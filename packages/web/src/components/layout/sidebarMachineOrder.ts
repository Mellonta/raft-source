import type { Machine } from "../../store/machineStore";

// Order of the sidebar's Computers list (task #124 follow-up, WAWQAQ: "my
// computer is no longer at the top"). The server returns machines in an
// arbitrary order; what a user wants first is the computer they are sitting at,
// then the computers they attached themselves, then everyone else's.
//
//   1. the host-pinned machine (a native shell knows which machine IS this
//      device — the desktop pins it; the web never pins anything itself),
//   2. computers attached by the current user (server-derived flag),
//   3. the rest,
// each group keeping the server's relative order (stable).
export function orderSidebarMachineIds(
  machines: readonly Pick<Machine, "id" | "computerAttachedByCurrentUser">[],
  pinnedMachineId: string | null | undefined,
): string[] {
  const pinned: string[] = [];
  const mine: string[] = [];
  const rest: string[] = [];
  for (const machine of machines) {
    if (pinnedMachineId && machine.id === pinnedMachineId) pinned.push(machine.id);
    else if (machine.computerAttachedByCurrentUser) mine.push(machine.id);
    else rest.push(machine.id);
  }
  return [...pinned, ...mine, ...rest];
}
