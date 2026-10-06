import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { Agent as HttpsAgent } from "node:https";

import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { and, eq, isNotNull } from "drizzle-orm";

import { getDb, isDatabaseInitialized } from "../db/index";
import {
  channels,
  featureFlags,
  inboxTargetMuteStates,
  messages,
  mobilePushOutbox,
  pushRegistrations,
  pushSubscriptions,
  sessionFamilies,
  sessions,
  serverMembers,
  servers,
  users,
} from "../db/schema";
import { recordInboxNotificationFacts } from "./inboxNotificationService";
import { __setActivityReadSourceForTests, getActivityReadSourceOverride } from "./activityReadSource";
import {
  ApnsDeliveryError,
  __resetApnsHttpClientForTests,
  __resetApnsPushProviderForTests,
  __resetMobilePushDeliveryRuntimeForTests,
  __resetWebPushRuntimeForTests,
  __setApnsHttpClientForTests,
  __setApnsPushProviderForTests,
  __setMobilePushDeliveryRuntimeForTests,
  __setWebPushRuntimeForTests,
  dispatchMobilePushForInboxFacts,
  drainMobilePushOutbox,
  ensureFamilyRevokeCapability,
  revokePushFamilyByCapability,
  sendPushToUsers,
  startMobilePushOutboxWorker,
  unbindPushInstallation,
  upsertPushRegistration,
  type ApnsDeliveryInput,
  type ApnsPushProvider,
} from "./pushService";
import { MOBILE_PUSH_DELIVERY_FEATURE_FLAG_KEY } from "./featureFlagService";
import { runWithTraceSpan } from "../tracing/semanticTrace";


process.env.JWT_SECRET ||= "push-service-test-secret";

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  attempts = 50,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

async function seedPushFixture() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "mobile-push-owner@test.com",
    name: "MobilePushOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [other] = await db.insert(users).values({
    email: "mobile-push-other@test.com",
    name: "MobilePushOther",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Mobile Push",
    slug: "mobile-push",
    ownerId: owner.id,
  }).returning();
  const [otherServer] = await db.insert(servers).values({
    name: "Other Mobile Push",
    slug: "other-mobile-push",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: otherServer.id, userId: owner.id, role: "owner" },
  ]);
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "general",
    type: "channel",
  }).returning();
  const [message] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: other.id,
    content: "hello",
    seq: 1,
  }).returning();
  const [mention] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: other.id,
    content: "hello @MobilePushOwner",
    seq: 2,
  }).returning();
  const [family] = await db.insert(sessionFamilies).values({ userId: owner.id }).returning();
  await db.insert(sessions).values({
    userId: owner.id,
    familyId: family.id,
    tokenHash: `token-${family.id}`,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return { owner, other, server, otherServer, channel, message, mention, family };
}

test("mobile push delivery consumes inbox eligibility and routes APNs by stored env", async ({ db }) => {

  const deliveries: ApnsDeliveryInput[] = [];
  const scheduled: (() => Promise<void>)[] = [];
  const provider: ApnsPushProvider = {
    async send(input) {
      deliveries.push(input);
      return { status: "sent" };
    },
  };
  __setApnsPushProviderForTests(provider);
  __setMobilePushDeliveryRuntimeForTests({
    schedule: (work) => {
      scheduled.push(work);
    },
    sleep: async () => {},
    jitterMs: () => 1,
  });
  try {
    const { owner, server, otherServer, channel, message, mention, family } = await seedPushFixture();
    await upsertPushRegistration({
      installationId: "eligible-install",
      provider: "apns",
      userId: owner.id,
      serverId: server.id,
      sessionFamilyId: family.id,
      deviceToken: "sandbox-token",
      topic: "ai.slock.app.dev",
      env: "sandbox",
    });
    await upsertPushRegistration({
      installationId: "other-server-install",
      provider: "apns",
      userId: owner.id,
      serverId: otherServer.id,
      sessionFamilyId: family.id,
      deviceToken: "prod-token",
      topic: "ai.slock.app",
      env: "production",
    });

    await getDb().insert(inboxTargetMuteStates).values({
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      sourceChannelId: channel.id,
      activityMuted: true,
      muteFromSeq: 1,
    });

    await recordInboxNotificationFacts([
      {
        receiverType: "user",
        receiverId: owner.id,
        serverId: server.id,
        kind: "channel",
        sourceChannelId: channel.id,
        messageId: message.id,
        messageSeq: message.seq,
        activityAt: new Date("2026-07-10T00:00:01.000Z"),
      },
    ]);
    assert.equal(scheduled.length, 0, "muted ordinary inbox activity should not enqueue APNs work");
    assert.equal(deliveries.length, 0, "muted ordinary inbox activity must not fan out to APNs");

    await recordInboxNotificationFacts([
      {
        receiverType: "user",
        receiverId: owner.id,
        serverId: server.id,
        kind: "channel",
        sourceChannelId: channel.id,
        messageId: mention.id,
        messageSeq: mention.seq,
        activityAt: new Date("2026-07-10T00:00:02.000Z"),
        personalMention: true,
      },
    ]);
    assert.equal(deliveries.length, 0, "provider must not run synchronously inside inbox fact recording");
    assert.equal(scheduled.length, 1, "eligible inbox activity should enqueue post-write APNs work");
    const [pendingOutbox] = await getDb().select().from(mobilePushOutbox).where(eq(mobilePushOutbox.messageId, mention.id));
    assert.equal(pendingOutbox?.status, "pending", "eligible mobile push work should be durable before scheduled drain runs");
    await Promise.all(scheduled.splice(0).map((work) => work()));

    assert.equal(deliveries.length, 2, "personal mention should pierce mute via inbox eligibility for all user-scoped installs");
    const [drainedOutbox] = await getDb().select().from(mobilePushOutbox).where(eq(mobilePushOutbox.messageId, mention.id));
    assert.equal(drainedOutbox?.status, "sent");
    assert.equal(drainedOutbox?.sentCount, 2);
    const deliveriesByInstallation = new Map(deliveries.map((delivery) => [delivery.installationId, delivery]));
    assert.equal(deliveriesByInstallation.get("eligible-install")?.env, "sandbox");
    assert.equal(deliveriesByInstallation.get("other-server-install")?.env, "production");
    for (const delivery of deliveries) {
      assert.deepEqual(delivery.payload, {
        serverId: server.id,
        channelId: channel.id,
        messageId: mention.id,
        kind: "channel",
        badge: 1,
        alertTitle: "#general · Mobile Push",
        alertBody: "MobilePushOther mentioned you: hello @MobilePushOwner",
      });
    }
  } finally {
    __resetApnsPushProviderForTests();
    __resetMobilePushDeliveryRuntimeForTests();
    await closeTestDatabase();
  }
});

test("mobile push fanout is user-scoped across server-bound registrations", async ({ db }) => {

  const deliveries: ApnsDeliveryInput[] = [];
  const scheduled: Promise<void>[] = [];
  const provider: ApnsPushProvider = {
    async send(input) {
      deliveries.push(input);
      return { status: "sent" };
    },
  };
  __setApnsPushProviderForTests(provider);
  __setMobilePushDeliveryRuntimeForTests({
    schedule: (work) => {
      scheduled.push(work());
    },
    sleep: async () => {},
    jitterMs: () => 1,
  });
  try {
    const { owner, other, server, otherServer, family } = await seedPushFixture();
    const [otherServerChannel] = await getDb().insert(channels).values({
      serverId: otherServer.id,
      name: "other-general",
      type: "channel",
    }).returning();
    const [otherServerMessage] = await getDb().insert(messages).values({
      channelId: otherServerChannel.id,
      senderType: "user",
      senderId: other.id,
      content: "cross-server hello",
      seq: 1,
    }).returning();

    await upsertPushRegistration({
      installationId: "server-a-install",
      provider: "apns",
      userId: owner.id,
      serverId: server.id,
      sessionFamilyId: family.id,
      deviceToken: "server-a-token",
      topic: "ai.slock.app",
      env: "production",
    });

    await recordInboxNotificationFacts([{
      receiverType: "user",
      receiverId: owner.id,
      serverId: otherServer.id,
      kind: "channel",
      sourceChannelId: otherServerChannel.id,
      messageId: otherServerMessage.id,
      messageSeq: otherServerMessage.seq,
      activityAt: new Date("2026-07-10T00:00:02.500Z"),
    }]);
    await Promise.all(scheduled.splice(0));

    assert.equal(deliveries.length, 1, "server B fact should reach user install originally registered under server A");
    assert.equal(deliveries[0].installationId, "server-a-install");
    assert.deepEqual(deliveries[0].payload, {
      serverId: otherServer.id,
      channelId: otherServerChannel.id,
      messageId: otherServerMessage.id,
      kind: "channel",
      badge: 1,
      alertTitle: "#other-general · Other Mobile Push",
      alertBody: "MobilePushOther: cross-server hello",
    });
  } finally {
    __resetApnsPushProviderForTests();
    __resetMobilePushDeliveryRuntimeForTests();
    await closeTestDatabase();
  }
});

test("a person on several servers of one joint channel gets one push per message", async ({ db }) => {
  const deliveries: ApnsDeliveryInput[] = [];
  const scheduled: Promise<void>[] = [];
  __setApnsPushProviderForTests({
    async send(input) {
      deliveries.push(input);
      return { status: "sent" };
    },
  });
  __setMobilePushDeliveryRuntimeForTests({
    schedule: (work) => {
      scheduled.push(work());
    },
    sleep: async () => {},
    jitterMs: () => 1,
  });
  try {
    const { owner, server, otherServer, channel, message, family } = await seedPushFixture();
    // The same joint channel as seen from the owner's other server.
    const [otherCopy] = await getDb().insert(channels).values({
      serverId: otherServer.id,
      name: "general",
      type: "channel",
    }).returning();
    await upsertPushRegistration({
      installationId: "joint-install",
      provider: "apns",
      userId: owner.id,
      serverId: server.id,
      sessionFamilyId: family.id,
      deviceToken: "joint-token",
      topic: "ai.slock.app",
      env: "production",
    });

    // One Activity fact per copy, all for the same canonical message.
    const facts = [channel, otherCopy].map((copy) => ({
      receiverType: "user" as const,
      receiverId: owner.id,
      serverId: copy.serverId,
      kind: "channel" as const,
      sourceChannelId: copy.id,
      messageId: message.id,
      messageSeq: message.seq,
      activityAt: new Date("2026-07-10T00:00:03.000Z"),
    }));
    await recordInboxNotificationFacts(facts);
    await Promise.all(scheduled.splice(0));
    // A retried enqueue of the same facts must not add a second push either.
    await recordInboxNotificationFacts(facts);
    await Promise.all(scheduled.splice(0));

    assert.equal(deliveries.length, 1, "one message must buzz the phone once, not once per joint copy");
    const outbox = await db.select().from(mobilePushOutbox).where(eq(mobilePushOutbox.receiverId, owner.id));
    assert.equal(outbox.length, 1);
  } finally {
    __resetApnsPushProviderForTests();
    __resetMobilePushDeliveryRuntimeForTests();
    await closeTestDatabase();
  }
});

test("the one joint push goes through a copy whose server push mode allows it", async ({ db }) => {
  const deliveries: ApnsDeliveryInput[] = [];
  const scheduled: Promise<void>[] = [];
  __setApnsPushProviderForTests({
    async send(input) {
      deliveries.push(input);
      return { status: "sent" };
    },
  });
  __setMobilePushDeliveryRuntimeForTests({
    schedule: (work) => {
      scheduled.push(work());
    },
    sleep: async () => {},
    jitterMs: () => 1,
  });
  try {
    const { owner, server, otherServer, channel, message, family } = await seedPushFixture();
    const [otherCopy] = await getDb().insert(channels).values({
      serverId: otherServer.id,
      name: "general",
      type: "channel",
    }).returning();
    // Silence the server whose copy would win the id tie-break.
    const [first, second] = [channel, otherCopy].sort((a, b) => (a.id < b.id ? -1 : 1));
    await db.update(serverMembers).set({ serverPushMode: "none" })
      .where(and(eq(serverMembers.userId, owner.id), eq(serverMembers.serverId, first!.serverId)));
    await upsertPushRegistration({
      installationId: "joint-mode-install",
      provider: "apns",
      userId: owner.id,
      serverId: server.id,
      sessionFamilyId: family.id,
      deviceToken: "joint-mode-token",
      topic: "ai.slock.app",
      env: "production",
    });

    await recordInboxNotificationFacts([first!, second!].map((copy) => ({
      receiverType: "user" as const,
      receiverId: owner.id,
      serverId: copy.serverId,
      kind: "channel" as const,
      sourceChannelId: copy.id,
      messageId: message.id,
      messageSeq: message.seq,
      activityAt: new Date("2026-07-10T00:00:04.000Z"),
    })));
    await Promise.all(scheduled.splice(0));

    assert.equal(deliveries.length, 1, "a silenced server must not swallow the push another server allows");
    assert.equal(deliveries[0].payload.channelId, second!.id);
  } finally {
    __resetApnsPushProviderForTests();
    __resetMobilePushDeliveryRuntimeForTests();
    await closeTestDatabase();
  }
});

test("mobile APNs uses the shared plain-text notification preview", async ({ db }) => {

  const deliveries: ApnsDeliveryInput[] = [];
  __setApnsPushProviderForTests({
    async send(input) {
      deliveries.push(input);
      return { status: "sent" };
    },
  });
  try {
    const { owner, server, channel, message, family } = await seedPushFixture();
    await getDb().update(messages).set({
      content: "## **hello** [team](https://raft.ai) 🚀",
    }).where(eq(messages.id, message.id));
    await upsertPushRegistration({
      installationId: "plain-preview-install",
      provider: "apns",
      userId: owner.id,
      serverId: server.id,
      sessionFamilyId: family.id,
      deviceToken: "plain-preview-token",
      topic: "ai.slock.app",
      env: "production",
    });

    const result = await dispatchMobilePushForInboxFacts([{
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "channel",
      sourceChannelId: channel.id,
      messageId: message.id,
      messageSeq: message.seq,
      activityAt: new Date("2026-07-10T00:00:02.750Z"),
    }]);

    assert.deepEqual(result, { attempted: 1, sent: 1, skipped: 0, revoked: 0, dropped: 0 });
    assert.equal(deliveries[0]?.payload.alertBody, "MobilePushOther: hello team 🚀");
  } finally {
    __resetApnsPushProviderForTests();
    await closeTestDatabase();
  }
});

test("mobile APNs honors each server member all, mentions, and none push mode", async ({ db }) => {

  const deliveries: ApnsDeliveryInput[] = [];
  __setApnsPushProviderForTests({
    async send(input) {
      deliveries.push(input);
      return { status: "sent" };
    },
  });
  try {
    const { owner, server, channel, message, mention, family } = await seedPushFixture();
    await upsertPushRegistration({
      installationId: "push-mode-install",
      provider: "apns",
      userId: owner.id,
      serverId: server.id,
      sessionFamilyId: family.id,
      deviceToken: "push-mode-token",
      topic: "ai.slock.app",
      env: "production",
    });

    await getDb().update(serverMembers).set({ serverPushMode: "mentions" }).where(and(
      eq(serverMembers.serverId, server.id),
      eq(serverMembers.userId, owner.id),
    ));
    assert.deepEqual(
      await dispatchMobilePushForInboxFacts([{
        receiverType: "user",
        receiverId: owner.id,
        serverId: server.id,
        kind: "channel",
        sourceChannelId: channel.id,
        messageId: message.id,
        messageSeq: message.seq,
        activityAt: message.createdAt,
      }]),
      { attempted: 0, sent: 0, skipped: 0, revoked: 0, dropped: 0 },
    );
    assert.equal(deliveries.length, 0, "mentions mode must suppress ordinary mobile pushes");

    assert.deepEqual(
      await dispatchMobilePushForInboxFacts([{
        receiverType: "user",
        receiverId: owner.id,
        serverId: server.id,
        kind: "channel",
        sourceChannelId: channel.id,
        messageId: mention.id,
        messageSeq: mention.seq,
        activityAt: mention.createdAt,
        personalMention: true,
      }]),
      { attempted: 1, sent: 1, skipped: 0, revoked: 0, dropped: 0 },
    );
    assert.equal(deliveries.length, 1, "mentions mode must deliver personal mentions");

    await getDb().update(serverMembers).set({ serverPushMode: "none" }).where(and(
      eq(serverMembers.serverId, server.id),
      eq(serverMembers.userId, owner.id),
    ));
    assert.deepEqual(
      await dispatchMobilePushForInboxFacts([{
        receiverType: "user",
        receiverId: owner.id,
        serverId: server.id,
        kind: "channel",
        sourceChannelId: channel.id,
        messageId: mention.id,
        messageSeq: mention.seq,
        activityAt: mention.createdAt,
        personalMention: true,
      }]),
      { attempted: 0, sent: 0, skipped: 0, revoked: 0, dropped: 0 },
    );
    assert.equal(deliveries.length, 1, "none mode must suppress mentioned mobile pushes too");

    await getDb().update(serverMembers).set({ serverPushMode: "all" }).where(and(
      eq(serverMembers.serverId, server.id),
      eq(serverMembers.userId, owner.id),
    ));
    assert.deepEqual(
      await dispatchMobilePushForInboxFacts([{
        receiverType: "user",
        receiverId: owner.id,
        serverId: server.id,
        kind: "channel",
        sourceChannelId: channel.id,
        messageId: message.id,
        messageSeq: message.seq,
        activityAt: message.createdAt,
      }]),
      { attempted: 1, sent: 1, skipped: 0, revoked: 0, dropped: 0 },
    );
    assert.equal(deliveries.length, 2, "all mode must deliver ordinary mobile pushes");
  } finally {
    __resetApnsPushProviderForTests();
    await closeTestDatabase();
  }
});

test("mobile push feature gate kill switch suppresses APNs, terminally skips, and never replays", async ({ db }) => {

  const deliveries: ApnsDeliveryInput[] = [];
  const scheduled: Promise<void>[] = [];
  __setApnsPushProviderForTests({
    async send(input) {
      deliveries.push(input);
      return { status: "sent" };
    },
  });
  __setMobilePushDeliveryRuntimeForTests({
    schedule: (work) => scheduled.push(work()),
    sleep: async () => {},
    jitterMs: () => 1,
  });
  try {
    const { owner, server, channel, message, family } = await seedPushFixture();
    await upsertPushRegistration({
      installationId: "server-disabled-install",
      provider: "apns",
      userId: owner.id,
      serverId: server.id,
      sessionFamilyId: family.id,
      deviceToken: "server-disabled-token",
      topic: "ai.slock.app",
      env: "production",
    });
    const [seededFlag] = await getDb().select().from(featureFlags).where(
      eq(featureFlags.key, MOBILE_PUSH_DELIVERY_FEATURE_FLAG_KEY),
    );
    assert.equal(seededFlag?.enabled, true);
    assert.equal(seededFlag?.defaultEnabled, true);
    assert.equal(seededFlag?.killSwitch, false);
    await getDb().update(featureFlags).set({ killSwitch: true }).where(
      eq(featureFlags.key, MOBILE_PUSH_DELIVERY_FEATURE_FLAG_KEY),
    );

    await recordInboxNotificationFacts([{
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "channel",
      sourceChannelId: channel.id,
      messageId: message.id,
      messageSeq: message.seq,
      activityAt: message.createdAt,
    }]);
    await Promise.all(scheduled.splice(0));

    assert.equal(deliveries.length, 0, "disabled server switch must not call the APNs provider");
    const [outbox] = await getDb().select().from(mobilePushOutbox).where(eq(mobilePushOutbox.messageId, message.id));
    assert.equal(outbox?.status, "skipped");
    assert.equal(outbox?.attemptedCount, 0);

    await getDb().update(featureFlags).set({ killSwitch: false }).where(
      eq(featureFlags.key, MOBILE_PUSH_DELIVERY_FEATURE_FLAG_KEY),
    );
    await drainMobilePushOutbox();
    assert.equal(deliveries.length, 0, "re-enabling the gate must not replay terminally skipped rows");
    const [stillSkipped] = await getDb().select().from(mobilePushOutbox).where(eq(mobilePushOutbox.messageId, message.id));
    assert.equal(stillSkipped?.status, "skipped");
  } finally {
    __resetApnsPushProviderForTests();
    __resetMobilePushDeliveryRuntimeForTests();
    await closeTestDatabase();
  }
});

test("thread push carries canonical parent identity and global unread badge", async ({ db }) => {

  const deliveries: ApnsDeliveryInput[] = [];
  __setApnsPushProviderForTests({
    async send(input) {
      deliveries.push(input);
      return { status: "sent" };
    },
  });
  try {
    const { owner, other, server, channel, message, family } = await seedPushFixture();
    const [thread] = await getDb().insert(channels).values({
      serverId: server.id,
      name: `thread-${message.id}`,
      type: "thread",
      parentMessageId: message.id,
    }).returning();
    const [reply] = await getDb().insert(messages).values({
      channelId: thread.id,
      senderType: "user",
      senderId: other.id,
      content: "thread reply",
      seq: 1,
    }).returning();
    await upsertPushRegistration({
      installationId: "thread-install",
      provider: "apns",
      userId: owner.id,
      serverId: server.id,
      sessionFamilyId: family.id,
      deviceToken: "thread-token",
      topic: "ai.slock.app",
      env: "production",
    });

    const result = await dispatchMobilePushForInboxFacts([{
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "thread",
      sourceChannelId: thread.id,
      messageId: reply.id,
      messageSeq: reply.seq,
      activityAt: new Date("2026-07-10T00:00:05.000Z"),
    }]);

    assert.deepEqual(result, { attempted: 1, sent: 1, skipped: 0, revoked: 0, dropped: 0 });
    assert.deepEqual(deliveries[0]?.payload, {
      serverId: server.id,
      channelId: thread.id,
      threadId: thread.id,
      parentChannelId: channel.id,
      parentMessageId: message.id,
      messageId: reply.id,
      kind: "thread",
      // Badge totals come from the unified chain totals view (UNIFIED_CHAIN_VIEWS);
      // without a RisingWave environment the badge is the presence constant 1.
      badge: 1,
      alertTitle: "Thread in #general · Mobile Push",
      alertBody: "MobilePushOther: thread reply",
    });

    // The outbox drain loads the badge before opening the writer-fence
    // transaction and hands it in; a provided badge is used as is.
    await dispatchMobilePushForInboxFacts([{
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "thread",
      sourceChannelId: thread.id,
      messageId: reply.id,
      messageSeq: reply.seq,
      activityAt: new Date("2026-07-10T00:00:05.000Z"),
    }], getDb(), { badgeByReceiverId: new Map([[owner.id, 7]]) });
    assert.equal(deliveries[1]?.payload.badge, 7);

    // RisingWave cannot answer the badge: the push is still delivered, without
    // a badge (the device keeps its current one), not failed and dropped.
    const installed = getActivityReadSourceOverride();
    __setActivityReadSourceForTests({
      ...installed!,
      async activityUnreadTotals() { throw new Error("risingwave unavailable"); },
    });
    try {
      const degraded = await dispatchMobilePushForInboxFacts([{
        receiverType: "user",
        receiverId: owner.id,
        serverId: server.id,
        kind: "thread",
        sourceChannelId: thread.id,
        messageId: reply.id,
        messageSeq: reply.seq,
        activityAt: new Date("2026-07-10T00:00:05.000Z"),
      }]);
      assert.deepEqual(degraded, { attempted: 1, sent: 1, skipped: 0, revoked: 0, dropped: 0 });
      assert.equal(deliveries[2]?.payload.badge, undefined);
    } finally {
      __setActivityReadSourceForTests(installed);
    }
  } finally {
    __resetApnsPushProviderForTests();
    await closeTestDatabase();
  }
});

test("configured APNs provider sends a real preview with identity-only custom route fields", async ({ db }) => {

  const previousEnv = {
    keyId: process.env.APNS_KEY_ID,
    teamId: process.env.APNS_TEAM_ID,
    privateKey: process.env.APNS_PRIVATE_KEY,
  };
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  process.env.APNS_KEY_ID = "TESTKEY123";
  process.env.APNS_TEAM_ID = "TEAM123456";
  process.env.APNS_PRIVATE_KEY = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const capturedRequests: Array<{
    authority: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  __resetApnsPushProviderForTests();
  __setApnsHttpClientForTests(async (request) => {
    capturedRequests.push(request);
    return { statusCode: 200, body: "" };
  });
  try {
    const { owner, server, channel, message, family } = await seedPushFixture();
    await upsertPushRegistration({
      installationId: "real-apns-install",
      provider: "apns",
      userId: owner.id,
      serverId: server.id,
      sessionFamilyId: family.id,
      deviceToken: "abcdef123456",
      topic: "ai.slock.app.dev",
      env: "sandbox",
    });

    const result = await dispatchMobilePushForInboxFacts([{
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "channel",
      sourceChannelId: channel.id,
      messageId: message.id,
      messageSeq: message.seq,
      activityAt: new Date("2026-07-10T00:00:05.000Z"),
    }]);

    assert.deepEqual(result, { attempted: 1, sent: 1, skipped: 0, revoked: 0, dropped: 0 });
    const capturedRequest = capturedRequests[0];
    assert.ok(capturedRequest);
    assert.equal(capturedRequest.authority, "https://api.sandbox.push.apple.com");
    assert.equal(capturedRequest.path, "/3/device/abcdef123456");
    assert.match(capturedRequest.headers.authorization, /^bearer .+/);
    assert.equal(capturedRequest.headers["content-type"], "application/json");
    assert.equal(capturedRequest.headers["apns-topic"], "ai.slock.app.dev");
    assert.equal(capturedRequest.headers["apns-push-type"], "alert");
    assert.equal(capturedRequest.headers["apns-priority"], "10");
    assert.equal(
      capturedRequest.headers["apns-collapse-id"],
      createHash("sha256")
        .update("mobile-push-conversation-v1\0")
        .update(server.id)
        .update("\0")
        .update(channel.id)
        .digest("base64url"),
    );
    assert.deepEqual(capturedRequest.body, {
      aps: {
        alert: {
          title: "#general · Mobile Push",
          body: "MobilePushOther: hello",
        },
        badge: 1,
        sound: "default",
        "thread-id": `${server.id}:${channel.id}`,
        category: "RAFT_MESSAGE",
      },
      serverId: server.id,
      channelId: channel.id,
      messageId: message.id,
      kind: "channel",
    });
  } finally {
    __resetApnsHttpClientForTests();
    __resetApnsPushProviderForTests();
    restoreEnv("APNS_KEY_ID", previousEnv.keyId);
    restoreEnv("APNS_TEAM_ID", previousEnv.teamId);
    restoreEnv("APNS_PRIVATE_KEY", previousEnv.privateKey);
    await closeTestDatabase();
  }
});

test("thread APNs thread-id groups by the parent channel", async ({ db }) => {

  const previousEnv = {
    keyId: process.env.APNS_KEY_ID,
    teamId: process.env.APNS_TEAM_ID,
    privateKey: process.env.APNS_PRIVATE_KEY,
  };
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  process.env.APNS_KEY_ID = "TESTKEY123";
  process.env.APNS_TEAM_ID = "TEAM123456";
  process.env.APNS_PRIVATE_KEY = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const capturedRequests: Array<{ body: unknown }> = [];
  __resetApnsPushProviderForTests();
  __setApnsHttpClientForTests(async (request) => {
    capturedRequests.push(request);
    return { statusCode: 200, body: "" };
  });
  try {
    const { owner, other, server, channel, message, family } = await seedPushFixture();
    const [thread] = await getDb().insert(channels).values({
      serverId: server.id,
      name: `thread-${message.id}`,
      type: "thread",
      parentMessageId: message.id,
    }).returning();
    const [reply] = await getDb().insert(messages).values({
      channelId: thread.id,
      senderType: "user",
      senderId: other.id,
      content: "thread reply",
      seq: 1,
    }).returning();
    await upsertPushRegistration({
      installationId: "thread-group-install",
      provider: "apns",
      userId: owner.id,
      serverId: server.id,
      sessionFamilyId: family.id,
      deviceToken: "threadgrouptoken",
      topic: "ai.slock.app.dev",
      env: "sandbox",
    });

    const result = await dispatchMobilePushForInboxFacts([{
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "thread",
      sourceChannelId: thread.id,
      messageId: reply.id,
      messageSeq: reply.seq,
      activityAt: new Date("2026-07-10T00:00:05.000Z"),
    }]);

    assert.deepEqual(result, { attempted: 1, sent: 1, skipped: 0, revoked: 0, dropped: 0 });
    const body = capturedRequests[0]?.body as { aps?: { "thread-id"?: string }; channelId?: string; parentChannelId?: string };
    assert.equal(body.channelId, thread.id);
    assert.equal(body.parentChannelId, channel.id);
    assert.equal(body.aps?.["thread-id"], `${server.id}:${channel.id}`);
  } finally {
    __resetApnsHttpClientForTests();
    __resetApnsPushProviderForTests();
    restoreEnv("APNS_KEY_ID", previousEnv.keyId);
    restoreEnv("APNS_TEAM_ID", previousEnv.teamId);
    restoreEnv("APNS_PRIVATE_KEY", previousEnv.privateKey);
    await closeTestDatabase();
  }
});

test("mobile push revokes APNs registrations immediately on terminal token errors", async ({ db }) => {

  const scheduled: Promise<void>[] = [];
  const provider: ApnsPushProvider = {
    async send() {
      throw new ApnsDeliveryError("bad device token", { statusCode: 410, reason: "BadDeviceToken" });
    },
  };
  __setApnsPushProviderForTests(provider);
  __setMobilePushDeliveryRuntimeForTests({
    schedule: (work) => {
      scheduled.push(work());
    },
    sleep: async () => {},
    jitterMs: () => 1,
  });
  try {
    const { owner, server, channel, message, family } = await seedPushFixture();
    const registration = await upsertPushRegistration({
      installationId: "revoked-install",
      provider: "apns",
      userId: owner.id,
      serverId: server.id,
      sessionFamilyId: family.id,
      deviceToken: "bad-token",
      topic: "ai.slock.app",
      env: "production",
    });

    await recordInboxNotificationFacts([{
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "channel",
      sourceChannelId: channel.id,
      messageId: message.id,
      messageSeq: message.seq,
      activityAt: new Date("2026-07-10T00:00:03.000Z"),
    }]);
    await Promise.all(scheduled.splice(0));

    const [row] = await getDb().select().from(pushRegistrations).where(and(
      eq(pushRegistrations.id, registration.id),
      isNotNull(pushRegistrations.revokedAt),
    ));
    assert.ok(row, "APNs 410/BadDeviceToken should revoke the row immediately");
    assert.equal(row.userId, null);
    assert.equal(row.serverId, null);
    assert.equal(row.revokedReason, "BadDeviceToken");
  } finally {
    __resetApnsPushProviderForTests();
    __resetMobilePushDeliveryRuntimeForTests();
    await closeTestDatabase();
  }
});

test("mobile push bounds retries for transient APNs failures without revoking", async ({ db }) => {

  let attempts = 0;
  const sleeps: number[] = [];
  const scheduled: Promise<void>[] = [];
  const provider: ApnsPushProvider = {
    async send() {
      attempts += 1;
      throw new ApnsDeliveryError("temporary provider failure", { statusCode: 503, reason: "ServiceUnavailable" });
    },
  };
  __setApnsPushProviderForTests(provider);
  __setMobilePushDeliveryRuntimeForTests({
    schedule: (work) => {
      scheduled.push(work());
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    jitterMs: (attempt) => attempt * 10,
  });
  try {
    const { owner, server, channel, message, family } = await seedPushFixture();
    const registration = await upsertPushRegistration({
      installationId: "retry-install",
      provider: "apns",
      userId: owner.id,
      serverId: server.id,
      sessionFamilyId: family.id,
      deviceToken: "retry-token",
      topic: "ai.slock.app",
      env: "production",
    });

    await recordInboxNotificationFacts([{
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "channel",
      sourceChannelId: channel.id,
      messageId: message.id,
      messageSeq: message.seq,
      activityAt: new Date("2026-07-10T00:00:04.000Z"),
    }]);
    await Promise.all(scheduled.splice(0));

    assert.equal(attempts, 3);
    assert.deepEqual(sleeps, [10, 20]);
    const [row] = await getDb().select().from(pushRegistrations).where(eq(pushRegistrations.id, registration.id));
    assert.equal(row.revokedAt, null);
    assert.equal(row.userId, owner.id);
    assert.equal(row.serverId, server.id);
  } finally {
    __resetApnsPushProviderForTests();
    __resetMobilePushDeliveryRuntimeForTests();
    await closeTestDatabase();
  }
});

test("mobile push fanout excludes a revoked session family", async ({ db }) => {

  const deliveries: ApnsDeliveryInput[] = [];
  __setApnsPushProviderForTests({
    async send(input) {
      deliveries.push(input);
      return { status: "sent" };
    },
  });
  try {
    const { owner, server, channel, message, family } = await seedPushFixture();
    await upsertPushRegistration({
      installationId: "dead-family-install",
      provider: "apns",
      userId: owner.id,
      serverId: server.id,
      sessionFamilyId: family.id,
      deviceToken: "dead-family-token",
      topic: "ai.slock.app",
      env: "production",
    });
    const capability = await ensureFamilyRevokeCapability({ familyId: family.id, userId: owner.id });
    assert.ok(capability);
    assert.equal(await revokePushFamilyByCapability(capability), "revoked");

    const result = await dispatchMobilePushForInboxFacts([{
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "channel",
      sourceChannelId: channel.id,
      messageId: message.id,
      messageSeq: message.seq,
      activityAt: new Date(),
    }]);
    assert.deepEqual(result, { attempted: 0, sent: 0, skipped: 0, revoked: 0, dropped: 0 });
    assert.equal(deliveries.length, 0, "dead-family registrations must be excluded by the fanout join");
  } finally {
    __resetApnsPushProviderForTests();
    await closeTestDatabase();
  }
});

test("mobile push fanout delivers once when a family has multiple active sessions", async ({ db }) => {

  const deliveries: ApnsDeliveryInput[] = [];
  __setApnsPushProviderForTests({
    async send(input) {
      deliveries.push(input);
      return { status: "sent" };
    },
  });
  try {
    const { owner, server, channel, message, family } = await seedPushFixture();
    await getDb().insert(sessions).values({
      userId: owner.id,
      familyId: family.id,
      tokenHash: `second-token-${family.id}`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await upsertPushRegistration({
      installationId: "multi-session-install",
      provider: "apns",
      userId: owner.id,
      serverId: server.id,
      sessionFamilyId: family.id,
      deviceToken: "multi-session-token",
      topic: "ai.slock.app",
      env: "production",
    });

    const result = await dispatchMobilePushForInboxFacts([{
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "channel",
      sourceChannelId: channel.id,
      messageId: message.id,
      messageSeq: message.seq,
      activityAt: new Date(),
    }]);

    assert.deepEqual(result, { attempted: 1, sent: 1, skipped: 0, revoked: 0, dropped: 0 });
    assert.equal(deliveries.length, 1);
  } finally {
    __resetApnsPushProviderForTests();
    await closeTestDatabase();
  }
});

test("mobile push traces never contain raw installation, device token, topic, or revoke capability values", async ({ db }) => {

  const scheduled: Promise<void>[] = [];
  __setApnsPushProviderForTests({
    async send() {
      throw new ApnsDeliveryError("temporary provider failure", { statusCode: 503, reason: "ServiceUnavailable" });
    },
  });
  __setMobilePushDeliveryRuntimeForTests({
    schedule: (work) => scheduled.push(work()),
    sleep: async () => {},
    jitterMs: () => 1,
  });
  try {
    const { owner, server, channel, message, family } = await seedPushFixture();
    const installationId = "alice@example.com secret installation";
    const deviceToken = "secret-device-token-marker";
    const topic = "secret.topic.marker";
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({
      sink,
      traceIdGenerator: () => "f".repeat(32),
      spanIdGenerator: () => "1".repeat(16),
    });
    const span = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });
    let capability = "";

    await runWithTraceSpan(span, async () => {
      await upsertPushRegistration({
        installationId,
        provider: "apns",
        userId: owner.id,
        serverId: server.id,
        sessionFamilyId: family.id,
        deviceToken,
        topic,
        env: "production",
      });
      await recordInboxNotificationFacts([{
        receiverType: "user",
        receiverId: owner.id,
        serverId: server.id,
        kind: "channel",
        sourceChannelId: channel.id,
        messageId: message.id,
        messageSeq: message.seq,
        activityAt: new Date(),
      }]);
      await Promise.all(scheduled.splice(0));
      await unbindPushInstallation({ installationId, userId: owner.id, serverId: server.id });
      capability = (await ensureFamilyRevokeCapability({ familyId: family.id, userId: owner.id })) ?? "";
      assert.ok(capability);
      await revokePushFamilyByCapability(capability);
    });
    span.end();

    const traceValues = JSON.stringify(sink.getAllSpans().flatMap((recorded) => recorded.events.map((event) => event.attrs)));
    for (const secret of [installationId, deviceToken, topic, capability]) {
      assert.equal(traceValues.includes(secret), false, `trace attrs must not contain ${secret}`);
    }
  } finally {
    __resetApnsPushProviderForTests();
    __resetMobilePushDeliveryRuntimeForTests();
    await closeTestDatabase();
  }
});

test("mobile push interval worker drains inside an explicit trace root", async ({ db }) => {

  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  let intervalRun: (() => void) | undefined;
  let worker: ReturnType<typeof startMobilePushOutboxWorker> | undefined;
  __setApnsPushProviderForTests({
    async send() {
      return { status: "sent" };
    },
  });

  try {
    worker = startMobilePushOutboxWorker({
      tracer,
      clock: {
        scheduleEvery(run) {
          intervalRun = run;
          return Symbol("mobile-push-worker-timer");
        },
        clearInterval() {},
      },
    });
    await waitFor(
      () => sink.getAllSpans().length === 1,
      "startup drain should finish before the interval specimen is inserted",
    );

    const { owner, server, channel, message, family } = await seedPushFixture();
    await upsertPushRegistration({
      installationId: "interval-worker-install",
      provider: "apns",
      userId: owner.id,
      serverId: server.id,
      sessionFamilyId: family.id,
      deviceToken: "interval-worker-token",
      topic: "ai.slock.app",
      env: "production",
    });
    await getDb().insert(mobilePushOutbox).values({
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "channel",
      sourceChannelId: channel.id,
      messageId: message.id,
      messageSeq: message.seq,
      activityAt: new Date("2026-07-19T12:00:00.000Z"),
    });

    assert.ok(intervalRun, "worker should register an interval callback");
    intervalRun();
    await waitFor(
      () => sink.getAllSpans().length === 2,
      "interval drain should close its trace root",
    );

    const intervalSpan = sink.getAllSpans()[1];
    assert.equal(intervalSpan?.name, "server.push.mobile_outbox.drain");
    assert.equal(intervalSpan?.kind, "internal");
    assert.equal(intervalSpan?.attrs?.trigger, "interval_worker");
    assert.equal(intervalSpan?.attrs?.batch_size, 100);
    assert.equal(intervalSpan?.attrs?.claimed_count, 1);
    assert.equal(intervalSpan?.attrs?.processed_count, 1);
    // The badge is read through the Activity totals (in CI, the installed
    // test-only Postgres reference, whose inbox.* read events land here too);
    // this pins the push event sequence.
    assert.deepEqual(
      intervalSpan?.events.map((event) => event.name).filter((name) => name.startsWith("push.")),
      [
        "push.mobile.targets.built",
        "push.mobile.delivery.attempt",
        "push.mobile.delivery.summary",
      ],
    );
    const [outboxRow] = await getDb()
      .select()
      .from(mobilePushOutbox)
      .where(eq(mobilePushOutbox.messageId, message.id));
    assert.equal(outboxRow?.status, "sent");
  } finally {
    worker?.stop();
    __resetApnsPushProviderForTests();
    await closeTestDatabase();
  }
});

test("database close drains default deferred mobile push before releasing SQL", async ({ db }) => {
  __resetMobilePushDeliveryRuntimeForTests();
  let markEntered = () => {};
  let releaseProvider = () => {};
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  const released = new Promise<void>(resolve => { releaseProvider = resolve; });
  let delivered = false;
  let closing: Promise<void> | undefined;
  __setApnsPushProviderForTests({
    async send() {
      markEntered();
      await released;
      // Dispatch holds the conversion fence transaction. A second PGlite
      // query through the outer database would wait on this very callback.
      assert.equal(isDatabaseInitialized(), true, "provider work still owns a live database");
      assert.equal(getDb(), db);
      delivered = true;
      return { status: "sent" };
    },
  });
  try {
    const { owner, server, channel, mention, family } = await seedPushFixture();
    await upsertPushRegistration({
      installationId: "close-drain-install",
      provider: "apns",
      userId: owner.id,
      serverId: server.id,
      sessionFamilyId: family.id,
      deviceToken: "sandbox-token",
      topic: "ai.slock.app.dev",
      env: "sandbox",
    });
    await recordInboxNotificationFacts([{
      receiverType: "user", receiverId: owner.id, serverId: server.id,
      kind: "channel", sourceChannelId: channel.id,
      messageId: mention.id, messageSeq: mention.seq,
      activityAt: new Date(), personalMention: true,
    }]);
    closing = closeTestDatabase();
    await Promise.race([
      entered,
      closing.then(() => assert.fail("database closed before deferred delivery started")),
    ]);
    assert.equal(delivered, false, "close waits for the blocked provider");
    releaseProvider();
    await closing;
    assert.equal(delivered, true, "close joins the actual provider and its SQL work");
    assert.equal(isDatabaseInitialized(), false, "SQL closes only after delivery returns");
  } finally {
    releaseProvider();
    await closing?.catch(() => {});
    __resetApnsPushProviderForTests();
    __resetMobilePushDeliveryRuntimeForTests();
  }
});

async function seedWebPushSubscriptions(db: ReturnType<typeof getDb>, endpoints: string[]) {
  const [owner] = await db.insert(users).values({
    email: "web-push-owner@test.com",
    name: "WebPushOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  // Rows are inserted directly: they stand in for subscriptions saved before
  // endpoints were validated at registration.
  await db.insert(pushSubscriptions).values(endpoints.map((endpoint) => ({
    userId: owner.id,
    endpoint,
    p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
    auth: "tBHItJI5svbpez7KI4CCXg",
  })));
  return owner;
}

function storedEndpoints(db: ReturnType<typeof getDb>, userId: string) {
  return db.select({ endpoint: pushSubscriptions.endpoint }).from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .then((rows) => rows.map((row) => row.endpoint).sort());
}

test("web push delivery drops subscriptions whose endpoint is not a public HTTPS host without contacting it", async ({ db }) => {
  const resolved: string[] = [];
  let sends = 0;
  __setWebPushRuntimeForTests({
    enabled: true,
    lookup: async (hostname) => {
      resolved.push(hostname);
      return [{ address: "10.0.0.5", family: 4 }];
    },
    sendNotification: async () => {
      sends += 1;
      return { statusCode: 201, body: "", headers: {} };
    },
  });
  try {
    const owner = await seedWebPushSubscriptions(db, [
      "https://push.corp.example/sub/private-range",
      "http://updates.push.services.mozilla.com/wpush/v2/plain-http",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/sub/loopback",
      "https://push.internal/sub/internal-suffix",
    ]);

    const result = await sendPushToUsers([owner.id], { title: "t", body: "b", tag: "web-push-test", url: "/" });

    assert.deepEqual(result, { attempted: 5, delivered: 0, failed: 5 });
    assert.equal(sends, 0, "no push endpoint may be contacted");
    assert.deepEqual(resolved, ["push.corp.example"], "only a syntactically acceptable host reaches DNS");
    assert.deepEqual(await storedEndpoints(db, owner.id), [], "undeliverable subscriptions are dropped like a 410");
  } finally {
    __resetWebPushRuntimeForTests();
  }
});

test("web push delivery keeps the subscription when name resolution itself fails", async ({ db }) => {
  let sends = 0;
  __setWebPushRuntimeForTests({
    enabled: true,
    lookup: async () => {
      throw Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
    },
    sendNotification: async () => {
      sends += 1;
      return { statusCode: 201, body: "", headers: {} };
    },
  });
  try {
    const owner = await seedWebPushSubscriptions(db, ["https://fcm.googleapis.com/fcm/send/transient"]);

    const result = await sendPushToUsers([owner.id], { title: "t", body: "b", tag: "web-push-test", url: "/" });

    assert.deepEqual(result, { attempted: 1, delivered: 0, failed: 1 });
    assert.equal(sends, 0);
    assert.deepEqual(await storedEndpoints(db, owner.id), ["https://fcm.googleapis.com/fcm/send/transient"]);
  } finally {
    __resetWebPushRuntimeForTests();
  }
});

test("web push delivery pins the connection to the public address the endpoint resolved to", async ({ db }) => {
  const lookups: Array<{ hostname: string; options: unknown }> = [];
  const sends: Array<{ endpoint: string; agent: unknown }> = [];
  __setWebPushRuntimeForTests({
    enabled: true,
    lookup: async (hostname, options) => {
      lookups.push({ hostname, options });
      return [
        { address: "142.250.72.10", family: 4 },
        { address: "2607:f8b0:4004:c07::5f", family: 6 },
      ];
    },
    sendNotification: async (subscription, _payload, options) => {
      sends.push({ endpoint: subscription.endpoint, agent: options?.agent });
      return { statusCode: 201, body: "", headers: {} };
    },
  });
  try {
    const owner = await seedWebPushSubscriptions(db, ["https://fcm.googleapis.com/fcm/send/pinned"]);

    const result = await sendPushToUsers([owner.id], { title: "t", body: "b", tag: "web-push-test", url: "/" });

    assert.deepEqual(result, { attempted: 1, delivered: 1, failed: 0 });
    assert.deepEqual(lookups, [{ hostname: "fcm.googleapis.com", options: { all: true, verbatim: true } }]);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].endpoint, "https://fcm.googleapis.com/fcm/send/pinned");
    const agent = sends[0].agent;
    assert.ok(agent instanceof HttpsAgent, "delivery must go through an https.Agent the service controls");
    const pinnedLookup = agent.options.lookup as (
      hostname: string,
      options: { all: boolean },
      callback: (error: Error | null, ...rest: unknown[]) => void,
    ) => void;
    const single = await new Promise<unknown[]>((resolve) => {
      pinnedLookup("fcm.googleapis.com", { all: false }, (_error, ...rest) => resolve(rest));
    });
    assert.deepEqual(single, ["142.250.72.10", 4], "the socket connects to the address that passed the check");
    const all = await new Promise<unknown[]>((resolve) => {
      pinnedLookup("fcm.googleapis.com", { all: true }, (_error, ...rest) => resolve(rest));
    });
    assert.deepEqual(all, [[{ address: "142.250.72.10", family: 4 }]]);
    assert.deepEqual(await storedEndpoints(db, owner.id), ["https://fcm.googleapis.com/fcm/send/pinned"]);
  } finally {
    __resetWebPushRuntimeForTests();
  }
});
