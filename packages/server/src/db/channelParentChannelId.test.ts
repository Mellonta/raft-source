import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq, inArray, sql } from "drizzle-orm";
import { channels, messages, servers, users } from "./schema";

// channels.parent_channel_id is derived data owned by the 0297 triggers: for a
// thread, the channel its parent message currently lives in; NULL otherwise.
// These cases cover every way the derived value can change: thread writes,
// parent-message moves (channel conversion and its rollback), and direct
// writes of the column itself.

test("0297 derives parent_channel_id on every thread write and parent-message move", async ({ db }) => {
  const [owner] = await db.insert(users).values({ email: "pcid-owner@test.com", name: "pcidOwner", passwordHash: "x", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "Parent Channel", slug: "pcid-server", ownerId: owner.id }).returning();
  const [source, joint, other] = await db.insert(channels).values([
    { serverId: server.id, name: "pcid-source", type: "channel" },
    { serverId: server.id, name: "pcid-joint", type: "joint" },
    { serverId: server.id, name: "pcid-other", type: "channel" },
  ]).returning();
  const [parent, sibling] = await db.insert(messages).values([
    { channelId: source.id, senderType: "user", senderId: owner.id, content: "parent" },
    { channelId: source.id, senderType: "user", senderId: owner.id, content: "not a parent" },
  ]).returning();
  const parentChannelOf = async (id: string) =>
    (await db.select({ value: channels.parentChannelId }).from(channels).where(eq(channels.id, id)))[0]!.value;

  const [thread] = await db.insert(channels).values({ serverId: server.id, name: "pcid-thread", type: "thread", parentMessageId: parent.id }).returning();
  assert.equal(thread.parentChannelId, source.id, "insert derives it from the parent message");
  assert.equal(source.parentChannelId, null, "non-threads stay NULL");
  const [projection] = await db.insert(channels).values({ serverId: server.id, name: "pcid-projection", type: "thread" }).returning();
  assert.equal(projection.parentChannelId, null, "a thread without a parent message (joint projection) stays NULL");
  const [lying] = await db.insert(channels).values({ serverId: server.id, name: "pcid-lying", type: "thread", parentMessageId: parent.id, parentChannelId: other.id, deletedAt: new Date() }).returning();
  assert.equal(lying.parentChannelId, source.id, "an explicit value on insert is replaced by the derived one");

  // Conversion moves the parent into the joint channel; rollback moves it back.
  await db.update(messages).set({ channelId: joint.id }).where(eq(messages.id, parent.id));
  assert.equal(await parentChannelOf(thread.id), joint.id, "moving the parent message moves its thread");
  assert.equal(await parentChannelOf(lying.id), joint.id, "every thread row on that parent follows, deleted ones included");
  await db.update(messages).set({ channelId: source.id }).where(inArray(messages.id, [parent.id, sibling.id]));
  assert.equal(await parentChannelOf(thread.id), source.id, "a multi-row move back restores it");

  // Conversion detaches local threads (parent_message_id NULL) and rollback
  // reattaches them, in either order relative to the parent move.
  await db.update(channels).set({ parentMessageId: null }).where(eq(channels.id, thread.id));
  assert.equal(await parentChannelOf(thread.id), null, "detaching the parent clears it");
  await db.update(messages).set({ channelId: joint.id }).where(eq(messages.id, parent.id));
  await db.update(channels).set({ parentMessageId: parent.id }).where(eq(channels.id, thread.id));
  assert.equal(await parentChannelOf(thread.id), joint.id, "reattaching derives the parent's current channel");
  await db.update(messages).set({ channelId: source.id }).where(eq(messages.id, parent.id));
  assert.equal(await parentChannelOf(thread.id), source.id);

  await db.update(channels).set({ parentChannelId: other.id }).where(eq(channels.id, thread.id));
  assert.equal(await parentChannelOf(thread.id), source.id, "a direct write cannot store a wrong value");
  await db.update(channels).set({ type: "channel", parentMessageId: null }).where(eq(channels.id, projection.id));
  assert.equal(await parentChannelOf(projection.id), null);

  // Guards: unrelated updates on either table do not touch the thread row.
  const version = async () => (await db.execute(sql`SELECT xmin::text AS v FROM channels WHERE id = ${thread.id}`)).rows[0]!.v;
  const before = await version();
  await db.update(messages).set({ content: "edited" }).where(eq(messages.id, parent.id));
  await db.update(messages).set({ channelId: source.id }).where(eq(messages.id, parent.id));
  assert.equal(await version(), before, "message updates that keep channel_id never rewrite the thread row");
  await db.update(channels).set({ name: "pcid-thread-renamed" }).where(eq(channels.id, thread.id));
  assert.equal(await parentChannelOf(thread.id), source.id, "unrelated channel updates keep the value");
});

test("0297 guards both triggers so unrelated updates skip them", () => {
  const migration = readFileSync(new URL("../../drizzle/0297_channels_parent_channel_id.sql", import.meta.url), "utf8");
  assert.match(migration, /AFTER UPDATE OF "channel_id" ON "messages"\s+FOR EACH ROW\s+WHEN \(OLD\."channel_id" IS DISTINCT FROM NEW\."channel_id"\)/);
  assert.match(migration, /BEFORE UPDATE OF "parent_message_id", "type", "parent_channel_id" ON "channels"\s+FOR EACH ROW\s+WHEN \(/);
  assert.doesNotMatch(migration, /REFERENCES/, "parent_channel_id is a cached fact, not a foreign key");
});
