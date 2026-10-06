import assert from "node:assert/strict";
import { formatAgentInboxAppItems, noopTracer, type AgentInboxAppItem } from "@botiverse/raft-shared";
import { createAgentAppInboxStore, type AgentAppInboxNoticeOptions, type AgentAppInboxStore } from "../../agentAppInbox";
import { createBuiltInLocalScheduleRuntime } from "../../registry.manifest";

const { diskStats } = vi.hoisted(() => ({
  diskStats: vi.fn(async (_absolutePath: string) => ({
    type: 0, bsize: 4096, blocks: 100, bfree: 90, bavail: 9, files: 0, ffree: 0,
  })),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  statfs: diskStats,
}));

function productionRuntime(input: { memoryBytes: number }) {
  const inboxes = new Map<string, AgentAppInboxStore>();
  const delivered: Array<{ owner: string; item: AgentInboxAppItem; notice: AgentAppInboxNoticeOptions | undefined }> = [];
  const traces: Array<{ name: string; attrs: Readonly<Record<string, unknown>> }> = [];
  const runtime = createBuiltInLocalScheduleRuntime({
    agentsDataDir: "/computer/agents",
    cleanerMeasureMemoryFile: async () => ({ kind: "measured", bytes: input.memoryBytes }),
    cleanerMeasureRaftDiskFootprint: async () => ({
      raft_migration_chunks_bytes: 300,
      raft_workspace_backups_bytes: 2_000,
      raft_launch_dirs_bytes: 20,
      measure_outcome: "complete",
    }),
    getInbox(owner) {
      let inbox = inboxes.get(owner);
      if (!inbox) {
        inbox = createAgentAppInboxStore({ registry: runtime.inboxRegistry });
        inboxes.set(owner, inbox);
      }
      return inbox;
    },
    notifyInbox: async (owner, item, notice) => { delivered.push({ owner, item, notice }); return true; },
    send: () => {},
    trace: (name, attrs) => { traces.push({ name, attrs }); },
    tracer: noopTracer,
  });
  for (const owner of ["owner-a", "owner-b"]) {
    runtime.handleServerMessage({
      type: "app_config.upsert",
      agentId: owner,
      config: {
        appId: "system.cleaner", ownerAgentId: owner, revision: 1,
        effective: { enabled: true, thresholdBytes: 65536, intervalMs: 3600000 },
      },
    });
  }
  return { runtime, inboxes, delivered, traces };
}

test("low disk space is traced per owner but never reaches or wakes an agent", async () => {
  vi.useFakeTimers();
  const { runtime, inboxes, delivered, traces } = productionRuntime({ memoryBytes: 1 });
  try {
    await vi.advanceTimersByTimeAsync(3600000);
    assert.ok(diskStats.mock.calls.every(([root]) => root === "/computer/agents"));
    const lowDisk = traces.filter(({ name, attrs }) =>
      name === "daemon.cleaner.decision" && attrs.decision === "disk_low");
    assert.equal(lowDisk.length, 2, "bavail, not root-reserved bfree, determines pressure");
    for (const { attrs } of lowDisk) {
      assert.equal(attrs.disk_available_bytes, 9 * 4096);
      assert.equal(attrs.disk_total_bytes, 100 * 4096);
      assert.equal(attrs.raft_workspace_backups_bytes, 2_000, "Raft's own footprint rides on the low-disk decision");
      assert.equal(attrs.measure_outcome, "complete");
    }
    assert.equal(delivered.length, 0, "a machine-wide condition must not wake every agent on it");
    for (const owner of ["owner-a", "owner-b"]) {
      assert.equal(inboxes.get(owner)?.list().length ?? 0, 0);
    }
  } finally {
    runtime.stop();
    vi.useRealTimers();
  }
});

test("the memory hint asks the production notice path never to start a stopped agent", async () => {
  vi.useFakeTimers();
  const { runtime, inboxes, delivered } = productionRuntime({ memoryBytes: 65537 });
  try {
    await vi.advanceTimersByTimeAsync(3600000);
    assert.deepEqual(
      delivered.map(({ owner, item, notice }) => [owner, item.notificationClass, notice]),
      [
        ["owner-a", "memory_size_hint", { startStoppedAgent: false }],
        ["owner-b", "memory_size_hint", { startStoppedAgent: false }],
      ],
    );
    assert.match(formatAgentInboxAppItems(inboxes.get("owner-a")!.list()), /class=memory_size_hint/);
  } finally {
    runtime.stop();
    vi.useRealTimers();
  }
});
