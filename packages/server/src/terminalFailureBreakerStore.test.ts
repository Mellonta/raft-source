import assert from "node:assert/strict";
import {
  InMemoryWakeCrashLoopStateStore,
  WakeCrashLoopBreaker,
  freshWakeCrashLoopEpisode,
  type WakeCrashLoopExit,
} from "./services/wakeCrashLoopBreaker";
import {
  encodeTerminalFailureBreakerState,
  type TerminalFailureFrame,
} from "./terminalFailureBreaker";
import {
  InMemoryTerminalFailureBreakerStore,
  TerminalFailureBreaker,
  claimTerminalAndWakeCrashLoopStartSync,
  decideCombinedClaim,
  terminalStateFromStored,
  type CombinedClaimInput,
  type TerminalAndWakeCrashLoopWrite,
  type TerminalFailureBreakerStore,
} from "./terminalFailureBreakerStore";

// RFC 071 part 1: the CAS store seam, the in-memory fallback and the combined
// two-key claim (§4.3 step 3). The Redis twin of these runs in
// terminalFailureBreaker.realRedis.test.ts.

const H = 3_600_000;
const D1 = "daemon-1";
const AGENT = "agent-a";
// #1119 rules with a window wide enough that an exit an hour after its start still counts.
const WAKE_RULES = { windowMs: 10 * H, threshold: 1 };

let seq = 0;
const e1 = (launchId: string, fingerprint = "fpA"): TerminalFailureFrame =>
  ({ launchId, sessionId: "S", daemonInstanceId: D1, clientSeq: (seq += 1), failureKind: "compaction_failed", fingerprint });
const processExit = (launchId: string): WakeCrashLoopExit => ({ kind: "agent_process_exited", evidence: { code: 1, signal: null }, launchId });
const claimInput = (launchId: string, nowMs: number, extra: Partial<CombinedClaimInput> = {}): CombinedClaimInput =>
  ({ launchId, nowMs, resumedSessionId: "S", daemonInstanceId: D1, capability: true, control: "automatic", human: false, ...extra });

/** Two failing launches through the combined claim; the terminal record opens. Returns the time a probe may run. */
async function openBreaker(breaker: TerminalFailureBreaker): Promise<number> {
  for (const [i, launchId] of ["L1", "L2"].entries()) {
    const t = i * 60_000;
    const claimed = await breaker.claimStart(AGENT, claimInput(launchId, t));
    assert.ok(claimed.ok, `claim ${launchId}`);
    await breaker.recordProcessSpawned(AGENT, t, { launchId, daemonInstanceId: D1, processInstanceId: `pi-${launchId}` });
    await breaker.recordTerminalFailure(AGENT, e1(launchId), { nowMs: t + 1_000, unreadCeilings: {} });
    await breaker.recordProcessExited(AGENT, { daemonInstanceId: D1, processInstanceId: `pi-${launchId}`, spawnLaunchId: launchId, launchId, atMs: t + 2_000 });
  }
  const state = await breaker.read(AGENT, 70_000);
  assert.equal(state.state, "open");
  return state.blockedUntilMs!;
}

/** Runs `beforeScript` once, between the claim's reads and its combined compare-and-set. */
class InterleavingStore implements TerminalFailureBreakerStore {
  beforeScript: (() => Promise<void>) | null = null;
  scriptCalls = 0;
  constructor(readonly inner: InMemoryTerminalFailureBreakerStore) {}
  getTerminalFailureBreakerState(agentId: string) { return this.inner.getTerminalFailureBreakerState(agentId); }
  compareAndSetTerminalFailureBreakerState(agentId: string, v: number, s: Parameters<InMemoryTerminalFailureBreakerStore["compareAndSetTerminalFailureBreakerState"]>[2]) {
    return this.inner.compareAndSetTerminalFailureBreakerState(agentId, v, s);
  }
  getWakeCrashLoopState(agentId: string) { return this.inner.getWakeCrashLoopState(agentId); }
  async compareAndSetTerminalAndWakeCrashLoop(agentId: string, write: TerminalAndWakeCrashLoopWrite) {
    this.scriptCalls += 1;
    const hook = this.beforeScript;
    this.beforeScript = null;
    if (hook) await hook();
    return this.inner.compareAndSetTerminalAndWakeCrashLoop(agentId, write);
  }
}

test("H-12 (in-memory) a #1119 exit CAS between the reads and the combined write: nothing is written and the #1119 reason wins", async () => {
  const wakeStore = new InMemoryWakeCrashLoopStateStore();
  const store = new InterleavingStore(new InMemoryTerminalFailureBreakerStore(wakeStore));
  const breaker = new TerminalFailureBreaker(store, WAKE_RULES);
  const wakeBreaker = new WakeCrashLoopBreaker(wakeStore, WAKE_RULES);
  const probeAt = await openBreaker(breaker);
  const terminalBefore = store.inner.getRawForTest(AGENT);
  const wakeVersionBefore = (await wakeStore.getWakeCrashLoopState(AGENT))!.version;

  store.scriptCalls = 0;
  store.beforeScript = async () => {
    const counted = await wakeBreaker.recordExit(AGENT, processExit("L2"), probeAt);
    assert.equal(counted.blockedNow, true, "the concurrent exit blocks #1119");
  };
  const result = await breaker.claimStart(AGENT, claimInput("P", probeAt));
  assert.deepEqual(result, { ok: false, reason: "wake_crash_loop_blocked" });
  assert.equal(store.scriptCalls, 1, "the re-read decides without a second write attempt");
  assert.deepEqual(store.inner.getRawForTest(AGENT), terminalBefore, "terminal record byte-identical, same version");
  assert.equal((await wakeStore.getWakeCrashLoopState(AGENT))!.version, wakeVersionBefore + 1, "only the exit wrote #1119");
});

test("H-12 (in-memory, mirror) the combined write lands first; the exit's CAS then fails and retries against the claimed start", async () => {
  const wakeStore = new InMemoryWakeCrashLoopStateStore();
  const store = new InMemoryTerminalFailureBreakerStore(wakeStore);
  const breaker = new TerminalFailureBreaker(store, WAKE_RULES);
  const wakeBreaker = new WakeCrashLoopBreaker(wakeStore, WAKE_RULES);
  const probeAt = await openBreaker(breaker);
  const staleRead = (await wakeStore.getWakeCrashLoopState(AGENT))!;

  const claimed = await breaker.claimStart(AGENT, claimInput("P", probeAt));
  assert.ok(claimed.ok);
  assert.equal((await breaker.read(AGENT, probeAt)).state, "half_open");
  const afterScript = (await wakeStore.getWakeCrashLoopState(AGENT))!;
  assert.equal(afterScript.version, staleRead.version + 1);
  assert.equal(afterScript.state.lastStartLaunchId, "P");
  // The exit computed against the stale read cannot land.
  const staleWrite = { ...staleRead.state, earlyExitCount: 1, blocked: true, lastStartCounted: true };
  assert.equal(await wakeStore.compareAndSetWakeCrashLoopState(AGENT, staleRead.version, staleWrite), false);
  // Retried against the claimed state, #1119 rules apply to the new launch.
  assert.equal((await wakeBreaker.recordExit(AGENT, processExit("L2"), probeAt + 1)).rejected, "launch_mismatch");
  assert.equal((await wakeBreaker.recordExit(AGENT, processExit("P"), probeAt + 2)).counted, true);
});

test("H-12 (in-memory, sync) one synchronous function over both local stores writes both or refuses with no write", () => {
  const wakeStore = new InMemoryWakeCrashLoopStateStore();
  const store = new InMemoryTerminalFailureBreakerStore(wakeStore);
  const first = claimTerminalAndWakeCrashLoopStartSync(store, AGENT, claimInput("L1", 0));
  assert.ok(first.ok);
  assert.equal(store.getRawForTest(AGENT)?.version, 1);
  assert.equal(wakeStore.getWakeCrashLoopStateSync(AGENT)?.version, 1);
  assert.equal(first.crashLoopVersion, 1);
  // #1119 blocked → refuse, no write to either key.
  const blocked = wakeStore.getWakeCrashLoopStateSync(AGENT)!;
  assert.ok(wakeStore.compareAndSetWakeCrashLoopStateSync(AGENT, blocked.version, { ...blocked.state, blocked: true }));
  const refused = claimTerminalAndWakeCrashLoopStartSync(store, AGENT, claimInput("L2", 1_000));
  assert.deepEqual(refused, { ok: false, reason: "wake_crash_loop_blocked" });
  assert.equal(store.getRawForTest(AGENT)?.version, 1);
  assert.equal(wakeStore.getWakeCrashLoopStateSync(AGENT)?.version, 2);
});

test("combined write compares BOTH versions: a moved terminal version writes neither key", async () => {
  const wakeStore = new InMemoryWakeCrashLoopStateStore();
  const store = new InMemoryTerminalFailureBreakerStore(wakeStore);
  const terminal = terminalStateFromStored(await store.getTerminalFailureBreakerState(AGENT), 0);
  const decision = decideCombinedClaim(terminal, { state: freshWakeCrashLoopEpisode(1), version: 0 }, claimInput("L1", 0));
  assert.equal(decision.kind, "write");
  if (decision.kind !== "write") return;
  // A concurrent terminal-only write moves the terminal version.
  assert.ok(await store.compareAndSetTerminalFailureBreakerState(AGENT, 0, terminal.state));
  assert.equal(await store.compareAndSetTerminalAndWakeCrashLoop(AGENT, decision.write), false);
  assert.equal(await wakeStore.getWakeCrashLoopState(AGENT), null, "the #1119 key was not written");
});

test("H-1 (store level) five concurrent automatic wakes after blockedUntil: exactly one claims the probe", async () => {
  const breaker = new TerminalFailureBreaker(new InMemoryTerminalFailureBreakerStore(), WAKE_RULES);
  const probeAt = await openBreaker(breaker);
  const results = await Promise.all([1, 2, 3, 4, 5].map((i) => breaker.claimStart(AGENT, claimInput(`W${i}`, probeAt))));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.deepEqual(results.filter((r) => !r.ok).map((r) => !r.ok && r.reason), Array(4).fill("terminal_failure_probe_in_flight"));
});

test("H-13 (store level) a loser writes nothing; a winner's rollback after a later claim is skipped on both keys", async () => {
  const wakeStore = new InMemoryWakeCrashLoopStateStore();
  const store = new InMemoryTerminalFailureBreakerStore(wakeStore);
  const breaker = new TerminalFailureBreaker(store, WAKE_RULES);
  const wakeBreaker = new WakeCrashLoopBreaker(wakeStore, WAKE_RULES);
  const probeAt = await openBreaker(breaker);

  // W2 snapshots both records before W1 claims.
  const w2Terminal = terminalStateFromStored(await store.getTerminalFailureBreakerState(AGENT), probeAt);
  const w2Wake = (await wakeStore.getWakeCrashLoopState(AGENT))!;
  const w2Decision = decideCombinedClaim(w2Terminal, w2Wake, claimInput("W2", probeAt), WAKE_RULES);
  assert.equal(w2Decision.kind, "write");

  const w1 = await breaker.claimStart(AGENT, claimInput("W1", probeAt));
  assert.ok(w1.ok);
  const afterW1 = { terminal: store.getRawForTest(AGENT), wake: await wakeStore.getWakeCrashLoopState(AGENT) };

  if (w2Decision.kind === "write") assert.equal(await store.compareAndSetTerminalAndWakeCrashLoop(AGENT, w2Decision.write), false);
  assert.deepEqual(await breaker.claimStart(AGENT, claimInput("W2", probeAt)), { ok: false, reason: "terminal_failure_probe_in_flight" });
  assert.deepEqual({ terminal: store.getRawForTest(AGENT), wake: await wakeStore.getWakeCrashLoopState(AGENT) }, afterW1, "W2 wrote nothing");
  assert.equal((await breaker.read(AGENT, probeAt)).currentLaunch?.launchId, "W1");
  assert.equal(afterW1.wake?.state.lastStartLaunchId, "W1");

  // W3 (a human start) claims; then W1's dispatch fails.
  const w3 = await breaker.claimStart(AGENT, claimInput("W3", probeAt + 10, { control: "human_start", human: true }));
  assert.ok(w3.ok);
  assert.ok(w1.ok);
  assert.equal(await breaker.rollbackClaim(AGENT, w1.token, { nowMs: probeAt + 20, dispatchLeftReplica: false }), "rollback_skipped_not_owner");
  assert.equal(await wakeBreaker.rollbackStart(AGENT, w1.crashLoopStart), false);
  const final = await breaker.read(AGENT, probeAt + 20);
  assert.equal(final.currentLaunch?.launchId, "W3");
  assert.equal(final.state, "closed");
});

test("C-5 (store level) an ignored frame does not write: the record version is unchanged", async () => {
  const store = new InMemoryTerminalFailureBreakerStore();
  const breaker = new TerminalFailureBreaker(store);
  await breaker.claimStart(AGENT, claimInput("L1", 0));
  await breaker.recordProcessExited(AGENT, { daemonInstanceId: D1, processInstanceId: "pi", spawnLaunchId: "L1", launchId: "L1", atMs: 1 });
  await breaker.claimStart(AGENT, claimInput("L2", 10));
  const before = store.getRawForTest(AGENT);
  const late = await breaker.recordTerminalFailure(AGENT, e1("L1"), { nowMs: 20, unreadCeilings: {} });
  assert.equal(late.ignored, "launch_mismatch");
  assert.deepEqual(store.getRawForTest(AGENT), before);
});

test("R-7 (store level) a corrupt record reads as closed + owedOverflow; the next claim overwrites it at its version", async () => {
  const store = new InMemoryTerminalFailureBreakerStore();
  const breaker = new TerminalFailureBreaker(store);
  store.setRawForTest(AGENT, "{\"schema\":1,\"state\":\"open\"");
  const read = await breaker.read(AGENT, 5);
  assert.equal(read.state, "closed");
  assert.equal(read.catchupObligation?.owedOverflow, true);
  assert.equal(read.diagnostics.lastClosedReason, "state_unreadable");
  assert.equal(await breaker.gate(AGENT, { nowMs: 6, capability: true, wakeMessage: null }), "pass");
  const claimed = await breaker.claimStart(AGENT, claimInput("L1", 7));
  assert.ok(claimed.ok);
  const stored = store.getRawForTest(AGENT)!;
  assert.equal(stored.version, 2);
  const after = await breaker.read(AGENT, 8);
  assert.equal(after.catchupObligation?.owedOverflow, true, "the owed-everything obligation is persisted, not dropped");
  assert.equal(encodeTerminalFailureBreakerState(after), stored.raw);
});
