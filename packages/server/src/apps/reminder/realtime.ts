import type { Server as SocketServer } from "socket.io";
import type { ReminderSummary } from "@botiverse/raft-shared";

import { roleCanInspectAgentPrivateSurfaces } from "../../lib/actorPermissions";
import * as agentService from "../../services/agentService";
import { socketServerAllRooms } from "../../socket/platformScope";
import { serializeErrorForLog } from "../../tracing/safeErrorLog";
import type { ReminderRow } from "./service";

/** The live Reminders-tab events. Wire names and payload shapes are fixed by
 * deployed web clients (AgentDetailPanel); the canceled payload is derived
 * from the row here so no call site can send a different shape. */
export type ReminderRealtimeEvent =
  | { type: "reminder:scheduled"; reminder: ReminderSummary }
  | { type: "reminder:canceled" };

/**
 * A reminder is one of the owner agent's private surfaces: its summary carries
 * the title, the anchor message permalink and the target channel. Deliver the
 * event only to connections of users who may inspect that agent, i.e. the same
 * rule as the HTTP listing (`editAgents` on the current server role, or the
 * agent's human creator), instead of the whole server room.
 *
 * Runs per replica over local sockets (`io.local`), like channel publication,
 * because the decision is per socket. Each server-attached socket carries its
 * `serverRole` from the handshake, and every human role change or membership
 * removal revokes the user's sockets, so that role is the current one; the
 * rule therefore needs no query per socket. The reminder mutation is already
 * committed when this runs, so a degraded publication is logged rather than
 * failing the request (a retry would duplicate the mutation).
 */
export async function publishReminderEvent(
  io: SocketServer | null | undefined,
  row: Pick<ReminderRow, "id" | "serverId" | "ownerAgentId">,
  event: ReminderRealtimeEvent,
): Promise<void> {
  if (!io) return;
  try {
    const agent = await agentService.getAgent(row.ownerAgentId, true);
    if (!agent || agent.serverId !== row.serverId) return;
    const payload = event.type === "reminder:scheduled"
      ? { reminder: event.reminder }
      : { reminderId: row.id, ownerAgentId: row.ownerAgentId };
    const sockets = await io.local.in(socketServerAllRooms(row.serverId)).fetchSockets();
    const decisions = new Map<string, boolean>();
    for (const socket of sockets) {
      const { userId, serverRole } = socket.data;
      if (typeof userId !== "string" || socket.data.accessRevoked) continue;
      let allowed = decisions.get(userId);
      if (allowed === undefined) {
        allowed = roleCanInspectAgentPrivateSurfaces(serverRole, userId, agent);
        decisions.set(userId, allowed);
      }
      if (allowed) socket.emit(event.type, payload);
    }
  } catch (error) {
    console.error(`[reminder] ${event.type} publication degraded for ${row.id}:`, serializeErrorForLog(error));
  }
}
