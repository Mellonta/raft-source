import { createHash } from "node:crypto";

import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import { clearClockInterval, currentDate, setClockInterval } from "@botiverse/raft-shared";

import type { Database, DatabaseExecutor } from "../db/index";
import {
  agents,
  channelAgents,
  channels,
  externalActorProjections,
  externalAttachmentAssets,
  externalAttachmentMessageFacts,
  externalAppInstalls,
  externalHumanIdentityLinks,
  externalInboundEvents,
  externalMessageLinks,
  jointChannels,
  jointChannelServers,
  messageMentions,
  messages,
} from "../db/schema";
import { insertCanonicalExternalMessage } from "./externalProjectionService";
import { resolveExternalConversationTarget } from "./externalConversationTargetService";
import { recordInboxFactsForPersistedMessages } from "./messageService";
import type { JointThreadProjection } from "./channelService";
import {
  getActiveJointChannelProjectionsByLocalChannel,
  getActiveJointThreadProjectionsByCanonicalThread,
  isChannelAgent,
  isChannelHuman,
  startReadPositionAtJoin,
} from "./channelService";
import {
  createInboundExternalAttachmentTransferWithExecutor,
} from "./externalAttachmentTransferService";
import { linkAttachmentsToMessageWithExecutor } from "./attachmentLinkingService";
import { applyExternalReactionObservation } from "./externalReactionSyncService";

const INBOUND_LEASE_MS = 60_000;
const INBOUND_BLOCKED_RETRY_MS = 30_000;
const INBOUND_PAYLOAD_SCHEMA_V1 = "external-inbound-normalized-event.v1" as const;
const INBOUND_PAYLOAD_SCHEMA_V2 = "external-inbound-normalized-event.v2" as const;
const INBOUND_REACTION_PAYLOAD_SCHEMA = "external-inbound-normalized-reaction.v1" as const;
const ATTACHMENT_UNAVAILABLE_MARKER = "[One or more attachments unavailable]";

type InboundEvent = typeof externalInboundEvents.$inferSelect;

class ExternalInboundTargetUnavailableError extends Error {}

type LockedJointParentProjection = {
  serverId: string;
  localChannelId: string;
  role: "host" | "participant";
  status: "active" | "disconnected";
  joinedByUserId: string | null;
  channel: typeof channels.$inferSelect;
};

let inboundEventRowLockHookForTests: (() => Promise<void> | void) | null = null;
let inboundCanonicalCommitHookForTests: (() => Promise<void> | void) | null = null;

export function __setExternalInboundEventRowLockHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  inboundEventRowLockHookForTests = hook;
}

export function __setExternalInboundCanonicalCommitHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  inboundCanonicalCommitHookForTests = hook;
}

type ExternalInboundNormalizedMessageFields = {
  projectionId: string;
  actorProjectionRevision: number;
  externalActorId: string;
  providerMessageId: string;
  providerThreadId: string | null;
  content: string;
  createdAt: string;
};

export type ExternalInboundNormalizedMessage = ExternalInboundNormalizedMessageFields & (
  | { schema: typeof INBOUND_PAYLOAD_SCHEMA_V1 }
  | { schema: typeof INBOUND_PAYLOAD_SCHEMA_V2; providerFileIds: string[] }
);

type ParsedExternalInboundNormalizedMessage = ExternalInboundNormalizedMessageFields & {
  schema: typeof INBOUND_PAYLOAD_SCHEMA_V1 | typeof INBOUND_PAYLOAD_SCHEMA_V2;
  providerFileIds: string[];
};

type ParsedExternalInboundNormalizedReaction = {
  schema: typeof INBOUND_REACTION_PAYLOAD_SCHEMA;
  operation: "add" | "remove";
  providerMessageId: string;
  externalActorId: string;
  providerReactionKey: string;
  eventOccurredAt: string;
  eventSequence: number;
  botUserId: string;
};

export type ExternalInboundRuntimeAuthority = {
  runtimeRevision: string;
  provider: string;
  environment: "test" | "production";
  appRegistrationId: string;
  installId: string;
  workspaceId: string;
  providerAuthorityId: string;
  providerConversationId: string;
  bindingId: string;
  bindingEpoch: number;
  connectionEpoch: number;
  raftChannelId: string;
  privacyClass: "public" | "private";
};

export interface ExternalInboundWorkerDependencies {
  decryptNormalizedPayload(input: {
    eventId: string;
    ciphertext: string;
    envelopeKeyId: string;
    aad: {
      purpose: "external-inbound-normalized-event";
      aadVersion: 1;
      schemaVersion: 1 | 2 | 3;
      provider: string;
      environment: "test" | "production";
      appRegistrationId: string;
      installId: string;
      workspaceId: string;
      providerAuthorityId: string;
      providerConversationId: string;
      providerEventId: string;
      bindingId: string;
      bindingEpoch: number;
      connectionEpoch: number;
      runtimeRevision: string;
      raftChannelId: string;
      privacyClass: "public" | "private";
    };
    signal?: AbortSignal;
  }): Promise<string>;
  resolveCurrentRuntime(input: {
    eventId: string;
    frozenAuthority: ExternalInboundRuntimeAuthority;
    requiredCapabilities?: readonly ("attachment_transfer" | "reaction_sync")[];
    signal?: AbortSignal;
  }): Promise<ExternalInboundRuntimeAuthority | null>;
  resolveProviderMentionProfiles?(input: {
    eventId: string;
    frozenAuthority: ExternalInboundRuntimeAuthority;
    providerUserIds: readonly string[];
    signal?: AbortSignal;
  }): Promise<readonly { providerUserId: string; displayName: string; handle: string | null }[]>;
  onMessageCommitted?(input: { eventId: string; messageId: string }): Promise<void> | void;
  onMessageCommittedError?(error: unknown): void;
  onReactionCommitted?(input: { eventId: string; messageId: string }): Promise<void> | void;
  onReactionCommittedError?(error: unknown): void;
  now?(): Date;
}

export type ExternalInboundWorkerResult =
  | { kind: "disabled" }
  | { kind: "empty" }
  | { kind: "blocked"; eventId: string; reason: string }
  | { kind: "committed" | "duplicate" | "echo"; eventId: string; messageId: string };

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function nonEmpty(value: unknown, max = 320): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validClock(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function frozenAuthority(event: InboundEvent): ExternalInboundRuntimeAuthority {
  return {
    runtimeRevision: event.runtimeRevision,
    provider: event.provider,
    environment: event.environment,
    appRegistrationId: event.appRegistrationId,
    installId: event.installId,
    workspaceId: event.workspaceId,
    providerAuthorityId: event.providerAuthorityId,
    providerConversationId: event.providerConversationId,
    bindingId: event.bindingId,
    bindingEpoch: event.bindingEpoch,
    connectionEpoch: event.connectionEpoch,
    raftChannelId: event.raftChannelId,
    privacyClass: event.privacyClass,
  };
}

function sameAuthority(left: ExternalInboundRuntimeAuthority, right: ExternalInboundRuntimeAuthority): boolean {
  return (Object.keys(left) as (keyof ExternalInboundRuntimeAuthority)[])
    .every((key) => left[key] === right[key]);
}

function appendAttachmentUnavailableMarker(content: string): string {
  const suffix = `\n\n${ATTACHMENT_UNAVAILABLE_MARKER}`;
  const maximumContentBytes = 40_000 - Buffer.byteLength(suffix, "utf8");
  let prefix = "";
  let prefixBytes = 0;
  for (const character of content) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (prefixBytes + characterBytes > maximumContentBytes) break;
    prefix += character;
    prefixBytes += characterBytes;
  }
  return `${prefix}${suffix}`;
}

const SLACK_NATIVE_USER_MENTION = /<@([A-Z0-9]{2,160})(?:\|[^>\r\n]{1,160})?>/gu;

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\\`*_{}\[\]()<>#+.!|~-]/gu, "\\$&");
}

function slackMentionLabel(
  providerUserId: string,
  actor: Pick<typeof externalActorProjections.$inferSelect, "displayName" | "handles">,
): string {
  const opaqueId = providerUserId.trim().toLocaleLowerCase("en-US");
  const handle = actor.handles.find((candidate) => (
    /^[\p{L}\p{N}._-]{1,80}$/u.test(candidate)
    && candidate.trim().toLocaleLowerCase("en-US") !== opaqueId
  ));
  if (handle) return `@${handle}`;
  const displayName = actor.displayName.trim().replace(/\s+/gu, " ").slice(0, 80);
  return displayName && displayName.toLocaleLowerCase("en-US") !== opaqueId
    ? `@${escapeMarkdownLabel(displayName)}`
    : "@Slack user";
}

export function renderSlackInboundMentionLabels(
  content: string,
  labelsByProviderUserId: ReadonlyMap<string, string>,
): string {
  const rendered = content.replace(SLACK_NATIVE_USER_MENTION, (_token, providerUserId: string) => (
    labelsByProviderUserId.get(providerUserId) ?? "@Slack user"
  ));
  if (Buffer.byteLength(rendered, "utf8") <= 40_000) return rendered;
  // A pathological body can contain thousands of short mention tokens. Keep
  // the accepted content bound without restoring opaque provider identifiers.
  return content.replace(SLACK_NATIVE_USER_MENTION, "@user");
}

async function renderProviderInboundMentions(
  executor: DatabaseExecutor,
  event: InboundEvent,
  content: string,
  providerProfiles: readonly { providerUserId: string; displayName: string; handle: string | null }[] = [],
): Promise<string> {
  if (event.provider !== "slack") return content;
  const providerUserIds = [...new Set(
    [...content.matchAll(SLACK_NATIVE_USER_MENTION)].map((match) => match[1]!),
  )];
  if (providerUserIds.length === 0) return content;
  const actors = await executor.select({
    externalActorId: externalActorProjections.externalActorId,
    displayName: externalActorProjections.displayName,
    handles: externalActorProjections.handles,
  }).from(externalActorProjections).where(and(
    eq(externalActorProjections.provider, "slack"),
    eq(externalActorProjections.appRegistrationId, event.appRegistrationId),
    eq(externalActorProjections.installId, event.installId),
    eq(externalActorProjections.workspaceId, event.workspaceId),
    inArray(externalActorProjections.externalActorId, providerUserIds),
    eq(externalActorProjections.state, "active"),
    eq(externalActorProjections.deactivated, false),
  ));
  const labels = new Map(providerProfiles.map((profile) => [
    profile.providerUserId,
    slackMentionLabel(profile.providerUserId, {
      displayName: profile.displayName,
      handles: profile.handle ? [profile.handle] : [],
    }),
  ]));
  for (const actor of actors) {
    labels.set(actor.externalActorId, slackMentionLabel(actor.externalActorId, actor));
  }
  return renderSlackInboundMentionLabels(content, labels);
}

function parseNormalizedMessage(
  plaintext: string,
  expectedDigest: string,
): ParsedExternalInboundNormalizedMessage | null {
  if (sha256(plaintext) !== expectedDigest) return null;
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  const commonKeys = [
    "actorProjectionRevision",
    "content",
    "createdAt",
    "externalActorId",
    "projectionId",
    "providerMessageId",
    "providerThreadId",
  ];
  const expectedKeys = message.schema === INBOUND_PAYLOAD_SCHEMA_V2
    ? [...commonKeys, "providerFileIds", "schema"].sort()
    : [...commonKeys, "schema"].sort();
  if (Object.keys(message).sort().join("\0") !== expectedKeys.join("\0")) return null;
  const providerFileIds = message.schema === INBOUND_PAYLOAD_SCHEMA_V2
    ? message.providerFileIds
    : [];
  if (
    (message.schema !== INBOUND_PAYLOAD_SCHEMA_V1 && message.schema !== INBOUND_PAYLOAD_SCHEMA_V2)
    || !nonEmpty(message.projectionId)
    || !positive(message.actorProjectionRevision)
    || !nonEmpty(message.externalActorId)
    || !nonEmpty(message.providerMessageId, 160)
    || !(message.providerThreadId === null || nonEmpty(message.providerThreadId, 160))
    || !nonEmpty(message.content, 40_000)
    || !nonEmpty(message.createdAt, 80)
    || !Number.isFinite(Date.parse(message.createdAt))
    || new Date(message.createdAt).toISOString() !== message.createdAt
    || !Array.isArray(providerFileIds)
    || providerFileIds.length > 10
    || providerFileIds.some((fileId) => !nonEmpty(fileId, 320))
    || new Set(providerFileIds).size !== providerFileIds.length
  ) return null;
  return { ...message, providerFileIds } as unknown as ParsedExternalInboundNormalizedMessage;
}

function parseNormalizedReaction(
  plaintext: string,
  expectedDigest: string,
): ParsedExternalInboundNormalizedReaction | null {
  if (sha256(plaintext) !== expectedDigest) return null;
  let value: unknown;
  try { value = JSON.parse(plaintext); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reaction = value as Record<string, unknown>;
  if (
    Object.keys(reaction).sort().join("\0") !== [
      "botUserId",
      "eventOccurredAt",
      "eventSequence",
      "externalActorId",
      "operation",
      "providerMessageId",
      "providerReactionKey",
      "schema",
    ].sort().join("\0")
    || reaction.schema !== INBOUND_REACTION_PAYLOAD_SCHEMA
    || (reaction.operation !== "add" && reaction.operation !== "remove")
    || !nonEmpty(reaction.providerMessageId, 160)
    || !nonEmpty(reaction.externalActorId, 160)
    || !nonEmpty(reaction.providerReactionKey, 160)
    || !nonEmpty(reaction.botUserId, 160)
    || !nonEmpty(reaction.eventOccurredAt, 80)
    || !positive(reaction.eventSequence)
    || !Number.isFinite(Date.parse(reaction.eventOccurredAt))
    || new Date(reaction.eventOccurredAt).toISOString() !== reaction.eventOccurredAt
  ) return null;
  return reaction as ParsedExternalInboundNormalizedReaction;
}

function terminalErase(event: InboundEvent, status: "committed" | "duplicate" | "echo", messageId: string, now: Date) {
  return {
    status,
    encryptedPayload: null,
    envelopeKeyId: null,
    payloadExpiresAt: null,
    payloadErasedAt: now,
    payloadTombstoneDigest: sha256(JSON.stringify([
      "external-inbound-payload-tombstone",
      "v1",
      event.id,
      event.normalizedPayloadDigest,
      status,
      messageId,
    ])),
    committedMessageId: messageId,
    outcomeReason: `provider_inbound_${status}`,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: now,
  } as const;
}

function terminalEraseWithoutMessage(
  event: InboundEvent,
  status: "dead" | "quarantined" | "revoked",
  reason: string,
  now: Date,
) {
  return {
    status,
    encryptedPayload: null,
    envelopeKeyId: null,
    payloadExpiresAt: null,
    payloadErasedAt: now,
    payloadTombstoneDigest: sha256(JSON.stringify([
      "external-inbound-payload-tombstone",
      "v1",
      event.id,
      event.normalizedPayloadDigest,
      status,
      reason,
    ])),
    committedMessageId: null,
    outcomeReason: reason,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: now,
  } as const;
}

async function releaseLease(
  db: Database,
  eventId: string,
  leaseOwner: string,
  leaseGeneration: number,
  reason: string,
  now: Date,
): Promise<void> {
  await db.update(externalInboundEvents).set({
    status: "queued",
    leaseOwner: null,
    leaseExpiresAt: null,
    outcomeReason: reason,
    updatedAt: now,
  }).where(and(
    eq(externalInboundEvents.id, eventId),
    eq(externalInboundEvents.status, "processing"),
    eq(externalInboundEvents.leaseOwner, leaseOwner),
    eq(externalInboundEvents.leaseGeneration, leaseGeneration),
  ));
}

async function terminalizeLeaseWithoutMessage(
  db: Database,
  event: InboundEvent,
  leaseOwner: string,
  leaseGeneration: number,
  status: "dead" | "quarantined" | "revoked",
  reason: string,
  now: Date,
): Promise<void> {
  await db.update(externalInboundEvents).set(terminalEraseWithoutMessage(event, status, reason, now)).where(and(
    eq(externalInboundEvents.id, event.id),
    eq(externalInboundEvents.status, "processing"),
    eq(externalInboundEvents.leaseOwner, leaseOwner),
    eq(externalInboundEvents.leaseGeneration, leaseGeneration),
  ));
}

async function resolveTargetChannel(
  executor: DatabaseExecutor,
  event: InboundEvent,
  payload: ExternalInboundNormalizedMessage,
): Promise<{
  channel: typeof channels.$inferSelect;
  canonicalRootMessageId: string | null;
  jointThreadProjection: JointThreadProjection | null;
} | null> {
  const conversationTarget = await resolveExternalConversationTarget({
    executor,
    authorityChannelId: event.raftChannelId,
  });
  if (!conversationTarget) return null;
  // Channel rows are only serialized and revalidated here, never re-keyed, so
  // every channel lock in this resolver is FOR NO KEY UPDATE: it still
  // excludes Raft send admission and archive/delete writes, but not the FOR KEY
  // SHARE that foreign-key checks (inbox facts, push outbox, mentions) take on
  // the same rows. Rows are also taken in the Raft send path's order, so the
  // two cannot form a cycle: Joint parent projections (local parents) ->
  // canonical parent -> local thread projections -> canonical thread. A Raft
  // Joint-thread send locks local parent -> its local thread -> canonical
  // thread; a Joint channel send locks local parent -> canonical parent.
  const [authorityChannel] = await executor.select().from(channels)
    .where(eq(channels.id, conversationTarget.authorityChannelId)).for("no key update").limit(1);
  if (conversationTarget.kind === "joint" && payload.providerThreadId) {
    // The host's local parent (authority) was taken above, ahead of this sorted
    // set; that is safe only because a host's local channel is never the
    // canonical one, so no locker can hold the canonical parent and want it.
    // A thread reply freezes every active parent projection below; take their
    // rows before the canonical parent, as a Joint channel send does.
    await executor.select({ id: channels.id }).from(jointChannelServers)
      .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
      .where(and(
        eq(jointChannelServers.jointChannelId, conversationTarget.jointChannelId),
        eq(jointChannelServers.status, "active"),
      ))
      .orderBy(asc(jointChannelServers.serverId))
      .for("no key update", { of: channels });
  }
  const [parentChannel] = await executor.select().from(channels)
    .where(eq(channels.id, conversationTarget.storageChannelId)).for("no key update").limit(1);
  if (
    !authorityChannel
    || !parentChannel
    || authorityChannel.deletedAt
    || authorityChannel.archivedAt
    || parentChannel.type === "thread"
    || parentChannel.deletedAt
    || parentChannel.archivedAt
    || (conversationTarget.kind === "joint" && (
      conversationTarget.role !== "host"
      || event.privacyClass !== "public"
      || authorityChannel.type !== "joint"
      || parentChannel.type !== "channel"
    ))
    || (conversationTarget.kind === "ordinary"
      && event.privacyClass === "public" && parentChannel.type !== "channel")
    || (conversationTarget.kind === "ordinary"
      && event.privacyClass === "private" && parentChannel.type !== "private")
  ) return null;
  if (!payload.providerThreadId) {
    return {
      channel: parentChannel,
      canonicalRootMessageId: null,
      jointThreadProjection: null,
    };
  }

  const [rootLink] = await executor.select().from(externalMessageLinks).where(and(
    eq(externalMessageLinks.provider, event.provider),
    eq(externalMessageLinks.installId, event.installId),
    eq(externalMessageLinks.providerAuthorityId, event.providerAuthorityId),
    eq(externalMessageLinks.providerConversationId, event.providerConversationId),
    eq(externalMessageLinks.providerMessageId, payload.providerThreadId),
    eq(externalMessageLinks.bindingId, event.bindingId),
    eq(externalMessageLinks.bindingEpoch, event.bindingEpoch),
    eq(externalMessageLinks.connectionEpoch, event.connectionEpoch),
    eq(externalMessageLinks.outcomeState, "accepted"),
    eq(externalMessageLinks.authorityState, "active"),
  )).for("update").limit(1);
  if (!rootLink) return null;
  const [rootMessage] = await executor.select().from(messages)
    .where(eq(messages.id, rootLink.raftMessageId)).for("update").limit(1);
  if (!rootMessage || rootMessage.channelId !== parentChannel.id) return null;

  let lockedJointParentProjections: LockedJointParentProjection[] | null = null;
  if (conversationTarget.kind === "joint") {
    const [parentJoint] = await executor.select().from(jointChannels).where(and(
      eq(jointChannels.id, conversationTarget.jointChannelId),
      eq(jointChannels.canonicalChannelId, parentChannel.id),
      eq(jointChannels.status, "active"),
    )).for("update").limit(1);
    if (!parentJoint) return null;

    const parentProjections = await executor.select({
      serverId: jointChannelServers.serverId,
      localChannelId: jointChannelServers.localChannelId,
      role: jointChannelServers.role,
      status: jointChannelServers.status,
      joinedByUserId: jointChannelServers.joinedByUserId,
      channel: channels,
    }).from(jointChannelServers)
      .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
      .where(and(
        eq(jointChannelServers.jointChannelId, parentJoint.id),
        eq(jointChannelServers.status, "active"),
      ))
      .orderBy(asc(jointChannelServers.serverId))
      .for("no key update");
    if (
      parentProjections.length === 0
      || parentProjections.some((projection) =>
        projection.status !== "active"
        || projection.channel.serverId !== projection.serverId
        || projection.channel.type !== "joint"
        || projection.channel.deletedAt
        || projection.channel.archivedAt
      )
      || !parentProjections.some((projection) =>
        projection.localChannelId === event.raftChannelId
        && projection.serverId === conversationTarget.serverId
        && projection.role === "host"
      )
    ) return null;
    lockedJointParentProjections = parentProjections;
  }

  // The root message row locked above serializes every creator of this
  // canonical thread (inbound replies here; Raft thread creation takes its
  // foreign-key share on the same root), so finding or creating the thread
  // needs no thread-row lock yet. The canonical thread row itself is locked
  // last, after any local thread projection, matching Raft send admission.
  const findCanonicalThread = () => executor.select().from(channels).where(and(
    eq(channels.type, "thread"),
    eq(channels.parentMessageId, rootMessage.id),
  )).limit(1);
  let [threadChannel] = await findCanonicalThread();
  if (!threadChannel) {
    [threadChannel] = await executor.insert(channels).values({
      serverId: parentChannel.serverId,
      name: `thread-${rootMessage.id.slice(0, 8)}`,
      type: "thread",
      parentMessageId: rootMessage.id,
    }).onConflictDoNothing().returning();
    if (!threadChannel) [threadChannel] = await findCanonicalThread();
  }
  if (!threadChannel || threadChannel.serverId !== parentChannel.serverId || threadChannel.deletedAt) {
    throw new ExternalInboundTargetUnavailableError();
  }
  const canonicalThreadId = threadChannel.id;
  const lockCanonicalThread = async () => {
    const [locked] = await executor.select().from(channels)
      .where(eq(channels.id, canonicalThreadId)).for("no key update").limit(1);
    if (
      !locked
      || locked.type !== "thread"
      || locked.parentMessageId !== rootMessage.id
      || locked.serverId !== parentChannel.serverId
      || locked.deletedAt
    ) throw new ExternalInboundTargetUnavailableError();
    return locked;
  };
  if (rootMessage.threadId !== threadChannel.id) {
    await executor.update(messages).set({ threadId: threadChannel.id })
      .where(eq(messages.id, rootMessage.id));
  }

  if (conversationTarget.kind === "ordinary") {
    return {
      channel: await lockCanonicalThread(),
      canonicalRootMessageId: rootMessage.id,
      jointThreadProjection: null,
    };
  }

  // The accepted provider root serializes every reply racing to create the
  // same canonical thread. Under that lock, freeze the complete active Joint
  // parent projection set and materialize one local thread face per active
  // server before the reply itself is inserted.
  if (!lockedJointParentProjections) throw new ExternalInboundTargetUnavailableError();

  const existingJointThreads = await executor.select().from(jointChannels).where(and(
    eq(jointChannels.canonicalChannelId, threadChannel.id),
    eq(jointChannels.status, "active"),
  )).for("update").limit(2);
  if (existingJointThreads.length > 1) throw new ExternalInboundTargetUnavailableError();
  let [jointThread] = existingJointThreads;
  if (!jointThread) {
    [jointThread] = await executor.insert(jointChannels).values({
      canonicalChannelId: threadChannel.id,
      createdByServerId: conversationTarget.serverId,
      createdByUserId: null,
      status: "active",
    }).returning();
  }
  if (!jointThread || jointThread.canonicalChannelId !== threadChannel.id) {
    throw new ExternalInboundTargetUnavailableError();
  }

  let hostThreadProjection: JointThreadProjection | null = null;
  for (const parentProjection of lockedJointParentProjections) {
    let [threadProjection] = await executor.select().from(jointChannelServers).where(and(
      eq(jointChannelServers.jointChannelId, jointThread.id),
      eq(jointChannelServers.serverId, parentProjection.serverId),
    )).for("update").limit(1);
    let localThreadChannel: typeof channels.$inferSelect | undefined;
    if (threadProjection) {
      [localThreadChannel] = await executor.select().from(channels)
        .where(eq(channels.id, threadProjection.localChannelId)).for("no key update").limit(1);
    } else {
      [localThreadChannel] = await executor.insert(channels).values({
        serverId: parentProjection.serverId,
        name: `thread-${rootMessage.id.slice(0, 8)}`,
        type: "thread",
        parentMessageId: null,
      }).returning();
      [threadProjection] = await executor.insert(jointChannelServers).values({
        jointChannelId: jointThread.id,
        serverId: parentProjection.serverId,
        localChannelId: localThreadChannel.id,
        role: parentProjection.role,
        status: "active",
        joinedByUserId: parentProjection.joinedByUserId,
      }).returning();
    }
    if (
      !threadProjection
      || !localThreadChannel
      || threadProjection.status !== "active"
      || threadProjection.role !== parentProjection.role
      || threadProjection.localChannelId !== localThreadChannel.id
      || localThreadChannel.serverId !== parentProjection.serverId
      || localThreadChannel.type !== "thread"
      || localThreadChannel.parentMessageId !== null
      || localThreadChannel.deletedAt
      || localThreadChannel.archivedAt
    ) throw new ExternalInboundTargetUnavailableError();

    if (parentProjection.localChannelId === event.raftChannelId) {
      hostThreadProjection = {
        jointThreadId: jointThread.id,
        localThreadChannelId: localThreadChannel.id,
        canonicalThreadChannelId: threadChannel.id,
        localServerId: parentProjection.serverId,
        localParentChannelId: parentProjection.localChannelId,
        canonicalParentChannelId: parentChannel.id,
        canonicalParentMessageId: rootMessage.id,
        role: parentProjection.role,
        threadChannel: localThreadChannel,
      };
    }
  }
  if (!hostThreadProjection) throw new ExternalInboundTargetUnavailableError();
  const lockedCanonicalThread = await lockCanonicalThread();
  return {
    channel: lockedCanonicalThread,
    canonicalRootMessageId: rootMessage.id,
    jointThreadProjection: hostThreadProjection,
  };
}

export async function enqueueExternalInboundEvent(input: {
  db: Database;
  authority: ExternalInboundRuntimeAuthority;
  providerEventId: string;
  normalizedPayloadDigest: string;
  encryptedPayload: string;
  envelopeKeyId: string;
  payloadSchemaVersion?: 1 | 2;
  payloadExpiresAt: Date;
  receivedAt?: Date;
}): Promise<{ event: InboundEvent; duplicate: boolean }> {
  const now = input.receivedAt ?? currentDate();
  const payloadSchemaVersion = input.payloadSchemaVersion ?? 1;
  if (
    !validClock(now)
    || !validClock(input.payloadExpiresAt)
    || input.payloadExpiresAt.getTime() <= now.getTime()
    || !nonEmpty(input.providerEventId, 320)
    || !/^[0-9a-f]{64}$/.test(input.normalizedPayloadDigest)
    || !nonEmpty(input.encryptedPayload, 1_000_000)
    || !nonEmpty(input.envelopeKeyId, 320)
    || (payloadSchemaVersion !== 1 && payloadSchemaVersion !== 2)
  ) throw new Error("External inbound sealed event admission is invalid");
  const authority = input.authority;
  if (
    !nonEmpty(authority.runtimeRevision)
    || !nonEmpty(authority.provider, 80)
    || !nonEmpty(authority.appRegistrationId)
    || !nonEmpty(authority.installId, 160)
    || !nonEmpty(authority.workspaceId)
    || !nonEmpty(authority.providerAuthorityId, 160)
    || !nonEmpty(authority.providerConversationId, 160)
    || !nonEmpty(authority.bindingId, 160)
    || !nonEmpty(authority.raftChannelId)
    || !positive(authority.bindingEpoch)
    || !positive(authority.connectionEpoch)
    || (authority.environment !== "test" && authority.environment !== "production")
    || (authority.privacyClass !== "public" && authority.privacyClass !== "private")
  ) throw new Error("External inbound frozen authority is invalid");

  const [event] = await input.db.insert(externalInboundEvents).values({
    provider: authority.provider,
    environment: authority.environment,
    appRegistrationId: authority.appRegistrationId,
    installId: authority.installId,
    workspaceId: authority.workspaceId,
    providerAuthorityId: authority.providerAuthorityId,
    providerConversationId: authority.providerConversationId,
    providerEventId: input.providerEventId,
    bindingId: authority.bindingId,
    bindingEpoch: authority.bindingEpoch,
    connectionEpoch: authority.connectionEpoch,
    runtimeRevision: authority.runtimeRevision,
    raftChannelId: authority.raftChannelId,
    privacyClass: authority.privacyClass,
    normalizedPayloadDigest: input.normalizedPayloadDigest,
    encryptedPayload: input.encryptedPayload,
    envelopeKeyId: input.envelopeKeyId,
    payloadSchemaVersion,
    payloadExpiresAt: input.payloadExpiresAt,
    receivedAt: now,
    updatedAt: now,
  }).onConflictDoNothing({
    target: [
      externalInboundEvents.provider,
      externalInboundEvents.appRegistrationId,
      externalInboundEvents.providerEventId,
    ],
  }).returning();
  if (event) return { event, duplicate: false };

  const [existing] = await input.db.select().from(externalInboundEvents).where(and(
    eq(externalInboundEvents.provider, authority.provider),
    eq(externalInboundEvents.appRegistrationId, authority.appRegistrationId),
    eq(externalInboundEvents.providerEventId, input.providerEventId),
  )).limit(1);
  if (!existing) throw new Error("External inbound provider event replay disappeared");
  if (
    existing.normalizedPayloadDigest !== input.normalizedPayloadDigest
    || existing.payloadSchemaVersion !== payloadSchemaVersion
    || !sameAuthority(frozenAuthority(existing), authority)
  ) throw new Error("External inbound provider event identity conflicts with frozen admission");
  return { event: existing, duplicate: true };
}

export async function processExternalInboundEventOnce(input: {
  db: Database;
  leaseOwner: string;
  dependencies?: ExternalInboundWorkerDependencies | null;
  signal?: AbortSignal;
}): Promise<ExternalInboundWorkerResult> {
  if (!input.dependencies) return { kind: "disabled" };
  if (!nonEmpty(input.leaseOwner, 160)) throw new Error("External inbound lease owner is invalid");
  const claimAt = input.dependencies.now?.() ?? currentDate();
  if (!validClock(claimAt)) throw new Error("External inbound clock is invalid");
  const blockedRetryThreshold = new Date(claimAt.getTime() - INBOUND_BLOCKED_RETRY_MS);

  const claim = await input.db.transaction(async (executor) => {
    const eligibleAt = sql<Date>`CASE
      WHEN ${externalInboundEvents.status} = 'processing' THEN ${externalInboundEvents.leaseExpiresAt}
      WHEN ${externalInboundEvents.outcomeReason} IS NULL THEN ${externalInboundEvents.receivedAt}
      ELSE ${externalInboundEvents.updatedAt} + (${INBOUND_BLOCKED_RETRY_MS} * interval '1 millisecond')
    END`;
    const [candidate] = await executor.select().from(externalInboundEvents).where(or(
      and(
        eq(externalInboundEvents.status, "queued"),
        or(
          isNull(externalInboundEvents.outcomeReason),
          lte(externalInboundEvents.updatedAt, blockedRetryThreshold),
        ),
      ),
      and(
        eq(externalInboundEvents.status, "processing"),
        lt(externalInboundEvents.leaseExpiresAt, claimAt),
      ),
    )).orderBy(asc(eligibleAt), asc(externalInboundEvents.receivedAt)).for("update").limit(1);
    if (!candidate) return null;
    const leaseGeneration = candidate.leaseGeneration + 1;
    const [claimed] = await executor.update(externalInboundEvents).set({
      status: "processing",
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: new Date(claimAt.getTime() + INBOUND_LEASE_MS),
      leaseGeneration,
      outcomeReason: null,
      updatedAt: claimAt,
    }).where(eq(externalInboundEvents.id, candidate.id)).returning();
    return claimed;
  });
  if (!claim) return { kind: "empty" };
  const releaseClaim = async (reason: string): Promise<void> => {
    const releaseAt = input.dependencies?.now?.() ?? currentDate();
    if (!validClock(releaseAt)) throw new Error("External inbound release clock is invalid");
    await releaseLease(
      input.db,
      claim.id,
      input.leaseOwner,
      claim.leaseGeneration,
      reason,
      releaseAt,
    );
  };
  if (!claim.encryptedPayload || !claim.envelopeKeyId || !claim.payloadExpiresAt) {
    await releaseClaim("payload_custody_missing");
    return { kind: "blocked", eventId: claim.id, reason: "payload_custody_missing" };
  }
  if (claim.payloadExpiresAt.getTime() <= claimAt.getTime()) {
    await terminalizeLeaseWithoutMessage(
      input.db,
      claim,
      input.leaseOwner,
      claim.leaseGeneration,
      "dead",
      "payload_expired",
      claimAt,
    );
    return { kind: "blocked", eventId: claim.id, reason: "payload_expired" };
  }

  let plaintext: string;
  try {
    plaintext = await input.dependencies.decryptNormalizedPayload({
      eventId: claim.id,
      ciphertext: claim.encryptedPayload,
      envelopeKeyId: claim.envelopeKeyId,
      aad: {
        purpose: "external-inbound-normalized-event",
        aadVersion: 1,
        schemaVersion: claim.payloadSchemaVersion as 1 | 2 | 3,
        provider: claim.provider,
        environment: claim.environment,
        appRegistrationId: claim.appRegistrationId,
        installId: claim.installId,
        workspaceId: claim.workspaceId,
        providerAuthorityId: claim.providerAuthorityId,
        providerConversationId: claim.providerConversationId,
        providerEventId: claim.providerEventId,
        bindingId: claim.bindingId,
        bindingEpoch: claim.bindingEpoch,
        connectionEpoch: claim.connectionEpoch,
        runtimeRevision: claim.runtimeRevision,
        raftChannelId: claim.raftChannelId,
        privacyClass: claim.privacyClass,
      },
      signal: input.signal,
    });
  } catch {
    await releaseClaim("payload_decrypt_failed");
    return { kind: "blocked", eventId: claim.id, reason: "payload_decrypt_failed" };
  }
  const reactionPayload = claim.payloadSchemaVersion === 3
    ? parseNormalizedReaction(plaintext, claim.normalizedPayloadDigest)
    : null;
  const payload = claim.payloadSchemaVersion === 3
    ? null
    : parseNormalizedMessage(plaintext, claim.normalizedPayloadDigest);
  if (!payload && !reactionPayload) {
    await terminalizeLeaseWithoutMessage(
      input.db,
      claim,
      input.leaseOwner,
      claim.leaseGeneration,
      "quarantined",
      "payload_invalid",
      claimAt,
    );
    return { kind: "blocked", eventId: claim.id, reason: "payload_invalid" };
  }
  const frozen = frozenAuthority(claim);
  const runtime = await input.dependencies.resolveCurrentRuntime({
    eventId: claim.id,
    frozenAuthority: frozen,
    requiredCapabilities: reactionPayload
      ? ["reaction_sync"]
      : payload!.providerFileIds.length > 0
        ? ["attachment_transfer"]
        : [],
    signal: input.signal,
  }).catch(() => null);
  if (!runtime || !sameAuthority(runtime, frozen)) {
    await releaseClaim("runtime_authority_inactive_or_mismatched");
    return { kind: "blocked", eventId: claim.id, reason: "runtime_authority_inactive_or_mismatched" };
  }

  let providerMentionProfiles: readonly {
    providerUserId: string;
    displayName: string;
    handle: string | null;
  }[] = [];
  if (payload && frozen.provider === "slack" && input.dependencies.resolveProviderMentionProfiles) {
    const mentionedIds = [...new Set(
      [...payload.content.matchAll(SLACK_NATIVE_USER_MENTION)].map((match) => match[1]!),
    )].slice(0, 50);
    const currentActors = mentionedIds.length === 0 ? [] : await input.db.select({
      externalActorId: externalActorProjections.externalActorId,
    }).from(externalActorProjections).where(and(
      eq(externalActorProjections.provider, "slack"),
      eq(externalActorProjections.appRegistrationId, claim.appRegistrationId),
      eq(externalActorProjections.installId, claim.installId),
      eq(externalActorProjections.workspaceId, claim.workspaceId),
      inArray(externalActorProjections.externalActorId, mentionedIds),
      eq(externalActorProjections.state, "active"),
      eq(externalActorProjections.deactivated, false),
    ));
    const currentIds = new Set(currentActors.map((actor) => actor.externalActorId));
    const missingIds = mentionedIds.filter((providerUserId) => !currentIds.has(providerUserId));
    providerMentionProfiles = missingIds.length === 0
      ? []
      : await input.dependencies.resolveProviderMentionProfiles({
        eventId: claim.id,
        frozenAuthority: frozen,
        providerUserIds: missingIds,
        signal: input.signal,
      }).catch(() => []);
  }

  if (reactionPayload) {
    const reactionAt = input.dependencies.now?.() ?? currentDate();
    try {
      const applied = await input.db.transaction(async (tx) => {
        const [event] = await tx.select().from(externalInboundEvents).where(and(
          eq(externalInboundEvents.id, claim.id),
          eq(externalInboundEvents.status, "processing"),
          eq(externalInboundEvents.leaseOwner, input.leaseOwner),
          eq(externalInboundEvents.leaseGeneration, claim.leaseGeneration),
        )).for("update").limit(1);
        if (!event || !event.leaseExpiresAt || event.leaseExpiresAt <= reactionAt) return null;
        const result = await applyExternalReactionObservation({
          tx,
          inboundEventId: event.id,
          providerEventId: event.providerEventId,
          operation: reactionPayload.operation,
          providerMessageId: reactionPayload.providerMessageId,
          externalActorId: reactionPayload.externalActorId,
          providerReactionKey: reactionPayload.providerReactionKey,
          eventOccurredAt: new Date(reactionPayload.eventOccurredAt),
          eventSequence: reactionPayload.eventSequence,
          botUserId: reactionPayload.botUserId,
          now: reactionAt,
        });
        if (result.outcome === "quarantined") {
          await tx.update(externalInboundEvents).set(terminalEraseWithoutMessage(
            event,
            "quarantined",
            "reaction_event_order_conflict",
            reactionAt,
          )).where(eq(externalInboundEvents.id, event.id));
          return { status: "quarantined" as const, messageId: result.raftMessageId, changed: false };
        }
        const status = result.outcome === "bot_echo" ? "echo" as const : "committed" as const;
        await tx.update(externalInboundEvents).set(terminalErase(event, status, result.raftMessageId, reactionAt))
          .where(eq(externalInboundEvents.id, event.id));
        return { status, messageId: result.raftMessageId, changed: result.changed };
      });
      if (!applied) {
        await releaseClaim("reaction_commit_authority_lost");
        return { kind: "blocked", eventId: claim.id, reason: "reaction_commit_authority_lost" };
      }
      if (applied.status === "quarantined") {
        return { kind: "blocked", eventId: claim.id, reason: "reaction_event_order_conflict" };
      }
      if (applied.status === "committed" && applied.changed && input.dependencies.onReactionCommitted) {
        try {
          await input.dependencies.onReactionCommitted({
            eventId: claim.id,
            messageId: applied.messageId,
          });
        } catch (error) {
          // Reaction state is already durable. Realtime is an acceleration
          // path and must never replay the provider event on socket failure.
          try {
            input.dependencies.onReactionCommittedError?.(error);
          } catch {
            // Observability must not restore a retry after durable commit.
          }
        }
      }
      return { kind: applied.status, eventId: claim.id, messageId: applied.messageId };
    } catch {
      await releaseClaim("reaction_commit_blocked");
      return { kind: "blocked", eventId: claim.id, reason: "reaction_commit_blocked" };
    }
  }
  if (!payload) throw new Error("External inbound message payload routing invariant failed");

  if (payload.providerFileIds.length > 0) {
    let attachmentFacts;
    try {
      attachmentFacts = await input.db.transaction(async (executor) => {
        const [event] = await executor.select().from(externalInboundEvents).where(and(
          eq(externalInboundEvents.id, claim.id),
          eq(externalInboundEvents.status, "processing"),
          eq(externalInboundEvents.leaseOwner, input.leaseOwner),
          eq(externalInboundEvents.leaseGeneration, claim.leaseGeneration),
        )).for("update").limit(1);
        if (!event) return null;
        for (const [orderedPosition, providerFileId] of payload.providerFileIds.entries()) {
          await createInboundExternalAttachmentTransferWithExecutor(executor, {
            provider: event.provider,
            appRegistrationId: event.appRegistrationId,
            installId: event.installId,
            workspaceId: event.workspaceId,
            providerAuthorityId: event.providerAuthorityId,
            providerFileId,
            inboundEventId: event.id,
            connectionEpoch: event.connectionEpoch,
            bindingId: event.bindingId,
            bindingEpoch: event.bindingEpoch,
            orderedPosition,
            sourceActorProjectionId: payload.projectionId,
          }, claimAt);
        }
        return executor.select().from(externalAttachmentMessageFacts)
          .where(eq(externalAttachmentMessageFacts.inboundEventId, event.id))
          .orderBy(asc(externalAttachmentMessageFacts.orderedPosition))
          .for("update");
      });
    } catch {
      await releaseClaim("attachment_transfer_prepare_failed");
      return { kind: "blocked", eventId: claim.id, reason: "attachment_transfer_prepare_failed" };
    }
    if (!attachmentFacts || attachmentFacts.length !== payload.providerFileIds.length) {
      await terminalizeLeaseWithoutMessage(
        input.db,
        claim,
        input.leaseOwner,
        claim.leaseGeneration,
        "quarantined",
        "attachment_transfer_set_invalid",
        claimAt,
      );
      return { kind: "blocked", eventId: claim.id, reason: "attachment_transfer_set_invalid" };
    }
    if (attachmentFacts.some((fact) => fact.state === "pending")) {
      await releaseClaim("attachment_transfer_pending");
      return { kind: "blocked", eventId: claim.id, reason: "attachment_transfer_pending" };
    }
    if (attachmentFacts.some((fact) => fact.state !== "stored" && fact.state !== "unavailable" && fact.state !== "revoked")) {
      await terminalizeLeaseWithoutMessage(
        input.db,
        claim,
        input.leaseOwner,
        claim.leaseGeneration,
        "quarantined",
        "attachment_transfer_state_invalid",
        claimAt,
      );
      return { kind: "blocked", eventId: claim.id, reason: "attachment_transfer_state_invalid" };
    }
  }

  let commitAt = claimAt;
  let commitBlockReason = "commit_authority_lost_or_root_unavailable";
  let committed: ExternalInboundWorkerResult | null = null;
  try {
    committed = await input.db.transaction(async (executor): Promise<ExternalInboundWorkerResult | null> => {
      const [event] = await executor.select().from(externalInboundEvents).where(and(
        eq(externalInboundEvents.id, claim.id),
        eq(externalInboundEvents.status, "processing"),
        eq(externalInboundEvents.leaseOwner, input.leaseOwner),
        eq(externalInboundEvents.leaseGeneration, claim.leaseGeneration),
      )).for("update").limit(1);
      if (!event) return null;
      if (inboundEventRowLockHookForTests) await inboundEventRowLockHookForTests();
      const freshCommitAt = input.dependencies?.now?.() ?? currentDate();
      if (!validClock(freshCommitAt)) {
        commitBlockReason = "invalid_commit_clock";
        return null;
      }
      commitAt = freshCommitAt;
      if (!event.leaseExpiresAt || event.leaseExpiresAt.getTime() <= commitAt.getTime()) {
        commitBlockReason = "lease_expired_before_canonical_commit";
        return null;
      }
      if (!event.payloadExpiresAt || event.payloadExpiresAt.getTime() <= commitAt.getTime()) {
        commitBlockReason = "payload_expired_before_canonical_commit";
        return null;
      }

      const [existingLink] = await executor.select().from(externalMessageLinks).where(and(
        eq(externalMessageLinks.provider, event.provider),
        eq(externalMessageLinks.installId, event.installId),
        eq(externalMessageLinks.providerAuthorityId, event.providerAuthorityId),
        eq(externalMessageLinks.providerConversationId, event.providerConversationId),
        eq(externalMessageLinks.providerMessageId, payload.providerMessageId),
      )).for("update").limit(1);
      if (existingLink) {
        if (
          existingLink.firstDirection === "provider_inbound"
          && existingLink.payloadFingerprint !== event.normalizedPayloadDigest
        ) {
          await executor.update(externalInboundEvents).set(terminalEraseWithoutMessage(
            event,
            "quarantined",
            "provider_message_payload_conflict",
            commitAt,
          )).where(eq(externalInboundEvents.id, event.id));
          return {
            kind: "blocked",
            eventId: event.id,
            reason: "provider_message_payload_conflict",
          };
        }
        const status = existingLink.firstDirection === "raft_outbound" ? "echo" : "duplicate";
        await executor.update(externalInboundEvents).set(terminalErase(event, status, existingLink.raftMessageId, commitAt))
          .where(eq(externalInboundEvents.id, event.id));
        return { kind: status, eventId: event.id, messageId: existingLink.raftMessageId };
      }

      const target = await resolveTargetChannel(executor, event, payload);
      if (!target) return null;
      // Joint commits store on the canonical channel/thread, which carries no
      // member rows of its own — facts fan out per active local projection
      // (each face's own channel id as sourceChannelId). Threads resolve
      // their faces inside recordInboxFacts via jointThreadProjection; a
      // top-level Joint target needs its channel projections frozen here,
      // matching the send path's executor requirement.
      const jointChannelProjections = target.channel.type !== "thread"
        ? await getActiveJointChannelProjectionsByLocalChannel(target.channel.id, executor)
        : [];
      const jointThreadFaces = target.jointThreadProjection
        ? await getActiveJointThreadProjectionsByCanonicalThread(
            target.jointThreadProjection.canonicalThreadChannelId,
            executor,
          )
        : [];
      const attachmentFacts = payload.providerFileIds.length === 0
        ? []
        : await executor.select().from(externalAttachmentMessageFacts)
          .where(eq(externalAttachmentMessageFacts.inboundEventId, event.id))
          .orderBy(asc(externalAttachmentMessageFacts.orderedPosition))
          .for("update");
      if (
        attachmentFacts.length !== payload.providerFileIds.length
        || attachmentFacts.some((fact) => (
          fact.state !== "stored" && fact.state !== "unavailable" && fact.state !== "revoked"
        ))
      ) {
        commitBlockReason = "attachment_transfer_pending";
        return null;
      }
      const unavailableAttachment = attachmentFacts.some(
        (fact) => fact.state === "unavailable" || fact.state === "revoked",
      );
      const providerRenderedContent = await renderProviderInboundMentions(
        executor,
        event,
        payload.content,
        providerMentionProfiles,
      );
      const [sourceInstall] = await executor
        .select({ workspaceName: externalAppInstalls.workspaceName, botUserId: externalAppInstalls.botUserId })
        .from(externalAppInstalls)
        .where(and(
          eq(externalAppInstalls.id, event.installId),
          eq(externalAppInstalls.registrationId, event.appRegistrationId),
          eq(externalAppInstalls.providerAuthorityId, event.providerAuthorityId),
        ))
        .limit(1);
      const result = await insertCanonicalExternalMessage({
        executor,
        channelId: target.channel.id,
        content: unavailableAttachment
          ? appendAttachmentUnavailableMarker(providerRenderedContent)
          : providerRenderedContent,
        createdAt: new Date(payload.createdAt),
        projectionId: payload.projectionId,
        provider: event.provider,
        appRegistrationId: event.appRegistrationId,
        installId: event.installId,
        workspaceId: event.workspaceId,
        workspaceName: sourceInstall?.workspaceName ?? null,
        externalActorId: payload.externalActorId,
        externalConversationId: event.providerConversationId,
        externalMessageId: payload.providerMessageId,
        actorProjectionRevision: payload.actorProjectionRevision,
      });

      // Mint real Raft mention rows for provider-side mention tokens that
      // resolve to a Raft principal. Before this, external_projection messages
      // carried zero message_mentions rows, so Slack-side @-mentions could
      // never notify a linked human or wake an agent — fail-closed by
      // omission (task #221, yezizp directive: match normal Raft mention
      // semantics, no fail-closed).
      const mentionedProviderUserIds = [...new Set(
        [...payload.content.matchAll(SLACK_NATIVE_USER_MENTION)].map((match) => match[1]!),
      )].slice(0, 50);

      // Mention scope mirrors resolveMentionScopeForChannel: for a thread it
      // is the parent channel — every active face for a Joint thread — and
      // for a channel it is every active local projection (or the channel
      // itself when ordinary). Members of a scope channel are notifiable;
      // linked users outside scope still mint an inert row (notifiable=false)
      // so the fact is recorded without notification authority.
      const mentionScopeChannelIds = target.channel.type === "thread"
        ? target.jointThreadProjection
          ? jointThreadFaces.map((face) => face.localParentChannelId)
          : [((await executor.select({ channelId: messages.channelId })
              .from(messages)
              .where(eq(messages.id, target.channel.parentMessageId!))
              .limit(1))[0]?.channelId ?? target.channel.id)]
        : jointChannelProjections.length > 0
          ? jointChannelProjections.map((projection) => projection.localChannelId)
          : [target.channel.id];

      // Mention rows carry the sender's local-face coordinates, not the
      // canonical storage channel (mention-v6 contract): the inbound event
      // commits on the host side, so the origin face is the joint host
      // projection — host local thread for Joint threads, host local channel
      // for Joint channels, the bound channel itself for ordinary targets.
      const hostJointProjection = jointChannelProjections.find(
        (projection) => projection.role === "host",
      );
      const mentionOriginChannelId = target.jointThreadProjection
        ? target.jointThreadProjection.localThreadChannelId
        : hostJointProjection?.localChannelId ?? target.channel.id;
      const mentionOriginServerId = target.jointThreadProjection
        ? target.jointThreadProjection.localServerId
        : hostJointProjection?.serverId ?? target.channel.serverId;

      // Scope-membership gate: public channel/DM scope keeps an inert row
      // for linked outsiders (the fact is recorded without notification
      // authority); private-like scope (private channels, every Joint face)
      // does not mint outsider rows at all so an out-of-scope identity is
      // never recorded on the commit.
      const scopeChannelRows = mentionScopeChannelIds.length > 0
        ? await executor.select({ type: channels.type })
            .from(channels)
            .where(inArray(channels.id, mentionScopeChannelIds))
        : [];
      const privateLikeScope = scopeChannelRows.some(
        (row) => row.type === "private" || row.type === "joint",
      );

      const mentionTargetRows: {
        targetType: "user" | "agent";
        targetId: string;
        handle: string;
        notifiableAtSend: boolean;
      }[] = [];
      if (event.provider === "slack" && mentionedProviderUserIds.length > 0) {
        const humanCandidateIds = mentionedProviderUserIds.filter(
          (id) => id !== sourceInstall?.botUserId,
        );
        if (humanCandidateIds.length > 0) {
          const identityLinks = await executor.select({
            userId: externalHumanIdentityLinks.userId,
            providerUserId: externalHumanIdentityLinks.providerUserId,
          }).from(externalHumanIdentityLinks).where(and(
            eq(externalHumanIdentityLinks.installId, event.installId),
            inArray(externalHumanIdentityLinks.providerUserId, humanCandidateIds),
            eq(externalHumanIdentityLinks.state, "active"),
          ));
          for (const link of identityLinks) {
            // Scope membership decides notifiable_at_send — the same rule the
            // Raft send path applies. An in-scope member on ANY face counts
            // (a Joint inbound message is visible to every face's members).
            let notifiable = false;
            for (const scopeChannelId of mentionScopeChannelIds) {
              if (await isChannelHuman(scopeChannelId, link.userId, executor)) {
                notifiable = true;
                break;
              }
            }
            // Private-like scope (private channel, any Joint face) mints only
            // in-scope members — an outsider identity must not be recorded on
            // this commit at all, matching native private/joint parsing.
            if (!notifiable && privateLikeScope) continue;
            mentionTargetRows.push({
              targetType: "user",
              targetId: link.userId,
              handle: link.providerUserId,
              notifiableAtSend: notifiable,
            });
          }
        }
        // A mention of the bridge bot itself addresses the bound channel's
        // agents — that is the only addressable Raft agent set a Slack user
        // can mean. Agents are minted from the same scope set as humans, so
        // every Joint face's agents get the mention on their own face.
        if (sourceInstall?.botUserId && mentionedProviderUserIds.includes(sourceInstall.botUserId)) {
          const mintedAgentIds = new Set<string>();
          for (const scopeChannelId of mentionScopeChannelIds) {
            const scopedAgents = await executor.select({ id: agents.id })
              .from(channelAgents)
              .innerJoin(agents, eq(agents.id, channelAgents.agentId))
              .where(eq(channelAgents.channelId, scopeChannelId));
            for (const agent of scopedAgents) {
              if (mintedAgentIds.has(agent.id)) continue;
              mintedAgentIds.add(agent.id);
              mentionTargetRows.push({
                targetType: "agent",
                targetId: agent.id,
                handle: sourceInstall.botUserId,
                notifiableAtSend: true,
              });
            }
          }
        }
      }

      // A reply into a thread authored by a Raft user/agent must make the
      // parent author a durable thread follower — the same "authored" follow
      // the Raft send path records for internal replies. For a Joint thread
      // the follow lands on each local face where the author is a member of
      // that face's parent channel; ordinary threads have a single face.
      const authorFollowFaces: { threadChannelId: string; scopeParentChannelId: string }[] =
        target.channel.type === "thread"
          ? target.jointThreadProjection
            ? jointThreadFaces.map((face) => ({
                threadChannelId: face.localThreadChannelId,
                scopeParentChannelId: face.localParentChannelId,
              }))
            : target.channel.parentMessageId
              ? [{
                  threadChannelId: target.channel.id,
                  scopeParentChannelId: (
                    await executor.select({ channelId: messages.channelId })
                      .from(messages)
                      .where(eq(messages.id, target.channel.parentMessageId))
                      .limit(1)
                  )[0]?.channelId,
                }].filter((face): face is typeof face & { scopeParentChannelId: string } =>
                  Boolean(face.scopeParentChannelId))
              : []
          : [];
      if (authorFollowFaces.length > 0) {
        const [parentAuthor] = await executor.select({
          senderType: messages.senderType,
          senderId: messages.senderId,
        }).from(messages).where(eq(messages.id, target.channel.parentMessageId!)).limit(1);
        if (parentAuthor && (parentAuthor.senderType === "agent" || parentAuthor.senderType === "user")) {
          for (const face of authorFollowFaces) {
            const faceMember = parentAuthor.senderType === "agent"
              ? await isChannelAgent(face.scopeParentChannelId, parentAuthor.senderId, executor)
              : await isChannelHuman(face.scopeParentChannelId, parentAuthor.senderId, executor);
            if (!faceMember) continue;
            const followResult = await executor.execute(sql`
              INSERT INTO thread_follows (
                thread_channel_id,
                follower_type,
                follower_id,
                parent_message_id,
                reason,
                done_at,
                unfollowed_at
              )
              VALUES (
                ${face.threadChannelId}::uuid,
                ${parentAuthor.senderType},
                ${parentAuthor.senderId}::uuid,
                ${target.channel.parentMessageId}::uuid,
                'authored',
                NULL,
                NULL
              )
              ON CONFLICT (thread_channel_id, follower_type, follower_id) DO UPDATE
              SET
                parent_message_id = EXCLUDED.parent_message_id,
                reason = EXCLUDED.reason,
                created_at = now(),
                done_at = NULL
              WHERE thread_follows.unfollowed_at IS NULL
              RETURNING xmax = 0 AS inserted
            `);
            // Mirror the send path's joinedThroughSeq=reply.seq-1: a fresh
            // follow must not swallow this reply into born-read.
            if ((followResult.rows[0] as { inserted?: boolean } | undefined)?.inserted) {
              await startReadPositionAtJoin(
                executor,
                parentAuthor.senderType === "agent" ? "agent" : "human",
                parentAuthor.senderId,
                face.threadChannelId,
                result.message.seq - 1,
              );
            }
          }
        }
      }

      if (mentionTargetRows.length > 0) {
        await executor.insert(messageMentions).values(
          mentionTargetRows.map((mentionTarget) => ({
            messageId: result.message.id,
            messageSeq: result.message.seq,
            serverId: mentionOriginServerId,
            channelId: mentionOriginChannelId,
            targetType: mentionTarget.targetType,
            targetId: mentionTarget.targetId,
            handleAtSendTime: mentionTarget.handle,
            source: "send_path" as const,
            confidence: "exact" as const,
            notifiableAtSend: mentionTarget.notifiableAtSend,
          })),
        ).onConflictDoNothing();
      }

      const [messageLink] = await executor.insert(externalMessageLinks).values({
        provider: event.provider,
        installId: event.installId,
        providerAuthorityId: event.providerAuthorityId,
        providerConversationId: event.providerConversationId,
        providerMessageId: payload.providerMessageId,
        providerThreadId: payload.providerThreadId,
        bindingId: event.bindingId,
        bindingEpoch: event.bindingEpoch,
        connectionEpoch: event.connectionEpoch,
        raftMessageId: result.message.id,
        raftCanonicalRootMessageId: target.canonicalRootMessageId,
        firstDirection: "provider_inbound",
        payloadFingerprint: event.normalizedPayloadDigest,
        outcomeState: "accepted",
        authorityState: "active",
        stateReason: "provider_inbound_committed",
        createdAt: commitAt,
        updatedAt: commitAt,
      }).returning();
      if (!messageLink) throw new Error("External attachment message link was not created");
      const storedFacts = attachmentFacts.filter((fact) => fact.state === "stored");
      if (storedFacts.length > 0) {
        const projectionIds = storedFacts.map((fact) => fact.attachmentProjectionId!);
        await linkAttachmentsToMessageWithExecutor(
          executor,
          projectionIds,
          result.message.id,
          payload.projectionId,
          "new",
          commitAt,
        );
        const assetIds = storedFacts.map((fact) => fact.assetId);
        await executor.update(externalAttachmentAssets).set({
          state: "linked",
          updatedAt: commitAt,
        }).where(inArray(externalAttachmentAssets.id, assetIds));
        await executor.update(externalAttachmentMessageFacts).set({
          messageLinkId: messageLink.id,
          state: "linked",
          updatedAt: commitAt,
        }).where(inArray(externalAttachmentMessageFacts.id, storedFacts.map((fact) => fact.id)));
      }
      const unavailableFacts = attachmentFacts.filter(
        (fact) => fact.state === "unavailable" || fact.state === "revoked",
      );
      if (unavailableFacts.length > 0) {
        await executor.update(externalAttachmentMessageFacts).set({
          messageLinkId: messageLink.id,
          updatedAt: commitAt,
        }).where(inArray(externalAttachmentMessageFacts.id, unavailableFacts.map((fact) => fact.id)));
      }
      await recordInboxFactsForPersistedMessages([result.message], {
        executor,
        channel: target.channel,
        // resolveTargetChannel locks the permission-facing binding anchor,
        // canonical storage target, and every active Joint thread projection.
        allowExecutorThread: target.jointThreadProjection === null,
        jointThreadProjection: target.jointThreadProjection,
        // Top-level Joint commits must fan facts out to every active local
        // projection — the canonical storage channel has no members, so
        // without this no face member ever receives a row.
        jointProjections: jointChannelProjections,
        inboxFactPolicy: {
          mode: "record",
          producer: "external_projection.inbound",
          reason: "provider inbound canonical message committed",
        },
      });
      if (inboundCanonicalCommitHookForTests) await inboundCanonicalCommitHookForTests();
      const status = result.kind === "duplicate" ? "duplicate" : "committed";
      await executor.update(externalInboundEvents).set(terminalErase(event, status, result.message.id, commitAt))
        .where(eq(externalInboundEvents.id, event.id));
      return { kind: status, eventId: event.id, messageId: result.message.id };
    });
  } catch (error) {
    if (error instanceof ExternalInboundTargetUnavailableError) {
      await releaseClaim(commitBlockReason);
      return { kind: "blocked", eventId: claim.id, reason: commitBlockReason };
    }
    const actorRevoked = error instanceof Error
      && error.message === "External projection actor authority is not current";
    if (actorRevoked) {
      await terminalizeLeaseWithoutMessage(
        input.db,
        claim,
        input.leaseOwner,
        claim.leaseGeneration,
        "revoked",
        "external_actor_authority_revoked",
        commitAt,
      );
      return { kind: "blocked", eventId: claim.id, reason: "external_actor_authority_revoked" };
    }
    await releaseClaim("canonical_commit_failed");
    return { kind: "blocked", eventId: claim.id, reason: "canonical_commit_failed" };
  }

  if (committed) {
    if (committed.kind === "committed" && input.dependencies.onMessageCommitted) {
      try {
        await input.dependencies.onMessageCommitted({
          eventId: committed.eventId,
          messageId: committed.messageId,
        });
      } catch (error) {
        // Persistence and inbox facts are already committed. Realtime is an
        // acceleration path; a socket/read-model failure must not replay the
        // provider event or duplicate the canonical message.
        try {
          input.dependencies.onMessageCommittedError?.(error);
        } catch {
          // Observability must not turn a durable commit into a retry.
        }
      }
    }
    return committed;
  }
  if (commitBlockReason === "payload_expired_before_canonical_commit") {
    await terminalizeLeaseWithoutMessage(
      input.db,
      claim,
      input.leaseOwner,
      claim.leaseGeneration,
      "dead",
      commitBlockReason,
      commitAt,
    );
  } else {
    await releaseClaim(commitBlockReason);
  }
  return { kind: "blocked", eventId: claim.id, reason: commitBlockReason };
}

export function createExternalInboundWorkerRuntime(input: {
  db: Database;
  leaseOwner: string;
  dependencies?: ExternalInboundWorkerDependencies | null;
  intervalMs?: number;
}) {
  const intervalMs = input.intervalMs ?? 1_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("External inbound worker interval must be positive");
  }
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<unknown> | null = null;
  let controller: AbortController | null = null;
  const tick = () => {
    if (running) return;
    controller = new AbortController();
    running = processExternalInboundEventOnce({
      db: input.db,
      leaseOwner: input.leaseOwner,
      dependencies: input.dependencies,
      signal: controller.signal,
    }).catch(() => undefined).finally(() => {
      running = null;
      controller = null;
    });
  };
  return {
    start() {
      if (timer || !input.dependencies) return;
      tick();
      timer = setClockInterval(tick, intervalMs) as ReturnType<typeof setInterval>;
      timer.unref?.();
    },
    async stop() {
      if (timer) clearClockInterval(timer);
      timer = null;
      controller?.abort();
      await running?.catch(() => undefined);
    },
    tick,
  };
}

/** Exposes target resolution (and its row-lock order) to the real-PostgreSQL lock-order test. */
export const __resolveExternalInboundTargetForTests = resolveTargetChannel;
