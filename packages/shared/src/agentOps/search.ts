// Find-a-specific-message operations: search, resolve one id, react. Distinct
// from the inbox ("what needs me now").

import { z } from "zod";

import type { AgentApiClient } from "../agentApiClient";
import type { AgentApiMessageSearchResponse } from "../agentApiContract";
import { formatAgentMessages } from "../agentMessageText";
import { formatAgentSearchResults } from "../agentText/search";
import { hintStep, RAFT_HINTS, type RaftHintOptions } from "./hint";
import { projectRaftMessage, toAgentMessageLike, type RaftMessage } from "./message";
import { failureFromClientResult, failureOutcome, opError, validateOpRequest, type RaftNextStep, type RaftOutcome } from "./outcome";
import { requestSchema } from "./requestSchema";

export interface SearchMessagesRequest {
  /** Free-text query; may be omitted when filtering by target or sender only. */
  query?: string;
  /** Restrict to a channel, DM, or thread target. */
  target?: string;
  /** Restrict to a sender handle. */
  sender?: string;
  sort?: "relevance" | "recent";
  /** ISO timestamps, both inclusive server-side. */
  before?: string;
  after?: string;
  /** 1..50; Server default 20. */
  limit?: number;
  offset?: number;
}

export const searchMessagesRequestSchema = requestSchema<SearchMessagesRequest>()(z.object({
  query: z.string().optional().describe("Free-text query; may be omitted when filtering by target or sender."),
  target: z.string().optional().describe("Only this channel, DM, or thread."),
  sender: z.string().optional().describe("Only messages from this handle."),
  sort: z.enum(["relevance", "recent"]).optional(),
  before: z.string().optional().describe("ISO timestamp; only messages at or before it."),
  after: z.string().optional().describe("ISO timestamp; only messages at or after it."),
  limit: z.number().int().positive().optional().describe("Results per page, 1..50 (Server default 20)."),
  offset: z.number().int().nonnegative().optional().describe("Skip this many results (paging)."),
}));

export const resolveMessageRequestSchema = requestSchema<{ messageId: string }>()(z.object({
  messageId: z.string().describe("Full or short message id."),
}));

export const reactRequestSchema = requestSchema<ReactRequest>()(z.object({
  messageId: z.string().describe("Full or short message id."),
  emoji: z.string().describe("One reaction emoji."),
}));

export interface RaftSearchPage {
  query: string;
  results: AgentApiMessageSearchResponse["results"];
  /** Server-reported; `null` when an older Server did not say. */
  hasMore: boolean | null;
}

export async function searchMessages(
  client: Pick<AgentApiClient, "messages">,
  request: SearchMessagesRequest,
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftSearchPage, "results" | "empty">> {
  const invalid = validateOpRequest(searchMessagesRequestSchema, request); if (invalid) return invalid;
  if (!request.query?.trim() && !request.target && !request.sender) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "Pass a query, or filter by target or sender." }));
  }
  const result = await client.messages.search({
    ...(request.query?.trim() ? { q: request.query.trim() } : {}),
    ...(request.target ? { channel: request.target } : {}),
    ...(request.sender ? { sender: request.sender } : {}),
    ...(request.sort ? { sort: request.sort } : {}),
    ...(request.before ? { before: request.before } : {}),
    ...(request.after ? { after: request.after } : {}),
    ...(request.limit === undefined ? {} : { limit: String(request.limit) }),
    ...(request.offset === undefined ? {} : { offset: String(request.offset) }),
  });
  if (!result.ok) return failureFromClientResult(result);
  const data = result.data;
  const hasMore = typeof data.hasMore === "boolean" ? data.hasMore : null;
  const page: RaftSearchPage = { query: request.query?.trim() ?? "", results: data.results, hasMore };
  const nextArgs = { ...request, offset: (request.offset ?? 0) + data.results.length };
  const next: RaftNextStep | null = hasMore
    ? {
        kind: "next_search_page",
        args: nextArgs,
        operation: { name: "messages.search", args: nextArgs },
        why: "More results exist; page on, or narrow the query.",
      }
    : null;
  return {
    ok: true,
    state: data.results.length > 0 ? "results" : "empty",
    data: page,
    next,
    text: formatAgentSearchResults(page.query, { results: data.results as never, ...(hasMore === null ? {} : { hasMore }) }, request.offset, request.sort, request.limit, options.hints),
  };
}

export async function resolveMessage(
  client: Pick<AgentApiClient, "messages">,
  request: { messageId: string },
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftMessage, "message">> {
  const invalid = validateOpRequest(resolveMessageRequestSchema, request); if (invalid) return invalid;
  if (!request.messageId?.trim()) return failureOutcome(opError("INVALID_REQUEST", { message: "A message id is required." }));
  const result = await client.messages.resolve({ msgId: request.messageId as never });
  if (!result.ok) return failureFromClientResult(result);
  const message = projectRaftMessage(result.data.message, options.hints);
  if (!message) return failureOutcome(opError("INVALID_RESPONSE", { message: "The resolved message carries no conversation identity." }));
  return {
    ok: true,
    state: "message",
    data: message,
    next: hintStep(
      "read_target",
      RAFT_HINTS.messageRead({ target: message.target, around: { shown: message.shortId ?? request.messageId, id: message.id ?? request.messageId } }),
      "Read the surrounding context before acting on one message.",
      options.hints,
      { target: message.target, around: message.id ?? request.messageId },
    ),
    text: formatAgentMessages([toAgentMessageLike(message.raw)], options.hints),
  };
}

export interface ReactRequest {
  messageId: string;
  emoji: string;
}

export async function reactToMessage(
  client: Pick<AgentApiClient, "messages">,
  request: ReactRequest,
  action: "add" | "remove" = "add",
): Promise<RaftOutcome<ReactRequest, "added" | "removed">> {
  const invalid = validateOpRequest(reactRequestSchema, request); if (invalid) return invalid;
  const emoji = request.emoji?.trim();
  if (!request.messageId?.trim() || !emoji || /\s/.test(emoji) || emoji.length > 16) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "A message id and a single reaction emoji are required." }));
  }
  const params = { msgId: request.messageId as never };
  const result = action === "add"
    ? await client.messages.addReaction(params, { emoji })
    : await client.messages.removeReaction(params, { emoji });
  if (!result.ok) return failureFromClientResult(result);
  const verb = action === "add" ? "added to" : "removed from";
  return {
    ok: true,
    state: action === "add" ? "added" : "removed",
    data: { messageId: request.messageId, emoji },
    next: null,
    text: `Reaction ${emoji} ${verb} message ${request.messageId.slice(0, 8)}.`,
  };
}
