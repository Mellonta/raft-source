import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "vitest";
import { eq, sql, type SQL } from "drizzle-orm";
import { dbTest } from "../test/integration/dbTest";
import { makeLegacy, markReceipt } from "../test/messagesServerIdFixtures";
import { channels, messages, servers, users } from "../db/schema";
import { runMessagesServerIdBackfill, verifyMessagesServerId } from "./messagesServerIdBackfill";

// Rows written before 0317 have server_id NULL. The fixture recreates that
// state, spread over several heap pages, then checks the verifier finds exactly
// those rows, the page-range backfill fills them (including a migration receipt
// message), a stopped run resumes from its next page, a re-run writes nothing,
// and the verifier catches a wrong server.

dbTest("messages.server_id backfill fills pre-0317 rows by page range, stops and resumes, and the verifier gates on 0", async ({ db }) => {
  const run = async (query: SQL) => (await db.execute(query)).rows as Array<Record<string, unknown>>;
  const [owner] = await db.insert(users).values({ email: "msid-bf@test.com", name: "msidBf", passwordHash: "x", emailVerified: true }).returning();
  const [serverA, serverB] = await db.insert(servers).values([
    { name: "MSID BF A", slug: "msid-bf-a", ownerId: owner!.id },
    { name: "MSID BF B", slug: "msid-bf-b", ownerId: owner!.id },
  ]).returning();
  const [chanA, chanB] = await db.insert(channels).values([
    { serverId: serverA!.id, name: "msid-bf-a", type: "channel" },
    { serverId: serverB!.id, name: "msid-bf-b", type: "channel" },
  ]).returning();

  // ~1.5 KB of incompressible text per row: a few rows per 8 KB page.
  const legacy = await db.insert(messages).values(
    Array.from({ length: 16 }, (_, i) => ({
      channelId: i % 2 ? chanB!.id : chanA!.id, senderType: "user" as const, senderId: owner!.id,
      content: randomBytes(750).toString("hex"), searchText: `legacy word${i}`,
    })),
  ).returning();
  await makeLegacy(db, legacy.map((m) => m.id));
  await markReceipt(db, legacy[0]!, serverA!.id);
  // Written after 0317: the trigger already filled it.
  const [live] = await db.insert(messages).values({ channelId: chanA!.id, senderType: "user", senderId: owner!.id, content: "live" }).returning();
  assert.equal(live!.serverId, serverA!.id);

  const pages = Number((await run(sql`SELECT count(DISTINCT (ctid::text::point)[0])::int AS pages FROM messages WHERE id IN (${sql.join(legacy.map((m) => sql`${m.id}`), sql`, `)})`))[0]!.pages);
  assert.ok(pages >= 3, `legacy rows should span several pages, got ${pages}`);

  const before = await verifyMessagesServerId(run, { pagesPerSlice: 2 });
  assert.equal(before.missingRows, 16);
  assert.equal(before.divergentRows, 0);

  // Stop after two one-page batches (the operator's --stop-at), then resume.
  let allowed = 2;
  const lines: string[] = [];
  const stopped = await runMessagesServerIdBackfill(run, {
    pagesPerBatch: 1, sleepMs: 0, beforeBatch: async () => (allowed-- > 0 ? "continue" : "stop"), log: (line) => lines.push(line),
  });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.batches, 2);
  assert.equal(stopped.nextPage, 2);
  assert.match(lines[1]!, /next_page=2$/);
  const resumed = await runMessagesServerIdBackfill(run, { pagesPerBatch: 1, sleepMs: 0, fromPage: stopped.nextPage });
  assert.equal(resumed.stopped, false);
  assert.equal(resumed.nextPage, resumed.endPage);
  assert.equal(stopped.rowsUpdated + resumed.rowsUpdated, 16, "every legacy row exactly once across the stop, the live row untouched");

  const serverOf = new Map((await db.select({ id: messages.id, serverId: messages.serverId }).from(messages)).map((r) => [r.id, r.serverId]));
  for (const m of legacy) assert.equal(serverOf.get(m.id), m.channelId === chanA!.id ? serverA!.id : serverB!.id);
  assert.deepEqual(await verifyMessagesServerId(run, { pagesPerSlice: 2 }), { missingRows: 0, divergentRows: 0, sampleIds: [] });

  // VALIDATE now succeeds: the switch gate's final proof.
  await db.execute(sql`ALTER TABLE messages VALIDATE CONSTRAINT messages_server_id_not_null`);

  const again = await runMessagesServerIdBackfill(run, { pagesPerBatch: 4, sleepMs: 0 });
  const bounded = await runMessagesServerIdBackfill(run, { pagesPerBatch: 1, sleepMs: 0, fromPage: 1, toPage: 2 });
  assert.deepEqual([bounded.batches, bounded.nextPage, bounded.endPage], [1, 2, 2], "--to-page bounds a trial run");
  assert.equal(again.rowsUpdated, 0, "a re-run writes nothing");

  // A wrong server (not a trigger path, but the verifier must catch it).
  await db.update(messages).set({ serverId: serverB!.id }).where(eq(messages.id, legacy[2]!.id));
  const wrong = await verifyMessagesServerId(run, { pagesPerSlice: 2 });
  assert.equal(wrong.divergentRows, 1);
  assert.deepEqual(wrong.sampleIds, [legacy[2]!.id]);
});

test("a batch that hits lock_timeout is retried in place, and gives up after maxLockRetries", async () => {
  const lockError = Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }) });
  let updates = 0;
  let failuresLeft = 2;
  const run = async (query: SQL) => {
    const text = JSON.stringify(query);
    if (text.includes("pg_relation_size")) return [{ pages: 3 }];
    updates += 1;
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw lockError;
    }
    return [{ updated: 5 }];
  };
  const result = await runMessagesServerIdBackfill(run, { pagesPerBatch: 1, sleepMs: 0 });
  assert.equal(result.lockRetries, 2);
  assert.equal(result.batches, 3);
  assert.equal(result.rowsUpdated, 15);
  assert.equal(updates, 5);

  failuresLeft = Number.POSITIVE_INFINITY;
  await assert.rejects(runMessagesServerIdBackfill(run, { pagesPerBatch: 1, sleepMs: 0, maxLockRetries: 1 }), /Failed query/);
  // Any other error fails the run immediately.
  const other = async (query: SQL) => {
    if (JSON.stringify(query).includes("pg_relation_size")) return [{ pages: 1 }];
    throw new Error("boom");
  };
  await assert.rejects(runMessagesServerIdBackfill(other, { sleepMs: 0 }), /boom/);
});
