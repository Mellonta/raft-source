// @botiverse/raft-trace-client — shared trace-client primitives for node-side
// callers (daemon, Computer CLI, menu-bar). Houses node-only Sink
// implementations and a thin `createTraceClient` factory; canonical
// types (Tracer, TraceSink, TraceEvent, etc.) continue to live in
// @botiverse/raft-shared/tracing where they're web-bundle-safe.

export {
  getActiveSpan,
  getActiveTraceContext,
  runWithActiveSpan,
  runWithoutActiveSpan,
} from "./activeSpan";
export {
  LocalRotatingTraceSink,
  type LocalRotatingTraceSinkOptions,
} from "./localTraceSink";
export {
  LEGACY_TO_CANONICAL_TRACE_ATTRS,
  withCanonicalTraceAttributes,
} from "./traceAttributeAliases";
export {
  bucketDelayMs,
  computeTraceJitter,
  NO_JITTER,
  type TraceJitter,
} from "./traceJitter";
export {
  createTraceClient,
  type TraceClient,
  type TraceClientOptions,
  type TraceClientEmitEventOptions,
  type TraceClientSource,
  MultiSink,
} from "./traceClient";
