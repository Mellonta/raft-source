import type { Request } from "express";
import type { Server as SocketServer } from "socket.io";

/**
 * Tell every open client on the server that an agent's stored profile changed.
 * The payload carries only the id: each client re-reads the agent list through
 * `GET /api/agents`, which applies that viewer's own visibility rules.
 */
export function broadcastAgentUpdated(req: Request, serverId: string, agentId: string): void {
  const io = req.app.get("io") as SocketServer | undefined;
  io?.to(`server:${serverId}`).emit("agent:updated", { agentId });
}
