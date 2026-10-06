import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// 0290 must switch the message full-text GIN index to fastupdate=off in place.
// drizzle-kit renders an index option change as DROP INDEX + CREATE INDEX,
// which on prod would rebuild a multi-GB index inside the deploy migration.
const migrationPath = new URL(
  "../../drizzle/0290_messages_search_gin_fastupdate_off.sql",
  import.meta.url,
);

test("0290 turns off GIN fastupdate without rebuilding the index", async () => {
  const migration = await readFile(migrationPath, "utf8");
  const executableSql = migration.replace(/^\s*--.*$/gm, "").trim();
  assert.equal(
    executableSql,
    `ALTER INDEX "idx_messages_search_vector_gin" SET (fastupdate = off);`,
    "the migration must be a single in-place ALTER INDEX",
  );

  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE messages (id int PRIMARY KEY, search_vector tsvector);
      CREATE INDEX "idx_messages_search_vector_gin" ON messages USING gin (search_vector);
    `);
    const before = await db.query<{ oid: number }>(
      `SELECT 'idx_messages_search_vector_gin'::regclass::oid AS oid`,
    );
    await db.exec(migration);
    const after = await db.query<{ oid: number; reloptions: string[] | null }>(
      `SELECT c.oid, c.reloptions FROM pg_class c WHERE c.relname = 'idx_messages_search_vector_gin'`,
    );
    assert.equal(after.rows[0]?.oid, before.rows[0]?.oid, "the index must be altered in place, not recreated");
    assert.deepEqual(after.rows[0]?.reloptions, ["fastupdate=off"]);
  } finally {
    await db.close();
  }
});
