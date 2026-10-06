/**
 * Test seam for the RisingWave-served Activity reads: the Activity item list
 * (getInboxItems), the Activity unread totals (getActivityUnreadTotalsBatch),
 * the followed-thread stats and the followed-threads rows (getFollowedThreads).
 *
 * RisingWave is a hard dependency: production reads these from RisingWave only,
 * and with no RisingWave configured (or a failed read) the request fails. There
 * is no Postgres fallback in the product.
 *
 * CI unit tests and e2e run on PGlite without RisingWave, so they explicitly
 * install a Postgres reference (src/test/risingWaveReadReference.ts) through
 * this seam. Like conversationUnreadSource.ts, this module is deliberately tiny
 * (type-only imports) so the test setup can install the reference without
 * loading channelService. Production never sets the override.
 */
import type { DbQueryTracer } from "../tracing/dbQueryTrace";
import type {
  ActivityUnreadTotals,
  ActivityUnreadTotalsBatchInput,
  FollowedThreadMetadataRow,
  FollowedThreadRwRow,
  FollowedThreadStatsRow,
  InboxItemsQuery,
  InboxItemsResult,
} from "./channelService";

export type FollowedThreadStatsQuery = {
  serverId: string;
  userId: string;
  threads: FollowedThreadMetadataRow[];
  traceQuery: DbQueryTracer;
};

export type FollowedThreadRowsQuery = {
  serverId: string;
  userId: string;
  traceQuery: DbQueryTracer;
};

export type ActivityReadSource = {
  /** Replaces the RisingWave Activity item read of getInboxItems. */
  inboxItems(serverId: string, userId: string, query: InboxItemsQuery): Promise<InboxItemsResult>;
  /** Replaces the RisingWave Activity totals read of getActivityUnreadTotalsBatch. */
  activityUnreadTotals(
    inputs: ActivityUnreadTotalsBatchInput[],
    userId: string,
    opts: { traceQuery: DbQueryTracer },
  ): Promise<Map<string, ActivityUnreadTotals>>;
  /** Replaces the RisingWave followed-thread stats read (no cutoff, no upper bound). */
  followedThreadStats(query: FollowedThreadStatsQuery): Promise<FollowedThreadStatsRow[]>;
  /**
   * Replaces the rw_followed_threads_v4 read of getFollowedThreads' active path:
   * every row of (server, user), all follow states.
   */
  followedThreadRows(query: FollowedThreadRowsQuery): Promise<FollowedThreadRwRow[]>;
};

let testSource: ActivityReadSource | null = null;

/** TEST-ONLY: replace the RisingWave Activity reads with another source (null restores RisingWave). */
export function __setActivityReadSourceForTests(source: ActivityReadSource | null): void {
  testSource = source;
}

export function getActivityReadSourceOverride(): ActivityReadSource | null {
  return testSource;
}
