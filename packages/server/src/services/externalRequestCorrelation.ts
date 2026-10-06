// Cross-system correlation for Raft's outbound calls to external agent
// infrastructure (the hosted runtime provider client and the external agent
// inbox push notice). Raft sends its active trace id as `X-Raft-Trace-Id`, and
// records the receiver's own request id (when it echoes one) on the span, so an
// incident can be followed from a Raft trace to the provider's logs and back.
import { getCurrentTraceContext } from "../tracing/semanticTrace";

export const RAFT_TRACE_ID_HEADER = "x-raft-trace-id";

/** Response headers that carry the receiver's request id, most specific first. */
export const RESPONSE_REQUEST_ID_HEADERS = ["x-antiproton-request-id", "x-request-id", "cf-ray"] as const;

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const INVALID_TRACE_ID = "0".repeat(32);
const MAX_REQUEST_ID_CHARS = 128;
const REQUEST_ID_RE = /^[\x21-\x7e]+$/;

/** The active trace id (W3C, 32 hex), or null outside a traced span. */
export function currentRaftTraceId(): string | null {
  const traceId = getCurrentTraceContext()?.traceId;
  return traceId && TRACE_ID_RE.test(traceId) && traceId !== INVALID_TRACE_ID ? traceId : null;
}

/** `{ "x-raft-trace-id": <trace id> }` when a trace is active, otherwise `{}`. */
export function raftTraceIdHeaders(traceId: string | null = currentRaftTraceId()): Record<string, string> {
  return traceId ? { [RAFT_TRACE_ID_HEADER]: traceId } : {};
}

/**
 * The receiver's request id from its response headers, or null. Only a bounded
 * printable token is kept: it is a correlation handle, never free text.
 */
export function responseRequestId(getHeader: (name: string) => string | null | undefined): string | null {
  for (const name of RESPONSE_REQUEST_ID_HEADERS) {
    const value = getHeader(name)?.trim();
    if (value && value.length <= MAX_REQUEST_ID_CHARS && REQUEST_ID_RE.test(value)) return value;
  }
  return null;
}
