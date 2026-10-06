// Contract v0.3 §18.5–§18.11 (joint channel limits), test matrix 30–39.
// Every scenario builds its own servers and plans from scratch.
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { JOINT_CHANNEL_OVER_LIMIT_GRACE_MS, PRO_AGENT_SEAT_BLOCK_SIZE } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { jointChannels, servers, subscriptions, users } from "../db/schema";
import { createServer } from "./serverService";
import {
  acceptJointChannelInvite,
  createJointChannel,
  getOrCreateThreadForChannel,
  inviteServerToJointChannel,
} from "./channelService";
import { createMessage } from "./messageService";
import { isChannelReadOnlyByBillingFeature } from "./planService";
import {
  JointChannelLimitError,
  onJointLimitStateChanged,
  reconcileJointsForServer,
  sweepJointOverLimit,
} from "./jointChannelLimitService";
import { emitJointLimitStateChange } from "../routes/channels";

afterEach(async () => {
  await closeTestDatabase();
});

type Plan = "free" | "founder" | "partner" | "pro";
type Seeded = { owner: typeof users.$inferSelect; server: Awaited<ReturnType<typeof createServer>> };

async function seedServer(label: string, plan: Plan): Promise<Seeded> {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await getDb().insert(users).values({
    email: `${label}-${suffix}@slock.test`,
    name: `${label}-${suffix}`,
    displayName: label,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer(`${label} ${suffix}`, `${label}-${suffix}`, owner.id);
  await setPlan(server.id, plan);
  return { owner, server };
}

async function setPlan(serverId: string, plan: Plan) {
  await getDb().update(servers).set({ plan }).where(eq(servers.id, serverId));
}

async function insertSubscription(serverId: string, ownerId: string, status: "active" | "past_due" | "canceled") {
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await getDb().insert(subscriptions).values({
    serverId,
    plan: "pro",
    provider: "stripe",
    stripeCustomerId: `cus_${randomUUID()}`,
    stripeSubscriptionId: `sub_${randomUUID()}`,
    stripeProPackItemId: `si_pro_${randomUUID()}`,
    status,
    provisionedHumanSeats: 1,
    provisionedAgentSeats: PRO_AGENT_SEAT_BLOCK_SIZE,
    proPackQuantity: 1,
    trialFreePackQuantity: 1,
    firstPackTrialEndsAt: future,
    currentPeriodStart: new Date(),
    currentPeriodEnd: future,
    createdByUserId: ownerId,
    updatedByUserId: ownerId,
  });
}

async function createJoint(host: Seeded, targets: Seeded[] = []) {
  return createJointChannel({
    hostServerId: host.server.id,
    createdByUserId: host.owner.id,
    name: `joint-${randomUUID().slice(0, 8)}`,
    jointInvites: targets.map((target) => ({ targetServerSlug: target.server.slug, invitedPeople: [target.owner.email] })),
  });
}

function inviteFor(result: Awaited<ReturnType<typeof createJoint>>, target: Seeded) {
  const invite = result.invites.find((row) => row.toServerId === target.server.id);
  assert.ok(invite, "invite for target");
  return invite;
}

async function accept(inviteId: string, target: Seeded) {
  return acceptJointChannelInvite({ inviteId, targetServerId: target.server.id, acceptedByUserId: target.owner.id });
}

async function invite(localChannelId: string, from: Seeded, target: Seeded) {
  return inviteServerToJointChannel({
    localChannelId,
    fromServerId: from.server.id,
    invitedByUserId: from.owner.id,
    targetServerSlug: target.server.slug,
    invitedPeople: [target.owner.email],
  });
}

async function overLimitSince(jointId: string) {
  const [row] = await getDb().select({ since: jointChannels.overLimitSince }).from(jointChannels).where(eq(jointChannels.id, jointId));
  return row?.since ?? null;
}

function rejectsWith(code: "joint_free_server_limit" | "joint_server_limit") {
  return (error: unknown) => error instanceof JointChannelLimitError && error.code === code;
}

/** Host free + free participant + paid participant, all accepted. */
async function jointAtTwoFreePlusPaid() {
  const host = await seedServer("host", "free");
  const freeA = await seedServer("free-a", "free");
  const paid = await seedServer("paid", "founder");
  const created = await createJoint(host, [freeA, paid]);
  await accept(inviteFor(created, freeA).id, freeA);
  await accept(inviteFor(created, paid).id, paid);
  return {
    host, freeA, paid, created,
    jointId: created.jointChannel.id,
    hostLocal: created.channel.id,
    canonicalId: created.jointChannel.canonicalChannelId,
  };
}

test("30: an invite that would make a third free server is rejected, and pending invites count", async ({ db: _db }) => {
  const host = await seedServer("host", "founder");
  const freeA = await seedServer("free-a", "free");
  const freeB = await seedServer("free-b", "free");
  const freeC = await seedServer("free-c", "free");
  const created = await createJoint(host, [freeA]);
  // A is only pending; B makes 2 free (pending included); C would make 3.
  await invite(created.channel.id, host, freeB);
  await assert.rejects(() => invite(created.channel.id, host, freeC), rejectsWith("joint_free_server_limit"));

  // Creating with three free servers up front is rejected the same way.
  const freeHost = await seedServer("free-host", "free");
  await assert.rejects(() => createJoint(freeHost, [freeA, freeB]), rejectsWith("joint_free_server_limit"));
});

test("30b: a joint already at two free servers can still invite paid servers", async ({ db: _db }) => {
  const host = await seedServer("host", "free");
  const freeA = await seedServer("free-a", "free");
  const paid = await seedServer("paid", "pro");
  await insertSubscription(paid.server.id, paid.owner.id, "active");
  const created = await createJoint(host, [freeA]);
  await accept(inviteFor(created, freeA).id, freeA);
  const result = await invite(created.channel.id, host, paid);
  assert.equal(result.invites.length, 1);
});

test("32: after a downgrade, accepting an old free invite is rejected; only one of two concurrent accepts succeeds", async ({ db: _db }) => {
  const host = await seedServer("host", "founder");
  const freeB = await seedServer("free-b", "free");
  const freeC = await seedServer("free-c", "free");
  const created = await createJoint(host, [freeB, freeC]);
  await setPlan(host.server.id, "free");

  const results = await Promise.allSettled([
    accept(inviteFor(created, freeB).id, freeB),
    accept(inviteFor(created, freeC).id, freeC),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejectsWith("joint_free_server_limit")(rejected[0]!.reason));
});

test("33: a free server can host more than one joint channel", async ({ db: _db }) => {
  const host = await seedServer("host", "free");
  const peer = await seedServer("peer", "founder");
  // The old rule allowed a free host only one active joint channel.
  const first = await createJoint(host, [peer]);
  const second = await createJoint(host, [peer]);
  assert.notEqual(first.jointChannel.id, second.jointChannel.id);
});

test("34: downgrade starts the grace, read-only after 3 days, writable again after upgrade", async ({ db: _db }) => {
  const { paid, jointId, hostLocal, host } = await jointAtTwoFreePlusPaid();
  assert.equal(await overLimitSince(jointId), null);

  const t0 = new Date();
  await setPlan(paid.server.id, "free");
  await reconcileJointsForServer(paid.server.id, t0);
  const since = await overLimitSince(jointId);
  assert.equal(since?.getTime(), t0.getTime());

  const justBefore = new Date(t0.getTime() + JOINT_CHANNEL_OVER_LIMIT_GRACE_MS - 1);
  const atEnd = new Date(t0.getTime() + JOINT_CHANNEL_OVER_LIMIT_GRACE_MS);
  assert.equal(await isChannelReadOnlyByBillingFeature(hostLocal, host.server.id, justBefore), false);
  assert.equal(await isChannelReadOnlyByBillingFeature(hostLocal, host.server.id, atEnd), true);

  await setPlan(paid.server.id, "founder");
  await reconcileJointsForServer(paid.server.id, atEnd);
  assert.equal(await overLimitSince(jointId), null);
  assert.equal(await isChannelReadOnlyByBillingFeature(hostLocal, host.server.id, atEnd), false);
});

test("35 + existing defect: joint sub-threads follow the parent, including local thread projections", async ({ db: _db }) => {
  const { paid, host, freeA, hostLocal, created, canonicalId } = await jointAtTwoFreePlusPaid();
  // Joint messages persist in the canonical storage channel.
  const parent = await createMessage(canonicalId, "user", host.owner.id, "parent in joint");
  const thread = await getOrCreateThreadForChannel(hostLocal, parent.id, host.owner.id, "user");

  const t0 = new Date();
  await setPlan(paid.server.id, "free");
  await reconcileJointsForServer(paid.server.id, t0);
  const afterGrace = new Date(t0.getTime() + JOINT_CHANNEL_OVER_LIMIT_GRACE_MS);

  // Before this change a local joint-thread projection (type "thread" with no
  // parentMessageId) resolved to "not joint" and stayed writable.
  assert.equal(await isChannelReadOnlyByBillingFeature(thread.id, host.server.id, afterGrace), true);
  assert.equal(await isChannelReadOnlyByBillingFeature(thread.id, host.server.id, t0), false);

  // The sub-thread's own joint record never carries its own state.
  const [threadJoint] = await getDb()
    .select({ id: jointChannels.id, since: jointChannels.overLimitSince })
    .from(jointChannels)
    .where(eq(jointChannels.canonicalChannelId, thread.canonicalThreadChannelId));
  assert.ok(threadJoint && threadJoint.id !== created.jointChannel.id);
  assert.equal(threadJoint.since, null);
  void freeA;
});

test("36: paid means founder, partner, pro subscription active/past_due, or pro without a subscription; canceled pro is free", async ({ db: _db }) => {
  const host = await seedServer("host", "free");
  const freeA = await seedServer("free-a", "free");
  const created = await createJoint(host, [freeA]);
  await accept(inviteFor(created, freeA).id, freeA);

  const founder = await seedServer("founder", "founder");
  const partner = await seedServer("partner", "partner");
  const proActive = await seedServer("pro-active", "pro");
  await insertSubscription(proActive.server.id, proActive.owner.id, "active");
  const proPastDue = await seedServer("pro-past-due", "pro");
  await insertSubscription(proPastDue.server.id, proPastDue.owner.id, "past_due");
  const proNoSub = await seedServer("pro-no-sub", "pro");
  for (const paid of [founder, partner, proActive, proPastDue, proNoSub]) {
    await invite(created.channel.id, host, paid);
  }

  const proCanceled = await seedServer("pro-canceled", "pro");
  await insertSubscription(proCanceled.server.id, proCanceled.owner.id, "canceled");
  await assert.rejects(() => invite(created.channel.id, host, proCanceled), rejectsWith("joint_free_server_limit"));
});

test("37: the sweep finds an idle joint that went over and starts its grace", async ({ db: _db }) => {
  const { paid, jointId } = await jointAtTwoFreePlusPaid();
  await setPlan(paid.server.id, "free"); // no hook runs: nobody posts, no billing event
  const t0 = new Date();
  const result = await sweepJointOverLimit(t0);
  assert.ok(result.started >= 1);
  assert.equal((await overLimitSince(jointId))?.getTime(), t0.getTime());

  // Idempotent: a second sweep keeps the first observation.
  await sweepJointOverLimit(new Date(t0.getTime() + 60_000));
  assert.equal((await overLimitSince(jointId))?.getTime(), t0.getTime());
});

test("38: going over, recovering, then going over again starts a fresh grace", async ({ db: _db }) => {
  const { paid, jointId } = await jointAtTwoFreePlusPaid();
  const t1 = new Date("2027-01-01T00:00:00Z");
  const t2 = new Date("2027-01-02T00:00:00Z");
  const t3 = new Date("2027-01-03T00:00:00Z");
  await setPlan(paid.server.id, "free");
  await sweepJointOverLimit(t1);
  assert.equal((await overLimitSince(jointId))?.getTime(), t1.getTime());
  await setPlan(paid.server.id, "founder");
  await sweepJointOverLimit(t2);
  assert.equal(await overLimitSince(jointId), null);
  await setPlan(paid.server.id, "free");
  await sweepJointOverLimit(t3);
  assert.equal((await overLimitSince(jointId))?.getTime(), t3.getTime());
});

test("39: a deleted participant server never makes the joint go over", async ({ db: _db }) => {
  const { paid, jointId } = await jointAtTwoFreePlusPaid();
  await getDb().update(servers).set({ plan: "free", deletedAt: new Date() }).where(eq(servers.id, paid.server.id));
  await sweepJointOverLimit(new Date());
  assert.equal(await overLimitSince(jointId), null);
});

test("sub-thread joint records are not counted as joints by the sweep", async ({ db: _db }) => {
  const { host, hostLocal, canonicalId } = await jointAtTwoFreePlusPaid();
  const before = await sweepJointOverLimit(new Date());
  const parent = await createMessage(canonicalId, "user", host.owner.id, "parent");
  await getOrCreateThreadForChannel(hostLocal, parent.id, host.owner.id, "user");
  const after = await sweepJointOverLimit(new Date());
  assert.equal(after.scanned, before.scanned);
});

test("background observers notify clients only when the over-limit state changes", async ({ db: _db }) => {
  const { paid, jointId } = await jointAtTwoFreePlusPaid();
  const notified: string[] = [];
  onJointLimitStateChanged((parentJointId) => { notified.push(parentJointId); });
  try {
    const t0 = new Date("2027-02-01T00:00:00Z");
    // Billing sync: going over, staying over, recovering.
    await setPlan(paid.server.id, "free");
    await reconcileJointsForServer(paid.server.id, t0);
    assert.deepEqual(notified.splice(0), [jointId], "entering grace notifies");
    await reconcileJointsForServer(paid.server.id, new Date(t0.getTime() + 1000));
    assert.deepEqual(notified.splice(0), [], "no change, no notification");
    await setPlan(paid.server.id, "founder");
    await reconcileJointsForServer(paid.server.id, new Date(t0.getTime() + 2000));
    assert.deepEqual(notified.splice(0), [jointId], "recovering notifies");

    // Sweep: same three cases.
    await sweepJointOverLimit(new Date(t0.getTime() + 3000));
    assert.deepEqual(notified.splice(0), [], "a sweep with nothing to change is silent");
    await setPlan(paid.server.id, "free");
    await sweepJointOverLimit(new Date(t0.getTime() + 4000));
    assert.deepEqual(notified.splice(0), [jointId], "the sweep starting a grace notifies");
    await setPlan(paid.server.id, "founder");
    await sweepJointOverLimit(new Date(t0.getTime() + 5000));
    assert.deepEqual(notified.splice(0), [jointId], "the sweep clearing it notifies");
  } finally {
    onJointLimitStateChanged(null);
  }
});

test("a joint limit state change pushes fresh metadata to every participant's projection", async ({ db: _db }) => {
  const { paid, jointId, created } = await jointAtTwoFreePlusPaid();
  const t0 = new Date();
  await setPlan(paid.server.id, "free");
  await reconcileJointsForServer(paid.server.id, t0);

  const emitted: Array<{ room: string; event: string; channel: { id: string; jointOverLimitGraceEndsAt?: string | null } }> = [];
  const io = {
    to: (room: string) => ({
      emit: (event: string, payload: { channel: { id: string; jointOverLimitGraceEndsAt?: string | null } }) => {
        emitted.push({ room, event, channel: payload.channel });
      },
    }),
  };
  await emitJointLimitStateChange(io as never, jointId);

  assert.equal(emitted.length, 3, "host, free participant and paid participant each get their projection");
  assert.ok(emitted.every((entry) => entry.event === "channel:updated" && entry.room === `channel:${entry.channel.id}`));
  assert.ok(emitted.some((entry) => entry.channel.id === created.channel.id), "the host's local channel is included");
  const graceEndsAt = new Date(t0.getTime() + JOINT_CHANNEL_OVER_LIMIT_GRACE_MS).toISOString();
  assert.ok(
    emitted.every((entry) => new Date(entry.channel.jointOverLimitGraceEndsAt ?? 0).toISOString() === graceEndsAt),
    "each payload carries the new grace deadline",
  );
});
