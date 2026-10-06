// messages.server_id step 2 operator entrypoint. NEVER scheduled; run manually
// in the agreed window (weekdays from 19:00Z), under the pause rules in the
// design doc (RW freshness, RW slot retention, primary p95). messages is in the
// RisingWave publication, so every updated row is a CDC change event.
// Idempotent and resumable: re-running only pays the scan; --from-page resumes
// from the next_page of a previous run's batch lines.
//
// Pausing without losing the place:
//   --pause-file <path>  while this file exists, the run holds between batches
//                        (touch it on a BREACH, remove it on RECOVERED).
//                        Repeatable: the run holds while ANY of them exists, so
//                        the RW freshness sampler and the operator (slot
//                        retention, primary p95) each own their own file and
//                        one's RECOVERED never lifts the other's pause.
//   --stop-at <ISO-8601> end cleanly before the first batch after this time
//                        (e.g. 2026-10-06T01:00:00Z), printing the resume page.
//   --to-page <n>        process pages [from, n) only, e.g. a bounded trial run
//                        (rows ~= n x reltuples/relpages). Skips the verify.
//
// Usage:
//   DATABASE_URL=... node --import @oxc-node/core/register scripts/messages-server-id-backfill.ts \
//     [--pages-per-batch 700] [--sleep-ms 200] [--statement-timeout-ms 30000] [--lock-timeout-ms 2000] \
//     [--from-page <n>] [--to-page <n>] [--pause-file <path>]... [--stop-at <iso>]
//   DATABASE_URL=... node --import @oxc-node/core/register scripts/messages-server-id-backfill.ts --verify-only [--verify-sleep-ms 100]
// Verify runs only after a backfill that reached its end page (not after --stop-at or --to-page).
//
// RUNBOOK (owner role; the autovacuum change MUST be undone at the end):
//   before the first night:
//     ALTER TABLE messages SET (autovacuum_vacuum_scale_factor = 0.15);
//     -- ~1 autovacuum per 2.5M updated rows instead of per 330k; each pass
//     -- scans all 11 GB of indexes.
//   every night: this script with --stop-at, plus the pause files.
//   after the run reaches its end page and verify prints 0/0:
//     ALTER TABLE messages SET (autovacuum_vacuum_scale_factor = 0.02);  -- restore
//     VACUUM (ANALYZE) messages;
//     ALTER TABLE messages VALIDATE CONSTRAINT messages_server_id_not_null;
// The script prints the current autovacuum_vacuum_scale_factor at the end of
// every run as a reminder.
import "dotenv/config";
import { existsSync } from "node:fs";
import { setClockTimeout } from "@botiverse/raft-shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql, type SQL } from "drizzle-orm";
import pg from "pg";
import { runMessagesServerIdBackfill, verifyMessagesServerId, type BeforeBatchDecision } from "../src/services/messagesServerIdBackfill";

function flag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

function flags(name: string): string[] {
  return process.argv.flatMap((arg, idx) => (arg === name && idx + 1 < process.argv.length ? [process.argv[idx + 1]!] : []));
}

function fail(message: string): never {
  console.error(`[MESSAGES_SERVER_ID_BACKFILL_FAILED] ${message}`);
  process.exit(1);
}

function intFlag(name: string, fallback: number): number {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== raw) fail(`invalid ${name}: ${raw}`);
  return parsed;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setClockTimeout(resolve, ms));

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) fail("DATABASE_URL is not set");
  const fromPage = intFlag("--from-page", 0);
  const toPageRaw = flag("--to-page");
  const toPage = toPageRaw === undefined ? undefined : intFlag("--to-page", 0);
  if (toPage !== undefined && toPage <= fromPage) fail("--to-page must be greater than --from-page");
  const pagesPerBatch = intFlag("--pages-per-batch", 700);
  if (pagesPerBatch === 0) fail("--pages-per-batch must be positive");
  const pauseFiles = flags("--pause-file");
  const stopAtRaw = flag("--stop-at");
  const stopAt = stopAtRaw === undefined ? undefined : Date.parse(stopAtRaw);
  if (stopAt !== undefined && Number.isNaN(stopAt)) fail(`invalid --stop-at: ${stopAtRaw}`);
  const verifyOnly = process.argv.includes("--verify-only");

  const beforeBatch = async (): Promise<BeforeBatchDecision> => {
    let announced = false;
    for (;;) {
      if (stopAt !== undefined && Date.now() >= stopAt) return "stop";
      const present = pauseFiles.filter((file) => existsSync(file));
      if (present.length === 0) break;
      if (!announced) {
        console.log(`[MESSAGES_SERVER_ID_BACKFILL_PAUSED] pause file present: ${present.join(", ")}`);
        announced = true;
      }
      await sleep(5000);
    }
    if (announced) console.log("[MESSAGES_SERVER_ID_BACKFILL_RESUMED]");
    return "continue";
  };

  const pool = new pg.Pool({
    connectionString: url,
    max: 1,
    application_name: "messages-server-id-backfill",
    statement_timeout: intFlag("--statement-timeout-ms", 30_000),
    lock_timeout: intFlag("--lock-timeout-ms", 2_000),
  });
  const db = drizzle(pool);
  const run = async (query: SQL) => (await db.execute(query)).rows as Array<Record<string, unknown>>;
  try {
    if (!verifyOnly) {
      const result = await runMessagesServerIdBackfill(run, {
        pagesPerBatch,
        sleepMs: intFlag("--sleep-ms", 200),
        fromPage,
        toPage,
        beforeBatch,
        log: (line) => console.log(line),
      });
      console.log(`[MESSAGES_SERVER_ID_BACKFILL_REPORT] ${JSON.stringify(result)}`);
      if (result.stopped || toPage !== undefined) {
        console.log(`[MESSAGES_SERVER_ID_BACKFILL_STOPPED] resume with --from-page ${result.nextPage}`);
        return;
      }
    }
    const divergence = await verifyMessagesServerId(run, { sleepMs: intFlag("--verify-sleep-ms", 100) });
    console.log(`[MESSAGES_SERVER_ID_VERIFY] ${JSON.stringify(divergence)}`);
    if (divergence.missingRows !== 0 || divergence.divergentRows !== 0) process.exitCode = 2;
  } catch (err) {
    // Drizzle wraps the driver error; its cause carries the Postgres reason.
    const cause = err instanceof Error && err.cause instanceof Error ? ` cause: ${err.cause.message}` : "";
    const message = (err instanceof Error ? err.message : String(err)) + cause;
    console.error(`[MESSAGES_SERVER_ID_BACKFILL_FAILED] ${message.replaceAll("\n", " ")}`);
    process.exitCode = 1;
  } finally {
    // Reminder for the runbook: the scale factor must be back at 0.02 after the run.
    try {
      const rows = await run(sql`
        SELECT coalesce((SELECT option_value FROM pg_options_to_table(reloptions) WHERE option_name = 'autovacuum_vacuum_scale_factor'), 'default') AS factor
        FROM pg_class WHERE oid = 'messages'::regclass`);
      console.log(`[MESSAGES_SERVER_ID_AUTOVACUUM] messages autovacuum_vacuum_scale_factor=${String(rows[0]?.factor)} (restore to 0.02 once the backfill is complete)`);
    } catch {
      // Reporting only.
    }
    await pool.end().catch(() => {});
  }
}

void main();
