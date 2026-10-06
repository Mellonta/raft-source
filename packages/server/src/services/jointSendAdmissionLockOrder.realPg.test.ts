import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "../db/schema";
import {
  __resetOrdinaryMessageOutboundAuthorizationResolverForTests,
  __setOrdinaryMessageOutboundAuthorizationResolverForTests,
  lockOrdinaryMessageExternalDeliveryAdmission,
} from "./externalDeliveryOutboxService";
import { recordInboxNotificationFacts, type InboxNotificationFactInput } from "./inboxNotificationService";

// Prod 40P01 (messages.agent_send_transaction): two agents on two Servers reply
// concurrently in one Joint thread. Each send transaction first takes the
// Slack Bridge admission lock on its local parent, its own local thread
// projection and the canonical thread, then writes inbox facts for followers on
// EVERY projection, whose source_channel_id foreign key takes FOR KEY SHARE on
// the other Server's local thread row. With the admission lock at FOR UPDATE,
// A (holding T_A and T_c) waited on B's T_B while B (holding T_B) waited on
// T_c: a deadlock cycle. FOR NO KEY UPDATE keeps admission serialized but lets
// the foreign-key share through, so the second sender just queues on T_c.

const REAL_PG_URL_ENV = "CHANNEL_CONVERSION_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.CHANNEL_CONVERSION_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const ELIGIBLE = { eligible: true } as const;

function databaseUrlFor(adminUrl: string, databaseName: string, applicationName?: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, `${REAL_PG_URL_ENV} must be a PostgreSQL URL`);
  parsed.pathname = `/${databaseName}`;
  if (applicationName) parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
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

afterEach(() => {
  __resetOrdinaryMessageOutboundAuthorizationResolverForTests();
});

test.skipIf(!REAL_PG_URL && !REAL_PG_REQUIRED)(
  "concurrent sends into one Joint thread from two Servers queue on admission instead of deadlocking",
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_joint_send_admission_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "joint-send-admission-admin" });
    const pools: pg.Pool[] = [];
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const setupPool = new pg.Pool({ connectionString: databaseUrlFor(REAL_PG_URL, databaseName), max: 1 });
      pools.push(setupPool);
      setupPool.on("error", () => {}); // DROP DATABASE ... WITH (FORCE) terminates idle clients
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });

      const ownerId = randomUUID();
      const serverA = randomUUID();
      const serverB = randomUUID();
      const parentA = randomUUID();
      const parentB = randomUUID();
      const canonicalThread = randomUUID();
      const threadA = randomUUID();
      const threadB = randomUUID();
      await setupPool.query(
        `INSERT INTO users (id, email, name, password_hash, email_verified) VALUES ($1::uuid, $1::text || '@jsa.test', 'jsa-' || $1::text, 'x', true)`,
        [ownerId],
      );
      await setupPool.query(
        `INSERT INTO servers (id, name, slug, owner_id) VALUES ($1::uuid, 'jsa-a', 'jsa-a-' || $1::text, $3), ($2::uuid, 'jsa-b', 'jsa-b-' || $2::text, $3)`,
        [serverA, serverB, ownerId],
      );
      await setupPool.query(
        `INSERT INTO channels (id, server_id, name, type) VALUES
           ($1, $6, 'jsa-parent-a', 'joint'),
           ($2, $7, 'jsa-parent-b', 'joint'),
           ($3, $6, 'jsa-canonical-thread', 'thread'),
           ($4, $6, 'jsa-thread-a', 'thread'),
           ($5, $7, 'jsa-thread-b', 'thread')`,
        [parentA, parentB, canonicalThread, threadA, threadB, serverA, serverB],
      );

      // Admission is a no-op until an outbound runtime is installed; prod has one.
      __setOrdinaryMessageOutboundAuthorizationResolverForTests(async () => null);

      const sender = (name: string) => {
        const pool = new pg.Pool({ connectionString: databaseUrlFor(REAL_PG_URL, databaseName, name), max: 1 });
        pools.push(pool);
        pool.on("error", () => {}); // DROP DATABASE ... WITH (FORCE) terminates idle clients
        return drizzle(pool, { schema });
      };
      const applicationA = `jsa-sender-a-${process.pid}`;
      const applicationB = `jsa-sender-b-${process.pid}`;
      const dbA = sender(applicationA);
      const dbB = sender(applicationB);

      // One Joint-thread send, in the order messageService runs it: admission,
      // source insert into the canonical thread, then inbox facts for followers
      // on every projection (the other Server's local thread included).
      const jointThreadSend = async (
        db: typeof dbA,
        local: { serverId: string; parentId: string; threadId: string },
        afterInsert: () => Promise<void>,
      ) => db.transaction(async (tx) => {
        await tx.execute("SET LOCAL lock_timeout = '10s'");
        await lockOrdinaryMessageExternalDeliveryAdmission({
          executor: tx,
          authorityChannelId: local.parentId,
          requestedChannelId: local.threadId,
          canonicalConversationId: canonicalThread,
          decision: ELIGIBLE,
        });
        const [message] = await tx.insert(schema.messages).values({
          channelId: canonicalThread,
          senderType: "agent",
          senderId: randomUUID(),
          content: `from ${local.serverId}`,
          messageType: "chat",
        }).returning();
        await afterInsert();
        const facts: InboxNotificationFactInput[] = [
          { serverId: serverA, sourceChannelId: threadA },
          { serverId: serverB, sourceChannelId: threadB },
        ].map((projection) => ({
          receiverType: "agent",
          receiverId: randomUUID(),
          serverId: projection.serverId,
          kind: "thread",
          sourceChannelId: projection.sourceChannelId,
          messageId: message!.id,
          messageSeq: message!.seq,
          activityAt: message!.createdAt,
          personalMention: false,
          unreadEligible: true,
        }));
        await recordInboxNotificationFacts(facts, tx);
        return message!.id;
      });

      const aInserted = deferred();
      const releaseA = deferred();
      const sendA = jointThreadSend(dbA, { serverId: serverA, parentId: parentA, threadId: threadA }, async () => {
        aInserted.resolve();
        await releaseA.promise;
      });
      await bounded(aInserted.promise, "sender A admission and insert");

      // B takes its parent and its own local thread, then queues on the
      // canonical thread A holds.
      const sendB = jointThreadSend(dbB, { serverId: serverB, parentId: parentB, threadId: threadB }, async () => {});
      const observer = new pg.Client({ connectionString: databaseUrlFor(REAL_PG_URL, databaseName) });
      await observer.connect();
      try {
        const deadline = Date.now() + 10_000;
        for (;;) {
          const waiting = await observer.query(
            "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
            [applicationB],
          );
          if (waiting.rowCount) break;
          assert.ok(Date.now() < deadline, "sender B never queued behind sender A's admission");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        await observer.end();
      }

      // A now writes the fact whose foreign key points at B's local thread.
      releaseA.resolve();
      const [messageA, messageB] = await bounded(Promise.all([sendA, sendB]), "both Joint-thread sends");
      assert.notEqual(messageA, messageB);

      const check = new pg.Client({ connectionString: databaseUrlFor(REAL_PG_URL, databaseName) });
      await check.connect();
      const committed = await check.query(
        "SELECT count(*)::int AS n FROM inbox_notification_facts WHERE message_id = ANY($1::uuid[])",
        [[messageA, messageB]],
      ).finally(() => check.end());
      assert.equal(committed.rows[0].n, 4, "both sends committed facts for both projections");
    } finally {
      for (const pool of pools) await pool.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  },
  60_000,
);
