// LEGACY (RFC 069 §8): activity from daemons without `agent:status-sequenced`
// still drives instance state (#1819, task #120). These assertions are moved
// verbatim from agentLifecycleReducer.test.ts; delete this file together with
// legacyActivityStateInference.ts.
import assert from "node:assert/strict";
import { createAgentLifecycleEvent } from "./agentLifecycleEvents";
import { buildAgentLifecycleStateSnapshot, reduceDaemonActivityLifecycle } from "./agentLifecycleReducer";
import { legacyRuntimeStateFromActivity } from "./legacyActivityStateInference";

function lifecycleEvent(overrides: Partial<Parameters<typeof createAgentLifecycleEvent>[0]> = {}) {
  return createAgentLifecycleEvent(
    {
      serverId: "server-1",
      agentId: "agent-1",
      machineId: "machine-1",
      eventType: "runtime_interrupted",
      actor: "daemon",
      source: "ready_reconcile",
      reason: "daemon_restart",
      correlationId: "correlation-1",
      occurredAt: "2026-05-13T00:00:00.000Z",
      ...overrides,
    },
    { createId: () => "event-1" },
  );
}

function state(input: Parameters<typeof buildAgentLifecycleStateSnapshot>[0]) {
  return buildAgentLifecycleStateSnapshot({
    machineId: "machine-1",
    ...input,
  });
}

test("daemon activity reducer restores inactive agents when live runtime activity resumes", () => {
  const plan = reduceDaemonActivityLifecycle({
    action: "broadcast-activity",
    activity: "thinking",
    detail: "Resumed output",
    detailKind: "daemon_activity",
    event: lifecycleEvent(),
    state: state({ dbStatus: "inactive", runtimeState: "thinking" }),
  });

  assert.deepEqual(plan.sideEffects, { updateCache: { runtimeState: "thinking", status: "active" } });
  assert.deepEqual(plan.dbStatus, {
    kind: "apply",
    status: "active",
    writer: "signal",
    attrs: {
      activity_status: "thinking",
      legacy_status: "inactive",
      runtime_state: "thinking",
    },
  });
  assert.deepEqual(plan.wakeEligibility, { eligible: true });
  assert.equal(plan.liveActivity.kind, "emit");
  assert.equal(plan.activityLog.labelKind, "daemon_activity");
});


test("daemon activity reducer does not restore inactive agents from offline or error activity", () => {
  for (const activity of ["offline", "error"] as const) {
    const plan = reduceDaemonActivityLifecycle({
      action: "broadcast-activity",
      activity,
      detail: activity,
      detailKind: activity === "offline" ? "stopped" : "runtime_error",
      event: lifecycleEvent(),
      state: state({ dbStatus: "inactive", runtimeState: activity === "offline" ? "interrupted" : "crashed" }),
    });

    assert.deepEqual(plan.sideEffects, {
      updateCache: { runtimeState: activity === "offline" ? "interrupted" : "crashed" },
    });
    assert.deepEqual(plan.dbStatus, {
      kind: "skip",
      skippedReason: "daemon_activity_does_not_change_db_status",
      attrs: { activity_status: activity },
    });
  }
});

test("legacy activity implies a runtime state", () => {
  assert.deepEqual(
    (["online", "thinking", "working", "error", "offline"] as const).map(legacyRuntimeStateFromActivity),
    ["running_idle", "thinking", "working", "crashed", "interrupted"],
  );
});
