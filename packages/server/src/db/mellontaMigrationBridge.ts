// The public 1.13 snapshot ended with session_token_predecessors at 0266.
// In 1.21 the identical SQL is 0273, with seven new migrations inserted before
// it. Reconcile only that exact, complete old ledger; never guess from schema.
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import type pg from "pg";

export const LEGACY_PREDECESSORS_HASH = "81ec32a7d3c49f52e849e2df18885fcbde08267612755ca7ee01b99b29085bad";
export const LEGACY_PREDECESSORS_WHEN = 1789376344766;
const TABLE = '"drizzle"."__drizzle_migrations"';

export function planMellontaMigrationBridge(
  rows: Array<{ hash: string; created_at: string | number }>, migrations: MigrationMeta[],
): MigrationMeta[] | null {
  if (!rows.some(row => row.hash === LEGACY_PREDECESSORS_HASH && Number(row.created_at) === LEGACY_PREDECESSORS_WHEN)) return null;
  const canonical = migrations[273];
  if (canonical?.hash !== LEGACY_PREDECESSORS_HASH || canonical.folderMillis !== 1789461572432) {
    throw new Error("MELLONTA_MIGRATION_BRIDGE_TARGET_CHANGED");
  }
  const expected = new Set(migrations.slice(0, 266).map(m => `${m.hash}:${m.folderMillis}`));
  expected.add(`${LEGACY_PREDECESSORS_HASH}:${LEGACY_PREDECESSORS_WHEN}`);
  if (rows.length !== 267 || expected.size !== rows.length || rows.some(row => !expected.delete(`${row.hash}:${row.created_at}`))) {
    throw new Error("MELLONTA_MIGRATION_BRIDGE_LEDGER_DIVERGED");
  }
  return migrations.slice(266, 273);
}

/** Called after deployment backup, before upstream preflight/migrate. Atomic. */
export async function bridgeMellonta113(client: pg.Client, migrationsFolder: string): Promise<boolean> {
  const exists = await client.query("SELECT to_regclass('drizzle.__drizzle_migrations') AS ledger");
  if (!exists.rows[0]?.ledger) return false;
  await client.query("BEGIN");
  try {
    await client.query(`LOCK TABLE ${TABLE} IN EXCLUSIVE MODE`);
    const rows = await client.query(`SELECT hash, created_at FROM ${TABLE}`);
    const migrations = readMigrationFiles({ migrationsFolder });
    const pending = planMellontaMigrationBridge(rows.rows, migrations);
    if (!pending) { await client.query("COMMIT"); return false; }
    const timeout = await client.query("SHOW statement_timeout");
    if (timeout.rows[0]?.statement_timeout !== "1min") throw new Error("MELLONTA_MIGRATION_BRIDGE_REQUIRES_60000MS_TIMEOUT");
    // Session tokens and all user data remain in place. Apply exactly the
    // inserted migrations, then re-number the already-applied identical SQL.
    for (const migration of pending) {
      for (const statement of migration.sql) if (statement.trim()) await client.query(statement);
      await client.query(`INSERT INTO ${TABLE} (hash, created_at) VALUES ($1, $2)`, [migration.hash, migration.folderMillis]);
    }
    await client.query(`UPDATE ${TABLE} SET created_at = $1 WHERE hash = $2 AND created_at = $3`,
      [migrations[273].folderMillis, LEGACY_PREDECESSORS_HASH, LEGACY_PREDECESSORS_WHEN]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
