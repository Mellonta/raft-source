import { currentDate, type AgentAppEventDetail, type AgentAppEventListResponse, type AgentAppEventSummary } from "@botiverse/raft-shared";
import { and, desc, eq, lt, or, sql, type SQL } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { oauthClients, thirdPartyAgentEvents } from "../db/schema";

// Human-facing read of the events connected apps sent to an agent (Agent panel).
// The agent's own read path stays in oauthService (readThirdPartyAgentEventForAgent).
// Callers check visibility (canInspectAgentPrivateSurfaces) before calling.

export const AGENT_APP_EVENTS_DEFAULT_LIMIT = 50;
export const AGENT_APP_EVENTS_MAX_LIMIT = 100;
/** Events are kept this long after they expire, then pruned. */
export const AGENT_APP_EVENT_RETENTION_AFTER_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH_SIZE = 1_000;
const PRUNE_MAX_BATCHES = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type EventRow = {
  event: typeof thirdPartyAgentEvents.$inferSelect;
  clientKey: string;
  clientName: string;
  logoUrl: string | null;
};

function displayStatus(event: EventRow["event"], now: Date): AgentAppEventSummary["status"] {
  if (event.status === "delivered") return "delivered";
  if (event.status === "expired" || event.status === "rejected") return "expired";
  return event.expiresAt.getTime() <= now.getTime() ? "expired" : "queued";
}

function toSummary(row: EventRow, now: Date): AgentAppEventSummary {
  return {
    id: row.event.id,
    app: { clientId: row.event.clientId, clientKey: row.clientKey, name: row.clientName, logoUrl: row.logoUrl },
    kind: row.event.kind,
    summary: row.event.summary,
    status: displayStatus(row.event, now),
    externalEventId: row.event.externalEventId,
    createdAt: row.event.createdAt.toISOString(),
    deliveredAt: row.event.deliveredAt?.toISOString() ?? null,
    expiresAt: row.event.expiresAt.toISOString(),
    payloadBytes: Buffer.byteLength(JSON.stringify(row.event.payload), "utf8"),
  };
}

/** Opaque keyset cursor over (created_at, id), newest first. */
export function encodeAgentAppEventCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeAgentAppEventCursor(cursor: string): { createdAt: Date; id: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf("|");
  if (sep <= 0) return null;
  const createdAt = new Date(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);
  if (Number.isNaN(createdAt.getTime()) || !UUID_RE.test(id)) return null;
  return { createdAt, id };
}

function selectEventRows(executor: DatabaseExecutor) {
  return executor.select({
    event: thirdPartyAgentEvents,
    clientKey: oauthClients.clientId,
    clientName: oauthClients.name,
    logoUrl: oauthClients.logoUrl,
  })
    .from(thirdPartyAgentEvents)
    .innerJoin(oauthClients, eq(oauthClients.id, thirdPartyAgentEvents.clientId));
}

export async function listAgentAppEvents(input: {
  agentId: string;
  clientId?: string;
  before?: { createdAt: Date; id: string };
  limit?: number;
  executor?: DatabaseExecutor;
}): Promise<AgentAppEventListResponse> {
  const now = currentDate();
  const limit = Math.min(Math.max(input.limit ?? AGENT_APP_EVENTS_DEFAULT_LIMIT, 1), AGENT_APP_EVENTS_MAX_LIMIT);
  const conditions: SQL[] = [eq(thirdPartyAgentEvents.agentId, input.agentId)];
  if (input.clientId) conditions.push(eq(thirdPartyAgentEvents.clientId, input.clientId));
  if (input.before) {
    conditions.push(or(
      lt(thirdPartyAgentEvents.createdAt, input.before.createdAt),
      and(eq(thirdPartyAgentEvents.createdAt, input.before.createdAt), lt(thirdPartyAgentEvents.id, input.before.id)),
    )!);
  }
  const rows = await selectEventRows(input.executor ?? getDb())
    .where(and(...conditions))
    .orderBy(desc(thirdPartyAgentEvents.createdAt), desc(thirdPartyAgentEvents.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    events: page.map((row) => toSummary(row, now)),
    nextCursor: rows.length > limit && last ? encodeAgentAppEventCursor(last.event.createdAt, last.event.id) : null,
  };
}

/** One event of this agent, or null. Unknown and other agents' ids are the same null. */
export async function getAgentAppEvent(input: {
  agentId: string;
  eventId: string;
  executor?: DatabaseExecutor;
}): Promise<AgentAppEventDetail | null> {
  if (!UUID_RE.test(input.eventId)) return null;
  const [row] = await selectEventRows(input.executor ?? getDb())
    .where(and(
      eq(thirdPartyAgentEvents.agentId, input.agentId),
      eq(thirdPartyAgentEvents.id, input.eventId.toLowerCase()),
    ))
    .limit(1);
  if (!row) return null;
  return { ...toSummary(row, currentDate()), payload: row.event.payload };
}

/**
 * Delete events that expired more than the retention window ago, in bounded
 * batches. Called from the hourly maintenance tick; returns rows deleted.
 */
export async function pruneExpiredAgentAppEvents(opts: {
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
  executor?: DatabaseExecutor;
} = {}): Promise<number> {
  const db = opts.executor ?? getDb();
  const cutoff = new Date((opts.now ?? currentDate()).getTime() - AGENT_APP_EVENT_RETENTION_AFTER_EXPIRY_MS);
  const batchSize = opts.batchSize ?? PRUNE_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? PRUNE_MAX_BATCHES;
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const deleted = await db.execute<{ id: string }>(sql`
      DELETE FROM ${thirdPartyAgentEvents}
      WHERE id IN (
        SELECT id FROM ${thirdPartyAgentEvents}
        WHERE expires_at <= ${cutoff}
        ORDER BY expires_at
        LIMIT ${batchSize}
      )
      RETURNING id`);
    const count = deleted.rows.length;
    total += count;
    if (count < batchSize) break;
  }
  return total;
}
