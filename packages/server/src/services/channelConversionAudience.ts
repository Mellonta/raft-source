import { currentDate } from "@botiverse/raft-shared";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { type AnyPgTable } from "drizzle-orm/pg-core";
import { createHash } from "node:crypto";
import type { Server as SocketServer } from "socket.io";
import { getDb, type DatabaseExecutor } from "../db/index";
import {
  activitySyncChanges,
  activitySyncRows,
  activitySyncScopes,
  agentChannelReadCursors,
  channelAgents,
  channelConversionJobs,
  channelHumans,
  channels,
  inboxNotificationFacts,
  inboxSuppressionStates,
  inboxTargetMuteStates,
  mobilePushOutbox,
  serverMembers,
  threadFollows,
  userChannelDisplayPrefs,
  userChannelInboxStates,
  userChannelReadCursors
} from "../db/schema";
import {
  requireActionCardReconfirmationAfterCutover
} from "./actionCardConversionService";
import {
  conversionScopeIds,
  parseConversionProgress,
  type ConversionAudienceResult,
  type ConversionCleanupCounter,
  type ConversionCleanupLedger
} from "./channelConversionContracts";
import {
  recordConversionPhaseCommit,
  releaseChannelConversionFence,
  withChannelConversionResourceLock
} from "./channelConversionFenceService";
import { advance, conversionTraceAttrs, persistResourceBatchProgress, requireCanonicalChannelId, stableStringify, type ChannelConversionJob } from "./channelConversionPhaseContext";
import { CHANNEL_CONVERSION_BATCH_SIZE, conversionThreadMapping } from "./channelConversionResources";
import { clearSuppressionForReceivers } from "./inboxSuppressionWriters";

import type { ConversionPhaseContext } from "./channelConversionPhaseContext";
type AudienceCleanupMutation =
  | "legacy_public_acl_leak"
  | "follow_resurrection"
  | "pin_sidebar_residue"
  | "unread_inbox_activity_residue"
  | "pending_push_socket_leak"
  | "rejoin_restores_old_state"
  | "activity_change_only_principal_discovery"
  | "cleanup_non_idempotent";

let audienceCleanupMutationForTest: AudienceCleanupMutation | null = null;

export function setAudienceCleanupMutationForTest(mutation: AudienceCleanupMutation | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("audience cleanup hooks are test-only");
  audienceCleanupMutationForTest = mutation;
}


export type ChannelConversionAudienceCutover = {
  serverId: string;
  sourceChannelId: string;
  conversionEpoch: string;
  scopeChannelIds: string[];
  lostUserIds: string[];
  lostAgentIds: string[];
};

function audienceCutoverFromJob(job: ChannelConversionJob): ChannelConversionAudienceCutover {
  const progress = parseConversionProgress(job.progress);
  const audience = progress.audienceCutover;
  const threadIds = Array.isArray(audience?.threadIds)
    ? audience?.threadIds.filter((id): id is string => typeof id === "string")
    : [];
  return {
    serverId: job.serverId,
    sourceChannelId: job.sourceChannelId,
    conversionEpoch: job.conversionEpoch,
    scopeChannelIds: [...conversionScopeIds({ serverId: job.serverId, sourceChannelId: job.sourceChannelId, canonicalChannelId: job.canonicalChannelId }), ...threadIds],
    lostUserIds: Array.isArray(audience?.lostUserIds)
      ? audience?.lostUserIds.filter((id): id is string => typeof id === "string")
      : [],
    lostAgentIds: Array.isArray(audience?.lostAgentIds)
      ? audience?.lostAgentIds.filter((id): id is string => typeof id === "string")
      : [],
  };
}

export async function getChannelConversionAudienceCutover(jobId: string): Promise<ChannelConversionAudienceCutover | null> {
  const [job] = await getDb().select().from(channelConversionJobs).where(eq(channelConversionJobs.id, jobId));
  if (!job || !parseConversionProgress(job.progress).audienceCutoverAt) return null;
  return audienceCutoverFromJob(job);
}

/** Remove lost principals from every request-facing room before the route
 * emits its post-cutover channel update. Persisted ACL checks protect future
 * reconnects; this closes the already-connected socket window.
 */
export function applyChannelConversionAudienceRealtimeCutover(
  io: Pick<SocketServer, "in"> | undefined,
  cutover: ChannelConversionAudienceCutover | null,
): void {
  if (!io || !cutover || audienceCleanupMutationForTest === "pending_push_socket_leak") return;
  for (const userId of cutover.lostUserIds) {
    for (const channelId of cutover.scopeChannelIds) {
      // A user room is globally identity-scoped. Adding `server:*` here would
      // be a Socket.IO room UNION, not an intersection, and could evict every
      // socket in the server. Restrict the operator to the lost principal.
      io.in(`user:${userId}`).socketsLeave(`channel:${channelId}`);
    }
  }
  for (const agentId of cutover.lostAgentIds) {
    for (const channelId of cutover.scopeChannelIds) {
      io.in(`agent:${agentId}`).socketsLeave(`channel:${channelId}`);
    }
  }
}

async function conversionScopeChannelIds(
  tx: DatabaseExecutor,
  job: ChannelConversionJob,
  canonicalChannelId: string,
): Promise<string[]> {
  const result = await tx.execute(sql`
    WITH threads AS (${conversionThreadMapping(job.serverId, canonicalChannelId)})
    SELECT id::text FROM (
      SELECT ${job.sourceChannelId}::uuid AS id UNION SELECT ${canonicalChannelId}::uuid
      UNION SELECT local_id FROM threads UNION SELECT canonical_id FROM threads
    ) scope ORDER BY id
  `);
  return (result.rows as Array<{ id?: unknown }>).flatMap((row) => typeof row.id === "string" ? [row.id] : []);
}

function audienceChecksum(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export async function audienceCutover(
  { tx, job, progress, span }: ConversionPhaseContext,
  options: { applyMutations?: boolean; advanceJob?: boolean } = {},
): Promise<ConversionAudienceResult> {
  const applyMutations = options.applyMutations !== false;
  const canonicalChannelId = await requireCanonicalChannelId(tx, job);
  const [source] = await tx.select({ type: channels.type }).from(channels).where(eq(channels.id, job.sourceChannelId)).limit(1);
  if (!source || (source.type !== "channel" && source.type !== "private" && source.type !== "joint")) {
    throw new Error("source channel missing during audience cutover");
  }

  const oldHumans = await tx.select({ userId: channelHumans.userId })
    .from(channelHumans).where(eq(channelHumans.channelId, job.sourceChannelId));
  const oldAgents = await tx.select({ agentId: channelAgents.agentId })
    .from(channelAgents).where(eq(channelAgents.channelId, job.sourceChannelId));
  // Public channels previously used an implicit server-wide read shortcut. A
  // converted Joint has only its explicit channel_humans/channel_agents ACL,
  // exactly like a newly-created Joint; the old public shortcut is not copied.
  if (applyMutations && source.type === "channel" && audienceCleanupMutationForTest === "legacy_public_acl_leak") {
    const publicUsers = (await tx.select({ userId: serverMembers.userId }).from(serverMembers).where(eq(serverMembers.serverId, job.serverId))).map((row) => row.userId);
    const publicAgents = (await tx.execute(sql`SELECT id::text AS id FROM agents WHERE server_id = ${job.serverId} AND deleted_at IS NULL ORDER BY id`)).rows.flatMap((row) => typeof (row as { id?: unknown }).id === "string" ? [(row as { id: string }).id] : []);
    // read-position: test-only mutation (audienceCleanupMutationForTest)
    await tx.insert(channelHumans).values(publicUsers.map((userId) => ({ channelId: job.sourceChannelId, userId }))).onConflictDoNothing();
    // read-position: test-only mutation (audienceCleanupMutationForTest)
    await tx.insert(channelAgents).values(publicAgents.map((agentId) => ({ channelId: job.sourceChannelId, agentId }))).onConflictDoNothing();
  }
  if (applyMutations && (source.type === "private" || source.type === "channel")) {
    await tx.delete(channelHumans).where(and(
      eq(channelHumans.channelId, job.sourceChannelId),
      sql`NOT EXISTS (SELECT 1 FROM ${serverMembers} member WHERE member.server_id = ${job.serverId} AND member.user_id = ${channelHumans.userId})`,
    ));
    await tx.delete(channelAgents).where(and(
      eq(channelAgents.channelId, job.sourceChannelId),
      sql`NOT EXISTS (SELECT 1 FROM agents member WHERE member.id = ${channelAgents.agentId} AND member.server_id = ${job.serverId} AND member.deleted_at IS NULL)`,
    ));
  }

  const finalUsers = await tx.select({ userId: channelHumans.userId }).from(channelHumans)
    .where(eq(channelHumans.channelId, job.sourceChannelId));
  const finalAgents = await tx.select({ agentId: channelAgents.agentId }).from(channelAgents)
    .where(eq(channelAgents.channelId, job.sourceChannelId));
  const finalUserSet = new Set(finalUsers.map((row) => row.userId));
  const finalAgentSet = new Set(finalAgents.map((row) => row.agentId));
  const threadIds = (await conversionScopeChannelIds(tx, job, canonicalChannelId)).filter((id) => id !== job.sourceChannelId && id !== canonicalChannelId);
  const scopeIds = [job.sourceChannelId, canonicalChannelId, ...threadIds];
  const residue = await tx.execute(sql`
    SELECT DISTINCT receiver_id::text AS id, receiver_type::text AS type
      FROM ${inboxNotificationFacts}
     WHERE source_channel_id IN (${sql.join(scopeIds.map((id) => sql`${id}::uuid`), sql`, `)})
    UNION
    SELECT DISTINCT follower_id::text, follower_type::text
      FROM ${threadFollows}
     WHERE thread_channel_id IN (${sql.join(scopeIds.map((id) => sql`${id}::uuid`), sql`, `)})
    UNION
    SELECT DISTINCT user_id::text, 'user'::text
      FROM ${userChannelInboxStates}
     WHERE channel_id IN (${sql.join(scopeIds.map((id) => sql`${id}::uuid`), sql`, `)})
    UNION
    SELECT DISTINCT user_id::text, 'user'::text
      FROM ${userChannelReadCursors}
     WHERE channel_id IN (${sql.join(scopeIds.map((id) => sql`${id}::uuid`), sql`, `)})
    UNION
    SELECT DISTINCT user_id::text, 'user'::text
      FROM ${userChannelDisplayPrefs}
     WHERE channel_id IN (${sql.join(scopeIds.map((id) => sql`${id}::uuid`), sql`, `)})
    UNION
    SELECT DISTINCT receiver_id::text, receiver_type::text
      FROM ${inboxSuppressionStates}
     WHERE target_channel_id IN (${sql.join(scopeIds.map((id) => sql`${id}::uuid`), sql`, `)})
        OR source_channel_id IN (${sql.join(scopeIds.map((id) => sql`${id}::uuid`), sql`, `)})
    UNION
    SELECT DISTINCT receiver_id::text, receiver_type::text
      FROM ${inboxTargetMuteStates}
     WHERE source_channel_id IN (${sql.join(scopeIds.map((id) => sql`${id}::uuid`), sql`, `)})
    UNION
    SELECT DISTINCT receiver_id::text, receiver_type::text
      FROM ${mobilePushOutbox}
     WHERE source_channel_id IN (${sql.join(scopeIds.map((id) => sql`${id}::uuid`), sql`, `)})
    UNION
    SELECT DISTINCT principal_id::text, 'user'::text
      FROM ${activitySyncRows}
     WHERE server_id = ${job.serverId}::uuid
       AND row_id IN (${sql.join(scopeIds.map((id) => sql`${id}::uuid`), sql`, `)})
    UNION
    SELECT DISTINCT principal_id::text, 'user'::text
      FROM ${activitySyncChanges}
     WHERE server_id = ${job.serverId}::uuid
       AND row_id IN (${sql.join(scopeIds.map((id) => sql`${id}::uuid`), sql`, `)})
       AND ${audienceCleanupMutationForTest !== "activity_change_only_principal_discovery"}
    UNION
    SELECT DISTINCT agent_id::text, 'agent'::text
      FROM ${agentChannelReadCursors}
     WHERE channel_id IN (${sql.join(scopeIds.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
  const residueUsers = (residue.rows as Array<{ id?: unknown; type?: unknown }>)
    .filter((row) => row.type === "user" && typeof row.id === "string")
    .map((row) => row.id as string);
  const residueAgents = (residue.rows as Array<{ id?: unknown; type?: unknown }>)
    .filter((row) => row.type === "agent" && typeof row.id === "string")
    .map((row) => row.id as string);
  const serverMemberState = await tx.select({
    userId: serverMembers.userId,
    channelOrder: serverMembers.sidebarChannelOrder,
    pinnedRefs: serverMembers.pinnedRefs,
    pinnedChannelIds: serverMembers.pinnedChannelIds,
    pinnedOrder: serverMembers.pinnedOrder,
  }).from(serverMembers).where(eq(serverMembers.serverId, job.serverId));
  const scope = new Set(scopeIds);
  const pinnedResidueUsers = serverMemberState.filter((member) =>
    (Array.isArray(member.channelOrder) && member.channelOrder.some((id) => scope.has(id)))
    || (Array.isArray(member.pinnedRefs) && member.pinnedRefs.some((ref) => ref.kind === "channel" && scope.has(ref.id)))
    || (Array.isArray(member.pinnedChannelIds) && member.pinnedChannelIds.some((id) => scope.has(id)))
    || (Array.isArray(member.pinnedOrder) && member.pinnedOrder.some((id) => scope.has(id)))
  ).map((member) => member.userId);
  const formerPublicUsers = job.sourceChannelType === "channel"
    ? serverMemberState.map(row => row.userId) : [];
  const formerPublicAgents = job.sourceChannelType === "channel"
    ? (await tx.execute(sql`SELECT id::text AS id FROM agents WHERE server_id = ${job.serverId} AND deleted_at IS NULL`)).rows.map(row => String(row.id)) : [];
  const lostUserIds = [...new Set([...formerPublicUsers, ...oldHumans.map((row) => row.userId), ...residueUsers, ...pinnedResidueUsers])].filter((id) => !finalUserSet.has(id)).sort();
  const lostAgentIds = [...new Set([...formerPublicAgents, ...oldAgents.map((row) => row.agentId), ...residueAgents])].filter((id) => !finalAgentSet.has(id)).sort();
  const result: ConversionAudienceResult = {
    threadIds,
    retainedUserIds: [...finalUserSet].sort(),
    lostUserIds,
    retainedAgentIds: [...finalAgentSet].sort(),
    lostAgentIds,
    sourceType: job.sourceChannelType,
  };
  const ledger = {
    epoch: job.conversionEpoch,
    sourceType: result.sourceType,
    scopeCount: threadIds.length + 2,
    retainedUserCount: result.retainedUserIds.length,
    lostUserCount: result.lostUserIds.length,
    retainedAgentCount: result.retainedAgentIds.length,
    lostAgentCount: result.lostAgentIds.length,
    checksum: audienceChecksum(result),
  };
  if (applyMutations) await tx.update(channels).set({
    type: "joint",
    guestVisible: false,
    guestJoinable: false,
  }).where(eq(channels.id, job.sourceChannelId));
  if (options.advanceJob !== false) {
    await advance(tx, job.id, "residual_cleanup", {
      progress: {
        ...progress,
        audienceCutoverAt: currentDate().toISOString(),
        audienceCutover: result,
        audienceCutoverLedger: ledger,
      },
    });
  }
  span?.addEvent("server.channel_conversion.phase.finished", conversionTraceAttrs(job, { outcome: "ok", rowsCopied: result.retainedUserIds.length }));
  return result;
}

function boundedCleanupRows(table: AnyPgTable, condition: SQL | undefined) {
  return sql`${table}.ctid IN (SELECT ctid FROM ${table} WHERE ${condition ?? sql`true`} LIMIT ${CHANNEL_CONVERSION_BATCH_SIZE})`;
}

export async function residualCleanup(
  { tx, job, progress, span }: ConversionPhaseContext,
  options: { advanceJob?: boolean; applyMutations?: boolean } = {},
): Promise<ConversionCleanupLedger> {
  const applyMutations = options.applyMutations !== false;
  const canonicalChannelId = await requireCanonicalChannelId(tx, job);
  const audience = progress.audienceCutover;
  const scopeIds = [job.sourceChannelId, canonicalChannelId, ...(Array.isArray(audience?.threadIds) ? audience?.threadIds : [])];
  const lostUserIds = Array.isArray(audience?.lostUserIds) ? audience?.lostUserIds : [];
  const lostAgentIds = Array.isArray(audience?.lostAgentIds) ? audience?.lostAgentIds : [];
  const now = currentDate();
  let followRows = 0;
  let pinRows = 0;
  let inboxRows = 0;
  let readCursorRows = 0;
  let displayPrefRows = 0;
  let notificationFactRows = 0;
  let suppressionRows = 0;
  let muteRows = 0;
  let activityRowRows = 0;
  let activityChangeRows = 0;
  let activityScopeRows = 0;
  let pushRows = 0;
  let agentFollowRows = 0;
  let agentNotificationFactRows = 0;
  let agentReadCursorRows = 0;

  if (applyMutations && lostUserIds.length > 0 && audienceCleanupMutationForTest !== "follow_resurrection") {
    const updated = await tx.update(threadFollows).set({ unfollowedAt: now, doneAt: null }).where(boundedCleanupRows(threadFollows, and(
      eq(threadFollows.followerType, "user"),
      inArray(threadFollows.followerId, lostUserIds),
      inArray(threadFollows.threadChannelId, scopeIds),
      isNull(threadFollows.unfollowedAt),
    ))).returning({ threadChannelId: threadFollows.threadChannelId });
    followRows = updated.length;
  }

  if (applyMutations && lostUserIds.length > 0 && audienceCleanupMutationForTest !== "pin_sidebar_residue") {
    const members = await tx.select({ serverId: serverMembers.serverId, userId: serverMembers.userId, channelOrder: serverMembers.sidebarChannelOrder, pinnedRefs: serverMembers.pinnedRefs, pinnedChannelIds: serverMembers.pinnedChannelIds, pinnedOrder: serverMembers.pinnedOrder })
      .from(serverMembers).where(and(eq(serverMembers.serverId, job.serverId), inArray(serverMembers.userId, lostUserIds)));
    const scope = new Set(scopeIds);
    for (const member of members) {
      const refs = Array.isArray(member.pinnedRefs) ? member.pinnedRefs.filter((ref) => !(ref.kind === "channel" && scope.has(ref.id))) : member.pinnedRefs;
      const channelOrder = Array.isArray(member.channelOrder) ? member.channelOrder.filter((id) => !scope.has(id)) : member.channelOrder;
      const pinnedChannelIds = Array.isArray(member.pinnedChannelIds) ? member.pinnedChannelIds.filter((id) => !scope.has(id)) : member.pinnedChannelIds;
      const pinnedOrder = Array.isArray(member.pinnedOrder) ? member.pinnedOrder.filter((id) => !scope.has(id)) : member.pinnedOrder;
      if (JSON.stringify(refs) !== JSON.stringify(member.pinnedRefs) || JSON.stringify(channelOrder) !== JSON.stringify(member.channelOrder) || JSON.stringify(pinnedChannelIds) !== JSON.stringify(member.pinnedChannelIds) || JSON.stringify(pinnedOrder) !== JSON.stringify(member.pinnedOrder)) {
        await tx.update(serverMembers).set({ pinnedRefs: refs, sidebarChannelOrder: channelOrder, pinnedChannelIds, pinnedOrder, pinnedVersion: sql`${serverMembers.pinnedVersion} + 1` }).where(and(eq(serverMembers.serverId, member.serverId), eq(serverMembers.userId, member.userId)));
        pinRows += 1;
        if (pinRows === CHANNEL_CONVERSION_BATCH_SIZE) break;
      }
    }
  }

  if (applyMutations && lostUserIds.length > 0 && audienceCleanupMutationForTest !== "unread_inbox_activity_residue") {
    const userScopes = and(inArray(userChannelInboxStates.userId, lostUserIds), inArray(userChannelInboxStates.channelId, scopeIds));
    inboxRows += (await tx.delete(userChannelInboxStates).where(boundedCleanupRows(userChannelInboxStates, userScopes)).returning({ userId: userChannelInboxStates.userId })).length;
    if (audienceCleanupMutationForTest !== "rejoin_restores_old_state") {
      readCursorRows = (await tx.delete(userChannelReadCursors).where(boundedCleanupRows(userChannelReadCursors, and(inArray(userChannelReadCursors.userId, lostUserIds), inArray(userChannelReadCursors.channelId, scopeIds)))).returning({ userId: userChannelReadCursors.userId })).length;
    }
    displayPrefRows = (await tx.delete(userChannelDisplayPrefs).where(boundedCleanupRows(userChannelDisplayPrefs, and(inArray(userChannelDisplayPrefs.userId, lostUserIds), inArray(userChannelDisplayPrefs.channelId, scopeIds)))).returning({ userId: userChannelDisplayPrefs.userId })).length;
    notificationFactRows = (await tx.delete(inboxNotificationFacts).where(boundedCleanupRows(inboxNotificationFacts, and(eq(inboxNotificationFacts.receiverType, "user"), inArray(inboxNotificationFacts.receiverId, lostUserIds), inArray(inboxNotificationFacts.sourceChannelId, scopeIds)))).returning({ id: inboxNotificationFacts.id })).length;
    // A suppression can be keyed by a canonical target while retaining the
    // converted source in `source_channel_id` (or vice versa for a projected
    // thread). Discovery intentionally considers both identities; cleanup
    // must use the same scope predicate or a stale suppression can recreate a
    // lost user's notification state on retry/rejoin.
    suppressionRows = await clearSuppressionForReceivers({
      receiverIds: lostUserIds,
      channelIds: scopeIds,
      executor: tx,
      limit: CHANNEL_CONVERSION_BATCH_SIZE,
    });
    muteRows = (await tx.delete(inboxTargetMuteStates).where(boundedCleanupRows(inboxTargetMuteStates, and(eq(inboxTargetMuteStates.receiverType, "user"), inArray(inboxTargetMuteStates.receiverId, lostUserIds), inArray(inboxTargetMuteStates.sourceChannelId, scopeIds)))).returning({ receiverId: inboxTargetMuteStates.receiverId })).length;
    // Activity rows are derived windows, not authority. Remove only rows whose
    // row id is in this conversion scope; preserve unrelated channels for a
    // retained principal. Any affected scope is rolled to a new epoch with a
    // zero watermark and empty snapshot metadata, so a stale change frame or
    // orphaned scope cannot re-materialize the retired channel/thread.
    const affectedActivityScopes = await tx.execute(sql`
      SELECT DISTINCT server_id::text AS "serverId", principal_id::text AS "principalId", filter, window_id AS "windowId"
        FROM ${activitySyncRows}
       WHERE server_id = ${job.serverId}::uuid
         AND principal_id IN (${sql.join(lostUserIds.map((id) => sql`${id}::uuid`), sql`, `)})
         AND row_id IN (${sql.join(scopeIds.map((id) => sql`${id}::uuid`), sql`, `)})
      UNION
      SELECT DISTINCT server_id::text, principal_id::text, filter, window_id
        FROM ${activitySyncChanges}
       WHERE server_id = ${job.serverId}::uuid
         AND principal_id IN (${sql.join(lostUserIds.map((id) => sql`${id}::uuid`), sql`, `)})
         AND row_id IN (${sql.join(scopeIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `);
    activityRowRows = (await tx.delete(activitySyncRows).where(boundedCleanupRows(activitySyncRows, and(
      eq(activitySyncRows.serverId, job.serverId),
      inArray(activitySyncRows.principalId, lostUserIds),
      inArray(activitySyncRows.rowId, scopeIds),
    ))).returning({ rowId: activitySyncRows.rowId })).length;
    for (const raw of affectedActivityScopes.rows as Array<Record<string, unknown>>) {
      const serverId = typeof raw.serverId === "string" ? raw.serverId : null;
      const principalId = typeof raw.principalId === "string" ? raw.principalId : null;
      const filter = typeof raw.filter === "string" ? raw.filter : null;
      const windowId = typeof raw.windowId === "string" ? raw.windowId : null;
      if (!serverId || !principalId || !filter || !windowId) continue;
      activityChangeRows += (await tx.delete(activitySyncChanges).where(boundedCleanupRows(activitySyncChanges, and(
        eq(activitySyncChanges.serverId, serverId),
        eq(activitySyncChanges.principalId, principalId),
        eq(activitySyncChanges.filter, filter as "all" | "unread" | "mentions"),
        eq(activitySyncChanges.windowId, windowId),
      ))).returning({ seq: activitySyncChanges.seq })).length;
      activityScopeRows += (await tx.update(activitySyncScopes).set({
        epoch: sql`${activitySyncScopes.epoch} + 1`,
        watermark: 0n,
        scopeDigest: null,
        metadata: null,
        updatedAt: now,
      }).where(and(
        eq(activitySyncScopes.serverId, serverId),
        eq(activitySyncScopes.principalId, principalId),
        eq(activitySyncScopes.filter, filter as "all" | "unread" | "mentions"),
        eq(activitySyncScopes.windowId, windowId),
      )).returning({ principalId: activitySyncScopes.principalId })).length;
    }
  }

  if (applyMutations && lostUserIds.length > 0 && audienceCleanupMutationForTest !== "pending_push_socket_leak") {
    const push = await tx.update(mobilePushOutbox).set({ status: "revoked", revokedCount: sql`${mobilePushOutbox.revokedCount} + 1`, processedAt: now, updatedAt: now, lastError: "channel_conversion_audience_cutover" }).where(boundedCleanupRows(mobilePushOutbox, and(eq(mobilePushOutbox.receiverType, "user"), inArray(mobilePushOutbox.receiverId, lostUserIds), inArray(mobilePushOutbox.sourceChannelId, scopeIds), inArray(mobilePushOutbox.status, ["pending", "processing"])))).returning({ id: mobilePushOutbox.id });
    pushRows = push.length;
  }

  // Agents do not have personal sidebar/unread state, but their thread follow
  // and notification facts must not survive a permission cutover either.
  if (applyMutations && lostAgentIds.length > 0) {
    if (audienceCleanupMutationForTest !== "follow_resurrection") {
      agentFollowRows = (await tx.update(threadFollows).set({ unfollowedAt: now, doneAt: null }).where(boundedCleanupRows(threadFollows, and(eq(threadFollows.followerType, "agent"), inArray(threadFollows.followerId, lostAgentIds), inArray(threadFollows.threadChannelId, scopeIds), isNull(threadFollows.unfollowedAt)))).returning({ followerId: threadFollows.followerId })).length;
    }
    if (audienceCleanupMutationForTest !== "unread_inbox_activity_residue") {
      agentNotificationFactRows = (await tx.delete(inboxNotificationFacts).where(boundedCleanupRows(inboxNotificationFacts, and(eq(inboxNotificationFacts.receiverType, "agent"), inArray(inboxNotificationFacts.receiverId, lostAgentIds), inArray(inboxNotificationFacts.sourceChannelId, scopeIds)))).returning({ id: inboxNotificationFacts.id })).length;
      agentReadCursorRows = (await tx.delete(agentChannelReadCursors).where(boundedCleanupRows(agentChannelReadCursors, and(inArray(agentChannelReadCursors.agentId, lostAgentIds), inArray(agentChannelReadCursors.channelId, scopeIds)))).returning({ agentId: agentChannelReadCursors.agentId })).length;
    }
  }

  const prior = progress.residualCleanupDeferred === true
    ? undefined
    : progress.residualCleanupLedger;
  const retainedCount = (key: ConversionCleanupCounter, value: number) => prior && audienceCleanupMutationForTest !== "cleanup_non_idempotent"
    ? prior[key] + value
    : value;
  const counts = {
    epoch: job.conversionEpoch,
    scopeCount: scopeIds.length,
    followRows: retainedCount("followRows", followRows),
    pinRows: retainedCount("pinRows", pinRows),
    inboxRows: retainedCount("inboxRows", inboxRows),
    readCursorRows: retainedCount("readCursorRows", readCursorRows),
    displayPrefRows: retainedCount("displayPrefRows", displayPrefRows),
    notificationFactRows: retainedCount("notificationFactRows", notificationFactRows),
    suppressionRows: retainedCount("suppressionRows", suppressionRows),
    muteRows: retainedCount("muteRows", muteRows),
    activityRowRows: retainedCount("activityRowRows", activityRowRows),
    activityChangeRows: retainedCount("activityChangeRows", activityChangeRows),
    activityScopeRows: retainedCount("activityScopeRows", activityScopeRows),
    pushRows: retainedCount("pushRows", pushRows),
    agentFollowRows: retainedCount("agentFollowRows", agentFollowRows),
    agentNotificationFactRows: retainedCount("agentNotificationFactRows", agentNotificationFactRows),
    agentReadCursorRows: retainedCount("agentReadCursorRows", agentReadCursorRows),
    lostUserCount: lostUserIds.length,
    lostAgentCount: lostAgentIds.length,
  };
  if (prior && audienceCleanupMutationForTest === "cleanup_non_idempotent") {
    // Witnessed mutation: pretend the previous epoch ledger did not exist.
    // A same-epoch replay then records zero newly-removed rows and changes the
    // stable output checksum, which is the observable non-idempotence contract.
    counts.followRows = followRows;
    counts.pinRows = pinRows;
    counts.inboxRows = inboxRows;
    counts.readCursorRows = readCursorRows;
    counts.displayPrefRows = displayPrefRows;
    counts.notificationFactRows = notificationFactRows;
    counts.suppressionRows = suppressionRows;
    counts.muteRows = muteRows;
    counts.activityRowRows = activityRowRows;
    counts.activityChangeRows = activityChangeRows;
    counts.activityScopeRows = activityScopeRows;
    counts.pushRows = pushRows;
    counts.agentFollowRows = agentFollowRows;
    counts.agentNotificationFactRows = agentNotificationFactRows;
    counts.agentReadCursorRows = agentReadCursorRows;
  }
  const ledger = { ...counts, checksum: audienceChecksum(counts) };
  const batchCounts = [followRows, pinRows, inboxRows, readCursorRows, displayPrefRows, notificationFactRows,
    suppressionRows, muteRows, activityRowRows, activityChangeRows, pushRows,
    agentFollowRows, agentNotificationFactRows, agentReadCursorRows];
  const batchNumber = Number(progress.cleanupBatchNumber ?? 0);
  if (options.advanceJob !== false && batchCounts.some(count => count > 0)) {
    await recordConversionPhaseCommit(tx, {
      jobId: job.id, conversionEpoch: job.conversionEpoch, phase: job.phase,
      batchKey: `cleanup:${batchNumber}`, sourceCount: batchCounts.reduce((a, b) => a + b, 0),
      targetCount: 0, checksumInput: stableStringify(counts),
    });
  }
  if (options.advanceJob !== false && batchCounts.some(count => count >= CHANNEL_CONVERSION_BATCH_SIZE)) {
    await persistResourceBatchProgress(tx, job, { ...progress, residualCleanupLedger: ledger, cleanupBatchNumber: batchNumber + 1 });
    return ledger;
  }
  if (options.advanceJob !== false) {
    await advance(tx, job.id, "finalize", {
      progress: { ...progress, ...(applyMutations ? { residualCleanupAt: now.toISOString(), residualCleanupLedger: ledger } : { residualCleanupDeferred: true }) },
    });
  }
  span?.addEvent("server.channel_conversion.phase.finished", conversionTraceAttrs(job, {
    outcome: "ok",
    rowsCopied: followRows + pinRows + inboxRows + readCursorRows + displayPrefRows
      + notificationFactRows + suppressionRows + muteRows + activityRowRows
      + activityChangeRows + activityScopeRows + pushRows + agentFollowRows
      + agentNotificationFactRows + agentReadCursorRows,
  }));
  return ledger;
}

/** Test-only same-epoch replay seam. It executes the real cleanup body under
 * the production source lock but does not advance a terminal job. This lets
 * the permanent idempotence tooth compare the persisted ledger with a second
 * cleanup pass without direct table edits or a synthetic counter assertion.
 */
export async function replayResidualCleanupForTest(jobId: string): Promise<ConversionCleanupLedger> {
  if (process.env.NODE_ENV !== "test") throw new Error("audience cleanup replay is test-only");
  const db = getDb();
  const [routing] = await db
    .select({ serverId: channelConversionJobs.serverId, sourceChannelId: channelConversionJobs.sourceChannelId })
    .from(channelConversionJobs)
    .where(eq(channelConversionJobs.id, jobId))
    .limit(1);
  if (!routing) throw new Error("conversion job not found");
  return withChannelConversionResourceLock(routing.serverId, routing.sourceChannelId, async (tx) => {
    const [job] = await tx.select().from(channelConversionJobs).where(eq(channelConversionJobs.id, jobId)).limit(1);
    if (!job) throw new Error("conversion job not found");
    return residualCleanup({ tx, job, progress: parseConversionProgress(job.progress) }, { advanceJob: false });
  });
}

export async function finalize(
  { tx, job, progress, span }: ConversionPhaseContext) {
  if (!progress.audienceCutoverAt || !progress.residualCleanupAt) {
    throw new Error("conversion cutover and residual cleanup must commit before completion");
  }
  const [updated] = await tx
    .update(channels)
    .set({
      // The source is always cut over to Joint.  The legacy-public mutation
      // only suppresses explicit ACL materialisation above; retaining the old
      // `channel` type here would make the mutation pass by changing the
      // product contract rather than leaking the old public shortcut.
      type: "joint",
      // Preserve lifecycle independently of conversion; converting an
      // archived channel must never reopen it for writes.
    })
    .where(eq(channels.id, job.sourceChannelId))
    .returning({ id: channels.id, serverId: channels.serverId });
  if (!updated) throw new Error("source channel missing during finalize");
  if (updated.serverId !== job.serverId) throw new Error("source channel server mismatch during finalize");

  await tx
    .update(channelConversionJobs)
    .set({
      state: "succeeded",
      phase: "done",
      status: "done",
      completedAt: currentDate(),
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: currentDate(),
      progress: { ...progress, finalizedAt: currentDate().toISOString() },
    })
    .where(eq(channelConversionJobs.id, job.id));
  await requireActionCardReconfirmationAfterCutover(tx, {
    id: job.id,
    serverId: job.serverId,
    sourceChannelId: job.sourceChannelId,
    conversionEpoch: job.conversionEpoch,
  });
  await releaseChannelConversionFence(tx, job.id, "succeeded");
  span?.addEvent("server.channel_conversion.phase.finished", conversionTraceAttrs(job, { outcome: "ok" }));
}
