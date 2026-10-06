// task #1228 ①: feedback transcript results that arrive AFTER the server
// stopped waiting (30 s). The route never waits; this only lets the server
// record the late outcome as a span. In memory, bounded (cap + TTL), lost on
// restart by design (no table). A late result is accepted only from the
// machine it was asked of, for the same agent and report, and only once.
//
// The frame's typed fields are untrusted (the WebSocket layer only
// JSON.parses): they are read with the strict, never-throwing shared reader,
// and only the validated projection is ever recorded or forwarded.
import {
  readFeedbackTranscriptResultOutcome,
  type FeedbackTranscriptResultOutcomeRead,
  type MachineToServerMessage,
  type TraceAttributes,
} from "@botiverse/raft-shared";

/** How long after the timeout a late result is still correlated. */
export const FEEDBACK_TRANSCRIPT_LATE_RESULT_TTL_MS = 15 * 60_000;
/** Most pending timed-out requests remembered at once; the oldest is evicted first. */
export const FEEDBACK_TRANSCRIPT_LATE_RESULT_MAX_ENTRIES = 256;

interface PendingLateResult {
  machineId: string;
  agentId: string;
  feedbackReportId: string;
  timedOutAtMs: number;
}

export type LateResultDecision =
  | { status: "accepted"; entry: PendingLateResult; lateByMs: number }
  | { status: "unknown" }
  | { status: "expired" }
  | { status: "ownership_mismatch"; field: "machine" | "agent" | "report" };

type FeedbackTranscriptResultMessage = Extract<MachineToServerMessage, { type: "agent:diagnostic:feedback_transcript_result" }>;

export class FeedbackTranscriptLateResults {
  private readonly entries = new Map<string, PendingLateResult>();

  constructor(
    private readonly now: () => number,
    private readonly ttlMs = FEEDBACK_TRANSCRIPT_LATE_RESULT_TTL_MS,
    private readonly maxEntries = FEEDBACK_TRANSCRIPT_LATE_RESULT_MAX_ENTRIES,
  ) {}

  size(): number {
    return this.entries.size;
  }

  remember(requestId: string, entry: Omit<PendingLateResult, "timedOutAtMs">): void {
    const now = this.now();
    this.prune(now);
    this.entries.delete(requestId);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(requestId, { ...entry, timedOutAtMs: now });
  }

  /**
   * Decides WITHOUT consuming (only an expired entry is dropped). The caller
   * consumes with `consume` once it has also validated the frame, so neither
   * an impostor nor a malformed frame from the right machine removes the entry.
   */
  check(machineId: string, msg: FeedbackTranscriptResultMessage): LateResultDecision {
    const entry = this.entries.get(msg.requestId);
    if (!entry) return { status: "unknown" };
    const now = this.now();
    if (now - entry.timedOutAtMs > this.ttlMs) {
      this.entries.delete(msg.requestId);
      return { status: "expired" };
    }
    if (entry.machineId !== machineId) return { status: "ownership_mismatch", field: "machine" };
    if (entry.agentId !== msg.agentId) return { status: "ownership_mismatch", field: "agent" };
    if (entry.feedbackReportId !== msg.feedbackReportId) return { status: "ownership_mismatch", field: "report" };
    return { status: "accepted", entry, lateByMs: now - entry.timedOutAtMs };
  }

  /** Accept exactly once: later frames for the same request are `unknown`. */
  consume(requestId: string): void {
    this.entries.delete(requestId);
  }

  private prune(now: number): void {
    for (const [id, entry] of this.entries) {
      if (now - entry.timedOutAtMs <= this.ttlMs) break; // insertion order = age
      this.entries.delete(id);
    }
  }
}

function bounded(value: unknown, max = 200): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

/** The strict shared reader, guarded once more: this can never throw. */
export function readFeedbackTranscriptResultOutcomeSafely(msg: unknown): FeedbackTranscriptResultOutcomeRead {
  try {
    return readFeedbackTranscriptResultOutcome(msg);
  } catch {
    return { status: "invalid", reason: "typed fields could not be read" };
  }
}

/**
 * Span attributes for one daemon result frame, built ONLY from the validated
 * read. A typed frame (outcomeVersion 1, every field valid) is recorded field
 * by field; an older daemon's untyped frame as daemon_outcome=untyped; a frame
 * with any malformed typed field as daemon_outcome=invalid with a fixed parser
 * reason (never an echoed value). `stored` is never inferred from `reachable`.
 */
export function feedbackTranscriptOutcomeSpanAttrs(
  msg: FeedbackTranscriptResultMessage,
  read: FeedbackTranscriptResultOutcomeRead = readFeedbackTranscriptResultOutcomeSafely(msg),
): TraceAttributes {
  const attrs: Record<string, string | number | boolean | undefined> = {
    legacy_reachable: typeof msg.reachable === "boolean" ? msg.reachable : undefined,
    legacy_has_trace_bundle_id: Boolean(msg.traceBundleId),
    legacy_fallback_reason: bounded(msg.fallbackReason),
    legacy_error: bounded(msg.error),
  };
  attrs.daemon_outcome = read.status;
  attrs.daemon_typed = read.status === "typed";
  if (read.status === "typed") {
    const { lookup, upload } = read;
    attrs.lookup_status = lookup.reachable ? "ok" : "failed";
    attrs.lookup_reason = lookup.reasonCode ?? undefined;
    attrs.lookup_method = lookup.lookupMethod ?? undefined;
    attrs.workspace_dir_present = lookup.workspaceDirPresent ?? undefined;
    attrs.transcript_content = lookup.content;
    attrs.transcript_source_bytes = lookup.sourceBytes ?? undefined;
    attrs.transcript_bytes = lookup.transcriptBytes ?? undefined;
    attrs.upload_status = upload.status;
    attrs.upload_reason = upload.reason ?? undefined;
    attrs.upload_stage = upload.stage ?? undefined;
    attrs.upload_http_status = upload.httpStatus ?? undefined;
    attrs.upload_http_class = upload.httpClass ?? undefined;
    attrs.upload_id = upload.uploadId ?? undefined;
    attrs.content_label = upload.contentLabel ?? undefined;
    // The frame is sent BEFORE the outcome object is uploaded: the server can
    // never know from it whether that object was stored.
    attrs.outcome_object = read.outcomeObject === "not_attempted_worker_not_configured" ? "not_attempted" : "unknown";
  } else if (read.status === "invalid") {
    attrs.daemon_outcome_invalid_reason = bounded(read.reason, 120);
    attrs.upload_status = "unknown";
    attrs.outcome_object = "unknown";
  } else {
    attrs.upload_status = "unknown";
    attrs.outcome_object = "not_applicable";
  }
  return Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined)) as TraceAttributes;
}

/** Never throws: a failure to build attributes is itself recorded as invalid. */
export function feedbackTranscriptOutcomeSpanAttrsSafely(
  msg: FeedbackTranscriptResultMessage,
  read: FeedbackTranscriptResultOutcomeRead,
): TraceAttributes {
  try {
    return feedbackTranscriptOutcomeSpanAttrs(msg, read);
  } catch {
    return { daemon_outcome: "invalid", daemon_typed: false, daemon_outcome_invalid_reason: "span attributes could not be built", upload_status: "unknown", outcome_object: "unknown" };
  }
}
