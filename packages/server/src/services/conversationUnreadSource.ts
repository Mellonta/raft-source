import { usesPostgresReadBackend } from "../db/readBackend";
import { referenceConversationUnreadSource } from "./postgresConversationUnread";
/** Sidebar read source, selected explicitly for the deployment or by a test. */

/** One (user, conversation) row of the sidebar unread read. */
export type ConversationUnreadRow = {
  serverId: string;
  /** The LOCAL channel id (joint storage mapping is done upstream in the chain). */
  targetId: string;
  kind: "channel" | "dm" | "thread";
  /** False for a mention-only row and for a public-channel `hasNew` row. */
  subscribed: boolean;
  unreadCount: number;
  mentionUnread: number;
  totalMentions: number;
  /**
   * Public-channel arm only: a non-joined public channel of the server whose
   * latest seq is past the user's cursor. Carries no count.
   */
  hasNew: boolean;
  latestSeq: string | null;
  latestMessageId: string | null;
  cursorPresent: boolean;
  lastReadSeq: string | null;
  readStateVersion: number | null;
};

export type ConversationUnreadSummaryQuery = {
  serverId: string;
  userId: string;
  /** Include the non-joined public channel `hasNew` arm (the summary does; bare counts do not). */
  includePublicNew: boolean;
};

export type SidebarUnreadTotalsQuery = {
  serverIds: string[];
  userId: string;
};

export type ConversationUnreadSource = {
  /**
   * Rows for one (user, server): every view row with unread_count > 0 or
   * total_mentions > 0, plus (when asked) the public `hasNew` rows.
   */
  summaryRows(query: ConversationUnreadSummaryQuery): Promise<ConversationUnreadRow[]>;
  /**
   * Per-server SUM(unread_count) over subscribed, non-thread rows. Servers with
   * nothing unread may be absent.
   */
  sidebarTotals(query: SidebarUnreadTotalsQuery): Promise<Array<{ serverId: string; unreadCount: number }>>;
};

let testSource: ConversationUnreadSource | null = null;

/** TEST-ONLY: replace the RisingWave read with another source (null restores RisingWave). */
export function __setConversationUnreadSourceForTests(source: ConversationUnreadSource | null): void {
  testSource = source;
}

export function getConversationUnreadSourceOverride(): ConversationUnreadSource | null {
  return testSource ?? (usesPostgresReadBackend() ? referenceConversationUnreadSource : null);
}
