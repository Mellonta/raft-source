/**
 * RFC 071 outbox — reliable, ordered, bounded delivery of the breaker's
 * evidence frames (`agent:runtime:outcome`, `agent:process_spawned`,
 * `agent:process_exited`, `agent:start:outcome`).
 *
 * Contract (review of PR #8679):
 *  - one file per agent; write-ahead (persist, then send); every write is
 *    temp file -> fsync -> rename -> fsync(dir), so a crash leaves either the
 *    old or the new complete state on disk. Every queue change (append, fold,
 *    in-flight, ack deletion, epoch) stands only once that write succeeded; a
 *    failed write rolls the in-memory queue back, sends nothing through the
 *    outbox and makes the agent unreliable;
 *  - entry identity: normal entries `(daemonInstanceId, clientSeq)`, markers
 *    their own `gapId`; identities survive a daemon restart;
 *  - stop-and-wait: at most one in-flight entry per agent, the oldest; the
 *    next is sent only after the exact ack; an ack deletes only the exactly
 *    matching entry; the in-flight entry is never folded;
 *  - retransmission: while connected, an un-acked in-flight entry is resent
 *    with the SAME identity after 5s, 10s, 20s, ... capped at 5 min (minus up
 *    to 20% jitter), without limit; a reconnect resends at once and resets
 *    the backoff; a late or duplicate ack matches at most once;
 *  - capacity per agent: 128 normal entries; per daemon instance at most 2
 *    gaps (1 sealed + 1 open), for at most 8 instances; at most 2 cross
 *    entries; hard total 146;
 *  - overflow: drop the oldest not-in-flight `turn_completed`; otherwise fold
 *    the oldest not-in-flight critical entry of the CURRENT takeover epoch
 *    into its instance's open gap (past 8 instances: into the open cross
 *    entry). Old-epoch entries are never folded, and markers never mix epochs;
 *  - admission: a start is admitted only if the current epoch keeps a reserve
 *    (room for one launch's critical frames + one open gap + one open cross);
 *    otherwise the start is refused `terminal_failure_outcome_storage_blocked`;
 *  - unreliable: a failed write/fsync, a corrupt file, or a fail-closed drop
 *    of known evidence marks the agent unreliable (local refusal of automatic
 *    starts on an acking server, best-effort `outcome_unreliable`, listed on
 *    ready). It is durable:
 *    a fsynced marker `<agent>@unreliable.json` (since, cause,
 *    daemonInstanceId); a corrupt file is renamed aside, never deleted, and
 *    counts as unreliable until resolved. Any load that finds a marker or an
 *    unresolved corrupt file is unreliable. The only way out is an admitted
 *    human start: the daemon durably writes `<agent>@resolution.json`, then
 *    removes the marker and archives the corrupt files. If the marker cannot
 *    be written the agent stays unreliable in memory (and it is retried); if
 *    the resolution cannot be written the human start is refused
 *    `storage_blocked` and the agent stays unreliable;
 *  - open launches: `<agent>@open-launches.json` durably lists every admitted
 *    start request still waiting for its result and every runtime process
 *    that may be running. A request is recorded before the start is admitted,
 *    a process before it is spawned or reused (a failed write refuses the
 *    start / does not spawn). A request leaves the record once its result
 *    (`process_spawned` naming it, `rebound`, `not_spawned`) is durably
 *    stored in the queue; a process only once its `process_exited` is, or
 *    once its start failed before it was reported spawned (no runtime runs
 *    and no process frame will ever name it: `processNotStarted`). Durably
 *    stored means stored and retryable; whether the server received it is
 *    decided only by the ack sent after the server commits it. Nothing is
 *    removed while the agent's unreliable state is not yet durable (the
 *    marker first). On load, any entry left by an earlier daemon instance
 *    means an outcome is unknown: the agent is unreliable until a human start
 *    durably resolves it. Cost: after a hard crash (kill -9, power loss)
 *    while an agent was running, that agent needs one human start. A process
 *    started without a server launch (internal restart) is recorded too,
 *    keyed by its `processInstanceId`. If a server start was later rebound
 *    onto it, its exit is a `process_exited` with `spawnLaunchId: null` (its
 *    birth had no launch; the last launch is `launchId`) that closes it by
 *    process identity like any other; otherwise it has no process frames and
 *    its exit is recorded durably in this file before its entry is removed;
 *  - automatic starts: ONE rule (`startRefusal`) decides every automatic
 *    start, a server start without `humanStart` and every start the daemon
 *    makes on its own (crash respawn, wake / message cold start, deferred
 *    spawn, rebind): refused while the agent is unreliable, or while it has
 *    an un-acked marker of LOST CRITICAL evidence (a gap counting any kind
 *    but `turn_completed`, or any cross-instance marker) that no persisted
 *    human takeover covers. A gap of `turn_completed` only is backlog: it
 *    blocks only while the server acks (as the reserve does). The rule
 *    applies only where its way out exists: a confirmed-old server never
 *    sends a human start, so there it refuses nothing (refusing would strand
 *    the agent with nothing its owner can do); the unreliable state and the
 *    markers are kept and apply again once an acking server is attached. A marker is covered only when
 *    an admitted human start durably recorded a takeover epoch
 *    (`humanTakeoverEpoch` in the queue file) newer than the marker's epoch;
 *    a larger epoch merely seen on a start (automatic, or a human start that
 *    was not admitted) exempts nothing. Markers are never deleted to pass the
 *    rule: only their ack removes them;
 *  - human recovery: an admitted human start (its resolution and takeover
 *    durably written) yields a `RecoveryGrant` bound to that start's launch.
 *    The grant is passed explicitly to the spawn / rebind gate, which spends
 *    it on first use (pass or refuse); a replaced, spent or other-launch
 *    grant counts for nothing and the start is decided as automatic. The
 *    grant covers only the evidence known at admission: a new unreliable
 *    cause or a new (or grown) blocking marker between admission and the gate
 *    refuses the start all the same. Every later start (crash respawn, cold
 *    start, ...) is automatic again;
 *  - server capability: per CONNECTION, `unknown` until this connection's
 *    `machine:context` confirms `acks` or `old`, and `unknown` again after a
 *    disconnect or restart. The last confirmed value is persisted
 *    (`@server-capability.json`) for diagnostics only; it never stands in
 *    for this connection's confirmation. A start that would create a process
 *    waits (`waitForCapability`) until the capability is confirmed; the
 *    wait is cancellable (a stop of that agent, or the daemon stopping) and
 *    is never released by pretending the capability is known.
 *
 *    Support boundary. A server that never sends `machine:context` (older
 *    than #6460, 2026-08-13) holds every start that would create a process;
 *    a stop still cancels a held start. On a confirmed-old server, results
 *    produced while the capability is unknown (between a disconnect or
 *    restart and the next `machine:context`) are kept and never acked, so
 *    each reconnect window in which a running process produces a result
 *    adds those frames. A frame that finds the queue (128) full there is
 *    lost: the agent becomes unreliable, which refuses nothing on the old
 *    server (see the automatic-start rule);
 *  - process mode, fixed in the open-launch record when a process is
 *    launched or rebound: `reliable` if this connection had confirmed acks,
 *    else `compat` (a rebind under acks upgrades it; nothing downgrades it);
 *  - protocol engagement (`protocolEngaged` in the queue file): set when a
 *    frame is durably queued. On a CONFIRMED-old connection a frame is
 *    produced only while a reliable-mode process of the agent is open (its
 *    E1 / exit are always queued); a compat process's results are not
 *    produced there (frames exist only for a server that acks them; the
 *    open-launch record still closes, and storage failures still mark the
 *    agent unreliable). While the capability is unknown or acks, frames are
 *    queued as always. What is queued is never deleted: on an old server
 *    sending pauses, nothing is folded or dropped to make room, and a frame
 *    that finds no room fails closed (unreliable) instead.
 *    Engagement ends (durably) only on a confirmed-old connection with an
 *    empty queue (no entries, no markers) and no open reliable process.
 *    Frames produced while the capability is unknown are queued and kept;
 *  - old servers: a confirmed-old server gets no outbox frames and no
 *    `outcome_unreliable` notice, and the automatic-start rule refuses
 *    nothing there. Only a failed open-record write refuses the start /
 *    spawn / rebind, whatever server is attached.
 *
 * Not in this module: the server half (acks, watermarks) is RFC 071 part 3.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { AgentRuntimeOutcomeGapCounts, MachineToServerMessage } from "@botiverse/raft-shared";

/** Directory name under the agents data dir (excluded from the workspace scan). */
export const RUNTIME_OUTCOME_OUTBOX_DIR_NAME = ".runtime-outcome-outbox";
export const OUTBOX_NORMAL_CAP = 128;
export const OUTBOX_GAP_INSTANCES_MAX = 8;
export const OUTBOX_GAPS_PER_INSTANCE_MAX = 2;
export const OUTBOX_CROSS_MAX = 2;
export const OUTBOX_HARD_TOTAL = OUTBOX_NORMAL_CAP + OUTBOX_GAP_INSTANCES_MAX * OUTBOX_GAPS_PER_INSTANCE_MAX + OUTBOX_CROSS_MAX;
/** Critical frames one admitted launch can produce: start outcome, spawned, E1, exited. */
export const OUTBOX_LAUNCH_CRITICAL_RESERVE = 4;
/** Online retransmission of the in-flight entry: first timeout, cap, and the jitter fraction (it only shortens a delay). */
export const OUTBOX_RETRANSMIT_BASE_MS = 5_000;
export const OUTBOX_RETRANSMIT_MAX_MS = 300_000;
export const OUTBOX_RETRANSMIT_JITTER = 0.2;

/** Delay before resend number `attempt + 1`: base * 2^attempt, capped, minus up to `JITTER` of it. */
export function retransmitDelayMs(attempt: number, random: () => number = Math.random): number {
  const raw = Math.min(OUTBOX_RETRANSMIT_MAX_MS, OUTBOX_RETRANSMIT_BASE_MS * 2 ** Math.min(attempt, 32));
  return Math.round(raw * (1 - OUTBOX_RETRANSMIT_JITTER * random()));
}

export type OutboxFrame = Extract<
  MachineToServerMessage,
  { type: "agent:runtime:outcome" | "agent:process_spawned" | "agent:process_exited" | "agent:start:outcome" }
>;
export const OUTBOX_FRAME_TYPES: ReadonlySet<string> = new Set([
  "agent:runtime:outcome",
  "agent:process_spawned",
  "agent:process_exited",
  "agent:start:outcome",
]);
export function isOutboxFrame(msg: MachineToServerMessage): msg is OutboxFrame {
  return OUTBOX_FRAME_TYPES.has(msg.type);
}

type CountKey = keyof AgentRuntimeOutcomeGapCounts;
type EntryKind = CountKey;

export interface NormalEntry {
  t: "normal";
  kind: EntryKind;
  daemonInstanceId: string;
  clientSeq: number;
  takeoverEpoch: number;
  frame: OutboxFrame;
}
export interface GapEntry {
  t: "gap";
  gapId: string;
  daemonInstanceId: string;
  takeoverEpoch: number;
  fromSeq: number;
  toSeq: number;
  counts: AgentRuntimeOutcomeGapCounts;
  sealed: boolean;
}
export interface CrossEntry {
  t: "cross";
  gapId: string;
  instances: string[];
  takeoverEpoch: number;
  counts: AgentRuntimeOutcomeGapCounts;
  sealed: boolean;
}
export type OutboxEntry = NormalEntry | GapEntry | CrossEntry;

export interface AgentOutboxState {
  v: 1;
  agentId: string;
  takeoverEpoch: number;
  /** A frame of this agent was durably queued; see the module comment (absent: false). */
  protocolEngaged?: boolean;
  /**
   * The newest takeover epoch an ADMITTED human start durably recorded.
   * Markers of an older epoch no longer block automatic starts (the person
   * took over knowing them); absent: none recorded, every marker blocks.
   */
  humanTakeoverEpoch?: number;
  /** Oldest first. When `inFlight`, `entries[0]` was sent and awaits its ack. */
  entries: OutboxEntry[];
  inFlight: boolean;
}

export function freshOutboxState(agentId: string): AgentOutboxState {
  return { v: 1, agentId, takeoverEpoch: 0, entries: [], inFlight: false };
}

function zeroCounts(): AgentRuntimeOutcomeGapCounts {
  return { e1: 0, turnCompleted: 0, spawned: 0, exited: 0, startOutcome: 0 };
}

function addCounts(into: AgentRuntimeOutcomeGapCounts, from: AgentRuntimeOutcomeGapCounts): void {
  for (const key of Object.keys(into) as CountKey[]) into[key] += from[key];
}

export function outboxEntryKind(frame: OutboxFrame): EntryKind {
  switch (frame.type) {
    case "agent:runtime:outcome":
      return frame.outcome.kind === "terminal_failure" ? "e1" : "turnCompleted";
    case "agent:process_spawned":
      return "spawned";
    case "agent:process_exited":
      return "exited";
    case "agent:start:outcome":
      return "startOutcome";
  }
}

function isNormal(entry: OutboxEntry): entry is NormalEntry {
  return entry.t === "normal";
}

function isInFlightIndex(state: AgentOutboxState, index: number): boolean {
  return state.inFlight && index === 0;
}

// --- Pure capacity logic -------------------------------------------------

function normalCount(state: AgentOutboxState): number {
  return state.entries.filter(isNormal).length;
}

function gapsOf(state: AgentOutboxState, instance: string): GapEntry[] {
  return state.entries.filter((entry): entry is GapEntry => entry.t === "gap" && entry.daemonInstanceId === instance);
}

function instancesWithGaps(state: AgentOutboxState): string[] {
  const seen: string[] = [];
  for (const entry of state.entries) {
    if (entry.t === "gap" && !seen.includes(entry.daemonInstanceId)) seen.push(entry.daemonInstanceId);
  }
  return seen;
}

function crossEntries(state: AgentOutboxState): CrossEntry[] {
  return state.entries.filter((entry): entry is CrossEntry => entry.t === "cross");
}

function openGap(state: AgentOutboxState, instance: string): GapEntry | undefined {
  return gapsOf(state, instance).find((gap) => !gap.sealed && gap.takeoverEpoch === state.takeoverEpoch);
}

function openCross(state: AgentOutboxState): CrossEntry | undefined {
  return crossEntries(state).find((cross) => !cross.sealed && cross.takeoverEpoch === state.takeoverEpoch);
}

function canCreateCross(state: AgentOutboxState): boolean {
  return crossEntries(state).length < OUTBOX_CROSS_MAX;
}

/** The oldest instance (other than `except`) whose gaps are all open, current-epoch and so mergeable into the cross entry. */
function mergeableInstance(state: AgentOutboxState, except: string): string | null {
  for (const instance of instancesWithGaps(state)) {
    if (instance === except) continue;
    const gaps = gapsOf(state, instance);
    if (gaps.every((gap) => !gap.sealed && gap.takeoverEpoch === state.takeoverEpoch)) return instance;
  }
  return null;
}

/** Can `instance` hold an open gap of the current epoch (existing, creatable, or creatable after merging an older instance into the cross entry)? */
function gapSlotAvailable(state: AgentOutboxState, instance: string): boolean {
  if (openGap(state, instance)) return true;
  if (gapsOf(state, instance).length >= OUTBOX_GAPS_PER_INSTANCE_MAX) return false;
  if (gapsOf(state, instance).length > 0 || instancesWithGaps(state).length < OUTBOX_GAP_INSTANCES_MAX) return true;
  return (openCross(state) !== undefined || canCreateCross(state)) && mergeableInstance(state, instance) !== null;
}

function crossSlotAvailable(state: AgentOutboxState): boolean {
  return openCross(state) !== undefined || canCreateCross(state);
}

function droppableTurnCompletedIndex(state: AgentOutboxState): number {
  return state.entries.findIndex((entry, index) => isNormal(entry) && entry.kind === "turnCompleted" && !isInFlightIndex(state, index));
}

function foldableIndexes(state: AgentOutboxState): number[] {
  const indexes: number[] = [];
  state.entries.forEach((entry, index) => {
    if (isNormal(entry) && entry.kind !== "turnCompleted" && !isInFlightIndex(state, index) && entry.takeoverEpoch === state.takeoverEpoch) {
      indexes.push(index);
    }
  });
  return indexes;
}

/**
 * Admission for a new start (amendment 2): the current epoch must keep room
 * for one launch's critical frames, one open gap for this daemon instance,
 * and one open cross entry. Evaluated after the start's epoch is adopted.
 */
export function canAdmitStart(state: AgentOutboxState, daemonInstanceId: string): boolean {
  const normalRoom = OUTBOX_NORMAL_CAP - normalCount(state)
    + state.entries.filter((entry, index) => isNormal(entry) && entry.kind === "turnCompleted" && !isInFlightIndex(state, index)).length
    + foldableIndexes(state).length;
  return normalRoom >= OUTBOX_LAUNCH_CRITICAL_RESERVE
    && gapSlotAvailable(state, daemonInstanceId)
    && crossSlotAvailable(state);
}

function mergeInstanceIntoCross(state: AgentOutboxState, instance: string): void {
  let cross = openCross(state);
  if (!cross) {
    cross = { t: "cross", gapId: randomUUID(), instances: [], takeoverEpoch: state.takeoverEpoch, counts: zeroCounts(), sealed: false };
    const firstGap = state.entries.findIndex((entry) => entry.t === "gap" && entry.daemonInstanceId === instance);
    state.entries.splice(firstGap, 0, cross);
  }
  for (const gap of gapsOf(state, instance)) {
    addCounts(cross.counts, gap.counts);
    state.entries.splice(state.entries.indexOf(gap), 1);
  }
  if (!cross.instances.includes(instance)) cross.instances.push(instance);
}

/** Fold the normal entry at `index` into a marker of the current epoch. Returns false if no marker slot exists. */
function foldEntry(state: AgentOutboxState, index: number): boolean {
  const entry = state.entries[index] as NormalEntry;
  const instance = entry.daemonInstanceId;
  let gap = openGap(state, instance);
  if (!gap && gapsOf(state, instance).length < OUTBOX_GAPS_PER_INSTANCE_MAX) {
    const hasGaps = gapsOf(state, instance).length > 0;
    if (!hasGaps && instancesWithGaps(state).length >= OUTBOX_GAP_INSTANCES_MAX) {
      const oldest = mergeableInstance(state, instance);
      if (oldest && crossSlotAvailable(state)) mergeInstanceIntoCross(state, oldest);
    }
    if (hasGaps || instancesWithGaps(state).length < OUTBOX_GAP_INSTANCES_MAX) {
      gap = {
        t: "gap", gapId: randomUUID(), daemonInstanceId: instance, takeoverEpoch: state.takeoverEpoch,
        fromSeq: entry.clientSeq, toSeq: entry.clientSeq, counts: zeroCounts(), sealed: false,
      };
      state.entries.splice(state.entries.indexOf(entry), 0, gap);
    }
  }
  if (gap) {
    gap.counts[entry.kind] += 1;
    gap.fromSeq = Math.min(gap.fromSeq, entry.clientSeq);
    gap.toSeq = Math.max(gap.toSeq, entry.clientSeq);
    state.entries.splice(state.entries.indexOf(entry), 1);
    return true;
  }
  let cross = openCross(state);
  if (!cross && canCreateCross(state)) {
    cross = { t: "cross", gapId: randomUUID(), instances: [], takeoverEpoch: state.takeoverEpoch, counts: zeroCounts(), sealed: false };
    state.entries.splice(state.entries.indexOf(entry), 0, cross);
  }
  if (!cross) return false;
  cross.counts[entry.kind] += 1;
  if (!cross.instances.includes(instance)) cross.instances.push(instance);
  state.entries.splice(state.entries.indexOf(entry), 1);
  return true;
}

export type AppendResult = "appended" | "dropped_turn_completed" | "folded" | "no_room";

/**
 * Append a frame, making room if the normal entries are full. Mutates
 * `state`. `no_room` means nothing could be dropped or folded: the frame is
 * NOT added and the caller must fail closed (unreliable). Under the admission
 * rule this is unreachable for frames of the current daemon instance.
 */
/**
 * `evict: false` (sending paused on a confirmed-old server): nothing queued
 * is dropped or folded to make room; a full queue is `no_room`.
 */
export function appendToOutbox(state: AgentOutboxState, entry: NormalEntry, options: { evict: boolean } = { evict: true }): AppendResult {
  let result: AppendResult = "appended";
  if (normalCount(state) >= OUTBOX_NORMAL_CAP && !options.evict) return "no_room";
  if (normalCount(state) >= OUTBOX_NORMAL_CAP) {
    const droppable = droppableTurnCompletedIndex(state);
    if (droppable >= 0) {
      const dropped = state.entries[droppable] as NormalEntry;
      const gap = openGap(state, dropped.daemonInstanceId);
      if (gap && dropped.takeoverEpoch === state.takeoverEpoch) {
        gap.counts.turnCompleted += 1;
        gap.fromSeq = Math.min(gap.fromSeq, dropped.clientSeq);
        gap.toSeq = Math.max(gap.toSeq, dropped.clientSeq);
      }
      state.entries.splice(droppable, 1);
      result = "dropped_turn_completed";
    } else if (entry.kind === "turnCompleted") {
      // A turn_completed never displaces a critical entry.
      return "dropped_turn_completed";
    } else {
      const folded = foldableIndexes(state).some((index) => foldEntry(state, index));
      if (!folded) return "no_room";
      result = "folded";
    }
  }
  state.entries.push(entry);
  return result;
}

/** A start carried a newer takeover epoch: seal every open marker of the older epoch. */
export function adoptTakeoverEpoch(state: AgentOutboxState, epoch: number): boolean {
  if (!(epoch > state.takeoverEpoch)) return false;
  for (const entry of state.entries) {
    if (entry.t !== "normal") entry.sealed = true;
  }
  state.takeoverEpoch = epoch;
  return true;
}

/** Remove the entry named by an ack. Only the exact entry; a late ack for a folded entry matches nothing. */
export function applyOutboxAck(
  state: AgentOutboxState,
  ack: { daemonInstanceId?: string; clientSeq?: number; gapId?: string },
): { matched: boolean; wasInFlight: boolean } {
  const index = state.entries.findIndex((entry) => ack.gapId !== undefined
    ? entry.t !== "normal" && entry.gapId === ack.gapId
    : entry.t === "normal" && entry.daemonInstanceId === ack.daemonInstanceId && entry.clientSeq === ack.clientSeq);
  if (index < 0) return { matched: false, wasInFlight: false };
  const wasInFlight = isInFlightIndex(state, index);
  state.entries.splice(index, 1);
  if (wasInFlight) state.inFlight = false;
  return { matched: true, wasInFlight };
}

export function hasUnackedMarker(state: AgentOutboxState): boolean {
  return state.entries.some((entry) => entry.t !== "normal");
}

/**
 * Un-acked gap / cross markers that block automatic starts: all of them,
 * except those older than a takeover an admitted human start durably
 * recorded. Nothing here removes a marker (only its ack does).
 */
export function blockingMarkers(state: AgentOutboxState): Array<GapEntry | CrossEntry> {
  const takenOver = state.humanTakeoverEpoch;
  return state.entries.filter((entry): entry is GapEntry | CrossEntry => entry.t !== "normal"
    && !(takenOver !== undefined && entry.takeoverEpoch < takenOver));
}

export function outboxEntryWireFrame(agentId: string, entry: OutboxEntry): MachineToServerMessage {
  switch (entry.t) {
    case "normal":
      return entry.frame;
    case "gap":
      return {
        type: "agent:runtime:outcome_gap",
        agentId,
        daemonInstanceId: entry.daemonInstanceId,
        gapId: entry.gapId,
        fromSeq: entry.fromSeq,
        toSeq: entry.toSeq,
        counts: { ...entry.counts },
        takeoverEpoch: entry.takeoverEpoch,
      };
    case "cross":
      return {
        type: "agent:runtime:outcome_cross_instance_unknown",
        agentId,
        gapId: entry.gapId,
        instances: [...entry.instances],
        counts: { ...entry.counts },
        takeoverEpoch: entry.takeoverEpoch,
      };
  }
}

// --- Durable storage -----------------------------------------------------

/** The four steps of a durable write, injectable so tests can fail between them. */
export interface OutboxFs {
  writeTempAndSync(tempPath: string, data: string): void;
  rename(from: string, to: string): void;
  syncDir(dir: string): void;
}

function fsyncDirectory(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Node-backed outbox storage. Windows has no directory fsync: fsync on a
 * directory handle fails with EPERM, which made every durable write fail and
 * every agent start be refused `storage_blocked` (computer-v1.0.42). On win32
 * the directory step is skipped, so the guarantee there is WEAKER than on
 * POSIX: the temp file's bytes are fsynced and the rename is atomic, but the
 * directory entry is not flushed, so after a power loss the rename itself may
 * not have reached disk (the previous record, or none, is what survives).
 * Real failures of the temp write, the file fsync or the rename still fail the
 * write on every platform; elsewhere a failing directory fsync still fails it.
 */
export function createNodeOutboxFs(options: {
  platform?: NodeJS.Platform;
  syncDir?: (dir: string) => void;
  fsyncFile?: (fd: number) => void;
} = {}): OutboxFs {
  const platform = options.platform ?? process.platform;
  const syncDir = options.syncDir ?? fsyncDirectory;
  const fsyncFile = options.fsyncFile ?? fsyncSync;
  return {
    writeTempAndSync(tempPath, data) {
      const fd = openSync(tempPath, "w", 0o600);
      try {
        writeSync(fd, data);
        fsyncFile(fd);
      } finally {
        closeSync(fd);
      }
    },
    rename(from, to) {
      renameSync(from, to);
    },
    syncDir(dir) {
      if (platform === "win32") return;
      syncDir(dir);
    },
  };
}

export const nodeOutboxFs: OutboxFs = createNodeOutboxFs();

function outboxFileName(agentId: string): string {
  return `${encodeURIComponent(agentId)}.json`;
}

// Side files use "@", which encodeURIComponent always escapes, so they never
// collide with an agent's queue file.
const MARKER_SUFFIX = "@unreliable.json";
const RESOLUTION_SUFFIX = "@resolution.json";
const CORRUPT_INFIX = ".json.corrupt-";
const ARCHIVED_SUFFIX = "@resolved";

const OPEN_LAUNCHES_SUFFIX = "@open-launches.json";

function openLaunchesFileName(agentId: string): string {
  return `${encodeURIComponent(agentId)}${OPEN_LAUNCHES_SUFFIX}`;
}

export type ProcessMode = "reliable" | "compat";
export type ServerCapability = "unknown" | "acks" | "old";
const SERVER_CAPABILITY_FILE = "@server-capability.json";

/** Start requests waiting for their result and runtime processes that may be running (see the module comment). */
export interface OpenLaunchRecord {
  v: 1;
  agentId: string;
  requests: Array<{ launchId: string; daemonInstanceId: string; admittedAtMs: number }>;
  /**
   * `spawnLaunchId` null: an internal start (restart) without a server launch;
   * no process frames exist for it, so its exit is recorded here
   * (`exitedAtMs`, durably) before the entry is removed.
   */
  processes: Array<{
    processInstanceId: string; spawnLaunchId: string | null; daemonInstanceId: string; openedAtMs: number; exitedAtMs?: number;
    /** Fixed at launch / rebind (see the module comment); absent (older records): reliable. */
    mode?: ProcessMode;
  }>;
}

function emptyOpenLaunches(agentId: string): OpenLaunchRecord {
  return { v: 1, agentId, requests: [], processes: [] };
}

function isOpenLaunchRecord(value: unknown, agentId: string): value is OpenLaunchRecord {
  const record = value as Record<string, unknown> | null;
  if (!record || typeof record !== "object" || Array.isArray(record) || record.v !== 1 || record.agentId !== agentId) return false;
  if (!Array.isArray(record.requests) || !Array.isArray(record.processes)) return false;
  const requestsOk = record.requests.every((entry: Record<string, unknown> | null) => !!entry && typeof entry === "object"
    && typeof entry.launchId === "string" && entry.launchId.length > 0
    && typeof entry.daemonInstanceId === "string" && entry.daemonInstanceId.length > 0
    && typeof entry.admittedAtMs === "number" && Number.isFinite(entry.admittedAtMs) && entry.admittedAtMs >= 0);
  const processesOk = record.processes.every((entry: Record<string, unknown> | null) => !!entry && typeof entry === "object"
    && typeof entry.processInstanceId === "string" && entry.processInstanceId.length > 0
    && (entry.spawnLaunchId === null || (typeof entry.spawnLaunchId === "string" && entry.spawnLaunchId.length > 0))
    && typeof entry.daemonInstanceId === "string" && entry.daemonInstanceId.length > 0
    && typeof entry.openedAtMs === "number" && Number.isFinite(entry.openedAtMs) && entry.openedAtMs >= 0
    && (entry.exitedAtMs === undefined || (typeof entry.exitedAtMs === "number" && Number.isFinite(entry.exitedAtMs) && entry.exitedAtMs >= 0))
    && (entry.mode === undefined || entry.mode === "reliable" || entry.mode === "compat"));
  if (!requestsOk || !processesOk) return false;
  const launchIds = (record.requests as Array<{ launchId: string }>).map((entry) => entry.launchId);
  const processIds = (record.processes as Array<{ processInstanceId: string }>).map((entry) => entry.processInstanceId);
  return new Set(launchIds).size === launchIds.length && new Set(processIds).size === processIds.length;
}

function markerFileName(agentId: string): string {
  return `${encodeURIComponent(agentId)}${MARKER_SUFFIX}`;
}

function resolutionFileName(agentId: string): string {
  return `${encodeURIComponent(agentId)}${RESOLUTION_SUFFIX}`;
}

/** Durable record that an agent's outbox lost (or may have lost) evidence. */
export interface UnreliableMarker {
  v: 1;
  markerId: string;
  agentId: string;
  since: number;
  cause: string;
  daemonInstanceId: string;
  takeoverEpoch: number;
}

/** Durable record of the explicit recovery (an admitted human start) that cleared a marker and corrupt files. */
export interface UnreliableResolution {
  v: 1;
  agentId: string;
  resolvedAt: number;
  launchId: string | null;
  daemonInstanceId: string;
  /** The marker this resolution clears (null if the marker was never durable). */
  markerId: string | null;
  cause: string;
  /** Corrupt files (names in the outbox dir) this resolution covers; they are archived, never deleted. */
  corruptFiles: string[];
  /** Open-launch entries of earlier daemon instances (outcome unknown) this resolution covers. */
  openLaunchIds?: string[];
  openProcessInstanceIds?: string[];
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isNonNegativeTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function isMarker(value: unknown, agentId: string): value is UnreliableMarker {
  const marker = value as Record<string, unknown> | null;
  return !!marker && typeof marker === "object" && !Array.isArray(marker) && marker.v === 1 && marker.agentId === agentId
    && isNonEmptyString(marker.markerId) && isNonNegativeTime(marker.since) && isNonEmptyString(marker.cause)
    && isNonEmptyString(marker.daemonInstanceId)
    && typeof marker.takeoverEpoch === "number" && Number.isSafeInteger(marker.takeoverEpoch) && marker.takeoverEpoch >= 0;
}

function isResolution(value: unknown, agentId: string): value is UnreliableResolution {
  const record = value as Record<string, unknown> | null;
  const idList = (list: unknown) => list === undefined || (Array.isArray(list) && list.every(isNonEmptyString));
  return !!record && typeof record === "object" && !Array.isArray(record) && record.v === 1 && record.agentId === agentId
    && isNonNegativeTime(record.resolvedAt) && (record.launchId === null || isNonEmptyString(record.launchId))
    && isNonEmptyString(record.daemonInstanceId) && (record.markerId === null || isNonEmptyString(record.markerId))
    && isNonEmptyString(record.cause) && Array.isArray(record.corruptFiles) && record.corruptFiles.every(isNonEmptyString)
    && idList(record.openLaunchIds) && idList(record.openProcessInstanceIds);
}

/** `@server-capability.json` (diagnostics only; never used for a decision). */
function isServerCapabilityRecord(value: unknown): value is { v: 1; lastKnownServerAcks: boolean; at: number } {
  const record = value as Record<string, unknown> | null;
  return !!record && typeof record === "object" && !Array.isArray(record) && record.v === 1
    && typeof record.lastKnownServerAcks === "boolean" && isNonNegativeTime(record.at);
}

export type OutboxStartRefusal = "terminal_failure_outcome_storage_blocked" | "terminal_failure_needs_manual";

/** The shown reason a start is refused because its runtime outcome evidence could not be stored. */
export const RUNTIME_OUTCOME_STORAGE_BLOCKED_TEXT = "Start refused: this Computer cannot store runtime outcome evidence until the server acknowledges what it holds";

/**
 * The shown reason an automatic start (a server start without `humanStart`,
 * or one the daemon makes on its own) of an unreliable agent is refused.
 * Only shown on a server that acknowledges runtime outcomes, where a person
 * starting the agent is the way out.
 */
export const AUTOMATIC_START_REFUSAL_TEXT = "Automatic start refused: runtime outcome evidence for this agent is incomplete; start it manually";

/**
 * RFC 071 human recovery: what one admitted human start may do at the
 * spawn / rebind gate. Bound to that start's launch, spent on first use,
 * and covering only the evidence known when it was admitted.
 */
export interface RecoveryGrant {
  readonly grantId: string;
  readonly agentId: string;
  readonly launchId: string;
  /** The unreliable marker this start's durable resolution cleared (null: none, or never durable). */
  readonly resolvedMarkerId: string | null;
  /** The takeover epoch this start durably recorded (null: it carried none). */
  readonly takeoverEpoch: number | null;
  /** The blocking markers (wire form) known at admission; any other blocking marker is a new fault. */
  readonly knownMarkers: readonly string[];
}

export interface StartRefusalDecision {
  reason: OutboxStartRefusal;
  /** The shown reason (with the way out). */
  detail: string;
}

/** A held start's wait for the connection's capability (see `waitForCapability`). */
export interface CapabilityWait {
  readonly confirmed: Promise<boolean>;
  cancel(): void;
}

export type OutboxStartAdmission =
  | { refusal: OutboxStartRefusal; recoveryGrant: null }
  | { refusal: null; recoveryGrant: RecoveryGrant | null };

function markerFingerprint(agentId: string, entry: GapEntry | CrossEntry): string {
  return JSON.stringify(outboxEntryWireFrame(agentId, entry));
}

// --- Strict validation of persisted records ------------------------------
//
// Every record read from disk is checked field by field before anything
// uses it: a record that parses but does not match its shape is treated
// exactly like unparseable JSON (kept aside, the agent unreliable). Decision
// code only ever sees validated (or freshly created) objects.

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isIdOrNull = (value: unknown): boolean => value === null || isId(value);
const ENTRY_KINDS: ReadonlySet<string> = new Set<EntryKind>(["e1", "turnCompleted", "spawned", "exited", "startOutcome"]);
const COUNT_KEYS: readonly CountKey[] = ["e1", "turnCompleted", "spawned", "exited", "startOutcome"];

function isValidCounts(value: unknown): value is AgentRuntimeOutcomeGapCounts {
  return isObject(value) && Object.keys(value).length === COUNT_KEYS.length && COUNT_KEYS.every((key) => isCount(value[key]));
}

/** The frame inside a normal entry: its envelope, its identity (= the entry's), and the kind it declares. */
function isValidFrame(value: unknown, agentId: string, entry: Json): boolean {
  if (!isObject(value) || value.agentId !== agentId || !OUTBOX_FRAME_TYPES.has(value.type as string)) return false;
  if (value.daemonInstanceId !== entry.daemonInstanceId || value.clientSeq !== entry.clientSeq) return false;
  if (value.generation !== undefined && !isCount(value.generation)) return false;
  switch (value.type) {
    case "agent:runtime:outcome": {
      const outcome = value.outcome;
      if (value.v !== 1 || !isId(value.launchId) || !(value.sessionId === null || typeof value.sessionId === "string") || !isTime(value.observedAtMs)) return false;
      if (!isObject(outcome)) return false;
      if (outcome.kind === "terminal_failure") return entry.kind === "e1" && isId(outcome.failureKind) && isId(outcome.fingerprint) && isId(outcome.errorClass);
      if (outcome.kind === "turn_completed") return entry.kind === "turnCompleted" && isCount(outcome.textEvents) && isCount(outcome.toolCalls);
      return false;
    }
    case "agent:process_spawned":
      return entry.kind === "spawned" && isId(value.processInstanceId) && isId(value.launchId)
        && (value.supersededLaunchIds === undefined || (Array.isArray(value.supersededLaunchIds) && value.supersededLaunchIds.every(isId)));
    case "agent:process_exited":
      return entry.kind === "exited" && isId(value.processInstanceId) && isIdOrNull(value.spawnLaunchId) && isId(value.launchId)
        && (value.code === null || (typeof value.code === "number" && Number.isInteger(value.code)))
        && (value.signal === null || typeof value.signal === "string");
    case "agent:start:outcome": {
      const result = value.result;
      if (entry.kind !== "startOutcome" || !isId(value.launchId) || !isObject(result)) return false;
      if (result.kind === "rebound") return isId(result.processInstanceId);
      if (result.kind === "not_spawned") return isId(result.reason);
      return false;
    }
    default:
      return false;
  }
}

function isValidEntry(value: unknown, agentId: string, epoch: number): value is OutboxEntry {
  if (!isObject(value) || !isCount(value.takeoverEpoch) || (value.takeoverEpoch as number) > epoch) return false;
  switch (value.t) {
    case "normal":
      return ENTRY_KINDS.has(value.kind as string) && isId(value.daemonInstanceId) && isCount(value.clientSeq)
        && isValidFrame(value.frame, agentId, value);
    case "gap":
      return isId(value.gapId) && isId(value.daemonInstanceId) && isCount(value.fromSeq) && isCount(value.toSeq)
        && (value.fromSeq as number) <= (value.toSeq as number) && isValidCounts(value.counts) && typeof value.sealed === "boolean";
    case "cross":
      return isId(value.gapId) && Array.isArray(value.instances) && value.instances.length > 0 && value.instances.every(isId)
        && new Set(value.instances).size === value.instances.length && isValidCounts(value.counts) && typeof value.sealed === "boolean";
    default:
      return false;
  }
}

/** The whole queue file: top-level fields, every entry, unique identities, and the capacity caps. */
function isValidState(value: unknown, agentId: string): value is AgentOutboxState {
  if (!isObject(value) || value.v !== 1 || value.agentId !== agentId || !isCount(value.takeoverEpoch)) return false;
  const epoch = value.takeoverEpoch as number;
  if (value.humanTakeoverEpoch !== undefined && !(isCount(value.humanTakeoverEpoch) && (value.humanTakeoverEpoch as number) <= epoch)) return false;
  if (value.protocolEngaged !== undefined && typeof value.protocolEngaged !== "boolean") return false;
  if (typeof value.inFlight !== "boolean" || !Array.isArray(value.entries)) return false;
  const entries = value.entries as unknown[];
  if (value.inFlight && entries.length === 0) return false;
  if (entries.length > OUTBOX_HARD_TOTAL || !entries.every((entry) => isValidEntry(entry, agentId, epoch))) return false;
  const state = value as unknown as AgentOutboxState;
  const normalIds = state.entries.filter(isNormal).map((entry) => `${entry.daemonInstanceId}\u0000${entry.clientSeq}`);
  const markerIds = state.entries.filter((entry) => entry.t !== "normal").map((entry) => (entry as GapEntry | CrossEntry).gapId);
  if (new Set(normalIds).size !== normalIds.length || new Set(markerIds).size !== markerIds.length) return false;
  if (normalIds.length > OUTBOX_NORMAL_CAP || crossEntries(state).length > OUTBOX_CROSS_MAX) return false;
  const instances = instancesWithGaps(state);
  return instances.length <= OUTBOX_GAP_INSTANCES_MAX && instances.every((instance) => gapsOf(state, instance).length <= OUTBOX_GAPS_PER_INSTANCE_MAX);
}

export interface RuntimeOutcomeOutboxOptions {
  dir: string;
  daemonInstanceId: string;
  /** Raw send on the current connection. Outbox entries are sent only while the server acknowledges; the unreliable notice is best effort. */
  send: (msg: MachineToServerMessage) => void;
  fs?: OutboxFs;
  trace?: (name: string, attrs: Record<string, unknown>, status?: "ok" | "error") => void;
  now?: () => number;
  /** Jitter source for the retransmission backoff (tests pin it). */
  random?: () => number;
}

interface UnreliableInfo {
  cause: string;
  /** The durable marker's id; null while no marker could be written (retried). */
  markerId: string | null;
}

export class RuntimeOutcomeOutbox {
  private readonly states = new Map<string, AgentOutboxState>();
  private readonly unreliable = new Map<string, UnreliableInfo>();
  /** Per agent: the pending resend timer of the in-flight entry and how many resends it already had. */
  private readonly retransmits = new Map<string, { timer: ReturnType<typeof setTimeout> | null; attempt: number }>();
  /** THIS connection's confirmed capability (`unknown` until its machine:context, and after a disconnect). */
  private capability: ServerCapability = "unknown";
  /** Held starts waiting for this connection's capability: `true` confirmed, `false` cancelled. */
  private readonly capabilityWaiters = new Set<(confirmed: boolean) => void>();
  /** Per agent, the one live recovery grant (a newer admitted human start replaces it; the gate spends it). */
  private readonly recoveryGrants = new Map<string, RecoveryGrant>();
  /** Per agent, the durable open-launch record (memory changes only after the write succeeded). */
  private readonly openLaunches = new Map<string, OpenLaunchRecord>();
  private readonly fs: OutboxFs;

  constructor(private readonly options: RuntimeOutcomeOutboxOptions) {
    this.fs = options.fs ?? nodeOutboxFs;
  }

  /**
   * Load every agent's outbox. A corrupt file is renamed aside (never
   * deleted) and its agent is unreliable. An agent with an unreliable marker,
   * or with a renamed-aside corrupt file no resolution record covers, is
   * unreliable (so the protection survives any number of restarts).
   */
  load(): void {
    const dir = this.options.dir;
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name.includes(".tmp-")) {
        // An interrupted write; the complete state is the non-temp file.
        rmSync(path.join(dir, name), { force: true });
        continue;
      }
      if (!name.endsWith(".json") || name.includes("@")) continue;
      const agentId = decodeURIComponent(name.slice(0, -".json".length));
      const filePath = path.join(dir, name);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(filePath, "utf8"));
      } catch {
        parsed = undefined;
      }
      if (isValidState(parsed, agentId)) {
        this.states.set(agentId, parsed);
        continue;
      }
      const aside = `${filePath}.corrupt-${(this.options.now ?? Date.now)()}`;
      try {
        renameSync(filePath, aside);
      } catch {
        // Keep it where it is; it is still not deleted.
      }
      this.options.trace?.("daemon.runtime_outcome_outbox.corrupt", { agentId }, "error");
      this.states.set(agentId, freshOutboxState(agentId));
      this.markUnreliable(agentId, "corrupt_on_load");
    }
    this.loadUnreliable();
  }

  /**
   * Keep an invalid side record aside under a corrupt name (never deleted):
   * like a corrupt queue file, it stays unresolved (the agent unreliable)
   * until an admitted human start's resolution archives it.
   */
  private setAsideInvalid(agentId: string, name: string, what: string): boolean {
    const dir = this.options.dir;
    this.options.trace?.("daemon.runtime_outcome_outbox.corrupt", { agentId, record: what }, "error");
    try {
      renameSync(path.join(dir, name), path.join(dir, `${outboxFileName(agentId)}${CORRUPT_INFIX.slice(".json".length)}${what}-${(this.options.now ?? Date.now)()}`));
      return true;
    } catch {
      // Left in place; still unreliable.
      return false;
    }
  }

  /**
   * The last confirmed server capability, for diagnostics only (never a
   * decision). An invalid record is set aside (renamed, not deleted) and
   * reads as null.
   */
  lastKnownServerCapability(): { lastKnownServerAcks: boolean; at: number } | null {
    const filePath = path.join(this.options.dir, SERVER_CAPABILITY_FILE);
    if (!existsSync(filePath)) return null;
    const record = readJson(filePath);
    if (isServerCapabilityRecord(record)) return { lastKnownServerAcks: record.lastKnownServerAcks, at: record.at };
    try {
      renameSync(filePath, `${filePath}.invalid-${(this.options.now ?? Date.now)()}`);
    } catch {
      // Diagnostics only.
    }
    return null;
  }

  private loadUnreliable(): void {
    const dir = this.options.dir;
    const names = readdirSync(dir);
    const resolutions = new Map<string, UnreliableResolution>();
    for (const name of names) {
      if (!name.endsWith(RESOLUTION_SUFFIX)) continue;
      const agentId = decodeURIComponent(name.slice(0, -RESOLUTION_SUFFIX.length));
      const record = readJson(path.join(dir, name));
      if (isResolution(record, agentId)) {
        resolutions.set(agentId, record);
        continue;
      }
      // An invalid resolution resolves nothing: kept aside, the agent unreliable.
      this.setAsideInvalid(agentId, name, "resolution");
      this.markUnreliable(agentId, "resolution_corrupt");
    }
    let finishedCleanup = false;
    for (const name of names) {
      if (!name.endsWith(MARKER_SUFFIX)) continue;
      const agentId = decodeURIComponent(name.slice(0, -MARKER_SUFFIX.length));
      const marker = readJson(path.join(dir, name));
      if (isMarker(marker, agentId) && resolutions.get(agentId)?.markerId === marker.markerId) {
        // Resolved; a crash interrupted the removal. Finish it.
        rmSync(path.join(dir, name), { force: true });
        finishedCleanup = true;
        continue;
      }
      if (isMarker(marker, agentId)) {
        this.markUnreliable(agentId, marker.cause, marker.markerId);
        continue;
      }
      // An invalid marker is still a marker: kept aside (never deleted), and
      // the agent is unreliable under a new, valid durable marker.
      // If it could not be moved, it is left as the (unreadable) marker and not overwritten.
      if (this.setAsideInvalid(agentId, name, "marker")) this.markUnreliable(agentId, "marker_corrupt");
      else this.markUnreliable(agentId, "marker_corrupt", `unreadable:${name}`);
    }
    for (const name of names) {
      if (!name.endsWith(OPEN_LAUNCHES_SUFFIX)) continue;
      const agentId = decodeURIComponent(name.slice(0, -OPEN_LAUNCHES_SUFFIX.length));
      const filePath = path.join(dir, name);
      const record = readJson(filePath);
      if (!isOpenLaunchRecord(record, agentId)) {
        // Kept (renamed aside, never deleted) and unresolved: unreliable.
        this.setAsideInvalid(agentId, name, "open-launches");
        this.markUnreliable(agentId, "open_launches_corrupt");
        continue;
      }
      // Entries a durable resolution already covers, and processes whose exit
      // was durably recorded here: finish the interrupted removal.
      const resolution = resolutions.get(agentId);
      const kept: OpenLaunchRecord = {
        ...record,
        requests: record.requests.filter((entry) => !resolution?.openLaunchIds?.includes(entry.launchId)),
        processes: record.processes.filter((entry) => !resolution?.openProcessInstanceIds?.includes(entry.processInstanceId)
          && typeof entry.exitedAtMs !== "number"),
      };
      this.openLaunches.set(agentId, record);
      if (kept.requests.length !== record.requests.length || kept.processes.length !== record.processes.length) {
        if (this.writeOpenLaunches(agentId, kept, { markOnFailure: false })) finishedCleanup = true;
        else this.openLaunches.set(agentId, kept); // resolved either way; the file is rewritten next time
      }
      if (kept.requests.length > 0 || kept.processes.length > 0) {
        // An earlier instance admitted or ran these; no terminal frame was durably stored: the outcome is unknown.
        this.options.trace?.("daemon.runtime_outcome_outbox.open_launch_unknown_outcome", {
          agentId, requests: kept.requests.length, processes: kept.processes.length,
        }, "error");
        this.markUnreliable(agentId, "open_launch_unknown_outcome");
      }
    }
    for (const name of readdirSync(dir)) {
      const at = name.indexOf(CORRUPT_INFIX);
      if (at <= 0 || name.endsWith(ARCHIVED_SUFFIX) || name.includes(".tmp-")) continue;
      const agentId = decodeURIComponent(name.slice(0, at));
      if (resolutions.get(agentId)?.corruptFiles.includes(name)) {
        try {
          this.fs.rename(path.join(dir, name), path.join(dir, `${name}${ARCHIVED_SUFFIX}`));
          finishedCleanup = true;
        } catch {
          // Resolved either way; the archive rename is retried on the next load.
        }
        continue;
      }
      this.markUnreliable(agentId, "corrupt_unresolved");
    }
    if (finishedCleanup) {
      try {
        this.fs.syncDir(dir);
      } catch {
        // The resolution record is durable; a lost cleanup is redone next load.
      }
    }
  }

  state(agentId: string): AgentOutboxState {
    let state = this.states.get(agentId);
    if (!state) {
      state = freshOutboxState(agentId);
      this.states.set(agentId, state);
    }
    return state;
  }

  isUnreliable(agentId: string): boolean {
    return this.unreliable.has(agentId);
  }

  unreliableAgents(): string[] {
    return [...this.unreliable.keys()];
  }

  /**
   * THE automatic-start rule, the single source of truth for every start:
   * the server's automatic starts (`decideStart`) and the spawn / rebind
   * gate every start goes through (crash respawn, wake / message cold start,
   * restart on message, deferred spawn, rebind, and server starts). Returns
   * the shown reason, or null when the start may go on.
   *
   * Without a grant the start is automatic: refused while the agent is
   * unreliable, or while a blocking marker exists (`blockingMarkers`): one
   * of lost critical evidence on every server, a backlog-only one
   * (`turn_completed`) only while the server is not known not to ack. With `recoveryGrant` (and the
   * `launchId` the start carries), the grant is spent here whatever the
   * answer; if it is the agent's live grant and bound to that launch, the
   * start passes unless a NEW fault appeared since its admission (any
   * unreliable state now, or a blocking marker the grant did not know). A
   * replaced, spent or other-launch grant counts for nothing: automatic.
   */
  startRefusal(agentId: string, launchId: string | null = null, recoveryGrant: RecoveryGrant | null = null): string | null {
    return this.startDecision(agentId, launchId, recoveryGrant)?.detail ?? null;
  }

  /**
   * `startRefusal` with its reason (`needs_manual`: a human start is the way
   * out), which callers settle waiting launches with. Null on a confirmed-old
   * server: no human start can come from it.
   */
  startDecision(agentId: string, launchId: string | null = null, recoveryGrant: RecoveryGrant | null = null): StartRefusalDecision | null {
    const spent = recoveryGrant !== null && this.spendRecoveryGrant(agentId, launchId, recoveryGrant);
    // A confirmed-old server never sends the human start that clears a
    // refusal: refusing there would strand the agent, so nothing is refused.
    if (this.capability === "old") return null;
    const refusal: StartRefusalDecision = { reason: "terminal_failure_needs_manual", detail: AUTOMATIC_START_REFUSAL_TEXT };
    const blocking = blockingMarkers(this.state(agentId));
    if (recoveryGrant && spent) {
      const newMarkers = blocking.filter((entry) => !recoveryGrant.knownMarkers.includes(markerFingerprint(agentId, entry)));
      const newCause = this.unreliable.get(agentId)?.cause ?? null;
      if (newCause === null && newMarkers.length === 0) return null;
      this.options.trace?.("daemon.runtime_outcome_outbox.recovery_grant_overridden", {
        agentId, launch_id: launchId, grant_id: recoveryGrant.grantId, new_unreliable_cause: newCause, new_markers: newMarkers.length,
      }, "error");
      return refusal;
    }
    if (this.unreliable.has(agentId) || blocking.length > 0) return refusal;
    return null;
  }

  /** Whether an automatic start would be refused now (`startRefusal` without a grant). */
  refusesAutomaticStart(agentId: string): boolean {
    return this.startRefusal(agentId) !== null;
  }

  /** Spend `grant` if it is the agent's live one; true only if it is also bound to `launchId`. */
  private spendRecoveryGrant(agentId: string, launchId: string | null, grant: RecoveryGrant): boolean {
    if (this.recoveryGrants.get(agentId) !== grant) {
      this.options.trace?.("daemon.runtime_outcome_outbox.recovery_grant_not_live", { agentId, launch_id: launchId, grant_id: grant.grantId }, "error");
      return false;
    }
    this.recoveryGrants.delete(agentId);
    return grant.agentId === agentId && grant.launchId === launchId;
  }

  /** A start that ends before reaching the gate (failed, cancelled) spends its grant here. */
  releaseRecoveryGrant(grant: RecoveryGrant | null | undefined): void {
    if (grant && this.recoveryGrants.get(grant.agentId) === grant) this.recoveryGrants.delete(grant.agentId);
  }

  /**
   * Adopt a start's takeover epoch (sealing older markers), then decide
   * whether the start fits the reserve. An epoch that cannot be recorded
   * durably refuses the start: its evidence could not be stored either.
   */
  admitStart(agentId: string, takeoverEpoch: number | undefined): boolean {
    if (takeoverEpoch !== undefined && this.commit(agentId, (state) => adoptTakeoverEpoch(state, takeoverEpoch)) === "failed") return false;
    return canAdmitStart(this.state(agentId), this.options.daemonInstanceId);
  }

  /**
   * The outbox's local decision on an accepted start. A KNOWN storage failure
   * refuses whatever server is attached (an older server only means no
   * outbox frames are sent to it); what depends on acks (the reserve that
   * acks drain, un-acked markers) applies only while the server acks:
   *  - its epoch cannot be recorded, or its open request cannot be written:
   *    `terminal_failure_outcome_storage_blocked`, human starts included;
   *  - (acks) no reserve for this launch: `storage_blocked`, human starts included;
   *  - an AUTOMATIC start (no `humanStart: true`) while the agent is
   *    unreliable, or (acks) has an un-acked marker: `terminal_failure_needs_manual`;
   *  - a HUMAN start is the explicit recovery: it is admitted only if it
   *    durably resolves the unreliable state; a recovery whose resolution
   *    record cannot be written is refused `storage_blocked` (a failed
   *    recovery never counts as an admitted start). Automatic starts never
   *    resolve anything.
   */
  decideStart(agentId: string, start: { takeoverEpoch?: number; humanStart?: boolean; launchId?: string }): OutboxStartRefusal | null {
    return this.admitServerStart(agentId, start).refusal;
  }

  /**
   * `decideStart`, plus the recovery grant of an admitted human start (with
   * a launchId): the only thing that lets that start through the spawn /
   * rebind gate under the recovery contract. The human takeover (its epoch)
   * is durably recorded only after the resolution; either write failing
   * refuses the start `storage_blocked` and exempts nothing.
   */
  admitServerStart(agentId: string, start: { takeoverEpoch?: number; humanStart?: boolean; launchId?: string }): OutboxStartAdmission {
    const refuse = (refusal: OutboxStartRefusal): OutboxStartAdmission => ({ refusal, recoveryGrant: null });
    if (start.takeoverEpoch !== undefined
      && this.commit(agentId, (state) => adoptTakeoverEpoch(state, start.takeoverEpoch!)) === "failed") {
      return refuse("terminal_failure_outcome_storage_blocked");
    }
    if (this.capability === "acks" && !canAdmitStart(this.state(agentId), this.options.daemonInstanceId)) return refuse("terminal_failure_outcome_storage_blocked");
    if (start.humanStart !== true && this.startRefusal(agentId) !== null) return refuse("terminal_failure_needs_manual");
    // Before admitting: the request is durably open (its result will close it).
    if (start.launchId !== undefined && !this.openRequest(agentId, start.launchId)) return refuse("terminal_failure_outcome_storage_blocked");
    if (start.humanStart !== true) return { refusal: null, recoveryGrant: null };
    const resolvedMarkerId = this.unreliable.get(agentId)?.markerId ?? null;
    const takeoverEpoch = start.takeoverEpoch;
    if (this.resolveUnreliable(agentId, start.launchId ?? null) === "failed"
      || (takeoverEpoch !== undefined && this.commit(agentId, (state) => {
        if (state.humanTakeoverEpoch !== undefined && state.humanTakeoverEpoch >= takeoverEpoch) return false;
        state.humanTakeoverEpoch = takeoverEpoch;
        return true;
      }) === "failed")) {
      // Not admitted; its request gets no stored result, so drop it (if that fails too it stays: conservative).
      if (start.launchId !== undefined) this.closeOpenEntries(agentId, [start.launchId], []);
      return refuse("terminal_failure_outcome_storage_blocked");
    }
    if (start.launchId === undefined) {
      this.recoveryGrants.delete(agentId);
      return { refusal: null, recoveryGrant: null };
    }
    const recoveryGrant: RecoveryGrant = {
      grantId: randomUUID(),
      agentId,
      launchId: start.launchId,
      resolvedMarkerId,
      takeoverEpoch: takeoverEpoch ?? null,
      knownMarkers: blockingMarkers(this.state(agentId)).map((entry) => markerFingerprint(agentId, entry)),
    };
    this.recoveryGrants.set(agentId, recoveryGrant);
    return { refusal: null, recoveryGrant };
  }

  /** Durably open a start request before it is admitted. */
  private openRequest(agentId: string, launchId: string): boolean {
    const record = this.openLaunches.get(agentId) ?? emptyOpenLaunches(agentId);
    if (record.requests.some((entry) => entry.launchId === launchId)) return true;
    return this.writeOpenLaunches(agentId, {
      ...record,
      requests: [...record.requests, { launchId, daemonInstanceId: this.options.daemonInstanceId, admittedAtMs: (this.options.now ?? Date.now)() }],
    }, { markOnFailure: true });
  }

  /**
   * The spawn / rebind gate: durably record that this runtime process may run
   * BEFORE it is spawned or reused. False means do not spawn / rebind (the
   * agent is unreliable), whatever server is attached. `spawnLaunchId` null:
   * an internal start without a server launch, keyed by its own
   * `processInstanceId` (closed by `processExitedLocally`).
   */
  openProcess(agentId: string, processInstanceId: string, spawnLaunchId: string | null): boolean {
    const record = this.openLaunches.get(agentId) ?? emptyOpenLaunches(agentId);
    // The mode is fixed now (launch / rebind): reliable only under a confirmed acking connection.
    const mode: ProcessMode = this.capability === "acks" ? "reliable" : "compat";
    const existing = record.processes.find((entry) => entry.processInstanceId === processInstanceId);
    if (existing) {
      // A rebind under acks upgrades a compat process; nothing downgrades one.
      if (mode === "compat" || existing.mode !== "compat") return true;
      return this.writeOpenLaunches(agentId, {
        ...record,
        processes: record.processes.map((entry) => entry === existing ? { ...entry, mode } : entry),
      }, { markOnFailure: true });
    }
    const written = this.writeOpenLaunches(agentId, {
      ...record,
      processes: [...record.processes, {
        processInstanceId, spawnLaunchId, daemonInstanceId: this.options.daemonInstanceId, openedAtMs: (this.options.now ?? Date.now)(), mode,
      }],
    }, { markOnFailure: true });
    return written;
  }

  /** A reliable-mode process of the agent may still be running: its frames are always produced. */
  private hasOpenReliableProcess(agentId: string): boolean {
    return (this.openLaunches.get(agentId)?.processes ?? [])
      .some((entry) => entry.mode !== "compat" && typeof entry.exitedAtMs !== "number");
  }

  /** The mode a process was fixed to, if it is open (tests, diagnostics). */
  processMode(agentId: string, processInstanceId: string): ProcessMode | null {
    const entry = this.openLaunches.get(agentId)?.processes.find((candidate) => candidate.processInstanceId === processInstanceId);
    return entry ? entry.mode ?? "reliable" : null;
  }

  currentServerCapability(): ServerCapability {
    return this.capability;
  }

  /**
   * Wait for THIS connection's capability (at once if it is confirmed).
   * `confirmed` resolves true once it is, or false if the wait is cancelled
   * (`cancel()`, for that start only, or `stop()` for all): the waiter is
   * removed and the capability is not pretended known.
   */
  waitForCapability(): CapabilityWait {
    if (this.capability !== "unknown") return { confirmed: Promise.resolve(true), cancel: () => {} };
    let settle!: (confirmed: boolean) => void;
    const confirmed = new Promise<boolean>((resolve) => { settle = resolve; });
    this.capabilityWaiters.add(settle);
    return {
      confirmed,
      cancel: () => {
        if (this.capabilityWaiters.delete(settle)) settle(false);
      },
    };
  }

  /** Starts currently held for the capability (diagnostics, tests). */
  heldCapabilityWaits(): number {
    return this.capabilityWaiters.size;
  }

  private releaseCapabilityWaiters(confirmed: boolean): void {
    const waiters = [...this.capabilityWaiters];
    this.capabilityWaiters.clear();
    for (const settle of waiters) settle(confirmed);
  }

  /**
   * End engagement, durably, only on a confirmed-old connection with a
   * completely empty queue and no open reliable process. Deletes nothing.
   */
  private maybeDisengage(agentId: string): void {
    const state = this.states.get(agentId);
    if (!state || this.capability !== "old" || state.protocolEngaged !== true) return;
    if (state.entries.length > 0 || this.hasOpenReliableProcess(agentId)) return;
    if (this.commit(agentId, (draft) => {
      draft.protocolEngaged = false;
      return true;
    }) === "committed") {
      this.options.trace?.("daemon.runtime_outcome_outbox.disengaged", { agentId });
    }
  }

  /**
   * The exit of a process opened without a server launch (no process frames
   * exist for it): record the exit in the open-launch record durably, THEN
   * remove the entry (a crash in between is finished by load). An exit of a
   * process with a server launch, or one no entry matches, clears nothing:
   * only its stored `process_exited` can (else unknown after a restart). A
   * failed exit record keeps the entry and makes the agent unreliable.
   */
  processExitedLocally(agentId: string, processInstanceId: string): void {
    const record = this.openLaunches.get(agentId);
    const entry = record?.processes.find((candidate) => candidate.processInstanceId === processInstanceId);
    if (!record || !entry || entry.spawnLaunchId !== null) {
      this.options.trace?.("daemon.runtime_outcome_outbox.local_exit_uncorrelated", { agentId, process_instance_id: processInstanceId }, "error");
      return;
    }
    if (!this.unreliableDurableForRemoval(agentId)) return;
    if (typeof entry.exitedAtMs !== "number") {
      const exitedAtMs = (this.options.now ?? Date.now)();
      const recorded = this.writeOpenLaunches(agentId, {
        ...record,
        processes: record.processes.map((candidate) => candidate === entry ? { ...candidate, exitedAtMs } : candidate),
      }, { markOnFailure: true });
      if (!recorded) return;
    }
    this.closeOpenEntries(agentId, [], [processInstanceId]);
  }

  /**
   * A start that failed before its process was reported spawned: no runtime
   * runs for it and no process frame will ever name it (its launches are
   * settled `not_spawned`). That is known now, so its entry closes now;
   * left open it would read as an unknown outcome after a restart.
   */
  processNotStarted(agentId: string, processInstanceId: string): void {
    if (!this.openLaunches.get(agentId)?.processes.some((entry) => entry.processInstanceId === processInstanceId)) return;
    this.options.trace?.("daemon.runtime_outcome_outbox.process_not_started", { agentId, process_instance_id: processInstanceId });
    this.closeOpenEntries(agentId, [], [processInstanceId]);
  }

  /** Open-launch entries the given durably stored frame closes: the request for a start result; the process for its exit. */
  private closeForStoredFrame(frame: OutboxFrame): void {
    switch (frame.type) {
      case "agent:process_spawned":
        this.closeOpenEntries(frame.agentId, [frame.launchId, ...(frame.supersededLaunchIds ?? [])], []);
        return;
      case "agent:start:outcome":
        // rebound: the request has its result; the reused process stays open.
        this.closeOpenEntries(frame.agentId, [frame.launchId], []);
        return;
      case "agent:process_exited":
        this.closeOpenEntries(frame.agentId, [], [frame.processInstanceId]);
        return;
      case "agent:runtime:outcome":
        return;
    }
  }

  /**
   * Remove open entries. Never while the agent's unreliable state is only in
   * memory: removing them first could leave a falsely clean disk. A failed
   * write keeps them (conservative: unknown after a restart).
   */
  private closeOpenEntries(agentId: string, launchIds: string[], processInstanceIds: string[]): void {
    const record = this.openLaunches.get(agentId);
    if (!record) return;
    const next: OpenLaunchRecord = {
      ...record,
      requests: record.requests.filter((entry) => !launchIds.includes(entry.launchId)),
      processes: record.processes.filter((entry) => !processInstanceIds.includes(entry.processInstanceId)),
    };
    if (next.requests.length === record.requests.length && next.processes.length === record.processes.length) return;
    if (!this.unreliableDurableForRemoval(agentId)) return;
    this.writeOpenLaunches(agentId, next, { markOnFailure: false });
  }

  /** Open entries may be removed (or marked exited) only once an unreliable state is durable: the marker first. */
  private unreliableDurableForRemoval(agentId: string): boolean {
    const info = this.unreliable.get(agentId);
    if (!info || info.markerId !== null) return true;
    this.writeMarker(agentId, info);
    if (info.markerId !== null) return true;
    this.options.trace?.("daemon.runtime_outcome_outbox.open_launch_kept", { agentId, reason: "unreliable_not_durable" }, "error");
    return false;
  }

  private writeOpenLaunches(agentId: string, next: OpenLaunchRecord, options: { markOnFailure: boolean }): boolean {
    try {
      this.durableWrite(path.join(this.options.dir, openLaunchesFileName(agentId)), JSON.stringify(next));
      this.openLaunches.set(agentId, next);
      return true;
    } catch (err) {
      this.options.trace?.("daemon.runtime_outcome_outbox.open_launches_write_failed", {
        agentId, error_class: err instanceof Error ? err.name : "unknown",
      }, "error");
      if (options.markOnFailure) this.markUnreliable(agentId, "open_launches_write_failed");
      return false;
    }
  }

  currentTakeoverEpoch(agentId: string): number {
    return this.state(agentId).takeoverEpoch;
  }

  /**
   * Write-ahead enqueue: the frame is sent only after the queue holding it is
   * durably on disk. If that write fails the queue does not change, the frame
   * is not sent through the outbox, and the agent is unreliable.
   */
  enqueue(frame: OutboxFrame): void {
    if (this.capability === "old") {
      this.maybeDisengage(frame.agentId);
      if (!this.hasOpenReliableProcess(frame.agentId)) {
        // A compat process's result on a confirmed-old connection: no reader,
        // so no frame (engaged or not: what is already queued stays, but
        // nothing is added to it). The open-launch entries it settles still
        // close (its result is known here).
        this.closeForStoredFrame(frame);
        return;
      }
    }
    const entry: NormalEntry = {
      t: "normal",
      kind: outboxEntryKind(frame),
      daemonInstanceId: frame.daemonInstanceId,
      clientSeq: frame.clientSeq,
      takeoverEpoch: this.state(frame.agentId).takeoverEpoch,
      frame,
    };
    // Assigned inside the commit callback (a cast keeps TS from narrowing it to "appended").
    let result = "appended" as AppendResult;
    const committed = this.commit(frame.agentId, (state) => {
      result = appendToOutbox(state, entry, { evict: this.capability !== "old" });
      if (result === "no_room") return false;
      state.protocolEngaged = true;
      return true;
    }) === "committed";
    if (result !== "appended") {
      this.options.trace?.("daemon.runtime_outcome_outbox.overflow", {
        agentId: frame.agentId, result, kind: entry.kind, client_seq: entry.clientSeq,
      }, result === "no_room" ? "error" : "ok");
    }
    if (result === "no_room") {
      // Known evidence is lost: fail closed.
      this.markUnreliable(frame.agentId, "no_room");
      return;
    }
    if (!committed) return;
    // Stored and retryable: now (and only now) the entries it closes may go.
    this.closeForStoredFrame(frame);
    this.pump(frame.agentId);
  }

  /** Delete exactly the acked entry, durably; only then send the next one. A failed write keeps the entry (the server's redelivered ack retries). */
  ack(ack: { agentId: string; daemonInstanceId?: string; clientSeq?: number; gapId?: string }): void {
    if (!this.states.has(ack.agentId)) return;
    let wasInFlight = false;
    const committed = this.commit(ack.agentId, (state) => {
      const applied = applyOutboxAck(state, ack);
      wasInFlight = applied.wasInFlight;
      return applied.matched;
    }) === "committed";
    if (!committed) return;
    // The next entry starts a fresh backoff.
    if (wasInFlight) this.resetRetransmit(ack.agentId);
    this.pump(ack.agentId);
  }

  /** A new connection's `machine:context`: resend each agent's oldest entry at once (stop-and-wait restarts, backoff reset). */
  onServerContext(supportsAcks: boolean): void {
    this.capability = supportsAcks ? "acks" : "old";
    this.recordLastKnownCapability(supportsAcks);
    this.resetAllRetransmits();
    this.releaseCapabilityWaiters(true);
    if (!supportsAcks) {
      for (const agentId of [...this.states.keys()]) this.maybeDisengage(agentId);
      return;
    }
    for (const agentId of this.states.keys()) this.sendOldest(agentId);
  }

  /** Diagnostics only (never read back into a decision): the last confirmed capability. */
  private recordLastKnownCapability(acks: boolean): void {
    try {
      this.durableWrite(path.join(this.options.dir, SERVER_CAPABILITY_FILE), JSON.stringify({ v: 1, lastKnownServerAcks: acks, at: (this.options.now ?? Date.now)() }));
    } catch {
      // Diagnostics only.
    }
  }

  onDisconnected(): void {
    this.capability = "unknown";
    this.resetAllRetransmits();
  }

  /** Daemon shutdown: no timer outlives it. The queue stays on disk. */
  stop(): void {
    this.capability = "unknown";
    // Held starts end cancelled: the daemon is stopping, nothing was confirmed.
    this.releaseCapabilityWaiters(false);
    this.resetAllRetransmits();
  }

  private resetRetransmit(agentId: string): void {
    const pending = this.retransmits.get(agentId);
    if (pending?.timer) clearTimeout(pending.timer);
    this.retransmits.delete(agentId);
  }

  private resetAllRetransmits(): void {
    for (const agentId of [...this.retransmits.keys()]) this.resetRetransmit(agentId);
  }

  /** (Re)arm the in-flight entry's resend timer with the agent's current backoff step. */
  private armRetransmit(agentId: string): void {
    const pending = this.retransmits.get(agentId) ?? { timer: null, attempt: 0 };
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      pending.timer = null;
      pending.attempt += 1;
      this.sendOldest(agentId);
    }, retransmitDelayMs(pending.attempt, this.options.random));
    pending.timer.unref?.();
    this.retransmits.set(agentId, pending);
  }

  private pump(agentId: string): void {
    const state = this.states.get(agentId);
    if (!state || state.inFlight) return;
    this.sendOldest(agentId);
  }

  /** Send (or resend, same identity) the oldest entry and arm its resend timer. */
  private sendOldest(agentId: string): void {
    if (this.capability !== "acks") return;
    const state = this.states.get(agentId);
    const oldest = state?.entries[0];
    if (!state || !oldest) {
      this.resetRetransmit(agentId);
      return;
    }
    if (!state.inFlight || (oldest.t !== "normal" && !oldest.sealed)) {
      const committed = this.commit(agentId, (draft) => {
        draft.inFlight = true;
        // An in-flight marker is sealed: nothing folds into what was sent.
        const first = draft.entries[0]!;
        if (first.t !== "normal") first.sealed = true;
        return true;
      }) === "committed";
      if (!committed) {
        // Not durably in flight: not sent. Retry the write on the backoff.
        this.armRetransmit(agentId);
        return;
      }
    }
    this.options.send(outboxEntryWireFrame(agentId, state.entries[0]!));
    this.armRetransmit(agentId);
  }

  /**
   * Apply `mutate` to the agent's queue and persist it. The change stands
   * only if the durable write succeeded; otherwise the in-memory queue is
   * rolled back and the agent is unreliable. `mutate` returning false means
   * "nothing to persist" (also rolled back): `noop`.
   */
  private commit(agentId: string, mutate: (state: AgentOutboxState) => boolean): "committed" | "noop" | "failed" {
    const state = this.state(agentId);
    const before = JSON.stringify(state);
    // Restores the pre-change queue (only if it changed, so entry objects stay stable otherwise).
    const rollback = () => {
      if (JSON.stringify(state) !== before) Object.assign(state, JSON.parse(before) as AgentOutboxState);
    };
    if (!mutate(state)) {
      rollback();
      return "noop";
    }
    if (!this.persist(agentId, state)) {
      rollback();
      return "failed";
    }
    // Storage works again: make a still memory-only unreliable state durable.
    const info = this.unreliable.get(agentId);
    if (info && info.markerId === null) this.writeMarker(agentId, info);
    return "committed";
  }

  private persist(agentId: string, state: AgentOutboxState): boolean {
    try {
      this.durableWrite(path.join(this.options.dir, outboxFileName(agentId)), JSON.stringify(state));
      return true;
    } catch (err) {
      this.options.trace?.("daemon.runtime_outcome_outbox.write_failed", {
        agentId, error_class: err instanceof Error ? err.name : "unknown",
      }, "error");
      this.markUnreliable(agentId, "write_failed");
      return false;
    }
  }

  /** temp write -> fsync(temp) -> rename -> fsync(dir). Throws if any step fails (the temp file is removed). */
  private durableWrite(filePath: string, data: string): void {
    const dir = path.dirname(filePath);
    const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.fs.writeTempAndSync(tempPath, data);
      this.fs.rename(tempPath, filePath);
      this.fs.syncDir(dir);
    } catch (err) {
      rmSync(tempPath, { force: true });
      throw err;
    }
  }

  /**
   * Mark the agent unreliable: in memory at once, and durably via its marker
   * (`markerId` = an existing durable marker was found on load). If the
   * marker cannot be written the agent stays unreliable in memory, the
   * failure is reported, and the write is retried later.
   */
  private markUnreliable(agentId: string, cause: string, markerId?: string): void {
    let info = this.unreliable.get(agentId);
    const first = !info;
    if (!info) {
      info = { cause, markerId: markerId ?? null };
      this.unreliable.set(agentId, info);
    }
    if (info.markerId === null) this.writeMarker(agentId, info);
    if (!first) return;
    this.options.trace?.("daemon.runtime_outcome_outbox.unreliable", { agentId, cause, durable: info.markerId !== null }, "error");
    // Best effort, not queued: the storage that would queue it just failed.
    // Never to a known older server: it does not understand the frame (the
    // local refusal applies there all the same).
    if (this.capability === "old") return;
    try {
      this.options.send({
        type: "agent:runtime:outcome_unreliable",
        agentId,
        daemonInstanceId: this.options.daemonInstanceId,
        takeoverEpoch: this.state(agentId).takeoverEpoch,
      });
    } catch {
      // Nothing more to do; the local refusal already applies.
    }
  }

  private writeMarker(agentId: string, info: UnreliableInfo): void {
    const marker: UnreliableMarker = {
      v: 1,
      markerId: randomUUID(),
      agentId,
      since: (this.options.now ?? Date.now)(),
      cause: info.cause,
      daemonInstanceId: this.options.daemonInstanceId,
      takeoverEpoch: this.state(agentId).takeoverEpoch,
    };
    try {
      this.durableWrite(path.join(this.options.dir, markerFileName(agentId)), JSON.stringify(marker));
      info.markerId = marker.markerId;
    } catch (err) {
      this.options.trace?.("daemon.runtime_outcome_outbox.unreliable_marker_write_failed", {
        agentId, cause: info.cause, error_class: err instanceof Error ? err.name : "unknown",
      }, "error");
    }
  }

  /** Open entries of earlier daemon instances: their outcome is unknown until resolved. */
  private staleOpenEntries(agentId: string): { openLaunchIds: string[]; openProcessInstanceIds: string[] } {
    const record = this.openLaunches.get(agentId);
    const current = this.options.daemonInstanceId;
    return {
      openLaunchIds: (record?.requests ?? []).filter((entry) => entry.daemonInstanceId !== current).map((entry) => entry.launchId),
      openProcessInstanceIds: (record?.processes ?? []).filter((entry) => entry.daemonInstanceId !== current).map((entry) => entry.processInstanceId),
    };
  }

  private unresolvedCorruptFiles(agentId: string): string[] {
    const dir = this.options.dir;
    if (!existsSync(dir)) return [];
    const prefix = `${outboxFileName(agentId)}${CORRUPT_INFIX.slice(".json".length)}`;
    return readdirSync(dir).filter((name) => name.startsWith(prefix) && !name.endsWith(ARCHIVED_SUFFIX) && !name.includes(".tmp-"));
  }

  /**
   * The explicit recovery after an admitted human start: durably write the
   * resolution record FIRST, then remove the marker and archive the corrupt
   * files (a crash in between is finished by the next load). If the record
   * cannot be written the agent stays unreliable and this returns `failed`.
   */
  private resolveUnreliable(agentId: string, launchId: string | null): "resolved" | "not_needed" | "failed" {
    const info = this.unreliable.get(agentId);
    if (!info) return "not_needed";
    const dir = this.options.dir;
    const corruptFiles = this.unresolvedCorruptFiles(agentId);
    const record: UnreliableResolution = {
      v: 1,
      agentId,
      resolvedAt: (this.options.now ?? Date.now)(),
      launchId,
      daemonInstanceId: this.options.daemonInstanceId,
      markerId: info.markerId,
      cause: info.cause,
      corruptFiles,
      ...this.staleOpenEntries(agentId),
    };
    try {
      this.durableWrite(path.join(dir, resolutionFileName(agentId)), JSON.stringify(record));
    } catch (err) {
      this.options.trace?.("daemon.runtime_outcome_outbox.unreliable_resolution_write_failed", {
        agentId, error_class: err instanceof Error ? err.name : "unknown",
      }, "error");
      return "failed";
    }
    this.unreliable.delete(agentId);
    // After the durable record: the stale open entries it covers, then the marker (a crash in between is finished by load).
    const stale = this.staleOpenEntries(agentId);
    if (stale.openLaunchIds.length > 0 || stale.openProcessInstanceIds.length > 0) {
      const record = this.openLaunches.get(agentId)!;
      this.writeOpenLaunches(agentId, {
        ...record,
        requests: record.requests.filter((entry) => !stale.openLaunchIds.includes(entry.launchId)),
        processes: record.processes.filter((entry) => !stale.openProcessInstanceIds.includes(entry.processInstanceId)),
      }, { markOnFailure: false });
    }
    try {
      for (const name of corruptFiles) this.fs.rename(path.join(dir, name), path.join(dir, `${name}${ARCHIVED_SUFFIX}`));
      rmSync(path.join(dir, markerFileName(agentId)), { force: true });
      this.fs.syncDir(dir);
    } catch {
      // The resolution record is durable; the next load finishes the cleanup.
    }
    this.options.trace?.("daemon.runtime_outcome_outbox.unreliable_resolved", { agentId, launch_id: launchId, cause: info.cause });
    return "resolved";
  }
}
