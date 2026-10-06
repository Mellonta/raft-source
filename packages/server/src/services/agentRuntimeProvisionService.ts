/**
 * Provisioning of external agents onto a hosted runtime provider
 * (raft-agent-provider.v1) — records, state machine and the worker.
 *
 * State machine (one `agent_runtime_provisions` row per Agent):
 *
 *   provisioning ──POST 2xx──────────────▶ active ──(edit)──▶ PATCH, stays active
 *        │  └─5xx/timeout/network: backoff, same body
 *        └──401/409/422/other 4xx, or no provider config──▶ failed ──retry──▶ provisioning
 *   any ──Raft agent deleted (credentials revoked in the same tx)──▶ deleting
 *   deleting ──DELETE by-raft-agent 2xx/404──▶ deleted   (other answers: backoff, tombstone kept)
 *
 * providerAgentId is stored for display and for PATCH; delete and the live
 * status passthrough address the provider by Raft agent id.
 *
 * The raw sk_agent key is minted in the Agent-create transaction and kept
 * encrypted on the row only until the provider accepted it; it is nulled on
 * POST success and on delete. It is never logged or returned by any API.
 *
 * Single executor per Agent: the worker claims a row with a conditional UPDATE
 * on an expired lease (lease_owner / lease_generation / lease_expires_at), and
 * every result write is guarded by the same owner and generation, so a stale
 * executor can neither run concurrently nor commit a result. Rows are
 * processed one operation at a time, so provider calls for one Agent are
 * ordered; edits are last-write-wins (the PATCH sends the Agent's current
 * name/instructions and marks the revision it read as synced).
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  clearClockInterval,
  currentDate,
  setClockInterval,
  type AgentHostedRuntimeSummary,
  type AgentRuntimeProviderKind,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agentCredentials, agentRuntimeProvisions, agents } from "../db/schema";
import { DEFAULT_EXTERNAL_AGENT_CAPABILITIES, mintAgentCredential } from "./agentCredentialService";
import {
  AgentRuntimeProviderError,
  assertAgentRuntimeProviderSecretKeyConfigured,
  decryptProviderSecret,
  encryptProviderSecret,
  getRaftOrigin,
  providerAgentByRaftIdPath,
  providerAgentPath,
  providerRequest,
  resolveProviderConfig,
  type ProviderCallResult,
} from "./agentRuntimeProviderService";
import { isAgentRuntimeProviderEnabledForServer } from "./agentRuntimeProviderFeature";

export const PROVISION_LEASE_MS = 60_000;
export const PROVISION_RETRY_BASE_MS = 5_000;
export const PROVISION_RETRY_MAX_MS = 15 * 60_000;
const PROVIDER_NAME_MAX = 60;
const PROVIDER_INSTRUCTIONS_MAX = 8_000;
const DRAIN_BATCH = 20;

type ProvisionRow = typeof agentRuntimeProvisions.$inferSelect;

const credentialScope = (agentId: string) => `agent-runtime-provision-credential:${agentId}`;

/** The name the provider shows: the Agent's display name, else its handle; the provider caps names at 60. */
export function providerAgentName(agent: { name: string; displayName: string | null }): string {
  const display = agent.displayName?.trim();
  return (display || agent.name).slice(0, PROVIDER_NAME_MAX);
}

/** Raft has no separate system-prompt field; the Agent's description is its instructions. */
export function providerAgentInstructions(agent: { description: string | null }): string {
  return (agent.description ?? "").slice(0, PROVIDER_INSTRUCTIONS_MAX);
}

export function provisionBackoffMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(20, attempt - 1));
  return Math.min(PROVISION_RETRY_MAX_MS, PROVISION_RETRY_BASE_MS * 2 ** exponent);
}

// ---------------------------------------------------------------------------
// Writes made inside the caller's transaction
// ---------------------------------------------------------------------------

/**
 * Request-time checks for `provider` on POST /api/agents, before anything is
 * written: the server's feature flag, then the deployment configuration.
 */
export async function assertProviderProvisioningAvailable(serverId: string, kind: AgentRuntimeProviderKind): Promise<void> {
  if (!await isAgentRuntimeProviderEnabledForServer(serverId, kind)) {
    throw new AgentRuntimeProviderError(`The ${kind} hosted runtime is not enabled for this server`, "agent_runtime_provider_disabled");
  }
  if (!resolveProviderConfig(kind)) {
    throw new AgentRuntimeProviderError(`The ${kind} hosted runtime is not configured on this deployment`, "agent_runtime_provider_not_configured");
  }
  if (!getRaftOrigin()) {
    throw new AgentRuntimeProviderError("SERVER_URL must be configured so the provider can reach this Raft", "agent_runtime_provider_origin_unconfigured");
  }
  assertAgentRuntimeProviderSecretKeyConfigured();
}

/**
 * Called inside the Agent-create transaction: mint the Agent's credential with
 * the default external capabilities (the creator's authority applies; this
 * replaces the device login a human would otherwise do) and record the
 * provisioning intent. Nothing reaches the provider until the create commits.
 */
export async function recordAgentProvisioning(tx: DatabaseExecutor, input: {
  agent: { id: string; serverId: string; name: string; displayName: string | null; description: string | null };
  provider: AgentRuntimeProviderKind;
  createdByUserId: string;
}): Promise<void> {
  const minted = await mintAgentCredential({
    agentId: input.agent.id,
    scopes: DEFAULT_EXTERNAL_AGENT_CAPABILITIES,
    name: `${input.provider} hosted runtime`,
    createdByUserId: input.createdByUserId,
    requireExternalRuntime: true,
  }, { executor: tx });
  const now = currentDate();
  await tx.insert(agentRuntimeProvisions).values({
    agentId: input.agent.id,
    serverId: input.agent.serverId,
    provider: input.provider,
    state: "provisioning",
    credentialId: minted.credentialId,
    encryptedCredential: encryptProviderSecret(minted.apiKey, credentialScope(input.agent.id)),
    provisionedName: providerAgentName(input.agent),
    provisionedInstructions: providerAgentInstructions(input.agent),
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

/** An Agent's name or instructions changed: queue a PATCH (no-op for Agents without a provisioning record). */
export async function noteProvisionedAgentProfileEdit(tx: DatabaseExecutor, agentId: string): Promise<boolean> {
  const now = currentDate();
  const rows = await tx.update(agentRuntimeProvisions).set({
    desiredRevision: sql`${agentRuntimeProvisions.desiredRevision} + 1`,
    // A due PATCH starts a fresh backoff; provisioning/failed rows keep their schedule.
    attemptCount: sql`CASE WHEN ${agentRuntimeProvisions.state} = 'active' THEN 0 ELSE ${agentRuntimeProvisions.attemptCount} END`,
    nextAttemptAt: sql`CASE WHEN ${agentRuntimeProvisions.state} = 'active' THEN ${now.toISOString()}::timestamptz ELSE ${agentRuntimeProvisions.nextAttemptAt} END`,
    updatedAt: now,
  }).where(and(
    eq(agentRuntimeProvisions.agentId, agentId),
    sql`${agentRuntimeProvisions.state} IN ('provisioning', 'active', 'failed')`,
  )).returning({ agentId: agentRuntimeProvisions.agentId });
  return rows.length > 0;
}

/**
 * Called inside the Agent-delete transaction, after the Agent row is
 * soft-deleted: revoke every active credential of the Agent FIRST (in this
 * transaction, so it is committed before the worker can issue the provider
 * DELETE) and turn the record into a deletion tombstone.
 */
export async function beginProvisionedAgentDeletion(tx: DatabaseExecutor, agentId: string, revokedByUserId: string | null): Promise<boolean> {
  const [row] = await tx.select({ state: agentRuntimeProvisions.state })
    .from(agentRuntimeProvisions)
    .where(eq(agentRuntimeProvisions.agentId, agentId))
    .for("update");
  if (!row || row.state === "deleted" || row.state === "deleting") return false;
  const now = currentDate();
  await tx.update(agentCredentials).set({
    revokedAt: now,
    revokedReason: "agent_deleted",
    ...(revokedByUserId ? { revokedByUserId } : {}),
  }).where(and(eq(agentCredentials.agentId, agentId), isNull(agentCredentials.revokedAt)));
  await tx.update(agentRuntimeProvisions).set({
    state: "deleting",
    encryptedCredential: null,
    attemptCount: 0,
    nextAttemptAt: now,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastErrorHttpStatus: null,
    lastErrorAt: null,
    updatedAt: now,
  }).where(eq(agentRuntimeProvisions.agentId, agentId));
  return true;
}

export type RetryProvisionOutcome = "requeued" | "not_found" | "nothing_to_retry";

/** Manual retry: failed → provisioning; a stuck PATCH/DELETE is made due now. */
export async function retryAgentProvisioning(tx: DatabaseExecutor, agentId: string): Promise<RetryProvisionOutcome> {
  const [row] = await tx.select().from(agentRuntimeProvisions)
    .where(eq(agentRuntimeProvisions.agentId, agentId))
    .for("update");
  if (!row) return "not_found";
  const now = currentDate();
  const reset = { attemptCount: 0, nextAttemptAt: now, updatedAt: now };
  if (row.state === "failed") {
    if (!row.encryptedCredential) return "nothing_to_retry";
    await tx.update(agentRuntimeProvisions).set({ ...reset, state: "provisioning" })
      .where(eq(agentRuntimeProvisions.agentId, agentId));
    return "requeued";
  }
  if (row.state === "active" && (row.lastErrorCode || row.desiredRevision > row.syncedRevision)) {
    // Re-send the current profile even if the last PATCH gave up on its revision.
    await tx.update(agentRuntimeProvisions).set({
      ...reset,
      desiredRevision: Math.max(row.desiredRevision, row.syncedRevision + 1),
    }).where(eq(agentRuntimeProvisions.agentId, agentId));
    return "requeued";
  }
  if (row.state === "provisioning" || row.state === "deleting") {
    await tx.update(agentRuntimeProvisions).set(reset).where(eq(agentRuntimeProvisions.agentId, agentId));
    return "requeued";
  }
  return "nothing_to_retry";
}

// ---------------------------------------------------------------------------
// Read surface
// ---------------------------------------------------------------------------

export function toHostedRuntimeSummary(row: ProvisionRow): AgentHostedRuntimeSummary {
  const retrying = row.state === "provisioning" || row.state === "deleting"
    || (row.state === "active" && row.desiredRevision > row.syncedRevision);
  return {
    provider: row.provider,
    state: row.state,
    providerAgentId: row.providerAgentId,
    syncPending: row.desiredRevision > row.syncedRevision && row.state !== "deleted" && row.state !== "deleting",
    push: row.pushRegistered === null ? null : { registered: row.pushRegistered, error: row.pushError },
    lastError: row.lastErrorCode
      ? {
          code: row.lastErrorCode,
          message: row.lastErrorMessage ?? "",
          httpStatus: row.lastErrorHttpStatus,
          at: (row.lastErrorAt ?? row.updatedAt).toISOString(),
        }
      : null,
    attemptCount: row.attemptCount,
    nextAttemptAt: retrying ? row.nextAttemptAt.toISOString() : null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
  };
}

export async function getHostedRuntimeSummaries(agentIds: readonly string[]): Promise<Map<string, AgentHostedRuntimeSummary>> {
  const result = new Map<string, AgentHostedRuntimeSummary>();
  if (agentIds.length === 0) return result;
  const rows = await getDb().select().from(agentRuntimeProvisions)
    .where(inArray(agentRuntimeProvisions.agentId, [...agentIds]));
  for (const row of rows) result.set(row.agentId, toHostedRuntimeSummary(row));
  return result;
}

export async function getHostedRuntimeSummary(agentId: string): Promise<AgentHostedRuntimeSummary | null> {
  return (await getHostedRuntimeSummaries([agentId])).get(agentId) ?? null;
}

/** Optional passthrough of the provider's own view (incl. live push status). */
export async function fetchProviderAgentStatus(agentId: string): Promise<
  | { kind: "ok"; status: unknown }
  | { kind: "unavailable"; reason: string }
> {
  const [row] = await getDb().select().from(agentRuntimeProvisions)
    .where(eq(agentRuntimeProvisions.agentId, agentId)).limit(1);
  if (!row) return { kind: "unavailable", reason: "not_provisioned" };
  const config = resolveProviderConfig(row.provider);
  if (!config) return { kind: "unavailable", reason: "provider_not_configured" };
  const result = await providerRequest(config, "GET", providerAgentByRaftIdPath(row.agentId, row.serverId));
  if (result.kind === "network") return { kind: "unavailable", reason: result.code };
  if (result.status < 200 || result.status >= 300) return { kind: "unavailable", reason: result.error?.code ?? `http_${result.status}` };
  return { kind: "ok", status: result.body };
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

type Operation = "post" | "patch" | "delete";

function operationFor(row: ProvisionRow): Operation | null {
  if (row.state === "provisioning") return "post";
  if (row.state === "deleting") return "delete";
  if (row.state === "active" && row.desiredRevision > row.syncedRevision) return "patch";
  return null;
}

const dueCondition = (now: Date) => and(
  lte(agentRuntimeProvisions.nextAttemptAt, now),
  or(isNull(agentRuntimeProvisions.leaseExpiresAt), lt(agentRuntimeProvisions.leaseExpiresAt, now)),
  or(
    sql`${agentRuntimeProvisions.state} IN ('provisioning', 'deleting')`,
    and(eq(agentRuntimeProvisions.state, "active"), gt(agentRuntimeProvisions.desiredRevision, agentRuntimeProvisions.syncedRevision)),
  ),
);

/** Claim one specific due row. Exactly one executor wins; the loser gets null. */
export async function claimProvision(agentId: string, leaseOwner: string, now: Date, executor: DatabaseExecutor = getDb()): Promise<ProvisionRow | null> {
  const [claimed] = await executor.update(agentRuntimeProvisions).set({
    leaseOwner,
    leaseExpiresAt: new Date(now.getTime() + PROVISION_LEASE_MS),
    leaseGeneration: sql`${agentRuntimeProvisions.leaseGeneration} + 1`,
    attemptCount: sql`${agentRuntimeProvisions.attemptCount} + 1`,
  }).where(and(eq(agentRuntimeProvisions.agentId, agentId), dueCondition(now))).returning();
  return claimed ?? null;
}

type Outcome =
  | { kind: "post_ok"; providerAgentId: string; push: { registered: boolean; error: string | null } }
  | { kind: "patch_ok"; revision: number }
  | { kind: "delete_ok" }
  | { kind: "retry"; code: string; message: string; httpStatus: number | null }
  | { kind: "terminal"; code: string; message: string; httpStatus: number | null };

function classify(result: ProviderCallResult): { retryable: boolean; code: string; message: string; httpStatus: number | null } {
  if (result.kind === "network") {
    return { retryable: true, code: result.code === "timeout" ? "provider_timeout" : "provider_unreachable", message: `Provider request failed (${result.code})`, httpStatus: null };
  }
  const retryable = result.status >= 500 || result.status === 408 || result.status === 425 || result.status === 429;
  return {
    retryable,
    code: result.error?.code ?? `http_${result.status}`,
    message: result.error?.message || `Provider answered HTTP ${result.status}`,
    httpStatus: result.status,
  };
}

function parsePostBody(body: unknown): { providerAgentId: string; push: { registered: boolean; error: string | null } } | null {
  if (typeof body !== "object" || body === null) return null;
  const { providerAgentId, push } = body as { providerAgentId?: unknown; push?: unknown };
  if (typeof providerAgentId !== "string" || !providerAgentId || providerAgentId.length > 200) return null;
  const pushObj = typeof push === "object" && push !== null ? push as { registered?: unknown; error?: unknown } : {};
  return {
    providerAgentId,
    push: {
      registered: pushObj.registered === true,
      error: typeof pushObj.error === "string" ? pushObj.error.slice(0, 500) : null,
    },
  };
}

async function execute(row: ProvisionRow, op: Operation): Promise<Outcome> {
  // Existing rows keep being driven (edits, deletes) even if the server's flag
  // is later turned off; the flag only gates new creates.
  const config = resolveProviderConfig(row.provider);
  if (!config) {
    // POST cannot proceed without a provider; a DELETE tombstone keeps waiting for one.
    return { kind: op === "post" ? "terminal" : "retry", code: "agent_runtime_provider_not_configured", message: "The hosted runtime is not configured on this deployment", httpStatus: null };
  }

  if (op === "delete") {
    // Always by Raft agent id: a POST may have succeeded at the provider even
    // though Raft never saw the answer (no providerAgentId stored).
    const result = await providerRequest(config, "DELETE", providerAgentByRaftIdPath(row.agentId, row.serverId));
    if (result.kind === "response" && ((result.status >= 200 && result.status < 300) || result.status === 404)) return { kind: "delete_ok" };
    const c = classify(result);
    // Delete never gives up: the tombstone stays until 2xx/404.
    return { kind: "retry", code: c.code, message: c.message, httpStatus: c.httpStatus };
  }

  if (op === "post") {
    const raftOrigin = getRaftOrigin();
    if (!raftOrigin) {
      return { kind: "terminal", code: "agent_runtime_provider_origin_unconfigured", message: "SERVER_URL is not configured", httpStatus: null };
    }
    if (!row.encryptedCredential) {
      return { kind: "terminal", code: "credential_unavailable", message: "The agent credential for provisioning is no longer available", httpStatus: null };
    }
    let credential: string;
    try {
      credential = decryptProviderSecret(row.encryptedCredential, credentialScope(row.agentId));
    } catch (error) {
      return { kind: "terminal", code: "credential_unavailable", message: error instanceof Error ? error.message : "Stored credential is unreadable", httpStatus: null };
    }
    // Byte-identical on every retry: frozen fields only.
    const body = {
      raftAgentId: row.agentId,
      raftServerId: row.serverId,
      raftOrigin,
      name: row.provisionedName,
      instructions: row.provisionedInstructions,
      credential,
    };
    const result = await providerRequest(config, "POST", "/provision/agents", { body, idempotencyKey: row.agentId });
    if (result.kind === "response" && result.status >= 200 && result.status < 300) {
      const parsed = parsePostBody(result.body);
      if (parsed) return { kind: "post_ok", ...parsed };
      return { kind: "retry", code: "provider_response_invalid", message: "The provider answered without a providerAgentId", httpStatus: result.status };
    }
    const c = classify(result);
    return { kind: c.retryable ? "retry" : "terminal", code: c.code, message: c.message, httpStatus: c.httpStatus };
  }

  // PATCH: last write wins — send the Agent's current profile.
  const [agent] = await getDb().select({
    name: agents.name,
    displayName: agents.displayName,
    description: agents.description,
  }).from(agents).where(eq(agents.id, row.agentId)).limit(1);
  if (!agent || !row.providerAgentId) {
    return { kind: "patch_ok", revision: row.desiredRevision };
  }
  const result = await providerRequest(config, "PATCH", providerAgentPath(row.providerAgentId, row.serverId), {
    body: { name: providerAgentName(agent), instructions: providerAgentInstructions(agent) },
  });
  if (result.kind === "response" && result.status >= 200 && result.status < 300) return { kind: "patch_ok", revision: row.desiredRevision };
  const c = classify(result);
  return { kind: c.retryable ? "retry" : "terminal", code: c.code, message: c.message, httpStatus: c.httpStatus };
}

/** Commit an outcome iff this executor still holds the lease it claimed with. */
async function finish(claimed: ProvisionRow, op: Operation, outcome: Outcome, now: Date): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [current] = await tx.select().from(agentRuntimeProvisions)
      .where(and(
        eq(agentRuntimeProvisions.agentId, claimed.agentId),
        eq(agentRuntimeProvisions.leaseOwner, claimed.leaseOwner!),
        eq(agentRuntimeProvisions.leaseGeneration, claimed.leaseGeneration),
      ))
      .for("update");
    if (!current) return false;
    const release = { leaseOwner: null, leaseExpiresAt: null, updatedAt: now };
    const clearError = { lastErrorCode: null, lastErrorMessage: null, lastErrorHttpStatus: null, lastErrorAt: null };
    // The row may have moved on while the call was in flight (e.g. the Agent
    // was deleted during a POST). Only the claimed state may be transitioned.
    const stateUnchanged = current.state === claimed.state;
    let patch: Partial<typeof agentRuntimeProvisions.$inferInsert>;
    switch (outcome.kind) {
      case "post_ok":
        patch = {
          ...release,
          ...clearError,
          providerAgentId: outcome.providerAgentId,
          encryptedCredential: null,
          pushRegistered: outcome.push.registered,
          pushError: outcome.push.error,
          attemptCount: 0,
          nextAttemptAt: now,
          ...(stateUnchanged ? { state: "active" as const, activatedAt: now } : {}),
        };
        break;
      case "patch_ok":
        patch = {
          ...release,
          ...clearError,
          syncedRevision: Math.max(current.syncedRevision, outcome.revision),
          attemptCount: 0,
          nextAttemptAt: now,
        };
        break;
      case "delete_ok":
        patch = stateUnchanged
          ? { ...release, ...clearError, state: "deleted", deletedAt: now, encryptedCredential: null, pushRegistered: false, attemptCount: 0 }
          : { ...release, nextAttemptAt: now };
        break;
      case "retry":
        patch = {
          ...release,
          lastErrorCode: outcome.code,
          lastErrorMessage: outcome.message,
          lastErrorHttpStatus: outcome.httpStatus,
          lastErrorAt: now,
          nextAttemptAt: stateUnchanged ? new Date(now.getTime() + provisionBackoffMs(current.attemptCount)) : now,
        };
        break;
      case "terminal": {
        const error = { lastErrorCode: outcome.code, lastErrorMessage: outcome.message, lastErrorHttpStatus: outcome.httpStatus, lastErrorAt: now };
        if (!stateUnchanged) {
          patch = { ...release, nextAttemptAt: now };
        } else if (op === "post") {
          patch = { ...release, ...error, state: "failed" };
        } else {
          // A refused PATCH gives up on this revision (visible error; the next edit or a retry re-sends).
          patch = { ...release, ...error, syncedRevision: Math.max(current.syncedRevision, claimed.desiredRevision), nextAttemptAt: now };
        }
        break;
      }
    }
    await tx.update(agentRuntimeProvisions).set(patch).where(eq(agentRuntimeProvisions.agentId, claimed.agentId));
    return true;
  });
}

export interface ProvisionDrainSummary { claimed: number; succeeded: number; retried: number; failed: number }

/** Process due rows once. Safe to run concurrently on every replica. */
export async function drainAgentRuntimeProvisions(input: { leaseOwner?: string; batchSize?: number; now?: () => Date } = {}): Promise<ProvisionDrainSummary> {
  const leaseOwner = input.leaseOwner ?? defaultLeaseOwner;
  const clock = input.now ?? currentDate;
  const summary: ProvisionDrainSummary = { claimed: 0, succeeded: 0, retried: 0, failed: 0 };
  const candidates = await getDb().select({ agentId: agentRuntimeProvisions.agentId })
    .from(agentRuntimeProvisions)
    .where(dueCondition(clock()))
    .orderBy(agentRuntimeProvisions.nextAttemptAt)
    .limit(input.batchSize ?? DRAIN_BATCH);
  for (const candidate of candidates) {
    const claimed = await claimProvision(candidate.agentId, leaseOwner, clock());
    if (!claimed) continue;
    const op = operationFor(claimed);
    if (!op) {
      await getDb().update(agentRuntimeProvisions).set({ leaseOwner: null, leaseExpiresAt: null })
        .where(and(eq(agentRuntimeProvisions.agentId, claimed.agentId), eq(agentRuntimeProvisions.leaseGeneration, claimed.leaseGeneration)));
      continue;
    }
    summary.claimed += 1;
    let outcome: Outcome;
    try {
      outcome = await execute(claimed, op);
    } catch (error) {
      outcome = { kind: "retry", code: "internal_error", message: error instanceof Error ? error.name : "internal error", httpStatus: null };
    }
    const committed = await finish(claimed, op, outcome, clock());
    if (!committed) continue;
    if (outcome.kind === "retry") summary.retried += 1;
    else if (outcome.kind === "terminal") summary.failed += 1;
    else summary.succeeded += 1;
    if (outcome.kind === "retry" || outcome.kind === "terminal") {
      console.warn(`[AgentRuntimeProvision] agent=${claimed.agentId} op=${op} outcome=${outcome.kind} code=${outcome.code} status=${outcome.httpStatus ?? "-"}`);
    }
  }
  return summary;
}

const defaultLeaseOwner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
let running: { kick: () => void } | null = null;

/** Nudge this replica's worker after a create/edit/delete/retry commits (others poll). */
export function kickAgentRuntimeProvisionWorker(): void {
  running?.kick();
}

export function startAgentRuntimeProvisionWorker(input: { intervalMs?: number } = {}) {
  let draining = false;
  let again = false;
  const run = () => {
    if (draining) { again = true; return; }
    draining = true;
    void drainAgentRuntimeProvisions()
      .catch((error: unknown) => {
        console.error("[AgentRuntimeProvision] drain failed", error instanceof Error ? error.name : "unknown");
      })
      .finally(() => {
        draining = false;
        if (again) { again = false; setImmediate(run); }
      });
  };
  running = { kick: () => setImmediate(run) };
  run();
  const handle = setClockInterval(run, input.intervalMs ?? 5_000);
  if (typeof handle === "object" && handle && "unref" in handle && typeof handle.unref === "function") handle.unref();
  return {
    stop() {
      running = null;
      clearClockInterval(handle);
    },
  };
}
