import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/index";
import {
  notificationDeliveries,
  notificationEvents,
  notificationRecipients,
  oauthAccessTokens,
  oauthClientInstalls,
  oauthClients,
  users,
} from "../db/schema";
import { addMember, createServer, updateAgentMemberRole } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { createOAuthClient } from "../services/oauthService";
import { __setAppWebhookEncryptionKeyForTests, configureAppWebhook } from "../services/appWebhookConfigService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedUser(prefix: string, suffix: string) {
  const name = `${prefix}-${suffix.slice(0, 8)}`;
  const [user] = await getDb().insert(users).values({
    email: `${name}@slock.test`,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

/** A Server with an owner, two members, an agent and an app subscribed to server.member_removed. */
async function seedSubscribedServer(events: string[] = ["server.member_removed"]) {
  const suffix = randomUUID();
  const owner = await seedUser("sme-owner", suffix);
  const signedIn = await seedUser("sme-signed-in", suffix);
  const leaver = await seedUser("sme-leaver", suffix);
  const server = await createServer("Server Member Events", `server-member-events-${suffix.slice(0, 8)}`, owner.id);
  await addMember(server.id, signedIn.id, "member");
  await addMember(server.id, leaver.id, "admin");
  const agent = await createAgent(server.id, `MemberEventBot${suffix.slice(0, 4)}`, {
    runtime: "claude",
    model: "sonnet",
    creatorType: "user",
    creatorId: owner.id,
  });

  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    appType: "third_party_global",
    clientId: `sme-${suffix.slice(0, 8)}`,
    name: "Member Events App",
    returnUrl: "https://vault.example.test/callback",
  });
  await getDb().update(oauthClients).set({
    outboundCurrentGroups: ["server"],
    outboundCurrentEvents: events,
  }).where(eq(oauthClients.id, client.id));
  await getDb().insert(oauthClientInstalls).values({
    serverId: server.id,
    clientId: client.id,
    installedByUserId: owner.id,
    status: "active",
    approvedGroups: ["server"],
    subscribedEvents: events,
    grantRevision: 1,
    subscriptionRevision: 1,
  }).onConflictDoUpdate({
    target: [oauthClientInstalls.serverId, oauthClientInstalls.clientId],
    set: { approvedGroups: ["server"], subscribedEvents: events, status: "active" },
  });
  await configureAppWebhook({ clientId: client.id, actorUserId: owner.id, endpointUrl: "https://vault.example.test/raft" });

  // signedIn has a live Sign in with Raft token for this app on this Server.
  await getDb().insert(oauthAccessTokens).values({
    serverId: server.id,
    principalType: "human",
    userId: signedIn.id,
    clientId: client.id,
    tokenHash: `sme-${suffix}`,
    scopes: ["openid", "profile"],
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return { owner, signedIn, leaver, server, agent, client };
}

async function memberRemovedEvents(serverId: string) {
  return memberEvents(serverId, "server.member_removed");
}

async function memberEvents(serverId: string, eventType: string) {
  const rows = await getDb().select({
    event: notificationEvents,
    deliveryStatus: notificationDeliveries.status,
  }).from(notificationEvents)
    .innerJoin(notificationRecipients, eq(notificationRecipients.eventId, notificationEvents.id))
    .innerJoin(notificationDeliveries, eq(notificationDeliveries.notificationId, notificationRecipients.id))
    .where(and(eq(notificationEvents.serverId, serverId), eq(notificationEvents.eventType, eventType)));
  return rows.map(({ event, deliveryStatus }) => ({
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    provenance: event.provenance,
    deliveryQueued: deliveryStatus === "pending" || deliveryStatus === "processing" || deliveryStatus === "suppressed" || deliveryStatus === "delivered",
  }));
}

function serverHeaders(token: string, serverId: string) {
  return { Authorization: `Bearer ${token}`, "X-Server-Id": serverId, "Content-Type": "application/json" };
}

test.beforeEach(() => {
  __setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 7));
});

test.afterEach(() => {
  __setAppWebhookEncryptionKeyForTests(null);
});

test("an admin removal queues server.member_removed in the same commit and revokes the member's sign-in tokens", async ({ app }) => {
  const { owner, signedIn, server } = await seedSubscribedServer();
  const ownerToken = await tokenForHuman(owner.email);

  const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${signedIn.id}`, {
    method: "DELETE",
    headers: serverHeaders(ownerToken, server.id),
  });
  assert.equal(res.status, 200);

  assert.deepEqual(await memberRemovedEvents(server.id), [{
    subjectType: "member",
    subjectId: signedIn.id,
    provenance: { actor_type: "human", principal_type: "human", reason: "removed", role: "member", source: "server_service" },
    deliveryQueued: true,
  }]);
  const tokens = await getDb().select({ revokedAt: oauthAccessTokens.revokedAt }).from(oauthAccessTokens)
    .where(and(eq(oauthAccessTokens.serverId, server.id), eq(oauthAccessTokens.userId, signedIn.id)));
  assert.equal(tokens.length, 1);
  assert.ok(tokens[0]!.revokedAt instanceof Date, "a removed member must sign in again after rejoining");
});

test("leaving a Server queues server.member_removed with reason left", async ({ app }) => {
  const { leaver, server } = await seedSubscribedServer();
  const leaverToken = await tokenForHuman(leaver.email);

  const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/leave`, {
    method: "POST",
    headers: serverHeaders(leaverToken, server.id),
  });
  assert.equal(res.status, 200);

  const events = await memberRemovedEvents(server.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.subjectId, leaver.id);
  assert.deepEqual(events[0]!.provenance, {
    actor_type: "human", principal_type: "human", reason: "left", role: "admin", source: "server_service",
  });
});

test("deleting an agent queues server.member_removed for the agent", async ({ app }) => {
  const { owner, agent, server } = await seedSubscribedServer();
  const ownerToken = await tokenForHuman(owner.email);

  const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
    method: "DELETE",
    headers: serverHeaders(ownerToken, server.id),
  });
  assert.equal(res.status, 200);

  const events = await memberRemovedEvents(server.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.subjectId, agent.id);
  assert.equal(events[0]!.provenance.principal_type, "agent");
  assert.equal(events[0]!.provenance.reason, "removed");
});

test("deleting a Server announces every member's removal before the tombstone", async ({ app }) => {
  const { owner, signedIn, leaver, agent, server } = await seedSubscribedServer();
  const ownerToken = await tokenForHuman(owner.email);

  const res = await fetch(`${app.baseUrl}/api/servers/${server.id}`, {
    method: "DELETE",
    headers: serverHeaders(ownerToken, server.id),
  });
  assert.equal(res.status, 200);

  const events = await memberRemovedEvents(server.id);
  assert.deepEqual(
    events.map((event) => event.subjectId).sort(),
    [owner.id, signedIn.id, leaver.id, agent.id].sort(),
  );
  assert.ok(events.every((event) => event.provenance.reason === "server_deleted" && event.deliveryQueued));

  // A repeated delete of an already-deleted Server announces nothing new.
  await fetch(`${app.baseUrl}/api/servers/${server.id}`, { method: "DELETE", headers: serverHeaders(ownerToken, server.id) });
  const again = await getDb().select({ id: notificationEvents.id }).from(notificationEvents)
    .where(and(eq(notificationEvents.serverId, server.id), inArray(notificationEvents.eventType, ["server.member_removed"])));
  assert.equal(again.length, 4);
});

test("joining through a join link queues server.member_added; a role change queues server.member_role_changed", async ({ app }) => {
  const { owner, signedIn, server } = await seedSubscribedServer(["server.member_added", "server.member_role_changed"]);
  const ownerToken = await tokenForHuman(owner.email);
  const joiner = await seedUser("sme-joiner", randomUUID());

  const link = await fetch(`${app.baseUrl}/api/servers/${server.id}/join-links`, {
    method: "POST",
    headers: serverHeaders(ownerToken, server.id),
    body: JSON.stringify({ maxUses: 1 }),
  });
  assert.equal(link.status, 200);
  const { token: joinToken } = await link.json() as { token: string };
  const accepted = await fetch(`${app.baseUrl}/api/auth/accept-invite`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await tokenForHuman(joiner.email)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ token: joinToken }),
  });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const added = await memberEvents(server.id, "server.member_added");
  assert.deepEqual(added.map((event) => [event.subjectId, event.provenance.principal_type, event.provenance.role]), [[joiner.id, "human", "member"]]);
  assert.ok(added[0]!.deliveryQueued);

  const promote = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${signedIn.id}`, {
    method: "PATCH",
    headers: serverHeaders(ownerToken, server.id),
    body: JSON.stringify({ role: "admin" }),
  });
  assert.equal(promote.status, 200, await promote.clone().text());
  const changed = await memberEvents(server.id, "server.member_role_changed");
  assert.deepEqual(changed.map((event) => event.provenance), [{
    actor_type: "human", previous_role: "member", principal_type: "human", role: "admin", source: "server_service",
  }]);
  assert.equal(changed[0]!.subjectId, signedIn.id);
});

test("an agent joining and changing role queues the same member events", async ({ db }) => {
  void db;
  const { owner, server } = await seedSubscribedServer(["server.member_added", "server.member_role_changed"]);
  const agent = await createAgent(server.id, `JoinBot${randomUUID().slice(0, 4)}`, {
    runtime: "claude",
    model: "sonnet",
    creatorType: "user",
    creatorId: owner.id,
  });
  const added = await memberEvents(server.id, "server.member_added");
  assert.deepEqual(added.map((event) => [event.subjectId, event.provenance.principal_type, event.provenance.reason]), [[agent.id, "agent", "created"]]);

  await updateAgentMemberRole(server.id, agent.id, "admin");
  await updateAgentMemberRole(server.id, agent.id, "admin");
  const changed = await memberEvents(server.id, "server.member_role_changed");
  assert.equal(changed.length, 1, "setting the same role again is not a change");
  assert.deepEqual(changed[0]!.provenance, {
    actor_type: "human", previous_role: "member", principal_type: "agent", role: "admin", source: "server_service",
  });
});
