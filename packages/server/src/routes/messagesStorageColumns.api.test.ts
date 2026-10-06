import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { getDb } from "../db/index";
import { users } from "../db/schema";
import { createServer as createServerService } from "../services/serverService";
import { createChannel as createChannelService, addHuman } from "../services/channelService";
import { createMessage } from "../services/messageService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

// task #17 (staging load speed): `searchText` / `searchVector` only feed the
// full-text index. The history HTTP reads used to SELECT every column, so a
// 50-message page shipped ~16KB of tsvector + search text — more than the
// message content itself. The realtime path already strips them; the HTTP
// reads must not send them either.

const STORAGE_ONLY_KEYS = ["searchText", "searchVector"] as const;

async function seedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

function headers(token: string, serverId: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-Server-Id": serverId,
  };
}

function assertNoStorageOnlyKeys(surface: string, rows: Array<Record<string, unknown>>) {
  assert.ok(rows.length > 0, `${surface} must return messages to examine`);
  for (const row of rows) {
    for (const key of STORAGE_ONLY_KEYS) {
      assert.equal(key in row, false, `${surface} must not serialize storage-only "${key}"`);
    }
  }
}

test("message history HTTP reads never serialize search-index columns", async ({ app }) => {
  const owner = await seedUser("storage-cols@slock.test", "storage-cols");
  const server = await createServerService("Storage Cols", "storage-cols", owner.id);
  const channel = await createChannelService(server.id, "storage-cols", "test channel");
  await addHuman(channel.id, owner.id);

  const first = await createMessage(channel.id, "user", owner.id, "searchable words for the index");
  await createMessage(channel.id, "user", owner.id, "another searchable message");

  const token = await tokenForHuman(owner.email);
  const get = async (path: string) => {
    const res = await fetch(`${app.baseUrl}${path}`, { headers: headers(token, server.id) });
    assert.equal(res.status, 200, `${path} must succeed`);
    return res.json() as Promise<Record<string, unknown>>;
  };

  const page = await get(`/api/messages/channel/${channel.id}?limit=50`);
  assertNoStorageOnlyKeys("channel page", page.messages as Array<Record<string, unknown>>);

  const context = await get(`/api/messages/context/${first.id}?channelId=${channel.id}`);
  assertNoStorageOnlyKeys("message context", context.messages as Array<Record<string, unknown>>);

  const sync = await get(`/api/messages/sync?since_seq=0&channel_id=${channel.id}`);
  assertNoStorageOnlyKeys("message sync", sync as unknown as Array<Record<string, unknown>>);
});
