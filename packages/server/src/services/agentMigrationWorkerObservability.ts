import { randomUUID } from "node:crypto";
import { currentDate } from "@botiverse/raft-shared";
import { readBuildIdentityStatus, SERVER_VERSION, type BuildIdentityStatus } from "../version";
import { errorClassOf } from "../tracing/semanticTrace";

export type AgentMigrationWorkerName = "receipt_outbox" | "remediation";
export type AgentMigrationWorkerDrainOutcome = "empty" | "served" | "failed";

export type AgentMigrationWorkerObservation = {
  event: "startup" | "drain" | "receipt_retry_exhausted";
  worker: AgentMigrationWorkerName;
  outcome: "started" | AgentMigrationWorkerDrainOutcome | "parked";
  observed_at: string;
  runtime_id: string;
  server_version: string;
  release_identity: "available" | "unavailable";
  release_sha: string | null;
  release_branch: string | null;
  release_built_at: string | null;
  /**
   * Identity of the exception behind an outcome=failed transition. Bounded
   * (exception name or typeof); present only on failure observations that
   * carry one. Repeated failures stay heartbeat-bounded — per the drain
   * contract, this classifies the transition, it does not count occurrences.
   */
  error_class?: string;
  /** receipt_retry_exhausted only: the parked outbox row (ids, never content). */
  outbox_id?: string;
  migration_id?: string;
  receipt_kind?: string;
  attempt_count?: number;
  /** Code-shaped last delivery error, or "unclassified". */
  last_error_code?: string;
};

export interface AgentMigrationReceiptRetryExhaustion {
  outboxId: string;
  migrationId: string;
  receiptKind: string;
  attemptCount: number;
  lastError: string | null;
}

export interface AgentMigrationWorkerObservability {
  startup(): void;
  drain(outcome: AgentMigrationWorkerDrainOutcome, error?: unknown): void;
  /** A receipt outbox row hit its retry cap and is parked. Emitted once per row, never bounded. */
  receiptRetryExhausted?(row: AgentMigrationReceiptRetryExhaustion): void;
}

const DEFAULT_OUTCOME_HEARTBEAT_MS = 5 * 60_000;
const PROCESS_RUNTIME_ID = randomUUID();

function observationIdentity(status: BuildIdentityStatus): Pick<
  AgentMigrationWorkerObservation,
  "release_identity" | "release_sha" | "release_branch" | "release_built_at"
> {
  if (!status.ok) {
    return {
      release_identity: "unavailable",
      release_sha: null,
      release_branch: null,
      release_built_at: null,
    };
  }
  return {
    release_identity: "available",
    release_sha: status.identity.sha,
    release_branch: status.identity.branch,
    release_built_at: status.identity.builtAt,
  };
}

function defaultEmit(observation: AgentMigrationWorkerObservation): void {
  if (observation.event === "receipt_retry_exhausted") {
    console.warn("[AgentMigrationWorker]", JSON.stringify(observation));
    return;
  }
  console.info("[AgentMigrationWorker]", JSON.stringify(observation));
}

const ERROR_CODE_SHAPE = /^[A-Za-z0-9_:.-]{1,160}$/;

/**
 * Emits a privacy-safe lifecycle signal for one worker instance.
 *
 * Drain success is a bounded heartbeat rather than a poll log: the first
 * outcome is emitted immediately and later empty/served outcomes are emitted
 * no more than once per heartbeat window. A transition into failed emits
 * immediately, while repeated failures are also bounded. Instrumentation is
 * best-effort and can never change worker scheduling or drain behavior.
 */
export function createAgentMigrationWorkerObservability(input: {
  worker: AgentMigrationWorkerName;
  now?: () => Date;
  runtimeId?: string;
  serverVersion?: string;
  buildIdentity?: BuildIdentityStatus;
  outcomeHeartbeatMs?: number;
  emit?: (observation: AgentMigrationWorkerObservation) => void;
}): AgentMigrationWorkerObservability {
  const now = input.now ?? currentDate;
  const runtimeId = input.runtimeId ?? PROCESS_RUNTIME_ID;
  const serverVersion = input.serverVersion ?? SERVER_VERSION;
  const buildIdentity = input.buildIdentity ?? readBuildIdentityStatus();
  const outcomeHeartbeatMs = input.outcomeHeartbeatMs ?? DEFAULT_OUTCOME_HEARTBEAT_MS;
  const emit = input.emit ?? defaultEmit;
  let startupEmitted = false;
  let lastDrainOutcome: AgentMigrationWorkerDrainOutcome | null = null;
  let lastDrainEmittedAtMs: number | null = null;

  const emitSafely = (
    event: AgentMigrationWorkerObservation["event"],
    outcome: AgentMigrationWorkerObservation["outcome"],
    observedAt: Date,
    error?: unknown,
    extra: Partial<AgentMigrationWorkerObservation> = {},
  ) => {
    const observation: AgentMigrationWorkerObservation = {
      event,
      worker: input.worker,
      outcome,
      observed_at: observedAt.toISOString(),
      runtime_id: runtimeId,
      server_version: serverVersion,
      ...observationIdentity(buildIdentity),
      ...(error === undefined ? {} : { error_class: errorClassOf(error) }),
      ...extra,
    };
    try {
      emit(observation);
    } catch {
      // Observability must never change worker authority or scheduling.
    }
  };

  return {
    startup() {
      if (startupEmitted) return;
      startupEmitted = true;
      emitSafely("startup", "started", now());
    },
    drain(outcome, error) {
      const observedAt = now();
      const elapsedMs = lastDrainEmittedAtMs === null
        ? Number.POSITIVE_INFINITY
        : observedAt.getTime() - lastDrainEmittedAtMs;
      const enteringFailure = outcome === "failed" && lastDrainOutcome !== "failed";
      if (elapsedMs < outcomeHeartbeatMs && !enteringFailure) {
        return;
      }
      lastDrainOutcome = outcome;
      lastDrainEmittedAtMs = observedAt.getTime();
      emitSafely("drain", outcome, observedAt, error);
    },
    receiptRetryExhausted(row) {
      emitSafely("receipt_retry_exhausted", "parked", now(), undefined, {
        outbox_id: row.outboxId,
        migration_id: row.migrationId,
        receipt_kind: row.receiptKind,
        attempt_count: row.attemptCount,
        last_error_code: row.lastError && ERROR_CODE_SHAPE.test(row.lastError) ? row.lastError : "unclassified",
      });
    },
  };
}

export function classifyAgentMigrationReceiptDrain(input: {
  attempted: number;
  sent: number;
  failed: number;
}): AgentMigrationWorkerDrainOutcome {
  if (input.failed > 0) return "failed";
  if (input.attempted > 0 || input.sent > 0) return "served";
  return "empty";
}

export function classifyAgentMigrationRemediationDrain(input: {
  autoStart: boolean;
  cancellation: boolean;
  deadline: boolean;
  sourceArchive: boolean;
}): AgentMigrationWorkerDrainOutcome {
  return input.autoStart || input.cancellation || input.deadline || input.sourceArchive ? "served" : "empty";
}
