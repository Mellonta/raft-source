import { EventEmitter } from "node:events";
import { closeConnectionsForDrain, MACHINE_DRAIN_CLOSE_CODE, MACHINE_DRAIN_CLOSE_REASON } from "./machineDrain";
import crypto from "node:crypto";
import type { Server as SocketServer } from "socket.io";
import type { WebSocket } from "ws";
import {
  DAEMON_CAPABILITY_SEQUENCED_STATUS,
  DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1,
  type AgentWakeRefusedReason,
  asMachineId,
  type MachineId,
  EXTERNAL_AGENT_ACTIVITY_PROVENANCE,
  EXTERNAL_AGENT_ACTIVITY_TEXT_LIMIT,
  EXTERNAL_AGENT_ACTIVITY_TOOL_NAME_LIMIT,
  RAFT_AGENT_STATUS_DETAIL_LIMIT,
  isRaftAgentStatus,
  type RaftAgentStatus,
  createTraceScopeTracer,
  currentDate,
  currentTimeMs,
  failpoints,
  formatTraceparent,
  getStaticRuntimeModelSourceSet,
  getToolActivityLabel,
  hydrateRuntimeConfig,
  isAgentActivityDetailKind,
  isExternalAgentRuntime,
  noopTracer,
  normalizeActivity,
  PROVIDER_PROBE_BUDGET_MS,
  PROVIDER_PROBE_RELAY_BUDGET_MS,
  RUNTIME_ACCOUNT_USAGE_RELAY_BUDGET_MS,
  normalizeActivityDetailKind,
  parseTraceparent,
  runtimeConfigToLaunchFields,
  runtimeModelSourceOutcomeFromSet,
  runtimeModelDetectionRequestTimeoutMs,
  setClockTimeout,
  type ActiveSpan,
  type AgentMessage,
  type MentionDeliveryIdentitySnapshot,
  type ServerToMachineMessage,
  type MachineToServerMessage,
  type MachineDiskStatus,
  isMachineDiskLow,
  isValidMachineDiskStatus,
  type MachineShutdownReason,
  type ComputerLifecycleExecutionAck,
  type AgentConfig,
  type WorkspaceDirectoryInfo,
  type FileNode,
  type TrajectoryEntry,
  type ReasoningEffort,
  type RuntimeReasoningEffort,
  type RuntimeConfig,
  type SkillInfo,
  type AgentStatus,
  type RuntimeModelInfo,
  type RuntimeModelSourceOutcome,
  type AgentActivity,
  type AgentActivityDetailKind,
  type AgentActivityKind,
  type AgentRuntimeErrorState,
  type TraceAttributes,
  type TraceContext,
  type TraceStatus,
  type Tracer,
  type ExternalAgentActivityEvent,
  type ExternalAgentActivityIngestRequest,
  type AgentMigrationTransportLeaseSource,
  type AgentMigrationTransportReady,
  type FeedbackTranscriptReportTimeSource,
  type FeedbackMachineEvidenceOutcome,
  type FeedbackTranscriptLookupOutcome,
  type FeedbackTranscriptOutcomeObjectPlan,
  type FeedbackTranscriptUploadOutcome,
  type FeedbackMachineLogTailOutcome,
  type FeedbackTranscriptWindow,
  type RuntimeAccountUsageProvider,
  type RuntimeErrorActivityDiagnostic,
  type DeliveryConsumptionActivityDiagnostic,
  type WakeCrashLoopActivityDiagnostic,
  type SpawnFailureActivityDiagnostic,
  NON_RETRYABLE_SPAWN_FAILURE_REASONS,
  AGENT_MIGRATION_CAPABILITY,
  MODEL_SEEN_MAX_ITEMS_PER_REPORT,
} from "@botiverse/raft-shared";
import {
  FeedbackTranscriptLateResults,
  feedbackTranscriptOutcomeSpanAttrsSafely,
  readFeedbackTranscriptResultOutcomeSafely,
} from "./feedbackTranscriptLateResults";
import {
  appConfigTraceAttrs,
  appSourceTraceAttrs,
  filterAppRuntimeTraceAttrs,
} from "@botiverse/raft-shared/src/appRuntimeTrace";
import { wakeRequestAppRefTraceAttrs } from "./wakeRequestAppRef";
import type { AppConfigWireSnapshot } from "@botiverse/raft-shared/src/appConfigTransport";
import { RouteFailureError } from "../tracing/routeFailure";
import { applyAgentModelSeen as applyAgentModelSeenToReadPosition } from "./agentModelSeen";
import { AgentMigrationSourceArchiveError } from "./agentMigrationSourceArchive";
import { composeReminderSnapshot } from "../apps/reminder/snapshotComposition";
import { resolveBuiltInMachineMessageDispatch } from "../registry.manifest";
import {
  RUNTIME_OUTCOME_ACK_ENABLED,
  ingestRuntimeOutcomeOutboxMessage,
  type RuntimeOutcomeOutboxMessage,
} from "../runtimeOutcomeOutboxIngest";
import { TerminalFailureBreaker, type CombinedClaimResult } from "../terminalFailureBreakerStore";
import {
  isTerminalBreakerProtecting,
  terminalBlockView,
  type TerminalBlockView,
  type TerminalStartControl,
  type TerminalWakeRefusal,
} from "../terminalFailureBreaker";
import { redisTerminalFailureBreakerStore } from "../terminalFailureBreakerRedisStore";
import { listBuiltInAppConfigSnapshotsForAgent } from "./appConfigTransportComposition";
import { isProbeCarrierFactLive, parseProbeCarrierMeta } from "./probeCarrierFact";
import type { AppSnapshotComposition } from "./appSnapshotComposition";
import { boundedErrorClass } from "../tracing/queryTrace";
import {
  addTraceEvent,
  errorClassOf,
  getCurrentTraceContext,
  getCurrentTraceSpan,
  recordTraceEvent,
  runWithTraceSpan,
  withTraceRoot,
} from "../tracing/semanticTrace";
import * as agentService from "./agentService";
import * as agentMigrationService from "./agentMigrationService";
import * as agentRuntimeProfileService from "./agentRuntimeProfileService";
import * as machineService from "./machineService";
import * as channelService from "./channelService";
import * as messageService from "./messageService";
import * as oauthService from "./oauthService";
import * as mentionDeliveryOccurrenceService from "./mentionDeliveryOccurrenceService";
import * as agentActivityLogService from "./agentActivityLogService";
import * as computerLifecycleOperationService from "./computerLifecycleOperationService";
import * as computerUpgradeRequestService from "./computerUpgradeRequestService";
import {
  recordComputerOfflineTransition,
  recordComputerOnlineTransition,
} from "./computerOutageNotificationService";
import { legacyRuntimeStateFromActivity } from "./legacyActivityStateInference";
import { CONSTRUCTED_WAKE_CONTEXT_FEATURE_FLAG_KEY, evaluateFeatureFlag, PASSIVE_AX_FEATURE_FLAG_KEY, SUBAGENT_DELEGATION_FEATURE_FLAG_KEY } from "./featureFlagService";
import { runtimeAccountUsageCacheService } from "./runtimeAccountUsageCacheService";
import { machineRuntimeModelCatalogService } from "./machineRuntimeModelCatalogService";
import { getComputerLinkedMachineAttachers } from "./computerCredentialService";
import {
  evaluateBroadcastPolicy,
  isQueuedComputerUpgradePolicyCompatible,
  normalizeComputerPlatform,
  type ComputerBroadcastPolicyDecision,
  type EvaluateComputerBroadcastPolicyInput,
} from "./computerBroadcastPolicyService";
import type { PersistedAgentActivityHint } from "./agentActivityLogService";
import * as reminderService from "../apps/reminder/service";
import { agentHasScope } from "./agentScopesService";
import {
  adaptDaemonActivityLifecycleEvent,
  adaptDaemonSessionLifecycleEvent,
  adaptDaemonStatusLifecycleEvent,
  adaptMachineDisconnectLifecycleEvent,
  adaptMachineShutdownLifecycleEvent,
  adaptReadyReconcileLifecycleEvent,
  adaptRuntimeProfileControlLifecycleEvent,
  adaptStartLifecycleEvent,
  adaptStopLifecycleEvent,
  normalizeRuntimeErrorActivityDiagnostic,
} from "./legacyAgentLifecycleAdapter";
import { normalizeDeliveryConsumptionActivityDiagnostic } from "./deliveryConsumptionActivityDiagnostic";
import { WakeCrashLoopBreaker, type WakeCrashLoopExit, type WakeCrashLoopStartRecord } from "./wakeCrashLoopBreaker";
import { normalizeSpawnFailureActivityDiagnostic } from "./spawnFailureActivityDiagnostic";
import { createAgentLifecycleEvent, type AgentLifecycleEventType } from "./agentLifecycleEvents";
import {
  applyAgentLifecycleProjectionPlan,
  type AgentLifecycleProjectionWriterDeps,
  type LifecycleActivityBroadcastResult,
} from "./agentLifecycleProjectionWriter";
import {
  buildAgentLifecycleStateSnapshot,
  buildLifecycleShadowVerdictAttrs,
  CANONICAL_DAEMON_ACTIVITY_BY_DETAIL_KIND,
  arbitrateLifecycleProjection,
  classifyDaemonActivityObservation,
  legacyActivityToCanonicalProjection,
  planActivitySignalAction,
  planSessionSignalAction,
  planStatusSignalAction,
  planWakeAction,
  reduceDaemonActivityLifecycle,
  planSequencedStatus,
  type SequencedStatusVerdict,
  type SequencedStatusVersion,
  reduceDaemonActivitySignal,
  rewriteDaemonActivityEntries,
  reduceRuntimeErrorActivityAction,
  reduceDaemonSessionLifecycle,
  reduceDaemonStatusLifecycle,
  reduceAgentMigrationControlLifecycle,
  reduceExternalActivityLifecycle,
  reduceMachineDisconnectLifecycle,
  reduceMachineShutdownLifecycle,
  reduceReadyReconcileLifecycle,
  reduceRuntimeProfileControlLifecycle,
  reduceStartLifecycle,
  reduceStopLifecycle,
  type DaemonReportedAgentStatus,
  type LifecycleObservationClass,
  type LifecycleArbitrationVerdict,
  type LifecycleRuntimeState,
  type LifecycleShadowSignalSite,
  type WakePlanAction,
  type WakePlanInput,
  type StatusSignalPlanAction,
  type StatusSignalPlanInput,
  type SessionSignalPlanAction,
  type SessionSignalPlanInput,
  type ActivitySignalPlanAction,
  type ActivitySignalPlanInput,
} from "./agentLifecycleReducer";

export {
  buildAgentLifecycleStateSnapshot,
  planActivitySignalAction,
  planSessionSignalAction,
  planStatusSignalAction,
  planWakeAction,
  type ActivitySignalPlanAction,
  type ActivitySignalPlanInput,
  type DaemonReportedAgentStatus,
  type SessionSignalPlanAction,
  type SessionSignalPlanInput,
  type StatusSignalPlanAction,
  type StatusSignalPlanInput,
  type WakePlanAction,
  type WakePlanInput,
} from "./agentLifecycleReducer";
import { getServerPlan, getHistoryCutoff } from "./planService";
import {
  REPLICA_ID,
  routeStartIntent,
  START_INTENT_OWNER_MOVED,
  StartIntentOwnerMovedError,
  StartIntentRemoteError,
  StartIntentTimeoutError,
  StartIntentTransportError,
  replicaSupportsOwnerIntents,
  type OwnerIntent,
  type StartIntentRequest,
  type StartIntentResult,
  routeMachineCommandWithResult,
  machineResponseRelay,
  routeInboxDelivery,
  routeInboxDeliveryWithReceipt,
  fingerprintAgentRuntimeError,
  publishExternalWakeSignal,
  type MachineCommandRouteResult,
  type RoutedInboxDeliveryOptions,
  type RoutedInboxDeliveryReceipt,
  type RoutedInboxDeliveryReceiptResult,
} from "../replicaRouter";
import {
  redisReplicaStateStore,
  type MachineMeta,
  type PersistedActivityTypedCarriers,
  type PersistedAgentActivity,
  type ReplicaStateStore,
} from "./replicaStateStore";
import {
  buildRuntimeTraceContext,
  projectMachineConnectTraceAttrs,
  projectOwnerTraceAttrs,
  type MachineConnectTraceContext,
} from "../tracing/migrationTraceContext";
import {
  agentDeliveryAckSeconds,
  agentDeliveryOutcomesTotal,
  agentDeliveryTrackedTotal,
  machineConnectionsRefusedTotal,
} from "../metrics";
import type { ComputerSourceFact } from "./computerBroadcastPolicyService";
import {
  MachineCatalogAuthority,
  MachineCatalogStaleError,
  type MachineConnectionGeneration,
} from "./machineCatalogAuthority";
import {
  BuiltInModelCatalogError,
  assertBuiltInPresetSupportedByCatalog,
  type BuiltInModelCatalogValidation,
} from "./builtinModelCatalogCompatibility";

export type MachineConnectionPrincipalKind = "computer" | "legacy_machine" | "unknown";

interface MachineConnection {
  ws: WebSocket;
  machineId: string;
  serverId: string;
  principalKind: MachineConnectionPrincipalKind;
  connectionEpochId: string;
  replicaGeneration: string | null;
  heartbeatTimer: unknown | null;
  runtimeAccountUsageTimer: unknown | null;
  lastPong: number;
  lastIngressAt: number;
  daemonVersion: string | null;
  capabilities: Set<string>;
  // Runtimes reported in the daemon `ready` message, held in-memory so
  // server-authoritative readiness (ServerSetupProjectionGate) derives runtime
  // from the SAME live "Ready" event as the client card — no DB-persist lag,
  // no double-source divergence. Null until `ready` is processed.
  runtimes: string[] | null;
  runtimeVersions: Record<string, string>;
  // Latest `machine:disk_status` of this connection; null until reported.
  diskStatus?: MachineDiskStatus | null;
  migrationTransport: MachineMigrationTransportState | null;
  shutdownIntent: MachineShutdownIntent | null;
  traceContext?: MachineConnectTraceContext;
  // Managed-Computer bundle version (`@botiverse/raft-computer`), reported in
  // `ready` when this connection is a Computer; null for a raw daemon.
  computerVersion: string | null;
  // RFC 069 §8: the daemon process on this connection (from `ready`); sequenced
  // status frames from any other daemon process are stale.
  daemonInstanceId: string | null;
  // RFC 071 outbox: agents whose outcome storage this daemon reports as
  // unreliable (`ready.runtimeOutcomeUnreliableAgents`, or an
  // `agent:runtime:outcome_unreliable` notice). `agent:runtime-outcome-v1`
  // does not apply to them.
  runtimeOutcomeUnreliableAgents?: Set<string>;
}

// Daemon-reported capabilities we persist then reflect to the client card. Held
// per machine so a transient DB-write failure can be retried by the server
// itself (see enqueueCapabilitiesPersist) instead of waiting for the daemon to
// send another `ready`.
interface CapabilitiesPersistPayload {
  runtimes: string[];
  runtimeVersions?: Record<string, string>;
  hostname?: string;
  os?: string;
  daemonVersion?: string | null;
  computerVersion?: string | null;
}

function normalizeRuntimeVersions(value: unknown, runtimes: readonly string[]): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const allowed = new Set(runtimes);
  const versions: Record<string, string> = {};
  for (const [runtimeId, rawVersion] of Object.entries(value).slice(0, 32)) {
    if (!allowed.has(runtimeId) || runtimeId.length > 64 || typeof rawVersion !== "string") continue;
    const version = rawVersion.trim();
    if (!version || version.length > 128) continue;
    versions[runtimeId] = version;
  }
  return versions;
}

function runtimeVersionsFromMachineMeta(meta: MachineMeta | null): Record<string, string> {
  if (typeof meta?.runtimeVersions !== "string" || !meta.runtimeVersions) return {};
  try {
    const parsed = JSON.parse(meta.runtimeVersions) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const versions: Record<string, string> = {};
    for (const [runtimeId, rawVersion] of Object.entries(parsed).slice(0, 32)) {
      if (runtimeId.length > 64 || typeof rawVersion !== "string") continue;
      const version = rawVersion.trim();
      if (!version || version.length > 128) continue;
      versions[runtimeId] = version;
    }
    return versions;
  } catch {
    return {};
  }
}

interface CapabilitiesWriteState {
  // The most recent payload we still owe the DB. A newer `ready` overwrites it
  // in place; only ONE writer (runCapabilitiesWriter) ever persists, so writes
  // are serialized and the last write is always this latest payload.
  latest: CapabilitiesPersistPayload;
  // Monotonic per-machine generation (from capabilitiesGenerationSeq, which is
  // NOT reset when this entry is cleared). Used to detect that a newer payload
  // arrived while a persist was in flight so the writer loops again.
  generation: number;
  // True while a persist is in flight for this machine. The single-writer lock:
  // a concurrent `ready` only updates `latest`/`generation`; it must not start a
  // second persist, so an older write can never land after a newer one.
  writing: boolean;
  attempt: number;
  timer: unknown | null;
  // Set when the connection is cleared while a write is in flight; the writer
  // loop sees it after the persist resolves and stops without emitting.
  cancelled: boolean;
}

export interface MachineMigrationTransportState extends AgentMigrationTransportReady {
  capturedAt: string;
}

export interface MachineRuntimeModelDetection {
  outcome: RuntimeModelSourceOutcome;
  authority: MachineConnectionGeneration;
  daemonVersion: string | null;
  computerVersion: string | null;
}

/**
 * task #358: a sessioned start whose resume catch-up could not read the inbox
 * (chain unavailable, or the query failed) carries this as its resume prompt.
 * Without it the start has no summary and no catch-up, and the daemon's prompt
 * chain reads that as "no new messages while you were away" — "not checked"
 * presented as "nothing arrived". The daemon already renders `resumePrompt` as
 * the startup input, on old and new versions alike, so no protocol field.
 */
export const RESUME_CATCHUP_UNAVAILABLE_PROMPT =
  "Messages that arrived while you were away could not be checked: the inbox source was unavailable when you started. Run `raft message check` once to see what is pending, then handle it or stop.";

function normalizeMigrationTransportReady(
  input: AgentMigrationTransportReady | undefined,
  capturedAtMs: number,
): MachineMigrationTransportState | null {
  if (!input || typeof input !== "object") return null;
  const leaseSource = input.leaseSource === "server" || input.leaseSource === "env" ? input.leaseSource : null;
  const endpoint = typeof input.endpoint === "string" && input.endpoint.trim() ? input.endpoint.trim() : null;
  const observedAt = typeof input.observedAt === "string" && input.observedAt.trim()
    ? input.observedAt.trim()
    : new Date(capturedAtMs).toISOString();
  return {
    provisioned: input.provisioned === true,
    endpoint,
    leaseSource,
    protocol: typeof input.protocol === "string" && input.protocol.trim() ? input.protocol.trim() : null,
    capabilities: Array.isArray(input.capabilities)
      ? [...new Set(input.capabilities.filter((value): value is string => typeof value === "string" && value.length > 0))].sort()
      : null,
    observedAt,
    capturedAt: new Date(capturedAtMs).toISOString(),
  };
}

function machineMetaFromMigrationTransport(
  migrationTransport: MachineMigrationTransportState | null,
): Pick<MachineMeta,
  | "migrationTransportProvisioned"
  | "migrationTransportEndpoint"
  | "migrationTransportLeaseSource"
  | "migrationTransportObservedAt"
  | "migrationTransportCapturedAt"
  | "migrationTransportProtocol"
  | "migrationTransportCapabilities"
> {
  return {
    migrationTransportProvisioned: migrationTransport ? (migrationTransport.provisioned ? "1" : "0") : null,
    migrationTransportEndpoint: migrationTransport?.endpoint ?? null,
    migrationTransportLeaseSource: migrationTransport?.leaseSource ?? null,
    migrationTransportObservedAt: migrationTransport?.observedAt ?? null,
    migrationTransportCapturedAt: migrationTransport?.capturedAt ?? null,
    migrationTransportProtocol: migrationTransport?.protocol ?? null,
    migrationTransportCapabilities: migrationTransport?.capabilities
      ? JSON.stringify(migrationTransport.capabilities)
      : null,
  };
}

function migrationTransportFromMachineMeta(meta: MachineMeta | null): MachineMigrationTransportState | null {
  if (!meta?.migrationTransportCapturedAt) return null;
  const rawLeaseSource = meta.migrationTransportLeaseSource;
  const leaseSource: AgentMigrationTransportLeaseSource | null = rawLeaseSource === "server" || rawLeaseSource === "env"
    ? rawLeaseSource
    : null;
  return {
    provisioned: meta.migrationTransportProvisioned === "1",
    endpoint: meta.migrationTransportEndpoint ?? null,
    leaseSource,
    protocol: meta.migrationTransportProtocol ?? null,
    capabilities: parseMachineMigrationTransportCapabilities(meta.migrationTransportCapabilities),
    observedAt: meta.migrationTransportObservedAt ?? meta.migrationTransportCapturedAt,
    capturedAt: meta.migrationTransportCapturedAt,
  };
}

function parseMachineMigrationTransportCapabilities(value: string | null | undefined): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? [...new Set(parsed)].sort()
      : null;
  } catch {
    return null;
  }
}

interface MachineShutdownIntent {
  reason: MachineShutdownReason;
  receivedAtMs: number;
}

interface OrchestratorClock {
  now(): number;
  scheduleRepeated(fn: () => void, ms: number): unknown;
  cancelRepeated(timer: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

/**
 * Next outbound `agent:activity` serverSeq: wall-clock milliseconds, bumped
 * past the previous value this replica issued (so two pushes in the same
 * millisecond, or after the clock steps back, still increase). Every replica (and a restarted
 * one) therefore issues seqs above what an earlier replica issued, so the
 * client's "drop if not newer" check keeps accepting pushes after the daemon
 * reconnects elsewhere. This assumes replica clocks are NTP-synced (ms-level
 * on ECS): skew only matters for pushes that close together, but a replica
 * whose clock ran far behind would have its pushes dropped until its clock
 * passed the last seq the browser saw.
 */
export function nextActivityServerSeq(previous: number, nowMs: number): number {
  return Math.max(nowMs, previous + 1);
}

const systemOrchestratorClock: OrchestratorClock = {
  now: () => Date.now(),
  scheduleRepeated: (fn, ms) => setInterval(fn, ms),
  cancelRepeated: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
  setTimeout: setClockTimeout,
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function runtimeAccountUsageProvidersForRuntimes(runtimes: readonly string[]): RuntimeAccountUsageProvider[] {
  const providers = new Set<RuntimeAccountUsageProvider>();
  for (const runtime of runtimes) {
    if (runtime === "claude" || runtime === "codex" || runtime === "grok") providers.add(runtime);
    if (runtime === "kimi" || runtime === "kimi-sdk") providers.add("kimi");
  }
  return [...providers];
}

export function runtimeAccountUsageIntervalMs(machineId: string): number {
  const baseMs = 15 * 60_000;
  const jitterRangeMs = 2 * 60_000;
  return baseMs + crypto.createHash("sha256").update(machineId).digest().readUInt32BE(0) % jitterRangeMs;
}

type RuntimeModelSourceResultMessage = Extract<MachineToServerMessage, { type: "machine:runtime_models:result" }>;

/** Project both new and legacy daemon result carriers into one closed truth. */
export function projectRuntimeModelSourceResult(
  msg: RuntimeModelSourceResultMessage,
  runtime: string,
): RuntimeModelSourceOutcome {
  if (msg.outcome) return msg.outcome;
  if (msg.error) {
    const staticSource = msg.error === "unsupported"
      ? getStaticRuntimeModelSourceSet(runtime)
      : undefined;
    if (staticSource) {
      return { kind: "live", value: staticSource };
    }
    return msg.error === "unsupported"
      ? { kind: "unsupported" }
      : { kind: "error", retryable: true };
  }
  return runtimeModelSourceOutcomeFromSet({ models: msg.models ?? [], default: msg.default });
}

function readBooleanEnv(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function readAnyBooleanEnv(names: string[]): boolean {
  return names.some((name) => readBooleanEnv(name));
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function durationMsBucket(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms === 0) return "0";
  if (ms <= 1_000) return "1s";
  if (ms <= 10_000) return "1s-10s";
  if (ms <= 30_000) return "10s-30s";
  if (ms <= 60_000) return "30s-60s";
  if (ms <= 120_000) return "60s-120s";
  return "120s+";
}

function hashRuntimeProfileKey(key: string | null | undefined): string | undefined {
  if (!key) return undefined;
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// The daemon->server `agent:runtime_profile` frame is `JSON.parse(...) as MachineToServerMessage`
// with no runtime schema, so `source` is an untrusted wire value. Allowlist-normalize before it
// lands on a ScopeDB span attr: only the four known emit sources pass through, everything else
// (including absent / malformed) collapses to "unknown". Closed-set-at-boundary; see task #317.
const RUNTIME_PROFILE_REPORT_SOURCES = new Set(["connect", "session_init", "turn_end", "stop"]);
const MACHINE_SHUTDOWN_REASONS = new Set<MachineShutdownReason>(["computer_stop", "daemon_stop", "unknown"]);
const MACHINE_REPLICA_UNREGISTER_TIMEOUT_MS = 1000;
const MACHINE_REPLICA_REPAIR_MAX_REPLACEMENTS = 4;

function requireReplicaGeneration(generation: unknown): string {
  if (typeof generation !== "string" || generation.trim().length === 0) {
    throw new Error("Machine replica registration returned an empty generation");
  }
  return generation;
}
const COMPUTER_LIFECYCLE_DISCONNECT_OBSERVATION_TIMEOUT_MS = 1000;
const MACHINE_DISCONNECT_PROJECTION_GRACE_MS = 2000;
export function normalizeRuntimeProfileReportSource(source: unknown): string {
  return typeof source === "string" && RUNTIME_PROFILE_REPORT_SOURCES.has(source) ? source : "unknown";
}

function normalizeMachineShutdownReason(reason: unknown): MachineShutdownReason {
  return typeof reason === "string" && MACHINE_SHUTDOWN_REASONS.has(reason as MachineShutdownReason)
    ? reason as MachineShutdownReason
    : "unknown";
}

function runtimeProfileSessionId(ref: unknown): string | undefined {
  if (typeof ref === "string") {
    const trimmed = ref.trim();
    return trimmed || undefined;
  }
  if (ref && typeof ref === "object" && "label" in ref && typeof ref.label === "string") {
    const trimmed = ref.label.trim();
    return trimmed || undefined;
  }
  return undefined;
}

function liveActivityRootTraceAttrs(
  result: LifecycleActivityBroadcastResult | undefined,
): Record<string, unknown> {
  if (!result) {
    return { live_activity_updated: false };
  }
  if (result.action === "kernel-preserve") {
    return {
      live_activity_updated: false,
      live_activity_arbitration_enabled: true,
      live_activity_arbitration_action: result.arbitration?.verdictAction ?? "preserve",
      live_activity_arbitration_reason: result.arbitration?.reason ?? "unknown",
      previous_activity_status: result.previousActivity ?? "none",
      next_activity_status: result.nextActivity,
      activity_status: result.nextActivity,
    };
  }
  const previous = result.previousActivity ?? "none";
  return {
    live_activity_updated: true,
    live_activity_arbitration_enabled: result.arbitration?.enabled ?? false,
    live_activity_arbitration_action: result.arbitration?.verdictAction ?? "legacy",
    live_activity_arbitration_reason: result.arbitration?.reason ?? "legacy_disabled",
    previous_activity_status: previous,
    next_activity_status: result.nextActivity,
    activity_status: result.nextActivity,
    activity_transition: `${previous}->${result.nextActivity}`,
  };
}

function oldestInboxMessageAgeMs(messages: AgentMessage[], now: number): number | undefined {
  let oldest: number | undefined;
  for (const message of messages) {
    if (!message.timestamp) continue;
    const timestampMs = Date.parse(message.timestamp);
    if (!Number.isFinite(timestampMs)) continue;
    oldest = oldest == null ? timestampMs : Math.min(oldest, timestampMs);
  }
  return oldest == null ? undefined : Math.max(0, now - oldest);
}

interface MachineDisconnectContext {
  cause?: "heartbeat_timeout" | "socket_close" | "socket_error" | "computer_machine_unlinked" | "legacy_machine_key_migrated";
  closeCode?: number;
  closeReason?: string;
  errorMessage?: string;
  shutdownIntent?: MachineShutdownIntent;
}

const MACHINE_UNLINKED_CLOSE_CODE = 4001;
const MACHINE_UNLINKED_CLOSE_REASON = "computer_machine_unlinked";
const LEGACY_PRINCIPAL_FENCED_CLOSE_CODE = 4002;
const LEGACY_PRINCIPAL_FENCED_CLOSE_REASON = "legacy_machine_key_migrated";

interface PendingMachineDisconnectProjection {
  serverId: string;
  connectionEpochId: string;
  replicaGeneration: string | null;
  context: MachineDisconnectContext;
  timer: unknown;
}

interface PendingAgentSkillsListRequest {
  agentId: string;
  machineId: string;
  runtime: string;
  startedAtMs: number;
  timedOut: boolean;
  timeoutTimer: unknown | null;
  observationTimer: unknown | null;
}

interface PendingAgentDeliveryAck {
  machineId: string;
  msg: Extract<ServerToMachineMessage, { type: "agent:deliver" }>;
  timer: unknown | null;
  attempts: number;
  parked: boolean;
  parkedReason?: "machine_offline";
  firstAttemptAt: number;
  lastAttemptAt: number;
  /** SLO v1 SLI 4: the machine socket was open on this replica when the record was created. */
  onlineAtFirstAttempt: boolean;
}

type AgentDeliveryOutcome =
  | "acked"
  | "gave_up"
  | "dropped"
  | "routed"
  | "terminal"
  | "agent_stopped"
  | "converted_to_wake"
  | "replica_shutdown";

type AgentStartMessage = Extract<
  ServerToMachineMessage,
  { type: "agent:start" | "agent:start:wiki" }
>;

type AgentStartDispatchTerminalReason =
  | "acked"
  | "stopped"
  | "superseded"
  | "machine_reassigned"
  | "retry_exhausted";

interface PendingAgentStartAck {
  machineId: string;
  msg: AgentStartMessage & { startDispatchId: string };
  timer: unknown | null;
  attempts: number;
  parked: boolean;
  createdAt: number;
  lastAttemptAt: number;
  nextRetryAt: number | null;
}

interface AgentInbox {
  inbox: AgentMessage[];
  pendingReceive: {
    resolve: (messages: AgentMessage[]) => void;
    timer: ReturnType<typeof setTimeout>;
    finish: (messages: AgentMessage[]) => void;
  } | null;
}

interface StartAgentOptions {
  /** Daemon-requested wake for a due app-inbox item (task #1103). */
  startCause?: "app_inbox_wake";
  resumePrompt?: string;
  wakeMessage?: AgentMessage;
  wakeMessageTransient?: boolean;
  requireQueueReceipt?: boolean;
  /**
   * RFC 071 §5: an explicit human start (E3) for the terminal-failure
   * breaker. Set only by named human control routes; never inferred from
   * `startCause` (task #1119 keeps its own rule). Every start without it is
   * automatic for that breaker.
   */
  control?: TerminalHumanStartControl;
}

/** RFC 071: what a start knows about its machine's outcome reporting (see `terminalStartContext`). */
interface TerminalStartContext {
  /** `agent:runtime-outcome-v1` applies to this agent here; `unknown` off the socket-owning replica. */
  capability: boolean | "unknown";
  /** The daemon advertises `agent:runtime-outcome-v1` (it has the outcome outbox), reliable or not. */
  daemonReportsOutcomes: boolean;
  daemonInstanceId: string | null;
}

/** RFC 071 §5: the only start control the terminal-failure breaker treats as human. */
export type TerminalHumanStartControl = "human_start";

/** RFC 071: refusals of the terminal-failure breaker (`AgentWakeRefusedReason` members). */
export type TerminalStartRefusal = TerminalWakeRefusal;

export type AgentStartDispatchResult =
  | { outcome: "dispatched" }
  | { outcome: "skipped"; reason: "manual_stop" | "wake_lock_held" | "wake_crash_loop_blocked" | TerminalStartRefusal };

/** RFC 071 §9: the server-authored detail of a `terminal_failure_paused` activity (ids/classes/times only). */
export function terminalBlockDetail(view: TerminalBlockView): string {
  if (view.kind === "paused") {
    const why = view.failureKind ? ` after repeated runtime failures (${view.failureKind})` : " after repeated runtime failures";
    return `Automatic wake paused until ${new Date(view.blockedUntilMs).toISOString()}${why}. `
      + "The next message, reminder or manual start after that retries; a manual start lifts it now.";
  }
  const why = view.reason === "outcome_unobservable"
    ? "This computer can no longer report runtime outcomes for this agent."
    : view.reason === "outcome_evidence_lost"
      ? "Runtime outcome reports for this agent were lost."
      : "The previous runtime process could not be confirmed stopped.";
  return `Automatic wake stopped: ${why} A manual start is needed.`;
}

/**
 * RFC 071: the terminal-failure breaker's record could not be read or
 * written, so the start's pending entry cannot be recorded before dispatch
 * (RFC 4.3 rule 1). The start is not dispatched.
 */
export class TerminalBreakerStorageUnavailableError extends Error {
  readonly code = "terminal_failure_breaker_storage_unavailable" as const;

  constructor(readonly cause: unknown) {
    super("Agent start not dispatched: the terminal-failure breaker state is unavailable");
    this.name = "TerminalBreakerStorageUnavailableError";
  }
}

class CrossReplicaQueueReceiptUnavailableError extends Error {
  constructor() {
    super("Cross-replica dispatch has no target-side queue acknowledgement");
    this.name = "CrossReplicaQueueReceiptUnavailableError";
  }
}

export class KimiReasoningEffortUpgradeRequiredError extends Error {
  readonly code = "upgrade_required" as const;

  constructor() {
    super("Update Raft on this computer before starting a Kimi agent with an explicit reasoning setting");
    this.name = "KimiReasoningEffortUpgradeRequiredError";
  }
}

type StopAgentReason = "manual" | "internal";

/** Whether the stop reached the daemon. False: only the server-side state changed. */
export interface AgentStopResult {
  delivered: boolean;
}

export interface ResetAgentOptions {
  restartEvenIfInactive?: boolean;
  restartIfStopped?: boolean;
  /**
   * RFC 071 §5: an E3 reset. Set by the human reset route, and by a settings
   * change whose runtime values really differ. The terminal-failure breaker
   * lifts, and the restart is a human takeover start. Absent: the reset's
   * restart is an automatic start for that breaker.
   */
  terminalControl?: "human_reset" | "runtime_config_changed";
}
type PersistedAgentRow = NonNullable<Awaited<ReturnType<typeof agentService.getAgent>>>;

/** Cached agent state for delivery — avoids DB reads in hot path. */
interface CachedAgentState {
  id: string;
  /**
   * User/server intent, not proof that a runtime process is currently alive.
   * `active` means the agent is allowed to be served and may be lazy-woken.
   * Manual `stopped` is the true offline/unwakeable state.
   */
  status: AgentStatus;
  machineId: string | null;
  sessionId: string | null;
  expectedLaunchId: string | null;
  launchGuardMode: "legacy" | "guarded";
  serverId: string;
  name: string;
  displayName: string | null;
  description: string | null;
  model: string;
  runtime: string;
  runtimeConfig: RuntimeConfig;
  lastRuntimeError: AgentRuntimeErrorState | null;
  /**
   * Ephemeral runtime-process presence/state observed from daemon signals.
   * Daemon restart can make this `not_running` while `status` remains active.
   */
  runtimeState: LifecycleRuntimeState;
  reasoningEffort: RuntimeReasoningEffort | null;
  envVars: Record<string, string> | null;
}

type ActivitySnapshot = {
  activity: AgentActivityKind;
  detail: string;
  detailKind: AgentActivityDetailKind;
  observedAtMs?: number;
  updatedAt: number;
  /**
   * task #1116: present only while detailKind === "delivery_unconsumed". The
   * daemon's typed observation carrier, passed through unchanged for the web.
   * Mirrored with the snapshot to the replica state store so non-owner
   * replicas read it back (task #1116); a later activity write drops it.
   */
  deliveryConsumption?: DeliveryConsumptionActivityDiagnostic;
  /** task #1119: present only while detailKind === "wake_crash_loop_blocked". */
  wakeCrashLoop?: WakeCrashLoopActivityDiagnostic;
  /**
   * task #1123: present only while detailKind === "runtime_unavailable" after
   * a failed start. The daemon's typed reason, passed through unchanged.
   */
  spawnFailure?: SpawnFailureActivityDiagnostic;
};

type ActivityClockSnapshot = {
  observedAtMs?: number;
  updatedAt: number;
};

type VisibleActivity = {
  activity: AgentActivityKind;
  activityDetail: string;
  /** task #1116: typed detail kind of the served snapshot, when one exists. */
  activityDetailKind?: AgentActivityDetailKind;
  /** task #1116: the daemon's delivery-consumption carrier, when the served snapshot is delivery_unconsumed. */
  deliveryConsumption?: DeliveryConsumptionActivityDiagnostic;
  /** task #1119: the server's wake crash-loop breaker state, when the served snapshot is wake_crash_loop_blocked. */
  wakeCrashLoop?: WakeCrashLoopActivityDiagnostic;
  /** task #1123: the daemon's typed spawn-failure reason, when the served snapshot is runtime_unavailable. */
  spawnFailure?: SpawnFailureActivityDiagnostic;
};

type MachineReachability = "local" | "remote" | "offline" | "none" | "external-reported";

/**
 * task #1116 / #1119: the typed carriers that travel with the activity snapshot
 * — on the socket payload, and in the same shared-store write so a non-owner
 * replica's refresh read-back exposes them. Only the carrier matching the
 * served detail kind rides; a write of any other kind carries none, which
 * clears the mirrored field.
 */
function snapshotTypedCarriers(snapshot: ActivitySnapshot): ActivityTypedCarriers | undefined {
  if (snapshot.detailKind === "delivery_unconsumed" && snapshot.deliveryConsumption) {
    return { deliveryConsumption: snapshot.deliveryConsumption };
  }
  if (snapshot.detailKind === "wake_crash_loop_blocked" && snapshot.wakeCrashLoop) {
    return { wakeCrashLoop: snapshot.wakeCrashLoop };
  }
  if (snapshot.detailKind === "runtime_unavailable" && snapshot.spawnFailure) {
    return { spawnFailure: snapshot.spawnFailure };
  }
  return undefined;
}

/**
 * task #1116: rebuild a snapshot from the shared mirror, carriers included, so
 * the non-owner read path formats exactly what the owner wrote.
 */
function activitySnapshotFromPersisted(persisted: PersistedAgentActivity | null): ActivitySnapshot | null {
  if (!persisted) return null;
  const { carriers, ...rest } = persisted;
  return {
    ...rest,
    ...(carriers?.deliveryConsumption ? { deliveryConsumption: carriers.deliveryConsumption } : {}),
    ...(carriers?.wakeCrashLoop ? { wakeCrashLoop: carriers.wakeCrashLoop } : {}),
    ...(carriers?.spawnFailure ? { spawnFailure: carriers.spawnFailure } : {}),
  };
}

type ActivityHintSource = "local-cache" | "redis";

type WeakOfflineSource = "owner_missing" | "replica_state_unavailable" | "self_owner_without_local_connection";

type WeakOfflineCompetingFact = "redis_busy_activity" | "persisted_busy_activity";

type ActivityTraceOptions = {
  parent?: TraceContext | null;
  /**
   * The agent's row as the caller loaded it in this request (e.g. the agent
   * list). Stands in for the cache-miss and authoritative re-reads, which would
   * return the same row moments later: a live row seeds the cache, a deleted
   * row resolves as "no agent" (getAgent excludes deleted rows) without a query.
   */
  persistedAgent?: PersistedAgentRow;
};

type RuntimeContextMachine = {
  name: string;
  description: string | null;
  hostname: string | null;
  os: string | null;
} | null;

export type AgentLifecycleAction = "start" | "stop" | "reset" | "wake";
export type AgentLifecycleOutcome = "attempted" | "completed" | "failed" | "skipped" | "suppressed";
export type AgentLifecycleCause = "message" | "manual" | "resume" | "app_inbox_wake" | "internal" | "restart" | "session" | "full";

export interface StaleActivitySweepPlanInput {
  isTransient: boolean;
  ageSec: number;
  staleAfterSec: number;
}

export type StaleActivitySweepPlanAction = "keep-current" | "sweep-online";

export function planStaleActivitySweepAction(input: StaleActivitySweepPlanInput): StaleActivitySweepPlanAction {
  return input.isTransient && input.ageSec > input.staleAfterSec ? "sweep-online" : "keep-current";
}

export interface ActivityBroadcastPlanInput {
  hasEntries: boolean;
  isHeartbeat: boolean;
  isProbeResponse: boolean;
  isDeliveryAckTurnActive: boolean;
  shouldPersistStatusOnly: boolean;
}

export type ActivityBroadcastPlanAction =
  | "persist-and-emit-now"
  | "heartbeat-refresh"
  | "probe-refresh"
  | "delivery-ack-refresh"
  | "debounce-only";
type ActivityBroadcastWriteAction = ActivityBroadcastPlanAction | "kernel-preserve";

interface ActivityWriteArbitrationTrace {
  enabled: boolean;
  reason: LifecycleArbitrationVerdict["reason"] | "legacy_disabled";
  verdictAction: LifecycleArbitrationVerdict["action"] | "legacy";
}

export function planActivityBroadcastAction(input: ActivityBroadcastPlanInput): ActivityBroadcastPlanAction {
  // Entries are authoritative history even if a buggy producer marks the
  // frame as a replay. Status-only heartbeat/probe snapshots and the
  // delivery-ack turn-active overlay are refresh-only by contract: they
  // reassert current truth, not a new user-visible fact.
  if (input.hasEntries) return "persist-and-emit-now";
  if (input.isHeartbeat) return "heartbeat-refresh";
  if (input.isProbeResponse) return "probe-refresh";
  if (input.isDeliveryAckTurnActive) return "delivery-ack-refresh";
  return input.shouldPersistStatusOnly ? "persist-and-emit-now" : "debounce-only";
}

export interface RuntimeProfileHeartbeatNudgePlanInput {
  disabled: boolean;
  lastSentAt: number | null;
  now: number;
  cooldownMs: number;
}

export type RuntimeProfileHeartbeatNudgePlanAction = "disabled" | "cooldown" | "allow";

export function planRuntimeProfileHeartbeatNudgeAction(
  input: RuntimeProfileHeartbeatNudgePlanInput,
): RuntimeProfileHeartbeatNudgePlanAction {
  if (input.disabled) return "disabled";
  if (input.lastSentAt !== null && input.now - input.lastSentAt < input.cooldownMs) {
    return "cooldown";
  }
  return "allow";
}

export interface ReminderFireReceiptPlanInput {
  reminderExists: boolean;
  reminderServerMatchesAgent: boolean;
  reminderOwnerAgentId: string | null;
  reminderVersion: number;
  reminderStatus: string;
  receiptAgentId: string;
  receiptVersion: number;
}

export type ReminderFireReceiptPlanAction =
  | "reject"
  | "converge-current"
  | "ack-historical"
  | "noop";

export function shouldEmitReminderFiredLifecycle(result: { fired: boolean }): boolean {
  return result.fired;
}

/**
 * A fire receipt is authorized by the Computer agent that owned the revision
 * which fired. A later owner rebind must not strand that already-committed
 * historical receipt, while a receipt for the current/future revision must
 * still match the current owner.
 */
export function planReminderFireReceiptAction(
  input: ReminderFireReceiptPlanInput,
): ReminderFireReceiptPlanAction {
  if (!input.reminderExists || !input.reminderServerMatchesAgent) return "reject";
  if (
    input.reminderVersion <= input.receiptVersion &&
    input.reminderOwnerAgentId !== input.receiptAgentId
  ) {
    return "reject";
  }
  if (input.reminderVersion > input.receiptVersion) return "ack-historical";
  if (input.reminderVersion === input.receiptVersion && input.reminderStatus === "scheduled") {
    return "converge-current";
  }
  return "noop";
}

function protocolSourceTraceAttrs(input: {
  ownerAgentId: string;
  sourceId: string;
  version: number;
  messageType: string;
}) {
  return appSourceTraceAttrs({
    ownerAgentId: input.ownerAgentId,
    sourceRef: {
      kind: input.messageType.split(".", 1)[0]!,
      id: input.sourceId,
      revision: String(input.version),
    },
  });
}

type ActivityBroadcastTraceResult = {
  action: ActivityBroadcastWriteAction;
  arbitration?: ActivityWriteArbitrationTrace;
  persistedEntryCount: number;
  previousActivity: AgentActivityKind | null;
  nextActivity: AgentActivityKind;
  persistence?: Promise<ActivityPersistenceOutcome>;
};

interface AgentActivitySnapshotWriteResult {
  action: "map-write" | "kernel-preserve";
  arbitration: ActivityWriteArbitrationTrace;
  nextActivity: AgentActivityKind;
  previousActivity: AgentActivityKind | null;
  snapshot?: ActivitySnapshot;
}

type ActivityPersistenceOutcome = "applied" | "deduped" | "error";

type DeliveryAckTurnActiveGate = {
  admit: boolean;
  reason: "runtime_liveness_failed_or_unknown" | "stale_runtime_observation" | null;
  runtimeState: LifecycleRuntimeState;
  currentActivity: AgentActivityKind | null;
  observedAgeSec: number | null;
};

export interface ActivityHintResolutionPlanInput {
  hasStoppedOfflineHint: boolean;
  reachability: MachineReachability;
  shouldTrustRecoveredOfflineHint: boolean;
  weakOfflineSource?: WeakOfflineSource;
  weakOfflineCompetingFact?: WeakOfflineCompetingFact;
  source: ActivityHintSource;
  isFreshLocalCache: boolean;
}

export type ActivityHintResolutionPlanAction =
  | "return-snapshot"
  | "return-offline"
  | "ignore-hint"
  | "return-read-through-snapshot";

type ActivityHintArbitrationReason =
  | "trusted_snapshot"
  | "owner_mirror_read_through";

export function planActivityHintResolutionAction(
  input: ActivityHintResolutionPlanInput,
): ActivityHintResolutionPlanAction {
  if (input.reachability === "local") {
    return "return-snapshot";
  }

  if (input.hasStoppedOfflineHint) {
    return "return-snapshot";
  }

  if (input.reachability === "offline" || input.reachability === "none") {
    if (input.weakOfflineSource && input.weakOfflineCompetingFact) {
      return input.source === "local-cache" ? "return-snapshot" : "return-read-through-snapshot";
    }
    return "return-offline";
  }

  if (input.reachability === "external-reported") {
    return "return-read-through-snapshot";
  }

  if (input.shouldTrustRecoveredOfflineHint) {
    return "ignore-hint";
  }

  if (input.source === "local-cache") {
    return input.isFreshLocalCache ? "return-snapshot" : "ignore-hint";
  }

  return "return-read-through-snapshot";
}

export interface MachineReachabilityPlanInput {
  hasMachineId: boolean;
  hasLocalMachine: boolean;
  replicaStateAvailable: boolean;
  ownerReplica: string | null;
  isExternalRuntime: boolean;
}

export function planMachineReachability(input: MachineReachabilityPlanInput): MachineReachability {
  if (!input.hasMachineId) {
    return input.isExternalRuntime ? "external-reported" : "none";
  }

  if (input.hasLocalMachine) {
    return "local";
  }

  if (!input.replicaStateAvailable) {
    return "offline";
  }

  if (!input.ownerReplica || input.ownerReplica === REPLICA_ID) {
    return "offline";
  }

  return "remote";
}

interface MachineReachabilityInputContext {
  agent: CachedAgentState | null;
}

export interface StaleTransientNormalizationPlanInput {
  isTransient: boolean;
  ageSec: number;
  staleAfterSec: number;
}

export type StaleTransientNormalizationPlanAction = "keep-current" | "normalize-online";

export function planStaleTransientNormalizationAction(
  input: StaleTransientNormalizationPlanInput,
): StaleTransientNormalizationPlanAction {
  return input.isTransient && input.ageSec > input.staleAfterSec ? "normalize-online" : "keep-current";
}

interface StaleActivitySweepApplyContext {
  action: StaleActivitySweepPlanAction;
  agentId: string;
  now: number;
}

interface ActivityBroadcastApplyContext {
  action: ActivityBroadcastPlanAction;
  agentId: string;
  activity: AgentActivityKind;
  detail: string;
  detailKind: AgentActivityDetailKind;
  now: number;
  persistedEntries: TrajectoryEntry[];
  dedupeKey?: string;
  /**
   * Optional daemon-side join keys (task #136). When present, threaded
   * into the Socket.IO `agent:activity` payload alongside `serverSeq`
   * so feedback-export bundles can exact-join the broadcast row back
   * to `server.agent.activity.ingest`. Status-only debounced broadcasts
   * don't carry these because their final-state emit can merge multiple
   * upstream daemon messages with different launch keys.
   */
  launchId?: string;
  clientSeq?: number;
  probeId?: string;
  producerFactId?: string;
  isHeartbeat?: boolean;
  /** task #1116/#1119: typed carriers of the snapshot this broadcast wrote, so the emit does not depend on a later snapshot. */
  carriers?: ActivityTypedCarriers;
}

type ActivityTypedCarriers = PersistedActivityTypedCarriers;

type ActivityBroadcastArbitrationInput = {
  observationClass: LifecycleObservationClass;
  signalSite: LifecycleShadowSignalSite;
  planKind?: AgentLifecycleEventType;
};

interface ActivityHintResolutionApplyContext {
  action: ActivityHintResolutionPlanAction;
  agentId: string;
  snapshot: ActivitySnapshot;
}

interface ActivityHintResolutionInputContext {
  agent: CachedAgentState | null;
  snapshot: ActivitySnapshot;
  source: ActivityHintSource;
}

interface StaleTransientNormalizationApplyContext {
  action: StaleTransientNormalizationPlanAction;
  agentId: string;
  source: ActivityHintSource;
  now: number;
}

export interface SendToMachinePlanInput {
  hasReadyLocalConnection: boolean;
  canReroute: boolean;
}

export type SendToMachinePlanAction =
  | "send-locally"
  | "reroute-then-warn"
  | "warn-offline";

/**
 * The HTTP status a POST redrive answers with, as a pure function of the orchestrator verdict.
 *
 * EXTRACTED 2026-08-20 because @Kabi's CHANGES REQUIRED measured this write path at ZERO arms
 * across all three of its layers (route, authorize function, orchestrator method) — and the
 * mapping lived inline in a nested ternary inside the route, where nothing could reach it without
 * standing up an HTTP app.
 *
 * The distinction this function exists to protect is "queued" versus "everything else". A redrive
 * that did not queue must never answer 202, because 202 is the only answer a caller reads as
 * "delivery was re-attempted". ACKED and CAS_MISMATCH are the two verdicts most likely to be
 * mistaken for success by a future edit: the first means the message already arrived, the second
 * means someone else moved the row first — in both cases re-delivering would duplicate.
 */
// DERIVED FROM THE PRODUCER, NEVER HAND-LISTED. My first version enumerated these by hand and was
// wrong in both directions: it omitted BROKEN_HOP and invented three states that do not exist.
// tsc caught it, but the deeper point is that a hand-copied enumeration silently rots the moment
// the method gains a verdict — and this mapping's whole job is to be exhaustive over that set.
export type MentionRedriveVerdict =
  Awaited<ReturnType<AgentOrchestrator["redriveMentionDelivery"]>>["status"];

export function planMentionRedriveHttpStatus(verdict: MentionRedriveVerdict): 202 | 404 | 409 {
  if (verdict === "REDRIVE_QUEUED") return 202;
  if (verdict === "NOT_JOINABLE") return 404;
  return 409;
}

export function planSendToMachineAction(input: SendToMachinePlanInput): SendToMachinePlanAction {
  if (input.hasReadyLocalConnection) {
    return "send-locally";
  }
  return input.canReroute ? "reroute-then-warn" : "warn-offline";
}

function normalizeMachineCommandRouteResult(result: boolean | MachineCommandRouteResult): MachineCommandRouteResult {
  if (typeof result !== "boolean") return result;
  return {
    routed: result,
    reason: result ? "published" : "owner_missing",
    ownerReplicaPresent: false,
    ownerReplicaCurrent: false,
    ownerCohort: "unknown",
    ownerRequestHostClass: "unknown",
    ownerRequestHostPresent: false,
    receiverPresent: false,
    receiverKind: "none",
    receiverReplicaCurrent: false,
  };
}

export function projectMachineCommandRouteTraceAttrs(result: MachineCommandRouteResult): Record<string, unknown> {
  return {
    router_reason: result.reason,
    router_routed: result.routed,
    ...(result.ownerReplicaPresent !== undefined ? { owner_replica_present: result.ownerReplicaPresent } : {}),
    ...(result.ownerReplicaCurrent !== undefined ? { owner_replica_current: result.ownerReplicaCurrent } : {}),
    ...(result.ownerReplicaTtlSeconds !== undefined ? { owner_replica_ttl_seconds: result.ownerReplicaTtlSeconds } : {}),
    ...(result.ownerReplicaAgeMs !== undefined ? { owner_replica_age_ms: result.ownerReplicaAgeMs } : {}),
    ...(result.receiverPresent !== undefined ? { receiver_present: result.receiverPresent } : {}),
    ...(result.receiverKind !== undefined ? { receiver_kind: result.receiverKind } : {}),
    ...(result.receiverReplicaCurrent !== undefined ? { receiver_replica_current: result.receiverReplicaCurrent } : {}),
    ...(result.publishReceivers !== undefined ? { publish_receivers: result.publishReceivers } : {}),
    ...(result.staleOwnerCleanupResult !== undefined ? { stale_owner_cleanup_result: result.staleOwnerCleanupResult } : {}),
    ...(result.staleOwnerCleanupReason !== undefined ? { stale_owner_cleanup_reason: result.staleOwnerCleanupReason } : {}),
  };
}

export interface StopPlanInput {
  reason: StopAgentReason;
}

export type StopPlanAction = "persist-stopped" | "persist-inactive";

export function planStopAction(input: StopPlanInput): StopPlanAction {
  return input.reason === "manual" ? "persist-stopped" : "persist-inactive";
}

export interface ReceivePlanInput {
  hasBufferedMessages: boolean;
  block: boolean;
}

export type ReceivePlanAction =
  | "return-buffered"
  | "return-empty"
  | "install-waiter";

export function planReceiveAction(input: ReceivePlanInput): ReceivePlanAction {
  if (input.hasBufferedMessages) {
    return "return-buffered";
  }
  return input.block ? "install-waiter" : "return-empty";
}

export interface AckPartitionInput {
  inbox: AgentMessage[];
  ackedSeqs: Set<number>;
  ackedMessageIds?: Set<string>;
}

export interface AckPartitionResult {
  removed: AgentMessage[];
  retained: AgentMessage[];
}

export function partitionAcknowledgedMessages(input: AckPartitionInput): AckPartitionResult {
  const removed: AgentMessage[] = [];
  const retained: AgentMessage[] = [];

  for (const message of input.inbox) {
    if (
      (message.seq && input.ackedSeqs.has(message.seq))
      || (!message.seq && message.message_id && input.ackedMessageIds?.has(message.message_id))
    ) {
      removed.push(message);
    } else {
      retained.push(message);
    }
  }

  return { removed, retained };
}

export interface TargetScopedAckPartitionInput {
  inbox: AgentMessage[];
  channelId: string;
  ackedSeqs: Set<number>;
}

export function partitionTargetScopedAcknowledgedMessages(input: TargetScopedAckPartitionInput): AckPartitionResult {
  const removed: AgentMessage[] = [];
  const retained: AgentMessage[] = [];

  for (const message of input.inbox) {
    if (message.channel_id === input.channelId && message.seq && input.ackedSeqs.has(message.seq)) {
      removed.push(message);
    } else {
      retained.push(message);
    }
  }

  return { removed, retained };
}

export interface TargetScopedAckUpToSeqPartitionInput {
  inbox: AgentMessage[];
  channelId: string;
  maxSeq: number;
}

export function partitionTargetScopedMessagesUpToSeq(input: TargetScopedAckUpToSeqPartitionInput): AckPartitionResult {
  const removed: AgentMessage[] = [];
  const retained: AgentMessage[] = [];

  for (const message of input.inbox) {
    if (message.channel_id === input.channelId && message.seq && message.seq <= input.maxSeq) {
      removed.push(message);
    } else {
      retained.push(message);
    }
  }

  return { removed, retained };
}

export interface LocalInboxEnqueuePlanInput {
  hasSeqDuplicate: boolean;
  hasMessageIdDuplicate: boolean;
}

export type LocalInboxEnqueuePlanAction = "enqueue" | "skip-duplicate";

export function planLocalInboxEnqueueAction(input: LocalInboxEnqueuePlanInput): LocalInboxEnqueuePlanAction {
  return input.hasSeqDuplicate || input.hasMessageIdDuplicate ? "skip-duplicate" : "enqueue";
}

export interface LocalDeliveryGatePlanInput {
  hasAgent: boolean;
  status: AgentStatus | null;
  machineMatches: boolean;
}

export type LocalDeliveryGatePlanAction = "deliver-locally" | "drop-delivery";

export function planLocalDeliveryGateAction(input: LocalDeliveryGatePlanInput): LocalDeliveryGatePlanAction {
  if (!input.hasAgent) {
    return "drop-delivery";
  }
  return input.status === "active" && input.machineMatches ? "deliver-locally" : "drop-delivery";
}

export interface RoutedOwnershipPlanInput {
  machineIsLocal: boolean;
  canReroute: boolean;
}

export type RoutedOwnershipPlanAction =
  | "handle-locally"
  | "reroute-then-fallback"
  | "fallback";

export function planRoutedOwnershipAction(input: RoutedOwnershipPlanInput): RoutedOwnershipPlanAction {
  if (input.machineIsLocal) {
    return "handle-locally";
  }
  return input.canReroute ? "reroute-then-fallback" : "fallback";
}

interface StopApplyContext {
  agentId: string;
  serverId: string;
  machineId: string | null;
  reason: StopAgentReason;
  previousStatus: AgentStatus;
  nextStatus: AgentStatus;
}

interface WakeApplyContext {
  agentId: string;
  machineId: string | null;
  previousStatus: AgentStatus;
  resetMode: "restart" | "session" | "full" | null;
  transient?: boolean;
  requireQueueReceipt?: boolean;
  mentionDeliveryOccurrenceId?: string;
}

interface DirectDeliveryContext {
  agentId: string;
  machineId: string | null;
  /**
   * Require proof that this server established replayable inbox state before
   * returning `queued`. Redis pub/sub publication alone does not satisfy this:
   * the target replica may have no subscriber or may reject the enqueue after
   * revalidating agent state/access.
   */
  requireQueueReceipt?: boolean;
  /**
   * Skip the replayable inbox enqueue and just do a best-effort ws send.
   * Used for transient wakes where:
   *   - the wake doesn't have a `seq` allocated from `messages.seq`, so the
   *     inbox can't ack/remove it (`partitionAcknowledgedMessages` requires
   *     truthy seq), and
   *   - re-delivering on reconnect would be wrong: the audit lives in
   *     `reminder_events`, the owner sees fire history via the reminder UI,
   *     and a missed wake is recoverable on the agent's own initiative.
   */
  transient?: boolean;
  mentionDeliveryOccurrenceId?: string;
}

/**
 * Options for `agentOrchestrator.deliverMessage`.
 */
export interface DeliverMessageOptions {
  /** Skip the replayable inbox; ws-send only. See `DirectDeliveryContext.transient`. */
  transient?: boolean;
  /**
   * Return `queued` only when this process can prove replayable inbox state was
   * established. Cross-replica pub/sub remains best-effort until it has a
   * target-side typed acknowledgement.
   */
  requireQueueReceipt?: boolean;
  /**
   * Bypass the `inbox:receive` scope gate because the delivery was initiated by
   * a server owner/admin. This keeps a human authority lane open even when an
   * agent's ordinary inbox notifications are disabled.
   */
  adminAuthority?: boolean;
  /**
   * Bypass the `inbox:receive` scope gate. Set by intrinsic deliveries that
   * the agent cannot opt out of: reminder fire wakes, action-card execution
   * notices, and other author-owned events about the agent's own state.
   *
   * Default false — chat / in-channel system / task message deliveries all
   * gate by `inbox:receive`. This is intentionally separate from
   * `message:read`: read gates active CLI/history access; inbox:receive gates
   * passive server delivery and wake.
   *
   * The "intrinsic" lane is the same model as Discord gateway intents vs
   * session events: inbox receive gates other-principal content; the bot always
   * gets its own session/lifecycle events. In Slock terms, channel
   * messages are other-principal content (gated); reminder fires and
   * action-card notices are author-owned (intrinsic).
   */
  intrinsic?: boolean;
  /**
   * Replace a queued same-seq `non_member_mention` projection after the
   * recipient has authoritatively become a channel member. This must only be
   * set by the membership transaction; an ordinary replay without the marker
   * remains strict dedupe and cannot infer a capability upgrade.
   */
  reconcileNonMemberMention?: boolean;
  /** Stable message_mentions.id for the one durable mention occurrence. */
  mentionDeliveryOccurrenceId?: string;
}

/** Server-side handoff receipt. `queued` never proves daemon/model consumption. */
export type AgentMessageDeliveryResult =
  | {
      status: "queued";
      reason: "external_inbox" | "control_gate_inbox" | "wake_accepted" | "replayable_inbox" | "direct_dispatch";
    }
  | {
      status: "dropped";
      reason:
        | "agent_unavailable"
        | "passive_scope_revoked"
        | "target_access_changed"
        | "transient_delivery_unsupported"
        | "reset_in_progress"
        | "wake_failed"
        | "wake_suppressed"
        | "cross_replica_receipt_unavailable"
        | "agent_state_changed";
    };

function normalizeRoutedInboxDeliveryReceipt(
  receipt: RoutedInboxDeliveryReceipt,
): AgentMessageDeliveryResult {
  if (receipt.status === "queued") {
    const reason = receipt.reason;
    if (
      reason === "external_inbox"
      || reason === "control_gate_inbox"
      || reason === "wake_accepted"
      || reason === "replayable_inbox"
      || reason === "direct_dispatch"
    ) {
      return { status: "queued", reason };
    }
    return { status: "dropped", reason: "cross_replica_receipt_unavailable" };
  }

  const reason = receipt.reason;
  if (
    reason === "agent_unavailable"
    || reason === "passive_scope_revoked"
    || reason === "target_access_changed"
    || reason === "transient_delivery_unsupported"
    || reason === "reset_in_progress"
    || reason === "wake_failed"
    || reason === "wake_suppressed"
    || reason === "cross_replica_receipt_unavailable"
    || reason === "agent_state_changed"
  ) {
    return { status: "dropped", reason };
  }
  return { status: "dropped", reason: "cross_replica_receipt_unavailable" };
}

interface LocalInboxApplyContext {
  inbox: AgentInbox;
  message: AgentMessage;
  notifyPendingReceive?: boolean;
}

interface LocalDeliveryGateApplyContext {
  action: LocalDeliveryGatePlanAction;
  agentId: string;
  message: AgentMessage;
}

interface SendToMachineApplyContext {
  action: SendToMachinePlanAction;
  machineId: string;
  msg: ServerToMachineMessage;
  sendLocally: () => boolean;
  reroute: () => Promise<boolean | MachineCommandRouteResult>;
  onRouteResult?: (result: MachineCommandRouteResult) => void;
}

interface ReceiveApplyContext {
  agentId: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface RoutedOwnershipApplyContext {
  action: RoutedOwnershipPlanAction;
  handleLocally: () => boolean | Promise<boolean>;
  rerouteToCurrentOwner: () => Promise<boolean>;
  fallback: () => boolean | Promise<boolean>;
}

export interface ReadyReconcilePlanInput {
  status: AgentStatus;
  running: boolean;
  resetMode: "restart" | "session" | "full" | null;
}

export type ReadyReconcilePlanAction =
  | "force-stop-and-stay-offline"
  | "mark-active-online"
  | "mark-wakeable-not-running"
  | "mark-inactive-offline"
  | "stay-offline";

export function planReadyReconcileAction(input: ReadyReconcilePlanInput): ReadyReconcilePlanAction {
  if (input.running) {
    if (input.status === "stopped" || input.resetMode) {
      return "force-stop-and-stay-offline";
    }
    return "mark-active-online";
  }

  if (input.status !== "active") {
    return "stay-offline";
  }

  // Missing from daemon ready means the runtime process is absent, not that the
  // agent was manually stopped. Keep active agents wakeable unless a reset gate
  // is deliberately draining the old process/session.
  return input.resetMode ? "mark-inactive-offline" : "mark-wakeable-not-running";
}

export interface ResetPlanInput {
  mode: "restart" | "session" | "full";
  hasMachine: boolean;
  restart?: boolean;
}

export type ResetPlanAction = "stop-internal" | "clear-session" | "reset-workspace" | "restart";

export function planResetActions(input: ResetPlanInput): ResetPlanAction[] {
  const actions: ResetPlanAction[] = ["stop-internal"];

  if (input.mode === "session" || input.mode === "full") {
    actions.push("clear-session");
  }

  if (input.mode === "full" && input.hasMachine) {
    actions.push("reset-workspace");
  }

  if (input.restart !== false) {
    actions.push("restart");
  }
  return actions;
}

export function normalizeDaemonAgentStatus(status: string): DaemonReportedAgentStatus {
  if (status === "sleeping") return "active";
  return status === "active" || status === "inactive" ? status : null;
}

export interface LifecycleEventAcceptanceInput {
  launchGuardMode: "legacy" | "guarded";
  expectedLaunchId: string | null;
  launchId?: string;
}

export type LifecycleEventAcceptanceAction =
  | "accept"
  | "ignore-legacy-for-guarded"
  | "ignore-stale-launch";

type MachineAgentValidationDropReason =
  | "missing_server_context"
  | "unknown_agent"
  | "machine_or_server_mismatch";

type MachineAgentValidationResult =
  | { agent: CachedAgentState; dropReason: null }
  | { agent: null; dropReason: MachineAgentValidationDropReason };

type ActivityIngestionDropReason =
  | MachineAgentValidationDropReason
  | "legacy_lifecycle_event"
  | "stale_launch_guard"
  | "agent_stopped"
  | "reset_window"
  | "activity_plan_ignore"
  | "stale_client_seq"
  | "unknown_activity_detail_kind"
  | "non_fact_activity_detail_kind"
  | "kimi_activity_circuit_breaker";

const DAEMON_INGRESS_RATE_LIMITED_MESSAGE_TYPES = new Set<MachineToServerMessage["type"]>([
  "agent:status",
  "agent:activity",
  "agent:session",
  "agent:session:invalidate",
  "agent:runtime_profile",
  "agent:runtime_profile:migration:ack",
  "agent:runtime_profile:migration_done",
  "agent:runtime_profile:daemon_release_notice:ack",
  // RFC 071: a best-effort notice, not an outbox entry. The outbox entries
  // (RUNTIME_OUTCOME_OUTBOX_MESSAGE_TYPES) are deliberately NOT listed: a drop
  // would stall that agent's queue (no ack) or lose evidence (ack), and the
  // daemon's stop-and-wait already bounds their rate.
  "agent:runtime:outcome_unreliable",
]);

type DaemonIngressRateLimitWindow = {
  startedAt: number;
  count: number;
  droppedCount: number;
};

type DaemonIngressRateLimitScope = "message_type" | "machine_total";

type DaemonIngressRateLimitTraceAttrs = {
  scope: DaemonIngressRateLimitScope;
  limit: number;
  messageType?: MachineToServerMessage["type"];
};

type DaemonIngressRateLimitDecision =
  | { action: "allow"; aggregateDrops?: Array<DaemonIngressRateLimitTraceAttrs & { aggregateDroppedCount: number }> }
  | { action: "drop"; droppedCount: number; retryAfterMs: number; trace: boolean; attrs: DaemonIngressRateLimitTraceAttrs };

type DaemonIngressRateLimitBucketDecision =
  | { action: "allow"; aggregateDrop?: DaemonIngressRateLimitTraceAttrs & { aggregateDroppedCount: number } }
  | { action: "drop"; droppedCount: number; retryAfterMs: number; trace: boolean; attrs: DaemonIngressRateLimitTraceAttrs };

type KimiActivityCircuitState = {
  emittedSignatures: Set<string>;
  lastEmittedAt: number;
  lastObservedAt: number;
  suppressedCount: number;
};

type KimiActivityCircuitDecision =
  | { action: "allow"; aggregateSuppressedCount?: number }
  | { action: "suppress"; suppressedCount: number };

function isStartIntentOwnerMoved(error: unknown): boolean {
  return error instanceof StartIntentOwnerMovedError
    || (error instanceof StartIntentRemoteError && error.failure.name === START_INTENT_OWNER_MOVED);
}

/**
 * Rethrow a routed-intent failure with the class callers already branch on, so
 * routes keep answering 409 machine_offline / 504 daemon_timeout instead of a
 * generic 500 when the owner is gone, slow or moved.
 */
/**
 * How runOnOwner placed an agent operation. `local_machine`, `self_owner`,
 * `no_machine` and `no_replica_state` run here by design; the fallbacks run
 * here only because the owner could not be used.
 */
type OwnerRouteDecision =
  | "routed"
  | "route_failed"
  | "local_machine"
  | "self_owner"
  | "no_machine"
  | "no_replica_state"
  | "no_owner"
  | "owner_without_intents"
  | "lookup_failed";

const OWNER_ROUTE_FALLBACKS: ReadonlySet<OwnerRouteDecision> = new Set(["no_owner", "owner_without_intents", "lookup_failed"]);

function rehydrateStartIntentError(error: unknown): unknown {
  if (error instanceof StartIntentTimeoutError) return new RouteFailureError("daemon_timeout", error.message);
  if (error instanceof StartIntentTransportError) return new RouteFailureError("daemon_offline", error.message);
  if (isStartIntentOwnerMoved(error)) return new RouteFailureError("daemon_offline", (error as Error).message);
  if (!(error instanceof StartIntentRemoteError)) return error;
  const { name, message, subkind } = error.failure;
  if (name === "RouteFailureError" && subkind) {
    try {
      return new RouteFailureError(subkind as ConstructorParameters<typeof RouteFailureError>[0], message);
    } catch {
      return error;
    }
  }
  if (name === "CrossReplicaQueueReceiptUnavailableError") return new CrossReplicaQueueReceiptUnavailableError();
  return error;
}

function daemonActivityJoinTraceAttrs(msg: Extract<MachineToServerMessage, { type: "agent:activity" }>): Record<string, unknown> {
  return {
    ...(typeof msg.launchId === "string" ? { launchId: msg.launchId, launch_id: msg.launchId } : {}),
    launch_id_present: typeof msg.launchId === "string",
    ...(typeof msg.daemonInstanceId === "string"
      ? { daemonInstanceId: msg.daemonInstanceId, daemon_instance_id: msg.daemonInstanceId }
      : {}),
    daemon_instance_id_present: typeof msg.daemonInstanceId === "string",
    activity_sequence_generation: typeof msg.daemonInstanceId === "string"
      ? "daemon_instance"
      : "legacy_server_epoch",
    ...(typeof msg.clientSeq === "number" ? { clientSeq: msg.clientSeq, client_seq: msg.clientSeq } : {}),
    client_seq_present: typeof msg.clientSeq === "number",
    ...(typeof msg.probeId === "string" ? { probe_id_present: true } : { probe_id_present: false }),
    ...(typeof msg.producerFactId === "string"
      ? {
          producerFactId: msg.producerFactId,
          producer_fact_id: msg.producerFactId,
        }
      : {}),
    // REDUNDANT, not independent: when this is true the raw `producer_fact_id`
    // is on this same span, just above. Kept under case 2 of the #422 item-3
    // rule (@Leiysky) — a flag is only a defect when it claims a value that is
    // not on the surface, which is the daemon's case, not this one.
    producer_fact_id_present: typeof msg.producerFactId === "string",
    ...(typeof msg.isHeartbeat === "boolean" ? { is_heartbeat: msg.isHeartbeat } : {}),
    correlation_id: typeof msg.producerFactId === "string"
      ? msg.producerFactId
      : `agent:${msg.agentId}:daemonActivity:${msg.launchId ?? "legacy"}:${msg.clientSeq ?? "unsequenced"}`,
  };
}

function daemonActivityDropRowAttrs(input: {
  atMs: number;
  observationClass: LifecycleObservationClass;
  probeIdPresent?: boolean;
}): Record<string, unknown> {
  if (input.probeIdPresent === true) {
    return {
      event_kind: "activity_snapshot",
      source: "activity_probe",
      authority: "activity_probe",
      observation_class: "liveness_observation",
      advances_observed_clock: "none",
      shadow_observation_class: "liveness_observation",
    };
  }
  if (input.observationClass === "replayed") {
    return {
      event_kind: "activity_replayed",
      source: "replay_tooling",
      authority: "replay_tooling",
      observation_class: "activity_replay",
      advances_observed_clock: "none",
      shadow_observation_class: "activity_replay",
    };
  }
  if (input.observationClass === "observed") {
    return {
      event_kind: "activity_observed",
      source: "daemon_runtime",
      authority: "daemon_runtime",
      observation_class: "activity_assertion",
      activity_observed_at_ms: input.atMs,
      advances_observed_clock: "activity",
      shadow_observation_class: "activity_assertion",
    };
  }
  if (input.observationClass === "observed_turn_active") {
    return {
      event_kind: "turn_active",
      source: "daemon_runtime",
      authority: "observed_turn_active",
      observation_class: "observed_turn_active",
      activity_observed_at_ms: input.atMs,
      advances_observed_clock: "activity",
      shadow_observation_class: "observed_turn_active",
    };
  }
  return {
    event_kind: "synthetic_repair",
    source: "scheduler_repair",
    authority: "scheduler_repair",
    observation_class: "synthetic_diagnostic",
    advances_observed_clock: "none",
    shadow_observation_class: "synthetic_diagnostic",
  };
}

export function planLifecycleEventAcceptance(
  input: LifecycleEventAcceptanceInput,
): LifecycleEventAcceptanceAction {
  if (input.launchGuardMode !== "guarded" || !input.expectedLaunchId) {
    return "accept";
  }

  if (!input.launchId) {
    return "ignore-legacy-for-guarded";
  }

  if (input.launchId !== input.expectedLaunchId) {
    return "ignore-stale-launch";
  }

  return "accept";
}

export function supportsLaunchGuardForDaemonVersion(version: string | null): boolean {
  if (!version) return false;
  // Strip pre-release suffixes (e.g. "0.30.1-alpha.1" -> "0.30.1")
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  // launchId was introduced in 0.30.1 (PR #518)
  if (major > 0) return true;
  if (minor > 30) return true;
  if (minor === 30 && patch >= 1) return true;
  return false;
}

function narrowPersistedAgentStatus(status: string): AgentStatus | null {
  return status === "active" || status === "inactive" || status === "stopped"
    ? status
    : null;
}

export function narrowReadyReconcileStatus(status: string): AgentStatus | null {
  return narrowPersistedAgentStatus(status);
}

type ReadyReconcileAgent = Awaited<ReturnType<AgentOrchestrator["loadAgentsForReadyReconcile"]>>[number];
type ActivityProducer = "lifecycle" | "slock_cli" | "runtime_tool" | "control" | "message_io";

interface ActivityProducerEvent {
  producer: ActivityProducer;
  summary: string;
  outcome?: "started" | "succeeded" | "failed";
  command?: string;
  target?: string;
  correlationId?: string;
}

interface MappedExternalPluginActivity {
  activity: AgentActivity;
  detail: string;
  entries: TrajectoryEntry[];
  occurredAtMs?: number;
  dedupeKey?: string;
}

export function mapExternalPluginActivityEvent(event: ExternalAgentActivityEvent): MappedExternalPluginActivity | null {
  const hookEventName = externalActivityString(event.hookEventName ?? event.hook_event_name, 80);
  const eventId = externalActivityString(event.eventId ?? event.event_id, 160);
  if (!hookEventName || !eventId) return null;

  const producerFactId = buildExternalPluginProducerFactId(eventId);
  const toolName = externalActivityString(event.toolName ?? event.tool_name, EXTERNAL_AGENT_ACTIVITY_TOOL_NAME_LIMIT) ?? "tool";
  const detail = getToolActivityLabel(toolName);
  const occurredAtMs = externalActivityTimeMs(event.occurredAt ?? event.occurred_at);
  const dedupeKey = externalAgentActivityDedupeKey(eventId);

  if (hookEventName === "BridgeFatal") {
    const errorClass = externalActivityString(event.errorClass ?? event.error_class, 120) ?? "BridgeFatal";
    const output = truncateExternalActivityText(
      event.toolOutput ?? event.tool_output ?? "",
      event.toolOutputTruncated ?? event.tool_output_truncated ?? event.truncated,
    );
    const detail = `Bridge fatal: ${errorClass}`;
    return {
      activity: "error",
      detail,
      entries: [{
        kind: "status",
        activity: "error",
        activityKind: "error",
        detail,
        detailKind: "external_activity",
        producerFactId,
      }, {
        kind: "system",
        title: "Bridge fatal",
        text: [errorClass, output.text].filter(Boolean).join("\n"),
        producerFactId,
      }],
      occurredAtMs,
      dedupeKey,
    };
  }

  if (hookEventName === "PreToolUse") {
    const input = truncateExternalActivityText(
      event.toolInput ?? event.tool_input ?? "",
      event.toolInputTruncated ?? event.tool_input_truncated ?? event.truncated,
    );
    return {
      activity: "working",
      detail,
      entries: [{
        kind: "tool_start",
        toolName,
        toolInput: input.text,
        producerFactId,
      }],
      occurredAtMs,
      dedupeKey,
    };
  }

  if (hookEventName === "PostToolUse" || hookEventName === "PostToolUseFailure") {
    const output = truncateExternalActivityText(
      event.toolOutput ?? event.tool_output ?? "",
      event.toolOutputTruncated ?? event.tool_output_truncated ?? event.truncated,
    );
    const errorClass = externalActivityString(event.errorClass ?? event.error_class, 120);
    const title = hookEventName === "PostToolUseFailure" ? `Tool failed: ${toolName}` : `Tool output: ${toolName}`;
    const text = [errorClass, output.text].filter(Boolean).join("\n");
    return {
      activity: "working",
      detail,
      entries: [{
        kind: "system",
        title,
        text,
        producerFactId,
      }],
      occurredAtMs,
      dedupeKey,
    };
  }

  if (hookEventName === "PostToolBatch") {
    return {
      activity: "working",
      detail: "Tool batch complete",
      entries: [{
        kind: "status",
        activity: "working",
        activityKind: "working",
        detail: "Tool batch complete",
        detailKind: "external_activity",
        producerFactId,
      }],
      occurredAtMs,
      dedupeKey,
    };
  }

  if (hookEventName === "UserPromptSubmit") {
    return {
      activity: "working",
      detail: "Message received",
      entries: [{
        kind: "status",
        activity: "working",
        activityKind: "working",
        detail: "Message received",
        detailKind: "message_received",
        producerFactId,
      }],
      occurredAtMs,
      dedupeKey,
    };
  }

  if (hookEventName === "Stop" || hookEventName === "SessionStart" || hookEventName === "SessionEnd") {
    const activity: AgentActivity = hookEventName === "SessionEnd" ? "offline" : "online";
    const detailText = hookEventName === "SessionEnd" ? "Session ended" : "";
    return {
      activity,
      detail: detailText,
      entries: [{
        kind: "status",
        activity,
        activityKind: activity,
        detail: detailText,
        detailKind: hookEventName === "SessionEnd" ? "stopped" : "ready",
        producerFactId,
      }],
      occurredAtMs,
      dedupeKey,
    };
  }

  return null;
}

function truncateExternalActivityText(value: unknown, alreadyTruncated?: unknown): { text: string; truncated: boolean } {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const marker = "\n[truncated]";
  const shouldMark = Boolean(alreadyTruncated);
  if (text.length > EXTERNAL_AGENT_ACTIVITY_TEXT_LIMIT) {
    return {
      text: `${text.slice(0, Math.max(0, EXTERNAL_AGENT_ACTIVITY_TEXT_LIMIT - marker.length))}${marker}`,
      truncated: true,
    };
  }
  if (shouldMark && !text.includes("[truncated]")) {
    const marked = `${text}${marker}`;
    return {
      text: marked.length > EXTERNAL_AGENT_ACTIVITY_TEXT_LIMIT
        ? `${marked.slice(0, Math.max(0, EXTERNAL_AGENT_ACTIVITY_TEXT_LIMIT - marker.length))}${marker}`
        : marked,
      truncated: true,
    };
  }
  return { text, truncated: shouldMark };
}

function externalActivityString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function externalActivityTimeMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function normalizeExternalActivityDroppedCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function externalAgentActivityDedupeKey(eventId: string): string {
  return `external-agent-activity:${eventId}`;
}

type PlannedExternalActivityEvent =
  | { kind: "hook"; mapped: MappedExternalPluginActivity }
  | {
    kind: "status";
    eventId: string;
    status: RaftAgentStatus;
    detail: string;
    occurredAtMs: number;
    mapped: MappedExternalPluginActivity | null;
  };

function buildExternalStatusProducerFactId(eventId: string): string {
  const safe = eventId.replace(/[^A-Za-z0-9_:/-]/g, "_").slice(0, 160) || "unknown";
  return `external/status-reported:${safe}`;
}

function buildExternalPluginProducerFactId(eventId: string): string {
  const safe = eventId.replace(/[^A-Za-z0-9_:/-]/g, "_").slice(0, 160) || "unknown";
  return `${EXTERNAL_AGENT_ACTIVITY_PROVENANCE}:${safe}`;
}

type ResetApplyContext = {
  agentId: string;
  serverId: string | null;
  mode: "restart" | "session" | "full";
  previousStatus: AgentStatus | null;
  machineId: string | null;
  /** RFC 071 §5: this reset is an E3 (a human reset, or a real runtime-config change). */
  terminalControl?: "human_reset" | "runtime_config_changed";
};

export interface AgentLifecycleEvent {
  at: number;
  agentId: string;
  machineId: string | null;
  action: AgentLifecycleAction;
  outcome: AgentLifecycleOutcome;
  cause: AgentLifecycleCause;
  previousStatus?: AgentStatus | null;
  nextStatus?: AgentStatus | null;
  detail?: string;
}

type AgentLifecycleRingBuffer = {
  events: AgentLifecycleEvent[];
  nextIndex: number;
  size: number;
};

/**
 * Classification of one best-effort built-in App transport send. The variant
 * fields double as the transport span's attributes: a result spreads directly
 * onto the span. `send_skipped` marks a send that was never attempted because
 * the snapshot composition itself failed.
 *
 * `send_failed.reason` value domain (verified against ws@8.20 + replicaRouter):
 * - `machine_unreachable` — sendToMachine returned false (no ready connection
 *   / reroute unavailable), or ws.send() sync-threw its not-open Error (the
 *   socket is mid-handshake; ws only sync-throws while CONNECTING, CLOSING /
 *   CLOSED go through an async error event instead). Both mean "connection
 *   unready", not a code fault.
 * - `send_threw` — any other exception. `error_class` then carries the
 *   bounded identity via `errorClassOf` (exception name; `""` names and
 *   non-Error throws route to sentinels — "unknown" / typeof strings). Named
 *   replica-router error classes never reach here: the reroute branch
 *   swallows its own errors in applySendToMachineAction.
 */
type AppTransportSendResult =
  | { outcome: "sent" }
  | { outcome: "send_skipped"; reason: "snapshot_failed" }
  | { outcome: "send_failed"; reason: "machine_unreachable" | "send_threw"; error_class?: string };

/**
 * A persisted chat message: it has a durable row (a positive seq) and can be
 * re-read from the agent's inbox. Third-party app events and other notices
 * without a durable row are not.
 */
export function isDurableAgentInboxMessage(message: AgentMessage): boolean {
  return Number.isInteger(message.seq) && (message.seq ?? 0) > 0 && !message.third_party_event;
}

/**
 * AgentOrchestrator routes agent commands to the appropriate machine via WebSocket.
 */
export class AgentOrchestrator extends EventEmitter {
  private io: SocketServer | null = null;
  private machineConnections = new Map<string, MachineConnection>();
  private machineCatalogAuthority = new MachineCatalogAuthority((machineId) => {
    const conn = this.machineConnections.get(machineId);
    return conn?.replicaGeneration
      ? {
          connectionEpochId: conn.connectionEpochId,
          replicaGeneration: conn.replicaGeneration,
        }
      : null;
  });
  // Latest capabilities write we still owe the DB, per machine. Present only
  // while a persist is in flight or awaiting a backoff retry; deleted once it
  // lands (or the connection is cleared). See enqueueCapabilitiesPersist.
  private capabilitiesWrites = new Map<string, CapabilitiesWriteState>();
  // Monotonic per-machine generation counter. NEVER reset when a write entry is
  // cleared, so a generation value is never reused for the same machine — this
  // is what makes an ABA match (an old in-flight generation coinciding with a
  // freshly-created entry) impossible. Swept only on shutdown.
  private capabilitiesGenerationSeq = new Map<string, number>();
  private legacyPrincipalFences = new Set<string>();
  /** Set once this task starts draining (task #268). The drain going-away
   * closes a snapshot of the connections it finds; a daemon that reconnects
   * to this same task during the seconds before the ALB deregisters it would
   * not be in that snapshot and would be hard-cut with 1006 at the
   * deregistration-delay expiry, which is the failure the drain exists to
   * remove. So a draining task refuses new machine connections with the same
   * 1001 `server_draining`, and the daemon's normal reconnect lands elsewhere. */
  private drainingMachineConnections = false;
  private drainRefusedMachineConnections = 0;
  private machineStatusVersions = new Map<string, number>();
  private pendingMachineDisconnects = new Map<string, PendingMachineDisconnectProjection>();
  private pendingAgentSkillsListRequests = new Map<string, PendingAgentSkillsListRequest>();
  private pendingAgentDeliveryAcks = new Map<string, PendingAgentDeliveryAck>();
  private pendingAgentStartAcks = new Map<string, PendingAgentStartAck>();
  private terminalAgentStartDispatches = new Map<string, AgentStartDispatchTerminalReason>();
  private agentInboxes = new Map<string, AgentInbox>();
  private agentActivity = new Map<string, ActivitySnapshot>();
  /**
   * task #1116: carrier captured from an accepted `agent:activity` frame with
   * detailKind "delivery_unconsumed", consumed by the very next snapshot write
   * for that agent (attached when that write is delivery_unconsumed, dropped
   * otherwise). Never read for any decision.
   */
  private pendingDeliveryConsumption = new Map<string, DeliveryConsumptionActivityDiagnostic>();
  /**
   * task #1119: automatic-wake crash-loop breaker. Consulted before every
   * non-human start; fed by dispatched starts and by early exits (daemon
   * process exit / runner disconnect). Process-local like the wake lock's
   * intent: a replica failover starts a fresh episode.
   */
  /**
   * task #1119: episode state lives in the replica state store (CAS), so a block
   * survives a replica switch and only a human start/resume clears it.
   */
  private readonly wakeCrashLoopBreaker: WakeCrashLoopBreaker;
  /** task #1228 ①: timed-out feedback transcript requests whose late result is still recorded. */
  private readonly feedbackTranscriptLateResults = new FeedbackTranscriptLateResults(() => this.clock.now());
  /** RFC 071 part 3: commits outbox frames (state + watermark in one write) before they are acked. */
  private readonly terminalFailureBreaker = new TerminalFailureBreaker(redisTerminalFailureBreakerStore);
  /** RFC 071 §9: the last block shown per agent, so a block is projected once. */
  private readonly projectedTerminalBlocks = new Map<string, string>();
  /** RFC 071 part 3: handle outbox frames only when the server advertises the ack capability (dormant). */
  private readonly runtimeOutcomeAckEnabled: boolean = RUNTIME_OUTCOME_ACK_ENABLED;
  /** task #1119: carrier captured at block time, attached by the next snapshot write of that kind. */
  private pendingWakeCrashLoop = new Map<string, WakeCrashLoopActivityDiagnostic>();
  /**
   * task #1123: typed spawn-failure carrier captured at ingest, attached on the
   * runtime_unavailable snapshot write. `null` records that the frame CARRIED NO
   * carrier (e.g. a probe response "Agent not running" from the same daemon),
   * which must clear the previous one rather than inherit it: a new fact
   * without a carrier is not the same observation (XX, #7793 review).
   */
  private pendingSpawnFailure = new Map<string, SpawnFailureActivityDiagnostic | null>();
  private activityDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private agentStateCache = new Map<string, CachedAgentState>();
  private resetInProgress = new Map<string, "restart" | "session" | "full">();
  private lastReadyOnlineBroadcastAt = new Map<string, number>();
  private lifecycleEventsByAgent = new Map<string, AgentLifecycleRingBuffer>();
  private staleActivityTimer: unknown | null = null;
  /**
   * In-flight activity probes keyed by probeId. Each entry holds the
   * fallback timer that fires synth-online if the daemon never replies
   * (legacy sweep behaviour) and the snapshot time used to detect
   * "fresh organic activity arrived" without the probe needing to
   * complete. Cleared by handleActivityProbeResponse on probe-response
   * or by the timer's own callback on timeout.
   */
  private pendingActivityProbes = new Map<
    string,
    { agentId: string; startedAt: number; fallbackTimer: ReturnType<typeof setTimeout> }
  >();

  /**
   * Ingest dedup state for `agent:activity` from daemons, keyed by
   * `${agentId}:daemon:${daemonInstanceId}:launch:${launchId|legacy}` for
   * current daemons, `${agentId}:launch:${launchId}` for older daemons with a
   * launch id, or
   * `${agentId}:legacy:${serverIngestEpoch}` for legacy/no-launch frames.
   * Stores the highest `clientSeq` seen for that key. New launchId resets
   * naturally; server-controlled starts/resets/internal stop boundaries also
   * advance the legacy ingest epoch so no-launch daemons can re-baseline their
   * clientSeq clock without preserving stale watermarks from the previous
   * runtime generation. Launch-present frames intentionally do not use the
   * legacy epoch; same-launch replay protection must survive lifecycle churn.
   * (#engineering:72283cf7 task #340 PR B, #proj-o11y task #180)
   */
  private lastClientSeqByActivityIngestKey = new Map<string, number>();
  private activityIngestEpochByAgent = new Map<string, number>();
  /**
   * External agents known to have adopted raft-agent-status.v1
   * (`agents.status_protocol_adopted_at`). The flag only ever goes NULL -> set,
   * so a positive read is cached for the process lifetime; a negative read is
   * never cached, so an adoption accepted on another replica takes effect on
   * this one at the next `/activity` batch.
   */
  private statusProtocolAdoptedAgents = new Set<string>();
  private activityDaemonGenerationsByAgent = new Map<string, string[]>();
  private kimiActivityCircuitByLaunch = new Map<string, KimiActivityCircuitState>();
  private daemonIngressRateLimitWindows = new Map<string, DaemonIngressRateLimitWindow>();
  private daemonIngressTotalRateLimitWindows = new Map<string, DaemonIngressRateLimitWindow>();
  private lastIngressReplicaRefreshAt = new Map<string, number>();

  /**
   * Last `serverSeq` this replica emitted on an outbound `agent:activity`
   * socket push (one value for all agents). The client drops pushes whose seq
   * is not above the last one it saw for that agent. The seq is wall-clock
   * based (`nextActivityServerSeq`), so a push from another replica or after
   * a restart still compares newer; a per-replica counter starting at 1 made
   * the client drop every push after the daemon moved replicas.
   */
  private lastActivityServerSeq = 0;
  /** RFC 069 §8: last applied sequenced status per agent. */
  private sequencedStatusVersions = new Map<string, SequencedStatusVersion>();
  private runtimeProfileHeartbeatNudgeSentAt = new Map<string, number>();

  /** Max seconds a transient activity (working/thinking) can stay before auto-reset */
  private static ACTIVITY_STALE_SEC = 90;
  /**
   * Soft timeout for an `agent:activity_probe` round-trip. If the
   * daemon doesn't respond within this window, the sweep falls back
   * to the legacy synth-online behaviour. Tuned so a single missed
   * sweep cycle (30s) plus normal WS RTT plus daemon `respondToActivityProbe`
   * processing time fits comfortably; if the daemon is genuinely
   * stuck/unreachable, fallback fires as before.
   * Introduced 2026-05-02 #engineering:72283cf7 task #340.
   */
  private static ACTIVITY_PROBE_TIMEOUT_MS = 5_000;
  private static RUNTIME_PROFILE_MIGRATION_NUDGE_AFTER_MS = 5 * 60_000;
  private static RUNTIME_PROFILE_MIGRATION_NUDGE_INTERVAL_MS = 15 * 60_000;
  private static RUNTIME_PROFILE_MIGRATION_MAX_NUDGES = 3;
  private static RUNTIME_PROFILE_HEARTBEAT_NUDGE_COOLDOWN_MS = 24 * 60 * 60_000;
  private static MACHINE_HEARTBEAT_TIMEOUT_MS = 60_000;
  private static AGENT_DELIVERY_ACK_TIMEOUT_MS = 5_000;
  private static AGENT_DELIVERY_ACK_MAX_ATTEMPTS = 24;
  private static AGENT_START_ACK_TIMEOUT_MS = 5_000;
  private static AGENT_START_ACK_MAX_ATTEMPTS = 24;
  private static AGENT_START_TERMINAL_CACHE_SIZE = 1_024;
  /** Debounce window for activity broadcasts (ms) */
  private static ACTIVITY_DEBOUNCE_MS = 200;
  private static KIMI_ACTIVITY_CIRCUIT_WINDOW_MS = 30_000;
  private static KIMI_ACTIVITY_CIRCUIT_AGGREGATE_MS = 60_000;
  private static DAEMON_INGRESS_RATE_LIMIT_DEFAULT_WINDOW_MS = 10_000;
  private static DAEMON_INGRESS_RATE_LIMIT_DEFAULT_MAX_EVENTS = 2_000;
  private static DAEMON_INGRESS_RATE_LIMIT_DEFAULT_MAX_EVENTS_PER_MACHINE = 3_000;
  private static INGRESS_REPLICA_REFRESH_MIN_INTERVAL_MS = 15_000;
  private static ACTIVITY_DAEMON_GENERATIONS_PER_AGENT = 4;
  /** Retain a small recent lifecycle buffer for debugging/tests without introducing persistence yet. */
  private static MAX_LIFECYCLE_EVENTS = 500;
  private readonly daemonIngressRateLimitWindowMs: number;
  private readonly daemonIngressRateLimitMaxEvents: number;
  private readonly daemonIngressRateLimitMaxEventsPerMachine: number;
  private readonly daemonIngressRateLimitDisabled: boolean;

  constructor(
    private readonly replicaStateStore: ReplicaStateStore = redisReplicaStateStore,
    private readonly clock: OrchestratorClock = systemOrchestratorClock,
    private readonly tracer: Tracer = noopTracer,
  ) {
    super();
    this.daemonIngressRateLimitWindowMs = readPositiveIntegerEnv(
      "SLOCK_DAEMON_INGRESS_RATE_LIMIT_WINDOW_MS",
      AgentOrchestrator.DAEMON_INGRESS_RATE_LIMIT_DEFAULT_WINDOW_MS,
    );
    this.daemonIngressRateLimitMaxEvents = readPositiveIntegerEnv(
      "SLOCK_DAEMON_INGRESS_RATE_LIMIT_MAX_EVENTS",
      AgentOrchestrator.DAEMON_INGRESS_RATE_LIMIT_DEFAULT_MAX_EVENTS,
    );
    this.daemonIngressRateLimitMaxEventsPerMachine = readPositiveIntegerEnv(
      "SLOCK_DAEMON_INGRESS_RATE_LIMIT_MAX_EVENTS_PER_MACHINE",
      AgentOrchestrator.DAEMON_INGRESS_RATE_LIMIT_DEFAULT_MAX_EVENTS_PER_MACHINE,
    );
    this.daemonIngressRateLimitDisabled = readBooleanEnv("SLOCK_DISABLE_DAEMON_INGRESS_RATE_LIMIT");
    this.wakeCrashLoopBreaker = new WakeCrashLoopBreaker({
      getWakeCrashLoopState: (agentId) => this.replicaStateStore.getWakeCrashLoopState(agentId),
      compareAndSetWakeCrashLoopState: (agentId, expectedVersion, state) =>
        this.replicaStateStore.compareAndSetWakeCrashLoopState(agentId, expectedVersion, state),
    });
  }

  getCurrentTimeMs(): number {
    return this.clock.now();
  }

  /**
   * Make an already started span the active span while work runs, so child
   * spans and trace events nest under it.
   */
  private runInActiveSpan<T>(span: ActiveSpan, work: () => T): T {
    return runWithTraceSpan(span, work, getCurrentTraceContext() ? undefined : this.tracer);
  }

  private recordEvent(name: string, attrs?: TraceAttributes): void {
    recordTraceEvent(name, attrs, this.tracer);
  }

  /**
   * Run work inside a span. The span is a child of the active span when there
   * is one, and a root otherwise. A root carries this.tracer so that child
   * spans and trace events under it use the same tracer.
   */
  private async runInTraceSpan<T>(
    name: string,
    options: { attrs?: TraceAttributes; parent?: TraceContext | null; kind?: "internal" | "consumer" | "producer" },
    work: () => Promise<T>,
    finish?: (result: T) => { status?: TraceStatus; attrs?: TraceAttributes },
  ): Promise<T> {
    const current = getCurrentTraceContext();
    const span = this.tracer.startSpan(name, {
      parent: options.parent !== undefined ? options.parent : current,
      surface: "server",
      kind: options.kind ?? "internal",
      attrs: options.attrs,
    });
    try {
      const result = await runWithTraceSpan(span, work, current ? undefined : this.tracer);
      const outcome = finish?.(result);
      span.end(outcome?.status ?? "ok", outcome?.attrs ? { attrs: outcome.attrs } : undefined);
      return result;
    } catch (error) {
      span.end("error", { attrs: { error_class: errorClassOf(error) } });
      throw error;
    }
  }

  /**
   * Run one app source receipt as a span under the current span. The work reports the receipt
   * outcome through setReceiptOutcome; the last call wins and is written on
   * the span when the work ends.
   */
  private async runAppSourceReceipt(
    attrs: TraceAttributes,
    work: (setReceiptOutcome: (attrs: Record<string, unknown>, status?: TraceStatus) => void) => Promise<void>,
    parent?: TraceContext | null,
  ): Promise<void> {
    let receiptOutcome: { attrs: TraceAttributes; status: TraceStatus } | null = null;
    await this.runInTraceSpan(
      "server.app_source.receipt",
      // A daemon that sent its traceparent gets the receipt on its trace;
      // otherwise the receipt stays under the current (socket) span.
      parent ? { attrs, parent, kind: "consumer" } : { attrs },
      () => work((outcomeAttrs, status) => {
        receiptOutcome = { attrs: filterAppRuntimeTraceAttrs(outcomeAttrs), status: status ?? "ok" };
      }),
      () => receiptOutcome ?? {},
    );
  }

  /**
   * Classification of one best-effort machine send. The variant fields are
   * also the span attributes: they spread directly onto the transport span.
   */
  private async trySendAppTransport(
    machineId: string,
    message: ServerToMachineMessage,
  ): Promise<AppTransportSendResult> {
    try {
      return (await this.sendToMachine(machineId, message))
        ? { outcome: "sent" }
        : { outcome: "send_failed", reason: "machine_unreachable" };
    } catch (err) {
      // ws@8.20 sync-throws `Error('WebSocket is not open: readyState 0 (CONNECTING)')`
      // while the socket is mid-handshake; CLOSING/CLOSED surface as an async
      // ws error event instead of this catch. The sync throw means "connection
      // unready", same as a false return — not a code fault.
      if (err instanceof Error && err.message.startsWith("WebSocket is not open")) {
        return { outcome: "send_failed", reason: "machine_unreachable" };
      }
      return {
        outcome: "send_failed",
        reason: "send_threw",
        error_class: errorClassOf(err),
      };
    }
  }

  /**
   * Best-effort push of one built-in App message to its owner's machine.
   * An unassigned owner (agent without a machine) is a designed, recovered
   * state — the daemon refills via snapshot on reconnect — so it traces as
   * ok, never as error. Send failures trace as error with a low-cardinality
   * reason and stay on the boolean return; they never throw.
   */
  private async sendAppTransport(input: {
    spanName: "server.app_source.transport" | "server.app_config.transport";
    traceAttrs: Record<string, unknown>;
    machineId: string | null;
    message: ServerToMachineMessage;
  }): Promise<boolean> {
    if (!input.machineId) {
      this.recordEvent(input.spanName, filterAppRuntimeTraceAttrs({
        ...input.traceAttrs,
        message_type: input.message.type,
        outcome: "owner_offline",
      }));
      return false;
    }
    const machineId = input.machineId;
    const result = await this.runInTraceSpan(
      input.spanName,
      {
        attrs: filterAppRuntimeTraceAttrs({
          ...input.traceAttrs,
          machine_id: machineId,
          message_type: input.message.type,
        }),
      },
      () => this.trySendAppTransport(machineId, input.message),
      (sendResult) => ({
        status: sendResult.outcome === "sent" ? "ok" : "error",
        attrs: filterAppRuntimeTraceAttrs({ ...sendResult }),
      }),
    );
    return result.outcome === "sent";
  }

  private async deliverBuiltInAppSnapshot<T>(input: {
    machineId: string;
    messageType: "reminder.snapshot" | "app_config.snapshot";
    spanName: "server.app_source.transport" | "server.app_config.transport";
    composition: AppSnapshotComposition<T>;
    buildMessage: (values: T[]) => ServerToMachineMessage;
  }): Promise<void> {
    await this.runInTraceSpan(
      input.spanName,
      {
        attrs: filterAppRuntimeTraceAttrs({
          machine_id: input.machineId,
          message_type: input.messageType,
        }),
      },
      async () => {
        const snapshotFailed = input.composition.terminals.some(
          (terminal) => terminal.outcome === "snapshot_failed",
        );
        const sendResult: AppTransportSendResult = snapshotFailed
          ? { outcome: "send_skipped", reason: "snapshot_failed" }
          : await this.trySendAppTransport(
            input.machineId,
            input.buildMessage(input.composition.envelopes.map((envelope) => envelope.value)),
          );
        const sent = sendResult.outcome === "sent";
        for (const envelope of input.composition.envelopes) {
          this.recordEvent(input.spanName, filterAppRuntimeTraceAttrs({
            ...envelope.traceAttrs,
            machine_id: input.machineId,
            message_type: input.messageType,
            ...sendResult,
          }));
        }
        for (const terminal of input.composition.terminals) {
          const failed = terminal.outcome === "snapshot_failed";
          this.recordEvent(input.spanName, filterAppRuntimeTraceAttrs({
            ...terminal.traceAttrs,
            machine_id: input.machineId,
            message_type: input.messageType,
            ...(failed
              ? { outcome: "snapshot_failed", reason: terminal.reason }
              : sent
                ? { outcome: "sent_empty" }
                : sendResult),
          }));
        }
        return sendResult;
      },
      (sendResult) => ({
        status: sendResult.outcome === "sent" ? "ok" : "error",
        attrs: filterAppRuntimeTraceAttrs({ ...sendResult }),
      }),
    );
  }

  /**
   * Machine-connect reminder coverage (task #2, #proj-reminder): push a
   * reminder snapshot for EVERY agent on this machine that owns scheduled
   * reminders — authoritatively from the reminders table, independent of
   * whether the agent has a running/idle session. The daemon's own
   * connect-time requests cover only session-holding agents; an owner outside
   * that set never gets its reminders loaded into the local scheduler, so
   * missed fires neither trigger nor advance until an unrelated upsert forces
   * a snapshot. The daemon applies unsolicited reminder.snapshot messages
   * per-agent (idempotent replace), so pushing is safe alongside its own
   * requests.
   */
  protected async pushReminderSnapshotsForMachine(machineId: string): Promise<void> {
    const ownerAgentIds = await reminderService.listScheduledReminderOwnersForMachine(machineId);
    for (const agentId of ownerAgentIds) {
      const composition = await composeReminderSnapshot(agentId);
      await this.deliverBuiltInAppSnapshot({
        machineId,
        messageType: "reminder.snapshot",
        spanName: "server.app_source.transport",
        composition,
        buildMessage: (reminders) => ({
          type: "reminder.snapshot",
          agentId,
          reminders,
        }),
      });
    }
  }

  /**
   * Machine-connect app-config coverage: the same gap as reminders above. A
   * freshly started daemon has no running/idle sessions at connect, so it
   * requests no app_config snapshot, and system.cleaner never arms its
   * per-owner schedule until some later reconnect or config edit. Push every
   * agent's built-in app config on ready; the daemon applies unsolicited
   * snapshots per owner (same revision is a no-op).
   */
  protected async pushAppConfigSnapshotsForMachine(machineId: string): Promise<void> {
    const machineAgents = await agentService.getAgentsForMachine(machineId);
    for (const agent of machineAgents) {
      const composition = await listBuiltInAppConfigSnapshotsForAgent({
        serverId: agent.serverId,
        ownerAgentId: agent.id,
      });
      await this.deliverBuiltInAppSnapshot({
        machineId,
        messageType: "app_config.snapshot",
        spanName: "server.app_config.transport",
        composition,
        buildMessage: (configs) => ({
          type: "app_config.snapshot",
          agentId: agent.id,
          configs,
        }),
      });
    }
  }

  protected async persistAgentStatus(agentId: string, status: AgentStatus, sessionId?: string) {
    await agentService.updateAgentStatus(agentId, status, sessionId);
  }

  /**
   * Signal-driven status writes (ready reconcile, daemon `agent:status`/`agent:session`)
   * gate on the in-memory cache, but the cache is replica-local and never
   * invalidated cross-replica. Route signal writes through the DB-layer guard so
   * a stale `active` cache on another replica cannot resurrect a stopped agent.
   */
  protected async persistAgentStatusFromSignal(agentId: string, status: AgentStatus, sessionId?: string) {
    return agentService.updateAgentStatusFromSignal(agentId, status, sessionId);
  }

  protected async invalidatePersistedAgentSessionFromSignal(
    agentId: string,
    expectedSessionId: string,
    expectedMachineId: string,
  ) {
    return agentService.invalidateAgentSessionFromSignal(agentId, expectedSessionId, expectedMachineId);
  }

  protected async persistAgentLastRuntimeError(agentId: string, lastRuntimeError: AgentRuntimeErrorState) {
    return agentService.setAgentLastRuntimeError(agentId, lastRuntimeError);
  }

  protected async clearPersistedAgentLastRuntimeError(agentId: string) {
    return agentService.clearAgentLastRuntimeError(agentId);
  }

  protected async loadAgentForSessionBroadcast(agentId: string) {
    return agentService.getAgent(agentId, false, {
      dbCallsite: "agent_orchestrator.session_broadcast_reload",
    });
  }

  private getLifecycleBuffer(agentId: string): AgentLifecycleRingBuffer {
    let buffer = this.lifecycleEventsByAgent.get(agentId);
    if (!buffer) {
      buffer = {
        events: new Array<AgentLifecycleEvent>(AgentOrchestrator.MAX_LIFECYCLE_EVENTS),
        nextIndex: 0,
        size: 0,
      };
      this.lifecycleEventsByAgent.set(agentId, buffer);
    }
    return buffer;
  }

  private readLifecycleBuffer(buffer: AgentLifecycleRingBuffer, limit: number): AgentLifecycleEvent[] {
    const count = Math.min(limit, buffer.size);
    if (count === 0) return [];

    const start = (buffer.nextIndex - count + AgentOrchestrator.MAX_LIFECYCLE_EVENTS) % AgentOrchestrator.MAX_LIFECYCLE_EVENTS;
    const events: AgentLifecycleEvent[] = [];

    for (let i = 0; i < count; i += 1) {
      const index = (start + i) % AgentOrchestrator.MAX_LIFECYCLE_EVENTS;
      const event = buffer.events[index];
      if (event) events.push(event);
    }

    return events;
  }

  protected recordLifecycleEvent(event: Omit<AgentLifecycleEvent, "at">) {
    const enriched: AgentLifecycleEvent = {
      at: this.clock.now(),
      ...event,
    };
    const buffer = this.getLifecycleBuffer(enriched.agentId);
    buffer.events[buffer.nextIndex] = enriched;
    buffer.nextIndex = (buffer.nextIndex + 1) % AgentOrchestrator.MAX_LIFECYCLE_EVENTS;
    buffer.size = Math.min(buffer.size + 1, AgentOrchestrator.MAX_LIFECYCLE_EVENTS);
    this.emit("agent:lifecycle", enriched);
  }

  getRecentLifecycleEvents(agentId?: string, limit = 50): AgentLifecycleEvent[] {
    if (agentId) {
      const buffer = this.lifecycleEventsByAgent.get(agentId);
      return buffer ? this.readLifecycleBuffer(buffer, limit) : [];
    }

    const events = [...this.lifecycleEventsByAgent.values()]
      .flatMap((buffer) => this.readLifecycleBuffer(buffer, AgentOrchestrator.MAX_LIFECYCLE_EVENTS))
      .sort((a, b) => a.at - b.at);

    return events.slice(-limit);
  }

  private makeLifecycleCorrelationId(...parts: Array<string | null | undefined>): string {
    return parts.filter((part): part is string => Boolean(part)).join(":");
  }

  private makeLifecycleDedupeKey(...parts: Array<string | null | undefined>): string {
    return parts.filter((part): part is string => Boolean(part)).join(":");
  }

  private makeReadyReconcileActivityDedupeKey(input: {
    agentId: string;
    machineId: string;
    connectionEpochId?: string;
    agentStatus: AgentStatus;
    action: ReadyReconcilePlanAction;
  }): string {
    const incidentKind = input.agentStatus === "stopped"
      ? "manualStop"
      : input.action === "mark-active-online"
        ? "readyOnline"
        : input.action === "mark-wakeable-not-running"
          ? "wakeableNotRunning"
          : "runtimeInterrupted";
    return this.makeLifecycleDedupeKey(
      "agent",
      input.agentId,
      "machine",
      input.machineId,
      "connectionEpoch",
      input.connectionEpochId ?? "unknown",
      "readyReconcile",
      incidentKind,
    );
  }

  private getConnectionEpochId(machineId: string | null | undefined): string | undefined {
    if (!machineId) return undefined;
    return this.machineConnections.get(machineId)?.connectionEpochId;
  }

  private lifecycleProjectionWriterDeps(): AgentLifecycleProjectionWriterDeps {
    return {
      broadcastActivity: (agentId, activity, detail, detailKind, entries, nowOverride, options) =>
        this.broadcastActivity(agentId, activity, detail, detailKind, entries, nowOverride, options),
      broadcastReadyOnline: (agentId, span) => this.broadcastReadyOnline(agentId, span),
      emitLifecyclePlanShadowVerdict: (agentId, signal, span) =>
        this.emitActivityWriterShadowVerdict(agentId, {
          activity: signal.activity,
          detailKind: signal.detailKind,
          observationClass: signal.observationClass,
          site: "lifecycle_plan",
          planKind: signal.planKind,
        }),
      clearInbox: (agentId) => this.clearAgentInbox(agentId),
      clearLaunchGuard: (agentId) => this.clearLaunchGuard(agentId),
      maybeResolveStartingActivity: (agentId, span) => this.maybeResolveStartingActivity(agentId, span),
      persistAgentStatus: (agentId, status, sessionId) => this.persistAgentStatus(agentId, status, sessionId),
      persistAgentStatusFromSignal: (agentId, status, sessionId) =>
        this.persistAgentStatusFromSignal(agentId, status, sessionId),
      releaseWakeLock: (agentId) => this.releaseWakeLock(agentId),
      terminalizeFreshnessHold: (agentId, reason, span) => this.terminalizeFreshnessHold(agentId, reason, span),
      sendBestEffortStopToMachine: (machineId, agentId) => this.sendBestEffortToMachine(
        machineId,
        { type: "agent:stop", agentId },
        `best-effort lifecycle stop send failed for agent ${agentId}`,
      ),
      sendStopToMachine: async (machineId, agentId) => {
        const sent = await this.sendToMachine(machineId, { type: "agent:stop", agentId });
        if (!sent) {
          console.warn(`[Orchestrator] stopAgent ${agentId}: machine ${machineId} unreachable, applying lifecycle projection anyway`);
        }
        return sent;
      },
      updateCache: (agentId, updates) => this.updateCache(agentId, updates),
    };
  }

  setIO(io: SocketServer) {
    this.io = io;
    // Periodically sweep stale transient activities (working/thinking stuck due to missed events)
    if (!this.staleActivityTimer) {
      void this.sweepComputerLifecycleOperations().catch(() => {});
      void this.dispatchPendingComputerLifecycleOperations().catch(() => {});
      this.staleActivityTimer = this.clock.scheduleRepeated(() => {
        void this.sweepStaleActivities();
        void this.sweepComputerLifecycleOperations().catch(() => {});
        void this.dispatchPendingComputerLifecycleOperations().catch(() => {});
      }, 30_000);
    }
  }

  /**
   * Reset any working/thinking activities that have been stale for too long.
   *
   * Behaviour change 2026-05-02 (#engineering:72283cf7 task #340 PR A):
   * instead of synthesizing `online` immediately when a transient state
   * goes 90s without an update, we first ask the agent's daemon for
   * ground truth via `agent:activity_probe`. The daemon's response
   * arrives via the existing `agent:activity` upstream channel and
   * cancels the fallback. If the machine is unreachable, we fall back
   * to the legacy synth-online behaviour. If a connected daemon probe
   * times out, we preserve the last busy state instead of inventing
   * online/idle: a missed probe is not proof that a long tool call
   * finished.
   *
   * The pure-function `planStaleActivitySweepAction` + protected
   * `applyStaleActivitySweepAction` seam is preserved for tests; the
   * probe machinery wraps but doesn't replace it.
   */
  private async sweepStaleActivities(): Promise<void> {
    await this.runInTraceSpan(
      "server.agent.stale_activity.sweep",
      { parent: null, attrs: { replica_id: REPLICA_ID } },
      () => this.sweepStaleActivitiesInSpan(),
      (staleCount) => ({ attrs: { stale_count: staleCount } }),
    );
  }

  private async sweepStaleActivitiesInSpan(): Promise<number> {
    const now = this.clock.now();
    const pendingWork: Promise<void>[] = [];
    let staleCount = 0;
    for (const [agentId, entry] of this.agentActivity) {
      const action = planStaleActivitySweepAction({
        isTransient: this.isTransientActivity(entry.activity),
        ageSec: (now - this.getActivityObservedAtMs(entry)) / 1000,
        staleAfterSec: AgentOrchestrator.ACTIVITY_STALE_SEC,
      });
      if (action === "keep-current") continue;
      staleCount += 1;

      // Resolve the agent's machine from the in-memory state cache. If
      // we have no cached entry (rare in steady state — the agent was
      // never seen by this replica), fast-path straight to synth-online.
      // If the machine is not connected locally but Redis still says a
      // different replica owns the machine, this replica is a non-owner:
      // preserve the busy state instead of inventing online.
      //
      // NOTE: this cache can be stale during a machine migration (the
      // agent moved but cache still points at the old machine). In
      // that window the probe goes to the wrong daemon → no response
      // → 5s fallback refreshes the existing busy state instead of
      // synth'ing online. Migration-aware probe routing can be a
      // follow-up. (@Tenny note d8459ab7)
      const cached = this.agentStateCache.get(agentId);
      const machineId = cached?.machineId ?? null;
      if (!machineId) {
        this.applyStaleActivitySweepAction({ action, agentId, now });
        continue;
      }
      if (!this.machineConnections.has(machineId)) {
        pendingWork.push(this.handleStaleActivityWithoutLocalMachine(agentId, machineId, action, now));
        continue;
      }

      // Skip if another probe for this agent is already in flight.
      let alreadyInFlight = false;
      for (const pending of this.pendingActivityProbes.values()) {
        if (pending.agentId === agentId) {
          alreadyInFlight = true;
          break;
        }
      }
      if (alreadyInFlight) continue;

      // Probe path — async, fires fallback timer if no response in 5s.
      pendingWork.push(this.issueActivityProbe(agentId, machineId, now));
    }
    await Promise.allSettled(pendingWork);
    return staleCount;
  }

  private async handleStaleActivityWithoutLocalMachine(
    agentId: string,
    machineId: string,
    action: StaleActivitySweepPlanAction,
    now: number,
  ) {
    try {
      const ownerReplica = this.replicaStateStore.isAvailable()
        ? await this.replicaStateStore.getMachineReplicaOwner(machineId)
        : null;
      if (ownerReplica && ownerReplica !== REPLICA_ID) {
        this.refreshStaleTransientActivity(agentId, now);
        return;
      }
    } catch {
      // Fall through to the legacy synthetic repair when replica reachability
      // cannot be proven. A Redis outage is not positive evidence of a live
      // remote owner.
    }
    this.applyStaleActivitySweepAction({ action, agentId, now });
  }

  /**
   * Send `agent:activity_probe` to the daemon and arm a 5s fallback
   * timer. On daemon response (`agent:activity` carrying matching
   * `probeId`) `handleActivityProbeResponse` cancels the timer. If
   * the probe times out, keep the last busy state visible; timeout is
   * ambiguous between "daemon wedged" and "long tool call", so it
   * must not be rendered as idle/online.
   *
   * TODO(lifecycle-v2/daemon-protocol): replace this legacy probe/request
   * pair with a canonical activity_snapshot_request / activity_snapshot
   * exchange. The response should be a read-only state snapshot, not another
   * `agent:activity` event that the server has to distinguish from lifecycle
   * mutation.
   */
  private async issueActivityProbe(agentId: string, machineId: string, sweepNow: number) {
    const fallbackToBusySnapshot = () => this.refreshStaleTransientActivity(agentId, this.clock.now());
    const fallbackAfterTimeout = () => {
      void this.runInTraceSpan(
        "server.agent.activity_probe.timeout",
        { parent: null, attrs: { agent_id: agentId, machine_id: machineId } },
        async () => fallbackToBusySnapshot(),
      );
    };

    const probeId = crypto.randomUUID();
    const fallbackTimer = setTimeout(() => {
      // Probe timed out — daemon crashed, unreachable, or too slow.
      if (this.pendingActivityProbes.delete(probeId)) {
        fallbackAfterTimeout();
      }
    }, AgentOrchestrator.ACTIVITY_PROBE_TIMEOUT_MS);

    this.pendingActivityProbes.set(probeId, {
      agentId,
      startedAt: sweepNow,
      fallbackTimer,
    });

    try {
      const sent = await this.sendToMachine(machineId, {
        type: "agent:activity_probe",
        agentId,
        probeId,
        purpose: "sweep",
      });
      if (!sent) {
        if (this.pendingActivityProbes.delete(probeId)) {
          clearTimeout(fallbackTimer);
          fallbackToBusySnapshot();
        }
      }
    } catch {
      if (this.pendingActivityProbes.delete(probeId)) {
        clearTimeout(fallbackTimer);
        fallbackToBusySnapshot();
      }
    }
  }

  private refreshStaleTransientActivity(agentId: string, now: number) {
    const current = this.agentActivity.get(agentId);
    if (!current || !this.isTransientActivity(current.activity)) {
      this.applyStaleActivitySweepAction({ action: "sweep-online", agentId, now });
      return;
    }

    // "Starting…" is a TRANSITIONAL working state, not genuine busy work:
    // `isFreshBusyActivity` deliberately excludes it (working + "Starting…"
    // → false). It must resolve to `online`, not be preserved. Preserving it
    // here used to re-stamp its age every sweep and pin the activity bar/status-
    // history on "Starting" indefinitely when a relaunch's ready path didn't
    // fire `maybeResolveStartingActivity` — the agent is live and producing
    // activity, yet the visible state is stuck. Route this explicit transition
    // to the same resolve path instead. (#161 starting-line closure)
    // Gated on the closed `detailKind` (not display text) to stay consistent
    // with `maybeResolveStartingActivity` and the T4 no-text-as-semantics rule.
    if (
      current.activity === "working"
      && (current.detailKind === "starting" || current.detailKind === "runtime_starting")
    ) {
      this.maybeResolveStartingActivity(agentId);
      return;
    }

    const serverId = this.agentStateCache.get(agentId)?.serverId ?? "unknown";
    // A probe timeout is not a new runtime or delivery observation. Keep the
    // existing snapshot in memory, but do not re-broadcast it: re-emitting a
    // stale message_received snapshot mints a new user-visible/durable fact and
    // launders its freshness on every sweep cadence. The legacy
    // preserve_rebroadcast site value remains stable for trace consumers, while
    // the verdict records the canonical no-authority/no-clock-advance outcome.
    this.recordEvent("server.agent.stale_activity.busy_preserved", {
      agent_id: agentId,
      server_id: serverId,
      previous_activity: current.activity,
      detail_present: Boolean(current.detail),
      repair_kind: "probe_timeout_busy_preserved",
      authority: "scheduler_repair",
      candidate_activity: current.activity,
      served_activity: current.activity,
      projection_outcome: "preserved_without_write",
      outcome: "preserved_without_write",
      reason: "synthetic_no_authority",
      advances_observed_clock: "none",
    });
    this.recordEvent(
      "lifecycle_v2.shadow_verdict",
      buildLifecycleShadowVerdictAttrs(
        {
          activity: current.activity,
          detail: current.detail,
          detailKind: current.detailKind,
          updatedAtMs: current.observedAtMs ?? current.updatedAt,
        },
        {
          activity: current.activity,
          agentId,
          detailKind: current.detailKind,
          atMs: now,
          // Server-originated: the sweep carries no launch generation.
          currentLaunchGeneration: null,
          launchGeneration: null,
          observationClass: "synthetic",
          site: "preserve_rebroadcast",
        },
      ),
    );
  }

  /**
   * Cancel the fallback timer when the daemon's probe response arrives.
   * Called from the `agent:activity` ingest path when the inbound
   * message carries a matching `probeId`. The activity payload itself
   * still flows through the normal broadcast pipeline (so the new
   * ground-truth state propagates to clients via standard means);
   * this method just stops the synth-fallback from also firing.
   */
  private handleActivityProbeResponse(probeId: string) {
    const pending = this.pendingActivityProbes.get(probeId);
    if (!pending) return;
    clearTimeout(pending.fallbackTimer);
    this.pendingActivityProbes.delete(probeId);
  }

  protected applyStaleActivitySweepAction(context: StaleActivitySweepApplyContext) {
    if (context.action === "keep-current") {
      return;
    }
    const serverId = this.agentStateCache.get(context.agentId)?.serverId ?? "unknown";
    const current = this.agentActivity.get(context.agentId);
    this.recordEvent("server.agent.synthetic_repair.apply", {
      agent_id: context.agentId,
      server_id: serverId,
      synthetic_repair: true,
      repair_kind: "stale_sweep",
      source: "scheduler",
      authority: "scheduler_repair",
      previous_activity: current?.activity ?? "none",
      candidate_activity: "online",
      served_activity: current?.activity ?? "none",
      projection_outcome: "preserved_without_write",
      outcome: "preserved_without_write",
      reason: "synthetic_no_authority",
      advances_observed_clock: "none",
    });
    // Keep the legacy online candidate in the shadow verdict so the rejected
    // heuristic remains measurable, but do not project it into activity truth.
    this.emitSyntheticRepairShadowVerdict(context.agentId, context.now);
  }

  /**
   * Shared gamma shadow emitter for the two synthetic-repair apply sites
   * (stale_sweep / transient_normalization). The signal records the rejected
   * legacy online candidate even though canonical repair is now trace-only.
   * This keeps the former whitewash measurable without minting it as truth.
   */
  private emitSyntheticRepairShadowVerdict(agentId: string, nowMs: number) {
    const current = this.agentActivity.get(agentId);
    this.recordEvent(
      "lifecycle_v2.shadow_verdict",
      buildLifecycleShadowVerdictAttrs(
        current
          ? {
              activity: current.activity,
              detail: current.detail,
              detailKind: current.detailKind,
              updatedAtMs: current.observedAtMs ?? current.updatedAt,
            }
          : undefined,
        {
          activity: "online",
          agentId,
          detailKind: "synthetic_repair",
          atMs: nowMs,
          // Server-originated repair: no launch generation is carried.
          currentLaunchGeneration: null,
          launchGeneration: null,
          observationClass: "synthetic",
          site: "synthetic_repair",
        },
      ),
    );
  }

  /**
   * gamma-2 write-site closure emitter (task #460): shared by the five
   * previously unshadowed agentActivity writers (starting_resolve /
   * ready_online / slock_action_status / hint_resolution / runtime_error —
   * see AGENT_ACTIVITY_WRITER_REGISTRY). The verdict is a standalone trace
   * event. It links to the active span when there is one, and is still
   * recorded when there is none, so a serving map write is never invisible
   * in traces. Trace only; zero behavior change.
   */
  private emitActivityWriterShadowVerdict(
    agentId: string,
    signal: {
      activity: AgentActivityKind;
      detailKind?: AgentActivityDetailKind | null;
      observationClass: LifecycleObservationClass;
      site: LifecycleShadowSignalSite;
      planKind?: AgentLifecycleEventType;
    },
  ) {
    const current = this.agentActivity.get(agentId);
    const attrs = buildLifecycleShadowVerdictAttrs(
      current
        ? {
            activity: current.activity,
            detail: current.detail,
            detailKind: current.detailKind,
            updatedAtMs: current.observedAtMs ?? current.updatedAt,
          }
        : undefined,
      {
        activity: signal.activity,
        agentId,
        detailKind: signal.detailKind ?? null,
        atMs: this.clock.now(),
        // Server-originated writers carry no launch generation.
        currentLaunchGeneration: null,
        launchGeneration: null,
        observationClass: signal.observationClass,
        site: signal.site,
        ...(signal.planKind !== undefined ? { planKind: signal.planKind } : {}),
      },
    );
    this.recordEvent("lifecycle_v2.shadow_verdict", attrs);
  }

  private shouldRecordDeliveryAckTurnActive(agentId: string, agent: CachedAgentState | null): DeliveryAckTurnActiveGate {
    const runtimeState = agent?.runtimeState ?? this.agentStateCache.get(agentId)?.runtimeState ?? "unknown";
    const current = this.agentActivity.get(agentId) ?? null;
    const observedAgeSec = current ? this.getActivityAgeSec(current) : null;
    const liveRuntimeState = runtimeState === "starting" || runtimeState === "running_idle" || runtimeState === "working" || runtimeState === "thinking";

    if (!liveRuntimeState) {
      return {
        admit: false,
        reason: "runtime_liveness_failed_or_unknown",
        runtimeState,
        currentActivity: current?.activity ?? null,
        observedAgeSec,
      };
    }

    if (
      current
      && this.isTransientActivity(current.activity)
      && observedAgeSec !== null
      && observedAgeSec > AgentOrchestrator.ACTIVITY_STALE_SEC
    ) {
      return {
        admit: false,
        reason: "stale_runtime_observation",
        runtimeState,
        currentActivity: current.activity,
        observedAgeSec,
      };
    }

    return {
      admit: true,
      reason: null,
      runtimeState,
      currentActivity: current?.activity ?? null,
      observedAgeSec,
    };
  }

  private recordDeliveryAckTurnActive(
    agentId: string,
    agent: CachedAgentState | null,
    span?: ActiveSpan | null,
  ): ActivityBroadcastTraceResult | null {
    const gate = this.shouldRecordDeliveryAckTurnActive(agentId, agent);
    if (!gate.admit) {
      span?.addEvent("turn_active.skipped", {
        outcome: "skipped",
        reason: gate.reason,
        runtime_state: gate.runtimeState,
        current_activity: gate.currentActivity,
        observed_age_sec: gate.observedAgeSec,
      });
      return null;
    }

    const now = this.clock.now();
    this.emitActivityWriterShadowVerdict(agentId, {
      activity: "working",
      detailKind: "message_received",
      observationClass: "observed_turn_active",
      site: "delivery_ack",
    });
    return this.broadcastActivity(agentId, "working", "Message received", "message_received", undefined, now, {
      observedAtMs: now,
      isDeliveryAckTurnActive: true,
      arbitration: {
        observationClass: "observed_turn_active",
        signalSite: "delivery_ack",
      },
    });
  }

  private isTransientActivity(activity: string): boolean {
    return activity === "working" || activity === "thinking";
  }

  private shouldPersistStatusOnlyActivity(
    activity: AgentActivityKind,
    detailKind: AgentActivityDetailKind,
  ): boolean {
    // Only the terminal activities that can currently arrive without explicit
    // trajectory entries need synthesis here. `stopped` / `crashed` are not
    // AgentActivity values routed through broadcastActivity; they are rendered as
    // `offline` or `error` before reaching this seam.
    if (activity === "offline" || activity === "error") return true;
    if (activity !== "working") return false;
    return detailKind === "starting"
      || detailKind === "runtime_starting"
      || detailKind === "message_received"
      || detailKind === "compaction_stale"
      || detailKind === "stalled_recovery";
  }

  recordActivityProducerEvent(agentId: string, event: ActivityProducerEvent) {
    const summary = this.formatActivityProducerField(event.summary, 120) || "Agent activity";
    const lines = [
      event.target ? `target: ${this.formatActivityProducerField(event.target, 160)}` : null,
      event.outcome && event.outcome !== "succeeded" ? `status: ${event.outcome}` : null,
    ].filter((line): line is string => Boolean(line));

    return this.broadcastRaftAction(agentId, {
      title: summary,
      text: lines.join("\n"),
    });
  }

  recordRaftCliAction(
    agentId: string,
    event: Omit<ActivityProducerEvent, "producer" | "outcome"> & { outcome?: "succeeded" | "failed" },
  ) {
    return this.recordActivityProducerEvent(agentId, {
      producer: "slock_cli",
      outcome: "succeeded",
      ...event,
    });
  }

  // Append a durable Raft workspace action. Live status/detail remains owned by
  // lifecycle/status projection; this helper must not author a new subtitle for it.
  async recordAgentRaftAction(
    agentId: string,
    event: {
      title: string;
      text: string;
      producerFactId?: string;
      activity?: AgentActivity;
      activityDetail?: string;
      dedupeKey?: string;
    },
  ): Promise<void> {
    const result = this.broadcastRaftAction(agentId, event);
    await result.persistence;
  }

  /**
   * Activity ingest (`raft-agent-activity-ingest.v1`). Hook events map to the
   * activity log / trajectory and, for agents that never adopted
   * raft-agent-status.v1, also to the live status. An event carrying a
   * raft-agent-status.v1 `status` (with or without a hook) drives the live
   * status directly (status + optional detail) through the same
   * external-signal lifecycle path, so latest-occurredAt-wins arbitration
   * holds; a replayed status `eventId` is skipped. The first accepted status
   * durably marks the agent as a status.v1 reporter, after which hook-derived
   * status no longer drives its dot (hook events are still logged).
   */
  async recordExternalAgentActivity(
    agentId: string,
    // Input-only: accept readonly event arrays (e.g. `as const` fixtures).
    request: Omit<ExternalAgentActivityIngestRequest, "events"> & {
      readonly events: readonly ExternalAgentActivityEvent[];
    },
    serverId?: string,
  ): Promise<{ acceptedCount: number; rejectedCount: number; droppedCount: number }> {
    const resolvedServerId = serverId ?? this.agentStateCache.get(agentId)?.serverId ?? "unknown";
    const span = this.tracer.startSpan("server.external_agent.activity.ingest", {
      surface: "server",
      kind: "internal",
      attrs: {
        agent_id: agentId,
        server_id: resolvedServerId,
        session_id: request.coreSessionId,
        event_count: request.events.length,
      },
    });
    let acceptedCount = 0;
    let rejectedCount = 0;
    let statusCount = 0;
    let loggedOnlyCount = 0;
    let statusProtocolAdopted = false;
    try {
      const planned: PlannedExternalActivityEvent[] = [];
      for (const event of request.events) {
        const status = isRaftAgentStatus(event.status) ? event.status : undefined;
        if (!status) {
          const mapped = mapExternalPluginActivityEvent(event);
          if (!mapped) {
            rejectedCount += 1;
            continue;
          }
          planned.push({ kind: "hook", mapped });
          continue;
        }
        const eventId = externalActivityString(event.eventId ?? event.event_id, 160);
        const occurredAtMs = externalActivityTimeMs(event.occurredAt ?? event.occurred_at);
        if (!eventId || occurredAtMs === undefined) {
          rejectedCount += 1;
          continue;
        }
        planned.push({
          kind: "status",
          eventId,
          status,
          detail: typeof event.detail === "string" ? event.detail.slice(0, RAFT_AGENT_STATUS_DETAIL_LIMIT) : "",
          occurredAtMs,
          mapped: mapExternalPluginActivityEvent(event),
        });
      }

      // Dedupe status reports by eventId: within the batch and against events
      // already recorded (the activity-log dedupe key is durable).
      const statusKeys = [...new Set(planned.flatMap((item) => (
        item.kind === "status" ? [externalAgentActivityDedupeKey(item.eventId)] : []
      )))];
      const recorded = statusKeys.length > 0
        ? await this.loadExistingActivityDedupeKeys(agentId, statusKeys)
        : new Set<string>();
      const seenStatusKeys = new Set<string>();
      const fresh = planned.filter((item) => {
        if (item.kind !== "status") return true;
        const key = externalAgentActivityDedupeKey(item.eventId);
        if (recorded.has(key) || seenStatusKeys.has(key)) {
          rejectedCount += 1;
          return false;
        }
        seenStatusKeys.add(key);
        return true;
      });

      if (fresh.some((item) => item.kind === "status")) {
        await this.markExternalStatusProtocolAdopted(agentId);
        statusProtocolAdopted = true;
      } else if (fresh.length > 0) {
        statusProtocolAdopted = await this.isExternalStatusProtocolAdopted(agentId);
      }

      for (const item of fresh) {
        acceptedCount += 1;
        const receivedAtMs = this.clock.now();
        if (item.kind === "hook") {
          const { mapped } = item;
          const observedAtMs = Math.min(mapped.occurredAtMs ?? receivedAtMs, receivedAtMs);
          if (statusProtocolAdopted) {
            if (await this.persistExternalActivityLogOnly(agentId, mapped.entries, observedAtMs, mapped.dedupeKey)) {
              loggedOnlyCount += 1;
            }
            continue;
          }
          const eventId = mapped.dedupeKey ?? `external-activity-${acceptedCount}`;
          const lifecycleEvent = createAgentLifecycleEvent({
            serverId: resolvedServerId,
            agentId,
            eventType: "external_agent_signal",
            actor: "external",
            source: "external_cli",
            reason: "external_activity",
            correlationId: `agent:${agentId}:externalActivity:${eventId}`,
            occurredAt: mapped.occurredAtMs ? new Date(mapped.occurredAtMs) : new Date(this.clock.now()),
            attrs: {
              activity_status: mapped.activity,
              external_event_id: eventId.slice(0, 128),
            },
          });
          const plan = reduceExternalActivityLifecycle({
            event: lifecycleEvent,
            activity: mapped.activity,
            detail: mapped.detail,
            entries: mapped.entries,
            dedupeKey: mapped.dedupeKey,
            occurredAtMs: mapped.occurredAtMs,
            observedAtMs,
          });
          await applyAgentLifecycleProjectionPlan(plan, this.lifecycleProjectionWriterDeps(), span);
          continue;
        }

        statusCount += 1;
        const observedAtMs = Math.min(item.occurredAtMs, receivedAtMs);
        const dedupeKey = externalAgentActivityDedupeKey(item.eventId);
        // The hook's usual log entries ride along; its hook-derived status
        // entry is replaced by the reported status.
        const hookEntries = (item.mapped?.entries ?? []).filter((entry) => entry.kind !== "status");
        const lifecycleEvent = createAgentLifecycleEvent({
          serverId: resolvedServerId,
          agentId,
          eventType: "external_agent_signal",
          actor: "external",
          source: "external_cli",
          reason: "external_activity",
          correlationId: `agent:${agentId}:externalActivity:${dedupeKey}`,
          occurredAt: new Date(observedAtMs),
          attrs: {
            activity_status: item.status,
            external_event_id: dedupeKey.slice(0, 128),
            external_signal_kind: "status_report",
          },
        });
        const plan = reduceExternalActivityLifecycle({
          event: lifecycleEvent,
          activity: item.status,
          detail: item.detail,
          entries: [...hookEntries, {
            kind: "status",
            activity: item.status,
            activityKind: item.status,
            detail: item.detail,
            detailKind: "external_activity",
            producerFactId: buildExternalStatusProducerFactId(item.eventId),
          }],
          dedupeKey,
          occurredAtMs: observedAtMs,
          observedAtMs,
        });
        const applied = await applyAgentLifecycleProjectionPlan(plan, this.lifecycleProjectionWriterDeps(), span);
        // A stale status (older than the live one) does not override it, but
        // the hook it rode on is still recorded.
        if (applied.liveActivityResult?.action === "kernel-preserve" && hookEntries.length > 0) {
          await this.persistExternalActivityLogOnly(agentId, hookEntries, observedAtMs, dedupeKey);
        }
      }
      span.end("ok", {
        attrs: {
          outcome: acceptedCount > 0 ? "accepted" : "dropped",
          reason: acceptedCount > 0 ? "external_activity_mapped" : "no_mappable_events",
          accepted_count: acceptedCount,
          rejected_count: rejectedCount,
          status_count: statusCount,
          logged_only_count: loggedOnlyCount,
          status_protocol_adopted: statusProtocolAdopted,
        },
      });
    } catch (err) {
      span.end("error", {
        attrs: {
          outcome: "error",
          reason: "external_activity_projection_failed",
          accepted_count: acceptedCount,
          rejected_count: rejectedCount,
          error_class: errorClassOf(err),
        },
      });
      throw err;
    }

    return {
      acceptedCount,
      rejectedCount,
      droppedCount: normalizeExternalActivityDroppedCount(request.dropped),
    };
  }

  /** Whether the agent reports raft-agent-status.v1 (durable; cached once seen). */
  async isExternalStatusProtocolAdopted(agentId: string): Promise<boolean> {
    if (this.statusProtocolAdoptedAgents.has(agentId)) return true;
    const adoptedAt = await this.loadStatusProtocolAdoptedAt(agentId);
    if (!adoptedAt) return false;
    this.statusProtocolAdoptedAgents.add(agentId);
    return true;
  }

  private async markExternalStatusProtocolAdopted(agentId: string): Promise<void> {
    if (this.statusProtocolAdoptedAgents.has(agentId)) return;
    await this.persistStatusProtocolAdopted(agentId, new Date(this.clock.now()));
    this.statusProtocolAdoptedAgents.add(agentId);
  }

  protected async loadStatusProtocolAdoptedAt(agentId: string): Promise<Date | null> {
    return agentService.getAgentStatusProtocolAdoptedAt(agentId);
  }

  protected async persistStatusProtocolAdopted(agentId: string, adoptedAt: Date): Promise<void> {
    await agentService.markAgentStatusProtocolAdopted(agentId, adoptedAt);
  }

  protected async loadExistingActivityDedupeKeys(agentId: string, dedupeKeys: readonly string[]): Promise<Set<string>> {
    return agentActivityLogService.listExistingAgentActivityDedupeKeys(agentId, dedupeKeys);
  }

  /**
   * Record hook activity in the activity log / trajectory without touching the
   * live status (status.v1 reporters, or a hook riding a stale status).
   * Hook-derived `status` entries are dropped: they are the status derivation
   * the agent replaced. The row carries the current live status so a restart
   * hint read from the log does not resurrect a hook-derived one.
   */
  private async persistExternalActivityLogOnly(
    agentId: string,
    mappedEntries: readonly TrajectoryEntry[],
    observedAtMs: number,
    dedupeKey: string | undefined,
  ): Promise<boolean> {
    const entries = mappedEntries.filter((entry) => entry.kind !== "status");
    if (entries.length === 0) return false;
    const current = this.agentActivity.get(agentId);
    try {
      return await this.persistActivityEvent(
        agentId,
        current?.activity ?? "online",
        current?.detail ?? "",
        entries,
        new Date(observedAtMs),
        dedupeKey,
      );
    } catch (err) {
      console.warn(`[ActivityLog ${agentId}] Failed to persist external activity event:`, err);
      return false;
    }
  }

  private broadcastRaftAction(
    agentId: string,
    event: {
      title: string;
      text: string;
      producerFactId?: string;
      activity?: AgentActivity;
      activityDetail?: string;
      dedupeKey?: string;
    },
  ): ActivityBroadcastTraceResult {
    const current = this.agentActivity.get(agentId);
    const envelopeActivity = event.activity ?? current?.activity ?? "online";
    const envelopeDetail = event.activityDetail ?? current?.detail ?? "";
    const entries: TrajectoryEntry[] = [
      ...(event.activity && event.activityDetail
        ? [{
            kind: "status" as const,
            activity: event.activity,
            activityKind: event.activity,
            detail: event.activityDetail,
            detailKind: "slock_action" as const,
            ...(event.producerFactId ? { producerFactId: event.producerFactId } : {}),
          }]
        : []),
      {
        // Ordinary `slock_action` entries append durable workspace history only.
        // Callers with a real status transition must pass explicit activity
        // fields so reload recovery sees the same status as the live envelope.
        kind: "slock_action",
        title: event.title,
        text: event.text,
        ...(event.producerFactId ? { producerFactId: event.producerFactId } : {}),
      },
    ];
    // gamma-2 shadow: the two caller families are distinguishable and
    // classify differently (gamma-2.1, Kai calibration v3 §B split):
    // - explicit status transition (SMR-006 statusEntry family): an
    //   AUTHORIZED control command — class "control", kernel verdict
    //   replace/control_command_authority (authoritative writer of its own
    //   axis; never a downgrade — this family only writes working).
    // - history append (CLI action records, no activity fields): claims no
    //   new value — plain synthetic; preserve is the correct filing.
    this.emitActivityWriterShadowVerdict(agentId, {
      activity: envelopeActivity,
      detailKind: event.activity && event.activityDetail ? "slock_action" : current?.detailKind ?? "none",
      observationClass: event.activity && event.activityDetail ? "control" : "synthetic",
      site: "slock_action_status",
    });
    return this.broadcastActivity(
      agentId,
      envelopeActivity,
      envelopeDetail,
      event.activity && event.activityDetail ? "slock_action" : current?.detailKind ?? "none",
      entries,
      undefined,
      event.dedupeKey ? { dedupeKey: event.dedupeKey } : undefined,
    );
  }

  private formatActivityProducerField(value: string, maxLength: number): string {
    const singleLine = value.replace(/\s+/g, " ").trim();
    if (singleLine.length <= maxLength) return singleLine;
    return `${singleLine.slice(0, Math.max(0, maxLength - 1))}\u2026`;
  }

  private formatActivity(activity: AgentActivityKind, detail = ""): VisibleActivity {
    return { activity, activityDetail: detail };
  }

  /**
   * task #1116: refresh read-back must expose the typed detail kind and, for a
   * delivery_unconsumed snapshot, the daemon's carrier — otherwise a page load
   * would silently drop what the live socket frame showed.
   */
  private formatActivityFromSnapshot(snapshot: ActivitySnapshot): VisibleActivity {
    // Scoped to the delivery_unconsumed observation for now: the plain
    // {activity, activityDetail} shape is asserted verbatim by many callers and
    // tests, and only this kind has a typed carrier the web must not lose.
    // task #1123: a failed start keeps its typed carrier too; runtime_unavailable
    // without a carrier keeps the plain shape so untyped callers see no change.
    const carriesSpawnFailure = snapshot.detailKind === "runtime_unavailable" && snapshot.spawnFailure !== undefined;
    if (
      snapshot.detailKind !== "delivery_unconsumed"
      && snapshot.detailKind !== "wake_crash_loop_blocked"
      && snapshot.detailKind !== "terminal_failure_paused"
      && !carriesSpawnFailure
    ) {
      return this.formatActivity(snapshot.activity, snapshot.detail);
    }
    return {
      activity: snapshot.activity,
      activityDetail: snapshot.detail,
      activityDetailKind: snapshot.detailKind,
      ...(snapshot.deliveryConsumption ? { deliveryConsumption: snapshot.deliveryConsumption } : {}),
      ...(snapshot.wakeCrashLoop ? { wakeCrashLoop: snapshot.wakeCrashLoop } : {}),
      ...(snapshot.spawnFailure ? { spawnFailure: snapshot.spawnFailure } : {}),
    };
  }

  private async blockWakesForNonRetryableStartFailure(agentId: string, launchId: string | null, reason: string): Promise<void> {
    try {
      const blockedNow = await this.wakeCrashLoopBreaker.recordNonRetryableStartFailure(agentId, {
        launchId,
        reason,
        nowMs: this.clock.now(),
      });
      this.recordEvent("wake.start_failure_block", { blocked_now: blockedNow, reason, launch_id_present: launchId !== null });
      if (!blockedNow) return;
      const cached = this.agentStateCache.get(agentId);
      this.recordLifecycleEvent({
        agentId,
        machineId: cached?.machineId ?? null,
        action: "wake",
        outcome: "suppressed",
        cause: "message",
        previousStatus: cached?.status ?? null,
        detail: "start_failure_needs_action",
      });
      console.warn(`[Agent ${agentId}] Automatic wakes paused: start failed (${reason}); a manual start or a runtime config change lifts it`);
    } catch (error) {
      console.error(`[Agent ${agentId}] Failed to record a non-retryable start failure:`, error);
    }
  }

  /**
   * task #1221: the runtime configuration changed; lift a start-failure (or
   * crash-loop) block. RFC 071 §5 (F3): the terminal-failure breaker lifts
   * only when a runtime value actually differs (`runtimeValuesChanged`);
   * field presence alone is not a change.
   */
  async liftWakeBlockForConfigChange(agentId: string, options: { runtimeValuesChanged?: boolean } = {}): Promise<void> {
    if (await this.wakeCrashLoopBreaker.liftForConfigChange(agentId)) {
      this.recordEvent("wake.block_lifted", { cause: "runtime_config_changed" });
    }
    if (options.runtimeValuesChanged === true) await this.liftTerminalBreaker(agentId, "runtime_config_changed");
  }

  /**
   * RFC 071 §5 E3 other than a human start: reset or a real runtime-config
   * change. Closed, generation+1, counts reset; `unexited` and needs-manual
   * stay. Best effort: a failed lift leaves the breaker as it was (the
   * conservative side) and is logged.
   */
  private async liftTerminalBreaker(agentId: string, cause: "human_reset" | "runtime_config_changed"): Promise<void> {
    // Dormant (RUNTIME_OUTCOME_ACK_ENABLED false): the breaker store is never touched.
    if (!this.runtimeOutcomeAckEnabled) return;
    try {
      await this.terminalFailureBreaker.lift(agentId, { cause, nowMs: this.clock.now() });
      this.recordEvent("terminal_breaker.lifted", { cause });
    } catch (error) {
      console.warn(`[Agent ${agentId}] terminal-failure breaker lift (${cause}) failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * RFC 071 §9: show the person why automatic wakes stopped, once per block,
   * as an offline activity with detailKind `terminal_failure_paused`. Paused:
   * until when, why, and that the next wake after it (or a manual start)
   * retries. Needs manual: why, and that only a manual start proceeds (never
   * "will retry"). Best effort: a failure to read is logged, nothing else.
   */
  private async projectTerminalBlock(agentId: string, options: { includeNeedsManual: boolean }): Promise<void> {
    if (!this.runtimeOutcomeAckEnabled) return;
    let view: TerminalBlockView | null;
    try {
      view = terminalBlockView(await this.terminalFailureBreaker.read(agentId, this.clock.now()), this.clock.now());
    } catch (error) {
      console.warn(`[Agent ${agentId}] terminal-failure breaker block not shown: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (view === null || (view.kind === "needs_manual" && !options.includeNeedsManual)) return;
    const key = view.kind === "paused" ? `paused:${view.blockedUntilMs}` : `needs_manual:${view.reason}`;
    if (this.projectedTerminalBlocks.get(agentId) === key) return;
    this.projectedTerminalBlocks.set(agentId, key);
    this.broadcastActivity(agentId, "offline", terminalBlockDetail(view), "terminal_failure_paused", []);
    this.recordEvent("terminal_breaker.block_shown", { agent_id: agentId, kind: view.kind, ...(view.kind === "needs_manual" ? { reason: view.reason } : { blocked_until_ms: view.blockedUntilMs }) });
  }

  /** RFC 071 §4.3 rule 4: a `ready` from a daemon instance. Best effort per agent (logged). */
  private async observeTerminalDaemonReady(agentId: string, daemonInstanceId: string): Promise<void> {
    if (!this.runtimeOutcomeAckEnabled) return;
    try {
      const wrote = await this.terminalFailureBreaker.recordDaemonReady(agentId, { daemonInstanceId, nowMs: this.clock.now() });
      if (wrote) this.recordEvent("terminal_breaker.daemon_ready", { agent_id: agentId, daemon_instance_id: daemonInstanceId });
    } catch (error) {
      console.warn(`[Agent ${agentId}] terminal-failure breaker ready not recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * RFC 071: what the terminal-failure breaker knows about the machine a
   * start goes to. `capability` is the daemon's `agent:runtime-outcome-v1`,
   * minus agents whose outcome storage it reports as unreliable, and only
   * while this server consumes outcome frames (`runtimeOutcomeAckEnabled`);
   * `unknown` when this replica does not hold the machine's socket.
   */
  private terminalStartContext(agentId: string, machineId: string | null): TerminalStartContext {
    const conn = machineId ? this.machineConnections.get(machineId) : undefined;
    if (!conn) return { capability: "unknown", daemonReportsOutcomes: false, daemonInstanceId: null };
    // Outcomes are observable only while this server also consumes (and acks) the frames.
    const daemonReportsOutcomes = this.runtimeOutcomeAckEnabled && conn.capabilities.has(DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1);
    const capability = daemonReportsOutcomes && !(conn.runtimeOutcomeUnreliableAgents?.has(agentId) ?? false);
    return { capability, daemonReportsOutcomes, daemonInstanceId: conn.daemonInstanceId };
  }

  /**
   * Does this start go through the terminal claim? Every start to a machine
   * that reports outcomes for the agent (its pending entry must be written
   * before dispatch). A human start also when the daemon has an outbox but
   * reports the agent's storage unreliable (only a human start resolves it,
   * and the daemon needs `humanStart`), or when the record is protecting (the
   * takeover must be recorded, RFC X-4(b)). Otherwise, notably every start
   * to a daemon without `agent:runtime-outcome-v1` on a never-protected
   * record, nothing changes: no terminal write, no new agent:start field.
   */
  private async usesTerminalClaim(agentId: string, context: TerminalStartContext, control: TerminalStartControl): Promise<boolean> {
    // Dormant: no claim, no read — a start behaves exactly as before RFC 071.
    if (!this.runtimeOutcomeAckEnabled) return false;
    if (context.capability === true) return true;
    if (control !== "human_start") return false;
    if (context.daemonReportsOutcomes) return true;
    return isTerminalBreakerProtecting(await this.terminalFailureBreaker.read(agentId, this.clock.now()));
  }

  /**
   * RFC 071 §4.3 fast reject for an automatic start. It persists what a
   * refusal learned (needs-manual, the refused message's owed ceiling); the
   * claim decides. Store errors propagate: an automatic start that cannot
   * consult the breaker does not start (fail closed).
   * `unknown` capability (not this replica's machine): a protected record
   * refuses without writing anything; a never-protected one passes.
   */
  private async terminalStartGate(
    agentId: string,
    context: { capability: boolean | "unknown" },
    wakeMessage: AgentMessage | undefined,
  ): Promise<TerminalWakeRefusal | null> {
    // Dormant: no gate and no store read, so a store failure cannot refuse a start.
    if (!this.runtimeOutcomeAckEnabled) return null;
    const nowMs = this.clock.now();
    if (context.capability === "unknown") {
      const state = await this.terminalFailureBreaker.read(agentId, nowMs);
      return isTerminalBreakerProtecting(state) ? "terminal_failure_needs_manual" : null;
    }
    const owed = wakeMessage && typeof wakeMessage.seq === "number" && wakeMessage.channel_id
      ? { conversationId: wakeMessage.channel_id, seq: wakeMessage.seq }
      : null;
    const decision = await this.terminalFailureBreaker.gate(agentId, { nowMs, capability: context.capability, wakeMessage: owed });
    return decision === "pass" ? null : decision;
  }

  /** RFC 071 §4.3 step 3: the one claim over both breaker keys. */
  private claimTerminalStart(
    agentId: string,
    input: {
      launchId: string | undefined;
      sessionId: string | null;
      context: TerminalStartContext;
      control: TerminalStartControl;
      human: boolean;
    },
  ): Promise<CombinedClaimResult> {
    return this.terminalFailureBreaker.claimStart(agentId, {
      // A start without a launchId still claims (a human takeover must be
      // recorded); its terminal launch can never be bound by a frame.
      launchId: input.launchId ?? `unbound:${crypto.randomUUID()}`,
      crashLoopLaunchId: input.launchId ?? null,
      nowMs: this.clock.now(),
      resumedSessionId: input.sessionId,
      daemonInstanceId: input.context.daemonInstanceId,
      capability: input.context.capability === true,
      control: input.control,
      human: input.human,
    });
  }

  private recordTerminalWakeSuppressed(
    agentId: string,
    machineId: string | null,
    startCause: AgentLifecycleCause,
    previousStatus: AgentStatus | null,
    refusal: TerminalWakeRefusal,
    context: { capability: boolean | "unknown" },
  ): void {
    this.recordLifecycleEvent({
      agentId,
      machineId,
      action: "wake",
      outcome: "suppressed",
      cause: startCause,
      previousStatus,
      detail: refusal,
    });
    this.recordEvent("terminal_breaker.wake_suppressed", {
      start_cause: startCause,
      reason: refusal,
      capability: String(context.capability),
    });
  }

  /**
   * task #1119: feed one exit into the breaker. When this exit crosses the
   * threshold, project the block once as a typed offline activity (counts,
   * classes, ids, times only). No stop/start/retry is issued here.
   */
  private async observeWakeCrashLoopExit(agentId: string, exit: WakeCrashLoopExit, span?: ActiveSpan | null): Promise<void> {
    const observation = await this.wakeCrashLoopBreaker.recordExit(agentId, exit, this.clock.now());
    span?.addEvent("wake_crash_loop.exit_observed", {
      counted: observation.counted,
      rejected: observation.rejected ?? "none",
      blocked_now: observation.blockedNow,
      early_exit_count: observation.snapshot.earlyExitCount,
      episode: observation.snapshot.episode,
      exit_kind: exit.kind,
      evidence_present: exit.evidence !== null,
      launch_id_present: exit.launchId !== null,
    });
    if (!observation.blockedNow) return;
    const cached = this.agentStateCache.get(agentId);
    this.recordLifecycleEvent({
      agentId,
      machineId: cached?.machineId ?? null,
      action: "wake",
      outcome: "suppressed",
      cause: "message",
      previousStatus: cached?.status ?? null,
      detail: "wake_crash_loop_armed",
    });
    console.warn(
      `[Agent ${agentId}] Automatic wakes paused: ${observation.snapshot.earlyExitCount} early exits in a row `
      + `(episode ${observation.snapshot.episode}, last ${exit.kind}${exit.evidence?.signal ? ` ${exit.evidence.signal}` : ""}); a manual start lifts it`,
    );
    this.pendingWakeCrashLoop.set(agentId, observation.snapshot);
    this.broadcastActivity(
      agentId,
      "offline",
      `Automatic wake paused after ${observation.snapshot.earlyExitCount} early exits`,
      "wake_crash_loop_blocked",
      [],
      undefined,
      { ...(observation.snapshot.lastLaunchId ? { launchId: observation.snapshot.lastLaunchId } : {}) },
    );
  }

  private formatRuntimeErrorActivity(error: AgentRuntimeErrorState): VisibleActivity {
    return this.formatActivity("error", error.message);
  }

  private async rememberRuntimeError(agentId: string, error: AgentRuntimeErrorState): Promise<boolean> {
    // Redis is an authority only for a value the durable row accepted. Publish
    // nothing (including the process-local shadow) when persistence is a no-op
    // or throws, otherwise another replica could observe Redis-only truth.
    // `durable` is what the row holds now: `error`, or the same error already
    // stored a moment ago (crash loop; see setAgentLastRuntimeError). Cache and
    // Redis carry that, so they never differ from the row.
    const durable = await this.persistAgentLastRuntimeError(agentId, error);
    if (!durable) return false;

    this.updateCache(agentId, { lastRuntimeError: durable });
    // gamma-2 shadow: the error state is daemon-reported ground truth
    // (observed); classification note filed for Kai's calibration table.
    this.emitActivityWriterShadowVerdict(agentId, {
      activity: "error",
      detailKind: "runtime_error",
      observationClass: "observed",
      site: "runtime_error",
    });
    const now = this.clock.now();
    const errorObservedAtMs = Date.parse(error.at);
    this.writeAgentActivitySnapshot(agentId, "error", error.message, "runtime_error", now, {
      observedAtMs: Number.isFinite(errorObservedAtMs) ? errorObservedAtMs : now,
      arbitration: {
        observationClass: "observed",
        signalSite: "runtime_error",
      },
    });
    await this.mirrorAgentRuntimeError(agentId, durable);
    return true;
  }

  private async clearLastRuntimeError(agentId: string): Promise<boolean> {
    // A Redis tombstone must never outrun the durable clear. Keeping all local
    // projections unchanged on rejection also prevents this replica from
    // claiming recovery that persistence did not accept.
    const persisted = await this.clearPersistedAgentLastRuntimeError(agentId);
    if (!persisted) return false;

    this.updateCache(agentId, { lastRuntimeError: null });
    const current = this.agentActivity.get(agentId);
    if (current?.activity === "error") {
      // gamma-2 shadow: the error->online restore is a server-derived write
      // (the recovery observation itself flows through ingest separately).
      this.emitActivityWriterShadowVerdict(agentId, {
        activity: "online",
        detailKind: "none",
        observationClass: "synthetic",
        site: "runtime_error",
      });
      this.writeAgentActivitySnapshot(agentId, "online", "", "none", this.clock.now(), {
        arbitration: {
          observationClass: "synthetic",
          signalSite: "runtime_error",
        },
      });
    }
    await this.mirrorAgentRuntimeError(agentId, null);
    return persisted;
  }

  private async mirrorAgentRuntimeError(
    agentId: string,
    error: AgentRuntimeErrorState | null,
  ): Promise<void> {
    if (!this.replicaStateStore.isAvailable()) return;
    try {
      // Unlike the lossy activity projection mirror, this write is awaited:
      // getActivity treats the Redis record as cross-replica authority.
      await this.replicaStateStore.setAgentRuntimeError(agentId, error);
    } catch (err) {
      // Redis degradation must not suppress the durable DB write. Readers that
      // cannot verify Redis authority re-source from persistence and never use
      // their process-local shadow.
      console.warn(
        `[Orchestrator] Failed to mirror runtime error for agent ${agentId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private buildRuntimeErrorState(input: {
    detail: string;
    launchId?: string;
    atMs?: number;
    /** #688(c): the normalized typed diagnostic that established this state, if any. */
    typed?: RuntimeErrorActivityDiagnostic | null;
  }): AgentRuntimeErrorState {
    const typed = input.typed ? {
      errorClass: input.typed.errorClass,
      errorReason: input.typed.errorReason,
      fingerprint: input.typed.fingerprint,
      reasonProvenance: input.typed.reasonProvenance,
    } : {};
    return {
      message: input.detail || "Agent encountered an error",
      at: new Date(input.atMs ?? this.clock.now()).toISOString(),
      ...(input.launchId !== undefined ? { launchId: input.launchId } : {}),
      actionRequired: true,
      ...typed,
    };
  }

  private isStartingActivitySnapshot(snapshot: ActivitySnapshot & { detailKind?: string | null }): boolean {
    if (snapshot.activity !== "working") return false;
    if (snapshot.detailKind === "starting" || snapshot.detailKind === "runtime_starting") return true;
    return snapshot.detail === "Starting…";
  }

  protected maybeResolveStartingActivity(agentId: string, span?: ActiveSpan | null) {
    const current = this.agentActivity.get(agentId);
    if (!current) {
      span?.addEvent("starting_activity.resolve", { outcome: "skip", reason: "no_current_activity" });
      return;
    }
    if (current.activity !== "working") {
      span?.addEvent("starting_activity.resolve", { outcome: "skip", reason: "not_working", current_activity: current.activity });
      return;
    }
    if (!this.isStartingActivitySnapshot(current)) {
      span?.addEvent("starting_activity.resolve", { outcome: "skip", reason: "not_starting_detail", current_detail_kind: current.detailKind });
      return;
    }
    span?.addEvent("starting_activity.resolve", { outcome: "resolved", reason: "starting_activity_snapshot" });
    // gamma-2 shadow: g1 Phase A pinned this resolve racing the first real
    // working of a launch and stomping it with online (arrival-order LWW).
    // The kernel refuses that authority (synthetic vs fresh observed).
    this.emitActivityWriterShadowVerdict(agentId, {
      activity: "online",
      detailKind: "none",
      observationClass: "synthetic",
      site: "starting_resolve",
    });
    this.broadcastActivity(agentId, "online", "", "none", [{ kind: "status", activity: "online", activityKind: "online", detail: "", detailKind: "none" }]);
  }

  private isFreshnessHoldActivitySnapshot(snapshot: ActivitySnapshot & { detailKind?: string | null }): boolean {
    return snapshot.activity === "working"
      && snapshot.detailKind === "slock_action"
      && snapshot.detail === "Send held by freshness check";
  }

  protected terminalizeFreshnessHold(
    agentId: string,
    reason: "freshness_hold_terminalized",
    span?: ActiveSpan | null,
  ) {
    const producerFactId = `lifecycle_plan:${reason}`;
    const current = this.agentActivity.get(agentId);
    if (!current) {
      span?.addEvent("freshness_hold.terminalize", { outcome: "skip", reason: "no_current_activity" });
      return;
    }
    if (!this.isFreshnessHoldActivitySnapshot(current)) {
      span?.addEvent("freshness_hold.terminalize", {
        outcome: "skip",
        reason: "not_freshness_hold",
        current_activity: current.activity,
        current_detail_kind: current.detailKind,
      });
      return;
    }
    span?.addEvent("freshness_hold.terminalize", { outcome: "resolved", reason });
    this.emitActivityWriterShadowVerdict(agentId, {
      activity: "online",
      detailKind: "idle",
      observationClass: "control",
      site: "lifecycle_plan",
    });
    this.broadcastActivity(
      agentId,
      "online",
      "",
      "idle",
      [{ kind: "status", activity: "online", activityKind: "online", detail: "", detailKind: "idle", producerFactId }],
      undefined,
      {
        producerFactId,
        arbitration: {
          observationClass: "control",
          signalSite: "lifecycle_plan",
        },
      },
    );
  }

  private isFreshBusyActivity(snapshot: ActivitySnapshot | PersistedAgentActivityHint): boolean {
    if (!this.isTransientActivity(snapshot.activity)) return false;
    if (snapshot.activity === "working" && (snapshot.detailKind === "starting" || snapshot.detailKind === "runtime_starting")) return false;
    return this.getActivityAgeSec(snapshot) <= AgentOrchestrator.ACTIVITY_STALE_SEC;
  }

  private async shouldPreserveBusyActivity(agentId: string): Promise<boolean> {
    const current = this.agentActivity.get(agentId);
    if (current && this.isFreshBusyActivity(current)) return true;

    const persisted = await this.loadLatestPersistedActivityHint(agentId);
    return Boolean(persisted && this.isFreshBusyActivity(persisted));
  }

  private isDurableRecoveryActivity(activity: string): boolean {
    return activity === "offline" || activity === "error";
  }

  private static READY_ONLINE_DEDUP_MS = 1000;

  private async broadcastReadyOnline(agentId: string, span?: ActiveSpan | null) {
    const now = this.clock.now();
    const lastBroadcast = this.lastReadyOnlineBroadcastAt.get(agentId) ?? 0;
    if (now - lastBroadcast < AgentOrchestrator.READY_ONLINE_DEDUP_MS) {
      span?.addEvent("ready_online.resolve", { agent_id: agentId, outcome: "skip", reason: "dedup_window" });
      return;
    }
    this.lastReadyOnlineBroadcastAt.set(agentId, now);

    const current = this.agentActivity.get(agentId);
    if (current && this.isFreshBusyActivity(current)) {
      span?.addEvent("ready_online.resolve", { agent_id: agentId, outcome: "skip", reason: "fresh_busy_cached", cached_activity: current.activity });
      return;
    }

    const persisted = await this.loadLatestPersistedActivityHint(agentId);
    if (persisted && this.isFreshBusyActivity(persisted)) {
      span?.addEvent("ready_online.resolve", { agent_id: agentId, outcome: "skip", reason: "fresh_busy_persisted", persisted_activity: persisted.activity });
      return;
    }

    const agent = await this.getCachedAgent(agentId);
    if (agent?.lastRuntimeError) {
      span?.addEvent("ready_online.resolve", { agent_id: agentId, outcome: "skip", reason: "runtime_error_state" });
      return;
    }

    const previous = current ?? persisted;
    const hasDurableRecovery = Boolean(previous && this.isDurableRecoveryActivity(previous.activity));
    const entries: TrajectoryEntry[] | undefined =
      hasDurableRecovery
        ? [{ kind: "status", activity: "online", activityKind: "online", detail: "", detailKind: "none" }]
        : undefined;

    span?.addEvent("ready_online.resolve", {
      agent_id: agentId,
      outcome: "broadcast",
      previous_activity: previous?.activity ?? "none",
      has_trajectory_entry: hasDurableRecovery,
    });
    // gamma-2 shadow: machine-ready reconcile synthesizing an agent-axis
    // online claim (g1 saw it fire twice on one daemon reconnect).
    this.emitActivityWriterShadowVerdict(agentId, {
      activity: "online",
      detailKind: "none",
      observationClass: "synthetic",
      site: "ready_online",
    });
    this.broadcastActivity(agentId, "online", "", "none", entries);
  }

  private async resolveLastRuntimeErrorActivity(
    agentId: string,
    agent: CachedAgentState | null,
    loadAuthoritativeAgent: () => Promise<CachedAgentState | null> = () => this.getAuthoritativeAgentForDelivery(agentId),
  ): Promise<{
    agent: CachedAgentState | null;
    activity: VisibleActivity | null;
    source: "runtime-error-l1" | "runtime-error-redis" | "runtime-error-persisted" | null;
  }> {
    if (agent?.status === "stopped") {
      return { agent, activity: null, source: null };
    }

    if (this.replicaStateStore.isAvailable()) {
      try {
        const mirror = await this.replicaStateStore.getAgentRuntimeError(agentId);
        if (mirror) {
          const localError = agent?.lastRuntimeError ?? null;
          const localMatches = fingerprintAgentRuntimeError(localError) === mirror.fingerprint
            && localError?.actionRequired === mirror.error?.actionRequired;
          if (!localMatches) {
            this.updateCache(agentId, { lastRuntimeError: mirror.error });
            if (agent) agent.lastRuntimeError = mirror.error;
          }
          const error = localMatches ? localError : mirror.error;
          return {
            agent,
            activity: error ? this.formatRuntimeErrorActivity(error) : null,
            source: error ? (localMatches ? "runtime-error-l1" : "runtime-error-redis") : null,
          };
        }

        // A missing mirror is a rollout/expiry cache miss, not authority for a
        // process-local value. Re-source from DB once and seed an explicit error
        // or clear record so subsequent replica reads converge without a DB hit.
        const freshAgent = await loadAuthoritativeAgent();
        if (freshAgent) {
          await this.mirrorAgentRuntimeError(agentId, freshAgent.lastRuntimeError);
        }
        return {
          agent: freshAgent,
          activity: freshAgent?.lastRuntimeError
            ? this.formatRuntimeErrorActivity(freshAgent.lastRuntimeError)
            : null,
          source: freshAgent?.lastRuntimeError ? "runtime-error-persisted" : null,
        };
      } catch (err) {
        // Treat an unreachable Redis command exactly like isAvailable=false.
        // The durable read below is authoritative; local memory is never used.
        console.warn(
          `[Orchestrator] Failed to read runtime error mirror for agent ${agentId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    const freshAgent = await loadAuthoritativeAgent();
    return {
      agent: freshAgent,
      activity: freshAgent?.lastRuntimeError
        ? this.formatRuntimeErrorActivity(freshAgent.lastRuntimeError)
        : null,
      source: freshAgent?.lastRuntimeError ? "runtime-error-persisted" : null,
    };
  }

  private getActivityObservedAtMs(snapshot: ActivityClockSnapshot): number {
    return snapshot.observedAtMs ?? snapshot.updatedAt;
  }

  private getActivityAgeSec(snapshot: ActivityClockSnapshot): number {
    return (this.clock.now() - this.getActivityObservedAtMs(snapshot)) / 1000;
  }

  private getWeakOfflineSource(
    input: MachineReachabilityPlanInput,
    reachability: MachineReachability,
  ): WeakOfflineSource | null {
    if (reachability !== "offline") return null;
    if (!input.replicaStateAvailable) return "replica_state_unavailable";
    if (input.ownerReplica === REPLICA_ID && !input.hasLocalMachine) {
      return "self_owner_without_local_connection";
    }
    if (input.hasMachineId && !input.ownerReplica) return "owner_missing";
    return null;
  }

  private getWeakOfflineCompetingFact(
    snapshot: ActivitySnapshot | PersistedAgentActivityHint,
    source: ActivityHintSource | "persisted",
  ): WeakOfflineCompetingFact | null {
    if (!this.isFreshBusyActivity(snapshot)) return null;
    if (source === "persisted") return "persisted_busy_activity";
    if (source === "redis" && "observedAtMs" in snapshot && snapshot.observedAtMs !== undefined) {
      return "redis_busy_activity";
    }
    return null;
  }

  private getSuppressibleWeakOfflineSource(
    agent: CachedAgentState | null,
    reachabilityInput: MachineReachabilityPlanInput,
    reachability: MachineReachability,
  ): WeakOfflineSource | null {
    if (!agent || agent.status !== "active") return null;
    const weakSource = this.getWeakOfflineSource(reachabilityInput, reachability);
    return weakSource === "owner_missing" ? weakSource : null;
  }

  private normalizeStaleTransientActivity(
    agentId: string,
    snapshot: ActivitySnapshot,
    source: ActivityHintSource,
  ): VisibleActivity | null {
    const action = planStaleTransientNormalizationAction({
      isTransient: this.isTransientActivity(snapshot.activity),
      ageSec: this.getActivityAgeSec(snapshot),
      staleAfterSec: AgentOrchestrator.ACTIVITY_STALE_SEC,
    });
    return this.applyStaleTransientNormalizationAction({
      action,
      agentId,
      source,
      now: this.clock.now(),
    });
  }

  protected applyStaleTransientNormalizationAction(
    context: StaleTransientNormalizationApplyContext,
  ): VisibleActivity | null {
    if (context.action === "keep-current") {
      return null;
    }

    if (context.source === "local-cache") {
      const serverId = this.agentStateCache.get(context.agentId)?.serverId ?? "unknown";
      const current = this.agentActivity.get(context.agentId);
      this.recordEvent("server.agent.synthetic_repair.apply", {
        agent_id: context.agentId,
        server_id: serverId,
        synthetic_repair: true,
        repair_kind: "transient_normalization",
        source: "scheduler",
        authority: "scheduler_repair",
        previous_activity: current?.activity ?? "none",
        candidate_activity: "online",
        served_activity: "online",
        projection_outcome: "served_ephemeral",
        outcome: "served_ephemeral",
        reason: "synthetic_no_authority",
        advances_observed_clock: "none",
      });
      // Record the rejected online candidate, then serve online only as an
      // ephemeral read view. No map, persistence, broadcast, or clock write.
      this.emitSyntheticRepairShadowVerdict(context.agentId, context.now);
    }
    return this.formatActivity("online");
  }

  private async getMachineReachability(agent: CachedAgentState | null): Promise<MachineReachability> {
    return planMachineReachability(await this.loadMachineReachabilityPlanInput({ agent }));
  }

  protected async loadMachineReachabilityPlanInput(
    context: MachineReachabilityInputContext,
  ): Promise<MachineReachabilityPlanInput> {
    const machineId = context.agent?.machineId ?? null;
    const replicaStateAvailable = this.replicaStateStore.isAvailable();
    const hasLocalMachine = Boolean(machineId && this.hasMachineLocally(machineId));
    const ownerReplica = machineId && replicaStateAvailable && !hasLocalMachine
      ? await this.replicaStateStore.getMachineReplicaOwner(machineId)
      : null;

    return {
      hasMachineId: Boolean(machineId),
      hasLocalMachine,
      replicaStateAvailable,
      ownerReplica,
      isExternalRuntime: isExternalAgentRuntime(context.agent?.runtime),
    };
  }

  private shouldTrustRecoveredOfflineHint(
    agent: CachedAgentState | null,
    snapshot: ActivitySnapshot,
    reachability: MachineReachability,
  ): boolean {
    return snapshot.activity === "offline"
      && agent?.status === "active"
      && reachability !== "offline"
      && reachability !== "none";
  }

  private async resolveActivityHint(
    agentId: string,
    agent: CachedAgentState | null,
    snapshot: ActivitySnapshot,
    source: ActivityHintSource,
    span: ActiveSpan,
  ): Promise<VisibleActivity | null> {
    span.addEvent("activity.hint.seen", {
      source,
      activity: snapshot.activity,
    });

    const planInput = await this.loadActivityHintResolutionPlanInput({
      agent,
      snapshot,
      source,
    });
    span.addEvent("activity.reachability.resolved", {
      source,
      reachability: planInput.reachability,
      agentStatus: agent?.status ?? null,
      hasMachineId: Boolean(agent?.machineId),
    });

    const action = planActivityHintResolutionAction(planInput);
    if (planInput.weakOfflineSource && planInput.weakOfflineCompetingFact) {
      span.addEvent("suppressed_weak_offline", {
        weak_source: planInput.weakOfflineSource,
        competing_fact: planInput.weakOfflineCompetingFact,
        hint_source: source,
        reachability: planInput.reachability,
        resolved_activity: snapshot.activity,
      });
    }
    if (action === "return-offline" || action === "ignore-hint") {
      span.addEvent("activity.hint.ignored", {
        source,
        reason: action === "return-offline" ? "hard-reachability-offline" : "hint-not-trusted",
      });
      return this.applyActivityHintResolutionAction({
        action,
        agentId,
        snapshot,
      });
    }

    const normalized = this.normalizeStaleTransientActivity(agentId, snapshot, source);
    if (normalized) {
      span.addEvent("activity.hint.normalized", {
        source,
        activity: snapshot.activity,
        result: normalized.activity,
      });
      return normalized;
    }

    span.addEvent("activity.hint.candidate", {
      hint_source: source,
      candidate_activity: snapshot.activity,
      // trace_events_v2 compatibility alias; the raw event carries the
      // candidate-specific field above.
      resolved_activity: snapshot.activity,
    });

    const resolved = this.applyActivityHintResolutionAction({
      action,
      agentId,
      snapshot,
    });
    if (resolved) {
      this.emitActivityHintApplied(
        span,
        source,
        snapshot.activity,
        resolved.activity,
        action === "return-read-through-snapshot" ? "owner_mirror_read_through" : "trusted_snapshot",
      );
    }
    return resolved;
  }

  private emitActivityHintApplied(
    span: ActiveSpan,
    source: ActivityHintSource,
    candidateActivity: AgentActivityKind,
    servedActivity: AgentActivityKind,
    arbitrationReason: ActivityHintArbitrationReason,
  ): void {
    span.addEvent("activity.hint.applied", {
      hint_source: source,
      candidate_activity: candidateActivity,
      served_activity: servedActivity,
      write_action: "none",
      arbitration_reason: arbitrationReason,
      // Keep the closed decision queryable through the existing event-row
      // schema while the raw event uses the more precise contract names.
      resolved_activity: candidateActivity,
      next_activity: servedActivity,
      action: "none",
      reason: arbitrationReason,
    });
  }

  protected async loadActivityHintResolutionPlanInput(
    context: ActivityHintResolutionInputContext,
  ): Promise<ActivityHintResolutionPlanInput> {
    const reachabilityInput = await this.loadMachineReachabilityPlanInput({ agent: context.agent });
    const reachability = planMachineReachability(reachabilityInput);
    const hasStoppedOfflineHint = context.snapshot.activity === "offline" && context.snapshot.detailKind === "stopped";
    const weakOfflineSource = hasStoppedOfflineHint ? null : this.getSuppressibleWeakOfflineSource(
      context.agent,
      reachabilityInput,
      reachability,
    );
    const weakOfflineCompetingFact = weakOfflineSource
      ? this.getWeakOfflineCompetingFact(context.snapshot, context.source)
      : null;
    return {
      hasStoppedOfflineHint,
      reachability,
      shouldTrustRecoveredOfflineHint: this.shouldTrustRecoveredOfflineHint(
        context.agent,
        context.snapshot,
        reachability,
      ),
      ...(weakOfflineSource ? { weakOfflineSource } : {}),
      ...(weakOfflineCompetingFact ? { weakOfflineCompetingFact } : {}),
      source: context.source,
      isFreshLocalCache: this.getActivityAgeSec(context.snapshot) < 15,
    };
  }

  protected applyActivityHintResolutionAction(
    context: ActivityHintResolutionApplyContext,
  ): VisibleActivity | null {
    if (context.action === "return-snapshot") {
      return this.formatActivityFromSnapshot(context.snapshot);
    }

    if (context.action === "return-offline") {
      return this.formatActivity("offline");
    }

    if (context.action === "ignore-hint") {
      return null;
    }

    // A non-owner Redis mirror is authoritative for this read, but it is not a
    // local observation. Serve it directly without promoting it into this
    // replica's local serving authority.
    return this.formatActivityFromSnapshot(context.snapshot);
  }

  private async resolveDerivedActivity(agent: CachedAgentState | null): Promise<VisibleActivity> {
    const reachability = await this.getMachineReachability(agent);

    if (reachability === "external-reported") {
      return this.formatActivity("offline");
    }

    const isReachable = reachability === "local" || reachability === "remote";
    return this.formatActivity(
      agent
      && isReachable
      && agent.status === "active"
        ? "online"
        : "offline",
    );
  }

  private async resolveRecentPersistedActivity(
    agentId: string,
    agent: CachedAgentState | null,
    span: ActiveSpan,
  ): Promise<VisibleActivity | null> {
    const reachabilityInput = await this.loadMachineReachabilityPlanInput({ agent });
    const reachability = planMachineReachability(reachabilityInput);
    const isExternal = reachability === "external-reported";
    // These rule the persisted hint out below whatever it holds; skip its query
    // (every listed deleted / inactive agent paid it on every agent-list read).
    if (!agent || (!isExternal && agent.status !== "active")) return null;
    const persisted = await this.loadLatestPersistedActivityHint(agentId);
    const weakOfflineSource = this.getSuppressibleWeakOfflineSource(agent, reachabilityInput, reachability);
    const weakOfflineCompetingFact = weakOfflineSource && persisted
      ? this.getWeakOfflineCompetingFact(persisted, "persisted")
      : null;

    if (
      !agent
      || (!isExternal && agent.status !== "active")
      || (!isExternal && (reachability === "offline" || reachability === "none") && !weakOfflineCompetingFact)
      || !persisted
      || !this.isTransientActivity(persisted.activity)
      || this.getActivityAgeSec(persisted) > AgentOrchestrator.ACTIVITY_STALE_SEC
    ) {
      return null;
    }

    if (weakOfflineSource && weakOfflineCompetingFact) {
      span.addEvent("suppressed_weak_offline", {
        weak_source: weakOfflineSource,
        competing_fact: weakOfflineCompetingFact,
        hint_source: "persisted",
        reachability,
        resolved_activity: persisted.activity,
      });
    }

    return this.formatActivity(persisted.activity, persisted.detail);
  }

  // Agent state cache management

  /** Get cached agent state, falling back to DB on cache miss */
  private async getCachedAgent(agentId: string, knownRow?: PersistedAgentRow): Promise<CachedAgentState | null> {
    const cached = this.agentStateCache.get(agentId);
    if (cached) return cached;

    // The caller's row from this request answers the miss without a query:
    // a deleted row is what getAgent(id, false) would return as null.
    if (knownRow) {
      if (knownRow.deletedAt) return null;
      const seeded = this.cachedStateFromPersistedAgent(knownRow);
      this.agentStateCache.set(agentId, seeded);
      return seeded;
    }

    // Cache miss — load from DB and populate cache
    const agent = await agentService.getAgent(agentId, false, {
      dbCallsite: "agent_orchestrator.cache_miss",
    });
    if (!agent) return null;

    const state = this.cachedStateFromPersistedAgent(agent);
    this.agentStateCache.set(agentId, state);
    return state;
  }

  private cachedStateFromPersistedAgent(agent: PersistedAgentRow, existing?: CachedAgentState): CachedAgentState {
    const runtimeConfig = hydrateRuntimeConfig(agent);
    const launchRuntimeFields = runtimeConfigToLaunchFields(runtimeConfig);
    return {
      id: agent.id,
      status: agent.status,
      machineId: agent.machineId,
      sessionId: agent.sessionId,
      expectedLaunchId: existing?.expectedLaunchId ?? null,
      launchGuardMode: existing?.launchGuardMode ?? "legacy",
      serverId: agent.serverId,
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      model: launchRuntimeFields.model,
      runtime: launchRuntimeFields.runtime,
      lastRuntimeError: agent.lastRuntimeError ?? null,
      runtimeState: existing?.machineId === agent.machineId ? existing.runtimeState : "unknown",
      reasoningEffort: launchRuntimeFields.reasoningEffort,
      runtimeConfig,
      envVars: launchRuntimeFields.envVars,
    };
  }

  protected async loadAgentForDelivery(agentId: string): Promise<PersistedAgentRow | null> {
    return agentService.getAgent(agentId, false, {
      dbCallsite: "agent_orchestrator.delivery",
    });
  }

  /**
   * Passive-delivery scope check. Default impl reads `agent_scopes` via
   * `agentHasScope`; deterministic tests override to bypass DB. See
   * `DeliverMessageOptions.intrinsic` for the full design rationale.
   */
  protected async hasPassiveDeliveryScope(agentId: string): Promise<boolean> {
    return agentHasScope(agentId, "inbox:receive");
  }

  // `protected` for the same reason: arms ②③ must get past identity resolution to reach the
  // branch under test, and stubbing it is the only way to do that without seeding a full agent row.
  /**
   * getAuthoritativeAgentForDelivery for activity reads. A deleted row loaded by
   * the caller in this request answers it without a query, with the same effect
   * (getAgent excludes deleted rows: the cache entry is dropped, null returned).
   */
  private async getAuthoritativeAgentForActivity(
    agentId: string,
    knownRow: PersistedAgentRow | undefined,
  ): Promise<CachedAgentState | null> {
    if (knownRow?.deletedAt) {
      this.agentStateCache.delete(agentId);
      return null;
    }
    return this.getAuthoritativeAgentForDelivery(agentId);
  }

  protected async getAuthoritativeAgentForDelivery(agentId: string): Promise<CachedAgentState | null> {
    const persisted = await this.loadAgentForDelivery(agentId);
    if (!persisted) {
      this.agentStateCache.delete(agentId);
      return null;
    }

    const state = this.cachedStateFromPersistedAgent(persisted, this.agentStateCache.get(agentId));
    this.agentStateCache.set(agentId, state);
    return state;
  }

  /** Update cache entry (partial update) */
  private updateCache(agentId: string, updates: Partial<CachedAgentState>) {
    const cached = this.agentStateCache.get(agentId);
    if (cached) {
      Object.assign(cached, updates);
    }
  }

  protected setLaunchGuard(agentId: string, launchId: string) {
    this.updateCache(agentId, { expectedLaunchId: launchId, launchGuardMode: "guarded" });
  }

  protected clearLaunchGuard(agentId: string) {
    this.updateCache(agentId, { expectedLaunchId: null, launchGuardMode: "legacy" });
  }

  protected shouldAcceptLifecycleEvent(
    machineId: string,
    agent: CachedAgentState,
    messageType: MachineToServerMessage["type"],
    launchId?: string,
    span?: ActiveSpan | null,
  ): boolean {
    const action = this.getLifecycleEventAcceptanceAction(agent, launchId);

    if (action === "accept") {
      return true;
    }

    this.handleRejectedLifecycleEvent(machineId, agent, messageType, launchId, action, span);
    return false;
  }

  protected getLifecycleEventAcceptanceAction(
    agent: CachedAgentState,
    launchId?: string,
  ): LifecycleEventAcceptanceAction {
    return planLifecycleEventAcceptance({
      launchGuardMode: agent.launchGuardMode,
      expectedLaunchId: agent.expectedLaunchId,
      launchId,
    });
  }

  private logLifecycleEventDrop(
    machineId: string,
    agent: CachedAgentState,
    messageType: MachineToServerMessage["type"],
    launchId: string | undefined,
    action: Exclude<LifecycleEventAcceptanceAction, "accept">,
  ) {
    if (action === "ignore-legacy-for-guarded") {
      console.warn(
        `[Machine ${machineId}] Ignoring legacy ${messageType} for guarded agent ${agent.name} (${agent.expectedLaunchId})`,
      );
      return;
    }

    console.warn(
      `[Machine ${machineId}] Ignoring stale ${messageType} for agent ${agent.name}: expected launch ${agent.expectedLaunchId}, got ${launchId}`,
    );
  }

  private handleRejectedLifecycleEvent(
    machineId: string,
    agent: CachedAgentState,
    messageType: MachineToServerMessage["type"],
    launchId: string | undefined,
    action: Exclude<LifecycleEventAcceptanceAction, "accept">,
    span?: ActiveSpan | null,
  ) {
    this.logLifecycleEventDrop(machineId, agent, messageType, launchId, action);
    if (!this.shouldResolveStartingActivityForRejectedLifecycleEvent(agent.id)) return;

    span?.addEvent("lifecycle_guard.starting_resolve_on_reject", {
      action,
      message_type: messageType,
    });
    this.maybeResolveStartingActivity(agent.id, span);
  }

  private shouldResolveStartingActivityForRejectedLifecycleEvent(agentId: string): boolean {
    const current = this.agentActivity.get(agentId);
    return Boolean(current && this.isStartingActivitySnapshot(current));
  }

  /** Remove agent from cache */
  evictCache(agentId: string) {
    this.agentStateCache.delete(agentId);
  }

  // Machine WebSocket management

  private latestHeartbeatProofAt(conn: MachineConnection): number {
    return Math.max(conn.lastPong, conn.lastIngressAt);
  }

  private isMachineHeartbeatStale(conn: MachineConnection): boolean {
    return this.clock.now() - this.latestHeartbeatProofAt(conn) > AgentOrchestrator.MACHINE_HEARTBEAT_TIMEOUT_MS;
  }

  protected onMachineHeartbeatTick(machineId: string, conn: MachineConnection) {
    const lastPongAgeMs = this.clock.now() - conn.lastPong;
    const lastIngressAgeMs = this.clock.now() - conn.lastIngressAt;
    const heartbeatProofAgeMs = this.clock.now() - this.latestHeartbeatProofAt(conn);
    void this.runInTraceSpan(
      "server.machine.websocket.heartbeat",
      {
        parent: null,
        attrs: {
          machine_id: machineId,
          server_id: conn.serverId,
          machine_id_present: Boolean(machineId),
          server_id_present: Boolean(conn.serverId),
          daemon_version_present: Boolean(conn.daemonVersion),
          ws_ready_state: conn.ws.readyState,
          last_pong_age_ms_bucket: durationMsBucket(lastPongAgeMs),
          last_ingress_age_ms_bucket: durationMsBucket(lastIngressAgeMs),
          heartbeat_proof_age_ms_bucket: durationMsBucket(heartbeatProofAgeMs),
          heartbeat_timeout_ms: AgentOrchestrator.MACHINE_HEARTBEAT_TIMEOUT_MS,
        },
      },
      async (): Promise<{ status: TraceStatus; attrs: TraceAttributes }> => {
        if (this.isMachineHeartbeatStale(conn)) {
          console.log(`[Machine ${machineId}] Heartbeat timeout — terminating socket`);
          this.recordEvent("heartbeat.timeout", {
            outcome: "heartbeat_timeout",
            reason: "heartbeat_timeout",
            last_pong_age_ms_bucket: durationMsBucket(lastPongAgeMs),
            last_ingress_age_ms_bucket: durationMsBucket(lastIngressAgeMs),
            heartbeat_proof_age_ms_bucket: durationMsBucket(heartbeatProofAgeMs),
            ws_ready_state: conn.ws.readyState,
          });
          // Use terminate() (TCP RST) rather than close() so the connection is
          // dropped even in half-open / black-hole network conditions.
          try { conn.ws.terminate(); } catch { /* ignore */ }
          void this.handleMachineDisconnect(machineId, conn.ws, { cause: "heartbeat_timeout" });
          return { status: "error", attrs: { outcome: "heartbeat_timeout", terminated_socket: true } };
        }
        try {
          const sent = await this.sendToMachine(machineId, { type: "ping" });
          return sent
            ? { status: "ok", attrs: { outcome: "ping_sent", sent: true } }
            : { status: "error", attrs: { outcome: "ping_send_failed", sent: false } };
        } catch (err) {
          console.warn(`[Machine ${machineId}] best-effort ping send failed:`, err);
          return {
            status: "error",
            attrs: { outcome: "ping_send_failed", sent: false, error_class: errorClassOf(err) },
          };
        }
      },
      (result) => result,
    );
  }

  protected startMachineHeartbeat(machineId: string, conn: MachineConnection) {
    this.recordEvent("server.machine.websocket.heartbeat_timer", {
      machine_id: machineId,
      server_id: conn.serverId,
      machine_id_present: Boolean(machineId),
      server_id_present: Boolean(conn.serverId),
      interval_ms: 30_000,
      outcome: "started",
    });
    conn.heartbeatTimer = this.clock.scheduleRepeated(() => this.onMachineHeartbeatTick(machineId, conn), 30_000);
  }

  protected async loadRuntimeAccountUsageAttacher(serverId: string, machineId: string): Promise<string | null> {
    return (await getComputerLinkedMachineAttachers(serverId)).get(machineId) ?? null;
  }

  protected async isRuntimeAccountUsageDataBoundaryAuthorized(
    machineId: string,
    conn: MachineConnection,
  ): Promise<boolean> {
    if (this.machineConnections.get(machineId) !== conn || conn.principalKind !== "computer") return false;
    const attachedBy = await this.loadRuntimeAccountUsageAttacher(conn.serverId, machineId);
    return this.machineConnections.get(machineId) === conn && Boolean(attachedBy);
  }

  protected async writeRuntimeAccountUsageSnapshot(machineId: string, snapshot: unknown): Promise<void> {
    await runtimeAccountUsageCacheService.write(machineId, snapshot);
  }

  protected async collectScheduledRuntimeAccountUsage(machineId: string, conn: MachineConnection): Promise<void> {
    if (this.machineConnections.get(machineId) !== conn || !conn.runtimes) return;
    if (!await this.isRuntimeAccountUsageDataBoundaryAuthorized(machineId, conn)) return;
    for (const provider of runtimeAccountUsageProvidersForRuntimes(conn.runtimes)) {
      if (!await runtimeAccountUsageCacheService.tryAcquireRefresh(machineId, provider)) continue;
      await this.requestRuntimeAccountUsageRefresh(machineId, provider, "scheduled");
    }
  }

  private startRuntimeAccountUsageSchedule(machineId: string, conn: MachineConnection): void {
    if (conn.runtimeAccountUsageTimer) this.clock.cancelRepeated(conn.runtimeAccountUsageTimer);
    void this.collectScheduledRuntimeAccountUsage(machineId, conn).catch(() => {});
    conn.runtimeAccountUsageTimer = this.clock.scheduleRepeated(() => {
      void this.collectScheduledRuntimeAccountUsage(machineId, conn).catch(() => {});
    }, runtimeAccountUsageIntervalMs(machineId));
    (conn.runtimeAccountUsageTimer as { unref?: () => void })?.unref?.();
  }

  protected async autoAssignConnectedMachine(serverId: string, machineId: string) {
    await agentService.autoAssignMachine(serverId, machineId);
  }

  protected async loadAgentsForDisconnect(machineId: string) {
    return agentService.getAgentsForMachine(machineId);
  }

  protected async persistMachineCapabilities(
    machineId: string,
    runtimes: string[],
    hostname?: string,
    os?: string,
    daemonVersion?: string | null,
  ) {
    await machineService.updateMachineRuntimes(machineId, runtimes, hostname, os, daemonVersion);
  }

  protected async persistMachineComputerVersion(
    machineId: string,
    computerVersion: string | null | undefined,
    reportedAt: Date,
  ): Promise<boolean> {
    return machineService.recordMachineComputerVersion(machineId, computerVersion, reportedAt);
  }

  private async recordReportedMachineComputerVersion(
    machineId: string,
    computerVersion: string | null | undefined,
    source: "ready" | "lifecycle_ack",
  ): Promise<void> {
    if (!computerVersion?.trim()) return;
    await this.runInTraceSpan(
      "server.machine.computer_version.persist",
      { attrs: { machine_id: machineId, source } },
      async (): Promise<{ status: TraceStatus; attrs: TraceAttributes }> => {
        try {
          const updated = await this.persistMachineComputerVersion(
            machineId,
            computerVersion,
            new Date(this.clock.now()),
          );
          return { status: "ok", attrs: { outcome: updated ? "updated" : "unchanged" } };
        } catch (err) {
          return { status: "error", attrs: { outcome: "failed", error_class: errorClassOf(err) } };
        }
      },
      (result) => result,
    );
  }

  private static readonly CAPABILITIES_PERSIST_RETRY_BASE_MS = 500;
  private static readonly CAPABILITIES_PERSIST_RETRY_MAX_MS = 30_000;
  // After this many consecutive failures we escalate to a loud trace so a stuck
  // control-plane write is visible; we keep retrying at the capped interval
  // rather than giving up. Giving up would silently strand the owner on Screen B
  // (the setup projection reads the persisted column), which is the very
  // liveness gap this path closes.
  private static readonly CAPABILITIES_PERSIST_ALERT_AFTER_ATTEMPTS = 5;
  private static readonly AGENT_SKILLS_LIST_TIMEOUT_MS = 15_000;
  private static readonly AGENT_SKILLS_LIST_LATE_RESULT_OBSERVATION_MS = 60_000;

  /**
   * The one place in this file that schedules on the injected clock.
   *
   * Keep scheduling centralized so callers share the same deterministic test
   * seam and typed-handle behavior. Callers that must not hold the process open
   * still call `.unref()` on the handle they get back.
   */
  private scheduleOnClock(fn: () => void, ms: number): unknown {
    return this.clock.setTimeout(fn, ms);
  }

  private nextCapabilitiesGeneration(machineId: string): number {
    const next = (this.capabilitiesGenerationSeq.get(machineId) ?? 0) + 1;
    this.capabilitiesGenerationSeq.set(machineId, next);
    return next;
  }

  /**
   * Persist daemon-reported capabilities, then — ONLY after the write lands —
   * update the in-memory connection and emit the client `machine:capabilities`
   * card. The setup projection reads the persisted `machines.runtimes` column as
   * its single cross-replica source, so the card and conn must never advance
   * past what actually reached the DB (otherwise the card shows "runtime
   * detected" while the projection reads the un-persisted column → Next dead).
   *
   * Two invariants, both structural (not "decide who wins afterwards"):
   *
   * 1. Liveness (#4695): a transient persist failure must NOT depend on the
   *    daemon sending another `ready` to recover. runCapabilitiesWriter retries
   *    the latest payload itself on a capped exponential backoff until it lands.
   *
   * 2. Single-writer serialization (@铁根/@Dozy/@Jianwei/@Jiayuan): at most ONE
   *    persist is in flight per machine. A concurrent `ready` only overwrites
   *    `latest` + bumps the monotonic generation — it does NOT start a second
   *    persist. This is what makes it *impossible* for an older write to land
   *    after a newer one (the earlier "post-await generation guard" only shielded
   *    conn/card; it could not un-write a stale DB row that was already in flight).
   *    The last write is always the latest payload, so DB/conn/card converge.
   *
   * A newer payload supersedes in place (monotonic generation, never reused →
   * no ABA); disconnect cancels or, if a write is in flight, marks the entry so
   * the loop finishes without emitting; we never hard-exhaust — a persistently
   * failing write escalates to a loud trace but keeps converging.
   *
   * Out of scope (Jiayuan's follow-up ledger): distinguishing clearly
   * non-retryable failures (constraint/permission/missing-row) and giving the
   * owner a user-visible retry via a separate `capabilities_persist_failed`
   * gateReason on a path independent of this failing write — not reusing
   * `runtime_error` and not writing a "DB-write-failed" marker through the same
   * failing DB.
   */
  protected async enqueueCapabilitiesPersist(machineId: string, payload: CapabilitiesPersistPayload): Promise<void> {
    const generation = this.nextCapabilitiesGeneration(machineId);
    const existing = this.capabilitiesWrites.get(machineId);
    if (existing) {
      // Overwrite the pending payload in place. If a persist is currently in
      // flight (writing), the running loop will pick this up when it resolves;
      // we must not start a second concurrent writer.
      if (existing.timer != null) {
        this.clock.clearTimeout(existing.timer);
        existing.timer = null;
      }
      existing.latest = payload;
      existing.generation = generation;
      existing.attempt = 0;
      existing.cancelled = false;
    } else {
      this.capabilitiesWrites.set(machineId, { latest: payload, generation, writing: false, timer: null, attempt: 0, cancelled: false });
    }
    // Await so the happy path persists + emits before the `ready` handler
    // returns (unchanged from the previous inline persist). If a writer is
    // already running this returns immediately and that writer converges.
    await this.runCapabilitiesWriter(machineId);
  }

  private async runCapabilitiesWriter(machineId: string): Promise<void> {
    const start = this.capabilitiesWrites.get(machineId);
    // Single-writer lock: only one loop persists for this machine at a time.
    if (!start || start.writing) return;
    start.writing = true;

    while (true) {
      const state = this.capabilitiesWrites.get(machineId);
      if (!state) return;
      if (state.cancelled) {
        this.capabilitiesWrites.delete(machineId);
        return;
      }
      const writeGeneration = state.generation;
      const payload = state.latest;

      try {
        await this.runInTraceSpan(
          "server.machine.capabilities.persist",
          { attrs: { machine_id: machineId, attempt: state.attempt + 1 } },
          () => this.persistMachineCapabilities(machineId, payload.runtimes, payload.hostname, payload.os, payload.daemonVersion),
        );
      } catch (err) {
        const failed = this.capabilitiesWrites.get(machineId);
        if (!failed || failed.cancelled) {
          if (failed) this.capabilitiesWrites.delete(machineId);
          return;
        }
        failed.attempt += 1;
        // Release the writer lock; the backoff timer re-enters the loop, which
        // will pick up whatever the latest payload is by then.
        failed.writing = false;
        const delayMs = Math.min(
          AgentOrchestrator.CAPABILITIES_PERSIST_RETRY_BASE_MS * 2 ** (failed.attempt - 1),
          AgentOrchestrator.CAPABILITIES_PERSIST_RETRY_MAX_MS,
        );
        const alerting = failed.attempt >= AgentOrchestrator.CAPABILITIES_PERSIST_ALERT_AFTER_ATTEMPTS;
        this.recordEvent("server.machine.capabilities.persist_retry", {
          machine_id: machineId,
          attempt: failed.attempt,
          retry_delay_ms: delayMs,
          reason: "capabilities_persist_failed",
          error_class: errorClassOf(err),
          outcome: alerting ? "alerting" : "retrying",
        });
        if (alerting) {
          console.error(`[Machine ${machineId}] capabilities persist still failing after ${failed.attempt} attempts; retrying every ${delayMs}ms:`, err);
        }
        const timer = this.scheduleOnClock(() => {
          const scheduled = this.capabilitiesWrites.get(machineId);
          if (scheduled) scheduled.timer = null;
          void this.runCapabilitiesWriter(machineId);
        }, delayMs);
        // A best-effort background retry must never keep the process alive on
        // its own (a real server stays up via its listeners; tests must be able
        // to exit while a retry is pending). No-op on the fake test clock.
        (timer as { unref?: () => void })?.unref?.();
        failed.timer = timer;
        return;
      }

      const after = this.capabilitiesWrites.get(machineId);
      if (!after) return;
      if (after.cancelled) {
        this.capabilitiesWrites.delete(machineId);
        return;
      }
      if (after.generation !== writeGeneration) {
        // A newer payload arrived while we were writing. Keep the writer lock
        // and loop again to persist it — the older write we just did is
        // therefore never the last word, and the newer one lands strictly after.
        after.attempt = 0;
        continue;
      }

      // Converged on the latest generation: update conn + emit exactly once,
      // then clear the pending write.
      this.capabilitiesWrites.delete(machineId);
      const conn = this.machineConnections.get(machineId);
      if (conn) {
        conn.runtimes = payload.runtimes;
        conn.runtimeVersions = payload.runtimeVersions ?? {};
        this.io?.to(`server:${conn.serverId}`).emit("machine:capabilities", {
          machineId,
          runtimes: payload.runtimes,
          runtimeVersions: payload.runtimeVersions ?? {},
          hostname: payload.hostname,
          os: payload.os,
          daemonVersion: payload.daemonVersion,
          computerVersion: payload.computerVersion,
        });
      }
      return;
    }
  }

  protected cancelPendingCapabilities(machineId: string): void {
    const state = this.capabilitiesWrites.get(machineId);
    if (!state) return;
    if (state.timer != null) {
      this.clock.clearTimeout(state.timer);
      state.timer = null;
    }
    // If a persist is in flight, do NOT delete the entry (that would let a
    // reconnect start a second concurrent writer). Mark it so the running loop
    // exits without emitting once the in-flight write resolves.
    if (state.writing) {
      state.cancelled = true;
    } else {
      this.capabilitiesWrites.delete(machineId);
    }
  }

  protected async loadAgentsForReadyReconcile(machineId: string) {
    return agentService.getAgentsForMachine(machineId);
  }

  protected async loadRuntimeContextMachine(machineId: MachineId): Promise<RuntimeContextMachine> {
    const machine = await machineService.getMachine(machineId);
    return machine
      ? { name: machine.name, description: machine.description, hostname: machine.hostname, os: machine.os }
      : null;
  }

  protected async applyReadyReconcileAction(
    machineId: string,
    agent: ReadyReconcileAgent,
    action: ReadyReconcilePlanAction,
  ): Promise<void> {
    if (!this.agentStateCache.has(agent.id)) {
      this.agentStateCache.set(agent.id, this.cachedStateFromPersistedAgent(agent));
    }
    const connectionEpochId = this.getConnectionEpochId(machineId);
    const activityDedupeKey = this.makeReadyReconcileActivityDedupeKey({
      agentId: agent.id,
      machineId,
      connectionEpochId,
      agentStatus: agent.status,
      action,
    });
    // TODO(lifecycle-v2/server-producer): ready reconcile is server-owned.
    // Have the reconcile planner produce canonical runtime_ready,
    // runtime_interrupted, or ready_reconciled lifecycle events directly with
    // connectionEpochId/reason attrs, then delete this legacy adapter call.
    const { event } = adaptReadyReconcileLifecycleEvent({
      serverId: agent.serverId,
      agentId: agent.id,
      machineId,
      action,
      agentStatus: agent.status,
      connectionEpochId,
      now: () => new Date(this.clock.now()),
    });
    const state = buildAgentLifecycleStateSnapshot({
      dbStatus: agent.status,
      machineId,
      machineReachability: "reachable",
      runtimeState: action === "mark-active-online"
        ? "running_idle"
        : action === "mark-wakeable-not-running"
          ? "not_running"
        : action === "mark-inactive-offline"
          ? "interrupted"
          : "not_running",
    });
    await applyAgentLifecycleProjectionPlan(
      reduceReadyReconcileLifecycle({
        action,
        activityDedupeKey,
        event,
        state,
      }),
      this.lifecycleProjectionWriterDeps(),
      getCurrentTraceSpan(),
    );
  }

  private peekLocalInboxWakeMessage(agentId: string): AgentMessage | null {
    return this.agentInboxes.get(agentId)?.inbox[0] ?? null;
  }

  private removeLocalInboxWakeMessage(agentId: string, message: AgentMessage): boolean {
    const inbox = this.agentInboxes.get(agentId);
    if (!inbox || inbox.inbox.length === 0) return false;

    const index = inbox.inbox.findIndex((candidate) => {
      if (message.seq && candidate.seq === message.seq) return true;
      return Boolean(!message.seq && message.message_id && candidate.message_id === message.message_id);
    });
    if (index < 0) return false;

    inbox.inbox.splice(index, 1);
    return true;
  }

  private async maybeWakePendingInboxAfterReady(
    machineId: string,
    agent: ReadyReconcileAgent,
  ): Promise<boolean> {
    const wakeMessage = this.peekLocalInboxWakeMessage(agent.id);
    if (!wakeMessage) {
      return false;
    }

    const wakeInput = await this.loadWakePlanInput(agent.id, agent.status);
    const action = planWakeAction(wakeInput);
    this.recordEvent("machine.ready.pending_inbox_wake.planned", {
      agent_id: agent.id,
      machine_id: machineId,
      agent_id_present: Boolean(agent.id),
      machine_id_present: Boolean(machineId),
      message_id_present: Boolean(wakeMessage.message_id),
      seq: wakeMessage.seq ?? 0,
      db_status: wakeInput.state.dbStatus,
      runtime_state: wakeInput.state.runtimeState,
      reset_mode: wakeInput.state.resetMode ?? null,
      control_gate: wakeInput.state.controlGate,
      action,
    });

    if (action !== "attempt-wake") {
      return false;
    }

    await this.applyWakeAction({
      agentId: agent.id,
      machineId,
      previousStatus: agent.status,
      resetMode: wakeInput.state.resetMode,
    }, wakeMessage, action);

    const woke = this.agentStateCache.get(agent.id)?.runtimeState === "starting";
    if (!woke) {
      this.recordEvent("machine.ready.pending_inbox_wake.not_started", {
        agent_id: agent.id,
        machine_id: machineId,
        agent_id_present: Boolean(agent.id),
        machine_id_present: Boolean(machineId),
        seq: wakeMessage.seq ?? 0,
      });
      return false;
    }

    // The pending message is now embedded in agent:start as wakeMessage. Daemon
    // startup-wake messages are not sent as agent:deliver, so they do not emit
    // a delivery ack to drain this replay inbox entry.
    const removed = this.removeLocalInboxWakeMessage(agent.id, wakeMessage);
    this.recordEvent("machine.ready.pending_inbox_wake.started", {
      agent_id: agent.id,
      machine_id: machineId,
      agent_id_present: Boolean(agent.id),
      machine_id_present: Boolean(machineId),
      seq: wakeMessage.seq ?? 0,
      removed_from_inbox: removed,
    });
    return true;
  }

  private async bumpMachineStatusVersion(machineId: string): Promise<number> {
    if (this.replicaStateStore.isAvailable()) {
      return this.replicaStateStore.bumpMachineStatusVersion(machineId);
    }
    const next = (this.machineStatusVersions.get(machineId) ?? 0) + 1;
    this.machineStatusVersions.set(machineId, next);
    return next;
  }

  async getMachineStatusVersion(machineId: string): Promise<number> {
    if (this.replicaStateStore.isAvailable()) {
      return this.replicaStateStore.getMachineStatusVersion(machineId);
    }
    return this.machineStatusVersions.get(machineId) ?? 0;
  }

  private async clearMachineConnection(
    machineId: string,
    unregisterReplica: boolean,
    close?: { code: number; reason: string },
    expectedWs?: WebSocket,
  ): Promise<void> {
    let conn = this.machineConnections.get(machineId);
    if (!conn || (expectedWs && conn.ws !== expectedWs)) {
      try {
        if (expectedWs?.readyState === 1) expectedWs.close(close?.code, close?.reason);
      } catch { /* ignore */ }
      return;
    }
    if (conn.replicaGeneration) {
      const replacementGeneration = {
        connectionEpochId: conn.connectionEpochId,
        replicaGeneration: conn.replicaGeneration,
      };
      // Fence new catalog readers first, then wait for already-authorized
      // persist/dispatch work. Revalidate the socket after the await because a
      // concurrent clear may have completed while this caller was queued.
      try {
        await this.machineCatalogAuthority.beginReplacement(
          machineId,
          replacementGeneration,
        );
      } catch (error) {
        if (error instanceof MachineCatalogStaleError) return;
        throw error;
      }
      const current = this.machineConnections.get(machineId);
      if (!current || current.ws !== conn.ws) {
        this.machineCatalogAuthority.completeReplacement(
          machineId,
          replacementGeneration,
        );
        return;
      }
      conn = current;
    }

    const hadHeartbeatTimer = Boolean(conn.heartbeatTimer);
    if (conn.heartbeatTimer) this.clock.cancelRepeated(conn.heartbeatTimer);
    if (conn.runtimeAccountUsageTimer) this.clock.cancelRepeated(conn.runtimeAccountUsageTimer);
    // Cancel any in-flight capabilities-persist retry: once the daemon is gone
    // there is nothing to converge, and the next `ready` on reconnect re-enqueues.
    this.cancelPendingCapabilities(machineId);
    try {
      if (conn.ws.readyState === 1) conn.ws.close(close?.code, close?.reason);
    } catch { /* ignore */ }
    this.machineConnections.delete(machineId);
    // RFC 069 §8: this process can no longer send status; a reconnect starts a
    // fresh sequence check, so its versions only hold memory.
    if (conn.daemonInstanceId) {
      for (const [agentId, version] of this.sequencedStatusVersions) {
        if (version.daemonInstanceId === conn.daemonInstanceId) this.sequencedStatusVersions.delete(agentId);
      }
    }
    if (conn.replicaGeneration) {
      this.machineCatalogAuthority.completeReplacement(machineId, {
        connectionEpochId: conn.connectionEpochId,
        replicaGeneration: conn.replicaGeneration,
      });
    }
    this.lastIngressReplicaRefreshAt.delete(machineId);
    this.recordEvent("server.machine.websocket.heartbeat_timer", {
      machine_id: machineId,
      server_id: conn.serverId,
      machine_id_present: Boolean(machineId),
      server_id_present: Boolean(conn.serverId),
      timer_present: hadHeartbeatTimer,
      outcome: "cleared",
    });

    if (unregisterReplica) {
      // Drop the meta mirror too so non-owner replicas don't keep returning
      // stale state after the daemon hangs up. The TTL would evict orphans
      // eventually, but clean unregister is cheaper and keeps REST reads
      // consistent with the offline status event.
      await this.commitMachineReplicaDisconnectState(
        machineId,
        conn.replicaGeneration ?? undefined,
      );
    }
  }

  private cancelPendingMachineDisconnect(machineId: string): boolean {
    const pending = this.pendingMachineDisconnects.get(machineId);
    if (!pending) return false;
    this.clock.clearTimeout(pending.timer);
    this.pendingMachineDisconnects.delete(machineId);
    return true;
  }

  private async commitMachineReplicaDisconnectState(
    machineId: string,
    expectedGeneration?: string,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const operations = Promise.allSettled([
      this.replicaStateStore.unregisterMachineReplica(machineId, expectedGeneration),
      this.replicaStateStore.clearMachineMeta(machineId),
    ]);
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), MACHINE_REPLICA_UNREGISTER_TIMEOUT_MS);
    });

    const result = await Promise.race([operations, timeoutPromise]);
    if (timeout) clearTimeout(timeout);
    if (result === "timeout") {
      console.warn(`[Machine ${machineId}] Timed out unregistering replica state before offline emit`);
      return;
    }

    const rejected = result.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    if (rejected.length > 0) {
      const noun = rejected.length === 1 ? "entry" : "entries";
      console.warn(`[Machine ${machineId}] Failed to unregister ${rejected.length} replica state ${noun} before offline emit`);
    }
  }

  /**
   * A stale registration can finish after its successor and overwrite that
   * successor's owner generation. Reassert the exact generation already
   * committed for the currently active socket, then revalidate the socket and
   * generation after every async write. A replacement that lands while the
   * repair is in flight is repaired in turn; sustained churn fails closed
   * instead of leaving a request-ready local socket without a Redis owner.
   */
  private async convergeMachineReplicaAfterStaleCommit(
    machineId: string,
    staleGeneration: string,
  ): Promise<void> {
    let observedStoreGeneration = staleGeneration;

    for (let attempt = 0; attempt < MACHINE_REPLICA_REPAIR_MAX_REPLACEMENTS; attempt += 1) {
      const active = this.machineConnections.get(machineId);
      if (!active) {
        await this.replicaStateStore.unregisterMachineReplica(machineId, observedStoreGeneration);
        return;
      }

      const activeGeneration = active.replicaGeneration;
      if (!activeGeneration) {
        // A replacement still awaiting its own owner commit is not locally
        // request-ready. Remove only the stale write and let that pending
        // registration establish its own generation.
        await this.replicaStateStore.unregisterMachineReplica(machineId, observedStoreGeneration);
        return;
      }

      try {
        await this.replicaStateStore.restoreMachineReplicaGeneration(
          machineId,
          activeGeneration,
          active.traceContext ?? buildRuntimeTraceContext(),
        );
      } catch (err) {
        await Promise.allSettled([
          this.replicaStateStore.unregisterMachineReplica(machineId, observedStoreGeneration),
          this.replicaStateStore.unregisterMachineReplica(machineId, activeGeneration),
        ]);
        if (
          this.machineConnections.get(machineId)?.ws === active.ws
          && active.replicaGeneration === activeGeneration
        ) {
          await this.clearMachineConnection(machineId, false, {
            code: 1011,
            reason: "replica_registration_failed",
          }, active.ws);
        }
        throw err;
      }

      observedStoreGeneration = activeGeneration;
      const current = this.machineConnections.get(machineId);
      if (current?.ws === active.ws && current.replicaGeneration === activeGeneration) return;
    }

    await this.replicaStateStore.unregisterMachineReplica(machineId, observedStoreGeneration)
      .catch(() => undefined);
    const current = this.machineConnections.get(machineId);
    if (current) {
      await this.clearMachineConnection(machineId, true, {
        code: 1011,
        reason: "replica_registration_failed",
      }, current.ws);
    }
    throw new Error("Machine replica registration repair did not converge");
  }

  protected async isLegacyMachinePrincipalMigrated(machineId: string): Promise<boolean> {
    const machine = await machineService.getMachine(asMachineId(machineId));
    return Boolean(machine?.legacyKeyMigratedAt);
  }

  private async isLegacyPrincipalFenced(machineId: string): Promise<boolean> {
    if (this.legacyPrincipalFences.has(machineId)) return true;
    const migrated = await this.isLegacyMachinePrincipalMigrated(machineId);
    // Re-check the process-local fence after the DB await. The adoption CAS
    // broadcast can land while this read is in flight.
    return migrated || this.legacyPrincipalFences.has(machineId);
  }

  /** Going-away for a connection that arrived after the drain started: closed
   * with 1001 `server_draining` and never registered, so it is neither owned
   * by this replica nor left for the ALB to cut. Counted and logged per
   * refusal; prod acceptance for task #268 reads how often this fires. */
  private refuseMachineConnectionWhileDraining(
    machineId: string,
    ws: WebSocket,
    traceContext: MachineConnectTraceContext,
  ): void {
    this.drainRefusedMachineConnections += 1;
    machineConnectionsRefusedTotal.inc({ reason: "draining" });
    try {
      if (ws.readyState === 1) ws.close(MACHINE_DRAIN_CLOSE_CODE, MACHINE_DRAIN_CLOSE_REASON);
    } catch {
      // The socket is already torn down; nothing was registered either way.
    }
    console.log(
      `[Slock] Drain going-away: refused new machine connection while draining (machine=${machineId}, refused_total=${this.drainRefusedMachineConnections})`,
    );
    this.tracer.emitEvent("server.machine.connection.refused_while_draining", {
      surface: "server",
      attrs: {
        machine_id: machineId,
        drain_refused_total: this.drainRefusedMachineConnections,
        ...projectMachineConnectTraceAttrs(traceContext),
      },
    });
  }

  private closeUnregisteredLegacySocket(ws: WebSocket): void {
    try {
      if (ws.readyState === 1) {
        ws.close(LEGACY_PRINCIPAL_FENCED_CLOSE_CODE, LEGACY_PRINCIPAL_FENCED_CLOSE_REASON);
      }
    } catch {
      // The caller still returns without registering ownership.
    }
  }

  async fenceMachinePrincipalConnections(
    machineId: string,
    principalKind: "legacy_machine",
  ): Promise<boolean> {
    this.legacyPrincipalFences.add(machineId);
    const conn = this.machineConnections.get(machineId);
    if (!conn || conn.principalKind !== principalKind) return false;

    try {
      conn.ws.close(LEGACY_PRINCIPAL_FENCED_CLOSE_CODE, LEGACY_PRINCIPAL_FENCED_CLOSE_REASON);
    } catch {
      // Disconnect handling below removes server-side ownership even when the
      // transport has already torn down.
    }
    await this.handleMachineDisconnect(machineId, conn.ws, {
      cause: LEGACY_PRINCIPAL_FENCED_CLOSE_REASON,
      closeCode: LEGACY_PRINCIPAL_FENCED_CLOSE_CODE,
      closeReason: LEGACY_PRINCIPAL_FENCED_CLOSE_REASON,
    });
    return true;
  }

  async registerMachine(
    machineId: string,
    serverId: string,
    ws: WebSocket,
    traceContext: MachineConnectTraceContext = buildRuntimeTraceContext(),
    principalKind: MachineConnectionPrincipalKind = "unknown",
  ) {
    if (this.drainingMachineConnections) {
      this.refuseMachineConnectionWhileDraining(machineId, ws, traceContext);
      return;
    }
    const replacedExistingConnection = this.machineConnections.has(machineId);
    const canceledPendingDisconnect = this.cancelPendingMachineDisconnect(machineId);
    const connectionTraceAttrs = projectMachineConnectTraceAttrs(traceContext);
    const span = this.tracer.startSpan("server.machine.connection.register", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "internal",
      attrs: {
        machine_id: machineId,
        server_id: serverId,
        machine_id_present: Boolean(machineId),
        server_id_present: Boolean(serverId),
        replaced_existing_connection: replacedExistingConnection,
        canceled_pending_disconnect: canceledPendingDisconnect,
        principal_kind: principalKind,
        ...connectionTraceAttrs,
      },
    });
    await this.runInActiveSpan(span, async () => {
      // A same-replica reconnect is a connection handoff, not a true ownership drop.
      // If we unregister the replica mapping here, the stale async delete can land after
      // the fresh register and briefly strand the machine as "offline" to other replicas.
      try {
        const current = this.machineConnections.get(machineId);
        if (
          principalKind === "legacy_machine"
          && (current?.principalKind === "computer" || await this.isLegacyPrincipalFenced(machineId))
        ) {
          this.closeUnregisteredLegacySocket(ws);
          span.end("ok", { attrs: { outcome: "legacy_principal_fenced" } });
          return;
        }

        await this.clearMachineConnection(machineId, false);

        const conn: MachineConnection = {
          ws,
          machineId,
          serverId,
          principalKind,
          connectionEpochId: `machine:${machineId}:connection:${crypto.randomUUID()}`,
          replicaGeneration: null,
          heartbeatTimer: null,
          runtimeAccountUsageTimer: null,
          lastPong: this.clock.now(),
          lastIngressAt: this.clock.now(),
          daemonVersion: null,
          capabilities: new Set(),
          runtimes: null,
          runtimeVersions: {},
          migrationTransport: null,
          shutdownIntent: null,
          computerVersion: null,
          daemonInstanceId: null,
          traceContext,
        };

        this.startMachineHeartbeat(machineId, conn);

        this.machineConnections.set(machineId, conn);

        // A legacy handshake can authenticate immediately before the adoption
        // CAS and finish registering immediately after it. Revalidate after the
        // connection becomes locally visible: a fence that lands before this
        // point is observed by the set/DB check; one that lands after this point
        // sees the registered principal and closes it.
        if (principalKind === "legacy_machine" && await this.isLegacyPrincipalFenced(machineId)) {
          if (this.machineConnections.get(machineId)?.ws === ws) {
            await this.fenceMachinePrincipalConnections(machineId, principalKind);
          } else {
            this.closeUnregisteredLegacySocket(ws);
          }
          span.end("ok", { attrs: { outcome: "legacy_principal_fenced" } });
          return;
        }

        // Commit the machine→replica owner mapping in Redis BEFORE emitting the
        // online status event. The web client treats receipt of this event as the
        // trigger for an authoritative reloadMachines REST; that REST can land on a
        // different replica and resolve cross-replica reachability from the owner
        // mapping. If we emit online before the mapping is committed, the soonest
        // cross-replica read returns offline and the client (which has no repair /
        // re-poll loop) latches offline until a manual refresh — the multi-replica
        // "restart -> offline -> never auto online" symptom (#wg-raft-computer #89).
        // Registration is the readiness commit for this connection. Surfacing
        // online or accepting queued work without it strands cross-replica
        // requests behind an owner key that was never established.
        try {
          const replicaGeneration = requireReplicaGeneration(
            await this.replicaStateStore.registerMachineReplica(machineId, traceContext),
          );
          const activeConnection = this.machineConnections.get(machineId);
          if (activeConnection?.ws !== ws) {
            if (activeConnection) {
              let activeGeneration: string;
              try {
                activeGeneration = requireReplicaGeneration(
                  await this.replicaStateStore.registerMachineReplica(
                    machineId,
                    activeConnection.traceContext ?? buildRuntimeTraceContext(),
                  ),
                );
              } catch (err) {
                // The stale commit replaced the successor's earlier lease, so a
                // failed recommit cannot leave that successor request-ready.
                await this.replicaStateStore.unregisterMachineReplica(machineId, replicaGeneration)
                  .catch(() => undefined);
                if (this.machineConnections.get(machineId)?.ws === activeConnection.ws) {
                  await this.clearMachineConnection(machineId, false, {
                    code: 1011,
                    reason: "replica_registration_failed",
                  }, activeConnection.ws);
                }
                throw err;
              }
              if (this.machineConnections.get(machineId)?.ws === activeConnection.ws) {
                activeConnection.replicaGeneration = activeGeneration;
              } else {
                // The successor disconnected or was replaced while its repair
                // commit was in flight. Exact cleanup is sufficient for a
                // disconnect; a replacement must also have its already-committed
                // generation reasserted because the stale repair overwrote it.
                await this.convergeMachineReplicaAfterStaleCommit(machineId, activeGeneration);
              }
            } else {
              // The stale registration completed after every local connection
              // disappeared. Do not leave its lease routable for the full TTL.
              await this.replicaStateStore.unregisterMachineReplica(machineId, replicaGeneration);
            }
            try {
              if (ws.readyState === 1) ws.close(1000, "superseded_connection");
            } catch { /* ignore */ }
            span.end("ok", { attrs: { outcome: "superseded_connection" } });
            return;
          }
          conn.replicaGeneration = replicaGeneration;
          this.recordEvent("machine.replica.register_committed", {
            outcome: "committed",
            ...connectionTraceAttrs,
          });
        } catch (err) {
          console.error(
            `[Machine ${machineId}] Failed to register replica mapping:`,
            err instanceof Error ? err.message : err,
          );
          this.recordEvent("machine.replica.register_failed", {
            outcome: "failed",
            reason: "replica_register_failed",
            error_class: errorClassOf(err),
          });
          await this.clearMachineConnection(machineId, false, {
            code: 1011,
            reason: "replica_registration_failed",
          }, ws);
          span.end("error", {
            attrs: {
              outcome: "replica_register_failed",
              reason: "replica_register_failed",
              error_class: errorClassOf(err),
            },
          });
          return;
        }

        const statusVersion = await this.bumpMachineStatusVersion(machineId);

        this.io?.to(`server:${serverId}`).emit("machine:status", {
          machineId,
          status: "online",
          statusVersion,
        });
        this.emit("machine:online", { machineId, serverId });
        this.recordEvent("machine.status.emitted", {
          outcome: "emitted",
          status: "online",
          status_version: statusVersion,
        });
        try {
          const recovery = await recordComputerOnlineTransition({
            serverId,
            machineId,
            now: new Date(this.clock.now()),
          });
          this.recordEvent("machine.outage_recovery.recorded", {
            outcome: "recorded",
            recovered_count: recovery.recovered,
            suppressed_flaps_count: recovery.suppressedFlaps,
            offline_emitted_count: recovery.offlineEmitted,
            online_emitted_count: recovery.onlineEmitted,
          });
        } catch (err) {
          console.warn(
            `[Machine ${machineId}] Failed to record Computer outage recovery:`,
            err instanceof Error ? err.message : err,
          );
          this.recordEvent("machine.outage_recovery.failed", {
            outcome: "failed",
            error_class: errorClassOf(err),
          });
        }
        this.retryPendingAgentDeliveriesForMachine(machineId, "register");
        this.retryPendingAgentStartsForMachine(machineId, "register");

        // Auto-assign this machine to any BYOC agents in the server that have no machine
        try {
          await this.autoAssignConnectedMachine(serverId, machineId);
          this.recordEvent("machine.auto_assign.completed", {
            outcome: "completed",
          });
        } catch (err) {
          console.error(`[Machine ${machineId}] Failed to auto-assign agents:`, err);
          this.recordEvent("machine.auto_assign.failed", {
            outcome: "failed",
            reason: "auto_assign_failed",
            error_class: errorClassOf(err),
          });
        }

        console.log(`[Machine ${machineId}] Connected (server: ${serverId})`);
        span.end("ok", { attrs: { outcome: "registered", status_version: statusVersion } });
      } catch (err) {
        span.end("error", {
          attrs: {
            outcome: "error",
            reason: "direct_delivery_exception",
            error_class: errorClassOf(err),
          },
        });
        throw err;
      }
    });
  }

  async unregisterMachine(machineId: string): Promise<void> {
    this.cancelPendingMachineDisconnect(machineId);
    await this.clearMachineConnection(machineId, true);
  }

  async disconnectMachineForUnlink(machineId: string): Promise<boolean> {
    const conn = this.machineConnections.get(machineId);
    if (!conn) return false;

    try {
      conn.ws.close(MACHINE_UNLINKED_CLOSE_CODE, MACHINE_UNLINKED_CLOSE_REASON);
    } catch {
      // `handleMachineDisconnect` below still removes server-side ownership.
    }

    await this.handleMachineDisconnect(machineId, conn.ws, {
      cause: MACHINE_UNLINKED_CLOSE_REASON,
      closeCode: MACHINE_UNLINKED_CLOSE_CODE,
      closeReason: MACHINE_UNLINKED_CLOSE_REASON,
    });
    const pending = this.pendingMachineDisconnects.get(machineId);
    if (pending) {
      await this.applyMachineDisconnectProjection(machineId, pending);
    }
    return true;
  }

  /**
   * Going-away for every live machine connection, paced per connection
   * across the caller's budget (task #261).
   *
   * Called when this task starts draining (or as a SIGTERM fallback). The
   * sockets are closed with 1001 `server_draining`; each close still runs
   * the normal ws `close` handler, so connection bookkeeping stays on the
   * existing path. See machineDrain.ts for the pacing semantics and the
   * measured-span result.
   */
  async closeMachineConnectionsForDrain(options?: {
    spreadMs?: number;
  }): Promise<{ closed: number; spanMs: number }> {
    // Refuse new connections from this point on (see drainingMachineConnections);
    // set before the snapshot so no connection can slip between the two.
    this.drainingMachineConnections = true;
    return closeConnectionsForDrain(this.machineConnections.values(), options);
  }

  /** True once the drain going-away has started on this task (task #268). */
  get isDrainingMachineConnections(): boolean {
    return this.drainingMachineConnections;
  }

  /** Machine connections refused with 1001 since the drain started. */
  get drainRefusedMachineConnectionCount(): number {
    return this.drainRefusedMachineConnections;
  }

  /** Get the daemon version for a connected machine (null if offline or unknown). */
  getMachineDaemonVersion(machineId: string): string | null {
    return this.machineConnections.get(machineId)?.daemonVersion ?? null;
  }

  /** True iff the connected daemon explicitly advertised this capability in `ready`. */
  hasMachineCapability(machineId: string | null | undefined, capability: string): boolean {
    if (!machineId) return false;
    return this.machineConnections.get(machineId)?.capabilities.has(capability) === true;
  }

  async getMachineMigrationTransport(machineId: string): Promise<MachineMigrationTransportState | null> {
    const local = this.machineConnections.get(machineId)?.migrationTransport;
    if (local) return local;
    if (!this.replicaStateStore.isAvailable()) return local ?? null;
    try {
      return migrationTransportFromMachineMeta(await this.replicaStateStore.getMachineMeta(machineId));
    } catch {
      return local ?? null;
    }
  }

  /**
   * Managed-Computer bundle version reported in `ready`, or null.
   *
   * Owner-replica fast path: read the in-memory `machineConnections`. If
   * this replica owns the machine connection, the value is already in
   * RAM and no Redis round-trip happens.
   *
   * Non-owner replica fallback: REST handlers land on whichever replica
   * the load balancer picked, not necessarily the owner; in that case the
   * in-memory map is empty and we fall back to the cross-replica meta
   * mirror in Redis (#wg-raft-computer task #95). Returns null when
   * neither has a value (Redis unavailable or never written).
   */
  async getMachineComputerVersion(machineId: string): Promise<string | null> {
    return (await this.getMachineComputerVersionFact(machineId))?.version ?? null;
  }

  /**
   * Live Computer-version fact used by source-aware broadcast policy.
   *
   * Value, freshness, and provenance travel together so no caller can admit
   * an upgrade from a value-only read. The owner uses current connection
   * ingress; non-owner replicas use the heartbeat-refreshed meta mirror.
   */
  async getMachineComputerVersionFact(machineId: string): Promise<ComputerSourceFact | null> {
    const local = this.machineConnections.get(machineId);
    if (local) {
      return {
        version: local.computerVersion ?? null,
        observedAt: new Date(local.lastIngressAt).toISOString(),
        provenance: "owner_connection",
      };
    }
    if (!this.replicaStateStore.isAvailable()) return null;
    try {
      const meta = await this.replicaStateStore.getMachineMeta(machineId);
      if (meta?.computerVersion === undefined && meta?.computerVersionObservedAt === undefined) {
        return null;
      }
      return {
        version: meta.computerVersion ?? null,
        observedAt: meta.computerVersionObservedAt ?? null,
        provenance: "replica_meta",
      };
    } catch {
      return null;
    }
  }

  /** Runtime binary/package versions reported by the current daemon ready frame. */
  /** Latest disk report of a connected machine (owner memory, else the Redis mirror). */
  async getMachineDiskStatus(machineId: string): Promise<MachineDiskStatus | null> {
    const local = this.machineConnections.get(machineId);
    if (local) return local.diskStatus ?? null;
    if (!this.replicaStateStore.isAvailable()) return null;
    try {
      const meta = await this.replicaStateStore.getMachineMeta(machineId);
      const disk = { availableBytes: Number(meta?.diskAvailableBytes), totalBytes: Number(meta?.diskTotalBytes) };
      return isValidMachineDiskStatus(disk) ? disk : null;
    } catch {
      return null;
    }
  }

  async getMachineRuntimeVersions(machineId: string): Promise<Record<string, string>> {
    const local = this.machineConnections.get(machineId);
    if (local) return { ...(local.runtimeVersions ?? {}) };
    if (!this.replicaStateStore.isAvailable()) return {};
    try {
      return runtimeVersionsFromMachineMeta(await this.replicaStateStore.getMachineMeta(machineId));
    } catch {
      return {};
    }
  }

  getMachineConnectionEpoch(machineId: string): string | null {
    return this.machineConnections.get(machineId)?.connectionEpochId ?? null;
  }

  /**
   * Relay a managed-Computer control command (restart / upgrade) over the
   * machine's live WS connection to its Computer service. Returns false if
   * the machine has no live connection (offline). Public wrapper over the
   * protected `sendToMachine` for the `/computer/:action` route.
   */
  async sendComputerControl(
    machineId: string,
    action: "restart" | "upgrade",
    operationId: string = crypto.randomUUID(),
  ): Promise<{ sent: boolean; requestId: string }> {
    // requestId-for-everything: the managed Computer threads this id through
    // the whole upgrade (progress frames + the post-restart `done` report).
    // It is REQUIRED for the SEA in-process upgrade path to trigger — without
    // it the runner falls back to the legacy detached `raft-computer upgrade`.
    const requestId = operationId;
    const sent = await this.sendToMachine(machineId, {
      type: action === "restart" ? "computer:restart" : "computer:upgrade",
      operationId,
      requestId,
    });
    return { sent, requestId };
  }

  /**
   * Remote upgrade v2 (task #873): send the exact target; the machine's next
   * reconnect is the only readback.
   */
  async sendComputerUpgrade(
    machineId: string,
    targetVersion: string,
    requestId: string,
  ): Promise<{ sent: boolean }> {
    const sent = await this.sendToMachine(machineId, {
      type: "computer:upgrade",
      operationId: requestId,
      requestId,
      targetVersion,
    });
    return { sent };
  }
  protected claimPendingComputerLifecycleDispatches(machineIds: string[]) {
    return computerLifecycleOperationService.claimPendingComputerLifecycleDispatches(machineIds);
  }

  protected releaseComputerLifecycleDispatchLease(operationId: string) {
    return computerLifecycleOperationService.releaseComputerLifecycleDispatchLease(operationId);
  }

  protected markComputerLifecycleCommandSent(operationId: string) {
    return computerLifecycleOperationService.markComputerLifecycleCommandSent(operationId);
  }

  protected async loadComputerBroadcastMachine(machineId: string): Promise<{ os: string | null } | null> {
    const machine = await machineService.getMachine(asMachineId(machineId));
    return machine ? { os: machine.os } : null;
  }

  protected evaluateComputerBroadcastPolicy(
    input: EvaluateComputerBroadcastPolicyInput,
  ): ComputerBroadcastPolicyDecision | Promise<ComputerBroadcastPolicyDecision> {
    return evaluateBroadcastPolicy(input);
  }

  protected async dispatchPendingComputerLifecycleOperations(): Promise<void> {
    const claimed = await this.claimPendingComputerLifecycleDispatches([
      ...this.machineConnections.keys(),
    ]);
    for (const operation of claimed) {
      await this.runInTraceSpan(
        "server.computer.operation.command",
        {
          attrs: {
            operation_id: operation.operationId,
            machine_id: operation.machineId,
            action: operation.action,
          },
        },
        async (): Promise<string> => {
          if (operation.action === "upgrade") {
            const machine = await this.loadComputerBroadcastMachine(operation.machineId);
            const decision = await this.evaluateComputerBroadcastPolicy({
              source: await this.getMachineComputerVersionFact(operation.machineId),
              platform: normalizeComputerPlatform(machine?.os),
              requestedTargetVersion: operation.targetVersion,
              now: new Date(this.clock.now()),
              serverId: operation.serverId,
            });
            if (decision.reasonCode === "hands_unavailable") {
              // A temporary release-authority outage is not a withdrawn target.
              // Release the dispatch lease; the existing operation deadline still bounds retries.
              await this.releaseComputerLifecycleDispatchLease(operation.operationId);
              return "hands_unavailable";
            }
            if (!isQueuedComputerUpgradePolicyCompatible(
              operation.broadcastPolicyDecision,
              decision,
            )) {
              const reason = decision.eligibility === "no_broadcast"
                ? `computer_broadcast_revalidation_${decision.reasonCode}`
                : "computer_broadcast_revalidation_incompatible";
              await this.terminalizeComputerLifecycleOperation({
                operationId: operation.operationId,
                serverId: operation.serverId,
                machineId: operation.machineId,
                terminal: "failed",
                reason,
              });
              this.recordEvent("server.computer.operation.command.refused", {
                operation_id: operation.operationId,
                machine_id: operation.machineId,
                action: operation.action,
                policy_revision: decision.policyRevision ?? "unknown",
                policy_reason: decision.reasonCode,
                outcome: "refused",
              });
              return "refused";
            }
          }
          const { sent } = await this.sendComputerControl(
            operation.machineId,
            operation.action,
            operation.operationId,
          );
          if (!sent) {
            await this.releaseComputerLifecycleDispatchLease(operation.operationId);
            return "send_failed";
          }
          await this.markComputerLifecycleCommandSent(operation.operationId);
          this.recordEvent("server.computer.operation.command.sent", {
            operation_id: operation.operationId,
            machine_id: operation.machineId,
            action: operation.action,
            outcome: "sent",
          });
          return "sent";
        },
        (outcome) => ({ status: outcome === "refused" ? "error" : "ok", attrs: { outcome } }),
      );
    }
  }

  private async sweepComputerLifecycleOperations(): Promise<void> {
    try {
      const expired = await computerUpgradeRequestService.expireComputerUpgradeRequests(new Date(this.clock.now()));
      for (const row of expired) {
        this.io?.to(`server:${row.serverId}`).emit("machine:upgrade-request", { machineId: row.machineId, upgradeRequest: computerUpgradeRequestService.projectComputerUpgradeRequest(row) });
      }
    } catch (error) {
      console.warn(`[Orchestrator] upgrade request expiry sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.runInTraceSpan(
      "server.computer.operation.sweep",
      {},
      async () => {
        const results = await computerLifecycleOperationService.expirePendingComputerLifecycleOperations();
        let terminalCount = 0;
        for (const result of results) {
          if (result.status !== "terminal") continue;
          terminalCount += 1;
          this.recordEvent("operation.terminal", {
            operation_id: result.fact.operationId,
            server_id: result.fact.serverId,
            machine_id: result.fact.machineId,
            action: result.fact.action,
            terminal: result.fact.terminal,
            outcome: result.fact.terminal,
          });
          this.recordEvent("activity.projected", {
            operation_id: result.fact.operationId,
            projection_count: result.projections.length,
            outcome: "history_only",
          });
        }
        return terminalCount;
      },
      (terminalCount) => ({ status: terminalCount > 0 ? "error" : "ok", attrs: { terminal_count: terminalCount } }),
    );
  }

  /**
   * A daemon that restarted before the flip lost its in-memory transfer run.
   * Only daemons that report every live run (AGENT_MIGRATION_CAPABILITY) are
   * trusted here. For each pre-flip migration involving this machine whose run
   * is missing from the report: a lost target run gets its lease re-issued
   * under the same generation (resumable download, no re-upload); a lost source
   * run before upload completion rotates to a new transport generation and
   * both daemons get fresh leases. The peer's old run is then rejected as stale
   * and its transport-lost report (tagged with the old generation) is ignored.
   * Mixed versions: an old peer daemon tags no generation, so its stale report
   * can still fail the new generation, no worse than before this recovery.
   */
  private async reprovisionLostMigrationTransfers(
    machineId: string,
    ready: { capabilities?: string[]; migrationTransport?: AgentMigrationTransportReady },
  ): Promise<void> {
    if (!ready.migrationTransport?.capabilities?.includes(AGENT_MIGRATION_CAPABILITY)) return;
    const reported = new Set((ready.migrationTransport?.activeLeases ?? [])
      .map((lease) => `${lease.migrationId}:${lease.transportGeneration}`));
    const migrations = await agentMigrationService.listAgentMigrationsAwaitingTransportOnMachine(machineId);
    for (const migration of migrations) {
      if (!migration.transportGeneration) continue;
      if (reported.has(`${migration.id}:${migration.transportGeneration}`)) continue;
      const role = migration.sourceMachineId === machineId ? "source" : "target";
      const recovery = agentMigrationService.agentMigrationLostRunRecovery(migration, role);
      if (recovery === "reissue_target_lease") {
        // Target lost its run: resume its download under the same generation.
        const delivery = await agentMigrationService.reissueAgentMigrationTargetLease({
          migrationId: migration.id,
          expectedTransportGeneration: migration.transportGeneration,
        });
        if (!delivery) continue;
        this.recordEvent("machine.ready.migration_target_lease_reissued", { outcome: "reissued" });
        await this.sendAgentMigrationTransportLease(delivery.machineId, delivery.message);
        continue;
      }
      if (recovery !== "rotate_generation") continue;
      // Source lost its run before the upload completed: start a new generation.
      const provision = await agentMigrationService.provisionAgentMigrationObjectStoreTransfer();
      const result = await agentMigrationService.reprovisionAgentMigrationTransport({
        migrationId: migration.id,
        expectedTransportGeneration: migration.transportGeneration,
        provision,
      });
      if (!result) continue;
      this.recordEvent("machine.ready.migration_transport_reprovisioned", {
        outcome: "reprovisioned",
        machine_role: role,
      });
      const sends = await Promise.allSettled([
        this.sendAgentMigrationTransportLease(result.source.machineId, result.source.message),
        this.sendAgentMigrationTransportLease(result.target.machineId, result.target.message),
      ]);
      for (const send of sends) {
        if (send.status === "rejected") {
          // An offline target later gets its lease re-issued (same generation) when it reconnects.
          console.warn(`[Machine ${machineId}] Re-provisioned migration lease not delivered:`, send.reason);
        }
      }
    }
  }

  async sendAgentMigrationTransportLease(
    machineId: string,
    msg: Extract<ServerToMachineMessage, { type: "machine:migration_transport:lease" }>,
  ): Promise<void> {
    await this.sendRequiredToMachine(machineId, msg, "Machine WebSocket not ready for migration transfer lease");
  }

  protected getMachineResponseRelay() { return machineResponseRelay; }

  private recordMachineResponseRelay(event: string, attrs: Record<string, string | boolean>): void {
    this.recordEvent(`server.machine.response.${event}`, attrs);
  }

  async archiveAgentMigrationSourceWorkspace(
    machineId: string,
    input: { migrationId: string; agentId: string; migrationCreatedAt?: string },
  ): Promise<"archived" | "already_archived" | "source_absent"> {
    const requestId = crypto.randomUUID();
    if (!this.machineConnections.has(machineId)) {
      const response = await this.getMachineResponseRelay().request({
        requestId, machineId, type: "machine:migration:source_workspace_archive_result", ...input,
      }, 15_000, () => this.sendRequiredToMachine(machineId, {
        type: "machine:migration:source_workspace_archive", requestId, ...input,
      }), (event, attrs) => this.recordMachineResponseRelay(event, attrs));
      if (response.type !== "machine:migration:source_workspace_archive_result" || response.outcome === "error") {
        throw new AgentMigrationSourceArchiveError(
          response.type === "machine:migration:source_workspace_archive_result" ? response.errorCode : undefined,
        );
      }
      return response.outcome;
    }
    const eventName = `machine:response:${machineId}`;

    return new Promise((resolve, reject) => {
      const timeout = this.scheduleOnClock(() => {
        this.removeListener(eventName, handler);
        reject(new RouteFailureError(
          "daemon_timeout",
          "Migration source workspace archive timed out",
        ));
      }, 15_000);

      const handler = (message: MachineToServerMessage) => {
        if (
          message.type !== "machine:migration:source_workspace_archive_result"
          || message.requestId !== requestId
          || message.migrationId !== input.migrationId
          || message.agentId !== input.agentId
        ) {
          return;
        }

        this.clock.clearTimeout(timeout);
        this.removeListener(eventName, handler);
        if (message.outcome === "error") {
          reject(new AgentMigrationSourceArchiveError(message.errorCode));
          return;
        }
        resolve(message.outcome);
      };

      this.on(eventName, handler);
      void this.sendRequiredToMachine(
        machineId,
        {
          type: "machine:migration:source_workspace_archive",
          requestId,
          migrationId: input.migrationId,
          agentId: input.agentId,
          ...(input.migrationCreatedAt ? { migrationCreatedAt: input.migrationCreatedAt } : {}),
        },
        "Machine WebSocket not ready for migration source workspace archive",
      ).catch((error) => {
        this.clock.clearTimeout(timeout);
        this.removeListener(eventName, handler);
        reject(error);
      });
    });
  }

  async sendAgentMigrationCancel(
    machineId: string,
    msg: Extract<ServerToMachineMessage, { type: "machine:migration:cancel" }>,
  ): Promise<void> {
    await this.sendRequiredToMachine(machineId, msg, "Machine WebSocket not ready for migration cancellation");
  }

  protected observeComputerLifecycleAck(
    input: Parameters<typeof computerLifecycleOperationService.observeComputerLifecycleAck>[0],
  ) {
    return computerLifecycleOperationService.observeComputerLifecycleAck(input);
  }

  private async handleComputerLifecycleAcknowledgement(
    machineId: string,
    serverId: string,
    connectionEpoch: string,
    acknowledgement: ComputerLifecycleExecutionAck,
  ): Promise<void> {
    await this.runInTraceSpan(
      "server.computer.operation.ack.received",
      {
        attrs: {
          server_id: serverId,
          machine_id: machineId,
          action: acknowledgement.action,
          phase: acknowledgement.phase,
        },
      },
      async (): Promise<{ status: TraceStatus; attrs: TraceAttributes }> => {
        const result = await this.observeComputerLifecycleAck({
          machineId,
          serverId,
          connectionEpoch,
          acknowledgement,
        });
        if (result.status === "rejected") {
          return { status: "ok", attrs: { outcome: result.status } };
        }
        if (acknowledgement.phase === "ready" && acknowledgement.loadedComputerVersion) {
          await this.recordReportedMachineComputerVersion(
            machineId,
            acknowledgement.loadedComputerVersion,
            "lifecycle_ack",
          );
        }
        const operationId = result.status === "terminal" ? result.fact.operationId : result.operationId;
        this.recordEvent("operation.ack.received", {
          operation_id: operationId,
          action: acknowledgement.action,
          phase: acknowledgement.phase,
          outcome: result.status,
        });
        if (result.status === "terminal") {
          this.recordEvent("operation.terminal", {
            operation_id: operationId,
            server_id: serverId,
            machine_id: machineId,
            action: result.fact.action,
            terminal: result.fact.terminal,
            outcome: result.fact.terminal,
          });
          this.recordEvent("activity.projected", {
            operation_id: operationId,
            projection_count: result.projections.length,
            outcome: "history_only",
          });
        }
        await this.sendToMachine(machineId, {
          type: "computer:lifecycle:receipt",
          operationId: computerLifecycleOperationService.resolveComputerLifecycleOperationId(acknowledgement)
            ?? operationId,
          phase: acknowledgement.phase,
        });
        return {
          status: result.status === "terminal" && result.fact.terminal !== "completed" ? "error" : "ok",
          attrs: { operation_id: operationId, outcome: result.status },
        };
      },
      (outcome) => outcome,
    );
  }


  protected terminalizeComputerLifecycleOperation(
    input: Parameters<typeof computerLifecycleOperationService.terminalizeComputerLifecycleOperation>[0],
  ) {
    return computerLifecycleOperationService.terminalizeComputerLifecycleOperation(input);
  }

  private async sendComputerLifecycleFailureReceipts(
    machineId: string,
    operationId: string,
    terminalization: Awaited<ReturnType<typeof computerLifecycleOperationService.terminalizeComputerLifecycleOperation>>,
  ): Promise<void> {
    if (terminalization.status !== "terminal") return;
    await this.sendToMachine(machineId, {
      type: "computer:lifecycle:receipt",
      operationId,
      phase: "shutdown",
    });
    await this.sendToMachine(machineId, {
      type: "computer:lifecycle:receipt",
      operationId,
      phase: "ready",
    });
  }

  /**
   * The daemon version a start dispatch must reason about. The local
   * connection is authoritative when this replica owns the machine; otherwise
   * the owner replica's shared machine meta carries the same `ready` fact.
   * Task #1129: a replica without the connection used to read null here,
   * dispatched the start without a launchId, and left the agent guarded on
   * the previous launch — every frame of the new process was then dropped.
   */
  protected async resolveMachineDaemonVersionForStart(machineId: string): Promise<string | null> {
    const local = this.getMachineDaemonVersion(machineId);
    if (local) return local;
    if (!this.replicaStateStore.isAvailable()) return null;
    try {
      return (await this.replicaStateStore.getMachineMeta(machineId))?.daemonVersion ?? null;
    } catch {
      return null;
    }
  }

  /** Check if a daemon supports the launchId lifecycle guard (requires >= 0.30.1). */
  private async daemonSupportsLaunchGuard(machineId: string): Promise<boolean> {
    return supportsLaunchGuardForDaemonVersion(await this.resolveMachineDaemonVersionForStart(machineId));
  }

  /** The guard state a start dispatch found, so a failed send can put it back. */
  protected snapshotLaunchGuard(agentId: string): Pick<CachedAgentState, "expectedLaunchId" | "launchGuardMode"> {
    const cached = this.agentStateCache.get(agentId);
    return {
      expectedLaunchId: cached?.expectedLaunchId ?? null,
      launchGuardMode: cached?.launchGuardMode ?? "legacy",
    };
  }

  /**
   * Arm the guard for the launch about to be sent, or — when this start
   * cannot carry a launchId — drop to legacy so the frames it produces are
   * not rejected against a launch that is no longer running. A start that
   * goes out without a launchId while the agent stays guarded is exactly the
   * fleet-wide drop of 2026-09-14.
   */
  protected async prepareStartLaunchGuard(agentId: string, machineId: string | null): Promise<string | undefined> {
    const launchId = await this.planStartLaunchId(machineId);
    this.armStartLaunchGuard(agentId, launchId);
    return launchId;
  }

  /** The launchId a start will carry (a plain value; nothing is armed), or undefined when the daemon cannot carry one. */
  protected async planStartLaunchId(machineId: string | null): Promise<string | undefined> {
    if (!machineId || !(await this.daemonSupportsLaunchGuard(machineId))) return undefined;
    return crypto.randomUUID();
  }

  /** Arm the guard for a planned launch, or drop to legacy when the start carries none. */
  protected armStartLaunchGuard(agentId: string, launchId: string | undefined): void {
    if (launchId === undefined) {
      this.clearLaunchGuard(agentId);
      return;
    }
    this.setLaunchGuard(agentId, launchId);
  }

  /**
   * A send that failed did not replace the running process, so the guard
   * goes back to what it was — not to legacy, which would accept frames from
   * any launch. RFC 071 §4.3 (H-13): compare-and-restore. Only while the
   * guard is still the one this start armed; a concurrent start that armed
   * its own guard since keeps it.
   */
  protected rollbackStartLaunchGuard(
    agentId: string,
    previous: Pick<CachedAgentState, "expectedLaunchId" | "launchGuardMode">,
    armedLaunchId: string | undefined,
  ) {
    const current = this.snapshotLaunchGuard(agentId);
    const stillOurs = armedLaunchId === undefined
      ? current.expectedLaunchId === null && current.launchGuardMode === "legacy"
      : current.expectedLaunchId === armedLaunchId;
    if (!stillOurs) {
      this.recordEvent("terminal_breaker.rollback", { step: "guard", outcome: "rollback_skipped_not_owner" });
      return;
    }
    this.updateCache(agentId, { expectedLaunchId: previous.expectedLaunchId, launchGuardMode: previous.launchGuardMode });
  }

  /** Resolve current machine status from live reachability instead of trusting stale DB state. */
  async getMachineStatus(machineId: string): Promise<"online" | "offline"> {
    if (this.hasMachineLocally(machineId)) return "online";
    if (this.pendingMachineDisconnects.has(machineId)) return "online";
    if (this.replicaStateStore.isAvailable()) {
      const ownerReplica = await this.replicaStateStore.getMachineReplicaOwner(machineId);
      return ownerReplica && ownerReplica !== REPLICA_ID ? "online" : "offline";
    }
    return "offline";
  }

  /**
   * Runtimes reported in the daemon `ready` message for a locally-connected
   * machine, straight from the live connection (same live "Ready" event as the
   * client machine:capabilities emit). Null before `ready` is processed or when
   * the machine is not connected on this replica. Used by server-authoritative
   * readiness so its runtime fact stays same-source with the client card
   * instead of reading the lagging persisted `machines.runtimes` column.
   */
  getMachineRuntimes(machineId: string): string[] | null {
    return this.machineConnections.get(machineId)?.runtimes ?? null;
  }

  private async getMachineOwnerTraceAttrs(machineId: string): Promise<Record<string, unknown>> {
    const localConn = this.machineConnections.get(machineId);
    if (localConn?.ws.readyState === 1) {
      return {
        ...projectOwnerTraceAttrs(localConn.traceContext ?? buildRuntimeTraceContext()),
        owner_replica_present: true,
        owner_replica_current: true,
      };
    }
    if (!this.replicaStateStore.isAvailable()) {
      return {
        ...projectOwnerTraceAttrs(null),
        owner_replica_present: false,
        owner_replica_current: false,
      };
    }
    try {
      const [ownerReplica, ownerContext] = await Promise.all([
        this.replicaStateStore.getMachineReplicaOwner(machineId),
        this.replicaStateStore.getMachineReplicaTraceContext?.(machineId) ?? Promise.resolve(null),
      ]);
      return {
        ...projectOwnerTraceAttrs(ownerContext),
        owner_replica_present: Boolean(ownerReplica),
        owner_replica_current: ownerReplica === REPLICA_ID,
      };
    } catch {
      return {
        ...projectOwnerTraceAttrs(null),
        owner_replica_present: false,
        owner_replica_current: false,
      };
    }
  }

  /** Check if a machine is connected to THIS replica (for fly-replay routing). */
  hasMachineLocally(machineId: string): boolean {
    const conn = this.machineConnections.get(machineId);
    return !!conn
      && conn.replicaGeneration !== null
      && conn.ws.readyState === 1
      && !this.isMachineHeartbeatStale(conn);
  }

  /** Close all machine connections and timers (for graceful shutdown). */
  async shutdown(): Promise<void> {
    if (this.staleActivityTimer) {
      this.clock.cancelRepeated(this.staleActivityTimer);
      this.staleActivityTimer = null;
    }
    for (const timer of this.activityDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.activityDebounceTimers.clear();
    for (const pending of this.pendingMachineDisconnects.values()) {
      this.clock.clearTimeout(pending.timer);
    }
    this.pendingMachineDisconnects.clear();
    for (const pending of this.pendingAgentDeliveryAcks.values()) {
      if (pending.timer) this.clock.clearTimeout(pending.timer);
      this.recordAgentDeliveryOutcome(pending, "replica_shutdown");
    }
    this.pendingAgentDeliveryAcks.clear();
    for (const pending of this.pendingAgentStartAcks.values()) {
      if (pending.timer) this.clock.clearTimeout(pending.timer);
    }
    this.pendingAgentStartAcks.clear();
    this.terminalAgentStartDispatches.clear();
    for (const write of this.capabilitiesWrites.values()) {
      if (write.timer != null) this.clock.clearTimeout(write.timer);
      write.cancelled = true;
    }
    this.capabilitiesWrites.clear();
    this.capabilitiesGenerationSeq.clear();
    const machineIds = [...this.machineConnections.keys()];
    const unregisters = machineIds.map(async (machineId) => {
      try {
        await this.unregisterMachine(machineId);
      } catch (err) {
        console.warn(
          `[Machine ${machineId}] Failed to unregister during orchestrator shutdown:`,
          err instanceof Error ? err.message : err,
        );
      }
    });
    this.lifecycleEventsByAgent.clear();
    await Promise.allSettled(unregisters);
  }

  async handleMachineDisconnect(machineId: string, ws?: WebSocket, context: MachineDisconnectContext = {}) {
    const span = this.tracer.startSpan("server.machine.connection.disconnect", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "internal",
      attrs: {
        machine_id: machineId,
        machine_id_present: Boolean(machineId),
        cause: context.cause || "socket_close",
        close_code_present: context.closeCode !== undefined,
        close_reason_present: Boolean(context.closeReason),
        error_present: Boolean(context.errorMessage),
        shutdown_intent_present: Boolean(context.shutdownIntent),
        shutdown_reason: context.shutdownIntent?.reason,
      },
    });
    await this.runInActiveSpan(span, async () => {
      const conn = this.machineConnections.get(machineId);
      // Ignore stale disconnect from a previous socket (e.g. after reconnect)
      if (ws && conn && conn.ws !== ws) {
        console.log(`[Machine ${machineId}] Ignoring stale disconnect from previous socket`);
        span.end("ok", { attrs: { outcome: "ignored_stale_socket" } });
        return;
      }
      // Ignore duplicate disconnect (error + close both fire on same socket)
      if (!conn) {
        span.end("ok", { attrs: { outcome: "ignored_duplicate" } });
        return;
      }
      const serverId = conn.serverId;
      const connectionEpochId = conn.connectionEpochId;
      const replicaGeneration = conn.replicaGeneration;
      const shutdownIntent = context.shutdownIntent ?? conn.shutdownIntent ?? undefined;
      const disconnectContext: MachineDisconnectContext = shutdownIntent
        ? { ...context, shutdownIntent }
        : context;
      this.emit(`machine:disconnect:${machineId}`, disconnectContext);
      await this.clearMachineConnection(machineId, false);
      this.dispatchComputerLifecycleDisconnectObservation({
        machineId,
        serverId,
        connectionEpoch: connectionEpochId,
      });
      this.recordEvent("operation.disconnect_observation.dispatched", { outcome: "dispatched" });

      this.cancelPendingMachineDisconnect(machineId);
      const pending: PendingMachineDisconnectProjection = {
        serverId,
        connectionEpochId,
        replicaGeneration,
        context: disconnectContext,
        timer: null,
      };
      pending.timer = this.scheduleOnClock(() => {
        void this.applyMachineDisconnectProjection(machineId, pending);
      }, MACHINE_DISCONNECT_PROJECTION_GRACE_MS);
      this.pendingMachineDisconnects.set(machineId, pending);
      span.end("ok", {
        attrs: {
          outcome: "scheduled",
          server_id: serverId,
          connection_epoch_present: Boolean(connectionEpochId),
          projection_grace_ms: MACHINE_DISCONNECT_PROJECTION_GRACE_MS,
          shutdown_intent_present: Boolean(shutdownIntent),
          shutdown_reason: shutdownIntent?.reason,
        },
      });
    });
  }

  protected observeComputerLifecycleDisconnect(
    input: Parameters<typeof computerLifecycleOperationService.observeComputerLifecycleDisconnect>[0],
  ) {
    return computerLifecycleOperationService.observeComputerLifecycleDisconnect(input);
  }

  private dispatchComputerLifecycleDisconnectObservation(
    input: Parameters<typeof computerLifecycleOperationService.observeComputerLifecycleDisconnect>[0],
  ): void {
    const sidecarSpan = this.tracer.startSpan("server.computer.operation.disconnect_observation", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "internal",
      attrs: {
        machine_id: input.machineId,
        server_id: input.serverId,
        operation_phase: "disconnect",
      },
    });
    let settled = false;
    const finish = (outcome: "recorded" | "error" | "timeout", errorClass?: string) => {
      if (settled) return;
      settled = true;
      this.clock.clearTimeout(timer);
      sidecarSpan.end(outcome === "recorded" ? "ok" : "error", {
        attrs: {
          outcome,
          ...(errorClass ? { error_class: errorClass } : {}),
        },
      });
      if (outcome !== "recorded") {
        console.warn(`[Machine ${input.machineId}] Lifecycle disconnect observation ${outcome} (${errorClass ?? "unknown"})`);
      }
    };
    const timer = this.scheduleOnClock(() => {
      finish("timeout", "timeout");
    }, COMPUTER_LIFECYCLE_DISCONNECT_OBSERVATION_TIMEOUT_MS);
    void this.runInActiveSpan(sidecarSpan, () => this.observeComputerLifecycleDisconnect(input)).then(
      () => finish("recorded"),
      (error) => finish("error", boundedErrorClass(error)),
    );
  }

  private async applyMachineDisconnectProjection(
    machineId: string,
    pending: PendingMachineDisconnectProjection,
  ) {
    const currentPending = this.pendingMachineDisconnects.get(machineId);
    if (currentPending !== pending) return;
    if (this.machineConnections.has(machineId)) {
      this.cancelPendingMachineDisconnect(machineId);
      return;
    }

    this.pendingMachineDisconnects.delete(machineId);
    const { serverId, connectionEpochId, context } = pending;
    const span = this.tracer.startSpan("server.machine.connection.disconnect_projection", {
      surface: "server",
      kind: "internal",
      attrs: {
        machine_id: machineId,
        server_id: serverId,
        machine_id_present: Boolean(machineId),
        server_id_present: Boolean(serverId),
        cause: context.cause || "socket_close",
        close_code_present: context.closeCode !== undefined,
        close_reason_present: Boolean(context.closeReason),
        error_present: Boolean(context.errorMessage),
        shutdown_intent_present: Boolean(context.shutdownIntent),
        shutdown_reason: context.shutdownIntent?.reason,
        connection_epoch_present: Boolean(connectionEpochId),
        projection_grace_ms: MACHINE_DISCONNECT_PROJECTION_GRACE_MS,
      },
    });
    await this.runInActiveSpan(span, async () => {

      await this.commitMachineReplicaDisconnectState(
        machineId,
        pending.replicaGeneration ?? undefined,
      );
      if (this.machineConnections.has(machineId)) {
        try {
          const conn = this.machineConnections.get(machineId);
          if (!conn) throw new Error("Machine connection disappeared before replica repair");
          conn.replicaGeneration = null;
          const replicaGeneration = requireReplicaGeneration(
            await this.replicaStateStore.registerMachineReplica(
              machineId,
              conn.traceContext ?? buildRuntimeTraceContext(),
            ),
          );
          if (this.machineConnections.get(machineId)?.ws === conn.ws) {
            conn.replicaGeneration = replicaGeneration;
          } else {
            await this.replicaStateStore.unregisterMachineReplica(machineId, replicaGeneration);
          }
          this.recordEvent("machine.replica.register_repaired_after_reconnect", {
            outcome: "repaired",
            reason: "reconnected_during_projection",
            ...projectMachineConnectTraceAttrs(conn?.traceContext ?? buildRuntimeTraceContext()),
          });
        } catch (err) {
          console.error(
            `[Machine ${machineId}] Failed to repair replica mapping after reconnect:`,
            err instanceof Error ? err.message : err,
          );
          this.recordEvent("machine.replica.register_repair_failed", {
            outcome: "failed",
            reason: "replica_register_repair_failed",
            error_class: errorClassOf(err),
          });
          const conn = this.machineConnections.get(machineId);
          if (conn?.replicaGeneration === null) {
            await this.clearMachineConnection(machineId, false, {
              code: 1011,
              reason: "replica_registration_failed",
            }, conn.ws);
          }
        }
        span.end("ok", { attrs: { outcome: "canceled_after_reconnect" } });
        return;
      }

      // Mark all active agents on this machine offline, but preserve enough
      // lifecycle state for a future explicit work item to lazy-wake them.
      try {
        try {
          const outage = await recordComputerOfflineTransition({
            serverId,
            machineId,
            connectionEpochId,
            shutdownIntent: context.shutdownIntent,
            now: new Date(this.clock.now()),
          });
          this.recordEvent("machine.outage.recorded", {
            outcome: outage.status,
            ...(outage.status === "created" ? { occurrence_id_present: Boolean(outage.occurrenceId) } : {}),
            ...(outage.status === "suppressed_planned" ? { suppress_reason: outage.reason } : {}),
          });
        } catch (err) {
          console.warn(
            `[Machine ${machineId}] Failed to record Computer outage transition:`,
            err instanceof Error ? err.message : err,
          );
          this.recordEvent("machine.outage.failed", {
            outcome: "failed",
            error_class: errorClassOf(err),
          });
        }
        const machineAgents = await this.loadAgentsForDisconnect(machineId);
        let activeAgentsCount = 0;
        let pendingReceivesResolvedCount = 0;
        for (const agent of machineAgents) {
          this.releaseWakeLock(agent.id);
          if (agent.status === "active") {
            activeAgentsCount += 1;
            const shutdownIntent = context.shutdownIntent;
            const activityDedupeKey = this.makeLifecycleDedupeKey(
              "agent",
              agent.id,
              "machine",
              machineId,
              "connectionEpoch",
              connectionEpochId,
              shutdownIntent ? "shutdown" : "disconnect",
            );
            const disconnectCause = context.cause || "socket_close";
            await applyAgentLifecycleProjectionPlan(
              shutdownIntent
                ? reduceMachineShutdownLifecycle({
                  activityDedupeKey,
                  event: adaptMachineShutdownLifecycleEvent({
                    serverId: agent.serverId,
                    agentId: agent.id,
                    machineId,
                    connectionEpochId,
                    disconnectCause,
                    previousStatus: agent.status,
                    shutdownReason: shutdownIntent.reason,
                    now: () => new Date(this.clock.now()),
                  }).event,
                  shutdownReason: shutdownIntent.reason,
                  state: buildAgentLifecycleStateSnapshot({
                    dbStatus: agent.status,
                    machineId,
                    machineReachability: "unreachable",
                    runtimeState: "interrupted",
                  }),
                })
                : reduceMachineDisconnectLifecycle({
                  activityDedupeKey,
                  // TODO(lifecycle-v2/server-producer): machine disconnect is a
                  // server-owned reachability transition. Emit canonical
                  // machine_disconnected events from the disconnect planner with
                  // the connection epoch and cause, then delete this adapter call.
                  event: adaptMachineDisconnectLifecycleEvent({
                    serverId: agent.serverId,
                    agentId: agent.id,
                    machineId,
                    reason: context.cause === "heartbeat_timeout"
                      ? "heartbeat_timeout"
                      : context.cause === "computer_machine_unlinked"
                        ? "computer_machine_unlinked"
                        : "machine_disconnect",
                    connectionEpochId,
                    disconnectCause,
                    previousStatus: agent.status,
                    now: () => new Date(this.clock.now()),
                  }).event,
                  state: buildAgentLifecycleStateSnapshot({
                    dbStatus: agent.status,
                    machineId,
                    machineReachability: "unreachable",
                    runtimeState: "interrupted",
                  }),
                }),
              this.lifecycleProjectionWriterDeps(),
              span,
            );

            // Clean up inbox
            if (this.clearAgentInbox(agent.id)) {
              pendingReceivesResolvedCount += 1;
            }
          }
          // task #1119: a machine disconnect is deliberately NOT fed to the wake
          // crash-loop breaker. A transport loss carries no exit evidence, so it
          // cannot prove the runner died; only a daemon-reported process exit
          // (agent:status inactive with exit evidence + launchId) counts.
        }

        let statusVersion: number | null = null;
        if (serverId) {
          statusVersion = await this.bumpMachineStatusVersion(machineId);
          this.io?.to(`server:${serverId}`).emit("machine:status", {
            machineId,
            status: "offline",
            statusVersion,
            cause: context.shutdownIntent ? "machine_shutdown" : context.cause || "socket_close",
            ...(context.shutdownIntent ? { shutdownReason: context.shutdownIntent.reason } : {}),
          });
          this.recordEvent("machine.status.emitted", {
            outcome: "emitted",
            status: "offline",
            status_version: statusVersion,
            shutdown_intent_present: Boolean(context.shutdownIntent),
            shutdown_reason: context.shutdownIntent?.reason,
          });
        }

        const detailParts = [
          `reason=${context.cause || "socket_close"}`,
          `affected_agents=${machineAgents.length}`,
        ];
        if (context.shutdownIntent) detailParts.push(`shutdown_reason=${context.shutdownIntent.reason}`);
        if (context.closeCode !== undefined) detailParts.push(`code=${context.closeCode}`);
        if (context.closeReason) detailParts.push(`close_reason=${JSON.stringify(context.closeReason)}`);
        if (context.errorMessage) detailParts.push(`error=${JSON.stringify(context.errorMessage)}`);
        console.log(`[Machine ${machineId}] Disconnected (${detailParts.join(", ")})`);
        span.end("ok", {
          attrs: {
            outcome: "processed",
            affected_agents_count: machineAgents.length,
            active_agents_count: activeAgentsCount,
            pending_receives_resolved_count: pendingReceivesResolvedCount,
            status_version: statusVersion,
            shutdown_intent_present: Boolean(context.shutdownIntent),
            shutdown_reason: context.shutdownIntent?.reason,
          },
        });
      } catch (err) {
        console.error(`[Machine ${machineId}] Failed to clean up agents on disconnect:`, err);
        let statusVersion: number | null = null;
        if (serverId) {
          statusVersion = await this.bumpMachineStatusVersion(machineId);
          this.io?.to(`server:${serverId}`).emit("machine:status", {
            machineId,
            status: "offline",
            statusVersion,
            cause: context.shutdownIntent ? "machine_shutdown" : context.cause || "socket_close",
            ...(context.shutdownIntent ? { shutdownReason: context.shutdownIntent.reason } : {}),
          });
        }
        span.end("error", {
          attrs: {
            outcome: "cleanup_failed",
            error_class: errorClassOf(err),
            status_version: statusVersion,
            shutdown_intent_present: Boolean(context.shutdownIntent),
            shutdown_reason: context.shutdownIntent?.reason,
          },
        });
      }
    });
  }

  private planDaemonIngressRateLimit(
    machineId: string,
    messageType: MachineToServerMessage["type"],
  ): DaemonIngressRateLimitDecision {
    if (this.daemonIngressRateLimitDisabled || !DAEMON_INGRESS_RATE_LIMITED_MESSAGE_TYPES.has(messageType)) {
      return { action: "allow" };
    }

    const totalDecision = this.planDaemonIngressRateLimitBucket({
      windows: this.daemonIngressTotalRateLimitWindows,
      key: machineId,
      limit: this.daemonIngressRateLimitMaxEventsPerMachine,
      scope: "machine_total",
    });
    if (totalDecision.action === "drop") {
      return totalDecision;
    }

    const messageTypeDecision = this.planDaemonIngressRateLimitBucket({
      windows: this.daemonIngressRateLimitWindows,
      key: `${machineId}:${messageType}`,
      limit: this.daemonIngressRateLimitMaxEvents,
      scope: "message_type",
      messageType,
    });
    if (messageTypeDecision.action === "drop") {
      return messageTypeDecision;
    }

    const aggregateDrops = [totalDecision.aggregateDrop, messageTypeDecision.aggregateDrop]
      .filter((drop): drop is DaemonIngressRateLimitTraceAttrs & { aggregateDroppedCount: number } => Boolean(drop));

    return aggregateDrops.length > 0
      ? { action: "allow", aggregateDrops }
      : { action: "allow" };
  }

  private planDaemonIngressRateLimitBucket(input: {
    windows: Map<string, DaemonIngressRateLimitWindow>;
    key: string;
    limit: number;
    scope: DaemonIngressRateLimitScope;
    messageType?: MachineToServerMessage["type"];
  }): DaemonIngressRateLimitBucketDecision {
    const now = this.clock.now();
    const existing = input.windows.get(input.key);
    const traceAttrs: DaemonIngressRateLimitTraceAttrs = {
      scope: input.scope,
      limit: input.limit,
      ...(input.messageType ? { messageType: input.messageType } : {}),
    };
    if (!existing || now - existing.startedAt >= this.daemonIngressRateLimitWindowMs) {
      const aggregateDroppedCount = existing?.droppedCount;
      input.windows.set(input.key, {
        startedAt: now,
        count: 1,
        droppedCount: 0,
      });
      return aggregateDroppedCount
        ? { action: "allow", aggregateDrop: { ...traceAttrs, aggregateDroppedCount } }
        : { action: "allow" };
    }

    existing.count += 1;
    if (existing.count <= input.limit) {
      return { action: "allow" };
    }

    existing.droppedCount += 1;
    return {
      action: "drop",
      droppedCount: existing.droppedCount,
      retryAfterMs: Math.max(0, existing.startedAt + this.daemonIngressRateLimitWindowMs - now),
      trace: existing.droppedCount === 1 || existing.droppedCount % 1_000 === 0,
      attrs: traceAttrs,
    };
  }

  private traceDaemonIngressRateLimit(
    machineId: string,
    serverId: string | undefined,
    messageType: MachineToServerMessage["type"],
    decision:
      | Extract<DaemonIngressRateLimitDecision, { action: "drop" }>
      | (DaemonIngressRateLimitTraceAttrs & { action: "aggregate"; aggregateDroppedCount: number }),
    msg?: MachineToServerMessage,
  ) {
    const agentId = msg && "agentId" in msg && typeof msg.agentId === "string" ? msg.agentId : undefined;
    const traceAttrs = decision.action === "drop" ? decision.attrs : decision;
    const baseAttrs = {
      machine_id: machineId,
      server_id: serverId,
      machine_id_present: Boolean(machineId),
      server_id_present: Boolean(serverId),
      agent_id: agentId,
      agent_id_present: Boolean(agentId),
      scope: traceAttrs.scope,
      message_type: traceAttrs.scope === "message_type" ? traceAttrs.messageType ?? messageType : undefined,
      window_ms: this.daemonIngressRateLimitWindowMs,
      limit: traceAttrs.limit,
      max_events: traceAttrs.limit,
    };
    if (decision.action === "drop") {
      this.recordEvent("server.daemon.ingress.rate_limit", {
        ...baseAttrs,
        outcome: "dropped",
        reason: "daemon_ingress_rate_limited",
        dropped_count: decision.droppedCount,
        retry_after_ms: decision.retryAfterMs,
      });
      return;
    }
    this.recordEvent("server.daemon.ingress.rate_limit", {
      ...baseAttrs,
      outcome: "suppressed_aggregate",
      reason: "daemon_ingress_rate_limited",
      suppressed_count: decision.aggregateDroppedCount,
    });
  }

  async handleMachineMessage(machineId: string, msg: MachineToServerMessage, ws?: WebSocket) {
    const conn = this.machineConnections.get(machineId);
    // A replaced socket can still have a buffered message callback queued.
    // Never let an old legacy principal act through the current Computer
    // connection's machineId after a handoff.
    if (ws && (!conn || conn.ws !== ws)) return;
    const daemonIngressRateLimit = this.planDaemonIngressRateLimit(machineId, msg.type);
    if (daemonIngressRateLimit.action === "drop") {
      if (daemonIngressRateLimit.trace) {
        this.traceDaemonIngressRateLimit(machineId, conn?.serverId, msg.type, daemonIngressRateLimit, msg);
      }
      return;
    }
    for (const aggregateDrop of daemonIngressRateLimit.aggregateDrops ?? []) {
      this.traceDaemonIngressRateLimit(
        machineId,
        conn?.serverId,
        msg.type,
        { action: "aggregate", ...aggregateDrop },
        msg,
      );
    }

    // One accepted frame has one observation time. Owner memory and the
    // cross-replica mirror must not disagree because the clock ticked between
    // two projections of the same ready/pong frame.
    const ingressAtMs = this.clock.now();
    if (conn) {
      conn.lastIngressAt = ingressAtMs;
    }
    this.refreshReplicaLivenessFromDaemonIngress(machineId, conn, msg.type);

    const builtInDispatch = resolveBuiltInMachineMessageDispatch(msg);
    if (builtInDispatch) {
      const agent = await this.validateMachineAgentMessage(
        machineId,
        conn?.serverId ?? null,
        builtInDispatch.agentId,
        msg.type,
      );
      if (!agent) return;
      await this.runAppSourceReceipt(
        {
          machine_id: machineId,
          server_id: agent.serverId,
          agent_id: agent.id,
          receipt_type: msg.type,
        },
        (setReceiptOutcome) => builtInDispatch.handle({
          host: this,
          machineId,
          agent,
          daemonVersion: conn?.daemonVersion ?? null,
          computerVersion: conn?.computerVersion ?? null,
          capabilities: conn?.capabilities ?? new Set(),
          nowMs: this.clock.now(),
          send: (message) => this.sendToMachine(machineId, message),
          setReceiptOutcome,
          emit: (event, payload) => {
            this.io?.to(`server:${agent.serverId}`).emit(event, payload);
          },
        }),
        "traceparent" in msg && typeof msg.traceparent === "string" ? parseTraceparent(msg.traceparent) : null,
      );
      return;
    }

    switch (msg.type) {
      case "ping":
      {
        await this.sendToMachine(machineId, { type: "ping" });
        break;
      }

      case "pong":
      {
        const previousLastPong = conn?.lastPong ?? null;
        if (conn) conn.lastPong = ingressAtMs;
        let heartbeatError: unknown = null;
        await this.runInTraceSpan(
          "server.machine.websocket.pong_received",
          {
            attrs: {
              machine_id: machineId,
              server_id: conn?.serverId,
              machine_id_present: Boolean(machineId),
              server_id_present: Boolean(conn?.serverId),
              previous_last_pong_age_ms_bucket: previousLastPong == null ? "unknown" : durationMsBucket(this.clock.now() - previousLastPong),
              connection_present: Boolean(conn),
            },
          },
          async () => {
            try {
              await this.updateMachineHeartbeat(machineId);
            } catch (err) {
              console.error(`[Machine ${machineId}] Failed to update heartbeat:`, err);
              heartbeatError = err;
            }
            // Refresh machine→replica TTL in Redis so cross-replica routing stays valid
            this.replicaStateStore.refreshMachineReplica(
              machineId,
              conn?.traceContext ?? buildRuntimeTraceContext(),
              conn?.replicaGeneration ?? undefined,
            ).catch(() => {});
            // Upsert the cross-replica meta mirror with the connection's current
            // live fields. Beyond just bumping TTL, this self-heals two narrow
            // failure modes: (1) the original `ready` write missed Redis (e.g.
            // a transient outage right when the daemon connected), and (2) the
            // entry was evicted by Redis under pressure. Either way, the very
            // next heartbeat re-populates fields + resets the deadline so
            // non-owner replica REST stops returning null. Best-effort —
            // a Redis miss here is silent. Only the owner replica enters this
            // branch (conn is the local-replica connection state).
            if (conn) {
              this.replicaStateStore
                .setMachineMeta(machineId, {
                  computerVersion: conn.computerVersion ?? null,
                  computerVersionObservedAt: new Date(ingressAtMs).toISOString(),
                  daemonVersion: conn.daemonVersion ?? null,
                  runtimeVersions: JSON.stringify(conn.runtimeVersions ?? {}),
                  ...machineMetaFromMigrationTransport(conn.migrationTransport),
                  ...this.probeCarrierMetaFields(conn),
                })
                .catch(() => {});
            }
            await this.maybePiggybackRuntimeProfileMigrationNudgesForMachine(machineId);
          },
          () => heartbeatError == null
            ? { attrs: { outcome: "heartbeat_persisted" } }
            : { status: "error", attrs: { outcome: "heartbeat_persist_failed", error_class: errorClassOf(heartbeatError) } },
        );
        break;
      }

      case "machine:runtime_account_usage:snapshot":
      {
        // Re-authorize at the source-to-cache boundary. Raw/legacy principals
        // and Computers that no longer have an attaching human must never
        // populate the private runtime-usage cache.
        if (!conn || !await this.isRuntimeAccountUsageDataBoundaryAuthorized(machineId, conn)) break;
        await this.writeRuntimeAccountUsageSnapshot(machineId, msg.snapshot);
        // Manual refreshes wait on this reply through the cross-replica relay.
        // Forward only after the cache write above, so a resolved waiter finds
        // the snapshot already cached; the relay is a side channel here, the
        // write above stays the single cache mutation. Snapshots without a
        // requestId have no waiter and are skipped by forward().
        void this.getMachineResponseRelay().forward(machineId, msg,
          (event, attrs) => this.recordMachineResponseRelay(event, attrs));
        break;
      }

      case "machine:disk_status":
      {
        if (!conn) break;
        const disk = { availableBytes: msg.availableBytes, totalBytes: msg.totalBytes };
        if (!isValidMachineDiskStatus(disk)) break;
        const wasLow = isMachineDiskLow(conn.diskStatus);
        conn.diskStatus = disk;
        this.replicaStateStore
          .setMachineMeta(machineId, {
            diskAvailableBytes: String(disk.availableBytes),
            diskTotalBytes: String(disk.totalBytes),
          })
          .catch(() => {});
        // Clients refetch machines only when the warning appears or clears,
        // not on every hourly report.
        if (wasLow !== isMachineDiskLow(disk)) {
          this.io?.to(`server:${conn.serverId}`).emit("machine:updated", {
            serverId: conn.serverId,
            machineId,
          });
        }
        break;
      }

      case "machine:runtime_models:catalog":
      {
        // Proactive model-list report (task #700). The catalog is display
        // data that every member may read, so it does not need the private
        // usage boundary; it is still validated strictly at the boundary and
        // a malformed report keeps the previous copy.
        if (conn) {
          await machineRuntimeModelCatalogService.writeRuntime(machineId, msg.runtime, msg.models);
        }
        break;
      }

      case "machine:shutdown":
      {
        if (conn) {
          const shutdownConn = conn;
          const reason = normalizeMachineShutdownReason(msg.reason);
          await this.runInTraceSpan(
            "server.machine.shutdown_intent.received",
            {
              attrs: {
                machine_id: machineId,
                server_id: shutdownConn.serverId,
                machine_id_present: Boolean(machineId),
                server_id_present: Boolean(shutdownConn.serverId),
                shutdown_reason: reason,
              },
            },
            async () => {
              for (const acknowledgement of msg.lifecycleAcks ?? []) {
                await this.handleComputerLifecycleAcknowledgement(
                  machineId,
                  shutdownConn.serverId,
                  shutdownConn.connectionEpochId,
                  acknowledgement,
                );
              }
              shutdownConn.shutdownIntent = {
                reason,
                receivedAtMs: this.clock.now(),
              };
            },
            () => ({ attrs: { outcome: "recorded" } }),
          );
        }
        break;
      }

      case "computer:restart:done":
      {
        // Relay managed Computer operation frames to web clients.
        // The daemon frame carries only `requestId` (it doesn't know its own
        // server-machine id); the server is the sole party that knows which
        // machine this connection is, so we ADD `machineId` here. The web
        // (machineStore/MachineDetailPanel) routes by machineId and correlates
        // by requestId. Emitted to the same `server:<id>` room as
        // machine:capabilities/status, so the Redis adapter fans it out to web
        // clients on any replica (the daemon WS is pinned to this replica).
        // Additive + best-effort: a pre-relay server just dropped these frames.
        if (conn) {
          // Durable-before-projection (task #356 / #5092): persist a successful,
          // non-rolled-back upgrade's new version BEFORE relaying the done frame
          // to web, so a reload in the relay->reload window cannot read a stale
          // version. recordReportedMachineComputerVersion swallows DB errors, so
          // on a failed persist we still relay the operation-fact but leave the
          // old row for ready/lifecycle-ack replay to converge (Web must not
          // optimistically claim the new version). Only ok && !rolledBack
          // advances the row — a failed/rolled-back frame that still carries
          // newVersion must not (previously an unguarded persist ran below).
          const relayConn = conn;
          await this.runInTraceSpan(
            "server.computer.control.relay",
            {
              attrs: {
                action: "restart",
                event_type: msg.type,
                server_id: relayConn.serverId,
                machine_id: machineId,
                request_id: msg.requestId,
                ok: msg.ok,
                error_present: Boolean(msg.error),
              },
            },
            async () => {
              this.io?.to(`server:${relayConn.serverId}`).emit(msg.type, { machineId, ...msg });
              if (!msg.ok) {
                const reason = msg.error === "control_busy" || msg.error === "self_relaunch_unavailable"
                  ? msg.error
                  : "restart_reported_failure";
                const terminalization = await this.terminalizeComputerLifecycleOperation({
                  operationId: msg.requestId,
                  serverId: relayConn.serverId,
                  machineId,
                  terminal: "failed",
                  reason,
                });
                await this.sendComputerLifecycleFailureReceipts(
                  machineId,
                  msg.requestId,
                  terminalization,
                );
              }
            },
            () => ({ status: msg.ok ? "ok" : "error" }),
          );
        }
        break;
      }

      case "ready":
      {
        // RFC 069 §8: pin the daemon instance and capabilities before the
        // first await below. Inbound frames are handled concurrently, so a
        // status or activity frame sent right after `ready` must not observe
        // the connection as unpinned (status falls back to the unsequenced
        // path, activity to legacy state inference) while ready reconciles.
        if (conn) {
          conn.daemonInstanceId = typeof msg.daemonInstanceId === "string" && msg.daemonInstanceId.trim() ? msg.daemonInstanceId : null;
          conn.capabilities = new Set((msg.capabilities ?? []).filter((capability) => typeof capability === "string" && capability.trim()));
        }
        const readyCapturedAtMs = ingressAtMs;
        const runtimeVersions = normalizeRuntimeVersions(msg.runtimeVersions, msg.runtimes);
        const migrationTransport = normalizeMigrationTransportReady(msg.migrationTransport, readyCapturedAtMs);
        const span = this.tracer.startSpan("server.machine.ready.reconcile", {
          parent: getCurrentTraceContext(),
          surface: "server",
          kind: "internal",
          attrs: {
            machine_id: machineId,
            server_id: conn?.serverId,
            machine_id_present: Boolean(machineId),
            server_id_present: Boolean(conn?.serverId),
            runtimes_count: msg.runtimes.length,
            running_agents_count: msg.runningAgents.length,
            daemon_version_present: Boolean(msg.daemonVersion),
            ...(msg.daemonVersion ? { daemonVersion: msg.daemonVersion } : {}),
            ...(msg.daemonVersion ? { daemon_version: msg.daemonVersion } : {}),
            computer_version_present: Boolean(msg.computerVersion),
            ...(msg.computerVersion ? { computerVersion: msg.computerVersion } : {}),
            ...(msg.computerVersion ? { computer_version: msg.computerVersion } : {}),
            migration_transport_present: Boolean(migrationTransport),
            migration_transport_provisioned: migrationTransport?.provisioned ?? false,
            migration_transport_endpoint_present: Boolean(migrationTransport?.endpoint),
            ...(migrationTransport?.leaseSource ? { migration_transport_lease_source: migrationTransport.leaseSource } : {}),
            hostname_present: Boolean(msg.hostname),
            os_present: Boolean(msg.os),
            ...projectMachineConnectTraceAttrs(conn?.traceContext ?? buildRuntimeTraceContext()),
          },
        });
        const actionCounts: Record<string, number> = {};
        let invalid_status_count = 0;
        let requestStartCount = 0;
        let foreignRunningCount = 0;
        await this.runInActiveSpan(span, async () => {
          try {
            if (conn) {
              for (const acknowledgement of msg.lifecycleAcks ?? []) {
                await this.handleComputerLifecycleAcknowledgement(
                  machineId,
                  conn.serverId,
                  conn.connectionEpochId,
                  acknowledgement,
                );
              }
            }
            console.log(`[Machine ${machineId}] Ready, runtimes: ${msg.runtimes.join(", ") || "none"}, version: ${msg.daemonVersion || "unknown"}, running agents: ${msg.runningAgents.join(", ") || "none"}`);
            // Store version in memory (transient connection state)
            if (conn) {
              conn.daemonVersion = msg.daemonVersion ?? null;
              conn.runtimeOutcomeUnreliableAgents = new Set((msg.runtimeOutcomeUnreliableAgents ?? []).filter((id) => typeof id === "string" && id.length > 0));
              conn.computerVersion = msg.computerVersion ?? null;
              conn.migrationTransport = migrationTransport;
              void this.dispatchPendingComputerLifecycleOperations().catch(() => {});
            }
            // Mirror the same fields through the replica state store so REST
            // handlers that land on a non-owner replica can still surface
            // them. In-memory above stays the owner-replica source of truth;
            // the Redis hash is a TTL'd cross-replica view (see
            // replicaRouter.MachineMeta — same seam will absorb hostname/os
            // and any other owner-only live field as ApplePI's cross-replica
            // coherence contract picks them up). Best-effort: a Redis miss
            // logs nothing and the read path falls back to in-memory.
            if (this.replicaStateStore.isAvailable()) {
              this.replicaStateStore
                .setMachineMeta(machineId, {
                  computerVersion: msg.computerVersion ?? null,
                  computerVersionObservedAt: new Date(readyCapturedAtMs).toISOString(),
                  daemonVersion: msg.daemonVersion ?? null,
                  runtimeVersions: JSON.stringify(runtimeVersions),
                  hostname: msg.hostname ?? null,
                  os: msg.os ?? null,
                  ...machineMetaFromMigrationTransport(migrationTransport),
                  ...(conn ? this.probeCarrierMetaFields(conn, runtimeVersions) : {}),
                })
                .catch(() => {});
            }
            await this.recordReportedMachineComputerVersion(
              machineId,
              msg.computerVersion,
              "ready",
            );
            // Remote upgrade v2: the reported version settles any open request.
            try {
              const settled = await computerUpgradeRequestService.observeComputerVersionForUpgradeRequests({
                machineId,
                reportedVersion: msg.computerVersion,
                receipt: msg.lastUpgradeReceipt ?? null,
                now: new Date(this.clock.now()),
              });
              if (settled) {
                this.recordEvent("server.computer.upgrade_request.settled", {
                  request_id: settled.id,
                  machine_id: machineId,
                  target_version: settled.targetVersion,
                  observed_version: settled.observedVersion ?? "",
                  outcome: settled.outcome ?? "",
                });
                if (conn) this.io?.to(`server:${conn.serverId}`).emit("machine:upgrade-request", { machineId, upgradeRequest: computerUpgradeRequestService.projectComputerUpgradeRequest(settled) });
              }
            } catch (error) {
              console.warn(`[Orchestrator] upgrade request observation failed for ${machineId}: ${error instanceof Error ? error.message : String(error)}`);
            }
            // Persist runtimes to DB, then (only after the write lands) update the
            // in-memory connection + emit the client card. `machines.runtimes` is
            // the SINGLE source the setup projection reads (one row, visible from
            // every replica), so this write is not bookkeeping — it IS the fact,
            // and the card must never advance past it: a "detected" card over an
            // un-persisted column leaves Next dead with nothing on screen to
            // explain it, and diverges across replicas. Telling someone a thing is
            // ready when the only record of it failed to write is worse than
            // saying nothing — they can retry a silence, they cannot argue with a
            // lie (@Jianwei, 2026-07-13). So we do not announce what we did not
            // record; and a transient failure is retried by the server itself on a
            // capped backoff (it does NOT wait for the daemon to send another
            // `ready`), with a newer `ready` superseding the pending payload. See
            // enqueueCapabilitiesPersist and task #154 / #4691 / #4694.
            this.recordEvent("machine.capabilities.enqueued", {
              outcome: "enqueued",
              runtimes_count: msg.runtimes.length,
            });
            await this.enqueueCapabilitiesPersist(machineId, {
              runtimes: msg.runtimes,
              runtimeVersions,
              hostname: msg.hostname,
              os: msg.os,
              daemonVersion: msg.daemonVersion,
              computerVersion: msg.computerVersion,
            });
            if (conn) this.startRuntimeAccountUsageSchedule(machineId, conn);

            // Reconcile all agents assigned to this machine:
            // - running now => mark active
            // - active but missing => keep wakeable/online, mark only runtime process absent
            // - inactive/stopped => stay non-running until an explicit wake path
            try {
              const runningSet = new Set(msg.runningAgents);
              const machineAgents = await this.loadAgentsForReadyReconcile(machineId);
              this.recordEvent("machine.ready.agents.loaded", {
                outcome: "loaded",
                agents_count: machineAgents.length,
              });
              const readyDaemonInstanceId = conn?.daemonInstanceId ?? null;
              for (const agent of machineAgents) {
                // RFC 071 §4.3 rule 4, before anything below may wake the agent:
                // processes of an earlier daemon instance can no longer be seen
                // to exit on this connection unless that instance's queue replays.
                if (readyDaemonInstanceId) await this.observeTerminalDaemonReady(agent.id, readyDaemonInstanceId);
                const running = runningSet.has(agent.id);
                const narrowedStatus = narrowReadyReconcileStatus(agent.status);
                if (!narrowedStatus) {
                  console.warn(
                    `[Machine ${machineId}] Invalid persisted agent status ${JSON.stringify(agent.status)} for ${agent.id}; failing closed`,
                  );
                  invalid_status_count += 1;
                  const action = running ? "force-stop-and-stay-offline" : "stay-offline";
                  actionCounts[action] = (actionCounts[action] ?? 0) + 1;
                  await this.applyReadyReconcileAction(
                    machineId,
                    { ...agent, status: "inactive" },
                    action,
                  );
                  continue;
                }

                const action = planReadyReconcileAction({
                  status: narrowedStatus,
                  running,
                  resetMode: this.getResetMode(agent.id),
                });
                if (action === "mark-wakeable-not-running" && this.hasPendingAgentStart(agent.id, machineId)) {
                  // The ready list predates a start this replica already sent
                  // (still waiting for its ack). Marking the agent not running
                  // would drop that start's launch guard and wake lock, and the
                  // pending-inbox wake would send a second start with a new
                  // launch. The daemon runs whichever start arrives last while
                  // the guard keeps the one sent last, so a reorder left every
                  // frame of the running launch dropped as stale for hours.
                  actionCounts["start-in-flight"] = (actionCounts["start-in-flight"] ?? 0) + 1;
                  this.recordEvent("machine.ready.reconcile.start_in_flight", {
                    agent_id: agent.id,
                    machine_id: machineId,
                    outcome: "skipped",
                  });
                  continue;
                }
                actionCounts[action] = (actionCounts[action] ?? 0) + 1;
                await this.applyReadyReconcileAction(machineId, agent, action);
                if (action === "mark-wakeable-not-running" && await this.maybeWakePendingInboxAfterReady(machineId, agent)) {
                  requestStartCount += 1;
                }
              }
              foreignRunningCount = await this.observeForeignRunningAgents(
                machineId,
                msg.runningAgents.filter((agentId) => !machineAgents.some((agent) => agent.id === agentId)),
              );
            } catch (err) {
              console.error(`[Machine ${machineId}] Failed to reconcile agents:`, err);
              this.recordEvent("machine.ready.reconcile_failed", {
                outcome: "failed",
                reason: "ready_reconcile_failed",
                error_class: errorClassOf(err),
              });
            }
            try {
              await this.recoverDurableMentionDeliveriesForMachine(machineId);
            } catch (err) {
              // Ready reconciliation must keep the ordinary task #166 retry
              // executor live even when durable occurrence storage is
              // temporarily unavailable. A later agent:session event re-runs
              // the authoritative durable recovery path.
              console.error(`[Machine ${machineId}] Failed to recover durable mention deliveries:`, err);
              this.recordEvent("machine.ready.mention_recovery_failed", {
                outcome: "failed",
                reason: "mention_recovery_failed",
                error_class: errorClassOf(err),
              });
            }
            try {
              await this.pushReminderSnapshotsForMachine(machineId);
            } catch (err) {
              // Coverage push is additive: the daemon still requests snapshots
              // for running/idle agents itself, and an unsynchronized upsert
              // triggers a per-owner snapshot. Failing here must not take down
              // ready processing.
              console.error(`[Machine ${machineId}] Failed to push reminder snapshots:`, err);
              this.recordEvent("machine.ready.reminder_snapshot_push_failed", {
                outcome: "failed",
                reason: "reminder_snapshot_push_failed",
                error_class: errorClassOf(err),
              });
            }
            try {
              await this.pushAppConfigSnapshotsForMachine(machineId);
            } catch (err) {
              console.error(`[Machine ${machineId}] Failed to push app config snapshots:`, err);
              this.recordEvent("machine.ready.app_config_snapshot_push_failed", {
                outcome: "failed",
                reason: "app_config_snapshot_push_failed",
                error_class: errorClassOf(err),
              });
            }
            try {
              await this.reprovisionLostMigrationTransfers(machineId, msg);
            } catch (err) {
              console.error(`[Machine ${machineId}] Failed to re-provision lost migration transfers:`, err);
              this.recordEvent("machine.ready.migration_reprovision_failed", {
                outcome: "failed",
                reason: "migration_reprovision_failed",
                error_class: errorClassOf(err),
              });
            }
            this.retryPendingAgentDeliveriesForMachine(machineId, "ready_reconcile");
            this.retryPendingAgentStartsForMachine(machineId, "ready_reconcile");
            span.end("ok", {
              attrs: {
                outcome: "processed",
                invalid_status_count,
                force_stop_and_stay_offline_count: actionCounts["force-stop-and-stay-offline"] ?? 0,
                mark_inactive_offline_count: actionCounts["mark-inactive-offline"] ?? 0,
                mark_wakeable_not_running_count: actionCounts["mark-wakeable-not-running"] ?? 0,
                mark_active_online_count: actionCounts["mark-active-online"] ?? 0,
                stay_offline_count: actionCounts["stay-offline"] ?? 0,
                start_in_flight_count: actionCounts["start-in-flight"] ?? 0,
                foreign_running_count: foreignRunningCount,
                request_start_count: requestStartCount,
              },
            });
          } catch (err) {
            span.end("error", { attrs: { error_class: errorClassOf(err) } });
            throw err;
          }
        });
        break;
      }

      case "agent:status": {
        const span = this.tracer.startSpan("server.agent.status.ingest", {
          parent: getCurrentTraceContext(),
          surface: "server",
          kind: "internal",
          attrs: {
            agent_id: msg.agentId,
            machine_id: machineId,
            server_id: conn?.serverId,
            launch_id: msg.launchId,
            agent_id_present: Boolean(msg.agentId),
            machine_id_present: Boolean(machineId),
            launch_id_present: Boolean(msg.launchId),
            reported_status: msg.status,
          },
        });
        // RFC 069 §8 rollout evidence: which status path this frame took.
        let sequencedStatus: SequencedStatusVerdict["kind"] | undefined;
        const finish = (outcome: string, attrs?: Record<string, unknown>) => {
          span.end("ok", { attrs: { outcome, ...(sequencedStatus ? { sequenced_status: sequencedStatus } : {}), ...attrs } });
        };
        await this.runInActiveSpan(span, async () => {
          try {
            this.recordEvent("agent.status.received", {
              outcome: "received",
              reason: "daemon_status",
              reported_status: msg.status,
              launch_id_present: Boolean(msg.launchId),
            });
            const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
            if (!agent) {
              finish("dropped", { reason: "validation_failed" });
              return;
            }
            // RFC 069 §8: status is the agent's only state channel for sequenced
            // daemons; apply it in order, and only from the connected process.
            const sequenced = planSequencedStatus({
              connectionInstanceId: conn?.daemonInstanceId ?? null,
              frameInstanceId: msg.daemonInstanceId,
              frameSeq: msg.clientSeq,
              last: this.sequencedStatusVersions.get(msg.agentId),
            });
            sequencedStatus = sequenced.kind;
            if (sequenced.kind === "stale_instance" || sequenced.kind === "stale_seq") {
              this.recordEvent("agent.status.sequenced.dropped", { outcome: "dropped", reason: sequenced.kind });
              finish("dropped", { reason: sequenced.kind });
              return;
            }
            if (!this.shouldAcceptLifecycleEvent(machineId, agent, msg.type, msg.launchId, span)) {
              this.recordEvent("agent.status.lifecycle_guard.checked", {
                outcome: "rejected",
                reason: "lifecycle_guard",
                accepted: false,
                launch_id_present: Boolean(msg.launchId),
              });
              finish("dropped", { reason: "lifecycle_guard" });
              return;
            }
            this.recordEvent("agent.status.lifecycle_guard.checked", {
              outcome: "accepted",
              reason: "lifecycle_guard",
              accepted: true,
              launch_id_present: Boolean(msg.launchId),
            });
            const normalizedStatus = normalizeDaemonAgentStatus(msg.status);
            if (!normalizedStatus) {
              console.warn(`[Machine ${machineId}] Unknown agent status "${msg.status}" for ${msg.agentId}, ignoring`);
              finish("dropped", { reason: "unknown_status" });
              return;
            }
            if (sequenced.kind === "accept") this.sequencedStatusVersions.set(msg.agentId, sequenced.next);
            this.acknowledgePendingAgentStartFromLifecycle(
              msg.agentId,
              msg.launchId,
              "agent_status",
            );
            const resetMode = this.getResetMode(msg.agentId);
            const state = buildAgentLifecycleStateSnapshot({
              dbStatus: agent.status,
              launchId: msg.launchId,
              machineId,
              machineReachability: "reachable",
              resetMode,
              runtimeState: normalizedStatus === "active" ? "running_idle" : "not_running",
            });
            const action = planStatusSignalAction({
              reportedStatus: normalizedStatus,
              state,
            });
            this.recordEvent("agent.status.action.planned", {
              outcome: "planned",
              reason: "status_signal_action",
              current_status: agent.status,
              normalized_status: normalizedStatus,
              action,
            });
            const nextStatus: AgentStatus =
              action === "persist-active" ? "active"
                : action === "persist-stopped" ? "stopped"
                  : "inactive";
            // TODO(lifecycle-v2/daemon-protocol): replace legacy `agent:status`
            // ingestion with daemon-emitted canonical runtime_ready or
            // runtime_interrupted events carrying reason, launchId, correlationId,
            // and reset/window attrs. This call site is the server compatibility
            // boundary until all supported daemons speak that protocol.
            const { event } = adaptDaemonStatusLifecycleEvent({
              serverId: agent.serverId,
              agentId: msg.agentId,
              machineId,
              launchId: msg.launchId,
              currentStatus: agent.status,
              normalizedStatus,
              resetMode,
              now: () => new Date(this.clock.now()),
            });
            let liveActivityAttrs = liveActivityRootTraceAttrs(undefined);
            try {
              const result = await applyAgentLifecycleProjectionPlan(
                reduceDaemonStatusLifecycle({
                  action,
                  event,
                  nextStatus,
                  state,
                }),
                this.lifecycleProjectionWriterDeps(),
                span,
              );
              liveActivityAttrs = liveActivityRootTraceAttrs(result.liveActivityResult);
              if (action === "persist-active" || action === "persist-inactive" || action === "persist-stopped") {
                this.recordEvent("agent.status.persisted", {
                  outcome: "persisted",
                  reason: "status_signal",
                  next_status: nextStatus,
                });
              }
            } catch (err) {
              console.error(`[Machine ${machineId}] Failed to apply agent ${msg.agentId} status projection:`, err);
              this.recordEvent("agent.status.persist_failed", {
                outcome: "error",
                reason: "status_projection_failed",
                error_class: errorClassOf(err),
                next_status: nextStatus,
              });
              finish("error", {
                action,
                next_status: nextStatus,
                error_class: errorClassOf(err),
                ...liveActivityAttrs,
              });
              return;
            }
            // task #1119: a daemon-reported process exit shortly after a start is
            // an early exit for the wake crash-loop breaker. The breaker itself
            // refuses frames without exit evidence or whose launchId does not
            // match the current start. `stopped` is operator intent and never
            // counts.
            if (normalizedStatus === "active" && typeof msg.launchId === "string") {
              await this.wakeCrashLoopBreaker.confirmCatchupDelivered(msg.agentId, msg.launchId);
            }
            if (normalizedStatus === "inactive") {
              const exit = (msg as { exit?: { code: number | null; signal: string | null } }).exit;
              await this.observeWakeCrashLoopExit(msg.agentId, {
                kind: "agent_process_exited",
                evidence: exit ? { code: exit.code ?? null, signal: exit.signal ?? null } : null,
                launchId: msg.launchId ?? null,
              }, span);
            }
            finish(action === "ignore" || action === "ignore-and-release-wake-lock" ? "ignored" : "persisted", {
              action,
              next_status: nextStatus,
              ...liveActivityAttrs,
            });
          } catch (err) {
            span.end("error", {
              attrs: {
                outcome: "error",
                reason: "status_ingest_exception",
                error_class: errorClassOf(err),
              },
            });
            throw err;
          }
        });
        break;
      }

      case "agent:activity": {
        const joinTraceAttrs = daemonActivityJoinTraceAttrs(msg);
        const span = this.tracer.startSpan("server.agent.activity.ingest", {
          parent: getCurrentTraceContext(),
          surface: "server",
          attrs: {
            agent_id_present: Boolean(msg.agentId),
            machine_id_present: Boolean(machineId),
            ...joinTraceAttrs,
          },
        });
        await this.runInActiveSpan(span, async () => {
          this.recordEvent("activity.ingest.received", {
            activity: msg.activity,
            hasEntries: Boolean(msg.entries?.length),
            hasLaunchId: Boolean(msg.launchId),
            ...joinTraceAttrs,
          });

          const drop = (reason: ActivityIngestionDropReason, attrs?: Record<string, unknown>) => {
            this.recordEvent("activity.ingest.dropped", { reason, ...joinTraceAttrs, ...attrs });
            span.end("ok", { attrs: { outcome: "dropped", reason, ...joinTraceAttrs } });
          };

          try {
            const validation = await this.validateMachineAgentMessageWithReason(
              machineId,
              conn?.serverId ?? null,
              msg.agentId,
              msg.type,
            );
            if (!validation.agent) {
              drop(validation.dropReason);
              return;
            }
            const agent = validation.agent;

            const lifecycleAction = this.getLifecycleEventAcceptanceAction(agent, msg.launchId);
            this.recordEvent("lifecycle_guard.checked", {
              action: lifecycleAction,
              guardMode: agent.launchGuardMode,
              hasExpectedLaunchId: Boolean(agent.expectedLaunchId),
              hasLaunchId: Boolean(msg.launchId),
            });
            if (lifecycleAction !== "accept") {
              this.handleRejectedLifecycleEvent(machineId, agent, msg.type, msg.launchId, lifecycleAction, span);
              // Lifecycle-v2 shadow accounting (#460): the shadow's
              // stale-generation axis is observable ONLY on these guard-drop
              // rows — at the accept path both generations are identical
              // post-guard, so the arbitration stale-generation branch is a
              // structural dead branch there (#459 DoD note 4). The class is
              // computed with the same production classifier as the accept
              // path; the generation axis itself is named by the drop reason.
              {
                const droppedSnapshot = this.agentActivity.get(msg.agentId);
                const droppedObservationClass = classifyDaemonActivityObservation({
                  declaredHeartbeat: typeof msg.isHeartbeat === "boolean" ? msg.isHeartbeat : null,
                  incoming: {
                    activity: normalizeActivity(msg.activityKind ?? msg.activity, agent.status),
                    detail: msg.detail,
                    detailKind: normalizeActivityDetailKind(msg.detailKind),
                    hasEntries: Boolean(msg.entries?.length),
                    probeId: typeof msg.probeId === "string" ? msg.probeId : null,
                  },
                  lastAccepted: droppedSnapshot
                    ? {
                        activity: droppedSnapshot.activity,
                        detail: droppedSnapshot.detail,
                        detailKind: droppedSnapshot.detailKind,
                        hasEntries: false,
                      }
                    : undefined,
                });
                drop(
                  lifecycleAction === "ignore-legacy-for-guarded"
                    ? "legacy_lifecycle_event"
                    : "stale_launch_guard",
                  {
                    ...daemonActivityDropRowAttrs({
                      atMs: typeof msg.observedAtMs === "number" && Number.isFinite(msg.observedAtMs)
                        ? msg.observedAtMs
                        : this.clock.now(),
                      observationClass: droppedObservationClass,
                      probeIdPresent: typeof msg.probeId === "string",
                    }),
                  },
                );
              }
              return;
            }

            if (msg.detailKind !== undefined && !isAgentActivityDetailKind(msg.detailKind)) {
              drop("unknown_activity_detail_kind", {
                detail_kind_present: true,
              });
              return;
            }
            if (
              msg.detailKind !== undefined
              && !(msg.detailKind in CANONICAL_DAEMON_ACTIVITY_BY_DETAIL_KIND)
            ) {
              drop("non_fact_activity_detail_kind", {
                detail_kind: msg.detailKind,
                detail_kind_present: true,
              });
              return;
            }

            // Ingest dedup by (daemonInstanceId, launchId, clientSeq), with the
            // pre-carrier serverIngestEpoch/launchId key retained for compat.
            // Daemon-emitted activity messages can arrive out-of-order across
            // WS reconnects (a re-queued heartbeat can land after a newer
            // transition). Drop any whose clientSeq isn't strictly greater
            // than the highest seen for that server/runtime generation.
            // A new daemon process identity owns an independent sequence space.
            // New launchId also resets naturally, and server-controlled
            // starts/resets advance serverIngestEpoch so legacy/no-launch daemons
            // can reset after a deliberate new runtime generation. Daemons that
            // leave clientSeq unset retain pre-dedup behaviour.
            // (#engineering:72283cf7 task #340 PR B)
            if (typeof msg.clientSeq === "number") {
              const activityIngestKey = this.getActivityIngestSeqKey(
                msg.agentId,
                msg.launchId,
                msg.daemonInstanceId,
              );
              const lastSeen = this.lastClientSeqByActivityIngestKey.get(activityIngestKey);
              if (lastSeen !== undefined && msg.clientSeq <= lastSeen) {
                this.recordEvent("activity.ingest.dropped_stale_seq", {
                  clientSeq: msg.clientSeq,
                  lastSeen,
                  ...joinTraceAttrs,
                });
                drop("stale_client_seq", {
                  clientSeq: msg.clientSeq,
                  lastSeen,
                  // Lifecycle-v2 replay accounting (#460): a stale/duplicate
                  // clientSeq is the wire-level replay species; the in-window
                  // heartbeat replay species is classified at the accept path.
                  ...daemonActivityDropRowAttrs({
                    atMs: typeof msg.observedAtMs === "number" && Number.isFinite(msg.observedAtMs)
                      ? msg.observedAtMs
                      : this.clock.now(),
                    observationClass: "replayed",
                  }),
                });
                return;
              }
              this.lastClientSeqByActivityIngestKey.set(activityIngestKey, msg.clientSeq);
            }

            const resetMode = this.getResetMode(msg.agentId);
            const declaredActivity = msg.activityKind ?? msg.activity;
            const legacyActivity = declaredActivity === undefined
              ? undefined
              : normalizeActivity(declaredActivity, agent.status);
            const activitySignal = reduceDaemonActivitySignal({
              detailKind: msg.detailKind,
              legacyActivity,
            });
            const activity = activitySignal.activity;
            const detailKind = activitySignal.detailKind;
            const entries = rewriteDaemonActivityEntries(msg.entries, activitySignal);
            const state = buildAgentLifecycleStateSnapshot({
              dbStatus: agent.status,
              launchId: msg.launchId,
              machineId,
              machineReachability: "reachable",
              resetMode,
              // Sequenced-status daemons report state themselves; only legacy
              // daemons have it inferred from activity (RFC 069 §8).
              runtimeState: conn?.capabilities.has(DAEMON_CAPABILITY_SEQUENCED_STATUS)
                ? agent.runtimeState
                : legacyRuntimeStateFromActivity(activity),
            });
            const action = planActivitySignalAction({
              state,
            });
            // TODO(lifecycle-v2/daemon-protocol): replace the remaining legacy
            // `agent:activity` envelope with structured daemon events. The server
            // reducer above already owns canonical detailKind -> activityKind;
            // this adapter now only translates the accepted lifecycle envelope.
            const { event } = adaptDaemonActivityLifecycleEvent({
              serverId: agent.serverId,
              agentId: msg.agentId,
              machineId,
              launchId: msg.launchId,
              clientSeq: msg.clientSeq,
              currentStatus: agent.status,
              resetMode,
              activity,
              hasEntries: Boolean(entries?.length),
              runtimeError: msg.runtimeError,
              now: () => new Date(this.clock.now()),
            });
            if (action === "ignore") {
              const result = await applyAgentLifecycleProjectionPlan(
                reduceDaemonActivityLifecycle({
                  action,
                  event,
                  activity,
                  detail: msg.detail,
                  detailKind,
                  entries,
                  state,
                  // task #136: pass-through join keys for downstream Socket.IO
                  // emit. Server-internal dedup still happens above against
                  // `lastClientSeqByActivityIngestKey`; these are not the dedup keys.
                  ...(typeof msg.launchId === "string" ? { launchId: msg.launchId } : {}),
                  ...(typeof msg.clientSeq === "number" ? { clientSeq: msg.clientSeq } : {}),
                  ...(typeof msg.probeId === "string" ? { probeId: msg.probeId } : {}),
                  ...(typeof msg.producerFactId === "string" ? { producerFactId: msg.producerFactId } : {}),
                }),
                this.lifecycleProjectionWriterDeps(),
                span,
              );
              drop(
                agent.status === "stopped"
                  ? "agent_stopped"
                  : resetMode
                    ? "reset_window"
                    : "activity_plan_ignore",
                {
                  agentStatus: agent.status,
                  resetMode,
                  normalized_activity: activity,
                  activity_kind: activity,
                  detail_kind: detailKind,
                  activity_status: activity,
                  ...liveActivityRootTraceAttrs(result.liveActivityResult),
                },
              );
              return;
            }

            const kimiCircuitDecision = this.planKimiActivityCircuitBreaker({
              agent,
              activity,
              entries,
              launchId: msg.launchId,
              probeId: msg.probeId,
              now: this.clock.now(),
            });
            if (kimiCircuitDecision.action === "suppress") {
              drop("kimi_activity_circuit_breaker", {
                activity,
                launchId: msg.launchId ?? null,
                activity_kind: activity,
                detail_kind: detailKind,
                suppressedCount: kimiCircuitDecision.suppressedCount,
                normalized_activity: activity,
                activity_status: activity,
                ...liveActivityRootTraceAttrs(undefined),
              });
              return;
            }

            const acceptedAttrs: Record<string, unknown> = {
              activity,
              activity_kind: activity,
              detail_kind: detailKind,
              activity_signal_source: activitySignal.source,
              hasEntries: Boolean(entries?.length),
              ...joinTraceAttrs,
            };
            if (kimiCircuitDecision.aggregateSuppressedCount) {
              acceptedAttrs.kimiCircuitAggregateSuppressedCount =
                kimiCircuitDecision.aggregateSuppressedCount;
            }
            this.recordEvent("activity.ingest.accepted", acceptedAttrs);
            const shadowSnapshot = this.agentActivity.get(msg.agentId);
            const acceptedObservedAtMs = typeof msg.observedAtMs === "number" && Number.isFinite(msg.observedAtMs)
              ? msg.observedAtMs
              : this.clock.now();
            const acceptedObservationClass = classifyDaemonActivityObservation({
              declaredHeartbeat: typeof msg.isHeartbeat === "boolean" ? msg.isHeartbeat : null,
              incoming: {
                activity,
                detail: msg.detail,
                detailKind,
                hasEntries: Boolean(entries?.length),
                probeId: typeof msg.probeId === "string" ? msg.probeId : null,
              },
              lastAccepted: shadowSnapshot
                ? {
                    activity: shadowSnapshot.activity,
                    detail: shadowSnapshot.detail,
                    detailKind: shadowSnapshot.detailKind,
                    // Only the content axes of the last accepted signal
                    // participate in identity comparison.
                    hasEntries: false,
                  }
                : undefined,
            });

            // Lifecycle-v2 shadow verdict (task #460 PR-beta-2, trace-only).
            // Stateless: the arbitration state is built in place from the live
            // snapshot — no new store. `startingAffordance` is fed from the
            // production detailKind truth source (isStartingActivitySnapshot),
            // never inferred from a projection value. Oracle scope: per-step
            // divergence against the live projection, not trajectory
            // equivalence (#459 DoD). Zero behavior change: the verdict goes
            // to the span only.
            {
              this.recordEvent(
                "lifecycle_v2.shadow_verdict",
                buildLifecycleShadowVerdictAttrs(
                  shadowSnapshot
                    ? {
                        activity: shadowSnapshot.activity,
                        detail: shadowSnapshot.detail,
                        detailKind: shadowSnapshot.detailKind,
                        updatedAtMs: shadowSnapshot.observedAtMs ?? shadowSnapshot.updatedAt,
                      }
                    : undefined,
                  {
                    activity,
                    agentId: msg.agentId,
                    detailKind,
                    atMs: acceptedObservedAtMs,
                    // Launch-guard acceptance ran above, so the accepted
                    // launchId IS the current generation at this site; the
                    // stale-generation kernel path binds at the guard's
                    // reject path, not here.
                    currentLaunchGeneration: msg.launchId ?? null,
                    launchGeneration: msg.launchId ?? null,
                    observationClass: acceptedObservationClass,
                    probeIdPresent: typeof msg.probeId === "string",
                    site: "daemon_ingest",
                  },
                ),
              );
            }
            const currentRuntimeError = this.agentStateCache.get(msg.agentId)?.lastRuntimeError ?? agent.lastRuntimeError ?? null;
            // #688(b): a crash is durable typed authority only when it rides a valid
            // typed RuntimeErrorActivityDiagnostic carrier (normalized server-side).
            const normalizedTypedRuntimeError = normalizeRuntimeErrorActivityDiagnostic(
              (msg as { runtimeError?: RuntimeErrorActivityDiagnostic | Record<string, unknown> | null } | null)?.runtimeError ?? null,
            );
            const runtimeErrorAction = reduceRuntimeErrorActivityAction({
              signal: activitySignal,
              currentErrorPresent: currentRuntimeError !== null,
              isHeartbeat: msg.isHeartbeat,
              typedRuntimeCarrierPresent: normalizedTypedRuntimeError !== null,
            });
            // task #1116: capture the typed delivery-consumption carrier so the
            // snapshot write below can attach it. Observation only — no action.
            if (detailKind === "delivery_unconsumed") {
              const normalizedDeliveryConsumption = normalizeDeliveryConsumptionActivityDiagnostic(
                (msg as { deliveryConsumption?: DeliveryConsumptionActivityDiagnostic | Record<string, unknown> | null }).deliveryConsumption ?? null,
              );
              if (normalizedDeliveryConsumption) {
                this.pendingDeliveryConsumption.set(msg.agentId, normalizedDeliveryConsumption);
              } else {
                this.pendingDeliveryConsumption.delete(msg.agentId);
              }
              this.recordEvent("delivery_consumption.carrier", { present: normalizedDeliveryConsumption !== null });
            }
            // task #1123: same discipline for the typed spawn-failure reason on a
            // failed-start frame. Observation only — the reason picks web copy.
            if (detailKind === "runtime_unavailable") {
              const normalizedSpawnFailure = normalizeSpawnFailureActivityDiagnostic(
                (msg as { spawnFailure?: SpawnFailureActivityDiagnostic | Record<string, unknown> | null }).spawnFailure ?? null,
              );
              this.pendingSpawnFailure.set(msg.agentId, normalizedSpawnFailure);
              this.recordEvent("spawn_failure.carrier", { present: normalizedSpawnFailure !== null, reason: normalizedSpawnFailure?.reason });
              // task #1221: a start that failed for a reason retrying cannot fix
              // stops automatic wakes until a person restarts the agent or its
              // runtime configuration changes. Messages stay in the inbox.
              if (normalizedSpawnFailure && NON_RETRYABLE_SPAWN_FAILURE_REASONS.includes(normalizedSpawnFailure.reason)) {
                void this.blockWakesForNonRetryableStartFailure(
                  msg.agentId,
                  typeof msg.launchId === "string" ? msg.launchId : null,
                  normalizedSpawnFailure.reason,
                );
              }
            }
            const shouldPreserveVisibleRuntimeError = currentRuntimeError
              && runtimeErrorAction === "preserve"
              && (activity === "online" || activity === "working" || activity === "thinking");
            if (shouldPreserveVisibleRuntimeError) {
              this.recordEvent("runtime_error_state.preserved", {
                reason: activitySignal.source === "legacy_detail_kind_missing"
                  ? "weak_legacy_signal"
                  : msg.isHeartbeat !== false
                    ? "heartbeat_or_unclassified_frame"
                    : "non_progress_detail_kind",
                activity,
                detail_kind: detailKind,
                activity_signal_source: activitySignal.source,
              });
              if (msg.probeId) {
                this.handleActivityProbeResponse(msg.probeId);
                this.recordEvent("activity.probe.response_consumed", { probe_id_present: true });
              }
              span.end("ok", {
                attrs: {
                  outcome: "accepted",
                  normalized_activity: activity,
                  activity_status: activity,
                  has_entries: Boolean(entries?.length),
                  runtime_error_state_preserved: true,
                  activity_signal_source: activitySignal.source,
                  ...joinTraceAttrs,
                },
              });
              return;
            }
            const result = await applyAgentLifecycleProjectionPlan(
              reduceDaemonActivityLifecycle({
                action,
                // RFC 069 §8: sequenced-status daemons own agent state; activity is display only.
                activityDrivesInstanceState: !conn?.capabilities.has(DAEMON_CAPABILITY_SEQUENCED_STATUS),
                event,
                activity,
                detail: msg.detail,
                detailKind,
                entries,
                state,
                observedAtMs: acceptedObservedAtMs,
                observationClass: acceptedObservationClass,
                // task #136: pass-through join keys for downstream Socket.IO
                // emit. This is the accepted-path branch — the one that
                // actually produces the live socket payload. Without this
                // the keys are dropped before emit and feedback-export
                // bundles classify every fresh activity row as
                // `join_key_missing`. (Stone's BLOCKER review on PR #3257.)
                ...(typeof msg.launchId === "string" ? { launchId: msg.launchId } : {}),
                ...(typeof msg.clientSeq === "number" ? { clientSeq: msg.clientSeq } : {}),
                ...(typeof msg.probeId === "string" ? { probeId: msg.probeId } : {}),
                ...(typeof msg.producerFactId === "string" ? { producerFactId: msg.producerFactId } : {}),
                ...(typeof msg.isHeartbeat === "boolean" ? { isHeartbeat: msg.isHeartbeat } : {}),
              }),
              this.lifecycleProjectionWriterDeps(),
              span,
            );
            if (runtimeErrorAction === "set") {
              await this.rememberRuntimeError(msg.agentId, this.buildRuntimeErrorState({
                detail: msg.detail,
                launchId: msg.launchId,
                typed: normalizedTypedRuntimeError,
              }));
              this.recordEvent("runtime_error_state.persisted", {
                action_required: true,
                source: activitySignal.source,
                detail_kind: detailKind,
              });
            } else if (runtimeErrorAction === "clear") {
              await this.clearLastRuntimeError(msg.agentId);
              this.recordEvent("runtime_error_state.cleared", {
                reason: "strong_typed_runtime_progress",
                detail_kind: detailKind,
              });
            }
            if (result.liveActivityResult) {
              this.recordEvent("status.read_model.updated", {
                from: result.liveActivityResult.previousActivity ?? null,
                to: result.liveActivityResult.nextActivity ?? activity,
              });
            }
            if (result.liveActivityResult?.action === "persist-and-emit-now") {
              this.recordEvent("activity.log.persist_scheduled", {
                entryCount: result.liveActivityResult.persistedEntryCount ?? 0,
              });
            } else {
              this.recordEvent("activity.log.persist_skipped", {
                reason: result.liveActivityResult?.action === "kernel-preserve"
                  ? "kernel_preserve"
                  : result.liveActivityResult?.action === "heartbeat-refresh"
                    ? "heartbeat_refresh"
                    : result.liveActivityResult?.action === "probe-refresh"
                      ? "probe_refresh"
                      : "debounce_only",
              });
            }
            // If this activity is the daemon's response to a server-issued
            // `agent:activity_probe`, cancel the pending fallback timer.
            // The activity broadcast above already updated agent state and
            // pushed to clients; the fallback's job (synth-online) is
            // moot. Lifecycle-dropped messages skip this — that's
            // intentional, the fallback should still fire if the
            // probe response was rejected. (#engineering:72283cf7 #340 PR A)
            if (msg.probeId) {
              this.handleActivityProbeResponse(msg.probeId);
              this.recordEvent("activity.probe.response_consumed", { probe_id_present: true });
            }
            span.end("ok", {
              attrs: {
                outcome: "accepted",
                normalized_activity: activity,
                activity_status: activity,
                has_entries: Boolean(entries?.length),
                activity_log_action: result.liveActivityResult?.action ?? "none",
                activity_log_entry_count: result.liveActivityResult?.persistedEntryCount ?? 0,
                ...joinTraceAttrs,
                ...liveActivityRootTraceAttrs(result.liveActivityResult),
              },
            });
          } catch (err) {
            this.recordEvent("activity.ingest.failed", {
              error_class: errorClassOf(err),
            });
            span.end("error");
            throw err;
          }
        });
        break;
      }

      case "agent:session": {
        const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
        if (!agent) {
          break;
        }
        if (!this.shouldAcceptLifecycleEvent(machineId, agent, msg.type, msg.launchId)) {
          break;
        }
        this.acknowledgePendingAgentStartFromLifecycle(
          msg.agentId,
          msg.launchId,
          "agent_session",
        );
        const resetMode = this.getResetMode(msg.agentId);
        const state = buildAgentLifecycleStateSnapshot({
          dbStatus: agent.status,
          launchId: msg.launchId,
          machineId,
          machineReachability: "reachable",
          resetMode,
          runtimeState: "running_idle",
          sessionId: agent.sessionId,
        });
        const action = planSessionSignalAction({ state });
        // TODO(lifecycle-v2/daemon-protocol): replace legacy `agent:session`
        // ingestion with canonical runtime_ready/session_init or session_resync
        // events. The daemon producer should include launchId and reconnect/
        // connection-window identity so the server does not infer readiness
        // solely from session presence.
        const { event } = adaptDaemonSessionLifecycleEvent({
          serverId: agent.serverId,
          agentId: msg.agentId,
          machineId,
          launchId: msg.launchId,
          currentStatus: agent.status,
          resetMode,
          now: () => new Date(this.clock.now()),
        });
        try {
          const result = await applyAgentLifecycleProjectionPlan(
            reduceDaemonSessionLifecycle({
              action,
              event,
              sessionId: msg.sessionId,
              state,
            }),
            this.lifecycleProjectionWriterDeps(),
          );
          if (action === "persist-active-session") {
            if (result.dbStatusApplied === false) {
              this.agentStateCache.delete(msg.agentId);
            } else {
              await this.clearLastRuntimeError(msg.agentId);
              this.broadcastAgentSession(agent.serverId, msg.agentId, msg.sessionId);
              if (msg.launchId) {
                await this.recoverDurableMentionDeliveriesForAgent(msg.agentId, {
                  machineId,
                  launchId: msg.launchId,
                  sessionId: msg.sessionId,
                });
              }
            }
          }
        } catch (err) {
          console.error(`[Machine ${machineId}] Failed to update agent ${msg.agentId} session:`, err);
        }
        break;
      }

      case "agent:session:invalidate": {
        const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
        if (!agent) {
          break;
        }
        if (!this.shouldAcceptLifecycleEvent(machineId, agent, msg.type, msg.launchId)) {
          break;
        }
        const invalidated = await this.invalidatePersistedAgentSessionFromSignal(msg.agentId, msg.sessionId, machineId);
        if (invalidated) {
          this.updateCache(msg.agentId, { sessionId: null });
          this.broadcastAgentSession(agent.serverId, msg.agentId, null);
        }
        break;
      }

      case "agent:runtime_profile": {
        const scopedTracer = createTraceScopeTracer(this.tracer, {
          actor: {
            serverId: conn?.serverId ?? undefined,
            agentId: msg.agentId,
            machineId,
            launchId: msg.launchId,
            sessionId: runtimeProfileSessionId(msg.facts.sessionRef),
          },
        });
        const span = scopedTracer.startSpan("server.runtime_profile.report.ingest", {
          parent: parseTraceparent(msg.traceparent),
          surface: "server",
          kind: "consumer",
          attrs: {
            // Actor identity comes from the typed TraceScope projection so every
            // early-return keeps the same closed identity contract.
            event_kind: "runtime_profile",
            runtime: msg.facts.runtime,
            report_source: normalizeRuntimeProfileReportSource(msg.source),
            model_present: Boolean(msg.facts.model),
            session_ref_present: Boolean(msg.facts.sessionRef),
            workspace_ref_present: Boolean(msg.facts.workspaceRef || msg.facts.workspacePathRef),
          },
        });
        await runWithTraceSpan(span, async () => {
          const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
          if (!agent) {
            span.end("ok", { attrs: { outcome: "invalid-agent", reason: "invalid_agent" } });
            return;
          }
          if (!this.shouldAcceptLifecycleEvent(machineId, agent, msg.type, msg.launchId)) {
            span.end("ok", { attrs: { outcome: "stale-launch", reason: "stale_launch" } });
            return;
          }
          if (msg.facts.runtime === "kimi") {
            span.end("ok", { attrs: { outcome: "skipped-kimi-runtime", reason: "unsupported_runtime" } });
            return;
          }
          const context = await agentRuntimeProfileService.loadAgentRuntimeProfileContext(msg.agentId);
          if (!context) {
            console.warn(`[Machine ${machineId}] Dropping runtime profile report for ${msg.agentId}: missing runtime profile context`);
            span.end("ok", { attrs: { outcome: "missing-context", reason: "missing_context" } });
            return;
          }
          try {
            await agentRuntimeProfileService.recordAgentRuntimeProfile({
              serverId: agent.serverId,
              agentId: msg.agentId,
              machineId,
              daemonVersion: conn?.daemonVersion ?? context.machine.daemonVersion ?? null,
              facts: msg.facts,
            });
            span.end("ok", { attrs: { outcome: "recorded", reason: "profile_recorded" } });
          } catch (err) {
            console.error(`[Machine ${machineId}] Failed to record runtime profile for ${msg.agentId}:`, err);
            span.end("error", { attrs: { outcome: "record-failed", reason: "record_failed", error_class: errorClassOf(err) } });
          }
        }, scopedTracer);
        break;
      }

      case "agent:runtime_profile:migration:ack": {
        const span = this.tracer.startSpan("server.runtime_profile.control.inject_ack", {
          parent: parseTraceparent(msg.traceparent),
          surface: "server",
          kind: "consumer",
          attrs: {
            event_kind: "runtime_profile",
            agent_id: msg.agentId,
            machine_id: machineId,
            server_id: conn?.serverId,
            launch_id: msg.launchId,
            agent_id_present: Boolean(msg.agentId),
            machine_id_present: Boolean(machineId),
            launch_id_present: Boolean(msg.launchId),
            control_kind: "migration",
            key_present: Boolean(msg.migrationKey),
          },
        });
        await this.runInActiveSpan(span, async () => {
          const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
          if (!agent) {
            span.end("ok", { attrs: { outcome: "invalid-agent", reason: "invalid_agent" } });
            return;
          }
          if (!this.shouldAcceptLifecycleEvent(machineId, agent, msg.type, msg.launchId)) {
            span.end("ok", { attrs: { outcome: "stale-launch", reason: "stale_launch" } });
            return;
          }
          try {
            await agentRuntimeProfileService.markRuntimeProfileMigrationDelivered(msg.agentId, msg.migrationKey, msg.launchId || null);
            span.end("ok", { attrs: { outcome: "delivered", reason: "ack_delivered" } });
          } catch (err) {
            console.error(`[Machine ${machineId}] Failed to mark runtime profile migration delivered ${msg.migrationKey} for ${msg.agentId}:`, err);
            span.end("error", { attrs: { outcome: "mark-failed", reason: "mark_failed", error_class: errorClassOf(err) } });
          }
        });
        break;
      }

      case "agent:runtime_profile:migration_done": {
        const span = this.tracer.startSpan("server.runtime_profile.migration_done", {
          parent: parseTraceparent(msg.traceparent),
          surface: "server",
          kind: "consumer",
          attrs: {
            event_kind: "runtime_profile",
            agent_id: msg.agentId,
            machine_id: machineId,
            server_id: conn?.serverId,
            launch_id: msg.launchId,
            agent_id_present: Boolean(msg.agentId),
            machine_id_present: Boolean(machineId),
            launch_id_present: Boolean(msg.launchId),
            key_present: Boolean(msg.migrationKey),
            source: "daemon",
          },
        });
        await this.runInActiveSpan(span, async () => {
          const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
          if (!agent) {
            span.end("ok", { attrs: { outcome: "invalid-agent", reason: "invalid_agent" } });
            return;
          }
          if (!this.shouldAcceptLifecycleEvent(machineId, agent, msg.type, msg.launchId)) {
            span.end("ok", { attrs: { outcome: "stale-launch", reason: "stale_launch" } });
            return;
          }
          try {
            const handled = await agentRuntimeProfileService.markRuntimeProfileMigrationHandled(msg.agentId, msg.migrationKey, msg.launchId || null);
            if (handled) {
              await this.deliverPendingRuntimeProfileMigration(machineId, agent, msg.launchId);
            }
            span.end("ok", { attrs: { outcome: handled ? "handled" : "not-handled", reason: handled ? "migration_handled" : "no_matching_migration" } });
          } catch (err) {
            console.error(`[Machine ${machineId}] Failed to mark runtime profile migration handled ${msg.migrationKey} for ${msg.agentId}:`, err);
            span.end("error", { attrs: { outcome: "handle-failed", reason: "handle_failed", error_class: errorClassOf(err) } });
          }
        });
        break;
      }

      case "agent:runtime_profile:daemon_release_notice:ack": {
        const span = this.tracer.startSpan("server.runtime_profile.control.inject_ack", {
          parent: parseTraceparent(msg.traceparent),
          surface: "server",
          kind: "consumer",
          attrs: {
            event_kind: "runtime_profile",
            agent_id: msg.agentId,
            machine_id: machineId,
            server_id: conn?.serverId,
            launch_id: msg.launchId,
            agent_id_present: Boolean(msg.agentId),
            machine_id_present: Boolean(machineId),
            launch_id_present: Boolean(msg.launchId),
            control_kind: "daemon_release_notice",
            key_present: Boolean(msg.noticeKey),
          },
        });
        await this.runInActiveSpan(span, async () => {
          const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
          if (!agent) {
            span.end("ok", { attrs: { outcome: "invalid-agent", reason: "invalid_agent" } });
            return;
          }
          if (!this.shouldAcceptLifecycleEvent(machineId, agent, msg.type, msg.launchId)) {
            span.end("ok", { attrs: { outcome: "stale-launch", reason: "stale_launch" } });
            return;
          }
          try {
            await agentRuntimeProfileService.markRuntimeProfileMigrationDelivered(msg.agentId, msg.noticeKey, msg.launchId || null);
            span.end("ok", { attrs: { outcome: "delivered", reason: "notice_ack_delivered" } });
          } catch (err) {
            console.error(`[Machine ${machineId}] Failed to ack runtime profile daemon release notice ${msg.noticeKey} for ${msg.agentId}:`, err);
            span.end("error", { attrs: { outcome: "mark-failed", reason: "mark_failed", error_class: errorClassOf(err) } });
          }
        });
        break;
      }

      case "agent:start:ack": {
        const pending = this.pendingAgentStartAcks.get(msg.startDispatchId);
        const ackAttrs = {
          queue_state: msg.queueState,
          daemon_queue_depth: msg.queueDepth,
          daemon_queue_age_ms: msg.queueAgeMs,
        };
        if (!pending) {
          const terminalReason = this.terminalAgentStartDispatches.get(msg.startDispatchId);
          await this.runInTraceSpan(
            "server.agent.start_dispatch.ack",
            {
              kind: "consumer",
              parent: parseTraceparent(msg.traceparent),
              attrs: {
                agent_id: msg.agentId,
                machine_id: machineId,
                launch_id: msg.launchId,
                start_dispatch_id: msg.startDispatchId,
                queue_state: msg.queueState,
                queue_depth: msg.queueDepth,
                queue_age_ms: msg.queueAgeMs,
              },
            },
            async () => {},
            () => ({
              attrs: {
                outcome: terminalReason ? "ignored_terminal" : "unknown_dispatch",
                terminal_reason: terminalReason ?? null,
              },
            }),
          );
          break;
        }
        const identityMatches = pending.machineId === machineId
          && pending.msg.agentId === msg.agentId
          && pending.msg.launchId === msg.launchId;
        await this.runInTraceSpan(
          "server.agent.start_dispatch.ack",
          {
            kind: "consumer",
            parent: parseTraceparent(msg.traceparent ?? pending.msg.traceparent),
            attrs: {
              ...this.startDispatchTraceAttrs(pending),
              ...ackAttrs,
            },
          },
          async () => {
            if (identityMatches) {
              this.terminalizePendingAgentStart(msg.startDispatchId, "acked", "acked", ackAttrs);
            }
          },
          () => ({
            attrs: identityMatches
              ? { outcome: "acked", terminal_reason: "acked" }
              : { outcome: "rejected", terminal_reason: null, reason: "identity_mismatch" },
          }),
        );
        break;
      }

      case "agent:model-seen": {
        await this.runInTraceSpan(
          "server.agent.model_seen.ingest",
          {
            kind: "consumer",
            attrs: {
              agent_id: msg.agentId,
              machine_id: machineId,
              launch_id_present: Boolean(msg.launchId),
              items_count: msg.items.length,
            },
          },
          async (): Promise<TraceAttributes> => {
            const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
            if (!agent) return { outcome: "dropped", reason: "invalid_agent" };
            // A report from a launch the guard no longer expects describes a
            // process that is gone; it must not move the read position.
            if (this.getLifecycleEventAcceptanceAction(agent, msg.launchId) !== "accept") {
              return { outcome: "dropped", reason: "stale_launch" };
            }
            let advanced = 0;
            let unchanged = 0;
            // Each item costs reads and maybe a write; a daemon never sends more
            // than the cap in one report, so the rest is ignored (positions stay).
            const items = msg.items.slice(0, MODEL_SEEN_MAX_ITEMS_PER_REPORT);
            for (const item of items) {
              const result = await this.applyAgentModelSeen({
                agentId: msg.agentId,
                serverId: agent.serverId ?? null,
                channelId: item.channelId,
                seqs: item.seqs,
              });
              if (result.outcome === "advanced") advanced += 1;
              else unchanged += 1;
            }
            return {
              outcome: "applied",
              advanced_count: advanced,
              unchanged_count: unchanged,
              ignored_items_count: msg.items.length - items.length,
            };
          },
          (attrs) => ({ attrs }),
        );
        break;
      }

      case "agent:delivery:transition": {
        const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
        if (
          !agent
          || msg.mentionDelivery.machineId !== machineId
        ) {
          break;
        }
        if (
          msg.mentionDelivery.launchId !== agent.expectedLaunchId
          || msg.mentionDelivery.sessionId !== agent.sessionId
        ) {
          await mentionDeliveryOccurrenceService.recordMentionDeliveryIdentityDriftForIdentity({
            occurrenceId: msg.mentionDelivery.occurrenceId,
            agentId: msg.agentId,
            messageId: msg.mentionDelivery.messageId,
            identity: msg.mentionDelivery,
            stage: "stage_receipt",
          });
          break;
        }
        await mentionDeliveryOccurrenceService.recordMentionDeliveryDaemonTransition({
          occurrenceId: msg.mentionDelivery.occurrenceId,
          agentId: msg.agentId,
          messageId: msg.mentionDelivery.messageId,
          identity: msg.mentionDelivery,
          stage: msg.stage,
          outcome: msg.outcome,
        });
        break;
      }

      case "agent:wake:request": {
        await this.handleAgentWakeRequest(machineId, conn?.serverId ?? null, msg);
        break;
      }

      case "agent:runtime:outcome":
      case "agent:process_spawned":
      case "agent:process_exited":
      case "agent:start:outcome":
      case "agent:runtime:outcome_gap":
      case "agent:runtime:outcome_cross_instance_unknown": {
        await this.handleRuntimeOutcomeOutboxMessage(machineId, conn, msg);
        break;
      }

      case "agent:runtime:outcome_unreliable": {
        // RFC 071 outbox, best effort: the daemon's evidence for this agent may
        // be missing until a human start resolves it. Until the next `ready`,
        // `agent:runtime-outcome-v1` does not apply to the agent here.
        if (!conn || !this.runtimeOutcomeAckEnabled) break;
        const agent = await this.validateMachineAgentMessage(machineId, conn.serverId, msg.agentId, msg.type);
        if (!agent) break;
        (conn.runtimeOutcomeUnreliableAgents ??= new Set()).add(msg.agentId);
        this.recordEvent("terminal_breaker.outcome_unreliable", { agent_id: msg.agentId, daemon_instance_id: msg.daemonInstanceId });
        break;
      }

      case "agent:delivery:rejected": {
        await this.handleAgentDeliveryRejected(machineId, conn?.serverId ?? null, msg);
        break;
      }

      case "agent:delivery:terminal_error": {
        const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
        if (
          !agent
          || msg.mentionDelivery.machineId !== machineId
        ) {
          break;
        }
        if (
          msg.mentionDelivery.launchId !== agent.expectedLaunchId
          || msg.mentionDelivery.sessionId !== agent.sessionId
        ) {
          const terminal = await mentionDeliveryOccurrenceService.recordMentionDeliveryIdentityDriftForIdentity({
            occurrenceId: msg.mentionDelivery.occurrenceId,
            agentId: msg.agentId,
            messageId: msg.mentionDelivery.messageId,
            identity: msg.mentionDelivery,
            stage: "terminal_receipt",
            originalDaemonCode: msg.code,
          });
          if (terminal) this.clearPendingAgentDeliveryAck({
            agentId: msg.agentId,
            seq: terminal.deliveryPayload?.seq ?? 0,
            deliveryId: msg.mentionDelivery.occurrenceId,
          }, "terminal");
          break;
        }
        const terminal = await mentionDeliveryOccurrenceService.recordMentionDeliveryTerminalError({
          occurrenceId: msg.mentionDelivery.occurrenceId,
          agentId: msg.agentId,
          messageId: msg.mentionDelivery.messageId,
          identity: msg.mentionDelivery,
          code: msg.code,
        });
        if (terminal) this.clearPendingAgentDeliveryAck({
          agentId: msg.agentId,
          seq: terminal.deliveryPayload?.seq ?? 0,
          deliveryId: msg.mentionDelivery.occurrenceId,
        }, "terminal");
        break;
      }

      case "agent:deliver:ack": {
        const span = this.tracer.startSpan("server.agent.delivery.ack", {
          parent: parseTraceparent(msg.traceparent),
          surface: "server",
          kind: "server",
          attrs: {
            agent_id: msg.agentId,
            machine_id: machineId,
            server_id: conn?.serverId,
            agent_id_present: Boolean(msg.agentId),
            machine_id_present: Boolean(machineId),
            deliveryId: msg.deliveryId,
            delivery_correlation_id: msg.deliveryId,
            seq: msg.seq,
            ...projectMachineConnectTraceAttrs(conn?.traceContext ?? buildRuntimeTraceContext()),
          },
        });
        await this.runInActiveSpan(span, async () => {
          this.recordEvent("server.ack.received", {
            outcome: "received",
            reason: "daemon_delivery_ack",
            seq: msg.seq,
            deliveryId: msg.deliveryId,
          });
          const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
          if (!agent) {
            span.end("ok", {
              attrs: {
                outcome: "invalid-agent",
                reason: "invalid_agent",
              },
            });
            return;
          }
          if (msg.mentionDelivery) {
            if (
              msg.mentionDelivery.machineId !== machineId
            ) {
              span.end("ok", { attrs: { outcome: "identity-mismatch", reason: "mention_identity_mismatch" } });
              return;
            }
            if (
              msg.mentionDelivery.launchId !== agent.expectedLaunchId
              || msg.mentionDelivery.sessionId !== agent.sessionId
            ) {
              const terminal = await mentionDeliveryOccurrenceService.recordMentionDeliveryIdentityDriftForIdentity({
                occurrenceId: msg.mentionDelivery.occurrenceId,
                agentId: msg.agentId,
                messageId: msg.mentionDelivery.messageId,
                identity: msg.mentionDelivery,
                stage: "ack_receipt",
              });
              if (terminal) this.clearPendingAgentDeliveryAck({
                agentId: msg.agentId,
                seq: terminal.deliveryPayload?.seq ?? 0,
                deliveryId: msg.mentionDelivery.occurrenceId,
              }, "terminal");
              span.end("ok", { attrs: { outcome: "identity-drift", reason: "mention_identity_drift" } });
              return;
            }
            const durableAck = await mentionDeliveryOccurrenceService.recordMentionDeliveryAck({
              occurrenceId: msg.mentionDelivery.occurrenceId,
              agentId: msg.agentId,
              messageId: msg.mentionDelivery.messageId,
              identity: msg.mentionDelivery,
            });
            if (!durableAck) {
              span.end("ok", { attrs: { outcome: "durable-ack-rejected", reason: "mention_ack_not_joinable" } });
              return;
            }
          }
          const pendingCleared = this.clearPendingAgentDeliveryAck(msg, "acked");
          const ackResult = this.acknowledgeDeliveredMessages(msg.agentId, [msg.seq]);
          if (ackResult.removedCount > 0) {
            this.recordEvent("inbox.cleared", {
              outcome: "cleared",
              reason: "acknowledged_seq",
              action: "clear_inbox",
              removedCount: ackResult.removedCount,
            });
            const turnActiveWrite = this.recordDeliveryAckTurnActive(msg.agentId, agent, span);
            if (turnActiveWrite) {
              const turnActiveArbitration = turnActiveWrite.arbitration;
              this.recordEvent("turn_active.observed", {
                outcome: turnActiveWrite.action === "kernel-preserve" ? "preserved" : "applied",
                reason: "daemon_delivery_ack",
                activity: turnActiveWrite.nextActivity,
                activity_log_action: turnActiveWrite.action,
                activity_log_entry_count: turnActiveWrite.persistedEntryCount,
                arbitration_reason: turnActiveArbitration?.reason,
                arbitration_action: turnActiveArbitration?.verdictAction,
              });
            }
          } else if (pendingCleared) {
            this.recordEvent("pending_delivery.cleared", {
              outcome: "cleared",
              reason: "delivery_acknowledged",
              action: "clear_pending_delivery",
            });
          } else {
            this.recordEvent("inbox.clear.noop", {
              outcome: "noop",
              reason: "seq_not_pending",
              action: "clear_inbox",
            });
          }
          span.end("ok", {
            attrs: {
              outcome: ackResult.removedCount > 0 ? "cleared-inbox" : "noop",
              reason: ackResult.removedCount > 0 ? "acknowledged_seq" : "seq_not_pending",
              ack_result: ackResult.removedCount > 0 ? "acknowledged_seq" : "seq_not_pending",
            },
          });
        });
        break;
      }

      case "reminder.armed": {
        const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
        if (!agent) break;
        const sourceId = msg.reminderId;
        const traceAttrs = protocolSourceTraceAttrs({
          ownerAgentId: msg.agentId,
          sourceId,
          version: msg.version,
          messageType: msg.type,
        });
        await this.runAppSourceReceipt(
          { ...traceAttrs, machine_id: machineId, server_id: agent.serverId, agent_id: agent.id, receipt_type: msg.type },
          async (setReceiptOutcome) => {
            try {
              const recorded = await reminderService.recordReminderArmed(
                sourceId,
                msg.agentId,
                msg.version,
              );
              setReceiptOutcome(
                {
                  outcome: recorded ? "recorded" : "not_recorded",
                  ...(!recorded ? { reason: "identity_mismatch_or_missing" } : {}),
                },
                recorded ? "ok" : "error",
              );
            } catch (err) {
              setReceiptOutcome({
                outcome: "record_failed",
                reason: "record_reminder_armed_threw",
                error_class: errorClassOf(err),
              }, "error");
              console.error(`[Machine ${machineId}] Failed to record reminder arm ${sourceId}:`, err);
            }
          },
        );
        break;
      }

      case "reminder.arm_rejected": {
        const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
        if (!agent) break;
        const sourceId = msg.reminderId;
        const traceAttrs = protocolSourceTraceAttrs({
          ownerAgentId: msg.agentId,
          sourceId,
          version: msg.version,
          messageType: msg.type,
        });
        await this.runAppSourceReceipt(
          { ...traceAttrs, machine_id: machineId, server_id: agent.serverId, agent_id: agent.id, receipt_type: msg.type },
          async (setReceiptOutcome) => {
            try {
              const recorded = await reminderService.markReminderNotArmed(
                sourceId,
                msg.agentId,
                msg.version,
              );
              setReceiptOutcome(
                {
                  outcome: recorded ? "recorded" : "not_recorded",
                  reason: recorded ? msg.reason : "identity_mismatch_or_missing",
                },
                recorded ? "ok" : "error",
              );
            } catch (err) {
              setReceiptOutcome({
                outcome: "record_failed",
                reason: "mark_reminder_not_armed_threw",
                error_class: errorClassOf(err),
              }, "error");
              console.error(`[Machine ${machineId}] Failed to record reminder arm rejection ${sourceId}:`, err);
            }
          },
        );
        break;
      }

      case "reminder.fire_receipt": {
        const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
        if (!agent) break;
        const sourceId = msg.reminderId;
        const traceAttrs = protocolSourceTraceAttrs({
          ownerAgentId: msg.agentId,
          sourceId,
          version: msg.version,
          messageType: msg.type,
        });
        await this.runAppSourceReceipt(
          { ...traceAttrs, machine_id: machineId, server_id: agent.serverId, agent_id: agent.id, receipt_type: msg.type },
          async (setReceiptOutcome) => {
            try {
              const existing = await reminderService.getReminderById(sourceId);
              const action = planReminderFireReceiptAction({
                reminderExists: existing !== null,
                reminderServerMatchesAgent: existing?.serverId === agent.serverId,
                reminderOwnerAgentId: existing?.ownerAgentId ?? null,
                reminderVersion: existing?.version ?? 0,
                reminderStatus: existing?.status ?? "missing",
                receiptAgentId: msg.agentId,
                receiptVersion: msg.version,
              });
              if (action === "reject" && (!existing || existing.serverId !== agent.serverId)) {
                setReceiptOutcome({
                  outcome: "rejected",
                  reason: "server_mismatch_or_missing",
                }, "error");
                console.warn(`[Machine ${machineId}] reminder.fire_receipt server mismatch or missing reminder ${sourceId}`);
                return;
              }
              if (action === "reject") {
                setReceiptOutcome({
                  outcome: "rejected",
                  reason: "owner_or_revision_mismatch",
                }, "error");
                console.warn(`[Machine ${machineId}] reminder.fire_receipt owner mismatch for current revision ${sourceId}`);
                return;
              }
              if (action === "converge-current") {
                const result = await reminderService.fireReminder(sourceId, msg.version, { catchup: msg.catchup });
                // `result.ok`, NOT truthiness: a refusal is now an object and would
                // pass a bare `if (result)`, sending us into the success branch with
                // an undefined row.
                //
                // Wording is deliberately generic: this layer routes fire receipts
                // for any app and has no business naming one, which is exactly what
                // the app-name ratchet enforces. The FIELDS are the reviewed
                // observability surface (@Huaihuai) and must all survive -- the
                // owning service only logs the premature case, and machineId does
                // not exist down there at all.
                if (!result.ok) {
                  console.warn(
                    `[Machine ${machineId}] scheduled fire refused for ${sourceId}: `
                    + `reason=${result.reason} now=${result.now.toISOString()} `
                    + `dueAt=${result.fireAt?.toISOString() ?? "unknown"}`,
                  );
                } else {
                  const fired = result.row;
                  if (shouldEmitReminderFiredLifecycle(result)) {
                    this.io?.to(`server:${fired.serverId}`).emit("reminder:fired", {
                      reminderId: fired.id,
                      ownerAgentId: fired.ownerAgentId,
                      firedAt: fired.firedAt?.toISOString() ?? msg.firedAtClient,
                      catchup: result.catchup,
                      nextFireAt: result.nextFireAt?.toISOString() ?? null,
                    });
                  }
                  if (result.nextFireAt) {
                    await this.pushReminderUpsert(fired.ownerAgentId, fired);
                  } else {
                    await this.pushReminderCancel(fired.ownerAgentId, fired.id, fired.version);
                  }
                }
              }
              if (action === "ack-historical") {
                const acked = await this.sendToMachine(machineId, {
                  type: "reminder.fire_receipt.ack",
                  agentId: msg.agentId,
                  reminderId: sourceId,
                  version: msg.version,
                });
                setReceiptOutcome(
                  {
                    outcome: acked
                      ? "historical_ack_sent"
                      : "historical_ack_failed",
                    catchup: msg.catchup,
                  },
                  acked ? "ok" : "error",
                );
                return;
              }
              const converged = await reminderService.getReminderById(sourceId);
              if (converged && converged.serverId === agent.serverId && converged.version > msg.version) {
                const acked = await this.sendToMachine(machineId, {
                  type: "reminder.fire_receipt.ack",
                  agentId: msg.agentId,
                  reminderId: sourceId,
                  version: msg.version,
                });
                setReceiptOutcome(
                  {
                    outcome: acked ? "converged_ack_sent" : "converged_ack_failed",
                    ...(acked ? {} : { reason: "machine_unreachable" }),
                    catchup: msg.catchup,
                  },
                  acked ? "ok" : "error",
                );
              } else {
                setReceiptOutcome({
                  outcome: "converged_without_ack",
                  catchup: msg.catchup,
                });
              }
            } catch (err) {
              setReceiptOutcome({
                outcome: "convergence_failed",
                reason: "reminder_convergence_threw",
                error_class: errorClassOf(err),
              }, "error");
              console.error(`[Machine ${machineId}] Failed to converge reminder receipt ${sourceId}:`, err);
            }
          },
        );
        break;
      }

      case "reminder.snapshot.request": {
        const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
        if (!agent) break;
        const composition = await composeReminderSnapshot(msg.agentId);
        await this.deliverBuiltInAppSnapshot({
          machineId,
          messageType: "reminder.snapshot",
          spanName: "server.app_source.transport",
          composition,
          buildMessage: (reminders) => ({
            type: "reminder.snapshot",
            agentId: msg.agentId,
            reminders,
          }),
        });
        break;
      }

      case "app_config.snapshot.request": {
        const agent = await this.validateMachineAgentMessage(
          machineId,
          conn?.serverId ?? null,
          msg.agentId,
          msg.type,
        );
        if (!agent) break;
        const composition = await listBuiltInAppConfigSnapshotsForAgent({
          serverId: agent.serverId,
          ownerAgentId: msg.agentId,
        });
        await this.deliverBuiltInAppSnapshot({
          machineId,
          messageType: "app_config.snapshot",
          spanName: "server.app_config.transport",
          composition,
          buildMessage: (configs) => ({
            type: "app_config.snapshot",
            agentId: msg.agentId,
            configs,
          }),
        });
        break;
      }

      case "agent:skills:list_result":
        this.observeAgentSkillsListResult(machineId, msg);
        this.emit(`machine:response:${machineId}`, msg);
        break;

      case "agent:workspace:file_tree":
      case "agent:workspace:file_content":
      case "agent:workspace:wiki_ensured":
      case "machine:workspace:scan_result":
      case "machine:workspace:delete_result":
      case "machine:migration:source_workspace_archive_result":
      case "machine:runtime_models:result":
      case "machine:provider_probe:result":
      case "agent:diagnostic:session_transcript_result":
      case "agent:diagnostic:feedback_transcript_result":
        if (msg.type === "agent:diagnostic:feedback_transcript_result") this.observeLateFeedbackTranscriptResult(machineId, msg);
        // These are responses to workspace/machine/diagnostic requests — emit events for pending promises
        this.emit(`machine:response:${machineId}`, msg);
        if (
          msg.type === "machine:runtime_models:result"
          || msg.type === "machine:migration:source_workspace_archive_result"
          || msg.type === "machine:provider_probe:result"
        ) {
          void this.getMachineResponseRelay().forward(machineId, msg,
            (event, attrs) => this.recordMachineResponseRelay(event, attrs));
        }
        break;
    }
  }

  /**
   * RFC 071 part 3: commit the frame (breaker state + outbox watermark, one
   * compare-and-set), then ack it on the machine. Nothing while the ack
   * capability is not advertised. A frame for an agent this machine does not
   * own, a held frame, or a failed commit gets no ack: the daemon keeps it.
   */
  private async handleRuntimeOutcomeOutboxMessage(
    machineId: string,
    conn: MachineConnection | undefined,
    msg: RuntimeOutcomeOutboxMessage,
  ): Promise<void> {
    if (!this.runtimeOutcomeAckEnabled) return;
    const agent = await this.validateMachineAgentMessage(machineId, conn?.serverId ?? null, msg.agentId, msg.type);
    if (!agent) return;
    const result = await ingestRuntimeOutcomeOutboxMessage(
      {
        applyOutboxFrame: (agentId, frame, input) => this.terminalFailureBreaker.applyOutboxFrame(agentId, frame, input),
        applyOutcomeMarker: (agentId, marker, input) => this.terminalFailureBreaker.applyOutcomeMarker(agentId, marker, input),
        send: (message) => this.sendToMachine(machineId, message),
      },
      msg,
      {
        nowMs: this.clock.now(),
        // Unknown here: an E1 that opens the breaker owes every unread row (the conservative side).
        unreadCeilings: null,
        persistedSessionId: agent.sessionId,
      },
    );
    if (result.kind === "commit_failed") {
      console.warn(`[Machine ${machineId}] RFC 071 outbox ${msg.type} for agent ${msg.agentId} not committed; not acked, the daemon resends:`, result.error);
      return;
    }
    // RFC 071 §9: a frame that opened the breaker shows the pause once. A
    // needs-manual block is shown when it refuses a wake (the agent may still
    // be running when the evidence of an earlier process is found lost).
    if (result.kind === "acked" && !result.duplicate) await this.projectTerminalBlock(msg.agentId, { includeNeedsManual: false });
  }

  private refreshReplicaLivenessFromDaemonIngress(
    machineId: string,
    conn: MachineConnection | undefined,
    messageType: MachineToServerMessage["type"],
  ) {
    if (!conn || !this.replicaStateStore.isAvailable()) return;
    if (messageType === "pong") return;

    const now = this.clock.now();
    const last = this.lastIngressReplicaRefreshAt.get(machineId);
    if (last !== undefined && now - last < AgentOrchestrator.INGRESS_REPLICA_REFRESH_MIN_INTERVAL_MS) {
      return;
    }
    this.lastIngressReplicaRefreshAt.set(machineId, now);

    this.replicaStateStore
      .refreshMachineReplica(
        machineId,
        conn.traceContext ?? buildRuntimeTraceContext(),
        conn.replicaGeneration ?? undefined,
      )
      .catch(() => {});
  }

  /**
   * Push a reminder to the daemon that owns the agent. Best-effort: if the
   * machine is offline, the daemon will request a snapshot on reconnect.
   */
  async pushReminderUpsert(agentId: string, row: reminderService.ReminderRow): Promise<boolean> {
    const outgoing = {
      type: "reminder.upsert",
      agentId,
      reminder: reminderService.toReminderJob(row),
    } satisfies ServerToMachineMessage;
    const agent = await agentService.getAgent(agentId, false, {
      dbCallsite: "agent_orchestrator.reminder_push",
    });
    return this.sendAppTransport({
      spanName: "server.app_source.transport",
      traceAttrs: protocolSourceTraceAttrs({
        ownerAgentId: agentId,
        sourceId: row.id,
        version: row.version,
        messageType: outgoing.type,
      }),
      machineId: agent?.machineId ?? null,
      message: outgoing,
    });
  }

  /**
   * Push one typed app-config envelope to the agent's Computer (task #204).
   * Best-effort: an offline machine refills via app_config.snapshot.request on
   * reconnect, so a dropped push is recovered rather than silently lost.
   */
  async pushAppConfigUpsert(
    agentId: string,
    config: AppConfigWireSnapshot,
  ): Promise<boolean> {
    const agent = await agentService.getAgent(agentId, false, {
      dbCallsite: "agent_orchestrator.app_config_push",
    });
    return this.sendAppTransport({
      spanName: "server.app_config.transport",
      traceAttrs: appConfigTraceAttrs(config),
      machineId: agent?.machineId ?? null,
      message: {
        type: "app_config.upsert",
        agentId,
        config,
      },
    });
  }

  async pushReminderCancel(agentId: string, sourceId: string, version: number): Promise<boolean> {
    const outgoing = {
      type: "reminder.cancel",
      agentId,
      reminderId: sourceId,
      version,
    } satisfies ServerToMachineMessage;
    const agent = await agentService.getAgent(agentId, false, {
      dbCallsite: "agent_orchestrator.reminder_push",
    });
    return this.sendAppTransport({
      spanName: "server.app_source.transport",
      traceAttrs: protocolSourceTraceAttrs({
        ownerAgentId: agentId,
        sourceId,
        version,
        messageType: outgoing.type,
      }),
      machineId: agent?.machineId ?? null,
      message: outgoing,
    });
  }

  private async deliverPendingRuntimeProfileMigration(
    machineId: string,
    agent: CachedAgentState,
    launchId?: string,
  ): Promise<void> {
    await agentRuntimeProfileService.clearRuntimeProfileMigrationForReset(agent.id, launchId || null);

    const notice = await agentRuntimeProfileService.getPendingRuntimeProfileNotice(agent.id);
    if (!notice?.pendingKey) return;
    const span = this.tracer.startSpan("server.runtime_profile.control.delivery", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "producer",
      attrs: {
        event_kind: "runtime_profile",
        agent_id: agent.id,
        machine_id: machineId,
        server_id: agent.serverId,
        launch_id: agent.expectedLaunchId || launchId,
        agent_id_present: true,
        machine_id_present: true,
        launch_id_present: Boolean(agent.expectedLaunchId || launchId),
        control_kind: "daemon_release_notice",
        key_present: true,
        migration_status: notice.migrationStatus,
        pending_kind: notice.pendingKind,
        delivery_reason: "pending",
      },
    });
    const sent = await this.sendToMachine(machineId, {
      type: "agent:runtime_profile:daemon_release_notice",
      agentId: agent.id,
      noticeKey: notice.pendingKey,
      message: agentRuntimeProfileService.renderRuntimeProfileMigrationMessage(notice),
      launchId: agent.expectedLaunchId || launchId,
      traceparent: formatTraceparent(span.context),
    });
    span.end(sent ? "ok" : "error", { attrs: { outcome: sent ? "sent" : "send_failed", reason: sent ? "notice_sent" : "send_failed" } });
  }

  private async maybePiggybackRuntimeProfileMigrationNudge(
    machineId: string,
    agent: CachedAgentState,
    launchId?: string,
    options: { source?: "heartbeat" | "user_path"; nudgeIntervalMs?: number } = {},
  ): Promise<"sent" | "send_failed" | "not_online" | "no_candidate"> {
    const activity = this.agentActivity.get(agent.id);
    if (activity && activity.activity !== "online") return "not_online";

    const pending = await agentRuntimeProfileService.getRuntimeProfileMigrationNudgeCandidate(
      agent.id,
      new Date(this.clock.now()),
      AgentOrchestrator.RUNTIME_PROFILE_MIGRATION_NUDGE_AFTER_MS,
      options.nudgeIntervalMs ?? AgentOrchestrator.RUNTIME_PROFILE_MIGRATION_NUDGE_INTERVAL_MS,
      AgentOrchestrator.RUNTIME_PROFILE_MIGRATION_MAX_NUDGES,
    );
    if (!pending?.pendingKey) return "no_candidate";

    const span = this.tracer.startSpan("server.runtime_profile.control.delivery", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "producer",
      attrs: {
        event_kind: "runtime_profile",
        agent_id: agent.id,
        machine_id: machineId,
        server_id: agent.serverId,
        launch_id: agent.expectedLaunchId || launchId,
        agent_id_present: true,
        machine_id_present: true,
        launch_id_present: Boolean(agent.expectedLaunchId || launchId),
        control_kind: "migration",
        key_present: true,
        migration_status: pending.migrationStatus,
        pending_kind: pending.pendingKind,
        delivery_reason: options.source === "heartbeat" ? "heartbeat_nudge" : "user_path_nudge",
      },
    });
    const sent = await this.sendToMachine(machineId, {
      type: "agent:runtime_profile:migration",
      agentId: agent.id,
      migrationKey: pending.pendingKey,
      message: agentRuntimeProfileService.renderRuntimeProfileMigrationNudgeMessage(pending),
      launchId: agent.expectedLaunchId || launchId,
      traceparent: formatTraceparent(span.context),
    });
    if (sent) {
      await agentRuntimeProfileService.markRuntimeProfileMigrationNudged(agent.id, pending.pendingKey);
      if (options.source === "heartbeat") {
        this.runtimeProfileHeartbeatNudgeSentAt.set(this.runtimeProfileHeartbeatNudgeKey(machineId, agent.id), this.clock.now());
      }
      span.end("ok", { attrs: { outcome: "sent", reason: "nudge_sent" } });
      return "sent";
    }
    span.end("error", { attrs: { outcome: "send_failed", reason: "send_failed" } });
    return "send_failed";
  }

  private async maybePiggybackRuntimeProfileMigrationNudgesForMachine(machineId: string): Promise<void> {
    const activeAgents = [...this.agentStateCache.values()]
      .filter((agent) => agent.machineId === machineId && agent.status === "active");
    const disabled = readBooleanEnv("SLOCK_DISABLE_MIGRATION_NUDGE_PIGGYBACK");
    const cooldownMs = readPositiveIntegerEnv(
      "SLOCK_MIGRATION_NUDGE_PIGGYBACK_COOLDOWN_MS",
      AgentOrchestrator.RUNTIME_PROFILE_HEARTBEAT_NUDGE_COOLDOWN_MS,
    );
    const now = this.clock.now();
    const counts = {
      active_agents_count: 0,
      disabled_count: 0,
      cooldown_count: 0,
      sent_count: 0,
      send_failed_count: 0,
      no_candidate_count: 0,
      not_online_count: 0,
    };

    await this.runInTraceSpan(
      "server.runtime_profile.heartbeat_nudge.scan",
      {
        attrs: {
          event_kind: "runtime_profile",
          machine_id: machineId,
          machine_id_present: true,
          disabled,
          cooldown_ms: cooldownMs,
        },
      },
      async () => {
        for (const agent of activeAgents) {
          counts.active_agents_count += 1;
          const action = planRuntimeProfileHeartbeatNudgeAction({
            disabled,
            lastSentAt: this.runtimeProfileHeartbeatNudgeSentAt.get(this.runtimeProfileHeartbeatNudgeKey(machineId, agent.id)) ?? null,
            now,
            cooldownMs,
          });
          if (action === "disabled") {
            counts.disabled_count += 1;
            continue;
          }
          if (action === "cooldown") {
            counts.cooldown_count += 1;
            continue;
          }
          const outcome = await this.maybePiggybackRuntimeProfileMigrationNudge(machineId, agent, undefined, {
            source: "heartbeat",
            nudgeIntervalMs: cooldownMs,
          });
          if (outcome === "sent") counts.sent_count += 1;
          if (outcome === "send_failed") counts.send_failed_count += 1;
          if (outcome === "no_candidate") counts.no_candidate_count += 1;
          if (outcome === "not_online") counts.not_online_count += 1;
        }
      },
      () => ({
        attrs: {
          ...counts,
          outcome: counts.sent_count > 0 ? "sent" : "skipped",
          reason: disabled ? "disabled" : activeAgents.length === 0 ? "no_active_agents" : "scan_completed",
        },
      }),
    );
  }

  private runtimeProfileHeartbeatNudgeKey(machineId: string, agentId: string): string {
    return `${machineId}:${agentId}`;
  }

  async completeRuntimeProfileMigrationFromAgent(
    agentId: string,
    migrationKey: string,
    launchId?: string | null,
  ): Promise<boolean> {
    const span = this.tracer.startSpan("server.runtime_profile.migration_done", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "server",
      attrs: {
        event_kind: "runtime_profile",
        agent_id: agentId,
        launch_id: launchId ?? undefined,
        agent_id_present: Boolean(agentId),
        key_present: Boolean(migrationKey),
        launch_id_present: Boolean(launchId),
        source: "tool",
      },
    });
    const agent = await this.getCachedAgent(agentId);
    if (!agent?.machineId) {
      span.end("ok", { attrs: { outcome: "missing-agent-or-machine", reason: "missing_agent_or_machine" } });
      return false;
    }
    if (!this.shouldAcceptLifecycleEvent(agent.machineId, agent, "agent:runtime_profile:migration_done", launchId || undefined)) {
      span.end("ok", { attrs: { machine_id: agent.machineId, server_id: agent.serverId, outcome: "stale-launch", reason: "stale_launch" } });
      return false;
    }
    const machineId = agent.machineId;
    let handled = false;
    try {
      handled = await this.runInActiveSpan(span, async () => {
        const marked = await agentRuntimeProfileService.markRuntimeProfileMigrationHandled(
          agentId,
          migrationKey,
          launchId || null,
        );
        if (marked) {
          await this.deliverPendingRuntimeProfileMigration(machineId, agent, launchId || undefined);
        }
        return marked;
      });
    } catch (err) {
      span.end("error", { attrs: { machine_id: agent.machineId, server_id: agent.serverId, outcome: "handle-failed", reason: "handle_failed", error_class: errorClassOf(err) } });
      throw err;
    }
    span.end("ok", { attrs: { machine_id: agent.machineId, server_id: agent.serverId, outcome: handled ? "handled" : "not-handled", reason: handled ? "migration_handled" : "no_matching_migration" } });
    return handled;
  }

  private async flushRuntimeProfileGatedInbox(
    machineId: string,
    agent: CachedAgentState,
  ): Promise<void> {
    const inbox = this.agentInboxes.get(agent.id);
    if (!inbox || inbox.inbox.length === 0) return;
    const oldestMessageAgeMs = oldestInboxMessageAgeMs(inbox.inbox, this.clock.now());
    const span = this.tracer.startSpan("server.runtime_profile.gated_inbox.flush", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "producer",
      attrs: {
        event_kind: "runtime_profile",
        agent_id: agent.id,
        machine_id: machineId,
        server_id: agent.serverId,
        agent_id_present: Boolean(agent.id),
        machine_id_present: true,
        inbox_count: inbox.inbox.length,
        oldest_message_age_ms: oldestMessageAgeMs,
        oldest_message_age_bucket: durationMsBucket(oldestMessageAgeMs),
      },
    });
    let sentCount = 0;
    let sendFailedCount = 0;
    for (const message of [...inbox.inbox]) {
      const deliveryId = crypto.randomUUID();
      const sent = await this.sendAgentDeliveryWithAckRetry(machineId, {
        type: "agent:deliver",
        agentId: agent.id,
        message,
        seq: message.seq ?? 0,
        deliveryId,
        traceparent: formatTraceparent(span.context),
      }, `runtime profile gated inbox flush failed for agent ${agent.id}`);
      if (sent) {
        sentCount += 1;
      } else {
        sendFailedCount += 1;
      }
    }
    span.end(sendFailedCount > 0 ? "error" : "ok", {
      attrs: {
        sent_count: sentCount,
        send_failed_count: sendFailedCount,
        outcome: sendFailedCount > 0 ? "partial_failure" : "sent",
        reason: sendFailedCount > 0 ? "send_failed" : "gated_inbox_flushed",
      },
    });
  }

  /** Messages that are expected to fail silently (fire-and-forget during deploy transitions) */
  private static SILENT_SEND_TYPES = new Set(["ping", "agent:stop"]);

  protected getRoutableLocalMachineIds(): Set<string> {
    const localIds = new Set<string>();
    for (const [machineId, conn] of this.machineConnections.entries()) {
      if (conn.ws.readyState === 1) {
        localIds.add(machineId);
      }
    }
    return localIds;
  }

  protected async routeMachineCommandCrossReplica(
    machineId: string,
    msg: ServerToMachineMessage,
    localMachineIds: Set<string>,
  ): Promise<boolean | MachineCommandRouteResult> {
    return routeMachineCommandWithResult(machineId, msg, localMachineIds);
  }

  /** Re-emit a cross-replica external wake signal on the local emitter. */
  handleRoutedExternalWakeSignal(agentId: string): void {
    this.emit("external-inbox-delivered", agentId);
  }

  protected async publishExternalWakeSignalCrossReplica(agentId: string): Promise<void> {
    return publishExternalWakeSignal(agentId);
  }

  protected async routeInboxDeliveryCrossReplica(
    agentId: string,
    machineId: string,
    message: AgentMessage,
    localMachineIds: Set<string>,
  ): Promise<boolean> {
    return routeInboxDelivery(agentId, machineId, message, localMachineIds);
  }

  protected async routeInboxDeliveryWithReceiptCrossReplica(
    agentId: string,
    machineId: string,
    message: AgentMessage,
    localMachineIds: Set<string>,
    deliveryOptions: RoutedInboxDeliveryOptions,
  ): Promise<RoutedInboxDeliveryReceiptResult> {
    return routeInboxDeliveryWithReceipt(agentId, machineId, message, localMachineIds, deliveryOptions);
  }

  protected async sendToMachine(
    machineId: string,
    msg: ServerToMachineMessage,
    options: { onRouteResult?: (result: MachineCommandRouteResult) => void } = {},
  ): Promise<boolean> {
    const dispatch = async (): Promise<boolean> => {
      const conn = this.machineConnections.get(machineId);
      const hasReadyLocalConnection = Boolean(conn && conn.ws.readyState === 1);
      const action = planSendToMachineAction({
        hasReadyLocalConnection,
        canReroute: this.replicaStateStore.isAvailable(),
      });
      return this.applySendToMachineAction({
        action,
        machineId,
        msg,
        sendLocally: () => {
          if (!conn) return false;
          conn.ws.send(JSON.stringify(msg));
          return true;
        },
        reroute: () => this.routeMachineCommandCrossReplica(
          machineId,
          msg,
          this.getRoutableLocalMachineIds(),
        ),
        onRouteResult: options.onRouteResult,
      });
    };

    if (!failpoints.enabled) {
      return dispatch();
    }

    const result = await failpoints.hit<boolean>(
      "server.agentOrchestrator.sendToMachine.dispatch",
      { machineId, msgType: msg.type },
      dispatch,
    );
    return result ?? false;
  }

  protected async applySendToMachineAction(context: SendToMachineApplyContext): Promise<boolean> {
    if (context.action === "send-locally") {
      return context.sendLocally();
    }

    if (context.action === "reroute-then-warn") {
      try {
        const routeResult = await this.routeMachineCommand(context);
        context.onRouteResult?.(routeResult);
        if (routeResult.routed) return true;
      } catch (err: any) {
        console.error(`[ReplicaRouter] Failed to route to machine ${context.machineId}:`, err.message);
      }
    }

    if (!AgentOrchestrator.SILENT_SEND_TYPES.has(context.msg.type)) {
      console.warn(`[Machine ${context.machineId}] sendToMachine: no connection found (msg: ${context.msg.type})`);
    }
    return false;
  }

  private async routeMachineCommand(context: SendToMachineApplyContext): Promise<MachineCommandRouteResult> {
    const { machineId, msg } = context;
    const identityAttrs = {
      machine_id: machineId,
      ...("agentId" in msg && typeof msg.agentId === "string" ? { agent_id: msg.agentId } : {}),
    };
    return this.runInTraceSpan(
      "server.machine.command.route",
      {
        attrs: {
          ...identityAttrs,
          source: "sendToMachine",
          action: "route_machine_command",
          message_type: msg.type,
        },
      },
      async () => {
        const routeResult = normalizeMachineCommandRouteResult(await context.reroute());
        this.recordEvent("machine.command.route", {
          event_kind: "machine_command_route",
          outcome: routeResult.routed ? "routed" : "not_routed",
          reason: routeResult.reason,
          ...identityAttrs,
          ...projectMachineCommandRouteTraceAttrs(routeResult),
        });
        return routeResult;
      },
      (routeResult) => ({
        attrs: {
          outcome: routeResult.routed ? "routed" : "not_routed",
          reason: routeResult.reason,
          ...identityAttrs,
          ...projectMachineCommandRouteTraceAttrs(routeResult),
        },
      }),
    );
  }

  protected async sendRequiredToMachine(
    machineId: string,
    msg: ServerToMachineMessage,
    offlineMessage = "Machine WebSocket not ready",
  ): Promise<"local" | "cross_replica"> {
    let routeResult: MachineCommandRouteResult | undefined;
    const sent = await this.sendToMachine(machineId, msg, {
      onRouteResult: (result) => {
        routeResult = result;
      },
    });
    if (!sent) {
      throw new RouteFailureError("daemon_offline", offlineMessage);
    }
    return routeResult?.routed ? "cross_replica" : "local";
  }

  protected sendBestEffortToMachine(machineId: string, msg: ServerToMachineMessage, errorContext: string): void {
    void this.sendToMachine(machineId, msg).catch((err) => {
      console.warn(`[Machine ${machineId}] ${errorContext}:`, err);
    });
  }

  private pendingStartQueueDepth(machineId: string): number {
    let depth = 0;
    for (const pending of this.pendingAgentStartAcks.values()) {
      if (pending.machineId === machineId) depth += 1;
    }
    return depth;
  }

  private startDispatchTraceAttrs(pending: PendingAgentStartAck): Record<string, unknown> {
    return {
      agent_id: pending.msg.agentId,
      machine_id: pending.machineId,
      launch_id: pending.msg.launchId,
      start_dispatch_id: pending.msg.startDispatchId,
      agent_id_present: Boolean(pending.msg.agentId),
      machine_id_present: Boolean(pending.machineId),
      launch_id_present: Boolean(pending.msg.launchId),
      queue_age_ms: Math.max(0, this.clock.now() - pending.createdAt),
      queue_depth: this.pendingStartQueueDepth(pending.machineId),
      attempts: pending.attempts,
      last_attempt_at_ms: pending.lastAttemptAt,
      next_retry_at_ms: pending.nextRetryAt,
      parked: pending.parked,
    };
  }

  private rememberTerminalStartDispatch(
    startDispatchId: string,
    reason: AgentStartDispatchTerminalReason,
  ): void {
    this.terminalAgentStartDispatches.delete(startDispatchId);
    this.terminalAgentStartDispatches.set(startDispatchId, reason);
    while (
      this.terminalAgentStartDispatches.size
      > AgentOrchestrator.AGENT_START_TERMINAL_CACHE_SIZE
    ) {
      const oldest = this.terminalAgentStartDispatches.keys().next().value;
      if (typeof oldest !== "string") break;
      this.terminalAgentStartDispatches.delete(oldest);
    }
  }

  private terminalizePendingAgentStart(
    startDispatchId: string,
    reason: AgentStartDispatchTerminalReason,
    outcome: "acked" | "terminal" = reason === "acked" ? "acked" : "terminal",
    extraAttrs: Record<string, unknown> = {},
  ): PendingAgentStartAck | null {
    const pending = this.pendingAgentStartAcks.get(startDispatchId);
    if (!pending) return null;
    if (pending.timer) this.clock.clearTimeout(pending.timer);
    pending.timer = null;
    pending.nextRetryAt = null;
    const terminalTraceAttrs = this.startDispatchTraceAttrs(pending);
    this.pendingAgentStartAcks.delete(startDispatchId);
    this.rememberTerminalStartDispatch(startDispatchId, reason);
    this.recordEvent("server.agent.start_dispatch.terminal", {
      ...terminalTraceAttrs,
      outcome,
      terminal_reason: reason,
      ...extraAttrs,
    });
    return pending;
  }

  private clearPendingAgentStartsForAgent(
    agentId: string,
    reason: Extract<AgentStartDispatchTerminalReason, "stopped" | "superseded">,
  ): number {
    const dispatchIds = [...this.pendingAgentStartAcks.values()]
      .filter((pending) => pending.msg.agentId === agentId)
      .map((pending) => pending.msg.startDispatchId);
    for (const startDispatchId of dispatchIds) {
      this.terminalizePendingAgentStart(startDispatchId, reason);
    }
    return dispatchIds.length;
  }

  private acknowledgePendingAgentStartFromLifecycle(
    agentId: string,
    launchId: string | undefined,
    source: "agent_status" | "agent_session",
  ): void {
    for (const pending of [...this.pendingAgentStartAcks.values()]) {
      if (pending.msg.agentId !== agentId) continue;
      if (pending.msg.launchId && launchId && pending.msg.launchId !== launchId) {
        continue;
      }
      this.terminalizePendingAgentStart(
        pending.msg.startDispatchId,
        "acked",
        "acked",
        { ack_source: source },
      );
    }
  }

  /**
   * Agents the daemon reports running that the database does not place on
   * this machine: deleted, or moved to another machine (e.g. a migration that
   * flipped while this daemon was away). Left running, a moved agent runs on
   * two machines at once. Observe-only for now: each one is recorded with its
   * reason, and nothing is stopped until production shows no false positives
   * (e.g. an agent mid-migration). Reads the primary, not a cache.
   */
  private async observeForeignRunningAgents(machineId: string, agentIds: string[]): Promise<number> {
    if (agentIds.length === 0) return 0;
    const placements = new Map((await this.loadAgentPlacements(agentIds)).map((row) => [row.id, row]));
    let count = 0;
    for (const agentId of agentIds) {
      const placement = placements.get(agentId);
      if (placement && !placement.deletedAt && placement.machineId === machineId) continue;
      count += 1;
      this.recordEvent("machine.ready.reconcile.foreign_running", {
        agent_id: agentId,
        machine_id: machineId,
        reason: !placement || placement.deletedAt ? "deleted" : "moved",
        current_machine_id_present: Boolean(placement?.machineId),
        enforcement: "observe_only",
      });
    }
    return count;
  }

  protected async loadAgentPlacements(agentIds: string[]) {
    return agentService.getAgentPlacements(agentIds);
  }

  /** Move the agent's read position over messages its daemon reported the model was shown. */
  protected applyAgentModelSeen(input: Parameters<typeof applyAgentModelSeenToReadPosition>[0]) {
    return applyAgentModelSeenToReadPosition(input);
  }

  /** Whether this replica sent `agentId` a start on `machineId` that is not acknowledged yet. */
  private hasPendingAgentStart(agentId: string, machineId: string): boolean {
    for (const pending of this.pendingAgentStartAcks.values()) {
      if (pending.msg.agentId === agentId && pending.machineId === machineId) return true;
    }
    return false;
  }

  private trackPendingAgentStart(
    machineId: string,
    msg: AgentStartMessage & { startDispatchId: string },
    options: { scheduleTimeout?: boolean } = {},
  ): void {
    const existing = this.pendingAgentStartAcks.get(msg.startDispatchId);
    if (existing) {
      existing.machineId = machineId;
      existing.msg = msg;
      return;
    }
    this.clearPendingAgentStartsForAgent(msg.agentId, "superseded");
    const now = this.clock.now();
    const pending: PendingAgentStartAck = {
      machineId,
      msg,
      timer: null,
      attempts: 0,
      parked: false,
      createdAt: now,
      lastAttemptAt: 0,
      nextRetryAt: null,
    };
    this.pendingAgentStartAcks.set(msg.startDispatchId, pending);
    this.recordEvent("server.agent.start_dispatch.created", {
      ...this.startDispatchTraceAttrs(pending),
      outcome: "created",
    });
    if (options.scheduleTimeout ?? true) {
      this.scheduleAgentStartAckTimeout(pending);
    }
  }

  private scheduleAgentStartAckTimeout(pending: PendingAgentStartAck): void {
    if (pending.timer) this.clock.clearTimeout(pending.timer);
    pending.nextRetryAt = this.clock.now() + AgentOrchestrator.AGENT_START_ACK_TIMEOUT_MS;
    pending.timer = this.scheduleOnClock(() => {
      void this.retryPendingAgentStart(pending.msg.startDispatchId, "ack_timeout");
    }, AgentOrchestrator.AGENT_START_ACK_TIMEOUT_MS);
    const timerWithUnref = pending.timer as { unref?: () => void } | null;
    timerWithUnref?.unref?.();
  }

  private startDispatchAttemptSpan(machineId: string, msg: AgentStartMessage & { startDispatchId: string }): ActiveSpan {
    return this.tracer.startSpan("server.agent.start_dispatch.attempted", {
      parent: getCurrentTraceContext() ?? parseTraceparent(msg.traceparent),
      surface: "server",
      kind: "producer",
      attrs: {
        agent_id: msg.agentId,
        machine_id: machineId,
        launch_id: msg.launchId,
        start_dispatch_id: msg.startDispatchId,
      },
    });
  }

  private endStartDispatchAttemptSpan(span: ActiveSpan, pending: PendingAgentStartAck | undefined, sent: boolean): void {
    span.end(sent ? "ok" : "error", {
      attrs: {
        ...(pending ? this.startDispatchTraceAttrs(pending) : {}),
        outcome: sent ? "sent" : "send_failed",
      },
    });
  }

  private retryPendingAgentStartsForMachine(
    machineId: string,
    reason: "register" | "ready_reconcile",
  ): void {
    for (const pending of [...this.pendingAgentStartAcks.values()]) {
      if (pending.machineId === machineId) {
        void this.retryPendingAgentStart(pending.msg.startDispatchId, reason);
      }
    }
  }

  private async retryPendingAgentStart(
    startDispatchId: string,
    reason: "ack_timeout" | "register" | "ready_reconcile",
  ): Promise<void> {
    const pending = this.pendingAgentStartAcks.get(startDispatchId);
    if (!pending) return;
    let retryOutcome: TraceAttributes = {};
    await this.runInTraceSpan(
      "server.agent.start_dispatch.retry",
      {
        kind: "producer",
        parent: parseTraceparent(pending.msg.traceparent),
        attrs: {
          agent_id: pending.msg.agentId,
          machine_id: pending.machineId,
          launch_id: pending.msg.launchId,
          start_dispatch_id: startDispatchId,
          retry_reason: reason,
        },
      },
      async () => {
        retryOutcome = await this.retryPendingAgentStartInSpan(pending, startDispatchId);
      },
      () => ({ attrs: retryOutcome }),
    );
  }

  /**
   * Runs one retry of a pending start and returns the attributes that
   * describe what happened. The caller puts them on the retry span.
   */
  private async retryPendingAgentStartInSpan(
    pending: PendingAgentStartAck,
    startDispatchId: string,
  ): Promise<TraceAttributes> {
    const terminal = (terminalReason: AgentStartDispatchTerminalReason): TraceAttributes => ({
      outcome: "terminal",
      terminal_reason: terminalReason,
    });
    const agent = await this.getAuthoritativeAgentForDelivery(pending.msg.agentId);
    if (!agent) {
      this.terminalizePendingAgentStart(startDispatchId, "superseded");
      return terminal("superseded");
    }
    if (agent.machineId !== pending.machineId) {
      this.terminalizePendingAgentStart(startDispatchId, "machine_reassigned", "terminal", {
        current_machine_id_present: agent.machineId != null,
      });
      return terminal("machine_reassigned");
    }
    if (agent.status === "stopped") {
      this.terminalizePendingAgentStart(startDispatchId, "stopped");
      return terminal("stopped");
    }
    const cached = this.agentStateCache.get(pending.msg.agentId);
    if (
      pending.msg.launchId
      && cached?.expectedLaunchId
      && cached.expectedLaunchId !== pending.msg.launchId
    ) {
      this.terminalizePendingAgentStart(startDispatchId, "superseded");
      return terminal("superseded");
    }
    if (pending.attempts >= AgentOrchestrator.AGENT_START_ACK_MAX_ATTEMPTS) {
      const exhausted = this.terminalizePendingAgentStart(
        startDispatchId,
        "retry_exhausted",
      );
      if (exhausted) {
        this.updateCache(exhausted.msg.agentId, {
          status: "inactive",
          runtimeState: "not_running",
        });
        await this.persistAgentStatus(exhausted.msg.agentId, "inactive");
        this.broadcastActivity(
          exhausted.msg.agentId,
          "offline",
          "Start delivery could not reach the Computer",
          "runtime_unavailable",
          [],
          undefined,
          { launchId: exhausted.msg.launchId },
        );
      }
      return terminal("retry_exhausted");
    }

    const machineStatus = await this.getMachineStatus(pending.machineId);
    if (machineStatus === "offline") {
      if (pending.timer) this.clock.clearTimeout(pending.timer);
      pending.timer = null;
      pending.parked = true;
      // A reconnect can register on another replica, so this replica may not
      // receive the register/ready callbacks that normally unpark the start.
      // Keep probing ownership without consuming a delivery attempt.
      this.scheduleAgentStartAckTimeout(pending);
      return {
        ...this.startDispatchTraceAttrs(pending),
        outcome: "parked",
        terminal_reason: null,
      };
    }

    const localAtRetry = this.hasMachineLocally(pending.machineId);
    const sent = await this.sendToMachine(pending.machineId, pending.msg);
    if (sent) {
      pending.attempts += 1;
      pending.lastAttemptAt = this.clock.now();
      pending.parked = false;
    }
    if (sent && !localAtRetry) {
      if (pending.timer) this.clock.clearTimeout(pending.timer);
      pending.timer = null;
      pending.nextRetryAt = null;
      this.pendingAgentStartAcks.delete(startDispatchId);
      return {
        ...this.startDispatchTraceAttrs(pending),
        outcome: "routed",
        terminal_reason: null,
      };
    }
    this.scheduleAgentStartAckTimeout(pending);
    return {
      ...this.startDispatchTraceAttrs(pending),
      outcome: sent ? "replayed" : "scheduled",
      terminal_reason: null,
    };
  }

  private async sendAgentStartWithAckRetry(
    machineId: string,
    msg: AgentStartMessage & { startDispatchId: string },
  ): Promise<boolean> {
    const span = this.startDispatchAttemptSpan(machineId, msg);
    try {
      return await this.runInActiveSpan(span, async () => {
        const localAtSend = this.hasMachineLocally(machineId);
        if (localAtSend) {
          this.trackPendingAgentStart(machineId, msg);
        }
        const sent = await this.sendToMachine(machineId, msg);
        let pending = this.pendingAgentStartAcks.get(msg.startDispatchId);
        if (sent && pending) {
          pending.attempts += 1;
          pending.lastAttemptAt = this.clock.now();
        }
        if (!sent && !pending) {
          this.trackPendingAgentStart(machineId, msg);
          pending = this.pendingAgentStartAcks.get(msg.startDispatchId);
        }
        this.endStartDispatchAttemptSpan(span, pending, sent);
        return sent;
      });
    } catch (error) {
      span.end("error", { attrs: { outcome: "send_failed", error_class: errorClassOf(error) } });
      throw error;
    }
  }

  private sendLocalAgentStartWithAckRetry(
    machineId: string,
    msg: AgentStartMessage & { startDispatchId: string },
  ): boolean {
    const span = this.startDispatchAttemptSpan(machineId, msg);
    try {
      return this.runInActiveSpan(span, () => {
        this.trackPendingAgentStart(machineId, msg);
        const sent = this.sendToLocalMachine(machineId, msg);
        const pending = this.pendingAgentStartAcks.get(msg.startDispatchId);
        if (sent && pending) {
          pending.attempts += 1;
          pending.lastAttemptAt = this.clock.now();
        }
        this.endStartDispatchAttemptSpan(span, pending, sent);
        return sent;
      });
    } catch (error) {
      span.end("error", { attrs: { outcome: "send_failed", error_class: errorClassOf(error) } });
      throw error;
    }
  }

  private agentDeliveryAckKey(msg: Pick<Extract<ServerToMachineMessage, { type: "agent:deliver" }>, "agentId" | "seq" | "deliveryId">): string {
    return msg.deliveryId ? `delivery:${msg.deliveryId}` : `seq:${msg.agentId}:${msg.seq}`;
  }

  /**
   * An ack-retry cycle is in flight only while it can still exhaust. A parked cycle (machine went
   * offline) ignores ack timeouts and is never unparked for tracked mentions, so treating it as in
   * flight would let every recovery trigger re-send without spending budget, forever.
   */
  private hasLiveAgentDeliveryAckCycle(msg: Pick<Extract<ServerToMachineMessage, { type: "agent:deliver" }>, "agentId" | "seq" | "deliveryId">): boolean {
    const pending = this.pendingAgentDeliveryAcks.get(this.agentDeliveryAckKey(msg));
    return Boolean(pending && !pending.parked);
  }

  private findAgentDeliveryAckKey(agentId: string, seq: number, deliveryId?: string): string | null {
    if (deliveryId) {
      const deliveryKey = `delivery:${deliveryId}`;
      if (this.pendingAgentDeliveryAcks.has(deliveryKey)) return deliveryKey;
    }
    const seqKey = `seq:${agentId}:${seq}`;
    if (this.pendingAgentDeliveryAcks.has(seqKey)) return seqKey;
    for (const [key, pending] of this.pendingAgentDeliveryAcks.entries()) {
      if (pending.msg.agentId === agentId && pending.msg.seq === seq) return key;
    }
    return null;
  }

  private trackPendingAgentDeliveryAck(
    machineId: string,
    msg: Extract<ServerToMachineMessage, { type: "agent:deliver" }>,
    options: { scheduleTimeout?: boolean } = {},
  ): void {
    const scheduleTimeout = options.scheduleTimeout ?? true;
    const key = this.agentDeliveryAckKey(msg);
    const existing = this.pendingAgentDeliveryAcks.get(key);
    if (existing) {
      existing.machineId = machineId;
      existing.msg = msg;
      existing.lastAttemptAt = this.clock.now();
      if (scheduleTimeout) {
        this.scheduleAgentDeliveryAckTimeout(key, existing);
      }
      return;
    }

    const now = this.clock.now();
    const pending: PendingAgentDeliveryAck = {
      machineId,
      msg,
      timer: null,
      attempts: 1,
      parked: false,
      firstAttemptAt: now,
      lastAttemptAt: now,
      onlineAtFirstAttempt: this.hasMachineLocally(machineId),
    };
    this.pendingAgentDeliveryAcks.set(key, pending);
    agentDeliveryTrackedTotal.inc({ online_at_first_attempt: String(pending.onlineAtFirstAttempt) });
    if (scheduleTimeout) {
      this.scheduleAgentDeliveryAckTimeout(key, pending);
    }
  }

  private scheduleAgentDeliveryAckTimeout(key: string, pending: PendingAgentDeliveryAck): void {
    if (pending.timer) {
      this.clock.clearTimeout(pending.timer);
    }
    pending.timer = this.scheduleOnClock(() => {
      void this.retryPendingAgentDelivery(key, "ack_timeout");
    }, AgentOrchestrator.AGENT_DELIVERY_ACK_TIMEOUT_MS);
    const timerWithUnref = pending.timer as { unref?: () => void } | null;
    timerWithUnref?.unref?.();
  }

  private clearPendingAgentDeliveryAck(
    msg: Pick<Extract<MachineToServerMessage, { type: "agent:deliver:ack" }>, "agentId" | "seq" | "deliveryId">,
    outcome: "acked" | "terminal",
  ): boolean {
    const key = this.findAgentDeliveryAckKey(msg.agentId, msg.seq, msg.deliveryId);
    if (!key) return false;
    const pending = this.pendingAgentDeliveryAcks.get(key);
    if (pending?.timer) this.clock.clearTimeout(pending.timer);
    if (pending) {
      if (outcome === "acked") {
        agentDeliveryAckSeconds.observe(
          { online_at_first_attempt: String(pending.onlineAtFirstAttempt) },
          (this.clock.now() - pending.firstAttemptAt) / 1000,
        );
      }
      this.recordAgentDeliveryOutcome(pending, outcome);
    }
    return this.pendingAgentDeliveryAcks.delete(key);
  }

  private recordAgentDeliveryOutcome(pending: PendingAgentDeliveryAck, outcome: AgentDeliveryOutcome): void {
    agentDeliveryOutcomesTotal.inc({ outcome, online_at_first_attempt: String(pending.onlineAtFirstAttempt) });
  }

  private clearPendingAgentDeliveryAcksForAgent(agentId: string): number {
    let cleared = 0;
    for (const [key, pending] of [...this.pendingAgentDeliveryAcks.entries()]) {
      if (pending.msg.agentId !== agentId) continue;
      if (pending.timer) this.clock.clearTimeout(pending.timer);
      this.recordAgentDeliveryOutcome(pending, "agent_stopped");
      this.pendingAgentDeliveryAcks.delete(key);
      cleared += 1;
    }
    return cleared;
  }

  private retryPendingAgentDeliveriesForMachine(machineId: string, reason: "ready_reconcile" | "register"): void {
    for (const [key, pending] of [...this.pendingAgentDeliveryAcks.entries()]) {
      // Tracked mention obligations are rebuilt from the durable occurrence
      // state on ready. The task #166 map remains only their timer/dispatch
      // executor; it must not become a second recovery authority.
      if (pending.msg.mentionDelivery) continue;
      if (pending.machineId === machineId) {
        void this.retryPendingAgentDelivery(key, reason);
      }
    }
  }

  private async recoverDurableMentionDeliveriesForMachine(machineId: string): Promise<void> {
    const rows = await mentionDeliveryOccurrenceService.listRecoverableMentionDeliveries(machineId);
    const agentIds = new Set(rows.map((row) => row.agentId));
    for (const agentId of agentIds) {
      const agent = await this.getCachedAgent(agentId);
      if (
        !agent
        || agent.machineId !== machineId
        || !agent.expectedLaunchId
        || !agent.sessionId
      ) {
        continue;
      }
      await this.recoverDurableMentionDeliveriesForAgent(agentId, {
        machineId,
        launchId: agent.expectedLaunchId,
        sessionId: agent.sessionId,
      });
    }
  }

  private async recoverDurableMentionDeliveriesForAgent(
    agentId: string,
    runtimeIdentity: Pick<MentionDeliveryIdentitySnapshot, "machineId" | "launchId" | "sessionId">,
  ): Promise<void> {
    const rows = await mentionDeliveryOccurrenceService.listRecoverableMentionDeliveriesForAgent(
      runtimeIdentity.machineId,
      agentId,
    );
    for (const row of rows) {
      if (!row.deliveryPayload) continue;
      const identity: MentionDeliveryIdentitySnapshot = {
        occurrenceId: row.occurrenceId,
        messageId: row.messageId,
        ...runtimeIdentity,
      };
      let current = row;
      if (row.serverDecidedAt) {
        if (
          row.machineIdSnapshot !== identity.machineId
          || row.launchIdSnapshot !== identity.launchId
          || row.sessionIdSnapshot !== identity.sessionId
        ) {
          await mentionDeliveryOccurrenceService.recordMentionDeliveryIdentityDrift(row.occurrenceId, "recovery");
          continue;
        }
      } else {
        const decided = await mentionDeliveryOccurrenceService.recordMentionDeliveryServerDecision({
          occurrenceId: row.occurrenceId,
          payload: row.deliveryPayload,
          identity,
        });
        if (!decided) continue;
        current = decided;
      }
      if (current.state === "daemon_drained") continue;
      // task #285: every agent:session (each session_init and turn_end) and machine-ready
      // re-arms this listing. A round is one ack-retry cycle, so a trigger while this
      // occurrence's cycle is still in flight re-sends without spending budget; only starting
      // a new cycle does. Past the budget the occurrence is written terminal and leaves the
      // listing, which is what stops the loop for daemons that never terminalise it.
      const cycleInFlight = this.hasLiveAgentDeliveryAckCycle({
        agentId,
        seq: row.deliveryPayload.seq ?? 0,
        deliveryId: row.occurrenceId,
      });
      if (!cycleInFlight) {
        const recovery = await mentionDeliveryOccurrenceService.claimMentionDeliveryRecovery({
          occurrenceId: current.occurrenceId,
          expectedVersion: current.version,
        });
        if (recovery.status !== "claimed") continue;
      }
      await this.enqueueToLocalInboxIfStillActive(agentId, identity.machineId, row.deliveryPayload);
      await this.sendAgentDeliveryWithAckRetry(identity.machineId, {
        type: "agent:deliver",
        agentId,
        message: row.deliveryPayload,
        seq: row.deliveryPayload.seq ?? 0,
        deliveryId: row.occurrenceId,
        mentionDelivery: identity,
      }, `durable mention recovery failed for agent ${agentId}`);
    }
  }

  private parkPendingAgentDeliveryAck(
    pending: PendingAgentDeliveryAck,
    reason: "machine_offline",
  ): void {
    if (pending.timer) {
      this.clock.clearTimeout(pending.timer);
      pending.timer = null;
    }
    pending.parked = true;
    pending.parkedReason = reason;
  }

  private async loadPendingAgentDeliveryRetryGate(pending: PendingAgentDeliveryAck): Promise<{
    allowed: boolean;
    reason: string;
    wakeAction?: WakePlanAction;
    currentStatus?: AgentStatus;
    currentMachineId?: string | null;
  }> {
    const agent = await this.getAuthoritativeAgentForDelivery(pending.msg.agentId);
    if (!agent) {
      return { allowed: false, reason: "agent_missing" };
    }
    if (agent.machineId !== pending.machineId) {
      return {
        allowed: false,
        reason: "machine_mismatch",
        currentMachineId: agent.machineId,
        currentStatus: agent.status,
      };
    }
    if (pending.msg.mentionDelivery && (
      pending.msg.mentionDelivery.machineId !== agent.machineId
      || pending.msg.mentionDelivery.launchId !== agent.expectedLaunchId
      || pending.msg.mentionDelivery.sessionId !== agent.sessionId
    )) {
      await mentionDeliveryOccurrenceService.recordMentionDeliveryIdentityDrift(
        pending.msg.mentionDelivery.occurrenceId,
        "retry",
      );
      return {
        allowed: false,
        reason: "mention_identity_drift",
        currentMachineId: agent.machineId,
        currentStatus: agent.status,
      };
    }

    const wakeInput = await this.loadWakePlanInput(pending.msg.agentId, agent.status);
    const wakeAction = planWakeAction(wakeInput);
    if (wakeAction !== "deliver-directly") {
      return {
        allowed: false,
        reason: "wake_plan_not_direct",
        wakeAction,
        currentMachineId: agent.machineId,
        currentStatus: agent.status,
      };
    }

    return {
      allowed: true,
      reason: "deliver_directly",
      wakeAction,
      currentMachineId: agent.machineId,
      currentStatus: agent.status,
    };
  }

  private async retryPendingAgentDelivery(key: string, reason: "ack_timeout" | "ready_reconcile" | "register"): Promise<void> {
    const pending = this.pendingAgentDeliveryAcks.get(key);
    if (!pending) return;
    if (pending.parked && reason === "ack_timeout") {
      return;
    }
    const localAtRetry = this.hasMachineLocally(pending.machineId);
    const ownerTraceAttrs = await this.getMachineOwnerTraceAttrs(pending.machineId);
    const span = this.tracer.startSpan("server.agent.delivery.retry", {
      parent: parseTraceparent(pending.msg.traceparent),
      surface: "server",
      kind: "producer",
      attrs: {
        agent_id: pending.msg.agentId,
        machine_id: pending.machineId,
        agent_id_present: Boolean(pending.msg.agentId),
        machine_id_present: Boolean(pending.machineId),
        deliveryId: pending.msg.deliveryId,
        delivery_correlation_id: pending.msg.deliveryId,
        seq: pending.msg.seq,
        attempts: pending.attempts,
        retry_reason: reason,
        parked: pending.parked,
        parked_reason: pending.parkedReason,
        local_socket_present: localAtRetry,
        ...ownerTraceAttrs,
      },
    });
    if (pending.attempts >= AgentOrchestrator.AGENT_DELIVERY_ACK_MAX_ATTEMPTS) {
      if (pending.timer) this.clock.clearTimeout(pending.timer);
      this.recordAgentDeliveryOutcome(pending, "gave_up");
      this.pendingAgentDeliveryAcks.delete(key);
      span.end("ok", {
        attrs: {
          first_attempt_age_ms: this.clock.now() - pending.firstAttemptAt,
          outcome: "gave_up",
          reason: "ack_retry_exhausted",
        },
      });
      return;
    }
    await this.runInActiveSpan(span, async () => {
      try {
        const gate = await this.loadPendingAgentDeliveryRetryGate(pending);
        this.recordEvent("server.delivery.retry.gate", {
          outcome: gate.allowed ? "allowed" : "dropped",
          reason: gate.reason,
          wake_action: gate.wakeAction,
          current_status: gate.currentStatus,
          current_machine_id_present: gate.currentMachineId != null,
          machine_matches: gate.currentMachineId === pending.machineId,
        });
        if (!gate.allowed) {
          if (pending.timer) this.clock.clearTimeout(pending.timer);
          this.recordAgentDeliveryOutcome(pending, "dropped");
          this.pendingAgentDeliveryAcks.delete(key);
          span.end("ok", {
            attrs: {
              outcome: "dropped",
              reason: gate.reason,
              wake_action: gate.wakeAction,
              current_status: gate.currentStatus,
            },
          });
          return;
        }

        const machineStatus = await this.getMachineStatus(pending.machineId);
        this.recordEvent("server.delivery.retry.machine_status", {
          machine_status: machineStatus,
          retry_reason: reason,
        });
        if (machineStatus === "offline") {
          this.parkPendingAgentDeliveryAck(pending, "machine_offline");
          span.end("ok", {
            attrs: {
              outcome: "parked",
              reason: "machine_offline",
              wake_action: gate.wakeAction,
              current_status: gate.currentStatus,
            },
          });
          return;
        }

        pending.parked = false;
        pending.parkedReason = undefined;
        pending.attempts += 1;
        pending.lastAttemptAt = this.clock.now();
        let routeTraceAttrs: Record<string, unknown> = {};
        const sent = await this.sendToMachine(pending.machineId, pending.msg, {
          onRouteResult: (routeResult) => {
            routeTraceAttrs = projectMachineCommandRouteTraceAttrs(routeResult);
          },
        });
        const deliveryTraceAttrs = { ...ownerTraceAttrs, ...routeTraceAttrs };
        this.recordEvent("server.delivery.retry.sent", {
          outcome: sent ? "sent" : "not_sent",
          reason: sent ? (localAtRetry ? "local_socket_present" : "routed_to_owner") : "machine_unreachable",
          deliveryId: pending.msg.deliveryId,
          seq: pending.msg.seq,
          ...deliveryTraceAttrs,
        });
        if (sent && !localAtRetry) {
          if (pending.timer) this.clock.clearTimeout(pending.timer);
          this.recordAgentDeliveryOutcome(pending, "routed");
          this.pendingAgentDeliveryAcks.delete(key);
          span.end("ok", { attrs: { outcome: "routed", reason: "routed_to_owner", ...deliveryTraceAttrs } });
          return;
        }
        this.scheduleAgentDeliveryAckTimeout(key, pending);
        span.end("ok", { attrs: { outcome: sent ? "resent" : "scheduled", reason: sent ? "local_retry_sent" : "machine_unreachable", ...deliveryTraceAttrs } });
      } catch (err) {
        this.scheduleAgentDeliveryAckTimeout(key, pending);
        span.end("error", { attrs: { outcome: "scheduled", reason: "retry_error", error_class: errorClassOf(err) } });
        console.warn(`[Machine ${pending.machineId}] agent delivery retry failed for ${pending.msg.agentId}:`, err);
      }
    });
  }

  protected async sendAgentDeliveryWithAckRetry(
    machineId: string,
    msg: Extract<ServerToMachineMessage, { type: "agent:deliver" }>,
    errorContext: string,
  ): Promise<boolean> {
    const localAtSend = this.hasMachineLocally(machineId);
    if (localAtSend) {
      this.trackPendingAgentDeliveryAck(machineId, msg);
    }
    try {
      const sent = await this.sendToMachine(machineId, msg);
      if (!sent && !this.findAgentDeliveryAckKey(msg.agentId, msg.seq, msg.deliveryId)) {
        this.trackPendingAgentDeliveryAck(machineId, msg);
      }
      return sent;
    } catch (err) {
      if (!this.findAgentDeliveryAckKey(msg.agentId, msg.seq, msg.deliveryId)) {
        this.trackPendingAgentDeliveryAck(machineId, msg);
      }
      console.warn(`[Machine ${machineId}] ${errorContext}:`, err);
      return false;
    }
  }

  protected async resolveRoutedMachineOwnership(
    machineId: string,
    localMachineIds: Set<string>,
    handleLocally: () => boolean | Promise<boolean>,
    rerouteToCurrentOwner: () => Promise<boolean>,
    fallback: () => boolean | Promise<boolean>,
  ): Promise<boolean> {
    const action = planRoutedOwnershipAction({
      machineIsLocal: localMachineIds.has(machineId),
      canReroute: this.replicaStateStore.isAvailable(),
    });

    return this.applyRoutedOwnershipAction({
      action,
      handleLocally,
      rerouteToCurrentOwner,
      fallback,
    });
  }

  protected async applyRoutedOwnershipAction(context: RoutedOwnershipApplyContext): Promise<boolean> {
    if (context.action === "handle-locally") {
      return await context.handleLocally();
    }

    if (context.action === "reroute-then-fallback") {
      const rerouted = await context.rerouteToCurrentOwner();
      if (rerouted) {
        return true;
      }
    }

    return await context.fallback();
  }

  /** Send directly to a local machine connection (used by ReplicaRouter callback) */
  sendToLocalMachine(machineId: string, msg: ServerToMachineMessage): boolean {
    const conn = this.machineConnections.get(machineId);
    if (!conn || conn.ws.readyState !== 1) return false;
    conn.ws.send(JSON.stringify(msg));
    return true;
  }

  async handleRoutedMachineCommand(machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    const localMachineIds = this.getRoutableLocalMachineIds();
    return this.resolveRoutedMachineOwnership(
      machineId,
      localMachineIds,
      () => this.handleLocalRoutedMachineCommand(machineId, msg),
      async () => normalizeMachineCommandRouteResult(
        await this.routeMachineCommandCrossReplica(machineId, msg, localMachineIds),
      ).routed,
      () => false,
    );
  }

  private async handleLocalRoutedMachineCommand(machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (msg.type === "agent:start") {
      // A peer that could not route the start as an intent (owner without
      // intent support) prepared it and armed only its own guard. This
      // replica receives the launch's frames, so it arms the guard for the
      // launch it is about to send; otherwise every frame of that launch is
      // dropped against the older one as stale_launch_guard.
      this.armStartLaunchGuard(msg.agentId, msg.launchId);
    }
    if (
      (msg.type === "agent:start" || msg.type === "agent:start:wiki")
      && msg.startDispatchId
    ) {
      return await this.sendAgentStartWithAckRetry(
        machineId,
        msg as AgentStartMessage & { startDispatchId: string },
      );
    }

    if (msg.type === "agent:deliver" && await this.maybeWakeForRoutedAgentDeliver(machineId, msg)) {
      return true;
    }

    if (msg.type === "agent:deliver") {
      this.trackPendingAgentDeliveryAck(machineId, msg);
      return this.sendToLocalMachine(machineId, msg);
    }

    return this.sendToLocalMachine(machineId, msg);
  }

  private async maybeWakeForRoutedAgentDeliver(
    machineId: string,
    msg: Extract<ServerToMachineMessage, { type: "agent:deliver" }>,
  ): Promise<boolean> {
    const agent = await this.getAuthoritativeAgentForDelivery(msg.agentId);
    if (!agent || agent.machineId !== machineId) {
      return false;
    }

    const wakeInput = await this.loadWakePlanInput(msg.agentId, agent.status);
    const action = planWakeAction(wakeInput);
    if (action === "deliver-directly") {
      return false;
    }
    if (action === "suppress-control-gate") {
      if (!msg.transient) {
        this.deliverToLocalInbox(msg.agentId, msg.message, { notifyPendingReceive: false });
      }
      await this.maybePiggybackRuntimeProfileMigrationNudge(machineId, agent);
      return true;
    }

    await this.applyWakeAction({
      agentId: msg.agentId,
      machineId: agent.machineId,
      previousStatus: agent.status,
      resetMode: wakeInput.state.resetMode,
      transient: msg.transient ?? false,
    }, msg.message, action);
    return true;
  }

  async handleRoutedInboxDelivery(agentId: string, machineId: string | null, message: AgentMessage): Promise<boolean> {
    const agent = await this.getCachedAgent(agentId);
    if (!agent || agent.status !== "active" || !agent.machineId) {
      return true;
    }
    if (!await this.canAgentAccessDeliveryTarget(agentId, agent, message)) {
      return true;
    }

    // Old routed payloads may not carry machineId; use current cached ownership as
    // the contract anchor so mixed-version server windows still route correctly.
    const targetMachineId = agent.machineId;
    const localMachineIds = this.getRoutableLocalMachineIds();
    return this.resolveRoutedMachineOwnership(
      targetMachineId,
      localMachineIds,
      () => this.deliverToLocalInboxIfStillActive(agentId, targetMachineId, message),
      () => this.routeInboxDeliveryCrossReplica(agentId, targetMachineId, message, localMachineIds),
      () => this.deliverToLocalInboxIfStillActive(agentId, targetMachineId, message),
    );
  }

  async handleRoutedInboxDeliveryWithReceipt(
    agentId: string,
    machineId: string | null,
    message: AgentMessage,
    deliveryOptions: RoutedInboxDeliveryOptions = {},
  ): Promise<AgentMessageDeliveryResult> {
    if (!machineId || !this.getRoutableLocalMachineIds().has(machineId)) {
      return { status: "dropped", reason: "cross_replica_receipt_unavailable" };
    }
    const agent = await this.getCachedAgent(agentId);
    if (!agent || agent.machineId !== machineId) {
      return { status: "dropped", reason: "agent_state_changed" };
    }
    return this.deliverMessage(agentId, message, {
      ...deliveryOptions,
      requireQueueReceipt: true,
    });
  }

  protected async canAgentAccessDeliveryTarget(agentId: string, agent: CachedAgentState, message: AgentMessage): Promise<boolean> {
    if (message.third_party_event) return true;
    let checkError: unknown = null;
    return this.runInTraceSpan(
      "server.agent_delivery.visibility_check",
      {
        attrs: {
          agent_id: agentId,
          channel_id: message.channel_id,
        },
      },
      async () => {
        try {
          const channel = await channelService.getChannel(message.channel_id);
          if (!channel || channel.serverId !== agent.serverId) {
            return false;
          }
          return await channelService.canAgentAccessChannel(message.channel_id, agentId);
        } catch (error) {
          console.warn(`[Agent ${agentId}] Dropping delivery for ${message.channel_id}: target visibility check failed`, error);
          checkError = error;
          this.recordEvent("server.agent_delivery.visibility_check_failed", {
            agent_id: agentId,
            channel_id: message.channel_id,
            outcome: "error",
            reason: "visibility_check_threw",
            error_class: errorClassOf(error),
          });
          return false;
        }
      },
      (allowed) => checkError == null
        ? { attrs: { outcome: allowed ? "allowed" : "denied" } }
        : { status: "error", attrs: { outcome: "error", reason: "visibility_check_threw", error_class: errorClassOf(checkError) } },
    );
  }

  /**
   * Validate that an incoming machine-originated agent event actually belongs to
   * the machine/server that sent it. This prevents a buggy or compromised daemon
   * from overwriting another agent's activity/status/trajectory.
   */
  /**
   * task #1103 — a daemon asks the Server to wake an agent that has a due
   * app-inbox item but no local process and no restart snapshot. The Server
   * owns the config, so it decides through the ordinary startAgent path and
   * answers with a typed outcome. A dispatched id is replayed for a while so a
   * duplicate fire or a resend after reconnect never dispatches twice.
   */
  private readonly recentAgentWakeDispatches = new Map<string, { agentId: string; atMs: number }>();
  private static readonly AGENT_WAKE_DISPATCH_REPLAY_MS = 5 * 60_000;
  private static readonly AGENT_WAKE_DISPATCH_REPLAY_MAX_ENTRIES = 4096;

  /** Keyed by wakeRequestId: one agent may have several ids in flight (A, B, then A resent). */
  private rememberAgentWakeDispatch(wakeRequestId: string, agentId: string): void {
    const now = this.clock.now();
    for (const [id, entry] of this.recentAgentWakeDispatches) {
      if (now - entry.atMs >= AgentOrchestrator.AGENT_WAKE_DISPATCH_REPLAY_MS) this.recentAgentWakeDispatches.delete(id);
    }
    while (this.recentAgentWakeDispatches.size >= AgentOrchestrator.AGENT_WAKE_DISPATCH_REPLAY_MAX_ENTRIES) {
      const oldest = this.recentAgentWakeDispatches.keys().next().value;
      if (oldest === undefined) break;
      this.recentAgentWakeDispatches.delete(oldest);
    }
    this.recentAgentWakeDispatches.set(wakeRequestId, { agentId, atMs: now });
  }

  private replayableAgentWakeDispatch(wakeRequestId: string, agentId: string): boolean {
    const entry = this.recentAgentWakeDispatches.get(wakeRequestId);
    if (!entry) return false;
    if (entry.agentId !== agentId || this.clock.now() - entry.atMs >= AgentOrchestrator.AGENT_WAKE_DISPATCH_REPLAY_MS) {
      this.recentAgentWakeDispatches.delete(wakeRequestId);
      return false;
    }
    return true;
  }

  private async handleAgentWakeRequest(
    machineId: string,
    serverId: string | null,
    msg: Extract<MachineToServerMessage, { type: "agent:wake:request" }>,
  ): Promise<void> {
    // The daemon sends its traceparent with the request, so the start
    // dispatch and the agent:start it produces stay on the daemon's trace.
    await withTraceRoot(this.tracer, "server.agent.wake_request", {
      parent: parseTraceparent(msg.traceparent),
      surface: "server",
      kind: "consumer",
      attrs: {
        agent_id: msg.agentId,
        machine_id: machineId,
        wake_request_id: msg.wakeRequestId,
        wake_reason: msg.reason,
        pending_app_items: msg.pendingAppItems,
        // The machine is authenticated; its CONTENT is not. Validate the app
        // reference against the SERVER's own known-app set before it becomes
        // span attributes — see wakeRequestAppRef.ts. The wake itself is
        // unaffected either way.
        ...wakeRequestAppRefTraceAttrs({
          appId: msg.appId,
          ownerAgentId: msg.agentId,
          sourceRef: msg.sourceRef,
        }),
      },
    }, () => this.answerAgentWakeRequest(machineId, serverId, msg));
  }

  private async answerAgentWakeRequest(
    machineId: string,
    serverId: string | null,
    msg: Extract<MachineToServerMessage, { type: "agent:wake:request" }>,
  ): Promise<void> {
    const answer = (outcome: "dispatched" | "refused", reason?: AgentWakeRefusedReason) => {
      addTraceEvent("wake_request.answered", {
        outcome,
        reason: reason ?? null,
      });
      return this.sendToMachine(machineId, {
        type: "agent:wake:outcome",
        agentId: msg.agentId,
        wakeRequestId: msg.wakeRequestId,
        outcome,
        ...(reason ? { reason } : {}),
      });
    };
    const validation = await this.validateMachineAgentMessageWithReason(machineId, serverId, msg.agentId, msg.type);
    if (!validation.agent) {
      await answer("refused", validation.dropReason === "unknown_agent" ? "agent_not_found" : "machine_mismatch");
      return;
    }
    if (this.replayableAgentWakeDispatch(msg.wakeRequestId, msg.agentId)) {
      await answer("dispatched");
      return;
    }
    try {
      const result = await this.startAgent(msg.agentId, { startCause: "app_inbox_wake" });
      if (result.outcome === "dispatched") {
        this.rememberAgentWakeDispatch(msg.wakeRequestId, msg.agentId);
        console.log(`[Agent ${msg.agentId}] Wake dispatched for daemon app-inbox request ${msg.wakeRequestId} (${msg.appId} ${msg.sourceRef.kind}:${msg.sourceRef.id})`);
        await answer("dispatched");
        return;
      }
      console.log(`[Agent ${msg.agentId}] Wake refused for daemon app-inbox request ${msg.wakeRequestId}: ${result.reason}`);
      await answer("refused", result.reason);
    } catch (error) {
      console.error(`[Agent ${msg.agentId}] Wake request ${msg.wakeRequestId} failed:`, error);
      await answer("refused", "server_error");
    }
  }

  /**
   * task #1113 — the daemon could not deliver because the agent has no
   * process and no cached config. The Server owns the config: settle the
   * pending delivery as converted and dispatch one ordinary start that
   * carries the message as its wake message. Idempotent per delivery key: a
   * duplicate rejection finds no pending delivery and is ignored.
   */
  private async handleAgentDeliveryRejected(
    machineId: string,
    serverId: string | null,
    msg: Extract<MachineToServerMessage, { type: "agent:delivery:rejected" }>,
  ): Promise<void> {
    let rejectedOutcome: TraceAttributes = { outcome: "invalid_agent" };
    await this.runInTraceSpan(
      "server.agent.delivery.rejected",
      {
        kind: "consumer",
        parent: parseTraceparent(msg.traceparent),
        attrs: {
          agent_id: msg.agentId,
          machine_id: machineId,
          seq: msg.seq,
          deliveryId: msg.deliveryId ?? null,
          reason: msg.reason,
        },
      },
      () => this.handleAgentDeliveryRejectedInSpan(machineId, serverId, msg, (outcome, extra = {}) => {
        rejectedOutcome = { outcome, ...(extra as TraceAttributes) };
      }),
      () => ({
        status: String(rejectedOutcome.outcome).startsWith("start_failed") ? "error" : "ok",
        attrs: rejectedOutcome,
      }),
    );
  }

  private async handleAgentDeliveryRejectedInSpan(
    machineId: string,
    serverId: string | null,
    msg: Extract<MachineToServerMessage, { type: "agent:delivery:rejected" }>,
    trace: (outcome: string, extra?: Record<string, unknown>) => void,
  ): Promise<void> {
    const agent = await this.validateMachineAgentMessage(machineId, serverId, msg.agentId, msg.type);
    if (!agent) return;
    const key = this.findAgentDeliveryAckKey(msg.agentId, msg.seq, msg.deliveryId);
    const pending = key ? this.pendingAgentDeliveryAcks.get(key) : undefined;
    if (!key || !pending) {
      trace("ignored_no_pending");
      return;
    }
    if (pending.machineId !== machineId) {
      trace("ignored_other_machine", { pending_machine_id: pending.machineId });
      return;
    }
    // Settle the delivery here: the start below is its continuation, and the
    // ordinary retry-until-gave-up path must not redeliver the same message.
    if (pending.timer) this.clock.clearTimeout(pending.timer);
    this.recordAgentDeliveryOutcome(pending, "converted_to_wake");
    this.pendingAgentDeliveryAcks.delete(key);
    let result: AgentStartDispatchResult;
    try {
      result = await this.startAgent(msg.agentId, {
        wakeMessage: pending.msg.message,
        ...(pending.msg.transient ? { wakeMessageTransient: true } : {}),
      });
    } catch (error) {
      console.error(`[Agent ${msg.agentId}] Wake start after rejected delivery ${key} failed:`, error);
      // Keep the delivery observable through the ordinary ack-retry path.
      this.trackPendingAgentDeliveryAck(machineId, pending.msg);
      trace("start_failed_retracked", {
        error_class: errorClassOf(error),
      });
      return;
    }
    if (result.outcome === "dispatched") {
      console.log(`[Agent ${msg.agentId}] Rejected delivery ${key} converted into a wake start`);
      trace("converted_to_wake_start");
      return;
    }
    if (result.reason === "wake_lock_held") {
      // Another replica is starting this agent; the starting process will take
      // the ordinary redelivery.
      this.trackPendingAgentDeliveryAck(machineId, pending.msg);
      trace("start_skipped_wake_lock_held_retracked");
      return;
    }
    // manual_stop: the agent is offline by user intent; the delivery ends here
    // with a typed outcome instead of retrying until gave_up.
    trace(`start_skipped_${result.reason}`);
  }

  private async validateMachineAgentMessage(
    machineId: string,
    serverId: string | null,
    agentId: string,
    messageType: string
  ): Promise<CachedAgentState | null> {
    const result = await this.validateMachineAgentMessageWithReason(machineId, serverId, agentId, messageType);
    return result.agent;
  }

  private async validateMachineAgentMessageWithReason(
    machineId: string,
    serverId: string | null,
    agentId: string,
    messageType: string
  ): Promise<MachineAgentValidationResult> {
    if (!serverId) {
      console.warn(`[Machine ${machineId}] Dropping ${messageType} for agent ${agentId}: missing server context`);
      return { agent: null, dropReason: "missing_server_context" };
    }

    const agent = await this.getCachedAgent(agentId);
    if (!agent) {
      console.warn(`[Machine ${machineId}] Dropping ${messageType} for unknown agent ${agentId}`);
      return { agent: null, dropReason: "unknown_agent" };
    }

    if (agent.machineId !== machineId || agent.serverId !== serverId) {
      console.warn(
        `[Machine ${machineId}] Dropping ${messageType} for agent ${agentId}: ` +
        `expected machine=${agent.machineId ?? "null"} server=${agent.serverId}, got machine=${machineId} server=${serverId}`
      );
      return { agent: null, dropReason: "machine_or_server_mismatch" };
    }

    return { agent, dropReason: null };
  }

  protected async getMachineForAgent(agentId: string): Promise<{ machineId: string; conn: MachineConnection } | null> {
    const agent = await agentService.getAgent(agentId, false, {
      dbCallsite: "agent_orchestrator.machine_lookup",
    });
    if (!agent?.machineId) return null;
    const conn = this.machineConnections.get(agent.machineId);
    if (!conn) return null;
    return { machineId: agent.machineId, conn };
  }

  // Agent lifecycle

  /** Test seam: the resume recovery read (the unified chain). */
  protected async selectResumeInbox(agentId: string): Promise<channelService.AgentInboxChainSelection> {
    return channelService.selectAgentInboxChainRows(agentId);
  }

  protected async loadAgentForStart(agentId: string) {
    return agentService.getAgent(agentId, false, {
      dbCallsite: "agent_orchestrator.start",
    });
  }

  protected async resetPersistedAgentSession(agentId: string, status: AgentStatus = "inactive") {
    await agentService.resetAgentSession(agentId, status);
  }

  private broadcastAgentSession(serverId: string, agentId: string, sessionId: string | null) {
    this.io?.to(`server:${serverId}`).emit("agent:session", { agentId, sessionId });
  }

  private releaseWakeLock(agentId: string) {
    if (!this.replicaStateStore.isAvailable()) return;
    this.replicaStateStore.releaseWakeLock(agentId).catch(() => {});
  }

  private clearAgentInbox(agentId: string): boolean {
    const inbox = this.agentInboxes.get(agentId);
    let resolvedPendingReceive = false;
    if (inbox?.pendingReceive) {
      clearTimeout(inbox.pendingReceive.timer);
      inbox.pendingReceive.resolve([]);
      resolvedPendingReceive = true;
    }
    this.agentInboxes.delete(agentId);
    return resolvedPendingReceive;
  }

  protected getResetMode(agentId: string): "restart" | "session" | "full" | null {
    return this.resetInProgress.get(agentId) ?? null;
  }

  private getActivityIngestSeqKey(
    agentId: string,
    launchId: string | undefined,
    daemonInstanceId?: string,
  ): string {
    if (daemonInstanceId) {
      this.observeActivityDaemonGeneration(agentId, daemonInstanceId);
      return `${agentId}:daemon:${daemonInstanceId}:launch:${launchId ?? "legacy"}`;
    }
    if (launchId) return `${agentId}:launch:${launchId}`;
    const epoch = this.activityIngestEpochByAgent.get(agentId) ?? 0;
    return `${agentId}:legacy:${epoch}`;
  }

  private observeActivityDaemonGeneration(agentId: string, daemonInstanceId: string): void {
    const generations = this.activityDaemonGenerationsByAgent.get(agentId) ?? [];
    if (generations.includes(daemonInstanceId)) return;

    generations.push(daemonInstanceId);
    while (generations.length > AgentOrchestrator.ACTIVITY_DAEMON_GENERATIONS_PER_AGENT) {
      const expired = generations.shift();
      if (!expired) continue;
      const expiredPrefix = `${agentId}:daemon:${expired}:`;
      for (const key of this.lastClientSeqByActivityIngestKey.keys()) {
        if (key.startsWith(expiredPrefix)) {
          this.lastClientSeqByActivityIngestKey.delete(key);
        }
      }
    }
    this.activityDaemonGenerationsByAgent.set(agentId, generations);
  }

  private advanceActivityIngestEpoch(agentId: string): number {
    const next = (this.activityIngestEpochByAgent.get(agentId) ?? 0) + 1;
    this.activityIngestEpochByAgent.set(agentId, next);
    const legacyPrefix = `${agentId}:legacy:`;
    for (const key of this.lastClientSeqByActivityIngestKey.keys()) {
      if (key.startsWith(legacyPrefix)) {
        this.lastClientSeqByActivityIngestKey.delete(key);
      }
    }
    return next;
  }

  private async loadWakePlanInput(
    agentId: string,
    status: AgentStatus,
  ): Promise<WakePlanInput> {
    // TODO(lifecycle-v2/state-snapshot): delivery wake planning currently
    // builds a minimal in-memory state from DB status, reset state, and
    // runtime-profile gate. If machine reachability becomes authoritative for
    // delivery wake decisions, extend this builder to read the machine owner/
    // connection state instead of leaving reachability as "unknown".
    const migrationGateStatus = await agentMigrationService.getAgentMigrationGateStatus(agentId);
    const controlGate = migrationGateStatus.migration
      ? "zen_migrating"
      : await agentRuntimeProfileService.isRuntimeProfileMigrationGated(agentId)
        ? "runtime_profile_migration"
        : "open";
    const state = buildAgentLifecycleStateSnapshot({
      controlGate,
      dbStatus: status,
      resetMode: this.getResetMode(agentId),
      runtimeState: this.agentStateCache.get(agentId)?.runtimeState,
    });
    return { state };
  }

  /**
   * Emit `migration_aborted` for a migration the deadline sweep just aborted. The sweep's revision-checked update makes
   * it the single writer of each abort, so this runs exactly once per aborted migration.
   */
  async recordAgentMigrationAborted(migration: agentMigrationService.AgentMigrationRow, occurredAt: Date): Promise<void> {
    const event = agentMigrationService.createAgentMigrationLifecycleEvent({ migration, occurredAt });
    const agent = await this.getCachedAgent(migration.agentId);
    if (!agent) return;
    const { state } = await this.loadWakePlanInput(migration.agentId, agent.status);
    const span = this.tracer.startSpan("server.agent.migration.deadline_expired", {
      surface: "server",
      kind: "internal",
      attrs: {
        agent_id_present: Boolean(migration.agentId),
        migration_event_type: event.eventType,
        control_gate: state.controlGate,
      },
    });
    try {
      await applyAgentLifecycleProjectionPlan(
        reduceAgentMigrationControlLifecycle({ event, state }),
        this.lifecycleProjectionWriterDeps(),
        span,
      );
      span.end("ok");
    } catch (err) {
      span.end("error", { attrs: { error_class: errorClassOf(err) } });
    }
  }

  /**
   * Start an agent on the replica that owns its machine socket. That replica
   * is the one that checks the new launch's frames against the launchId it
   * minted, so the start is prepared there rather than here and forwarded as
   * a finished command. Without this, a start prepared on a peer leaves the
   * owner expecting an older launch and every frame of the new one is dropped
   * as stale_launch_guard.
   */
  async startAgent(agentId: string, options: StartAgentOptions = {}): Promise<AgentStartDispatchResult> {
    const routed = this.mayRunOnOwner(agentId) ? await this.runOnOwner(agentId, { kind: "start", options }) : null;
    if (!routed) return this.startAgentHere(agentId, options);
    return routed as AgentStartDispatchResult;
  }

  /**
   * Synchronous pre-check: false only when there is no shared replica state
   * (a single-replica deployment), so that path keeps its previous timing.
   * Whether the machine is local is decided in runOnOwner from the database:
   * this replica's cache is not told when a migration moves the agent.
   */
  protected mayRunOnOwner(_agentId: string): boolean {
    return this.replicaStateStore.isAvailable();
  }

  /**
   * Hand an agent operation to the replica that owns the agent's machine
   * socket. Returns null when it runs here: the machine socket is here (or
   * this replica is the registered owner while its registration completes),
   * the agent has no machine, or -- the fallbacks -- no owner is known, the
   * owner cannot answer intents, or the agent could not be loaded. Every
   * decision is recorded as `server.agent.owner_route`.
   */
  protected async runOnOwner(agentId: string, intent: OwnerIntent): Promise<StartIntentResult | null> {
    const decide = (route: OwnerRouteDecision, attrs: Record<string, unknown> = {}): null => {
      this.recordOwnerRoute(agentId, intent.kind, route, attrs);
      return null;
    };
    if (!this.replicaStateStore.isAvailable()) return decide("no_replica_state");
    // The owner refuses before running anything when its socket moved or the
    // agent no longer runs on that machine, so one more lookup cannot run the
    // operation twice.
    for (let attempt = 0; ; attempt += 1) {
      let agent: Awaited<ReturnType<AgentOrchestrator["loadAgentForStart"]>>;
      try {
        agent = await this.loadAgentForStart(agentId);
      } catch (error) {
        return decide("lookup_failed", { error_class: errorClassOf(error) });
      }
      const machineId = agent?.machineId;
      if (!agent || !machineId) return decide("no_machine");
      if (this.hasMachineLocally(machineId)) return decide("local_machine");
      const owner = await this.replicaStateStore.getMachineReplicaOwner(machineId);
      if (!owner) return decide("no_owner");
      // Registered here but not yet routable (registration in progress): the
      // local send reaches the socket, so this is the normal path.
      if (owner === REPLICA_ID) return decide("self_owner");
      if (!await this.ownerAcceptsIntents(owner)) return decide("owner_without_intents");
      try {
        const result = await this.routeIntentToOwner(owner, { requestId: crypto.randomUUID(), machineId, agentId, intent });
        this.recordOwnerRoute(agentId, intent.kind, "routed", { attempt });
        return result;
      } catch (error) {
        if (attempt === 0 && isStartIntentOwnerMoved(error)) continue;
        this.recordOwnerRoute(agentId, intent.kind, "route_failed", { attempt, error_class: errorClassOf(error) });
        throw rehydrateStartIntentError(error);
      }
    }
  }

  private recordOwnerRoute(
    agentId: string,
    intentKind: OwnerIntent["kind"],
    route: OwnerRouteDecision,
    attrs: Record<string, unknown> = {},
  ): void {
    this.recordEvent("server.agent.owner_route", {
      agent_id: agentId,
      intent_kind: intentKind,
      route,
      fallback: OWNER_ROUTE_FALLBACKS.has(route),
      ...attrs,
    });
  }

  /**
   * RFC 070 constructed wake context, per server, default OFF. Evaluated at
   * every agent start so turning the flag off takes effect on the next start;
   * any evaluation failure keeps it off.
   */
  protected async constructedWakeContextEnabled(serverId: string | null | undefined): Promise<boolean> {
    if (!serverId) return false;
    try {
      return (await evaluateFeatureFlag({ key: CONSTRUCTED_WAKE_CONTEXT_FEATURE_FLAG_KEY, serverId })).enabled === true;
    } catch (error) {
      console.warn(`[AgentOrchestrator] ${CONSTRUCTED_WAKE_CONTEXT_FEATURE_FLAG_KEY} evaluation failed; leaving it off`, error);
      return false;
    }
  }

  /**
   * Sub-agent delegation prompt, per server, default OFF. Evaluated at every
   * agent start; any evaluation failure keeps it off.
   */
  protected async subagentDelegationEnabled(serverId: string | null | undefined): Promise<boolean> {
    if (!serverId) return false;
    try {
      return (await evaluateFeatureFlag({ key: SUBAGENT_DELEGATION_FEATURE_FLAG_KEY, serverId })).enabled === true;
    } catch (error) {
      console.warn(`[AgentOrchestrator] ${SUBAGENT_DELEGATION_FEATURE_FLAG_KEY} evaluation failed; leaving it off`, error);
      return false;
    }
  }

  /** task #359: RFC 072 §7 passive AX, per server, default off (see featureFlagService). */
  protected async passiveAxEnabled(serverId: string | null | undefined): Promise<boolean> {
    if (!serverId) return false;
    try {
      return (await evaluateFeatureFlag({ key: PASSIVE_AX_FEATURE_FLAG_KEY, serverId })).enabled === true;
    } catch (error) {
      console.warn(`[AgentOrchestrator] ${PASSIVE_AX_FEATURE_FLAG_KEY} evaluation failed; leaving it off`, error);
      return false;
    }
  }

  protected ownerAcceptsIntents(replicaId: string): Promise<boolean> {
    return replicaSupportsOwnerIntents(replicaId);
  }

  protected routeIntentToOwner(ownerReplicaId: string, request: StartIntentRequest): Promise<StartIntentResult> {
    return routeStartIntent(ownerReplicaId, request);
  }

  /**
   * Run an operation another replica routed here. Only the replica that still
   * holds the machine's socket, for the machine the agent is on now, may run
   * it; otherwise the requester is told the owner moved and looks again.
   */
  async handleStartIntent(request: StartIntentRequest): Promise<StartIntentResult> {
    if (!this.hasMachineLocally(request.machineId)) {
      throw new StartIntentOwnerMovedError();
    }
    // A requester with a stale cache can route by the agent's previous
    // machine. Running it here would dispatch to the new machine from a
    // replica that does not hold its socket, which is what routing avoids.
    const agent = await this.loadAgentForStart(request.agentId);
    if (agent && agent.machineId !== request.machineId) {
      throw new StartIntentOwnerMovedError();
    }
    const { intent } = request;
    switch (intent.kind) {
      case "start":
        return this.startAgentHere(request.agentId, intent.options);
      case "stop":
        await this.stopAgentHere(request.agentId, intent.reason);
        return { outcome: "done" };
      case "reset":
        await this.resetAgentHere(request.agentId, intent.mode, intent.options);
        return { outcome: "done" };
    }
  }

  protected async startAgentHere(agentId: string, options: StartAgentOptions = {}): Promise<AgentStartDispatchResult> {
    const { resumePrompt, wakeMessageTransient } = options;
    let { wakeMessage } = options;
    // Load from DB (and populate cache) for start — need full state
    const agent = await this.loadAgentForStart(agentId);
    const startCause = options.startCause ?? (wakeMessage ? "message" : resumePrompt ? "resume" : "manual");
    if (!agent) {
      this.recordLifecycleEvent({
        agentId,
        machineId: null,
        action: "start",
        outcome: "failed",
        cause: startCause,
        detail: "agent_not_found",
      });
      throw new Error(`Agent ${agentId} not found`);
    }
    const previousStatus = narrowPersistedAgentStatus(agent.status);
    if (!previousStatus) {
      console.warn(
        `[Agent ${agentId}] Invalid persisted agent status ${JSON.stringify(agent.status)} before start; failing closed`,
      );
    }
    // A manual stop is the one truly offline state: neither a message wake nor
    // a daemon app-inbox wake (task #1103) may undo it; only a manual start does.
    if ((wakeMessage || options.startCause === "app_inbox_wake") && previousStatus === "stopped") {
      this.updateCache(agentId, { status: "stopped" });
      this.recordLifecycleEvent({
        agentId,
        machineId: agent.machineId,
        action: "wake",
        outcome: "suppressed",
        cause: startCause,
        previousStatus,
      });
      return { outcome: "skipped", reason: "manual_stop" };
    }
    // task #1119: after consecutive early exits, automatic wakes (message,
    // app-inbox, rejected-delivery conversion) are paused for the episode.
    // A human start/resume always passes and opens a new episode below.
    const humanStart = startCause === "manual" || startCause === "resume";
    if (!humanStart && await this.wakeCrashLoopBreaker.isBlocked(agentId)) {
      this.recordLifecycleEvent({
        agentId,
        machineId: agent.machineId,
        action: "wake",
        outcome: "suppressed",
        cause: startCause,
        previousStatus,
        detail: "wake_crash_loop_blocked",
      });
      return { outcome: "skipped", reason: "wake_crash_loop_blocked" };
    }
    // RFC 071 §4.3/§5: the terminal-failure breaker gates every start that is
    // not an explicit human control (the #1119 inference above is not used:
    // tracked mentions, migrations and auto-starts reach "manual" there, F2).
    // The gate only reads (and records what a refusal learned); the claim
    // below decides. Gate order (RFC 7): manual stop, #1119, then this.
    const terminalControl: TerminalStartControl = options.control === "human_start" ? "human_start" : "automatic";
    const terminalContext = this.terminalStartContext(agentId, agent.machineId);
    if (terminalControl === "automatic") {
      const refusal = await this.terminalStartGate(agentId, terminalContext, wakeMessage).catch((error: unknown) => {
        this.recordLifecycleEvent({
          agentId,
          machineId: agent.machineId,
          action: "start",
          outcome: "failed",
          cause: startCause,
          previousStatus,
          detail: "terminal_failure_breaker_storage_unavailable",
        });
        throw new TerminalBreakerStorageUnavailableError(error);
      });
      if (refusal) {
        this.recordTerminalWakeSuppressed(agentId, agent.machineId, startCause, previousStatus, refusal, terminalContext);
        await this.projectTerminalBlock(agentId, { includeNeedsManual: true });
        return { outcome: "skipped", reason: refusal };
      }
    }
    const rollbackStatus = previousStatus ?? "inactive";

    if (isExternalAgentRuntime(agent.runtime)) {
      this.recordLifecycleEvent({
        agentId,
        machineId: agent.machineId,
        action: "start",
        outcome: "failed",
        cause: startCause,
        previousStatus,
        detail: "external_agent_not_startable",
      });
      throw new Error("External agents are operator-run; Slock never starts or manages their runtime (SHA-V0-006C).");
    }

    if (!agent.machineId) {
      this.recordLifecycleEvent({
        agentId,
        machineId: null,
        action: "start",
        outcome: "failed",
        cause: startCause,
        previousStatus,
        detail: "machine_unassigned",
      });
      throw new Error("No machine assigned. Please assign a machine to this agent first.");
    }

    const normalizedRuntimeConfig = hydrateRuntimeConfig(agent);
    const launchRuntimeFields = runtimeConfigToLaunchFields(normalizedRuntimeConfig);
    if (launchRuntimeFields.runtime === "kimi-sdk" && launchRuntimeFields.reasoningEffort !== null) {
      const detected = await this.detectMachineRuntimeModels(agent.machineId, "kimi-sdk");
      const selectedModel = detected.kind === "live"
        ? detected.value.models.find((candidate) => candidate.id === launchRuntimeFields.model)
        : undefined;
      if (
        detected.kind === "live"
        && !selectedModel?.supportedReasoningEfforts?.includes(launchRuntimeFields.reasoningEffort)
      ) {
        this.recordLifecycleEvent({
          agentId,
          machineId: agent.machineId,
          action: "start",
          outcome: "failed",
          cause: startCause,
          previousStatus,
          detail: "kimi_reasoning_effort_upgrade_required",
        });
        throw new KimiReasoningEffortUpgradeRequiredError();
      }
    }

    // Catalog detect is diagnostic, not a delivery gate: the catch below swallows every
    // BuiltInModelCatalogError -- all four codes of BuiltInModelCatalogErrorCode -- and continues
    // the spawn, so the runtime reports the real start failure instead of the preflight guessing at
    // one. Continuing here does not promise the model resolves or runs.
    //
    // The write paths are narrower: validateBuiltInPresetForWrite in routes/agents.ts demotes only
    // builtin_model_unsupported_by_target; the other codes still reject there.
    let catalogValidation: Awaited<
      ReturnType<AgentOrchestrator["validateBuiltInPresetForMachine"]>
    > = null;
    try {
      catalogValidation = await this.validateBuiltInPresetForMachine(
        agent.machineId,
        normalizedRuntimeConfig,
      );
    } catch (error) {
      if (error instanceof BuiltInModelCatalogError) {
        console.warn(
          `[Agent ${agentId}] Built-in catalog preflight ${error.code}; continuing spawn so runtime can fail the start: ${error.message}`,
        );
      } else {
        throw error;
      }
    }
    const releaseCatalogAuthority = catalogValidation
      ? this.acquireBuiltInCatalogAuthority(
          agent.machineId,
          catalogValidation.authority,
        )
      : () => undefined;

    try {
    let wakeLockHeld = false;
    if (this.replicaStateStore.isAvailable()) {
      wakeLockHeld = await this.replicaStateStore.acquireWakeLock(agentId);
      if (!wakeLockHeld) {
        this.recordLifecycleEvent({
          agentId,
          machineId: agent.machineId,
          action: "start",
          outcome: "skipped",
          cause: startCause,
          previousStatus,
          detail: "wake_lock_held",
        });
        console.log(`[Agent ${agentId}] Start skipped: wake lock held on another replica`);
        if (options.requireQueueReceipt) {
          throw new CrossReplicaQueueReceiptUnavailableError();
        }
        return { outcome: "skipped", reason: "wake_lock_held" };
      }
    }

    // The guard state this start found. It is carried into the refreshed
    // cache entry unchanged: prepareStartLaunchGuard() below decides whether
    // the new launch replaces it or the start drops to legacy, and a failed
    // send restores it (task #1129). Resetting it to legacy here would let a
    // failed dispatch accept frames from any launch.
    const launchGuardBeforeStart = this.snapshotLaunchGuard(agentId);
    // Populate/refresh cache
    const state: CachedAgentState = {
      id: agent.id,
      status: "active",
      machineId: agent.machineId,
      sessionId: agent.sessionId,
      expectedLaunchId: launchGuardBeforeStart.expectedLaunchId,
      launchGuardMode: launchGuardBeforeStart.launchGuardMode,
      serverId: agent.serverId,
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      model: launchRuntimeFields.model,
      runtime: launchRuntimeFields.runtime,
      lastRuntimeError: agent.lastRuntimeError ?? null,
      runtimeConfig: normalizedRuntimeConfig,
      runtimeState: "starting",
      reasoningEffort: launchRuntimeFields.reasoningEffort,
      envVars: launchRuntimeFields.envVars,
    };
    this.agentStateCache.set(agentId, state);

    const machine = agent.machineId ? await this.loadRuntimeContextMachine(asMachineId(agent.machineId)) : null;
    const daemonVersion = agent.machineId ? this.getMachineDaemonVersion(agent.machineId) : null;
    const config: AgentConfig = {
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      model: launchRuntimeFields.model,
      runtime: launchRuntimeFields.runtime,
      runtimeConfig: normalizedRuntimeConfig,
      reasoningEffort: launchRuntimeFields.reasoningEffort,
      executionMode: agent.executionMode,
      envVars: launchRuntimeFields.envVars,
      sessionId: agent.sessionId,
      serverUrl: process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3001}`,
      authToken: "", // Daemon will use its own API key
      runtimeContext: {
        agentId: agent.id,
        serverId: agent.serverId,
        machineId: agent.machineId,
        machineName: machine?.name ?? null,
        machineDescription: machine?.description ?? null,
        machineHostname: machine?.hostname ?? null,
        machineOs: machine?.os ?? null,
        daemonVersion,
        workspacePath: null,
      },
    };
    const runtimeProfileControl = await agentRuntimeProfileService.getPendingRuntimeProfileControl(agentId);
    if (runtimeProfileControl) {
      config.runtimeProfileControl = runtimeProfileControl;
    }
    if (await this.constructedWakeContextEnabled(agent.serverId)) {
      config.constructedWakeContext = true;
    }
    if (await this.subagentDelegationEnabled(agent.serverId)) {
      config.subagentDelegation = true;
    }
    if (await this.passiveAxEnabled(agent.serverId)) {
      config.passiveAx = true;
    }

    // task #319 — installed-app catalog rides agent:start config (server-level
    // data, identical for all agents on this server). A catalog failure must
    // never block or break agent start; the daemon degrades to no section.
    try {
      const installedApps = await oauthService.listInstalledAppPromptCatalog(agent.serverId);
      if (installedApps.length > 0) {
        config.installedApps = installedApps;
      }
    } catch (err) {
      this.tracer.emitEvent("server.agent.installed_app_catalog_failed", {
        surface: "server",
        attrs: {
          agent_id: agentId,
          server_id: agent.serverId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }

    // Query unread rows so resume can deterministically re-drive durable
    // messages that arrived while a manual-stopped/sessioned agent was offline.
    let unreadSummary: Record<string, number> | undefined;
    let resumeMessages: AgentMessage[] | undefined;
    // task #358: set when the catch-up ran but could not read the inbox.
    let catchupUnverified = false;
    // task #1221: messages refused as wakes during a start-failure block are
    // owed to the start that follows it, whether or not the agent has a session
    // (a fresh session has no history to resume, so without this they would
    // only surface if the agent read its inbox itself).
    const catchupOwed = await this.wakeCrashLoopBreaker.isCatchupOwed(agentId);
    const catchupReplacesWake = catchupOwed && wakeMessage !== undefined && !wakeMessageTransient;
    if (agent.sessionId || catchupOwed) {
      const span = this.tracer.startSpan("server.agent.resume_catchup.prepare", {
        surface: "server",
        kind: "internal",
        attrs: {
          agent_id: agentId,
          machine_id: agent.machineId,
          server_id: agent.serverId,
          session_id: agent.sessionId,
          agent_id_present: Boolean(agentId),
          machine_id_present: Boolean(agent.machineId),
          session_id_present: Boolean(agent.sessionId),
          start_cause: startCause,
          wake_message_present: Boolean(wakeMessage),
          resume_prompt_present: Boolean(resumePrompt),
        },
      });
      try {
        // One read of the unified chain feeds both the summary and the catch-up.
        // It is the only recovery source: when it is unavailable the resume
        // carries no summary or catch-up, and the start proceeds (live delivery
        // is unaffected).
        const inbox = await this.selectResumeInbox(agentId);
        if (inbox.source === "unavailable") {
          catchupUnverified = true;
          span.addEvent("resume_catchup.skipped", {
            outcome: "inbox_unavailable",
            reason: inbox.reason,
          });
          span.end("ok", { attrs: { outcome: "skipped", reason: "inbox_unavailable" } });
        } else {
          const chain = inbox.rows;
          span.addEvent("resume_catchup.inbox_source", {
            source: inbox.source,
            reason: "chain",
            chain_row_count: chain.length,
          });
          const plan = await getServerPlan(agent.serverId);
          const historyCutoff = getHistoryCutoff(plan);
          const counts = await channelService.getAgentUnreadCounts(agentId, chain);
          if (Object.keys(counts).length > 0) unreadSummary = channelService.capAgentUnreadSummary(counts);
          if ((!wakeMessage || catchupReplacesWake) && !resumePrompt) {
            const catchup = await messageService.getAgentResumeCatchupMessages(agentId, historyCutoff, { chain });
            if (catchup.messages.length > 0) {
              resumeMessages = catchup.messages;
              // The daemon ignores resumeMessages when a wake message is present,
              // so the catch-up replaces the wake. The catch-up is bounded; if it
              // left the wake message out, append it so it is never dropped.
              if (catchupReplacesWake && wakeMessage) {
                const wake = wakeMessage;
                if (!catchup.messages.some((m) => m.message_id === wake.message_id)) {
                  resumeMessages = [...catchup.messages, wake];
                }
                wakeMessage = undefined;
              }
            }
            span.addEvent("resume_catchup.selected", {
              outcome: catchup.messages.length > 0
                ? "messages_selected"
                : Object.keys(counts).length > 0
                  ? "summary_only"
                  : "none",
              reason: catchup.messages.length > 0
                ? "messages_selected"
                : Object.keys(counts).length > 0
                  ? "unread_summary_only"
                  : "no_unread",
              unread_channel_count: Object.keys(counts).length,
              candidate_channel_count: catchup.candidateChannelCount,
              resume_message_count: catchup.messages.length,
              resume_max_seq_present: catchup.maxSeq != null,
            });
          } else {
            span.addEvent("resume_catchup.skipped", {
              outcome: wakeMessage ? "wake_message_present" : "resume_prompt_present",
              reason: wakeMessage ? "wake_message_present" : "resume_prompt_present",
              unread_channel_count: Object.keys(counts).length,
            });
          }
          span.end("ok", { attrs: { outcome: "prepared", reason: "resume_catchup_checked" } });
        }
      } catch (err) {
        catchupUnverified = true;
        span.addEvent("resume_catchup.failed", {
          outcome: "failed",
          reason: "query_failed",
          error_type: errorClassOf(err),
        });
        span.end("error", {
          attrs: {
            outcome: "failed",
            reason: "query_failed",
            error_class: errorClassOf(err),
          },
        });
      }
    }

    // Only set launch guard if the daemon supports it (>= 0.30.1).
    // Old daemons ignore the launchId field and never echo it back,
    // which causes all their lifecycle events to be silently dropped.
    // RFC 071 §4.3: the launchId is minted first, the breakers are claimed,
    // and only then is the guard armed, so a start that loses the claim has
    // touched nothing shared.
    const launchId = await this.planStartLaunchId(agent.machineId);
    let terminalClaim: Extract<CombinedClaimResult, { ok: true }> | null = null;
    const claimTerminal = await this.usesTerminalClaim(agentId, terminalContext, terminalControl).catch((error: unknown) => {
      this.updateCache(agentId, { status: rollbackStatus });
      if (wakeLockHeld) this.releaseWakeLock(agentId);
      throw new TerminalBreakerStorageUnavailableError(error);
    });
    if (claimTerminal) {
      const claimed = await this.claimTerminalStart(agentId, {
        launchId,
        sessionId: agent.sessionId ?? null,
        context: terminalContext,
        control: terminalControl,
        human: humanStart,
      }).catch((error: unknown) => {
        // RFC 071 storage: a start whose pending entry cannot be recorded is
        // not dispatched (RFC 4.3 rule 1), human or automatic. Same cleanup as
        // a failed dispatch; nothing shared was written.
        this.updateCache(agentId, { status: rollbackStatus });
        if (wakeLockHeld) this.releaseWakeLock(agentId);
        this.recordLifecycleEvent({
          agentId,
          machineId: agent.machineId,
          action: "start",
          outcome: "failed",
          cause: startCause,
          previousStatus,
          detail: "terminal_failure_breaker_storage_unavailable",
        });
        throw new TerminalBreakerStorageUnavailableError(error);
      });
      if (!claimed.ok) {
        // A concurrent claimer won (or #1119 blocked in between): nothing was written.
        this.updateCache(agentId, { status: rollbackStatus });
        if (wakeLockHeld) this.releaseWakeLock(agentId);
        if (claimed.reason === "wake_crash_loop_blocked") {
          this.recordLifecycleEvent({
            agentId,
            machineId: agent.machineId,
            action: "wake",
            outcome: "suppressed",
            cause: startCause,
            previousStatus,
            detail: "wake_crash_loop_blocked",
          });
        } else {
          this.recordTerminalWakeSuppressed(agentId, agent.machineId, startCause, previousStatus, claimed.reason, terminalContext);
          await this.projectTerminalBlock(agentId, { includeNeedsManual: true });
        }
        return { outcome: "skipped", reason: claimed.reason };
      }
      terminalClaim = claimed;
    }
    this.armStartLaunchGuard(agentId, launchId);
    const startDispatchId = crypto.randomUUID();
    // task #358: a caller's own resume prompt or a wake message already gives
    // the agent something true to act on. Otherwise, if the catch-up could not
    // be read, say so instead of letting the daemon report an empty resume.
    const startResumePrompt = resumePrompt
      ?? (catchupUnverified && agent.sessionId && !wakeMessage ? RESUME_CATCHUP_UNAVAILABLE_PROMPT : undefined);
    const startDispatchSpan = this.tracer.startSpan("server.agent.start_dispatch", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "producer",
      attrs: {
        agent_id: agentId,
        machine_id: agent.machineId,
        launch_id: launchId,
        start_dispatch_id: startDispatchId,
        start_cause: startCause,
        resume_prompt_source: resumePrompt ? "caller" : startResumePrompt ? "catchup_unverified" : "none",
      },
    });
    const startFields = {
      agentId,
      config,
      wakeMessage,
      wakeMessageTransient: wakeMessage ? wakeMessageTransient : undefined,
      ...(resumeMessages ? { resumeMessages } : {}),
      unreadSummary,
      resumePrompt: startResumePrompt,
      launchId,
      startDispatchId,
      traceparent: formatTraceparent(startDispatchSpan.context),
      // RFC 071 outbox: only on a start the terminal breaker claimed. An older
      // daemon ignores them; a start that was not claimed is unchanged.
      ...(terminalClaim
        ? {
          breakerGeneration: terminalClaim.token.generation,
          takeoverEpoch: terminalClaim.token.takeoverEpoch,
          ...(terminalControl === "human_start" ? { humanStart: true } : {}),
        }
        : {}),
    };
    const startMessage: ServerToMachineMessage = { type: "agent:start", ...startFields };
    // task #1119: record the start BEFORE the dispatch leaves this replica, so
    // an exit that becomes visible while the send is still in flight already
    // has its start on record (review counterexample: a fast crash landed at
    // count 0). The write sits inside the dispatch's failure scope: if the
    // shared store rejects it, or the send fails, the same cleanup runs
    // (guard rollback, wake lock release, lifecycle event) and the record is
    // rolled back when it was written.
    const targetMachineId = agent.machineId;
    await this.runInActiveSpan(startDispatchSpan, async () => {
      // RFC 071: a claimed start already wrote its #1119 start in the combined claim.
      let wakeCrashLoopStartRecord: WakeCrashLoopStartRecord | null = terminalClaim?.crashLoopStart ?? null;
      // Whether the agent:start may have left this replica: only a send that
      // returned false (or never ran) proves it did not (RFC X-6(b)).
      let dispatchMayHaveLeft = false;
      try {
        if (!terminalClaim) {
          wakeCrashLoopStartRecord = await this.wakeCrashLoopBreaker.recordStart(
            agentId,
            launchId ?? null,
            this.clock.now(),
            { human: humanStart },
          );
        }
        // task #1221: only a start that actually carries the owed catch-up
        // (resumeMessages the daemon will use: no wake message, no resume
        // prompt) can clear it, and only once its runtime reports active.
        if (catchupOwed && launchId && resumeMessages && resumeMessages.length > 0 && !wakeMessage && !resumePrompt) {
          await this.wakeCrashLoopBreaker.markCatchupCarried(agentId, launchId);
        }
        if (options.requireQueueReceipt) {
          // Strict manual Notify cannot publish cross-replica without a target-side
          // queue acknowledgement. Fail before publishing so a retry cannot wake
          // a remote daemon twice after the source reports `dropped`.
          dispatchMayHaveLeft = true;
          const sent = this.sendLocalAgentStartWithAckRetry(
            targetMachineId,
            startMessage as AgentStartMessage & { startDispatchId: string },
          );
          dispatchMayHaveLeft = sent;
          if (!sent) {
            throw new CrossReplicaQueueReceiptUnavailableError();
          }
        } else {
          dispatchMayHaveLeft = true;
          const sent = await this.sendAgentStartWithAckRetry(
            targetMachineId,
            startMessage as AgentStartMessage & { startDispatchId: string },
          );
          dispatchMayHaveLeft = sent;
          if (!sent) {
            throw new RouteFailureError(
              "daemon_offline",
              "Machine offline. Please start your local daemon.",
            );
          }
        }
        // RFC 071 §9: a dispatched start ends any shown block; the next one is shown again.
        this.projectedTerminalBlocks.delete(agentId);
        if (terminalControl === "human_start") {
          // RFC 071 outbox: a human start is the daemon's only way out of
          // unreliable outcome storage; its next `ready` lists the agent again
          // if the daemon could not resolve it.
          this.machineConnections.get(targetMachineId)?.runtimeOutcomeUnreliableAgents?.delete(agentId);
        }
        startDispatchSpan.end("ok", {
          attrs: {
            outcome: "sent",
            queue_depth: this.pendingStartQueueDepth(targetMachineId),
          },
        });
      } catch (err) {
        startDispatchSpan.end("error", {
          attrs: {
            outcome: "send_failed",
            error_class: errorClassOf(err),
          },
        });
        this.terminalizePendingAgentStart(startDispatchId, "superseded");
        this.updateCache(agentId, { status: rollbackStatus });
        this.rollbackStartLaunchGuard(agentId, launchGuardBeforeStart, launchId);
        if (wakeLockHeld) this.releaseWakeLock(agentId);
        if (terminalClaim) {
          // RFC 071 §4.3: ownership-checked; the pending entry stays unless the start provably never left.
          try {
            const outcome = await this.terminalFailureBreaker.rollbackClaim(agentId, terminalClaim.token, {
              nowMs: this.clock.now(),
              dispatchLeftReplica: dispatchMayHaveLeft,
            });
            this.recordEvent("terminal_breaker.rollback", { step: "claim", outcome, dispatch_left_replica: dispatchMayHaveLeft });
          } catch (rollbackErr) {
            console.warn(`[Agent ${agentId}] terminal-failure breaker claim rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
          }
        }
        if (wakeCrashLoopStartRecord) {
          // Shared-store rollback is best effort: a failure here must not stop
          // the local cleanup above or the lifecycle record below.
          try {
            await this.wakeCrashLoopBreaker.rollbackStart(agentId, wakeCrashLoopStartRecord);
          } catch (rollbackErr) {
            console.warn(`[Agent ${agentId}] wake crash-loop start rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
          }
        }
        this.recordLifecycleEvent({
          agentId,
          machineId: targetMachineId,
          action: "start",
          outcome: "failed",
          cause: startCause,
          previousStatus,
          detail: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });
    this.advanceActivityIngestEpoch(agentId);

    // Init inbox
    if (!this.agentInboxes.has(agentId)) {
      this.agentInboxes.set(agentId, { inbox: [], pendingReceive: null });
    }

    // TODO(lifecycle-v2/server-producer): manual/lazy/resume start is
    // server-owned. Construct the canonical runtime_spawned event at the start
    // planner boundary (or make the planner return it) and remove this legacy
    // action adapter once start no longer flows through the compatibility layer.
    const { event } = adaptStartLifecycleEvent({
      serverId: agent.serverId,
      agentId,
      machineId: agent.machineId,
      launchId,
      previousStatus,
      startCause,
      now: () => new Date(this.clock.now()),
    });
    const span = this.tracer.startSpan("server.agent.lifecycle.start.apply", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "internal",
      attrs: {
        agent_id: agentId,
        authority: "server_control",
        event_kind: "start_requested",
        machine_id: agent.machineId,
        previous_status: previousStatus ?? null,
        reason: event.reason,
        server_id: agent.serverId,
        source: "server_control",
        start_cause: startCause,
      },
    });
    try {
      await this.runInActiveSpan(span, async () => {
        const result = await applyAgentLifecycleProjectionPlan(
          reduceStartLifecycle({
            event,
            state: buildAgentLifecycleStateSnapshot({
              dbStatus: previousStatus ?? agent.status,
              intentState: "running_allowed",
              launchId,
              machineId: agent.machineId,
              machineReachability: agent.machineId ? "reachable" : "unknown",
              runtimeState: "starting",
            }),
          }),
          this.lifecycleProjectionWriterDeps(),
          span,
        );
        this.recordLifecycleEvent({
          agentId,
          machineId: agent.machineId,
          action: "start",
          outcome: "completed",
          cause: startCause,
          previousStatus,
          nextStatus: "active",
        });
        span.end("ok", {
          attrs: {
            outcome: "applied",
            ...liveActivityRootTraceAttrs(result.liveActivityResult),
          },
        });
      });
    } catch (err) {
      span.end("error", { attrs: { error_class: errorClassOf(err) } });
      throw err;
    }
    return { outcome: "dispatched" };
    } finally {
      releaseCatalogAuthority();
    }
  }

  /**
   * Stop on the replica that owns the machine socket, so the guards and
   * trackers the stop clears are the ones that replica checks frames against.
   */
  async stopAgent(
    agentId: string,
    reason: StopAgentReason = "manual",
    options: { withinReset?: boolean } = {},
  ): Promise<AgentStopResult> {
    if (this.mayRunOnOwner(agentId) && await this.runOnOwner(agentId, { kind: "stop", reason })) return { delivered: true };
    const result = await this.stopAgentHere(agentId, reason);
    if (result.delivered) return result;
    // No replica holds the machine socket, so the daemon was not told.
    if (reason === "manual") {
      // The agent is persisted `stopped`; ready reconcile force-stops it when
      // the daemon reconnects (force-stop-and-stay-offline).
      this.recordEvent("server.agent.stop.undelivered", { agent_id: agentId, reason, applies_on: "reconnect" });
      return result;
    }
    // An internal stop persists `inactive`, which is also what an observed
    // disconnect writes, so ready reconcile cannot tell "we want it stopped"
    // from "we saw it go away" and adopts a still-running process. Until RFC
    // 072 records the intent itself, this stop is lost when undelivered.
    this.recordEvent("server.agent.stop.undelivered", {
      agent_id: agentId,
      reason,
      applies_on: "none",
      within_reset: options.withinReset === true,
    });
    // A reset still clears the session offline (stop_undelivered is recorded
    // above); a standalone internal stop tells its caller.
    if (options.withinReset) return result;
    throw new RouteFailureError("daemon_offline", `Agent ${agentId} stop could not reach its Computer`);
  }

  protected async stopAgentHere(agentId: string, reason: StopAgentReason = "manual"): Promise<AgentStopResult> {
    // task #1119: an operator stop is intent, not a crash; forget the streak.
    if (reason === "manual") await this.wakeCrashLoopBreaker.recordManualStop(agentId);
    // RFC 071 §5: not E3. A probe in flight is cleared (half_open → open, step unchanged).
    if (reason === "manual" && this.runtimeOutcomeAckEnabled) {
      await this.terminalFailureBreaker.recordManualStop(agentId, this.clock.now()).catch((error: unknown) => {
        console.warn(`[Agent ${agentId}] terminal-failure breaker manual stop not recorded: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    const agent = await this.getCachedAgent(agentId);
    if (!agent) return { delivered: true };
    const previousStatus = agent.status;
    const action = planStopAction({ reason });
    const nextStatus: AgentStatus = action === "persist-stopped" ? "stopped" : "inactive";
    const context: StopApplyContext = {
      agentId,
      serverId: agent.serverId,
      machineId: agent.machineId,
      reason,
      previousStatus,
      nextStatus,
    };

    return this.applyStopAction(context);
  }

  protected async applyStopAction(context: StopApplyContext): Promise<AgentStopResult> {
    const correlationId = this.makeLifecycleCorrelationId(
      "agent",
      context.agentId,
      "stop",
      context.reason,
      crypto.randomUUID(),
    );
    // TODO(lifecycle-v2/server-producer): stop is server-owned. Have the stop
    // planner emit canonical manual_stop_requested/runtime_interrupted events
    // with the stop correlation id and reason, then delete this adapter call.
    const { event } = adaptStopLifecycleEvent({
      serverId: context.serverId,
      agentId: context.agentId,
      machineId: context.machineId,
      reason: context.reason,
      previousStatus: context.previousStatus,
      nextStatus: context.nextStatus,
      stopCorrelationId: correlationId,
      now: () => new Date(this.clock.now()),
    });
    const activityDedupeKey = this.makeLifecycleDedupeKey("agent", context.agentId, "stop", correlationId);
    const span = this.tracer.startSpan("server.agent.lifecycle.stop.apply", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "internal",
      attrs: {
        agent_id: context.agentId,
        authority: "server_control",
        event_kind: "stop_requested",
        machine_id: context.machineId,
        reason: context.reason,
        previous_status: context.previousStatus,
        next_status: context.nextStatus,
        server_id: context.serverId,
        source: "server_control",
      },
    });
    try {
      return await this.runInActiveSpan(span, async (): Promise<AgentStopResult> => {
        const result = await applyAgentLifecycleProjectionPlan(
          reduceStopLifecycle({
            activityDedupeKey,
            event,
            nextStatus: context.nextStatus,
            state: buildAgentLifecycleStateSnapshot({
              dbStatus: context.previousStatus,
              intentState: context.nextStatus === "stopped" ? "manual_stopped" : "running_allowed",
              machineId: context.machineId,
              machineReachability: context.machineId ? "reachable" : "unknown",
              runtimeState: "not_running",
            }),
          }),
          this.lifecycleProjectionWriterDeps(),
          span,
        );
        if (context.reason === "manual") {
          await this.clearLastRuntimeError(context.agentId);
        }
        if (context.reason === "internal") {
          const nextIngestEpoch = this.advanceActivityIngestEpoch(context.agentId);
          this.recordEvent("activity.ingest.rebaseline", {
            reason: "internal_stop",
            activity_ingest_epoch: nextIngestEpoch,
          });
        }
        const clearedPendingDeliveries = this.clearPendingAgentDeliveryAcksForAgent(context.agentId);
        if (clearedPendingDeliveries > 0) {
          this.recordEvent("server.delivery.retry.cleared", {
            outcome: "cleared",
            reason: "agent_stopped",
            pending_delivery_count: clearedPendingDeliveries,
          });
        }
        const clearedPendingStarts = this.clearPendingAgentStartsForAgent(
          context.agentId,
          "stopped",
        );
        if (clearedPendingStarts > 0) {
          this.recordEvent("server.start_dispatch.cleared", {
            outcome: "terminal",
            terminal_reason: "stopped",
            pending_start_count: clearedPendingStarts,
          });
        }
        this.recordLifecycleEvent({
          agentId: context.agentId,
          machineId: context.machineId,
          action: "stop",
          outcome: "completed",
          cause: context.reason,
          previousStatus: context.previousStatus,
          nextStatus: context.nextStatus,
        });
        span.end("ok", {
          attrs: {
            outcome: "applied",
            stop_sent: result.stopSent ?? false,
            ...liveActivityRootTraceAttrs(result.liveActivityResult),
          },
        });
        // No machine means no process to stop.
        return { delivered: result.stopSent !== false };
      });
    } catch (err) {
      span.end("error", { attrs: { error_class: errorClassOf(err) } });
      throw err;
    }
  }

  /**
   * Reset on the replica that owns the machine socket: its reset window is the
   * one consulted when the old process's frames arrive, and the stop/start the
   * reset performs then run there too.
   */
  async resetAgent(
    agentId: string,
    mode: "restart" | "session" | "full",
    options: ResetAgentOptions = {},
  ) {
    if (this.mayRunOnOwner(agentId) && await this.runOnOwner(agentId, { kind: "reset", mode, options })) return;
    await this.resetAgentHere(agentId, mode, options);
  }

  protected async resetAgentHere(
    agentId: string,
    mode: "restart" | "session" | "full",
    options: ResetAgentOptions = {},
  ) {
    if (this.resetInProgress.has(agentId)) {
      this.recordLifecycleEvent({
        agentId,
        machineId: null,
        action: "reset",
        outcome: "skipped",
        cause: mode,
        detail: "reset_in_progress",
      });
      return;
    }
    this.resetInProgress.set(agentId, mode);
    try {
      // Get machine info before stopping (cache may be populated)
      const agentBefore = await this.getCachedAgent(agentId);
      const previousStatus = agentBefore?.status ?? null;
      const shouldRestart = agentBefore?.status === "stopped"
        ? (options.restartIfStopped ?? true)
        : ((options.restartEvenIfInactive ?? true) || agentBefore?.status === "active");
      const plan = planResetActions({
        mode,
        hasMachine: Boolean(agentBefore?.machineId),
        restart: shouldRestart,
      });
      const context: ResetApplyContext = {
        agentId,
        serverId: agentBefore?.serverId ?? null,
        mode,
        previousStatus,
        machineId: agentBefore?.machineId ?? null,
        ...(options.terminalControl ? { terminalControl: options.terminalControl } : {}),
      };
      this.recordLifecycleEvent({
        agentId,
        machineId: agentBefore?.machineId ?? null,
        action: "reset",
        outcome: "attempted",
        cause: mode,
        previousStatus,
      });
      await this.applyResetPlan(context, plan);
    } finally {
      this.resetInProgress.delete(agentId);
    }
  }

  protected async applyResetPlan(context: ResetApplyContext, plan: ResetPlanAction[]) {
    if (plan.includes("stop-internal")) {
      await this.stopAgent(context.agentId, "internal", { withinReset: true });
    }
    // RFC 071 §5: an E3 reset lifts the terminal-failure breaker whether or
    // not the plan restarts (session / full drop the failing session). The
    // restart below is then the human takeover start.
    if (context.terminalControl) await this.liftTerminalBreaker(context.agentId, context.terminalControl);

    if (plan.includes("clear-session")) {
      const resetStatus = context.previousStatus === "stopped" ? "stopped" : "inactive";
      await this.resetPersistedAgentSession(context.agentId, resetStatus);
      this.updateCache(context.agentId, { sessionId: null, status: resetStatus });
      if (context.serverId) {
        this.broadcastAgentSession(context.serverId, context.agentId, null);
      }
      this.clearLaunchGuard(context.agentId);
      this.advanceActivityIngestEpoch(context.agentId);
    }

    if (plan.includes("reset-workspace") && context.machineId) {
      this.sendBestEffortToMachine(
        context.machineId,
        { type: "agent:reset-workspace", agentId: context.agentId },
        `best-effort reset-workspace send failed for agent ${context.agentId}`,
      );
    }

    // Some caller-driven resets only need to clear session state; restart remains explicit in the plan.
    if (!plan.includes("restart")) return;

    try {
      await this.startAgent(context.agentId, context.terminalControl ? { control: "human_start" } : {});
      const restarted = await this.getCachedAgent(context.agentId);
      this.recordLifecycleEvent({
        agentId: context.agentId,
        machineId: restarted?.machineId ?? context.machineId,
        action: "reset",
        outcome: "completed",
        cause: context.mode,
        previousStatus: context.previousStatus,
        nextStatus: restarted?.status ?? "active",
      });
    } catch {
      // If restart fails (e.g. no machine), agent stays offline — that's fine.
      const failed = await this.getCachedAgent(context.agentId);
      this.recordLifecycleEvent({
        agentId: context.agentId,
        machineId: failed?.machineId ?? context.machineId,
        action: "reset",
        outcome: "failed",
        cause: context.mode,
        previousStatus: context.previousStatus,
        nextStatus: failed?.status ?? null,
      });
    }
  }

  // Agent workspace file browsing

  async getAgentFileTree(agentId: string, dirPath?: string, includeHidden = false): Promise<FileNode[]> {
    const result = await this.getMachineForAgent(agentId);
    if (!result) throw new RouteFailureError("daemon_offline", "Agent has no connected machine");
    const { machineId } = result;

    return new Promise(async (resolve, reject) => {
      const timeout = this.scheduleOnClock(() => {
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new RouteFailureError("daemon_timeout", "File tree request timed out"));
      }, 15_000);

      const handler = (msg: MachineToServerMessage) => {
        if (
          msg.type === "agent:workspace:file_tree"
          && msg.agentId === agentId
          && msg.dirPath === dirPath
          && Boolean(msg.includeHidden) === includeHidden
        ) {
          this.clock.clearTimeout(timeout);
          this.removeListener(`machine:response:${machineId}`, handler);
          resolve(msg.files);
        }
      };

      this.on(`machine:response:${machineId}`, handler);

      try {
        await this.sendRequiredToMachine(machineId, { type: "agent:workspace:list", agentId, dirPath, includeHidden });
      } catch {
        this.clock.clearTimeout(timeout);
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new RouteFailureError("daemon_offline", "Failed to send request — machine WebSocket not ready"));
      }
    });
  }

  /**
   * Ask a computer to re-detect which runtimes are installed.
   *
   * Fire-and-forget by design: the daemon answers by re-emitting its capabilities,
   * which flow back through the normal `machine:capabilities` push. There is no
   * reply to await, and an older daemon that does not know this message simply
   * ignores it — so this must never be something the UI blocks on.
   */
  async rescanMachineRuntimes(machineId: string): Promise<boolean> {
    return this.sendToMachine(machineId, { type: "machine:runtimes:rescan" });
  }

  async requestRuntimeAccountUsageRefresh(
    machineId: string,
    provider: RuntimeAccountUsageProvider,
    reason: "manual" | "stale_or_missing" | "scheduled",
  ): Promise<boolean> {
    return this.sendToMachine(machineId, {
      type: "machine:runtime_account_usage:refresh",
      requestId: crypto.randomUUID(),
      provider,
      reason,
    });
  }

  /**
   * Manual runtime-account usage refresh: send the refresh command and wait
   * for the correlated snapshot through the cross-replica relay (same carrier
   * shape as requestProviderProbe). Background refreshes
   * (scheduled/stale_or_missing) stay fire-and-forget on
   * requestRuntimeAccountUsageRefresh — only the manual route blocks on the
   * machine's reply. The snapshot message itself still flows through the
   * inbound switch, which re-authorizes at the data boundary and writes the
   * private cache before forwarding to this relay; this method never touches
   * the cache. Failures are typed: daemon_offline when the command could not
   * be sent, daemon_timeout when no snapshot arrived within the relay budget.
   */
  async requestRuntimeAccountUsageRefreshAndAwait(
    machineId: string,
    provider: RuntimeAccountUsageProvider,
  ): Promise<Extract<MachineToServerMessage, { type: "machine:runtime_account_usage:snapshot" }>> {
    const requestId = crypto.randomUUID();
    const response = await this.getMachineResponseRelay().request({
      requestId, machineId, type: "machine:runtime_account_usage:snapshot",
    }, RUNTIME_ACCOUNT_USAGE_RELAY_BUDGET_MS, () => this.sendRequiredToMachine(machineId, {
      type: "machine:runtime_account_usage:refresh",
      requestId,
      provider,
      reason: "manual",
    }), (event, attrs) => this.recordMachineResponseRelay(event, attrs));
    if (response.type !== "machine:runtime_account_usage:snapshot") throw new Error("Unexpected runtime account usage response");
    return response;
  }

  /**
   * Computer-scoped provider probe carrier. Mirrors the runtime-models seam:
   * requestId correlation, cross-replica relay, typed daemon_offline /
   * daemon_timeout failures and the probe budget (distinct from the 5s model
   * budget). The command carries no credential; the daemon materializes with
   * its own machine auth.
   */
  async requestProviderProbe(
    machineId: string,
    input: { requestId: string; probeId: string; runtime: string; model: string },
  ): Promise<Extract<MachineToServerMessage, { type: "machine:provider_probe:result" }>> {
    const response = await this.getMachineResponseRelay().request({
      requestId: input.requestId, machineId, type: "machine:provider_probe:result", probeId: input.probeId,
    }, PROVIDER_PROBE_RELAY_BUDGET_MS, () => this.sendRequiredToMachine(machineId, {
      type: "machine:provider_probe:request",
      requestId: input.requestId,
      probeId: input.probeId,
      runtime: input.runtime,
      model: input.model,
    }), (event, attrs) => this.recordMachineResponseRelay(event, attrs));
    if (response.type !== "machine:provider_probe:result") throw new Error("Unexpected probe response");
    return response;
  }

  /**
   * Probe carrier fact fields mirrored through the replica state store so a
   * non-owner replica can verify dispatch authority (F1). Rewritten on ready
   * and every heartbeat while the connection is live.
   */
  private probeCarrierMetaFields(
    conn: MachineConnection,
    normalizedRuntimeVersions?: Record<string, string>,
  ): {
    probeCapabilities: string;
    probeConnectionEpochId: string | null;
    probeReplicaGeneration: string | null;
    probeObservedAt: string;
    probeRuntimeVersions: string;
  } {
    return {
      probeCapabilities: JSON.stringify([...conn.capabilities].sort()),
      probeConnectionEpochId: conn.connectionEpochId ?? null,
      probeReplicaGeneration: conn.replicaGeneration ?? null,
      probeObservedAt: new Date(currentTimeMs()).toISOString(),
      probeRuntimeVersions: JSON.stringify(normalizedRuntimeVersions ?? conn.runtimeVersions ?? {}),
    };
  }

  /**
   * Cross-replica probe carrier fact: the owner replica's live connection when
   * local, otherwise the Redis machine-meta mirror. Freshness is bounded so a
   * forgotten connection can never keep authorizing probes.
   */
  async readProbeCarrierFact(machineId: string): Promise<{
    capabilities: string[];
    connectionEpochId: string;
    replicaGeneration: string;
    daemonVersion: string | null;
    computerVersion: string | null;
    runtimes: string[];
    runtimeVersions: Record<string, string>;
  } | null> {
    const local = this.machineConnections.get(machineId);
    if (local?.connectionEpochId && local.replicaGeneration) {
      // Owner replica: the live socket must be open and the heartbeat fresh,
      // otherwise the fact is not authoritative for a new dispatch.
      if (local.ws.readyState !== 1 || this.isMachineHeartbeatStale(local)) return null;
      return {
        capabilities: [...local.capabilities],
        connectionEpochId: local.connectionEpochId,
        replicaGeneration: local.replicaGeneration,
        daemonVersion: local.daemonVersion ?? null,
        computerVersion: local.computerVersion ?? null,
        runtimes: [...(local.runtimes ?? [])],
        runtimeVersions: { ...(local.runtimeVersions ?? {}) },
      };
    }
    const meta = await this.replicaStateStore.getMachineMeta(machineId);
    const snapshot = parseProbeCarrierMeta(meta ?? {});
    if (!snapshot || !isProbeCarrierFactLive(snapshot, currentTimeMs())) return null;
    return {
      capabilities: snapshot.capabilities,
      connectionEpochId: snapshot.connectionEpochId,
      replicaGeneration: snapshot.replicaGeneration,
      daemonVersion: snapshot.daemonVersion,
      computerVersion: snapshot.computerVersion,
      runtimes: Object.keys(snapshot.runtimeVersions),
      runtimeVersions: snapshot.runtimeVersions,
    };
  }

  /** Dispatch authority of the current machine connection, if any. */
  getMachineAuthority(machineId: string): { connectionEpochId: string; replicaGeneration: string } | null {
    const connection = this.machineConnections.get(machineId);
    if (!connection?.connectionEpochId || !connection.replicaGeneration) return null;
    return {
      connectionEpochId: connection.connectionEpochId,
      replicaGeneration: connection.replicaGeneration,
    };
  }

  async detectMachineRuntimeModels(machineId: string, runtime: string): Promise<RuntimeModelSourceOutcome> {
    // Plain model discovery does not consume connection-generation authority.
    // Built-in admission continues to use the local, fenced WithAuthority path.
    let outcome: RuntimeModelSourceOutcome;
    if (!this.machineConnections.has(machineId)) {
      const requestId = crypto.randomUUID();
      const response = await this.getMachineResponseRelay().request({
        requestId, machineId, type: "machine:runtime_models:result",
      }, runtimeModelDetectionRequestTimeoutMs(runtime), () => this.sendRequiredToMachine(machineId, {
        type: "machine:runtime_models:detect", requestId, runtime,
      }), (event, attrs) => this.recordMachineResponseRelay(event, attrs));
      if (response.type !== "machine:runtime_models:result") throw new Error("Unexpected model response");
      outcome = projectRuntimeModelSourceResult(response, runtime);
    } else {
      outcome = (
        await this.detectMachineRuntimeModelsWithAuthority(machineId, runtime)
      ).outcome;
    }
    // A live detection is a fresh report of the machine's model list; keep
    // the shared display catalog current without waiting for the proactive
    // `machine:runtime_models:catalog` frame (task #700).
    if (outcome.kind === "live") {
      await machineRuntimeModelCatalogService.writeRuntime(machineId, runtime, outcome.value.models);
    }
    return outcome;
  }

  async detectMachineRuntimeModelsWithAuthority(
    machineId: string,
    runtime: string,
  ): Promise<MachineRuntimeModelDetection> {
    const connection = this.machineConnections.get(machineId);
    if (
      !connection ||
      !connection.replicaGeneration ||
      connection.ws.readyState !== 1 ||
      this.isMachineHeartbeatStale(connection)
    ) {
      throw new RouteFailureError(
        "daemon_offline",
        "Failed to send request — machine WebSocket not ready",
      );
    }
    const authority = {
      connectionEpochId: connection.connectionEpochId,
      replicaGeneration: connection.replicaGeneration,
    };
    const requestId = crypto.randomUUID();

    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener(`machine:response:${machineId}`, handler);
        // Server-structural classification: we waited and the daemon never
        // answered. This is knowable at the throw site, so tag it.
        reject(new RouteFailureError("daemon_timeout", "Runtime model detect request timed out"));
      }, runtimeModelDetectionRequestTimeoutMs(runtime));

      const handler = (msg: MachineToServerMessage) => {
        if (msg.type === "machine:runtime_models:result" && msg.requestId === requestId) {
          clearTimeout(timeout);
          this.removeListener(`machine:response:${machineId}`, handler);
          const current = this.machineConnections.get(machineId);
          if (
            current?.connectionEpochId !== authority.connectionEpochId ||
            current.replicaGeneration !== authority.replicaGeneration
          ) {
            reject(new MachineCatalogStaleError());
            return;
          }
          resolve({
            outcome: projectRuntimeModelSourceResult(msg, runtime),
            authority,
            daemonVersion: current.daemonVersion,
            computerVersion: current.computerVersion,
          });
        }
      };

      this.on(`machine:response:${machineId}`, handler);

      try {
        await this.sendRequiredToMachine(machineId, { type: "machine:runtime_models:detect", requestId, runtime });
      } catch {
        clearTimeout(timeout);
        this.removeListener(`machine:response:${machineId}`, handler);
        // Server-structural classification: send failed because the machine WS
        // is not ready — i.e. the daemon is effectively offline for this call.
        reject(new RouteFailureError("daemon_offline", "Failed to send request — machine WebSocket not ready"));
      }
    });
  }

  async validateBuiltInPresetForMachine(
    machineId: string,
    config: RuntimeConfig,
  ): Promise<
    | (BuiltInModelCatalogValidation & {
        authority: MachineConnectionGeneration;
      })
    | null
  > {
    if (
      config.runtime !== "builtin" ||
      config.provider.kind !== "preset" ||
      config.model.kind !== "preset"
    )
      return null;
    let detection: MachineRuntimeModelDetection;
    try {
      detection = await this.detectMachineRuntimeModelsWithAuthority(
        machineId,
        "builtin",
      );
    } catch (error) {
      if (!(error instanceof RouteFailureError)) throw error;
      const connection = this.machineConnections.get(machineId);
      throw new BuiltInModelCatalogError(
        "builtin_catalog_unavailable",
        "The target Computer's Built-in model catalog is unavailable. Retry after the Computer reconnects.",
        {
          requestedModel: config.model.id,
          daemonVersion: connection?.daemonVersion ?? null,
          computerVersion: connection?.computerVersion ?? null,
          recovery: "retry",
        },
      );
    }
    const validation = assertBuiltInPresetSupportedByCatalog(
      config,
      detection.outcome,
      {
        machineId,
        daemonVersion: detection.daemonVersion,
        computerVersion: detection.computerVersion,
      },
    );
    return validation
      ? { ...validation, authority: detection.authority }
      : null;
  }

  acquireBuiltInCatalogAuthority(
    machineId: string,
    authority: MachineConnectionGeneration,
  ): () => void {
    return this.machineCatalogAuthority.acquire(machineId, authority);
  }

  async readAgentFile(agentId: string, filePath: string): Promise<{ content: string | null; binary: boolean; size: number; mimeType?: string; encoding?: "utf-8" | "base64" }> {
    const result = await this.getMachineForAgent(agentId);
    if (!result) throw new RouteFailureError("daemon_offline", "Agent has no connected machine");
    const { machineId } = result;

    const requestId = crypto.randomUUID();

    return new Promise(async (resolve, reject) => {
      const timeout = this.scheduleOnClock(() => {
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new RouteFailureError("daemon_timeout", "File read request timed out"));
      }, 15_000);

      const handler = (msg: MachineToServerMessage) => {
        if (msg.type === "agent:workspace:file_content" && msg.agentId === agentId && msg.requestId === requestId) {
          this.clock.clearTimeout(timeout);
          this.removeListener(`machine:response:${machineId}`, handler);
          resolve({
            content: msg.content,
            binary: msg.binary,
            size: msg.size ?? (msg.content ? Buffer.byteLength(msg.content, msg.encoding === "base64" ? "base64" : "utf-8") : 0),
            mimeType: msg.mimeType,
            encoding: msg.encoding,
          });
        }
      };

      this.on(`machine:response:${machineId}`, handler);

      try {
        await this.sendRequiredToMachine(machineId, { type: "agent:workspace:read", agentId, path: filePath, requestId });
      } catch {
        this.clock.clearTimeout(timeout);
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new RouteFailureError("daemon_offline", "Failed to send request — machine WebSocket not ready"));
      }
    });
  }

  // Agent skills listing

  /**
   * Record one skills list result as a span under the machine message span. The way the result matches
   * a pending request is recorded as a server.agent.skills.list event on it.
   */
  private observeAgentSkillsListResult(
    machineId: string,
    msg: Extract<MachineToServerMessage, { type: "agent:skills:list_result" }>,
  ): void {
    const baseAttrs = {
      agent_id: msg.agentId,
      machine_id: machineId,
      request_id_present: Boolean(msg.requestId),
      global_count: msg.global.length,
      workspace_count: msg.workspace.length,
    };
    const span = this.tracer.startSpan("server.agent.skills.list_result", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "consumer",
      attrs: { ...baseAttrs, request_id: msg.requestId },
    });
    let resultOutcome = "ignored";
    let resultStatus: TraceStatus = "ok";
    const recordResult = (outcome: string, attrs: TraceAttributes, status: TraceStatus = "ok") => {
      resultOutcome = outcome;
      resultStatus = status;
      this.recordEvent("server.agent.skills.list", { outcome, ...attrs });
    };
    try {
      this.runInActiveSpan(span, () => this.matchAgentSkillsListResult(machineId, msg, baseAttrs, recordResult));
    } catch (error) {
      span.end("error", { attrs: { error_class: errorClassOf(error) } });
      throw error;
    }
    span.end(resultStatus, { attrs: { outcome: resultOutcome } });
  }

  private matchAgentSkillsListResult(
    machineId: string,
    msg: Extract<MachineToServerMessage, { type: "agent:skills:list_result" }>,
    baseAttrs: TraceAttributes,
    recordResult: (outcome: string, attrs: TraceAttributes, status?: TraceStatus) => void,
  ): void {
    if (msg.requestId) {
      const pending = this.pendingAgentSkillsListRequests.get(msg.requestId);
      if (!pending) {
        recordResult("unmatched_request_id", {
          ...baseAttrs,
          request_id: msg.requestId,
        });
        return;
      }

      if (pending.agentId !== msg.agentId) {
        recordResult("wrong_agent_for_request_id", {
          ...baseAttrs,
          request_id: msg.requestId,
          expected_agent_id: pending.agentId,
          runtime: pending.runtime,
          duration_ms: Math.max(0, this.clock.now() - pending.startedAtMs),
        }, "error");
        return;
      }

      if (pending.machineId !== machineId) {
        recordResult("wrong_machine_for_request_id", {
          ...baseAttrs,
          request_id: msg.requestId,
          expected_machine_id: pending.machineId,
          runtime: pending.runtime,
          duration_ms: Math.max(0, this.clock.now() - pending.startedAtMs),
        }, "error");
        return;
      }

      recordResult(pending.timedOut ? "late_after_timeout" : "result_before_timeout", {
        ...baseAttrs,
        request_id: msg.requestId,
        runtime: pending.runtime,
        duration_ms: Math.max(0, this.clock.now() - pending.startedAtMs),
      });
      return;
    }

    const matchingPending = this.countMatchingLegacyAgentSkillsPending(machineId, msg.agentId);

    if (matchingPending.activeCount > 0) {
      recordResult(matchingPending.activeCount === 1 ? "legacy_unscoped_result" : "legacy_ambiguous_result", {
        ...baseAttrs,
        matching_pending_count: matchingPending.activeCount,
        retained_timeout_count: matchingPending.retainedTimeoutCount,
      }, matchingPending.activeCount === 1 ? "ok" : "error");
      return;
    }

    if (matchingPending.retainedTimeoutCount > 0) {
      recordResult("legacy_late_after_timeout", {
        ...baseAttrs,
        matching_pending_count: 0,
        retained_timeout_count: matchingPending.retainedTimeoutCount,
      });
    }
  }

  private countMatchingLegacyAgentSkillsPending(machineId: string, agentId: string): { activeCount: number; retainedTimeoutCount: number } {
    let activeCount = 0;
    let retainedTimeoutCount = 0;
    for (const pending of this.pendingAgentSkillsListRequests.values()) {
      if (pending.machineId === machineId && pending.agentId === agentId) {
        if (pending.timedOut) {
          retainedTimeoutCount += 1;
        } else {
          activeCount += 1;
        }
      }
    }
    return { activeCount, retainedTimeoutCount };
  }

  async getAgentSkills(agentId: string, runtime?: string): Promise<{ global: SkillInfo[]; workspace: SkillInfo[] }> {
    const result = await this.getMachineForAgent(agentId);
    if (!result) throw new RouteFailureError("daemon_offline", "Agent has no connected machine");
    const { machineId } = result;

    return new Promise(async (resolve, reject) => {
      const eventName = `machine:response:${machineId}`;
      const disconnectEventName = `machine:disconnect:${machineId}`;
      const requestId = crypto.randomUUID();
      const startedAtMs = this.clock.now();
      let settled = false;
      const span = this.tracer.startSpan("server.agent.skills.list", {
        parent: getCurrentTraceContext(),
        surface: "server",
        kind: "internal",
        attrs: {
          agent_id: agentId,
          machine_id: machineId,
          runtime: runtime || "auto",
          request_id: requestId,
        },
      });
      const endSpan = (status: TraceStatus, attrs: TraceAttributes) => {
        span.end(status, {
          attrs: { ...attrs, duration_ms: Math.max(0, this.clock.now() - startedAtMs) },
        });
      };
      const pending: PendingAgentSkillsListRequest = {
        agentId,
        machineId,
        runtime: runtime || "auto",
        startedAtMs,
        timedOut: false,
        timeoutTimer: null,
        observationTimer: null,
      };

      const cleanup = () => {
        if (pending.timeoutTimer) {
          this.clock.clearTimeout(pending.timeoutTimer);
          pending.timeoutTimer = null;
        }
        if (pending.observationTimer) {
          this.clock.clearTimeout(pending.observationTimer);
          pending.observationTimer = null;
        }
        this.removeListener(eventName, handler);
        this.removeListener(disconnectEventName, disconnectHandler);
        this.pendingAgentSkillsListRequests.delete(requestId);
      };

      const timeout = this.scheduleOnClock(() => {
        if (settled) return;
        settled = true;
        pending.timedOut = true;
        pending.timeoutTimer = null;
        endSpan("error", {
          outcome: "timeout",
          timeout_ms: AgentOrchestrator.AGENT_SKILLS_LIST_TIMEOUT_MS,
        });
        reject(new RouteFailureError("daemon_timeout", "Skills list request timed out"));
        pending.observationTimer = this.scheduleOnClock(() => {
          cleanup();
        }, AgentOrchestrator.AGENT_SKILLS_LIST_LATE_RESULT_OBSERVATION_MS);
      }, AgentOrchestrator.AGENT_SKILLS_LIST_TIMEOUT_MS);
      pending.timeoutTimer = timeout;

      const handler = (msg: MachineToServerMessage) => {
        if (msg.type !== "agent:skills:list_result" || msg.agentId !== agentId) return;
        if (msg.requestId && msg.requestId !== requestId) return;
        if (!msg.requestId && this.countMatchingLegacyAgentSkillsPending(machineId, agentId).activeCount !== 1) return;
        if (settled) {
          cleanup();
          return;
        }
        settled = true;
        cleanup();
        endSpan("ok", {
          outcome: "result_received",
          global_count: msg.global.length,
          workspace_count: msg.workspace.length,
        });
        resolve({ global: msg.global, workspace: msg.workspace });
      };

      const disconnectHandler = (context: MachineDisconnectContext = {}) => {
        if (settled) return;
        settled = true;
        endSpan("error", {
          outcome: "disconnected_before_result",
          disconnect_cause: context.cause || "socket_close",
        });
        cleanup();
        reject(new RouteFailureError("daemon_offline", "Machine disconnected while listing skills"));
      };

      this.pendingAgentSkillsListRequests.set(requestId, pending);
      this.on(eventName, handler);
      this.on(disconnectEventName, disconnectHandler);

      try {
        await this.runInActiveSpan(span, () =>
          this.sendRequiredToMachine(machineId, { type: "agent:skills:list", agentId, runtime, requestId }));
      } catch (error) {
        if (settled) return;
        settled = true;
        cleanup();
        endSpan("error", { outcome: "send_failed", error_class: errorClassOf(error) });
        reject(new RouteFailureError("daemon_offline", "Failed to send request — machine WebSocket not ready"));
      }
    });
  }

  async getAgentSessionTranscript(agentId: string): Promise<{
    runtime: string;
    sessionId: string;
    reachable: boolean;
    path: string | null;
    fallbackReason?: string;
    transcript: string | null;
    sizeBytes: number;
    truncated: boolean;
    redacted: boolean;
    tier: string;
    error?: string;
  }> {
    const result = await this.getMachineForAgent(agentId);
    if (!result) throw new Error("Agent has no connected machine");
    const { machineId } = result;

    const requestId = crypto.randomUUID();

    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new Error("Session transcript request timed out"));
      }, 15_000);

      const handler = (msg: MachineToServerMessage) => {
        if (msg.type === "agent:diagnostic:session_transcript_result" && msg.agentId === agentId && msg.requestId === requestId) {
          clearTimeout(timeout);
          this.removeListener(`machine:response:${machineId}`, handler);
          resolve({
            runtime: msg.runtime,
            sessionId: msg.sessionId,
            reachable: msg.reachable,
            path: msg.path,
            fallbackReason: msg.fallbackReason,
            transcript: msg.transcript,
            sizeBytes: msg.sizeBytes,
            truncated: msg.truncated,
            redacted: msg.redacted,
            tier: msg.tier,
            error: msg.error,
          });
        }
      };

      this.on(`machine:response:${machineId}`, handler);

      try {
        await this.sendRequiredToMachine(machineId, { type: "agent:diagnostic:session_transcript", agentId, requestId });
      } catch {
        clearTimeout(timeout);
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new Error("Failed to send request — machine WebSocket not ready"));
      }
    });
  }

  /**
   * Ask the daemon to collect the agent's current session transcript and upload
   * it as a trace bundle linked to a feedback report. This is intentionally
   * fire-and-forget from the HTTP route's perspective: callers receive a job id
   * immediately and the transcript upload proceeds in the background.
   */
  async collectFeedbackTranscript(
    agentId: string,
    feedbackReportId: string,
    reportWindow: {
      reportGeneratedAt: string;
      reportTimeSource: FeedbackTranscriptReportTimeSource;
    },
    options: { includeMachineLogTail?: boolean } = {},
  ): Promise<{
    traceBundleId?: string;
    reachable: boolean;
    fallbackReason?: string;
    error?: string;
    transcriptWindow?: FeedbackTranscriptWindow;
    machineLogTail?: FeedbackMachineLogTailOutcome;
    machineEvidence?: FeedbackMachineEvidenceOutcome;
    outcomeVersion?: 1;
    lookup?: FeedbackTranscriptLookupOutcome;
    upload?: FeedbackTranscriptUploadOutcome;
    outcomeObject?: FeedbackTranscriptOutcomeObjectPlan;
  }> {
    // task #1228 ①: one span per request, ended with the state the server
    // observed (machine_not_connected | send_failed | daemon_timeout | result).
    // Best-effort like every span: absent when trace export is off.
    const span = this.tracer.startSpan("server.feedback_transcript.request", {
      surface: "server",
      kind: "internal",
      attrs: {
        feedback_report_id: feedbackReportId,
        agent_id: agentId,
        report_time_source: reportWindow.reportTimeSource,
        include_machine_log_tail: options.includeMachineLogTail === true,
      },
    });
    const result = await this.getMachineForAgent(agentId);
    if (!result) {
      span.end("error", { attrs: { state: "machine_not_connected" } });
      throw new Error("Agent has no connected machine");
    }
    const { machineId } = result;

    const requestId = crypto.randomUUID();

    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener(`machine:response:${machineId}`, handler);
        // The route never waits; remember the request so a late result is
        // still recorded (bounded, TTL'd, ownership-checked, once).
        this.feedbackTranscriptLateResults.remember(requestId, { machineId, agentId, feedbackReportId });
        span.end("error", { attrs: { machine_id: machineId, request_id: requestId, state: "daemon_timeout" } });
        reject(new Error("Feedback transcript request timed out"));
      }, 30_000);

      const handler = (msg: MachineToServerMessage) => {
        if (msg.type === "agent:diagnostic:feedback_transcript_result" && msg.agentId === agentId && msg.feedbackReportId === feedbackReportId && msg.requestId === requestId) {
          clearTimeout(timeout);
          this.removeListener(`machine:response:${machineId}`, handler);
          // task #1228 ①: the typed fields are untrusted (the WebSocket layer
          // only JSON.parses). Only the strictly validated projection is
          // forwarded; a malformed one is dropped (legacy-compatible result)
          // and recorded as invalid. resolve runs BEFORE any span work, and
          // span work can never throw, so the request always completes.
          const read = readFeedbackTranscriptResultOutcomeSafely(msg);
          resolve({
            traceBundleId: msg.traceBundleId,
            reachable: msg.reachable,
            fallbackReason: msg.fallbackReason,
            error: msg.error,
            transcriptWindow: msg.transcriptWindow,
            ...(msg.machineLogTail ? { machineLogTail: msg.machineLogTail } : {}),
            ...(msg.machineEvidence ? { machineEvidence: msg.machineEvidence } : {}),
            ...(read.status === "typed"
              ? {
                outcomeVersion: 1 as const,
                lookup: read.lookup,
                upload: read.upload,
                ...(read.outcomeObject ? { outcomeObject: read.outcomeObject } : {}),
              }
              : {}),
          });
          try {
            span.end("ok", { attrs: { machine_id: machineId, request_id: requestId, state: "result", ...feedbackTranscriptOutcomeSpanAttrsSafely(msg, read) } });
          } catch {
            // Best-effort like every span; never affects the request.
          }
        }
      };

      this.on(`machine:response:${machineId}`, handler);

      try {
        await this.sendRequiredToMachine(machineId, {
          type: "agent:diagnostic:feedback_transcript",
          agentId,
          feedbackReportId,
          requestId,
          feedbackReportGeneratedAt: reportWindow.reportGeneratedAt,
          feedbackReportTimeSource: reportWindow.reportTimeSource,
          // Only ever true after the route verified the reporter owns the machine.
          ...(options.includeMachineLogTail ? { includeMachineLogTail: true } : {}),
        });
      } catch {
        clearTimeout(timeout);
        this.removeListener(`machine:response:${machineId}`, handler);
        span.end("error", { attrs: { machine_id: machineId, request_id: requestId, state: "send_failed" } });
        reject(new Error("Failed to send request — machine WebSocket not ready"));
      }
    });
  }

  /**
   * A feedback transcript result for a request the server already stopped
   * waiting for: recorded as `server.feedback_transcript.outcome{late}` when it
   * comes from the machine/agent/report it was asked of, once, within the TTL.
   * In-time results are not in the map and are ignored here.
   *
   * The entry is consumed only by a frame that is from the right
   * machine/agent/report AND whose typed fields are valid (or absent: an
   * older daemon). A malformed frame is recorded as rejected
   * (`invalid_outcome`) and leaves the entry in place, so a later valid frame
   * is still accepted once. Never throws: it runs before the in-time handlers.
   */
  private observeLateFeedbackTranscriptResult(
    machineId: string,
    msg: Extract<MachineToServerMessage, { type: "agent:diagnostic:feedback_transcript_result" }>,
  ): void {
    try {
      this.observeLateFeedbackTranscriptResultUnsafe(machineId, msg);
    } catch {
      // Observation only; must never break message handling.
    }
  }

  private observeLateFeedbackTranscriptResultUnsafe(
    machineId: string,
    msg: Extract<MachineToServerMessage, { type: "agent:diagnostic:feedback_transcript_result" }>,
  ): void {
    const decision = this.feedbackTranscriptLateResults.check(machineId, msg);
    if (decision.status === "unknown") return;
    if (decision.status === "accepted") {
      const read = readFeedbackTranscriptResultOutcomeSafely(msg);
      if (read.status === "invalid") {
        const rejected = this.tracer.startSpan("server.feedback_transcript.late_result_rejected", {
          surface: "server",
          kind: "internal",
          attrs: {
            machine_id: machineId,
            request_id: msg.requestId,
            reason: "invalid_outcome",
            ...feedbackTranscriptOutcomeSpanAttrsSafely(msg, read),
          },
        });
        rejected.end("error");
        return;
      }
      this.feedbackTranscriptLateResults.consume(msg.requestId);
      const span = this.tracer.startSpan("server.feedback_transcript.outcome", {
        surface: "server",
        kind: "internal",
        attrs: {
          late: true,
          late_by_ms: decision.lateByMs,
          feedback_report_id: msg.feedbackReportId,
          agent_id: msg.agentId,
          machine_id: machineId,
          request_id: msg.requestId,
          ...feedbackTranscriptOutcomeSpanAttrsSafely(msg, read),
        },
      });
      span.end("ok");
      return;
    }
    const span = this.tracer.startSpan("server.feedback_transcript.late_result_rejected", {
      surface: "server",
      kind: "internal",
      attrs: {
        machine_id: machineId,
        request_id: msg.requestId,
        reason: decision.status === "expired" ? "expired" : `ownership_mismatch_${decision.field}`,
      },
    });
    span.end("error");
  }

  // Machine workspace scanning

  async scanMachineWorkspaces(machineId: string): Promise<WorkspaceDirectoryInfo[]> {
    const conn = this.machineConnections.get(machineId);
    if (!conn || conn.ws.readyState !== 1) {
      throw new Error("Machine is not connected");
    }

    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new Error("Workspace scan timed out"));
      }, 15_000);

      const handler = (msg: MachineToServerMessage) => {
        if (msg.type === "machine:workspace:scan_result") {
          clearTimeout(timeout);
          this.removeListener(`machine:response:${machineId}`, handler);
          resolve(msg.directories);
        }
      };

      this.on(`machine:response:${machineId}`, handler);
      try {
        await this.sendRequiredToMachine(machineId, { type: "machine:workspace:scan" });
      } catch {
        clearTimeout(timeout);
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new Error("Failed to send request — machine WebSocket not ready"));
      }
    });
  }

  async deleteMachineWorkspaceDir(machineId: string, directoryName: string): Promise<boolean> {
    const conn = this.machineConnections.get(machineId);
    if (!conn || conn.ws.readyState !== 1) {
      throw new Error("Machine is not connected");
    }

    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new Error("Delete timed out"));
      }, 15_000);

      const handler = (msg: MachineToServerMessage) => {
        if (msg.type === "machine:workspace:delete_result" && msg.directoryName === directoryName) {
          clearTimeout(timeout);
          this.removeListener(`machine:response:${machineId}`, handler);
          resolve(msg.success);
        }
      };

      this.on(`machine:response:${machineId}`, handler);
      try {
        await this.sendRequiredToMachine(machineId, { type: "machine:workspace:delete", directoryName });
      } catch {
        clearTimeout(timeout);
        this.removeListener(`machine:response:${machineId}`, handler);
        reject(new Error("Failed to send request — machine WebSocket not ready"));
      }
    });
  }

  /**
   * deliverMessage's gates (passive scope unless intrinsic / admin authority,
   * target access) for persisted messages an EXTERNAL agent pulls from its
   * inbox rather than receiving into the buffer. One result per item.
   */
  async filterExternalInboxDeliveries(
    agentId: string,
    items: Array<{ message: AgentMessage; options: DeliverMessageOptions }>,
  ): Promise<boolean[]> {
    if (items.length === 0) return [];
    const agent = await this.getAuthoritativeAgentForDelivery(agentId);
    if (!agent) return items.map(() => false);
    let passiveScope: boolean | null = null;
    const results: boolean[] = [];
    for (const { message, options } of items) {
      if (!options.intrinsic && !options.adminAuthority) {
        passiveScope ??= await this.hasPassiveDeliveryScope(agentId).catch(() => false);
        if (!passiveScope) {
          results.push(false);
          continue;
        }
      }
      results.push(options.intrinsic ? true : await this.canAgentAccessDeliveryTarget(agentId, agent, message));
    }
    return results;
  }

  async deliverMessage(
    agentId: string,
    message: AgentMessage,
    options: DeliverMessageOptions = {},
  ): Promise<AgentMessageDeliveryResult> {
    const agent = await this.getAuthoritativeAgentForDelivery(agentId);
    if (!agent) return { status: "dropped", reason: "agent_unavailable" };
    const requireQueueReceipt = options.requireQueueReceipt === true
      || options.reconcileNonMemberMention === true;
    // Passive scope gate — see DeliverMessageOptions.intrinsic. We drop rather
    // than enqueue and return a typed receipt to the caller: a revoked agent
    // should not see historical channel traffic when the scope is later restored. The
    // server-side audit trail lives on the scope toggle itself
    // (revision + updatedAt + updatedByUserId on `agent_scopes`).
    if (!options.intrinsic && !options.adminAuthority) {
      const allowed = await this.hasPassiveDeliveryScope(agentId).catch(() => false);
      if (!allowed) return { status: "dropped", reason: "passive_scope_revoked" };
    }
    if (!options.intrinsic && !await this.canAgentAccessDeliveryTarget(agentId, agent, message)) {
      return { status: "dropped", reason: "target_access_changed" };
    }
    // A tracked mention carries the launch/session identity the daemon checks
    // it against. Only the socket owner holds the current identity, so hand
    // the whole delivery to the owner rather than stamping
    // this replica's cached identity on it.
    const routeTrackedMention = Boolean(options.mentionDeliveryOccurrenceId)
      && Boolean(agent.machineId);
    if ((requireQueueReceipt || routeTrackedMention) && agent.machineId) {
      const localMachineIds = this.getRoutableLocalMachineIds();
      if (!localMachineIds.has(agent.machineId) && this.replicaStateStore.isAvailable()) {
        const routed = await this.routeInboxDeliveryWithReceiptCrossReplica(
          agentId,
          agent.machineId,
          message,
          localMachineIds,
          options,
        );
        if (routed.routed) {
          return normalizeRoutedInboxDeliveryReceipt(routed.receipt);
        }
      }
    }
    if (options.reconcileNonMemberMention) {
      this.reconcileQueuedNonMemberMention(agentId, message);
    }
    // External agents are supplied/observed, never Slock-launched
    // (SHA-V0-006C): there is no managed wake path for them. Signal the
    // content-free `/wake-hints` surfaces (rfcs/035 D7); the runtime drains
    // bodies via its own direct `message check`. Transient synthetic
    // messages (e.g. reminder fire) have no ackable `seq` and would pin the
    // inbox forever — drop them, same rule as the control-gate path below.
    if (isExternalAgentRuntime(agent.runtime)) {
      if (!options.transient) {
        // A persisted message is pulled from the agent's durable inbox on its
        // next call (messageService.pullExternalAgentInbox); only items with no
        // durable row are buffered here.
        if (!isDurableAgentInboxMessage(message)) {
          this.deliverToLocalInbox(agentId, message, { notifyPendingReceive: false });
        }
        // Wake the agent's SSE wake-hint stream subscribers (D7 T1, task
        // #72). Content-free signal only: listeners re-peek the inbox and
        // build hints themselves — nothing here drains or advances cursors.
        // The message itself rides along (second listener argument) for the
        // inbox push, which POSTs it directly (agentInboxPushService), the
        // external counterpart of `agent:deliver`. Signals relayed from
        // another replica carry no message.
        this.emit("external-inbox-delivered", agentId, message);
        // Option C (#wg-external-agent 2026-06-11): the emit above is
        // process-local, but the agent's SSE stream may be connected to
        // another replica. Broadcast a content-free signal so that replica's
        // stream flushes immediately (its flush pulls the durable inbox, so
        // duplicates/loss are harmless); the heartbeat pull stays the floor.
        void this.publishExternalWakeSignalCrossReplica(agentId);
        return { status: "queued", reason: "external_inbox" };
      }
      return { status: "dropped", reason: "transient_delivery_unsupported" };
    }
    const wakeInput = await this.loadWakePlanInput(agentId, agent.status);
    const action = planWakeAction(wakeInput);
    if (action === "suppress-control-gate") {
      // Migration-gated path normally enqueues into the local inbox so the wake
      // is delivered after the gate clears. For transient wakes (e.g. reminder
      // fire) we DROP instead of enqueue: the synthetic AgentMessage has no
      // ackable seq, so it would sit in the inbox forever and re-fire on every
      // receive/reconnect once the gate lifts. Audit lives in `reminder_events`;
      // owner observes via reminder UI (status=fired). Best-effort delivery
      // semantics are intentional — reminder fire is fire-and-observe.
      if (!options.transient) {
        this.deliverToLocalInbox(agentId, message, { notifyPendingReceive: false });
      }
      if (wakeInput.state.controlGate === "runtime_profile_migration" && agent.machineId) {
        await this.maybePiggybackRuntimeProfileMigrationNudge(agent.machineId, agent);
      }
      return options.transient
        ? { status: "dropped", reason: "transient_delivery_unsupported" }
        : { status: "queued", reason: "control_gate_inbox" };
    }
    // Hotfix (mention-push incident 2026-08-27): tracked-mention delivery must
    // not be silently demoted to replayable-inbox-only when the daemon-side
    // session identity is unavailable. applyDirectDelivery's identity gate
    // returned before span creation on missing expectedLaunchId/sessionId —
    // for machines whose daemon never established that identity the whole
    // @ push vanished until next contact. Restore ordinary immediate delivery
    // semantics: CAS-terminalize the occurrence and deliver untracked (plain
    // ws frame + durable inbox + embedded wake content). Only the caller whose
    // CAS wins (row still in its pre-decision fanout state) owns that untracked
    // push; a null CAS means another path already terminalized or decided this
    // occurrence, and emitting a second copy here would double-deliver.
    let mentionDeliveryOccurrenceId = options.mentionDeliveryOccurrenceId;
    if (
      mentionDeliveryOccurrenceId
      && (
        !message.message_id
        || !agent.machineId
        || !this.agentStateCache.get(agentId)?.expectedLaunchId
        || !this.agentStateCache.get(agentId)?.sessionId
      )
    ) {
      let abandoned: Awaited<ReturnType<typeof mentionDeliveryOccurrenceService.abandonMentionDeliveryWithoutInstrumentation>>;
      try {
        abandoned = await mentionDeliveryOccurrenceService.abandonMentionDeliveryWithoutInstrumentation({
          occurrenceId: mentionDeliveryOccurrenceId,
        });
      } catch {
        // Ownership unknown (the CAS itself failed to execute): do not push a
        // copy we cannot prove we own. The row stays `recorded`, so durable
        // recovery redrives it once the agent's identity is established —
        // delayed, never lost, never doubled.
        return { status: "queued", reason: "replayable_inbox" };
      }
      if (!abandoned) {
        // Lost the CAS: already terminal (a previous fallback call delivered),
        // already server-decided (tracked path owns it), or no such row. Same
        // idempotency shape as the tracked decision guard: no second copy.
        return { status: "dropped", reason: "agent_state_changed" };
      }
      mentionDeliveryOccurrenceId = undefined;
    }
    if (action !== "deliver-directly") {
      return this.applyWakeAction({
        agentId,
        machineId: agent.machineId,
        previousStatus: agent.status,
        resetMode: wakeInput.state.resetMode,
        transient: options.transient ?? false,
        requireQueueReceipt,
        mentionDeliveryOccurrenceId,
      }, message, action);
    }
    return this.applyDirectDelivery({
      agentId,
      machineId: agent.machineId,
      transient: options.transient ?? false,
      requireQueueReceipt,
      mentionDeliveryOccurrenceId,
    }, message);
  }

  async redriveMentionDelivery(
    messageId: string,
    agentId: string,
    expectedVersion: number,
  ): Promise<
    | { status: "REDRIVE_QUEUED"; occurrenceId: string; version: number }
    | { status: "NOT_JOINABLE" | "IDENTITY_UNKNOWN" | "IDENTITY_DRIFT" | "CAS_MISMATCH" }
    | mentionDeliveryOccurrenceService.MentionDeliveryLookupResult
  > {
    const row = await mentionDeliveryOccurrenceService.getMentionDeliveryOccurrence(messageId, agentId);
    if (!row || !row.deliveryPayload) return { status: "NOT_JOINABLE" };
    const currentResult = mentionDeliveryOccurrenceService.evaluateMentionDeliveryOccurrence(row);
    if (
      currentResult.status === "ACKED"
      || currentResult.status === "TERMINAL_ERROR"
      || currentResult.status === "INSTRUMENT_FAILED"
    ) return currentResult;
    const agent = await this.getAuthoritativeAgentForDelivery(agentId);
    if (!agent?.machineId || !agent.expectedLaunchId || !agent.sessionId) {
      return { status: "IDENTITY_UNKNOWN" };
    }
    const identity: MentionDeliveryIdentitySnapshot = {
      occurrenceId: row.occurrenceId,
      messageId: row.messageId,
      machineId: agent.machineId,
      launchId: agent.expectedLaunchId,
      sessionId: agent.sessionId,
    };
    if (
      row.machineIdSnapshot !== identity.machineId
      || row.launchIdSnapshot !== identity.launchId
      || row.sessionIdSnapshot !== identity.sessionId
    ) {
      await mentionDeliveryOccurrenceService.recordMentionDeliveryIdentityDrift(row.occurrenceId, "redrive");
      return { status: "IDENTITY_DRIFT" };
    }
    const claimed = await mentionDeliveryOccurrenceService.claimMentionDeliveryRedrive({
      occurrenceId: row.occurrenceId,
      expectedVersion,
      identity,
    });
    if (!claimed) return { status: "CAS_MISMATCH" };
    await this.enqueueToLocalInboxIfStillActive(agentId, identity.machineId, row.deliveryPayload);
    await this.sendAgentDeliveryWithAckRetry(identity.machineId, {
      type: "agent:deliver",
      agentId,
      message: row.deliveryPayload,
      seq: row.deliveryPayload.seq ?? 0,
      deliveryId: row.occurrenceId,
      mentionDelivery: identity,
    }, `operator mention redrive failed for agent ${agentId}`);
    return { status: "REDRIVE_QUEUED", occurrenceId: row.occurrenceId, version: claimed.version };
  }

  protected async applyDirectDelivery(
    context: DirectDeliveryContext,
    message: AgentMessage,
  ): Promise<AgentMessageDeliveryResult> {
    const cachedAgent = this.agentStateCache.get(context.agentId);
    const serverId = cachedAgent?.serverId;
    const deliveryId = context.mentionDeliveryOccurrenceId ?? crypto.randomUUID();
    let mentionDelivery: MentionDeliveryIdentitySnapshot | undefined;
    if (context.mentionDeliveryOccurrenceId) {
      if (
        !message.message_id
        || !context.machineId
        || !cachedAgent?.expectedLaunchId
        || !cachedAgent.sessionId
      ) {
        return { status: "queued", reason: "replayable_inbox" };
      }
      mentionDelivery = {
        occurrenceId: context.mentionDeliveryOccurrenceId,
        messageId: message.message_id,
        machineId: context.machineId,
        launchId: cachedAgent.expectedLaunchId,
        sessionId: cachedAgent.sessionId,
      };
      const decision = await mentionDeliveryOccurrenceService.recordMentionDeliveryServerDecision({
        occurrenceId: context.mentionDeliveryOccurrenceId,
        payload: message,
        identity: mentionDelivery,
      });
      if (!decision) {
        return { status: "dropped", reason: "agent_state_changed" };
      }
    }
    const span = this.tracer.startSpan("server.agent.delivery", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "producer",
      attrs: {
        agent_id: context.agentId,
        machine_id: context.machineId ?? undefined,
        server_id: serverId,
        agent_id_present: Boolean(context.agentId),
        machine_id_present: Boolean(context.machineId),
        server_id_present: Boolean(serverId),
        deliveryId,
        delivery_correlation_id: deliveryId,
        message_id_present: Boolean(message.message_id),
        seq: message.seq ?? 0,
      },
    });
    span.addEvent("server.deliver.enqueued", {
      outcome: "enqueued",
      reason: "direct_delivery",
      seq: message.seq ?? 0,
      deliveryId,
    });

    try {
      let inboxPath: "routed" | "local" | "local-fallback" | "strict-remote-skip" | "transient-skip" = "local";
      let queued = false;
      // Establish replayable inbox state before direct websocket delivery. The
      // daemon can ack immediately from ws.send(); if the inbox does not exist yet,
      // that ack is lost and weak-network recovery can replay a delivered message.
      //
      // Transient deliveries (e.g. reminder fire) intentionally skip this: their
      // synthetic AgentMessage has no `seq` from `messages.seq`, so the inbox
      // could never ack/remove it (see `partitionAcknowledgedMessages`). Audit
      // lives elsewhere (`reminder_events`) and a missed wake is recoverable
      // via the owner's reminder UI, so best-effort ws send is correct.
      if (context.transient) {
        inboxPath = "transient-skip";
        span.addEvent("inbox.skipped", {
          outcome: "skipped",
          reason: "transient_delivery",
          path: inboxPath,
        });
      } else if (
        context.requireQueueReceipt
        && context.machineId
        && !this.getRoutableLocalMachineIds().has(context.machineId)
      ) {
        // The receipt RPC is attempted before the local delivery plan. Reaching
        // this branch means no current target replica could own that contract;
        // do not fall back to the legacy publish-only route, because it could
        // mutate a remote inbox before this replica reports `dropped`.
        inboxPath = "strict-remote-skip";
        span.addEvent("inbox.routed", {
          outcome: "skipped",
          reason: "cross_replica_receipt_unavailable",
          path: inboxPath,
        });
      } else if (context.machineId && this.replicaStateStore.isAvailable()) {
        const routed = await this.routeInboxDeliveryCrossReplica(
          context.agentId,
          context.machineId,
          message,
          this.getRoutableLocalMachineIds(),
        );
        if (routed) {
          inboxPath = "routed";
          // Pub/sub publication is only a route signal. It does not prove the
          // target replica accepted the message into its replayable inbox.
          queued = !context.requireQueueReceipt;
          span.addEvent("inbox.routed", {
            outcome: context.requireQueueReceipt ? "unconfirmed" : "routed",
            reason: context.requireQueueReceipt
              ? "cross_replica_receipt_unavailable"
              : "cross_replica_inbox",
            path: inboxPath,
          });
        } else {
          inboxPath = "local-fallback";
          queued = await this.enqueueToLocalInboxIfStillActive(context.agentId, context.machineId, message);
          span.addEvent("inbox.ready", {
            outcome: "prepared",
            reason: "local_fallback_inbox",
            path: inboxPath,
          });
        }
      } else {
        queued = await this.enqueueToLocalInboxIfStillActive(context.agentId, context.machineId, message);
        span.addEvent("inbox.ready", {
          outcome: "prepared",
          reason: "local_inbox",
          path: inboxPath,
        });
      }

      if (!context.transient && !queued) {
        const reason = inboxPath === "routed" || inboxPath === "strict-remote-skip"
          ? "cross_replica_receipt_unavailable"
          : "agent_state_changed";
        span.end("ok", {
          attrs: {
            outcome: "dropped",
            reason,
          },
        });
        return { status: "dropped", reason };
      }

      if (context.transient && !context.machineId) {
        span.end("ok", {
          attrs: {
            outcome: "dropped",
            reason: "agent_state_changed",
          },
        });
        return { status: "dropped", reason: "agent_state_changed" };
      }

      // Try to deliver to the machine directly (daemon auto-restarts idle processes;
      // sendToMachine handles cross-replica routing via Redis).
      if (context.machineId) {
        span.addEvent("server.ws.send.attempted", {
          outcome: "attempted",
          reason: "machine_present",
          machine_id_present: true,
        });
        void this.sendAgentDeliveryWithAckRetry(context.machineId, {
          type: "agent:deliver",
          agentId: context.agentId,
          message,
          seq: message.seq ?? 0,
          traceparent: formatTraceparent(span.context),
          deliveryId,
          transient: context.transient || undefined,
          mentionDelivery,
        }, `deliverMessage send failed for agent ${context.agentId}`);
      }
      span.end("ok", {
        attrs: {
          outcome: context.machineId ? "ws-send-attempted" : "inbox-only",
          reason: context.machineId ? "machine_present" : "machine_absent",
        },
      });
      return {
        status: "queued",
        reason: context.transient ? "direct_dispatch" : "replayable_inbox",
      };
    } catch (err) {
      span.end("error", { attrs: { error_class: errorClassOf(err) } });
      throw err;
    }
  }

  protected async applyWakeAction(
    context: WakeApplyContext,
    message: AgentMessage,
    action: Exclude<WakePlanAction, "deliver-directly">,
  ): Promise<AgentMessageDeliveryResult> {
    if (action === "suppress-reset") {
      this.recordLifecycleEvent({
        agentId: context.agentId,
        machineId: context.machineId,
        action: "wake",
        outcome: "suppressed",
        cause: "message",
        previousStatus: context.previousStatus,
        detail: `reset_in_progress:${context.resetMode}`,
      });
      return { status: "dropped", reason: "reset_in_progress" };
    }
    if (action === "attempt-wake") {
      this.recordLifecycleEvent({
        agentId: context.agentId,
        machineId: context.machineId,
        action: "wake",
        outcome: "attempted",
        cause: "message",
        previousStatus: context.previousStatus,
      });
      try {
        const startResult = await this.startAgent(context.agentId, {
          // A tracked mention is not embedded in agent:start because the
          // concrete session identity does not exist yet. Start the runtime,
          // then agent:session rebuilds the existing ACK obligation from the
          // durable occurrence and sends the same occurrence id once.
          wakeMessage: context.mentionDeliveryOccurrenceId ? undefined : message,
          wakeMessageTransient: context.mentionDeliveryOccurrenceId ? undefined : context.transient ?? false,
          requireQueueReceipt: context.requireQueueReceipt ?? false,
        });
        if (startResult.outcome === "dispatched") {
          return { status: "queued", reason: "wake_accepted" };
        }
        if (
          startResult.reason === "manual_stop"
          || startResult.reason === "wake_crash_loop_blocked"
          || startResult.reason === "terminal_failure_paused"
          || startResult.reason === "terminal_failure_probe_in_flight"
          || startResult.reason === "terminal_failure_needs_manual"
        ) {
          // RFC 071: the message is neither consumed nor acked; it stays in the durable inbox.
          return { status: "dropped", reason: "wake_suppressed" };
        }
        if (context.requireQueueReceipt) {
          return { status: "dropped", reason: "cross_replica_receipt_unavailable" };
        }
        if (context.transient) {
          return { status: "dropped", reason: "transient_delivery_unsupported" };
        }

        // Another replica owns the in-flight start and its start payload cannot
        // contain this later message. Retain the message on this replica so a
        // subsequent receive/reconnect can replay it instead of falsely
        // reporting that the wake accepted content it never handed off.
        const queued = await this.enqueueWakeLockFallbackToLocalInbox(
          context.agentId,
          context.machineId,
          message,
        );
        return queued
          ? { status: "queued", reason: "replayable_inbox" }
          : { status: "dropped", reason: "agent_state_changed" };
      } catch (err) {
        this.recordLifecycleEvent({
          agentId: context.agentId,
          machineId: context.machineId,
          action: "wake",
          outcome: "failed",
          cause: "message",
          previousStatus: context.previousStatus,
          detail: err instanceof Error ? err.message : String(err),
        });
        console.warn(`[Orchestrator] deliverMessage ${context.agentId}: failed to wake inactive agent: ${err instanceof Error ? err.message : String(err)}`);
        if (err instanceof CrossReplicaQueueReceiptUnavailableError) {
          return { status: "dropped", reason: "cross_replica_receipt_unavailable" };
        }
        return { status: "dropped", reason: "wake_failed" };
      }
    }
    this.recordLifecycleEvent({
      agentId: context.agentId,
      machineId: context.machineId,
      action: "wake",
      outcome: "suppressed",
      cause: "message",
      previousStatus: context.previousStatus,
    });
    return { status: "dropped", reason: "wake_suppressed" };
  }

  private async enqueueWakeLockFallbackToLocalInbox(
    agentId: string,
    expectedMachineId: string | null,
    message: AgentMessage,
  ): Promise<boolean> {
    const latest = await this.getAuthoritativeAgentForDelivery(agentId);
    if (!latest || latest.status === "stopped" || latest.machineId !== expectedMachineId) {
      return false;
    }
    this.deliverToLocalInbox(agentId, message);
    return true;
  }

  // `protected`, not private, PURELY so a test can count deliveries. @Kabi's probe shape for the
  // "AND no delivery happened" half of the redrive arms is: override the delivery call with a
  // counter and assert the (rc, count) PAIR. With this private, a counter could see only ONE of
  // the two delivery calls on the queued path, so a count of 0 would not mean "nothing was
  // delivered" — it would mean "I could not see one of the two ways it delivers".
  protected async enqueueToLocalInboxIfStillActive(
    agentId: string,
    expectedMachineId: string | null,
    message: AgentMessage,
  ): Promise<boolean> {
    const latest = await this.getAuthoritativeAgentForDelivery(agentId);
    const action = planLocalDeliveryGateAction({
      hasAgent: Boolean(latest),
      status: latest?.status ?? null,
      machineMatches: latest?.machineId === expectedMachineId,
    });
    this.applyLocalDeliveryGateAction({
      action,
      agentId,
      message,
    });
    return action === "deliver-locally";
  }

  private async deliverToLocalInboxIfStillActive(
    agentId: string,
    expectedMachineId: string | null,
    message: AgentMessage,
  ): Promise<boolean> {
    await this.enqueueToLocalInboxIfStillActive(agentId, expectedMachineId, message);
    // Replica routing asks whether this replica handled the command, not
    // whether the late delivery was still eligible to enqueue. A stale drop is
    // therefore handled=true even though the receipt-facing path reports it as
    // dropped.
    return true;
  }

  protected applyLocalDeliveryGateAction(context: LocalDeliveryGateApplyContext): boolean {
    if (context.action === "drop-delivery") {
      return true;
    }

    this.deliverToLocalInbox(context.agentId, context.message);
    return true;
  }

  /** Deliver a message to a local agent inbox. Used by deliverMessage and ReplicaRouter. */
  deliverToLocalInbox(
    agentId: string,
    message: AgentMessage,
    options: {
      notifyPendingReceive?: boolean;
      reconcileNonMemberMention?: boolean;
    } = {},
  ) {
    let inbox = this.agentInboxes.get(agentId);
    if (!inbox) {
      inbox = { inbox: [], pendingReceive: null };
      this.agentInboxes.set(agentId, inbox);
    }

    if (
      options.reconcileNonMemberMention === true
      && this.reconcileQueuedNonMemberMention(agentId, message)
    ) {
      return;
    }

    const action = planLocalInboxEnqueueAction({
      hasSeqDuplicate: Boolean(message.seq && inbox.inbox.some((queued) => queued.seq === message.seq)),
      hasMessageIdDuplicate: Boolean(!message.seq && message.message_id && inbox.inbox.some((queued) => queued.message_id === message.message_id)),
    });
    if (action === "enqueue") {
      this.applyLocalInboxEnqueue({
        inbox,
        message,
        notifyPendingReceive: options.notifyPendingReceive ?? true,
      });
    }
  }

  private reconcileQueuedNonMemberMention(agentId: string, message: AgentMessage): boolean {
    const inbox = this.agentInboxes.get(agentId);
    if (!inbox || !message.seq || message.non_member_mention === true) return false;

    const duplicateIndex = inbox.inbox.findIndex((queued) => queued.seq === message.seq);
    if (duplicateIndex < 0 || inbox.inbox[duplicateIndex]?.non_member_mention !== true) return false;
    inbox.inbox[duplicateIndex] = message;
    return true;
  }

  protected applyLocalInboxEnqueue(context: LocalInboxApplyContext) {
    context.inbox.inbox.push(context.message);
    if (context.inbox.inbox.length > 1000) {
      context.inbox.inbox.shift();
    }

    if (context.notifyPendingReceive !== false && context.inbox.pendingReceive) {
      clearTimeout(context.inbox.pendingReceive.timer);
      context.inbox.pendingReceive.resolve([...context.inbox.inbox]);
      context.inbox.pendingReceive = null;
    }
  }

  async receiveMessages(agentId: string, block: boolean, timeoutMs: number, signal?: AbortSignal): Promise<AgentMessage[]> {
    if (await agentRuntimeProfileService.isRuntimeProfileMigrationGated(agentId)) {
      const agent = await this.getCachedAgent(agentId);
      const inbox = this.agentInboxes.get(agentId);
      const pendingMigration = await agentRuntimeProfileService.getPendingRuntimeProfileMigration(agentId);
      const oldestMessageAgeMs = oldestInboxMessageAgeMs(inbox?.inbox ?? [], this.clock.now());
      const pendingAgeMs = pendingMigration?.migratingSince
        ? Math.max(0, this.clock.now() - pendingMigration.migratingSince.getTime())
        : undefined;
      const span = this.tracer.startSpan("server.runtime_profile.gated_inbox.receive_blocked", {
        parent: getCurrentTraceContext(),
        surface: "server",
        kind: "internal",
        attrs: {
          event_kind: "runtime_profile",
          agent_id: agentId,
          machine_id: agent?.machineId,
          server_id: agent?.serverId,
          agent_id_present: Boolean(agentId),
          machine_id_present: Boolean(agent?.machineId),
          pending_kind: pendingMigration?.pendingKind,
          pending_key_present: Boolean(pendingMigration?.pendingKey),
          pending_key_hash: hashRuntimeProfileKey(pendingMigration?.pendingKey),
          migration_status: pendingMigration?.migrationStatus,
          pending_age_ms: pendingAgeMs,
          pending_age_bucket: durationMsBucket(pendingAgeMs),
          inbox_count: inbox?.inbox.length ?? 0,
          pending_receive_present: Boolean(inbox?.pendingReceive),
          oldest_message_age_ms: oldestMessageAgeMs,
          oldest_message_age_bucket: durationMsBucket(oldestMessageAgeMs),
          block,
          timeout_ms: timeoutMs,
        },
      });
      try {
        await this.runInActiveSpan(span, async () => {
          if (agent?.machineId) {
            await this.maybePiggybackRuntimeProfileMigrationNudge(agent.machineId, agent);
          }
          if (agent) {
            const pendingKeyHash = hashRuntimeProfileKey(pendingMigration?.pendingKey);
            // TODO(lifecycle-v2/server-producer): this is the server-side half of
            // runtime-profile control gating. Emit canonical
            // runtime_profile_control_changed from the gate planner when it marks
            // controlGate=runtime_profile_migration, then remove this adapter use.
            const { event } = adaptRuntimeProfileControlLifecycleEvent({
              serverId: agent.serverId,
              agentId,
              machineId: agent.machineId,
              source: "server",
              controlGate: "runtime_profile_migration",
              pendingKeyHash,
              now: () => new Date(this.clock.now()),
              attrs: {
                pending_kind: pendingMigration?.pendingKind,
                migration_status: pendingMigration?.migrationStatus,
              },
            });
            await applyAgentLifecycleProjectionPlan(
              reduceRuntimeProfileControlLifecycle({
                event,
                state: buildAgentLifecycleStateSnapshot({
                  controlGate: "runtime_profile_migration",
                  dbStatus: agent.status,
                  machineId: agent.machineId,
                  machineReachability: agent.machineId ? "reachable" : "unknown",
                }),
              }),
              this.lifecycleProjectionWriterDeps(),
              span,
            );
          }
        });
      } catch (err) {
        span.end("error", {
          attrs: {
            outcome: "nudge_failed",
            reason: "nudge_failed",
            error_class: errorClassOf(err),
          },
        });
        throw err;
      }
      span.end("ok", { attrs: { outcome: "gated_by_runtime_profile_migration", reason: "runtime_profile_migration_gate" } });
      return [];
    }
    let inbox = this.agentInboxes.get(agentId);
    if (!inbox) {
      inbox = { inbox: [], pendingReceive: null };
      this.agentInboxes.set(agentId, inbox);
    }

    const action = planReceiveAction({
      hasBufferedMessages: inbox.inbox.length > 0,
      block,
    });

    if (action === "return-buffered") {
      return Promise.resolve([...inbox.inbox]);
    }

    if (action === "return-empty") return Promise.resolve([]);
    return this.installReceiveWaiter({
      agentId,
      timeoutMs,
      signal,
    });
  }

  /**
   * Content-free bridge wake hints must be a peek, not a receive/drain.
   * This returns a copy of the current volatile server inbox without installing
   * a pending receive waiter and without acknowledging delivery.
   */
  peekPendingMessages(agentId: string): AgentMessage[] {
    const inbox = this.agentInboxes.get(agentId);
    return inbox ? [...inbox.inbox] : [];
  }

  protected installReceiveWaiter(context: ReceiveApplyContext): Promise<AgentMessage[]> {
    return new Promise((resolve) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout>;
      let cleanupAbortListener = () => {};

      const finish = (messages: AgentMessage[]) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        cleanupAbortListener();
        const ib = this.agentInboxes.get(context.agentId);
        if (ib?.pendingReceive === pendingReceive) {
          ib.pendingReceive = null;
        }
        resolve(messages);
      };

      timer = setTimeout(() => {
        // Return empty — the bridge returns a "take a rest" hint to the agent,
        // keeping the process alive until new messages arrive via stdin.
        finish([]);
      }, context.timeoutMs);

      const pendingReceive = { resolve, timer, finish };
      const inbox = this.agentInboxes.get(context.agentId);

      // Only one blocked receive can be active per agent. If a second long-poll
      // arrives, supersede the old waiter so it doesn't hang indefinitely or let
      // a stale abort/timeout clear the newer waiter.
      if (inbox?.pendingReceive) {
        inbox.pendingReceive.finish([]);
      }

      // If the HTTP connection is aborted, clean up gracefully
      if (context.signal) {
        const onAbort = () => finish([]);
        if (context.signal.aborted) {
          finish([]);
          return;
        }
        context.signal.addEventListener("abort", onAbort, { once: true });
        cleanupAbortListener = () => context.signal?.removeEventListener("abort", onAbort);
      }

      if (!inbox) {
        this.agentInboxes.set(context.agentId, { inbox: [], pendingReceive });
        return;
      }
      inbox.pendingReceive = pendingReceive;
    });
  }

  acknowledgeDeliveredMessages(agentId: string, seqs: number[], messageIds: string[] = []): { removedCount: number } {
    if (seqs.length === 0 && messageIds.length === 0) return { removedCount: 0 };
    const inbox = this.agentInboxes.get(agentId);
    if (!inbox || inbox.inbox.length === 0) return { removedCount: 0 };

    const { removed, retained } = partitionAcknowledgedMessages({
      inbox: inbox.inbox,
      ackedSeqs: new Set(seqs),
      ackedMessageIds: new Set(messageIds),
    });

    if (removed.length === 0) return { removedCount: 0 };
    inbox.inbox = retained;
    return { removedCount: removed.length };
  }

  discardUndeliverableMessages(agentId: string, messages: AgentMessage[]): { removedCount: number } {
    if (messages.length === 0) return { removedCount: 0 };
    const inbox = this.agentInboxes.get(agentId);
    if (!inbox || inbox.inbox.length === 0) return { removedCount: 0 };

    const seqs = new Set<number>();
    const seqlessMessageIds = new Set<string>();
    for (const message of messages) {
      if (Number.isInteger(message.seq) && (message.seq ?? 0) > 0) {
        seqs.add(message.seq!);
      } else if (message.message_id) {
        seqlessMessageIds.add(message.message_id);
      }
    }
    if (seqs.size === 0 && seqlessMessageIds.size === 0) return { removedCount: 0 };

    const retained: AgentMessage[] = [];
    let removedCount = 0;
    for (const queued of inbox.inbox) {
      const matchesSeq = Number.isInteger(queued.seq) && seqs.has(queued.seq!);
      const matchesSeqlessId = !queued.seq && Boolean(queued.message_id) && seqlessMessageIds.has(queued.message_id!);
      if (matchesSeq || matchesSeqlessId) {
        removedCount += 1;
      } else {
        retained.push(queued);
      }
    }

    if (removedCount === 0) return { removedCount: 0 };
    inbox.inbox = retained;
    return { removedCount };
  }

  private discardMessagesForChannels(agentId: string, channelIds: readonly string[]): { removedCount: number } {
    const channelIdSet = new Set(channelIds.filter((id) => typeof id === "string" && id.length > 0));
    if (channelIdSet.size === 0) return { removedCount: 0 };
    const inbox = this.agentInboxes.get(agentId);
    if (!inbox || inbox.inbox.length === 0) return { removedCount: 0 };

    const retained: AgentMessage[] = [];
    let removedCount = 0;
    for (const queued of inbox.inbox) {
      if (channelIdSet.has(queued.channel_id)) {
        removedCount += 1;
      } else {
        retained.push(queued);
      }
    }
    if (removedCount === 0) return { removedCount: 0 };
    inbox.inbox = retained;
    return { removedCount };
  }

  async purgeAgentInboxForChannels(
    agentId: string,
    channelIds: readonly string[],
    reason = "channel_membership_removed",
  ): Promise<{ localRemovedCount: number; machineSent: boolean }> {
    const local = this.discardMessagesForChannels(agentId, channelIds);
    const agent = await this.getCachedAgent(agentId);
    let machineSent = false;
    const dedupedChannelIds = [...new Set(channelIds.filter((id) => typeof id === "string" && id.length > 0))];
    if (agent?.machineId && dedupedChannelIds.length > 0) {
      this.sendBestEffortToMachine(agent.machineId, {
        type: "agent:inbox:purge",
        agentId,
        channelIds: dedupedChannelIds,
        reason,
      }, `purgeAgentInboxForChannels send failed for agent ${agentId}`);
      machineSent = true;
    }
    return { localRemovedCount: local.removedCount, machineSent };
  }

  async purgeAgentInboxForChannelTree(
    agentId: string,
    parentChannelId: string,
    reason = "channel_membership_removed",
  ): Promise<{ localRemovedCount: number; machineSent: boolean }> {
    const threadChannelIds = await this.listThreadChannelIdsForInboxPurge(parentChannelId);
    return this.purgeAgentInboxForChannels(agentId, [parentChannelId, ...threadChannelIds], reason);
  }

  protected async listThreadChannelIdsForInboxPurge(parentChannelId: string): Promise<string[]> {
    return channelService.listThreadChannelIdsForParentChannel(parentChannelId);
  }

  acknowledgeDeliveredMessagesForChannel(agentId: string, channelId: string, seqs: number[]): { removedCount: number } {
    if (seqs.length === 0) return { removedCount: 0 };
    const inbox = this.agentInboxes.get(agentId);
    if (!inbox || inbox.inbox.length === 0) return { removedCount: 0 };

    const { removed, retained } = partitionTargetScopedAcknowledgedMessages({
      inbox: inbox.inbox,
      channelId,
      ackedSeqs: new Set(seqs),
    });

    if (removed.length === 0) return { removedCount: 0 };
    inbox.inbox = retained;
    return { removedCount: removed.length };
  }

  acknowledgeDeliveredMessagesForChannelUpToSeq(agentId: string, channelId: string, maxSeq: number): { removedCount: number } {
    if (!Number.isInteger(maxSeq) || maxSeq <= 0) return { removedCount: 0 };
    const inbox = this.agentInboxes.get(agentId);
    if (!inbox || inbox.inbox.length === 0) return { removedCount: 0 };

    const { removed, retained } = partitionTargetScopedMessagesUpToSeq({
      inbox: inbox.inbox,
      channelId,
      maxSeq,
    });

    if (removed.length === 0) return { removedCount: 0 };
    inbox.inbox = retained;
    return { removedCount: removed.length };
  }

  /**
   * Pick the fresher of a local-cache snapshot vs the Redis cross-replica mirror
   * by `updatedAt`. On a tie the local cache wins (it was observed here). Returns
   * null when neither source has a snapshot.
   */
  async getActivity(agentId: string, options: ActivityTraceOptions = {}): Promise<VisibleActivity> {
    const span = this.tracer.startSpan("server.agent.activity.resolve", {
      parent: options.parent ?? null,
      surface: "server",
      kind: "internal",
      // This span is per getActivity(agentId). If resolve ever batches multiple
      // agents in one span, move raw identity to event-level attrs instead.
      attrs: { agent_id: agentId, agent_id_present: Boolean(agentId) },
    });
    try {
      const knownRow = options.persistedAgent?.id === agentId ? options.persistedAgent : undefined;
      const authoritativeAgent = () => this.getAuthoritativeAgentForActivity(agentId, knownRow);
      let agent = await this.getCachedAgent(agentId, knownRow);
      let localMachineId = agent?.machineId ?? null;
      let hostedLocally = localMachineId !== null && this.hasMachineLocally(localMachineId);
      let redisActivity: ActivitySnapshot | null | undefined;
      if (agent?.status === "stopped") {
        if (!hostedLocally && this.replicaStateStore.isAvailable()) {
          redisActivity = activitySnapshotFromPersisted(await this.replicaStateStore.getAgentActivity(agentId));
          if (redisActivity && redisActivity.activity !== "offline") {
            const freshAgent = await authoritativeAgent();
            if (freshAgent) agent = freshAgent;
          }
        }
      }
      if (agent?.status === "stopped") {
        const stopped = this.formatActivity("offline", "Stopped");
        span.end("ok", { attrs: { outcome: stopped.activity, source: "stopped-status" } });
        return stopped;
      }

      const runtimeErrorResolution = await this.resolveLastRuntimeErrorActivity(agentId, agent, authoritativeAgent);
      agent = runtimeErrorResolution.agent;
      localMachineId = agent?.machineId ?? null;
      hostedLocally = localMachineId !== null && this.hasMachineLocally(localMachineId);
      if (agent?.status === "stopped") {
        const stopped = this.formatActivity("offline", "Stopped");
        span.end("ok", { attrs: { outcome: stopped.activity, source: "stopped-status-refresh" } });
        return stopped;
      }
      if (runtimeErrorResolution.activity) {
        span.end("ok", {
          attrs: {
            outcome: runtimeErrorResolution.activity.activity,
            source: "runtime-error-state",
            runtime_error_authority: runtimeErrorResolution.source ?? "runtime-error-persisted",
          },
        });
        return runtimeErrorResolution.activity;
      }

      const activityCached = this.agentActivity.get(agentId);

      // task #1119: a wake crash-loop block is server-authored state, not a
      // daemon observation, so machine reachability arbitration does not
      // apply to it: while the served snapshot (local or shared mirror) is
      // wake_crash_loop_blocked, serve it as-is on every replica. A human
      // start writes the next snapshot and thereby lifts it.
      // RFC 071 §9: the terminal-failure breaker's block is server-authored the same way.
      const isServerBlock = (kind: string | undefined) => kind === "wake_crash_loop_blocked" || kind === "terminal_failure_paused";
      const blockedSnapshot = isServerBlock(activityCached?.detailKind)
        ? activityCached
        : !activityCached && this.replicaStateStore.isAvailable()
          ? (redisActivity ??= activitySnapshotFromPersisted(await this.replicaStateStore.getAgentActivity(agentId)))
          : null;
      if (blockedSnapshot && isServerBlock(blockedSnapshot.detailKind)) {
        const blocked = this.formatActivityFromSnapshot(blockedSnapshot);
        span.end("ok", { attrs: { outcome: blocked.activity, source: activityCached ? "local-cache" : "redis", typed_state: blockedSnapshot.detailKind } });
        return blocked;
      }

      // When the agent's machine is connected to THIS replica, the in-memory
      // cache is authoritative and fresh (it is written on every broadcast).
      if (activityCached && hostedLocally) {
        const resolved = await this.resolveActivityHint(agentId, agent, activityCached, "local-cache", span);
        if (resolved) {
          span.end("ok", { attrs: { outcome: resolved.activity, source: "local-cache" } });
          return resolved;
        }
      }

      // Non-owner read-through (cross-replica cache-coherence contract CC-004 /
      // CC-004a). The agent is not hosted on this replica, so the Redis mirror
      // written by the owning replica is the authoritative cross-replica source.
      // Read through it; NEVER prefer the process-lifetime local shadow — it has
      // no authority for a non-owned agent and was the A.3 staleness vector (a
      // stale-but-timestamp-recent local entry must not mask the owner's value).
      // When Redis is unreachable, pass through to the durable activity log /
      // derived state below rather than fall back to the local shadow, so
      // INV-CC-FRESH holds even under Redis degradation.
      if (this.replicaStateStore.isAvailable()) {
        redisActivity ??= activitySnapshotFromPersisted(await this.replicaStateStore.getAgentActivity(agentId));
        if (redisActivity) {
          if (redisActivity.activity === "offline" && agent && !hostedLocally) {
            const freshAgent = await authoritativeAgent();
            if (freshAgent) agent = freshAgent;
            const redisOfflineDetail = redisActivity.detail.trim();
            const hasSpecificRedisOfflineDetail = redisOfflineDetail !== "" && redisOfflineDetail.toLowerCase() !== "stopped";
            if (freshAgent?.status === "stopped" && !hasSpecificRedisOfflineDetail) {
              const stopped = this.formatActivity("offline", "Stopped");
              span.end("ok", { attrs: { outcome: stopped.activity, source: "redis-stopped-refresh" } });
              return stopped;
            }
          }
          const resolved = await this.resolveActivityHint(agentId, agent, redisActivity, "redis", span);
          if (resolved) {
            span.end("ok", { attrs: { outcome: resolved.activity, source: "redis" } });
            return resolved;
          }
        }
      }

      const persisted = await this.resolveRecentPersistedActivity(agentId, agent, span);
      if (persisted) {
        span.end("ok", { attrs: { outcome: persisted.activity, source: "persisted" } });
        return persisted;
      }
      const derived = await this.resolveDerivedActivity(agent);
      span.end("ok", { attrs: { outcome: derived.activity, source: "derived" } });
      return derived;
    } catch (err) {
      span.addEvent("activity.resolve.failed", {
        error_class: errorClassOf(err),
      });
      span.end("error");
      throw err;
    }
  }

  async listRecentActivityLog(agentId: string, limit = 50) {
    return this.loadPersistedActivityLog(agentId, limit);
  }

  /**
   * Diagnostics: when the live status snapshot was observed (the reporter's
   * occurredAt when known, else when this server recorded it), from the fresher
   * of the local snapshot and the cross-replica mirror. Null when neither exists.
   */
  async getLiveActivityObservedAtMs(agentId: string): Promise<number | null> {
    const local = this.agentActivity.get(agentId) ?? null;
    const mirrored = this.replicaStateStore.isAvailable()
      ? activitySnapshotFromPersisted(await this.replicaStateStore.getAgentActivity(agentId))
      : null;
    const snapshot = local && (!mirrored || local.updatedAt >= mirrored.updatedAt) ? local : mirrored;
    return snapshot ? this.getActivityObservedAtMs(snapshot) : null;
  }

  /**
   * Unified activity broadcast — emits a single `agent:activity` Socket.io event
   * carrying both the status (activity/detail) and trajectory entries.
   *
   * When trajectory entries are present, the event is emitted immediately (entries
   * must not be dropped). Explicit heartbeats, read-only activity-probe snapshots,
   * and the delivery-ack turn-active overlay emit refresh-only frames without
   * persistence; other status-only updates are debounced to merge rapid changes.
   */
  private broadcastActivity(
    agentId: string,
    activity: AgentActivityKind,
    detail: string = "",
    detailKind: AgentActivityDetailKind = "other",
    entries?: TrajectoryEntry[],
    nowOverride?: number,
    options: {
      dedupeKey?: string;
      launchId?: string;
      clientSeq?: number;
      probeId?: string;
      producerFactId?: string;
      observedAtMs?: number;
      isHeartbeat?: boolean;
      isDeliveryAckTurnActive?: boolean;
      arbitration?: ActivityBroadcastArbitrationInput;
    } = {},
  ): ActivityBroadcastTraceResult {
    const now = nowOverride ?? this.clock.now();
    const writeResult = this.writeAgentActivitySnapshot(agentId, activity, detail, detailKind, now, {
      launchId: options.launchId,
      observedAtMs: options.observedAtMs,
      arbitration: options.arbitration,
    });

    if (writeResult.action === "kernel-preserve") {
      return {
        action: "kernel-preserve",
        arbitration: writeResult.arbitration,
        persistedEntryCount: 0,
        previousActivity: writeResult.previousActivity,
        nextActivity: writeResult.nextActivity,
      };
    }

    const snapshot = writeResult.snapshot;
    if (!snapshot) {
      return {
        action: "kernel-preserve",
        arbitration: writeResult.arbitration,
        persistedEntryCount: 0,
        previousActivity: writeResult.previousActivity,
        nextActivity: writeResult.nextActivity,
      };
    }
    const nextActivity = snapshot.activity;
    const nextDetail = snapshot.detail;
    const nextDetailKind = snapshot.detailKind;

    const hasEntries = Boolean(entries && entries.length > 0);
    const shouldPersistStatusOnly = !hasEntries && this.shouldPersistStatusOnlyActivity(nextActivity, nextDetailKind);
    const action = planActivityBroadcastAction({
      hasEntries,
      isHeartbeat: options.isHeartbeat === true,
      isProbeResponse: options.probeId !== undefined,
      isDeliveryAckTurnActive: options.isDeliveryAckTurnActive === true,
      shouldPersistStatusOnly,
    });
    const persistedEntries: TrajectoryEntry[] = hasEntries
      ? (entries ?? [])
      : [{ kind: "status", activity: nextActivity, activityKind: nextActivity, detail: nextDetail, detailKind: nextDetailKind }];

    const persistence = this.applyActivityBroadcastAction({
      action,
      agentId,
      activity: nextActivity,
      detail: nextDetail,
      detailKind: nextDetailKind,
      now,
      persistedEntries,
      dedupeKey: options.dedupeKey,
      carriers: snapshotTypedCarriers(snapshot),
      // Pass-through join keys (task #136). Only attached to the
      // persist-and-emit-now path; status-only debounced emits drop
      // them on purpose so the final-state merge doesn't claim a
      // launch key that belongs to a particular pre-debounce
      // transition. Feedback-export classifies dropped rows as
      // `join_key_missing`.
      ...(options.launchId !== undefined ? { launchId: options.launchId } : {}),
      ...(options.clientSeq !== undefined ? { clientSeq: options.clientSeq } : {}),
      ...(options.probeId !== undefined ? { probeId: options.probeId } : {}),
      ...(options.producerFactId !== undefined ? { producerFactId: options.producerFactId } : {}),
      ...(options.isHeartbeat !== undefined ? { isHeartbeat: options.isHeartbeat } : {}),
    });

    return {
      action,
      arbitration: writeResult.arbitration,
      persistedEntryCount: action === "heartbeat-refresh"
        || action === "probe-refresh"
        || action === "delivery-ack-refresh"
        ? 0
        : persistedEntries.length,
      previousActivity: writeResult.previousActivity,
      nextActivity,
      persistence,
    };
  }

  private writeAgentActivitySnapshot(
    agentId: string,
    activity: AgentActivityKind,
    detail: string = "",
    detailKind: AgentActivityDetailKind = "other",
    now: number = this.clock.now(),
    options: {
      launchId?: string;
      observedAtMs?: number;
      arbitration?: ActivityBroadcastArbitrationInput;
    } = {},
  ): AgentActivitySnapshotWriteResult {
    const observedAtMs = options.observedAtMs ?? now;
    const observedAtMsExplicit = options.observedAtMs !== undefined;
    const current = this.agentActivity.get(agentId);
    const previousActivity = current?.activity ?? null;
    const arbitration = options.arbitration ?? {
      observationClass: "observed" as const,
      signalSite: "lifecycle_plan" as const,
    };
    const arbitrationDecision = this.planActivityBroadcastArbitration({
      activity,
      current,
      detailKind,
      launchId: options.launchId,
      now,
      observedAtMs,
      observedAtMsExplicit,
      signal: arbitration,
    });

    if (!arbitrationDecision.admit) {
      return {
        action: "kernel-preserve" as const,
        arbitration: {
          enabled: true,
          reason: arbitrationDecision.verdict?.reason ?? "legacy_disabled",
          verdictAction: arbitrationDecision.verdict?.action ?? "legacy",
        },
        previousActivity,
        nextActivity: current?.activity ?? activity,
      };
    }

    const nextActivity = arbitrationDecision.activity;
    const nextDetail = arbitrationDecision.detail ?? detail;
    const nextDetailKind = arbitrationDecision.detailKind ?? detailKind;
    const nextObservedAtMs = arbitrationDecision.observedAtMs ?? current?.observedAtMs;
    // task #1116: the carrier rides only a delivery_unconsumed write; any other
    // write drops it (and the pending capture) so it never lingers.
    const deliveryConsumption = nextDetailKind === "delivery_unconsumed"
      ? this.pendingDeliveryConsumption.get(agentId) ?? current?.deliveryConsumption
      : undefined;
    this.pendingDeliveryConsumption.delete(agentId);
    const wakeCrashLoop = nextDetailKind === "wake_crash_loop_blocked"
      ? this.pendingWakeCrashLoop.get(agentId) ?? current?.wakeCrashLoop
      : undefined;
    this.pendingWakeCrashLoop.delete(agentId);
    // task #1123: likewise the spawn-failure reason rides only a
    // runtime_unavailable write and is dropped by any other write.
    // A fresh runtime_unavailable ingest always decides (carrier or explicit
    // none); only a write that did not come from such a frame keeps the
    // current observation.
    const spawnFailure = nextDetailKind === "runtime_unavailable"
      ? (this.pendingSpawnFailure.has(agentId)
        ? this.pendingSpawnFailure.get(agentId) ?? undefined
        : current?.spawnFailure)
      : undefined;
    this.pendingSpawnFailure.delete(agentId);
    const snapshot: ActivitySnapshot = {
      activity: nextActivity,
      detail: nextDetail,
      detailKind: nextDetailKind,
      ...(nextObservedAtMs !== undefined ? { observedAtMs: nextObservedAtMs } : {}),
      updatedAt: now,
      ...(deliveryConsumption ? { deliveryConsumption } : {}),
      ...(wakeCrashLoop ? { wakeCrashLoop } : {}),
      ...(spawnFailure ? { spawnFailure } : {}),
    };

    this.agentActivity.set(agentId, snapshot);

    // Mirror to Redis for cross-replica consistency (fire-and-forget). The
    // typed carrier rides the same write so a non-owner replica's refresh
    // read-back exposes it (task #1116).
    this.replicaStateStore
      .setAgentActivity(agentId, nextActivity, nextDetail, nextDetailKind, nextObservedAtMs, snapshotTypedCarriers(snapshot))
      .catch(() => {});

    return {
      action: "map-write",
      arbitration: {
        enabled: arbitrationDecision.enabled,
        reason: arbitrationDecision.verdict?.reason ?? "legacy_disabled",
        verdictAction: arbitrationDecision.verdict?.action ?? "legacy",
      },
      previousActivity,
      nextActivity,
      snapshot,
    };
  }

  private isAgentActivityKernelArbitrationEnabled(): boolean {
    if (readAnyBooleanEnv([
      "RAFT_DISABLE_AGENT_ACTIVITY_KERNEL_ARBITRATION",
      "SLOCK_DISABLE_AGENT_ACTIVITY_KERNEL_ARBITRATION",
    ])) {
      return false;
    }
    return readAnyBooleanEnv([
      "RAFT_ENABLE_AGENT_ACTIVITY_KERNEL_ARBITRATION",
      "SLOCK_ENABLE_AGENT_ACTIVITY_KERNEL_ARBITRATION",
    ]);
  }

  private planActivityBroadcastArbitration(input: {
    activity: AgentActivityKind;
    current?: ActivitySnapshot;
    detailKind: AgentActivityDetailKind;
    launchId?: string;
    now: number;
    observedAtMs: number;
    observedAtMsExplicit: boolean;
    signal: ActivityBroadcastArbitrationInput;
  }): {
    activity: AgentActivityKind;
    admit: boolean;
    detail?: string;
    detailKind?: AgentActivityDetailKind;
    enabled: boolean;
    observedAtMs?: number;
    verdict?: LifecycleArbitrationVerdict;
  } {
    // External-agent activity (plugin hook events forwarded over the agent
    // API) always goes through the kernel: those events arrive over HTTP in
    // batches and may be reordered, so latest-occurredAt-wins must hold
    // regardless of the managed-agent rollout flag. Managed behavior is
    // unchanged: it still follows the env flag.
    const isExternalSignal = input.signal.planKind === "external_agent_signal";
    if (!isExternalSignal && !this.isAgentActivityKernelArbitrationEnabled()) {
      return {
        activity: input.activity,
        admit: true,
        detailKind: input.detailKind,
        enabled: false,
        observedAtMs: input.signal.observationClass === "observed"
          ? input.observedAtMsExplicit
            ? input.observedAtMs
            : input.current?.observedAtMs
          : input.current?.observedAtMs,
      };
    }

    const currentProjection = input.current
      ? legacyActivityToCanonicalProjection(input.current.activity, input.current.detailKind)
      : "unknown";
    const incomingProjection = legacyActivityToCanonicalProjection(input.activity, input.detailKind);
    const verdict = arbitrateLifecycleProjection(
      {
        currentLaunchGeneration: input.launchId ?? null,
        // External ordering compares only against previously observed external
        // time; an unrelated server-side write's wall-clock updatedAt must not
        // make a slightly-skewed client event look stale.
        lastObservedAtMs: input.current?.observedAtMs
          ?? (isExternalSignal ? 0 : input.current?.updatedAt ?? 0),
        projection: currentProjection,
        startingAffordance: input.current ? this.isStartingActivitySnapshot(input.current) : false,
      },
      {
        atMs: input.observedAtMs,
        launchGeneration: input.launchId ?? null,
        observationClass: input.signal.observationClass,
        projection: incomingProjection,
      },
    );

    if (
      verdict.action === "preserve"
      || (verdict.action === "arbitrate" && verdict.projection === currentProjection && incomingProjection !== currentProjection)
    ) {
      return {
        activity: input.current?.activity ?? input.activity,
        admit: false,
        detail: input.current?.detail,
        detailKind: input.current?.detailKind,
        enabled: true,
        observedAtMs: input.current?.observedAtMs,
        verdict,
      };
    }

    if (verdict.action === "degrade_unknown") {
      return {
        activity: input.current?.activity ?? input.activity,
        admit: false,
        detail: input.current?.detail,
        detailKind: input.current?.detailKind,
        enabled: true,
        observedAtMs: input.current?.observedAtMs,
        verdict,
      };
    }

    if (verdict.action === "resolve_starting") {
      return {
        activity: "online",
        admit: true,
        detail: "",
        detailKind: "idle",
        enabled: true,
        observedAtMs: input.current?.observedAtMs,
        verdict,
      };
    }

    const admittedObservedAtMs = input.signal.observationClass === "observed"
      || input.signal.observationClass === "observed_turn_active"
      ? Math.max(input.current?.observedAtMs ?? 0, input.observedAtMs)
      : input.current?.observedAtMs;
    return {
      activity: input.activity,
      admit: true,
      detailKind: input.detailKind,
      enabled: true,
      observedAtMs: admittedObservedAtMs,
      verdict,
    };
  }

  protected applyActivityBroadcastAction(context: ActivityBroadcastApplyContext): Promise<ActivityPersistenceOutcome> | undefined {
    if (context.action === "persist-and-emit-now") {
      const persistence = this.persistActivityEvent(
        context.agentId,
        context.activity,
        context.detail,
        context.persistedEntries,
        new Date(context.now),
        context.dedupeKey,
      ).then((inserted): ActivityPersistenceOutcome => inserted ? "applied" : "deduped")
        .catch((err): ActivityPersistenceOutcome => {
          console.warn(`[ActivityLog ${context.agentId}] Failed to persist activity event:`, err);
          return "error";
        });

      // Trajectory entries present — emit immediately (cancel any pending debounce)
      const existing = this.activityDebounceTimers.get(context.agentId);
      if (existing) {
        clearTimeout(existing);
        this.activityDebounceTimers.delete(context.agentId);
      }
      this.emitActivity(
        context.agentId,
        context.activity,
        context.detail,
        context.detailKind,
        context.now,
        context.persistedEntries,
        // Pass-through join keys on the immediate-emit path (task #136).
        // Status-only debounced emits below (line ~5800) intentionally
        // do not carry these — see ActivityBroadcastApplyContext doc.
        {
          ...(context.launchId !== undefined ? { launchId: context.launchId } : {}),
          ...(context.clientSeq !== undefined ? { clientSeq: context.clientSeq } : {}),
          ...(context.probeId !== undefined ? { probeId: context.probeId } : {}),
          ...(context.producerFactId !== undefined ? { producerFactId: context.producerFactId } : {}),
          ...(context.carriers ? { carriers: context.carriers } : {}),
        },
      );
      return persistence;
    }

    if (
      context.action === "heartbeat-refresh"
      || context.action === "probe-refresh"
      || context.action === "delivery-ack-refresh"
    ) {
      const existing = this.activityDebounceTimers.get(context.agentId);
      if (existing) {
        clearTimeout(existing);
        this.activityDebounceTimers.delete(context.agentId);
      }
      void this.emitActivity(
        context.agentId,
        context.activity,
        context.detail,
        context.detailKind,
        context.now,
        undefined,
        {
          ...(context.launchId !== undefined ? { launchId: context.launchId } : {}),
          ...(context.clientSeq !== undefined ? { clientSeq: context.clientSeq } : {}),
          ...(context.probeId !== undefined ? { probeId: context.probeId } : {}),
          ...(context.producerFactId !== undefined ? { producerFactId: context.producerFactId } : {}),
          ...(context.action === "heartbeat-refresh" ? { isHeartbeat: true } : {}),
          isRefreshOnly: true,
          ...(context.carriers ? { carriers: context.carriers } : {}),
        },
      );
      return undefined;
    }

    // Status-only update — debounce to merge rapid state changes
    const existing = this.activityDebounceTimers.get(context.agentId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.activityDebounceTimers.delete(context.agentId);
      const latest = this.agentActivity.get(context.agentId);
      if (!latest) return;
      this.emitActivity(context.agentId, latest.activity, latest.detail, latest.detailKind, this.clock.now(), undefined, {
        carriers: snapshotTypedCarriers(latest),
      });
    }, AgentOrchestrator.ACTIVITY_DEBOUNCE_MS);

    this.activityDebounceTimers.set(context.agentId, timer);
    return undefined;
  }

  protected async updateMachineHeartbeat(machineId: string) {
    await machineService.updateHeartbeat(machineId);
  }

  protected async persistActivityEvent(
    agentId: string,
    activity: string,
    detail: string,
    entries: TrajectoryEntry[],
    createdAt: Date,
    dedupeKey?: string,
  ): Promise<boolean> {
    if (this.shouldSkipActivityLogPersistence(agentId)) {
      return false;
    }
    return agentActivityLogService.appendAgentActivityEvent(agentId, activity, detail, entries, createdAt, dedupeKey);
  }

  private shouldSkipActivityLogPersistence(agentId: string): boolean {
    const agent = this.agentStateCache.get(agentId);
    return agent ? hydrateRuntimeConfig(agent).runtime === "kimi" : false;
  }

  private planKimiActivityCircuitBreaker(input: {
    activity: AgentActivity;
    agent: CachedAgentState;
    entries?: TrajectoryEntry[];
    launchId?: string | null;
    now: number;
    probeId?: string;
  }): KimiActivityCircuitDecision {
    const runtime = hydrateRuntimeConfig(input.agent).runtime;

    // Workaround for Kimi CLI crash loops observed in production on 2026-06-04.
    // Kimi can alternate repeated `error`/`working` updates for the same launch
    // fast enough to saturate lifecycle projection, Redis mirror, and Socket.IO
    // fanout. Keep the CLI usable by preserving user messages, probes,
    // launch/clientSeq guards, terminal states, and genuinely new trajectory
    // entries; only collapse repeated same-launch crash/working signatures
    // before the expensive projection writer. Delete this once daemon activity
    // is split into first-class lifecycle/progress/log-entry protocols.
    const candidateSignature =
      runtime === "kimi"
      && Boolean(input.launchId)
      && !input.probeId
      && (input.activity === "error" || input.activity === "working")
        ? this.kimiActivityCircuitSignature(input.activity, input.entries)
        : null;

    if (!candidateSignature) {
      if (
        runtime === "kimi"
        && input.launchId
        && (input.activity === "offline" || input.activity === "online")
      ) {
        this.kimiActivityCircuitByLaunch.delete(`${input.agent.id}:${input.launchId}`);
      }
      return { action: "allow" };
    }

    const key = `${input.agent.id}:${input.launchId}`;
    const existing = this.kimiActivityCircuitByLaunch.get(key);
    if (!existing || input.now - existing.lastObservedAt > AgentOrchestrator.KIMI_ACTIVITY_CIRCUIT_WINDOW_MS) {
      this.kimiActivityCircuitByLaunch.set(key, {
        emittedSignatures: new Set([candidateSignature]),
        lastEmittedAt: input.now,
        lastObservedAt: input.now,
        suppressedCount: 0,
      });
      return { action: "allow" };
    }

    existing.lastObservedAt = input.now;

    if (!existing.emittedSignatures.has(candidateSignature)) {
      existing.emittedSignatures.add(candidateSignature);
      return { action: "allow" };
    }

    if (input.now - existing.lastEmittedAt >= AgentOrchestrator.KIMI_ACTIVITY_CIRCUIT_AGGREGATE_MS) {
      const aggregateSuppressedCount = existing.suppressedCount;
      existing.lastEmittedAt = input.now;
      existing.suppressedCount = 0;
      return { action: "allow", aggregateSuppressedCount };
    }

    existing.suppressedCount += 1;
    return { action: "suppress", suppressedCount: existing.suppressedCount };
  }

  private kimiActivityCircuitSignature(activity: AgentActivity, entries?: TrajectoryEntry[]): string {
    if (!entries?.length) return "status-only";

    const entrySignature = entries
      .map((entry) => {
        switch (entry.kind) {
          case "thinking":
          case "text":
            return `${entry.kind}:${entry.text}`;
          case "tool_start":
            return `tool_start:${entry.toolName}:${entry.toolInput}`;
          case "slock_action":
          case "system":
            return `${entry.kind}:${entry.title}:${entry.text}`;
          case "compaction_started":
          case "compaction_finished":
            return entry.kind;
          case "status":
            return `status:${entry.activity}:${entry.detail}`;
        }
      })
      .join("\n")
      .slice(0, 4000);

    return `${activity}:${entrySignature}`;
  }

  protected async loadPersistedActivityLog(agentId: string, limit: number) {
    return agentActivityLogService.listRecentAgentTrajectory(agentId, limit);
  }

  protected async loadLatestPersistedActivityHint(agentId: string) {
    return agentActivityLogService.getLatestAgentActivityHint(agentId);
  }

  private async emitActivity(
    agentId: string,
    activity: AgentActivityKind,
    detail: string,
    detailKind: AgentActivityDetailKind,
    timestamp: number,
    entries?: TrajectoryEntry[],
    joinKeys?: {
      launchId?: string;
      clientSeq?: number;
      probeId?: string;
      producerFactId?: string;
      isHeartbeat?: boolean;
      isRefreshOnly?: boolean;
      carriers?: ActivityTypedCarriers;
    },
  ) {
    const agent = await this.getCachedAgent(agentId);
    if (agent) {
      // Bump the monotonic seq before emit so the client can
      // drop pushes that arrive out-of-order during reconnect storms
      // (a race between socket-pushed updates and an in-flight
      // `loadAgents()` REST call). (#engineering:72283cf7 task #340 PR B)
      const nextSeq = nextActivityServerSeq(this.lastActivityServerSeq, this.clock.now());
      this.lastActivityServerSeq = nextSeq;
      // task #1116: pass the daemon's typed carrier through when this emit is
      // the delivery_unconsumed observation (ids/classes/counts only).
      // Prefer the carrier of the snapshot this emit is for; fall back to the
      // current snapshot for legacy call sites that did not thread it.
      const current = this.agentActivity.get(agentId);
      const deliveryConsumption = detailKind === "delivery_unconsumed"
        ? joinKeys?.carriers?.deliveryConsumption ?? current?.deliveryConsumption
        : undefined;
      const wakeCrashLoop = detailKind === "wake_crash_loop_blocked"
        ? joinKeys?.carriers?.wakeCrashLoop ?? current?.wakeCrashLoop
        : undefined;
      // task #1123: the typed spawn-failure reason rides the runtime_unavailable emit.
      const spawnFailure = detailKind === "runtime_unavailable"
        ? this.agentActivity.get(agentId)?.spawnFailure
        : undefined;
      const publicPayload = {
        agentId,
        activity,
        activityKind: activity,
        detail,
        detailKind,
        timestamp,
        serverSeq: nextSeq,
        ...(deliveryConsumption ? { deliveryConsumption } : {}),
        ...(wakeCrashLoop ? { wakeCrashLoop } : {}),
        ...(spawnFailure ? { spawnFailure } : {}),
        // Daemon socket-message join keys (task #136). `serverSeq` is the
        // server-side monotonic identity for THIS broadcast; `clientSeq`
        // is the daemon-side monotonic identity for the inbound message
        // that produced it. Keep them as separate fields so feedback-
        // export bundles can exact-join the latter against
        // `server.agent.activity.ingest` correlationId
        // `agent:<agentId>:daemonActivity:<launchId|legacy>:<clientSeq>`.
        ...(joinKeys?.launchId !== undefined ? { launchId: joinKeys.launchId } : {}),
        ...(joinKeys?.clientSeq !== undefined ? { clientSeq: joinKeys.clientSeq } : {}),
        ...(joinKeys?.probeId !== undefined ? { probeId: joinKeys.probeId } : {}),
        ...(joinKeys?.producerFactId !== undefined ? { producerFactId: joinKeys.producerFactId } : {}),
        ...(joinKeys?.isHeartbeat !== undefined ? { isHeartbeat: joinKeys.isHeartbeat } : {}),
        ...(joinKeys?.isRefreshOnly !== undefined ? { isRefreshOnly: joinKeys.isRefreshOnly } : {}),
      };
      const doEmit = () => {
        // Server and joint projection rooms can include members who may not be
        // allowed to inspect the agent's private workspace/action trajectory.
        // Keep raw entries behind the creator/admin activity-log hydration path.
        this.io?.to(`server:${agent.serverId}`).emit("agent:activity", publicPayload);
        void this.emitJointActivityToProjectionRooms(agent.id, agent.serverId, publicPayload);
      };
      // Injectable seam for the realtime push. Per cache-coherence contract
      // CC-006 the push is best-effort (drop/delay/reorder) and MUST NOT be
      // load-bearing for correctness — convergence is owed to write-through +
      // pull. Tests inject drop/delay here to prove that. Production uses the
      // noop failpoint registry: the fast path below runs the emit synchronously,
      // identical to before.
      if (!failpoints.enabled) {
        doEmit();
        return;
      }
      await failpoints.hit("server.agentActivity.emit", { agentId, activity, serverSeq: nextSeq }, doEmit);
    }
  }

  private async emitJointActivityToProjectionRooms(
    agentId: string,
    sourceServerId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      const channelIds = await this.loadJointActivityProjectionChannelIdsForAgent(agentId, sourceServerId);
      for (const channelId of channelIds) {
        this.io?.to(`channel:${channelId}`).emit("agent:activity", payload);
      }
    } catch (err) {
      console.error("[AgentOrchestrator] Failed to fan out joint activity", err);
    }
  }

  protected async loadJointActivityProjectionChannelIdsForAgent(agentId: string, sourceServerId: string): Promise<string[]> {
    return channelService.listJointActivityProjectionChannelIdsForAgent(agentId, sourceServerId);
  }
}
