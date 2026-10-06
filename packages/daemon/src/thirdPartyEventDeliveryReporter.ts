// Task #175: third-party app events have no durable inbox row, so the server
// keeps each one `queued`/`delivering` until something confirms the agent
// received it, and re-delivers it until then. For a managed runner the daemon
// answers `/internal/agent-api/events` from its Local Inbox and never forwards
// that request, so the server never saw the confirmation. After the daemon has
// written such a response to the runtime, it reports the third-party event ids
// in that response here.
//
// A report that fails is kept and retried (with backoff, and again on the next
// report). The server applies it idempotently by id, so a retry that follows a
// lost success response is harmless. Pending reports live in daemon memory: a
// daemon restart before a report lands leaves the events `delivering`, and the
// server re-delivers them once. That is a duplicate, never a loss.

import {
  THIRD_PARTY_EVENT_DELIVERED_REPORT_MAX_IDS,
  isThirdPartyEventId,
  normalizeThirdPartyEventId,
} from "@botiverse/raft-shared";

const REPORT_PATH = "/internal/agent-api/third-party-events/delivered";
/** Bounds memory while the server is unreachable; dropped ids are re-delivered, not lost. */
const PENDING_MAX_IDS_PER_AGENT = 1000;
const RETRY_MAX_MS = 5 * 60_000;

export type ThirdPartyEventDeliveryReportTarget = {
  serverUrl: string;
  apiKey: string;
};

export type ThirdPartyEventDeliveryReportOutcome = {
  agentId: string;
  outcome: "reported" | "retry_scheduled" | "rejected" | "pending_overflow";
  eventCount: number;
  httpStatus?: number;
  pendingCount: number;
};

type AgentReportState = {
  pending: Set<string>;
  inFlight: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  failures: number;
};

export type ThirdPartyEventDeliveryReporter = {
  report(agentId: string, eventIds: readonly string[]): void;
  pendingEventIds(agentId: string): string[];
  reset(): void;
};

export function createThirdPartyEventDeliveryReporter(deps: {
  /** The agent's current server credential; null while it has no live registration. */
  resolveTarget(agentId: string): ThirdPartyEventDeliveryReportTarget | null;
  fetch(url: URL, init: RequestInit): Promise<Response>;
  retryBaseMs: () => number;
  onOutcome?(outcome: ThirdPartyEventDeliveryReportOutcome): void;
}): ThirdPartyEventDeliveryReporter {
  const states = new Map<string, AgentReportState>();

  const stateFor = (agentId: string): AgentReportState => {
    let state = states.get(agentId);
    if (!state) {
      state = { pending: new Set(), inFlight: false, timer: null, failures: 0 };
      states.set(agentId, state);
    }
    return state;
  };

  const scheduleRetry = (agentId: string, state: AgentReportState): void => {
    if (state.timer) return;
    state.failures += 1;
    const delay = Math.min(deps.retryBaseMs() * 2 ** (state.failures - 1), RETRY_MAX_MS);
    state.timer = setTimeout(() => {
      state.timer = null;
      void flush(agentId);
    }, delay);
    state.timer.unref?.();
  };

  const flush = async (agentId: string): Promise<void> => {
    const state = states.get(agentId);
    if (!state || state.inFlight || state.pending.size === 0) return;
    const target = deps.resolveTarget(agentId);
    if (!target) {
      scheduleRetry(agentId, state);
      deps.onOutcome?.({ agentId, outcome: "retry_scheduled", eventCount: state.pending.size, pendingCount: state.pending.size });
      return;
    }
    const batch = [...state.pending].slice(0, THIRD_PARTY_EVENT_DELIVERED_REPORT_MAX_IDS);
    state.inFlight = true;
    let httpStatus: number | undefined;
    try {
      const res = await deps.fetch(new URL(REPORT_PATH, target.serverUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${target.apiKey}`,
          "Content-Type": "application/json",
          "X-Agent-Id": agentId,
          "X-Raft-Client": "daemon",
        },
        body: JSON.stringify({ eventIds: batch }),
      });
      httpStatus = res.status;
      await res.arrayBuffer().catch(() => undefined);
    } catch {
      httpStatus = undefined;
    } finally {
      state.inFlight = false;
    }

    if (httpStatus !== undefined && httpStatus >= 200 && httpStatus < 300) {
      for (const id of batch) state.pending.delete(id);
      state.failures = 0;
      deps.onOutcome?.({ agentId, outcome: "reported", eventCount: batch.length, httpStatus, pendingCount: state.pending.size });
    } else if (httpStatus === 400) {
      // The server will never accept this batch; retrying it would pin the
      // queue. Its events stay `delivering` and are re-delivered once.
      for (const id of batch) state.pending.delete(id);
      deps.onOutcome?.({ agentId, outcome: "rejected", eventCount: batch.length, httpStatus, pendingCount: state.pending.size });
    } else {
      scheduleRetry(agentId, state);
      deps.onOutcome?.({ agentId, outcome: "retry_scheduled", eventCount: batch.length, httpStatus, pendingCount: state.pending.size });
      return;
    }
    if (state.pending.size > 0 && !state.timer) void flush(agentId);
  };

  return {
    report(agentId, eventIds) {
      const ids = eventIds.filter(isThirdPartyEventId).map(normalizeThirdPartyEventId);
      if (ids.length === 0) return;
      const state = stateFor(agentId);
      for (const id of ids) state.pending.add(id);
      let dropped = 0;
      for (const id of state.pending) {
        if (state.pending.size <= PENDING_MAX_IDS_PER_AGENT) break;
        state.pending.delete(id);
        dropped += 1;
      }
      if (dropped > 0) {
        deps.onOutcome?.({ agentId, outcome: "pending_overflow", eventCount: dropped, pendingCount: state.pending.size });
      }
      // A new report is also the retry trigger for anything still pending.
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      void flush(agentId);
    },
    pendingEventIds(agentId) {
      return [...(states.get(agentId)?.pending ?? [])];
    },
    reset() {
      for (const state of states.values()) {
        if (state.timer) clearTimeout(state.timer);
      }
      states.clear();
    },
  };
}

/** Third-party event ids carried by an `/events` response body's `events`. */
export function thirdPartyEventIdsFromEvents(events: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const event of events) {
    const id = (event as { third_party_event?: { id?: unknown } | null } | null)?.third_party_event?.id;
    if (typeof id === "string" && id.length > 0) ids.push(id);
  }
  return ids;
}
