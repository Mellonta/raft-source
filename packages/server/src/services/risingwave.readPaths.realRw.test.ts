/**
 * Every production RisingWave read, once, against a REAL RisingWave.
 *
 * The rest of the suite runs on PGlite with the RisingWave readers pinned to
 * their test-only Postgres references (src/test/risingWaveReadReference.ts), so
 * SQL that RisingWave rejects (e.g. a bind parameter after LIMIT) passes there. This file runs only
 * when RISINGWAVE_DATABASE_URL and DATABASE_URL point at the `risingwave-real`
 * stack (scripts/ci/risingwave-real-stack.sh); it seeds Postgres, waits for CDC
 * and the MV graph, then calls the real readers with every test seam disabled.
 */
import assert from "node:assert/strict";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import { channelHumans, channels, messages, tasks, threadFollows } from "../db/schema";
import {
  closeRisingWavePool,
  CONVERSATION_UNREAD_VIEW,
  getRisingWavePool,
  queryRisingWave,
  UNIFIED_CHAIN_VIEWS,
} from "../db/risingwave";
import type { DbQueryTracer } from "../tracing/dbQueryTrace";
import { seedRealRwFixture, waitForRealRwFixture, type RealRwFixture } from "../test/realRwFixture";
import {
  __testRisingWaveInbox,
  getActivityUnreadTotalsBatch,
  getAgentUnreadCounts,
  getFollowedThreads,
  getInboxItems,
  getSidebarUnreadSummaryCounts,
  getUnreadCounts,
  getUnreadSummary,
  listAgentInbox,
  selectAgentInboxChainRows,
} from "./channelService";
import { uninstallRisingWaveReadReferences } from "../test/risingWaveReadReference";

const required = process.env.RISINGWAVE_REAL_REQUIRED === "1";
const databaseUrl = process.env.DATABASE_URL?.trim();
const risingWaveUrl = process.env.RISINGWAVE_DATABASE_URL?.trim();
const configured = Boolean(databaseUrl && risingWaveUrl && !databaseUrl.startsWith("pglite"));

if (required && !configured) {
  throw new Error("real RW read-path test requires DATABASE_URL (real Postgres) and RISINGWAVE_DATABASE_URL");
}

let f: RealRwFixture;

type InboxItem = Awaited<ReturnType<typeof getInboxItems>>["items"][number];
/** The conversation an Activity row is about: its channel, or the thread. */
const targetOf = (item: InboxItem) => (item.kind === "thread" ? item.threadChannelId : item.channelId);

beforeAll(async () => {
  if (!configured) return;
  // The global setupFiles pin the RW readers to their Postgres test references;
  // take them away, and clear the pool/query seam, so the real RW pool serves.
  uninstallRisingWaveReadReferences();
  __testRisingWaveInbox.reset();
  await initDatabase(databaseUrl!, undefined, { log: () => {} });
  const pool = getRisingWavePool();
  assert.ok(pool, "RISINGWAVE_DATABASE_URL must yield a RisingWave pool");
  f = await seedRealRwFixture(getDb());
  await waitForRealRwFixture(pool, f);
}, 180_000);

afterAll(async () => {
  if (!configured) return;
  await closeRisingWavePool();
  await closeDatabase();
});

test.skipIf(!configured)("the RisingWave catalog carries every view the server reads", async () => {
  const pool = getRisingWavePool()!;
  const expected = [...new Set([...Object.values(UNIFIED_CHAIN_VIEWS), CONVERSATION_UNREAD_VIEW])];
  const read = await queryRisingWave<{ name: string }>(
    pool,
    "SELECT name FROM rw_catalog.rw_materialized_views WHERE name = ANY($1)",
    [expected],
  );
  assert.deepEqual(read.result.rows.map((row) => row.name).sort(), [...expected].sort());
});

test.skipIf(!configured)("sidebar readers: unread count, mention flag, joint mention on the receiver's projection", async () => {
  const summary = await getUnreadSummary(f.receiverServer.id, f.receiver.id);
  assert.equal(summary[f.general.id]?.unreadCount, 1);
  assert.equal(summary[f.general.id]?.hasMention, true, "the personal mention is flagged");
  assert.equal(summary[f.receiverLocal.id]?.unreadCount, 1);
  assert.equal(summary[f.receiverLocal.id]?.hasMention, true, "the joint mention stored under the sender's projection surfaces for the receiver");
  assert.equal(summary[f.senderLocal.id], undefined, "never keyed on the sender's projection");

  const counts = await getUnreadCounts(f.receiverServer.id, f.receiver.id);
  assert.equal(counts[f.general.id], 1);
  assert.equal(counts[f.receiverLocal.id], 1);
  assert.equal(counts[f.thread.id], 1, "a followed thread counts in the sidebar");

  const perServer = await getSidebarUnreadSummaryCounts([f.receiverServer.id, f.senderServer.id], f.receiver.id);
  assert.equal(perServer[f.receiverServer.id], 2, "channels and DMs only; followed threads excluded");
  assert.equal(perServer[f.senderServer.id] ?? 0, 0);
});

test.skipIf(!configured)("Activity readers: items, mentions, scoped channel, unified all, totals", async () => {
  const all = await getInboxItems(f.receiverServer.id, f.receiver.id, { filter: "all", limit: 50 });
  const general = all.items.find((item) => item.kind === "channel" && item.channelId === f.general.id);
  assert.ok(general, "the unread channel appears in Activity");
  assert.equal(general.unreadCount, 1);
  assert.equal(general.hasMention, true);
  const joint = all.items.find((item) => item.kind === "channel" && item.channelId === f.receiverLocal.id);
  assert.ok(joint, "the joint conversation appears on the receiver's projection");
  assert.equal(joint.hasMention, true);
  const thread = all.items.find((item) => item.kind === "thread" && item.threadChannelId === f.thread.id);
  assert.ok(thread, "the followed thread appears in Activity");
  assert.equal(thread.unreadCount, 1);

  const mentions = await getInboxItems(f.receiverServer.id, f.receiver.id, { filter: "mentions", limit: 50 });
  assert.deepEqual(
    mentions.items.map(targetOf).sort(),
    [f.general.id, f.receiverLocal.id].sort(),
  );

  const unread = await getInboxItems(f.receiverServer.id, f.receiver.id, { filter: "unread", limit: 1 });
  assert.equal(unread.items.length, 1, "LIMIT/OFFSET paging works on RisingWave");
  const unreadMentions = await getInboxItems(f.receiverServer.id, f.receiver.id, { filter: "unread_mentions", limit: 50, sort: "asc" });
  assert.equal(unreadMentions.items.length, 2);

  const scoped = await getInboxItems(f.receiverServer.id, f.receiver.id, { filter: "all", limit: 50, channelId: f.general.id });
  assert.ok(scoped.items.some((item) => targetOf(item) === f.general.id));

  const unified = await getInboxItems(f.receiverServer.id, f.receiver.id, { filter: "all", limit: 50, includeUnfollowedThreads: true });
  assert.ok(unified.items.some((item) => targetOf(item) === f.general.id));

  const totals = await getActivityUnreadTotalsBatch(
    [{ serverId: f.receiverServer.id }, { serverId: f.senderServer.id }],
    f.receiver.id,
  );
  assert.equal(totals.get(f.receiverServer.id)?.totalUnreadCount, 3, "general + joint + followed thread");
  assert.equal(totals.get(f.senderServer.id)?.totalUnreadCount ?? 0, 0);
});

test.skipIf(!configured)("active followed threads are served by rw_followed_threads_v4 and equal the legacy path", async () => {
  const traced: Array<{ name: string; attrs: Record<string, unknown> | undefined }> = [];
  const traceQuery: DbQueryTracer = async (name, work, onComplete) => {
    const result = await work();
    traced.push({ name, attrs: onComplete?.(result) as Record<string, unknown> | undefined });
    return result;
  };
  const threads = await getFollowedThreads(f.receiverServer.id, f.receiver.id, undefined, { traceQuery });
  const row = threads.find((thread) => thread.threadChannelId === f.thread.id);
  assert.ok(row, "the followed thread is listed");
  assert.equal(row.replyCount, 1);
  assert.equal(row.unreadCount, 1);
  assert.equal(row.parentMessageId, f.generalMessage.id);
  assert.equal(row.parentChannelId, f.general.id);
  const rwRead = traced.find((entry) => entry.name === "channels.followed_threads_rw_rows");
  assert.equal(rwRead?.attrs?.backend, "risingwave", `rows did not come from RisingWave: ${JSON.stringify(rwRead?.attrs)}`);
  assert.equal(
    traced.some((entry) => entry.name === "channels.followed_threads_by_user"),
    false,
    "every followed thread was in the view: no legacy list query",
  );
  const byId = (list: typeof threads) => [...list].sort((a, b) => a.threadChannelId.localeCompare(b.threadChannelId));
  const legacy = await getFollowedThreads(f.receiverServer.id, f.receiver.id, undefined, { forceLegacyPath: true });
  assert.deepEqual(byId(threads), byId(legacy));
});

test.skipIf(!configured)("rw_followed_threads_v4 carries the parent's task (rw_tasks) and long-content previews", async () => {
  const db = getDb();
  const [parentChannel] = await db.insert(channels).values({
    serverId: f.receiverServer.id, name: `rwreal-v4-task-${f.tag}`, type: "channel",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: parentChannel.id, userId: f.sender.id },
    { channelId: parentChannel.id, userId: f.receiver.id },
  ]);
  const longParent = `${"p".repeat(98)}😀😀${"q".repeat(60)} ${f.tag}`;
  const [parent] = await db.insert(messages).values({
    channelId: parentChannel.id, senderType: "user", senderId: f.sender.id, content: longParent,
  }).returning();
  const [thread] = await db.insert(channels).values({
    serverId: f.receiverServer.id, name: `thread-${parent.id.slice(0, 8)}`, type: "thread", parentMessageId: parent.id,
  }).returning();
  await db.insert(threadFollows).values({
    threadChannelId: thread.id, parentMessageId: parent.id, reason: "manual", followerType: "user", followerId: f.receiver.id,
  });
  const [task] = await db.insert(tasks).values({
    channelId: parentChannel.id, taskNumber: 1, title: `v4 task ${f.tag}`, status: "in_progress",
    createdByType: "user", createdById: f.sender.id, claimedByType: "user", claimedById: f.sender.id, messageId: parent.id,
  }).returning();
  await db.insert(messages).values({
    channelId: thread.id, senderType: "user", senderId: f.sender.id, content: `${"r".repeat(138)}😀😀😀${"s".repeat(60)} ${f.tag}`,
  });

  const pool = getRisingWavePool()!;
  const timeoutMs = Number(process.env.RISINGWAVE_REAL_CDC_TIMEOUT_MS ?? 120_000);
  const deadline = Date.now() + timeoutMs;
  let propagated = false;
  do {
    const read = await queryRisingWave<{ n: string }>(
      pool,
      `SELECT count(*) AS n FROM rw_followed_threads_v4
        WHERE server_id = $1 AND user_id = $2 AND thread_channel_id = $3 AND task_id = $4 AND reply_count = 1`,
      [f.receiverServer.id, f.receiver.id, thread.id, task.id],
    );
    propagated = Number(read.result.rows[0]?.n) === 1;
    if (propagated) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  assert.ok(propagated, "the thread, its reply and its task reached rw_followed_threads_v4");

  const rw = await getFollowedThreads(f.receiverServer.id, f.receiver.id);
  const legacy = await getFollowedThreads(f.receiverServer.id, f.receiver.id, undefined, { forceLegacyPath: true });
  const rwRow = rw.find((t) => t.threadChannelId === thread.id);
  assert.ok(rwRow);
  assert.deepEqual(rwRow, legacy.find((t) => t.threadChannelId === thread.id), "byte-identical to the legacy row");
  assert.equal(rwRow.taskId, task.id);
  assert.equal(rwRow.taskClaimedById, f.sender.id);
  assert.equal(rwRow.parentMessagePreview, `${longParent.slice(0, 100)}…`);
}, 180_000);

test.skipIf(!configured)("followed-thread stats are served by rw_followed_threads_v4 (legacy path)", async () => {
  const traced: Array<{ name: string; attrs: Record<string, unknown> | undefined }> = [];
  const traceQuery: DbQueryTracer = async (name, work, onComplete) => {
    const result = await work();
    traced.push({ name, attrs: onComplete?.(result) as Record<string, unknown> | undefined });
    return result;
  };
  const threads = await getFollowedThreads(f.receiverServer.id, f.receiver.id, undefined, { traceQuery, forceLegacyPath: true });
  const row = threads.find((thread) => thread.threadChannelId === f.thread.id);
  assert.ok(row, "the followed thread is listed");
  assert.equal(row.replyCount, 1);
  const stats = traced.find((entry) => entry.name === "channels.followed_threads_stats_by_threads");
  assert.equal(stats?.attrs?.backend, "risingwave", `stats read did not come from RisingWave: ${JSON.stringify(stats?.attrs)}`);
});

test.skipIf(!configured)("unfollowed and done threads list without error, with stats from rw_followed_threads_v4", async () => {
  const db = getDb();
  // A channel of its own (no agent member): parents posted in the shared
  // fixture's general would change the agent inbox counts asserted below.
  const [parentChannel] = await db.insert(channels).values({
    serverId: f.receiverServer.id, name: `rwreal-follow-states-${f.tag}`, type: "channel",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: parentChannel.id, userId: f.sender.id },
    { channelId: parentChannel.id, userId: f.receiver.id },
  ]);
  const seeded: Record<"unfollowed" | "done", string> = { unfollowed: "", done: "" };
  for (const kind of ["unfollowed", "done"] as const) {
    const [parent] = await db.insert(messages).values({
      channelId: parentChannel.id, senderType: "user", senderId: f.sender.id, content: `${kind} parent ${f.tag}`,
    }).returning();
    const [thread] = await db.insert(channels).values({
      serverId: f.receiverServer.id, name: `thread-${parent.id.slice(0, 8)}`, type: "thread", parentMessageId: parent.id,
    }).returning();
    await db.insert(messages).values({
      channelId: thread.id, senderType: "user", senderId: f.sender.id, content: `${kind} reply ${f.tag}`,
    });
    await db.insert(threadFollows).values({
      threadChannelId: thread.id, parentMessageId: parent.id, reason: "manual", followerType: "user", followerId: f.receiver.id,
      ...(kind === "unfollowed" ? { unfollowedAt: new Date() } : { doneAt: new Date() }),
    });
    seeded[kind] = thread.id;
  }

  const unfollowed = await getFollowedThreads(f.receiverServer.id, f.receiver.id, undefined, { state: "unfollowed_active" });
  assert.ok(unfollowed.some((t) => t.threadChannelId === seeded.unfollowed), "the unfollowed thread is listed");
  const done = await getFollowedThreads(f.receiverServer.id, f.receiver.id, undefined, { state: "done" });
  assert.ok(done.some((t) => t.threadChannelId === seeded.done), "the done thread is listed");
  // Activity "All" reads the unfollowed-active list; it must not 500.
  await getInboxItems(f.receiverServer.id, f.receiver.id, { filter: "all", limit: 50 });

  // Once CDC catches up, RW serves real stats for the done and unfollowed
  // follows too (v1 held only active follows, so these stayed stat-less).
  const timeoutMs = Number(process.env.RISINGWAVE_REAL_CDC_TIMEOUT_MS ?? 120_000);
  const deadline = Date.now() + timeoutMs;
  let replyCounts: Record<"unfollowed" | "done", number | undefined> = { unfollowed: undefined, done: undefined };
  do {
    const [u, d] = await Promise.all([
      getFollowedThreads(f.receiverServer.id, f.receiver.id, undefined, { state: "unfollowed_active" }),
      getFollowedThreads(f.receiverServer.id, f.receiver.id, undefined, { state: "done" }),
    ]);
    replyCounts = {
      unfollowed: u.find((t) => t.threadChannelId === seeded.unfollowed)?.replyCount,
      done: d.find((t) => t.threadChannelId === seeded.done)?.replyCount,
    };
    if (replyCounts.unfollowed === 1 && replyCounts.done === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  assert.deepEqual(replyCounts, { unfollowed: 1, done: 1 }, "RW serves stats for done and unfollowed follows");
}, 180_000);

test.skipIf(!configured)("rw_followed_threads_v4 counts unread with the chain rule: self-caused system and noise subtypes excluded, a peer's message counted", async () => {
  const db = getDb();
  // A channel of its own (no agent member), so the agent inbox counts below hold.
  const [parentChannel] = await db.insert(channels).values({
    serverId: f.receiverServer.id, name: `rwreal-chain-rule-${f.tag}`, type: "channel",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: parentChannel.id, userId: f.sender.id },
    { channelId: parentChannel.id, userId: f.receiver.id },
  ]);
  const [parent] = await db.insert(messages).values({
    channelId: parentChannel.id, senderType: "user", senderId: f.sender.id, content: `chain-rule parent ${f.tag}`,
  }).returning();
  const [thread] = await db.insert(channels).values({
    serverId: f.receiverServer.id, name: `thread-${parent.id.slice(0, 8)}`, type: "thread", parentMessageId: parent.id,
  }).returning();
  await db.insert(threadFollows).values({
    threadChannelId: thread.id, parentMessageId: parent.id, reason: "manual", followerType: "user", followerId: f.receiver.id,
  });
  // Oldest first, so first_unread_message_id also proves the exclusions.
  await db.insert(messages).values({
    channelId: thread.id, senderType: "user", senderId: "system", content: `receiver did this ${f.tag}`,
    messageType: "system", causalActorType: "user", causalActorId: f.receiver.id,
  });
  await db.insert(messages).values({
    channelId: thread.id, senderType: "user", senderId: "system", content: `task deleted ${f.tag}`,
    messageType: "system", systemSubtype: "task.deleted_summary",
  });
  const [peerReply] = await db.insert(messages).values({
    channelId: thread.id, senderType: "user", senderId: f.sender.id, content: `peer reply ${f.tag}`,
  }).returning();

  const timeoutMs = Number(process.env.RISINGWAVE_REAL_CDC_TIMEOUT_MS ?? 120_000);
  const deadline = Date.now() + timeoutMs;
  let row: Awaited<ReturnType<typeof getFollowedThreads>>[number] | undefined;
  do {
    const threads = await getFollowedThreads(f.receiverServer.id, f.receiver.id);
    row = threads.find((t) => t.threadChannelId === thread.id);
    if (row?.replyCount === 3) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  assert.ok(row, "the followed thread is listed");
  assert.equal(row.replyCount, 3, "reply count is every message in the thread, unfiltered");
  assert.equal(row.unreadCount, 1, "only the peer's message is unread");
  assert.equal(row.firstUnreadMessageId, peerReply.id);
}, 180_000);

test.skipIf(!configured)("agent inbox readers: chain rows, paged list, unread counts", async () => {
  const selection = await selectAgentInboxChainRows(f.agent.id);
  assert.equal(selection.source, "chain", `agent chain read failed: ${JSON.stringify(selection)}`);
  const rows = selection.source === "chain" ? selection.rows : [];
  const general = rows.find((row) => row.targetId === f.general.id);
  assert.ok(general, "the agent is offered its channel");
  assert.equal(general.unreadCount, 1);
  assert.equal(general.mentionUnread, 1);
  const joint = rows.find((row) => row.targetId === f.receiverLocal.id);
  assert.ok(joint, "the joint mention surfaces on the agent's own projection");
  assert.equal(joint.storageChannelId, f.canonical.id);
  assert.equal(joint.mentionUnread, 1);
  assert.equal(joint.maxMentionSeq, Number(f.jointMessage.seq));

  const counts = await getAgentUnreadCounts(f.agent.id, rows);
  assert.equal(Object.values(counts).reduce((sum, n) => sum + n, 0), 2);

  const page = await listAgentInbox(f.agent.id, f.receiverServer.id, { view: "unread", limit: 1 });
  assert.equal(page.items.length, 1, "LIMIT is inlined as a constant RisingWave accepts");
  assert.equal(page.hasMore, true);
  assert.equal(page.totals.conversations, 2);
  assert.equal(page.totals.mentions, 2);
  const next = await listAgentInbox(f.agent.id, f.receiverServer.id, {
    view: "mentions",
    limit: 5,
    beforeSeq: page.nextBeforeSeq ?? undefined,
  });
  assert.equal(next.items.length, 1, "keyset paging by activity_seq");
});
