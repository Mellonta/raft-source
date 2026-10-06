import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";

import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { users } from "../db/schema";
import { machineConnectionsRefusedTotal } from "../metrics";
import { AgentOrchestrator } from "./agentOrchestrator";
import { MACHINE_DRAIN_CLOSE_CODE, MACHINE_DRAIN_CLOSE_REASON } from "./machineDrain";
import { registerMachine } from "./machineService";
import type { ReplicaStateStore } from "./replicaStateStore";
import { createServer } from "./serverService";

// Wiring test for task #268 follow-up ①: the drain going-away closes a
// snapshot of the connections it finds. A daemon that reconnects to this
// same task in the seconds before the ALB deregisters it is not in that
// snapshot and would be hard-cut with 1006 at the deregistration-delay
// expiry. A draining task must therefore refuse new machine connections with
// the same 1001 `server_draining` so the daemon's reconnect lands elsewhere.

afterEach(async () => {
  await closeTestDatabase();
});

async function drainingRefusals(): Promise<number> {
  const metric = await machineConnectionsRefusedTotal.get();
  return metric.values.find((value) => value.labels.reason === "draining")?.value ?? 0;
}

function makeFakeMachineWs() {
  const closes: Array<{ code?: number; reason?: string }> = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: () => {},
    close(code?: number, reason?: string) {
      closes.push({ code, reason });
      this.readyState = 3;
    },
    terminate() {
      this.readyState = 3;
    },
  };
  return { ws, closes };
}

function makeReplicaStateStore(): ReplicaStateStore {
  let statusVersion = 0;
  return {
    isAvailable: () => true,
    registerMachineReplica: async () => "test-generation",
    restoreMachineReplicaGeneration: async () => {},
    unregisterMachineReplica: async () => {},
    refreshMachineReplica: async () => {},
    hasMachineReplica: async () => true,
    getMachineReplicaOwner: async () => "test-replica",
    bumpMachineStatusVersion: async () => {
      statusVersion += 1;
      return statusVersion;
    },
    getMachineStatusVersion: async () => statusVersion,
    acquireWakeLock: async () => true,
    releaseWakeLock: async () => {},
    setAgentActivity: async () => {},
    getAgentActivity: async () => null,
    getWakeCrashLoopState: async () => null,
    compareAndSetWakeCrashLoopState: async () => true,
    setAgentRuntimeError: async () => {},
    getAgentRuntimeError: async () => null,
    setMachineMeta: async () => {},
    getMachineMeta: async () => null,
    clearMachineMeta: async () => {},
  };
}

async function seedServerWithMachines(count: number) {
  const [user] = await getDb()
    .insert(users)
    .values({
      email: "drain-refuse@slock.test",
      name: "drain-refuse",
      passwordHash: "hash",
      emailVerified: true,
    })
    .returning();
  const server = await createServer("Drain refuse", "drain-refuse", user!.id);
  const machineIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const { machine } = await registerMachine(server.id, user!.id, `drain-machine-${i}`);
    machineIds.push(machine.id);
  }
  return { server, machineIds };
}

test("a machine connection that arrives after the drain started is closed with 1001 server_draining and never registered", async ({ db: _db }) => {
  const { server, machineIds } = await seedServerWithMachines(2);
  const sink = new MemoryTraceSink();
  const orchestrator = new AgentOrchestrator(makeReplicaStateStore(), undefined, new BasicTracer({ sink }));
  const refusalsBefore = await drainingRefusals();

  // Before the drain: a connection registers normally.
  const early = makeFakeMachineWs();
  await orchestrator.registerMachine(machineIds[0]!, server.id, early.ws as never);
  assert.ok(orchestrator.getMachineConnectionEpoch(machineIds[0]!), "pre-drain connection is registered");
  assert.equal(orchestrator.isDrainingMachineConnections, false);

  // Drain starts: the snapshot (one connection) gets its 1001 …
  const result = await orchestrator.closeMachineConnectionsForDrain({ spreadMs: 0 });
  assert.equal(result.closed, 1);
  assert.deepEqual(early.closes, [{ code: MACHINE_DRAIN_CLOSE_CODE, reason: MACHINE_DRAIN_CLOSE_REASON }]);
  assert.equal(orchestrator.isDrainingMachineConnections, true);

  // … and a daemon that reconnects to THIS task afterwards (ALB still routing
  // here for a few seconds) is refused with the same 1001, immediately, and
  // is not registered as owned by this replica.
  const late = makeFakeMachineWs();
  await orchestrator.registerMachine(machineIds[1]!, server.id, late.ws as never);
  assert.deepEqual(late.closes, [{ code: MACHINE_DRAIN_CLOSE_CODE, reason: MACHINE_DRAIN_CLOSE_REASON }]);
  assert.equal(orchestrator.getMachineConnectionEpoch(machineIds[1]!), null, "late connection is not registered");
  assert.equal(orchestrator.drainRefusedMachineConnectionCount, 1);

  // The real socket's close event runs the normal disconnect bookkeeping.
  await orchestrator.handleMachineDisconnect(machineIds[0]!, early.ws as never, {
    cause: "socket_close",
    closeCode: MACHINE_DRAIN_CLOSE_CODE,
    closeReason: MACHINE_DRAIN_CLOSE_REASON,
  });
  assert.equal(orchestrator.getMachineConnectionEpoch(machineIds[0]!), null);

  // Same machine reconnecting again (its snapshot 1001 bounced it back here).
  const again = makeFakeMachineWs();
  await orchestrator.registerMachine(machineIds[0]!, server.id, again.ws as never);
  assert.deepEqual(again.closes, [{ code: MACHINE_DRAIN_CLOSE_CODE, reason: MACHINE_DRAIN_CLOSE_REASON }]);
  assert.equal(orchestrator.getMachineConnectionEpoch(machineIds[0]!), null, "reconnect-back is not registered");
  assert.equal(orchestrator.drainRefusedMachineConnectionCount, 2);
  // The Prometheus counter moves with every refusal (SLO v1 post-deploy readout).
  assert.equal((await drainingRefusals()) - refusalsBefore, 2);

  // The refusal is observable: one event per refusal, with the running total.
  const events = sink.getAllLogEvents().filter((event) => event.name === "server.machine.connection.refused_while_draining");
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => event.attrs?.drain_refused_total),
    [1, 2],
  );
});

test("a socket that is no longer open when refused is still counted and never registered", async ({ db: _db }) => {
  const { server, machineIds } = await seedServerWithMachines(1);
  const orchestrator = new AgentOrchestrator(makeReplicaStateStore(), undefined, new BasicTracer({ sink: new MemoryTraceSink() }));
  await orchestrator.closeMachineConnectionsForDrain({ spreadMs: 0 });

  const closing = makeFakeMachineWs();
  closing.ws.readyState = 2;
  await orchestrator.registerMachine(machineIds[0]!, server.id, closing.ws as never);
  assert.deepEqual(closing.closes, [], "no close frame on a socket that is not OPEN");
  assert.equal(orchestrator.getMachineConnectionEpoch(machineIds[0]!), null);
  assert.equal(orchestrator.drainRefusedMachineConnectionCount, 1);
});
