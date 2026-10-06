// task #279 — default machine-side evidence on feedback uploads (artin,
// 2026-09-15: investigations kept asking for the same evidence; ship it by
// default). Two STRUCTURED sources join the default tier beside the
// observed-failure summary (task #272 tier 1):
//
//   1. A projection of the daemon trace tail: fixed tuple per record, every
//      value drawn from a closed enum, a validated ID/time/version format, or
//      omitted. Free-text attrs (e.g. `original_message`, stringified
//      `modelUsageJson`) never enter the payload — the projection constructs a
//      new object from named fields; it does not spread or filter the input.
//   2. A machine-state summary: versions, K stable slot version, and the KIND
//      of the login-carrier dispatcher path (never the path itself).
//
// "No free text" is a property of these two structures only. The runner-log
// tail (task #272 tier 2) is free text and stays governed by its own opt-in and
// disclosure; nothing here extends to it.
import {
  OBSERVED_FAILURE_SPANS,
  UNKNOWN_FAILURE_SPAN,
  normalizeTraceInstant,
  parseObservedFailureSummary,
  toObservedFailureSpan,
  traceRecordStatus,
  traceRecordTime,
  type ObservedFailureSpan,
  type ObservedFailureSummary,
} from "./observedFailureSummary";
import { RUNTIME_ERROR_CLASSES, RUNTIME_ERROR_REASONS, SPAWN_FAILURE_REASONS } from "./index";

// "unknown" is the fixed label for a missing or out-of-vocabulary status. A
// record never becomes "ok" by default (Jianwei, #7798 review).
export const FEEDBACK_TRACE_STATUSES = ["ok", "error", "cancelled", "unknown"] as const;
export type FeedbackTraceStatus = (typeof FEEDBACK_TRACE_STATUSES)[number];

export const FEEDBACK_TRACE_TAIL_MAX_RECORDS = 500;

/** One projected trace record. Every field is closed-enum, validated-format, or null. */
export interface FeedbackTraceRecord {
  span: ObservedFailureSpan;
  status: FeedbackTraceStatus;
  /** ISO-8601 UTC. */
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  agentId: string | null;
  launchId: string | null;
  dispatchId: string | null;
  errorClass: (typeof RUNTIME_ERROR_CLASSES)[number] | null;
  errorReason: (typeof RUNTIME_ERROR_REASONS)[number] | null;
  spawnFailureReason: (typeof SPAWN_FAILURE_REASONS)[number] | null;
}

export interface FeedbackTraceTail {
  window: {
    requestedFrom: string;
    requestedTo: string;
    /** Span of records actually emitted; null when none. Not a coverage claim. */
    observedFrom: string | null;
    observedTo: string | null;
    recordsRead: number;
    recordsEmitted: number;
    dropped: { unparseable: number; undatable: number; outsideWindow: number; overCap: number };
    /** Always "unknown": sampling/rotation of the trace files is not established. */
    completeness: "unknown";
  };
  records: FeedbackTraceRecord[];
}

export const DISPATCHER_PATH_KINDS = ["stable", "temp", "k_slot", "missing", "unknown"] as const;
export type DispatcherPathKind = (typeof DISPATCHER_PATH_KINDS)[number];
export const HOST_LIFECYCLE_OWNERS = ["cli", "app", "none", "unknown"] as const;
export type HostLifecycleOwnerKind = (typeof HOST_LIFECYCLE_OWNERS)[number];

export interface FeedbackMachineState {
  /** Version the running daemon reports for itself (baked at build). */
  daemonVersion: string | null;
  /** Computer version recorded by the service at startup (service-version.json). */
  computerServiceVersion: string | null;
  /** Version file of the K stable slot, when present. */
  kStableVersion: string | null;
  hostLifecycleOwner: HostLifecycleOwnerKind;
  /** Kind of the login-carrier dispatcher path; the path itself is never emitted. */
  dispatcherPathKind: DispatcherPathKind;
}

// IDs are UUIDs, hex digests, or lowercase word-dash-token fixtures. A JWT or
// API-key segment (mixed case, no dash) is not an ID and is dropped.
const ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8,64}|[a-z]{1,16}-[a-z0-9-]{1,32})$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,64})?$/;
// The enum sets are built lazily: this module is re-exported from index.ts,
// which also defines the runtime/spawn enums, so a module-level `new Set(...)`
// would run inside the import cycle and see `undefined`.
let enumSets: { statuses: ReadonlySet<string>; errorClasses: ReadonlySet<string>; errorReasons: ReadonlySet<string>; spawnReasons: ReadonlySet<string>; spans: ReadonlySet<string> } | null = null;
function sets() {
  enumSets ??= {
    statuses: new Set<string>(FEEDBACK_TRACE_STATUSES),
    errorClasses: new Set<string>(RUNTIME_ERROR_CLASSES),
    errorReasons: new Set<string>(RUNTIME_ERROR_REASONS),
    spawnReasons: new Set<string>(SPAWN_FAILURE_REASONS),
    spans: new Set<string>([...OBSERVED_FAILURE_SPANS, UNKNOWN_FAILURE_SPAN]),
  };
  return enumSets;
}

export function validatedId(raw: unknown): string | null {
  return typeof raw === "string" && ID_RE.test(raw) ? raw : null;
}
export function validatedSemver(raw: unknown): string | null {
  return typeof raw === "string" && SEMVER_RE.test(raw) ? raw : null;
}
function enumOrNull<T extends string>(raw: unknown, set: ReadonlySet<string>): T | null {
  return typeof raw === "string" && set.has(raw) ? (raw as T) : null;
}
function nonNegativeIntOrNull(raw: unknown, max: number): number | null {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 && raw <= max ? raw : null;
}

/**
 * Project one raw trace record (as read from a daemon-trace-*.jsonl line) into
 * the fixed tuple. Returns null when the record has no usable start time, since
 * a record with no instant cannot be placed in a window. Everything else that
 * fails validation becomes null/omitted rather than passed through.
 */
export function projectFeedbackTraceRecord(raw: unknown): FeedbackTraceRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const startedAt = normalizeTraceInstant(traceRecordTime(record));
  if (startedAt === null) return null;
  const attrs = record.attrs && typeof record.attrs === "object" && !Array.isArray(record.attrs)
    ? (record.attrs as Record<string, unknown>)
    : {};
  return {
    span: toObservedFailureSpan(record.name),
    status: enumOrNull<FeedbackTraceStatus>(traceRecordStatus(record), sets().statuses) ?? "unknown",
    startedAt,
    endedAt: normalizeTraceInstant(record.end_time),
    durationMs: nonNegativeIntOrNull(record.duration_ms, 7 * 24 * 60 * 60 * 1000),
    agentId: validatedId(attrs.agentId ?? attrs.agent_id),
    launchId: validatedId(attrs.launchId ?? attrs.launch_id),
    dispatchId: validatedId(attrs.startDispatchId ?? attrs.start_dispatch_id ?? attrs.dispatchId),
    errorClass: enumOrNull(attrs.error_class ?? attrs.errorClass, sets().errorClasses),
    errorReason: enumOrNull(attrs.error_reason ?? attrs.errorReason, sets().errorReasons),
    spawnFailureReason: enumOrNull(attrs.failure_reason ?? attrs.spawnFailureReason, sets().spawnReasons),
  };
}

const RECORD_KEYS = [
  "span", "status", "startedAt", "endedAt", "durationMs", "agentId", "launchId", "dispatchId",
  "errorClass", "errorReason", "spawnFailureReason",
] as const;

/** Server-side strict parser: rebuilds the structure field by field; throws on any deviation. */
export function parseFeedbackTraceTail(raw: unknown): FeedbackTraceTail {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("feedbackTraceTail must be a JSON object");
  const value = raw as Record<string, unknown>;
  const window = value.window;
  if (!window || typeof window !== "object" || Array.isArray(window)) throw new Error("feedbackTraceTail.window must be a JSON object");
  const w = window as Record<string, unknown>;
  const requestedFrom = normalizeTraceInstant(w.requestedFrom);
  const requestedTo = normalizeTraceInstant(w.requestedTo);
  if (!requestedFrom || !requestedTo) throw new Error("feedbackTraceTail.window.requested* must be timestamps");
  // Raw null is "nothing observed"; a non-null value that does not parse is a
  // malformed timestamp and rejects (Jianwei, #7798 review).
  const observedInstant = (raw: unknown, name: string): string | null => {
    if (raw === null) return null;
    const parsed = normalizeTraceInstant(raw);
    if (parsed === null) throw new Error(`feedbackTraceTail.window.${name} is not a timestamp`);
    return parsed;
  };
  const observedFrom = observedInstant(w.observedFrom, "observedFrom");
  const observedTo = observedInstant(w.observedTo, "observedTo");
  if (w.completeness !== "unknown") throw new Error('feedbackTraceTail.window.completeness must be "unknown"');
  const recordsRead = nonNegativeIntOrNull(w.recordsRead, 10_000_000);
  const recordsEmitted = nonNegativeIntOrNull(w.recordsEmitted, FEEDBACK_TRACE_TAIL_MAX_RECORDS);
  if (recordsRead === null || recordsEmitted === null) throw new Error("feedbackTraceTail.window counters invalid");
  const d = w.dropped && typeof w.dropped === "object" && !Array.isArray(w.dropped) ? (w.dropped as Record<string, unknown>) : null;
  if (!d) throw new Error("feedbackTraceTail.window.dropped must be a JSON object");
  const dropped = {
    unparseable: nonNegativeIntOrNull(d.unparseable, 10_000_000),
    undatable: nonNegativeIntOrNull(d.undatable, 10_000_000),
    outsideWindow: nonNegativeIntOrNull(d.outsideWindow, 10_000_000),
    overCap: nonNegativeIntOrNull(d.overCap, 10_000_000),
  };
  if (Object.values(dropped).some((n) => n === null)) throw new Error("feedbackTraceTail.window.dropped counters invalid");
  if (!Array.isArray(value.records)) throw new Error("feedbackTraceTail.records must be an array");
  if (value.records.length > FEEDBACK_TRACE_TAIL_MAX_RECORDS) throw new Error("feedbackTraceTail.records exceeds the cap");
  const records: FeedbackTraceRecord[] = value.records.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`feedbackTraceTail.records[${index}] must be an object`);
    const r = entry as Record<string, unknown>;
    for (const key of Object.keys(r)) {
      if (!(RECORD_KEYS as readonly string[]).includes(key)) throw new Error(`feedbackTraceTail.records[${index}] has unknown field`);
    }
    const startedAt = normalizeTraceInstant(r.startedAt);
    if (!startedAt) throw new Error(`feedbackTraceTail.records[${index}].startedAt invalid`);
    if (typeof r.span !== "string" || !sets().spans.has(r.span)) throw new Error(`feedbackTraceTail.records[${index}].span not in the closed set`);
    const status = enumOrNull<FeedbackTraceStatus>(r.status, sets().statuses);
    if (!status) throw new Error(`feedbackTraceTail.records[${index}].status invalid`);
    const nullable = (v: unknown, f: (x: unknown) => string | null, name: string): string | null => {
      if (v === null || v === undefined) return null;
      const out = f(v);
      if (out === null) throw new Error(`feedbackTraceTail.records[${index}].${name} invalid`);
      return out;
    };
    return {
      span: r.span as ObservedFailureSpan,
      status,
      startedAt,
      endedAt: nullable(r.endedAt, normalizeTraceInstant, "endedAt"),
      durationMs: r.durationMs === null || r.durationMs === undefined ? null : (() => {
        const n = nonNegativeIntOrNull(r.durationMs, 7 * 24 * 60 * 60 * 1000);
        if (n === null) throw new Error(`feedbackTraceTail.records[${index}].durationMs invalid`);
        return n;
      })(),
      agentId: nullable(r.agentId, validatedId, "agentId"),
      launchId: nullable(r.launchId, validatedId, "launchId"),
      dispatchId: nullable(r.dispatchId, validatedId, "dispatchId"),
      errorClass: nullable(r.errorClass, (v) => enumOrNull(v, sets().errorClasses), "errorClass") as FeedbackTraceRecord["errorClass"],
      errorReason: nullable(r.errorReason, (v) => enumOrNull(v, sets().errorReasons), "errorReason") as FeedbackTraceRecord["errorReason"],
      spawnFailureReason: nullable(r.spawnFailureReason, (v) => enumOrNull(v, sets().spawnReasons), "spawnFailureReason") as FeedbackTraceRecord["spawnFailureReason"],
    };
  });
  return {
    window: { requestedFrom, requestedTo, observedFrom, observedTo, recordsRead, recordsEmitted, dropped: dropped as FeedbackTraceTail["window"]["dropped"], completeness: "unknown" },
    records,
  };
}

const OWNERS: ReadonlySet<string> = new Set<string>(HOST_LIFECYCLE_OWNERS);
const KINDS: ReadonlySet<string> = new Set<string>(DISPATCHER_PATH_KINDS);

/** Server-side strict parser for the machine-state summary. */
export function parseFeedbackMachineState(raw: unknown): FeedbackMachineState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("feedbackMachineState must be a JSON object");
  const v = raw as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["daemonVersion", "computerServiceVersion", "kStableVersion", "hostLifecycleOwner", "dispatcherPathKind"].includes(key)) {
      throw new Error("feedbackMachineState has unknown field");
    }
  }
  const semverOrNull = (x: unknown, name: string): string | null => {
    if (x === null || x === undefined) return null;
    const out = validatedSemver(x);
    if (out === null) throw new Error(`feedbackMachineState.${name} is not a version`);
    return out;
  };
  const owner = enumOrNull<HostLifecycleOwnerKind>(v.hostLifecycleOwner, OWNERS);
  const kind = enumOrNull<DispatcherPathKind>(v.dispatcherPathKind, KINDS);
  if (!owner || !kind) throw new Error("feedbackMachineState enums invalid");
  return {
    daemonVersion: semverOrNull(v.daemonVersion, "daemonVersion"),
    computerServiceVersion: semverOrNull(v.computerServiceVersion, "computerServiceVersion"),
    kStableVersion: semverOrNull(v.kStableVersion, "kStableVersion"),
    hostLifecycleOwner: owner,
    dispatcherPathKind: kind,
  };
}

// ---------------------------------------------------------------------------
// The machine_evidence attachment.
//
// The three diagnostic structures above (plus the tier-1 observed-failure
// summary) used to ride INSIDE the transcript upload's signed attestation. The
// worker caps every attestation at SCOPE_ATTESTATION_MAX_CHARS before it even
// verifies it, so a busy trace window made the MAIN transcript fail to upload.
// They now travel as their own object (`feedbackAttachmentKind:
// "machine_evidence"`) whose own attestation binds only its sha256, the report,
// the agent and the server-derived machine identity. No attestation carries the
// diagnostics or a digest of them, so nothing about them can block the
// transcript.
// ---------------------------------------------------------------------------

/** Attachment kinds a feedback-linked trace bundle may be signed as (closed set). */
/**
 * `transcript_outcome` (task #1228 ①): the small typed lookup/upload outcome of
 * one feedback transcript request. Filed outside trace-bundles/ and never
 * ingested as traces; see feedbackTranscriptOutcome.ts.
 */
export const FEEDBACK_ATTACHMENT_KINDS = ["session_transcript", "machine_log_tail", "machine_evidence", "transcript_outcome"] as const;
export type FeedbackAttachmentKind = (typeof FEEDBACK_ATTACHMENT_KINDS)[number];

export function isFeedbackAttachmentKind(value: unknown): value is FeedbackAttachmentKind {
  return typeof value === "string" && (FEEDBACK_ATTACHMENT_KINDS as readonly string[]).includes(value);
}

/** The diagnostic sections. None of them may ever be signed into an attestation. */
export const FEEDBACK_MACHINE_EVIDENCE_SECTIONS = ["observedFailureSummary", "feedbackTraceTail", "feedbackMachineState"] as const;
export type FeedbackMachineEvidenceSection = (typeof FEEDBACK_MACHINE_EVIDENCE_SECTIONS)[number];

export const FEEDBACK_MACHINE_EVIDENCE_TYPE = "feedback_machine_evidence";
export const FEEDBACK_MACHINE_EVIDENCE_SCHEMA_VERSION = 1;
/**
 * Hard cap on the evidence object's RAW UTF-8 JSON bytes: the whole envelope,
 * including the summary, the machine state and the truncation marker itself.
 * Not the tail alone, and not the compressed size.
 */
export const FEEDBACK_MACHINE_EVIDENCE_MAX_BYTES = 256 * 1024;
/** Upper bound on the gzipped object the server will sign for (gzip can exceed its input slightly). */
export const FEEDBACK_MACHINE_EVIDENCE_MAX_UPLOAD_BYTES = FEEDBACK_MACHINE_EVIDENCE_MAX_BYTES + 4096;
/** Upper bound on the report / agent identifiers bound into the object (matches the worker's claim readers). */
export const FEEDBACK_MACHINE_EVIDENCE_ID_MAX_CHARS = 128;

export interface FeedbackMachineEvidenceBounds {
  maxBytes: number;
  /** True iff trace records were dropped to fit `maxBytes`. */
  truncated: boolean;
  /** Oldest trace records dropped to fit `maxBytes`; the newest are always kept. */
  dropped: { overBytes: number };
}

export interface FeedbackMachineEvidenceEnvelope {
  type: typeof FEEDBACK_MACHINE_EVIDENCE_TYPE;
  schema_version: typeof FEEDBACK_MACHINE_EVIDENCE_SCHEMA_VERSION;
  feedbackReportId: string;
  agentId: string;
  /** `null` = could not be built (never "nothing happened"). */
  observedFailureSummary: ObservedFailureSummary | null;
  feedbackTraceTail: FeedbackTraceTail | null;
  feedbackMachineState: FeedbackMachineState | null;
  bounds: FeedbackMachineEvidenceBounds;
}

export type FeedbackMachineEvidenceBuildResult =
  | { ok: true; envelope: FeedbackMachineEvidenceEnvelope; json: string; bytes: number }
  /** Even with every trace record dropped the envelope does not fit: omit it, explicitly. */
  | { ok: false; reason: "over_byte_cap"; bytes: number; maxBytes: number };

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function tailKeepingNewest(tail: FeedbackTraceTail, keep: number): FeedbackTraceTail {
  if (keep >= tail.records.length) return tail;
  const records = tail.records.slice(tail.records.length - keep);
  return {
    window: {
      ...tail.window,
      observedFrom: records[0]?.startedAt ?? null,
      observedTo: records.at(-1)?.startedAt ?? null,
      recordsEmitted: records.length,
    },
    records,
  };
}

/**
 * Build the evidence envelope under a raw UTF-8 byte cap. Trace records are
 * dropped OLDEST first (a contiguous newest suffix is kept) and the drop is
 * recorded in `bounds`. The marker is measured as part of the envelope. If the
 * summary and state alone (zero records) still exceed the cap the result is
 * `ok: false` — the caller must report the evidence as omitted, never ship an
 * emptied object as if it were complete.
 */
export function buildBoundedFeedbackMachineEvidence(input: {
  feedbackReportId: string;
  agentId: string;
  observedFailureSummary: ObservedFailureSummary | null;
  feedbackTraceTail: FeedbackTraceTail | null;
  feedbackMachineState: FeedbackMachineState | null;
  maxBytes?: number;
}): FeedbackMachineEvidenceBuildResult {
  const maxBytes = input.maxBytes ?? FEEDBACK_MACHINE_EVIDENCE_MAX_BYTES;
  const total = input.feedbackTraceTail?.records.length ?? 0;
  const measure = (keep: number) => {
    const overBytes = total - keep;
    const envelope: FeedbackMachineEvidenceEnvelope = {
      type: FEEDBACK_MACHINE_EVIDENCE_TYPE,
      schema_version: FEEDBACK_MACHINE_EVIDENCE_SCHEMA_VERSION,
      feedbackReportId: input.feedbackReportId,
      agentId: input.agentId,
      observedFailureSummary: input.observedFailureSummary,
      feedbackTraceTail: input.feedbackTraceTail ? tailKeepingNewest(input.feedbackTraceTail, keep) : null,
      feedbackMachineState: input.feedbackMachineState,
      bounds: { maxBytes, truncated: overBytes > 0, dropped: { overBytes } },
    };
    const json = JSON.stringify(envelope);
    return { ok: true as const, envelope, json, bytes: utf8ByteLength(json) };
  };
  const full = measure(total);
  if (full.bytes <= maxBytes) return full;
  const none = measure(0);
  if (none.bytes > maxBytes) return { ok: false, reason: "over_byte_cap", bytes: none.bytes, maxBytes };
  // Size grows with every kept record; find the largest newest-suffix that fits.
  let fits = none;
  let lo = 0;
  let hi = total;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = measure(mid);
    if (candidate.bytes <= maxBytes) {
      lo = mid;
      fits = candidate;
    } else {
      hi = mid;
    }
  }
  return fits;
}

const ENVELOPE_KEYS = [
  "type", "schema_version", "feedbackReportId", "agentId",
  "observedFailureSummary", "feedbackTraceTail", "feedbackMachineState", "bounds",
] as const;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function boundedId(raw: unknown, name: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > FEEDBACK_MACHINE_EVIDENCE_ID_MAX_CHARS) {
    throw new Error(`${name} must be a non-empty string of at most ${FEEDBACK_MACHINE_EVIDENCE_ID_MAX_CHARS} chars`);
  }
  return raw;
}

/**
 * Strict parser for a stored/uploaded evidence object. Every section goes
 * through its own strict parser, and the input must be EXACTLY what those
 * parsers produce (compared key-order-insensitively): a field a section parser
 * would drop, collapse or normalize is a rejection here, because the worker
 * stores the uploaded bytes, not the parsed value.
 */
export function parseFeedbackMachineEvidence(raw: unknown): FeedbackMachineEvidenceEnvelope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("machine evidence must be a JSON object");
  const v = raw as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!(ENVELOPE_KEYS as readonly string[]).includes(key)) throw new Error("machine evidence has an unknown field");
  }
  for (const key of ENVELOPE_KEYS) {
    if (!(key in v)) throw new Error(`machine evidence is missing ${key}`);
  }
  if (v.type !== FEEDBACK_MACHINE_EVIDENCE_TYPE) throw new Error("machine evidence type is invalid");
  if (v.schema_version !== FEEDBACK_MACHINE_EVIDENCE_SCHEMA_VERSION) throw new Error("machine evidence schema_version is unsupported");
  const b = v.bounds;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("machine evidence bounds must be a JSON object");
  const bounds = b as Record<string, unknown>;
  const dropped = bounds.dropped && typeof bounds.dropped === "object" && !Array.isArray(bounds.dropped)
    ? (bounds.dropped as Record<string, unknown>)
    : null;
  const maxBytes = nonNegativeIntOrNull(bounds.maxBytes, FEEDBACK_MACHINE_EVIDENCE_MAX_BYTES);
  const overBytes = dropped ? nonNegativeIntOrNull(dropped.overBytes, 10_000_000) : null;
  if (maxBytes === null || maxBytes === 0) throw new Error("machine evidence bounds.maxBytes is invalid");
  if (overBytes === null || typeof bounds.truncated !== "boolean") throw new Error("machine evidence bounds marker is invalid");
  if (bounds.truncated !== overBytes > 0) throw new Error("machine evidence bounds.truncated disagrees with dropped.overBytes");
  const envelope: FeedbackMachineEvidenceEnvelope = {
    type: FEEDBACK_MACHINE_EVIDENCE_TYPE,
    schema_version: FEEDBACK_MACHINE_EVIDENCE_SCHEMA_VERSION,
    feedbackReportId: boundedId(v.feedbackReportId, "machine evidence feedbackReportId"),
    agentId: boundedId(v.agentId, "machine evidence agentId"),
    observedFailureSummary: v.observedFailureSummary === null ? null : parseObservedFailureSummary(v.observedFailureSummary),
    feedbackTraceTail: v.feedbackTraceTail === null ? null : parseFeedbackTraceTail(v.feedbackTraceTail),
    feedbackMachineState: v.feedbackMachineState === null ? null : parseFeedbackMachineState(v.feedbackMachineState),
    bounds: { maxBytes, truncated: bounds.truncated, dropped: { overBytes } },
  };
  if (canonicalJson(envelope) !== canonicalJson(raw)) {
    throw new Error("machine evidence carries fields or values its strict parsers do not reproduce");
  }
  return envelope;
}
