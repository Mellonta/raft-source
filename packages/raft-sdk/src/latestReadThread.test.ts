import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { cliReadStatePathSegments } from "@botiverse/raft-shared/src/agentOps/index";

import { readLatestReadThread } from "./index";

const recordPath = (home: string, agentId: string) => join(home, ...cliReadStatePathSegments(agentId));

function homeWith(agentId: string, record: unknown, mode = 0o600): string {
  const home = mkdtempSync(join(tmpdir(), "raft-sdk-latest-read-"));
  const file = recordPath(home, agentId);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, typeof record === "string" ? record : JSON.stringify(record), { mode });
  chmodSync(file, mode);
  return home;
}

const threadThenNothing = { targets: { "#room": { seq: 900, readOrder: 1 }, "#room:1a2b3c4d": { seq: 40, readOrder: 2 } }, nextReadOrder: 3 };

test("reads the CLI's record without a credential or a network call", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("readLatestReadThread must not use the network"); }) as typeof fetch;
  try {
    const home = homeWith("agent-1", threadThenNothing);
    assert.deepEqual(
      await readLatestReadThread({ agentId: "agent-1", home, env: {} }),
      { state: "thread", target: "#room:1a2b3c4d", parentTarget: "#room" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the agent id and the home default to what the CLI resolves from the environment", async () => {
  const home = homeWith("agent-1", threadThenNothing);
  const expected = { state: "thread", target: "#room:1a2b3c4d", parentTarget: "#room" };
  assert.deepEqual(await readLatestReadThread({ env: { SLOCK_AGENT_ID: "agent-1", SLOCK_HOME: home } }), expected);
  assert.deepEqual(await readLatestReadThread({ env: { SLOCK_AGENT_ID: "agent-1", RAFT_HOME: home, SLOCK_HOME: "/nonexistent" } }), expected);
  assert.deepEqual(await readLatestReadThread({ env: { SLOCK_AGENT_ID: "agent-1", SLOCK_CLI_CONSUMED_SEQ_STATE_DIR: home, RAFT_HOME: "/nonexistent" } }), expected);
});

test("a later channel read means no latest thread", async () => {
  const home = homeWith("agent-1", { targets: { "#room:1a2b3c4d": { seq: 40, readOrder: 1 }, "#room": { seq: 900, readOrder: 2 } } });
  assert.deepEqual(await readLatestReadThread({ agentId: "agent-1", home, env: {} }), { state: "none", reason: "latest_read_is_not_a_thread" });
});

test("each way of having nothing to report has its own reason", async () => {
  const home = homeWith("agent-1", { targets: {} });
  assert.deepEqual(await readLatestReadThread({ home, env: {} }), { state: "none", reason: "no_agent_id" });
  assert.deepEqual(await readLatestReadThread({ agentId: "../agent-1", home, env: {} }), { state: "none", reason: "no_agent_id" });
  assert.deepEqual(await readLatestReadThread({ agentId: "agent-never", home, env: {} }), { state: "none", reason: "no_record" });
  assert.deepEqual(await readLatestReadThread({ agentId: "agent-1", home, env: {} }), { state: "none", reason: "no_reads" });
  assert.deepEqual(await readLatestReadThread({ agentId: "agent-1", home: homeWith("agent-1", "{not json"), env: {} }), { state: "none", reason: "unreadable" });
});

test("a record that is not a private regular file of this user is not trusted", async () => {
  if (typeof process.getuid !== "function") return;
  const shared = homeWith("agent-1", threadThenNothing, 0o644);
  assert.deepEqual(await readLatestReadThread({ agentId: "agent-1", home: shared, env: {} }), { state: "none", reason: "unreadable" });

  const real = homeWith("agent-1", threadThenNothing);
  const linked = mkdtempSync(join(tmpdir(), "raft-sdk-latest-read-link-"));
  mkdirSync(dirname(recordPath(linked, "agent-1")), { recursive: true });
  symlinkSync(recordPath(real, "agent-1"), recordPath(linked, "agent-1"));
  assert.deepEqual(await readLatestReadThread({ agentId: "agent-1", home: linked, env: {} }), { state: "none", reason: "unreadable" });
});
