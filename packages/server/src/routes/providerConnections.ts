import { Router, type NextFunction, type Request, type Response, type Router as RouterType } from "express";
import {
  isProviderConnectionProviderId,
  isProviderProbeId,
  isProviderProbeRequestId,
  PROVIDER_PROBE_BUDGET_MS,
  PROVIDER_PROBE_CAPABILITY,
  PROVIDER_PROBE_INTENT_TTL_MS,
  type ProviderConnectionProviderOption,
  type ServerCapability,
} from "@botiverse/raft-shared";
import { actorHasServerCapabilityInServer } from "../lib/actorPermissions";
import { RouteFailureError } from "../tracing/routeFailure";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { isProviderConnectionsEnabled, isProviderProbesEnabled } from "../services/providerConnectionFeature";
import {
  createProviderProbe,
  listProviderProbeReceipts,
  readProviderProbe,
  resolveProviderProbeCarrier,
  ProviderProbeError,
  type ProbeCarrier,
} from "../services/providerProbeService";
import { buildBuiltInPiFormOptionSource } from "../services/runtimeFormDefinitionService";
import {
  createProviderConnection,
  deleteProviderConnection,
  detachProviderConnectionDeletedAgent,
  listProviderConnections,
  listProviderConnectionAssignedAgents,
  listProviderConnectionModels,
  ProviderConnectionError,
  rotateProviderConnectionCredential,
  testProviderConnection,
  updateProviderConnection,
} from "../services/providerConnectionService";

export const providerConnectionRouter: RouterType = Router();

function body(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new ProviderConnectionError("Request body must be an object", "provider_connection_invalid");
  }
  return req.body as Record<string, unknown>;
}

function exactBody(req: Request, allowed: readonly string[]): Record<string, unknown> {
  const value = body(req);
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ProviderConnectionError("Request body contains unknown fields", "provider_connection_invalid");
  }
  return value;
}

function connectionId(req: Request): string {
  return uuidParam(req.params.connectionId, "Provider connection id is invalid");
}

function agentId(req: Request): string {
  return uuidParam(req.params.agentId, "Agent id is invalid");
}

function uuidParam(value: unknown, message: string): string {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/iu.test(value)) {
    throw new ProviderConnectionError(message, "provider_connection_invalid");
  }
  return value;
}

function requireCapability(capability: ServerCapability) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, capability)) {
        res.status(403).json({ error: `${capability} capability required`, code: "provider_connection_forbidden" });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

async function requireProviderConnectionsFeature(req: Request, res: Response, next: NextFunction) {
  try {
    if (!await isProviderConnectionsEnabled(req.serverId!)) {
      res.status(404).json({
        error: "Provider connections are not enabled for this server",
        code: "provider_connections_disabled",
      });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}

function sendError(error: unknown, res: Response, next: NextFunction) {
  if (!(error instanceof ProviderConnectionError)) {
    next(error);
    return;
  }
  const status = error.code === "provider_connection_retired"
    ? 410
    : error.code === "provider_connection_not_found"
    ? 404
    : error.code === "provider_connection_key_missing"
      ? 503
      : error.code === "provider_connection_test_failed" || error.code === "provider_connection_model_list_failed"
        ? 502
        : error.code === "provider_connection_invalid"
          ? 400
          : 409;
  res.status(status).json({ error: error.message, code: error.code });
}

providerConnectionRouter.use(requireProviderConnectionsFeature);

export function listProviderConnectionProviderOptions(): ProviderConnectionProviderOption[] {
  const source = buildBuiltInPiFormOptionSource("provider");
  if (!source || source.kind !== "select") {
    throw new ProviderConnectionError("Built-in provider catalog is unavailable", "provider_connection_unavailable");
  }
  return source.options.map((option) => {
    if (
      !isProviderConnectionProviderId(option.value)
      || (option.providerKind !== "preset" && option.providerKind !== "gateway")
    ) {
      throw new ProviderConnectionError("Built-in provider catalog is out of sync", "provider_connection_unavailable");
    }
    return {
      id: option.value,
      label: option.label,
      providerKind: option.providerKind,
    };
  });
}

providerConnectionRouter.get("/", requireCapability("manageExternalAuth"), async (req, res, next) => {
  try {
    res.json({
      connections: await listProviderConnections(req.serverId!),
      providerOptions: listProviderConnectionProviderOptions(),
    });
  } catch (error) {
    sendError(error, res, next);
  }
});

providerConnectionRouter.post("/", requireCapability("manageExternalAuth"), async (req, res, next) => {
  try {
    const input = exactBody(req, ["name", "providerId", "endpointUrl", "supportsImageInput", "apiKey"]);
    res.status(201).json(await createProviderConnection({
      serverId: req.serverId!,
      userId: req.userId!,
      name: input.name,
      providerId: input.providerId,
      endpointUrl: input.endpointUrl,
      supportsImageInput: input.supportsImageInput,
      apiKey: input.apiKey,
    }));
  } catch (error) {
    sendError(error, res, next);
  }
});

providerConnectionRouter.patch("/:connectionId", requireCapability("manageExternalAuth"), async (req, res, next) => {
  try {
    const input = exactBody(req, ["name", "enabled", "endpointUrl", "supportsImageInput", "apiKey"]);
    if (input.apiKey !== undefined && input.apiKey !== null && String(input.apiKey).trim() !== "") {
      if (!await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "rotateServerSecrets")) {
        res.status(403).json({ error: "rotateServerSecrets capability required", code: "provider_connection_forbidden" });
        return;
      }
    }
    res.json(await updateProviderConnection({
      serverId: req.serverId!,
      userId: req.userId!,
      connectionId: connectionId(req),
      ...input,
    }));
  } catch (error) {
    sendError(error, res, next);
  }
});

providerConnectionRouter.post("/:connectionId/credentials/rotate", requireCapability("rotateServerSecrets"), async (req, res, next) => {
  try {
    const input = exactBody(req, ["apiKey", "endpointUrl", "supportsImageInput"]);
    res.json(await rotateProviderConnectionCredential({
      serverId: req.serverId!,
      userId: req.userId!,
      connectionId: connectionId(req),
      apiKey: input.apiKey,
      endpointUrl: input.endpointUrl,
      supportsImageInput: input.supportsImageInput,
    }));
  } catch (error) {
    sendError(error, res, next);
  }
});

providerConnectionRouter.delete("/:connectionId", requireCapability("manageExternalAuth"), async (req, res, next) => {
  try {
    await deleteProviderConnection({
      serverId: req.serverId!,
      userId: req.userId!,
      connectionId: connectionId(req),
    });
    res.status(204).end();
  } catch (error) {
    sendError(error, res, next);
  }
});

providerConnectionRouter.get("/:connectionId/models", requireCapability("manageExternalAuth"), async (req, res, next) => {
  try {
    res.json(await listProviderConnectionModels({
      serverId: req.serverId!,
      connectionId: connectionId(req),
    }));
  } catch (error) {
    sendError(error, res, next);
  }
});


function sendProbeError(error: unknown, res: Response, next: NextFunction) {
  if (!(error instanceof ProviderProbeError)) {
    next(error);
    return;
  }
  const status = error.code === "probe_not_found" || error.code === "probe_disabled"
    ? 404
    : error.code === "probe_invalid"
      ? 400
      : error.code === "probe_expired"
        ? 410
        : error.code === "probe_rate_limited"
          ? 429
          : error.code === "probe_key_missing"
            ? 503
            : 409;
  if (status === 429 && error.retryAfterSeconds) res.set("Retry-After", String(error.retryAfterSeconds));
  res.status(status).json({ error: error.message, code: error.code });
}

/**
 * Wire the probe carrier to the owning Computer through the orchestrator's
 * machine relay. Send/timeout failures are typed; anything else is a send
 * failure so a lost carrier can never read as success.
 */
function probeCarrier(req: Request): ProbeCarrier {
  const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
  return {
    readFact: (machineId) => orchestrator.readProbeCarrierFact(machineId),
    dispatch: async (machineId, command) => {
      try {
        const result = await orchestrator.requestProviderProbe(machineId, command);
        return { kind: "result" as const, result };
      } catch (error) {
        if (error instanceof RouteFailureError && error.subkind === "daemon_timeout") {
          return { kind: "timeout" as const };
        }
        return { kind: "send_failed" as const };
      }
    },
  };
}

providerConnectionRouter.get("/:connectionId/agents", requireCapability("manageExternalAuth"), async (req, res, next) => {
  try {
    res.json(await listProviderConnectionAssignedAgents({
      serverId: req.serverId!,
      connectionId: connectionId(req),
    }));
  } catch (error) {
    sendError(error, res, next);
  }
});

providerConnectionRouter.delete("/:connectionId/agents/:agentId", requireCapability("manageExternalAuth"), async (req, res, next) => {
  try {
    await detachProviderConnectionDeletedAgent({
      serverId: req.serverId!,
      userId: req.userId!,
      connectionId: connectionId(req),
      agentId: agentId(req),
    });
    res.status(204).end();
  } catch (error) {
    sendError(error, res, next);
  }
});


providerConnectionRouter.post("/:connectionId/probes", requireCapability("manageExternalAuth"), async (req, res, next) => {
  try {
    if (!await isProviderProbesEnabled(req.serverId!)) {
      res.status(404).json({ error: "Provider probes are not enabled for this server", code: "probe_disabled" });
      return;
    }
    const input = exactBody(req, ["probeRequestId", "requestDigest", "computerId", "runtime", "model", "probeKind"]);
    if (!isProviderProbeRequestId(input.probeRequestId)) {
      throw new ProviderProbeError("Probe request id is invalid", "probe_invalid");
    }
    if (typeof input.runtime !== "string" || typeof input.probeKind !== "string" || typeof input.model !== "string") {
      throw new ProviderProbeError("Probe runtime, kind and model must be strings", "probe_invalid");
    }
    const created = await createProviderProbe({
      serverId: req.serverId!,
      userId: req.userId!,
      connectionId: connectionId(req),
      probeRequestId: input.probeRequestId,
      requestDigest: typeof input.requestDigest === "string" ? input.requestDigest : "",
      computerId: typeof input.computerId === "string" ? input.computerId : "",
      runtime: typeof input.runtime === "string" ? input.runtime : "",
      model: typeof input.model === "string" ? input.model : "",
      probeKind: input.probeKind as string,
      expiresAt: new Date(Date.now() + PROVIDER_PROBE_INTENT_TTL_MS),
      carrier: resolveProviderProbeCarrier(probeCarrier(req)),
    });
    res.status(created.replayed ? 200 : 201).json(created);
  } catch (error) {
    sendProbeError(error, res, next);
  }
});

providerConnectionRouter.get("/:connectionId/probes", requireCapability("manageExternalAuth"), async (req, res, next) => {
  try {
    if (!await isProviderProbesEnabled(req.serverId!)) {
      res.status(404).json({ error: "Provider probes are not enabled for this server", code: "probe_disabled" });
      return;
    }
    res.json(await listProviderProbeReceipts({
      serverId: req.serverId!,
      connectionId: connectionId(req),
    }));
  } catch (error) {
    sendProbeError(error, res, next);
  }
});

providerConnectionRouter.get("/:connectionId/probes/:probeId", requireCapability("manageExternalAuth"), async (req, res, next) => {
  try {
    if (!await isProviderProbesEnabled(req.serverId!)) {
      res.status(404).json({ error: "Provider probes are not enabled for this server", code: "probe_disabled" });
      return;
    }
    const probeId = req.params.probeId;
    if (!isProviderProbeId(probeId)) {
      throw new ProviderProbeError("Provider probe id is invalid", "probe_invalid");
    }
    // Durable receipt only: the transient reply never leaves the create call.
    res.json(await readProviderProbe({
      serverId: req.serverId!,
      connectionId: connectionId(req),
      probeId,
    }));
  } catch (error) {
    sendProbeError(error, res, next);
  }
});

providerConnectionRouter.post("/:connectionId/test", requireCapability("manageExternalAuth"), async (req, res, next) => {
  try {
    const input = exactBody(req, ["model", "message"]);
    res.json(await testProviderConnection({
      serverId: req.serverId!,
      userId: req.userId!,
      connectionId: connectionId(req),
      model: input.model,
      message: input.message,
    }));
  } catch (error) {
    sendError(error, res, next);
  }
});
