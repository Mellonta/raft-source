// Mention arm v6 (infra/risingwave/sql/067-mention-v6.sql). For a joint (cross-
// server) conversation, message_mentions.channel_id is the SENDER's local
// projection while the message lives in canonical storage. rw_inbox_mention_v5
// keyed mentions by that raw id and dropped every one of them; v6 maps it to
// canonical storage first, then fans out to each receiver's own local projection,
// membership-gated. The Postgres mirrors of the chain (conversationUnreadReference,
// agentInboxChainReference) carry the same rule; these cases pin it.
import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import {
  agents,
  channelAgents,
  channelHumans,
  channels,
  inboxTargetMuteStates,
  jointChannels,
  jointChannelServers,
  messageMentions,
  messages,
  servers,
  users,
} from "../db/schema";
import type { Database } from "../db/index";
import { getInboxItems, getUnreadSummary } from "./channelService";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";

async function jointFixture(db: Database) {
  const [sender, receiver, outsider, owner] = await db.insert(users).values(
    ["sender", "receiver", "outsider", "owner"].map((name) => ({
      email: `joint-mention-v6-${name}@test.com`, name: `jm6${name}`, passwordHash: "x", emailVerified: true,
    })),
  ).returning();
  const [senderServer, receiverServer, storage] = await db.insert(servers).values([
    { name: "JM6 Sender", slug: "jm6-sender", ownerId: owner.id },
    { name: "JM6 Receiver", slug: "jm6-receiver", ownerId: owner.id },
    { name: "JM6 Storage", slug: "__jm6_storage__", ownerId: owner.id, kind: "joint_storage" },
  ]).returning();
  const [canonical, senderLocal, receiverLocal, plainPublic] = await db.insert(channels).values([
    { serverId: storage.id, name: "jm6-canonical", type: "joint" },
    { serverId: senderServer.id, name: "jm6-sender-local", type: "joint" },
    { serverId: receiverServer.id, name: "jm6-receiver-local", type: "joint" },
    { serverId: receiverServer.id, name: "jm6-plain-public", type: "channel" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id, createdByServerId: senderServer.id, createdByUserId: owner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint.id, serverId: senderServer.id, localChannelId: senderLocal.id, role: "host", status: "active", joinedByUserId: owner.id },
    { jointChannelId: joint.id, serverId: receiverServer.id, localChannelId: receiverLocal.id, role: "participant", status: "active", joinedByUserId: owner.id },
  ]);
  const [agent, mutedAgent, outsiderAgent] = await db.insert(agents).values([
    { serverId: receiverServer.id, name: "jm6-agent", status: "active" },
    { serverId: receiverServer.id, name: "jm6-muted-agent", status: "active" },
    { serverId: receiverServer.id, name: "jm6-outsider-agent", status: "active" },
  ]).returning();
  await db.insert(channelHumans).values([
    { channelId: senderLocal.id, userId: sender.id },
    { channelId: receiverLocal.id, userId: receiver.id },
    { channelId: plainPublic.id, userId: sender.id },
  ]);
  await db.insert(channelAgents).values([
    { channelId: receiverLocal.id, agentId: agent.id },
    { channelId: receiverLocal.id, agentId: mutedAgent.id },
  ]);
  return { sender, receiver, outsider, senderServer, receiverServer, canonical, senderLocal, receiverLocal, plainPublic, agent, mutedAgent, outsiderAgent };
}

type Target = { targetType: "user" | "agent"; targetId: string; notifiedAt?: Date };

/** A message stored in `storageChannelId`, its mention rows under `mentionChannelId` (as the send path writes them). */
async function sendWithMentions(
  db: Database,
  input: { storageChannelId: string; mentionChannelId: string; serverId: string; senderId: string; targets: Target[] },
) {
  const [message] = await db.insert(messages).values({
    channelId: input.storageChannelId, senderType: "user", senderId: input.senderId, content: "hey @you",
  }).returning();
  if (input.targets.length > 0) {
    await db.insert(messageMentions).values(input.targets.map((target) => ({
      messageId: message.id,
      messageSeq: message.seq,
      serverId: input.serverId,
      channelId: input.mentionChannelId,
      targetType: target.targetType,
      targetId: target.targetId,
      handleAtSendTime: "you",
      notifiableAtSend: target.notifiedAt === undefined,
      notifiedAt: target.notifiedAt ?? null,
    })));
  }
  return message;
}

test("a mention stored under the sender's projection surfaces on the receiver's own projection (sidebar and agent inbox, with mute pierce)", async ({ db }) => {
  const f = await jointFixture(db);
  const plain = await sendWithMentions(db, {
    storageChannelId: f.canonical.id, mentionChannelId: f.senderLocal.id, serverId: f.senderServer.id, senderId: f.sender.id, targets: [],
  });
  // The muted agent's mute starts after the plain message: the mention lies beyond its admitted stream.
  await db.insert(inboxTargetMuteStates).values({
    receiverType: "agent", receiverId: f.mutedAgent.id, serverId: f.receiverServer.id,
    sourceChannelId: f.receiverLocal.id, muteFromSeq: plain.seq + 1,
  });
  const mention = await sendWithMentions(db, {
    storageChannelId: f.canonical.id, mentionChannelId: f.senderLocal.id, serverId: f.senderServer.id, senderId: f.sender.id,
    targets: [
      { targetType: "user", targetId: f.receiver.id },
      { targetType: "agent", targetId: f.agent.id },
      { targetType: "agent", targetId: f.mutedAgent.id },
    ],
  });

  // Human sidebar, on the receiver's server and projection.
  const summary = await getUnreadSummary(f.receiverServer.id, f.receiver.id);
  assert.equal(summary[f.receiverLocal.id]?.unreadCount, 2);
  assert.equal(summary[f.receiverLocal.id]?.hasMention, true, "the joint mention lights the receiver's projection");
  assert.equal(summary[f.receiverLocal.id]?.hasAnyMention, true);
  assert.equal(summary[f.senderLocal.id], undefined, "never keyed on the sender's projection");
  assert.deepEqual(await getUnreadSummary(f.senderServer.id, f.receiver.id), {}, "nothing on a server where the receiver is not a member");

  // Agent inbox: the mention row is on the agent's own projection.
  const agentRow = (await referenceAgentInboxChain(f.agent.id)).find((row) => row.targetId === f.receiverLocal.id);
  assert.ok(agentRow, "the agent inbox offers the joint conversation");
  assert.equal(agentRow.storageChannelId, f.canonical.id);
  assert.equal(agentRow.mentionUnread, 1);
  assert.equal(agentRow.maxMentionSeq, mention.seq);
  assert.equal(agentRow.unreadCount, 2);

  // Muted agent: the admitted stream stops at the mute; the mention pierces it.
  const mutedRow = (await referenceAgentInboxChain(f.mutedAgent.id)).find((row) => row.targetId === f.receiverLocal.id);
  assert.ok(mutedRow, "a mention beyond the mute pierces it");
  assert.equal(mutedRow.unreadCount, 1, "only the pre-mute message is admitted");
  assert.equal(mutedRow.mentionUnread, 1);
  assert.equal(mutedRow.offeredUnread, 2, "admitted unread + the pierced mention");
  assert.equal(mutedRow.activitySeq, mention.seq);

  // Activity (the Postgres path; CI has no mirror of the serving view) agrees.
  const activity = await getInboxItems(f.receiverServer.id, f.receiver.id, { filter: "mentions" });
  assert.ok(
    activity.items.some((item) => item.kind === "channel" && item.channelId === f.receiverLocal.id && item.hasMention),
    "Activity mentions include the joint conversation on the receiver's projection",
  );
});

test("a notified mention does not surface on a joint projection the receiver is not a member of", async ({ db }) => {
  const f = await jointFixture(db);
  await sendWithMentions(db, {
    storageChannelId: f.canonical.id, mentionChannelId: f.senderLocal.id, serverId: f.senderServer.id, senderId: f.sender.id,
    targets: [
      { targetType: "user", targetId: f.outsider.id, notifiedAt: new Date() },
      { targetType: "agent", targetId: f.outsiderAgent.id, notifiedAt: new Date() },
    ],
  });
  // The same notified admission on an unprojected public channel still surfaces (mention-only).
  await sendWithMentions(db, {
    storageChannelId: f.plainPublic.id, mentionChannelId: f.plainPublic.id, serverId: f.receiverServer.id, senderId: f.sender.id,
    targets: [{ targetType: "user", targetId: f.outsider.id, notifiedAt: new Date() }],
  });

  const onReceiverServer = await getUnreadSummary(f.receiverServer.id, f.outsider.id);
  assert.equal(onReceiverServer[f.receiverLocal.id], undefined, "no mention on a projection the outsider cannot see");
  assert.equal(onReceiverServer[f.plainPublic.id]?.hasMention, true, "notified outsider admission still applies to unprojected channels");
  assert.equal(onReceiverServer[f.plainPublic.id]?.unreadCount, 0);
  const onSenderServer = await getUnreadSummary(f.senderServer.id, f.outsider.id);
  assert.equal(onSenderServer[f.senderLocal.id], undefined);
  assert.equal(
    (await referenceAgentInboxChain(f.outsiderAgent.id)).some((row) => row.targetId === f.receiverLocal.id || row.targetId === f.senderLocal.id),
    false,
  );
});
