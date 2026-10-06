import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents, users } from "../db/schema";
import { AgentOrchestrator } from "./agentOrchestrator";
import { createAgent } from "./agentService";
import { registerMachine } from "./machineService";
import { createServer } from "./serverService";

afterEach(async () => {
  await closeTestDatabase();
});

// A freshly started Computer has no running/idle sessions at connect, so the
// daemon requests no app_config snapshot and system.cleaner never arms its
// per-owner schedule (no MEMORY.md or disk hints) until a later reconnect or
// config edit. Machine ready must push every agent's built-in app config.
test("machine connect pushes an app config snapshot for every agent on that machine", async ({ db }) => {
  const [user] = await getDb()
    .insert(users)
    .values({
      email: "app-config-snapshot-coverage@slock.test",
      name: "app-config-snapshot-coverage",
      passwordHash: "hash",
      emailVerified: true,
    })
    .returning();
  const server = await createServer(
    "App config snapshot coverage",
    "app-config-snapshot-coverage",
    user!.id,
  );
  const { machine } = await registerMachine(server.id, user!.id, "coverage-machine");
  const { machine: otherMachine } = await registerMachine(server.id, user!.id, "other-machine");

  const first = await createAgent(server.id, "sessionless-a", { machineId: machine.id });
  const second = await createAgent(server.id, "sessionless-b", { machineId: machine.id });
  await createAgent(server.id, "elsewhere", { machineId: otherMachine.id });
  const deleted = await createAgent(server.id, "deleted", { machineId: machine.id });
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, deleted.id));

  const orchestrator = new AgentOrchestrator();
  const deliveries: Array<{ machineId: string; message: any }> = [];
  (orchestrator as any).sendToMachine = async (machineId: string, message: any) => {
    deliveries.push({ machineId, message });
    return true;
  };

  await (orchestrator as any).pushAppConfigSnapshotsForMachine(machine.id);

  const snapshots = deliveries.filter(
    (delivery) => delivery.message?.type === "app_config.snapshot",
  );
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.message.agentId).sort(),
    [first.id, second.id].sort(),
    "every live agent on this machine, and only those",
  );
  for (const snapshot of snapshots) {
    assert.equal(snapshot.machineId, machine.id);
    const cleaner = snapshot.message.configs.filter(
      (config: { appId: string }) => config.appId === "system.cleaner",
    );
    assert.equal(cleaner.length, 1);
    assert.equal(cleaner[0].ownerAgentId, snapshot.message.agentId);
  }
});
