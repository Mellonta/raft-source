import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { serverAgentMembers } from "../db/schema";
import { addMember } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { addAgent, getChannel, isChannelAgent, isChannelHuman } from "../services/channelService";
import { createServer, headers, installFakeIo, seedUser } from "./channels.api.fixtures";
import { setChannelArchivedForAgent } from "./agentChannelLifecycle";
import { addChannelMemberForAgent, removeChannelMemberForAgent } from "./agentChannelMembers";
import { updateChannelForAgent } from "./agentChannelUpdate";

// Joint channel parity, agent side (#proj-joint-channel:6a2a81a9, t1–t4): an
// agent can leave, manage members of, edit, and archive a joint channel the
// same way a human admin can. Each case also pins that the other server's
// projection and members are untouched, or updated together where the state
// is shared (name, archive).

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function setupJoint(app: { baseUrl: string }, label: string) {
  const suffix = randomUUID().slice(0, 8);
  const hostOwner = await seedUser(`${label}-host-${suffix}@slock.test`, `${label}-host-${suffix}`);
  const targetOwner = await seedUser(`${label}-target-${suffix}@slock.test`, `${label}-target-${suffix}`);
  const hostServer = await createServer(`${label} host`, `${label}-host-${suffix}`, hostOwner.id);
  const targetServer = await createServer(`${label} target`, `${label}-target-${suffix}`, targetOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);
  const targetToken = await tokenForHuman(targetOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: `${label}-room-${suffix}`,
      visibility: "joint",
      targetServerSlug: targetServer.slug,
      invitedPeople: [`@${targetOwner.name}`],
    }),
  });
  assert.equal(createRes.status, 200);
  const hostProjection = await createRes.json() as { id: string; jointInvite: { id: string } };
  const acceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(acceptRes.status, 200);
  const targetProjection = await acceptRes.json() as { id: string };

  const agent = await createAgent(hostServer.id, `${label}-agent-${suffix}`, { runtime: "codex" });
  await getDb().update(serverAgentMembers).set({ role: "admin" }).where(and(
    eq(serverAgentMembers.serverId, hostServer.id),
    eq(serverAgentMembers.agentId, agent.id),
  ));
  await addAgent(hostProjection.id, agent.id);

  return {
    hostServer,
    targetServer,
    targetOwner,
    hostProjectionId: hostProjection.id,
    targetProjectionId: targetProjection.id,
    agent,
    actor: { id: agent.id, name: agent.name, serverId: hostServer.id },
  };
}

test("an agent can leave a joint channel without touching the other server's members", async ({ app }) => {
  const f = await setupJoint(app, "joint-leave");
  const credential = await mintAgentCredential({
    agentId: f.agent.id,
    scopes: ["channels"],
    name: "joint-leave-test",
    createdByUserId: null,
  });
  // The test orchestrator has no inbox; record the purge the route requests.
  const purges: Array<{ agentId: string; channelId: string; reason?: string }> = [];
  const orchestrator = app.app.get("agentOrchestrator") as {
    purgeAgentInboxForChannelTree: (agentId: string, channelId: string, reason?: string) => Promise<unknown>;
  };
  orchestrator.purgeAgentInboxForChannelTree = async (agentId, channelId, reason) => {
    purges.push({ agentId, channelId, reason });
  };

  const res = await fetch(`${app.baseUrl}/internal/agent-api/channels/${f.hostProjectionId}/leave`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential.apiKey}`, "Content-Type": "application/json" },
  });
  assert.equal(res.status, 200);
  assert.equal(await isChannelAgent(f.hostProjectionId, f.agent.id), false);
  assert.deepEqual(purges, [{ agentId: f.agent.id, channelId: f.hostProjectionId, reason: "channel_membership_removed" }]);
  assert.equal(await isChannelHuman(f.targetProjectionId, f.targetOwner.id), true);
});

test("an admin agent adds and removes its own server's members in a joint channel, but not the other server's", async ({ app }) => {
  const f = await setupJoint(app, "joint-members");
  const suffix = randomUUID().slice(0, 8);
  const hostMember = await seedUser(`joint-members-local-${suffix}@slock.test`, `joint-members-local-${suffix}`);
  await addMember(f.hostServer.id, hostMember.id, "member");

  const added = await addChannelMemberForAgent({
    actor: f.actor,
    serverId: f.hostServer.id,
    channelId: f.hostProjectionId,
    body: { userId: hostMember.id },
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(await isChannelHuman(f.hostProjectionId, hostMember.id), true);

  // Candidates resolve from the acting server only: the other server's owner
  // is not addressable through this server's projection.
  const crossServer = await addChannelMemberForAgent({
    actor: f.actor,
    serverId: f.hostServer.id,
    channelId: f.hostProjectionId,
    body: { userId: f.targetOwner.id },
  });
  assert.notEqual(crossServer.status, 200);
  assert.equal(await isChannelHuman(f.hostProjectionId, f.targetOwner.id), false);

  // Nor can it remove the other server's members from the shared channel.
  const crossServerRemove = await removeChannelMemberForAgent({
    actor: f.actor,
    serverId: f.hostServer.id,
    channelId: f.hostProjectionId,
    body: { userId: f.targetOwner.id },
  });
  assert.notEqual(crossServerRemove.status, 200);
  assert.equal(await isChannelHuman(f.targetProjectionId, f.targetOwner.id), true);

  const removed = await removeChannelMemberForAgent({
    actor: f.actor,
    serverId: f.hostServer.id,
    channelId: f.hostProjectionId,
    body: { userId: hostMember.id },
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(await isChannelHuman(f.hostProjectionId, hostMember.id), false);
  assert.equal(await isChannelHuman(f.targetProjectionId, f.targetOwner.id), true);
});

test("an admin agent renames a joint channel for every server and cannot change its visibility", async ({ app }) => {
  const f = await setupJoint(app, "joint-edit");
  const events = installFakeIo(app.app);
  const newName = `joint-renamed-${randomUUID().slice(0, 8)}`;

  const updated = await updateChannelForAgent({
    actor: f.actor,
    serverId: f.hostServer.id,
    channelId: f.hostProjectionId,
    body: { name: newName, description: "shared description" },
    io: app.app.get("io"),
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal((await getChannel(f.hostProjectionId))?.name, newName);
  assert.equal((await getChannel(f.targetProjectionId))?.name, newName);
  // The other server's open clients get the new metadata without a reload.
  assert.ok(
    events.some((event) => event.room === `channel:${f.targetProjectionId}` && event.event === "channel:updated"),
    "the other server's projection must receive channel:updated",
  );

  const visibility = await updateChannelForAgent({
    actor: f.actor,
    serverId: f.hostServer.id,
    channelId: f.hostProjectionId,
    body: { visibility: "public" },
  });
  assert.notEqual(visibility.status, 200);
  assert.equal((await getChannel(f.hostProjectionId))?.type, "joint");
});

test("an admin agent archives and unarchives a joint channel for every server; an ordinary agent cannot", async ({ app }) => {
  const f = await setupJoint(app, "joint-archive");

  const ordinary = await createAgent(f.hostServer.id, `joint-archive-member-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  await addAgent(f.hostProjectionId, ordinary.id);
  const denied = await setChannelArchivedForAgent({
    actor: { id: ordinary.id, name: ordinary.name, serverId: f.hostServer.id },
    serverId: f.hostServer.id,
    channelId: f.hostProjectionId,
    archived: true,
  });
  assert.equal(denied.status, 403);
  assert.equal((await getChannel(f.targetProjectionId))?.archivedAt, null);

  const events = installFakeIo(app.app);
  const archived = await setChannelArchivedForAgent({
    actor: f.actor,
    serverId: f.hostServer.id,
    channelId: f.hostProjectionId,
    archived: true,
    io: app.app.get("io"),
  });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.ok((await getChannel(f.hostProjectionId))?.archivedAt);
  assert.ok((await getChannel(f.targetProjectionId))?.archivedAt);
  assert.ok(
    events.some((event) => event.room === `channel:${f.targetProjectionId}` && event.event === "channel:updated"),
    "the other server's projection must receive channel:updated",
  );

  const unarchived = await setChannelArchivedForAgent({
    actor: f.actor,
    serverId: f.hostServer.id,
    channelId: f.hostProjectionId,
    archived: false,
  });
  assert.equal(unarchived.status, 200, JSON.stringify(unarchived.body));
  assert.equal((await getChannel(f.hostProjectionId))?.archivedAt, null);
  assert.equal((await getChannel(f.targetProjectionId))?.archivedAt, null);
});
