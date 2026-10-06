import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "../db/schema";

// 0297's messages_parent_channel_id_follow trigger runs while a parent-message
// move (channel conversion, its rollback) holds the message row, then writes
// the thread row: message -> thread, the reverse of read-state resolution's
// thread -> parent message order. That is only safe because the trigger writes
// a non-key column (FOR NO KEY UPDATE), which never conflicts with the
// readers' FOR KEY SHARE. If parent_channel_id ever became a key column (a
// unique index or FK target on it) or the trigger locked the thread row
// harder, this order would close a deadlock cycle; these cases pin it.

const REAL_PG_URL_ENV = "CHANNEL_CONVERSION_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.CHANNEL_CONVERSION_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

function databaseUrlFor(adminUrl: string, databaseName: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, `${REAL_PG_URL_ENV} must be a PostgreSQL URL`);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

const LOCK_THREAD = "SELECT 1 FROM channels WHERE id = $1 FOR KEY SHARE";
const LOCK_PARENT = "SELECT 1 FROM messages WHERE id = $1 FOR KEY SHARE";
const MOVE_PARENT = "UPDATE messages SET channel_id = $2 WHERE id = $1";

test.skipIf(!REAL_PG_URL && !REAL_PG_REQUIRED)(
  "a parent-message move re-derives its thread without blocking readers' thread locks",
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_parent_channel_id_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "parent-channel-id-admin" });
    const clients: pg.Client[] = [];
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      const setupPool = new pg.Pool({ connectionString: testUrl, max: 1 });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });

      const ownerId = randomUUID();
      const serverId = randomUUID();
      const sourceId = randomUUID();
      const jointId = randomUUID();
      const parentId = randomUUID();
      const threadId = randomUUID();
      await setupPool.query(
        `INSERT INTO users (id, email, name, password_hash, email_verified) VALUES ($1::uuid, $1::text || '@pcid.test', 'pcid-' || $1::text, 'x', true)`,
        [ownerId],
      );
      await setupPool.query(`INSERT INTO servers (id, name, slug, owner_id) VALUES ($1::uuid, 'pcid', 'pcid-' || $1::text, $2)`, [serverId, ownerId]);
      await setupPool.query(
        `INSERT INTO channels (id, server_id, name, type) VALUES ($1, $3, 'pcid-source', 'channel'), ($2, $3, 'pcid-joint', 'joint')`,
        [sourceId, jointId, serverId],
      );
      await setupPool.query(
        `INSERT INTO messages (id, channel_id, sender_type, sender_id, content) VALUES ($1, $2, 'user', $3, 'parent')`,
        [parentId, sourceId, ownerId],
      );
      await setupPool.query(
        `INSERT INTO channels (id, server_id, name, type, parent_message_id) VALUES ($1, $2, 'pcid-thread', 'thread', $3)`,
        [threadId, serverId, parentId],
      );
      await setupPool.end();

      const connect = async (name: string) => {
        const client = new pg.Client({ connectionString: testUrl, application_name: name });
        await client.connect();
        clients.push(client);
        return client;
      };
      const reader = await connect("parent-channel-id-reader");
      const mover = await connect("parent-channel-id-mover");
      const parentChannel = async () =>
        (await reader.query<{ v: string | null }>("SELECT parent_channel_id::text AS v FROM channels WHERE id = $1", [threadId])).rows[0]!.v;
      assert.equal(await parentChannel(), sourceId);

      // 1. A reader already holds the thread row when the move arrives: the
      //    move and its trigger must complete without waiting on the reader.
      await reader.query("BEGIN");
      await reader.query(LOCK_THREAD, [threadId]);
      await mover.query("BEGIN");
      await mover.query("SET LOCAL lock_timeout = '500ms'");
      await assert.doesNotReject(
        mover.query(MOVE_PARENT, [parentId, jointId]),
        "the trigger's thread write must not wait on a reader's KEY SHARE",
      );
      await mover.query("COMMIT");
      await reader.query("COMMIT");
      assert.equal(await parentChannel(), jointId);

      // 2. A move is in flight (holding the parent message and, through the
      //    trigger, the thread row) when a reader starts: the reader still gets
      //    the thread row, and only its next lock, the parent message, waits on
      //    the mover, which is not waiting on it: a plain wait, not a cycle.
      await mover.query("BEGIN");
      await mover.query(MOVE_PARENT, [parentId, sourceId]);
      await reader.query("BEGIN");
      await reader.query("SET LOCAL lock_timeout = '500ms'");
      await assert.doesNotReject(
        reader.query(LOCK_THREAD, [threadId]),
        "a reader's thread lock must not wait on an in-flight parent move",
      );
      await assert.rejects(
        reader.query(LOCK_PARENT, [parentId]),
        (error: { code?: string }) => error.code === "55P03",
        "fixture: the moved parent message itself is held by the mover",
      );
      await reader.query("ROLLBACK");
      await mover.query("COMMIT");
      assert.equal(await parentChannel(), sourceId);
    } finally {
      for (const client of clients) await client.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  },
);
