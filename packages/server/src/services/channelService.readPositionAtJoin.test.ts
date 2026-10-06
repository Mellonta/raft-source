import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { createMessage, getAgentResumeCatchupMessages } from "./messageService";
import { addAgent, addHuman, getAgentUnreadCounts, recordThreadFollow } from "./channelService";
import { getDb } from "../db/index";
import { agentChannelReadCursors, agents, channels, serverMembers, servers, threadFollows, userChannelReadCursors, users } from "../db/schema";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";

async function seed(db: ReturnType<typeof getDb>, label: string) {
  const [owner] = await db.insert(users).values({
    email: `${label}-owner@test.com`,
    name: `${label}Owner`,
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [joiner] = await db.insert(users).values({
    email: `${label}-joiner@test.com`,
    name: `${label}Joiner`,
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: label, slug: label, ownerId: owner.id }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: joiner.id, role: "member" },
  ]);
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: `${label}-agent`, status: "active" }).returning();
  const [channel] = await db.insert(channels).values({ serverId: server.id, name: `${label}-room`, type: "channel" }).returning();
  return { owner, joiner, server, agent, channel };
}

test("joining a channel starts the read position at its latest message, for agents and humans alike", async ({ db }) => {
  const { owner, joiner, agent, channel } = await seed(db, "join-position");
  await createMessage(channel.id, "user", owner.id, "history one");
  const latest = await createMessage(channel.id, "user", owner.id, "history two");

  assert.equal(await addAgent(channel.id, agent.id), true);
  assert.equal(await addHuman(channel.id, joiner.id), true);

  const [agentCursor] = await db.select().from(agentChannelReadCursors).where(and(
    eq(agentChannelReadCursors.agentId, agent.id),
    eq(agentChannelReadCursors.channelId, channel.id),
  ));
  const [humanCursor] = await db.select().from(userChannelReadCursors).where(and(
    eq(userChannelReadCursors.userId, joiner.id),
    eq(userChannelReadCursors.channelId, channel.id),
  ));
  assert.equal(agentCursor.lastReadSeq, latest.seq);
  assert.equal(humanCursor.lastReadSeq, latest.seq);
  // Clients drop read-state updates whose version does not advance past what they hold.
  assert.equal(agentCursor.readStateVersion, 1);
  assert.equal(humanCursor.readStateVersion, 1);

  assert.deepEqual(await getAgentUnreadCounts(agent.id, await referenceAgentInboxChain(agent.id)), {});
  await createMessage(channel.id, "user", owner.id, "after joining");
  assert.deepEqual(await getAgentUnreadCounts(agent.id, await referenceAgentInboxChain(agent.id)), { [`#${channel.name}`]: 1 });
});

test("a follow started by a message leaves that message unread; an active follow keeps its position", async ({ db }) => {
  const { owner, agent, channel } = await seed(db, "follow-position");
  const parent = await createMessage(channel.id, "user", owner.id, "parent");
  const [thread] = await db.insert(channels).values({
    serverId: channel.serverId,
    name: "follow-position-thread",
    type: "thread",
    parentMessageId: parent.id,
  }).returning();
  await createMessage(thread.id, "user", owner.id, "before the mention");
  const mention = await createMessage(thread.id, "user", owner.id, "mentions the agent");

  const cursor = async () => (await db.select().from(agentChannelReadCursors).where(and(
    eq(agentChannelReadCursors.agentId, agent.id),
    eq(agentChannelReadCursors.channelId, thread.id),
  )))[0]?.lastReadSeq;

  await recordThreadFollow("agent", agent.id, thread.id, parent.id, "mentioned", { joinedThroughSeq: mention.seq - 1 });
  assert.equal(await cursor(), mention.seq - 1);

  // Already following: a later mention must not mark the unread before it as read.
  const later = await createMessage(thread.id, "user", owner.id, "mentions the agent again");
  await recordThreadFollow("agent", agent.id, thread.id, parent.id, "mentioned", {
    reactivateUnfollowed: true,
    joinedThroughSeq: later.seq - 1,
  });
  assert.equal(await cursor(), mention.seq - 1);
});

test("the message that started a follow is recovered on resume even though the follow row is newer", async ({ db }) => {
  const { owner, agent, channel } = await seed(db, "trigger-recovery");
  await addAgent(channel.id, agent.id);
  const parent = await createMessage(channel.id, "user", owner.id, "parent");
  const [thread] = await db.insert(channels).values({
    serverId: channel.serverId,
    name: "trigger-recovery-thread",
    type: "thread",
    parentMessageId: parent.id,
  }).returning();
  const mention = await createMessage(thread.id, "user", owner.id, "@agent come look");
  await recordThreadFollow("agent", agent.id, thread.id, parent.id, "mentioned", { joinedThroughSeq: mention.seq - 1 });
  // In production the follow row is written ~100ms after the message that caused it.
  await db.update(threadFollows).set({ createdAt: new Date(mention.createdAt.getTime() + 100) })
    .where(and(eq(threadFollows.threadChannelId, thread.id), eq(threadFollows.followerId, agent.id)));

  const resume = await getAgentResumeCatchupMessages(agent.id, undefined, { chain: await referenceAgentInboxChain(agent.id) });
  assert.ok(resume.messages.some((m) => m.message_id === mention.id), "the triggering mention must be recovered");
});
