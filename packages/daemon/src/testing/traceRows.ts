import type {
  CompletedTraceSpan,
  MemoryTraceSink,
  TraceStatus,
  TraceLogEvent,
} from "@botiverse/raft-shared";

const TRACE_STATUSES: readonly string[] = ["ok", "error", "cancelled", "unset"];

// Test view of everything a tracer recorded: closed spans plus point events.
// An event is shown with the same shape as a span, so assertions can read
// name, status and attrs the same way. The event status comes from attrs.status.
export function traceRows(sink: MemoryTraceSink, traceId?: string): CompletedTraceSpan[] {
  const spans = sink.getAllSpans().filter((span) => traceId === undefined || span.context.traceId === traceId);
  const events = sink.getAllLogEvents()
    // An event without a parent has no trace id, so it belongs to every trace here.
    .filter((event) => traceId === undefined || !event.context || event.context.traceId === traceId)
    .map(eventAsRow);
  return [...spans, ...events];
}

function eventAsRow(event: TraceLogEvent): CompletedTraceSpan {
  const status = event.attrs?.status;
  return {
    // The event is shown as a child of its parent span.
    context: {
      traceId: event.context?.traceId ?? "",
      spanId: "",
      parentSpanId: event.context?.spanId ?? null,
      traceFlags: event.context?.traceFlags ?? "00",
    },
    name: event.name,
    surface: event.surface,
    kind: "internal",
    status: typeof status === "string" && TRACE_STATUSES.includes(status) ? status as TraceStatus : "ok",
    startTimeMs: event.timeMs,
    endTimeMs: event.timeMs,
    durationMs: 0,
    ...(event.attrs ? { attrs: event.attrs } : {}),
    events: [],
  };
}
