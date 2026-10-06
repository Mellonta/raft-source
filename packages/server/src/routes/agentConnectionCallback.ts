/**
 * `GET /api/connections/callback/:serverId/:agentId` — where a hosted runtime
 * provider returns the browser after an account-connection OAuth round trip
 * (raft-agent-provider.v1 connections extension). The provider only accepts
 * return URLs under this Raft's API origin, so this route just forwards the
 * allowlisted outcome (`connection`, `status`, `by`) to the web landing page
 * `/connections/callback`, which checks `by` against the signed-in user.
 * Unauthenticated by design: it reads and writes nothing.
 */
import { Router, type Router as RouterType } from "express";
import { buildAgentConnectionLandingUrl } from "../services/agentConnectionService";

export const agentConnectionCallbackRouter: RouterType = Router();

agentConnectionCallbackRouter.get("/callback/:serverId/:agentId", (req, res) => {
  const landing = buildAgentConnectionLandingUrl({
    serverId: req.params.serverId,
    agentId: req.params.agentId,
    query: req.query as Record<string, unknown>,
  });
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (!landing) {
    res.status(404).json({ error: "Unknown connection callback" });
    return;
  }
  res.redirect(302, landing);
});
