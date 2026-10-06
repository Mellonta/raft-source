import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "vitest";
import { assertThreadParentChannelIndexReady } from "../../scripts/channels-thread-parent-channel-index";

// idx_channels_thread_parent_channel is built concurrently outside the
// transactional Drizzle migration (same contract as 0236 / 0248 / 0293).
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readServerFile(relativePath: string) {
  return readFile(path.join(SERVER_ROOT, relativePath), "utf8");
}

test("0298 keeps the thread parent-channel index out of drizzle migrate", async () => {
  const migration = await readServerFile("drizzle/0298_channels_thread_parent_channel_index.sql");
  assert.equal(migration.replace(/--.*$/gm, "").replace(/\s/g, ""), "SELECT1;");
});

test("snapshot declares the thread parent-channel partial index for future schema diffs", async () => {
  const snapshot = JSON.parse(await readServerFile("drizzle/meta/0298_snapshot.json"));
  const index = snapshot.tables["public.channels"].indexes.idx_channels_thread_parent_channel;
  assert.ok(index, "snapshot must declare idx_channels_thread_parent_channel");
  assert.deepEqual(index.columns.map((column: { expression: string }) => column.expression), ["parent_channel_id", "id"]);
  assert.equal(index.where, "type = 'thread' AND deleted_at IS NULL");
});

test("server package exposes concurrent thread parent-channel index create and verify scripts", async () => {
  const packageJson = JSON.parse(await readServerFile("package.json"));
  assert.equal(packageJson.scripts["db:create-channels-thread-parent-channel-index"], "node --import @oxc-node/core/register scripts/create-channels-thread-parent-channel-index.ts");
  assert.equal(packageJson.scripts["db:verify-channels-thread-parent-channel-index"], "node --import @oxc-node/core/register scripts/verify-channels-thread-parent-channel-index.ts");

  const helper = await readServerFile("scripts/channels-thread-parent-channel-index.ts");
  assert.match(helper, /CREATE INDEX CONCURRENTLY IF NOT EXISTS "\$\{THREAD_PARENT_CHANNEL_INDEX_NAME\}"/);
  assert.match(helper, /ON "channels" USING btree \("parent_channel_id", "id"\)/);
  assert.match(helper, /WHERE type = 'thread' AND deleted_at IS NULL/);
  assert.match(helper, /CHANNELS_THREAD_PARENT_CHANNEL_INDEX_STATEMENT_TIMEOUT/);
  assert.match(helper, /CHANNELS_THREAD_PARENT_CHANNEL_INDEX_LOCK_TIMEOUT/);
  assert.match(helper, /indisvalid/);
  assert.match(helper, /indisready/);

  const create = await readServerFile("scripts/create-channels-thread-parent-channel-index.ts");
  assert.match(create, /assertParentChannelColumnExists/);
  assert.match(create, /set_config\('statement_timeout'/);
  assert.match(create, /set_config\('lock_timeout'/);
});

test("the readiness check accepts exactly the built shape", () => {
  const ready = { exists: true, isUnique: false, isValid: true, isReady: true, columns: ["parent_channel_id", "id"], predicate: "((type = 'thread'::text) AND (deleted_at IS NULL))" };
  assert.doesNotThrow(() => assertThreadParentChannelIndexReady(ready));
  assert.throws(() => assertThreadParentChannelIndexReady({ ...ready, isValid: false }), /not ready\/valid/);
  assert.throws(() => assertThreadParentChannelIndexReady({ ...ready, columns: ["parent_channel_id"] }), /unexpected columns/);
  assert.throws(() => assertThreadParentChannelIndexReady({ ...ready, predicate: "(type = 'thread'::text)" }), /unexpected predicate/);
});
