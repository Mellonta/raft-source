// Action cards: prepare an operation for a human to confirm in Raft.
//
// Today this covers the Server's existing card types (channel:create,
// channel:add_member, agent:create, and the integration ones); the human who
// clicks the card executes it under their own identity. Generic cards for any
// write operation (`raft.<op>.prepare`) are designed separately and will build
// on this outcome shape.

import { randomUuid } from "../randomUuid";
import type { AgentApiClient } from "../agentApiClient";
import { agentApiActionPrepareBodySchema, type AgentApiActionPrepareBody } from "../agentApiContract";
import { agentTaskThreadTarget } from "../agentText/tasks";
import { hintStep, RAFT_HINTS, type RaftHintOptions, type RaftHintStyle } from "./hint";
import { failureFromClientResult, failureOutcome, keyedWriteFailure, opError, validateOpRequest, type RaftNextStep, type RaftOutcome } from "./outcome";
import { getParentTargetForThread } from "./seenPolicy/consumedSeqs";

/**
 * `idempotencyKey`: one key per logical prepare. Generated with
 * `randomUuid()` when omitted and returned as `data.idempotencyKey`
 * (and, on a retryable failure, as `next.args.idempotencyKey`). Repeating the
 * same request with the same key returns the first card (same `messageId`)
 * and posts nothing; the same key with a different request fails with
 * `IDEMPOTENCY_KEY_REUSED`. A key is valid for 24 hours; after that the
 * Server forgets it. Servers without keyed prepare ignore the key.
 */
export type PrepareActionCardRequest = AgentApiActionPrepareBody;

/**
 * The Agent API's own body schema (a discriminated union over the card
 * types), so the SDK checks exactly what the Server checks. The operation
 * manifest projects it flattened (see the SDK's operations.ts).
 */
export const prepareActionCardRequestSchema = agentApiActionPrepareBodySchema;

export interface RaftPreparedCard {
  target: string;
  /** The card message; a human commits it by clicking its action verb. */
  messageId: string;
  /** The key this prepare was sent with (the caller's `idempotencyKey`, or the generated one). */
  idempotencyKey: string;
}

/** Text is the CLI's `raft action prepare` output. */
export function formatAgentActionCardPosted(target: string, messageId: string | null): string {
  const shortId = messageId ? messageId.slice(0, 8) : null;
  return shortId
    ? `Action card posted to ${target} as message ${messageId} (short ${shortId}). The human can click the action verb to commit.\n`
    : `Action card posted to ${target}.\n`;
}

/**
 * Where the card's outcome arrives (Server #8604): when a human executes the
 * card, or execution fails, the Server posts a system reply that @mentions
 * the preparer in the card's own thread; a card posted inside a thread has no
 * thread of its own, so the reply lands in that same thread.
 */
function awaitConfirmationNext(target: string, messageId: string, style: RaftHintStyle): RaftNextStep {
  const short = messageId.slice(0, 8);
  if (getParentTargetForThread(target) !== null) {
    return hintStep(
      "await_confirmation",
      RAFT_HINTS.messageRead({ target, around: { shown: short, id: messageId } }),
      "A human must click the card to commit it. When it is executed (or fails), the outcome arrives as a reply in this thread that @mentions you; you do not need to poll.",
      style,
      { target, around: messageId, messageId },
    );
  }
  const thread = agentTaskThreadTarget(target, messageId);
  return hintStep(
    "await_confirmation",
    RAFT_HINTS.messageRead({ target: thread }),
    "A human must click the card to commit it. When it is executed (or fails), the outcome arrives as a reply in the card's thread that @mentions you; you do not need to poll.",
    style,
    { target: thread, messageId },
  );
}

export async function prepareActionCard(
  client: Pick<AgentApiClient, "actions">,
  request: PrepareActionCardRequest,
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftPreparedCard, "prepared">> {
  if (typeof request?.target !== "string" || !request.target.trim() || !request.action) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "A target and an action are required to prepare a card." }));
  }
  const invalid = validateOpRequest(prepareActionCardRequestSchema, request); if (invalid) return invalid;
  // One key per logical prepare (generated when omitted): a repeat with the
  // same key and request returns the same card instead of posting another.
  // Never retried here: Servers without keyed prepare ignore the key.
  const idempotencyKey = request.idempotencyKey?.trim() || randomUuid();
  const result = await client.actions.prepare({ ...request, idempotencyKey });
  if (!result.ok) return keyedWriteFailure(failureFromClientResult(result), idempotencyKey);
  const card: RaftPreparedCard = { target: request.target, messageId: result.data.messageId, idempotencyKey };
  return {
    ok: true,
    state: "prepared",
    data: card,
    next: awaitConfirmationNext(request.target, card.messageId, options.hints ?? "cli"),
    text: formatAgentActionCardPosted(request.target, card.messageId),
  };
}
