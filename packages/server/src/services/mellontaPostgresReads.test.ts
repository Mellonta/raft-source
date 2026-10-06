import assert from "node:assert/strict";
import { afterEach, beforeEach, vi } from "vitest";
import { dbTest as test } from "../test/integration/dbTest";
import { installRisingWaveReadReferences, uninstallRisingWaveReadReferences } from "../test/risingWaveReadReference";
import { usesPostgresReadBackend } from "../db/readBackend";
import { agents, channelAgents, messages } from "../db/schema";
import {
  getActivityUnreadTotalsBatch, getFollowedThreads, getInboxItems,
  getSidebarUnreadSummaryCounts, getUnreadSummary, listAgentInbox,
  markAgentLegacyRead, markReadLatest, selectAgentInboxChainRows,
} from "./channelService";

beforeEach(() => {
  uninstallRisingWaveReadReferences();
  vi.stubEnv("RAFT_READ_BACKEND", "postgres");
  vi.stubEnv("RISINGWAVE_DATABASE_URL", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  installRisingWaveReadReferences();
});

test("self-hosted human reads use real Postgres without the test overrides or RisingWave", async ({ seed }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  await seed.message({ channel, author: peer, content: "unread" });
  assert.equal((await getUnreadSummary(server.id, owner.id))[channel.id].unreadCount, 1);
  assert.equal((await getSidebarUnreadSummaryCounts([server.id], owner.id))[server.id], 1);
  const inbox = await getInboxItems(server.id, owner.id, { filter: "all" });
  assert.ok(Array.isArray(inbox.items));
  const totals = await getActivityUnreadTotalsBatch([{ serverId: server.id }], owner.id);
  assert.equal(totals.get(server.id)?.totalUnreadCount, inbox.totalUnreadCount);
  assert.ok(await getFollowedThreads(server.id, owner.id));
  await markReadLatest(owner.id, channel.id);
  assert.equal((await getUnreadSummary(server.id, owner.id))[channel.id], undefined);
});

test("agent inbox pagination, counts and resume recovery share the Postgres source", async ({ seed, db }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const first = await seed.channel({ server, members: [owner], name: "first" });
  const second = await seed.channel({ server, members: [owner], name: "second" });
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: "reader", status: "active" }).returning();
  await db.insert(channelAgents).values([first, second].map(channel => ({ channelId: channel.id, agentId: agent.id })));
  const [one, two] = await db.insert(messages).values([first, second].map(channel => ({
    channelId: channel.id, senderType: "user" as const, senderId: owner.id, content: "unread",
  }))).returning();
  const chain = await selectAgentInboxChainRows(agent.id);
  assert.equal(chain.source, "chain");
  assert.equal(chain.source === "chain" && chain.rows.length, 2);
  const page = await listAgentInbox(agent.id, server.id, { view: "unread", limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].target, "#second");
  assert.equal(page.totals.conversations, 2);
  assert.equal(page.hasMore, true);
  const next = await listAgentInbox(agent.id, server.id, { view: "unread", limit: 1, beforeSeq: page.nextBeforeSeq! });
  assert.equal(next.items[0].target, "#first");
  await markAgentLegacyRead(agent.id, first.id, one.seq);
  await markAgentLegacyRead(agent.id, second.id, two.seq);
  assert.equal((await listAgentInbox(agent.id, server.id, { view: "unread", limit: 10 })).items.length, 0);
});

test("invalid or ambiguous read backend configuration fails explicitly", () => {
  assert.equal(usesPostgresReadBackend({}), false);
  assert.equal(usesPostgresReadBackend({ RAFT_READ_BACKEND: "postgres" }), true);
  assert.throws(() => usesPostgresReadBackend({ RAFT_READ_BACKEND: "invalid" }), /must be/);
  assert.throws(() => usesPostgresReadBackend({ RAFT_READ_BACKEND: "postgres", RISINGWAVE_DATABASE_URL: "postgres://rw" }), /cannot be combined/);
});
