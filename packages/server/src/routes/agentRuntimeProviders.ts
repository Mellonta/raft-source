/**
 * `GET /api/agent-runtime-providers/:kind` — read-only availability probe for
 * the create-agent dialog (raft-agent-provider.v1). Today the only kind is
 * `antiproton`.
 *
 * The provider is configured once per deployment (base URL fixed by
 * DEPLOYMENT_ENV + the ANTIPROTON_PROVISIONING_TOKEN secret) and enabled per server
 * by the `antiproton_hosted_runtime` feature flag. The answer is
 * `{kind, available}` and exposes nothing about the configuration.
 */
import { Router, type Response, type Router as RouterType } from "express";
import { isAgentRuntimeProviderKind, type AgentRuntimeProviderAvailabilityView } from "@botiverse/raft-shared";
import { actorHasServerCapabilityInServer } from "../lib/actorPermissions";
import { AgentRuntimeProviderError } from "../services/agentRuntimeProviderService";
import { getAgentRuntimeProviderAvailability } from "../services/agentRuntimeProviderFeature";

export const agentRuntimeProviderRouter: RouterType = Router();

const STATUS_BY_CODE: Record<AgentRuntimeProviderError["code"], number> = {
  agent_runtime_provider_invalid: 400,
  agent_runtime_provider_disabled: 403,
  agent_runtime_provider_not_configured: 409,
  agent_runtime_provider_key_missing: 503,
  agent_runtime_provider_origin_unconfigured: 409,
};

export function sendAgentRuntimeProviderError(res: Response, error: AgentRuntimeProviderError): void {
  res.status(STATUS_BY_CODE[error.code] ?? 400).json({ error: error.message, code: error.code });
}

agentRuntimeProviderRouter.get("/:kind", async (req, res, next) => {
  try {
    const kind = req.params.kind;
    if (!isAgentRuntimeProviderKind(kind)) {
      res.status(404).json({ error: "Unknown runtime provider", code: "agent_runtime_provider_unknown" });
      return;
    }
    if (!await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "createAgents")) {
      res.status(403).json({ error: "createAgents capability required", code: "agent_runtime_provider_forbidden" });
      return;
    }
    const availability = await getAgentRuntimeProviderAvailability(req.serverId!, kind);
    const view: AgentRuntimeProviderAvailabilityView = { kind, available: availability.available };
    res.setHeader("Cache-Control", "no-store");
    res.json(view);
  } catch (error) {
    next(error);
  }
});
