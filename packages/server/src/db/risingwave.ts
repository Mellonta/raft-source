import pg from "pg";
import { attachPoolClientErrorHandler } from "./pgPoolErrorHandler";
import { performance } from "node:perf_hooks";
import { recordExternalSinkInsideTransaction } from "./ambientTransaction";

export const RISINGWAVE_UNREAD_INBOX_CONTRACT_VERSION = 2;
/**
 * The unified chain's reader-facing views. Every reader of one request-path -- the
 * Activity list, the Activity badge, the mobile push badge, agent recovery and the
 * sidebar -- takes its views from this ONE set, so no two of them can count by
 * different rules. There is no generation switch: rolling back is a deploy revert.
 *
 * The totals are stacked ON the serving view on purpose (tygg's ruling
 * 2026-09-20): they inherit every serving predicate (mention-only zeroing, target
 * kinds, watermark, free-tier cutoff) by construction, so a badge is
 * definitionally the sum of what its list shows. Rebuild scripts must carry this
 * dependent.
 *
 * The set is the chain on mention v6 (infra/risingwave/sql/067-mention-v6.sql and
 * 068-chain-mention-v6-consumers.sql), carrying the v5 semantics
 * (infra/risingwave/sql/063-chain-v5.sql: mute acts at admission, the watermark is
 * per (receiver, server), every (user, server) membership has a totals row).
 * message_mentions.channel_id of a joint conversation is the SENDER's local
 * projection while the message lives in canonical storage; rw_inbox_mention_v5
 * keyed mentions by that raw id and dropped every one of them. rw_inbox_mention_v6
 * maps a projection id to its canonical storage first, then fans out to local
 * targets (projected targets are membership-gated). Every older reader view sits
 * on the dropping arm.
 *
 * agentInbox (rw_agent_inbox_v5) owns the offer rules (offered rows only, thread
 * deliverability, a mention beyond the admitted stream pierces a mute,
 * offered_unread / activity_seq), and the app reads its columns without
 * re-deriving them.
 *
 * conversationUnread (rw_conversation_unread_v2; rw_inbox_muted_full_v1 in
 * infra/risingwave/sql/066-conversation-unread-v1.sql) is the sidebar's unread
 * source -- GET /channels/unread (bare and summary) and the per-server pink badge
 * (GET /servers/unread-summary).
 */
export const CONVERSATION_UNREAD_VIEW = "rw_conversation_unread_v2";
export const UNIFIED_CHAIN_VIEWS = {
  serving: "rw_inbox_serving_v6",
  totals: "rw_activity_totals_v4",
  agentInbox: "rw_agent_inbox_v5",
  conversationUnread: CONVERSATION_UNREAD_VIEW,
} as const;
export type RisingWaveInboxItemsServingVersion = 2 | 3;
export type RisingWaveInboxRfc056ServingMode = "off" | "shadow" | "on";
export const RISINGWAVE_UNREAD_INBOX_SERVING_VERSION: RisingWaveInboxItemsServingVersion = 2;
const DEFAULT_RISINGWAVE_CONNECTION_TIMEOUT_MS = 1_000;
const MIN_RISINGWAVE_CONNECTION_TIMEOUT_MS = 250;
const MAX_RISINGWAVE_CONNECTION_TIMEOUT_MS = 10_000;

export type RisingWavePoolState = {
  rw_pool_total: number;
  rw_pool_idle: number;
  rw_pool_waiting: number;
};

export type RisingWaveQueryRead<T extends pg.QueryResultRow = any> = {
  result: pg.QueryResult<T>;
  acquireWaitMs: number;
  poolState: RisingWavePoolState;
};

export function getRisingWaveInboxItemsServingVersion(): RisingWaveInboxItemsServingVersion {
  return RISINGWAVE_UNREAD_INBOX_SERVING_VERSION;
}

export function getRisingWaveInboxRfc056ServingMode(
  env: NodeJS.ProcessEnv = process.env,
): RisingWaveInboxRfc056ServingMode {
  const value = env.RISINGWAVE_INBOX_RFC056_SERVING_MODE?.trim().toLowerCase();
  if (value === "shadow" || value === "on") return value;
  // Fail closed for missing and invalid values. Operators must explicitly
  // authorize every RFC056 candidate read or serving transition.
  return "off";
}

let _risingWavePool: pg.Pool | null = null;
let _risingWaveUrl: string | null = null;

export function getRisingWaveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.RISINGWAVE_DATABASE_URL?.trim();
  return value ? value : null;
}

export function isRisingWaveConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(getRisingWaveDatabaseUrl(env));
}

/**
 * RisingWave is a hard dependency of the server: the Activity, followed-thread
 * and sidebar unread reads are served from it only. With no RisingWave
 * configured those reads fail with this error; there is no Postgres fallback.
 */
export class RisingWaveNotConfiguredError extends Error {
  constructor(surface: string) {
    super(`RisingWave is not configured (RISINGWAVE_DATABASE_URL is unset); cannot serve ${surface}`);
    this.name = "RisingWaveNotConfiguredError";
  }
}

/**
 * Every RisingWave pool connection stayed busy past the acquire timeout
 * (RISINGWAVE_CONNECTION_TIMEOUT_MS): RisingWave is slow, not down, and the
 * request can be retried. Routes answer it with 503 + Retry-After instead of
 * 500 (respondToRisingWaveOverload). The message keeps pg-pool's wording so
 * trace classification still reads it as rw_acquire_timeout.
 */
export class RisingWaveOverloadedError extends Error {
  constructor(cause: unknown) {
    super(`RisingWave pool saturated: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "RisingWaveOverloadedError";
  }
}

/** pg-pool's "no client within connectionTimeoutMillis" error. */
export function isPoolAcquireTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timeout exceeded when trying to connect/i.test(error.message);
}

/** Rethrow a RisingWave pool acquire timeout as RisingWaveOverloadedError. */
export function asRisingWaveOverload(error: unknown): unknown {
  return isPoolAcquireTimeoutError(error) && !(error instanceof RisingWaveOverloadedError)
    ? new RisingWaveOverloadedError(error)
    : error;
}

export function getRisingWaveConnectionTimeoutMillis(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RISINGWAVE_CONNECTION_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_RISINGWAVE_CONNECTION_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_RISINGWAVE_CONNECTION_TIMEOUT_MS;
  return Math.min(
    Math.max(Math.trunc(parsed), MIN_RISINGWAVE_CONNECTION_TIMEOUT_MS),
    MAX_RISINGWAVE_CONNECTION_TIMEOUT_MS,
  );
}

export async function queryRisingWave<T extends pg.QueryResultRow = any>(
  pool: pg.Pool,
  queryText: string,
  values?: unknown[],
): Promise<RisingWaveQueryRead<T>> {
  // A RisingWave read is an external round-trip; if it runs while a Postgres
  // transaction is open, that transaction sits idle holding a connection waiting
  // on RisingWave. Report it to the audit file (when enabled) so the test suite
  // can surface any such call site at any depth.
  recordExternalSinkInsideTransaction("risingwave");
  const acquireStartedAt = performance.now();
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw asRisingWaveOverload(error);
  }
  const acquireWaitMs = performance.now() - acquireStartedAt;
  const poolState = getRisingWavePoolState(pool);
  try {
    const result = await client.query<T>(queryText, values);
    return { result, acquireWaitMs, poolState };
  } finally {
    client.release();
  }
}

export function getRisingWavePool(): pg.Pool | null {
  const databaseUrl = getRisingWaveDatabaseUrl();
  if (!databaseUrl) return null;

  if (_risingWavePool && _risingWaveUrl === databaseUrl) {
    return _risingWavePool;
  }

  if (_risingWavePool) {
    void _risingWavePool.end().catch((err) => {
      console.error("[risingwave] failed to close replaced pool:", err.message);
    });
  }

  _risingWaveUrl = databaseUrl;
  _risingWavePool = new pg.Pool({
    connectionString: databaseUrl,
    max: Number(process.env.RISINGWAVE_POOL_MAX || "10"),
    connectionTimeoutMillis: getRisingWaveConnectionTimeoutMillis(),
    idleTimeoutMillis: 60_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    ssl: databaseUrl.includes("risingwave.cloud") ? { rejectUnauthorized: false } : undefined,
  });
  _risingWavePool.on("error", (err) => {
    console.error("[risingwave] unexpected pool error:", err.message);
  });
  // Same crash guard as the primary pool (task #269): pg-pool detaches its
  // idle 'error' listener from checked-out clients, so a dropped connection
  // between queries would otherwise take the process down.
  attachPoolClientErrorHandler(_risingWavePool, "risingwave");
  return _risingWavePool;
}

export function getRisingWavePoolState(pool: pg.Pool | null = _risingWavePool): RisingWavePoolState {
  return {
    rw_pool_total: pool?.totalCount ?? 0,
    rw_pool_idle: pool?.idleCount ?? 0,
    rw_pool_waiting: pool?.waitingCount ?? 0,
  };
}

export async function closeRisingWavePool() {
  if (_risingWavePool) {
    await _risingWavePool.end();
  }
  _risingWavePool = null;
  _risingWaveUrl = null;
}
