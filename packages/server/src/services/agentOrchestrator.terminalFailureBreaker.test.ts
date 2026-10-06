/**
 * RFC 071 part 3 (second slice): the terminal-failure breaker wired into the
 * REAL start path and wake entries. Real DB rows; the real
 * `handleMachineMessage` (app-inbox wake request, outbox frames, `ready`,
 * `agent:status`), `deliverMessageToAgent` (message wake) and `startAgent`
 * paths. Only the machine socket and the inbox-chain source are stubbed.
 *
 * Without Redis the orchestrator's #1119 store and the terminal store are the
 * process-local fallbacks that share one #1119 record, exactly as in a
 * single-replica deployment, so the combined claim is the production code.
 */
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";

import {
  DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1,
  type MachineToServerMessage,
  type ServerToMachineMessage,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agents, machines, serverMembers, servers, users } from "../db/schema";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import { localTerminalFailureBreakerStore } from "../terminalFailureBreakerRedisStore";
import { TerminalFailureBreaker, terminalStateFromStored, type TerminalFailureBreakerStore } from "../terminalFailureBreakerStore";
import type { TerminalFailureBreakerState } from "../terminalFailureBreaker";
import { AgentOrchestrator, TerminalBreakerStorageUnavailableError } from "./agentOrchestrator";
import * as channelService from "./channelService";
import { createMessage, deliverMessageToAgent } from "./messageService";

afterEach(async () => {
  await closeTestDatabase();
});

type StartMessage = Extract<ServerToMachineMessage, { type: "agent:start" }>;

class CapturingOrchestrator extends AgentOrchestrator {
  readonly sent: ServerToMachineMessage[] = [];
  /** When true, agent:start sends report "not sent" (machine offline). */
  failStartSend = false;

  get starts(): StartMessage[] {
    return this.sent.filter((m): m is StartMessage => m.type === "agent:start");
  }

  wakeOutcomes() {
    return this.sent.filter((m): m is Extract<ServerToMachineMessage, { type: "agent:wake:outcome" }> => m.type === "agent:wake:outcome");
  }

  acks() {
    return this.sent.filter((m) => m.type === "agent:outcome:ack");
  }

  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (msg.type === "agent:start" && this.failStartSend) return false;
    this.sent.push(msg);
    return true;
  }

  protected override async selectResumeInbox(agentId: string): Promise<channelService.AgentInboxChainSelection> {
    return { source: "chain", rows: await referenceAgentInboxChain(agentId) } as channelService.AgentInboxChainSelection;
  }
}

let seedCounter = 0;
async function seed() {
  const tag = `rfc071-${process.pid}-${seedCounter += 1}`;
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${tag}@example.com`,
    name: `Breaker Owner ${tag}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: "Breaker", slug: tag, ownerId: owner!.id }).returning();
  await db.insert(serverMembers).values({ serverId: server!.id, userId: owner!.id, role: "owner" });
  const [machine] = await db.insert(machines).values({
    serverId: server!.id,
    userId: owner!.id,
    name: "breaker-mac",
    apiKeyHash: `hash-${tag}`,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server!.id,
    name: "pi-agent",
    status: "inactive",
    runtime: "kimi-sdk",
    model: "devin/swe-2",
    executionMode: "byoc",
    machineId: machine!.id,
    sessionId: null,
  }).returning();
  return { owner: owner!, server: server!, machine: machine!, agent: agent! };
}

const D1 = "daemon-instance-1";
const D2 = "daemon-instance-2";

function bindMachine(
  orchestrator: AgentOrchestrator,
  machineId: string,
  serverId: string,
  options: { outcomes: boolean; daemonInstanceId?: string | null },
): void {
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
    capabilities: new Set<string>(options.outcomes ? [DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1] : []),
    runtimes: ["kimi-sdk"],
    runtimeVersions: {},
    migrationTransport: null,
    shutdownIntent: null,
    computerVersion: "1.0.40",
    daemonInstanceId: options.daemonInstanceId === undefined ? (options.outcomes ? D1 : null) : options.daemonInstanceId,
  });
}

/** The commit-1 switch is still off on this commit's base; the wiring tests run with acks on. */
function enableAcks(orchestrator: AgentOrchestrator): void {
  (orchestrator as any).runtimeOutcomeAckEnabled = true;
}

function terminalState(agentId: string): TerminalFailureBreakerState {
  return terminalStateFromStored(localTerminalFailureBreakerStore.getTerminalFailureBreakerStateSync(agentId), Date.now()).state;
}

let wakeCounter = 0;
function wakeRequest(agentId: string): Extract<MachineToServerMessage, { type: "agent:wake:request" }> {
  wakeCounter += 1;
  return {
    type: "agent:wake:request",
    agentId,
    wakeRequestId: wakeCounter.toString(16).padStart(32, "0"),
    reason: "app_inbox_notice",
    appId: "system.reminder",
    sourceRef: { kind: "reminder", id: "11111111-1111-4111-8111-111111111111", revision: String(wakeCounter) },
    pendingAppItems: 1,
  };
}

/** A daemon instance's outbox: frames with its own per-agent clientSeq. */
function daemonFrames(agentId: string, daemonInstanceId: string) {
  let seq = 0;
  const next = () => (seq += 1);
  return {
    spawned: (launchId: string, processInstanceId: string): MachineToServerMessage =>
      ({ type: "agent:process_spawned", agentId, daemonInstanceId, processInstanceId, launchId, clientSeq: next() }),
    e1: (launchId: string, fingerprint = "c4722931c8a1f172"): MachineToServerMessage => ({
      type: "agent:runtime:outcome",
      v: 1,
      agentId,
      launchId,
      sessionId: null,
      daemonInstanceId,
      clientSeq: next(),
      observedAtMs: Date.now(),
      outcome: { kind: "terminal_failure", failureKind: "compaction_failed", fingerprint, errorClass: "RuntimeError" },
    }),
    exited: (launchId: string, processInstanceId: string): MachineToServerMessage => ({
      type: "agent:process_exited", agentId, daemonInstanceId, processInstanceId, spawnLaunchId: launchId, launchId, clientSeq: next(), code: 1, signal: null,
    }),
  };
}

/** Drive one failing automatic launch through the real app-inbox wake entry and the outbox. */
async function failingWake(
  orchestrator: CapturingOrchestrator,
  machineId: string,
  agentId: string,
  frames: ReturnType<typeof daemonFrames>,
  pi: string,
): Promise<string> {
  const before = orchestrator.starts.length;
  await orchestrator.handleMachineMessage(machineId, wakeRequest(agentId));
  assert.equal(orchestrator.starts.length, before + 1, "the wake dispatched an agent:start");
  const launchId = orchestrator.starts.at(-1)!.launchId!;
  await orchestrator.handleMachineMessage(machineId, frames.spawned(launchId, pi));
  await orchestrator.handleMachineMessage(machineId, frames.e1(launchId));
  await orchestrator.handleMachineMessage(machineId, frames.exited(launchId, pi));
  return launchId;
}

test("negative control: a tripped breaker refuses the automatic wake through the real wake entries; a human start still starts", async ({ db: _db }) => {
  const { owner, server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const frames = daemonFrames(agent.id, D1);

    const first = await failingWake(orchestrator, machine.id, agent.id, frames, "pi-1");
    assert.equal(orchestrator.starts[0]!.breakerGeneration, terminalState(agent.id).currentLaunch!.generation, "the claimed start carries its generation");
    assert.equal(orchestrator.starts[0]!.humanStart, undefined, "an automatic start is not a human start");
    assert.equal(terminalState(agent.id).totalCount, 1);
    assert.equal(terminalState(agent.id).state, "closed");
    const second = await failingWake(orchestrator, machine.id, agent.id, frames, "pi-2");
    assert.notEqual(first, second);
    assert.equal(terminalState(agent.id).state, "open", "two failures with the same fingerprint open it");
    assert.equal(orchestrator.acks().length, 6, "every frame committed, then acked");
    // RFC 9: shown once as a typed offline activity: until when, why, what retries.
    const shown = (orchestrator as any).agentActivity.get(agent.id);
    assert.equal(shown.detailKind, "terminal_failure_paused");
    assert.equal(shown.activity, "offline");
    assert.match(shown.detail, /^Automatic wake paused until \d{4}-\d\d-\d\dT.*\(compaction_failed\)\. The next message, reminder or manual start after that retries; a manual start lifts it now\.$/);

    // App-inbox / reminder wake (the field loop): refused, no agent:start.
    const startsBefore = orchestrator.starts.length;
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    assert.equal(orchestrator.starts.length, startsBefore, "no agent:start while paused");
    assert.deepEqual(
      orchestrator.wakeOutcomes().at(-1),
      { type: "agent:wake:outcome", agentId: agent.id, wakeRequestId: wakeCounter.toString(16).padStart(32, "0"), outcome: "refused", reason: "terminal_failure_paused" },
    );

    // A human posts a message: the message wake is refused too, and the message stays unread.
    await orchestrator.handleMachineMessage(machine.id, { type: "agent:status", agentId: agent.id, status: "inactive", launchId: second });
    const dm = await channelService.findOrCreateDM(server.id, owner.id, agent.id);
    assert.ok(dm);
    const message = await createMessage(dm.id, "user", owner.id, "are you there?");
    const delivery = await deliverMessageToAgent(orchestrator, message.id, agent.id);
    assert.deepEqual(delivery, { status: "dropped", reason: "wake_suppressed" });
    assert.equal(orchestrator.starts.length, startsBefore, "no agent:start for the message either");
    assert.equal(await channelService.getAgentLegacyReadCursor(agent.id, dm.id), 0, "read cursor not advanced");
    assert.equal(terminalState(agent.id).catchupObligation?.owedCeilings[dm.id], message.seq, "the refused message is owed (RFC O-6)");

    // A person presses Start: the explicit human start (E3) is dispatched and lifts.
    const human = await orchestrator.startAgent(agent.id, { control: "human_start" });
    assert.equal(human.outcome, "dispatched");
    const start = orchestrator.starts.at(-1)!;
    assert.equal(start.humanStart, true);
    assert.equal(start.takeoverEpoch, 1);
    const lifted = terminalState(agent.id);
    assert.equal(lifted.state, "closed");
    assert.equal(lifted.totalCount, 0);
    assert.equal(lifted.currentLaunch!.launchId, start.launchId);
    assert.deepEqual(lifted.unexited.map((e) => [e.spawnLaunchId, e.processInstanceId]), [[start.launchId, null]], "written before dispatch");
  } finally {
    await orchestrator.shutdown();
  }
});

test("lost evidence: a critical gap marker makes automatic wakes need a person; a human start clears it", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const frames = daemonFrames(agent.id, D1);
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    const l1 = orchestrator.starts.at(-1)!.launchId!;
    await orchestrator.handleMachineMessage(machine.id, frames.spawned(l1, "pi-1"));
    await orchestrator.handleMachineMessage(machine.id, {
      type: "agent:runtime:outcome_gap", agentId: agent.id, daemonInstanceId: D1, gapId: "gap-1", fromSeq: 2, toSeq: 4,
      counts: { e1: 1, turnCompleted: 0, spawned: 0, exited: 1, startOutcome: 0 }, takeoverEpoch: 0,
    });
    assert.deepEqual(orchestrator.acks().at(-1), { type: "agent:outcome:ack", agentId: agent.id, gapId: "gap-1" });
    assert.equal(terminalState(agent.id).needsManual?.reason, "outcome_evidence_lost");

    const startsBefore = orchestrator.starts.length;
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    assert.equal(orchestrator.starts.length, startsBefore);
    assert.equal(orchestrator.wakeOutcomes().at(-1)!.reason, "terminal_failure_needs_manual");
    const shown = (orchestrator as any).agentActivity.get(agent.id);
    assert.equal(shown.detailKind, "terminal_failure_paused");
    assert.equal(shown.detail, "Automatic wake stopped: Runtime outcome reports for this agent were lost. A manual start is needed.");
    assert.doesNotMatch(shown.detail, /retr/i, "needs-manual never says it will retry");

    assert.equal((await orchestrator.startAgent(agent.id, { control: "human_start" })).outcome, "dispatched");
    const human = orchestrator.starts.at(-1)!;
    assert.equal(human.humanStart, true);
    assert.equal(human.takeoverEpoch, 1, "the daemon's marker of epoch 0 is covered by this takeover");
    assert.equal(terminalState(agent.id).needsManual, null);
    // The human launch's process is confirmed: the next automatic wake passes again.
    await orchestrator.handleMachineMessage(machine.id, frames.spawned(human.launchId!, "pi-2"));
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    assert.equal(orchestrator.wakeOutcomes().at(-1)!.outcome, "dispatched");
  } finally {
    await orchestrator.shutdown();
  }
});

test("daemon restart: an earlier instance's protected process blocks wakes until that instance's replayed exit arrives on the new connection", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true, daemonInstanceId: D1 });
    enableAcks(orchestrator);
    const old = daemonFrames(agent.id, D1);
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    const l1 = orchestrator.starts.at(-1)!.launchId!;
    await orchestrator.handleMachineMessage(machine.id, old.spawned(l1, "pi-1"));
    await orchestrator.handleMachineMessage(machine.id, old.e1(l1));
    assert.equal(terminalState(agent.id).totalCount, 1, "engaged: its process entry is protected");

    // The daemon restarts as D2 (its ready omits the agent). The D1 process was never seen to exit.
    await orchestrator.handleMachineMessage(machine.id, {
      type: "ready", daemonInstanceId: D2, capabilities: [DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1], runtimes: ["kimi-sdk"], runningAgents: [], daemonVersion: "1.0.40",
    });
    assert.equal((orchestrator as any).machineConnections.get(machine.id).daemonInstanceId, D2);
    assert.equal(terminalState(agent.id).needsManual?.reason, "daemon_restarted_no_exit");
    const startsBefore = orchestrator.starts.length;
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    assert.equal(orchestrator.starts.length, startsBefore);
    assert.equal(orchestrator.wakeOutcomes().at(-1)!.reason, "terminal_failure_needs_manual");

    // D2 replays D1's queued exit: applied by its D1 identity and acked; the block lifts.
    await orchestrator.handleMachineMessage(machine.id, old.exited(l1, "pi-1"));
    assert.deepEqual(orchestrator.acks().at(-1), { type: "agent:outcome:ack", agentId: agent.id, daemonInstanceId: D1, clientSeq: 3 });
    assert.equal(terminalState(agent.id).needsManual, null);
    assert.deepEqual(terminalState(agent.id).unexited, []);
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    assert.equal(orchestrator.wakeOutcomes().at(-1)!.outcome, "dispatched");
    assert.deepEqual(
      terminalState(agent.id).unexited.map((e) => e.daemonInstanceId),
      [D2],
      "the new start's pending entry is on the new instance",
    );
  } finally {
    await orchestrator.shutdown();
  }
});

test("a dispatch that never left the replica rolls the claim back (pending entry removed, guard restored); the next wake is not stuck", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    orchestrator.failStartSend = true;
    await assert.rejects(orchestrator.startAgent(agent.id), /Machine offline/);
    const rolled = terminalState(agent.id);
    assert.equal(rolled.currentLaunch, null, "the claim is undone");
    assert.deepEqual(rolled.unexited, [], "the start provably never left: no pending entry");
    assert.equal((orchestrator as any).agentStateCache.get(agent.id)?.expectedLaunchId ?? null, null, "guard restored");

    orchestrator.failStartSend = false;
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    assert.equal(orchestrator.wakeOutcomes().at(-1)!.outcome, "dispatched");
  } finally {
    await orchestrator.shutdown();
  }
});

test("storage unavailable: no start is dispatched, automatic or human; the wake entries report a failure, not a refusal", async ({ db: _db }) => {
  const { owner, server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const down: TerminalFailureBreakerStore = {
      getTerminalFailureBreakerState: async () => { throw new Error("redis unavailable"); },
      compareAndSetTerminalFailureBreakerState: async () => { throw new Error("redis unavailable"); },
      getWakeCrashLoopState: async () => { throw new Error("redis unavailable"); },
      compareAndSetTerminalAndWakeCrashLoop: async () => { throw new Error("redis unavailable"); },
    };
    (orchestrator as any).terminalFailureBreaker = new TerminalFailureBreaker(down);
    const errors = console.error;
    console.error = () => {};
    try {
      await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
      assert.equal(orchestrator.wakeOutcomes().at(-1)!.reason, "server_error");

      const dm = await channelService.findOrCreateDM(server.id, owner.id, agent.id);
      const message = await createMessage(dm!.id, "user", owner.id, "hello?");
      assert.deepEqual(await deliverMessageToAgent(orchestrator, message.id, agent.id), { status: "dropped", reason: "wake_failed" });

      await assert.rejects(orchestrator.startAgent(agent.id, { control: "human_start" }), TerminalBreakerStorageUnavailableError);
      // Same on a daemon without the capability: whether the record protects the agent cannot be read.
      bindMachine(orchestrator, machine.id, server.id, { outcomes: false });
      await assert.rejects(orchestrator.startAgent(agent.id, { control: "human_start" }), TerminalBreakerStorageUnavailableError);
    } finally {
      console.error = errors;
    }
    assert.equal(orchestrator.starts.length, 0, "nothing dispatched");
  } finally {
    await orchestrator.shutdown();
  }
});

test("dormant switch: with outcome acks off, a capable daemon starts exactly as before (no breaker write, no new start fields)", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    (orchestrator as any).runtimeOutcomeAckEnabled = false;
    for (let i = 0; i < 3; i += 1) {
      await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
      assert.equal(orchestrator.wakeOutcomes().at(-1)!.outcome, "dispatched", `wake ${i + 1}`);
    }
    assert.equal((await orchestrator.startAgent(agent.id, { control: "human_start" })).outcome, "dispatched");
    for (const start of orchestrator.starts) {
      assert.equal(start.breakerGeneration, undefined);
      assert.equal(start.humanStart, undefined);
    }
    assert.equal(localTerminalFailureBreakerStore.getRawForTest(agent.id), null);
  } finally {
    await orchestrator.shutdown();
  }
});

test("dormant switch: no path touches the terminal breaker store, so a store failure can never refuse a start", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  const touched: string[] = [];
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    (orchestrator as any).runtimeOutcomeAckEnabled = false;
    // Every breaker method fails like an unavailable store, and is recorded.
    (orchestrator as any).terminalFailureBreaker = new Proxy({}, {
      get: (_target, method) => (..._args: unknown[]) => {
        touched.push(String(method));
        return Promise.reject(new Error("terminal breaker store unavailable"));
      },
    });
    for (let i = 0; i < 2; i += 1) {
      await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
      assert.equal(orchestrator.wakeOutcomes().at(-1)!.outcome, "dispatched", `automatic wake ${i + 1}`);
    }
    assert.equal((await orchestrator.startAgent(agent.id, { control: "human_start" })).outcome, "dispatched");
    await orchestrator.liftWakeBlockForConfigChange(agent.id, { runtimeValuesChanged: true });
    await (orchestrator as any).liftTerminalBreaker(agent.id, "human_reset");
    await (orchestrator as any).observeTerminalDaemonReady(agent.id, "daemon-instance-x");
    await (orchestrator as any).projectTerminalBlock(agent.id, { includeNeedsManual: true });
    await orchestrator.stopAgent(agent.id, "manual");
    assert.deepEqual(touched, [], "dormant: the breaker store is never consulted or written");
  } finally {
    await orchestrator.shutdown();
  }
});

test("backward compatibility: a daemon without agent:runtime-outcome-v1 starts exactly as before (no breaker write, no new start fields)", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: false });
    enableAcks(orchestrator);
    for (let i = 0; i < 3; i += 1) {
      await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
      assert.equal(orchestrator.wakeOutcomes().at(-1)!.outcome, "dispatched", `wake ${i + 1}`);
      const launchId = orchestrator.starts.at(-1)!.launchId;
      // What such a daemon reports for a terminal failure: inactive without exit evidence.
      await orchestrator.handleMachineMessage(machine.id, { type: "agent:status", agentId: agent.id, status: "inactive", launchId });
    }
    assert.equal((await orchestrator.startAgent(agent.id, { control: "human_start" })).outcome, "dispatched");
    for (const start of orchestrator.starts) {
      assert.equal(start.breakerGeneration, undefined);
      assert.equal(start.takeoverEpoch, undefined);
      assert.equal(start.humanStart, undefined);
    }
    assert.equal(localTerminalFailureBreakerStore.getRawForTest(agent.id), null, "the breaker record was never written");
  } finally {
    await orchestrator.shutdown();
  }
});

test("an E3 human reset lifts an open breaker and its restart is a human start; a reset without E3 does not lift", async ({ db: _db }) => {
  for (const terminalControl of ["human_reset", undefined] as const) {
    const { server, machine, agent } = await seed();
    const orchestrator = new CapturingOrchestrator();
    try {
      bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
      enableAcks(orchestrator);
      const frames = daemonFrames(agent.id, D1);
      await failingWake(orchestrator, machine.id, agent.id, frames, "pi-1");
      const last = await failingWake(orchestrator, machine.id, agent.id, frames, "pi-2");
      assert.equal(terminalState(agent.id).state, "open");
      await orchestrator.handleMachineMessage(machine.id, { type: "agent:status", agentId: agent.id, status: "active", launchId: last });
      const startsBefore = orchestrator.starts.length;

      await orchestrator.resetAgent(agent.id, "session", terminalControl ? { terminalControl } : {});

      if (terminalControl) {
        assert.equal(terminalState(agent.id).state, "closed", "the reset lifted");
        assert.equal(orchestrator.starts.length, startsBefore + 1, "and restarted");
        assert.equal(orchestrator.starts.at(-1)!.humanStart, true);
      } else {
        assert.equal(terminalState(agent.id).state, "open", "a reset that is not E3 does not lift (RFC 5)");
        assert.equal(orchestrator.starts.length, startsBefore, "its restart is automatic and refused");
      }
    } finally {
      await orchestrator.shutdown();
    }
  }
});

test("an E3 reset that does not restart (stopped agent) still lifts: session reset drops the failing session (RFC 5, E-2)", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const frames = daemonFrames(agent.id, D1);
    await failingWake(orchestrator, machine.id, agent.id, frames, "pi-1");
    await failingWake(orchestrator, machine.id, agent.id, frames, "pi-2");
    await orchestrator.stopAgent(agent.id);
    assert.equal(terminalState(agent.id).state, "open", "a manual stop is not a lift");
    const generation = terminalState(agent.id).generation;
    const startsBefore = orchestrator.starts.length;

    await orchestrator.resetAgent(agent.id, "session", { terminalControl: "human_reset", restartIfStopped: false });

    assert.equal(orchestrator.starts.length, startsBefore, "no restart");
    const lifted = terminalState(agent.id);
    assert.equal(lifted.state, "closed");
    assert.equal(lifted.generation, generation + 1);
    assert.equal(lifted.currentLaunch, null);
  } finally {
    await orchestrator.shutdown();
  }
});

test("manual stop clears a probe in flight (half_open -> open, step unchanged); it is not a lift", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    enableAcks(orchestrator);
    const frames = daemonFrames(agent.id, D1);
    await failingWake(orchestrator, machine.id, agent.id, frames, "pi-1");
    await failingWake(orchestrator, machine.id, agent.id, frames, "pi-2");
    // Let the backoff pass: the next automatic wake claims the probe.
    const opened = terminalState(agent.id);
    assert.ok(await localTerminalFailureBreakerStore.compareAndSetTerminalFailureBreakerState(
      agent.id,
      localTerminalFailureBreakerStore.getRawForTest(agent.id)!.version,
      { ...opened, blockedUntilMs: Date.now() - 1 },
    ));
    await orchestrator.handleMachineMessage(machine.id, wakeRequest(agent.id));
    assert.equal(orchestrator.wakeOutcomes().at(-1)!.outcome, "dispatched");
    assert.equal(terminalState(agent.id).state, "half_open");
    const step = terminalState(agent.id).backoffStep;

    await orchestrator.stopAgent(agent.id);
    const stopped = terminalState(agent.id);
    assert.equal(stopped.state, "open");
    assert.equal(stopped.backoffStep, step);
    assert.equal(stopped.currentLaunch, null);
  } finally {
    await orchestrator.shutdown();
  }
});

test("runtime config change: the terminal breaker lifts only when a runtime value really changed (F3)", async ({ db: _db }) => {
  for (const runtimeValuesChanged of [false, true]) {
    const { server, machine, agent } = await seed();
    const orchestrator = new CapturingOrchestrator();
    try {
      bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
      enableAcks(orchestrator);
      const frames = daemonFrames(agent.id, D1);
      await failingWake(orchestrator, machine.id, agent.id, frames, "pi-1");
      await failingWake(orchestrator, machine.id, agent.id, frames, "pi-2");
      assert.equal(terminalState(agent.id).state, "open");
      await orchestrator.liftWakeBlockForConfigChange(agent.id, { runtimeValuesChanged });
      assert.equal(terminalState(agent.id).state, runtimeValuesChanged ? "closed" : "open");
    } finally {
      await orchestrator.shutdown();
    }
  }
});

test("H-13: a failed start's guard rollback restores only its own guard (compare-and-restore)", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, { outcomes: true });
    const internals = orchestrator as any;
    await orchestrator.startAgent(agent.id, { control: "human_start" });
    const winner = internals.agentStateCache.get(agent.id).expectedLaunchId as string;
    // A loser that snapshotted before the winner armed rolls back with its own launchId: no-op.
    internals.rollbackStartLaunchGuard(agent.id, { expectedLaunchId: "stale", launchGuardMode: "guarded" }, "loser-launch");
    assert.equal(internals.agentStateCache.get(agent.id).expectedLaunchId, winner, "the winner's guard survives");
    // The owner's own rollback restores.
    internals.rollbackStartLaunchGuard(agent.id, { expectedLaunchId: "previous", launchGuardMode: "guarded" }, winner);
    assert.equal(internals.agentStateCache.get(agent.id).expectedLaunchId, "previous");
  } finally {
    await orchestrator.shutdown();
  }
});
