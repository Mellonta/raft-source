import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// 0311 raises only search_vector's per-column statistics target; it must not
// run ANALYZE itself or touch the table's storage parameters (0181/0291/0302).
const migrationPath = new URL(
  "../../drizzle/0311_messages_search_vector_statistics.sql",
  import.meta.url,
);

test("0311 sets the search_vector statistics target and nothing else", async () => {
  const migration = await readFile(migrationPath, "utf8");
  const executableSql = migration.replace(/^\s*--.*$/gm, "").trim();
  assert.doesNotMatch(executableSql, /\b(?:VACUUM|ANALYZE|ALTER DATABASE)\b/i);
  assert.doesNotMatch(executableSql, /\bSET\s*\(/i, "storage parameters stay as 0181/0291/0302 set them");

  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE messages (id int PRIMARY KEY, content text, search_vector tsvector);
      ALTER TABLE messages SET (autovacuum_analyze_scale_factor = 0.02);
    `);
    await db.exec(migration);
    const columns = await db.query<{ attname: string; target: number | null }>(
      `SELECT attname, attstattarget AS target FROM pg_attribute
       WHERE attrelid = 'messages'::regclass AND attnum > 0 ORDER BY attnum`,
    );
    const target = (name: string) => columns.rows.find((row) => row.attname === name)?.target ?? null;
    assert.equal(target("search_vector"), 1000);
    assert.ok(target("content") === null || target("content") === -1, "other columns keep the default target");
    const options = await db.query<{ reloptions: string[] }>(`SELECT reloptions FROM pg_class WHERE relname = 'messages'`);
    assert.deepEqual(options.rows[0]?.reloptions, ["autovacuum_analyze_scale_factor=0.02"]);
  } finally {
    await db.close();
  }
});
