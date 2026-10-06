// Canonical message formatting for agent-facing output.
// This is the canonical implementation of the agent-facing message text
// format (the MCP chat-bridge it originally mirrored has been removed) —
// an AX contract, not an implementation detail. Pinned by `_format.test.ts`.

import { T, UUID_A, UUID_B, UUID_C, sampleMessage, sampleMessageChannelThread, sampleMessageDm, sampleMessageDmThread } from "../_axExampleFixtures";
import { axSurface } from "../../core/renderer";
import {
  AGENT_API_MESSAGE_SEARCH_DEFAULT_LIMIT,
  AGENT_API_MESSAGE_SEARCH_MAX_LIMIT,
  formatAgentAttachmentSuffix,
  formatAgentInboxHint,
  formatAgentMessageLine,
  formatAgentMessages,
  formatAgentMessageTarget,
  formatAgentSenderHandle,
  formatAgentTaskAssigneeSuffix,
  formatAgentTaskCurrentProjection,
  formatAgentSearchResults,
  formatUtcTimestamp,
  indentAgentBodyContinuationLines,
  neutralizeAgentRaftRefLiterals,
  renderAgentSearchPreviewText,
  type AgentMessageLike,
  type AgentMessageTaskCurrentProjectionLike,
  type AgentSearchData,
  type AgentSearchResultLike,
  type RaftTargetString,
} from "@botiverse/raft-shared";
import type { AgentApiMessageSearchResponse } from "@botiverse/raft-shared";

// The message-like shapes and the canonical header line live in
// `@botiverse/raft-shared` (`agentMessageText.ts`) so the SDK renders the same
// bytes; this file keeps the `axSurface` registrations and CLI-only formatters.
export type TaskCurrentProjectionLike = AgentMessageTaskCurrentProjectionLike;
export type MessageLike = AgentMessageLike;

// Return type is the structured wire form (not opaque string): a dropped `@`,
// a missing sigil, or a malformed thread suffix in any branch below is now a
// compile error instead of a subtly-wrong target string shipped to agents.
// Structured target shape, not a reply surface: consumed inside other
// formatters and by command routing; typed as RaftTargetString.
export function formatTarget(m: MessageLike): RaftTargetString {
  return formatAgentMessageTarget(m);
}

const formatSenderHandle = formatAgentSenderHandle;
const formatAttachmentSuffix = formatAgentAttachmentSuffix;
const formatTaskAssigneeSuffix = formatAgentTaskAssigneeSuffix;

function formatTaskCurrentProjection(
  projection: TaskCurrentProjectionLike | null | undefined,
  taskNumber?: number | null,
  neutralizeRefs = false,
): string {
  return formatAgentTaskCurrentProjection(projection, taskNumber, neutralizeRefs ? renderAgentSearchPreviewText : undefined);
}

export const formatMessageLine = axSurface(
  "One received-message line: header bracket + sender + content + suffixes.",
  (m: MessageLike): string => formatAgentMessageLine(m),
  {
    // All four target shapes (@xxchan 8/31): channel, channel thread, dm, dm thread.
    examples: [
      { title: "channel", args: [sampleMessage] },
      { title: "channel thread", args: [sampleMessageChannelThread] },
      { title: "dm", args: [sampleMessageDm] },
      { title: "dm thread", args: [sampleMessageDmThread] },
    ],
  },
);

export const formatMessages = axSurface(
  "Batch of received-message lines (message check output).",
  (messages: MessageLike[]): string => formatAgentMessages(messages),
  {
    examples: [{ title: "batch incl. agent sender + task bracket + all target shapes", args: [[sampleMessage, { ...sampleMessage, message_id: UUID_B, seq: 1201, sender_type: "agent", sender_name: "Alice", sender_description: "example agent role", content: "hi there", task_status: "in_progress", task_number: 42, task_assignee_id: "a-1", task_assignee_type: "agent" }, { ...sampleMessageChannelThread, seq: 1202 }, { ...sampleMessageDm, message_id: UUID_A, seq: 1203 }, { ...sampleMessageDmThread, seq: 1204 }]] }],
  },
);

/**
 * `message check` hands over a bounded batch, oldest first per conversation;
 * the server reports how many conversations still have unread after it.
 */
export const formatInboxHint = axSurface(
  "Still-unread line appended to message check when conversations remain unread beyond the returned batch.",
  (hint: { unread_conversations: number }): string => formatAgentInboxHint(hint),
  {
    examples: [{ args: [{ unread_conversations: 12 }] }, { title: "singular", args: [{ unread_conversations: 1 }] }],
  },
);

/**
 * App items come from a Raft daemon's inbox; an external agent has no daemon.
 * Said explicitly so an absent pending-app-items line is not read as "none".
 */
export const formatAppItemsUnavailable = axSurface(
  "message check line for external agents: app items are not available (no Raft daemon).",
  (): string => "App items: not available for external agents.",
  {
    examples: [{ args: [] }],
  },
);

// --- History formatting (matches MCP read_history output) ---

export interface HistoryMessage {
  seq?: number;
  id?: string;
  message_id?: string;
  createdAt?: string;
  timestamp?: string;
  senderType?: string;
  sender_type?: string;
  senderName?: string;
  sender_name?: string;
  senderDescription?: string | null;
  sender_description?: string | null;
  content?: string;
  attachments?: Array<{ id: string; filename: string }>;
  taskStatus?: string | null;
  taskNumber?: number | null;
  taskAssigneeType?: string | null;
  taskAssigneeId?: string | null;
  taskAssigneeName?: string | null;
  task_assignee_name?: string | null;
  taskCurrentProjection?: TaskCurrentProjectionLike | null;
  threadId?: string | null;
  replyCount?: number | null;
  [key: string]: unknown;
}

// Match the server's `parseChannelRef`: only the LAST colon can introduce a
// thread suffix, and that suffix must be exactly 8 hex characters. Parent
// channel/DM names may themselves contain colons, so `[^:]+` is incorrect.
function isThreadTargetRef(channel: string): boolean {
  const prefixLength = channel.startsWith("#")
    ? 1
    : /^dm:@/i.test(channel) ? 4 : -1;
  if (prefixLength < 0) return false;
  const targetRest = channel.slice(prefixLength);
  const lastColon = targetRest.lastIndexOf(":");
  return lastColon > 0 && /^[0-9a-f]{8}$/i.test(targetRest.slice(lastColon + 1));
}

function buildReplyTarget(channel: string, messageId: string | undefined): string | null {
  if (!messageId) return null;
  if (isThreadTargetRef(channel)) return null;
  return `${channel}:${messageId.slice(0, 8)}`;
}

function formatHistoryMessageLine(channel: string, m: HistoryMessage, index: number, total: number): string {
  const senderName = m.senderName ?? m.sender_name ?? "unknown";
  const senderDescription = m.senderDescription ?? m.sender_description ?? null;
  const messageId = m.id ?? m.message_id ?? "-";
  const createdAt = m.createdAt ?? m.timestamp ?? null;
  const senderType = m.senderType ?? m.sender_type ?? null;
  const headerParts = [
    `${index + 1}/${total}`,
    `seq=${m.seq ?? "-"}`,
    `msg=${messageId}`,
    `time=${createdAt ? formatUtcTimestamp(createdAt) : "-"}`,
  ];
  if (senderType) headerParts.push(`type=${senderType}`);
  if (m.threadId) headerParts.push(`threadId=${m.threadId}`);
  if ((m.replyCount ?? 0) > 0) headerParts.push(`replyCount=${m.replyCount}`);
  const replyTarget = buildReplyTarget(channel, messageId);
  if (replyTarget) headerParts.push(`replyTarget=${replyTarget}`);

  const attachSuffix = formatAttachmentSuffix(m.attachments);
  const assigneeName = m.taskAssigneeName ?? m.task_assignee_name ?? null;
  const taskSuffix = m.taskStatus
    ? ` [task #${m.taskNumber} status=${m.taskStatus}${formatTaskAssigneeSuffix(m.taskAssigneeId, assigneeName)}]`
    : "";
  const handle = senderDescription ? `@${senderName} — ${senderDescription}` : `@${senderName}`;
  return `[${headerParts.join(" ")}] ${handle}: ${indentAgentBodyContinuationLines(m.content ?? "")}${attachSuffix}${taskSuffix}${formatTaskCurrentProjection(m.taskCurrentProjection)}`;
}

export interface HistoryData {
  messages?: HistoryMessage[];
  has_more?: boolean;
  has_older?: boolean;
  has_newer?: boolean;
  historyLimited?: boolean;
  historyLimitMessage?: string;
  last_read_seq?: number | null;
  unread_after_seq?: number | null;
  read_through_seq?: number | null;
  model_seen_up_to_seq?: number | null;
}

function seqBoundary(messages: HistoryMessage[], edge: "first" | "last"): number | string {
  const message = edge === "first" ? messages[0] : messages[messages.length - 1];
  return typeof message?.seq === "number" && Number.isFinite(message.seq) ? message.seq : "-";
}

function seqRange(messages: HistoryMessage[]): string {
  const first = seqBoundary(messages, "first");
  const last = seqBoundary(messages, "last");
  return first === last ? String(first) : `${first}-${last}`;
}

// Exported for the freshness-hold digest: the hold's never-shown line reuses
// this exact cursor phrasing so agents meet one recovery-command format
// everywhere. If this string shape changes, the hold line follows for free.
// `commandTarget` completes the fragment into a runnable command — required
// outside read output, where no surrounding context supplies the verb
// (instruction-surface universality: every printed command must execute
// as-is, without internal knowledge).
export function historyCursorText(
  label: "Older" | "Newer",
  exists: boolean,
  flag: "before" | "after",
  anchor: number | string,
  commandTarget?: string,
): string {
  if (!exists) return `No ${label.toLowerCase()}.`;
  const command = commandTarget !== undefined
    ? `raft message read --target "${commandTarget}" --${flag} ${anchor}`
    : `--${flag} ${anchor}`;
  return `${label} exist: ${command}.`;
}

export const formatHistory = axSurface(
  "Read window: header with seq range/cursors, numbered lines, end-of-window footer.",
  (
  channel: string,
  data: HistoryData,
  opts?: { around?: string; after?: string | number; before?: string | number; unread?: boolean; alreadyShownSeqs?: ReadonlySet<number> },
): string => {
  const isThreadTarget = isThreadTargetRef(channel);
  const coverage = isThreadTarget
    ? "Coverage: this thread target only."
    : "Coverage: top-level messages in this target only; thread replies are excluded and must be read from their thread targets.";
  if (opts?.unread) return formatUnreadWindow(channel, data, coverage, opts.alreadyShownSeqs);
  if (!data.messages || data.messages.length === 0) return (`${coverage}\n\nNo messages in this target.`);

  const messages = data.messages;
  const count = messages.length;
  const minSeq = seqBoundary(messages, "first");
  const maxSeq = seqBoundary(messages, "last");
  const hasOlder = Boolean(data.has_older ?? (data.has_more && !opts?.after));
  const hasNewer = Boolean(data.has_newer ?? (data.has_more && Boolean(opts?.after)));

  const formatted = messages
    .map((m, index) => formatHistoryMessageLine(channel, {
      ...m,
      senderName: m.senderName ?? m.sender_name ?? "unknown",
      senderDescription: m.senderDescription ?? m.sender_description ?? null,
    }, index, count))
    .join("\n");

  const headerLines = [
    `Read window: ${count} returned, seq ${seqRange(messages)}, oldest to newest. ${historyCursorText("Older", hasOlder, "before", minSeq)} ${historyCursorText("Newer", hasNewer, "after", maxSeq)}`,
    coverage,
  ];
  if (opts?.around) {
    headerLines.push(`Around: ${opts.around}.`);
  }
  if (data.historyLimited) {
    headerLines.push(data.historyLimitMessage || "Message history is limited on this plan.");
  }
  if ((data.last_read_seq ?? 0) > 0 && !opts?.after && !opts?.before && !opts?.around) {
    headerLines.push(`Server unread cursor before this read: seq ${data.last_read_seq}. Use raft message read --target "${channel}" --after ${data.last_read_seq} to browse newer messages.`);
  }

  return (`${headerLines.join("\n")}\n\n${formatted}\n\nEnd of window: ${count}/${count} shown.`);
},
  {
    // Window examples cover all four target shapes (@xxchan 8/31); the dm
    // window also shows the replyTarget affordance, which thread windows omit.
    examples: [{ title: "unread window (--unread), more unread remain", args: ["#general:00000000", { messages: [sampleMessage, { ...sampleMessage, message_id: UUID_B, seq: 1201, content: "second message" }], has_older: true, has_newer: true, last_read_seq: 1199, unread_after_seq: 1199, model_seen_up_to_seq: 1201 }, { unread: true }] }, { title: "unread window (--unread), newest message too recent to mark read", args: ["#general", { messages: [sampleMessage, { ...sampleMessage, message_id: UUID_B, seq: 1201, content: "second message" }], has_older: true, has_newer: false, last_read_seq: 1199, unread_after_seq: 1199, read_through_seq: 1200, model_seen_up_to_seq: 1201 }, { unread: true }] }, { title: "unread window (--unread), a message already shown last time is folded", args: ["#general", { messages: [sampleMessage, { ...sampleMessage, message_id: UUID_B, seq: 1201, content: "second message" }], has_older: true, has_newer: false, last_read_seq: 1199, unread_after_seq: 1199, read_through_seq: 1201, model_seen_up_to_seq: 1201 }, { unread: true, alreadyShownSeqs: new Set([1200]) }] }, { title: "unread window (--unread), nothing unread", args: ["#general", { messages: [], has_older: true, has_newer: false, last_read_seq: 1201, unread_after_seq: 1201 }, { unread: true }] }, { title: "channel window with unread cursor", args: ["#general", { messages: [sampleMessage, { ...sampleMessage, message_id: UUID_B, seq: 1201, content: "second message" }], has_older: true, has_newer: false, last_read_seq: 1200 }] }, { title: "channel thread window (--around anchor)", args: ["#general:00000000", { messages: [sampleMessage], has_older: true, has_newer: true }, { around: "00000000" }] }, { title: "dm window with a threaded reply", args: ["dm:@richard", { messages: [{ ...sampleMessage, content: "hey, can you help?", replyCount: 2 }], has_older: false, has_newer: false }] }, { title: "dm thread window", args: ["dm:@richard:00000000", { messages: [sampleMessage, { ...sampleMessage, message_id: UUID_B, seq: 1201, content: "DM thread reply" }], has_older: false, has_newer: false }] }],
  },
);

/**
 * `raft message read --unread`: what is unread in one conversation, starting
 * right after the agent's read position. Reading moves that position, so the
 * continuation is the same command again, never a seq that can go stale.
 */
function formatUnreadWindow(
  channel: string,
  data: HistoryData,
  coverage: string,
  alreadyShownSeqs: ReadonlySet<number> = new Set(),
): string {
  const readThrough = data.unread_after_seq ?? data.last_read_seq ?? 0;
  const messages = data.messages ?? [];
  if (messages.length === 0) {
    return `${coverage}\n\nNo unread messages in ${channel}. You have read through seq ${readThrough}.`;
  }
  // Messages this agent was already shown (they came back because they were
  // too recent to mark read last time) are folded into one line, so a repeat
  // is not mistaken for a new message and answered twice.
  const folded = messages.filter((m) => typeof m.seq === "number" && alreadyShownSeqs.has(m.seq));
  const shown = messages.filter((m) => !folded.includes(m));
  const newPosition = typeof data.read_through_seq === "number" ? data.read_through_seq : data.model_seen_up_to_seq;
  const shownCount = messages.length - folded.length;
  const movedTo = shownCount > 0 && typeof newPosition === "number" && newPosition > readThrough
    ? `Read position: seq ${readThrough} → ${newPosition}. To re-read these: raft message read --target "${channel}" --after ${readThrough}`
    : null;
  // The re-read command is printed once: on the read-position line when there
  // is one, otherwise here.
  const foldNote = folded.length > 0
    ? `${folded.length} message${folded.length === 1 ? "" : "s"} you were already shown (seq ${seqRange(folded)}) ${folded.length === 1 ? "is" : "are"} not repeated.${movedTo ? "" : ` To see ${folded.length === 1 ? "it" : "them"} again: raft message read --target "${channel}" --after ${readThrough}`}`
    : null;
  const footer = data.has_newer
    ? `More unread remain. Next: raft message read --target "${channel}" --unread`
    : null;
  if (shown.length === 0) {
    return `${coverage}\n\nNo new unread messages in ${channel}. ${foldNote}${footer ? `\n${footer}` : ""}`;
  }
  const count = shown.length;
  const formatted = shown
    .map((m, index) => formatHistoryMessageLine(channel, {
      ...m,
      senderName: m.senderName ?? m.sender_name ?? "unknown",
      senderDescription: m.senderDescription ?? m.sender_description ?? null,
    }, index, count))
    .join("\n");
  const header = `Unread window: ${count} returned, seq ${seqRange(shown)}, oldest to newest, starting after your read position (seq ${readThrough}).`;
  // Rows newer than the read position were too recent to mark read (seq order
  // is not commit order); say so, or the agent reads them as new next time.
  const unsettled = typeof newPosition === "number"
    ? shown.filter((m) => typeof m.seq === "number" && m.seq > newPosition).length
    : 0;
  const settleNote = unsettled > 0
    ? `${unsettled} newest message${unsettled === 1 ? " is" : "s are"} too recent to mark read; ${unsettled === 1 ? "it" : "they"} will come back on your next --unread, folded into one line.`
    : null;
  const end = footer ?? (unsettled > 0 ? null : "No more unread in this target.");
  return `${header}\n${coverage}\n\n${[foldNote, formatted].filter(Boolean).join("\n")}\n\n${[movedTo, settleNote, end].filter(Boolean).join("\n")}`;
}

// --- Search result rendering (agent-facing AX readout) ---
// The text lives in `@botiverse/raft-shared` (`agentText/search.ts`) so the
// SDK renders the same bytes; this file keeps the axSurface registration.

type SearchResult = AgentSearchResultLike;
type SearchData = AgentSearchData;
type _DeclaredKeys<T> = keyof { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] };
type _UnmodelledSearchTopLevelFields = Exclude<_DeclaredKeys<AgentApiMessageSearchResponse>, keyof SearchData>;
const _searchDataModelsContractTopLevel: [_UnmodelledSearchTopLevelFields] extends [never] ? true : never = true;
void _searchDataModelsContractTopLevel;
export type { SearchResult, SearchData };

export const formatSearchResults = axSurface(
  "Search results with <match>/<omit /> preview markup.",
  (query: string, data: SearchData, offset?: number, sort?: string, limit?: number): string =>
    formatAgentSearchResults(query, data, offset, sort, limit),
  {
    // Results cover all four source shapes (@xxchan 8/31): channel, channel
    // thread, dm, dm thread — each renders a distinct Source: line.
    examples: [{ args: ["deploy", { results: [
      { id: UUID_A, seq: 1200, createdAt: T, channelType: "channel", channelName: "general", senderName: "richard", senderType: "human", content: "we should deploy on tuesday after the review", match: { start: 10, end: 16 } },
      { id: UUID_B, seq: 1201, createdAt: T, channelType: "thread", channelName: "thread-00000000", parentChannelType: "channel", parentChannelName: "general", senderName: "Alice", senderType: "agent", content: "deploy checklist is green, ready when you are", match: { start: 0, end: 6 } },
      { id: UUID_C, seq: 1202, createdAt: T, channelType: "dm", channelName: "richard", senderName: "richard", senderType: "human", content: "can you own the deploy tomorrow?", match: { start: 16, end: 22 } },
      { id: UUID_A, seq: 1203, createdAt: T, channelType: "thread", channelName: "thread-55555555", parentChannelType: "dm", parentChannelName: "richard", senderName: "Alice", senderType: "agent", content: "deploy done, readback posted", match: { start: 0, end: 6 } },
    ], hasMore: false }] }],
  },
);

// --- Send-path diagnostics (moved verbatim from send.ts, print-seam S3) ---

// Bytes observed before this deadline make --send-draft fail closed. Once the
// deadline wins, later bytes are outside the observation window and stay unread.
export const SEND_DRAFT_STDIN_OBSERVATION_MS = 1_000;

export const formatSendDraftStdinDeadlineDiagnostic = axSurface(
  "send --send-draft stdin-deadline diagnostic (stderr).",
  (
  observationWindowMs = SEND_DRAFT_STDIN_OBSERVATION_MS,
): string => {
  return (`No stdin bytes were detected within ${observationWindowMs}ms; the stored draft will now be sent.`);
},
  {
    examples: [{ args: [] }],
  },
);

export const DRAFT_REPLACED_EXCERPT_LIMIT = 400;

/**
 * A target holds exactly ONE draft — the slot is keyed `(agentId, target)` both
 * locally and server-side — so sending new content discards whatever was there.
 *
 * The discarded body is printed on purpose: after this point it exists nowhere
 * else, and this line is the last copy. It is the sender's own text going back
 * to the sender's own terminal. Deliberately NOT suggesting `--send-draft` as a
 * recovery: by the time this prints, the slot already belongs to the new
 * content, so that command would send the replacement rather than the thing
 * just lost.
 */
export const formatDraftReplacedWarning = axSurface(
  "Draft-replaced warning carrying the last copy of the discarded body.",
  (target: string, previousContent: string): string => {
  const trimmed = previousContent.trim();
  const excerpt = trimmed.length > DRAFT_REPLACED_EXCERPT_LIMIT
    ? `${trimmed.slice(0, DRAFT_REPLACED_EXCERPT_LIMIT)}… (${trimmed.length} chars total, truncated)`
    : trimmed;
  return ([
    `Warning: replacing an unsent draft for ${target}.`,
    `One draft is kept per target, so the previous body is now discarded.`,
    `Discarded draft (last copy):`,
    excerpt,
  ].join("\n"));
},
  {
    examples: [{ args: ["#general", "the previously drafted body that is being discarded"] }],
  },
);
