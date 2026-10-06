// messages.server_id step 2: operator-run backfill of the rows that existed
// before 0317. New rows get server_id from the 0317 insert trigger, and any app
// update of an unfilled row fills it too; this only fills history.
//
// SCRIPT-ONLY: the sole non-test caller is scripts/messages-server-id-backfill.ts,
// which builds its own single-connection pool. The server runtime never reaches
// this module.
//
// Batches walk the heap in physical order (ctid page ranges, a TID range scan),
// not by id: ids are random uuids, so an id-ordered batch would touch thousands
// of scattered pages, and each could cost a full-page write. In page order every
// page is updated once, in one batch. Each batch is one short autocommit UPDATE
// of the still-NULL rows in `pagesPerBatch` pages. The table is fillfactor 100,
// so most updates are not HOT: the new versions land elsewhere (freed space or
// the end of the table) with server_id already set, so a later batch skips them.
//
// messages IS in slock_rw_publication: every updated row is a change event for
// RisingWave. The run is spaced and pausable for that reason (`beforeBatch`).
import { setClockTimeout } from "@botiverse/raft-shared";
import { sql, type SQL } from "drizzle-orm";

export type BackfillExecutor = (query: SQL) => Promise<Array<Record<string, unknown>>>;

export type BeforeBatchDecision = "continue" | "stop";

// The executor's connection carries statement_timeout and lock_timeout (the
// script sets both on its pool), so every batch is bounded and a row lock held
// by a live update makes the batch fail fast and retry instead of waiting.
export interface MessagesServerIdBackfillOptions {
  pagesPerBatch?: number;
  sleepMs?: number;
  /** First heap page to process (resume point printed by a previous run). */
  fromPage?: number;
  /** Stop before this heap page (exclusive), e.g. a bounded trial run; capped at the heap size. */
  toPage?: number;
  /** Retries of one batch after a lock_timeout before the run fails. */
  maxLockRetries?: number;
  /** Awaited before every batch; may wait (pause) and returns "stop" to end the run cleanly. */
  beforeBatch?: () => Promise<BeforeBatchDecision>;
  log?: (line: string) => void;
}

export interface MessagesServerIdBackfillResult {
  batches: number;
  rowsUpdated: number;
  /** Next page to process: the --from-page of a resumed run. */
  nextPage: number;
  /** Heap size in pages when the run started (or --to-page if smaller); the run stops there. */
  endPage: number;
  lockRetries: number;
  /** True when the run ended because beforeBatch said stop, not because it reached endPage. */
  stopped: boolean;
}

export interface MessagesServerIdDivergence {
  /** Rows still without server_id. */
  missingRows: number;
  /** Rows whose server_id differs from their channel's server. */
  divergentRows: number;
  sampleIds: string[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setClockTimeout(resolve, ms));
const LOCK_NOT_AVAILABLE = "55P03";

const tid = (page: number) => `(${page},0)`;

async function heapPages(run: BackfillExecutor): Promise<number> {
  const rows = await run(sql`SELECT (pg_relation_size('messages') / current_setting('block_size')::bigint)::int AS pages`);
  return Number((rows[0] as { pages: number } | undefined)?.pages ?? 0);
}

function isLockTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if ((current as { code?: unknown }).code === LOCK_NOT_AVAILABLE) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function runMessagesServerIdBackfill(
  run: BackfillExecutor,
  options: MessagesServerIdBackfillOptions = {},
): Promise<MessagesServerIdBackfillResult> {
  const pagesPerBatch = options.pagesPerBatch ?? 700;
  const sleepMs = options.sleepMs ?? 200;
  const maxLockRetries = options.maxLockRetries ?? 5;
  const log = options.log ?? (() => {});
  // Rows written after the migration already have server_id, and so do the new
  // versions this run creates, so the heap size at the start bounds the work.
  const heapEnd = await heapPages(run);
  const endPage = options.toPage === undefined ? heapEnd : Math.min(options.toPage, heapEnd);
  const result: MessagesServerIdBackfillResult = {
    batches: 0, rowsUpdated: 0, nextPage: options.fromPage ?? 0, endPage, lockRetries: 0, stopped: false,
  };
  let retriesThisBatch = 0;
  while (result.nextPage < endPage) {
    if (options.beforeBatch && (await options.beforeBatch()) === "stop") {
      result.stopped = true;
      break;
    }
    const from = result.nextPage;
    const to = Math.min(from + pagesPerBatch, endPage);
    let updated: number;
    try {
      const rows = await run(sql`
        WITH updated AS (
          UPDATE messages m
          SET server_id = c.server_id
          FROM channels c
          WHERE m.ctid >= ${tid(from)}::tid
            AND m.ctid < ${tid(to)}::tid
            AND m.server_id IS NULL
            AND c.id = m.channel_id
          RETURNING 1
        )
        SELECT count(*)::int AS updated FROM updated
      `);
      updated = Number((rows[0] as { updated: number } | undefined)?.updated ?? 0);
    } catch (error) {
      if (!isLockTimeout(error) || retriesThisBatch >= maxLockRetries) throw error;
      retriesThisBatch += 1;
      result.lockRetries += 1;
      log(`[MESSAGES_SERVER_ID_BACKFILL_LOCK_RETRY] pages=${from}-${to} attempt=${retriesThisBatch}`);
      if (sleepMs > 0) await sleep(sleepMs);
      continue;
    }
    retriesThisBatch = 0;
    result.batches += 1;
    result.rowsUpdated += updated;
    result.nextPage = to;
    log(`[MESSAGES_SERVER_ID_BACKFILL_BATCH] n=${result.batches} pages=${from}-${to} of ${endPage} updated=${updated} next_page=${to}`);
    if (sleepMs > 0 && to < endPage) await sleep(sleepMs);
  }
  return result;
}

/**
 * Read-only check over the whole current heap, in ctid page slices so no
 * statement reads the whole table: rows still without server_id, and rows whose
 * server_id differs from their channel's. Run after a backfill that reached its
 * end page; during it, "missing" counts the pages it has not reached yet. Both
 * must be 0 before VALIDATE CONSTRAINT messages_server_id_not_null, which is
 * the final proof.
 */
export async function verifyMessagesServerId(
  run: BackfillExecutor,
  options: { pagesPerSlice?: number; sampleLimit?: number; sleepMs?: number } = {},
): Promise<MessagesServerIdDivergence> {
  const pagesPerSlice = options.pagesPerSlice ?? 20_000;
  const sampleLimit = options.sampleLimit ?? 20;
  const sleepMs = options.sleepMs ?? 0;
  const divergence: MessagesServerIdDivergence = { missingRows: 0, divergentRows: 0, sampleIds: [] };
  const endPage = await heapPages(run);
  for (let from = 0; from < endPage; from += pagesPerSlice) {
    const rows = await run(sql`
      WITH checked AS (
        SELECT
          m.id,
          m.server_id IS NULL AS missing,
          m.server_id IS NOT NULL AND m.server_id IS DISTINCT FROM c.server_id AS divergent
        FROM messages m
        JOIN channels c ON c.id = m.channel_id
        WHERE m.ctid >= ${tid(from)}::tid
          AND m.ctid < ${tid(from + pagesPerSlice)}::tid
      )
      SELECT
        (SELECT count(*)::int FROM checked WHERE missing) AS missing,
        (SELECT count(*)::int FROM checked WHERE divergent) AS divergent,
        (SELECT coalesce(array_agg(id::text), '{}') FROM (SELECT id FROM checked WHERE missing OR divergent LIMIT ${sampleLimit}) sample) AS sample_ids
    `);
    const row = rows[0] as { missing: number; divergent: number; sample_ids: string[] } | undefined;
    if (!row) continue;
    divergence.missingRows += row.missing;
    divergence.divergentRows += row.divergent;
    for (const id of row.sample_ids) {
      if (divergence.sampleIds.length < sampleLimit) divergence.sampleIds.push(id);
    }
    if (sleepMs > 0 && from + pagesPerSlice < endPage) await sleep(sleepMs);
  }
  return divergence;
}
