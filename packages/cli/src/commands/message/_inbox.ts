// Shared inbox-drain helper for `message check`. The CLI consumes the id-less
// /internal/agent-api/events surface directly.
//
// Acknowledgement: a self-hosted runner (External Agent credential) asks for
// cursor acks (`ack=cursor`): each batch is acknowledged by the NEXT request,
// which passes the previous `last_seen_seq` as `since`, so a response lost in
// transit is delivered again rather than acknowledged unseen. The drain keeps
// going until a request acknowledges everything and returns nothing new.
// Servers without cursor acks answer without `ack_mode: "cursor"` and have
// already acknowledged the batch; the drain then keeps `since=latest` (a
// numeric `since` is a filter there). Managed runners go through the daemon
// and keep the immediate ack.

import {
  AGENT_API_EVENTS_ACK_HEADER,
  AGENT_API_EVENTS_ACK_LEASE,
  type AgentApiEventsResponse,
  type AgentApiRequestQueryByRoute,
} from "@botiverse/raft-shared";

import type { AgentContext } from "../../auth/env";

import { buildAgentApiEventsPath, createAgentApiSurfaceClient } from "../../agentApiPath";
import { ApiClient } from "../../client";
import { CliError } from "../../core/errors";

interface InboxMessage {
  seq?: number;
  [key: string]: unknown;
}

export interface InboxHint {
  unread_conversations: number;
}

/** Task #178: a batch of third-party app events the daemon leased to this drain. */
export interface ThirdPartyEventLease {
  batchId: string;
  eventIds: string[];
}

export interface DrainResult {
  messages: InboxMessage[];
  /** Conversations still unread beyond what was returned (from the last round that reported it). */
  inboxHint?: InboxHint;
  drainedMore?: boolean;
  hasMore?: boolean;
  drainComplete?: boolean;
  /** Task #178: leases to ack on the daemon once the rendered bodies reached stdout. */
  thirdPartyLeases?: ThirdPartyEventLease[];
}

export interface DrainOpts {
  block: boolean;
  timeoutMs?: number;
}

// Safety ceiling for the drain-to-completion loop: 50 rounds x server batch
// size is far beyond any real backlog; the cap only guards against a server
// bug that reports has_more=true forever.
const MAX_DRAIN_ROUNDS = 50;

function sortedMessages(messages: InboxMessage[]): InboxMessage[] {
  return [...messages].sort((a, b) => {
    const aSeq = typeof a.seq === "number" && Number.isInteger(a.seq) && a.seq > 0 ? a.seq : Number.MAX_SAFE_INTEGER;
    const bSeq = typeof b.seq === "number" && Number.isInteger(b.seq) && b.seq > 0 ? b.seq : Number.MAX_SAFE_INTEGER;
    return aSeq - bSeq;
  });
}

function result(
  messages: InboxMessage[],
  opts: {
    drainedMore?: boolean;
    hasMore?: boolean;
    drainComplete?: boolean;
    inboxHint?: InboxHint | null;
    thirdPartyLeases?: ThirdPartyEventLease[];
  } = {},
): DrainResult {
  return {
    messages: sortedMessages(messages),
    ...(opts.inboxHint ? { inboxHint: opts.inboxHint } : {}),
    ...(opts.drainedMore ? { drainedMore: true } : {}),
    ...(opts.hasMore ? { hasMore: true } : {}),
    ...(opts.drainComplete ? { drainComplete: true } : {}),
    ...(opts.thirdPartyLeases && opts.thirdPartyLeases.length > 0 ? { thirdPartyLeases: opts.thirdPartyLeases } : {}),
  };
}

function leaseFromEventsResponse(data: AgentApiEventsResponse | null | undefined): ThirdPartyEventLease | null {
  const lease = data?.third_party_lease;
  if (!lease || typeof lease.batch_id !== "string" || !lease.batch_id) return null;
  const eventIds = Array.isArray(lease.event_ids) ? lease.event_ids.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  return eventIds.length > 0 ? { batchId: lease.batch_id, eventIds } : null;
}

export async function drainInbox(
  ctx: AgentContext,
  opts: DrainOpts,
  client: ApiClient = new ApiClient(ctx),
): Promise<DrainResult> {
  const failCode = opts.block ? "WAIT_FAILED" : "CHECK_FAILED";
  const agentApi = createAgentApiSurfaceClient(client);
  const allMessages: InboxMessage[] = [];
  let sawHasMore = false;
  let inboxHint: InboxHint | null = null;

  const requestCursorAck = ctx.clientMode === "self-hosted-runner";
  // Task #178: a managed runner's /events is answered by the daemon Local
  // Inbox. Declare that this drain will ack leased third-party events after
  // output; `message check` performs that ack. The header is sent only here,
  // on the same path that acks, so the daemon never sees "declared, not acked".
  const leaseThirdPartyAck = ctx.clientMode === "managed-runner";
  const leases: ThirdPartyEventLease[] = [];
  // The cursor to pass back as `since`, once the server confirmed cursor acks.
  let cursor: string | null = null;

  for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
    const sentCursor: string | null = cursor;
    const query: AgentApiRequestQueryByRoute["events"] = requestCursorAck
      ? { since: sentCursor ?? "latest", ack: "cursor" }
      : { since: "latest" };
    const res = leaseThirdPartyAck
      ? await client.request<AgentApiEventsResponse>("GET", buildAgentApiEventsPath(query), undefined, {
          headers: { [AGENT_API_EVENTS_ACK_HEADER]: AGENT_API_EVENTS_ACK_LEASE },
        })
      : await agentApi.events.get(query);
    if (!res.ok) {
      if (allMessages.length > 0) {
        return result(allMessages, { drainedMore: sawHasMore, hasMore: true, inboxHint, thirdPartyLeases: leases });
      }
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : failCode,
        message: res.error ?? `HTTP ${res.status}`,
      });
    }

    const messages = res.data?.events ?? [];
    const lease = leaseThirdPartyAck ? leaseFromEventsResponse(res.data) : null;
    if (lease) leases.push(lease);
    const hint = res.data?.inbox_hint;
    inboxHint = hint && typeof hint.unread_conversations === "number" && hint.unread_conversations > 0
      ? { unread_conversations: hint.unread_conversations }
      : null;
    allMessages.push(...messages);
    const hasMore = res.data?.has_more === true;
    const drainComplete = !hasMore && allMessages.length > 0;
    sawHasMore = sawHasMore || hasMore;

    if (requestCursorAck && res.data?.ack_mode === "cursor") {
      const lastSeenSeq = res.data?.last_seen_seq;
      cursor = typeof lastSeenSeq === "number" && Number.isInteger(lastSeenSeq) && lastSeenSeq >= 0
        ? String(lastSeenSeq)
        : sentCursor;
      // Continue until one request returns nothing and leaves nothing pending:
      // that request acknowledged the previous batch.
      if (messages.length > 0 || cursor !== sentCursor) continue;
      return result(allMessages, {
        drainedMore: sawHasMore,
        hasMore,
        drainComplete: !hasMore && allMessages.length > 0,
        inboxHint,
        thirdPartyLeases: leases,
      });
    }

    if (hasMore && messages.length > 0) continue;
    return result(allMessages, { drainedMore: sawHasMore, hasMore, drainComplete, inboxHint, thirdPartyLeases: leases });
  }

  return result(allMessages, { drainedMore: sawHasMore, hasMore: true, inboxHint, thirdPartyLeases: leases });
}
