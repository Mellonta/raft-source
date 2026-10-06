/**
 * Hosted runtime providers for external agents — deployment-level configuration
 * and the raft-agent-provider.v1 HTTP client.
 *
 * Configuration is one per deployment: the base URL is fixed by DEPLOYMENT_ENV
 * (staging → preview.antiproton.ai, production → antiproton.ai) and the only
 * setting is the optional secret `ANTIPROTON_PROVISIONING_TOKEN`. The token is bound
 * by antiproton to this deployment's Raft origin (`raftOrigin`, see
 * getRaftOrigin) and the provider derives the tenant from `raftServerId`, so
 * every call carries the Raft server explicitly (POST in its body, every other
 * call as `?raftServerId=`). Availability per server is additionally gated by
 * the `antiproton_hosted_runtime` feature flag (agentRuntimeProviderFeature.ts).
 * The raw agent credential waiting to be provisioned is AES-256-GCM encrypted
 * with SLOCK_PROVIDER_CREDENTIAL_KEY; no secret is ever returned or logged.
 *
 * Contract (botiverse/antiproton#571 + by-raft-agent follow-up):
 *   POST   {base}/provision/agents                     Idempotency-Key: <raftAgentId>
 *   PATCH  {base}/provision/agents/:providerAgentId?raftServerId=  {name?, instructions?}
 *   GET|DELETE {base}/provision/agents/by-raft-agent/:raftAgentId?raftServerId=
 *          (Raft's delete and status path; DELETE idempotent, 404 if never created)
 *   POST|GET|DELETE {base}/provision/agents/by-raft-agent/:raftAgentId/connections/:provider?raftServerId=
 *   POST   {base}/provision/agents/by-raft-agent/:raftAgentId/connections/:provider/confirm?raftServerId=
 *   PUT    {base}/provision/agents/by-raft-agent/:raftAgentId/connections/:provider?raftServerId=
 *   DELETE {base}/provision/connectors/:connectorId?raftServerId=
 *          (account connections / tenant connectors, see agentConnectionService; 404 = not supported)
 * Errors: `{error:{code,message,param?}}`; 401 token, 404 agent, 409 conflict,
 * 422 invalid, 5xx retryable. There is no model field anywhere.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { AgentRuntimeProviderKind } from "@botiverse/raft-shared";
import { withTraceChildSpan } from "../tracing/semanticTrace";
import { currentRaftTraceId, raftTraceIdHeaders, responseRequestId } from "./externalRequestCorrelation";
import { createSafeFetch } from "./managedMcpGateway";

const KEY_ENV = "SLOCK_PROVIDER_CREDENTIAL_KEY";
const SECRET_VERSION = "arp1";
export const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;
const MAX_TOKEN_BYTES = 4 * 1024;
const MAX_ERROR_MESSAGE_CHARS = 500;

export type AgentRuntimeProviderErrorCode =
  | "agent_runtime_provider_invalid"
  | "agent_runtime_provider_not_configured"
  | "agent_runtime_provider_disabled"
  | "agent_runtime_provider_key_missing"
  | "agent_runtime_provider_origin_unconfigured";

export class AgentRuntimeProviderError extends Error {
  constructor(message: string, readonly code: AgentRuntimeProviderErrorCode) {
    super(message);
    this.name = "AgentRuntimeProviderError";
  }
}

// ---------------------------------------------------------------------------
// Transport (overridable in tests; production uses the SSRF-safe fetch)
// ---------------------------------------------------------------------------

type ProviderTransport = { fetch: typeof globalThis.fetch; baseUrl?: string };
let testTransport: ProviderTransport | null = null;
let safeFetch: { fetch: typeof globalThis.fetch; close: () => Promise<void> } | null = null;

/** Tests point the client at a local fake provider (plain http on loopback) and may inject its base URL. */
export function __setAgentRuntimeProviderTransportForTests(transport: ProviderTransport | null): void {
  testTransport = transport;
}

function transportFetch(): typeof globalThis.fetch {
  if (testTransport) return testTransport.fetch;
  safeFetch ??= createSafeFetch();
  return safeFetch.fetch;
}

// ---------------------------------------------------------------------------
// Secrets at rest
// ---------------------------------------------------------------------------

function secretKey(): Buffer {
  const raw = process.env[KEY_ENV]?.trim();
  if (!raw) {
    throw new AgentRuntimeProviderError(`${KEY_ENV} must be configured before storing provider secrets`, "agent_runtime_provider_key_missing");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new AgentRuntimeProviderError(`${KEY_ENV} must be a base64-encoded 32-byte key`, "agent_runtime_provider_key_missing");
  }
  return key;
}

/** Fail fast (before any write) when secrets could not be stored. */
export function assertAgentRuntimeProviderSecretKeyConfigured(): void {
  secretKey();
}

/** AES-256-GCM with the scope as AAD, so a ciphertext cannot be replayed onto another row. */
export function encryptProviderSecret(plaintext: string, scope: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  cipher.setAAD(Buffer.from(scope, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [SECRET_VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
}

export function decryptProviderSecret(payload: string, scope: string): string {
  const [version, iv, tag, encrypted, extra] = payload.split(":");
  if (version !== SECRET_VERSION || !iv || !tag || !encrypted || extra !== undefined) {
    throw new AgentRuntimeProviderError("Stored provider secret is invalid", "agent_runtime_provider_invalid");
  }
  const decipher = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(scope, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new AgentRuntimeProviderError("Stored provider secret cannot be decrypted", "agent_runtime_provider_invalid");
  }
}


// ---------------------------------------------------------------------------
// raftOrigin
// ---------------------------------------------------------------------------

/**
 * The public origin of this Raft API — `SERVER_URL`, the same origin used as
 * the OIDC issuer and handed to daemons/agents as their server URL. External
 * agents (and the provider's push registration) call Raft here, and the
 * provider token must be minted for exactly this origin.
 */
export function getRaftOrigin(raw = process.env.SERVER_URL): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Configuration (deployment-level, from the environment)
// ---------------------------------------------------------------------------

export const ANTIPROTON_PROVISIONING_TOKEN_ENV = "ANTIPROTON_PROVISIONING_TOKEN";

/**
 * The antiproton base URL is fixed per deployment (owner decision), selected by
 * DEPLOYMENT_ENV — the explicit environment name Terraform sets on every AWS
 * deployment. Anything else (local, dev, test, release-qa) has no provider
 * unless a test transport injects one.
 */
export const ANTIPROTON_BASE_URL_BY_DEPLOYMENT_ENV: Readonly<Record<string, string>> = Object.freeze({
  staging: "https://preview.antiproton.ai",
  production: "https://antiproton.ai",
});

function normalizeToken(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const token = raw.trim();
  if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES || /[\s\0]/u.test(token)) return null;
  return token;
}

export interface ResolvedProviderConfig {
  kind: AgentRuntimeProviderKind;
  baseUrl: string;
  token: string;
}

/**
 * One provider configuration per deployment: the base URL fixed by
 * DEPLOYMENT_ENV plus the optional secret `ANTIPROTON_PROVISIONING_TOKEN`
 * (bound by antiproton to this deployment's SERVER_URL origin; antiproton
 * derives the tenant from `raftServerId`). No base URL or no token → null: the
 * feature is unavailable, nothing crashes. Never log or return the token.
 */
export function resolveProviderConfig(
  kind: AgentRuntimeProviderKind,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProviderConfig | null {
  if (kind !== "antiproton") return null;
  const deploymentEnv = env.DEPLOYMENT_ENV?.trim() ?? "";
  const baseUrl = testTransport?.baseUrl
    ?? (Object.hasOwn(ANTIPROTON_BASE_URL_BY_DEPLOYMENT_ENV, deploymentEnv) ? ANTIPROTON_BASE_URL_BY_DEPLOYMENT_ENV[deploymentEnv] : null);
  const token = normalizeToken(env[ANTIPROTON_PROVISIONING_TOKEN_ENV]);
  if (!baseUrl || !token) return null;
  return { kind, baseUrl, token };
}

/** Deployment prerequisites: provider env config, SERVER_URL and the secret key for the pending credential. */
export function isProviderDeploymentConfigured(kind: AgentRuntimeProviderKind): boolean {
  if (!resolveProviderConfig(kind) || !getRaftOrigin()) return false;
  try {
    secretKey();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

export type ProviderErrorBody = { code: string; message: string; param?: string };

export type ProviderCallResult =
  | {
    kind: "response";
    status: number;
    body: unknown;
    error: ProviderErrorBody | null;
    /** The provider's own request id from its response headers, when it sent one. */
    requestId?: string | null;
  }
  | { kind: "network"; code: string };

function boundedText(value: unknown, max = MAX_ERROR_MESSAGE_CHARS): string {
  return (typeof value === "string" ? value : String(value)).slice(0, max);
}

function parseProviderError(body: unknown): ProviderErrorBody | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const { code, message, param } = error as { code?: unknown; message?: unknown; param?: unknown };
  return {
    code: boundedText(typeof code === "string" && code ? code : "provider_error", 100),
    message: boundedText(typeof message === "string" ? message : ""),
    ...(typeof param === "string" ? { param: boundedText(param, 100) } : {}),
  };
}

function networkCode(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "timeout";
    const cause = (error as { cause?: { code?: unknown } }).cause;
    if (cause && typeof cause.code === "string") return boundedText(cause.code, 60);
    return boundedText(error.name, 60);
  }
  return "network_error";
}

type ProviderRequestMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type ProviderRequestOptions = { body?: unknown; idempotencyKey?: string; timeoutMs?: number };

/**
 * One provider call. Never throws for HTTP or network failures — the caller
 * classifies. Request bodies (which may carry the raw credential) are never
 * logged or echoed into errors.
 *
 * Runs in a `server.agent_runtime_provider.request` client span. The active
 * trace id is sent as `X-Raft-Trace-Id` (omitted outside a trace) and the
 * provider's response request id is recorded as `provider.request_id`.
 */
export async function providerRequest(
  target: { baseUrl: string; token: string },
  method: ProviderRequestMethod,
  path: string,
  options: ProviderRequestOptions = {},
): Promise<ProviderCallResult> {
  // Read before the child span opens: outside a trace the child is a no-op
  // span with a fresh id that nothing records, so no header is sent.
  const traceId = currentRaftTraceId();
  return withTraceChildSpan(
    "server.agent_runtime_provider.request",
    { surface: "server", kind: "client", attrs: { http_method: method } },
    () => sendProviderRequest(target, method, path, options, traceId),
    {
      onSuccess: (result) => result.kind === "response"
        ? { outcome: "response", http_status: result.status, "provider.request_id": result.requestId ?? null }
        : { outcome: "network", error_code: result.code },
    },
  );
}

async function sendProviderRequest(
  target: { baseUrl: string; token: string },
  method: ProviderRequestMethod,
  path: string,
  options: ProviderRequestOptions,
  traceId: string | null,
): Promise<ProviderCallResult> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${target.token}`,
    accept: "application/json",
    "user-agent": "Raft-Agent-Provider/1 (raft-agent-provider.v1)",
    ...raftTraceIdHeaders(traceId),
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  try {
    const response = await transportFetch()(`${target.baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? PROVIDER_REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = null; }
    }
    return {
      kind: "response",
      status: response.status,
      body,
      error: response.ok ? null : parseProviderError(body) ?? { code: `http_${response.status}`, message: "" },
      requestId: responseRequestId((name) => response.headers.get(name)),
    };
  } catch (error) {
    return { kind: "network", code: networkCode(error) };
  }
}

const serverQuery = (raftServerId: string) => `?raftServerId=${encodeURIComponent(raftServerId)}`;

export function providerAgentPath(providerAgentId: string, raftServerId: string): string {
  return `/provision/agents/${encodeURIComponent(providerAgentId)}${serverQuery(raftServerId)}`;
}

/** `raftServerId` first, then the given params (undefined ones dropped), each URL-encoded. */
function serverQueryWith(raftServerId: string, params: Record<string, string | undefined>): string {
  let query = serverQuery(raftServerId);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query += `&${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
  return query;
}

/** One level of the hosted agent's workspace (virtual top-level dirs `state/`, `artifacts/`, `sandbox/`). */
export function providerAgentWorkspaceFilesPath(
  providerAgentId: string,
  raftServerId: string,
  params: { dirPath?: string; includeHidden?: boolean },
): string {
  return `/provision/agents/${encodeURIComponent(providerAgentId)}/workspace-files${serverQueryWith(raftServerId, {
    dirPath: params.dirPath,
    includeHidden: params.includeHidden === undefined ? undefined : String(params.includeHidden),
  })}`;
}

export function providerAgentWorkspaceFileReadPath(providerAgentId: string, raftServerId: string, filePath: string): string {
  return `/provision/agents/${encodeURIComponent(providerAgentId)}/workspace-files/read${serverQueryWith(raftServerId, { path: filePath })}`;
}

export function providerAgentUsagePath(
  providerAgentId: string,
  raftServerId: string,
  params: { from: string; to: string; bucket: string },
): string {
  return `/provision/agents/${encodeURIComponent(providerAgentId)}/usage${serverQueryWith(raftServerId, params)}`;
}

/**
 * Addressed by the Raft agent id, so Raft can GET/DELETE an agent even when
 * it never learned the provider's id (e.g. the POST answer was lost).
 * DELETE is idempotent; 404 means never created or already gone.
 */
export function providerAgentByRaftIdPath(raftAgentId: string, raftServerId: string): string {
  return `/provision/agents/by-raft-agent/${encodeURIComponent(raftAgentId)}${serverQuery(raftServerId)}`;
}

/** Account connection (e.g. GitHub) of a provisioned agent; the provider owns the OAuth flow and token. */
export function providerAgentConnectionPath(raftAgentId: string, provider: string, raftServerId: string): string {
  return `/provision/agents/by-raft-agent/${encodeURIComponent(raftAgentId)}/connections/${encodeURIComponent(provider)}${serverQuery(raftServerId)}`;
}

/** A tenant-level connector (shared by the server's agents); DELETE disconnects it for every agent using it. */
export function providerConnectorPath(connectorId: string, raftServerId: string): string {
  return `/provision/connectors/${encodeURIComponent(connectorId)}${serverQuery(raftServerId)}`;
}

export function providerAgentConnectionConfirmPath(raftAgentId: string, provider: string, raftServerId: string): string {
  return `/provision/agents/by-raft-agent/${encodeURIComponent(raftAgentId)}/connections/${encodeURIComponent(provider)}/confirm${serverQuery(raftServerId)}`;
}
