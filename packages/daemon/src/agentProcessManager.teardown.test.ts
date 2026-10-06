import assert from "node:assert/strict";
import { test } from "vitest";
import { drainAgentManagerForTests } from "./testing/agentManagerTeardown";

test("test teardown fails loudly, naming the member, when a private member it relies on is renamed", async () => {
  const renamed = {
    coldIdleSweepTimer: null,
    agentStartQueue: {},
    capabilityHolds: new Map(),
    lifecycleRecords: { clearRestartSnapshots() {} },
    runtimeErrorProcessRestartTimers: new Map(),
    startAgentNow: async () => {},
    ensureManagedRunnerCredential: async () => {},
  };
  await assert.rejects(
    drainAgentManagerForTests(renamed),
    /AgentProcessManager has no object `agentStarts`; update the teardown/,
  );
});
