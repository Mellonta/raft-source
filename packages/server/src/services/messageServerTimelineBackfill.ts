// message_server_timeline step 2: operator-run keyset backfill of the messages
// that existed before 0310. Live writes are already covered by the 0310
// triggers from the moment the migration committed; this only fills history.
//
// SCRIPT-ONLY: the sole non-test caller is scripts/message-server-timeline-backfill.ts,
// which builds its own single-connection pool. The server runtime never reaches
// this module.
//
// Each batch is one short autocommit INSERT ... SELECT over at most `batchSize`
// messages in messages.id order, ON CONFLICT DO NOTHING: a row the trigger (a
// new message, or a message moved during the run) already wrote is newer than
// anything this batch could compute, so it is left alone, and a re-run after
// any interruption only pays the scan. Keyset on id rather than ctid ranges, so
// a message whose tuple moves (an edit) during the run is never skipped.
//
// The table is not in slock_rw_publication, so no batch reaches RisingWave CDC;
// the cost is WAL volume (about the new table's size) and messages' primary key
// reads. Batches are still spaced so the replica keeps up.
import { setClockTimeout } from "@botiverse/raft-shared";
import { sql, type SQL } from "drizzle-orm";

export type BackfillExecutor = (query: SQL) => Promise<Array<Record<string, unknown>>>;

// The executor's connection carries the per-statement timeout (the script sets
// statement_timeout on its pool), so every batch is bounded.
export interface MessageServerTimelineBackfillOptions {
  batchSize?: number;
  sleepMs?: number;
  /** Start after this messages.id (resume point printed by a previous run). */
  afterId?: string;
  log?: (line: string) => void;
}

export interface MessageServerTimelineBackfillResult {
  batches: number;
  messagesScanned: number;
  rowsInserted: number;
  lastId: string | null;
}

export interface MessageServerTimelineDivergence {
  /** Messages with no timeline row. */
  missingRows: number;
  /** Timeline rows whose server, time or channel differs from the message's current values. */
  divergentRows: number;
  sampleIds: string[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setClockTimeout(resolve, ms));
const MIN_UUID = "00000000-0000-0000-0000-000000000000";

export async function runMessageServerTimelineBackfill(
  run: BackfillExecutor,
  options: MessageServerTimelineBackfillOptions = {},
): Promise<MessageServerTimelineBackfillResult> {
  const batchSize = options.batchSize ?? 5000;
  const sleepMs = options.sleepMs ?? 200;
  const log = options.log ?? (() => {});
  const result: MessageServerTimelineBackfillResult = { batches: 0, messagesScanned: 0, rowsInserted: 0, lastId: options.afterId ?? null };
  for (;;) {
    const rows = await run(sql`
      WITH batch AS (
        SELECT m.id, m.channel_id, m.created_at
        FROM messages m
        WHERE m.id > ${result.lastId ?? MIN_UUID}::uuid
        ORDER BY m.id
        LIMIT ${batchSize}
      ),
      inserted AS (
        INSERT INTO message_server_timeline (message_id, server_id, created_at, channel_id)
        SELECT batch.id, c.server_id, batch.created_at, batch.channel_id
        FROM batch
        JOIN channels c ON c.id = batch.channel_id
        ON CONFLICT (message_id) DO NOTHING
        RETURNING message_id
      )
      SELECT
        (SELECT count(*)::int FROM batch) AS scanned,
        (SELECT count(*)::int FROM inserted) AS inserted,
        (SELECT max(id::text) FROM batch) AS last_id
    `);
    const row = rows[0] as { scanned: number; inserted: number; last_id: string | null } | undefined;
    if (!row || row.scanned === 0 || !row.last_id) break;
    result.batches += 1;
    result.messagesScanned += row.scanned;
    result.rowsInserted += row.inserted;
    result.lastId = row.last_id;
    log(`[MESSAGE_TIMELINE_BACKFILL_BATCH] n=${result.batches} scanned=${row.scanned} inserted=${row.inserted} last_id=${row.last_id}`);
    if (row.scanned < batchSize) break;
    if (sleepMs > 0) await sleep(sleepMs);
  }
  return result;
}

/**
 * The switch gate, in keyset slices over messages.id so no statement reads the
 * whole table: messages without a timeline row, and rows that disagree with the
 * message's current channel, the channel's server, or the message's time.
 * Timeline rows without a message cannot exist (FK ON DELETE CASCADE).
 * Run after the backfill has finished; during it, "missing" counts the messages
 * it has not reached yet.
 */
export async function verifyMessageServerTimeline(
  run: BackfillExecutor,
  options: { batchSize?: number; sampleLimit?: number } = {},
): Promise<MessageServerTimelineDivergence> {
  const batchSize = options.batchSize ?? 20_000;
  const sampleLimit = options.sampleLimit ?? 20;
  const divergence: MessageServerTimelineDivergence = { missingRows: 0, divergentRows: 0, sampleIds: [] };
  let lastId = MIN_UUID;
  for (;;) {
    const rows = await run(sql`
      WITH slice AS (
        SELECT m.id, m.channel_id, m.created_at
        FROM messages m
        WHERE m.id > ${lastId}::uuid
        ORDER BY m.id
        LIMIT ${batchSize}
      ),
      checked AS (
        SELECT
          slice.id,
          t.message_id IS NULL AS missing,
          t.message_id IS NOT NULL AND (
            t.server_id IS DISTINCT FROM c.server_id
            OR t.created_at IS DISTINCT FROM slice.created_at
            OR t.channel_id IS DISTINCT FROM slice.channel_id
          ) AS divergent
        FROM slice
        JOIN channels c ON c.id = slice.channel_id
        LEFT JOIN message_server_timeline t ON t.message_id = slice.id
      )
      SELECT
        (SELECT count(*)::int FROM slice) AS scanned,
        (SELECT max(id::text) FROM slice) AS last_id,
        (SELECT count(*)::int FROM checked WHERE missing) AS missing,
        (SELECT count(*)::int FROM checked WHERE divergent) AS divergent,
        (SELECT coalesce(array_agg(id::text), '{}') FROM (SELECT id FROM checked WHERE missing OR divergent LIMIT ${sampleLimit}) sample) AS sample_ids
    `);
    const row = rows[0] as { scanned: number; last_id: string | null; missing: number; divergent: number; sample_ids: string[] } | undefined;
    if (!row || row.scanned === 0 || !row.last_id) break;
    divergence.missingRows += row.missing;
    divergence.divergentRows += row.divergent;
    for (const id of row.sample_ids) {
      if (divergence.sampleIds.length < sampleLimit) divergence.sampleIds.push(id);
    }
    lastId = row.last_id;
    if (row.scanned < batchSize) break;
  }
  return divergence;
}
