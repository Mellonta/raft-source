import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";

// Test tracer with a fixed trace id and unique, predictable span ids.
//
// Every span must get its own id: events are attached to a span by
// (traceId, spanId), so two spans sharing an id make one span's events show up
// under the other. A fixed short id list that falls back to one repeated id
// causes exactly that once a flow records more spans than the list is long.
export function makeDeterministicTracer() {
  let spanIndex = 0;
  const traceId = "1".repeat(32);
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => traceId,
    spanIdGenerator: () => (++spanIndex).toString(16).padStart(16, "0"),
  });
  return { sink, tracer, traceId };
}
