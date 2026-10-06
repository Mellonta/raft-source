import assert from "node:assert/strict";

import { RuntimeAccountUsageClient } from "../src/utils/runtimeAccountUsageClient";

test("dedupes cache reads and keeps a 60-second client cache", async () => {
  let now = 1_000;
  let calls = 0;
  let resolveRead!: (value: any) => void;
  const client = new RuntimeAccountUsageClient(
    async () => {
      calls += 1;
      return new Promise((resolve) => { resolveRead = resolve; });
    },
    async () => ({ accepted: true, state: "requested" }),
    () => now,
  );
  const first = client.read("server", "machine", "codex");
  const duplicate = client.read("server", "machine", "codex");
  assert.equal(calls, 1);
  resolveRead({ state: "missing", snapshot: null });
  assert.equal(await first, await duplicate);
  assert.equal((await client.read("server", "machine", "codex")).state, "missing");
  assert.equal(calls, 1);
  now += 60_001;
  void client.read("server", "machine", "codex");
  assert.equal(calls, 2);
});

test("dedupes refreshes and enforces a two-minute client cooldown", async () => {
  let now = 1_000;
  let calls = 0;
  const client = new RuntimeAccountUsageClient(
    async () => ({ state: "missing", snapshot: null }),
    async () => {
      calls += 1;
      return { accepted: true, state: "requested" };
    },
    () => now,
  );
  assert.deepEqual(await client.refresh("server", "machine", "claude", "stale_or_missing"), {
    accepted: true,
    state: "requested",
  });
  assert.deepEqual(await client.refresh("server", "machine", "claude", "manual"), {
    accepted: false,
    state: "cooldown",
  });
  assert.equal(calls, 1);
  now += 120_001;
  await client.refresh("server", "machine", "claude", "manual");
  assert.equal(calls, 2);
});

test("a fresh refresh result is written into the read cache in the read-path shape", async () => {
  let now = 1_000;
  let reads = 0;
  const freshSnapshot = { protocolVersion: 2, provider: "codex" } as unknown as never;
  const client = new RuntimeAccountUsageClient(
    async () => {
      reads += 1;
      return { state: "missing", snapshot: null };
    },
    async () => ({ accepted: true, state: "fresh" as const, snapshot: freshSnapshot }),
    () => now,
  );
  const result = await client.refresh("server", "machine", "codex", "manual");
  assert.equal(result.state, "fresh");
  assert.deepEqual(await client.read("server", "machine", "codex"), {
    state: "fresh",
    snapshot: freshSnapshot,
  });
  assert.equal(reads, 0);
});

test("a timed-out refresh result passes through unchanged", async () => {
  const client = new RuntimeAccountUsageClient(
    async () => ({ state: "missing", snapshot: null }),
    async () => ({ accepted: true, state: "timeout" as const }),
  );
  assert.deepEqual(await client.refresh("server", "machine", "claude", "manual"), {
    accepted: true,
    state: "timeout",
  });
});
