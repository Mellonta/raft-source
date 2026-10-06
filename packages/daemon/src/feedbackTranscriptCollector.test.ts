import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { BasicTracer, MemoryTraceSink, type FeedbackMachineState, type FeedbackTraceTail, type ObservedFailureSummary } from "@botiverse/raft-shared";
import { collectFeedbackTranscriptAttachment, type FeedbackTranscriptCollectionResult } from "./feedbackTranscriptCollector";

const TRACE_TAIL: FeedbackTraceTail = {
  window: { requestedFrom: "2026-09-15T11:45:00.000Z", requestedTo: "2026-09-15T12:00:00.000Z", observedFrom: "2026-09-15T11:50:00.000Z", observedTo: "2026-09-15T11:50:00.000Z", recordsRead: 1, recordsEmitted: 1, dropped: { unparseable: 0, undatable: 0, outsideWindow: 0, overCap: 0 }, completeness: "unknown" },
  records: [{ span: "daemon.runtime.process.exit", status: "error", startedAt: "2026-09-15T11:50:00.000Z", endedAt: null, durationMs: null, agentId: "agent-1", launchId: "launch-1", dispatchId: null, errorClass: null, errorReason: null, spawnFailureReason: null }],
};
const MACHINE_STATE: FeedbackMachineState = { daemonVersion: "1.0.27", computerServiceVersion: "1.0.33", kStableVersion: "1.0.33", hostLifecycleOwner: "cli", dispatcherPathKind: "stable" };

const TRANSCRIPT = '{"type":"message","time":"2026-09-15T12:10:00.000Z","text":"hello"}';

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
      excluded: { unparseable: 0, undatable: 1, otherAgent: 1 },
      completeness: "unknown",
    },
    failures: [
      {
        span: "daemon.connection.error",
        count: 1,
        firstAt: "2026-09-15T11:50:00.000Z",
        lastAt: "2026-09-15T11:50:00.000Z",
        attribution: "machine-wide",
      },
    ],
  };
}

const DIAGNOSTIC_KEYS = ["observedFailureSummary", "feedbackTraceTail", "feedbackMachineState"] as const;

interface Captured {
  /** Metadata the daemon asked the server to sign, per attachment kind. */
  transcriptMetadata: Record<string, unknown> | null;
  evidenceMetadata: Record<string, unknown> | null;
  transcriptUploadedBytes: number | null;
  evidenceBody: Record<string, unknown> | null;
  evidenceWorkerCreates: number;
  evidencePuts: number;
}

type EvidenceFault = "server_500" | "server_drops_kind" | "worker_create_500" | "worker_no_ack" | "put_400" | "hang";

function harness(options: {
  getObservedFailureSummary: (window: { from: string; to: string }) => Promise<ObservedFailureSummary | null>;
  getMachineEvidence?: (window: { from: string; to: string }) => Promise<{ traceTail: FeedbackTraceTail | null; machineState: FeedbackMachineState | null }>;
  evidenceFault?: EvidenceFault;
  machineEvidenceWaitMs?: number;
  machineEvidenceMaxBytes?: number;
}): { run: () => Promise<FeedbackTranscriptCollectionResult>; captured: Captured } {
  const captured: Captured = {
    transcriptMetadata: null,
    evidenceMetadata: null,
    transcriptUploadedBytes: null,
    evidenceBody: null,
    evidenceWorkerCreates: 0,
    evidencePuts: 0,
  };
  const fault = options.evidenceFault;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body;
    if (url.includes("/internal/machine/scope-attestation")) {
      const parsed = JSON.parse(String(body)) as { metadata: Record<string, unknown> };
      const evidence = parsed.metadata.feedbackAttachmentKind === "machine_evidence";
      if (evidence) {
        captured.evidenceMetadata = parsed.metadata;
        if (fault === "hang") return new Promise<Response>(() => {});
        if (fault === "server_500") return json({ error: "boom" }, 500);
      } else {
        captured.transcriptMetadata = parsed.metadata;
      }
      const signed: Record<string, unknown> = { ...parsed.metadata, uploadId: evidence ? "upload-ev" : "upload-1", objectKey: "k" };
      if (evidence && fault === "server_drops_kind") delete signed.feedbackAttachmentKind;
      return json({
        attestation: evidence ? `signed-evidence${fault === "server_drops_kind" ? "-nokind" : ""}` : "signed-transcript",
        scope: "daemon-trace-bundle:create",
        audience: "trace-ingest-worker",
        resource: "servers/s/machines/m/trace-bundles",
        metadata: signed,
      });
    }
    if (url.endsWith("/api/trace-bundles")) {
      const parsed = JSON.parse(String(body)) as { attestation: string };
      if (parsed.attestation.startsWith("signed-evidence")) {
        captured.evidenceWorkerCreates += 1;
        if (fault === "worker_create_500") return json({ error: "Internal server error" }, 500);
        return json({
          id: "bundle-evidence-1",
          ...(fault === "worker_no_ack" || parsed.attestation.endsWith("-nokind") ? {} : { feedbackAttachmentKind: "machine_evidence" }),
          upload: { url: "https://worker.test/put-evidence", method: "PUT", headers: {} },
        });
      }
      return json({
        id: "bundle-session-1",
        feedbackAttachmentKind: "session_transcript",
        upload: { url: "https://worker.test/put", method: "PUT", headers: {} },
      });
    }
    if (url.endsWith("/put-evidence")) {
      captured.evidencePuts += 1;
      if (fault === "put_400") return json({ error: "bundleSha256 mismatch" }, 400);
      const bytes = Buffer.from(await (body as Blob).arrayBuffer());
      captured.evidenceBody = JSON.parse(gunzipSync(bytes).toString("utf8")) as Record<string, unknown>;
      return new Response("", { status: 200 });
    }
    // The transcript's signed PUT.
    captured.transcriptUploadedBytes = typeof body === "object" && body !== null && "size" in body
      ? (body as Blob).size
      : null;
    return new Response("", { status: 200 });
  };

  const run = () =>
    collectFeedbackTranscriptAttachment({
      agentId: "agent-1",
      feedbackReportId: "report-1",
      reportWindow: {
        reportGeneratedAt: "2026-09-15T12:00:00.000Z",
        reportTimeSource: "server_request_received",
      },
      getSessionTranscript: async () => ({
        runtime: "claude",
        sessionId: "session-1",
        reachable: true,
        transcript: TRANSCRIPT,
        sizeBytes: Buffer.byteLength(TRANSCRIPT, "utf8"),
        // The reader classified these bytes as the runtime's own file (task #1228 ①).
        transcriptContent: "native_session_file",
      }),
      getObservedFailureSummary: options.getObservedFailureSummary,
      getMachineEvidence: options.getMachineEvidence ?? (async () => ({ traceTail: null, machineState: null })),
      serverUrl: "https://server.test",
      daemonApiKey: "key",
      workerUrl: "https://worker.test",
      tracer: new BasicTracer({ sink: new MemoryTraceSink() }),
      fetchImpl: fetchImpl as never,
      ...(options.machineEvidenceWaitMs !== undefined ? { machineEvidenceWaitMs: options.machineEvidenceWaitMs } : {}),
      ...(options.machineEvidenceMaxBytes !== undefined ? { machineEvidenceMaxBytes: options.machineEvidenceMaxBytes } : {}),
    });

  return { run, captured };
}

function assertTranscriptStored(result: FeedbackTranscriptCollectionResult, captured: Captured): void {
  assert.equal(result.reachable, true);
  assert.equal(result.error, undefined, `transcript must not fail: ${result.error}`);
  assert.equal(result.traceBundleId, "bundle-session-1");
  assert.ok((captured.transcriptUploadedBytes ?? 0) > 0, "transcript bundle must be uploaded");
}

describe("feedback transcript upload: the transcript attestation carries no diagnostics", () => {
  test("none of the three diagnostic fields, and no digest of them, ride in the transcript attestation", async () => {
    const { run, captured } = harness({
      getObservedFailureSummary: async () => summary(),
      getMachineEvidence: async () => ({ traceTail: TRACE_TAIL, machineState: MACHINE_STATE }),
    });
    const result = await run();
    assertTranscriptStored(result, captured);
    for (const key of DIAGNOSTIC_KEYS) {
      assert.equal(key in (captured.transcriptMetadata ?? {}), false, `${key} must not be in the transcript attestation`);
    }
    assert.doesNotMatch(Object.keys(captured.transcriptMetadata ?? {}).join(","), /evidence|digest/i);
    assert.notEqual(captured.transcriptMetadata?.feedbackAttachmentKind, "machine_evidence");
  });

  test("the transcript body is still exactly the transcript", async () => {
    const { run, captured } = harness({ getObservedFailureSummary: async () => summary() });
    await run();
    assert.equal(captured.transcriptMetadata?.bundleContentType, "application/json");
    assert.equal(captured.transcriptMetadata?.agentId, "agent-1");
    assert.equal(captured.transcriptMetadata?.feedbackReportId, "report-1");
  });
});

describe("feedback transcript upload: machine_evidence is a separate, separately signed attachment", () => {
  test("summary, trace tail and machine state ship verbatim in the evidence object, bound to report, agent and its own sha", async () => {
    const seen: { from: string; to: string }[] = [];
    const expected = summary();
    const { run, captured } = harness({
      getObservedFailureSummary: async (window) => { seen.push(window); return expected; },
      getMachineEvidence: async (window) => { seen.push(window); return { traceTail: TRACE_TAIL, machineState: MACHINE_STATE }; },
    });
    const result = await run();
    assertTranscriptStored(result, captured);
    assert.equal(result.machineEvidence?.status, "uploaded");
    assert.equal(result.machineEvidence?.traceBundleId, "bundle-evidence-1");
    // Same window as the transcript: one report, one period.
    assert.equal(seen.length, 2);
    for (const window of seen) {
      assert.equal(window.to, "2026-09-15T12:00:00.000Z");
      assert.ok(Date.parse(window.from) < Date.parse(window.to));
    }
    const meta = captured.evidenceMetadata!;
    assert.equal(meta.feedbackAttachmentKind, "machine_evidence");
    assert.equal(meta.feedbackReportId, "report-1");
    assert.equal(meta.agentId, "agent-1");
    assert.match(String(meta.bundleSha256), /^[0-9a-f]{64}$/);
    for (const key of DIAGNOSTIC_KEYS) assert.equal(key in meta, false, `${key} travels in the object, not the attestation`);
    const body = captured.evidenceBody!;
    assert.equal(body.type, "feedback_machine_evidence");
    assert.equal(body.schema_version, 1);
    assert.equal(body.feedbackReportId, "report-1");
    assert.equal(body.agentId, "agent-1");
    assert.equal(JSON.stringify(body.observedFailureSummary), JSON.stringify(expected), "verbatim module output");
    assert.deepEqual(body.feedbackTraceTail, TRACE_TAIL);
    assert.deepEqual(body.feedbackMachineState, MACHINE_STATE);
    assert.deepEqual(body.bounds, { maxBytes: 256 * 1024, truncated: false, dropped: { overBytes: 0 } });
  });

  test("a throwing summary provider does not take the transcript down; the evidence reports the gap", async () => {
    const { run, captured } = harness({
      getObservedFailureSummary: async () => { throw new Error("trace dir exploded"); },
      getMachineEvidence: async () => ({ traceTail: TRACE_TAIL, machineState: MACHINE_STATE }),
    });
    const result = await run();
    assertTranscriptStored(result, captured);
    assert.equal(result.machineEvidence?.status, "uploaded");
    assert.deepEqual(result.machineEvidence?.unavailable, ["observedFailureSummary"]);
    assert.equal(captured.evidenceBody?.observedFailureSummary, null);
  });

  test("a summary provider that throws SYNCHRONOUSLY is reported like an async failure; the transcript proceeds", async () => {
    const { run, captured } = harness({
      getObservedFailureSummary: () => { throw new Error("synthetic generation failure"); },
      getMachineEvidence: async () => ({ traceTail: TRACE_TAIL, machineState: MACHINE_STATE }),
    });
    const result = await run();
    assertTranscriptStored(result, captured);
    assert.deepEqual(result.machineEvidence?.unavailable, ["observedFailureSummary"]);
  });

  test("an evidence provider that throws SYNCHRONOUSLY is reported like an async failure; the transcript proceeds", async () => {
    const { run, captured } = harness({
      getObservedFailureSummary: async () => null,
      getMachineEvidence: () => { throw new Error("synthetic generation failure"); },
    });
    const result = await run();
    assertTranscriptStored(result, captured);
    assert.deepEqual(result.machineEvidence?.unavailable, ["feedbackTraceTail", "feedbackMachineState"]);
  });

  test("building the evidence envelope throws: outcome = failed, the transcript result is kept", async () => {
    const { run, captured } = harness({
      getObservedFailureSummary: async () => null,
      // A BigInt makes JSON serialisation of the envelope throw.
      getMachineEvidence: async () => ({ traceTail: TRACE_TAIL, machineState: { ...MACHINE_STATE, poison: 1n } as unknown as FeedbackMachineState }),
    });
    const result = await run();
    assertTranscriptStored(result, captured);
    assert.equal(result.machineEvidence?.status, "failed");
    assert.match(result.machineEvidence?.error ?? "", /BigInt/);
  });

  test("a diagnostics failure arriving after the bounded wait never becomes an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { run, captured } = harness({
        getObservedFailureSummary: async () => null,
        getMachineEvidence: async () => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return { traceTail: TRACE_TAIL, machineState: { ...MACHINE_STATE, poison: 1n } as unknown as FeedbackMachineState };
        },
        machineEvidenceWaitMs: 20,
      });
      const result = await run();
      assertTranscriptStored(result, captured);
      assert.equal(result.machineEvidence?.status, "timeout");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("a throwing evidence provider leaves tail and state null, reported, and the transcript proceeds", async () => {
    const { run, captured } = harness({
      getObservedFailureSummary: async () => null,
      getMachineEvidence: async () => { throw new Error("traces unreadable"); },
    });
    const result = await run();
    assertTranscriptStored(result, captured);
    assert.deepEqual(result.machineEvidence?.unavailable, ["feedbackTraceTail", "feedbackMachineState"]);
  });

  for (const fault of ["server_500", "worker_create_500", "put_400"] as const) {
    test(`evidence upload failure (${fault}) never blocks the transcript and is reported, not swallowed`, async () => {
      const { run, captured } = harness({
        getObservedFailureSummary: async () => summary(),
        getMachineEvidence: async () => ({ traceTail: TRACE_TAIL, machineState: MACHINE_STATE }),
        evidenceFault: fault,
      });
      const result = await run();
      assertTranscriptStored(result, captured);
      assert.equal(result.machineEvidence?.status, "failed");
      assert.match(result.machineEvidence?.error ?? "", fault === "put_400" ? /400/ : /500/);
    });
  }

  test("evidence upload that never answers: the transcript result returns within the bounded wait, outcome = timeout", async () => {
    const { run, captured } = harness({
      getObservedFailureSummary: async () => summary(),
      getMachineEvidence: async () => ({ traceTail: TRACE_TAIL, machineState: MACHINE_STATE }),
      evidenceFault: "hang",
      machineEvidenceWaitMs: 50,
    });
    const started = Date.now();
    const result = await run();
    assert.ok(Date.now() - started < 5_000, "bounded wait");
    assertTranscriptStored(result, captured);
    assert.equal(result.machineEvidence?.status, "timeout");
    assert.match(result.machineEvidence?.error ?? "", /50ms/);
  });

  test("evidence GENERATION that never finishes also cannot hold the transcript result", async () => {
    const { run, captured } = harness({
      getObservedFailureSummary: () => new Promise(() => {}),
      getMachineEvidence: () => new Promise(() => {}),
      machineEvidenceWaitMs: 50,
    });
    const result = await run();
    assertTranscriptStored(result, captured);
    assert.equal(result.machineEvidence?.status, "timeout");
  });

  test("worker without machine_evidence support (no kind acknowledgement): explicit unsupported, nothing PUT", async () => {
    const { run, captured } = harness({
      getObservedFailureSummary: async () => summary(),
      evidenceFault: "worker_no_ack",
    });
    const result = await run();
    assertTranscriptStored(result, captured);
    assert.equal(result.machineEvidence?.status, "unsupported");
    assert.match(result.machineEvidence?.error ?? "", /machine_evidence/);
    assert.equal(captured.evidencePuts, 0, "an unacknowledged kind must never be uploaded as an untyped bundle");
  });

  test("server that drops the machine_evidence kind: explicit unsupported, never handed to the worker", async () => {
    const { run, captured } = harness({
      getObservedFailureSummary: async () => summary(),
      evidenceFault: "server_drops_kind",
    });
    const result = await run();
    assertTranscriptStored(result, captured);
    assert.equal(result.machineEvidence?.status, "unsupported");
    assert.equal(captured.evidenceWorkerCreates, 0);
    assert.equal(captured.evidencePuts, 0);
  });

  test("summary + state alone over the byte cap: evidence explicitly omitted, transcript unaffected", async () => {
    const { run, captured } = harness({
      getObservedFailureSummary: async () => summary(),
      getMachineEvidence: async () => ({ traceTail: TRACE_TAIL, machineState: MACHINE_STATE }),
      machineEvidenceMaxBytes: 200,
    });
    const result = await run();
    assertTranscriptStored(result, captured);
    assert.equal(result.machineEvidence?.status, "omitted");
    assert.equal(result.machineEvidence?.reason, "over_byte_cap");
    assert.equal(captured.evidenceMetadata, null, "nothing to sign");
  });
});

// task #272 tier 2: unlike tier 1, the machine log tail IS a toggle by ruling.
// It must run only on explicit opt-in, on the transcript's window, and even
// when the transcript itself is unreachable.
describe("feedback transcript upload: tier-2 machine log tail opt-in", () => {
  function tailHarness(options: { include: boolean; transcriptReachable?: boolean }) {
    const calls: { from: string; to: string }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("/internal/machine/scope-attestation")) {
        const parsed = JSON.parse(String(init?.body)) as { metadata: Record<string, unknown> };
        return new Response(JSON.stringify({
          attestation: "signed", scope: "daemon-trace-bundle:create", audience: "trace-ingest-worker",
          resource: "r", metadata: { ...parsed.metadata, uploadId: "u", objectKey: "k" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/api/trace-bundles")) {
        return new Response(JSON.stringify({ id: "bundle-session-1", upload: { url: "https://worker.test/put", method: "PUT", headers: {} } }),
          { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("", { status: 200 });
    };
    const reachable = options.transcriptReachable ?? true;
    const run = () => collectFeedbackTranscriptAttachment({
      agentId: "agent-1",
      feedbackReportId: "report-1",
      reportWindow: { reportGeneratedAt: "2026-09-15T12:00:00.000Z", reportTimeSource: "server_request_received" },
      getSessionTranscript: async () => reachable
        ? { runtime: "claude", sessionId: "s", reachable: true, transcript: TRANSCRIPT, sizeBytes: TRANSCRIPT.length, transcriptContent: "native_session_file" as const }
        : { runtime: "claude", sessionId: "s", reachable: false, fallbackReason: "runtime not running", transcript: null, sizeBytes: 0 },
      getObservedFailureSummary: async () => null,
      getMachineEvidence: async () => ({ traceTail: null, machineState: null }),
      machineLogTail: {
        include: options.include,
        collect: async (window) => {
          calls.push(window);
          return { reachable: true, traceBundleId: "bundle-tail-1", lineCount: 3, sourceLineCount: 3, truncated: false };
        },
      },
      serverUrl: "https://server.test",
      daemonApiKey: "key",
      workerUrl: "https://worker.test",
      tracer: new BasicTracer({ sink: new MemoryTraceSink() }),
      fetchImpl: fetchImpl as never,
    });
    return { run, calls };
  }

  test("not opted in → the tail collector is never invoked and no tail outcome is reported", async () => {
    const { run, calls } = tailHarness({ include: false });
    const result = await run();
    assert.equal(calls.length, 0);
    assert.equal("machineLogTail" in result, false);
  });

  test("opted in → collected once on the transcript's own window and reported beside the transcript", async () => {
    const { run, calls } = tailHarness({ include: true });
    const result = await run();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.to, "2026-09-15T12:00:00.000Z");
    assert.ok(Date.parse(calls[0]!.from) < Date.parse(calls[0]!.to));
    assert.equal(result.machineLogTail?.traceBundleId, "bundle-tail-1");
  });

  test("opted in with an unreachable transcript → the tail still ships, on the report-anchored fallback window", async () => {
    const { run, calls } = tailHarness({ include: true, transcriptReachable: false });
    const result = await run();
    assert.equal(result.reachable, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.to, "2026-09-15T12:00:00.000Z");
    assert.equal(calls[0]!.from, "2026-09-15T11:45:00.000Z");
    assert.equal(result.machineLogTail?.traceBundleId, "bundle-tail-1");
  });
});
