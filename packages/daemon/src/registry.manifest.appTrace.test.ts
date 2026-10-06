import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { noopTracer } from "@botiverse/raft-shared";
import { CLEANER_CONFIG_DEFAULTS } from "@botiverse/raft-shared/src/apps/cleaner/configProtocol";

import { createAgentAppInboxStore } from "./agentAppInbox";
import { createBuiltInLocalScheduleRuntime } from "./registry.manifest";
import { createScopedAppStorageFactory } from "./scopedAppStorage";

const cleanerClock = {
  now: () => 0,
  schedule: () => 1,
  cancel: () => {},
};

test("daemon config receiver emits truthful stale, invalid, and empty-removal terminals", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "app-config-trace-"));
  const traces: Array<{
    name: string;
    attrs: Record<string, unknown>;
    status?: "ok" | "error";
  }> = [];
  const runtime = createBuiltInLocalScheduleRuntime({
    agentsDataDir: root,
    cleanerClock,
    getInbox: () => createAgentAppInboxStore(),
    notifyInbox: async () => false,
    send: () => {},
    tracer: noopTracer,
    trace: (name, attrs, status) =>
      traces.push({ name, attrs: { ...attrs }, status }),
  });
  const storageFactory = createScopedAppStorageFactory({
    slockHome: root,
    owner: { machineId: "machine-test", serverId: "server-test" },
  });
  runtime.bindScopedStorage(storageFactory);
  const wire = (revision: number) => ({
    appId: "system.cleaner" as const,
    ownerAgentId: "agent-a",
    revision,
    effective: { ...CLEANER_CONFIG_DEFAULTS },
  });

  try {
    assert.equal(runtime.handleServerMessage({
      type: "app_config.upsert",
      agentId: "agent-a",
      config: wire(2),
    }), true);
    assert.equal(runtime.handleServerMessage({
      type: "app_config.upsert",
      agentId: "agent-a",
      config: wire(1),
    }), true);
    assert.equal(runtime.handleServerMessage({
      type: "app_config.upsert",
      agentId: "agent-a",
      config: {
        ...wire(3),
        effective: { ...CLEANER_CONFIG_DEFAULTS, forbidden: 1 },
      },
    }), true);
    assert.equal(runtime.handleServerMessage({
      type: "app_config.snapshot",
      agentId: "agent-a",
      configs: [],
    }), true);

    const terminals = traces.filter((trace) =>
      trace.name === "daemon.app_config.receive"
    );
    assert.deepEqual(
      terminals.map(({ attrs, status }) => ({
        outcome: attrs.outcome,
        reason: attrs.reason,
        status,
        correlation: attrs.app_correlation_id,
      })),
      [
        {
          outcome: "applied",
          reason: undefined,
          status: "ok",
          correlation: "config:system.cleaner:agent-a:2",
        },
        {
          outcome: "stale",
          reason: undefined,
          status: "error",
          correlation: "config:system.cleaner:agent-a:1",
        },
        {
          outcome: "invalid",
          reason: "config_invalid",
          status: "error",
          correlation: "config:system.cleaner:agent-a:3",
        },
        {
          outcome: "removed",
          reason: undefined,
          status: "ok",
          correlation: "snapshot:app_config:system.cleaner:agent-a",
        },
      ],
    );
  } finally {
    runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent start asks for app config only while the owner has none, once per connection", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "app-config-start-"));
  const sent: Array<{ type: string; agentId?: string }> = [];
  const runtime = createBuiltInLocalScheduleRuntime({
    agentsDataDir: root,
    cleanerClock,
    getInbox: () => createAgentAppInboxStore(),
    notifyInbox: async () => false,
    send: (message) => sent.push(message as { type: string; agentId?: string }),
    tracer: noopTracer,
  });
  const configRequests = () =>
    sent.filter((message) => message.type === "app_config.snapshot.request")
      .map((message) => message.agentId);

  try {
    assert.equal(runtime.requestAppConfigSnapshotIfMissing("agent-a"), true);
    assert.equal(runtime.requestAppConfigSnapshotIfMissing("agent-a"), false);
    assert.deepEqual(configRequests(), ["agent-a"]);

    runtime.handleServerMessage({
      type: "app_config.snapshot",
      agentId: "agent-b",
      configs: [{
        appId: "system.cleaner",
        ownerAgentId: "agent-b",
        revision: 1,
        effective: { ...CLEANER_CONFIG_DEFAULTS },
      }],
    });
    assert.equal(runtime.requestAppConfigSnapshotIfMissing("agent-b"), false);

    runtime.onConnect();
    assert.equal(runtime.requestAppConfigSnapshotIfMissing("agent-a"), true);
    assert.deepEqual(configRequests(), ["agent-a", "agent-a"]);
  } finally {
    runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
