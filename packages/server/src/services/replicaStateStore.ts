import {
  registerMachineReplica,
  restoreMachineReplicaGeneration,
  unregisterMachineReplica,
  refreshMachineReplica,
  hasMachineReplica,
  getMachineReplicaOwner,
  getMachineReplicaTraceContext,
  bumpMachineStatusVersion,
  getMachineStatusVersion,
  acquireWakeLock,
  releaseWakeLock,
  setAgentActivity,
  getAgentActivity,
  getWakeCrashLoopState,
  compareAndSetWakeCrashLoopState,
  setAgentRuntimeError,
  getAgentRuntimeError,
  setMachineMeta,
  getMachineMeta,
  clearMachineMeta,
  type MachineMeta,
  type AgentRuntimeErrorMirror,
} from "../replicaRouter";
import { isRedisAvailable } from "../redis";
import type {
  AgentActivityDetailKind,
  AgentActivityKind,
  DeliveryConsumptionActivityDiagnostic,
  WakeCrashLoopActivityDiagnostic,
  SpawnFailureActivityDiagnostic,
} from "@botiverse/raft-shared";

/**
 * task #1116: typed observation carriers that ride the shared activity
 * snapshot so a non-owner replica's refresh read-back exposes the same
 * diagnostic the owner's socket frame showed. Ids, classes, counts and times
 * only; a later write without a carrier clears it.
 */
export interface PersistedActivityTypedCarriers {
  deliveryConsumption?: DeliveryConsumptionActivityDiagnostic;
  /** task #1119: the wake crash-loop breaker state, when the snapshot is wake_crash_loop_blocked. */
  wakeCrashLoop?: WakeCrashLoopActivityDiagnostic;
  /** task #1123: rides a runtime_unavailable write from a failed start. */
  spawnFailure?: SpawnFailureActivityDiagnostic;
}

export interface PersistedAgentActivity {
  activity: AgentActivityKind;
  detail: string;
  detailKind: AgentActivityDetailKind;
  observedAtMs?: number;
  updatedAt: number;
  carriers?: PersistedActivityTypedCarriers;
}
import type { AgentRuntimeErrorState } from "@botiverse/raft-shared";
import type { WakeCrashLoopEpisodeState, WakeCrashLoopStateRecord } from "./wakeCrashLoopBreaker";
import type { MachineConnectTraceContext } from "../tracing/migrationTraceContext";

export type { MachineMeta, AgentRuntimeErrorMirror };

export interface ReplicaStateStore {
  isAvailable(): boolean;
  registerMachineReplica(machineId: string, traceContext?: MachineConnectTraceContext): Promise<string>;
  restoreMachineReplicaGeneration(
    machineId: string,
    generation: string,
    traceContext?: MachineConnectTraceContext,
  ): Promise<void>;
  unregisterMachineReplica(machineId: string, expectedGeneration?: string): Promise<void>;
  refreshMachineReplica(
    machineId: string,
    traceContext?: MachineConnectTraceContext,
    expectedGeneration?: string,
  ): Promise<void>;
  hasMachineReplica(machineId: string): Promise<boolean>;
  getMachineReplicaOwner(machineId: string): Promise<string | null>;
  getMachineReplicaTraceContext?(machineId: string): Promise<Partial<MachineConnectTraceContext> | null>;
  bumpMachineStatusVersion(machineId: string): Promise<number>;
  getMachineStatusVersion(machineId: string): Promise<number>;
  acquireWakeLock(agentId: string): Promise<boolean>;
  releaseWakeLock(agentId: string): Promise<void>;
  setAgentActivity(
    agentId: string,
    activity: AgentActivityKind,
    detail: string,
    detailKind: AgentActivityDetailKind,
    observedAtMs?: number,
    carriers?: PersistedActivityTypedCarriers,
  ): Promise<void>;
  getAgentActivity(agentId: string): Promise<PersistedAgentActivity | null>;
  setAgentRuntimeError(agentId: string, error: AgentRuntimeErrorState | null): Promise<void>;
  getAgentRuntimeError(agentId: string): Promise<AgentRuntimeErrorMirror | null>;
  /**
   * task #1119: wake crash-loop breaker episode state, shared across replicas.
   * `compareAndSet` writes only when the stored version equals `expectedVersion`
   * (0 when absent) so read→apply→write is atomic against concurrent writers.
   */
  getWakeCrashLoopState(agentId: string): Promise<WakeCrashLoopStateRecord | null>;
  compareAndSetWakeCrashLoopState(agentId: string, expectedVersion: number, state: WakeCrashLoopEpisodeState): Promise<boolean>;
  setMachineMeta(machineId: string, meta: MachineMeta): Promise<void>;
  getMachineMeta(machineId: string): Promise<MachineMeta | null>;
  clearMachineMeta(machineId: string): Promise<void>;
}

export const redisReplicaStateStore: ReplicaStateStore = {
  isAvailable: () => isRedisAvailable(),
  registerMachineReplica,
  restoreMachineReplicaGeneration,
  unregisterMachineReplica,
  refreshMachineReplica,
  hasMachineReplica,
  getMachineReplicaOwner,
  getMachineReplicaTraceContext,
  bumpMachineStatusVersion,
  getMachineStatusVersion,
  acquireWakeLock,
  releaseWakeLock,
  setAgentActivity,
  getAgentActivity,
  getWakeCrashLoopState,
  compareAndSetWakeCrashLoopState,
  setAgentRuntimeError,
  getAgentRuntimeError,
  setMachineMeta,
  getMachineMeta,
  clearMachineMeta,
};
