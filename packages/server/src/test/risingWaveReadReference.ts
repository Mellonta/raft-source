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
 *     rw_followed_threads_v5 (v3's stats columns).
 *   - Followed-thread rows (rw_followed_threads_v5): v5's followed_threads CTE
 *     and parent/task/joint-parent joins in Postgres, with those same stats.
 *
 * channelService and the references are imported lazily, so installing the seam
 * from a vitest setup file does not load the service graph before a test file
 * has set its environment.
 */
import { __setActivityReadSourceForTests } from "../services/activityReadSource";
import {
  __setConversationUnreadSourceForTests,
  type ConversationUnreadSource,
} from "../services/conversationUnreadSource";

export { referenceActivityReadSource } from "../services/postgresActivityReads";
import { referenceActivityReadSource } from "../services/postgresActivityReads";

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
