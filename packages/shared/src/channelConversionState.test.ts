import assert from "node:assert/strict";
import { conversionStateBlocksSending, projectConversionState } from "./channelConversionState";
import type { ChannelConversionCommandView, ChannelConversionJobView } from "./channelConversionState";

const command: ChannelConversionCommandView = { id: "command", kind: "start", status: "completed", jobId: "job" };
const job: ChannelConversionJobView = { id: "job", status: "running", phase: "prepare_threads" };

test("command completion never means that the longer-lived job completed", () => {
  const state = projectConversionState(command, job);
  assert.equal(state.status, "running");
  assert.equal(state.job?.phase, "prepare_threads");
  assert.equal(conversionStateBlocksSending(state), true);
});

test("a rejected action preserves an existing job and its write block", () => {
  for (const status of ["pending", "running", "failed"] as const) {
    const state = projectConversionState({ ...command, kind: "cancel", status: "failed", error: "Cannot cancel" }, { ...job, status });
    assert.equal(state.status, status === "failed" ? "failed" : "running");
    assert.equal(conversionStateBlocksSending(state), true);
  }
  const rejectedStart = projectConversionState({ ...command, status: "failed", jobId: null }, null);
  assert.equal(rejectedStart.status, "failed");
  assert.equal(conversionStateBlocksSending(rejectedStart), false);
});

test("admission dominates old failure and terminal snapshots", () => {
  for (const kind of ["start", "retry", "cancel"] as const) {
    for (const previous of [null, { ...job, status: "failed" as const }, { ...job, status: "canceled" as const }]) {
      const state = projectConversionState({ ...command, kind, status: "pending" }, previous);
      assert.equal(state.status, "pending");
      assert.equal(conversionStateBlocksSending(state), true);
    }
  }
});

test("completed Cancel cannot override a newer active job; canceled is not done", () => {
  const cancel = { ...command, kind: "cancel" as const, jobId: "old-job" };
  assert.equal(projectConversionState(cancel, job).status, "running");
  const canceled = projectConversionState(cancel, { ...job, id: "old-job", status: "canceled", phase: "done" });
  assert.equal(canceled.status, "canceled");
  assert.equal(conversionStateBlocksSending(canceled), false);
  const done = projectConversionState(command, { ...job, status: "done", phase: "done" });
  assert.equal(done.status, "done");
  assert.equal(conversionStateBlocksSending(done), false);
  assert.equal(projectConversionState(null, null).status, "idle");
});

test("a failed conversion that was compensated restores the ordinary write state", () => {
  const restored = projectConversionState(command, {
    ...job,
    status: "failed",
    progress: { rollbackState: "restored" },
  });
  assert.equal(restored.status, "failed");
  assert.equal(conversionStateBlocksSending(restored), false);
});
