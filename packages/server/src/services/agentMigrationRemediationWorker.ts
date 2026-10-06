import { hostname } from "node:os";
import { currentDate, setClockInterval } from "@botiverse/raft-shared";
import type { Server as SocketServer } from "socket.io";
import type { AgentOrchestrator } from "./agentOrchestrator";
import {
  acknowledgeAgentMigrationCancellation,
  claimAgentMigrationAutoStartRemediation,
  claimAgentMigrationCancellationCleanup,
  claimAgentMigrationSourceArchiveRetry,
  completeAgentMigrationAutoStart,
  recordAgentMigrationAutoStartFailure,
  recordAgentMigrationSourceArchiveAttemptFailed,
  recordAgentMigrationSourceWorkspaceArchivedById,
  sweepElapsedAgentMigrationDeadline,
} from "./agentMigrationService";
import { emitAgentMigrationUpdated } from "./agentMigrationRealtime";
import { archiveMigrationSourceWorkspace } from "./agentMigrationSourceArchive";
import {
  classifyAgentMigrationRemediationDrain,
  createAgentMigrationWorkerObservability,
  type AgentMigrationWorkerObservability,
} from "./agentMigrationWorkerObservability";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
// Reads no longer abort expired migrations, so the sweep is the only abort path: drain a bounded batch per tick so a
// burst of expiries is persisted (receipt queued, grant freed) within one interval instead of one row per interval.
const MAX_DEADLINE_ABORTS_PER_TICK = 20;

interface AgentMigrationRemediationOperationalInput {
  io: SocketServer;
  orchestrator: AgentOrchestrator;
  workerId?: string;
}

export interface AgentMigrationRemediationWorkerInput extends AgentMigrationRemediationOperationalInput {
  intervalMs?: number;
  observability?: AgentMigrationWorkerObservability;
  drainRemediation?: typeof drainAgentMigrationRemediation;
}

export interface AgentMigrationRemediationDrainInput extends AgentMigrationRemediationOperationalInput {
  now?: Date;
}

async function remediateAutoStart(input: Required<Pick<AgentMigrationRemediationDrainInput, "io" | "orchestrator" | "workerId">> & {
  now: Date;
}): Promise<boolean> {
  const claim = await claimAgentMigrationAutoStartRemediation({
    workerId: input.workerId,
    now: input.now,
  });
  if (!claim) return false;
  if (claim.action === "terminal") {
    await emitAgentMigrationUpdated(input.io, claim.migration);
    return true;
  }

  let current = claim.migration;
  if (!input.orchestrator || typeof input.orchestrator.startAgent !== "function") {
    current = await recordAgentMigrationAutoStartFailure({
      migrationId: claim.migration.id,
      agentId: claim.migration.agentId,
      targetMachineId: claim.migration.targetMachineId,
      stage: "orchestrator",
      code: "orchestrator_unavailable",
      remediationLeaseId: claim.leaseId,
      now: input.now,
    });
    await emitAgentMigrationUpdated(input.io, current);
    return true;
  }

  try {
    const result = await input.orchestrator.startAgent(claim.migration.agentId);
    if (result.outcome !== "dispatched") {
      current = await recordAgentMigrationAutoStartFailure({
        migrationId: claim.migration.id,
        agentId: claim.migration.agentId,
        targetMachineId: claim.migration.targetMachineId,
        stage: "start_agent",
        code: "start_not_dispatched",
        remediationLeaseId: claim.leaseId,
        now: input.now,
      });
      await emitAgentMigrationUpdated(input.io, current);
      return true;
    }
    current = await completeAgentMigrationAutoStart({
      migrationId: claim.migration.id,
      agentId: claim.migration.agentId,
      targetMachineId: claim.migration.targetMachineId,
      remediationLeaseId: claim.leaseId,
      now: input.now,
    });
    await emitAgentMigrationUpdated(input.io, current);
    return true;
  } catch (error) {
    console.error("[AgentMigrationRemediation] auto-start dispatch failed:", error);
    current = await recordAgentMigrationAutoStartFailure({
      migrationId: claim.migration.id,
      agentId: claim.migration.agentId,
      targetMachineId: claim.migration.targetMachineId,
      stage: "start_agent",
      code: "start_threw",
      remediationLeaseId: claim.leaseId,
      now: input.now,
    });
    await emitAgentMigrationUpdated(input.io, current);
    return true;
  }
}

async function remediateCancellation(input: Required<Pick<AgentMigrationRemediationDrainInput, "io" | "orchestrator" | "workerId">> & {
  now: Date;
}): Promise<boolean> {
  const claim = await claimAgentMigrationCancellationCleanup({
    workerId: input.workerId,
    now: input.now,
  });
  if (!claim) return false;
  if (claim.dispatch === "none") {
    await emitAgentMigrationUpdated(input.io, claim.migration);
    return true;
  }

  let current = claim.migration;
  if (!input.orchestrator || typeof input.orchestrator.sendAgentMigrationCancel !== "function") {
    const sourceDelivery = claim.deliveries.find((delivery) => delivery.message.role === "source") ?? claim.deliveries[0];
    if (sourceDelivery) {
      current = await acknowledgeAgentMigrationCancellation({
        migrationId: current.id,
        migrationRef: current.supportRef,
        transportGeneration: current.cancelTransportGeneration!,
        cancelGeneration: current.cancelGeneration!,
        serverId: current.serverId,
        machineId: sourceDelivery.machineId,
        role: sourceDelivery.message.role,
        outcome: "needs_attention",
        cleanupLeaseId: claim.leaseId,
        errorCode: "cancel_dispatch_unavailable",
        errorMessage: "Migration cancellation dispatch is unavailable",
        now: input.now,
      });
      await emitAgentMigrationUpdated(input.io, current);
    }
    return true;
  }

  const results = await Promise.allSettled(claim.deliveries.map((delivery) =>
    input.orchestrator.sendAgentMigrationCancel(delivery.machineId, delivery.message)
  ));
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === "fulfilled") continue;
    const delivery = claim.deliveries[index]!;
    current = await acknowledgeAgentMigrationCancellation({
      migrationId: current.id,
      migrationRef: current.supportRef,
      transportGeneration: current.cancelTransportGeneration!,
      cancelGeneration: current.cancelGeneration!,
      serverId: current.serverId,
      machineId: delivery.machineId,
      role: delivery.message.role,
      outcome: "needs_attention",
      cleanupLeaseId: claim.leaseId,
      errorCode: "cancel_dispatch_failed",
      errorMessage: result.reason instanceof Error ? result.reason.message : String(result.reason),
      now: input.now,
    });
    await emitAgentMigrationUpdated(input.io, current);
  }
  return true;
}

async function sweepDeadline(input: Pick<AgentMigrationRemediationDrainInput, "io" | "orchestrator"> & {
  now: Date;
}): Promise<boolean> {
  let swept = false;
  for (let index = 0; index < MAX_DEADLINE_ABORTS_PER_TICK; index += 1) {
    // The aborted receipt is queued inside the abort transaction; the lifecycle event is emitted here, once, by the
    // worker that won the abort.
    const aborted = await sweepElapsedAgentMigrationDeadline({ now: input.now });
    if (!aborted) break;
    swept = true;
    await emitAgentMigrationUpdated(input.io, aborted);
    if (typeof input.orchestrator?.recordAgentMigrationAborted === "function") {
      try {
        await input.orchestrator.recordAgentMigrationAborted(aborted, input.now);
      } catch (error) {
        console.error(`[AgentMigrationRemediation] migration_aborted lifecycle emit failed for ${aborted.id}:`, error);
      }
    }
  }
  return swept;
}

async function retrySourceArchive(input: Pick<AgentMigrationRemediationDrainInput, "io" | "orchestrator"> & {
  now: Date;
}): Promise<boolean> {
  const claim = await claimAgentMigrationSourceArchiveRetry({ now: input.now });
  if (!claim) return false;
  if (claim.action === "abandoned") {
    await emitAgentMigrationUpdated(input.io, claim.migration);
    return true;
  }
  const result = await archiveMigrationSourceWorkspace(input.orchestrator, {
    sourceMachineId: claim.migration.sourceMachineId,
    migrationId: claim.migration.id,
    agentId: claim.migration.agentId,
    migrationCreatedAt: claim.migration.createdAt,
  });
  const updated = result.ok
    ? await recordAgentMigrationSourceWorkspaceArchivedById({ migrationId: claim.migration.id, now: input.now })
    : await recordAgentMigrationSourceArchiveAttemptFailed({
        migrationId: claim.migration.id,
        errorCode: result.errorCode,
        now: input.now,
      });
  if (updated) await emitAgentMigrationUpdated(input.io, updated);
  return true;
}

export async function drainAgentMigrationRemediation(input: AgentMigrationRemediationDrainInput): Promise<{
  autoStart: boolean;
  cancellation: boolean;
  deadline: boolean;
  sourceArchive: boolean;
}> {
  const now = input.now ?? currentDate();
  const workerId = input.workerId ?? `server:${hostname()}`;
  const autoStart = await remediateAutoStart({
    io: input.io,
    orchestrator: input.orchestrator,
    workerId,
    now,
  });
  const cancellation = await remediateCancellation({
    io: input.io,
    orchestrator: input.orchestrator,
    workerId,
    now,
  });
  const deadline = await sweepDeadline({ io: input.io, orchestrator: input.orchestrator, now });
  const sourceArchive = await retrySourceArchive({ io: input.io, orchestrator: input.orchestrator, now });
  return { autoStart, cancellation, deadline, sourceArchive };
}

export function startAgentMigrationRemediationWorker(input: AgentMigrationRemediationWorkerInput): { stop(): void } {
  let stopped = false;
  let running = false;
  const observability = input.observability ?? createAgentMigrationWorkerObservability({
    worker: "remediation",
  });
  const drainRemediation = input.drainRemediation ?? drainAgentMigrationRemediation;
  observability.startup();
  const drain = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await drainRemediation({
        io: input.io,
        orchestrator: input.orchestrator,
        workerId: input.workerId,
      });
      observability.drain(classifyAgentMigrationRemediationDrain(result));
    } catch (error) {
      observability.drain("failed", error);
      console.error("[AgentMigrationRemediation] Failed to drain remediation queues:", error);
    } finally {
      running = false;
    }
  };
  const timer = setClockInterval(() => void drain(), input.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
  void drain();
  return {
    stop() {
      stopped = true;
      clearInterval(timer as ReturnType<typeof setInterval>);
    },
  };
}
