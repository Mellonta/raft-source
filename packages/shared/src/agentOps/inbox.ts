// Inbox operations: what an agent wants when it is woken up.
//
// `checkInbox` pulls one bounded batch from `/events`; `drainInbox` keeps
// pulling until the Server reports nothing more (the CLI's `raft message
// check` loop, same round cap and same cursor rules); `listInbox` is the
// Activity panel (`raft inbox check`): unread conversations, each with the
// exact command that opens it, and one `next` step.
//
// Acknowledgement is explicit. With `ack: "cursor"` (the default here, and the
// External Agent contract) nothing is acknowledged by a pull; the NEXT pull
// that passes the returned `cursor` as `since` acknowledges the batch. A
// runtime therefore commits its own work first and only then passes the
// cursor on, and a crash before that simply returns the same batch again.
// `ack: "immediate"` is the pre-1.0 behaviour and is a destructive read.

import { z } from "zod";

import type { AgentApiClient } from "../agentApiClient";
import { formatAgentInboxHint, formatAgentMessages } from "../agentMessageText";
import type { AgentApiInboxListResponse } from "../agentApiContract";
import { projectRaftMessages, sortBySeq, toAgentMessageLike, type RaftMessage } from "./message";
import { failureFromClientResult, validateOpRequest, type RaftNextStep, type RaftOutcome } from "./outcome";
import { requestSchema } from "./requestSchema";
import type { SeenFrontier } from "./frontier";
import { formatHint, hintStep, RAFT_HINTS, type RaftHintOptions, type RaftHintStyle } from "./hint";

export type RaftAckMode = "cursor" | "immediate";

export interface CheckInboxRequest {
  /**
   * Cursor from the previous batch. Under `ack: "cursor"` it acknowledges every
   * row of that batch with seq ≤ since; omit it to resume from what the Server
   * still has pending (safe after a restart).
   */
  since?: number;
  /** 1..200; Server default 50. */
  limit?: number;
  ack?: RaftAckMode;
}

const inboxPullFields = {
  since: z.number().int().nonnegative().optional().describe("Cursor of the previous batch; under cursor acks it acknowledges that batch. Omit to continue from the last committed cursor."),
  limit: z.number().int().positive().optional().describe("Messages per batch, 1..200 (Server default 50)."),
  ack: z.enum(["cursor", "immediate"]).optional().describe("cursor (default): a batch is acknowledged by the next pull; immediate: acknowledged as it is returned."),
};

export const checkInboxRequestSchema = requestSchema<CheckInboxRequest>()(z.object(inboxPullFields));

export interface RaftInboxBatch {
  messages: RaftMessage[];
  /** Pass as `since` on the next check to acknowledge this batch (cursor mode). `null` when the Server sent none. */
  cursor: number | null;
  /** How this batch is acknowledged; `immediate` means it already was. */
  ackMode: RaftAckMode;
  /** The Server trimmed the batch; check again (with the cursor) until false. */
  hasMore: boolean;
  /** Conversations still unread beyond this batch (External Agents), or null when the Server did not say. */
  stillUnreadConversations: number | null;
  /** Server hint for the conversation of the newest event (canonical target since #8559), or null. */
  replyTarget: string | null;
}

export type CheckInboxOutcome = RaftOutcome<RaftInboxBatch, "batch" | "empty">;

const MAX_DRAIN_ROUNDS = 50;

function batchNext(batch: RaftInboxBatch, style: RaftHintStyle): RaftNextStep | null {
  if (batch.hasMore) {
    return hintStep(
      "check_inbox_again",
      RAFT_HINTS.messageCheck(),
      "The Server trimmed this batch; more messages are pending.",
      style,
      batch.cursor === null ? undefined : { since: batch.cursor },
    );
  }
  if ((batch.stillUnreadConversations ?? 0) > 0) {
    return hintStep("list_inbox", RAFT_HINTS.inboxList(), "Conversations remain unread beyond this batch.", style);
  }
  if (batch.messages.length > 0) {
    const first = batch.messages[0]!;
    return {
      kind: "reply_or_act",
      args: { target: first.target },
      why: "Handle the messages above; reply where each one came from.",
    };
  }
  return null;
}

function batchText(batch: RaftInboxBatch, style: RaftHintStyle): string {
  const lines = [formatAgentMessages(batch.messages.map((m) => toAgentMessageLike(m.raw)), style)];
  if (batch.hasMore) lines.push(`More messages are pending. Run \`${formatHint(RAFT_HINTS.messageCheck(), style)}\` again.`);
  else if (batch.messages.length > 0) lines.push("No more new inbox messages.");
  if ((batch.stillUnreadConversations ?? 0) > 0) lines.push(formatAgentInboxHint({ unread_conversations: batch.stillUnreadConversations! }, style));
  return lines.join("\n");
}

function recordExactSeen(frontier: SeenFrontier | undefined, messages: readonly RaftMessage[]): void {
  if (!frontier) return;
  const byTarget = new Map<string, number[]>();
  for (const message of messages) {
    if (message.seq === null) continue;
    byTarget.set(message.target, [...(byTarget.get(message.target) ?? []), message.seq]);
  }
  for (const [target, seqs] of byTarget) frontier.recordExact(target, seqs);
}

/** One bounded pull. Records exact seen seqs on `frontier` (sparse drains never advance the high-water mark). */
export async function checkInbox(
  client: Pick<AgentApiClient, "events">,
  request: CheckInboxRequest = {},
  frontier?: SeenFrontier,
  options: RaftHintOptions = {},
): Promise<CheckInboxOutcome> {
  const style = options.hints ?? "cli";
  const invalid = validateOpRequest(checkInboxRequestSchema, request); if (invalid) return invalid;
  const ack: RaftAckMode = request.ack ?? "cursor";
  const result = await client.events.get({
    since: request.since === undefined ? "latest" : String(request.since),
    ...(request.limit === undefined ? {} : { limit: String(request.limit) }),
    ack,
  });
  if (!result.ok) return failureFromClientResult(result);
  const data = result.data;
  const messages = sortBySeq(projectRaftMessages(data.events, style));
  recordExactSeen(frontier, messages);
  const batch: RaftInboxBatch = {
    messages,
    cursor: typeof data.last_seen_seq === "number" ? data.last_seen_seq : null,
    ackMode: data.ack_mode ?? "immediate",
    hasMore: data.has_more === true,
    stillUnreadConversations: data.inbox_hint?.unread_conversations ?? null,
    replyTarget: data.reply_target ?? null,
  };
  return { ok: true, state: messages.length > 0 ? "batch" : "empty", data: batch, next: batchNext(batch, style), text: batchText(batch, style) };
}

export interface DrainInboxRequest {
  since?: number;
  limit?: number;
  ack?: RaftAckMode;
}

export const drainInboxRequestSchema = requestSchema<DrainInboxRequest>()(z.object(inboxPullFields));

export interface RaftInboxDrainSummary {
  /** Cursor of the last batch handed out; pass it as `since` on the next pull to acknowledge that batch. */
  cursor: number | null;
  ackMode: RaftAckMode;
  /** Rounds made against the Server. */
  rounds: number;
  /** True when the drain stopped at the round cap or after a failed round; messages may remain. */
  hasMore: boolean;
  stillUnreadConversations: number | null;
  /** The failure that ended the drain early, if any. */
  error: Extract<CheckInboxOutcome, { ok: false }> | null;
}

/**
 * Pull until the Server reports nothing more, like `raft message check`, but
 * as an async iterator so that acknowledgement follows consumption: under
 * cursor acks, the pull that acknowledges batch N is only sent when the
 * consumer asks for batch N+1, i.e. after it has processed batch N. A consumer
 * that stops midway leaves the current batch unacknowledged, and a later pull
 * without a cursor returns it again. Capped at 50 rounds. The generator's
 * return value summarises the drain; the batch that ends the iteration is
 * acknowledged only by the caller's next pull (`summary.cursor`).
 */
export async function* drainInbox(
  client: Pick<AgentApiClient, "events">,
  request: DrainInboxRequest = {},
  frontier?: SeenFrontier,
  /** Called after each successful pull with the `since` it sent and the batch; lets a state session follow along. */
  onPull?: (sentSince: number | null, batch: RaftInboxBatch) => void | Promise<void>,
  options: RaftHintOptions = {},
): AsyncGenerator<RaftInboxBatch, RaftInboxDrainSummary, void> {
  const ack: RaftAckMode = request.ack ?? "cursor";
  const invalid = validateOpRequest(drainInboxRequestSchema, request);
  if (invalid) return { cursor: null, ackMode: ack, rounds: 0, hasMore: true, stillUnreadConversations: null, error: invalid };
  let cursor: number | null = request.since ?? null;
  let ackMode: RaftAckMode = ack;
  let stillUnread: number | null = null;
  let rounds = 0;

  while (rounds < MAX_DRAIN_ROUNDS) {
    const sent = cursor;
    rounds += 1;
    const round = await checkInbox(client, { ...(sent === null ? {} : { since: sent }), limit: request.limit, ack }, frontier, options);
    if (!round.ok) return { cursor, ackMode, rounds, hasMore: true, stillUnreadConversations: stillUnread, error: round };
    const batch = round.data;
    await onPull?.(sent, batch);
    ackMode = batch.ackMode;
    stillUnread = batch.stillUnreadConversations;
    if (batch.messages.length > 0) {
      cursor = batch.cursor ?? sent;
      // Handing the batch out; the consumer's next request is what acknowledges it.
      yield batch;
      if (ack === "cursor" && batch.ackMode === "cursor") continue;
      if (batch.hasMore) continue;
      return { cursor, ackMode, rounds, hasMore: false, stillUnreadConversations: stillUnread, error: null };
    }
    // An empty round: under cursor acks it acknowledged the previous batch and confirmed nothing is pending.
    if (ack === "cursor" && batch.ackMode === "cursor" && batch.cursor !== null && batch.cursor !== sent) {
      cursor = batch.cursor;
      continue;
    }
    return { cursor, ackMode, rounds, hasMore: batch.hasMore, stillUnreadConversations: stillUnread, error: null };
  }
  return { cursor, ackMode, rounds, hasMore: true, stillUnreadConversations: stillUnread, error: null };
}

/** A whole drain as one result (the SDK's `invoke("inbox.drain")`): every batch's messages, in order, and the summary. */
export interface RaftInboxDrained {
  messages: RaftMessage[];
  /** Batches handed out. */
  batches: number;
  summary: RaftInboxDrainSummary;
}

/** Fold a finished drain into one outcome; a drain that failed before its first batch is that failure. */
export function drainedInboxOutcome(
  batches: readonly RaftInboxBatch[],
  summary: RaftInboxDrainSummary,
  options: RaftHintOptions = {},
): RaftOutcome<RaftInboxDrained, "batch" | "empty"> {
  if (summary.error && batches.length === 0) return summary.error;
  const style = options.hints ?? "cli";
  const messages = batches.flatMap((batch) => batch.messages);
  const lines = [formatAgentMessages(messages.map((m) => toAgentMessageLike(m.raw)), style)];
  if (summary.error) lines.push("The drain stopped early on an error; more messages may be pending. Check the inbox again.");
  else if (summary.hasMore) lines.push("More messages are pending. Check the inbox again.");
  else if (messages.length > 0) lines.push("No more new inbox messages.");
  const stillUnread = summary.stillUnreadConversations ?? 0;
  if (stillUnread > 0) lines.push(formatAgentInboxHint({ unread_conversations: stillUnread }, style));
  const first = messages[0];
  const next: RaftNextStep | null = summary.hasMore
    ? hintStep("check_inbox_again", RAFT_HINTS.messageCheck(), "More messages are pending.", style)
    : stillUnread > 0
      ? hintStep("list_inbox", RAFT_HINTS.inboxList(), "Conversations remain unread beyond this drain.", style)
      : first
        ? { kind: "reply_or_act", args: { target: first.target }, why: "Handle the messages above; reply where each one came from." }
        : null;
  return {
    ok: true,
    state: messages.length > 0 ? "batch" : "empty",
    data: { messages, batches: batches.length, summary },
    next,
    text: lines.join("\n"),
  };
}

export interface ListInboxRequest {
  view?: "unread" | "mentions";
  /** Next page: the `nextBeforeSeq` of the previous page. */
  before?: number;
  /** 1..50; Server default 20. */
  limit?: number;
}

export const listInboxRequestSchema = requestSchema<ListInboxRequest>()(z.object({
  view: z.enum(["unread", "mentions"]).optional().describe("unread (default): every unread conversation; mentions: only those that @mention you."),
  before: z.number().int().nonnegative().optional().describe("Next page: the nextBeforeSeq of the previous page."),
  limit: z.number().int().positive().optional().describe("Conversations per page, 1..50 (Server default 20)."),
}));

export interface RaftInboxConversation {
  target: string;
  kind: "dm" | "channel" | "thread";
  unread: number;
  mentions: number;
  lastReadSeq: number;
  activitySeq: number;
  latestSenderName: string | null;
  latestAt: string | null;
  /** The exact command that opens this conversation from the agent's read position (the tool call with `hints: "tool"`). */
  openCommand: string;
}

export interface RaftInboxListing {
  view: "unread" | "mentions";
  conversations: RaftInboxConversation[];
  totals: AgentApiInboxListResponse["totals"];
  hasMore: boolean;
  nextBeforeSeq: number | null;
}

function openHint(item: { target: string; lastReadSeq: number }) {
  return RAFT_HINTS.messageRead({ target: item.target, after: item.lastReadSeq });
}

function listingNext(listing: RaftInboxListing, style: RaftHintStyle): RaftNextStep | null {
  const first = listing.conversations[0];
  if (first) {
    return hintStep(
      "read_target",
      openHint(first),
      "Open the newest unread conversation from your read position.",
      style,
      { target: first.target, after: first.lastReadSeq },
    );
  }
  return null;
}

function listingText(listing: RaftInboxListing, style: RaftHintStyle): string {
  const t = listing.totals;
  const head = t.conversations === 0
    ? "Inbox: nothing unread."
    : `Inbox: ${t.conversations} unread ${t.conversations === 1 ? "conversation" : "conversations"} (${t.dms} DMs, ${t.mentions} with mentions).${listing.conversations.length > 0 ? " Newest activity first." : ""}`;
  const rows = listing.conversations.map((c) => {
    const flags = [c.mentions > 0 ? "mentions you" : null, c.kind === "thread" ? "thread" : null].filter(Boolean).join(" · ");
    return `${c.target} · ${c.unread} unread${flags ? ` · ${flags}` : ""}${c.latestSenderName ? ` · latest @${c.latestSenderName}` : ""}\n  open: ${c.openCommand}`;
  });
  const trailer: string[] = [];
  if (listing.hasMore && listing.nextBeforeSeq !== null) {
    const more = RAFT_HINTS.inboxList({ ...(listing.view === "mentions" ? { view: "mentions" as const } : {}), before: listing.nextBeforeSeq });
    trailer.push(`More: ${formatHint(more, style)}`);
  }
  const next = listingNext(listing, style);
  trailer.push(next?.command ? `Next: open the first conversation above: ${next.command}` : "Next: nothing to do.");
  return [head, ...rows, ...trailer].join("\n");
}

/** The agent's Activity panel. Lists only; nothing is consumed. */
export async function listInbox(
  client: Pick<AgentApiClient, "inbox">,
  request: ListInboxRequest = {},
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftInboxListing, "listed" | "empty">> {
  const style = options.hints ?? "cli";
  const invalid = validateOpRequest(listInboxRequestSchema, request); if (invalid) return invalid;
  const result = await client.inbox.list({
    ...(request.view && request.view !== "unread" ? { view: request.view } : {}),
    ...(request.before === undefined ? {} : { before_seq: String(request.before) }),
    ...(request.limit === undefined ? {} : { limit: String(request.limit) }),
  });
  if (!result.ok) return failureFromClientResult(result);
  const data = result.data;
  const listing: RaftInboxListing = {
    view: data.view,
    conversations: data.items.map((item) => ({
      target: item.target,
      kind: item.kind,
      unread: item.unread,
      mentions: item.mentions,
      lastReadSeq: item.lastReadSeq,
      activitySeq: item.activitySeq,
      latestSenderName: item.latestSenderName,
      latestAt: item.latestAt,
      openCommand: formatHint(openHint(item), style),
    })),
    totals: data.totals,
    hasMore: data.hasMore,
    nextBeforeSeq: data.nextBeforeSeq,
  };
  return {
    ok: true,
    state: listing.conversations.length > 0 ? "listed" : "empty",
    data: listing,
    next: listingNext(listing, style),
    text: listingText(listing, style),
  };
}
