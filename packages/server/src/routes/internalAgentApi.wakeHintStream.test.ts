import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
// task #72 — D7 T1 SSE wake-hint stream route tests, against the wire
// contract (#wg-external-agent:0b2a7438 msg=3f265263): content-free,
// non-draining, zero server-side cursor effects, replay-then-live,
// Last-Event-ID dedup, auth fails as JSON before the stream opens.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import argon2 from "argon2";

import { getDb } from "../db/index";
import { machines as machinesTable, users } from "../db/schema";
import { openTestApp } from "../test/integration/app";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { createChannel, addAgent, addHuman } from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import { createMessage, __setExternalAgentInboxChainSelectorForTests, __setExternalWakeFollowUpPullDelaysMsForTests } from "../services/messageService";


const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

// CI has no RisingWave: the external agent inbox pull reads the test-only
// reference derivation of the agent inbox chain.
__setExternalAgentInboxChainSelectorForTests(async (agentId: string) => ({ source: "chain", rows: await referenceAgentInboxChain(agentId) }));

async function seedExternalFixture() {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `wake-stream-${suffix}@slock.test`,
    name: `wake-stream-${suffix}`,
    displayName: "Wake Stream Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Wake Stream Test", `wake-stream-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, "WakeStreamExt", { runtime: "external", model: "external" });
  const channel = await createChannel(server.id, "wake-stream-room");
  await addHuman(channel.id, owner!.id);
  await addAgent(channel.id, agent.id);
  const minted = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read"],
    name: "wake-stream-test",
    createdByUserId: null,
  });
  return { ownerId: owner!.id, ownerName: owner!.name, serverId: server.id, channelId: channel.id, channelName: channel.name, agentId: agent.id, apiKey: minted.apiKey };
}

type Fixture = Awaited<ReturnType<typeof seedExternalFixture>>;

/**
 * Persist a message and hand its live delivery to the orchestrator, as the
 * send path does. An external agent's persisted messages are served from its
 * durable inbox; the delivery is only the wake signal.
 */
async function sendAndDeliver(orchestrator: any, f: Fixture, content: string) {
  const message = await createMessage(f.channelId, "user", f.ownerId, content);
  await orchestrator.deliverMessage(f.agentId, {
    channel_id: f.channelId,
    channel_name: f.channelName,
    channel_type: "channel" as const,
    sender_id: f.ownerId,
    sender_name: f.ownerName,
    sender_type: "human" as const,
    content,
    timestamp: new Date().toISOString(),
    seq: message.seq,
    message_id: message.id,
  });
  return message;
}

/** Read SSE frames from a fetch body until `count` wake-hint events or timeout. */
async function readWakeHintEvents(body: ReadableStream<Uint8Array>, count: number, timeoutMs = 8000): Promise<{ events: Array<{ id: string; data: any }>; raw: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let raw = "";
  const events: Array<{ id: string; data: any }> = [];
  const deadline = Date.now() + timeoutMs;
  while (events.length < count && Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), Math.max(50, deadline - Date.now()))),
    ]);
    if (next.done) break;
    const chunk = decoder.decode(next.value, { stream: true });
    buffer += chunk;
    raw += chunk;
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      if (!frame.includes("event: wake-hint")) continue;
      const idLine = frame.split("\n").find((l) => l.startsWith("id: "));
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      events.push({ id: idLine?.slice(4) ?? "", data: dataLine ? JSON.parse(dataLine.slice(6)) : null });
    }
  }
  await reader.cancel().catch(() => {});
  return { events, raw };
}

test("stream replays pending hints, pushes live ones, leaks no body, drains nothing", async ({ app }) => {
  const f = await seedExternalFixture();
  const orchestrator = new AgentOrchestrator() as any;
  app.app.set("agentOrchestrator", orchestrator);

  // Pending BEFORE connect → must replay on connect.
  const before = await sendAndDeliver(orchestrator, f, "secret body before connect");
  let after: { seq: number } | undefined;

  const res = await fetch(`${app.baseUrl}/internal/agent-api/wake-hints/stream`, {
    headers: { Authorization: `Bearer ${f.apiKey}` },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

  // Live push AFTER connect.
  setTimeout(() => {
    void sendAndDeliver(orchestrator, f, "secret body after connect").then((message) => { after = message; });
  }, 250);

  const { events, raw } = await readWakeHintEvents(res.body!, 2);
  assert.equal(events.length, 2, `expected replay + live event, got ${events.length}: ${raw}`);
  assert.deepEqual(events.map((e) => e.id), [String(before.seq), String(after?.seq)]);
  for (const e of events) {
    assert.equal(typeof e.data.event_id, "string");
    assert.equal(typeof e.data.message_id, "string");
    assert.equal(typeof e.data.seq, "number");
  }
  // Content-free: bodies never cross the stream.
  assert.doesNotMatch(raw, /secret body/);

  // Non-draining + zero server-side cursor effect: the poll route still
  // returns BOTH hints after the stream consumed them, twice.
  for (let i = 0; i < 2; i += 1) {
    const poll = await fetch(`${app.baseUrl}/internal/agent-api/wake-hints`, {
      headers: { Authorization: `Bearer ${f.apiKey}` },
    });
    const body = await poll.json() as { wake_hints?: unknown[] };
    assert.equal(body.wake_hints?.length, 2, "stream consumption must be a peek: poll still sees both hints");
  }
});

test("stream honors Last-Event-ID: already-seen hints are not replayed", async ({ app }) => {
  const f = await seedExternalFixture();
  const orchestrator = new AgentOrchestrator() as any;
  app.app.set("agentOrchestrator", orchestrator);
  const older = await sendAndDeliver(orchestrator, f, "old");
  const newer = await sendAndDeliver(orchestrator, f, "new");

  const res = await fetch(`${app.baseUrl}/internal/agent-api/wake-hints/stream`, {
    headers: { Authorization: `Bearer ${f.apiKey}`, "Last-Event-ID": String(older.seq) },
  });
  const { events } = await readWakeHintEvents(res.body!, 1, 4000);
  assert.deepEqual(events.map((e) => e.id), [String(newer.seq)], "seq<=Last-Event-ID must be filtered from replay");
});

test("auth failure is a JSON error before any stream opens", async ({ app }) => {
  const res = await fetch(`${app.baseUrl}/internal/agent-api/wake-hints/stream`, {
    headers: { Authorization: "Bearer sk_agent_invalid" },
  });
  assert.ok(res.status === 401 || res.status === 403, `expected auth rejection, got ${res.status}`);
  assert.doesNotMatch(res.headers.get("content-type") ?? "", /text\/event-stream/);
});

test("a valid sk_machine credential is rejected before the stream opens (wrong principal, #73 anchor)", async ({ app }) => {
  const f = await seedExternalFixture();
  // Mint a REAL machine credential on the same server — the centralized
  // fail-closed dispatcher must still 401 it on this sk_agent-only path.
  const machineKey = `sk_machine_${randomUUID().replaceAll("-", "")}`;
  await getDb().insert(machinesTable).values({
    serverId: f.serverId,
    userId: f.ownerId,
    name: `wake-stream-machine-${randomUUID()}`,
    apiKeyHash: await argon2.hash(machineKey),
  });

  const res = await fetch(`${app.baseUrl}/internal/agent-api/wake-hints/stream`, {
    headers: { Authorization: `Bearer ${machineKey}` },
  });
  assert.ok(res.status === 401 || res.status === 403, `wrong principal must be rejected, got ${res.status}`);
  assert.doesNotMatch(res.headers.get("content-type") ?? "", /text\/event-stream/, "rejection must happen before any SSE upgrade");
});

// Field incident 2026-06-11 (#wg-external-agent:00fcc8f7): external-agent
// deliveries buffer process-locally and the stream's live push listens to an
// in-process emitter, so a delivery handled by another replica was invisible
// to a healthy connected stream until client-side reconciliation (~2min).
// The heartbeat must double as a server-side reconcile tick: re-peek durable
// (CS-4 rebuild) and push what the emitter never announced. Pins (Kai):
// the peek must FIRE on the heartbeat path (not just be correct in isolation),
// stay non-draining / zero-cursor, and not double-push what was already sent.
test("heartbeat tick pushes durable pending the in-process emitter never announced (split-brain rescue)", async () => {
  process.env.SLOCK_WAKE_STREAM_HEARTBEAT_MS = "300";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const f = await seedExternalFixture();
    const orchestrator = new AgentOrchestrator() as any;
    app.app.set("agentOrchestrator", orchestrator);

    // Watermark exists (CS-4 precondition), nothing pending at connect time.
    const { createMessage } = await import("../services/messageService");
    const { markAgentLegacyRead, getAgentLegacyReadCursor } = await import("../services/channelService");
    const base = await createMessage(f.channelId, "user", f.ownerId, "seen before connect");
    await markAgentLegacyRead(f.agentId, f.channelId, base.seq);

    const res = await fetch(`${app.baseUrl}/internal/agent-api/wake-hints/stream`, {
      headers: { Authorization: `Bearer ${f.apiKey}` },
    });
    assert.equal(res.status, 200);

    // Cross-replica simulation: the durable row exists, but THIS process's
    // orchestrator never buffered it and never emitted — like a fan-out that
    // happened on another replica.
    const missed = await createMessage(f.channelId, "user", f.ownerId, "fanned out on another replica");

    // Single reader session: ask for 2 events with a deadline that spans
    // several heartbeats — exactly 1 must arrive (the missed delivery), and
    // later heartbeats must NOT re-push the same seq (dedup via lastSentSeq).
    const { events, raw } = await readWakeHintEvents(res.body!, 2, 6000);
    assert.equal(events.length, 1, `heartbeat peek must surface the missed delivery exactly once, got: ${raw}`);
    assert.equal(events[0]!.data.seq, missed.seq);
    assert.doesNotMatch(raw, /fanned out on another replica/, "wake hints stay content-free");

    // Zero cursor movement: the rescue is delivery-side only.
    assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), base.seq);

    // Non-draining: the poll peek still sees it pending after the push.
    const poll = await fetch(`${app.baseUrl}/internal/agent-api/wake-hints`, {
      headers: { Authorization: `Bearer ${f.apiKey}` },
    });
    const pollBody = await poll.json() as { wake_hints?: Array<{ seq?: number }> };
    assert.equal(pollBody.wake_hints?.some((h) => h.seq === missed.seq), true, "heartbeat push must not drain");
  } finally {
    delete process.env.SLOCK_WAKE_STREAM_HEARTBEAT_MS;
    await app.close();
  }
});

// RisingWave trails Postgres by ~1s, so the pull a wake signal forces usually
// runs before the new message is in the chain. Follow-up pulls must surface it
// without waiting for the heartbeat.
test("a wake signal that outruns the inbox chain still reaches the stream through the follow-up pulls", async () => {
  process.env.SLOCK_WAKE_STREAM_HEARTBEAT_MS = "60000"; // park the heartbeat out of the test window
  __setExternalWakeFollowUpPullDelaysMsForTests([300, 800]);
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  let chainHasMessage = false;
  let readsWithoutMessage = 0;
  __setExternalAgentInboxChainSelectorForTests(async (agentId: string) => {
    if (!chainHasMessage) {
      readsWithoutMessage += 1;
      return { source: "chain", rows: [] };
    }
    return { source: "chain", rows: await referenceAgentInboxChain(agentId) };
  });
  try {
    const f = await seedExternalFixture();
    const orchestrator = new AgentOrchestrator() as any;
    app.app.set("agentOrchestrator", orchestrator);

    const res = await fetch(`${app.baseUrl}/internal/agent-api/wake-hints/stream`, {
      headers: { Authorization: `Bearer ${f.apiKey}` },
    });
    assert.equal(res.status, 200);
    const readsBeforeSignal = readsWithoutMessage;

    const reading = readWakeHintEvents(res.body!, 1, 3000);
    const message = await sendAndDeliver(orchestrator, f, "arrives before the chain has it");
    // Let the forced pull run against the lagging chain, then let it catch up.
    const deadline = Date.now() + 1000;
    while (readsWithoutMessage === readsBeforeSignal && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(readsWithoutMessage > readsBeforeSignal, "the signal's immediate pull ran before the chain had the message");
    chainHasMessage = true;

    const { events, raw } = await reading;
    assert.deepEqual(events.map((e) => e.id), [String(message.seq)], `follow-up pull must push the hint: ${raw}`);
  } finally {
    __setExternalWakeFollowUpPullDelaysMsForTests(null);
    __setExternalAgentInboxChainSelectorForTests(async (agentId: string) => ({ source: "chain", rows: await referenceAgentInboxChain(agentId) }));
    delete process.env.SLOCK_WAKE_STREAM_HEARTBEAT_MS;
    await app.close();
  }
});
