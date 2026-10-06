import { usesPostgresReadBackend } from "../db/readBackend";
import { referenceActivityReadSource } from "./postgresActivityReads";
/**
 * Activity read source. Self-hosted deployments explicitly select the canonical
 * PostgreSQL implementation with RAFT_READ_BACKEND=postgres. Otherwise reads use
 * RisingWave. Test overrides take precedence; failures never switch backends.
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
  return testSource ?? (usesPostgresReadBackend() ? referenceActivityReadSource : null);
}
