// Canonical agent-facing message text: the `[target=… msg=… time=… type=…]`
// header line and the target string an agent replies to.
//
// This is an AX contract, not an implementation detail: the daemon-managed
// runner, the CLI (`raft message check` / `read`), and the SDK all hand the
// model this exact shape, so an agent sees one world regardless of transport.
// The CLI wraps these functions in `axSurface()` for the AX surfaces manifest;
// the SDK exposes them as `message.text`. Behaviour is pinned by
// `packages/cli/src/commands/message/_format.test.ts`.

import { formatAgentReplyAffordanceSuffix } from "./agentInbox";
import { formatHint, RAFT_HINTS, type RaftHintStyle } from "./agentOps/hint";
import type { RaftTargetString } from "./raftRefs";
import { renderThirdPartyInertJson } from "./thirdPartyInertRenderer";
import { formatUtcTimestamp } from "./utcTimestamp";

export interface AgentMessageTaskCurrentProjectionLike {
  title?: string;
  description?: string | null;
  revision?: number;
  superseded?: boolean;
  amendedAt?: string | null;
  amended_at?: string | null;
  amendedByType?: string | null;
  amended_by_type?: string | null;
  amendedByName?: string | null;
  amended_by_name?: string | null;
  source?: string;
}

/**
 * Prefix every continuation line of a quoted body with `  │ `, so body text
 * never reaches column 0. Structural lines (`[target=…]` / `[1/5 seq=…]` headers,
 * read cursors, footers) always start at column 0, so a line-anchored reader
 * (`grep '^\['`) cannot be handed a forged one by message content. The `│` is
 * non-whitespace on purpose: a reader that trims each line still sees it. It is
 * the same quote marker as the freshness-hold digest previews. Remove the first
 * four characters after each line separator to recover the original body.
 */
export const AGENT_BODY_CONTINUATION_PREFIX = "  │ ";
// Every separator a universal-newline reader (Python `str.splitlines()`, etc.)
// breaks on, not just `\n`: a body could otherwise start an unprefixed line
// with a lone `\r`, NEL or U+2028. `\r\n` is matched first as one separator.
// Exported without the `g` flag so callers' `.test()` / `.exec()` carry no
// `lastIndex` state; global uses build their own from `.source`.
export const AGENT_BODY_LINE_SEPARATOR = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
const AGENT_BODY_LINE_SEPARATOR_GLOBAL = new RegExp(AGENT_BODY_LINE_SEPARATOR.source, "g");
export function indentAgentBodyContinuationLines(text: string): string {
  // The separator itself is kept, so removing the prefix restores the exact body.
  return text.replace(AGENT_BODY_LINE_SEPARATOR_GLOBAL, (separator) => `${separator}${AGENT_BODY_CONTINUATION_PREFIX}`);
}

/** The wire-shaped message fields the canonical text reads. Extra keys are ignored. */
export interface AgentMessageLike {
  channel_type?: string;
  channel_name?: string;
  parent_channel_type?: string;
  parent_channel_name?: string;
  message_id?: string;
  timestamp?: string;
  sender_type?: string;
  sender_name?: string;
  sender_description?: string | null;
  content?: string;
  attachments?: Array<{ id: string; filename: string }>;
  task_status?: string | null;
  task_number?: number | null;
  task_assignee_id?: string | null;
  task_assignee_type?: string | null;
  task_assignee_name?: string | null;
  task_current_projection?: AgentMessageTaskCurrentProjectionLike | null;
  non_member_mention?: boolean;
  third_party_event?: {
    id: string;
    kind: string;
    client_id: string;
    client_name: string;
    external_event_id?: string | null;
    payload_hash: string;
    payload?: Record<string, unknown>;
    expires_at: string;
    source?: {
      client_id?: string;
      client_name?: string;
      oauth_client_id?: string;
      access_token_id_hash?: string | null;
      resource?: string;
    };
  };
  [key: string]: unknown;
}

/**
 * The target an agent passes back to reply where a message came from:
 * `#channel`, `#channel:shortid`, `dm:@peer`, `dm:@peer:shortid`, or
 * `agent-event:shortid` for third-party app events.
 */
export function formatAgentMessageTarget(m: AgentMessageLike): RaftTargetString {
  if (m.third_party_event) {
    return `agent-event:${m.third_party_event.id.slice(0, 8)}` as RaftTargetString;
  }
  if (m.channel_type === "thread" && m.parent_channel_name) {
    const shortId = m.channel_name?.startsWith("thread-") ? m.channel_name.slice(7) : m.channel_name;
    if (m.parent_channel_type === "dm") {
      return `dm:@${m.parent_channel_name}:${shortId}` as RaftTargetString;
    }
    return `#${m.parent_channel_name}:${shortId}` as RaftTargetString;
  }
  if (m.channel_type === "dm") {
    return `dm:@${m.channel_name}` as RaftTargetString;
  }
  return `#${m.channel_name}` as RaftTargetString;
}

export function formatAgentSenderHandle(m: AgentMessageLike): string {
  const name = m.sender_name ?? "unknown";
  const desc = m.sender_description ?? null;
  return desc ? `@${name} — ${desc}` : `@${name}`;
}

export function formatAgentAttachmentSuffix(attachments: Array<{ id: string; filename: string }> | undefined, style: RaftHintStyle = "cli"): string {
  if (!attachments?.length) return "";
  // The tool form names the one attachment's id; with several, the id is the caller's pick.
  const download = formatHint(RAFT_HINTS.attachmentView(style === "tool" && attachments.length === 1 ? attachments[0]!.id : undefined), style);
  return ` [${attachments.length} attachment${attachments.length > 1 ? "s" : ""}: ${attachments.map((a) => `${a.filename} (id:${a.id})`).join(", ")} — use ${download} to download]`;
}

export function formatAgentTaskAssigneeSuffix(assigneeId?: string | null, assigneeName?: string | null): string {
  if (!assigneeId) return "";
  return assigneeName ? ` assignee=@${assigneeName}` : " assignee=<unresolved>";
}

/**
 * Superseded-task projection suffix. `neutralize`, when given, rewrites quoted
 * title/description/actor text so pasted refs cannot route attention (the CLI
 * passes its search-preview neutraliser); the actor handle is then `user:<name>`.
 */
export function formatAgentTaskCurrentProjection(
  projection: AgentMessageTaskCurrentProjectionLike | null | undefined,
  taskNumber?: number | null,
  neutralize?: (text: string) => string,
): string {
  const neutralizeRefs = neutralize !== undefined;
  const renderPreviewText = neutralize ?? ((text: string) => text);
  if (!projection?.superseded) return "";
  const revision = Number.isInteger(projection.revision) ? projection.revision : "?";
  const source = projection.source ?? "tasks_current_projection";
  const actorName = projection.amendedByName ?? projection.amended_by_name ?? null;
  const actorType = projection.amendedByType ?? projection.amended_by_type ?? null;
  const actor = actorName
    ? neutralizeRefs ? `user:${actorName}` : `@${actorName}`
    : actorType === "system" ? "system" : "<unresolved>";
  const amendedAt = projection.amendedAt ?? projection.amended_at ?? null;
  const lines = [
    `[${taskNumber ? `task #${taskNumber} ` : "task "}superseded: current projection rev=${revision} source=${source} actor=${actor} time=${amendedAt ? formatUtcTimestamp(amendedAt) : "-"}]`,
    `Current title: ${indentAgentBodyContinuationLines(neutralizeRefs ? renderPreviewText(projection.title ?? "") : projection.title ?? "")}`,
  ];
  if (projection.description != null) {
    lines.push(`Current description: ${indentAgentBodyContinuationLines(neutralizeRefs ? renderPreviewText(projection.description) : projection.description)}`);
  }
  return `\n${lines.join("\n")}`;
}

/** One received-message line: header bracket + sender + content + suffixes. */
export function formatAgentMessageLine(m: AgentMessageLike, style: RaftHintStyle = "cli"): string {
  if (m.third_party_event) {
    const msgId = m.message_id ? m.message_id.slice(0, 8) : m.third_party_event.id.slice(0, 8);
    const time = m.timestamp ? formatUtcTimestamp(m.timestamp) : "-";
    const event = m.third_party_event;
    const content = m.content ?? "";
    const source = event.source;
    const sourceSuffix = source?.resource
      ? `; resource=${source.resource}${source.access_token_id_hash ? `; access_token_id_hash=${source.access_token_id_hash}` : ""}`
      : "";
    const provenance = `kind=${event.kind}; payload_hash=${event.payload_hash}${sourceSuffix}`;
    return (`[target=agent-event:${event.id.slice(0, 8)} msg=${msgId} time=${time} type=third_party_app] @${event.client_id} — ${event.client_name}: ${provenance}\n${content}${event.payload ? `\npayload:\n${renderThirdPartyInertJson(event.payload)}` : ""}`);
  }
  const target = formatAgentMessageTarget(m);
  const msgId = m.message_id ? m.message_id.slice(0, 8) : "-";
  const time = m.timestamp ? formatUtcTimestamp(m.timestamp) : "-";
  const senderType = ` type=${m.sender_type}`;
  const content = indentAgentBodyContinuationLines(m.content ?? "");
  const attachSuffix = formatAgentAttachmentSuffix(m.attachments, style);
  const taskSuffix = m.task_status
    ? ` [task #${m.task_number} status=${m.task_status}${formatAgentTaskAssigneeSuffix(m.task_assignee_id, m.task_assignee_name)}]`
    : "";
  return (`[target=${target} msg=${msgId} time=${time}${senderType}] ${formatAgentSenderHandle(m)}: ${content}${attachSuffix}${taskSuffix}${formatAgentReplyAffordanceSuffix(m)}${formatAgentTaskCurrentProjection(m.task_current_projection)}`);
}

/** Batch of received-message lines (`raft message check` output). */
export function formatAgentMessages(messages: AgentMessageLike[], style: RaftHintStyle = "cli"): string {
  if (messages.length === 0) return "No new inbox messages.";
  return messages.map((m) => formatAgentMessageLine(m, style)).join("\n");
}

/**
 * `message check` hands over a bounded batch, oldest first per conversation;
 * the server reports how many conversations still have unread after it.
 */
export function formatAgentInboxHint(hint: { unread_conversations: number }, style: RaftHintStyle = "cli"): string {
  const n = hint.unread_conversations;
  return `Still unread: ${n} ${n === 1 ? "conversation" : "conversations"}. Run \`${formatHint(RAFT_HINTS.inboxList(), style)}\` to list them.`;
}
