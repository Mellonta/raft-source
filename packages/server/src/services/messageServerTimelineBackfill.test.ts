import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { eq, sql, type SQL } from "drizzle-orm";
import { channels, messages, messageServerTimeline, servers, users } from "../db/schema";
import { runMessageServerTimelineBackfill, verifyMessageServerTimeline } from "./messageServerTimelineBackfill";

// Messages written before 0310 have no timeline row. The fixture recreates that
// state by inserting with the insert trigger disabled, then checks the verifier
// finds exactly those rows, the batched backfill fills them (leaving live
// trigger-written rows alone), and a re-run or a resumed run changes nothing.

test("message_server_timeline backfill fills pre-0310 messages in batches and the verifier gates on 0", async ({ db }) => {
  const run = async (query: SQL) => (await db.execute(query)).rows as Array<Record<string, unknown>>;
  const [owner] = await db.insert(users).values({ email: "mst-bf@test.com", name: "mstBf", passwordHash: "x", emailVerified: true }).returning();
  const [serverA, serverB] = await db.insert(servers).values([
    { name: "MST BF A", slug: "mst-bf-a", ownerId: owner!.id },
    { name: "MST BF B", slug: "mst-bf-b", ownerId: owner!.id },
  ]).returning();
  const [chanA, chanB] = await db.insert(channels).values([
    { serverId: serverA!.id, name: "mst-bf-a", type: "channel" },
    { serverId: serverB!.id, name: "mst-bf-b", type: "channel" },
  ]).returning();

  await db.execute(sql`ALTER TABLE messages DISABLE TRIGGER messages_server_timeline_insert`);
  const legacy = await db.insert(messages).values(
    Array.from({ length: 7 }, (_, i) => ({ channelId: i % 2 ? chanB!.id : chanA!.id, senderType: "user" as const, senderId: owner!.id, content: `legacy ${i}` })),
  ).returning();
  await db.execute(sql`ALTER TABLE messages ENABLE TRIGGER messages_server_timeline_insert`);
  // Written after 0310: the trigger already has it.
  const [live] = await db.insert(messages).values({ channelId: chanA!.id, senderType: "user", senderId: owner!.id, content: "live" }).returning();
  // A legacy message moved during the rollout: the update trigger upserts it now.
  await db.update(messages).set({ channelId: chanB!.id }).where(eq(messages.id, legacy[0]!.id));

  const before = await verifyMessageServerTimeline(run, { batchSize: 3 });
  assert.equal(before.missingRows, 6, "six legacy messages have no row; the moved one got its row from the update trigger");
  assert.equal(before.divergentRows, 0);

  const lines: string[] = [];
  const first = await runMessageServerTimelineBackfill(run, { batchSize: 2, sleepMs: 0, log: (line) => lines.push(line) });
  assert.equal(first.rowsInserted, 6);
  assert.equal(first.messagesScanned, 8, "every message is scanned once");
  assert.ok(first.batches >= 4);
  assert.equal(lines.length, first.batches);

  assert.deepEqual(await verifyMessageServerTimeline(run, { batchSize: 3 }), { missingRows: 0, divergentRows: 0, sampleIds: [] });
  for (const message of [...legacy, live!]) {
    const [row] = await db.select().from(messageServerTimeline).where(eq(messageServerTimeline.messageId, message.id));
    const [current] = await db.select().from(messages).where(eq(messages.id, message.id));
    assert.equal(row?.serverId, current!.channelId === chanA!.id ? serverA!.id : serverB!.id);
    assert.equal(row?.channelId, current!.channelId);
    assert.deepEqual(row?.createdAt, current!.createdAt);
  }

  const rerun = await runMessageServerTimelineBackfill(run, { batchSize: 2, sleepMs: 0 });
  assert.equal(rerun.rowsInserted, 0, "a re-run writes nothing");
  const resumed = await runMessageServerTimelineBackfill(run, { batchSize: 2, sleepMs: 0, afterId: first.lastId! });
  assert.deepEqual({ batches: resumed.batches, rowsInserted: resumed.rowsInserted }, { batches: 0, rowsInserted: 0 });

  // The verifier catches a row that went stale (e.g. a trigger disabled by hand).
  await db.execute(sql`UPDATE message_server_timeline SET server_id = ${serverB!.id} WHERE message_id = ${live!.id}`);
  const stale = await verifyMessageServerTimeline(run, { batchSize: 3 });
  assert.deepEqual({ missing: stale.missingRows, divergent: stale.divergentRows, sample: stale.sampleIds }, { missing: 0, divergent: 1, sample: [live!.id] });
});
