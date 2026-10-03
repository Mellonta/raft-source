import assert from "node:assert/strict";
import test from "node:test";
import { raftdevStoragePaths } from "./raftdev-paths.js";

test("legacy state and seed locations are unchanged when unset", () => {
  assert.deepEqual(raftdevStoragePaths("/workspace/raft", {}), {
    stateRoot: "/workspace/raft/.slockdev", seedRoot: "/workspace/raft",
  });
});

test("one external root controls both environment state and seed credentials", () => {
  assert.deepEqual(raftdevStoragePaths("/workspace/raft", { RAFTDEV_STATE_DIR: " /data/.raftdev " }), {
    stateRoot: "/data/.raftdev", seedRoot: "/data/.raftdev",
  });
});
