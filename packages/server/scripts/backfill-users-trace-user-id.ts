#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * Fill users.trace_user_id (migration 0319) for rows created before it. New
 * rows get a value from the column default. Small batches, each its own short
 * transaction with a bounded lock_timeout, because every authenticated request
 * reads users. Existing values are never overwritten, so re-running is safe.
 * Defaults to dry-run; pass --apply to write.
 */
import pg from "pg";

function usage(exitCode: number): never {
  console.error(`Usage:
  DATABASE_URL=... pnpm --filter @botiverse/raft-server db:backfill-users-trace-user-id -- [--apply] [--batch <n>]`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): { apply: boolean; batch: number } {
  if (argv[0] === "--") argv = argv.slice(1);
  const options = { apply: false, batch: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") { options.apply = true; continue; }
    if (arg === "--batch") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0 || value > 10_000) throw new Error("--batch must be 1..10000");
      options.batch = value;
      continue;
    }
    if (arg === "--help" || arg === "-h") usage(0);
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) usage(2);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows: [missing] } = await client.query<{ n: string }>("SELECT count(*) AS n FROM users WHERE trace_user_id IS NULL");
    console.log(`users without trace_user_id: ${missing!.n}`);
    if (!options.apply) {
      console.log("dry-run; pass --apply to fill them");
      return;
    }
    let total = 0;
    for (;;) {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '30s'");
      const result = await client.query(
        `UPDATE users SET trace_user_id = gen_random_uuid()
         WHERE id IN (SELECT id FROM users WHERE trace_user_id IS NULL LIMIT $1 FOR UPDATE SKIP LOCKED)`,
        [options.batch],
      );
      await client.query("COMMIT");
      total += result.rowCount ?? 0;
      if (!result.rowCount) break;
      console.log(`filled ${total}`);
    }
    const { rows: [left] } = await client.query<{ n: string }>("SELECT count(*) AS n FROM users WHERE trace_user_id IS NULL");
    console.log(`done: filled ${total}, still missing ${left!.n}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
