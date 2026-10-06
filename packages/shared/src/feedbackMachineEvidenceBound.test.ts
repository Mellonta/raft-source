// The machine-evidence attachment's byte cap is measured on the WHOLE raw UTF-8
// JSON envelope (summary + state + tail + the truncation marker itself), not on
// the tail alone and not on the compressed bytes.
import assert from "node:assert/strict";
import {
  FEEDBACK_MACHINE_EVIDENCE_MAX_BYTES,
  FEEDBACK_MACHINE_EVIDENCE_TYPE,
  SCOPE_ATTESTATION_MAX_CHARS,
  buildBoundedFeedbackMachineEvidence,
  parseFeedbackMachineEvidence,
  utf8ByteLength,
  type FeedbackMachineState,
  type FeedbackTraceRecord,
  type FeedbackTraceTail,
  type ObservedFailureSummary,
} from "./index";

const STATE: FeedbackMachineState = {
  daemonVersion: "1.0.40",
  computerServiceVersion: "1.0.40",
  kStableVersion: "1.0.40",
  hostLifecycleOwner: "cli",
  dispatcherPathKind: "stable",
};

function summary(): ObservedFailureSummary {
  return {
    window: {
      requestedFrom: "2026-09-15T11:45:00.000Z",
      requestedTo: "2026-09-15T12:00:00.000Z",
      observedFrom: "2026-09-15T11:46:00.000Z",
      observedTo: "2026-09-15T11:59:00.000Z",
      recordsRead: 42,
      recordsInWindow: 40,
      failureRecords: 1,
      nonFailureRecords: 39,
      excluded: { unparseable: 0, undatable: 0, otherAgent: 0 },
      completeness: "unknown",
    },
    failures: [{ span: "daemon.connection.error", count: 1, firstAt: "2026-09-15T11:50:00.000Z", lastAt: "2026-09-15T11:50:00.000Z", attribution: "machine-wide" }],
  };
}

function record(index: number, agentId = "0b0e2a8e-1d2c-4f3a-9a1b-0c0d0e0f1a2b"): FeedbackTraceRecord {
  const at = new Date(Date.parse("2026-09-15T11:46:00.000Z") + index * 1000).toISOString();
  return {
    span: "daemon.runtime.process.exit",
    status: index % 7 === 0 ? "error" : "ok",
    startedAt: at,
    endedAt: at,
    durationMs: 37,
    agentId,
    launchId: "1b0e2a8e-1d2c-4f3a-9a1b-0c0d0e0f1a2b",
    dispatchId: null,
    errorClass: null,
    errorReason: null,
    spawnFailureReason: null,
  };
}

function tail(records: FeedbackTraceRecord[]): FeedbackTraceTail {
  return {
    window: {
      requestedFrom: "2026-09-15T11:45:00.000Z",
      requestedTo: "2026-09-15T12:00:00.000Z",
      observedFrom: records[0]?.startedAt ?? null,
      observedTo: records.at(-1)?.startedAt ?? null,
      recordsRead: records.length,
      recordsEmitted: records.length,
      dropped: { unparseable: 0, undatable: 0, outsideWindow: 0, overCap: 0 },
      completeness: "unknown",
    },
    records,
  };
}

function build(records: FeedbackTraceRecord[], maxBytes?: number, extra: { summary?: ObservedFailureSummary | null; state?: FeedbackMachineState | null } = {}) {
  return buildBoundedFeedbackMachineEvidence({
    feedbackReportId: "report-1",
    agentId: "0b0e2a8e-1d2c-4f3a-9a1b-0c0d0e0f1a2b",
    observedFailureSummary: extra.summary === undefined ? summary() : extra.summary,
    feedbackTraceTail: tail(records),
    feedbackMachineState: extra.state === undefined ? STATE : extra.state,
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  });
}

describe("feedback machine evidence: byte cap over the whole envelope", () => {
  test("shared constants: 16 KiB attestation sign budget, 256 KiB raw evidence cap", () => {
    assert.equal(SCOPE_ATTESTATION_MAX_CHARS, 16 * 1024);
    assert.equal(FEEDBACK_MACHINE_EVIDENCE_MAX_BYTES, 256 * 1024);
  });

  test("under the cap: every record kept, explicit truncated:false, dropped.overBytes 0, strict-parses", () => {
    const records = Array.from({ length: 20 }, (_, i) => record(i));
    const result = build(records);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.envelope.type, FEEDBACK_MACHINE_EVIDENCE_TYPE);
    assert.equal(result.envelope.schema_version, 1);
    assert.equal(result.envelope.feedbackTraceTail?.records.length, 20);
    assert.deepEqual(result.envelope.bounds, { maxBytes: FEEDBACK_MACHINE_EVIDENCE_MAX_BYTES, truncated: false, dropped: { overBytes: 0 } });
    assert.equal(result.bytes, utf8ByteLength(result.json));
    assert.deepEqual(parseFeedbackMachineEvidence(JSON.parse(result.json)), result.envelope);
  });

  test("exactly at the cap fits untouched; cap+1 (one byte over) truncates", () => {
    const records = Array.from({ length: 60 }, (_, i) => record(i));
    // Measure with a cap of the same digit count, because the marker's own
    // `"maxBytes":<n>` is part of the measured bytes.
    const probe = build(records, 99_999);
    assert.equal(probe.ok, true);
    if (!probe.ok) return;
    const size = probe.bytes;
    assert.ok(size > 10_000 && size < 99_999, `fixture size ${size} must be 5 digits`);

    const atCap = build(records, size);
    assert.equal(atCap.ok, true);
    if (!atCap.ok) return;
    assert.equal(atCap.bytes, size, "exactly at the cap");
    assert.equal(atCap.envelope.bounds.truncated, false);
    assert.equal(atCap.envelope.bounds.dropped.overBytes, 0);
    assert.equal(atCap.envelope.feedbackTraceTail?.records.length, 60);

    const overByOne = build(records, size - 1);
    assert.equal(overByOne.ok, true);
    if (!overByOne.ok) return;
    assert.ok(overByOne.bytes <= size - 1, `${overByOne.bytes} must be <= cap ${size - 1}`);
    assert.equal(overByOne.envelope.bounds.truncated, true);
    assert.equal(overByOne.envelope.bounds.dropped.overBytes, 1, "exactly the oldest record goes");
    assert.equal(overByOne.envelope.feedbackTraceTail?.records.length, 59);
    assert.deepEqual(overByOne.envelope.feedbackTraceTail?.records, records.slice(1));
  });

  test("truncation keeps the NEWEST records, contiguously, and the tail window describes what was kept", () => {
    const records = Array.from({ length: 200 }, (_, i) => record(i));
    const full = build(records);
    assert.equal(full.ok, true);
    if (!full.ok) return;
    const result = build(records, Math.floor(full.bytes / 2));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const kept = result.envelope.feedbackTraceTail!.records;
    assert.ok(kept.length > 0 && kept.length < 200);
    assert.deepEqual(kept, records.slice(200 - kept.length), "a contiguous newest suffix");
    assert.equal(result.envelope.bounds.dropped.overBytes, 200 - kept.length);
    assert.equal(result.envelope.feedbackTraceTail!.window.recordsEmitted, kept.length);
    assert.equal(result.envelope.feedbackTraceTail!.window.observedFrom, kept[0]!.startedAt);
    assert.ok(result.bytes <= Math.floor(full.bytes / 2));
    // The marker survives the strict parser.
    assert.deepEqual(parseFeedbackMachineEvidence(JSON.parse(result.json)).bounds, result.envelope.bounds);
  });

  test("the cap counts UTF-8 bytes, not string length (multibyte content)", () => {
    // Not a value the projection can produce; this pins the byte arithmetic.
    const wide = Array.from({ length: 10 }, (_, i) => ({ ...record(i), agentId: "é中\u{1F600}".repeat(20) }));
    const full = build(wide);
    assert.equal(full.ok, true);
    if (!full.ok) return;
    assert.ok(full.bytes > full.json.length, "multibyte content: bytes exceed UTF-16 length");
    // A cap between the char count and the byte count must truncate.
    const cap = full.json.length + Math.floor((full.bytes - full.json.length) / 2);
    const capped = build(wide, cap);
    assert.equal(capped.ok, true);
    if (!capped.ok) return;
    assert.equal(capped.envelope.bounds.truncated, true);
    assert.ok(utf8ByteLength(capped.json) <= cap);
  });

  test("a single record larger than the remaining budget is dropped (marked), summary and state still ship", () => {
    const base = build([]);
    assert.equal(base.ok, true);
    if (!base.ok) return;
    const huge = { ...record(0), agentId: "x".repeat(4096) };
    const result = build([huge], base.bytes + 1024);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.envelope.feedbackTraceTail!.records.length, 0);
    assert.equal(result.envelope.bounds.truncated, true);
    assert.equal(result.envelope.bounds.dropped.overBytes, 1);
    assert.deepEqual(result.envelope.observedFailureSummary, summary());
    assert.deepEqual(result.envelope.feedbackMachineState, STATE);
  });

  test("summary + state alone over the cap: explicitly not buildable (omitted), never silently emptied", () => {
    const base = build([]);
    assert.equal(base.ok, true);
    if (!base.ok) return;
    const cap = Math.floor(base.bytes / 2);
    const result = build([record(0)], cap);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "over_byte_cap");
    assert.equal(result.maxBytes, cap);
    assert.ok(result.bytes > result.maxBytes);
  });

  test("strict parser rejects free text, unknown keys, and an inconsistent marker", () => {
    const ok = build([record(0)]);
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    const good = JSON.parse(ok.json) as Record<string, unknown>;
    assert.throws(() => parseFeedbackMachineEvidence({ ...good, note: "free text" }));
    assert.throws(() => parseFeedbackMachineEvidence({ ...good, type: "trace" }));
    assert.throws(() => parseFeedbackMachineEvidence({ ...good, bounds: { maxBytes: FEEDBACK_MACHINE_EVIDENCE_MAX_BYTES, truncated: false, dropped: { overBytes: 3 } } }));
    assert.throws(() => parseFeedbackMachineEvidence({ ...good, bounds: { maxBytes: FEEDBACK_MACHINE_EVIDENCE_MAX_BYTES + 1, truncated: false, dropped: { overBytes: 0 } } }));
    const tainted = JSON.parse(ok.json) as { feedbackTraceTail: { records: Record<string, unknown>[] } };
    tainted.feedbackTraceTail.records[0]!.original_message = "free text";
    assert.throws(() => parseFeedbackMachineEvidence(tainted));
  });
});
