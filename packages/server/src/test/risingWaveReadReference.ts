/**
 * TEST-ONLY Postgres references for the RisingWave-served reads.
 *
 * RisingWave is a hard dependency of the server: the Activity item list, the
 * Activity unread totals, the followed-thread stats and the sidebar unread read
 * come from RisingWave only, and with no RisingWave the request fails. CI unit
 * tests and e2e run on PGlite without RisingWave, so they install these
 * references explicitly through the product's test seams:
 *
 *   - services/activityReadSource.ts      Activity items, totals, followed-thread stats
 *   - services/conversationUnreadSource.ts sidebar unread (conversationUnreadReference.ts)
 *
 * Installed for every server test by the vitest setup file
 * (src/test/setup/risingWaveReadReference.ts) and by the Playwright e2e server
 * (src/test/startPlaywrightServer.ts). A test that exercises a RisingWave read
 * itself (a mocked pool) uninstalls them and reinstalls them in its own finally.
 *
 * These are stand-ins for the RW views, not product paths. They are the
 * Postgres reads the server served before RisingWave became a hard dependency,
 * so behaviour under test is unchanged:
 *   - Activity items: the canonical inline Postgres read of getInboxItems (the
 *     same SQL that still serves search, guest access and authority
 *     transactions), reached with forceCanonicalPostgres.
 *   - Activity totals: the per-server canonical computation, looped, with
 *     membership revalidated per server.
 *   - Followed-thread stats: getFollowedThreadStatsFromPostgres (the same SQL
 *     that still serves activity-upper-bound / authority-transaction reads). Its
 *     unread predicate is the unified chain's rule, identical to
 *     rw_followed_threads_v4 (v3's stats columns).
 *   - Followed-thread rows (rw_followed_threads_v4): v4's followed_threads CTE
 *     and parent/task joins in Postgres, with those same stats.
 *
 * channelService and the references are imported lazily, so installing the seam
 * from a vitest setup file does not load the service graph before a test file
 * has set its environment.
 */
import { and, eq, inArray } from "drizzle-orm";
import { __setActivityReadSourceForTests, type ActivityReadSource } from "../services/activityReadSource";
import {
  __setConversationUnreadSourceForTests,
  type ConversationUnreadSource,
} from "../services/conversationUnreadSource";
import type {
  ActivityUnreadTotals,
  FollowedThreadRwRow,
  FollowedThreadStatsRow,
} from "../services/channelService";

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

const lazyConversationUnreadReference: ConversationUnreadSource = {
  async summaryRows(query) {
    const { referenceConversationUnreadSource } = await import("./conversationUnreadReference");
    return referenceConversationUnreadSource.summaryRows(query);
  },
  async sidebarTotals(query) {
    const { referenceConversationUnreadSource } = await import("./conversationUnreadReference");
    return referenceConversationUnreadSource.sidebarTotals(query);
  },
};

/** Install every RisingWave read reference (vitest setup, e2e server). */
export function installRisingWaveReadReferences(): void {
  __setActivityReadSourceForTests(referenceActivityReadSource);
  __setConversationUnreadSourceForTests(lazyConversationUnreadReference);
}

/** Remove every reference, so reads go to RisingWave (a mocked pool, or none: an error). */
export function uninstallRisingWaveReadReferences(): void {
  __setActivityReadSourceForTests(null);
  __setConversationUnreadSourceForTests(null);
}
