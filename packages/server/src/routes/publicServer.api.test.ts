import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { openTestApp } from "../test/integration/app";
import { getDb } from "../db/index";
import {
  agents,
  channelHumans,
  channels,
  featureFlags,
  messages,
  serverMembers,
  serverInvites,
  serverMembershipAgreementAudit,
  servers,
  users,
} from "../db/schema";
import { createChannel, getOrCreateThread, updateChannel } from "../services/channelService";
import { createServer, seedUser, headers } from "./channels.api.fixtures";
import { tokenForHuman } from "../test/integration/credentials";
import { addMember } from "../services/serverService";
import { createMessage } from "../services/messageService";
import * as serverAgreementService from "../services/serverAgreementService";
import { PUBLIC_SERVER_FEATURE_FLAG_KEY, SERVER_GUEST_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

async function enablePublicServerFeature() {
  await getDb().update(featureFlags)
    .set({ enabled: true, killSwitch: false, defaultEnabled: true })
    .where(eq(featureFlags.key, PUBLIC_SERVER_FEATURE_FLAG_KEY));
}

async function enablePublicGuestJoinFeatures() {
  await enablePublicServerFeature();
  await getDb().update(featureFlags)
    .set({ enabled: true, killSwitch: false, defaultEnabled: true })
    .where(eq(featureFlags.key, SERVER_GUEST_FEATURE_FLAG_KEY));
}

/**
 * Task #70, hard requirement 2 (@cindyz): turning `public` off must refuse the
 * same reader's next request, not just prevent a new anonymous session/token.
 *
 * The dangerous way to pass this is a test that only ever issues fresh requests
 * after the flip using a new app — that would stay green even if the running
 * process cached the decision. So this drives the SAME endpoint on the SAME
 * running app before and after, with nothing in between but the column change.
 */
test("public server: a logged-out reader loses access the moment the toggle goes off", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    await enablePublicServerFeature();
    const owner = await seedUser("public-server-owner@slock.test", "public-server-owner");
    const server = await createServer("Public Server", "public-server-70", owner.id);

    const open = await createChannel(server.id, "open-channel", undefined, "channel", { type: "user", id: owner.id });
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, open.id));
    await db.update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));

    // No Authorization header anywhere in this test. That is the point.
    const listUrl = `${app.baseUrl}/api/public/servers/public-server-70`;
    const msgsUrl = `${app.baseUrl}/api/public/servers/public-server-70/channels/${open.id}/messages`;

    const before = await fetch(listUrl);
    assert.equal(before.status, 200, await before.clone().text());
    assert.equal(before.headers.get("cache-control"), "no-store", "a browser or CDN must not carry a public decision past the next request");
    const body = await before.json() as { channels: { id: string }[] };
    assert.deepEqual(body.channels.map((c) => c.id), [open.id], "only the guest-visible ordinary channel is offered");

    const readBefore = await fetch(msgsUrl);
    assert.equal(readBefore.status, 200, "a stranger can read the guest-visible channel while public is on");
    assert.equal(readBefore.headers.get("cache-control"), "no-store");

    // The flip. Nothing else changes: same app, same process, same URLs.
    await db.update(servers).set({ publiclyVisible: false }).where(eq(servers.id, server.id));

    const afterList = await fetch(listUrl);
    assert.equal(afterList.status, 404, "the server card must disappear immediately");
    const afterRead = await fetch(msgsUrl);
    assert.equal(afterRead.status, 404, "the same reader's next page request must fail without waiting for cache expiry");
  } finally {
    await app.close();
  }
});

test("public server: rollout flag defaults closed at owner and anonymous boundaries", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    const owner = await seedUser("public-gate-owner@slock.test", "public-gate-owner");
    const server = await createServer("Gated", "public-gated-70", owner.id);
    const channel = await createChannel(server.id, "would-be-public", undefined, "channel", { type: "user", id: owner.id });
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, channel.id));
    await db.update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));
    const ownerToken = await tokenForHuman(owner.email);
    const ownerUrl = `${app.baseUrl}/api/servers/${server.id}/public-visibility`;

    const ownerRead = await fetch(ownerUrl, { headers: headers(ownerToken, server.id) });
    assert.equal(ownerRead.status, 404, "the owner read must fail closed while rollout is off");
    const ownerWrite = await fetch(ownerUrl, {
      method: "PATCH",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ publiclyVisible: false }),
    });
    assert.equal(ownerWrite.status, 404, "the owner write must fail closed while rollout is off");

    const publicList = await fetch(`${app.baseUrl}/api/public/servers/public-gated-70`);
    const publicRead = await fetch(`${app.baseUrl}/api/public/servers/public-gated-70/channels/${channel.id}/messages`);
    const missing = await fetch(`${app.baseUrl}/api/public/servers/does-not-exist-70`);
    assert.equal(publicList.status, 404);
    assert.equal(publicRead.status, 404);
    assert.equal(await publicList.text(), await missing.text(), "flag-off and nonexistent slugs must have byte-identical bodies");

    const [unchanged] = await db.select({ v: servers.publiclyVisible }).from(servers).where(eq(servers.id, server.id));
    assert.equal(unchanged.v, true, "a refused owner PATCH must leave the stored setting untouched");
  } finally {
    await app.close();
  }
});

/**
 * The surface must be exactly "ordinary channels the owner marked guest-visible".
 * `guestVisible` alone is not the predicate: it exists on other channel kinds too,
 * so the route requires type = "channel" explicitly. Each negative below is a
 * separate way the surface could widen without anyone intending it.
 */
test("public server: the anonymous surface is only guest-visible ordinary channels", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    await enablePublicServerFeature();
    const owner = await seedUser("public-surface-owner@slock.test", "public-surface-owner");
    const server = await createServer("Surface", "public-surface-70", owner.id);
    await db.update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));

    const creator = { type: "user" as const, id: owner.id };
    const visible = await createChannel(server.id, "visible", undefined, "channel", creator);
    const notMarked = await createChannel(server.id, "not-marked", undefined, "channel", creator);
    const privateMarked = await createChannel(server.id, "private-marked", undefined, "private", creator);
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, visible.id));
    // A private channel that is ALSO marked guest-visible: the trap this predicate exists for.
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, privateMarked.id));

    const listed = await (await fetch(`${app.baseUrl}/api/public/servers/public-surface-70`)).json() as { channels: { id: string }[] };
    assert.deepEqual(listed.channels.map((c) => c.id), [visible.id], "a guest-visible PRIVATE channel must not be listed");

    for (const [label, id] of [["unmarked ordinary", notMarked.id], ["guest-visible private", privateMarked.id]] as const) {
      const res = await fetch(`${app.baseUrl}/api/public/servers/public-surface-70/channels/${id}/messages`);
      assert.equal(res.status, 404, `${label} channel must not be readable anonymously`);
    }

    // A non-public server is indistinguishable from one that does not exist,
    // so this endpoint cannot be used to enumerate slugs.
    const other = await createServer("Private Server", "private-server-70", owner.id);
    assert.ok(other.id);
    const probe = await fetch(`${app.baseUrl}/api/public/servers/private-server-70`);
    assert.equal(probe.status, 404, "a non-public server must 404, not 403");

    const [stillPrivate] = await db.select({ v: servers.publiclyVisible }).from(servers)
      .where(and(eq(servers.slug, "private-server-70")));
    assert.equal(stillPrivate.v, false, "probing must not have changed anything");
  } finally {
    await app.close();
  }
});

test("public server: making an ordinary channel private clears both Guest audience flags", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const owner = await seedUser("public-private-policy-owner@slock.test", "public-private-policy-owner");
    const server = await createServer("Policy", "public-private-policy-70", owner.id);
    const channel = await createChannel(server.id, "before-private", undefined, "channel", { type: "user", id: owner.id });

    await updateChannel(channel.id, { guestVisible: true, guestJoinable: true });
    const updated = await updateChannel(channel.id, { type: "private" });

    assert.equal(updated.type, "private");
    assert.equal(updated.guestVisible, false, "a private channel must not retain the anonymous audience marker");
    assert.equal(updated.guestJoinable, false, "a private channel must not retain Guest join authority");
  } finally {
    await app.close();
  }
});

test("public server: anonymous message history is a narrow public projection", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    await enablePublicServerFeature();
    const owner = await seedUser("public-projection-owner@slock.test", "public-projection-owner");
    const publicAvatarUrl = `/api/avatars/users/${"a".repeat(32)}.webp`;
    await db.update(users).set({
      avatarUrl: publicAvatarUrl,
      description: "Public profile description",
    }).where(eq(users.id, owner.id));
    const server = await createServer("Projection", "public-projection-70", owner.id);
    const channel = await createChannel(server.id, "public-projection", undefined, "channel", { type: "user", id: owner.id });
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, channel.id));
    await db.update(servers).set({
      publiclyVisible: true,
      avatarUrl: "https://third-party.example.test/server-avatar.png?signature=secret",
    }).where(eq(servers.id, server.id));
    const externalServerAvatar = await (await fetch(`${app.baseUrl}/api/public/servers/public-projection-70`)).json() as { server: { avatarUrl: string | null } };
    assert.equal(externalServerAvatar.server.avatarUrl, null, "third-party server avatars must not cross the anonymous boundary");
    const storedServerAvatar = `/api/avatars/server-${server.id}/${"c".repeat(32)}.webp`;
    await db.update(servers).set({ avatarUrl: storedServerAvatar }).where(eq(servers.id, server.id));
    const storedServerProjection = await (await fetch(`${app.baseUrl}/api/public/servers/public-projection-70`)).json() as { server: { avatarUrl: string | null } };
    assert.equal(storedServerProjection.server.avatarUrl, storedServerAvatar);
    const message = await createMessage(channel.id, "user", owner.id, "Public words only");
    await db.update(messages).set({
      actionMetadata: { kind: "action-card", secretControlPlaneFact: "must-not-leak" },
      taskStatus: "in_progress",
      taskAssigneeId: owner.id,
      taskAssigneeType: "user",
    }).where(eq(messages.id, message.id));

    const response = await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/channels/${channel.id}/messages`);
    assert.equal(response.status, 200);
    const body = await response.json() as { messages: Array<Record<string, unknown>> };
    assert.equal(body.messages.length, 1);
    assert.deepEqual(Object.keys(body.messages[0]!).sort(), [
      "content", "createdAt", "id", "messageType", "replyCount", "sender", "senderType", "threadId",
    ]);
    assert.equal(body.messages[0]!.content, "Public words only");
    assert.deepEqual(body.messages[0]!.sender, {
      displayName: owner.displayName || owner.name,
      avatarUrl: publicAvatarUrl,
      description: "Public profile description",
    });
    assert.equal(JSON.stringify(body).includes("must-not-leak"), false);
    assert.equal(JSON.stringify(body).includes(owner.id), false, "anonymous DTO must not expose actor ids");

    const storedAgentAvatar = `/api/avatars/${server.id}/${"b".repeat(32)}.webp`;
    const [storedAgent] = await db.insert(agents).values({
      serverId: server.id,
      name: "stored-avatar-agent",
      displayName: "Stored Avatar Agent",
      avatarUrl: storedAgentAvatar,
      description: "Public agent description",
    }).returning();
    const [externalAgent] = await db.insert(agents).values({
      serverId: server.id,
      name: "external-avatar-agent",
      displayName: "External Avatar Agent",
      avatarUrl: "https://third-party.example.test/private-avatar.png?signature=secret",
      description: "External avatar is filtered",
    }).returning();
    const storedAgentMessage = await createMessage(channel.id, "agent", storedAgent.id, "Stored agent avatar");
    const externalAgentMessage = await createMessage(channel.id, "agent", externalAgent.id, "External agent avatar");
    const otherServer = await createServer("Other Projection", "other-public-projection-70", owner.id);
    const otherServerAvatar = `/api/avatars/${otherServer.id}/${"d".repeat(32)}.webp`;
    const [otherServerAgent] = await db.insert(agents).values({
      serverId: otherServer.id,
      name: "other-server-agent",
      displayName: "Other Server Secret Agent",
      avatarUrl: otherServerAvatar,
      description: "Must not cross the server boundary",
    }).returning();
    const otherServerAgentMessage = await createMessage(channel.id, "agent", otherServerAgent.id, "Cross-server agent id");
    const agentProjection = await (await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/channels/${channel.id}/messages`)).json() as {
      messages: Array<{ id: string; sender: { displayName: string; avatarUrl: string | null; description: string | null } }>;
    };
    assert.deepEqual(agentProjection.messages.find((row) => row.id === storedAgentMessage.id)?.sender, {
      displayName: "Stored Avatar Agent",
      avatarUrl: storedAgentAvatar,
      description: "Public agent description",
    });
    assert.deepEqual(agentProjection.messages.find((row) => row.id === externalAgentMessage.id)?.sender, {
      displayName: "External Avatar Agent",
      avatarUrl: null,
      description: "External avatar is filtered",
    }, "third-party or signed avatar URLs must not cross the anonymous boundary");
    assert.deepEqual(agentProjection.messages.find((row) => row.id === otherServerAgentMessage.id)?.sender, {
      displayName: "Unknown agent",
      avatarUrl: null,
      description: null,
    }, "an agent id from another server must not project that server's profile data");

    const thread = await getOrCreateThread(message.id, owner.id, "user");
    const reply = await createMessage(thread.id, "user", owner.id, "> quoted\n\n**reply**");
    const newerReply = await createMessage(thread.id, "user", owner.id, "newer reply");
    const withThread = await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/channels/${channel.id}/messages`);
    const withThreadBody = await withThread.json() as { messages: Array<{ id: string; threadId: string | null; replyCount: number }> };
    const parentProjection = withThreadBody.messages.find((row) => row.id === message.id);
    assert.deepEqual(parentProjection && {
      id: parentProjection.id,
      threadId: parentProjection.threadId,
      replyCount: parentProjection.replyCount,
    }, {
      id: message.id,
      threadId: thread.id,
      replyCount: 2,
    });
    const threadResponse = await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/threads/${thread.id}/messages`);
    assert.equal(threadResponse.status, 200);
    const threadBody = await threadResponse.json() as { messages: Array<Record<string, unknown>> };
    assert.equal(threadBody.messages[0]?.id, reply.id);
    assert.equal(threadBody.messages[0]?.content, "> quoted\n\n**reply**");
    assert.equal(JSON.stringify(threadBody).includes(owner.id), false, "public thread DTO must not expose actor ids");
    const latestThreadPage = await (await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/threads/${thread.id}/messages?limit=1`)).json() as { messages: Array<{ id: string }> };
    assert.deepEqual(latestThreadPage.messages.map((row) => row.id), [newerReply.id]);
    const olderThreadPage = await (await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/threads/${thread.id}/messages?limit=1&beforeMessageId=${newerReply.id}`)).json() as { messages: Array<{ id: string }> };
    assert.deepEqual(olderThreadPage.messages.map((row) => row.id), [reply.id], "public thread pagination must page beyond the latest window");

    await db.update(featureFlags).set({ killSwitch: true }).where(eq(featureFlags.key, PUBLIC_SERVER_FEATURE_FLAG_KEY));
    const killedThread = await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/threads/${thread.id}/messages`);
    assert.equal(killedThread.status, 404, "the Public kill switch must close the thread route too");
    await db.update(featureFlags).set({ killSwitch: false }).where(eq(featureFlags.key, PUBLIC_SERVER_FEATURE_FLAG_KEY));

    const second = await createMessage(channel.id, "user", owner.id, "Second public message");
    const older = await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/channels/${channel.id}/messages?beforeMessageId=${second.id}`);
    assert.equal(older.status, 200);
    const olderBody = await older.json() as { messages: Array<{ id: string }> };
    assert.deepEqual(
      olderBody.messages.map((row) => row.id),
      [message.id, storedAgentMessage.id, externalAgentMessage.id, otherServerAgentMessage.id],
      "message-id cursor pages only within its channel",
    );

    const other = await createChannel(server.id, "other-public", undefined, "channel", { type: "user", id: owner.id });
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, other.id));
    const otherMessage = await createMessage(other.id, "user", owner.id, "Other channel");
    const crossed = await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/channels/${channel.id}/messages?beforeMessageId=${otherMessage.id}`);
    assert.equal(crossed.status, 404, "a cursor from another channel must not become an oracle or pagination boundary");

    await db.update(channels).set({ guestVisible: false }).where(eq(channels.id, channel.id));
    const revokedThread = await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/threads/${thread.id}/messages`);
    assert.equal(revokedThread.status, 404, "thread access must disappear with its public parent on the next request");
  } finally {
    await app.close();
  }
});

/**
 * The toggle is OWNER-only, and that is the whole reason it is its own endpoint.
 *
 * The obvious implementation — a field on `PATCH /servers/:id` — is gated on
 * `editServerSettings`, which ADMINS also hold. Folding it in would have handed
 * "make this server readable by the entire internet" to every admin, and nothing
 * in that route would have looked wrong. This test is the thing that would go red.
 */
test("public server: only the owner can flip the toggle, not an admin", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    await enablePublicServerFeature();
    const owner = await seedUser("pv-owner@slock.test", "pv-owner");
    const admin = await seedUser("pv-admin@slock.test", "pv-admin");
    const server = await createServer("Toggle", "public-toggle-70", owner.id);
    await addMember(server.id, admin.id, "admin");
    const ownerToken = await tokenForHuman(owner.email);
    const adminToken = await tokenForHuman(admin.email);

    const open = await createChannel(server.id, "open", undefined, "channel", { type: "user", id: owner.id });
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, open.id));

    const url = `${app.baseUrl}/api/servers/${server.id}/public-visibility`;

    // The admin holds editServerSettings and is still refused, on both verbs.
    const adminRead = await fetch(url, { headers: headers(adminToken, server.id) });
    assert.equal(adminRead.status, 403, "an admin must not even read the public-visibility state");
    const adminWrite = await fetch(url, {
      method: "PATCH",
      headers: headers(adminToken, server.id),
      body: JSON.stringify({ publiclyVisible: true }),
    });
    assert.equal(adminWrite.status, 403, "an admin must not be able to publish the server");

    const [untouched] = await db.select({ v: servers.publiclyVisible }).from(servers).where(eq(servers.id, server.id));
    assert.equal(untouched.v, false, "the refused admin write must not have changed anything");

    // The owner can, and the read tells the UI exactly what becomes world-readable.
    const ownerRead = await fetch(url, { headers: headers(ownerToken, server.id) });
    assert.equal(ownerRead.status, 200, await ownerRead.clone().text());
    const state = await ownerRead.json() as { publiclyVisible: boolean; exposedChannels: { id: string }[] };
    assert.equal(state.publiclyVisible, false);
    assert.deepEqual(state.exposedChannels.map((c) => c.id), [open.id],
      "the owner is shown the exact channel list that becomes world-readable");

    const ownerWrite = await fetch(url, {
      method: "PATCH",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ publiclyVisible: true }),
    });
    assert.equal(ownerWrite.status, 200, await ownerWrite.clone().text());

    // And the toggle is wired to the same column the anonymous route reads —
    // proving the owner-facing control and the public surface cannot drift apart.
    const anon = await fetch(`${app.baseUrl}/api/public/servers/public-toggle-70`);
    assert.equal(anon.status, 200, "flipping the owner toggle must open the anonymous surface");
  } finally {
    await app.close();
  }
});

test("public Guest admission is owner-only, depends on Public, and is cleared when Public turns off", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    await enablePublicGuestJoinFeatures();
    const owner = await seedUser("public-join-owner@slock.test", "public-join-owner");
    const admin = await seedUser("public-join-admin@slock.test", "public-join-admin");
    const server = await createServer("Join Controls", "public-join-controls-74", owner.id);
    await addMember(server.id, admin.id, "admin");
    const ownerToken = await tokenForHuman(owner.email);
    const adminToken = await tokenForHuman(admin.email);
    const url = `${app.baseUrl}/api/servers/${server.id}/public-guest-join`;

    const beforePublic = await fetch(url, {
      method: "PATCH",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ publicGuestJoinEnabled: true }),
    });
    assert.equal(beforePublic.status, 409, "Guest admission cannot open before Public access");

    const adminAttempt = await fetch(url, {
      method: "PATCH",
      headers: headers(adminToken, server.id),
      body: JSON.stringify({ publicGuestJoinEnabled: true }),
    });
    assert.equal(adminAttempt.status, 403, "admin must not control public admission");

    await db.update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));
    const opened = await fetch(url, {
      method: "PATCH",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ publicGuestJoinEnabled: true }),
    });
    assert.equal(opened.status, 200, await opened.clone().text());

    const publicReadback = await (await fetch(`${app.baseUrl}/api/public/servers/public-join-controls-74`)).json() as { canJoinAsGuest: boolean };
    assert.equal(publicReadback.canJoinAsGuest, true);

    const closed = await fetch(`${app.baseUrl}/api/servers/${server.id}/public-visibility`, {
      method: "PATCH",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ publiclyVisible: false }),
    });
    assert.equal(closed.status, 200, await closed.clone().text());
    const closedBody = await closed.json() as { publicGuestJoinEnabled: boolean };
    assert.equal(closedBody.publicGuestJoinEnabled, false, "Public OFF must clear public Guest admission in the same write");
    const [stored] = await db.select({ publiclyVisible: servers.publiclyVisible, publicGuestJoinEnabled: servers.publicGuestJoinEnabled })
      .from(servers).where(eq(servers.id, server.id));
    assert.deepEqual(stored, { publiclyVisible: false, publicGuestJoinEnabled: false });
  } finally {
    await app.close();
  }
});

test("authenticated public self-join is explicit Guest-only, agreement-gated, and idempotent", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    await enablePublicGuestJoinFeatures();
    const owner = await seedUser("public-join2-owner@slock.test", "public-join2-owner");
    const visitor = await seedUser("public-join-visitor@slock.test", "public-join-visitor");
    const server = await createServer("Join Target", "public-join-target-74", owner.id);
    await db.update(servers).set({ publiclyVisible: true, publicGuestJoinEnabled: true }).where(eq(servers.id, server.id));
    const agreement = await serverAgreementService.configureAgreement(server.id, owner.id, {
      enabled: true,
      title: "Guest rules",
      bodyMarkdown: "Be kind.",
    });
    assert.ok(agreement);
    const url = `${app.baseUrl}/api/public/servers/public-join-target-74/join-as-guest`;

    const anonymous = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(anonymous.status, 401);
    let rows = await db.select().from(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, visitor.id)));
    assert.equal(rows.length, 0, "anonymous refusal must leave no membership side effect");

    const token = await tokenForHuman(visitor.email);
    const needsAgreement = await fetch(url, { method: "POST", headers: headers(token, server.id), body: "{}" });
    assert.equal(needsAgreement.status, 409);
    const agreementBody = await needsAgreement.json() as { error: string; agreement: { id: string } };
    assert.equal(agreementBody.error, "agreement_required");
    assert.equal(agreementBody.agreement.id, agreement.id);
    rows = await db.select().from(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, visitor.id)));
    assert.equal(rows.length, 0, "agreement refusal must happen before membership creation");

    const attempts = await Promise.all([
      fetch(url, {
        method: "POST",
        headers: headers(token, server.id),
        body: JSON.stringify({ agreementId: agreement.id, role: "member", source: "invite" }),
      }),
      fetch(url, {
        method: "POST",
        headers: headers(token, server.id),
        body: JSON.stringify({ agreementId: agreement.id }),
      }),
    ]);
    assert.ok(attempts.every((response) => response.status === 200), await attempts[0]!.clone().text());
    const outcomes = await Promise.all(attempts.map((response) => response.json() as Promise<{ role: string; joined: boolean }>));
    assert.ok(outcomes.every((outcome) => outcome.role === "guest"), "client role/source fields must not widen this endpoint");
    assert.deepEqual(outcomes.map((outcome) => outcome.joined).sort(), [false, true], "concurrent clicks create one membership");

    rows = await db.select().from(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, visitor.id)));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.role, "guest");
    const audit = await db.select({ source: serverMembershipAgreementAudit.source, agreementId: serverMembershipAgreementAudit.agreementId })
      .from(serverMembershipAgreementAudit)
      .where(and(eq(serverMembershipAgreementAudit.serverId, server.id), eq(serverMembershipAgreementAudit.subjectId, visitor.id)));
    assert.deepEqual(audit, [{ source: "join", agreementId: agreement.id }]);
  } finally {
    await app.close();
  }
});

test("public self-join rechecks every gate and leaves no membership when admission is closed", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    await enablePublicGuestJoinFeatures();
    const owner = await seedUser("public-closed-owner@slock.test", "public-closed-owner");
    const visitor = await seedUser("public-closed-visitor@slock.test", "public-closed-visitor");
    const server = await createServer("Closed Join", "public-closed-join-74", owner.id);
    await db.update(servers).set({ publiclyVisible: true, publicGuestJoinEnabled: false }).where(eq(servers.id, server.id));
    const token = await tokenForHuman(visitor.email);
    const refused = await fetch(`${app.baseUrl}/api/public/servers/public-closed-join-74/join-as-guest`, {
      method: "POST",
      headers: headers(token, server.id),
      body: "{}",
    });
    assert.equal(refused.status, 404, "closed admission must not reveal a distinct server-existence response");
    let rows = await db.select().from(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, visitor.id)));
    assert.equal(rows.length, 0, "a refused join must have no membership side effect");

    await db.update(servers).set({ publicGuestJoinEnabled: true }).where(eq(servers.id, server.id));
    await db.update(featureFlags).set({ killSwitch: true }).where(eq(featureFlags.key, SERVER_GUEST_FEATURE_FLAG_KEY));
    const guestFlagClosed = await fetch(`${app.baseUrl}/api/public/servers/public-closed-join-74/join-as-guest`, {
      method: "POST",
      headers: headers(token, server.id),
      body: "{}",
    });
    assert.equal(guestFlagClosed.status, 404, "the Guest rollout kill switch is authoritative at write time");

    await db.update(featureFlags).set({ killSwitch: false }).where(eq(featureFlags.key, SERVER_GUEST_FEATURE_FLAG_KEY));
    await db.update(featureFlags).set({ killSwitch: true }).where(eq(featureFlags.key, PUBLIC_SERVER_FEATURE_FLAG_KEY));
    const publicFlagClosed = await fetch(`${app.baseUrl}/api/public/servers/public-closed-join-74/join-as-guest`, {
      method: "POST",
      headers: headers(token, server.id),
      body: "{}",
    });
    assert.equal(publicFlagClosed.status, 404, "the Public rollout kill switch is authoritative at write time");
    rows = await db.select().from(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, visitor.id)));
    assert.equal(rows.length, 0, "neither rollout gate may fail after creating membership");
  } finally {
    await app.close();
  }
});

test("a valid Guest email invite remains independent of Public self-admission settings", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    const owner = await seedUser("source-invite-owner@slock.test", "source-invite-owner");
    const invitee = await seedUser("source-invite-guest@slock.test", "source-invite-guest");
    const server = await createServer("Invite Source", "invite-source-74", owner.id);
    const rawToken = "public-task-74-source-specific-guest-invite";
    await db.insert(serverInvites).values({
      serverId: server.id,
      invitedEmail: invitee.email,
      invitedByUserId: owner.id,
      role: "guest",
      tokenHash: createHash("sha256").update(rawToken).digest("hex"),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const [precondition] = await db.select({
      publiclyVisible: servers.publiclyVisible,
      publicGuestJoinEnabled: servers.publicGuestJoinEnabled,
    }).from(servers).where(eq(servers.id, server.id));
    assert.deepEqual(precondition, { publiclyVisible: false, publicGuestJoinEnabled: false });

    const token = await tokenForHuman(invitee.email);
    const accepted = await fetch(`${app.baseUrl}/api/auth/accept-invite`, {
      method: "POST",
      headers: headers(token, server.id),
      body: JSON.stringify({ token: rawToken }),
    });
    assert.equal(accepted.status, 200, await accepted.clone().text());
    const [membership] = await db.select({ role: serverMembers.role }).from(serverMembers)
      .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, invitee.id)));
    assert.deepEqual(membership, { role: "guest" }, "invite source keeps its stored role and does not consult Public admission");
  } finally {
    await app.close();
  }
});

/**
 * Acceptance A5 — a logged-out visitor has NO write path, anywhere.
 *
 * The weak version of this test pokes the public router with a POST and finds a
 * 404. That is trivially true (no such route is registered) and could never have
 * gone red, so it certifies nothing. The property worth pinning is broader: with
 * the server public and a channel world-readable, an anonymous caller must not be
 * able to write through ANY route — and the check is the absence of the side
 * effect, not the status code, because a 401 returned after a row was inserted
 * would look identical from outside.
 */
test("public server: a logged-out visitor has no write path and leaves no state behind", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    await enablePublicServerFeature();
    const owner = await seedUser("pv-write-owner@slock.test", "pv-write-owner");
    const server = await createServer("NoWrite", "public-nowrite-70", owner.id);
    const open = await createChannel(server.id, "readable", undefined, "channel", { type: "user", id: owner.id });
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, open.id));
    await db.update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));

    // Confirm the reader really is inside the public surface first — otherwise
    // every refusal below could be "not public" rather than "not writable",
    // and the test would pass for the wrong reason.
    const readable = await fetch(`${app.baseUrl}/api/public/servers/public-nowrite-70/channels/${open.id}/messages`);
    assert.equal(readable.status, 200, "precondition: the anonymous reader can read this channel");

    const before = await db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, open.id));

    const attempts: [string, RequestInit][] = [
      // The real send path, with no credentials.
      [`${app.baseUrl}/api/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelId: open.id, content: "anonymous write" }) }],
      // The public router itself must expose no write verb.
      [`${app.baseUrl}/api/public/servers/public-nowrite-70/channels/${open.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "anonymous write" }) }],
      // Nor a way to join, which would convert a reader into a member.
      [`${app.baseUrl}/api/channels/${open.id}/join`, { method: "POST" }],
    ];
    for (const [url, init] of attempts) {
      const res = await fetch(url, init);
      assert.ok(res.status >= 400, `anonymous write must be refused: ${init.method} ${url} returned ${res.status}`);
    }

    const after = await db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, open.id));
    assert.equal(after.length, before.length, "no anonymous attempt may leave a message behind");

    const memberRows = await db.select({ userId: channelHumans.userId }).from(channelHumans).where(eq(channelHumans.channelId, open.id));
    assert.deepEqual(memberRows.map((r) => r.userId), [owner.id], "no anonymous attempt may create a membership row");
  } finally {
    await app.close();
  }
});
