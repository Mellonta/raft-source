import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
// External Agent inbox notice push (raft-agent-inbox-notice.v1) and `/events`
// cursor acks.
//
// Pins:
//   1. registration is agent-self, External-only, secret supplied by the
//      receiver, validated, stored encrypted and never returned;
//   2. a delivery to the agent's inbox is announced at once by a signed notice
//      (targets + "Inbox update" text, no bodies), without reading the chain,
//      and the notice never moves the inbox cursor;
//   3. notices merge per agent while one is in flight / backing off; a retry
//      sends the latest merged state; replicas never coordinate;
//   4. 3 consecutive 401/404/410 disable, 400 never disables, a new PUT
//      re-enables; the sweep re-announces unread a notice never reached, and
//      reminds once per pending state of unread still pending once the last
//      notice is stale;
//   5. `/events?ack=cursor` acknowledges on the next request's `since`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";

import { BasicTracer, MemoryTraceSink, type AgentMessage } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { traceAgentIdHash, traceServerIdHash } from "../tracing/traceIdentity";
import { agentInboxPushRegistrations, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel, getAgentLegacyReadCursor, type AgentInboxChainSelection } from "../services/channelService";
import {
  createMessage,
  __setExternalAgentInboxChainSelectorForTests,
} from "../services/messageService";
import { mintAgentCredential, revokeAgentCredential } from "../services/agentCredentialService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { recordInboxNotificationFacts } from "../services/inboxNotificationService";
import { recordAgentInboxEventsPendingAck } from "../services/agentInboxEvents";
import { __setAppWebhookEncryptionKeyForTests } from "../services/appWebhookConfigService";
import {
  AGENT_INBOX_NOTICE_DIRECT_LEASE_MS,
  AGENT_INBOX_NOTICE_POST_TIMEOUT_MS,
  AGENT_INBOX_NOTICE_REMIND_AFTER_MS,
  AGENT_INBOX_PUSH_BAD_REQUEST_RETRY_DELAYS_MS,
  startAgentInboxPushWorker,
  sweepAgentInboxNotices,
  type AgentInboxNotice,
} from "../services/agentInboxPushService";
import type { WebhookPost } from "../services/appNotificationDeliveryService";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

// `chainReads` counts inbox chain reads per agent: the notice hot path makes none.
const chainReads = new Map<string, number>();
__setExternalAgentInboxChainSelectorForTests(async (agentId: string): Promise<AgentInboxChainSelection> => {
  chainReads.set(agentId, (chainReads.get(agentId) ?? 0) + 1);
  return { source: "chain", rows: await referenceAgentInboxChain(agentId) };
});
__setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 9));

const SECRET = "Q2hvb3NlLWEtcmFuZG9tLXNlY3JldC1vZi0zMi1ieXRlcw_x"; // 47 base64url chars
const URL_A = "https://receiver.example.com/raft/inbox";

async function seedAgent(runtime: "external" | "claude" = "external") {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `inbox-push-${suffix}@slock.test`,
    name: `inbox-push-${suffix}`,
    displayName: "Inbox Push Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Inbox Push Test", `inbox-push-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, `PushExt${suffix.slice(0, 6)}`, runtime === "external"
    ? { runtime: "external", model: "external" }
    : { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, `inbox-push-room-${suffix.slice(0, 6)}`);
  await addHuman(channel.id, owner!.id);
  await addAgent(channel.id, agent.id);
  const minted = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "inbox-push-test", createdByUserId: null });
  return {
    ownerId: owner!.id,
    serverId: server.id,
    channelId: channel.id,
    channelName: channel.name,
    agentId: agent.id,
    apiKey: minted.apiKey,
    credentialId: minted.credentialId,
  };
}

type Fixture = Awaited<ReturnType<typeof seedAgent>>;

async function sendHumanMessage(f: Fixture, content: string) {
  const message = await createMessage(f.channelId, "user", f.ownerId, content);
  await recordInboxNotificationFacts([{
    receiverType: "agent",
    receiverId: f.agentId,
    serverId: f.serverId,
    kind: "channel",
    sourceChannelId: f.channelId,
    messageId: message.id,
    messageSeq: message.seq,
    activityAt: message.createdAt,
    personalMention: false,
    unreadEligible: true,
  }]);
  return message;
}

function freshProcess(app: { app: { set: (key: string, value: unknown) => void } }) {
  const orchestrator = new AgentOrchestrator() as any;
  app.app.set("agentOrchestrator", orchestrator);
  return orchestrator as AgentOrchestrator;
}

async function api(baseUrl: string, apiKey: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
}

async function register(app: { baseUrl: string }, f: Fixture, url = URL_A, secret = SECRET) {
  const res = await api(app.baseUrl, f.apiKey, "PUT", "/push-webhook", { url, secret });
  assert.equal(res.status, 200, res.raw);
  return res.body;
}

type Posted = { endpointUrl: string; body: string; headers: Record<string, string>; notice: AgentInboxNotice };

function recorder(responses: Array<Awaited<ReturnType<WebhookPost>> | Error>) {
  const posted: Posted[] = [];
  let index = 0;
  const post: WebhookPost = async (input) => {
    posted.push({ ...input, notice: JSON.parse(input.body) });
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    if (next instanceof Error) throw next;
    return next;
  };
  return { posted, post };
}

/** A clock `offsetMs` ahead of real time (the registration timestamps are real time). */
function clockAt(offsetMs: number) {
  return () => new Date(Date.now() + offsetMs);
}

async function registrationRow(agentId: string) {
  const [row] = await getDb().select().from(agentInboxPushRegistrations).where(eq(agentInboxPushRegistrations.agentId, agentId));
  return row!;
}

/** The AgentMessage the orchestrator hands over when it delivers a persisted message to the inbox. */
function delivered(f: Fixture, message: { id: string; seq: number; content: string; createdAt: Date }, extra: Partial<AgentMessage> = {}): AgentMessage {
  return {
    channel_id: f.channelId,
    channel_name: f.channelName,
    channel_type: "channel",
    sender_id: f.ownerId,
    sender_name: "owner",
    sender_type: "human",
    content: message.content,
    timestamp: message.createdAt.toISOString(),
    seq: message.seq,
    message_id: message.id,
    ...extra,
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition(), "condition not reached in time");
}

async function withWorker<T>(
  orchestrator: AgentOrchestrator,
  post: WebhookPost,
  run: (worker: ReturnType<typeof startAgentInboxPushWorker>) => Promise<T>,
  options: Partial<Parameters<typeof startAgentInboxPushWorker>[0]> = {},
): Promise<T> {
  const worker = startAgentInboxPushWorker({
    agentOrchestrator: orchestrator,
    post,
    sweepIntervalMs: 60 * 60_000,
    tracer: new BasicTracer({ sink: new MemoryTraceSink() }),
    ...options,
  });
  try {
    return await run(worker);
  } finally {
    worker.stop();
  }
}

test("registration: agent-self PUT/GET/DELETE, receiver secret validated and never returned", async ({ app }) => {
  const f = await seedAgent();

  for (const [body, code] of [
    [{ url: URL_A, secret: "short" }, "INVALID_SECRET"],
    [{ url: URL_A, secret: "a".repeat(64) }, "INVALID_SECRET"],
    [{ url: URL_A, secret: "0123456789abcdef".repeat(3) }, "INVALID_SECRET"],
    [{ url: "http://receiver.example.com/x", secret: SECRET }, "INVALID_URL"],
    [{ url: "https://127.0.0.1/x", secret: SECRET }, "INVALID_URL"],
    [{ url: URL_A, secret: SECRET, extra: true }, "INVALID_BODY"],
  ] as const) {
    const res = await api(app.baseUrl, f.apiKey, "PUT", "/push-webhook", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, code);
  }
  assert.equal((await api(app.baseUrl, f.apiKey, "PUT", "/push-webhook", { url: URL_A, secret: "0123456789abcdef".repeat(4) })).status, 200, "64 hex chars");

  const status = await register(app, f);
  assert.equal(status.registered, true);
  assert.equal(status.url, URL_A);
  assert.equal(status.enabled, true);
  assert.equal(status.consecutiveFailures, 0);
  const got = await api(app.baseUrl, f.apiKey, "GET", "/push-webhook");
  assert.equal(got.status, 200);
  assert.deepEqual(Object.keys(got.body).sort(), [
    "consecutiveFailures", "disabledAt", "disabledReason", "enabled", "lastAttemptAt", "lastDeliveryAt", "lastError", "nextAttemptAt", "registered", "url",
  ]);
  assert.ok(!got.raw.includes(SECRET), "the secret is never returned");
  const row = await registrationRow(f.agentId);
  assert.ok(!JSON.stringify(row).includes(SECRET), "the secret is stored encrypted");
  assert.equal(row.credentialId, f.credentialId, "bound to the calling credential");

  assert.equal((await api(app.baseUrl, f.apiKey, "DELETE", "/push-webhook")).status, 204);
  assert.equal((await api(app.baseUrl, f.apiKey, "GET", "/push-webhook")).body.registered, false);
});

test("registration: a managed agent is refused (it uses the daemon transport)", async ({ app }) => {
  const f = await seedAgent("claude");
  const res = await api(app.baseUrl, f.apiKey, "PUT", "/push-webhook", { url: URL_A, secret: SECRET });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "AGENT_NOT_EXTERNAL");
});


test("notice: a delivery is announced at once, signed, with targets and text, no bodies, no chain read, no cursor move", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "secret body text");
  const cursorBefore = await getAgentLegacyReadCursor(f.agentId, f.channelId);
  const readsBefore = chainReads.get(f.agentId) ?? 0;
  const rec = recorder([{
    status: 200,
    requestId: "rcv-req-7f3a",
    timing: { dnsMs: 12, connectMs: 41, tlsMs: 96, ttfbMs: 612, socketReused: false },
  }]);
  const sink = new MemoryTraceSink();
  await withWorker(orchestrator, rec.post, async (worker) => {
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m1, { mentioned: true }));
    await waitFor(() => rec.posted.length === 1);
    await worker.idle();
  }, { tracer: new BasicTracer({ sink }) });

  assert.equal(chainReads.get(f.agentId) ?? 0, readsBefore, "the hot path never reads the inbox chain");
  const [posted] = rec.posted;
  const notice = posted!.notice;
  assert.deepEqual(Object.keys(notice).sort(), ["noticeId", "occurredAt", "recipientAgentId", "schema", "targets", "text"]);
  assert.equal(notice.schema, "raft-agent-inbox-notice.v1");
  assert.equal(notice.recipientAgentId, f.agentId);
  assert.equal(posted!.headers["x-raft-delivery-id"], notice.noticeId);
  assert.equal(posted!.headers["x-raft-signature-256"], `sha256=${createHmac("sha256", SECRET).update(posted!.body).digest("hex")}`);
  assert.deepEqual(notice.targets, [{
    target: `#${f.channelName}`,
    channelId: f.channelId,
    channelType: "channel",
    pendingCount: 1,
    firstPendingMsgId: m1.id,
    latestMsgId: m1.id,
    latestSenderName: "owner",
    latestSenderType: "human",
    flags: ["mention"],
  }]);
  assert.match(notice.text, /^Inbox update: 1 changed target\n#inbox-push-room-/);
  assert.ok(!posted!.body.includes("secret body text"), "no message bodies");
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), cursorBefore, "a notice moves no cursor");
  const status = (await api(app.baseUrl, f.apiKey, "GET", "/push-webhook")).body;
  assert.ok(status.lastDeliveryAt);
  assert.equal(status.consecutiveFailures, 0);

  const span = sink.getAllSpans().find((candidate) => candidate.name === "server.agent_push.notice");
  assert.equal(span?.attrs?.mode, "direct");
  assert.equal(span?.attrs?.outcome, "delivered");
  assert.equal(span?.attrs?.http_status, 200);
  assert.equal(span?.attrs?.targets_count, 1);
  assert.equal(typeof span?.attrs?.latency_ms, "number");
  // Correlation: the notice carries this span's trace id; the receiver's request id lands on the span.
  assert.equal(posted!.headers["x-raft-trace-id"], span?.context.traceId);
  assert.match(posted!.headers["x-raft-trace-id"] ?? "", /^[0-9a-f]{32}$/);
  assert.equal(span?.attrs?.["push.response_request_id"], "rcv-req-7f3a");
  // Where the POST's time went (cumulative ms): DNS, connect, TLS, first byte.
  assert.equal(span?.attrs?.["push.dns_ms"], 12);
  assert.equal(span?.attrs?.["push.connect_ms"], 41);
  assert.equal(span?.attrs?.["push.tls_ms"], 96);
  assert.equal(span?.attrs?.["push.ttfb_ms"], 612);
  assert.equal(span?.attrs?.["push.socket_reused"], false);
  // Grouping by agent without the raw id: the keyed hash, never agentId itself.
  assert.match(String(span?.attrs?.agent_id_hash), /^[0-9a-f]{16}$/);
  assert.equal(span?.attrs?.agent_id_hash, traceAgentIdHash(f.agentId));
  assert.equal(span?.attrs?.server_id_hash, traceServerIdHash(f.serverId));
  const raw = JSON.stringify(span);
  assert.ok(!raw.includes("receiver.example.com") && !raw.includes("secret body") && !raw.includes(SECRET), "no URL, content or secret in trace");
  assert.ok(!raw.includes(f.agentId), "no raw agent id in trace");
  assert.ok(!raw.includes(f.serverId), "no raw server id in trace");
});

test("notice: deliveries while a notice is in flight merge into the next one", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const [m1, m2, m3] = [await sendHumanMessage(f, "one"), await sendHumanMessage(f, "two"), await sendHumanMessage(f, "three")];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const posted: AgentInboxNotice[] = [];
  const post: WebhookPost = async (input) => {
    posted.push(JSON.parse(input.body));
    if (posted.length === 1) await gate;
    return { status: 200 };
  };
  await withWorker(orchestrator, post, async (worker) => {
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m1));
    await waitFor(() => posted.length === 1);
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m2));
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m3));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(posted.length, 1, "one notice in flight per agent");
    release();
    await waitFor(() => posted.length === 2);
    await worker.idle();
  });
  assert.equal(posted[0]!.targets[0]!.pendingCount, 1);
  const merged = posted[1]!.targets[0]!;
  assert.equal(merged.pendingCount, 2);
  assert.equal(merged.firstPendingMsgId, m2.id);
  assert.equal(merged.latestMsgId, m3.id);
});

test("notice: two replicas notify independently (harmless duplicates, no coordination)", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const replicaA = new AgentOrchestrator();
  const replicaB = new AgentOrchestrator();
  const m1 = await sendHumanMessage(f, "on a");
  const m2 = await sendHumanMessage(f, "on b");
  const rec = recorder([{ status: 200 }]);
  await withWorker(replicaA, rec.post, (workerA) => withWorker(replicaB, rec.post, async (workerB) => {
    replicaA.emit("external-inbox-delivered", f.agentId, delivered(f, m1));
    replicaB.emit("external-inbox-delivered", f.agentId, delivered(f, m2));
    await waitFor(() => rec.posted.length === 2);
    await workerA.idle();
    await workerB.idle();
  }));
  assert.deepEqual(rec.posted.map((p) => p.notice.targets[0]!.latestMsgId).sort(), [m1.id, m2.id].sort());
  assert.equal((await registrationRow(f.agentId)).consecutiveFailures, 0);
});

test("notice: 5xx backs off and the retry sends the latest merged state", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "first");
  const m2 = await sendHumanMessage(f, "second");
  const rec = recorder([{ status: 503 }, { status: 200 }]);
  let offsetMs = 0;
  await withWorker(orchestrator, rec.post, async (worker) => {
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m1));
    await waitFor(() => rec.posted.length === 1);
    await waitFor(() => (rec.posted.length === 1));
    const row = await waitForRow(f.agentId, (r) => r.consecutiveFailures === 1);
    assert.equal(row.lastError, "http_503");
    // Arrives during the backoff: merged, not sent on its own.
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(rec.posted.length, 1);
    offsetMs = 60_000; // the backoff is over when the retry timer fires
    await waitFor(() => rec.posted.length === 2);
    await worker.idle();
  }, { clock: () => new Date(Date.now() + offsetMs), retryTimerMs: () => 100 });
  const retried = rec.posted[1]!.notice.targets[0]!;
  assert.equal(retried.pendingCount, 2, "the failed rows and the newer one");
  assert.equal(retried.firstPendingMsgId, m1.id);
  assert.equal(retried.latestMsgId, m2.id);
  assert.notEqual(rec.posted[1]!.notice.noticeId, rec.posted[0]!.notice.noticeId);
  assert.equal((await registrationRow(f.agentId)).consecutiveFailures, 0);
});

async function waitForRow(agentId: string, predicate: (row: Awaited<ReturnType<typeof registrationRow>>) => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await registrationRow(agentId);
    if (predicate(row) || Date.now() > deadline) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("notice: 3 consecutive 404/410/401 disable; 400 never counts; a new PUT re-enables", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "one");
  const rec = recorder([{ status: 404 }, { status: 400 }, { status: 410 }, { status: 401 }, { status: 401 }]);
  let offsetMs = 0;
  await withWorker(orchestrator, rec.post, async () => {
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m1));
    for (let sent = 1; sent <= 4; sent += 1) {
      await waitFor(() => rec.posted.length === sent);
      await waitForRow(f.agentId, (row) => row.consecutiveFailures === sent || row.disabledAt !== null);
      offsetMs += 7 * 60 * 60_000; // past any backoff, 400's included
    }
    await waitForRow(f.agentId, (row) => row.disabledAt !== null);
  }, { clock: () => new Date(Date.now() + offsetMs), retryTimerMs: () => 20 });
  const status = (await api(app.baseUrl, f.apiKey, "GET", "/push-webhook")).body;
  // 404 then 400 (breaks the streak), then 410, 401, 401: the third in a row disables.
  assert.equal(rec.posted.length, 5);
  assert.equal(status.enabled, false);
  assert.equal(status.disabledReason, "endpoint_rejected");
  const reenabled = await register(app, f);
  assert.equal(reenabled.enabled, true);
  assert.equal(reenabled.consecutiveFailures, 0);
});

test("400: recorded as lastError, retried on the long schedule, never disables", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "one");
  const rec = recorder([{ status: 400 }]);
  await withWorker(orchestrator, rec.post, async () => {
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m1));
    await waitFor(() => rec.posted.length === 1);
    const row = await waitForRow(f.agentId, (r) => r.consecutiveFailures === 1);
    assert.equal(row.lastError, "http_400");
    assert.equal(row.consecutiveRejections, 0);
    assert.equal(row.disabledAt, null);
    assert.ok(row.nextAttemptAt.getTime() >= Date.now() + AGENT_INBOX_PUSH_BAD_REQUEST_RETRY_DELAYS_MS[0]! - 5_000);
  });
});

test("POST is bounded: a hung receiver costs one timed-out attempt", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "one");
  const hung: WebhookPost = () => new Promise(() => undefined);
  const started = Date.now();
  await withWorker(orchestrator, hung, async () => {
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m1));
    const row = await waitForRow(f.agentId, (r) => r.consecutiveFailures === 1, 25_000);
    assert.equal(row.lastError, "timeout");
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= AGENT_INBOX_NOTICE_POST_TIMEOUT_MS - 500 && elapsed < AGENT_INBOX_NOTICE_POST_TIMEOUT_MS + 8_000, `bounded at ${elapsed} ms`);
}, 30_000);

test("sweep: unread written after the last delivered notice (a dropped notice) is announced; nothing new, no notice", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "notice for this was lost");
  const rec = recorder([{ status: 200 }]);
  const sink = new MemoryTraceSink();
  const first = await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId], tracer: new BasicTracer({ sink }) });
  assert.equal(first.sent, 1);
  assert.equal(rec.posted[0]!.notice.targets[0]!.latestMsgId, m1.id);
  const spans = sink.getAllSpans();
  assert.ok(spans.some((span) => span.name === "server.agent_push.sweep" && span.attrs?.sent === 1));
  assert.equal(spans.find((span) => span.name === "server.agent_push.notice")?.attrs?.mode, "sweep");
  assert.equal(spans.find((span) => span.name === "server.agent_push.notice")?.attrs?.reason, "new");

  const again = await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId] });
  assert.equal(again.sent, 0, "the unread was announced already");
  assert.equal(rec.posted.length, 1);
});

test("sweep: unread still pending after a stale notice (the pull beat the chain) is reminded once per pending state", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "notified, but the pull saw an empty chain");
  // The hot-path notice for m1 was delivered after m1 was written.
  await getDb().update(agentInboxPushRegistrations).set({ lastDeliveryAt: new Date(m1.createdAt.getTime() + 1) })
    .where(eq(agentInboxPushRegistrations.agentId, f.agentId));
  const rec = recorder([{ status: 200 }]);
  const sweep = (options: { remindAfterMs?: number; tracer?: BasicTracer } = {}) =>
    sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId], ...options });

  const fresh = await sweep();
  assert.equal(fresh.checked, 1);
  assert.equal(fresh.sent, 0, `a notice fresher than ${AGENT_INBOX_NOTICE_REMIND_AFTER_MS} ms with nothing new is not repeated`);
  assert.equal(rec.posted.length, 0);

  // A short interval stands in for the default one, so the clock stays real.
  const remindAfterMs = 50;
  const elapse = () => new Promise((resolve) => setTimeout(resolve, remindAfterMs + 20));
  await elapse();
  const sink = new MemoryTraceSink();
  const reminded = await sweep({ remindAfterMs, tracer: new BasicTracer({ sink }) });
  assert.equal(reminded.sent, 1);
  assert.equal(rec.posted[0]!.notice.targets[0]!.latestMsgId, m1.id);
  const notice = sink.getAllSpans().find((span) => span.name === "server.agent_push.notice");
  assert.equal(notice?.attrs?.mode, "sweep");
  assert.equal(notice?.attrs?.reason, "remind");
  const remindedAt = (await registrationRow(f.agentId)).lastDeliveryAt!;
  assert.ok(remindedAt.getTime() > m1.createdAt.getTime() + 1, "the reminder moves lastDeliveryAt");

  // A stable backlog: silence across further sweeps, however many intervals pass.
  for (let i = 0; i < 4; i += 1) {
    await elapse();
    const later = await sweep({ remindAfterMs });
    assert.equal(later.sent, 0, "a pending state is reminded once");
  }
  assert.equal(rec.posted.length, 1);

  // New unread after that is a normal notice.
  const m2 = await sendHumanMessage(f, "new after the reminder");
  const newSink = new MemoryTraceSink();
  const announced = await sweep({ remindAfterMs, tracer: new BasicTracer({ sink: newSink }) });
  assert.equal(announced.sent, 1);
  assert.equal(rec.posted[1]!.notice.targets[0]!.latestMsgId, m2.id);
  assert.equal(newSink.getAllSpans().find((span) => span.name === "server.agent_push.notice")?.attrs?.reason, "new");
});

test("sweep: replicas sweeping at once send one reminder per pending state", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "pending while every replica sweeps");
  await getDb().update(agentInboxPushRegistrations).set({ lastDeliveryAt: new Date(m1.createdAt.getTime() + 1) })
    .where(eq(agentInboxPushRegistrations.agentId, f.agentId));
  const rec = recorder([{ status: 200 }, { status: 200 }, { status: 200 }, { status: 200 }]);
  const remindAfterMs = 50;
  await new Promise((resolve) => setTimeout(resolve, remindAfterMs + 20));
  // Four replicas sweep the same registration concurrently.
  const results = await Promise.all(Array.from({ length: 4 }, () =>
    sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId], remindAfterMs })));
  assert.equal(results.reduce((sum, result) => sum + result.sent, 0), 1);
  assert.equal(rec.posted.length, 1);
  assert.equal((await registrationRow(f.agentId)).remindedMaxSeq, Number(m1.seq));

  // A later sweep (any replica, e.g. one that just restarted) does not repeat it.
  await new Promise((resolve) => setTimeout(resolve, remindAfterMs + 20));
  const later = await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId], remindAfterMs });
  assert.equal(later.sent, 0);
  assert.equal(rec.posted.length, 1);
});

test("sweep: a second sweep during an in-flight sweep notice does not send it again", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  await sendHumanMessage(f, "notice for this was lost");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const posted: string[] = [];
  const slowPost: WebhookPost = async (input) => {
    posted.push(input.body);
    await gate;
    return { status: 200 };
  };
  const first = sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: slowPost, agentIds: [f.agentId] });
  // Wait until the first sweep is mid-POST, then sweep again from "another replica".
  while (posted.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: slowPost, agentIds: [f.agentId] });
  assert.equal(second.sent, 0);
  release();
  assert.equal((await first).sent, 1);
  assert.equal(posted.length, 1);
  assert.equal((await registrationRow(f.agentId)).leaseExpiresAt, null, "the lease ends with the send");
});

/** A post that records each call and holds it until `release()`. */
function gatedPost() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const posted: string[] = [];
  const post: WebhookPost = async (input) => {
    posted.push(input.body);
    await gate;
    return { status: 200 };
  };
  return { posted, post, release };
}

test("sweep: a direct notice in flight holds the registration; the sweep skips it", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "direct notice on a slow receiver");
  const direct = gatedPost();
  const rec = recorder([{ status: 200 }]);
  await withWorker(orchestrator, direct.post, async (worker) => {
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m1));
    await waitFor(() => direct.posted.length === 1);
    // Another replica's sweep sees unread with no delivered notice yet.
    const swept = await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId] });
    assert.equal(swept.sent, 0, "the direct notice is on the wire");
    assert.equal(rec.posted.length, 0);
    direct.release();
    await worker.idle();
  });
  assert.equal(direct.posted.length, 1);
  assert.equal((await registrationRow(f.agentId)).leaseExpiresAt, null, "the direct send hands its lease back");
});

test("sweep: once a stuck direct notice's lease expires, the sweep takes over", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "direct notice that never comes back");
  const direct = gatedPost();
  const rec = recorder([{ status: 200 }]);
  await withWorker(orchestrator, direct.post, async (worker) => {
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m1));
    await waitFor(() => direct.posted.length === 1);
    // No cleanup ran (as after a crash); the sweep's clock is past the lease.
    const swept = await sweepAgentInboxNotices({
      agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId],
      clock: clockAt(AGENT_INBOX_NOTICE_DIRECT_LEASE_MS + 1_000),
    });
    assert.equal(swept.sent, 1);
    assert.equal(rec.posted[0]!.notice.targets[0]!.latestMsgId, m1.id);
    direct.release();
    await worker.idle();
  });
});

test("sweep: rows a cursor pull already handed over are neither re-announced nor reminded", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "handed over, not yet acknowledged");
  await recordAgentInboxEventsPendingAck(f.agentId, [Number(m1.seq)]);
  const rec = recorder([{ status: 200 }]);
  const remindAfterMs = 50;
  await new Promise((resolve) => setTimeout(resolve, remindAfterMs + 20));
  const swept = await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId], remindAfterMs });
  assert.equal(swept.sent, 0);
  assert.equal(rec.posted.length, 0);

  // Unread written after the hand-over is still announced.
  const m2 = await sendHumanMessage(f, "new after the pull");
  const next = await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId], remindAfterMs });
  assert.equal(next.sent, 1);
  assert.equal(rec.posted[0]!.notice.targets[0]!.latestMsgId, m2.id);
});

test("credential revocation stops notices", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  await revokeAgentCredential({ credentialId: f.credentialId, reason: "test" });
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "after revoke");
  const rec = recorder([{ status: 200 }]);
  await withWorker(orchestrator, rec.post, async (worker) => {
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m1));
    await waitForRow(f.agentId, (row) => row.disabledAt !== null);
    await worker.idle();
  });
  assert.equal(rec.posted.length, 0);
  assert.equal((await registrationRow(f.agentId)).disabledReason, "credential_revoked");
});

test("cross-agent isolation: a notice goes only to the recipient's own endpoint", async ({ app }) => {
  const a = await seedAgent();
  const b = await seedAgent();
  await register(app, a, "https://a.example.com/hook");
  await register(app, b, "https://b.example.com/hook", `${SECRET}B`);
  const orchestrator = freshProcess(app);
  const aMsg = await sendHumanMessage(a, "for a");
  const rec = recorder([{ status: 200 }]);
  await withWorker(orchestrator, rec.post, async (worker) => {
    orchestrator.emit("external-inbox-delivered", a.agentId, delivered(a, aMsg));
    await waitFor(() => rec.posted.length === 1);
    await worker.idle();
  });
  assert.equal(rec.posted[0]!.endpointUrl, "https://a.example.com/hook");
  assert.equal(rec.posted[0]!.notice.recipientAgentId, a.agentId);
  assert.equal((await api(app.baseUrl, b.apiKey, "GET", "/push-webhook")).body.url, "https://b.example.com/hook");
  assert.equal((await api(app.baseUrl, b.apiKey, "DELETE", "/push-webhook")).status, 204);
  assert.equal((await api(app.baseUrl, a.apiKey, "GET", "/push-webhook")).body.registered, true);
});

test("/events ack=cursor: a lost response is delivered again; the next since acknowledges it", async ({ app }) => {
  const f = await seedAgent();
  const m1 = await sendHumanMessage(f, "one");
  const m2 = await sendHumanMessage(f, "two");
  const cursorBefore = await getAgentLegacyReadCursor(f.agentId, f.channelId);
  freshProcess(app);

  const first = await api(app.baseUrl, f.apiKey, "GET", "/events?ack=cursor");
  assert.equal(first.body.ack_mode, "cursor");
  assert.deepEqual(first.body.events.map((e: any) => e.seq), [m1.seq, m2.seq]);
  assert.equal(first.body.last_seen_seq, m2.seq);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), cursorBefore, "not acknowledged by the response");

  // The response was lost: the client repeats its old cursor (none yet).
  const again = await api(app.baseUrl, f.apiKey, "GET", "/events?ack=cursor");
  assert.deepEqual(again.body.events.map((e: any) => e.seq), [m1.seq, m2.seq], "delivered again");

  const m3 = await sendHumanMessage(f, "three");
  const next = await api(app.baseUrl, f.apiKey, "GET", `/events?ack=cursor&since=${again.body.last_seen_seq}`);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), m2.seq, "since acknowledged the previous batch");
  assert.deepEqual(next.body.events.map((e: any) => e.seq), [m3.seq]);
  // Lost again: repeating the same since re-delivers m3 and acknowledges nothing new.
  const repeat = await api(app.baseUrl, f.apiKey, "GET", `/events?ack=cursor&since=${again.body.last_seen_seq}`);
  assert.deepEqual(repeat.body.events.map((e: any) => e.seq), [m3.seq]);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), m2.seq);
  const done = await api(app.baseUrl, f.apiKey, "GET", `/events?ack=cursor&since=${repeat.body.last_seen_seq}`);
  assert.deepEqual(done.body.events, []);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), m3.seq);
});

test("/events without ack=cursor keeps the immediate ack published clients rely on", async ({ app }) => {
  const f = await seedAgent();
  const m1 = await sendHumanMessage(f, "legacy");
  freshProcess(app);
  const first = await api(app.baseUrl, f.apiKey, "GET", "/events?since=latest");
  assert.equal(first.body.ack_mode, "immediate");
  assert.deepEqual(first.body.events.map((e: any) => e.seq), [m1.seq]);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), m1.seq);
  assert.deepEqual((await api(app.baseUrl, f.apiKey, "GET", "/events?since=latest")).body.events, []);
  // A constant/stale numeric since (a published SDK caller) never loops either.
  const m2 = await sendHumanMessage(f, "legacy two");
  assert.deepEqual((await api(app.baseUrl, f.apiKey, "GET", "/events?since=0")).body.events.map((e: any) => e.seq), [m2.seq]);
  assert.deepEqual((await api(app.baseUrl, f.apiKey, "GET", "/events?since=0")).body.events, []);
});

test("production wiring: server.ts starts the push worker with the server tracer", () => {
  // The worker's tracer is a required dependency; this pins that bootstrap
  // hands it the server tracer (so server.agent_push.* spans reach the sink),
  // not a stand-in.
  const serverSource = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  assert.match(serverSource, /startAgentInboxPushWorker\(\{\s*agentOrchestrator,\s*tracer: serverTracer\.tracer\s*\}\)/);
});
