// message_server_timeline step 2 operator entrypoint. NEVER scheduled; run
// manually, off-peak, watching replica replay lag (the table is not in the
// RisingWave publication, so there is no CDC traffic, only WAL). Idempotent and
// resumable: re-running only pays the scan; --after-id resumes from the last_id
// of a previous run's batch lines.
//
// Usage:
//   DATABASE_URL=... node --import @oxc-node/core/register scripts/message-server-timeline-backfill.ts \
//     [--batch-size 5000] [--sleep-ms 200] [--statement-timeout-ms 30000] [--lock-timeout-ms 2000] [--after-id <uuid>]
//   DATABASE_URL=... node --import @oxc-node/core/register scripts/message-server-timeline-backfill.ts --verify-only
// The final [MESSAGE_TIMELINE_VERIFY] line is the switch gate evidence: both
// counts must be 0, measured after the backfill finished.
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import type { SQL } from "drizzle-orm";
import pg from "pg";
import { runMessageServerTimelineBackfill, verifyMessageServerTimeline } from "../src/services/messageServerTimelineBackfill";

function flag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

function intFlag(name: string, fallback: number): number {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.error(`[MESSAGE_TIMELINE_BACKFILL_FAILED] invalid ${name}: ${raw}`);
    process.exit(1);
  }
  return parsed;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[MESSAGE_TIMELINE_BACKFILL_FAILED] DATABASE_URL is not set");
    process.exitCode = 1;
    return;
  }
  const afterId = flag("--after-id");
  if (afterId !== undefined && !/^[0-9a-f-]{36}$/.test(afterId)) {
    console.error(`[MESSAGE_TIMELINE_BACKFILL_FAILED] invalid --after-id: ${afterId}`);
    process.exitCode = 1;
    return;
  }
  const pool = new pg.Pool({
    connectionString: url,
    max: 1,
    application_name: "message-server-timeline-backfill",
    statement_timeout: intFlag("--statement-timeout-ms", 30_000),
    lock_timeout: intFlag("--lock-timeout-ms", 2_000),
  });
  const db = drizzle(pool);
  const run = async (query: SQL) => (await db.execute(query)).rows as Array<Record<string, unknown>>;
  try {
    if (!process.argv.includes("--verify-only")) {
      const result = await runMessageServerTimelineBackfill(run, {
        batchSize: intFlag("--batch-size", 5000),
        sleepMs: intFlag("--sleep-ms", 200),
        afterId,
        log: (line) => console.log(line),
      });
      console.log(`[MESSAGE_TIMELINE_BACKFILL_REPORT] ${JSON.stringify(result)}`);
    }
    const divergence = await verifyMessageServerTimeline(run);
    console.log(`[MESSAGE_TIMELINE_VERIFY] ${JSON.stringify(divergence)}`);
    if (divergence.missingRows !== 0 || divergence.divergentRows !== 0) process.exitCode = 2;
  } catch (err) {
    // Drizzle wraps the driver error; its cause carries the Postgres reason.
    const cause = err instanceof Error && err.cause instanceof Error ? ` cause: ${err.cause.message}` : "";
    const message = (err instanceof Error ? err.message : String(err)) + cause;
    console.error(`[MESSAGE_TIMELINE_BACKFILL_FAILED] ${message.replaceAll("\n", " ")}`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

void main();
