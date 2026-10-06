import type { ServerToMachineMessage } from "@botiverse/raft-shared";
import { serverMachineContextCapabilities } from "../runtimeOutcomeOutboxIngest";

type MachineContextSocket = {
  send(data: string): void;
};

/**
 * The connection route has already authenticated both identities. Send this
 * before registration can replay any queued Agent/App work to the machine.
 * `capabilities` is omitted when the server advertises none, so the frame is
 * unchanged for every daemon until a capability is switched on.
 */
export function sendAuthenticatedMachineContext(
  ws: MachineContextSocket,
  context: { machineId: string; serverId: string },
  capabilities: readonly string[] = serverMachineContextCapabilities(),
): void {
  const message = {
    type: "machine:context",
    machineId: context.machineId,
    serverId: context.serverId,
    ...(capabilities.length > 0 ? { capabilities: [...capabilities] } : {}),
  } satisfies ServerToMachineMessage;
  ws.send(JSON.stringify(message));
}
