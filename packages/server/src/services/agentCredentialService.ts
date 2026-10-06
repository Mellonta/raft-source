// Agent credential service — manages `sk_agent_*` runtime principals per
// `rfcs/034-slock-credential-rfc.zh.html#section-credential-model`.
//
// One row in `agent_credentials` per credential, bound to exactly one
// `agentId` for life. NEVER reassigned to a different agent — a fresh
// credential is issued instead. Rows are NEVER deleted; revoked rows stay
// for audit.
//
// Hot-path auth lookup: prefix-indexed (O(1) by `idx_agent_credentials_prefix_active`,
// the partial index that excludes revoked rows). Argon2id verify follows.
//
// This module owns:
//   - findAgentCredentialByApiKey(apiKey)   — middleware-side lookup
//   - recordAgentCredentialUse({...})       — best-effort observability triple
//   - mintAgentCredential(...) / revokeAgentCredential(...) live in step 3
//     when the mint endpoints land.
//
// Key isolation invariant (base RFC §1.4 runner key isolation): this module
// returns the raw key exactly once at mint time; subsequent reads return the
// row WITHOUT the raw key.

import { randomBytes, createHmac } from "node:crypto";
import argon2 from "argon2";
import { eq, and, isNull, desc, inArray, max } from "drizzle-orm";
import { isExternalAgentRuntime, makeIsMember } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agentCredentials, agentBootstrapTokens, agents, servers } from "../db/schema";
import { addTraceEvent } from "../tracing/semanticTrace";

const API_KEY_PREFIX_LENGTH = 16;
const RAW_KEY_BYTES = 32;
const BOOTSTRAP_TOKEN_BYTES = 24;       // 24 random bytes → 32-char base64url body
const BOOTSTRAP_TOKEN_PREFIX_LENGTH = 12;
const DEFAULT_BOOTSTRAP_TTL_MS = 30 * 60 * 1000;  // 30 minutes (§7 default)

// Allowed scope values for `sk_agent_*` credentials (v0 active enum).
// Route allowlist in `routeAuthPolicy` is the actual enforcement; this
// list bounds what the mint endpoints will accept onto a credential row.
export const ALLOWED_AGENT_CAPABILITIES = [
  "send",
  "read",
  "mentions",
  "tasks",
  "reactions",
  "server",
  "channels",
  "knowledge",
  "mcp",
] as const;
export type AgentCapability = (typeof ALLOWED_AGENT_CAPABILITIES)[number];
const isAgentCapability = makeIsMember(ALLOWED_AGENT_CAPABILITIES);

/**
 * Least-privilege default for an external agent's `sk_agent_*` when the
 * minter does not name scopes: everything a normal member agent needs to
 * message, read, react, work its inbox / mentions / tasks, use channels and
 * threads, attach files, read knowledge and edit its own profile/avatar
 * (`send`). Excluded (must be requested explicitly by an authorized minter):
 *   - `server` — acting on the server: PATCH /server, POST /server/avatar,
 *     labs, and migrations (moving a managed agent between computers);
 *   - `mcp`    — calling managed MCP tools with server-held provider
 *     credentials.
 * A managed agent's runner credential (daemon `RUNNER_CREDENTIAL_SCOPES`)
 * carries this set plus `server` and `mcp`.
 */
export const DEFAULT_EXTERNAL_AGENT_CAPABILITIES: readonly AgentCapability[] = [
  "channels",
  "knowledge",
  "mentions",
  "reactions",
  "read",
  "send",
  "tasks",
];

export type RequestedAgentCapabilities =
  | { ok: true; scopes: AgentCapability[] }
  | { ok: false; code: "scopes_invalid" | "scopes_empty"; error: string };

/**
 * Parse the optional `scopes` field of a mint/issue request body. Omitted →
 * `defaults`; otherwise a non-empty subset of `ALLOWED_AGENT_CAPABILITIES`.
 */
export function resolveRequestedAgentCapabilities(
  raw: unknown,
  defaults: readonly AgentCapability[],
): RequestedAgentCapabilities {
  if (raw === undefined) return { ok: true, scopes: [...defaults] };
  if (!Array.isArray(raw)) {
    return { ok: false, code: "scopes_invalid", error: "scopes must be an array of capability literals" };
  }
  let scopes: AgentCapability[];
  try {
    scopes = normalizeAgentCapabilities(raw as readonly string[]);
  } catch {
    return {
      ok: false,
      code: "scopes_invalid",
      error: `scopes must each be one of: ${ALLOWED_AGENT_CAPABILITIES.join(", ")}`,
    };
  }
  if (scopes.length === 0) {
    return { ok: false, code: "scopes_empty", error: "scopes must include at least one capability" };
  }
  return { ok: true, scopes };
}

// Exported so the device-code grant (task #30 PR-A2, deviceAuthService.ts)
// reuses the EXACT same pepper + lookup-hash, not a parallel one — per
// v0.8 contract v3 §5 "device-code lifecycle aligned with the existing
// bootstrap-token model" (no forked auth/pepper path).
export function getBootstrapTokenPepper(): Buffer {
  const raw = process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER || process.env.JWT_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      "AGENT_BOOTSTRAP_TOKEN_PEPPER or JWT_SECRET environment variable is required (>= 32 chars)",
    );
  }
  return Buffer.from(raw, "utf8");
}

export function computeTokenLookupHash(rawToken: string): Buffer {
  return createHmac("sha256", getBootstrapTokenPepper()).update(rawToken, "utf8").digest();
}

export function extractApiKeyPrefix(apiKey: string): string {
  return apiKey.slice(0, API_KEY_PREFIX_LENGTH);
}

export function isAgentApiKey(token: string): boolean {
  return token.startsWith("sk_agent_");
}

export interface AgentCredentialLookupResult {
  credentialId: string;
  agentId: string;
  serverId: string;
  scopes: readonly string[];
}

export interface LatestActiveAgentCredentialSummary {
  credentialId: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export async function getLatestActiveAgentCredential(
  agentId: string,
): Promise<LatestActiveAgentCredentialSummary | null> {
  const db = getDb();
  const [row] = await db
    .select({
      credentialId: agentCredentials.id,
      createdAt: agentCredentials.createdAt,
      lastUsedAt: agentCredentials.lastUsedAt,
    })
    .from(agentCredentials)
    .where(and(eq(agentCredentials.agentId, agentId), isNull(agentCredentials.revokedAt)))
    .orderBy(desc(agentCredentials.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Look up an agent credential by raw API key.
 *
 * Hot path: prefix lookup served by `idx_agent_credentials_prefix_active`
 * (partial index `WHERE revoked_at IS NULL`) → argon2id verify against
 * matching rows. Revoked rows are excluded by the index — the middleware
 * never argon2-verifies against a revoked credential.
 *
 * Returns `null` for: unknown key, revoked credential, soft-deleted agent.
 * The agent join ensures the credential's bound agent still exists.
 *
 * No in-memory caching in v0 — keep the current behavior and trace the
 * phase costs first so optimization can target the measured bottleneck.
 */
export async function findAgentCredentialByApiKey(
  apiKey: string,
): Promise<AgentCredentialLookupResult | null> {
  if (!isAgentApiKey(apiKey)) return null;
  const db = getDb();
  const prefix = extractApiKeyPrefix(apiKey);

  // Partial index `idx_agent_credentials_prefix_active` requires the WHERE
  // clause to include `revoked_at IS NULL` for the planner to pick it up.
  const lookupStart = Date.now();
  const candidates = await db
    .select({
      id: agentCredentials.id,
      agentId: agentCredentials.agentId,
      apiKeyHash: agentCredentials.apiKeyHash,
      scopes: agentCredentials.scopes,
    })
    .from(agentCredentials)
    .where(
      and(
        eq(agentCredentials.apiKeyPrefix, prefix),
        isNull(agentCredentials.revokedAt),
      ),
    );
  addTraceEvent("agent_credential_auth.credential_lookup.finished", {
    duration_ms: Date.now() - lookupStart,
    candidate_count: candidates.length,
  });

  const verifyStart = Date.now();
  let verifiedCredential: typeof candidates[number] | null = null;
  for (const cred of candidates) {
    try {
      if (!(await argon2.verify(cred.apiKeyHash, apiKey))) continue;
      verifiedCredential = cred;
      break;
    } catch {
      continue;
    }
  }
  addTraceEvent("agent_credential_auth.argon2_verify.finished", {
    duration_ms: Date.now() - verifyStart,
    candidate_count: candidates.length,
    outcome: verifiedCredential ? "matched" : "not_matched",
  });
  if (!verifiedCredential) return null;

  // Resolve serverId via the bound agent. The credential row itself does
  // not carry serverId — it's derived from `agents.serverId` (FK chain).
  // Filtering on `agents.deletedAt IS NULL` keeps the contract that a
  // soft-deleted agent's credential is unusable.
  const agentLookupStart = Date.now();
  const [agentRow] = await db
    .select({ id: agents.id, serverId: agents.serverId })
    .from(agents)
    .where(and(eq(agents.id, verifiedCredential.agentId), isNull(agents.deletedAt)));
  addTraceEvent("agent_credential_auth.agent_lookup.finished", {
    duration_ms: Date.now() - agentLookupStart,
    outcome: agentRow ? "found" : "missing",
  });
  if (!agentRow) return null;

  const result = {
    credentialId: verifiedCredential.id,
    agentId: verifiedCredential.agentId,
    serverId: agentRow.serverId,
    scopes: verifiedCredential.scopes,
  } satisfies AgentCredentialLookupResult;
  return result;
}

/**
 * Minimum interval between two `last_used_at` writes for the same credential
 * in this process. `last_used_at` doubles as the external-agent presence
 * signal ("seen in the last 120 s" → online), so 30 s keeps it well inside
 * that window while collapsing a chatty agent's per-request writes into at
 * most one write per credential per 30 s. The map is per process: with N
 * replicas a credential is written at most N times per window, which is fine.
 */
export const AGENT_CREDENTIAL_USE_WRITE_THROTTLE_MS = 30_000;
const MAX_TRACKED_CREDENTIAL_WRITES = 10_000;
const lastCredentialUseWriteMs = new Map<string, number>();
let credentialUseWriteThrottleMs = AGENT_CREDENTIAL_USE_WRITE_THROTTLE_MS;

function claimCredentialUseWrite(credentialId: string, nowMs: number): boolean {
  const last = lastCredentialUseWriteMs.get(credentialId);
  if (last !== undefined && nowMs - last < credentialUseWriteThrottleMs) return false;
  if (last === undefined && lastCredentialUseWriteMs.size >= MAX_TRACKED_CREDENTIAL_WRITES) {
    // Bound memory: drop entries whose window already expired (they would
    // write on their next request anyway).
    for (const [id, at] of lastCredentialUseWriteMs) {
      if (nowMs - at >= credentialUseWriteThrottleMs) lastCredentialUseWriteMs.delete(id);
    }
  }
  lastCredentialUseWriteMs.set(credentialId, nowMs);
  return true;
}

/**
 * Test seam: override the throttle window (`null` restores the default) and
 * forget per-credential throttle state.
 */
export function __setAgentCredentialUseThrottleMsForTests(ms: number | null): void {
  credentialUseWriteThrottleMs = ms ?? AGENT_CREDENTIAL_USE_WRITE_THROTTLE_MS;
  lastCredentialUseWriteMs.clear();
}

/**
 * Record observability triple (last_used_at, last_used_ip, last_used_user_agent)
 * for a successful credential auth. Best-effort: failure does not affect the
 * request path. Always called via `void recordAgentCredentialUse(...)` after
 * `next()` resolves on the middleware.
 *
 * Throttled per credential (see `AGENT_CREDENTIAL_USE_WRITE_THROTTLE_MS`):
 * resolves `null` when the write was skipped (or failed), otherwise the
 * `last_used_at` value that was written.
 */
export async function recordAgentCredentialUse(input: {
  credentialId: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<Date | null> {
  const now = new Date();
  if (!claimCredentialUseWrite(input.credentialId, now.getTime())) {
    addTraceEvent("agent_credential_auth.last_used.finished", {
      duration_ms: 0,
      outcome: "throttled",
    });
    return null;
  }
  const writeStart = Date.now();
  try {
    const db = getDb();
    // A revoked credential is never "seen": an already-open stream or an
    // in-flight request must not refresh its presence after revocation.
    const updated = await db
      .update(agentCredentials)
      .set({
        lastUsedAt: now,
        lastUsedIp: input.ip,
        lastUsedUserAgent: input.userAgent,
      })
      .where(and(eq(agentCredentials.id, input.credentialId), isNull(agentCredentials.revokedAt)))
      .returning({ id: agentCredentials.id });
    const outcome = updated.length > 0 ? "updated" : "revoked";
    addTraceEvent("agent_credential_auth.last_used.finished", {
      duration_ms: Date.now() - writeStart,
      outcome,
    });
    return outcome === "updated" ? now : null;
  } catch {
    // Let the next request retry instead of waiting out the window.
    lastCredentialUseWriteMs.delete(input.credentialId);
    addTraceEvent("agent_credential_auth.last_used.finished", {
      duration_ms: Date.now() - writeStart,
      outcome: "error",
    });
    // Swallow — observability writes must not impact auth latency / success.
    return null;
  }
}

/**
 * Re-validation for long-lived connections that authenticated once at open
 * (the wake-hint stream): the credential is still unrevoked and its agent and
 * server still exist. Same conditions as `findAgentCredentialByApiKey` plus
 * the middleware's server-liveness check, keyed by credential id.
 */
export async function isAgentCredentialActive(credentialId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: agentCredentials.id })
    .from(agentCredentials)
    .innerJoin(agents, and(eq(agents.id, agentCredentials.agentId), isNull(agents.deletedAt)))
    .innerJoin(servers, and(eq(servers.id, agents.serverId), isNull(servers.deletedAt)))
    .where(and(eq(agentCredentials.id, credentialId), isNull(agentCredentials.revokedAt)))
    .limit(1);
  return Boolean(row);
}

/**
 * Presence read for `GET /agents`: max(last_used_at) over each agent's
 * non-revoked credentials, one query for the whole page.
 */
export async function getAgentsLastSeenAt(agentIds: readonly string[]): Promise<Map<string, Date>> {
  const result = new Map<string, Date>();
  if (agentIds.length === 0) return result;
  const db = getDb();
  const rows = await db
    .select({
      agentId: agentCredentials.agentId,
      lastSeenAt: max(agentCredentials.lastUsedAt),
    })
    .from(agentCredentials)
    .where(and(inArray(agentCredentials.agentId, [...agentIds]), isNull(agentCredentials.revokedAt)))
    .groupBy(agentCredentials.agentId);
  for (const row of rows) {
    if (!row.lastSeenAt) continue;
    const at = row.lastSeenAt instanceof Date ? row.lastSeenAt : new Date(row.lastSeenAt);
    if (!Number.isNaN(at.getTime())) result.set(row.agentId, at);
  }
  return result;
}

/**
 * Helper for the step-3 mint endpoints. Generates a raw `sk_agent_*` key
 * + its argon2id hash + the prefix used for indexed lookup. Returns the
 * raw key ONLY to the caller; never persists it in raw form.
 */
export async function generateAgentApiKeyMaterial(): Promise<{
  apiKey: string;
  apiKeyHash: string;
  apiKeyPrefix: string;
}> {
  const apiKey = `sk_agent_${randomBytes(RAW_KEY_BYTES).toString("hex")}`;
  const apiKeyHash = await argon2.hash(apiKey);
  return {
    apiKey,
    apiKeyHash,
    apiKeyPrefix: extractApiKeyPrefix(apiKey),
  };
}

// ============================================================================
// Mint primitives — write paths. Used by:
//   - POST /api/agent/login                       (bootstrap exchange, gated)
//   - POST /api/agents/:id/bootstrap-tokens       (web session mint, gated)
//   - POST /internal/computer/runners/:agentId/credentials  (sk_computer mint)
// ============================================================================

export const AGENT_BOOTSTRAP_SURFACE_ENABLED_ENV = "SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED";

export function isAgentBootstrapSurfaceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[AGENT_BOOTSTRAP_SURFACE_ENABLED_ENV] ?? "").trim().toLowerCase() === "true";
}

/**
 * Validate a scopes array submitted by a caller. Returns the canonical list
 * (deduplicated, sorted) or throws if any value is outside the v0 enum.
 */
export function normalizeAgentCapabilities(input: readonly string[]): AgentCapability[] {
  const seen = new Set<AgentCapability>();
  for (const raw of input) {
    if (!isAgentCapability(raw)) {
      throw new Error(`unsupported agent capability: ${raw}`);
    }
    seen.add(raw);
  }
  return Array.from(seen).sort();
}

export interface MintAgentCredentialInput {
  agentId: string;
  scopes: readonly AgentCapability[];
  name?: string | null;
  // User id is set on the audit column when the mint is initiated by a
  // human-authenticated path (web session or bootstrap-exchange tracing the
  // human who issued the token). For sk_computer_*-initiated mints there is
  // no user id; pass null and the audit lineage lives on the Computer
  // attachment record instead.
  createdByUserId: string | null;
  /**
   * Refuse (`agent_not_external`) unless the agent's runtime is external.
   * Set by every human-facing mint path (web session, bootstrap exchange):
   * a managed agent's credentials come only from its Computer
   * (`/internal/computer/runners/:agentId/credentials`), because a key for a
   * managed agent could drain and ack the daemon's delivery buffer.
   */
  requireExternalRuntime?: boolean;
  /**
   * Rotation: revoke this credential of the same agent in the same write
   * (the login flow passes the credential its local profile held). Throws
   * `replaces_credential_invalid` when it does not belong to the agent.
   * Callers that need atomicity pass a transaction executor.
   */
  replacesCredentialId?: string | null;
}

/**
 * Mint a fresh `sk_agent_*` credential bound to `agentId`. Returns the raw
 * API key exactly once — callers MUST return it to the user in the same
 * response and then forget it. The argon2 hash is what persists.
 *
 * One row per credential. Other credentials for the same agent are NOT
 * revoked (each device/profile holds its own); only `replacesCredentialId`,
 * when given, is revoked in the same write.
 */
export async function mintAgentCredential(
  input: MintAgentCredentialInput,
  options: { executor?: DatabaseExecutor } = {},
): Promise<{
  credentialId: string;
  apiKey: string;
  scopes: AgentCapability[];
  agentId: string;
  serverId: string;
  agentName: string;
  replacedCredentialId: string | null;
}> {
  const db = options.executor ?? getDb();

  // Resolve agent + soft-delete check + server liveness in one go.
  const [agentRow] = await db
    .select({
      id: agents.id,
      name: agents.name,
      serverId: agents.serverId,
      runtime: agents.runtime,
    })
    .from(agents)
    .innerJoin(servers, and(eq(servers.id, agents.serverId), isNull(servers.deletedAt)))
    .where(and(eq(agents.id, input.agentId), isNull(agents.deletedAt)));
  if (!agentRow) {
    throw new Error("agent_missing");
  }
  if (input.requireExternalRuntime && !isExternalAgentRuntime(agentRow.runtime)) {
    throw new Error("agent_not_external");
  }

  const scopes = normalizeAgentCapabilities(input.scopes);

  let replacedCredentialId: string | null = null;
  if (input.replacesCredentialId) {
    const [replaced] = await db
      .select({ id: agentCredentials.id, revokedAt: agentCredentials.revokedAt })
      .from(agentCredentials)
      .where(and(eq(agentCredentials.id, input.replacesCredentialId), eq(agentCredentials.agentId, input.agentId)));
    if (!replaced) throw new Error("replaces_credential_invalid");
    if (!replaced.revokedAt) {
      await db
        .update(agentCredentials)
        .set({
          revokedAt: new Date(),
          revokedReason: "rotated",
          ...(input.createdByUserId ? { revokedByUserId: input.createdByUserId } : {}),
        })
        .where(and(eq(agentCredentials.id, replaced.id), isNull(agentCredentials.revokedAt)));
      replacedCredentialId = replaced.id;
    }
  }

  const material = await generateAgentApiKeyMaterial();

  const [row] = await db
    .insert(agentCredentials)
    .values({
      agentId: input.agentId,
      apiKeyHash: material.apiKeyHash,
      apiKeyPrefix: material.apiKeyPrefix,
      name: input.name ?? null,
      scopes,
      createdByUserId: input.createdByUserId,
    })
    .returning({ id: agentCredentials.id });

  return {
    credentialId: row.id,
    apiKey: material.apiKey,
    scopes,
    agentId: agentRow.id,
    serverId: agentRow.serverId,
    agentName: agentRow.name,
    replacedCredentialId,
  };
}

/** Public management metadata only; never return key material or usage IPs. */
export async function listAgentCredentials(agentId: string) {
  const rows = await getDb().select({
    id: agentCredentials.id,
    apiKeyPrefix: agentCredentials.apiKeyPrefix,
    name: agentCredentials.name,
    scopes: agentCredentials.scopes,
    createdAt: agentCredentials.createdAt,
    lastUsedAt: agentCredentials.lastUsedAt,
    revokedAt: agentCredentials.revokedAt,
  }).from(agentCredentials).where(eq(agentCredentials.agentId, agentId))
    .orderBy(desc(agentCredentials.createdAt), desc(agentCredentials.id));
  // Existing rows retain only a lookup prefix, not a recoverable secret/tail.
  return rows.map(({ apiKeyPrefix, ...metadata }) => ({
    ...metadata,
    maskedToken: `${apiKeyPrefix.slice(0, 14)}***`,
  }));
}

export async function revokeAgentCredential(input: {
  credentialId: string;
  agentId?: string;
  serverId?: string;
  reason: string;
  revokedByUserId?: string;
}, options: { executor?: DatabaseExecutor } = {}): Promise<boolean> {
  const db = options.executor ?? getDb();
  const [row] = await db
    .select({
      id: agentCredentials.id,
      agentId: agentCredentials.agentId,
      revokedAt: agentCredentials.revokedAt,
      serverId: agents.serverId,
    })
    .from(agentCredentials)
    .innerJoin(agents, eq(agents.id, agentCredentials.agentId))
    .where(eq(agentCredentials.id, input.credentialId));
  if (!row) return false;
  if (input.agentId && row.agentId !== input.agentId) return false;
  if (input.serverId && row.serverId !== input.serverId) return false;
  if (row.revokedAt) return true;

  await db
    .update(agentCredentials)
    .set({
      revokedAt: new Date(),
      revokedReason: input.reason,
      ...(input.revokedByUserId ? { revokedByUserId: input.revokedByUserId } : {}),
    })
    .where(eq(agentCredentials.id, input.credentialId));
  return true;
}

// ----------------------------------------------------------------------------
// Bootstrap token mint + exchange (RFC v0.8 invariants).
// ----------------------------------------------------------------------------

export interface IssueAgentBootstrapTokenInput {
  agentId: string;
  serverId: string;
  issuedByUserId: string;
  scopes: readonly AgentCapability[];
  ttlMs?: number;
}

export async function issueAgentBootstrapToken(
  input: IssueAgentBootstrapTokenInput,
  options: { executor?: DatabaseExecutor } = {},
): Promise<{
  tokenId: string;
  rawToken: string;
  tokenPrefix: string;
  ttlExpiresAt: Date;
  scopes: AgentCapability[];
}> {
  const db = options.executor ?? getDb();

  // Resolve agent + check it belongs to the issuer's server (callers MUST
  // pre-verify this; we re-check here for defense-in-depth).
  const [agentRow] = await db
    .select({ id: agents.id, serverId: agents.serverId, runtime: agents.runtime })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), isNull(agents.deletedAt)));
  if (!agentRow) {
    throw new Error("agent_missing");
  }
  if (agentRow.serverId !== input.serverId) {
    throw new Error("agent_server_mismatch");
  }
  // The token exchanges for an `sk_agent_*`; same external-only rule as
  // `mintAgentCredential({ requireExternalRuntime: true })`.
  if (!isExternalAgentRuntime(agentRow.runtime)) {
    throw new Error("agent_not_external");
  }

  const scopes = normalizeAgentCapabilities(input.scopes);

  // Generate the raw token. The "abtk_" prefix is human-recognizable so
  // accidental paste into other contexts is identifiable as an agent
  // bootstrap token.
  const rawToken = `abtk_${randomBytes(BOOTSTRAP_TOKEN_BYTES).toString("base64url")}`;
  const tokenLookupHash = computeTokenLookupHash(rawToken);
  const tokenHash = await argon2.hash(rawToken);
  const tokenPrefix = rawToken.slice(0, BOOTSTRAP_TOKEN_PREFIX_LENGTH);
  const ttlMs = input.ttlMs ?? DEFAULT_BOOTSTRAP_TTL_MS;
  const ttlExpiresAt = new Date(Date.now() + ttlMs);

  const [row] = await db
    .insert(agentBootstrapTokens)
    .values({
      tokenLookupHash,
      tokenHash,
      tokenPrefix,
      targetAgentId: input.agentId,
      serverId: input.serverId,
      issuedByUserId: input.issuedByUserId,
      scopes,
      ttlExpiresAt,
    })
    .returning({ id: agentBootstrapTokens.id });

  return {
    tokenId: row.id,
    rawToken,
    tokenPrefix,
    ttlExpiresAt,
    scopes,
  };
}

export type ConsumeAgentBootstrapTokenError =
  | "token_invalid"
  | "token_consumed"
  | "token_revoked"
  | "token_expired"
  | "agent_missing"
  | "agent_not_external"
  | "server_missing";

export type ConsumeAgentBootstrapTokenResult =
  | {
      ok: true;
      apiKey: string;
      credentialId: string;
      agentId: string;
      agentName: string;
      serverId: string;
      scopes: AgentCapability[];
    }
  | { ok: false; error: ConsumeAgentBootstrapTokenError };

/**
 * Single-use exchange of a raw bootstrap token for a fresh `sk_agent_*`
 * credential. Concurrent racers contract (RFC §7): exactly one caller gets
 * 200 + apiKey; all others get 410 token_consumed. Implementation:
 *
 *   1. SELECT by HMAC lookup hash (filters revoked / consumed / expired)
 *   2. argon2id verify the raw token against token_hash
 *   3. mint the credential
 *   4. CAS-style UPDATE setting consumed_at + consumed_credential_id
 *      WHERE id = ? AND consumed_at IS NULL — if 0 rows updated, another
 *      racer won; revoke the just-minted credential and return token_consumed.
 *
 * NOTE: step 4 is the actual race-defense. The partial index in step 1 is a
 * fast-path filter, not a serialization point.
 */
export async function consumeAgentBootstrapToken(
  rawToken: string,
  observe: { ip?: string | null; userAgent?: string | null } = {},
): Promise<ConsumeAgentBootstrapTokenResult> {
  if (!rawToken || typeof rawToken !== "string") {
    return { ok: false, error: "token_invalid" };
  }
  const db = getDb();
  const tokenLookupHash = computeTokenLookupHash(rawToken);

  // Step 1 — locate the row. Don't filter on consumed/revoked/expired here:
  // we want distinct error codes so the CLI can render the right message.
  const [row] = await db
    .select({
      id: agentBootstrapTokens.id,
      tokenHash: agentBootstrapTokens.tokenHash,
      targetAgentId: agentBootstrapTokens.targetAgentId,
      serverId: agentBootstrapTokens.serverId,
      scopes: agentBootstrapTokens.scopes,
      ttlExpiresAt: agentBootstrapTokens.ttlExpiresAt,
      consumedAt: agentBootstrapTokens.consumedAt,
      revokedAt: agentBootstrapTokens.revokedAt,
    })
    .from(agentBootstrapTokens)
    .where(eq(agentBootstrapTokens.tokenLookupHash, tokenLookupHash));
  if (!row) {
    return { ok: false, error: "token_invalid" };
  }

  // Constant-time verify against argon2 hash. A row with a matching lookup
  // hash but failing argon2 verify means a (near-impossible) HMAC collision
  // — treat as token_invalid, not 500.
  let argonOk = false;
  try {
    argonOk = await argon2.verify(row.tokenHash, rawToken);
  } catch {
    argonOk = false;
  }
  if (!argonOk) {
    return { ok: false, error: "token_invalid" };
  }

  if (row.revokedAt) return { ok: false, error: "token_revoked" };
  if (row.consumedAt) return { ok: false, error: "token_consumed" };
  if (row.ttlExpiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "token_expired" };
  }

  // Step 2 — mint a fresh credential carrying the token's scopes. If the
  // bound agent has been soft-deleted between issue and exchange,
  // mintAgentCredential throws agent_missing and we map back to the public
  // error code.
  let minted: Awaited<ReturnType<typeof mintAgentCredential>>;
  try {
    minted = await mintAgentCredential({
      agentId: row.targetAgentId,
      scopes: row.scopes as AgentCapability[],
      createdByUserId: null, // bootstrap exchange: issuer is on the token row
      name: null,
      requireExternalRuntime: true,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "agent_missing") {
      return { ok: false, error: "agent_missing" };
    }
    if (err instanceof Error && err.message === "agent_not_external") {
      return { ok: false, error: "agent_not_external" };
    }
    throw err;
  }

  // Step 3 — CAS-style claim. If another racer beat us, this returns 0
  // rows; revoke the just-minted credential (otherwise we'd leak it) and
  // surface token_consumed to the caller.
  const claimResult = await db
    .update(agentBootstrapTokens)
    .set({
      consumedAt: new Date(),
      consumedCredentialId: minted.credentialId,
      consumedIp: observe.ip ?? null,
      consumedUserAgent: observe.userAgent ?? null,
    })
    .where(
      and(
        eq(agentBootstrapTokens.id, row.id),
        isNull(agentBootstrapTokens.consumedAt),
      ),
    )
    .returning({ id: agentBootstrapTokens.id });

  if (claimResult.length === 0) {
    // Race lost. Revoke the just-minted credential so it can't be used.
    await db
      .update(agentCredentials)
      .set({
        revokedAt: new Date(),
        revokedReason: "bootstrap_exchange_race_lost",
      })
      .where(eq(agentCredentials.id, minted.credentialId));
    return { ok: false, error: "token_consumed" };
  }

  return {
    ok: true,
    apiKey: minted.apiKey,
    credentialId: minted.credentialId,
    agentId: minted.agentId,
    agentName: minted.agentName,
    serverId: minted.serverId,
    scopes: minted.scopes,
  };
}
