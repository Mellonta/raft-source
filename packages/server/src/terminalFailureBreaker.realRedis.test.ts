// Real-Redis teeth for the RFC 071 terminal-failure breaker store and the
// combined two-key claim. The default suite only has the in-memory store,
// which cannot show that the Lua script compares and writes BOTH keys, that
// the Redis decoder round-trips every field, or that the TTL rule holds.
// Gated like the wake crash-loop real-Redis suite (same env vars): CI runs it
// in the probe-concurrency job with a Redis service; local runs need
// WAKE_CRASH_LOOP_REAL_REDIS_URL.
import assert from "node:assert/strict";
import { getRedis, getRedisPub, getRedisReplicaSub, getRedisSub, initRedis } from "./redis";
import { compareAndSetWakeCrashLoopState, getWakeCrashLoopState } from "./replicaRouter";
import { WakeCrashLoopBreaker, type WakeCrashLoopExit } from "./services/wakeCrashLoopBreaker";
import {
  TERMINAL_BREAKER_UNREADABLE,
  encodeTerminalFailureBreakerState,
  freshTerminalFailureBreakerState,
  decodeTerminalFailureBreakerState,
  terminalOutboxWatermark,
  type TerminalFailureBreakerState,
  type TerminalFailureFrame,
  type TerminalOutboxFrame,
} from "./terminalFailureBreaker";
import {
  compareAndSetTerminalFailureBreakerState,
  getTerminalFailureBreakerState,
  redisTerminalFailureBreakerStore,
  terminalFailureBreakerKey,
} from "./terminalFailureBreakerRedisStore";
import {
  TerminalFailureBreaker,
  type CombinedClaimInput,
  type TerminalAndWakeCrashLoopWrite,
  type TerminalFailureBreakerStore,
} from "./terminalFailureBreakerStore";

const REAL_REDIS_URL = process.env.WAKE_CRASH_LOOP_REAL_REDIS_URL;
const REAL_REDIS_REQUIRED = process.env.WAKE_CRASH_LOOP_REAL_REDIS_REQUIRED === "1";

function skipUnlessRealRedis(): boolean {
  if (REAL_REDIS_URL) return false;
  if (REAL_REDIS_REQUIRED) throw new Error("WAKE_CRASH_LOOP_REAL_REDIS_REQUIRED=1 but WAKE_CRASH_LOOP_REAL_REDIS_URL is unset");
  return true;
}

const agentIds: string[] = [];
function freshAgentId(): string {
  const id = `rfc071-terminal-breaker-${Math.random().toString(36).slice(2)}`;
  agentIds.push(id);
  return id;
}

beforeAll(() => {
  if (REAL_REDIS_URL) initRedis(REAL_REDIS_URL);
});

afterAll(async () => {
  if (!REAL_REDIS_URL) return;
  for (const id of agentIds) await getRedis().del(terminalFailureBreakerKey(id), `slock:agent:${id}:wake_crash_loop`);
  for (const client of [getRedis(), getRedisPub(), getRedisSub(), getRedisReplicaSub()]) client.disconnect();
});

const H = 3_600_000;
const D1 = "daemon-1";
const WAKE_RULES = { windowMs: 10 * H, threshold: 1 };
let seq = 0;
const e1 = (launchId: string): TerminalFailureFrame =>
  ({ launchId, sessionId: "S", daemonInstanceId: D1, clientSeq: (seq += 1), failureKind: "compaction_failed", fingerprint: "c4722931c8a1f172" });
const processExit = (launchId: string): WakeCrashLoopExit => ({ kind: "agent_process_exited", evidence: { code: 1, signal: null }, launchId });
const claimInput = (launchId: string, nowMs: number, extra: Partial<CombinedClaimInput> = {}): CombinedClaimInput =>
  ({ launchId, nowMs, resumedSessionId: "S", daemonInstanceId: D1, capability: true, control: "automatic", human: false, ...extra });

async function rawTerminal(agentId: string) {
  return getRedis().hgetall(terminalFailureBreakerKey(agentId));
}

async function openBreaker(breaker: TerminalFailureBreaker, agentId: string): Promise<number> {
  for (const [i, launchId] of ["L1", "L2"].entries()) {
    const t = i * 60_000;
    assert.ok((await breaker.claimStart(agentId, claimInput(launchId, t))).ok);
    await breaker.recordProcessSpawned(agentId, t, { launchId, daemonInstanceId: D1, processInstanceId: `pi-${launchId}` });
    await breaker.recordTerminalFailure(agentId, e1(launchId), { nowMs: t + 1_000, unreadCeilings: { c1: 4 } });
    await breaker.recordProcessExited(agentId, { daemonInstanceId: D1, processInstanceId: `pi-${launchId}`, spawnLaunchId: launchId, launchId, atMs: t + 2_000 });
  }
  const state = await breaker.read(agentId, 70_000);
  assert.equal(state.state, "open");
  return state.blockedUntilMs!;
}

class InterleavingRedisStore implements TerminalFailureBreakerStore {
  beforeScript: (() => Promise<void>) | null = null;
  scriptCalls = 0;
  getTerminalFailureBreakerState = redisTerminalFailureBreakerStore.getTerminalFailureBreakerState;
  compareAndSetTerminalFailureBreakerState = redisTerminalFailureBreakerStore.compareAndSetTerminalFailureBreakerState;
  getWakeCrashLoopState = redisTerminalFailureBreakerStore.getWakeCrashLoopState;
  async compareAndSetTerminalAndWakeCrashLoop(agentId: string, write: TerminalAndWakeCrashLoopWrite) {
    this.scriptCalls += 1;
    const hook = this.beforeScript;
    this.beforeScript = null;
    if (hook) await hook();
    return redisTerminalFailureBreakerStore.compareAndSetTerminalAndWakeCrashLoop(agentId, write);
  }
}

function everyFieldState(): TerminalFailureBreakerState {
  const launch = {
    launchId: "L9", generation: 4, resumedSessionId: "S9", isProbe: true, claimedAtMs: 1_000, leaseExpiresAtMs: 2_000,
    lastAppliedSeq: { daemonInstanceId: D1, clientSeq: 17 }, terminal: "e1" as const, takeover: true, catchupBatchId: "B9",
  };
  const failure = { kind: "compaction_failed", fingerprint: "c4722931c8a1f172", launchId: "L9", sessionId: "S9", atMs: 1_500 };
  return {
    schema: 1,
    state: "half_open",
    generation: 4,
    currentLaunch: launch,
    lastProbe: { ...launch, launchId: "L8", terminal: "process_exit" },
    needsManual: { reason: "daemon_restarted_no_exit", sinceMs: 1_200, causeEntries: [{ spawnLaunchId: "L6", daemonInstanceId: "daemon-0" }] },
    unexited: [{ spawnLaunchId: "L9", daemonInstanceId: D1, processInstanceId: "pi9", launchIds: ["L9", "L10"], dispatchedAtMs: 1_000, protected: true }],
    recentExits: [{ daemonInstanceId: D1, processInstanceId: "pi8", spawnLaunchId: "L8", atMs: 900 }, { daemonInstanceId: D1, processInstanceId: "pi-internal", spawnLaunchId: null, atMs: 950 }],
    unexitedOverflow: true,
    acknowledgedUnexited: [{ processInstanceId: null, daemonInstanceId: D1, spawnLaunchId: "L7", ackedAtMs: 800, reason: "daemon_restarted_untracked" }],
    sameFingerprint: { fingerprint: "c4722931c8a1f172", count: 2 },
    totalCount: 3,
    backoffStep: 1,
    openedAtMs: 700,
    blockedUntilMs: 3_000,
    lastFailure: failure,
    catchupObligation: {
      owedCeilings: { c1: 18, "c-dm": 4 },
      owedOverflow: true,
      obligationCursor: { c1: 15 },
      pendingBatch: {
        batchId: "B9", launchId: "L9", builtAtMs: 1_100,
        coverage: [{ conversationId: "c1", fromSeqExclusive: 10, coveredUpToSeq: 15, truncated: true }],
        messages: [{ id: "m11", conversationId: "c1", seq: 11, inPrefix: true }, { id: "m18", conversationId: "c1", seq: 18, inPrefix: false }],
        candidateCapHit: true, allUnreadCovered: false,
      },
      engagedByFailure: true,
    },
    diagnostics: { lastFailure: failure, lastClosedReason: "state_unreadable" },
    lastTransition: { from: "open", to: "half_open", cause: "probe_claimed", atMs: 1_000 },
    outboxWatermarks: { [D1]: 17, "daemon-0": 3 },
    outboxWatermarksLost: true,
    takeoverEpoch: 3,
  };
}

test("real Redis R-1: every field written through the store reads back equal; an open record has no TTL", async () => {
  if (skipUnlessRealRedis()) return;
  const agentId = freshAgentId();
  const state = everyFieldState();
  assert.equal(await compareAndSetTerminalFailureBreakerState(agentId, 0, state), true);
  assert.deepEqual(await getTerminalFailureBreakerState(agentId), { state, version: 1 });
  assert.equal(await getRedis().ttl(terminalFailureBreakerKey(agentId)), -1, "half_open persists");
  // An empty closed record expires after 7 days.
  assert.equal(await compareAndSetTerminalFailureBreakerState(agentId, 1, freshTerminalFailureBreakerState()), true);
  const ttl = await getRedis().ttl(terminalFailureBreakerKey(agentId));
  assert.ok(ttl > 6 * 86_400 && ttl <= 7 * 86_400, `closed TTL ${ttl}`);
});

test("real Redis control (3): a closed record holding only an outbox watermark is persisted (no TTL); the combined claim script keeps that rule", async () => {
  if (skipUnlessRealRedis()) return;
  const agentId = freshAgentId();
  const withWatermark = { ...freshTerminalFailureBreakerState(), outboxWatermarks: { "daemon-0": 5 } };
  assert.equal(await compareAndSetTerminalFailureBreakerState(agentId, 0, withWatermark), true);
  assert.equal(await getRedis().ttl(terminalFailureBreakerKey(agentId)), -1, "watermarks never expire");
  // Through the two-key claim script as well.
  const breaker = new TerminalFailureBreaker(redisTerminalFailureBreakerStore);
  const claimed = await breaker.claimStart(agentId, {
    launchId: "L1", nowMs: 1_000, resumedSessionId: null, daemonInstanceId: null, capability: false, control: "automatic", human: false,
  });
  assert.ok(claimed.ok);
  assert.equal(await getRedis().ttl(terminalFailureBreakerKey(agentId)), -1);
  assert.equal(terminalOutboxWatermark((await getTerminalFailureBreakerState(agentId))!.state as never, "daemon-0"), 5);
});

test("real Redis: a stale-version write is rejected and leaves the record byte-identical", async () => {
  if (skipUnlessRealRedis()) return;
  const agentId = freshAgentId();
  const first = everyFieldState();
  assert.equal(await compareAndSetTerminalFailureBreakerState(agentId, 0, first), true);
  const before = await rawTerminal(agentId);
  assert.equal(await compareAndSetTerminalFailureBreakerState(agentId, 0, freshTerminalFailureBreakerState()), false, "stale version 0");
  assert.equal(await compareAndSetTerminalFailureBreakerState(agentId, 7, freshTerminalFailureBreakerState()), false, "future version");
  assert.deepEqual(await rawTerminal(agentId), before);
  assert.equal(await compareAndSetTerminalFailureBreakerState(agentId, 1, freshTerminalFailureBreakerState()), true);
  assert.equal((await rawTerminal(agentId)).version, "2");
});

test("real Redis: an unreadable record decodes to the sentinel and reads as closed + owedOverflow through the breaker", async () => {
  if (skipUnlessRealRedis()) return;
  const agentId = freshAgentId();
  await getRedis().hset(terminalFailureBreakerKey(agentId), "version", "3", "state", "{\"schema\":1,\"state\":\"open\"}");
  assert.deepEqual(await getTerminalFailureBreakerState(agentId), { state: TERMINAL_BREAKER_UNREADABLE, version: 3 });
  const breaker = new TerminalFailureBreaker(redisTerminalFailureBreakerStore);
  const state = await breaker.read(agentId, 1);
  assert.equal(state.state, "closed");
  assert.equal(state.catchupObligation?.owedOverflow, true);
  assert.ok((await breaker.claimStart(agentId, claimInput("L1", 2))).ok, "the next write lands at the stored version");
  assert.equal((await rawTerminal(agentId)).version, "4");
});

test("real Redis H-12: a #1119 exit CAS between the reads and the script → the script writes nothing; the terminal record is byte-identical", async () => {
  if (skipUnlessRealRedis()) return;
  const agentId = freshAgentId();
  const store = new InterleavingRedisStore();
  const breaker = new TerminalFailureBreaker(store, WAKE_RULES);
  const wakeBreaker = new WakeCrashLoopBreaker({ getWakeCrashLoopState, compareAndSetWakeCrashLoopState }, WAKE_RULES);
  const probeAt = await openBreaker(breaker, agentId);
  const terminalBefore = await rawTerminal(agentId);
  const wakeVersionBefore = (await getWakeCrashLoopState(agentId))!.version;

  store.scriptCalls = 0;
  store.beforeScript = async () => {
    assert.equal((await wakeBreaker.recordExit(agentId, processExit("L2"), probeAt)).blockedNow, true);
  };
  assert.deepEqual(await breaker.claimStart(agentId, claimInput("P", probeAt)), { ok: false, reason: "wake_crash_loop_blocked" });
  assert.equal(store.scriptCalls, 1);
  assert.deepEqual(await rawTerminal(agentId), terminalBefore, "terminal record byte-identical at the same version");
  const wakeAfter = (await getWakeCrashLoopState(agentId))!;
  assert.equal(wakeAfter.version, wakeVersionBefore + 1, "only the exit wrote #1119");
  assert.equal(wakeAfter.state.blocked, true);
  assert.equal(wakeAfter.state.lastStartLaunchId, "L2", "the script did not record P");
});

test("real Redis H-12 mirror: the script lands first; the exit's stale CAS fails and its retry counts against the claimed launch", async () => {
  if (skipUnlessRealRedis()) return;
  const agentId = freshAgentId();
  const breaker = new TerminalFailureBreaker(redisTerminalFailureBreakerStore, WAKE_RULES);
  const wakeBreaker = new WakeCrashLoopBreaker({ getWakeCrashLoopState, compareAndSetWakeCrashLoopState }, WAKE_RULES);
  const probeAt = await openBreaker(breaker, agentId);
  const staleRead = (await getWakeCrashLoopState(agentId))!;
  const terminalVersionBefore = Number((await rawTerminal(agentId)).version);

  const claimed = await breaker.claimStart(agentId, claimInput("P", probeAt));
  assert.ok(claimed.ok);
  assert.equal(Number((await rawTerminal(agentId)).version), terminalVersionBefore + 1, "terminal written");
  const afterScript = (await getWakeCrashLoopState(agentId))!;
  assert.equal(afterScript.version, staleRead.version + 1, "#1119 written by the same script");
  assert.equal(afterScript.state.lastStartLaunchId, "P");
  assert.equal(claimed.crashLoopVersion, afterScript.version);
  assert.equal((await breaker.read(agentId, probeAt)).state, "half_open");

  const staleWrite = { ...staleRead.state, earlyExitCount: 1, blocked: true, lastStartCounted: true };
  assert.equal(await compareAndSetWakeCrashLoopState(agentId, staleRead.version, staleWrite), false, "the exit's CAS fails on the script's version");
  assert.equal((await wakeBreaker.recordExit(agentId, processExit("L2"), probeAt + 1)).rejected, "launch_mismatch");
  assert.equal((await wakeBreaker.recordExit(agentId, processExit("P"), probeAt + 2)).counted, true, "counts against the new launch");
});

test("real Redis: the combined script writes neither key when only the terminal version moved", async () => {
  if (skipUnlessRealRedis()) return;
  const agentId = freshAgentId();
  const fresh = freshTerminalFailureBreakerState();
  const wakeState = { episode: 1, earlyExitCount: 0, blocked: false, blockedAtMs: null, lastStartAtMs: 5, lastStartLaunchId: "L1", lastStartCounted: false, firstExitAtMs: null, lastExitAtMs: null, lastExitKind: null, lastSignal: null, lastLaunchId: null };
  assert.equal(await compareAndSetTerminalFailureBreakerState(agentId, 0, fresh), true);
  const write = { terminal: { expectedVersion: 0, state: fresh }, wakeCrashLoop: { expectedVersion: 0, state: wakeState } };
  assert.equal(await redisTerminalFailureBreakerStore.compareAndSetTerminalAndWakeCrashLoop(agentId, write), false);
  assert.equal(await getWakeCrashLoopState(agentId), null, "the #1119 key was not created");
  assert.equal((await rawTerminal(agentId)).state, encodeTerminalFailureBreakerState(fresh));
  assert.equal(await redisTerminalFailureBreakerStore.compareAndSetTerminalAndWakeCrashLoop(agentId, { ...write, terminal: { expectedVersion: 1, state: fresh } }), true);
  assert.equal((await getWakeCrashLoopState(agentId))?.version, 1);
  assert.equal((await rawTerminal(agentId)).version, "2");
});

test("real Redis X-6(c): an exit before the identity settles the pending entry; the late process_spawned creates no entry", async () => {
  if (skipUnlessRealRedis()) return;
  const agentId = freshAgentId();
  const breaker = new TerminalFailureBreaker(redisTerminalFailureBreakerStore);
  assert.ok((await breaker.claimStart(agentId, claimInput("P", 0))).ok);
  assert.deepEqual((await breaker.read(agentId, 1)).unexited.map((e) => [e.spawnLaunchId, e.processInstanceId]), [["P", null]]);
  assert.equal(await breaker.recordProcessExited(agentId, { daemonInstanceId: D1, processInstanceId: "pi", spawnLaunchId: "P", launchId: "P", atMs: 2 }), "removed");
  assert.equal(await breaker.recordProcessSpawned(agentId, 3, { launchId: "P", daemonInstanceId: D1, processInstanceId: "pi" }), "settled_recent_exit");
  const state = await breaker.read(agentId, 4);
  assert.deepEqual(state.unexited, []);
  assert.deepEqual(state.recentExits.map((e) => e.processInstanceId), ["pi"]);
});

test("real Redis X-5(b): an exit with the right launchId but another processInstanceId removes nothing", async () => {
  if (skipUnlessRealRedis()) return;
  const agentId = freshAgentId();
  const breaker = new TerminalFailureBreaker(redisTerminalFailureBreakerStore);
  assert.ok((await breaker.claimStart(agentId, claimInput("P", 0))).ok);
  await breaker.recordProcessSpawned(agentId, 1, { launchId: "P", daemonInstanceId: D1, processInstanceId: "pi" });
  assert.equal(await breaker.recordProcessExited(agentId, { daemonInstanceId: D1, processInstanceId: "pi-other", spawnLaunchId: "P", launchId: "P", atMs: 2 }), "exit_unmatched");
  const state = await breaker.read(agentId, 3);
  assert.deepEqual(state.unexited.map((e) => e.processInstanceId), ["pi"]);
  assert.equal(state.currentLaunch?.terminal, null);
});

// --- RFC 071 part 3: outbox frame commit (state + watermark, one hash write) ---

/** Runs `beforeCas` once, between a single-key CAS's read and its script. */
class SingleKeyInterleavingRedisStore implements TerminalFailureBreakerStore {
  beforeCas: (() => Promise<void>) | null = null;
  casCalls = 0;
  getTerminalFailureBreakerState = redisTerminalFailureBreakerStore.getTerminalFailureBreakerState;
  getWakeCrashLoopState = redisTerminalFailureBreakerStore.getWakeCrashLoopState;
  compareAndSetTerminalAndWakeCrashLoop = redisTerminalFailureBreakerStore.compareAndSetTerminalAndWakeCrashLoop;
  async compareAndSetTerminalFailureBreakerState(agentId: string, expectedVersion: number, state: TerminalFailureBreakerState) {
    this.casCalls += 1;
    const hook = this.beforeCas;
    this.beforeCas = null;
    if (hook) await hook();
    return redisTerminalFailureBreakerStore.compareAndSetTerminalFailureBreakerState(agentId, expectedVersion, state);
  }
}

const outboxE1 = (launchId: string, clientSeq: number): TerminalOutboxFrame =>
  ({ kind: "terminal_failure", frame: { launchId, sessionId: "S", daemonInstanceId: D1, clientSeq, failureKind: "compaction_failed", fingerprint: "c4722931c8a1f172" } });
const outboxInput = (nowMs: number) => ({ nowMs, unreadCeilings: {}, persistedSessionId: null });

test("real Redis: an outbox frame's state change and watermark land in one hash write; a replay writes nothing", async () => {
  if (skipUnlessRealRedis()) return;
  const agentId = freshAgentId();
  const breaker = new TerminalFailureBreaker(redisTerminalFailureBreakerStore);
  assert.ok((await breaker.claimStart(agentId, claimInput("L1", 0))).ok);
  const before = await rawTerminal(agentId);

  assert.deepEqual(await breaker.applyOutboxFrame(agentId, outboxE1("L1", 11), outboxInput(1_000)), { duplicate: false, outcome: "applied" });
  const after = await rawTerminal(agentId);
  assert.equal(Number(after.version), Number(before.version) + 1, "one write");
  const decoded = decodeTerminalFailureBreakerState(after.state);
  assert.notEqual(decoded, TERMINAL_BREAKER_UNREADABLE);
  const state = decoded as TerminalFailureBreakerState;
  assert.equal(state.totalCount, 1);
  assert.equal(terminalOutboxWatermark(state, D1), 11);

  // The ack was lost; the daemon resends the same frame.
  assert.deepEqual(await breaker.applyOutboxFrame(agentId, outboxE1("L1", 11), outboxInput(2_000)), { duplicate: true, outcome: "duplicate" });
  assert.deepEqual(await rawTerminal(agentId), after, "byte-identical: nothing re-applied");
});

test("real Redis: a concurrent write between the frame's read and its CAS → retried with state and watermark together", async () => {
  if (skipUnlessRealRedis()) return;
  const agentId = freshAgentId();
  const store = new SingleKeyInterleavingRedisStore();
  const breaker = new TerminalFailureBreaker(store);
  assert.ok((await breaker.claimStart(agentId, claimInput("L1", 0))).ok);
  const other = new TerminalFailureBreaker(redisTerminalFailureBreakerStore);
  store.beforeCas = async () => {
    await other.recordProcessSpawned(agentId, 0, { launchId: "L1", daemonInstanceId: D1, processInstanceId: "pi-L1" });
  };

  assert.deepEqual(await breaker.applyOutboxFrame(agentId, outboxE1("L1", 12), outboxInput(1_000)), { duplicate: false, outcome: "applied" });
  assert.equal(store.casCalls, 2, "first CAS lost to the concurrent write, the retry won");
  const state = (await getTerminalFailureBreakerState(agentId))!.state as TerminalFailureBreakerState;
  assert.equal(state.unexited[0]!.processInstanceId, "pi-L1", "the concurrent change survives");
  assert.equal(state.totalCount, 1);
  assert.equal(terminalOutboxWatermark(state, D1), 12);
});
