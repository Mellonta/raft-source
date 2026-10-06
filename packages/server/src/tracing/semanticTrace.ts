import { AsyncLocalStorage } from "node:async_hooks";
import {
  createScopedTracer,
  currentTimeMs,
  errorClassOf,
  noopTracer,
  type ActiveSpan,
  type StartSpanOptions,
  type TraceAttributes,
  type TraceContext,
  type Tracer,
} from "@botiverse/raft-shared";
import { getActiveSpan, runWithActiveSpan } from "@botiverse/raft-trace-client";
import type { DbQueryTracer } from "./dbQueryTrace";
import { queryFailureDiagnostics, timeoutBucket } from "./queryTrace";

// The active span itself lives in the one node-side store shared with the
// daemon (`@botiverse/raft-trace-client`), so code that runs in-process on
// either side sees the same parent. The server additionally carries the
// tracer of the current request beside it, so deep service code can open an
// exact child span without threading a tracer through every signature.
const activeTracerStore = new AsyncLocalStorage<Tracer>();

export function runWithTraceSpan<T>(span: ActiveSpan, work: () => T, tracer?: Tracer): T {
  const activeTracer = tracer ?? activeTracerStore.getStore();
  return activeTracer
    ? activeTracerStore.run(activeTracer, () => runWithActiveSpan(span, work))
    : runWithActiveSpan(span, work);
}

/**
 * Add attrs to every span opened by `work` in the current request, for
 * identity that is only known mid-request (e.g. after credential auth). The
 * already-open request span is unaffected; it stamps its own attrs at end.
 * Outside an instrumented request this just runs `work`.
 */
export function runWithTraceAttrs<T>(attrs: TraceAttributes, work: () => T): T {
  const tracer = activeTracerStore.getStore();
  const span = getCurrentTraceSpan();
  if (!tracer || !span || !Object.keys(attrs).length) return work();
  return runWithTraceSpan(span, work, createScopedTracer(tracer, attrs, { attrPrecedence: "caller" }));
}

export function getCurrentTraceSpan(): ActiveSpan | null {
  return getActiveSpan();
}

export function getCurrentTraceContext(): TraceContext | null {
  return getCurrentTraceSpan()?.context ?? null;
}

/**
 * Record a point in time fact as a standalone trace event. It is attached to
 * the active span when there is one, and uses the tracer of the current
 * request. Outside an instrumented request it uses the fallback tracer when
 * one is given, and does nothing otherwise.
 */
export function recordTraceEvent(name: string, attrs?: TraceAttributes, fallbackTracer?: Tracer): void {
  const tracer = activeTracerStore.getStore() ?? fallbackTracer ?? noopTracer;
  tracer.emitEvent(name, {
    surface: "server",
    attrs,
    parent: getCurrentTraceContext(),
  });
}

/**
 * Run work in a new root span. The span starts before the work and ends after
 * it. When errorEventName is set, a failure also records that trace event
 * inside the span with the span start attrs, so failures stay searchable by
 * their old name.
 */
export async function withTraceRoot<T>(
  tracer: Tracer | null | undefined,
  name: string,
  options: StartSpanOptions,
  work: () => Promise<T>,
  errorEventName?: string,
): Promise<T> {
  const activeTracer = tracer ?? noopTracer;
  const span = activeTracer.startSpan(name, options);
  try {
    const result = await runWithTraceSpan(span, work, activeTracer);
    span.end("ok");
    return result;
  } catch (error) {
    const errorClass = errorClassOf(error);
    if (errorEventName) {
      activeTracer.emitEvent(errorEventName, {
        surface: options.surface,
        parent: span.context,
        attrs: { ...options.attrs, outcome: "error", error_class: errorClass },
      });
    }
    span.end("error", { attrs: { error_class: errorClass } });
    throw error;
  }
}

export interface TraceChildSpanOutcome<T> {
  onSuccess?: (result: T) => TraceAttributes;
  onError?: (error: unknown) => TraceAttributes;
}

/**
 * Run work in a real child span of the active request span.
 *
 * The tracer is carried beside the active span in AsyncLocalStorage so deep
 * service code can create an exact query/decision boundary without threading
 * an Express request or tracer through every service signature. When invoked
 * outside an instrumented request this is a no-op span, preserving behavior.
 */
export async function withTraceChildSpan<T>(
  name: string,
  options: Omit<StartSpanOptions, "parent">,
  work: () => Promise<T>,
  outcome: TraceChildSpanOutcome<T> = {},
): Promise<T> {
  const tracer = activeTracerStore.getStore() ?? noopTracer;
  const startedAt = currentTimeMs();
  const span = tracer.startSpan(name, {
    ...options,
    parent: getCurrentTraceContext(),
  });
  try {
    const result = await runWithTraceSpan(span, work, tracer);
    span.end("ok", {
      attrs: {
        duration_ms: currentTimeMs() - startedAt,
        ...outcome.onSuccess?.(result),
      },
    });
    return result;
  } catch (error) {
    span.end("error", {
      attrs: {
        duration_ms: currentTimeMs() - startedAt,
        error_class: errorClassOf(error),
        ...outcome.onError?.(error),
      },
    });
    throw error;
  }
}

export function addTraceEvent(name: string, attrs?: TraceAttributes): void {
  getCurrentTraceSpan()?.addEvent(name, attrs);
}

export async function tracePhase<T>(
  work: () => Promise<T>,
  onComplete: (durationMs: number, result: T) => { name: string; attrs?: TraceAttributes },
): Promise<T> {
  const start = Date.now();
  const result = await work();
  const durationMs = Date.now() - start;
  const event = onComplete(durationMs, result);
  addTraceEvent(event.name, {
    duration_ms: durationMs,
    ...event.attrs,
  });
  return result;
}

/**
 * Every current call site wraps the PG pool, so dbSystem defaults to
 * "postgresql". RisingWave never flows through this wrapper (RW uses
 * queryRisingWave + risingWaveInboxTrace); a future non-PG caller must pass
 * dbSystem explicitly.
 */
export function createTraceDbQueryTracer(
  phase: string,
  options: { dbSystem?: string } = {},
): DbQueryTracer {
  const dbSystem = options.dbSystem ?? "postgresql";
  return async (queryName, work, onComplete, onError) => {
    const start = Date.now();
    try {
      const result = await work();
      const duration = Date.now() - start;
      safeAddTraceEvent("db.query.finished", () => ({
        event_kind: "db_query",
        outcome: "success",
        reason: "query_completed",
        query_name: queryName,
        phase,
        duration_ms: duration,
        db_system: dbSystem,
        timeout_bucket: timeoutBucket(duration),
        ...inferRowCount(result),
        ...onComplete?.(result),
      }));
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      safeAddTraceEvent("db.query.failed", () => ({
        event_kind: "db_query",
        outcome: "error",
        reason: "query_failed",
        query_name: queryName,
        phase,
        duration_ms: duration,
        error_class: errorClassOf(error),
        db_system: dbSystem,
        ...queryFailureDiagnostics(error, duration),
        ...onError?.(error),
      }));
      throw error;
    }
  };
}

export const traceAttrs = {
  count(name: string, count: number): TraceAttributes {
    return { [`${name}_count`]: count };
  },
  present(name: string, value: unknown): TraceAttributes {
    return { [`${name}_present`]: Boolean(value) };
  },
  error(error: unknown): TraceAttributes {
    return { error_class: errorClassOf(error) };
  },
};

/**
 * Bounded classification for an unknown throw. Canonical definition lives in
 * @botiverse/raft-shared (tracing/index.ts); re-exported here so existing
 * server-internal imports keep working.
 */
export { errorClassOf };

export function safeAddTraceEvent(name: string, getAttrs: () => TraceAttributes): void {
  try {
    addTraceEvent(name, getAttrs());
  } catch (error) {
    console.warn(`[Tracing] Failed to record trace event ${name}:`, error);
  }
}

function inferRowCount(result: unknown): TraceAttributes {
  if (Array.isArray(result)) return { row_count: result.length };
  if (result instanceof Map || result instanceof Set) return { row_count: result.size };
  return {};
}
