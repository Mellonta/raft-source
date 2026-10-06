import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { closeDatabase, getDb, initDatabase } from "../db/index";
import { getRisingWavePool } from "../db/risingwave";
import * as schema from "../db/schema";
import {
  channels,
  messages,
  serverMembers,
  servers,
  threadFollows,
  users,
} from "../db/schema";
import { getFollowedThreads } from "./channelService";
import { installRisingWaveReadReferences, uninstallRisingWaveReadReferences } from "../test/risingWaveReadReference";

// B1-independent real-PG gate (does NOT borrow READ_MUTATION_* semantics).
// Hosted CI sets FOLLOWED_THREAD_RW_REAL_PG_URL + REQUIRED=1; missing URL with
// REQUIRED=1 must FAIL (not skip), so a silently-unwired gate cannot pass.
const REAL_PG_URL_ENV = "FOLLOWED_THREAD_RW_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.FOLLOWED_THREAD_RW_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

// The exact high-S seq (>2^53) that a JS number would round to ...992.
const HIGH_SEQ = "9007199254740993";
// A distinct high-S seq for the zero-reply parent-fallback path (proves the
// parent seq also survives byte-exact, not just the reply seq).
const HIGH_SEQ_PARENT = "9007199254740995";

function databaseUrlFor(adminUrl: string, databaseName: string, applicationName?: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, `${REAL_PG_URL_ENV} must be a PostgreSQL URL`);
  parsed.pathname = `/${databaseName}`;
  if (applicationName) parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z0-9_]+$/);
  return `"${identifier}"`;
}

// Minimal rw_followed_threads_v5 carrier (074): the columns the production
// reads select/join, both the active-path read (RISINGWAVE_FOLLOWED_THREADS_ROWS_SQL)
// and the stats replay read the legacy path uses. A plain PG table standing in
// for the RisingWave materialized view; the production query paths are unchanged.
const RW_V5_CARRIER_DDL = `
  CREATE TABLE rw_followed_threads_v5 (
    server_id varchar NOT NULL,
    user_id varchar NOT NULL,
    thread_channel_id varchar NOT NULL,
    storage_thread_channel_id varchar,
    reply_count int,
    unread_count int,
    latest_seq bigint,
    latest_message_id varchar,
    last_reply_at timestamp,
    latest_preview text,
    latest_sender_type varchar,
    latest_sender_id varchar,
    first_unread_message_id varchar,
    parent_message_id varchar,
    parent_channel_id varchar,
    parent_server_id varchar,
    parent_preview text,
    parent_sender_type varchar,
    parent_sender_id varchar,
    parent_seq bigint,
    parent_created_at timestamptz,
    task_id varchar,
    task_number int,
    task_status varchar,
    task_claimed_by_type varchar,
    task_claimed_by_id varchar,
    joint_projection boolean,
    joint_parent_channel_id varchar
  )
`;

test(
  "production getFollowedThreads reads latestActivitySeq byte-exact from a real PG rw_followed_threads_v5 carrier",
  {
    skip: !(REAL_PG_URL || REAL_PG_REQUIRED),
  },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_b1_followed_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "b1-followed-admin" });
    await admin.connect();
    const prevRwUrl = process.env.RISINGWAVE_DATABASE_URL;
    let carrier: pg.Client | null = null;
    let carrierDbName: string | null = null;
    try {
      // Main app database (production schema + data).
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const migrationUrl = databaseUrlFor(REAL_PG_URL, databaseName, "b1-followed-migrator");
      const migrationPool = new pg.Pool({ connectionString: migrationUrl, max: 2 });
      await migrate(drizzle(migrationPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await migrationPool.end();

      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName, "b1-followed-service");
      await initDatabase(testUrl);

      // Seed a user/server/thread follow + parent message so getFollowedThreads
      // has a followed thread to project stats onto.
      const [owner] = await getDb().insert(users).values({
        email: `b1-followed-${randomUUID()}@test.invalid`,
        name: `B1Followed${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        passwordHash: "x",
        emailVerified: true,
      }).returning();
      const [server] = await getDb().insert(servers).values({
        name: "B1 Followed",
        slug: `b1-followed-${randomUUID()}`,
        ownerId: owner.id,
      }).returning();
      await getDb().insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
      const [parentChannel] = await getDb().insert(channels).values({
        serverId: server.id,
        name: "parent",
        type: "channel",
      }).returning();
      const [parentMessage] = await getDb().insert(messages).values({
        channelId: parentChannel.id,
        senderType: "user",
        senderId: owner.id,
        content: "parent message",
        seq: 1,
      }).returning();
      const [threadChannel] = await getDb().insert(channels).values({
        serverId: server.id,
        name: "thread",
        type: "thread",
        parentMessageId: parentMessage.id,
      }).returning();
      await getDb().insert(threadFollows).values({
        threadChannelId: threadChannel.id,
        followerType: "user",
        followerId: owner.id,
        parentMessageId: parentMessage.id,
        reason: "authored",
      });

      // A ZERO-reply thread: its parent message carries a high-S seq, and the
      // thread has no replies, so the frontier must fall back to the parent
      // (id + seq) same-source — never parent id + NULL seq.
      const [parentMessage2] = await getDb().insert(messages).values({
        channelId: parentChannel.id,
        senderType: "user",
        senderId: owner.id,
        content: "parent message 2",
        seq: sql`${HIGH_SEQ_PARENT}::bigint`,
      }).returning();
      const [zeroReplyThreadChannel] = await getDb().insert(channels).values({
        serverId: server.id,
        name: "thread-zero-reply",
        type: "thread",
        parentMessageId: parentMessage2.id,
      }).returning();
      await getDb().insert(threadFollows).values({
        threadChannelId: zeroReplyThreadChannel.id,
        followerType: "user",
        followerId: owner.id,
        parentMessageId: parentMessage2.id,
        reason: "authored",
      });

      // Sidecar carrier database standing in for RisingWave.
      carrierDbName = `slock_b1_carrier_${process.pid}_${randomBytes(4).toString("hex")}`;
      await admin.query(`CREATE DATABASE ${quoteIdentifier(carrierDbName)}`);
      const carrierUrl = databaseUrlFor(REAL_PG_URL, carrierDbName, "b1-followed-carrier");
      carrier = new pg.Client({ connectionString: carrierUrl });
      await carrier.connect();
      const latestMessageId = randomUUID();
      await carrier.query(RW_V5_CARRIER_DDL);
      const v5Insert = `INSERT INTO rw_followed_threads_v5 (
          server_id, user_id, thread_channel_id, storage_thread_channel_id,
          reply_count, unread_count, latest_seq, latest_message_id, last_reply_at,
          latest_preview, latest_sender_type, latest_sender_id, first_unread_message_id,
          parent_message_id, parent_channel_id, parent_server_id, parent_preview,
          parent_sender_type, parent_sender_id, parent_seq, parent_created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`;
      await carrier.query(v5Insert, [
        server.id, owner.id, threadChannel.id, threadChannel.id,
        1, 1, HIGH_SEQ, latestMessageId, new Date("2026-07-30T00:00:00.000Z"),
        "reply preview", "user", owner.id, latestMessageId,
        parentMessage.id, parentChannel.id, server.id, parentMessage.content,
        "user", owner.id, String(parentMessage.seq), parentMessage.createdAt,
      ]);
      await carrier.query(v5Insert, [
        server.id, owner.id, zeroReplyThreadChannel.id, zeroReplyThreadChannel.id,
        0, 0, null, null, null,
        null, null, null, null,
        parentMessage2.id, parentChannel.id, server.id, parentMessage2.content,
        "user", owner.id, HIGH_SEQ_PARENT, parentMessage2.createdAt,
      ]);
      // Point production RW pool at the sidecar carrier, and take the installed
      // test reference away so the production RW query path runs.
      process.env.RISINGWAVE_DATABASE_URL = carrierUrl;
      uninstallRisingWaveReadReferences();

      // Legacy path first: its stats replay read is also served by v4.
      const followed = await getFollowedThreads(server.id, owner.id, undefined, { forceLegacyPath: true });
      const row = followed.find((t) => t.threadChannelId === threadChannel.id);
      assert.ok(row, "followed thread must be returned");
      // Byte-exact: the same tuple (latest_message_id + latest_seq) read back
      // through the production RW query path, no JS number rounding.
      assert.equal(row.latestActivityMessageId, latestMessageId);
      assert.equal(row.latestActivitySeq, HIGH_SEQ, "latestActivitySeq must be byte-exact high-S");

      // Zero-reply thread: the frontier must fall back to the PARENT message,
      // paired same-source (parent id + parent seq), never parent id + NULL seq.
      const zeroReplyRow = followed.find((t) => t.threadChannelId === zeroReplyThreadChannel.id);
      assert.ok(zeroReplyRow, "zero-reply followed thread must be returned");
      assert.equal(zeroReplyRow.latestActivityMessageId, parentMessage2.id, "zero-reply falls back to the parent message id");
      assert.equal(zeroReplyRow.latestActivitySeq, HIGH_SEQ_PARENT, "zero-reply falls back to the parent seq byte-exact, never NULL");
      // Now the RW path: it must read the same tuples byte-exact.
      const viaV4 = await getFollowedThreads(server.id, owner.id, undefined);
      const v4Row = viaV4.find((t) => t.threadChannelId === threadChannel.id);
      assert.ok(v4Row, "followed thread must be returned on the RW path");
      assert.equal(v4Row.latestActivityMessageId, latestMessageId);
      assert.equal(v4Row.latestActivitySeq, HIGH_SEQ, "v4: latestActivitySeq must be byte-exact high-S");
      const v4ZeroReply = viaV4.find((t) => t.threadChannelId === zeroReplyThreadChannel.id);
      assert.ok(v4ZeroReply, "zero-reply followed thread must be returned on the RW path");
      assert.equal(v4ZeroReply.latestActivityMessageId, parentMessage2.id);
      assert.equal(v4ZeroReply.latestActivitySeq, HIGH_SEQ_PARENT, "v4: zero-reply parent seq byte-exact");
      assert.equal(v4ZeroReply.lastActivityAt, parentMessage2.createdAt.toISOString(), "parent_created_at round-trips to the legacy ISO string");
      assert.deepEqual(
        [...viaV4].sort((a, b) => a.threadChannelId.localeCompare(b.threadChannelId)),
        [...followed].sort((a, b) => a.threadChannelId.localeCompare(b.threadChannelId)),
        "the RW path equals the legacy path on the same carrier data",
      );
    } finally {
      // Restore env FIRST so a later getRisingWavePool() in this process does
      // not hand back the carrier pool, then end that pool (it stays connected
      // to the carrier even on assertion failure, which would otherwise hang
      // the test process and block DROP DATABASE).
      if (prevRwUrl === undefined) delete process.env.RISINGWAVE_DATABASE_URL;
      else process.env.RISINGWAVE_DATABASE_URL = prevRwUrl;
      installRisingWaveReadReferences();
      const rwPool = getRisingWavePool();
      if (rwPool) await rwPool.end().catch(() => undefined);
      if (carrier) await carrier.end().catch(() => undefined);
      await closeDatabase();
      if (carrierDbName) {
        await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [carrierDbName],
        ).catch(() => undefined);
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(carrierDbName)}`).catch(() => undefined);
      }
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [databaseName],
      ).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`).catch(() => undefined);
      await admin.end();
    }
  },
);
