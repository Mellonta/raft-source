// LEGACY: inferring an agent's instance state from its activity (RFC 069 §8).
//
// Applies only to daemons that do NOT advertise `agent:status-sequenced`.
// Those daemons drop `agent:status` sent while disconnected and replay only
// activity, so after a reconnect the server had to treat live activity as
// evidence that the runtime exists (#1819, task #120). Daemons with the
// capability report state only on sequenced `agent:status`, and their
// activity changes display only.
//
// Delete this file, its caller branch in `reduceDaemonActivityLifecycle`, and
// `legacyActivityStateInference.test.ts` once no supported daemon lacks
// `agent:status-sequenced`.

import type { AgentActivity } from "@botiverse/raft-shared";
import type { LifecycleDbStatusProjection, LifecycleRuntimeState } from "./agentLifecycleReducer";

/** The runtime state a legacy daemon's activity implies. */
export function legacyRuntimeStateFromActivity(activity: AgentActivity): LifecycleRuntimeState {
  if (activity === "thinking" || activity === "working") return activity;
  if (activity === "error") return "crashed";
  if (activity === "offline") return "interrupted";
  return "running_idle";
}

/**
 * State effects of one legacy activity frame: the implied runtime state, and
 * restoring an inactive agent to active when the activity shows a live runtime.
 */
export function legacyActivityStateProjection(input: {
  activity: AgentActivity;
  state: { dbStatus: string; runtimeState: LifecycleRuntimeState };
}): {
  sideEffects: { updateCache: { runtimeState: LifecycleRuntimeState; status?: "active" } };
  dbStatus: LifecycleDbStatusProjection;
} {
  const liveRuntimeActivity =
    input.activity === "online" || input.activity === "thinking" || input.activity === "working";
  const shouldRestoreActiveStatus = input.state.dbStatus === "inactive" && liveRuntimeActivity;
  const runtimeState = legacyRuntimeStateFromActivity(input.activity);
  return {
    sideEffects: {
      updateCache: {
        runtimeState,
        ...(shouldRestoreActiveStatus ? { status: "active" as const } : {}),
      },
    },
    dbStatus: shouldRestoreActiveStatus
      ? {
          kind: "apply",
          status: "active",
          writer: "signal",
          attrs: {
            activity_status: input.activity,
            legacy_status: input.state.dbStatus,
            runtime_state: input.state.runtimeState,
          },
        }
      : {
          kind: "skip",
          skippedReason: "daemon_activity_does_not_change_db_status",
          attrs: { activity_status: input.activity },
        },
  };
}
