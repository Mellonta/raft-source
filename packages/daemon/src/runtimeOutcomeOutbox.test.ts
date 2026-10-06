import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MachineToServerMessage } from "@botiverse/raft-shared";
import { vi } from "vitest";
import {
  OUTBOX_HARD_TOTAL,
  OUTBOX_NORMAL_CAP,
  OUTBOX_RETRANSMIT_BASE_MS,
  OUTBOX_RETRANSMIT_MAX_MS,
  RuntimeOutcomeOutbox,
  retransmitDelayMs,
  adoptTakeoverEpoch,
  blockingMarkers,
  canAdmitStart,
  AUTOMATIC_START_REFUSAL_TEXT,
  nodeOutboxFs,
  createNodeOutboxFs,
  type AgentOutboxState,
  type OutboxFrame,
  type OutboxFs,
} from "./runtimeOutcomeOutbox";

const AGENT = "agent-1";

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "rfc071-outbox-"));
}

function e1(seq: number, instance = "d1"): OutboxFrame {
  return {
    type: "agent:runtime:outcome", v: 1, agentId: AGENT, launchId: `launch-${seq}`, sessionId: "s", daemonInstanceId: instance,
    clientSeq: seq, observedAtMs: 1, outcome: { kind: "terminal_failure", failureKind: "compaction_failed", fingerprint: "c4722931c8a1f172", errorClass: "RuntimeError" },
  };
}
function e2(seq: number, instance = "d1"): OutboxFrame {
  return {
    type: "agent:runtime:outcome", v: 1, agentId: AGENT, launchId: `launch-${seq}`, sessionId: "s", daemonInstanceId: instance,
    clientSeq: seq, observedAtMs: 1, outcome: { kind: "turn_completed", textEvents: 1, toolCalls: 0 },
  };
}
function spawned(seq: number, instance = "d1"): OutboxFrame {
  return { type: "agent:process_spawned", agentId: AGENT, daemonInstanceId: instance, processInstanceId: `p-${seq}`, launchId: `launch-${seq}`, clientSeq: seq };
}
function exited(seq: number, instance = "d1"): OutboxFrame {
  return { type: "agent:process_exited", agentId: AGENT, daemonInstanceId: instance, processInstanceId: `p-${seq}`, spawnLaunchId: `launch-${seq}`, launchId: `launch-${seq}`, clientSeq: seq, code: 0, signal: null };
}
function startOutcome(seq: number, instance = "d1"): OutboxFrame {
  return { type: "agent:start:outcome", agentId: AGENT, daemonInstanceId: instance, launchId: `launch-${seq}`, clientSeq: seq, result: { kind: "not_spawned", reason: "cancelled" } };
}

/** The admitted start's result is stored (not_spawned here), closing its open request. */
function settle(outbox: RuntimeOutcomeOutbox, launchId: string, seq: number, instance = "d1"): void {
  outbox.enqueue({ type: "agent:start:outcome", agentId: AGENT, daemonInstanceId: instance, launchId, clientSeq: seq, result: { kind: "not_spawned", reason: "cancelled" } });
}

function makeOutbox(dir: string, options: { instance?: string; fs?: OutboxFs } = {}) {
  const sent: MachineToServerMessage[] = [];
  const outbox = new RuntimeOutcomeOutbox({ dir, daemonInstanceId: options.instance ?? "d1", send: (msg) => sent.push(msg), fs: options.fs });
  return { outbox, sent };
}

function onDisk(dir: string): AgentOutboxState {
  return JSON.parse(readFileSync(path.join(dir, `${AGENT}.json`), "utf8")) as AgentOutboxState;
}

function seqOf(msg: MachineToServerMessage): string {
  if ("clientSeq" in msg && typeof msg.clientSeq === "number") return `${(msg as { daemonInstanceId: string }).daemonInstanceId}:${msg.clientSeq}`;
  if ("gapId" in msg) return `${msg.type}`;
  return msg.type;
}

function ackFor(msg: MachineToServerMessage) {
  if (msg.type === "agent:runtime:outcome_gap" || msg.type === "agent:runtime:outcome_cross_instance_unknown") {
    return { agentId: msg.agentId, gapId: msg.gapId };
  }
  const frame = msg as OutboxFrame;
  return { agentId: frame.agentId, daemonInstanceId: frame.daemonInstanceId, clientSeq: frame.clientSeq };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function withDir(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = tempDir();
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("RFC 071 outbox (1): a same-instance disconnect resends the in-flight entry with its identity, then delivers the rest in order, one at a time", withDir((dir) => {
  const sent: MachineToServerMessage[] = [];
  const onDiskAtSend: boolean[] = [];
  const outbox = new RuntimeOutcomeOutbox({
    dir,
    daemonInstanceId: "d1",
    send: (msg) => {
      // Write-ahead: every entry is on disk before it is sent.
      const frame = msg as OutboxFrame;
      onDiskAtSend.push(existsSync(path.join(dir, `${AGENT}.json`))
        && onDisk(dir).entries.some((entry) => entry.t === "normal" && entry.clientSeq === frame.clientSeq));
      sent.push(msg);
    },
  });
  outbox.onServerContext(true);
  outbox.enqueue(spawned(1));
  outbox.enqueue(e1(2));
  assert.deepEqual(sent.map(seqOf), ["d1:1"], "stop-and-wait: one in flight");
  outbox.onDisconnected();
  outbox.enqueue(exited(3));
  assert.deepEqual(sent.map(seqOf), ["d1:1"], "nothing is sent while disconnected");
  outbox.onServerContext(true);
  assert.deepEqual(sent.map(seqOf), ["d1:1", "d1:1"], "the unacked entry is resent with the same clientSeq");
  outbox.ack(ackFor(sent[1]!));
  outbox.ack(ackFor(sent[2]!));
  outbox.ack(ackFor(sent[3]!));
  assert.deepEqual(sent.map(seqOf), ["d1:1", "d1:1", "d1:2", "d1:3"]);
  assert.deepEqual(onDiskAtSend, [true, true, true, true]);
  assert.deepEqual(onDisk(dir).entries, []);
}));

test("RFC 071 outbox (2): after a daemon restart, E1 is resent with its ORIGINAL (daemonInstanceId, clientSeq)", withDir((dir) => {
  const first = makeOutbox(dir, { instance: "d-old" });
  first.outbox.enqueue(e1(7, "d-old"));
  assert.equal(first.sent.length, 0, "no server yet");
  // Write-ahead: on disk as soon as enqueue returns.
  assert.equal(onDisk(dir).entries.length, 1);

  const second = makeOutbox(dir, { instance: "d-new" });
  second.outbox.load();
  second.outbox.onServerContext(true);
  assert.equal(second.sent.length, 1);
  const resent = second.sent[0] as OutboxFrame;
  assert.equal(resent.type, "agent:runtime:outcome");
  assert.equal(resent.daemonInstanceId, "d-old");
  assert.equal(resent.clientSeq, 7);
}));

test("RFC 071 outbox: overflow drops the oldest turn_completed first, never an E1 or an exit", withDir((dir) => {
  const { outbox } = makeOutbox(dir);
  outbox.enqueue(e2(1));
  for (let seq = 2; seq <= OUTBOX_NORMAL_CAP; seq += 1) outbox.enqueue(seq % 2 ? e1(seq) : exited(seq));
  outbox.enqueue(e1(OUTBOX_NORMAL_CAP + 1));
  const state = outbox.state(AGENT);
  assert.equal(state.entries.length, OUTBOX_NORMAL_CAP);
  assert.ok(!state.entries.some((entry) => entry.t === "normal" && entry.clientSeq === 1), "the turn_completed was dropped");
  assert.ok(!state.entries.some((entry) => entry.t !== "normal"), "no gap needed while a turn_completed can go");
  assert.equal(outbox.refusesAutomaticStart(AGENT), false);
}));

test("RFC 071 outbox (3): an ack for an entry that was folded is a no-op; the gap stays until its own gapId ack", withDir((dir) => {
  const { outbox, sent } = makeOutbox(dir);
  for (let seq = 1; seq <= OUTBOX_NORMAL_CAP + 1; seq += 1) outbox.enqueue(e1(seq));
  const state = outbox.state(AGENT);
  const gap = state.entries.find((entry) => entry.t === "gap");
  assert.ok(gap && gap.t === "gap", "the oldest entry was folded into a gap");
  assert.deepEqual([gap.fromSeq, gap.toSeq, gap.counts.e1], [1, 1, 1]);
  outbox.ack({ agentId: AGENT, daemonInstanceId: "d1", clientSeq: 1 });
  assert.ok(outbox.state(AGENT).entries.includes(gap), "late ack for the folded entry is a no-op");
  assert.equal(outbox.refusesAutomaticStart(AGENT), true, "an un-acked gap refuses automatic starts");
  outbox.onServerContext(true);
  assert.equal(sent[0]?.type, "agent:runtime:outcome_gap");
  outbox.ack({ agentId: AGENT, gapId: gap.gapId });
  assert.ok(!outbox.state(AGENT).entries.includes(gap));
  assert.equal(outbox.refusesAutomaticStart(AGENT), false);
}));

test("RFC 071 outbox (4): the in-flight entry is never folded", withDir((dir) => {
  const { outbox, sent } = makeOutbox(dir);
  outbox.onServerContext(true);
  for (let seq = 1; seq <= OUTBOX_NORMAL_CAP + 5; seq += 1) outbox.enqueue(e1(seq));
  assert.deepEqual(sent.map(seqOf), ["d1:1"]);
  const first = outbox.state(AGENT).entries[0]!;
  assert.ok(first.t === "normal" && first.clientSeq === 1, "the in-flight E1 is still entry 0");
  const gap = outbox.state(AGENT).entries.find((entry) => entry.t === "gap");
  assert.ok(gap && gap.t === "gap" && gap.fromSeq === 2 && gap.toSeq === 6 && gap.counts.e1 === 5);
}));

test("RFC 071 outbox (5): a crash between the durable-write steps leaves only a complete state on disk", withDir((dir) => {
  const { outbox } = makeOutbox(dir);
  for (let seq = 1; seq <= OUTBOX_NORMAL_CAP; seq += 1) outbox.enqueue(e1(seq));
  const before = JSON.stringify(onDisk(dir));
  for (const failAt of ["writeTempAndSync", "rename", "syncDir"] as const) {
    const failing: OutboxFs = {
      writeTempAndSync: (temp, data) => {
        if (failAt === "writeTempAndSync") {
          writeFileSync(temp, data.slice(0, 20)); // a torn temp write
          throw new Error("EIO");
        }
        nodeOutboxFs.writeTempAndSync(temp, data);
      },
      rename: (from, to) => {
        if (failAt === "rename") throw new Error("EIO");
        nodeOutboxFs.rename(from, to);
      },
      syncDir: (d) => {
        if (failAt === "syncDir") throw new Error("EIO");
        nodeOutboxFs.syncDir(d);
      },
    };
    const crashing = makeOutbox(dir, { fs: failing });
    crashing.outbox.load();
    crashing.outbox.enqueue(e1(1000)); // this write folds the oldest entry into a gap
    const text = readFileSync(path.join(dir, `${AGENT}.json`), "utf8");
    const parsed = JSON.parse(text) as AgentOutboxState; // complete JSON either way
    if (failAt === "syncDir") {
      assert.ok(parsed.entries.some((entry) => entry.t === "gap"), "rename happened: the new complete state");
    } else {
      assert.equal(JSON.stringify(parsed), before, `${failAt}: the old complete state`);
    }
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp-")), [], "no temp file is left behind");
    assert.equal(crashing.outbox.isUnreliable(AGENT), true, `${failAt}: a failed write marks the agent unreliable`);
    // Restore the pre-crash state for the next step.
    writeFileSync(path.join(dir, `${AGENT}.json`), before);
  }
}));

test("RFC 071 outbox (6): while a gap is in flight the same instance keeps overflowing into a second, open gap; the total stays capped", withDir((dir) => {
  const { outbox, sent } = makeOutbox(dir);
  for (let seq = 1; seq <= OUTBOX_NORMAL_CAP + 1; seq += 1) outbox.enqueue(e1(seq));
  outbox.onServerContext(true);
  assert.equal(sent[0]?.type, "agent:runtime:outcome_gap", "the gap is in flight (sealed)");
  const inFlightGap = outbox.state(AGENT).entries[0]!;
  const sealedCounts = JSON.stringify(inFlightGap.t === "gap" ? inFlightGap.counts : null);
  for (let seq = 2000; seq < 2600; seq += 1) outbox.enqueue(seq % 3 === 0 ? exited(seq) : e1(seq));
  const state = outbox.state(AGENT);
  const gaps = state.entries.filter((entry) => entry.t === "gap");
  assert.equal(gaps.length, 2);
  assert.equal(JSON.stringify(inFlightGap.t === "gap" ? inFlightGap.counts : null), sealedCounts, "the in-flight gap never grows");
  const open = gaps[1]!;
  assert.ok(open.t === "gap" && !open.sealed && open.counts.e1 + open.counts.exited >= 600);
  assert.ok(state.entries.length <= OUTBOX_HARD_TOTAL);
  assert.equal(state.entries.filter((entry) => entry.t === "normal").length, OUTBOX_NORMAL_CAP);
  assert.equal(outbox.refusesAutomaticStart(AGENT), true);
}));

test("RFC 071 outbox (7): gaps of more than 8 daemon instances merge the oldest instance into a cross-instance entry", withDir((dir) => {
  const { outbox } = makeOutbox(dir, { instance: "d9" });
  const instances = ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9"];
  let seq = 1;
  for (const instance of instances) for (let i = 0; i < 14; i += 1) outbox.enqueue(e1(seq++, instance));
  for (let i = 0; i < 200; i += 1) outbox.enqueue(e1(seq++, "d9"));
  const state = outbox.state(AGENT);
  const gapInstances = new Set(state.entries.flatMap((entry) => entry.t === "gap" ? [entry.daemonInstanceId] : []));
  const cross = state.entries.filter((entry) => entry.t === "cross");
  assert.ok(gapInstances.size <= 8, `at most 8 instances keep gaps (got ${gapInstances.size})`);
  assert.equal(cross.length, 1);
  assert.ok(cross[0]!.t === "cross" && cross[0]!.instances.includes("d1"), "the oldest instance merged into the cross entry");
  const total = state.entries.reduce((sum, entry) => sum + (entry.t === "normal" ? 1 : entry.counts.e1), 0);
  assert.equal(total, seq - 1, "every E1 is either retained or counted in a marker");
  assert.ok(state.entries.length <= OUTBOX_HARD_TOTAL);
}));

test("RFC 071 outbox (8): a new takeover epoch seals old markers; new overflow goes into a new marker, never an old-epoch one", withDir((dir) => {
  const { outbox } = makeOutbox(dir);
  for (let seq = 1; seq <= OUTBOX_NORMAL_CAP + 1; seq += 1) outbox.enqueue(e1(seq));
  const oldGap = outbox.state(AGENT).entries.find((entry) => entry.t === "gap")!;
  // Every old-epoch entry is unfoldable once the epoch moves, so a full
  // old epoch leaves no reserve: the start would be refused.
  assert.equal(canAdmitAfter(outbox, 1), false);
  // The server acknowledges ten old entries; now the new epoch has room.
  for (let seq = 2; seq <= 11; seq += 1) outbox.ack({ agentId: AGENT, daemonInstanceId: "d1", clientSeq: seq });
  assert.equal(outbox.admitStart(AGENT, 1), true);
  assert.ok(oldGap.t === "gap" && oldGap.sealed && oldGap.takeoverEpoch === 0);
  const oldCounts = JSON.stringify(oldGap.counts);
  for (let seq = 500; seq < 530; seq += 1) outbox.enqueue(spawned(seq));
  const gaps = outbox.state(AGENT).entries.filter((entry) => entry.t === "gap");
  assert.equal(JSON.stringify(oldGap.t === "gap" ? oldGap.counts : null), oldCounts, "the old-epoch gap is unchanged");
  assert.ok(gaps.every((gap) => gap === oldGap || gap.takeoverEpoch === 1));
  // Old-epoch E1s are never folded into the new epoch: they are all still retained or in the old gap.
  const oldE1 = outbox.state(AGENT).entries.filter((entry) => entry.t === "normal" && entry.takeoverEpoch === 0).length;
  assert.equal(oldE1 + (oldGap.t === "gap" ? oldGap.counts.e1 : 0), OUTBOX_NORMAL_CAP + 1 - 10);
  assert.ok(gaps.some((gap) => gap.t === "gap" && gap.takeoverEpoch === 1 && gap.counts.spawned > 0), "new overflow went into a new-epoch gap");
}));

/** Would a start at `epoch` be admitted? Evaluated on a copy, so the real state keeps its epoch. */
function canAdmitAfter(outbox: RuntimeOutcomeOutbox, epoch: number): boolean {
  const copy = JSON.parse(JSON.stringify(outbox.state(AGENT))) as AgentOutboxState;
  adoptTakeoverEpoch(copy, epoch);
  return canAdmitStart(copy, "d1");
}

test("RFC 071 outbox (amendment 2): consecutive human starts across epochs with every ack lost stay under the cap, keep old evidence, and are refused at the limit", withDir((dir) => {
  const { outbox, sent } = makeOutbox(dir);
  outbox.onServerContext(true); // connected, but no ack ever arrives
  let seq = 1;
  let epoch = 0;
  let refusedAtEpoch: number | null = null;
  const e1Produced: number[] = [];
  for (let attempt = 0; attempt < 400 && refusedAtEpoch === null; attempt += 1) {
    epoch += 1;
    if (!outbox.admitStart(AGENT, epoch)) {
      refusedAtEpoch = epoch;
      break;
    }
    // One admitted launch: its critical frames, then a burst of daemon respawns.
    outbox.enqueue(startOutcome(seq++));
    outbox.enqueue(spawned(seq++));
    e1Produced.push(seq);
    outbox.enqueue(e1(seq++));
    outbox.enqueue(exited(seq++));
    for (let i = 0; i < 20; i += 1) outbox.enqueue(i % 2 ? spawned(seq++) : exited(seq++));
    assert.ok(outbox.state(AGENT).entries.length <= OUTBOX_HARD_TOTAL, "total never exceeds the cap");
    assert.equal(outbox.isUnreliable(AGENT), false, "admitted launches always fit (no fail-closed)");
  }
  assert.ok(refusedAtEpoch !== null, "the storage limit is reached and the next start is refused");
  assert.equal(outbox.admitStart(AGENT, (refusedAtEpoch ?? 0) + 1), false, "still refused until acks drain");
  const state = outbox.state(AGENT);
  const retainedE1 = state.entries.reduce((sum, entry) => sum + (entry.t === "normal" ? (entry.kind === "e1" ? 1 : 0) : entry.counts.e1), 0);
  assert.equal(retainedE1, e1Produced.length, "every E1 of every epoch is retained or counted");
  assert.ok(state.entries.some((entry) => entry.takeoverEpoch === 1), "first-epoch evidence is still held");
  assert.equal(sent.length, 1, "stop-and-wait: only the first entry was ever sent");
  // Acks drain: the explicit recovery path works again.
  while (state.entries.length > 0) outbox.ack(ackFor(sent[sent.length - 1]!));
  assert.equal(outbox.admitStart(AGENT, (refusedAtEpoch ?? 0) + 2), true);
}));

test("RFC 071 outbox (10): a corrupt file on load marks the agent unreliable and is renamed aside, never deleted", withDir((dir) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${AGENT}.json`), "{not json");
  const { outbox, sent } = makeOutbox(dir);
  outbox.load();
  assert.equal(outbox.isUnreliable(AGENT), true);
  assert.equal(outbox.refusesAutomaticStart(AGENT), true);
  assert.deepEqual(outbox.unreliableAgents(), [AGENT]);
  const aside = readdirSync(dir).filter((name) => name.startsWith(`${AGENT}.json.corrupt-`));
  assert.equal(aside.length, 1);
  assert.equal(readFileSync(path.join(dir, aside[0]!), "utf8"), "{not json");
  assert.ok(sent.some((msg) => msg.type === "agent:runtime:outcome_unreliable"));
}));

test("RFC 071 outbox (9, unit): a failed first-E1 write with the server connected refuses at once, sends outcome_unreliable, and does NOT send the unpersisted E1", withDir((dir) => {
  const failing: OutboxFs = { ...nodeOutboxFs, writeTempAndSync: () => { throw new Error("ENOSPC"); } };
  const { outbox, sent } = makeOutbox(dir, { fs: failing });
  outbox.onServerContext(true);
  outbox.enqueue(e1(1));
  assert.equal(outbox.refusesAutomaticStart(AGENT), true);
  assert.equal(sent[0]?.type, "agent:runtime:outcome_unreliable");
  assert.equal(sent.filter((msg) => msg.type === "agent:runtime:outcome").length, 0, "persist-then-send: an E1 that is not on disk is never sent through the outbox");
  assert.equal(existsSync(path.join(dir, `${AGENT}.json`)), false);
  assert.deepEqual(outbox.state(AGENT).entries, [], "the queue did not advance");
}));

/** An fs whose writes fail while `failing.on` is true (every durable-write step can be targeted). */
function switchableFs(step: keyof OutboxFs = "writeTempAndSync", match: (target: string) => boolean = () => true) {
  const failing = { on: false };
  const fs: OutboxFs = {
    writeTempAndSync: (temp, data) => {
      if (failing.on && step === "writeTempAndSync" && match(temp)) throw new Error("EIO");
      nodeOutboxFs.writeTempAndSync(temp, data);
    },
    rename: (from, to) => {
      if (failing.on && step === "rename" && match(to)) throw new Error("EIO");
      nodeOutboxFs.rename(from, to);
    },
    syncDir: (d) => {
      if (failing.on && step === "syncDir") throw new Error("EIO");
      nodeOutboxFs.syncDir(d);
    },
  };
  return { fs, failing };
}

const isStateFile = (target: string) => path.basename(target).startsWith(`${AGENT}.json`);

test("RFC 071 outbox (persist-then-send): a failed persist sends no evidence frame, does not advance the queue (append, fold, ack), and takes the unreliable path", withDir((dir) => {
  for (const step of ["writeTempAndSync", "rename", "syncDir"] as const) {
    rmSync(dir, { recursive: true, force: true });
    const { fs, failing } = switchableFs(step, isStateFile);
    const { outbox, sent } = makeOutbox(dir, { fs });
    outbox.onServerContext(true);
    for (let seq = 1; seq <= OUTBOX_NORMAL_CAP; seq += 1) outbox.enqueue(e1(seq));
    assert.deepEqual(sent.map(seqOf), ["d1:1"]);
    const before = JSON.stringify(outbox.state(AGENT));

    failing.on = true;
    // Append: the queue is full, so this would fold the oldest foldable E1 into a gap.
    outbox.enqueue(exited(500));
    assert.equal(JSON.stringify(outbox.state(AGENT)), before, `${step}: a failed append+fold leaves the queue unchanged`);
    // Ack: deleting the in-flight entry must not happen in memory either, nor may the next entry go out.
    outbox.ack({ agentId: AGENT, daemonInstanceId: "d1", clientSeq: 1 });
    assert.equal(JSON.stringify(outbox.state(AGENT)), before, `${step}: a failed ack deletion leaves the queue unchanged`);
    const evidence = sent.filter((msg) => msg.type !== "agent:runtime:outcome_unreliable");
    assert.deepEqual(evidence.map(seqOf), ["d1:1"], `${step}: nothing beyond the first persisted frame was sent`);
    assert.equal(outbox.isUnreliable(AGENT), true, `${step}: unreliable`);
    assert.equal(outbox.refusesAutomaticStart(AGENT), true, `${step}: automatic starts refused`);
    assert.equal(sent.filter((msg) => msg.type === "agent:runtime:outcome_unreliable").length, 1, `${step}: one best-effort notice`);

    // Storage heals: the server's redelivered ack now deletes the entry and the next goes out.
    failing.on = false;
    outbox.ack({ agentId: AGENT, daemonInstanceId: "d1", clientSeq: 1 });
    assert.deepEqual(sent.filter((msg) => msg.type !== "agent:runtime:outcome_unreliable").map(seqOf), ["d1:1", "d1:2"]);
    assert.ok(!onDisk(dir).entries.some((entry) => entry.t === "normal" && entry.clientSeq === 500), `${step}: the unpersisted frame never reached the queue`);
  }
}));

test("RFC 071 outbox (persist-then-send): the first send of an entry waits until its in-flight state is durable", withDir((dir) => {
  const { fs, failing } = switchableFs("writeTempAndSync", isStateFile);
  const { outbox, sent } = makeOutbox(dir, { fs });
  outbox.enqueue(e1(1)); // queued while disconnected
  failing.on = true;
  outbox.onServerContext(true);
  assert.equal(sent.filter((msg) => msg.type === "agent:runtime:outcome").length, 0, "not sent: marking it in flight did not persist");
  assert.equal(outbox.state(AGENT).inFlight, false);
  assert.equal(outbox.isUnreliable(AGENT), true);
}));

test("RFC 071 outbox (11): an unsupported server gets nothing; what was queued (here while the capability was unknown) is kept and delivery resumes from the oldest entry", withDir((dir) => {
  const { outbox, sent } = makeOutbox(dir);
  outbox.enqueue(e1(1));
  outbox.enqueue(exited(2));
  outbox.onServerContext(false);
  assert.equal(sent.length, 0);
  assert.equal(onDisk(dir).entries.length, 2, "queue kept on disk");
  outbox.onServerContext(true);
  assert.deepEqual(sent.map(seqOf), ["d1:1"]);
  outbox.ack(ackFor(sent[0]!));
  assert.deepEqual(sent.map(seqOf), ["d1:1", "d1:2"]);
}));

test("RFC 071 outbox (amendment 2, marker reserve): with plenty of entry room, a start is still refused when this instance has no gap slot left for the new epoch", withDir((dir) => {
  const { outbox, sent } = makeOutbox(dir);
  for (let seq = 1; seq <= OUTBOX_NORMAL_CAP + 1; seq += 1) outbox.enqueue(e1(seq));
  outbox.onServerContext(true); // the epoch-0 gap goes in flight (sealed); its ack is lost
  assert.equal(sent[0]?.type, "agent:runtime:outcome_gap");
  for (let seq = 1000; seq < 1010; seq += 1) outbox.enqueue(e1(seq)); // a second, open epoch-0 gap
  assert.equal(outbox.state(AGENT).entries.filter((entry) => entry.t === "gap").length, 2);
  // The server acknowledges most normal entries, so entry room is not the limit.
  for (let seq = 2; seq <= 120; seq += 1) outbox.ack({ agentId: AGENT, daemonInstanceId: "d1", clientSeq: seq });
  assert.ok(outbox.state(AGENT).entries.filter((entry) => entry.t === "normal").length < 40);
  assert.equal(outbox.admitStart(AGENT, 1), false, "both gap slots of this instance hold epoch-0 evidence");
  const gaps = outbox.state(AGENT).entries.filter((entry) => entry.t === "gap");
  assert.ok(gaps.every((gap) => gap.t === "gap" && gap.takeoverEpoch === 0 && gap.sealed), "old evidence retained and sealed");
  outbox.ack(ackFor(sent[0]!)); // the in-flight gap's ack finally arrives
  assert.equal(outbox.admitStart(AGENT, 1), true);
}));

// --- Durable unreliable state (review blocker 2) --------------------------

function markerPath(dir: string): string {
  return path.join(dir, `${AGENT}@unreliable.json`);
}

function makeTracingOutbox(dir: string, options: { instance?: string; fs?: OutboxFs } = {}) {
  const sent: MachineToServerMessage[] = [];
  const traces: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const outbox = new RuntimeOutcomeOutbox({
    dir, daemonInstanceId: options.instance ?? "d1", send: (msg) => sent.push(msg), fs: options.fs,
    trace: (name, attrs) => traces.push({ name, attrs }),
  });
  return { outbox, sent, traces };
}

test("RFC 071 outbox (unreliable survives restart): corrupt file -> load -> a NEW outbox -> load again is still unreliable, and an automatic start is refused", withDir((dir) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${AGENT}.json`), "{not json");
  const first = makeOutbox(dir);
  first.outbox.load();
  assert.equal(first.outbox.isUnreliable(AGENT), true);

  const second = makeOutbox(dir, { instance: "d2" });
  second.outbox.load();
  assert.equal(second.outbox.isUnreliable(AGENT), true, "the second load still sees the loss");
  assert.deepEqual(second.outbox.unreliableAgents(), [AGENT]);
  second.outbox.onServerContext(true);
  assert.equal(second.outbox.decideStart(AGENT, { humanStart: false, launchId: "auto-1" }), "terminal_failure_needs_manual");
  assert.equal(second.outbox.isUnreliable(AGENT), true, "an automatic start never clears it");

  // Even without the marker (e.g. written by an older build), an unresolved corrupt file alone is unreliable.
  rmSync(markerPath(dir), { force: true });
  const third = makeOutbox(dir, { instance: "d3" });
  third.outbox.load();
  assert.equal(third.outbox.isUnreliable(AGENT), true, "a renamed-aside corrupt file without a resolution record is unreliable");
  assert.equal(existsSync(markerPath(dir)), true, "and the marker is rewritten");
}));

test("RFC 071 outbox (unreliable survives restart): a failed queue write leaves a durable marker; after a restart the agent is unreliable and automatic starts are refused", withDir((dir) => {
  const { fs, failing } = switchableFs("writeTempAndSync", isStateFile);
  const first = makeOutbox(dir, { instance: "d-old", fs });
  first.outbox.enqueue(e1(1, "d-old"));
  failing.on = true;
  first.outbox.enqueue(exited(2, "d-old"));
  assert.equal(first.outbox.isUnreliable(AGENT), true);
  const marker = JSON.parse(readFileSync(markerPath(dir), "utf8")) as Record<string, unknown>;
  assert.equal(marker.agentId, AGENT);
  assert.equal(marker.cause, "write_failed");
  assert.equal(marker.daemonInstanceId, "d-old");
  assert.equal(typeof marker.since, "number");

  const second = makeOutbox(dir, { instance: "d-new" });
  second.outbox.load();
  assert.equal(second.outbox.isUnreliable(AGENT), true);
  second.outbox.onServerContext(true);
  assert.equal(second.outbox.decideStart(AGENT, { humanStart: false, launchId: "auto-1" }), "terminal_failure_needs_manual");
  assert.equal(second.outbox.decideStart(AGENT, {}), "terminal_failure_needs_manual", "no humanStart flag = automatic");
  assert.equal(existsSync(markerPath(dir)), true, "automatic starts leave the marker in place");
}));

test("RFC 071 outbox (unreliable, known evidence lost): a fail-closed no_room drop writes the durable marker", withDir((dir) => {
  const { outbox } = makeOutbox(dir);
  for (let seq = 1; seq <= OUTBOX_NORMAL_CAP; seq += 1) outbox.enqueue(e1(seq));
  // A newer epoch makes every held entry unfoldable; the next critical frame has no room.
  assert.equal(outbox.admitStart(AGENT, 1), false);
  outbox.enqueue(e1(999));
  assert.equal(outbox.isUnreliable(AGENT), true);
  assert.equal((JSON.parse(readFileSync(markerPath(dir), "utf8")) as { cause: string }).cause, "no_room");
  const restarted = makeOutbox(dir);
  restarted.outbox.load();
  assert.equal(restarted.outbox.isUnreliable(AGENT), true);
}));

test("RFC 071 outbox (unreliable recovery): an admitted human start durably clears it (resolution record, marker removed, corrupt file archived not deleted); it stays clear after a restart", withDir((dir) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${AGENT}.json`), "{not json");
  const first = makeOutbox(dir);
  first.outbox.load();
  const restarted = makeTracingOutbox(dir, { instance: "d2" });
  restarted.outbox.load();
  restarted.outbox.onServerContext(true);
  assert.equal(restarted.outbox.decideStart(AGENT, { humanStart: true, launchId: "human-1" }), null, "the human start is admitted");
  assert.equal(restarted.outbox.isUnreliable(AGENT), false);
  assert.equal(restarted.outbox.refusesAutomaticStart(AGENT), false);
  assert.equal(existsSync(markerPath(dir)), false, "marker removed");
  const resolution = JSON.parse(readFileSync(path.join(dir, `${AGENT}@resolution.json`), "utf8")) as Record<string, unknown>;
  assert.equal(resolution.launchId, "human-1");
  assert.equal(resolution.daemonInstanceId, "d2");
  const archived = readdirSync(dir).filter((name) => name.startsWith(`${AGENT}.json.corrupt-`));
  assert.equal(archived.length, 1);
  assert.ok(archived[0]!.endsWith("@resolved"), "the corrupt file is archived, not deleted");
  assert.equal(readFileSync(path.join(dir, archived[0]!), "utf8"), "{not json");
  assert.ok(restarted.traces.some((trace) => trace.name === "daemon.runtime_outcome_outbox.unreliable_resolved"));
  settle(restarted.outbox, "human-1", 50, "d2");

  const again = makeOutbox(dir, { instance: "d3" });
  again.outbox.load();
  assert.equal(again.outbox.isUnreliable(AGENT), false, "cleared durably");
}));

test("RFC 071 outbox (unreliable recovery): a crash after the resolution record but before the marker is removed stays resolved", withDir((dir) => {
  const { fs, failing } = switchableFs("writeTempAndSync", isStateFile);
  const first = makeOutbox(dir, { fs });
  failing.on = true;
  first.outbox.enqueue(e1(1));
  const markerText = readFileSync(markerPath(dir), "utf8");
  first.outbox.onServerContext(true);
  assert.equal(first.outbox.decideStart(AGENT, { humanStart: true, launchId: "human-1" }), null);
  failing.on = false;
  settle(first.outbox, "human-1", 50);
  failing.on = true;
  // Simulate the crash window: the marker is back, the resolution record names it.
  writeFileSync(markerPath(dir), markerText);
  const restarted = makeOutbox(dir);
  restarted.outbox.load();
  assert.equal(restarted.outbox.isUnreliable(AGENT), false);
  assert.equal(existsSync(markerPath(dir)), false, "the interrupted removal is finished");
  // A NEW loss after that resolution is not covered by it.
  const later = makeOutbox(dir, { fs });
  later.outbox.load();
  later.outbox.enqueue(e1(2));
  const again = makeOutbox(dir);
  again.outbox.load();
  assert.equal(again.outbox.isUnreliable(AGENT), true);
}));

test("RFC 071 outbox (unreliable, marker unwritable): stays unreliable in memory, refuses automatic starts, reports it, and a human start that cannot write its resolution is refused storage_blocked", withDir((dir) => {
  const failing: OutboxFs = { ...nodeOutboxFs, writeTempAndSync: () => { throw new Error("ENOSPC"); } };
  const { outbox, sent, traces } = makeTracingOutbox(dir, { fs: failing });
  outbox.onServerContext(true);
  outbox.enqueue(e1(1));
  assert.equal(existsSync(markerPath(dir)), false);
  assert.equal(outbox.isUnreliable(AGENT), true);
  assert.deepEqual(outbox.unreliableAgents(), [AGENT]);
  assert.ok(traces.some((trace) => trace.name === "daemon.runtime_outcome_outbox.unreliable_marker_write_failed"), "reported");
  assert.ok(sent.some((msg) => msg.type === "agent:runtime:outcome_unreliable"));
  assert.equal(outbox.decideStart(AGENT, { humanStart: false }), "terminal_failure_needs_manual");
  assert.equal(outbox.decideStart(AGENT, { humanStart: true, launchId: "human-1" }), "terminal_failure_outcome_storage_blocked",
    "a failed recovery is never an admitted start");
  assert.equal(outbox.isUnreliable(AGENT), true, "and without a durable resolution it is never reported reliable");
}));

test("RFC 071 outbox (recovery must be durable): all writes fail -> a human start with an unchanged or missing epoch is refused storage_blocked and the agent stays unreliable; once storage heals the same human start is admitted and clears it", withDir((dir) => {
  const { fs, failing } = switchableFs("writeTempAndSync");
  const { outbox } = makeOutbox(dir, { fs });
  outbox.onServerContext(true);
  failing.on = true;
  outbox.enqueue(e1(1));
  assert.equal(outbox.isUnreliable(AGENT), true);
  // Epoch unchanged (0) or missing: admission itself would write nothing.
  assert.equal(outbox.decideStart(AGENT, { humanStart: true, launchId: "h-0", takeoverEpoch: 0 }), "terminal_failure_outcome_storage_blocked");
  assert.equal(outbox.decideStart(AGENT, { humanStart: true, launchId: "h-missing" }), "terminal_failure_outcome_storage_blocked");
  assert.equal(outbox.isUnreliable(AGENT), true);
  failing.on = false;
  assert.equal(outbox.decideStart(AGENT, { humanStart: true, launchId: "h-ok" }), null, "admitted");
  assert.equal(outbox.isUnreliable(AGENT), false, "cleared");
  settle(outbox, "h-ok", 50);
  const restarted = makeOutbox(dir);
  restarted.outbox.load();
  assert.equal(restarted.outbox.isUnreliable(AGENT), false, "cleared durably");
}));

test("RFC 071 outbox (recovery must be durable, isolated): only the resolution record fails -> the human start (epoch unchanged or missing) is refused storage_blocked, still unreliable, and its open request is dropped", withDir((dir) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${AGENT}.json`), "{not json");
  const { fs, ctl } = predicateFs();
  const { outbox } = makeOutbox(dir, { fs });
  outbox.load();
  outbox.onServerContext(true);
  assert.equal(outbox.isUnreliable(AGENT), true);
  ctl.fail = (target) => path.basename(target).includes("@resolution");
  assert.equal(outbox.decideStart(AGENT, { humanStart: true, launchId: "h-0", takeoverEpoch: 0 }), "terminal_failure_outcome_storage_blocked");
  assert.equal(outbox.decideStart(AGENT, { humanStart: true, launchId: "h-missing" }), "terminal_failure_outcome_storage_blocked");
  assert.equal(outbox.isUnreliable(AGENT), true);
  assert.deepEqual(openOnDisk(dir).requests, [], "the refused starts leave no open request");
  ctl.fail = () => false;
  assert.equal(outbox.decideStart(AGENT, { humanStart: true, launchId: "h-ok" }), null);
  assert.equal(outbox.isUnreliable(AGENT), false);
}));

// --- Bounded retransmission while online (review item 3) ------------------

function makeTimedOutbox(dir: string, random = () => 0) {
  const sent: MachineToServerMessage[] = [];
  const outbox = new RuntimeOutcomeOutbox({ dir, daemonInstanceId: "d1", send: (msg) => sent.push(msg), random });
  return { outbox, sent };
}

function withFakeTimers(fn: (dir: string) => void) {
  return withDir((dir) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fn(dir);
    } finally {
      vi.useRealTimers();
    }
  });
}

test("RFC 071 outbox (retransmit): an ack lost while connected -> the SAME identity is resent after the timeout; still one in flight", withFakeTimers((dir) => {
  const { outbox, sent } = makeTimedOutbox(dir);
  outbox.onServerContext(true);
  outbox.enqueue(e1(1));
  outbox.enqueue(exited(2));
  assert.deepEqual(sent.map(seqOf), ["d1:1"]);
  vi.advanceTimersByTime(OUTBOX_RETRANSMIT_BASE_MS - 1);
  assert.equal(sent.length, 1, "not before the timeout");
  vi.advanceTimersByTime(1);
  assert.deepEqual(sent.map(seqOf), ["d1:1", "d1:1"], "resent, and only the in-flight entry");
  assert.deepEqual(sent[1], sent[0], "same frame, same (daemonInstanceId, clientSeq)");
}));

test("RFC 071 outbox (retransmit): an in-flight marker is resent with the same gapId", withFakeTimers((dir) => {
  const { outbox, sent } = makeTimedOutbox(dir);
  for (let seq = 1; seq <= OUTBOX_NORMAL_CAP + 1; seq += 1) outbox.enqueue(e1(seq));
  outbox.onServerContext(true);
  assert.equal(sent[0]?.type, "agent:runtime:outcome_gap");
  vi.advanceTimersByTime(OUTBOX_RETRANSMIT_BASE_MS);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0]);
}));

test("RFC 071 outbox (retransmit): the backoff doubles from 5s and caps at 5 min, unlimited attempts; jitter only shortens within 20%", withFakeTimers((dir) => {
  const { outbox, sent } = makeTimedOutbox(dir);
  outbox.onServerContext(true);
  outbox.enqueue(e1(1));
  const gaps: number[] = [];
  let now = 0;
  let last = 0;
  for (let tick = 0; tick < 3000 && sent.length < 12; tick += 1) {
    const before = sent.length;
    vi.advanceTimersByTime(1000);
    now += 1000;
    if (sent.length > before) {
      gaps.push(now - last);
      last = now;
    }
  }
  assert.deepEqual(gaps, [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000, 300000, 300000]);
  assert.equal(OUTBOX_RETRANSMIT_MAX_MS, 300_000);
  assert.ok(new Set(sent.map(seqOf)).size === 1, "every resend is the same identity");

  assert.equal(retransmitDelayMs(0, () => 0.5), 4500);
  assert.equal(retransmitDelayMs(40, () => 0.999999), Math.round(300_000 * (1 - 0.2 * 0.999999)));
  assert.equal(retransmitDelayMs(40, () => 0), 300_000);
}));

test("RFC 071 outbox (retransmit): a late ack for an earlier send deletes the entry exactly once; a duplicate ack is a no-op; the next entry starts at the base timeout", withFakeTimers((dir) => {
  const { outbox, sent } = makeTimedOutbox(dir);
  outbox.onServerContext(true);
  outbox.enqueue(e1(1));
  outbox.enqueue(exited(2));
  vi.advanceTimersByTime(OUTBOX_RETRANSMIT_BASE_MS + OUTBOX_RETRANSMIT_BASE_MS * 2);
  assert.deepEqual(sent.map(seqOf), ["d1:1", "d1:1", "d1:1"]);
  outbox.ack(ackFor(sent[0]!)); // the ack of the FIRST send arrives late
  assert.deepEqual(outbox.state(AGENT).entries.map((entry) => entry.t === "normal" ? entry.clientSeq : -1), [2]);
  assert.deepEqual(sent.map(seqOf), ["d1:1", "d1:1", "d1:1", "d1:2"]);
  outbox.ack(ackFor(sent[1]!)); // acks of the resends: no-ops
  outbox.ack(ackFor(sent[2]!));
  assert.deepEqual(outbox.state(AGENT).entries.map((entry) => entry.t === "normal" ? entry.clientSeq : -1), [2], "entry 2 untouched");
  assert.equal(sent.length, 4, "a duplicate ack sends nothing");
  vi.advanceTimersByTime(OUTBOX_RETRANSMIT_BASE_MS);
  assert.deepEqual(sent.map(seqOf).slice(4), ["d1:2"], "backoff was reset for the next entry");
  outbox.ack(ackFor(sent[3]!));
  outbox.ack(ackFor(sent[3]!));
  assert.deepEqual(outbox.state(AGENT).entries, []);
  vi.advanceTimersByTime(OUTBOX_RETRANSMIT_MAX_MS * 2);
  assert.equal(sent.length, 5, "nothing left to resend");
}));

test("RFC 071 outbox (retransmit): disconnected sends nothing; a reconnect resends at once and resets the backoff", withFakeTimers((dir) => {
  const { outbox, sent } = makeTimedOutbox(dir);
  outbox.onServerContext(true);
  outbox.enqueue(e1(1));
  vi.advanceTimersByTime(5000 + 10000 + 20000);
  assert.equal(sent.length, 4);
  outbox.onDisconnected();
  vi.advanceTimersByTime(OUTBOX_RETRANSMIT_MAX_MS * 3);
  assert.equal(sent.length, 4, "no resend while disconnected");
  outbox.onServerContext(true);
  assert.equal(sent.length, 5, "resent immediately on reconnect");
  vi.advanceTimersByTime(OUTBOX_RETRANSMIT_BASE_MS);
  assert.equal(sent.length, 6, "backoff restarted at the base");
  outbox.onServerContext(false); // an older server: paused
  vi.advanceTimersByTime(OUTBOX_RETRANSMIT_MAX_MS * 3);
  assert.equal(sent.length, 6);
  outbox.stop();
}));

// --- Open-launch record (review of #8688, blocker 2) ----------------------

function openLaunchesPath(dir: string): string {
  return path.join(dir, `${AGENT}@open-launches.json`);
}

function openOnDisk(dir: string): { requests: Array<{ launchId: string }>; processes: Array<{ processInstanceId: string }> } {
  return JSON.parse(readFileSync(openLaunchesPath(dir), "utf8"));
}

/** An fs that fails every durable-write step whose target matches `ctl.fail`. */
function predicateFs() {
  const ctl = { fail: (_target: string) => false };
  const fs: OutboxFs = {
    writeTempAndSync: (temp, data) => {
      if (ctl.fail(temp)) throw new Error("EIO");
      nodeOutboxFs.writeTempAndSync(temp, data);
    },
    rename: (from, to) => {
      if (ctl.fail(to)) throw new Error("EIO");
      nodeOutboxFs.rename(from, to);
    },
    syncDir: (d) => nodeOutboxFs.syncDir(d),
  };
  return { fs, ctl };
}
const all = () => true;
const isOpenFile = (target: string) => path.basename(target).includes("@open-launches");
const isQueueFile = (target: string) => path.basename(target).startsWith(`${AGENT}.json`);

/** One admitted automatic launch whose process is running: request recorded, process opened before the spawn, spawned frame stored. */
function runningLaunch(outbox: RuntimeOutcomeOutbox, seq: number) {
  assert.equal(outbox.decideStart(AGENT, { launchId: `launch-${seq}` }), null);
  assert.equal(outbox.openProcess(AGENT, `p-${seq}`, `launch-${seq}`), true);
  outbox.enqueue(spawned(seq));
}

test("RFC 071 outbox (open launches, negative control): the result frame AND the marker writes fail, then an immediate restart -> automatic starts are still refused", withDir((dir) => {
  const { fs, ctl } = predicateFs();
  const { outbox } = makeOutbox(dir, { fs });
  outbox.onServerContext(true);
  runningLaunch(outbox, 1);
  ctl.fail = all; // the disk dies: the E1 and the unreliable marker both fail
  outbox.enqueue(e1(2));
  outbox.enqueue(exited(1));
  assert.equal(existsSync(markerPath(dir)), false, "no marker could be written");
  // Immediate restart (the in-memory state is gone).
  const restarted = makeOutbox(dir, { instance: "d2" });
  restarted.outbox.load();
  restarted.outbox.onServerContext(true);
  assert.equal(restarted.outbox.isUnreliable(AGENT), true, "the open launch has no durably stored terminal frame: outcome unknown");
  assert.equal(restarted.outbox.decideStart(AGENT, { launchId: "auto-after" }), "terminal_failure_needs_manual");
  assert.ok(restarted.sent.some((msg) => msg.type === "agent:runtime:outcome_unreliable"), "best-effort notice");
  // Cleared only by a durable human resolution.
  assert.equal(restarted.outbox.decideStart(AGENT, { humanStart: true, launchId: "human" }), null);
  assert.equal(restarted.outbox.isUnreliable(AGENT), false);
  assert.deepEqual(openOnDisk(dir).processes, [], "the stale process entry is resolved");
  settle(restarted.outbox, "human", 50, "d2");
  const again = makeOutbox(dir, { instance: "d3" });
  again.outbox.load();
  assert.equal(again.outbox.isUnreliable(AGENT), false);
}));

test("RFC 071 outbox (open launches): a normal stop (exit stored) then a restart is not unreliable", withDir((dir) => {
  const { outbox } = makeOutbox(dir);
  outbox.onServerContext(true);
  runningLaunch(outbox, 1);
  outbox.enqueue({ ...exited(1), clientSeq: 2 } as OutboxFrame); // p-1's exit (each frame has its own clientSeq)
  assert.deepEqual(openOnDisk(dir), { ...openOnDisk(dir), requests: [], processes: [] });
  const restarted = makeOutbox(dir, { instance: "d2" });
  restarted.outbox.load();
  restarted.outbox.onServerContext(true);
  assert.equal(restarted.outbox.isUnreliable(AGENT), false);
  assert.equal(restarted.outbox.decideStart(AGENT, { launchId: "auto-2" }), null);
}));

test("RFC 071 outbox (open launches): a failed open-record write refuses the start storage_blocked (human too) and blocks the spawn", withDir((dir) => {
  const { fs, ctl } = predicateFs();
  const { outbox } = makeOutbox(dir, { fs });
  outbox.onServerContext(true);
  ctl.fail = isOpenFile;
  assert.equal(outbox.decideStart(AGENT, { launchId: "auto-1" }), "terminal_failure_outcome_storage_blocked");
  assert.equal(outbox.decideStart(AGENT, { humanStart: true, launchId: "human-1" }), "terminal_failure_outcome_storage_blocked");
  assert.equal(outbox.openProcess(AGENT, "p-1", "launch-1"), false, "an internal (re)spawn does not happen");
  assert.equal(outbox.isUnreliable(AGENT), true);
  assert.equal(outbox.decideStart(AGENT, { launchId: "auto-2" }), "terminal_failure_needs_manual");
}));

test("RFC 071 outbox (open launches): not_spawned clears only its request; spawned and rebound keep the process open; only the stored exit clears the process", withDir((dir) => {
  const { outbox } = makeOutbox(dir);
  outbox.onServerContext(true);
  runningLaunch(outbox, 1);
  assert.deepEqual(openOnDisk(dir).requests, [], "the spawned launch's request has its result");
  assert.deepEqual(openOnDisk(dir).processes.map((entry) => entry.processInstanceId), ["p-1"], "spawned does not clear the running process");
  assert.equal(outbox.decideStart(AGENT, { launchId: "launch-2" }), null);
  assert.equal(outbox.decideStart(AGENT, { launchId: "launch-3" }), null);
  assert.deepEqual(openOnDisk(dir).requests.map((entry) => entry.launchId), ["launch-2", "launch-3"]);
  outbox.enqueue(startOutcome(2)); // not_spawned for launch-2
  assert.deepEqual(openOnDisk(dir).requests.map((entry) => entry.launchId), ["launch-3"], "not_spawned clears only launch-2");
  assert.equal(outbox.openProcess(AGENT, "p-1", "launch-3"), true, "a rebind reuses the open process");
  outbox.enqueue({ type: "agent:start:outcome", agentId: AGENT, daemonInstanceId: "d1", launchId: "launch-3", clientSeq: 3, result: { kind: "rebound", processInstanceId: "p-1" } });
  assert.deepEqual(openOnDisk(dir).requests, []);
  assert.deepEqual(openOnDisk(dir).processes.map((entry) => entry.processInstanceId), ["p-1"], "rebound does not clear the running process");
  outbox.enqueue(exited(1));
  assert.deepEqual(openOnDisk(dir).processes, [], "the stored exit clears it, durably");
}));

test("RFC 071 outbox (open launches): a stored exit does not wash away lost evidence", withDir((dir) => {
  // (a) The E1 is lost but the marker is durable: the exit clears the process entry, the marker keeps it unreliable.
  const first = predicateFs();
  const a = makeOutbox(dir, { fs: first.fs });
  a.outbox.onServerContext(true);
  runningLaunch(a.outbox, 1);
  first.ctl.fail = isQueueFile;
  a.outbox.enqueue(e1(2));
  first.ctl.fail = () => false;
  a.outbox.enqueue(exited(1));
  const ra = makeOutbox(dir, { instance: "d2" });
  ra.outbox.load();
  assert.equal(ra.outbox.isUnreliable(AGENT), true);
  rmSync(dir, { recursive: true, force: true });

  // (b) The E1 AND the marker are lost, then the exit is stored: the process entry must stay open (the marker is not durable).
  const second = predicateFs();
  const b = makeOutbox(dir, { fs: second.fs });
  b.outbox.onServerContext(true);
  runningLaunch(b.outbox, 1);
  second.ctl.fail = (target) => isQueueFile(target) || path.basename(target).includes("@unreliable");
  b.outbox.enqueue(e1(2));
  second.ctl.fail = (target) => path.basename(target).includes("@unreliable");
  b.outbox.enqueue(exited(1));
  assert.ok(b.outbox.state(AGENT).entries.some((entry) => entry.t === "normal" && entry.kind === "exited"), "the exit itself is stored");
  assert.deepEqual(openOnDisk(dir).processes.map((entry) => entry.processInstanceId), ["p-1"], "kept open: the loss is not durable anywhere else");
  const rb = makeOutbox(dir, { instance: "d2" });
  rb.outbox.load();
  assert.equal(rb.outbox.isUnreliable(AGENT), true);
}));

test("RFC 071 outbox (open launches, crash points): exit stored but the open entry not yet removed -> conservative; exit not stored -> entry kept", withDir((dir) => {
  const { fs, ctl } = predicateFs();
  const { outbox } = makeOutbox(dir, { fs });
  outbox.onServerContext(true);
  runningLaunch(outbox, 1);
  runningLaunch(outbox, 2);
  // Step 1 fails: the exit is not stored, so the entry must not be removed.
  ctl.fail = isQueueFile;
  outbox.enqueue(exited(1));
  assert.deepEqual(openOnDisk(dir).processes.map((entry) => entry.processInstanceId), ["p-1", "p-2"]);
  // Crash between step 1 (exit stored) and step 2 (entry removed).
  ctl.fail = isOpenFile;
  outbox.enqueue(exited(2));
  assert.ok(onDisk(dir).entries.some((entry) => entry.t === "normal" && entry.kind === "exited" && entry.clientSeq === 2));
  assert.ok(openOnDisk(dir).processes.some((entry) => entry.processInstanceId === "p-2"));
  const restarted = makeOutbox(dir, { instance: "d2" });
  restarted.outbox.load();
  assert.equal(restarted.outbox.isUnreliable(AGENT), true, "never falsely clean");
}));

test("RFC 071 outbox (open launches, crash points): resolution record first; a crash after it is resolved on the next load; a failed record keeps everything", withDir((dir) => {
  const { fs, ctl } = predicateFs();
  const { outbox } = makeOutbox(dir, { fs });
  outbox.onServerContext(true);
  runningLaunch(outbox, 1);
  // Hard crash while running: a new instance loads the open process.
  const second = predicateFs();
  const r1 = makeOutbox(dir, { instance: "d2", fs: second.fs });
  r1.outbox.load();
  r1.outbox.onServerContext(true);
  assert.equal(r1.outbox.isUnreliable(AGENT), true);
  const markerBefore = readFileSync(markerPath(dir), "utf8");
  const openBefore = readFileSync(openLaunchesPath(dir), "utf8");
  // The resolution record cannot be written: refused, nothing cleared.
  second.ctl.fail = (target) => path.basename(target).includes("@resolution");
  assert.equal(r1.outbox.decideStart(AGENT, { humanStart: true, launchId: "h-1" }), "terminal_failure_outcome_storage_blocked");
  assert.equal(readFileSync(markerPath(dir), "utf8"), markerBefore);
  assert.ok(openOnDisk(dir).processes.some((entry) => entry.processInstanceId === "p-1"));
  const r2 = makeOutbox(dir, { instance: "d3" });
  r2.outbox.load();
  assert.equal(r2.outbox.isUnreliable(AGENT), true);
  // The resolution record is written; then a crash before the open entry and the marker are removed.
  second.ctl.fail = () => false;
  assert.equal(r1.outbox.decideStart(AGENT, { humanStart: true, launchId: "h-2" }), null);
  writeFileSync(markerPath(dir), markerBefore);
  writeFileSync(openLaunchesPath(dir), openBefore);
  const r3 = makeOutbox(dir, { instance: "d4" });
  r3.outbox.load();
  assert.equal(r3.outbox.isUnreliable(AGENT), false, "the durable resolution covers the marker and the open entry");
  assert.deepEqual(openOnDisk(dir).processes, [], "the interrupted removal is finished");
  void ctl;
}));

// --- Old servers: storage failures refuse locally, nothing strands the agent; internal starts are recorded ---

// Windows refuses fsync on a directory handle with EPERM (computer-v1.0.42
// field report: every agent start refused with storage_blocked). The file
// fsync + rename still make the write durable there; only the directory fsync
// is skipped, and only on win32.
const windowsDirFsyncEperm = () => {
  throw Object.assign(new Error("EPERM: operation not permitted, fsync"), { code: "EPERM" });
};

test("RFC 071 outbox (win32): the directory fsync Windows refuses does not fail the write or block the start", withDir((dir) => {
  const { outbox } = makeOutbox(dir, { fs: createNodeOutboxFs({ platform: "win32", syncDir: windowsDirFsyncEperm }) });
  outbox.onServerContext(false);
  assert.equal(outbox.decideStart(AGENT, { launchId: "auto-1" }), null, "the automatic start is admitted");
  assert.equal(outbox.openProcess(AGENT, "p-1", "launch-1"), true, "the process is recorded and spawns");
  assert.equal(outbox.isUnreliable(AGENT), false);
  assert.ok(readdirSync(dir).some((name) => name === `${encodeURIComponent(AGENT)}@open-launches.json`), "the open-process record is on disk");
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp-")), [], "no temp file is left behind");
}));

for (const failAt of ["writeTempAndSync", "rename"] as const) {
  test(`RFC 071 outbox (win32 control): a real ${failAt} failure on Windows still fails the write and refuses the spawn`, withDir((dir) => {
    const win32 = createNodeOutboxFs({ platform: "win32", syncDir: windowsDirFsyncEperm });
    const fs: OutboxFs = {
      ...win32,
      writeTempAndSync: (temp, data) => {
        if (failAt === "writeTempAndSync") throw Object.assign(new Error("EIO"), { code: "EIO" });
        win32.writeTempAndSync(temp, data);
      },
      rename: (from, to) => {
        if (failAt === "rename") throw Object.assign(new Error("EPERM: rename"), { code: "EPERM" });
        win32.rename(from, to);
      },
    };
    const { outbox } = makeOutbox(dir, { fs });
    outbox.onServerContext(false);
    assert.equal(outbox.openProcess(AGENT, "p-1", "launch-1"), false, `${failAt} failing on win32 is not skipped`);
    assert.equal(outbox.isUnreliable(AGENT), true);
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp-")), [], "no temp file is left behind");
  }));
}

test("RFC 071 outbox (win32 control): the temp file is written but its own fsync fails on Windows: the write still fails and the spawn is refused", withDir((dir) => {
  let written = false;
  const fs = createNodeOutboxFs({
    platform: "win32",
    syncDir: windowsDirFsyncEperm,
    fsyncFile: () => {
      written = true;
      throw Object.assign(new Error("EIO: fsync"), { code: "EIO" });
    },
  });
  const { outbox } = makeOutbox(dir, { fs });
  outbox.onServerContext(false);
  assert.equal(outbox.openProcess(AGENT, "p-1", "launch-1"), false, "a failed file fsync on win32 is not skipped");
  assert.equal(written, true, "the bytes reached the temp file before its fsync failed");
  assert.equal(outbox.isUnreliable(AGENT), true);
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp-")), [], "no temp file is left behind");
}));

test("RFC 071 outbox (posix control): a failing directory fsync off Windows still fails the write and refuses the spawn", withDir((dir) => {
  const { outbox } = makeOutbox(dir, { fs: createNodeOutboxFs({ platform: "linux", syncDir: windowsDirFsyncEperm }) });
  outbox.onServerContext(false);
  assert.equal(outbox.openProcess(AGENT, "p-1", "launch-1"), false, "durability is not relaxed on POSIX");
  assert.equal(outbox.isUnreliable(AGENT), true);
}));

test("RFC 071 outbox (old server): a failed open-process write refuses the spawn and the rebind and the agent is unreliable, yet later starts are not stranded; nothing RFC 071 is sent", withDir((dir) => {
  const { fs, ctl } = predicateFs();
  const { outbox, sent } = makeOutbox(dir, { fs });
  outbox.onServerContext(false); // a server without the ack capability
  // Positive control: healthy storage on the same old server admits the automatic start.
  assert.equal(outbox.decideStart(AGENT, { launchId: "auto-ok" }), null);
  ctl.fail = isOpenFile;
  assert.equal(outbox.openProcess(AGENT, "p-1", "launch-1"), false, "no spawn: the process could not be recorded");
  assert.equal(outbox.openProcess(AGENT, "p-2", null), false, "no internal spawn either");
  assert.equal(outbox.isUnreliable(AGENT), true);
  ctl.fail = () => false;
  assert.equal(outbox.decideStart(AGENT, { launchId: "auto-3" }), null, "no human start can come from an old server: the unreliable agent is not stranded");
  assert.deepEqual(sent.map((msg) => msg.type), [], "an old server gets no outbox frame and no outcome_unreliable notice");
  // A failed open-REQUEST write on the old server refuses the start too.
  const other = predicateFs();
  const otherDir = path.join(dir, "other");
  const second = makeOutbox(otherDir, { fs: other.fs });
  second.outbox.onServerContext(false);
  other.ctl.fail = isOpenFile;
  assert.equal(second.outbox.decideStart(AGENT, { launchId: "auto-req" }), "terminal_failure_outcome_storage_blocked");
  // The same disk means the same thing on an acking server.
  const restarted = makeOutbox(dir, { instance: "d2" });
  restarted.outbox.load();
  restarted.outbox.onServerContext(true);
  assert.equal(restarted.outbox.decideStart(AGENT, { launchId: "auto-4" }), "terminal_failure_needs_manual");
}));

test("RFC 071 outbox (old server): a gap of lost critical frames refuses on an acking server, not on an old one; it is kept", withDir((dir) => {
  const { outbox } = makeOutbox(dir);
  for (let seq = 1; seq <= OUTBOX_NORMAL_CAP + 1; seq += 1) outbox.enqueue(e1(seq));
  assert.ok(outbox.state(AGENT).entries.some((entry) => entry.t === "gap"));
  outbox.onServerContext(true);
  assert.equal(outbox.decideStart(AGENT, { launchId: "auto-acks" }), "terminal_failure_needs_manual");
  // The acking server takes every frame but the gap (so the old server below has room: this is about the gap).
  for (const entry of [...outbox.state(AGENT).entries]) {
    if (entry.t === "normal") outbox.ack({ agentId: AGENT, daemonInstanceId: entry.daemonInstanceId, clientSeq: entry.clientSeq });
  }
  outbox.onServerContext(false);
  assert.equal(outbox.decideStart(AGENT, { launchId: "auto-old" }), null, "no human start can come from an old server: not stranded");
  assert.ok(outbox.state(AGENT).entries.some((entry) => entry.t === "gap"), "the gap is kept for an acking server");
  outbox.stop();
}));

test("RFC 071 outbox (internal start, no launchId): the process is durably open, keyed by processInstanceId; its durable local exit clears it and a restart is clean", withDir((dir) => {
  const { outbox, sent } = makeOutbox(dir);
  outbox.onServerContext(true);
  assert.equal(outbox.openProcess(AGENT, "p-int", null), true);
  const open = openOnDisk(dir).processes as Array<{ processInstanceId: string; spawnLaunchId: string | null }>;
  assert.deepEqual(open.map((entry) => [entry.processInstanceId, entry.spawnLaunchId]), [["p-int", null]], "no server launchId is invented");
  // A hard crash now: the next instance finds it open -> unreliable.
  const crashed = makeOutbox(dir, { instance: "d-crash" });
  crashed.outbox.load();
  assert.equal(crashed.outbox.isUnreliable(AGENT), true, "restart with the entry still open -> unreliable");
  rmSync(markerPath(dir), { force: true }); // undo that probe's marker
  outbox.processExitedLocally(AGENT, "p-int");
  assert.deepEqual(openOnDisk(dir).processes, [], "the durable local exit clears it");
  assert.deepEqual(sent, [], "no process frame for an internal start");
  const restarted = makeOutbox(dir, { instance: "d2" });
  restarted.outbox.load();
  assert.equal(restarted.outbox.isUnreliable(AGENT), false);
}));

test("RFC 071 outbox (start failed before spawn): the process never reported spawned closes on processNotStarted, so a restart is clean; nothing else closes", withDir((dir) => {
  const { outbox } = makeOutbox(dir);
  outbox.onServerContext(false); // the field case: compat processes on an old server
  for (const launch of ["launch-1", "launch-2"]) {
    assert.equal(outbox.decideStart(AGENT, { launchId: launch }), null);
    assert.equal(outbox.openProcess(AGENT, `p-${launch}`, launch), true);
    settle(outbox, launch, launch === "launch-1" ? 1 : 2); // its start failed: not_spawned closes the request only
  }
  assert.deepEqual(openOnDisk(dir).requests, [], "the requests have their results");
  assert.deepEqual(openOnDisk(dir).processes.map((entry) => entry.processInstanceId), ["p-launch-1", "p-launch-2"], "the processes stay open on the result alone");
  outbox.processNotStarted(AGENT, "p-launch-1");
  outbox.processNotStarted(AGENT, "p-unknown");
  assert.deepEqual(openOnDisk(dir).processes.map((entry) => entry.processInstanceId), ["p-launch-2"], "only the named process closes");
  // Positive control: the one left open still reads as unknown after a restart.
  const crashed = makeOutbox(dir, { instance: "d-crash" });
  crashed.outbox.load();
  assert.equal(crashed.outbox.isUnreliable(AGENT), true, "an open entry left behind -> unreliable");
  rmSync(markerPath(dir), { force: true });
  outbox.processNotStarted(AGENT, "p-launch-2");
  assert.deepEqual(openOnDisk(dir).processes, []);
  const restarted = makeOutbox(dir, { instance: "d2" });
  restarted.outbox.load();
  assert.equal(restarted.outbox.isUnreliable(AGENT), false, "nothing left open: a restart is clean");
}));

test("RFC 071 outbox (internal start, no launchId): the exit is recorded before the entry is removed; crash points are never falsely clean; an uncorrelated exit clears nothing", withDir((dir) => {
  const { fs, ctl } = predicateFs();
  const { outbox } = makeOutbox(dir, { fs });
  outbox.onServerContext(true);
  runningLaunch(outbox, 1); // a server launch: only its stored process_exited may clear it
  assert.equal(outbox.openProcess(AGENT, "p-a", null), true);
  assert.equal(outbox.openProcess(AGENT, "p-b", null), true);
  outbox.processExitedLocally(AGENT, "p-1");
  outbox.processExitedLocally(AGENT, "p-unknown");
  assert.deepEqual(openOnDisk(dir).processes.map((entry) => entry.processInstanceId), ["p-1", "p-a", "p-b"], "uncorrelated exits clear nothing");
  // Step 1 (the exit record) fails: the entry stays open and the agent is unreliable.
  ctl.fail = isOpenFile;
  outbox.processExitedLocally(AGENT, "p-a");
  assert.equal(outbox.isUnreliable(AGENT), true);
  ctl.fail = () => false;
  const afterFailedRecord = openOnDisk(dir).processes as Array<{ processInstanceId: string; exitedAtMs?: number }>;
  assert.equal(afterFailedRecord.find((entry) => entry.processInstanceId === "p-a")!.exitedAtMs, undefined);
  // Crash between step 1 (exit recorded) and step 2 (entry removed): only the second write fails.
  let writes = 0;
  ctl.fail = (target) => isOpenFile(target) && target.includes(".tmp-") && ++writes > 1;
  outbox.processExitedLocally(AGENT, "p-b");
  ctl.fail = () => false;
  const recorded = openOnDisk(dir).processes as Array<{ processInstanceId: string; exitedAtMs?: number }>;
  assert.equal(typeof recorded.find((entry) => entry.processInstanceId === "p-b")!.exitedAtMs, "number", "the exit is durable in the record");
  const restarted = makeOutbox(dir, { instance: "d2" });
  restarted.outbox.load();
  const processes = restarted.outbox["openLaunches"].get(AGENT)!.processes.map((entry) => entry.processInstanceId);
  assert.ok(!processes.includes("p-b"), "a recorded exit is closed on load (interrupted removal finished)");
  assert.ok(processes.includes("p-a") && processes.includes("p-1"));
  assert.equal(restarted.outbox.isUnreliable(AGENT), true, "p-a / p-1 are still unknown");
}));

// --- Internal starts and rebound internal processes (review of #8688, round 3) ---

test("RFC 071 outbox (internal starts): the spawn / rebind gate refuses the daemon's own starts while the agent is unreliable; only an admitted human start clears it", withDir((dir) => {
  const { fs, ctl } = predicateFs();
  const { outbox } = makeOutbox(dir, { fs });
  outbox.onServerContext(true);
  assert.equal(outbox.startRefusal(AGENT), null, "positive control: a reliable agent may be restarted");
  ctl.fail = isQueueFile;
  outbox.enqueue(exited(1)); // the exit evidence cannot be stored
  ctl.fail = () => false;
  assert.equal(outbox.isUnreliable(AGENT), true);
  assert.equal(outbox.startRefusal(AGENT), AUTOMATIC_START_REFUSAL_TEXT);
  // Writing a new open record does not undo the missing evidence.
  assert.equal(outbox.openProcess(AGENT, "p-new", null), true);
  assert.notEqual(outbox.startRefusal(AGENT), null, "still refused");
  // An automatic server start does not clear it; a human start does.
  assert.equal(outbox.decideStart(AGENT, { launchId: "auto" }), "terminal_failure_needs_manual");
  assert.notEqual(outbox.startRefusal(AGENT), null);
  assert.equal(outbox.decideStart(AGENT, { launchId: "human", humanStart: true }), null);
  assert.equal(outbox.startRefusal(AGENT), null, "the admitted human start is the way out");
  outbox.stop();
}));

test("RFC 071 outbox (old server): an unreliable agent is not stranded where no human start can come; on an acking server it is refused with the way out, and the state is kept", withDir((dir) => {
  const { outbox } = makeOutbox(dir);
  const corrupt = path.join(dir, `${AGENT}.json`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(corrupt, "{not json");
  outbox.load();
  assert.equal(outbox.isUnreliable(AGENT), true, "corrupt on load");
  outbox.onServerContext(false);
  assert.equal(outbox.startRefusal(AGENT), null, "the old server never sends a human start: nothing is refused");
  assert.equal(outbox.decideStart(AGENT, { launchId: "auto-old" }), null, "the server's automatic start too");
  assert.equal(outbox.isUnreliable(AGENT), true, "the unreliable state is kept");
  outbox.onServerContext(true);
  assert.equal(outbox.startRefusal(AGENT), "Automatic start refused: runtime outcome evidence for this agent is incomplete; start it manually");
  outbox.stop();
}));

test("RFC 071 outbox (rebound internal process): a stored process_exited with spawnLaunchId null closes that process by identity, never another process or a request of its last launch", withDir((dir) => {
  const { outbox } = makeOutbox(dir);
  outbox.onServerContext(true);
  assert.equal(outbox.openProcess(AGENT, "p-internal", null), true);
  runningLaunch(outbox, 3); // P2 = p-3, spawned for launch-3
  assert.equal(outbox.decideStart(AGENT, { launchId: "launch-2" }), null); // an open request under the exit's last launch
  outbox.enqueue({
    type: "agent:process_exited", agentId: AGENT, daemonInstanceId: "d1", processInstanceId: "p-internal",
    spawnLaunchId: null, launchId: "launch-2", clientSeq: 50, code: 1, signal: null,
  });
  const open = openOnDisk(dir);
  assert.deepEqual(open.processes.map((entry) => entry.processInstanceId), ["p-3"], "only the exited process closes");
  assert.deepEqual(open.requests.map((entry) => entry.launchId), ["launch-2"], "a request is closed by its start result, not by an exit naming its launch");
  outbox.stop();
}));

// --- One automatic-start rule; human recovery bound to its launch; old-epoch gaps (review of #8688, round 6) ---

/** An acking server; an E1 folded into a gap marker (the rest acked, the gap never). */
function outboxWithGap(dir: string, fs?: OutboxFs) {
  const made = makeTracingOutbox(dir, { fs });
  made.outbox.onServerContext(true);
  const addGap = (firstSeq: number) => {
    for (let seq = firstSeq; seq <= firstSeq + OUTBOX_NORMAL_CAP; seq += 1) made.outbox.enqueue(e1(seq));
    for (const entry of [...made.outbox.state(AGENT).entries]) {
      if (entry.t === "normal") made.outbox.ack({ agentId: AGENT, daemonInstanceId: entry.daemonInstanceId, clientSeq: entry.clientSeq });
    }
  };
  addGap(1);
  const markers = () => made.outbox.state(AGENT).entries.filter((entry) => entry.t !== "normal").map((entry) => entry.takeoverEpoch);
  assert.deepEqual(markers(), [0], "precondition: one un-acked gap of epoch 0");
  return { ...made, addGap, markers };
}

test("RFC 071 outbox (one rule): the server's automatic starts and the spawn gate give the same answer; a critical gap blocks both on an acking server, not on an old one, and is kept", withDir((dir) => {
  const { outbox } = outboxWithGap(dir);
  assert.equal(outbox.startRefusal(AGENT), AUTOMATIC_START_REFUSAL_TEXT, "the gate refuses on the gap");
  assert.equal(outbox.refusesAutomaticStart(AGENT), true);
  assert.equal(outbox.decideStart(AGENT, { launchId: "auto-1" }), "terminal_failure_needs_manual", "the server's automatic start too");
  outbox.onServerContext(false);
  assert.equal(outbox.startRefusal(AGENT), null, "an old server never sends the human start that clears it: not refused");
  assert.equal(outbox.decideStart(AGENT, { launchId: "auto-2" }), null);
  outbox.onServerContext(true);
  assert.equal(outbox.startRefusal(AGENT), AUTOMATIC_START_REFUSAL_TEXT, "the kept gap refuses again under acks");
  outbox.onDisconnected();
  assert.notEqual(outbox.startRefusal(AGENT), null, "a disconnect does not relax it");
  outbox.stop();
}));

/** A queue file with one un-acked marker of the given counts (a state the fold path can reach only via turn_completed drops into an open gap). */
function outboxWithMarker(dir: string, marker: Record<string, unknown>) {
  mkdirSync(dir, { recursive: true });
  const counts = { e1: 0, turnCompleted: 0, spawned: 0, exited: 0, startOutcome: 0, ...(marker.counts as object) };
  writeFileSync(path.join(dir, `${AGENT}.json`), JSON.stringify({
    v: 1, agentId: AGENT, takeoverEpoch: 0, inFlight: false,
    entries: [{ gapId: "g-1", takeoverEpoch: 0, sealed: false, ...marker, counts }],
  }));
  const made = makeOutbox(dir);
  made.outbox.load();
  return made;
}

test("RFC 071 outbox (markers on an old server): no marker blocks there, backlog or lost critical evidence; every one is kept", withDir((dir) => {
  const backlog = outboxWithMarker(dir, { t: "gap", daemonInstanceId: "d1", fromSeq: 1, toSeq: 3, counts: { turnCompleted: 3 } });
  assert.notEqual(backlog.outbox.startRefusal(AGENT), null, "acking (or not yet known) server: blocks as before");
  backlog.outbox.onServerContext(false);
  assert.equal(backlog.outbox.startRefusal(AGENT), null, "positive control: backlog only, an old server never acks it");
  assert.equal(backlog.outbox.decideStart(AGENT, { launchId: "auto" }), null);
  backlog.outbox.stop();
  for (const [kind, marker] of [
    ["e1", { t: "gap", daemonInstanceId: "d1", fromSeq: 1, toSeq: 2, counts: { turnCompleted: 1, e1: 1 } }],
    ["spawned", { t: "gap", daemonInstanceId: "d1", fromSeq: 1, toSeq: 1, counts: { spawned: 1 } }],
    ["exited", { t: "gap", daemonInstanceId: "d1", fromSeq: 1, toSeq: 1, counts: { exited: 1 } }],
    ["startOutcome", { t: "gap", daemonInstanceId: "d1", fromSeq: 1, toSeq: 1, counts: { startOutcome: 1 } }],
    ["cross", { t: "cross", instances: ["d0", "d1"], counts: { turnCompleted: 2 } }],
  ] as const) {
    rmSync(dir, { recursive: true, force: true });
    const critical = outboxWithMarker(dir, marker);
    assert.notEqual(critical.outbox.startRefusal(AGENT), null, `${kind}: blocks before an old server is confirmed`);
    critical.outbox.onServerContext(false);
    assert.equal(critical.outbox.startRefusal(AGENT), null, `${kind}: not on an old server`);
    assert.equal(critical.outbox.decideStart(AGENT, { launchId: "auto" }), null, `${kind}: nor the server's automatic start`);
    assert.equal(critical.outbox.state(AGENT).entries.some((entry) => entry.t !== "normal"), true, `${kind}: the marker is kept`);
    critical.outbox.stop();
  }
}));

test("RFC 071 outbox (old-epoch gaps): a larger epoch on an automatic start exempts nothing; a human start whose resolution or takeover write fails exempts nothing (storage_blocked); a persisted takeover does, across a restart; the gap is kept", withDir((dir) => {
  const { fs, ctl } = predicateFs();
  const { outbox, markers } = outboxWithGap(dir, fs);
  const gapBlocks = () => blockingMarkers(outbox.state(AGENT)).length === 1;

  assert.equal(outbox.decideStart(AGENT, { launchId: "auto", takeoverEpoch: 5 }), "terminal_failure_needs_manual");
  assert.equal(outbox.state(AGENT).takeoverEpoch, 5, "the epoch was seen (and the gap sealed)");
  assert.ok(gapBlocks(), "a larger epoch merely seen exempts nothing");
  assert.notEqual(outbox.startRefusal(AGENT), null);

  // A human start whose takeover record cannot be written (the queue file).
  ctl.fail = isQueueFile;
  assert.equal(outbox.decideStart(AGENT, { launchId: "human-1", humanStart: true, takeoverEpoch: 6 }), "terminal_failure_outcome_storage_blocked");
  ctl.fail = () => false;
  assert.ok(gapBlocks(), "a takeover not persisted exempts nothing");
  assert.equal(outbox.state(AGENT).humanTakeoverEpoch, undefined);
  assert.equal(outbox.isUnreliable(AGENT), true, "and the failed write made the agent unreliable");

  // A human start whose resolution record cannot be written.
  ctl.fail = (target) => path.basename(target).startsWith(`${AGENT}@resolution.json`);
  assert.equal(outbox.decideStart(AGENT, { launchId: "human-2", humanStart: true, takeoverEpoch: 7 }), "terminal_failure_outcome_storage_blocked");
  ctl.fail = () => false;
  assert.ok(gapBlocks(), "a recovery not persisted exempts nothing");
  assert.equal(outbox.state(AGENT).humanTakeoverEpoch, undefined);

  // The admitted human start: resolution and takeover durable.
  assert.equal(outbox.decideStart(AGENT, { launchId: "human-3", humanStart: true, takeoverEpoch: 8 }), null);
  assert.equal(onDisk(dir).humanTakeoverEpoch, 8, "the takeover is on disk");
  assert.equal(blockingMarkers(outbox.state(AGENT)).length, 0, "the old gap no longer blocks");
  assert.equal(outbox.startRefusal(AGENT), null, "the daemon's own start may go on");
  assert.deepEqual(markers(), [0], "the gap itself is kept, un-acked");
  settle(outbox, "human-3", 20_000); // its start result is stored (else a restart finds it open: unknown)
  outbox.stop();

  const restarted = makeOutbox(dir, { instance: "d2" });
  restarted.outbox.load();
  restarted.outbox.onServerContext(true);
  assert.equal(restarted.outbox.startRefusal(AGENT), null, "the persisted takeover survives a restart");
  assert.deepEqual(onDisk(dir).entries.filter((entry) => entry.t !== "normal").map((entry) => entry.takeoverEpoch), [0], "still un-acked on disk");
  // A new gap in the taken-over epoch blocks again.
  for (let seq = 30_000; seq <= 30_000 + OUTBOX_NORMAL_CAP; seq += 1) restarted.outbox.enqueue(e1(seq, "d2"));
  const blocking = blockingMarkers(restarted.outbox.state(AGENT)).map((entry) => entry.takeoverEpoch);
  assert.ok(blocking.length > 0 && blocking.every((epoch) => epoch === 8), `only the current-epoch gaps block (${blocking})`);
  assert.notEqual(restarted.outbox.startRefusal(AGENT), null, "a current-epoch gap refuses automatic starts");
  restarted.outbox.stop();
}));

test("RFC 071 outbox (recovery grant): bound to its launch, spent on first use, replaced by a newer one, released on failure; a copy is nothing", withDir((dir) => {
  const { outbox } = outboxWithGap(dir);
  const admit = (launchId: string) => {
    const admission = outbox.admitServerStart(AGENT, { launchId, humanStart: true });
    assert.equal(admission.refusal, null);
    assert.ok(admission.recoveryGrant);
    return admission.recoveryGrant!;
  };
  // The gap is current (no new epoch): only the grant can pass.
  let grant = admit("human-1");
  assert.notEqual(outbox.startRefusal(AGENT, "human-1", { ...grant }), null, "a copy of the grant is not the grant");
  assert.equal(outbox.startRefusal(AGENT, "human-1", grant), null, "the copy did not spend the live grant; the live grant passes");
  grant = admit("human-2");
  assert.notEqual(outbox.startRefusal(AGENT, "other-launch", grant), null, "bound to its launch");
  assert.notEqual(outbox.startRefusal(AGENT, "human-2", grant), null, "and spent by that attempt");
  grant = admit("human-3");
  assert.equal(outbox.startRefusal(AGENT, "human-3", grant), null, "its own start passes");
  assert.notEqual(outbox.startRefusal(AGENT, "human-3", grant), null, "once");
  assert.notEqual(outbox.startRefusal(AGENT, "human-3"), null, "the next start (same launchId, no grant) is automatic");
  const older = admit("human-4");
  const newer = admit("human-5");
  assert.notEqual(outbox.startRefusal(AGENT, "human-4", older), null, "a newer admitted human start replaces the older grant");
  assert.equal(outbox.startRefusal(AGENT, "human-5", newer), null);
  const released = admit("human-6");
  outbox.releaseRecoveryGrant(released);
  assert.notEqual(outbox.startRefusal(AGENT, "human-6", released), null, "a start that failed before its gate cannot keep its grant");
  assert.deepEqual(outbox.state(AGENT).entries.filter((entry) => entry.t !== "normal").length, 1, "the gap is kept throughout");
  outbox.stop();
}));

test("RFC 071 outbox (recovery grant): it covers only the evidence known at admission; a new unreliable cause or a new or grown gap after it refuses the start and spends the grant", withDir((dir) => {
  const { fs, ctl } = predicateFs();
  const { outbox, addGap, traces } = outboxWithGap(dir, fs);
  // Same epoch: the known gap is covered by the grant.
  let admission = outbox.admitServerStart(AGENT, { launchId: "human-1", humanStart: true });
  addGap(1_000); // a new gap (the in-flight gap is sealed) of the same epoch
  assert.equal(outbox.startRefusal(AGENT, "human-1", admission.recoveryGrant), AUTOMATIC_START_REFUSAL_TEXT);
  assert.ok(traces.some((trace) => trace.name === "daemon.runtime_outcome_outbox.recovery_grant_overridden" && trace.attrs.new_markers === 1));
  assert.notEqual(outbox.startRefusal(AGENT, "human-1", admission.recoveryGrant), null, "spent");

  // Grown: more frames fold into the open gap the grant knew.
  admission = outbox.admitServerStart(AGENT, { launchId: "human-2", humanStart: true });
  assert.equal(outbox.startRefusal(AGENT, "human-2", { ...admission.recoveryGrant! }), outbox.startRefusal(AGENT), "(a copy answers as automatic)");
  admission = outbox.admitServerStart(AGENT, { launchId: "human-3", humanStart: true });
  const openGapBefore = JSON.stringify(outbox.state(AGENT).entries.filter((entry) => entry.t === "gap").at(-1));
  for (let seq = 5_000; seq <= 5_000 + OUTBOX_NORMAL_CAP; seq += 1) outbox.enqueue(e1(seq)); // one more than fits: folds into the open gap
  assert.equal(outbox.state(AGENT).entries.filter((entry) => entry.t !== "normal").length, 2, "no new marker: the open gap grew");
  assert.notEqual(JSON.stringify(outbox.state(AGENT).entries.filter((entry) => entry.t === "gap").at(-1)), openGapBefore);
  assert.notEqual(outbox.startRefusal(AGENT, "human-3", admission.recoveryGrant), null, "a grown gap is a new fault");
  for (const entry of [...outbox.state(AGENT).entries]) {
    if (entry.t === "normal") outbox.ack({ agentId: AGENT, daemonInstanceId: entry.daemonInstanceId, clientSeq: entry.clientSeq });
  }

  outbox.stop();
}));

test("RFC 071 outbox (recovery grant): a new unreliable cause after the admitted human start that resolved the old one is not covered", withDir((dir) => {
  const { fs, ctl } = predicateFs();
  const { outbox } = makeOutbox(dir, { fs });
  outbox.onServerContext(true);
  const loseEvidence = (seq: number) => {
    ctl.fail = isQueueFile;
    outbox.enqueue(exited(seq));
    ctl.fail = () => false;
    assert.equal(outbox.isUnreliable(AGENT), true);
  };
  loseEvidence(1);
  const markerId = (JSON.parse(readFileSync(markerPath(dir), "utf8")) as { markerId: string }).markerId;
  let admission = outbox.admitServerStart(AGENT, { launchId: "human-1", humanStart: true, takeoverEpoch: 1 });
  assert.equal(admission.refusal, null);
  assert.equal(admission.recoveryGrant!.resolvedMarkerId, markerId, "the grant records the evidence it resolved");
  assert.equal(outbox.startRefusal(AGENT, "human-1", admission.recoveryGrant), null, "positive control: nothing new, it passes");
  admission = outbox.admitServerStart(AGENT, { launchId: "human-2", humanStart: true, takeoverEpoch: 2 });
  loseEvidence(2);
  assert.notEqual(outbox.startRefusal(AGENT, "human-2", admission.recoveryGrant), null, "a new unreliable cause is not covered");
  outbox.stop();
}));

// --- Protocol engagement, process mode and per-connection capability (review of #8688, round 8) ---

/** One compat/reliable run of a launch: admitted, process opened, spawned, an E1, exited. */
function launchCycle(outbox: RuntimeOutcomeOutbox, cycle: number, seqBase: number): void {
  assert.equal(outbox.decideStart(AGENT, { launchId: `launch-${cycle}` }), null, `cycle ${cycle}: automatic start admitted`);
  assert.equal(outbox.openProcess(AGENT, `p-${cycle}`, `launch-${cycle}`), true);
  outbox.enqueue({ type: "agent:process_spawned", agentId: AGENT, daemonInstanceId: "d1", processInstanceId: `p-${cycle}`, launchId: `launch-${cycle}`, clientSeq: seqBase });
  outbox.enqueue({ ...e1(seqBase + 1), launchId: `launch-${cycle}` } as OutboxFrame);
  outbox.enqueue({ type: "agent:process_exited", agentId: AGENT, daemonInstanceId: "d1", processInstanceId: `p-${cycle}`, spawnLaunchId: `launch-${cycle}`, launchId: `launch-${cycle}`, clientSeq: seqBase + 2, code: 1, signal: null });
}

const engagedOnDisk = (dir: string) => onDisk(dir).protocolEngaged === true;

test("RFC 071 outbox (pure old server, regression): 200 start/exit cycles of a never-engaged agent queue nothing, form no gap, mark nothing unreliable, never refuse, and close their open-launch entries", withDir((dir) => {
  const { outbox } = makeOutbox(dir);
  outbox.onServerContext(false);
  for (let cycle = 0; cycle < 200; cycle += 1) {
    launchCycle(outbox, cycle, 1 + cycle * 3);
    assert.equal(outbox.startRefusal(AGENT), null, `cycle ${cycle}: never refused`);
  }
  assert.deepEqual(outbox.state(AGENT).entries, []);
  assert.equal(outbox.isUnreliable(AGENT), false);
  assert.deepEqual(openOnDisk(dir), { v: 1, agentId: AGENT, requests: [], processes: [] }, "results and exits still close the open-launch record");
  outbox.stop();
}));

test("RFC 071 outbox (downgrade, then restore): an un-acked E1 is kept on an old server (sending pauses, the agent stays engaged, new frames of its reliable process queue); back on an acking server it replays with its ORIGINAL identity, then the later frames in order", withDir((dir) => {
  const { outbox, sent } = makeOutbox(dir);
  outbox.onServerContext(true);
  assert.equal(outbox.openProcess(AGENT, "p-1", "launch-1"), true);
  assert.equal(outbox.processMode(AGENT, "p-1"), "reliable");
  outbox.enqueue(e1(7));
  assert.deepEqual(sent.map(seqOf), ["d1:7"], "sent, not acked");
  outbox.onServerContext(false);
  outbox.enqueue(e2(8));
  outbox.enqueue(exited(9));
  assert.deepEqual(sent.map(seqOf), ["d1:7"], "sending pauses on the old server");
  assert.deepEqual(onDisk(dir).entries.map((entry) => entry.t === "normal" ? entry.clientSeq : -1), [7, 8, 9], "the E1 is kept, the later frames queue");
  assert.equal(engagedOnDisk(dir), true, "still engaged");
  outbox.onServerContext(true);
  assert.deepEqual(sent.map(seqOf), ["d1:7", "d1:7"], "replayed with its original (daemonInstanceId, clientSeq)");
  outbox.ack(ackFor(sent[1]!));
  outbox.ack(ackFor(sent[2]!));
  assert.deepEqual(sent.map(seqOf), ["d1:7", "d1:7", "d1:8", "d1:9"], "then the later frames, in order");
  outbox.stop();
}));

test("RFC 071 outbox (unknown, then old): a frame queued while the capability was unknown is kept (not discarded) and the agent stays engaged", withDir((dir) => {
  const { outbox } = makeOutbox(dir);
  outbox.enqueue(exited(1)); // before this connection's machine:context
  outbox.onServerContext(false);
  assert.deepEqual(onDisk(dir).entries.map((entry) => entry.t === "normal" ? entry.clientSeq : -1), [1], "kept");
  assert.equal(engagedOnDisk(dir), true);
  outbox.enqueue(e2(2)); // a compat result on the confirmed-old connection
  assert.equal(onDisk(dir).entries.length, 1, "not produced: engagement does not make an old server a reader");
  outbox.onServerContext(false);
  assert.equal(engagedOnDisk(dir), true, "still engaged while the kept frame is there");
  outbox.stop();
}));

test("RFC 071 outbox (per-connection capability): a persisted last-known 'old' never stands in for this connection: after a restart the capability is unknown, a result is kept, starts wait for the context, and an upgraded server gets the result with its original identity", withDir(async (dir) => {
  const first = makeOutbox(dir);
  first.outbox.onServerContext(false);
  first.outbox.stop();
  assert.equal((JSON.parse(readFileSync(path.join(dir, "@server-capability.json"), "utf8")) as { lastKnownServerAcks: boolean }).lastKnownServerAcks, false, "history is recorded");

  const { outbox, sent } = makeOutbox(dir, { instance: "d2" });
  outbox.load();
  assert.equal(outbox.currentServerCapability(), "unknown", "not the last known value");
  let confirmed = false;
  const held = outbox.waitForCapability().confirmed.then((value) => { confirmed = value; });
  outbox.enqueue(exited(5, "d2")); // a running process exits before the context
  await flush();
  assert.equal(confirmed, false, "a start waits for this connection's context");
  assert.deepEqual(onDisk(dir).entries.map((entry) => entry.t === "normal" ? `${entry.daemonInstanceId}:${entry.clientSeq}` : "m"), ["d2:5"], "the result is kept");
  outbox.onServerContext(true);
  await held;
  assert.equal(confirmed, true);
  assert.deepEqual(sent.map(seqOf), ["d2:5"], "sent with its original identity");
  outbox.onDisconnected();
  assert.equal(outbox.currentServerCapability(), "unknown", "a disconnect reopens the unknown window");
  outbox.stop();
}));

test("RFC 071 outbox (process mode): fixed at launch from this connection's confirmed capability; a rebind under acks upgrades a compat process; nothing downgrades a reliable one", withDir((dir) => {
  const { outbox } = makeOutbox(dir);
  assert.equal(outbox.openProcess(AGENT, "p-unknown", null), true);
  assert.equal(outbox.processMode(AGENT, "p-unknown"), "compat", "launched while unknown");
  outbox.onServerContext(false);
  assert.equal(outbox.openProcess(AGENT, "p-old", "launch-old"), true);
  assert.equal(outbox.processMode(AGENT, "p-old"), "compat");
  outbox.onServerContext(true);
  assert.equal(outbox.openProcess(AGENT, "p-old", "launch-old"), true); // a server start rebound onto it
  assert.equal(outbox.processMode(AGENT, "p-old"), "reliable", "rebound under acks");
  outbox.onServerContext(false);
  assert.equal(outbox.openProcess(AGENT, "p-old", "launch-old"), true);
  assert.equal(outbox.processMode(AGENT, "p-old"), "reliable", "never downgraded");
  outbox.stop();
}));

test("RFC 071 outbox (disengage): engaged, the queue drains on an acking server, then an old server: disengaged durably; a later 200-cycle compat run stays empty", withDir((dir) => {
  const { outbox, sent } = makeOutbox(dir);
  outbox.onServerContext(true);
  launchCycle(outbox, 0, 1);
  for (let index = 0; index < 10 && outbox.state(AGENT).entries.length > 0; index += 1) outbox.ack(ackFor(sent.at(-1)!));
  assert.deepEqual(outbox.state(AGENT).entries, [], "precondition: everything acked");
  assert.equal(engagedOnDisk(dir), true, "precondition: engaged");
  outbox.onServerContext(false);
  assert.equal(onDisk(dir).protocolEngaged, false, "disengaged durably");
  for (let cycle = 1; cycle <= 200; cycle += 1) launchCycle(outbox, cycle, 10 + cycle * 3);
  assert.deepEqual(onDisk(dir).entries, []);
  assert.equal(outbox.startRefusal(AGENT), null);
  outbox.stop();
}));

test("RFC 071 outbox (disengage, interleaving): a reliable process is running and the queue is empty, then an old server: NOT disengaged; its later E1 and exit are queued and kept", withDir((dir) => {
  const { outbox, sent } = makeOutbox(dir);
  outbox.onServerContext(true);
  assert.equal(outbox.decideStart(AGENT, { launchId: "launch-1" }), null);
  assert.equal(outbox.openProcess(AGENT, "p-1", "launch-1"), true);
  outbox.enqueue(spawned(1));
  outbox.ack(ackFor(sent.at(-1)!));
  assert.deepEqual(outbox.state(AGENT).entries, [], "precondition: empty queue, the reliable process runs");
  outbox.onServerContext(false);
  assert.equal(engagedOnDisk(dir), true, "not disengaged while a reliable process runs");
  outbox.enqueue({ ...e1(2), launchId: "launch-1" } as OutboxFrame);
  outbox.enqueue(exited(1)); // p-1's exit (seq reuse is fine: a different identity kind)
  assert.deepEqual(onDisk(dir).entries.map((entry) => entry.t === "normal" ? entry.kind : "m"), ["e1", "exited"], "queued and kept");
  outbox.onServerContext(false);
  assert.equal(engagedOnDisk(dir), true, "the kept frames keep it engaged");
  outbox.stop();
}));

test("RFC 071 outbox (capacity on an old server): an engaged agent fills its queue: starts are still admitted, no entry is ever deleted to make room, and the lost frame fails closed", withDir((dir) => {
  const { outbox } = makeOutbox(dir);
  outbox.onServerContext(true);
  assert.equal(outbox.openProcess(AGENT, "p-reliable", "launch-0"), true); // launched under acks: its frames always queue
  outbox.enqueue(e1(1)); // in flight, never acked
  outbox.onServerContext(false);
  const seqs = () => outbox.state(AGENT).entries.map((entry) => entry.t === "normal" ? entry.clientSeq : -1);
  let seq = 2;
  while (outbox.state(AGENT).entries.length < OUTBOX_NORMAL_CAP) {
    const before = seqs();
    for (let frame = 0; frame < 3; frame += 1) outbox.enqueue(e2(seq++)); // the reliable process's turn results
    const after = seqs();
    assert.deepEqual(after.slice(0, before.length), before, "nothing queued before was removed (turn_completed included)");
    assert.ok(seq < 1_000, "the queue fills");
  }
  assert.equal(outbox.decideStart(AGENT, { launchId: "launch-last" }), null, "a full queue does not strand the agent on the old server");
  assert.equal(outbox.startRefusal(AGENT), null, "the daemon's own starts are admitted too");
  const before = seqs();
  for (let extra = 0; extra < 10; extra += 1) outbox.enqueue(e1(seq++));
  assert.deepEqual(seqs().slice(0, before.length), before, "a frame beyond capacity deletes nothing");
  assert.equal(outbox.state(AGENT).entries.some((entry) => entry.t !== "normal"), false, "no folding into gaps on the old server");
  assert.equal(outbox.isUnreliable(AGENT), true, "a frame that could not be stored fails closed");
  outbox.stop();
}));

test("RFC 071 outbox (old server): a storage failure of this daemon's own open-launch record still refuses that start and marks unreliable; the next start is not stranded", withDir((dir) => {
  const { fs, ctl } = predicateFs();
  const { outbox } = makeOutbox(dir, { fs });
  outbox.onServerContext(false);
  ctl.fail = (target) => path.basename(target).includes("@open-launches");
  assert.equal(outbox.decideStart(AGENT, { launchId: "launch-1" }), "terminal_failure_outcome_storage_blocked");
  ctl.fail = () => false;
  assert.equal(outbox.isUnreliable(AGENT), true);
  assert.equal(outbox.startRefusal(AGENT), null, "on the old server");
  outbox.onServerContext(true);
  assert.notEqual(outbox.startRefusal(AGENT), null, "under acks, where a human start is the way out");
  outbox.stop();
}));

test("RFC 071 outbox (residual growth, bounded): a frame kept from an unknown window engages the agent on an old server, but its later compat turns add nothing: the queue grows only by what unknown windows (and reliable processes) produce", withDir((dir) => {
  const { outbox } = makeOutbox(dir);
  outbox.enqueue(e2(1)); // a running process's turn completes during a reconnect window (unknown)
  outbox.onServerContext(false);
  for (let cycle = 0; cycle < 200; cycle += 1) launchCycle(outbox, cycle, 10 + cycle * 3);
  for (let turn = 0; turn < 500; turn += 1) outbox.enqueue(e2(5_000 + turn));
  assert.deepEqual(onDisk(dir).entries.map((entry) => entry.t === "normal" ? entry.clientSeq : -1), [1], "only the window's frame is queued");
  assert.equal(outbox.startRefusal(AGENT), null, "and automatic starts are not refused");
  outbox.onDisconnected();
  outbox.enqueue(e2(9_000)); // the next reconnect window adds its own
  outbox.onServerContext(false);
  assert.equal(onDisk(dir).entries.length, 2, "one more per result produced in a window");
  outbox.stop();
}));

test("RFC 071 outbox (held starts): a capability wait is cancellable for that start only; stop() releases every waiter as cancelled; a late context does not revive a cancelled wait; nothing pretends the capability is known", withDir(async (dir) => {
  const { outbox } = makeOutbox(dir);
  const first = outbox.waitForCapability();
  const second = outbox.waitForCapability();
  assert.equal(outbox.heldCapabilityWaits(), 2);
  first.cancel();
  assert.equal(await first.confirmed, false, "cancelled");
  assert.equal(outbox.heldCapabilityWaits(), 1, "that waiter is removed; the other still waits");
  assert.equal(outbox.currentServerCapability(), "unknown", "cancelling pretends nothing");
  outbox.stop(); // the reviewer's repro: wait, then stop
  assert.equal(await second.confirmed, false, "the daemon stopping ends every wait, cancelled");
  assert.equal(outbox.heldCapabilityWaits(), 0);
  outbox.onServerContext(true);
  assert.equal(await first.confirmed, false, "a late context does not revive it");
  assert.equal(await outbox.waitForCapability().confirmed, true, "a new wait after the context resolves at once");
  outbox.stop();
}));

// --- Strict validation of every persisted record (review of #8688, round 10) ---

const zero = { e1: 0, turnCompleted: 0, spawned: 0, exited: 0, startOutcome: 0 };
const normalE1 = (seq: number) => ({ t: "normal", kind: "e1", daemonInstanceId: "d0", clientSeq: seq, takeoverEpoch: 0, frame: { ...e1(seq, "d0") } });
const queueFile = (entries: unknown[], top: Record<string, unknown> = {}) => ({ v: 1, agentId: AGENT, takeoverEpoch: 0, inFlight: false, entries, ...top });

/** Valid JSON, broken structure: which file it is and what it holds. */
const brokenRecords: Array<{ name: string; file: string; content: unknown }> = [
  { name: "a gap missing counts", file: `${AGENT}.json`, content: queueFile([{ t: "gap", gapId: "g", daemonInstanceId: "d0", takeoverEpoch: 0, fromSeq: 1, toSeq: 1, sealed: false }]) },
  { name: "a negative seq", file: `${AGENT}.json`, content: queueFile([{ ...normalE1(1), clientSeq: -1, frame: { ...e1(1, "d0"), clientSeq: -1 } }]) },
  { name: "fromSeq > toSeq", file: `${AGENT}.json`, content: queueFile([{ t: "gap", gapId: "g", daemonInstanceId: "d0", takeoverEpoch: 0, fromSeq: 5, toSeq: 2, sealed: false, counts: { ...zero, e1: 1 } }]) },
  { name: "an unknown kind", file: `${AGENT}.json`, content: queueFile([{ ...normalE1(1), kind: "bogus" }]) },
  { name: "a frame whose type does not match its kind", file: `${AGENT}.json`, content: queueFile([{ ...normalE1(1), frame: { ...spawned(1, "d0") } }]) },
  { name: "over-capacity entries", file: `${AGENT}.json`, content: queueFile(Array.from({ length: OUTBOX_NORMAL_CAP + 1 }, (_, index) => normalE1(index + 1))) },
  { name: "a wrong-typed protocolEngaged", file: `${AGENT}.json`, content: queueFile([], { protocolEngaged: "yes" }) },
  { name: "a malformed open-launch entry", file: `${AGENT}@open-launches.json`, content: { v: 1, agentId: AGENT, requests: [], processes: [{ processInstanceId: 5, spawnLaunchId: null, daemonInstanceId: "d0", openedAtMs: 1 }] } },
  { name: "a malformed unreliable marker", file: `${AGENT}@unreliable.json`, content: { v: 1, markerId: "m-1", agentId: AGENT, since: "yesterday", daemonInstanceId: "d0", takeoverEpoch: 0 } },
];

for (const broken of brokenRecords) {
  test(`RFC 071 outbox (strict load): valid JSON with ${broken.name} is treated like unparseable JSON: unreliable, the file is kept, starts are decided without throwing (refused until an old server is confirmed), nothing is sent`, withDir((dir) => {
    mkdirSync(dir, { recursive: true });
    const raw = JSON.stringify(broken.content);
    writeFileSync(path.join(dir, broken.file), raw);
    const { outbox, sent } = makeOutbox(dir);
    outbox.load();
    assert.equal(outbox.isUnreliable(AGENT), true, "unreliable");
    assert.ok(readdirSync(dir).some((name) => (name === broken.file || name.startsWith(`${AGENT}.json.corrupt-`)) && readFileSync(path.join(dir, name), "utf8") === raw), "the original bytes are kept");
    assert.ok(existsSync(markerPath(dir)) && (JSON.parse(readFileSync(markerPath(dir), "utf8")) as { markerId?: unknown }).markerId !== "m-1" || broken.file !== `${AGENT}@unreliable.json`, "a durable (valid) marker");
    for (const phase of ["unknown", "old"] as const) {
      if (phase === "old") outbox.onServerContext(false);
      assert.doesNotThrow(() => outbox.refusesAutomaticStart(AGENT), `${phase}: no throw`);
      // Refused until the old server is confirmed; there nothing is refused (no human start can clear it).
      assert.equal(outbox.refusesAutomaticStart(AGENT), phase === "unknown", `${phase}: automatic starts refused only before the old server is confirmed`);
      let decided: unknown;
      assert.doesNotThrow(() => { decided = outbox.decideStart(AGENT, { launchId: `auto-${phase}` }); }, `${phase}: decideStart does not throw`);
      assert.equal(decided !== null, phase === "unknown", `${phase}: the server's automatic start likewise`);
      assert.doesNotThrow(() => outbox.enqueue(e1(900, "d1")), `${phase}: enqueue does not throw`);
    }
    outbox.onServerContext(true);
    assert.deepEqual(sent.filter((msg) => msg.type !== "agent:runtime:outcome_unreliable" && msg.type !== "agent:runtime:outcome").map((msg) => msg.type), [], "nothing from the broken record is sent");
    assert.equal(sent.some((msg) => msg.type === "agent:runtime:outcome" && (msg as OutboxFrame).daemonInstanceId === "d0"), false, "no frame of the broken record");
    outbox.stop();
  }));
}

test("RFC 071 outbox (strict load, positive control): a valid state with every entry kind, a gap, a cross marker, engagement and a takeover loads as is", withDir((dir) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${AGENT}.json`), JSON.stringify(queueFile([
    { t: "cross", gapId: "c-1", instances: ["d0", "d9"], takeoverEpoch: 1, counts: { ...zero, exited: 2 }, sealed: true },
    { t: "gap", gapId: "g-1", daemonInstanceId: "d0", takeoverEpoch: 1, fromSeq: 1, toSeq: 3, counts: { ...zero, e1: 2, turnCompleted: 1 }, sealed: false },
    normalE1(4),
    { t: "normal", kind: "turnCompleted", daemonInstanceId: "d0", clientSeq: 5, takeoverEpoch: 1, frame: e2(5, "d0") },
    { t: "normal", kind: "spawned", daemonInstanceId: "d0", clientSeq: 6, takeoverEpoch: 1, frame: spawned(6, "d0") },
    { t: "normal", kind: "exited", daemonInstanceId: "d0", clientSeq: 7, takeoverEpoch: 1, frame: exited(7, "d0") },
    { t: "normal", kind: "startOutcome", daemonInstanceId: "d0", clientSeq: 8, takeoverEpoch: 1, frame: startOutcome(8, "d0") },
  ], { takeoverEpoch: 2, humanTakeoverEpoch: 1, protocolEngaged: true, inFlight: true })));
  const { outbox } = makeOutbox(dir);
  outbox.load();
  assert.equal(outbox.isUnreliable(AGENT), false);
  assert.equal(outbox.state(AGENT).entries.length, 7);
  outbox.stop();
}));
