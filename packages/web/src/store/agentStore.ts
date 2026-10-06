import { useSyncExternalStore } from "react";
import { create } from "zustand";
import api from "../api/client";
import { currentTimeMs, EXTERNAL_AGENT_ONLINE_WINDOW_MS, isExternalAgentRuntime, normalizeActivity, normalizeActivityDetailKind } from "@botiverse/raft-shared";
import type { AgentActivity, AgentActivityDetailKind, AgentHostedRuntimeSummary, ExternalAgentDiagnosticsView, AgentRuntimeErrorState, AgentRuntimeProviderKind, AgentStatus, DeliveryConsumptionActivityDiagnostic, ReasoningEffort, RuntimeConfig, RuntimeFormDefinitionRef, ServerRole, SpawnFailureActivityDiagnostic, TrajectoryEntry, WakeCrashLoopActivityDiagnostic } from "@botiverse/raft-shared";
import type { RuntimeFormV2SubmitRef } from "@botiverse/raft-runtime-form";
import { useServerStore } from "./serverStore";
import { registerServerReset } from "./serverResetRegistry";
import { en } from "../i18n/messages/en";
import { getActivityText } from "../utils/activity";
import { formatRelativeTime } from "../utils/relativeTime";
import { getPresenceClockNowMs, subscribePresenceClock } from "./presenceClock";
import { traceAgentActivityStoreDecision } from "../utils/webAgentActivityTrace";
import type { AgentActivityTraceJoin } from "../utils/webAgentActivityTrace";
import { emitStateViolationTrace } from "../utils/stateViolationTrace";
import { emitStateTransitionTrace } from "../utils/stateTransitionTrace";
import {
  applyAgentActivityEvent,
  makeActivityState,
} from "./events/agentActivityEvents";
import type {
  ActivityLogEntry,
  AgentActivityDomainState,
  AgentActivityJoinKeys,
  AgentActivityState,
  AgentActivityTransition,
  TrajectoryLogEntry,
} from "./events/agentActivityEvents";
import { notifyAllChannelMembersChanged } from "./channelMemberEvents";

// Re-export for consumers that previously imported from this file
export type { AgentActivity } from "@botiverse/raft-shared";
export type { TrajectoryEntry } from "@botiverse/raft-shared";

export interface Agent {
  id: string;
  serverId?: string;
  serverName?: string | null;
  serverSlug?: string | null;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  description: string | null;
  status: AgentStatus;
  model: string;
  runtime: string;
  external?: boolean;
  /**
   * External agents only: when the agent's credential was last seen (any
   * agent-API call or an open wake-hint stream). Online = seen within
   * `EXTERNAL_AGENT_ONLINE_WINDOW_MS`. Absent for managed agents.
   */
  lastSeenAt?: string | null;
  serverRole: ServerRole | null;
  runtimeConfig?: RuntimeConfig | null;
  lastRuntimeError?: AgentRuntimeErrorState | null;
  reasoningEffort: ReasoningEffort | null;
  executionMode: "byoc" | "cloud";
  envVars: Record<string, string> | null;
  machineId: string | null;
  sessionId?: string | null;
  runtimeProfile?: AgentRuntimeProfileSummary | null;
  /** External agents on a hosted runtime provider (antiproton): provisioning state, for managers only. */
  hostedRuntime?: AgentHostedRuntimeSummary | null;
  creatorType: "user" | "agent" | null;
  creatorId: string | null;
  creator: CreatorSummary | null;
  createdAgents: AgentCreatedSummary[];
  deletedAt: string | null;
  createdAt: string;
  /** Bounded public profile carried by a readable channel relation. */
  profileProjection?: "channel_summary";
}

export type OnboardingIdentityField = "name" | "displayName" | "role" | "serverRole" | "avatarUrl";

export interface OnboardingIdentityChange {
  field: OnboardingIdentityField;
  label: string;
  before: string | null;
  after: string | null;
}

export interface OnboardingIdentityAdoptionPreview {
  canAdopt: boolean;
  changes: OnboardingIdentityChange[];
  currentIdentity: Record<OnboardingIdentityField, string | null>;
  officialIdentity: Record<OnboardingIdentityField, string | null>;
}

export interface OnboardingIdentityAdoptionResult extends OnboardingIdentityAdoptionPreview {
  appliedChanges: OnboardingIdentityChange[];
  agent: Agent;
}

export type AgentRuntimeProfileMigrationStatus = "stable" | "pending" | "migrating";
export type AgentRuntimeProfilePendingKind = "migration" | "daemon_release_notice";

export interface AgentRuntimeProfileRef {
  label?: string | null;
  path?: string | null;
  machineId?: string | null;
  runtime?: string | null;
  reachable?: boolean | null;
  reason?: string | null;
}

export interface AgentRuntimeProfileSnapshot {
  runtimeProfileFingerprint?: string;
  daemonVersion?: string | null;
  machineId?: string | null;
  machineName?: string | null;
  runtime?: string | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  executionMode?: "byoc" | "cloud" | string | null;
  workspaceRef?: AgentRuntimeProfileRef | string | null;
  workspacePathRef?: AgentRuntimeProfileRef | string | null;
  sessionRef?: AgentRuntimeProfileRef | string | null;
  observedAt?: string | null;
}

export interface AgentRuntimeProfileChange {
  field: string;
  before?: unknown;
  after?: unknown;
}

export interface AgentRuntimeProfilePending {
  kind: AgentRuntimeProfilePendingKind;
  key: string;
  migratingSince?: string | null;
  lastNudgeAt?: string | null;
  nudgeCount?: number;
  before?: AgentRuntimeProfileSnapshot | null;
  after?: AgentRuntimeProfileSnapshot | null;
  changes?: AgentRuntimeProfileChange[];
  previousSessionRef?: AgentRuntimeProfileRef | string | null;
}

export interface AgentRuntimeProfileSummary {
  current?: AgentRuntimeProfileSnapshot | null;
  migrationStatus: AgentRuntimeProfileMigrationStatus;
  pending?: AgentRuntimeProfilePending | null;
}

export interface CreatorSummary {
  type: "human" | "agent";
  id: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  gravatarHash?: string;
  deletedAt?: string | null;
}

export interface AgentCreatedSummary {
  id: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  runtime: string;
  external?: boolean;
  status: AgentStatus;
}

export type ExternalAgentSetupState = "waiting_for_login" | "credential_minted" | "connected";

export interface ExternalAgentStatus {
  setupState: ExternalAgentSetupState;
  credentialLastUsedAt: string | null;
  lastActivityAt: string | null;
  hostedRuntime?: AgentHostedRuntimeSummary;
}

/** Shape returned by the API — may include activity fields used to seed agentActivities. */
type ApiAgent = Agent & {
  activity?: AgentActivity;
  activityKind?: AgentActivity;
  activityDetail?: string;
  activityDetailKind?: AgentActivityDetailKind;
  /** task #1116: served with activityDetailKind "delivery_unconsumed" so a refresh keeps the typed state. */
  deliveryConsumption?: DeliveryConsumptionActivityDiagnostic;
  /** task #1119: served with activityDetailKind "wake_crash_loop_blocked". */
  wakeCrashLoop?: WakeCrashLoopActivityDiagnostic;
  /** task #1123: served with activityDetailKind "runtime_unavailable" after a failed start. */
  spawnFailure?: SpawnFailureActivityDiagnostic;
};


export type { ActivityLogEntry, AgentActivityState, TrajectoryLogEntry } from "./events/agentActivityEvents";

export interface AgentDisplayState {
  activity: AgentActivity;
  activityDetail: string;
  activityDetailKind: AgentActivityDetailKind;
  activityText: string;
  isOnline: boolean;
  /** True for external agents — use neutral tone instead of managed liveness dot when not online. */
  isExternal?: boolean;
  /** External agents only: last time the agent was seen (ISO), if ever. */
  lastSeenAt?: string | null;
}

type AgentDisplayFallback = Pick<Agent, "status"> & Partial<Pick<Agent, "runtime" | "external" | "lastSeenAt">>;

/** Pure presence rule for external agents: seen within the online window. */
export function isExternalAgentSeenOnline(lastSeenAt: string | null | undefined, nowMs: number): boolean {
  if (!lastSeenAt) return false;
  const seenMs = Date.parse(lastSeenAt);
  if (Number.isNaN(seenMs)) return false;
  return nowMs - seenMs < EXTERNAL_AGENT_ONLINE_WINDOW_MS;
}

export function resolveAgentDisplayState(
  agent: (Pick<Agent, "status"> & Partial<Pick<Agent, "lastSeenAt">>) | null | undefined,
  activityState: AgentActivityState | null | undefined,
  isExternal?: boolean,
  nowMs: number = currentTimeMs(),
): AgentDisplayState {
  // External agents have no daemon: presence (credential seen within the
  // online window) is only the floor for agents that go silent. While seen,
  // the dot shows the same activity-derived state as a managed agent —
  // including an explicit "offline" (SessionEnd: the agent declared it
  // stopped), which shows offline immediately, as a managed agent does when
  // its daemon reports it; a newer activity event brings it back.
  if (isExternal) {
    const lastSeenAt = agent?.lastSeenAt ?? null;
    const isOnline = isExternalAgentSeenOnline(lastSeenAt, nowMs);
    if (isOnline && activityState) {
      return {
        activity: activityState.activity,
        activityDetail: activityState.activityDetail,
        activityDetailKind: activityState.detailKind,
        activityText: getActivityText(activityState.activity, activityState.activityDetail, activityState.detailKind),
        isOnline: activityState.activity !== "offline",
        isExternal: true,
        lastSeenAt,
      };
    }
    const relative = !isOnline ? formatRelativeTime(lastSeenAt, "en") : null;
    return {
      activity: isOnline ? "online" : "offline",
      activityDetail: "",
      activityDetailKind: "none",
      activityText: relative
        ? en["activity.status.lastActive"].replace("{time}", relative)
        : getActivityText(isOnline ? "online" : "offline"),
      isOnline,
      isExternal: true,
      lastSeenAt,
    };
  }
  const activity = activityState?.activity
    ?? (agent?.status === "active" ? "online" : "offline");
  const activityDetail = activityState?.activityDetail
    ?? (agent?.status === "stopped" ? en["activity.log.status.stopped"] : "");
  const detailKind = activityState?.detailKind
    ?? (agent?.status === "stopped" ? "stopped" : "none");
  return {
    activity,
    activityDetail,
    activityDetailKind: detailKind,
    activityText: getActivityText(activity, activityDetail, detailKind),
    isOnline: activity !== "offline",
  };
}

interface AgentState {
  agents: Agent[];
  /**
   * Internal materialized current-activity cache.
   * Components should consume selector/hook projections below instead of
   * reading this record directly.
   */
  agentActivities: Record<string, AgentActivityState>;
  /**
   * Transient trace-only equijoin data for the latest socket-rooted activity
   * render. This is deliberately kept out of activity/trajectory logs so the
   * opaque clientEventId cannot become persisted producer metadata.
   */
  agentActivityTraceJoins: Record<string, AgentActivityTraceJoin>;
  /**
   * Last observation timestamp used to update the status surface.
   * Activity Log entries can arrive via a separate trajectory stream;
   * this lets that stream fix stale idle badges without letting older
   * log replay clobber a newer non-idle socket push.
   */
  agentActivityObservedAt: Record<string, number>;
  /**
   * Local monotonic activity mutation counter. REST snapshots can race
   * socket pushes during reconnect: if an `agent:activity` push lands
   * while `/agents` is still in flight, the stale REST response must not
   * overwrite the fresher socket state.
   */
  agentActivityVersions: Record<string, number>;
  /**
   * Per-agent monotonic seq of the last applied `agent:activity`
   * push, used to drop out-of-order updates that arrive during
   * reconnect storms. Cleared on `socket.connect` (which also fires
   * `loadAgents()`) so server restarts don't false-reject. New
   * server emits include `serverSeq`; old servers omit it, in which
   * case we always apply (== pre-PR behaviour).
   * Introduced 2026-05-02 #engineering:72283cf7 task #340 PR B.
   */
  agentActivitySeq: Record<string, number>;
  /**
   * Per-agent launchId under which `agentActivitySeq` was last applied.
   * TRACKING ONLY — this does NOT gate the serverSeq dedup (the guard below is
   * unchanged). It exists so the store-decision trace can emit the closed-set
   * `launch_changed` / `same_launch` relation, letting a reader tell whether a
   * `stale_server_seq` drop coincided with a launch change. That distinguishes
   * a launch-scoped counter reset from ordinary within-launch reorder without
   * exposing raw ids/seqs (Q8). Provability instrumentation for #161; the
   * behavioural fix (if any) is decided separately once this proves the path.
   */
  agentActivityLaunchId: Record<string, string>;
  loading: boolean;
  showCreateAgent: boolean;
  createAgentOnboarding: boolean;
  activityLogs: Record<string, ActivityLogEntry[]>;
  trajectoryLogs: Record<string, TrajectoryLogEntry[]>;
  /**
   * Request generation for durable trajectory hydrates. Re-baseline events
   * reset seq space; any older in-flight hydrate must be dropped before it can
   * compare old-epoch serverSeq values against the new baseline.
   */
  trajectoryHydrateGeneration: number;
  setShowCreateAgent: (show: boolean, onboarding?: boolean) => void;
  loadAgents: () => Promise<void>;
  ensureAgentProfile: (agentId: string) => Promise<void>;
  /**
   * Reset the per-agent serverSeq tracking. Call this on
   * `socket.on("connect")` so the post-reconnect snapshot path
   * (`loadAgents()` + subsequent socket pushes) is not blocked by
   * stale seq numbers held over from before the disconnect.
   */
  resetActivitySeq: () => void;
  createAgent: (
    name: string,
    opts?: { description?: string; model?: string; runtime?: string; runtimeConfig?: RuntimeConfig; formDefinitionRef?: RuntimeFormDefinitionRef | RuntimeFormV2SubmitRef; formValues?: Record<string, unknown>; reasoningEffort?: ReasoningEffort; machineId?: string; envVars?: Record<string, string>; avatarUrl?: string; onboarding?: boolean; external?: boolean; provider?: AgentRuntimeProviderKind; actionCardMessageId?: string; actionCardConfirmationVersion?: number }
  ) => Promise<Agent>;
  fetchExternalAgentStatus: (agentId: string) => Promise<ExternalAgentStatus>;
  fetchExternalAgentDiagnostics: (agentId: string) => Promise<ExternalAgentDiagnosticsView>;
  retryHostedRuntimeProvisioning: (agentId: string) => Promise<AgentHostedRuntimeSummary | null>;
  fetchOnboardingIdentityAdoption: (agentId: string) => Promise<OnboardingIdentityAdoptionPreview>;
  adoptOnboardingIdentity: (agentId: string) => Promise<OnboardingIdentityAdoptionResult>;
  updateAgent: (
    agentId: string,
    fields: { displayName?: string | null; description?: string | null; avatarUrl?: string | null; serverRole?: Extract<ServerRole, "admin" | "member">; model?: string; runtime?: string; runtimeConfig?: RuntimeConfig | null; formDefinitionRef?: RuntimeFormDefinitionRef | RuntimeFormV2SubmitRef; formValues?: Record<string, unknown>; reasoningEffort?: ReasoningEffort | null; envVars?: Record<string, string> | null },
    opts?: { restartMode?: "restart" | "session" },
  ) => Promise<Agent>;
  startAgent: (agentId: string) => Promise<void>;
  stopAgent: (agentId: string) => Promise<void>;
  deleteAgent: (agentId: string) => Promise<void>;
  resetAgent: (agentId: string, mode: "restart" | "session" | "full") => Promise<void>;
  updateAgentSession: (agentId: string, sessionId: string | null) => void;
  /** `agent:seen` push: advance an external agent's `lastSeenAt` (never backwards). */
  applyAgentSeen: (agentId: string, lastSeenAt: string) => void;
  updateActivity: (
    agentId: string,
    activity: string,
    activityDetail?: string,
    serverSeq?: number,
    timestamp?: number,
    joinKeys?: { launchId?: string; clientSeq?: number; probeId?: string },
    activityKind?: string,
    detailKind?: string,
    traceJoin?: AgentActivityTraceJoin,
    isHeartbeat?: boolean,
    isRefreshOnly?: boolean,
    deliveryConsumption?: DeliveryConsumptionActivityDiagnostic,
    wakeCrashLoop?: WakeCrashLoopActivityDiagnostic,
    spawnFailure?: SpawnFailureActivityDiagnostic,
  ) => void;
  appendTrajectory: (
    agentId: string,
    entries: TrajectoryEntry[],
    timestamp?: number,
    joinKeys?: { launchId?: string; clientSeq?: number; probeId?: string },
    serverSeq?: number,
    traceJoin?: AgentActivityTraceJoin,
  ) => void;
  loadTrajectoryLog: (agentId: string, limit?: number) => Promise<void>;
  getActivityLog: (agentId: string) => ActivityLogEntry[];
  getTrajectoryLog: (agentId: string) => TrajectoryLogEntry[];
}

export function selectAgentCurrentActivityState(state: AgentState, agentId: string): AgentActivityState | undefined {
  return state.agentActivities[agentId];
}

export function selectAgentActivityTraceJoin(state: AgentState, agentId: string): AgentActivityTraceJoin | undefined {
  return state.agentActivityTraceJoins[agentId];
}

/**
 * Pure per-agent display-state compute over narrow slices. Components that
 * need MANY agents' display states must subscribe to the raw slices
 * (`s.agents`, `s.agentActivities` — stable references) and call this in
 * render. NEVER build a map of these inside a store selector: the result is
 * a fresh object per call, so even useShallow sees a changed snapshot every
 * time -> infinite re-render (React #185, prod incident 2026-07-07).
 */
/** Named stable slice export — components subscribe via this instead of
 *  naming the raw field (agentActivityStoreBoundary ratchet). Returns the
 *  store-held reference, so it is snapshot-stable by construction. */
export const selectAgentActivitiesSlice = (state: AgentState): Record<string, AgentActivityState> => state.agentActivities;

export function computeAgentDisplayState(
  agents: Agent[],
  agentActivities: Record<string, AgentActivityState>,
  agentId: string,
  fallbackAgent?: AgentDisplayFallback | null,
  nowMs: number = currentTimeMs(),
): AgentDisplayState {
  const agent = agents.find((candidate) => candidate.id === agentId) ?? fallbackAgent;
  const isExternal = agent?.external === true || isExternalAgentRuntime(agent?.runtime);
  return resolveAgentDisplayState(agent, agentActivities[agentId], isExternal, nowMs);
}

export function selectAgentDisplayState(
  state: AgentState,
  agentId: string,
  fallbackAgent?: AgentDisplayFallback | null,
  nowMs: number = currentTimeMs(),
): AgentDisplayState {
  return computeAgentDisplayState(state.agents, state.agentActivities, agentId, fallbackAgent, nowMs);
}

/**
 * Module-level in-flight guard for `loadAgents()`. Multiple
 * concurrent calls (e.g. socket-reconnect storm firing several
 * `connect` events in quick succession) coalesce onto the same
 * Promise, preventing the REST response from racing with newer
 * socket pushes. Cleared after each settled fetch.
 * (#engineering:72283cf7 task #340 PR B)
 */
let loadAgentsInFlight: Promise<void> | null = null;

/**
 * Re-read the agent list after the server says a stored agent changed.
 * `loadAgents()` joins a read that is already in flight, and that read may have
 * been answered before the change. So when one is in flight, wait for it and
 * read once more; several pushes during the same wait share that one extra read.
 */
export function reloadAgentsAfterServerChange(): Promise<void> {
  const stale = loadAgentsInFlight;
  if (!stale) return useAgentStore.getState().loadAgents();
  const reload = () => useAgentStore.getState().loadAgents();
  return stale.then(reload, reload);
}
const agentProfileInFlight = new Map<string, Promise<void>>();
let agentActivityReconcileScheduled = false;

function nextActivityVersion(state: Pick<AgentState, "agentActivityVersions">, agentId: string): number {
  return (state.agentActivityVersions[agentId] ?? 0) + 1;
}

function stripActivityFields(agent: ApiAgent): Agent {
  const { activity: _a, activityKind: _ak, activityDetail: _d, activityDetailKind: _dk, deliveryConsumption: _dc, wakeCrashLoop: _wcl, spawnFailure: _sf, ...rest } = agent;
  return rest;
}

/**
 * task #1116 / #1119: REST snapshots carry a typed carrier only with its own
 * activityDetailKind; attach each there and nowhere else.
 */
function withTypedCarriers(
  state: AgentActivityState,
  carriers: { deliveryConsumption?: DeliveryConsumptionActivityDiagnostic; wakeCrashLoop?: WakeCrashLoopActivityDiagnostic; spawnFailure?: SpawnFailureActivityDiagnostic },
): AgentActivityState {
  if (state.detailKind === "delivery_unconsumed" && carriers.deliveryConsumption) {
    return { ...state, deliveryConsumption: carriers.deliveryConsumption };
  }
  if (state.detailKind === "wake_crash_loop_blocked" && carriers.wakeCrashLoop) {
    return { ...state, wakeCrashLoop: carriers.wakeCrashLoop };
  }
  // task #1123: the daemon's typed spawn-failure reason rides runtime_unavailable.
  if (state.detailKind === "runtime_unavailable" && carriers.spawnFailure) {
    return { ...state, spawnFailure: carriers.spawnFailure };
  }
  return state;
}


function clearAgentActivityTraceJoin(
  traceJoins: Record<string, AgentActivityTraceJoin>,
  agentId: string,
): Record<string, AgentActivityTraceJoin> {
  if (traceJoins[agentId] === undefined) return traceJoins;
  const { [agentId]: _cleared, ...rest } = traceJoins;
  return rest;
}

function agentStateTransitionOutcome(transition: AgentActivityTransition): "applied" | "noop" | "conflict" {
  if (transition.outcome === "producer_seq_conflict") return "conflict";
  if (transition.outcome === "applied" || transition.outcome === "logged") return "applied";
  return "noop";
}

/**
 * Structural sharing for the agents list. `loadAgents()` runs not only on
 * initial load but also on the 60s periodic status reconcile (#2616 / CC-006
 * client side) and on focus refetch — each fetch builds a brand-new array of
 * brand-new objects. Swapping the `agents` reference on every reconcile, even
 * when nothing changed, churns every `agents`-derived selector (e.g. ChatPanel's
 * mentionMap / agentById) by reference → breaks `MessageItem`'s `memo()` → the
 * whole message list re-renders and re-parses markdown. Reuse the previous array
 * (and per-element references) whenever the freshly-fetched data is deep-equal,
 * so a no-op reconcile yields zero re-renders while a real status/identity change
 * still propagates. (#proj-o11y / #wg-frontend-perf message-list re-render storm.)
 */
/**
 * The keys `agentRecordEqual` compares. task #633.
 *
 * An explicit key set whose COMPLETENESS is compiler-checked: the annotation is
 * `Record<keyof Agent, true>`, so adding a field to `Agent` without listing it
 * here fails to compile. (It is an explicit list, not a generated one — Stone,
 * PR #8125 review.) That turns a silent omission into a build error.
 *
 * Keys absent from this record are ignored: the server may send fields the web
 * does not model, and those must not decide whether a row counts as changed.
 */
/**
 * `keyof Agent` — but only while `Agent`'s keys are a finite literal union.
 *
 * @Tenny, PR #8125 review: if someone ever adds an index signature to `Agent`,
 * `keyof Agent` collapses to `string`, `Record<string, true>` accepts any keys
 * and requires none, and `AGENT_COMPARED_KEYS` stops checking completeness —
 * with `tsc` still green. The lock would still be in the source and no longer
 * lock anything, which is the silent failure this whole card is about.
 *
 * So the precondition is checked too: adding an index signature turns this into
 * a tuple, which does not satisfy `Record`'s key constraint, and the error lands
 * on the declaration below with the sentence naming what broke.
 */
type AgentComparedKey = string extends keyof Agent
  ? ["Agent gained an index signature, so AGENT_COMPARED_KEYS no longer checks completeness"]
  : keyof Agent;

const AGENT_COMPARED_KEYS: Record<AgentComparedKey, true> = {
  id: true,
  serverId: true,
  serverName: true,
  serverSlug: true,
  name: true,
  displayName: true,
  avatarUrl: true,
  description: true,
  status: true,
  model: true,
  runtime: true,
  external: true,
  lastSeenAt: true,
  serverRole: true,
  runtimeConfig: true,
  lastRuntimeError: true,
  reasoningEffort: true,
  executionMode: true,
  envVars: true,
  machineId: true,
  sessionId: true,
  runtimeProfile: true,
  hostedRuntime: true,
  creatorType: true,
  creatorId: true,
  creator: true,
  createdAgents: true,
  deletedAt: true,
  createdAt: true,
  profileProjection: true,
};

const AGENT_COMPARED_KEY_LIST = Object.keys(AGENT_COMPARED_KEYS) as (keyof Agent)[];

function agentRecordEqual(a: Agent, b: Agent): boolean {
  if (a === b) return true;
  // task #633. This used to walk whatever keys were on the record, so a
  // server-added field could force a swap two ways: key counts differing once
  // during a rollout, and — the one that fires repeatedly — its value flipping
  // in steady state while the web does not model it at all. Neither is visible:
  // no error, no red test, just more re-renders.
  for (const k of AGENT_COMPARED_KEY_LIST) {
    const va = a[k];
    const vb = b[k];
    if (va === vb) continue;
    if (va && vb && typeof va === "object" && typeof vb === "object") {
      if (JSON.stringify(va) !== JSON.stringify(vb)) return false;
    } else {
      return false;
    }
  }
  return true;
}

function isNewerTimestamp(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  return Date.parse(a) > Date.parse(b);
}

export function reconcileAgentsList(prev: Agent[], next: Agent[]): Agent[] {
  const prevById = new Map(prev.map((a) => [a.id, a]));
  const reconciled = next.map((incoming) => {
    const p = prevById.get(incoming.id);
    // `lastSeenAt` only moves forward: an `agent:seen` push may land while a
    // `/agents` snapshot carrying the older value is still in flight.
    const n = p && incoming.lastSeenAt !== undefined && isNewerTimestamp(p.lastSeenAt, incoming.lastSeenAt)
      ? { ...incoming, lastSeenAt: p.lastSeenAt }
      : incoming;
    return p && agentRecordEqual(p, n) ? p : n;
  });
  // If every element resolved to the previous reference in the same order, the
  // list is unchanged — return the prior array so subscribers don't re-render.
  if (reconciled.length === prev.length && reconciled.every((a, i) => a === prev[i])) {
    return prev;
  }
  return reconciled;
}

function pickAgentActivityDomainState(state: AgentState): AgentActivityDomainState {
  return {
    agentActivities: state.agentActivities,
    agentActivityTraceJoins: state.agentActivityTraceJoins,
    agentActivityObservedAt: state.agentActivityObservedAt,
    agentActivityVersions: state.agentActivityVersions,
    agentActivitySeq: state.agentActivitySeq,
    agentActivityLaunchId: state.agentActivityLaunchId,
    activityLogs: state.activityLogs,
    trajectoryLogs: state.trajectoryLogs,
  };
}

function applyAgentActivityDomainPatch(state: AgentState, next: AgentActivityDomainState): Partial<AgentState> {
  return {
    agentActivities: next.agentActivities,
    agentActivityTraceJoins: next.agentActivityTraceJoins,
    agentActivityObservedAt: next.agentActivityObservedAt,
    agentActivityVersions: next.agentActivityVersions,
    agentActivitySeq: next.agentActivitySeq,
    agentActivityLaunchId: next.agentActivityLaunchId,
    activityLogs: next.activityLogs,
    trajectoryLogs: next.trajectoryLogs,
  };
}

function traceAgentActivityTransition(
  state: AgentState,
  transition: AgentActivityTransition,
  input: {
    activity?: string;
    activityKind?: string;
    detail?: string;
    detailKind?: string;
    joinKeys?: AgentActivityJoinKeys;
    traceJoin?: AgentActivityTraceJoin;
    isHeartbeat?: boolean;
    isRefreshOnly?: boolean;
  } = {},
): void {
  const arrivedAtMs = input.traceJoin?.arrivedAtMs;
  emitStateTransitionTrace({
    domain: "agents",
    event: transition.event,
    entityId: transition.agentId,
    touched: transition.touched,
    outcome: agentStateTransitionOutcome(transition),
    outcomeDetail: transition.outcome,
    reconcileSuggested: transition.reconcileSuggested,
    seq: transition.serverSeq,
    timestamp: transition.timestamp,
    arrivalToAppliedMs: arrivedAtMs === undefined ? undefined : Math.max(0, Date.now() - arrivedAtMs),
    join: input.traceJoin,
  });
  if (transition.outcome === "producer_seq_conflict") {
    const basis = transition.violationBasis!;
    emitStateViolationTrace({
      domain: "agents",
      entityId: transition.agentId,
      violationKind: "producer_seq_conflict",
      epoch: state.trajectoryHydrateGeneration,
      same_activity: basis.same_activity,
      same_detail_kind: basis.same_detail_kind,
      same_detail_presence: basis.same_detail_presence,
      same_detail_bucket: basis.same_detail_bucket,
      event: transition.event,
      outcomeDetail: transition.outcome,
      serverSeq: transition.serverSeq,
      timestamp: transition.timestamp,
      currentActivity: basis.currentActivity,
      projectedActivity: basis.projectedActivity,
      currentDetailKind: basis.currentDetailKind,
      projectedDetailKind: basis.projectedDetailKind,
      join: input.traceJoin,
    });
    return;
  }
  if (transition.outcome !== "applied" && transition.outcome !== "stale_server_seq" && transition.outcome !== "invalid_activity") return;
  traceAgentActivityStoreDecision({
    agentId: transition.agentId,
    activity: transition.nextActivity ?? input.activity,
    activityKind: transition.nextActivity ?? input.activityKind ?? input.activity,
    detail: input.detail,
    detailKind: input.detailKind,
    serverSeq: transition.serverSeq,
    timestamp: transition.timestamp,
    isHeartbeat: input.isHeartbeat,
    isRefreshOnly: input.isRefreshOnly,
    ...input.joinKeys,
    join: input.traceJoin,
    lastServerSeq: transition.agentId ? state.agentActivitySeq[transition.agentId] : undefined,
    lastLaunchId: transition.agentId ? state.agentActivityLaunchId[transition.agentId] : undefined,
    previousActivity: transition.previousActivity ?? null,
    nextActivity: transition.nextActivity ?? null,
    outcome: transition.outcome,
  });
}

function scheduleAgentActivityReconcile(): void {
  if (agentActivityReconcileScheduled) return;
  agentActivityReconcileScheduled = true;
  void Promise.resolve().then(() => {
    agentActivityReconcileScheduled = false;
    return useAgentStore.getState().loadAgents();
  });
}

export const useAgentStore = create<AgentState>((set, get) => ({
  showCreateAgent: false,
  createAgentOnboarding: false,
  setShowCreateAgent: (show, onboarding = false) =>
    set({
      showCreateAgent: show,
      createAgentOnboarding: show ? onboarding : false,
    }),
  agents: [],
  agentActivities: {},
  agentActivityTraceJoins: {},
  agentActivityObservedAt: {},
  agentActivityVersions: {},
  agentActivitySeq: {},
  agentActivityLaunchId: {},
  loading: true,
  activityLogs: {},
  trajectoryLogs: {},
  trajectoryHydrateGeneration: 0,

  loadAgents: async () => {
    // In-flight guard: when the socket reconnects in a flap, `connect`
    // can fire multiple times rapidly. Each call into `loadAgents`
    // would otherwise produce a parallel REST request whose response
    // races the live socket pushes — a slow response can clobber a
    // newer pushed activity. Coalesce concurrent calls onto a single
    // promise. (#engineering:72283cf7 task #340 PR B.)
    if (loadAgentsInFlight) return loadAgentsInFlight;
    const epoch = useServerStore.getState().serverEpoch;
    const serverId = useServerStore.getState().current?.id;
    if (!serverId) return;
    const agentIdsAtRequest = new Set(get().agents.map((agent) => agent.id));
    const activityVersionsAtRequest = { ...get().agentActivityVersions };
    // Never set loading here — it starts as true (store init / server reset)
    // and goes to false after the first successful fetch. This keeps existing
    // data (or a legitimate empty state) visible during refreshes.
    loadAgentsInFlight = (async () => {
      try {
        const { data } = await api.get("/agents");
        if (useServerStore.getState().serverEpoch !== epoch) return;
        const apiAgents = data as ApiAgent[];
        const agents = apiAgents.map(stripActivityFields);
        const snapshotActivities: Record<string, AgentActivityState> = {};
        const snapshotObservedAt = Date.now();
        for (const a of apiAgents) {
          snapshotActivities[a.id] = withTypedCarriers({
            activity: normalizeActivity(a.activityKind ?? a.activity, a.status),
            activityDetail: a.activityDetail || "",
            detailKind: normalizeActivityDetailKind(a.activityDetailKind),
          }, a);
        }
        // The REST snapshot is authoritative for the moment of fetch;
        // reset per-agent seq tracking so future socket pushes are
        // accepted as long as they're monotonically newer.
        set((state) => {
          const agentActivities: Record<string, AgentActivityState> = {};
          const agentActivityTraceJoins: Record<string, AgentActivityTraceJoin> = {};
          const agentActivityObservedAt: Record<string, number> = {};
          const agentActivityVersions: Record<string, number> = {};
          const snapshotAgentIds = new Set(agents.map((agent) => agent.id));
          const locallyAddedAgents = state.agents.filter((agent) =>
            !agentIdsAtRequest.has(agent.id) && !snapshotAgentIds.has(agent.id)
          );
          for (const a of apiAgents) {
            const requestVersion = activityVersionsAtRequest[a.id] ?? 0;
            const currentVersion = state.agentActivityVersions[a.id] ?? 0;
            if (currentVersion > requestVersion && state.agentActivities[a.id]) {
              agentActivities[a.id] = state.agentActivities[a.id];
              if (state.agentActivityTraceJoins[a.id]) {
                agentActivityTraceJoins[a.id] = state.agentActivityTraceJoins[a.id];
              }
              agentActivityObservedAt[a.id] = state.agentActivityObservedAt[a.id] ?? snapshotObservedAt;
              agentActivityVersions[a.id] = currentVersion;
            } else {
              agentActivities[a.id] = snapshotActivities[a.id];
              agentActivityObservedAt[a.id] = snapshotObservedAt;
              agentActivityVersions[a.id] = currentVersion;
            }
          }
          for (const a of locallyAddedAgents) {
            if (state.agentActivities[a.id]) {
              agentActivities[a.id] = state.agentActivities[a.id];
              if (state.agentActivityTraceJoins[a.id]) {
                agentActivityTraceJoins[a.id] = state.agentActivityTraceJoins[a.id];
              }
              agentActivityObservedAt[a.id] = state.agentActivityObservedAt[a.id] ?? snapshotObservedAt;
              agentActivityVersions[a.id] = state.agentActivityVersions[a.id] ?? 0;
            }
          }
          return {
            agents: reconcileAgentsList(state.agents, [...agents, ...locallyAddedAgents]),
            agentActivities,
            agentActivityTraceJoins,
            agentActivityObservedAt,
            agentActivityVersions,
            agentActivitySeq: {},
            agentActivityLaunchId: {},
            trajectoryHydrateGeneration: state.trajectoryHydrateGeneration + 1,
            loading: false,
          };
        });
      } catch (err) {
        console.error("Failed to load agents:", err);
        if (useServerStore.getState().serverEpoch !== epoch) return;
        set({ loading: false });
      }
    })();
    try {
      await loadAgentsInFlight;
    } finally {
      loadAgentsInFlight = null;
    }
  },

  ensureAgentProfile: async (agentId) => {
    if (!agentId || get().agents.some((agent) => agent.id === agentId)) return;
    const existing = agentProfileInFlight.get(agentId);
    if (existing) return existing;
    const promise = (async () => {
      try {
        const { data } = await api.get(`/agents/${agentId}`);
        const apiAgent = data as ApiAgent;
        const agent = stripActivityFields(apiAgent);
        const observedAt = Date.now();
        const snapshotActivity = withTypedCarriers(makeActivityState(
          normalizeActivity(apiAgent.activityKind ?? apiAgent.activity, apiAgent.status),
          apiAgent.activityDetail || "",
          normalizeActivityDetailKind(apiAgent.activityDetailKind),
        ), apiAgent);
        set((state) => {
          const currentAgents = state.agents.filter((candidate) => candidate.id !== agent.id);
          const next: Partial<AgentState> = {
            agents: reconcileAgentsList(state.agents, [...currentAgents, agent]),
            loading: false,
          };
          if (!state.agentActivities[agent.id]) {
            next.agentActivities = { ...state.agentActivities, [agent.id]: snapshotActivity };
            next.agentActivityTraceJoins = clearAgentActivityTraceJoin(state.agentActivityTraceJoins, agent.id);
            next.agentActivityObservedAt = { ...state.agentActivityObservedAt, [agent.id]: observedAt };
            next.agentActivityVersions = { ...state.agentActivityVersions, [agent.id]: state.agentActivityVersions[agent.id] ?? 0 };
          }
          return next;
        });
      } catch (err) {
        console.error(`Failed to load agent profile ${agentId}:`, err);
      }
    })();
    agentProfileInFlight.set(agentId, promise);
    try {
      await promise;
    } finally {
      agentProfileInFlight.delete(agentId);
    }
  },

  resetActivitySeq: () => set((state) => ({
    agentActivitySeq: {},
    agentActivityLaunchId: {},
    agentActivityTraceJoins: {},
    trajectoryHydrateGeneration: state.trajectoryHydrateGeneration + 1,
  })),

  createAgent: async (name, opts = {}) => {
    const { data } = await api.post("/agents", {
      name,
      description: opts.description,
      model: opts.model,
      runtime: opts.runtime,
      runtimeConfig: opts.runtimeConfig,
      formDefinitionRef: opts.formDefinitionRef,
      ...(opts.formValues ? { formValues: opts.formValues } : {}),
      reasoningEffort: opts.reasoningEffort,
      machineId: opts.machineId,
      envVars: opts.envVars,
      avatarUrl: opts.avatarUrl,
      onboarding: opts.onboarding,
      external: opts.external,
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.actionCardMessageId ? { actionCardMessageId: opts.actionCardMessageId } : {}),
      ...(opts.actionCardConfirmationVersion !== undefined ? { actionCardConfirmationVersion: opts.actionCardConfirmationVersion } : {}),
    });
    const { activity: rawActivity, activityKind: rawActivityKind, activityDetail: rawDetail, activityDetailKind: rawDetailKind, deliveryConsumption: rawDeliveryConsumption, wakeCrashLoop: rawWakeCrashLoop, spawnFailure: rawSpawnFailure, ...rest } = data as ApiAgent;
    const agent: Agent = rest;
    set((state) => ({
      agents: [...state.agents, agent],
      agentActivities: {
        ...state.agentActivities,
        [agent.id]: withTypedCarriers({
          activity: normalizeActivity(rawActivityKind ?? rawActivity, agent.status),
          activityDetail: rawDetail || "",
          detailKind: normalizeActivityDetailKind(rawDetailKind),
        }, { deliveryConsumption: rawDeliveryConsumption, wakeCrashLoop: rawWakeCrashLoop, spawnFailure: rawSpawnFailure }),
      },
      agentActivityTraceJoins: clearAgentActivityTraceJoin(state.agentActivityTraceJoins, agent.id),
      agentActivityObservedAt: {
        ...state.agentActivityObservedAt,
        [agent.id]: Date.now(),
      },
      agentActivityVersions: {
        ...state.agentActivityVersions,
        [agent.id]: nextActivityVersion(state, agent.id),
      },
    }));
    notifyAllChannelMembersChanged();
    return agent;
  },

  fetchExternalAgentStatus: async (agentId) => {
    const { data } = await api.get(`/agents/${agentId}/external-status`);
    return data as ExternalAgentStatus;
  },

  fetchExternalAgentDiagnostics: async (agentId) => {
    const { data } = await api.get(`/agents/${agentId}/external-diagnostics`);
    return data as ExternalAgentDiagnosticsView;
  },

  retryHostedRuntimeProvisioning: async (agentId) => {
    const { data } = await api.post(`/agents/${agentId}/hosted-runtime/retry`);
    const hostedRuntime = (data as { hostedRuntime?: AgentHostedRuntimeSummary | null }).hostedRuntime ?? null;
    set((state) => ({
      agents: state.agents.map((agent) => agent.id === agentId ? { ...agent, hostedRuntime } : agent),
    }));
    return hostedRuntime;
  },

  fetchOnboardingIdentityAdoption: async (agentId) => {
    const { data } = await api.get(`/agents/${agentId}/onboarding-identity-adoption`);
    return data as OnboardingIdentityAdoptionPreview;
  },

  adoptOnboardingIdentity: async (agentId) => {
    const { data } = await api.post(`/agents/${agentId}/onboarding-identity-adoption`);
    const result = data as OnboardingIdentityAdoptionResult;
    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === agentId ? { ...a, ...result.agent } : a
      ),
    }));
    return result;
  },

  updateAgent: async (agentId, fields, opts) => {
    const { data } = await api.patch(`/agents/${agentId}`, {
      ...fields,
      ...(opts?.restartMode ? { restartMode: opts.restartMode } : {}),
    });
    set((state) => ({
      ...(() => {
        if (opts?.restartMode !== "session") {
          return {};
        }
        const { [agentId]: _activityLog, ...nextActivityLogs } = state.activityLogs;
        const { [agentId]: _trajectoryLog, ...nextTrajectoryLogs } = state.trajectoryLogs;
        return {
          activityLogs: nextActivityLogs,
          trajectoryLogs: nextTrajectoryLogs,
        };
      })(),
      agents: state.agents.map((a) =>
        a.id === agentId ? { ...a, ...data } : a
      ),
    }));
    return data;
  },

  startAgent: async (agentId) => {
    await api.post(`/agents/${agentId}/start`);
    // Only optimistically update if agent was offline — avoid overriding real state
    set((state) => {
      const current = state.agentActivities[agentId];
      const agents = state.agents.map((a) =>
        a.id === agentId ? { ...a, status: "active" as const } : a
      );
      if (current?.activity !== "offline") {
        return { agents };
      }
      return {
        agents,
        agentActivities: {
          ...state.agentActivities,
          [agentId]: makeActivityState("working", "", "starting"),
        },
        agentActivityTraceJoins: clearAgentActivityTraceJoin(state.agentActivityTraceJoins, agentId),
        agentActivityObservedAt: {
          ...state.agentActivityObservedAt,
          [agentId]: Date.now(),
        },
        agentActivityVersions: {
          ...state.agentActivityVersions,
          [agentId]: nextActivityVersion(state, agentId),
        },
      };
    });
    notifyAllChannelMembersChanged();
  },

  stopAgent: async (agentId) => {
    await api.post(`/agents/${agentId}/stop`);
    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === agentId ? { ...a, status: "stopped" as const } : a
      ),
      agentActivities: {
        ...state.agentActivities,
        [agentId]: makeActivityState("offline", en["activity.log.status.stopped"], "stopped"),
      },
      agentActivityTraceJoins: clearAgentActivityTraceJoin(state.agentActivityTraceJoins, agentId),
      agentActivityObservedAt: {
        ...state.agentActivityObservedAt,
        [agentId]: Date.now(),
      },
      agentActivityVersions: {
        ...state.agentActivityVersions,
        [agentId]: nextActivityVersion(state, agentId),
      },
    }));
  },

  deleteAgent: async (agentId) => {
    await api.delete(`/agents/${agentId}`);
    set((state) => {
      const { [agentId]: _, ...restActivities } = state.agentActivities;
      const { [agentId]: _traceJoin, ...restTraceJoins } = state.agentActivityTraceJoins;
      const { [agentId]: _observedAt, ...restObservedAt } = state.agentActivityObservedAt;
      const { [agentId]: _version, ...restVersions } = state.agentActivityVersions;
      return {
        agents: state.agents.map((a) =>
          a.id === agentId ? { ...a, deletedAt: new Date().toISOString(), status: "inactive" as const } : a
        ),
        agentActivities: restActivities,
        agentActivityTraceJoins: restTraceJoins,
        agentActivityObservedAt: restObservedAt,
        agentActivityVersions: restVersions,
      };
    });
  },

  resetAgent: async (agentId, mode: "restart" | "session" | "full") => {
    await api.post(`/agents/${agentId}/reset`, { mode });
    set((state) => ({
      ...(() => {
        if (mode === "restart") {
          return {};
        }
        const { [agentId]: _activityLog, ...nextActivityLogs } = state.activityLogs;
        const { [agentId]: _trajectoryLog, ...nextTrajectoryLogs } = state.trajectoryLogs;
        return {
          activityLogs: nextActivityLogs,
          trajectoryLogs: nextTrajectoryLogs,
        };
      })(),
      agents: state.agents.map((a) =>
        a.id === agentId
          ? { ...a, status: "active" as const, ...(mode === "restart" ? {} : { sessionId: null }) }
          : a
      ),
      agentActivities: {
        ...state.agentActivities,
        [agentId]: makeActivityState("working", "", "starting"),
      },
      agentActivityTraceJoins: clearAgentActivityTraceJoin(state.agentActivityTraceJoins, agentId),
      agentActivityObservedAt: {
        ...state.agentActivityObservedAt,
        [agentId]: Date.now(),
      },
    }));
  },

  updateAgentSession: (agentId, sessionId) => set((state) => {
    const current = state.agents.find((agent) => agent.id === agentId);
    // Repeated socket snapshots must preserve the agents array identity: its
    // consumers include every rendered agent message in the current timeline.
    if (!current || current.sessionId === sessionId) return {};
    return {
      agents: state.agents.map((agent) =>
        agent.id === agentId ? { ...agent, sessionId } : agent
      ),
    };
  }),

  applyAgentSeen: (agentId, lastSeenAt) => set((state) => {
    const current = state.agents.find((agent) => agent.id === agentId);
    if (!current || !isNewerTimestamp(lastSeenAt, current.lastSeenAt)) return {};
    return {
      agents: state.agents.map((agent) =>
        agent.id === agentId ? { ...agent, lastSeenAt } : agent
      ),
    };
  }),

  updateActivity: (agentId, activity, activityDetail = "", serverSeq, timestamp = Date.now(), joinKeys, activityKind, detailKind, traceJoin, isHeartbeat, isRefreshOnly, deliveryConsumption, wakeCrashLoop, spawnFailure) =>
    set((state) => {
      const { state: next, transition } = applyAgentActivityEvent(pickAgentActivityDomainState(state), {
        kind: "patch:socket-activity",
        agentId,
        activity,
        activityDetail,
        serverSeq,
        timestamp,
        joinKeys,
        traceJoin,
        activityKind,
        detailKind,
        isHeartbeat,
        isRefreshOnly,
        ...(deliveryConsumption ? { deliveryConsumption } : {}),
        ...(wakeCrashLoop ? { wakeCrashLoop } : {}),
        ...(spawnFailure ? { spawnFailure } : {}),
      });
      traceAgentActivityTransition(state, transition, { activity, activityKind, detail: activityDetail, detailKind, joinKeys, traceJoin, isHeartbeat, isRefreshOnly });
      if (transition.reconcileSuggested) scheduleAgentActivityReconcile();
      return transition.touched === 0 ? {} : applyAgentActivityDomainPatch(state, next);
    }),

  appendTrajectory: (agentId, entries, timestamp = Date.now(), joinKeys, serverSeq, traceJoin) =>
    set((state) => {
      const { state: next, transition } = applyAgentActivityEvent(pickAgentActivityDomainState(state), {
        kind: "patch:trajectory-append",
        agentId,
        entries,
        timestamp,
        serverSeq,
        joinKeys,
        traceJoin,
      });
      traceAgentActivityTransition(state, transition, { joinKeys, traceJoin });
      if (transition.reconcileSuggested) scheduleAgentActivityReconcile();
      return transition.touched === 0 ? {} : applyAgentActivityDomainPatch(state, next);
    }),

  loadTrajectoryLog: async (agentId, limit = 50) => {
    const hydrateGeneration = get().trajectoryHydrateGeneration;
    let incoming: TrajectoryLogEntry[];
    try {
      const { data } = await api.get(`/agents/${agentId}/activity-log`, { params: { limit } });
      incoming = data as TrajectoryLogEntry[];
    } catch (err) {
      console.error(`Failed to load trajectory log for agent ${agentId}:`, err);
      if (get().trajectoryHydrateGeneration !== hydrateGeneration) return;
      set((state) => ({
        trajectoryLogs: {
          ...state.trajectoryLogs,
          [agentId]: state.trajectoryLogs[agentId] || [],
        },
      }));
      return;
    }
    set((state) => {
      if (state.trajectoryHydrateGeneration !== hydrateGeneration) return {};
      const { state: next, transition } = applyAgentActivityEvent(pickAgentActivityDomainState(state), {
        kind: "hydrate:trajectory-log",
        agentId,
        entries: incoming,
      });
      traceAgentActivityTransition(state, transition);
      if (transition.reconcileSuggested) scheduleAgentActivityReconcile();
      return transition.touched === 0 ? {} : applyAgentActivityDomainPatch(state, next);
    });
  },

  getActivityLog: (agentId) => get().activityLogs[agentId] || [],

  getTrajectoryLog: (agentId) => get().trajectoryLogs[agentId] || [],
}));

const getConstantPresenceSnapshot = () => 0;
const subscribeNoPresenceClock = () => () => {};

export function useAgentDisplayState(
  agentId: string,
  fallbackAgent?: AgentDisplayFallback | null,
): AgentDisplayState {
  const agentFromStore = useAgentStore((state) => state.agents.find((agent) => agent.id === agentId));
  const activityState = useAgentCurrentActivityState(agentId);
  const agent = agentFromStore ?? fallbackAgent;
  const isExternal = agent?.external === true || isExternalAgentRuntime(agent?.runtime);
  // External presence is time-derived: follow the shared presence clock.
  // Managed agents read a constant snapshot, so they never re-render from it.
  const nowMs = useSyncExternalStore(
    isExternal ? subscribePresenceClock : subscribeNoPresenceClock,
    isExternal ? getPresenceClockNowMs : getConstantPresenceSnapshot,
    getConstantPresenceSnapshot,
  );
  return resolveAgentDisplayState(agent, activityState, isExternal, isExternal ? nowMs : undefined);
}

export function useAgentCurrentActivityState(agentId: string): AgentActivityState | undefined {
  return useAgentStore((state) => selectAgentCurrentActivityState(state, agentId));
}

export function useAgentActivityTraceJoin(agentId: string): AgentActivityTraceJoin | undefined {
  return useAgentStore((state) => selectAgentActivityTraceJoin(state, agentId));
}

// Reset all server-scoped state when the user switches servers.
registerServerReset(() =>
  useAgentStore.setState({
    agents: [],
    agentActivities: {},
    agentActivityTraceJoins: {},
    agentActivityObservedAt: {},
    agentActivityVersions: {},
    agentActivitySeq: {},
    agentActivityLaunchId: {},
    loading: true,
    showCreateAgent: false,
    createAgentOnboarding: false,
    activityLogs: {},
    trajectoryLogs: {},
    trajectoryHydrateGeneration: 0,
  })
);
