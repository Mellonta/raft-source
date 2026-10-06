/**
 * RFC 071 — terminal runtime failure wake breaker (server state, part 1).
 *
 * A runtime that ends every turn in the same terminal failure (field case:
 * Pi threshold compaction fails on a ~184K-token session) is resumed by every
 * automatic wake and fails again. The task #1119 crash-loop breaker cannot see
 * it: the daemon reports `inactive` without exit evidence. This module is the
 * separate per-agent state machine the RFC proposes: pure transitions for every
 * row of the RFC §8 state table, the catch-up obligation of §6, and the record
 * codec. The stores (Redis CAS + in-memory fallback) and the combined two-key
 * claim live in `terminalFailureBreakerStore.ts`. Nothing here is wired into
 * the orchestrator yet; that is a later part.
 *
 * Shape of the rules (RFC sections in brackets):
 *  - E1 (`terminal_failure` frame) and E2 (`turn_completed`) are applied only
 *    when bound to the current launch, its generation, a newer
 *    (daemonInstanceId, clientSeq), and, for E2, the session [4.2];
 *  - E1 counts; SAME_FP / TOTAL thresholds open the breaker with a backoff
 *    [4.5]; E2 resets the counts and keeps the launch current [4.2];
 *  - automatic starts pass a gate and then a claim; `open` past its backoff
 *    admits exactly one probe under a lease, evaluated lazily [4.3];
 *  - no automatic start while a dispatched process was never seen to exit
 *    (`unexited`, rules 1-8 of 4.3), or when the machine cannot report outcomes
 *    after protection [7];
 *  - owed messages are tracked as a catch-up obligation that only an echoed,
 *    rendered batch fulfils, by contiguous-prefix coverage [6].
 *
 * Every threshold, backoff, lease and bound exported below is a CANDIDATE value
 * (RFC 071 §8 "Candidate values"), to be validated, not a decision.
 * Observation carrier: ids, classes, counts and times only, never message text.
 */

// --- Candidate values (RFC 071 §8). Candidates to validate, not decisions. ---

/** Candidate: consecutive terminal failures with the same fingerprint that open the breaker. */
export const TERMINAL_FAILURE_SAME_FP_THRESHOLD = 2;
/** Candidate: consecutive terminal failures, any fingerprint, no E2/E3 between, that open the breaker. */
export const TERMINAL_FAILURE_TOTAL_THRESHOLD = 3;
/** Candidate: backoff per step, 1 h → 4 h → 24 h; the last step is the cap. */
export const TERMINAL_FAILURE_BACKOFF_MS: readonly number[] = [3_600_000, 4 * 3_600_000, 24 * 3_600_000];
/** Candidate: how long a half_open probe owns the breaker before the lease lapses to open. */
export const TERMINAL_FAILURE_PROBE_LEASE_MS = 30 * 60_000;
/** Candidate: bound of the `unexited` set; one more drops the oldest and sets `unexitedOverflow`. */
export const TERMINAL_FAILURE_UNEXITED_MAX = 8;
/** Candidate: bound of `recentExits` (count). */
export const TERMINAL_FAILURE_RECENT_EXITS_MAX = 16;
/** Candidate: bound of `recentExits` (age). */
export const TERMINAL_FAILURE_RECENT_EXITS_MAX_AGE_MS = 24 * 3_600_000;
/** Candidate: owed conversations tracked by ceiling; one more sets `owedOverflow`. */
export const TERMINAL_FAILURE_OWED_CONVERSATIONS_MAX = 64;
/**
 * Candidate (not named in the RFC, which only says "bounded, oldest dropped"):
 * launches remembered per process in `unexited[].launchIds`.
 */
export const TERMINAL_FAILURE_LAUNCH_IDS_PER_PROCESS_MAX = 8;
/**
 * Candidate (not named in the RFC; diagnostics only, never blocks): bound of
 * `acknowledgedUnexited`, oldest dropped.
 */
export const TERMINAL_FAILURE_ACKNOWLEDGED_UNEXITED_MAX = 16;
/** Candidate: the resume catch-up candidate page (`RESUME_CATCHUP_MAX_CHANNELS * 4` in messageService). */
export const TERMINAL_FAILURE_CATCHUP_MAX_CANDIDATES = 32;

// --- Record (RFC 071 §4.1) ---

export type TerminalBreakerCircuit = "closed" | "open" | "half_open";
export type TerminalLaunchOutcome = "e1" | "process_exit";

/** Ordering key of a daemon frame (RFC 069 §8 per-agent counter), compared within one daemon instance. */
export interface TerminalFrameSeq {
  daemonInstanceId: string;
  clientSeq: number;
}

/** The launch whose evidence may count (`currentLaunch`), or the previous probe (`lastProbe`). */
export interface TerminalBreakerLaunch {
  launchId: string;
  /** Record generation at claim. */
  generation: number;
  /** sessionId the server asked this launch to resume. */
  resumedSessionId: string | null;
  isProbe: boolean;
  /** Claim identity, used by rollback. */
  claimedAtMs: number;
  /** Probe only. */
  leaseExpiresAtMs: number | null;
  lastAppliedSeq: TerminalFrameSeq | null;
  /** Set once the launch is known dead; E1 wins (RFC 4.3). Doubles as the "counted" flag of RFC 4.5. */
  terminal: TerminalLaunchOutcome | null;
  /** The start ack said the daemon rebound a live process. */
  takeover: boolean;
  /** Batch this launch's agent:start carried (RFC 6). */
  catchupBatchId: string | null;
}

export type TerminalNeedsManualReason =
  | "unexited_process"
  | "daemon_restarted_no_exit"
  | "unexited_overflow"
  | "outcome_unobservable"
  /**
   * RFC 071 part 3 (outbox): evidence the daemon produced is known to be lost
   * or of unknown effect: a gap / cross-instance marker of critical frames,
   * a frame from a daemon instance whose watermark was dropped, or a frame
   * the server cannot read. Only a human start clears it.
   */
  | "outcome_evidence_lost";

/** Identifies one `unexited` entry: one dispatched start on one daemon instance. */
export interface TerminalUnexitedKey {
  spawnLaunchId: string;
  daemonInstanceId: string;
}

export interface TerminalNeedsManual {
  reason: TerminalNeedsManualReason;
  sinceMs: number;
  /**
   * The `unexited` entries whose state set this block (reasons
   * `unexited_process` and `daemon_restarted_no_exit`; empty otherwise). The
   * block lifts on its own only once every one of them is resolved and
   * nothing else blocks (`settleTerminalNeedsManual`).
   */
  causeEntries: TerminalUnexitedKey[];
}

/** A start dispatched and never seen to exit (RFC 4.3 rules 1-8). */
export interface TerminalUnexitedEntry {
  /** The launch the start was dispatched with; written BEFORE dispatch. */
  spawnLaunchId: string;
  /** The machine's daemon instance at dispatch time. */
  daemonInstanceId: string;
  /** Null until a rebind ack or `agent:process_spawned` supplies it. */
  processInstanceId: string | null;
  /** Every launch this process carried (a rebind appends); bounded, oldest dropped. */
  launchIds: string[];
  dispatchedAtMs: number;
  /**
   * Durable marker: the entry was created, updated or present while the
   * breaker was engaged (`isTerminalBreakerEngaged`). Never reset: it leaves
   * with the entry (exit, rejected before spawn, human takeover). Decides
   * whether a daemon restart may drop the entry (never protected) or must
   * block on it (review of PR #8633, item 4).
   */
  protected: boolean;
}

/** Settles an identity that arrives after its exit (RFC 4.3 rule 3). */
export interface TerminalRecentExit {
  daemonInstanceId: string;
  processInstanceId: string;
  /** Null for a process the daemon started without a server launch (exit with `spawnLaunchId: null`). */
  spawnLaunchId: string | null;
  atMs: number;
}

/**
 * Taken over by an explicit human start, or dropped by a daemon restart
 * because it was never protected; diagnostics only, never blocks.
 * Superset of the RFC's `{processInstanceId, daemonInstanceId, ackedAtMs}`:
 * `spawnLaunchId` is kept and `processInstanceId` may be null, so an entry
 * whose identity never arrived before the takeover can still be matched by a
 * late exit (RFC 4.3 rule 7 with the rule 3 fallback).
 */
export interface TerminalAcknowledgedUnexited {
  processInstanceId: string | null;
  daemonInstanceId: string;
  spawnLaunchId: string;
  ackedAtMs: number;
  /** A human start took it over, or a daemon restart dropped a never-protected entry. */
  reason: TerminalAcknowledgedReason;
}

export type TerminalAcknowledgedReason = "human_start" | "daemon_restarted_untracked";

export interface TerminalSameFingerprint {
  fingerprint: string;
  count: number;
}

export interface TerminalLastFailure {
  kind: string;
  fingerprint: string;
  launchId: string;
  sessionId: string | null;
  atMs: number;
}

export interface CatchupCoverage {
  conversationId: string;
  /** The lower bound used: max(read cursor, obligation cursor). */
  fromSeqExclusive: number;
  /** Contiguous prefix: every deliverable row in (fromSeqExclusive, coveredUpToSeq] was rendered. */
  coveredUpToSeq: number;
  truncated: boolean;
}

export interface CatchupBatchMessage {
  id: string;
  conversationId: string;
  seq: number;
  /** False for a row appended out of order (the folded wake message); it never extends coverage. */
  inPrefix: boolean;
}

export interface CatchupBatch {
  /** Also sent on agent:start (RFC 7). */
  batchId: string;
  launchId: string;
  builtAtMs: number;
  coverage: CatchupCoverage[];
  /** In the order rendered. */
  messages: CatchupBatchMessage[];
  /**
   * Not in the RFC's CatchupBatch sketch, needed to evaluate its §6 rule that
   * an `owedOverflow` obligation is fulfilled only by a batch with no
   * candidate-cap cut and coverage of every unread conversation.
   * `allUnreadCovered` is computed by `buildCatchupBatch` (every conversation
   * unread at build time covered up to its latest unread seq), never supplied.
   */
  candidateCapHit: boolean;
  allUnreadCovered: boolean;
}

export interface CatchupObligation {
  /** conversationId -> highest owed seq (bounded). */
  owedCeilings: Record<string, number>;
  /** Too many conversations or state lost: every unread row is owed. */
  owedOverflow: boolean;
  /** conversationId -> rendered in a clean turn up to seq. */
  obligationCursor: Record<string, number>;
  pendingBatch: CatchupBatch | null;
  /**
   * Origin of the debt (review of c8ece02f2). True once any part of it was
   * owed because of a failure-driven transition: the breaker opening, a probe
   * failing, a refusal while open / half_open / needs-manual for a reason
   * other than `unexited_process` / capability lost, or a lost record. False
   * while it only holds messages refused because a start was waiting for its
   * process identity on a never-failed agent. Those messages are still owed
   * and delivered, but such an obligation is NOT breaker engagement, so it
   * does not mark entries `protected`. Never reset to false while the
   * obligation exists.
   */
  engagedByFailure: boolean;
}

/** Why a ceiling is raised; see `CatchupObligation.engagedByFailure`. */
export type CatchupObligationOrigin = "failure" | "identity_wait";

export interface TerminalBreakerDiagnostics {
  /** Typed instead of the RFC's `unknown` (repo rule: no new bare `unknown` business fields). */
  lastFailure: TerminalLastFailure | null;
  lastClosedReason: string | null;
}

/**
 * RFC 071 part 3: per daemon instance, the highest `clientSeq` of its outbox
 * frames this record has committed (applied, or judged and ignored), as
 * `{ [daemonInstanceId]: clientSeq }`. It lives in the record itself, so the
 * state change a frame makes and the watermark that marks it done are one
 * compare-and-set. A frame at or below it is a replay: acknowledged again,
 * never applied again.
 *
 * Never forgotten (review of #8824, option B): there is no bound and no
 * eviction, no lift / reset / human start / manual stop clears it, and a
 * record holding any watermark never expires (`terminalBreakerTtlSeconds`).
 * Growth: one entry (a 36-character instance id and a number, about 50 bytes
 * encoded) per daemon instance that ever committed a frame for the agent,
 * i.e. per daemon restart that produced evidence for it.
 */
export type TerminalOutboxWatermarks = Record<string, number>;

export interface TerminalBreakerTransition {
  from: string;
  to: string;
  cause: string;
  atMs: number;
}

export interface TerminalFailureBreakerState {
  schema: 1;
  state: TerminalBreakerCircuit;
  /** Recovery generation (RFC 4.2): bumped only by an E3 lift or a probe rollback. */
  generation: number;
  currentLaunch: TerminalBreakerLaunch | null;
  /**
   * The previous probe. The RFC lists a subset of the launch fields; the whole
   * launch is kept so a late E2 can be session-bound against the probe's own
   * `resumedSessionId` (RFC 4.3 late-E2 rule, 4.2 rule 4).
   */
  lastProbe: TerminalBreakerLaunch | null;
  /** Automatic starts refused until an E3 human start (RFC 4.3). */
  needsManual: TerminalNeedsManual | null;
  unexited: TerminalUnexitedEntry[];
  recentExits: TerminalRecentExit[];
  unexitedOverflow: boolean;
  acknowledgedUnexited: TerminalAcknowledgedUnexited[];
  sameFingerprint: TerminalSameFingerprint | null;
  /** Consecutive terminal failures without E2/E3. */
  totalCount: number;
  /** Index into TERMINAL_FAILURE_BACKOFF_MS. */
  backoffStep: number;
  openedAtMs: number | null;
  blockedUntilMs: number | null;
  lastFailure: TerminalLastFailure | null;
  catchupObligation: CatchupObligation | null;
  /** Survives every close. */
  diagnostics: TerminalBreakerDiagnostics;
  lastTransition: TerminalBreakerTransition | null;
  /** Outbox dedup watermarks, one per daemon instance; never forgotten (see `TerminalOutboxWatermarks`). */
  outboxWatermarks: TerminalOutboxWatermarks;
  /**
   * The watermarks were lost (the stored record could not be decoded, RFC 4.1).
   * Then an instance without a watermark may have committed frames before,
   * so its first frame is not applied (see `applyTerminalOutboxFrame`).
   */
  outboxWatermarksLost: boolean;
  /**
   * RFC 071 outbox takeover epoch, sent on every `agent:start`. Bumped by
   * every human start claim (the explicit takeover, RFC 4.3 rule 6). A
   * daemon gap / cross-instance marker of an OLDER epoch describes launches
   * claimed before that takeover, which the takeover already settled.
   */
  takeoverEpoch: number;
}

export function freshTerminalFailureBreakerState(): TerminalFailureBreakerState {
  return {
    schema: 1,
    state: "closed",
    generation: 1,
    currentLaunch: null,
    lastProbe: null,
    needsManual: null,
    unexited: [],
    recentExits: [],
    unexitedOverflow: false,
    acknowledgedUnexited: [],
    sameFingerprint: null,
    totalCount: 0,
    backoffStep: 0,
    openedAtMs: null,
    blockedUntilMs: null,
    lastFailure: null,
    catchupObligation: null,
    diagnostics: { lastFailure: null, lastClosedReason: null },
    lastTransition: null,
    outboxWatermarks: {},
    outboxWatermarksLost: false,
    takeoverEpoch: 0,
  };
}

/** Deep copy (plain JSON data), so transitions never alias the input. */
export function cloneTerminalFailureBreakerState(state: TerminalFailureBreakerState): TerminalFailureBreakerState {
  return structuredClone(state);
}

function withTransition(
  state: TerminalFailureBreakerState,
  to: TerminalBreakerCircuit,
  cause: string,
  nowMs: number,
): TerminalFailureBreakerState {
  state.lastTransition = { from: state.state, to, cause, atMs: nowMs };
  state.state = to;
  return state;
}

function backoffMs(step: number): number {
  return TERMINAL_FAILURE_BACKOFF_MS[Math.min(step, TERMINAL_FAILURE_BACKOFF_MS.length - 1)]!;
}

/** `step+` of the §8 legend: min(step + 1, max). */
function nextBackoffStep(step: number): number {
  return Math.min(step + 1, TERMINAL_FAILURE_BACKOFF_MS.length - 1);
}

// --- Unreadable record (RFC 071 §4.1) ---

/**
 * A stored record that cannot be decoded becomes `closed` so the agent is not
 * silenced with no visible reason, but the close must not look like a
 * recovery: every unread row is owed (`owedOverflow`), the reason is
 * `state_unreadable`, and no E2 transition is recorded.
 */
export function terminalBreakerStateFromUnreadable(nowMs: number): TerminalFailureBreakerState {
  const state = freshTerminalFailureBreakerState();
  // A lost record may have been protecting anything: treat the debt as failure-owed (conservative).
  state.catchupObligation = { owedCeilings: {}, owedOverflow: true, obligationCursor: {}, pendingBatch: null, engagedByFailure: true };
  state.diagnostics = { lastFailure: null, lastClosedReason: "state_unreadable" };
  // Which outbox frames were already committed is lost with the record.
  state.outboxWatermarksLost = true;
  state.lastTransition = { from: "unreadable", to: "closed", cause: "state_unreadable", atMs: nowMs };
  return state;
}

// --- Lazy lease expiry (RFC 071 §4.3) ---

/**
 * Every read normalises `half_open` with an expired lease to `open`. The time
 * comes from the stored lease, not the observation time, so replicas agree.
 * The probe moves to `lastProbe`: the process may still be alive.
 */
export function normalizeTerminalBreakerLease(
  current: TerminalFailureBreakerState,
  nowMs: number,
): { state: TerminalFailureBreakerState; expired: boolean } {
  const lease = current.currentLaunch?.leaseExpiresAtMs ?? null;
  if (current.state !== "half_open" || lease === null || nowMs < lease) return { state: current, expired: false };
  const state = cloneTerminalFailureBreakerState(current);
  state.backoffStep = nextBackoffStep(state.backoffStep);
  state.blockedUntilMs = lease + backoffMs(state.backoffStep);
  state.lastProbe = state.currentLaunch;
  state.currentLaunch = null;
  withTransition(state, "open", "lease_expired", lease);
  markProtectedIfEngaged(state);
  return { state, expired: true };
}

// --- Evidence binding (RFC 071 §4.2) ---

export type TerminalFrameIgnoredReason =
  | "no_current_launch"
  | "launch_mismatch"
  | "generation_mismatch"
  | "stale_seq"
  | "already_counted"
  | "after_terminal"
  | "session_unbound";

interface TerminalFrameBase {
  launchId: string;
  sessionId: string | null;
  daemonInstanceId: string;
  clientSeq: number;
}

/** E1: `agent:runtime:outcome` with `outcome.kind = "terminal_failure"`. */
export interface TerminalFailureFrame extends TerminalFrameBase {
  failureKind: string;
  /** 16 hex from the RAW runtime text (RFC 7). */
  fingerprint: string;
}

/** E2: `agent:runtime:outcome` with `outcome.kind = "turn_completed"`. */
export interface TurnCompletedFrame extends TerminalFrameBase {
  catchupBatchId: string | null;
  /**
   * With `catchupBatchId`: how many of the batch's rows the daemon rendered
   * into that turn's input. The outbox ingest always sets it (null when the
   * frame carried none, which fulfils nothing); `undefined` is only for
   * in-process callers that bypass the wire.
   */
  catchupRenderedRows?: number | null;
}

/** Strictly newer within the same daemon instance; a different instance is not comparable and passes. */
function isSeqNewer(last: TerminalFrameSeq | null, frame: TerminalFrameSeq): boolean {
  if (last === null || last.daemonInstanceId !== frame.daemonInstanceId) return true;
  return frame.clientSeq > last.clientSeq;
}

/**
 * Binding checks in order: launch, generation, seq, then the launch's terminal
 * outcome. Seq comes before terminal so an older frame reads as `stale_seq`
 * (RFC test C-6) and a newer frame after a terminal outcome as `already_counted`
 * / `after_terminal` (RFC tests C-4, H-8b(ii)).
 */
function bindLaunch(
  launch: TerminalBreakerLaunch,
  generation: number,
  frame: TerminalFrameBase,
  terminalReason: "already_counted" | "after_terminal",
): TerminalFrameIgnoredReason | null {
  if (frame.launchId !== launch.launchId) return "launch_mismatch";
  if (launch.generation !== generation) return "generation_mismatch";
  if (!isSeqNewer(launch.lastAppliedSeq, frame)) return "stale_seq";
  if (launch.terminal !== null) return terminalReason;
  return null;
}

function isSessionBound(frame: TerminalFrameBase, launch: TerminalBreakerLaunch, persistedSessionId: string | null): boolean {
  if (frame.sessionId === null) return false;
  return frame.sessionId === launch.resumedSessionId || (persistedSessionId !== null && frame.sessionId === persistedSessionId);
}

function frameSeq(frame: TerminalFrameBase): TerminalFrameSeq {
  return { daemonInstanceId: frame.daemonInstanceId, clientSeq: frame.clientSeq };
}

// --- Catch-up obligation (RFC 071 §6) ---

function emptyObligation(): CatchupObligation {
  return { owedCeilings: {}, owedOverflow: false, obligationCursor: {}, pendingBatch: null, engagedByFailure: false };
}

/**
 * Raise the owed ceilings: the breaker opening (every conversation with unread
 * rows, ceiling = its latest unread seq) or a refused wake for one message.
 * `null` means the unread set is not known (the chain could not be read): owe
 * every unread row. Past the conversation bound, `owedOverflow` is set.
 * `origin` defaults to `failure` (the conservative side); only the gate's
 * identity-wait refusal passes `identity_wait`.
 */
export function raiseCatchupObligation(
  current: CatchupObligation | null,
  ceilings: Record<string, number> | null,
  origin: CatchupObligationOrigin = "failure",
): CatchupObligation {
  const obligation: CatchupObligation = current ? structuredClone(current) : emptyObligation();
  if (origin === "failure") obligation.engagedByFailure = true;
  if (ceilings === null) {
    obligation.owedOverflow = true;
    return obligation;
  }
  for (const [conversationId, seq] of Object.entries(ceilings)) {
    const existing = obligation.owedCeilings[conversationId];
    if (existing !== undefined) {
      obligation.owedCeilings[conversationId] = Math.max(existing, seq);
      continue;
    }
    if (Object.keys(obligation.owedCeilings).length >= TERMINAL_FAILURE_OWED_CONVERSATIONS_MAX) {
      obligation.owedOverflow = true;
      continue;
    }
    obligation.owedCeilings[conversationId] = seq;
  }
  return obligation;
}

/** The next batch's lower bound for a conversation: max(read cursor, obligation cursor). Never goes backwards. */
export function catchupLowerBound(obligation: CatchupObligation | null, conversationId: string, readCursor: number): number {
  const obligationCursor = obligation?.obligationCursor[conversationId];
  return obligationCursor === undefined ? readCursor : Math.max(readCursor, obligationCursor);
}

function isConversationFulfilled(obligation: CatchupObligation, conversationId: string): boolean {
  const ceiling = obligation.owedCeilings[conversationId];
  if (ceiling === undefined) return true;
  return (obligation.obligationCursor[conversationId] ?? -Infinity) >= ceiling;
}

export function isCatchupObligationFulfilled(obligation: CatchupObligation): boolean {
  if (obligation.owedOverflow) return false;
  return Object.keys(obligation.owedCeilings).every((conversationId) => isConversationFulfilled(obligation, conversationId));
}

export interface ResumeCatchupCandidateInput {
  conversationId: string;
  /** The agent's read cursor for the conversation. */
  lastReadSeq: number;
  firstUnreadSeq: number;
  latestUnreadSeq: number;
}

export interface ObligationCatchupCandidate extends ResumeCatchupCandidateInput {
  /** max(read cursor, obligation cursor): the row query's exclusive lower bound. */
  lowerBoundSeq: number;
  owed: boolean;
}

/**
 * Candidate selection while an obligation exists (RFC 6 "no starvation"):
 *  1. the lower bound is applied BEFORE the cut; a candidate with no unread
 *     row above it is dropped, so a covered conversation takes no slot;
 *  2. unfulfilled owed conversations first, oldest owed first (lowest
 *     unfulfilled seq ascending); ties and the rest keep the input order
 *     (today's comparator);
 *  3. then the candidate cut.
 */
export function selectObligationCatchupCandidates(
  obligation: CatchupObligation | null,
  candidatesInTodaysOrder: ResumeCatchupCandidateInput[],
  maxCandidates: number = TERMINAL_FAILURE_CATCHUP_MAX_CANDIDATES,
): { candidates: ObligationCatchupCandidate[]; candidateCapHit: boolean } {
  const eligible = candidatesInTodaysOrder
    .map((candidate, index) => {
      const lowerBoundSeq = catchupLowerBound(obligation, candidate.conversationId, candidate.lastReadSeq);
      const owed = obligation !== null
        && obligation.owedCeilings[candidate.conversationId] !== undefined
        && !isConversationFulfilled(obligation, candidate.conversationId);
      return { candidate: { ...candidate, lowerBoundSeq, owed }, index, lowestUnfulfilledSeq: Math.max(candidate.firstUnreadSeq, lowerBoundSeq + 1) };
    })
    .filter(({ candidate }) => candidate.latestUnreadSeq > candidate.lowerBoundSeq);
  eligible.sort((a, b) => {
    if (a.candidate.owed !== b.candidate.owed) return a.candidate.owed ? -1 : 1;
    if (a.candidate.owed && a.lowestUnfulfilledSeq !== b.lowestUnfulfilledSeq) return a.lowestUnfulfilledSeq - b.lowestUnfulfilledSeq;
    return a.index - b.index;
  });
  return {
    candidates: eligible.slice(0, maxCandidates).map(({ candidate }) => candidate),
    candidateCapHit: eligible.length > maxCandidates,
  };
}

export interface CatchupBatchBuildInput {
  batchId: string;
  launchId: string;
  builtAtMs: number;
  /** Every conversation whose rows the batch read (AgentResumeCatchupResult.conversations). */
  conversations: Array<{
    conversationId: string;
    /** The lower bound the rows were read from (see `catchupLowerBound`). */
    fromSeqExclusive: number;
    /** The conversation's latest seq seen by the chain at build time (read before the rows). */
    latestSeq: number;
    /** More deliverable rows exist above the fetched ones (the query hit its row limit). */
    truncated: boolean;
    /**
     * Input contract: EVERY deliverable seq the row query returned above
     * `fromSeqExclusive` (after the per-row filters), ascending. Coverage is
     * derived from this list and the rendered rows only.
     */
    fetchedSeqs: number[];
  }>;
  /** Rows in the order rendered; `appendedOutOfOrder` marks the folded wake message. */
  rendered: Array<{ id: string; conversationId: string; seq: number; appendedOutOfOrder: boolean }>;
  /**
   * Owed conversations the batch did not read, with their current read
   * cursor. One whose cursor has passed its ceiling is listed with
   * `coveredUpToSeq = fromSeqExclusive`, so the echo fulfils it (RFC 6 "read cursor").
   */
  owedReadCursors: Record<string, number>;
  candidateCapHit: boolean;
  /**
   * Every conversation the chain reported unread at build time → its latest
   * unread seq. `allUnreadCovered` is computed against it; it is never taken
   * from the caller.
   */
  unreadLatestSeqs: Record<string, number>;
}

/**
 * Coverage of one conversation: the contiguous prefix of the FETCHED
 * deliverable rows that were rendered in order (RFC 6). It never claims more
 * than was rendered:
 *  - no row rendered (including an empty fetch): `fromSeqExclusive` itself;
 *  - a fetched row not rendered ends the prefix before it;
 *  - a row appended out of order, or not in the fetch, never extends it;
 *  - only when the fetch was not truncated, was non-empty, and every fetched
 *    row was rendered, does coverage extend to `latestSeq`: rows between the
 *    last fetched row and `latestSeq` were then filtered by the same
 *    deliverability rule, so none is left undelivered.
 */
function conversationCoverage(
  c: CatchupBatchBuildInput["conversations"][number],
  renderedInOrder: Set<number>,
): number {
  let covered = c.fromSeqExclusive;
  let all = true;
  for (const seq of c.fetchedSeqs) {
    if (seq <= c.fromSeqExclusive) continue;
    if (!renderedInOrder.has(seq)) { all = false; break; }
    covered = seq;
  }
  if (all && !c.truncated && covered > c.fromSeqExclusive) covered = Math.max(covered, c.latestSeq);
  return covered;
}

/** Build the batch record (RFC 6); see `conversationCoverage` for the coverage rule. */
export function buildCatchupBatch(obligation: CatchupObligation | null, input: CatchupBatchBuildInput): CatchupBatch {
  const byConversation = new Map(input.conversations.map((c) => [c.conversationId, c]));
  // Rows rendered in ascending order per conversation, not appended out of order.
  const renderedInOrder = new Map<string, Set<number>>();
  const lastRendered = new Map<string, number>();
  for (const row of input.rendered) {
    if (row.appendedOutOfOrder || !byConversation.has(row.conversationId)) continue;
    const previous = lastRendered.get(row.conversationId) ?? -Infinity;
    if (row.seq <= previous) continue;
    lastRendered.set(row.conversationId, row.seq);
    let set = renderedInOrder.get(row.conversationId);
    if (!set) renderedInOrder.set(row.conversationId, (set = new Set()));
    set.add(row.seq);
  }
  const coverage: CatchupCoverage[] = input.conversations.map((c) => ({
    conversationId: c.conversationId,
    fromSeqExclusive: c.fromSeqExclusive,
    coveredUpToSeq: conversationCoverage(c, renderedInOrder.get(c.conversationId) ?? new Set()),
    truncated: c.truncated,
  }));
  const coveredBy = new Map(coverage.map((entry) => [entry.conversationId, entry]));
  const messages: CatchupBatchMessage[] = input.rendered.map((row) => {
    const conversation = byConversation.get(row.conversationId);
    const entry = coveredBy.get(row.conversationId);
    const inPrefix = !row.appendedOutOfOrder
      && conversation !== undefined && entry !== undefined
      && conversation.fetchedSeqs.includes(row.seq)
      && row.seq > entry.fromSeqExclusive && row.seq <= entry.coveredUpToSeq;
    return { id: row.id, conversationId: row.conversationId, seq: row.seq, inPrefix };
  });
  if (obligation) {
    for (const [conversationId, readCursor] of Object.entries(input.owedReadCursors)) {
      if (byConversation.has(conversationId)) continue;
      const ceiling = obligation.owedCeilings[conversationId];
      if (ceiling === undefined || isConversationFulfilled(obligation, conversationId)) continue;
      const from = catchupLowerBound(obligation, conversationId, readCursor);
      if (from < ceiling) continue;
      coverage.push({ conversationId, fromSeqExclusive: from, coveredUpToSeq: from, truncated: false });
    }
  }
  const finalCoverage = new Map(coverage.map((entry) => [entry.conversationId, entry.coveredUpToSeq]));
  const allUnreadCovered = !input.candidateCapHit
    && Object.entries(input.unreadLatestSeqs).every(([conversationId, latest]) => (finalCoverage.get(conversationId) ?? -Infinity) >= latest);
  return {
    batchId: input.batchId,
    launchId: input.launchId,
    builtAtMs: input.builtAtMs,
    coverage,
    messages,
    candidateCapHit: input.candidateCapHit,
    allUnreadCovered,
  };
}

/**
 * Apply an echoed batch: advance each covered conversation's obligation
 * cursor (never lowering it). An overflow obligation is cleared only by a
 * complete batch. Returns null once every owed conversation is fulfilled.
 */
export function applyCatchupEcho(obligation: CatchupObligation, batch: CatchupBatch): CatchupObligation | null {
  const next = structuredClone(obligation);
  for (const entry of batch.coverage) {
    const existing = next.obligationCursor[entry.conversationId];
    next.obligationCursor[entry.conversationId] = existing === undefined ? entry.coveredUpToSeq : Math.max(existing, entry.coveredUpToSeq);
  }
  if (next.owedOverflow) {
    const complete = !batch.candidateCapHit && batch.allUnreadCovered && batch.coverage.every((entry) => !entry.truncated);
    if (complete) next.owedOverflow = false;
  }
  if (next.pendingBatch?.batchId === batch.batchId) next.pendingBatch = null;
  return isCatchupObligationFulfilled(next) ? null : next;
}

export type AttachCatchupBatchResult =
  | { attached: true; state: TerminalFailureBreakerState }
  | { attached: false; reason: "no_obligation" | "not_current_launch" };

/** A start carried a batch: record it as the pending batch of the current launch. */
export function attachCatchupBatch(current: TerminalFailureBreakerState, batch: CatchupBatch): AttachCatchupBatchResult {
  if (!current.catchupObligation) return { attached: false, reason: "no_obligation" };
  if (current.currentLaunch?.launchId !== batch.launchId) return { attached: false, reason: "not_current_launch" };
  const state = cloneTerminalFailureBreakerState(current);
  state.catchupObligation!.pendingBatch = structuredClone(batch);
  state.currentLaunch!.catchupBatchId = batch.batchId;
  return { attached: true, state };
}

// --- E1 (RFC 071 §4.5, §8 row "E1 applied") ---

export type TerminalOpenTrigger = "same_fp" | "total";

export interface TerminalFailureApplied {
  state: TerminalFailureBreakerState;
  applied: boolean;
  /** Applied and counted (not a late E1 from `lastProbe`). */
  counted: boolean;
  ignored: TerminalFrameIgnoredReason | null;
  openedNow: boolean;
  trigger: TerminalOpenTrigger | null;
}

/**
 * Apply an E1. `unreadCeilings` is the agent's unread snapshot (conversation →
 * latest unread seq) used only if this E1 opens the breaker; `null` = unknown,
 * which owes every unread row.
 */
export function applyTerminalFailureFrame(
  current: TerminalFailureBreakerState,
  frame: TerminalFailureFrame,
  input: { nowMs: number; unreadCeilings: Record<string, number> | null },
): TerminalFailureApplied {
  const ignore = (ignored: TerminalFrameIgnoredReason): TerminalFailureApplied =>
    ({ state: current, applied: false, counted: false, ignored, openedNow: false, trigger: null });
  const { state: normalized } = normalizeTerminalBreakerLease(current, input.nowMs);

  // Open: the current launch (if any) is already terminal. A late E1 from the
  // last probe records its terminal outcome and adds no count (RFC 4.3).
  if (normalized.state === "open") {
    const probe = normalized.lastProbe;
    if (probe === null || frame.launchId !== probe.launchId) {
      if (normalized.currentLaunch === null) return ignore("no_current_launch");
      return ignore(bindLaunch(normalized.currentLaunch, normalized.generation, frame, "already_counted") ?? "already_counted");
    }
    const reason = bindLaunch(probe, normalized.generation, frame, "already_counted");
    if (reason) return ignore(reason);
    const state = cloneTerminalFailureBreakerState(normalized);
    state.lastProbe = { ...probe, terminal: "e1", lastAppliedSeq: frameSeq(frame) };
    finishTransition(state);
    return { state, applied: true, counted: false, ignored: null, openedNow: false, trigger: null };
  }

  const launch = normalized.currentLaunch;
  if (launch === null) return ignore("no_current_launch");
  const reason = bindLaunch(launch, normalized.generation, frame, "already_counted");
  if (reason) return ignore(reason);

  const state = cloneTerminalFailureBreakerState(normalized);
  const failure: TerminalLastFailure = {
    kind: frame.failureKind,
    fingerprint: frame.fingerprint,
    launchId: frame.launchId,
    sessionId: frame.sessionId,
    atMs: input.nowMs,
  };
  state.currentLaunch = { ...launch, terminal: "e1", lastAppliedSeq: frameSeq(frame) };
  state.sameFingerprint = state.sameFingerprint?.fingerprint === frame.fingerprint
    ? { fingerprint: frame.fingerprint, count: state.sameFingerprint.count + 1 }
    : { fingerprint: frame.fingerprint, count: 1 };
  state.totalCount += 1;
  state.lastFailure = failure;
  state.diagnostics = { ...state.diagnostics, lastFailure: failure };

  if (state.state === "half_open") {
    // The probe failed: open with the next backoff step.
    state.backoffStep = nextBackoffStep(state.backoffStep);
    state.blockedUntilMs = input.nowMs + backoffMs(state.backoffStep);
    state.currentLaunch.leaseExpiresAtMs = null;
    state.catchupObligation = raiseCatchupObligation(state.catchupObligation, input.unreadCeilings);
    withTransition(state, "open", "probe_e1", input.nowMs);
    finishTransition(state);
    return { state, applied: true, counted: true, ignored: null, openedNow: true, trigger: null };
  }

  const trigger: TerminalOpenTrigger | null = state.sameFingerprint.count >= TERMINAL_FAILURE_SAME_FP_THRESHOLD
    ? "same_fp"
    : state.totalCount >= TERMINAL_FAILURE_TOTAL_THRESHOLD ? "total" : null;
  if (trigger === null) {
    finishTransition(state);
    return { state, applied: true, counted: true, ignored: null, openedNow: false, trigger: null };
  }
  state.backoffStep = 0;
  state.openedAtMs = input.nowMs;
  state.blockedUntilMs = input.nowMs + backoffMs(0);
  state.catchupObligation = raiseCatchupObligation(state.catchupObligation, input.unreadCeilings);
  withTransition(state, "open", `threshold_${trigger}`, input.nowMs);
  finishTransition(state);
  return { state, applied: true, counted: true, ignored: null, openedNow: true, trigger };
}

// --- E2 (RFC 071 §4.2, §4.4, §8 row "E2 applied") ---

export interface TurnCompletedApplied {
  state: TerminalFailureBreakerState;
  applied: boolean;
  ignored: TerminalFrameIgnoredReason | null;
  closedNow: boolean;
  /** The echo matched the pending batch and was applied. */
  echoApplied: boolean;
}

function resetCounts(state: TerminalFailureBreakerState): void {
  state.sameFingerprint = null;
  state.totalCount = 0;
  state.backoffStep = 0;
}

/**
 * Apply the echo of a pending batch. RFC 071 part 3: the daemon reports how
 * many batch rows it rendered (`catchupRenderedRows`). Coverage was computed
 * from every row the server put in the batch, so it holds only when the
 * daemon rendered all of them; any other count (fewer rows, or no count)
 * fulfils nothing and the batch stays owed. The E2 itself still applies.
 */
function applyEchoIfPending(state: TerminalFailureBreakerState, frame: TurnCompletedFrame): boolean {
  const obligation = state.catchupObligation;
  const batch = obligation?.pendingBatch;
  if (!obligation || !batch || frame.catchupBatchId === null) return false;
  if (batch.batchId !== frame.catchupBatchId || batch.launchId !== frame.launchId) return false;
  // The wire path always passes a value (number, or null when the daemon sent none).
  if (frame.catchupRenderedRows !== undefined && frame.catchupRenderedRows !== batch.messages.length) return false;
  state.catchupObligation = applyCatchupEcho(obligation, batch);
  return true;
}

/**
 * Apply an E2. `persistedSessionId` is the agent's persisted sessionId read at
 * ingest (the second accepted binding of RFC 4.2 rule 4).
 */
export function applyTurnCompletedFrame(
  current: TerminalFailureBreakerState,
  frame: TurnCompletedFrame,
  input: { nowMs: number; persistedSessionId: string | null },
): TurnCompletedApplied {
  const ignore = (ignored: TerminalFrameIgnoredReason): TurnCompletedApplied =>
    ({ state: current, applied: false, ignored, closedNow: false, echoApplied: false });
  const { state: normalized } = normalizeTerminalBreakerLease(current, input.nowMs);

  if (normalized.state === "open") {
    if (normalized.currentLaunch !== null) {
      return ignore(bindLaunch(normalized.currentLaunch, normalized.generation, frame, "after_terminal") ?? "after_terminal");
    }
    // Late E2 from the last probe: terminal null, same generation, no newer
    // launch (currentLaunch is null), newer seq, session-bound (RFC 4.3).
    const probe = normalized.lastProbe;
    if (probe === null) return ignore("no_current_launch");
    const reason = bindLaunch(probe, normalized.generation, frame, "after_terminal");
    if (reason) return ignore(reason);
    if (!isSessionBound(frame, probe, input.persistedSessionId)) return ignore("session_unbound");
    const state = cloneTerminalFailureBreakerState(normalized);
    resetCounts(state);
    state.currentLaunch = { ...probe, lastAppliedSeq: frameSeq(frame), leaseExpiresAtMs: null };
    state.lastProbe = null;
    state.blockedUntilMs = null;
    state.openedAtMs = null;
    const echoApplied = applyEchoIfPending(state, frame);
    withTransition(state, "closed", "late_e2", input.nowMs);
    finishTransition(state);
    return { state, applied: true, ignored: null, closedNow: true, echoApplied };
  }

  const launch = normalized.currentLaunch;
  if (launch === null) return ignore("no_current_launch");
  const reason = bindLaunch(launch, normalized.generation, frame, "after_terminal");
  if (reason) return ignore(reason);
  if (!isSessionBound(frame, launch, input.persistedSessionId)) return ignore("session_unbound");

  const state = cloneTerminalFailureBreakerState(normalized);
  resetCounts(state);
  // The launch stays current and the generation is unchanged (RFC 4.2, C-10).
  state.currentLaunch = { ...launch, lastAppliedSeq: frameSeq(frame) };
  const echoApplied = applyEchoIfPending(state, frame);
  if (state.state === "half_open") {
    state.currentLaunch.leaseExpiresAtMs = null;
    state.blockedUntilMs = null;
    state.openedAtMs = null;
    withTransition(state, "closed", "probe_e2", input.nowMs);
    finishTransition(state);
    return { state, applied: true, ignored: null, closedNow: true, echoApplied };
  }
  finishTransition(state);
  return { state, applied: true, ignored: null, closedNow: false, echoApplied };
}

// --- Gate and claim (RFC 071 §4.3, §7, §8 rows "fast reject" / "claim") ---

export type TerminalWakeRefusal =
  | "terminal_failure_paused"
  | "terminal_failure_probe_in_flight"
  | "terminal_failure_needs_manual";

/**
 * Has the breaker recorded anything for this agent? "Never protected" (RFC 7)
 * is the complement: closed, no counts, nothing unexited, no needs-manual.
 */
export function isTerminalBreakerProtecting(state: TerminalFailureBreakerState): boolean {
  return state.state !== "closed"
    || state.needsManual !== null
    || state.unexited.length > 0
    || state.unexitedOverflow
    || state.totalCount > 0;
}

function needsManualReasonFor(state: TerminalFailureBreakerState): TerminalNeedsManualReason {
  return state.unexitedOverflow ? "unexited_overflow" : "unexited_process";
}

/**
 * Is this entry the CONFIRMED process of the live current launch? Confirmed
 * means its identity arrived (rebind ack or `agent:process_spawned`); live
 * means `closed`, current generation, and no terminal outcome recorded for
 * the launch. A pending entry (identity null) is an unknown start and is
 * never confirmed, even when it belongs to the current launch (review of
 * PR #8633, item 1).
 *
 * Documented limitation (accepted in review): a confirmed identity is not
 * proof the process is still alive. If its exit frame was lost, the entry
 * stays exempt in `closed` until the next start or a daemon restart. The
 * orchestrator wiring must keep the reuse-vs-new-process boundary: a start
 * exempted here must reach the daemon as a rebind onto that process or a new
 * spawn that the daemon reports (ack / `agent:process_spawned`) as a new
 * pending entry; it must never assume reuse on the server side.
 */
function isConfirmedLiveCurrentProcess(state: TerminalFailureBreakerState, entry: TerminalUnexitedEntry): boolean {
  const launch = state.currentLaunch;
  return state.state === "closed"
    && launch !== null
    && launch.terminal === null
    && launch.generation === state.generation
    && entry.processInstanceId !== null
    && entry.launchIds.includes(launch.launchId);
}

/**
 * `unexited` entries that block an automatic start. In `closed`, only the
 * confirmed process of the live current launch is exempt: it is the healthy
 * runtime, and RFC test H-10(b) requires the next automatic wake to pass
 * after a probe's clean turn while that process still runs. Every other
 * entry blocks, in every state: a pending (unconfirmed) dispatch (RFC 4.3
 * rules 1-2), rule 5, X-5(d), and the §8 "E3 reset" row.
 */
export function blockingUnexitedEntries(state: TerminalFailureBreakerState): TerminalUnexitedEntry[] {
  return state.unexited.filter((entry) => !isConfirmedLiveCurrentProcess(state, entry));
}

export function unexitedKey(entry: TerminalUnexitedKey): TerminalUnexitedKey {
  return { spawnLaunchId: entry.spawnLaunchId, daemonInstanceId: entry.daemonInstanceId };
}

function sameKey(a: TerminalUnexitedKey, b: TerminalUnexitedKey): boolean {
  return a.spawnLaunchId === b.spawnLaunchId && a.daemonInstanceId === b.daemonInstanceId;
}

/**
 * Has the breaker engaged for this agent (review of PR #8633, item 4)?
 * Counts, a non-closed state, a failure-owed obligation (an obligation made
 * only of identity-wait refusals does not count, review of c8ece02f2), a
 * probe launch, or a
 * needs-manual block that is not merely about the unexited entries
 * themselves. `unexited_process` is excluded: it is set by an ordinary async
 * interleaving on a healthy agent (a gate call between a claim and its ack)
 * and would otherwise protect entries permanently.
 */
export function isTerminalBreakerEngaged(state: TerminalFailureBreakerState): boolean {
  return state.totalCount > 0
    || state.state !== "closed"
    || state.catchupObligation?.engagedByFailure === true
    || state.currentLaunch?.isProbe === true
    || (state.needsManual !== null && state.needsManual.reason !== "unexited_process");
}

/**
 * Mark every current `unexited` entry `protected` when the breaker is
 * engaged. Covers entries created or updated while engaged, and every entry
 * present at the moment it engages. Never un-marks. Returns whether it changed anything.
 */
function markProtectedIfEngaged(state: TerminalFailureBreakerState): boolean {
  if (!isTerminalBreakerEngaged(state)) return false;
  let changed = false;
  for (const entry of state.unexited) {
    if (!entry.protected) { entry.protected = true; changed = true; }
  }
  return changed;
}

/**
 * Lift a needs-manual block only when its recorded cause is resolved
 * (review of PR #8633, item 2):
 *  - `unexited_process`: every cause entry is gone or has become the
 *    confirmed live current process, AND no entry blocks, AND no overflow;
 *  - `daemon_restarted_no_exit`: every cause entry has LEFT `unexited`
 *    (exit, rejection, restart drop), AND no entry blocks, AND no overflow;
 *    an identity arriving never resolves it;
 *  - `unexited_overflow`, `outcome_unobservable`: never; only a human start.
 * Returns whether it cleared the block.
 */
export function settleTerminalNeedsManual(state: TerminalFailureBreakerState): boolean {
  const block = state.needsManual;
  if (block === null) return false;
  if (block.reason !== "unexited_process" && block.reason !== "daemon_restarted_no_exit") return false;
  const blocking = blockingUnexitedEntries(state);
  if (blocking.length > 0 || state.unexitedOverflow) return false;
  const resolved = block.reason === "unexited_process"
    ? block.causeEntries.every((cause) => !blocking.some((entry) => sameKey(entry, cause)))
    : block.causeEntries.every((cause) => !state.unexited.some((entry) => sameKey(entry, cause)));
  if (!resolved) return false;
  state.needsManual = null;
  return true;
}

/** Post-transition bookkeeping on a state the transition owns (already cloned). */
function finishTransition(state: TerminalFailureBreakerState): boolean {
  const settled = settleTerminalNeedsManual(state);
  const marked = markProtectedIfEngaged(state);
  return settled || marked;
}

/**
 * Normalisation every gate and claim applies to what it read: lazy lease
 * expiry, a needs-manual block whose cause is resolved, and the protection
 * marker. `changed` means the next CAS should persist it.
 */
export function normalizeTerminalBreaker(
  current: TerminalFailureBreakerState,
  nowMs: number,
): { state: TerminalFailureBreakerState; changed: boolean } {
  const { state: leased, expired } = normalizeTerminalBreakerLease(current, nowMs);
  const state = expired ? leased : cloneTerminalFailureBreakerState(leased);
  const changed = finishTransition(state) || expired;
  return { state: changed ? state : current, changed };
}

/** Read-only refusal decision for an automatic start (shared by the gate and the claim). */
function automaticRefusal(
  state: TerminalFailureBreakerState,
  nowMs: number,
  capability: boolean,
): { refusal: TerminalWakeRefusal; needsManual: TerminalNeedsManualReason | null } | null {
  if (!capability) {
    // Never protected: today's behaviour. Protected: needs manual, never closed (RFC 7).
    return isTerminalBreakerProtecting(state) ? { refusal: "terminal_failure_needs_manual", needsManual: "outcome_unobservable" } : null;
  }
  if (state.state === "half_open") return { refusal: "terminal_failure_probe_in_flight", needsManual: null };
  if (state.needsManual !== null) return { refusal: "terminal_failure_needs_manual", needsManual: state.needsManual.reason };
  if (blockingUnexitedEntries(state).length > 0 || state.unexitedOverflow) {
    return { refusal: "terminal_failure_needs_manual", needsManual: needsManualReasonFor(state) };
  }
  if (state.state === "open" && state.blockedUntilMs !== null && nowMs < state.blockedUntilMs) {
    return { refusal: "terminal_failure_paused", needsManual: null };
  }
  return null;
}

/**
 * What a person is shown while automatic wakes are stopped (RFC 071 §9),
 * or null when nothing stops them now. `paused`: open and its backoff has
 * not passed (the next wake after `blockedUntilMs` retries). `needs_manual`:
 * only a manual start proceeds. A needs-manual block that only waits for a
 * dispatched start's process identity on a breaker that never engaged
 * (`unexited_process`, settles on its own) is not shown.
 */
export type TerminalBlockView =
  | { kind: "paused"; blockedUntilMs: number; failureKind: string | null }
  | { kind: "needs_manual"; reason: TerminalNeedsManualReason };

export function terminalBlockView(current: TerminalFailureBreakerState, nowMs: number): TerminalBlockView | null {
  const { state } = normalizeTerminalBreaker(current, nowMs);
  if (state.needsManual !== null && (state.needsManual.reason !== "unexited_process" || isTerminalBreakerEngaged(state))) {
    return { kind: "needs_manual", reason: state.needsManual.reason };
  }
  if (state.state === "open" && state.blockedUntilMs !== null && nowMs < state.blockedUntilMs) {
    return { kind: "paused", blockedUntilMs: state.blockedUntilMs, failureKind: state.lastFailure?.kind ?? null };
  }
  return null;
}

export interface TerminalWakeGateResult {
  decision: "pass" | TerminalWakeRefusal;
  state: TerminalFailureBreakerState;
  /** The gate normalised an expired lease, set `needsManual`, or raised an owed ceiling. */
  write: boolean;
}

/**
 * Fast reject for an automatic start. It decides nothing on its own (the
 * claim re-checks), but it persists what a refusal learned: `needsManual`
 * (RFC 4.3 rule 5, RFC 7) and the refused message's owed ceiling (RFC 6).
 */
export function evaluateTerminalWakeGate(
  current: TerminalFailureBreakerState,
  input: { nowMs: number; capability: boolean; wakeMessage: { conversationId: string; seq: number } | null },
): TerminalWakeGateResult {
  const { state: normalized, changed } = normalizeTerminalBreaker(current, input.nowMs);
  const refused = automaticRefusal(normalized, input.nowMs, input.capability);
  if (refused === null) return { decision: "pass", state: normalized, write: changed };
  let write = changed;
  let state = normalized;
  const mutable = (): TerminalFailureBreakerState => {
    if (state === normalized) state = cloneTerminalFailureBreakerState(normalized);
    write = true;
    return state;
  };
  if (refused.needsManual !== null && normalized.needsManual === null) {
    const causeEntries = refused.needsManual === "unexited_process" ? blockingUnexitedEntries(normalized).map(unexitedKey) : [];
    mutable().needsManual = { reason: refused.needsManual, sinceMs: input.nowMs, causeEntries };
  }
  // Identity-wait only: refused solely because a dispatched start has no
  // confirmed process yet, on an agent where no failure engaged the breaker.
  const identityWaitOnly = refused.refusal === "terminal_failure_needs_manual"
    && refused.needsManual === "unexited_process"
    && !isTerminalBreakerEngaged(normalized);
  const origin: CatchupObligationOrigin = identityWaitOnly ? "identity_wait" : "failure";
  if (input.wakeMessage) {
    const { conversationId, seq } = input.wakeMessage;
    const ceiling = normalized.catchupObligation?.owedCeilings[conversationId];
    if (ceiling === undefined || ceiling < seq) {
      const target = mutable();
      target.catchupObligation = raiseCatchupObligation(target.catchupObligation, { [conversationId]: seq }, origin);
    }
  }
  if (origin === "failure" && state.catchupObligation !== null && !state.catchupObligation.engagedByFailure) {
    // A failure-driven refusal now also holds the existing debt.
    mutable().catchupObligation!.engagedByFailure = true;
  }
  if (write && state !== normalized) markProtectedIfEngaged(state);
  return { decision: refused.refusal, state, write };
}

export type TerminalStartControl = "automatic" | "human_start";

export interface TerminalClaimInput {
  launchId: string;
  nowMs: number;
  /** config.sessionId the start asks the runtime to resume. */
  resumedSessionId: string | null;
  /** The target machine's current daemon instance; required to record the pending `unexited` entry. */
  daemonInstanceId: string | null;
  /** The machine advertises `agent:runtime-outcome-v1`. */
  capability: boolean;
  control: TerminalStartControl;
}

/** Claim identity (RFC 4.3 step 3). Rollback applies only while it still matches. */
export interface TerminalClaimToken {
  launchId: string;
  generation: number;
  claimedAtMs: number;
  isProbe: boolean;
  control: TerminalStartControl;
  /** The launch this claim replaced (non-probe claims restore it on rollback). */
  previousLaunch: TerminalBreakerLaunch | null;
  /** The record's takeover epoch after this claim; sent on `agent:start` (RFC 071 outbox). */
  takeoverEpoch: number;
}

export type TerminalClaimResult =
  | { ok: true; state: TerminalFailureBreakerState; token: TerminalClaimToken }
  | { ok: false; reason: TerminalWakeRefusal };

function pushUnexited(state: TerminalFailureBreakerState, entry: TerminalUnexitedEntry): void {
  state.unexited.push(entry);
  while (state.unexited.length > TERMINAL_FAILURE_UNEXITED_MAX) {
    state.unexited.shift();
    state.unexitedOverflow = true;
  }
}

function pushAcknowledged(state: TerminalFailureBreakerState, entries: TerminalAcknowledgedUnexited[]): void {
  state.acknowledgedUnexited.push(...entries);
  while (state.acknowledgedUnexited.length > TERMINAL_FAILURE_ACKNOWLEDGED_UNEXITED_MAX) state.acknowledgedUnexited.shift();
}

/** E3 bookkeeping shared by every lift: closed, generation+1, launch cleared, counts reset (RFC 5). */
function liftCommon(state: TerminalFailureBreakerState, cause: string, nowMs: number): void {
  resetCounts(state);
  state.generation += 1;
  state.currentLaunch = null;
  state.lastProbe = null;
  state.blockedUntilMs = null;
  state.openedAtMs = null;
  withTransition(state, "closed", cause, nowMs);
}

/**
 * The atomic claim. Automatic: closed → replace the current launch (non-probe);
 * open past its backoff → half_open with a probe under a lease (the previous
 * launch becomes `lastProbe`); anything else fails with no write. A human
 * start (E3) proceeds whatever the record holds: it lifts, takes over every
 * `unexited` entry into `acknowledgedUnexited`, and clears overflow and
 * `needsManual` (RFC 4.3 rule 6). Both write the pending `unexited` entry for
 * this launch in the same write, before dispatch (rule 1), when the machine
 * can later report its exit.
 */
export function claimTerminalStart(current: TerminalFailureBreakerState, input: TerminalClaimInput): TerminalClaimResult {
  const { state: normalized } = normalizeTerminalBreaker(current, input.nowMs);
  const state = cloneTerminalFailureBreakerState(normalized);
  const previousLaunch = normalized.currentLaunch;
  let isProbe = false;
  if (input.control === "human_start") {
    pushAcknowledged(state, state.unexited.map((entry) => ({
      processInstanceId: entry.processInstanceId,
      daemonInstanceId: entry.daemonInstanceId,
      spawnLaunchId: entry.spawnLaunchId,
      ackedAtMs: input.nowMs,
      reason: "human_start",
    })));
    state.unexited = [];
    state.unexitedOverflow = false;
    state.needsManual = null;
    // The explicit takeover: daemon markers of an older epoch are settled by it.
    state.takeoverEpoch += 1;
    liftCommon(state, "human_start", input.nowMs);
  } else {
    const refused = automaticRefusal(normalized, input.nowMs, input.capability);
    if (refused) return { ok: false, reason: refused.refusal };
    if (normalized.state === "open") {
      isProbe = true;
      state.lastProbe = previousLaunch;
      withTransition(state, "half_open", "probe_claimed", input.nowMs);
    }
  }
  state.currentLaunch = {
    launchId: input.launchId,
    generation: state.generation,
    resumedSessionId: input.resumedSessionId,
    isProbe,
    claimedAtMs: input.nowMs,
    leaseExpiresAtMs: isProbe ? input.nowMs + TERMINAL_FAILURE_PROBE_LEASE_MS : null,
    lastAppliedSeq: null,
    terminal: null,
    takeover: false,
    catchupBatchId: null,
  };
  if (input.capability && input.daemonInstanceId !== null) {
    pushUnexited(state, {
      spawnLaunchId: input.launchId,
      daemonInstanceId: input.daemonInstanceId,
      processInstanceId: null,
      launchIds: [input.launchId],
      dispatchedAtMs: input.nowMs,
      protected: false,
    });
  }
  markProtectedIfEngaged(state);
  return {
    ok: true,
    state,
    token: {
      launchId: input.launchId,
      generation: state.generation,
      claimedAtMs: input.nowMs,
      isProbe,
      control: input.control,
      previousLaunch: previousLaunch && input.control === "automatic" && !isProbe ? previousLaunch : null,
      takeoverEpoch: state.takeoverEpoch,
    },
  };
}

export type TerminalRollbackOutcome = "restored" | "rollback_skipped_not_owner";

/**
 * Undo a claim whose dispatch failed, only while the claim is still the
 * owner (launchId, generation and claimedAtMs equal the token). A probe goes
 * to `open`, step+, generation+1. A non-probe automatic claim restores the
 * launch it replaced; a human claim keeps its lift and clears the launch.
 *
 * The pending `unexited` entry is removed only when `dispatchLeftReplica` is
 * false (the frame provably never reached a daemon). An ack timeout is not
 * "not started" (RFC X-6(b)): then the entry stays.
 */
export function rollbackTerminalClaim(
  current: TerminalFailureBreakerState,
  token: TerminalClaimToken,
  input: { nowMs: number; dispatchLeftReplica: boolean },
): { state: TerminalFailureBreakerState; outcome: TerminalRollbackOutcome } {
  const launch = current.currentLaunch;
  const owns = launch !== null
    && launch.launchId === token.launchId
    && launch.generation === token.generation
    && launch.claimedAtMs === token.claimedAtMs
    && current.generation === token.generation;
  if (!owns) return { state: current, outcome: "rollback_skipped_not_owner" };
  const state = cloneTerminalFailureBreakerState(current);
  if (token.isProbe) {
    state.backoffStep = nextBackoffStep(state.backoffStep);
    state.blockedUntilMs = input.nowMs + backoffMs(state.backoffStep);
    state.generation += 1;
    state.currentLaunch = null;
    withTransition(state, "open", "probe_dispatch_failed", input.nowMs);
  } else {
    state.currentLaunch = token.previousLaunch ? structuredClone(token.previousLaunch) : null;
  }
  if (!input.dispatchLeftReplica) {
    state.unexited = state.unexited.filter((entry) => !(entry.spawnLaunchId === token.launchId && entry.processInstanceId === null));
  }
  finishTransition(state);
  return { state, outcome: "restored" };
}

/**
 * E3 other than a human start (RFC 5): reset (restart / session / full) or a
 * real runtime-config change. Closed, generation+1, counts reset, launch
 * cleared; the obligation and diagnostics are kept, and so are `unexited`
 * and `needsManual`: nothing was taken over (RFC 4.3 rule 6).
 */
export function applyTerminalLift(
  current: TerminalFailureBreakerState,
  input: { cause: "human_reset" | "runtime_config_changed"; nowMs: number },
): TerminalFailureBreakerState {
  const state = cloneTerminalFailureBreakerState(current);
  liftCommon(state, input.cause, input.nowMs);
  // Never un-protects: an entry marked while engaged stays marked after the reset.
  finishTransition(state);
  return state;
}

/** Manual Stop is not E3: half_open → open, step unchanged, probe cleared; otherwise no change. */
export function applyTerminalManualStop(
  current: TerminalFailureBreakerState,
  input: { nowMs: number },
): { state: TerminalFailureBreakerState; write: boolean } {
  const { state: normalized, expired } = normalizeTerminalBreakerLease(current, input.nowMs);
  if (normalized.state !== "half_open") return { state: normalized, write: expired };
  const state = cloneTerminalFailureBreakerState(normalized);
  state.currentLaunch = null;
  withTransition(state, "open", "manual_stop", input.nowMs);
  finishTransition(state);
  return { state, write: true };
}

// --- Process identity and exit (RFC 071 §4.3 rules 1-8) ---

function sameIdentity(
  a: { daemonInstanceId: string; processInstanceId: string | null },
  daemonInstanceId: string,
  processInstanceId: string,
): boolean {
  return a.processInstanceId === processInstanceId && a.daemonInstanceId === daemonInstanceId;
}

function isRecentExit(state: TerminalFailureBreakerState, daemonInstanceId: string, processInstanceId: string): boolean {
  return state.recentExits.some((exit) => sameIdentity(exit, daemonInstanceId, processInstanceId));
}

function pendingIndex(state: TerminalFailureBreakerState, spawnLaunchId: string, daemonInstanceId: string): number {
  return state.unexited.findIndex((entry) =>
    entry.spawnLaunchId === spawnLaunchId && entry.daemonInstanceId === daemonInstanceId && entry.processInstanceId === null);
}

export type TerminalIdentityOutcome =
  | "filled"
  | "merged"
  | "settled_recent_exit"
  | "unmatched"
  | "not_rebind"
  /** A `respawn` (or an otherwise unmatched spawn) created a new `unexited` entry. */
  | "respawn_tracked"
  | "untracked_tracked";

/**
 * `agent:start:ack`. Only `running`/`rebound` carries a `processInstanceId`
 * (the rebound process exists already). An identity already in `unexited`
 * absorbs this launch and the pending entry is dropped; otherwise the pending
 * entry takes the identity; an identity in `recentExits` settles at once.
 * Marks `takeover` on the current launch.
 */
export function applyTerminalStartAck(
  current: TerminalFailureBreakerState,
  ack: { launchId: string; daemonInstanceId: string; queueState: string; processInstanceId: string | null },
): { state: TerminalFailureBreakerState; outcome: TerminalIdentityOutcome; write: boolean } {
  const rebind = (ack.queueState === "running" || ack.queueState === "rebound") && ack.processInstanceId !== null;
  if (!rebind) return { state: current, outcome: "not_rebind", write: false };
  const processInstanceId = ack.processInstanceId!;
  const state = cloneTerminalFailureBreakerState(current);
  if (state.currentLaunch?.launchId === ack.launchId) state.currentLaunch.takeover = true;
  const pending = pendingIndex(state, ack.launchId, ack.daemonInstanceId);
  let outcome: TerminalIdentityOutcome;
  if (isRecentExit(state, ack.daemonInstanceId, processInstanceId)) {
    if (pending >= 0) state.unexited.splice(pending, 1);
    outcome = "settled_recent_exit";
  } else {
    const existing = state.unexited.find((entry) => sameIdentity(entry, ack.daemonInstanceId, processInstanceId));
    if (existing) {
      if (!existing.launchIds.includes(ack.launchId)) {
        existing.launchIds.push(ack.launchId);
        while (existing.launchIds.length > TERMINAL_FAILURE_LAUNCH_IDS_PER_PROCESS_MAX) existing.launchIds.shift();
      }
      if (pending >= 0) state.unexited.splice(pending, 1);
      outcome = "merged";
    } else if (pending >= 0) {
      state.unexited[pending]!.processInstanceId = processInstanceId;
      outcome = "filled";
    } else {
      outcome = "unmatched";
    }
  }
  // An identity arriving may resolve the pending entry a needs-manual block was waiting on.
  finishTransition(state);
  return { state, outcome, write: true };
}

export interface TerminalProcessSpawnedFrame {
  /** The launch the process was spawned for. */
  launchId: string;
  daemonInstanceId: string;
  processInstanceId: string;
  /**
   * RFC 071 part 2: other accepted launches the daemon folded into this spawn.
   * Each is bound to this process; none gets a process of its own.
   */
  supersededLaunchIds?: string[];
  /**
   * RFC 071 part 2: no accepted server start was waiting; the daemon started
   * this runtime on its own under an already settled `launchId`.
   */
  respawn?: boolean;
  /** Server time the frame is applied; dates an entry this frame creates. */
  atMs?: number;
}

function appendLaunchIds(entry: TerminalUnexitedEntry, launchIds: string[]): void {
  for (const launchId of launchIds) {
    if (!entry.launchIds.includes(launchId)) entry.launchIds.push(launchId);
  }
  while (entry.launchIds.length > TERMINAL_FAILURE_LAUNCH_IDS_PER_PROCESS_MAX) entry.launchIds.shift();
}

/**
 * `agent:process_spawned` (RFC 4.3 rule 2, with the part 2 fields):
 *  - an identity already in `recentExits` settles every pending entry of the
 *    spawn's launches (RFC X-6(c));
 *  - otherwise the process takes over the pending entries of its own launch
 *    AND of every superseded launch: one entry keeps the identity and lists
 *    all of them, the other pending entries leave (they never get a process
 *    of their own); an entry already holding the identity absorbs them all;
 *  - a pending entry already taken over by a human start (in
 *    `acknowledgedUnexited`) only gets its identity, for a late exit;
 *  - nothing matched (a `respawn`, or a start the server dispatched without
 *    a pending entry): a process exists that the record does not track, so
 *    it gets a new entry. An untracked live process would let an automatic
 *    probe start a second one; its exit frame removes the entry.
 * A respawn under the current launch after that launch's process exited
 * makes the launch live again (`terminal` back to null), but only in
 * `closed`, at the current generation, and never after an E1: the new
 * process's evidence then counts, and it is the confirmed live process.
 */
export function applyTerminalProcessSpawned(
  current: TerminalFailureBreakerState,
  frame: TerminalProcessSpawnedFrame,
): { state: TerminalFailureBreakerState; outcome: TerminalIdentityOutcome; write: boolean } {
  const launches = [frame.launchId, ...(frame.supersededLaunchIds ?? []).filter((id) => id !== frame.launchId)];
  const pendingOf = (state: TerminalFailureBreakerState) => launches
    .map((launchId) => pendingIndex(state, launchId, frame.daemonInstanceId))
    .filter((index) => index >= 0);
  const state = cloneTerminalFailureBreakerState(current);
  const pendings = pendingOf(state);
  const removePendings = (keep: number | null) => {
    const drop = new Set(pendings.filter((index) => index !== keep));
    state.unexited = state.unexited.filter((_, index) => !drop.has(index));
  };
  let outcome: TerminalIdentityOutcome;
  if (isRecentExit(state, frame.daemonInstanceId, frame.processInstanceId)) {
    if (pendings.length === 0) return { state: current, outcome: "settled_recent_exit", write: false };
    removePendings(null);
    outcome = "settled_recent_exit";
  } else {
    const existing = state.unexited.findIndex((entry) => sameIdentity(entry, frame.daemonInstanceId, frame.processInstanceId));
    if (existing >= 0) {
      appendLaunchIds(state.unexited[existing]!, launches);
      removePendings(null);
      outcome = "merged";
    } else if (pendings.length > 0) {
      // Prefer the spawn's own launch; else the oldest superseded pending entry.
      const own = pendingIndex(state, frame.launchId, frame.daemonInstanceId);
      const keep = own >= 0 ? own : pendings[0]!;
      const target = state.unexited[keep]!;
      target.processInstanceId = frame.processInstanceId;
      appendLaunchIds(target, launches);
      removePendings(keep);
      outcome = "filled";
    } else {
      const acknowledged = state.acknowledgedUnexited.findIndex((entry) =>
        launches.includes(entry.spawnLaunchId) && entry.daemonInstanceId === frame.daemonInstanceId && entry.processInstanceId === null);
      if (acknowledged >= 0) {
        state.acknowledgedUnexited[acknowledged]!.processInstanceId = frame.processInstanceId;
        return { state, outcome: "filled", write: true };
      }
      pushUnexited(state, {
        spawnLaunchId: frame.launchId,
        daemonInstanceId: frame.daemonInstanceId,
        processInstanceId: frame.processInstanceId,
        launchIds: [...launches].slice(-TERMINAL_FAILURE_LAUNCH_IDS_PER_PROCESS_MAX),
        dispatchedAtMs: frame.atMs ?? 0,
        protected: false,
      });
      outcome = frame.respawn === true ? "respawn_tracked" : "untracked_tracked";
    }
    // Superseded launches a human start already took over keep the identity too, for a late exit.
    for (const entry of state.acknowledgedUnexited) {
      if (entry.processInstanceId === null && entry.daemonInstanceId === frame.daemonInstanceId && launches.includes(entry.spawnLaunchId)) {
        entry.processInstanceId = frame.processInstanceId;
      }
    }
    const launch = state.currentLaunch;
    if (
      frame.respawn === true
      && state.state === "closed"
      && launch !== null
      && launch.launchId === frame.launchId
      && launch.generation === state.generation
      && launch.terminal === "process_exit"
    ) {
      launch.terminal = null;
    }
  }
  finishTransition(state);
  return { state, outcome, write: true };
}

export type TerminalExitOutcome = "removed" | "acknowledged_removed" | "exit_unmatched";

export interface TerminalProcessExitFrame {
  daemonInstanceId: string;
  processInstanceId: string;
  /**
   * The launch the process was spawned for. Null for a process the daemon
   * started on its own (no server launch) that a server start was later
   * rebound onto: it is settled by its identity only (RFC 071 part 2).
   */
  spawnLaunchId: string | null;
  /** The last launch it carried (diagnostics; also binds the exit to the current launch/probe). */
  launchId: string;
  atMs: number;
}

/**
 * `agent:process_exited`, in either order relative to the identity (RFC 4.3
 * rule 3): match by identity, else the pending entry with the same
 * `spawnLaunchId` and daemon instance; an `acknowledgedUnexited` match is
 * removed from there only (rule 7); the identity always goes to `recentExits`.
 * Exit is a fact, not an outcome: it never counts and never recovers. It only
 * marks the current launch / last probe `terminal = process_exit`, and a probe
 * that exits before its E2 reopens the breaker (§8 table).
 */
export function applyTerminalProcessExited(
  current: TerminalFailureBreakerState,
  frame: TerminalProcessExitFrame,
): { state: TerminalFailureBreakerState; outcome: TerminalExitOutcome; probeEnded: boolean } {
  const state = cloneTerminalFailureBreakerState(current);
  let outcome: TerminalExitOutcome = "exit_unmatched";
  let carried: string[] = frame.spawnLaunchId === null ? [frame.launchId] : [frame.launchId, frame.spawnLaunchId];
  let index = state.unexited.findIndex((entry) => sameIdentity(entry, frame.daemonInstanceId, frame.processInstanceId));
  // The rule 3 fallback needs the spawn launch; a null one is matched by identity only.
  if (index < 0 && frame.spawnLaunchId !== null) index = pendingIndex(state, frame.spawnLaunchId, frame.daemonInstanceId);
  if (index >= 0) {
    carried = carried.concat(state.unexited[index]!.launchIds);
    state.unexited.splice(index, 1);
    outcome = "removed";
  } else {
    let ack = state.acknowledgedUnexited.findIndex((entry) => sameIdentity(entry, frame.daemonInstanceId, frame.processInstanceId));
    if (ack < 0 && frame.spawnLaunchId !== null) {
      ack = state.acknowledgedUnexited.findIndex((entry) =>
        entry.processInstanceId === null && entry.spawnLaunchId === frame.spawnLaunchId && entry.daemonInstanceId === frame.daemonInstanceId);
    }
    if (ack >= 0) {
      state.acknowledgedUnexited.splice(ack, 1);
      outcome = "acknowledged_removed";
    }
  }

  // recentExits: dedupe, age bound, count bound.
  state.recentExits = state.recentExits.filter((exit) =>
    !sameIdentity(exit, frame.daemonInstanceId, frame.processInstanceId)
    && frame.atMs - exit.atMs <= TERMINAL_FAILURE_RECENT_EXITS_MAX_AGE_MS);
  state.recentExits.push({
    daemonInstanceId: frame.daemonInstanceId,
    processInstanceId: frame.processInstanceId,
    spawnLaunchId: frame.spawnLaunchId,
    atMs: frame.atMs,
  });
  while (state.recentExits.length > TERMINAL_FAILURE_RECENT_EXITS_MAX) state.recentExits.shift();

  // Terminal outcome of the launch this process carried (only for a launch still bound).
  let probeEnded = false;
  if (outcome === "removed") {
    const launch = state.currentLaunch;
    if (launch && launch.terminal === null && launch.generation === state.generation && carried.includes(launch.launchId)) {
      launch.terminal = "process_exit";
      if (state.state === "half_open" && launch.isProbe) {
        state.backoffStep = nextBackoffStep(state.backoffStep);
        state.blockedUntilMs = frame.atMs + backoffMs(state.backoffStep);
        launch.leaseExpiresAtMs = null;
        withTransition(state, "open", "probe_process_exit", frame.atMs);
        probeEnded = true;
      }
    } else if (state.state === "open" && state.lastProbe && state.lastProbe.terminal === null && carried.includes(state.lastProbe.launchId)) {
      state.lastProbe.terminal = "process_exit";
    }
  }
  finishTransition(state);
  return { state, outcome, probeEnded };
}

/**
 * The machine's `ready` from a daemon instance: entries from older instances
 * can no longer receive an exit frame (RFC 4.3 rule 4), narrowed by the
 * review of PR #8633 (item 4):
 *  - an older-instance entry that was ever `protected` stays and sets
 *    `needsManual = daemon_restarted_no_exit` (a protected agent's unknown old
 *    process still needs manual recovery);
 *  - a never-protected older-instance entry (the agent was only tracked, the
 *    breaker never engaged for it) moves to `acknowledgedUnexited` with
 *    reason `daemon_restarted_untracked`, and blocks nothing.
 * The decision reads the durable marker, never the current counters: E2 and
 * an E3 reset clear the counters but not the marker.
 */
export function applyTerminalDaemonReady(
  current: TerminalFailureBreakerState,
  input: { daemonInstanceId: string; nowMs: number },
): { state: TerminalFailureBreakerState; write: boolean } {
  const older = current.unexited.filter((entry) => entry.daemonInstanceId !== input.daemonInstanceId);
  if (older.length === 0) return { state: current, write: false };
  const state = cloneTerminalFailureBreakerState(current);
  markProtectedIfEngaged(state);
  const untracked = state.unexited.filter((entry) => entry.daemonInstanceId !== input.daemonInstanceId && !entry.protected);
  const protectedOld = state.unexited.filter((entry) => entry.daemonInstanceId !== input.daemonInstanceId && entry.protected);
  if (untracked.length > 0) {
    state.unexited = state.unexited.filter((entry) => !untracked.includes(entry));
    pushAcknowledged(state, untracked.map((entry) => ({
      processInstanceId: entry.processInstanceId,
      daemonInstanceId: entry.daemonInstanceId,
      spawnLaunchId: entry.spawnLaunchId,
      ackedAtMs: input.nowMs,
      reason: "daemon_restarted_untracked",
    })));
  }
  if (protectedOld.length > 0 && (state.needsManual === null || state.needsManual.reason === "unexited_process")) {
    state.needsManual = { reason: "daemon_restarted_no_exit", sinceMs: input.nowMs, causeEntries: protectedOld.map(unexitedKey) };
  }
  finishTransition(state);
  return { state, write: true };
}

/** The daemon stated the start was rejected before any spawn: the pending entry leaves the set (RFC 4.3 rule 2). */
export function applyTerminalStartRejectedBeforeSpawn(
  current: TerminalFailureBreakerState,
  input: { launchId: string; daemonInstanceId: string },
): { state: TerminalFailureBreakerState; write: boolean } {
  const index = pendingIndex(current, input.launchId, input.daemonInstanceId);
  if (index < 0) return { state: current, write: false };
  const state = cloneTerminalFailureBreakerState(current);
  state.unexited.splice(index, 1);
  finishTransition(state);
  return { state, write: true };
}

// --- Outbox frames (RFC 071 part 3: dedup watermark, one commit) ---

/**
 * Lost evidence (RFC 071 part 3): what the daemon produced cannot all be
 * applied, so the server takes over the protection the daemon's own refusal
 * gave until now. Automatic starts are refused `needs_manual` until a human
 * start; nothing else clears it. A weaker block that clears on its own
 * (`unexited_process`, `daemon_restarted_no_exit`) is replaced; one that
 * also needs a human start is kept. Returns whether it changed anything.
 */
function markEvidenceLost(state: TerminalFailureBreakerState, nowMs: number): boolean {
  const block = state.needsManual;
  if (block !== null && block.reason !== "unexited_process" && block.reason !== "daemon_restarted_no_exit") return false;
  state.needsManual = { reason: "outcome_evidence_lost", sinceMs: nowMs, causeEntries: [] };
  finishTransition(state);
  return true;
}

/**
 * An outbox frame the server applies, normalised from the wire. Every frame
 * with a usable identity `(daemonInstanceId, clientSeq)` becomes one of
 * these; `evidence_lost` stands for a frame the server cannot read (an
 * unknown `v` or shape), which is committed as lost evidence instead of
 * being held: a held frame would stall the agent's stop-and-wait queue
 * forever behind it.
 */
export type TerminalOutboxFrame =
  | { kind: "terminal_failure"; frame: TerminalFailureFrame }
  | { kind: "turn_completed"; frame: TurnCompletedFrame }
  | {
    kind: "process_spawned";
    daemonInstanceId: string;
    clientSeq: number;
    launchId: string;
    processInstanceId: string;
    supersededLaunchIds?: string[];
    respawn?: boolean;
  }
  | { kind: "process_exited"; daemonInstanceId: string; clientSeq: number; processInstanceId: string; spawnLaunchId: string | null; launchId: string }
  | { kind: "start_rebound"; daemonInstanceId: string; clientSeq: number; launchId: string; processInstanceId: string }
  | { kind: "start_not_spawned"; daemonInstanceId: string; clientSeq: number; launchId: string }
  | { kind: "evidence_lost"; daemonInstanceId: string; clientSeq: number; reason: string };

export function terminalOutboxFrameSeq(frame: TerminalOutboxFrame): TerminalFrameSeq {
  const source = frame.kind === "terminal_failure" || frame.kind === "turn_completed" ? frame.frame : frame;
  return { daemonInstanceId: source.daemonInstanceId, clientSeq: source.clientSeq };
}

export interface TerminalOutboxFrameInput {
  nowMs: number;
  /** E1 only: the agent's unread snapshot; `null` owes every unread row if the E1 opens the breaker. */
  unreadCeilings: Record<string, number> | null;
  /** E2 only: the agent's persisted sessionId. */
  persistedSessionId: string | null;
}

export interface TerminalOutboxApplied {
  state: TerminalFailureBreakerState;
  /** At or below the instance's watermark: nothing applied, nothing written. */
  duplicate: boolean;
  /** What the part-1 transition said (`applied`, an ignored reason, an identity/exit outcome); `duplicate` for a replay. */
  outcome: string;
  /** Whether the caller must write `state` before acking. */
  write: boolean;
}

/** The committed watermark of a daemon instance, or null. */
export function terminalOutboxWatermark(state: TerminalFailureBreakerState, daemonInstanceId: string): number | null {
  return Object.prototype.hasOwnProperty.call(state.outboxWatermarks, daemonInstanceId) ? state.outboxWatermarks[daemonInstanceId]! : null;
}

/** Advance (never lower, never drop) one instance's watermark on a state the caller owns. */
function advanceOutboxWatermark(state: TerminalFailureBreakerState, seq: TerminalFrameSeq): void {
  const previous = terminalOutboxWatermark(state, seq.daemonInstanceId);
  state.outboxWatermarks = { ...state.outboxWatermarks, [seq.daemonInstanceId]: Math.max(previous ?? seq.clientSeq, seq.clientSeq) };
}

/**
 * Apply one outbox frame and mark it committed, as ONE next state: the
 * transition's result and the advanced watermark are written by the same
 * compare-and-set. A frame at or below its instance's watermark is a replay
 * (the server committed it and the ack was lost): no transition runs and
 * nothing is written, so the caller acknowledges it again. A frame the
 * transition ignores (wrong launch, stale, unmatched) still advances the
 * watermark: it was judged, and the judgement is final.
 *
 * Frames are applied by their OWN `daemonInstanceId`, whichever instance the
 * connection now runs: a restarted daemon replays its earlier instance's
 * queue, and those frames (an exit above all) are real evidence.
 *
 * No double apply (review of #8824, option B): watermarks are never
 * forgotten, so an instance without one has never had a frame committed for
 * this agent, and its frame is a first delivery whichever connection it
 * arrives on. The one exception is a record whose watermarks were lost (it
 * could not be decoded): then the first frame of an instance without a
 * watermark is never applied. It is committed as lost evidence
 * (`needs_manual`, cleared only by a human start) together with a watermark
 * at its seq, and acked. Its later frames apply: the daemon's stop-and-wait
 * queue sends an entry only after every older one was acked, so a frame
 * above one still being resent was never committed.
 */
export function applyTerminalOutboxFrame(
  current: TerminalFailureBreakerState,
  frame: TerminalOutboxFrame,
  input: TerminalOutboxFrameInput,
): TerminalOutboxApplied {
  const seq = terminalOutboxFrameSeq(frame);
  const watermark = terminalOutboxWatermark(current, seq.daemonInstanceId);
  if (watermark !== null && seq.clientSeq <= watermark) {
    return { state: current, duplicate: true, outcome: "duplicate", write: false };
  }
  if (watermark === null && current.outboxWatermarksLost) {
    const state = cloneTerminalFailureBreakerState(current);
    markEvidenceLost(state, input.nowMs);
    advanceOutboxWatermark(state, seq);
    return { state, duplicate: false, outcome: "watermarks_lost", write: true };
  }
  let next: TerminalFailureBreakerState;
  let outcome: string;
  switch (frame.kind) {
    case "terminal_failure": {
      const applied = applyTerminalFailureFrame(current, frame.frame, { nowMs: input.nowMs, unreadCeilings: input.unreadCeilings });
      next = applied.state;
      outcome = applied.ignored ?? "applied";
      break;
    }
    case "turn_completed": {
      const applied = applyTurnCompletedFrame(current, frame.frame, { nowMs: input.nowMs, persistedSessionId: input.persistedSessionId });
      next = applied.state;
      outcome = applied.ignored ?? (frame.frame.catchupBatchId !== null && !applied.echoApplied ? "applied_echo_unmatched" : "applied");
      break;
    }
    case "process_spawned": {
      const applied = applyTerminalProcessSpawned(current, { ...frame, atMs: input.nowMs });
      next = applied.state;
      outcome = applied.outcome;
      break;
    }
    case "process_exited": {
      const applied = applyTerminalProcessExited(current, { ...frame, atMs: input.nowMs });
      next = applied.state;
      outcome = applied.outcome;
      break;
    }
    case "start_rebound": {
      // RFC 071 part 3 item 1: a `rebound` result is handled like a rebind ack.
      const applied = applyTerminalStartAck(current, {
        launchId: frame.launchId,
        daemonInstanceId: frame.daemonInstanceId,
        queueState: "rebound",
        processInstanceId: frame.processInstanceId,
      });
      next = applied.state;
      outcome = applied.outcome;
      break;
    }
    case "start_not_spawned": {
      const applied = applyTerminalStartRejectedBeforeSpawn(current, { launchId: frame.launchId, daemonInstanceId: frame.daemonInstanceId });
      next = applied.state;
      outcome = applied.write ? "pending_removed" : "unmatched";
      break;
    }
    case "evidence_lost": {
      next = cloneTerminalFailureBreakerState(current);
      markEvidenceLost(next, input.nowMs);
      outcome = `evidence_lost:${frame.reason}`;
      break;
    }
  }
  const state = cloneTerminalFailureBreakerState(next);
  advanceOutboxWatermark(state, seq);
  return { state, duplicate: false, outcome, write: true };
}

/**
 * A daemon outbox marker (RFC 071 outbox): `agent:runtime:outcome_gap` or
 * `agent:runtime:outcome_cross_instance_unknown`. It stands for frames the
 * daemon folded away under overflow; they will never arrive.
 *  - `critical`: the folded frames include anything but `turn_completed`
 *    (an E1, a spawn, an exit or a start result), or it is a cross-instance
 *    marker (the daemon blocks on every one of those). A lost E2 only delays
 *    a recovery, the conservative side, so a `turn_completed`-only gap is
 *    backlog and changes nothing.
 *  - `takeoverEpoch` below the record's: the folded frames belong to launches
 *    claimed before a human takeover that already settled them.
 * Otherwise the evidence is lost: `needs_manual` (`outcome_evidence_lost`).
 * A marker has no `(daemonInstanceId, clientSeq)`, so it has no watermark; a
 * replay is idempotent: the block is already set, or a human start has since
 * raised the epoch above the marker's.
 */
export interface TerminalOutcomeMarker {
  takeoverEpoch: number;
  critical: boolean;
}

export function applyTerminalOutcomeMarker(
  current: TerminalFailureBreakerState,
  marker: TerminalOutcomeMarker,
  input: { nowMs: number },
): { state: TerminalFailureBreakerState; outcome: "backlog_only" | "covered_by_takeover" | "evidence_lost" | "already_blocked"; write: boolean } {
  if (!marker.critical) return { state: current, outcome: "backlog_only", write: false };
  if (marker.takeoverEpoch < current.takeoverEpoch) return { state: current, outcome: "covered_by_takeover", write: false };
  const state = cloneTerminalFailureBreakerState(current);
  if (!markEvidenceLost(state, input.nowMs)) return { state: current, outcome: "already_blocked", write: false };
  return { state, outcome: "evidence_lost", write: true };
}

// --- Codec (RFC 071 §4.1, test R-1) ---

/** Sentinel: the stored record cannot be decoded. The reader maps it to `terminalBreakerStateFromUnreadable`. */
export const TERMINAL_BREAKER_UNREADABLE = Symbol("terminal_failure_breaker_unreadable");
export type TerminalBreakerUnreadable = typeof TERMINAL_BREAKER_UNREADABLE;

/** The Redis write form; `decodeTerminalFailureBreakerState` is its inverse. */
export function encodeTerminalFailureBreakerState(state: TerminalFailureBreakerState): string {
  return JSON.stringify(state);
}

class Unreadable extends Error {}

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Unreadable();
  return value as Obj;
}
function str(value: unknown): string {
  if (typeof value !== "string") throw new Unreadable();
  return value;
}
function strOrNull(value: unknown): string | null {
  return value === null ? null : str(value);
}
function num(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Unreadable();
  return value;
}
function int(value: unknown): number {
  const n = num(value);
  if (!Number.isInteger(n) || n < 0) throw new Unreadable();
  return n;
}
function numOrNull(value: unknown): number | null {
  return value === null ? null : num(value);
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Unreadable();
  return value;
}
function arr<T>(value: unknown, item: (v: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Unreadable();
  return value.map(item);
}
function orNull<T>(value: unknown, decode: (v: unknown) => T): T | null {
  return value === null ? null : decode(value);
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new Unreadable();
  return value as T;
}
function seqMap(value: unknown): Record<string, number> {
  const record = obj(value);
  return Object.fromEntries(Object.entries(record).map(([key, seq]) => [key, num(seq)]));
}

function decodeSeq(value: unknown): Required<TerminalFrameSeq> {
  const o = obj(value);
  return { daemonInstanceId: str(o.daemonInstanceId), clientSeq: num(o.clientSeq) };
}

function decodeLaunch(value: unknown): Required<TerminalBreakerLaunch> {
  const o = obj(value);
  return {
    launchId: str(o.launchId),
    generation: int(o.generation),
    resumedSessionId: strOrNull(o.resumedSessionId),
    isProbe: bool(o.isProbe),
    claimedAtMs: num(o.claimedAtMs),
    leaseExpiresAtMs: numOrNull(o.leaseExpiresAtMs),
    lastAppliedSeq: orNull(o.lastAppliedSeq, decodeSeq),
    terminal: o.terminal === null ? null : oneOf(o.terminal, ["e1", "process_exit"] as const),
    takeover: bool(o.takeover),
    catchupBatchId: strOrNull(o.catchupBatchId),
  };
}

function decodeFailure(value: unknown): Required<TerminalLastFailure> {
  const o = obj(value);
  return { kind: str(o.kind), fingerprint: str(o.fingerprint), launchId: str(o.launchId), sessionId: strOrNull(o.sessionId), atMs: num(o.atMs) };
}

function decodeBatch(value: unknown): Required<CatchupBatch> {
  const o = obj(value);
  return {
    batchId: str(o.batchId),
    launchId: str(o.launchId),
    builtAtMs: num(o.builtAtMs),
    coverage: arr(o.coverage, (v): Required<CatchupCoverage> => {
      const c = obj(v);
      return { conversationId: str(c.conversationId), fromSeqExclusive: num(c.fromSeqExclusive), coveredUpToSeq: num(c.coveredUpToSeq), truncated: bool(c.truncated) };
    }),
    messages: arr(o.messages, (v): Required<CatchupBatchMessage> => {
      const m = obj(v);
      return { id: str(m.id), conversationId: str(m.conversationId), seq: num(m.seq), inPrefix: bool(m.inPrefix) };
    }),
    candidateCapHit: bool(o.candidateCapHit),
    allUnreadCovered: bool(o.allUnreadCovered),
  };
}

function decodeObligation(value: unknown): Required<CatchupObligation> {
  const o = obj(value);
  return {
    owedCeilings: seqMap(o.owedCeilings),
    owedOverflow: bool(o.owedOverflow),
    obligationCursor: seqMap(o.obligationCursor),
    pendingBatch: orNull(o.pendingBatch, decodeBatch),
    engagedByFailure: bool(o.engagedByFailure),
  };
}

const ACKNOWLEDGED_REASONS = ["human_start", "daemon_restarted_untracked"] as const;

function decodeUnexitedKey(value: unknown): Required<TerminalUnexitedKey> {
  const o = obj(value);
  return { spawnLaunchId: str(o.spawnLaunchId), daemonInstanceId: str(o.daemonInstanceId) };
}

const NEEDS_MANUAL_REASONS = ["unexited_process", "daemon_restarted_no_exit", "unexited_overflow", "outcome_unobservable", "outcome_evidence_lost"] as const;

/**
 * Decode a stored record. Every field is checked; the output is `Required<>`
 * at every level, so a field added to the type without a decode step is a
 * type error here (the F1 pattern of `decodeWakeCrashLoopState`). Anything
 * that does not decode, in whole, returns the unreadable sentinel: this
 * breaker has no field-level repair (RFC 4.1 "unreadable record").
 */
export function decodeTerminalFailureBreakerState(raw: unknown): TerminalFailureBreakerState | TerminalBreakerUnreadable {
  if (typeof raw !== "string") return TERMINAL_BREAKER_UNREADABLE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return TERMINAL_BREAKER_UNREADABLE;
  }
  try {
    const o = obj(parsed);
    if (o.schema !== 1) throw new Unreadable();
    const state: Required<TerminalFailureBreakerState> = {
      schema: 1,
      state: oneOf(o.state, ["closed", "open", "half_open"] as const),
      generation: int(o.generation),
      currentLaunch: orNull(o.currentLaunch, decodeLaunch),
      lastProbe: orNull(o.lastProbe, decodeLaunch),
      needsManual: orNull(o.needsManual, (v): Required<TerminalNeedsManual> => {
        const n = obj(v);
        return { reason: oneOf(n.reason, NEEDS_MANUAL_REASONS), sinceMs: num(n.sinceMs), causeEntries: arr(n.causeEntries, decodeUnexitedKey) };
      }),
      unexited: arr(o.unexited, (v): Required<TerminalUnexitedEntry> => {
        const e = obj(v);
        return {
          spawnLaunchId: str(e.spawnLaunchId),
          daemonInstanceId: str(e.daemonInstanceId),
          processInstanceId: strOrNull(e.processInstanceId),
          launchIds: arr(e.launchIds, str),
          dispatchedAtMs: num(e.dispatchedAtMs),
          protected: bool(e.protected),
        };
      }),
      recentExits: arr(o.recentExits, (v): Required<TerminalRecentExit> => {
        const e = obj(v);
        return { daemonInstanceId: str(e.daemonInstanceId), processInstanceId: str(e.processInstanceId), spawnLaunchId: strOrNull(e.spawnLaunchId), atMs: num(e.atMs) };
      }),
      unexitedOverflow: bool(o.unexitedOverflow),
      acknowledgedUnexited: arr(o.acknowledgedUnexited, (v): Required<TerminalAcknowledgedUnexited> => {
        const e = obj(v);
        return {
          processInstanceId: strOrNull(e.processInstanceId),
          daemonInstanceId: str(e.daemonInstanceId),
          spawnLaunchId: str(e.spawnLaunchId),
          ackedAtMs: num(e.ackedAtMs),
          reason: oneOf(e.reason, ACKNOWLEDGED_REASONS),
        };
      }),
      sameFingerprint: orNull(o.sameFingerprint, (v): Required<TerminalSameFingerprint> => {
        const s = obj(v);
        return { fingerprint: str(s.fingerprint), count: int(s.count) };
      }),
      totalCount: int(o.totalCount),
      backoffStep: int(o.backoffStep),
      openedAtMs: numOrNull(o.openedAtMs),
      blockedUntilMs: numOrNull(o.blockedUntilMs),
      lastFailure: orNull(o.lastFailure, decodeFailure),
      catchupObligation: orNull(o.catchupObligation, decodeObligation),
      diagnostics: ((v): Required<TerminalBreakerDiagnostics> => {
        const d = obj(v);
        return { lastFailure: orNull(d.lastFailure, decodeFailure), lastClosedReason: strOrNull(d.lastClosedReason) };
      })(o.diagnostics),
      lastTransition: orNull(o.lastTransition, (v): Required<TerminalBreakerTransition> => {
        const t = obj(v);
        return { from: str(t.from), to: str(t.to), cause: str(t.cause), atMs: num(t.atMs) };
      }),
      // Strict like every other field. No record was written before these
      // fields existed (the breaker never wrote one while dormant), so nothing defaults.
      outboxWatermarks: Object.fromEntries(Object.entries(obj(o.outboxWatermarks)).map(([id, seq]) => [id, int(seq)])),
      outboxWatermarksLost: bool(o.outboxWatermarksLost),
      takeoverEpoch: int(o.takeoverEpoch),
    };
    return state;
  } catch (error) {
    if (error instanceof Unreadable) return TERMINAL_BREAKER_UNREADABLE;
    throw error;
  }
}

/** Candidate: TTL of a closed record with nothing protective in it (same rule as the #1119 key). */
export const TERMINAL_FAILURE_CLOSED_TTL_SEC = 7 * 86_400;

/**
 * TTL of the stored record: none while open/half_open (RFC 4.1); 7 days while
 * closed, EXCEPT when the closed record still carries something that must
 * not silently vanish on expiry (outbox watermarks, needs-manual, an unexited process, overflow,
 * or an open catch-up obligation). See the RFC-ambiguity note in the PR.
 */
export function terminalBreakerTtlSeconds(state: TerminalFailureBreakerState): number {
  if (state.state !== "closed") return 0;
  // Outbox watermarks are consumed-evidence identity: an expired record would
  // let a replay apply again (review of #8824). A record holding one persists.
  if (Object.keys(state.outboxWatermarks).length > 0 || state.outboxWatermarksLost) return 0;
  if (state.needsManual !== null || state.unexited.length > 0 || state.unexitedOverflow || state.catchupObligation !== null) return 0;
  return TERMINAL_FAILURE_CLOSED_TTL_SEC;
}
