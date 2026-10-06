import { randomUUID } from "node:crypto";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS, type Tracer } from "@botiverse/raft-shared";
import { and, eq } from "drizzle-orm";

import { getDb, type Database, type DatabaseExecutor } from "../db/index";
import {
  externalActorProjections,
  externalAppInstalls,
  externalChannelBindings,
} from "../db/schema";
import { resolveExternalInstallServerGrantAuthority } from "./externalInstallServerGrantAuthority";
import {
  createExternalInboundWorkerRuntime,
  type ExternalInboundWorkerDependencies,
} from "./externalInboundWorkerService";
import type { ExternalDeliveryAuthorityAlert } from "./externalDeliveryWorkerService";
import {
  createExternalInboundAttachmentWorkerRuntime,
  type ExternalInboundAttachmentWorkerDependencies,
} from "./externalInboundAttachmentWorkerService";
import type { ExternalAttachmentAuthority } from "./externalAttachmentProviderAdapter";
import {
  createSlackDatabaseAudienceIdentityAuthority,
  createSlackDatabaseInboundWorkerRuntimeResolver,
  createSlackDatabaseIngressRuntimeResolver,
} from "./slackBridgeDatabaseRuntimeAuthority";
import { createSlackBridgeDatabaseOutboundRuntime } from "./slackBridgeDatabaseOutboundRuntime";
import {
  createSlackBridgeEnvSecretBackends,
  slackBridgeKeyFromEnv,
  SLACK_BRIDGE_OAUTH_CLIENT_SECRET_REF,
  SLACK_BRIDGE_SIGNING_SECRET_REF,
} from "./slackBridgeEnvSecrets";
import {
  createSlackBridgeManagedRuntime,
  type SlackBridgeManagedRuntime,
} from "./slackBridgeManagedRuntime";
import { createSlackBridgeOAuthCompletionRedirectPathResolver } from "./slackBridgeOAuthCompletionRedirect";
import {
  createSlackBridgeProductionLifecycle,
} from "./slackBridgeProductionLifecycle";
import {
  createSlackBridgeProviderRuntime,
} from "./slackBridgeProviderRuntime";
import {
  createSlackBridgeProvisioningControlPlane,
  slackBridgeProvisioningManifestHash,
  SLACK_BRIDGE_PROVISIONING_CAPABILITIES,
} from "./slackBridgeProvisioningControlPlane";
import type {
  SlackBridgeLifecycleExecutionReceipt,
  SlackBridgePersistentWorkerClock,
} from "./slackBridgeWorkerLifecycle";
import { evaluateFeatureFlag } from "./featureFlagService";
import { getAttachmentFileSizeLimitBytes } from "./attachmentUploadPolicy";
import { getFileUploadQuotaSummary } from "./fileUploadQuotaService";
import { getCdnStorage, getStorage } from "./storageService";
import { createSlackInboundAttachmentAdapter } from "./slackInboundAttachmentAdapter";
import { createSlackAvatarSourceAdapter } from "./slackAvatarSourceAdapter";
import { materializeExternalProjectionAvatar } from "./externalAvatarMaterializerService";
import { installExternalReactionCommandHandler } from "./externalReactionCommandRuntime";
import { enqueueSlackReactionAggregateTransition } from "./externalReactionSyncService";
import { createExternalReactionWorkerRuntime } from "./externalReactionWorkerService";
import { refreshSlackChannelBindingsPrivacy } from "./slackBindingPrivacyFreshnessService";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SlackBridgeProductionServerRuntime extends SlackBridgeManagedRuntime {
  start(): void;
  revalidateChannelPrivacy(input: { serverId: string; channelId: string; now: Date }): Promise<readonly { kind: string; reason?: string }[]>;
  inboundWorkerDependencies: Pick<
    ExternalInboundWorkerDependencies,
    "decryptNormalizedPayload" | "resolveCurrentRuntime" | "resolveProviderMentionProfiles"
  >;
  inboundAttachmentWorkerDependencies: ExternalInboundAttachmentWorkerDependencies;
}

export type SlackBridgeServerRuntime = SlackBridgeProductionServerRuntime;

export interface SlackBridgeServerRuntimeDependencies {
  db?: Database;
  fetch?: typeof fetch;
  now?: () => Date;
  lifecycleClock?: SlackBridgePersistentWorkerClock;
  lifecycleIntervalMs?: number;
  inboundWorkerLeaseOwner?: string;
  inboundWorkerIntervalMs?: number;
  inboundAttachmentWorkerLeaseOwner?: string;
  inboundAttachmentWorkerIntervalMs?: number;
  outboundWorkerLeaseOwner?: string;
  outboundWorkerIntervalMs?: number;
  reactionWorkerLeaseOwner?: string;
  reactionWorkerIntervalMs?: number;
  onLifecycleReceipt?(receipt: SlackBridgeLifecycleExecutionReceipt): void;
  onLifecycleError?(error: unknown): void;
  onInboundMessageCommitted?(input: { eventId: string; messageId: string }): Promise<void> | void;
  onInboundReactionCommitted?(input: { eventId: string; messageId: string }): Promise<void> | void;
  onInboundRealtimeError?(error: unknown): void;
  onOutboundAuthorityAlert?(alert: ExternalDeliveryAuthorityAlert): void;
  onOutboundError?(error: unknown): void;
  tracer?: Tracer;
}

async function slackAttachmentAuthorityIsCurrent(
  executor: DatabaseExecutor,
  authority: ExternalAttachmentAuthority,
  sourceActorProjectionId: string,
): Promise<boolean> {
  if (
    authority.provider !== "slack"
    || authority.workspaceId !== authority.providerAuthorityId
  ) return false;
  const rows = await executor.select({
    installId: externalAppInstalls.id,
    serverId: externalChannelBindings.serverId,
    registrationId: externalChannelBindings.registrationId,
    bindingGrantEpoch: externalChannelBindings.grantEpoch,
  }).from(externalAppInstalls)
    .innerJoin(externalChannelBindings, eq(externalChannelBindings.installId, externalAppInstalls.id))
    .where(and(
      eq(externalAppInstalls.id, authority.installId),
      eq(externalAppInstalls.registrationId, authority.appRegistrationId),
      eq(externalAppInstalls.providerAuthorityId, authority.providerAuthorityId),
      eq(externalAppInstalls.connectionEpoch, authority.connectionEpoch),
      eq(externalAppInstalls.state, "active"),
      eq(externalChannelBindings.id, authority.bindingId),
      eq(externalChannelBindings.providerConversationId, authority.providerConversationId),
      eq(externalChannelBindings.connectionEpoch, authority.connectionEpoch),
      eq(externalChannelBindings.bindingEpoch, authority.bindingEpoch),
      eq(externalChannelBindings.state, "active"),
    )).limit(2);
  if (rows.length !== 1) return false;
  const row = rows[0]!;
  const serverAuthority = await resolveExternalInstallServerGrantAuthority(executor, {
    installId: row.installId,
    serverId: row.serverId,
    registrationId: row.registrationId,
  });
  if (!serverAuthority.current || row.bindingGrantEpoch !== serverAuthority.grant.grantEpoch) {
    return false;
  }
  const [actor] = await executor.select({ id: externalActorProjections.id })
    .from(externalActorProjections)
    .where(and(
      eq(externalActorProjections.id, sourceActorProjectionId),
      eq(externalActorProjections.provider, authority.provider),
      eq(externalActorProjections.appRegistrationId, authority.appRegistrationId),
      eq(externalActorProjections.installId, authority.installId),
      eq(externalActorProjections.workspaceId, authority.workspaceId),
      eq(externalActorProjections.state, "active"),
      eq(externalActorProjections.deactivated, false),
    )).limit(2);
  if (!actor) return false;
  return (await evaluateFeatureFlag({
    key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.attachmentTransfer,
    serverId: row.serverId,
  }, executor as Database)).enabled;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Slack Bridge production runtime requires ${name}`);
  return value;
}

function httpsUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Slack Bridge production runtime ${name} is invalid`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`Slack Bridge production runtime ${name} must be credential-free HTTPS`);
  }
  return url.toString();
}

function managedAppOrigin(
  value: string,
  runtimeEnvironment: "test" | "production",
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Slack Bridge production runtime app URL is invalid");
  }
  const protocolAllowed = runtimeEnvironment === "production"
    ? url.protocol === "https:"
    : url.protocol === "https:" || url.protocol === "http:";
  if (!protocolAllowed || url.username || url.password) {
    const protocol = runtimeEnvironment === "production" ? "HTTPS" : "HTTP(S)";
    throw new Error(
      `Slack Bridge production runtime app URL must be credential-free ${protocol}`,
    );
  }
  return url.origin;
}

function environment(value: string): "test" | "production" {
  if (value === "test" || value === "production") return value;
  throw new Error("Slack Bridge production runtime environment is invalid");
}

function registrationId(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error("Slack Bridge registration id is invalid");
  return value;
}

const PRODUCTION_ENV_KEYS = [
  "SLACK_BRIDGE_ENVIRONMENT",
  "SLACK_BRIDGE_REGISTRATION_ID",
  "SLACK_BRIDGE_PROVIDER_APP_ID",
  "SLACK_BRIDGE_PROVIDER_OAUTH_CLIENT_ID",
  "SLACK_BRIDGE_OAUTH_REDIRECT_URI",
  "SLACK_BRIDGE_EVENTS_REQUEST_URL",
  "SLACK_BRIDGE_SIGNING_SECRET",
  "SLACK_BRIDGE_OAUTH_CLIENT_SECRET",
  "SLACK_BRIDGE_CREDENTIAL_ENCRYPTION_KEY",
  "SLACK_BRIDGE_PAYLOAD_ENCRYPTION_KEY",
] as const;

const LEGACY_ENV_KEYS = [
  "SLACK_BRIDGE_RUNTIME_MODE",
  "SLACK_BRIDGE_LOCAL_RUNTIME_CONFIG_FILE",
  "SLACK_BRIDGE_CREDENTIAL_KMS_KEY_ID",
  "SLACK_BRIDGE_PAYLOAD_KMS_KEY_ID",
] as const;

/**
 * Creates the only deployable Slack Bridge composition. Static app secrets
 * come directly from process env; runtime-generated bot credentials and
 * normalized ingress payloads use env master keys plus tenant/install AAD.
 * Any partial or legacy runtime configuration fails closed at process startup.
 */
export async function createSlackBridgeServerRuntimeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: SlackBridgeServerRuntimeDependencies = {},
): Promise<SlackBridgeServerRuntime | undefined> {
  const configured = PRODUCTION_ENV_KEYS.some((key) => Boolean(env[key]?.trim()));
  const legacyConfigured = LEGACY_ENV_KEYS.some((key) => Boolean(env[key]?.trim()));
  if (!configured && !legacyConfigured) return undefined;
  if (legacyConfigured) {
    throw new Error("Slack Bridge legacy local/AWS runtime configuration is not supported");
  }

  const runtimeEnvironment = environment(requiredEnv(env, "SLACK_BRIDGE_ENVIRONMENT"));
  const runtimeRegistrationId = registrationId(requiredEnv(env, "SLACK_BRIDGE_REGISTRATION_ID"));
  const providerAppId = requiredEnv(env, "SLACK_BRIDGE_PROVIDER_APP_ID");
  const providerOAuthClientId = requiredEnv(env, "SLACK_BRIDGE_PROVIDER_OAUTH_CLIENT_ID");
  const oauthRedirectUri = httpsUrl(
    requiredEnv(env, "SLACK_BRIDGE_OAUTH_REDIRECT_URI"),
    "OAuth redirect URI",
  );
  const eventsRequestUrl = httpsUrl(
    requiredEnv(env, "SLACK_BRIDGE_EVENTS_REQUEST_URL"),
    "events request URL",
  );
  const payloadEncryptionKey = slackBridgeKeyFromEnv(
    env.SLACK_BRIDGE_PAYLOAD_ENCRYPTION_KEY,
    "SLACK_BRIDGE_PAYLOAD_ENCRYPTION_KEY",
  );
  const secretBackends = createSlackBridgeEnvSecretBackends({
    registrationId: runtimeRegistrationId,
    environment: runtimeEnvironment,
    providerAppId,
    providerOAuthClientId,
    signingSecret: requiredEnv(env, "SLACK_BRIDGE_SIGNING_SECRET"),
    oauthClientSecret: requiredEnv(env, "SLACK_BRIDGE_OAUTH_CLIENT_SECRET"),
    credentialEncryptionKey: slackBridgeKeyFromEnv(
      env.SLACK_BRIDGE_CREDENTIAL_ENCRYPTION_KEY,
      "SLACK_BRIDGE_CREDENTIAL_ENCRYPTION_KEY",
    ),
    payloadEncryptionKey,
  });
  const db = dependencies.db;
  const appOrigin = managedAppOrigin(
    requiredEnv(env, "APP_URL"),
    runtimeEnvironment,
  );
  const provider = createSlackBridgeProviderRuntime({
    credentialCipher: secretBackends.credentialCipher,
    ...(db ? { db } : {}),
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  const avatarStorage = getCdnStorage() ?? getStorage();
  const avatarSource = createSlackAvatarSourceAdapter({
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
  });
  const avatarMaterializer = avatarStorage ? {
    materializeExternalProjection: (input: {
      projectionId: string;
      expectedProjectionRevision: number;
      expectedObservedAt?: Date;
      sourceLocator: string | null;
    }) => materializeExternalProjectionAvatar({
      db: db ?? getDb(),
      storage: avatarStorage,
      source: avatarSource,
      publicOrigin: new URL(eventsRequestUrl).origin,
      ...input,
      ...(dependencies.now ? { now: dependencies.now } : {}),
    }),
  } : undefined;
  const provisioning = createSlackBridgeProvisioningControlPlane({
    ...(db ? { db } : {}),
    provider: provider.provisioningProvider,
    ...(avatarMaterializer ? { avatarMaterializer } : {}),
    bootstrap: {
      registrationId: runtimeRegistrationId,
      environment: runtimeEnvironment,
      providerAppId,
      providerOAuthClientId,
      oauthRedirectUri,
      eventsRequestUrl,
      capabilityManifestVersion: 1,
      capabilityManifestHash: slackBridgeProvisioningManifestHash({
        oauthRedirectUri,
        eventsRequestUrl,
      }),
      requiredCapabilities: SLACK_BRIDGE_PROVISIONING_CAPABILITIES,
      signingSecret: {
        encryptedSecretRef: SLACK_BRIDGE_SIGNING_SECRET_REF,
        envelopeKeyId: "env:process",
        secretRevision: 1,
      },
      oauthClientSecret: {
        encryptedSecretRef: SLACK_BRIDGE_OAUTH_CLIENT_SECRET_REF,
        envelopeKeyId: "env:process",
        secretRevision: 1,
      },
    },
  });
  const lifecycle = createSlackBridgeProductionLifecycle({
    provider,
    identityAuthority: createSlackDatabaseAudienceIdentityAuthority(),
    ...(avatarMaterializer ? { avatarMaterializer } : {}),
    ...(db ? { db } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.lifecycleClock ? { clock: dependencies.lifecycleClock } : {}),
    ...(dependencies.lifecycleIntervalMs ? { intervalMs: dependencies.lifecycleIntervalMs } : {}),
    ...(dependencies.onLifecycleReceipt ? { onReceipt: dependencies.onLifecycleReceipt } : {}),
    onError: dependencies.onLifecycleError,
    tracer: dependencies.tracer,
  });
  const runtime = createSlackBridgeManagedRuntime({
    environment: runtimeEnvironment,
    oauthRedirectUri,
    eventsRequestUrl,
    appOrigin,
    isLaunchEnabled: async ({ serverId }) => (
      await evaluateFeatureFlag(
        { key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, serverId },
        db ?? getDb(),
      )
    ).enabled,
    resolveOAuthCompletionRedirectPath:
      createSlackBridgeOAuthCompletionRedirectPathResolver({ db }),
    appSecrets: secretBackends.appSecrets,
    credentialSealer: secretBackends.credentialCipher.sealer,
    secretResolver: secretBackends.secretResolver,
    payloadSealer: secretBackends.payloadSealer,
    provisioning,
    runtimeResolver: createSlackDatabaseIngressRuntimeResolver(db),
    requestLifecycleReconcile: () => lifecycle.requestEventReconcile(),
    onLifecycleError: dependencies.onLifecycleError,
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  const inboundWorkerDependencies = {
    decryptNormalizedPayload: secretBackends.decryptNormalizedPayload,
    resolveCurrentRuntime: createSlackDatabaseInboundWorkerRuntimeResolver(db, dependencies.now),
    async resolveProviderMentionProfiles(input: {
      frozenAuthority: Parameters<NonNullable<ExternalInboundWorkerDependencies["resolveProviderMentionProfiles"]>>[0]["frozenAuthority"];
      providerUserIds: readonly string[];
    }) {
      if (input.frozenAuthority.provider !== "slack" || input.providerUserIds.length === 0) return [];
      const executor = db ?? getDb();
      const installs = await executor.select({
        id: externalAppInstalls.id,
        providerAppId: externalAppInstalls.providerAppId,
        providerAuthorityId: externalAppInstalls.providerAuthorityId,
        botUserId: externalAppInstalls.botUserId,
        connectionEpoch: externalAppInstalls.connectionEpoch,
        credentialRevision: externalAppInstalls.credentialRevision,
      }).from(externalAppInstalls).where(and(
        eq(externalAppInstalls.id, input.frozenAuthority.installId),
        eq(externalAppInstalls.registrationId, input.frozenAuthority.appRegistrationId),
        eq(externalAppInstalls.providerAuthorityId, input.frozenAuthority.providerAuthorityId),
        eq(externalAppInstalls.connectionEpoch, input.frozenAuthority.connectionEpoch),
        eq(externalAppInstalls.state, "active"),
      )).limit(2);
      const install = installs.length === 1 ? installs[0]! : null;
      if (!install?.botUserId) return [];
      const observedAt = dependencies.now?.() ?? new Date();
      const resolved = await provider.resolveUsers({
        installId: install.id,
        providerAppId: install.providerAppId,
        providerAuthorityId: install.providerAuthorityId,
        botUserId: install.botUserId,
        connectionEpoch: install.connectionEpoch,
        credentialRevision: install.credentialRevision,
        now: observedAt,
      }, input.providerUserIds);
      return resolved.kind === "fact"
        ? resolved.fact.users.map((user) => ({
          providerUserId: user.id,
          displayName: user.displayName,
          handle: user.handle,
        }))
        : [];
    },
    ...(dependencies.onInboundMessageCommitted
      ? { onMessageCommitted: dependencies.onInboundMessageCommitted }
      : {}),
    ...(dependencies.onInboundReactionCommitted
      ? { onReactionCommitted: dependencies.onInboundReactionCommitted }
      : {}),
    onMessageCommittedError: dependencies.onInboundRealtimeError ?? ((error: unknown) => {
      console.error("[Slock] Slack Bridge inbound realtime emit failed", error);
    }),
    onReactionCommittedError: dependencies.onInboundRealtimeError ?? ((error: unknown) => {
      console.error("[Slock] Slack Bridge inbound reaction realtime emit failed", error);
    }),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  };
  const inboundWorker = createExternalInboundWorkerRuntime({
    db: db ?? getDb(),
    leaseOwner: dependencies.inboundWorkerLeaseOwner
      ?? `slack-inbound:${runtimeRegistrationId}:${randomUUID()}`,
    dependencies: inboundWorkerDependencies,
    ...(dependencies.inboundWorkerIntervalMs
      ? { intervalMs: dependencies.inboundWorkerIntervalMs }
      : {}),
  });
  const attachmentStorage = getStorage();
  if (!attachmentStorage?.putStream) {
    throw new Error("Slack Bridge attachment runtime requires bounded streaming storage");
  }
  const inboundAttachmentAdapter = createSlackInboundAttachmentAdapter(
    provider.inboundAttachmentTransport,
  );
  const inboundAttachmentWorkerDependencies: ExternalInboundAttachmentWorkerDependencies = {
    storage: attachmentStorage,
    resolveAdapter: (requestedProvider) => requestedProvider === inboundAttachmentAdapter.provider
      ? inboundAttachmentAdapter
      : null,
    authorityIsCurrent: (authority, sourceActorProjectionId, executor) => slackAttachmentAuthorityIsCurrent(
      executor ?? db ?? getDb(),
      authority,
      sourceActorProjectionId,
    ),
    maximumFileSizeBytes: async (serverId, at) => {
      const quota = await getFileUploadQuotaSummary(serverId, at);
      return getAttachmentFileSizeLimitBytes(quota.plan, at);
    },
    ...(dependencies.now ? { now: dependencies.now } : {}),
  };
  const inboundAttachmentWorker = createExternalInboundAttachmentWorkerRuntime({
    db: db ?? getDb(),
    leaseOwner: dependencies.inboundAttachmentWorkerLeaseOwner
      ?? `slack-inbound-attachment:${runtimeRegistrationId}:${randomUUID()}`,
    dependencies: inboundAttachmentWorkerDependencies,
    ...(dependencies.inboundAttachmentWorkerIntervalMs
      ? { intervalMs: dependencies.inboundAttachmentWorkerIntervalMs }
      : {}),
  });
  const outboundWorker = createSlackBridgeDatabaseOutboundRuntime({
    db: db ?? getDb(),
    provider,
    reconciliationKey: payloadEncryptionKey,
    registrationId: runtimeRegistrationId,
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.outboundWorkerLeaseOwner
      ? { workerLeaseOwner: dependencies.outboundWorkerLeaseOwner }
      : {}),
    ...(dependencies.outboundWorkerIntervalMs
      ? { workerIntervalMs: dependencies.outboundWorkerIntervalMs }
      : {}),
    onAuthorityAlert: dependencies.onOutboundAuthorityAlert ?? ((alert) => {
      console.error("[Slock] Slack Bridge outbound authority alert", JSON.stringify(alert));
    }),
    ...(dependencies.onOutboundError ? { onError: dependencies.onOutboundError } : {}),
    tracer: dependencies.tracer,
  });
  const uninstallReactionCommandHandler = installExternalReactionCommandHandler(
    enqueueSlackReactionAggregateTransition,
  );
  const reactionWorker = createExternalReactionWorkerRuntime({
    db: db ?? getDb(),
    provider,
    leaseOwner: dependencies.reactionWorkerLeaseOwner
      ?? `slack-reaction:${runtimeRegistrationId}:${randomUUID()}`,
    ...(dependencies.reactionWorkerIntervalMs
      ? { intervalMs: dependencies.reactionWorkerIntervalMs }
      : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
    onError: dependencies.onOutboundError,
    tracer: dependencies.tracer,
  });
  return {
    ...runtime,
    revalidateChannelPrivacy: (input) => refreshSlackChannelBindingsPrivacy({
      ...input,
      provider,
      db: db ?? getDb(),
    }),
    start() {
      lifecycle.start();
      inboundAttachmentWorker.start();
      inboundWorker.start();
      outboundWorker.start();
      reactionWorker.start();
    },
    async stop() {
      uninstallReactionCommandHandler();
      await reactionWorker.stop();
      await outboundWorker.stop();
      await inboundWorker.stop();
      await inboundAttachmentWorker.stop();
      lifecycle.stop();
      await provider.stop();
      runtime.stop();
    },
    inboundWorkerDependencies,
    inboundAttachmentWorkerDependencies,
  };
}
