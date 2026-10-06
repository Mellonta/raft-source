import { monitorEventLoopDelay, performance, type EventLoopUtilization } from "node:perf_hooks";
import type { Tracer } from "@botiverse/raft-shared";

// Every interval, one `server.event_loop.delay` event per process: how late
// timers fired (delay percentiles) and how busy the loop was (utilization).
// A query that takes 0.04ms in Postgres but shows a 700ms hold on
// server.db.connection points at a busy loop delaying the result callback;
// these events let that be checked per instance and per minute.
export const EVENT_LOOP_SAMPLE_INTERVAL_MS = 10_000;

const NS_PER_MS = 1e6;

export interface EventLoopDelaySample {
  interval_ms: number;
  delay_p50_ms: number;
  delay_p99_ms: number;
  delay_max_ms: number;
  delay_mean_ms: number;
  utilization: number;
}

export function startEventLoopDelaySampler(
  tracer: Tracer,
  intervalMs: number = EVENT_LOOP_SAMPLE_INTERVAL_MS,
): () => void {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let lastUtilization: EventLoopUtilization = performance.eventLoopUtilization();
  const timer = setInterval(() => {
    try {
      const utilization = performance.eventLoopUtilization(lastUtilization);
      lastUtilization = performance.eventLoopUtilization();
      const sample = toSample(histogram, utilization, intervalMs);
      histogram.reset();
      tracer.emitEvent("server.event_loop.delay", { surface: "server", attrs: { ...sample } });
    } catch {
      // Sampling must never affect the process.
    }
  }, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}

export function toSample(
  histogram: { percentile(p: number): number; max: number; mean: number },
  utilization: Pick<EventLoopUtilization, "utilization">,
  intervalMs: number,
): EventLoopDelaySample {
  const round = (ns: number) => (Number.isFinite(ns) ? Math.round((ns / NS_PER_MS) * 10) / 10 : 0);
  return {
    interval_ms: intervalMs,
    delay_p50_ms: round(histogram.percentile(50)),
    delay_p99_ms: round(histogram.percentile(99)),
    delay_max_ms: round(histogram.max),
    delay_mean_ms: round(histogram.mean),
    utilization: Math.round(utilization.utilization * 1000) / 1000,
  };
}
