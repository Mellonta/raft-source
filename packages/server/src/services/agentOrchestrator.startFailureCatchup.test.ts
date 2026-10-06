/**
 * task #1221 — a chat message that arrives while automatic wakes are blocked by
 * a non-retryable start failure is neither consumed nor acknowledged, and the
 * start that follows the block carries it (by the same message id), with or
 * without a session. Real DB rows, the real deliverMessage/startAgent paths;
 * only the machine socket and the inbox-chain source (RisingWave) are stubbed.
 *
 * task #358 (at the end): the same real path, used as the control that a
 * readable inbox with nothing unread still sends no resume prompt.
 */
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";

import type { ServerToMachineMessage } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agents, machines, serverMembers, servers, users } from "../db/schema";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import { AgentOrchestrator } from "./agentOrchestrator";
import * as channelService from "./channelService";
import * as messageService from "./messageService";
import { createMessage, deliverMessageToAgent } from "./messageService";

afterEach(async () => {
  await closeTestDatabase();
});

class CapturingOrchestrator extends AgentOrchestrator {
  readonly starts: Array<Extract<ServerToMachineMessage, { type: "agent:start" }>> = [];
  /** When set, the next resume-inbox read throws (the catch-up query fails). */
  failNextInboxRead = false;

  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (msg.type === "agent:start") this.starts.push(msg);
    return true;
  }

  // The durable inbox chain comes from RisingWave in production; read the
  // reference implementation over the same Postgres rows instead.
  protected override async selectResumeInbox(agentId: string): Promise<channelService.AgentInboxChainSelection> {
    if (this.failNextInboxRead) {
      this.failNextInboxRead = false;
      throw new Error("inbox chain query failed");
    }
    return { source: "chain", rows: await referenceAgentInboxChain(agentId) } as channelService.AgentInboxChainSelection;
  }
}

async function seed(sessionId: string | null) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `catchup-${sessionId ?? "fresh"}@example.com`,
    name: "Catchup Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Catchup",
    slug: `catchup-${sessionId ?? "fresh"}`,
    ownerId: owner!.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server!.id, userId: owner!.id, role: "owner" });
  const [machine] = await db.insert(machines).values({
    serverId: server!.id,
    userId: owner!.id,
    name: "catchup-mac",
    apiKeyHash: `hash-${sessionId ?? "fresh"}`,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server!.id,
    name: "mahua",
    status: "inactive",
    runtime: "kimi-sdk",
    model: "devin/swe-2",
    executionMode: "byoc",
    machineId: machine!.id,
    sessionId,
  }).returning();
  return { owner: owner!, server: server!, machine: machine!, agent: agent! };
}

function bindMachine(orchestrator: AgentOrchestrator, machineId: string, serverId: string): void {
  (orchestrator as any).machineConnections.set(machineId, {
    ws: {},
    machineId,
    serverId,
    principalKind: "computer",
    connectionEpochId: `epoch-${machineId}`,
    heartbeatTimer: null,
    runtimeAccountUsageTimer: null,
    lastPong: Date.now(),
    lastIngressAt: Date.now(),
    daemonVersion: "1.0.40",
    capabilities: new Set<string>(),
    runtimes: ["kimi-sdk"],
    migrationTransport: null,
    shutdownIntent: null,
    computerVersion: "1.0.40",
  });
}

for (const sessionId of ["kimi-session-1", null] as const) {
  test(`task #1221: a message sent while starts are blocked is kept and carried by the next start (${sessionId ? "with" : "without"} a session)`, async ({ db: _db }) => {
    const { owner, server, machine, agent } = await seed(sessionId);
    const orchestrator = new CapturingOrchestrator();
    try {
      bindMachine(orchestrator, machine.id, server.id);
      const breaker = (orchestrator as any).wakeCrashLoopBreaker;
      // The model is not configured on the computer: the current start fails
      // non-retryably and automatic wakes stop.
      await breaker.recordStart(agent.id, "launch-1", Date.now());
      assert.equal(
        await breaker.recordNonRetryableStartFailure(agent.id, { launchId: "launch-1", reason: "model_not_configured", nowMs: Date.now() }),
        true,
      );

      const dm = await channelService.findOrCreateDM(server.id, owner.id, agent.id);
      assert.ok(dm);
      const message = await createMessage(dm.id, "user", owner.id, "are you there?");

      // While blocked: the wake is refused and nothing consumes or acknowledges the message.
      const delivery = await deliverMessageToAgent(orchestrator, message.id, agent.id);
      assert.deepEqual(delivery, { status: "dropped", reason: "wake_suppressed" });
      assert.equal(orchestrator.starts.length, 0, "no start while blocked");
      assert.equal(await channelService.getAgentLegacyReadCursor(agent.id, dm.id), 0, "read cursor not advanced");
      assert.deepEqual(await orchestrator.receiveMessages(agent.id, false, 0), [], "not buffered as delivered");

      // A person restarts the agent (after fixing the model): the start carries the same message.
      const started = await orchestrator.startAgent(agent.id);
      assert.equal(started.outcome, "dispatched");
      assert.equal(orchestrator.starts.length, 1);
      const start = orchestrator.starts[0]!;
      const carried = [
        ...(start.wakeMessage ? [start.wakeMessage] : []),
        ...(start.resumeMessages ?? []),
      ].map((m) => m.message_id);
      assert.ok(carried.includes(message.id), `start carries message ${message.id}; got ${JSON.stringify(carried)}`);

      // Owed until the start that carried it reports its runtime active (the
      // agent:status wiring is covered in the deterministic orchestrator tests).
      assert.equal(await breaker.isCatchupOwed(agent.id), true, "not cleared by dispatch alone");
      assert.equal(await breaker.confirmCatchupDelivered(agent.id, start.launchId!), true);
      assert.equal(await breaker.isCatchupOwed(agent.id), false, "cleared once the carrying runtime is active");
    } finally {
      await orchestrator.shutdown();
    }
  });
}


/** Shared setup for the branch tests below: blocked agent (no session) with one owed message. */
async function blockedWithOwedMessage() {
  const { owner, server, machine, agent } = await seed(null);
  const orchestrator = new CapturingOrchestrator();
  bindMachine(orchestrator, machine.id, server.id);
  const breaker = (orchestrator as any).wakeCrashLoopBreaker;
  await breaker.recordStart(agent.id, "launch-1", Date.now());
  await breaker.recordNonRetryableStartFailure(agent.id, { launchId: "launch-1", reason: "model_not_configured", nowMs: Date.now() });
  const dm = await channelService.findOrCreateDM(server.id, owner.id, agent.id);
  assert.ok(dm);
  const owed = await createMessage(dm.id, "user", owner.id, "owed while blocked");
  assert.deepEqual(await deliverMessageToAgent(orchestrator, owed.id, agent.id), { status: "dropped", reason: "wake_suppressed" });
  return { owner, server, machine, agent, orchestrator, breaker, dm: dm!, owed };
}

const carriedIds = (start: Extract<ServerToMachineMessage, { type: "agent:start" }>) => [
  ...(start.wakeMessage ? [start.wakeMessage] : []),
  ...(start.resumeMessages ?? []),
].map((m) => m.message_id);

test("task #1221: a failed catch-up query leaves the catch-up owed, and the retry carries the same message", async ({ db: _db }) => {
  const { agent, orchestrator, breaker, owed } = await blockedWithOwedMessage();
  try {
    orchestrator.failNextInboxRead = true;
    assert.equal((await orchestrator.startAgent(agent.id)).outcome, "dispatched");
    assert.equal(carriedIds(orchestrator.starts[0]!).includes(owed.id), false, "the failed query carried nothing");
    assert.equal(await breaker.isCatchupOwed(agent.id), true, "still owed");
    // The start's runtime even comes up: it did not carry the catch-up, so nothing is cleared.
    assert.equal(await breaker.confirmCatchupDelivered(agent.id, orchestrator.starts[0]!.launchId!), false);
    assert.equal(await breaker.isCatchupOwed(agent.id), true);
    assert.equal((await orchestrator.startAgent(agent.id)).outcome, "dispatched");
    assert.ok(carriedIds(orchestrator.starts.at(-1)!).includes(owed.id), "the retry carries the owed message id");
  } finally {
    await orchestrator.shutdown();
  }
});

test("task #1221: a wake message left out of the bounded catch-up is appended, never dropped", async ({ db: _db }) => {
  const { owner, agent, orchestrator, breaker, dm, owed } = await blockedWithOwedMessage();
  try {
    await breaker.liftForConfigChange(agent.id);
    const wake = await createMessage(dm.id, "user", owner.id, "the message that wakes it");
    // The bounded catch-up returns only the older owed message.
    const real = messageService.getAgentResumeCatchupMessages;
    const spy = vi.spyOn(messageService, "getAgentResumeCatchupMessages").mockImplementationOnce(async (...args) => {
      const result = await real(...args);
      return { ...result, messages: result.messages.filter((m) => m.message_id !== wake.id) };
    });
    await deliverMessageToAgent(orchestrator, wake.id, agent.id);
    spy.mockRestore();
    const start = orchestrator.starts.at(-1)!;
    assert.equal(start.wakeMessage, undefined, "the daemon would ignore resumeMessages next to a wake message");
    assert.deepEqual(new Set(carriedIds(start)), new Set([owed.id, wake.id]));
  } finally {
    await orchestrator.shutdown();
  }
});

test("task #1221: if the carrying start's runtime fails, the next start carries the same message again", async ({ db: _db }) => {
  const { agent, orchestrator, breaker, owed } = await blockedWithOwedMessage();
  try {
    assert.equal((await orchestrator.startAgent(agent.id)).outcome, "dispatched");
    const first = orchestrator.starts.at(-1)!;
    assert.ok(carriedIds(first).includes(owed.id));
    // The runtime fails to come up (a retryable failure): no active report, so it stays owed.
    assert.equal(await breaker.isCatchupOwed(agent.id), true);
    assert.equal((await orchestrator.startAgent(agent.id)).outcome, "dispatched");
    assert.ok(carriedIds(orchestrator.starts.at(-1)!).includes(owed.id), "same message id carried again");
  } finally {
    await orchestrator.shutdown();
  }
});


test("task #1221: blocked message -> manual stop -> start again carries the same message (no session)", async ({ db: _db }) => {
  const { agent, orchestrator, breaker, owed } = await blockedWithOwedMessage();
  try {
    await orchestrator.stopAgent(agent.id);
    assert.equal(await breaker.isCatchupOwed(agent.id), true, "stopping does not deliver it");
    assert.equal((await orchestrator.startAgent(agent.id)).outcome, "dispatched");
    assert.ok(carriedIds(orchestrator.starts.at(-1)!).includes(owed.id), "the start after the stop carries the same message id");
  } finally {
    await orchestrator.shutdown();
  }
});

test("task #358: a readable inbox with nothing unread sends no resume prompt (the daemon's empty resume stays)", async ({ db: _db }) => {
  const { server, machine, agent } = await seed("kimi-session-358");
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id);
    assert.equal((await orchestrator.startAgent(agent.id)).outcome, "dispatched");
    const start = orchestrator.starts[0]!;
    assert.equal(start.resumePrompt, undefined, "nothing unread is a verified empty, not an unverified one");
    assert.equal(start.unreadSummary, undefined);
  } finally {
    await orchestrator.shutdown();
  }
});
