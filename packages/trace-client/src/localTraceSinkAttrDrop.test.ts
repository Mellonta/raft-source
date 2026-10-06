import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BasicTracer } from "@botiverse/raft-shared";
import { LocalRotatingTraceSink } from "./localTraceSink";

// Task #422 — `sanitizeAttrs` removes attributes with no trace at all, so a
// field that never reaches disk is indistinguishable from one nobody set. The
// stock is already non-zero: `session_id` and `start_dispatch_id` are on every
// daemon span via processLifecycleIdentityAttrs and both are dropped, while
// `session_id_present` survives and claims they were there.
//
// Every assertion here reads the JSONL back off disk. Asserting on the object
// handed to the tracer would pass with the bug fully intact, because the drop
// happens after that point.

async function writeSpanAndReadBack(
  attrs: Record<string, unknown>,
): Promise<{ sink: LocalRotatingTraceSink; written: Record<string, unknown>; dir: string; machineDir: string }> {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-422-"));
  const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
  const tracer = new BasicTracer({ sink });
  tracer.startSpan("daemon.probe", { surface: "daemon", kind: "internal", attrs: attrs as never }).end("ok");

  const dir = path.join(machineDir, "traces");
  let written: Record<string, unknown> = {};
  for (const name of readdirSync(dir)) {
    const text = await readFile(path.join(dir, name), "utf8");
    for (const line of text.split("\n").filter((l) => l.length > 0)) {
      const record = JSON.parse(line) as { name?: string; attrs?: Record<string, unknown> };
      if (record.name === "daemon.probe") written = record.attrs ?? {};
    }
  }
  return { sink, written, dir, machineDir };
}

test("#422 an allowlist miss is counted by name, and the value really is gone from disk", async () => {
  const { sink, written, machineDir } = await writeSpanAndReadBack({
    feedbackReportId: "report-1",
    some_other_id: "other-1",
    agent_id: "agent-1",
  });
  try {
    // The premise: these are gone. If this ever stops holding, the counter
    // below is measuring something else and the test should say so here.
    assert.ok(!("feedbackReportId" in written), "precondition: feedbackReportId is dropped today");
    assert.ok(!("start_dispatch_id" in written), "precondition: start_dispatch_id is dropped today");
    assert.equal(written.agent_id, "agent-1", "control: an allowlisted id survives");

    const stats = sink.getWriteFailureStats();
    assert.equal(stats.droppedAttrsByReason.id_not_allowlisted, 2);
    assert.equal(stats.droppedAttrNames.feedbackReportId, 1);
    assert.equal(stats.droppedAttrNames.some_other_id, 1);
    assert.equal(stats.droppedAttrNamesOverflow, 0);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#422 secret-like and content-like drops are counted but never named", async () => {
  const { sink, written, machineDir } = await writeSpanAndReadBack({
    api_key: "sk-secret",
    prompt: "user text",
    feedbackReportId: "report-1",
  });
  try {
    assert.ok(!("api_key" in written) && !("prompt" in written), "both must be gone from disk");

    const stats = sink.getWriteFailureStats();
    assert.equal(stats.droppedAttrsByReason.secret_like, 1);
    assert.equal(stats.droppedAttrsByReason.content_like, 1);
    assert.equal(stats.droppedAttrsByReason.id_not_allowlisted, 1);

    // Only the actionable reason records names. Accumulating the names of
    // secret-like keys is the thing the filter exists to avoid.
    assert.deepEqual(Object.keys(stats.droppedAttrNames), ["feedbackReportId"]);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#422 an empty or absent value is not reported as a drop", async () => {
  const { sink, machineDir } = await writeSpanAndReadBack({
    some_id: "",
    other_id: null,
    third_id: undefined,
    agent_id: "agent-1",
  });
  try {
    const stats = sink.getWriteFailureStats();
    assert.equal(
      stats.droppedAttrsByReason.id_not_allowlisted,
      0,
      "values that were never carrying anything are not losses and must not inflate the count",
    );
    assert.deepEqual(stats.droppedAttrNames, {});
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#422 the name table is bounded and says so when it overflows", async () => {
  const attrs: Record<string, unknown> = {};
  for (let i = 0; i < 50; i += 1) attrs[`key${i}_id`] = `v${i}`;
  const { sink, machineDir } = await writeSpanAndReadBack(attrs);
  try {
    const stats = sink.getWriteFailureStats();
    // Totals stay exact even when the name table is full.
    assert.equal(stats.droppedAttrsByReason.id_not_allowlisted, 50);
    assert.equal(Object.keys(stats.droppedAttrNames).length, 32);
    assert.equal(stats.droppedAttrNamesOverflow, 18, "the names we could not keep are counted, not lost");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#422 a healthy span drops nothing and the counters stay at zero", async () => {
  const { sink, written, machineDir } = await writeSpanAndReadBack({
    agent_id: "a",
    machine_id: "m",
    uploadId: "u",
    outcome: "ok",
    duration_ms_bucket: "0-1s",
  });
  try {
    assert.equal(Object.keys(written).length, 5, "nothing should have been removed");
    const stats = sink.getWriteFailureStats();
    assert.deepEqual(stats.droppedAttrsByReason, {
      secret_like: 0, path_like: 0, content_like: 0, id_not_allowlisted: 0, session_hash_unavailable: 0,
    });
    assert.deepEqual(stats.droppedAttrNames, {});
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#422 drops inside span events are counted too, not just span attrs", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-422-ev-"));
  try {
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
    const tracer = new BasicTracer({ sink });
    const span = tracer.startSpan("daemon.probe", { surface: "daemon", kind: "internal" });
    span.addEvent("runtime.thing", { feedbackReportId: "report-1" } as never);
    span.end("ok");

    const stats = sink.getWriteFailureStats();
    assert.equal(stats.droppedAttrsByReason.id_not_allowlisted, 1, "event attrs go through the same sanitizer");
    assert.equal(stats.droppedAttrNames.feedbackReportId, 1);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

// @Kabi's real sample: `daemon.agent.inbox.dropped_on_exit` shipped an
// `exit_path` attribute that the `path` rule removed silently. It was invisible
// in the first survey because that only looked at the id family — so the label
// has to say which rule fired, not merely that something was dropped.
test("#422 a path-rule drop is labelled as such, not lumped in with content", async () => {
  const { sink, written, machineDir } = await writeSpanAndReadBack({
    exit_path: "shutdown",
    prompt: "text",
    agent_id: "a",
  });
  try {
    assert.ok(!("exit_path" in written), "precondition: the path rule removes it today");
    const stats = sink.getWriteFailureStats();
    assert.equal(stats.droppedAttrsByReason.path_like, 1);
    assert.equal(stats.droppedAttrsByReason.content_like, 1);
    assert.equal(stats.droppedAttrsByReason.id_not_allowlisted, 0);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

// @Stone: reset the name table per report window, so a window that filled the
// table cannot keep a newly dropped key out of the next one. @Leiysky: assert
// the REVERSE too — that the new name is absent from the first report — since
// asserting only its presence in the second would also pass for an
// implementation that never clears and merely had room left.
test("#422 the name table is per window, and the window really is cleared", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-422-window-"));
  try {
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
    const tracer = new BasicTracer({ sink });

    // Window 1: fill the table past its cap.
    const filling: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) filling[`w1key${i}_id`] = `v${i}`;
    tracer.startSpan("daemon.w1", { surface: "daemon", kind: "internal", attrs: filling as never }).end("ok");

    const first = sink.drainAttrDropReport();
    assert.equal(first.windowByReason.id_not_allowlisted, 40, "the window total is exact even when names are not");
    assert.equal(Object.keys(first.windowNames).length, 32);
    assert.equal(first.windowNamesFull, true, "a full table must say so, or the list reads as complete");
    assert.ok(!("brand_new_id" in first.windowNames), "reverse: the second window's key is not in the first report");

    // Window 2: a brand-new key must be nameable despite window 1 filling up.
    tracer.startSpan("daemon.w2", { surface: "daemon", kind: "internal", attrs: { brand_new_id: "x" } as never }).end("ok");

    const second = sink.drainAttrDropReport();
    assert.deepEqual(Object.keys(second.windowNames), ["brand_new_id"], "the new window starts empty");
    assert.equal(second.windowByReason.id_not_allowlisted, 1, "the window figure is a delta, not a running total");
    assert.equal(second.windowNamesFull, false);

    // Cumulative totals stay exact across both windows.
    assert.equal(second.cumulativeByReason.id_not_allowlisted, 41);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#422 draining an untouched sink reports an empty window, not a missing one", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-422-empty-"));
  try {
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
    const report = sink.drainAttrDropReport();
    assert.deepEqual(report.windowNames, {});
    assert.equal(report.windowNamesFull, false);
    assert.equal(report.windowByReason.id_not_allowlisted, 0);
    assert.equal(report.cumulativeByReason.id_not_allowlisted, 0);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});
