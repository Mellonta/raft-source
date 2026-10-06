/**
 * Wire contract for the tier-1 machine-side context attached to a feedback
 * transcript upload (task #272).
 *
 * WHY THIS LIVES IN SHARED: the daemon produces this summary and the server
 * validates it before storing it. Validating `span` requires the allowed-name
 * set, so a copy in each package would mean the same closed set written twice
 * — the exact shape of the `non_member_mention` incident, where the daemon
 * emitted a value the shared wire enum rejected because one union had been
 * written in two places. Derive, do not duplicate.
 *
 * The trace-reading implementation stays in the daemon; only the contract and
 * its validators are here.
 *
 * WHAT THIS SUMMARY REFUSES TO SAY — every one of these is a limit on how the
 * output may be read, and they are stated here because the next reader of these
 * types will not have the review thread:
 *
 *  - An empty `failures` list means NOTHING WAS OBSERVED, never "no failure
 *    occurred". The requested window may not be covered by the corpus at all.
 *  - `observedFrom`/`observedTo` are the SPAN of the records counted. They do
 *    not assert continuous coverage between those instants.
 *  - `completeness` is the literal `"unknown"`, deliberately not a boolean.
 *    Sampling and rotation behaviour is unproven; a boolean would invite a
 *    future `true` that no type would stop.
 *  - `span` is drawn from OBSERVED_FAILURE_SPANS, a controlled *emission
 *    vocabulary* — not a failure taxonomy, and not a contract about what the
 *    daemon can emit. Any other name becomes `"unknown"`; raw corpus strings
 *    are never echoed, because a span name is data and data can carry a
 *    credential or a path. Adding a member is a contract change.
 *  - `attribution` is OBSERVATION attribution and nothing else. Neither value
 *    means the record was delivered to, consumed by, or model-seen by any
 *    agent, and neither means the failure caused what the reporter is
 *    reporting. `"machine-wide"` means ATTRIBUTION COULD NOT BE PROVEN — not
 *    that the whole machine was affected, and not that the reporting agent was
 *    affected. `"machine-wide"` collects ONLY records whose owning agent could
 *    not be determined; a record that plainly belongs to a different agent is
 *    excluded and counted under `excluded.otherAgent` instead, because its
 *    attribution is not unknown — it is known, to someone else (ruling: @XX,
 *    2026-09-15). Attribution may come only from the structured
 *    `attrs.agentId`; never from a span name, file path, or directory.
 *  - Failure is `status === "error"` and nothing else. `cancelled`, missing,
 *    unknown, and any future status are not failures.
 *  - `excluded` exists so that records left out stay visible as counts instead
 *    of silently becoming absent.
 */

/**
 * Closed emission vocabulary: names this contract is permitted to *carry*. It
 * is not a claim about which failures exist.
 */
export const OBSERVED_FAILURE_SPANS = [
  "cli.transport.normalized_error",
  "daemon.agent.app_inbox_notice",
  "daemon.app_schedule.delivery_alert",
  "daemon.app_schedule.occurrence",
  "daemon.app_source.fire",
  "daemon.app_source.retry",
  "daemon.bundle.upload",
  "daemon.connection.error",
  "daemon.connection.handshake_rejected",
  "daemon.connection.reconnect_stopped",
  "daemon.connection.watchdog_timeout",
  "daemon.runtime.process.exit",
] as const;

/** A span name outside the vocabulary is reported under this fixed label. */
export const UNKNOWN_FAILURE_SPAN = "unknown";

export type ObservedFailureSpan =
  | (typeof OBSERVED_FAILURE_SPANS)[number]
  | typeof UNKNOWN_FAILURE_SPAN;

/** The only trace status treated as a failure. */
export const FAILURE_STATUS = "error";

/**
 * Observation attribution only. See the header: neither value asserts delivery,
 * consumption, model-seen state, or causation.
 */
export type FailureAttribution = "exact" | "machine-wide";

export interface ObservedFailureClass {
  /** Controlled label, never a raw corpus string. */
  readonly span: ObservedFailureSpan;
  /** Records with `status === "error"`. Not a span occurrence count. */
  readonly count: number;
  readonly firstAt: string | null;
  readonly lastAt: string | null;
  readonly attribution: FailureAttribution;
}

/** Counts of records deliberately left out, kept visible rather than dropped. */
export interface ExcludedRecordCounts {
  /** Lines that did not parse as a JSON object. */
  readonly unparseable: number;
  /** Records without a usable timestamp, so they cannot be placed in a window. */
  readonly undatable: number;
  /** Records carrying a different agent's `attrs.agentId`. */
  readonly otherAgent: number;
}

export interface ObservationWindow {
  readonly requestedFrom: string;
  readonly requestedTo: string;
  /** Data SPAN of the records counted, not coverage. `null` when none. */
  readonly observedFrom: string | null;
  readonly observedTo: string | null;
  /** Records parsed from disk, before window or attribution filtering. */
  readonly recordsRead: number;
  /** Of those, records inside the requested window and not excluded. */
  readonly recordsInWindow: number;
  /** Of `recordsInWindow`, those with `status === "error"`. */
  readonly failureRecords: number;
  /** Of `recordsInWindow`, every other status — ok, cancelled, missing, other. */
  readonly nonFailureRecords: number;
  readonly excluded: ExcludedRecordCounts;
  /** Literal, not a boolean. See the header. */
  readonly completeness: "unknown";
}

export interface ObservedFailureSummary {
  readonly window: ObservationWindow;
  /** Empty means NOT OBSERVED, never "no failure". */
  readonly failures: readonly ObservedFailureClass[];
}

/** The closed list of fields this summary may carry. The list IS the boundary. */
export const OBSERVED_FAILURE_EMITTED_FIELDS = [
  "window.requestedFrom",
  "window.requestedTo",
  "window.observedFrom",
  "window.observedTo",
  "window.recordsRead",
  "window.recordsInWindow",
  "window.failureRecords",
  "window.nonFailureRecords",
  "window.excluded.unparseable",
  "window.excluded.undatable",
  "window.excluded.otherAgent",
  "window.completeness",
  "failures[].span",
  "failures[].count",
  "failures[].firstAt",
  "failures[].lastAt",
  "failures[].attribution",
] as const;

/**
 * Upper bound on distinct failure classes carried on the wire. The producer
 * emits at most (vocabulary + unknown) x (attribution) entries, so this is
 * generous; it exists so a malformed or hostile producer cannot make the
 * attestation unbounded.
 */
export const OBSERVED_FAILURE_MAX_CLASSES = 64;

/**
 * Map a span name onto the emission vocabulary. Anything unrecognized collapses
 * to `UNKNOWN_FAILURE_SPAN`: the failure is still counted, but the raw string
 * never reaches the summary.
 */
export function toObservedFailureSpan(raw: unknown): ObservedFailureSpan {
  return (OBSERVED_FAILURE_SPANS as readonly string[]).includes(raw as string)
    ? (raw as ObservedFailureSpan)
    : UNKNOWN_FAILURE_SPAN;
}

// Span lines carry `start_time` and `status`. Event lines (`type: "event"`)
// have no status field, so the outcome lives in `attrs.status`, and their
// time is `time`.
function isEventRecord(record: Record<string, unknown>): boolean {
  return record.type === "event";
}

export function traceRecordTime(record: Record<string, unknown>): unknown {
  return isEventRecord(record) ? record.time : record.start_time;
}

export function traceRecordStatus(record: Record<string, unknown>): unknown {
  if (!isEventRecord(record)) return record.status;
  const attrs = record.attrs;
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return undefined;
  return (attrs as Record<string, unknown>).status;
}

/**
 * Parse and re-serialize an instant as canonical ISO-8601 UTC. The input is
 * never copied through: an unparseable or non-finite value yields `null` rather
 * than passing arbitrary text into the summary.
 */
export function normalizeTraceInstant(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const ms = typeof raw === "number" ? raw : Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  const at = new Date(ms);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function readCount(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function readInstantOrNull(value: unknown, name: string): string | null {
  if (value === null) return null;
  const normalized = normalizeTraceInstant(value);
  if (normalized === null) throw new Error(`${name} must be an ISO-8601 instant or null`);
  return normalized;
}

function readRequiredInstant(value: unknown, name: string): string {
  const normalized = normalizeTraceInstant(value);
  if (normalized === null) throw new Error(`${name} must be an ISO-8601 instant`);
  return normalized;
}

/**
 * Validate an untrusted `ObservedFailureSummary` and REBUILD it field by field.
 *
 * The receiver is the server and the producer is a daemon it does not control,
 * so this deliberately does not copy the input object: unknown keys are
 * dropped, `span` must be a vocabulary member (an unrecognized name is
 * collapsed to `"unknown"`, never echoed), every instant is re-serialized from
 * a parse rather than passed through, and counts are bounded.
 *
 * Throws on a malformed summary rather than silently accepting a partial one.
 * The leniency policy belongs to the CALLER, not here: the trace-bundle route
 * catches this and drops the field with a warning, because a feedback upload is
 * the channel users report problems through and an optional diagnostic must not
 * be able to reject it. Keeping the validator strict means no caller can weaken
 * it for everyone by wanting to be forgiving in one place.
 */
export function parseObservedFailureSummary(raw: unknown): ObservedFailureSummary {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("observedFailureSummary must be a JSON object");
  }
  const body = raw as Record<string, unknown>;

  const windowRaw = body.window;
  if (!windowRaw || typeof windowRaw !== "object" || Array.isArray(windowRaw)) {
    throw new Error("observedFailureSummary.window must be a JSON object");
  }
  const w = windowRaw as Record<string, unknown>;

  const excludedRaw = w.excluded;
  if (!excludedRaw || typeof excludedRaw !== "object" || Array.isArray(excludedRaw)) {
    throw new Error("observedFailureSummary.window.excluded must be a JSON object");
  }
  const e = excludedRaw as Record<string, unknown>;

  if (w.completeness !== "unknown") {
    // Literal on purpose: there is no other legal value, and accepting one
    // would let a producer claim a confidence this contract never establishes.
    throw new Error('observedFailureSummary.window.completeness must be "unknown"');
  }

  const failuresRaw = body.failures;
  if (!Array.isArray(failuresRaw)) {
    throw new Error("observedFailureSummary.failures must be an array");
  }
  if (failuresRaw.length > OBSERVED_FAILURE_MAX_CLASSES) {
    throw new Error("observedFailureSummary.failures exceeds the maximum class count");
  }

  const failures: ObservedFailureClass[] = failuresRaw.map((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`observedFailureSummary.failures[${i}] must be a JSON object`);
    }
    const f = entry as Record<string, unknown>;
    if (f.attribution !== "exact" && f.attribution !== "machine-wide") {
      throw new Error(`observedFailureSummary.failures[${i}].attribution is invalid`);
    }
    return {
      // Collapsed, never echoed: an unrecognized name must not survive the hop.
      span: toObservedFailureSpan(f.span),
      count: readCount(f.count, `observedFailureSummary.failures[${i}].count`),
      firstAt: readInstantOrNull(f.firstAt, `observedFailureSummary.failures[${i}].firstAt`),
      lastAt: readInstantOrNull(f.lastAt, `observedFailureSummary.failures[${i}].lastAt`),
      attribution: f.attribution,
    };
  });

  return {
    window: {
      requestedFrom: readRequiredInstant(w.requestedFrom, "observedFailureSummary.window.requestedFrom"),
      requestedTo: readRequiredInstant(w.requestedTo, "observedFailureSummary.window.requestedTo"),
      observedFrom: readInstantOrNull(w.observedFrom, "observedFailureSummary.window.observedFrom"),
      observedTo: readInstantOrNull(w.observedTo, "observedFailureSummary.window.observedTo"),
      recordsRead: readCount(w.recordsRead, "observedFailureSummary.window.recordsRead"),
      recordsInWindow: readCount(w.recordsInWindow, "observedFailureSummary.window.recordsInWindow"),
      failureRecords: readCount(w.failureRecords, "observedFailureSummary.window.failureRecords"),
      nonFailureRecords: readCount(w.nonFailureRecords, "observedFailureSummary.window.nonFailureRecords"),
      excluded: {
        unparseable: readCount(e.unparseable, "observedFailureSummary.window.excluded.unparseable"),
        undatable: readCount(e.undatable, "observedFailureSummary.window.excluded.undatable"),
        otherAgent: readCount(e.otherAgent, "observedFailureSummary.window.excluded.otherAgent"),
      },
      completeness: "unknown",
    },
    failures,
  };
}
