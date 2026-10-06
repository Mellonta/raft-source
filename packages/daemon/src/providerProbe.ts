// Computer-scoped provider probe executor (Phase 2A foundation).
//
// The daemon never receives credentials over the machine command: it claims a
// one-time materialization with its own machine auth, then runs a bounded
// canary through the real pi-ai provider adapters (`completeSimple`), without
// creating an Agent session and without reading host ambient provider env.
//
// Contract of record: #wg-subscription-login:225b161b (Cardy v2 + 收口修正).
import { completeSimple, registerBuiltInApiProviders } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS,
  BUILTIN_RUNTIME_PROVIDER_ENV_KEYS,
  PI_BUILTIN_PROVIDER_CONNECTION_PROBES,
  PROVIDER_PROBE_BUDGET_MS,
  PROVIDER_PROBE_MATERIALIZE_BUDGET_MS,
  boundProviderProbeReply,
  isBuiltInRuntimeGatewayProviderId,
  providerProbeAuthorityIdentity,
  providerProbeResultDigest,
  sha256Hex,
  utf8ByteLength,
  type MachineProviderProbeResult,
  type ProviderConnectionLaunchProjection,
  type ProviderProbeDaemonCategory,
  type ProviderProbeId,
} from "@botiverse/raft-shared";
import { daemonFetch } from "./daemonFetch";
import { parseProviderConnectionLaunchPayload } from "./providerConnectionLaunch";

/** The canary prompt. Fixed so receipts are comparable across probes. */
export const PROVIDER_PROBE_MESSAGE = "Reply with OK.";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

let builtinProvidersRegistered = false;
function ensureBuiltinApiProviders(): void {
  if (builtinProvidersRegistered) return;
  registerBuiltInApiProviders();
  builtinProvidersRegistered = true;
}

export interface ProbeMaterialization {
  envVars: Record<string, string>;
  providerConnection: ProviderConnectionLaunchProjection;
  authority: { connectionEpochId: string; replicaGeneration: string };
}

/**
 * Claim the one-time materialization. The claim is idempotent for the same
 * claimant inside the server-side lease, so a lost HTTP response may be
 * retried once without risking a second provider call.
 */
export async function claimProbeMaterialization(input: {
  serverUrl: string;
  daemonApiKey: string;
  probeId: ProviderProbeId;
  claimRequestId: string;
}): Promise<ProbeMaterialization> {
  const url = new URL(
    `/internal/computer/probes/${encodeURIComponent(input.probeId)}/materialize`,
    input.serverUrl,
  );
  // One overall deadline for the whole claim (including the single idempotent
  // retry): once the signal aborts, no further attempt may start or continue.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_PROBE_MATERIALIZE_BUDGET_MS);
  let lastError: unknown = null;
  try {
    for (let attempt = 0; attempt < 2 && !controller.signal.aborted; attempt += 1) {
      try {
        const response = await daemonFetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${input.daemonApiKey}`,
            "Content-Type": "application/json",
            "X-Raft-Client": "daemon-server-session-worker",
          },
          body: JSON.stringify({ claimRequestId: input.claimRequestId }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`probe materialization failed (HTTP ${response.status})`);
        }
        const body = await response.json().catch(() => null) as Record<string, unknown> | null;
        const authority = body?.authority as Record<string, unknown> | undefined;
        if (
          !body
          || Object.keys(body).sort().join(",") !== "authority,envVars,providerConnection"
          || !authority
          || typeof authority.connectionEpochId !== "string"
          || typeof authority.replicaGeneration !== "string"
        ) {
          throw new Error("probe materialization returned an invalid payload");
        }
        const parsed = parseProviderConnectionLaunchPayload({
          envVars: body.envVars,
          providerConnection: body.providerConnection,
        });
        return {
          envVars: parsed.envVars,
          providerConnection: parsed.providerConnection as ProviderConnectionLaunchProjection,
          authority: {
            connectionEpochId: authority.connectionEpochId as string,
            replicaGeneration: authority.replicaGeneration as string,
          },
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  } finally {
    clearTimeout(timer);
  }
}

function probeApiKeyEnvName(providerId: ProviderConnectionLaunchProjection["providerId"]): string | null {
  if (isBuiltInRuntimeGatewayProviderId(providerId)) {
    return BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS[providerId] ?? null;
  }
  return BUILTIN_RUNTIME_PROVIDER_ENV_KEYS[providerId] ?? null;
}

function buildProbeModel(
  projection: ProviderConnectionLaunchProjection,
  modelId: string,
): Model<Api> | null {
  if (isBuiltInRuntimeGatewayProviderId(projection.providerId)) {
    if (!projection.endpointUrl) return null;
    const api: Api = projection.providerId === "anthropic-compatible"
      ? "anthropic-messages"
      : "openai-completions";
    return {
      id: modelId,
      name: modelId,
      api,
      provider: projection.providerId,
      baseUrl: projection.endpointUrl,
      reasoning: false,
      input: ["text"],
      cost: { ...ZERO_COST },
      contextWindow: 200_000,
      maxTokens: 1,
    };
  }
  const probe = PI_BUILTIN_PROVIDER_CONNECTION_PROBES[projection.providerId];
  if (!probe) return null;
  return {
    id: modelId,
    name: modelId,
    api: probe.api as Api,
    provider: projection.providerId,
    baseUrl: probe.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { ...ZERO_COST },
    contextWindow: 200_000,
    maxTokens: 1,
  };
}

/** Map a provider/transport failure onto the closed daemon category set. */
export function classifyProbeFailure(detail: string): ProviderProbeDaemonCategory {
  const text = detail.toLowerCase();
  if (/(401|403|unauthorized|forbidden|invalid api key|authentication|credential)/u.test(text)) return "auth";
  if (/(429|rate limit|quota|too many requests)/u.test(text)) return "rate_quota";
  if (/(404|model not found|unknown model|does not exist|no such model)/u.test(text)) return "model";
  if (/(enotfound|eai_again|getaddrinfo|dns|certificate|tls|ssl|handshake|unable to verify)/u.test(text)) return "dns_tls";
  if (/(econnrefused|econnreset|epipe|socket|network|fetch failed|connect|timeout)/u.test(text)) return "network";
  return "invalid_response";
}

function assistantReplyText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => (
      Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text"
    ))
    .map((part) => part.text)
    .join("");
}

export interface ProbeExecutionResult {
  outcome: "success" | "failure";
  category: ProviderProbeDaemonCategory | null;
  latencyMs: number;
  responseSha256: string | null;
  responseBytes: number | null;
  reply: string | null;
}

/**
 * Run the bounded canary with the real provider adapter. Success requires a
 * valid assistant result AND a bounded plain-text reply; everything else is a
 * failure with a closed category. Never logs the key, prompt or reply.
 */
export async function runProviderProbeCanary(input: {
  materialization: ProbeMaterialization;
  model: string;
  budgetMs?: number;
}): Promise<ProbeExecutionResult> {
  ensureBuiltinApiProviders();
  const { providerConnection: projection, envVars } = input.materialization;
  const keyEnv = probeApiKeyEnvName(projection.providerId);
  const apiKey = keyEnv ? envVars[keyEnv] : undefined;
  const model = buildProbeModel(projection, input.model);
  const started = Date.now();
  if (!model || !apiKey) {
    return {
      outcome: "failure",
      category: "model",
      latencyMs: Date.now() - started,
      responseSha256: null,
      responseBytes: null,
      reply: null,
    };
  }
  const budget = input.budgetMs ?? PROVIDER_PROBE_BUDGET_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  let abortedByBudget = false;
  const onAbort = () => { abortedByBudget = true; };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const assistant = await completeSimple(
      model,
      { messages: [{ role: "user", content: PROVIDER_PROBE_MESSAGE, timestamp: Date.now() }] },
      { apiKey, maxTokens: 1, signal: controller.signal },
    );
    const latencyMs = Date.now() - started;
    const stopReason = assistant?.stopReason;
    if (stopReason === "aborted") {
      return {
        outcome: "failure",
        category: abortedByBudget ? "provider_timeout" : "provider_timeout",
        latencyMs,
        responseSha256: null,
        responseBytes: null,
        reply: null,
      };
    }
    if (stopReason !== "stop" && stopReason !== "length") {
      return {
        outcome: "failure",
        category: classifyProbeFailure(assistant?.errorMessage ?? `stop reason ${String(stopReason)}`),
        latencyMs,
        responseSha256: null,
        responseBytes: null,
        reply: null,
      };
    }
    const reply = boundProviderProbeReply(assistantReplyText(assistant?.content));
    if (reply === null) {
      return {
        outcome: "failure",
        category: "invalid_response",
        latencyMs,
        responseSha256: null,
        responseBytes: null,
        reply: null,
      };
    }
    return {
      outcome: "success",
      category: null,
      latencyMs,
      responseSha256: await sha256Hex(reply),
      responseBytes: utf8ByteLength(reply),
      reply,
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    if (abortedByBudget) {
      return {
        outcome: "failure",
        category: "provider_timeout",
        latencyMs,
        responseSha256: null,
        responseBytes: null,
        reply: null,
      };
    }
    return {
      outcome: "failure",
      category: classifyProbeFailure(error instanceof Error ? error.message : String(error)),
      latencyMs,
      responseSha256: null,
      responseBytes: null,
      reply: null,
    };
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

/** Assemble the wire result, chaining the digest over closed fields only. */
export async function buildProviderProbeResultMessage(input: {
  requestId: string;
  probeId: ProviderProbeId;
  execution: ProbeExecutionResult;
  authority: { connectionEpochId: string; replicaGeneration: string };
  daemonVersion: string | null;
  computerVersion: string | null;
  runtimeVersion: string | null;
}): Promise<MachineProviderProbeResult> {
  const authorityIdentity = await providerProbeAuthorityIdentity(input.authority);
  return {
    type: "machine:provider_probe:result",
    requestId: input.requestId,
    probeId: input.probeId,
    outcome: input.execution.outcome,
    category: input.execution.category,
    latencyMs: input.execution.latencyMs,
    // Closed wire shape: failures never carry reply/hash/bytes.
    responseSha256: input.execution.outcome === "success" ? input.execution.responseSha256 : null,
    responseBytes: input.execution.outcome === "success" ? input.execution.responseBytes : null,
    resultDigest: await providerProbeResultDigest({
      outcome: input.execution.outcome,
      category: input.execution.category,
      responseSha256: input.execution.outcome === "success" ? input.execution.responseSha256 : null,
      responseBytes: input.execution.outcome === "success" ? input.execution.responseBytes : null,
      authorityIdentity,
    }),
    authorityEcho: input.authority,
    daemonVersion: input.daemonVersion,
    computerVersion: input.computerVersion,
    runtimeVersion: input.runtimeVersion,
    reply: input.execution.outcome === "success" ? input.execution.reply : null,
  };
}

/** Failure result for a carrier that could not even claim authority. */
export async function buildUnclaimedProviderProbeResult(input: {
  requestId: string;
  probeId: ProviderProbeId;
}): Promise<MachineProviderProbeResult> {
  return {
    type: "machine:provider_probe:result",
    requestId: input.requestId,
    probeId: input.probeId,
    // category null: the carrier could not even claim authority, so no
    // daemon-decided category applies. The Server closes such results as
    // invalid_carrier_result through its own digest/receipt path.
    outcome: "failure",
    category: null,
    latencyMs: null,
    responseSha256: null,
    responseBytes: null,
    resultDigest: await providerProbeResultDigest({
      outcome: "failure",
      category: null,
      responseSha256: null,
      responseBytes: null,
      authorityIdentity: "none",
    }),
    authorityEcho: { connectionEpochId: "none", replicaGeneration: "none" },
    daemonVersion: null,
    computerVersion: null,
    runtimeVersion: null,
    reply: null,
  };
}
