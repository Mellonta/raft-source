/**
 * A human and an agent in one server may share a name. Before this, a bare
 * `dm:@Twin` silently resolved to the human's DM, so an agent reading or
 * replying to the agent Twin landed in the wrong conversation (task #3,
 * Grace/skyzh). These tests pin the explicit peer kind (`dm:@Twin~agent`),
 * the typed ambiguity error, and that agent-facing targets carry the kind only
 * for names that actually collide.
 */
import assert from "node:assert/strict";
import { dbTest as test } from "../test/integration/dbTest";
import type { Database } from "../db/index";
import { eq } from "drizzle-orm";
import { agents, channels, messages, serverMembers, servers, users } from "../db/schema";
import {
  findOrCreateAgentDM,
  findOrCreateDM,
  resolveAgentFacingChannelRef,
  resolveAgentFacingDmRefs,
  resolveChannelByName,
} from "./channelService";
import { DmTargetResolutionError } from "./dmTargetResolutionError";
import { resolveWritableAgentTarget } from "../routes/agentWritableTarget";

async function seedTwins(db: Database) {
  const [owner, humanTwin] = await db
    .insert(users)
    .values([
      { email: "owner-twin@test.invalid", name: "OwnerTwin", passwordHash: "x", emailVerified: true },
      { email: "human-twin@test.invalid", name: "Twin", passwordHash: "x", emailVerified: true },
    ])
    .returning();
  const [server] = await db
    .insert(servers)
    .values({ name: "TwinServer", slug: "twin-server", ownerId: owner.id })
    .returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: humanTwin.id, role: "member" },
  ]);
  const [grace, agentTwin, solo, bystander] = await db
    .insert(agents)
    .values([
      { serverId: server.id, name: "Grace", status: "active" },
      { serverId: server.id, name: "Twin", status: "active" },
      { serverId: server.id, name: "Solo", status: "active" },
      { serverId: server.id, name: "Bystander", status: "active" },
    ])
    .returning();
  const humanDm = await findOrCreateDM(server.id, humanTwin.id, grace.id);
  const agentDm = await findOrCreateAgentDM(server.id, grace.id, agentTwin.id);
  const soloDm = await findOrCreateAgentDM(server.id, grace.id, solo.id);
  assert.ok(humanDm && agentDm && soloDm);
  return { server, grace, agentTwin, bystander, humanDm, agentDm, soloDm };
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof DmTargetResolutionError, `expected DmTargetResolutionError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

test("a bare name shared by a human and an agent DM is ambiguous; the kind picks one", async ({ db }) => {
  const { server, grace, humanDm, agentDm } = await seedTwins(db);

  await rejectsWith(resolveChannelByName(server.id, grace.id, "dm:@Twin"), "DM_TARGET_AMBIGUOUS");
  assert.equal((await resolveChannelByName(server.id, grace.id, "dm:@Twin~agent"))?.channelId, agentDm.id);
  assert.equal((await resolveChannelByName(server.id, grace.id, "dm:@Twin~human"))?.channelId, humanDm.id);
});

test("a twin NAME is ambiguous even when only one DM exists yet (stable, not time-dependent)", async ({ db }) => {
  // A human named Twin and an agent named Twin in the same server, but here ONLY
  // the human's DM with grace exists — the agent Twin's DM is not opened yet.
  const [owner, humanTwin] = await db
    .insert(users)
    .values([
      { email: "owner-early@test.invalid", name: "OwnerEarly", passwordHash: "x", emailVerified: true },
      { email: "human-early@test.invalid", name: "Twin", passwordHash: "x", emailVerified: true },
    ])
    .returning();
  const [server] = await db
    .insert(servers)
    .values({ name: "EarlyTwinServer", slug: "early-twin-server", ownerId: owner.id })
    .returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: humanTwin.id, role: "member" },
  ]);
  const [grace, agentTwin] = await db
    .insert(agents)
    .values([
      { serverId: server.id, name: "Grace", status: "active" },
      { serverId: server.id, name: "Twin", status: "active" },
    ])
    .returning();
  const humanDm = await findOrCreateDM(server.id, humanTwin.id, grace.id);
  assert.ok(humanDm);
  // No agent DM: the agent Twin exists (so the name is a twin) but has no DM with grace.

  // The bare name must be rejected REGARDLESS of the agent DM not existing yet:
  // otherwise the same target would resolve to the human today and become an
  // error once the agent DM opened, silently changing which conversation it names.
  await rejectsWith(resolveChannelByName(server.id, grace.id, "dm:@Twin"), "DM_TARGET_AMBIGUOUS");
  assert.equal((await resolveChannelByName(server.id, grace.id, "dm:@Twin~human"))?.channelId, humanDm.id);
  // The agent DM doesn't exist, so the explicit kind resolves to nothing yet.
  assert.equal(await resolveChannelByName(server.id, grace.id, "dm:@Twin~agent"), null);
});

test("the ambiguity error tells the caller exactly what to type", async ({ db }) => {
  const { server, grace } = await seedTwins(db);
  await assert.rejects(resolveChannelByName(server.id, grace.id, "dm:@Twin"), (err: unknown) => {
    assert.ok(err instanceof DmTargetResolutionError);
    assert.equal(err.status, 409);
    assert.match(err.message, /dm:@Twin~agent/);
    assert.match(err.message, /dm:@Twin~human/);
    return true;
  });
});

test("an unknown peer kind is refused instead of falling back to the bare name", async ({ db }) => {
  const { server, grace } = await seedTwins(db);
  await rejectsWith(resolveChannelByName(server.id, grace.id, "dm:@Twin~bot"), "DM_TARGET_INVALID_PEER_KIND");
  await rejectsWith(resolveChannelByName(server.id, grace.id, "dm:@Solo~"), "DM_TARGET_INVALID_PEER_KIND");
  // Thread targets are located by short id, but a malformed kind is still refused.
  await rejectsWith(resolveChannelByName(server.id, grace.id, "dm:@Twin~bot:deadbeef"), "DM_TARGET_INVALID_PEER_KIND");
});

test("a name with only one kind of DM resolves as before, and the wrong kind finds nothing", async ({ db }) => {
  const { server, grace, soloDm } = await seedTwins(db);
  assert.equal((await resolveChannelByName(server.id, grace.id, "dm:@Solo"))?.channelId, soloDm.id);
  assert.equal((await resolveChannelByName(server.id, grace.id, "dm:@Solo~agent"))?.channelId, soloDm.id);
  assert.equal(await resolveChannelByName(server.id, grace.id, "dm:@Solo~human"), null);
});

test("an explicit kind never reaches another agent's DM", async ({ db }) => {
  const { server, bystander } = await seedTwins(db);
  // Bystander has no DM with either Twin; naming the kind grants nothing.
  assert.equal(await resolveChannelByName(server.id, bystander.id, "dm:@Twin~agent"), null);
  assert.equal(await resolveChannelByName(server.id, bystander.id, "dm:@Twin~human"), null);
});

test("agent-facing DM targets carry the kind only for names a human and an agent share", async ({ db }) => {
  const { server, grace, humanDm, agentDm, soloDm } = await seedTwins(db);

  assert.equal(await resolveAgentFacingChannelRef(server.id, grace.id, agentDm.id), "dm:@Twin~agent");
  assert.equal(await resolveAgentFacingChannelRef(server.id, grace.id, humanDm.id), "dm:@Twin~human");
  assert.equal(await resolveAgentFacingChannelRef(server.id, grace.id, soloDm.id), "dm:@Solo");

  const batched = await resolveAgentFacingDmRefs(server.id, grace.id, [agentDm.id, humanDm.id, soloDm.id]);
  assert.equal(batched.get(agentDm.id), "dm:@Twin~agent");
  assert.equal(batched.get(humanDm.id), "dm:@Twin~human");
  assert.equal(batched.get(soloDm.id), "dm:@Solo");
});

test("every rendered target resolves back to the same DM (round trip)", async ({ db }) => {
  const { server, grace, humanDm, agentDm, soloDm } = await seedTwins(db);
  for (const dm of [humanDm, agentDm, soloDm]) {
    const ref = await resolveAgentFacingChannelRef(server.id, grace.id, dm.id);
    assert.ok(ref);
    assert.equal((await resolveChannelByName(server.id, grace.id, ref))?.channelId, dm.id, ref);
  }
});

test("sending to a bare shared name refuses to create a DM; the kind creates the right one", async ({ db }) => {
  const { server, bystander, agentTwin } = await seedTwins(db);

  await rejectsWith(resolveWritableAgentTarget(server.id, bystander.id, "dm:@Twin"), "DM_TARGET_AMBIGUOUS");

  const created = await resolveWritableAgentTarget(server.id, bystander.id, "dm:@Twin~agent");
  assert.ok(created && typeof created === "object" && created.type === "dm");
  const expected = await findOrCreateAgentDM(server.id, bystander.id, agentTwin.id);
  assert.equal(created.channelId, expected?.id);
});

test("replying under a kind-pinned DM creates the thread there, and only there", async ({ db }) => {
  const { server, grace, agentTwin, agentDm, humanDm } = await seedTwins(db);
  const [agentParent] = await db
    .insert(messages)
    .values({ channelId: agentDm.id, senderType: "agent", senderId: agentTwin.id, content: "agent parent" })
    .returning();
  const [humanParent] = await db
    .insert(messages)
    .values({ channelId: humanDm.id, senderType: "agent", senderId: grace.id, content: "human parent" })
    .returning();
  const agentShort = agentParent.id.slice(0, 8);

  // No thread exists yet: the pinned target must still create one.
  const created = await resolveWritableAgentTarget(server.id, grace.id, `dm:@Twin~agent:${agentShort}`);
  assert.ok(created && typeof created === "object" && created.type === "thread", String(created));
  assert.equal(await threadParentChannelId(db, created.channelId), agentDm.id);

  assert.equal(await resolveWritableAgentTarget(server.id, grace.id, `dm:@Twin~human:${agentShort}`), null);
  const humanThread = await resolveWritableAgentTarget(server.id, grace.id, `dm:@Twin~human:${humanParent.id.slice(0, 8)}`);
  assert.ok(humanThread && typeof humanThread === "object" && humanThread.type === "thread");
  assert.equal(await threadParentChannelId(db, humanThread.channelId), humanDm.id);

  // Once it exists, the thread's own id is held to the same kind.
  const threadShort = created.channelId.slice(0, 8);
  assert.equal((await resolveChannelByName(server.id, grace.id, `dm:@Twin~agent:${threadShort}`))?.channelId, created.channelId);
  assert.equal(await resolveChannelByName(server.id, grace.id, `dm:@Twin~human:${threadShort}`), null);
  assert.equal(await resolveChannelByName(server.id, grace.id, `dm:@Twin~human:${agentShort}`), null);
});

async function threadParentChannelId(db: Database, threadId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ channelId: messages.channelId })
    .from(channels)
    .innerJoin(messages, eq(messages.id, channels.parentMessageId))
    .where(eq(channels.id, threadId));
  return row?.channelId;
}
