import type { AGENT_MIGRATION_STATES } from "@botiverse/raft-shared";

export type AgentMigrationState = (typeof AGENT_MIGRATION_STATES)[number];

// Steps follow what the owner can observe: the agent stops on the source,
// the source packs the workspace (the slow part), the files move, and the
// agent starts on the target. Transport setup is near-instant and not shown.
export const MIGRATION_PROGRESS_STEPS = [
  "agent.detail.migrationStepStopAgent",
  "agent.detail.migrationStepPackWorkspace",
  "agent.detail.migrationStepTransfer",
  "agent.detail.migrationStepStartOnTarget",
] as const;

export type AgentMigrationPhase = "active" | "completed" | "failed" | "canceled";

interface AgentMigrationStateInfo {
  phase: AgentMigrationPhase;
  /** Lowest progress step this state implies; notice timestamps can advance it. */
  step: number;
  cancellable: boolean;
}

// Exhaustive over the shared state union, so adding or removing a state is a
// compile error here rather than a silent fallthrough in the UI.
const AGENT_MIGRATION_STATE_INFO: Record<AgentMigrationState, AgentMigrationStateInfo> = {
  provisioning: { phase: "active", step: 0, cancellable: true },
  // Legacy enum value that is never written; presented as packing.
  prep: { phase: "active", step: 1, cancellable: true },
  ready: { phase: "active", step: 2, cancellable: true },
  in_transit: { phase: "active", step: 2, cancellable: true },
  arriving: { phase: "active", step: 3, cancellable: true },
  starting: { phase: "active", step: 3, cancellable: true },
  cancel_requested_pre_flip: { phase: "active", step: 0, cancellable: false },
  cancel_requested_post_flip: { phase: "active", step: 0, cancellable: false },
  canceled_pre_flip: { phase: "canceled", step: 0, cancellable: false },
  canceled_post_flip: { phase: "canceled", step: 0, cancellable: false },
  completed: { phase: "completed", step: MIGRATION_PROGRESS_STEPS.length, cancellable: false },
  aborted: { phase: "failed", step: 0, cancellable: false },
  failed: { phase: "failed", step: 0, cancellable: false },
};

// REST snapshots are not schema-validated, so an unknown state can still arrive.
function migrationStateInfo(state: string): AgentMigrationStateInfo | null {
  return Object.hasOwn(AGENT_MIGRATION_STATE_INFO, state)
    ? AGENT_MIGRATION_STATE_INFO[state as AgentMigrationState]
    : null;
}

export function migrationPhase(state: string): AgentMigrationPhase | null {
  return migrationStateInfo(state)?.phase ?? null;
}

export function isActiveMigrationState(state: string): boolean {
  return migrationPhase(state) === "active";
}

export function isCompletedMigrationState(state: string): boolean {
  return migrationPhase(state) === "completed";
}

export function isFailedMigrationState(state: string): boolean {
  return migrationPhase(state) === "failed";
}

export function isCanceledMigrationState(state: string): boolean {
  return migrationPhase(state) === "canceled";
}

export function canCancelMigration(notice: { state: string; revision?: number | null }): boolean {
  return migrationStateInfo(notice.state)?.cancellable === true
    && Number.isInteger(notice.revision) && (notice.revision ?? 0) > 0;
}

export function migrationProgressStep(notice: {
  state: string;
  sourceQuiescedAt?: string | null;
  transportControlRegisteredAt?: string | null;
  readyAt?: string | null;
  flippedAt?: string | null;
  arrivedAt?: string | null;
}): number {
  const step = migrationStateInfo(notice.state)?.step ?? 0;
  if (step === MIGRATION_PROGRESS_STEPS.length) return step;
  const observed = notice.arrivedAt || notice.flippedAt
    ? 3
    : notice.readyAt || notice.transportControlRegisteredAt
      ? 2
      : notice.sourceQuiescedAt
        ? 1
        : 0;
  return Math.max(step, observed);
}
