import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { createMessage } from "./messageService";
import { getOrCreateThread } from "./channelService";
import { channels, messages, servers, users } from "../db/schema";

// getOrCreateThread runs on every thread resolution. Stamping the parent's
// thread_id must write the row only when the value changes: a no-op UPDATE
// still creates a new row version, and a non-HOT one re-inserts the parent
// into every messages index, including the full-text GIN pending list.
test("resolving an existing thread does not rewrite the parent message row", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "thread-id-sync@test.com", name: "threadIdSync", passwordHash: "x", emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: "Thread Id Sync", slug: "thread-id-sync", ownerId: owner.id }).returning();
  const [channel] = await db.insert(channels).values({ serverId: server.id, name: "tis-room", type: "channel" }).returning();
  const parent = await createMessage(channel.id, "user", owner.id, "thread parent");

  const rowVersion = async () => {
    const result = await db.execute(sql`SELECT xmin::text AS xmin, thread_id FROM messages WHERE id = ${parent.id}`);
    return result.rows[0] as { xmin: string; thread_id: string | null };
  };

  const created = await getOrCreateThread(parent.id, owner.id, "user");
  const afterCreate = await rowVersion();
  assert.equal(afterCreate.thread_id, created.id, "creating the thread stamps the parent's thread_id");

  const resolved = await getOrCreateThread(parent.id, owner.id, "user");
  assert.equal(resolved.id, created.id);
  assert.equal((await rowVersion()).xmin, afterCreate.xmin, "resolving an existing thread must not write the parent row");

  // A parent whose thread_id is missing (or stale) is still repaired.
  await db.update(messages).set({ threadId: null }).where(eq(messages.id, parent.id));
  await getOrCreateThread(parent.id, owner.id, "user");
  assert.equal((await rowVersion()).thread_id, created.id, "a missing thread_id is re-stamped");
});

// Creating a thread and stamping its parent's thread_id are one transaction:
// if the stamp fails (a timeout, a crash), no thread channel may survive
// without its parent pointing at it.
test("a failed thread_id stamp rolls back the new thread channel", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "thread-id-atomic@test.com", name: "threadIdAtomic", passwordHash: "x", emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: "Thread Id Atomic", slug: "thread-id-atomic", ownerId: owner.id }).returning();
  const [channel] = await db.insert(channels).values({ serverId: server.id, name: "tia-room", type: "channel" }).returning();
  const parent = await createMessage(channel.id, "user", owner.id, "thread parent");

  await db.execute(sql`
    CREATE FUNCTION reject_thread_id_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.thread_id IS DISTINCT FROM OLD.thread_id THEN RAISE EXCEPTION 'injected thread_id stamp failure'; END IF;
      RETURN NEW;
    END $$`);
  await db.execute(sql`CREATE TRIGGER reject_thread_id_stamp BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION reject_thread_id_stamp()`);
  try {
    await assert.rejects(getOrCreateThread(parent.id, owner.id, "user"), /Failed query: update "messages" set "thread_id"/);
    const threads = await db.select({ id: channels.id }).from(channels).where(eq(channels.parentMessageId, parent.id));
    assert.deepEqual(threads, [], "the thread channel must not be committed without its parent's thread_id");
  } finally {
    await db.execute(sql`DROP TRIGGER reject_thread_id_stamp ON messages`);
    await db.execute(sql`DROP FUNCTION reject_thread_id_stamp()`);
  }

  const created = await getOrCreateThread(parent.id, owner.id, "user");
  const [row] = await db.select({ threadId: messages.threadId }).from(messages).where(eq(messages.id, parent.id));
  assert.equal(row.threadId, created.id, "once the stamp succeeds, thread and thread_id commit together");
});
