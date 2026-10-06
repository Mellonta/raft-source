import assert from "node:assert/strict";

import {
  cliReadStatePathSegments,
  configuredCliReadStateBase,
  configuredRaftHome,
  latestReadThreadFromCliReadState,
  parentTargetOfThread,
} from "./latestReadThread";

test("the latest read thread follows local read order, not the message seq", () => {
  assert.deepEqual(
    latestReadThreadFromCliReadState({
      targets: {
        "#room:older-read-high-seq": { seq: 900, readOrder: 1 },
        "dm:@peer:newer-read-low-seq": { seq: 10, readOrder: 2 },
      },
      nextReadOrder: 3,
    }),
    { state: "thread", target: "dm:@peer:newer-read-low-seq", parentTarget: "dm:@peer" },
  );
});

test("a later read of a channel or DM root means there is no latest thread", () => {
  for (const root of ["#room", "dm:@peer"]) {
    assert.deepEqual(
      latestReadThreadFromCliReadState({ targets: { "#room:thread": { seq: 5, readOrder: 1 }, [root]: { seq: 3, readOrder: 2 } } }),
      { state: "none", reason: "latest_read_is_not_a_thread" },
    );
  }
});

test("records written before read order existed fall back to their seq", () => {
  assert.deepEqual(
    latestReadThreadFromCliReadState({ targets: { "#room:a": 5, "#room:b": { seq: 9 } } }),
    { state: "thread", target: "#room:b", parentTarget: "#room" },
  );
});

test("a sparse drain alone is not a read", () => {
  assert.deepEqual(
    latestReadThreadFromCliReadState({ targets: { "#room:thread": { exactSeqs: [4, 5] } } }),
    { state: "none", reason: "no_reads" },
  );
});

test("an empty or unrecognised record has no reads", () => {
  for (const raw of [null, undefined, 7, "x", [], {}, { targets: null }, { targets: [] }, { targets: { "": { seq: 1 } } }, { targets: { "#room:t": { seq: -1, readOrder: "2" } } }]) {
    assert.deepEqual(latestReadThreadFromCliReadState(raw), { state: "none", reason: "no_reads" });
  }
});

test("thread parents: only `#channel:thread` and `dm:@peer:thread` are threads", () => {
  assert.equal(parentTargetOfThread("#room:abcd1234"), "#room");
  assert.equal(parentTargetOfThread("dm:@peer:abcd1234"), "dm:@peer");
  assert.equal(parentTargetOfThread("#room"), null);
  assert.equal(parentTargetOfThread("dm:@peer"), null);
  assert.equal(parentTargetOfThread("#room:"), null);
  assert.equal(parentTargetOfThread("room:abcd1234"), null);
});

test("the record's location: base from the environment, then namespace, agent, file", () => {
  assert.deepEqual(cliReadStatePathSegments("agent-1"), ["slock-cli-consumed-seq", "agent-1", "consumed-seqs.json"]);
  assert.throws(() => cliReadStatePathSegments("../agent-1"));
  assert.throws(() => cliReadStatePathSegments(""));

  assert.equal(configuredRaftHome({}), undefined);
  assert.equal(configuredRaftHome({ SLOCK_HOME: "/s" }), "/s");
  assert.equal(configuredRaftHome({ RAFT_HOME: " /r ", SLOCK_HOME: "/s" }), "/r");
  assert.equal(configuredRaftHome({ RAFT_HOME: "  ", SLOCK_HOME: "/s" }), "/s");

  assert.equal(configuredCliReadStateBase({}), undefined);
  assert.equal(configuredCliReadStateBase({ RAFT_HOME: "/r" }), "/r");
  assert.equal(configuredCliReadStateBase({ SLOCK_CLI_CONSUMED_SEQ_STATE_DIR: "/d", RAFT_HOME: "/r" }), "/d");
});
