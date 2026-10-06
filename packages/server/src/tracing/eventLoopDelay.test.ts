import assert from "node:assert/strict";
import { test } from "vitest";
import { BasicTracer, type TraceLogEvent } from "@botiverse/raft-shared";
import { startEventLoopDelaySampler, toSample } from "./eventLoopDelay";

test("toSample converts nanoseconds to rounded milliseconds", () => {
  const sample = toSample(
    { percentile: (p) => (p === 50 ? 1_234_567 : 98_765_432), max: 250_000_000, mean: 2_500_000 },
    { utilization: 0.73456 },
    10_000,
  );
  assert.deepEqual(sample, {
    interval_ms: 10_000,
    delay_p50_ms: 1.2,
    delay_p99_ms: 98.8,
    delay_max_ms: 250,
    delay_mean_ms: 2.5,
    utilization: 0.735,
  });
});

test("the sampler emits one server.event_loop.delay event per interval", async () => {
  const events: TraceLogEvent[] = [];
  const tracer = new BasicTracer({ sink: { record: () => undefined, recordLogEvent: (event) => { events.push(event); } } });
  const stop = startEventLoopDelaySampler(tracer, 30);
  await new Promise((resolve) => setTimeout(resolve, 100));
  stop();
  assert.ok(events.length >= 2, `got ${events.length} events`);
  const event = events[0]!;
  assert.equal(event.name, "server.event_loop.delay");
  assert.equal(event.surface, "server");
  for (const key of ["delay_p50_ms", "delay_p99_ms", "delay_max_ms", "delay_mean_ms", "utilization"]) {
    assert.equal(typeof event.attrs?.[key], "number", key);
  }
});
