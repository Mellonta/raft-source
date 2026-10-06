// Followed-thread stats count unread with the unified chain's rule
// (rw_inbox_normal_v4 / rw_followed_threads_v4): not own sends, not system
// messages the user caused, not the noise subtypes; a NULL causal actor never
// excludes. Here the global test setup answers the RW reads from their Postgres
// references (rw_followed_threads_v4 rows for the active list, v3 stats for the
// rest), both on getFollowedThreadStatsFromPostgres, the same SQL that serves
// the activity-upper-bound gap.
import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { channels, messages, threadFollows } from "../db/schema";
import { getFollowedThreads } from "./channelService";

test("followed-thread unread excludes self-caused system messages and the noise subtypes; a peer's message counts", async ({ seed, db }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const [parent] = await db.insert(messages).values({
    channelId: channel.id, senderType: "user", senderId: peer.id, content: "parent",
  }).returning();
  const [thread] = await db.insert(channels).values({
    serverId: server.id, name: `thread-${parent.id.slice(0, 8)}`, type: "thread", parentMessageId: parent.id,
  }).returning();
  await db.insert(threadFollows).values({
    threadChannelId: thread.id, parentMessageId: parent.id, reason: "manual", followerType: "user", followerId: owner.id,
  });
  // Oldest first: the two excluded messages precede the counted one, so
  // firstUnreadMessageId also proves they are skipped.
  await db.insert(messages).values({
    channelId: thread.id, senderType: "user", senderId: "system", content: "owner did this",
    messageType: "system", causalActorType: "user", causalActorId: owner.id,
  });
  await db.insert(messages).values({
    channelId: thread.id, senderType: "user", senderId: "system", content: "task deleted",
    messageType: "system", systemSubtype: "task.deleted_summary",
  });
  const [peerReply] = await db.insert(messages).values({
    channelId: thread.id, senderType: "user", senderId: peer.id, content: "peer reply",
  }).returning();

  const threads = await getFollowedThreads(server.id, owner.id);
  const row = threads.find((t) => t.threadChannelId === thread.id);
  assert.ok(row, "the followed thread is listed");
  assert.equal(row.unreadCount, 1, "only the peer's message is unread");
  assert.equal(row.firstUnreadMessageId, peerReply.id);
  assert.equal(row.replyCount, 3, "reply count is every message in the thread, unfiltered");

  // A history cutoff does not change the numbers (they come from RW as-is).
  const cut = await getFollowedThreads(server.id, owner.id, new Date(0));
  assert.equal(cut.find((t) => t.threadChannelId === thread.id)?.unreadCount, 1);
});
