// Message operations: read a conversation, send, reply.
//
// `readHistory` reads a target the way `raft message read` does and advances
// the seen frontier by the same rules (the Server's `model_seen_up_to_seq`
// for a contiguous window; exact seqs for an anchored `around` lookup).
// `sendMessage` attests that frontier so a reply into a conversation the agent
// has read is not held, and turns the Server's freshness hold into an
// `interrupted` outcome (interrupt.ts) the caller can act on, never an
// exception. `replyTo` sends to the target a received message came from.

import { z } from "zod";

import type { AgentApiClient } from "../agentApiClient";
import type { AgentApiHistoryResponse } from "../agentApiContract";
import {
  agentApiStructuredMentionSchema,
  type AgentApiHeldFreshnessResponse,
  type AgentApiSendResponse,
  type AgentApiSendV2Body,
  type AgentApiStructuredMention,
} from "../agentApiMessageContract";
import { formatAgentMessages } from "../agentMessageText";
import type { SeenFrontier } from "./frontier";
import { formatHint, hintStep, RAFT_HINTS, type RaftHintOptions, type RaftHintStyle } from "./hint";
import {
  inProcessSendResume,
  unreadMessagesInterrupt,
  type RaftInterrupt,
  type RaftInterruptCancel,
  type RaftInterrupted,
  type RaftInterruptResume,
} from "./interrupt";
import { projectRaftMessages, sortBySeq, toAgentMessageLike, type RaftMessage } from "./message";
import { failureFromClientResult, failureOutcome, opError, validateOpRequest, type RaftNextStep, type RaftOutcome } from "./outcome";
import { requestSchema } from "./requestSchema";

/** A conversation target as agents spell it. */
export const raftTargetSchema = z.string().describe("Conversation: `#channel`, `dm:@peer`, or a thread `#channel:shortid` / `dm:@peer:shortid`.");

// ── read ──────────────────────────────────────────────────────────────────

export interface ReadHistoryRequest {
  target: string;
  /** Messages after this seq (exclusive); the `--after` the inbox listing prints. */
  after?: number;
  /** Messages before this seq (exclusive): browse older. */
  before?: number;
  /** Anchor a window around a seq or message id; records exact seqs only. */
  around?: number | string;
  limit?: number;
  /**
   * Read this target's unread: start right after the agent's read position
   * (where `inbox.list` counts unread from) and move it forward. Cannot be
   * combined with after/before/around.
   */
  unread?: boolean;
  /**
   * `false` reads without consuming: the Server does not mark the page read,
   * and nothing is recorded in the seen frontier. Use it when the result may
   * not reach the model (for example, code the agent wrote).
   */
  consume?: boolean;
}

export const readHistoryRequestSchema = requestSchema<ReadHistoryRequest>()(z.object({
  target: raftTargetSchema,
  after: z.number().int().nonnegative().optional().describe("Only messages after this seq (exclusive): read what is new since a position, for example the `--after` an inbox listing prints."),
  before: z.number().int().nonnegative().optional().describe("Only messages before this seq (exclusive): browse older history."),
  // A seq is sent to the Server as its string form either way, so "12345" and 12345 read the same window.
  around: z.union([z.number().int(), z.string()]).optional().describe("Anchor a window around a message: its seq number (for example \"12345\") or its message id."),
  limit: z.number().int().positive().optional().describe("Maximum messages in the window."),
  unread: z.boolean().optional().describe("true reads this conversation's unread messages: starts right after your read position and moves it forward. Cannot be combined with after, before, or around."),
  consume: z.boolean().optional().describe("false reads without consuming: the conversation is not marked read and nothing counts as seen."),
}));

export interface RaftHistoryPage {
  /** Canonical target the Server resolved (falls back to the requested spelling on older Servers). */
  target: string;
  messages: RaftMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
  lastReadSeq: number | null;
  /** The contiguous boundary the Server considers model-seen after this read, when it computed one. */
  modelSeenUpToSeq: number | null;
  /** For an `unread` read: the read position the page started after. */
  unreadAfterSeq?: number;
  /**
   * For an `unread` read: the read position after it. Below the newest seq
   * when the newest messages are too recent to mark read (seq order is not
   * commit order); those come again on the next unread read.
   */
  readThroughSeq?: number;
  /**
   * For an `unread` read: seqs on this page the agent was already shown (per
   * the seen frontier, in the current context). They are still in `messages`;
   * `text` folds them into one line so a repeat is not read as new.
   */
  alreadyShownSeqs?: number[];
}

function historyNext(page: RaftHistoryPage, style: RaftHintStyle): RaftNextStep | null {
  const seqs = page.messages.map((m) => m.seq).filter((s): s is number => s !== null);
  // An unread read moved the read position, so the same call continues it.
  if (page.unreadAfterSeq !== undefined) {
    return page.hasNewer && seqs.length > 0
      ? hintStep(
        "read_newer",
        RAFT_HINTS.messageRead({ target: page.target, unread: true }),
        "More unread messages remain in this conversation.",
        style,
        { target: page.target, unread: true },
      )
      : null;
  }
  if (page.hasNewer && seqs.length > 0) {
    const max = Math.max(...seqs);
    return hintStep(
      "read_newer",
      RAFT_HINTS.messageRead({ target: page.target, after: max }),
      "Newer messages exist beyond this window.",
      style,
      { target: page.target, after: max },
    );
  }
  if (page.hasOlder && seqs.length > 0) {
    const min = Math.min(...seqs);
    return hintStep(
      "read_older",
      RAFT_HINTS.messageRead({ target: page.target, before: min }),
      "Older messages exist before this window; read them only if the task needs them.",
      style,
      { target: page.target, before: min },
    );
  }
  return null;
}

function historyText(page: RaftHistoryPage, style: RaftHintStyle): string {
  if (page.messages.length === 0) {
    return page.unreadAfterSeq !== undefined
      ? `No unread messages in ${page.target}. You have read through seq ${page.unreadAfterSeq}.`
      : `No messages in ${page.target}.`;
  }
  const folded = new Set(page.alreadyShownSeqs ?? []);
  const shown = page.messages.filter((m) => m.seq === null || !folded.has(m.seq));
  const lines: string[] = [];
  if (folded.size > 0 && page.unreadAfterSeq !== undefined) {
    const seqs = [...folded].sort((a, b) => a - b);
    const range = seqs.length === 1 ? `${seqs[0]}` : `${seqs[0]}-${seqs[seqs.length - 1]}`;
    const again = formatHint(RAFT_HINTS.messageRead({ target: page.target, after: page.unreadAfterSeq }), style);
    lines.push(`${shown.length === 0 ? `No new unread messages in ${page.target}. ` : ""}${seqs.length} message${seqs.length === 1 ? "" : "s"} you were already shown (seq ${range}) ${seqs.length === 1 ? "is" : "are"} not repeated. To see ${seqs.length === 1 ? "it" : "them"} again: ${again}`);
  }
  if (shown.length > 0) lines.push(formatAgentMessages(shown.map((m) => toAgentMessageLike(m.raw)), style));
  const next = historyNext(page, style);
  if (next?.command) lines.push(`${next.kind === "read_newer" ? "Newer" : "Older"} exist: ${next.command}`);
  return lines.join("\n");
}

/**
 * Frontier rules (FH-EXT-001, mirrored from the CLI): a contiguous window may
 * advance the high-water mark to the Server's `model_seen_up_to_seq`; an
 * `around` lookup and a legacy Server without that field record exact seqs.
 */
function recordHistorySeen(frontier: SeenFrontier | undefined, requested: string, page: RaftHistoryPage, around: boolean): void {
  if (!frontier) return;
  frontier.recordAlias(requested, page.target);
  const seqs = page.messages.map((m) => m.seq).filter((s): s is number => s !== null);
  if (seqs.length === 0) return;
  if (!around && page.modelSeenUpToSeq !== null && page.modelSeenUpToSeq > 0) {
    frontier.recordUpTo(page.target, page.modelSeenUpToSeq);
    return;
  }
  frontier.recordExact(page.target, seqs);
}

export async function readHistory(
  client: Pick<AgentApiClient, "history">,
  request: ReadHistoryRequest,
  frontier?: SeenFrontier,
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftHistoryPage, "page" | "empty">> {
  const style = options.hints ?? "cli";
  const invalid = validateOpRequest(readHistoryRequestSchema, request); if (invalid) return invalid;
  if (!request.target?.trim()) return failureOutcome(opError("INVALID_REQUEST", { message: "A target is required to read history." }));
  if (request.unread && (request.after !== undefined || request.before !== undefined || request.around !== undefined)) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "unread cannot be combined with after, before, or around: it always starts right after your read position." }));
  }
  const result = await client.history.read({
    channel: request.target,
    ...(request.after === undefined ? {} : { after: String(request.after) }),
    ...(request.before === undefined ? {} : { before: String(request.before) }),
    ...(request.around === undefined ? {} : { around: String(request.around) }),
    ...(request.limit === undefined ? {} : { limit: String(request.limit) }),
    ...(request.consume === false ? { consume: "false" as const } : {}),
    ...(request.unread ? { unread: "true" as const } : {}),
  });
  if (!result.ok) return failureFromClientResult(result);
  const data = result.data as AgentApiHistoryResponse & { target?: string };
  // A Server that does not know `unread` ignores it and returns the latest page.
  if (request.unread && typeof data.unread_after_seq !== "number") {
    return failureOutcome(opError("INVALID_RESPONSE", {
      message: "This Server does not support unread reads yet; the page it returned was discarded instead of being shown as unread.",
      nextAction: "List unread conversations with inbox.list, then read one with messages.read and its after seq.",
    }));
  }
  const page: RaftHistoryPage = {
    target: typeof data.target === "string" && data.target ? data.target : request.target,
    messages: sortBySeq(projectRaftMessages(data.messages, style)),
    hasOlder: data.has_older === true,
    hasNewer: data.has_newer === true,
    lastReadSeq: typeof data.last_read_seq === "number" ? data.last_read_seq : null,
    modelSeenUpToSeq: typeof data.model_seen_up_to_seq === "number" ? data.model_seen_up_to_seq : null,
    ...(typeof data.unread_after_seq === "number" ? { unreadAfterSeq: data.unread_after_seq } : {}),
    ...(typeof data.read_through_seq === "number" ? { readThroughSeq: data.read_through_seq } : {}),
  };
  if (request.unread && frontier) {
    const seen = frontier.attestation(page.target);
    const exact = new Set(seen.seenExactSeqs);
    const alreadyShown = page.messages
      .map((m) => m.seq)
      .filter((seq): seq is number => seq !== null && ((seen.seenUpToSeq !== undefined && seq <= seen.seenUpToSeq) || exact.has(seq)));
    if (alreadyShown.length > 0) page.alreadyShownSeqs = alreadyShown;
  }
  if (request.consume !== false) recordHistorySeen(frontier, request.target, page, request.around !== undefined);
  return { ok: true, state: page.messages.length > 0 ? "page" : "empty", data: page, next: historyNext(page, style), text: historyText(page, style) };
}

// ── send ──────────────────────────────────────────────────────────────────

/** Attempts for a keyed send whose request never reached the Server (transport failure only). */
const SEND_TRANSPORT_ATTEMPTS = 3;

export interface SendMessageRequest {
  target: string;
  content: string;
  attachmentIds?: string[];
  /**
   * One key per logical message. Generated with `crypto.randomUUID()` when
   * omitted, so a response lost after the Server committed can be retried
   * without posting twice; sending again after an interrupt reuses the same
   * key (`interrupt.resume.idempotencyKey`).
   */
  idempotencyKey?: string;
  mentions?: AgentApiStructuredMention[];
  /**
   * Override the frontier attestation for this send. Use when the runtime
   * tracks what its model saw itself (for example a stateless worker that
   * persisted the seq it last showed the model).
   */
  seen?: { upToSeq?: number; exactSeqs?: number[] };
}

const sendMessageFields = {
  content: z.string().describe("Message text (Markdown). May be empty only when attachmentIds are given."),
  attachmentIds: z.array(z.string()).optional().describe("Attachment ids from an upload, posted with this message."),
  idempotencyKey: z.string().optional().describe("One key per logical message; generated when omitted. Reuse it to retry, and to resume an interrupted send (interrupt.resume.idempotencyKey)."),
  mentions: z.array(agentApiStructuredMentionSchema).optional().describe("Structured @mentions (user or agent id and name), in addition to @handles in the text."),
  seen: z.object({
    upToSeq: z.number().int().nonnegative().optional(),
    exactSeqs: z.array(z.number().int().positive()).optional(),
  }).optional().describe("Override the seen attestation for this send (runtimes that track what their model saw themselves)."),
};

export const sendMessageRequestSchema = requestSchema<SendMessageRequest>()(z.object({
  target: raftTargetSchema,
  ...sendMessageFields,
}));

/** `reply(message, request)` as one argument object: the received message (its `target`) and the send fields. */
export interface ReplyToRequest extends Omit<SendMessageRequest, "target"> {
  message: Pick<RaftMessage, "target">;
}

export const replyToRequestSchema = requestSchema<ReplyToRequest>()(z.object({
  message: z.object({ target: raftTargetSchema }).describe("The received message to reply to; only its `target` is used."),
  ...sendMessageFields,
}));

export interface RaftSent {
  messageId: string;
  messageSeq: number | null;
  /** Handles in the content that resolved to nobody (Server warning, sender-only). */
  unresolvedMentionHandles: string[];
  /** Newer messages the Server returned alongside the acceptance, if any. */
  recentUnread: RaftMessage[];
}

export type SendMessageOutcome = RaftOutcome<RaftSent, "sent"> | RaftInterrupted;

/** The interrupt's structured details, as `heldText` reads them. */
type HeldDetails = Omit<RaftInterrupt, "reason" | "context" | "resume" | "cancel">;

/** Today's held text (unchanged); it is the interrupt's `context` and the outcome's `text`. */
function heldText(held: HeldDetails, action: string, style: RaftHintStyle): string {
  const noun = held.newMessageCount === 1 ? "message" : "messages";
  const head = `Held — ${held.newMessageCount} unread ${noun} in ${held.target}. ${action}`;
  if (held.withheld) return `${head}\nContext withheld (reviewer isolation).`;
  const lines = [head];
  if (held.formalMentionCount > 0) lines.push(`Note: ${held.formalMentionCount} of these messages formally @mention you.`);
  if (held.omittedMessageCount > 0) lines.push(`${held.omittedMessageCount} earlier ${held.omittedMessageCount === 1 ? "message" : "messages"} not shown.`);
  if (held.heldMessages.length > 0) lines.push(formatAgentMessages(held.heldMessages.map((m) => toAgentMessageLike(m.raw)), style));
  if (!held.contextComplete) lines.push("Not all of them are shown here; read the conversation before sending again.");
  lines.push(`Full text: ${formatHint(RAFT_HINTS.messageRead({ target: held.target }), style)}`);
  return lines.join("\n");
}

/**
 * A Server freshness hold as the `unread_messages` interrupt: the structured
 * details, today's held text as `context`, and the given resume / cancel.
 */
export function heldInterrupt(
  target: string,
  data: AgentApiHeldFreshnessResponse,
  action: string,
  resume: RaftInterruptResume,
  cancel?: RaftInterruptCancel,
  style: RaftHintStyle = "cli",
): RaftInterrupt {
  const interrupt = unreadMessagesInterrupt({ target, hold: data, context: "", resume, ...(cancel ? { cancel } : {}), hints: style });
  return { ...interrupt, context: heldText(interrupt, action, style) };
}

function heldSendNext(interrupt: RaftInterrupt, style: RaftHintStyle): RaftNextStep {
  return hintStep(
    "resend",
    RAFT_HINTS.messageRead({ target: interrupt.target }),
    interrupt.withheld
      ? "Newer messages exist in this conversation but were withheld; read them, then resume the send (interrupt.resume, same idempotencyKey) or cancel it."
      : !interrupt.contextComplete
      ? "Newer messages arrived in this conversation and not all of them are shown here; read the conversation, then resume the send (interrupt.resume, same idempotencyKey) or cancel it."
      : "Newer messages arrived in this conversation. Show interrupt.context to the model, call frontier.recordHeld(interrupt) to attest that, then resume the send (interrupt.resume, same idempotencyKey) or cancel it.",
    style,
    { target: interrupt.target },
  );
}

export function isHeldResponse(data: unknown): data is AgentApiHeldFreshnessResponse {
  return Boolean(data) && typeof data === "object" && (data as { state?: unknown }).state === "held";
}

function sentOutcome(target: string, data: Extract<AgentApiSendResponse, { state: "sent" }>, style: RaftHintStyle): SendMessageOutcome {
  const sent: RaftSent = {
    messageId: data.messageId,
    messageSeq: typeof data.messageSeq === "number" ? data.messageSeq : null,
    unresolvedMentionHandles: data.unresolvedMentionHandles ?? [],
    recentUnread: projectRaftMessages(data.recentUnread ?? [], style),
  };
  const warn = sent.unresolvedMentionHandles.length > 0
    ? ` Unresolved @handles: ${sent.unresolvedMentionHandles.map((h) => `@${h}`).join(", ")}.`
    : "";
  return {
    ok: true,
    state: "sent",
    data: sent,
    next: sent.recentUnread.length > 0
      ? hintStep("read_target", RAFT_HINTS.messageRead({ target }), "Newer messages arrived while you were sending.", style, { target })
      : null,
    text: `Message sent to ${target}. Message ID: ${sent.messageId}${warn}`,
  };
}

export async function sendMessage(
  client: Pick<AgentApiClient, "messages">,
  request: SendMessageRequest,
  frontier?: SeenFrontier,
  options: RaftHintOptions = {},
): Promise<SendMessageOutcome> {
  const style = options.hints ?? "cli";
  const invalid = validateOpRequest(sendMessageRequestSchema, request); if (invalid) return invalid;
  if (!request.target?.trim()) return failureOutcome(opError("INVALID_REQUEST", { message: "A target is required to send a message." }));
  if (typeof request.content !== "string" || (!request.content.trim() && !(request.attachmentIds?.length))) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "Message content (or an attachment) is required." }));
  }
  const idempotencyKey = request.idempotencyKey?.trim() || crypto.randomUUID();
  const attestation = request.seen
    ? { ...(request.seen.upToSeq === undefined ? {} : { seenUpToSeq: request.seen.upToSeq }), seenExactSeqs: request.seen.exactSeqs ?? [] }
    : frontier?.attestation(request.target) ?? { seenExactSeqs: [] };
  const body: AgentApiSendV2Body = {
    target: request.target,
    content: request.content,
    ...(request.attachmentIds?.length ? { attachmentIds: request.attachmentIds } : {}),
    idempotencyKey,
    ...(request.mentions?.length ? { mentions: request.mentions } : {}),
    ...(attestation.seenUpToSeq === undefined ? {} : { seenUpToSeq: attestation.seenUpToSeq }),
    ...(attestation.seenExactSeqs.length > 0 ? { seenExactSeqs: attestation.seenExactSeqs.slice(0, 2_500) } : {}),
  };
  // The key makes a repeat safe, so a request that never reached the Server is retried (bounded).
  let result = await client.messages.sendV2(body);
  for (let attempt = 1; !result.ok && result.error.kind === "transport" && attempt < SEND_TRANSPORT_ATTEMPTS; attempt += 1) {
    result = await client.messages.sendV2(body);
  }
  if (!result.ok) return failureFromClientResult(result);
  const data = result.data;
  if (isHeldResponse(data)) {
    // The SDK keeps no draft, so there is no argv to offer: resuming is
    // sending the same request again with `resume.idempotencyKey`, and
    // cancelling is not sending it (nothing to clean up, so no `cancel`).
    const interrupt = heldInterrupt(
      request.target,
      data,
      "Your message was not sent.",
      inProcessSendResume(idempotencyKey),
      undefined,
      style,
    );
    return { ok: true, state: "interrupted", interrupt, next: heldSendNext(interrupt, style), text: interrupt.context };
  }
  if (data.state === "sent") return sentOutcome(request.target, data, style);
  // `committed` / `not_found` only come back from reconcile-only requests, which this operation does not issue.
  return failureOutcome(opError("INVALID_RESPONSE", { message: `Unexpected send state "${(data as { state: string }).state}".` }));
}

/** Reply where a received message came from. */
export function replyTo(
  client: Pick<AgentApiClient, "messages">,
  message: Pick<RaftMessage, "target">,
  request: Omit<SendMessageRequest, "target">,
  frontier?: SeenFrontier,
  options: RaftHintOptions = {},
): Promise<SendMessageOutcome> {
  return sendMessage(client, { ...request, target: message.target }, frontier, options);
}
