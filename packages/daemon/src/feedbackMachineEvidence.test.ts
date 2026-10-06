import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseFeedbackMachineState, parseFeedbackTraceTail } from "@botiverse/raft-shared";
import { DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES } from "../../shared/src/test/diagnosticRedactionCredentialSamples";
import { classifyDispatcherPath, collectFeedbackMachineState, collectFeedbackTraceTail, redactedOrNull } from "./feedbackMachineEvidence";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
async function tempDir(): Promise<string> { const d = await mkdtemp(path.join(tmpdir(), "feedback-evidence-")); dirs.push(d); return d; }

const WINDOW = { from: "2026-09-15T11:45:00.000Z", to: "2026-09-15T12:00:00.000Z" };
const SECRET = DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES[0]!.mustNotContain;

describe("feedback trace tail projection (task #279)", () => {
  test("emits only the fixed tuple: free-text attrs, stringified objects and unknown fields never reach the payload; values outside their enums are dropped", async () => {
    const machineDir = await tempDir();
    await mkdir(path.join(machineDir, "traces"), { recursive: true });
    const lines = [
      // Kabi's measured shape: a stringified-object attr and a free-text message.
      { type: "span", name: "daemon.runtime.process.exit", status: "error", start_time: "2026-09-15T11:50:00.000Z", end_time: "2026-09-15T11:50:01.000Z", duration_ms: 1000,
        attrs: { agentId: "agent-1", launchId: "launch-1", failure_reason: "model_not_found", original_message: `token ${SECRET}`, modelUsageJson: JSON.stringify({ prompt: 873, secret: SECRET }), error_class: "not-an-enum" } },
      // Unknown span name → "unknown"; out-of-vocabulary status → "unknown" (never "ok"); arbitrary text in an allowed field → dropped.
      { type: "span", name: `daemon.made.up.${SECRET}`, status: "weird", start_time: "2026-09-15T11:51:00.000Z", attrs: { agentId: SECRET, error_reason: SECRET } },
      // Outside the window.
      { type: "span", name: "daemon.connection.error", status: "error", start_time: "2026-09-15T13:00:00.000Z", attrs: {} },
      // Undatable.
      { type: "span", name: "daemon.connection.error", status: "error", attrs: {} },
    ];
    await writeFile(path.join(machineDir, "traces", "daemon-trace-a.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n`);
    const tail = await collectFeedbackTraceTail({ machineDir, window: WINDOW });
    const serialized = JSON.stringify(tail);
    assert.ok(!serialized.includes(SECRET), `secret leaked into payload: ${serialized}`);
    assert.ok(!serialized.includes("original_message") && !serialized.includes("modelUsageJson") && !serialized.includes("873"));
    assert.equal(tail.records.length, 2);
    assert.deepEqual(tail.records[0], {
      span: "daemon.runtime.process.exit", status: "error", startedAt: "2026-09-15T11:50:00.000Z", endedAt: "2026-09-15T11:50:01.000Z", durationMs: 1000,
      agentId: "agent-1", launchId: "launch-1", dispatchId: null, errorClass: null, errorReason: null, spawnFailureReason: "model_not_found",
    });
    assert.equal(tail.records[1]!.span, "unknown");
    assert.equal(tail.records[1]!.status, "unknown", "a missing or unknown status must not be reported as ok");
    assert.equal(tail.records[1]!.agentId, null, "arbitrary text in an allowed ID field is dropped");
    assert.equal(tail.records[1]!.errorReason, null);
    assert.deepEqual(tail.window.dropped, { unparseable: 1, undatable: 1, outsideWindow: 1, overCap: 0 });
    assert.equal(tail.window.recordsRead, 4);
    assert.equal(tail.window.completeness, "unknown");
    // Round-trips through the server's strict parser unchanged.
    assert.deepEqual(parseFeedbackTraceTail(JSON.parse(serialized)), tail);
    assert.deepEqual(redactedOrNull(tail), tail, "field-projected output passes the exit guard untouched");
  });

  test("missing trace directory → empty observed window, not an error; cap keeps the newest records", async () => {
    const machineDir = await tempDir();
    const empty = await collectFeedbackTraceTail({ machineDir, window: WINDOW });
    assert.equal(empty.records.length, 0);
    assert.equal(empty.window.observedFrom, null);
    await mkdir(path.join(machineDir, "traces"), { recursive: true });
    const many = Array.from({ length: 30 }, (_, i) => JSON.stringify({ name: "daemon.connection.error", status: "ok", start_time: `2026-09-15T11:5${Math.floor(i / 10)}:${String(i % 10).padStart(2, "0")}.000Z` }));
    await writeFile(path.join(machineDir, "traces", "daemon-trace-b.jsonl"), `${many.join("\n")}\n`);
    const capped = await collectFeedbackTraceTail({ machineDir, window: WINDOW, maxRecords: 5 });
    assert.equal(capped.records.length, 5);
    assert.equal(capped.window.dropped.overCap, 25);
    assert.equal(capped.records.at(-1)!.startedAt, "2026-09-15T11:52:09.000Z");
  });

  test("the strict parser rejects unknown fields and out-of-enum values", () => {
    const good = { window: { requestedFrom: WINDOW.from, requestedTo: WINDOW.to, observedFrom: null, observedTo: null, recordsRead: 0, recordsEmitted: 0, dropped: { unparseable: 0, undatable: 0, outsideWindow: 0, overCap: 0 }, completeness: "unknown" }, records: [] as unknown[] };
    assert.deepEqual(parseFeedbackTraceTail(good), good);
    for (const bad of [
      { ...good, records: [{ span: "daemon.connection.error", status: "ok", startedAt: WINDOW.from, endedAt: null, durationMs: null, agentId: null, launchId: null, dispatchId: null, errorClass: null, errorReason: null, spawnFailureReason: null, extra: SECRET }] },
      { ...good, records: [{ span: `x ${SECRET}`, status: "ok", startedAt: WINDOW.from }] },
      { ...good, records: [{ span: "daemon.connection.error", status: "weird", startedAt: WINDOW.from }] },
      { ...good, window: { ...good.window, completeness: true } },
      // A malformed (non-null) observed timestamp is not a legitimate null.
      { ...good, window: { ...good.window, observedFrom: "yesterday-ish" } },
      { ...good, window: { ...good.window, observedTo: "not-a-time" } },
    ]) {
      assert.throws(() => parseFeedbackTraceTail(bad), JSON.stringify(bad).slice(0, 80));
    }
  });
});

describe("feedback machine state (task #279)", () => {
  test("reports versions and kinds only; the dispatcher path itself is classified, never emitted", async () => {
    const home = await tempDir();
    const computerDir = path.join(home, "computer");
    await mkdir(path.join(computerDir, "k", "slots", "stable"), { recursive: true });
    await writeFile(path.join(computerDir, "service-version.json"), JSON.stringify({ version: "1.0.33", pid: 4242, role: "service" }));
    await writeFile(path.join(computerDir, "k", "slots", "stable", "VERSION"), "1.0.33\n");
    await writeFile(path.join(computerDir, "host-lifecycle-owner.json"), JSON.stringify({ formatVersion: 1, owner: "cli", enabled: true, dispatcherPath: "/private/var/folders/ab/T/tmp.X1/raft-computer", label: "x", definitionPath: null }));
    const state = await collectFeedbackMachineState({ slockHome: home, daemonVersion: "1.0.27" });
    assert.deepEqual(state, { daemonVersion: "1.0.27", computerServiceVersion: "1.0.33", kStableVersion: "1.0.33", hostLifecycleOwner: "cli", dispatcherPathKind: "temp" });
    assert.ok(!JSON.stringify(state).includes("/private/var/folders"));
    assert.deepEqual(parseFeedbackMachineState(state), state);
  });

  test("absent files → nulls and 'none'/'missing'; malformed versions are nulled not forwarded", async () => {
    const home = await tempDir();
    await mkdir(path.join(home, "computer"), { recursive: true });
    await writeFile(path.join(home, "computer", "service-version.json"), JSON.stringify({ version: `1.0.33 ${SECRET}` }));
    const state = await collectFeedbackMachineState({ slockHome: home, daemonVersion: "not a version" });
    assert.deepEqual(state, { daemonVersion: null, computerServiceVersion: null, kStableVersion: null, hostLifecycleOwner: "none", dispatcherPathKind: "missing" });
    assert.equal(classifyDispatcherPath(path.join(home, "computer", "k", "slots", "stable", "raft-computer"), home), "k_slot");
    assert.equal(classifyDispatcherPath("/Users/alice/.local/bin/raft-computer", home), "stable");
    assert.equal(classifyDispatcherPath("relative/raft-computer", home), "unknown");
    assert.throws(() => parseFeedbackMachineState({ ...state, extra: 1 }));
    assert.throws(() => parseFeedbackMachineState({ ...state, dispatcherPathKind: "/Users/alice/bin" }));
  });
});
