import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import {
  __testRisingWaveInbox,
  getActivityUnreadTotalsBatch,
  getFollowedThreads,
  getInboxItems,
  getOrCreateThread,
  selectAgentInboxChainRows,
} from "./channelService";
import { installRisingWaveReadReferences, uninstallRisingWaveReadReferences } from "../test/risingWaveReadReference";
import { getDb } from "../db/index";
import { threadFollows } from "../db/schema";
import { createMessage } from "./messageService";

// First-principles invariants (RFC-061 teardown, tygg's rulings 2026-09-21 and
// the hard-dependency decision): RisingWave is a HARD dependency. A configured
// RisingWave that fails mid-read throws — no fail-soft, no breaker, no PG
// reroute — and an UNCONFIGURED RisingWave is an error too: there is no
// "no-env" Postgres path in the product. These cases take the installed test
// references away so they pin the product reads themselves.

beforeEach(() => {
  uninstallRisingWaveReadReferences();
});

afterEach(() => {
  __testRisingWaveInbox.reset();
  installRisingWaveReadReferences();
});

test("configured RisingWave that fails mid-read throws — no Postgres fallback", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  __testRisingWaveInbox.set({
    getPool: () => ({} as never),
    query: (async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:4566"), { code: "ECONNREFUSED" });
    }) as never,
  });
  await assert.rejects(
    getInboxItems(server.id, owner.id, { filter: "all" }),
    /ECONNREFUSED/,
    "an RW read failure must surface, never silently reroute to Postgres",
  );
});

test("unconfigured RisingWave (and no test reference) fails the Activity reads — no Postgres fallback", async ({ seed }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer], name: "no-rw" });
  const parent = await seed.message({ channel, author: owner, content: "parent" });
  await seed.message({ channel, author: peer, content: "a" });
  __testRisingWaveInbox.set({ getPool: () => null });
  await assert.rejects(getInboxItems(server.id, owner.id, { filter: "all" }), /RisingWave is not configured/);
  await assert.rejects(getInboxItems(server.id, owner.id, { filter: "unread" }), /RisingWave is not configured/);
  await assert.rejects(
    getActivityUnreadTotalsBatch([{ serverId: server.id }], owner.id),
    /RisingWave is not configured/,
  );
  // The explicit authority-transaction escape is not a fallback and still reads Postgres.
  const forced = await getInboxItems(server.id, owner.id, { filter: "all", forceCanonicalPostgres: true });
  assert.ok(Array.isArray(forced.items));

  // Followed-thread stats: the RW-absent Postgres path is gone too.
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  await createMessage(thread.id, "user", peer.id, "reply");
  await getDb().insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "user",
    followerId: owner.id,
    parentMessageId: parent.id,
    reason: "manual",
  }).onConflictDoNothing();
  await assert.rejects(getFollowedThreads(server.id, owner.id), /RisingWave is not configured/);
});

test("totals batch with configured RW that fails throws — absence is not manufactured", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  __testRisingWaveInbox.set({
    getPool: () => ({} as never),
    query: (async () => {
      throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    }) as never,
  });
  await assert.rejects(
    getActivityUnreadTotalsBatch([{ serverId: server.id }], owner.id),
    /statement timeout/,
  );
});

test("no fail-soft vocabulary survives in the service", async () => {
  const source = (await import("node:fs")).readFileSync(
    new URL("./channelService.ts", import.meta.url),
    "utf8",
  ) as string;
  // The teardown's contract: these constructs must not grow back.
  assert.doesNotMatch(source, /tryReadRisingWaveInboxWithFailSoft/);
  assert.doesNotMatch(source, /risingWaveInboxBreaker/);
  assert.doesNotMatch(source, /halfOpenProbeInFlight/);
  assert.doesNotMatch(source, /getInboxItemsFromServingRows/);
  assert.doesNotMatch(source, /rfc056ServingMode/);
  assert.doesNotMatch(source, /inbox\.rw\.failsoft\.fallback/);
  // Hard dependency: no RW-absent Postgres path may grow back either.
  assert.doesNotMatch(source, /no_rw_env/);
  assert.doesNotMatch(source, /no-env/i);
  assert.doesNotMatch(source, /conversationUnreadPostgres/);
  assert.doesNotMatch(source, /"rw_row_mismatch"|"feature_disabled"/);
});

// Agent resume recovery has ONE source, the unified chain. When it cannot be
// read the selection says so and the resume skips recovery; nothing reroutes.
test("agent inbox selection: unconfigured RisingWave is unavailable, not a Postgres read", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  assert.deepEqual(
    await selectAgentInboxChainRows("00000000-0000-4000-8000-000000000001"),
    { source: "unavailable", reason: "rw_unconfigured" },
  );
});

test("agent inbox selection: a failed chain read is unavailable (rw_error)", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  __testRisingWaveInbox.set({
    getPool: () => ({} as never),
    query: (async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:4566"), { code: "ECONNREFUSED" });
    }) as never,
  });
  assert.deepEqual(
    await selectAgentInboxChainRows("00000000-0000-4000-8000-000000000001"),
    { source: "unavailable", reason: "rw_error" },
  );
});

test("agent inbox selection: a successful chain read returns the chain rows", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const agentId = "00000000-0000-4000-8000-000000000001";
  const queries: unknown[][] = [];
  __testRisingWaveInbox.set({
    getPool: () => ({} as never),
    query: (async (_pool: unknown, _text: string, values?: unknown[]) => {
      queries.push(values ?? []);
      return {
        result: {
          rows: [{
            target_id: "t-1", storage_channel_id: "t-1", kind: "channel", server_id: server.id,
            channel_name: "general", channel_type: "channel", parent_message_id: null,
            parent_channel_id: null, parent_channel_name: null, parent_channel_type: null,
            last_read_seq: "4", unread_count: "2", first_unread_seq: "5", latest_seq: "6",
            mention_unread: "0", max_mention_seq: null, subscribed: true, offered_unread: "2", activity_seq: "6",
            joined_at: "2026-09-01T00:00:00.000Z",
          }],
        },
      };
    }) as never,
  });
  const selection = await selectAgentInboxChainRows(agentId);
  assert.equal(selection.source, "chain");
  assert.deepEqual(queries, [[agentId]]);
  assert.deepEqual(selection.source === "chain" ? selection.rows : null, [{
    targetId: "t-1", storageChannelId: "t-1", kind: "channel", serverId: server.id,
    channelName: "general", channelType: "channel", parentMessageId: null,
    parentChannelId: null, parentChannelName: null, parentChannelType: null,
    lastReadSeq: 4, unreadCount: 2, firstUnreadSeq: 5, latestSeq: 6,
    mentionUnread: 0, maxMentionSeq: null, subscribed: true, offeredUnread: 2, activitySeq: 6,
    joinedAt: new Date("2026-09-01T00:00:00.000Z"),
  }]);
});
