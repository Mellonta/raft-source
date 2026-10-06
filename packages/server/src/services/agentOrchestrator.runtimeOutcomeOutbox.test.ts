import assert from "node:assert/strict";
import type { MachineToServerMessage, ServerToMachineMessage } from "@botiverse/raft-shared";
import { RUNTIME_OUTCOME_OUTBOX_MESSAGE_TYPES } from "../runtimeOutcomeOutboxIngest";
import { terminalOutboxWatermark } from "../terminalFailureBreaker";
import { InMemoryTerminalFailureBreakerStore, TerminalFailureBreaker, terminalStateFromStored } from "../terminalFailureBreakerStore";
import { AgentOrchestrator } from "./agentOrchestrator";

// RFC 071 part 3, first slice: the orchestrator routes outbox frames to the
// commit-then-ack ingest only behind the switch, and never rate-limit-drops
// an outbox entry.

const MACHINE = "machine-outbox";
const SERVER = "server-outbox";
const AGENT = "agent-outbox";
const D1 = "daemon-1";

function makeOrchestrator(options: { enabled: boolean }) {
  const orchestrator = new AgentOrchestrator();
  const sent: ServerToMachineMessage[] = [];
  const store = new InMemoryTerminalFailureBreakerStore();
  const internals = orchestrator as unknown as Record<string, unknown> & { machineConnections: Map<string, unknown> };
  internals.machineConnections.set(MACHINE, {
    ws: {},
    machineId: MACHINE,
    serverId: SERVER,
    principalKind: "computer",
    connectionEpochId: "outbox-connection",
    heartbeatTimer: null,
    runtimeAccountUsageTimer: null,
    lastPong: Date.now(),
    lastIngressAt: Date.now(),
    daemonVersion: "1.0.0",
    capabilities: new Set<string>(),
    runtimes: [],
    migrationTransport: null,
    shutdownIntent: null,
    computerVersion: null,
    daemonInstanceId: D1,
  });
  internals.validateMachineAgentMessage = async () => ({ id: AGENT, serverId: SERVER, machineId: MACHINE, sessionId: null });
  internals.sendToMachine = async (_machineId: string, message: ServerToMachineMessage) => {
    sent.push(message);
    return true;
  };
  internals.terminalFailureBreaker = new TerminalFailureBreaker(store);
  internals.runtimeOutcomeAckEnabled = options.enabled;
  return { orchestrator, sent, store, internals };
}

const spawned = (clientSeq: number): MachineToServerMessage => ({
  type: "agent:process_spawned",
  agentId: AGENT,
  daemonInstanceId: D1,
  processInstanceId: "pi-1",
  launchId: "L-none",
  clientSeq,
});

test("dormant by default: an outbox frame is neither committed nor acked", async () => {
  const orchestrator = new AgentOrchestrator();
  assert.equal((orchestrator as unknown as { runtimeOutcomeAckEnabled: boolean }).runtimeOutcomeAckEnabled, false);
  const { orchestrator: dormant, sent, store } = makeOrchestrator({ enabled: false });
  await dormant.handleMachineMessage(MACHINE, spawned(1));
  assert.deepEqual(sent, []);
  assert.equal(store.getRawForTest(AGENT), null);
});

test("switched on: the frame is committed through the breaker, then acked to the machine", async () => {
  const { orchestrator, sent, store } = makeOrchestrator({ enabled: true });
  await orchestrator.handleMachineMessage(MACHINE, spawned(4));
  assert.deepEqual(sent, [{ type: "agent:outcome:ack", agentId: AGENT, daemonInstanceId: D1, clientSeq: 4 }]);
  assert.equal(terminalOutboxWatermark(terminalStateFromStored(store.getTerminalFailureBreakerStateSync(AGENT), 0).state, D1), 4);
});

test("switched on: a failed commit sends no ack", async () => {
  const { orchestrator, sent, internals } = makeOrchestrator({ enabled: true });
  internals.terminalFailureBreaker = { applyOutboxFrame: async () => { throw new Error("redis unavailable"); } };
  const warn = console.warn;
  console.warn = () => {};
  try {
    await orchestrator.handleMachineMessage(MACHINE, spawned(4));
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(sent, []);
});

test("switched on: a frame for an agent this machine does not own is neither committed nor acked", async () => {
  const { orchestrator, sent, store, internals } = makeOrchestrator({ enabled: true });
  internals.validateMachineAgentMessage = async () => null;
  await orchestrator.handleMachineMessage(MACHINE, spawned(4));
  assert.deepEqual(sent, []);
  assert.equal(store.getRawForTest(AGENT), null);
});

test("ingress rate limit: outbox entries are never dropped; the best-effort unreliable notice is limited", () => {
  const { internals } = makeOrchestrator({ enabled: true });
  internals.daemonIngressRateLimitMaxEvents = 1;
  internals.daemonIngressRateLimitMaxEventsPerMachine = 1;
  const plan = internals.planDaemonIngressRateLimit as (machineId: string, type: MachineToServerMessage["type"]) => { action: string };
  for (const type of RUNTIME_OUTCOME_OUTBOX_MESSAGE_TYPES) {
    for (let i = 0; i < 5; i += 1) assert.equal(plan.call(internals, MACHINE, type).action, "allow", `${type} #${i}`);
  }
  const unreliable = [0, 1, 2].map(() => plan.call(internals, "machine-other", "agent:runtime:outcome_unreliable").action);
  assert.deepEqual(unreliable, ["allow", "drop", "drop"]);
});
