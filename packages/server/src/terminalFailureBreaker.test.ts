import assert from "node:assert/strict";
import {
  TERMINAL_BREAKER_UNREADABLE,
  TERMINAL_FAILURE_BACKOFF_MS,
  TERMINAL_FAILURE_PROBE_LEASE_MS,
  TERMINAL_FAILURE_UNEXITED_MAX,
  applyCatchupEcho,
  applyTerminalDaemonReady,
  applyTerminalFailureFrame,
  applyTerminalLift,
  applyTerminalManualStop,
  applyTerminalProcessExited,
  applyTerminalProcessSpawned,
  applyTerminalStartAck,
  applyTerminalStartRejectedBeforeSpawn,
  applyTurnCompletedFrame,
  attachCatchupBatch,
  buildCatchupBatch,
  catchupLowerBound,
  claimTerminalStart,
  decodeTerminalFailureBreakerState,
  encodeTerminalFailureBreakerState,
  evaluateTerminalWakeGate,
  freshTerminalFailureBreakerState,
  normalizeTerminalBreakerLease,
  raiseCatchupObligation,
  rollbackTerminalClaim,
  selectObligationCatchupCandidates,
  terminalBreakerStateFromUnreadable,
  terminalBreakerTtlSeconds,
  type CatchupBatch,
  type CatchupObligation,
  type ResumeCatchupCandidateInput,
  type TerminalClaimInput,
  type TerminalFailureBreakerState,
  type TerminalFailureFrame,
  type TurnCompletedFrame,
} from "./terminalFailureBreaker";

// RFC 071 part 1: the pure state machine. Test names carry the RFC test IDs.
// "State level" means the pure transitions; the orchestrator-facing halves of
// these IDs (routes, dispatch, spans) belong to the wiring part.

const H = 3_600_000;
const D1 = "daemon-1";
const SESSION = "S";
let clientSeq = 0;
const nextSeq = () => (clientSeq += 1);

function e1(launchId: string, fingerprint: string, seq = nextSeq(), sessionId: string | null = SESSION): TerminalFailureFrame {
  return { launchId, sessionId, daemonInstanceId: D1, clientSeq: seq, failureKind: "compaction_failed", fingerprint };
}

function e2(launchId: string, seq = nextSeq(), sessionId: string | null = SESSION, catchupBatchId: string | null = null): TurnCompletedFrame {
  return { launchId, sessionId, daemonInstanceId: D1, clientSeq: seq, catchupBatchId };
}

function claimInput(launchId: string, nowMs: number, extra: Partial<TerminalClaimInput> = {}): TerminalClaimInput {
  return { launchId, nowMs, resumedSessionId: SESSION, daemonInstanceId: D1, capability: true, control: "automatic", ...extra };
}

function claim(state: TerminalFailureBreakerState, launchId: string, nowMs: number, extra: Partial<TerminalClaimInput> = {}) {
  const result = claimTerminalStart(state, claimInput(launchId, nowMs, extra));
  if (!result.ok) throw new Error(`claim ${launchId} refused: ${result.reason}`);
  return result;
}

const pi = (launchId: string) => `pi-${launchId}`;

function spawned(state: TerminalFailureBreakerState, launchId: string, processInstanceId = pi(launchId)) {
  return applyTerminalProcessSpawned(state, { launchId, daemonInstanceId: D1, processInstanceId }).state;
}

function exited(state: TerminalFailureBreakerState, launchId: string, atMs: number, processInstanceId = pi(launchId)) {
  return applyTerminalProcessExited(state, { daemonInstanceId: D1, processInstanceId, spawnLaunchId: launchId, launchId, atMs }).state;
}

function failE1(state: TerminalFailureBreakerState, launchId: string, fingerprint: string, nowMs: number, unreadCeilings: Record<string, number> | null = {}) {
  const result = applyTerminalFailureFrame(state, e1(launchId, fingerprint), { nowMs, unreadCeilings });
  assert.equal(result.applied, true, `E1 for ${launchId} must apply, ignored=${result.ignored}`);
  return result;
}

function completeE2(state: TerminalFailureBreakerState, launchId: string, nowMs: number, catchupBatchId: string | null = null) {
  const result = applyTurnCompletedFrame(state, e2(launchId, nextSeq(), SESSION, catchupBatchId), { nowMs, persistedSessionId: null });
  assert.equal(result.applied, true, `E2 for ${launchId} must apply, ignored=${result.ignored}`);
  return result;
}

/** The field sequence of one failing launch: claim, spawn, E1, then the SIGTERMed process exits. */
function runFailing(state: TerminalFailureBreakerState, launchId: string, fingerprint: string, nowMs: number, unreadCeilings: Record<string, number> | null = {}) {
  let s = claim(state, launchId, nowMs).state;
  s = spawned(s, launchId);
  const failed = failE1(s, launchId, fingerprint, nowMs + 1_000, unreadCeilings);
  s = exited(failed.state, launchId, nowMs + 2_000);
  return { state: s, failed };
}

/** Open at step 0 after two same-fingerprint failures; returns the state and when the probe may run. */
function openedAtStep0(t0 = 0) {
  let s = runFailing(freshTerminalFailureBreakerState(), "L1", "fpA", t0).state;
  const second = runFailing(s, "L2", "fpA", t0 + 60_000, { c1: 4 });
  s = second.state;
  assert.equal(s.state, "open");
  return { state: s, probeAt: s.blockedUntilMs! };
}

const gate = (state: TerminalFailureBreakerState, nowMs: number, extra: Partial<Parameters<typeof evaluateTerminalWakeGate>[1]> = {}) =>
  evaluateTerminalWakeGate(state, { nowMs, capability: true, wakeMessage: null, ...extra });

// --- Counting and opening ---

test("C-1 two same-fingerprint E1s from L1 and L2 open at step 0 with blockedUntil = t + 1h", () => {
  let s = runFailing(freshTerminalFailureBreakerState(), "L1", "fpA", 0).state;
  assert.equal(s.state, "closed");
  assert.equal(s.sameFingerprint?.count, 1);
  const second = runFailing(s, "L2", "fpA", 600_000);
  s = second.state;
  assert.equal(second.failed.openedNow, true);
  assert.equal(second.failed.trigger, "same_fp");
  assert.equal(s.state, "open");
  assert.equal(s.backoffStep, 0);
  assert.equal(s.blockedUntilMs, 601_000 + H);
  assert.ok(s.catchupObligation, "opening opens a catch-up obligation");
});

test("C-2 three E1s with different fingerprints open through the total count", () => {
  let s = freshTerminalFailureBreakerState();
  s = runFailing(s, "L1", "fpA", 0).state;
  s = runFailing(s, "L2", "fpB", 10_000).state;
  assert.equal(s.state, "closed");
  const third = runFailing(s, "L3", "fpC", 20_000);
  assert.equal(third.failed.trigger, "total");
  assert.equal(third.state.state, "open");
  assert.equal(third.state.totalCount, 3);
});

test("C-3 E1, E2, E1 stays closed with count 1", () => {
  let s = runFailing(freshTerminalFailureBreakerState(), "L1", "fpA", 0).state;
  s = spawned(claim(s, "L2", 10_000).state, "L2");
  s = completeE2(s, "L2", 11_000).state;
  assert.equal(s.totalCount, 0);
  assert.equal(s.sameFingerprint, null);
  s = failE1(s, "L2", "fpA", 12_000).state;
  assert.equal(s.state, "closed");
  assert.equal(s.totalCount, 1);
  assert.equal(s.sameFingerprint?.count, 1);
});

test("C-4 a duplicate E1 for the same launch (newer seq) counts once: already_counted", () => {
  let s = spawned(claim(freshTerminalFailureBreakerState(), "L1", 0).state, "L1");
  s = failE1(s, "L1", "fpA", 1_000).state;
  const dup = applyTerminalFailureFrame(s, e1("L1", "fpA"), { nowMs: 1_500, unreadCeilings: {} });
  assert.equal(dup.applied, false);
  assert.equal(dup.ignored, "already_counted");
  assert.equal(dup.state, s, "ignored = no write");
  assert.equal(s.totalCount, 1);
});

test("C-5 an E1 from L1 after L2 was recorded is ignored as launch_mismatch with no state change", () => {
  let s = spawned(claim(freshTerminalFailureBreakerState(), "L1", 0).state, "L1");
  s = exited(s, "L1", 500);
  s = claim(s, "L2", 1_000).state;
  const before = encodeTerminalFailureBreakerState(s);
  const late = applyTerminalFailureFrame(s, e1("L1", "fpA"), { nowMs: 2_000, unreadCeilings: {} });
  assert.equal(late.applied, false);
  assert.equal(late.ignored, "launch_mismatch");
  assert.equal(encodeTerminalFailureBreakerState(late.state), before);
});

test("C-6 an E2 (seq 7) processed after an E1 (seq 9) from the same launch is ignored as stale_seq", () => {
  let s = spawned(claim(freshTerminalFailureBreakerState(), "L1", 0).state, "L1");
  s = applyTerminalFailureFrame(s, e1("L1", "fpA", 9), { nowMs: 1_000, unreadCeilings: {} }).state;
  const late = applyTurnCompletedFrame(s, e2("L1", 7), { nowMs: 1_100, persistedSessionId: SESSION });
  assert.equal(late.applied, false);
  assert.equal(late.ignored, "stale_seq");
  assert.equal(late.state.totalCount, 1);
});

test("C-7 (state level) while open, every automatic wake is refused paused, whatever triggered it, and the message is owed", () => {
  const { state } = openedAtStep0();
  const reminder = gate(state, state.blockedUntilMs! - 1);
  assert.equal(reminder.decision, "terminal_failure_paused");
  const message = gate(state, state.blockedUntilMs! - 1, { wakeMessage: { conversationId: "c-dm", seq: 11 } });
  assert.equal(message.decision, "terminal_failure_paused");
  assert.equal(message.state.catchupObligation?.owedCeilings["c-dm"], 11);
  const claimed = claimTerminalStart(message.state, claimInput("L3", state.blockedUntilMs! - 1));
  assert.deepEqual(claimed, { ok: false, reason: "terminal_failure_paused" });
});

test("C-8 fingerprints A, B, A: closed after the 2nd with {B,1}; the 3rd opens through total, not same_fp", () => {
  let s = runFailing(freshTerminalFailureBreakerState(), "L1", "fpA", 0).state;
  s = runFailing(s, "L2", "fpB", 10_000).state;
  assert.equal(s.state, "closed");
  assert.deepEqual(s.sameFingerprint, { fingerprint: "fpB", count: 1 });
  assert.equal(s.totalCount, 2);
  const third = runFailing(s, "L3", "fpA", 20_000);
  assert.deepEqual(third.state.sameFingerprint, { fingerprint: "fpA", count: 1 });
  assert.equal(third.state.totalCount, 3);
  assert.equal(third.failed.trigger, "total");
});

test("C-9 a recorded start, acks and a ready from the same daemon do not reset the count; a bound E2 does", () => {
  let s = runFailing(freshTerminalFailureBreakerState(), "L1", "fpA", 0).state;
  s = claim(s, "L2", 10_000).state;
  s = applyTerminalStartAck(s, { launchId: "L2", daemonInstanceId: D1, queueState: "starting", processInstanceId: null }).state;
  s = spawned(s, "L2");
  s = applyTerminalDaemonReady(s, { daemonInstanceId: D1, nowMs: 10_500 }).state;
  assert.equal(s.totalCount, 1);
  assert.equal(s.sameFingerprint?.count, 1);
  s = completeE2(s, "L2", 11_000).state;
  assert.equal(s.totalCount, 0);
  assert.equal(s.backoffStep, 0);
});

test("C-10 E2 keeps the launch current; the same launch's next-turn E1 counts (from 0), and L2's same-fp E1 opens", () => {
  let s = runFailing(freshTerminalFailureBreakerState(), "L0", "fpA", 0).state;
  s = spawned(claim(s, "L", 10_000).state, "L");
  const generation = s.generation;
  s = applyTurnCompletedFrame(s, e2("L", 5), { nowMs: 11_000, persistedSessionId: null }).state;
  assert.equal(s.totalCount, 0);
  assert.equal(s.currentLaunch?.launchId, "L");
  assert.equal(s.generation, generation);
  const nextTurn = applyTerminalFailureFrame(s, e1("L", "fpA", 9), { nowMs: 12_000, unreadCeilings: {} });
  assert.equal(nextTurn.applied, true, `L's E1 must count, ignored=${nextTurn.ignored}`);
  s = exited(nextTurn.state, "L", 12_500);
  assert.equal(s.state, "closed");
  assert.equal(s.totalCount, 1);
  assert.equal(s.currentLaunch?.terminal, "e1");
  const l2 = runFailing(s, "L2", "fpA", 20_000);
  assert.equal(l2.state.state, "open");
  assert.equal(l2.failed.trigger, "same_fp");
});

// --- half_open ---

test("H-2 before blockedUntil the claim fails paused and writes nothing", () => {
  const { state, probeAt } = openedAtStep0();
  assert.deepEqual(claimTerminalStart(state, claimInput("P", probeAt - 1)), { ok: false, reason: "terminal_failure_paused" });
  assert.equal(gate(state, probeAt - 1).write, false);
});

test("H-4 a probe whose dispatch fails goes to open, step 1, now + 4h, generation + 1", () => {
  const { state, probeAt } = openedAtStep0();
  const claimed = claim(state, "P", probeAt);
  assert.equal(claimed.state.state, "half_open");
  const rolled = rollbackTerminalClaim(claimed.state, claimed.token, { nowMs: probeAt + 10, dispatchLeftReplica: false });
  assert.equal(rolled.outcome, "restored");
  assert.equal(rolled.state.state, "open");
  assert.equal(rolled.state.backoffStep, 1);
  assert.equal(rolled.state.blockedUntilMs, probeAt + 10 + 4 * H);
  assert.equal(rolled.state.generation, state.generation + 1);
  assert.equal(rolled.state.unexited.length, 0, "a frame that never left the replica created no process");
});

test("H-6 the probe's process exits before any E2: open, step+", () => {
  const { state, probeAt } = openedAtStep0();
  let s = spawned(claim(state, "P", probeAt).state, "P");
  const exit = applyTerminalProcessExited(s, { daemonInstanceId: D1, processInstanceId: pi("P"), spawnLaunchId: "P", launchId: "P", atMs: probeAt + 5_000 });
  s = exit.state;
  assert.equal(exit.probeEnded, true);
  assert.equal(s.state, "open");
  assert.equal(s.backoffStep, 1);
  assert.equal(s.blockedUntilMs, probeAt + 5_000 + 4 * H);
  assert.equal(s.currentLaunch?.terminal, "process_exit");
  assert.equal(s.totalCount, 2, "exit is not a count");
});

test("H-7 an expired lease normalises lazily to open with blockedUntil = L + 4h; the wake is then refused", () => {
  const { state, probeAt } = openedAtStep0();
  const s = spawned(claim(state, "P", probeAt).state, "P");
  const lease = probeAt + TERMINAL_FAILURE_PROBE_LEASE_MS;
  assert.equal(normalizeTerminalBreakerLease(s, lease - 1).expired, false);
  const normalized = normalizeTerminalBreakerLease(s, lease + 999).state;
  assert.equal(normalized.state, "open");
  assert.equal(normalized.blockedUntilMs, lease + 4 * H, "from the stored lease, not the observation time");
  assert.equal(normalized.lastProbe?.launchId, "P");
  assert.equal(normalized.currentLaunch, null);
  assert.notEqual(gate(s, lease + 999).decision, "pass");
});

test("H-8 after lease expiry, a session-bound newer E2 from P with no newer launch closes with P current", () => {
  const { state, probeAt } = openedAtStep0();
  const s = spawned(claim(state, "P", probeAt).state, "P");
  const late = applyTurnCompletedFrame(s, e2("P"), { nowMs: probeAt + TERMINAL_FAILURE_PROBE_LEASE_MS + 60_000, persistedSessionId: null });
  assert.equal(late.applied, true);
  assert.equal(late.state.state, "closed");
  assert.equal(late.state.currentLaunch?.launchId, "P");
  assert.equal(late.state.backoffStep, 0);
  assert.equal(late.state.totalCount, 0);
});

test("H-8b after lease expiry and P's E1 (seq 9), P's E2 is ignored at seq 7 and at seq 11; the state stays open", () => {
  const { state, probeAt } = openedAtStep0();
  const s = spawned(claim(state, "P", probeAt).state, "P");
  const afterLease = probeAt + TERMINAL_FAILURE_PROBE_LEASE_MS + 1;
  const lateE1 = applyTerminalFailureFrame(s, e1("P", "fpA", 9), { nowMs: afterLease, unreadCeilings: {} });
  assert.equal(lateE1.applied, true);
  assert.equal(lateE1.counted, false, "the probe was already charged by the lease expiry");
  assert.equal(lateE1.state.lastProbe?.terminal, "e1");
  for (const seq of [7, 11]) {
    const late = applyTurnCompletedFrame(lateE1.state, e2("P", seq), { nowMs: afterLease + 1, persistedSessionId: null });
    assert.equal(late.applied, false, `seq ${seq}`);
    assert.equal(late.ignored, seq === 7 ? "stale_seq" : "after_terminal");
  }
  assert.equal(lateE1.state.state, "open");
});

test("H-9 step escalation: 1h, 4h, 24h, 24h", () => {
  let { state: s, probeAt } = openedAtStep0();
  const durations = [s.blockedUntilMs! - s.lastFailure!.atMs];
  for (let i = 0; i < 3; i++) {
    s = spawned(claim(s, `P${i}`, probeAt).state, `P${i}`);
    const failed = failE1(s, `P${i}`, "fpA", probeAt + 1_000);
    durations.push(failed.state.blockedUntilMs! - (probeAt + 1_000));
    s = exited(failed.state, `P${i}`, probeAt + 2_000);
    probeAt = s.blockedUntilMs!;
  }
  assert.deepEqual(durations, [H, 4 * H, 24 * H, 24 * H]);
  assert.equal(s.backoffStep, TERMINAL_FAILURE_BACKOFF_MS.length - 1);
});

test("H-10 (a) the probe's E1 opens at step 1 (+4h); (b) its E2 closes, P stays current, the next wake passes, P's next E1 counts", () => {
  const { state, probeAt } = openedAtStep0();
  const probing = spawned(claim(state, "P", probeAt).state, "P");
  const a = failE1(probing, "P", "fpA", probeAt + 1_000);
  assert.equal(a.state.state, "open");
  assert.equal(a.state.backoffStep, 1);
  assert.equal(a.state.blockedUntilMs, probeAt + 1_000 + 4 * H);

  const b = completeE2(probing, "P", probeAt + 1_000);
  assert.equal(b.closedNow, true);
  assert.equal(b.state.state, "closed");
  assert.equal(b.state.totalCount, 0);
  assert.equal(b.state.backoffStep, 0);
  assert.equal(b.state.currentLaunch?.launchId, "P");
  assert.equal(b.state.generation, probing.generation);
  assert.equal(gate(b.state, probeAt + 2_000).decision, "pass", "P's own live process does not block in closed");
  const next = failE1(b.state, "P", "fpA", probeAt + 3_000);
  assert.equal(next.counted, true);
  assert.equal(next.state.totalCount, 1);
});

test("H-11 (state level) lease expiry is not 'stopped': the next automatic wake needs manual; a human start proceeds and a rebind marks takeover", () => {
  const { state, probeAt } = openedAtStep0();
  const s = spawned(claim(state, "P", probeAt).state, "P");
  const afterBackoff = probeAt + TERMINAL_FAILURE_PROBE_LEASE_MS + 4 * H + 1;
  const refused = gate(s, afterBackoff);
  assert.equal(refused.decision, "terminal_failure_needs_manual");
  assert.equal(refused.state.state, "open");
  assert.equal(refused.state.needsManual?.reason, "unexited_process");
  assert.deepEqual(claimTerminalStart(refused.state, claimInput("P2", afterBackoff)), { ok: false, reason: "terminal_failure_needs_manual" });
  const human = claim(refused.state, "H1", afterBackoff, { control: "human_start" });
  const ack = applyTerminalStartAck(human.state, { launchId: "H1", daemonInstanceId: D1, queueState: "running", processInstanceId: pi("P") });
  assert.equal(ack.state.currentLaunch?.takeover, true);
});

test("H-11b E1 alone is not exit evidence; the exit frame for P's process is", () => {
  const { state, probeAt } = openedAtStep0();
  const probing = spawned(claim(state, "P", probeAt).state, "P");
  const failed = failE1(probing, "P", "fpA", probeAt + 1_000).state;
  const after = failed.blockedUntilMs! + 1;
  assert.equal(gate(failed, after).decision, "terminal_failure_needs_manual", "SIGTERM ignored: no exit frame");
  const withExit = exited(failed, "P", probeAt + 4_000);
  assert.equal(gate(withExit, after).decision, "pass");
  assert.equal(claim(withExit, "P2", after).state.state, "half_open");
});

test("H-11c after a human takeover, the old process's exit leaves acknowledgedUnexited and not the new process", () => {
  const { state, probeAt } = openedAtStep0();
  let s = spawned(claim(state, "P", probeAt).state, "P", "pi");
  s = failE1(s, "P", "fpA", probeAt + 1_000).state;
  s = spawned(claim(s, "P2", probeAt + 2_000, { control: "human_start" }).state, "P2", "pi2");
  assert.deepEqual(s.acknowledgedUnexited.map((e) => e.processInstanceId), ["pi"]);
  const exit = applyTerminalProcessExited(s, { daemonInstanceId: D1, processInstanceId: "pi", spawnLaunchId: "P", launchId: "P", atMs: probeAt + 3_000 });
  assert.equal(exit.outcome, "acknowledged_removed");
  assert.deepEqual(exit.state.acknowledgedUnexited, []);
  assert.deepEqual(exit.state.unexited.map((e) => e.processInstanceId), ["pi2"]);
});

test("H-11d a ready from a new daemon instance that omits the agent is not exit evidence: needs manual", () => {
  const { state, probeAt } = openedAtStep0();
  const s = spawned(claim(state, "P", probeAt).state, "P");
  const ready = applyTerminalDaemonReady(s, { daemonInstanceId: "daemon-2", nowMs: probeAt + 1_000 });
  assert.equal(ready.state.needsManual?.reason, "daemon_restarted_no_exit");
  assert.equal(ready.state.unexited.length, 1, "the entry stays");
  assert.equal(gate(ready.state, probeAt + TERMINAL_FAILURE_PROBE_LEASE_MS + 5 * H).decision, "terminal_failure_needs_manual");
});

test("E-7 manual stop in half_open → open, step unchanged, probe cleared", () => {
  const { state, probeAt } = openedAtStep0();
  const s = claim(state, "P", probeAt).state;
  const stopped = applyTerminalManualStop(s, { nowMs: probeAt + 1 });
  assert.equal(stopped.state.state, "open");
  assert.equal(stopped.state.backoffStep, 0);
  assert.equal(stopped.state.currentLaunch, null);
  assert.equal(applyTerminalManualStop(state, { nowMs: 1 }).write, false, "not half_open: no write");
});

// --- Recovery binding ---

test("R-2/R-3 after an E3 lift, the pre-lift launch's E1 and E2 are ignored", () => {
  let s = spawned(claim(freshTerminalFailureBreakerState(), "L1", 0).state, "L1");
  s = applyTerminalLift(s, { cause: "human_reset", nowMs: 1_000 });
  assert.equal(applyTerminalFailureFrame(s, e1("L1", "fpA"), { nowMs: 2_000, unreadCeilings: {} }).ignored, "no_current_launch");
  assert.equal(applyTurnCompletedFrame(s, e2("L1"), { nowMs: 2_000, persistedSessionId: SESSION }).ignored, "no_current_launch");
});

test("R-4 E2 with a sessionId that is neither the resumed nor the persisted one is session_unbound", () => {
  const s = spawned(claim(freshTerminalFailureBreakerState(), "L1", 0).state, "L1");
  const other = applyTurnCompletedFrame(s, e2("L1", nextSeq(), "S-other"), { nowMs: 1, persistedSessionId: "S-persisted" });
  assert.equal(other.ignored, "session_unbound");
  const nullSession = applyTurnCompletedFrame(s, e2("L1", nextSeq(), null), { nowMs: 1, persistedSessionId: "S-persisted" });
  assert.equal(nullSession.ignored, "session_unbound");
  assert.equal(applyTurnCompletedFrame(s, e2("L1", nextSeq(), "S-persisted"), { nowMs: 1, persistedSessionId: "S-persisted" }).applied, true);
});

test("R-5 a probe rollback after a concurrent lift is refused (the generation moved)", () => {
  const { state, probeAt } = openedAtStep0();
  const claimed = claim(state, "P", probeAt);
  const lifted = applyTerminalLift(claimed.state, { cause: "runtime_config_changed", nowMs: probeAt + 1 });
  const rolled = rollbackTerminalClaim(lifted, claimed.token, { nowMs: probeAt + 2, dispatchLeftReplica: false });
  assert.equal(rolled.outcome, "rollback_skipped_not_owner");
  assert.equal(rolled.state, lifted);
});

test("R-7 (a) an unreadable record reads as closed, state_unreadable, every unread row owed, and not a recovery", () => {
  assert.equal(decodeTerminalFailureBreakerState("{not json"), TERMINAL_BREAKER_UNREADABLE);
  assert.equal(decodeTerminalFailureBreakerState(JSON.stringify({ schema: 1, state: "open" })), TERMINAL_BREAKER_UNREADABLE);
  const s = terminalBreakerStateFromUnreadable(5_000);
  assert.equal(s.state, "closed");
  assert.equal(s.diagnostics.lastClosedReason, "state_unreadable");
  assert.equal(s.catchupObligation?.owedOverflow, true);
  assert.equal(s.lastTransition?.cause, "state_unreadable");
  assert.notEqual(s.lastTransition?.cause, "probe_e2");
  assert.equal(gate(s, 6_000).decision, "pass", "closed so the agent is not silenced");
});

// --- Codec ---

function everyFieldState(): TerminalFailureBreakerState {
  const launch = {
    launchId: "L9",
    generation: 4,
    resumedSessionId: "S9",
    isProbe: true,
    claimedAtMs: 1_000,
    leaseExpiresAtMs: 2_000,
    lastAppliedSeq: { daemonInstanceId: D1, clientSeq: 17 },
    terminal: "e1" as const,
    takeover: true,
    catchupBatchId: "B9",
  };
  const failure = { kind: "compaction_failed", fingerprint: "c4722931c8a1f172", launchId: "L9", sessionId: "S9", atMs: 1_500 };
  const batch: CatchupBatch = {
    batchId: "B9",
    launchId: "L9",
    builtAtMs: 1_100,
    coverage: [{ conversationId: "c1", fromSeqExclusive: 10, coveredUpToSeq: 15, truncated: true }],
    messages: [{ id: "m11", conversationId: "c1", seq: 11, inPrefix: true }, { id: "m18", conversationId: "c1", seq: 18, inPrefix: false }],
    candidateCapHit: true,
    allUnreadCovered: false,
  };
  return {
    schema: 1,
    state: "half_open",
    generation: 4,
    currentLaunch: launch,
    lastProbe: { ...launch, launchId: "L8", terminal: "process_exit", isProbe: true },
    needsManual: { reason: "daemon_restarted_no_exit", sinceMs: 1_200, causeEntries: [{ spawnLaunchId: "L6", daemonInstanceId: "daemon-0" }] },
    unexited: [{ spawnLaunchId: "L9", daemonInstanceId: D1, processInstanceId: "pi9", launchIds: ["L9", "L10"], dispatchedAtMs: 1_000, protected: true }],
    recentExits: [{ daemonInstanceId: D1, processInstanceId: "pi8", spawnLaunchId: "L8", atMs: 900 }, { daemonInstanceId: D1, processInstanceId: "pi-internal", spawnLaunchId: null, atMs: 950 }],
    unexitedOverflow: true,
    acknowledgedUnexited: [{ processInstanceId: "pi7", daemonInstanceId: D1, spawnLaunchId: "L7", ackedAtMs: 800, reason: "daemon_restarted_untracked" }],
    sameFingerprint: { fingerprint: "c4722931c8a1f172", count: 2 },
    totalCount: 3,
    backoffStep: 1,
    openedAtMs: 700,
    blockedUntilMs: 3_000,
    lastFailure: failure,
    catchupObligation: { owedCeilings: { c1: 18, "c-dm": 4 }, owedOverflow: true, obligationCursor: { c1: 15 }, pendingBatch: batch, engagedByFailure: true },
    diagnostics: { lastFailure: failure, lastClosedReason: "state_unreadable" },
    lastTransition: { from: "open", to: "half_open", cause: "probe_claimed", atMs: 1_000 },
    outboxWatermarks: { [D1]: 17, "daemon-0": 3 },
    outboxWatermarksLost: true,
    takeoverEpoch: 3,
  };
}

test("R-1 encode → decode is the identity for a record with every field populated", () => {
  const state = everyFieldState();
  for (const [key, value] of Object.entries(state)) {
    assert.ok(value !== null && !(Array.isArray(value) && value.length === 0), `fixture field ${key} must be populated`);
  }
  assert.deepEqual(decodeTerminalFailureBreakerState(encodeTerminalFailureBreakerState(state)), state);
  const fresh = freshTerminalFailureBreakerState();
  assert.deepEqual(decodeTerminalFailureBreakerState(encodeTerminalFailureBreakerState(fresh)), fresh);
});

test("R-1 a record missing any single top-level field is unreadable, not silently defaulted", () => {
  const encoded = JSON.parse(encodeTerminalFailureBreakerState(everyFieldState())) as Record<string, unknown>;
  for (const key of Object.keys(encoded)) {
    const { [key]: _dropped, ...rest } = encoded;
    assert.equal(decodeTerminalFailureBreakerState(JSON.stringify(rest)), TERMINAL_BREAKER_UNREADABLE, `missing ${key}`);
  }
});

test("TTL: persisted while open/half_open or while anything protective remains; 7 days only for an empty closed record", () => {
  assert.equal(terminalBreakerTtlSeconds(freshTerminalFailureBreakerState()), 7 * 86_400);
  assert.equal(terminalBreakerTtlSeconds(openedAtStep0().state), 0);
  const closedWithEntry = claim(freshTerminalFailureBreakerState(), "L1", 0).state;
  assert.equal(terminalBreakerTtlSeconds(closedWithEntry), 0);
  assert.equal(terminalBreakerTtlSeconds(terminalBreakerStateFromUnreadable(0)), 0, "owedOverflow must not expire");
});

// --- Coexistence: capability and unexited ---

test("X-4 (a) never protected: without the capability automatic wakes pass and nothing is recorded", () => {
  let s = freshTerminalFailureBreakerState();
  for (let i = 0; i < 5; i++) {
    const g = evaluateTerminalWakeGate(s, { nowMs: i, capability: false, wakeMessage: null });
    assert.equal(g.decision, "pass");
    s = claim(s, `L${i}`, i, { capability: false }).state;
  }
  assert.deepEqual(s.unexited, []);
  assert.equal(s.state, "closed");
});

test("X-4 (b) capability lost after protection: needs manual (outcome_unobservable), not closed; a human start takes over", () => {
  const { state, probeAt } = openedAtStep0();
  const refused = evaluateTerminalWakeGate(state, { nowMs: probeAt + 1, capability: false, wakeMessage: null });
  assert.equal(refused.decision, "terminal_failure_needs_manual");
  assert.equal(refused.state.needsManual?.reason, "outcome_unobservable");
  assert.equal(refused.state.state, "open");
  assert.deepEqual(refused.state.catchupObligation, state.catchupObligation);
  assert.deepEqual(refused.state.diagnostics, state.diagnostics);
  // One unexited entry is enough to count as protected.
  const oneEntry = claim(freshTerminalFailureBreakerState(), "L1", 0).state;
  const lifted = applyTerminalLift(oneEntry, { cause: "human_reset", nowMs: 1 });
  assert.equal(evaluateTerminalWakeGate(lifted, { nowMs: 2, capability: false, wakeMessage: null }).decision, "terminal_failure_needs_manual");
  const human = claim(lifted, "H1", 3, { capability: false, control: "human_start" });
  assert.deepEqual(human.state.unexited, []);
  assert.deepEqual(human.state.acknowledgedUnexited.map((e) => e.spawnLaunchId), ["L1"]);
});

test("X-5 (a) rebind: P on π, then P2 rebound onto π → one entry with [P, P2]; π's exit removes it", () => {
  let r = spawned(claim(freshTerminalFailureBreakerState(), "P", 0).state, "P", "pi");
  r = completeE2(r, "P", 500).state;
  r = claim(r, "P2", 1_000).state;
  const ack = applyTerminalStartAck(r, { launchId: "P2", daemonInstanceId: D1, queueState: "rebound", processInstanceId: "pi" });
  assert.equal(ack.outcome, "merged");
  assert.deepEqual(ack.state.unexited.map((e) => [e.processInstanceId, e.launchIds]), [["pi", ["P", "P2"]]]);
  assert.equal(ack.state.currentLaunch?.takeover, true);
  const exit = applyTerminalProcessExited(ack.state, { daemonInstanceId: D1, processInstanceId: "pi", spawnLaunchId: "P", launchId: "P2", atMs: 2_000 });
  assert.equal(exit.outcome, "removed");
  assert.deepEqual(exit.state.unexited, []);
});

test("X-5 (b) an exit with P's launchId but a different processInstanceId removes nothing (exit_unmatched)", () => {
  const s = spawned(claim(freshTerminalFailureBreakerState(), "P", 0).state, "P", "pi");
  const exit = applyTerminalProcessExited(s, { daemonInstanceId: D1, processInstanceId: "pi-other", spawnLaunchId: "P", launchId: "P", atMs: 1_000 });
  assert.equal(exit.outcome, "exit_unmatched");
  assert.deepEqual(exit.state.unexited, s.unexited);
  assert.equal(exit.state.currentLaunch?.terminal, null);
});

test("X-5 (c) human takeover: π moves to acknowledgedUnexited, P3 enters unexited; π's late exit removes it from there only", () => {
  let s = spawned(claim(freshTerminalFailureBreakerState(), "P", 0).state, "P", "pi");
  s = failE1(s, "P", "fpA", 100).state;
  s = spawned(claim(s, "P3", 1_000, { control: "human_start" }).state, "P3", "pi3");
  const exit = applyTerminalProcessExited(s, { daemonInstanceId: D1, processInstanceId: "pi", spawnLaunchId: "P", launchId: "P", atMs: 2_000 });
  assert.equal(exit.outcome, "acknowledged_removed");
  assert.deepEqual(exit.state.acknowledgedUnexited, []);
  assert.deepEqual(exit.state.unexited.map((e) => e.processInstanceId), ["pi3"]);
});

test("X-5 (d) an E3 reset without a start keeps π in unexited, and the next automatic wake is refused", () => {
  let s = spawned(claim(freshTerminalFailureBreakerState(), "P", 0).state, "P", "pi");
  s = failE1(s, "P", "fpA", 100).state;
  s = applyTerminalLift(s, { cause: "human_reset", nowMs: 1_000 });
  assert.equal(s.state, "closed");
  assert.equal(s.unexited.length, 1);
  assert.equal(gate(s, 2_000).decision, "terminal_failure_needs_manual");
});

test("X-5 (e) the bound: a ninth entry drops the oldest and sets overflow; exits for the other eight do not re-enable probes until a human start", () => {
  // Through the gate rules alone the set cannot grow past two entries (an
  // automatic claim is refused while any other entry exists; a human start
  // moves every entry aside), so the bound is defensive: exercise it on a
  // record that already holds eight entries of the live current launch.
  let s = spawned(claim(freshTerminalFailureBreakerState(), "Q0", 0).state, "Q0", "pq0");
  s = completeE2(s, "Q0", 1).state;
  for (let i = 1; i < TERMINAL_FAILURE_UNEXITED_MAX; i++) {
    s.unexited.push({ spawnLaunchId: "Q0", daemonInstanceId: D1, processInstanceId: `pq0-${i}`, launchIds: ["Q0"], dispatchedAtMs: i, protected: false });
  }
  assert.equal(s.unexited.length, TERMINAL_FAILURE_UNEXITED_MAX);
  s = claim(s, "Q9", 100).state;
  assert.equal(s.unexited.length, TERMINAL_FAILURE_UNEXITED_MAX);
  assert.equal(s.unexitedOverflow, true);
  assert.equal(s.unexited[0]!.processInstanceId, "pq0-1", "the oldest (pq0) was dropped");
  for (const entry of [...s.unexited]) {
    s = applyTerminalProcessExited(s, { daemonInstanceId: D1, processInstanceId: entry.processInstanceId ?? "pq9", spawnLaunchId: entry.spawnLaunchId, launchId: entry.spawnLaunchId, atMs: 200 }).state;
  }
  assert.deepEqual(s.unexited, []);
  assert.equal(gate(s, 300).decision, "terminal_failure_needs_manual", "overflow alone still refuses");
  const human = claim(s, "H", 400, { control: "human_start" });
  assert.equal(human.state.unexitedOverflow, false, "only a human start clears overflow");
});

test("X-6 (a) lost ack: the pre-dispatch entry stays and refuses the next automatic wake; process_spawned fills it and the exit removes it", () => {
  const { state, probeAt } = openedAtStep0();
  const probing = claim(state, "P", probeAt).state;
  assert.deepEqual(probing.unexited.map((e) => [e.spawnLaunchId, e.processInstanceId]), [["P", null]], "written in the claim, before dispatch");
  const afterLeaseAndBackoff = probeAt + TERMINAL_FAILURE_PROBE_LEASE_MS + 4 * H + 1;
  assert.equal(gate(probing, afterLeaseAndBackoff).decision, "terminal_failure_needs_manual");
  const filled = applyTerminalProcessSpawned(probing, { launchId: "P", daemonInstanceId: D1, processInstanceId: "pi" });
  assert.equal(filled.outcome, "filled");
  const gone = exited(filled.state, "P", probeAt + 10_000, "pi");
  assert.deepEqual(gone.unexited, []);
  assert.equal(gate(gone, afterLeaseAndBackoff).decision, "pass");
});

test("X-6 (b) an ack timeout is not 'not started': a rollback after the frame left the replica keeps the entry", () => {
  const { state, probeAt } = openedAtStep0();
  const claimed = claim(state, "P", probeAt);
  const rolled = rollbackTerminalClaim(claimed.state, claimed.token, { nowMs: probeAt + 30_000, dispatchLeftReplica: true });
  assert.equal(rolled.outcome, "restored");
  assert.deepEqual(rolled.state.unexited.map((e) => e.spawnLaunchId), ["P"]);
});

test("X-6 (c) an exit that overtakes the identity settles the pending entry; the late process_spawned creates no entry", () => {
  const s = claim(freshTerminalFailureBreakerState(), "P", 0).state;
  const exit = applyTerminalProcessExited(s, { daemonInstanceId: D1, processInstanceId: "pi", spawnLaunchId: "P", launchId: "P", atMs: 100 });
  assert.equal(exit.outcome, "removed");
  assert.deepEqual(exit.state.unexited, []);
  assert.deepEqual(exit.state.recentExits.map((e) => e.processInstanceId), ["pi"]);
  const late = applyTerminalProcessSpawned(exit.state, { launchId: "P", daemonInstanceId: D1, processInstanceId: "pi" });
  assert.equal(late.outcome, "settled_recent_exit");
  assert.deepEqual(late.state.unexited, []);
  const lateAck = applyTerminalStartAck(exit.state, { launchId: "P", daemonInstanceId: D1, queueState: "running", processInstanceId: "pi" });
  assert.deepEqual(lateAck.state.unexited, []);
});

test("X-6 (c) rebind variant: an ack naming a process that already exited settles the new launch's pending entry, no phantom entry", () => {
  // P runs on π and completes a turn; P2 is claimed (pending entry) and the
  // daemon rebinds it onto π; π then exits before the server processes the
  // ack. The exit carries π's own spawnLaunchId (P), so only recentExits can
  // settle P2's pending entry when the ack finally names π.
  let s = completeE2(spawned(claim(freshTerminalFailureBreakerState(), "P", 0).state, "P", "pi"), "P", 10).state;
  s = claim(s, "P2", 100).state;
  s = applyTerminalProcessExited(s, { daemonInstanceId: D1, processInstanceId: "pi", spawnLaunchId: "P", launchId: "P2", atMs: 200 }).state;
  assert.deepEqual(s.unexited.map((e) => [e.spawnLaunchId, e.processInstanceId]), [["P2", null]]);
  const ack = applyTerminalStartAck(s, { launchId: "P2", daemonInstanceId: D1, queueState: "running", processInstanceId: "pi" });
  assert.deepEqual(ack.state.unexited, [], "π is known to have exited: P2's pending entry settles instead of taking π's identity");
  assert.equal(gate(ack.state, 300).decision, "pass");
});

test("X-6 (d) a daemon restart with a pending entry (identity never arrived) → needs manual, daemon_restarted_no_exit", () => {
  const s = claim(freshTerminalFailureBreakerState(), "P", 0).state;
  const failed = applyTerminalFailureFrame(s, e1("P", "fpA"), { nowMs: 10, unreadCeilings: {} }).state;
  const ready = applyTerminalDaemonReady(failed, { daemonInstanceId: "daemon-2", nowMs: 20 });
  assert.equal(ready.state.needsManual?.reason, "daemon_restarted_no_exit");
  assert.equal(gate(ready.state, 30).decision, "terminal_failure_needs_manual");
});

test("X-6 (e) a start the daemon rejected before any spawn removes the pending entry", () => {
  const s = claim(freshTerminalFailureBreakerState(), "P", 0).state;
  const rejected = applyTerminalStartRejectedBeforeSpawn(s, { launchId: "P", daemonInstanceId: D1 });
  assert.equal(rejected.write, true);
  assert.deepEqual(rejected.state.unexited, []);
});

// --- Owed messages (§6) ---

function obligationOf(ceilings: Record<string, number>, cursor: Record<string, number> = {}): CatchupObligation {
  return { ...raiseCatchupObligation(null, ceilings), obligationCursor: cursor };
}

function stateWithObligation(obligation: CatchupObligation, launchId = "L"): TerminalFailureBreakerState {
  const s = spawned(claim(freshTerminalFailureBreakerState(), launchId, 0).state, launchId);
  s.catchupObligation = obligation;
  return s;
}

function batchFor(obligation: CatchupObligation | null, launchId: string, input: Partial<Parameters<typeof buildCatchupBatch>[1]>): CatchupBatch {
  return buildCatchupBatch(obligation, {
    batchId: `B-${launchId}-${nextSeq()}`,
    launchId,
    builtAtMs: 0,
    conversations: [],
    rendered: [],
    owedReadCursors: {},
    candidateCapHit: false,
    unreadLatestSeqs: {},
    ...input,
  });
}

/** Attach a batch to the current launch and echo it from a clean turn. */
function echo(state: TerminalFailureBreakerState, batch: CatchupBatch) {
  const attached = attachCatchupBatch(state, batch);
  assert.ok(attached.attached);
  return completeE2(attached.state, batch.launchId, 1, batch.batchId);
}

test("O-1 no batch (fetch failure): a clean E2 without an echo leaves the obligation unchanged", () => {
  const s = stateWithObligation(obligationOf({ dm: 1, c1: 2 }));
  const done = completeE2(s, "L", 1);
  assert.deepEqual(done.state.catchupObligation, s.catchupObligation);
  assert.equal(done.echoApplied, false);
});

test("O-2 truncation past the cap: covered conversations advance; an unreached one and the truncated remainder stay owed", () => {
  const obligation = obligationOf({ c1: 30, c9: 90 });
  const s = stateWithObligation(obligation);
  const batch = batchFor(obligation, "L", {
    conversations: [{ conversationId: "c1", fromSeqExclusive: 20, latestSeq: 30, truncated: true, fetchedSeqs: [21, 22, 23, 24, 25, 26] }],
    rendered: [21, 22, 23, 24, 25].map((seq) => ({ id: `m${seq}`, conversationId: "c1", seq, appendedOutOfOrder: false })),
    candidateCapHit: true,
  });
  const next = echo(s, batch).state.catchupObligation;
  assert.ok(next);
  assert.equal(next.obligationCursor.c1, 25);
  assert.equal(next.obligationCursor.c9, undefined);
  assert.equal(catchupLowerBound(next, "c1", 20), 25, "the next batch starts above the coverage");
});

test("O-3 a failed probe dispatch leaves the obligation and pending batch unchanged", () => {
  const { state, probeAt } = openedAtStep0();
  const claimed = claim(state, "P", probeAt);
  const batch = batchFor(claimed.state.catchupObligation, "P", {});
  const attached = attachCatchupBatch(claimed.state, batch);
  assert.ok(attached.attached);
  const rolled = rollbackTerminalClaim(attached.state, claimed.token, { nowMs: probeAt + 1, dispatchLeftReplica: false });
  assert.deepEqual(rolled.state.catchupObligation, attached.state.catchupObligation);
});

test("O-4 manual stop and the E3 lift keep the obligation", () => {
  const { state, probeAt } = openedAtStep0();
  const stopped = applyTerminalManualStop(claim(state, "P", probeAt).state, { nowMs: probeAt + 1 }).state;
  assert.deepEqual(stopped.catchupObligation, state.catchupObligation);
  const human = claim(stopped, "H", probeAt + 2, { control: "human_start" }).state;
  assert.deepEqual(human.catchupObligation, state.catchupObligation);
  const reset = applyTerminalLift(stopped, { cause: "human_reset", nowMs: probeAt + 3 });
  assert.deepEqual(reset.catchupObligation, state.catchupObligation);
});

test("O-5 fed, then E1 before any clean turn: nothing is fulfilled; the next lower bound follows the moved read cursor", () => {
  const obligation = obligationOf({ c1: 4 });
  const s = stateWithObligation(obligation);
  const batch = batchFor(obligation, "L", {
    conversations: [{ conversationId: "c1", fromSeqExclusive: 0, latestSeq: 4, truncated: false, fetchedSeqs: [1, 2, 3, 4] }],
    rendered: [1, 2, 3, 4].map((seq) => ({ id: `m${seq}`, conversationId: "c1", seq, appendedOutOfOrder: false })),
  });
  const attached = attachCatchupBatch(s, batch);
  assert.ok(attached.attached);
  const failed = failE1(attached.state, "L", "fpA", 10).state;
  assert.deepEqual(failed.catchupObligation?.obligationCursor, {});
  assert.deepEqual(failed.catchupObligation?.owedCeilings, { c1: 4 });
  assert.equal(catchupLowerBound(failed.catchupObligation, "c1", 1), 1, "the agent pulled m1: the next batch omits m1");
});

test("O-6 a refused wake raises that conversation's ceiling to the message seq", () => {
  const { state } = openedAtStep0();
  const refused = gate(state, state.blockedUntilMs! - 1, { wakeMessage: { conversationId: "c1", seq: 5 } });
  assert.equal(refused.decision, "terminal_failure_paused");
  assert.equal(refused.write, true);
  assert.equal(refused.state.catchupObligation?.owedCeilings.c1, 5);
});

test("O-7 (state level) a daemon restart does not touch the obligation", () => {
  const { state, probeAt } = openedAtStep0();
  const ready = applyTerminalDaemonReady(claim(state, "P", probeAt).state, { daemonInstanceId: "daemon-2", nowMs: probeAt + 1 });
  assert.deepEqual(ready.state.catchupObligation, state.catchupObligation);
});

test("O-8/O-13 a folded row beyond a truncated gap is listed out of prefix; coverage stops at the contiguous prefix", () => {
  const obligation = obligationOf({ c1: 18 });
  const s = stateWithObligation(obligation);
  const batch = batchFor(obligation, "L", {
    conversations: [{ conversationId: "c1", fromSeqExclusive: 10, latestSeq: 18, truncated: true, fetchedSeqs: [11, 12, 13, 14, 15, 16] }],
    rendered: [
      ...[11, 12, 13, 14, 15].map((seq) => ({ id: `m${seq}`, conversationId: "c1", seq, appendedOutOfOrder: false })),
      { id: "m18", conversationId: "c1", seq: 18, appendedOutOfOrder: true },
    ],
  });
  assert.deepEqual(batch.coverage, [{ conversationId: "c1", fromSeqExclusive: 10, coveredUpToSeq: 15, truncated: true }]);
  assert.deepEqual(batch.messages.at(-1), { id: "m18", conversationId: "c1", seq: 18, inPrefix: false });
  const next = echo(s, batch).state.catchupObligation;
  assert.equal(next?.obligationCursor.c1, 15, "m16, m17, m18 stay owed");
  assert.equal(catchupLowerBound(next, "c1", 10), 15);
});

test("O-9 a batch fed to a launch that fails is fed again: duplicates are permitted", () => {
  const obligation = obligationOf({ c1: 2 });
  const conv = [{ conversationId: "c1", fromSeqExclusive: 0, latestSeq: 2, truncated: false, fetchedSeqs: [2] }];
  const rows = [{ id: "m2", conversationId: "c1", seq: 2, appendedOutOfOrder: false }];
  const b1 = batchFor(obligation, "L", { conversations: conv, rendered: rows });
  const attached = attachCatchupBatch(stateWithObligation(obligation), b1);
  assert.ok(attached.attached);
  const failed = failE1(attached.state, "L", "fpA", 1).state;
  const b2 = batchFor(failed.catchupObligation, "L2", { conversations: conv, rendered: rows });
  assert.deepEqual(b1.messages.map((m) => m.id), b2.messages.map((m) => m.id));
});

test("O-10 m1, m2 owed; only the echo of the carrying batch fulfils, not active or an echo-less E2", () => {
  const obligation = obligationOf({ c1: 2 });
  const s = stateWithObligation(obligation);
  const batch = batchFor(obligation, "L", {
    conversations: [{ conversationId: "c1", fromSeqExclusive: 0, latestSeq: 2, truncated: false, fetchedSeqs: [1, 2] }],
    rendered: [1, 2].map((seq) => ({ id: `m${seq}`, conversationId: "c1", seq, appendedOutOfOrder: false })),
  });
  assert.deepEqual(batch.messages.map((m) => m.id), ["m1", "m2"]);
  assert.deepEqual(batch.coverage, [{ conversationId: "c1", fromSeqExclusive: 0, coveredUpToSeq: 2, truncated: false }]);
  const attached = attachCatchupBatch(s, batch);
  assert.ok(attached.attached);
  const echoLess = completeE2(attached.state, "L", 1);
  assert.deepEqual(echoLess.state.catchupObligation, attached.state.catchupObligation);
  const echoed = completeE2(echoLess.state, "L", 2, batch.batchId);
  assert.equal(echoed.echoApplied, true);
  assert.equal(echoed.state.catchupObligation, null);
  const again = applyTurnCompletedFrame(echoed.state, e2("L", nextSeq(), SESSION, batch.batchId), { nowMs: 3, persistedSessionId: null });
  assert.equal(again.echoApplied, false, "echoed only once");
});

test("O-11 a start whose control prompt replaced the batch never echoes: the obligation is unchanged", () => {
  const obligation = obligationOf({ c1: 2 });
  const s = stateWithObligation(obligation);
  const attached = attachCatchupBatch(s, batchFor(obligation, "L", { conversations: [{ conversationId: "c1", fromSeqExclusive: 0, latestSeq: 2, truncated: false, fetchedSeqs: [1, 2] }] }));
  assert.ok(attached.attached);
  const done = completeE2(attached.state, "L", 1, null);
  assert.equal(done.state.catchupObligation?.pendingBatch?.batchId, attached.state.catchupObligation?.pendingBatch?.batchId);
  assert.deepEqual(done.state.catchupObligation?.obligationCursor, {});
});

test("O-12 a message that arrives after the batch is still owed after the batch's echo", () => {
  const obligation = obligationOf({ c1: 4 });
  const s = stateWithObligation(obligation);
  const batch = batchFor(obligation, "L", {
    conversations: [{ conversationId: "c1", fromSeqExclusive: 0, latestSeq: 4, truncated: false, fetchedSeqs: [1, 2, 3, 4] }],
    rendered: [1, 2, 3, 4].map((seq) => ({ id: `m${seq}`, conversationId: "c1", seq, appendedOutOfOrder: false })),
  });
  const attached = attachCatchupBatch(s, batch);
  assert.ok(attached.attached);
  const raised = { ...attached.state, catchupObligation: raiseCatchupObligation(attached.state.catchupObligation, { c1: 7 }) };
  const next = completeE2(raised, "L", 1, batch.batchId).state.catchupObligation;
  assert.equal(next?.obligationCursor.c1, 4);
  assert.equal(next?.owedCeilings.c1, 7);
});

test("O-14 conversations already covered by an echo are dropped before the 32-candidate slice", () => {
  const cursor: Record<string, number> = {};
  const candidates: ResumeCatchupCandidateInput[] = [];
  for (let i = 1; i <= 40; i++) {
    cursor[`d${i}`] = 100 + i;
    candidates.push({ conversationId: `d${i}`, lastReadSeq: 0, firstUnreadSeq: 1, latestUnreadSeq: 100 + i });
  }
  candidates.push({ conversationId: "e1", lastReadSeq: 40, firstUnreadSeq: 41, latestUnreadSeq: 41 });
  const obligation = { ...obligationOf({ e1: 41 }), obligationCursor: cursor };
  const selected = selectObligationCatchupCandidates(obligation, candidates, 32);
  assert.deepEqual(selected.candidates.map((c) => c.conversationId), ["e1"]);
  assert.equal(selected.candidateCapHit, false);
});

test("O-15 owed conversations go first, oldest owed first; the obligation clears after two echoed batches", () => {
  const ceilings: Record<string, number> = {};
  for (let i = 1; i <= 12; i++) ceilings[`f${i}`] = 50 + i;
  let s = exited(stateWithObligation(obligationOf(ceilings)), "L", 1);
  const channelSlots = 8;
  for (let round = 1; round <= 2; round++) {
    // Today's order is newest first: the g channels (fresh, non-owed) lead.
    const candidates: ResumeCatchupCandidateInput[] = [];
    for (let g = 1; g <= 10; g++) candidates.push({ conversationId: `g${g}`, lastReadSeq: 0, firstUnreadSeq: 1000 * round + g, latestUnreadSeq: 1000 * round + g });
    for (let i = 12; i >= 1; i--) candidates.push({ conversationId: `f${i}`, lastReadSeq: 0, firstUnreadSeq: 50 + i, latestUnreadSeq: 50 + i });
    const selected = selectObligationCatchupCandidates(s.catchupObligation, candidates).candidates.slice(0, channelSlots);
    const expectedF = round === 1 ? [1, 2, 3, 4, 5, 6, 7, 8] : [9, 10, 11, 12];
    assert.deepEqual(selected.slice(0, expectedF.length).map((c) => c.conversationId), expectedF.map((i) => `f${i}`), `round ${round}`);
    if (round === 1) assert.ok(selected.every((c) => c.conversationId.startsWith("f")), "no g row while owed f rows fit");
    const launchId = `L${round}`;
    s = spawned(claim(s, launchId, round * 100).state, launchId);
    const batch = batchFor(s.catchupObligation, launchId, {
      conversations: selected.map((c) => ({ conversationId: c.conversationId, fromSeqExclusive: c.lowerBoundSeq, latestSeq: c.latestUnreadSeq, truncated: false, fetchedSeqs: [c.latestUnreadSeq] })),
      rendered: selected.map((c) => ({ id: `m-${c.conversationId}`, conversationId: c.conversationId, seq: c.latestUnreadSeq, appendedOutOfOrder: false })),
    });
    s = exited(echo(s, batch).state, launchId, round * 100 + 50);
  }
  assert.equal(s.catchupObligation, null);
});

test("O-16 read-cursor movement raises the lower bound, never lowers the obligation cursor, and a passed ceiling is fulfilled by the echo", () => {
  const obligation = obligationOf({ h1: 75 });
  let s = stateWithObligation(obligation);
  const b1 = batchFor(obligation, "L", {
    conversations: [{ conversationId: "h1", fromSeqExclusive: 70, latestSeq: 75, truncated: true, fetchedSeqs: [71, 72, 73] }],
    rendered: [71, 72].map((seq) => ({ id: `m${seq}`, conversationId: "h1", seq, appendedOutOfOrder: false })),
  });
  s = echo(s, b1).state;
  assert.equal(s.catchupObligation?.obligationCursor.h1, 72);
  // The agent pulls #h1; the cursor moves to 74.
  assert.equal(catchupLowerBound(s.catchupObligation, "h1", 74), 74);
  assert.equal(catchupLowerBound(s.catchupObligation, "h1", 60), 72, "an older cursor never lowers the bound");
  const b2 = batchFor(s.catchupObligation, "L", {
    conversations: [{ conversationId: "h1", fromSeqExclusive: 74, latestSeq: 75, truncated: false, fetchedSeqs: [75] }],
    rendered: [{ id: "m75", conversationId: "h1", seq: 75, appendedOutOfOrder: false }],
  });
  assert.deepEqual(b2.messages.map((m) => m.id), ["m75"]);
  assert.equal(echo(s, b2).state.catchupObligation, null);
  // Variant: the cursor reached 75 before B2; B2 has no rows for h1 but lists it.
  const b2v = batchFor(s.catchupObligation, "L", { owedReadCursors: { h1: 75 } });
  assert.deepEqual(b2v.coverage, [{ conversationId: "h1", fromSeqExclusive: 75, coveredUpToSeq: 75, truncated: false }]);
  assert.equal(echo(s, b2v).state.catchupObligation, null);
});

test("owedOverflow is fulfilled only by a complete batch", () => {
  const overflow = raiseCatchupObligation(null, null);
  const s = stateWithObligation(overflow);
  const conversations = [{ conversationId: "c1", fromSeqExclusive: 0, latestSeq: 3, truncated: false, fetchedSeqs: [1, 2, 3] }];
  const rendered = [1, 2, 3].map((seq) => ({ id: `m${seq}`, conversationId: "c1", seq, appendedOutOfOrder: false }));
  const partial = batchFor(overflow, "L", { conversations, rendered, candidateCapHit: true, unreadLatestSeqs: { c1: 3 } });
  assert.equal(partial.allUnreadCovered, false, "a candidate-cap cut is never complete");
  assert.equal(echo(s, partial).state.catchupObligation?.owedOverflow, true);
  const complete = batchFor(overflow, "L", { conversations, rendered, candidateCapHit: false, unreadLatestSeqs: { c1: 3 } });
  assert.equal(echo(s, complete).state.catchupObligation, null);
});

// --- Review of PR #8633 (Huaihuai): gate, identity, coverage and restart findings ---

/** A healthy never-failed agent: launch A on process `pa`, one clean turn. */
function healthyOnA(): TerminalFailureBreakerState {
  const s = spawned(claim(freshTerminalFailureBreakerState(), "A", 0).state, "A", "pa");
  return completeE2(s, "A", 10).state;
}

test("review-1 a pending (identity unknown) current launch is not exempt in closed: the next automatic claim is refused", () => {
  const pending = claim(freshTerminalFailureBreakerState(), "A", 0).state;
  assert.equal(pending.unexited[0]?.processInstanceId, null);
  assert.equal(gate(pending, 1).decision, "terminal_failure_needs_manual");
  assert.deepEqual(claimTerminalStart(pending, claimInput("B", 2)), { ok: false, reason: "terminal_failure_needs_manual" });
});

test("review-1 once A's identity is confirmed (spawned or rebind ack) and A has no terminal outcome, the next automatic claim passes", () => {
  const pending = claim(freshTerminalFailureBreakerState(), "A", 0).state;
  const viaSpawned = spawned(pending, "A", "pa");
  assert.equal(gate(viaSpawned, 1).decision, "pass");
  assert.ok(claimTerminalStart(viaSpawned, claimInput("B", 2)).ok);
  const viaAck = applyTerminalStartAck(pending, { launchId: "A", daemonInstanceId: D1, queueState: "running", processInstanceId: "pa" }).state;
  assert.equal(gate(viaAck, 1).decision, "pass");
  // A confirmed launch that already ended (E1) is not exempt.
  const failed = applyTerminalFailureFrame(viaSpawned, e1("A", "fpA"), { nowMs: 3, unreadCeilings: {} }).state;
  assert.equal(gate(failed, 4).decision, "terminal_failure_needs_manual");
});

test("review-2 gate refusal while B's rebind ack is in flight, then the ack merges B into A's process: the block lifts", () => {
  const b = claim(healthyOnA(), "B", 100).state;
  const refused = gate(b, 101);
  assert.equal(refused.decision, "terminal_failure_needs_manual");
  assert.equal(refused.state.needsManual?.reason, "unexited_process");
  const merged = applyTerminalStartAck(refused.state, { launchId: "B", daemonInstanceId: D1, queueState: "rebound", processInstanceId: "pa" });
  assert.equal(merged.outcome, "merged");
  assert.equal(merged.state.needsManual, null, "the cause (B's pending entry) is resolved");
  assert.equal(gate(merged.state, 102).decision, "pass");
});

test("review-2 opposite order: the ack merges before any gate runs; no needsManual is ever written", () => {
  const b = claim(healthyOnA(), "B", 100).state;
  const merged = applyTerminalStartAck(b, { launchId: "B", daemonInstanceId: D1, queueState: "rebound", processInstanceId: "pa" }).state;
  const g = gate(merged, 101);
  assert.equal(g.decision, "pass");
  assert.equal(g.state.needsManual, null);
});

test("review-2 control: a merge does not clear a different needsManual reason or a block from another unexited entry", () => {
  // (a) outcome_unobservable (capability lost) stays after the merge.
  const b = claim(healthyOnA(), "B", 100).state;
  const lost = evaluateTerminalWakeGate(b, { nowMs: 101, capability: false, wakeMessage: null });
  assert.equal(lost.state.needsManual?.reason, "outcome_unobservable");
  const mergedLost = applyTerminalStartAck(lost.state, { launchId: "B", daemonInstanceId: D1, queueState: "rebound", processInstanceId: "pa" }).state;
  assert.equal(mergedLost.needsManual?.reason, "outcome_unobservable");
  assert.equal(gate(mergedLost, 102).decision, "terminal_failure_needs_manual");
  // (b) another process z that never exited keeps the block after B's merge.
  const withZ = claim(healthyOnA(), "B", 100).state;
  withZ.unexited.unshift({ spawnLaunchId: "Z", daemonInstanceId: D1, processInstanceId: "pz", launchIds: ["Z"], dispatchedAtMs: 50, protected: true });
  const refused = gate(withZ, 101);
  assert.equal(refused.state.needsManual?.reason, "unexited_process");
  const mergedZ = applyTerminalStartAck(refused.state, { launchId: "B", daemonInstanceId: D1, queueState: "rebound", processInstanceId: "pa" }).state;
  assert.equal(mergedZ.needsManual?.reason, "unexited_process", "z is still unexited");
  assert.equal(gate(mergedZ, 102).decision, "terminal_failure_needs_manual");
  // (c) daemon_restarted_no_exit stays after a fill for the new instance.
  const protectedOld = spawned(claim(runFailing(freshTerminalFailureBreakerState(), "L0", "fpA", 0).state, "A", 10).state, "A", "pa");
  const restarted = applyTerminalDaemonReady(protectedOld, { daemonInstanceId: "daemon-2", nowMs: 20 }).state;
  assert.equal(restarted.needsManual?.reason, "daemon_restarted_no_exit");
  // A pending entry on the new instance (constructed: through the gate only a human start could add one,
  // and that takes the old entry over) gets its identity; the old protected entry is still unexited.
  restarted.unexited.push({ spawnLaunchId: "N", daemonInstanceId: "daemon-2", processInstanceId: null, launchIds: ["N"], dispatchedAtMs: 25, protected: true });
  const filled = applyTerminalProcessSpawned(restarted, { launchId: "N", daemonInstanceId: "daemon-2", processInstanceId: "pn" }).state;
  assert.deepEqual(filled.unexited.map((e) => e.spawnLaunchId), ["A", "N"]);
  assert.equal(filled.needsManual?.reason, "daemon_restarted_no_exit", "a fill never clears a restart block");
});

function batchWith(obligation: CatchupObligation | null, input: Partial<Parameters<typeof buildCatchupBatch>[1]>): CatchupBatch {
  return buildCatchupBatch(obligation, {
    batchId: `B-${nextSeq()}`, launchId: "L", builtAtMs: 0, conversations: [], rendered: [], owedReadCursors: {},
    candidateCapHit: false, unreadLatestSeqs: {}, ...input,
  } as Parameters<typeof buildCatchupBatch>[1]);
}
const rows = (conversationId: string, seqs: number[]) => seqs.map((seq) => ({ id: `m${seq}`, conversationId, seq, appendedOutOfOrder: false }));

test("review-3 empty rendering covers nothing: coverage = from, the owed ceiling and the overflow debt stay", () => {
  const conv = [{ conversationId: "c", fromSeqExclusive: 0, latestSeq: 10, truncated: false, fetchedSeqs: [3, 7, 10] }];
  const batch = batchWith(null, { conversations: conv, rendered: [], unreadLatestSeqs: { c: 10 } });
  assert.deepEqual(batch.coverage, [{ conversationId: "c", fromSeqExclusive: 0, coveredUpToSeq: 0, truncated: false }]);
  assert.equal(batch.allUnreadCovered, false);
  const owed = applyCatchupEcho(obligationOf({ c: 10 }), batch);
  assert.equal(owed?.owedCeilings.c, 10);
  assert.ok((owed?.obligationCursor.c ?? 0) < 10, "not fulfilled");
  const overflow = applyCatchupEcho(raiseCatchupObligation(null, null), batch);
  assert.equal(overflow?.owedOverflow, true, "the overflow debt stays");
  // Also when the fetch returned nothing: no rows rendered, nothing covered.
  const none = batchWith(null, { conversations: [{ ...conv[0]!, fetchedSeqs: [] }], unreadLatestSeqs: { c: 10 } });
  assert.equal(none.coverage[0]?.coveredUpToSeq, 0);
});

test("review-3 partial rendering covers only the rendered contiguous prefix of the fetched rows", () => {
  const conv = [{ conversationId: "c", fromSeqExclusive: 0, latestSeq: 10, truncated: false, fetchedSeqs: [3, 7, 10] }];
  const tail = batchWith(null, { conversations: conv, rendered: rows("c", [3, 7]) });
  assert.equal(tail.coverage[0]?.coveredUpToSeq, 7, "10 was fetched but not rendered");
  const gap = batchWith(null, { conversations: conv, rendered: rows("c", [3, 10]) });
  assert.equal(gap.coverage[0]?.coveredUpToSeq, 3, "7 missing breaks the prefix");
  assert.deepEqual(gap.messages.map((m) => m.inPrefix), [true, false]);
});

test("review-3 positive control: every fetched row rendered and not truncated extends to latestSeq; overflow clears only when every unread conversation is covered", () => {
  const convs = [
    { conversationId: "a", fromSeqExclusive: 0, latestSeq: 10, truncated: false, fetchedSeqs: [3, 7] },
    { conversationId: "b", fromSeqExclusive: 4, latestSeq: 9, truncated: false, fetchedSeqs: [9] },
  ];
  const full = batchWith(null, { conversations: convs, rendered: [...rows("a", [3, 7]), ...rows("b", [9])], unreadLatestSeqs: { a: 10, b: 9 } });
  assert.deepEqual(full.coverage.map((c) => c.coveredUpToSeq), [10, 9]);
  assert.equal(full.allUnreadCovered, true);
  assert.equal(applyCatchupEcho(raiseCatchupObligation(null, null), full), null);
  const missingB = batchWith(null, { conversations: [convs[0]!], rendered: rows("a", [3, 7]), unreadLatestSeqs: { a: 10, b: 9 } });
  assert.equal(missingB.allUnreadCovered, false);
  assert.equal(applyCatchupEcho(raiseCatchupObligation(null, null), missingB)?.owedOverflow, true);
});

test("review-4 a normal never-protected agent is not blocked after a daemon restart; its old entry is acknowledged as untracked", () => {
  const s = healthyOnA();
  assert.equal(s.unexited[0]?.protected, false);
  const ready = applyTerminalDaemonReady(s, { daemonInstanceId: "daemon-2", nowMs: 100 });
  assert.equal(ready.state.needsManual, null);
  assert.deepEqual(ready.state.unexited, []);
  assert.deepEqual(ready.state.acknowledgedUnexited.map((e) => [e.spawnLaunchId, e.reason]), [["A", "daemon_restarted_untracked"]]);
  assert.equal(gate(ready.state, 101).decision, "pass");
});

test("review-4 protect → E2 → daemon restart: the unknown old entry still blocks (daemon_restarted_no_exit)", () => {
  let s = runFailing(freshTerminalFailureBreakerState(), "L0", "fpA", 0).state;
  s = spawned(claim(s, "A", 10).state, "A", "pa");
  assert.equal(s.unexited[0]?.protected, true, "created while engaged (count 1)");
  s = completeE2(s, "A", 20).state;
  assert.equal(s.totalCount, 0);
  assert.equal(s.unexited[0]?.protected, true, "E2 does not un-protect");
  const ready = applyTerminalDaemonReady(s, { daemonInstanceId: "daemon-2", nowMs: 30 });
  assert.equal(ready.state.needsManual?.reason, "daemon_restarted_no_exit");
  assert.equal(ready.state.unexited.length, 1);
  assert.equal(gate(ready.state, 40).decision, "terminal_failure_needs_manual");
});

test("review-4 an entry is protected when the breaker engages after it exists; an E3 reset does not un-protect it", () => {
  let s = spawned(claim(freshTerminalFailureBreakerState(), "A", 0).state, "A", "pa");
  assert.equal(s.unexited[0]?.protected, false);
  s = failE1(s, "A", "fpA", 10).state;
  assert.equal(s.unexited[0]?.protected, true, "marked when the count engaged");
  s = applyTerminalLift(s, { cause: "human_reset", nowMs: 20 });
  assert.equal(s.totalCount, 0);
  assert.equal(s.unexited[0]?.protected, true);
  const ready = applyTerminalDaemonReady(s, { daemonInstanceId: "daemon-2", nowMs: 30 });
  assert.equal(ready.state.needsManual?.reason, "daemon_restarted_no_exit");
  assert.equal(gate(ready.state, 40).decision, "terminal_failure_needs_manual");
});

test("review-4 mixed: a restart drops only never-protected old entries and blocks on the protected one", () => {
  const s = healthyOnA();
  s.unexited.push({ spawnLaunchId: "Z", daemonInstanceId: D1, processInstanceId: "pz", launchIds: ["Z"], dispatchedAtMs: 5, protected: true });
  const ready = applyTerminalDaemonReady(s, { daemonInstanceId: "daemon-2", nowMs: 100 }).state;
  assert.deepEqual(ready.unexited.map((e) => e.spawnLaunchId), ["Z"]);
  assert.deepEqual(ready.acknowledgedUnexited.map((e) => e.spawnLaunchId), ["A"]);
  assert.equal(ready.needsManual?.reason, "daemon_restarted_no_exit");
});

test("review-4 R-1 the new fields (entry.protected, acknowledged.reason, needsManual.causeEntries) round-trip and are required", () => {
  const state = everyFieldState();
  assert.equal(state.unexited[0]?.protected, true);
  assert.equal(state.acknowledgedUnexited[0]?.reason, "daemon_restarted_untracked");
  assert.equal(state.needsManual?.causeEntries.length, 1);
  assert.deepEqual(decodeTerminalFailureBreakerState(encodeTerminalFailureBreakerState(state)), state);
  const drop = (mutate: (record: { unexited: Array<Record<string, unknown>>; acknowledgedUnexited: Array<Record<string, unknown>>; needsManual: Record<string, unknown> }) => void) => {
    const record = JSON.parse(encodeTerminalFailureBreakerState(state));
    mutate(record);
    return decodeTerminalFailureBreakerState(JSON.stringify(record));
  };
  assert.equal(drop((r) => { delete r.unexited[0]!.protected; }), TERMINAL_BREAKER_UNREADABLE);
  assert.equal(drop((r) => { delete r.acknowledgedUnexited[0]!.reason; }), TERMINAL_BREAKER_UNREADABLE);
  assert.equal(drop((r) => { r.acknowledgedUnexited[0]!.reason = "other"; }), TERMINAL_BREAKER_UNREADABLE);
  assert.equal(drop((r) => { delete r.needsManual.causeEntries; }), TERMINAL_BREAKER_UNREADABLE);
});

// --- Review of c8ece02f2: a wait-only refusal owes messages but is not breaker engagement ---

/** Healthy A on `pa`; B claimed (pending); a real message wake is refused only because B's identity is unknown; B's ack merges. */
function waitOnlyRefusalThenMerge() {
  const b = claim(healthyOnA(), "B", 100).state;
  const refused = gate(b, 101, { wakeMessage: { conversationId: "c", seq: 10 } });
  assert.equal(refused.decision, "terminal_failure_needs_manual");
  assert.equal(refused.state.needsManual?.reason, "unexited_process");
  assert.equal(refused.state.catchupObligation?.owedCeilings.c, 10, "the refused message is owed");
  const merged = applyTerminalStartAck(refused.state, { launchId: "B", daemonInstanceId: D1, queueState: "rebound", processInstanceId: "pa" }).state;
  assert.equal(merged.needsManual, null);
  return merged;
}

test("review-5 a wait-only refusal owes the message but does not protect: a restart does not block, and the next batch carries it", () => {
  const merged = waitOnlyRefusalThenMerge();
  assert.deepEqual(merged.unexited.map((e) => e.protected), [false], "no failure ever engaged the breaker");
  const ready = applyTerminalDaemonReady(merged, { daemonInstanceId: "daemon-2", nowMs: 200 }).state;
  assert.equal(ready.needsManual, null);
  assert.deepEqual(ready.unexited, []);
  assert.equal(gate(ready, 201).decision, "pass");
  assert.equal(ready.catchupObligation?.owedCeilings.c, 10, "the obligation survives the restart");
  const next = claim(ready, "C", 210, { daemonInstanceId: "daemon-2" }).state;
  const selected = selectObligationCatchupCandidates(next.catchupObligation, [{ conversationId: "c", lastReadSeq: 9, firstUnreadSeq: 10, latestUnreadSeq: 10 }]);
  assert.deepEqual(selected.candidates.map((c) => [c.conversationId, c.owed]), [["c", true]]);
  const batch = batchWith(next.catchupObligation, {
    launchId: "C",
    conversations: [{ conversationId: "c", fromSeqExclusive: 9, latestSeq: 10, truncated: false, fetchedSeqs: [10] }],
    rendered: rows("c", [10]),
    unreadLatestSeqs: { c: 10 },
  });
  const attached = attachCatchupBatch(next, batch);
  assert.ok(attached.attached, "the next start carries the owed message");
  assert.deepEqual(batch.messages.map((m) => m.id), ["m10"]);
});

test("review-5 negative control: an E1 counted before the restart protects the entry, and the restart blocks", () => {
  const merged = waitOnlyRefusalThenMerge();
  const failed = failE1(merged, "B", "fpA", 150).state;
  assert.deepEqual(failed.unexited.map((e) => e.protected), [true]);
  const ready = applyTerminalDaemonReady(failed, { daemonInstanceId: "daemon-2", nowMs: 200 }).state;
  assert.equal(ready.needsManual?.reason, "daemon_restarted_no_exit");
  assert.equal(gate(ready, 201).decision, "terminal_failure_needs_manual");
  // Even after an E3 reset clears the count, the marker keeps it protected.
  const reset = applyTerminalLift(failed, { cause: "human_reset", nowMs: 160 });
  assert.equal(applyTerminalDaemonReady(reset, { daemonInstanceId: "daemon-2", nowMs: 200 }).state.needsManual?.reason, "daemon_restarted_no_exit");
});

test("review-5 negative control: a message refused while the breaker is open is failure-owed and protects", () => {
  const { state } = openedAtStep0();
  const refused = gate(state, state.blockedUntilMs! - 1, { wakeMessage: { conversationId: "c", seq: 10 } });
  assert.equal(refused.decision, "terminal_failure_paused");
  assert.equal(refused.state.catchupObligation?.engagedByFailure, true);
});

test("review-5 the wait-only obligation is still fulfilled by an echoed batch", () => {
  const merged = waitOnlyRefusalThenMerge();
  assert.equal(merged.catchupObligation?.engagedByFailure, false);
  const batch = batchWith(merged.catchupObligation, {
    launchId: "B",
    conversations: [{ conversationId: "c", fromSeqExclusive: 9, latestSeq: 10, truncated: false, fetchedSeqs: [10] }],
    rendered: rows("c", [10]),
    unreadLatestSeqs: { c: 10 },
  });
  const done = echo(merged, batch);
  assert.equal(done.echoApplied, true);
  assert.equal(done.state.catchupObligation, null);
});

test("review-5 R-1 catchupObligation.engagedByFailure round-trips and is required", () => {
  const state = everyFieldState();
  assert.equal(state.catchupObligation?.engagedByFailure, true);
  assert.deepEqual(decodeTerminalFailureBreakerState(encodeTerminalFailureBreakerState(state)), state);
  const wait = { ...state, catchupObligation: { ...state.catchupObligation!, engagedByFailure: false } };
  assert.deepEqual(decodeTerminalFailureBreakerState(encodeTerminalFailureBreakerState(wait)), wait);
  const record = JSON.parse(encodeTerminalFailureBreakerState(state));
  delete record.catchupObligation.engagedByFailure;
  assert.equal(decodeTerminalFailureBreakerState(JSON.stringify(record)), TERMINAL_BREAKER_UNREADABLE);
});

test("review-5 negative control: a refusal on a failure-engaged agent creates a failure-owed obligation even when the cause is an unexited entry", () => {
  // L0 failed (count 1) and its process never exited: the refusal is about the entry, but a failure engaged the breaker.
  const failed = applyTerminalFailureFrame(spawned(claim(freshTerminalFailureBreakerState(), "L0", 0).state, "L0"), e1("L0", "fpA"), { nowMs: 1, unreadCeilings: {} }).state;
  assert.equal(failed.catchupObligation, null);
  const refused = gate(failed, 2, { wakeMessage: { conversationId: "c", seq: 10 } });
  assert.equal(refused.decision, "terminal_failure_needs_manual");
  assert.equal(refused.state.needsManual?.reason, "unexited_process");
  assert.equal(refused.state.catchupObligation?.engagedByFailure, true);
  // Capability lost after protection (counts > 0, nothing unexited): failure-owed too.
  const exitedFailed = exited(failed, "L0", 3);
  const lost = evaluateTerminalWakeGate(exitedFailed, { nowMs: 4, capability: false, wakeMessage: { conversationId: "c", seq: 11 } });
  assert.equal(lost.decision, "terminal_failure_needs_manual");
  assert.equal(lost.state.catchupObligation?.engagedByFailure, true);
});

test("review-5 a failure-driven refusal upgrades an existing identity-wait obligation, and from then on entries are protected", () => {
  const b = claim(healthyOnA(), "B", 100).state;
  const waited = gate(b, 101, { wakeMessage: { conversationId: "c", seq: 10 } }).state;
  assert.equal(waited.catchupObligation?.engagedByFailure, false);
  const lost = evaluateTerminalWakeGate(waited, { nowMs: 102, capability: false, wakeMessage: null });
  assert.equal(lost.state.needsManual?.reason, "unexited_process", "the earlier block is kept");
  assert.equal(lost.state.catchupObligation?.engagedByFailure, true, "the capability-lost refusal now holds the debt");
});
