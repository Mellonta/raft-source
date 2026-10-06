// Self-hosted PostgreSQL Activity and followed-thread reads. These are the
// canonical reads upstream retains for search/authority and its reference suite.
import { and, eq, inArray } from "drizzle-orm";
import type { ActivityReadSource } from "./activityReadSource";
import type { ActivityUnreadTotals, FollowedThreadRwRow, FollowedThreadStatsRow } from "./channelService";

export const referenceActivityReadSource: ActivityReadSource = {
  async inboxItems(serverId, userId, query) {
    const { getInboxItems } = await import("../services/channelService");
    return getInboxItems(serverId, userId, { ...query, forceCanonicalPostgres: true });
  },

  async activityUnreadTotals(inputs, userId, opts) {
    const [{ getDb }, { serverMembers }, { getInboxItems }] = await Promise.all([
      import("../db/index"),
      import("../db/schema"),
      import("../services/channelService"),
    ]);
    // The same per-server canonical computation the oracle uses, looped.
    // Membership is revalidated per server: a revoked membership yields ABSENT
    // (fail-closed unknown), never a count or a fake 0; an empty member server
    // yields present-0.
    const memberRows = await getDb()
      .select({ serverId: serverMembers.serverId })
      .from(serverMembers)
      .where(and(
        eq(serverMembers.userId, userId),
        inArray(serverMembers.serverId, inputs.map((input) => input.serverId)),
      ));
    const memberServerIds = new Set(memberRows.map((row) => row.serverId));
    const totalsByServer = new Map<string, ActivityUnreadTotals>();
    for (const input of inputs) {
      if (!memberServerIds.has(input.serverId)) continue;
      const result = await getInboxItems(input.serverId, userId, {
        filter: "all",
        limit: 1,
        offset: 0,
        historyCutoff: input.historyCutoff,
        traceQuery: opts.traceQuery,
        forceCanonicalPostgres: true,
      });
      totalsByServer.set(input.serverId, {
        totalUnreadCount: result.totalUnreadCount,
        activeUnreadCount: result.activeUnreadCount,
      });
    }
    return totalsByServer;
  },

  async followedThreadStats({ userId, threads, traceQuery }) {
    const { getFollowedThreadStatsFromPostgres } = await import("../services/channelService");
    return getFollowedThreadStatsFromPostgres(userId, threads, undefined, traceQuery, "none");
  },

  async followedThreadRows({ serverId, userId, traceQuery }) {
    const [{ getDb }, { sql }, { getFollowedThreadStatsFromPostgres }, { untracedDbQuery }] = await Promise.all([
      import("../db/index"),
      import("drizzle-orm"),
      import("../services/channelService"),
      import("../tracing/dbQueryTrace"),
    ]);
    const readRows = async (): Promise<FollowedThreadRwRow[]> => {
      // rw_followed_threads_v4 (072) in Postgres: v3's followed_threads CTE (every
      // follow state, the joint storage mapping) restricted to (server, user), the
      // parent message / its channel / its task joined last, 141-char previews.
      const threadRows = (await getDb().execute(sql`
        WITH followed_threads AS (
          SELECT
            t.id AS thread_channel_id,
            COALESCE(canonical_thread.id, t.id) AS storage_thread_channel_id,
            t.parent_message_id
          FROM thread_follows tf
          JOIN channels t
            ON t.id = tf.thread_channel_id AND t.type = 'thread' AND t.deleted_at IS NULL
          LEFT JOIN joint_channel_servers thread_projection
            ON thread_projection.local_channel_id = t.id
           AND thread_projection.server_id = t.server_id
           AND thread_projection.status = 'active'
          LEFT JOIN joint_channels thread_joint
            ON thread_joint.id = thread_projection.joint_channel_id AND thread_joint.status = 'active'
          LEFT JOIN channels canonical_thread
            ON canonical_thread.id = thread_joint.canonical_channel_id
           AND canonical_thread.type = 'thread'
           AND canonical_thread.deleted_at IS NULL
          WHERE tf.follower_type = 'user'
            AND tf.follower_id = ${userId}
            AND t.server_id = ${serverId}
        )
        SELECT
          ft.thread_channel_id::text AS "threadChannelId",
          ft.storage_thread_channel_id::text AS "storageThreadChannelId",
          ft.parent_message_id::text AS "parentMessageId",
          parent.channel_id::text AS "parentChannelId",
          parent_ch.server_id::text AS "parentServerId",
          SUBSTR(parent.content, 1, 141) AS "parentMessageContent",
          parent.sender_type AS "parentMessageSenderType",
          parent.sender_id AS "parentMessageSenderId",
          parent.seq::text AS "parentMessageSeq",
          CASE
            WHEN parent.created_at IS NULL THEN NULL::text
            ELSE to_char(parent.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'
          END AS "parentMessageCreatedAt",
          task.id::text AS "taskId",
          task.task_number::int AS "taskNumber",
          task.status AS "taskStatus",
          task.claimed_by_type AS "taskClaimedByType",
          task.claimed_by_id AS "taskClaimedById"
        FROM followed_threads ft
        LEFT JOIN messages parent ON parent.id = ft.parent_message_id
        LEFT JOIN channels parent_ch ON parent_ch.id = parent.channel_id
        LEFT JOIN tasks task ON task.message_id = parent.id
      `)).rows as unknown as Array<Omit<FollowedThreadRwRow, keyof FollowedThreadStatsRow> & { threadChannelId: string }>;
      if (threadRows.length === 0) return [];
      // v3's stats with the same unread predicate and storage mapping (the
      // Postgres stats read the followedThreadStats reference serves).
      const statsRows = await getFollowedThreadStatsFromPostgres(
        userId,
        threadRows.map((row) => ({ threadChannelId: row.threadChannelId, storageThreadChannelId: row.storageThreadChannelId })),
        undefined,
        untracedDbQuery,
        "none",
      );
      const statsByThread = new Map(statsRows.map((row) => [row.threadChannelId, row]));
      return threadRows.map((row): FollowedThreadRwRow => {
        const stats = statsByThread.get(row.threadChannelId)!;
        return {
          ...row,
          ...stats,
          // SUBSTR(latest.content, 1, 141): 141 code points, as RisingWave counts.
          lastReplyContent: stats.lastReplyContent == null
            ? null
            : Array.from(stats.lastReplyContent).slice(0, 141).join(""),
        };
      });
    };
    // Traced as ONE read under the production query name, like the RW lookup.
    return traceQuery(
      "channels.followed_threads_rw_rows",
      readRows,
      (rows) => ({ backend: "postgres_reference", rows_count: rows.length }),
    );
  },
};

