// Sender-side mention operations: what to do when an @mention you sent did not
// reach its target (pending actions), notify / add to deliver it, and the
// per-target delivery outcome of a message you sent.

import { z } from "zod";

import type { AgentApiClient } from "../agentApiClient";
import type { AgentApiSenderMentionDeliveriesResponse } from "../agentApiContract";
import {
  formatAgentMentionActionResults,
  formatAgentPendingMentionActions,
  formatAgentSenderMentionDeliveries,
  normalizeAgentMentionActionResults,
  normalizeAgentPendingMentionActions,
  type AgentMentionActionKind,
  type AgentMentionActionResult,
  type AgentPendingMentionAction,
} from "../agentText/mentions";
import { hintStep, RAFT_HINTS, type RaftHintOptions } from "./hint";
import { failureFromClientResult, failureOutcome, opError, validateOpRequest, type RaftNextStep, type RaftOutcome } from "./outcome";
import { requestSchema } from "./requestSchema";

export const pendingMentionActionsRequestSchema = requestSchema<{ limit?: number }>()(z.object({
  limit: z.number().int().positive().optional().describe("Maximum pending mentions to list."),
}));

export const mentionResolutionIdsRequestSchema = requestSchema<MentionResolutionIdsRequest>()(z.object({
  resolutionIds: z.array(z.string()).describe("resolutionId values from mentions.pending."),
}));

export const senderMentionDeliveriesRequestSchema = requestSchema<{ messageId: string }>()(z.object({
  messageId: z.string().describe("Id of a message you sent."),
}));

export interface RaftPendingMentions {
  actions: AgentPendingMentionAction[];
  /** Server-reported; `null` when it did not say (completeness not asserted). */
  hasMore: boolean | null;
  limit: number | undefined;
}

export async function pendingMentionActions(
  client: Pick<AgentApiClient, "mentions">,
  request: { limit?: number } = {},
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftPendingMentions, "pending" | "empty">> {
  const invalid = validateOpRequest(pendingMentionActionsRequestSchema, request); if (invalid) return invalid;
  const result = await client.mentions.pendingActions(request.limit === undefined ? {} : { limit: String(request.limit) });
  if (!result.ok) return failureFromClientResult(result);
  const actions = normalizeAgentPendingMentionActions(result.data);
  const hasMore = typeof result.data.has_more === "boolean" ? result.data.has_more : null;
  const first = actions.find((a) => a.availableActions.length > 0);
  const next: RaftNextStep | null = first
    ? hintStep(
        "resolve_mention",
        RAFT_HINTS.mentionAction("notify", first.resolutionId),
        "This @mention reached nobody at send time; notify the target (or add them) so the message is seen.",
        options.hints,
        { action: "notify", resolutionIds: [first.resolutionId] },
      )
    : null;
  return {
    ok: true,
    state: actions.length > 0 ? "pending" : "empty",
    data: { actions, hasMore, limit: request.limit },
    next,
    text: formatAgentPendingMentionActions(actions, { source: "pending", ...(hasMore === null ? {} : { hasMore }), limit: request.limit, hints: options.hints }),
  };
}

export interface MentionResolutionIdsRequest {
  resolutionIds: string[];
}

export type RaftMentionActionOutcome = RaftOutcome<{ action: AgentMentionActionKind; results: AgentMentionActionResult[] }, "executed">;

/** Tell the targets of unreached @mentions about the message (`raft mention notify`). */
export async function notifyMentions(client: Pick<AgentApiClient, "mentions">, request: MentionResolutionIdsRequest): Promise<RaftMentionActionOutcome> {
  const invalid = validateOpRequest(mentionResolutionIdsRequestSchema, request); if (invalid) return invalid;
  return runMentionAction(client, "notify", request.resolutionIds);
}

/** Add the targets of unreached @mentions to the conversation (`raft mention add`). */
export async function addMentions(client: Pick<AgentApiClient, "mentions">, request: MentionResolutionIdsRequest): Promise<RaftMentionActionOutcome> {
  const invalid = validateOpRequest(mentionResolutionIdsRequestSchema, request); if (invalid) return invalid;
  return runMentionAction(client, "add", request.resolutionIds);
}

async function runMentionAction(
  client: Pick<AgentApiClient, "mentions">,
  action: AgentMentionActionKind,
  resolutionIds: string[] | undefined,
): Promise<RaftMentionActionOutcome> {
  const ids = (resolutionIds ?? []).map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) return failureOutcome(opError("INVALID_REQUEST", { message: "Pass at least one resolution id." }));
  const result = await client.mentions.executeAction({ action, resolutionIds: ids });
  if (!result.ok) return failureFromClientResult(result);
  const results = normalizeAgentMentionActionResults(result.data);
  return {
    ok: true,
    state: "executed",
    data: { action, results },
    next: null,
    text: formatAgentMentionActionResults(action, results),
  };
}

export async function senderMentionDeliveries(
  client: Pick<AgentApiClient, "mentions">,
  request: { messageId: string },
): Promise<RaftOutcome<AgentApiSenderMentionDeliveriesResponse, "deliveries" | "empty">> {
  const invalid = validateOpRequest(senderMentionDeliveriesRequestSchema, request); if (invalid) return invalid;
  if (!request.messageId?.trim()) return failureOutcome(opError("INVALID_REQUEST", { message: "A message id is required." }));
  const result = await client.mentions.senderDeliveries({ messageId: request.messageId });
  if (!result.ok) return failureFromClientResult(result);
  const data = result.data;
  return {
    ok: true,
    state: data.deliveries.length > 0 ? "deliveries" : "empty",
    data,
    next: null,
    text: formatAgentSenderMentionDeliveries(data.messageId, data.deliveries),
  };
}
