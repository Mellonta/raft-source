/**
 * task #1119 — server-side crash-loop breaker for automatic agent wakes.
 *
 * Incident 2026-09-14: an agent's runner died on every start and the server
 * woke it again on every reconnect for 181 cycles. This module is the state
 * machine the orchestrator consults before an *automatic* start (message wake,
 * app-inbox wake, rejected-delivery conversion). Human starts always pass and
 * open a new episode.
 *
 * Counting rule (locked by Huaihuai in #proj-runtime:3ddaa7c2, refined after
 * the task #1126 review):
 *  - an "early exit" is a daemon-reported *process exit* (agent:status inactive
 *    carrying the exit evidence and the launchId of the start it ends) observed
 *    within WINDOW_MS of that start; at most one early exit is counted per
 *    start;
 *  - a machine disconnect, an inactive frame without exit evidence, or an exit
 *    whose launchId does not match the current start is NOT an early exit: a
 *    transport loss is not proof of runner death, and a late exit from an
 *    earlier launch must not count against a later one;
 *  - THRESHOLD consecutive early exits block automatic wakes for the episode;
 *  - a start that runs past WINDOW_MS without an exit resets the count;
 *  - manual stop is not an exit (the caller forgets the streak instead);
 *  - only a human start/resume lifts a block, and it opens a new episode.
 *
 * State lives in the replica state store behind an optimistic compare-and-set
 * (read version → apply → write-if-unchanged, retry on conflict), so a block
 * survives a replica switch and concurrent writers cannot lose a count. The
 * pure transition functions are exported so the rules stay testable without a
 * store. Observation carrier: ids, classes, counts and times only.
 */
import type { WakeCrashLoopActivityDiagnostic } from "@botiverse/raft-shared";

export const WAKE_CRASH_LOOP_WINDOW_MS = 60_000;
export const WAKE_CRASH_LOOP_THRESHOLD = 3;

export type WakeCrashLoopExitKind = WakeCrashLoopActivityDiagnostic["lastExitKind"];

/** How the process ended, as attached by the daemon to `agent:status inactive`. */
export interface WakeCrashLoopExitEvidence {
  code: number | null;
  signal: string | null;
}

export interface WakeCrashLoopExit {
  kind: WakeCrashLoopExitKind;
  /** Daemon exit evidence; `null` when the frame carried none (then the exit is not counted). */
  evidence: WakeCrashLoopExitEvidence | null;
  /** launchId of the run that ended; must match the current start to count. */
  launchId: string | null;
}

export type WakeCrashLoopExitRejectReason =
  | "not_process_exit"
  | "no_exit_evidence"
  | "launch_mismatch"
  | "no_start"
  | "outside_window"
  | "already_counted"
  | "already_blocked";

export interface WakeCrashLoopExitObservation {
  /** False when the exit was not eligible (see `rejected`). */
  counted: boolean;
  rejected: WakeCrashLoopExitRejectReason | null;
  /** True exactly once per episode: this exit crossed the threshold. */
  blockedNow: boolean;
  snapshot: WakeCrashLoopActivityDiagnostic;
}

/** Persisted per-agent episode state. Plain JSON: ids, counts, classes, times. */
export interface WakeCrashLoopEpisodeState {
  episode: number;
  earlyExitCount: number;
  blocked: boolean;
  blockedAtMs: number | null;
  lastStartAtMs: number | null;
  lastStartLaunchId: string | null;
  lastStartCounted: boolean;
  firstExitAtMs: number | null;
  lastExitAtMs: number | null;
  lastExitKind: WakeCrashLoopExitKind | null;
  lastSignal: string | null;
  lastLaunchId: string | null;
  /**
   * task #1221: set when the block came from a start failure that retrying
   * cannot fix (e.g. the model is not configured on the computer), instead of
   * repeated early exits. Absent on older records (= null).
   */
  needsActionReason?: string | null;
  /**
   * task #1221: messages may have arrived while automatic wakes were refused
   * for a non-retryable start failure. Starts carry the unread catch-up (with
   * or without a session) until one that carried it reports its runtime
   * active; only that clears it.
   */
  catchupOwed?: boolean;
  /** task #1221: the start (launchId) that carried the owed catch-up, pending its active report. */
  catchupCarriedLaunchId?: string | null;
}

/** Token returned by `recordStart`; lets a failed dispatch roll the record back. */
export interface WakeCrashLoopStartRecord {
  launchId: string | null;
  nowMs: number;
  previous: WakeCrashLoopEpisodeState;
}

/** Versioned read; `version` 0 means "no state yet" and is the expected version for a first write. */
export interface WakeCrashLoopStateRecord {
  state: WakeCrashLoopEpisodeState;
  version: number;
}

/**
 * The shared-store seam. `compareAndSet` must be atomic with respect to other
 * writers: write only if the stored version equals `expectedVersion` (0 when
 * absent) and bump it; return false otherwise.
 */
export interface WakeCrashLoopStateStore {
  getWakeCrashLoopState(agentId: string): Promise<WakeCrashLoopStateRecord | null>;
  compareAndSetWakeCrashLoopState(agentId: string, expectedVersion: number, state: WakeCrashLoopEpisodeState): Promise<boolean>;
}

export function freshWakeCrashLoopEpisode(episode: number): WakeCrashLoopEpisodeState {
  return {
    episode,
    earlyExitCount: 0,
    blocked: false,
    blockedAtMs: null,
    lastStartAtMs: null,
    lastStartLaunchId: null,
    lastStartCounted: false,
    firstExitAtMs: null,
    lastExitAtMs: null,
    lastExitKind: null,
    lastSignal: null,
    lastLaunchId: null,
  };
}

export interface WakeCrashLoopRules {
  windowMs: number;
  threshold: number;
}

export const DEFAULT_WAKE_CRASH_LOOP_RULES: WakeCrashLoopRules = {
  windowMs: WAKE_CRASH_LOOP_WINDOW_MS,
  threshold: WAKE_CRASH_LOOP_THRESHOLD,
};

/**
 * A start was dispatched. `human` starts (manual start / resume) always lift a
 * block and open a new episode; automatic starts keep the episode. A start
 * whose predecessor ran past the window without an exit resets the count.
 */
export function applyWakeCrashLoopStart(
  current: WakeCrashLoopEpisodeState,
  input: { launchId: string | null; nowMs: number; human: boolean },
  rules: WakeCrashLoopRules = DEFAULT_WAKE_CRASH_LOOP_RULES,
): WakeCrashLoopEpisodeState {
  let state: WakeCrashLoopEpisodeState = { ...current };
  if (input.human && (state.blocked || state.earlyExitCount > 0)) {
    // A new episode, but an owed catch-up survives until it is delivered.
    state = { ...freshWakeCrashLoopEpisode(state.episode + 1), catchupOwed: current.catchupOwed === true };
  } else if (
    state.lastStartAtMs !== null
    && !state.lastStartCounted
    && input.nowMs - state.lastStartAtMs > rules.windowMs
  ) {
    // The previous run survived the window: the streak is broken.
    state.earlyExitCount = 0;
    state.firstExitAtMs = null;
  }
  state.lastStartAtMs = input.nowMs;
  state.lastStartLaunchId = input.launchId;
  state.lastStartCounted = false;
  // A new start supersedes any earlier carrier; the owed catch-up stays until delivered.
  state.catchupCarriedLaunchId = null;
  return state;
}

/** Human said stop: the agent is offline by intent; forget the streak but keep the episode number. */
export function applyWakeCrashLoopManualStop(current: WakeCrashLoopEpisodeState): WakeCrashLoopEpisodeState {
  // task #1221: an undelivered catch-up survives the stop; the carrier (if any)
  // loses its claim, so only a later start that carries it again can clear it.
  return { ...freshWakeCrashLoopEpisode(current.episode), catchupOwed: current.catchupOwed === true, catchupCarriedLaunchId: null };
}

export function wakeCrashLoopExitRejectReason(
  state: WakeCrashLoopEpisodeState,
  exit: WakeCrashLoopExit,
  nowMs: number,
  rules: WakeCrashLoopRules = DEFAULT_WAKE_CRASH_LOOP_RULES,
): WakeCrashLoopExitRejectReason | null {
  if (exit.kind !== "agent_process_exited") return "not_process_exit";
  if (!exit.evidence) return "no_exit_evidence";
  if (state.lastStartAtMs === null || state.lastStartLaunchId === null) return "no_start";
  if (exit.launchId === null || exit.launchId !== state.lastStartLaunchId) return "launch_mismatch";
  if (state.blocked) return "already_blocked";
  if (state.lastStartCounted) return "already_counted";
  if (nowMs - state.lastStartAtMs > rules.windowMs) return "outside_window";
  return null;
}

export function applyWakeCrashLoopExit(
  current: WakeCrashLoopEpisodeState,
  exit: WakeCrashLoopExit,
  nowMs: number,
  rules: WakeCrashLoopRules = DEFAULT_WAKE_CRASH_LOOP_RULES,
): { state: WakeCrashLoopEpisodeState; counted: boolean; rejected: WakeCrashLoopExitRejectReason | null; blockedNow: boolean } {
  const rejected = wakeCrashLoopExitRejectReason(current, exit, nowMs, rules);
  if (rejected) return { state: current, counted: false, rejected, blockedNow: false };
  const state: WakeCrashLoopEpisodeState = { ...current };
  state.lastStartCounted = true;
  state.earlyExitCount += 1;
  state.firstExitAtMs ??= nowMs;
  state.lastExitAtMs = nowMs;
  state.lastExitKind = exit.kind;
  state.lastSignal = exit.evidence?.signal ?? null;
  state.lastLaunchId = exit.launchId;
  const blockedNow = state.earlyExitCount >= rules.threshold;
  if (blockedNow) {
    state.blocked = true;
    state.blockedAtMs = nowMs;
  }
  return { state, counted: true, rejected: null, blockedNow };
}

/**
 * task #1221: a start failed for a reason retrying cannot fix. Block automatic
 * wakes at once (no threshold), but only when the failure belongs to the
 * current start: a late failure from an older launch must not re-block a start
 * a person or a config change has since made. Already blocked: no change.
 */
export function applyWakeCrashLoopNonRetryableStartFailure(
  current: WakeCrashLoopEpisodeState,
  input: { launchId: string | null; reason: string; nowMs: number },
): { state: WakeCrashLoopEpisodeState; blockedNow: boolean } {
  if (current.blocked) return { state: current, blockedNow: false };
  if (input.launchId === null || input.launchId !== current.lastStartLaunchId) return { state: current, blockedNow: false };
  return {
    state: {
      ...current,
      blocked: true,
      blockedAtMs: input.nowMs,
      lastLaunchId: input.launchId,
      needsActionReason: input.reason,
      catchupOwed: true,
    },
    blockedNow: true,
  };
}

const WAKE_CRASH_LOOP_EXIT_KINDS: ReadonlySet<string> = new Set(["machine_disconnected", "agent_process_exited"]);
const MAX_WAKE_CRASH_LOOP_ID_LENGTH = 128;

function isNullableNonNegativeInt(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function isNullableBoundedString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= MAX_WAKE_CRASH_LOOP_ID_LENGTH);
}

/**
 * Shape-validate a mirrored breaker carrier. Anything that is not exactly the
 * typed diagnostic (ids, counts, classes, times) is dropped, never propagated.
 */
export function normalizeWakeCrashLoopActivityDiagnostic(value: unknown): WakeCrashLoopActivityDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  if (!Number.isInteger(c.episode) || (c.episode as number) < 1) return null;
  if (!Number.isInteger(c.earlyExitCount) || (c.earlyExitCount as number) < 0) return null;
  if (!Number.isInteger(c.threshold) || (c.threshold as number) < 1) return null;
  if (!Number.isInteger(c.windowMs) || (c.windowMs as number) < 1) return null;
  if (typeof c.blocked !== "boolean") return null;
  if (!isNullableNonNegativeInt(c.blockedAtMs) || !isNullableNonNegativeInt(c.firstExitAtMs) || !isNullableNonNegativeInt(c.lastExitAtMs)) return null;
  if (c.lastExitKind !== null && !(typeof c.lastExitKind === "string" && WAKE_CRASH_LOOP_EXIT_KINDS.has(c.lastExitKind))) return null;
  if (!isNullableBoundedString(c.lastSignal) || !isNullableBoundedString(c.lastLaunchId)) return null;
  return {
    episode: c.episode as number,
    earlyExitCount: c.earlyExitCount as number,
    threshold: c.threshold as number,
    windowMs: c.windowMs as number,
    blocked: c.blocked,
    blockedAtMs: c.blockedAtMs,
    firstExitAtMs: c.firstExitAtMs,
    lastExitAtMs: c.lastExitAtMs,
    lastExitKind: c.lastExitKind as WakeCrashLoopExitKind | null,
    lastSignal: c.lastSignal,
    lastLaunchId: c.lastLaunchId,
  };
}

export function wakeCrashLoopSnapshot(
  state: WakeCrashLoopEpisodeState,
  rules: WakeCrashLoopRules = DEFAULT_WAKE_CRASH_LOOP_RULES,
): WakeCrashLoopActivityDiagnostic {
  return {
    episode: state.episode,
    earlyExitCount: state.earlyExitCount,
    threshold: rules.threshold,
    windowMs: rules.windowMs,
    blocked: state.blocked,
    blockedAtMs: state.blockedAtMs,
    firstExitAtMs: state.firstExitAtMs,
    lastExitAtMs: state.lastExitAtMs,
    lastExitKind: state.lastExitKind,
    lastSignal: state.lastSignal,
    lastLaunchId: state.lastLaunchId,
  };
}

/** Process-local store: the no-Redis (single replica) fallback and the unit-test default. */
export class InMemoryWakeCrashLoopStateStore implements WakeCrashLoopStateStore {
  private readonly records = new Map<string, WakeCrashLoopStateRecord>();

  async getWakeCrashLoopState(agentId: string): Promise<WakeCrashLoopStateRecord | null> {
    return this.getWakeCrashLoopStateSync(agentId);
  }

  async compareAndSetWakeCrashLoopState(agentId: string, expectedVersion: number, state: WakeCrashLoopEpisodeState): Promise<boolean> {
    return this.compareAndSetWakeCrashLoopStateSync(agentId, expectedVersion, state);
  }

  /**
   * Synchronous forms, so a caller can read and write this store together
   * with another process-local store in one JS turn (RFC 071 combined claim).
   */
  getWakeCrashLoopStateSync(agentId: string): WakeCrashLoopStateRecord | null {
    const record = this.records.get(agentId);
    return record ? { state: { ...record.state }, version: record.version } : null;
  }

  compareAndSetWakeCrashLoopStateSync(agentId: string, expectedVersion: number, state: WakeCrashLoopEpisodeState): boolean {
    const current = this.records.get(agentId)?.version ?? 0;
    if (current !== expectedVersion) return false;
    this.records.set(agentId, { state: { ...state }, version: current + 1 });
    return true;
  }
}

const CAS_MAX_ATTEMPTS = 16;

export class WakeCrashLoopBreaker {
  private readonly rules: WakeCrashLoopRules;

  constructor(
    private readonly store: WakeCrashLoopStateStore = new InMemoryWakeCrashLoopStateStore(),
    options: Partial<WakeCrashLoopRules> = {},
  ) {
    this.rules = {
      windowMs: options.windowMs ?? WAKE_CRASH_LOOP_WINDOW_MS,
      threshold: options.threshold ?? WAKE_CRASH_LOOP_THRESHOLD,
    };
  }

  private async read(agentId: string): Promise<WakeCrashLoopStateRecord> {
    const record = await this.store.getWakeCrashLoopState(agentId);
    return record ?? { state: freshWakeCrashLoopEpisode(1), version: 0 };
  }

  /**
   * Read → transition → compare-and-set, retried on version conflict so two
   * writers (two replicas, or a start racing an exit) both land their update
   * on the latest state instead of one overwriting the other.
   */
  private async mutate<T>(
    agentId: string,
    transition: (state: WakeCrashLoopEpisodeState) => { state: WakeCrashLoopEpisodeState; result: T; write: boolean },
  ): Promise<T> {
    let last: { state: WakeCrashLoopEpisodeState; result: T } | null = null;
    for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt += 1) {
      const record = await this.read(agentId);
      const next = transition(record.state);
      last = next;
      if (!next.write) return next.result;
      if (await this.store.compareAndSetWakeCrashLoopState(agentId, record.version, next.state)) return next.result;
    }
    throw new Error(`wake crash-loop state for agent ${agentId}: compare-and-set did not converge after ${CAS_MAX_ATTEMPTS} attempts`);
  }

  async isBlocked(agentId: string): Promise<boolean> {
    return (await this.read(agentId)).state.blocked;
  }

  /** task #1221: does the next start owe the unread catch-up (see `catchupOwed`)? */
  async isCatchupOwed(agentId: string): Promise<boolean> {
    return (await this.read(agentId)).state.catchupOwed === true;
  }

  /** task #1221: this start (launchId) carries the owed catch-up. */
  async markCatchupCarried(agentId: string, launchId: string): Promise<void> {
    await this.mutate(agentId, (state) => state.catchupOwed === true && state.lastStartLaunchId === launchId
      ? { state: { ...state, catchupCarriedLaunchId: launchId }, result: undefined, write: true }
      : { state, result: undefined, write: false });
  }

  /**
   * task #1221: a start reported its runtime active. If it is the start that
   * carried the owed catch-up, the messages reached the runtime: clear it. A
   * failed query, a start that could not carry it, or a runtime that never
   * came up leaves it owed for the next start.
   */
  async confirmCatchupDelivered(agentId: string, launchId: string): Promise<boolean> {
    return this.mutate(agentId, (state) => state.catchupOwed === true && state.catchupCarriedLaunchId === launchId
      ? { state: { ...state, catchupOwed: false, catchupCarriedLaunchId: null }, result: true, write: true }
      : { state, result: false, write: false });
  }

  /**
   * Record a dispatched start. Returns a token for `rollbackStart` so a start
   * whose send fails can be undone without disturbing a newer start.
   */
  async recordStart(agentId: string, launchId: string | null, nowMs: number, options: { human?: boolean } = {}): Promise<WakeCrashLoopStartRecord> {
    return this.mutate(agentId, (state) => ({
      state: applyWakeCrashLoopStart(state, { launchId, nowMs, human: options.human === true }, this.rules),
      result: { launchId, nowMs, previous: { ...state } },
      write: true,
    }));
  }

  /**
   * Undo a `recordStart` whose dispatch never left this replica. Only applies
   * while the recorded start is still the current one (same launchId and
   * start time); a newer start or a counted exit leaves the state alone.
   */
  async rollbackStart(agentId: string, record: WakeCrashLoopStartRecord): Promise<boolean> {
    return this.mutate(agentId, (state) => {
      const isSameStart = state.lastStartAtMs === record.nowMs
        && state.lastStartLaunchId === record.launchId
        && !state.lastStartCounted;
      return isSameStart
        ? { state: { ...record.previous }, result: true, write: true }
        : { state, result: false, write: false };
    });
  }

  async recordManualStop(agentId: string): Promise<void> {
    await this.mutate(agentId, (state) => ({
      state: applyWakeCrashLoopManualStop(state),
      result: undefined,
      write: true,
    }));
  }

  async recordExit(agentId: string, exit: WakeCrashLoopExit, nowMs: number): Promise<WakeCrashLoopExitObservation> {
    return this.mutate(agentId, (state) => {
      const applied = applyWakeCrashLoopExit(state, exit, nowMs, this.rules);
      return {
        state: applied.state,
        write: applied.counted,
        result: {
          counted: applied.counted,
          rejected: applied.rejected,
          blockedNow: applied.blockedNow,
          snapshot: wakeCrashLoopSnapshot(applied.state, this.rules),
        },
      };
    });
  }

  /** task #1221: see `applyWakeCrashLoopNonRetryableStartFailure`. */
  async recordNonRetryableStartFailure(
    agentId: string,
    input: { launchId: string | null; reason: string; nowMs: number },
  ): Promise<boolean> {
    return this.mutate(agentId, (state) => {
      const applied = applyWakeCrashLoopNonRetryableStartFailure(state, input);
      return { state: applied.state, result: applied.blockedNow, write: applied.blockedNow };
    });
  }

  /**
   * task #1221: the agent's runtime configuration changed, so a block that
   * retrying could not lift may no longer apply. Open a fresh episode; the next
   * wake starts normally. Also drops the in-flight start's eligibility, so a
   * failure it reports after the change cannot block. A human start/resume
   * lifts a block too (recordStart).
   */
  async liftForConfigChange(agentId: string): Promise<boolean> {
    return this.mutate(agentId, (state) => {
      if (state.blocked) {
        return {
          state: { ...freshWakeCrashLoopEpisode(state.episode + 1), catchupOwed: state.catchupOwed === true },
          result: true,
          write: true,
        };
      }
      // Not blocked yet, but a start made under the old configuration may still
      // report its failure. Forget that start so its late failure cannot block
      // the agent under the new configuration.
      if (state.lastStartLaunchId === null) return { state, result: false, write: false };
      return { state: { ...state, lastStartLaunchId: null }, result: false, write: true };
    });
  }

  async snapshot(agentId: string): Promise<WakeCrashLoopActivityDiagnostic> {
    return wakeCrashLoopSnapshot((await this.read(agentId)).state, this.rules);
  }
}
