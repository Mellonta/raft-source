import assert from "node:assert/strict";
import {
  InMemoryWakeCrashLoopStateStore,
  WakeCrashLoopBreaker,
  type WakeCrashLoopEpisodeState,
  type WakeCrashLoopExit,
  type WakeCrashLoopStateRecord,
  type WakeCrashLoopStateStore,
} from "./wakeCrashLoopBreaker";

// task #1119 — breaker rules (60s window, K=3 consecutive process exits with
// evidence + matching launchId, human start resets) over a shared CAS store.

const processExit = (launchId: string, signal: string | null = "SIGTERM", code: number | null = null): WakeCrashLoopExit => ({
  kind: "agent_process_exited",
  evidence: { code, signal },
  launchId,
});

test("three consecutive early process exits block; the third is the only blockedNow", async () => {
  const b = new WakeCrashLoopBreaker();
  let t = 0;
  const outcomes: boolean[] = [];
  for (let i = 0; i < 3; i++) {
    await b.recordStart("a", `launch-${i}`, t);
    const o = await b.recordExit("a", processExit(`launch-${i}`), t + 10_000);
    assert.equal(o.counted, true);
    outcomes.push(o.blockedNow);
    t += 15_000;
  }
  assert.deepEqual(outcomes, [false, false, true]);
  assert.equal(await b.isBlocked("a"), true);
  assert.equal((await b.snapshot("a")).earlyExitCount, 3);
  assert.equal((await b.snapshot("a")).lastLaunchId, "launch-2");
});

test("two early exits then a run that survives the window reset the streak", async () => {
  const b = new WakeCrashLoopBreaker();
  await b.recordStart("a", "l1", 0);
  await b.recordExit("a", processExit("l1"), 5_000);
  await b.recordStart("a", "l2", 10_000);
  await b.recordExit("a", processExit("l2"), 15_000);
  await b.recordStart("a", "l3", 20_000);
  // l3 lives past the window; the next start sees a broken streak.
  await b.recordStart("a", "l4", 100_000);
  const o = await b.recordExit("a", processExit("l4"), 105_000);
  assert.equal(o.counted, true);
  assert.equal(o.blockedNow, false);
  assert.equal((await b.snapshot("a")).earlyExitCount, 1);
});

test("an exit outside the window, a second exit for the same start, or an exit while blocked is not counted", async () => {
  const b = new WakeCrashLoopBreaker(undefined, { threshold: 1 });
  await b.recordStart("a", "l1", 0);
  assert.equal((await b.recordExit("a", processExit("l1"), 61_000)).rejected, "outside_window");
  await b.recordStart("a", "l2", 100_000);
  assert.equal((await b.recordExit("a", processExit("l2"), 100_500)).blockedNow, true);
  assert.equal((await b.recordExit("a", processExit("l2"), 100_600)).rejected, "already_blocked");
  assert.equal(await b.isBlocked("a"), true);
  // Not blocked, same start twice: the second is a duplicate.
  const c = new WakeCrashLoopBreaker();
  await c.recordStart("a", "l1", 0);
  assert.equal((await c.recordExit("a", processExit("l1"), 1_000)).counted, true);
  assert.equal((await c.recordExit("a", processExit("l1"), 1_100)).rejected, "already_counted");
});

// Review counterexample (task #1126): three WebSocket closes with no signal and
// no launch must not arm the breaker. A transport loss is not runner death.
test("machine disconnects are never early exits: three in a row leave automatic wakes allowed", async () => {
  const b = new WakeCrashLoopBreaker();
  for (let i = 0; i < 3; i++) {
    await b.recordStart("a", `l${i}`, i * 20_000);
    const o = await b.recordExit("a", { kind: "machine_disconnected", evidence: null, launchId: null }, i * 20_000 + 10_000);
    assert.equal(o.counted, false);
    assert.equal(o.rejected, "not_process_exit");
  }
  assert.equal(await b.isBlocked("a"), false);
  assert.equal((await b.snapshot("a")).earlyExitCount, 0);
});

test("an inactive frame without exit evidence, or with a launchId that is not the current start, is not counted", async () => {
  const b = new WakeCrashLoopBreaker(undefined, { threshold: 1 });
  await b.recordStart("a", "l1", 0);
  assert.equal((await b.recordExit("a", { kind: "agent_process_exited", evidence: null, launchId: "l1" }, 1_000)).rejected, "no_exit_evidence");
  assert.equal((await b.recordExit("a", processExit("l0"), 1_000)).rejected, "launch_mismatch");
  assert.equal((await b.recordExit("a", { kind: "agent_process_exited", evidence: { code: 1, signal: null }, launchId: null }, 1_000)).rejected, "launch_mismatch");
  assert.equal(await b.isBlocked("a"), false);
  // A start without a launchId cannot be bound, so nothing counts against it.
  const c = new WakeCrashLoopBreaker(undefined, { threshold: 1 });
  await c.recordStart("a", null, 0);
  assert.equal((await c.recordExit("a", processExit("l1"), 1_000)).rejected, "no_start");
  assert.equal(await c.isBlocked("a"), false);
  // Exit code without a signal is still process-exit evidence.
  await b.recordStart("a", "l2", 5_000);
  assert.equal((await b.recordExit("a", processExit("l2", null, 1), 6_000)).blockedNow, true);
});

test("only a human start lifts a block and opens a new episode; manual stop forgets the streak", async () => {
  const b = new WakeCrashLoopBreaker(undefined, { threshold: 2 });
  await b.recordStart("a", "l1", 0);
  await b.recordExit("a", processExit("l1"), 1_000);
  await b.recordStart("a", "l2", 2_000);
  await b.recordExit("a", processExit("l2"), 3_000);
  assert.equal(await b.isBlocked("a"), true);
  // An automatic start attempt does not lift the block.
  await b.recordStart("a", "l3", 4_000);
  assert.equal(await b.isBlocked("a"), true);
  await b.recordStart("a", "l4", 5_000, { human: true });
  assert.equal(await b.isBlocked("a"), false);
  assert.equal((await b.snapshot("a")).episode, 2);
  assert.equal((await b.snapshot("a")).earlyExitCount, 0);
  // One early exit in the new episode counts but does not block yet.
  assert.equal((await b.recordExit("a", processExit("l4", "SIGKILL"), 6_000)).blockedNow, false);
  await b.recordManualStop("a");
  assert.equal((await b.snapshot("a")).earlyExitCount, 0);
  assert.equal((await b.snapshot("a")).episode, 2);
});

// Review counterexample (task #1126): a block must outlive the process that
// armed it. A second breaker on the same shared store (a replica switch or a
// restart) must see the block; a human start on either side lifts it for both.
test("a block is read back by a fresh breaker on the same shared store; only a human start on any replica lifts it", async () => {
  const store = new InMemoryWakeCrashLoopStateStore();
  const replicaA = new WakeCrashLoopBreaker(store);
  for (let i = 0; i < 3; i++) {
    await replicaA.recordStart("a", `l${i}`, i * 20_000);
    await replicaA.recordExit("a", processExit(`l${i}`), i * 20_000 + 10_000);
  }
  assert.equal(await replicaA.isBlocked("a"), true, "positive control");

  const replicaB = new WakeCrashLoopBreaker(store);
  assert.equal(await replicaB.isBlocked("a"), true, "the replacement owner must not start unblocked");
  await replicaB.recordStart("a", "l3", 70_000);
  assert.equal(await replicaB.isBlocked("a"), true, "an automatic start on the new replica does not lift it");
  assert.equal(await replicaA.isBlocked("a"), true);

  await replicaB.recordStart("a", "l4", 80_000, { human: true });
  assert.equal(await replicaB.isBlocked("a"), false);
  assert.equal(await replicaA.isBlocked("a"), false, "the old replica reads the lifted block through the store");
  assert.equal((await replicaA.snapshot("a")).episode, 2);
});

// Locked by Huaihuai (#proj-runtime:3ddaa7c2): a late exit from the previous
// episode's launch must not re-block after a human start/resume.
test("a late exit from an old launch after a human start does not count against the new episode", async () => {
  const b = new WakeCrashLoopBreaker(undefined, { threshold: 3 });
  await b.recordStart("a", "l1", 0);
  await b.recordExit("a", processExit("l1"), 1_000);
  await b.recordStart("a", "l2", 2_000);
  await b.recordExit("a", processExit("l2"), 3_000);
  assert.equal((await b.snapshot("a")).earlyExitCount, 2);
  // Human resumes with l3 before l2's late exit frame arrives (or a replayed l2).
  await b.recordStart("a", "l3", 4_000, { human: true });
  const late = await b.recordExit("a", processExit("l2"), 4_500);
  assert.equal(late.counted, false);
  assert.equal(late.rejected, "launch_mismatch");
  assert.equal(await b.isBlocked("a"), false);
  assert.equal((await b.snapshot("a")).episode, 2);
  assert.equal((await b.snapshot("a")).earlyExitCount, 0);
  // And an exit that really belongs to l3 counts as the first of the new episode.
  assert.equal((await b.recordExit("a", processExit("l3"), 5_000)).counted, true);
  assert.equal((await b.snapshot("a")).earlyExitCount, 1);
});

/** A store whose next N reads are held until released, so N writers observe the same version before any writes. */
class GatedWakeCrashLoopStateStore implements WakeCrashLoopStateStore {
  private readonly inner = new InMemoryWakeCrashLoopStateStore();
  private holdRemaining = 0;
  private readonly heldReads: Array<() => void> = [];
  private allHeld: (() => void) | null = null;

  /** Resolves once `count` reads are parked. */
  holdNextReads(count: number): Promise<void> {
    this.holdRemaining = count;
    return new Promise((resolve) => {
      this.allHeld = resolve;
    });
  }

  releaseHeldReads(): void {
    for (const release of this.heldReads.splice(0)) release();
  }

  async getWakeCrashLoopState(agentId: string): Promise<WakeCrashLoopStateRecord | null> {
    if (this.holdRemaining > 0) {
      this.holdRemaining -= 1;
      await new Promise<void>((release) => {
        this.heldReads.push(release);
        if (this.holdRemaining === 0) this.allHeld?.();
      });
    }
    return this.inner.getWakeCrashLoopState(agentId);
  }

  compareAndSetWakeCrashLoopState(agentId: string, expectedVersion: number, state: WakeCrashLoopEpisodeState): Promise<boolean> {
    return this.inner.compareAndSetWakeCrashLoopState(agentId, expectedVersion, state);
  }
}

// Locked by Huaihuai/XX (#proj-runtime:3ddaa7c2): read-count→increment→write
// must be atomic on the shared store. Two writers that both read the same
// state must not lose a count. RED with a plain get/set store: the start's
// stale write overwrites the exit's increment and the third exit lands on 2.
test("concurrent writers on the shared store never lose an early-exit count", async () => {
  const store = new GatedWakeCrashLoopStateStore();
  const b = new WakeCrashLoopBreaker(store);
  await b.recordStart("a", "l1", 0);
  await b.recordExit("a", processExit("l1"), 1_000);
  await b.recordStart("a", "l2", 2_000);
  assert.equal((await b.snapshot("a")).earlyExitCount, 1);

  // Writer 1 (owner replica): l2's early exit. Writer 2 (a replica handling the
  // next automatic wake): start l3. Both read before either writes.
  const bothRead = store.holdNextReads(2);
  const exitWrite = b.recordExit("a", processExit("l2"), 3_000);
  const startWrite = b.recordStart("a", "l3", 3_000);
  await bothRead;
  store.releaseHeldReads();
  const [exitObservation] = await Promise.all([exitWrite, startWrite]);
  assert.equal(exitObservation.counted, true);

  const afterRace = await b.snapshot("a");
  assert.equal(afterRace.earlyExitCount, 2, "the exit's increment must survive the concurrent start");
  assert.equal((await store.getWakeCrashLoopState("a"))!.state.lastStartLaunchId, "l3", "the start's launch binding must survive too");

  const third = await b.recordExit("a", processExit("l3"), 4_000);
  assert.equal(third.counted, true);
  assert.equal(third.blockedNow, true, "K=3 is reached; a lost count would leave this at 2");
  assert.equal(await b.isBlocked("a"), true);
});

// Review counterexample (task #1126): the start must be on record before the
// dispatch can produce a visible exit; a send that fails must roll it back
// without touching a newer start.
test("rollbackStart undoes a start whose dispatch failed, but never a newer start or a counted exit", async () => {
  const b = new WakeCrashLoopBreaker(undefined, { threshold: 3 });
  await b.recordStart("a", "l1", 0);
  await b.recordExit("a", processExit("l1"), 1_000);
  const failed = await b.recordStart("a", "l2", 2_000);
  assert.equal(await b.rollbackStart("a", failed), true);
  const after = await b.snapshot("a");
  assert.equal(after.earlyExitCount, 1, "the streak from l1 is untouched");
  // The rolled-back start is gone: an exit for l2 binds to nothing.
  assert.equal((await b.recordExit("a", processExit("l2"), 2_500)).rejected, "launch_mismatch");

  // A newer start supersedes the token: rolling back the old one is a no-op.
  const stale = await b.recordStart("a", "l3", 3_000);
  await b.recordStart("a", "l4", 4_000);
  assert.equal(await b.rollbackStart("a", stale), false);
  assert.equal((await b.recordExit("a", processExit("l4"), 4_500)).counted, true);

  // A counted exit pins the start: rolling back afterwards is a no-op.
  const counted = await b.recordStart("a", "l5", 5_000);
  await b.recordExit("a", processExit("l5"), 5_500);
  assert.equal(await b.rollbackStart("a", counted), false);
  assert.equal((await b.snapshot("a")).earlyExitCount, 3);
  assert.equal(await b.isBlocked("a"), true);
});

test("task #1221: a non-retryable start failure blocks at once, only for the current launch", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await breaker.recordStart("agent-1", "launch-a", 1_000);
  await breaker.recordStart("agent-1", "launch-b", 2_000);
  // A late failure from the previous launch must not block the current one.
  assert.equal(await breaker.recordNonRetryableStartFailure("agent-1", { launchId: "launch-a", reason: "model_not_configured", nowMs: 3_000 }), false);
  assert.equal(await breaker.isBlocked("agent-1"), false);
  assert.equal(await breaker.recordNonRetryableStartFailure("agent-1", { launchId: null, reason: "model_not_configured", nowMs: 3_000 }), false);
  // The current launch's failure blocks immediately (no threshold) and only once.
  assert.equal(await breaker.recordNonRetryableStartFailure("agent-1", { launchId: "launch-b", reason: "model_not_configured", nowMs: 3_000 }), true);
  assert.equal(await breaker.isBlocked("agent-1"), true);
  assert.equal(await breaker.recordNonRetryableStartFailure("agent-1", { launchId: "launch-b", reason: "model_not_configured", nowMs: 4_000 }), false);
});

test("task #1221: a config change or a human start lifts a start-failure block", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await breaker.recordStart("agent-1", "launch-a", 1_000);
  await breaker.recordNonRetryableStartFailure("agent-1", { launchId: "launch-a", reason: "runtime_login_required", nowMs: 1_500 });
  assert.equal(await breaker.liftForConfigChange("agent-1"), true);
  assert.equal(await breaker.isBlocked("agent-1"), false);
  assert.equal(await breaker.liftForConfigChange("agent-1"), false, "nothing to lift");

  await breaker.recordStart("agent-1", "launch-b", 2_000);
  await breaker.recordNonRetryableStartFailure("agent-1", { launchId: "launch-b", reason: "runtime_config_invalid", nowMs: 2_500 });
  await breaker.recordStart("agent-1", "launch-c", 3_000, { human: true });
  assert.equal(await breaker.isBlocked("agent-1"), false, "a human start opens a fresh episode");
});


test("task #1221: a config change before the old launch reports its failure stops that late failure from blocking", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await breaker.recordStart("agent-1", "launch-old", 1_000);
  // Configuration changes while the old start is still in flight (not blocked yet).
  assert.equal(await breaker.liftForConfigChange("agent-1"), false, "nothing was blocked");
  // The old start's failure arrives late.
  assert.equal(await breaker.recordNonRetryableStartFailure("agent-1", { launchId: "launch-old", reason: "model_not_configured", nowMs: 2_000 }), false);
  assert.equal(await breaker.isBlocked("agent-1"), false, "the next wake starts under the new configuration");
  // A start under the new configuration can still be blocked by its own failure.
  await breaker.recordStart("agent-1", "launch-new", 3_000);
  assert.equal(await breaker.recordNonRetryableStartFailure("agent-1", { launchId: "launch-new", reason: "model_not_configured", nowMs: 3_500 }), true);
});

test("task #1221: the block owes a catch-up; a config-change lift keeps it owed; only the carrying start's active report clears it", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await breaker.recordStart("agent-1", "launch-a", 1_000);
  assert.equal(await breaker.isCatchupOwed("agent-1"), false);
  await breaker.recordNonRetryableStartFailure("agent-1", { launchId: "launch-a", reason: "model_not_configured", nowMs: 1_500 });
  assert.equal(await breaker.isCatchupOwed("agent-1"), true);
  await breaker.liftForConfigChange("agent-1");
  assert.equal(await breaker.isBlocked("agent-1"), false);
  assert.equal(await breaker.isCatchupOwed("agent-1"), true, "lifted, still owed to the next start");
  await breaker.recordStart("agent-1", "launch-b", 2_000);
  assert.equal(await breaker.isCatchupOwed("agent-1"), true, "a dispatch alone does not deliver it");
  assert.equal(await breaker.confirmCatchupDelivered("agent-1", "launch-b"), false, "launch-b was not marked as the carrier");
  await breaker.markCatchupCarried("agent-1", "launch-b");
  assert.equal(await breaker.confirmCatchupDelivered("agent-1", "launch-b"), true);
  assert.equal(await breaker.isCatchupOwed("agent-1"), false);
});


test("task #1221: a manual stop keeps an undelivered catch-up owed and voids the old carrier", async () => {
  const breaker = new WakeCrashLoopBreaker(new InMemoryWakeCrashLoopStateStore());
  await breaker.recordStart("agent-1", "launch-a", 1_000);
  await breaker.recordNonRetryableStartFailure("agent-1", { launchId: "launch-a", reason: "model_not_configured", nowMs: 1_500 });
  await breaker.recordStart("agent-1", "launch-b", 2_000, { human: true });
  await breaker.markCatchupCarried("agent-1", "launch-b");
  await breaker.recordManualStop("agent-1");
  assert.equal(await breaker.isCatchupOwed("agent-1"), true, "the stop does not deliver it");
  assert.equal(await breaker.confirmCatchupDelivered("agent-1", "launch-b"), false, "the pre-stop carrier can no longer clear it");
});
