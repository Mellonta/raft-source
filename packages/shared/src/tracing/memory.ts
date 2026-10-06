import type { CompletedTraceSpan, TraceLogEvent, TraceSink } from "./index";

export class MemoryTraceSink implements TraceSink {
  private readonly spans: CompletedTraceSpan[] = [];
  private readonly logEvents: TraceLogEvent[] = [];

  record(span: CompletedTraceSpan): void {
    this.spans.push(span);
  }

  recordLogEvent(event: TraceLogEvent): void {
    this.logEvents.push(event);
  }

  clear(): void {
    this.spans.length = 0;
    this.logEvents.length = 0;
  }

  getTrace(traceId: string): readonly CompletedTraceSpan[] {
    return this.spans.filter((span) => span.context.traceId === traceId);
  }

  getAllSpans(): readonly CompletedTraceSpan[] {
    return this.spans;
  }

  getAllLogEvents(): readonly TraceLogEvent[] {
    return this.logEvents;
  }
}
