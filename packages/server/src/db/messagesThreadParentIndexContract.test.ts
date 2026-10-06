import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "vitest";

// idx_messages_channel_thread_parent was built concurrently outside the
// transactional Drizzle migration (0293) and is dropped the same way (0309):
// DROP INDEX CONCURRENTLY cannot run inside the migrator's transaction.
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readServerFile(relativePath: string) {
  return readFile(path.join(SERVER_ROOT, relativePath), "utf8");
}

const stripSql = (sql: string) => sql.replace(/--.*$/gm, "").replace(/\s/g, "");

test("0293 and 0309 keep the thread-parent index out of drizzle migrate", async () => {
  assert.equal(stripSql(await readServerFile("drizzle/0293_messages_channel_thread_parent_index.sql")), "SELECT1;");
  assert.equal(stripSql(await readServerFile("drizzle/0309_messages_drop_channel_thread_parent_index.sql")), "SELECT1;");
});

test("snapshot no longer declares the thread-parent index", async () => {
  const snapshot = JSON.parse(await readServerFile("drizzle/meta/0309_snapshot.json"));
  assert.equal(snapshot.tables["public.messages"].indexes.idx_messages_channel_thread_parent, undefined);
});

test("server package exposes concurrent thread-parent index drop and verify scripts", async () => {
  const packageJson = JSON.parse(await readServerFile("package.json"));
  assert.equal(packageJson.scripts["db:drop-messages-thread-parent-index"], "node --import @oxc-node/core/register scripts/drop-messages-thread-parent-index.ts");
  assert.equal(packageJson.scripts["db:verify-messages-thread-parent-index-dropped"], "node --import @oxc-node/core/register scripts/verify-messages-thread-parent-index-dropped.ts");

  const helper = await readServerFile("scripts/messages-thread-parent-index.ts");
  assert.match(helper, /DROP INDEX CONCURRENTLY IF EXISTS "\$\{THREAD_PARENT_INDEX_NAME\}"/);
  assert.match(helper, /MESSAGES_THREAD_PARENT_INDEX_STATEMENT_TIMEOUT/);
  assert.match(helper, /MESSAGES_THREAD_PARENT_INDEX_LOCK_TIMEOUT/);

  const drop = await readServerFile("scripts/drop-messages-thread-parent-index.ts");
  assert.match(drop, /set_config\('statement_timeout'/);
  assert.match(drop, /set_config\('lock_timeout'/);
  assert.doesNotMatch(drop, /BEGIN|transaction\(/);
});
