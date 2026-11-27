import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { bridgeMellonta113, LEGACY_PREDECESSORS_WHEN, planMellontaMigrationBridge } from "./mellontaMigrationBridge";

const folder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const url = process.env.MELLONTA_MIGRATION_TEST_URL;

test.skipIf(!url)("1.13 migration reconciliation is atomic, preserves data, and admits the complete 1.21 journal", async () => {
  const client = new pg.Client({ connectionString: url, statement_timeout: 60_000 });
  const temporary = await mkdtemp(join(tmpdir(), "mellonta-113-"));
  try {
    await client.connect();
    assert.equal(await bridgeMellonta113(client, folder), false, "fresh database is unchanged");
    const journal = JSON.parse(await readFile(join(folder, "meta/_journal.json"), "utf8"));
    const oldEntries = [...journal.entries.slice(0, 266), { ...journal.entries[273], idx: 266, when: LEGACY_PREDECESSORS_WHEN }];
    await mkdir(join(temporary, "meta"));
    for (const entry of oldEntries) await copyFile(join(folder, `${entry.tag}.sql`), join(temporary, `${entry.tag}.sql`));
    await writeFile(join(temporary, "meta/_journal.json"), JSON.stringify({ ...journal, entries: oldEntries }));
    await migrate(drizzle(client), { migrationsFolder: temporary });
    await client.query("CREATE TABLE mellonta_persistence_probe (value text NOT NULL)");
    await client.query("INSERT INTO mellonta_persistence_probe VALUES ('retained')");
    const before = (await client.query('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows;
    assert.equal(before.length, 267);
    assert.throws(() => planMellontaMigrationBridge([...before, before[0]], readMigrationFiles({ migrationsFolder: folder })), /LEDGER_DIVERGED/);

    // Simulate a DDL failure after the first inserted migration, then prove the
    // entire reconciliation (including the journal) rolled back.
    for (const entry of journal.entries) await copyFile(join(folder, `${entry.tag}.sql`), join(temporary, `${entry.tag}.sql`));
    await writeFile(join(temporary, "meta/_journal.json"), JSON.stringify(journal));
    await writeFile(join(temporary, `${journal.entries[267].tag}.sql`), "SELECT deliberately_missing_bridge_function()");
    await assert.rejects(bridgeMellonta113(client, temporary));
    assert.deepEqual((await client.query('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows, before);
    assert.equal((await client.query("SELECT to_regclass('public.channel_conversion_fences') AS t")).rows[0].t, null);

    assert.equal(await bridgeMellonta113(client, folder), true);
    assert.equal(await bridgeMellonta113(client, folder), false, "repair is idempotent");
    await migrate(drizzle(client), { migrationsFolder: folder });
    const ledger = (await client.query('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    const expected = readMigrationFiles({ migrationsFolder: folder }).map(m => ({ hash: m.hash, created_at: String(m.folderMillis) }));
    assert.deepEqual(ledger, expected);
    assert.equal((await client.query("SELECT value FROM mellonta_persistence_probe")).rows[0].value, "retained");
    assert.equal((await client.query("SELECT to_regclass('public.session_token_predecessors') AS t")).rows[0].t, "session_token_predecessors");
    assert.equal(await bridgeMellonta113(client, folder), false);
  } finally {
    await client.end();
    await rm(temporary, { recursive: true, force: true });
  }
});
