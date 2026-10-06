import { dbTest as test } from "../../test/integration/dbTest";
import { closeTestDatabase } from "../../test/integration/database";
import assert from "node:assert/strict";
import type { Server as SocketServer } from "socket.io";
import type { ReminderSummary } from "@botiverse/raft-shared";

import { getDb } from "../../db/index";
import { users } from "../../db/schema";
import { createAgent } from "../../services/agentService";
import { createServer } from "../../services/serverService";
import { publishReminderEvent } from "./realtime";

afterEach(async () => {
  await closeTestDatabase();
});

interface FakeSocket {
  data: { userId?: string; serverRole?: string; accessRevoked?: boolean };
  received: Array<{ event: string; payload: unknown }>;
  emit(event: string, payload: unknown): void;
}

function socketFor(data: FakeSocket["data"]): FakeSocket {
  const received: FakeSocket["received"] = [];
  return { data, received, emit: (event, payload) => { received.push({ event, payload }); } };
}

/** `io.local.in(rooms).fetchSockets()` as the publisher sees it; every other
 * call would prove the publisher fell back to a room broadcast. */
function ioWithLocalSockets(sockets: FakeSocket[], rooms: string[][] = []): SocketServer {
  return {
    local: {
      in(target: string | string[]) {
        rooms.push(Array.isArray(target) ? target : [target]);
        return { fetchSockets: async () => sockets };
      },
    },
  } as unknown as SocketServer;
}

async function seed() {
  const db = getDb();
  const [owner, creator] = await db.insert(users).values(["owner", "creator"].map((name) => ({
    email: `reminder-realtime-${name}@slock.test`,
    name: `reminder-realtime-${name}`,
    displayName: name,
    passwordHash: "unused",
    emailVerified: true,
  }))).returning();
  const server = await createServer("Reminder Realtime", "reminder-realtime", owner.id);
  const agent = await createAgent(server.id, "r-agent", {
    runtime: "claude",
    creatorType: "user",
    creatorId: creator.id,
  });
  return { owner, creator, server, agent };
}

const summary = { reminderId: "r1", title: "standup" } as unknown as ReminderSummary;

test("publishReminderEvent reaches only sockets of users who may inspect the owner agent", async ({ db }) => {
  void db;
  const { owner, creator, server, agent } = await seed();
  const ownerSocket = socketFor({ userId: owner.id, serverRole: "owner" });
  const adminSocket = socketFor({ userId: "admin-user", serverRole: "admin" });
  const creatorSocket = socketFor({ userId: creator.id, serverRole: "member" });
  const creatorSecondTab = socketFor({ userId: creator.id, serverRole: "member" });
  const memberSocket = socketFor({ userId: "plain-member", serverRole: "member" });
  const guestSocket = socketFor({ userId: "guest-user", serverRole: "guest" });
  const revokedSocket = socketFor({ userId: owner.id, serverRole: "owner", accessRevoked: true });
  const anonymousSocket = socketFor({});
  const sockets = [ownerSocket, adminSocket, creatorSocket, creatorSecondTab, memberSocket, guestSocket, revokedSocket, anonymousSocket];
  const rooms: string[][] = [];
  const row = { id: "reminder-1", serverId: server.id, ownerAgentId: agent.id };

  await publishReminderEvent(ioWithLocalSockets(sockets, rooms), row, { type: "reminder:scheduled", reminder: summary });
  await publishReminderEvent(ioWithLocalSockets(sockets, rooms), row, { type: "reminder:canceled" });

  // Members and guests are addressed together; the per-socket decision, not
  // the room, decides who receives the event.
  assert.deepEqual(rooms, [
    [`server:${server.id}`, `server:${server.id}:guests`],
    [`server:${server.id}`, `server:${server.id}:guests`],
  ]);
  // Wire shape is pinned for deployed web clients: scheduled wraps the summary,
  // canceled carries the ids only.
  const expected = [
    { event: "reminder:scheduled", payload: { reminder: summary } },
    { event: "reminder:canceled", payload: { reminderId: "reminder-1", ownerAgentId: agent.id } },
  ];
  for (const socket of [ownerSocket, adminSocket, creatorSocket, creatorSecondTab]) {
    assert.deepEqual(socket.received, expected);
  }
  for (const socket of [memberSocket, guestSocket, revokedSocket, anonymousSocket]) {
    assert.deepEqual(socket.received, []);
  }
});

test("publishReminderEvent stays silent for an unknown owner agent and survives a degraded socket fetch", async ({ db }) => {
  void db;
  const { owner, server, agent } = await seed();
  const ownerSocket = socketFor({ userId: owner.id, serverRole: "owner" });
  await publishReminderEvent(
    ioWithLocalSockets([ownerSocket]),
    { id: "reminder-1", serverId: server.id, ownerAgentId: "00000000-0000-4000-8000-000000000000" },
    { type: "reminder:canceled" },
  );
  assert.deepEqual(ownerSocket.received, []);

  // The reminder mutation is already committed; a failed fetch is logged, not thrown.
  const broken = {
    local: { in: () => ({ fetchSockets: async () => { throw new Error("adapter unavailable"); } }) },
  } as unknown as SocketServer;
  const row = { id: "reminder-1", serverId: server.id, ownerAgentId: agent.id };
  await publishReminderEvent(broken, row, { type: "reminder:canceled" });
  await publishReminderEvent(null, row, { type: "reminder:canceled" });
});
