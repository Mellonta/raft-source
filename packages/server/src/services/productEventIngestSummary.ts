import { privacyModeEnabled } from "@botiverse/raft-shared/src/privacyMode";
// What became of RFC-067 product events on this replica, in otel.logs.
//
// The per-outcome counter (slock_product_event_ingest_total) is only in AMP,
// which the analytics and o11y owners cannot read. Production had zero rows in
// product.events and nobody could tell "nobody shares" or "flag off" from "no
// store" (AndyLok, Tenny 2026-10-15). So the same counts also go to the trace
// store: one event at startup naming the env pair the writer uses, then one
// event per outcome per window. Counts only, never ids or keys.

import type { Tracer } from "@botiverse/raft-shared";
import type { ProductScopeDbStore } from "./productEventScopeDbWriter";

export const PRODUCT_EVENT_SUMMARY_INTERVAL_MS = 10 * 60_000;

const pending = new Map<string, number>();
let summary: { tracer: Tracer; store: ProductScopeDbStore; windowStartMs: number; timer: NodeJS.Timeout | null } | null = null;

/** Called beside every slock_product_event_ingest_total increment. */
export function noteProductEventOutcome(outcome: string, count: number): void {
  if (count > 0 && summary) pending.set(outcome, (pending.get(outcome) ?? 0) + count);
}

/**
 * `server.product_events.store` once, then every interval one
 * `server.product_events.outcome` per outcome seen in the window (none when
 * nothing happened). A replica that stops loses at most one window: lower
 * bounds, like the counter.
 */
export function startProductEventIngestSummary(
  tracer: Tracer,
  store: ProductScopeDbStore,
  options: { intervalMs?: number; now?: () => number } = {},
): void {
  if (privacyModeEnabled() || summary) return;
  const now = options.now ?? Date.now;
  summary = { tracer, store, windowStartMs: now(), timer: null };
  tracer.emitEvent("server.product_events.store", { surface: "server", attrs: { store } });
  summary.timer = setInterval(() => flushProductEventIngestSummary(now()), options.intervalMs ?? PRODUCT_EVENT_SUMMARY_INTERVAL_MS);
  summary.timer.unref?.();
}

export function flushProductEventIngestSummary(nowMs: number = Date.now()): void {
  if (!summary) return;
  const windowS = Math.max(0, Math.round((nowMs - summary.windowStartMs) / 1000));
  for (const [outcome, count] of pending) {
    summary.tracer.emitEvent("server.product_events.outcome", {
      surface: "server",
      attrs: { outcome, count, window_s: windowS, store: summary.store },
    });
  }
  pending.clear();
  summary.windowStartMs = nowMs;
}

/** Test-only. */
export function resetProductEventIngestSummaryForTest(): void {
  if (summary?.timer) clearInterval(summary.timer);
  summary = null;
  pending.clear();
}
