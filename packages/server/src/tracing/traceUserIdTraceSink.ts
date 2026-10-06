import type {
  CompletedTraceSpan,
  TraceAttributes,
  TraceEventRecord,
  TraceLogEvent,
  TraceSink,
  TraceSpanFactRecord,
} from "@botiverse/raft-shared";
import { cachedTraceUserId } from "./traceUserId";

// Traces are kept indefinitely, so a raw user id in them would tie every trace
// (and whatever joins to it, such as product events through a client session)
// to the account for good. Several call sites record `user_id` (the HTTP
// request scope, auth session and refresh events, push registration events);
// rather than trust each one, the exporting sink replaces it with the user's
// random `trace_user_id` (users.trace_user_id) on every span, span event and
// log event. When the value isn't cached yet the attribute is dropped and the
// value is loaded for later spans; the raw id is never exported.
function replaceUserId(attrs: TraceAttributes | undefined): TraceAttributes | undefined {
  if (!attrs || !Object.hasOwn(attrs, "user_id")) return attrs;
  const { user_id: userId, ...rest } = attrs;
  const traceUserId = typeof userId === "string" && userId ? cachedTraceUserId(userId) : undefined;
  return traceUserId ? { ...rest, trace_user_id: traceUserId } : rest;
}

function withAttrs<T extends { attrs?: TraceAttributes }>(item: T): T {
  const attrs = replaceUserId(item.attrs);
  return attrs === item.attrs ? item : { ...item, attrs };
}

function completedSpan(span: CompletedTraceSpan): CompletedTraceSpan {
  const replaced = withAttrs(span);
  let eventsChanged = false;
  const events = span.events.map((event) => {
    const next = withAttrs(event);
    if (next !== event) eventsChanged = true;
    return next;
  });
  return eventsChanged ? { ...replaced, events } : replaced;
}

export class TraceUserIdTraceSink implements TraceSink {
  constructor(private readonly sink: TraceSink) {}

  record(span: CompletedTraceSpan): void {
    this.sink.record(completedSpan(span));
  }

  recordEvent(record: TraceEventRecord): void {
    this.sink.recordEvent?.({ ...record, span: withAttrs(record.span), event: withAttrs(record.event) });
  }

  recordSpanFact(record: TraceSpanFactRecord): void {
    this.sink.recordSpanFact?.({ ...record, span: completedSpan(record.span) });
  }

  recordLogEvent(event: TraceLogEvent): void {
    this.sink.recordLogEvent?.(withAttrs(event));
  }
}
