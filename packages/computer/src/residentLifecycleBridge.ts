import { currentTimeMs, type ComputerLifecycleExecutionAck } from "@botiverse/raft-shared";
import { readInstallerUpgradeEvidence } from "./externalInstaller";
import { COMPUTER_VERSION } from "./version";
import {
  acknowledgeLifecycleReceipt,
  readPendingLifecycleAcknowledgements,
  retireCompletedUpgradeShutdownsFromLog,
} from "./lifecycleOperations";
import { pendingRestartRequestIdForServer, readPendingRestartMarker } from "./restartMarker";
import { isProcessAlive } from "./internal/process-primitives";
import {
  readMachineServiceAttestation,
  waitForRestartConvergence,
} from "./machineServiceAttestation";
import type { MachineServiceAttestation } from "./lib/types";

export interface ResidentLifecycleBridge {
  supervisorMutationsAttested: boolean;
  getAcknowledgements(): ComputerLifecycleExecutionAck[];
  getReadyAcknowledgements(): Promise<ComputerLifecycleExecutionAck[]>;
  acknowledgeReceipt(operationId: string, phase: "shutdown" | "ready"): Promise<void>;
}

/** Bind a durable installer proof to the currently running successor. */
export function bindUpgradeReadyAcknowledgement(input: {
  acknowledgement: ComputerLifecycleExecutionAck;
  service: MachineServiceAttestation | null;
  proof: { targetVersion: string; deadProcessIdentities: string[] } | null;
  isAlive?: (pid: number) => boolean;
}): ComputerLifecycleExecutionAck | null {
  const { acknowledgement: ack, service, proof } = input;
  if (ack.action !== "upgrade" || !service || service.computerVersion !== COMPUTER_VERSION) return null;
  if (!proof || proof.targetVersion !== service.computerVersion || !proof.deadProcessIdentities.length
    || (ack.loadedComputerVersion !== undefined && ack.loadedComputerVersion !== service.computerVersion)) return null;
  if (!(input.isAlive ?? isProcessAlive)(service.servicePid)) return null;
  return {
    ...ack,
    serviceGeneration: service.serviceGeneration,
    managedSetRevision: service.managedSetRevision,
    oldProcessIdentitiesDead: true,
    deadProcessIdentities: proof.deadProcessIdentities,
  };
}

async function getReadyAcknowledgements(
  slockHome: string,
  serverId: string,
): Promise<ComputerLifecycleExecutionAck[]> {
  const pending = readPendingLifecycleAcknowledgements(
    slockHome,
    serverId,
    undefined,
    COMPUTER_VERSION,
  );
  const shutdown = pending.filter((ack) => ack.phase === "shutdown");
  const ready = pending.filter((ack) => ack.phase === "ready");
  if (ready.length === 0) return [];
  const pendingRestart = await readPendingRestartMarker(slockHome);
  const restart = await waitForRestartConvergence(slockHome, pendingRestart);
  const finalService = await readMachineServiceAttestation(slockHome);

  const readyResults = await Promise.all(ready.map(async (ack) => {
    if (pendingRestart && pendingRestartRequestIdForServer(pendingRestart, serverId) === ack.operationId) {
      if (!restart || !finalService || finalService.serviceGeneration !== restart.serviceGeneration) return [];
      return [{
        ...ack,
        serviceGeneration: restart.serviceGeneration,
        managedSetRevision: restart.managedSetRevision,
        oldProcessIdentitiesDead: true,
        deadProcessIdentities: restart.deadProcessIdentities,
      }];
    }
    const id = ack.operationId ?? ack.requestId;
    const proof = id ? await readInstallerUpgradeEvidence(slockHome, id) : null;
    const bound = bindUpgradeReadyAcknowledgement({ acknowledgement: ack, service: finalService, proof });
    return bound ? [bound] : [];
  }));
  return [...shutdown, ...readyResults.flat()];
}

export async function prepareResidentLifecycleBridge(
  slockHome: string,
  serverId: string,
): Promise<ResidentLifecycleBridge> {
  await retireCompletedUpgradeShutdownsFromLog(slockHome, serverId);
  const initialService = await readMachineServiceAttestation(slockHome);
  const supervisorMutationsAttested = Boolean(
    initialService
    && initialService.computerVersion === COMPUTER_VERSION
    && isProcessAlive(initialService.servicePid),
  );
  return {
    supervisorMutationsAttested,
    getAcknowledgements: () => readPendingLifecycleAcknowledgements(
      slockHome,
      serverId,
      undefined,
      COMPUTER_VERSION,
    ),
    getReadyAcknowledgements: () => getReadyAcknowledgements(slockHome, serverId),
    acknowledgeReceipt: async (operationId, phase) => {
      await acknowledgeLifecycleReceipt(slockHome, serverId, operationId, phase);
    },
  };
}
