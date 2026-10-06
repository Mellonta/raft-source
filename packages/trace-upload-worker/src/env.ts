// Runtime environment and the minimal R2-shaped storage interface the handlers use.
import type { ScopeDbTraceEventProjectorClient } from "./traces/traceEventProjector";

type R2PutValue = ArrayBuffer | ArrayBufferView | string | ReadableStream;

interface R2PutOptions {
  httpMetadata?: {
    contentType?: string;
    contentEncoding?: string;
  };
  customMetadata?: Record<string, string>;
}

interface R2PutResult {
  etag?: string;
}

interface R2ObjectLike {
  body: ReadableStream | null;
  httpMetadata?: {
    contentType?: string;
    contentEncoding?: string;
  };
  customMetadata?: Record<string, string>;
}

interface R2BucketLike {
  put(key: string, value: R2PutValue, options?: R2PutOptions): Promise<R2PutResult | null | undefined>;
  get?(key: string): Promise<R2ObjectLike | null>;
}

export interface TraceUploadRuntimeEnv {
  SCOPE_ATTESTATION_SECRET: string;
  TRACE_UPLOAD_WORKER_SECRET?: string;
  TRACE_UPLOAD_MAX_BYTES?: string;
  TRACE_INGEST_OTLP_ENDPOINT?: string;
  TRACE_INGEST_OTLP_AUTHORIZATION?: string;
  TRACE_INGEST_SERVICE_NAME?: string;
  TRACE_INGEST_BATCH_SIZE?: string;
  TRACE_INGEST_MAX_DECOMPRESSED_BYTES?: string;
  TRACE_INGEST_FETCH?: typeof fetch;
  RAFT_TRACE_SCOPEDB_PROJECTOR?: string;
  SCOPEDB_TRACE_EVENTS_ENDPOINT?: string;
  SCOPEDB_TRACE_EVENTS_WRITE_KEY?: string;
  /** Test-only structural injection; production constructs the SDK client. */
  SCOPEDB_TRACE_EVENTS_CLIENT?: ScopeDbTraceEventProjectorClient;
  TRACE_WEB_MAX_BYTES?: string;
  TRACE_WEB_CORS_ORIGIN?: string;
  FEEDBACK_REPORT_MAX_BYTES?: string;
  FEEDBACK_REPORT_HOURLY_LIMIT?: string;
  DEPLOYMENT_ENV?: string;
  SLOCK_RELEASE_SHA?: string;
}

export interface TraceUploadWorkerEnv extends TraceUploadRuntimeEnv {
  TRACE_BUNDLES: R2BucketLike;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}
