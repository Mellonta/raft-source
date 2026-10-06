import { RuntimeModelNotFoundError } from "../spawnFailureErrors";
import type { ProviderRequestObserver } from "../providerRequestFetch";
import "../bundledPiOAuth";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  DefaultPackageManager,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION as PI_SDK_VERSION,
  type AgentSession,
  type AgentSessionServices,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  isContextOverflow,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  buildLaunchPlan,
  errorClassOf,
  RUNTIME_ERROR_CLASSES,
  BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS,
  BUILTIN_RUNTIME_HOST_PROVIDER_ENV_SCRUB_KEYS,
  BUILTIN_RUNTIME_PROVIDER_ENV_KEYS,
  getRuntimeProviderDisplayName,
  humanizeRuntimeProviderSegment,
  hydrateRuntimeConfig,
  isBuiltInRuntimeGatewayProviderId,
  isBuiltInRuntimeProviderId,
  PI_BUILTIN_PROVIDER_ENV_KEYS,
  RUNTIME_MODELS,
  runtimeConfigToLaunchFields,
  runtimeModelSourceOutcomeFromSet,
  type ActiveSpan,
  type AgentConfig,
  type RuntimeModelInfo,
  type RuntimeModelSet,
  type RuntimeModelSourceOutcome,
  type RuntimeConfig,
  type ProviderRequestActivity,
  type ProviderConnectionLaunchProjection,
  currentTimeMs,
  type AxSurfaceText,
} from "@botiverse/raft-shared";
import {
  normalizeRuntimeCompactionReason,
  type RuntimeCompactionReason,
} from "../runtimeCompactionProjection";
import { buildRuntimeErrorActivityDiagnostic } from "../runtimeErrorDiagnostics";
import { buildCliTransportSystemPrompt, prepareCliTransport } from "./cliTransport";
import { buildPiTokenUsageEvent } from "./piEventNormalizer";
import { createManagedMcpPiTools } from "./managedMcpTools";
import { createPiCommandTool } from "./piCommandTool";
import {
  createProviderHttpClient,
  type ProviderHttpClient,
} from "../daemonFetch";
import {
  createPiToolExecutionObserver,
  type PiToolExecutionObserver,
} from "./piToolExecutionObservability";
import {
  type RuntimeLifecycleDiagnosticEvent,
  type RuntimeTerminalCausePhase,
  writeRuntimeLifecycleDiagnosticRecord,
  writeRuntimeTerminalCauseRecord,
} from "./index";
import type {
  ParsedEvent,
  RuntimeToolDiagnosticInput,
  RuntimeToolDiagnosticSnapshot,
  RuntimeDriver,
  RuntimeExitInfo,
  RuntimeModelDetectionContext,
  RuntimeProbeResult,
  RuntimeSendResult,
  RuntimeSession,
  RuntimeSessionDescriptor,
  SpawnContext,
  SpawnResult,
} from "./types";

const PI_SESSION_DIR = ".pi-sessions";
const BUILTIN_SESSION_DIR = ".builtin-sessions";
const BUILTIN_AGENT_DIR = ".builtin-runtime";
export const PI_SDK_COMPACTION_ENABLED = true;
// Pi also activates some providers through ambient non-API-key credentials.
// Public Pi metadata exposes API-key env names via `findEnvKeys(provider)`;
// these remaining names are host credential sources, not per-provider API-key
// metadata, and must stay scrubbed for Built-in isolation.
const BUILTIN_BLOCKED_HOST_AMBIENT_CREDENTIAL_ENV_KEYS = [
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_RESOURCE_NAME",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  "CLOUDFLARE_ACCOUNT_ID",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_REGION",
] as const;
const BUILTIN_BLOCKED_HOST_PROVIDER_ENV_KEYS = Array.from(new Set([
  ...BUILTIN_RUNTIME_HOST_PROVIDER_ENV_SCRUB_KEYS,
  ...BUILTIN_BLOCKED_HOST_AMBIENT_CREDENTIAL_ENV_KEYS,
])) as readonly string[];

type PiModelRegistryLike = Pick<ModelRegistry, "getAvailable">;
type PiSessionFactory = (
  ctx: SpawnContext,
  sessionId: string,
  toolExecutionObserver?: PiToolExecutionObserver,
  providerObserver?: ProviderRequestObserver,
) => Promise<AgentSession>;
type PiAssistantMessageEvent = Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"];

type RuntimeSessionEvents = {
  runtime_event: [ParsedEvent];
  stdout: [string];
  stderr: [string];
  error: [Error];
  exit: [RuntimeExitInfo];
  close: [RuntimeExitInfo];
};

type RuntimeSessionEventName = keyof RuntimeSessionEvents;

export interface PiSdkEventMappingState {
  sessionId: string | null;
  sessionAnnounced: boolean;
  pendingTurnEnd: boolean;
  pendingProviderError: string | null;
  providerErrorOwnedByCompaction: boolean;
  compactionTerminal: boolean;
  thinkingBuffers: Map<number, string>;
  announcedThinkingIndexes: Set<number>;
  textBuffers: Map<number, string>;
  announcedTextIndexes: Set<number>;
}

export function createPiSdkEventMappingState(sessionId: string | null = null): PiSdkEventMappingState {
  return {
    sessionId,
    sessionAnnounced: false,
    pendingTurnEnd: false,
    pendingProviderError: null,
    providerErrorOwnedByCompaction: false,
    compactionTerminal: false,
    thinkingBuffers: new Map(),
    announcedThinkingIndexes: new Set(),
    textBuffers: new Map(),
    announcedTextIndexes: new Set(),
  };
}

type PiCompactionOutcome =
  | "compaction_succeeded"
  | "compaction_failed_or_exhausted"
  | "aborted";
type PiCompactionFailureReason = "recovery_exhausted" | "input_too_large" | "compaction_failed";
type PiCompactionProjection = {
  outcome: PiCompactionOutcome;
  reason: RuntimeCompactionReason;
  failureReason?: PiCompactionFailureReason;
  willRetry: boolean;
};

export interface PiCompactionInputEvidence {
  messageCount: number;
  inputTextLength: number;
  configuredContextLimit: number | null;
}

function projectPiCompactionEnd(
  event: Extract<AgentSessionEvent, { type: "compaction_end" }>,
): PiCompactionProjection {
  const reason = normalizeRuntimeCompactionReason(event.reason);
  if (event.aborted) {
    return { outcome: "aborted", reason, willRetry: event.willRetry === true };
  }
  if (event.result !== undefined) {
    return { outcome: "compaction_succeeded", reason, willRetry: event.willRetry === true };
  }
  const failureReason = reason === "overflow"
    && typeof event.errorMessage === "string"
    && /after one compact-and-retry attempt/iu.test(event.errorMessage)
    ? "recovery_exhausted"
    : isContextOverflow({
        role: "assistant",
        stopReason: "error",
        errorMessage: event.errorMessage ?? "",
      } as Parameters<typeof isContextOverflow>[0])
      ? "input_too_large"
      : "compaction_failed";
  return {
    outcome: "compaction_failed_or_exhausted",
    reason,
    failureReason,
    willRetry: event.willRetry === true,
  };
}

const PI_TELEMETRY_MESSAGE_COUNT_CAP = 1_024;
const PI_TELEMETRY_CONTEXT_LIMIT_CAP = 10_000_000;
const PI_TELEMETRY_INPUT_LENGTH_CAP = 1_048_577;

function bucketPiInputLength(value: number): string {
  if (value <= 0) return "0";
  if (value <= 1_024) return "1_1024";
  if (value <= 4_096) return "1025_4096";
  if (value <= 16_384) return "4097_16384";
  if (value <= 65_536) return "16385_65536";
  if (value <= 262_144) return "65537_262144";
  if (value <= 1_048_576) return "262145_1048576";
  return "over_1048576";
}

export function projectPiCompactionInputTelemetry(
  evidence: PiCompactionInputEvidence | undefined,
  reason: RuntimeCompactionReason,
): Record<string, string | number | boolean> {
  if (!evidence) {
    return {
      message_count_present: false,
      input_length_bucket: "unknown",
      configured_context_limit_present: false,
      input_range_classification: "unknown",
    };
  }

  const rawMessageCount = Number.isFinite(evidence.messageCount)
    ? Math.max(0, Math.floor(evidence.messageCount))
    : 0;
  const inputTextLength = Number.isFinite(evidence.inputTextLength)
    ? Math.max(0, Math.floor(evidence.inputTextLength))
    : 0;
  const configuredContextLimit = Number.isFinite(evidence.configuredContextLimit)
    && Number(evidence.configuredContextLimit) >= 1
    && Number(evidence.configuredContextLimit) <= PI_TELEMETRY_CONTEXT_LIMIT_CAP
    ? Math.floor(Number(evidence.configuredContextLimit))
    : null;

  return {
    message_count_capped: Math.min(rawMessageCount, PI_TELEMETRY_MESSAGE_COUNT_CAP),
    message_count_was_capped: rawMessageCount > PI_TELEMETRY_MESSAGE_COUNT_CAP,
    input_length_bucket: bucketPiInputLength(inputTextLength),
    ...(configuredContextLimit === null
      ? { configured_context_limit_present: false }
      : { configured_context_limit: configuredContextLimit }),
    input_range_classification: inputTextLength === 0
      ? "lower_bound_empty"
      : reason === "overflow"
        ? "upper_bound_overflow"
        : "nonempty",
  };
}

function piCompactionInputEvidence(session: AgentSession): PiCompactionInputEvidence {
  let inputTextLength = boundedTextLength(session.systemPrompt, PI_TELEMETRY_INPUT_LENGTH_CAP);
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (const message of messages) {
    if (inputTextLength >= PI_TELEMETRY_INPUT_LENGTH_CAP) break;
    inputTextLength += boundedTextLength(
      message,
      PI_TELEMETRY_INPUT_LENGTH_CAP - inputTextLength,
    );
  }
  return {
    messageCount: messages.length + (session.systemPrompt ? 1 : 0),
    inputTextLength,
    configuredContextLimit: session.model?.contextWindow ?? null,
  };
}

function boundedTextLength(value: unknown, remaining: number, seen = new Set<object>()): number {
  if (remaining <= 0) return 0;
  if (typeof value === "string") return Math.min(value.length, remaining);
  if (!value || typeof value !== "object") return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  let total = 0;
  const values = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  for (const child of values) {
    total += boundedTextLength(child, remaining - total, seen);
    if (total >= remaining) break;
  }
  return total;
}

export function buildPiSessionDir(workingDirectory: string): string {
  return path.join(workingDirectory, PI_SESSION_DIR);
}

export function buildBuiltInSessionDir(workingDirectory: string): string {
  return path.join(workingDirectory, BUILTIN_SESSION_DIR);
}

export function buildBuiltInAgentDir(workingDirectory: string): string {
  return path.join(workingDirectory, BUILTIN_AGENT_DIR);
}

export function buildPiLegacyRpcArgs(ctx: SpawnContext, sessionId: string | null): string[] {
  const launchRuntimeFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
  const args = [
    "--mode", "rpc",
    "--session-dir", buildPiSessionDir(ctx.workingDirectory),
    "--system-prompt", ctx.standingPrompt,
  ];

  if (launchRuntimeFields.model && launchRuntimeFields.model !== "default") {
    args.push("--model", launchRuntimeFields.model);
  }

  if (launchRuntimeFields.reasoningEffort) {
    args.push("--thinking", launchRuntimeFields.reasoningEffort);
  }

  if (sessionId) {
    args.push("--session-id", sessionId);
  }

  return args;
}

export async function buildPiSpawnEnv(ctx: SpawnContext): Promise<NodeJS.ProcessEnv> {
  return (await prepareCliTransport(ctx, { NO_COLOR: "1" })).spawnEnv;
}

/**
 * A provider key goes into an HTTP header (`Authorization: Bearer <key>` or an
 * api-key header). A key with a pasted note or placeholder in it (e.g. Chinese
 * text) otherwise surfaces as Node's opaque "Cannot convert argument to a
 * ByteString because the character at index 7…" on every request. Refuse it up
 * front with a message that names the key.
 *
 * Only what every header form refuses is rejected: fetch trims leading and
 * trailing HTTP whitespace (tab, LF, CR, space) from a header value, so the
 * check runs on the trimmed key and then refuses what remains that no header
 * value can carry (a character above U+00FF, CR, LF, NUL). A key that worked in
 * some header form before is never newly refused.
 */
const HTTP_WHITESPACE_EDGES = /^[\t\n\r ]+|[\t\n\r ]+$/g;

export function assertProviderApiKeyIsHeaderSafe(apiKey: string, keyName: string): void {
  const leading = apiKey.length - apiKey.replace(/^[\t\n\r ]+/, "").length;
  const trimmed = apiKey.replace(HTTP_WHITESPACE_EDGES, "");
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code > 0xff || code === 0x0a || code === 0x0d || code === 0x00) {
      throw new Error(
        `${keyName} contains a character that cannot be sent in an HTTP header (position ${leading + index + 1}, `
        + `code ${code}). Remove any pasted text, line breaks or other characters that are not part of the key.`,
      );
    }
  }
}

async function setHeaderSafeRuntimeApiKey(
  modelRuntime: Pick<ModelRuntime, "setRuntimeApiKey">,
  providerId: string,
  apiKey: string,
  keyName: string,
): Promise<void> {
  assertProviderApiKeyIsHeaderSafe(apiKey, keyName);
  await modelRuntime.setRuntimeApiKey(providerId, apiKey);
}

export async function seedPiSessionModelRuntime(
  modelRuntime: Pick<ModelRuntime, "setRuntimeApiKey">,
  runtimeConfig: RuntimeConfig,
  providerConnection: ProviderConnectionLaunchProjection | null = null,
  launchEnvVars: Record<string, string> | null = null,
): Promise<void> {
  // ModelRuntime.create() is intentionally offline here, and credential seeding must not
  // reach the network. Under pi 0.84.3 that guarantee moved INTO the library: credential
  // synchronization itself calls models.refresh({ allowNetwork: false, ... }) and only
  // reconciles cached/built-in catalog, composition and availability locally. Remote
  // freshness is the caller's separate concern, and we deliberately do not request it here.
  // Passing an options object is no longer possible — AuthOperationOptions is { signal? }.
  if (runtimeConfig.runtime === "pi" && runtimeConfig.provider?.kind === "pi-builtin") {
    await setHeaderSafeRuntimeApiKey(
      modelRuntime,
      runtimeConfig.provider.providerId,
      runtimeConfig.provider.apiKey,
      `The ${runtimeConfig.provider.providerId} API key`,
    );
    return;
  }
  if (runtimeConfig.runtime !== "builtin") return;
  if (runtimeConfig.provider.kind === "connection") {
    if (!providerConnection) throw new Error("Provider connection launch metadata is missing");
    const apiKeyEnv = isBuiltInRuntimeProviderId(providerConnection.providerId)
      ? BUILTIN_RUNTIME_PROVIDER_ENV_KEYS[providerConnection.providerId]
      : BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS[providerConnection.providerId];
    const apiKey = launchEnvVars?.[apiKeyEnv];
    if (!apiKey) throw new Error("Provider connection launch credential is missing");
    const runtimeProviderId = providerConnection.providerId === "openai-compatible"
      ? "openai"
      : providerConnection.providerId === "anthropic-compatible"
        ? "anthropic"
        : providerConnection.providerId;
    await setHeaderSafeRuntimeApiKey(modelRuntime, runtimeProviderId, apiKey, apiKeyEnv);
    return;
  }
  if (runtimeConfig.provider.kind === "preset") {
    await setHeaderSafeRuntimeApiKey(
      modelRuntime,
      runtimeConfig.provider.providerId,
      runtimeConfig.provider.apiKey,
      `The ${runtimeConfig.provider.providerId} API key`,
    );
    return;
  }
  if (runtimeConfig.provider.providerId === "openai-compatible") {
    await setHeaderSafeRuntimeApiKey(modelRuntime, "openai", runtimeConfig.provider.apiKey, "The OpenAI-compatible API key");
  } else if (runtimeConfig.provider.providerId === "anthropic-compatible") {
    await setHeaderSafeRuntimeApiKey(modelRuntime, "anthropic", runtimeConfig.provider.apiKey, "The Anthropic-compatible API key");
  }
}

export function buildPiSessionCreateEnvPatch(
  runtimeConfig: RuntimeConfig,
  envVars: Record<string, string> | null,
): Record<string, string> | null {
  if (!envVars) return null;
  const providerApiKeyEnvNames = runtimeConfig.runtime === "builtin"
    ? new Set([
        ...Object.values(BUILTIN_RUNTIME_PROVIDER_ENV_KEYS),
        ...Object.values(BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS),
      ])
    : runtimeConfig.runtime === "pi" && runtimeConfig.provider?.kind === "pi-builtin"
      ? new Set([PI_BUILTIN_PROVIDER_ENV_KEYS[runtimeConfig.provider.providerId]])
      : new Set<string>();
  if (providerApiKeyEnvNames.size === 0) return envVars;
  const filtered = Object.fromEntries(
    Object.entries(envVars).filter(([key]) => !providerApiKeyEnvNames.has(key)),
  );
  return Object.keys(filtered).length > 0 ? filtered : null;
}

let processEnvPatchTail: Promise<void> = Promise.resolve();

async function runWithProcessEnvPatchLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = processEnvPatchTail;
  let release!: () => void;
  processEnvPatchTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function withProcessEnvPatch<T>(
  patch: Record<string, string> | null | undefined,
  fn: () => Promise<T>,
  opts: { removeFirst?: readonly string[] } = {},
): Promise<T> {
  const keys = new Set([...(opts.removeFirst ?? []), ...Object.keys(patch ?? {})]);
  if (keys.size === 0) return fn();

  return runWithProcessEnvPatchLock(async () => {
    const previous: Record<string, string | undefined> = {};
    for (const key of keys) {
      previous[key] = process.env[key];
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(patch ?? {})) {
      process.env[key] = value;
    }
    try {
      return await fn();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
}

/** The model-registry provider a built-in gateway custom model is registered
 * under. Registration and selection must use this one mapping. */
function builtInGatewayRegistryProvider(
  providerId: "openai-compatible" | "anthropic-compatible",
): { id: "openai"; api: "openai-completions"; apiKeyEnv: "OPENAI_API_KEY" }
  | { id: "anthropic"; api: "anthropic-messages"; apiKeyEnv: "ANTHROPIC_API_KEY" } {
  return providerId === "openai-compatible"
    ? { id: "openai", api: "openai-completions", apiKeyEnv: "OPENAI_API_KEY" }
    : { id: "anthropic", api: "anthropic-messages", apiKeyEnv: "ANTHROPIC_API_KEY" };
}

export function resolvePiModelFromRegistry(
  modelId: string | null | undefined,
  modelRegistry: ModelRegistry,
  runtimeConfig: RuntimeConfig,
  providerConnection: ProviderConnectionLaunchProjection | null = null,
) {
  if (!modelId || modelId === "default") return undefined;
  // A built-in custom model reached through a gateway — configured directly or
  // through a managed provider connection — is registered under exactly one
  // provider (configureBuiltInGatewayCustomModel). Select only that entry: the
  // bare name can also exist in the SDK catalog under another provider (e.g.
  // github-copilot/kimi-k3), and a custom name may itself contain "/". A missing
  // entry must stay missing so the launch fails as RuntimeModelNotFoundError
  // instead of silently running a different provider's model.
  const gateway = resolveBuiltInGatewayLaunch(runtimeConfig, providerConnection);
  if (gateway && runtimeConfig.runtime === "builtin" && runtimeConfig.model.kind === "custom") {
    return modelRegistry.find(builtInGatewayRegistryProvider(gateway.providerId).id, runtimeConfig.model.name);
  }
  const [provider, ...modelParts] = modelId.split("/");
  if (provider && modelParts.length > 0) {
    return modelRegistry.find(provider, modelParts.join("/"));
  }

  return modelRegistry.getAll().find((model) => model.id === modelId);
}

function normalizeGatewayBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function findMatchingOpenAICompatibleModel(
  modelRegistry: ModelRegistry,
  baseUrl: string,
  modelId: string,
): Model<"openai-completions"> | undefined {
  const normalizedBaseUrl = normalizeGatewayBaseUrl(baseUrl);
  return modelRegistry.getAll().find(
    (model): model is Model<"openai-completions"> =>
      model.api === "openai-completions"
      && model.id === modelId
      && normalizeGatewayBaseUrl(model.baseUrl) === normalizedBaseUrl,
  );
}

export function resolveBuiltInGatewayModelInput(
  registryInput: Model<"openai-completions">["input"] | undefined,
  supportsImageInput: boolean | undefined,
): Model<"openai-completions">["input"] {
  const input = registryInput ?? ["text"];
  return supportsImageInput === true
    ? [...new Set([...input, "text" as const, "image" as const])]
    : input;
}

export function resolveBuiltInGatewayLaunch(
  runtimeConfig: RuntimeConfig,
  providerConnection: ProviderConnectionLaunchProjection | null = null,
): {
  providerId: "openai-compatible" | "anthropic-compatible";
  baseUrl: string;
  supportsImageInput?: boolean;
} | null {
  if (runtimeConfig.runtime !== "builtin") return null;
  if (runtimeConfig.model.kind !== "custom") return null;
  if (runtimeConfig.provider.kind === "gateway") return runtimeConfig.provider;
  if (
    runtimeConfig.provider.kind === "connection"
    && providerConnection
    && isBuiltInRuntimeGatewayProviderId(providerConnection.providerId)
    && providerConnection.endpointUrl
  ) {
    return {
      providerId: providerConnection.providerId,
      baseUrl: providerConnection.endpointUrl,
      supportsImageInput: providerConnection.supportsImageInput,
    };
  }
  return null;
}

export function configureBuiltInGatewayCustomModel(
  modelRegistry: ModelRegistry,
  runtimeConfig: RuntimeConfig,
  providerConnection: ProviderConnectionLaunchProjection | null,
): void {
  const gateway = resolveBuiltInGatewayLaunch(runtimeConfig, providerConnection);
  if (!gateway || runtimeConfig.runtime !== "builtin" || runtimeConfig.model.kind !== "custom") return;

  const provider = builtInGatewayRegistryProvider(gateway.providerId);
  const matchingModel = provider.api === "openai-completions"
    ? findMatchingOpenAICompatibleModel(
        modelRegistry,
        gateway.baseUrl,
        runtimeConfig.model.name,
      )
    : undefined;
  const input = resolveBuiltInGatewayModelInput(
    matchingModel?.input,
    gateway.supportsImageInput,
  );

  modelRegistry.registerProvider(provider.id, {
    name: getRuntimeProviderDisplayName(gateway.providerId),
    baseUrl: gateway.baseUrl,
    apiKey: `$${provider.apiKeyEnv}`,
    api: provider.api,
    models: [{
      id: runtimeConfig.model.name,
      name: matchingModel?.name ?? runtimeConfig.model.name,
      reasoning: matchingModel?.reasoning ?? true,
      thinkingLevelMap: matchingModel?.thinkingLevelMap,
      input,
      cost: matchingModel?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: matchingModel?.contextWindow ?? 200_000,
      maxTokens: matchingModel?.maxTokens ?? 8192,
      ...(provider.api === "openai-completions"
        ? {
            // A user-supplied OpenAI-compatible endpoint is not necessarily
            // native OpenAI. Keep unknown payloads portable, while preserving
            // exact SDK metadata when endpoint + model match a known provider
            // (for example Qwen Token Plan).
            compat: matchingModel?.compat ?? {
              supportsDeveloperRole: false,
              supportsStore: false,
            },
          }
        : {}),
    }],
  });
}

function findPiSessionFile(sessionDir: string, sessionId: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(sessionDir);
  } catch {
    return null;
  }

  const suffix = `_${sessionId}.jsonl`;
  const match = entries.find((entry) => entry.endsWith(suffix));
  return match ? path.join(sessionDir, match) : null;
}

export function detectPiModelsFromRegistry(modelRegistry: PiModelRegistryLike): RuntimeModelSet | null {
  const models: RuntimeModelInfo[] = [];
  const seen = new Set<string>();

  for (const model of modelRegistry.getAvailable()) {
    const id = `${model.provider}/${model.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: `${model.name || humanizeRuntimeProviderSegment(model.id)} · ${getRuntimeProviderDisplayName(model.provider)}`,
      verified: "launchable",
    });
  }

  return models.length > 0 ? { models } : null;
}

function applyPiDaemonSettingsOverrides(settingsManager: SettingsManager): void {
  settingsManager.applyOverrides({ compaction: { enabled: PI_SDK_COMPACTION_ENABLED } });
}

function logPiServiceDiagnostics(context: string, services: AgentSessionServices): void {
  for (const diagnostic of services.diagnostics) {
    const message = `[pi-driver] ${context} diagnostic: ${diagnostic.message}`;
    if (diagnostic.type === "info") {
      console.info(message);
    } else {
      console.warn(message);
    }
  }
}

function formatPiModelLogId(model: Model<any> | undefined): string {
  return model ? `${model.provider}/${model.id}` : "default";
}

function piServiceDiagnosticTraceAttrs(services: AgentSessionServices): Record<string, number> {
  let info = 0;
  let warning = 0;
  for (const diagnostic of services.diagnostics) {
    if (diagnostic.type === "info") {
      info++;
    } else {
      warning++;
    }
  }
  return {
    diagnostics_count: services.diagnostics.length,
    diagnostic_info_count: info,
    diagnostic_warning_count: warning,
  };
}

function addPiServiceTraceEvent(
  span: RuntimeModelDetectionContext["span"],
  name: string,
  services: AgentSessionServices,
  attrs: Record<string, unknown> = {},
): void {
  const modelRegistry = new ModelRegistry(services.modelRuntime);
  span?.addEvent(name, {
    available_models_count: modelRegistry.getAvailable().length,
    ...piServiceDiagnosticTraceAttrs(services),
    ...attrs,
  });
}

export async function detectPiModels(
  modelRegistry?: PiModelRegistryLike,
  traceContext: RuntimeModelDetectionContext = {},
): Promise<RuntimeModelSet | null> {
  if (modelRegistry) {
    return detectPiModelsFromRegistry(modelRegistry);
  }

  const agentDir = getAgentDir();
  const services = await createAgentSessionServices({
    cwd: process.cwd(),
    agentDir,
  });
  const detectedModelRegistry = new ModelRegistry(services.modelRuntime);
  logPiServiceDiagnostics("detect_models", services);
  addPiServiceTraceEvent(traceContext.span, "daemon.pi.models.services_ready", services);
  const result = detectPiModelsFromRegistry(detectedModelRegistry);
  traceContext.span?.addEvent("daemon.pi.models.result", {
    available_models_count: detectedModelRegistry.getAvailable().length,
    returned_models_count: result?.models?.length ?? 0,
    outcome: result ? "models_returned" : "no_models",
    ...piServiceDiagnosticTraceAttrs(services),
  });
  console.info(
    "[pi-driver] detect_models agentDir=%s available=%d returned=%d",
    agentDir,
    detectedModelRegistry.getAvailable().length,
    result?.models?.length ?? 0,
  );
  return result;
}

function piErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    try {
      return JSON.stringify(error);
    } catch {
      // Fall through.
    }
  }
  return "Unknown Pi error";
}

type PiProviderRequestFailureReason =
  | "provider_auth_denied"
  | "provider_rate_limited"
  | "provider_not_found"
  | "provider_request_rejected"
  | "provider_server_error"
  | "pre_response_transport_error"
  | "stream_read_error"
  | "provider_unknown_error";

type PiProviderRequestState = {
  phase: RuntimeTerminalCausePhase;
  responseStarted: boolean;
  failureReported: boolean;
  span: ActiveSpan | undefined;
  settle?: (status: "ok" | "error") => void;
};

function writePiLifecycleDiagnostic(
  ctx: SpawnContext,
  sessionId: string,
  event: RuntimeLifecycleDiagnosticEvent,
  logPrefix: string,
): boolean {
  const written = Boolean(writeRuntimeLifecycleDiagnosticRecord({
    runtime: ctx.config.runtime,
    sessionId,
    fallbackDir: ctx.workingDirectory,
    agentId: ctx.agentId,
    launchId: ctx.launchId ?? null,
    processInstanceId: ctx.processInstanceId ?? null,
    event,
  }));
  console.info("[%s] runtime_lifecycle %s", logPrefix, JSON.stringify({
    sessionId,
    launchId: ctx.launchId ?? null,
    processInstanceId: ctx.processInstanceId ?? null,
    event,
    diagnosticPersisted: written,
  }));
  return written;
}

/**
 * Closed set of error classes the persisted lifecycle diagnostics may name.
 * The sidecar is a diagnostic artifact that outlives the process, so an
 * `error.name` is copied only when it is one of these known categories;
 * anything else (including a name that merely looks identifier-shaped) is
 * written as `UnknownError`. The set is the shared runtime error taxonomy
 * plus the daemon's own startup/launch error classes and the JS built-ins
 * that reach the Built-in driver's start and transcript-persist paths.
 */
const DIAGNOSTIC_ERROR_CLASSES: ReadonlySet<string> = new Set<string>([
  ...RUNTIME_ERROR_CLASSES,
  "RuntimeModelNotFoundError",
  "RuntimeExecutableNotFoundError",
  "RuntimeSessionStartError",
  "RuntimeVersionTooOldError",
  "ProviderConnectionMaterializationError",
  "RunnerCredentialMintError",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "AggregateError",
  "AbortError",
]);

export function safeDiagnosticErrorClass(error: unknown): string {
  const name = error instanceof Error ? error.name : undefined;
  return name !== undefined && DIAGNOSTIC_ERROR_CLASSES.has(name) ? name : "UnknownError";
}

/**
 * Closed set of `error.code` values the persisted lifecycle diagnostics may copy:
 * Node/undici transport codes and Node file-system codes that reach the Built-in
 * driver's start and transcript-persist paths. Like the error class, the code is
 * externally controlled text, so an identifier-shaped value is not enough; anything
 * outside this set is omitted rather than persisted.
 */
const DIAGNOSTIC_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  // transport
  "ABORT_ERR",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_ABORTED",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  // file system
  "EACCES",
  "EAGAIN",
  "EBUSY",
  "EEXIST",
  "EINVAL",
  "EIO",
  "EISDIR",
  "EMFILE",
  "ENAMETOOLONG",
  "ENFILE",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "EPERM",
  "EROFS",
]);

export function safeDiagnosticErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && DIAGNOSTIC_ERROR_CODES.has(code) ? code : undefined;
}

function safeTranscriptEntryType(
  value: unknown,
): Extract<RuntimeLifecycleDiagnosticEvent, { kind: "transcript_persist" }>["entryType"] {
  switch (value) {
    case "message":
    case "thinking_level_change":
    case "model_change":
    case "compaction":
    case "branch_summary":
    case "custom":
    case "custom_message":
    case "label":
    case "session_info":
      return value;
    default:
      return "unknown";
  }
}

type PiDeliveryRequest = {
  requestMethod: () => "turn/start" | "turn/steer";
  text: string;
};

function normalizeProviderHttpStatus(value: unknown): number | null {
  const status = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d{3}$/u.test(value.trim())
      ? Number(value)
      : Number.NaN;
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

function readProviderHttpStatus(error: unknown): number | null {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const value of [record.status, record.statusCode]) {
      const status = normalizeProviderHttpStatus(value);
      if (status !== null) return status;
    }
    if (record.response && typeof record.response === "object") {
      const status = normalizeProviderHttpStatus(
        (record.response as Record<string, unknown>).status,
      );
      if (status !== null) return status;
    }
  }

  const message = piErrorMessage(error);
  const match = /\b(?:HTTP|status(?:\s+code)?|API\s+Error)[:\s]+([45]\d{2})\b/iu.exec(message)
    ?? /\b([45]\d{2})\s+(?:status(?:\s+code)?|Bad Request|Unauthorized|Forbidden|Not Found|Conflict|Too Many Requests|Internal Server Error|Service Unavailable)\b/iu.exec(message);
  return normalizeProviderHttpStatus(match?.[1]);
}

function classifyPiProviderRequestFailure(
  error: unknown,
  responseStarted: boolean,
): { reason: PiProviderRequestFailureReason; http_status?: number } {
  try {
    const httpStatus = readProviderHttpStatus(error);
    let reason: PiProviderRequestFailureReason;
    if (httpStatus === 401 || httpStatus === 403) {
      reason = "provider_auth_denied";
    } else if (httpStatus === 429) {
      reason = "provider_rate_limited";
    } else if (httpStatus === 404) {
      reason = "provider_not_found";
    } else if (httpStatus !== null && httpStatus < 500) {
      reason = "provider_request_rejected";
    } else if (httpStatus !== null) {
      reason = "provider_server_error";
    } else if (isPiProviderTransportFailure(error)) {
      reason = responseStarted ? "stream_read_error" : "pre_response_transport_error";
    } else {
      reason = "provider_unknown_error";
    }
    return {
      reason,
      ...(httpStatus === null ? {} : { http_status: httpStatus }),
    };
  } catch {
    return { reason: "provider_unknown_error" };
  }
}

function isPiProviderTransportFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const message = typeof error === "string"
    ? error.trim()
    : error instanceof Error
      ? error.message.trim()
      : "";
  if (/^(?:Connection error\.?|fetch failed|Premature close|socket hang up|terminated)$/iu.test(message)) {
    return true;
  }
  if (/\b(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ETIMEDOUT|UND_ERR_[A-Z_]+)\b/u.test(message)) {
    return true;
  }
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : "";
  if (/^(?:APIConnectionError|ConnectTimeoutError|HeadersTimeoutError|SocketError)$/u.test(name)) {
    return true;
  }
  const code = typeof record.code === "string" ? record.code : "";
  return /^(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ETIMEDOUT|UND_ERR_[A-Z_]+)$/u.test(code);
}

function pushSessionInitIfNeeded(state: PiSdkEventMappingState, events: ParsedEvent[]): void {
  if (!state.sessionAnnounced && state.sessionId) {
    events.push({ kind: "session_init", sessionId: state.sessionId });
    state.sessionAnnounced = true;
  }
}

function piAssistantContentIndex(assistantEvent: PiAssistantMessageEvent): number {
  return "contentIndex" in assistantEvent && typeof assistantEvent.contentIndex === "number"
    ? assistantEvent.contentIndex
    : 0;
}

function announcePiThinkingIfNeeded(index: number, state: PiSdkEventMappingState): ParsedEvent[] {
  if (state.announcedThinkingIndexes.has(index)) return [];
  state.announcedThinkingIndexes.add(index);
  return [{ kind: "thinking", text: "" }];
}

function resetPiThinking(index: number, state: PiSdkEventMappingState): void {
  state.thinkingBuffers.delete(index);
  state.announcedThinkingIndexes.delete(index);
}

function announcePiTextIfNeeded(index: number, state: PiSdkEventMappingState): ParsedEvent[] {
  if (state.announcedTextIndexes.has(index)) return [];
  state.announcedTextIndexes.add(index);
  return [{ kind: "text", text: "" }];
}

function resetPiText(index: number, state: PiSdkEventMappingState): void {
  state.textBuffers.delete(index);
  state.announcedTextIndexes.delete(index);
}

function mapPiAssistantMessageEvent(
  assistantEvent: PiAssistantMessageEvent,
  state: PiSdkEventMappingState,
): ParsedEvent[] {
  switch (assistantEvent.type) {
    case "thinking_start": {
      const index = piAssistantContentIndex(assistantEvent);
      resetPiThinking(index, state);
      return announcePiThinkingIfNeeded(index, state);
    }
    case "thinking_delta": {
      const index = piAssistantContentIndex(assistantEvent);
      const events = announcePiThinkingIfNeeded(index, state);
      if (typeof assistantEvent.delta === "string" && assistantEvent.delta.length > 0) {
        state.thinkingBuffers.set(index, `${state.thinkingBuffers.get(index) ?? ""}${assistantEvent.delta}`);
      }
      return events;
    }
    case "thinking_end": {
      const index = piAssistantContentIndex(assistantEvent);
      const buffered = state.thinkingBuffers.get(index) ?? "";
      const text = typeof assistantEvent.content === "string" && assistantEvent.content.length > 0
        ? assistantEvent.content
        : buffered;
      resetPiThinking(index, state);
      return text ? [{ kind: "thinking", text }] : [];
    }
    case "text_start": {
      const index = piAssistantContentIndex(assistantEvent);
      resetPiText(index, state);
      return announcePiTextIfNeeded(index, state);
    }
    case "text_delta": {
      const index = piAssistantContentIndex(assistantEvent);
      const events = announcePiTextIfNeeded(index, state);
      if (typeof assistantEvent.delta === "string" && assistantEvent.delta.length > 0) {
        state.textBuffers.set(index, `${state.textBuffers.get(index) ?? ""}${assistantEvent.delta}`);
      }
      return events;
    }
    case "text_end": {
      const index = piAssistantContentIndex(assistantEvent);
      const buffered = state.textBuffers.get(index) ?? "";
      const text = typeof assistantEvent.content === "string" && assistantEvent.content.length > 0
        ? assistantEvent.content
        : buffered;
      resetPiText(index, state);
      return text ? [{ kind: "text", text }] : [];
    }
    case "error":
      return [{ kind: "error", message: piErrorMessage(assistantEvent.error.errorMessage || assistantEvent.error) }];
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
    case "start":
    case "done":
      return [];
    default: {
      const _exhaustive: never = assistantEvent;
      return _exhaustive;
    }
  }
}

function mapPiMessageEndEvent(
  event: Extract<AgentSessionEvent, { type: "message_end" }>,
  state: PiSdkEventMappingState,
): ParsedEvent[] {
  const message = event.message as {
    role?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
    usage?: unknown;
  } | undefined;

  const events: ParsedEvent[] = [];

  // The pi-ai AssistantMessage carries a `usage` object (tokens + cost) on both
  // successful and error turns. Emit token_usage telemetry only when usage is
  // actually present (mark-absent, never zero-fill). See piEventNormalizer.ts.
  // sessionId is left undefined; agentProcessManager resolves it from the live
  // driver session when recording the telemetry span.
  const usageEvent = buildPiTokenUsageEvent(message, null);
  if (usageEvent) events.push(usageEvent);

  if (message?.role === "assistant" && message.stopReason === "error") {
    // Pi owns overflow recovery. Emitting the provider rejection here would
    // terminalize the daemon before Pi can compact and retry, and it leaks the
    // provider's raw body into Activity. Preserve any bounded usage telemetry,
    // then wait for compaction_end as the authoritative recovery outcome.
    if (isContextOverflow(message as Parameters<typeof isContextOverflow>[0])) {
      state.pendingProviderError = null;
      state.providerErrorOwnedByCompaction = true;
      return events;
    }
    state.providerErrorOwnedByCompaction = false;
    state.pendingProviderError = typeof message.errorMessage === "string" && message.errorMessage.trim()
      ? message.errorMessage.trim()
      : "Pi SDK assistant turn ended with an unknown provider error";
  }

  return events;
}

function piTerminalCausePhaseForSdkEvent(event: AgentSessionEvent): RuntimeTerminalCausePhase {
  switch (event.type) {
    case "message_update":
      return "message_stream";
    case "message_end":
      return "message_end";
    default:
      return "sdk_event";
  }
}

export function mapPiSdkEventToParsedEvents(
  event: AgentSessionEvent,
  state: PiSdkEventMappingState,
  inputEvidence?: PiCompactionInputEvidence,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  pushSessionInitIfNeeded(state, events);

  switch (event.type) {
    case "agent_start":
    case "turn_start":
    case "turn_end":
    case "tool_execution_update":
    case "queue_update":
    case "session_info_changed":
    case "thinking_level_changed":
    case "auto_retry_start":
      return events;
    case "auto_retry_end":
      if (!event.success) {
        if (state.providerErrorOwnedByCompaction) {
          state.providerErrorOwnedByCompaction = false;
          return events;
        }
        events.push({
          kind: "error",
          // A missing message_end is malformed SDK sequencing. Preserve the
          // terminal boundary by using the SDK's final error when available,
          // otherwise emit the same bounded fallback as message_end.
          message: event.finalError?.trim()
            || state.pendingProviderError
            || "Pi SDK assistant turn ended with an unknown provider error",
        });
        state.pendingProviderError = null;
      } else if (event.success) {
        // The SDK emits auto_retry_end(success=true) after the successful
        // message_end. Only this lifecycle event authorizes discarding the
        // earlier buffered provider failure.
        state.pendingProviderError = null;
        state.providerErrorOwnedByCompaction = false;
      }
      return events;
    case "agent_settled":
      if (state.pendingProviderError) {
        events.push({ kind: "error", message: state.pendingProviderError });
        state.pendingProviderError = null;
      }
      state.providerErrorOwnedByCompaction = false;
      if (state.pendingTurnEnd) {
        state.pendingTurnEnd = false;
        events.push({ kind: "turn_end", sessionId: state.sessionId || undefined });
      }
      return events;
    case "message_end":
      events.push(...mapPiMessageEndEvent(event, state));
      return events;
    case "message_start":
      if ((event.message as { role?: string }).role === "assistant") {
        state.thinkingBuffers.clear();
        state.announcedThinkingIndexes.clear();
        state.textBuffers.clear();
        state.announcedTextIndexes.clear();
      }
      return events;
    case "message_update":
      events.push(...mapPiAssistantMessageEvent(event.assistantMessageEvent, state));
      return events;
    case "tool_execution_start":
      events.push({
        kind: "tool_call",
        name: event.toolName || "unknown_tool",
        input: event.args ?? {},
      });
      return events;
    case "tool_execution_end":
      events.push({ kind: "tool_output", name: event.toolName || "unknown_tool" });
      return events;
    case "compaction_start":
      if (state.compactionTerminal) return events;
      events.push({ kind: "compaction_started" });
      return events;
    case "compaction_end": {
      if (state.compactionTerminal) return events;
      const projection = projectPiCompactionEnd(event);
      const { outcome, reason, failureReason, willRetry } = projection;
      if (outcome === "aborted") {
        events.push({
          kind: "compaction_interrupted",
          outcome,
          reason,
          willRetry,
        });
      } else if (outcome === "compaction_succeeded") {
        events.push({ kind: "compaction_finished" });
      } else {
        state.compactionTerminal = true;
      }
      events.push({
        kind: "telemetry",
        name: "recovery",
        source: "pi_compaction",
        attrs: {
          recovery_outcome: outcome,
          compaction_reason: reason,
          ...(failureReason ? { failure_reason: failureReason } : {}),
          will_retry: willRetry,
          ...projectPiCompactionInputTelemetry(inputEvidence, reason),
        },
      });
      if (outcome === "compaction_failed_or_exhausted") {
        const failureDiagnostic = typeof event.errorMessage === "string" && event.errorMessage.trim().length > 0
          ? buildRuntimeErrorActivityDiagnostic(event.errorMessage)
          : undefined;
        events.push({
          kind: "error",
          // Machine-readable classifier only. APM projects this structured
          // terminal outcome through the existing bounded runtime guidance;
          // raw provider text and new user-facing adapter copy stay out.
          message: failureReason === "compaction_failed" ? "RuntimeError: context compaction failed" : "InputTooLargeError",
          terminalReason: "compaction_failed_or_exhausted",
          // One atomic terminal event owns both the error and compaction facts.
          // A separate interruption would produce duplicate terminal Activity.
          compaction: {
            outcome, reason, failureReason, willRetry: event.willRetry === true,
            ...(failureDiagnostic ? { failureDiagnostic } : {}),
          },
        });
      }
      return events;
    }
    case "agent_end":
      // agent_end precedes Pi's post-run retry/compaction handling. Publishing
      // daemon turn_end here allows APM to flush another prompt while recovery
      // is still resolving, which is the observed recovery loop. agent_settled
      // is the actual boundary after retry/compaction has terminated.
      state.pendingTurnEnd = true;
      return events;
    default:
      return events;
  }
}

const PI_RUNTIME_SESSION_DESCRIPTOR = {
  transport: "sdk",
  lifecycle: "sdk_session",
  stdout: {
    channel: "diagnostic",
  },
  input: {
    initial: "start",
    idle: "sdk_prompt",
    busy: "sdk_steer",
  },
  readiness: "sdk_ready",
  turnBoundary: "sdk_event",
  startPolicy: "immediate",
  inFlightWake: "steer",
  busyDelivery: "direct",
  postTurn: "keep_alive",
} as const satisfies RuntimeSessionDescriptor;

const PI_IDLE_PROMPT_RETRY_MS = 25;
const PI_IDLE_PROMPT_MAX_WAIT_MS = 1_000;

function installProviderHttpClient(
  modelRuntime: ModelRuntime,
  providerHttpClient: ProviderHttpClient,
  customEndpoint: boolean,
): void {
  const fetchForModel = (model: Parameters<ModelRuntime["stream"]>[0]) => {
    const prefix = model.id.split("/")[0];
    const provider = customEndpoint ? "custom" : isBuiltInRuntimeProviderId(model.provider) ? model.provider
      : isBuiltInRuntimeProviderId(prefix) ? prefix : "custom";
    return providerHttpClient.forProvider?.(provider) ?? providerHttpClient.fetch;
  };
  const stream = modelRuntime.stream.bind(modelRuntime);
  modelRuntime.stream = ((model, context, options) => {
    const providerOptions = {
      ...options,
      fetch: fetchForModel(model),
    } as typeof options;
    return stream(model, context, providerOptions);
  }) as ModelRuntime["stream"];

  const streamSimple = modelRuntime.streamSimple.bind(modelRuntime);
  modelRuntime.streamSimple = ((model, context, options) => streamSimple(model, context, {
    ...options,
    fetch: fetchForModel(model),
  })) as ModelRuntime["streamSimple"];
}

export async function createPiAgentSessionForContext(
  ctx: SpawnContext,
  sessionId: string,
  opts: { agentDir?: string; sessionDir?: string; traceName?: string; traceEventPrefix?: string; logPrefix?: string; exposeLaunchEnvToTools?: boolean; isolateHostProviderEnv?: boolean; agentDirSource?: "default" | "spawn_env" | "managed_builtin"; exposeLaunchTraceEvidence?: boolean } = {},
  toolExecutionObserver?: PiToolExecutionObserver,
  providerObserver?: ProviderRequestObserver,
): Promise<AgentSession> {
  const sessionDir = opts.sessionDir ?? buildPiSessionDir(ctx.workingDirectory);
  mkdirSync(sessionDir, { recursive: true });

  const logPrefix = opts.logPrefix ?? "pi-driver";
  writePiLifecycleDiagnostic(ctx, sessionId, {
    kind: "session_start",
    phase: "started",
  }, logPrefix);

  let runtimeConfig: ReturnType<typeof hydrateRuntimeConfig>;
  let launchPlan: ReturnType<typeof buildLaunchPlan>;
  try {
    runtimeConfig = hydrateRuntimeConfig(ctx.config);
    launchPlan = buildLaunchPlan(runtimeConfig);
  } catch (error) {
    const errorCode = safeDiagnosticErrorCode(error);
    writePiLifecycleDiagnostic(ctx, sessionId, {
      kind: "session_start",
      phase: "failed",
      errorClass: safeDiagnosticErrorClass(error),
      ...(errorCode ? { errorCode } : {}),
    }, logPrefix);
    throw error;
  }
  const { trace: launchTrace, configSource: _configSource, ...launchRuntimeFields } = launchPlan;
  launchRuntimeFields.envVars = {
    ...(launchRuntimeFields.envVars ?? {}),
    ...(ctx.config.envVars ?? {}),
  };
  if (Object.keys(launchRuntimeFields.envVars).length === 0) launchRuntimeFields.envVars = null;
  const managedProviderConnection = runtimeConfig.runtime === "builtin"
    && runtimeConfig.provider.kind === "connection"
    ? ctx.config.providerConnection ?? null
    : null;
  const managedProviderApiKeyEnv = managedProviderConnection
    && isBuiltInRuntimeProviderId(managedProviderConnection.providerId)
    ? BUILTIN_RUNTIME_PROVIDER_ENV_KEYS[managedProviderConnection.providerId]
    : managedProviderConnection
      && isBuiltInRuntimeGatewayProviderId(managedProviderConnection.providerId)
      ? BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS[managedProviderConnection.providerId]
      : null;
  const managedProviderKeyPresent = Boolean(
    managedProviderApiKeyEnv && launchRuntimeFields.envVars?.[managedProviderApiKeyEnv],
  );
  const launchTraceEvidenceAttrs = opts.exposeLaunchTraceEvidence ? {
    config_source: launchTrace.config_source,
    ...(runtimeConfig.runtime === "builtin" ? { host_user_state: runtimeConfig.hostUserState } : {}),
    ...(launchTrace.provider_id || managedProviderConnection
      ? { provider_id: launchTrace.provider_id ?? managedProviderConnection?.providerId }
      : {}),
    ...(launchTrace.model_kind ? { model_kind: launchTrace.model_kind } : {}),
    ...(launchTrace.model_id ? { model_id: launchTrace.model_id } : {}),
    ...(launchTrace.base_url_present !== undefined || managedProviderConnection
      ? { base_url_present: launchTrace.base_url_present ?? Boolean(managedProviderConnection?.endpointUrl) }
      : {}),
    ...(launchTrace.base_url_host_class ? { base_url_host_class: launchTrace.base_url_host_class } : {}),
    provider_key_present: launchTrace.provider_key_present || managedProviderKeyPresent,
    ...(launchTrace.provider_key_source || managedProviderKeyPresent
      ? { provider_key_source: launchTrace.provider_key_source ?? "server_managed_connection" }
      : {}),
  } : {};
  const requestedModel = launchRuntimeFields.model || "default";
  const traceSpan = ctx.tracer?.startSpan(opts.traceName ?? "daemon.pi.session.create", {
    surface: "daemon",
    kind: "internal",
    attrs: {
      agentId: ctx.agentId,
      launchId: ctx.launchId || undefined,
      runtime: ctx.config.runtime,
      model: ctx.config.model,
      session_id_present: Boolean(sessionId),
      requested_model: requestedModel,
      ...launchTraceEvidenceAttrs,
    },
  });
  const traceEventPrefix = opts.traceEventPrefix ?? "daemon.pi.session";
  let providerHttpClient: ProviderHttpClient | undefined;

  try {
    const spawnEnv = await buildPiSpawnEnv(ctx);
    const agentDir = opts.agentDir ?? spawnEnv.PI_CODING_AGENT_DIR ?? getAgentDir();
    mkdirSync(agentDir, { recursive: true });
    const settingsManager = SettingsManager.create(ctx.workingDirectory, agentDir);
    // Resolve only enabled host extensions. Keep host auth, models and other
    // settings out of the managed Built-in session, and never install packages.
    let localExtensionPaths: string[] = [];
    if (runtimeConfig.runtime === "builtin" && runtimeConfig.loadLocalPlugins === true) {
      const hostAgentDir = spawnEnv.PI_CODING_AGENT_DIR ?? getAgentDir();
      const hostSettings = SettingsManager.create(ctx.workingDirectory, hostAgentDir, { projectTrusted: false });
      const hostPackages = new DefaultPackageManager({
        cwd: ctx.workingDirectory,
        agentDir: hostAgentDir,
        settingsManager: hostSettings,
      });
      const resources = await hostPackages.resolve(async () => "skip");
      localExtensionPaths = resources.extensions.filter((entry) => entry.enabled).map((entry) => entry.path);
    }
    const providerEnvScope = opts.isolateHostProviderEnv ? BUILTIN_BLOCKED_HOST_PROVIDER_ENV_KEYS : undefined;
    const sessionCreateEnvPatch = buildPiSessionCreateEnvPatch(runtimeConfig, launchRuntimeFields.envVars);
    const sessionServices = await withProcessEnvPatch(sessionCreateEnvPatch, async () => {
      const sessionProviderHttpClient = createProviderHttpClient(
        process.env,
        `pi-provider:${randomUUID()}`,
        { provider: "custom", observe: providerObserver },
      );
      try {
        const modelRuntime = await ModelRuntime.create({
          authPath: path.join(agentDir, "auth.json"),
          modelsPath: path.join(agentDir, "models.json"),
          allowModelNetwork: false,
        });
        installProviderHttpClient(modelRuntime, sessionProviderHttpClient,
          runtimeConfig.runtime === "builtin" && (runtimeConfig.provider.kind === "gateway"
            || (runtimeConfig.provider.kind === "connection" && Boolean(managedProviderConnection?.endpointUrl))));
        // Request-time credentials and proxy routing must be session-local.
        // Holding a process.env patch across an async SDK turn serializes every
        // Pi agent in this runner. The short create-time scope also keeps
        // ModelRuntime's initial refresh from snapshotting forbidden host
        // provider credentials for Built-in.
        await seedPiSessionModelRuntime(
          modelRuntime,
          runtimeConfig,
          managedProviderConnection,
          launchRuntimeFields.envVars,
        );
        const services = await createAgentSessionServices({
          cwd: ctx.workingDirectory,
          agentDir,
          modelRuntime,
          settingsManager,
          resourceLoaderOptions: {
            additionalExtensionPaths: localExtensionPaths,
            systemPromptOverride: () => ctx.standingPrompt,
          },
        });
        return { services, providerHttpClient: sessionProviderHttpClient };
      } catch (error) {
        sessionProviderHttpClient.dispose();
        throw error;
      }
    }, { removeFirst: providerEnvScope });
    const { services } = sessionServices;
    providerHttpClient = sessionServices.providerHttpClient;
    const modelRegistry = new ModelRegistry(services.modelRuntime);
    configureBuiltInGatewayCustomModel(modelRegistry, runtimeConfig, managedProviderConnection);
    applyPiDaemonSettingsOverrides(services.settingsManager);
    logPiServiceDiagnostics("create_session", services);
    addPiServiceTraceEvent(traceSpan, `${traceEventPrefix}.services_ready`, services, {
      agent_dir_source: opts.agentDirSource ?? (spawnEnv.PI_CODING_AGENT_DIR ? "spawn_env" : "default"),
      ...launchTraceEvidenceAttrs,
    });
    const model = resolvePiModelFromRegistry(
      launchRuntimeFields.model,
      modelRegistry,
      runtimeConfig,
      managedProviderConnection,
    );
    const resolvedModel = formatPiModelLogId(model);
    writePiLifecycleDiagnostic(ctx, sessionId, {
      kind: "model_resolved",
      requestedModel,
      providerId: model?.provider ?? null,
      modelId: model?.id ?? null,
      modelApi: model?.api ?? null,
      configSource: launchTrace.config_source ?? null,
    }, logPrefix);
    traceSpan?.addEvent(`${traceEventPrefix}.model_resolved`, {
      available_models_count: modelRegistry.getAvailable().length,
      requested_model: requestedModel,
      requested_model_explicit: requestedModel !== "default",
      resolved_model: resolvedModel,
      resolved_model_present: Boolean(model),
      ...launchTraceEvidenceAttrs,
    });
    console.info(
      "[%s] create_session services_ready agentDir=%s available=%d requested=%s resolved=%s",
      logPrefix,
      agentDir,
      modelRegistry.getAvailable().length,
      requestedModel,
      resolvedModel,
    );
    if (launchRuntimeFields.model && launchRuntimeFields.model !== "default" && !model) {
      console.warn(
        "[%s] create_session missing_model requested=%s available=%d",
        logPrefix,
        requestedModel,
        modelRegistry.getAvailable().length,
      );
      traceSpan?.addEvent(`${traceEventPrefix}.missing_model`, {
        available_models_count: modelRegistry.getAvailable().length,
        requested_model: requestedModel,
        ...launchTraceEvidenceAttrs,
      });
      traceSpan?.end("error", {
        attrs: {
          outcome: "missing_model",
          available_models_count: modelRegistry.getAvailable().length,
          requested_model: requestedModel,
          resolved_model_present: false,
          ...piServiceDiagnosticTraceAttrs(services),
          ...launchTraceEvidenceAttrs,
        },
      });
      throw new RuntimeModelNotFoundError({ runtimeId: "builtin", model: launchRuntimeFields.model });
    }

    const existingSessionFile = ctx.config.sessionId ? findPiSessionFile(sessionDir, ctx.config.sessionId) : null;
    const sessionManager = existingSessionFile
      ? SessionManager.open(existingSessionFile, sessionDir, ctx.workingDirectory)
      : SessionManager.create(ctx.workingDirectory, sessionDir, { id: sessionId });
    const persistSessionEntry = sessionManager._persist.bind(sessionManager);
    let lastTranscriptPersistOutcome: "deferred" | "persisted" | "failed" | null = null;
    sessionManager._persist = (entry) => {
      const entryType = safeTranscriptEntryType(entry.type);
      try {
        persistSessionEntry(entry);
        const sessionFile = sessionManager.getSessionFile();
        const outcome = sessionFile && existsSync(sessionFile) ? "persisted" : "deferred";
        if (outcome !== lastTranscriptPersistOutcome) {
          lastTranscriptPersistOutcome = outcome;
          writePiLifecycleDiagnostic(ctx, sessionId, {
            kind: "transcript_persist",
            outcome,
            entryType,
          }, logPrefix);
        }
      } catch (error) {
        lastTranscriptPersistOutcome = "failed";
        const errorCode = safeDiagnosticErrorCode(error);
        writePiLifecycleDiagnostic(ctx, sessionId, {
          kind: "transcript_persist",
          outcome: "failed",
          entryType,
          errorClass: safeDiagnosticErrorClass(error),
          ...(errorCode ? { errorCode } : {}),
        }, logPrefix);
        throw error;
      }
    };

    const toolSpawnEnv = { ...spawnEnv };
    if (opts.exposeLaunchEnvToTools === false) {
      for (const key of Object.keys(launchRuntimeFields.envVars ?? {})) {
        delete toolSpawnEnv[key];
      }
    }

    const managedMcpTools = await createManagedMcpPiTools({
      serverUrl: ctx.config.serverUrl,
      agentCredentialKey: ctx.config.agentCredentialKey,
      onWarning: (message) => console.warn("[%s] %s", logPrefix, message),
    });

    const { session } = await withProcessEnvPatch(sessionCreateEnvPatch, () => createAgentSessionFromServices({
      services,
      sessionManager,
      model,
      thinkingLevel: launchRuntimeFields.reasoningEffort as ModelThinkingLevel | undefined,
      customTools: [
        createPiCommandTool(ctx.workingDirectory, toolSpawnEnv, {
          observer: toolExecutionObserver,
        }),
        ...managedMcpTools,
      ],
    }), { removeFirst: providerEnvScope });
    const disposeSession = session.dispose.bind(session);
    let sessionDisposed = false;
    session.dispose = () => {
      if (sessionDisposed) return;
      sessionDisposed = true;
      try {
        disposeSession();
      } finally {
        sessionServices.providerHttpClient.dispose();
      }
    };

    if (runtimeConfig.runtime === "builtin" && runtimeConfig.loadLocalPlugins === true) {
      try {
        // Complete the SDK extension lifecycle, including session_start hooks.
        await session.bindExtensions({ mode: "rpc" });
      } catch (error) {
        session.dispose();
        throw error;
      }
    }

    traceSpan?.addEvent(`${traceEventPrefix}.started`, {
      requested_model: requestedModel,
      resolved_model: resolvedModel,
      session_id_present: Boolean(session.sessionId),
      ...launchTraceEvidenceAttrs,
    });
    traceSpan?.end("ok", {
      attrs: {
        outcome: "started",
        available_models_count: modelRegistry.getAvailable().length,
        requested_model: requestedModel,
        resolved_model: resolvedModel,
        resolved_model_present: Boolean(model),
        ...piServiceDiagnosticTraceAttrs(services),
        ...launchTraceEvidenceAttrs,
      },
    });
    console.info(
      "[%s] create_session started sessionId=%s requested=%s resolved=%s",
      logPrefix,
      sessionId,
      requestedModel,
      resolvedModel,
    );
    writePiLifecycleDiagnostic(ctx, sessionId, {
      kind: "session_start",
      phase: "ready",
    }, logPrefix);
    providerHttpClient = undefined;
    return session;
  } catch (error) {
    providerHttpClient?.dispose();
    const errorCode = safeDiagnosticErrorCode(error);
    writePiLifecycleDiagnostic(ctx, sessionId, {
      kind: "session_start",
      phase: "failed",
      errorClass: safeDiagnosticErrorClass(error),
      ...(errorCode ? { errorCode } : {}),
    }, logPrefix);
    traceSpan?.end("error", {
      attrs: {
        outcome: "error",
        error_class: errorClassOf(error),
        ...launchTraceEvidenceAttrs,
      },
    });
    throw error;
  }
}

/**
 * Pi SDK prompts currently in flight in this runner process, across all agents.
 *
 * This is the direct observable for the credential-isolation fix (task #510).
 * While request-time credentials were resolved from `process.env`, every
 * prompt/steer ran inside `runWithProcessEnvPatchLock`, so the lock was held for
 * the whole model turn and this counter could never exceed 1 — N agents sharing
 * one machine-wide runner serialized into a single queue (observed: 60-165s waits
 * for ~17s of real work). With session-local credentials the prompt path takes no
 * process-global lock, so this rises to the number of concurrently prompting
 * agents. A value > 1 is therefore proof the cross-agent queue is gone.
 */
let piPromptsInFlight = 0;

/** Test-only: read the process-wide in-flight prompt count. */
export function __piPromptsInFlightForTest(): number {
  return piPromptsInFlight;
}

export class PiSdkRuntimeSession implements RuntimeSession {
  readonly descriptor = PI_RUNTIME_SESSION_DESCRIPTOR;
  private readonly events = new EventEmitter();
  private readonly mappingState: PiSdkEventMappingState;
  private readonly toolExecutionObserver: PiToolExecutionObserver | undefined;
  private session: AgentSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private didClose = false;
  private requestedStopReason: string | undefined;
  private cancellationSource: "requested_stop" | "dispose" | null = null;
  private exitInfo: RuntimeExitInfo | null = null;
  private activeProviderRequest: PiProviderRequestState | null = null;

  constructor(
    private readonly ctx: SpawnContext,
    private readonly setCurrentSessionId: (sessionId: string | null) => void,
    private readonly sessionFactory: PiSessionFactory = (
      sessionCtx,
      sessionId,
      observer,
      providerObserver,
    ) => createPiAgentSessionForContext(sessionCtx, sessionId, {}, observer, providerObserver),
  ) {
    this.mappingState = createPiSdkEventMappingState(ctx.config.sessionId || null);
    const runtimeContext = ctx.config.runtimeContext;
    this.toolExecutionObserver = ctx.config.runtime === "pi"
      && Boolean(runtimeContext?.serverId)
      && Boolean(runtimeContext?.machineId)
      && Boolean(ctx.launchId)
      ? createPiToolExecutionObserver({
          tracer: ctx.tracer,
          serverId: runtimeContext!.serverId!,
          machineId: runtimeContext!.machineId!,
          agentId: ctx.agentId,
          launchId: ctx.launchId!,
          runtimeVersion: PI_SDK_VERSION,
          runtimeSessionId: ctx.config.sessionId,
        })
      : undefined;
  }

  get pid(): undefined {
    return undefined;
  }

  get currentSessionId(): string | null {
    return this.mappingState.sessionId;
  }

  get exitCode(): number | null {
    return this.exitInfo?.code ?? null;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.exitInfo?.signal ?? null;
  }

  get closed(): boolean {
    return this.didClose;
  }

  // In-process SDK session: there is no OS pid to probe with signal-0, so
  // liveness is unknowable via the pid-probe boundary. Return undefined, which
  // callers treat the same as the historic "no pid" probe result (RS-011).
  isAlive(): boolean | undefined {
    return undefined;
  }

  emitToolDiagnosticSnapshots(
    input: RuntimeToolDiagnosticInput,
  ): RuntimeToolDiagnosticSnapshot[] {
    return this.toolExecutionObserver?.emitDiagnosticSnapshots(input) ?? [];
  }

  on<T extends RuntimeSessionEventName>(
    event: T,
    cb: (...args: RuntimeSessionEvents[T]) => void,
  ): void {
    this.events.on(event, cb as (...args: unknown[]) => void);
  }

  async start(input: { text: string; sessionId?: string | null }): Promise<RuntimeSendResult> {
    if (this.started) {
      return { ok: false, reason: "runtime_error", error: "runtime session already started" };
    }
    if (this.didClose) return { ok: false, reason: "closed" };
    this.started = true;
    const sessionId = input.sessionId || this.ctx.config.sessionId || randomUUID();
    this.mappingState.sessionId = sessionId;
    this.setCurrentSessionId(sessionId);
    this.toolExecutionObserver?.setRuntimeSessionId(sessionId);

    const session = await this.sessionFactory({
      ...this.ctx,
      config: {
        ...this.ctx.config,
        sessionId,
      },
    }, sessionId, this.toolExecutionObserver, (activity) => {
      this.recordProviderRequestActivity(activity);
      if (!this.didClose) this.emitRuntimeEvent({ kind: "provider_request", activity });
    });
    this.session = session;
    this.mappingState.sessionId = session.sessionId;
    this.setCurrentSessionId(session.sessionId);
    this.toolExecutionObserver?.setRuntimeSessionId(session.sessionId);
    this.unsubscribe = session.subscribe((event) => {
      this.observeToolExecutionEvent(event);
      this.recordCompactionLifecycle(event);
      if (
        event.type === "message_start" &&
        (event.message as { role?: unknown }).role === "assistant"
      ) {
        this.markProviderResponseStarted();
      }
      const inputEvidence = event.type === "compaction_end"
        ? piCompactionInputEvidence(session)
        : undefined;
      for (const parsed of mapPiSdkEventToParsedEvents(
        event,
        this.mappingState,
        inputEvidence,
      )) {
        if (parsed.kind === "error") {
          this.reportProviderRequestFailure(parsed.message);
        }
        this.emitRuntimeEvent(parsed, piTerminalCausePhaseForSdkEvent(event));
      }
    });

    this.launchPrompt(input.text);
    // Register the initial prompt before announcing readiness. The runtime
    // event is synchronous, and a zero-delay readiness-debt settlement may
    // enqueue a busy steer; FIFO setImmediate ordering must keep the initial
    // prompt ahead of that steer.
    this.emitSessionInit();
    return { ok: true, acceptedAs: "prompt" };
  }

  send(input: {
    mode: "idle" | "busy";
    text: string;
    sessionId?: string | null;
  }): RuntimeSendResult {
    if (this.didClose) return { ok: false, reason: "closed" };
    const session = this.session;
    if (!session) return { ok: false, reason: "closed" };

    if (input.mode === "busy") {
      this.deferSdkCall(
        () => session.steer(input.text),
        "steer_request",
        { requestMethod: () => "turn/steer", text: input.text },
      );
      return { ok: true, acceptedAs: "steer" };
    }

    if (session.isStreaming) {
      this.launchPromptAfterStreaming(input.text);
      return { ok: true, acceptedAs: "prompt" };
    }
    this.launchPrompt(input.text, true);
    return { ok: true, acceptedAs: "prompt" };
  }

  async stop(opts?: {
    signal?: NodeJS.Signals;
    forceAfterMs?: number;
    reason?: string;
  }): Promise<void> {
    if (this.didClose) return;
    this.requestedStopReason = opts?.reason;
    const signal = opts?.signal ?? "SIGTERM";
    const session = this.session;
    if (session?.isStreaming || this.activeProviderRequest) {
      this.cancellationSource = "requested_stop";
      this.recordLifecycle({
        kind: "cancel_requested",
        source: "requested_stop",
        signal,
        providerRequestActive: Boolean(this.activeProviderRequest),
      });
    }
    if (session?.isStreaming) {
      try {
        await session.abort();
      } catch (error) {
        this.events.emit("stderr", piErrorMessage(error));
      }
    }
    await this.disposeSession();
    this.emitExitAndClose(null, signal);
  }

  async dispose(): Promise<void> {
    if (this.didClose) return;
    if (this.session?.isStreaming || this.activeProviderRequest) {
      this.cancellationSource = "dispose";
      this.recordLifecycle({
        kind: "cancel_requested",
        source: "dispose",
        signal: null,
        providerRequestActive: Boolean(this.activeProviderRequest),
      });
    }
    await this.disposeSession();
    this.emitExitAndClose(0, null);
  }

  private emitSessionInit(): void {
    const sessionId = this.mappingState.sessionId;
    if (!sessionId || this.mappingState.sessionAnnounced) return;
    this.mappingState.sessionAnnounced = true;
    this.emitRuntimeEvent({ kind: "session_init", sessionId } satisfies ParsedEvent);
  }

  private launchPrompt(text: string, delivery = false): void {
    const session = this.session;
    if (!session) {
      this.emitRuntimeEvent({
        kind: "error",
        message: "Pi SDK session is not started",
      } satisfies ParsedEvent, "session_start");
      return;
    }
    this.deferSdkCall(
      () => {
        this.toolExecutionObserver?.beginRuntimeTurn();
        return session.prompt(text);
      },
      "prompt_request",
      delivery ? { requestMethod: () => "turn/start", text } : undefined,
    );
  }

  private launchPromptAfterStreaming(text: string): void {
    let requestMethod: "turn/start" | "turn/steer" = "turn/start";
    this.deferSdkCall(
      async () => {
        const session = this.session;
        if (!session) return;
        const ready = await this.waitForStreamingToClear(session);
        if (this.didClose || this.session !== session) {
          return;
        }
        if (ready) {
          this.toolExecutionObserver?.beginRuntimeTurn();
          await session.prompt(text);
        } else {
          requestMethod = "turn/steer";
          await session.steer(text);
        }
      },
      "prompt_request",
      { requestMethod: () => requestMethod, text },
    );
  }

  private observeToolExecutionEvent(event: AgentSessionEvent): void {
    const observer = this.toolExecutionObserver;
    if (!observer) return;
    switch (event.type) {
      case "turn_start":
        observer.observeRuntimeTurnStart();
        return;
      case "turn_end":
      case "agent_end":
        observer.observeRuntimeTurnEnd();
        return;
      case "tool_execution_update":
        observer.observeRuntimeUpdate(event.toolCallId);
        return;
      default:
        return;
    }
  }

  private recordLifecycle(event: RuntimeLifecycleDiagnosticEvent): void {
    const sessionId = this.mappingState.sessionId || this.ctx.config.sessionId;
    if (!sessionId) return;
    writePiLifecycleDiagnostic(
      this.ctx,
      sessionId,
      event,
      this.ctx.config.runtime === "builtin" ? "builtin-driver" : "pi-driver",
    );
  }

  private recordProviderRequestActivity(activity: ProviderRequestActivity): void {
    this.recordLifecycle({
      kind: "provider_request",
      requestId: activity.requestId,
      providerId: activity.provider,
      phase: activity.phase,
      ...(activity.httpStatus === undefined ? {} : { httpStatus: activity.httpStatus }),
      ...(activity.phase === "cancelled"
        ? { cancelSource: this.cancellationSource ?? "sdk_internal_or_unknown" }
        : {}),
    });
  }

  private recordCompactionLifecycle(event: AgentSessionEvent): void {
    if (event.type === "compaction_start") {
      this.recordLifecycle({ kind: "compaction", phase: "started" });
      return;
    }
    if (event.type !== "compaction_end") return;
    const projection = projectPiCompactionEnd(event);
    this.recordLifecycle({
      kind: "compaction",
      phase: projection.outcome === "compaction_succeeded"
        ? "succeeded"
        : projection.outcome === "aborted"
          ? "aborted"
          : "failed",
      reason: projection.reason,
      ...(projection.failureReason ? { failureReason: projection.failureReason } : {}),
      willRetry: projection.willRetry,
    });
  }

  private async waitForStreamingToClear(session: AgentSession): Promise<boolean> {
    const deadline = Date.now() + PI_IDLE_PROMPT_MAX_WAIT_MS;
    while (!this.didClose && this.session === session && session.isStreaming) {
      if (Date.now() >= deadline) {
        return false;
      }
      await delay(PI_IDLE_PROMPT_RETRY_MS);
    }
    return !this.didClose && this.session === session && !session.isStreaming;
  }

  private deferSdkCall(
    invoke: () => Promise<unknown>,
    phase: RuntimeTerminalCausePhase,
    delivery?: PiDeliveryRequest,
  ): void {
    const queuedAt = currentTimeMs();
    setImmediate(() => {
      if (this.didClose) return;
      const span = this.ctx.tracer?.startSpan("daemon.pi.prompt", {
        surface: "daemon",
        kind: "internal",
        attrs: {
          agentId: this.ctx.agentId,
          launchId: this.ctx.launchId || undefined,
          runtime: this.ctx.config.runtime,
        },
      });
      const startedAt = currentTimeMs();
      piPromptsInFlight += 1;
      span?.addEvent("daemon.pi.prompt.start", {
        agentId: this.ctx.agentId,
        queued_ms: startedAt - queuedAt,
        prompts_in_flight: piPromptsInFlight,
      });
      const requestState: PiProviderRequestState = {
        phase,
        responseStarted: false,
        failureReported: false,
        span,
      };
      this.activeProviderRequest = requestState;
      let settled = false;
      const settle = (status: "ok" | "error") => {
        if (settled) return;
        settled = true;
        piPromptsInFlight -= 1;
        if (this.activeProviderRequest === requestState) {
          this.activeProviderRequest = null;
        }
        span?.end(requestState.failureReported ? "error" : status, {
          attrs: {
            queued_ms: startedAt - queuedAt,
            duration_ms: currentTimeMs() - startedAt,
            prompts_in_flight_after: piPromptsInFlight,
          },
        });
      };
      requestState.settle = settle;
      try {
        void invoke().then(() => settle("ok")).catch((error) => {
          this.reportProviderRequestFailure(error, requestState);
          settle("error");
          if (this.didClose) return;
          this.emitDeferredSdkCallFailure(error, phase, delivery);
        });
      } catch (error) {
        this.reportProviderRequestFailure(error, requestState);
        settle("error");
        if (this.didClose) return;
        this.emitDeferredSdkCallFailure(error, phase, delivery);
      }
    });
  }

  private emitDeferredSdkCallFailure(
    error: unknown,
    phase: RuntimeTerminalCausePhase,
    delivery?: PiDeliveryRequest,
  ): void {
    const message = piErrorMessage(error);
    if (delivery) {
      this.emitRuntimeEvent({
        kind: "delivery_error",
        message,
        requestMethod: delivery.requestMethod(),
        source: "pi_sdk_response",
        code: "runtime.delivery_error",
        payloadBytes: Buffer.byteLength(delivery.text, "utf8"),
      } satisfies ParsedEvent, phase);
      return;
    }
    this.emitRuntimeEvent({
      kind: "error",
      message,
    } satisfies ParsedEvent, phase);
  }

  private markProviderResponseStarted(): void {
    if (this.activeProviderRequest) {
      this.activeProviderRequest.responseStarted = true;
    }
  }

  private reportProviderRequestFailure(
    error: unknown,
    requestState: PiProviderRequestState | null = this.activeProviderRequest,
  ): void {
    if (!requestState || requestState.failureReported) return;
    requestState.failureReported = true;
    const classified = classifyPiProviderRequestFailure(
      error,
      requestState.responseStarted || readProviderHttpStatus(error) !== null,
    );
    const sessionId = this.mappingState.sessionId || this.ctx.config.sessionId;
    requestState.span?.addEvent("daemon.pi.provider_request.failed", {
      phase: requestState.phase,
      response_started: requestState.responseStarted || classified.http_status !== undefined,
      reason: classified.reason,
      ...(classified.http_status === undefined ? {} : { http_status: classified.http_status }),
      // #424 (@Leiysky): the flag keeps the same expression and changes only its
      // name. `sessionId` here IS the runtime session id — it is assigned to
      // `mappingState.sessionId` and `setRuntimeSessionId()` on the same line
      // (:1792-1795) — so naming the flag `session_id_present` put it in a
      // different family from the value it describes. The raw key is gone: the
      // sink drops it and it has no hash form, so emitting it only bought a
      // dropped-attribute count on every provider failure. Reads the same way
      // as the `launch_id_present` / `launch_id` pair just below.
      runtime_session_id_present: Boolean(sessionId),
      launch_id_present: Boolean(this.ctx.launchId),
      ...(this.ctx.launchId ? { launch_id: this.ctx.launchId } : {}),
    });
    // Close the span after the value-free provider event but before the
    // terminal runtime error is emitted. This makes the provenance row
    // queryable first for both rejected prompts and message_end stream errors.
    requestState.settle?.("error");
  }

  private emitRuntimeEvent(event: ParsedEvent, phase: RuntimeTerminalCausePhase = "sdk_event"): void {
    if (event.kind === "error") {
      this.writeTerminalCause(event.message, phase);
    }
    this.events.emit("runtime_event", event);
  }

  private writeTerminalCause(message: string, phase: RuntimeTerminalCausePhase): void {
    try {
      const sessionId = this.mappingState.sessionId || this.ctx.config.sessionId;
      if (!sessionId) return;
      const runtimeConfig = hydrateRuntimeConfig(this.ctx.config);
      const launchPlan = buildLaunchPlan(runtimeConfig);
      writeRuntimeTerminalCauseRecord({
        runtime: this.ctx.config.runtime,
        sessionId,
        fallbackDir: this.ctx.workingDirectory,
        agentId: this.ctx.agentId,
        launchId: this.ctx.launchId ?? null,
        processInstanceId: this.ctx.processInstanceId ?? null,
        providerId: launchPlan.trace.provider_id ?? null,
        modelId: launchPlan.trace.model_id ?? launchPlan.model ?? this.ctx.config.model ?? null,
        phase,
        message,
      });
    } catch {
      // Diagnostics must never mask the runtime's terminal error event.
    }
  }

  private async disposeSession(): Promise<void> {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    try {
      unsubscribe?.();
    } catch {
      // Ignore listener cleanup failures.
    }
    const session = this.session;
    this.session = null;
    try {
      session?.dispose();
    } catch (error) {
      this.events.emit("stderr", piErrorMessage(error));
    }
  }

  private emitExitAndClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.didClose) return;
    this.didClose = true;
    const info: RuntimeExitInfo = {
      code,
      signal,
      reason: this.requestedStopReason ? "requested" : "runtime_exit",
    };
    this.exitInfo = info;
    this.events.emit("exit", info);
    this.events.emit("close", info);
  }
}

/**
 * Pi SDK driver.
 *
 * Slock runs Pi through the TypeScript SDK as a native RuntimeSession. The
 * driver keeps the SDK session alive for same-session steering while visible
 * chat/task/attachment communication still goes through the workspace-local
 * `slock` CLI wrapper injected into PATH by prepareCliTransport.
 */
export class PiDriver implements RuntimeDriver {
  readonly id: string = "pi";
  readonly supportsNativeStandingPrompt = true;
  readonly lifecycle = {
    kind: "persistent",
    stdin: "direct",
    inFlightWake: "steer",
  } as const;
  readonly communication = {
    chat: "slock_cli",
    runtimeControl: "none",
  } as const;
  readonly session = {
    recovery: "resume_or_fresh",
  } as const;
  readonly model = {
    detectedModelsVerifiedAs: "launchable" as const,
    toLaunchSpec: (modelId: string) => ({ params: { model: modelId } }),
  };
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;

  protected sessionId: string | null = null;

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  probe(): RuntimeProbeResult {
    return {
      available: true,
      version: PI_SDK_VERSION,
    };
  }

  async detectModels(ctx?: RuntimeModelDetectionContext): Promise<RuntimeModelSourceOutcome> {
    return runtimeModelSourceOutcomeFromSet(await detectPiModels(undefined, ctx));
  }

  createSession(ctx: SpawnContext): RuntimeSession {
    this.sessionId = ctx.config.sessionId || null;
    return new PiSdkRuntimeSession(ctx, (sessionId) => {
      this.sessionId = sessionId;
    });
  }

  async spawn(_ctx: SpawnContext): Promise<SpawnResult> {
    throw new Error("PiDriver uses a native RuntimeSession; child-process spawn is unsupported");
  }

  parseLine(_line: string): ParsedEvent[] {
    return [];
  }

  encodeStdinMessage(
    _text: string,
    _sessionId: string | null,
    _opts?: { mode?: "idle" | "busy" },
  ): string | null {
    return null;
  }

  buildSystemPrompt(config: AgentConfig, _agentId: string): AxSurfaceText {
    const windowsPowerShell = process.platform === "win32";
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: windowsPowerShell
        ? ["- Pi's `bash` tool is a compatibility name on Windows: it executes native Windows PowerShell 5.1. Use PowerShell syntax and never Bash heredocs or Unix-only commands."]
        : [],
      commandShell: windowsPowerShell ? "powershell" : "posix",
    });
  }

}

/**
 * Built-in / Quick Start runtime driver.
 *
 * Product/design contract:
 * - Built-in is a Slock Quick Start path, not user-visible Pi.
 * - It reuses the Pi SDK implementation internally but stores sessions and Pi
 *   agent state under `.builtin-*` directories in the agent workspace.
 * - RuntimeConfig is the only launch source: provider/model/key/baseUrl and
 *   reasoning effort are materialized by `buildLaunchPlan()`.
 * - Host Pi settings/auth and ambient provider env vars remain isolated.
 *   Host extensions (including installed packages) load only with the per-agent
 *   loadLocalPlugins opt-in. Session creation removes generated
 *   Pi provider API-key env names plus a small local set of non-API ambient
 *   credential envs before services/model registry initialization.
 * - Trace evidence is closed/non-secret (`provider_id`, `model_kind`,
 *   `model_id`, key presence/source, baseUrl presence/host class) and never
 *   records API key values, raw base URLs, local paths, or host env names.
 */
export class BuiltInDriver extends PiDriver {
  readonly id = "builtin";
  readonly model = {
    detectedModelsVerifiedAs: "launchable" as const,
    toLaunchSpec: (modelId: string) => ({ params: { model: modelId } }),
  };

  probe(): RuntimeProbeResult {
    return {
      available: true,
      version: PI_SDK_VERSION,
    };
  }

  async detectModels(_ctx?: RuntimeModelDetectionContext): Promise<RuntimeModelSourceOutcome> {
    return {
      kind: "live",
      value: {
        models: RUNTIME_MODELS.builtin,
        catalog: {
          protocolVersion: 1,
          runtime: "builtin",
          runtimeVersion: PI_SDK_VERSION,
        },
      },
    };
  }

  createSession(ctx: SpawnContext): RuntimeSession {
    this.sessionId = ctx.config.sessionId || null;
    return new PiSdkRuntimeSession(ctx, (sessionId) => {
      this.sessionId = sessionId;
    }, (sessionCtx, sessionId, _observer, providerObserver) => createPiAgentSessionForContext(sessionCtx, sessionId, {
      agentDir: buildBuiltInAgentDir(sessionCtx.workingDirectory),
      sessionDir: buildBuiltInSessionDir(sessionCtx.workingDirectory),
      traceName: "daemon.builtin.session.create",
      traceEventPrefix: "daemon.builtin.session",
      logPrefix: "builtin-driver",
      agentDirSource: "managed_builtin",
      exposeLaunchTraceEvidence: true,
      exposeLaunchEnvToTools: false,
      isolateHostProviderEnv: true,
    }, undefined, providerObserver));
  }

  buildSystemPrompt(config: AgentConfig, _agentId: string): AxSurfaceText {
    const windowsPowerShell = process.platform === "win32";
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: windowsPowerShell
        ? ["- This runtime's `bash` tool is a compatibility name on Windows: it executes native Windows PowerShell 5.1. Use PowerShell syntax and never Bash heredocs or Unix-only commands."]
        : [],
      commandShell: windowsPowerShell ? "powershell" : "posix",
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
