import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "../db/schema";
import { __resolveExternalInboundTargetForTests } from "./externalInboundWorkerService";

// Slack inbound for a Joint thread reply resolves its target inside the commit
// transaction. It used to lock host parent -> canonical parent -> every parent
// projection FOR UPDATE, while a Raft Joint channel send locks its local
// parent -> canonical parent and then writes inbox facts whose foreign keys
// take FOR KEY SHARE on every Server's local parent. Two cycles followed:
//   A. send holds (local parent, canonical); inbound holds host parent FOR
//      UPDATE and waits on canonical; the send's fact FK needs the host parent.
//   B. inbound holds (host parent, canonical) and waits on the sender's local
//      parent; the sender holds that and waits on canonical.
// Inbound now locks FOR NO KEY UPDATE (no conflict with FK key shares) and
// takes every parent projection before the canonical parent, the send order.

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

async function waitUntilLockWaiting(observer: pg.Client, applicationName: string, label: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const waiting = await observer.query(
      "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
      [applicationName],
    );
    if (waiting.rowCount) return;
    assert.ok(Date.now() < deadline, `${label} never queued on a row lock`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test.skipIf(!REAL_PG_URL && !REAL_PG_REQUIRED)(
  "Slack inbound Joint thread resolution and a Raft Joint channel send queue instead of deadlocking",
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_inbound_joint_lock_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "inbound-joint-lock-admin" });
    const pools: pg.Pool[] = [];
    const clients: pg.Client[] = [];
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const setupPool = new pg.Pool({ connectionString: databaseUrlFor(REAL_PG_URL, databaseName), max: 1 });
      pools.push(setupPool);
      setupPool.on("error", () => {}); // DROP DATABASE ... WITH (FORCE) terminates idle clients
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });

      const ownerId = randomUUID();
      const hostServer = randomUUID();
      const peerServer = randomUUID();
      const storageServer = randomUUID();
      const hostParent = randomUUID();
      const peerParent = randomUUID();
      const canonicalParent = randomUUID();
      const jointId = randomUUID();
      await setupPool.query(
        `INSERT INTO users (id, email, name, password_hash, email_verified) VALUES ($1::uuid, $1::text || '@ijl.test', 'ijl-' || $1::text, 'x', true)`,
        [ownerId],
      );
      await setupPool.query(
        `INSERT INTO servers (id, name, slug, owner_id) VALUES
           ($1::uuid, 'ijl-host', 'ijl-host-' || $1::text, $4),
           ($2::uuid, 'ijl-peer', 'ijl-peer-' || $2::text, $4),
           ($3::uuid, 'ijl-storage', 'ijl-storage-' || $3::text, $4)`,
        [hostServer, peerServer, storageServer, ownerId],
      );
      await setupPool.query(
        `INSERT INTO channels (id, server_id, name, type) VALUES
           ($1, $4, 'ijl-host-parent', 'joint'),
           ($2, $5, 'ijl-peer-parent', 'joint'),
           ($3, $6, 'ijl-canonical', 'channel')`,
        [hostParent, peerParent, canonicalParent, hostServer, peerServer, storageServer],
      );
      await setupPool.query(
        `INSERT INTO joint_channels (id, canonical_channel_id, created_by_server_id, created_by_user_id, status)
         VALUES ($1, $2, $3, $4, 'active')`,
        [jointId, canonicalParent, hostServer, ownerId],
      );
      await setupPool.query(
        `INSERT INTO joint_channel_servers (joint_channel_id, server_id, local_channel_id, role, status, joined_by_user_id) VALUES
           ($1, $2, $3, 'host', 'active', $6),
           ($1, $4, $5, 'participant', 'active', $6)`,
        [jointId, hostServer, hostParent, peerServer, peerParent, ownerId],
      );

      const inboundApplication = `ijl-inbound-${process.pid}`;
      const senderApplication = `ijl-sender-${process.pid}`;
      const inboundPool = new pg.Pool({
        connectionString: databaseUrlFor(REAL_PG_URL, databaseName, inboundApplication),
        max: 1,
      });
      pools.push(inboundPool);
      inboundPool.on("error", () => {}); // DROP DATABASE ... WITH (FORCE) terminates idle clients
      const inboundDb = drizzle(inboundPool, { schema });
      const connect = async (applicationName?: string) => {
        const client = new pg.Client({ connectionString: databaseUrlFor(REAL_PG_URL, databaseName, applicationName) });
        client.on("error", () => {});
        await client.connect();
        clients.push(client);
        return client;
      };
      const sender = await connect(senderApplication);
      const observer = await connect();

      // The Slack binding event for a thread reply on the host's local parent.
      const event = {
        raftChannelId: hostParent,
        provider: "slack",
        installId: "install-ijl",
        providerAuthorityId: "authority-ijl",
        providerConversationId: "conversation-ijl",
        bindingId: "binding-ijl",
        bindingEpoch: 1,
        connectionEpoch: 1,
        privacyClass: "public",
      } as unknown as Parameters<typeof __resolveExternalInboundTargetForTests>[1];
      const payload = {
        providerThreadId: "provider-root-ijl",
      } as unknown as Parameters<typeof __resolveExternalInboundTargetForTests>[2];

      const inboundResolution = () => inboundDb.transaction(async (tx) => {
        await tx.execute("SET LOCAL lock_timeout = '10s'");
        // No accepted provider root is linked, so resolution returns null right
        // after its channel locks; the locks are what this test is about.
        return __resolveExternalInboundTargetForTests(tx, event, payload);
      });

      // The peer Server's Raft Joint channel send, as admission and the facts
      // write run it: local parent, canonical parent, then fact rows whose
      // source_channel_id is every Server's local parent. lockAsSend
      // deliberately keeps FOR UPDATE, the stricter pre-#8662 admission mode:
      // inbound's order must hold even against it (FOR NO KEY UPDATE, what
      // admission takes now, conflicts with strictly less).
      const lockAsSend = (channelId: string) =>
        sender.query("SELECT id FROM channels WHERE id = $1 FOR UPDATE", [channelId]);
      const writeFactsAsSend = async () => {
        const [{ id: messageId }] = (await sender.query(
          `INSERT INTO messages (id, channel_id, sender_type, sender_id, content, message_type)
           VALUES ($3, $1, 'agent', $2, 'peer send', 'chat') RETURNING id`,
          [canonicalParent, randomUUID(), randomUUID()],
        )).rows as Array<{ id: string }>;
        await sender.query(
          `INSERT INTO inbox_notification_facts
             (id, receiver_type, receiver_id, server_id, kind, source_channel_id, message_id, message_seq, activity_at)
           VALUES ($7, 'agent', $1, $2, 'channel', $3, $5, 1, now()), ($8, 'agent', $1, $4, 'channel', $6, $5, 1, now())`,
          [randomUUID(), hostServer, hostParent, peerServer, messageId, peerParent, randomUUID(), randomUUID()],
        );
      };

      // A. The send holds both of its admission rows; inbound queues on the
      //    canonical parent; the send's fact FK on the host parent must pass.
      await sender.query("BEGIN");
      await sender.query("SET LOCAL lock_timeout = '10s'");
      await lockAsSend(peerParent);
      await lockAsSend(canonicalParent);
      const inboundA = inboundResolution();
      await waitUntilLockWaiting(observer, inboundApplication, "inbound (A)");
      await bounded(writeFactsAsSend(), "send facts while inbound waits (A)");
      await sender.query("COMMIT");
      assert.equal(await bounded(inboundA, "inbound resolution (A)"), null);

      // B. The send holds only its local parent when inbound starts: inbound
      //    must queue there before taking the canonical parent, so the send can
      //    still take the canonical parent and finish.
      await sender.query("BEGIN");
      await sender.query("SET LOCAL lock_timeout = '10s'");
      await lockAsSend(peerParent);
      const inboundB = inboundResolution();
      await waitUntilLockWaiting(observer, inboundApplication, "inbound (B)");
      await bounded(lockAsSend(canonicalParent), "send canonical admission while inbound waits (B)");
      await bounded(writeFactsAsSend(), "send facts while inbound waits (B)");
      await sender.query("COMMIT");
      assert.equal(await bounded(inboundB, "inbound resolution (B)"), null);

      // C. The thread half. A linked provider root with an existing canonical
      //    thread and one local thread face per Server: the peer's Raft thread
      //    send holds its local parent and local thread; inbound resolves the
      //    thread and queues; the send takes the canonical thread and writes
      //    facts on the host's local thread; both commit, and inbound then
      //    locks the local threads and the canonical thread (with recheck).
      const rootId = randomUUID();
      const canonicalThread = randomUUID();
      const jointThreadId = randomUUID();
      const hostThread = randomUUID();
      const peerThread = randomUUID();
      const providerRootId = "provider-root-ijl-linked";
      await observer.query(
        `INSERT INTO messages (id, channel_id, sender_type, sender_id, content, message_type)
         VALUES ($1, $2, 'user', $3, 'linked root', 'chat')`,
        [rootId, canonicalParent, ownerId],
      );
      await observer.query(
        `INSERT INTO channels (id, server_id, name, type, parent_message_id) VALUES ($1, $2, 'ijl-canonical-thread', 'thread', $3)`,
        [canonicalThread, storageServer, rootId],
      );
      await observer.query("UPDATE messages SET thread_id = $1 WHERE id = $2", [canonicalThread, rootId]);
      await observer.query(
        `INSERT INTO channels (id, server_id, name, type) VALUES
           ($1, $3, 'ijl-host-thread', 'thread'),
           ($2, $4, 'ijl-peer-thread', 'thread')`,
        [hostThread, peerThread, hostServer, peerServer],
      );
      await observer.query(
        `INSERT INTO joint_channels (id, canonical_channel_id, created_by_server_id, created_by_user_id, status)
         VALUES ($1, $2, $3, $4, 'active')`,
        [jointThreadId, canonicalThread, hostServer, ownerId],
      );
      await observer.query(
        `INSERT INTO joint_channel_servers (joint_channel_id, server_id, local_channel_id, role, status, joined_by_user_id) VALUES
           ($1, $2, $3, 'host', 'active', $6),
           ($1, $4, $5, 'participant', 'active', $6)`,
        [jointThreadId, hostServer, hostThread, peerServer, peerThread, ownerId],
      );
      await observer.query(
        `INSERT INTO external_message_links
           (id, provider, install_id, provider_authority_id, provider_conversation_id, provider_message_id,
            binding_id, binding_epoch, connection_epoch, raft_message_id, first_direction,
            payload_fingerprint, outcome_state, authority_state)
         VALUES ($4, 'slack', 'install-ijl', 'authority-ijl', 'conversation-ijl', $1,
                 'binding-ijl', 1, 1, $2, 'provider_inbound', $3, 'accepted', 'active')`,
        [providerRootId, rootId, "a".repeat(64), randomUUID()],
      );
      const threadPayload = {
        providerThreadId: providerRootId,
      } as unknown as Parameters<typeof __resolveExternalInboundTargetForTests>[2];

      await sender.query("BEGIN");
      await sender.query("SET LOCAL lock_timeout = '10s'");
      await lockAsSend(peerParent);
      await lockAsSend(peerThread);
      const inboundC = inboundDb.transaction(async (tx) => {
        await tx.execute("SET LOCAL lock_timeout = '10s'");
        return __resolveExternalInboundTargetForTests(tx, event, threadPayload);
      });
      await waitUntilLockWaiting(observer, inboundApplication, "inbound (C)");
      await bounded(lockAsSend(canonicalThread), "send canonical thread admission while inbound waits (C)");
      await bounded((async () => {
        const messageId = randomUUID();
        await sender.query(
          `INSERT INTO messages (id, channel_id, sender_type, sender_id, content, message_type)
           VALUES ($1, $2, 'agent', $3, 'peer thread send', 'chat')`,
          [messageId, canonicalThread, randomUUID()],
        );
        await sender.query(
          `INSERT INTO inbox_notification_facts
             (id, receiver_type, receiver_id, server_id, kind, source_channel_id, message_id, message_seq, activity_at)
           VALUES ($1, 'agent', $2, $3, 'thread', $4, $5, 1, now()), ($6, 'agent', $2, $7, 'thread', $8, $5, 1, now())`,
          [randomUUID(), randomUUID(), hostServer, hostThread, messageId, randomUUID(), peerServer, peerThread],
        );
      })(), "send thread facts on the host's local thread while inbound waits (C)");
      await sender.query("COMMIT");
      const resolved = await bounded(inboundC, "inbound thread resolution (C)");
      assert.ok(resolved, "inbound must resolve the linked Joint thread");
      assert.equal(resolved.channel.id, canonicalThread);
      assert.equal(resolved.canonicalRootMessageId, rootId);
      assert.equal(resolved.jointThreadProjection?.localThreadChannelId, hostThread);
      assert.equal(resolved.jointThreadProjection?.canonicalThreadChannelId, canonicalThread);
    } finally {
      for (const client of clients) {
        await client.query("ROLLBACK").catch(() => {});
        await client.end().catch(() => {});
      }
      for (const pool of pools) await pool.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  },
  60_000,
);
