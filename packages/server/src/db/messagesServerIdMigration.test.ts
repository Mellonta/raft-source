import assert from "node:assert/strict";
import { eq, inArray, sql } from "drizzle-orm";
import { dbTest } from "../test/integration/dbTest";
import { makeLegacy, markReceipt, rejectsWithPg, type Db } from "../test/messagesServerIdFixtures";
import { channels, messages, servers, users } from "./schema";

// messages.server_id (0317) is derived from the channel by triggers. Rows that
// existed before 0317 are NULL until the operator backfill reaches them; the
// NOT VALID check already holds every inserted or updated row to NOT NULL.

async function fixture(db: Db, tag: string) {
  const [owner] = await db.insert(users).values({ email: `msid-${tag}@test.com`, name: `msid${tag}`, passwordHash: "x", emailVerified: true }).returning();
  const [serverA, serverB] = await db.insert(servers).values([
    { name: `MSID A ${tag}`, slug: `msid-a-${tag}`, ownerId: owner!.id },
    { name: `MSID B ${tag}`, slug: `msid-b-${tag}`, ownerId: owner!.id },
  ]).returning();
  const [chanA, chanB] = await db.insert(channels).values([
    { serverId: serverA!.id, name: `msid-a-${tag}`, type: "channel" },
    { serverId: serverB!.id, name: `msid-b-${tag}`, type: "channel" },
  ]).returning();
  return { owner: owner!, serverA: serverA!, serverB: serverB!, chanA: chanA!, chanB: chanB! };
}

const serverIdOf = async (db: Db, id: string) => (await db.select({ serverId: messages.serverId }).from(messages).where(eq(messages.id, id)))[0]?.serverId;

dbTest("server_id follows the channel's server on insert and on a channel move, and is never left NULL by an update", async ({ db }) => {
  const { owner, serverA, serverB, chanA, chanB } = await fixture(db, "trig");
  const [message] = await db.insert(messages).values({ channelId: chanA.id, senderType: "user", senderId: owner.id, content: "hi", searchText: "hi" }).returning();
  assert.equal(message!.serverId, serverA.id, "insert derives it from the channel");

  // A writer cannot store a server that disagrees with the channel.
  const [forged] = await db.insert(messages).values({ channelId: chanA.id, serverId: serverB.id, senderType: "user", senderId: owner.id, content: "x" }).returning();
  assert.equal(forged!.serverId, serverA.id);

  await db.update(messages).set({ channelId: chanB.id }).where(eq(messages.id, message!.id));
  assert.equal(await serverIdOf(db, message!.id), serverB.id, "a channel move re-derives it");

  // A pre-0317 row: any app update fills it (and so passes the NOT VALID check)
  // instead of failing, even if the backfill has not reached it yet.
  await makeLegacy(db, [message!.id]);
  assert.equal(await serverIdOf(db, message!.id), null);
  await db.update(messages).set({ content: "edited" }).where(eq(messages.id, message!.id));
  assert.equal(await serverIdOf(db, message!.id), serverB.id);

  // The check holds new and updated rows to NOT NULL (shown with the fill trigger off).
  await db.execute(sql`ALTER TABLE messages DISABLE TRIGGER messages_server_id_update`);
  try {
    await rejectsWithPg(db.execute(sql`UPDATE messages SET server_id = NULL WHERE id = ${message!.id}`), /messages_server_id_not_null/);
  } finally {
    await db.execute(sql`ALTER TABLE messages ENABLE TRIGGER messages_server_id_update`);
  }
});

dbTest("receipt messages accept only the backfill's server_id fill", async ({ db }) => {
  const { owner, serverA, serverB, chanA } = await fixture(db, "rcpt");
  const [receipt] = await db.insert(messages).values({ channelId: chanA.id, senderType: "agent", senderId: owner.id, content: "migrated", searchText: "migrated" }).returning();
  await makeLegacy(db, [receipt!.id]);
  await markReceipt(db, receipt!, serverA.id);

  // Other columns stay immutable, alone or together with the fill.
  await rejectsWithPg(db.update(messages).set({ content: "changed" }).where(eq(messages.id, receipt!.id)), /receipt message is immutable/);
  await rejectsWithPg(db.update(messages).set({ serverId: serverA.id, content: "changed" }).where(eq(messages.id, receipt!.id)), /receipt message is immutable/);
  await rejectsWithPg(db.update(messages).set({ serverId: serverA.id, searchText: "changed" }).where(eq(messages.id, receipt!.id)), /receipt message is immutable/);
  // A fill with the wrong server is rejected.
  await rejectsWithPg(db.update(messages).set({ serverId: serverB.id }).where(eq(messages.id, receipt!.id)), /receipt message is immutable/);
  assert.equal(await serverIdOf(db, receipt!.id), null);

  // The backfill's statement shape succeeds.
  await db.execute(sql`UPDATE messages m SET server_id = c.server_id FROM channels c WHERE m.id = ${receipt!.id} AND c.id = m.channel_id`);
  assert.equal(await serverIdOf(db, receipt!.id), serverA.id);

  // Once filled, nothing more is allowed, including a second fill or a delete.
  await rejectsWithPg(db.update(messages).set({ serverId: serverA.id }).where(eq(messages.id, receipt!.id)), /receipt message is immutable/);
  await rejectsWithPg(db.delete(messages).where(eq(messages.id, receipt!.id)), /receipt message is immutable/);
});
