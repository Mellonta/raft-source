// Keyed retry safety for Agent API writes that have no per-request row of
// their own to carry the key (task create, action prepare).
//
// Contract (same as message send's `idempotencyKey`):
// - the key is scoped to (agent, route);
// - a repeated request with the same key and the same request replays the
//   FIRST response (status and body) and writes nothing;
// - the same key with a different request is refused with 409
//   `idempotency_key_reused` (AgentApiIdempotencyConflictError);
// - concurrent identical first requests produce exactly one write: the ledger
//   row is inserted in the same transaction as the write it records, so the
//   loser blocks on the primary key until the winner commits, finds the key
//   taken, and rolls its own write back (AgentApiIdempotencyRaceLostError)
//   before replaying the winner's response.
//
// Message send keeps its key on the message row (messages.agent_send_key,
// agentSendReplayService); this ledger is the route-keyed counterpart for
// writes that create several rows or a non-message fact.
//
// A key is valid for 24 hours (AGENT_API_IDEMPOTENCY_KEY_TTL_MS). An older row
// counts as absent everywhere: the lookup ignores it, and the in-transaction
// insert replaces it (conditional upsert), so reusing an expired key is a new
// request. The hourly maintenance sweep deletes expired rows in bounded
// batches (pruneExpiredAgentApiIdempotencyKeys).

import { createHash } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agentApiIdempotencyKeys } from "../db/schema";
import { normalizeAgentApiWireValue } from "./agentInboxEvents";

export type AgentApiIdempotentRoute = "taskCreate" | "actionPrepare";

/** How long a key binds its request and first response: retry within 24 hours. */
export const AGENT_API_IDEMPOTENCY_KEY_TTL_MS = 24 * 60 * 60 * 1_000;

function expiryCutoff(now: Date): Date {
  return new Date(now.getTime() - AGENT_API_IDEMPOTENCY_KEY_TTL_MS);
}

export interface AgentApiIdempotencyScope {
  agentId: string;
  route: AgentApiIdempotentRoute;
  idempotencyKey: string;
  /** sha256 of the route-normalized request (see fingerprintAgentApiRequest). */
  requestFingerprint: string;
}

export interface AgentApiIdempotentResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * The key is already bound to a different request on this route. Replaying
 * the original would report a write the caller did not ask for, so the
 * request is refused. Same wire shape and code as message send's
 * AgentSendIdempotencyConflictError.
 */
export class AgentApiIdempotencyConflictError extends Error {
  readonly status = 409 as const;
  readonly code = "idempotency_key_reused" as const;
  readonly suggestedNextAction = "use a new idempotencyKey for a different request";
  readonly mismatch = "request" as const;

  constructor(route: AgentApiIdempotentRoute) {
    super(`idempotencyKey was already used for a different ${route === "taskCreate" ? "task create" : "action prepare"} request; use a new idempotencyKey for a different request`);
    this.name = "AgentApiIdempotencyConflictError";
  }
}

/**
 * Thrown inside the write transaction when a concurrent request committed the
 * same key first. Rolls the losing write back; the caller then replays (or
 * refuses) from the committed ledger row.
 */
export class AgentApiIdempotencyRaceLostError extends Error {
  constructor() {
    super("idempotencyKey was committed by a concurrent request");
    this.name = "AgentApiIdempotencyRaceLostError";
  }
}

type RaceHooks = {
  /** After a lookup found the key unused, before the caller writes. */
  afterLookupMiss?: (scope: AgentApiIdempotencyScope) => Promise<void>;
  /** A write lost the key to a concurrent committed request and rolls back. */
  onRaceLost?: (scope: AgentApiIdempotencyScope) => void;
};
let raceHooksForTests: RaceHooks = {};

export function __setAgentApiIdempotencyRaceHooksForTests(hooks: RaceHooks): void {
  raceHooksForTests = hooks;
}

/** A usable key: a non-empty trimmed string. Anything else means "no key" (send's rule). */
export function normalizeAgentApiIdempotencyKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
}

/**
 * Fingerprint of the request a key is bound to: sha256 over the route key and
 * the route's normalized request (key order independent; the idempotencyKey
 * itself is never part of it).
 */
export function fingerprintAgentApiRequest(route: AgentApiIdempotentRoute, request: unknown): string {
  return createHash("sha256").update(stableJson({ route, request })).digest("hex");
}

/**
 * The first response recorded for this key, or null when the key is unused
 * or its row is older than 24 hours.
 * Throws AgentApiIdempotencyConflictError when the key is bound to a
 * different request.
 */
export async function findAgentApiIdempotentResponse(
  scope: AgentApiIdempotencyScope,
  executor: DatabaseExecutor = getDb(),
  now: Date = currentDate(),
): Promise<AgentApiIdempotentResponse | null> {
  const [row] = await executor
    .select({
      requestFingerprint: agentApiIdempotencyKeys.requestFingerprint,
      responseStatus: agentApiIdempotencyKeys.responseStatus,
      responseBody: agentApiIdempotencyKeys.responseBody,
    })
    .from(agentApiIdempotencyKeys)
    .where(and(
      eq(agentApiIdempotencyKeys.agentId, scope.agentId),
      eq(agentApiIdempotencyKeys.route, scope.route),
      eq(agentApiIdempotencyKeys.idempotencyKey, scope.idempotencyKey),
      gt(agentApiIdempotencyKeys.createdAt, expiryCutoff(now)),
    ))
    .limit(1);
  if (!row) {
    await raceHooksForTests.afterLookupMiss?.(scope);
    return null;
  }
  if (row.requestFingerprint !== scope.requestFingerprint) {
    throw new AgentApiIdempotencyConflictError(scope.route);
  }
  return { status: row.responseStatus, body: row.responseBody };
}

/**
 * Bind the key to this request and its response. MUST run on the write's own
 * transaction executor, after the write: a concurrent holder of the same key
 * makes the insert wait for that transaction, and a committed live holder
 * makes it a no-op, which throws AgentApiIdempotencyRaceLostError to roll
 * this write back. An expired holder is replaced in place (the conditional
 * upsert takes its row lock, so two writers reusing one expired key still
 * produce exactly one write: the second re-checks the replaced, now live row
 * and loses).
 */
export async function recordAgentApiIdempotentResponse(
  executor: DatabaseExecutor,
  scope: AgentApiIdempotencyScope,
  response: AgentApiIdempotentResponse,
  now: Date = currentDate(),
): Promise<void> {
  const wireBody = JSON.parse(JSON.stringify(normalizeAgentApiWireValue(response.body))) as Record<string, unknown>;
  const inserted = await executor
    .insert(agentApiIdempotencyKeys)
    .values({
      agentId: scope.agentId,
      route: scope.route,
      idempotencyKey: scope.idempotencyKey,
      requestFingerprint: scope.requestFingerprint,
      responseStatus: response.status,
      responseBody: wireBody,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [agentApiIdempotencyKeys.agentId, agentApiIdempotencyKeys.route, agentApiIdempotencyKeys.idempotencyKey],
      set: {
        requestFingerprint: scope.requestFingerprint,
        responseStatus: response.status,
        responseBody: wireBody,
        createdAt: now,
      },
      setWhere: sql`${agentApiIdempotencyKeys.createdAt} <= ${expiryCutoff(now)}`,
    })
    .returning({ agentId: agentApiIdempotencyKeys.agentId });
  if (inserted.length === 0) {
    raceHooksForTests.onRaceLost?.(scope);
    throw new AgentApiIdempotencyRaceLostError();
  }
}

export const AGENT_API_IDEMPOTENCY_PRUNE_BATCH_SIZE = 1_000;
export const AGENT_API_IDEMPOTENCY_PRUNE_MAX_BATCHES = 10;

/**
 * Delete expired ledger rows, oldest first through the created_at index, in
 * bounded batches: at most `maxBatches` deletes of `batchSize` rows per run,
 * so one maintenance tick never holds a long delete. Returns the rows deleted.
 */
export async function pruneExpiredAgentApiIdempotencyKeys(opts: {
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
  executor?: DatabaseExecutor;
} = {}): Promise<number> {
  const db = opts.executor ?? getDb();
  const cutoff = expiryCutoff(opts.now ?? currentDate());
  const batchSize = opts.batchSize ?? AGENT_API_IDEMPOTENCY_PRUNE_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? AGENT_API_IDEMPOTENCY_PRUNE_MAX_BATCHES;
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const deleted = await db.execute<{ agent_id: string }>(sql`
      DELETE FROM ${agentApiIdempotencyKeys}
      WHERE (agent_id, route, idempotency_key) IN (
        SELECT agent_id, route, idempotency_key FROM ${agentApiIdempotencyKeys}
        WHERE created_at <= ${cutoff}
        ORDER BY created_at
        LIMIT ${batchSize}
      )
      RETURNING agent_id`);
    const count = deleted.rows.length;
    total += count;
    if (count < batchSize) break;
  }
  return total;
}
