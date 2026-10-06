import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { closeDatabase, initDatabase } from "../db/index";
import * as schema from "../db/schema";
import { getOrCreateThread } from "./channelService";

// Slack inbound creates a root's canonical thread by locking the root message
// FOR UPDATE and then INSERT ... ON CONFLICT DO NOTHING into channels. Raft's
// getOrCreateThread inserted the thread first: its uncommitted
// idx_channels_active_thread_parent entry made inbound's insert wait on it,
// while its parent_message_id FK share on the root waited on inbound's
// FOR UPDATE: 40P01. getOrCreateThread now queues on the root row first.

const REAL_PG_URL_ENV = "CHANNEL_CONVERSION_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.CHANNEL_CONVERSION_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

function databaseUrlFor(adminUrl: string, databaseName: string, applicationName?: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, `${REAL_PG_URL_ENV} must be a PostgreSQL URL`);
  parsed.pathname = `/${databaseName}`;
  if (applicationName) parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}

async function bounded<T>(promise: Promise<T>, label: string, ms = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test.skipIf(!REAL_PG_URL && !REAL_PG_REQUIRED)(
  "Raft thread creation queues on the root behind Slack inbound's thread creation instead of deadlocking",
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_thread_root_lock_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "thread-root-lock-admin" });
    const clients: pg.Client[] = [];
    let databaseOpen = false;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const setupPool = new pg.Pool({ connectionString: databaseUrlFor(REAL_PG_URL, databaseName), max: 1 });
      setupPool.on("error", () => {});
      try {
        await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      } finally {
        await setupPool.end();
      }

      const connect = async (applicationName?: string) => {
        const client = new pg.Client({ connectionString: databaseUrlFor(REAL_PG_URL, databaseName, applicationName) });
        client.on("error", () => {});
        await client.connect();
        clients.push(client);
        return client;
      };
      const setup = await connect();
      const ownerId = randomUUID();
      const serverId = randomUUID();
      const channelId = randomUUID();
      const rootId = randomUUID();
      await setup.query(
        `INSERT INTO users (id, email, name, password_hash, email_verified) VALUES ($1::uuid, $1::text || '@trl.test', 'trl-' || $1::text, 'x', true)`,
        [ownerId],
      );
      await setup.query(`INSERT INTO servers (id, name, slug, owner_id) VALUES ($1::uuid, 'trl', 'trl-' || $1::text, $2)`, [serverId, ownerId]);
      await setup.query(`INSERT INTO channels (id, server_id, name, type) VALUES ($1, $2, 'trl-channel', 'channel')`, [channelId, serverId]);
      await setup.query(
        `INSERT INTO messages (id, channel_id, sender_type, sender_id, content, message_type) VALUES ($1, $2, 'user', $3, 'root', 'chat')`,
        [rootId, channelId, ownerId],
      );

      const raftApplication = `trl-raft-${process.pid}`;
      await initDatabase(databaseUrlFor(REAL_PG_URL, databaseName, raftApplication));
      databaseOpen = true;
      const inbound = await connect("trl-inbound");
      const observer = await connect();

      // Inbound holds the root, as resolveTargetChannel does before creating the thread.
      await inbound.query("BEGIN");
      await inbound.query("SET LOCAL lock_timeout = '10s'");
      await inbound.query("SELECT id FROM messages WHERE id = $1 FOR UPDATE", [rootId]);

      const raft = getOrCreateThread(rootId, ownerId, "user");
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await observer.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
          [raftApplication],
        );
        if (waiting.rowCount) break;
        assert.ok(Date.now() < deadline, "Raft thread creation never queued behind inbound's root lock");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // Inbound now creates the canonical thread; it must not wait on Raft.
      const inboundThreadId = randomUUID();
      const inserted = await bounded(inbound.query(
        `INSERT INTO channels (id, server_id, name, type, parent_message_id)
         VALUES ($1, $2, 'thread-inbound', 'thread', $3)
         ON CONFLICT DO NOTHING RETURNING id`,
        [inboundThreadId, serverId, rootId],
      ), "inbound thread insert while Raft waits");
      assert.equal(inserted.rowCount, 1, "inbound creates the thread");
      await inbound.query("UPDATE messages SET thread_id = $1 WHERE id = $2", [inboundThreadId, rootId]);
      await inbound.query("COMMIT");

      const thread = await bounded(raft, "Raft getOrCreateThread");
      assert.equal(thread.id, inboundThreadId);
      assert.equal(thread.created, false);
      const threads = await observer.query(
        "SELECT id FROM channels WHERE parent_message_id = $1 AND type = 'thread' AND deleted_at IS NULL",
        [rootId],
      );
      assert.equal(threads.rowCount, 1);
    } finally {
      for (const client of clients) {
        await client.query("ROLLBACK").catch(() => {});
        await client.end().catch(() => {});
      }
      if (databaseOpen) await closeDatabase().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  },
  60_000,
);
