import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// 0291 lowers only the messages vacuum thresholds; the analyze settings from
// 0181 must survive, and the migration must not run VACUUM itself.
const migrationPath = new URL(
  "../../drizzle/0291_messages_autovacuum_thresholds.sql",
  import.meta.url,
);

test("0291 sets the messages vacuum thresholds and keeps the analyze settings", async () => {
  const migration = await readFile(migrationPath, "utf8");
  const executableSql = migration.replace(/^\s*--.*$/gm, "").trim();
  assert.doesNotMatch(executableSql, /\b(?:VACUUM|ANALYZE|ALTER DATABASE)\b/i);

  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE messages (id int PRIMARY KEY);
      ALTER TABLE messages SET (autovacuum_analyze_scale_factor = 0.05, autovacuum_analyze_threshold = 10000);
    `);
    await db.exec(migration);
    const result = await db.query<{ reloptions: string[] }>(
      `SELECT reloptions FROM pg_class WHERE relname = 'messages'`,
    );
    assert.deepEqual([...(result.rows[0]?.reloptions ?? [])].sort(), [
      "autovacuum_analyze_scale_factor=0.05",
      "autovacuum_analyze_threshold=10000",
      "autovacuum_vacuum_insert_scale_factor=0.02",
      "autovacuum_vacuum_scale_factor=0.02",
    ]);
  } finally {
    await db.close();
  }
});
