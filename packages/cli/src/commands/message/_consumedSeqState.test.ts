import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cliReadStatePathSegments, latestReadThreadFromCliReadState } from "@botiverse/raft-shared";

import {
  canonicalizeConsumedTarget,
  getConsumedExactSeqs,
  getMostRecentConsumedThreadForParent,
  getConsumedSeq,
  recordConsumedExactSeqs,
  recordConsumedSeqs,
  recordTargetAlias,
} from "./_consumedSeqState";
import { readAllStreamEntries, resolveCanonicalTarget } from "../../state/agentLedger";

// FH-EXT-001 local-cursor unit gates (task #70). Gate numbers reference
// Kai's conformance list in #wg-external-agent:0afd19eb.

function freshStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-"));
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = dir;
  return dir;
}

test("consumed cursor is strictly per-target — no cross-target leakage (gate 3)", () => {
  freshStateDir();
  recordConsumedSeqs("agent-1", { "#busy-channel": 500 });
  assert.equal(getConsumedSeq("agent-1", "#busy-channel"), 500);
  // Channel B was never consumed: a high seq in A must prove nothing for B.
  assert.equal(getConsumedSeq("agent-1", "#quiet-channel"), undefined);
  assert.equal(getConsumedSeq("agent-1", "dm:@peer"), undefined);
});

test("poisoned #undefined aliases and targets are ignored and scrubbed on the next write", () => {
  const root = freshStateDir();
  const file = path.join(root, "slock-cli-consumed-seq", "agent-1", "consumed-seqs.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    targets: {
      "#undefined": { seq: 999, readOrder: 99 },
      "#safe": { seq: 10, readOrder: 1 },
    },
    aliases: {
      "#alpha": "#undefined",
      "dm:@peer": "#undefined",
    },
    nextReadOrder: 100,
  }), { mode: 0o600 });

  assert.equal(getConsumedSeq("agent-1", "#alpha"), undefined);
  assert.equal(getConsumedSeq("agent-1", "dm:@peer"), undefined);
  assert.equal(getConsumedSeq("agent-1", "#undefined"), undefined);
  assert.equal(getConsumedSeq("agent-1", "#safe"), 10);

  recordConsumedSeqs("agent-1", { "#alpha": 20 });
  assert.equal(getConsumedSeq("agent-1", "#alpha"), 20);
  assert.equal(getConsumedSeq("agent-1", "dm:@peer"), undefined);

  // The ledger import is read-only with respect to the legacy JSON (it is
  // the migration source, never rewritten), so the scrub is asserted on the
  // ledger itself: no poisoned evidence key, no alias that resolves to one.
  assert.equal("#undefined" in readAllStreamEntries("agent-1"), false);
  assert.notEqual(resolveCanonicalTarget("agent-1", "#alpha"), "#undefined");
  assert.notEqual(resolveCanonicalTarget("agent-1", "dm:@peer"), "#undefined");
});

test("alias writes reject poisoned canonical targets while retaining valid aliases", () => {
  freshStateDir();
  assert.equal(canonicalizeConsumedTarget("#undefined"), null);
  assert.equal(canonicalizeConsumedTarget("#alpha:undefined"), null);
  assert.equal(canonicalizeConsumedTarget(" #alpha"), null);
  assert.equal(canonicalizeConsumedTarget("DM:@Peer"), "dm:@Peer");

  recordTargetAlias("agent-1", "#alpha", "#undefined");
  recordConsumedSeqs("agent-1", { "#undefined": 500 });
  assert.equal(getConsumedSeq("agent-1", "#alpha"), undefined);
  assert.equal(getConsumedSeq("agent-1", "#undefined"), undefined);

  recordTargetAlias("agent-1", "#alpha:feedbeef", "#alpha:deadbeef");
  recordConsumedSeqs("agent-1", { "#alpha:feedbeef": 11 });
  assert.equal(getConsumedSeq("agent-1", "#alpha:deadbeef"), 11);
});

test("consumed cursor merges monotonically per target", () => {
  freshStateDir();
  recordConsumedSeqs("agent-1", { "#room": 10, "dm:@peer": 7 });
  recordConsumedSeqs("agent-1", { "#room": 8 });   // stale write must not regress
  recordConsumedSeqs("agent-1", { "#room": 12 });
  assert.equal(getConsumedSeq("agent-1", "#room"), 12);
  assert.equal(getConsumedSeq("agent-1", "dm:@peer"), 7);
});

test("absent or junk cursors resolve to undefined (omit → server fail-closed hold)", () => {
  freshStateDir();
  assert.equal(getConsumedSeq("agent-1", "#never-read"), undefined);
  recordConsumedSeqs("agent-1", { "#room": Number.NaN, "": 9, "#zero": 0 });
  assert.equal(getConsumedSeq("agent-1", "#room"), undefined);
  assert.equal(getConsumedSeq("agent-1", "#zero"), undefined);
});

test("cursors are per-agent isolated", () => {
  freshStateDir();
  recordConsumedSeqs("agent-1", { "#room": 30 });
  assert.equal(getConsumedSeq("agent-2", "#room"), undefined);
});

test("sparse exact seqs stay per-target and are pruned only by a real high-water read", () => {
  freshStateDir();
  recordConsumedExactSeqs("agent-1", { "#room": [12, 10, 12], "dm:@peer": [9] });
  assert.equal(getConsumedSeq("agent-1", "#room"), undefined);
  assert.deepEqual(getConsumedExactSeqs("agent-1", "#room"), [10, 12]);
  assert.deepEqual(getConsumedExactSeqs("agent-1", "dm:@peer"), [9]);

  recordConsumedSeqs("agent-1", { "#room": 10 });
  assert.deepEqual(getConsumedExactSeqs("agent-1", "#room"), [12]);
  assert.deepEqual(getConsumedExactSeqs("agent-1", "dm:@peer"), [9]);
});

test("most recent thread context follows local read order, not global message seq", () => {
  freshStateDir();
  recordConsumedSeqs("agent-1", { "#room:older-read-high-seq": 200 });
  recordConsumedSeqs("agent-1", { "#room:newer-read-low-seq": 150 });

  assert.deepEqual(
    getMostRecentConsumedThreadForParent("agent-1", "#room"),
    { target: "#room:newer-read-low-seq", seq: 150, readOrder: 2 },
  );
});

// The SDK's `readLatestReadThread` reads this file through the shared reader
// (no CLI code). Writing through the CLI and reading the bytes on disk pins
// that the two agree on the file's location and shape.
test("the record this CLI writes answers the SDK's latest-read-thread question", () => {
  const root = freshStateDir();
  const onDisk = () => JSON.parse(fs.readFileSync(path.join(root, ...cliReadStatePathSegments("agent-1")), "utf8"));

  recordConsumedSeqs("agent-1", { "#room:older-read-high-seq": 200 });
  recordConsumedSeqs("agent-1", { "dm:@peer:newer-read-low-seq": 10 });
  recordConsumedExactSeqs("agent-1", { "#room:only-drained": [300] });
  assert.deepEqual(latestReadThreadFromCliReadState(onDisk()), { state: "thread", target: "dm:@peer:newer-read-low-seq", parentTarget: "dm:@peer" });

  recordConsumedSeqs("agent-1", { "#room": 5 });
  assert.deepEqual(latestReadThreadFromCliReadState(onDisk()), { state: "none", reason: "latest_read_is_not_a_thread" });
});
