import { createHash, randomUUID } from "node:crypto";

import {
  clearClockTimeout,
  currentDate,
  setClockTimeout,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS,
  type Tracer,
} from "@botiverse/raft-shared";
import { and, desc, eq, gt, isNull } from "drizzle-orm";

import { getDb, type Database, type DatabaseExecutor } from "../db/index";
import { withTraceRoot } from "../tracing/semanticTrace";
import {
  agents,
  externalBindingAudienceSnapshots,
  externalChannelBindings,
  externalMessageLinks,
  serverMembers,
  users,
} from "../db/schema";
import { resolveExternalBindingAuthority } from "./externalAppControlPlaneService";
import { resolveExternalConversationTarget } from "./externalConversationTargetService";
import {
  installOrdinaryMessageOutboundRuntime,
  mintSlackBridgeReconciliationMarker,
  type OrdinaryMessageOutboundAuthorizationResolver,
  type ProviderNeutralOutboundBindingAuthority,
} from "./externalDeliveryOutboxService";
import {
  processExternalDeliveryPartitionHead,
  type ExternalDeliveryAuthorityAlert,
  type ExternalDeliveryWorkerDependencies,
  type ProcessExternalDeliveryPartitionHeadInput,
} from "./externalDeliveryWorkerService";
import { evaluateFeatureFlag } from "./featureFlagService";
import { slackBridgeDatabaseRuntimeRevision } from "./slackBridgeDatabaseRuntimeAuthority";
import type { SlackBridgeProviderRuntime } from "./slackBridgeProviderRuntime";
import { createSlackOutboundAttachmentAdapter } from "./slackOutboundAttachmentAdapter";
import { dispatchExternalOutboundAttachments } from "./externalOutboundAttachmentCoordinator";
import { getStorage } from "./storageService";
import { effectiveAgentSenderName, effectiveUserSenderName } from "./effectiveSenderName";
import {
  createSlackProviderPreparation,
  reconcileSlackOutboundDelivery,
  type SlackBridgeCredentialHandle,
  type SlackOutboundReconciliationResult,
  type SlackProviderAuthorityFence,
} from "./slackProviderAdapter";

const DEFAULT_OUTBOUND_WORKER_INTERVAL_MS = 1_000;

export type SlackOutboundReconciliationDecision =
  | { kind: "abort"; reason: string }
  | { kind: "accept"; providerMessageId: string; providerThreadId: string | null }
  | { kind: "dispatch" };

export function classifySlackOutboundReconciliation(
  result: SlackOutboundReconciliationResult,
): SlackOutboundReconciliationDecision {
  if (result.kind === "unavailable") return { kind: "abort", reason: result.reason };
  if (result.kind === "not_found") return { kind: "dispatch" };
  return {
    kind: "accept",
    providerMessageId: result.providerMessageId,
    providerThreadId: result.providerThreadId,
  };
}

type ActiveBindingFact = Extract<
  Awaited<ReturnType<typeof resolveExternalBindingAuthority>>,
  { active: true }
>["fact"];

type CurrentOutboundAuthority = {
  active: true;
  fact: ActiveBindingFact;
  neutral: ProviderNeutralOutboundBindingAuthority;
  runtimeRevision: string;
  attachmentTransferEnabled: boolean;
};

export interface SlackBridgeDatabaseOutboundRuntimeDependencies {
  db?: Database;
  provider: SlackBridgeProviderRuntime;
  reconciliationKey: Uint8Array | string;
  registrationId: string;
  now?: () => Date;
  workerIntervalMs?: number;
  workerLeaseOwner?: string;
  runWorkerOnce?(input: ProcessExternalDeliveryPartitionHeadInput): ReturnType<
    typeof processExternalDeliveryPartitionHead
  >;
  onAuthorityAlert?(alert: ExternalDeliveryAuthorityAlert): void;
  onError?(error: unknown): void;
  tracer?: Tracer;
}

export interface SlackBridgeDatabaseOutboundRuntime {
  start(): void;
  stop(): Promise<void>;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

async function resolveCurrentAuthorPresentation(input: {
  executor: DatabaseExecutor;
  serverId: string;
  senderType: "user" | "agent";
  senderId: string;
}): Promise<{ displayName: string; fallbackKind: "human" | "agent" } | null> {
  if (input.senderType === "user") {
    const [subject] = await input.executor.select({
      name: users.name,
      displayName: users.displayName,
    }).from(serverMembers).innerJoin(users, eq(users.id, serverMembers.userId)).where(and(
      eq(serverMembers.serverId, input.serverId),
      eq(serverMembers.userId, input.senderId),
    )).limit(1);
    return subject
      ? { displayName: effectiveUserSenderName(subject), fallbackKind: "human" }
      : null;
  }
  const [subject] = await input.executor.select({
    name: agents.name,
    displayName: agents.displayName,
  }).from(agents).where(and(
    eq(agents.id, input.senderId),
    eq(agents.serverId, input.serverId),
    isNull(agents.deletedAt),
  )).limit(1);
  return subject
    ? { displayName: effectiveAgentSenderName(subject), fallbackKind: "agent" }
    : null;
}

function canonicalRevision(input: {
  authority: ActiveBindingFact;
  audienceRevision: number;
}): string {
  return createHash("sha256").update(JSON.stringify({
    schema: "slack-bridge-database-outbound-runtime.v1",
    bindingRuntimeRevision: slackBridgeDatabaseRuntimeRevision(input.authority),
    audienceRevision: input.audienceRevision,
  }), "utf8").digest("hex");
}

// Runtime/audience revisions are refreshed per dispatch. Only coordinates that
// identify the bound destination belong in this fence; revision drift must not
// poison an ordinary FIFO head.
function sameHardNeutralAuthority(
  left: ProviderNeutralOutboundBindingAuthority,
  right: ProviderNeutralOutboundBindingAuthority,
): boolean {
  return left.provider === right.provider
    && left.environment === right.environment
    && left.appRegistrationId === right.appRegistrationId
    && left.installId === right.installId
    && left.workspaceId === right.workspaceId
    && left.connectionEpoch === right.connectionEpoch
    && left.bindingId === right.bindingId
    && left.bindingEpoch === right.bindingEpoch
    && left.privacyClass === right.privacyClass
    && left.raftChannelId === right.raftChannelId
    && left.providerAuthorityId === right.providerAuthorityId
    && left.providerConversationId === right.providerConversationId;
}

function providerFence(
  fact: ActiveBindingFact,
): SlackProviderAuthorityFence {
  return {
    installId: fact.installId,
    providerAppId: fact.providerAppId,
    providerAuthorityId: fact.providerAuthorityId,
    providerConversationId: fact.providerConversationId,
    connectionEpoch: fact.connectionEpoch,
    credentialRevision: fact.credentialRevision,
    bindingId: fact.bindingId,
    bindingEpoch: fact.bindingEpoch,
  };
}

export async function resolveCurrentOutboundAuthority(input: {
  executor: DatabaseExecutor;
  bindingId: string;
  expectedConnectionEpoch: number;
  expectedBindingEpoch: number;
  expectedAudienceRevision?: number;
  senderType: "user" | "agent";
  senderId: string;
  now: Date;
  registrationId: string;
}): Promise<CurrentOutboundAuthority | null> {
  if (!validDate(input.now)) return null;
  const bindings = await input.executor.select({
    id: externalChannelBindings.id,
    serverId: externalChannelBindings.serverId,
  }).from(externalChannelBindings).where(and(
    eq(externalChannelBindings.id, input.bindingId),
    eq(externalChannelBindings.registrationId, input.registrationId),
  )).limit(2);
  if (bindings.length !== 1) return null;
  const decision = await resolveExternalBindingAuthority({
    serverId: bindings[0]!.serverId,
    bindingId: input.bindingId,
    expectedConnectionEpoch: input.expectedConnectionEpoch,
    expectedBindingEpoch: input.expectedBindingEpoch,
    now: input.now,
  }, input.executor as ReturnType<typeof getDb>);
  if (!decision.active || decision.fact.registrationId !== input.registrationId) return null;
  const launch = await evaluateFeatureFlag({
    key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
    serverId: decision.fact.serverId,
  }, input.executor as ReturnType<typeof getDb>);
  if (!launch.enabled) return null;
  const attachmentTransfer = await evaluateFeatureFlag({
    key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.attachmentTransfer,
    serverId: decision.fact.serverId,
  }, input.executor as ReturnType<typeof getDb>);

  if (
    input.expectedAudienceRevision !== undefined
    && (!Number.isSafeInteger(input.expectedAudienceRevision) || input.expectedAudienceRevision <= 0)
  ) return null;
  const publicFrozenDispatch = decision.fact.privacyClass === "public"
    && input.expectedAudienceRevision !== undefined;
  const snapshots = await input.executor.select({
    audienceRevision: externalBindingAudienceSnapshots.audienceRevision,
    status: externalBindingAudienceSnapshots.status,
    expiresAt: externalBindingAudienceSnapshots.expiresAt,
  }).from(externalBindingAudienceSnapshots).where(and(
    eq(externalBindingAudienceSnapshots.bindingId, decision.fact.bindingId),
    eq(externalBindingAudienceSnapshots.bindingEpoch, decision.fact.bindingEpoch),
    ...(publicFrozenDispatch
      ? []
      : [
          eq(externalBindingAudienceSnapshots.status, "matched"),
          gt(externalBindingAudienceSnapshots.expiresAt, input.now),
          ...(input.expectedAudienceRevision === undefined
            ? []
            : [eq(
                externalBindingAudienceSnapshots.audienceRevision,
                input.expectedAudienceRevision,
              )]),
        ]),
  )).orderBy(desc(externalBindingAudienceSnapshots.audienceRevision)).limit(2);
  if (snapshots.length === 0) return null;
  const latestSnapshot = snapshots[0]!;
  if (
    publicFrozenDispatch
    && (latestSnapshot.status !== "matched" || latestSnapshot.expiresAt <= input.now)
  ) return null;
  const audienceRevision = latestSnapshot.audienceRevision;
  // Public-channel membership refreshes are informational while the binding
  // and current matched snapshot remain valid. Preserve the frozen revision in
  // the neutral authority so an ordinary refresh cannot poison a FIFO head;
  // private channels keep the exact frozen revision contract above.
  const effectiveAudienceRevision = publicFrozenDispatch
    ? input.expectedAudienceRevision!
    : audienceRevision;
  const currentPrivateAudienceRevision = decision.fact.privacyClass === "private"
    ? decision.fact.audienceRevision
    : null;
  if (
    !Number.isSafeInteger(audienceRevision)
    || audienceRevision <= 0
    || (decision.fact.privacyClass === "private" && (
      typeof currentPrivateAudienceRevision !== "number"
      || !Number.isSafeInteger(currentPrivateAudienceRevision)
      || currentPrivateAudienceRevision < audienceRevision
      || (
        input.expectedAudienceRevision === undefined
        && currentPrivateAudienceRevision !== audienceRevision
      )
    ))
  ) return null;

  if (
    input.expectedAudienceRevision === undefined
    && !await resolveCurrentAuthorPresentation({
      executor: input.executor,
      serverId: decision.fact.serverId,
      senderType: input.senderType,
      senderId: input.senderId,
    })
  ) return null;
  const revisionAuthority = decision.fact.privacyClass === "private"
    && input.expectedAudienceRevision !== undefined
    ? { ...decision.fact, audienceRevision }
    : decision.fact;
  const neutral: ProviderNeutralOutboundBindingAuthority = {
    provider: decision.fact.provider,
    environment: decision.fact.environment,
    appRegistrationId: decision.fact.registrationId,
    installId: decision.fact.installId,
    workspaceId: decision.fact.providerAuthorityId,
    connectionEpoch: decision.fact.connectionEpoch,
    bindingId: decision.fact.bindingId,
    bindingEpoch: decision.fact.bindingEpoch,
    memberRevision: effectiveAudienceRevision,
    contextRevision: effectiveAudienceRevision,
    privacyClass: decision.fact.privacyClass,
    raftChannelId: decision.fact.channelId,
    providerAuthorityId: decision.fact.providerAuthorityId,
    providerConversationId: decision.fact.providerConversationId,
  };
  return {
    active: true,
    fact: decision.fact,
    neutral,
    runtimeRevision: canonicalRevision({
      authority: revisionAuthority,
      audienceRevision: effectiveAudienceRevision,
    }),
    attachmentTransferEnabled: attachmentTransfer.enabled,
  };
}

export async function resolveSlackOutboundMessageSurface(input: {
  executor: DatabaseExecutor;
  requestedChannelId: string;
  messageChannelId: string;
}): Promise<{
  level: "top_level" | "thread";
  authorityConversationId: string;
  bindingChannelId: string;
  canonicalRootMessageId: string | null;
} | null> {
  const target = await resolveExternalConversationTarget({
    executor: input.executor,
    authorityChannelId: input.requestedChannelId,
    expectedStorageChannelId: input.messageChannelId,
  });
  if (!target || (target.kind === "joint" && target.role !== "host")) return null;
  return {
    level: target.level,
    authorityConversationId: target.authorityChannelId,
    bindingChannelId: target.bindingChannelId,
    canonicalRootMessageId: target.canonicalRootMessageId,
  };
}

export function createSlackBridgeDatabaseOutboundRuntime(
  dependencies: SlackBridgeDatabaseOutboundRuntimeDependencies,
): SlackBridgeDatabaseOutboundRuntime {
  const db = dependencies.db ?? getDb();
  const now = dependencies.now ?? currentDate;
  const workerIntervalMs = dependencies.workerIntervalMs ?? DEFAULT_OUTBOUND_WORKER_INTERVAL_MS;
  if (!Number.isSafeInteger(workerIntervalMs) || workerIntervalMs <= 0) {
    throw new Error("Slack Bridge outbound worker interval is invalid");
  }
  const workerLeaseOwner = dependencies.workerLeaseOwner
    ?? `slack-outbound:${dependencies.registrationId}:${randomUUID()}`;
  const runWorkerOnce = dependencies.runWorkerOnce ?? processExternalDeliveryPartitionHead;
  let started = false;
  let stopped = false;
  let timer: unknown | null = null;
  let workerPromise: Promise<void> | null = null;
  let uninstallAdmission: (() => void) | null = null;

  const authorizationResolver: OrdinaryMessageOutboundAuthorizationResolver = async (request) => {
    if (
      stopped
      || request.sourceText.includes("\0")
      || Buffer.byteLength(request.sourceText, "utf8") > 40_000
    ) return null;
    const surface = await resolveSlackOutboundMessageSurface({
      executor: request.executor,
      requestedChannelId: request.requestedChannelId,
      messageChannelId: request.message.channelId,
    });
    if (!surface) return null;
    const bindings = await request.executor.select({
      id: externalChannelBindings.id,
      connectionEpoch: externalChannelBindings.connectionEpoch,
      bindingEpoch: externalChannelBindings.bindingEpoch,
    }).from(externalChannelBindings).where(and(
      eq(externalChannelBindings.registrationId, dependencies.registrationId),
      eq(externalChannelBindings.channelId, surface.bindingChannelId),
      eq(externalChannelBindings.state, "active"),
    )).limit(2);
    if (bindings.length !== 1) return null;
    const current = await resolveCurrentOutboundAuthority({
      executor: request.executor,
      bindingId: bindings[0]!.id,
      expectedConnectionEpoch: bindings[0]!.connectionEpoch,
      expectedBindingEpoch: bindings[0]!.bindingEpoch,
      senderType: request.senderType,
      senderId: request.senderId,
      now: now(),
      registrationId: dependencies.registrationId,
    });
    if (!current || current.neutral.raftChannelId !== surface.bindingChannelId || stopped) return null;
    return {
      activeRuntime: {
        level: surface.level,
        authorityConversationId: surface.authorityConversationId,
        runtimePredicateRevision: current.runtimeRevision,
        attachmentTransferEnabled: current.attachmentTransferEnabled,
        bindingAuthority: current.neutral,
      },
      canonicalConversationId: request.message.channelId,
      canonicalRootMessageId: surface.canonicalRootMessageId,
      sanitizedText: request.sourceText,
    };
  };

  const resolveCurrentRuntime: ExternalDeliveryWorkerDependencies["resolveCurrentRuntime"] = async ({
    frozenSnapshot,
  }) => db.transaction(async (tx) => {
    if (stopped) return null;
    const frozen = frozenSnapshot.bindingAuthority;
    const current = await resolveCurrentOutboundAuthority({
      executor: tx,
      bindingId: frozen.bindingId,
      expectedConnectionEpoch: frozen.connectionEpoch,
      expectedBindingEpoch: frozen.bindingEpoch,
      expectedAudienceRevision: frozen.memberRevision,
      senderType: frozenSnapshot.senderType,
      senderId: frozenSnapshot.senderId,
      now: now(),
      registrationId: dependencies.registrationId,
    });
    if (
      !current
      || !sameHardNeutralAuthority(current.neutral, frozen)
      || stopped
    ) return null;
    return {
      runtimeRevision: current.runtimeRevision,
      bindingAuthority: current.neutral,
      attachmentTransferEnabled: current.attachmentTransferEnabled,
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });

  const leaseCredential: ExternalDeliveryWorkerDependencies["leaseCredential"] = async ({
    runtime,
  }) => {
    const fact = await db.transaction(async (tx) => {
      if (stopped) return null;
      const authority = runtime.bindingAuthority;
      const bindings = await tx.select({
        serverId: externalChannelBindings.serverId,
      }).from(externalChannelBindings).where(and(
        eq(externalChannelBindings.id, authority.bindingId),
        eq(externalChannelBindings.registrationId, dependencies.registrationId),
      )).limit(2);
      if (bindings.length !== 1) return null;
      const decision = await resolveExternalBindingAuthority({
        serverId: bindings[0]!.serverId,
        bindingId: authority.bindingId,
        expectedConnectionEpoch: authority.connectionEpoch,
        expectedBindingEpoch: authority.bindingEpoch,
        now: now(),
      }, tx as ReturnType<typeof getDb>);
      return decision.active ? decision.fact : null;
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    if (!fact || stopped) return null;
    const handle = await dependencies.provider.credentialResolver.resolve({
      authority: providerFence(fact),
      now: now(),
    });
    if (!handle) return null;
    return {
      handle,
      credentialRevision: fact.credentialRevision,
      runtimeRevision: runtime.runtimeRevision,
      provider: fact.provider,
      installId: fact.installId,
      providerAuthorityId: fact.providerAuthorityId,
      providerConversationId: fact.providerConversationId,
      connectionEpoch: fact.connectionEpoch,
      bindingId: fact.bindingId,
      bindingEpoch: fact.bindingEpoch,
    };
  };

  const threadAuthority = {
    async resolve(input: {
      canonicalRootMessageId: string;
      authority: SlackProviderAuthorityFence;
    }) {
      const links = await db.select().from(externalMessageLinks).where(and(
        eq(externalMessageLinks.raftMessageId, input.canonicalRootMessageId),
        eq(externalMessageLinks.provider, "slack"),
        eq(externalMessageLinks.installId, input.authority.installId),
        eq(externalMessageLinks.providerAuthorityId, input.authority.providerAuthorityId),
        eq(externalMessageLinks.providerConversationId, input.authority.providerConversationId),
        eq(externalMessageLinks.bindingId, input.authority.bindingId),
        eq(externalMessageLinks.bindingEpoch, input.authority.bindingEpoch),
        eq(externalMessageLinks.connectionEpoch, input.authority.connectionEpoch),
        eq(externalMessageLinks.outcomeState, "accepted"),
        eq(externalMessageLinks.authorityState, "active"),
      )).limit(2);
      if (links.length !== 1 || !links[0]!.providerMessageId) {
        return { active: false as const, reason: "missing" as const };
      }
      return {
        active: true as const,
        fact: {
          providerThreadId: links[0]!.providerMessageId,
          rootLinkRevision: 1,
          installId: input.authority.installId,
          providerAuthorityId: input.authority.providerAuthorityId,
          providerConversationId: input.authority.providerConversationId,
          connectionEpoch: input.authority.connectionEpoch,
          bindingId: input.authority.bindingId,
          bindingEpoch: input.authority.bindingEpoch,
        },
      };
    },
  };
  const prepareSlackProvider = createSlackProviderPreparation({
    transport: dependencies.provider.transport,
    quarantineSink: dependencies.provider.quarantineSink,
    threadAuthority,
    now,
  });
  const workerDependencies: ExternalDeliveryWorkerDependencies = {
    resolveCurrentRuntime,
    leaseCredential,
    async prepareProvider(request) {
      const handle = request.credentialHandle as SlackBridgeCredentialHandle;
      const authority: SlackProviderAuthorityFence = {
        installId: request.frozenSnapshot.bindingAuthority.installId,
        providerAppId: handle.providerAppId,
        providerAuthorityId: request.frozenSnapshot.bindingAuthority.providerAuthorityId,
        providerConversationId: request.frozenSnapshot.bindingAuthority.providerConversationId,
        connectionEpoch: request.frozenSnapshot.bindingAuthority.connectionEpoch,
        credentialRevision: handle.credentialRevision,
        bindingId: request.frozenSnapshot.bindingAuthority.bindingId,
        bindingEpoch: request.frozenSnapshot.bindingAuthority.bindingEpoch,
      };
      if (request.reconcileUnknownOutcome) {
        let providerThreadId: string | null = null;
        if (request.frozenSnapshot.level === "thread") {
          const root = await threadAuthority.resolve({
            canonicalRootMessageId: request.frozenSnapshot.canonicalRootMessageId!,
            authority,
          });
          if (!root.active) return { ready: false, reason: "provider_thread_receipt_missing" };
          providerThreadId = root.fact.providerThreadId;
        }
        const reconciliation = await reconcileSlackOutboundDelivery({
          transport: dependencies.provider.transport,
          leaseCredential: async () => dependencies.provider.credentialResolver.resolve({
            authority,
            now: now(),
          }),
          authority,
          reconciliationMarker: request.reconciliationMarker,
          providerThreadId,
          now: now(),
        });
        const decision = classifySlackOutboundReconciliation(reconciliation);
        if (decision.kind === "abort") {
          return { ready: false, reason: decision.reason };
        }
        if (decision.kind === "accept") {
          return {
            ready: true,
            async dispatch() {
              await dependencies.provider.releaseCredential(handle);
              return {
                kind: "accepted" as const,
                providerMessageId: decision.providerMessageId,
                providerThreadId: decision.providerThreadId,
                reconciled: true,
              };
            },
          };
        }
      }
      if (request.frozenSnapshot.attachments.length > 0) {
        const attachmentFence: SlackProviderAuthorityFence = {
          installId: request.frozenSnapshot.bindingAuthority.installId,
          providerAppId: handle.providerAppId,
          providerAuthorityId: request.frozenSnapshot.bindingAuthority.providerAuthorityId,
          providerConversationId: request.frozenSnapshot.bindingAuthority.providerConversationId,
          connectionEpoch: request.frozenSnapshot.bindingAuthority.connectionEpoch,
          credentialRevision: handle.credentialRevision,
          bindingId: request.frozenSnapshot.bindingAuthority.bindingId,
          bindingEpoch: request.frozenSnapshot.bindingAuthority.bindingEpoch,
        };
        const transport = await dependencies.provider.createOutboundAttachmentTransport(handle, attachmentFence);
        const storage = getStorage();
        if (!transport || !storage) return { ready: false, reason: "provider_attachment_runtime_unavailable" };
        let providerRootThreadId: string | null = null;
        if (request.frozenSnapshot.level === "thread") {
          const root = await threadAuthority.resolve({
            canonicalRootMessageId: request.frozenSnapshot.canonicalRootMessageId!,
            authority: attachmentFence,
          });
          if (!root.active) return { ready: false, reason: "provider_thread_receipt_missing" };
          providerRootThreadId = root.fact.providerThreadId;
        }
        const adapter = createSlackOutboundAttachmentAdapter(transport);
        return {
          ready: true,
          async dispatch() {
            try {
              return await dispatchExternalOutboundAttachments({
                db,
                deliveryId: request.deliveryId,
                reconciliationMarker: request.reconciliationMarker,
                snapshot: request.frozenSnapshot,
                adapter,
                storage,
                providerRootThreadId,
                leaseOwner: `${workerLeaseOwner}:attachment`,
                now,
              });
            } finally {
              await dependencies.provider.releaseCredential(handle);
            }
          },
        };
      }
      const prepared = await prepareSlackProvider({
        deliveryId: request.deliveryId,
        reconciliationMarker: request.reconciliationMarker,
        renderSnapshot: request.frozenSnapshot,
        credentialHandle: handle,
      });
      if (!prepared.ready) return prepared;
      return {
        ready: true,
        async dispatch() {
          const result = await prepared.dispatch();
          if (result.kind === "accepted" || result.kind === "rate_limited") return result;
          if (result.kind === "transient_failure") {
            return { ...result, reasonCode: "provider_transient_failure" } as const;
          }
          if (result.kind === "deterministic_failure") {
            return { kind: "deterministic_failure", reasonCode: "provider_deterministic_failure" } as const;
          }
          return { kind: "outcome_unknown", reasonCode: "provider_outcome_unknown" } as const;
        },
      };
    },
    async releaseCredential({ credentialHandle }) {
      await dependencies.provider.releaseCredential(
        credentialHandle as SlackBridgeCredentialHandle,
      );
    },
    now,
  };

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setClockTimeout(() => {
      timer = null;
      if (stopped || workerPromise) return;
      // Each tick is a root span, so the onError report is tied to it.
      workerPromise = withTraceRoot(dependencies.tracer, "server.slack_bridge.outbound.tick", {
        surface: "server",
        kind: "internal",
      }, async () => {
        try {
          await runOutboundTick();
        } catch (error) {
          dependencies.onError?.(error);
          throw error;
        }
      }).catch(() => {
        // Already reported through onError inside the span.
      }).finally(() => {
        workerPromise = null;
        schedule(workerIntervalMs);
      });
    }, delayMs);
    if (timer && typeof timer === "object" && "unref" in timer) {
      (timer as { unref(): void }).unref();
    }
  };

  const runOutboundTick = async () => {
    const bindings = await db.select({
      id: externalChannelBindings.id,
      bindingEpoch: externalChannelBindings.bindingEpoch,
    }).from(externalChannelBindings).where(and(
      eq(externalChannelBindings.registrationId, dependencies.registrationId),
      eq(externalChannelBindings.state, "active"),
    ));
    for (const binding of bindings) {
      if (stopped) return;
      const result = await runWorkerOnce({
        db,
        bindingId: binding.id,
        bindingEpoch: binding.bindingEpoch,
        leaseOwner: workerLeaseOwner,
        dependencies: workerDependencies,
      });
      if (result.kind === "authority_blocked" && result.alert) {
        try {
          dependencies.onAuthorityAlert?.(result.alert);
        } catch (error) {
          dependencies.onError?.(error);
        }
      }
    }
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      uninstallAdmission = installOrdinaryMessageOutboundRuntime({
        authorizationResolver,
        reconciliationMarkerMinter: ({ deliveryId }) =>
          mintSlackBridgeReconciliationMarker(dependencies.reconciliationKey, deliveryId),
      });
      schedule(0);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      uninstallAdmission?.();
      uninstallAdmission = null;
      if (timer) clearClockTimeout(timer);
      timer = null;
      await workerPromise?.catch(() => undefined);
    },
  };
}
