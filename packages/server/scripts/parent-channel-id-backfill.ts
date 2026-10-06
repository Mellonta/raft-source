// channels.parent_channel_id phase 2 operator entrypoint. NEVER scheduled; run
// manually, off-peak, with the RisingWave CDC lag watch on (every updated row is
// an rw_channels update). Idempotent and resumable: re-running only pays the
// scan; --after-id resumes from the last_id of a previous run's batch lines.
//
// Usage:
//   DATABASE_URL=... node --import @oxc-node/core/register scripts/parent-channel-id-backfill.ts \
//     [--batch-size 1000] [--sleep-ms 200] [--statement-timeout-ms 30000] [--lock-timeout-ms 2000] [--after-id <uuid>]
// A batch that meets a row held by a long transaction fails fast on the lock
// timeout instead of holding its own row locks while it waits; resume with
// --after-id <last_id of the last BATCH line>.
//   DATABASE_URL=... node --import @oxc-node/core/register scripts/parent-channel-id-backfill.ts --verify-only
// The final [PARENT_CHANNEL_VERIFY] line is the phase-4 gate evidence: both
// counts must be 0 before search reads the column.
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import type { SQL } from "drizzle-orm";
import pg from "pg";
import { runParentChannelIdBackfill, verifyParentChannelIds } from "../src/services/parentChannelIdBackfill";

function flag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

function intFlag(name: string, fallback: number): number {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.error(`[PARENT_CHANNEL_BACKFILL_FAILED] invalid ${name}: ${raw}`);
    process.exit(1);
  }
  return parsed;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[PARENT_CHANNEL_BACKFILL_FAILED] DATABASE_URL is not set");
    process.exitCode = 1;
    return;
  }
  const afterId = flag("--after-id");
  if (afterId !== undefined && !/^[0-9a-f-]{36}$/.test(afterId)) {
    console.error(`[PARENT_CHANNEL_BACKFILL_FAILED] invalid --after-id: ${afterId}`);
    process.exitCode = 1;
    return;
  }
  const pool = new pg.Pool({
    connectionString: url,
    max: 1,
    application_name: "parent-channel-id-backfill",
    statement_timeout: intFlag("--statement-timeout-ms", 30_000),
    lock_timeout: intFlag("--lock-timeout-ms", 2_000),
  });
  const db = drizzle(pool);
  const run = async (query: SQL) => (await db.execute(query)).rows as Array<Record<string, unknown>>;
  try {
    if (!process.argv.includes("--verify-only")) {
      const result = await runParentChannelIdBackfill(run, {
        batchSize: intFlag("--batch-size", 1000),
        sleepMs: intFlag("--sleep-ms", 200),
        afterId,
        log: (line) => console.log(line),
      });
      console.log(`[PARENT_CHANNEL_BACKFILL_REPORT] ${JSON.stringify(result)}`);
    }
    const divergence = await verifyParentChannelIds(run);
    console.log(`[PARENT_CHANNEL_VERIFY] ${JSON.stringify(divergence)}`);
    if (divergence.divergentThreads !== 0 || divergence.nonThreadsWithValue !== 0) process.exitCode = 2;
  } catch (err) {
    // Drizzle wraps the driver error; its cause carries the Postgres reason.
    const cause = err instanceof Error && err.cause instanceof Error ? ` cause: ${err.cause.message}` : "";
    const message = (err instanceof Error ? err.message : String(err)) + cause;
    console.error(`[PARENT_CHANNEL_BACKFILL_FAILED] ${message.replaceAll("\n", " ")}`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

void main();
