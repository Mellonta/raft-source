import { usesPostgresReadBackend } from "../db/readBackend";
import { referenceAgentInboxChain } from "./postgresAgentInbox";
import { revokeSocketAccess } from "../socket/accessRevocation";
import { createHash, randomInt, randomUUID } from "crypto";
import { performance } from "node:perf_hooks";
import type { QueryResultRow } from "pg";
import { eq, and, isNull, isNotNull, sql, inArray, asc, desc, ne, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, getSqlTraceHash, withDbTraceAttributes, type DatabaseExecutor } from "../db/index";
import {
  getRisingWaveConnectionTimeoutMillis,
  getRisingWaveInboxItemsServingVersion,
  getRisingWavePool,
  getRisingWavePoolState,
  RisingWaveNotConfiguredError,
  queryRisingWave,
  RISINGWAVE_UNREAD_INBOX_CONTRACT_VERSION,
  UNIFIED_CHAIN_VIEWS,
  CONVERSATION_UNREAD_VIEW,
  type RisingWavePoolState,
  type RisingWaveInboxItemsServingVersion,
} from "../db/risingwave";
import {
  getConversationUnreadSourceOverride,
  type ConversationUnreadRow,
  type ConversationUnreadSummaryQuery,
  type SidebarUnreadTotalsQuery,
} from "./conversationUnreadSource";
import { getActivityReadSourceOverride } from "./activityReadSource";
import { agentPrivateSurfaces, channels, channelAgents, channelHumans, dmChannelIdentities, agents, users, serverMembers, messages, userChannelReadCursors, userChannelInboxStates, userChannelDisplayPrefs, inboxTargetMuteStates, inboxSuppressionStates, agentChannelReadCursors, servers, threadFollows, agentActivityEvents, tasks, taskEvents, jointChannels, jointChannelServers, jointChannelInvites, readMutationAuthorities, channelMembershipRoleEvents, serverAgentMembers, externalMessageAuthorFacts, externalProjectionAvatarArtifacts, externalActorProjections, externalAddressabilityProjections, externalAppRegistrations, externalChannelBindings } from "../db/schema";
import { gt, gte, lt } from "drizzle-orm";
import { acquireServerLock, assertGuestJoinableChannelCapacityAvailable, GUEST_JOINABLE_CHANNEL_LOCK_NAMESPACE, GuestJoinableChannelLimitError, isChannelReadOnlyByBillingFeature, withServerLock, withServerResourceLock } from "./planService";
import { assertJointAdmission, freeServerIds, reconcileJointOverLimit, reconcileJointOverLimitFor, refreshJointEntitlementsBeforeAdmission } from "./jointChannelLimitService";
import { getJointLimitStatesForJoints, resolveParentJointId } from "./jointChannelLimitState";
export { GuestJoinableChannelLimitError } from "./planService";
import { MAX_JOINT_CHANNEL_SERVERS, PLAN_CONFIG, channelTypeSupportsActivityMute, currentDate, currentTimeMs, formatInboxScopeCorruptionLine, getEffectiveLimits, makeInboxScopeReadFrontier, type AgentActivity, type InboxScopeCursorCorruption, type InboxScopeReadFrontier, type ServerId, type ServerPlan, type TraceAttributes, type TrajectoryEntry, CHANNEL_MANAGEMENT_CAPABILITIES, canAddChannelMembers, canGuestJoinChannel, canGuestPostToChannel, canGuestReadChannel, getChannelAdminBasis, hasEffectiveChannelCapability, type ChannelRole, type ServerRole } from "@botiverse/raft-shared";
import { formatDmPeerRef, parseDmPeerRef, type DmPeerKind } from "@botiverse/raft-shared";
import { DmTargetResolutionError } from "./dmTargetResolutionError";
import { untracedDbQuery, type DbQueryTracer } from "../tracing/dbQueryTrace";
import { MESSAGE_SHORT_ID_RE, uuidShortIdRange } from "../lib/messageId";
import { addTraceEvent, errorClassOf } from "../tracing/semanticTrace";
import { queryFailureReason, queryFailureTraceAttrs } from "../tracing/queryTrace";
import {
  risingWaveInboxFailureAttrs,
  type RisingWaveInboxTraceRoute,
} from "../tracing/risingWaveInboxTrace";
import { sendJointChannelInviteEmail } from "./emailService";
import { normalizeEmail } from "./emailNormalization";
import {
  mapInboxPolicyRowsToItems,
  selectInboxPolicyActiveUnreadCount,
  selectInboxPolicyPageRows,
  type InboxPolicySqlRow,
} from "./inboxPolicyModel";
import { legacyDoneFrontierFallbacksTotal } from "../metrics";
import {
  executeCompatibilityReadMutation,
  isReadMutationFenceRefusal,
  raiseReadPositionForJoin,
  resolveReadMutationUnreadBoundary,
  type ReadMutationAck,
} from "./readMutationSequencer";
import { activityPromotionAllowedByMuteSql, isActivityPromotionSuppressedByMute } from "./inboxMutePolicy";
import { evaluateFeatureFlag, SERVER_GUEST_FEATURE_FLAG_KEY } from "./featureFlagService";
import {
  clearChannelDoneSuppression,
  clearFollowedThreadSuppressionForAll,
  clearFollowedThreadSuppressionForReceiver,
  clearThreadDoneSuppression,
  assertChannelDoneFrontier,
  assertThreadDoneFrontier,
  DoneFrontierBeyondLatestError,
  DoneFrontierRequiredError,
  INBOX_SUPPRESSION_WRITE_SITES,
  parsePositiveCanonicalDecimal,
  resolveChannelSuppressionTarget,
  resolveThreadSuppressionTarget,
  writeThreadDoneSuppression,
} from "./inboxSuppressionWriters";
import { emitAppFacingNotificationEvent } from "./appNotificationDeliveryService";
import { isAppId } from "./rapRegistry";
import {
  AGENT_REMINDERS_DM_PEER,
  getAgentPrivateSurfaceChannelId,
  getAgentPrivateSurfaceKind,
  isAgentPrivateSurfaceChannel,
} from "./agentPrivateSurfaces";
import {
  getBuiltInConversationChannel,
  listInstalledApps as listInstalledRapApps,
} from "./rapRegistryStore";
import { withChannelWriterFence, assertChannelWritableInTransaction } from "./channelConversionFenceService";
import { assertActionCardWritableInTransaction } from "./actionCardConversionService";

interface ChannelServiceOptions {
  executor?: DatabaseExecutor;
  actionCardMessageId?: string;
  actionCardConfirmationVersion?: number;
}

export type JointChannelInviteValidationCode =
  | "joint_target_server_invalid"
  | "joint_invitee_not_found"
  | "joint_invitee_not_admin"
  | "joint_invite_required"
  | "joint_invite_limit_exceeded";

export class JointChannelInviteValidationError extends Error {
  readonly code: JointChannelInviteValidationCode;
  readonly targetServerSlug?: string;
  readonly invitee?: string;
  readonly inviteeIndex?: number;

  constructor(
    message: string,
    code: JointChannelInviteValidationCode,
    details: { targetServerSlug?: string; invitee?: string; inviteeIndex?: number } = {},
  ) {
    super(message);
    this.name = "JointChannelInviteValidationError";
    this.code = code;
    this.targetServerSlug = details.targetServerSlug;
    this.invitee = details.invitee;
    this.inviteeIndex = details.inviteeIndex;
  }
}

export type RegularChannelType = "channel" | "private";
export type ListableChannelType = RegularChannelType | "joint";
export type ChannelRefType = ListableChannelType | "dm" | "thread";

export type JointChannelMetadata = {
  jointChannelId?: string | null;
  jointRole?: "host" | "participant" | null;
  jointPeerServerId?: string | null;
  jointPeerServerName?: string | null;
  jointPeerServerSlug?: string | null;
  jointPeerStatus?: "pending" | "active" | null;
  jointServers?: JointServerMetadata[];
  jointPendingInvites?: JointPendingInviteMetadata[];
  jointBillingLocked?: boolean | null;
  /**
   * Contract v0.3 §18.8: set while the parent joint is over its free-server
   * cap. Before this time the joint is in its grace period; at or after it the
   * joint is read-only (`jointBillingLocked`). Null when within the cap.
   */
  jointOverLimitGraceEndsAt?: string | null;
};

export type ExternalBridgeMetadata = {
  bridge?: {
    provider: "slack";
    providerConversationId: string;
    state: "active" | "paused" | "quarantined";
  };
};

export type ChannelExternalMember = {
  id: string;
  provider: "slack";
  displayName: string;
  handles: string[];
  actorKind: "human" | "guest" | "remote" | "bot" | "unknown";
  avatarUrl: string | null;
};

export type JointServerMetadata = {
  serverId: string;
  serverName: string;
  serverSlug: string;
  role: "host" | "participant" | null;
  status: "active" | "pending";
  isCurrentServer?: boolean;
  /** Whether the joint's free-server cap counts this server as free. */
  plan: "free" | "paid";
};

export type JointPendingInviteMetadata = {
  id: string;
  fromServerId: string;
  toServerId: string;
  serverName: string;
  serverSlug: string;
  invitedUserId: string;
  status: "pending";
};

export type JointChannelProjection = {
  jointChannelId: string;
  localChannelId: string;
  canonicalChannelId: string;
  serverId: string;
  role: "host" | "participant";
  channel: typeof channels.$inferSelect;
};

export type JointThreadProjection = {
  jointThreadId: string;
  localThreadChannelId: string;
  canonicalThreadChannelId: string;
  localServerId: string;
  localParentChannelId: string;
  canonicalParentChannelId: string;
  canonicalParentMessageId: string;
  role: "host" | "participant";
  threadChannel: typeof channels.$inferSelect;
};

const REGULAR_CHANNEL_TYPES: RegularChannelType[] = ["channel", "private"];
const LISTABLE_CHANNEL_TYPES: ListableChannelType[] = ["channel", "private", "joint"];
const DM_LOCK_NAMESPACE = 5;
export const JOINT_STORAGE_SERVER_SLUG = "__joint_storage__";
const SYSTEM_ALL_CHANNEL_KEY = "all";

type ChannelSystemFields = Pick<typeof channels.$inferSelect, "name" | "type">;

export function isAllSystemChannel(channel: ChannelSystemFields): boolean {
  return channel.name === SYSTEM_ALL_CHANNEL_KEY
    && (channel.type === "channel" || channel.type === "private");
}

/**
 * One wording for every surface that refuses an #all visibility change.
 *
 * @cindyz asked for AX guidance rather than a bare refusal (2026-09-07,
 * #wg-rbac msg=66de07f5): an agent that is told only "forbidden" will retry,
 * or report the product as broken, which is exactly how the original incident
 * was escalated. So the refusal names who can do it and where, and it says
 * "hide", not "make private" -- the human UI has always called this Hide #all,
 * and "private" is the word that led the reporter to expect ordinary
 * private-channel semantics.
 */
export const ALL_CHANNEL_VISIBILITY_REFUSAL =
  "The #all channel cannot be hidden or restored by changing channel visibility. "
  + "Only a human can do it, from channel settings or server settings.";

export function isEnabledAllChannel(channel: ChannelSystemFields): boolean {
  return isAllSystemChannel(channel) && channel.type === "channel";
}

function requiresExplicitMembership(type: string): boolean {
  return type === "private" || type === "joint";
}

async function resolveHumanServerRole(
  serverId: string,
  userId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<ServerRole | null> {
  const [membership] = await executor
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .limit(1);
  return membership?.role ?? null;
}

async function isGuestFeatureEnabled(
  serverId: string,
  userId: string,
  executor?: DatabaseExecutor,
): Promise<boolean> {
  return (await evaluateFeatureFlag({
    key: SERVER_GUEST_FEATURE_FLAG_KEY,
    serverId,
    userId,
  }, executor)).enabled;
}

export async function createChannel(
  serverId: string,
  name: string,
  description?: string,
  type: ListableChannelType = "channel",
  options: ChannelServiceOptions & { type?: "user" | "agent"; id?: string; initialUserIds?: readonly string[]; initialAgentIds?: readonly string[] } = {},
) {
  const creator = options.type && options.id ? { ...options, type: options.type, id: options.id } : undefined;
  const apply = async (tx: DatabaseExecutor) => {
    if (options.actionCardMessageId) {
      await assertActionCardWritableInTransaction(tx, options.actionCardMessageId, options.actionCardConfirmationVersion);
    }
    const channel = await createChannelWithExecutor(tx, serverId, name, description, type);
    if (creator && type !== "joint") {
      if (creator.type === "user") {
        // read-position: new conversation, no history before this join (no row = position 0)
        await tx.insert(channelHumans).values({
          channelId: channel.id,
          userId: creator.id,
          role: "admin",
        });
      } else {
        // read-position: new conversation, no history before this join (no row = position 0)
        await tx.insert(channelAgents).values({
          channelId: channel.id,
          agentId: creator.id,
          role: "admin",
        });
      }
      const initialUserIds = [...new Set(creator.initialUserIds ?? [])]
        .filter((userId) => creator.type !== "user" || userId !== creator.id);
      const initialAgentIds = [...new Set(creator.initialAgentIds ?? [])]
        .filter((agentId) => creator.type !== "agent" || agentId !== creator.id);
      if (initialUserIds.length > 0) {
        const validUsers = await tx.select({ id: serverMembers.userId })
          .from(serverMembers)
          .where(and(
            eq(serverMembers.serverId, serverId),
            inArray(serverMembers.userId, initialUserIds),
          ))
          .for("update");
        if (validUsers.length !== initialUserIds.length) {
          throw new Error("One or more initial users are not members of this server");
        }
        // read-position: new conversation, no history before this join (no row = position 0)
        await tx.insert(channelHumans).values(initialUserIds.map((userId) => ({
          channelId: channel.id,
          userId,
          role: "member" as const,
        })));
      }
      if (initialAgentIds.length > 0) {
        const validAgents = await tx.select({ id: agents.id })
          .from(agents)
          .where(and(
            eq(agents.serverId, serverId),
            isNull(agents.deletedAt),
            inArray(agents.id, initialAgentIds),
          ))
          .for("update");
        if (validAgents.length !== initialAgentIds.length) {
          throw new Error("One or more initial agents are not active in this server");
        }
        // read-position: new conversation, no history before this join (no row = position 0)
        await tx.insert(channelAgents).values(initialAgentIds.map((agentId) => ({
          channelId: channel.id,
          agentId,
          role: "member" as const,
        })));
      }
    }
    return channel;
  };
  if (options.executor) return apply(options.executor);
  return withServerLock(serverId, 3, apply);
}

async function createChannelWithExecutor(
  executor: DatabaseExecutor,
  serverId: string,
  name: string,
  description: string | undefined,
  type: ListableChannelType,
) {
  if (name === SYSTEM_ALL_CHANNEL_KEY) {
    throw new Error('Channel name "all" is reserved');
  }

  // Check plan quota. Joint projections are intentionally not counted against
  // ordinary public/private channel quota; they are invite-mediated shared
  // surfaces, not local channels a workspace can freely create.
  const [serverRow] = await executor.select({ plan: servers.plan }).from(servers).where(eq(servers.id, serverId));
  const plan = (serverRow?.plan as ServerPlan) || "free";
  const limits = getEffectiveLimits(plan);
  if (type !== "joint" && limits.maxChannels !== -1) {
    const [countRow] = await executor
      .select({ count: sql<number>`count(*)::int` })
      .from(channels)
      .where(and(eq(channels.serverId, serverId), inArray(channels.type, REGULAR_CHANNEL_TYPES), isNull(channels.deletedAt)));
    const count = countRow?.count ?? 0;
    if (count >= limits.maxChannels) {
      throw new Error(`Channel limit reached (${count}/${limits.maxChannels} on ${PLAN_CONFIG[plan].displayName} plan). Upgrade for more.`);
    }
  }

  const [existing] = await executor
    .select({ id: channels.id, archivedAt: channels.archivedAt, type: channels.type })
    .from(channels)
    .where(and(
      eq(channels.serverId, serverId),
      inArray(channels.type, LISTABLE_CHANNEL_TYPES),
      eq(channels.name, name),
      isNull(channels.deletedAt)
    ));
  if (existing) {
    if (existing.archivedAt) {
      throw new ArchivedNameCollisionError(name, existing.id, existing.type);
    }
    throw new Error(`Channel name "${name}" is already taken`);
  }

  const [channel] = await executor.insert(channels).values({
    serverId,
    name,
    description,
    type,
  }).returning();
  if (channel.type === "channel") {
    await emitAppFacingNotificationEvent({
      id: channel.id,
      serverId,
      eventType: "server.public_channel_created",
      subjectType: "channel",
      subjectId: channel.id,
      provenance: { source: "channel_service", changed_fields: ["public_channels"] },
    }, executor);
  }
  return channel;
}

async function ensureJointStorageNamespace(executor: DatabaseExecutor, ownerId: string): Promise<string> {
  const [existing] = await executor
    .select({ id: servers.id, kind: servers.kind })
    .from(servers)
    .where(and(eq(servers.slug, JOINT_STORAGE_SERVER_SLUG), isNull(servers.deletedAt)));
  if (existing) {
    if (existing.kind !== "joint_storage") {
      throw new Error("Reserved joint storage namespace slug is already used");
    }
    return existing.id;
  }

  const [inserted] = await executor
    .insert(servers)
    .values({
      name: "Joint Storage Namespace",
      slug: JOINT_STORAGE_SERVER_SLUG,
      kind: "joint_storage",
      ownerId,
      plan: "founder",
      agentAllChannelGreetingEnabled: false,
    })
    .onConflictDoNothing({ target: servers.slug })
    .returning({ id: servers.id });
  if (inserted) return inserted.id;

  const [createdByPeer] = await executor
    .select({ id: servers.id, kind: servers.kind })
    .from(servers)
    .where(and(eq(servers.slug, JOINT_STORAGE_SERVER_SLUG), isNull(servers.deletedAt)));
  if (!createdByPeer || createdByPeer.kind !== "joint_storage") {
    throw new Error("Failed to initialize joint storage namespace");
  }
  return createdByPeer.id;
}

async function createJointStorageChannelWithExecutor(
  executor: DatabaseExecutor,
  storageNamespaceId: string,
): Promise<typeof channels.$inferSelect> {
  const [channel] = await executor.insert(channels).values({
    serverId: storageNamespaceId,
    name: `joint-storage-${randomUUID()}`,
    type: "channel",
  }).returning();
  return channel;
}

const JOINT_CHANNEL_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_JOINT_CHANNEL_INVITE_TARGETS = MAX_JOINT_CHANNEL_SERVERS - 1;
export const MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET = 20;

export function isJointChannelInviteId(value: string): boolean {
  return UUID_RE.test(value);
}

function assertJointChannelInviteId(value: string): void {
  if (!isJointChannelInviteId(value)) {
    throw new Error("Joint channel invite not found");
  }
}

export interface CreateJointChannelInput {
  hostServerId: string;
  createdByUserId: string;
  name: string;
  description?: string;
  userIds?: string[];
  agentIds?: string[];
  targetServerSlug?: string;
  invitedPeople?: string[];
  jointInvites?: JointInviteRequest[];
  /**
   * Clock used for billing entitlements. Defaults to the real clock; routes
   * inject the app clock so subscription and trial boundaries stay deterministic.
   */
  now?: Date;
}

export interface JointInviteRequest {
  targetServerSlug: string;
  invitedPeople: string[];
}

type JointInvitee = {
  userId: string;
  email: string;
  name: string;
  displayName: string | null;
  role: "owner" | "admin";
};

export async function createJointChannel(input: CreateJointChannelInput) {
  const inviteRequests = normalizeJointInviteRequests(input);
  const db = getDb();
  const now = input.now ?? currentDate();
  // §18.11 item 5: refresh entitlements before taking any lock.
  const preResolvedTargets = [];
  for (const inviteRequest of inviteRequests) {
    preResolvedTargets.push((await getJointInviteTargetServer(db, inviteRequest.targetServerSlug, input.hostServerId)).id);
  }
  await refreshJointEntitlementsBeforeAdmission(null, [input.hostServerId, ...preResolvedTargets], now);

  const result = await withServerLock(input.hostServerId, 3, async (tx) => {
    const resolvedInviteRequests = [];
    for (const inviteRequest of inviteRequests) {
      const targetServer = await getJointInviteTargetServer(tx, inviteRequest.targetServerSlug, input.hostServerId);
      const invitees = await resolveJointInvitees(tx, targetServer.id, inviteRequest.invitedPeople, inviteRequest.targetServerSlug);
      resolvedInviteRequests.push({ targetServer, invitees });
    }
    // Contract v0.3 §18.6/§18.7: no per-host joint count; the new joint must
    // fit the server and free-server caps with every invited target counted.
    await assertJointAdmission(tx, null, {
      kind: "invite",
      targetServerIds: [input.hostServerId, ...resolvedInviteRequests.map((request) => request.targetServer.id)],
    }, now);

    const storageNamespaceId = await ensureJointStorageNamespace(tx, input.createdByUserId);
    const storageChannel = await createJointStorageChannelWithExecutor(tx, storageNamespaceId);
    const channel = await createChannelWithExecutor(tx, input.hostServerId, input.name, input.description, "joint");
    // read-position: new conversation, no history before this join (no row = position 0)
    await tx.insert(channelHumans)
      .values([
        { channelId: channel.id, userId: input.createdByUserId },
        ...(input.userIds ?? []).map((userId) => ({ channelId: channel.id, userId })),
      ])
      .onConflictDoNothing();
    if (input.agentIds?.length) {
      // read-position: new conversation, no history before this join (no row = position 0)
      await tx.insert(channelAgents)
        .values(input.agentIds.map((agentId) => ({ channelId: channel.id, agentId })))
        .onConflictDoNothing();
    }

    const [joint] = await tx.insert(jointChannels).values({
      canonicalChannelId: storageChannel.id,
      createdByServerId: input.hostServerId,
      createdByUserId: input.createdByUserId,
    }).returning();
    await tx.insert(jointChannelServers).values({
      jointChannelId: joint.id,
      serverId: input.hostServerId,
      localChannelId: channel.id,
      role: "host",
      joinedByUserId: input.createdByUserId,
    });

    const invites = [];
    for (const inviteRequest of resolvedInviteRequests) {
      for (const invitee of inviteRequest.invitees) {
        const invite = await createJointChannelInvite({
          jointChannelId: joint.id,
          fromServerId: input.hostServerId,
          targetServerId: inviteRequest.targetServer.id,
          invitedUserId: invitee.userId,
          invitedByUserId: input.createdByUserId,
          executor: tx,
        });
        invites.push(invite);
      }
    }

    return { channel, jointChannel: joint, invites };
  });

  await sendJointChannelInviteEmails(result.invites.map((invite) => invite.id));
  return result;
}

function normalizeJointInviteRequests(input: Pick<CreateJointChannelInput, "targetServerSlug" | "invitedPeople" | "jointInvites">): JointInviteRequest[] {
  const rawRequests = Array.isArray(input.jointInvites) && input.jointInvites.length > 0
    ? input.jointInvites
    : [{
        targetServerSlug: input.targetServerSlug ?? "",
        invitedPeople: input.invitedPeople ?? [],
      }];
  if (rawRequests.length > MAX_JOINT_CHANNEL_INVITE_TARGETS) {
    throw new JointChannelInviteValidationError(
      `Joint channels support a maximum of ${MAX_JOINT_CHANNEL_SERVERS} servers`,
      "joint_invite_limit_exceeded",
    );
  }
  const byTargetSlug = new Map<string, JointInviteRequest>();

  for (const rawRequest of rawRequests) {
    const targetServerSlug = rawRequest.targetServerSlug.trim();
    if (!targetServerSlug) {
      throw new JointChannelInviteValidationError("Invite server slug is required", "joint_invite_required");
    }
    const invitedPeople = normalizeJointInvitePeople(rawRequest.invitedPeople);
    if (invitedPeople.length === 0) {
      throw new JointChannelInviteValidationError("At least one invited person is required", "joint_invite_required", { targetServerSlug });
    }
    const key = targetServerSlug.toLowerCase();
    const existing = byTargetSlug.get(key);
    if (existing) {
      existing.invitedPeople = normalizeJointInvitePeople([...existing.invitedPeople, ...invitedPeople]);
    } else {
      byTargetSlug.set(key, { targetServerSlug, invitedPeople });
    }
  }

  if (byTargetSlug.size === 0) {
    throw new JointChannelInviteValidationError("Invite server slug is required", "joint_invite_required");
  }
  return [...byTargetSlug.values()];
}

export async function inviteServerToJointChannel(input: {
  localChannelId: string;
  fromServerId: string;
  invitedByUserId: string;
  targetServerSlug: string;
  invitedPeople: string[];
}) {
  const targetSlug = input.targetServerSlug.trim();
  if (!targetSlug) {
    throw new JointChannelInviteValidationError("Invite server slug is required", "joint_invite_required");
  }
  const invitedPeople = normalizeJointInvitePeople(input.invitedPeople);
  if (invitedPeople.length === 0) {
    throw new JointChannelInviteValidationError("At least one invited person is required", "joint_invite_required", { targetServerSlug: targetSlug });
  }

  const now = currentDate();
  const db = getDb();
  const [preProjection] = await db
    .select({ jointChannelId: jointChannelServers.jointChannelId })
    .from(jointChannelServers)
    .where(and(
      eq(jointChannelServers.localChannelId, input.localChannelId),
      eq(jointChannelServers.serverId, input.fromServerId),
      eq(jointChannelServers.status, "active"),
    ));
  if (preProjection) {
    const preTarget = await getJointInviteTargetServer(db, targetSlug, input.fromServerId);
    await refreshJointEntitlementsBeforeAdmission(
      await resolveParentJointId(db, preProjection.jointChannelId),
      [preTarget.id],
      now,
    );
  }

  const result = await withServerResourceLock(input.fromServerId, 3, input.localChannelId, async (tx) => {
    const [projection] = await tx
      .select({ jointChannelId: jointChannelServers.jointChannelId })
      .from(jointChannelServers)
      .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
      .where(and(
        eq(jointChannelServers.localChannelId, input.localChannelId),
        eq(jointChannelServers.serverId, input.fromServerId),
        eq(jointChannelServers.status, "active"),
        eq(jointChannels.status, "active"),
      ));
    if (!projection) {
      throw new Error("Joint channel not found");
    }

    const targetServer = await getJointInviteTargetServer(tx, targetSlug, input.fromServerId);
    // One lock on the parent joint row serializes invites from every
    // participant server, not just this server's projection (§18.7).
    await assertJointAdmission(tx, await resolveParentJointId(tx, projection.jointChannelId), {
      kind: "invite",
      targetServerIds: [targetServer.id],
    }, now);
    const invitees = await resolveJointInvitees(tx, targetServer.id, invitedPeople, targetSlug);
    const invites = [];
    for (const invitee of invitees) {
      const invite = await createJointChannelInvite({
        jointChannelId: projection.jointChannelId,
        fromServerId: input.fromServerId,
        targetServerId: targetServer.id,
        invitedUserId: invitee.userId,
        invitedByUserId: input.invitedByUserId,
        executor: tx,
      });
      invites.push(invite);
    }
    return { invites };
  });

  await sendJointChannelInviteEmails(result.invites.map((invite) => invite.id));
  return result;
}

function normalizeJointInvitePeople(invitedPeople: string[] | undefined): string[] {
  if ((invitedPeople?.length ?? 0) > MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET) {
    throw new JointChannelInviteValidationError(
      `A joint channel invite can include a maximum of ${MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET} invited people per target server`,
      "joint_invite_limit_exceeded",
    );
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of invitedPeople ?? []) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.startsWith("@") && !value.includes("@", 1)
      ? value.slice(1).toLowerCase()
      : value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }
  return normalized;
}

async function getJointInviteTargetServer(executor: DatabaseExecutor, targetServerSlug: string, fromServerId: string) {
  const [targetServer] = await executor
    .select({ id: servers.id, slug: servers.slug, kind: servers.kind, deletedAt: servers.deletedAt })
    .from(servers)
    .where(eq(servers.slug, targetServerSlug));
  if (!targetServer || targetServer.deletedAt || targetServer.kind === "joint_storage") {
    throw new JointChannelInviteValidationError(
      "Target server not found",
      "joint_target_server_invalid",
      { targetServerSlug },
    );
  }
  if (targetServer.id === fromServerId) {
    throw new JointChannelInviteValidationError(
      "Cannot invite the current server",
      "joint_target_server_invalid",
      { targetServerSlug },
    );
  }
  return targetServer;
}

async function resolveJointInvitees(
  executor: DatabaseExecutor,
  targetServerId: string,
  invitedPeople: string[],
  targetServerSlug: string,
): Promise<JointInvitee[]> {
  const invitees: JointInvitee[] = [];
  const seenUserIds = new Set<string>();
  for (const [inviteeIndex, invitedPerson] of invitedPeople.entries()) {
    const token = invitedPerson.trim();
    const isEmail = token.includes("@") && !token.startsWith("@");
    const lookup = isEmail ? normalizeEmail(token) : token.replace(/^@/, "");
    if (!lookup) continue;
    const [invitee] = await executor
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        displayName: users.displayName,
        role: serverMembers.role,
      })
      .from(serverMembers)
      .innerJoin(users, eq(users.id, serverMembers.userId))
      .where(and(
        eq(serverMembers.serverId, targetServerId),
        isEmail ? eq(users.email, lookup) : eq(users.name, lookup),
      ));
    if (!invitee) {
      throw new JointChannelInviteValidationError(
        `Invited person not found in target server: ${invitedPerson}`,
        "joint_invitee_not_found",
        { targetServerSlug, invitee: invitedPerson, inviteeIndex },
      );
    }
    if (invitee.role !== "owner" && invitee.role !== "admin") {
      throw new JointChannelInviteValidationError(
        `Invited person must be a target server admin: ${invitedPerson}`,
        "joint_invitee_not_admin",
        { targetServerSlug, invitee: invitedPerson, inviteeIndex },
      );
    }
    if (seenUserIds.has(invitee.userId)) continue;
    seenUserIds.add(invitee.userId);
    invitees.push({ ...invitee, role: invitee.role });
  }
  if (invitees.length === 0) {
    throw new JointChannelInviteValidationError(
      "At least one invited person is required",
      "joint_invite_required",
      { targetServerSlug },
    );
  }
  return invitees;
}

export async function sendJointChannelInviteEmails(inviteIds: string[]) {
  if (inviteIds.length === 0) return;
  const db = getDb();
  const fromServer = alias(servers, "joint_email_from_server");
  const toServer = alias(servers, "joint_email_to_server");
  const fromProjection = alias(jointChannelServers, "joint_email_from_projection");
  const displayChannel = alias(channels, "joint_email_display_channel");
  const inviter = alias(users, "joint_email_inviter");
  const invitees = await db
    .select({
      inviteId: jointChannelInvites.id,
      fromServerName: fromServer.name,
      toServerName: toServer.name,
      toServerSlug: toServer.slug,
      channelName: displayChannel.name,
      inviterName: inviter.displayName,
      inviterHandle: inviter.name,
      recipientEmail: users.email,
      recipientName: users.displayName,
      recipientHandle: users.name,
    })
    .from(jointChannelInvites)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelInvites.jointChannelId))
    .innerJoin(fromServer, eq(fromServer.id, jointChannelInvites.fromServerId))
    .innerJoin(toServer, eq(toServer.id, jointChannelInvites.toServerId))
    .innerJoin(fromProjection, and(
      eq(fromProjection.jointChannelId, jointChannelInvites.jointChannelId),
      eq(fromProjection.serverId, jointChannelInvites.fromServerId),
      eq(fromProjection.status, "active"),
    ))
    .innerJoin(displayChannel, eq(displayChannel.id, fromProjection.localChannelId))
    .innerJoin(inviter, eq(inviter.id, jointChannelInvites.invitedByUserId))
    .innerJoin(users, eq(users.id, jointChannelInvites.invitedUserId))
    .where(inArray(jointChannelInvites.id, inviteIds));

  await Promise.all(invitees.map((invitee) => sendJointChannelInviteEmail(invitee.recipientEmail, {
    recipientName: invitee.recipientName || invitee.recipientHandle,
    inviterName: invitee.inviterName || invitee.inviterHandle,
    fromServerName: invitee.fromServerName,
    toServerName: invitee.toServerName,
    toServerSlug: invitee.toServerSlug,
    channelName: invitee.channelName,
    inviteId: invitee.inviteId,
  })));
}

export async function createJointChannelInvite(input: {
  jointChannelId: string;
  fromServerId: string;
  targetServerId: string;
  invitedUserId: string;
  invitedByUserId: string;
  executor?: DatabaseExecutor;
}) {
  const db = input.executor ?? getDb();
  const [existing] = await db
    .select()
    .from(jointChannelServers)
    .where(and(
      eq(jointChannelServers.jointChannelId, input.jointChannelId),
      eq(jointChannelServers.serverId, input.targetServerId),
      eq(jointChannelServers.status, "active"),
    ));
  if (existing) {
    throw new JointChannelInviteValidationError(
      "Target server is already in this joint channel",
      "joint_target_server_invalid",
    );
  }

  const [invite] = await db.insert(jointChannelInvites).values({
    jointChannelId: input.jointChannelId,
    fromServerId: input.fromServerId,
    toServerId: input.targetServerId,
    invitedUserId: input.invitedUserId,
    invitedByUserId: input.invitedByUserId,
    expiresAt: new Date(currentTimeMs() + JOINT_CHANNEL_INVITE_TTL_MS),
  }).onConflictDoUpdate({
    target: [jointChannelInvites.jointChannelId, jointChannelInvites.toServerId, jointChannelInvites.invitedUserId],
    targetWhere: sql`status = 'pending'`,
    set: {
      invitedByUserId: input.invitedByUserId,
      expiresAt: new Date(currentTimeMs() + JOINT_CHANNEL_INVITE_TTL_MS),
      createdAt: currentDate(),
    },
  }).returning();
  return invite;
}

export async function resendPendingJointChannelInvites(input: {
  localChannelId: string;
  fromServerId: string;
  requestedByUserId: string;
}) {
  const db = getDb();
  const [projection] = await db
    .select({ jointChannelId: jointChannelServers.jointChannelId })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(
      eq(jointChannelServers.localChannelId, input.localChannelId),
      eq(jointChannelServers.serverId, input.fromServerId),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
    ));
  if (!projection) {
    throw new Error("Joint channel not found");
  }

  const pendingRows = await db
    .select({ id: jointChannelInvites.id })
    .from(jointChannelInvites)
    .where(and(
      eq(jointChannelInvites.jointChannelId, projection.jointChannelId),
      eq(jointChannelInvites.fromServerId, input.fromServerId),
      eq(jointChannelInvites.status, "pending"),
    ));
  const inviteIds = pendingRows.map((row) => row.id);
  if (inviteIds.length === 0) {
    throw new Error("No pending joint channel invite found");
  }

  await db.update(jointChannelInvites)
    .set({
      invitedByUserId: input.requestedByUserId,
      expiresAt: new Date(currentTimeMs() + JOINT_CHANNEL_INVITE_TTL_MS),
      createdAt: currentDate(),
    })
    .where(inArray(jointChannelInvites.id, inviteIds));

  await sendJointChannelInviteEmails(inviteIds);
  return { ok: true, resentCount: inviteIds.length };
}

export async function listPendingJointChannelInvites(serverId: string, userId: string) {
  const db = getDb();
  const fromServer = alias(servers, "joint_invite_from_server");
  const fromProjection = alias(jointChannelServers, "joint_invite_from_projection");
  const displayChannel = alias(channels, "joint_invite_display_channel");
  const rows = await db
    .select({
      id: jointChannelInvites.id,
      jointChannelId: jointChannelInvites.jointChannelId,
      fromServerId: jointChannelInvites.fromServerId,
      fromServerName: fromServer.name,
      fromServerSlug: fromServer.slug,
      channelName: displayChannel.name,
      channelDescription: displayChannel.description,
      invitedByUserId: jointChannelInvites.invitedByUserId,
      invitedUserId: jointChannelInvites.invitedUserId,
      expiresAt: jointChannelInvites.expiresAt,
      createdAt: jointChannelInvites.createdAt,
    })
    .from(jointChannelInvites)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelInvites.jointChannelId))
    .innerJoin(fromServer, eq(fromServer.id, jointChannelInvites.fromServerId))
    .innerJoin(fromProjection, and(
      eq(fromProjection.jointChannelId, jointChannelInvites.jointChannelId),
      eq(fromProjection.serverId, jointChannelInvites.fromServerId),
      eq(fromProjection.status, "active"),
    ))
    .innerJoin(displayChannel, eq(displayChannel.id, fromProjection.localChannelId))
    .where(and(
      eq(jointChannelInvites.toServerId, serverId),
      eq(jointChannelInvites.invitedUserId, userId),
      eq(jointChannelInvites.status, "pending"),
      eq(jointChannels.status, "active"),
      isNull(displayChannel.deletedAt),
    ))
    .orderBy(desc(jointChannelInvites.createdAt));
  const now = currentTimeMs();
  return rows.filter((row) => row.expiresAt.getTime() > now);
}

export async function acceptJointChannelInvite(input: {
  inviteId: string;
  targetServerId: string;
  acceptedByUserId: string;
}) {
  assertJointChannelInviteId(input.inviteId);
  const now = currentDate();
  const [preInvite] = await getDb()
    .select({ jointChannelId: jointChannelInvites.jointChannelId })
    .from(jointChannelInvites)
    .where(eq(jointChannelInvites.id, input.inviteId));
  if (preInvite) {
    await refreshJointEntitlementsBeforeAdmission(
      await resolveParentJointId(getDb(), preInvite.jointChannelId),
      [input.targetServerId],
      now,
    );
  }
  return withServerLock(input.targetServerId, 3, async (tx) => {
    const fromProjection = alias(jointChannelServers, "joint_accept_from_projection");
    const displayChannel = alias(channels, "joint_accept_display_channel");
    const [invite] = await tx
      .select({
        id: jointChannelInvites.id,
        jointChannelId: jointChannelInvites.jointChannelId,
        fromServerId: jointChannelInvites.fromServerId,
        toServerId: jointChannelInvites.toServerId,
        invitedUserId: jointChannelInvites.invitedUserId,
        status: jointChannelInvites.status,
        expiresAt: jointChannelInvites.expiresAt,
        canonicalChannelId: jointChannels.canonicalChannelId,
        channelName: displayChannel.name,
        channelDescription: displayChannel.description,
      })
      .from(jointChannelInvites)
      .innerJoin(jointChannels, eq(jointChannels.id, jointChannelInvites.jointChannelId))
      .innerJoin(fromProjection, and(
        eq(fromProjection.jointChannelId, jointChannelInvites.jointChannelId),
        eq(fromProjection.serverId, jointChannelInvites.fromServerId),
        eq(fromProjection.status, "active"),
      ))
      .innerJoin(displayChannel, eq(displayChannel.id, fromProjection.localChannelId))
      .where(and(
        eq(jointChannelInvites.id, input.inviteId),
        eq(jointChannelInvites.toServerId, input.targetServerId),
        eq(jointChannelInvites.invitedUserId, input.acceptedByUserId),
        eq(jointChannelInvites.status, "pending"),
        eq(jointChannels.status, "active"),
        isNull(displayChannel.deletedAt),
      ));
    if (!invite) {
      throw new Error("Joint channel invite not found");
    }
    if (invite.expiresAt.getTime() <= currentTimeMs()) {
      await tx.update(jointChannelInvites)
        .set({ status: "expired" })
        .where(eq(jointChannelInvites.id, input.inviteId));
      throw new Error("Joint channel invite expired");
    }
    const [acceptingMember] = await tx
      .select({ role: serverMembers.role })
      .from(serverMembers)
      .where(and(
        eq(serverMembers.serverId, input.targetServerId),
        eq(serverMembers.userId, input.acceptedByUserId),
      ));
    if (!acceptingMember || (acceptingMember.role !== "owner" && acceptingMember.role !== "admin")) {
      throw new Error("Only target server admins can accept joint channel invites");
    }

    const [existingProjection] = await tx
      .select({ localChannelId: jointChannelServers.localChannelId })
      .from(jointChannelServers)
      .where(and(
        eq(jointChannelServers.jointChannelId, invite.jointChannelId),
        eq(jointChannelServers.serverId, input.targetServerId),
        eq(jointChannelServers.status, "active"),
      ));
    if (existingProjection) {
      const joined = await tx.insert(channelHumans)
        .values({ channelId: existingProjection.localChannelId, userId: input.acceptedByUserId })
        .onConflictDoNothing()
        .returning({ userId: channelHumans.userId });
      if (joined.length > 0) {
        await startReadPositionAtJoin(tx, "human", input.acceptedByUserId, existingProjection.localChannelId);
      }
      await tx.update(jointChannelInvites)
        .set({
          status: "accepted",
          acceptedByUserId: input.acceptedByUserId,
          acceptedAt: currentDate(),
        })
        .where(eq(jointChannelInvites.id, input.inviteId));
      const [existingChannel] = await tx
        .select()
        .from(channels)
        .where(and(
          eq(channels.id, existingProjection.localChannelId),
          isNull(channels.deletedAt),
        ));
      if (!existingChannel) throw new Error("Joint channel projection not found");
      return existingChannel;
    }

    // Accepting counts active participants plus this server, so an old free
    // invite cannot push a joint that is already over past the cap (§18.8).
    const parentJointId = await resolveParentJointId(tx, invite.jointChannelId);
    await assertJointAdmission(tx, parentJointId, { kind: "accept", serverId: input.targetServerId }, now);

    const projection = await createChannelWithExecutor(
      tx,
      input.targetServerId,
      invite.channelName,
      invite.channelDescription ?? undefined,
      "joint",
    );
    await tx.insert(channelHumans)
      .values({ channelId: projection.id, userId: input.acceptedByUserId })
      .onConflictDoNothing();
    await tx.insert(jointChannelServers).values({
      jointChannelId: invite.jointChannelId,
      serverId: input.targetServerId,
      localChannelId: projection.id,
      role: "participant",
      joinedByUserId: input.acceptedByUserId,
    });
    await backfillJointThreadProjectionsForLocalParent(tx, {
      jointChannelId: invite.jointChannelId,
      canonicalParentChannelId: invite.canonicalChannelId,
      localParentProjection: {
        serverId: input.targetServerId,
        localChannelId: projection.id,
        role: "participant",
      },
      joinedByUserId: input.acceptedByUserId,
    });
    // The projection is not committed yet, so name the canonical storage explicitly.
    const [canonicalLatest] = await tx
      .select({ seq: sql<number>`COALESCE(MAX(${messages.seq}), 0)::int` })
      .from(messages)
      .where(eq(messages.channelId, invite.canonicalChannelId));
    await startReadPositionAtJoin(tx, "human", input.acceptedByUserId, projection.id, canonicalLatest?.seq ?? 0);
    await tx.update(jointChannelInvites)
      .set({
        status: "accepted",
        acceptedByUserId: input.acceptedByUserId,
        acceptedAt: currentDate(),
      })
      .where(eq(jointChannelInvites.id, input.inviteId));
    if (parentJointId) await reconcileJointOverLimit(tx, parentJointId, now);
    return projection;
  });
}

export type ArchivedFilter = "exclude" | "include" | "only";

interface ChannelListOptions {
  archived?: ArchivedFilter;
  traceQuery?: DbQueryTracer;
  humanActivityMuteEnabled?: boolean;
}

export type ReadStateSnapshot = {
  maxReadSeq: number;
  readStateVersion: number;
  /** Authoritative per-scope read state (#632 SSOT) — see packages/shared. */
  readState: InboxScopeReadFrontier;
};

export async function getReadStateSnapshot(userId: string, channelId: string): Promise<ReadStateSnapshot> {
  const [row] = await fetchReadStateAuthorityRows(
    [channelId],
    userId,
    untracedDbQuery,
    "channels.read_state_by_channel",
  );
  if (!row) {
    return { maxReadSeq: 0, readStateVersion: 0, readState: makeInboxScopeReadFrontier(null) };
  }
  return {
    maxReadSeq: row.readCursorPresent ? Number(row.maxReadSeq) : 0,
    readStateVersion: row.readCursorPresent ? (row.readStateVersion as number) : 0,
    readState: readFrontierFromAuthorityRow(row),
  };
}

/**
 * The SINGLE authority-table read shared by the list/DM/followed-thread exit
 * (attachReadState) and the unread-summary exit (#632 SSOT): presence is a
 * STRUCTURAL JOIN fact, version/seq stay NULL when the cursor row is absent
 * (never coalesced before the shared constructor decides), and the content
 * frontier is a same-source pair from ONE lateral row over the storage
 * channel (joint channels resolve to canonical storage). The dedicated Done
 * frontier uses that same storage scope, with the parent-message fallback
 * required by zero-reply threads.
 *
 * Executor discipline: pass the CALLER's executor when inside a transaction —
 * the authority read must see the transaction's snapshot, and on
 * single-connection drivers (pglite) a global-getDb() read issued while the
 * caller's transaction holds the connection deadlocks the flow. Today the
 * ONLY transaction-scoped caller is activitySyncService (via getInboxItems);
 * any NEW tx-scoped caller MUST thread its executor — otherwise this
 * silently hangs (no RED).
 */
/**
 * Read-state authority rows for a set of channels.
 *
 * The `deleted_at IS NULL` filter is REDUNDANT for every current caller: all of
 * them already resolve through a query that excludes soft-deleted channels
 * (inbox serving paths, `getChannel` without `includeDeleted`, or a just-created
 * channel). It is kept deliberately.
 *
 * Keeping it turns "no soft-deleted channel reaches this query" from a
 * convention every caller must honour into a property of this function. A fifth
 * caller that forgets to pre-filter is then harmless instead of silently
 * surfacing deleted channels' read state.
 *
 * Because it changes no current behaviour, it is exactly the kind of line that
 * looks safe to delete. It is not: see the boundary test
 * "fetchReadStateAuthorityRows excludes soft-deleted channels regardless of
 * what the caller passes", which goes red if this filter is removed.
 */
async function fetchReadStateAuthorityRows(
  channelIds: string[],
  userId: string,
  traceQuery: DbQueryTracer,
  traceName: string,
  executor: DatabaseExecutor = getDb(),
): Promise<UnreadSummaryReadStateRow[]> {
  if (channelIds.length === 0) return [];
  const result = await traceQuery(
    traceName,
    () => executor.execute(sql`
      SELECT
        c.id::text AS "channelId",
        (rc.user_id IS NOT NULL) AS "readCursorPresent",
        rc.read_state_version::int AS "readStateVersion",
        rc.last_read_seq::text AS "maxReadSeq",
        lm.id::text AS "latestActivityMessageId",
        lm.seq::text AS "latestActivitySeq",
        COALESCE(lm.seq, parent_message.seq)::text AS "doneFrontierSeq"
      FROM channels c
      LEFT JOIN joint_channel_servers joint_projection
        ON joint_projection.local_channel_id = c.id
       AND joint_projection.server_id = c.server_id
       AND joint_projection.status = 'active'
      LEFT JOIN joint_channels joint_storage
        ON joint_storage.id = joint_projection.joint_channel_id
       AND joint_storage.status = 'active'
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = c.id AND rc.user_id = ${userId}
      LEFT JOIN channels storage_scope
        ON storage_scope.id = COALESCE(joint_storage.canonical_channel_id, c.id)
      LEFT JOIN messages parent_message
        ON parent_message.id = storage_scope.parent_message_id
      LEFT JOIN LATERAL (
        SELECT m.id, m.seq
        FROM messages m
        WHERE m.channel_id = COALESCE(joint_storage.canonical_channel_id, c.id)
        ORDER BY m.seq DESC
        LIMIT 1
      ) lm ON TRUE
      WHERE c.id IN (${sql.join(channelIds.map((id) => sql`${id}::uuid`), sql`, `)})
        AND c.deleted_at IS NULL
    `),
    (r) => ({ read_state_authority_rows_count: r.rows.length }),
  );
  return result.rows as unknown as UnreadSummaryReadStateRow[];
}

function readFrontierFromAuthorityRow(row: UnreadSummaryReadStateRow): InboxScopeReadFrontier {
  const cursor = row.readCursorPresent
    ? {
      readStateVersion: row.readStateVersion as number,
      maxReadSeq: row.maxReadSeq as string,
      latestActivityMessageId: row.latestActivityMessageId,
      latestActivitySeq: row.latestActivitySeq,
    }
    : null;
  return makeInboxScopeReadFrontier(cursor, (c) => {
    console.error(formatInboxScopeCorruptionLine(row.channelId, c));
  });
}

/**
 * The list/DM/followed-thread read-state snapshot of one authority row (absent
 * row = no channel row). Shared by attachReadState and the followed-threads
 * RisingWave path, which builds the authority row from the cursor table plus
 * the RW latest message, so both produce the same snapshot for the same facts.
 */
function readStateSnapshotFromAuthorityRow(state: UnreadSummaryReadStateRow | undefined): ReadStateSnapshot {
  return {
    // Legacy fields keep their historical coalesce-to-0 shape for existing
    // consumers; the NEW readState union is the authoritative carrier
    // (#632) — absence/corruption stay visible there.
    maxReadSeq: state?.readCursorPresent ? Number(state.maxReadSeq) : 0,
    readStateVersion: state?.readCursorPresent ? (state.readStateVersion as number) : 0,
    readState: state ? readFrontierFromAuthorityRow(state) : makeInboxScopeReadFrontier(null),
  };
}

async function attachReadState<T extends { id: string }>(
  rows: T[],
  userId: string,
  executor: DatabaseExecutor = getDb(),
  traceQuery: DbQueryTracer = untracedDbQuery,
): Promise<Array<T & ReadStateSnapshot>> {
  if (rows.length === 0) return [];
  const authorityRows = await fetchReadStateAuthorityRows(
    rows.map((row) => row.id),
    userId,
    traceQuery,
    "channels.read_state_by_channels",
    executor,
  );
  const stateByChannel = new Map(authorityRows.map((row) => [row.channelId, row]));
  return rows.map((row) => ({
    ...row,
    ...readStateSnapshotFromAuthorityRow(stateByChannel.get(row.id)),
  }));
}

// `type` is required, not optional: this row set decides whether the API
// announces a mute capability, and an absent type must fail the compile rather
// than silently default to "supported" (that default is what let DMs claim a
// control no surface renders — task #473).
async function attachActivityMuteState<T extends { id: string; type: string }>(
  rows: T[],
  receiverType: "user" | "agent",
  receiverId: string,
  enabled = true,
): Promise<Array<T & { activityMuted?: boolean; muteFromSeq?: number | null; prefsVersion?: number; activityMuteSupported?: boolean }>> {
  if (rows.length === 0) return [];
  if (!enabled) {
    return rows;
  }
  const states = await getDb()
    .select({
      sourceChannelId: inboxTargetMuteStates.sourceChannelId,
      activityMuted: inboxTargetMuteStates.activityMuted,
      muteFromSeq: inboxTargetMuteStates.muteFromSeq,
      prefsVersion: inboxTargetMuteStates.prefsVersion,
    })
    .from(inboxTargetMuteStates)
    .where(and(
      eq(inboxTargetMuteStates.receiverType, receiverType),
      eq(inboxTargetMuteStates.receiverId, receiverId),
      inArray(inboxTargetMuteStates.sourceChannelId, rows.map((row) => row.id)),
    ));
  const stateByChannel = new Map(states.map((state) => [state.sourceChannelId, state]));
  return rows.map((row) => {
    const state = stateByChannel.get(row.id);
    const activityMuted = !!state?.activityMuted && state.muteFromSeq != null;
    const muteFromSeq = activityMuted ? state!.muteFromSeq : null;
    return {
      ...row,
      activityMuted,
      muteFromSeq,
      prefsVersion: state?.prefsVersion ?? 0,
      activityMuteSupported: channelTypeSupportsActivityMute(row.type),
    };
  });
}

// Per-user message display prefs hydration (task #187 collapse-long-messages).
// A missing row means the default: long messages collapse (collapseLongMessages
// = true) at prefsVersion 0.
async function attachUserChannelDisplayPrefs<T extends { id: string }>(
  rows: T[],
  userId: string,
): Promise<Array<T & { collapseLongMessages: boolean; displayPrefsVersion: number }>> {
  if (rows.length === 0) return [];
  const states = await getDb()
    .select({
      channelId: userChannelDisplayPrefs.channelId,
      collapseLongMessages: userChannelDisplayPrefs.collapseLongMessages,
      prefsVersion: userChannelDisplayPrefs.prefsVersion,
    })
    .from(userChannelDisplayPrefs)
    .where(and(
      eq(userChannelDisplayPrefs.userId, userId),
      inArray(userChannelDisplayPrefs.channelId, rows.map((row) => row.id)),
    ));
  const stateByChannel = new Map(states.map((state) => [state.channelId, state]));
  return rows.map((row) => {
    const state = stateByChannel.get(row.id);
    return {
      ...row,
      collapseLongMessages: state?.collapseLongMessages ?? true,
      displayPrefsVersion: state?.prefsVersion ?? 0,
    };
  });
}

type DmIdentityKind = "human_self" | "human_human" | "human_agent" | "agent_agent";

function dmIdentityKey(participantIds: string[]): string {
  return participantIds.slice().sort().join(":");
}

function dmPairKey(kind: "human-agent" | "user-user" | "agent-agent", participantIds: string[]): string {
  return `${kind}:${participantIds.slice().sort().join(":")}`;
}

interface UnreadCountOptions {
  traceQuery?: DbQueryTracer;
}

export type ChannelUnreadSummaryEntry = {
  unreadCount: number;
  hasMention: boolean;
  hasAnyMention: boolean;
  /**
   * Authoritative per-scope read state (#632 SSOT): constructed from the
   * read-cursor table via the single shared constructor. The badge surface
   * derives read/unread from THIS, not from its own arithmetic.
   */
  readState: InboxScopeReadFrontier;
  /**
   * Non-joined public channel only: its latest message is past the user's read
   * cursor. Such a channel has no exact count (unreadCount is 0); the sidebar
   * shows a quiet indicator instead.
   */
  hasNew?: boolean;
};

interface SidebarUnreadSummaryOptions {
  traceQuery?: DbQueryTracer;
}


/** Every unified-chain serving view is receiver-keyed: reads must filter on `receiver_type`. */
const RECEIVER_KEYED_SERVING_VIEWS: ReadonlySet<string> = new Set([UNIFIED_CHAIN_VIEWS.serving]);

async function attachLastMessageAt<T extends { id: string }>(
  rows: T[],
  traceQuery: DbQueryTracer,
  queryName: string,
  countAttrName: string,
): Promise<Array<T & { lastMessageAt?: Date | null }>> {
  if (rows.length === 0) return [];

  const channelIds = rows.map((row) => row.id);
  const lastMessages = await traceQuery(
    queryName,
    () => getDb().execute(sql`
      WITH input_channels(channel_id) AS (
        VALUES ${sql.join(channelIds.map((id) => sql`(${id}::uuid)`), sql`, `)}
      )
      SELECT
        input_channels.channel_id::text AS "channelId",
        latest.created_at AS "lastMessageAt"
      FROM input_channels
      JOIN LATERAL (
        SELECT m.created_at
        FROM messages m
        WHERE m.channel_id = input_channels.channel_id
        ORDER BY m.created_at DESC
        LIMIT 1
      ) latest ON TRUE
    `).then((result) =>
      (result.rows as Array<{ channelId: string; lastMessageAt: Date | string | null }>).map((row) => ({
        channelId: row.channelId,
        lastMessageAt: row.lastMessageAt instanceof Date
          ? row.lastMessageAt
          : row.lastMessageAt
            ? new Date(row.lastMessageAt)
            : null,
      }))
    ),
    (latestRows) => ({
      [countAttrName]: channelIds.length,
      channels_with_messages_count: latestRows.length,
    }),
  );
  const lastMessageMap = new Map(lastMessages.map((row) => [row.channelId, row.lastMessageAt]));
  return rows.map((row) => ({
    ...row,
    lastMessageAt: lastMessageMap.get(row.id) ?? null,
  }));
}

type DMChannelLastMessageSummary = {
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  lastMessageSenderName: string | null;
};

async function attachLastMessageSummary<T extends { id: string }>(
  rows: T[],
  traceQuery: DbQueryTracer,
  queryName: string,
  countAttrName: string,
): Promise<Array<T & DMChannelLastMessageSummary>> {
  if (rows.length === 0) return [];

  const channelIds = rows.map((row) => row.id);
  const lastMessages = await traceQuery(
    queryName,
    () => getDb().execute(sql`
      WITH input_channels(channel_id) AS (
        VALUES ${sql.join(channelIds.map((id) => sql`(${id}::uuid)`), sql`, `)}
      )
      SELECT
        input_channels.channel_id::text AS "channelId",
        latest.created_at AS "lastMessageAt",
        CASE
          WHEN length(latest.normalized_content) = 0 THEN NULL
          WHEN length(latest.normalized_content) > 140 THEN left(latest.normalized_content, 139) || '…'
          ELSE latest.normalized_content
        END AS "lastMessagePreview",
        COALESCE(
          NULLIF(sender_user.display_name, ''),
          sender_user.name,
          NULLIF(sender_agent.display_name, ''),
          sender_agent.name,
          external_author.display_name
        ) AS "lastMessageSenderName"
      FROM input_channels
      JOIN LATERAL (
        SELECT
          m.id,
          m.sender_type,
          m.sender_id,
          m.created_at,
          btrim(regexp_replace(m.content, '\\s+', ' ', 'g')) AS normalized_content
        FROM messages m
        WHERE m.channel_id = input_channels.channel_id
        ORDER BY m.created_at DESC, m.seq DESC
        LIMIT 1
      ) latest ON TRUE
      LEFT JOIN users sender_user
        ON latest.sender_type = 'user'
       AND sender_user.id::text = latest.sender_id
      LEFT JOIN agents sender_agent
        ON latest.sender_type = 'agent'
       AND sender_agent.id::text = latest.sender_id
      LEFT JOIN external_message_author_facts external_author
        ON latest.sender_type = 'external_projection'
       AND external_author.message_id = latest.id
    `).then((result) =>
      (result.rows as Array<{
        channelId: string;
        lastMessageAt: Date | string | null;
        lastMessagePreview: string | null;
        lastMessageSenderName: string | null;
      }>).map((row) => ({
        channelId: row.channelId,
        lastMessageAt: row.lastMessageAt instanceof Date
          ? row.lastMessageAt
          : row.lastMessageAt
            ? new Date(row.lastMessageAt)
            : null,
        lastMessagePreview: row.lastMessagePreview,
        lastMessageSenderName: row.lastMessageSenderName,
      }))
    ),
    (latestRows) => ({
      [countAttrName]: channelIds.length,
      channels_with_messages_count: latestRows.length,
    }),
  );
  const lastMessageMap = new Map(lastMessages.map((row) => [row.channelId, row]));
  return rows.map((row) => ({
    ...row,
    lastMessageAt: lastMessageMap.get(row.id)?.lastMessageAt ?? null,
    lastMessagePreview: lastMessageMap.get(row.id)?.lastMessagePreview ?? null,
    lastMessageSenderName: lastMessageMap.get(row.id)?.lastMessageSenderName ?? null,
  }));
}

export async function attachJointChannelMetadata<T extends { id: string; type: string; serverId: string }>(
  rows: T[],
): Promise<Array<T & JointChannelMetadata>> {
  const jointRows = rows.filter((row) => row.type === "joint");
  if (jointRows.length === 0) {
    return rows.map((row) => ({
      ...row,
      jointChannelId: null,
      jointRole: null,
      jointPeerServerId: null,
      jointPeerServerName: null,
      jointPeerServerSlug: null,
      jointPeerStatus: null,
      jointServers: [],
      jointPendingInvites: [],
      jointBillingLocked: null,
    }));
  }

  const db = getDb();
  const localIds = jointRows.map((row) => row.id);
  const projections = await db
    .select({
      localChannelId: jointChannelServers.localChannelId,
      jointChannelId: jointChannelServers.jointChannelId,
      serverId: jointChannelServers.serverId,
      role: jointChannelServers.role,
    })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(
      inArray(jointChannelServers.localChannelId, localIds),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
    ));
  const projectionByLocalId = new Map(projections.map((projection) => [projection.localChannelId, projection]));
  const jointIds = [...new Set(projections.map((projection) => projection.jointChannelId))];

  if (jointIds.length === 0) {
    return rows.map((row) => ({
      ...row,
      jointChannelId: null,
      jointRole: null,
      jointPeerServerId: null,
      jointPeerServerName: null,
      jointPeerServerSlug: null,
      jointPeerStatus: null,
      jointServers: [],
      jointPendingInvites: [],
      jointBillingLocked: null,
    }));
  }

  const activeServers = await db
    .select({
      jointChannelId: jointChannelServers.jointChannelId,
      serverId: jointChannelServers.serverId,
      serverName: servers.name,
      serverSlug: servers.slug,
      role: jointChannelServers.role,
    })
    .from(jointChannelServers)
    .innerJoin(servers, eq(servers.id, jointChannelServers.serverId))
    .where(and(
      inArray(jointChannelServers.jointChannelId, jointIds),
      eq(jointChannelServers.status, "active"),
    ));

  const pendingInvites = await db
    .select({
      id: jointChannelInvites.id,
      jointChannelId: jointChannelInvites.jointChannelId,
      fromServerId: jointChannelInvites.fromServerId,
      toServerId: jointChannelInvites.toServerId,
      invitedUserId: jointChannelInvites.invitedUserId,
      serverName: servers.name,
      serverSlug: servers.slug,
    })
    .from(jointChannelInvites)
    .innerJoin(servers, eq(servers.id, jointChannelInvites.toServerId))
    .where(and(
      inArray(jointChannelInvites.jointChannelId, jointIds),
      eq(jointChannelInvites.status, "pending"),
    ));

  const billingLockedByLocalId = new Map<string, boolean>();
  const graceEndsAtByLocalId = new Map<string, string | null>();
  const limitNow = currentDate();
  const limitStates = await getJointLimitStatesForJoints(db, jointIds, limitNow);
  for (const projection of projections) {
    const state = limitStates.get(projection.jointChannelId) ?? null;
    billingLockedByLocalId.set(projection.localChannelId, state?.readOnly ?? false);
    graceEndsAtByLocalId.set(projection.localChannelId, state?.graceEndsAt?.toISOString() ?? null);
  }
  const freeServers = await freeServerIds(db, [...new Set([
    ...activeServers.map((server) => server.serverId),
    ...pendingInvites.map((invite) => invite.toServerId),
  ])], limitNow);
  const planOf = (serverId: string) => (freeServers.has(serverId) ? "free" as const : "paid" as const);

  return rows.map((row) => {
    if (row.type !== "joint") {
      return {
        ...row,
        jointChannelId: null,
        jointRole: null,
        jointPeerServerId: null,
        jointPeerServerName: null,
        jointPeerServerSlug: null,
        jointPeerStatus: null,
        jointServers: [],
        jointPendingInvites: [],
        jointBillingLocked: null,
      };
    }

    const projection = projectionByLocalId.get(row.id);
    const activePeer = projection
      ? activeServers.find((server) => server.jointChannelId === projection.jointChannelId && server.serverId !== row.serverId)
      : null;
    const pendingPeer = projection
      ? pendingInvites.find((invite) => invite.jointChannelId === projection.jointChannelId && invite.fromServerId === row.serverId)
      : null;
    const activeRows = projection
      ? activeServers.filter((server) => server.jointChannelId === projection.jointChannelId)
      : [];
    const activeServerIds = new Set(activeRows.map((server) => server.serverId));
    const jointPendingInvites = projection
      ? pendingInvites
        .filter((invite) => invite.jointChannelId === projection.jointChannelId)
        .map((invite) => ({
          id: invite.id,
          fromServerId: invite.fromServerId,
          toServerId: invite.toServerId,
          serverName: invite.serverName,
          serverSlug: invite.serverSlug,
          invitedUserId: invite.invitedUserId,
          status: "pending" as const,
        }))
      : [];
    const pendingServerRows = new Map<string, JointServerMetadata>();
    for (const invite of jointPendingInvites) {
      if (activeServerIds.has(invite.toServerId) || pendingServerRows.has(invite.toServerId)) continue;
      pendingServerRows.set(invite.toServerId, {
        serverId: invite.toServerId,
        serverName: invite.serverName,
        serverSlug: invite.serverSlug,
        role: null,
        status: "pending",
        plan: planOf(invite.toServerId),
      });
    }
    const jointServers: JointServerMetadata[] = [
      ...activeRows.map((server) => ({
        serverId: server.serverId,
        serverName: server.serverName,
        serverSlug: server.serverSlug,
        role: server.role as "host" | "participant",
        status: "active" as const,
        isCurrentServer: server.serverId === row.serverId,
        plan: planOf(server.serverId),
      })),
      ...pendingServerRows.values(),
    ];

    return {
      ...row,
      jointChannelId: projection?.jointChannelId ?? null,
      jointRole: projection?.role ?? null,
      jointPeerServerId: activePeer?.serverId ?? pendingPeer?.toServerId ?? null,
      jointPeerServerName: activePeer?.serverName ?? pendingPeer?.serverName ?? null,
      jointPeerServerSlug: activePeer?.serverSlug ?? pendingPeer?.serverSlug ?? null,
      jointPeerStatus: activePeer ? "active" : pendingPeer ? "pending" : null,
      jointServers,
      jointPendingInvites,
      jointBillingLocked: projection ? billingLockedByLocalId.get(projection.localChannelId) ?? false : null,
      jointOverLimitGraceEndsAt: projection ? graceEndsAtByLocalId.get(projection.localChannelId) ?? null : null,
    };
  });
}

interface FollowedThreadsOptions {
  traceQuery?: DbQueryTracer;
  executor?: DatabaseExecutor;
  state?: "active" | "done" | "unfollowed" | "unfollowed_active";
  maxRows?: number;
  channelId?: string;
  q?: string;
  sort?: "asc" | "desc";
  /**
   * Internal: run the legacy all-Postgres list even when the active-follows
   * RisingWave path (rw_followed_threads_v4) applies. For the path diff script
   * (scripts/followed-threads-path-diff.ts) and tests; no route sets it.
   */
  forceLegacyPath?: boolean;
}

interface ThreadSummaryOptions {
  traceQuery?: DbQueryTracer;
  userId?: string;
  parentMessageIds?: string[];
  parentMessageScopeSource?: "client" | "compat_recent" | "messages_page" | "messages_context";
}

/**
 * Attach secret-free current bridge identity to ordinary channel DTOs. This is
 * presentation metadata only: it does not grant provider or Raft authority.
 */
export async function attachExternalBridgeMetadata<T extends { id: string }>(
  list: T[],
  traceQuery: DbQueryTracer = untracedDbQuery,
): Promise<Array<T & ExternalBridgeMetadata>> {
  if (list.length === 0) return list;
  const rows = await traceQuery(
    "channels.external_bridges_by_channels",
    () => getDb().select({
      channelId: externalChannelBindings.channelId,
      provider: externalAppRegistrations.provider,
      providerConversationId: externalChannelBindings.providerConversationId,
      state: externalChannelBindings.state,
    }).from(externalChannelBindings)
      .innerJoin(
        externalAppRegistrations,
        eq(externalAppRegistrations.id, externalChannelBindings.registrationId),
      )
      .where(and(
        inArray(externalChannelBindings.channelId, list.map((channel) => channel.id)),
        inArray(externalChannelBindings.state, ["active", "paused", "quarantined"]),
        eq(externalAppRegistrations.state, "active"),
      )),
    (result) => ({
      channels_count: list.length,
      bridged_channels_count: result.length,
    }),
  );
  const bridgeByChannelId = new Map(rows.map((row) => [row.channelId, {
    provider: row.provider,
    providerConversationId: row.providerConversationId,
    state: row.state,
  }]));
  return list.map((channel) => {
    const bridge = bridgeByChannelId.get(channel.id);
    return bridge ? { ...channel, bridge } : channel;
  });
}

export async function listChannels(
  serverId: string,
  userId?: string,
  opts?: ChannelListOptions,
) {
  const db = getDb();
  const archivedFilter = opts?.archived ?? "exclude";
  const traceQuery = opts?.traceQuery ?? untracedDbQuery;
  const conditions = [
    eq(channels.serverId, serverId),
    inArray(channels.type, LISTABLE_CHANNEL_TYPES),
    isNull(channels.deletedAt),
  ];
  if (archivedFilter === "exclude") conditions.push(isNull(channels.archivedAt));
  else if (archivedFilter === "only") conditions.push(isNotNull(channels.archivedAt));
  const list = await traceQuery(
    "channels.list_by_server",
    () => db.select().from(channels)
      .where(and(...conditions))
      .orderBy(asc(channels.createdAt)),
    (rows) => ({
      archived_filter: archivedFilter,
      channels_count: rows.length,
    }),
  );

  // Ensure #all channel exists for this server (lazy init for pre-existing servers).
  // Skip in "only" mode — the archived view should not create channels.
  if (archivedFilter === "only") {
    if (userId) {
      const serverRole = await resolveHumanServerRole(serverId, userId);
      const guestGateEnabled = serverRole === "guest" && await isGuestFeatureEnabled(serverId, userId);
      const memberships = await traceQuery(
        "channels.memberships_by_user",
        () => db
          .select({ channelId: channelHumans.channelId })
          .from(channelHumans)
          .where(eq(channelHumans.userId, userId)),
        (rows) => ({
          channels_count: list.length,
          memberships_count: rows.length,
        }),
      );
      const joinedSet = new Set(memberships.map((m) => m.channelId));
      const visibleChannels = list
        .filter((ch) => serverRole === "guest"
          ? canGuestReadChannel({
              gateEnabled: guestGateEnabled,
              serverRole,
              channelType: ch.type,
              channelName: ch.name,
              allChannelHidden: isAllSystemChannel(ch) && !isEnabledAllChannel(ch),
              guestVisible: ch.guestVisible,
              guestJoinable: ch.guestJoinable,
              isChannelMember: joinedSet.has(ch.id),
              archived: ch.archivedAt !== null,
              deleted: ch.deletedAt !== null,
            })
          : !requiresExplicitMembership(ch.type) || joinedSet.has(ch.id))
        .map((ch) => ({
          ...ch,
          joined: serverRole === "guest" && isAllSystemChannel(ch) ? false : joinedSet.has(ch.id),
        }));
      const humanActivityMuteEnabled = opts?.humanActivityMuteEnabled ?? true;
      return attachJointChannelMetadata(
        await attachLastMessageAt(
          await attachReadState(
            await attachUserChannelDisplayPrefs(
              await attachActivityMuteState(visibleChannels, "user", userId, humanActivityMuteEnabled),
              userId,
            ),
            userId,
          ),
          traceQuery,
          "channels.last_messages_by_channels",
          "channels_count",
        ),
      );
    }
    const visibleChannels = list.filter((ch) => ch.type === "channel");
    return attachJointChannelMetadata(
      await attachLastMessageAt(visibleChannels, traceQuery, "channels.last_messages_by_channels", "channels_count"),
    );
  }

  let allChannel = list.find(isAllSystemChannel);
  if (!allChannel) {
    const result = await db.insert(channels).values({
      serverId,
      name: "all",
      description: "General channel for all members",
      type: "channel",
    }).onConflictDoNothing().returning();

    if (result.length > 0) {
      allChannel = result[0];
    } else {
      // Another request created it concurrently — fetch it
      const [existing] = await db.select().from(channels).where(and(
        eq(channels.serverId, serverId),
        eq(channels.name, SYSTEM_ALL_CHANNEL_KEY),
        inArray(channels.type, REGULAR_CHANNEL_TYPES),
        isNull(channels.deletedAt),
      ));
      allChannel = existing;
    }

    list.push(allChannel);
  }

  const visibleList = allChannel && !isEnabledAllChannel(allChannel)
    ? list.filter((channel) => channel.id !== allChannel.id)
    : list;

  // If userId provided, compute joined status for each channel
  if (userId) {
    const serverRole = await resolveHumanServerRole(serverId, userId);
    const guestGateEnabled = serverRole === "guest" && await isGuestFeatureEnabled(serverId, userId);
    const memberships = await traceQuery(
      "channels.memberships_by_user",
      () => db
        .select({ channelId: channelHumans.channelId })
        .from(channelHumans)
        .where(eq(channelHumans.userId, userId)),
      (rows) => ({
        channels_count: visibleList.length,
        memberships_count: rows.length,
      }),
    );
    const joinedSet = new Set(memberships.map((m) => m.channelId));

    const visibleChannels = visibleList
      .filter((ch) => serverRole === "guest"
        ? canGuestReadChannel({
            gateEnabled: guestGateEnabled,
            serverRole,
            channelType: ch.type,
            channelName: ch.name,
            allChannelHidden: isAllSystemChannel(ch) && !isEnabledAllChannel(ch),
            guestVisible: ch.guestVisible,
            guestJoinable: ch.guestJoinable,
            isChannelMember: joinedSet.has(ch.id),
            archived: ch.archivedAt !== null,
            deleted: ch.deletedAt !== null,
          })
        : !requiresExplicitMembership(ch.type) || joinedSet.has(ch.id))
      .map((ch) => ({
        ...ch,
        joined: serverRole === "guest"
          ? !isAllSystemChannel(ch) && joinedSet.has(ch.id)
          : isEnabledAllChannel(ch) || joinedSet.has(ch.id),
      }));
    const humanActivityMuteEnabled = opts?.humanActivityMuteEnabled ?? true;
    return attachJointChannelMetadata(
      await attachLastMessageAt(
        await attachReadState(
          await attachUserChannelDisplayPrefs(
            await attachActivityMuteState(visibleChannels, "user", userId, humanActivityMuteEnabled),
            userId,
          ),
          userId,
        ),
        traceQuery,
        "channels.last_messages_by_channels",
        "channels_count",
      ),
    );
  }

  const visibleChannels = visibleList.filter((ch) => ch.type === "channel");
  return attachJointChannelMetadata(
    await attachLastMessageAt(visibleChannels, traceQuery, "channels.last_messages_by_channels", "channels_count"),
  );
}

export async function getSystemAllChannel(serverId: string) {
  const db = getDb();
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(
      eq(channels.serverId, serverId),
      eq(channels.name, SYSTEM_ALL_CHANNEL_KEY),
      inArray(channels.type, REGULAR_CHANNEL_TYPES),
      isNull(channels.deletedAt),
    ));
  return channel ?? null;
}

export async function updateChannel(
  channelId: string,
  updates: {
    name?: string;
    description?: string;
    type?: RegularChannelType;
    guestVisible?: boolean;
    guestJoinable?: boolean;
  },
  executor?: DatabaseExecutor,
): Promise<typeof channels.$inferSelect> {
  if (!executor) {
    const updated = await withChannelWriterFence(channelId, tx => updateChannel(channelId, updates, tx));
    // Post-commit: callers that own the transaction (routes) revoke themselves
    // after their commit; the fenced path revokes here, after the fence.
    await revokeChannelAccessAfterUpdate(updates, updated);
    return updated;
  }
  await assertChannelWritableInTransaction(executor, channelId);
  const db = executor ?? getDb();
  const channel = await getChannel(channelId, { executor: db });
  if (!channel) throw new Error("Channel not found");
  if (!REGULAR_CHANNEL_TYPES.includes(channel.type as RegularChannelType) && channel.type !== "joint") {
    throw new Error("Cannot edit DM channels");
  }
  if (channel.type === "joint" && updates.type !== undefined) {
    throw new Error("Cannot change visibility for joint channels");
  }
  if ((updates.guestVisible !== undefined || updates.guestJoinable !== undefined)
    && channel.type !== "channel" && channel.type !== "private") {
    throw new Error("Guest access is supported only for ordinary channels");
  }
  if (isAllSystemChannel(channel) && updates.name && updates.name !== "all") {
    throw new Error("Cannot rename the #all channel");
  }
  if (isAllSystemChannel(channel) && updates.guestJoinable === true) {
    throw new Error("The #all channel does not support Guest joining");
  }
  if (!isAllSystemChannel(channel) && updates.name === SYSTEM_ALL_CHANNEL_KEY) {
    throw new Error('Channel name "all" is reserved');
  }
  const allSystemVisibilityUpdate = isAllSystemChannel(channel)
    && updates.type !== undefined
    && updates.type !== channel.type;

  const jointProjections = channel.type === "joint"
    ? await getActiveJointChannelProjectionsByLocalChannel(channelId, db)
    : [];

  // If renaming, check uniqueness. Joint channel names are shared metadata, so
  // every active projection's server must be able to accept the new local name
  // before any projection is updated.
  if (updates.name && updates.name !== channel.name) {
    const projectionChannels = jointProjections.length > 0
      ? jointProjections.map((projection) => projection.channel)
      : [channel];
    for (const projectionChannel of projectionChannels) {
      const [existing] = await db
        .select({ id: channels.id })
        .from(channels)
        .where(and(
          eq(channels.serverId, projectionChannel.serverId),
          inArray(channels.type, LISTABLE_CHANNEL_TYPES),
          eq(channels.name, updates.name),
          ne(channels.id, projectionChannel.id),
          isNull(channels.deletedAt)
        ));
      if (existing) {
        throw new Error(`Channel name "${updates.name}" is already taken`);
      }
    }
  }

  const setValues: Record<string, unknown> = {};
  if (updates.name !== undefined) setValues.name = updates.name;
  if (updates.description !== undefined) setValues.description = updates.description || null;
  if (allSystemVisibilityUpdate) {
    setValues.type = updates.type;
  } else if (updates.type !== undefined && updates.type !== channel.type) {
    setValues.type = updates.type;
  }
  const nextType = updates.type ?? channel.type;
  const nextGuestVisible = nextType === "private" && !isAllSystemChannel(channel)
    ? false
    : updates.guestVisible ?? channel.guestVisible;
  const nextGuestJoinable = isAllSystemChannel(channel)
    ? false
    : nextType === "private"
      ? false
      : updates.guestJoinable ?? channel.guestJoinable;
  if (nextGuestJoinable && !nextGuestVisible) {
    throw new Error("Guest-joinable channels must also be guest-visible");
  }
  if (!channel.guestJoinable && nextGuestJoinable && channel.archivedAt === null) {
    await acquireServerLock(db, channel.serverId, GUEST_JOINABLE_CHANNEL_LOCK_NAMESPACE);
    await assertGuestJoinableChannelCapacityAvailable(db, channel.serverId);
  }
  if (updates.guestVisible !== undefined || (nextType === "private" && !isAllSystemChannel(channel))) {
    setValues.guestVisible = nextGuestVisible;
  }
  if (isAllSystemChannel(channel) || updates.guestJoinable !== undefined || nextType === "private") {
    setValues.guestJoinable = nextGuestJoinable;
  }

  if (Object.keys(setValues).length === 0) {
    return channel;
  }

  const applyUpdate = async (tx: DatabaseExecutor) => {
    const projectionIds = channel.type === "joint" && jointProjections.length > 0
      ? jointProjections.map((projection) => projection.localChannelId)
      : [channelId];

    await tx.update(channels)
      .set(setValues)
      .where(inArray(channels.id, projectionIds));

    if (allSystemVisibilityUpdate && updates.type === "private") {
      await Promise.all([
        tx.delete(channelHumans).where(eq(channelHumans.channelId, channelId)),
        tx.delete(channelAgents).where(eq(channelAgents.channelId, channelId)),
      ]);
    }

    const [updated] = await tx.select().from(channels).where(eq(channels.id, channelId));

    if (channel.type === "channel" && updated.type === "private") {
      await pruneThreadFollowsOutsideParentMembership(channelId, tx);
    }

    return updated;
  };
  return applyUpdate(executor);
}

/** Transaction callers invoke this only after commit, before publishing new
 * metadata/messages. Eviction is scoped to the connections that can lose read
 * access (closing a connection also drops its child thread rooms):
 * - `guestVisible: false` evicts the server's guest connections;
 * - `type: "private"` evicts connections of users who are not channel members;
 * - #all enable/disable evicts the whole server, since it changes every
 *   member's audience.
 * Widening changes (`guestVisible: true`, private -> public) revoke nothing.
 * The decision is made from the requested update and the committed row, not
 * a before/after diff, so an idempotent retry after a failed cross-replica
 * notification repairs the eviction instead of skipping it. */
export async function revokeChannelAccessAfterUpdate(
  updates: { type?: RegularChannelType; guestVisible?: boolean },
  after: Pick<typeof channels.$inferSelect, "id" | "serverId" | "type" | "name">,
) {
  if (isAllSystemChannel(after)) {
    if (updates.type !== undefined) await revokeSocketAccess({ serverId: after.serverId });
    return;
  }
  const revocations: Promise<void>[] = [];
  if (updates.guestVisible === false) {
    revocations.push(revokeSocketAccess({ serverId: after.serverId, scope: "guests" }));
  }
  if (updates.type === "private") {
    const memberUserIds = (await getChannelHumans(after.id)).map((human) => human.id);
    revocations.push(revokeSocketAccess({ serverId: after.serverId, scope: "non-members", channelId: after.id, memberUserIds }));
  }
  await Promise.all(revocations);
}

export async function getActiveJointChannelProjectionsByLocalChannel(
  channelId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<JointChannelProjection[]> {
  const db = executor;
  const [projection] = await db
    .select({ jointChannelId: jointChannelServers.jointChannelId })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(
      eq(jointChannelServers.localChannelId, channelId),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
    ));
  let jointChannelId = projection?.jointChannelId ?? null;
  if (!jointChannelId) {
    const [storage] = await db
      .select({ jointChannelId: jointChannels.id })
      .from(jointChannels)
      .where(and(
        eq(jointChannels.canonicalChannelId, channelId),
        eq(jointChannels.status, "active"),
      ));
    jointChannelId = storage?.jointChannelId ?? null;
  }
  if (!jointChannelId) return [];

  const rows = await db
    .select({
      jointChannelId: jointChannelServers.jointChannelId,
      localChannelId: jointChannelServers.localChannelId,
      canonicalChannelId: jointChannels.canonicalChannelId,
      serverId: jointChannelServers.serverId,
      role: jointChannelServers.role,
      channel: channels,
    })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
    .where(and(
      eq(jointChannelServers.jointChannelId, jointChannelId),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
      isNull(channels.deletedAt),
    ))
    .orderBy(asc(jointChannelServers.joinedAt));

  return rows.map((row) => ({
    ...row,
    role: row.role as "host" | "participant",
  }));
}

async function ensureJointThreadProjectionForLocalParent(
  executor: DatabaseExecutor,
  input: {
    jointThreadId: string;
    localParentProjection: Pick<JointChannelProjection, "serverId" | "localChannelId" | "role">;
    parentMessageId: string;
    joinedByUserId: string | null;
  },
): Promise<{ localThreadChannelId: string; created: boolean }> {
  const [existingLocal] = await executor
    .select({ localChannelId: jointChannelServers.localChannelId })
    .from(jointChannelServers)
    .where(and(
      eq(jointChannelServers.jointChannelId, input.jointThreadId),
      eq(jointChannelServers.serverId, input.localParentProjection.serverId),
      eq(jointChannelServers.status, "active"),
    ))
    .limit(1);

  if (existingLocal?.localChannelId) {
    return { localThreadChannelId: existingLocal.localChannelId, created: false };
  }

  const [threadProjection] = await executor.insert(channels).values({
    serverId: input.localParentProjection.serverId,
    name: `thread-${input.parentMessageId.slice(0, 8)}`,
    type: "thread",
    parentMessageId: null,
  }).returning();

  await executor.insert(jointChannelServers).values({
    jointChannelId: input.jointThreadId,
    serverId: input.localParentProjection.serverId,
    localChannelId: threadProjection.id,
    role: input.localParentProjection.role,
    status: "active",
    joinedByUserId: input.joinedByUserId,
  }).onConflictDoNothing();

  return { localThreadChannelId: threadProjection.id, created: true };
}

async function backfillJointThreadProjectionsForLocalParent(
  executor: DatabaseExecutor,
  input: {
    jointChannelId: string;
    canonicalParentChannelId: string;
    localParentProjection: Pick<JointChannelProjection, "serverId" | "localChannelId" | "role">;
    joinedByUserId: string | null;
  },
): Promise<void> {
  const canonicalThread = alias(channels, "joint_backfill_canonical_thread");
  const parentMessage = alias(messages, "joint_backfill_parent_message");
  const rows = await executor
    .select({
      jointThreadId: jointChannels.id,
      parentMessageId: canonicalThread.parentMessageId,
    })
    .from(jointChannels)
    .innerJoin(canonicalThread, eq(canonicalThread.id, jointChannels.canonicalChannelId))
    .innerJoin(parentMessage, eq(parentMessage.id, canonicalThread.parentMessageId))
    .where(and(
      eq(parentMessage.channelId, input.canonicalParentChannelId),
      eq(canonicalThread.type, "thread"),
      eq(jointChannels.status, "active"),
      isNull(canonicalThread.deletedAt),
    ));

  for (const row of rows) {
    if (!row.parentMessageId) continue;
    await ensureJointThreadProjectionForLocalParent(executor, {
      jointThreadId: row.jointThreadId,
      localParentProjection: input.localParentProjection,
      parentMessageId: row.parentMessageId,
      joinedByUserId: input.joinedByUserId,
    });
  }
}

async function listActiveJointThreadProjectionRows(
  input: { localThreadChannelId?: string; canonicalThreadChannelId?: string; serverId?: string },
  executor: DatabaseExecutor = getDb(),
): Promise<JointThreadProjection[]> {
  const db = executor;
  const localThread = alias(channels, "joint_thread_local_thread");
  const canonicalThread = alias(channels, "joint_thread_canonical_thread");
  const parentMessage = alias(messages, "joint_thread_parent_message");
  const parentJoint = alias(jointChannels, "joint_thread_parent_joint");
  const parentProjection = alias(jointChannelServers, "joint_thread_parent_projection");

  const filters = [
    eq(jointChannels.status, "active"),
    eq(jointChannelServers.status, "active"),
    eq(parentJoint.status, "active"),
    eq(parentProjection.status, "active"),
    eq(localThread.type, "thread"),
    eq(canonicalThread.type, "thread"),
    // The parent message is the durable local↔canonical Thread identity
    // anchor. A swapped projection row must not silently redirect reads or
    // writes to another canonical Thread that happens to share the parent
    // channel; fail closed until the mapping is repaired.
    sql`${parentMessage.threadId} = ${canonicalThread.id}::text`,
    isNull(localThread.deletedAt),
    isNull(canonicalThread.deletedAt),
  ];
  if (input.localThreadChannelId) filters.push(eq(jointChannelServers.localChannelId, input.localThreadChannelId));
  if (input.canonicalThreadChannelId) filters.push(eq(jointChannels.canonicalChannelId, input.canonicalThreadChannelId));
  if (input.serverId) filters.push(eq(jointChannelServers.serverId, input.serverId));

  const rows = await db
    .select({
      jointThreadId: jointChannels.id,
      localThreadChannelId: jointChannelServers.localChannelId,
      canonicalThreadChannelId: jointChannels.canonicalChannelId,
      localServerId: jointChannelServers.serverId,
      localParentChannelId: parentProjection.localChannelId,
      canonicalParentChannelId: parentMessage.channelId,
      canonicalParentMessageId: canonicalThread.parentMessageId,
      role: jointChannelServers.role,
      threadChannel: localThread,
    })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .innerJoin(localThread, eq(localThread.id, jointChannelServers.localChannelId))
    .innerJoin(canonicalThread, eq(canonicalThread.id, jointChannels.canonicalChannelId))
    .innerJoin(parentMessage, eq(parentMessage.id, canonicalThread.parentMessageId))
    .innerJoin(parentJoint, eq(parentJoint.canonicalChannelId, parentMessage.channelId))
    .innerJoin(parentProjection, and(
      eq(parentProjection.jointChannelId, parentJoint.id),
      eq(parentProjection.serverId, jointChannelServers.serverId),
    ))
    .where(and(...filters))
    .orderBy(asc(jointChannelServers.joinedAt));

  return rows
    .filter((row): row is typeof row & { canonicalParentMessageId: string } => Boolean(row.canonicalParentMessageId))
    .map((row) => ({ ...row, role: row.role as "host" | "participant" }));
}

export async function getJointThreadProjectionByLocalThread(
  localThreadChannelId: string,
  serverId?: string,
  executor: DatabaseExecutor = getDb(),
): Promise<JointThreadProjection | null> {
  const [projection] = await listActiveJointThreadProjectionRows({ localThreadChannelId, serverId }, executor);
  return projection ?? null;
}

export async function getActiveJointThreadProjectionsByCanonicalThread(
  canonicalThreadChannelId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<JointThreadProjection[]> {
  return listActiveJointThreadProjectionRows({ canonicalThreadChannelId }, executor);
}

export async function getJointThreadProjectionForMember(
  canonicalThreadChannelId: string,
  followerType: "user" | "agent",
  followerId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<JointThreadProjection | null> {
  const projections = await getActiveJointThreadProjectionsByCanonicalThread(canonicalThreadChannelId, executor);
  for (const projection of projections) {
    const isMember = followerType === "user"
      ? await isChannelHuman(projection.localParentChannelId, followerId, executor)
      : await isChannelAgent(projection.localParentChannelId, followerId, executor);
    if (isMember) return projection;
  }
  return null;
}

export async function canUserSeeAgentThroughJointChannel(serverId: string, userId: string, agentId: string): Promise<boolean> {
  const db = getDb();
  const localProjection = alias(jointChannelServers, "joint_profile_local_projection");
  const peerProjection = alias(jointChannelServers, "joint_profile_peer_projection");
  const [row] = await db
    .select({ jointChannelId: localProjection.jointChannelId })
    .from(localProjection)
    .innerJoin(peerProjection, eq(peerProjection.jointChannelId, localProjection.jointChannelId))
    .innerJoin(jointChannels, eq(jointChannels.id, localProjection.jointChannelId))
    .innerJoin(channelHumans, and(
      eq(channelHumans.channelId, localProjection.localChannelId),
      eq(channelHumans.userId, userId),
    ))
    .innerJoin(channelAgents, and(
      eq(channelAgents.channelId, peerProjection.localChannelId),
      eq(channelAgents.agentId, agentId),
    ))
    .where(and(
      eq(localProjection.serverId, serverId),
      eq(localProjection.status, "active"),
      eq(peerProjection.status, "active"),
      eq(jointChannels.status, "active"),
    ))
    .limit(1);
  return !!row;
}

/**
 * Local-channel counterpart to the joint projection check above. Guest agent
 * profiles are relation-scoped: seeing an Agent in one readable, joined
 * channel grants only its public summary, never the server-wide directory.
 */
export async function canUserSeeAgentThroughLocalChannel(
  serverId: string,
  requesterId: string,
  agentId: string,
): Promise<boolean> {
  return (await getAgentIdsVisibleThroughLocalChannels(serverId, requesterId)).has(agentId);
}

export async function getAgentIdsVisibleThroughLocalChannels(
  serverId: string,
  requesterId: string,
): Promise<Set<string>> {
  const readableChannels = await listChannels(serverId, requesterId, { archived: "include" });
  if (readableChannels.length === 0) return new Set();

  const db = getDb();
  const visibleAgentIds = new Set<string>();
  const explicitChannelIds = readableChannels
    .filter((channel) => !isEnabledAllChannel(channel))
    .map((channel) => channel.id);
  if (explicitChannelIds.length > 0) {
    const rows = await db
      .select({ agentId: channelAgents.agentId })
      .from(channelAgents)
      .innerJoin(agents, and(eq(agents.id, channelAgents.agentId), isNull(agents.deletedAt)))
      .where(inArray(channelAgents.channelId, explicitChannelIds));
    for (const row of rows) visibleAgentIds.add(row.agentId);
  }
  if (readableChannels.some(isEnabledAllChannel)) {
    const rows = await db
      .select({ agentId: agents.id })
      .from(agents)
      .where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt)));
    for (const row of rows) visibleAgentIds.add(row.agentId);
  }
  return visibleAgentIds;
}

export async function listJointActivityProjectionChannelIdsForAgent(agentId: string, sourceServerId: string): Promise<string[]> {
  const db = getDb();
  const sourceProjection = alias(jointChannelServers, "joint_activity_source_projection");
  const siblingProjection = alias(jointChannelServers, "joint_activity_sibling_projection");

  const rows = await db
    .select({ localChannelId: siblingProjection.localChannelId })
    .from(channelAgents)
    .innerJoin(sourceProjection, and(
      eq(sourceProjection.localChannelId, channelAgents.channelId),
      eq(sourceProjection.status, "active"),
    ))
    .innerJoin(siblingProjection, and(
      eq(siblingProjection.jointChannelId, sourceProjection.jointChannelId),
      eq(siblingProjection.status, "active"),
      ne(siblingProjection.serverId, sourceServerId),
    ))
    .where(eq(channelAgents.agentId, agentId));

  return [...new Set(rows.map((row) => row.localChannelId))];
}

export async function getJointVisibleHumanServerId(serverId: string, requesterId: string, targetUserId: string): Promise<string | null> {
  const db = getDb();
  const localProjection = alias(jointChannelServers, "joint_human_profile_local_projection");
  const peerProjection = alias(jointChannelServers, "joint_human_profile_peer_projection");
  const peerHumans = alias(channelHumans, "joint_human_profile_peer_humans");
  const [row] = await db
    .select({ serverId: peerProjection.serverId })
    .from(localProjection)
    .innerJoin(peerProjection, eq(peerProjection.jointChannelId, localProjection.jointChannelId))
    .innerJoin(jointChannels, eq(jointChannels.id, localProjection.jointChannelId))
    .innerJoin(channelHumans, and(
      eq(channelHumans.channelId, localProjection.localChannelId),
      eq(channelHumans.userId, requesterId),
    ))
    .innerJoin(peerHumans, and(
      eq(peerHumans.channelId, peerProjection.localChannelId),
      eq(peerHumans.userId, targetUserId),
    ))
    .where(and(
      eq(localProjection.serverId, serverId),
      eq(localProjection.status, "active"),
      eq(peerProjection.status, "active"),
      eq(jointChannels.status, "active"),
    ))
    .limit(1);
  return row?.serverId ?? null;
}

export async function canUserSeeHumanThroughLocalChannel(serverId: string, requesterId: string, targetUserId: string): Promise<boolean> {
  if (requesterId === targetUserId) return true;

  const db = getDb();
  const requesterRole = await resolveHumanServerRole(serverId, requesterId);
  const targetHumans = alias(channelHumans, "hidden_profile_target_humans");
  if (requesterRole === "guest") {
    if (!await isGuestFeatureEnabled(serverId, requesterId)) return false;
    const requesterMemberships = new Set((await db
      .select({ channelId: channelHumans.channelId })
      .from(channelHumans)
      .innerJoin(channels, and(
        eq(channels.id, channelHumans.channelId),
        eq(channels.serverId, serverId),
        isNull(channels.deletedAt),
      ))
      .where(eq(channelHumans.userId, requesterId))).map((row) => row.channelId));
    const targetChannels = await db
      .select({
        id: channels.id,
        name: channels.name,
        type: channels.type,
        guestVisible: channels.guestVisible,
        guestJoinable: channels.guestJoinable,
        archivedAt: channels.archivedAt,
        deletedAt: channels.deletedAt,
      })
      .from(targetHumans)
      .innerJoin(channels, and(
        eq(channels.id, targetHumans.channelId),
        eq(channels.serverId, serverId),
        isNull(channels.deletedAt),
      ))
      .where(eq(targetHumans.userId, targetUserId));
    if (targetChannels.some((channel) => canGuestReadChannel({
      gateEnabled: true,
      serverRole: "guest",
      channelType: channel.type,
      channelName: channel.name,
      allChannelHidden: isAllSystemChannel(channel) && !isEnabledAllChannel(channel),
      guestVisible: channel.guestVisible,
      guestJoinable: channel.guestJoinable,
      isChannelMember: requesterMemberships.has(channel.id),
      archived: channel.archivedAt !== null,
      deleted: channel.deletedAt !== null,
    }))) return true;

    const allChannel = await getSystemAllChannel(serverId);
    return Boolean(
      allChannel
      && await isServerHumanMember(serverId, targetUserId)
      && canGuestReadChannel({
        gateEnabled: true,
        serverRole: "guest",
        channelType: allChannel.type,
        channelName: allChannel.name,
        allChannelHidden: !isEnabledAllChannel(allChannel),
        guestVisible: allChannel.guestVisible,
        guestJoinable: allChannel.guestJoinable,
        isChannelMember: false,
        archived: allChannel.archivedAt !== null,
        deleted: allChannel.deletedAt !== null,
      })
    );
  }
  const rows = await db
    .select({ name: channels.name, type: channels.type })
    .from(channelHumans)
    .innerJoin(targetHumans, and(
      eq(targetHumans.channelId, channelHumans.channelId),
      eq(targetHumans.userId, targetUserId),
    ))
    .innerJoin(channels, and(
      eq(channels.id, channelHumans.channelId),
      eq(channels.serverId, serverId),
      isNull(channels.deletedAt),
    ))
    .where(eq(channelHumans.userId, requesterId));

  return rows.some((channel) => !isAllSystemChannel(channel));
}

export async function getHumanIdsVisibleThroughLocalChannels(serverId: string, requesterId: string): Promise<Set<string>> {
  const db = getDb();
  const visibleHumans = alias(channelHumans, "hidden_directory_visible_humans");
  const rows = await db
    .select({
      userId: visibleHumans.userId,
      name: channels.name,
      type: channels.type,
    })
    .from(channelHumans)
    .innerJoin(visibleHumans, eq(visibleHumans.channelId, channelHumans.channelId))
    .innerJoin(channels, and(
      eq(channels.id, channelHumans.channelId),
      eq(channels.serverId, serverId),
      isNull(channels.deletedAt),
    ))
    .where(eq(channelHumans.userId, requesterId));

  return new Set(rows
    .filter((channel) => !isAllSystemChannel(channel))
    .map((channel) => channel.userId));
}

export async function getHumanIdsVisibleThroughJointChannels(serverId: string, requesterId: string): Promise<Set<string>> {
  const db = getDb();
  const localProjection = alias(jointChannelServers, "hidden_directory_joint_local_projection");
  const peerProjection = alias(jointChannelServers, "hidden_directory_joint_peer_projection");
  const peerHumans = alias(channelHumans, "hidden_directory_joint_peer_humans");
  const rows = await db
    .select({ userId: peerHumans.userId })
    .from(localProjection)
    .innerJoin(peerProjection, and(
      eq(peerProjection.jointChannelId, localProjection.jointChannelId),
      ne(peerProjection.serverId, serverId),
    ))
    .innerJoin(jointChannels, and(
      eq(jointChannels.id, localProjection.jointChannelId),
      eq(jointChannels.status, "active"),
    ))
    .innerJoin(channelHumans, and(
      eq(channelHumans.channelId, localProjection.localChannelId),
      eq(channelHumans.userId, requesterId),
    ))
    .innerJoin(peerHumans, eq(peerHumans.channelId, peerProjection.localChannelId))
    .where(and(
      eq(localProjection.serverId, serverId),
      eq(localProjection.status, "active"),
      eq(peerProjection.status, "active"),
    ));

  return new Set(rows.map((row) => row.userId));
}

export async function canUserSeeHumanThroughJointChannel(serverId: string, requesterId: string, targetUserId: string): Promise<boolean> {
  return !!await getJointVisibleHumanServerId(serverId, requesterId, targetUserId);
}

// Thread follows are delivery/inbox state, not access grants. Member removal
// keeps follows intact; private delivery paths intersect follows with current
// parent membership. Only parent visibility tightening needs a durable snapshot
// cleanup so historical public followers outside the private member set stop
// carrying stale attention state.
async function pruneThreadFollowsOutsideParentMembership(
  parentChannelId: string,
  executor: DatabaseExecutor,
) {
  const start = currentTimeMs();
  const userResult = await executor.execute(sql`
    DELETE FROM ${threadFollows}
    WHERE ${threadFollows.followerType} = 'user'
      AND EXISTS (
        SELECT 1
        FROM ${channels} parent_threads
        INNER JOIN ${messages} parent_messages
          ON parent_messages.id = parent_threads.parent_message_id
        WHERE parent_threads.id = ${threadFollows.threadChannelId}
          AND parent_threads.type = 'thread'
          AND parent_threads.deleted_at IS NULL
          AND parent_messages.channel_id = ${parentChannelId}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM ${channelHumans}
        WHERE ${channelHumans.channelId} = ${parentChannelId}
          AND ${channelHumans.userId} = ${threadFollows.followerId}
      )
    RETURNING 1
  `);

  const agentResult = await executor.execute(sql`
    DELETE FROM ${threadFollows}
    WHERE ${threadFollows.followerType} = 'agent'
      AND EXISTS (
        SELECT 1
        FROM ${channels} parent_threads
        INNER JOIN ${messages} parent_messages
          ON parent_messages.id = parent_threads.parent_message_id
        WHERE parent_threads.id = ${threadFollows.threadChannelId}
          AND parent_threads.type = 'thread'
          AND parent_threads.deleted_at IS NULL
          AND parent_messages.channel_id = ${parentChannelId}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM ${channelAgents}
        WHERE ${channelAgents.channelId} = ${parentChannelId}
          AND ${channelAgents.agentId} = ${threadFollows.followerId}
      )
    RETURNING 1
  `);
  addTraceEvent("thread_follows.pruned_outside_parent_membership", {
    phase: "channel_visibility.private_conversion",
    user_row_count: userResult.rows.length,
    agent_row_count: agentResult.rows.length,
    row_count: userResult.rows.length + agentResult.rows.length,
    duration_ms: currentTimeMs() - start,
  });
}

export async function getChannel(
  channelId: string,
  opts?: { includeDeleted?: boolean; executor?: DatabaseExecutor },
) {
  const db = opts?.executor ?? getDb();
  const conditions = [eq(channels.id, channelId)];
  if (!opts?.includeDeleted) {
    conditions.push(isNull(channels.deletedAt));
  }
  const [channel] = await db.select().from(channels).where(and(...conditions));
  return channel || null;
}

export async function hasDeletedDmThreadParent(threadChannelId: string, serverId: string): Promise<boolean> {
  const result = await getDb().execute(sql`
    SELECT 1
    FROM channels thread_channel
    INNER JOIN messages parent_message
      ON parent_message.id = thread_channel.parent_message_id
    INNER JOIN channels parent_channel
      ON parent_channel.id = parent_message.channel_id
    WHERE thread_channel.id = ${threadChannelId}::uuid
      AND thread_channel.server_id = ${serverId}::uuid
      AND thread_channel.type = 'thread'
      AND thread_channel.deleted_at IS NULL
      AND parent_channel.server_id = ${serverId}::uuid
      AND parent_channel.type = 'dm'
      AND parent_channel.deleted_at IS NOT NULL
    LIMIT 1
  `);
  return result.rows.length === 1;
}

export async function hasUserThreadResidue(userId: string, serverId: string, threadChannelId: string): Promise<boolean> {
  const result = await getDb().execute(sql`
    SELECT 1
    WHERE EXISTS (
      SELECT 1 FROM user_channel_read_cursors cursor_row
      WHERE cursor_row.user_id = ${userId}::uuid
        AND cursor_row.channel_id = ${threadChannelId}::uuid
    )
    OR EXISTS (
      SELECT 1 FROM inbox_notification_facts fact_row
      WHERE fact_row.receiver_type = 'user'
        AND fact_row.receiver_id = ${userId}::uuid
        AND fact_row.server_id = ${serverId}::uuid
        AND fact_row.source_channel_id = ${threadChannelId}::uuid
    )
  `);
  return result.rows.length === 1;
}

export type ChannelAccessResolution =
  | {
      kind: "local";
      localChannelId: string;
      canonicalChannelId: string;
      serverId: string;
      channel: typeof channels.$inferSelect;
    }
  | {
      kind: "joint";
      localChannelId: string;
      canonicalChannelId: string;
      jointChannelId: string;
      localServerId: string;
      role: "host" | "participant";
      channel: typeof channels.$inferSelect;
    };

/**
 * Resolve a request-scoped channel id into its storage authority.
 *
 * For ordinary channels this is identity. For joint channels, the caller must
 * present the local projection id that belongs to their active server. The
 * canonical channel is storage-only and never grants cross-server access on
 * its own.
 */
export async function resolveChannelAccess(input: {
  serverId: string;
  channelId: string;
  includeDeleted?: boolean;
  executor?: DatabaseExecutor;
}): Promise<ChannelAccessResolution | null> {
  const db = input.executor ?? getDb();
  const channel = await getChannel(input.channelId, {
    includeDeleted: input.includeDeleted,
    executor: db,
  });
  if (!channel) return null;
  if (channel.serverId !== input.serverId) return null;

  if (channel.type !== "joint") {
    return {
      kind: "local",
      localChannelId: channel.id,
      canonicalChannelId: channel.id,
      serverId: channel.serverId,
      channel,
    };
  }

  const [projection] = await db
    .select({
      jointChannelId: jointChannelServers.jointChannelId,
      localChannelId: jointChannelServers.localChannelId,
      localServerId: jointChannelServers.serverId,
      role: jointChannelServers.role,
      projectionStatus: jointChannelServers.status,
      canonicalChannelId: jointChannels.canonicalChannelId,
      jointStatus: jointChannels.status,
    })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(
      eq(jointChannelServers.localChannelId, channel.id),
      eq(jointChannelServers.serverId, input.serverId),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
    ));

  if (!projection) return null;

  return {
    kind: "joint",
    localChannelId: projection.localChannelId,
    canonicalChannelId: projection.canonicalChannelId,
    jointChannelId: projection.jointChannelId,
    localServerId: projection.localServerId,
    role: projection.role,
    channel,
  };
}

/**
 * Resolve every message-bearing channel visible through a server's local
 * namespace into canonical storage in one projection-aware query.
 */
export async function resolveServerMessageStorageChannelIds(
  serverId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<string[]> {
  const result = await executor.execute(sql`
    WITH local_channels AS (
      SELECT local_channel.id, local_channel.type
      FROM ${channels} local_channel
      WHERE local_channel.server_id = ${serverId}::uuid
    ), ordinary_local AS (
      SELECT local_channel.id AS storage_channel_id
      FROM local_channels local_channel
      WHERE local_channel.type <> 'joint'
        AND NOT EXISTS (
          SELECT 1
          FROM ${jointChannelServers} mapped_projection
          WHERE mapped_projection.local_channel_id = local_channel.id
        )
    ), active_joint_channels AS (
      SELECT joint_authority.canonical_channel_id AS storage_channel_id
      FROM local_channels local_channel
      INNER JOIN ${jointChannelServers} local_projection
        ON local_projection.local_channel_id = local_channel.id
      INNER JOIN ${jointChannels} joint_authority
        ON joint_authority.id = local_projection.joint_channel_id
      WHERE local_channel.type = 'joint'
        AND local_projection.server_id = ${serverId}::uuid
        AND local_projection.status = 'active'
        AND joint_authority.status = 'active'
    ), active_joint_threads AS (
      SELECT thread_authority.canonical_channel_id AS storage_channel_id
      FROM local_channels local_thread_scope
      INNER JOIN ${jointChannelServers} thread_projection
        ON thread_projection.local_channel_id = local_thread_scope.id
      INNER JOIN ${jointChannels} thread_authority
        ON thread_authority.id = thread_projection.joint_channel_id
      INNER JOIN ${channels} local_thread
        ON local_thread.id = thread_projection.local_channel_id
      INNER JOIN ${channels} canonical_thread
        ON canonical_thread.id = thread_authority.canonical_channel_id
      INNER JOIN ${messages} parent_message
        ON parent_message.id = canonical_thread.parent_message_id
      INNER JOIN ${jointChannels} parent_authority
        ON parent_authority.canonical_channel_id = parent_message.channel_id
      INNER JOIN ${jointChannelServers} parent_projection
        ON parent_projection.joint_channel_id = parent_authority.id
        AND parent_projection.server_id = thread_projection.server_id
      WHERE local_thread_scope.type = 'thread'
        AND thread_projection.server_id = ${serverId}::uuid
        AND thread_projection.status = 'active'
        AND thread_authority.status = 'active'
        AND parent_projection.status = 'active'
        AND parent_authority.status = 'active'
        AND local_thread.deleted_at IS NULL
        AND canonical_thread.type = 'thread'
        AND canonical_thread.deleted_at IS NULL
    )
    SELECT DISTINCT resolved.storage_channel_id::text AS "storageChannelId"
    FROM (
      SELECT storage_channel_id FROM ordinary_local
      UNION ALL
      SELECT storage_channel_id FROM active_joint_channels
      UNION ALL
      SELECT storage_channel_id FROM active_joint_threads
    ) resolved
    ORDER BY "storageChannelId"
  `);

  return (result.rows as Array<{ storageChannelId: string }>).map((row) => row.storageChannelId);
}

/**
 * For a thread channel, return the parent channel's type ("channel" | "private" | "joint" | "dm").
 * Returns null if the channel is not a thread or the parent can't be found.
 */
export async function getThreadParentChannelType(channel: { type: string; parentMessageId: string | null }): Promise<"channel" | "private" | "joint" | "dm" | null> {
  if (channel.type !== "thread" || !channel.parentMessageId) return null;
  const db = getDb();
  const [parentMsg] = await db
    .select({ channelId: messages.channelId })
    .from(messages)
    .where(eq(messages.id, channel.parentMessageId));
  if (!parentMsg) return null;
  const parentChannel = await getChannel(parentMsg.channelId);
  return (parentChannel?.type as "channel" | "private" | "joint" | "dm") ?? null;
}

/**
 * Archive a channel. Freezes writes but preserves read access and the name.
 * Idempotent: archiving an already-archived channel is a no-op and returns
 * the current row.
 * Refuses to archive the #all channel, DMs, and threads.
 */
export async function archiveChannel(
  channelId: string,
  archivedByUserId: string,
  executor?: DatabaseExecutor,
): Promise<typeof channels.$inferSelect> {
  if (!executor) return withChannelWriterFence(channelId, tx => archiveChannel(channelId, archivedByUserId, tx));
  await assertChannelWritableInTransaction(executor, channelId);
  const db = executor ?? getDb();
  const channel = await getChannel(channelId, { executor: db });
  if (!channel) throw new Error("Channel not found");
  if (!REGULAR_CHANNEL_TYPES.includes(channel.type as RegularChannelType) && channel.type !== "joint") throw new Error("Only regular channels can be archived");
  if (isAllSystemChannel(channel)) throw new Error("The #all channel cannot be archived");
  if (channel.archivedAt) return channel;

  if (channel.type === "joint") {
    const projections = await getActiveJointChannelProjectionsByLocalChannel(channelId, db);
    const projectionIds = projections.length > 0
      ? projections.map((projection) => projection.localChannelId)
      : [channelId];
    const [updated] = await db.update(channels)
      .set({ archivedAt: currentDate(), archivedByUserId, archivedByAgentId: null })
      .where(inArray(channels.id, projectionIds))
      .returning();
    return updated ?? channel;
  }

  const applyArchive = async (tx: DatabaseExecutor) => {
    const [updated] = await tx.update(channels)
      .set({ archivedAt: currentDate(), archivedByUserId, archivedByAgentId: null })
      .where(and(eq(channels.id, channelId), isNull(channels.archivedAt)))
      .returning();
    if (!updated) {
      const [unchanged] = await tx.select().from(channels).where(eq(channels.id, channelId)).limit(1);
      return unchanged ?? channel;
    }
    await emitPublicChannelArchiveEvents(tx, updated, "human");
    return updated;
  };
  return executor ? applyArchive(executor) : getDb().transaction(applyArchive);
}

async function emitPublicChannelArchiveEvents(
  executor: DatabaseExecutor,
  channel: typeof channels.$inferSelect,
  actorType: "human" | "agent",
): Promise<void> {
  if (channel.type !== "channel") return;
  const provenance = {
    source: "channel_service",
    actor_type: actorType,
    changed_fields: ["archived"],
  };
  await emitAppFacingNotificationEvent({
    serverId: channel.serverId,
    eventType: "server.public_channel_archived",
    subjectType: "channel",
    subjectId: channel.id,
    provenance,
  }, executor);
  await emitAppFacingNotificationEvent({
    serverId: channel.serverId,
    eventType: "channel.archived",
    subjectType: "channel",
    subjectId: channel.id,
    provenance,
  }, executor);
}

/**
 * Atomically archive or unarchive a local public/private channel as an agent.
 *
 * The conditional write is the source of truth for `changed`: concurrent
 * identical requests cannot both claim the transition and therefore cannot
 * emit duplicate lifecycle activity. Agent provenance is stored on the
 * channel row rather than relying on a best-effort system message.
 */
export async function setLocalChannelArchivedByAgent(
  channelId: string,
  archivedByAgentId: string,
  archived: boolean,
  executor?: DatabaseExecutor,
): Promise<{ channel: typeof channels.$inferSelect; changed: boolean }> {
  if (!executor) return withChannelWriterFence(channelId, tx => setLocalChannelArchivedByAgent(channelId, archivedByAgentId, archived, tx));
  await assertChannelWritableInTransaction(executor, channelId);
  const db = executor ?? getDb();
  const current = await getChannel(channelId, { executor: db });
  if (!current) throw new Error("Channel not found");
  if (!REGULAR_CHANNEL_TYPES.includes(current.type as RegularChannelType) && current.type !== "joint") {
    throw new Error("Only regular channels can be archived");
  }
  if (isAllSystemChannel(current)) throw new Error("The #all channel cannot be archived");

  if (current.type === "joint") {
    // Same shape as the human joint archive: the archive is shared, so every
    // active projection flips together.
    const projections = await getActiveJointChannelProjectionsByLocalChannel(channelId, db);
    const projectionIds = projections.length > 0
      ? projections.map((projection) => projection.localChannelId)
      : [channelId];
    const changedRows = await db.update(channels)
      .set(archived
        ? { archivedAt: currentDate(), archivedByUserId: null, archivedByAgentId }
        : { archivedAt: null, archivedByUserId: null, archivedByAgentId: null })
      .where(and(
        inArray(channels.id, projectionIds),
        archived ? isNull(channels.archivedAt) : isNotNull(channels.archivedAt),
      ))
      .returning();
    const updatedLocal = changedRows.find((row) => row.id === channelId);
    if (updatedLocal) return { channel: updatedLocal, changed: true };
    const [unchanged] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!unchanged) throw new Error("Channel not found");
    return { channel: unchanged, changed: changedRows.length > 0 };
  }

  const applyArchive = async (tx: DatabaseExecutor) => {
    const [updated] = await tx.update(channels)
      .set(archived
        ? {
            archivedAt: currentDate(),
            archivedByUserId: null,
            archivedByAgentId,
          }
        : {
            archivedAt: null,
            archivedByUserId: null,
            archivedByAgentId: null,
          })
      .where(and(
        eq(channels.id, channelId),
        archived ? isNull(channels.archivedAt) : isNotNull(channels.archivedAt),
      ))
      .returning();

    if (updated) {
      if (archived) await emitPublicChannelArchiveEvents(tx, updated, "agent");
      return { channel: updated, changed: true };
    }
    const [unchanged] = await tx.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!unchanged) throw new Error("Channel not found");
    return { channel: unchanged, changed: false };
  };
  return executor ? applyArchive(executor) : getDb().transaction(applyArchive);
}

/**
 * Unarchive a channel. Idempotent on already-active channels.
 */
export async function unarchiveChannel(channelId: string, executor?: DatabaseExecutor): Promise<typeof channels.$inferSelect> {
  if (!executor) return withChannelWriterFence(channelId, tx => unarchiveChannel(channelId, tx));
  await assertChannelWritableInTransaction(executor, channelId);
  const db = executor ?? getDb();
  const channel = await getChannel(channelId, { executor: db });
  if (!channel) throw new Error("Channel not found");
  if (!REGULAR_CHANNEL_TYPES.includes(channel.type as RegularChannelType) && channel.type !== "joint") throw new Error("Only regular channels can be unarchived");
  if (!channel.archivedAt) return channel;

  let guestJoinable = channel.guestJoinable;
  if (guestJoinable) {
    await acquireServerLock(db, channel.serverId, GUEST_JOINABLE_CHANNEL_LOCK_NAMESPACE);
    try {
      await assertGuestJoinableChannelCapacityAvailable(db, channel.serverId);
    } catch (error) {
      if (!(error instanceof GuestJoinableChannelLimitError)) throw error;
      guestJoinable = false;
    }
  }

  if (channel.type === "joint") {
    const projections = await getActiveJointChannelProjectionsByLocalChannel(channelId, db);
    const projectionIds = projections.length > 0
      ? projections.map((projection) => projection.localChannelId)
      : [channelId];
    const [updated] = await db.update(channels)
      .set({ archivedAt: null, archivedByUserId: null, archivedByAgentId: null })
      .where(inArray(channels.id, projectionIds))
      .returning();
    return updated ?? channel;
  }

  const [updated] = await db.update(channels)
    .set({ archivedAt: null, archivedByUserId: null, archivedByAgentId: null, guestJoinable })
    .where(eq(channels.id, channelId))
    .returning();
  return updated;
}

/**
 * Source of truth for the archive write-gate. Returns true if the channel
 * exists and is archived. Threads inherit their parent's archived state, so
 * archiving a channel also freezes all of its threads.
 */
export async function isChannelArchived(channelId: string): Promise<boolean> {
  const channel = await getChannel(channelId);
  if (!channel) return false;
  if (channel.archivedAt) return true;
  if (channel.type === "thread") {
    const jointThread = await getJointThreadProjectionByLocalThread(channelId, channel.serverId);
    if (jointThread) {
      return isChannelArchived(jointThread.localParentChannelId);
    }
  }

  if (channel.type === "thread" && channel.parentMessageId) {
    const db = getDb();
    const [parentMsg] = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, channel.parentMessageId));
    if (!parentMsg) return false;
    return isChannelArchived(parentMsg.channelId);
  }
  return false;
}

export class ChannelArchivedError extends Error {
  constructor(public readonly channelId: string) {
    super("Channel is archived");
    this.name = "ChannelArchivedError";
  }
}

export class ArchivedNameCollisionError extends Error {
  constructor(
    public readonly channelName: string,
    public readonly archivedChannelId: string,
    public readonly archivedChannelType: string,
  ) {
    super(`Channel name "${channelName}" is held by an archived channel`);
    this.name = "ArchivedNameCollisionError";
  }
}

/**
 * Throws ChannelArchivedError if the channel (or its parent, for threads) is
 * archived. Call from write-path code to freeze all mutations on archived
 * channels.
 */
export async function assertChannelNotArchived(channelId: string): Promise<void> {
  if (await isChannelArchived(channelId)) {
    throw new ChannelArchivedError(channelId);
  }
}

export async function deleteChannel(channelId: string) {
  const db = getDb();
  const channel = await getChannel(channelId, { includeDeleted: true });

  if (!channel) return;

  // Prevent deletion of the built-in #all channel
  if (isAllSystemChannel(channel)) {
    throw new Error("The #all channel cannot be deleted");
  }

  const now = currentDate();

  // Channel is soft-deleted, so the FK `onDelete: cascade` never fires.
  // If we leave open tasks behind, users see them in the Tasks panel but
  // `PATCH /tasks/:id/status` 404s because `getChannel()` filters by
  // `deletedAt IS NULL`. Auto-close open tasks to the terminal `closed`
  // state so the panel shows them as "🚫 Closed" instead of stuck open.
  // Done/closed tasks are left as-is (already terminal).
  //
  // v1.4: a channel's open tasks can live on either side during the mixed
  // window — legacy `messages.task_*` or the canonical `tasks` table — so both
  // are closed here. Closing only one side would leave the other stuck open in
  // exactly the state this hook exists to prevent.
  await withChannelWriterFence(channelId, async (tx) => {
    await tx.update(messages)
      .set({
        taskStatus: "closed",
        taskCompletedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(messages.channelId, channelId),
        inArray(messages.taskStatus, ["todo", "in_progress", "in_review"]),
      ));

    // `closed_by_*` stays null: the enum is user|agent and this close has no
    // human/agent actor. The actor is recorded on the audit event instead.
    const autoClosed = await tx.update(tasks)
      .set({
        status: "closed",
        completedAt: now,
        closedAt: now,
        revision: sql`${tasks.revision} + 1`,
        updatedAt: now,
      })
      .where(and(
        eq(tasks.channelId, channelId),
        inArray(tasks.status, ["todo", "in_progress", "in_review"]),
      ))
      .returning({ id: tasks.id });

    if (autoClosed.length > 0) {
      await tx.insert(taskEvents).values(autoClosed.map((task) => ({
        taskId: task.id,
        eventType: "closed" as const,
        actorType: "system" as const,
        actorId: null,
        payload: { status: "closed", reason: "channel_deleted", channelId },
      })));
    }

    await tx.update(channels)
      .set({ deletedAt: now })
      .where(eq(channels.id, channelId));
  });
}

/** Payload reason marking an unassign the disconnect caused, not a person choosing. */
export const TASK_UNASSIGN_REASON_JOINT_DISCONNECTED = "joint_channel_disconnected";

/**
 * Clear assignees that no active projection can reach any more.
 *
 * `disconnectJointChannel` used to touch only the projection row and the local
 * channel, never `tasks`. The leaving side's cards fall into the existing
 * membership checks, but a card on the REMAINING side kept rendering "assigned
 * to X" while X had no active projection left to reach it — an identity claim
 * with nothing behind it.
 *
 * Reachability is re-derived with the same predicate `assignTask` uses
 * (`lockTaskAssigneeEligibility` in taskService): the union of members across
 * projections that are still `active`. A cheaper rule — "unassign everyone from
 * the departing server" — would be wrong, because a human is a GLOBAL logical
 * identity: someone who is a member via both the departing projection and a
 * surviving one is still reachable and must keep the task. Agents are
 * server-owned, so an agent on the departing server is not.
 *
 * Must run inside the disconnect transaction and AFTER the projection/channel
 * rows are updated, so it reads post-disconnect truth.
 *
 * `done` is excluded: its assignee is frozen and rewriting it would rewrite
 * history. `closed` is included — it can transition back to `todo`/
 * `in_progress`, so leaving a dangling assignee there only defers the same bug.
 * That matches `writeCanonicalUnclaim`, which also blocks `done` alone.
 */
async function unassignUnreachableJointTasks(
  tx: DatabaseExecutor,
  jointChannelId: string,
  disconnectedByUserId: string,
  now: Date,
) {
  const [joint] = await tx
    .select({ canonicalChannelId: jointChannels.canonicalChannelId })
    .from(jointChannels)
    .where(eq(jointChannels.id, jointChannelId))
    .limit(1);
  if (!joint) return;

  const assigned = await tx
    .select({
      id: tasks.id,
      claimedByType: tasks.claimedByType,
      claimedById: tasks.claimedById,
    })
    .from(tasks)
    .where(and(
      eq(tasks.channelId, joint.canonicalChannelId),
      isNotNull(tasks.claimedById),
      ne(tasks.status, "done"),
    ))
    .for("update");
  if (assigned.length === 0) return;

  const activeProjection = and(
    eq(jointChannelServers.jointChannelId, jointChannelId),
    eq(jointChannelServers.status, "active"),
  );
  const liveLocalChannel = and(
    eq(channels.id, jointChannelServers.localChannelId),
    eq(channels.serverId, jointChannelServers.serverId),
    isNull(channels.deletedAt),
  );

  const reachableUserRows = await tx
    .select({ id: channelHumans.userId })
    .from(jointChannelServers)
    .innerJoin(channelHumans, eq(channelHumans.channelId, jointChannelServers.localChannelId))
    .innerJoin(channels, liveLocalChannel)
    .where(activeProjection);

  const reachableAgentRows = await tx
    .select({ id: channelAgents.agentId })
    .from(jointChannelServers)
    .innerJoin(channelAgents, eq(channelAgents.channelId, jointChannelServers.localChannelId))
    .innerJoin(channels, liveLocalChannel)
    .innerJoin(agents, and(
      eq(agents.id, channelAgents.agentId),
      eq(agents.serverId, jointChannelServers.serverId),
      isNull(agents.deletedAt),
    ))
    .where(activeProjection);

  const reachableUserIds = new Set(reachableUserRows.map((row) => row.id));
  const reachableAgentIds = new Set(reachableAgentRows.map((row) => row.id));

  for (const task of assigned) {
    const assigneeType = task.claimedByType;
    const assigneeId = task.claimedById;
    if (!assigneeType || !assigneeId) continue;
    const stillReachable = assigneeType === "user"
      ? reachableUserIds.has(assigneeId)
      : reachableAgentIds.has(assigneeId);
    if (stillReachable) continue;

    await tx.update(tasks)
      .set({
        claimedByType: null,
        claimedById: null,
        claimedAt: null,
        revision: sql`${tasks.revision} + 1`,
        updatedAt: now,
      })
      .where(eq(tasks.id, task.id));

    // actorType stays "user" with the disconnecting user's id — a person did
    // cause this, and `system` would lose who. `reason` is what separates it
    // from a manual unclaim, so history never reads "they dropped it themselves".
    await tx.insert(taskEvents).values({
      taskId: task.id,
      eventType: "assignee_changed" as const,
      actorType: "user" as const,
      actorId: disconnectedByUserId,
      payload: {
        assigneeType: null,
        assigneeId: null,
        previousAssigneeType: assigneeType,
        previousAssigneeId: assigneeId,
        reason: TASK_UNASSIGN_REASON_JOINT_DISCONNECTED,
      },
    });
  }
}

export async function disconnectJointChannel(channelId: string, disconnectedByUserId: string) {
  const db = getDb();
  const channel = await getChannel(channelId);
  if (!channel) throw new Error("Channel not found");
  if (channel.type !== "joint") throw new Error("Only joint channels can be disconnected");

  const now = currentDate();
  await db.transaction(async (tx) => {
    const [projection] = await tx
      .select({ jointChannelId: jointChannelServers.jointChannelId })
      .from(jointChannelServers)
      .where(and(
        eq(jointChannelServers.localChannelId, channelId),
        eq(jointChannelServers.status, "active"),
      ));
    if (!projection) throw new Error("Joint channel not found");

    await tx.update(jointChannelServers)
      .set({
        status: "disconnected",
        disconnectedByUserId,
        disconnectedAt: now,
      })
      .where(and(
        eq(jointChannelServers.jointChannelId, projection.jointChannelId),
        eq(jointChannelServers.localChannelId, channelId),
      ));

    await tx.update(channels)
      .set({ deletedAt: now })
      .where(eq(channels.id, channelId));

    // Settle assignees the disconnect just made unreachable. This must run
    // AFTER the two updates above and inside the same transaction: it re-derives
    // reachability from the projections that are still active, so it depends on
    // this projection already being 'disconnected' and its local channel already
    // soft-deleted. Eager, not lazy-at-read — a stale assignee must never be
    // observable, and read-time settlement would need every reader to remember.
    await unassignUnreachableJointTasks(tx, projection.jointChannelId, disconnectedByUserId, now);
    // A free participant leaving can bring the joint back within the cap.
    await reconcileJointOverLimitFor(tx, projection.jointChannelId, now);
  });
}

async function deletePrivateChannelIfEmpty(channelId: string, db: DatabaseExecutor = getDb()) {
  const [channel] = await db
    .select({ type: channels.type, deletedAt: channels.deletedAt })
    .from(channels)
    .where(eq(channels.id, channelId));
  if (!channel || channel.type !== "private" || channel.deletedAt) return;

  const result = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM channel_humans WHERE channel_id = ${channelId}) AS "humanCount",
      (SELECT count(*)::int FROM channel_agents WHERE channel_id = ${channelId}) AS "agentCount"
  `);
  const [row] = result.rows as Array<{ humanCount?: number; agentCount?: number }>;
  const humanCount = row?.humanCount ?? 0;
  const agentCount = row?.agentCount ?? 0;
  if (humanCount + agentCount > 0) return;

  await db.update(channels)
    .set({ deletedAt: currentDate() })
    .where(and(eq(channels.id, channelId), eq(channels.type, "private"), isNull(channels.deletedAt)));
}

/**
 * Where a conversation's messages are stored, resolved on the caller's executor: a join
 * runs inside the membership transaction, which must see its own uncommitted rows and
 * must not wait on a second connection.
 */
export async function getMessageStorageChannelIdWithExecutor(executor: DatabaseExecutor, channelId: string): Promise<string> {
  const [channel] = await executor
    .select({ type: channels.type, serverId: channels.serverId })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  if (!channel) return channelId;
  if (channel.type === "thread") {
    const jointThread = await getJointThreadProjectionByLocalThread(channelId, channel.serverId, executor);
    return jointThread?.canonicalThreadChannelId ?? channelId;
  }
  if (channel.type !== "joint") return channelId;
  const [projection] = await executor
    .select({ canonicalChannelId: jointChannels.canonicalChannelId })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(
      eq(jointChannelServers.localChannelId, channelId),
      eq(jointChannelServers.serverId, channel.serverId),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
    ))
    .limit(1);
  return projection?.canonicalChannelId ?? channelId;
}

/**
 * A member's read position starts where they joined: everything already in the
 * conversation is read, for humans and agents alike, so "unread" is only ever
 * `seq > cursor`. Runs in the membership write's transaction. `throughSeq` defaults
 * to the conversation's latest message; a join caused by a message that must itself
 * stay unread (a mention or reply that auto-follows) passes the seq before it.
 */
export async function startReadPositionAtJoin(
  executor: DatabaseExecutor,
  principalKind: "human" | "agent",
  principalId: string,
  channelId: string,
  throughSeq?: number,
): Promise<void> {
  let seq = throughSeq;
  if (seq === undefined) {
    const storageChannelId = await getMessageStorageChannelIdWithExecutor(executor, channelId);
    const [latest] = await executor
      .select({ seq: sql<number>`COALESCE(MAX(${messages.seq}), 0)::int` })
      .from(messages)
      .where(eq(messages.channelId, storageChannelId));
    seq = latest?.seq ?? 0;
  }
  await raiseReadPositionForJoin(executor, principalKind, principalId, channelId, seq);
}

export async function addAgent(channelId: string, agentId: string, options: ChannelServiceOptions & { role?: "member" | "admin" } = {}): Promise<boolean> {
  if (!options.executor) {
    return withChannelWriterFence(channelId, async (tx) => {
      if (options.actionCardMessageId) {
        await assertActionCardWritableInTransaction(tx, options.actionCardMessageId, options.actionCardConfirmationVersion);
      }
      return addAgent(channelId, agentId, { ...options, executor: tx });
    });
  }
  const db = options.executor ?? getDb();
  await assertChannelWritableInTransaction(db, channelId);
  if (options.actionCardMessageId) {
    await assertActionCardWritableInTransaction(db, options.actionCardMessageId, options.actionCardConfirmationVersion);
  }
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)));
  if (!channel) {
    throw new Error("Channel not found");
  }
  if (channel?.type === "thread") {
    throw new Error("Thread membership is managed via follow/unfollow, not channel_agents");
  }
  const [agent] = await db
    .select({ serverId: agents.serverId })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!agent || agent.serverId !== channel.serverId) {
    throw new Error("Agent is not a member of this channel's server");
  }
  if (isAllSystemChannel(channel)) {
    return false;
  }
  const inserted = await db
    .insert(channelAgents)
    .values({ channelId, agentId, role: options.role ?? "member" })
    .onConflictDoNothing()
    .returning({ agentId: channelAgents.agentId });
  if (inserted.length > 0) await startReadPositionAtJoin(db, "agent", agentId, channelId);
  return inserted.length > 0;
}

export async function removeAgent(channelId: string, agentId: string, executor?: DatabaseExecutor): Promise<void> {
  if (!executor) return withChannelWriterFence(channelId, tx => removeAgent(channelId, agentId, tx));
  await assertChannelWritableInTransaction(executor, channelId);
  const db = executor ?? getDb();
  const channel = await getChannel(channelId, { executor: db });
  if (channel?.type === "thread") {
    throw new Error("Thread membership is managed via follow/unfollow, not channel_agents");
  }
  // Protect #all channel
  if (channel && isAllSystemChannel(channel)) {
    throw new Error("Cannot remove members from the #all channel");
  }
  await db.delete(channelAgents).where(
    and(eq(channelAgents.channelId, channelId), eq(channelAgents.agentId, agentId))
  );
  await deletePrivateChannelIfEmpty(channelId, db);
}

async function getChannelAgentsRaw(channelId: string) {
  return (await getChannelAgentsRawForChannels([channelId])).map(({ channelId: _channelId, ...agent }) => agent);
}

/** getChannelAgentsRaw for several channels in one query; rows carry their channelId. */
async function getChannelAgentsRawForChannels(channelIds: readonly string[], options: { name?: string; id?: string } = {}) {
  if (channelIds.length === 0) return [];
  const db = getDb();
  return db
    .select({
      channelId: channelAgents.channelId,
      id: agents.id,
      serverId: agents.serverId,
      serverName: servers.name,
      serverSlug: servers.slug,
      name: agents.name,
      displayName: agents.displayName,
      status: agents.status,
      avatarUrl: agents.avatarUrl,
      channelRole: channelAgents.role,
      serverRole: serverAgentMembers.role,
    })
    .from(channelAgents)
    .innerJoin(agents, eq(channelAgents.agentId, agents.id))
    .innerJoin(servers, eq(servers.id, agents.serverId))
    // Channel membership is the audience authority here. Keep the server-role
    // projection additive: legacy/test rows can predate server_agent_members
    // and must not disappear from delivery merely because role metadata is
    // absent.
    .leftJoin(serverAgentMembers, and(
      eq(serverAgentMembers.serverId, agents.serverId),
      eq(serverAgentMembers.agentId, agents.id),
    ))
    .where(and(
      inArray(channelAgents.channelId, [...channelIds]),
      isNull(agents.deletedAt),
      options.name === undefined ? undefined : eq(agents.name, options.name),
      options.id === undefined ? undefined : eq(agents.id, options.id),
    ))
    .orderBy(asc(channelAgents.addedAt));
}

/**
 * The full agent audience of a server. This is the effective agent membership
 * of an enabled virtual `#all` channel: in the pre-virtualization model every
 * active agent had a real `channel_agents` row in `#all`, so the audience is
 * every active (non-deleted) agent on the server.
 */
async function getServerAudienceAgents(serverId: string, options: { name?: string } = {}) {
  const db = getDb();
  return db
    .select({
      id: agents.id,
      serverId: agents.serverId,
      serverName: servers.name,
      serverSlug: servers.slug,
      name: agents.name,
      displayName: agents.displayName,
      status: agents.status,
      avatarUrl: agents.avatarUrl,
    })
    .from(agents)
    .innerJoin(servers, eq(servers.id, agents.serverId))
    .where(and(
      eq(agents.serverId, serverId),
      isNull(agents.deletedAt),
      options.name === undefined ? undefined : eq(agents.name, options.name),
    ))
    .orderBy(asc(agents.createdAt));
}

/**
 * Agent membership of a channel. For an enabled virtual `#all` channel this is
 * the whole server agent audience (single source of truth shared with
 * getChannelMembers / getVirtualAllChannelMembers), so message delivery, agent
 * wake/system messages, push/unread, and the member-list API all match the
 * pre-virtualization behavior. All other channels read their explicit
 * `channel_agents` rows.
 */
export async function getChannelAgents(channelId: string) {
  const channel = await getChannel(channelId);
  if (channel && isEnabledAllChannel(channel)) {
    return getServerAudienceAgents(channel.serverId);
  }
  return getChannelAgentsRaw(channelId);
}

export async function getAgentChannels(agentId: string, viewerUserId: string) {
  const db = getDb();
  const viewerMembership = alias(channelHumans, "viewer_agent_channel_membership");
  const rows = await db
    .select({
      id: channels.id,
      name: channels.name,
      description: channels.description,
      type: channels.type,
      createdAt: channels.createdAt,
      archivedAt: channels.archivedAt,
    })
    .from(channelAgents)
    .innerJoin(channels, eq(channelAgents.channelId, channels.id))
    .leftJoin(viewerMembership, and(
      eq(viewerMembership.channelId, channels.id),
      eq(viewerMembership.userId, viewerUserId),
    ))
    .where(
      and(
        eq(channelAgents.agentId, agentId),
        inArray(channels.type, LISTABLE_CHANNEL_TYPES),
        or(
          eq(channels.type, "channel"),
          isNotNull(viewerMembership.userId),
        ),
        isNull(channels.deletedAt)
      )
    )
    .orderBy(asc(channels.name));
  return attachActivityMuteState(rows, "agent", agentId);
}

export async function listChannelsForAgent(serverId: string, agentId: string) {
  const db = getDb();
  const memberships = await db
    .select({
      channelId: channelAgents.channelId,
      role: channelAgents.role,
      authorityRevision: channelAgents.authorityRevision,
    })
    .from(channelAgents)
    .where(eq(channelAgents.agentId, agentId));
  const joinedSet = new Set(memberships.map((m) => m.channelId));
  const membershipByChannel = new Map(memberships.map((membership) => [membership.channelId, membership]));
  const [agentServerMembership] = await db.select({ role: serverAgentMembers.role })
    .from(serverAgentMembers)
    .where(and(eq(serverAgentMembers.serverId, serverId), eq(serverAgentMembers.agentId, agentId)));
  const list = await db
    .select()
    .from(channels)
    .where(and(
      eq(channels.serverId, serverId),
      inArray(channels.type, LISTABLE_CHANNEL_TYPES),
      isNull(channels.deletedAt),
      isNull(channels.archivedAt),
    ))
    .orderBy(asc(channels.createdAt));

  const visibleChannels = list
    .filter((ch) => !requiresExplicitMembership(ch.type) || joinedSet.has(ch.id))
    .map((ch) => {
      const membership = membershipByChannel.get(ch.id);
      const joined = isEnabledAllChannel(ch) || Boolean(membership);
      const supportsChannelRoles = (ch.type === "channel" || ch.type === "private") && !isAllSystemChannel(ch);
      return {
        ...ch,
        joined,
        channelRole: membership?.role ?? null,
        channelAuthorityRevision: membership?.authorityRevision ?? null,
        channelAdminBasis: getChannelAdminBasis({
          serverRole: agentServerMembership?.role ?? null,
          channelRole: membership?.role ?? null,
          isChannelMember: Boolean(membership),
          supportsChannelRoles,
        }),
        channelCapabilities: Object.fromEntries(CHANNEL_MANAGEMENT_CAPABILITIES.map((capability) => [
          capability,
          capability === "addChannelMembers"
            ? canAddChannelMembers({
                serverRole: agentServerMembership?.role ?? null,
                admissionClass: "current_member",
                isChannelMember: Boolean(membership),
                channelType: ch.type,
                channelName: ch.name,
                archived: ch.archivedAt !== null,
                deleted: ch.deletedAt !== null,
              })
            : hasEffectiveChannelCapability({
                serverRole: agentServerMembership?.role ?? null,
                channelRole: membership?.role ?? null,
                isChannelMember: Boolean(membership),
                supportsChannelRoles,
                capability,
              }),
        ])),
      };
    });
  // v1 built-in app conversations are intentionally not ordinary DMs: they
  // have one agent member and no dm_channel_identities row. Admit only the
  // exact registry-derived rows for this authenticated agent. This keeps
  // arbitrary DMs and test-catalog app names out of the channel directory and
  // writable target surface.
  const installedApps = await listInstalledRapApps(serverId);
  const builtInDmChannels = (await Promise.all(installedApps.map((app) =>
    getBuiltInConversationChannel(serverId, app.appId, agentId)
  )))
    .filter((channel): channel is NonNullable<typeof channel> => channel !== null)
    .map((channel) => ({ ...channel, joined: true }));
  const visibleWithMuteState = await attachActivityMuteState(visibleChannels, "agent", agentId);
  const builtInDmWithoutMuteSurface = builtInDmChannels.map((channel) => ({
    ...channel,
    activityMuted: false,
    muteFromSeq: null,
    prefsVersion: 0,
    activityMuteSupported: false,
  }));
  return [...visibleWithMuteState, ...builtInDmWithoutMuteSurface]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

// DM support — unified peer model for both agent-DMs and user-DMs

/** Peer info returned for DMs (agent or user) */
export interface DMPeer {
  peerType: "agent" | "user";
  peerId: string;
  peerName: string;
  peerDisplayName: string | null;
  peerDescription: string | null;
  peerGravatarHash: string | null;
  peerAvatarUrl: string | null;
}

/** DM channel with peer info */
export type DMChannel = {
  id: string;
  name: string;
  type: string;
  description: string | null;
  createdAt: Date;
  lastMessageAt?: Date | null;
  lastMessagePreview?: string | null;
  lastMessageSenderName?: string | null;
  activityMuted?: boolean;
  muteFromSeq?: number | null;
  prefsVersion?: number;
  activityMuteSupported?: boolean;
  maxReadSeq?: number;
  readStateVersion?: number;
} & DMPeer;

interface DMChannelListOptions {
  traceQuery?: DbQueryTracer;
  humanActivityMuteEnabled?: boolean;
}

/**
 * Select a DM channel with its peer info (agent-DM).
 */
async function selectDMWithAgentPeer(channelId: string): Promise<DMChannel | null> {
  const db = getDb();
  const [result] = await db
    .select({
      id: channels.id,
      name: channels.name,
      type: channels.type,
      description: channels.description,
      createdAt: channels.createdAt,
      peerId: agents.id,
      peerName: agents.name,
      peerDisplayName: agents.displayName,
      peerDescription: agents.description,
      peerGravatarHash: sql<string | null>`null`,
      peerAvatarUrl: agents.avatarUrl,
    })
    .from(channels)
    .innerJoin(channelAgents, eq(channels.id, channelAgents.channelId))
    .innerJoin(agents, eq(channelAgents.agentId, agents.id))
    .where(and(eq(channels.id, channelId), isNull(agents.deletedAt)));
  if (!result) return null;
  return { ...result, peerType: "agent" as const };
}

/**
 * Select a human-readable DM detail row for a participant. Unlike the normal DM
 * list this preserves soft-deleted agent peers so historical search/permalink
 * navigation can still open the conversation without resurrecting it in the
 * sidebar DM list.
 */
export async function getReadableDMChannelForUser(channelId: string, currentUserId: string): Promise<DMChannel | null> {
  const db = getDb();
  const [agentPeer] = await db
    .select({
      id: channels.id,
      name: channels.name,
      type: channels.type,
      description: channels.description,
      createdAt: channels.createdAt,
      peerId: channelAgents.agentId,
      peerName: sql<string>`COALESCE(${agents.name}, ${channels.name}, 'Agent')`,
      peerDisplayName: agents.displayName,
      peerDescription: agents.description,
      peerGravatarHash: sql<string | null>`null`,
      peerAvatarUrl: agents.avatarUrl,
    })
    .from(channels)
    .innerJoin(channelAgents, eq(channels.id, channelAgents.channelId))
    .leftJoin(agents, eq(channelAgents.agentId, agents.id))
    .innerJoin(channelHumans, and(
      eq(channels.id, channelHumans.channelId),
      eq(channelHumans.userId, currentUserId),
    ))
    .where(and(eq(channels.id, channelId), eq(channels.type, "dm")));
  if (agentPeer) return { ...agentPeer, peerType: "agent" as const };

  // Once mutable agent membership is gone, current membership shape is not
  // provenance: a deleted human-agent DM and a self-DM both look like one
  // human and zero agents. Only the durable identity may classify the row.
  const [identity] = await db
    .select({
      kind: dmChannelIdentities.kind,
      peerKey: dmChannelIdentities.peerKey,
    })
    .from(dmChannelIdentities)
    .innerJoin(channels, and(
      eq(channels.id, dmChannelIdentities.channelId),
      eq(channels.serverId, dmChannelIdentities.serverId),
    ))
    .innerJoin(channelHumans, and(
      eq(channels.id, channelHumans.channelId),
      eq(channelHumans.userId, currentUserId),
    ))
    .where(and(eq(channels.id, channelId), eq(channels.type, "dm")));
  if (!identity) return null;

  const participantIds = identity.peerKey.split(":");
  if (!participantIds.includes(currentUserId)) return null;
  if (identity.kind === "human_self") {
    return participantIds.length === 1 && participantIds[0] === currentUserId
      ? selectDMWithUserPeer(channelId, currentUserId, currentUserId)
      : null;
  }
  if (identity.kind === "human_human") {
    const peerUserId = participantIds.find((id) => id !== currentUserId);
    return participantIds.length === 2 && peerUserId
      ? selectDMWithUserPeer(channelId, currentUserId, peerUserId)
      : null;
  }
  if (identity.kind !== "human_agent" || participantIds.length !== 2) return null;

  const agentId = participantIds.find((id) => id !== currentUserId);
  if (!agentId) return null;
  const [deletedAgentPeer] = await db
    .select({
      id: channels.id,
      name: channels.name,
      type: channels.type,
      description: channels.description,
      createdAt: channels.createdAt,
      peerId: agents.id,
      peerName: agents.name,
      peerDisplayName: agents.displayName,
      peerDescription: agents.description,
      peerGravatarHash: sql<string | null>`null`,
      peerAvatarUrl: agents.avatarUrl,
    })
    .from(channels)
    .innerJoin(agents, and(eq(agents.id, agentId), eq(agents.serverId, channels.serverId)))
    .where(and(eq(channels.id, channelId), eq(channels.type, "dm")));
  return deletedAgentPeer ? { ...deletedAgentPeer, peerType: "agent" as const } : null;
}

/**
 * Select a DM channel with its peer info (user-DM, peer = the other user).
 */
async function selectDMWithUserPeer(
  channelId: string,
  currentUserId: string,
  identityPeerId?: string,
): Promise<DMChannel | null> {
  const db = getDb();

  // Direct-read callers pass the durable identity peer. Find/create callers
  // have just established exact membership and may resolve from that shape.
  let otherUserId = identityPeerId;
  if (!otherUserId) {
    const allHumans = await db
      .select({ userId: channelHumans.userId })
      .from(channelHumans)
      .where(eq(channelHumans.channelId, channelId));
    otherUserId = allHumans.find(h => h.userId !== currentUserId)?.userId ?? currentUserId;
  }
  if (!otherUserId) return null;

  const [peer] = await db
    .select({ id: users.id, name: users.name, displayName: users.displayName, description: users.description, email: users.email, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, otherUserId));
  if (!peer) return null;

  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!ch) return null;

  return {
    id: ch.id,
    name: ch.name,
    type: ch.type,
    description: ch.description,
    createdAt: ch.createdAt,
    peerType: "user",
    peerId: peer.id,
    peerName: peer.name,
    peerDisplayName: peer.displayName,
    peerDescription: peer.description,
    peerAvatarUrl: peer.avatarUrl,
    peerGravatarHash: createHash("sha256").update(peer.email.trim().toLowerCase()).digest("hex"),
  };
}

/**
 * Find or create a DM channel between a user and an agent.
 * Returns unified peer format.
 */
export async function findOrCreateDM(serverId: string, userId: string, agentId: string): Promise<DMChannel | null> {
  const identityKind: DmIdentityKind = "human_agent";
  const identityKey = dmIdentityKey([userId, agentId]);
  const dmChannelId = await withServerResourceLock(
    serverId,
    DM_LOCK_NAMESPACE,
    dmPairKey("human-agent", [userId, agentId]),
    async (tx) => {
      const [agent] = await tx
        .select({ id: agents.id, name: agents.name, displayName: agents.displayName })
        .from(agents)
        .where(and(
          eq(agents.id, agentId),
          eq(agents.serverId, serverId),
          isNull(agents.deletedAt),
        ));
      if (!agent) return null;

      const [identified] = await tx
        .select({ id: channels.id, deletedAt: channels.deletedAt })
        .from(dmChannelIdentities)
        .innerJoin(channels, eq(channels.id, dmChannelIdentities.channelId))
        .where(and(
          eq(dmChannelIdentities.serverId, serverId),
          eq(channels.type, "dm"),
          eq(dmChannelIdentities.kind, identityKind),
          eq(dmChannelIdentities.peerKey, identityKey),
        ))
        .orderBy(sql`${channels.deletedAt} ASC NULLS FIRST`, asc(channels.createdAt), asc(channels.id))
        .limit(1);

      if (identified) {
        if (identified.deletedAt) {
          await tx.update(channels).set({ deletedAt: null }).where(eq(channels.id, identified.id));
        }
        return identified.id;
      }

      // Legacy fallback: while both membership rows still exist, the exact
      // one-human/one-agent shape is sufficient to adopt and stamp. Once an
      // agent deletion removes channel_agents this path can no longer match,
      // which prevents the tombstone from being reclassified as a self-DM.
      const [existing] = await tx
        .select({ id: channels.id, deletedAt: channels.deletedAt })
        .from(channels)
        .innerJoin(channelAgents, eq(channels.id, channelAgents.channelId))
        .innerJoin(channelHumans, eq(channels.id, channelHumans.channelId))
        .where(and(
          eq(channels.serverId, serverId),
          eq(channels.type, "dm"),
          eq(channelAgents.agentId, agentId),
          eq(channelHumans.userId, userId),
          sql`(SELECT count(*) FROM channel_humans WHERE channel_id = ${channels.id}) = 1`,
          sql`(SELECT count(*) FROM channel_agents WHERE channel_id = ${channels.id}) = 1`,
        ));

      if (existing) {
        await tx.insert(dmChannelIdentities).values({
          channelId: existing.id,
          serverId,
          kind: identityKind,
          peerKey: identityKey,
        });
        await tx.update(channels).set({ deletedAt: null }).where(eq(channels.id, existing.id));
        return existing.id;
      }

      // DM channel name = unique name (identity); display name resolved at read time.
      const dmName = agent.name || "Agent";
      const [dmChannel] = await tx.insert(channels).values({
        serverId,
        name: dmName,
        type: "dm",
      }).returning();

      await tx.insert(dmChannelIdentities).values({
        channelId: dmChannel.id,
        serverId,
        kind: identityKind,
        peerKey: identityKey,
      });
      // read-position: new conversation, no history before this join (no row = position 0)
      await tx.insert(channelAgents).values({ channelId: dmChannel.id, agentId });
      await tx.insert(channelHumans).values({ channelId: dmChannel.id, userId });
      return dmChannel.id;
    },
  );

  return dmChannelId ? selectDMWithAgentPeer(dmChannelId) : null;
}

/**
 * Find or create a DM channel between two users (human-to-human DM).
 * Returns unified peer format (peer = the other user).
 */
export async function findOrCreateUserDM(
  serverId: string,
  userId1: string,
  userId2: string,
  opts: { hidePassivePeerOnCreate?: boolean } = {},
): Promise<DMChannel | null> {
  const isSelf = userId1 === userId2;

  if (isSelf) {
    const identityKind: DmIdentityKind = "human_self";
    const identityKey = dmIdentityKey([userId1]);
    const dmChannelId = await withServerResourceLock(
      serverId,
      DM_LOCK_NAMESPACE,
      dmPairKey("user-user", [userId1]),
      async (tx) => {
        // Self-DM lookup is deliberately provenance-only. A legacy singleton
        // membership shape is ambiguous because deleting an agent leaves its
        // human-agent DM with exactly one human and no channel_agents row.
        const [existing] = await tx
          .select({ id: channels.id, deletedAt: channels.deletedAt })
          .from(dmChannelIdentities)
          .innerJoin(channels, eq(channels.id, dmChannelIdentities.channelId))
          .where(and(
            eq(dmChannelIdentities.serverId, serverId),
            eq(channels.type, "dm"),
            eq(dmChannelIdentities.kind, identityKind),
            eq(dmChannelIdentities.peerKey, identityKey),
          ))
          .orderBy(sql`${channels.deletedAt} ASC NULLS FIRST`, asc(channels.createdAt), asc(channels.id))
          .limit(1);

        if (existing) {
          if (existing.deletedAt) {
            await tx.update(channels).set({ deletedAt: null }).where(eq(channels.id, existing.id));
          }
          return existing.id;
        }

        const [selfUser] = await tx.select({ name: users.name }).from(users).where(eq(users.id, userId1));
        const [dmChannel] = await tx.insert(channels).values({
          serverId,
          name: selfUser?.name || "User",
          type: "dm",
        }).returning();

        await tx.insert(dmChannelIdentities).values({
          channelId: dmChannel.id,
          serverId,
          kind: identityKind,
          peerKey: identityKey,
        });
        // read-position: new conversation, no history before this join (no row = position 0)
        await tx.insert(channelHumans).values({ channelId: dmChannel.id, userId: userId1 });
        return dmChannel.id;
      },
    );
    return selectDMWithUserPeer(dmChannelId, userId1);
  }

  const identityKind: DmIdentityKind = "human_human";
  const identityKey = dmIdentityKey([userId1, userId2]);
  const dmChannelId = await withServerResourceLock(
    serverId,
    DM_LOCK_NAMESPACE,
    dmPairKey("user-user", [userId1, userId2]),
    async (tx) => {
      const cm2 = alias(channelHumans, "cm2");

      const [identified] = await tx
        .select({ id: channels.id, deletedAt: channels.deletedAt })
        .from(dmChannelIdentities)
        .innerJoin(channels, eq(channels.id, dmChannelIdentities.channelId))
        .where(and(
          eq(dmChannelIdentities.serverId, serverId),
          eq(channels.type, "dm"),
          eq(dmChannelIdentities.kind, identityKind),
          eq(dmChannelIdentities.peerKey, identityKey),
        ))
        .orderBy(sql`${channels.deletedAt} ASC NULLS FIRST`, asc(channels.createdAt), asc(channels.id))
        .limit(1);

      if (identified) {
        if (identified.deletedAt) {
          await tx.update(channels).set({ deletedAt: null }).where(eq(channels.id, identified.id));
        }
        return identified.id;
      }

      // Legacy exact-shape fallback, stamped on first safe reuse.
      const existing = await tx
        .select({ id: channels.id, deletedAt: channels.deletedAt })
        .from(channels)
        .innerJoin(channelHumans, and(eq(channels.id, channelHumans.channelId), eq(channelHumans.userId, userId1)))
        .innerJoin(cm2, and(eq(channels.id, cm2.channelId), eq(cm2.userId, userId2)))
        .leftJoin(channelAgents, eq(channels.id, channelAgents.channelId))
        .where(and(
          eq(channels.serverId, serverId),
          eq(channels.type, "dm"),
          isNull(channelAgents.agentId), // No agent = user-DM
          sql`(SELECT count(*) FROM channel_humans WHERE channel_id = ${channels.id}) = 2`,
        ));

      if (existing.length > 0) {
        const dm = existing[0];
        await tx.insert(dmChannelIdentities).values({
          channelId: dm.id,
          serverId,
          kind: identityKind,
          peerKey: identityKey,
        });
        await tx.update(channels).set({ deletedAt: null }).where(eq(channels.id, dm.id));
        return dm.id;
      }

      // DM channel name = unique name (identity); display name resolved at read time.
      const [otherUser] = await tx
        .select({ name: users.name, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, userId2));
      const dmName = otherUser?.name || "User";
      const [dmChannel] = await tx.insert(channels).values({
        serverId,
        name: dmName,
        type: "dm",
      }).returning();

      await tx.insert(dmChannelIdentities).values({
        channelId: dmChannel.id,
        serverId,
        kind: identityKind,
        peerKey: identityKey,
      });
      // read-position: new conversation, no history before this join (no row = position 0)
      await tx.insert(channelHumans).values([
        { channelId: dmChannel.id, userId: userId1 },
        { channelId: dmChannel.id, userId: userId2 },
      ]);

      if (opts.hidePassivePeerOnCreate) {
        await tx
          .update(serverMembers)
          .set({
            hiddenDmIds: sql`(
              SELECT COALESCE(json_agg(id), '[]'::json)
              FROM (
                SELECT id
                FROM json_array_elements_text(COALESCE(${serverMembers.hiddenDmIds}, '[]'::json)) existing(id)
                UNION
                SELECT ${dmChannel.id}
              ) merged
            )`,
          })
          .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId2)));
      }

      return dmChannel.id;
    },
  );

  return selectDMWithUserPeer(dmChannelId, userId1);
}

/**
 * Find or create a DM channel between two agents (agent-to-agent DM).
 * Both agents are stored in channelAgents; no human membership is written.
 */
export async function findOrCreateAgentDM(serverId: string, agentId1: string, agentId2: string): Promise<DMChannel | null> {
  if (agentId1 === agentId2) {
    throw new Error("Cannot create a DM with yourself");
  }

  const identityKind: DmIdentityKind = "agent_agent";
  const identityKey = dmIdentityKey([agentId1, agentId2]);
  const dmChannelId = await withServerResourceLock(
    serverId,
    DM_LOCK_NAMESPACE,
    dmPairKey("agent-agent", [agentId1, agentId2]),
    async (tx) => {
      const [agent2] = await tx
        .select({ id: agents.id, name: agents.name, displayName: agents.displayName, avatarUrl: agents.avatarUrl })
        .from(agents)
        .where(and(eq(agents.id, agentId2), eq(agents.serverId, serverId), isNull(agents.deletedAt)));
      if (!agent2) return null;

      const ca2 = alias(channelAgents, "ca2");

      const [identified] = await tx
        .select({ id: channels.id, deletedAt: channels.deletedAt })
        .from(dmChannelIdentities)
        .innerJoin(channels, eq(channels.id, dmChannelIdentities.channelId))
        .where(and(
          eq(dmChannelIdentities.serverId, serverId),
          eq(channels.type, "dm"),
          eq(dmChannelIdentities.kind, identityKind),
          eq(dmChannelIdentities.peerKey, identityKey),
        ))
        .orderBy(sql`${channels.deletedAt} ASC NULLS FIRST`, asc(channels.createdAt), asc(channels.id))
        .limit(1);

      if (identified) {
        if (identified.deletedAt) {
          await tx.update(channels).set({ deletedAt: null }).where(eq(channels.id, identified.id));
        }
        return identified.id;
      }

      const existing = await tx
        .select({ id: channels.id, deletedAt: channels.deletedAt })
        .from(channels)
        .innerJoin(channelAgents, and(eq(channels.id, channelAgents.channelId), eq(channelAgents.agentId, agentId1)))
        .innerJoin(ca2, and(eq(channels.id, ca2.channelId), eq(ca2.agentId, agentId2)))
        .leftJoin(channelHumans, eq(channels.id, channelHumans.channelId))
        .where(and(
          eq(channels.serverId, serverId),
          eq(channels.type, "dm"),
          isNull(channelHumans.userId),
          sql`(SELECT count(*) FROM channel_agents WHERE channel_id = ${channels.id}) = 2`,
        ));

      if (existing.length > 0) {
        const dm = existing[0];
        await tx.insert(dmChannelIdentities).values({
          channelId: dm.id,
          serverId,
          kind: identityKind,
          peerKey: identityKey,
        });
        await tx.update(channels).set({ deletedAt: null }).where(eq(channels.id, dm.id));
        return dm.id;
      }

      const dmName = agent2.name || "Agent";
      const [dmChannel] = await tx.insert(channels).values({
        serverId,
        name: dmName,
        type: "dm",
      }).returning();

      await tx.insert(dmChannelIdentities).values({
        channelId: dmChannel.id,
        serverId,
        kind: identityKind,
        peerKey: identityKey,
      });
      // read-position: new conversation, no history before this join (no row = position 0)
      await tx.insert(channelAgents).values([
        { channelId: dmChannel.id, agentId: agentId1 },
        { channelId: dmChannel.id, agentId: agentId2 },
      ]);

      return dmChannel.id;
    },
  );

  return dmChannelId ? selectDMWithAgentPeer(dmChannelId) : null;
}

/**
 * List all DM channels for a user — both agent-DMs and user-DMs.
 * Returns unified peer format.
 */
export async function listDMChannels(
  serverId: string,
  userId: string,
  opts?: DMChannelListOptions,
): Promise<DMChannel[]> {
  const db = getDb();
  const traceQuery = opts?.traceQuery ?? untracedDbQuery;
  const serverRole = await resolveHumanServerRole(serverId, userId);
  if (serverRole === "guest" && !await isGuestFeatureEnabled(serverId, userId)) return [];

  // Query 1: Agent-DMs (channel has entry in channelAgents)
  const agentDMs = await traceQuery(
    "dm_channels.agent_dms_by_user",
    () => db
      .select({
        id: channels.id,
        name: channels.name,
        type: channels.type,
        description: channels.description,
        createdAt: channels.createdAt,
        peerId: agents.id,
        peerName: agents.name,
        peerDisplayName: agents.displayName,
        peerDescription: agents.description,
        peerGravatarHash: sql<string | null>`null`,
        peerAvatarUrl: agents.avatarUrl,
      })
      .from(channels)
      .innerJoin(channelAgents, eq(channels.id, channelAgents.channelId))
      .innerJoin(agents, eq(channelAgents.agentId, agents.id))
      .innerJoin(channelHumans, eq(channels.id, channelHumans.channelId))
      .where(and(
        eq(channels.serverId, serverId),
        eq(channels.type, "dm"),
        eq(channelHumans.userId, userId),
        isNull(channels.deletedAt),
        isNull(agents.deletedAt),
      )),
  );

  // Query 2: User-DMs (channel has NO entry in channelAgents, peer = other user)
  const otherHuman = alias(channelHumans, "other_human");
  const userDMRows = await traceQuery(
    "dm_channels.user_dms_by_user",
    () => db
      .select({
        id: channels.id,
        name: channels.name,
        type: channels.type,
        description: channels.description,
        createdAt: channels.createdAt,
        peerId: users.id,
        peerName: users.name,
        peerDisplayName: users.displayName,
        peerDescription: users.description,
        peerEmail: users.email,
        peerAvatarUrl: users.avatarUrl,
      })
      .from(channels)
      .innerJoin(channelHumans, and(eq(channels.id, channelHumans.channelId), eq(channelHumans.userId, userId)))
      .innerJoin(otherHuman, and(eq(channels.id, otherHuman.channelId)))
      .innerJoin(users, eq(otherHuman.userId, users.id))
      .leftJoin(channelAgents, eq(channels.id, channelAgents.channelId))
      .where(and(
        eq(channels.serverId, serverId),
        eq(channels.type, "dm"),
        isNull(channels.deletedAt),
        isNull(channelAgents.agentId), // No agent = user-DM
        // other_human must not be current user
      )),
  );
  const userDMs = userDMRows
    .filter(r => r.peerId !== userId)
    .map(({ peerEmail, ...row }) => ({
      ...row,
      peerGravatarHash: createHash("sha256").update(peerEmail.trim().toLowerCase()).digest("hex"),
    }));

  // Query 3: Self-DMs. Mutable membership shape is ambiguous after agent
  // deletion, so explicit human_self provenance is the load-bearing filter.
  const selfDMRows = await traceQuery(
    "dm_channels.self_dms_by_user",
    () => db
      .select({
        id: channels.id,
        name: channels.name,
        type: channels.type,
        description: channels.description,
        createdAt: channels.createdAt,
        peerId: users.id,
        peerName: users.name,
        peerDisplayName: users.displayName,
        peerDescription: users.description,
        peerEmail: users.email,
        peerAvatarUrl: users.avatarUrl,
      })
      .from(channels)
      .innerJoin(dmChannelIdentities, and(
        eq(channels.id, dmChannelIdentities.channelId),
        eq(dmChannelIdentities.serverId, serverId),
        eq(dmChannelIdentities.kind, "human_self"),
        eq(dmChannelIdentities.peerKey, userId),
      ))
      .innerJoin(channelHumans, and(eq(channels.id, channelHumans.channelId), eq(channelHumans.userId, userId)))
      .innerJoin(users, eq(users.id, channelHumans.userId))
      .leftJoin(channelAgents, eq(channels.id, channelAgents.channelId))
      .where(and(
        eq(channels.serverId, serverId),
        eq(channels.type, "dm"),
        isNull(channels.deletedAt),
        isNull(channelAgents.agentId),
        sql`(SELECT count(*) FROM channel_humans WHERE channel_id = ${channels.id}) = 1`,
      )),
  );
  const selfDMs = selfDMRows.map(({ peerEmail, ...row }) => ({
    ...row,
    peerGravatarHash: createHash("sha256").update(peerEmail.trim().toLowerCase()).digest("hex"),
  }));

  const allDMs: DMChannel[] = [
    ...agentDMs.map(dm => ({ ...dm, peerType: "agent" as const })),
    ...userDMs.map(dm => ({ ...dm, peerType: "user" as const })),
    ...selfDMs.map(dm => ({ ...dm, peerType: "user" as const })),
  ];

  // Sort by most recent message first, then by createdAt for DMs with no messages
  if (allDMs.length === 0) return allDMs;

  const humanActivityMuteEnabled = opts?.humanActivityMuteEnabled ?? true;
  const allDmsWithMuteState = await attachActivityMuteState(allDMs, "user", userId, humanActivityMuteEnabled);
  const allDmsWithDisplayPrefs = await attachUserChannelDisplayPrefs(allDmsWithMuteState, userId);
  const allDmsWithLastMessageSummary = await attachLastMessageSummary(
    await attachReadState(allDmsWithDisplayPrefs, userId),
    traceQuery,
    "dm_channels.last_messages_by_channels",
    "dm_channels_count",
  );

  return allDmsWithLastMessageSummary.sort((a, b) => {
    const aLast = a.lastMessageAt;
    const bLast = b.lastMessageAt;
    // DMs with messages come first, sorted by most recent
    if (aLast && bLast) return bLast.getTime() - aLast.getTime();
    if (aLast && !bLast) return -1;
    if (!aLast && bLast) return 1;
    // Both have no messages — sort by creation date ascending
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

/**
 * List DM channel ids the user still participates in, including soft-deleted
 * or peer-removed DMs. Used only for conversation-level sidebar state so stale
 * removed-peer rows can still be closed/pinned without resurrecting them in
 * the normal DM list.
 */
export async function listUserDMChannelIdsIncludingRemoved(
  serverId: string,
  userId: string,
  opts: { traceQuery?: DbQueryTracer } = {},
): Promise<string[]> {
  const db = getDb();
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const rows = await traceQuery(
    "dm_channels.removed_peer_dms_by_user",
    () => db
      .select({ id: channels.id })
      .from(channels)
      .innerJoin(channelHumans, and(eq(channels.id, channelHumans.channelId), eq(channelHumans.userId, userId)))
      .where(and(
        eq(channels.serverId, serverId),
        eq(channels.type, "dm"),
      )),
  );
  return rows.map((row) => row.id);
}

export interface UserDMPinTarget {
  channelId: string;
  peerType: "human" | "agent";
  peerId: string;
}

/**
 * Resolve durable peer identities for DMs the user still participates in.
 * Unlike the ordinary DM directory, this intentionally includes removed human
 * members and deleted agents so conversation-level Pin/Unpin can keep working
 * without re-exposing those peers in Members/Agents directory responses.
 */
export async function listUserDMPinTargetsIncludingRemoved(
  serverId: string,
  userId: string,
  opts: { traceQuery?: DbQueryTracer } = {},
): Promise<UserDMPinTarget[]> {
  const db = getDb();
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const rows = await traceQuery(
    "dm_channels.pin_targets_including_removed",
    () => db
      .select({
        channelId: dmChannelIdentities.channelId,
        kind: dmChannelIdentities.kind,
        peerKey: dmChannelIdentities.peerKey,
      })
      .from(dmChannelIdentities)
      .innerJoin(channels, and(
        eq(channels.id, dmChannelIdentities.channelId),
        eq(channels.serverId, dmChannelIdentities.serverId),
      ))
      .innerJoin(channelHumans, and(
        eq(channelHumans.channelId, channels.id),
        eq(channelHumans.userId, userId),
      ))
      .where(and(
        eq(dmChannelIdentities.serverId, serverId),
        eq(channels.type, "dm"),
      )),
  );

  const targets: UserDMPinTarget[] = [];
  for (const row of rows) {
    const participantIds = row.peerKey.split(":");
    if (!participantIds.includes(userId)) continue;
    if (row.kind === "human_self") {
      if (participantIds.length === 1 && participantIds[0] === userId) {
        targets.push({ channelId: row.channelId, peerType: "human", peerId: userId });
      }
      continue;
    }
    if (participantIds.length !== 2) continue;
    const peerId = participantIds.find((id) => id !== userId);
    if (!peerId) continue;
    if (row.kind === "human_human") {
      targets.push({ channelId: row.channelId, peerType: "human", peerId });
    } else if (row.kind === "human_agent") {
      targets.push({ channelId: row.channelId, peerType: "agent", peerId });
    }
  }
  return targets;
}

export interface AgentConversationSummary {
  id: string;
  createdAt: Date;
  peerId: string;
  peerName: string;
  peerDisplayName: string | null;
  peerAvatarUrl: string | null;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
}

/**
 * List agent-to-agent DM channels for one agent.
 * Human DMs are explicitly excluded.
 */
export async function listAgentToAgentDMsForAgent(serverId: string, agentId: string): Promise<AgentConversationSummary[]> {
  const db = getDb();
  const otherAgentMembership = alias(channelAgents, "other_agent_membership");

  const rows = await db
    .select({
      id: channels.id,
      createdAt: channels.createdAt,
      peerId: agents.id,
      peerName: agents.name,
      peerDisplayName: agents.displayName,
      peerAvatarUrl: agents.avatarUrl,
    })
    .from(channels)
    .innerJoin(channelAgents, and(eq(channels.id, channelAgents.channelId), eq(channelAgents.agentId, agentId)))
    .innerJoin(otherAgentMembership, eq(channels.id, otherAgentMembership.channelId))
    .innerJoin(agents, eq(otherAgentMembership.agentId, agents.id))
    .leftJoin(channelHumans, eq(channels.id, channelHumans.channelId))
    .where(and(
      eq(channels.serverId, serverId),
      eq(channels.type, "dm"),
      isNull(channels.deletedAt),
      isNull(channelHumans.userId),
      isNull(agents.deletedAt),
      sql`${otherAgentMembership.agentId} <> ${agentId}`,
    ));

  if (rows.length === 0) return [];

  const lastMessages = await db
    .select({
      channelId: messages.channelId,
      content: messages.content,
      createdAt: messages.createdAt,
      messageType: messages.messageType,
    })
    .from(messages)
    .where(inArray(messages.channelId, rows.map((row) => row.id)))
    .orderBy(desc(messages.createdAt));

  const latestByChannel = new Map<string, { content: string; createdAt: Date }>();
  for (const message of lastMessages) {
    if (message.messageType === "system") continue;
    if (!latestByChannel.has(message.channelId)) {
      latestByChannel.set(message.channelId, { content: message.content, createdAt: message.createdAt });
    }
  }

  return rows
    .map((row) => {
      const latest = latestByChannel.get(row.id);
      return {
        id: row.id,
        createdAt: row.createdAt,
        peerId: row.peerId,
        peerName: row.peerName,
        peerDisplayName: row.peerDisplayName,
        peerAvatarUrl: row.peerAvatarUrl,
        lastMessageAt: latest?.createdAt ?? null,
        lastMessagePreview: latest?.content ?? null,
      };
    })
    .sort((a, b) => {
      const aTime = a.lastMessageAt?.getTime() ?? a.createdAt.getTime();
      const bTime = b.lastMessageAt?.getTime() ?? b.createdAt.getTime();
      return bTime - aTime;
    });
}



/**
 * Check if a human user can access (view) a channel within the active server.
 *
 * The `serverId` argument is mandatory and pins the check to the active server
 * in the request. This prevents cross-server IDOR: passing a channel/attachment
 * UUID from server B while authenticated against server A must always be
 * rejected, even when `canUserAccessChannel` is called from a route that uses
 * `requireFlexAuth` instead of `requireServer` (e.g. attachment downloads).
 *
 * Why: prior versions trusted middleware to constrain scope, but mounts like
 * `/api/attachments/:id` on the public router did not carry `req.serverId` for
 * user-auth paths. Callers must now assert the active server explicitly.
 * See #proj-security task #10 (2026-04-19).
 */
export async function canUserAccessChannel(
  channelId: string,
  userId: string,
  serverId: ServerId,
  opts?: { includeDeleted?: boolean; executor?: DatabaseExecutor },
): Promise<boolean> {
  const db = opts?.executor ?? getDb();
  const channel = await getChannel(channelId, { ...opts, executor: db });
  if (!channel) return false;

  // Cross-server guard: the channel must live in the caller's active server.
  if (channel.serverId !== serverId) return false;

  const serverRole = await resolveHumanServerRole(serverId, userId, db);
  if (serverRole === "guest") {
    if (channel.type === "thread") {
      const jointThread = await getJointThreadProjectionByLocalThread(channelId, serverId, db);
      if (jointThread) return false;
      if (!channel.parentMessageId) return false;
      const [parentMsg] = await db
        .select({ channelId: messages.channelId })
        .from(messages)
        .where(eq(messages.id, channel.parentMessageId));
      return parentMsg ? canUserAccessChannel(parentMsg.channelId, userId, serverId, opts) : false;
    }
    const isChannelMember = await isChannelHuman(channelId, userId, db);
    return canGuestReadChannel({
      gateEnabled: await isGuestFeatureEnabled(serverId, userId, db),
      serverRole,
      channelType: channel.type,
      channelName: channel.name,
      allChannelHidden: isAllSystemChannel(channel) && !isEnabledAllChannel(channel),
      guestVisible: channel.guestVisible,
      guestJoinable: channel.guestJoinable,
      isChannelMember,
      archived: channel.archivedAt !== null,
      deleted: channel.deletedAt !== null,
    });
  }

  if (isAllSystemChannel(channel) && !isEnabledAllChannel(channel)) return false;

  // Public channels are viewable by all server humans.
  if (channel.type === "channel") return true;

  if (channel.type === "joint") {
    const resolvedJoint = await resolveChannelAccess({
      serverId,
      channelId,
      includeDeleted: opts?.includeDeleted,
      executor: db,
    });
    if (!resolvedJoint || resolvedJoint.kind !== "joint") return false;
    const [membership] = await db
      .select({ userId: channelHumans.userId })
      .from(jointChannelServers)
      .innerJoin(channelHumans, eq(channelHumans.channelId, jointChannelServers.localChannelId))
      .where(and(
        eq(jointChannelServers.jointChannelId, resolvedJoint.jointChannelId),
        eq(jointChannelServers.serverId, serverId),
        eq(jointChannelServers.status, "active"),
        eq(channelHumans.userId, userId),
      ))
      .limit(1);
    return Boolean(membership);
  }

  if (channel.type === "thread") {
    const jointThread = await getJointThreadProjectionByLocalThread(channelId, serverId, db);
    if (jointThread) {
      return canUserAccessChannel(jointThread.localParentChannelId, userId, serverId, opts);
    }
  }

  if (channel.type === "thread" && channel.parentMessageId) {
    const [parentMsg] = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, channel.parentMessageId));
    if (!parentMsg) return false;
    return canUserAccessChannel(parentMsg.channelId, userId, serverId, opts);
  }

  // Human-facing DM reads are participant-scoped. Agent-to-agent DMs have no
  // human participant rows, so they are intentionally not readable through the
  // ordinary human channel/message/attachment routes; privileged human surfaces
  // expose them only as activity summaries through the agent detail API.
  if (channel.type === "dm") {
    const humanParticipants = await db
      .select({ userId: channelHumans.userId })
      .from(channelHumans)
      .where(eq(channelHumans.channelId, channelId));
    return humanParticipants.some((participant) => participant.userId === userId);
  }

  // Private channels are invite-only, so human users need explicit membership.
  const [row] = await db
    .select({ userId: channelHumans.userId })
    .from(channelHumans)
    .where(and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, userId)));
  if (row) return true;

  return false;
}

/**
 * Batched `canUserAccessChannel` over many candidate channels of ONE server:
 * returns the subset of `channelIds` the human may view, with a constant
 * number of queries independent of `channelIds.length`.
 *
 * Mirrors `canUserAccessChannel` rule for rule for the `channel`, `private`
 * and `joint` types (the only ones server-wide list surfaces enumerate).
 * `thread` and `dm` ids, whose rules recurse through parents, fall back to the
 * single-channel check so there is still exactly one source of truth for them.
 */
export async function filterUserAccessibleChannelIds(
  channelIds: readonly string[],
  userId: string,
  serverId: ServerId,
  opts?: { executor?: DatabaseExecutor },
): Promise<Set<string>> {
  const db = opts?.executor ?? getDb();
  const accessible = new Set<string>();
  if (channelIds.length === 0) return accessible;

  // Same row filter as getChannel (not deleted) plus the cross-server guard.
  const candidates = (await db
    .select()
    .from(channels)
    .where(and(inArray(channels.id, [...channelIds]), isNull(channels.deletedAt))))
    .filter((channel) => channel.serverId === serverId);
  if (candidates.length === 0) return accessible;

  const serverRole = await resolveHumanServerRole(serverId, userId, db);
  const batchable = candidates.filter((channel) => channel.type === "channel" || channel.type === "private" || channel.type === "joint");
  const fallback = candidates.filter((channel) => !batchable.includes(channel));

  const needsMembership = batchable.filter((channel) => serverRole === "guest" || channel.type === "private");
  const memberChannelIds = new Set<string>();
  if (needsMembership.length > 0) {
    const rows = await db
      .select({ channelId: channelHumans.channelId })
      .from(channelHumans)
      .where(and(
        eq(channelHumans.userId, userId),
        inArray(channelHumans.channelId, needsMembership.map((channel) => channel.id)),
      ));
    for (const row of rows) memberChannelIds.add(row.channelId);
  }

  if (serverRole === "guest") {
    const gateEnabled = batchable.length > 0 && await isGuestFeatureEnabled(serverId, userId, db);
    for (const channel of batchable) {
      if (canGuestReadChannel({
        gateEnabled,
        serverRole,
        channelType: channel.type,
        channelName: channel.name,
        allChannelHidden: isAllSystemChannel(channel) && !isEnabledAllChannel(channel),
        guestVisible: channel.guestVisible,
        guestJoinable: channel.guestJoinable,
        isChannelMember: memberChannelIds.has(channel.id),
        archived: channel.archivedAt !== null,
        deleted: channel.deletedAt !== null,
      })) accessible.add(channel.id);
    }
  } else {
    const visible = batchable.filter((channel) => !(isAllSystemChannel(channel) && !isEnabledAllChannel(channel)));
    const jointIds = visible.filter((channel) => channel.type === "joint").map((channel) => channel.id);
    // Joint: an active projection of the channel on this server (the
    // resolveChannelAccess condition) AND the human is a member of some active
    // local projection of that joint on this server.
    const jointMembers = new Set<string>();
    if (jointIds.length > 0) {
      const memberProjection = alias(jointChannelServers, "member_projection");
      const rows = await db
        .selectDistinct({ localChannelId: jointChannelServers.localChannelId })
        .from(jointChannelServers)
        .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
        .innerJoin(memberProjection, and(
          eq(memberProjection.jointChannelId, jointChannelServers.jointChannelId),
          eq(memberProjection.serverId, serverId),
          eq(memberProjection.status, "active"),
        ))
        .innerJoin(channelHumans, and(
          eq(channelHumans.channelId, memberProjection.localChannelId),
          eq(channelHumans.userId, userId),
        ))
        .where(and(
          inArray(jointChannelServers.localChannelId, jointIds),
          eq(jointChannelServers.serverId, serverId),
          eq(jointChannelServers.status, "active"),
          eq(jointChannels.status, "active"),
        ));
      for (const row of rows) jointMembers.add(row.localChannelId);
    }
    for (const channel of visible) {
      if (channel.type === "channel") accessible.add(channel.id);
      else if (channel.type === "joint") { if (jointMembers.has(channel.id)) accessible.add(channel.id); }
      else if (memberChannelIds.has(channel.id)) accessible.add(channel.id);
    }
  }

  for (const channel of fallback) {
    if (await canUserAccessChannel(channel.id, userId, serverId, { executor: db })) accessible.add(channel.id);
  }
  return accessible;
}

/**
 * The CLOSED set of fields a residue-only read-all receipt may contain.
 *
 * Every entry is a value the caller already owns: their own read-state row's
 * version, and whether that row changed. Nothing here is derived from the
 * channel's present state.
 *
 * @Tenny's ruling (#proj-activity:b3ffd225, `4cfb516d`) made this a closed SET
 * rather than a ban on one field name. Asserting "the receipt has no maxReadSeq"
 * names one leak; asserting "the receipt's fields are a subset of THIS list"
 * makes the next channel-derived field added to ReadStateMutationResult fail
 * automatically instead of requiring someone to remember to forbid it.
 *
 * Why it matters here and not in the deleted-channel precedent: a deleted
 * channel's frontier is FROZEN, a live channel's is a SIGNAL. One call tells a
 * former member roughly what they already knew; polling it is an activity
 * monitor for a channel they can no longer see. A precedent may only be cited
 * together with the property that made it safe.
 */
export const RESIDUE_ONLY_READ_ALL_RECEIPT_FIELDS = ["ok", "readStateVersion", "changed"] as const;

export type ResidueOnlyReadAllReceipt = {
  ok: true;
  readStateVersion: number;
  changed: boolean;
};

/**
 * Build the receipt for a caller who retired their own residue without having
 * access to the channel. Constructed by naming each allowed field, so a field
 * cannot arrive here by being spread in from somewhere else.
 */
export function buildResidueOnlyReadAllReceipt(
  state: ReadStateMutationResult,
): ResidueOnlyReadAllReceipt {
  return {
    ok: true,
    readStateVersion: state.readStateVersion,
    changed: state.changed,
  };
}

/**
 * Does the SERVER'S OWN records show this user ever had a relationship with this
 * channel?
 *
 * This exists to answer one question and no other: when access is denied, may we
 * say "you do not have access" (which admits the channel exists), or must we say
 * "not found" (which admits nothing)?
 *
 * @Tenny's ruling, #proj-activity:b3ffd225 (`f0a31e7f`): the criterion is NOT
 * "always 404". It is that the response must not depend on whether the channel
 * exists *for a requester with no prior relationship to it*. Someone who was a
 * member, or still carries residue for it, ALREADY KNOWS it exists -- telling
 * them the truth discloses nothing, and they are precisely the population that
 * needs to clear stale Activity entries (the usability half of task #48).
 *
 * Why this cannot be turned into a probe: every row consulted is keyed by the
 * CALLER'S OWN id and written by the server, never by the request. A stranger
 * cannot manufacture one, so a stranger can never move themselves out of the
 * 404 branch.
 *
 * Note what is deliberately NOT consulted: current membership (`channelHumans`).
 * A current member has access and never reaches this call; an ex-member's row is
 * gone. Membership answers "can you", residue answers "did you ever" -- and only
 * the second is the question here.
 *
 * Joining writes the first witness. Since #8292 a member's read position starts at
 * the join, so EVERY join (channel, joint invite, thread follow) leaves a read-cursor
 * row, and anyone removed afterwards gets the 403. The same holds for Guests: a
 * revoked Guest could read the channel, so a 404 would hide nothing from them and
 * would only stop them clearing its stale Activity entry. The one population still
 * answered 404 is ex-members from before #8292 who never read, followed, marked
 * done or were suppressed -- they left no residue and there is no membership
 * history table to consult. That is the fail-closed direction.
 *
 * Fail-closed: any error answers "no prior relationship", i.e. falls to the 404
 * that discloses nothing. Per ruling ①, uncertainty tips toward non-disclosure.
 */
export async function hasPriorChannelRelationship(
  userId: string,
  channelId: string,
): Promise<boolean> {
  try {
    const db = getDb();
    // Ruling ① requires the witness be *cheap*, or the site must fall back to 404
    // rather than pay for the answer -- so the cost of each lookup is part of the
    // contract, not an implementation detail. The first two tables are PRIMARY
    // KEY (user_id, channel_id): one index hit each. The other two are noted at
    // their own call sites, because they are keyed differently and an
    // undifferentiated "all cheap" claim here was already wrong once.
    const [cursor] = await db
      .select({ userId: userChannelReadCursors.userId })
      .from(userChannelReadCursors)
      .where(and(
        eq(userChannelReadCursors.userId, userId),
        eq(userChannelReadCursors.channelId, channelId),
      ))
      .limit(1);
    if (cursor) return true;

    const [inboxState] = await db
      .select({ userId: userChannelInboxStates.userId })
      .from(userChannelInboxStates)
      .where(and(
        eq(userChannelInboxStates.userId, userId),
        eq(userChannelInboxStates.channelId, channelId),
      ))
      .limit(1);
    if (inboxState) return true;

    // @Tenny's follow-up caught the gap that made the first two insufficient:
    // "ever held a read cursor" is NOT the same as "still has residue". A former
    // member who never read anything has no cursor row, yet is exactly the person
    // with an Activity entry they cannot clear -- judging them a stranger would
    // leave the usability half of #48 broken while the leak half looked fixed.
    // So every receiver-owned residue table is a witness, not just the read side.
    // target_kind is included deliberately. This table's PK is
    // (receiver_type, receiver_id, target_kind, target_channel_id), so omitting
    // the kind leaves target_channel_id off the usable prefix and degrades to a
    // scan of every suppression row this user owns -- on the STRANGER path, the
    // one an enumerating attacker hammers, and the one that widens the timing
    // difference already recorded as a known gap. Naming all five kinds keeps it
    // to a bounded set of index probes and needs no migration. (@Tenny)
    const [suppression] = await db
      .select({ receiverId: inboxSuppressionStates.receiverId })
      .from(inboxSuppressionStates)
      .where(and(
        eq(inboxSuppressionStates.receiverType, "user"),
        eq(inboxSuppressionStates.receiverId, userId),
        inArray(inboxSuppressionStates.targetKind, [
          "channel",
          "dm",
          "followed_thread",
          "public_channel_mention",
          "public_thread_mention",
        ]),
        eq(inboxSuppressionStates.targetChannelId, channelId),
      ))
      .limit(1);
    if (suppression) return true;

    // Threads are channels, and four of the six call sites take an id that may be
    // one. A follow row survives losing access to the parent.
    const [follow] = await db
      .select({ followerId: threadFollows.followerId })
      .from(threadFollows)
      .where(and(
        eq(threadFollows.threadChannelId, channelId),
        eq(threadFollows.followerType, "user"),
        eq(threadFollows.followerId, userId),
      ))
      .limit(1);
    return Boolean(follow);
  } catch (err) {
    console.error("[hasPriorChannelRelationship] lookup failed:", err);
    return false;
  }
}

/**
 * Add a human user to a channel (inserts into channelHumans).
 */
export async function addHuman(channelId: string, userId: string, options: ChannelServiceOptions & { role?: "member" | "admin" } = {}): Promise<boolean> {
  if (!options.executor) {
    return withChannelWriterFence(channelId, async (tx) => {
      if (options.actionCardMessageId) {
        await assertActionCardWritableInTransaction(tx, options.actionCardMessageId, options.actionCardConfirmationVersion);
      }
      return addHuman(channelId, userId, { ...options, executor: tx });
    });
  }
  const db = options.executor ?? getDb();
  await assertChannelWritableInTransaction(db, channelId);
  if (options.actionCardMessageId) {
    await assertActionCardWritableInTransaction(db, options.actionCardMessageId, options.actionCardConfirmationVersion);
  }
  const [channel] = await db
    .select({ id: channels.id, serverId: channels.serverId, name: channels.name, type: channels.type })
    .from(channels)
    .where(eq(channels.id, channelId));
  if (!channel) {
    throw new Error("Channel not found");
  }
  if (channel?.type === "thread") {
    throw new Error("Thread membership is managed via follow/unfollow, not channel_humans");
  }
  const [member] = await db
    .select({ userId: serverMembers.userId, role: serverMembers.role })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, channel.serverId), eq(serverMembers.userId, userId)));
  if (!member) {
    throw new Error("Human is not a member of this channel's server");
  }
  if (member.role === "guest" && options.role === "admin") {
    throw new Error("Guest cannot be a channel admin");
  }
  if (isAllSystemChannel(channel)) {
    if (member.role === "guest") {
      throw new Error("Guest cannot be added to the #all channel");
    }
    return false;
  }
  const inserted = await db
    .insert(channelHumans)
    .values({ channelId, userId, role: options.role ?? "member" })
    .onConflictDoNothing()
    .returning({ userId: channelHumans.userId });
  if (inserted.length > 0) await startReadPositionAtJoin(db, "human", userId, channelId);
  return inserted.length > 0;
}

export async function addGuestHumanIfAllowed(
  channelId: string,
  userId: string,
): Promise<"joined" | "already_joined" | "forbidden"> {
  return getDb().transaction(async (tx) => {
    const [lockedChannel] = await tx.select().from(channels)
      .where(eq(channels.id, channelId))
      .for("update");
    if (!lockedChannel) return "forbidden";

    const [member] = await tx.select({ role: serverMembers.role })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, lockedChannel.serverId), eq(serverMembers.userId, userId)))
      .limit(1);
    if (member?.role !== "guest") return "forbidden";

    const [existing] = await tx.select({ userId: channelHumans.userId })
      .from(channelHumans)
      .where(and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, userId)))
      .for("update")
      .limit(1);
    if (existing) return "already_joined";

    const allowed = canGuestJoinChannel({
      gateEnabled: await isGuestFeatureEnabled(lockedChannel.serverId, userId, tx),
      serverRole: member.role,
      channelType: lockedChannel.type,
      channelName: lockedChannel.name,
      allChannelHidden: isAllSystemChannel(lockedChannel) && !isEnabledAllChannel(lockedChannel),
      guestVisible: lockedChannel.guestVisible,
      guestJoinable: lockedChannel.guestJoinable,
      isChannelMember: false,
      archived: lockedChannel.archivedAt !== null,
      deleted: lockedChannel.deletedAt !== null,
    });
    if (!allowed) return "forbidden";

    return await addHuman(channelId, userId, { executor: tx })
      ? "joined"
      : "already_joined";
  });
}

/**
 * Mention "add" on a thread mutates membership on the parent channel. Resolve
 * that authority object explicitly so capability checks and the write lock use
 * the same channel rather than treating a thread follow as channel membership.
 */
export async function getChannelMembershipAuthorityChannelId(
  channelId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<string | null> {
  const channel = await getChannel(channelId, { executor });
  if (!channel) return null;
  if (channel.type !== "thread") return channel.id;
  if (!channel.parentMessageId) return null;
  const [parentMessage] = await executor
    .select({ channelId: messages.channelId })
    .from(messages)
    .where(eq(messages.id, channel.parentMessageId))
    .limit(1);
  return parentMessage?.channelId ?? null;
}

export type ChannelMembershipActorType = "user" | "agent";

export class ChannelMembershipRoleMutationError extends Error {
  constructor(
    public readonly code:
      | "channel_not_found"
      | "channel_capability_required"
      | "channel_archived"
      | "channel_admin_self_demote_forbidden"
      | "channel_member_required"
      | "channel_membership_conflict"
      | "guest_channel_admin_forbidden"
      | "unsupported_channel_shape"
      | "protected_server_role",
    message: string,
  ) {
    super(message);
    this.name = "ChannelMembershipRoleMutationError";
  }
}

/**
 * Human-only v1 writer for the stored channel role. Callers expose this through
 * the Web API only; there is deliberately no Agent API/CLI/action-card route.
 */
export async function changeChannelMembershipRole(input: {
  serverId: string;
  channelId: string;
  requesterUserId: string;
  targetType: ChannelMembershipActorType;
  targetId: string;
  nextRole: ChannelRole;
}) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [channel] = await tx
      .select({ id: channels.id, serverId: channels.serverId, name: channels.name, type: channels.type, archivedAt: channels.archivedAt })
      .from(channels)
      .where(and(eq(channels.id, input.channelId), eq(channels.serverId, input.serverId), isNull(channels.deletedAt)))
      .for("update");
    if (!channel) {
      throw new ChannelMembershipRoleMutationError("channel_not_found", "Channel not found");
    }
    if ((channel.type !== "channel" && channel.type !== "private") || isAllSystemChannel(channel)) {
      throw new ChannelMembershipRoleMutationError("unsupported_channel_shape", "Channel roles are supported only for regular public or private channels");
    }
    if (channel.archivedAt) {
      throw new ChannelMembershipRoleMutationError("channel_archived", "This channel is archived");
    }

    // Channel row is always locked first. Membership rows are then locked in a
    // stable actor tuple order so promote/demote/remove races cannot deadlock.
    const lockOrder = [
      { type: "user" as const, id: input.requesterUserId },
      { type: input.targetType, id: input.targetId },
    ].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
    for (const actor of lockOrder) {
      if (actor.type === "user") {
        await tx.select({ id: channelHumans.userId })
          .from(channelHumans)
          .where(and(eq(channelHumans.channelId, input.channelId), eq(channelHumans.userId, actor.id)))
          .for("update");
      } else {
        await tx.select({ id: channelAgents.agentId })
          .from(channelAgents)
          .where(and(eq(channelAgents.channelId, input.channelId), eq(channelAgents.agentId, actor.id)))
          .for("update");
      }
    }

    const [requesterServer] = await tx.select({ role: serverMembers.role }).from(serverMembers).where(and(
      eq(serverMembers.serverId, input.serverId),
      eq(serverMembers.userId, input.requesterUserId),
    ));
    const [requesterMembership] = await tx.select({ role: channelHumans.role }).from(channelHumans).where(and(
      eq(channelHumans.channelId, input.channelId),
      eq(channelHumans.userId, input.requesterUserId),
    ));
    const requesterCanAccess = channel.type === "channel" || Boolean(requesterMembership);
    const requesterAllowed = requesterCanAccess && hasEffectiveChannelCapability({
      serverRole: requesterServer?.role ?? null,
      channelRole: requesterMembership?.role ?? null,
      isChannelMember: Boolean(requesterMembership),
      supportsChannelRoles: true,
      capability: "changeChannelMemberRoles",
    });
    if (!requesterAllowed) {
      throw new ChannelMembershipRoleMutationError("channel_capability_required", "You do not have permission to change channel member roles");
    }

    if (input.targetType === "user" && input.targetId === input.requesterUserId) {
      const code = input.nextRole === "member"
        ? "channel_admin_self_demote_forbidden"
        : "channel_membership_conflict";
      throw new ChannelMembershipRoleMutationError(code, "A channel admin cannot change their own channel role");
    }

    const targetMembership = input.targetType === "user"
      ? await tx.select({ role: channelHumans.role, authorityRevision: channelHumans.authorityRevision })
        .from(channelHumans)
        .where(and(eq(channelHumans.channelId, input.channelId), eq(channelHumans.userId, input.targetId)))
        .then((rows) => rows[0])
      : await tx.select({ role: channelAgents.role, authorityRevision: channelAgents.authorityRevision })
        .from(channelAgents)
        .where(and(eq(channelAgents.channelId, input.channelId), eq(channelAgents.agentId, input.targetId)))
        .then((rows) => rows[0]);
    if (!targetMembership) {
      throw new ChannelMembershipRoleMutationError("channel_member_required", "Target must already be a channel member");
    }

    const targetServerRole = input.targetType === "user"
      ? await tx.select({ role: serverMembers.role }).from(serverMembers).where(and(
        eq(serverMembers.serverId, input.serverId),
        eq(serverMembers.userId, input.targetId),
      )).then((rows) => rows[0]?.role ?? null)
      : await tx.select({ role: serverAgentMembers.role }).from(serverAgentMembers).where(and(
        eq(serverAgentMembers.serverId, input.serverId),
        eq(serverAgentMembers.agentId, input.targetId),
      )).then((rows) => rows[0]?.role ?? null);
    if (targetServerRole === "owner" || targetServerRole === "admin") {
      throw new ChannelMembershipRoleMutationError("protected_server_role", "Server owners and admins cannot be changed from channel role management");
    }
    if (targetServerRole === "guest" && input.nextRole === "admin") {
      throw new ChannelMembershipRoleMutationError(
        "guest_channel_admin_forbidden",
        "Guests cannot be promoted to channel admin",
      );
    }

    if (targetMembership.role === input.nextRole) {
      return {
        changed: false,
        channelId: input.channelId,
        targetType: input.targetType,
        targetId: input.targetId,
        channelRole: targetMembership.role,
        authorityRevision: targetMembership.authorityRevision,
        eventId: null,
      };
    }

    const authorityRevision = targetMembership.authorityRevision + 1;
    if (input.targetType === "user") {
      await tx.update(channelHumans).set({ role: input.nextRole, authorityRevision }).where(and(
        eq(channelHumans.channelId, input.channelId),
        eq(channelHumans.userId, input.targetId),
      ));
    } else {
      await tx.update(channelAgents).set({ role: input.nextRole, authorityRevision }).where(and(
        eq(channelAgents.channelId, input.channelId),
        eq(channelAgents.agentId, input.targetId),
      ));
    }
    const [event] = await tx.insert(channelMembershipRoleEvents).values({
      channelId: input.channelId,
      serverId: input.serverId,
      requesterUserId: input.requesterUserId,
      targetType: input.targetType,
      targetId: input.targetId,
      previousRole: targetMembership.role,
      nextRole: input.nextRole,
      authorityRevision,
    }).returning({ id: channelMembershipRoleEvents.id });

    return {
      changed: true,
      channelId: input.channelId,
      targetType: input.targetType,
      targetId: input.targetId,
      channelRole: input.nextRole,
      authorityRevision,
      eventId: event!.id,
    };
  });
}

export async function markChannelMembershipRoleEventDelivered(eventId: string) {
  await getDb().update(channelMembershipRoleEvents).set({
    deliveryStatus: "sent",
    deliveryAttempts: sql`${channelMembershipRoleEvents.deliveryAttempts} + 1`,
    deliveredAt: currentDate(),
    lastDeliveryError: null,
  }).where(eq(channelMembershipRoleEvents.id, eventId));
}

/** Remove a human from a channel. #all never has explicit human membership. */
export async function removeHuman(channelId: string, userId: string, executor?: DatabaseExecutor): Promise<void> {
  if (!executor) {
    await withChannelWriterFence(channelId, tx => removeHuman(channelId, userId, tx));
    // Executor callers own the surrounding transaction and invalidate after its
    // commit. A reconnect before commit could otherwise recover the old rooms.
    await revokeSocketAccess({ userId });
    return;
  }
  await assertChannelWritableInTransaction(executor, channelId);
  const db = executor ?? getDb();
  const channel = await getChannel(channelId, { executor: db });
  if (channel?.type === "thread") {
    throw new Error("Thread membership is managed via follow/unfollow, not channel_humans");
  }
  if (channel && isAllSystemChannel(channel)) {
    throw new Error("Cannot leave or remove from the #all channel");
  }
  await db.delete(channelHumans).where(
    and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, userId))
  );
  await deletePrivateChannelIfEmpty(channelId, db);
}

/**
 * Get humans in a channel.
 */
async function getChannelHumansRaw(channelId: string) {
  return (await getChannelHumansRawForChannels([channelId])).map(({ channelId: _channelId, ...human }) => human);
}

/** getChannelHumansRaw for several channels in one query; rows carry their channelId. */
async function getChannelHumansRawForChannels(channelIds: readonly string[], options: { name?: string; id?: string } = {}) {
  if (channelIds.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select({
      channelId: channelHumans.channelId,
      id: users.id,
      serverId: channels.serverId,
      serverName: servers.name,
      serverSlug: servers.slug,
      name: users.name,
      displayName: users.displayName,
      description: users.description,
      avatarUrl: users.avatarUrl,
      email: users.email,
      role: serverMembers.role,
      serverRole: serverMembers.role,
      channelRole: channelHumans.role,
    })
    .from(channelHumans)
    .innerJoin(channels, eq(channelHumans.channelId, channels.id))
    .innerJoin(servers, eq(servers.id, channels.serverId))
    .innerJoin(users, eq(channelHumans.userId, users.id))
    .innerJoin(serverMembers, and(
      eq(serverMembers.serverId, channels.serverId),
      eq(serverMembers.userId, users.id),
    ))
    .where(and(
      inArray(channelHumans.channelId, [...channelIds]),
      options.name === undefined ? undefined : eq(users.name, options.name),
      options.id === undefined ? undefined : eq(users.id, options.id),
    ))
    .orderBy(asc(channelHumans.joinedAt));

  return rows.map(({ email, ...rest }) => ({
    ...rest,
    gravatarHash: createHash("sha256").update(email.trim().toLowerCase()).digest("hex"),
  }));
}

/**
 * The one definition of who is in a server's `#all` audience.
 *
 * Guest visibility is a separate read-only policy: a Guest may be allowed to
 * *read* a channel, but that never grants roster or delivery membership in
 * `#all`. Every query that resolves the `#all` audience must use this condition
 * rather than restating it — the Guest delivery defect this replaces existed
 * because a second copy of the predicate in `messageService` silently lost the
 * role filter, and the copies were held together only by a comment.
 */
export function serverAudienceMemberCondition(serverId: string) {
  return and(eq(serverMembers.serverId, serverId), ne(serverMembers.role, "guest"));
}

/**
 * The non-Guest human audience of a server. This is the effective human
 * membership of an enabled virtual `#all` channel. Guest visibility is a
 * separate read-only policy and never grants roster or delivery membership.
 */
async function getServerAudienceHumans(serverId: string, options: { name?: string } = {}) {
  const db = getDb();
  const rows = await db
    .select({
      id: users.id,
      serverId: serverMembers.serverId,
      serverName: servers.name,
      serverSlug: servers.slug,
      name: users.name,
      displayName: users.displayName,
      description: users.description,
      avatarUrl: users.avatarUrl,
      email: users.email,
      role: serverMembers.role,
    })
    .from(serverMembers)
    .innerJoin(servers, eq(servers.id, serverMembers.serverId))
    .innerJoin(users, eq(serverMembers.userId, users.id))
    .where(and(
      serverAudienceMemberCondition(serverId),
      options.name === undefined ? undefined : eq(users.name, options.name),
    ))
    .orderBy(asc(serverMembers.joinedAt));

  return rows.map(({ email, ...rest }) => ({
    ...rest,
    gravatarHash: createHash("sha256").update(email.trim().toLowerCase()).digest("hex"),
  }));
}

/**
 * Human membership of a channel. For an enabled virtual `#all` channel this is
 * the non-Guest server human audience (single source of truth shared with
 * getChannelMembers / getVirtualAllChannelMembers), so push/unread targeting and
 * the member-list API match the pre-virtualization behavior. All other channels
 * read their explicit `channel_humans` rows.
 */
export async function getChannelHumans(channelId: string) {
  const channel = await getChannel(channelId);
  if (channel && isEnabledAllChannel(channel)) {
    return getServerAudienceHumans(channel.serverId);
  }
  return getChannelHumansRaw(channelId);
}

async function getVirtualAllChannelMembers(serverId: string) {
  const [agentList, humanList] = await Promise.all([
    getServerAudienceAgents(serverId),
    getServerAudienceHumans(serverId),
  ]);
  return { agents: agentList, humans: humanList };
}

/**
 * Current external conversation participants for display in the channel
 * participant panel. They remain projections, never Raft users/agents or
 * membership authority. Provider actor IDs are deliberately not returned.
 */
export async function getChannelExternalMembers(
  channelId: string,
  now: Date = currentDate(),
): Promise<ChannelExternalMember[]> {
  const db = getDb();
  const rows = await db.select({
    id: externalActorProjections.id,
    provider: externalActorProjections.provider,
    displayName: externalActorProjections.displayName,
    handles: externalActorProjections.handles,
    actorKind: externalActorProjections.actorKind,
    avatarUrl: externalProjectionAvatarArtifacts.publicUrl,
  }).from(externalAddressabilityProjections)
    .innerJoin(
      externalActorProjections,
      eq(externalActorProjections.id, externalAddressabilityProjections.projectionId),
    )
    .innerJoin(
      externalChannelBindings,
      and(
        sql`${externalChannelBindings.id}::text = ${externalAddressabilityProjections.bindingId}`,
        eq(externalChannelBindings.bindingEpoch, externalAddressabilityProjections.bindingEpoch),
        eq(externalChannelBindings.providerConversationId, externalAddressabilityProjections.conversationId),
      ),
    )
    .leftJoin(
      externalProjectionAvatarArtifacts,
      and(
        eq(externalProjectionAvatarArtifacts.id, externalActorProjections.avatarArtifactId),
        eq(externalProjectionAvatarArtifacts.state, "active"),
      ),
    )
    .where(and(
      eq(externalChannelBindings.channelId, channelId),
      eq(externalChannelBindings.state, "active"),
      eq(externalAddressabilityProjections.state, "active"),
      gt(externalAddressabilityProjections.expiresAt, now),
      eq(externalActorProjections.state, "active"),
      eq(externalActorProjections.deactivated, false),
      eq(externalActorProjections.provider, "slack"),
      eq(externalAddressabilityProjections.provider, externalActorProjections.provider),
    ))
    .orderBy(asc(externalActorProjections.displayName), asc(externalActorProjections.id));

  const unique = new Map<string, ChannelExternalMember>();
  for (const row of rows) {
    if (row.provider !== "slack" || unique.has(row.id)) continue;
    unique.set(row.id, {
      id: row.id,
      provider: row.provider,
      displayName: row.displayName,
      handles: row.handles,
      actorKind: row.actorKind,
      avatarUrl: row.avatarUrl,
    });
  }
  return [...unique.values()];
}

/**
 * Members = join/post authority (see thread contract in schema.ts).
 * Regular channels: read channel_humans + channel_agents directly.
 * Thread channels:  delegate to the parent channel/DM's members.
 * For "who gets notified" use getThreadFollowers instead.
 * For enabled #all channels, derive members from the server audience.
 */
export async function getChannelMembers(channelId: string) {
  const channel = await getChannel(channelId);

  // Threads delegate join/membership to their parent channel (or DM).
  // Followers of a thread are exposed separately via getThreadFollowers.
  if (channel?.type === "thread") {
    const jointThread = await getJointThreadProjectionByLocalThread(channelId, channel.serverId);
    if (jointThread) {
      return getChannelMembers(jointThread.localParentChannelId);
    }
  }

  if (channel?.type === "thread" && channel.parentMessageId) {
    const db2 = getDb();
    const [parentMsg] = await db2
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, channel.parentMessageId));
    if (!parentMsg) return { agents: [], humans: [] };
    return getChannelMembers(parentMsg.channelId);
  }

  if (channel && isEnabledAllChannel(channel)) {
    return getVirtualAllChannelMembers(channel.serverId);
  }

  if (channel?.type === "joint") {
    const db = getDb();
    const [projection] = await db
      .select({ jointChannelId: jointChannelServers.jointChannelId })
      .from(jointChannelServers)
      .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
      .where(and(
        eq(jointChannelServers.localChannelId, channelId),
        eq(jointChannelServers.status, "active"),
        eq(jointChannels.status, "active"),
      ));
    if (projection) {
      const projections = await db
        .select({ localChannelId: jointChannelServers.localChannelId })
        .from(jointChannelServers)
        .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
        .where(and(
          eq(jointChannelServers.jointChannelId, projection.jointChannelId),
          eq(jointChannelServers.status, "active"),
          isNull(channels.deletedAt),
        ));
      // The same person can belong to more than one server in a joint channel.
      // Merge peer projections first so the projection being viewed always owns
      // the final role and server metadata for duplicate identities.
      const orderedProjections = [
        ...projections.filter((row) => row.localChannelId !== channelId),
        ...projections.filter((row) => row.localChannelId === channelId),
      ];
      const agentsById = new Map<string, Awaited<ReturnType<typeof getChannelAgentsRaw>>[number]>();
      const humansById = new Map<string, Awaited<ReturnType<typeof getChannelHumansRaw>>[number]>();
      // Two queries for all projections instead of two per projection, so
      // mention scope does not grow with the number of servers (§18.10.1).
      const localIds = orderedProjections.map((row) => row.localChannelId);
      const [agentRows, humanRows] = await Promise.all([
        getChannelAgentsRawForChannels(localIds),
        getChannelHumansRawForChannels(localIds),
      ]);
      for (const row of orderedProjections) {
        for (const { channelId: agentChannelId, ...agent } of agentRows) {
          if (agentChannelId === row.localChannelId) agentsById.set(agent.id, agent);
        }
        for (const { channelId: humanChannelId, ...human } of humanRows) {
          if (humanChannelId === row.localChannelId) humansById.set(human.id, human);
        }
      }
      return { agents: [...agentsById.values()], humans: [...humansById.values()] };
    }
  }

  const agentList = await getChannelAgentsRaw(channelId);
  const humanList = await getChannelHumansRaw(channelId);

  return { agents: agentList, humans: humanList };
}

export interface ChannelRosterNameMatches {
  agents: Array<{ id: string; name: string; channelRole?: ChannelMembershipRole }>;
  humans: Array<{ id: string; name: string; serverSlug: string | null; role: string | null; channelRole?: ChannelMembershipRole }>;
}

type ChannelMembershipRole = (typeof channelAgents.$inferSelect)["role"];

/**
 * A `GET /users/:name/channels` membership row: the channel's own facts and
 * the subject's membership of it, nothing of the caller's. A
 * `listChannelsForAgent` row also carries the caller's membership (`joined`,
 * `channelRole`, `channelAuthorityRevision`), the caller's authority
 * (`channelAdminBasis`, `channelCapabilities`), and the caller's attention
 * state (`activityMuted`, `muteFromSeq`, `prefsVersion`,
 * `activityMuteSupported`); none of them is copied. `joined` is the
 * subject's: a membership row is a channel whose roster lists them.
 * `channelRole` is the subject's stored role, present only where channel roles
 * exist (a public or private channel other than `#all`).
 */
export function userChannelMembershipRow<Id extends string>(
  channel: Omit<typeof channels.$inferSelect, "id"> & { id: Id },
  channelRole: ChannelMembershipRole | undefined,
) {
  return {
    id: channel.id,
    serverId: channel.serverId,
    name: channel.name,
    description: channel.description,
    type: channel.type,
    guestVisible: channel.guestVisible,
    guestJoinable: channel.guestJoinable,
    parentMessageId: channel.parentMessageId,
    parentChannelId: channel.parentChannelId,
    createdAt: channel.createdAt,
    archivedAt: channel.archivedAt,
    archivedByUserId: channel.archivedByUserId,
    archivedByAgentId: channel.archivedByAgentId,
    deletedAt: channel.deletedAt,
    joined: true,
    ...(channelRole ? { channelRole } : {}),
  };
}

/**
 * Roster rows of `subject` for each channel of a `listChannelsForAgent` window,
 * as the agent's roster route (`GET /channel-members?channel=#<name>`) would
 * list them: `resolveChannelByName(serverId, agentId, "#<name>")`, then
 * `getChannelMembers`. `null` where that reference does not resolve (the
 * roster route's 404).
 *
 * A non-joint roster is matched by name (`subject.name`, of `subject.kind`; the
 * other list is empty), the predicate the caller would apply to the full
 * roster, so only matching rows are read. A joint roster spans every server's
 * projection, where a same-named agent of another server is someone else, so
 * it is matched by identity instead: the rows of the agent or user
 * `subject.id` (see getJointChannelRosterRowsForSubject). User names are
 * unique, so for humans the two agree.
 *
 * Public and private channels are batched: one `channel_agents` or
 * `channel_humans` query for the whole window, one caller-membership query for
 * the private ones, and one audience query when an enabled `#all` is in the
 * window. Their resolution is the row itself: names are unique per server among
 * live listable channels, archived included. Everything else (joint channels,
 * whose roster spans server projections; a name that does not read back as a
 * plain `#name` reference) is resolved through the roster route's own
 * per-channel path; the joint rosters it resolves are then read together.
 *
 * Built-in app conversations (type `dm`, named by app id, the caller's own)
 * are not rosters anyone is a member of in this sense: they are inspected and
 * list no one (their `#<appId>` reference would resolve a regular channel of
 * that name, if one exists, or nothing).
 *
 * A matched row carries the subject's `channelRole` only where channel roles
 * exist: a public or private channel other than `#all`, read from that
 * channel's own membership row (not a joint projection, not the `#all`
 * audience).
 */
export async function getChannelRosterNameMatchesForAgentWindow(
  serverId: string,
  agentId: string,
  window: ReadonlyArray<Pick<typeof channels.$inferSelect, "id" | "name" | "type">>,
  subject: { kind: "agent" | "human"; name: string; id: string },
): Promise<Array<ChannelRosterNameMatches | null>> {
  // `withChannelRole`: the rows are the channel's own `channel_agents` /
  // `channel_humans` rows and the channel supports channel roles.
  const matches = (rows: readonly ChannelRosterRow[], withChannelRole = false): ChannelRosterNameMatches => {
    const named = rows.filter((row) => row.name === subject.name);
    const roleOf = (row: ChannelRosterRow) => (withChannelRole && row.channelRole ? { channelRole: row.channelRole } : {});
    return subject.kind === "agent"
      ? { agents: named.map((row) => ({ id: row.id, name: row.name, ...roleOf(row) })), humans: [] }
      : { agents: [], humans: named.map((row) => ({ id: row.id, name: row.name, serverSlug: row.serverSlug, role: row.role ?? null, ...roleOf(row) })) };
  };
  // The roster route's query schema trims the reference before resolving it.
  const refFor = (name: string) => `#${name}`.trim();
  const batched = window.filter((channel) => (
    (channel.type === "channel" || channel.type === "private")
    && refFor(channel.name) === `#${channel.name}`
    && parseChannelRef(`#${channel.name}`).threadShortId === null
  ));
  const batchedIds = new Set(batched.map((channel) => channel.id));
  // A hidden #all (private "all") never resolves; an enabled one is the server audience.
  const hiddenAll = batched.filter((channel) => isAllSystemChannel(channel) && !isEnabledAllChannel(channel));
  const enabledAll = batched.filter((channel) => isEnabledAllChannel(channel));
  const explicit = batched.filter((channel) => !isAllSystemChannel(channel));
  const privateIds = explicit.filter((channel) => requiresExplicitMembership(channel.type)).map((channel) => channel.id);
  const explicitIds = explicit.map((channel) => channel.id);

  const db = getDb();
  const [callerPrivateRows, explicitRows, audienceRows] = await Promise.all([
    privateIds.length === 0
      ? []
      : db.select({ channelId: channelAgents.channelId })
        .from(channelAgents)
        .where(and(inArray(channelAgents.channelId, privateIds), eq(channelAgents.agentId, agentId))),
    subject.kind === "agent"
      ? getChannelAgentsRawForChannels(explicitIds, { name: subject.name })
      : getChannelHumansRawForChannels(explicitIds, { name: subject.name }),
    enabledAll.length === 0
      ? []
      : subject.kind === "agent"
        ? getServerAudienceAgents(serverId, { name: subject.name })
        : getServerAudienceHumans(serverId, { name: subject.name }),
  ]);
  const callerPrivate = new Set(callerPrivateRows.map((row) => row.channelId));
  const rowsByChannel = new Map<string, ChannelRosterRow[]>();
  for (const { channelId, ...row } of explicitRows) {
    rowsByChannel.set(channelId, [...(rowsByChannel.get(channelId) ?? []), row]);
  }

  const result: Array<ChannelRosterNameMatches | null> = [];
  // Window index -> resolved joint channel, read together after the loop.
  const jointSlots = new Map<number, string>();
  for (const channel of window) {
    if (batchedIds.has(channel.id)) {
      if (hiddenAll.includes(channel)) result.push(null);
      else if (enabledAll.includes(channel)) result.push(matches(audienceRows));
      else if (requiresExplicitMembership(channel.type) && !callerPrivate.has(channel.id)) result.push(null);
      else result.push(matches(rowsByChannel.get(channel.id) ?? [], true));
      continue;
    }
    if (channel.type === "dm") {
      result.push(matches([]));
      continue;
    }
    const resolved = await resolveChannelByName(serverId, agentId, refFor(channel.name));
    if (!resolved) {
      result.push(null);
      continue;
    }
    if (resolved.type === "joint") {
      jointSlots.set(result.length, resolved.channelId);
      result.push(null);
      continue;
    }
    const members = await getChannelMembers(resolved.channelId);
    const ownRoleRows = resolved.channelId === channel.id
      && (channel.type === "channel" || channel.type === "private")
      && !isAllSystemChannel(channel);
    result.push(matches(subject.kind === "agent" ? members.agents.map((agent) => ({ ...agent, serverSlug: agent.serverSlug ?? null })) : members.humans, ownRoleRows));
  }
  if (jointSlots.size > 0) {
    const subjectRows = await getJointChannelRosterRowsForSubject([...new Set(jointSlots.values())], subject);
    for (const [index, channelId] of jointSlots) {
      const row = subjectRows.get(channelId);
      result[index] = matches(row ? [row] : []);
    }
  }
  return result;
}

type ChannelRosterRow = { id: string; name: string; serverSlug: string | null; role?: string | null; channelRole?: ChannelMembershipRole | null };

/**
 * `subject`'s row, if any, in the roster `getChannelMembers` returns for each
 * of these joint channel projections, read by identity (agent or user id) in
 * two queries for any number of channels.
 *
 * Membership lives on the projections: each server's members are
 * `channel_agents`/`channel_humans` rows of that server's local `joint`
 * channel (agents only ever on their own server's; a person can belong to
 * several servers and so to several projections). While a projection and its
 * joint channel are active, its roster merges every active, live projection,
 * and the projection being viewed wins for a person on more than one;
 * otherwise (disconnected or closed) it is that projection's own rows alone.
 */
async function getJointChannelRosterRowsForSubject(
  channelIds: readonly string[],
  subject: { kind: "agent" | "human"; id: string },
): Promise<Map<string, ChannelRosterRow>> {
  const db = getDb();
  const peerProjection = alias(jointChannelServers, "subject_roster_peer_projection");
  const peerChannel = alias(channels, "subject_roster_peer_channel");
  const projectionRows = await db
    .select({ channelId: jointChannelServers.localChannelId, peerChannelId: peerChannel.id })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .leftJoin(peerProjection, and(
      eq(peerProjection.jointChannelId, jointChannelServers.jointChannelId),
      eq(peerProjection.status, "active"),
    ))
    .leftJoin(peerChannel, and(eq(peerChannel.id, peerProjection.localChannelId), isNull(peerChannel.deletedAt)))
    .where(and(
      inArray(jointChannelServers.localChannelId, [...channelIds]),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
    ));
  const projectionsByChannel = new Map<string, string[]>();
  for (const row of projectionRows) {
    const projections = projectionsByChannel.get(row.channelId) ?? [];
    if (row.peerChannelId) projections.push(row.peerChannelId);
    projectionsByChannel.set(row.channelId, projections);
  }
  const rosterChannelsFor = (channelId: string) => {
    const projections = projectionsByChannel.get(channelId);
    if (!projections) return [channelId];
    return [
      ...projections.filter((projection) => projection !== channelId),
      ...projections.filter((projection) => projection === channelId),
    ];
  };
  const readIds = [...new Set(channelIds.flatMap(rosterChannelsFor))];
  const rows: Array<ChannelRosterRow & { channelId: string }> = subject.kind === "agent"
    ? await getChannelAgentsRawForChannels(readIds, { id: subject.id })
    : await getChannelHumansRawForChannels(readIds, { id: subject.id });

  const result = new Map<string, ChannelRosterRow>();
  for (const channelId of channelIds) {
    for (const projection of rosterChannelsFor(channelId)) {
      for (const { channelId: rowChannelId, ...row } of rows) {
        if (rowChannelId === projection) result.set(channelId, row);
      }
    }
  }
  return result;
}

/**
 * Followers = attention/notification authority (see thread contract in
 * schema.ts). Reads thread_follows and is the source of truth for
 * notifications, unread, done, and follow/unfollow. Never use this to decide
 * whether someone may post — that is governed by getChannelMembers and
 * canUserPostToChannel / canAgentPostToChannel.
 */
export async function getThreadFollowers(threadChannelId: string) {
  const db = getDb();

  const agentList = await db
    .select({
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
      status: agents.status,
      avatarUrl: agents.avatarUrl,
    })
    .from(threadFollows)
    .innerJoin(agents, eq(agents.id, threadFollows.followerId))
    .where(and(
      eq(threadFollows.threadChannelId, threadChannelId),
      eq(threadFollows.followerType, "agent"),
      isNull(threadFollows.unfollowedAt),
      isNull(agents.deletedAt),
    ))
    .orderBy(asc(threadFollows.createdAt));

  const humanRows = await db
    .select({
      id: users.id,
      name: users.name,
      displayName: users.displayName,
      description: users.description,
      avatarUrl: users.avatarUrl,
      email: users.email,
    })
    .from(threadFollows)
    .innerJoin(users, eq(users.id, threadFollows.followerId))
    .where(and(
      eq(threadFollows.threadChannelId, threadChannelId),
      eq(threadFollows.followerType, "user"),
      isNull(threadFollows.unfollowedAt),
    ))
    .orderBy(asc(threadFollows.createdAt));

  const humanList = humanRows.map(({ email, ...rest }) => ({
    ...rest,
    gravatarHash: createHash("sha256").update(email.trim().toLowerCase()).digest("hex"),
  }));

  return { agents: agentList, humans: humanList };
}

export type ManagedThreadAgentFollower = {
  id: string;
  name: string;
  displayName: string | null;
  status: string;
  avatarUrl: string | null;
  serverId: string;
  serverName: string;
  serverSlug: string;
  threadChannelId: string;
};

export async function getManagedThreadFollowerAudienceThreadChannelIds(threadChannelId: string): Promise<string[]> {
  const jointThread = await getJointThreadProjectionByLocalThread(threadChannelId);
  if (!jointThread) return [threadChannelId];
  const projections = await getActiveJointThreadProjectionsByCanonicalThread(jointThread.canonicalThreadChannelId);
  return [...new Set(projections.map((projection) => projection.localThreadChannelId))];
}

/**
 * Management rosters are rendered from one local thread projection, but a
 * Joint Thread can have active follower rows on peer-server local projections.
 * Aggregate those rows for display while leaving write permission to the
 * caller-facing route.
 */
export async function getManagedThreadAgentFollowers(threadChannelId: string): Promise<ManagedThreadAgentFollower[]> {
  const threadChannelIds = await getManagedThreadFollowerAudienceThreadChannelIds(threadChannelId);
  if (threadChannelIds.length === 0) return [];

  const rows = await getDb()
    .select({
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
      status: agents.status,
      avatarUrl: agents.avatarUrl,
      serverId: servers.id,
      serverName: servers.name,
      serverSlug: servers.slug,
      threadChannelId: threadFollows.threadChannelId,
    })
    .from(threadFollows)
    .innerJoin(agents, eq(agents.id, threadFollows.followerId))
    .innerJoin(channels, and(
      eq(channels.id, threadFollows.threadChannelId),
      eq(channels.type, "thread"),
      isNull(channels.deletedAt),
    ))
    .innerJoin(servers, eq(servers.id, channels.serverId))
    .where(and(
      inArray(threadFollows.threadChannelId, threadChannelIds),
      eq(threadFollows.followerType, "agent"),
      isNull(threadFollows.unfollowedAt),
      isNull(agents.deletedAt),
    ))
    .orderBy(asc(threadFollows.createdAt));

  const agentsById = new Map<string, ManagedThreadAgentFollower>();
  for (const row of rows) agentsById.set(row.id, row);
  return [...agentsById.values()];
}

export type ManagedAgentThreadFollowerMutation = {
  changed: boolean;
  removalToken: string | null;
  activityEvent: {
    id: string;
    title: string;
    text: string;
    dedupeKey: string;
  } | null;
};

const THREAD_FOLLOWER_REMOVED_ACTIVITY_PREFIX = "thread_follower_management:removed:";
const THREAD_FOLLOWER_RESTORED_ACTIVITY_PREFIX = "thread_follower_management:restored:";

function threadFollowerActivityEntry(input: {
  title: string;
  text: string;
  eventId: string;
}): TrajectoryEntry {
  return {
    kind: "slock_action",
    title: input.title,
    text: input.text,
    producerFactId: input.eventId,
  };
}

function formatThreadFollowerRemovalText(input: {
  actorLabel: string;
  threadLabel: string;
}): string {
  return [
    `actor: ${input.actorLabel}`,
    `thread: ${input.threadLabel}`,
    "Ordinary thread updates stopped. Personal mentions and task assignments can still notify you. You can follow the thread again.",
  ].join("\n");
}

function formatThreadFollowerRestoreText(input: {
  actorLabel: string;
  threadLabel: string;
}): string {
  return [
    `actor: ${input.actorLabel}`,
    `thread: ${input.threadLabel}`,
    "Thread updates resumed because your follower entry was restored.",
  ].join("\n");
}

/**
 * Remove an Agent from a thread's attention roster and append the user-visible
 * receipt to the canonical Agent Activity log in the same transaction. The
 * `unfollowedAt` value is both the exact state transition and the public Undo
 * token; the Activity dedupe key derives from it, so request retries reuse one
 * durable action instead of minting a parallel audit/notification model.
 */
export async function removeManagedAgentThreadFollower(input: {
  threadChannelId: string;
  agentId: string;
  actorLabel: string;
  threadLabel: string;
  activity: AgentActivity;
  activityDetail: string;
}): Promise<ManagedAgentThreadFollowerMutation> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const removalPrefix = `${THREAD_FOLLOWER_REMOVED_ACTIVITY_PREFIX}${input.threadChannelId}:`;
    const [latestActivityEvent] = await tx
      .select({ createdAt: agentActivityEvents.createdAt })
      .from(agentActivityEvents)
      .where(eq(agentActivityEvents.agentId, input.agentId))
      .orderBy(desc(agentActivityEvents.createdAt))
      .limit(1);
    const now = currentDate();
    const removalToken = new Date(Math.max(
      now.getTime(),
      (latestActivityEvent?.createdAt.getTime() ?? Number.NEGATIVE_INFINITY) + 1,
    ));
    const [removed] = await tx
      .update(threadFollows)
      .set({ unfollowedAt: removalToken })
      .where(and(
        eq(threadFollows.threadChannelId, input.threadChannelId),
        eq(threadFollows.followerType, "agent"),
        eq(threadFollows.followerId, input.agentId),
        isNull(threadFollows.unfollowedAt),
      ))
      .returning({ threadChannelId: threadFollows.threadChannelId });
    if (!removed) {
      const [currentFollow] = await tx
        .select({ unfollowedAt: threadFollows.unfollowedAt })
        .from(threadFollows)
        .where(and(
          eq(threadFollows.threadChannelId, input.threadChannelId),
          eq(threadFollows.followerType, "agent"),
          eq(threadFollows.followerId, input.agentId),
          isNotNull(threadFollows.unfollowedAt),
        ))
        .limit(1);
      if (!currentFollow?.unfollowedAt) {
        return {
          changed: false,
          removalToken: null,
          activityEvent: null,
        };
      }
      const currentToken = currentFollow.unfollowedAt.toISOString();
      const currentDedupeKey = `${removalPrefix}${currentToken}`;
      const [existingActivity] = await tx
        .select({
          id: agentActivityEvents.id,
          entries: agentActivityEvents.entries,
          dedupeKey: agentActivityEvents.dedupeKey,
        })
        .from(agentActivityEvents)
        .where(and(
          eq(agentActivityEvents.agentId, input.agentId),
          eq(agentActivityEvents.dedupeKey, currentDedupeKey),
        ))
        .limit(1);
      const existingEntry = existingActivity?.entries.find((entry) => entry.kind === "slock_action");
      return existingActivity?.dedupeKey && existingEntry?.kind === "slock_action"
        ? {
            changed: false,
            removalToken: currentToken,
            activityEvent: {
              id: existingActivity.id,
              title: existingEntry.title,
              text: existingEntry.text,
              dedupeKey: existingActivity.dedupeKey,
            },
          }
        : { changed: false, removalToken: null, activityEvent: null };
    }

    const eventId = randomUUID();
    const token = removalToken.toISOString();
    const dedupeKey = `${removalPrefix}${token}`;
    const title = "Removed from thread followers";
    const text = formatThreadFollowerRemovalText(input);
    await tx.insert(agentActivityEvents).values({
      id: eventId,
      agentId: input.agentId,
      activity: input.activity,
      detail: input.activityDetail,
      entries: [threadFollowerActivityEntry({ title, text, eventId })],
      dedupeKey,
      createdAt: removalToken,
    });
    return {
      changed: true,
      removalToken: token,
      activityEvent: { id: eventId, title, text, dedupeKey },
    };
  });
}

/** Restore only the exact removal represented by `removalToken`. */
export async function restoreManagedAgentThreadFollower(input: {
  threadChannelId: string;
  agentId: string;
  actorLabel: string;
  threadLabel: string;
  activity: AgentActivity;
  activityDetail: string;
  removalToken: string;
}): Promise<ManagedAgentThreadFollowerMutation> {
  const parsedToken = new Date(input.removalToken);
  if (!Number.isFinite(parsedToken.getTime())) {
    return {
      changed: false,
      removalToken: null,
      activityEvent: null,
    };
  }
  const db = getDb();
  return db.transaction(async (tx) => {
    const canonicalToken = parsedToken.toISOString();
    const removalDedupeKey = `${THREAD_FOLLOWER_REMOVED_ACTIVITY_PREFIX}${input.threadChannelId}:${canonicalToken}`;
    const [removalActivity] = await tx
      .select({ id: agentActivityEvents.id })
      .from(agentActivityEvents)
      .where(and(
        eq(agentActivityEvents.agentId, input.agentId),
        eq(agentActivityEvents.dedupeKey, removalDedupeKey),
      ))
      .limit(1);
    if (!removalActivity) {
      return { changed: false, removalToken: null, activityEvent: null };
    }

    const [restored] = await tx
      .update(threadFollows)
      .set({ unfollowedAt: null })
      .where(and(
        eq(threadFollows.threadChannelId, input.threadChannelId),
        eq(threadFollows.followerType, "agent"),
        eq(threadFollows.followerId, input.agentId),
        eq(threadFollows.unfollowedAt, parsedToken),
      ))
      .returning({ threadChannelId: threadFollows.threadChannelId });
    if (!restored) {
      return {
        changed: false,
        removalToken: null,
        activityEvent: null,
      };
    }

    const eventId = randomUUID();
    const dedupeKey = `${THREAD_FOLLOWER_RESTORED_ACTIVITY_PREFIX}${input.threadChannelId}:${canonicalToken}`;
    const title = "Restored to thread followers";
    const text = formatThreadFollowerRestoreText(input);
    const [latestActivityEvent] = await tx
      .select({ createdAt: agentActivityEvents.createdAt })
      .from(agentActivityEvents)
      .where(eq(agentActivityEvents.agentId, input.agentId))
      .orderBy(desc(agentActivityEvents.createdAt))
      .limit(1);
    const restoredAt = new Date(Math.max(
      currentDate().getTime(),
      parsedToken.getTime() + 1,
      (latestActivityEvent?.createdAt.getTime() ?? Number.NEGATIVE_INFINITY) + 1,
    ));
    await tx.insert(agentActivityEvents).values({
      id: eventId,
      agentId: input.agentId,
      activity: input.activity,
      detail: input.activityDetail,
      entries: [threadFollowerActivityEntry({ title, text, eventId })],
      dedupeKey,
      createdAt: restoredAt,
    });
    return {
      changed: true,
      removalToken: canonicalToken,
      activityEvent: { id: eventId, title, text, dedupeKey },
    };
  });
}

/**
 * Check if a human user is in a channel (in channelHumans).
 */
export async function isChannelHuman(
  channelId: string,
  userId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  const db = executor;
  const [row] = await db
    .select({ userId: channelHumans.userId })
    .from(channelHumans)
    .where(and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, userId)));
  return !!row;
}

/**
 * Check if an agent is in a channel (in channelAgents).
 */
export async function isChannelAgent(
  channelId: string,
  agentId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  const db = executor;
  const [row] = await db
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, channelId), eq(channelAgents.agentId, agentId)));
  return !!row;
}

async function isServerHumanMember(serverId: string, userId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
  return !!row;
}

async function isServerAgent(serverId: string, agentId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.serverId, serverId), eq(agents.id, agentId), isNull(agents.deletedAt)));
  return !!row;
}

/**
 * Check if an agent can access (view) a channel.
 * Public channels: all server agents can view.
 * Private, joint channels, and DMs: only participating agents can view.
 */
export async function canAgentAccessChannel(channelId: string, agentId: string): Promise<boolean> {
  const db = getDb();
  const channel = await getChannel(channelId);
  if (!channel) return false;

  if (isAllSystemChannel(channel) && !isEnabledAllChannel(channel)) return false;

  if (channel.type === "channel") return true;

  if (channel.type === "joint") {
    const resolvedJoint = await resolveChannelAccess({ serverId: channel.serverId, channelId });
    if (!resolvedJoint || resolvedJoint.kind !== "joint") return false;
    const [membership] = await db
      .select({ agentId: channelAgents.agentId })
      .from(jointChannelServers)
      .innerJoin(channelAgents, eq(channelAgents.channelId, jointChannelServers.localChannelId))
      .where(and(
        eq(jointChannelServers.jointChannelId, resolvedJoint.jointChannelId),
        eq(jointChannelServers.serverId, channel.serverId),
        eq(jointChannelServers.status, "active"),
        eq(channelAgents.agentId, agentId),
      ))
      .limit(1);
    return Boolean(membership);
  }

  if (channel.type === "thread") {
    const jointThread = await getJointThreadProjectionByLocalThread(channelId, channel.serverId);
    if (jointThread) {
      return canAgentAccessChannel(jointThread.localParentChannelId, agentId);
    }
  }

  if (channel.type === "thread" && channel.parentMessageId) {
    const db = getDb();
    const [parentMsg] = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, channel.parentMessageId));
    if (!parentMsg) return false;
    return canAgentAccessChannel(parentMsg.channelId, agentId);
  }

  return isChannelAgent(channelId, agentId);
}

/**
 * Resolve one channel id into the exact agent-facing target grammar, while
 * performing the visibility check in the same operation. Callers must treat a
 * null result as both "not visible" and "not resolvable" and must not disclose
 * which case applied.
 *
 * DM storage names are not a reliable peer projection: human-agent DMs are
 * named after the agent, and an agent-agent DM is named after whichever peer
 * happened to be the creation target. Prefer durable DM provenance and only
 * use current membership as a legacy fallback.
 */
/**
 * Names in this server held by BOTH a human member and a (non-deleted) agent.
 * For those names a bare `dm:@name` is ambiguous, so agent-facing DM targets
 * carry the peer's kind (`dm:@name~agent`, see dmPeerRef.ts); every other name
 * keeps the bare form it always had.
 */
export async function findCrossKindTwinPeerNames(serverId: string, names: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(names)].filter((name) => name.length > 0);
  const twins = new Set<string>();
  if (unique.length === 0) return twins;
  const db = getDb();
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const rows = await db
      .selectDistinct({ name: users.name })
      .from(users)
      .innerJoin(serverMembers, and(eq(serverMembers.userId, users.id), eq(serverMembers.serverId, serverId)))
      .innerJoin(agents, and(eq(agents.name, users.name), eq(agents.serverId, serverId), isNull(agents.deletedAt)))
      .where(inArray(users.name, chunk));
    for (const row of rows) if (row.name) twins.add(row.name);
  }
  return twins;
}

async function agentFacingDmRef(serverId: string, peerName: string, peerKind: DmPeerKind): Promise<string> {
  const twins = await findCrossKindTwinPeerNames(serverId, [peerName]);
  return `dm:@${formatDmPeerRef(peerName, twins.has(peerName) ? peerKind : null)}`;
}

export async function resolveAgentFacingChannelRef(
  serverId: string,
  agentId: string,
  channelId: string,
): Promise<string | null> {
  const channel = await getChannel(channelId);
  if (!channel || channel.serverId !== serverId) return null;
  if (!await canAgentAccessChannel(channelId, agentId)) return null;
  // Task creation is top-level-only. Do not manufacture a #thread-name target
  // for an invalid historical row; that string is not part of the target DSL.
  if (channel.type === "thread") return null;
  if (channel.type !== "dm") return `#${channel.name}`;
  // The agent's own private reminder conversation (no peer, no identity row).
  if (await getAgentPrivateSurfaceKind(agentId, channelId) === "reminders") return `dm:@${AGENT_REMINDERS_DM_PEER}`;

  const db = getDb();
  const [identity] = await db
    .select({ kind: dmChannelIdentities.kind, peerKey: dmChannelIdentities.peerKey })
    .from(dmChannelIdentities)
    .where(and(
      eq(dmChannelIdentities.channelId, channelId),
      eq(dmChannelIdentities.serverId, serverId),
    ))
    .limit(1);

  if (identity) {
    const participants = identity.peerKey.split(":");
    if (!participants.includes(agentId)) return null;
    const peerId = participants.find((id) => id !== agentId);
    if (peerId && identity.kind === "human_agent") {
      const [peer] = await db.select({ name: users.name }).from(users).where(eq(users.id, peerId)).limit(1);
      return peer?.name ? agentFacingDmRef(serverId, peer.name, "human") : null;
    }
    if (peerId && identity.kind === "agent_agent") {
      const [peer] = await db.select({ name: agents.name }).from(agents).where(and(
        eq(agents.id, peerId),
        eq(agents.serverId, serverId),
      )).limit(1);
      return peer?.name ? agentFacingDmRef(serverId, peer.name, "agent") : null;
    }
    return null;
  }

  // Legacy human-agent DMs may predate dm_channel_identities.
  const [humanPeer] = await db
    .select({ name: users.name })
    .from(channelHumans)
    .innerJoin(users, eq(channelHumans.userId, users.id))
    .where(eq(channelHumans.channelId, channelId))
    .limit(1);
  if (humanPeer?.name) return agentFacingDmRef(serverId, humanPeer.name, "human");

  // Legacy agent-agent DMs likewise derive the peer from the other member.
  const [agentPeer] = await db
    .select({ name: agents.name })
    .from(channelAgents)
    .innerJoin(agents, eq(channelAgents.agentId, agents.id))
    .where(and(
      eq(channelAgents.channelId, channelId),
      sql`${channelAgents.agentId} <> ${agentId}`,
    ))
    .limit(1);
  if (agentPeer?.name) return agentFacingDmRef(serverId, agentPeer.name, "agent");

  // Built-in app conversations intentionally have one agent member and no DM
  // identity row. Their registry app id is the documented dm:@ target.
  return isAppId(channel.name) ? `dm:@${channel.name}` : null;
}

/**
 * Enumerate the current agent's visible, task-bearing channel namespace. This
 * starts from public channels plus the agent's own membership rows; it never
 * scans hidden task assignments and therefore cannot turn their count into a
 * timing or output oracle. Archived channels remain included because archive
 * does not revoke read access or retire outstanding work.
 */
export async function listAgentFacingTaskChannelRefs(
  serverId: string,
  agentId: string,
): Promise<Map<string, string>> {
  const db = getDb();
  const candidates = await db
    .select({ id: channels.id })
    .from(channels)
    .leftJoin(channelAgents, and(
      eq(channelAgents.channelId, channels.id),
      eq(channelAgents.agentId, agentId),
    ))
    .where(and(
      eq(channels.serverId, serverId),
      inArray(channels.type, ["channel", "private", "joint", "dm"]),
      isNull(channels.deletedAt),
      or(eq(channels.type, "channel"), isNotNull(channelAgents.agentId)),
    ));

  const refs = new Map<string, string>();
  await Promise.all(candidates.map(async ({ id }) => {
    const ref = await resolveAgentFacingChannelRef(serverId, agentId, id);
    if (ref) refs.set(id, ref);
  }));
  return refs;
}

export async function isAgentActivelyFollowingThread(threadChannelId: string, agentId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ followerId: threadFollows.followerId })
    .from(threadFollows)
    .where(and(
      eq(threadFollows.threadChannelId, threadChannelId),
      eq(threadFollows.followerType, "agent"),
      eq(threadFollows.followerId, agentId),
      isNull(threadFollows.unfollowedAt),
    ))
    .limit(1);
  return Boolean(row);
}

async function canAgentAccessThreadParentForDelivery(threadChannelId: string, agentId: string): Promise<boolean> {
  const db = getDb();
  const [threadChannel] = await db
    .select({ id: channels.id, serverId: channels.serverId })
    .from(channels)
    .where(and(
      eq(channels.id, threadChannelId),
      eq(channels.type, "thread"),
      isNull(channels.deletedAt),
    ))
    .limit(1);
  if (!threadChannel) return false;

  const jointThread = await getJointThreadProjectionByLocalThread(threadChannelId, threadChannel.serverId);
  if (jointThread) {
    const jointParentChannels = alias(channels, "agent_thread_delivery_joint_parent_channels");
    const [row] = await db
      .select({ agentId: channelAgents.agentId })
      .from(channelAgents)
      .innerJoin(agents, and(
        eq(agents.id, channelAgents.agentId),
        isNull(agents.deletedAt),
      ))
      .innerJoin(jointParentChannels, and(
        eq(jointParentChannels.id, jointThread.localParentChannelId),
        isNull(jointParentChannels.deletedAt),
      ))
      .where(and(
        eq(channelAgents.channelId, jointThread.localParentChannelId),
        eq(channelAgents.agentId, agentId),
      ))
      .limit(1);
    return Boolean(row);
  }

  const parentMessages = alias(messages, "agent_thread_delivery_parent_messages");
  const parentChannels = alias(channels, "agent_thread_delivery_parent_channels");
  const parentChannelAgents = alias(channelAgents, "agent_thread_delivery_parent_channel_agents");
  const [row] = await db
    .select({ id: channels.id })
    .from(channels)
    .innerJoin(parentMessages, eq(parentMessages.id, channels.parentMessageId))
    .innerJoin(parentChannels, and(
      eq(parentChannels.id, parentMessages.channelId),
      isNull(parentChannels.deletedAt),
    ))
    .innerJoin(agents, and(
      eq(agents.id, agentId),
      isNull(agents.deletedAt),
    ))
    .leftJoin(parentChannelAgents, and(
      eq(parentChannelAgents.channelId, parentMessages.channelId),
      eq(parentChannelAgents.agentId, agents.id),
    ))
    .where(and(
      eq(channels.id, threadChannelId),
      eq(channels.type, "thread"),
      isNull(channels.deletedAt),
      sql`(
        (${parentChannels.type} = 'channel' AND ${agents.serverId} = ${parentChannels.serverId})
        OR ${parentChannelAgents.agentId} IS NOT NULL
      )`,
    ))
    .limit(1);
  return Boolean(row);
}

export async function canAgentReceiveChannelDelivery(
  channelId: string,
  agentId: string,
  opts: { personalMention?: boolean } = {},
): Promise<boolean> {
  const channel = await getChannel(channelId);
  if (!channel) return false;

  if (channel.type !== "thread") {
    return canAgentAccessChannel(channelId, agentId);
  }

  if (opts.personalMention) {
    return canAgentAccessThreadParentForDelivery(channelId, agentId);
  }

  return await isAgentActivelyFollowingThread(channelId, agentId)
    && await canAgentAccessThreadParentForDelivery(channelId, agentId);
}

/**
 * Post authority for a human (see thread contract in schema.ts).
 * Threads recurse to parent channel/DM membership; following a thread never
 * grants post permission.
 */
export async function canUserPostToChannel(channelId: string, userId: string): Promise<boolean> {
  const channel = await getChannel(channelId);
  if (!channel) return false;

  const serverRole = await resolveHumanServerRole(channel.serverId, userId);
  if (serverRole === "guest") {
    if (channel.type === "thread") {
      const jointThread = await getJointThreadProjectionByLocalThread(channelId, channel.serverId);
      if (jointThread) return false;
      if (!channel.parentMessageId) return false;
      const [parentMsg] = await getDb()
        .select({ channelId: messages.channelId })
        .from(messages)
        .where(eq(messages.id, channel.parentMessageId));
      return parentMsg ? canUserPostToChannel(parentMsg.channelId, userId) : false;
    }
    return canGuestPostToChannel({
      gateEnabled: await isGuestFeatureEnabled(channel.serverId, userId),
      serverRole,
      channelType: channel.type,
      channelName: channel.name,
      allChannelHidden: isAllSystemChannel(channel) && !isEnabledAllChannel(channel),
      guestVisible: channel.guestVisible,
      guestJoinable: channel.guestJoinable,
      isChannelMember: await isChannelHuman(channelId, userId),
      archived: channel.archivedAt !== null,
      deleted: channel.deletedAt !== null,
    });
  }

  if (isAllSystemChannel(channel) && !isEnabledAllChannel(channel)) return false;
  if (isEnabledAllChannel(channel)) return isServerHumanMember(channel.serverId, userId);

  if (channel.type === "thread") {
    const jointThread = await getJointThreadProjectionByLocalThread(channelId, channel.serverId);
    if (jointThread) {
      return canUserPostToChannel(jointThread.localParentChannelId, userId);
    }
  }

  if (channel.type === "thread" && channel.parentMessageId) {
    const db = getDb();
    const [parentMsg] = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, channel.parentMessageId));
    if (!parentMsg) return false;
    return canUserPostToChannel(parentMsg.channelId, userId);
  }

  return isChannelHuman(channelId, userId);
}

/**
 * Post authority for an agent (see thread contract in schema.ts).
 * Threads recurse to parent channel/DM membership; being in thread_follows
 * never grants post permission.
 */
export async function canAgentPostToChannel(channelId: string, agentId: string): Promise<boolean> {
  const channel = await getChannel(channelId);
  if (!channel) return false;

  if (isAllSystemChannel(channel) && !isEnabledAllChannel(channel)) return false;
  if (isEnabledAllChannel(channel)) return isServerAgent(channel.serverId, agentId);
  // Private agent surfaces (dm:@reminders) are written by the server only.
  if (channel.type === "dm" && await isAgentPrivateSurfaceChannel(channelId)) return false;

  if (channel.type === "thread") {
    const jointThread = await getJointThreadProjectionByLocalThread(channelId, channel.serverId);
    if (jointThread) {
      return canAgentPostToChannel(jointThread.localParentChannelId, agentId);
    }
  }

  if (channel.type === "thread" && channel.parentMessageId) {
    const db = getDb();
    const [parentMsg] = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, channel.parentMessageId));
    if (!parentMsg) return false;
    return canAgentPostToChannel(parentMsg.channelId, agentId);
  }

  return isChannelAgent(channelId, agentId);
}

/**
 * Resolve a unified target identifier to a channel ID.
 * Accepts:
 *   - "#channel" for channels
 *   - "#channel:shortid" for threads in channels
 *   - "dm:@peer" or "DM:@peer" (legacy uppercase) for DMs
 *   - "dm:@peer:shortid" for threads in DMs
 * For DMs, the agentId is needed to find the DM channel between the agent and the peer.
 */
/**
 * Split a channel ref into its channel part and optional thread short id.
 *
 * This is the ONLY place the suffix rule lives. `resolveChannelByName` below
 * calls it, so a caller that needs to tell "this channel does not exist" apart
 * from "this message has no thread yet" gets exactly the split the resolver
 * acted on. An earlier version of this comment claimed that while the resolver
 * still carried its own inline copy: the two agreed character for character,
 * which is precisely how a second implementation stays hidden -- nothing warns
 * you when you edit one of them.
 *
 * The suffix must be a full 8-hex message short id (`MESSAGE_SHORT_ID_RE`, the
 * same predicate the message resolvers use). A looser `[0-9a-f]+` also matched
 * refs like `#general:1`, routing a plain channel whose name happens to contain
 * a colon into thread lookup.
 */
export function parseChannelRef(
  channelRef: string,
): { baseRef: string; threadShortId: string | null } {
  const withSuffix = (prefix: string, rest: string) => {
    const lastColon = rest.lastIndexOf(":");
    if (lastColon > 0) {
      const shortId = rest.slice(lastColon + 1);
      if (MESSAGE_SHORT_ID_RE.test(shortId)) {
        return { baseRef: `${prefix}${rest.slice(0, lastColon)}`, threadShortId: shortId };
      }
    }
    return { baseRef: `${prefix}${rest}`, threadShortId: null };
  };
  if (channelRef.startsWith("DM:@") || channelRef.startsWith("dm:@")) {
    return withSuffix(channelRef.slice(0, 4), channelRef.slice(4));
  }
  if (channelRef.startsWith("#")) {
    return withSuffix("#", channelRef.slice(1));
  }
  return { baseRef: channelRef, threadShortId: null };
}

export async function resolveChannelByName(
  serverId: string,
  agentId: string,
  channelRef: string
): Promise<{ channelId: string; type: ChannelRefType } | null> {
  const db = getDb();

  // Single source for the suffix rule -- see parseChannelRef.
  const { baseRef, threadShortId } = parseChannelRef(channelRef);

  // DM or DM thread: dm:@peer or dm:@peer:shortid (also legacy DM:@)
  if (channelRef.startsWith("DM:@") || channelRef.startsWith("dm:@")) {
    if (threadShortId) {
      // The thread is located by its short id; still refuse a malformed peer
      // kind rather than silently ignoring it.
      const rawPeer = baseRef.slice(4);
      const parsedPeer = parseDmPeerRef(rawPeer);
      if (!parsedPeer.ok && parsedPeer.reason === "unknown_peer_kind") {
        throw DmTargetResolutionError.invalidPeerKind(rawPeer, parsedPeer.suffix);
      }
      const thread = await resolveThreadByShortId(serverId, agentId, threadShortId);
      // An explicit kind is a claim about which DM the thread lives in: a
      // thread under the agent Twin's DM is not `dm:@Twin~human:<id>`.
      if (thread && parsedPeer.ok && parsedPeer.peerKind) {
        const namedDm = await resolveDMByPeerName(serverId, agentId, rawPeer);
        if (!namedDm || await getThreadParentChannelId(thread.channelId) !== namedDm.channelId) return null;
      }
      return thread;
    }
    return resolveDMByPeerName(serverId, agentId, baseRef.slice(4));
  }

  // Channel or channel thread: #name or #name:shortid
  if (channelRef.startsWith("#")) {
    if (threadShortId) {
      return resolveThreadByShortId(serverId, agentId, threadShortId);
    }
    const rest = baseRef.slice(1);
    // Plain channel lookup
    const [channel] = await db
      .select({
        id: channels.id,
        type: channels.type,
        name: channels.name,
      })
      .from(channels)
      .where(
        and(
          eq(channels.serverId, serverId),
          inArray(channels.type, LISTABLE_CHANNEL_TYPES),
          eq(channels.name, rest),
          isNull(channels.deletedAt)
        )
      );
    if (!channel) return null;
    if (isAllSystemChannel(channel) && !isEnabledAllChannel(channel)) {
      return null;
    }
    if (requiresExplicitMembership(channel.type) && !await isChannelAgent(channel.id, agentId)) {
      return null;
    }
    if (channel.type === "joint" && !await resolveChannelAccess({ serverId, channelId: channel.id })) {
      return null;
    }
    return { channelId: channel.id, type: channel.type as ListableChannelType };
  }

  return null;
}

/**
 * Resolve a thread channel by an 8-hex suffix.
 *
 * The suffix is tried in order:
 *   1. as a parent-message short id (`thread-<shortId>` channel name) — the
 *      form `replyTarget` prints and the only form older docs described;
 *   2. as a thread-channel id short form — the `threadId=` header field is the
 *      first 8 chars of the thread channel's UUID, and agents habitually paste
 *      it into the same `#channel:<id>` slot. Before this fallback that always
 *      answered "Message or thread not found" for a thread that plainly exists.
 *
 * Both lookups are server-scoped (a `#channel:<id>` suffix never claimed to be
 * scoped to the named channel — thread resolution has always been server-wide)
 * and the same `canAgentAccessChannel` gate runs after each, so the fallback
 * grants nothing the message-id path did not. An id matching a message in one
 * place and a thread UUID in another resolves to the message first; a prefix
 * matching more than one thread resolves to nothing (same neutral answer as a
 * miss — UUID-prefix collisions are vanishingly rare and none of the callers
 * can distinguish the two cases anyway).
 */
async function resolveThreadByShortId(
  serverId: string,
  agentId: string,
  shortId: string
): Promise<{ channelId: string; type: "thread" } | null> {
  const db = getDb();
  const threadName = `thread-${shortId}`;
  const [channel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.serverId, serverId),
        eq(channels.type, "thread"),
        eq(channels.name, threadName),
        isNull(channels.deletedAt)
      )
    );
  if (channel) {
    if (!await canAgentAccessChannel(channel.id, agentId)) return null;
    return { channelId: channel.id, type: "thread" };
  }

  // Fallback: the suffix may be the thread channel's own id short form
  // (`threadId=` in the message header), not its parent's message short id.
  const bounds = uuidShortIdRange(shortId);
  const candidates = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.serverId, serverId),
        eq(channels.type, "thread"),
        gte(channels.id, bounds.lower),
        ...(bounds.upper ? [lt(channels.id, bounds.upper)] : []),
        isNull(channels.deletedAt)
      )
    )
    .limit(2);
  if (candidates.length !== 1) return null;
  if (!await canAgentAccessChannel(candidates[0].id, agentId)) return null;
  return { channelId: candidates[0].id, type: "thread" };
}

async function getThreadParentChannelId(threadChannelId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ channelId: messages.channelId })
    .from(channels)
    .innerJoin(messages, eq(messages.id, channels.parentMessageId))
    .where(eq(channels.id, threadChannelId))
    .limit(1);
  return row?.channelId ?? null;
}

/**
 * Resolve a DM channel by peer name (for agents).
 * Searches for an existing DM between the agent and a user/agent with this name.
 */
async function resolveDMByPeerName(
  serverId: string,
  agentId: string,
  rawPeer: string
): Promise<{ channelId: string; type: "dm" } | null> {
  const db = getDb();

  // `dm:@reminders` is the authenticated agent's own private reminder
  // conversation. The handle is reserved, so it takes precedence over (and
  // can never collide with) a human or agent peer named `reminders`.
  if (rawPeer.toLowerCase() === AGENT_REMINDERS_DM_PEER) {
    const channelId = await getAgentPrivateSurfaceChannelId(agentId, "reminders");
    return channelId ? { channelId, type: "dm" } : null;
  }

  // Built-in app DMs are resolved for the authenticated owner only. The
  // owner is never accepted from the ref string: Agent A therefore cannot
  // resolve Agent B's derived conversation even though both refs render as
  // `dm:@<appId>`.
  if (isAppId(rawPeer)) {
    const appDm = await getBuiltInConversationChannel(serverId, rawPeer, agentId);
    if (appDm) return { channelId: appDm.id, type: "dm" };
  }

  // `dm:@name~agent` / `dm:@name~human` names the kind of peer explicitly.
  // An unknown suffix is refused, never read as a bare name.
  const parsed = parseDmPeerRef(rawPeer);
  if (!parsed.ok) {
    if (parsed.reason === "unknown_peer_kind") throw DmTargetResolutionError.invalidPeerKind(rawPeer, parsed.suffix);
    return null;
  }
  const { peerName, peerKind } = parsed;

  const humanDm = peerKind === "agent" ? null : await findHumanPeerDm(db, serverId, agentId, peerName);
  if (peerKind === "human") return humanDm;
  const agentDm = await findAgentPeerDm(db, serverId, agentId, peerName);
  if (peerKind === "agent") return agentDm;

  // A bare name held by BOTH a human member and a non-deleted agent in this
  // server is ambiguous REGARDLESS of whether the two DMs both exist yet. The
  // meaning of `dm:@name` must be stable over time: resolving it to the human's
  // DM today and turning into an error once the agent's DM appears would let
  // the same target silently change which conversation it names (a
  // send-to-the-wrong-person hazard). `findCrossKindTwinPeerNames` is the one
  // stability rule shared with the agent-facing label path.
  const twins = await findCrossKindTwinPeerNames(serverId, [peerName]);
  if (twins.has(peerName)) throw DmTargetResolutionError.ambiguous(peerName);
  return humanDm ?? agentDm;
}

async function findHumanPeerDm(
  db: ReturnType<typeof getDb>,
  serverId: string,
  agentId: string,
  peerName: string,
): Promise<{ channelId: string; type: "dm" } | null> {
  const userResults = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(serverMembers, eq(serverMembers.userId, users.id))
    .where(and(eq(serverMembers.serverId, serverId), eq(users.name, peerName)));

  for (const user of userResults) {
    // Find DM channel between this agent and this user
    const [dm] = await db
      .select({ id: channels.id })
      .from(channels)
      .innerJoin(channelAgents, eq(channels.id, channelAgents.channelId))
      .innerJoin(channelHumans, eq(channels.id, channelHumans.channelId))
      .where(
        and(
          eq(channels.serverId, serverId),
          eq(channels.type, "dm"),
          eq(channelAgents.agentId, agentId),
          eq(channelHumans.userId, user.id),
          isNull(channels.deletedAt)
        )
      );
    if (dm) return { channelId: dm.id, type: "dm" };
  }
  return null;
}

async function findAgentPeerDm(
  db: ReturnType<typeof getDb>,
  serverId: string,
  agentId: string,
  peerName: string,
): Promise<{ channelId: string; type: "dm" } | null> {
  const agentResults = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.serverId, serverId), eq(agents.name, peerName), isNull(agents.deletedAt)));

  const otherAgentMembership = alias(channelAgents, "other_agent_membership");
  for (const peerAgent of agentResults) {
    if (peerAgent.id === agentId) continue;
    const [dm] = await db
      .select({ id: channels.id })
      .from(channels)
      .innerJoin(channelAgents, and(eq(channels.id, channelAgents.channelId), eq(channelAgents.agentId, agentId)))
      .innerJoin(otherAgentMembership, and(eq(channels.id, otherAgentMembership.channelId), eq(otherAgentMembership.agentId, peerAgent.id)))
      .leftJoin(channelHumans, eq(channels.id, channelHumans.channelId))
      .where(and(
        eq(channels.serverId, serverId),
        eq(channels.type, "dm"),
        isNull(channels.deletedAt),
        isNull(channelHumans.userId),
      ));
    if (dm) return { channelId: dm.id, type: "dm" };
  }
  return null;
}

/**
 * Resolve a user by @name within a server. Returns userId or null.
 */
export async function resolveUserByName(serverId: string, name: string): Promise<string | null> {
  const db = getDb();
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(serverMembers, eq(serverMembers.userId, users.id))
    .where(and(eq(serverMembers.serverId, serverId), eq(users.name, name)));
  return user?.id || null;
}

export async function resolveAgentByName(serverId: string, name: string): Promise<string | null> {
  const db = getDb();
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.serverId, serverId), eq(agents.name, name), isNull(agents.deletedAt)));
  return agent?.id || null;
}

export async function getMessage(messageId: string) {
  const db = getDb();
  const [msg] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  return msg ?? null;
}

export type ChannelFileEntry = {
  id: string;
  messageId: string;
  channelId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  thumbnailKey: string | null;
  createdAt: string;
  uploaderType: "user" | "agent" | "external_projection";
  uploaderId: string;
  uploaderName: string | null;
  uploaderDisplayName: string | null;
  source: {
    type: "channel" | "thread";
    channelId: string;
    parentMessageId: string | null;
    parentMessageShortId: string | null;
  };
};

export type ChannelFilesCursor = {
  createdAt: string;
  id: string;
};

export async function listChannelFiles(
  channelId: string,
  opts: { historyCutoff?: Date | null; limit?: number; cursor?: ChannelFilesCursor | null } = {},
): Promise<ChannelFileEntry[]> {
  const db = getDb();
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 500));
  const historyCutoff = opts.historyCutoff ?? null;
  const historyFilter = historyCutoff ? sql`AND m.created_at >= ${historyCutoff}` : sql``;
  const cursor = opts.cursor ?? null;
  const cursorFilter = cursor
    ? sql`AND (a.created_at < ${cursor.createdAt}::timestamptz OR (a.created_at = ${cursor.createdAt}::timestamptz AND a.id < ${cursor.id}))`
    : sql``;
  const rows = await db.execute(sql`
    WITH candidate_files AS (
      (
        SELECT
          a.id,
          a.message_id,
          a.channel_id,
          a.filename,
          a.mime_type,
          a.size_bytes,
          a.width,
          a.height,
          a.thumbnail_key,
          a.created_at,
          a.uploader_type,
          a.uploader_id,
          m.channel_id AS source_channel_id,
          CASE WHEN source_channel.type = 'thread' THEN 'thread' ELSE 'channel' END AS source_type,
          source_channel.parent_message_id
        FROM attachments a
        INNER JOIN messages m
          ON m.id = a.message_id
         AND m.channel_id = a.channel_id
        INNER JOIN channels source_channel
          ON source_channel.id = a.channel_id
         AND source_channel.deleted_at IS NULL
        WHERE a.message_id IS NOT NULL
          AND a.channel_id = ${channelId}
          ${historyFilter}
          ${cursorFilter}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${limit}
      )
      UNION ALL
      (
        SELECT
          a.id,
          a.message_id,
          a.channel_id,
          a.filename,
          a.mime_type,
          a.size_bytes,
          a.width,
          a.height,
          a.thumbnail_key,
          a.created_at,
          a.uploader_type,
          a.uploader_id,
          m.channel_id AS source_channel_id,
          'thread'::text AS source_type,
          source_channel.parent_message_id
        FROM messages parent_message
        INNER JOIN channels source_channel
          ON source_channel.parent_message_id = parent_message.id
         AND source_channel.type = 'thread'
         AND source_channel.deleted_at IS NULL
        INNER JOIN attachments a
          ON a.channel_id = source_channel.id
         AND a.message_id IS NOT NULL
        INNER JOIN messages m
          ON m.id = a.message_id
         AND m.channel_id = source_channel.id
        WHERE parent_message.channel_id = ${channelId}
          ${historyFilter}
          ${cursorFilter}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${limit}
      )
    )
    SELECT
      cf.id::text AS "id",
      cf.message_id::text AS "messageId",
      cf.channel_id::text AS "channelId",
      cf.filename AS "filename",
      cf.mime_type AS "mimeType",
      cf.size_bytes::int AS "sizeBytes",
      cf.width::int AS "width",
      cf.height::int AS "height",
      cf.thumbnail_key AS "thumbnailKey",
      cf.created_at::text AS "createdAt",
      cf.uploader_type AS "uploaderType",
      cf.uploader_id::text AS "uploaderId",
      CASE
        WHEN cf.uploader_type = 'user' THEN u.name
        WHEN cf.uploader_type = 'agent' THEN ag.name
        WHEN cf.uploader_type = 'external_projection' THEN eap.display_name
        ELSE NULL
      END AS "uploaderName",
      CASE
        WHEN cf.uploader_type = 'user' THEN u.display_name
        WHEN cf.uploader_type = 'agent' THEN ag.display_name
        WHEN cf.uploader_type = 'external_projection' THEN eap.display_name
        ELSE NULL
      END AS "uploaderDisplayName",
      cf.source_channel_id::text AS "sourceChannelId",
      cf.source_type AS "sourceType",
      cf.parent_message_id::text AS "parentMessageId"
    FROM candidate_files cf
    LEFT JOIN users u
      ON cf.uploader_type = 'user'
     AND u.id::text = cf.uploader_id
    LEFT JOIN agents ag
      ON cf.uploader_type = 'agent'
     AND ag.id::text = cf.uploader_id
    LEFT JOIN external_actor_projections eap
      ON cf.uploader_type = 'external_projection'
     AND eap.id::text = cf.uploader_id
    ORDER BY cf.created_at DESC, cf.id DESC
    LIMIT ${limit}
  `);

  return rows.rows.map((row) => {
    const r = row as Record<string, unknown>;
    const parentMessageId = typeof r.parentMessageId === "string" ? r.parentMessageId : null;
    return {
      id: String(r.id),
      messageId: String(r.messageId),
      channelId: String(r.channelId),
      filename: String(r.filename),
      mimeType: String(r.mimeType),
      sizeBytes: Number(r.sizeBytes),
      width: r.width == null ? null : Number(r.width),
      height: r.height == null ? null : Number(r.height),
      thumbnailKey: typeof r.thumbnailKey === "string" ? r.thumbnailKey : null,
      createdAt: String(r.createdAt),
      uploaderType: r.uploaderType === "agent"
        ? "agent"
        : r.uploaderType === "external_projection"
          ? "external_projection"
          : "user",
      uploaderId: String(r.uploaderId),
      uploaderName: typeof r.uploaderName === "string" ? r.uploaderName : null,
      uploaderDisplayName: typeof r.uploaderDisplayName === "string" ? r.uploaderDisplayName : null,
      source: {
        type: r.sourceType === "thread" ? "thread" : "channel",
        channelId: String(r.sourceChannelId),
        parentMessageId,
        parentMessageShortId: parentMessageId ? parentMessageId.slice(0, 8) : null,
      },
    };
  });
}

// ── Thread support ───────────────────────────────────────

type CanonicalThreadRow = {
  threadChannelId: string;
  storageThreadChannelId: string;
  parentMessageId: string;
  replyCount: number;
  lastReplyAt: string | null;
};

async function listCanonicalThreadsForParentMessages(
  parentMessageIds: string[],
): Promise<CanonicalThreadRow[]> {
  const dedupedParentMessageIds = [...new Set(parentMessageIds.filter(Boolean))];
  if (dedupedParentMessageIds.length === 0) return [];

  const db = getDb();
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (c.parent_message_id)
      c.id::text AS "threadChannelId",
      c.id::text AS "storageThreadChannelId",
      c.parent_message_id::text AS "parentMessageId",
      COALESCE(stats.reply_count, 0)::int AS "replyCount",
      latest.last_reply_at::text AS "lastReplyAt"
    FROM channels c
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS reply_count
      FROM messages m
      WHERE m.channel_id = c.id
    ) stats ON TRUE
    LEFT JOIN LATERAL (
      SELECT m.created_at AS last_reply_at
      FROM messages m
      WHERE m.channel_id = c.id
      ORDER BY m.created_at DESC
      LIMIT 1
    ) latest ON TRUE
    WHERE c.type = 'thread'
      AND c.deleted_at IS NULL
      AND c.parent_message_id IN (${sql.join(dedupedParentMessageIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY
      c.parent_message_id,
      latest.last_reply_at DESC NULLS LAST,
      COALESCE(stats.reply_count, 0) DESC,
      c.created_at ASC,
      c.id ASC
  `);

  return rows.rows as CanonicalThreadRow[];
}

async function listCanonicalThreadsForChannelParentMessages(
  channelId: string,
  parentMessageIds: string[],
): Promise<CanonicalThreadRow[]> {
  const dedupedParentMessageIds = [...new Set(parentMessageIds.filter(Boolean))];
  if (dedupedParentMessageIds.length === 0) return [];

  const db = getDb();
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (c.parent_message_id)
      c.id::text AS "threadChannelId",
      c.id::text AS "storageThreadChannelId",
      c.parent_message_id::text AS "parentMessageId",
      COALESCE(stats.reply_count, 0)::int AS "replyCount",
      latest.last_reply_at::text AS "lastReplyAt"
    FROM channels c
    INNER JOIN messages pm ON pm.id = c.parent_message_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS reply_count
      FROM messages m
      WHERE m.channel_id = c.id
    ) stats ON TRUE
    LEFT JOIN LATERAL (
      SELECT m.created_at AS last_reply_at
      FROM messages m
      WHERE m.channel_id = c.id
      ORDER BY m.created_at DESC
      LIMIT 1
    ) latest ON TRUE
    WHERE c.type = 'thread'
      AND c.deleted_at IS NULL
      AND pm.channel_id = ${channelId}
      AND c.parent_message_id IN (${sql.join(dedupedParentMessageIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY
      c.parent_message_id,
      latest.last_reply_at DESC NULLS LAST,
      COALESCE(stats.reply_count, 0) DESC,
      c.created_at ASC,
      c.id ASC
  `);

  return rows.rows as CanonicalThreadRow[];
}

async function listCanonicalThreadsForChannel(channelId: string): Promise<CanonicalThreadRow[]> {
  const db = getDb();
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (c.parent_message_id)
      c.id::text AS "threadChannelId",
      c.id::text AS "storageThreadChannelId",
      c.parent_message_id::text AS "parentMessageId",
      COALESCE(stats.reply_count, 0)::int AS "replyCount",
      latest.last_reply_at::text AS "lastReplyAt"
    FROM channels c
    INNER JOIN messages pm ON pm.id = c.parent_message_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS reply_count
      FROM messages m
      WHERE m.channel_id = c.id
    ) stats ON TRUE
    LEFT JOIN LATERAL (
      SELECT m.created_at AS last_reply_at
      FROM messages m
      WHERE m.channel_id = c.id
      ORDER BY m.created_at DESC
      LIMIT 1
    ) latest ON TRUE
    WHERE c.type = 'thread'
      AND c.deleted_at IS NULL
      AND pm.channel_id = ${channelId}
    ORDER BY
      c.parent_message_id,
      latest.last_reply_at DESC NULLS LAST,
      COALESCE(stats.reply_count, 0) DESC,
      c.created_at ASC,
      c.id ASC
  `);

  return rows.rows as CanonicalThreadRow[];
}

export async function listThreadChannelIdsForParentChannel(channelId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db.execute(sql`
    SELECT DISTINCT c.id::text AS "threadChannelId"
    FROM channels c
    INNER JOIN messages pm ON pm.id = c.parent_message_id
    WHERE c.type = 'thread'
      AND c.deleted_at IS NULL
      AND pm.channel_id = ${channelId}
  `);
  return (rows.rows as Array<{ threadChannelId: string }>).map((row) => row.threadChannelId);
}

async function listRecentCanonicalThreadParentMessageIds(channelId: string, limit: number): Promise<string[]> {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];

  const db = getDb();
  const rows = await db.execute(sql`
    SELECT c.parent_message_id::text AS "parentMessageId"
    FROM channels c
    INNER JOIN messages pm ON pm.id = c.parent_message_id
    WHERE c.type = 'thread'
      AND c.deleted_at IS NULL
      AND pm.channel_id = ${channelId}
    GROUP BY c.parent_message_id
    ORDER BY max(pm.seq) DESC, c.parent_message_id DESC
    LIMIT ${boundedLimit}
  `);

  return (rows.rows as Array<{ parentMessageId: string }>).map((row) => row.parentMessageId);
}

export async function listRecentThreadParentMessageIdsForChannelView(channelId: string, limit: number): Promise<string[]> {
  const channel = await getChannel(channelId);
  if (channel?.type !== "joint") {
    return listRecentCanonicalThreadParentMessageIds(channelId, limit);
  }

  const resolved = await resolveChannelAccess({ serverId: channel.serverId, channelId });
  if (!resolved || resolved.kind !== "joint") return [];
  return listRecentCanonicalThreadParentMessageIds(resolved.canonicalChannelId, limit);
}

async function getCanonicalThreadForParentMessage(parentMessageId: string): Promise<CanonicalThreadRow | null> {
  const [row] = await listCanonicalThreadsForParentMessages([parentMessageId]);
  return row ?? null;
}

async function listThreadRowsForChannelView(
  channelId: string,
  parentMessageIds?: string[],
): Promise<CanonicalThreadRow[]> {
  const parentScope = parentMessageIds ? [...new Set(parentMessageIds.filter(Boolean))] : undefined;
  if (parentScope && parentScope.length === 0) return [];

  const channel = await getChannel(channelId);
  if (channel?.type !== "joint") {
    return parentScope
      ? listCanonicalThreadsForChannelParentMessages(channelId, parentScope)
      : listCanonicalThreadsForChannel(channelId);
  }

  const resolved = await resolveChannelAccess({ serverId: channel.serverId, channelId });
  if (!resolved || resolved.kind !== "joint") return [];

  const canonicalThreads = parentScope
    ? await listCanonicalThreadsForChannelParentMessages(resolved.canonicalChannelId, parentScope)
    : await listCanonicalThreadsForChannel(resolved.canonicalChannelId);
  if (canonicalThreads.length === 0) return [];

  const projections = await Promise.all(
    canonicalThreads.map(async (thread) => ({
      thread,
      localProjection: (await listActiveJointThreadProjectionRows({
        canonicalThreadChannelId: thread.threadChannelId,
        serverId: channel.serverId,
      }))[0] ?? null,
    })),
  );

  return projections
    .filter((entry): entry is typeof entry & { localProjection: JointThreadProjection } => Boolean(entry.localProjection))
    .map(({ thread, localProjection }) => ({
      ...thread,
      threadChannelId: localProjection.localThreadChannelId,
      storageThreadChannelId: thread.threadChannelId,
    }));
}

// Stamps the thread CHANNEL id onto the PARENT message's `messages.thread_id`
// column. This is the single writer of that column: a thread parent gains its
// `thread_id` reference once its thread channel is resolved. Reply messages
// *inside* a thread keep `thread_id = null` and live in the thread channel
// itself (see `schema.ts` `messages.threadId` comment for the contract).
//
// getOrCreateThread calls this on every resolution, and the value is almost
// always already set. Skip the no-op: an UPDATE writes a new row version even
// when nothing changes, and when that version is not HOT it re-inserts the row
// into every messages index, including the full-text GIN pending list.
async function syncParentMessageThreadId(
  parentMessageId: string,
  threadChannelId: string,
  executor: DatabaseExecutor = getDb(),
) {
  await executor.update(messages)
    .set({ threadId: threadChannelId })
    .where(and(
      eq(messages.id, parentMessageId),
      sql`${messages.threadId} IS DISTINCT FROM ${threadChannelId}`,
    ));
}

/**
 * Every creator of a root's canonical thread queues on the root message row
 * before inserting the thread. Slack inbound locks the root FOR UPDATE and
 * then inserts the thread ON CONFLICT; if this path inserted first, its
 * uncommitted idx_channels_active_thread_parent entry made inbound wait on it
 * while its parent_message_id FK share (and the thread_id stamp) waited on
 * inbound's root lock: a 40P01 cycle. FOR NO KEY UPDATE is enough to queue
 * behind that FOR UPDATE and matches the thread_id stamp this transaction
 * writes anyway; it does not block readers' FOR KEY SHARE.
 */
async function lockThreadRootMessageForCreate(executor: DatabaseExecutor, parentMessageId: string) {
  await executor.select({ id: messages.id })
    .from(messages)
    .where(eq(messages.id, parentMessageId))
    .for("no key update");
}

/**
 * Find or create a thread channel for a parent message.
 * Thread = channel with type="thread" and parentMessageId set.
 *
 * This function never writes thread_follows rows. Follow rows are written only by:
 *   - the reply-broadcast path in messageService (sender → 'replied', parent author → 'authored')
 *   - mention handling in messageService (mentioned → 'mentioned')
 *   - explicit manual follow via the /channels/threads/follow route
 *
 * Rationale: opening a thread panel must not auto-follow — pollution of the
 * Threads list by view-only opens was the bug this contract fixes.
 */
export async function getOrCreateThread(
  parentMessageId: string,
  _creatorId: string,
  _creatorType: "user" | "agent",
): Promise<{ id: string; serverId: string; parentMessageId: string; created: boolean }> {
  const db = getDb();

  const existing = await getCanonicalThreadForParentMessage(parentMessageId);
  if (existing) {
    const [parentThread] = await db
      .select({
        serverId: channels.serverId,
        parentThreadId: sql<string | null>`(SELECT ${messages.threadId} FROM ${messages} WHERE ${messages.id} = ${parentMessageId})`,
      })
      .from(channels)
      .where(eq(channels.id, existing.threadChannelId))
      .limit(1);
    if (!parentThread) throw new Error("Canonical thread channel not found");
    // Usually already stamped. Still re-stamp when it is missing or when the
    // canonical thread among duplicates has changed.
    if (parentThread.parentThreadId !== existing.threadChannelId) {
      await syncParentMessageThreadId(parentMessageId, existing.threadChannelId);
    }
    return {
      id: existing.threadChannelId,
      serverId: parentThread.serverId,
      parentMessageId,
      created: false,
    };
  }

  // Get parent message to find its channel and author
  const [parentMsg] = await db
    .select()
    .from(messages)
    .where(eq(messages.id, parentMessageId));
  if (!parentMsg) throw new Error("Parent message not found");

  // Get parent channel to find serverId
  const [parentChannel] = await db
    .select({ serverId: channels.serverId })
    .from(channels)
    .where(eq(channels.id, parentMsg.channelId));
  if (!parentChannel) throw new Error("Parent channel not found");

  // Create the thread channel and stamp the parent's thread_id in one
  // transaction. As two autocommit statements, a failed or timed-out stamp
  // left a committed thread whose parent carried no thread_id; search relies
  // on "a thread's parent always carries its thread_id".
  const threadName = `thread-${parentMessageId.slice(0, 8)}`;
  const threadChannel = await db.transaction(async (tx) => {
    await lockThreadRootMessageForCreate(tx, parentMessageId);
    const [inserted] = await tx.insert(channels).values({
      serverId: parentChannel.serverId,
      name: threadName,
      type: "thread",
      parentMessageId,
    }).onConflictDoNothing().returning();
    if (inserted) await syncParentMessageThreadId(parentMessageId, inserted.id, tx);
    return inserted;
  });

  if (threadChannel) {
    return { id: threadChannel.id, serverId: parentChannel.serverId, parentMessageId, created: true };
  }

  const canonical = await getCanonicalThreadForParentMessage(parentMessageId);
  if (!canonical) throw new Error("Thread creation conflicted but no canonical thread was found");
  await syncParentMessageThreadId(parentMessageId, canonical.threadChannelId);
  return { id: canonical.threadChannelId, serverId: parentChannel.serverId, parentMessageId, created: false };
}

export async function getOrCreateThreadForChannel(
  parentChannelId: string,
  parentMessageId: string,
  creatorId: string,
  creatorType: "user" | "agent",
): Promise<{ id: string; serverId: string; parentMessageId: string; created: boolean; canonicalThreadChannelId: string }> {
  const parentChannel = await getChannel(parentChannelId);
  if (!parentChannel) throw new Error("Parent channel not found");

  if (parentChannel.type !== "joint") {
    const db = getDb();
    const [parentMsg] = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, parentMessageId));
    if (!parentMsg || parentMsg.channelId !== parentChannelId) {
      throw new Error("Parent message not found");
    }
    const thread = await getOrCreateThread(parentMessageId, creatorId, creatorType);
    return { ...thread, canonicalThreadChannelId: thread.id };
  }

  const parentProjection = await resolveChannelAccess({ serverId: parentChannel.serverId, channelId: parentChannelId });
  if (!parentProjection || parentProjection.kind !== "joint") {
    throw new Error("Parent channel not found");
  }

  const db = getDb();
  const [parentMsg] = await db
    .select({ id: messages.id, channelId: messages.channelId })
    .from(messages)
    .where(eq(messages.id, parentMessageId));
  if (!parentMsg || parentMsg.channelId !== parentProjection.canonicalChannelId) {
    throw new Error("Parent message not found");
  }

  const canonicalThread = await getOrCreateThread(parentMessageId, creatorId, creatorType);

  const [existingJointThread] = await db
    .select({ id: jointChannels.id })
    .from(jointChannels)
    .where(and(
      eq(jointChannels.canonicalChannelId, canonicalThread.id),
      eq(jointChannels.status, "active"),
    ))
    .limit(1);

  const jointThreadId = existingJointThread?.id ?? (await db.insert(jointChannels).values({
    canonicalChannelId: canonicalThread.id,
    createdByServerId: parentChannel.serverId,
    createdByUserId: creatorType === "user" ? creatorId : null,
    status: "active",
  }).returning({ id: jointChannels.id }))[0].id;

  const parentProjections = await getActiveJointChannelProjectionsByLocalChannel(parentChannelId);
  let localThreadId: string | null = null;
  let createdLocalProjection = false;

  for (const projection of parentProjections) {
    const projectionThread = await ensureJointThreadProjectionForLocalParent(db, {
      jointThreadId,
      localParentProjection: projection,
      parentMessageId,
      joinedByUserId: creatorType === "user" && projection.serverId === parentChannel.serverId ? creatorId : null,
    });
    createdLocalProjection = createdLocalProjection || projectionThread.created;

    if (projection.localChannelId === parentChannelId) {
      localThreadId = projectionThread.localThreadChannelId;
    }
  }

  if (!localThreadId) throw new Error("Thread projection not found");
  return {
    id: localThreadId,
    serverId: parentChannel.serverId,
    parentMessageId,
    created: canonicalThread.created || createdLocalProjection,
    canonicalThreadChannelId: canonicalThread.id,
  };
}

type ThreadSummaryLatestReply = {
  messageId: string;
  seq: number;
  preview: string;
  senderId: string;
  senderType: "user" | "agent" | "system" | "external_projection";
  /** Stable unique handle retained for identity/backward compatibility. */
  senderName: string;
  /** UI label: canonical display name, falling back to the stable handle. */
  senderDisplayName: string;
  senderAvatarUrl: string | null;
  createdAt: string;
};

type ThreadSummaryResult = {
  threadChannelId: string;
  replyCount: number;
  lastReplyAt: string | null;
  participantIds: string[];
  unreadCount: number;
  firstUnreadMessageId: string | null;
  latestReplies: ThreadSummaryLatestReply[];
};

/**
 * Get thread summary info for messages in a channel.
 * Returns map of parentMessageId → viewer-aware thread summary metadata.
 */
export async function getThreadSummaries(channelId: string): Promise<
  Record<string, ThreadSummaryResult>
>;
export async function getThreadSummaries(
  channelId: string,
  opts?: ThreadSummaryOptions,
): Promise<
  Record<string, ThreadSummaryResult>
>;
export async function getThreadSummaries(
  channelId: string,
  opts?: ThreadSummaryOptions,
): Promise<
  Record<string, ThreadSummaryResult>
> {
  const traceQuery = opts?.traceQuery ?? untracedDbQuery;

  const threads = await traceQuery(
    "channel_threads.list_by_channel",
    () => listThreadRowsForChannelView(channelId, opts?.parentMessageIds),
    (rows) => ({
      parent_message_scope_count: opts?.parentMessageIds?.length ?? null,
      parent_message_scope_source: opts?.parentMessageScopeSource ?? null,
      row_count: rows.length,
    }),
  );

  if (threads.length === 0) return {};

  const db = getDb();
  const result: Record<string, ThreadSummaryResult> = {};
  const threadChannelIds = threads.map(thread => thread.threadChannelId);
  const threadStorageRows = threads.map(thread => sql`(${thread.threadChannelId}::uuid, ${thread.storageThreadChannelId}::uuid)`);

  // Batch-fetch unique participants (senders in each thread)
  const participantRows = await traceQuery(
    "channel_threads.participants_by_threads",
    () => db.execute(sql`
      SELECT
        input_threads.thread_id::text AS "threadChannelId",
        m.sender_id AS "senderId"
      FROM (VALUES ${sql.join(threadStorageRows, sql`, `)}) AS input_threads(thread_id, storage_thread_id)
      INNER JOIN messages m
        ON m.channel_id = input_threads.storage_thread_id
      GROUP BY input_threads.thread_id, m.sender_id
    `),
    (rows) => ({
      input_count: threadChannelIds.length,
      participant_rows_count: rows.rows.length,
    }),
  );
  const participantsByThreadId = new Map<string, string[]>();
  for (const row of participantRows.rows as Array<{ threadChannelId: string; senderId: string }>) {
    const list = participantsByThreadId.get(row.threadChannelId) ?? [];
    list.push(row.senderId);
    participantsByThreadId.set(row.threadChannelId, list);
  }

  const unreadByThreadId = new Map<string, { unreadCount: number; firstUnreadMessageId: string | null }>();
  if (opts?.userId) {
    const unreadRows = await traceQuery(
      "channel_threads.unread_by_threads",
      () => db.execute(sql`
        SELECT
          input_threads.thread_id::text AS "threadChannelId",
          first_unread.id::text AS "firstUnreadMessageId",
          COALESCE(unread.unread_count, 0)::int AS "unreadCount"
        FROM (VALUES ${sql.join(threadStorageRows, sql`, `)}) AS input_threads(thread_id, storage_thread_id)
        LEFT JOIN thread_follows tf
          ON tf.thread_channel_id = input_threads.thread_id
          AND tf.follower_type = 'user'
          AND tf.follower_id = ${opts.userId}
          AND tf.done_at IS NULL
          AND tf.unfollowed_at IS NULL
        LEFT JOIN user_channel_read_cursors rc
          ON rc.channel_id = input_threads.thread_id
          AND rc.user_id = ${opts.userId}
        LEFT JOIN LATERAL (
          SELECT m.id
          FROM messages m
          WHERE tf.thread_channel_id IS NOT NULL
            AND m.channel_id = input_threads.storage_thread_id
            AND m.seq > COALESCE(rc.last_read_seq, 0)
          ORDER BY m.seq ASC
          LIMIT 1
        ) first_unread ON true
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS unread_count
          FROM messages m
          WHERE tf.thread_channel_id IS NOT NULL
            AND m.channel_id = input_threads.storage_thread_id
            AND m.seq > COALESCE(rc.last_read_seq, 0)
        ) unread ON true
      `),
      (rows) => ({
        input_count: threadChannelIds.length,
        unread_rows_count: rows.rows.length,
        unread_threads_count: (rows.rows as Array<{ unreadCount: number }>).filter((row) => row.unreadCount > 0).length,
      }),
    );
    for (const row of unreadRows.rows as Array<{ threadChannelId: string; unreadCount: number; firstUnreadMessageId: string | null }>) {
      unreadByThreadId.set(row.threadChannelId, {
        unreadCount: row.unreadCount,
        firstUnreadMessageId: row.firstUnreadMessageId ?? null,
      });
    }
  }

  // Latest conversation replies per thread — the "server sends the newest 3
  // upfront" leg of the inline reply previews design (task #47/#592). System
  // events remain part of replyCount and the full thread history, but the
  // compact preview is a human/agent conversation summary, not an audit log.
  const latestReplyRows = await traceQuery(
    "channel_threads.latest_replies_by_threads",
    () => db.execute(sql`
      SELECT
        input_threads.thread_id::text AS "threadChannelId",
        latest.id::text AS "messageId",
        latest.seq::int AS "seq",
        latest.content AS "content",
        latest.sender_id AS "senderId",
        latest.sender_type AS "senderType",
        latest.message_type AS "messageType",
        latest.created_at AS "createdAt"
      FROM (VALUES ${sql.join(threadStorageRows, sql`, `)}) AS input_threads(thread_id, storage_thread_id)
      JOIN LATERAL (
        SELECT m.id, m.seq, m.content, m.sender_id, m.sender_type, m.message_type, m.created_at
        FROM messages m
        WHERE m.channel_id = input_threads.storage_thread_id
          AND m.message_type <> 'system'
        ORDER BY m.seq DESC
        LIMIT 3
      ) latest ON true
    `),
    (rows) => ({
      input_count: threadChannelIds.length,
      latest_reply_rows_count: rows.rows.length,
    }),
  );
  type LatestReplyRow = {
    threadChannelId: string;
    messageId: string;
    seq: number;
    content: string;
    senderId: string;
    senderType: "user" | "agent" | "external_projection";
    messageType: string;
    createdAt: string | Date;
  };
  const latestRows = latestReplyRows.rows as LatestReplyRow[];
  const replySenderUserIds = [...new Set(latestRows.filter((r) => r.senderType === "user" && r.messageType !== "system").map((r) => r.senderId))];
  const replySenderAgentIds = [...new Set(latestRows.filter((r) => r.senderType === "agent").map((r) => r.senderId))];
  const replySenderNames = new Map<string, string>();
  const replySenderDisplayNames = new Map<string, string>();
  const replySenderAvatars = new Map<string, string | null>();
  const externalReplyNames = new Map<string, string>();
  const externalReplyAvatars = new Map<string, string | null>();
  if (replySenderUserIds.length > 0) {
    const rows = await db
      .select({ id: users.id, name: users.name, displayName: users.displayName, avatarUrl: users.avatarUrl })
      .from(users)
      .where(inArray(users.id, replySenderUserIds));
    for (const row of rows) {
      const senderName = row.name || "User";
      replySenderNames.set(row.id, senderName);
      replySenderDisplayNames.set(row.id, row.displayName || senderName);
      replySenderAvatars.set(row.id, row.avatarUrl ?? null);
    }
  }
  if (replySenderAgentIds.length > 0) {
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
      })
      .from(agents)
      .where(inArray(agents.id, replySenderAgentIds));
    for (const row of rows) {
      const senderName = row.name || "Agent";
      replySenderNames.set(row.id, senderName);
      replySenderDisplayNames.set(row.id, row.displayName || senderName);
      replySenderAvatars.set(row.id, row.avatarUrl ?? null);
    }
  }
  const externalReplyMessageIds = latestRows
    .filter((row) => row.senderType === "external_projection")
    .map((row) => row.messageId);
  if (externalReplyMessageIds.length > 0) {
    const rows = await db
      .select({
        messageId: externalMessageAuthorFacts.messageId,
        displayName: externalMessageAuthorFacts.displayName,
        frozenAvatarUrl: externalMessageAuthorFacts.avatarUrl,
        frozenAvatarDigest: externalMessageAuthorFacts.avatarDigest,
        avatarPublicUrl: externalProjectionAvatarArtifacts.publicUrl,
        avatarSourceDigest: externalProjectionAvatarArtifacts.sourceDigest,
        avatarState: externalProjectionAvatarArtifacts.state,
      })
      .from(externalMessageAuthorFacts)
      .leftJoin(
        externalProjectionAvatarArtifacts,
        eq(externalProjectionAvatarArtifacts.id, externalMessageAuthorFacts.avatarArtifactId),
      )
      .where(inArray(externalMessageAuthorFacts.messageId, externalReplyMessageIds));
    for (const row of rows) {
      externalReplyNames.set(row.messageId, row.displayName);
      externalReplyAvatars.set(
        row.messageId,
        row.avatarState === "active"
          && row.avatarPublicUrl === row.frozenAvatarUrl
          && row.avatarSourceDigest === row.frozenAvatarDigest
          ? row.avatarPublicUrl
          : null,
      );
    }
    if (externalReplyNames.size !== new Set(externalReplyMessageIds).size) {
      throw new Error("External projection thread reply is missing immutable author fact");
    }
  }
  const latestRepliesByThreadId = new Map<string, ThreadSummaryLatestReply[]>();
  for (const row of latestRows) {
    const isSystem = row.messageType === "system";
    const list = latestRepliesByThreadId.get(row.threadChannelId) ?? [];
    list.push({
      messageId: row.messageId,
      seq: row.seq,
      preview: row.content,
      senderId: row.senderId,
      senderType: isSystem ? "system" : row.senderType,
      senderName: isSystem
        ? "System"
        : row.senderType === "external_projection"
          ? (externalReplyNames.get(row.messageId) ?? "External user")
          : (replySenderNames.get(row.senderId) ?? (row.senderType === "agent" ? "Agent" : "User")),
      senderDisplayName: isSystem
        ? "System"
        : row.senderType === "external_projection"
          ? (externalReplyNames.get(row.messageId) ?? "External user")
          : (replySenderDisplayNames.get(row.senderId) ?? (row.senderType === "agent" ? "Agent" : "User")),
      senderAvatarUrl: isSystem
        ? null
        : row.senderType === "external_projection"
          ? (externalReplyAvatars.get(row.messageId) ?? null)
          : (replySenderAvatars.get(row.senderId) ?? null),
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    });
    latestRepliesByThreadId.set(row.threadChannelId, list);
  }
  for (const list of latestRepliesByThreadId.values()) list.sort((a, b) => a.seq - b.seq);

  for (const thread of threads) {
    if (!thread.parentMessageId) continue;
    const unread = unreadByThreadId.get(thread.threadChannelId);
    result[thread.parentMessageId] = {
      threadChannelId: thread.threadChannelId,
      replyCount: thread.replyCount,
      lastReplyAt: thread.lastReplyAt ?? null,
      participantIds: participantsByThreadId.get(thread.threadChannelId) ?? [],
      unreadCount: unread?.unreadCount ?? 0,
      firstUnreadMessageId: unread?.firstUnreadMessageId ?? null,
      latestReplies: latestRepliesByThreadId.get(thread.threadChannelId) ?? [],
    };
  }

  return result;
}

export async function getThreadSummariesForParentMessages(parentMessageIds: string[]): Promise<
  Record<string, { threadChannelId: string; replyCount: number }>
> {
  const threads = await listCanonicalThreadsForParentMessages(parentMessageIds);
  if (threads.length === 0) return {};

  const result: Record<string, { threadChannelId: string; replyCount: number }> = {};
  for (const thread of threads) {
    if (!thread.parentMessageId) continue;
    result[thread.parentMessageId] = {
      threadChannelId: thread.threadChannelId,
      replyCount: thread.replyCount,
    };
  }

  return result;
}

/**
 * Get thread info for a single parent message.
 */
export async function getThreadInfo(parentMessageId: string): Promise<{
  threadChannelId: string;
  replyCount: number;
  lastReplyAt: string | null;
  participantIds: string[];
} | null> {
  const db = getDb();
  const thread = await getCanonicalThreadForParentMessage(parentMessageId);
  if (!thread) return null;

  const participants = await db
    .select({ senderId: messages.senderId })
    .from(messages)
    .where(eq(messages.channelId, thread.threadChannelId))
    .groupBy(messages.senderId);

  return {
    threadChannelId: thread.threadChannelId,
    replyCount: thread.replyCount,
    lastReplyAt: thread.lastReplyAt ?? null,
    participantIds: participants.map(p => p.senderId),
  };
}

export async function getThreadInfoForChannel(channelId: string, parentMessageId: string): Promise<{
  threadChannelId: string;
  replyCount: number;
  lastReplyAt: string | null;
  participantIds: string[];
} | null> {
  const [thread] = await listThreadRowsForChannelView(channelId, [parentMessageId]);
  if (!thread || thread.parentMessageId !== parentMessageId) return null;

  const db = getDb();
  const participants = await db
    .select({ senderId: messages.senderId })
    .from(messages)
    .where(eq(messages.channelId, thread.storageThreadChannelId))
    .groupBy(messages.senderId);

  return {
    threadChannelId: thread.threadChannelId,
    replyCount: thread.replyCount,
    lastReplyAt: thread.lastReplyAt ?? null,
    participantIds: participants.map(p => p.senderId),
  };
}

// ── Followed threads ─────────────────────────────────────

export type FollowedThreadMetadataRow = {
  threadChannelId: string;
  storageThreadChannelId: string;
  activityUpperBoundSeq?: number | string | null;
};

export type FollowedThreadStatsRow = {
  threadChannelId: string;
  replyCount: number;
  lastReplyAt: string | null;
  lastReplyMessageId: string | null;
  /** Exact latest activity seq as a canonical decimal string (task #361 B1). */
  lastReplySeqExact: string | null;
  lastReplyContent: string | null;
  lastReplySenderType: string | null;
  lastReplySenderId: string | null;
  firstUnreadMessageId: string | null;
  unreadCount: number;
};

type FollowedThreadStatsSource = "rw_mv" | "pg_legacy";
/**
 * Why a followed-thread stats read ran on Postgres. None of these is a fallback
 * for an absent or failing RisingWave (that is an error): they are the reads the
 * RW view cannot answer (a per-thread activity upper bound) and consistency
 * reads inside an authority transaction ("history_cutoff" is now only the label
 * of an authority-transaction read that carries a cutoff; a cutoff alone no
 * longer reroutes a read to Postgres).
 */
type FollowedThreadStatsPostgresReason = "history_cutoff" | "activity_upper_bound" | "authority_transaction";
type FollowedThreadStatsFallbackReason = "none" | FollowedThreadStatsPostgresReason;

const RISINGWAVE_FOLLOWED_THREAD_STATS_CONTRACT_VERSION = 1;
// The stats read is served by rw_followed_threads_v4 (072): v3's exact stats
// columns (070: the unified chain's unread rule, a row for every follow state)
// plus the parent/task columns the active path reads. One view serves both, so
// v3 is no longer read and can be dropped once no running version reads it.
// latest_preview is a 141-char prefix, enough for the 140-char preview.
const RISINGWAVE_FOLLOWED_THREAD_STATS_VIEW = "rw_followed_threads_v4";
// This query is normally sub-100ms; 2s catches RW serving stalls without making
// the trace stream noisy during ordinary latency variance.
const RISINGWAVE_FOLLOWED_THREAD_STATS_SLOW_REPLAY_TRACE_MS = 2_000;
const RISINGWAVE_FOLLOWED_THREAD_STATS_SLOW_REPLAY_TRACE_MS_ENV = "RISINGWAVE_FOLLOWED_THREAD_STATS_SLOW_REPLAY_TRACE_MS";
const RISINGWAVE_FOLLOWED_THREAD_STATS_REPLAY_THREAD_CAP = 100;
const RISINGWAVE_FOLLOWED_THREAD_STATS_REPLAY_THREAD_CAP_ENV = "RISINGWAVE_FOLLOWED_THREAD_STATS_REPLAY_THREAD_CAP";
const RISINGWAVE_FOLLOWED_THREAD_STATS_QUERY_NAME = "channels.followed_threads_stats_by_threads";

type RisingWaveFollowedThreadStatsReplayQuery = {
  sql: string;
  params: string[];
  threadChannelIds: string[];
};

function followedThreadStatsTraceAttrs(
  statsSource: FollowedThreadStatsSource,
  fallbackReason: FollowedThreadStatsFallbackReason,
): TraceAttributes {
  return {
    stats_source: statsSource,
    fallback_reason: fallbackReason,
    contract_version: RISINGWAVE_FOLLOWED_THREAD_STATS_CONTRACT_VERSION,
  };
}

function recordFollowedThreadStatsBackendFailed(error: unknown) {
  addTraceEvent("followed_threads.stats_backend.failed", {
    ...followedThreadStatsTraceAttrs("rw_mv", "none"),
    error_class: errorClassOf(error),
  });
}

/**
 * RW served fewer stats rows than the followed threads asked for: CDC lag (a
 * thread followed seconds ago that the view has not caught up with yet). Not an
 * error and not a Postgres reroute; the missing threads render without stats.
 */
function recordFollowedThreadStatsRowMismatch(expectedRows: number, actualRows: number) {
  addTraceEvent("followed_threads.stats_backend.row_mismatch", {
    ...followedThreadStatsTraceAttrs("rw_mv", "none"),
    followed_threads_count: expectedRows,
    stats_rows_count: actualRows,
    missing_stats_rows_count: Math.max(0, expectedRows - actualRows),
    likely_cause: "cdc_lag",
  });
}

function recordFollowedThreadStatsBackendSucceeded(rowCount: number) {
  addTraceEvent("followed_threads.stats_backend.succeeded", {
    ...followedThreadStatsTraceAttrs("rw_mv", "none"),
    backend: "risingwave",
    rw_followed_thread_stats_view: RISINGWAVE_FOLLOWED_THREAD_STATS_VIEW,
    followed_threads_count: rowCount,
    stats_rows_count: rowCount,
  });
}

function getFollowedThreadStatsSlowReplayTraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RISINGWAVE_FOLLOWED_THREAD_STATS_SLOW_REPLAY_TRACE_MS_ENV]?.trim();
  if (!raw) return RISINGWAVE_FOLLOWED_THREAD_STATS_SLOW_REPLAY_TRACE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return RISINGWAVE_FOLLOWED_THREAD_STATS_SLOW_REPLAY_TRACE_MS;
  return parsed;
}

function getFollowedThreadStatsReplayThreadCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RISINGWAVE_FOLLOWED_THREAD_STATS_REPLAY_THREAD_CAP_ENV]?.trim();
  if (!raw) return RISINGWAVE_FOLLOWED_THREAD_STATS_REPLAY_THREAD_CAP;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return RISINGWAVE_FOLLOWED_THREAD_STATS_REPLAY_THREAD_CAP;
  return parsed;
}

function buildRisingWaveFollowedThreadStatsReplayQuery(
  serverId: string,
  userId: string,
  threadChannelIds: string[],
): RisingWaveFollowedThreadStatsReplayQuery {
  const values = threadChannelIds.map((_, index) => `($${index + 3}::varchar)`).join(", ");
  return {
    sql: `
      WITH input_threads(thread_channel_id) AS (
        VALUES ${values}
      )
      SELECT
        s.thread_channel_id::text AS "threadChannelId",
        COALESCE(s.reply_count, 0)::int AS "replyCount",
        CASE
          WHEN s.last_reply_at IS NULL THEN NULL::text
          ELSE to_char(s.last_reply_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'
        END AS "lastReplyAt",
        s.latest_message_id::text AS "lastReplyMessageId",
        -- Same tuple as lastReplyMessageId: rw_followed_threads_v4 joins
        -- latest.seq = stats.latest_seq, so id and seq cannot describe
        -- different messages. Never splice these from separate sources.
        s.latest_seq::text AS "lastReplySeqExact",
        s.latest_preview AS "lastReplyContent",
        s.latest_sender_type AS "lastReplySenderType",
        s.latest_sender_id AS "lastReplySenderId",
        s.first_unread_message_id::text AS "firstUnreadMessageId",
        COALESCE(s.unread_count, 0)::int AS "unreadCount"
      FROM input_threads i
      JOIN ${RISINGWAVE_FOLLOWED_THREAD_STATS_VIEW} s
        ON s.server_id = $1
       AND s.user_id = $2
       AND s.thread_channel_id = i.thread_channel_id
    `,
    params: [serverId, userId, ...threadChannelIds],
    threadChannelIds,
  };
}

function recordSlowRisingWaveFollowedThreadStatsReplayQuery(
  durationMs: number,
  replayQuery: RisingWaveFollowedThreadStatsReplayQuery,
  statsRowsCount: number,
): void {
  const thresholdMs = getFollowedThreadStatsSlowReplayTraceMs();
  if (durationMs < thresholdMs) return;

  const threadCap = getFollowedThreadStatsReplayThreadCap();
  const replayPayloadTruncated = replayQuery.threadChannelIds.length > threadCap;
  const stableQueryHash = createHash("sha256")
    .update(`${RISINGWAVE_FOLLOWED_THREAD_STATS_QUERY_NAME}\0${RISINGWAVE_FOLLOWED_THREAD_STATS_VIEW}`)
    .digest("hex");
  const attrs: TraceAttributes = {
    ...followedThreadStatsTraceAttrs("rw_mv", "none"),
    backend: "risingwave",
    query_name: RISINGWAVE_FOLLOWED_THREAD_STATS_QUERY_NAME,
    query_hash: stableQueryHash,
    query_shape_hash: stableQueryHash,
    duration_ms: durationMs,
    slow_threshold_ms: thresholdMs,
    rw_followed_thread_stats_view: RISINGWAVE_FOLLOWED_THREAD_STATS_VIEW,
    followed_threads_count: replayQuery.threadChannelIds.length,
    stats_rows_count: statsRowsCount,
    replay_sql_dialect: "risingwave_pgwire",
    replay_sql_parameterized: true,
    replay_param_count: replayQuery.params.length,
    replay_thread_cap: threadCap,
    replay_payload_truncated: replayPayloadTruncated,
    replay_contains_dsn: false,
    replay_contains_message_content: false,
    replay_connection_label: "risingwave",
  };
  if (!replayPayloadTruncated) {
    const replayParamsJson = JSON.stringify(replayQuery.params);
    attrs.replay_sql = replayQuery.sql;
    attrs.replay_params_json = replayParamsJson;
    attrs.replay_hash = createHash("sha256").update(`${replayQuery.sql}\0${replayParamsJson}`).digest("hex");
  }
  addTraceEvent("followed_threads.stats_backend.slow_replay_query", attrs);
}

async function getFollowedThreadStatsFromRisingWave(
  serverId: string,
  userId: string,
  threads: FollowedThreadMetadataRow[],
  traceQuery: DbQueryTracer,
  historyCutoffPresent: boolean,
): Promise<FollowedThreadStatsRow[]> {
  // CONTRACT: rw_followed_threads_v4 is an endpoint-shaped serving read
  // model for GET /api/channels/threads/followed and the Done / Activity
  // followed-thread lists, for every follow state. It must return all stats
  // fields in one lookup keyed by (server_id, user_id, thread_channel_id). Do
  // not replace this with request-time joins across generic RW MVs; that shape
  // was benchmarked slower than Postgres.
  if (threads.length === 0) return [];
  const client = getRisingWavePool();
  if (!client) throw new RisingWaveNotConfiguredError("followed-thread stats");

  const threadIds = threads.map((thread) => thread.threadChannelId);
  const replayQuery = buildRisingWaveFollowedThreadStatsReplayQuery(serverId, userId, threadIds);
  const queryStart = performance.now();
  const result = await traceQuery(
    RISINGWAVE_FOLLOWED_THREAD_STATS_QUERY_NAME,
    () => client.query(replayQuery.sql, replayQuery.params),
    (queryResult) => ({
      ...followedThreadStatsTraceAttrs("rw_mv", "none"),
      backend: "risingwave",
      rw_followed_thread_stats_view: RISINGWAVE_FOLLOWED_THREAD_STATS_VIEW,
      followed_threads_count: threads.length,
      stats_rows_count: queryResult.rows.length,
      // A cutoff no longer reroutes to Postgres; it only withholds old previews.
      history_cutoff_present: historyCutoffPresent,
    }),
  );
  recordSlowRisingWaveFollowedThreadStatsReplayQuery(performance.now() - queryStart, replayQuery, result.rows.length);
  return result.rows as FollowedThreadStatsRow[];
}

/**
 * Followed-thread stats from Postgres, for the reads the RW view cannot answer
 * (activity upper bound) and for authority transactions. Never
 * a substitute for an absent or failing RisingWave. Exported for the test
 * reference of the RW read (src/test/risingWaveReadReference.ts).
 */
export async function getFollowedThreadStatsFromPostgres(
  userId: string,
  threads: FollowedThreadMetadataRow[],
  historyCutoff: Date | undefined,
  traceQuery: DbQueryTracer,
  postgresReason: FollowedThreadStatsPostgresReason | "none",
  executor: DatabaseExecutor = getDb(),
): Promise<FollowedThreadStatsRow[]> {
  const cutoffCondition = historyCutoff ? sql` AND m.created_at > ${historyCutoff}` : sql``;
  // The unified chain's unread rule (rw_inbox_normal_v4, 063-unified-inbox-chain.sql),
  // identical to rw_followed_threads_v4 (v3's rule): after the cursor, not own-sent, not
  // a system message the user caused (NULL causal actor = no exclusion), not a
  // noise subtype. These reads serve the documented RW gaps, so they must not
  // reintroduce the pre-063 rule.
  const unreadPredicate = sql`m.seq > COALESCE(rc.last_read_seq, 0)
              AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
              AND NOT COALESCE(m.message_type = 'system' AND m.causal_actor_type = 'user' AND m.causal_actor_id = ${userId}::text, FALSE)
              AND (m.system_subtype IS NULL OR m.system_subtype NOT IN ('channel.self_unfollow_thread', 'task.deleted_summary'))`;

  const statsRows = await traceQuery(
    "channels.followed_threads_stats_by_threads",
    () => executor.execute(sql`
      WITH input_threads(thread_id, storage_thread_id, activity_upper_bound_seq) AS (
        VALUES ${sql.join(threads.map(t => sql`(
          ${t.threadChannelId}::uuid,
          ${t.storageThreadChannelId}::uuid,
          ${t.activityUpperBoundSeq ?? null}::bigint
        )`), sql`, `)}
      ),
      stats AS (
        SELECT
          input_threads.thread_id,
          input_threads.storage_thread_id,
          count(m.id)::int AS reply_count,
          count(m.id) FILTER (WHERE ${unreadPredicate})::int AS unread_count,
          max(m.seq) AS latest_seq,
          min(m.seq) FILTER (WHERE ${unreadPredicate}) AS first_unread_seq
        FROM input_threads
        LEFT JOIN user_channel_read_cursors rc
          ON rc.channel_id = input_threads.thread_id AND rc.user_id = ${userId}
        LEFT JOIN messages m
          ON m.channel_id = input_threads.storage_thread_id
         AND (
           input_threads.activity_upper_bound_seq IS NULL
           OR m.seq <= input_threads.activity_upper_bound_seq
         )
         ${cutoffCondition}
        GROUP BY input_threads.thread_id, input_threads.storage_thread_id
      )
      SELECT
        stats.thread_id::text AS "threadChannelId",
        COALESCE(stats.reply_count, 0)::int AS "replyCount",
        latest.created_at::text AS "lastReplyAt",
        latest.id::text AS "lastReplyMessageId",
        stats.latest_seq::text AS "lastReplySeqExact",
        latest.content AS "lastReplyContent",
        latest.sender_type AS "lastReplySenderType",
        latest.sender_id AS "lastReplySenderId",
        first_unread.id::text AS "firstUnreadMessageId",
        COALESCE(stats.unread_count, 0)::int AS "unreadCount"
      FROM stats
      LEFT JOIN messages latest
        ON latest.channel_id = stats.storage_thread_id
       AND latest.seq = stats.latest_seq
      LEFT JOIN messages first_unread
        ON first_unread.channel_id = stats.storage_thread_id
       AND first_unread.seq = stats.first_unread_seq
    `),
    (result) => ({
      ...followedThreadStatsTraceAttrs("pg_legacy", postgresReason),
      followed_threads_count: threads.length,
      stats_rows_count: result.rows.length,
      history_cutoff_present: Boolean(historyCutoff),
    }),
  );
  return statsRows.rows as FollowedThreadStatsRow[];
}

async function getFollowedThreadStatsRows(
  serverId: string,
  userId: string,
  threads: FollowedThreadMetadataRow[],
  historyCutoff: Date | undefined,
  traceQuery: DbQueryTracer,
  executor?: DatabaseExecutor,
): Promise<FollowedThreadStatsRow[]> {
  if (executor) {
    // Authority transaction: a consistency read on the caller's executor.
    return getFollowedThreadStatsFromPostgres(
      userId,
      threads,
      historyCutoff,
      traceQuery,
      threads.some((thread) => thread.activityUpperBoundSeq != null)
        ? "activity_upper_bound"
        : historyCutoff
          ? "history_cutoff"
          : "authority_transaction",
      executor,
    );
  }
  // The RW view carries no per-thread activity upper bound (unfollowed threads
  // are clipped at done_through_seq), so those reads stay on Postgres.
  //
  // A plan history cutoff does NOT reroute (product decision): the numbers
  // (unreadCount, replyCount, lastReplyAt) come from RW as-is for every plan.
  // The only cutoff rule is that a free plan never sees content older than its
  // cutoff; getFollowedThreads enforces it by blanking the latest reply's
  // preview when that reply is before the cutoff.
  if (threads.some((thread) => thread.activityUpperBoundSeq != null)) {
    return getFollowedThreadStatsFromPostgres(userId, threads, historyCutoff, traceQuery, "activity_upper_bound");
  }

  const override = getActivityReadSourceOverride();
  if (override) return override.followedThreadStats({ serverId, userId, threads, traceQuery });

  // RisingWave only, for every follow state: unconfigured or a failed read errors.
  let risingWaveRows: FollowedThreadStatsRow[];
  try {
    risingWaveRows = await getFollowedThreadStatsFromRisingWave(serverId, userId, threads, traceQuery, Boolean(historyCutoff));
  } catch (error) {
    recordFollowedThreadStatsBackendFailed(error);
    throw error;
  }
  if (risingWaveRows.length !== threads.length) {
    // CDC lag: a just-followed thread the view has not caught up with yet. Serve
    // what RW has; getFollowedThreads renders a thread without a stats row from
    // its parent message (zero replies, zero unread) until the view catches up.
    recordFollowedThreadStatsRowMismatch(threads.length, risingWaveRows.length);
    return risingWaveRows;
  }
  recordFollowedThreadStatsBackendSucceeded(risingWaveRows.length);
  return risingWaveRows;
}

/** Test-only surface for the same-source frontier rule. */
/**
 * Pair the content frontier with whichever message supplied
 * `latestActivityMessageId`, or fail closed.
 *
 * Keyed on `lastReplyMessageId` rather than `replyCount`: the id is what the
 * sibling field actually used, so keying on the same thing is what makes the two
 * provably same-source. `replyCount` can disagree with the joined row after a
 * delete and would silently re-pair a reply id with a parent seq.
 */
function latestActivitySeqSameSource(
  stats: { lastReplyMessageId: string | null; lastReplySeqExact: string | null } | undefined,
  parentMessageSeq: number | string | null | undefined,
): string | null {
  if (stats?.lastReplyMessageId != null) {
    // Fail closed on a NONCANONICAL value too, not only a missing one. A
    // selected message with a seq the contract cannot represent must not be
    // published as a frontier: UInt64String is what the Done intent validates
    // against, so a partial/odd value would either be rejected downstream or
    // compare wrongly in compareUInt64String (which keys on string length).
    return canonicalUint64OrNull(stats.lastReplySeqExact);
  }
  return canonicalUint64OrNull(parentMessageSeq);
}

/** Canonical decimal UInt64String, or null. Never a coerced/partial value. */
function canonicalUint64OrNull(value: number | string | null | undefined): string | null {
  if (value == null) return null;
  // Numbers arrive from some drivers; reject anything not an exact non-negative
  // integer rather than stringifying a float or a rounded >2^53 value.
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return String(value);
  }
  return /^(0|[1-9][0-9]*)$/.test(value) ? value : null;
}

export const __testFollowedThreadFrontier = { latestActivitySeqSameSource };

/** Test-only surface for the read-state authority query's own safety contract. */
export const __testReadStateAuthority = { fetchReadStateAuthorityRows };

// Inbox residue (follow, done, notified mention) is not access authority.
// Resolve the shared guest policy before SQL pagination. null means the
// ordinary-member policy; [] means a guest with no readable channels.
async function guestInboxChannelIds(serverId: string, userId: string, executor: DatabaseExecutor): Promise<string[] | null> {
  if (await resolveHumanServerRole(serverId, userId, executor) !== "guest") return null;
  const gateEnabled = await isGuestFeatureEnabled(serverId, userId, executor);
  if (!gateEnabled) return [];
  const rows = await executor.select({ channel: channels, memberId: channelHumans.userId, parentChannelId: messages.channelId })
    .from(channels).leftJoin(channelHumans, and(
      eq(channelHumans.channelId, channels.id), eq(channelHumans.userId, userId),
    )).leftJoin(messages, eq(messages.id, channels.parentMessageId)).where(and(eq(channels.serverId, serverId), isNull(channels.deletedAt)));
  const readable = rows.filter(({ channel, memberId }) => canGuestReadChannel({
    gateEnabled, serverRole: "guest", channelType: channel.type, channelName: channel.name,
    allChannelHidden: isAllSystemChannel(channel) && !isEnabledAllChannel(channel),
    guestVisible: channel.guestVisible, guestJoinable: channel.guestJoinable,
    isChannelMember: memberId !== null, archived: channel.archivedAt !== null, deleted: false,
  })).map(({ channel }) => channel.id);
  const parents = new Set(readable);
  return [...readable, ...rows.filter(({ channel, parentChannelId }) =>
    channel.type === "thread" && parentChannelId !== null && parents.has(parentChannelId),
  ).map(({ channel }) => channel.id)];
}

function guestInboxAccessSql(ids: string[] | null, channelId: SQL): SQL {
  return ids === null ? sql`true` : ids.length === 0 ? sql`false`
    : sql`${channelId} IN (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})`;
}

/** One followed thread as GET /api/channels/threads/followed returns it. */
export type FollowedThread = {
  threadChannelId: string;
  parentMessageId: string;
  parentChannelId: string;
  parentChannelName: string;
  parentChannelType: string;
  parentMessagePreview: string;
  parentMessageSenderType: string;
  parentMessageSenderId: string;
  latestActivityPreview: string;
  latestActivitySenderType: string;
  latestActivitySenderId: string;
  latestActivitySenderName: string | null;
  latestActivityMessageId: string;
  latestActivitySeq: string | null;
  firstUnreadMessageId: string | null;
  lastActivityAt: string;
  replyCount: number;
  lastReplyAt: string | null;
  unreadCount: number;
  taskId: string | null;
  taskNumber: number | null;
  taskStatus: string | null;
  taskClaimedByType: "agent" | "user" | null;
  taskClaimedById: string | null;
  taskClaimedByName: string | null;
  maxReadSeq: number;
  readStateVersion: number;
  readState: InboxScopeReadFrontier;
  doneAt: string | null;
  isFollowing: boolean;
  unfollowedAt: string | null;
};

/** One followed thread before stats and read state: its parent message, parent channel and task. */
type FollowedThreadSourceRow = {
  threadChannelId: string;
  storageThreadChannelId: string;
  parentMessageId: string | null;
  parentChannelId: string;
  parentChannelName: string;
  parentChannelType: string;
  parentMessageContent: string;
  parentMessageCreatedAt: Date;
  parentMessageSenderType: string;
  parentMessageSenderId: string;
  parentMessageSeq: string | null;
  taskId: string | null;
  taskNumber: number | null;
  taskStatus: string | null;
  taskClaimedByType: "agent" | "user" | null;
  taskClaimedById: string | null;
  doneAt: Date | string | null;
  unfollowedAt: Date | string | null;
  activityUpperBoundSeq: number | null;
};

/**
 * One rw_followed_threads_v4 row (infra/risingwave/sql/072-followed-threads-v4.sql)
 * as the server reads it: v3's stats columns (FollowedThreadStatsRow) plus the
 * parent message and its task. lastReplyContent and parentMessageContent are
 * 141-character prefixes (enough for the 140/100-character previews). The
 * timestamps are `YYYY-MM-DD HH24:MI:SS.US+00` text, the format the v3 stats read
 * returns for lastReplyAt.
 */
export type FollowedThreadRwRow = FollowedThreadStatsRow & {
  storageThreadChannelId: string;
  parentMessageId: string | null;
  parentChannelId: string | null;
  /** Server of the parent message's channel (rw_channels), NULL when RW lacks it. */
  parentServerId: string | null;
  parentMessageContent: string | null;
  parentMessageSenderType: string | null;
  parentMessageSenderId: string | null;
  parentMessageSeq: string | null;
  parentMessageCreatedAt: string | null;
  taskId: string | null;
  taskNumber: number | null;
  taskStatus: string | null;
  taskClaimedByType: "agent" | "user" | null;
  taskClaimedById: string | null;
};

type FollowedThreadsState = NonNullable<FollowedThreadsOptions["state"]>;

/** Why a getFollowedThreads call ran the legacy (all-Postgres list) path. */
type FollowedThreadsLegacyReason =
  | "guest"
  | "state"
  | "executor"
  | "search"
  | "channel_filter"
  | "max_rows"
  | "forced"
  | "rw_failed";

type FollowedThreadsQueryContext = {
  serverId: string;
  userId: string;
  db: DatabaseExecutor;
  traceQuery: DbQueryTracer;
  guestAccess: string[] | null;
  state: FollowedThreadsState;
  opts: FollowedThreadsOptions | undefined;
};

type LoadedFollowedThreads = {
  threads: FollowedThreadSourceRow[];
  statsRows: FollowedThreadStatsRow[];
  readStateByThread: Map<string, ReadStateSnapshot>;
};

const RISINGWAVE_FOLLOWED_THREADS_VIEW = "rw_followed_threads_v4";
const RISINGWAVE_FOLLOWED_THREADS_QUERY_NAME = "channels.followed_threads_rw_rows";

/**
 * The single lookup of the RW followed-threads path: every rw_followed_threads_v4
 * row of (server, user), on the lookup index prefix. The view holds every follow
 * state; the caller keeps only the Postgres follow set.
 */
export const RISINGWAVE_FOLLOWED_THREADS_ROWS_SQL = `
      SELECT
        v.thread_channel_id::text AS "threadChannelId",
        v.storage_thread_channel_id::text AS "storageThreadChannelId",
        COALESCE(v.reply_count, 0)::int AS "replyCount",
        CASE
          WHEN v.last_reply_at IS NULL THEN NULL::text
          ELSE to_char(v.last_reply_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'
        END AS "lastReplyAt",
        -- Same tuple: the view joins latest.seq = stats.latest_seq.
        v.latest_message_id::text AS "lastReplyMessageId",
        v.latest_seq::text AS "lastReplySeqExact",
        v.latest_preview AS "lastReplyContent",
        v.latest_sender_type AS "lastReplySenderType",
        v.latest_sender_id AS "lastReplySenderId",
        v.first_unread_message_id::text AS "firstUnreadMessageId",
        COALESCE(v.unread_count, 0)::int AS "unreadCount",
        v.parent_message_id::text AS "parentMessageId",
        v.parent_channel_id::text AS "parentChannelId",
        v.parent_server_id::text AS "parentServerId",
        v.parent_preview AS "parentMessageContent",
        v.parent_sender_type AS "parentMessageSenderType",
        v.parent_sender_id AS "parentMessageSenderId",
        v.parent_seq::text AS "parentMessageSeq",
        CASE
          WHEN v.parent_created_at IS NULL THEN NULL::text
          ELSE to_char(v.parent_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'
        END AS "parentMessageCreatedAt",
        v.task_id::text AS "taskId",
        v.task_number::int AS "taskNumber",
        v.task_status AS "taskStatus",
        v.task_claimed_by_type AS "taskClaimedByType",
        v.task_claimed_by_id AS "taskClaimedById"
      FROM ${RISINGWAVE_FOLLOWED_THREADS_VIEW} v
      WHERE v.server_id = $1
        AND v.user_id = $2
    `;

function followedThreadsLegacyReason(ctx: FollowedThreadsQueryContext): FollowedThreadsLegacyReason | null {
  if (ctx.opts?.forceLegacyPath) return "forced";
  if (ctx.guestAccess !== null) return "guest";
  if (ctx.state !== "active") return "state";
  if (ctx.opts?.executor) return "executor";
  if (ctx.opts?.q) return "search";
  if (ctx.opts?.channelId) return "channel_filter";
  if (ctx.opts?.maxRows != null) return "max_rows";
  return null;
}

/**
 * The Postgres regular-thread list (threads whose parent message is in this
 * server). `threadIds` restricts it to those thread channels: the RW path uses
 * that for followed threads RisingWave has not caught up with yet.
 */
async function queryFollowedRegularThreads(
  ctx: FollowedThreadsQueryContext,
  threadIds?: string[],
): Promise<FollowedThreadSourceRow[]> {
  const { serverId, userId, db, traceQuery, guestAccess, state, opts } = ctx;
  const searchPattern = opts?.q ? `%${opts.q}%` : null;
  const doneCondition = state === "done"
    ? isNotNull(threadFollows.doneAt)
    : state === "active" || state === "unfollowed_active"
      ? isNull(threadFollows.doneAt)
      : undefined;
  const followCondition = state === "unfollowed" || state === "unfollowed_active"
    ? isNotNull(threadFollows.unfollowedAt)
    : state === "done"
      ? undefined
      : isNull(threadFollows.unfollowedAt);

  // Find thread channels the user follows (via threadFollows)
  const parentMessages = alias(messages, "parent_msg");
  const parentChannels = alias(channels, "parent_ch");
  const parentChannelHumans = alias(channelHumans, "parent_channel_humans");

  const regularThreadsQuery = db
      .select({
        threadChannelId: channels.id,
        storageThreadChannelId: channels.id,
        parentMessageId: channels.parentMessageId,
        parentChannelId: parentMessages.channelId,
        parentChannelName: parentChannels.name,
        parentChannelType: parentChannels.type,
        parentMessageContent: parentMessages.content,
        parentMessageCreatedAt: parentMessages.createdAt,
        parentMessageSenderType: parentMessages.senderType,
        parentMessageSenderId: parentMessages.senderId,
        parentMessageSeq: sql<string>`${parentMessages.seq}::text`,
        taskId: tasks.id,
        taskNumber: tasks.taskNumber,
        taskStatus: tasks.status,
        taskClaimedByType: tasks.claimedByType,
        taskClaimedById: tasks.claimedById,
        doneAt: threadFollows.doneAt,
        unfollowedAt: threadFollows.unfollowedAt,
        activityUpperBoundSeq: sql<number>`COALESCE(${inboxSuppressionStates.doneThroughSeq}, 0)`,
      })
      .from(threadFollows)
      .innerJoin(channels, and(
        eq(threadFollows.threadChannelId, channels.id),
        eq(channels.type, "thread"),
        isNull(channels.deletedAt),
      ))
      .innerJoin(parentMessages, eq(channels.parentMessageId, parentMessages.id))
      .innerJoin(parentChannels, eq(parentMessages.channelId, parentChannels.id))
      .leftJoin(parentChannelHumans, and(
        eq(parentChannelHumans.channelId, parentChannels.id),
        eq(parentChannelHumans.userId, userId),
      ))
      .leftJoin(tasks, eq(tasks.messageId, parentMessages.id))
      .leftJoin(inboxSuppressionStates, and(
        eq(inboxSuppressionStates.receiverType, "user"),
        eq(inboxSuppressionStates.receiverId, userId),
        // Ordinary replies clear the followed-thread done projection, but the
        // paired mention suppression retains the exact sequence written by
        // explicit unfollow and is therefore the durable history boundary.
        eq(inboxSuppressionStates.targetKind, "public_thread_mention"),
        eq(inboxSuppressionStates.targetChannelId, channels.id),
      ))
      .where(and(
        eq(threadFollows.followerType, "user"),
        eq(threadFollows.followerId, userId),
        doneCondition,
        followCondition,
        threadIds ? inArray(channels.id, threadIds) : undefined,
        eq(parentChannels.serverId, serverId),
        guestInboxAccessSql(guestAccess, sql`${parentChannels.id}`),
        isNull(parentChannels.archivedAt),
        isNull(parentChannels.deletedAt),
        sql`(${parentChannels.type} = 'channel' OR ${parentChannelHumans.userId} IS NOT NULL)`,
        opts?.channelId ? eq(parentMessages.channelId, opts.channelId) : undefined,
        searchPattern
          ? sql`(
              ${parentChannels.name} ILIKE ${searchPattern}
              OR ${parentMessages.content} ILIKE ${searchPattern}
              OR EXISTS (
                SELECT 1
                FROM messages search_message
                LEFT JOIN users search_user
                  ON search_message.sender_type = 'user'
                 AND search_user.id::text = search_message.sender_id
                LEFT JOIN agents search_agent
                  ON search_message.sender_type = 'agent'
                 AND search_agent.id::text = search_message.sender_id
                WHERE search_message.channel_id = ${channels.id}
                  ${state === "unfollowed"
                    ? sql`AND search_message.seq <= COALESCE(${inboxSuppressionStates.doneThroughSeq}, 0)`
                    : sql``}
                  AND (
                    search_message.content ILIKE ${searchPattern}
                    OR COALESCE(search_user.display_name, search_user.name, search_agent.display_name, search_agent.name, '') ILIKE ${searchPattern}
                  )
              )
            )`
          : undefined,
      ));
  return traceQuery(
    "channels.followed_threads_by_user",
    () => state === "done" || state === "unfollowed"
      ? regularThreadsQuery
          .orderBy(
            state === "done"
              ? opts?.sort === "asc" ? asc(threadFollows.doneAt) : desc(threadFollows.doneAt)
              : opts?.sort === "asc" ? asc(threadFollows.unfollowedAt) : desc(threadFollows.unfollowedAt),
            opts?.sort === "asc" ? asc(threadFollows.threadChannelId) : desc(threadFollows.threadChannelId),
          )
          .limit(opts?.maxRows ?? 101)
      : regularThreadsQuery,
    threadIds
      ? (rows) => ({ thread_ids_filter_count: threadIds.length, threads_count: rows.length })
      : undefined,
  );
}

/** The Postgres joint-thread list (local projections of joint threads). */
async function queryFollowedJointThreads(ctx: FollowedThreadsQueryContext): Promise<FollowedThreadSourceRow[]> {
  const { serverId, userId, db, traceQuery, guestAccess, state, opts } = ctx;
  const searchPattern = opts?.q ? `%${opts.q}%` : null;
  const jointThreadRows = await traceQuery(
    "channels.followed_joint_threads_by_user",
    () => db.execute(sql`
      SELECT
        local_thread.id::text AS "threadChannelId",
        canonical_thread.id::text AS "storageThreadChannelId",
        canonical_thread.parent_message_id::text AS "parentMessageId",
        local_parent.id::text AS "parentChannelId",
        local_parent.name AS "parentChannelName",
        local_parent.type AS "parentChannelType",
        parent_msg.content AS "parentMessageContent",
        parent_msg.created_at AS "parentMessageCreatedAt",
        parent_msg.sender_type AS "parentMessageSenderType",
        parent_msg.sender_id AS "parentMessageSenderId",
        -- Same parent_msg row that supplies parentMessageId (joined on
        -- canonical_thread.parent_message_id), so the zero-reply fallback pairs
        -- id and seq from one tuple. Cast to text because messages.seq is a
        -- bigint: a JS number would round past 2^53 before this code saw it.
        -- Without this column the joint arm returned undefined and every joint
        -- zero-reply thread failed closed to a null frontier. (@赵梓淇.)
        parent_msg.seq::text AS "parentMessageSeq",
        legacy_task.id::text AS "taskId",
        legacy_task.task_number AS "taskNumber",
        legacy_task.status AS "taskStatus",
        legacy_task.claimed_by_type AS "taskClaimedByType",
        legacy_task.claimed_by_id AS "taskClaimedById",
        tf.done_at AS "doneAt",
        tf.unfollowed_at AS "unfollowedAt",
        COALESCE(suppression.done_through_seq, 0) AS "activityUpperBoundSeq"
      FROM ${threadFollows} tf
      INNER JOIN ${channels} local_thread
        ON local_thread.id = tf.thread_channel_id
       AND local_thread.type = 'thread'
       AND local_thread.server_id = ${serverId}
       AND local_thread.deleted_at IS NULL
      INNER JOIN ${jointChannelServers} thread_projection
        ON thread_projection.local_channel_id = local_thread.id
       AND thread_projection.server_id = ${serverId}
       AND thread_projection.status = 'active'
      INNER JOIN ${jointChannels} thread_joint
        ON thread_joint.id = thread_projection.joint_channel_id
       AND thread_joint.status = 'active'
      INNER JOIN ${channels} canonical_thread
        ON canonical_thread.id = thread_joint.canonical_channel_id
       AND canonical_thread.type = 'thread'
       AND canonical_thread.deleted_at IS NULL
      INNER JOIN ${messages} parent_msg
        ON parent_msg.id = canonical_thread.parent_message_id
      INNER JOIN ${jointChannels} parent_joint
        ON parent_joint.canonical_channel_id = parent_msg.channel_id
       AND parent_joint.status = 'active'
      INNER JOIN ${jointChannelServers} parent_projection
        ON parent_projection.joint_channel_id = parent_joint.id
       AND parent_projection.server_id = ${serverId}
       AND parent_projection.status = 'active'
      INNER JOIN ${channels} local_parent
        ON local_parent.id = parent_projection.local_channel_id
       AND local_parent.type = 'joint'
       AND local_parent.archived_at IS NULL
       AND local_parent.deleted_at IS NULL
      INNER JOIN ${channelHumans} parent_member
        ON parent_member.channel_id = local_parent.id
       AND parent_member.user_id = ${userId}
      LEFT JOIN ${tasks} legacy_task
        ON legacy_task.message_id = parent_msg.id
      LEFT JOIN ${inboxSuppressionStates} suppression
        ON suppression.receiver_type = 'user'
       AND suppression.receiver_id = ${userId}::uuid
       AND suppression.target_kind = 'public_thread_mention'
       AND suppression.target_channel_id = local_thread.id
      WHERE ${guestInboxAccessSql(guestAccess, sql`local_parent.id`)}
        AND tf.follower_type = 'user'
        AND tf.follower_id = ${userId}
        AND ${state === "done"
          ? sql`tf.done_at IS NOT NULL`
          : state === "active" || state === "unfollowed_active"
            ? sql`tf.done_at IS NULL`
            : sql`TRUE`}
        AND ${state === "unfollowed" || state === "unfollowed_active"
          ? sql`tf.unfollowed_at IS NOT NULL`
          : state === "done"
            ? sql`TRUE`
            : sql`tf.unfollowed_at IS NULL`}
        ${opts?.channelId ? sql`AND local_parent.id = ${opts.channelId}::uuid` : sql``}
        ${searchPattern ? sql`AND (
          local_parent.name ILIKE ${searchPattern}
          OR parent_msg.content ILIKE ${searchPattern}
          OR EXISTS (
            SELECT 1
            FROM messages search_message
            LEFT JOIN users search_user
              ON search_message.sender_type = 'user'
             AND search_user.id::text = search_message.sender_id
            LEFT JOIN agents search_agent
              ON search_message.sender_type = 'agent'
             AND search_agent.id::text = search_message.sender_id
            WHERE search_message.channel_id = canonical_thread.id
              ${state === "unfollowed"
                ? sql`AND search_message.seq <= COALESCE(suppression.done_through_seq, 0)`
                : sql``}
              AND (
                search_message.content ILIKE ${searchPattern}
                OR COALESCE(search_user.display_name, search_user.name, search_agent.display_name, search_agent.name, '') ILIKE ${searchPattern}
              )
          )
        )` : sql``}
      ${state === "done" || state === "unfollowed"
        ? sql`ORDER BY ${state === "done" ? sql`tf.done_at` : sql`tf.unfollowed_at`} ${opts?.sort === "asc" ? sql`ASC` : sql`DESC`}, tf.thread_channel_id ${opts?.sort === "asc" ? sql`ASC` : sql`DESC`} LIMIT ${opts?.maxRows ?? 101}`
        : sql``}
    `),
  );
  return (jointThreadRows.rows as any[]).map((row) => ({
    ...row,
    parentMessageCreatedAt: new Date(row.parentMessageCreatedAt),
    unfollowedAt: row.unfollowedAt ? new Date(row.unfollowedAt) : null,
    activityUpperBoundSeq: row.activityUpperBoundSeq == null ? null : Number(row.activityUpperBoundSeq),
  }));
}

/** Every follow state, any caller: the Postgres list, v3 stats, the read-state authority read. */
async function loadFollowedThreadsLegacy(
  ctx: FollowedThreadsQueryContext,
  historyCutoff: Date | undefined,
): Promise<LoadedFollowedThreads> {
  const { serverId, userId, db, traceQuery, state, opts } = ctx;
  const regularThreads = await queryFollowedRegularThreads(ctx);
  const jointThreads = await queryFollowedJointThreads(ctx);
  let threads = [...regularThreads, ...jointThreads];

  if (await resolveHumanServerRole(serverId, userId, db) === "guest") {
    const visibility = await Promise.all(threads.map(async (thread) => ({
      thread,
      visible: await canUserAccessChannel(thread.parentChannelId, userId, serverId as ServerId, {
        executor: db,
      }),
    })));
    threads = visibility.filter(({ visible }) => visible).map(({ thread }) => thread);
  }

  if (threads.length === 0) return { threads: [], statsRows: [], readStateByThread: new Map() };

  const statsRows = await getFollowedThreadStatsRows(
    serverId,
    userId,
    threads.map((thread) => ({
      ...thread,
      activityUpperBoundSeq: state === "unfollowed" ? thread.activityUpperBoundSeq : null,
    })),
    historyCutoff,
    traceQuery,
    opts?.executor,
  );
  const readStates = await attachReadState(
    threads.map((thread) => ({ id: thread.threadChannelId })),
    userId,
    db,
    traceQuery,
  );
  return {
    threads,
    statsRows,
    readStateByThread: new Map(readStates.map((readState) => [readState.id, readState])),
  };
}

async function readFollowedThreadRwRows(
  serverId: string,
  userId: string,
  traceQuery: DbQueryTracer,
): Promise<FollowedThreadRwRow[]> {
  const override = getActivityReadSourceOverride();
  if (override) return override.followedThreadRows({ serverId, userId, traceQuery });
  const pool = getRisingWaveInboxPool();
  if (!pool) throw new RisingWaveNotConfiguredError("followed threads");
  const read = await traceQuery(
    RISINGWAVE_FOLLOWED_THREADS_QUERY_NAME,
    () => queryRisingWaveInbox<FollowedThreadRwRow>(pool, RISINGWAVE_FOLLOWED_THREADS_ROWS_SQL, [serverId, userId]),
    (queryRead) => ({
      backend: "risingwave",
      db_system: "risingwave",
      rw_followed_threads_view: RISINGWAVE_FOLLOWED_THREADS_VIEW,
      rows_count: queryRead.result.rows.length,
      "rw.acquire_wait_ms": Math.round(queryRead.acquireWaitMs),
      "rw.pool.total_count": queryRead.poolState.rw_pool_total,
      "rw.pool.idle_count": queryRead.poolState.rw_pool_idle,
      "rw.pool.waiting_count": queryRead.poolState.rw_pool_waiting,
    }),
  );
  return read.result.rows;
}

/**
 * Active follows of a non-guest without search / channel filter / row cap /
 * executor, from rw_followed_threads_v4 plus three primary-key Postgres reads.
 *
 * Authority stays in Postgres: the follow set (a just-followed thread appears
 * immediately), the parent channel's visibility and name (by distinct parent
 * channel), and the read cursor. RisingWave supplies what used to cost a random
 * `messages` read per thread: the parent message, its task and the stats.
 *
 * Followed threads RW has no row for yet (CDC lag) take the legacy regular-thread
 * query restricted to them; joint projections keep the legacy joint query. Both
 * get v3 stats and the read-state authority read, as before.
 *
 * Returns null when the RW read fails (e.g. the view is not deployed yet); the
 * caller then runs the whole legacy path. That error is never surfaced.
 */
async function loadActiveFollowedThreadsFromRisingWave(
  ctx: FollowedThreadsQueryContext,
  historyCutoff: Date | undefined,
): Promise<LoadedFollowedThreads | null> {
  const { serverId, userId, db, traceQuery } = ctx;
  // Independent reads: RW in flight while Postgres resolves the follow set. The
  // settled wrapper keeps an RW rejection from going unhandled if Postgres throws.
  const rwRead = readFollowedThreadRwRows(serverId, userId, traceQuery).then(
    (rows) => ({ ok: true as const, rows }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const followSet = await traceQuery(
    "channels.followed_thread_ids_by_user",
    () => db.execute(sql`
      SELECT tf.thread_channel_id::text AS "threadChannelId"
      FROM thread_follows tf
      JOIN channels c
        ON c.id = tf.thread_channel_id
       AND c.type = 'thread'
       AND c.deleted_at IS NULL
       AND c.server_id = ${serverId}
      WHERE tf.follower_type = 'user'
        AND tf.follower_id = ${userId}
        AND tf.done_at IS NULL
        AND tf.unfollowed_at IS NULL
    `),
    (result) => ({ followed_threads_count: result.rows.length }),
  );
  const rw = await rwRead;
  if (!rw.ok) {
    addTraceEvent("followed_threads.rw_rows.failed", {
      backend: "risingwave",
      rw_followed_threads_view: RISINGWAVE_FOLLOWED_THREADS_VIEW,
      error_class: errorClassOf(rw.error),
    });
    return null;
  }
  const followedIds = (followSet.rows as Array<{ threadChannelId: string }>).map((row) => row.threadChannelId);

  // Partition the follow set by what RW knows about each thread.
  const rwByThread = new Map(rw.rows.map((row) => [row.threadChannelId, row]));
  const rwRegular: FollowedThreadRwRow[] = [];
  const missingIds: string[] = [];
  let nonRegularCount = 0;
  for (const threadChannelId of followedIds) {
    const row = rwByThread.get(threadChannelId);
    if (!row) {
      // CDC lag: followed in Postgres, not in the view yet.
      missingIds.push(threadChannelId);
    } else if (row.parentMessageId == null || (row.parentServerId != null && row.parentServerId !== serverId)) {
      // A joint projection (no local parent message) or a parent in another
      // server: never a regular thread of this server; the joint query serves
      // the joint ones.
      nonRegularCount += 1;
    } else if (row.parentServerId == null || row.parentChannelId == null || row.parentMessageCreatedAt == null) {
      // The parent message (or its channel) has not reached RW yet: CDC lag.
      missingIds.push(threadChannelId);
    } else {
      rwRegular.push(row);
    }
  }

  // Visibility and names for the RW regular threads, authoritative in Postgres
  // and per distinct parent channel. Same rule as the legacy regular query's
  // WHERE: this server, not archived, not deleted, public or a member.
  const parentChannelIds = [...new Set(rwRegular.map((row) => row.parentChannelId!))];
  const parentChannelRows = parentChannelIds.length === 0 ? [] : (await traceQuery(
    "channels.followed_threads.parent_channels",
    () => db.execute(sql`
      SELECT
        c.id::text AS "id",
        c.name AS "name",
        c.type AS "type",
        c.server_id::text AS "serverId",
        c.archived_at AS "archivedAt",
        c.deleted_at AS "deletedAt",
        (ch.user_id IS NOT NULL) AS "member"
      FROM channels c
      LEFT JOIN channel_humans ch
        ON ch.channel_id = c.id
       AND ch.user_id = ${userId}
      WHERE c.id IN (${sql.join(parentChannelIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `),
    (result) => ({ parent_channels_count: parentChannelIds.length, rows_count: result.rows.length }),
  )).rows as Array<{
    id: string;
    name: string;
    type: string;
    serverId: string;
    archivedAt: unknown;
    deletedAt: unknown;
    member: boolean;
  }>;
  const visibleParentById = new Map(
    parentChannelRows
      .filter((channel) => channel.serverId === serverId
        && channel.archivedAt == null
        && channel.deletedAt == null
        && (channel.type === "channel" || channel.member))
      .map((channel) => [channel.id, channel]),
  );
  const rwVisible = rwRegular.filter((row) => visibleParentById.has(row.parentChannelId!));
  const rwThreads: FollowedThreadSourceRow[] = rwVisible.map((row) => {
    const parentChannel = visibleParentById.get(row.parentChannelId!)!;
    return {
      threadChannelId: row.threadChannelId,
      storageThreadChannelId: row.storageThreadChannelId,
      parentMessageId: row.parentMessageId,
      parentChannelId: row.parentChannelId!,
      parentChannelName: parentChannel.name,
      parentChannelType: parentChannel.type,
      parentMessageContent: row.parentMessageContent ?? "",
      parentMessageCreatedAt: new Date(row.parentMessageCreatedAt!),
      parentMessageSenderType: row.parentMessageSenderType ?? "",
      parentMessageSenderId: row.parentMessageSenderId ?? "",
      parentMessageSeq: row.parentMessageSeq,
      taskId: row.taskId,
      taskNumber: row.taskNumber == null ? null : Number(row.taskNumber),
      taskStatus: row.taskStatus,
      taskClaimedByType: row.taskClaimedByType,
      taskClaimedById: row.taskClaimedById,
      doneAt: null,
      unfollowedAt: null,
      activityUpperBoundSeq: null,
    };
  });

  const missingThreads = missingIds.length === 0 ? [] : await queryFollowedRegularThreads(ctx, missingIds);
  const jointThreads = followedIds.length === 0 ? [] : await queryFollowedJointThreads(ctx);
  const legacyThreads = [...missingThreads, ...jointThreads];

  addTraceEvent("followed_threads.source_selected", {
    followed_threads_source: "rw_v4",
    rw_followed_threads_view: RISINGWAVE_FOLLOWED_THREADS_VIEW,
    followed_threads_count: followedIds.length,
    rw_rows_count: rw.rows.length,
    rw_regular_threads: rwRegular.length,
    rw_hidden_threads: rwRegular.length - rwVisible.length,
    rw_non_regular_threads: nonRegularCount,
    rw_missing_threads: missingIds.length,
    legacy_regular_threads: missingThreads.length,
    joint_threads: jointThreads.length,
  });

  // Stats: the RW row itself for RW regular threads (no second RW read); v3 for
  // the rest, as before.
  const rwStatsRows: FollowedThreadStatsRow[] = rwVisible.map((row) => ({
    threadChannelId: row.threadChannelId,
    replyCount: row.replyCount,
    lastReplyAt: row.lastReplyAt,
    lastReplyMessageId: row.lastReplyMessageId,
    lastReplySeqExact: row.lastReplySeqExact,
    lastReplyContent: row.lastReplyContent,
    lastReplySenderType: row.lastReplySenderType,
    lastReplySenderId: row.lastReplySenderId,
    firstUnreadMessageId: row.firstUnreadMessageId,
    unreadCount: row.unreadCount,
  }));
  const legacyStatsRows = legacyThreads.length === 0 ? [] : await getFollowedThreadStatsRows(
    serverId,
    userId,
    legacyThreads.map((thread) => ({ ...thread, activityUpperBoundSeq: null })),
    historyCutoff,
    traceQuery,
  );

  // Read state. RW regular threads: the cursor by primary key, plus the RW
  // latest message as the content frontier, through the same snapshot mapping
  // as the authority read (fetchReadStateAuthorityRows). The rest: that read.
  const rwThreadIds = rwVisible.map((row) => row.threadChannelId);
  const cursorRows = rwThreadIds.length === 0 ? [] : (await traceQuery(
    "channels.followed_threads.read_cursors",
    () => db.execute(sql`
      SELECT
        channel_id::text AS "channelId",
        read_state_version::int AS "readStateVersion",
        last_read_seq::text AS "maxReadSeq"
      FROM user_channel_read_cursors
      WHERE user_id = ${userId}
        AND channel_id IN (${sql.join(rwThreadIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `),
    (result) => ({ input_count: rwThreadIds.length, read_cursor_rows_count: result.rows.length }),
  )).rows as Array<{ channelId: string; readStateVersion: number; maxReadSeq: string }>;
  const cursorByThread = new Map(cursorRows.map((row) => [row.channelId, row]));
  const readStateByThread = new Map<string, ReadStateSnapshot>();
  for (const row of rwVisible) {
    const cursor = cursorByThread.get(row.threadChannelId);
    readStateByThread.set(row.threadChannelId, readStateSnapshotFromAuthorityRow({
      channelId: row.threadChannelId,
      readCursorPresent: cursor !== undefined,
      readStateVersion: cursor?.readStateVersion ?? null,
      maxReadSeq: cursor?.maxReadSeq ?? null,
      latestActivityMessageId: row.lastReplyMessageId,
      latestActivitySeq: row.lastReplySeqExact,
      doneFrontierSeq: row.lastReplySeqExact ?? row.parentMessageSeq,
    }));
  }
  const legacyReadStates = await attachReadState(
    legacyThreads.map((thread) => ({ id: thread.threadChannelId })),
    userId,
    db,
    traceQuery,
  );
  for (const readState of legacyReadStates) readStateByThread.set(readState.id, readState);

  return {
    threads: [...rwThreads, ...legacyThreads],
    statsRows: [...rwStatsRows, ...legacyStatsRows],
    readStateByThread,
  };
}

/** Get all threads a user participates in, with unread counts and parent message info. */
export async function getFollowedThreads(
  serverId: string,
  userId: string,
  historyCutoff?: Date,
  opts?: FollowedThreadsOptions,
): Promise<FollowedThread[]> {
  const db = opts?.executor ?? getDb();
  const traceQuery = opts?.traceQuery ?? untracedDbQuery;
  const guestAccess = await guestInboxChannelIds(serverId, userId, db);
  const state = opts?.state ?? "active";
  const ctx: FollowedThreadsQueryContext = { serverId, userId, db, traceQuery, guestAccess, state, opts };

  const legacyReason = followedThreadsLegacyReason(ctx);
  let loaded = legacyReason === null ? await loadActiveFollowedThreadsFromRisingWave(ctx, historyCutoff) : null;
  if (!loaded) {
    addTraceEvent("followed_threads.source_selected", {
      followed_threads_source: "legacy",
      legacy_reason: legacyReason ?? "rw_failed",
    });
    loaded = await loadFollowedThreadsLegacy(ctx, historyCutoff);
  }
  const { threads, statsRows, readStateByThread } = loaded;
  if (threads.length === 0) return [];

  const statsMap = new Map<string, {
    replyCount: number;
    lastReplyAt: string | null;
    lastReplyMessageId: string | null;
    lastReplySeqExact: string | null;
    lastReplyContent: string | null;
    lastReplySenderType: string | null;
    lastReplySenderId: string | null;
    firstUnreadMessageId: string | null;
    unreadCount: number;
  }>();
  for (const row of statsRows) {
    statsMap.set(row.threadChannelId, {
      replyCount: row.replyCount,
      lastReplyAt: row.lastReplyAt,
      lastReplyMessageId: row.lastReplyMessageId ?? null,
      lastReplySeqExact: row.lastReplySeqExact ?? null,
      lastReplyContent: row.lastReplyContent ?? null,
      lastReplySenderType: row.lastReplySenderType ?? null,
      lastReplySenderId: row.lastReplySenderId ?? null,
      firstUnreadMessageId: row.firstUnreadMessageId ?? null,
      unreadCount: row.unreadCount,
    });
  }

  // Batch-resolve task claimant names
  const claimantNameMap = new Map<string, string>();
  const agentClaimantIds = threads.filter(t => t.taskClaimedByType === "agent" && t.taskClaimedById).map(t => t.taskClaimedById!);
  const userClaimantIds = threads.filter(t => t.taskClaimedByType === "user" && t.taskClaimedById).map(t => t.taskClaimedById!);
  if (agentClaimantIds.length > 0) {
    const agentRows = await traceQuery(
      "channels.followed_threads.agent_claimants",
      () => db.select({ id: agents.id, name: agents.name }).from(agents).where(sql`${agents.id} IN (${sql.join(agentClaimantIds.map(id => sql`${id}`), sql`, `)})`),
      (rows) => ({
        input_count: agentClaimantIds.length,
        claimants_count: rows.length,
      }),
    );
    for (const a of agentRows) claimantNameMap.set(a.id, a.name);
  }
  if (userClaimantIds.length > 0) {
    const userRows = await traceQuery(
      "channels.followed_threads.user_claimants",
      () => db.select({ id: users.id, name: users.name, displayName: users.displayName }).from(users).where(sql`${users.id} IN (${sql.join(userClaimantIds.map(id => sql`${id}`), sql`, `)})`),
      (rows) => ({
        input_count: userClaimantIds.length,
        claimants_count: rows.length,
      }),
    );
    for (const u of userRows) claimantNameMap.set(u.id, u.displayName || u.name);
  }

  const externalLatestMessageIds = threads.flatMap((thread) => {
    const stats = statsMap.get(thread.threadChannelId);
    const senderType = stats?.lastReplySenderType ?? thread.parentMessageSenderType;
    const messageId = stats?.lastReplyMessageId ?? thread.parentMessageId;
    return senderType === "external_projection" && messageId ? [messageId] : [];
  });
  const externalLatestNameByMessageId = new Map<string, string>();
  if (externalLatestMessageIds.length > 0) {
    const externalRows = await traceQuery(
      "channels.followed_threads.external_projection_names",
      () => db
        .select({ messageId: externalMessageAuthorFacts.messageId, displayName: externalMessageAuthorFacts.displayName })
        .from(externalMessageAuthorFacts)
        .where(inArray(externalMessageAuthorFacts.messageId, externalLatestMessageIds)),
      (rows) => ({ input_count: externalLatestMessageIds.length, result_count: rows.length }),
    );
    for (const row of externalRows) externalLatestNameByMessageId.set(row.messageId, row.displayName);
    if (externalLatestNameByMessageId.size !== new Set(externalLatestMessageIds).size) {
      throw new Error("External projection followed-thread row is missing immutable author fact");
    }
  }

  const historyCutoffMs = historyCutoff?.getTime();
  const result = threads.map(t => {
    const stats = statsMap.get(t.threadChannelId);
    const readState = readStateByThread.get(t.threadChannelId);
    // Free-plan history cutoff: the counts and lastReplyAt are served as-is (a
    // product decision); only the content of a latest reply older than the
    // cutoff is withheld. The parent preview is not cut (it never was).
    const latestReplyBeforeCutoff = historyCutoffMs !== undefined
      && stats?.lastReplyAt != null
      && new Date(stats.lastReplyAt).getTime() < historyCutoffMs;
    const latestActivityContent = latestReplyBeforeCutoff ? "" : stats?.lastReplyContent ?? t.parentMessageContent;
    return {
      threadChannelId: t.threadChannelId,
      parentMessageId: t.parentMessageId!,
      parentChannelId: t.parentChannelId,
      parentChannelName: t.parentChannelName,
      parentChannelType: t.parentChannelType,
      parentMessagePreview: t.parentMessageContent.length > 100
        ? t.parentMessageContent.slice(0, 100) + "…"
        : t.parentMessageContent,
      parentMessageSenderType: t.parentMessageSenderType,
      parentMessageSenderId: t.parentMessageSenderId,
      latestActivityPreview: latestActivityContent.length > 140
        ? latestActivityContent.slice(0, 140) + "…"
        : latestActivityContent,
      latestActivitySenderType: stats?.lastReplySenderType ?? t.parentMessageSenderType,
      latestActivitySenderId: stats?.lastReplySenderId ?? t.parentMessageSenderId,
      latestActivitySenderName: externalLatestNameByMessageId.get(stats?.lastReplyMessageId ?? t.parentMessageId!) ?? null,
      latestActivityMessageId: stats?.lastReplyMessageId ?? t.parentMessageId!,
      // Same-source frontier, paired with latestActivityMessageId above. This is
      // the PRODUCTION call site: the helper existing and being unit-tested
      // proves nothing about /threads/followed unless the result uses it.
      latestActivitySeq: latestActivitySeqSameSource(stats, t.parentMessageSeq),
      firstUnreadMessageId: stats?.firstUnreadMessageId ?? null,
      lastActivityAt: stats?.lastReplyAt ?? t.parentMessageCreatedAt.toISOString(),
      replyCount: stats?.replyCount ?? 0,
      lastReplyAt: stats?.lastReplyAt ?? null,
      unreadCount: stats?.unreadCount ?? 0,
      taskId: t.taskId,
      taskNumber: t.taskNumber,
      taskStatus: t.taskStatus,
      taskClaimedByType: t.taskClaimedByType,
      taskClaimedById: t.taskClaimedById,
      taskClaimedByName: t.taskClaimedById ? (claimantNameMap.get(t.taskClaimedById) ?? null) : null,
      maxReadSeq: readState?.maxReadSeq ?? 0,
      readStateVersion: readState?.readStateVersion ?? 0,
      // #632 SSOT: the union must survive this manual map — the absent
      // fallback still goes through the shared constructor.
      readState: readState?.readState ?? makeInboxScopeReadFrontier(null),
      doneAt: t.doneAt ? new Date(t.doneAt).toISOString() : null,
      isFollowing: !t.unfollowedAt,
      unfollowedAt: t.unfollowedAt ? new Date(t.unfollowedAt).toISOString() : null,
    };
  });

  // Active follows are ordered by activity; Done history is ordered by the
  // explicit completion time so restoring an older item is deterministic.
  result.sort((a, b) => {
    if (state === "done" || state === "unfollowed") {
      const leftStateAt = state === "done" ? a.doneAt : a.unfollowedAt;
      const rightStateAt = state === "done" ? b.doneAt : b.unfollowedAt;
      const delta = new Date(leftStateAt ?? 0).getTime() - new Date(rightStateAt ?? 0).getTime();
      if (delta !== 0) return opts?.sort === "asc" ? delta : -delta;
      const identityDelta = a.threadChannelId.localeCompare(b.threadChannelId);
      return opts?.sort === "asc" ? identityDelta : -identityDelta;
    }
    return new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
  });

  return result;
}

export type InboxFilter = "all" | "unread" | "mentions" | "unread_mentions";

export type InboxGroupCount = {
  channelId: string;
  channelName: string;
  channelType: "channel" | "private" | "joint" | "dm";
  count: number;
  lastActivityAt: string;
};

// CONTRACT: InboxItem is the API-visible row shape that both the canonical
// inline Postgres SQL below and rw_inbox_items_v2 must produce after
// page-bounded enrichment. SYNC REQUIRED: if any field name, type, nullability,
// or semantics changes here, update the inline SQL in getInboxItems,
// infra/risingwave/sql/024-risingwave-unread-inbox-full-materialized.sql, and run:
// pnpm --filter @botiverse/raft-server risingwave:verify-inbox-parity
export type InboxItem =
  | {
      kind: "channel" | "dm";
      channelId: string;
      channelName: string;
      channelType: "channel" | "private" | "joint" | "dm";
      lastMessageId: string;
      latestActivitySeq: string | null;
      /** Guard-domain frontier on active Inbox rows; history may omit it. */
      doneFrontierSeq?: string | null;
      firstUnreadMessageId: string | null;
      firstMentionMessageId: string | null;
      lastMessageAt: string;
      lastMessagePreview: string;
      lastMessageSenderType: string;
      lastMessageSenderId: string;
      lastMessageSenderName: string | null;
      unreadCount: number;
      hasMention: boolean;
      maxReadSeq?: number;
      readStateVersion?: number;
      /**
       * SSOT per-scope read state union (#632) — always set on the ACTIVE
       * /channels/inbox serving path (every backend). Done/unfollowed history
       * surfaces do not adjudicate read state and may omit it.
       */
      readState?: InboxScopeReadFrontier;
      doneAt?: string | null;
    }
  | {
      kind: "thread";
      threadChannelId: string;
      parentMessageId: string;
      parentChannelId: string;
      parentChannelName: string;
      parentChannelType: string;
      parentMessagePreview: string;
      parentMessageSenderType: string;
      parentMessageSenderId: string;
      latestActivityPreview: string;
      latestActivitySenderType: string;
      latestActivitySenderId: string;
      latestActivitySenderName: string | null;
      latestActivityMessageId: string;
      latestActivitySeq: string | null;
      /** Guard-domain frontier on active Inbox rows; history may omit it. */
      doneFrontierSeq?: string | null;
      firstUnreadMessageId: string | null;
      firstMentionMessageId: string | null;
      lastActivityAt: string;
      lastReplyAt: string | null;
      replyCount: number;
      unreadCount: number;
      hasMention: boolean;
      taskNumber: number | null;
      taskStatus: string | null;
      taskClaimedByName: string | null;
      maxReadSeq?: number;
      readStateVersion?: number;
      /**
       * SSOT per-scope read state union (#632) — always set on the ACTIVE
       * /channels/inbox serving path (every backend). Done/unfollowed history
       * surfaces do not adjudicate read state and may omit it.
       */
      readState?: InboxScopeReadFrontier;
      doneAt?: string | null;
      isFollowing?: boolean;
      unfollowedAt?: string | null;
    };

function readInboxGroupCounts(rows: readonly QueryResultRow[]): InboxGroupCount[] {
  const row = rows[0] as Record<string, unknown> | undefined;
  const ids = Array.isArray(row?.groupChannelIds) ? row.groupChannelIds : [];
  const names = Array.isArray(row?.groupChannelNames) ? row.groupChannelNames : [];
  const types = Array.isArray(row?.groupChannelTypes) ? row.groupChannelTypes : [];
  const counts = Array.isArray(row?.groupCounts) ? row.groupCounts : [];
  const lastActivityAts = Array.isArray(row?.groupLastActivityAts) ? row.groupLastActivityAts : [];
  const groups: InboxGroupCount[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    const channelId = ids[index];
    const channelName = names[index];
    const channelType = types[index];
    const count = Number(counts[index]);
    const lastActivityValue = lastActivityAts[index];
    const lastActivityDate = lastActivityValue instanceof Date
      ? lastActivityValue
      : typeof lastActivityValue === "string"
        ? new Date(lastActivityValue)
        : null;
    if (
      typeof channelId !== "string" ||
      typeof channelName !== "string" ||
      (channelType !== "channel" && channelType !== "private" && channelType !== "joint" && channelType !== "dm") ||
      !Number.isFinite(count) ||
      count <= 0 ||
      !lastActivityDate ||
      !Number.isFinite(lastActivityDate.getTime())
    ) continue;
    groups.push({ channelId, channelName, channelType, count, lastActivityAt: lastActivityDate.toISOString() });
  }
  return groups;
}

type DoneChannelInboxRow = {
  kind: string;
  channelId: string;
  channelName: string | null;
  channelType: "channel" | "private" | "joint" | "dm";
  lastMessageId: string;
  lastMessageSeq: string;
  lastMessageAt: string | Date;
  lastMessagePreview: string | null;
  lastMessageSenderType: string;
  lastMessageSenderId: string;
  doneAt: string | Date;
};

async function attachReadStateToInboxItems(
  items: InboxItem[],
  userId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<InboxItem[]> {
  const scopeIds = items
    .map((item) => item.kind === "thread" ? item.threadChannelId : item.channelId)
    .filter((id, index, list) => list.indexOf(id) === index);
  if (scopeIds.length === 0) return items;
  const states = await executor
    .select({
      channelId: userChannelReadCursors.channelId,
      maxReadSeq: userChannelReadCursors.lastReadSeq,
      readStateVersion: userChannelReadCursors.readStateVersion,
    })
    .from(userChannelReadCursors)
    .where(and(
      eq(userChannelReadCursors.userId, userId),
      inArray(userChannelReadCursors.channelId, scopeIds),
    ));
  const stateByChannel = new Map(states.map((state) => [state.channelId, state]));
  return items.map((item) => {
    const scopeId = item.kind === "thread" ? item.threadChannelId : item.channelId;
    const state = stateByChannel.get(scopeId);
    return {
      ...item,
      maxReadSeq: state?.maxReadSeq ?? 0,
      readStateVersion: state?.readStateVersion ?? 0,
    } as InboxItem;
  });
}

/**
 * The one corruption sink every /channels/inbox backend wires as onCorrupt:
 * exactly one stable line per corrupt scope (shape frozen in the shared
 * contract). Callback failure isolation lives inside the shared total
 * constructor — this sink deliberately adds no try/catch of its own.
 */
function logInboxScopeCorruption(scopeId: string, corruption: InboxScopeCursorCorruption): void {
  console.error(formatInboxScopeCorruptionLine(scopeId, corruption));
}

/**
 * Enrich PG-path inbox page rows with the read-cursor triple AND the union
 * frontier pair from the SINGLE authority read (#632 SSOT — the same
 * fetchReadStateAuthorityRows the list/DM/thread and unread exits use, so the
 * same scope yields the identical union here as there):
 *   - readCursorPresent/readStateVersion/maxReadSeq: structural presence plus
 *     NULL-preserved cursor values.
 *   - readStateActivityMessageId/readStateActivitySeq: latest message of the
 *     scope's OWN storage channel (NULL for a zero-reply thread). Kept in
 *     DEDICATED fields: the row's latestActivityMessageId/latestActivitySeq
 *     stay the serving query's display pair, which deliberately keeps the
 *     zero-reply parent fallback the sync serializer requires — and which
 *     would be wrong for adjudication anyway (the parent seq lives in a
 *     different seq domain than the scope's cursor).
 * RW rows carry their own cursor_v2 fields and never come through here (the
 * RW offload is preserved).
 */
async function enrichInboxRowsWithReadCursorAuthority(
  rows: readonly InboxPolicySqlRow[],
  userId: string,
  traceQuery: DbQueryTracer,
  executor: DatabaseExecutor = getDb(),
): Promise<void> {
  const scopeIds = [...new Set(
    rows.map((row) => inboxScopeIdOfRow(row)).filter((id): id is string => id !== null),
  )];
  if (scopeIds.length === 0) return;
  const authorityRows = await fetchReadStateAuthorityRows(
    scopeIds,
    userId,
    traceQuery,
    "channels.inbox_read_state_authority",
    executor,
  );
  const authorityByScope = new Map(authorityRows.map((row) => [row.channelId, row]));
  for (const row of rows) {
    const scopeId = inboxScopeIdOfRow(row);
    const authority = scopeId === null ? undefined : authorityByScope.get(scopeId);
    row.readCursorPresent = authority?.readCursorPresent === true;
    row.readStateVersion = authority?.readStateVersion ?? null;
    row.maxReadSeq = authority?.maxReadSeq ?? null;
    row.readStateActivityMessageId = authority?.latestActivityMessageId ?? null;
    row.readStateActivitySeq = authority?.latestActivitySeq ?? null;
    row.doneFrontierSeq = authority?.doneFrontierSeq ?? null;
  }
}

function inboxScopeIdOfRow(row: InboxPolicySqlRow): string | null {
  const value = row.kind === "thread" ? row.threadChannelId : row.channelId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Read durable Done history from Postgres. This intentionally stays separate
 * from the active Inbox serving path: Done history is a lower-volume view and
 * must not widen the RisingWave active-row contract.
 */
export async function getDoneInboxItems(
  serverId: string,
  userId: string,
  opts: {
    limit?: number;
    offset?: number;
    historyCutoff?: Date;
    channelId?: string;
    q?: string;
    sort?: "asc" | "desc";
    traceQuery?: DbQueryTracer;
  } = {},
): Promise<{ items: InboxItem[]; hasMore: boolean; totalCount: null }> {
  const db = getDb();
  const guestAccess = await guestInboxChannelIds(serverId, userId, db);
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const fetchLimit = limit + offset + 1;
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const historyCutoff = opts.historyCutoff;
  const searchPattern = opts.q ? `%${opts.q}%` : null;
  const sortDirection = opts.sort === "asc" ? sql`ASC` : sql`DESC`;

  // Resolve the caller's local server namespace to canonical message storage
  // before reading messages. In particular, a joint channel's local projection
  // is the access authority while its canonical channel owns the message rows.
  const messageStorageChannelIds = await traceQuery(
    "channels.done_inbox_message_storage_scopes",
    () => resolveServerMessageStorageChannelIds(serverId, db),
    (rows) => ({ storage_scope_count: rows.length }),
  );

  const channelRows = messageStorageChannelIds.length === 0
    ? { rows: [] }
    : await traceQuery(
      "channels.done_inbox_channels_by_user",
      () => db.execute(sql`
      SELECT
        c.type::text AS "kind",
        c.id::text AS "channelId",
        c.name AS "channelName",
        c.type::text AS "channelType",
        latest.id::text AS "lastMessageId",
        latest.seq::text AS "lastMessageSeq",
        latest.created_at AS "lastMessageAt",
        latest.content AS "lastMessagePreview",
        latest.sender_type AS "lastMessageSenderType",
        latest.sender_id::text AS "lastMessageSenderId",
        state.done_at AS "doneAt"
      FROM ${userChannelInboxStates} state
      INNER JOIN ${channels} c
        ON c.id = state.channel_id
       AND c.type <> 'thread'
       AND c.deleted_at IS NULL
       AND c.archived_at IS NULL
      LEFT JOIN ${channelHumans} member
        ON member.channel_id = c.id
       AND member.user_id = ${userId}
      LEFT JOIN ${jointChannelServers} projection
        ON projection.local_channel_id = c.id
       AND projection.server_id = ${serverId}
       AND projection.status = 'active'
      LEFT JOIN ${jointChannels} joint
        ON joint.id = projection.joint_channel_id
       AND joint.status = 'active'
      INNER JOIN LATERAL (
        SELECT m.id, m.seq, m.created_at, m.content, m.sender_type, m.sender_id
        FROM ${messages} m
        WHERE m.channel_id = COALESCE(joint.canonical_channel_id, c.id)
          ${historyCutoff ? sql`AND m.created_at >= ${historyCutoff}` : sql``}
        ORDER BY m.seq DESC
        LIMIT 1
      ) latest ON true
      WHERE state.user_id = ${userId}
        AND ${guestInboxAccessSql(guestAccess, sql`c.id`)}
        AND state.done_at IS NOT NULL
        ${opts.channelId ? sql`AND c.id = ${opts.channelId}::uuid` : sql``}
        ${searchPattern ? sql`AND (
          c.name ILIKE ${searchPattern}
          OR latest.content ILIKE ${searchPattern}
          OR EXISTS (
            SELECT 1
            FROM users search_user
            WHERE latest.sender_type = 'user'
              AND search_user.id::text = latest.sender_id
              AND COALESCE(search_user.display_name, search_user.name) ILIKE ${searchPattern}
          )
          OR EXISTS (
            SELECT 1
            FROM agents search_agent
            WHERE latest.sender_type = 'agent'
              AND search_agent.id::text = latest.sender_id
              AND COALESCE(search_agent.display_name, search_agent.name) ILIKE ${searchPattern}
          )
        )` : sql``}
        AND COALESCE(joint.canonical_channel_id, c.id) IN (${sql.join(messageStorageChannelIds.map((id) => sql`${id}`), sql`, `)})
        AND (c.type = 'channel' OR member.user_id IS NOT NULL)
      ORDER BY state.done_at ${sortDirection}, c.id ${sortDirection}
      LIMIT ${fetchLimit}
    `),
    );

  const channelItems = (channelRows.rows as DoneChannelInboxRow[]).map((row) => ({
    kind: row.kind === "dm" ? "dm" as const : "channel" as const,
    channelId: String(row.channelId),
    channelName: String(row.channelName ?? ""),
    channelType: row.channelType as "channel" | "private" | "joint" | "dm",
    lastMessageId: String(row.lastMessageId),
    latestActivitySeq: row.lastMessageSeq,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastMessageAt: new Date(row.lastMessageAt as string | Date).toISOString(),
    lastMessagePreview: String(row.lastMessagePreview ?? ""),
    lastMessageSenderType: String(row.lastMessageSenderType),
    lastMessageSenderId: String(row.lastMessageSenderId),
    lastMessageSenderName: null,
    unreadCount: 0,
    hasMention: false,
    doneAt: new Date(row.doneAt as string | Date).toISOString(),
  })) satisfies InboxItem[];

  const followedThreads = await getFollowedThreads(serverId, userId, historyCutoff, {
    state: "done",
    maxRows: fetchLimit,
    channelId: opts.channelId,
    q: opts.q,
    sort: opts.sort,
    traceQuery,
  });
  const threadItems = followedThreads.map((thread): InboxItem => ({
    kind: "thread",
    threadChannelId: thread.threadChannelId,
    parentMessageId: thread.parentMessageId,
    parentChannelId: thread.parentChannelId,
    parentChannelName: thread.parentChannelName,
    parentChannelType: thread.parentChannelType,
    parentMessagePreview: thread.parentMessagePreview,
    parentMessageSenderType: thread.parentMessageSenderType,
    parentMessageSenderId: thread.parentMessageSenderId,
    latestActivityPreview: thread.latestActivityPreview,
    latestActivitySenderType: thread.latestActivitySenderType,
    latestActivitySenderId: thread.latestActivitySenderId,
    latestActivitySenderName: thread.latestActivitySenderName,
    latestActivityMessageId: thread.latestActivityMessageId,
    latestActivitySeq: thread.latestActivitySeq ?? null,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastActivityAt: thread.lastActivityAt,
    lastReplyAt: thread.lastReplyAt,
    replyCount: thread.replyCount,
    unreadCount: 0,
    hasMention: false,
    taskNumber: thread.taskNumber,
    taskStatus: thread.taskStatus,
    taskClaimedByName: thread.taskClaimedByName,
    maxReadSeq: thread.maxReadSeq,
    readStateVersion: thread.readStateVersion,
    readState: thread.readState,
    doneAt: thread.doneAt,
    isFollowing: thread.isFollowing,
    unfollowedAt: thread.unfollowedAt,
  }));

  const combined = [...channelItems, ...threadItems].sort((a, b) => {
    const delta = new Date(a.doneAt ?? 0).getTime() - new Date(b.doneAt ?? 0).getTime();
    if (delta !== 0) return opts.sort === "asc" ? delta : -delta;
    const aIdentity = `${a.kind}:${a.kind === "thread" ? a.threadChannelId : a.channelId}`;
    const bIdentity = `${b.kind}:${b.kind === "thread" ? b.threadChannelId : b.channelId}`;
    const identityDelta = aIdentity.localeCompare(bIdentity);
    return opts.sort === "asc" ? identityDelta : -identityDelta;
  });
  const page = combined.slice(offset, offset + limit);
  return {
    items: await attachReadStateToInboxItems(page, userId),
    hasMore: combined.length > offset + limit,
    totalCount: null,
  };
}

/**
 * Compatibility history for explicitly unfollowed threads. Activity All uses
 * the live not-Done projection below; this endpoint retains the frozen
 * unfollow-boundary projection across completion states for older clients.
 */
export async function getUnfollowedInboxItems(
  serverId: string,
  userId: string,
  opts: {
    limit?: number;
    offset?: number;
    historyCutoff?: Date;
    channelId?: string;
    q?: string;
    sort?: "asc" | "desc";
    traceQuery?: DbQueryTracer;
    executor?: DatabaseExecutor;
  } = {},
): Promise<{ items: InboxItem[]; hasMore: boolean; totalCount: null }> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const fetchLimit = limit + offset + 1;
  const followedThreads = await getFollowedThreads(serverId, userId, opts.historyCutoff, {
    state: "unfollowed",
    maxRows: fetchLimit,
    channelId: opts.channelId,
    q: opts.q,
    sort: opts.sort,
    traceQuery: opts.traceQuery,
    executor: opts.executor,
  });
  const combined = followedThreads.map(unfollowedThreadInboxItem);
  const page = combined.slice(offset, offset + limit);
  return {
    items: page,
    hasMore: combined.length > offset + limit,
    totalCount: null,
  };
}

type FollowedThreadInboxSource = Awaited<ReturnType<typeof getFollowedThreads>>[number];

function unfollowedThreadInboxItem(thread: FollowedThreadInboxSource): InboxItem {
  return {
    kind: "thread",
    threadChannelId: thread.threadChannelId,
    parentMessageId: thread.parentMessageId,
    parentChannelId: thread.parentChannelId,
    parentChannelName: thread.parentChannelName,
    parentChannelType: thread.parentChannelType,
    parentMessagePreview: thread.parentMessagePreview,
    parentMessageSenderType: thread.parentMessageSenderType,
    parentMessageSenderId: thread.parentMessageSenderId,
    latestActivityPreview: thread.latestActivityPreview,
    latestActivitySenderType: thread.latestActivitySenderType,
    latestActivitySenderId: thread.latestActivitySenderId,
    latestActivitySenderName: thread.latestActivitySenderName,
    latestActivityMessageId: thread.latestActivityMessageId,
    latestActivitySeq: thread.latestActivitySeq,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastActivityAt: thread.lastActivityAt,
    lastReplyAt: thread.lastReplyAt,
    replyCount: thread.replyCount,
    unreadCount: 0,
    hasMention: false,
    taskNumber: thread.taskNumber,
    taskStatus: thread.taskStatus,
    taskClaimedByName: thread.taskClaimedByName,
    maxReadSeq: thread.maxReadSeq,
    readStateVersion: thread.readStateVersion,
    readState: thread.readState,
    doneAt: null,
    isFollowing: false,
    unfollowedAt: thread.unfollowedAt,
  };
}

async function getActiveUnfollowedInboxItems(
  serverId: string,
  userId: string,
  opts: {
    historyCutoff?: Date;
    channelId?: string;
    q?: string;
    sort?: "asc" | "desc";
    traceQuery?: DbQueryTracer;
    executor?: DatabaseExecutor;
  },
): Promise<InboxItem[]> {
  const threads = await getFollowedThreads(serverId, userId, opts.historyCutoff, {
    state: "unfollowed_active",
    channelId: opts.channelId,
    q: opts.q,
    sort: opts.sort,
    traceQuery: opts.traceQuery,
    executor: opts.executor,
  });
  return threads.map((thread) => ({
    ...unfollowedThreadInboxItem(thread),
    // The active All row needs follow state for controls, not a terminal
    // history timestamp. Keeping this absent also prevents label projection.
    unfollowedAt: null,
  }));
}

type InboxQueryResult = { rows: QueryResultRow[]; contractVersion?: number };

const INBOX_PG_FALLBACK_QUERY_NAME = "channels.inbox_items_serving_rows_by_user";
const INBOX_PG_FALLBACK_QUERY_IDENTITY = "inbox_items_serving_rows_v13";
const INBOX_PG_FALLBACK_LEGACY_QUERY_HASH = "ff11a9e16bc68872";
const INBOX_PG_FALLBACK_STATEMENT_TIMEOUT_CAP_MS = 3_000;
const INBOX_PG_FALLBACK_TIMEOUT_SCOPE = "transaction_local" as const;

type InboxPgFallbackQueryOutcome = "query_completed" | "statement_timeout" | "query_error";
type InboxPgFallbackTimeoutPlan = {
  inheritedTimeoutMs: number;
  effectiveTimeoutMs: number;
};

function inboxPgFallbackEffectiveTimeoutMs(inheritedTimeoutMs: number): number {
  if (!Number.isSafeInteger(inheritedTimeoutMs) || inheritedTimeoutMs < 0) {
    throw new Error("Invalid inherited statement_timeout for inbox PG fallback");
  }
  return inheritedTimeoutMs === 0
    ? INBOX_PG_FALLBACK_STATEMENT_TIMEOUT_CAP_MS
    : Math.min(inheritedTimeoutMs, INBOX_PG_FALLBACK_STATEMENT_TIMEOUT_CAP_MS);
}

function inboxPgFallbackQueryScopeTraceAttrs(
  queryHash: string,
): Record<string, string | number | boolean> {
  return {
    "pg.fallback.query_name": INBOX_PG_FALLBACK_QUERY_NAME,
    "pg.fallback.query_identity": INBOX_PG_FALLBACK_QUERY_IDENTITY,
    "pg.fallback.query_hash": queryHash,
    "pg.fallback.legacy_query_hash": INBOX_PG_FALLBACK_LEGACY_QUERY_HASH,
    "pg.fallback.timeout_scope": INBOX_PG_FALLBACK_TIMEOUT_SCOPE,
    "pg.fallback.statement_timeout_cap_ms": INBOX_PG_FALLBACK_STATEMENT_TIMEOUT_CAP_MS,
  };
}

function inboxPgFallbackTimeoutPlanTraceAttrs(
  timeoutPlan: InboxPgFallbackTimeoutPlan | undefined,
): Record<string, number> {
  if (!timeoutPlan) return {};
  return {
    "pg.fallback.inherited_statement_timeout_ms": timeoutPlan.inheritedTimeoutMs,
    "pg.fallback.effective_statement_timeout_ms": timeoutPlan.effectiveTimeoutMs,
  };
}

function inboxPgFallbackQueryTraceAttrs(
  queryHash: string,
  outcome: InboxPgFallbackQueryOutcome,
  timeoutPlan?: InboxPgFallbackTimeoutPlan,
): TraceAttributes {
  return {
    ...inboxPgFallbackQueryScopeTraceAttrs(queryHash),
    ...inboxPgFallbackTimeoutPlanTraceAttrs(timeoutPlan),
    "pg.fallback.outcome": outcome,
  };
}

function inboxPgFallbackQueryErrorTraceAttrs(
  queryHash: string,
  error: unknown,
  timeoutPlan?: InboxPgFallbackTimeoutPlan,
): TraceAttributes {
  const reason = queryFailureReason(error);
  return {
    ...inboxPgFallbackQueryTraceAttrs(
      queryHash,
      reason === "statement_timeout" ? "statement_timeout" : "query_error",
      timeoutPlan,
    ),
    ...queryFailureTraceAttrs(error),
  };
}

function mergeInboxAllPageKeyRows(
  servingRows: readonly QueryResultRow[],
  mentionRows: readonly QueryResultRow[],
  sort: "asc" | "desc" | undefined,
  offset: number,
  limit: number,
): QueryResultRow[] {
  const rowsByIdentity = new Map<string, QueryResultRow>();
  for (const row of servingRows) {
    rowsByIdentity.set(
      `${String(row._kind)}:${String(row._sourceChannelId)}`,
      row,
    );
  }
  for (const row of mentionRows) {
    const identity = `${String(row._kind)}:${String(row._sourceChannelId)}`;
    if (!rowsByIdentity.has(identity)) rowsByIdentity.set(identity, row);
  }
  const direction = sort === "asc" ? 1 : -1;
  const compareText = (left: unknown, right: unknown) => {
    const leftText = String(left);
    const rightText = String(right);
    return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
  };
  const activityTime = (value: unknown) =>
    value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return [...rowsByIdentity.values()]
    .sort((left, right) => {
      const activityComparison =
        activityTime(left._lastActivityAt) -
        activityTime(right._lastActivityAt);
      return (
        direction *
        (activityComparison ||
          compareText(left._kind, right._kind) ||
          compareText(left._sourceChannelId, right._sourceChannelId))
      );
    })
    .slice(offset, offset + limit + 1)
    .map((row, pageOrdinal) => ({ ...row, _pageOrdinal: pageOrdinal }));
}

export const __testInboxPgFallbackTimeout = {
  queryName: INBOX_PG_FALLBACK_QUERY_NAME,
  queryIdentity: INBOX_PG_FALLBACK_QUERY_IDENTITY,
  statementTimeoutCapMs: INBOX_PG_FALLBACK_STATEMENT_TIMEOUT_CAP_MS,
  timeoutScope: INBOX_PG_FALLBACK_TIMEOUT_SCOPE,
  effectiveTimeoutMs: inboxPgFallbackEffectiveTimeoutMs,
  errorTraceAttrs: inboxPgFallbackQueryErrorTraceAttrs,
  mergeAllPageKeyRows: mergeInboxAllPageKeyRows,
};

const UUID_TEXT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** pg_legacy: the canonical inline Postgres read (search, guest, authority transactions). */
type InboxTraceBackend = "rw_mv" | "pg_legacy";
type InboxTraceRoute = RisingWaveInboxTraceRoute;
// RisingWave is a hard dependency, so no inbox read is ever a fallback. The
// trace key stays for the consumed trace contract.
type InboxFallbackReason = "none";
type InboxTraceNegativeEvidenceBucket =
  | "does_not_prove_fact_recorded_or_ui_rendered"
  | "does_not_prove_fact_absent_or_message_ineligible"
  | "does_not_prove_future_message_suppression";

type InboxBackendSelection = {
  backend: InboxTraceBackend;
  fallbackReason: InboxFallbackReason;
  contractVersion?: number;
};
// Test seam: pool/query injection ONLY. It carries no routing or fallback
// semantics — those died with the fail-soft teardown (2026-09-21) and must
// not grow back here.
let risingWaveInboxTestOverrides: {
  getPool?: typeof getRisingWavePool;
  query?: typeof queryRisingWave;
} = {};

export const __testRisingWaveInbox = {
  set(overrides: typeof risingWaveInboxTestOverrides) {
    risingWaveInboxTestOverrides = { ...risingWaveInboxTestOverrides, ...overrides };
  },
  reset() {
    risingWaveInboxTestOverrides = {};
  },
};

function getRisingWaveInboxPool() {
  return (risingWaveInboxTestOverrides.getPool ?? getRisingWavePool)();
}

function queryRisingWaveInbox<T extends QueryResultRow = QueryResultRow>(
  pool: NonNullable<ReturnType<typeof getRisingWavePool>>,
  queryText: string,
  values?: unknown[],
) {
  return (risingWaveInboxTestOverrides.query ?? queryRisingWave)<T>(pool, queryText, values);
}

type RisingWaveInboxThreadReplyCountContractRow = {
  kind?: unknown;
  replyCount?: unknown;
};

function inboxTraceAttrs(
  backend: InboxTraceBackend,
  route: InboxTraceRoute,
  fallbackReason: InboxFallbackReason,
  contractVersion = RISINGWAVE_UNREAD_INBOX_CONTRACT_VERSION,
): TraceAttributes {
  return {
    "inbox.backend": backend,
    "inbox.route": route,
    "inbox.fallback_reason": fallbackReason,
    "inbox.contract_version": contractVersion,
    inbox_backend: backend,
    inbox_route: route,
    inbox_fallback_reason: fallbackReason,
    inbox_contract_version: contractVersion,
    // db_system follows the backend. Without this, successful RW reads land as
    // db_system=postgresql (the shared route tracer's default — one tracer
    // instance serves both PG and RW queries in a request, so the per-call
    // attrs are the only place the backend is known). Failures already set
    // db_system=risingwave via risingWaveInboxFailureAttrs; during the
    // 2026-09-19 incident this asymmetry made "successes counted by
    // db_system=risingwave" structurally zero regardless of path health.
    "db.system": backend === "rw_mv" ? "risingwave" : "postgresql",
    db_system: backend === "rw_mv" ? "risingwave" : "postgresql",
  };
}

function recordInboxBackendSelected(
  backend: InboxTraceBackend,
  route: InboxTraceRoute,
  fallbackReason: InboxFallbackReason,
  contractVersion?: number,
  extraAttrs: TraceAttributes = {},
) {
  addTraceEvent("inbox.backend.selected", {
    ...inboxTraceAttrs(backend, route, fallbackReason, contractVersion),
    ...extraAttrs,
  });
}

function getRisingWavePoolTraceAttrs(): TraceAttributes {
  const state = getRisingWavePoolState(getRisingWaveInboxPool());
  const timeoutMs = getRisingWaveConnectionTimeoutMillis();
  return {
    "rw.pool.total_count": state.rw_pool_total,
    "rw.pool.idle_count": state.rw_pool_idle,
    "rw.pool.waiting_count": state.rw_pool_waiting,
    "rw.timeout_ms": timeoutMs,
    "rw.pool.connection_timeout_ms": timeoutMs,
    timeout_ms: timeoutMs,
    ...state,
  };
}

function userPersonalMentionExistsForMessageAliasSql(userId: string): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM message_mentions mm
    WHERE mm.message_id = m.id
      AND mm.target_type = 'user'
      AND mm.target_id = ${userId}::uuid
      AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)
  )`;
}

function legacyChatActivityPromotionAllowedSql(userId: string, muteFromSeq: SQL): SQL {
  return activityPromotionAllowedByMuteSql({
    kindIsThread: sql`false`,
    messageSeq: sql.raw("m.seq"),
    muteFromSeq,
    personalMentionExists: userPersonalMentionExistsForMessageAliasSql(userId),
  });
}

function buildRisingWaveInboxItemsServingQuery(
  limit: number,
  offset: number,
  version = getRisingWaveInboxItemsServingVersion(),
  opts: {
    includeMentionOnlyInAllAndUnread?: boolean;
    sort?: "asc" | "desc";
    servingViewOverride?: string;
  } = {},
) {
  const sortDirection = opts.sort === "asc" ? "ASC" : "DESC";
  // Defaults to the unified chain now that Stage 3 is complete. The override
  // exists for parity scripts that still want to name a view explicitly.
  const inboxItems = opts.servingViewOverride ?? UNIFIED_CHAIN_VIEWS.serving;
  // 063 Stage 3: v4 is receiver-keyed. Derive the key expression from the view
  // actually being queried rather than from the flag, so the predicate can
  // never disagree with the FROM clause.
  const receiverKeyed = RECEIVER_KEYED_SERVING_VIEWS.has(inboxItems);
  const inboxReceiverExpr = receiverKeyed ? "i.receiver_id" : "i.user_id";
  // Non-empty ONLY in the receiver-keyed shape: v3 has no receiver_type column,
  // so emitting this against v3 would be a hard SQL error rather than a wrong
  // answer -- which is the failure mode we want if these two ever drift apart.
  const receiverTypePredicate = receiverKeyed ? "AND i.receiver_type = 'user'" : "";
  const mentionOnlyExpr = "i.mention_only";
  // v5 and later serving views carry the latest activity seq as a column. Earlier views need it looked
  // up in rw_messages by id -- a random point read that, cold in the block cache,
  // cost seconds per page (the Activity tail of 2026-09-25).
  const carriesActivitySeq = inboxItems === UNIFIED_CHAIN_VIEWS.serving;
  const latestActivitySeqExpr = carriesActivitySeq ? "i.latest_activity_seq" : "latest_activity.seq";
  const latestActivityJoin = carriesActivitySeq
    ? ""
    : `LEFT JOIN rw_messages latest_activity
        ON latest_activity.id = i.latest_activity_message_id`;
  const filterMentionOnlyPredicate = opts.includeMentionOnlyInAllAndUnread
    ? ""
    : `AND (
          $3::text = 'mentions'
          OR ${mentionOnlyExpr} = false
        )`;
  const activeMentionOnlyPredicate = opts.includeMentionOnlyInAllAndUnread
    ? ""
    : `AND ${mentionOnlyExpr} = false`;
  // CONTRACT: RW serving must stay behavior-compatible with the inline Postgres
  // SQL in getInboxItems below. SYNC REQUIRED: any field, filter, unread-count,
  // mention, ordering, pagination, or total-count semantic changed here or in
  // the PG SQL must be mirrored in the other side and in:
  // infra/risingwave/sql/024-risingwave-unread-inbox-full-materialized.sql
  // Then run: pnpm --filter @botiverse/raft-server risingwave:verify-inbox-parity
  // PG and RW stringify timestamptz with slightly different timezone/fractional
  // formatting. Keep the shared serving query byte-comparable at the API layer.
  const timestampText = (expr: string) =>
    `to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'`;

  return `
    WITH filtered AS (
      SELECT
        i.kind AS "kind",
        i.channel_id AS "channelId",
        i.channel_name AS "channelName",
        i.channel_type AS "channelType",
        i.last_message_id AS "lastMessageId",
        i.first_unread_message_id AS "firstUnreadMessageId",
        i.last_message_at AS "lastMessageAtRaw",
        i.last_message_preview AS "lastMessagePreview",
        i.last_message_sender_type AS "lastMessageSenderType",
        i.last_message_sender_id AS "lastMessageSenderId",
        NULL::text AS "lastMessageSenderName",
        i.unread_count::int AS "unreadCount",
        i.thread_channel_id AS "threadChannelId",
        i.parent_message_id AS "parentMessageId",
        i.parent_channel_id AS "parentChannelId",
        i.parent_channel_name AS "parentChannelName",
        i.parent_channel_type AS "parentChannelType",
        i.parent_message_preview AS "parentMessagePreview",
        i.parent_message_sender_type AS "parentMessageSenderType",
        i.parent_message_sender_id AS "parentMessageSenderId",
        i.latest_activity_preview AS "latestActivityPreview",
        i.latest_activity_sender_type AS "latestActivitySenderType",
        i.latest_activity_sender_id AS "latestActivitySenderId",
        i.latest_activity_message_id AS "latestActivityMessageId",
        ${latestActivitySeqExpr}::text AS "latestActivitySeq",
        i.last_activity_at AS "lastActivityAtRaw",
        i.last_reply_at AS "lastReplyAtRaw",
        i.reply_count::int AS "replyCount",
        i.task_number AS "taskNumber",
        i.task_status AS "taskStatus",
        i.task_claimed_by_type AS "taskClaimedByType",
        i.task_claimed_by_id AS "taskClaimedById",
        NULL::text AS "taskClaimedByName",
        i.has_mention AS "hasMention",
        ${mentionOnlyExpr} AS "mentionOnly",
        i.last_read_seq AS "materializedLastReadSeq",
        -- NULL-preserving on purpose: presence is the structural "readCursorPresent"
        -- JOIN fact below; value columns stay NULL for absent/corrupt rows and the
        -- shared constructor classifies (never COALESCE-pad to 0). maxReadSeq is
        -- text so the int8 domain reaches the mapper as a canonical decimal string.
        cursor_v2.last_read_seq::text AS "maxReadSeq",
        cursor_v2.read_state_version AS "readStateVersion",
        cursor_v2.user_id IS NOT NULL AS "readCursorPresent",
        i.activity_at AS "activityAt",
        i.has_any_mention AS "hasAnyMention"
      FROM ${inboxItems} i
      LEFT JOIN rw_user_channel_read_cursors_v2 cursor_v2
        ON cursor_v2.user_id = ${inboxReceiverExpr}
       AND cursor_v2.channel_id = COALESCE(i.channel_id, i.thread_channel_id)
      ${latestActivityJoin}
      WHERE i.server_id = $1
        AND ${inboxReceiverExpr} = $2
        ${receiverTypePredicate}
        AND ($3::text <> 'all' OR i.kind = 'thread' OR i.channel_type IN ('channel', 'private', 'joint', 'dm'))
        AND (
          ($3::text = 'all')
          OR ($3::text = 'unread' AND i.unread_count > 0)
          OR ($3::text = 'mentions' AND i.has_any_mention)
          OR ($3::text = 'unread_mentions' AND i.unread_count > 0 AND i.has_mention)
        )
        AND ($4::timestamptz IS NULL OR i.activity_at > $4::timestamptz)
        AND (
          $6::text IS NULL
          OR COALESCE(i.channel_name, '') ILIKE '%' || $6::text || '%'
          OR COALESCE(i.last_message_preview, '') ILIKE '%' || $6::text || '%'
          OR COALESCE(i.parent_channel_name, '') ILIKE '%' || $6::text || '%'
          OR COALESCE(i.parent_message_preview, '') ILIKE '%' || $6::text || '%'
          OR COALESCE(i.latest_activity_preview, '') ILIKE '%' || $6::text || '%'
        )
        ${filterMentionOnlyPredicate}
    ),
    faceted AS (
      SELECT
        filtered.*,
        CASE WHEN "kind" = 'thread' THEN "parentChannelId" ELSE "channelId" END AS "groupChannelId",
        CASE WHEN "kind" = 'thread' THEN "parentChannelName" ELSE "channelName" END AS "groupChannelName",
        CASE WHEN "kind" = 'thread' THEN "parentChannelType" ELSE "channelType" END AS "groupChannelType"
      FROM filtered
    ),
    group_counts AS (
      SELECT
        "groupChannelId",
        "groupChannelName",
        "groupChannelType",
        count(*)::int AS "groupCount",
        MAX("activityAt") AS "groupLastActivityAt"
      FROM faceted
      WHERE "groupChannelId" IS NOT NULL
      GROUP BY "groupChannelId", "groupChannelName", "groupChannelType"
    ),
    group_totals AS (
      SELECT
        array_agg("groupChannelId"::text ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupChannelIds",
        array_agg("groupChannelName" ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupChannelNames",
        array_agg("groupChannelType"::text ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupChannelTypes",
        array_agg("groupCount"::int ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupCounts",
        array_agg("groupLastActivityAt"::text ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupLastActivityAts"
      FROM group_counts
    ),
    selected AS (
      SELECT *
      FROM faceted
      -- RisingWave's pgwire parameter binder supports text/varchar here but
      -- does not implement PostgreSQL's uuid cast. Route parsing has already
      -- validated channelId as a UUID, while every RW channel identity in this
      -- graph is varchar, so text equality preserves the channel facet exactly.
      WHERE $5::text IS NULL OR "groupChannelId" = $5::text
    ),
    active_totals AS (
      SELECT
        COALESCE(sum(CASE WHEN ${mentionOnlyExpr} THEN 0 ELSE i.unread_count END), 0)::int AS "activeUnreadCount"
      FROM ${inboxItems} i
      WHERE i.server_id = $1
        AND ${inboxReceiverExpr} = $2
        ${receiverTypePredicate}
        AND (i.kind = 'thread' OR i.channel_type IN ('channel', 'private', 'joint', 'dm'))
        AND ($4::timestamptz IS NULL OR i.activity_at > $4::timestamptz)
        ${activeMentionOnlyPredicate}
    ),
    totals AS (
      SELECT
        count(*)::int AS "totalCount",
        COALESCE(sum("unreadCount"), 0)::int AS "totalUnreadCount"
      FROM selected
    ),
    page AS (
      SELECT *
      FROM selected
      ORDER BY "activityAt" ${sortDirection} NULLS LAST,
        "kind" ${sortDirection},
        COALESCE("threadChannelId", "channelId") ${sortDirection}
      LIMIT ${limit}
      OFFSET ${offset}
    ),
    page_enriched AS (
      SELECT
        p."kind",
        p."channelId",
        p."channelName",
        p."channelType",
        p."lastMessageId"::text AS "lastMessageId",
        p."latestActivitySeq"::text AS "latestActivitySeq",
        p."firstUnreadMessageId"::text AS "firstUnreadMessageId",
        ${timestampText('p."lastMessageAtRaw"')} AS "lastMessageAt",
        p."lastMessagePreview",
        p."lastMessageSenderType",
        p."lastMessageSenderId",
        p."lastMessageSenderName",
        p."unreadCount" AS "unreadCount",
        p."threadChannelId"::text AS "threadChannelId",
        p."parentMessageId"::text AS "parentMessageId",
        p."parentChannelId"::text AS "parentChannelId",
        p."parentChannelName",
        p."parentChannelType",
        p."parentMessagePreview",
        p."parentMessageSenderType",
        p."parentMessageSenderId",
        p."latestActivityPreview",
        p."latestActivitySenderType",
        p."latestActivitySenderId",
        p."latestActivityMessageId"::text AS "latestActivityMessageId",
        ${timestampText('p."lastActivityAtRaw"')} AS "lastActivityAt",
        CASE WHEN p."lastReplyAtRaw" IS NULL THEN NULL::text ELSE ${timestampText('p."lastReplyAtRaw"')} END AS "lastReplyAt",
        p."replyCount",
        p."taskNumber",
        p."taskStatus",
        p."taskClaimedByType",
        p."taskClaimedById",
        p."taskClaimedByName",
        (CASE WHEN p."mentionOnly" THEN p."hasAnyMention" ELSE p."hasMention" END) AS "hasMention",
        -- TODO(firstMentionMessageId): materialize first_mention_message_id in
        -- rw_inbox_items_v2 MV + parity; Postgres-path-first. Until then the RW
        -- backend does not project this column, so the shared result mapper in
        -- getInboxItems resolves row.firstMentionMessageId to null for RW rows.
        p."materializedLastReadSeq",
        p."maxReadSeq",
        p."readStateVersion",
        p."readCursorPresent",
        p."activityAt"
      FROM page p
    )
    SELECT
      page_enriched.*,
      totals."totalCount",
      totals."totalUnreadCount",
      active_totals."activeUnreadCount",
      group_totals."groupChannelIds",
      group_totals."groupChannelNames",
      group_totals."groupChannelTypes",
      group_totals."groupCounts",
      group_totals."groupLastActivityAts"
    FROM totals
    CROSS JOIN active_totals
    CROSS JOIN group_totals
    LEFT JOIN page_enriched ON true
    ORDER BY page_enriched."activityAt" ${sortDirection} NULLS LAST,
      page_enriched."kind" ${sortDirection},
      COALESCE(page_enriched."threadChannelId", page_enriched."channelId") ${sortDirection}
  `;
}

async function getInboxItemsFromRisingWave(
  serverId: string,
  userId: string,
  opts: {
    filter: InboxFilter;
    limit: number;
    offset: number;
    channelId?: string;
    q?: string;
    historyCutoff?: Date;
    includeMentionOnlyInAllAndUnread?: boolean;
    sort?: "asc" | "desc";
    servingVersion?: RisingWaveInboxItemsServingVersion;
    requestedServingVersion?: RisingWaveInboxItemsServingVersion;
    traceQuery: DbQueryTracer;
  },
): Promise<InboxQueryResult> {
  const client = getRisingWaveInboxPool();
  // CONTRACT: RisingWave is required. Unconfigured or a failed read throws;
  // there is no Postgres fallback. SYNC REQUIRED: error behavior changes here
  // must be reflected in tracing expectations and parity verification.
  if (!client) throw new RisingWaveNotConfiguredError("Activity items");

  const pageLimit = Math.trunc(opts.limit + 1);
  const pageOffset = Math.trunc(opts.offset);
  const inboxItemsVersion = opts.servingVersion ?? getRisingWaveInboxItemsServingVersion();
  const requestedInboxItemsVersion = opts.requestedServingVersion ?? inboxItemsVersion;
  const versionForceReason = requestedInboxItemsVersion === 3 && inboxItemsVersion === 2
    ? "history_cutoff"
    : "none";
  if (opts.historyCutoff && inboxItemsVersion !== 2) {
    throw new Error(`RisingWave inbox serving version ${inboxItemsVersion} does not support a history cutoff`);
  }
  // 063 Stage 3 is complete: Activity serves only from the receiver-keyed
  // unified chain. The per-server Feature Flag that ramped it is gone, so the
  // rollback for this read is a deploy revert, not a flag flip -- the v3 objects
  // outlive this commit by design and are dropped in a later, separate batch.
  const servingView = UNIFIED_CHAIN_VIEWS.serving;
  // Limit/offset are clamped by getInboxItems before this point and truncated
  // again here. Keep them as SQL literals because RisingWave does not accept
  // bound parameters in LIMIT/OFFSET in this shared serving query shape.
  const queryParams: unknown[] = [serverId, userId, opts.filter, opts.historyCutoff ?? null, opts.channelId ?? null, opts.q ?? null];
  // The serving-view attributes below only become queryable once ScopeDB has
  // matching typed columns (its row builder promotes an allowlist and silently
  // drops everything else). The query name IS already a typed column, so during
  // the ramp we also distinguish the chain there: that makes liveness queryable
  // on the day of the hotfix rather than after a schema change. It deliberately
  // splits the metric series while the flag is ramping - that separation is the
  // point, and it disappears when the flag reaches 100% and the branch is
  // deleted.
  const read = await opts.traceQuery(
    "channels.inbox_items_by_user",
    () => queryRisingWaveInbox(client, buildRisingWaveInboxItemsServingQuery(pageLimit, pageOffset, inboxItemsVersion, {
      includeMentionOnlyInAllAndUnread: opts.includeMentionOnlyInAllAndUnread,
      sort: opts.sort,
      servingViewOverride: servingView,
    }), queryParams),
    (queryRead) => ({
      ...inboxTraceAttrs("rw_mv", opts.filter, "none", inboxItemsVersion),
      backend: "risingwave",
      contract_version: inboxItemsVersion,
      "rw.acquire_wait_ms": Math.round(queryRead.acquireWaitMs),
      "rw.pool.total_count": queryRead.poolState.rw_pool_total,
      "rw.pool.idle_count": queryRead.poolState.rw_pool_idle,
      "rw.pool.waiting_count": queryRead.poolState.rw_pool_waiting,
      "rw.timeout_ms": getRisingWaveConnectionTimeoutMillis(),
      "rw.pool.connection_timeout_ms": getRisingWaveConnectionTimeoutMillis(),
      ...queryRead.poolState,
      rw_inbox_items_version: inboxItemsVersion,
      rw_inbox_items_requested_version: requestedInboxItemsVersion,
      rw_inbox_items_version_forced: versionForceReason !== "none",
      rw_inbox_items_version_force_reason: versionForceReason,
      rw_inbox_visibility_v3_flag_enabled: requestedInboxItemsVersion === 3,
      // 061 Stage 2: the serving view is no longer implied by the version -
      // Still reported explicitly rather than hardcoded at the call site: the
      // value a trace carries should be the view that was queried, so a future
      // swap shows up here instead of hiding behind a literal.
      rw_inbox_items_serving_view: servingView,
      rw_inbox_items_derivation_chain: false,
      // The flag is evaluated per server, so a server-gated rollout can only be
      // compared against its control group if the serving event carries the
      // dimension it was gated on. Nothing else on this event family does.
      // The key must be exactly `server_id`: the ScopeDB row builder promotes
      // only allowlisted attribute names into typed columns
      // (PROMOTED_IDENTITY_ATTRS in shared/tracing/eventRows.ts), and anything
      // else is dropped on that sink - a dotted key would be silently lost.
      server_id: serverId,
      filter: opts.filter,
      limit: opts.limit,
      offset: opts.offset,
      history_cutoff_present: Boolean(opts.historyCutoff),
      channel_id_present: Boolean(opts.channelId),
      query_present: Boolean(opts.q),
      row_count: queryRead.result.rows.length,
    }),
    (error) => risingWaveInboxFailureAttrs({
      route: opts.filter,
      error,
      contractVersion: inboxItemsVersion,
      queryName: "channels.inbox_items_by_user",
    }),
  );
  recordRisingWaveInboxThreadReplyCountNullContractViolation(read.result.rows, {
    filter: opts.filter,
    servedVersion: inboxItemsVersion,
    servingView,
    requestedVersion: requestedInboxItemsVersion,
    forcedV2ForHistoryCutoff: versionForceReason === "history_cutoff",
    historyCutoff: Boolean(opts.historyCutoff),
  });
  return { rows: read.result.rows, contractVersion: inboxItemsVersion };
}

async function enrichInboxRowsWithProfileNames(
  rows: any[],
  traceQuery: DbQueryTracer,
  executor: DatabaseExecutor = getDb(),
) {
  // CONTRACT: RW intentionally does not materialize user/agent profile tables.
  // Both PG legacy rows and RW rows pass through this page-bounded enrichment
  // for lastMessageSenderName/taskClaimedByName. SYNC REQUIRED: if those fields
  // move into either backend query, update the other backend and parity script.
  if (rows.length === 0) return;
  const db = executor;

  const senderUserIds = new Set<string>();
  const senderAgentIds = new Set<string>();
  const externalSenderMessageIds = new Set<string>();
  const claimantUserIds = new Set<string>();
  const claimantAgentIds = new Set<string>();

  for (const row of rows) {
    if (!row.lastMessageSenderName && row.lastMessageSenderId) {
      if (row.lastMessageSenderType === "user" && UUID_TEXT_RE.test(row.lastMessageSenderId)) senderUserIds.add(row.lastMessageSenderId);
      if (row.lastMessageSenderType === "agent" && UUID_TEXT_RE.test(row.lastMessageSenderId)) senderAgentIds.add(row.lastMessageSenderId);
      if (row.lastMessageSenderType === "external_projection" && row.lastMessageId) externalSenderMessageIds.add(row.lastMessageId);
    }
    if (!row.latestActivitySenderName
      && row.latestActivitySenderType === "external_projection"
      && row.latestActivityMessageId) {
      externalSenderMessageIds.add(row.latestActivityMessageId);
    }
    if (!row.taskClaimedByName && row.taskClaimedById) {
      if (row.taskClaimedByType === "user" && UUID_TEXT_RE.test(row.taskClaimedById)) claimantUserIds.add(row.taskClaimedById);
      if (row.taskClaimedByType === "agent" && UUID_TEXT_RE.test(row.taskClaimedById)) claimantAgentIds.add(row.taskClaimedById);
    }
  }

  const userIds = [...new Set([...senderUserIds, ...claimantUserIds])];
  const agentIds = [...new Set([...senderAgentIds, ...claimantAgentIds])];
  const userNameMap = new Map<string, string>();
  const agentNameMap = new Map<string, string>();
  const externalNameByMessageId = new Map<string, string>();

  if (userIds.length > 0) {
    const userRows = await traceQuery(
      "channels.inbox_profile_names.users",
      () => db
        .select({ id: users.id, name: users.name, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, userIds)),
      (result) => ({ input_count: userIds.length, result_count: result.length }),
    );
    for (const user of userRows) userNameMap.set(user.id, user.displayName || user.name);
  }

  if (agentIds.length > 0) {
    const agentRows = await traceQuery(
      "channels.inbox_profile_names.agents",
      () => db
        .select({ id: agents.id, name: agents.name, displayName: agents.displayName })
        .from(agents)
        .where(inArray(agents.id, agentIds)),
      (result) => ({ input_count: agentIds.length, result_count: result.length }),
    );
    for (const agent of agentRows) agentNameMap.set(agent.id, agent.displayName || agent.name);
  }

  if (externalSenderMessageIds.size > 0) {
    const externalRows = await traceQuery(
      "channels.inbox_profile_names.external_projections",
      () => db
        .select({ messageId: externalMessageAuthorFacts.messageId, displayName: externalMessageAuthorFacts.displayName })
        .from(externalMessageAuthorFacts)
        .where(inArray(externalMessageAuthorFacts.messageId, [...externalSenderMessageIds])),
      (result) => ({ input_count: externalSenderMessageIds.size, result_count: result.length }),
    );
    for (const external of externalRows) externalNameByMessageId.set(external.messageId, external.displayName);
    if (externalNameByMessageId.size !== externalSenderMessageIds.size) {
      throw new Error("External projection inbox row is missing immutable author fact");
    }
  }

  for (const row of rows) {
    if (!row.lastMessageSenderName && row.lastMessageSenderId) {
      if (row.lastMessageSenderType === "user") row.lastMessageSenderName = userNameMap.get(row.lastMessageSenderId) ?? null;
      if (row.lastMessageSenderType === "agent") row.lastMessageSenderName = agentNameMap.get(row.lastMessageSenderId) ?? null;
      if (row.lastMessageSenderType === "external_projection") row.lastMessageSenderName = externalNameByMessageId.get(row.lastMessageId) ?? null;
    }
    if (!row.latestActivitySenderName && row.latestActivitySenderType === "external_projection") {
      row.latestActivitySenderName = externalNameByMessageId.get(row.latestActivityMessageId) ?? null;
    }
    if (!row.taskClaimedByName && row.taskClaimedById) {
      if (row.taskClaimedByType === "user") row.taskClaimedByName = userNameMap.get(row.taskClaimedById) ?? null;
      if (row.taskClaimedByType === "agent") row.taskClaimedByName = agentNameMap.get(row.taskClaimedById) ?? null;
    }
  }
}

export async function getActivityUnreadTotalsBatch(
  inputs: ActivityUnreadTotalsBatchInput[],
  userId: string,
  opts: {
    traceQuery?: DbQueryTracer;
  } = {},
): Promise<Map<string, ActivityUnreadTotals>> {
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const uniqueInputs = [...new Map(inputs.map((input) => [input.serverId, input])).values()];
  if (uniqueInputs.length === 0) return new Map();
  const override = getActivityReadSourceOverride();
  if (override) return override.activityUnreadTotals(uniqueInputs, userId, { traceQuery });
  // Totals come from the SAME materialized view family as the Activity list —
  // one source, watermark included, so the historical cross-surface divergence
  // (task #235) cannot exist. RisingWave is required: unconfigured or a failed
  // read throws (no Postgres fallback, no fail-closed absence).
  return getActivityUnreadTotalsBatchFromRisingWave(
    uniqueInputs.map((input) => input.serverId),
    userId,
    traceQuery,
  );
}
function recordInboxServingRowsRead(
  rows: readonly InboxPolicySqlRow[],
  opts: { receiverType: "user"; receiverId: string; filter: InboxFilter; limit: number; offset: number },
) {
  addTraceEvent("inbox.serving_row.read.page", {
    "inbox.trace_contract_version": 1,
    filter: opts.filter,
    limit: opts.limit,
    offset: opts.offset,
    rows_count: rows.length,
    negative_evidence_bucket: "does_not_prove_fact_recorded_or_ui_rendered" satisfies InboxTraceNegativeEvidenceBucket,
  });
  for (const row of rows) {
    const sourceChannelId = typeof row.sourceChannelId === "string"
      ? row.sourceChannelId
      : typeof row.channelId === "string"
        ? row.channelId
        : typeof row.threadChannelId === "string"
          ? row.threadChannelId
          : "";
    addTraceEvent("inbox.serving_row.read", {
      "inbox.trace_contract_version": 1,
      "inbox.trace_join_key": sourceChannelId
        ? inboxTargetTraceJoinKey(opts.receiverType, opts.receiverId, sourceChannelId)
        : `${opts.receiverType}:${opts.receiverId}:unknown`,
      receiver_type: opts.receiverType,
      receiver_id: opts.receiverId,
      source_channel_id: sourceChannelId,
      target_kind: row.kind ?? "unknown",
      latest_notified_seq: row.latestNotifiedSeq ?? null,
      first_unread_seq: row.firstUnreadSeq ?? null,
      unread_count: row.unreadCount ?? 0,
      has_any_mention: row.hasAnyMention === true || row.hasMention === true,
      state: "row_returned",
      negative_evidence_bucket: "does_not_prove_fact_recorded_or_ui_rendered" satisfies InboxTraceNegativeEvidenceBucket,
    });
  }
}

function inboxTargetTraceJoinKey(receiverType: "user" | "agent", receiverId: string, sourceChannelId: string) {
  return `${receiverType}:${receiverId}:${sourceChannelId}`;
}

export type ActivityUnreadTotals = {
  totalUnreadCount: number;
  activeUnreadCount: number;
};

export type ActivityUnreadTotalsBatchInput = {
  serverId: string;
  historyCutoff?: Date;
};

function recordInboxMuteStateTrace(
  eventName: "inbox.mute_state.read" | "inbox.mute_state.write",
  opts: {
    receiverType: "user" | "agent";
    receiverId: string;
    sourceChannelId: string;
    state: "muted" | "unmuted";
    muteFromSeq: number | null;
    reason: "current_state" | "muted_from_next_seq" | "unmuted";
  },
) {
  addTraceEvent(eventName, {
    "inbox.trace_contract_version": 1,
    "inbox.trace_join_key": inboxTargetTraceJoinKey(opts.receiverType, opts.receiverId, opts.sourceChannelId),
    receiver_type: opts.receiverType,
    receiver_id: opts.receiverId,
    source_channel_id: opts.sourceChannelId,
    state: opts.state,
    reason: opts.reason,
    activity_muted: opts.state === "muted",
    mute_from_seq_present: opts.muteFromSeq != null,
    ...(opts.muteFromSeq != null ? { mute_from_seq: opts.muteFromSeq } : {}),
    negative_evidence_bucket: "does_not_prove_future_message_suppression" satisfies InboxTraceNegativeEvidenceBucket,
  });
}

function recordInboxReadRebuildRequested(
  userId: string,
  rows: readonly { channelId: string }[],
) {
  addTraceEvent("inbox.serving_row.rebuild.requested", {
    "inbox.trace_contract_version": 1,
    receiver_type: "user",
    receiver_id: userId,
    targets_count: rows.length,
    state: rows.length > 0 ? "read_cursor_advanced" : "no_active_inbox_rows",
    negative_evidence_bucket: "does_not_prove_fact_absent_or_message_ineligible" satisfies InboxTraceNegativeEvidenceBucket,
  });
  for (const row of rows) {
    addTraceEvent("inbox.serving_row.rebuild.target", {
      "inbox.trace_contract_version": 1,
      "inbox.trace_join_key": inboxTargetTraceJoinKey("user", userId, row.channelId),
      receiver_type: "user",
      receiver_id: userId,
      source_channel_id: row.channelId,
      state: "read_cursor_advanced",
      negative_evidence_bucket: "does_not_prove_fact_absent_or_message_ineligible" satisfies InboxTraceNegativeEvidenceBucket,
    });
  }
}

function recordRisingWaveInboxThreadReplyCountNullContractViolation(
  rows: readonly RisingWaveInboxThreadReplyCountContractRow[],
  opts: {
    filter: InboxFilter;
    servedVersion: RisingWaveInboxItemsServingVersion;
    requestedVersion: RisingWaveInboxItemsServingVersion;
    forcedV2ForHistoryCutoff: boolean;
    historyCutoff: boolean;
    servingView?: string;
  },
) {
  const nullThreadReplyCountRows = rows.filter((row) =>
    row.kind === "thread" && row.replyCount == null
  ).length;
  if (nullThreadReplyCountRows === 0) return;

  addTraceEvent("inbox.rw.thread_reply_count_null_contract_violation", {
    ...inboxTraceAttrs("rw_mv", opts.filter, "none", opts.servedVersion),
    state: "contract_violation",
    contract: "thread_reply_count_non_null",
    violated_field: "reply_count",
    target_kind: "thread",
    rw_inbox_items_version: opts.servedVersion,
    rw_inbox_items_requested_version: opts.requestedVersion,
    rw_inbox_items_version_forced: opts.forcedV2ForHistoryCutoff,
    rw_inbox_items_version_force_reason: opts.forcedV2ForHistoryCutoff ? "history_cutoff" : "none",
    rw_inbox_items_serving_view: opts.servingView ?? UNIFIED_CHAIN_VIEWS.serving,
    history_cutoff_present: opts.historyCutoff,
    rows_count: rows.length,
    null_thread_reply_count_rows: nullThreadReplyCountRows,
  });
}

async function getActivityUnreadTotalsBatchFromRisingWave(
  serverIds: string[],
  userId: string,
  traceQuery: DbQueryTracer,
): Promise<Map<string, ActivityUnreadTotals>> {
  const client = getRisingWaveInboxPool();
  if (!client) throw new RisingWaveNotConfiguredError("Activity unread totals");
  // Point lookup on the totals MV stacked on the serving view: every serving
  // predicate (mention-only zeroing, target kinds, watermark, free-tier
  // cutoff) is inherited by construction, so the count is definitionally the
  // sum of what the list shows. Rebuild scripts must carry this dependent
  // when swapping the serving view.
  const totals = new Map<string, ActivityUnreadTotals>();
  for (const serverId of serverIds) {
    totals.set(serverId, { totalUnreadCount: 0, activeUnreadCount: 0 });
  }
  const totalsView = UNIFIED_CHAIN_VIEWS.totals;
  const read = await traceQuery(
    "channels.activity_unread_totals_batch_by_user.derivation",
    () => queryRisingWaveInbox<{ serverId: string; totalUnreadCount: number }>(
      client,
      `SELECT
         t.server_id AS "serverId",
         t.total_unread_count AS "totalUnreadCount"
       FROM ${totalsView} t
       WHERE t.receiver_id = $1
         AND t.receiver_type = 'user'
         AND t.server_id = ANY($2)`,
      [userId, serverIds],
    ),
    (queryRead) => ({
      ...inboxTraceAttrs("rw_mv", "activity_totals", "none"),
      server_count: serverIds.length,
      row_count: queryRead.result.rows.length,
      // Every (user, server) membership has a totals row, so a missing row is not
      // an ordinary zero: the membership has not reached RisingWave. Counted, not
      // hidden; the badge still reads 0 for it.
      missing_row_count: serverIds.length - queryRead.result.rows.length,
      rw_inbox_items_serving_view: totalsView,
      rw_inbox_items_derivation_chain: true,
      rw_inbox_unified_chain: true,
    }),
  );
  for (const row of read.result.rows) {
    const count = Number(row.totalUnreadCount);
    totals.set(String(row.serverId), { totalUnreadCount: count, activeUnreadCount: count });
  }
  return totals;
}


function safeReadFrontierNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}



function attachRisingWaveReadStateToInboxItems(
  items: InboxItem[],
  rows: readonly InboxPolicySqlRow[],
): InboxItem[] {
  return items.map((item, index) => ({
    ...item,
    maxReadSeq: safeReadFrontierNumber(rows[index]?.maxReadSeq) ?? 0,
    readStateVersion: safeReadFrontierNumber(rows[index]?.readStateVersion) ?? 0,
  } as InboxItem));
}

export type InboxItemsResult = {
  items: InboxItem[];
  groups: InboxGroupCount[];
  hasMore: boolean;
  totalCount: number;
  totalUnreadCount: number;
  activeUnreadCount: number;
};

function inboxItemActivityAt(item: InboxItem): string {
  return item.kind === "thread" ? item.lastActivityAt : item.lastMessageAt;
}

function inboxItemIdentity(item: InboxItem): string {
  return `${item.kind}:${item.kind === "thread" ? item.threadChannelId : item.channelId}`;
}

function compareInboxItems(
  left: InboxItem,
  right: InboxItem,
  sort: "asc" | "desc" | undefined,
): number {
  const direction = sort === "asc" ? 1 : -1;
  const leftAt = new Date(inboxItemActivityAt(left)).getTime();
  const rightAt = new Date(inboxItemActivityAt(right)).getTime();
  if (leftAt !== rightAt) return (leftAt - rightAt) * direction;
  const kindDelta = left.kind.localeCompare(right.kind);
  if (kindDelta !== 0) return kindDelta * direction;
  return inboxItemIdentity(left).localeCompare(inboxItemIdentity(right)) * direction;
}

function mergeActivityGroups(
  active: readonly InboxGroupCount[],
  unfollowed: readonly InboxItem[],
): InboxGroupCount[] {
  const groups = new Map(active.map((group) => [group.channelId, { ...group }]));
  for (const item of unfollowed) {
    if (item.kind !== "thread") continue;
    const current = groups.get(item.parentChannelId);
    if (!current) {
      groups.set(item.parentChannelId, {
        channelId: item.parentChannelId,
        channelName: item.parentChannelName,
        channelType: item.parentChannelType as InboxGroupCount["channelType"],
        count: 1,
        lastActivityAt: item.lastActivityAt,
      });
      continue;
    }
    current.count += 1;
    if (new Date(item.lastActivityAt).getTime() > new Date(current.lastActivityAt).getTime()) {
      current.lastActivityAt = item.lastActivityAt;
    }
  }
  return [...groups.values()].sort((left, right) => {
    const leftDm = left.channelType === "dm" ? 0 : 1;
    const rightDm = right.channelType === "dm" ? 0 : 1;
    if (leftDm !== rightDm) return leftDm - rightDm;
    const activityDelta = new Date(right.lastActivityAt).getTime()
      - new Date(left.lastActivityAt).getTime();
    if (activityDelta !== 0) return activityDelta;
    const nameDelta = left.channelName.toLocaleLowerCase().localeCompare(
      right.channelName.toLocaleLowerCase(),
    );
    if (nameDelta !== 0) return nameDelta;
    return left.channelId.localeCompare(right.channelId);
  });
}

async function getUnifiedActivityAllInboxItems(
  serverId: string,
  userId: string,
  opts: InboxItemsQuery,
  limit: number,
  offset: number,
): Promise<InboxItemsResult> {
  const needed = offset + limit + 1;
  const active = await getInboxItems(serverId, userId, {
    ...opts,
    includeUnfollowedThreads: false,
    internalLimitCap: needed,
    filter: "all",
    limit: needed,
    offset: 0,
  });
  const allUnfollowed = await getActiveUnfollowedInboxItems(serverId, userId, {
    historyCutoff: opts.historyCutoff,
    q: opts.q,
    sort: opts.sort,
    traceQuery: opts.traceQuery,
    executor: opts.executor,
  });
  const pageUnfollowed = opts.channelId
    ? allUnfollowed.filter((item) => item.kind === "thread" && item.parentChannelId === opts.channelId)
    : allUnfollowed;
  const activeItems = active.items.map((item): InboxItem => item.kind === "thread"
    ? { ...item, isFollowing: true, unfollowedAt: null }
    : item);
  const activeKeys = new Set(activeItems.map(inboxItemIdentity));
  const unfollowedItems = pageUnfollowed.filter((item) => !activeKeys.has(inboxItemIdentity(item)));
  const combined = [...activeItems, ...unfollowedItems]
    .sort((left, right) => compareInboxItems(left, right, opts.sort));

  return {
    items: combined.slice(offset, offset + limit),
    groups: mergeActivityGroups(active.groups, allUnfollowed.filter(
      (item) => !activeKeys.has(inboxItemIdentity(item)),
    )),
    hasMore: active.hasMore || combined.length > offset + limit,
    totalCount: active.totalCount + unfollowedItems.length,
    totalUnreadCount: active.totalUnreadCount,
    activeUnreadCount: active.activeUnreadCount,
  };
}

async function buildRisingWaveInboxItemsResult(
  result: InboxQueryResult,
  limit: number,
  traceQuery: DbQueryTracer,
  db: DatabaseExecutor,
): Promise<InboxItemsResult> {
  const rawRows = result.rows as InboxPolicySqlRow[];
  const page = selectInboxPolicyPageRows(rawRows, limit);
  const pageRows = page.rows;
  await enrichInboxRowsWithProfileNames(pageRows, traceQuery, db);
  const mappedItems = mapInboxPolicyRowsToItems(pageRows, logInboxScopeCorruption, "servingPair") as InboxItem[];
  return {
    items: attachRisingWaveReadStateToInboxItems(mappedItems, pageRows),
    groups: readInboxGroupCounts(result.rows),
    hasMore: page.hasMore,
    totalCount: page.totalCount,
    totalUnreadCount: page.totalUnreadCount,
    activeUnreadCount: selectInboxPolicyActiveUnreadCount(rawRows, page.totalUnreadCount),
  };
}

export type InboxItemsQuery = NonNullable<Parameters<typeof getInboxItems>[2]>;

export async function getInboxItems(
  serverId: string,
  userId: string,
  opts: {
    filter?: InboxFilter;
    limit?: number;
    offset?: number;
    channelId?: string;
    q?: string;
    sort?: "asc" | "desc";
    historyCutoff?: Date;
    humanActivityMuteEnabled?: boolean;
    traceQuery?: DbQueryTracer;
    executor?: DatabaseExecutor;
    forcePostgres?: boolean;
    /** Bypass both RW and the serving-row projection for authority transactions. */
    forceCanonicalPostgres?: boolean;
    /** Activity All only: include unfollowed/not-done threads in the same page. */
    includeUnfollowedThreads?: boolean;
    /** Internal compositor escape hatch; HTTP callers remain capped at 100. */
    internalLimitCap?: number;
  } = {},
): Promise<InboxItemsResult> {
  const db = opts.executor ?? getDb();
  const guestAccess = await guestInboxChannelIds(serverId, userId, db);
  const filter = opts.filter ?? "all";
  const limitCap = Math.max(opts.internalLimitCap ?? 100, 1);
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), limitCap);
  const offset = Math.max(opts.offset ?? 0, 0);
  const channelId = opts.channelId;
  const q = opts.q?.trim() || undefined;
  const sortDirection = opts.sort === "asc" ? sql`ASC` : sql`DESC`;
  const historyCutoff = opts.historyCutoff;
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  if (filter === "all" && opts.includeUnfollowedThreads) {
    return getUnifiedActivityAllInboxItems(serverId, userId, { ...opts, q }, limit, offset);
  }
  const humanActivityMuteEnabled = opts.humanActivityMuteEnabled ?? true;
  const humanMuteFromSeqSelect = humanActivityMuteEnabled
    ? sql`mute.mute_from_seq`
    : sql`NULL::bigint`;
  const humanMuteStateJoinSql = humanActivityMuteEnabled
    ? sql`
      LEFT JOIN inbox_target_mute_states mute
        ON mute.receiver_type = 'user'
       AND mute.receiver_id = ${userId}::uuid
       AND mute.server_id = ${serverId}
       AND mute.source_channel_id = c.id
    `
    : sql``;

  // The derivation view is THE serving source, and RisingWave is a hard
  // dependency: unconfigured or a failed read is an error, never a reroute (no
  // PG fail-soft; a future RW->PG sink may add storage-level redundancy, not a
  // read branch). The canonical inline Postgres read below serves only what the
  // projections do not carry yet -- search (sender display names are not
  // materialized) and guest access (guest policy is not represented) -- plus the
  // explicit force escapes for authority transactions.
  const useCanonicalPostgres = Boolean(q)
    || guestAccess !== null
    || opts.forcePostgres === true
    || opts.forceCanonicalPostgres === true;
  const canonicalSelectionReason = q
    ? "search_not_projected"
    : guestAccess !== null
      ? "guest_policy_not_projected"
      : "forced_canonical";
  if (!useCanonicalPostgres) {
    const override = getActivityReadSourceOverride();
    if (override) return override.inboxItems(serverId, userId, { ...opts, q });
    const risingWaveResult = await getInboxItemsFromRisingWave(serverId, userId, {
      filter,
      limit,
      offset,
      channelId,
      sort: opts.sort,
      historyCutoff,
      includeMentionOnlyInAllAndUnread: humanActivityMuteEnabled,
      traceQuery,
    });
    recordInboxBackendSelected(
      "rw_mv",
      filter,
      "none",
      risingWaveResult.contractVersion,
    );
    return buildRisingWaveInboxItemsResult(risingWaveResult, limit, traceQuery, db);
  }

  const legacyActivityChannelFilterPredicate = channelId
    ? sql`AND CASE
        WHEN activity."kind" = 'thread' THEN activity."parentChannelId"
        ELSE activity."sourceChannelId"
      END = ${channelId}::uuid`
    : sql``;
  const legacyCombinedChannelFilterPredicate = channelId
    ? sql`AND CASE
        WHEN combined."kind" = 'thread' THEN combined."parentChannelId"
        ELSE combined."channelId"
      END = ${channelId}`
    : sql``;
  const legacySearchPattern = q ? `%${q}%` : null;
  const legacyActivitySearchPredicate = legacySearchPattern
    ? sql`AND (
        COALESCE(activity."channelName", '') ILIKE ${legacySearchPattern}
        OR COALESCE(activity."parentChannelName", '') ILIKE ${legacySearchPattern}
        OR COALESCE(activity."parentMessagePreview", '') ILIKE ${legacySearchPattern}
        OR EXISTS (
          SELECT 1
          FROM messages search_message
          LEFT JOIN users search_user
            ON search_message.sender_type = 'user'
           AND search_user.id::text = search_message.sender_id
          LEFT JOIN agents search_agent
            ON search_message.sender_type = 'agent'
           AND search_agent.id::text = search_message.sender_id
          WHERE search_message.channel_id = activity."storageChannelId"
            AND (
              search_message.content ILIKE ${legacySearchPattern}
              OR COALESCE(search_user.display_name, search_user.name, search_agent.display_name, search_agent.name, '') ILIKE ${legacySearchPattern}
            )
        )
      )`
    : sql``;
  const legacyCombinedSearchPredicate = legacySearchPattern
    ? sql`AND (
        COALESCE(combined."channelName", '') ILIKE ${legacySearchPattern}
        OR COALESCE(combined."parentChannelName", '') ILIKE ${legacySearchPattern}
        OR COALESCE(combined."lastMessagePreview", '') ILIKE ${legacySearchPattern}
        OR COALESCE(combined."parentMessagePreview", '') ILIKE ${legacySearchPattern}
        OR COALESCE(combined."latestActivityPreview", '') ILIKE ${legacySearchPattern}
        OR COALESCE(combined."lastMessageSenderName", '') ILIKE ${legacySearchPattern}
        OR COALESCE(combined."taskClaimedByName", '') ILIKE ${legacySearchPattern}
      )`
    : sql``;

  // Free-tier history cutoff on the canonical path. In the projected world
  // this predicate lives INSIDE the serving view (plan-derived); the inline
  // SQL carries it per request so the canonical reads keep the same product
  // behavior. Empty fragments when no cutoff: zero plan-shape change.
  const legacyCutoffAndM = historyCutoff ? sql` AND m.created_at > ${historyCutoff}` : sql``;
  const legacyCutoffAndMm = historyCutoff ? sql` AND mm.created_at > ${historyCutoff}` : sql``;

  const readLegacyInboxItemsFromPostgres = () =>
    filter === "all"
      ? traceQuery(
          "channels.inbox_items_by_user",
          () =>
            db.execute(sql`
    -- Canonical Postgres Inbox read (search, guest access, authority transactions).
    -- If you change selected fields, filters, unread/mention semantics,
    -- ordering, pagination, or totals here, update rw_inbox_items_v2 in
    -- infra/risingwave/sql/024-risingwave-unread-inbox-full-materialized.sql and rerun
    -- pnpm --filter @botiverse/raft-server risingwave:verify-inbox-parity.
    WITH eligible_chats AS (
      SELECT
        c.id,
        c.name,
        c.type,
        COALESCE(joint_storage.canonical_channel_id, c.id) AS storage_channel_id,
        COALESCE(rc.last_read_seq, 0) AS last_read_seq,
        ${humanMuteFromSeqSelect} AS mute_from_seq
      FROM channels c
      INNER JOIN channel_humans ch
        ON ch.channel_id = c.id
       AND ch.user_id = ${userId}
      LEFT JOIN joint_channel_servers joint_projection
        ON joint_projection.local_channel_id = c.id
       AND joint_projection.server_id = c.server_id
       AND joint_projection.status = 'active'
      LEFT JOIN joint_channels joint_storage
        ON joint_storage.id = joint_projection.joint_channel_id
       AND joint_storage.status = 'active'
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = c.id
       AND rc.user_id = ${userId}
      LEFT JOIN user_channel_inbox_states inbox
        ON inbox.channel_id = c.id
       AND inbox.user_id = ${userId}
      ${humanMuteStateJoinSql}
      WHERE c.server_id = ${serverId}
        AND ${guestInboxAccessSql(guestAccess, sql`c.id`)}
        AND c.type IN ('channel', 'private', 'joint', 'dm')
        AND c.deleted_at IS NULL
        AND c.archived_at IS NULL
        AND inbox.done_at IS NULL
    ),
    followed_threads AS (
      SELECT
        t.id AS source_channel_id,
        COALESCE(canonical_thread.id, t.id) AS storage_channel_id,
        COALESCE(canonical_thread.parent_message_id, t.parent_message_id) AS parent_message_id,
        COALESCE(local_parent.id, pm.channel_id) AS parent_channel_id,
        COALESCE(local_parent.name, parent_ch.name) AS parent_channel_name,
        COALESCE(local_parent.type::text, parent_ch.type::text) AS parent_channel_type,
        pm.content AS parent_message_preview,
        pm.sender_type AS parent_message_sender_type,
        pm.sender_id AS parent_message_sender_id,
        pm.created_at AS parent_message_created_at,
        pm.seq AS parent_message_seq,
        COALESCE(rc.last_read_seq, 0) AS last_read_seq
      FROM thread_follows tf
      INNER JOIN channels t
        ON t.id = tf.thread_channel_id
       AND t.type = 'thread'
       AND t.server_id = ${serverId}
       AND t.deleted_at IS NULL
      LEFT JOIN joint_channel_servers thread_projection
        ON thread_projection.local_channel_id = t.id
       AND thread_projection.server_id = ${serverId}
       AND thread_projection.status = 'active'
      LEFT JOIN joint_channels thread_joint
        ON thread_joint.id = thread_projection.joint_channel_id
       AND thread_joint.status = 'active'
      LEFT JOIN channels canonical_thread
        ON canonical_thread.id = thread_joint.canonical_channel_id
       AND canonical_thread.type = 'thread'
       AND canonical_thread.deleted_at IS NULL
      INNER JOIN messages pm
        ON pm.id = COALESCE(canonical_thread.parent_message_id, t.parent_message_id)
      INNER JOIN channels parent_ch
        ON parent_ch.id = pm.channel_id
       AND parent_ch.archived_at IS NULL
       AND parent_ch.deleted_at IS NULL
      LEFT JOIN joint_channels parent_joint
        ON parent_joint.canonical_channel_id = pm.channel_id
       AND parent_joint.status = 'active'
      LEFT JOIN joint_channel_servers parent_projection
        ON parent_projection.joint_channel_id = parent_joint.id
       AND parent_projection.server_id = ${serverId}
       AND parent_projection.status = 'active'
      LEFT JOIN channels local_parent
        ON local_parent.id = parent_projection.local_channel_id
       AND local_parent.type = 'joint'
       AND local_parent.archived_at IS NULL
       AND local_parent.deleted_at IS NULL
      LEFT JOIN channel_humans parent_member
        ON parent_member.channel_id = COALESCE(local_parent.id, parent_ch.id)
       AND parent_member.user_id = ${userId}
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = t.id
       AND rc.user_id = ${userId}
        WHERE ${guestInboxAccessSql(guestAccess, sql`COALESCE(local_parent.id, parent_ch.id)`)}
        AND tf.follower_type = 'user'
          AND tf.follower_id = ${userId}
          AND tf.done_at IS NULL
          AND tf.unfollowed_at IS NULL
          AND (COALESCE(local_parent.type::text, parent_ch.type::text) = 'channel' OR parent_member.user_id IS NOT NULL)
    ),
    activity AS MATERIALIZED (
      SELECT
        CASE WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END AS "kind",
        c.id AS "sourceChannelId",
        c.storage_channel_id AS "storageChannelId",
        c.name AS "channelName",
        c.type::text AS "channelType",
        NULL::uuid AS "parentMessageId",
        NULL::uuid AS "parentChannelId",
        NULL::text AS "parentChannelName",
        NULL::text AS "parentChannelType",
        NULL::text AS "parentMessagePreview",
        NULL::text AS "parentMessageSenderType",
        NULL::text AS "parentMessageSenderId",
        NULL::timestamptz AS "parentMessageCreatedAt",
        NULL::bigint AS "parentMessageSeq",
        c.last_read_seq AS "lastReadSeq",
        c.mute_from_seq AS "muteFromSeq",
        lm.created_at AS "activityAt",
        false AS "isOutsiderMention"
      FROM eligible_chats c
      INNER JOIN LATERAL (
        SELECT m.created_at
        FROM messages m
        WHERE m.channel_id = c.storage_channel_id
          AND ${legacyChatActivityPromotionAllowedSql(userId, sql`c.mute_from_seq`)}
        ORDER BY m.seq DESC
        LIMIT 1
      ) lm ON true
      UNION ALL
      SELECT
        'thread' AS "kind",
        t.source_channel_id AS "sourceChannelId",
        t.storage_channel_id AS "storageChannelId",
        NULL::text AS "channelName",
        NULL::text AS "channelType",
        t.parent_message_id AS "parentMessageId",
        t.parent_channel_id AS "parentChannelId",
        t.parent_channel_name AS "parentChannelName",
        t.parent_channel_type AS "parentChannelType",
        t.parent_message_preview AS "parentMessagePreview",
        t.parent_message_sender_type AS "parentMessageSenderType",
        t.parent_message_sender_id AS "parentMessageSenderId",
        t.parent_message_created_at AS "parentMessageCreatedAt",
        t.parent_message_seq AS "parentMessageSeq",
        t.last_read_seq AS "lastReadSeq",
        NULL::bigint AS "muteFromSeq",
        COALESCE(latest_reply.created_at, t.parent_message_created_at) AS "activityAt",
        false AS "isOutsiderMention"
      FROM followed_threads t
      LEFT JOIN LATERAL (
        SELECT m.created_at
        FROM messages m
        WHERE m.channel_id = t.storage_channel_id
        ORDER BY m.seq DESC
        LIMIT 1
      ) latest_reply ON true
      UNION ALL
      -- Notified outsider public-channel mentions: a user @-mentioned in a
      -- public channel they are NOT a member of gets a mention-only Activity
      -- row. notified_at is the notify pipeline's recorded policy verdict —
      -- Activity trusts it rather than re-deriving visibility. This behavior
      -- lived exclusively in write-time fan-out (serving_rows) until the
      -- 2026-09-21 teardown surfaced the gap (live regression, three prod
      -- cases verified against the old chain).
      SELECT
        'channel' AS "kind",
        oc.id AS "sourceChannelId",
        oc.id AS "storageChannelId",
        oc.name AS "channelName",
        oc.type::text AS "channelType",
        NULL::uuid AS "parentMessageId",
        NULL::uuid AS "parentChannelId",
        NULL::text AS "parentChannelName",
        NULL::text AS "parentChannelType",
        NULL::text AS "parentMessagePreview",
        NULL::text AS "parentMessageSenderType",
        NULL::text AS "parentMessageSenderId",
        NULL::timestamptz AS "parentMessageCreatedAt",
        NULL::bigint AS "parentMessageSeq",
        COALESCE(outsider_rc.last_read_seq, 0) AS "lastReadSeq",
        NULL::bigint AS "muteFromSeq",
        outsider_latest.created_at AS "activityAt",
        true AS "isOutsiderMention"
      FROM channels oc
      INNER JOIN LATERAL (
        SELECT m.created_at
        FROM message_mentions mm
        INNER JOIN messages m ON m.id = mm.message_id
        LEFT JOIN inbox_suppression_states mention_suppression
          ON mention_suppression.receiver_type = 'user'
         AND mention_suppression.receiver_id = ${userId}::uuid
         AND mention_suppression.target_kind = 'public_channel_mention'
         AND mention_suppression.target_channel_id = mm.channel_id
        WHERE mm.channel_id = oc.id
          AND mm.target_type = 'user'
          AND mm.target_id = ${userId}::uuid
          AND mm.notified_at IS NOT NULL
          AND mm.message_seq > COALESCE(mention_suppression.done_through_seq, 0)${legacyCutoffAndMm}
        ORDER BY mm.message_seq DESC
        LIMIT 1
      ) outsider_latest ON true
      LEFT JOIN channel_humans outsider_member
        ON outsider_member.channel_id = oc.id
       AND outsider_member.user_id = ${userId}
      LEFT JOIN user_channel_read_cursors outsider_rc
        ON outsider_rc.channel_id = oc.id
       AND outsider_rc.user_id = ${userId}
      WHERE oc.server_id = ${serverId}
        AND ${guestInboxAccessSql(guestAccess, sql`oc.id`)}
        AND oc.type = 'channel'
        AND oc.deleted_at IS NULL
        AND oc.archived_at IS NULL
        AND outsider_member.user_id IS NULL
      UNION ALL
      -- Notified outsider public-thread mentions: same admission verdict
      -- (notified_at) for threads the user does not follow, in public parent
      -- channels. Mirrors notified_public_thread_mentions in the filtered
      -- branch.
      SELECT
        'thread' AS "kind",
        ot.id AS "sourceChannelId",
        ot.id AS "storageChannelId",
        NULL::text AS "channelName",
        NULL::text AS "channelType",
        ot.parent_message_id AS "parentMessageId",
        outsider_parent_ch.id AS "parentChannelId",
        outsider_parent_ch.name AS "parentChannelName",
        outsider_parent_ch.type::text AS "parentChannelType",
        outsider_pm.content AS "parentMessagePreview",
        outsider_pm.sender_type AS "parentMessageSenderType",
        outsider_pm.sender_id AS "parentMessageSenderId",
        outsider_pm.created_at AS "parentMessageCreatedAt",
        outsider_pm.seq AS "parentMessageSeq",
        COALESCE(outsider_trc.last_read_seq, 0) AS "lastReadSeq",
        NULL::bigint AS "muteFromSeq",
        outsider_tm.created_at AS "activityAt",
        true AS "isOutsiderMention"
      FROM channels ot
      INNER JOIN messages outsider_pm ON outsider_pm.id = ot.parent_message_id
      INNER JOIN channels outsider_parent_ch ON outsider_parent_ch.id = outsider_pm.channel_id
      INNER JOIN LATERAL (
        SELECT m.created_at
        FROM message_mentions mm
        INNER JOIN messages m ON m.id = mm.message_id
        LEFT JOIN inbox_suppression_states mention_suppression
          ON mention_suppression.receiver_type = 'user'
         AND mention_suppression.receiver_id = ${userId}::uuid
         AND mention_suppression.target_kind = 'public_thread_mention'
         AND mention_suppression.target_channel_id = mm.channel_id
        WHERE mm.channel_id = ot.id
          AND mm.target_type = 'user'
          AND mm.target_id = ${userId}::uuid
          AND mm.notified_at IS NOT NULL
          AND mm.message_seq > COALESCE(mention_suppression.done_through_seq, 0)${legacyCutoffAndMm}
        ORDER BY mm.message_seq DESC
        LIMIT 1
      ) outsider_tm ON true
      LEFT JOIN thread_follows outsider_follow
        ON outsider_follow.thread_channel_id = ot.id
       AND outsider_follow.follower_type = 'user'
       AND outsider_follow.follower_id = ${userId}
       AND outsider_follow.done_at IS NULL
       AND outsider_follow.unfollowed_at IS NULL
      LEFT JOIN user_channel_read_cursors outsider_trc
        ON outsider_trc.channel_id = ot.id
       AND outsider_trc.user_id = ${userId}
      WHERE ot.server_id = ${serverId}
        AND ot.type = 'thread'
        AND ot.deleted_at IS NULL
        AND outsider_parent_ch.type = 'channel'
        AND ${guestInboxAccessSql(guestAccess, sql`outsider_parent_ch.id`)}
        AND outsider_parent_ch.archived_at IS NULL
        AND outsider_parent_ch.deleted_at IS NULL
        AND outsider_follow.thread_channel_id IS NULL
    ),
    filtered_activity AS (
      SELECT *
      FROM activity
      WHERE true
      ${legacyActivitySearchPredicate}
    ),
    group_counts AS (
      SELECT
        CASE WHEN "kind" = 'thread' THEN "parentChannelId" ELSE "sourceChannelId" END AS "groupChannelId",
        CASE WHEN "kind" = 'thread' THEN "parentChannelName" ELSE "channelName" END AS "groupChannelName",
        CASE WHEN "kind" = 'thread' THEN "parentChannelType" ELSE "channelType" END AS "groupChannelType",
        count(*)::int AS "groupCount",
        MAX("activityAt") AS "groupLastActivityAt"
      FROM filtered_activity
      GROUP BY
        CASE WHEN "kind" = 'thread' THEN "parentChannelId" ELSE "sourceChannelId" END,
        CASE WHEN "kind" = 'thread' THEN "parentChannelName" ELSE "channelName" END,
        CASE WHEN "kind" = 'thread' THEN "parentChannelType" ELSE "channelType" END
    ),
    group_totals AS (
      SELECT
        array_agg("groupChannelId"::text ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupChannelIds",
        array_agg("groupChannelName" ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupChannelNames",
        array_agg("groupChannelType" ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupChannelTypes",
        array_agg("groupCount" ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupCounts",
        array_agg("groupLastActivityAt"::text ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupLastActivityAts"
      FROM group_counts
    ),
    selected_activity AS (
      SELECT *
      FROM filtered_activity activity
      WHERE true
      ${legacyActivityChannelFilterPredicate}
    ),
    totals AS (
      SELECT count(*)::int AS "totalCount"
      FROM selected_activity
    ),
    unread_totals AS (
      SELECT count(m.id)::int AS "totalUnreadCount"
      FROM selected_activity a
      INNER JOIN messages m
        ON m.channel_id = a."storageChannelId"
       AND m.seq > a."lastReadSeq"${legacyCutoffAndM}
       AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
       AND ${legacyChatActivityPromotionAllowedSql(userId, sql`a."muteFromSeq"`)}
      WHERE NOT a."isOutsiderMention"
    ),
    page AS (
      SELECT *
      FROM selected_activity
      ORDER BY "activityAt" ${sortDirection}, "kind" ${sortDirection}, "sourceChannelId" ${sortDirection}
      LIMIT ${limit + 1}
      OFFSET ${offset}
    ),
    page_enriched AS (
      SELECT
        p."kind",
        CASE WHEN p."kind" = 'thread' THEN NULL::text ELSE p."sourceChannelId"::text END AS "channelId",
        p."channelName",
        p."channelType",
        latest_message.id::text AS "lastMessageId",
        CASE WHEN p."isOutsiderMention" THEN has_mention.first_mention_message_id::text ELSE first_unread.id::text END AS "firstUnreadMessageId",
        to_char((latest_message.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS "lastMessageAt",
        latest_message.content AS "lastMessagePreview",
        latest_message.sender_type AS "lastMessageSenderType",
        latest_message.sender_id AS "lastMessageSenderId",
        COALESCE(su.display_name, su.name, sa.display_name, sa.name) AS "lastMessageSenderName",
        CASE WHEN p."isOutsiderMention" THEN 0 ELSE COALESCE(unread.unread_count, 0) END::int AS "unreadCount",
        CASE WHEN p."kind" = 'thread' THEN p."sourceChannelId"::text ELSE NULL::text END AS "threadChannelId",
        p."parentMessageId"::text AS "parentMessageId",
        p."parentChannelId"::text AS "parentChannelId",
        p."parentChannelName",
        p."parentChannelType",
        p."parentMessagePreview",
        p."parentMessageSenderType",
        p."parentMessageSenderId",
        COALESCE(latest_message.content, p."parentMessagePreview") AS "latestActivityPreview",
        COALESCE(latest_message.sender_type, p."parentMessageSenderType") AS "latestActivitySenderType",
        COALESCE(latest_message.sender_id, p."parentMessageSenderId") AS "latestActivitySenderId",
        COALESCE(latest_message.id, p."parentMessageId")::text AS "latestActivityMessageId",
        COALESCE(latest_message.seq, p."parentMessageSeq")::text AS "latestActivitySeq",
        to_char((COALESCE(latest_message.created_at, p."parentMessageCreatedAt")) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS "lastActivityAt",
        CASE WHEN p."kind" = 'thread' THEN to_char((latest_message.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' ELSE NULL::text END AS "lastReplyAt",
        CASE WHEN p."kind" = 'thread' THEN COALESCE(reply_count.reply_count, 0)::int ELSE NULL::int END AS "replyCount",
        legacy_task.task_number AS "taskNumber",
        legacy_task.status AS "taskStatus",
        COALESCE(claimant_user.display_name, claimant_user.name, claimant_agent.display_name, claimant_agent.name) AS "taskClaimedByName",
        CASE WHEN p."isOutsiderMention" THEN true ELSE COALESCE(has_mention.found, false) END AS "hasMention",
        has_mention.first_mention_message_id::text AS "firstMentionMessageId",
        CASE WHEN p."isOutsiderMention" THEN true ELSE COALESCE(has_mention.found, false) END AS "hasAnyMention",
        p."isOutsiderMention" AS "mentionOnly",
        p."activityAt"
      FROM page p
      LEFT JOIN LATERAL (
        SELECT m.id, m.content, m.sender_type, m.sender_id, m.created_at, m.seq
        FROM messages m
        WHERE m.channel_id = p."storageChannelId"
          AND ${legacyChatActivityPromotionAllowedSql(userId, sql`p."muteFromSeq"`)}
        ORDER BY m.seq DESC
        LIMIT 1
      ) latest_message ON true
      LEFT JOIN LATERAL (
        SELECT m.id
        FROM messages m
        WHERE m.channel_id = p."storageChannelId"
          AND m.seq > p."lastReadSeq"${legacyCutoffAndM}
          AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          AND ${legacyChatActivityPromotionAllowedSql(userId, sql`p."muteFromSeq"`)}
        ORDER BY m.seq ASC
        LIMIT 1
      ) first_unread ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS unread_count
        FROM messages m
        WHERE m.channel_id = p."storageChannelId"
          AND m.seq > p."lastReadSeq"${legacyCutoffAndM}
          AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          AND ${legacyChatActivityPromotionAllowedSql(userId, sql`p."muteFromSeq"`)}
      ) unread ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS reply_count
        FROM messages m
        WHERE p."kind" = 'thread'
          AND m.channel_id = p."storageChannelId"
      ) reply_count ON true
      LEFT JOIN LATERAL (
        SELECT true AS found, mm.message_id AS first_mention_message_id
        FROM message_mentions mm
        WHERE mm.target_type = 'user'
          AND mm.target_id = ${userId}::uuid
          AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)
          AND (
            mm.channel_id = p."sourceChannelId"
            OR EXISTS (
              SELECT 1
              FROM joint_channel_servers base_projection
              INNER JOIN joint_channel_servers sibling_projection
                ON sibling_projection.joint_channel_id = base_projection.joint_channel_id
               AND sibling_projection.status = 'active'
              WHERE base_projection.local_channel_id = p."sourceChannelId"
                AND base_projection.status = 'active'
                AND sibling_projection.local_channel_id = mm.channel_id
            )
          )
          -- Outsider rows: the anchor ignores the READ cursor (a mention-only
          -- row must open the @ even when read) but respects DONE
          -- (suppression): after done, only a newer mention reopens and the
          -- anchor moves to it. Member rows keep cursor gating.
          AND (
            (NOT p."isOutsiderMention" AND mm.message_seq > p."lastReadSeq")
            OR (p."isOutsiderMention" AND mm.message_seq > COALESCE((
              SELECT s.done_through_seq
              FROM inbox_suppression_states s
              WHERE s.receiver_type = 'user'
                AND s.receiver_id = ${userId}::uuid
                AND s.target_kind = CASE p."kind" WHEN 'thread' THEN 'public_thread_mention' ELSE 'public_channel_mention' END
                AND s.target_channel_id = p."sourceChannelId"
            ), 0))
          )${legacyCutoffAndMm}
        ORDER BY mm.message_seq ASC
        LIMIT 1
      ) has_mention ON true
      LEFT JOIN tasks legacy_task
        ON legacy_task.message_id = p."parentMessageId"
      LEFT JOIN agents claimant_agent
        ON legacy_task.claimed_by_type = 'agent'
       AND claimant_agent.id::text = legacy_task.claimed_by_id
      LEFT JOIN users claimant_user
        ON legacy_task.claimed_by_type = 'user'
       AND claimant_user.id::text = legacy_task.claimed_by_id
      LEFT JOIN users su
        ON latest_message.sender_type = 'user'
       AND su.id::text = latest_message.sender_id
      LEFT JOIN agents sa
        ON latest_message.sender_type = 'agent'
       AND sa.id::text = latest_message.sender_id
    )
    SELECT
      page_enriched.*,
      totals."totalCount",
      unread_totals."totalUnreadCount",
      unread_totals."totalUnreadCount" AS "activeUnreadCount",
      group_totals."groupChannelIds",
      group_totals."groupChannelNames",
      group_totals."groupChannelTypes",
      group_totals."groupCounts",
      group_totals."groupLastActivityAts"
    FROM totals
    CROSS JOIN unread_totals
    CROSS JOIN group_totals
    LEFT JOIN page_enriched ON true
    ORDER BY page_enriched."activityAt" ${sortDirection} NULLS LAST,
      page_enriched."kind" ${sortDirection},
      COALESCE(page_enriched."threadChannelId", page_enriched."channelId") ${sortDirection}
  `),
          (queryResult) => ({
            ...inboxTraceAttrs("pg_legacy", filter, "none"),
            inbox_pg_selection_reason: canonicalSelectionReason,
            filter,
            limit,
            offset,
            history_cutoff_present: false,
            row_count: queryResult.rows.length,
            channel_id_present: Boolean(channelId),
            query_present: Boolean(q),
            human_activity_mute_enabled: humanActivityMuteEnabled,
            mute_state_join_present: humanActivityMuteEnabled,
          }),
        )
      : traceQuery(
          "channels.inbox_items_by_user",
          () =>
            db.execute(sql`
    -- Canonical Postgres Inbox read (search, guest access, authority transactions).
    -- If you change selected fields, filters, unread/mention semantics,
    -- ordering, pagination, or totals here, update rw_inbox_items_v2 in
    -- infra/risingwave/sql/024-risingwave-unread-inbox-full-materialized.sql and rerun
    -- pnpm --filter @botiverse/raft-server risingwave:verify-inbox-parity.
    WITH eligible_chats AS (
      SELECT
        c.id,
        c.name,
        c.type,
        COALESCE(joint_storage.canonical_channel_id, c.id) AS storage_channel_id,
        COALESCE(rc.last_read_seq, 0) AS last_read_seq,
        ${humanMuteFromSeqSelect} AS mute_from_seq
      FROM channels c
      INNER JOIN channel_humans ch
        ON ch.channel_id = c.id
       AND ch.user_id = ${userId}
      LEFT JOIN joint_channel_servers joint_projection
        ON joint_projection.local_channel_id = c.id
       AND joint_projection.server_id = c.server_id
       AND joint_projection.status = 'active'
      LEFT JOIN joint_channels joint_storage
        ON joint_storage.id = joint_projection.joint_channel_id
       AND joint_storage.status = 'active'
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = c.id
       AND rc.user_id = ${userId}
      LEFT JOIN user_channel_inbox_states inbox
        ON inbox.channel_id = c.id
       AND inbox.user_id = ${userId}
      ${humanMuteStateJoinSql}
      WHERE c.server_id = ${serverId}
        AND ${guestInboxAccessSql(guestAccess, sql`c.id`)}
        AND c.type IN ('channel', 'private', 'joint', 'dm')
        AND c.deleted_at IS NULL
        AND c.archived_at IS NULL
        AND inbox.done_at IS NULL
    ),
    notified_public_mentions AS (
      SELECT
        c.id,
        c.name,
        c.type,
        c.id AS storage_channel_id,
        COALESCE(rc.last_read_seq, 0) AS last_read_seq,
        m.id AS latest_mention_message_id,
        m.seq AS latest_mention_seq,
        m.created_at AS latest_mention_created_at,
        m.content AS latest_mention_preview,
        m.sender_type AS latest_mention_sender_type,
        m.sender_id AS latest_mention_sender_id
      FROM (
        SELECT
          mm.channel_id,
          max(mm.message_seq) AS latest_mention_seq
        FROM message_mentions mm
        INNER JOIN channels mention_channel
          ON mention_channel.id = mm.channel_id
        LEFT JOIN channel_humans existing_member
          ON existing_member.channel_id = mm.channel_id
         AND existing_member.user_id = ${userId}
        LEFT JOIN user_channel_inbox_states inbox
          ON inbox.channel_id = mm.channel_id
         AND inbox.user_id = ${userId}
        LEFT JOIN inbox_suppression_states mention_suppression
          ON mention_suppression.receiver_type = 'user'
         AND mention_suppression.receiver_id = ${userId}::uuid
         AND mention_suppression.target_kind = 'public_channel_mention'
         AND mention_suppression.target_channel_id = mm.channel_id
        WHERE mm.target_type = 'user'
          AND mm.target_id = ${userId}::uuid
          AND mm.notified_at IS NOT NULL
          AND mm.message_seq > COALESCE(mention_suppression.done_through_seq, 0)${legacyCutoffAndMm}
          AND mention_channel.server_id = ${serverId}
          AND ${guestInboxAccessSql(guestAccess, sql`mention_channel.id`)}
          AND mention_channel.type = 'channel'
          AND mention_channel.deleted_at IS NULL
          AND mention_channel.archived_at IS NULL
          AND existing_member.user_id IS NULL
          AND inbox.done_at IS NULL
        GROUP BY mm.channel_id
      ) latest_mention
      INNER JOIN channels c
        ON c.id = latest_mention.channel_id
      INNER JOIN messages m
        ON m.channel_id = latest_mention.channel_id
       AND m.seq = latest_mention.latest_mention_seq
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = c.id
       AND rc.user_id = ${userId}
    ),
    notified_public_thread_mentions AS (
      SELECT
        t.id AS source_channel_id,
        t.id AS storage_channel_id,
        t.parent_message_id,
        parent_ch.id AS parent_channel_id,
        parent_ch.name AS parent_channel_name,
        parent_ch.type::text AS parent_channel_type,
        pm.content AS parent_message_preview,
        pm.sender_type AS parent_message_sender_type,
        pm.sender_id AS parent_message_sender_id,
        pm.created_at AS parent_message_created_at,
        COALESCE(rc.last_read_seq, 0) AS last_read_seq,
        m.id AS latest_mention_message_id,
        m.seq AS latest_mention_seq,
        m.created_at AS latest_mention_created_at,
        m.content AS latest_mention_preview,
        m.sender_type AS latest_mention_sender_type,
        m.sender_id AS latest_mention_sender_id
      FROM (
        SELECT
          mm.channel_id,
          max(mm.message_seq) AS latest_mention_seq
        FROM message_mentions mm
        INNER JOIN channels thread_channel
          ON thread_channel.id = mm.channel_id
        INNER JOIN messages parent_message
          ON parent_message.id = thread_channel.parent_message_id
        INNER JOIN channels parent_channel
          ON parent_channel.id = parent_message.channel_id
        LEFT JOIN thread_follows existing_follow
          ON existing_follow.thread_channel_id = mm.channel_id
         AND existing_follow.follower_type = 'user'
         AND existing_follow.follower_id = ${userId}
         AND existing_follow.done_at IS NULL
         AND existing_follow.unfollowed_at IS NULL
        LEFT JOIN inbox_suppression_states mention_suppression
          ON mention_suppression.receiver_type = 'user'
         AND mention_suppression.receiver_id = ${userId}::uuid
         AND mention_suppression.target_kind = 'public_thread_mention'
         AND mention_suppression.target_channel_id = mm.channel_id
        WHERE mm.target_type = 'user'
          AND mm.target_id = ${userId}::uuid
          AND mm.notified_at IS NOT NULL
          AND mm.message_seq > COALESCE(mention_suppression.done_through_seq, 0)${legacyCutoffAndMm}
          AND thread_channel.server_id = ${serverId}
          AND thread_channel.type = 'thread'
          AND thread_channel.deleted_at IS NULL
          AND parent_channel.type = 'channel'
          AND ${guestInboxAccessSql(guestAccess, sql`parent_channel.id`)}
          AND parent_channel.archived_at IS NULL
          AND parent_channel.deleted_at IS NULL
          AND existing_follow.thread_channel_id IS NULL
        GROUP BY mm.channel_id
      ) latest_mention
      INNER JOIN channels t
        ON t.id = latest_mention.channel_id
      INNER JOIN messages pm
        ON pm.id = t.parent_message_id
      INNER JOIN channels parent_ch
        ON parent_ch.id = pm.channel_id
      INNER JOIN messages m
        ON m.channel_id = latest_mention.channel_id
       AND m.seq = latest_mention.latest_mention_seq
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = t.id
       AND rc.user_id = ${userId}
    ),
    followed_threads AS (
      SELECT
        t.id AS source_channel_id,
        COALESCE(canonical_thread.id, t.id) AS storage_channel_id,
        COALESCE(canonical_thread.parent_message_id, t.parent_message_id) AS parent_message_id,
        COALESCE(local_parent.id, pm.channel_id) AS parent_channel_id,
        COALESCE(local_parent.name, parent_ch.name) AS parent_channel_name,
        COALESCE(local_parent.type::text, parent_ch.type::text) AS parent_channel_type,
        pm.content AS parent_message_preview,
        pm.sender_type AS parent_message_sender_type,
        pm.sender_id AS parent_message_sender_id,
        pm.created_at AS parent_message_created_at,
        pm.seq AS parent_message_seq,
        legacy_task.task_number AS task_number,
        legacy_task.status AS task_status,
        legacy_task.claimed_by_type AS task_claimed_by_type,
        legacy_task.claimed_by_id AS task_claimed_by_id
      FROM thread_follows tf
      INNER JOIN channels t
        ON t.id = tf.thread_channel_id
       AND t.type = 'thread'
       AND t.server_id = ${serverId}
       AND t.deleted_at IS NULL
      LEFT JOIN joint_channel_servers thread_projection
        ON thread_projection.local_channel_id = t.id
       AND thread_projection.server_id = ${serverId}
       AND thread_projection.status = 'active'
      LEFT JOIN joint_channels thread_joint
        ON thread_joint.id = thread_projection.joint_channel_id
       AND thread_joint.status = 'active'
      LEFT JOIN channels canonical_thread
        ON canonical_thread.id = thread_joint.canonical_channel_id
       AND canonical_thread.type = 'thread'
       AND canonical_thread.deleted_at IS NULL
      INNER JOIN messages pm
        ON pm.id = COALESCE(canonical_thread.parent_message_id, t.parent_message_id)
      INNER JOIN channels parent_ch
        ON parent_ch.id = pm.channel_id
       AND parent_ch.archived_at IS NULL
       AND parent_ch.deleted_at IS NULL
      LEFT JOIN joint_channels parent_joint
        ON parent_joint.canonical_channel_id = pm.channel_id
       AND parent_joint.status = 'active'
      LEFT JOIN joint_channel_servers parent_projection
        ON parent_projection.joint_channel_id = parent_joint.id
       AND parent_projection.server_id = ${serverId}
       AND parent_projection.status = 'active'
      LEFT JOIN channels local_parent
        ON local_parent.id = parent_projection.local_channel_id
       AND local_parent.type = 'joint'
       AND local_parent.archived_at IS NULL
       AND local_parent.deleted_at IS NULL
      LEFT JOIN channel_humans parent_member
        ON parent_member.channel_id = COALESCE(local_parent.id, parent_ch.id)
       AND parent_member.user_id = ${userId}
      LEFT JOIN tasks legacy_task
        ON legacy_task.message_id = pm.id
      WHERE ${guestInboxAccessSql(guestAccess, sql`COALESCE(local_parent.id, parent_ch.id)`)}
        AND tf.follower_type = 'user'
        AND tf.follower_id = ${userId}
        AND tf.done_at IS NULL
        AND tf.unfollowed_at IS NULL
        AND (COALESCE(local_parent.type::text, parent_ch.type::text) = 'channel' OR parent_member.user_id IS NOT NULL)
    ),
    chat_items AS (
      SELECT
        CASE WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END AS "kind",
        c.id::text AS "channelId",
        c.name AS "channelName",
        c.type::text AS "channelType",
        lm.id::text AS "lastMessageId",
        first_unread.id::text AS "firstUnreadMessageId",
        to_char((lm.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS "lastMessageAt",
        lm.content AS "lastMessagePreview",
        lm.sender_type AS "lastMessageSenderType",
        lm.sender_id AS "lastMessageSenderId",
        COALESCE(su.display_name, su.name, sa.display_name, sa.name) AS "lastMessageSenderName",
        COALESCE(unread.unread_count, 0)::int AS "unreadCount",
        NULL::text AS "threadChannelId",
        NULL::text AS "parentMessageId",
        NULL::text AS "parentChannelId",
        NULL::text AS "parentChannelName",
        NULL::text AS "parentChannelType",
        NULL::text AS "parentMessagePreview",
        NULL::text AS "parentMessageSenderType",
        NULL::text AS "parentMessageSenderId",
        NULL::text AS "latestActivityPreview",
        NULL::text AS "latestActivitySenderType",
        NULL::text AS "latestActivitySenderId",
        NULL::text AS "latestActivityMessageId",
        lm.seq::text AS "latestActivitySeq",
        NULL::text AS "lastActivityAt",
        NULL::text AS "lastReplyAt",
        NULL::int AS "replyCount",
        NULL::int AS "taskNumber",
        NULL::text AS "taskStatus",
        NULL::text AS "taskClaimedByName",
        COALESCE(has_mention.found, false) AS "hasMention",
        has_mention.first_mention_message_id::text AS "firstMentionMessageId",
        COALESCE(has_mention.found, false) AS "hasAnyMention",
        false AS "mentionOnly",
        c.id::text AS "mentionSourceChannelId",
        lm.created_at AS "activityAt"
      FROM eligible_chats c
      INNER JOIN LATERAL (
        SELECT m.id, m.content, m.sender_type, m.sender_id, m.created_at, m.seq
        FROM messages m
        WHERE m.channel_id = c.storage_channel_id
          AND ${legacyChatActivityPromotionAllowedSql(userId, sql`c.mute_from_seq`)}
        ORDER BY m.seq DESC
        LIMIT 1
      ) lm ON true
      LEFT JOIN LATERAL (
        SELECT m.id
        FROM messages m
        WHERE m.channel_id = c.storage_channel_id
          AND m.seq > c.last_read_seq${legacyCutoffAndM}
          AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          AND ${legacyChatActivityPromotionAllowedSql(userId, sql`c.mute_from_seq`)}
        ORDER BY m.seq ASC
        LIMIT 1
      ) first_unread ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS unread_count
        FROM messages m
        WHERE m.channel_id = c.storage_channel_id
          AND m.seq > c.last_read_seq${legacyCutoffAndM}
          AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
          AND ${legacyChatActivityPromotionAllowedSql(userId, sql`c.mute_from_seq`)}
      ) unread ON true
      LEFT JOIN LATERAL (
        SELECT true AS found, mm.message_id AS first_mention_message_id
        FROM message_mentions mm
        WHERE mm.target_type = 'user'
          AND mm.target_id = ${userId}::uuid
          AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)
          AND (
            mm.channel_id = c.id
            OR EXISTS (
              SELECT 1
              FROM joint_channel_servers base_projection
              INNER JOIN joint_channel_servers sibling_projection
                ON sibling_projection.joint_channel_id = base_projection.joint_channel_id
               AND sibling_projection.status = 'active'
              WHERE base_projection.local_channel_id = c.id
                AND base_projection.status = 'active'
                AND sibling_projection.local_channel_id = mm.channel_id
            )
          )
          AND mm.message_seq > c.last_read_seq${legacyCutoffAndMm}
        ORDER BY mm.message_seq ASC
        LIMIT 1
      ) has_mention ON true
      LEFT JOIN users su
        ON lm.sender_type = 'user'
       AND su.id::text = lm.sender_id
      LEFT JOIN agents sa
        ON lm.sender_type = 'agent'
       AND sa.id::text = lm.sender_id
    ),
    mention_items AS (
      SELECT
        'channel' AS "kind",
        c.id::text AS "channelId",
        c.name AS "channelName",
        c.type::text AS "channelType",
        c.latest_mention_message_id::text AS "lastMessageId",
        c.latest_mention_message_id::text AS "firstUnreadMessageId",
        to_char((c.latest_mention_created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS "lastMessageAt",
        c.latest_mention_preview AS "lastMessagePreview",
        c.latest_mention_sender_type AS "lastMessageSenderType",
        c.latest_mention_sender_id AS "lastMessageSenderId",
        COALESCE(su.display_name, su.name, sa.display_name, sa.name) AS "lastMessageSenderName",
        0::int AS "unreadCount",
        NULL::text AS "threadChannelId",
        NULL::text AS "parentMessageId",
        NULL::text AS "parentChannelId",
        NULL::text AS "parentChannelName",
        NULL::text AS "parentChannelType",
        NULL::text AS "parentMessagePreview",
        NULL::text AS "parentMessageSenderType",
        NULL::text AS "parentMessageSenderId",
        NULL::text AS "latestActivityPreview",
        NULL::text AS "latestActivitySenderType",
        NULL::text AS "latestActivitySenderId",
        NULL::text AS "latestActivityMessageId",
        c.latest_mention_seq::text AS "latestActivitySeq",
        NULL::text AS "lastActivityAt",
        NULL::text AS "lastReplyAt",
        NULL::int AS "replyCount",
        NULL::int AS "taskNumber",
        NULL::text AS "taskStatus",
        NULL::text AS "taskClaimedByName",
        true AS "hasMention",
        c.latest_mention_message_id::text AS "firstMentionMessageId",
        true AS "hasAnyMention",
        true AS "mentionOnly",
        c.id::text AS "mentionSourceChannelId",
        c.latest_mention_created_at AS "activityAt"
      FROM notified_public_mentions c
      LEFT JOIN users su
        ON c.latest_mention_sender_type = 'user'
       AND su.id::text = c.latest_mention_sender_id
      LEFT JOIN agents sa
        ON c.latest_mention_sender_type = 'agent'
       AND sa.id::text = c.latest_mention_sender_id
    ),
    mention_thread_items AS (
      SELECT
        'thread' AS "kind",
        NULL::text AS "channelId",
        NULL::text AS "channelName",
        NULL::text AS "channelType",
        NULL::text AS "lastMessageId",
        c.latest_mention_message_id::text AS "firstUnreadMessageId",
        NULL::text AS "lastMessageAt",
        NULL::text AS "lastMessagePreview",
        NULL::text AS "lastMessageSenderType",
        NULL::text AS "lastMessageSenderId",
        NULL::text AS "lastMessageSenderName",
        0::int AS "unreadCount",
        c.source_channel_id::text AS "threadChannelId",
        c.parent_message_id::text AS "parentMessageId",
        c.parent_channel_id::text AS "parentChannelId",
        c.parent_channel_name AS "parentChannelName",
        c.parent_channel_type AS "parentChannelType",
        c.parent_message_preview AS "parentMessagePreview",
        c.parent_message_sender_type AS "parentMessageSenderType",
        c.parent_message_sender_id AS "parentMessageSenderId",
        c.latest_mention_preview AS "latestActivityPreview",
        c.latest_mention_sender_type AS "latestActivitySenderType",
        c.latest_mention_sender_id AS "latestActivitySenderId",
        c.latest_mention_message_id::text AS "latestActivityMessageId",
        c.latest_mention_seq::text AS "latestActivitySeq",
        to_char((c.latest_mention_created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS "lastActivityAt",
        to_char((c.latest_mention_created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS "lastReplyAt",
        0::int AS "replyCount",
        NULL::int AS "taskNumber",
        NULL::text AS "taskStatus",
        NULL::text AS "taskClaimedByName",
        true AS "hasMention",
        c.latest_mention_message_id::text AS "firstMentionMessageId",
        true AS "hasAnyMention",
        true AS "mentionOnly",
        c.source_channel_id::text AS "mentionSourceChannelId",
        c.latest_mention_created_at AS "activityAt"
      FROM notified_public_thread_mentions c
    ),
    thread_items AS (
      SELECT
        'thread' AS "kind",
        NULL::text AS "channelId",
        NULL::text AS "channelName",
        NULL::text AS "channelType",
        NULL::text AS "lastMessageId",
        first_unread.id::text AS "firstUnreadMessageId",
        NULL::text AS "lastMessageAt",
        NULL::text AS "lastMessagePreview",
        NULL::text AS "lastMessageSenderType",
        NULL::text AS "lastMessageSenderId",
        NULL::text AS "lastMessageSenderName",
        COALESCE(unread.unread_count, 0)::int AS "unreadCount",
        t.source_channel_id::text AS "threadChannelId",
        t.parent_message_id::text AS "parentMessageId",
        t.parent_channel_id::text AS "parentChannelId",
        t.parent_channel_name AS "parentChannelName",
        t.parent_channel_type AS "parentChannelType",
        t.parent_message_preview AS "parentMessagePreview",
        t.parent_message_sender_type AS "parentMessageSenderType",
        t.parent_message_sender_id AS "parentMessageSenderId",
        COALESCE(latest.latest_preview, t.parent_message_preview) AS "latestActivityPreview",
        COALESCE(latest.latest_sender_type, t.parent_message_sender_type) AS "latestActivitySenderType",
        COALESCE(latest.latest_sender_id, t.parent_message_sender_id) AS "latestActivitySenderId",
        COALESCE(latest.latest_message_id, t.parent_message_id)::text AS "latestActivityMessageId",
        COALESCE(latest.latest_message_seq, t.parent_message_seq)::text AS "latestActivitySeq",
        to_char((COALESCE(latest.last_reply_at, t.parent_message_created_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS "lastActivityAt",
        CASE WHEN latest.last_reply_at IS NULL THEN NULL::text ELSE to_char((latest.last_reply_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' END AS "lastReplyAt",
        COALESCE(stats.reply_count, 0)::int AS "replyCount",
        t.task_number AS "taskNumber",
        t.task_status AS "taskStatus",
        COALESCE(claimant_user.display_name, claimant_user.name, claimant_agent.display_name, claimant_agent.name) AS "taskClaimedByName",
        COALESCE(has_mention.found, false) AS "hasMention",
        has_mention.first_mention_message_id::text AS "firstMentionMessageId",
        COALESCE(has_mention.found, false) AS "hasAnyMention",
        false AS "mentionOnly",
        t.source_channel_id::text AS "mentionSourceChannelId",
        COALESCE(latest.last_reply_at, t.parent_message_created_at) AS "activityAt"
      FROM followed_threads t
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = t.source_channel_id
       AND rc.user_id = ${userId}
      LEFT JOIN LATERAL (
        SELECT
          count(*)::int AS reply_count
        FROM messages m
        WHERE m.channel_id = t.storage_channel_id
      ) stats ON true
      LEFT JOIN LATERAL (
        SELECT
          m.id AS latest_message_id,
          m.seq AS latest_message_seq,
          m.content AS latest_preview,
          m.sender_type AS latest_sender_type,
          m.sender_id AS latest_sender_id,
          m.created_at AS last_reply_at
        FROM messages m
        WHERE m.channel_id = t.storage_channel_id
        ORDER BY m.seq DESC
        LIMIT 1
      ) latest ON true
      LEFT JOIN LATERAL (
        SELECT m.id
        FROM messages m
        WHERE m.channel_id = t.storage_channel_id
          AND m.seq > COALESCE(rc.last_read_seq, 0)${legacyCutoffAndM}
          AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
        ORDER BY m.seq ASC
        LIMIT 1
      ) first_unread ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS unread_count
        FROM messages m
        WHERE m.channel_id = t.storage_channel_id
          AND m.seq > COALESCE(rc.last_read_seq, 0)${legacyCutoffAndM}
          AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId})
      ) unread ON true
      LEFT JOIN LATERAL (
        SELECT true AS found, mm.message_id AS first_mention_message_id
        FROM message_mentions mm
        WHERE mm.target_type = 'user'
          AND mm.target_id = ${userId}::uuid
          AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)
          AND (
            mm.channel_id = t.source_channel_id
            OR EXISTS (
              SELECT 1
              FROM joint_channel_servers base_projection
              INNER JOIN joint_channel_servers sibling_projection
                ON sibling_projection.joint_channel_id = base_projection.joint_channel_id
               AND sibling_projection.status = 'active'
              WHERE base_projection.local_channel_id = t.source_channel_id
                AND base_projection.status = 'active'
                AND sibling_projection.local_channel_id = mm.channel_id
            )
          )
          AND mm.message_seq > COALESCE(rc.last_read_seq, 0)${legacyCutoffAndMm}
        ORDER BY mm.message_seq ASC
        LIMIT 1
      ) has_mention ON true
      LEFT JOIN agents claimant_agent
        ON t.task_claimed_by_type = 'agent'
       AND claimant_agent.id::text = t.task_claimed_by_id
      LEFT JOIN users claimant_user
        ON t.task_claimed_by_type = 'user'
       AND claimant_user.id::text = t.task_claimed_by_id
    ),
    combined AS (
      SELECT * FROM chat_items
      UNION ALL
      SELECT * FROM mention_items
      UNION ALL
      SELECT * FROM mention_thread_items
      UNION ALL
      SELECT * FROM thread_items
    ),
    active_totals AS (
      SELECT COALESCE(sum("unreadCount"), 0)::int AS "activeUnreadCount"
      FROM combined
    ),
    filtered AS (
      -- Filter semantics:
      --   all      → every active inbox item (done_at IS NULL is enforced upstream
      --              via eligible_chats / thread_follows joins above).
      --   unread   → only items with unread messages.
      --   mentions → only items where the user has been @-mentioned in this
      --              channel/thread, regardless of read state. Plan A from
      --              #proj-uiux:6beb878c msg=691ade99 ("aggregated by
      --              thread/channel, includes read mentions").
      --   unread_mentions → unread items whose unread range contains an
      --              @-mention. This is the composed Activity v2
      --              Unread + Mentions state.
      --
      -- The existing per-row "hasMention" column is unread-scoped (used by the
      -- frontend @ badge — only shows when there's an unread mention). The
      -- mentions filter intentionally does NOT reuse that column: it runs an
      -- independent EXISTS against message_mentions so reading a mentioned
      -- message does not drop the row from the Mentions tab.
      SELECT *
      FROM combined
      WHERE true
        ${legacyCombinedSearchPredicate}
        AND (
          ${filter} = 'all'
          OR (${filter} = 'unread' AND "unreadCount" > 0)
          OR (${filter} = 'unread_mentions' AND "unreadCount" > 0 AND "hasMention" = true)
          OR (${filter} = 'mentions' AND EXISTS (
          SELECT 1 FROM message_mentions mm
          WHERE mm.target_type = 'user'
            AND mm.target_id = ${userId}::uuid
            AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)
            AND (
              mm.channel_id::text = combined."mentionSourceChannelId"
              OR EXISTS (
                SELECT 1
                FROM joint_channel_servers base_projection
                INNER JOIN joint_channel_servers sibling_projection
                  ON sibling_projection.joint_channel_id = base_projection.joint_channel_id
                 AND sibling_projection.status = 'active'
                WHERE base_projection.local_channel_id::text = combined."mentionSourceChannelId"
                  AND base_projection.status = 'active'
                  AND sibling_projection.local_channel_id = mm.channel_id
              )
            )
        ))
        )
    ),
    group_counts AS (
      SELECT
        CASE WHEN "kind" = 'thread' THEN "parentChannelId" ELSE "channelId" END AS "groupChannelId",
        CASE WHEN "kind" = 'thread' THEN "parentChannelName" ELSE "channelName" END AS "groupChannelName",
        CASE WHEN "kind" = 'thread' THEN "parentChannelType" ELSE "channelType" END AS "groupChannelType",
        count(*)::int AS "groupCount",
        MAX("activityAt") AS "groupLastActivityAt"
      FROM filtered
      GROUP BY
        CASE WHEN "kind" = 'thread' THEN "parentChannelId" ELSE "channelId" END,
        CASE WHEN "kind" = 'thread' THEN "parentChannelName" ELSE "channelName" END,
        CASE WHEN "kind" = 'thread' THEN "parentChannelType" ELSE "channelType" END
    ),
    group_totals AS (
      SELECT
        array_agg("groupChannelId" ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupChannelIds",
        array_agg("groupChannelName" ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupChannelNames",
        array_agg("groupChannelType" ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupChannelTypes",
        array_agg("groupCount" ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupCounts",
        array_agg("groupLastActivityAt"::text ORDER BY CASE WHEN "groupChannelType" = 'dm' THEN 0 ELSE 1 END, "groupLastActivityAt" DESC NULLS LAST, lower("groupChannelName"), "groupChannelId") AS "groupLastActivityAts"
      FROM group_counts
    ),
    selected AS (
      SELECT *
      FROM filtered combined
      WHERE true
      ${legacyCombinedChannelFilterPredicate}
    ),
    totals AS (
      SELECT
        count(*)::int AS "totalCount",
        COALESCE(sum("unreadCount"), 0)::int AS "totalUnreadCount"
      FROM selected
    ),
    page AS (
      SELECT *
      FROM selected
      ORDER BY "activityAt" ${sortDirection},
        "kind" ${sortDirection},
        COALESCE("threadChannelId", "channelId") ${sortDirection}
      LIMIT ${limit + 1}
      OFFSET ${offset}
    )
    SELECT
      page.*,
      totals."totalCount",
      totals."totalUnreadCount",
      active_totals."activeUnreadCount",
      group_totals."groupChannelIds",
      group_totals."groupChannelNames",
      group_totals."groupChannelTypes",
      group_totals."groupCounts",
      group_totals."groupLastActivityAts"
    FROM totals
    CROSS JOIN active_totals
    CROSS JOIN group_totals
    LEFT JOIN page ON true
    ORDER BY page."activityAt" ${sortDirection} NULLS LAST,
      page."kind" ${sortDirection},
      COALESCE(page."threadChannelId", page."channelId") ${sortDirection}
  `),
          (queryResult) => ({
            ...inboxTraceAttrs("pg_legacy", filter, "none"),
            inbox_pg_selection_reason: canonicalSelectionReason,
            filter,
            limit,
            offset,
            history_cutoff_present: false,
            row_count: queryResult.rows.length,
            channel_id_present: Boolean(channelId),
            query_present: Boolean(q),
            human_activity_mute_enabled: humanActivityMuteEnabled,
            mute_state_join_present: humanActivityMuteEnabled,
          }),
        );
  const result = await readLegacyInboxItemsFromPostgres();

  const rawRows = result.rows as InboxPolicySqlRow[];
  const page = selectInboxPolicyPageRows(rawRows, limit);
  const pageRows = page.rows as any[];

  await enrichInboxRowsWithProfileNames(pageRows, traceQuery, db);
  recordInboxBackendSelected("pg_legacy", filter, "none", undefined, {
    inbox_pg_selection_reason: canonicalSelectionReason,
  });
  // Row-read trace events (page + one per returned item). Event names keep
  // the historical inbox.serving_row.* family: they are a consumed trace
  // contract (join-key correlation), and renaming them is a trace-contract
  // change, not a teardown concern.
  recordInboxServingRowsRead(pageRows, {
    receiverType: "user",
    receiverId: userId,
    filter,
    limit,
    offset,
  });
  // PG canonical path: the read-cursor triple AND the union frontier pair
  // come from the SINGLE authority read (identical union to the list/unread
  // exits). The authority read runs on the SAME executor as the rest of the
  // flow — required when the caller is inside a transaction (activity-sync
  // authority tx), both for snapshot consistency and to avoid
  // single-connection (pglite) deadlock.
  await enrichInboxRowsWithReadCursorAuthority(pageRows, userId, traceQuery, db);
  const mappedItems = mapInboxPolicyRowsToItems(pageRows, logInboxScopeCorruption, "authority") as InboxItem[];
  const items = await attachReadStateToInboxItems(mappedItems, userId, db);

  return {
    items,
    groups: readInboxGroupCounts(result.rows),
    hasMore: page.hasMore,
    totalCount: page.totalCount,
    totalUnreadCount: page.totalUnreadCount,
    activeUnreadCount: selectInboxPolicyActiveUnreadCount(
      rawRows,
      page.totalUnreadCount,
    ),
  };
}

export async function markChannelInboxDone(
  userId: string,
  channelId: string,
  throughActivitySeq: unknown,
): Promise<ReadMutationAck> {
  // Released clients that predate bounded Done omit the frontier entirely.
  // Snapshot their canonical latest once at admission, then feed that exact S
  // through the unchanged strict guard and durable worker recheck. Explicit
  // null/malformed values remain on the strict V1 error path.
  let admittedThroughActivitySeq = throughActivitySeq;
  if (throughActivitySeq === undefined) {
    legacyDoneFrontierFallbacksTotal.inc({ target_kind: "channel" });
    admittedThroughActivitySeq = (await resolveChannelSuppressionTarget(channelId))?.latestSeqExact;
  }
  // A synchronous zero-write guard preserves the V1 400/409 contract. The
  // sequencer repeats it under the canonical content lock before committing
  // the atomic cursor + Done-state + suppression composite.
  const { target, frontier } = await assertChannelDoneFrontier({
    channelId,
    throughActivitySeq: admittedThroughActivitySeq,
  });
  const ack = await executeCompatibilityReadMutation({
    serverId: target.serverId,
    principalId: userId,
    mutation: {
      kind: "done",
      targetKind: "channel",
      scopeId: channelId,
      throughSeq: frontier.toString(),
    },
  });
  if (ack.terminalReason === "done_frontier_beyond_latest") {
    throw new DoneFrontierBeyondLatestError(channelId, frontier.toString(), null);
  }
  return ack;
}

/** Restore a channel or DM from durable Done history to the active Inbox. */
export async function markChannelInboxActive(userId: string, channelId: string) {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.update(userChannelInboxStates)
      .set({ doneAt: null, updatedAt: currentDate() })
      .where(and(
        eq(userChannelInboxStates.userId, userId),
        eq(userChannelInboxStates.channelId, channelId),
      ));
    await clearChannelDoneSuppression({ userId, channelId, executor: tx });
  });
  const sourceChannelId = await getMessageStorageChannelId(channelId);
}

export type ReadStateMutationResult = {
  channelId: string;
  maxReadSeq: number;
  readStateVersion: number;
  changed: boolean;
};

export type InboxReadLatestResult = {
  markedCount: number;
  scopes: ReadStateMutationResult[];
};

function readStateResultFromAckScope(scope: ReadMutationAck["scopes"][number]): ReadStateMutationResult {
  return {
    channelId: scope.scopeId,
    maxReadSeq: scope.maxReadSeq,
    readStateVersion: scope.readStateVersion,
    changed: scope.changed,
  };
}

/** Mark every active Inbox row read, including rows not loaded by the current page. */
export async function markInboxReadLatest(serverId: string, userId: string): Promise<InboxReadLatestResult> {
  const ack = await executeCompatibilityReadMutation({
    serverId,
    principalId: userId,
    mutation: { kind: "global_read_all" },
  });
  const rows = ack.scopes.map(readStateResultFromAckScope).filter((scope) => scope.changed);
  recordInboxReadRebuildRequested(userId, rows);
  return { markedCount: rows.length, scopes: rows };
}

export type ThreadFollowReason = "replied" | "authored" | "mentioned" | "manual";

/**
 * Write thread attention state. Ordinary auto-follow callers intentionally do
 * not override an explicit human unfollow; callers must opt in when a direct
 * mention, manual follow, or self-reply should reactivate a suppressed thread.
 */
export async function recordThreadFollow(
  followerType: "user" | "agent",
  followerId: string,
  threadChannelId: string,
  parentMessageId: string,
  reason: ThreadFollowReason,
  opts: {
    reactivateUnfollowed?: boolean;
    preserveExistingReason?: boolean;
    /**
     * Where the follower's read position starts when this call STARTS a follow (no row,
     * or a previously unfollowed one): "latest", or the seq before the message that
     * caused the follow so that message stays unread. An already-active follow keeps
     * its position. Omit only when the caller moves the position itself.
     */
    joinedThroughSeq?: number | "latest";
  } = {},
) {
  const db = getDb();
  const reactivateUnfollowed = opts.reactivateUnfollowed ?? false;
  const preserveExistingReason = opts.preserveExistingReason ?? false;
  const result = await db.execute(sql`
    WITH prev AS (
      SELECT unfollowed_at FROM thread_follows
      WHERE thread_channel_id = ${threadChannelId}::uuid
        AND follower_type = ${followerType}
        AND follower_id = ${followerId}::uuid
    )
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
      ${threadChannelId}::uuid,
      ${followerType},
      ${followerId}::uuid,
      ${parentMessageId}::uuid,
      ${reason},
      NULL,
      NULL
    )
    ON CONFLICT (thread_channel_id, follower_type, follower_id) DO UPDATE
    SET
      parent_message_id = EXCLUDED.parent_message_id,
      reason = CASE
        WHEN ${preserveExistingReason} THEN thread_follows.reason
        ELSE EXCLUDED.reason
      END,
      created_at = now(),
      done_at = NULL,
      unfollowed_at = NULL
    WHERE ${reactivateUnfollowed}
       OR thread_follows.unfollowed_at IS NULL
    RETURNING thread_channel_id,
      NOT EXISTS (SELECT 1 FROM prev WHERE prev.unfollowed_at IS NULL) AS started
  `);

  if (result.rows.length > 0) {
    await clearFollowedThreadSuppressionForReceiver({
      followerType,
      followerId,
      threadChannelId,
    });
  }
  const started = (result.rows[0] as { started?: boolean } | undefined)?.started === true;
  if (started && opts.joinedThroughSeq !== undefined) {
    await startReadPositionAtJoin(
      db,
      followerType === "user" ? "human" : "agent",
      followerId,
      threadChannelId,
      opts.joinedThroughSeq === "latest" ? undefined : opts.joinedThroughSeq,
    );
  }
}

/** Follow a thread manually (user). */
export async function followThread(userId: string, threadChannelId: string, parentMessageId: string) {
  await recordThreadFollow("user", userId, threadChannelId, parentMessageId, "manual", { reactivateUnfollowed: true });
  // Mark thread as read so existing messages don't appear as unread. A read-state fence refusal (the follower left the
  // Server meanwhile) must not fail the follow; any other error still surfaces.
  await markReadLatest(userId, threadChannelId).catch((error: unknown) => {
    if (!isReadMutationFenceRefusal(error)) throw error;
  });
}

/** Unfollow a thread for any supported follower type. */
export async function unfollowThreadForFollower(
  followerType: "user" | "agent",
  followerId: string,
  threadChannelId: string,
) {
  const db = getDb();
  const [thread] = await db
    .select({ parentMessageId: channels.parentMessageId })
    .from(channels)
    .where(and(eq(channels.id, threadChannelId), eq(channels.type, "thread")))
    .limit(1);
  const parentMessageId = thread?.parentMessageId
    ?? (await getJointThreadProjectionByLocalThread(threadChannelId))?.canonicalParentMessageId;
  if (!parentMessageId) return;

  await db.transaction(async (tx) => {
    const now = currentDate();
    await tx.insert(threadFollows).values({
      threadChannelId,
      followerType,
      followerId,
      parentMessageId,
      reason: "manual",
      doneAt: null,
      unfollowedAt: now,
    }).onConflictDoUpdate({
      target: [threadFollows.threadChannelId, threadFollows.followerType, threadFollows.followerId],
      set: { reason: "manual", unfollowedAt: now },
    });

    if (followerType === "user") {
      await writeThreadDoneSuppression({
        userId: followerId,
        threadChannelId,
        writeSite: INBOX_SUPPRESSION_WRITE_SITES.unfollowThreadForFollower,
        executor: tx,
      });
    }
  });

  if (followerType === "user") {
    // A read-state fence refusal must not fail the unfollow; any other error still surfaces.
    await markReadLatest(followerId, threadChannelId).catch((error: unknown) => {
      if (!isReadMutationFenceRefusal(error)) throw error;
    });
  }
}

/** Unfollow a thread (user). */
export async function unfollowThread(userId: string, threadChannelId: string) {
  await unfollowThreadForFollower("user", userId, threadChannelId);
}

/** Mark a thread as done (hide from active list, auto-restores on new messages). */
export async function markThreadDone(
  userId: string,
  threadChannelId: string,
  throughActivitySeq: unknown,
): Promise<ReadMutationAck> {
  let admittedThroughActivitySeq = throughActivitySeq;
  if (throughActivitySeq === undefined) {
    legacyDoneFrontierFallbacksTotal.inc({ target_kind: "thread" });
    admittedThroughActivitySeq = (await resolveThreadSuppressionTarget(threadChannelId))?.latestSeqExact;
  }
  const { target, frontier } = await assertThreadDoneFrontier({
    threadChannelId,
    throughActivitySeq: admittedThroughActivitySeq,
  });
  const ack = await executeCompatibilityReadMutation({
    serverId: target.serverId,
    principalId: userId,
    mutation: {
      kind: "done",
      targetKind: "thread",
      scopeId: threadChannelId,
      throughSeq: frontier.toString(),
    },
  });
  if (ack.terminalReason === "done_frontier_beyond_latest") {
    throw new DoneFrontierBeyondLatestError(threadChannelId, frontier.toString(), null);
  }
  return ack;
}

export type DeletedThreadDoneReceipt = {
  terminalReason: "legacy_done_target_unavailable";
  legacyNoop: true;
  retiredThroughActivitySeq: number;
  readStateVersion: number;
  changed: boolean;
};

/**
 * Retire a caller's durable Activity residue after its thread source has been
 * soft-deleted. The source is intentionally not recreated and no synthetic
 * Done suppression is written: `channel_read_all` admits the request only
 * from receiver-owned serving-row/fact/cursor evidence, advances to that
 * evidence boundary, and rebuilds the projection so refresh cannot resurrect
 * the stale row.
 */
export async function retireDeletedThreadDoneResidue(
  userId: string,
  threadChannelId: string,
  throughActivitySeq: unknown,
): Promise<DeletedThreadDoneReceipt> {
  if (throughActivitySeq === undefined) {
    // Count at admission rather than success: denied old-client attempts are
    // part of the compatibility population and must block premature removal.
    legacyDoneFrontierFallbacksTotal.inc({ target_kind: "thread" });
  } else if (parsePositiveCanonicalDecimal(throughActivitySeq) === null) {
    throw new DoneFrontierRequiredError(threadChannelId, throughActivitySeq);
  }

  addTraceEvent("thread_done.legacy_target_unavailable.admitted", {
    scope_id: threadChannelId,
    frontier_source: throughActivitySeq === undefined ? "omitted" : "explicit",
  });
  const state = await markReadLatest(userId, threadChannelId);
  return {
    terminalReason: "legacy_done_target_unavailable",
    legacyNoop: true,
    retiredThroughActivitySeq: state.maxReadSeq,
    readStateVersion: state.readStateVersion,
    changed: state.changed,
  };
}

/** Un-done a thread (restore to active list). */
export async function undoneThread(userId: string, threadChannelId: string) {
  const db = getDb();
  await db.transaction(async (tx) => {
    const [restored] = await tx.update(threadFollows)
      .set({ doneAt: null })
      .where(and(
        eq(threadFollows.threadChannelId, threadChannelId),
        eq(threadFollows.followerType, "user"),
        eq(threadFollows.followerId, userId),
      ))
      .returning({ unfollowedAt: threadFollows.unfollowedAt });
    // Restoring Done must not silently re-follow an explicitly unfollowed
    // thread. Its existing suppression remains the delivery authority until a
    // direct mention, self-participation, or explicit Follow clears it.
    if (restored && restored.unfollowedAt === null) {
      await clearThreadDoneSuppression({ userId, threadChannelId, executor: tx });
    }
  });
  const sourceChannelId = await getMessageStorageChannelId(threadChannelId);
}

/** Clear doneAt for all followers of a thread (called when new message arrives). */
export async function clearThreadDoneForAll(threadChannelId: string) {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.update(threadFollows)
      .set({ doneAt: null })
      .where(and(
        eq(threadFollows.threadChannelId, threadChannelId),
        isNotNull(threadFollows.doneAt),
        isNull(threadFollows.unfollowedAt),
      ));
    await clearFollowedThreadSuppressionForAll({ threadChannelId, executor: tx });
  });
}


// ── Unread tracking ──────────────────────────────────────

/** Mark a channel as read up to the given seq for one kinded principal.
 *  String callers retain the deployed human-self behavior. */
export async function markRead(
  principal: string | { kind: "human" | "agent"; id: string },
  channelId: string,
  seq: number,
): Promise<ReadStateMutationResult> {
  const channel = await getChannel(channelId, { includeDeleted: true });
  if (!channel) throw new Error("Channel not found");
  const resolved = typeof principal === "string"
    ? { kind: "human" as const, id: principal }
    : principal;
  const ack = await executeCompatibilityReadMutation({
    serverId: channel.serverId,
    principalKind: resolved.kind,
    principalId: resolved.id,
    mutation: { kind: "row_read", scopeId: channelId, throughSeq: seq },
  });
  const scope = ack.scopes.find((candidate) => candidate.scopeId === channelId);
  if (!scope) return { channelId, maxReadSeq: 0, readStateVersion: 0, changed: false };
  return readStateResultFromAckScope(scope);
}

async function getMessageStorageChannelId(channelId: string): Promise<string> {
  const channel = await getChannel(channelId);
  if (!channel) return channelId;
  if (channel.type === "thread") {
    const jointThread = await getJointThreadProjectionByLocalThread(channelId, channel.serverId);
    return jointThread?.canonicalThreadChannelId ?? channelId;
  }
  if (channel.type === "joint") {
    const resolved = await resolveChannelAccess({ serverId: channel.serverId, channelId });
    return resolved?.kind === "joint" ? resolved.canonicalChannelId : channelId;
  }
  return channelId;
}

async function getLatestMessageSeq(channelId: string): Promise<number> {
  const db = getDb();
  const storageChannelId = await getMessageStorageChannelId(channelId);
  const [latest] = await db
    .select({ seq: sql<number>`MAX(${messages.seq})::int` })
    .from(messages)
    .where(eq(messages.channelId, storageChannelId));

  return latest?.seq ?? 0;
}

export type InboxTargetActivityMuteState = {
  activityMuted: boolean;
  muteFromSeq: number | null;
  prefsVersion: number;
  changed: boolean;
};

export async function getInboxTargetActivityMuteState(
  receiverType: "user" | "agent",
  receiverId: string,
  sourceChannelId: string,
): Promise<InboxTargetActivityMuteState> {
  const db = getDb();
  const [state] = await db
    .select({
      activityMuted: inboxTargetMuteStates.activityMuted,
      muteFromSeq: inboxTargetMuteStates.muteFromSeq,
      prefsVersion: inboxTargetMuteStates.prefsVersion,
    })
    .from(inboxTargetMuteStates)
    .where(and(
      eq(inboxTargetMuteStates.receiverType, receiverType),
      eq(inboxTargetMuteStates.receiverId, receiverId),
      eq(inboxTargetMuteStates.sourceChannelId, sourceChannelId),
    ))
    .limit(1);

  const activityMuted = !!state?.activityMuted && state.muteFromSeq != null;
  const result = state
    ? { activityMuted, muteFromSeq: activityMuted ? state.muteFromSeq : null, prefsVersion: state.prefsVersion }
    : { activityMuted: false, muteFromSeq: null, prefsVersion: 0 };
  recordInboxMuteStateTrace("inbox.mute_state.read", {
    receiverType,
    receiverId,
    sourceChannelId,
    state: result.activityMuted ? "muted" : "unmuted",
    muteFromSeq: result.muteFromSeq,
    reason: "current_state",
  });
  return { ...result, changed: false };
}

export async function setInboxTargetActivityMuteState(opts: {
  receiverType: "user" | "agent";
  receiverId: string;
  serverId: string;
  sourceChannelId: string;
  activityMuted: boolean;
}): Promise<InboxTargetActivityMuteState> {
  const db = getDb();
  const now = currentDate();
  const current = await getInboxTargetActivityMuteState(opts.receiverType, opts.receiverId, opts.sourceChannelId);
  if (current.activityMuted === opts.activityMuted) {
    return { ...current, changed: false };
  }

  if (!opts.activityMuted) {
    const [state] = await db
      .insert(inboxTargetMuteStates)
      .values({
        receiverType: opts.receiverType,
        receiverId: opts.receiverId,
        serverId: opts.serverId,
        sourceChannelId: opts.sourceChannelId,
        activityMuted: false,
        muteFromSeq: null,
        prefsVersion: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          inboxTargetMuteStates.receiverType,
          inboxTargetMuteStates.receiverId,
          inboxTargetMuteStates.sourceChannelId,
        ],
        set: {
          serverId: opts.serverId,
          activityMuted: false,
          muteFromSeq: null,
          prefsVersion: sql`${inboxTargetMuteStates.prefsVersion} + 1`,
          updatedAt: now,
        },
      })
      .returning({
        prefsVersion: inboxTargetMuteStates.prefsVersion,
      });
    recordInboxMuteStateTrace("inbox.mute_state.write", {
      receiverType: opts.receiverType,
      receiverId: opts.receiverId,
      sourceChannelId: opts.sourceChannelId,
      state: "unmuted",
      muteFromSeq: null,
      reason: "unmuted",
    });
    return { activityMuted: false, muteFromSeq: null, prefsVersion: state.prefsVersion, changed: true };
  }

  const muteFromSeq = await getLatestMessageSeq(opts.sourceChannelId) + 1;
  const [state] = await db
    .insert(inboxTargetMuteStates)
    .values({
      receiverType: opts.receiverType,
      receiverId: opts.receiverId,
      serverId: opts.serverId,
      sourceChannelId: opts.sourceChannelId,
      activityMuted: true,
      muteFromSeq,
      prefsVersion: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        inboxTargetMuteStates.receiverType,
        inboxTargetMuteStates.receiverId,
        inboxTargetMuteStates.sourceChannelId,
      ],
      set: {
        serverId: opts.serverId,
        activityMuted: true,
        muteFromSeq,
        prefsVersion: sql`${inboxTargetMuteStates.prefsVersion} + 1`,
        updatedAt: now,
      },
    })
    .returning({
      prefsVersion: inboxTargetMuteStates.prefsVersion,
    });

  recordInboxMuteStateTrace("inbox.mute_state.write", {
    receiverType: opts.receiverType,
    receiverId: opts.receiverId,
    sourceChannelId: opts.sourceChannelId,
    state: "muted",
    muteFromSeq,
    reason: "muted_from_next_seq",
  });
  return { activityMuted: true, muteFromSeq, prefsVersion: state.prefsVersion, changed: true };
}

export type UserChannelMessageDisplayPrefs = {
  collapseLongMessages: boolean;
  prefsVersion: number;
  changed: boolean;
};

export async function getUserChannelMessageDisplayPrefs(
  userId: string,
  channelId: string,
): Promise<UserChannelMessageDisplayPrefs> {
  const db = getDb();
  const [state] = await db
    .select({
      collapseLongMessages: userChannelDisplayPrefs.collapseLongMessages,
      prefsVersion: userChannelDisplayPrefs.prefsVersion,
    })
    .from(userChannelDisplayPrefs)
    .where(and(
      eq(userChannelDisplayPrefs.userId, userId),
      eq(userChannelDisplayPrefs.channelId, channelId),
    ))
    .limit(1);

  const result = state
    ? { collapseLongMessages: state.collapseLongMessages, prefsVersion: state.prefsVersion }
    : { collapseLongMessages: true, prefsVersion: 0 };
  return { ...result, changed: false };
}

export async function setUserChannelMessageDisplayPrefs(opts: {
  userId: string;
  serverId: string;
  channelId: string;
  collapseLongMessages: boolean;
}): Promise<UserChannelMessageDisplayPrefs> {
  const db = getDb();
  const now = currentDate();
  const current = await getUserChannelMessageDisplayPrefs(opts.userId, opts.channelId);
  if (current.collapseLongMessages === opts.collapseLongMessages) {
    return { ...current, changed: false };
  }

  const [state] = await db
    .insert(userChannelDisplayPrefs)
    .values({
      userId: opts.userId,
      channelId: opts.channelId,
      serverId: opts.serverId,
      collapseLongMessages: opts.collapseLongMessages,
      prefsVersion: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        userChannelDisplayPrefs.userId,
        userChannelDisplayPrefs.channelId,
      ],
      set: {
        serverId: opts.serverId,
        collapseLongMessages: opts.collapseLongMessages,
        prefsVersion: sql`${userChannelDisplayPrefs.prefsVersion} + 1`,
        updatedAt: now,
      },
    })
    .returning({
      prefsVersion: userChannelDisplayPrefs.prefsVersion,
    });
  return { collapseLongMessages: opts.collapseLongMessages, prefsVersion: state.prefsVersion, changed: true };
}

export async function getActivityMutedUserIdsForMessage(opts: {
  serverId: string;
  sourceChannelId: string;
  userIds: string[];
  messageSeq: number;
  piercedUserIds?: Set<string>;
}): Promise<Set<string>> {
  const db = getDb();
  if (opts.userIds.length === 0) return new Set();
  const rows = await db
    .select({
      receiverId: inboxTargetMuteStates.receiverId,
      activityMuted: inboxTargetMuteStates.activityMuted,
      muteFromSeq: inboxTargetMuteStates.muteFromSeq,
    })
    .from(inboxTargetMuteStates)
    .where(and(
      eq(inboxTargetMuteStates.receiverType, "user"),
      eq(inboxTargetMuteStates.serverId, opts.serverId),
      eq(inboxTargetMuteStates.sourceChannelId, opts.sourceChannelId),
      inArray(inboxTargetMuteStates.receiverId, opts.userIds),
    ));
  const piercedUserIds = opts.piercedUserIds ?? new Set<string>();
  return new Set(rows
    .filter((row) => row.activityMuted && row.muteFromSeq != null && isActivityPromotionSuppressedByMute({
      kind: "channel",
      messageSeq: opts.messageSeq,
      muteFromSeq: row.muteFromSeq,
      personalMention: piercedUserIds.has(row.receiverId),
    }))
    .map((row) => row.receiverId));
}

export async function getActivityMutedAgentIdsForMessage(opts: {
  serverId: string;
  sourceChannelId: string;
  agentIds: string[];
  messageSeq: number;
  piercedAgentIds?: Set<string>;
}): Promise<Set<string>> {
  if (opts.agentIds.length === 0) return new Set();
  const db = getDb();
  const rows = await db
    .select({
      receiverId: inboxTargetMuteStates.receiverId,
      activityMuted: inboxTargetMuteStates.activityMuted,
      muteFromSeq: inboxTargetMuteStates.muteFromSeq,
    })
    .from(inboxTargetMuteStates)
    .where(and(
      eq(inboxTargetMuteStates.receiverType, "agent"),
      eq(inboxTargetMuteStates.serverId, opts.serverId),
      eq(inboxTargetMuteStates.sourceChannelId, opts.sourceChannelId),
      inArray(inboxTargetMuteStates.receiverId, opts.agentIds),
    ));
  const piercedAgentIds = opts.piercedAgentIds ?? new Set<string>();
  return new Set(rows
    .filter((row) => row.activityMuted && row.muteFromSeq != null && isActivityPromotionSuppressedByMute({
      kind: "channel",
      messageSeq: opts.messageSeq,
      muteFromSeq: row.muteFromSeq,
      personalMention: piercedAgentIds.has(row.receiverId),
    }))
    .map((row) => row.receiverId));
}

async function getLatestUnreadMessageSeqForUser(userId: string, channelId: string): Promise<number> {
  const db = getDb();
  const storageChannelId = await getMessageStorageChannelId(channelId);
  const [latest] = await db
    .select({ seq: sql<number>`MAX(${messages.seq})::int` })
    .from(messages)
    .where(and(
      eq(messages.channelId, storageChannelId),
      sql`NOT (${messages.senderType} = 'user' AND ${messages.senderId} = ${userId})`,
    ));

  return latest?.seq ?? 0;
}

/** Mark a channel as fully read up to its latest message.
 *  String callers retain the deployed human-self behavior. Kinded callers are
 *  used only after the route/auth layer has resolved the intended receiver;
 *  the sequencer independently rechecks receiver membership by kind. */
export async function markReadLatest(
  principal: string | { kind: "human" | "agent"; id: string },
  channelId: string,
  options: { actingUserId?: string } = {},
): Promise<ReadStateMutationResult> {
  const channel = await getChannel(channelId, { includeDeleted: true });
  if (!channel) throw new Error("Channel not found");
  const resolved = typeof principal === "string"
    ? { kind: "human" as const, id: principal }
    : principal;
  const ack = await executeCompatibilityReadMutation({
    serverId: channel.serverId,
    principalKind: resolved.kind,
    principalId: resolved.id,
    mutation: { kind: "channel_read_all", scopeId: channelId },
    // Task #93 line B: a human writing an agent receiver's read state is fenced as the delegating actor.
    actor: resolved.kind === "agent" && options.actingUserId ? { kind: "human", userId: options.actingUserId } : undefined,
  });
  const scope = ack.scopes.find((candidate) => candidate.scopeId === channelId);
  if (!scope) return { channelId, maxReadSeq: 0, readStateVersion: 0, changed: false };
  return readStateResultFromAckScope(scope);
}

/** Mark a channel as unread by rewinding the read cursor to just before the latest unread-eligible message. */
export async function markUnread(userId: string, channelId: string): Promise<ReadStateMutationResult & { unreadCount: number }> {
  const channel = await getChannel(channelId, { includeDeleted: true });
  if (!channel) throw new Error("Channel not found");
  const boundary = await resolveReadMutationUnreadBoundary({
    serverId: channel.serverId,
    principalId: userId,
    scopeId: channelId,
  });
  if (boundary.latestUnreadEligibleSeq <= 0) {
    return { channelId, maxReadSeq: 0, readStateVersion: 0, changed: false, unreadCount: 0 };
  }
  const ack = await executeCompatibilityReadMutation({
    serverId: channel.serverId,
    principalId: userId,
    mutation: { kind: "row_unread", scopeId: channelId, throughSeq: boundary.throughSeq },
  });
  const scope = ack.scopes.find((candidate) => candidate.scopeId === channelId);
  if (!scope) return { channelId, maxReadSeq: 0, readStateVersion: 0, changed: false, unreadCount: 0 };
  return {
    ...readStateResultFromAckScope(scope),
    unreadCount: Math.max(boundary.latestUnreadEligibleSeq - scope.maxReadSeq, 0),
  };
}

/**
 * Sidebar unread comes from ONE RisingWave view, rw_conversation_unread_v2
 * (infra/risingwave/sql/068-chain-mention-v6-consumers.sql), a projection of the
 * unified chain: rw_inbox_normal_v4 + muted subscriptions (full count,
 * rw_inbox_muted_full_v1) + rw_inbox_mention_v6. Every rule -- membership, muted, joint storage mapping,
 * followed-thread visibility, free-plan eligibility (rw_target_eligible_v1), the
 * unread predicate (own sends, self-caused system messages and noise subtypes
 * excluded) and mention admission -- lives in the chain, so these readers only
 * select. There is no Postgres fallback: with no RisingWave, or a failed read,
 * the request fails.
 *
 * Non-joined public channels carry no count. The summary asks, in the same round
 * trip, whether each one has anything past the user's cursor (`hasNew`): a
 * per-request lookup over the server's public channels, never a users x public
 * channels expansion.
 */
const CONVERSATION_UNREAD_CONTRACT_VERSION = 3;

function conversationUnreadRwTraceAttrs(read: { acquireWaitMs: number; poolState: RisingWavePoolState }): TraceAttributes {
  return {
    backend: "risingwave",
    "rw.acquire_wait_ms": Math.round(read.acquireWaitMs),
    "rw.pool.total_count": read.poolState.rw_pool_total,
    "rw.pool.idle_count": read.poolState.rw_pool_idle,
    "rw.pool.waiting_count": read.poolState.rw_pool_waiting,
    "rw.timeout_ms": getRisingWaveConnectionTimeoutMillis(),
    "rw.pool.connection_timeout_ms": getRisingWaveConnectionTimeoutMillis(),
    ...read.poolState,
  };
}

type ConversationUnreadRead<T> = { rows: T; rwAttrs: TraceAttributes };


function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

async function readConversationUnreadSummaryRows(
  query: ConversationUnreadSummaryQuery,
): Promise<ConversationUnreadRead<ConversationUnreadRow[]>> {
  const override = getConversationUnreadSourceOverride();
  if (override) return { rows: await override.summaryRows(query), rwAttrs: {} };
  const pool = getRisingWaveInboxPool();
  if (!pool) throw new RisingWaveNotConfiguredError("sidebar unread");
  // Public arm: the server's live public channels the user has NOT joined (a
  // joined one is a subscribed row of the view, muted included), still eligible
  // under the plan (the chain's rule), whose latest seq is past the user's
  // cursor. rw_channels is read by its server_id index; the other joins are
  // point lookups by target / (user, channel).
  const publicArm = query.includePublicNew
    ? `
      UNION ALL
      SELECT c.server_id AS server_id, c.id AS target_id, 'channel' AS kind, FALSE AS subscribed,
             CAST(0 AS BIGINT) AS unread_count, CAST(0 AS BIGINT) AS mention_unread,
             CAST(0 AS BIGINT) AS total_mentions, TRUE AS has_new,
             tl.latest_seq AS latest_seq, CAST(NULL AS VARCHAR) AS latest_message_id,
             (uc.user_id IS NOT NULL) AS cursor_present,
             CAST(uc.last_read_seq AS BIGINT) AS last_read_seq,
             uc.read_state_version AS read_state_version
      FROM rw_channels AS c
      JOIN rw_target_latest_v4 AS tl ON tl.target_id = c.id
      JOIN rw_target_eligible_v1 AS g ON g.target_id = c.id
      LEFT JOIN rw_channel_humans AS ch ON ch.channel_id = c.id AND ch.user_id = $1
      LEFT JOIN rw_user_channel_read_cursors_v2 AS uc ON uc.channel_id = c.id AND uc.user_id = $1
      WHERE c.server_id = $2
        AND c.type = 'channel'
        AND c.deleted_at IS NULL
        AND c.archived_at IS NULL
        AND ch.user_id IS NULL
        AND tl.latest_seq > COALESCE(CAST(uc.last_read_seq AS BIGINT), 0)`
    : "";
  const read = await queryRisingWaveInbox(pool, `
      SELECT server_id, target_id, kind, subscribed,
             unread_count, mention_unread, total_mentions, FALSE AS has_new,
             latest_seq, latest_message_id, cursor_present, last_read_seq, read_state_version
      FROM ${CONVERSATION_UNREAD_VIEW}
      WHERE receiver_type = 'user'
        AND receiver_id = $1
        AND server_id = $2
        AND (unread_count > 0 OR total_mentions > 0)${publicArm}`, [query.userId, query.serverId]);
  const rows = read.result.rows.map((row): ConversationUnreadRow => ({
    serverId: String(row.server_id),
    targetId: String(row.target_id),
    kind: row.kind as ConversationUnreadRow["kind"],
    subscribed: row.subscribed === true,
    unreadCount: Number(row.unread_count ?? 0),
    mentionUnread: Number(row.mention_unread ?? 0),
    totalMentions: Number(row.total_mentions ?? 0),
    hasNew: row.has_new === true,
    latestSeq: nullableText(row.latest_seq),
    latestMessageId: nullableText(row.latest_message_id),
    cursorPresent: row.cursor_present === true,
    lastReadSeq: nullableText(row.last_read_seq),
    readStateVersion: row.read_state_version === null || row.read_state_version === undefined
      ? null
      : Number(row.read_state_version),
  }));
  return { rows, rwAttrs: conversationUnreadRwTraceAttrs(read) };
}

async function readSidebarUnreadTotals(
  query: SidebarUnreadTotalsQuery,
): Promise<ConversationUnreadRead<Array<{ serverId: string; unreadCount: number }>>> {
  const override = getConversationUnreadSourceOverride();
  if (override) return { rows: await override.sidebarTotals(query), rwAttrs: {} };
  const pool = getRisingWaveInboxPool();
  if (!pool) throw new RisingWaveNotConfiguredError("sidebar unread totals");
  const read = await queryRisingWaveInbox(pool, `
      SELECT server_id, CAST(SUM(unread_count) AS BIGINT) AS unread_count
      FROM ${CONVERSATION_UNREAD_VIEW}
      WHERE receiver_type = 'user'
        AND receiver_id = $1
        AND server_id = ANY($2::varchar[])
        AND subscribed
        AND kind <> 'thread'
        AND unread_count > 0
      GROUP BY server_id`, [query.userId, query.serverIds]);
  const rows = read.result.rows.map((row) => ({
    serverId: String(row.server_id),
    unreadCount: Number(row.unread_count ?? 0),
  }));
  return { rows, rwAttrs: conversationUnreadRwTraceAttrs(read) };
}

async function loadConversationUnreadSummaryRows(
  serverId: string,
  userId: string,
  includePublicNew: boolean,
  traceQuery: DbQueryTracer,
): Promise<ConversationUnreadRow[]> {
  const queryName = includePublicNew ? "channels.unread_summary_by_user" : "channels.unread_counts_by_user";
  const read = await traceQuery(
    queryName,
    () => readConversationUnreadSummaryRows({ serverId, userId, includePublicNew }),
    (result) => ({
      ...inboxTraceAttrs("rw_mv", "channel_unread", "none", CONVERSATION_UNREAD_CONTRACT_VERSION),
      ...result.rwAttrs,
      rw_conversation_unread_view: CONVERSATION_UNREAD_VIEW,
      unread_channels_count: result.rows.filter((row) => row.unreadCount > 0).length,
      has_new_channels_count: result.rows.filter((row) => row.hasNew).length,
      rows_count: result.rows.length,
    }),
    (error) => risingWaveInboxFailureAttrs({
      route: "channel_unread",
      error,
      contractVersion: CONVERSATION_UNREAD_CONTRACT_VERSION,
      queryName,
    }),
  );
  recordInboxBackendSelected("rw_mv", "channel_unread", "none", CONVERSATION_UNREAD_CONTRACT_VERSION);
  return read.rows;
}

/**
 * Exact unread counts for the user's subscribed conversations of a server
 * (joined channels incl. muted/private/joint, DMs, followed threads), keyed by
 * LOCAL channel id; only counts > 0. Non-joined public channels are not counted.
 */
export async function getUnreadCounts(
  serverId: string,
  userId: string,
  opts?: UnreadCountOptions,
): Promise<Record<string, number>> {
  const traceQuery = opts?.traceQuery ?? untracedDbQuery;
  const rows = await loadConversationUnreadSummaryRows(serverId, userId, false, traceQuery);
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.subscribed && row.unreadCount > 0) counts[row.targetId] = row.unreadCount;
  }
  return counts;
}

function readStateRowFromConversationUnreadRow(row: ConversationUnreadRow): UnreadSummaryReadStateRow {
  return {
    channelId: row.targetId,
    readCursorPresent: row.cursorPresent,
    readStateVersion: row.readStateVersion,
    maxReadSeq: row.lastReadSeq,
    latestActivityMessageId: row.latestMessageId,
    latestActivitySeq: row.latestSeq,
  };
}

/**
 * The sidebar summary of one server: subscribed conversations with their exact
 * count and mention flags, mention-only rows (count 0 + flags), and non-joined
 * public channels with `hasNew` (count 0). Read state rides on the same row.
 */
export async function getUnreadSummary(
  serverId: string,
  userId: string,
  opts?: UnreadCountOptions,
): Promise<Record<string, ChannelUnreadSummaryEntry>> {
  const traceQuery = opts?.traceQuery ?? untracedDbQuery;
  const rows = await loadConversationUnreadSummaryRows(serverId, userId, true, traceQuery);

  const summary: Record<string, ChannelUnreadSummaryEntry> = {};
  const readStateRows = new Map<string, UnreadSummaryReadStateRow>();
  const absentReadState = makeInboxScopeReadFrontier(null);
  for (const row of rows) {
    const existing = summary[row.targetId];
    if (row.hasNew) {
      // A public channel the user has not joined; a mention-only row for the
      // same channel keeps its flags (and its fuller read-state row).
      summary[row.targetId] = existing
        ? { ...existing, hasNew: true }
        : { unreadCount: 0, hasMention: false, hasAnyMention: false, hasNew: true, readState: absentReadState };
      if (!readStateRows.has(row.targetId)) readStateRows.set(row.targetId, readStateRowFromConversationUnreadRow(row));
      continue;
    }
    summary[row.targetId] = {
      unreadCount: row.subscribed ? row.unreadCount : 0,
      hasMention: row.mentionUnread > 0,
      hasAnyMention: row.totalMentions > 0,
      ...(existing?.hasNew ? { hasNew: true } : {}),
      readState: absentReadState,
    };
    readStateRows.set(row.targetId, readStateRowFromConversationUnreadRow(row));
  }
  applyUnreadSummaryReadStates(
    summary,
    [...readStateRows.values()],
    (channelId, corruption) => {
      console.error(formatInboxScopeCorruptionLine(channelId, corruption));
    },
  );
  return summary;
}

export interface UnreadSummaryReadStateRow {
  channelId: string;
  /**
   * STRUCTURAL presence fact straight from the JOIN (`rc.user_id IS NOT
   * NULL`) — presence is never synthesized from whichever value columns
   * happen to be NULL (frozen exit gate).
   */
  readCursorPresent: boolean;
  readStateVersion: number | null;
  maxReadSeq: string | null;
  latestActivityMessageId: string | null;
  latestActivitySeq: string | null;
  /** Done guard domain; parent fallback is included for zero-reply threads. */
  doneFrontierSeq?: string | null;
}

/**
 * Exported for teeth: applies authority rows onto summary entries via the
 * single shared constructor. Presence is the structural JOIN fact; a present
 * row whose value columns are unexpectedly NULL flows into the constructor
 * as-is and classifies CORRUPT (never silently absent, never coalesced to
 * 0). Corruption reporting goes through onCorrupt per scope — one bad row
 * must not affect the rest.
 */
export function applyUnreadSummaryReadStates(
  summary: Record<string, ChannelUnreadSummaryEntry>,
  rows: UnreadSummaryReadStateRow[],
  onCorrupt: (channelId: string, corruption: Parameters<typeof formatInboxScopeCorruptionLine>[1]) => void,
): void {
  for (const row of rows) {
    const entry = summary[row.channelId];
    if (!entry) continue;
    const cursor = row.readCursorPresent
      ? {
        readStateVersion: row.readStateVersion as number,
        maxReadSeq: row.maxReadSeq as string,
        latestActivityMessageId: row.latestActivityMessageId,
        latestActivitySeq: row.latestActivitySeq,
      }
      : null;
    entry.readState = makeInboxScopeReadFrontier(cursor, (c) => onCorrupt(row.channelId, c));
  }
}

/**
 * Per-server count behind the pink "other servers have unread" badge: the SUM of
 * exact unread over the user's subscribed channels and DMs (muted included, as
 * before), from the same view as the sidebar summary. Excludes followed threads,
 * mention-only rows and non-joined public channels.
 */
export async function getSidebarUnreadSummaryCounts(
  serverIds: string[],
  userId: string,
  opts: SidebarUnreadSummaryOptions = {},
): Promise<Record<string, number>> {
  const uniqueServerIds = [...new Set(serverIds)];
  if (uniqueServerIds.length === 0) return {};
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const queryName = "servers.sidebar_unread_counts_by_user";
  const read = await traceQuery(
    queryName,
    () => readSidebarUnreadTotals({ serverIds: uniqueServerIds, userId }),
    (result) => ({
      ...inboxTraceAttrs("rw_mv", "sidebar_summary", "none", CONVERSATION_UNREAD_CONTRACT_VERSION),
      ...result.rwAttrs,
      rw_conversation_unread_view: CONVERSATION_UNREAD_VIEW,
      servers_count: uniqueServerIds.length,
      servers_with_unread_count: result.rows.filter((row) => row.unreadCount > 0).length,
    }),
    (error) => risingWaveInboxFailureAttrs({
      route: "sidebar_summary",
      error,
      contractVersion: CONVERSATION_UNREAD_CONTRACT_VERSION,
      queryName,
    }),
  );
  const counts: Record<string, number> = {};
  for (const serverId of uniqueServerIds) counts[serverId] = 0;
  for (const row of read.rows) {
    if (row.serverId in counts) counts[row.serverId] = row.unreadCount;
  }
  recordInboxBackendSelected("rw_mv", "sidebar_summary", "none", CONVERSATION_UNREAD_CONTRACT_VERSION);
  return counts;
}

// ── Agent legacy read / compatibility tracking ───────────

/**
 * Get the durable legacy read-ish seq for an agent/channel.
 *
 * This value is an agent usability checkpoint, not model-seen proof. New
 * daemon/runtime freshness gates must use explicit model-seen provenance
 * (`seenUpToSeq` today), while old daemon compatibility may still advance this
 * checkpoint from receive-ack to keep unread/summary bounded.
 */
export async function getAgentLegacyReadCursor(agentId: string, channelId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ lastReadSeq: agentChannelReadCursors.lastReadSeq })
    .from(agentChannelReadCursors)
    .where(and(
      eq(agentChannelReadCursors.agentId, agentId),
      eq(agentChannelReadCursors.channelId, channelId),
    ));
  return row?.lastReadSeq ?? 0;
}

/**
 * All durable legacy read-ish cursor rows for an agent (CL-CURSOR-SPLIT CS-4).
 *
 * Same caveats as `getAgentLegacyReadCursor`: this is an ack/usability
 * checkpoint horizon, never model-seen proof, and must not feed freshness
 * gates. CS-4 uses it as the per-channel rebuild watermark after the volatile
 * delivery buffer is lost (server restart/deploy): channels WITHOUT a cursor
 * row are deliberately not rebuilt (v1 boundary — no horizon to rebuild from).
 */
export async function getAgentLegacyReadCursors(
  agentId: string,
): Promise<Array<{ channelId: string; lastReadSeq: number }>> {
  const db = getDb();
  return db
    .select({
      channelId: agentChannelReadCursors.channelId,
      lastReadSeq: agentChannelReadCursors.lastReadSeq,
    })
    .from(agentChannelReadCursors)
    .where(eq(agentChannelReadCursors.agentId, agentId));
}

/**
 * Advance the durable legacy read-ish cursor for an agent/channel.
 *
 * Callers must not treat this as a model-seen boundary. It is either an
 * explicit history/read usability checkpoint or an old-daemon ack compatibility
 * horizon. Faithfulness-sensitive decisions must use explicit model-seen
 * provenance instead.
 */
/**
 * An agent's own send: advance its read cursor to the sent message only when
 * that reads through nothing it has not been handed. If the conversation holds
 * unread from others between the cursor and the new message (the inbox's own
 * unread rule: not the agent's sends, not system rows it caused, not noise
 * subtypes), the cursor stays where it is, and those messages are still
 * delivered. The agent's own message never counts as unread for it (the inbox
 * chain and the pull exclude it), so leaving the cursor below it is safe.
 * Check and write are one statement.
 *
 * `channelId` keys the cursor (the agent-facing, local conversation id);
 * `storageChannelId` is where the rows live. They differ for a joint channel
 * or joint thread, whose rows are stored under the canonical id: checking the
 * local id there would find nothing and read through every unread row.
 */
export async function markAgentOwnSendRead(agentId: string, channelId: string, seq: number, storageChannelId: string = channelId) {
  const db = getDb();
  const result = await db.execute(sql`
    WITH cursor_now AS (
      SELECT COALESCE(
        (SELECT COALESCE(last_read_seq8, CAST(last_read_seq AS BIGINT))
         FROM agent_channel_read_cursors
         WHERE agent_id = ${agentId} AND channel_id = ${channelId}),
        0
      ) AS seq
    )
    INSERT INTO agent_channel_read_cursors (agent_id, channel_id, last_read_seq, updated_at)
    SELECT ${agentId}, ${channelId}, ${seq}, now()
    WHERE NOT EXISTS (
      SELECT 1 FROM messages m, cursor_now
      WHERE m.channel_id = ${storageChannelId}
        AND m.seq > cursor_now.seq
        AND m.seq < ${seq}
        AND NOT (m.sender_type = 'agent' AND m.sender_id = ${agentId}::text)
        AND NOT COALESCE(m.message_type = 'system' AND m.causal_actor_type = 'agent' AND m.causal_actor_id = ${agentId}::text, FALSE)
        AND (m.system_subtype IS NULL OR m.system_subtype NOT IN ('channel.self_unfollow_thread', 'task.deleted_summary'))
    )
    ON CONFLICT (agent_id, channel_id) DO UPDATE SET
      last_read_seq = EXCLUDED.last_read_seq,
      updated_at = now()
    WHERE agent_channel_read_cursors.last_read_seq < EXCLUDED.last_read_seq
    RETURNING
      channel_id::text AS "channelId",
      last_read_seq::int AS "maxReadSeq"
  `);
  const [advanced] = result.rows as Array<{ channelId: string; maxReadSeq: number }>;
  if (advanced) return { ...advanced, changed: true };
  return { channelId, maxReadSeq: await getAgentLegacyReadCursor(agentId, channelId), changed: false };
}

export async function markAgentLegacyRead(agentId: string, channelId: string, seq: number) {
  const db = getDb();
  const result = await db.execute(sql`
    INSERT INTO agent_channel_read_cursors (agent_id, channel_id, last_read_seq, updated_at)
    VALUES (${agentId}, ${channelId}, ${seq}, now())
    ON CONFLICT (agent_id, channel_id) DO UPDATE SET
      last_read_seq = EXCLUDED.last_read_seq,
      updated_at = now()
    WHERE agent_channel_read_cursors.last_read_seq < EXCLUDED.last_read_seq
    RETURNING
      channel_id::text AS "channelId",
      last_read_seq::int AS "maxReadSeq"
  `);
  const [advanced] = result.rows as Array<{ channelId: string; maxReadSeq: number }>;
  if (advanced) return { ...advanced, changed: true };

  await db
    .update(agentChannelReadCursors)
    .set({ updatedAt: currentDate() })
    .where(and(
      eq(agentChannelReadCursors.agentId, agentId),
      eq(agentChannelReadCursors.channelId, channelId),
    ));
  const [existing] = await db
    .select({ maxReadSeq: agentChannelReadCursors.lastReadSeq })
    .from(agentChannelReadCursors)
    .where(and(
      eq(agentChannelReadCursors.agentId, agentId),
      eq(agentChannelReadCursors.channelId, channelId),
    ))
    .limit(1);
  return { channelId, maxReadSeq: existing?.maxReadSeq ?? 0, changed: false };
}

/**
 * Old-daemon compatibility: advance the existing agent read cursor from acked
 * message seqs so legacy daemons connected to a newer server do not accumulate
 * unbounded unread/pending-summary state.
 *
 * This is deliberately separate from AgentOrchestrator delivery ack. Delivery
 * ack/drain remains volatile replay state; this DB write is an ack-checkpoint
 * compatibility horizon, not model-seen proof. Freshness gates must continue
 * to ignore this cursor and read explicit model-seen provenance only.
 */
export async function markAgentLegacyAckCheckpoint(agentId: string, seqs: number[]): Promise<void> {
  const normalizedSeqs = [...new Set(seqs
    .map((seq) => Math.floor(Number(seq)))
    .filter((seq) => Number.isInteger(seq) && seq > 0))];
  if (normalizedSeqs.length === 0) return;

  // The cursor belongs to the conversation the agent was delivered: a message stored
  // under a joint channel's canonical channel (or thread) is acked on the agent's
  // server's local projection of it, the id live delivery and recovery hand the
  // agent. Only conversations the agent belongs to are written: a member of the
  // channel (for a thread, of its parent channel), or a follower of the thread.
  const result = await getDb().execute(sql`
    WITH acked AS (
      SELECT ${messages.channelId} AS storage_id, max(${messages.seq})::int AS max_seq
      FROM ${messages}
      WHERE ${inArray(messages.seq, normalizedSeqs)}
      GROUP BY ${messages.channelId}
    ), targets AS (
      SELECT COALESCE(${jointChannelServers.localChannelId}, acked.storage_id) AS target_id, acked.max_seq
      FROM acked
      INNER JOIN ${agents} ON ${agents.id} = ${agentId}
      LEFT JOIN ${jointChannels}
        ON ${jointChannels.canonicalChannelId} = acked.storage_id AND ${jointChannels.status} = 'active'
      LEFT JOIN ${jointChannelServers}
        ON ${jointChannelServers.jointChannelId} = ${jointChannels.id}
        AND ${jointChannelServers.serverId} = ${agents.serverId}
        AND ${jointChannelServers.status} = 'active'
    )
    SELECT targets.target_id AS "channelId", targets.max_seq AS "maxSeq"
    FROM targets
    INNER JOIN ${channels} ON ${channels.id} = targets.target_id
    LEFT JOIN ${messages} AS parent ON parent.id = ${channels.parentMessageId}
    WHERE EXISTS (
        SELECT 1 FROM ${channelAgents}
        WHERE ${channelAgents.channelId} = COALESCE(parent.channel_id, targets.target_id)
          AND ${channelAgents.agentId} = ${agentId}
      )
      OR EXISTS (
        SELECT 1 FROM ${threadFollows}
        WHERE ${threadFollows.threadChannelId} = targets.target_id
          AND ${threadFollows.followerType} = 'agent'
          AND ${threadFollows.followerId} = ${agentId}
          AND ${threadFollows.unfollowedAt} IS NULL
      )
  `);
  const rows = (result.rows as Array<{ channelId: string; maxSeq: number | string }>)
    .map((row) => ({ channelId: String(row.channelId), maxSeq: Number(row.maxSeq) }));

  await Promise.all(rows.map((row) => markAgentLegacyRead(agentId, row.channelId, row.maxSeq)));
}

export type AgentFollowedThreadListItem = {
  target: string;
  threadChannelId: string;
  parentChannelRef: string;
  parentMessageId: string;
  parentMessageShortId: string;
  followedAt: string;
  reason: string;
  doneAt: string | null;
};

export async function listAgentFollowedThreads(
  serverId: string,
  agentId: string,
): Promise<AgentFollowedThreadListItem[]> {
  const db = getDb();
  const parentMessages = alias(messages, "agent_followed_thread_parent_messages");
  const parentChannels = alias(channels, "agent_followed_thread_parent_channels");

  const rows = await db
    .select({
      threadChannelId: channels.id,
      parentChannelId: parentChannels.id,
      parentMessageId: threadFollows.parentMessageId,
      followedAt: threadFollows.createdAt,
      reason: threadFollows.reason,
      doneAt: threadFollows.doneAt,
    })
    .from(threadFollows)
    .innerJoin(channels, and(
      eq(channels.id, threadFollows.threadChannelId),
      eq(channels.type, "thread"),
      eq(channels.serverId, serverId),
      isNull(channels.deletedAt),
    ))
    .innerJoin(parentMessages, eq(parentMessages.id, threadFollows.parentMessageId))
    .innerJoin(parentChannels, and(
      eq(parentChannels.id, parentMessages.channelId),
      eq(parentChannels.serverId, serverId),
      isNull(parentChannels.deletedAt),
    ))
    .where(and(
      eq(threadFollows.followerType, "agent"),
      eq(threadFollows.followerId, agentId),
      isNull(threadFollows.unfollowedAt),
    ))
    .orderBy(desc(threadFollows.createdAt), desc(threadFollows.threadChannelId));

  const items: AgentFollowedThreadListItem[] = [];
  for (const row of rows) {
    if (!await canAgentAccessChannel(row.threadChannelId, agentId)) continue;
    const parentChannelRef = await resolveAgentFacingChannelRef(serverId, agentId, row.parentChannelId);
    if (!parentChannelRef) continue;
    const parentMessageShortId = row.parentMessageId.slice(0, 8);
    items.push({
      target: `${parentChannelRef}:${parentMessageShortId}`,
      threadChannelId: row.threadChannelId,
      parentChannelRef,
      parentMessageId: row.parentMessageId,
      parentMessageShortId,
      followedAt: row.followedAt.toISOString(),
      reason: row.reason,
      doneAt: row.doneAt ? row.doneAt.toISOString() : null,
    });
  }
  return items;
}

/**
 * One (agent, target) row of the agent inbox view (UNIFIED_CHAIN_VIEWS.agentInbox,
 * rw_agent_inbox_v5 in infra/risingwave/sql/068-chain-mention-v6-consumers.sql). The view owns
 * every offer rule: it holds ONLY the conversations the agent is offered (joined
 * through a membership or an active follow; admitted-stream unread, or a mention
 * unread beyond the admitted stream -- a mention after a mute pierces it),
 * and thread rows only when the agent can receive the thread (parent access, thread
 * and parent not deleted). The app reads these rows; it does not re-filter them.
 * `target_id` is the agent-facing channel (a joint channel's LOCAL projection);
 * `storage_channel_id` is where its messages live.
 */
export interface AgentInboxChainRow {
  targetId: string;
  storageChannelId: string;
  kind: "channel" | "dm" | "thread";
  serverId: string;
  channelName: string;
  channelType: typeof channels.$inferSelect["type"];
  /** A thread's parent message; for a joint thread's local projection, the canonical parent. */
  parentMessageId: string | null;
  /** The LOCAL parent channel (rw_thread_parent_v3). */
  parentChannelId: string | null;
  parentChannelName: string | null;
  parentChannelType: string | null;
  lastReadSeq: number;
  unreadCount: number;
  firstUnreadSeq: number | null;
  latestSeq: number | null;
  mentionUnread: number;
  maxMentionSeq: number | null;
  /** False when the row exists only through the mention arm (e.g. a muted channel). */
  subscribed: boolean;
  /** The unread the agent is offered: subscribed ? unread_count : mention_unread. */
  offeredUnread: number;
  /** GREATEST(latest_seq, max_mention_seq): the newest activity, the inbox page key. */
  activitySeq: number;
  /** channel_agents.added_at, or the active thread follow's created_at. */
  joinedAt: Date;
}

export type AgentInboxChainSelection =
  | { source: "chain"; rows: AgentInboxChainRow[] }
  | { source: "unavailable"; reason: "rw_unconfigured" | "rw_error" };

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Read, once per resume, the agent's rows from the unified chain -- the only
 * source of agent recovery. Both consumers (unread summary and catch-up
 * candidates) take the SAME rows. When the chain is unconfigured or its read
 * fails the selection is `unavailable` and the caller skips recovery; there is
 * no second source to fall back to.
 */
export async function selectAgentInboxChainRows(agentId: string): Promise<AgentInboxChainSelection> {
  const pool = getRisingWaveInboxPool();
  if (!pool && !usesPostgresReadBackend()) return { source: "unavailable", reason: "rw_unconfigured" };
  try {
    return { source: "chain", rows: await readAgentInboxChainRows(pool, agentId) };
  } catch (error) {
    console.error(`[ChannelService] agent inbox chain read failed for agent ${agentId}; skipping resume recovery:`, error);
    return { source: "unavailable", reason: "rw_error" };
  }
}

/**
 * Narrows a chain read. With `limit`, the rows come newest activity first
 * (`ORDER BY activity_seq DESC LIMIT`), one range scan of the view's
 * (agent_id, activity_seq DESC) index.
 */
export type AgentInboxChainReadOptions = {
  kind?: AgentInboxChainRow["kind"];
  beforeSeq?: number;
  mentionsOnly?: boolean;
  limit?: number;
};

/** Read one agent's rows from the agent inbox view. Throws on query failure. */
export async function readAgentInboxChainRows(
  pool: ReturnType<typeof getRisingWavePool>,
  agentId: string,
  opts: AgentInboxChainReadOptions = {},
): Promise<AgentInboxChainRow[]> {
  if (usesPostgresReadBackend()) {
    let rows = await referenceAgentInboxChain(agentId);
    if (opts.kind !== undefined) rows = rows.filter(row => row.kind === opts.kind);
    if (opts.beforeSeq !== undefined) rows = rows.filter(row => row.activitySeq < opts.beforeSeq!);
    if (opts.mentionsOnly) rows = rows.filter(row => row.mentionUnread > 0);
    if (opts.limit !== undefined) {
      const limit = Math.trunc(opts.limit);
      if (!Number.isSafeInteger(limit) || limit < 0) throw new Error(`invalid agent inbox page limit: ${opts.limit}`);
      rows = rows.sort((a, b) => b.activitySeq - a.activitySeq).slice(0, limit);
    }
    return rows;
  }
  if (!pool) throw new RisingWaveNotConfiguredError("agent inbox");
  const values: unknown[] = [agentId];
  const where = ["agent_id = $1"];
  if (opts.kind !== undefined) {
    values.push(opts.kind);
    where.push(`kind = $${values.length}`);
  }
  if (opts.beforeSeq !== undefined) {
    values.push(opts.beforeSeq);
    where.push(`activity_seq < $${values.length}`);
  }
  if (opts.mentionsOnly) where.push("mention_unread > 0");
  let page = "";
  if (opts.limit !== undefined) {
    // RisingWave only accepts a constant after LIMIT (a bind parameter fails to
    // prepare: "expects an integer ... after LIMIT, but found non-const
    // expression"), so the validated integer is inlined.
    const limit = Math.trunc(opts.limit);
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error(`invalid agent inbox page limit: ${opts.limit}`);
    page = `
    ORDER BY activity_seq DESC
    LIMIT ${limit}`;
  }
  const read = await queryRisingWaveInbox(pool, `SELECT
      target_id, storage_channel_id, kind, server_id, channel_name, channel_type, parent_message_id,
      parent_channel_id, parent_channel_name, parent_channel_type, last_read_seq, unread_count,
      first_unread_seq, latest_seq, mention_unread, max_mention_seq, subscribed, offered_unread,
      activity_seq, joined_at
    FROM ${UNIFIED_CHAIN_VIEWS.agentInbox}
    WHERE ${where.join(" AND ")}${page}`, values);
  return read.result.rows.map((row) => ({
    targetId: String(row.target_id),
    storageChannelId: String(row.storage_channel_id),
    kind: row.kind as AgentInboxChainRow["kind"],
    serverId: String(row.server_id),
    channelName: String(row.channel_name),
    channelType: row.channel_type as AgentInboxChainRow["channelType"],
    parentMessageId: row.parent_message_id == null ? null : String(row.parent_message_id),
    parentChannelId: row.parent_channel_id == null ? null : String(row.parent_channel_id),
    parentChannelName: row.parent_channel_name == null ? null : String(row.parent_channel_name),
    parentChannelType: row.parent_channel_type == null ? null : String(row.parent_channel_type),
    lastReadSeq: Number(row.last_read_seq),
    unreadCount: Number(row.unread_count),
    firstUnreadSeq: toNullableNumber(row.first_unread_seq),
    latestSeq: toNullableNumber(row.latest_seq),
    mentionUnread: Number(row.mention_unread),
    maxMentionSeq: toNullableNumber(row.max_mention_seq),
    subscribed: row.subscribed === true,
    offeredUnread: Number(row.offered_unread),
    activitySeq: Number(row.activity_seq),
    joinedAt: new Date(row.joined_at as string | Date),
  }));
}

export type AgentInboxTotals = { conversations: number; dms: number; mentions: number };

/** The agent's inbox totals, counted in the view. Throws on query failure. */
export async function readAgentInboxChainTotals(
  pool: ReturnType<typeof getRisingWavePool>,
  agentId: string,
): Promise<AgentInboxTotals> {
  if (usesPostgresReadBackend()) {
    const rows = await referenceAgentInboxChain(agentId);
    return {
      conversations: rows.length,
      dms: rows.filter(row => row.kind === "dm").length,
      mentions: rows.filter(row => row.mentionUnread > 0).length,
    };
  }
  if (!pool) throw new RisingWaveNotConfiguredError("agent inbox totals");
  const read = await queryRisingWaveInbox(pool, `SELECT
      count(*) AS conversations,
      count(*) FILTER (WHERE kind = 'dm') AS dms,
      count(*) FILTER (WHERE mention_unread > 0) AS mentions
    FROM ${UNIFIED_CHAIN_VIEWS.agentInbox}
    WHERE agent_id = $1`, [agentId]);
  const row = read.result.rows[0] ?? {};
  return {
    conversations: Number(row.conversations ?? 0),
    dms: Number(row.dms ?? 0),
    mentions: Number(row.mentions ?? 0),
  };
}

const AGENT_UNREAD_SUMMARY_MAX_TARGETS = 20;

/**
 * The resume prompt lists unread targets one line each; an agent following
 * thousands of threads (prod max 13,906) would get a prompt of thousands of lines.
 * Keep DMs (and DM threads) first, then the targets with the most unread, and
 * fold the rest into one line that says how many were left out. The daemon
 * renders every entry as "- <label>: <n> unread", so the folded line reads
 * naturally without a daemon change.
 */
export function capAgentUnreadSummary(
  counts: Record<string, number>,
  max = AGENT_UNREAD_SUMMARY_MAX_TARGETS,
): Record<string, number> {
  const entries = Object.entries(counts);
  if (entries.length <= max) return counts;
  entries.sort(([a, na], [b, nb]) => {
    const dmA = a.startsWith("dm:") ? 0 : 1;
    const dmB = b.startsWith("dm:") ? 0 : 1;
    return dmA - dmB || nb - na || a.localeCompare(b);
  });
  const kept = entries.slice(0, max);
  const rest = entries.slice(max);
  const folded = rest.reduce((sum, [, n]) => sum + n, 0);
  return {
    ...Object.fromEntries(kept),
    [`(${rest.length} more conversations — run \`raft inbox check\` to list them)`]: folded,
  };
}

/**
 * The agent-facing `dm:@peer` ref of every DM the rows name (DM rows, and the
 * parent DM of DM threads). A DM with no addressable peer (e.g. the single-member
 * migration receipt DM) has no entry.
 */
export async function resolveAgentInboxDmRefs(
  agentId: string,
  rows: readonly AgentInboxChainRow[],
): Promise<Map<string, string>> {
  const byServer = new Map<string, Set<string>>();
  for (const row of rows) {
    const channelId = row.kind === "dm"
      ? row.targetId
      : row.kind === "thread" && row.parentChannelType === "dm" ? row.parentChannelId : null;
    if (!channelId) continue;
    const ids = byServer.get(row.serverId) ?? new Set<string>();
    ids.add(channelId);
    byServer.set(row.serverId, ids);
  }
  const refs = new Map<string, string>();
  for (const [serverId, ids] of byServer) {
    for (const [channelId, ref] of await resolveAgentFacingDmRefs(serverId, agentId, [...ids])) refs.set(channelId, ref);
  }
  return refs;
}

/**
 * The batched form of resolveAgentFacingChannelRef for DM channels: `dm:@peer`
 * for each DM the agent belongs to, by the same rules (DM identity row first;
 * legacy DMs by their other human, then other agent member; built-in app
 * conversations by their app id). One query per 500 channels instead of several
 * per channel — an agent can have hundreds of unread DM threads.
 */
export async function resolveAgentFacingDmRefs(
  serverId: string,
  agentId: string,
  dmChannelIds: readonly string[],
): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  const ids = [...new Set(dmChannelIds)];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const result = await getDb().execute(sql`
      SELECT c.id::text AS channel_id, c.name AS channel_name,
        i.kind AS identity_kind, i.peer_key AS peer_key,
        (SELECT u.name FROM ${users} AS u
          WHERE i.kind = 'human_agent' AND u.id::text = (
            SELECT p FROM unnest(string_to_array(i.peer_key, ':')) AS p WHERE p <> ${agentId} LIMIT 1)) AS identity_human,
        (SELECT a.name FROM ${agents} AS a
          WHERE i.kind = 'agent_agent' AND a.server_id = c.server_id AND a.id::text = (
            SELECT p FROM unnest(string_to_array(i.peer_key, ':')) AS p WHERE p <> ${agentId} LIMIT 1)) AS identity_agent,
        (SELECT u.name FROM ${channelHumans} AS h INNER JOIN ${users} AS u ON u.id = h.user_id
          WHERE h.channel_id = c.id LIMIT 1) AS legacy_human,
        (SELECT a.name FROM ${channelAgents} AS ca INNER JOIN ${agents} AS a ON a.id = ca.agent_id
          WHERE ca.channel_id = c.id AND ca.agent_id <> ${agentId} LIMIT 1) AS legacy_agent,
        (SELECT s.kind FROM ${agentPrivateSurfaces} AS s
          WHERE s.channel_id = c.id AND s.agent_id = ${agentId} LIMIT 1) AS private_surface_kind
      FROM ${channels} AS c
      INNER JOIN ${channelAgents} AS me ON me.channel_id = c.id AND me.agent_id = ${agentId}
      LEFT JOIN ${dmChannelIdentities} AS i ON i.channel_id = c.id AND i.server_id = c.server_id
      WHERE c.id IN (${sql.join(chunk.map((id) => sql`${id}::uuid`), sql`, `)})
        AND c.type = 'dm' AND c.server_id = ${serverId}
    `);
    const peers: Array<{ channelId: string; name: string; kind: DmPeerKind | null }> = [];
    for (const row of result.rows as Array<Record<string, string | null>>) {
      let peer: { name: string; kind: DmPeerKind | null } | null = null;
      if (row.private_surface_kind === "reminders") {
        peer = { name: AGENT_REMINDERS_DM_PEER, kind: null };
      } else if (row.identity_kind) {
        // Mirrors resolveAgentFacingChannelRef: an identity row is authoritative;
        // the agent must be one of its participants.
        const participants = String(row.peer_key ?? "").split(":");
        if (participants.includes(agentId)) {
          if (row.identity_kind === "human_agent" && row.identity_human) peer = { name: row.identity_human, kind: "human" };
          if (row.identity_kind === "agent_agent" && row.identity_agent) peer = { name: row.identity_agent, kind: "agent" };
        }
      } else if (row.legacy_human) {
        peer = { name: row.legacy_human, kind: "human" };
      } else if (row.legacy_agent) {
        peer = { name: row.legacy_agent, kind: "agent" };
      } else if (isAppId(String(row.channel_name))) {
        peer = { name: String(row.channel_name), kind: null };
      }
      if (peer) peers.push({ channelId: String(row.channel_id), ...peer });
    }
    const twins = await findCrossKindTwinPeerNames(serverId, peers.filter((p) => p.kind).map((p) => p.name));
    for (const peer of peers) {
      refs.set(peer.channelId, `dm:@${formatDmPeerRef(peer.name, twins.has(peer.name) ? peer.kind : null)}`);
    }
  }
  return refs;
}

/**
 * The bare peer face of one DM, as the agent-facing payload prints it: `name`
 * or `name~kind` (the `dm:@...` target with the prefix stripped). Reuses the
 * batched resolveAgentFacingDmRefs — identity-row-first resolution plus the
 * twin suffix — so the rendered label always matches the target DSL exactly.
 */
export async function resolveAgentFacingDmPeerFace(
  serverId: string,
  agentId: string,
  channelId: string,
): Promise<string | null> {
  const refs = await resolveAgentFacingDmRefs(serverId, agentId, [channelId]);
  const ref = refs.get(channelId);
  if (!ref) return null;
  return ref.slice("dm:@".length);
}

/**
 * THE target of an agent inbox row, in the delivery target DSL (what
 * `raft message send/read --target` takes and live delivery prints):
 * `#chan`, `#chan:<parent short id>`, `dm:@peer`, `dm:@peer:<parent short id>`.
 * The resume summary and `raft inbox check` both label rows with it.
 */
export function formatAgentInboxTarget(row: AgentInboxChainRow, dmRefs: ReadonlyMap<string, string>): string {
  if (row.kind === "dm") return dmRefs.get(row.targetId) ?? `dm:@${row.channelName}`;
  if (row.kind === "thread" && row.parentMessageId && row.parentChannelName) {
    const shortId = row.parentMessageId.slice(0, 8);
    if (row.parentChannelType === "dm") {
      const parentRef = (row.parentChannelId ? dmRefs.get(row.parentChannelId) : undefined) ?? `dm:@${row.parentChannelName}`;
      return `${parentRef}:${shortId}`;
    }
    return `#${row.parentChannelName}:${shortId}`;
  }
  return `#${row.channelName}`;
}

/**
 * Unread counts for the conversations an agent will be offered on resume, from
 * the unified chain's rows (read once for this resume by
 * selectAgentInboxChainRows). Returns target -> offered unread. The chain gates
 * the free-plan history window per target (rw_target_eligible_v1), not per message.
 */
export async function getAgentUnreadCounts(
  agentId: string,
  chain: AgentInboxChainRow[],
): Promise<Record<string, number>> {
  const dmRefs = await resolveAgentInboxDmRefs(agentId, chain);
  const counts: Record<string, number> = {};
  for (const row of chain) {
    if (row.offeredUnread <= 0) continue;
    const target = formatAgentInboxTarget(row, dmRefs);
    counts[target] = (counts[target] ?? 0) + row.offeredUnread;
  }
  return counts;
}

/**
 * `raft inbox check` cannot answer: the durable unread source (the unified
 * chain in RisingWave) is unconfigured or its read failed. The route turns this
 * into 503 INBOX_UNAVAILABLE -- never a silently partial list.
 */
export class AgentInboxUnavailableError extends Error {
  readonly code = "INBOX_UNAVAILABLE" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentInboxUnavailableError";
  }
}

export type AgentInboxView = "unread" | "mentions";

export type AgentInboxConversation = {
  target: string;
  kind: AgentInboxChainRow["kind"];
  unread: number;
  mentions: number;
  lastReadSeq: number;
  activitySeq: number;
  latestSenderName: string | null;
  latestAt: string | null;
};

export type AgentInboxList = {
  view: AgentInboxView;
  items: AgentInboxConversation[];
  hasMore: boolean;
  nextBeforeSeq: number | null;
  totals: AgentInboxTotals;
};

/**
 * The agent's Activity panel: the conversations the view offers, newest activity
 * first, keyset-paged by activity seq in the view. A message belongs to exactly
 * one conversation and seq is global, so activity seqs are unique across rows and
 * `activity_seq < beforeSeq` pages exactly. Only the page (and the agent's DM
 * rows, to drop DMs no target can open) is read, never the whole inbox.
 */
export async function listAgentInbox(
  agentId: string,
  serverId: string,
  opts: { view: AgentInboxView; beforeSeq?: number; limit: number },
): Promise<AgentInboxList> {
  const pool = getRisingWaveInboxPool();
  if (!pool && !usesPostgresReadBackend()) throw new AgentInboxUnavailableError("Agent inbox source is not configured");
  let totals: AgentInboxTotals;
  let dmRows: AgentInboxChainRow[];
  try {
    [totals, dmRows] = await Promise.all([
      readAgentInboxChainTotals(pool, agentId),
      readAgentInboxChainRows(pool, agentId, { kind: "dm" }),
    ]);
  } catch (error) {
    throw new AgentInboxUnavailableError("Agent inbox source read failed", { cause: error });
  }

  // A DM with no addressable peer (e.g. the single-member migration receipt DM)
  // cannot be opened with any target, so it would sit in the list forever: it is
  // neither listed nor counted.
  const dmRefs = await resolveAgentInboxDmRefs(agentId, dmRows);
  const unaddressable = dmRows.filter((row) => !dmRefs.has(row.targetId));
  const hidden = new Set(unaddressable.map((row) => row.targetId));
  totals = {
    conversations: totals.conversations - unaddressable.length,
    dms: totals.dms - unaddressable.length,
    mentions: totals.mentions - unaddressable.filter((row) => row.mentionUnread > 0).length,
  };

  let rows: AgentInboxChainRow[];
  try {
    rows = await readAgentInboxChainRows(pool, agentId, {
      beforeSeq: opts.beforeSeq,
      mentionsOnly: opts.view === "mentions",
      // One past the page says whether there is more; the hidden DMs may take slots.
      limit: opts.limit + 1 + hidden.size,
    });
  } catch (error) {
    throw new AgentInboxUnavailableError("Agent inbox source read failed", { cause: error });
  }
  const candidates = rows.filter((row) => !hidden.has(row.targetId));
  const page = candidates.slice(0, opts.limit);
  const hasMore = candidates.length > page.length;

  for (const [channelId, ref] of await resolveAgentInboxDmRefs(agentId, page.filter((row) => row.kind === "thread"))) {
    dmRefs.set(channelId, ref);
  }
  const latestBySeq = await getAgentInboxLatestMessages(page.map((row) => row.activitySeq).filter((seq) => seq > 0));
  const items: AgentInboxConversation[] = page.map((row) => {
    const latest = latestBySeq.get(row.activitySeq);
    return {
      target: formatAgentInboxTarget(row, dmRefs),
      kind: row.kind,
      unread: row.offeredUnread,
      mentions: row.mentionUnread,
      lastReadSeq: row.lastReadSeq,
      activitySeq: row.activitySeq,
      latestSenderName: latest?.senderName ?? null,
      latestAt: latest?.createdAt ?? null,
    };
  });
  const last = page.at(-1);
  return {
    view: opts.view,
    items,
    hasMore,
    nextBeforeSeq: hasMore && last ? last.activitySeq : null,
    totals,
  };
}

/** Sender name and time of the given messages (seq is global), for one inbox page. */
async function getAgentInboxLatestMessages(
  seqs: number[],
): Promise<Map<number, { senderName: string | null; createdAt: string }>> {
  const out = new Map<number, { senderName: string | null; createdAt: string }>();
  if (seqs.length === 0) return out;
  const rows = await getDb()
    .select({
      seq: messages.seq,
      createdAt: messages.createdAt,
      messageType: messages.messageType,
      senderType: messages.senderType,
      userName: users.name,
      agentName: agents.name,
    })
    .from(messages)
    .leftJoin(users, and(eq(messages.senderType, "user"), sql`${users.id}::text = ${messages.senderId}`))
    .leftJoin(agents, and(eq(messages.senderType, "agent"), sql`${agents.id}::text = ${messages.senderId}`))
    .where(inArray(messages.seq, seqs));
  for (const row of rows) {
    const senderName = row.messageType === "system"
      ? null
      : row.senderType === "user"
        ? row.userName
        : row.senderType === "agent"
          ? row.agentName
          : null;
    out.set(Number(row.seq), {
      senderName: senderName ?? null,
      createdAt: (row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt)).toISOString(),
    });
  }
  return out;
}
