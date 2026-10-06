/**
 * RFC 070 constructed wake context is gated per server by the
 * `constructed_wake_context` feature flag: the agent:start config carries
 * `constructedWakeContext: true` only when the flag evaluates on for the
 * agent's server, and a missing or off flag leaves the field out (the daemon
 * treats absent as off). Real DB rows and the real flag evaluation; only the
 * machine socket is stubbed.
 */
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";

import type { ServerToMachineMessage } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agents, machines, serverMembers, servers, users } from "../db/schema";
import { AgentOrchestrator } from "./agentOrchestrator";
import { CONSTRUCTED_WAKE_CONTEXT_FEATURE_FLAG_KEY, createFeatureFlag, PASSIVE_AX_FEATURE_FLAG_KEY, SUBAGENT_DELEGATION_FEATURE_FLAG_KEY } from "./featureFlagService";

afterEach(async () => {
  await closeTestDatabase();
});

class CapturingOrchestrator extends AgentOrchestrator {
  readonly starts: Array<Extract<ServerToMachineMessage, { type: "agent:start" }>> = [];

  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (msg.type === "agent:start") this.starts.push(msg);
    return true;
  }
}

async function seed(slug: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${slug}@example.com`,
    name: "Wake Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: "Wake", slug, ownerId: owner!.id }).returning();
  await db.insert(serverMembers).values({ serverId: server!.id, userId: owner!.id, role: "owner" });
  const [machine] = await db.insert(machines).values({
    serverId: server!.id,
    userId: owner!.id,
    name: "wake-mac",
    apiKeyHash: `hash-${slug}`,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server!.id,
    name: "wake-agent",
    status: "inactive",
    runtime: "claude",
    model: "sonnet",
    executionMode: "byoc",
    machineId: machine!.id,
  }).returning();
  return { server: server!, machine: machine!, agent: agent! };
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
    runtimes: ["claude"],
    migrationTransport: null,
    shutdownIntent: null,
    computerVersion: "1.0.40",
  });
}

async function startConfig(slug: string) {
  const { server, machine, agent } = await seed(slug);
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id);
    assert.equal((await orchestrator.startAgent(agent.id)).outcome, "dispatched");
    assert.equal(orchestrator.starts.length, 1);
    return orchestrator.starts[0]!.config;
  } finally {
    await orchestrator.shutdown();
  }
}

test("constructed wake context: no flag means the start config leaves it off", async ({ db: _db }) => {
  const config = await startConfig("cwc-missing");
  assert.equal(config.constructedWakeContext, undefined);
});

test("constructed wake context: a flag that evaluates off leaves it off", async ({ db: _db }) => {
  await createFeatureFlag({ key: CONSTRUCTED_WAKE_CONTEXT_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  const config = await startConfig("cwc-off");
  assert.equal(config.constructedWakeContext, undefined);
});

test("constructed wake context: a flag that evaluates on for the server turns it on", async ({ db: _db }) => {
  await createFeatureFlag({ key: CONSTRUCTED_WAKE_CONTEXT_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  const config = await startConfig("cwc-on");
  assert.equal(config.constructedWakeContext, true);
});

// The sub-agent delegation prompt rides the same per-server, default-off path.
test("sub-agent delegation: no flag means the start config leaves it off", async ({ db: _db }) => {
  const config = await startConfig("sad-missing");
  assert.equal(config.subagentDelegation, undefined);
});

test("sub-agent delegation: a flag that evaluates off leaves it off", async ({ db: _db }) => {
  await createFeatureFlag({ key: SUBAGENT_DELEGATION_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  const config = await startConfig("sad-off");
  assert.equal(config.subagentDelegation, undefined);
});

test("sub-agent delegation: a flag that evaluates on for the server turns it on, independently of wake context", async ({ db: _db }) => {
  await createFeatureFlag({ key: SUBAGENT_DELEGATION_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  const config = await startConfig("sad-on");
  assert.equal(config.subagentDelegation, true);
  assert.equal(config.constructedWakeContext, undefined);
});


// task #359: the RFC 072 passive AX gate rides the same per-server, default-off path.
test("passive AX: no flag means the start config leaves it off", async ({ db: _db }) => {
  const config = await startConfig("pax-missing");
  assert.equal(config.passiveAx, undefined);
});

test("passive AX: a flag that evaluates off leaves it off", async ({ db: _db }) => {
  await createFeatureFlag({ key: PASSIVE_AX_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  const config = await startConfig("pax-off");
  assert.equal(config.passiveAx, undefined);
});

test("passive AX: a flag that evaluates on for the server turns it on, independently of the other gates", async ({ db: _db }) => {
  await createFeatureFlag({ key: PASSIVE_AX_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  const config = await startConfig("pax-on");
  assert.equal(config.passiveAx, true);
  assert.equal(config.constructedWakeContext, undefined);
  assert.equal(config.subagentDelegation, undefined);
});
