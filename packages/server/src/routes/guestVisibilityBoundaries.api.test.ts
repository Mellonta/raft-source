import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { channels, featureFlagRules, messages } from "../db/schema";
import { SERVER_GUEST_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { transitionMemberRole } from "../services/serverService";
import { createMessage } from "../services/messageService";
import { markThreadDone, unfollowThread } from "../services/channelService";
import { emitTaskCreated } from "../services/taskRealtimeEvents";
import { headers, recordTestInboxFact, seedThreadFixture } from "./channels.api.fixtures";

const requireWeb = createRequire(new URL("../../../web/package.json", import.meta.url));
const { io: clientIo } = requireWeb("socket.io-client");
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
const waitEvent = (socket: any, event: string, timeoutMs = 500) => new Promise<any>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no ${event}`)), timeoutMs);
  socket.once(event, (value: any) => { clearTimeout(timer); resolve(value); });
});

test("Guest cannot read metadata, subscribe, or receive task content for a hidden public channel", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  await getDb().insert(featureFlagRules).values({ id: randomUUID(), flagKey: SERVER_GUEST_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [f.serverId] });
  await transitionMemberRole({ serverId: f.serverId, actorUserId: f.ownerId, targetUserId: f.followerId, nextRole: "guest", guestTransitionsEnabled: true });
  const guestHeaders = headers(f.followerToken, f.serverId);
  for (const suffix of ["", "/members", "/agents"]) {
    const response = await fetch(`${app.baseUrl}/api/channels/${f.parentChannelId}${suffix}`, { headers: guestHeaders });
    assert.equal(response.status, 404, `${suffix || "details"} must cloak the hidden channel`);
  }
  const socket = clientIo(app.baseUrl, { auth: { token: f.followerToken, serverId: f.serverId }, transports: ["websocket"], autoConnect: false });
  const ownerSocket = clientIo(app.baseUrl, { auth: { token: f.ownerToken, serverId: f.serverId }, transports: ["websocket"], autoConnect: false });
  try {
    const ready = waitEvent(socket, "rooms:joined", 4_000); socket.connect(); await ready;
    const ownerReady = waitEvent(ownerSocket, "rooms:joined", 4_000); ownerSocket.connect(); await ownerReady;
    const serverSocket = app.io.sockets.sockets.get(socket.id)!;
    assert.equal(serverSocket.rooms.has(`channel:${f.parentChannelId}`), false);
    const taskEvent = waitEvent(socket, "task:created");
    const ownerTaskEvent = waitEvent(ownerSocket, "task:created", 4_000);
    emitTaskCreated(app.io, { channelId: f.parentChannelId, channelType: "channel", serverId: f.serverId }, { channelId: f.parentChannelId, tasks: [{ id: randomUUID(), title: "hidden-task-title", description: "hidden-task-description" }] });
    await assert.rejects(taskEvent, /no task:created/);
    assert.equal((await ownerTaskEvent).tasks[0].description, "hidden-task-description", "authorized channel member must still receive task content");
    socket.emit("join:channel", f.parentChannelId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(serverSocket.rooms.has(`channel:${f.parentChannelId}`), false);
  } finally { socket.disconnect(); ownerSocket.disconnect(); }
});

test("Guest broad sync omits hidden public-channel content", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  await getDb().insert(featureFlagRules).values({ id: randomUUID(), flagKey: SERVER_GUEST_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [f.serverId] });
  await transitionMemberRole({ serverId: f.serverId, actorUserId: f.ownerId, targetUserId: f.followerId, nextRole: "guest", guestTransitionsEnabled: true });
  const response = await fetch(`${app.baseUrl}/api/messages/sync?since_seq=0`, { headers: headers(f.followerToken, f.serverId) });
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify(await response.json()).includes(f.parentMessageId), false);
});

test("Guest cannot mutate read state on a hidden public channel", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  await getDb().insert(featureFlagRules).values({ id: randomUUID(), flagKey: SERVER_GUEST_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [f.serverId] });
  await transitionMemberRole({ serverId: f.serverId, actorUserId: f.ownerId, targetUserId: f.followerId, nextRole: "guest", guestTransitionsEnabled: true });
  const guestHeaders = headers(f.followerToken, f.serverId);
  const statuses = await Promise.all([["read", { seq: 1 }], ["read-all", {}], ["unread", {}]].map(async ([suffix, body]) => (
    await fetch(`${app.baseUrl}/api/channels/${f.parentChannelId}/${suffix}`, {
      method: "POST", headers: guestHeaders, body: JSON.stringify(body),
    })
  ).status));
  assert.deepEqual(statuses, [404, 404, 404]);
});

test("Guest does not receive metadata-bearing server-room events", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  await getDb().insert(featureFlagRules).values({ id: randomUUID(), flagKey: SERVER_GUEST_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [f.serverId] });
  await transitionMemberRole({ serverId: f.serverId, actorUserId: f.ownerId, targetUserId: f.followerId, nextRole: "guest", guestTransitionsEnabled: true });
  const guestSocket = clientIo(app.baseUrl, { auth: { token: f.followerToken, serverId: f.serverId }, transports: ["websocket"], autoConnect: false });
  const ownerSocket = clientIo(app.baseUrl, { auth: { token: f.ownerToken, serverId: f.serverId }, transports: ["websocket"], autoConnect: false });
  try {
    const guestReady = waitEvent(guestSocket, "rooms:joined", 4_000); guestSocket.connect(); await guestReady;
    const ownerReady = waitEvent(ownerSocket, "rooms:joined", 4_000); ownerSocket.connect(); await ownerReady;
    assert.equal(app.io.sockets.sockets.get(guestSocket.id)!.rooms.has(`server:${f.serverId}`), false);
    const guestEvent = waitEvent(guestSocket, "channel:updated");
    const ownerEvent = waitEvent(ownerSocket, "channel:updated", 4_000);
    app.io.to(`server:${f.serverId}`).emit("channel:updated", { channel: { id: f.parentChannelId, name: "hidden-metadata" } });
    await assert.rejects(guestEvent, /no channel:updated/);
    assert.equal((await ownerEvent).channel.name, "hidden-metadata");
  } finally { guestSocket.disconnect(); ownerSocket.disconnect(); }
});

test("member socket is disconnected when the member is downgraded to Guest", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  await getDb().insert(featureFlagRules).values({ id: randomUUID(), flagKey: SERVER_GUEST_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [f.serverId] });
  const socket = clientIo(app.baseUrl, { auth: { token: f.followerToken, serverId: f.serverId }, transports: ["websocket"], autoConnect: false });
  try {
    const ready = waitEvent(socket, "rooms:joined", 4_000); socket.connect(); await ready;
    assert.equal(app.io.sockets.sockets.get(socket.id)!.rooms.has(`channel:${f.parentChannelId}`), true);
    const disconnected = waitEvent(socket, "disconnect", 4_000);
    const response = await fetch(`${app.baseUrl}/api/servers/${f.serverId}/members/${f.followerId}`, {
      method: "PATCH", headers: headers(f.ownerToken, f.serverId), body: JSON.stringify({ role: "guest" }),
    });
    assert.equal(response.status, 200);
    await disconnected;
  } finally { socket.disconnect(); }
});

test("revoking guestVisible evicts connected Guests from the channel room", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  await getDb().insert(featureFlagRules).values({ id: randomUUID(), flagKey: SERVER_GUEST_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [f.serverId] });
  await getDb().update(channels).set({ guestVisible: true }).where(eq(channels.id, f.parentChannelId));
  await transitionMemberRole({ serverId: f.serverId, actorUserId: f.ownerId, targetUserId: f.followerId, nextRole: "guest", guestTransitionsEnabled: true });
  const socket = clientIo(app.baseUrl, { auth: { token: f.followerToken, serverId: f.serverId }, transports: ["websocket"], autoConnect: false });
  try {
    const ready = waitEvent(socket, "rooms:joined", 4_000); socket.connect(); await ready;
    const serverSocket = app.io.sockets.sockets.get(socket.id)!;
    assert.equal(serverSocket.rooms.has(`channel:${f.parentChannelId}`), true);
    const response = await fetch(`${app.baseUrl}/api/channels/${f.parentChannelId}`, {
      method: "PATCH", headers: headers(f.ownerToken, f.serverId), body: JSON.stringify({ guestVisible: false }),
    });
    assert.equal(response.status, 200);
    assert.equal(serverSocket.rooms.has(`channel:${f.parentChannelId}`), false);
  } finally { socket.disconnect(); }
});

for (const state of ["followed", "done", "unfollowed"] as const) test(`Guest revoked visibility removes ${state} parent preview`, async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  await getDb().insert(featureFlagRules).values({ id: randomUUID(), flagKey: SERVER_GUEST_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [f.serverId] });
  await getDb().update(channels).set({ guestVisible: true }).where(eq(channels.id, f.parentChannelId));
  await transitionMemberRole({ serverId: f.serverId, actorUserId: f.ownerId, targetUserId: f.followerId, nextRole: "guest", guestTransitionsEnabled: true });
  const old = await createMessage(f.threadId, "user", f.ownerId, "old-visible-reply");
  await recordTestInboxFact({ serverId: f.serverId, receiverId: f.followerId, kind: "thread", sourceChannelId: f.threadId, message: old });
  if (state === "done") await markThreadDone(f.followerId, f.threadId, String(old.seq));
  if (state === "unfollowed") await unfollowThread(f.followerId, f.threadId);
  const guestHeaders = headers(f.followerToken, f.serverId);
  const path = state === "followed" ? "channels/threads/followed" : `channels/inbox/${state}`;
  const before = await fetch(`${app.baseUrl}/api/${path}`, { headers: guestHeaders }); assert.equal(before.status, 200); assert.ok(JSON.stringify(await before.json()).includes(f.threadId));
  const revoke = await fetch(`${app.baseUrl}/api/channels/${f.parentChannelId}`, { method: "PATCH", headers: headers(f.ownerToken, f.serverId), body: JSON.stringify({ guestVisible: false }) }); assert.equal(revoke.status, 200);
  await getDb().update(messages).set({ content: "new-parent-content-after-visibility-revocation" }).where(eq(messages.id, f.parentMessageId));
  const after = await fetch(`${app.baseUrl}/api/${path}`, { headers: guestHeaders }); assert.equal(after.status, 200); assert.equal(JSON.stringify(await after.json()).includes("new-parent-content-after-visibility-revocation"), false);
});
