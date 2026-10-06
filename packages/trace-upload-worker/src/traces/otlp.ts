// Parse daemon trace bundles and forward their spans/events to Telescope as OTLP.
import type { TraceUploadWorkerEnv } from "../env";
import { sha256Hex } from "../shared/auth";
import { isJsonObject, maybeDecompressStream, readStreamWithLimit, type JsonObject } from "../shared/http";
import type { TraceBundleMetadata } from "./bundles";
import type { ProjectableTraceRecord, TraceProjectionSkipReasonClass } from "./traceEventProjector";
import {
  daemonProjectionResource,
  projectV2BestEffort,
  projectorConfigured,
  projectorDisabledByMissingCanonicalSink,
  stringAttr,
  type V2ProjectorStatus,
} from "./v2Projection";

const DEFAULT_INGEST_BATCH_SIZE = 128;

const DEFAULT_INGEST_MAX_DECOMPRESSED_BYTES = 100 * 1024 * 1024;

export type OtlpAnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

export interface LocalTraceRecord extends ProjectableTraceRecord {
  type: "span";
  schema_version: number;
  trace_id: string;
  span_id: string;
  parent_span_id?: string | null;
  name: string;
  surface: string;
  kind: string;
  status: string;
  start_time: string;
  end_time: string;
  duration_ms?: number;
  attrs?: JsonObject;
  events?: Array<{
    name: string;
    time: string;
    attrs?: JsonObject;
  }>;
}

// A standalone point in time event. It is sent as an OTLP log record, not a
// span, and is never given to the V2 projector.
export interface LocalEventRecord {
  type: "event";
  schema_version: number;
  name: string;
  surface: string;
  time: string;
  trace_id?: string;
  span_id?: string;
  attrs?: JsonObject;
}

interface KeyedEventRecord {
  record: LocalEventRecord;
  eventKey: string;
}

export class TraceBundlePinMismatchError extends Error {}

export async function readTraceBundleRecords(
  env: TraceUploadWorkerEnv,
  metadata: TraceBundleMetadata,
): Promise<{ spans: LocalTraceRecord[]; events: KeyedEventRecord[] }> {
  if (!env.TRACE_BUNDLES.get) throw new Error("TRACE_BUNDLES.get is required for ingest");

  const object = await env.TRACE_BUNDLES.get(metadata.objectKey);
  if (!object?.body) throw new Error("Trace bundle object not found");

  const contentEncoding = object.httpMetadata?.contentEncoding
    ?? object.customMetadata?.bundleContentEncoding
    ?? undefined;
  const rawBody = await readStreamWithLimit(object.body, metadata.bundleSizeBytes);
  if (rawBody.byteLength !== metadata.bundleSizeBytes) {
    throw new TraceBundlePinMismatchError("Trace bundle size does not match ledger metadata");
  }
  const actualSha256 = await sha256Hex(rawBody);
  if (actualSha256 !== metadata.bundleSha256) {
    throw new TraceBundlePinMismatchError("Trace bundle hash does not match ledger metadata");
  }
  const bytes = await readStreamWithLimit(
    maybeDecompressStream(new Response(rawBody).body!, contentEncoding),
    getConfiguredIngestMaxDecompressedBytes(env),
  );
  return parseTraceBundleRecords(new TextDecoder().decode(bytes), metadata.bundleSha256);
}

export async function ingestTraceBundleObject(
  env: TraceUploadWorkerEnv,
  metadata: TraceBundleMetadata,
  options?: { recordFilter?: (record: LocalTraceRecord) => boolean },
): Promise<{
  spans_ingested: number;
  events_ingested?: number;
  batches_sent: number;
  v2_projector_status: V2ProjectorStatus;
  v2_spans_projected: number;
  v2_rows_projected: number;
  v2_spans_skipped: number;
  v2_skip_reason_classes: readonly TraceProjectionSkipReasonClass[];
  v2_error_class?: string;
  spans_total?: number;
  events_skipped?: number;
}> {
  if (!env.TRACE_INGEST_OTLP_ENDPOINT) {
    const v2 = projectorDisabledByMissingCanonicalSink(env);
    return {
      spans_ingested: 0,
      batches_sent: 0,
      v2_projector_status: v2.status,
      v2_spans_projected: 0,
      v2_rows_projected: 0,
      v2_spans_skipped: v2.spansSkipped,
      v2_skip_reason_classes: v2.skipReasonClasses,
      ...(v2.errorClass ? { v2_error_class: v2.errorClass } : {}),
    };
  }
  const parsed = await readTraceBundleRecords(env, metadata);
  const records = options?.recordFilter ? parsed.spans.filter(options.recordFilter) : parsed.spans;
  // Replay dedup keys exist only for spans (slock.trace_ingest.span_key); events have no
  // dedup key, so a filtered (partial) replay skips events rather than risk duplicating them.
  // The skipped count is reported so the loss is visible in the run output.
  const events = options?.recordFilter ? [] : parsed.events;
  const filterStats = options?.recordFilter
    ? { spans_total: parsed.spans.length, events_skipped: parsed.events.length }
    : {};
  const batchSize = getConfiguredIngestBatchSize(env);
  let batchesSent = 0;
  let v2Status: V2ProjectorStatus = projectorConfigured(env) ? "success" : "skipped";
  let v2SpansProjected = 0;
  let v2RowsProjected = 0;
  let v2SpansSkipped = 0;
  const v2SkipReasonClasses = new Set<TraceProjectionSkipReasonClass>();
  let v2ErrorClass: string | undefined;

  for (let idx = 0; idx < records.length; idx += batchSize) {
    const batch = records.slice(idx, idx + batchSize);
    await postOtlpTraceBatch(env, batch, metadata);
    batchesSent += 1;
    const projection = await projectV2BestEffort(env, batch, daemonProjectionResource(env, metadata, records));
    v2SpansProjected += projection.spansProjected;
    v2RowsProjected += projection.rowsProjected;
    v2SpansSkipped += projection.spansSkipped;
    projection.skipReasonClasses.forEach((reason) => v2SkipReasonClasses.add(reason));
    if (projection.status === "failed") {
      v2Status = "failed";
      v2ErrorClass ??= projection.errorClass;
    } else if (projection.status === "skipped" && v2Status !== "failed") {
      v2Status = "skipped";
    }
  }

  for (let idx = 0; idx < events.length; idx += batchSize) {
    const batch = events.slice(idx, idx + batchSize);
    await postOtlpLogBatch(env, daemonResourceAttributes(env, records, metadata), "@slock-ai/daemon", batch);
    batchesSent += 1;
  }

  return {
    spans_ingested: records.length,
    ...(events.length > 0 ? { events_ingested: events.length } : {}),
    batches_sent: batchesSent,
    v2_projector_status: v2Status,
    v2_spans_projected: v2SpansProjected,
    v2_rows_projected: v2RowsProjected,
    v2_spans_skipped: v2SpansSkipped,
    v2_skip_reason_classes: [...v2SkipReasonClasses].sort(),
    ...(v2ErrorClass ? { v2_error_class: v2ErrorClass } : {}),
    ...filterStats,
  };
}

async function postOtlpTraceBatch(
  env: TraceUploadWorkerEnv,
  records: readonly LocalTraceRecord[],
  metadata: TraceBundleMetadata,
): Promise<void> {
  const endpoint = normalizeOtlpTracesEndpoint(env.TRACE_INGEST_OTLP_ENDPOINT ?? "");
  const fetchImpl = env.TRACE_INGEST_FETCH ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(env.TRACE_INGEST_OTLP_AUTHORIZATION ? { Authorization: env.TRACE_INGEST_OTLP_AUTHORIZATION } : {}),
  };
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(toOtlpPayload(env, records, metadata)),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OTLP HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
}

export async function postOtlpLogBatch(
  env: TraceUploadWorkerEnv,
  resourceAttributes: Array<{ key: string; value: OtlpAnyValue }>,
  scopeName: string,
  events: readonly KeyedEventRecord[],
): Promise<void> {
  const endpoint = normalizeOtlpTracesEndpoint(env.TRACE_INGEST_OTLP_ENDPOINT ?? "").replace(/\/v1\/traces$/, "/v1/logs");
  const fetchImpl = env.TRACE_INGEST_FETCH ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(env.TRACE_INGEST_OTLP_AUTHORIZATION ? { Authorization: env.TRACE_INGEST_OTLP_AUTHORIZATION } : {}),
  };
  const payload = {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes },
        scopeLogs: [
          {
            scope: { name: scopeName },
            logRecords: events.map((event) => toOtlpLogRecord(event)),
          },
        ],
      },
    ],
  };
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OTLP HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
}

// Telescope keeps the log body but drops `eventName`, so the event name is
// also written as the body string.
function toOtlpLogRecord({ record, eventKey }: KeyedEventRecord): JsonObject {
  const timeUnixNano = isoToUnixNano(record.time);
  return {
    timeUnixNano,
    observedTimeUnixNano: timeUnixNano,
    severityNumber: 9,
    severityText: "INFO",
    eventName: record.name,
    body: { stringValue: record.name },
    traceId: record.trace_id ?? "",
    spanId: record.span_id ?? "",
    attributes: compactAttributes({
      ...(record.attrs ?? {}),
      "slock.surface": record.surface,
      "slock.schema_version": record.schema_version,
      "slock.trace_ingest.event_key": eventKey,
    }),
  };
}

function daemonResourceAttributes(
  env: TraceUploadWorkerEnv,
  records: readonly LocalTraceRecord[],
  metadata: {
    uploadId: string;
    bundleId: string;
    bundleSha256: string;
    bundleSizeBytes: number;
    serverId: string;
    machineId: string;
    deploymentEnvironment?: string;
  },
): Array<{ key: string; value: OtlpAnyValue }> {
  return compactAttributes({
    "service.name": env.TRACE_INGEST_SERVICE_NAME || "slock-daemon",
    "service.version": inferDaemonServiceVersion(records),
    "service.revision": env.SLOCK_RELEASE_SHA,
    "deployment.environment": metadata.deploymentEnvironment ?? env.DEPLOYMENT_ENV,
    "telemetry.sdk.name": "slock-daemon-local-trace-ingest",
    "slock.trace_upload.upload_id": metadata.uploadId,
    "slock.trace_upload.bundle_id": metadata.bundleId,
    "slock.trace_upload.bundle_sha256": metadata.bundleSha256,
    "slock.trace_upload.bundle_size_bytes": metadata.bundleSizeBytes,
    "slock.server_id": metadata.serverId,
    "slock.machine_id": metadata.machineId,
  });
}

function toOtlpPayload(
  env: TraceUploadWorkerEnv,
  records: readonly LocalTraceRecord[],
  metadata: {
    uploadId: string;
    bundleId: string;
    bundleSha256: string;
    bundleSizeBytes: number;
    serverId: string;
    machineId: string;
    deploymentEnvironment?: string;
  },
): JsonObject {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: daemonResourceAttributes(env, records, metadata),
        },
        scopeSpans: [
          {
            scope: { name: "@slock-ai/daemon" },
            spans: records.map((record) => toOtlpSpan(record, traceIngestSpanKey(metadata, record))),
          },
        ],
      },
    ],
  };
}

export function inferDaemonServiceVersion(records: readonly LocalTraceRecord[]): string | undefined {
  for (const record of records) {
    const attrs = record.attrs ?? {};
    const version = stringAttr(attrs.daemon_version) ?? stringAttr(attrs.daemonVersion);
    if (version) return version;
  }
  return undefined;
}

export function toOtlpSpan(record: LocalTraceRecord, ingestSpanKey: string): JsonObject {
  const attrs = compactAttributes({
    ...(record.attrs ?? {}),
    "slock.surface": record.surface,
    "slock.duration_ms": record.duration_ms,
    "slock.schema_version": record.schema_version,
    "slock.trace_ingest.span_key": ingestSpanKey,
  });
  const events = (record.events ?? []).map((event) => {
    const eventAttrs = compactAttributes(event.attrs ?? {});
    return {
      timeUnixNano: isoToUnixNano(event.time),
      name: event.name,
      ...(eventAttrs.length > 0 ? { attributes: eventAttrs } : {}),
    };
  });

  return {
    traceId: record.trace_id,
    spanId: record.span_id,
    ...(record.parent_span_id ? { parentSpanId: record.parent_span_id } : {}),
    name: record.name,
    kind: toOtlpSpanKind(record.kind),
    startTimeUnixNano: isoToUnixNano(record.start_time),
    endTimeUnixNano: isoToUnixNano(record.end_time),
    ...(attrs.length > 0 ? { attributes: attrs } : {}),
    ...(events.length > 0 ? { events } : {}),
    status: toOtlpStatus(record.status),
  };
}

export function traceIngestSpanKey(metadata: { serverId: string; machineId: string; bundleSha256: string }, record: LocalTraceRecord): string {
  return `${metadata.serverId}:${metadata.machineId}:${metadata.bundleSha256}:${record.trace_id}:${record.span_id}`;
}

export function parseTraceBundleRecords(
  text: string,
  bundleSha256: string,
): { spans: LocalTraceRecord[]; events: KeyedEventRecord[] } {
  const spans: LocalTraceRecord[] = [];
  const events: KeyedEventRecord[] = [];
  for (const [lineIdx, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`Invalid JSONL trace record at line ${lineIdx + 1}`);
    }
    if (isLocalEventRecord(parsed)) {
      events.push({ record: parsed, eventKey: `${bundleSha256}:${lineIdx}` });
      continue;
    }
    if (!isLocalTraceRecord(parsed)) {
      throw new Error(`Invalid trace span record at line ${lineIdx + 1}`);
    }
    spans.push(parsed);
  }
  return { spans, events };
}

function getConfiguredIngestBatchSize(env: TraceUploadWorkerEnv): number {
  if (!env.TRACE_INGEST_BATCH_SIZE) return DEFAULT_INGEST_BATCH_SIZE;
  const parsed = Number(env.TRACE_INGEST_BATCH_SIZE);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_INGEST_BATCH_SIZE;
}

function getConfiguredIngestMaxDecompressedBytes(env: TraceUploadWorkerEnv): number {
  if (!env.TRACE_INGEST_MAX_DECOMPRESSED_BYTES) return DEFAULT_INGEST_MAX_DECOMPRESSED_BYTES;
  const parsed = Number(env.TRACE_INGEST_MAX_DECOMPRESSED_BYTES);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_INGEST_MAX_DECOMPRESSED_BYTES;
}

export function normalizeOtlpTracesEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  const withoutTrailingSlash = withScheme.replace(/\/+$/, "");
  if (withoutTrailingSlash.endsWith("/v1/traces")) {
    return withoutTrailingSlash;
  }
  return `${withoutTrailingSlash}/v1/traces`;
}

// Exported for the cross-package daemon-bundle smoke test
// (daemonBundle.smoke.test.ts), which must validate REAL daemon-produced
// records against the same gate the ingest path uses.
export function isLocalTraceRecord(value: unknown): value is LocalTraceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === "span"
    && record.schema_version === 1
    && typeof record.trace_id === "string"
    && typeof record.span_id === "string"
    && (typeof record.parent_span_id === "string" || record.parent_span_id === null || record.parent_span_id === undefined)
    && typeof record.name === "string"
    && typeof record.surface === "string"
    && typeof record.kind === "string"
    && typeof record.status === "string"
    && typeof record.start_time === "string"
    && typeof record.end_time === "string"
    && (record.attrs === undefined || isJsonObject(record.attrs))
    && (record.events === undefined || isTraceEvents(record.events));
}

export function isLocalEventRecord(value: unknown): value is LocalEventRecord {
  if (!isJsonObject(value)) return false;
  return value.type === "event"
    && value.schema_version === 1
    && typeof value.name === "string"
    && typeof value.surface === "string"
    && typeof value.time === "string"
    && (value.trace_id === undefined || typeof value.trace_id === "string")
    && (value.span_id === undefined || typeof value.span_id === "string")
    && (value.attrs === undefined || isJsonObject(value.attrs));
}

function isTraceEvents(value: unknown): value is LocalTraceRecord["events"] {
  return Array.isArray(value) && value.every((event) => (
    !!event
    && typeof event === "object"
    && !Array.isArray(event)
    && typeof (event as Record<string, unknown>).name === "string"
    && typeof (event as Record<string, unknown>).time === "string"
    && (
      (event as Record<string, unknown>).attrs === undefined
      || isJsonObject((event as Record<string, unknown>).attrs)
    )
  ));
}

function toOtlpSpanKind(kind: string): number {
  switch (kind) {
    case "server":
      return 2;
    case "client":
      return 3;
    case "producer":
      return 4;
    case "consumer":
      return 5;
    case "internal":
    default:
      return 1;
  }
}

function toOtlpStatus(status: string): JsonObject {
  if (status === "unset") return { code: 0 };
  if (status === "ok") return { code: 1 };
  return { code: 2, message: status };
}

export function compactAttributes(attrs: Record<string, unknown>): Array<{ key: string; value: OtlpAnyValue }> {
  return Object.entries(attrs)
    .map(([key, value]) => {
      const converted = toOtlpAnyValue(value);
      return converted ? { key, value: converted } : null;
    })
    .filter((attr): attr is { key: string; value: OtlpAnyValue } => attr !== null);
}

function toOtlpAnyValue(value: unknown): OtlpAnyValue | null {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return null;
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "bigint") return { intValue: value.toString() };
  if (value === null) return { stringValue: "null" };
  try {
    return { stringValue: JSON.stringify(value) };
  } catch {
    return { stringValue: String(value) };
  }
}

function isoToUnixNano(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`Invalid trace timestamp: ${value}`);
  return (BigInt(Math.trunc(ms)) * 1_000_000n).toString();
}
