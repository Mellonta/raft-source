import type { AgentApiHistoryConsumptionScope } from "@botiverse/raft-shared";
import { readFileSync, rmSync } from "node:fs";
import { lstat, readFile, readdir, rm, stat } from "node:fs/promises";
import { createHash, randomInt, randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { daemonFetch } from "./daemonFetch";
import { runtimeEventEndsThinking, trajectoryActivityProjection } from "./activity/agentActivityProducer";
import { LegacyActivitySink, type ActivityProducerContext, type ActivitySink } from "./activity/activitySink";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
import {
  type DeliveryConsumptionActivityDiagnostic,
  getToolActivityLabel,
  normalizeToolDisplayInvocation,
  resolveToolSemantic,
  summarizeToolInput,
  type AgentMessage,
  type MentionDeliveryIdentitySnapshot,
  type MentionDeliveryTerminalErrorCode,
  type MentionDeliveryTransitionStage,
  type AgentInboxAppItem,
  type AgentConfig,
  type AgentRuntimeProfileReport,
  type RuntimeProfileReportSource,
  type FileNode,
  type MachineToServerMessage,
  type AgentRuntimeOutcome,
  type AgentStartNotSpawnedReason,
  type ServerToMachineMessage,
  type WorkspaceDirectoryInfo,
  type TrajectoryEntry,
  type SubagentLineage,
  type AgentActivityDetailKind,
  type AgentActivityKind,
  type RuntimeErrorActivityDiagnostic,
  type RuntimeCompactionInterruption,
  type SkillInfo,
  type AttentionHint,
  errorClassOf,
  noopTracer,
  type ActiveSpan,
  formatTraceparent,
  parseTraceparent,
  type TraceContext,
  type Tracer,
  setClockTimeout,
  clearClockTimeout,
  type ObservedFailureSummary,
  type FeedbackMachineState,
  type FeedbackTraceTail,
  asFeedbackTranscriptLookupMethod,
  type FeedbackTranscriptContentKind,
  type FeedbackTranscriptLookupMethod,
  type FeedbackTranscriptLookupReason,
  type FeedbackTranscriptUploadableContentKind,
  MODEL_SEEN_MAX_ITEMS_PER_REPORT,
} from "@botiverse/raft-shared";
import { appInboxItemTraceAttrs } from "@botiverse/raft-shared/src/appRuntimeTrace";
import { getActiveTraceContext, runWithActiveSpan, runWithoutActiveSpan, withCanonicalTraceAttributes } from "@botiverse/raft-trace-client";

/** Legacy identity keys whose canonical field may live on events (see `fields.ts` placement). */
const DAEMON_EVENT_CANONICAL_ALIAS_KEYS = ["agentId"] as const;
import {
  collectFeedbackTranscriptAttachment,
  defaultFeedbackTranscriptReportWindow,
  type FeedbackTranscriptCollectionResult,
  type FeedbackTranscriptReportWindowInput,
} from "./feedbackTranscriptCollector";
import { collectFeedbackMachineLogTailAttachment } from "./feedbackMachineLogTail";
import { uploadFeedbackTranscriptOutcome, type FeedbackTranscriptOutcomeUploadStatus } from "./feedbackTranscriptOutcomeUpload";
import { collectFeedbackMachineState, collectFeedbackTraceTail, redactedOrNull } from "./feedbackMachineEvidence";
import { collectObservedFailureSummary } from "./observedFailureSummary";
import { parseSkillFrontmatter } from "./skillFrontmatter";
import { isPathWithinAllowedRoots, readAndRedactTranscriptDetailed, TranscriptPathRejectedError } from "./sessionTranscriptReader";
import {
  allowedTranscriptRootsForRuntime,
  createChildProcessRuntimeSession,
  ensureRuntimeHomeDir,
  getDriver,
  projectCompactionInterruptionTraceAttrs, projectStructuredRuntimeTerminalFailure,
  projectCompactionInterruption, formatCompactionInterruption,
  resolveRuntimeHomeDir,
  resolveRuntimeSessionRef,
  resolveRuntimeSessionRefDetailed,
  type RuntimeDriver,
  type ParsedEvent,
  type ResolveRuntimeSessionRefOptions,
  type RuntimeSession,
  type RuntimeSendResult,
} from "./drivers/index";
import { logger } from "./logger";
import { bindContextGenerationToSession, configPassiveAx, rememberSessionContext, writeContextGeneration } from "./contextGeneration";
import { resolvePassiveAx } from "./passiveAxGate";
import { buildCliTransportDir } from "./drivers/cliTransport";
import { reapOrphanProcesses } from "./daemonOrphanReaper";
import { deleteWorkspaceDirectory, initializeAgentWorkspace, scanWorkspaceDirectories } from "./workspaces";
import { buildCindyMemoryMd, buildCindySeedFiles } from "./cindy";
import { AgentStartCoordinator, type AgentStartQueueItem, type PendingStartRebind } from "./agentStartCoordinator";
import type { CapabilityWait, RecoveryGrant, StartRefusalDecision } from "./runtimeOutcomeOutbox";
import { AgentStartDispatchProjection, type AgentStartAcceptance } from "./agentStartDispatchProjection";
import { AgentStartPendingDeliveryBuffer } from "./agentStartPendingDeliveryBuffer";
import {
  AgentNoProcessResidency,
  AgentNoProcessResidencyTransitions,
  type AgentNoProcessResidencyCloseResult,
  type AgentNoProcessResidencyEnterInput,
  type AgentNoProcessResidencySnapshot,
  type AgentNoProcessResidencyState,
  type AgentNoProcessResidencyTransitionIdentity,
  type AgentNoProcessResidencyTransitionRow,
} from "./agentNoProcessResidency";
import {
  AgentLifecycleRecords,
  buildAgentLifecycleRecords,
  type AgentLifecycleRecord,
  type AgentLifecycleRecordSnapshot,
} from "./agentLifecycleRecord";
import {
  LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN,
  LAUNCH_ACTIVATION_DELIVERY_TRANSITION_SPAN,
  buildLaunchReadinessEnterAttrs,
  buildLaunchReadinessCloseAttrs,
  buildLaunchActivationEnterAttrs,
  buildLaunchActivationCloseAttrs,
  launchReadinessNegativeEvidence,
  type LaunchCloseResult,
  type LaunchDeliveredVia,
  type LaunchFenceKind,
  type LaunchIdentityAttrs,
  type LaunchReadinessTransitionState,
  type LaunchActivationTransitionState,
} from "./launchPhaseTransition";
import { AgentVisibleDeliveryLedger, formatAgentMessageVisibleTarget } from "./agentVisibleDeliveryLedger";
import {
  NATIVE_STANDING_PROMPT_STARTUP_INPUT,
  RUNTIME_PROFILE_DAEMON_NOTICE_MESSAGE_PREFIX,
  adoptAxSurfaceText,
  composeAxSurfaces,
  formatAppInboxNoticeSuffix,
  formatBoundedStartupUnreadSuffix,
  formatConcreteMessagesRuntimeInput,
  formatInboxUpdateRuntimeInput,
  formatOtherUnreadChannelsSuffix,
  formatResumeEmptyPrompt,
  formatResumeUnreadSummaryPrompt,
  formatRuntimeProfileControlPrompt,
  formatRuntimeProfileControlStartupInput,
  formatSystemNoticeRuntimeInput,
  formatUnreadSummaryAddendum,
  formatUnreadSummaryRows,
  groupThreadJoinContextReceiptMessages,
  inboxProjectionTraceAttrs,
  projectThreadJoinContextsForRuntimeInput,
  runtimeProfileNotificationFromMessage,
  type AxSurfaceText,
  type RuntimeProfileControlKind,
} from "./agentRuntimeInput";
import {
  buildBoundedVisibleCrashProjection,
  buildClaudeStartupCrashRuntimeError,
} from "./claudeStartupCrashDiagnostic";
import {
  runtimeDisplayName,
  buildRuntimeErrorActivityDiagnostic,
  buildRuntimeErrorDiagnosticEnvelope,
  formatRuntimeInputTooLargeMessage,
  formatRuntimeLoginRequiredMessage,
  formatRuntimeStartTimeoutMessage,
  isRuntimeInputTooLargeErrorText,
  formatRuntimeBillingExhaustedMessage,
  formatRuntimePlanAccessMessage,
  isRuntimePlanAccessErrorText,
} from "./runtimeErrorDiagnostics";
import { isCodexToolArgumentParseErrorChunk } from "./codexToolArgumentParseSignature";
import { materializeProviderConnectionForSpawn } from "./providerConnectionLaunch";
import { applyStartupMemoryBlock, buildStartupMemoryBlock, resolveStartupMemoryBlockConfig } from "./startupMemoryBlock";
import { COLD_IDLE_SWEEP_MS, applyWakeRecycleBriefing, describeAppliedWakeRecycle, planWakeSessionRecycle, selectColdIdleRecycleStops } from "./wakeSessionRecycle";
import { RuntimeProgressState } from "./runtimeProgressState";
import {
  DeliveryConsumptionWatch,
  isDeliveryConsumptionEvent,
  type DeliveryConsumptionSnapshot,
  type DeliveryWritePath,
} from "./deliveryConsumptionWatch";
import { computeInboxNoticeFingerprint, RuntimeNotificationState } from "./runtimeNotificationState";
import {
  clearSessionReadyDeliveryRetry,
  createSessionReadyDeliveryRetryState,
  flushIdleInboxDeliveryRetry as flushIdleInboxDeliveryRetryDebt,
  flushSessionReadyDeliveryRetry as flushSessionReadyDeliveryRetryDebt,
  prepareSessionInitDeliveryDebtRetry,
  queueAgentInboxMessage,
  scheduleSessionReadyDeliveryRetry as scheduleSessionReadyDeliveryRetryDebt,
  type SessionReadyDeliveryRetryFlushSource,
  type SessionReadyDeliveryRetryState,
} from "./agentInboxDeliveryDebt";
import { RuntimeBusyDeliveryCoordinator } from "./runtimeBusyDeliveryCoordinator";
import {
  runtimeDiagnosticTraceAttrs,
  runtimeRecoveryTraceAttrs,
  runtimeTurnEventTraceAttrs, normalizeAgentProcessErrorClass,
  type RuntimeDiagnosticEvent,
  type RuntimeRecoveryEvent,
} from "./runtimeEventTrace";
import {
  formatRuntimeErrorFingerprintFenceDetail,
  recoverableRuntimeDeliveryBackoffReason,
  recoverableRuntimeProcessCloseReason,
  runtimeErrorFingerprintFenceResetEvent,
} from "./runtimeErrorDeliveryPolicy";
import { DecisionErrorWindow, pushRecentStderr, pushRecentStdout } from "./runtimeOutputWindow";
import { RuntimeProcessBindingFence } from "./runtimeProcessBindingFence";
import type { AgentAppInboxNoticeOptions, AgentAppInboxStore } from "./agentAppInbox";
import { enforceRuntimeLaunchVersion } from "./runtimeLaunchVersion";
import {
  codexCommunicationGapAttrs,
  createRuntimeTraceCounters,
  noteRaftMessageSendAttempt,
  noteRuntimeTraceCounter,
  runtimeToolingObservationAttrs,
  runtimeTraceCounterAttrs,
  type RuntimeTraceCounters,
} from "./runtimeCommunicationTrace";
import { resolveRaftHome, resolveRaftHomePath } from "./raftHome";
import {
  createTurnOutcomeCounters,
  noteTurnOutcomeEvent,
  terminalFailureFromRawText,
  terminalFailureFromRuntimeErrorEvent,
  turnCompletedOutcome,
  type TerminalRuntimeFailureEvidence,
  type TurnOutcomeCounters,
} from "./runtimeOutcome";
import { hasConfiguredCodexHome, resolveCodexHomeRootFromEnv } from "./drivers/codexHome";
import { isClaudeCustomProviderConfig } from "./drivers/claudeProviderIsolation";
import { hasStableLocalMessageId, type AgentProxyFreshnessDecision, type AgentProxyInboxCoordinator, type AgentProxyVisibleMessage } from "./agentCredentialProxy";
import { buildAgentProxyInboxCoordinator } from "./agentProxyInboxCoordinator";
import { cleanupLaunchProxies } from "./launchProxyCleanup";
import { projectAgentInboxSnapshot, type AgentInboxTargetRow } from "./agentInboxProjection";
import { sanitizeRuntimeTelemetryPayloadAttrs } from "./runtimeTelemetrySanitization";
import { bucketBytes, summarizeMessageInputBytes } from "./runtimeInputByteMetrics";
import {
  commitApmGatedSteeringDecisionState,
  createInitialApmGatedSteeringState,
  projectApmHeldFreshnessActivity,
  reduceApmGatedCompaction,
  reduceApmGatedCompactionBoundaryFlush,
  reduceApmGatedError,
  reduceApmGatedReview,
  reduceApmGatedReviewBoundaryFlush,
  reduceApmGatedTurnEnd,
  reduceApmToolUse,
  reduceApmIdleState,
  reduceApmColdIdleRecycleTermination,
  reduceApmStalledRecoveryTermination,
  reduceApmStartupRequestErrorTermination,
  reduceApmStartupTimeoutTermination,
  projectApmRuntimeProgressStalledTrace, projectRuntimeToolDiagnosticActivity,
  projectApmRuntimeStallDiagnostic,
  projectApmRuntimeTerminationTrace,
  type ApmExpectedTerminationReason,
  type ApmGatedFlushReason,
  type ApmGatedSteeringEffect,
  type ApmGatedSteeringDecisionState,
} from "./apmStateMachine";

export { DecisionErrorWindow } from "./runtimeOutputWindow";

const DEFAULT_MAX_CONCURRENT_AGENT_STARTS = 5;
const DEFAULT_AGENT_START_INTERVAL_MS = 500;
const RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS = 3;

function assertNeverApmEffect(effect: never): never {
  throw new Error(`Unhandled APM gated steering effect: ${String(effect)}`);
}

const MODEL_WORK_EVENT_KINDS: ReadonlySet<ParsedEvent["kind"]> = new Set<ParsedEvent["kind"]>([
  "thinking",
  "text",
  "tool_call",
  "tool_output",
]);

function isModelWorkEvent(kind: ParsedEvent["kind"]): boolean {
  return MODEL_WORK_EVENT_KINDS.has(kind);
}

function runtimeSendFailureOutcome(result: RuntimeSendResult): "encode_failed" | "send_failed" {
  return !result.ok && result.reason === "unsupported" ? "encode_failed" : "send_failed";
}

const RUNNER_CREDENTIAL_MINT_RETRY_DELAY_MS = 250;
const WORKSPACE_TEXT_FILE_MAX_BYTES = 1_048_576;
const WORKSPACE_IMAGE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

const WORKSPACE_TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".js", ".ts", ".jsx", ".tsx", ".yaml", ".yml",
  ".toml", ".log", ".csv", ".xml", ".html", ".css", ".sh", ".py",
]);

const WORKSPACE_IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const WORKSPACE_NEVER_VISIBLE_HIDDEN_NAMES = new Set([
  ".aws",
  ".gnupg",
  ".ssh",
  ".slock",
  ".slock-runtime",
]);

const WORKSPACE_SECRET_FILE_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /(?:^|[._-])secret(?:s)?(?:[._-]|$)/i,
  /(?:^|[._-])credential(?:s)?(?:[._-]|$)/i,
  /(?:^|[._-])token(?:s)?(?:[._-]|$)/i,
];

function isWorkspaceNeverVisibleHiddenEntry(name: string): boolean {
  return WORKSPACE_NEVER_VISIBLE_HIDDEN_NAMES.has(name) || name.startsWith(".slock-");
}

function workspacePathParts(relativePath: string): string[] {
  return relativePath.split(path.sep).filter(Boolean);
}

function isWorkspaceHiddenPath(relativePath: string): boolean {
  return workspacePathParts(relativePath).some((part) => part.startsWith("."));
}

function isWorkspaceNeverVisibleHiddenPath(relativePath: string): boolean {
  return workspacePathParts(relativePath).some(isWorkspaceNeverVisibleHiddenEntry);
}

function isWorkspaceSecretFilePath(filePath: string): boolean {
  return workspacePathParts(filePath).some((part) =>
    WORKSPACE_SECRET_FILE_PATTERNS.some((pattern) => pattern.test(part))
  );
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function readNonNegativeIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/**
 * task #1120: the manager's start failure wrapper. Carries the driver's typed
 * launch error as `cause` and mirrors its spawn-failure code so
 * `classifySpawnFailure` still decides by code after the message was rewritten.
 */
/** RFC 071 outbox: the open-launch record could not be written, so the runtime process was not spawned. */
export class RuntimeOutcomeStorageBlockedError extends Error {
  constructor(agentId: string) {
    super(`Runtime not started for ${agentId}: runtime outcome storage failed (open-launch record not written)`);
    this.name = "RuntimeOutcomeStorageBlockedError";
  }
}

/** RFC 071 outbox: "persist the open record, then spawn / rebind" (see runtimeOutcomeOutbox.ts). */
export interface RuntimeProcessGate {
  /** `spawnLaunchId` null: an internal start without a server launch (keyed by `processInstanceId`). */
  openProcess(agentId: string, processInstanceId: string, spawnLaunchId: string | null): boolean;
  /** The exit of a process started without a server launch and never rebound to one (it has no `process_exited` frame). */
  processExitedLocally(agentId: string, processInstanceId: string): void;
  /** A spawn that failed before its process was reported spawned: no runtime runs and no process frame will name it. */
  processNotStarted(agentId: string, processInstanceId: string): void;
  /**
   * Checked at the entry of the spawn and the rebind every start goes
   * through: the shown reason this agent may not be started or reused now
   * (the automatic-start rule: its runtime outcome evidence is known
   * incomplete), or null. `recoveryGrant` is the grant of the admitted human
   * start that `launchId` is, passed only for that start; it is spent by
   * this call. Every other start (crash respawn, cold start, rebind, ...)
   * passes null and is decided as automatic.
   */
  startRefusal(agentId: string, launchId: string | null, recoveryGrant: RecoveryGrant | null): StartRefusalDecision | null;
  /**
   * Wait for the current server connection's runtime-outcome capability. A
   * start that would create a process waits for it (held, not refused: its
   * messages stay buffered as for any starting agent). Cancellable: a stop
   * of the agent cancels that start's wait; the daemon stopping cancels all.
   */
  waitForCapability(): CapabilityWait;
}

/** The typed "executable not resolvable" failure with a known reason, anywhere in the cause chain. */
function launchUnresolvedCause(error: unknown): (RuntimeExecutableNotFoundError & { reason: string }) | null {
  for (let current = error, depth = 0; current && depth < 5; current = (current as { cause?: unknown }).cause, depth += 1) {
    if (current instanceof RuntimeExecutableNotFoundError && current.reason) {
      return current as RuntimeExecutableNotFoundError & { reason: string };
    }
  }
  return null;
}

export class RuntimeSessionStartError extends Error {
  readonly spawnFailureCode: SpawnFailureReason | null;

  constructor(message: string, cause: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RuntimeSessionStartError";
    this.spawnFailureCode = spawnFailureCodeOf(cause);
  }
}

export class RunnerCredentialMintError extends Error {
  /** task #1120: stable launch-failure class; `code` below is the mint-specific code. */
  readonly spawnFailureCode = "runner_credential_mint_failed" as const;
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, opts: { code: string; retryable?: boolean; status?: number }) {
    super(message);
    this.name = "RunnerCredentialMintError";
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
  }
}

function isRetryableMintHttpFailure(status: number, code: string | null): boolean {
  if (code === "experimental_surface_disabled") return false;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function runnerCredentialErrorDetail(error: unknown): { message: string; code: string; retryable: boolean; status?: number } {
  if (error instanceof RunnerCredentialMintError) {
    return {
      message: error.message,
      code: error.code,
      retryable: error.retryable,
      status: error.status,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    message,
    code: "runner_credential_mint_network_error",
    retryable: true,
  };
}

async function waitForRunnerCredentialRetry(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, RUNNER_CREDENTIAL_MINT_RETRY_DELAY_MS));
}

function probeSubprocessOsState(pid: number | undefined): string {
  if (typeof pid !== "number") return "unknown";
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^State:\s+(\S)/m);
    if (match) {
      const code = match[1];
      if (code === "R") return "running";
      if (code === "S") return "sleeping";
      if (code === "D") return "uninterruptible_sleep";
      if (code === "Z") return "zombie";
      if (code === "T" || code === "t") return "stopped";
    }
    return "unknown";
  } catch {
    return "gone";
  }
}

function bucketMs(ms: number): string {
  if (ms < 1_000) return "<1s";
  if (ms < 10_000) return "1-10s";
  if (ms < 60_000) return "10-60s";
  if (ms < 300_000) return "1-5m";
  if (ms < 900_000) return "5-15m";
  if (ms < 3_600_000) return "15-60m";
  return ">60m";
}

function stalledRecoverySigtermTimeoutMs(): number {
  return readNonNegativeIntegerEnv(
    "SLOCK_DAEMON_STALLED_RECOVERY_SIGTERM_TIMEOUT_MS",
    DEFAULT_STALLED_RECOVERY_SIGTERM_TIMEOUT_MS,
  );
}

function runtimeStartTimeoutMs(): number {
  return readNonNegativeIntegerEnv(
    "SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS",
    DEFAULT_RUNTIME_START_TIMEOUT_MS,
  );
}

const SESSION_TRANSCRIPT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * One feedback/diagnostic transcript lookup. `transcriptContent` is decided
 * HERE, where the bytes are produced: only native_* results ever carry
 * `transcript` bytes; a daemon placeholder never does.
 */
export interface SessionTranscriptLookup {
  runtime: string;
  sessionId: string;
  reachable: boolean;
  path: string | null;
  /** Legacy free text for older servers; `reasonCode` is the typed form. */
  fallbackReason?: string;
  transcript: string | null;
  sizeBytes: number;
  truncated: boolean;
  truncationDirection?: "head" | "tail" | "window";
  redacted: boolean;
  tier: string;
  transcriptContent: FeedbackTranscriptContentKind;
  reasonCode?: FeedbackTranscriptLookupReason;
  lookupMethod: FeedbackTranscriptLookupMethod | null;
  /** LOCAL diagnostic only (home folded to `~`, bounded); never in the feedback frame or outcome. */
  searchedPaths: string[];
  /** Only for no_config_in_memory: whether `<dataDir>/<agentId>` exists locally. */
  workspaceDirPresent?: boolean;
  /** Size of the source file on disk at read time (when one was read). */
  sourceBytes?: number;
  /** Uncompressed bytes kept (after windowing/redaction); == sizeBytes. */
  transcriptBytes: number;
}

/**
 * Bounds of the searched paths kept in the LOCAL session-transcript lookup
 * diagnostic. Local only: neither the feedback result frame nor the uploaded
 * transcript_outcome carries them.
 */
const TRANSCRIPT_LOOKUP_SEARCHED_PATHS_MAX = 4;
const TRANSCRIPT_LOOKUP_SEARCHED_PATH_MAX_CHARS = 160;

function runtimeTier(runtime: string): string {
  const tier1 = new Set(["claude", "codex", "grok", "kimi-sdk", "kimi", "pi"]);
  if (tier1.has(runtime)) return "tier1";
  return "tier2_or_fallback";
}

export { resolveRuntimeSessionRef };
export type { ResolveRuntimeSessionRefOptions };
export { classifySpawnFailure } from "./spawnFailureClassification";
import { RuntimeExecutableNotFoundError, spawnFailureCodeOf, type SpawnFailureReason } from "./spawnFailureErrors";
export type { SpawnFailureClassification, SpawnFailureReason } from "./spawnFailureClassification";

/** Max chars for thinking/text content in trajectory entries (sent over WebSocket) */
const MAX_TRAJECTORY_TEXT = 2000;
const TRAJECTORY_COALESCE_MS = 350;

/** Interval (ms) at which the daemon re-sends the current activity to prevent server-side stale timeout */
const ACTIVITY_HEARTBEAT_MS = 60_000;
const STDIN_NOTIFICATION_INITIAL_DELAY_MS = 3_000;
const STDIN_NOTIFICATION_RETRY_DELAY_MS = 15_000;
const SESSION_READY_DELIVERY_RETRY_DELAY_MS = 15_000;
const RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS = 10_000;
const RUNTIME_ERROR_DELIVERY_BACKOFF_MAX_MS = 5 * 60_000;
const RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD = 3;
/** RFC 071: accepted launches waiting for a final result, per agent (candidate bound). */
const ACCEPTED_LAUNCHES_PER_AGENT_MAX = 32;

// SPAWN-FAIL BACKOFF (界③ narrow): when auto_restart_from_idle / runtime_profile_auto_restart
// fail (startAgent throws — e.g. credential mint failure, runtime spawn error), the current
// behavior restores idleAgentConfigs and returns false; the NEXT message arrival walks the
// same path and triggers another failing startAgent. This is the per-agent token-burn-on-
// spawn-failure loop tygg's deep-think surfaced (#proj-o11y:9bf7d748): repeated spawn cost
// without backoff. Apply a per-agent cooldown after the first outer spawn failure (matches
// the runtime-error-delivery backoff pattern but anchored at spawn-fail) so a broken spawn
// path cannot burn one full spawn attempt per wake message.
const SPAWN_FAIL_BACKOFF_BASE_MS = 1_000;
const SPAWN_FAIL_BACKOFF_MAX_MS = 30_000;
const SPAWN_FAIL_BACKOFF_THRESHOLD = 0;
// Runner credential mint has its own inner retry loop. Once that loop is
// exhausted, do not require three more wake cycles before suppressing retry.
const RUNNER_CREDENTIAL_MINT_BACKOFF_BASE_MS = 60_000;
const RUNNER_CREDENTIAL_MINT_BACKOFF_MAX_MS = 10 * 60_000;
const RUNNER_CREDENTIAL_MINT_BACKOFF_THRESHOLD = 0;
/** Compaction should normally finish quickly; surface missing finish events explicitly. */
const COMPACTION_STALE_MS = 5 * 60_000;
/** Review mode should normally finish within a turn; surface missing finish events explicitly. */
const REVIEW_STALE_MS = 10 * 60_000;
/** Surface silent runtime stalls instead of letting activity heartbeats mask them indefinitely. */
const RUNTIME_PROGRESS_STALE_MS = 15 * 60_000;
/** Startup should either emit a runtime event or fail visibly; do not leave users on Starting forever. */
const DEFAULT_RUNTIME_START_TIMEOUT_MS = 2 * 60_000;
/** If stale recovery has already decided to terminate a process, surface and unblock SIGTERM hangs. */
const DEFAULT_STALLED_RECOVERY_SIGTERM_TIMEOUT_MS = 10_000;
const ONBOARDING_MEMORY_SEED_ENV = "SLOCK_ONBOARDING_MEMORY_SEED";
const FIRST_CINDY_SEED_MODE = "first-cindy";

function getOnboardingSeedMode(config: AgentConfig): string {
  return (config.envVars?.[ONBOARDING_MEMORY_SEED_ENV] || "").trim().toLowerCase();
}

function withLocalRuntimeContext(config: AgentConfig, agentId: string, workspacePath: string): AgentConfig {
  return {
    ...config,
    runtimeContext: {
      ...(config.runtimeContext ?? {}),
      agentId: config.runtimeContext?.agentId ?? agentId,
      workspacePath,
    },
  };
}

function buildInitialMemoryMd(config: AgentConfig): string {
  const agentName = config.displayName || config.name;
  const seedMode = getOnboardingSeedMode(config);
  if (seedMode !== FIRST_CINDY_SEED_MODE) {
    return `# ${agentName}\n\n## Role\n${config.description || "No role defined yet."}\n\n## Key Knowledge\n- No notes yet.\n\n## Active Context\n- First startup.\n`;
  }

  return buildCindyMemoryMd(agentName);
}

type AgentProcessTimer = ReturnType<typeof setTimeout>;

export type AgentProcessStartupContext = {
  wakeMessage: AgentMessage | undefined;
  unreadSummary: Record<string, number> | undefined;
  resumePrompt: string | undefined;
};

export type AgentProcessStartupState =
  | (AgentProcessStartupContext & { kind: "waiting"; timer: AgentProcessTimer | null })
  | (AgentProcessStartupContext & { kind: "ready" });

export type AgentProcessActivationState =
  | { kind: "idle" }
  | { kind: "open"; transition: LaunchActivationTransitionState }
  | { kind: "delivered" }
  | { kind: "closed" };

export type AgentProcessCompactionState =
  | { kind: "none" }
  | { kind: "active"; startedAt: number; watchdog: AgentProcessTimer | null };

export type AgentProcessReviewState =
  | { kind: "none" }
  | { kind: "active"; startedAt: number; watchdog: AgentProcessTimer | null };

export type AgentProcessExitState =
  | { kind: "live"; stalledRecoverySigtermTimer: AgentProcessTimer | null }
  | { kind: "exited"; code: number | null; signal: NodeJS.Signals | null };

export type PendingTrajectoryState = {
  kind: "thinking" | "text";
  text: string;
  timer: AgentProcessTimer;
  // APM 1.6 6b: closed subagent lineage for coalesced thinking/text rows. Only
  // present when the source row carried explicit lineage; never inferred.
  subagent?: SubagentLineage["subagent"];
};

function createAgentProcessStartupState(context: AgentProcessStartupContext): AgentProcessStartupState {
  return { kind: "waiting", timer: null, ...context };
}

function agentProcessStartupContext(startup: AgentProcessStartupState): AgentProcessStartupContext {
  return {
    wakeMessage: startup.wakeMessage,
    unreadSummary: startup.unreadSummary,
    resumePrompt: startup.resumePrompt,
  };
}

function agentProcessStartupReady(startup: AgentProcessStartupState): AgentProcessStartupState {
  return { kind: "ready", ...agentProcessStartupContext(startup) };
}

interface AgentProcess {
  providerRequest?: import("@botiverse/raft-shared").ProviderRequestActivity;
  runtime: RuntimeSession;
  driver: RuntimeDriver;
  inbox: AgentMessage[];
  config: AgentConfig;
  sessionId: string | null;
  sessionReadyForDelivery: boolean;
  launchId: string | null;
  startDispatchId: string | null;
  startup: AgentProcessStartupState;
  notifications: RuntimeNotificationState;
  /** Timer that periodically re-sends transient activity (working/thinking) to prevent server stale timeout */
  activityHeartbeat: ActivityHeartbeatTimerState;
  /**
   * Open phase-5 runtime-readiness exported-row transition (task #149). Set on
   * fence arm, cleared when the readiness wait closes (advanced / timeout /
   * terminal). Non-null = the readiness wait row is open and awaiting its
   * exactly-one close.
   */
  readinessTransition: LaunchReadinessTransitionState | null;
  activation: AgentProcessActivationState;
  compaction: AgentProcessCompactionState;
  /**
   * RFC 072 §7.2: this spawn's CLI transport directory (the same path
   * `prepareCliTransport` creates and injects as SLOCK_CLI_TRANSPORT_DIR),
   * where a new context id is written at every `compaction_started`.
   */
  cliTransportDir: string;
  /**
   * The passive AX gate this process was spawned with (task #359), taken from
   * the spawn config so compaction writes publish the same value; `config` is
   * the live config and need not carry the composed gate.
   */
  passiveAx: boolean;
  review: AgentProcessReviewState;
  runtimeProgress: RuntimeProgressState;
  /** task #1114: stdin writes since the last runtime consumption signal (observation only). */
  deliveryConsumption: DeliveryConsumptionWatch;
  runtimeTraceSpan: ActiveSpan | null;
  runtimeTraceCounters: RuntimeTraceCounters;
  /** RFC 071 §4.4: model output and runtime errors since the previous turn end (E2 evidence). */
  turnOutcome: TurnOutcomeCounters;
  /**
   * RFC 071 §6: the catch-up batch this process's first turn rendered as
   * input (`resumeCatchupDeliveredAsInput`), echoed on that turn's clean
   * `turn_completed` only. Cleared at the first turn end whatever its
   * outcome, so a batch is echoed at most once.
   */
  catchupBatchEcho: { launchId: string; batchId: string; renderedRows: number } | null;
  /** RFC 071: `agent:process_spawned` was sent for this process (at most once). */
  spawnReported: boolean;
  runtimeTelemetryResultSeq: number;
  lastActivityKind: AgentActivityKind;
  lastActivity: string;
  lastActivityDetail: string;
  lastActivityDetailKind: AgentActivityDetailKind;
  recentStdout: string[];
  recentStderr: string[];
  lastRuntimeError: string | null;
  /**
   * Decision-only view of error signals, bounded by runtime liveness. Recovery /
   * RESTART classifiers read through this window so a stale error from a turn
   * the process has since moved past cannot restart a recovered agent.
   * `recentStderr` / `lastRuntimeError` stay full for diagnostics, user-facing
   * reporting, and sticky terminal-failure gating (auth / model-not-supported).
   */
  decisionErrorWindow: DecisionErrorWindow;
  runtimeErrorDeliveryBackoff: RuntimeErrorDeliveryBackoffState;
  sessionReadyDeliveryRetry: SessionReadyDeliveryRetryState;
  spawnError: string | null;
  processInstanceId: string;
  spawnedAtMs: number;
  exit: AgentProcessExitState;
  runtimeProfileTurnControl: RuntimeProfileTurnControl | null;
  pendingTrajectory: PendingTrajectoryState | null;
  /**
   * Seq'd messages whose bodies this daemon put in front of the model (startup
   * catch-up, wake with thread context, full-body stdin), reported as
   * `agent:model-seen` on the first model-driven event of this process after
   * the input. Dropped with the process if it ends first: the next start's
   * catch-up sends them again (a duplicate rather than a loss).
   */
  pendingModelSeen?: AgentMessage[];
  gatedSteering: ApmGatedSteeringDecisionState;
}

export type ActivityHeartbeatTimerState =
  | { kind: "inactive" }
  | { kind: "active"; timer: ReturnType<typeof setInterval> };

export type RuntimeErrorDeliveryBackoffState =
  | { kind: "idle"; attempts: 0; untilMs: 0; timer: null; reason: null }
  | { kind: "backing_off"; attempts: number; untilMs: number; timer: ReturnType<typeof setTimeout> | null; reason: string };

interface RuntimeErrorFingerprintFenceState {
  fingerprint: string;
  attempts: number;
  lastRuntimeError: string;
  detail: string;
  launchId: string | null;
}

interface RuntimeErrorDeliveryFailure {
  detail: string;
  actionRequired: boolean;
  entries?: TrajectoryEntry[];
}

interface RuntimeErrorDeliveryBackoffFailPoint {
  terminalFailure?: RuntimeErrorDeliveryFailure | null;
  stickyTerminalFailure?: RuntimeErrorDeliveryFailure | null;
  reason?: string | null;
}

function createRuntimeErrorDeliveryBackoffState(): RuntimeErrorDeliveryBackoffState {
  return {
    kind: "idle",
    attempts: 0,
    untilMs: 0,
    timer: null,
    reason: null,
  };
}

function stripManagedRunnerCredential(config: AgentConfig): AgentConfig {
  const { agentCredentialKey: _agentCredentialKey, agentCredentialId: _agentCredentialId, ...rest } = config;
  return rest;
}

type RuntimeProfileControlSource = "agent_config" | "message";

interface RuntimeProfileTurnControl {
  kind: RuntimeProfileControlKind;
  source: RuntimeProfileControlSource;
  keyHash: string | null;
  keyPresent: boolean;
  injectedAtMs: number;
}

function createGatedSteeringState(): ApmGatedSteeringDecisionState {
  return createInitialApmGatedSteeringState();
}

export interface AgentRuntimeProfileWireReport {
  agentId: string;
  facts: AgentRuntimeProfileReport;
  launchId: string | null;
}


function runtimeProfileNotificationTitle(kind: RuntimeProfileControlKind): string {
  return kind === "migration" ? "Runtime Profile reset" : "Runtime Profile notice";
}

function hashRuntimeProfileKey(key: string | null | undefined): string | undefined {
  if (!key) return undefined;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function runtimeProfileTurnControl(
  kind: RuntimeProfileControlKind,
  key: string | null | undefined,
  source: RuntimeProfileControlSource,
): RuntimeProfileTurnControl {
  return {
    kind,
    source,
    keyHash: hashRuntimeProfileKey(key) ?? null,
    keyPresent: Boolean(key),
    injectedAtMs: Date.now(),
  };
}

function formatCrashReason(code: number | null, signal: NodeJS.Signals | null, ap: AgentProcess): string {
  const parts: string[] = [];

  if (signal) {
    parts.push(`signal ${signal}`);
  } else if (typeof code === "number") {
    parts.push(`exit code ${code}`);
  } else {
    parts.push("unknown exit");
  }

  if (ap.spawnError) {
    parts.push(`spawn error: ${ap.spawnError}`);
  }
  if (ap.lastRuntimeError) {
    parts.push(`runtime error: ${ap.lastRuntimeError}`);
  }
  if (ap.recentStderr.length > 0) {
    parts.push(`stderr: ${ap.recentStderr.join(" | ")}`);
  }
  if (!ap.lastRuntimeError && ap.recentStdout.length > 0) {
    parts.push(`stdout: ${ap.recentStdout.join(" | ")}`);
  }

  return parts.join(" | ");
}

function summarizeCrash(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `signal ${signal}`;
  if (typeof code === "number") return `exit code ${code}`;
  return "unknown exit";
}

function closeSatisfiedTurnBoundary(ap: AgentProcess, expectedTermination: boolean): boolean {
  if (expectedTermination) return true;
  if (ap.runtime.descriptor.turnBoundary === "process_exit") return true;
  return !ap.runtimeTraceSpan;
}

type StartupRequestErrorEvent = Extract<ParsedEvent, { kind: "error" }> & {
  startupRequestMethod: NonNullable<Extract<ParsedEvent, { kind: "error" }>["startupRequestMethod"]>;
};

function isStartupRequestErrorEvent(event: ParsedEvent): event is StartupRequestErrorEvent {
  return event.kind === "error" && !!event.startupRequestMethod;
}

function runtimeDiagnosticTitle(event: RuntimeDiagnosticEvent): string {
  switch (event.itemType) {
    case "configWarning":
      return "Codex config warning";
    case "guardianWarning":
      return "Codex guardian warning";
    case "deprecationNotice":
      return "Codex deprecation notice";
    default:
      return event.source === "grok_acp_notification" ? "Grok Build warning" : "Codex warning";
  }
}

function summarizeDiagnosticRange(range: unknown): string | null {
  if (range === undefined || range === null) return null;
  try {
    const json = JSON.stringify(range);
    if (!json) return null;
    return json.length <= 300 ? json : `${json.slice(0, 299)}…`;
  } catch {
    return null;
  }
}

function runtimeDiagnosticTrajectoryEntry(event: RuntimeDiagnosticEvent): TrajectoryEntry {
  const lines = [event.message];
  if (event.details && event.details !== event.message) {
    lines.push(event.details);
  }
  if (event.path) {
    lines.push(`Path: ${event.path}`);
  }
  const range = summarizeDiagnosticRange(event.range);
  if (range) {
    lines.push(`Range: ${range}`);
  }
  return {
    kind: "system",
    title: runtimeDiagnosticTitle(event),
    text: lines.join("\n"),
  };
}

function runtimeRecoveryTrajectoryEntry(event: RuntimeRecoveryEvent): TrajectoryEntry {
  const lines = [event.message];
  if (event.details && event.details !== event.message) {
    lines.push(event.details);
  }
  return {
    kind: "system",
    title: event.source === "grok_resume_missing_session"
      ? "Grok resume recovery"
      : "Codex resume recovery",
    text: lines.join("\n"),
  };
}

type SubagentProgressEvent = Extract<ParsedEvent, { kind: "subagent_progress" }>;

/**
 * Human-readable, BOUNDED detail line for a subagent lifecycle signal (APM 1.6
 * 6b). Built only from closed lifecycle tokens (phase + subagent role) — never
 * from raw prompt or output.
 */
function subagentProgressDetail(event: SubagentProgressEvent): string {
  const role = event.subagentType ? ` (${event.subagentType})` : "";
  switch (event.phase) {
    case "started":
      return `Subagent started${role}`;
    case "progress":
      return `Subagent working${role}`;
    case "notification":
      return `Subagent update${role}`;
    default:
      return `Subagent working${role}`;
  }
}

/**
 * Closed subagent lineage marker for a `system` task-lifecycle signal. Only ids
 * + bounded phase/role — never inferred from text, no raw content. (APM 1.6 6b)
 */
function subagentLineageFromEvent(event: SubagentProgressEvent): SubagentLineage["subagent"] {
  return {
    ...(event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
    ...(event.subagentType ? { subagentType: event.subagentType } : {}),
    ...(event.taskId ? { taskId: event.taskId } : {}),
    phase: event.phase,
  };
}

/** Closed-attr trace payload for a subagent lifecycle signal (Q8: ids as presence flags). */
function subagentProgressTraceAttrs(event: SubagentProgressEvent): Record<string, unknown> {
  return {
    kind: event.kind,
    source: event.source,
    phase: event.phase,
    parent_tool_use_id_present: Boolean(event.parentToolUseId),
    subagent_type_present: Boolean(event.subagentType),
    task_id_present: Boolean(event.taskId),
    last_tool_name_present: Boolean(event.lastToolName),
    payloadBytes: event.payloadBytes,
  };
}

type RuntimeDeliveryErrorEvent = Extract<ParsedEvent, { kind: "delivery_error" }>;

/**
 * Error signals a recovery/RESTART classifier may act on, bounded by runtime
 * liveness. Reads the decision-only view (cleared on the last runtime-progress
 * event), so an error from a turn the process has since moved past does not
 * restart or re-route a recovered agent. Error-class agnostic.
 *
 * Scope: this is for decisions that PROGRESS should invalidate (e.g.
 * stalled-recovery restart, session-resume). Terminal-failure GATING
 * (`classifyTerminalFailure`: auth / model-not-supported) is intentionally NOT
 * bounded here — those are sticky until an explicit user-turn recovery, not a
 * progress event — so it keeps reading the full history.
 */
function currentErrorCandidates(ap: AgentProcess): string[] {
  return ap.decisionErrorWindow.currentErrorCandidates();
}

function classifyTerminalFailure(ap: AgentProcess): RuntimeErrorDeliveryFailure | null {
  // Terminal-failure gating reads the FULL error history, not the progress-bounded
  // decision view: auth / model-not-supported sticky failures are recovered by an
  // explicit user-turn (the B.5 path), not by runtime progress, so they must stay
  // detectable across progress events.
  const candidates = [
    ap.lastRuntimeError,
    ...ap.recentStderr,
  ].filter((value): value is string => !!value);

  for (const text of candidates) {
    const diagnostics = buildRuntimeErrorDiagnosticEnvelope(text);
    const lower = text.toLowerCase();
    const inputTooLarge = diagnostics.spanAttrs.runtime_error_class === "InputTooLargeError";
    const billingExhausted = diagnostics.spanAttrs.runtime_error_class === "BillingError";
    if (
      billingExhausted ||
      lower.includes("usage limit") ||
      lower.includes("quota exceeded") ||
      lower.includes("quota limit") ||
      lower.includes("budget limit exceeded") ||
      lower.includes("usage not included in your plan") ||
      lower.includes("modelnotfounderror") ||
      lower.includes("requested entity was not found") ||
      lower.includes("model deprecated") ||
      lower.includes("model not found") ||
      lower.includes("model is not supported") ||
      lower.includes("unsupported model") ||
      lower.includes("codex_zero_evidence_turn_completed") ||
      /\bmodel\b.*\bnot supported\b/i.test(text) ||
      diagnostics.spanAttrs.runtime_error_action_required === true ||
      (inputTooLarge && ap.driver.id !== "claude") ||
      isProviderStreamFailureText(text) ||
      isRuntimeStartTimeoutText(text)
    ) {
      const actionRequired = diagnostics.spanAttrs.runtime_error_action_required === true;
      return {
        detail: actionRequired
          ? formatRuntimeActionRequiredMessage(ap, text)
          : billingExhausted
            ? formatRuntimeBillingExhaustedMessage(ap.driver.id)
          : inputTooLarge
            ? formatRuntimeInputTooLargeMessage(ap.driver.id)
            : text,
        actionRequired,
        ...(actionRequired ? { entries: buildRuntimeActionRequiredEntries(ap, text, diagnostics) } : {}),
      };
    }
  }

  return null;
}

function classifyStickyTerminalFailure(ap: AgentProcess): RuntimeErrorDeliveryFailure | null {
  const terminalFailure = classifyTerminalFailure(ap);
  if (!terminalFailure) return null;
  if (terminalFailure.actionRequired) return terminalFailure;
  if (terminalFailure.detail === formatRuntimeInputTooLargeMessage(ap.driver.id)) return terminalFailure;
  if (terminalFailure.detail === formatRuntimeBillingExhaustedMessage(ap.driver.id)) return terminalFailure;
  if (/\bcodex_zero_evidence_turn_completed\b/i.test(terminalFailure.detail)) return terminalFailure;
  if (/\b(?:model\b.*\bnot supported|unsupported\b.*\bmodel)\b/i.test(terminalFailure.detail)) return terminalFailure;
  if (isProviderStreamFailureText(terminalFailure.detail)) return null;
  if (isRuntimeStartTimeoutText(terminalFailure.detail)) return null;
  return null;
}

function formatRuntimeActionRequiredMessage(ap: AgentProcess, sourceText?: string | null): string {
  // task #352 — plan-without-model is action-required but is not a login
  // problem; it needs its own copy so the user changes the model or plan.
  if (isRuntimePlanAccessErrorText(sourceText ?? ap.lastRuntimeError ?? "")) {
    return formatRuntimePlanAccessMessage(ap.driver.id, ap.config.model);
  }
  if (ap.driver.id === "claude" && isClaudeCustomProviderConfig(ap.config)) {
    return "Claude Code custom provider authentication failed. Check this agent's custom Claude provider API key/API URL, then retry starting this agent.";
  }
  return formatRuntimeLoginRequiredMessage(ap.driver.id);
}

function buildRuntimeActionRequiredEntries(
  ap: AgentProcess,
  text: string,
  diagnostics: ReturnType<typeof buildRuntimeErrorDiagnosticEnvelope>,
): TrajectoryEntry[] {
  const excerpt = String(diagnostics.eventAttrs.runtime_error_message_excerpt ?? "").trim();
  const subtype = classifyRuntimeActionRequiredSubtype(ap, text);
  const detail = formatRuntimeActionRequiredMessage(ap, text);
  const diagnosticLabel = subtype === "provider_plan_access_error" ? "Runtime model-access diagnostic" : "Runtime auth diagnostic";
  const entries: TrajectoryEntry[] = [
    { kind: "text", text: `Error: ${detail}` },
    { kind: "text", text: `${diagnosticLabel}: ${subtype}` },
  ];
  if (excerpt) {
    entries.push({ kind: "text", text: `Raw error excerpt (redacted): ${excerpt}` });
  }
  if (ap.driver.id === "claude") {
    entries.push({
      kind: "text",
      text: isClaudeCustomProviderConfig(ap.config)
        ? "Claude auth mode: custom provider. Local Claude Code login does not fix this branch; check this agent's provider API key/API URL."
        : "Claude auth mode: default host login. If Terminal works, set this agent's Claude command to the absolute path from `which claude` and restart Raft Computer.",
    });
  }
  return entries;
}

function classifyRuntimeActionRequiredSubtype(ap: AgentProcess, text: string): string {
  if (isRuntimePlanAccessErrorText(text)) return "provider_plan_access_error";
  const lower = text.toLowerCase();
  const customClaudeProvider = ap.driver.id === "claude" && isClaudeCustomProviderConfig(ap.config);
  if (customClaudeProvider) {
    if (/\bmissing\b.*\b(?:api\s*)?key\b|\b(?:api\s*)?key\b.*\bnot set\b|\bmissing\b.*\btoken\b|\bno\b.*\btoken\b/i.test(text)) {
      return "custom_provider_missing_key";
    }
    if (/\binvalid\b.*\b(?:api\s*)?key\b|\bunauthorized\b|\b401\b|\b403\b|auth(?:entication)? failed/i.test(text)) {
      return "custom_provider_invalid_key";
    }
    return "custom_provider_auth_error";
  }
  if (ap.driver.id === "claude") {
    if (lower.includes("not logged in") || lower.includes("not signed in") || lower.includes("please log in") || lower.includes("login required")) {
      return "host_claude_login_required";
    }
    return "runtime_auth_error";
  }
  if (ap.driver.id === "builtin") return "builtin_provider_auth_error";
  return "runtime_auth_error";
}

/**
 * Per-line predicate for AUTH-CLASS action-required diagnostics (token / login /
 * credential / invalid-key). These are the sticky terminal failures that a
 * user-driven turn CAN recover from — a restored account makes the same retry
 * succeed — so they are cleared on the B.5 recovery path. Used to clear ONLY
 * those entries; quota / usage-limit (non-sticky, auto-recovers),
 * model-not-supported (needs explicit reconfiguration, stays gated),
 * provider-stream, runtime-start-timeout and other diagnostic/telemetry lines
 * are intentionally preserved — clear scope = exactly un-stick, no over-clear.
 */
function isAuthClassTerminalLine(text: string): boolean {
  return buildRuntimeErrorDiagnosticEnvelope(text).spanAttrs.runtime_error_action_required === true;
}

/** Close paths that leave unconsumed deliveries to the Server's unread
 * catch-up on purpose (task #353). */
const EXPECTED_SERVER_CARRIED_EXIT_PATHS = new Set(["explicit_stop", "silent_stop", "cold_idle_recycle", "clean_exit_deferred"]);

function isProviderStreamFailureText(text: string): boolean {
  return /stream closed before response\.completed|error decoding response body/i.test(text);
}

function isRuntimeStartTimeoutText(text: string): boolean {
  return /did not finish starting on this machine/i.test(text);
}

function isCodexProviderReconnectLog(text: string): boolean {
  return /Reconnecting\.\.\.\s*\d+\s*\/\s*\d+/i.test(text);
}

/**
 * task #1127 — English fallback shown when the web has no catalog copy for
 * `model_tool_args_invalid` (older web, or a surface that renders the daemon
 * detail directly). The web substitutes its own en/zh string by reason.
 */
const CODEX_TOOL_ARGUMENT_PARSE_USER_MESSAGE =
  "The model produced tool-call arguments Codex could not parse, so the tool call was rejected — try a different model";

function isCodexBenignTransportLog(text: string): boolean {
  return /Falling back from WebSockets/i.test(text);
}

function isStdinClassRecoveryLine(text: string): boolean {
  return /write_stdin failed|stdin is closed|closed for this session|session.*closed/i.test(text);
}

function hasDirectStdinRecoveryEvidence(ap: AgentProcess): boolean {
  const candidates = currentErrorCandidates(ap);

  return candidates.some((text) => isStdinClassRecoveryLine(text));
}

function resumeSessionRecoveryReason(ap: AgentProcess): "missing" | "provider_replay_rejected" | null {
  if (!ap.sessionId) return null;
  const candidates = currentErrorCandidates(ap);

  if (ap.driver.id === "claude") {
    return candidates.some((text) => /No conversation found with session ID/i.test(text)) ? "missing" : null;
  }

  if (ap.driver.id === "opencode") {
    if (candidates.some((text) => /Session not found/i.test(text) && text.includes(ap.sessionId!))) return "missing";
    if (candidates.some(isOpenCodeReplayRejectedByProvider)) return "provider_replay_rejected";
    return null;
  }

  if (ap.driver.id === "pi") {
    return candidates.some(isPiReplayRejectedByProvider) ? "provider_replay_rejected" : null;
  }

  if (ap.driver.id === "gemini") {
    return candidates.some((text) =>
      /Error resuming session:\s*Invalid session identifier/i.test(text) &&
      text.includes(ap.sessionId!),
    ) ? "missing" : null;
  }

  return null;
}

function isOpenCodeReplayRejectedByProvider(text: string): boolean {
  // Keep this exact: generic "Provider returned error" can be any upstream failure,
  // but this schema rejection means the stored replay transcript is unusable for the provider.
  return /Invalid request:\s*the message at position \d+ with role ['"]?assistant['"]? must not be empty/i.test(text);
}

function isPiReplayRejectedByProvider(text: string): boolean {
  return /Cannot continue from message role:\s*assistant/i.test(text);
}

function buildRuntimeStallDiagnostic(ap: AgentProcess, staleForMs: number, staleForMinutes: number) {
  return projectApmRuntimeStallDiagnostic({
    staleForMs,
    staleForMinutes,
    lastActivityKind: ap.lastActivityKind,
    lastActivity: ap.lastActivity,
    lastActivityDetail: ap.lastActivityDetail,
    lastActivityDetailKind: ap.lastActivityDetailKind,
    runtimeProgressLastEventKind: ap.runtimeProgress.lastEventKind,
    runtime: ap.config.runtime,
    model: ap.config.model,
    platform: process.platform,
    arch: process.arch,
    launchId: ap.launchId,
    sessionIdPresent: Boolean(ap.sessionId),
    inboxCount: ap.inbox.length,
    pendingNotificationCount: ap.notifications.pendingCount,
    processPidPresent: typeof ap.runtime.pid === "number",
    driverBusyDeliveryMode: ap.driver.busyDeliveryMode,
    supportsStdinNotification: ap.driver.supportsStdinNotification,
    outstandingToolUses: ap.gatedSteering.outstandingToolUses,
    compacting: ap.gatedSteering.compacting,
    reviewing: ap.gatedSteering.reviewing === true ? true : undefined,
    recentStderrCount: ap.recentStderr.length,
    recentStdoutCount: ap.recentStdout.length,
    runtimeTraceCounterAttrs: runtimeTraceCounterAttrs(ap),
  });
}

function messageProducerFactTraceAttrs(messages?: AgentMessage[]): Record<string, unknown> {
  if (!messages || messages.length === 0) return {};
  const producerFactIds = new Set<string>();
  for (const message of messages) {
    const producerFactId = typeof message.producerFactId === "string" ? message.producerFactId.trim() : "";
    if (producerFactId) producerFactIds.add(producerFactId);
  }
  if (producerFactIds.size === 0) return {};
  return {
    message_producer_fact_count: producerFactIds.size,
    ...(producerFactIds.size === 1 ? { message_producer_fact_id: [...producerFactIds][0] } : {}),
  };
}

function buildRuntimeInputTraceAttrs(opts: {
  source: string;
  prompt: string;
  standingPrompt?: string;
  resumePrompt?: string;
  messages?: AgentMessage[];
  unreadSummary?: Record<string, number>;
  sessionIdPresent: boolean;
  nativeStandingPrompt: boolean;
}): Record<string, unknown> {
  return {
    runtime_input_source: opts.source,
    runtime_input_prompt_bytes_bucket: bucketBytes(opts.prompt),
    runtime_input_standing_prompt_bytes_bucket: bucketBytes(opts.standingPrompt),
    runtime_input_resume_prompt_present: Boolean(opts.resumePrompt),
    runtime_input_resume_prompt_bytes_bucket: bucketBytes(opts.resumePrompt),
    runtime_input_session_present: opts.sessionIdPresent,
    runtime_input_native_standing_prompt_present: opts.nativeStandingPrompt,
    runtime_input_unread_channels_count: opts.unreadSummary ? Object.keys(opts.unreadSummary).length : 0,
    ...attentionHintInputTraceAttrs(opts.messages),
    ...summarizeMessageInputBytes(opts.messages),
  };
}

function attentionHintInputTraceAttrs(messages?: AgentMessage[]): Record<string, unknown> {
  const hints = messages
    ?.map((message) => message.attention_hint)
    .filter((hint): hint is AttentionHint => Boolean(hint)) ?? [];
  if (hints.length === 0) return {};
  const triggers = [...new Set(hints.map((hint) => hint.trigger))].join(",");
  return {
    runtime_input_attention_hint_count: hints.length,
    runtime_input_attention_hint_triggers: triggers,
  };
}

interface DeliveryTraceContext {
  deliveryId?: string;
  transient?: boolean;
  mentionDelivery?: MentionDeliveryIdentitySnapshot;
  onMentionTransition?: (stage: MentionDeliveryTransitionStage, outcome: "accepted" | "coalesced") => void;
  onMentionTerminalError?: (code: MentionDeliveryTerminalErrorCode) => void;
  onMentionAck?: () => void;
  /** No process and no cached idle/restart config: the Server must wake with config (task #1113). */
  onRejectedNoProcess?: () => void;
}

interface TrackedMentionDelivery {
  agentId: string;
  messageId: string;
  /** The delivered row, kept so turn-end settlement can ask whether the runtime consumed it. */
  message: AgentMessage;
  state: "received" | "pending" | "drained";
  context: DeliveryTraceContext;
  /** task #9: the process whose first input named this message (a restart for it). */
  toldProcessInstanceId?: string;
}

interface PendingServerWake {
  wakeRequestId: string;
  itemId: string;
  appId: string;
  sourceRef: { kind: string; id: string; revision?: string };
  pendingAppItems: number;
  requestedAtMs: number;
  // Captured when the wake is first parked, so an offline resend still joins
  // the trace of the flow that created it.
  traceparent?: string;
}

/**
 * Deterministic per (agent, inbox item): a duplicate fire, a resend after
 * reconnect, or a re-fire after a daemon restart all carry the same id, so the
 * Server can replay its outcome instead of dispatching twice.
 */
function appInboxNoticeText(pendingAppItems: number): string {
  return `[Raft Inbox notice:\nApp items pending: ${pendingAppItems}\nRun \`raft inbox check\` to inspect them.]`;
}

function serverWakeRequestId(agentId: string, itemId: string): string {
  return createHash("sha256").update(`${agentId}\n${itemId}`).digest("hex").slice(0, 32);
}

export class AgentProcessManager {
  private agents = new Map<string, AgentProcess>();
  private readonly lifecycleRecords = new AgentLifecycleRecords<RuntimeErrorDeliveryBackoffState, RuntimeErrorFingerprintFenceState>();

  /**
   * Where activity facts go (RFC 069 §7). The legacy sink frames them as
   * `agent:activity` (client sequence, producer fact id, heartbeat and probe
   * frames). Dependencies are read lazily so tests that swap `sendToServer` or
   * fake the clock still apply.
   */
  private readonly activitySink: ActivitySink = new LegacyActivitySink({
    sendToServer: (msg) => this.sendToServer(msg),
    nextClientSeq: (agentId) => this.lifecycleRecords.nextActivityClientSeq(agentId),
    daemonInstanceId: () => this.daemonInstanceId,
    recordEvent: (name, attrs, status) => this.recordDaemonEvent(name, attrs, status),
    now: () => Date.now(),
  });
  private agentStarts: AgentStartCoordinator;
  private agentStartDispatch: AgentStartDispatchProjection;
  private startingInboxes = new AgentStartPendingDeliveryBuffer();
  /**
   * Daemon-local coalescing only. Durable authority is the Server occurrence
   * row; an unacked pending row is replayed with the same occurrence id after
   * daemon restart and reconstructs this cache.
   */
  private readonly trackedMentionDeliveries = new Map<string, TrackedMentionDelivery>();
  /**
   * task #9: the identity of an idle agent being restarted for a delivery,
   * between dropping its restart snapshot and its new process existing, so a
   * tracked mention arriving in that window is matched instead of rejected.
   */
  private readonly restartingIdentities = new Map<string, { launchId: string | null; sessionId: string | null }>();
  /** Monotonic ordering counter for launch phase-5/6 exported rows (audit only, not a pairing key). */
  private launchTransitionSeq = 0;
  private noProcessResidencyTransitions = new AgentNoProcessResidencyTransitions();
  private slockCliPath: string;
  private sendToServer: (msg: MachineToServerMessage) => void;
  /**
   * task #1103 — one parked server wake per agent. An app-inbox item that is
   * due for an agent with no local process and no in-memory restart snapshot
   * is handed to the Server (which owns the config) instead of being retried
   * locally. The slot is resent once per connect edge and cleared by the
   * Server's outcome or by the agent starting for any reason.
   */
  private readonly pendingServerWakes = new Map<string, PendingServerWake>();
  /**
   * RFC 071 §6: the `catchupBatchId` of the latest server start per agent,
   * bound to that start's launchId. The spawn that renders the start's
   * resume catch-up as input takes it (a pending rebind replaces launchId and
   * resumeMessages together, so the launch match keeps them paired). One
   * slot per agent: every later start overwrites or clears it.
   */
  private readonly startCatchupBatches = new Map<string, { launchId: string; batchId: string }>();
  /**
   * RFC 071: launches accepted from server starts that have no final result
   * yet, in acceptance order. A spawn settles every launch waiting here
   * (folded starts become `supersededLaunchIds`); a spawn that fails or is
   * cancelled before a process exists settles them all `not_spawned`.
   */
  private readonly acceptedLaunches = new Map<string, string[]>();
  private daemonApiKey: string;
  private serverUrl: string;
  private slockHome: string;
  private dataDir: string;
  private runtimeSessionHomeDir: string;
  private coldIdleSweepTimer: ReturnType<typeof setInterval> | null = null;
  private frozenClockMs: number | null = null;
  private driverResolver: (runtimeId: string) => RuntimeDriver;
  private defaultAgentEnvVarsProvider: ((config: Pick<AgentConfig, "runtime" | "model" | "envVars">) => Promise<Record<string, string> | null> | Record<string, string> | null) | null;
  private tracer: Tracer;
  private stdinNotificationRetryMs: number;
  private sessionReadyDeliveryRetryMs: number;
  private runtimeErrorDeliveryBackoffBaseMs: number;
  private runtimeErrorDeliveryBackoffMaxMs: number;
  private runtimeErrorDeliveryBackoffJitterRatio: number;
  private runtimeErrorDeliveryBackoffJitterRandom: () => number;
  private runtimeErrorDeliveryBackoffFailPointForTesting: ((args: { agentId: string; message: string }) => RuntimeErrorDeliveryBackoffFailPoint | null | undefined) | null;
  private cliTransportTraceDir: string | null = null;
  /** Machine state root, for reading this machine's own trace corpus. */
  private machineDir: string | null = null;
  private readonly deliveryTraceContexts = new WeakMap<AgentMessage, DeliveryTraceContext>();
  private readonly runtimeExitTraceAttrs = new WeakMap<RuntimeSession, Record<string, unknown>>();
  private readonly runtimeProcessBindingFence = new RuntimeProcessBindingFence({
    getCurrentProcess: (agentId) => this.agents.get(agentId) ?? null,
    recordTrace: (...args) => this.recordDaemonEvent(...args),
  });
  private readonly agentVisibleDelivery = new AgentVisibleDeliveryLedger();
  /**
   * Per-agent lifecycle facts that outlive a single `AgentProcess`.
   *
   * The old implementation stored these as separate manager-level maps:
   * idle restart snapshots, terminal runtime failures, spawn-fail cooldown,
   * pending start rebinds, pending spawn causes, runtime-error fences, and the
   * activity client sequence. Keeping their storage under one owner makes the
   * lifecycle projection/invariants read the actual mutation boundary instead
   * of reconstructing it from unrelated fields.
   */
  private readonly daemonVersion: string | null;
  private readonly daemonInstanceId: string | null;
  private readonly runtimeProcessGate: RuntimeProcessGate | null;
  /** RFC 071: per agent, the start held for the server capability (cancelled by a stop). */
  private readonly capabilityHolds = new Map<string, CapabilityWait>();
  private readonly computerVersion: string | null;
  private readonly workerUrl: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly serverConnected: () => boolean;
  readonly #appInboxForAgent: ((agentId: string) => AgentAppInboxStore) | null;
  private readonly appInboxNoticedItemIds = new Map<string, Set<string>>();
  /**
   * per_turn runtimes (opencode, cursor, gemini, copilot) cannot take a notice
   * between or during turns. The notice waits for the process to exit:
   * `wake: true` restarts the agent for it (as a queued message would);
   * advisory notices instead ride in the next start's first input.
   */
  private readonly appInboxNoticesAfterTurn = new Map<string, { wake: boolean }>();
  private readonly appInboxIdleDrains = new Set<string>();
  private readonly runtimeErrorProcessRestartTimers = new Map<string, unknown>();
  private readonly busyDelivery = new RuntimeBusyDeliveryCoordinator<AgentProcess>({
    nowMs: () => this.clockNow(),
    commitDecisionState: (...args) => this.commitGatedSteeringDecisionState(...args),
    flushDirectNotification: (...args) => this.flushPendingDirectStdinNotificationOnRuntimeProgress(...args),
    flushIdleDelivery: (...args) => this.flushIdleInboxDeliveryRetry(...args),
    recordDaemonEvent: (...args) => this.recordDaemonEvent(...args),
    recordRuntimeTraceEvent: (...args) => this.recordRuntimeTraceEvent(...args),
  });

  constructor(
    sendToServer: (msg: MachineToServerMessage) => void,
    daemonApiKey: string,
    opts: {
      dataDir?: string;
      serverUrl: string;
      workerUrl?: string;
      driverResolver?: (runtimeId: string) => RuntimeDriver;
      defaultAgentEnvVarsProvider?: (config: Pick<AgentConfig, "runtime" | "model" | "envVars">) => Promise<Record<string, string> | null> | Record<string, string> | null;
      slockCliPath?: string;
      slockHome?: string;
      tracer?: Tracer;
      daemonVersion?: string | null;
      daemonInstanceId?: string | null;
      computerVersion?: string | null;
      fetchImpl?: FetchLike;
      stdinNotificationRetryMs?: number;
      sessionReadyDeliveryRetryMs?: number;
      runtimeErrorDeliveryBackoff?: {
        baseMs?: number;
        maxMs?: number;
        jitterRatio?: number;
        jitterRandom?: () => number;
        failPointForTesting?: (args: { agentId: string; message: string }) => RuntimeErrorDeliveryBackoffFailPoint | null | undefined;
      };
      runtimeSessionHomeDir?: string;
      runtimeStartScheduler?: {
        maxConcurrentStarts?: number;
        minStartIntervalMs?: number;
      };
      serverConnected?: () => boolean;
      appInboxForAgent?: (agentId: string) => AgentAppInboxStore;
      /** RFC 071 outbox: every spawn and rebind first durably records the process as open. */
      runtimeProcessGate?: RuntimeProcessGate;
    },
  ) {
    this.slockCliPath = opts.slockCliPath ?? "";
    this.sendToServer = sendToServer;
    this.daemonApiKey = daemonApiKey;
    this.serverUrl = opts.serverUrl;
    this.slockHome = opts.slockHome ? path.resolve(opts.slockHome) : resolveRaftHome();
    this.#appInboxForAgent = opts.appInboxForAgent ?? null;
    this.dataDir = opts.dataDir || resolveRaftHomePath("agents", this.slockHome);
    this.runtimeSessionHomeDir = opts.runtimeSessionHomeDir || os.homedir();
    this.driverResolver = opts.driverResolver || getDriver;
    this.defaultAgentEnvVarsProvider = opts.defaultAgentEnvVarsProvider || null;
    this.tracer = opts.tracer ?? noopTracer;
    this.daemonVersion = opts.daemonVersion?.trim() || null;
    this.daemonInstanceId = opts.daemonInstanceId?.trim() || null;
    this.runtimeProcessGate = opts.runtimeProcessGate ?? null;
    this.computerVersion = opts.computerVersion?.trim() || null;
    this.workerUrl = opts.workerUrl?.trim() || null;
    this.fetchImpl = opts.fetchImpl ?? (daemonFetch as FetchLike);
    this.serverConnected = opts.serverConnected ?? (() => true);
    this.stdinNotificationRetryMs = Math.max(
      0,
      Math.floor(opts.stdinNotificationRetryMs ?? STDIN_NOTIFICATION_RETRY_DELAY_MS),
    );
    this.sessionReadyDeliveryRetryMs = Math.max(
      0,
      Math.floor(opts.sessionReadyDeliveryRetryMs ?? SESSION_READY_DELIVERY_RETRY_DELAY_MS),
    );
    this.runtimeErrorDeliveryBackoffBaseMs = Math.max(
      0,
      Math.floor(opts.runtimeErrorDeliveryBackoff?.baseMs ?? RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS),
    );
    this.runtimeErrorDeliveryBackoffMaxMs = Math.max(
      this.runtimeErrorDeliveryBackoffBaseMs,
      Math.floor(opts.runtimeErrorDeliveryBackoff?.maxMs ?? RUNTIME_ERROR_DELIVERY_BACKOFF_MAX_MS),
    );
    this.runtimeErrorDeliveryBackoffJitterRatio = Math.max(
      0,
      Math.min(1, opts.runtimeErrorDeliveryBackoff?.jitterRatio ?? 0.1),
    );
    this.runtimeErrorDeliveryBackoffJitterRandom = opts.runtimeErrorDeliveryBackoff?.jitterRandom
      ?? (() => randomInt(1_000_000) / 1_000_000);
    this.runtimeErrorDeliveryBackoffFailPointForTesting = opts.runtimeErrorDeliveryBackoff?.failPointForTesting ?? null;
    this.agentStarts = new AgentStartCoordinator({
      maxConcurrentStarts: opts.runtimeStartScheduler?.maxConcurrentStarts
        ?? readPositiveIntegerEnv("SLOCK_DAEMON_MAX_CONCURRENT_AGENT_STARTS", DEFAULT_MAX_CONCURRENT_AGENT_STARTS),
      minStartIntervalMs: opts.runtimeStartScheduler?.minStartIntervalMs
        ?? readNonNegativeIntegerEnv("SLOCK_DAEMON_AGENT_START_INTERVAL_MS", DEFAULT_AGENT_START_INTERVAL_MS),
    });
    this.agentStartDispatch = new AgentStartDispatchProjection(
      this.agentStarts,
      () => this.clockNow(),
      (config) => this.runtimeLaunchPolicyTraceAttrs(config),
    );
    this.coldIdleSweepTimer = setInterval(
      () => void this.sweepColdIdleRuntimes(),
      readPositiveIntegerEnv("RAFT_WAKE_RECYCLE_SWEEP_MS", COLD_IDLE_SWEEP_MS),
    );
    this.coldIdleSweepTimer.unref?.();
  }

  /** RFC 070: an idle claude process past the cache TTL with a large context
   * provides no warmth; stop it so the next wake takes the process-start path,
   * where the at-wake recycle decides between resume and a fresh briefing. */
  private async sweepColdIdleRuntimes(): Promise<void> {
    const views = [...this.agents.entries()].map(([agentId, ap]) => ({
      agentId,
      config: ap.config,
      idle: this.isApmIdle(ap) && !this.hasUntoldInboxWork(ap) && ap.exit.kind === "live",
      lastEventAtMs: ap.runtimeProgress.lastEventAt,
      liveSessionId: ap.sessionId,
    }));
    for (const stop of await selectColdIdleRecycleStops(views, { homeDir: this.runtimeSessionHomeDir })) {
      const ap = this.agents.get(stop.agentId);
      if (!ap || !this.isApmIdle(ap) || this.hasUntoldInboxWork(ap) || ap.exit.kind !== "live") continue;
      logger.info(`[Agent ${stop.agentId}] Stopping cold idle runtime (idle ${Math.round(stop.idleMs / 60_000)}m, ~${Math.round(stop.priorContextTokens / 1000)}k context, session ${stop.sessionId}, ${ap.inbox.length} notified unread); next wake decides resume vs fresh briefing`);
      this.recordDaemonEvent("daemon.agent.cold_idle_stop", {
        agentId: stop.agentId,
        session_id: stop.sessionId,
        idle_ms: stop.idleMs,
        prior_context_tokens: stop.priorContextTokens,
        notified_unread_count: ap.inbox.length,
      });
      this.commitGatedSteeringDecisionState(stop.agentId, ap, reduceApmColdIdleRecycleTermination(ap.gatedSteering).nextState);
      void ap.runtime.stop({ signal: "SIGTERM", reason: "cold_idle_recycle" }).catch((err) => {
        logger.warn(`[Agent ${stop.agentId}] Cold idle stop failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  setTracer(tracer: Tracer): void {
    this.tracer = tracer;
  }

  setCliTransportTraceDir(traceDir: string | null): void {
    this.cliTransportTraceDir = traceDir;
  }

  setMachineDir(machineDir: string | null): void {
    this.machineDir = machineDir;
  }

  private assertStartPendingDeliveryInvariants(context: string): void {
    this.repairNonresidentRuntimeErrorFingerprintFences(context);
    this.repairNoProcessResidency(context);
    const residencySnapshot = this.noProcessResidencySnapshot();
    AgentNoProcessResidency.assertInvariants(context, residencySnapshot);
    this.lifecycleRecords.assertInvariants(context, this.agentLifecycleRecordSnapshot());
    this.startingInboxes.assertInvariants(
      context,
      AgentNoProcessResidency.allowedStartPendingSnapshot(residencySnapshot),
    );
  }

  /**
   * Repair no-process residency facts that drifted out of I2/I4 before the
   * global assertion runs (task #1102). The assertion below is a manager-wide
   * fail-closed gate: one agent's stale fact used to make EVERY agent's
   * read/history/send fail with LOCAL_DAEMON_STATE_INVALID until a daemon
   * restart (field: two machines, 2026-09-13). A stale fact is a bug in the
   * writer, so each repair is logged at error level and traced; it must never
   * become the silent normal path.
   *
   * - I4: pending start-delivery for an agent with no queued/starting/terminal/
   *   cooldown residency is dropped. The Server still holds the messages; the
   *   agent receives them as unread context on its next wake.
   * - I2: terminal failure coexisting with an idle restart config keeps the
   *   wakeable fact (restart config) and retires the terminal failure, so the
   *   next delivery restarts the agent instead of silently refusing.
   */
  private repairNoProcessResidency(context: string): void {
    const residencySnapshot = this.noProcessResidencySnapshot();
    const idle = new Set(residencySnapshot.idleAgentIds);
    for (const agentId of residencySnapshot.terminalFailureAgentIds) {
      if (!idle.has(agentId)) continue;
      this.lifecycleRecords.deleteTerminalFailure(agentId);
      logger.error(`[Agent ${agentId}] Repaired residency: terminal failure and idle restart config both present after ${context}; kept restart config`);
      this.recordDaemonEvent("daemon.agent.residency.repaired", {
        agentId,
        context,
        repair: "terminal_idle_overlap",
        kept: "idle_restart_config",
      }, "error");
    }

    const allowedPending = AgentNoProcessResidency.allowedStartPendingSnapshot(this.noProcessResidencySnapshot());
    const allowed = new Set<string>([
      ...allowedPending.queuedAgentIds,
      ...allowedPending.startingAgentIds,
      ...allowedPending.terminalRecoveryAgentIds,
      ...allowedPending.cooldownAgentIds,
    ]);
    for (const agentId of this.startingInboxes.agentIds()) {
      if (allowed.has(agentId)) continue;
      const droppedCount = this.startingInboxes.count(agentId);
      this.startingInboxes.cancelStart(agentId);
      logger.error(`[Agent ${agentId}] Repaired residency: dropped ${droppedCount} orphan pending delivery message(s) without residency after ${context}`);
      this.recordDaemonEvent("daemon.agent.residency.repaired", {
        agentId,
        context,
        repair: "orphan_pending_delivery",
        dropped_count: droppedCount,
      }, "error");
    }
  }

  private noProcessResidencySnapshot(): AgentNoProcessResidencySnapshot {
    const startSnapshot = this.agentStarts.snapshot();
    const now = this.clockNow();
    return {
      runningAgentIds: [...this.agents.keys()],
      queuedAgentIds: startSnapshot.queuedAgentIds,
      startingAgentIds: startSnapshot.startingAgentIds,
      idleAgentIds: [...this.lifecycleRecords.restartSnapshotAgentIds()],
      terminalFailureAgentIds: [...this.lifecycleRecords.terminalFailureAgentIds()],
      activeCooldownAgentIds: this.lifecycleRecords.activeSpawnFailBackoffAgentIds(
        now,
        (state, currentTime) => state.untilMs > currentTime,
      ),
      fingerprintFenceAgentIds: [...this.lifecycleRecords.runtimeErrorFingerprintFenceAgentIds()],
      pendingDeliveryAgentIds: this.startingInboxes.agentIds(),
    };
  }

  private agentLifecycleRecordSnapshot(): AgentLifecycleRecordSnapshot<RuntimeErrorDeliveryBackoffState, RuntimeErrorFingerprintFenceState> {
    const startSnapshot = this.agentStarts.snapshot();
    const now = this.clockNow();
    return this.lifecycleRecords.snapshot({
      runningAgentIds: [...this.agents.keys()],
      queuedAgentIds: startSnapshot.queuedAgentIds,
      startingAgentIds: startSnapshot.startingAgentIds,
      now,
      isSpawnFailBackoffActive: (state, currentTime) => state.untilMs > currentTime,
    });
  }

  private agentLifecycleRecord(agentId: string): AgentLifecycleRecord<RuntimeErrorDeliveryBackoffState, RuntimeErrorFingerprintFenceState> | undefined {
    return buildAgentLifecycleRecords(this.agentLifecycleRecordSnapshot()).get(agentId);
  }

  private getVisibleBoundary(agentId: string, target: string): number | undefined {
    return this.agentVisibleDelivery.getBoundary(agentId, target);
  }

  private getVisibleMessageIdSet(agentId: string, target: string): Set<string> | undefined {
    return this.agentVisibleDelivery.getMessageIdSet(agentId, target);
  }

  private isVisibleMessageModelSeen(agentId: string, target: string, message: { seq?: number; message_id?: string; id?: string }): boolean {
    return this.agentVisibleDelivery.isModelSeen(agentId, target, message);
  }

  private projectThreadJoinContextsForRuntimeInput(
    agentId: string,
    messages: readonly AgentMessage[],
    renderContext = true,
  ): { messages: AgentMessage[]; renderedContextMessages: AgentMessage[] } {
    return projectThreadJoinContextsForRuntimeInput(
      messages,
      (target) => this.getVisibleBoundary(agentId, target),
      renderContext,
    );
  }

  private recordRenderedThreadJoinContextReceipts(
    agentId: string,
    messages: readonly AgentMessage[],
  ): void {
    for (const [target, contextMessages] of groupThreadJoinContextReceiptMessages(messages)) {
      this.consumeVisibleMessages(agentId, {
        target,
        messages: contextMessages,
        source: "thread_join_context_rendered",
      });
    }
  }

  // ----- SPAWN-FAIL BACKOFF (per-agent) ----------------------------------
  // Anchored at auto_restart_from_idle (apm:3596) + runtime_profile_auto_restart (apm:4137).
  // One outer spawn failure enters cooldown immediately so repeated wakes cannot burn one
  // full spawn attempt per delivery. Runner credential mint failures keep a longer cooldown
  // because one outer failure already means the inner credential-mint loop exhausted
  // RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS.
  // Successful spawn resets state. State lives outside AgentProcess because spawn fails BEFORE
  // ap exists and the rate-window must persist across stop/respawn (else stop/start churn
  // bypasses the cap — CC1 lifecycle pattern). Never advances any consume cursor or model-seen
  // state (3-cursor orthogonality with CC1/CC2).
  private getOrCreateSpawnFailBackoff(agentId: string): RuntimeErrorDeliveryBackoffState {
    return this.lifecycleRecords.getOrCreateSpawnFailBackoff(agentId, createRuntimeErrorDeliveryBackoffState);
  }

  private isSpawnFailBackoffActive(agentId: string): boolean {
    const state = this.lifecycleRecords.getSpawnFailBackoff(agentId);
    if (!state) return false;
    return state.untilMs > 0 && this.clockNow() < state.untilMs;
  }

  private clockNow(): number {
    return this.frozenClockMs ?? this.readWallClock();
  }

  /** Test seam for the wall clock; production reads Date.now(). */
  private readWallClock(): number {
    return Date.now();
  }

  /** Task #355: run a synchronous routing step so that every clock read inside
   * it (the routing decision, the invariant repair, the residency entry) sees
   * the same instant. Without this, a cooldown that expires between two reads
   * is "active" to the router and "gone" to the repair, and the repair drops
   * the deliveries the router just buffered. */
  private withClockFrozen<T>(nowMs: number, fn: () => T): T {
    const previous = this.frozenClockMs;
    this.frozenClockMs = nowMs;
    try {
      return fn();
    } finally {
      this.frozenClockMs = previous;
    }
  }

  private recordSpawnFailure(agentId: string, reason: string): { backoffActive: boolean; attempts: number; untilMs: number } {
    const state = this.getOrCreateSpawnFailBackoff(agentId);
    state.attempts += 1;
    state.reason = reason;
    const isRunnerCredentialMint = reason === "runner_credential_mint";
    const threshold = isRunnerCredentialMint
      ? RUNNER_CREDENTIAL_MINT_BACKOFF_THRESHOLD
      : SPAWN_FAIL_BACKOFF_THRESHOLD;
    const baseMs = isRunnerCredentialMint
      ? RUNNER_CREDENTIAL_MINT_BACKOFF_BASE_MS
      : SPAWN_FAIL_BACKOFF_BASE_MS;
    const maxMs = isRunnerCredentialMint
      ? RUNNER_CREDENTIAL_MINT_BACKOFF_MAX_MS
      : SPAWN_FAIL_BACKOFF_MAX_MS;
    if (state.attempts <= threshold) {
      // Below threshold: do NOT enter cooldown. Generic spawn failures use threshold 0,
      // so this branch is currently only for future non-immediate reasons.
      state.untilMs = 0;
      return { backoffActive: false, attempts: state.attempts, untilMs: 0 };
    }
    const exponent = Math.min(state.attempts - threshold - 1, 10);
    const baseDelay = Math.min(maxMs, baseMs * Math.pow(2, exponent));
    state.untilMs = this.clockNow() + Math.floor(baseDelay);
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => this.onSpawnFailBackoffExpired(agentId), Math.max(1, state.untilMs - this.clockNow()));
    return { backoffActive: true, attempts: state.attempts, untilMs: state.untilMs };
  }

  private onSpawnFailBackoffExpired(agentId: string): void {
    const s = this.lifecycleRecords.getSpawnFailBackoff(agentId);
    if (!s) return;
    s.timer = null;
    s.untilMs = 0;
    // Task #355: deliveries buffered during the cooldown were promised a spawn
    // ("only delays the spawn, never drops"). Nothing else hands them over when
    // the cooldown ends, and the next invariant check would drop them as orphans
    // of an idle agent, so start the agent from its pending inbox here.
    const restartSnapshot = this.lifecycleRecords.getRestartSnapshot(agentId);
    const hasPendingWithoutProcess = this.startingInboxes.has(agentId)
      && !this.agents.has(agentId)
      && !this.agentStarts.hasQueued(agentId)
      && !this.agentStarts.hasStarting(agentId);
    if (restartSnapshot && hasPendingWithoutProcess) {
      this.lifecycleRecords.deleteRestartSnapshot(agentId);
      logger.info(`[Agent ${agentId}] Spawn-fail cooldown ended with ${this.startingInboxes.count(agentId)} buffered delivery(ies); starting from pending inbox`);
      this.recordDaemonEvent("daemon.agent.spawn_fail_cooldown.expired_restart", {
        agentId,
        launchId: restartSnapshot.launchId || undefined,
        pending_count: this.startingInboxes.count(agentId),
      });
      this.startAgent(agentId, restartSnapshot.config, undefined, undefined, undefined, restartSnapshot.launchId || undefined).then(
        () => this.resetSpawnFailBackoff(agentId),
        (err) => {
          logger.error(`[Agent ${agentId}] Failed to start from pending inbox after spawn-fail cooldown`, err);
          this.lifecycleRecords.setRestartSnapshot(agentId, restartSnapshot);
          const report = this.recordSpawnFailure(agentId, "spawn_error");
          if (report.backoffActive) {
            this.enterSpawnFailCooldownResidency(agentId, restartSnapshot, report.untilMs, "spawn_fail_cooldown_expired", "spawn_error");
          }
        },
      );
    }
    this.closeNoProcessResidency(agentId, "timeout", { negativeEvidenceBucket: "spawn_fail_cooldown_expired" });
  }

  private resetSpawnFailBackoff(agentId: string, closeResult: AgentNoProcessResidencyCloseResult = "advanced"): void {
    const state = this.lifecycleRecords.getSpawnFailBackoff(agentId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    this.lifecycleRecords.deleteSpawnFailBackoff(agentId);
    this.closeNoProcessResidency(agentId, closeResult, { negativeEvidenceBucket: "spawn_fail_cooldown_reset" });
  }

  private armRuntimeErrorProcessRestart(
    agentId: string,
    ap: AgentProcess,
    reason: string,
    queuedWakeMessage: AgentMessage,
    bufferedRestartMessages: AgentMessage[],
  ): void {
    const nextConfig = this.buildRestartSafeConfig(ap.config, ap.sessionId);
    const cached = {
      config: nextConfig,
      sessionId: ap.sessionId,
      launchId: ap.launchId,
      processInstanceId: ap.processInstanceId,
    };
    const attempts = 1;
    const delayMs = this.computeRuntimeErrorDeliveryBackoffDelayMs(attempts);
    const untilMs = this.clockNow() + delayMs;
    const stopEpochAtSchedule = this.lifecycleRecords.stopEpoch(agentId);

    this.cancelRuntimeErrorProcessRestart(agentId);
    this.lifecycleRecords.setRestartSnapshot(agentId, cached);
    this.lifecycleRecords.deleteTerminalFailure(agentId);

    const previousCooldownState = this.lifecycleRecords.getSpawnFailBackoff(agentId);
    if (previousCooldownState?.kind === "backing_off" && previousCooldownState.timer) {
      clearTimeout(previousCooldownState.timer);
    }

    const timer = setClockTimeout(() => {
      if (this.lifecycleRecords.stopEpochChanged(agentId, stopEpochAtSchedule)) {
        this.cancelRuntimeErrorProcessRestart(agentId);
        return;
      }
      this.runtimeErrorProcessRestartTimers.delete(agentId);
      const currentCooldown = this.lifecycleRecords.getSpawnFailBackoff(agentId);
      if (currentCooldown !== cooldownState) return;
      if (this.agents.has(agentId) || this.agentStarts.hasQueued(agentId) || this.agentStarts.hasStarting(agentId)) return;

      this.lifecycleRecords.deleteSpawnFailBackoff(agentId);
      this.closeNoProcessResidency(agentId, "timeout", { negativeEvidenceBucket: "runtime_error_process_backoff_elapsed" });
      const restartSnapshot = this.lifecycleRecords.getRestartSnapshot(agentId);
      if (!restartSnapshot) return;
      this.lifecycleRecords.deleteRestartSnapshot(agentId);
      this.lifecycleRecords.setPendingSpawnCause(agentId, "restart_crash");
      const startPromise = this.startAgent(agentId, restartSnapshot.config, undefined, undefined, undefined, restartSnapshot.launchId || undefined);
      startPromise.catch((err) => {
        logger.error(`[Agent ${agentId}] Failed to restart after recoverable runtime error`, err);
        this.lifecycleRecords.setRestartSnapshot(agentId, restartSnapshot);
        this.sendAgentStatus(agentId, "inactive", restartSnapshot.launchId);
        this.broadcastActivity(agentId, "offline", "Runtime retry failed after recoverable provider error", [], restartSnapshot.launchId, "runtime_crashed");
      });
    }, Math.max(1, untilMs - this.clockNow())) as ReturnType<typeof setTimeout>;
    const cooldownState: RuntimeErrorDeliveryBackoffState = {
      kind: "backing_off",
      attempts,
      reason,
      untilMs,
      timer,
    };
    this.lifecycleRecords.activeSpawnFailBackoffs.set(agentId, cooldownState);
    timer.unref?.();
    this.runtimeErrorProcessRestartTimers.set(agentId, timer);
    this.startingInboxes.bufferMessagesDuringStart(agentId, [
      queuedWakeMessage,
      ...bufferedRestartMessages,
    ]);
    this.assertStartPendingDeliveryInvariants("recoverable-runtime-close-pending-inbox");

    this.enterSpawnFailCooldownResidency(agentId, { config: nextConfig, launchId: ap.launchId }, untilMs, "recoverable_runtime_error_process_close", reason);
    this.recordDaemonEvent("daemon.agent.runtime_error_process_restart.scheduled", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      reason,
      attempts,
      delay_ms: delayMs,
      until_ms: untilMs,
      inbox_count: 1 + bufferedRestartMessages.length,
      session_id_present: Boolean(ap.sessionId),
    });
    this.sendAgentStatus(agentId, "active", ap.launchId);
  }

  // ----- RUNTIME-ERROR FINGERPRINT FENCE (per-agent) ---------------------
  // The delivery backoff above is scoped to AgentProcess and is cleared when a
  // runtime process exits. Recoverable terminal errors intentionally keep an
  // idle restart cache so the next message can wake the agent, but that also
  // means a deterministic same-fingerprint runtime error can close/restart
  // forever. Keep this counter outside AgentProcess and reset only on real turn
  // progress or explicit stop.
  private runtimeErrorFingerprintFenceResetEvent(eventKind: ParsedEvent["kind"]): boolean {
    return runtimeErrorFingerprintFenceResetEvent(eventKind);
  }

  private resetRuntimeErrorFingerprintFence(agentId: string, resetSource: string, ap?: AgentProcess): void {
    const state = this.lifecycleRecords.getRuntimeErrorFingerprintFence(agentId);
    if (!state) return;
    this.lifecycleRecords.deleteRuntimeErrorFingerprintFence(agentId);
    this.recordDaemonEvent("daemon.agent.runtime_error_fingerprint_fence.reset", {
      agentId,
      runtime: ap?.config.runtime,
      model: ap?.config.model,
      launchId: ap?.launchId || state.launchId || undefined,
      fingerprint: state.fingerprint,
      attempts: state.attempts,
      reset_source: resetSource,
    });
  }

  private resetRuntimeErrorFingerprintFenceIfNonresident(agentId: string, resetSource: string, ap?: AgentProcess): void {
    if (this.agents.has(agentId)) return;
    if (this.lifecycleRecords.getRestartSnapshot(agentId)) return;
    if (this.lifecycleRecords.getTerminalFailure(agentId)) return;
    this.resetRuntimeErrorFingerprintFence(agentId, resetSource, ap);
  }

  private repairNonresidentRuntimeErrorFingerprintFences(context: string): void {
    for (const agentId of [...this.lifecycleRecords.runtimeErrorFingerprintFenceAgentIds()]) {
      this.resetRuntimeErrorFingerprintFenceIfNonresident(agentId, `invariant_repair:${context}`);
    }
  }

  private formatRuntimeErrorFingerprintFenceDetail(state: RuntimeErrorFingerprintFenceState): string {
    return formatRuntimeErrorFingerprintFenceDetail(state);
  }

  private formatVisibleRuntimeErrorMessage(ap: AgentProcess, message: string): string {
    if (isRuntimeInputTooLargeErrorText(message)) {
      return formatRuntimeInputTooLargeMessage(ap.driver.id);
    }
    return message;
  }

  private noteRuntimeErrorFingerprintFence(
    agentId: string,
    ap: AgentProcess,
    message: string,
    fingerprint: string | null,
    terminalFailure: RuntimeErrorDeliveryFailure | null,
    stickyTerminalFailure: RuntimeErrorDeliveryFailure | null,
  ): RuntimeErrorFingerprintFenceState | null {
    if (!fingerprint) return null;
    if (stickyTerminalFailure || terminalFailure?.actionRequired) return null;

    let state = this.lifecycleRecords.getRuntimeErrorFingerprintFence(agentId);
    if (!state || state.fingerprint !== fingerprint) {
      state = {
        fingerprint,
        attempts: 0,
        lastRuntimeError: message,
        detail: "",
        launchId: ap.launchId,
      };
      this.lifecycleRecords.setRuntimeErrorFingerprintFence(agentId, state);
    }

    state.attempts += 1;
    state.lastRuntimeError = message;
    state.launchId = ap.launchId;
    state.detail = this.formatRuntimeErrorFingerprintFenceDetail({
      ...state,
      lastRuntimeError: this.formatVisibleRuntimeErrorMessage(ap, message),
    });
    const fenced = state.attempts >= RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD;

    this.recordDaemonEvent("daemon.agent.runtime_error_fingerprint_fence", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      fingerprint,
      attempts: state.attempts,
      threshold: RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD,
      fenced,
      runtime_error_class: buildRuntimeErrorDiagnosticEnvelope(message).spanAttrs.runtime_error_class,
    }, fenced ? "error" : "ok");

    return fenced ? state : null;
  }

  private applyRuntimeErrorFingerprintFence(agentId: string, ap: AgentProcess, state: RuntimeErrorFingerprintFenceState): void {
    const runtimeErrorClass = String(buildRuntimeErrorDiagnosticEnvelope(state.lastRuntimeError).spanAttrs.runtime_error_class);
    // task #352 — this path used to leave no runner.log line at all: when traces
    // were not uploaded, the SIGTERM below had no visible cause anywhere. One
    // line per trip (not per attempt), with the fields needed to attribute it.
    logger.warn(
      `[Agent ${agentId}] ${ap.driver.id} same-fingerprint runtime error fence tripped: `
      + `fingerprint=${state.fingerprint} attempts=${state.attempts}/${RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD} class=${runtimeErrorClass}; `
      + "stopping the runtime and entering terminal residency",
    );
    this.recordDaemonEvent("daemon.agent.runtime_error_fingerprint_fence.tripped", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      fingerprint: state.fingerprint,
      attempts: state.attempts,
      threshold: RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD,
      runtime_error_class: runtimeErrorClass,
    }, "error");
    this.lifecycleRecords.deleteRestartSnapshot(agentId);
    this.sendAgentStatus(agentId, "inactive", ap.launchId);
    this.cleanupTerminalRuntimeFailure(agentId, ap, state.detail, {
      failureKind: "fingerprint_fence",
      fingerprint: state.fingerprint,
      errorClass: terminalFailureFromRawText("fingerprint_fence", state.lastRuntimeError).errorClass,
    });
  }

  private scheduleStdinNotification(agentId: string, ap: AgentProcess, delayMs: number): boolean {
    return ap.notifications.schedule(() => {
      this.sendStdinNotification(agentId);
    }, delayMs);
  }

  private scheduleSessionReadyDeliveryRetry(agentId: string, ap: AgentProcess, reason: string): boolean {
    return scheduleSessionReadyDeliveryRetryDebt(agentId, ap, reason, {
      delayMs: this.sessionReadyDeliveryRetryMs,
      readyDelayCapMs: STDIN_NOTIFICATION_INITIAL_DELAY_MS,
      canDeliverToRuntimeSession: (process) => this.canDeliverToRuntimeSession(process),
      flush: (id, source) => this.flushSessionReadyDeliveryRetry(id, source),
      recordDaemonEvent: (...args) => this.recordDaemonEvent(...args),
    });
  }

  private flushSessionReadyDeliveryRetry(agentId: string, source: SessionReadyDeliveryRetryFlushSource): boolean {
    return flushSessionReadyDeliveryRetryDebt(agentId, source, {
      getProcess: (id) => this.agents.get(id),
      canDeliverToRuntimeSession: (ap) => this.canDeliverToRuntimeSession(ap),
      isApmIdle: (ap) => this.isApmIdle(ap),
      commitApmIdleState: (id, ap, idle) => this.commitApmIdleState(id, ap, idle),
      startRuntimeTrace: (id, ap, name, messages) => this.startRuntimeTrace(id, ap, name, messages),
      deliverInboxUpdateViaStdin: (id, ap, messages, mode, deliverySource) => this.deliverInboxUpdateViaStdin(id, ap, messages, mode, deliverySource),
      sendStdinNotification: (id, options) => this.sendStdinNotification(id, options),
      recordDaemonEvent: (...args) => this.recordDaemonEvent(...args),
    });
  }

  private scheduleIdleInboxDeliveryRetry(agentId: string, ap: AgentProcess, notificationCount: number, source: string, traceName: string): boolean {
    if (notificationCount <= 0 || !ap.driver.supportsStdinNotification || !ap.sessionId) return false;
    ap.notifications.add(notificationCount);
    ap.notifications.clearTimer();
    return ap.notifications.schedule(() => {
      this.flushIdleInboxDeliveryRetry(agentId, source, traceName);
    }, this.stdinNotificationRetryMs);
  }

  private flushIdleInboxDeliveryRetry(agentId: string, source: string, traceName: string): boolean {
    return flushIdleInboxDeliveryRetryDebt(agentId, source, traceName, {
      getProcess: (id) => this.agents.get(id),
      isApmIdle: (ap) => this.isApmIdle(ap),
      commitApmIdleState: (id, ap, idle) => this.commitApmIdleState(id, ap, idle),
      startRuntimeTrace: (id, ap, name, messages) => this.startRuntimeTrace(id, ap, name, messages),
      deliverInboxUpdateViaStdin: (id, ap, messages, mode, deliverySource) => this.deliverInboxUpdateViaStdin(id, ap, messages, mode, deliverySource),
      sendStdinNotification: (id, options) => this.sendStdinNotification(id, options),
      recordDaemonEvent: (...args) => this.recordDaemonEvent(...args),
    });
  }

  private flushAsyncRejectedIdleDelivery(agentId: string): boolean {
    return this.flushIdleInboxDeliveryRetry(
      agentId,
      "async_rejected_idle_delivery_retry",
      "daemon.agent.stdin_delivery.async_rejected.retry",
    );
  }

  /**
   * task #1114 — record one successful stdin write against the runtime
   * consumption clock and expose the result as typed observation. A write is
   * evidence of transport, not of consumption; the counter resets only on a
   * model-driven runtime event (see DeliveryConsumptionWatch). Observation
   * only: nothing here stops, restarts, retries or throttles anything.
   */
  private observeDeliveryWrite(
    agentId: string,
    ap: AgentProcess,
    deliveryKey: string | null,
    path: DeliveryWritePath,
  ): void {
    const nowMs = Date.now();
    const observation = ap.deliveryConsumption.recordWrite(deliveryKey, path, nowMs);
    const processAlive = ap.runtime.isAlive() ?? !ap.runtime.closed;
    this.recordDaemonEvent("daemon.agent.delivery.consumption", {
      agent_id: agentId,
      launch_id: ap.launchId || "",
      session_id_present: Boolean(ap.sessionId),
      runtime: ap.config.runtime,
      delivery_path: path,
      episode: observation.episode,
      unconsumed_deliveries: observation.unconsumedDeliveries,
      first_unconsumed_age_ms_bucket: observation.firstUnconsumedAtMs === null ? null : bucketMs(nowMs - observation.firstUnconsumedAtMs),
      last_delivery_key: observation.lastDeliveryKey,
      last_consumption_kind: observation.lastConsumption?.kind ?? null,
      last_consumption_age_ms_bucket: observation.lastConsumption ? bucketMs(nowMs - observation.lastConsumption.atMs) : null,
      last_runtime_result_kind: observation.lastRuntimeResult?.kind ?? null,
      last_runtime_result_class: observation.lastRuntimeResult?.kind === "error" ? observation.lastRuntimeResult.errorClass : null,
      last_runtime_result_empty: observation.lastRuntimeResult?.kind === "completed" ? observation.lastRuntimeResult.empty : null,
      last_delivery_error_class: observation.lastDeliveryError?.errorClass ?? null,
      process_alive: processAlive,
      threshold_crossed: observation.thresholdCrossed,
    }, observation.thresholdCrossed ? "error" : "ok");
    if (observation.thresholdCrossed) {
      const ageMs = observation.firstUnconsumedAtMs === null ? 0 : nowMs - observation.firstUnconsumedAtMs;
      logger.warn(
        `[Agent ${agentId}] ${observation.unconsumedDeliveries} stdin deliveries written since the last runtime consumption signal `
        + `(episode ${observation.episode}, first ${Math.round(ageMs / 1000)}s ago, process ${processAlive ? "alive" : "gone"}); observation only`,
      );
      // task #1116: project the typed state so the web can show it. Once per
      // episode, activity kind unchanged (this is a diagnostic, not a verdict).
      this.broadcastActivity(
        agentId,
        ap.lastActivityKind ?? "online",
        `${observation.unconsumedDeliveries} deliveries written, runtime not consuming`,
        [],
        ap.launchId || undefined,
        "delivery_unconsumed",
        undefined,
        undefined,
        undefined,
        {
          launchId: ap.launchId || "",
          episode: observation.episode,
          unconsumedDeliveries: observation.unconsumedDeliveries,
          firstUnconsumedAtMs: observation.firstUnconsumedAtMs,
          lastDeliveryAtMs: observation.lastDeliveryAtMs,
          lastDeliveryKey: observation.lastDeliveryKey,
          lastDeliveryPath: observation.lastDeliveryPath,
          lastConsumptionKind: observation.lastConsumption?.kind ?? null,
          lastConsumptionAtMs: observation.lastConsumption?.atMs ?? null,
          lastRuntimeResult: observation.lastRuntimeResult,
          lastDeliveryErrorClass: observation.lastDeliveryError?.errorClass ?? null,
          processAlive,
        },
      );
    }
  }

  /** task #1114: queryable delivery-consumption state for a live agent process, or null. */
  getDeliveryConsumptionSnapshot(agentId: string): DeliveryConsumptionSnapshot | null {
    return this.agents.get(agentId)?.deliveryConsumption.snapshot() ?? null;
  }

  /**
   * task #1114 — may this runtime event be attributed to the live process's
   * pending stdin writes? An event that names a session must name the live
   * one; an event without a session (or with the live one) counts only while a
   * turn is open on the process, because the daemon opens the turn when it
   * writes and a turn-less event has nothing to consume.
   */
  private deliveryConsumptionAssociation(
    ap: AgentProcess,
    event: ParsedEvent,
  ): "associated" | "session_mismatch" | "no_live_turn" {
    const eventSessionId = "sessionId" in event && typeof event.sessionId === "string" ? event.sessionId : undefined;
    // A named event must name the live session. An unknown live session
    // (ap.sessionId === null) fails closed: every write path requires a bound
    // session, so there is nothing a foreign-session event could have consumed.
    if (eventSessionId !== undefined && eventSessionId !== ap.sessionId) return "session_mismatch";
    if (!this.isApmIdle(ap)) return "associated";
    if (eventSessionId !== undefined) return "associated";
    return "no_live_turn";
  }

  private isApmIdle(ap: AgentProcess): boolean {
    return ap.gatedSteering.isIdle;
  }

  /** Work the runtime has not been told about yet: a notice still waiting to
   * be written, or a queued message whose notice never reached this session.
   * Messages the agent was notified about and chose to leave unread are its own
   * deferral, not pending work — under inbox-notice delivery agents routinely
   * idle with dozens of them, so treating them as work kept the cold-idle sweep
   * from ever firing. */
  private hasUntoldInboxWork(ap: AgentProcess): boolean {
    return ap.notifications.pendingCount > 0
      || ap.notifications.filterUncontributedMessages(ap.inbox, ap.sessionId).length > 0;
  }

  /** A cold-idle sweep stop must not turn the agent's deliberately-unread,
   * already-notified messages into an immediate restart wake: they stay unread
   * on the server and surface at the next real wake. Anything not yet told to
   * the session still wakes it as before. */
  private isNotifiedDeferralAtColdIdleStop(
    ap: AgentProcess,
    terminationReason: ApmExpectedTerminationReason,
    message: AgentMessage,
  ): boolean {
    return terminationReason === "cold_idle_recycle"
      && ap.notifications.hasContributedMessage(message, ap.sessionId);
  }

  private flushPendingDirectStdinNotificationOnRuntimeProgress(
    agentId: string,
    ap: AgentProcess,
    source: string,
  ): boolean {
    if (ap.notifications.pendingCount === 0) return false;
    if (this.isApmIdle(ap)) return false;
    if (!ap.sessionId) return false;
    if (!ap.driver.supportsStdinNotification) return false;
    if (ap.runtime.descriptor.busyDelivery !== "direct") return false;
    if (ap.gatedSteering.compacting && ap.driver.acceptsStdinDuringCompaction !== true) return false;
    if (ap.gatedSteering.reviewing) return false;

    this.recordDaemonEvent("daemon.agent.stdin_notification.retry_signal", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      source,
      mode: "busy",
      pending_notification_count: ap.notifications.pendingCount,
      inbox_count: ap.inbox.length,
      session_id_present: true,
    });
    return this.sendStdinNotification(agentId, { forceUnsupportedRetry: true });
  }

  private clearRuntimeErrorDeliveryBackoff(ap: AgentProcess): void {
    if (ap.runtimeErrorDeliveryBackoff.kind === "backing_off" && ap.runtimeErrorDeliveryBackoff.timer) {
      clearTimeout(ap.runtimeErrorDeliveryBackoff.timer);
    }
    ap.runtimeErrorDeliveryBackoff = createRuntimeErrorDeliveryBackoffState();
  }

  private clearPendingTrajectoryTimer(ap: AgentProcess): void {
    if (ap.pendingTrajectory?.timer) {
      clearTimeout(ap.pendingTrajectory.timer);
    }
    ap.pendingTrajectory = null;
  }

  private clearActivityHeartbeat(ap: AgentProcess): void {
    if (ap.activityHeartbeat.kind === "inactive") return;
    clearInterval(ap.activityHeartbeat.timer);
    ap.activityHeartbeat = { kind: "inactive" };
  }

  private broadcastMessageReceivedActivity(agentId: string): void {
    this.broadcastActivity(agentId, "working", "Message received", [], undefined, "model_request_started");
  }

  private toolActivityDetailKind(toolName: string): AgentActivityDetailKind {
    switch (resolveToolSemantic(toolName) ?? toolName) {
      case "bash":
        return "running_command";
      case "check_messages":
      case "receive_message":
        return "checking_messages";
      default:
        return "tool_started";
    }
  }

  private disposeAgentProcessTimers(
    ap: AgentProcess,
    options: { includeCompactionWatchdog?: boolean } = {},
  ): void {
    this.clearRuntimeErrorDeliveryBackoff(ap);
    clearSessionReadyDeliveryRetry(ap);
    this.clearPendingTrajectoryTimer(ap);
    this.clearActivityHeartbeat(ap);
    this.clearRuntimeStartupTimeout(ap);
    if (options.includeCompactionWatchdog ?? true) {
      this.clearCompactionWatchdog(ap);
    }
    this.clearReviewWatchdog(ap);
    this.clearStalledRecoverySigtermWatchdog(ap);
  }

  private clearRuntimeErrorDeliveryBackoffWithTrace(agentId: string, ap: AgentProcess, resetSource: string): void {
    if (ap.runtimeErrorDeliveryBackoff.attempts === 0 && ap.runtimeErrorDeliveryBackoff.untilMs === 0) return;
    const attempts = ap.runtimeErrorDeliveryBackoff.attempts;
    const reason = ap.runtimeErrorDeliveryBackoff.reason;
    this.clearRuntimeErrorDeliveryBackoff(ap);
    this.recordDaemonEvent("daemon.agent.runtime_error_delivery_backoff.reset", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      reason: reason || undefined,
      attempts,
      reset_source: resetSource,
    });
  }

  private clearRuntimeErrorDeliveryBackoffAfterProgress(agentId: string, ap: AgentProcess, eventKind: string): void {
    this.clearRuntimeErrorDeliveryBackoffWithTrace(agentId, ap, eventKind);
  }

  private runtimeErrorDeliveryBackoffRemainingMs(ap: AgentProcess): number {
    if (ap.runtimeErrorDeliveryBackoff.kind === "idle") return 0;
    return Math.max(0, ap.runtimeErrorDeliveryBackoff.untilMs - Date.now());
  }

  private runtimeErrorDeliveryBackoffTimerScheduled(ap: AgentProcess): boolean {
    return ap.runtimeErrorDeliveryBackoff.kind === "backing_off" && ap.runtimeErrorDeliveryBackoff.timer !== null;
  }

  private scheduleRuntimeErrorDeliveryBackoffFlush(agentId: string, ap: AgentProcess): boolean {
    const state = ap.runtimeErrorDeliveryBackoff;
    if (state.kind === "idle") return false;
    const delayMs = this.runtimeErrorDeliveryBackoffRemainingMs(ap);
    if (delayMs <= 0 || state.timer) return false;
    state.timer = setTimeout(() => {
      if (ap.runtimeErrorDeliveryBackoff === state) state.timer = null;
      this.flushRuntimeErrorDeliveryBackoff(agentId);
    }, delayMs);
    state.timer.unref?.();
    return true;
  }

  private recoverableRuntimeDeliveryBackoffReason(
    message: string,
    terminalFailure: RuntimeErrorDeliveryFailure | null,
    stickyTerminalFailure: RuntimeErrorDeliveryFailure | null,
    reasonOverride?: string | null,
  ): string | null {
    return recoverableRuntimeDeliveryBackoffReason(message, terminalFailure, stickyTerminalFailure, reasonOverride);
  }

  private noteRuntimeErrorDeliveryBackoff(
    agentId: string,
    ap: AgentProcess,
    message: string,
    terminalFailure: RuntimeErrorDeliveryFailure | null,
    stickyTerminalFailure: RuntimeErrorDeliveryFailure | null,
    reasonOverride?: string | null,
  ): boolean {
    const reason = this.recoverableRuntimeDeliveryBackoffReason(message, terminalFailure, stickyTerminalFailure, reasonOverride);
    if (!reason) return false;

    const attempts = ap.runtimeErrorDeliveryBackoff.attempts + 1;
    const delayMs = this.computeRuntimeErrorDeliveryBackoffDelayMs(attempts);

    if (ap.runtimeErrorDeliveryBackoff.kind === "backing_off" && ap.runtimeErrorDeliveryBackoff.timer) {
      clearTimeout(ap.runtimeErrorDeliveryBackoff.timer);
    }
    ap.runtimeErrorDeliveryBackoff = {
      kind: "backing_off",
      attempts,
      reason,
      untilMs: Date.now() + delayMs,
      timer: null,
    };
    if (ap.inbox.length > 0) {
      this.scheduleRuntimeErrorDeliveryBackoffFlush(agentId, ap);
    }

    this.recordDaemonEvent("daemon.agent.runtime_error_delivery_backoff", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      reason,
      attempts,
      delay_ms: delayMs,
      until_ms: ap.runtimeErrorDeliveryBackoff.untilMs,
      inbox_count: ap.inbox.length,
      pending_notification_count: ap.notifications.pendingCount,
    });
    return true;
  }

  private computeRuntimeErrorDeliveryBackoffDelayMs(attempts: number): number {
    const exponentialDelayMs = this.runtimeErrorDeliveryBackoffBaseMs * (2 ** Math.max(0, attempts - 1));
    const cappedDelayMs = Math.min(this.runtimeErrorDeliveryBackoffMaxMs, exponentialDelayMs);
    const jitterUnit = this.runtimeErrorDeliveryBackoffJitterRandom();
    const boundedJitterUnit = Number.isFinite(jitterUnit) ? Math.max(0, Math.min(1, jitterUnit)) : 0;
    const jitterMs = Math.floor(cappedDelayMs * this.runtimeErrorDeliveryBackoffJitterRatio * boundedJitterUnit);
    return Math.min(this.runtimeErrorDeliveryBackoffMaxMs, cappedDelayMs + jitterMs);
  }

  private cancelRuntimeErrorProcessRestart(agentId: string): void {
    const timer = this.runtimeErrorProcessRestartTimers.get(agentId);
    if (timer) clearClockTimeout(timer);
    this.runtimeErrorProcessRestartTimers.delete(agentId);
  }

  private queueDeliveryForRuntimeErrorBackoff(agentId: string, ap: AgentProcess, message: AgentMessage): boolean {
    const remainingMs = this.runtimeErrorDeliveryBackoffRemainingMs(ap);
    if (remainingMs <= 0) return false;

    const isIdle = this.isApmIdle(ap);
    const queued = queueAgentInboxMessage(ap, message);
    if (!queued.duplicate && !isIdle && ap.driver.supportsStdinNotification && ap.sessionId) {
      ap.notifications.add();
    }
    const scheduled = this.scheduleRuntimeErrorDeliveryBackoffFlush(agentId, ap);
    this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
      outcome: "queued_runtime_error_backoff",
      accepted: true,
      process_present: true,
      runtime: ap.config.runtime,
      session_id_present: Boolean(ap.sessionId),
      launchId: ap.launchId || undefined,
      is_idle: isIdle,
      inbox_count: queued.inboxCount,
      duplicate_pending_delivery: queued.duplicate,
      pending_notification_count: ap.notifications.pendingCount,
      runtime_error_backoff_remaining_ms: remainingMs,
      runtime_error_backoff_attempts: ap.runtimeErrorDeliveryBackoff.attempts,
      runtime_error_backoff_reason: ap.runtimeErrorDeliveryBackoff.reason || undefined,
      runtime_error_backoff_timer_scheduled: scheduled || this.runtimeErrorDeliveryBackoffTimerScheduled(ap),
    }));
    return true;
  }

  private flushRuntimeErrorDeliveryBackoff(agentId: string): boolean {
    const ap = this.agents.get(agentId);
    if (!ap) return false;

    const remainingMs = this.runtimeErrorDeliveryBackoffRemainingMs(ap);
    if (remainingMs > 0) {
      this.scheduleRuntimeErrorDeliveryBackoffFlush(agentId, ap);
      return false;
    }
    if (ap.inbox.length === 0) return false;

    const reason = ap.runtimeErrorDeliveryBackoff.reason || "runtime_error_backoff";
    if (this.isApmIdle(ap) && ap.driver.supportsStdinNotification && ap.sessionId) {
      ap.notifications.pruneContributedToPending(ap.inbox, ap.sessionId);
      const messages = ap.notifications.filterUncontributedMessages(ap.inbox, ap.sessionId);
      ap.notifications.clearPending();
      ap.notifications.clearTimer();
      if (messages.length === 0) {
        this.recordDaemonEvent("daemon.agent.runtime_error_delivery_backoff.flush", {
          agentId,
          runtime: ap.config.runtime,
          model: ap.config.model,
          launchId: ap.launchId || undefined,
          reason,
          mode: "idle",
          outcome: "suppressed_already_contributed",
          inbox_count: ap.inbox.length,
          messages_count: 0,
        });
        return false;
      }
      this.commitApmIdleState(agentId, ap, false);
      this.startRuntimeTrace(agentId, ap, "runtime-error-backoff-idle-delivery", messages);
      const accepted = this.deliverInboxUpdateViaStdin(
        agentId,
        ap,
        messages,
        "idle",
        "runtime_error_backoff_idle_delivery",
      );
      this.recordDaemonEvent("daemon.agent.runtime_error_delivery_backoff.flush", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        reason,
        mode: "idle",
        outcome: accepted ? "written" : "not_written",
        inbox_count: ap.inbox.length,
        messages_count: messages.length,
      });
      return accepted;
    }

    if (!ap.driver.supportsStdinNotification || !ap.sessionId) {
      this.recordDaemonEvent("daemon.agent.runtime_error_delivery_backoff.flush", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        reason,
        outcome: "queued_without_stdin",
        inbox_count: ap.inbox.length,
        session_id_present: Boolean(ap.sessionId),
        supports_stdin_notification: ap.driver.supportsStdinNotification,
      });
      return false;
    }

    if (ap.notifications.pendingCount === 0) {
      ap.notifications.add(ap.inbox.length);
    }
    const accepted = this.sendStdinNotification(agentId);
    this.recordDaemonEvent("daemon.agent.runtime_error_delivery_backoff.flush", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      reason,
      mode: "busy",
      outcome: accepted ? "written" : "not_written",
      inbox_count: ap.inbox.length,
      pending_notification_count: ap.notifications.pendingCount,
    });
    return accepted;
  }

  private allPendingVisibleMessages(agentId: string): AgentMessage[] {
    const collect = (messages: AgentMessage[] | undefined) =>
      (messages ?? []).filter((message) => !runtimeProfileNotificationFromMessage(message) && hasStableLocalMessageId(message));
    return [
      ...collect(this.agents.get(agentId)?.inbox),
      ...collect(this.startingInboxes.values(agentId)),
    ];
  }

  private pendingVisibleMessages(agentId: string, target: string): AgentMessage[] {
    return this.allPendingVisibleMessages(agentId).filter((message) => formatAgentMessageVisibleTarget(message) === target);
  }

  /**
   * Single-inbox consume point for messages that have been rendered into the
   * agent-visible input surface. Daemon pending inbox is only a runner cache:
   * once a message is visible through wake/stdin/check/read/held/preflight, the
   * same seq must not be injected later through the local pending queue.
   */
  private consumeVisibleMessages(
    agentId: string,
    input: { historyScope?: AgentApiHistoryConsumptionScope; target?: string; messages: AgentProxyVisibleMessage[]; boundarySeq?: number; source: string },
  ): void {
    // Model-seen boundary contract: delivery/queue/wake signals are attention
    // signals only. They may populate exact-id suppression for the just-rendered
    // rows, but they must not advance the per-target high-water boundary because
    // sparse delivery of a high-seq @mention does not prove older seqs in that
    // target were consumed. The ledger therefore treats daemon attention
    // sources (`spawn_wake_message`, `stdin_*_delivery`,
    // `agent_api_events_local`, server views, self-authored commits, and
    // future/unknown strings) as exact-id-only unless the source explicitly
    // represents rendered or contiguous full-body content consumption.
    const consumed = this.agentVisibleDelivery.recordConsumed(agentId, input);
    if (!consumed) return;

    const suppress = (messages: AgentMessage[] | undefined): number => {
      if (!messages || messages.length === 0) return 0;
      let removed = 0;
      const retained = messages.filter((message) => {
        const matched = consumed.shouldSuppress(message);
        if (matched) removed += 1;
        return !matched;
      });
      messages.splice(0, messages.length, ...retained);
      return removed;
    };

    const active = this.agents.get(agentId);
    const removedActive = suppress(active?.inbox);
    const removedStarting = this.startingInboxes.suppressConsumed(agentId, consumed.shouldSuppress);
    this.assertStartPendingDeliveryInvariants("visible-consume");
    this.recordDaemonEvent("daemon.agent.inbox.visible_consumed", {
      agentId,
      source: input.source,
      targets: consumed.targets,
      messages_count: consumed.messagesCount,
      suppressed_pending_count: removedActive + removedStarting,
    });
  }

  purgeInboxMessagesForChannels(agentId: string, channelIds: readonly string[], reason = "server_purge"): { removedCount: number } {
    const channelIdSet = new Set(channelIds.filter((id) => typeof id === "string" && id.length > 0));
    if (channelIdSet.size === 0) return { removedCount: 0 };

    const purge = (messages: AgentMessage[] | undefined): number => {
      if (!messages || messages.length === 0) return 0;
      let removed = 0;
      const retained = messages.filter((message) => {
        const shouldRemove = channelIdSet.has(message.channel_id);
        if (shouldRemove) removed += 1;
        return !shouldRemove;
      });
      if (removed > 0) {
        messages.splice(0, messages.length, ...retained);
      }
      return removed;
    };

    const active = this.agents.get(agentId);
    const removedActive = purge(active?.inbox);
    const removedStarting = this.startingInboxes.purge(agentId, (message) => channelIdSet.has(message.channel_id));
    this.assertStartPendingDeliveryInvariants("purge-starting-inbox");
    if (active && removedActive > 0) {
      active.notifications.remove(removedActive);
      if (active.inbox.length === 0) {
        active.notifications.clear();
        this.clearRuntimeErrorDeliveryBackoff(active);
      }
    }
    const removedCount = removedActive + removedStarting;
    this.recordDaemonEvent("daemon.agent.inbox.purged", {
      agentId,
      reason,
      channel_count: channelIdSet.size,
      removed_active_count: removedActive,
      removed_starting_count: removedStarting,
      removed_count: removedCount,
      active_inbox_count: active?.inbox.length ?? 0,
      starting_inbox_count: this.startingInboxes.count(agentId),
    });
    return { removedCount };
  }

  private createAgentProxyInboxCoordinator(agentId: string): AgentProxyInboxCoordinator {
    return buildAgentProxyInboxCoordinator({
      agentId,
      serverUrl: this.serverUrl,
      daemonApiKey: this.daemonApiKey,
      fetchImpl: this.fetchImpl,
      getBoundary: (target) => this.getVisibleBoundary(agentId, target),
      getPendingMessages: (target) => this.pendingVisibleMessages(agentId, target),
      isMessageModelSeen: ({ target, message }) => this.isVisibleMessageModelSeen(agentId, target, message),
      getExactSeenSeqs: (target) => this.agentVisibleDelivery.getExactSeenSeqs(agentId, target),
      getAllPendingMessages: () => this.allPendingVisibleMessages(agentId),
      consumeVisibleMessages: (input) => this.consumeVisibleMessages(agentId, input),
      recordTrace: (name, attrs, status) => this.recordDaemonEvent(name, attrs, status),
      recordFreshnessDecisionActivity: (input, producerFactId) => {
        this.recordFreshnessDecisionActivity(agentId, input, producerFactId);
      },
    });
  }

  private recordFreshnessDecisionActivity(agentId: string, input: AgentProxyFreshnessDecision, producerFactId: string): void {
    if (input.freshnessContextMode === "withheld" || (input.decision !== "local_hold" && input.decision !== "syncing_hold")) return;
    const ap = this.agents.get(agentId);
    const messageCount = input.decision === "syncing_hold"
      ? input.heldMessageCount ?? input.pendingCount ?? 0
      : input.pendingCount ?? input.heldMessageCount ?? 0;
    const activity = projectApmHeldFreshnessActivity({
      producerFactId,
      action: input.action,
      decision: input.decision,
      target: input.target,
      messageCount,
    });

    this.activitySink.send({
      agentId,
      activityKind: activity.statusEntry.activity,
      detail: activity.statusEntry.detail,
      detailKind: activity.statusEntry.detailKind,
      entries: activity.entries,
      launchId: ap?.launchId || undefined,
      clientSeq: ap ? this.activitySink.nextClientSeq(agentId) : undefined,
      isHeartbeat: false,
    });
  }

  private recordRuntimeDiagnosticActivity(agentId: string, ap: AgentProcess, event: RuntimeDiagnosticEvent): void {
    this.activitySink.send({
      agentId,
      activityKind: ap.lastActivityKind || "online",
      detail: ap.lastActivityDetail || "",
      detailKind: ap.lastActivityDetailKind,
      entries: [runtimeDiagnosticTrajectoryEntry(event)],
      launchId: ap.launchId || undefined,
      clientSeq: this.activitySink.nextClientSeq(agentId),
      isHeartbeat: false,
    });
    this.recordDaemonEvent("daemon.runtime.diagnostic", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      ...runtimeDiagnosticTraceAttrs(event),
    });
  }

  // Project bounded Working liveness without raw content or subagent state.
  private maybeBroadcastRuntimeProgressActivity(
    agentId: string,
    ap: AgentProcess,
    event: Extract<ParsedEvent, { kind: "internal_progress" }>,
  ): void {
    // Transport progress cannot cross a terminal APM idle boundary.
    if (this.isApmIdle(ap)) {
      this.recordDaemonEvent("daemon.runtime.progress.activity.suppressed", {
        agentId,
        launchId: ap.launchId || undefined,
        runtime: ap.config.runtime,
        outcome: "apm_idle",
        source: event.source,
        itemType: event.itemType,
        payloadBytes: event.payloadBytes,
      });
      return;
    }

    // Preserve richer live activity and transition into generic Working once.
    const alreadyLive = ap.lastActivityKind === "working" || ap.lastActivityKind === "thinking";
    if (alreadyLive) return;
    this.broadcastActivity(agentId, "working", "Working", [], undefined, "runtime_progress");
  }

  private recordSubagentProgressActivity(agentId: string, ap: AgentProcess, event: SubagentProgressEvent): void {
    this.flushPendingTrajectory(agentId);
    this.broadcastActivity(
      agentId,
      "working",
      subagentProgressDetail(event),
      [],
      undefined,
      "subagent_activity",
      "working",
      subagentLineageFromEvent(event),
    );
    this.recordDaemonEvent("daemon.runtime.subagent.progress", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      ...subagentProgressTraceAttrs(event),
    });
  }

  private recordRuntimeRecoveryActivity(agentId: string, ap: AgentProcess, event: RuntimeRecoveryEvent): void {
    this.activitySink.send({
      agentId,
      activityKind: ap.lastActivityKind || "online",
      detail: ap.lastActivityDetail || "",
      detailKind: ap.lastActivityDetailKind,
      entries: [runtimeRecoveryTrajectoryEntry(event)],
      launchId: ap.launchId || undefined,
      clientSeq: this.activitySink.nextClientSeq(agentId),
      isHeartbeat: false,
    });
    this.recordDaemonEvent("daemon.runtime.recovery.visible", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      ...runtimeRecoveryTraceAttrs(event),
    });
  }

  // Records a point in time fact as a trace event. The event attaches to the
  // given parent, or to the span that is active right now.
  private recordDaemonEvent(
    name: string,
    attrs?: Record<string, unknown>,
    status: "ok" | "error" | "cancelled" = "ok",
    parentTraceparent?: string | null,
  ): void {
    // Daemon events historically spell the agent identity in camelCase
    // (`agentId`), while the trace backend promotes and groups by `agent_id`.
    // Emit both so per-agent delivery/start counts are queryable. Only
    // `agentId` is canonicalized here: `agent_id` is `span_or_event` in the
    // shared field registry, whereas `launch_id` / `session_id` / `server_id` /
    // `machine_id` are span-only there and must not be added to events.
    this.tracer.emitEvent(name, {
      parent: parseTraceparent(parentTraceparent) ?? getActiveTraceContext(),
      surface: "daemon",
      attrs: { ...withCanonicalTraceAttributes(attrs ?? {}, { keys: DAEMON_EVENT_CANONICAL_ALIAS_KEYS }), status },
    });
  }

  private emitNoProcessResidencyRows(rows: readonly AgentNoProcessResidencyTransitionRow[]): void {
    for (const row of rows) {
      this.recordDaemonEvent("launch_residency_transition", row);
    }
  }

  private noProcessResidencyIdentity(
    agentId: string,
    config: AgentConfig,
    launchId: string | null | undefined,
    launchSource: string,
    driverId?: string,
  ): AgentNoProcessResidencyTransitionIdentity {
    const runtimeContext = config.runtimeContext;
    const agentLaunchIdPresent = typeof launchId === "string" && launchId.length > 0;
    return {
      agentId,
      agentLaunchId: agentLaunchIdPresent ? launchId : "missing_launch_id",
      agentLaunchIdPresent,
      serverId: runtimeContext?.serverId || "unknown_server",
      machineId: runtimeContext?.machineId || "unknown_machine",
      runtime: config.runtime || "unknown_runtime",
      driver: driverId || this.driverResolver(config.runtime || "claude").id,
      launchSource,
    };
  }

  private enterNoProcessResidency(
    state: AgentNoProcessResidencyState,
    identity: AgentNoProcessResidencyTransitionIdentity,
    opts: Omit<AgentNoProcessResidencyEnterInput, keyof AgentNoProcessResidencyTransitionIdentity | "state">,
  ): void {
    const launchEvidence = identity.agentLaunchIdPresent
      ? {}
      : {
          failureKind: opts.failureKind ?? "missing_launch_id",
          negativeEvidenceBucket: opts.negativeEvidenceBucket ?? "missing_launch_id",
        };
    this.emitNoProcessResidencyRows(this.noProcessResidencyTransitions.enter({
      ...identity,
      state,
      ...opts,
      ...launchEvidence,
    }));
  }

  private closeNoProcessResidency(
    agentId: string,
    closeResult: AgentNoProcessResidencyCloseResult,
    opts: { failureKind?: string; negativeEvidenceBucket?: string } = {},
  ): void {
    this.emitNoProcessResidencyRows(this.noProcessResidencyTransitions.close(agentId, {
      closeResult,
      failureKind: opts.failureKind,
      negativeEvidenceBucket: opts.negativeEvidenceBucket,
    }));
  }

  private startLaunchSource(config: AgentConfig, wakeMessage?: AgentMessage, resumePrompt?: string): string {
    if (config.runtimeProfileControl && !wakeMessage) return "runtime_profile";
    if (config.sessionId || resumePrompt) return "session_resume";
    if (wakeMessage) return "wake_message";
    return "explicit_start";
  }

  private enterSpawnFailCooldownResidency(
    agentId: string,
    cached: { config: AgentConfig; launchId: string | null },
    untilMs: number,
    source: string,
    reason: string,
  ): void {
    if (untilMs <= this.clockNow()) return;
    this.enterNoProcessResidency(
      "spawn_fail_cooldown",
      this.noProcessResidencyIdentity(agentId, cached.config, cached.launchId, source),
      {
        isWaitState: true,
        fenceKind: "spawn_fail_backoff",
        deadlineUnixMs: untilMs,
        failureKind: reason,
        negativeEvidenceBucket: reason,
      },
    );
  }

  private processLifecycleIdentityAttrs(agentId: string, ap: AgentProcess): Record<string, unknown> {
    const runtimeContext = ap.config.runtimeContext;
    return {
      agent_id: agentId,
      server_id: runtimeContext?.serverId,
      machine_id: runtimeContext?.machineId,
      launch_id: ap.launchId || undefined,
      start_dispatch_id: ap.startDispatchId || undefined,
      process_instance_id: ap.processInstanceId,
      session_id: ap.sessionId || undefined,
      session_id_present: Boolean(ap.sessionId),
      runtime: ap.config.runtime,
      runtime_version: runtimeContext?.daemonVersion,
      pid: typeof ap.runtime.pid === "number" ? ap.runtime.pid : undefined,
    };
  }

  private runtimeLaunchPolicyTraceAttrs(config: AgentConfig): Record<string, unknown> {
    if (config.runtime !== "claude") return {};
    const customProvider = isClaudeCustomProviderConfig(config);
    if (!customProvider) {
      return {
        claude_custom_provider: false,
      };
    }
    return {
      claude_custom_provider: true,
      claude_custom_provider_settings_sources_policy: "project,local",
      claude_custom_provider_inherited_provider_scrub: true,
      claude_custom_provider_host_managed_flag: false,
      claude_custom_provider_home_override: false,
      claude_custom_provider_config_dir_override: false,
    };
  }

  private getDeliveryTraceContext(message: AgentMessage): DeliveryTraceContext {
    return this.deliveryTraceContexts.get(message) ?? {};
  }

  /** Invariant (task #353): a queued delivery the runtime never consumed is
   * carried into the next start by the daemon, or left unread on the Server
   * for its catch-up at the next start, and every close that does not carry it
   * in the daemon says so here. `expected` marks paths that rely on the Server
   * by design (stop, cold-idle recycle, deferred notices); the rest lose the
   * wake until something else starts the agent, so they log a warning. */
  private recordInboxDroppedOnExit(agentId: string, ap: AgentProcess, exitPath: string, messages: AgentMessage[]): void {
    const dropped = messages.filter((message) => !this.isTransientDelivery(message));
    if (dropped.length === 0) return;
    const expected = EXPECTED_SERVER_CARRIED_EXIT_PATHS.has(exitPath);
    const line = `[Agent ${agentId}] Runtime closed via ${exitPath} with ${dropped.length} unconsumed queued message(s); not carried by the daemon, they stay unread on the server`;
    if (expected) logger.info(line);
    else logger.warn(line);
    this.recordDaemonEvent("daemon.agent.inbox.dropped_on_exit", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      // `exit_reason`, not `exit_path`: the local trace sink drops any key
      // containing a `path` segment, so `exit_path` never reached disk.
      exit_reason: exitPath,
      dropped_count: dropped.length,
      expected,
    }, expected ? "ok" : "error");
  }

  private isTransientDelivery(message: AgentMessage): boolean {
    return this.getDeliveryTraceContext(message).transient === true;
  }

  private deliveryTraceAttrs(agentId: string, message: AgentMessage, attrs: Record<string, unknown> = {}): Record<string, unknown> {
    const context = this.getDeliveryTraceContext(message);
    const deliveryCorrelationId = context.deliveryId ?? message.message_id;
    return {
      agentId,
      deliveryId: context.deliveryId,
      delivery_correlation_id: deliveryCorrelationId,
      channel_type: message.channel_type,
      sender_type: message.sender_type,
      messageId: message.message_id,
      message_id_present: Boolean(message.message_id),
      transient_delivery: context.transient === true,
      ...attrs,
    };
  }

  private recordStartRebind(agentId: string, start: PendingStartRebind, reason: string, previousLaunchId: string | null, nextLaunchId: string | null, sessionId: string | null): void {
    this.recordDaemonEvent("daemon.agent.start.rebound", {
      ...this.agentStartDispatch.traceAttrs(
        agentId,
        start.config,
        start.wakeMessage,
        start.unreadSummary,
        start.resumePrompt,
        start.launchId,
        start.wakeMessageTransient ?? false,
      ),
      reason,
      previous_launch_id_present: Boolean(previousLaunchId),
      next_launch_id_present: Boolean(nextLaunchId),
      session_id_present: Boolean(sessionId),
    });
  }

  private initialAgentProcessSessionId(driver: RuntimeDriver, config: AgentConfig): string | null {
    if (driver.requiresSessionInitForDelivery) return null;
    return config.sessionId || null;
  }

  private initialSessionReadyForDelivery(driver: RuntimeDriver, config: AgentConfig, sessionId: string | null): boolean {
    if (!sessionId) return false;
    // A configured resume target already names an existing runtime conversation.
    if (config.sessionId && config.sessionId === sessionId) return true;
    return driver.liveSessionReadyAt !== "turn_end";
  }

  private markSessionReadyForDelivery(ap: AgentProcess, source: "session_init" | "turn_end"): void {
    if (ap.sessionId && (source === "turn_end" || ap.driver.liveSessionReadyAt !== "turn_end")) {
      ap.sessionReadyForDelivery = true;
    }
  }

  private canDeliverToRuntimeSession(ap: AgentProcess): boolean {
    return Boolean(ap.sessionId && ap.sessionReadyForDelivery);
  }

  private restartSafeSessionId(ap: AgentProcess): string | null {
    return ap.sessionId || (ap.driver.requiresSessionInitForDelivery ? ap.config.sessionId || null : null);
  }

  private sameWakeMessage(left: AgentMessage | undefined, right: AgentMessage | undefined): boolean {
    if (!left || !right) return left === right;
    if (left.message_id && right.message_id) return left.message_id === right.message_id;
    return left === right;
  }

  private rebindQueuedStart(agentId: string, start: PendingStartRebind, reason: string): boolean {
    const item = this.agentStarts.getQueued(agentId);
    if (!item) {
      return false;
    }

    const previousLaunchId = item.launchId || null;
    const nextLaunchId = start.launchId || previousLaunchId;
    const previousWakeMessage = item.wakeMessage;
    this.startingInboxes.rebindWake(
      agentId,
      previousWakeMessage,
      start.wakeMessage,
      (left, right) => this.sameWakeMessage(left, right),
    );
    this.assertStartPendingDeliveryInvariants("rebind-queued-start");

    item.config = start.config;
    item.unreadSummary = start.unreadSummary;
    item.resumePrompt = start.resumePrompt;
    item.launchId = nextLaunchId || undefined;
    // RFC 071: a recovery grant stays with the launch it is bound to; the
    // queued start keeps one only while it still carries that launch.
    const recoveryGrant = start.recoveryGrant ?? item.recoveryGrant ?? null;
    item.recoveryGrant = recoveryGrant && recoveryGrant.launchId === nextLaunchId ? recoveryGrant : null;
    item.startDispatchId = start.startDispatchId ?? item.startDispatchId;
    if (start.wakeMessage) {
      item.wakeMessage = start.wakeMessage;
      item.wakeMessageTransient = start.wakeMessageTransient;
    }

    this.recordStartRebind(
      agentId,
      { ...start, launchId: nextLaunchId || undefined },
      reason,
      previousLaunchId,
      nextLaunchId,
      null,
    );
    return true;
  }

  private rebindRunningStart(agentId: string, start: PendingStartRebind, reason: string): boolean {
    const ap = this.agents.get(agentId);
    if (!ap) {
      this.lifecycleRecords.setPendingStartRebind(agentId, {
        ...start,
        stopEpochAtRebind: this.lifecycleRecords.stopEpoch(agentId),
      });
      return false;
    }
    // RFC 071 outbox: the automatic-start rule decides the reuse (only the
    // admitted human start this is passes on its own grant), and the reused
    // process must be durably open before it carries this launch.
    const rebindRefusal = this.runtimeProcessGate && this.daemonInstanceId
      ? this.runtimeProcessGate.startRefusal(agentId, start.launchId || null, start.recoveryGrant ?? null)
      : null;
    if (rebindRefusal !== null) {
      this.refuseRunningRebind(agentId, start, rebindRefusal.reason, rebindRefusal.detail);
      return false;
    }
    if (this.runtimeProcessGate && this.daemonInstanceId
      && !this.runtimeProcessGate.openProcess(agentId, ap.processInstanceId, ap.launchId || start.launchId || null)) {
      this.refuseRunningRebind(agentId, start, "terminal_failure_outcome_storage_blocked", "Start rebind refused: runtime outcome storage failed");
      return false;
    }

    const previousLaunchId = ap.launchId;
    const nextLaunchId = start.launchId || ap.launchId || null;
    const requiresSessionInit = ap.driver.requiresSessionInitForDelivery === true;
    const nextSessionId = ap.sessionId || (requiresSessionInit ? null : start.config.sessionId || null);
    const nextSessionReadyForDelivery = nextSessionId
      ? (nextSessionId === ap.sessionId ? ap.sessionReadyForDelivery : this.initialSessionReadyForDelivery(ap.driver, start.config, nextSessionId))
      : false;
    const nextConfigSessionId = nextSessionId || (
      requiresSessionInit
        ? start.config.sessionId || null
        : ap.config.sessionId || start.config.sessionId || null
    );
    this.runtimeProcessBindingFence.rebindLaunch(agentId, ap, nextLaunchId);
    this.runtimeProcessBindingFence.rebindSession(agentId, ap, nextSessionId, "server_start_rebind");
    ap.launchId = nextLaunchId;
    ap.startDispatchId = start.startDispatchId ?? ap.startDispatchId;
    ap.sessionId = nextSessionId;
    ap.sessionReadyForDelivery = nextSessionReadyForDelivery;
    const { agentCredentialKey, agentCredentialId } = ap.config;
    ap.config = { ...stripManagedRunnerCredential(start.config), sessionId: nextConfigSessionId, agentCredentialKey, agentCredentialId };
    this.lifecycleRecords.setRestartSnapshot(agentId, {
      config: this.buildRestartSafeConfig(ap.config, nextConfigSessionId),
      sessionId: nextConfigSessionId,
      launchId: nextLaunchId,
      processInstanceId: ap.processInstanceId,
    });

    this.recordStartRebind(agentId, start, reason, previousLaunchId, nextLaunchId, nextSessionId);
    // RFC 071: this launch is carried by the registered process.
    if (start.launchId) this.settleLaunches(agentId, [start.launchId], { kind: "rebound", processInstanceId: ap.processInstanceId });

    this.sendAgentStatus(agentId, "active", nextLaunchId);
    if (nextSessionId) {
      this.sendToServer({ type: "agent:session", agentId, sessionId: nextSessionId, launchId: nextLaunchId || undefined });
    }
    if (start.wakeMessage) {
      const accepted = this.deliverMessage(agentId, start.wakeMessage, { transient: start.wakeMessageTransient === true });
      if (accepted instanceof Promise) {
        accepted.catch((err) => {
          logger.error(`[Agent ${agentId}] Failed to deliver wake message after start rebind`, err);
          this.recordDaemonEvent("daemon.agent.wake_delivery_failed", {
            agentId,
            outcome: "error",
            reason: "wake_delivery_threw",
            error_class: errorClassOf(err),
          }, "error");
        });
      }
    }

    return true;
  }

  /**
   * RFC 071 outbox: the rebind gate refused to let the running process carry
   * this start. The process keeps running as it was (the refusal does not
   * stop it); the start's launch gets its refusal, and its wake message is
   * not lost: it is delivered like any message to the running process.
   */
  private refuseRunningRebind(
    agentId: string,
    start: PendingStartRebind,
    reason: "terminal_failure_needs_manual" | "terminal_failure_outcome_storage_blocked",
    detail: string,
  ): void {
    logger.warn(`[Agent ${agentId}] ${detail}`);
    this.recordDaemonEvent("daemon.agent.start.refused", {
      agentId,
      launchId: start.launchId,
      stage: "rebind",
      reason,
      refusal_detail: detail,
    }, "error");
    if (start.launchId) this.settleLaunches(agentId, [start.launchId], { kind: "not_spawned", reason });
    if (start.wakeMessage) this.keepRefusedWakeMessage(agentId, start.wakeMessage, start.wakeMessageTransient === true);
  }

  private keepRefusedWakeMessage(agentId: string, message: AgentMessage, transient: boolean): void {
    const accepted = this.deliverMessage(agentId, message, { transient });
    if (accepted instanceof Promise) {
      accepted.catch((err) => {
        logger.error(`[Agent ${agentId}] Failed to deliver the wake message of a refused start`, err);
        this.recordDaemonEvent("daemon.agent.wake_delivery_failed", {
          agentId,
          outcome: "error",
          reason: "refused_start_wake_delivery_threw",
          error_class: errorClassOf(err),
        }, "error");
      });
    }
  }

  /**
   * RFC 071 outbox: the spawn gate refused a start under the automatic-start
   * rule (the agent is unreliable, or has an un-acked gap / cross marker no
   * persisted human takeover covers). Nothing is spawned. The agent takes the existing no-process
   * refusal state (terminal failure record, as a terminal runtime error
   * does): its start-pending messages are kept, the wake message of this
   * start and of a deferred rebind are added to them, later deliveries are
   * kept the same way and no automatic restart is attempted; the reason
   * (`detail`, with the way out) is logged, traced and shown. A human start
   * (a server `agent:start` with `humanStart`) is the way out.
   */
  private refuseUnreliableSpawn(
    agentId: string,
    start: { config: AgentConfig; wakeMessage?: AgentMessage; wakeMessageTransient: boolean; launchId?: string; startDispatchId?: string },
    detail: string,
    spawnTraceparent: string,
    reason: "terminal_failure_needs_manual" | "terminal_failure_outcome_storage_blocked" = "terminal_failure_needs_manual",
  ): void {
    const pending = this.lifecycleRecords.getPendingStartRebind(agentId);
    this.lifecycleRecords.deletePendingStartRebind(agentId);
    this.lifecycleRecords.deletePendingSpawnCause(agentId);
    const kept: AgentMessage[] = [];
    for (const candidate of [
      { message: start.wakeMessage, transient: start.wakeMessageTransient },
      { message: pending?.wakeMessage, transient: pending?.wakeMessageTransient === true },
    ]) {
      if (!candidate.message || candidate.transient) continue;
      if (kept.some((message) => this.sameWakeMessage(message, candidate.message))) continue;
      if (this.startingInboxes.values(agentId).some((message) => this.sameWakeMessage(message, candidate.message))) continue;
      kept.push(candidate.message);
    }
    const launchId = pending?.launchId || start.launchId || null;
    // Every accepted server launch still waiting gets its result, with the
    // refusal's own reason (storage_blocked and needs_manual clear differently).
    this.settleAllAcceptedLaunches(agentId, reason);
    this.cancelRuntimeErrorProcessRestart(agentId);
    this.lifecycleRecords.setTerminalFailure(agentId, { detail, launchId });
    if (kept.length > 0) this.startingInboxes.bufferMessagesDuringStart(agentId, kept);
    this.closeNoProcessResidency(agentId, "terminal", { negativeEvidenceBucket: "runtime_outcome_unreliable" });
    this.enterNoProcessResidency(
      "terminal_runtime_error",
      this.noProcessResidencyIdentity(agentId, pending?.config ?? start.config, launchId, "terminal_runtime_error"),
      {
        isWaitState: false,
        failureKind: "runtime_outcome_unreliable",
        negativeEvidenceBucket: "runtime_outcome_unreliable",
      },
    );
    this.assertStartPendingDeliveryInvariants("unreliable-start-refused");
    logger.warn(`[Agent ${agentId}] Start refused, nothing spawned: ${detail}`);
    this.recordDaemonEvent("daemon.agent.start.refused", {
      agentId,
      launchId: launchId || undefined,
      start_dispatch_id: start.startDispatchId,
      stage: "spawn",
      reason: "runtime_outcome_unreliable",
      refusal_detail: detail,
      kept_message_count: this.startingInboxes.count(agentId),
    }, "error", spawnTraceparent);
    this.sendAgentStatus(agentId, "inactive", launchId);
    this.broadcastActivity(agentId, "error", detail, [], launchId, "runtime_error");
  }

  /**
   * RFC 071: DaemonCore accepted a server `agent:start` for this launch. The
   * launch now owes exactly one final result: named in `process_spawned`
   * (its own launch or `supersededLaunchIds`), `rebound` onto a running
   * process, or `not_spawned` with a reason. Internal restarts never call this.
   */
  noteServerStartAccepted(agentId: string, launchId: string | undefined): boolean {
    if (!launchId) return true;
    const pending = this.acceptedLaunches.get(agentId) ?? [];
    if (pending.includes(launchId)) return true;
    // Bounded admission: never drop an accepted launch. When the agent already
    // has the maximum number of launches waiting for a result, this start is
    // refused before acceptance and gets its own correlated final result.
    if (pending.length >= ACCEPTED_LAUNCHES_PER_AGENT_MAX) {
      if (this.daemonInstanceId) {
        this.sendToServer({
          type: "agent:start:outcome",
          agentId,
          daemonInstanceId: this.daemonInstanceId,
          launchId,
          clientSeq: this.activitySink.nextClientSeq(agentId),
          result: { kind: "not_spawned", reason: "admission_full" },
        });
      }
      return false;
    }
    pending.push(launchId);
    this.acceptedLaunches.set(agentId, pending);
    return true;
  }

  /**
   * RFC 071: a start DaemonCore failed on its own (before or around the
   * process manager). Settles the launch `not_spawned` only if it is still
   * waiting for a result; a launch the process manager already settled
   * (spawned, rebound, or failed with its own reason) is left alone.
   */
  settleServerStartNotSpawned(agentId: string, launchId: string | undefined, reason: AgentStartNotSpawnedReason): void {
    if (!launchId || !this.acceptedLaunches.get(agentId)?.includes(launchId)) return;
    this.settleLaunches(agentId, [launchId], { kind: "not_spawned", reason });
  }

  getAgentStartAcceptance(agentId: string): AgentStartAcceptance {
    const acceptance = this.agentStartDispatch.acceptance(agentId, this.agents.has(agentId));
    // RFC 071 §4.3 rule 2: a rebind names the registered process that now
    // carries the launch. A queued/starting start has no process yet; its id
    // is minted after the spawn and sent on agent:process_spawned.
    if (acceptance.queueState !== "running" && acceptance.queueState !== "rebound") return acceptance;
    const registered = this.agents.get(agentId);
    return registered ? { ...acceptance, processInstanceId: registered.processInstanceId } : acceptance;
  }

  /**
   * Wake an Agent because its Computer-local typed Inbox gained an app item.
   * This is deliberately not an AgentMessage: no channel/message/sender
   * identity is fabricated and no Server delivery cursor is touched.
   */
  async notifyAgentAppInbox(
    agentId: string,
    item: AgentInboxAppItem,
    noticeOptions?: AgentAppInboxNoticeOptions,
  ): Promise<boolean> {
    const traceAttrs = appInboxItemTraceAttrs(agentId, item);
    const appItems = this.#appInboxForAgent?.(agentId).list() ?? [];
    this.pruneAppInboxNoticeMemo(agentId, appItems);
    const count = appItems.length;
    const recordNotice = (
      outcome: string,
      status: "ok" | "error",
      mode?: "idle" | "busy",
    ) => this.recordDaemonEvent("daemon.agent.app_inbox_notice", {
      ...traceAttrs,
      outcome,
      ...(mode ? { mode } : {}),
      pending_app_items: count,
      message_identity_created: false,
    }, status);
    if (count === 0) {
      recordNotice("empty", "error");
      return false;
    }
    const undelivered = this.undeliveredAppInboxItems(agentId, appItems);
    if (undelivered.length === 0) {
      recordNotice("already_delivered", "ok");
      return true;
    }
    const notice = appInboxNoticeText(count);
    const ap = this.agents.get(agentId);
    if (ap && this.canDeliverToRuntimeSession(ap)) {
      const idle = this.isApmIdle(ap);
      const mode = idle ? "idle" : "busy";
      if ((idle && !ap.driver.supportsStdinNotification) || (!idle && ap.runtime.descriptor.busyDelivery !== "direct")) {
        if (ap.driver.lifecycle.kind === "per_turn") {
          const wake = noticeOptions?.startStoppedAgent !== false
            || this.appInboxNoticesAfterTurn.get(agentId)?.wake === true;
          this.appInboxNoticesAfterTurn.set(agentId, { wake });
          recordNotice("deferred_until_turn_exit", "ok", mode);
          return true;
        }
        recordNotice("unsupported_delivery", "error", mode);
        return false;
      }
      if (idle) this.commitApmIdleState(agentId, ap, false);
      const result = this.runtimeProcessBindingFence.send(
        agentId,
        ap,
        { mode, text: notice, sessionId: ap.sessionId },
        "app_inbox_notice",
      );
      recordNotice(result.ok ? "written" : "write_failed", result.ok ? "ok" : "error", mode);
      if (result.ok) {
        this.markAppInboxNoticeDelivered(agentId, appItems);
        this.observeDeliveryWrite(agentId, ap, item.itemId, "app_inbox_notice");
      }
      return result.ok;
    }

    if (noticeOptions?.startStoppedAgent === false) {
      // Advisory item: it stays in the Inbox and the next ordinary wake
      // surfaces it. Not marked delivered, so that wake still notices it.
      recordNotice("advisory_not_running", "ok");
      return true;
    }
    const lifecycleRecord = this.agentLifecycleRecord(agentId);
    if (lifecycleRecord === undefined || lifecycleRecord.kind === "terminal") {
      // No process and no restart snapshot: every idle agent is in this state
      // after a daemon restart or upgrade. The Server owns the config, so the
      // wake is its decision (task #1103); nothing is retried locally.
      return this.requestServerWake(agentId, item, count, recordNotice);
    }
    if (lifecycleRecord.kind !== "idle") {
      recordNotice("not_idle", "error");
      return false;
    }
    const cached = lifecycleRecord.restartSnapshot;
    this.lifecycleRecords.deleteRestartSnapshot(agentId);
    try {
      // The new process outlives this notice flow, so its later events must
      // not inherit the span that triggered the restart.
      await runWithoutActiveSpan(() => this.startAgent(
        agentId,
        cached.config,
        undefined,
        undefined,
        notice,
        cached.launchId || undefined,
      ));
      recordNotice("restart_requested", "ok", "idle");
      this.markAppInboxNoticeDelivered(agentId, appItems);
      return true;
    } catch (error) {
      this.lifecycleRecords.setRestartSnapshot(agentId, cached);
      logger.error(`[Agent ${agentId}] Failed to restart for app Inbox notice`, error);
      recordNotice("restart_failed", "error", "idle");
      return false;
    }
  }

  /**
   * A per_turn process exited with a deferred, waking app notice: deliver it
   * now through the no-process path, which restarts the agent with it.
   */
  private wakeForAppInboxNoticeAfterTurn(agentId: string): void {
    if (this.appInboxNoticesAfterTurn.get(agentId)?.wake !== true) return;
    let appItems: readonly AgentInboxAppItem[];
    try {
      appItems = this.#appInboxForAgent?.(agentId).list() ?? [];
    } catch (error) {
      // Runs inside process-exit handling: a store failure must not escape.
      // The deferral is kept, so the next start still carries the notice.
      this.recordAppInboxUnavailable(agentId, "turn_exit_wake", error);
      return;
    }
    const pending = this.undeliveredAppInboxItems(agentId, appItems);
    if (pending.length === 0) {
      this.appInboxNoticesAfterTurn.delete(agentId);
      return;
    }
    this.appInboxNoticesAfterTurn.delete(agentId);
    void this.notifyAgentAppInbox(agentId, pending[0]!).catch((error) => {
      logger.error(`[Agent ${agentId}] Failed to wake for a deferred App Inbox notice`, error);
    });
  }

  /**
   * The deferred app notice for a per_turn start's first input, or null. A
   * store failure never fails the start: the deferral is kept for a later one.
   */
  private takeAppInboxNoticeForStartInput(agentId: string): AxSurfaceText | null {
    if (!this.appInboxNoticesAfterTurn.has(agentId)) return null;
    let appItems: readonly AgentInboxAppItem[];
    try {
      appItems = this.#appInboxForAgent?.(agentId).list() ?? [];
    } catch (error) {
      this.recordAppInboxUnavailable(agentId, "start_input", error);
      return null;
    }
    this.appInboxNoticesAfterTurn.delete(agentId);
    const pending = this.undeliveredAppInboxItems(agentId, appItems);
    if (pending.length === 0) return null;
    this.markAppInboxNoticeDelivered(agentId, appItems);
    this.recordDaemonEvent("daemon.agent.app_inbox_notice", {
      ...appInboxItemTraceAttrs(agentId, pending[0]!),
      outcome: "carried_in_start_input",
      pending_app_items: appItems.length,
      message_identity_created: false,
    });
    return formatAppInboxNoticeSuffix(appItems.length);
  }

  private recordAppInboxUnavailable(agentId: string, route: "turn_exit_wake" | "start_input", error: unknown): void {
    logger.error(`[Agent ${agentId}] App Inbox unavailable for a deferred notice (${route})`, error);
    this.recordDaemonEvent("daemon.agent.app_inbox_notice", {
      owner_agent_id_present: true,
      outcome: "app_inbox_unavailable",
      route,
      message_identity_created: false,
      error_class: errorClassOf(error),
    }, "error");
  }

  private requestServerWake(
    agentId: string,
    item: AgentInboxAppItem,
    pendingAppItems: number,
    recordNotice: (outcome: string, status: "ok" | "error") => void,
  ): boolean {
    const existing = this.pendingServerWakes.get(agentId);
    if (existing && existing.itemId === item.itemId) {
      // Duplicate fire while the Server has not answered yet: the parked
      // request already carries this exact item and id.
      recordNotice("server_wake_pending", "ok");
      return true;
    }
    const pending: PendingServerWake = {
      wakeRequestId: serverWakeRequestId(agentId, item.itemId),
      itemId: item.itemId,
      appId: item.appId,
      sourceRef: {
        kind: item.sourceRef.kind,
        id: item.sourceRef.id,
        ...(item.sourceRef.revision !== undefined ? { revision: item.sourceRef.revision } : {}),
      },
      pendingAppItems,
      requestedAtMs: this.clockNow(),
    };
    const activeContext = getActiveTraceContext();
    if (activeContext) pending.traceparent = formatTraceparent(activeContext);
    this.pendingServerWakes.set(agentId, pending);
    if (!this.serverConnected()) {
      // Parked, not dropped: handleConnect resends it once. No local timer.
      recordNotice("server_wake_queued_offline", "ok");
      return true;
    }
    this.sendToServer(this.serverWakeRequestMessage(agentId, pending));
    recordNotice("server_wake_requested", "ok");
    return true;
  }

  private serverWakeRequestMessage(
    agentId: string,
    pending: PendingServerWake,
  ): Extract<MachineToServerMessage, { type: "agent:wake:request" }> {
    return {
      type: "agent:wake:request",
      agentId,
      wakeRequestId: pending.wakeRequestId,
      reason: "app_inbox_notice",
      appId: pending.appId,
      sourceRef: pending.sourceRef,
      pendingAppItems: pending.pendingAppItems,
      ...(pending.traceparent ? { traceparent: pending.traceparent } : {}),
    };
  }

  /** Resend every parked server wake once; called on each connect edge. */
  resendPendingServerWakes(): void {
    for (const [agentId, pending] of this.pendingServerWakes) {
      this.sendToServer(this.serverWakeRequestMessage(agentId, pending));
      this.recordDaemonEvent("daemon.agent.server_wake.resent", {
        agent_id: agentId,
        wake_request_id: pending.wakeRequestId,
        item_id: pending.itemId,
        requested_at_ms: pending.requestedAtMs,
      }, "ok");
    }
  }

  /** The Server's typed answer to a parked wake request. */
  handleServerWakeOutcome(msg: Extract<ServerToMachineMessage, { type: "agent:wake:outcome" }>): void {
    const pending = this.pendingServerWakes.get(msg.agentId);
    const attrs = {
      agent_id: msg.agentId,
      wake_request_id: msg.wakeRequestId,
      outcome: msg.outcome,
      ...(msg.reason ? { reason: msg.reason } : {}),
      matched_pending: pending?.wakeRequestId === msg.wakeRequestId,
    };
    if (!pending || pending.wakeRequestId !== msg.wakeRequestId) {
      // Stale or unknown: never apply it to a different live request.
      this.recordDaemonEvent("daemon.agent.server_wake.outcome", { ...attrs, ignored: true }, "ok");
      return;
    }
    this.pendingServerWakes.delete(msg.agentId);
    if (msg.outcome === "dispatched") {
      this.recordDaemonEvent("daemon.agent.server_wake.outcome", attrs, "ok");
      return;
    }
    // Refused is terminal for this request; the inbox item stays visible and
    // the next fire may ask again (the Server may have changed its answer).
    logger.error(`[Agent ${msg.agentId}] Server refused wake for due app-inbox item ${pending.itemId}: ${msg.reason ?? "unspecified"}`);
    this.recordDaemonEvent("daemon.agent.server_wake.outcome", attrs, "error");
  }

  /**
   * `recoveryGrant`: only for the admitted human start `launchId` is (RFC 071
   * outbox); every internal caller (restart, cold start, ...) passes none and
   * is checked as an automatic start.
   */
  async startAgent(agentId: string, config: AgentConfig, wakeMessage?: AgentMessage, unreadSummary?: Record<string, number>, resumePrompt?: string, launchId?: string, wakeMessageTransient = false, resumeMessages?: AgentMessage[], startDispatchId?: string, traceParent?: TraceContext | null, catchupBatchId?: string, recoveryGrant: RecoveryGrant | null = null) {
    // Any start settles a parked server wake: the pending app-inbox items are
    // replayed to the new process by the ordinary start path.
    this.pendingServerWakes.delete(agentId);
    if (launchId && catchupBatchId) {
      this.startCatchupBatches.set(agentId, { launchId, batchId: catchupBatchId });
    } else {
      this.startCatchupBatches.delete(agentId);
    }
    // Supersede pending stop completions before queuing or awaiting startup.
    // Even a failed replacement owns the newer status.
    this.lifecycleRecords.recordStart(agentId);
    this.recordDaemonEvent("daemon.agent.start.requested", this.agentStartDispatch.traceAttrs(agentId, config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId));
    if (this.agents.has(agentId)) {
      this.recordDaemonEvent("daemon.agent.start.ignored", {
        ...this.agentStartDispatch.traceAttrs(agentId, config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId),
        reason: "already_running",
      });
      this.rebindRunningStart(agentId, { config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId, recoveryGrant }, "already_running");
      logger.info(`[Agent ${agentId}] Start rebound (already running, launchId=${launchId ?? "none"})`);
      return;
    }
    if (this.agentStarts.hasStarting(agentId)) {
      this.recordDaemonEvent("daemon.agent.start.ignored", {
        ...this.agentStartDispatch.traceAttrs(agentId, config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId),
        reason: "already_starting",
      });
      this.lifecycleRecords.setPendingStartRebind(agentId, {
        config,
        wakeMessage,
        unreadSummary,
        resumePrompt,
        launchId,
        wakeMessageTransient,
        resumeMessages,
        startDispatchId,
        recoveryGrant,
        stopEpochAtRebind: this.lifecycleRecords.stopEpoch(agentId),
      });
      logger.info(`[Agent ${agentId}] Start rebind deferred (startup in progress)`);
      return;
    }
    if (this.agentStarts.hasQueued(agentId)) {
      this.recordDaemonEvent("daemon.agent.start.ignored", {
        ...this.agentStartDispatch.traceAttrs(agentId, config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId),
        reason: "already_queued",
      });
      this.rebindQueuedStart(agentId, { config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId, recoveryGrant }, "already_queued");
      logger.info(`[Agent ${agentId}] Queued start rebound (startup already queued)`);
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const item: AgentStartQueueItem = {
        agentId,
        startDispatchId,
        enqueuedAtMs: this.clockNow(),
        config,
        wakeMessage,
        wakeMessageTransient,
        resumeMessages,
        unreadSummary,
        resumePrompt,
        launchId,
        recoveryGrant,
        traceParent: traceParent ?? getActiveTraceContext(),
        resolve,
        reject,
      };
      this.agentStarts.enqueue(item);
      this.recordDaemonEvent("daemon.agent.start.queued", this.agentStartDispatch.traceAttrs(agentId, config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId));
      const startSnapshot = this.agentStarts.snapshot();
      this.enterNoProcessResidency(
        "queued_start",
        this.noProcessResidencyIdentity(agentId, config, launchId, this.startLaunchSource(config, wakeMessage, resumePrompt)),
        {
          isWaitState: true,
          fenceKind: "start_scheduler",
          deadlineUnixMs: this.clockNow() + Math.max(1, startSnapshot.minStartIntervalMs),
        },
      );
      logger.info(
        `[Agent ${agentId}] Start queued ` +
        `(launchId=${launchId ?? "none"}, queue=${startSnapshot.queueDepth}, active=${startSnapshot.activeStarts}, ` +
        `max=${startSnapshot.maxConcurrentStarts}, interval=${startSnapshot.minStartIntervalMs}ms)`,
      );
      this.pumpAgentStartQueue();
    });
  }

  private pumpAgentStartQueue() {
    const pumpState = this.agentStarts.getPumpState();
    if (pumpState.kind === "blocked") return;
    if (pumpState.kind === "rate_limited") {
      const { item: next, waitMs } = pumpState;
      this.recordDaemonEvent("daemon.agent.start.rate_limited", {
        ...this.agentStartDispatch.traceAttrs(next.agentId, next.config, next.wakeMessage, next.unreadSummary, next.resumePrompt, next.launchId, next.wakeMessageTransient, next.resumeMessages, next.startDispatchId),
        wait_ms: waitMs,
      });
      this.agentStarts.schedulePump(waitMs, () => this.pumpAgentStartQueue());
      return;
    }

    const dequeued = this.agentStarts.dequeue();
    if (dequeued.kind === "empty") return;
    if (dequeued.kind === "stale") {
      const { item } = dequeued;
      this.closeNoProcessResidency(item.agentId, "suppressed", { negativeEvidenceBucket: "stale_queue_item" });
      this.recordDaemonEvent("daemon.agent.start.skipped", {
        ...this.agentStartDispatch.traceAttrs(item.agentId, item.config, item.wakeMessage, item.unreadSummary, item.resumePrompt, item.launchId, item.wakeMessageTransient, item.resumeMessages, item.startDispatchId),
        reason: "stale_queue_item",
      });
      this.pumpAgentStartQueue();
      return;
    }
    const { item } = dequeued;

    if (this.agents.has(item.agentId) || this.agentStarts.hasStarting(item.agentId)) {
      this.closeNoProcessResidency(item.agentId, "suppressed", { negativeEvidenceBucket: "already_running_or_starting" });
      this.recordDaemonEvent("daemon.agent.start.skipped", {
        ...this.agentStartDispatch.traceAttrs(item.agentId, item.config, item.wakeMessage, item.unreadSummary, item.resumePrompt, item.launchId, item.wakeMessageTransient, item.resumeMessages, item.startDispatchId),
        reason: "already_running_or_starting",
      });
      if (this.agents.has(item.agentId)) {
        this.rebindRunningStart(item.agentId, item, "already_running_or_starting");
      } else {
        this.lifecycleRecords.setPendingStartRebind(item.agentId, {
          ...item,
          stopEpochAtRebind: this.lifecycleRecords.stopEpoch(item.agentId),
        });
      }
      logger.info(`[Agent ${item.agentId}] Queued start skipped (already running or starting)`);
      item.resolve();
      this.pumpAgentStartQueue();
      return;
    }

    this.agentStarts.claimStartSlot(item.agentId);
    this.enterNoProcessResidency(
      "starting_process",
      this.noProcessResidencyIdentity(item.agentId, item.config, item.launchId, this.startLaunchSource(item.config, item.wakeMessage, item.resumePrompt)),
      {
        isWaitState: true,
        fenceKind: "runtime_start_timeout",
        deadlineUnixMs: this.clockNow() + runtimeStartTimeoutMs(),
      },
    );
    const startSnapshot = this.agentStarts.snapshot();
    logger.info(
      `[Agent ${item.agentId}] Dequeued start ` +
      `(launchId=${item.launchId ?? "none"}, remaining=${startSnapshot.queueDepth}, active=${startSnapshot.activeStarts})`,
    );
    this.recordDaemonEvent("daemon.agent.start.dequeued", {
      ...this.agentStartDispatch.traceAttrs(item.agentId, item.config, item.wakeMessage, item.unreadSummary, item.resumePrompt, item.launchId, item.wakeMessageTransient, item.resumeMessages, item.startDispatchId),
      queue_age_ms: Math.max(0, this.clockNow() - item.enqueuedAtMs),
    });
    this.startAgentNow(
      item.agentId,
      item.config,
      item.wakeMessage,
      item.unreadSummary,
      item.resumePrompt,
      item.launchId,
      item.wakeMessageTransient ?? false,
      item.resumeMessages,
      item.startDispatchId,
      item.traceParent ?? null,
      item.recoveryGrant ?? null,
    ).then(() => {
      this.releaseAgentStartSlot(item.agentId, "spawn attempted");
      item.resolve();
    }, (err) => {
      this.releaseAgentStartSlot(item.agentId, "start failed");
      item.reject(err);
    });
  }

  private releaseAgentStartSlot(agentId: string, reason: string): void {
    if (!this.agentStarts.releaseStartSlot()) return;
    const startSnapshot = this.agentStarts.snapshot();
    this.recordDaemonEvent("daemon.agent.start.slot_released", {
      agentId,
      reason,
      active_starts: startSnapshot.activeStarts,
      queue_depth: startSnapshot.queueDepth,
      max_concurrent_starts: startSnapshot.maxConcurrentStarts,
    });
    logger.info(
      `[Agent ${agentId}] Start slot released (${reason}) ` +
      `(active=${startSnapshot.activeStarts}, queue=${startSnapshot.queueDepth})`,
    );
    this.pumpAgentStartQueue();
  }

  private cancelQueuedAgentStart(agentId: string, reason: string): boolean {
    const item = this.agentStarts.cancelQueued(agentId);
    if (!item) return false;
    this.closeNoProcessResidency(agentId, "suppressed", { negativeEvidenceBucket: "start_cancelled" });
    this.startingInboxes.cancelStart(agentId);
    this.assertStartPendingDeliveryInvariants("cancel-queued-start");
    this.recordDaemonEvent("daemon.agent.start.cancelled", {
      ...this.agentStartDispatch.traceAttrs(agentId, item.config, item.wakeMessage, item.unreadSummary, item.resumePrompt, item.launchId, item.wakeMessageTransient, item.resumeMessages, item.startDispatchId),
      reason,
    }, "cancelled");
    logger.info(`[Agent ${agentId}] Queued start cancelled (${reason})`);
    this.settleAllAcceptedLaunches(agentId, "cancelled");
    item.resolve();
    return true;
  }

  private cancelAllQueuedAgentStarts(reason: string) {
    const cancelled = this.agentStarts.cancelAllQueued((item) => {
      this.closeNoProcessResidency(item.agentId, "suppressed", { negativeEvidenceBucket: "start_cancelled" });
      this.recordDaemonEvent("daemon.agent.start.cancelled", {
        ...this.agentStartDispatch.traceAttrs(item.agentId, item.config, item.wakeMessage, item.unreadSummary, item.resumePrompt, item.launchId, item.wakeMessageTransient, item.resumeMessages, item.startDispatchId),
        reason,
      }, "cancelled");
      logger.info(`[Agent ${item.agentId}] Queued start cancelled (${reason})`);
      this.settleAllAcceptedLaunches(item.agentId, "cancelled");
    });
    for (const item of cancelled) {
      item.resolve();
    }
    this.startingInboxes.cancelAllStarts();
    this.assertStartPendingDeliveryInvariants("cancel-all-queued-starts");
  }

  // Wraps one spawn attempt in a short span. The spawn span is passed down
  // by value and is not made active, because the new process outlives it and
  // its later events must not attach to this span.
  private async startAgentNow(agentId: string, config: AgentConfig, wakeMessage?: AgentMessage, unreadSummary?: Record<string, number>, resumePrompt?: string, launchId?: string, wakeMessageTransient = false, resumeMessages?: AgentMessage[], startDispatchId?: string, traceParent: TraceContext | null = null, recoveryGrant: RecoveryGrant | null = null) {
    const spawnSpan = this.tracer.startSpan("daemon.agent.spawn", {
      parent: traceParent,
      surface: "daemon",
      kind: "internal",
      attrs: {
        agentId,
        launchId,
        start_dispatch_id: startDispatchId,
        runtime: config.runtime,
      },
    });
    try {
      await runWithoutActiveSpan(() => this.spawnAgentProcess(
        formatTraceparent(spawnSpan.context),
        agentId,
        config,
        wakeMessage,
        unreadSummary,
        resumePrompt,
        launchId,
        wakeMessageTransient,
        resumeMessages,
        startDispatchId,
        recoveryGrant,
      ));
      spawnSpan.end("ok");
    } catch (err) {
      const unresolved = launchUnresolvedCause(err);
      if (unresolved) {
        // Path-free: how many launches the no-cmd.exe Windows resolution turns away, and why.
        this.recordDaemonEvent("daemon.agent.launch_unresolved", {
          agentId,
          launchId,
          runtime: config.runtime,
          reason: unresolved.reason,
          platform: process.platform,
        }, "error", formatTraceparent(spawnSpan.context));
      }
      spawnSpan.end("error", { attrs: { error_class: errorClassOf(err) } });
      throw err;
    }
  }

  private async spawnAgentProcess(spawnTraceparent: string, agentId: string, config: AgentConfig, wakeMessage?: AgentMessage, unreadSummary?: Record<string, number>, resumePrompt?: string, launchId?: string, wakeMessageTransient = false, resumeMessages?: AgentMessage[], startDispatchId?: string, recoveryGrant: RecoveryGrant | null = null) {
    if (this.agents.has(agentId)) {
      this.recordDaemonEvent("daemon.agent.spawn.skipped", {
        ...this.agentStartDispatch.traceAttrs(agentId, config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId),
        reason: "already_running",
      }, "ok", spawnTraceparent);
      this.rebindRunningStart(agentId, { config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId, recoveryGrant }, "already_running");
      logger.info(`[Agent ${agentId}] Start rebound (already running, launchId=${launchId ?? "none"})`);
      return;
    }
    if (this.agentStarts.hasStarting(agentId)) {
      this.recordDaemonEvent("daemon.agent.spawn.skipped", {
        ...this.agentStartDispatch.traceAttrs(agentId, config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId),
        reason: "already_starting",
      }, "ok", spawnTraceparent);
      this.lifecycleRecords.setPendingStartRebind(agentId, {
        config,
        wakeMessage,
        unreadSummary,
        resumePrompt,
        launchId,
        wakeMessageTransient,
        resumeMessages,
        startDispatchId,
        recoveryGrant,
        stopEpochAtRebind: this.lifecycleRecords.stopEpoch(agentId),
      });
      logger.info(`[Agent ${agentId}] Start rebind deferred (startup in progress)`);
      return;
    }
    let startStopEpoch = this.lifecycleRecords.stopEpoch(agentId);
    this.agentStarts.markStarting(agentId);
    let agentProcess: AgentProcess | null = null;
    let pendingStartRebind: PendingStartRebind | undefined;
    const originalLaunchId = launchId || null;
    try {

    const agentDataDir = path.join(this.dataDir, agentId);
    const initialRuntimeConfig = withLocalRuntimeContext(config, agentId, agentDataDir);
    await initializeAgentWorkspace(
      agentDataDir,
      buildInitialMemoryMd(initialRuntimeConfig),
      getOnboardingSeedMode(config) === FIRST_CINDY_SEED_MODE ? buildCindySeedFiles() : [], config.envVars,
    );

    // RFC 071 outbox: the one spawn entry every start goes through (server
    // starts, crash respawn, wake / message cold start, restart on message,
    // deferred spawn, cooldown restart), decided by the automatic-start rule.
    // Only an admitted human start passes on its own grant: this start's, or
    // that of a server start deferred onto it (it takes this spawn over, below);
    // the grant counts only for the launch this spawn will carry. Nothing
    // below has consumed a message yet, and messages the caller hands over
    // while the start is pending are already buffered by now.
    if (this.runtimeProcessGate && this.daemonInstanceId) {
      // Held until this connection's capability is confirmed: the process's
      // mode (reliable / compat) is fixed at launch from it.
      // Cancellable: a stop of this agent (stopAgent) or the daemon stopping
      // ends the wait with `false`; it is never ended by pretending.
      const wait = this.runtimeProcessGate.waitForCapability();
      this.capabilityHolds.set(agentId, wait);
      const confirmed = await wait.confirmed;
      if (this.capabilityHolds.get(agentId) === wait) this.capabilityHolds.delete(agentId);
      if (!confirmed || this.lifecycleRecords.stopEpochChanged(agentId, startStopEpoch)) {
        // Nothing spawned: the starting state ends here (the caller releases
        // the start slot on return), and every launch still waiting is settled.
        this.agentStarts.clearStarting(agentId);
        this.lifecycleRecords.deletePendingStartRebind(agentId);
        this.closeNoProcessResidency(agentId, "suppressed", { negativeEvidenceBucket: "explicit_stop" });
        this.settleAllAcceptedLaunches(agentId, "cancelled");
        this.recordDaemonEvent("daemon.agent.start.held_cancelled", { agentId, launchId, reason: confirmed ? "stopped_after_confirmation" : "wait_cancelled" });
        return;
      }
    }
    const deferredStart = this.lifecycleRecords.getPendingStartRebind(agentId);
    const spawnRefusal = this.runtimeProcessGate && this.daemonInstanceId
      ? this.runtimeProcessGate.startRefusal(
        agentId,
        deferredStart?.launchId || launchId || null,
        deferredStart?.recoveryGrant ?? recoveryGrant,
      )
      : null;
    if (spawnRefusal !== null) {
      this.agentStarts.clearStarting(agentId);
      if (this.lifecycleRecords.stopEpochChanged(agentId, startStopEpoch)) {
        // A stop arrived meanwhile: it wins; no refusal state is left behind.
        this.closeNoProcessResidency(agentId, "suppressed", { negativeEvidenceBucket: "explicit_stop" });
        this.settleAllAcceptedLaunches(agentId, "cancelled");
        return;
      }
      this.refuseUnreliableSpawn(agentId, { config, wakeMessage, wakeMessageTransient, launchId, startDispatchId }, spawnRefusal.detail, spawnTraceparent, spawnRefusal.reason);
      return;
    }

    pendingStartRebind = this.lifecycleRecords.getPendingStartRebind(agentId);
    if (pendingStartRebind) {
      this.lifecycleRecords.deletePendingStartRebind(agentId);
      const previousWakeMessage = wakeMessage;
      this.startingInboxes.rebindWake(
        agentId,
        previousWakeMessage,
        pendingStartRebind.wakeMessage,
        (left, right) => this.sameWakeMessage(left, right),
      );
      this.assertStartPendingDeliveryInvariants("rebind-starting-start");

      config = pendingStartRebind.config;
      unreadSummary = pendingStartRebind.unreadSummary;
      resumePrompt = pendingStartRebind.resumePrompt;
      launchId = pendingStartRebind.launchId || launchId;
      resumeMessages = pendingStartRebind.resumeMessages;
      startStopEpoch = pendingStartRebind.stopEpochAtRebind ?? startStopEpoch;
      if (pendingStartRebind.wakeMessage) {
        wakeMessage = pendingStartRebind.wakeMessage;
        wakeMessageTransient = pendingStartRebind.wakeMessageTransient === true;
      }
    }

    this.enterNoProcessResidency(
      "starting_process",
      this.noProcessResidencyIdentity(agentId, config, launchId, this.startLaunchSource(config, wakeMessage, resumePrompt)),
      {
        isWaitState: true,
        fenceKind: "runtime_start_timeout",
        deadlineUnixMs: this.clockNow() + runtimeStartTimeoutMs(),
      },
    );
    this.recordDaemonEvent("daemon.agent.spawn.started", this.agentStartDispatch.traceAttrs(agentId, config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient, resumeMessages, startDispatchId), "ok", spawnTraceparent);

    const driver = this.driverResolver(config.runtime || "claude");
    const legacyWakeRuntimeProfile = wakeMessage ? runtimeProfileNotificationFromMessage(wakeMessage) : null;
    if (legacyWakeRuntimeProfile?.kind === "migration") {
      this.completeDeprecatedRuntimeProfileMigration(
        agentId,
        legacyWakeRuntimeProfile.key,
        launchId || null,
        wakeMessage?.traceparent,
        "wake_message",
      );
      wakeMessage = undefined;
    }

    let runtimeConfig = withLocalRuntimeContext(config, agentId, agentDataDir);
    const legacyRuntimeProfileControl = runtimeConfig.runtimeProfileControl?.kind === "migration"
      ? runtimeConfig.runtimeProfileControl
      : null;
    if (legacyRuntimeProfileControl) {
      this.completeDeprecatedRuntimeProfileMigration(
        agentId,
        legacyRuntimeProfileControl.key,
        launchId || null,
        undefined,
        "agent_config",
      );
      runtimeConfig = { ...runtimeConfig, runtimeProfileControl: null };
    }

    enforceRuntimeLaunchVersion(driver, runtimeConfig, { workingDirectory: agentDataDir }, (warning) => {
      logger.warn(`[Agent ${agentId}] ${warning}`);
      this.broadcastActivity(
        agentId,
        "working",
        warning,
        [{ kind: "system", title: "Runtime update recommended", text: warning }],
        launchId || null,
        "runtime_starting",
      );
    });
    // RFC 070 phase 1: at a cold wake with a large prior context, retire the
    // session (drop driver `--resume`) but keep the ladder's resume semantics.
    const wakeRecycle = await planWakeSessionRecycle({ config: runtimeConfig, hasResumePrompt: Boolean(resumePrompt), homeDir: this.runtimeSessionHomeDir });
    if (wakeRecycle.action === "recycle") {
      if (runtimeConfig.sessionId) {
        rememberSessionContext(buildCliTransportDir(this.slockHome, agentId, launchId), runtimeConfig.sessionId, null);
      }
      runtimeConfig = { ...runtimeConfig, sessionId: null };
      const applied = describeAppliedWakeRecycle(agentId, wakeRecycle);
      this.recordDaemonEvent("daemon.agent.wake_recycle", applied.traceAttrs);
      logger.info(`[Agent ${agentId}] ${applied.logLine}`);
    }
    const isResume = !!runtimeConfig.sessionId || wakeRecycle.action === "recycle";
    const standingPrompt = driver.buildSystemPrompt(runtimeConfig, agentId);
    let prompt: AxSurfaceText;
    let promptSource: string;
    let wakeMessageDeliveredAsInboxUpdate = false;
    let wakeMessageDeliveredWithThreadContext = false;
    let startingInboxDeliveredAsInput = false;
    let resumeCatchupDeliveredAsInput = false;
    let renderedStartupThreadContextMessages: AgentMessage[] = [];
    const startingInboxMessages = this.startingInboxes.values(agentId);
    // task #1221: a start that follows a start-failure block carries the
    // messages refused as wakes during it, including for a session-less agent
    // (the server only sends resumeMessages then, or for a resumed session).
    const resumeCatchupMessages = !wakeMessage && !resumePrompt ? (resumeMessages ?? []) : [];
    const resumeCatchupInputMessages = resumeCatchupMessages.length > 0
      ? [...resumeCatchupMessages, ...startingInboxMessages]
      : [];
    const wakeMessageProjection = this.projectThreadJoinContextsForRuntimeInput(
      agentId,
      wakeMessage ? [wakeMessage] : [],
      wakeMessageTransient !== true,
    );
    const resumeCatchupProjection = this.projectThreadJoinContextsForRuntimeInput(
      agentId,
      resumeCatchupInputMessages,
    );
    const startingInboxProjection = this.projectThreadJoinContextsForRuntimeInput(
      agentId,
      startingInboxMessages,
    );
    if (runtimeConfig.runtimeProfileControl && !wakeMessage) {
      prompt = driver.supportsNativeStandingPrompt
        ? NATIVE_STANDING_PROMPT_STARTUP_INPUT
        : formatRuntimeProfileControlStartupInput(runtimeConfig.runtimeProfileControl, driver);
      promptSource = "runtime_profile_control";
    } else if (isResume && resumePrompt) {
      prompt = adoptAxSurfaceText(resumePrompt);
      promptSource = "resume_prompt";
    } else if (wakeMessage) {
      const transientWakeMessage = wakeMessageTransient === true;
      const projectedWakeMessage = wakeMessageProjection.messages[0];
      const runtimeProfileControlPrompt = transientWakeMessage ? null : formatRuntimeProfileControlPrompt([projectedWakeMessage]);
      if (transientWakeMessage) {
        prompt = formatSystemNoticeRuntimeInput(projectedWakeMessage, driver);
      } else if (runtimeProfileControlPrompt) {
        prompt = runtimeProfileControlPrompt;
      } else if (wakeMessageProjection.renderedContextMessages.length > 0) {
        wakeMessageDeliveredWithThreadContext = true;
        renderedStartupThreadContextMessages = wakeMessageProjection.renderedContextMessages;
        const pendingInboxNotice = startingInboxMessages.length > 0
          ? formatInboxUpdateRuntimeInput(startingInboxMessages, driver, startingInboxMessages.length)
          : undefined;
        prompt = formatConcreteMessagesRuntimeInput([projectedWakeMessage], driver, pendingInboxNotice);
      } else {
        wakeMessageDeliveredAsInboxUpdate = true;
        prompt = formatInboxUpdateRuntimeInput([wakeMessage, ...startingInboxMessages], driver);
      }
      promptSource = transientWakeMessage
        ? "transient_wake_message"
        : runtimeProfileControlPrompt
          ? "runtime_profile_control_message"
          : wakeMessageDeliveredWithThreadContext
            ? "wake_thread_context"
          : "wake_inbox_update";

      if (!transientWakeMessage && !runtimeProfileControlPrompt) {
        prompt = composeAxSurfaces(prompt, formatOtherUnreadChannelsSuffix(unreadSummary));
      }
    } else if (resumeCatchupInputMessages.length > 0) {
      resumeCatchupDeliveredAsInput = true;
      renderedStartupThreadContextMessages = resumeCatchupProjection.renderedContextMessages;
      prompt = formatConcreteMessagesRuntimeInput(resumeCatchupProjection.messages, driver);
      promptSource = "resume_catchup_inbox";

      prompt = composeAxSurfaces(prompt, formatBoundedStartupUnreadSuffix(unreadSummary));
    } else if (startingInboxMessages.length > 0) {
      startingInboxDeliveredAsInput = true;
      renderedStartupThreadContextMessages = startingInboxProjection.renderedContextMessages;
      if (renderedStartupThreadContextMessages.length > 0) {
        const renderedSet = new Set(renderedStartupThreadContextMessages);
        const pendingMessages = startingInboxMessages.filter((message) => !renderedSet.has(message));
        const pendingInboxNotice = pendingMessages.length > 0
          ? formatInboxUpdateRuntimeInput(pendingMessages, driver, pendingMessages.length)
          : undefined;
        prompt = formatConcreteMessagesRuntimeInput(
          renderedStartupThreadContextMessages,
          driver,
          pendingInboxNotice,
        );
        promptSource = "starting_thread_context";
      } else {
        prompt = formatInboxUpdateRuntimeInput(startingInboxMessages, driver);
        promptSource = "starting_inbox_update";
      }
    } else if (isResume && unreadSummary && Object.keys(unreadSummary).length > 0) {
      prompt = formatResumeUnreadSummaryPrompt(unreadSummary, driver);
      promptSource = "resume_unread_summary";
    } else if (isResume) {
      prompt = formatResumeEmptyPrompt(driver);
      promptSource = "resume_empty";
    } else {
      prompt = driver.supportsNativeStandingPrompt
        ? NATIVE_STANDING_PROMPT_STARTUP_INPUT
        : standingPrompt;
      promptSource = "cold_start";
    }
    // task #9: the messages this launch's first input names (tracked mentions
    // among them count as told to this process).
    const firstInputMessages: readonly AgentMessage[] =
      promptSource === "wake_inbox_update" || promptSource === "wake_thread_context" || promptSource === "transient_wake_message"
        ? [...(wakeMessage ? [wakeMessage] : []), ...(promptSource === "transient_wake_message" ? [] : startingInboxMessages)]
        : promptSource === "resume_catchup_inbox"
          ? resumeCatchupInputMessages
          : promptSource === "starting_thread_context" || promptSource === "starting_inbox_update"
            ? startingInboxMessages
            : [];
    ({ prompt, promptSource } = applyWakeRecycleBriefing(wakeRecycle, prompt, promptSource));
    // Startup memory block (RFC 070 §6 follow-up): every fresh session gets
    // the MEMORY.md head pushed instead of relying on the standing-prompt
    // read. The recycle path injects its own copy inside the briefing (so the
    // block lands between briefing chrome and the constructed panel); this
    // covers the remaining fresh starts — creation, session/full reset, and
    // runtime switches that cleared the session.
    if (!runtimeConfig.sessionId && wakeRecycle.action !== "recycle") {
      const memoryBlockConfig = resolveStartupMemoryBlockConfig(runtimeConfig.constructedWakeContext, runtimeConfig.envVars);
      if (memoryBlockConfig.enabled) {
        const memoryBlock = await buildStartupMemoryBlock({ workspacePath: agentDataDir, budgetTokens: memoryBlockConfig.budgetTokens });
        if (memoryBlock) {
          ({ prompt, promptSource } = applyStartupMemoryBlock(memoryBlock, prompt, promptSource));
          logger.info(`[Agent ${agentId}] Startup memory block injected for fresh session (source ${promptSource})`);
        }
      }
    }
    const runtimeInputTraceAttrs = buildRuntimeInputTraceAttrs({
      source: promptSource,
      prompt,
      standingPrompt,
      resumePrompt,
      messages: wakeMessage
        ? wakeMessageProjection.messages
        : resumeCatchupInputMessages.length > 0
          ? resumeCatchupProjection.messages
          : startingInboxMessages.length > 0
            ? startingInboxProjection.messages
            : undefined,
      unreadSummary,
      sessionIdPresent: isResume,
      nativeStandingPrompt: Boolean(driver.supportsNativeStandingPrompt),
    });

    const effectiveLaunchId = launchId || null;

    const canDeferEmptyStart =
      driver.deferSpawnUntilMessage === true &&
      !wakeMessage &&
      !runtimeConfig.runtimeProfileControl &&
      resumeCatchupInputMessages.length === 0 &&
      (!unreadSummary || Object.keys(unreadSummary).length === 0);
    if (canDeferEmptyStart) {
      const pendingMessages = this.startingInboxes.drainOnSpawn(agentId);
      this.agentStarts.clearStarting(agentId);
      this.closeNoProcessResidency(agentId, "suppressed", { negativeEvidenceBucket: "defer_until_concrete_message" });
      this.assertStartPendingDeliveryInvariants("defer-empty-start-drain");
      if (this.lifecycleRecords.stopEpochChanged(agentId, startStopEpoch)) {
        this.closeNoProcessResidency(agentId, "suppressed", { negativeEvidenceBucket: "explicit_stop" });
        logger.info(`[Agent ${agentId}] Deferred ${driver.id} spawn suppressed by stop request`);
        this.settleAllAcceptedLaunches(agentId, "cancelled");
        return;
      }
      // RFC 071: no process exists for these launches; a later message-driven
      // spawn reports itself as a respawn.
      this.settleAllAcceptedLaunches(agentId, "deferred");
      this.lifecycleRecords.setRestartSnapshot(agentId, {
        config: this.buildRestartSafeConfig(runtimeConfig, runtimeConfig.sessionId || null),
        sessionId: runtimeConfig.sessionId || null,
        launchId: effectiveLaunchId,
        // No live AgentProcess in this adoption branch — omit rather than
        // fabricate; the marker's processInstanceId is nullable by contract.
      });
      this.sendAgentStatus(agentId, "active", effectiveLaunchId);
      this.broadcastActivity(agentId, "online", "Process idle", [], undefined, "idle");
      this.recordDaemonEvent("daemon.agent.spawn.deferred", {
        ...this.agentStartDispatch.traceAttrs(agentId, config, wakeMessage, unreadSummary, resumePrompt, effectiveLaunchId || undefined, wakeMessageTransient, resumeMessages, startDispatchId),
        pending_messages_count: pendingMessages.length,
        reason: "defer_until_concrete_message",
      }, "ok", spawnTraceparent);
      logger.info(`[Agent ${agentId}] Deferred ${driver.id} spawn until first concrete message`);
      for (const message of pendingMessages) {
        this.deliverMessage(agentId, message);
      }
      return;
    }

    // A per_turn runtime's deferred app notice rides in this start's first
    // input (a restart for the notice itself already carries it as the prompt).
    if (!resumePrompt) {
      const appNoticeSuffix = this.takeAppInboxNoticeForStartInput(agentId);
      if (appNoticeSuffix) prompt = composeAxSurfaces(prompt, appNoticeSuffix);
    }
    const effectiveConfig = await this.buildSpawnConfig(agentId, runtimeConfig);
    const fullyRenderedStartupMessages = wakeMessage
      ? wakeMessageDeliveredAsInboxUpdate ? [] : [wakeMessage]
      : resumeCatchupDeliveredAsInput
        ? resumeCatchupInputMessages
        : renderedStartupThreadContextMessages;
    const processInstanceId = randomUUID();
    const catchupBatchEcho = this.takeStartCatchupBatch(
      agentId,
      effectiveLaunchId,
      resumeCatchupDeliveredAsInput ? resumeCatchupMessages.length : 0,
    );
    const runtimeContext = {
      agentId,
      config: effectiveConfig,
      standingPrompt,
      prompt,
      workingDirectory: agentDataDir,
      slockCliPath: this.slockCliPath,
      daemonVersion: this.daemonVersion,
      computerVersion: this.computerVersion,
      daemonApiKey: this.daemonApiKey,
      slockHome: this.slockHome,
      launchId: effectiveLaunchId,
      processInstanceId,
      agentCredentialProxyInboxCoordinator: this.createAgentProxyInboxCoordinator(agentId),
      agentAppInbox: this.#appInboxForAgent?.(agentId),
      cliTransportTraceDir: this.cliTransportTraceDir,
      tracer: this.tracer,
    };
    const runtime = driver.createSession?.(runtimeContext) ?? createChildProcessRuntimeSession(driver, runtimeContext);
    const liveProcessConfig: AgentConfig = {
      ...runtimeConfig,
      serverUrl: effectiveConfig.serverUrl,
      agentCredentialKey: effectiveConfig.agentCredentialKey,
      agentCredentialId: effectiveConfig.agentCredentialId,
    };
    const initialSessionId = this.initialAgentProcessSessionId(driver, liveProcessConfig);
    const restartSessionId = initialSessionId || (driver.requiresSessionInitForDelivery ? liveProcessConfig.sessionId || null : null);
    this.runtimeProcessBindingFence.bind(runtime, {
      agentId,
      serverId: runtimeConfig.runtimeContext?.serverId ?? null,
      machineId: runtimeConfig.runtimeContext?.machineId ?? null,
      configuredRuntimeId: runtimeConfig.runtime,
      driverId: driver.id,
      initialLaunchId: effectiveLaunchId,
      activeLaunchId: effectiveLaunchId,
      startSessionId: effectiveConfig.sessionId || null,
      activeSessionId: initialSessionId,
      processInstanceId,
    });

    const startupInputMessages = wakeMessageDeliveredAsInboxUpdate && wakeMessage
      ? [wakeMessage, ...startingInboxMessages]
      : resumeCatchupDeliveredAsInput
        ? resumeCatchupInputMessages
        : startingInboxMessages;
    agentProcess = {
      runtime,
      driver,
      inbox: startupInputMessages,
      config: liveProcessConfig,
      sessionId: initialSessionId,
      sessionReadyForDelivery: this.initialSessionReadyForDelivery(driver, liveProcessConfig, initialSessionId),
      launchId: effectiveLaunchId,
      startDispatchId: startDispatchId || null,
      startup: createAgentProcessStartupState({
        wakeMessage,
        unreadSummary,
        resumePrompt,
      }),
      notifications: new RuntimeNotificationState(),
      activityHeartbeat: { kind: "inactive" },
      readinessTransition: null,
      activation: { kind: "idle" },
      compaction: { kind: "none" },
      cliTransportDir: buildCliTransportDir(this.slockHome, agentId, effectiveLaunchId),
      passiveAx: configPassiveAx(effectiveConfig),
      review: { kind: "none" },
      runtimeProgress: new RuntimeProgressState(Date.now()),
      deliveryConsumption: new DeliveryConsumptionWatch(),
      runtimeTraceSpan: null,
      runtimeTraceCounters: createRuntimeTraceCounters(),
      turnOutcome: createTurnOutcomeCounters(),
      catchupBatchEcho,
      spawnReported: false,
      runtimeTelemetryResultSeq: 0,
      lastActivityKind: "offline",
      lastActivity: "",
      lastActivityDetail: "",
      lastActivityDetailKind: "runtime_unavailable",
      recentStdout: [],
      recentStderr: [],
      lastRuntimeError: null,
      decisionErrorWindow: new DecisionErrorWindow(),
      runtimeErrorDeliveryBackoff: createRuntimeErrorDeliveryBackoffState(),
      sessionReadyDeliveryRetry: createSessionReadyDeliveryRetryState(),
      spawnError: null,
      processInstanceId,
      spawnedAtMs: Date.now(),
      exit: { kind: "live", stalledRecoverySigtermTimer: null },
      runtimeProfileTurnControl: liveProcessConfig.runtimeProfileControl
        ? runtimeProfileTurnControl(liveProcessConfig.runtimeProfileControl.kind, liveProcessConfig.runtimeProfileControl.key, "agent_config")
        : null,
      pendingTrajectory: null,
      gatedSteering: createGatedSteeringState(),
    };
    this.startingInboxes.drainOnSpawn(agentId);
    this.agents.set(agentId, agentProcess);
    this.markTrackedMentionsToldAtStart(agentId, processInstanceId, firstInputMessages);
    if (this.lifecycleRecords.stopEpochChanged(agentId, startStopEpoch)) {
      // RFC 071: the runtime has not been started, so no child exists.
      this.settleAllAcceptedLaunches(agentId, "cancelled");
      await this.cleanupStoppedRuntimeStart(agentId, agentProcess);
      return;
    }
    this.lifecycleRecords.setRestartSnapshot(agentId, {
      config: this.buildRestartSafeConfig(runtimeConfig, restartSessionId),
      sessionId: restartSessionId,
      launchId: effectiveLaunchId,
      processInstanceId: agentProcess.processInstanceId,
    });
    if (pendingStartRebind) {
      this.recordStartRebind(agentId, pendingStartRebind, "startup_registered", originalLaunchId, effectiveLaunchId, agentProcess.sessionId);
    }
    this.startRuntimeTrace(agentId, agentProcess, "spawn", wakeMessage ? [wakeMessage] : resumeCatchupInputMessages.length > 0 ? resumeCatchupInputMessages : undefined, runtimeInputTraceAttrs);
    this.agentStarts.clearStarting(agentId);
    if (runtimeConfig.runtimeProfileControl) {
      this.ackInjectedRuntimeProfileControl(agentId, runtimeConfig.runtimeProfileControl, agentProcess.launchId);
    }
    if (wakeMessageDeliveredAsInboxUpdate) {
      this.recordInboxUpdateProjection(agentId, agentProcess, agentProcess.inbox, "spawn_wake_inbox_update", "wake", prompt);
    } else if (wakeMessageDeliveredWithThreadContext && wakeMessage) {
      this.notePushedModelBodies(agentProcess, [wakeMessage, ...renderedStartupThreadContextMessages]);
      this.recordRenderedThreadJoinContextReceipts(agentId, renderedStartupThreadContextMessages);
      this.consumeVisibleMessages(agentId, { messages: [wakeMessage], source: "spawn_wake_message" });
      this.ackInjectedRuntimeProfileMessages(agentId, [wakeMessage], agentProcess.launchId);
    } else if (resumeCatchupDeliveredAsInput) {
      this.notePushedModelBodies(agentProcess, [...resumeCatchupInputMessages, ...renderedStartupThreadContextMessages]);
      this.recordInboxUpdateProjection(agentId, agentProcess, resumeCatchupInputMessages, "spawn_resume_catchup_inbox", "wake", prompt);
      this.recordRenderedThreadJoinContextReceipts(agentId, renderedStartupThreadContextMessages);
      this.consumeVisibleMessages(agentId, { messages: resumeCatchupInputMessages, source: "spawn_resume_catchup_inbox" });
      this.ackInjectedRuntimeProfileMessages(agentId, resumeCatchupInputMessages, agentProcess.launchId);
    } else if (startingInboxDeliveredAsInput) {
      // Only the rendered thread context carries bodies; the rest is a notice.
      this.notePushedModelBodies(agentProcess, renderedStartupThreadContextMessages);
      this.recordInboxUpdateProjection(agentId, agentProcess, startingInboxMessages, "spawn_starting_inbox_update", "wake", prompt);
      this.recordRenderedThreadJoinContextReceipts(agentId, renderedStartupThreadContextMessages);
      this.consumeVisibleMessages(agentId, { messages: startingInboxMessages, source: "spawn_starting_inbox_update" });
      this.ackInjectedRuntimeProfileMessages(agentId, startingInboxMessages, agentProcess.launchId);
    } else if (wakeMessage && !wakeMessageTransient) {
      this.consumeVisibleMessages(agentId, { messages: [wakeMessage], source: "spawn_wake_message" });
      this.ackInjectedRuntimeProfileMessages(agentId, [wakeMessage], agentProcess.launchId);
    }

    const boundAgentProcess = agentProcess;
    runtime.on("stdout", (chunkText) => {
      if (!this.runtimeProcessBindingFence.acceptOutput(agentId, boundAgentProcess, runtime, "stdout")) return;
      if (runtime.descriptor.stdout.channel === "structured_protocol") return;
      boundAgentProcess.recentStdout = pushRecentStdout(boundAgentProcess.recentStdout, chunkText);
    });

    runtime.on("runtime_event", (event) => {
      if (!this.runtimeProcessBindingFence.acceptOutput(agentId, boundAgentProcess, runtime, `runtime_event:${event.kind}`)) {
        this.runtimeProcessBindingFence.recordMissingProcessEvent(agentId, event, driver.id);
        return;
      }
      this.handleParsedEvent(agentId, event, driver);
    });

    runtime.on("stderr", (text) => {
      if (!text) return;
      if (!this.runtimeProcessBindingFence.acceptOutput(agentId, boundAgentProcess, runtime, "stderr")) return;
      const current = boundAgentProcess;
      if (driver.id === "codex" && isCodexProviderReconnectLog(text)) {
        current.recentStderr = pushRecentStderr(current.recentStderr, text);
        current.decisionErrorWindow.recordStderr(text);
        this.recordDaemonEvent("daemon.agent.provider_reconnect", {
          agentId,
          launchId: current.launchId || undefined,
          runtime: config.runtime,
          model: config.model,
        });
        this.broadcastActivity(agentId, "working", "Codex reconnecting to provider…", [
          { kind: "text", text },
        ], undefined, "runtime_reconnecting");
        logger.info(`[Agent ${agentId} stderr]: ${text}`);
        return;
      }
      // task #1127: Codex's tool router rejects tool-call arguments it cannot
      // deserialize and reports it only on stderr — no app-server notification
      // carries the fact, so without this branch the turn goes quiet and the
      // agent looks idle. Observation only: never restart, never retry. See
      // codexToolArgumentParseSignature.ts for why a text match is sanctioned
      // here and nowhere else.
      if (driver.id === "codex" && isCodexToolArgumentParseErrorChunk(text)) {
        current.recentStderr = pushRecentStderr(current.recentStderr, text);
        current.decisionErrorWindow.recordStderr(text);
        this.recordDaemonEvent("daemon.agent.tool_argument_parse_failed", {
          agentId,
          launchId: current.launchId || undefined,
          runtime: config.runtime,
          // Per-model counting is the point of the trace. The rejected argument
          // values are never recorded: they are model output and can hold
          // anything the user typed.
          model: config.model,
        }, "error");
        this.broadcastActivity(
          agentId,
          "error",
          CODEX_TOOL_ARGUMENT_PARSE_USER_MESSAGE,
          [{ kind: "text", text }],
          undefined,
          "runtime_error",
          undefined,
          undefined,
          buildRuntimeErrorActivityDiagnostic(text, {
            errorClass: "ToolArgumentParseError",
            reasonProvenance: "codex_stderr_signature",
            nativeReasonPresent: false,
          }),
        );
        logger.error(`[Agent ${agentId} stderr]: ${text}`);
        return;
      }
      // Codex CLI emits noisy but benign WebSocket fallback logs on stderr — suppress them.
      if (driver.id === "codex" && isCodexBenignTransportLog(text)) return;
      current.recentStderr = pushRecentStderr(current.recentStderr, text);
      current.decisionErrorWindow.recordStderr(text);
      logger.error(`[Agent ${agentId} stderr]: ${text}`);
    });

    runtime.on("error", (err) => {
      if (!this.runtimeProcessBindingFence.acceptOutput(agentId, boundAgentProcess, runtime, "error")) return;
      const current = boundAgentProcess;
      current.spawnError = err.message;
      this.clearRuntimeStartupTimeout(current);
      this.recordDaemonEvent("daemon.agent.process.error", {
        ...this.processLifecycleIdentityAttrs(agentId, current),
        error_class: normalizeAgentProcessErrorClass(err),
      }, "error");
      logger.error(`[Agent ${agentId}] Process error: ${err.message}`);
    });

    runtime.on("exit", ({ code, signal }) => {
      const current = this.agents.get(agentId);
      if (current && current.runtime === runtime) {
        this.clearStalledRecoverySigtermWatchdog(current);
        current.exit = { kind: "exited", code, signal };
      }
      // RFC 071 §4.3 rule 3: the identity comes from THIS runtime's closure
      // (the process that exited), never from the registry, which may already
      // hold a newer process for the agent or nothing at all.
      const exitFrameSent = this.sendProcessExited(agentId, boundAgentProcess, effectiveLaunchId, code, signal);
      // RFC 071 outbox: a process started without a server launch and never
      // rebound to one has no process_exited frame; its exit is recorded
      // locally and durably instead.
      if (!exitFrameSent && !effectiveLaunchId && this.runtimeProcessGate && this.daemonInstanceId) {
        this.runtimeProcessGate.processExitedLocally(agentId, boundAgentProcess.processInstanceId);
      }
      const exitTraceAttrs = this.runtimeExitTraceAttrs.get(runtime);
      this.recordDaemonEvent("daemon.agent.process.exited", {
        agentId,
        launchId: current?.launchId || undefined,
        runtime: config.runtime,
        model: config.model,
        exit_code: code,
        exit_signal: signal,
        clean_exit: code === 0,
        runtime_trace_active: Boolean(current?.runtimeTraceSpan),
        inbox_count: current?.inbox.length ?? 0,
        pending_notification_count: current?.notifications.pendingCount ?? 0,
        ...exitTraceAttrs,
      });
      // Use the closure-captured agentProcess: stopAgent deletes from
      // this.agents before the runtime exits, so the map lookup above
      // returns undefined for explicit stops. The lifecycle span must
      // fire for every exit path.
      if (agentProcess) {
        const stopSource = exitTraceAttrs?.stop_source as string | undefined;
        const exitCause = stopSource?.includes("stall") ? "stall_kill"
          : stopSource === "disconnect" ? "disconnect_kill"
          : stopSource === "daemon_exit" ? "parent_exit"
          : stopSource === "explicit_request" || stopSource === "daemon_internal" || code === 0 ? "expected_terminate"
          : "crash";
        // last_event_age_ms_bucket is anchored on the last runtime event, not on
        // the turn start that stall decisions use (2026-06-22 lifecycle contract).
        const lastEventAgeMs = agentProcess.runtimeProgress.lastEventAgeMs();
        this.recordDaemonEvent("daemon.runtime.process.exit", {
          ...this.processLifecycleIdentityAttrs(agentId, agentProcess),
          exit_code: code,
          exit_signal: signal,
          cause: exitCause,
          last_event_kind: agentProcess.lastActivityKind || undefined,
          last_event_age_ms_bucket: bucketMs(lastEventAgeMs),
          uptime_ms_bucket: bucketMs(Date.now() - agentProcess.spawnedAtMs),
        }, code === 0 ? "ok" : "error");
      }
      logger.info(`[Agent ${agentId}] Process exited with code ${code}${signal ? ` (signal ${signal})` : ""}`);
    });

    runtime.on("close", ({ code, signal }) => {
      if (this.agents.has(agentId)) {
        const ap = this.agents.get(agentId)!;
        // Guard: if a new process was already spawned for this agent, don't touch it.
        // This happens when a process is replaced (e.g. restart on new message),
        // new process is added to the map, then the old process's exit handler fires.
        if (ap.runtime !== runtime) return;
        ap.notifications.clearTimer();
        this.disposeAgentProcessTimers(ap, { includeCompactionWatchdog: false });
        this.closeRuntimeReadinessTransition(ap, "terminal");
        this.closeActivationTransition(ap, "terminal");

        const finalCode = ap.exit.kind === "exited" ? ap.exit.code ?? code : code;
        const finalSignal = ap.exit.kind === "exited" ? ap.exit.signal ?? signal : signal;
        const expectedTerminationReason = ap.gatedSteering.expectedTerminationReason;
        const startupTimeoutTermination = expectedTerminationReason === "startup_timeout";
        const startupRequestErrorTermination = expectedTerminationReason === "startup_request_error";
        const expectedTermination = Boolean(expectedTerminationReason);
        const stickyTerminalFailureDetail = classifyStickyTerminalFailure(ap);
        const turnBoundarySatisfied = closeSatisfiedTurnBoundary(ap, expectedTermination);
        const closeBeforeTurnBoundary = !turnBoundarySatisfied;
        // A startup-timeout termination is NOT a clean exit even when the killed
        // process happens to exit with code 0 (or leaves no runtime error) — the
        // agent never finished starting. Excluding it here routes the close
        // handler to the startup-timeout branch below, which preserves the
        // error/inactive status set at timeout detection instead of overwriting
        // it with a masking "online / Process idle" (Antigravity startup-timeout
        // status-masking bug: a timed-out `agy` killed by the daemon closes with
        // code 0, and the clean-exit path then hid the failure on the status dot).
        // A cold-idle sweep stop ignores `lastRuntimeError`: that field is only
        // cleared when an ordinary message is delivered, so an error the runtime
        // has long since recovered from (e.g. a rate limit that lifted hours
        // ago) would otherwise turn a deliberate stop into a "crash" and mark a
        // healthy agent inactive. The sweep only stops processes that completed
        // a turn and then idled past the cache TTL, which is itself evidence the
        // runtime is fine; genuinely sticky failures are still excluded above.
        const staleRuntimeErrorIgnored = expectedTerminationReason === "cold_idle_recycle";
        const processEndedCleanly = !stickyTerminalFailureDetail && !startupTimeoutTermination && !startupRequestErrorTermination && ((finalCode === 0 && turnBoundarySatisfied) || (expectedTermination && (!ap.lastRuntimeError || staleRuntimeErrorIgnored)));
        const terminalFailureDetail = processEndedCleanly ? null : (stickyTerminalFailureDetail ?? classifyTerminalFailure(ap));
        const resumeRecoveryReason = resumeSessionRecoveryReason(ap);
        const shouldColdStartResumeSession = resumeRecoveryReason !== null;
        const summary = summarizeCrash(finalCode, finalSignal);
        this.endRuntimeTrace(ap, processEndedCleanly ? "ok" : "error", {
          outcome: processEndedCleanly ? "process-exit" : "process-crash",
          expectedTerminationReason: expectedTerminationReason || undefined,
          runtime_turn_boundary: ap.runtime.descriptor.turnBoundary,
          runtime_turn_boundary_satisfied: turnBoundarySatisfied,
          runtime_exit_before_turn_boundary: closeBeforeTurnBoundary || undefined,
          exitCode: finalCode,
          exitSignal: finalSignal,
          ...runtimeTraceCounterAttrs(ap),
          ...this.finalizeRuntimeProfileTurnControl(agentId, ap, "process_exit"),
        });

        this.interruptCompactionIfActive(agentId);
        cleanupLaunchProxies(agentId);
        this.revokeManagedRunnerCredential(agentId, ap.config, ap.launchId);
        this.agents.delete(agentId);

        if (shouldColdStartResumeSession) {
          const staleSessionId = ap.sessionId;
          const runtimeLabel = runtimeDisplayName(ap.driver.id);
          const restartConfig = this.buildRestartSafeConfig(ap.config, null);
          if (staleSessionId) rememberSessionContext(ap.cliTransportDir, staleSessionId, null);
          if (staleSessionId) this.sendToServer({ type: "agent:session:invalidate", agentId, sessionId: staleSessionId, launchId: ap.launchId || undefined, reason: resumeRecoveryReason });
          const reasonText = resumeRecoveryReason === "provider_replay_rejected" ? "was rejected by the provider during replay" : "is unavailable locally";
          const activityText = resumeRecoveryReason === "provider_replay_rejected"
            ? `Stored ${runtimeLabel} session replay rejected; cold-starting a new session…`
            : `Stored ${runtimeLabel} session missing; cold-starting a new session…`;
          logger.warn(
            `[Agent ${agentId}] Stored ${runtimeLabel} session ${staleSessionId} ${reasonText}; falling back to cold start`,
          );
          this.broadcastActivity(
            agentId,
            "working",
            activityText,
            [{
              kind: "text",
              text: `Stored ${runtimeLabel} session ${staleSessionId} ${reasonText}. Falling back to a cold start; earlier runtime context may not be restored.`,
            }],
            undefined,
            "runtime_unavailable",
          );
          this.lifecycleRecords.setPendingSpawnCause(agentId, "restart_crash");
          const coldStartCarriedMessages = ap.inbox
            .splice(0)
            .filter((message) => !this.isTransientDelivery(message));
          const coldStartPromise = this.startAgent(
            agentId,
            restartConfig,
            ap.startup.wakeMessage,
            ap.startup.unreadSummary,
            ap.startup.resumePrompt,
            ap.launchId || undefined,
          );
          if (coldStartCarriedMessages.length > 0) {
            this.startingInboxes.bufferMessagesDuringStart(agentId, coldStartCarriedMessages);
            this.assertStartPendingDeliveryInvariants("cold-start-pending-inbox-transfer");
          }
          coldStartPromise.catch((err) => {
            logger.error(`[Agent ${agentId}] Cold start recovery failed`, err);
            this.recordInboxDroppedOnExit(agentId, ap, "cold_start_failed", coldStartCarriedMessages);
            // The status transition + crash broadcast below trace the OUTCOME;
            // this span preserves the bounded identity of the exception that
            // failed the recovery start itself.
            this.recordDaemonEvent("daemon.agent.cold_start_recovery_failed", {
              agentId,
              launchId: ap.launchId || undefined,
              outcome: "error",
              reason: "cold_start_recovery_threw",
              error_class: errorClassOf(err),
            }, "error");
            this.lifecycleRecords.deletePendingSpawnCause(agentId);
            this.sendAgentStatus(agentId, "inactive", ap.launchId, { code: code ?? null, signal: signal ?? null });
            this.broadcastActivity(agentId, "offline", `Crashed (${summary})`, [], ap.launchId, "runtime_crashed", undefined, undefined, buildClaudeStartupCrashRuntimeError(ap, closeBeforeTurnBoundary));
          });
          return;
        }

        if (processEndedCleanly) {
          const pendingRestartMessages = ap.inbox
            .splice(0)
            .filter((message) => !this.isTransientDelivery(message));
          let queuedWakeMessage: AgentMessage | undefined;
          const bufferedRestartMessages: AgentMessage[] = [];
          for (const message of pendingRestartMessages) {
            if (!queuedWakeMessage && !this.isNotifiedDeferralAtColdIdleStop(ap, expectedTerminationReason, message) && !this.shouldDeferWakeMessage(agentId, ap.driver, message)) {
              queuedWakeMessage = message;
            } else {
              bufferedRestartMessages.push(message);
            }
          }

          if (queuedWakeMessage) {
            logger.info(`[Agent ${agentId}] Turn completed; restarting immediately for queued message`);
            const nextConfig = this.buildRestartSafeConfig(ap.config, ap.sessionId);
            this.lifecycleRecords.setRestartSnapshot(agentId, {
              config: nextConfig,
              sessionId: ap.sessionId,
              launchId: ap.launchId,
              processInstanceId: ap.processInstanceId,
            });
            this.lifecycleRecords.deleteRestartSnapshot(agentId);
            if (expectedTerminationReason === "stalled_recovery") {
              this.lifecycleRecords.setPendingSpawnCause(agentId, "restart_stall");
            }
            const startPromise = this.startAgent(agentId, nextConfig, queuedWakeMessage, undefined, undefined, ap.launchId || undefined);
            if (bufferedRestartMessages.length > 0) {
              this.startingInboxes.bufferMessagesDuringStart(agentId, bufferedRestartMessages);
              this.assertStartPendingDeliveryInvariants("clean-exit-pending-inbox-transfer");
            }
            startPromise.catch((err) => {
              logger.error(`[Agent ${agentId}] Failed to continue with queued message`, err);
              if (this.reportRunnerCredentialMintFailure(agentId, err, ap.launchId, "queued_continuation")) {
                this.lifecycleRecords.setRestartSnapshot(agentId, {
                  config: nextConfig,
                  sessionId: ap.sessionId,
                  launchId: ap.launchId,
                  processInstanceId: ap.processInstanceId,
                });
                const report = this.recordSpawnFailure(agentId, "runner_credential_mint");
                this.assertStartPendingDeliveryInvariants("queued-continuation-runner-credential-mint-failure");
                if (report.backoffActive) {
                  this.enterSpawnFailCooldownResidency(agentId, { config: nextConfig, launchId: ap.launchId }, report.untilMs, "queued_continuation", "runner_credential_mint");
                }
                this.recordDaemonEvent("daemon.agent.spawn.fail_backoff", {
                  agentId,
                  source: "queued_continuation",
                  reason: "runner_credential_mint",
                  attempts: report.attempts,
                  cooldown_active: report.backoffActive,
                  until_ms: report.untilMs,
                });
                return;
              }
              this.lifecycleRecords.setRestartSnapshot(agentId, {
                config: nextConfig,
                sessionId: ap.sessionId,
                launchId: ap.launchId,
                processInstanceId: ap.processInstanceId,
              });
              this.broadcastActivity(agentId, "online", "Process idle", [], undefined, "idle");
            });
            return;
          }

          this.recordInboxDroppedOnExit(
            agentId,
            ap,
            expectedTerminationReason === "cold_idle_recycle" ? "cold_idle_recycle" : "clean_exit_deferred",
            bufferedRestartMessages,
          );
          // Normal exit (turn completed, idle timeout) — daemon is still online and can
          // restart the process on next message, so keep status active.
          // Cache config so we can auto-restart when a new message arrives.
          this.lifecycleRecords.setRestartSnapshot(agentId, {
            config: this.buildRestartSafeConfig(ap.config, ap.sessionId),
            sessionId: ap.sessionId,
            launchId: ap.launchId,
            processInstanceId: ap.processInstanceId,
          });
          if (!ap.driver.supportsStdinNotification) {
            logger.info(`[Agent ${agentId}] Turn completed; cached idle state for future restart`);
          }
          this.broadcastActivity(agentId, "online", "Process idle", [], undefined, "idle");
          this.wakeForAppInboxNoticeAfterTurn(agentId);
        } else {
          // Crash (non-zero) or killed by signal (code === null) while still in map
          const reason = formatCrashReason(finalCode, finalSignal, ap);
          const recoverableProcessCloseReason = recoverableRuntimeProcessCloseReason(
            ap.lastRuntimeError || reason,
            terminalFailureDetail,
            stickyTerminalFailureDetail,
          );

          if (recoverableProcessCloseReason) {
            const pendingRestartMessages = ap.inbox
              .splice(0)
              .filter((message) => !this.isTransientDelivery(message));
            let queuedWakeMessage: AgentMessage | undefined;
            const bufferedRestartMessages: AgentMessage[] = [];
            for (const message of pendingRestartMessages) {
              if (!queuedWakeMessage && !this.isNotifiedDeferralAtColdIdleStop(ap, expectedTerminationReason, message) && !this.shouldDeferWakeMessage(agentId, ap.driver, message)) {
                queuedWakeMessage = message;
              } else {
                bufferedRestartMessages.push(message);
              }
            }
            this.lifecycleRecords.setRestartSnapshot(agentId, {
              config: this.buildRestartSafeConfig(ap.config, ap.sessionId),
              sessionId: ap.sessionId,
              launchId: ap.launchId,
              processInstanceId: ap.processInstanceId,
            });
            if (queuedWakeMessage) {
              this.armRuntimeErrorProcessRestart(agentId, ap, recoverableProcessCloseReason, queuedWakeMessage, bufferedRestartMessages);
              logger.warn(`[Agent ${agentId}] Recoverable runtime error (${reason}) — retrying after backoff`);
            } else {
              logger.warn(`[Agent ${agentId}] Recoverable runtime error (${reason}) — keeping agent wakeable`);
              this.recordInboxDroppedOnExit(agentId, ap, "recoverable_error_no_wake", bufferedRestartMessages);
              this.sendAgentStatus(agentId, "active", ap.launchId);
            }
          } else if (terminalFailureDetail && isProviderStreamFailureText(terminalFailureDetail.detail)) {
            this.lifecycleRecords.setRestartSnapshot(agentId, {
              config: this.buildRestartSafeConfig(ap.config, ap.sessionId),
              sessionId: ap.sessionId,
              launchId: ap.launchId,
              processInstanceId: ap.processInstanceId,
            });
            logger.warn(`[Agent ${agentId}] Recoverable provider stream failure (${reason}) — keeping agent wakeable`);
            this.recordInboxDroppedOnExit(agentId, ap, "provider_stream_failure", ap.inbox.splice(0));
            this.sendAgentStatus(agentId, "active", ap.launchId);
          } else if (startupTimeoutTermination) {
            this.cacheStartupTimeoutRetryConfig(agentId, ap);
            logger.warn(`[Agent ${agentId}] Startup timeout cleanup completed (${reason})`);
            this.recordInboxDroppedOnExit(agentId, ap, "startup_timeout", ap.inbox.splice(0));
          } else if (startupRequestErrorTermination) {
            this.lifecycleRecords.deleteRestartSnapshot(agentId);
            this.resetRuntimeErrorFingerprintFenceIfNonresident(agentId, "startup_request_error_cleanup", ap);
            logger.warn(`[Agent ${agentId}] Startup request failure cleanup completed (${reason})`);
            this.recordInboxDroppedOnExit(agentId, ap, "startup_request_error", ap.inbox.splice(0));
          } else {
            // Non-recoverable crash → mark inactive to prevent crash loops. User/server can restart explicitly.
            this.lifecycleRecords.deleteRestartSnapshot(agentId);
            this.resetRuntimeErrorFingerprintFenceIfNonresident(agentId, "nonrecoverable_process_close", ap);
            logger.error(`[Agent ${agentId}] Process crashed (${reason}) — marking inactive`);
            this.recordInboxDroppedOnExit(agentId, ap, "nonrecoverable_crash", ap.inbox.splice(0));
            this.sendAgentStatus(agentId, "inactive", ap.launchId, { code: code ?? null, signal: signal ?? null });
          }
          if (terminalFailureDetail) {
            if (!startupTimeoutTermination && !startupRequestErrorTermination) {
              const { detail: visibleDetail, entries: visibleEntries } = buildBoundedVisibleCrashProjection(terminalFailureDetail.detail, terminalFailureDetail.entries);
              this.broadcastActivity(
                agentId,
                "error",
                visibleDetail,
                visibleEntries,
                ap.launchId,
                "runtime_error",
                undefined,
                undefined,
                buildClaudeStartupCrashRuntimeError(ap, closeBeforeTurnBoundary),
              );
            }
          } else if (!startupRequestErrorTermination) {
            this.broadcastActivity(agentId, "offline", `Crashed (${summary})`, [], ap.launchId, "runtime_crashed", undefined, undefined, buildClaudeStartupCrashRuntimeError(ap, closeBeforeTurnBoundary));
          }
        }
      }
    });

    let startResult: RuntimeSendResult;
    // task #1120: keep the driver's typed launch failure so the classifier can
    // decide by code; the flattened `error` string is for logs/diagnostics only.
    let startFailureCause: unknown = undefined;
    // RFC 071 outbox: persist the open record, then spawn. Every runtime
    // process (server start, respawn, restart) is created here, internal
    // starts without a server launchId included (keyed by processInstanceId).
    if (this.runtimeProcessGate && this.daemonInstanceId
      && !this.runtimeProcessGate.openProcess(agentId, processInstanceId, effectiveLaunchId)) {
      throw new RuntimeOutcomeStorageBlockedError(agentId);
    }
    try {
      startResult = await this.runtimeProcessBindingFence.start(
        agentId,
        agentProcess,
        { text: prompt, sessionId: effectiveConfig.sessionId || null },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      startFailureCause = error;
      startResult = { ok: false, reason: "runtime_error", error: message };
    }
    if (!startResult.ok && typeof runtime.pid === "number") {
      // RFC 071 negative control: the start failed but a child process was
      // created. It is reported as spawned (its exit follows), never as
      // not_spawned.
      this.sendProcessSpawned(agentId, agentProcess, effectiveLaunchId);
    }
    if (!startResult.ok) {
      const diagnostics = startResult.error ? buildRuntimeErrorDiagnosticEnvelope(startResult.error) : null;
      this.recordDaemonEvent("daemon.agent.runtime_start.failed", {
        ...this.agentStartDispatch.traceAttrs(agentId, effectiveConfig, wakeMessage, unreadSummary, resumePrompt, agentProcess.launchId || undefined, wakeMessageTransient, undefined, startDispatchId),
        runtime_start_reason: startResult.reason,
        error_present: Boolean(startResult.error),
        runtime_error_class: diagnostics?.spanAttrs.runtime_error_class,
      }, "error", spawnTraceparent);
      if (startResult.error) {
        agentProcess.lastRuntimeError = startResult.error;
        agentProcess.decisionErrorWindow.recordRuntimeError(startResult.error);
      }
      if (startResult.error && diagnostics?.spanAttrs.runtime_error_action_required === true) {
        const terminalFailure = classifyTerminalFailure(agentProcess);
        const visibleErrorMessage = terminalFailure?.detail ?? formatRuntimeActionRequiredMessage(agentProcess, startResult.error);
        this.broadcastActivity(agentId, "error", visibleErrorMessage, [
          ...(terminalFailure?.entries ?? [{ kind: "text", text: `Error: ${visibleErrorMessage}` }]),
        ], agentProcess.launchId, "runtime_error");
      } else if (diagnostics?.spanAttrs.runtime_error_class === "InputTooLargeError") {
        const visibleErrorMessage = formatRuntimeInputTooLargeMessage(agentProcess.driver.id);
        this.broadcastActivity(agentId, "error", visibleErrorMessage, [
          { kind: "text", text: `Error: ${visibleErrorMessage}` },
        ], agentProcess.launchId, "runtime_error");
      }
      const visibleStartError = diagnostics?.spanAttrs.runtime_error_class === "InputTooLargeError"
        ? formatRuntimeInputTooLargeMessage(agentProcess.driver.id)
        : startResult.error;
      throw new RuntimeSessionStartError(
        `Runtime session failed to start: ${startResult.reason}${visibleStartError ? ` (${visibleStartError})` : ""}`,
        startFailureCause,
      );
    }
    // RFC 071 §4.3 rule 2: the identity of the process this launch spawned.
    this.sendProcessSpawned(agentId, agentProcess, effectiveLaunchId);
    const startupAcceptedMessages = wakeMessage ? [wakeMessage] : resumeCatchupInputMessages.length > 0 ? resumeCatchupInputMessages : startingInboxMessages;
    if (this.containsOrdinaryInboxMessage(startupAcceptedMessages)) this.broadcastMessageReceivedActivity(agentId);
    this.closeNoProcessResidency(agentId, "advanced");
    if (this.lifecycleRecords.deleteTerminalFailure(agentId)) {
      this.closeNoProcessResidency(agentId, "advanced", { negativeEvidenceBucket: "terminal_recovery_start_succeeded" });
    }
    this.assertStartPendingDeliveryInvariants("spawn-drain");
    this.recordDaemonEvent("daemon.agent.spawn.created", {
      ...this.agentStartDispatch.traceAttrs(agentId, effectiveConfig, wakeMessage, unreadSummary, resumePrompt, agentProcess.launchId || undefined, wakeMessageTransient, undefined, startDispatchId),
      detached: false,
      new_session: false,
      process_pid_present: typeof runtime.pid === "number",
    }, "ok", spawnTraceparent);
    const pendingCause = this.lifecycleRecords.getPendingSpawnCause(agentId);
    this.lifecycleRecords.deletePendingSpawnCause(agentId);
    const startCause = pendingCause
      ?? (isResume ? "session_resume" : wakeMessage ? "wake_message" : "explicit_start");
    this.recordDaemonEvent("daemon.runtime.process.spawn", {
      ...this.processLifecycleIdentityAttrs(agentId, agentProcess),
      start_dispatch_id: startDispatchId,
      start_cause: startCause,
      credential_type: effectiveConfig.agentCredentialKey ? "managed_runner" : "legacy_machine",
      session_id_present: Boolean(agentProcess.sessionId),
      launch_id_present: Boolean(agentProcess.launchId),
    }, "ok", spawnTraceparent);

    this.sendAgentStatus(agentId, "active", agentProcess.launchId);
    if (pendingStartRebind && agentProcess.sessionId) {
      this.sendToServer({ type: "agent:session", agentId, sessionId: agentProcess.sessionId, launchId: agentProcess.launchId || undefined });
    }
    this.broadcastActivity(agentId, "working", "Starting\u2026", [], undefined, "starting");
    this.startRuntimeStartupTimeout(agentId, agentProcess, startCause);

    // Phase-6 activation delivery: open the wait when this launch carries an
    // initial activation (wake / buffered inbox). When that activation was
    // folded into the spawn prompt it is delivered synchronously here \u2014 close
    // advanced(spawn_prompt). Otherwise (transient wake / resume / deferred) it
    // is delivered post-ready via stdin, so leave the row open until then.
    if (wakeMessage || startingInboxMessages.length > 0) {
      this.openActivationTransition(agentId, agentProcess, startCause);
      if (wakeMessageDeliveredAsInboxUpdate || startingInboxDeliveredAsInput) {
        this.closeActivationTransition(agentProcess, "advanced", "spawn_prompt");
      }
    }

    // A start that arrived while this spawn was being prepared, after the
    // deferred rebind above was taken, is still pending. The server armed its
    // launch guard for that newer launch, so unless this process carries it,
    // every frame of this launch is dropped as stale until the server restarts.
    const lateStartRebind = this.lifecycleRecords.getPendingStartRebind(agentId);
    if (lateStartRebind) {
      this.lifecycleRecords.deletePendingStartRebind(agentId);
      this.rebindRunningStart(agentId, lateStartRebind, "already_starting_late");
    }

    } catch (err) {
      // RFC 071: every launch still waiting has no process: either no child
      // was created, or it was folded after the child was reported (then it
      // was never carried by it).
      this.settleAllAcceptedLaunches(agentId, err instanceof RuntimeOutcomeStorageBlockedError ? "terminal_failure_outcome_storage_blocked" : "spawn_failed");
      // Never reported spawned: no process exists and no process_exited will
      // close its open record, so close it now (else a restart reads it as unknown).
      if (agentProcess && !agentProcess.spawnReported && this.runtimeProcessGate && this.daemonInstanceId) {
        this.runtimeProcessGate.processNotStarted(agentId, agentProcess.processInstanceId);
      }
      this.agentStarts.clearStarting(agentId);
      this.closeNoProcessResidency(agentId, "terminal", { negativeEvidenceBucket: "runtime_start_failed" });
      this.lifecycleRecords.deletePendingStartRebind(agentId);
      this.cleanupFailedRuntimeStart(agentId, agentProcess, err);
      throw err;
    }
  }

  private async cleanupStoppedRuntimeStart(agentId: string, ap: AgentProcess): Promise<void> {
    if (this.agents.get(agentId) !== ap) return;

    this.agentStarts.clearStarting(agentId);
    this.lifecycleRecords.deletePendingStartRebind(agentId);
    this.lifecycleRecords.deletePendingSpawnCause(agentId);
    this.lifecycleRecords.deleteRestartSnapshot(agentId);
    this.startingInboxes.cancelStart(agentId);
    ap.notifications.clearTimer();
    this.disposeAgentProcessTimers(ap);
    this.closeRuntimeReadinessTransition(ap, "terminal");
    this.closeActivationTransition(ap, "terminal");
    cleanupLaunchProxies(agentId);
    this.revokeManagedRunnerCredential(agentId, ap.config, ap.launchId);
    this.agents.delete(agentId);
    this.closeNoProcessResidency(agentId, "suppressed", { negativeEvidenceBucket: "explicit_stop" });
    this.assertStartPendingDeliveryInvariants("runtime-start-stop-epoch-fence");
    this.runtimeExitTraceAttrs.set(ap.runtime, {
      stop_source: "explicit_request",
      stop_wait_requested: false,
      stop_silent: false,
      stop_epoch_fence: true,
    });
    try {
      await ap.runtime.stop({ signal: "SIGTERM", reason: "explicit_request" });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`[Agent ${agentId}] Failed to stop runtime suppressed by stop epoch: ${reason}`);
    }
    logger.info(`[Agent ${agentId}] Runtime start discarded after stop request`);
  }

  private suppressFailedRestartAfterStop(agentId: string, stopEpochAtRestart: number, source: string): boolean {
    if (!this.lifecycleRecords.stopEpochChanged(agentId, stopEpochAtRestart)) return false;

    this.lifecycleRecords.deleteRestartSnapshot(agentId);
    this.lifecycleRecords.deletePendingStartRebind(agentId);
    this.lifecycleRecords.deletePendingSpawnCause(agentId);
    this.startingInboxes.cancelStart(agentId);
    this.closeNoProcessResidency(agentId, "suppressed", { negativeEvidenceBucket: "explicit_stop" });
    this.assertStartPendingDeliveryInvariants(`${source}-stop-epoch-fence`);
    logger.info(`[Agent ${agentId}] Failed ${source} restart suppressed after stop request`);
    return true;
  }

  private cleanupFailedRuntimeStart(agentId: string, ap: AgentProcess | null, err: unknown): void {
    if (!ap) return;
    if (this.agents.get(agentId) !== ap) return;

    ap.notifications.clearTimer();
    this.disposeAgentProcessTimers(ap);
    this.closeRuntimeReadinessTransition(ap, "terminal");
    this.closeActivationTransition(ap, "terminal");
    this.endRuntimeTrace(ap, "error", {
      outcome: "runtime-start-failed",
      failure_detail: err instanceof Error ? err.message : String(err),
      ...runtimeTraceCounterAttrs(ap),
      ...this.finalizeRuntimeProfileTurnControl(agentId, ap, "runtime_error"),
    });
    cleanupLaunchProxies(agentId);
    this.revokeManagedRunnerCredential(agentId, ap.config, ap.launchId);
    this.agents.delete(agentId);
    this.lifecycleRecords.deleteRestartSnapshot(agentId);
    if (this.lifecycleRecords.deleteTerminalFailure(agentId)) {
      this.closeNoProcessResidency(agentId, "terminal", { negativeEvidenceBucket: "runtime_start_failed" });
    }
    this.resetRuntimeErrorFingerprintFenceIfNonresident(agentId, "runtime_start_failed_cleanup", ap);
  }

  private cleanupTerminalRuntimeFailure(
    agentId: string,
    ap: AgentProcess,
    detail: string,
    failure: TerminalRuntimeFailureEvidence,
  ): void {
    if (this.agents.get(agentId) !== ap) return;
    // RFC 071 §7 E1: the one choke point for every terminal cleanup. Sent
    // BEFORE the registry entry is deleted, while launchId/sessionId are
    // still readable (test W-1).
    this.sendRuntimeOutcome(agentId, ap, {
      kind: "terminal_failure",
      failureKind: failure.failureKind,
      fingerprint: failure.fingerprint,
      errorClass: failure.errorClass,
    });

    ap.notifications.clear();
    this.disposeAgentProcessTimers(ap);
    this.closeRuntimeReadinessTransition(ap, "terminal");
    this.closeActivationTransition(ap, "terminal");
    cleanupLaunchProxies(agentId);
    this.revokeManagedRunnerCredential(agentId, ap.config, ap.launchId);
    this.lifecycleRecords.deleteRestartSnapshot(agentId);
    if (ap.inbox.length > 0) {
      this.startingInboxes.bufferMessagesDuringStart(agentId, ap.inbox);
    }
    this.agents.delete(agentId);
    this.lifecycleRecords.setTerminalFailure(agentId, { detail, launchId: ap.launchId });
    this.enterNoProcessResidency(
      "terminal_runtime_error",
      this.noProcessResidencyIdentity(agentId, ap.config, ap.launchId, "terminal_runtime_error", ap.driver.id),
      {
        isWaitState: false,
        failureKind: "terminal_runtime_error",
        negativeEvidenceBucket: "terminal_runtime_error",
      },
    );
    this.assertStartPendingDeliveryInvariants("terminal-runtime-failure-cleanup");

    const diagnostics = buildRuntimeErrorDiagnosticEnvelope(detail);
    // task #352 — attribute the SIGTERM in runner.log by the raw runtime error.
    // RFC 071: every caller now passes the raw-text evidence it sent as E1.
    const sourceFingerprint = failure.fingerprint;
    const sourceClass = failure.errorClass;
    logger.warn(
      `[Agent ${agentId}] ${ap.driver.id} terminal runtime error cleanup: `
      + `class=${sourceClass} fingerprint=${sourceFingerprint} `
      + `inbox=${ap.inbox.length} pending_notifications=${ap.notifications.pendingCount}; terminating runtime process (SIGTERM)`,
    );
    this.recordDaemonEvent("daemon.agent.terminal_runtime_error.cleanup", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      model: ap.config.model,
      session_id_present: Boolean(ap.sessionId),
      process_pid_present: typeof ap.runtime.pid === "number",
      inbox_count: ap.inbox.length,
      pending_notification_count: ap.notifications.pendingCount,
      runtime_error_class: diagnostics.spanAttrs.runtime_error_class,
    }, "error");
    this.runtimeExitTraceAttrs.set(ap.runtime, {
      stop_source: "terminal_runtime_error",
      runtime_error_class: diagnostics.spanAttrs.runtime_error_class,
    });
    void ap.runtime.stop({ signal: "SIGTERM", reason: "terminal_runtime_error" }).catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`[Agent ${agentId}] Failed to terminate ${ap.driver.id} after terminal runtime error: ${reason}`);
    });
  }

  private cacheStartupTimeoutRetryConfig(agentId: string, ap: AgentProcess): void {
    const retrySessionId = this.restartSafeSessionId(ap);
    const retryConfig = this.buildRestartSafeConfig(ap.config, retrySessionId);
    this.lifecycleRecords.setRestartSnapshot(agentId, {
      config: retryConfig,
      sessionId: retrySessionId,
      launchId: ap.launchId,
      processInstanceId: ap.processInstanceId,
    });
    this.recordDaemonEvent("daemon.agent.startup_timeout.retry_config_cached", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      session_id_present: Boolean(ap.sessionId),
    });
  }

  private buildRestartSafeConfig(config: AgentConfig, sessionId: string | null): AgentConfig {
    const stripped = stripManagedRunnerCredential(config);
    return {
      ...stripped,
      serverUrl: this.serverUrl,
      sessionId,
    };
  }

  private async buildSpawnConfig(agentId: string, config: AgentConfig): Promise<AgentConfig> {
    // The daemon's live connection target is authoritative for agent-side chat
    // bridge / CLI callbacks even when server config points at another origin.
    const baseConfig = config.serverUrl === this.serverUrl
      ? config
      : { ...config, serverUrl: this.serverUrl };
    const runnerConfig = await materializeProviderConnectionForSpawn(await this.ensureManagedRunnerCredential(agentId, baseConfig), { serverUrl: this.serverUrl, daemonApiKey: this.daemonApiKey, agentId });
    let effectiveConfig = runnerConfig;
    if (this.defaultAgentEnvVarsProvider) {
      try {
        const defaultEnvVars = await this.defaultAgentEnvVarsProvider({
          runtime: runnerConfig.runtime,
          model: runnerConfig.model,
          envVars: runnerConfig.envVars,
        });
        const mergedEnvVars = { ...(defaultEnvVars ?? {}), ...(runnerConfig.envVars ?? {}) };
        if (!this.sameEnvVars(mergedEnvVars, runnerConfig.envVars)) {
          effectiveConfig = { ...runnerConfig, envVars: mergedEnvVars };
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn(
          `[Agent ${agentId}] Failed to resolve default runtime env vars — continuing without machine-level defaults (${reason})`,
        );
      }
    }
    // task #359: the server's passive_ax flag composed with the local
    // RAFT_PASSIVE_AX kill switch (agent env_vars over process env). The
    // context-generation writer reads the effective value from here.
    const passiveAx = resolvePassiveAx(effectiveConfig.passiveAx, effectiveConfig.envVars);
    if ((effectiveConfig.passiveAx === true) !== passiveAx) {
      effectiveConfig = { ...effectiveConfig, passiveAx };
    }
    return effectiveConfig;
  }

  private async requestManagedRunnerCredentialOnce(agentId: string, config: AgentConfig): Promise<{ apiKey: string; credentialId: string | null }> {
    const url = new URL(`/internal/computer/runners/${encodeURIComponent(agentId)}/credentials`, this.serverUrl);
    const res = await daemonFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.daemonApiKey}`,
        "Content-Type": "application/json",
        "X-Raft-Client": "daemon-server-session-worker",
      },
      body: JSON.stringify({
        scopes: ["send", "read", "mentions", "tasks", "reactions", "server", "channels", "knowledge", "mcp"],
        name: `runner:${config.runtime}:${agentId.slice(0, 8)}`,
      }),
    });
    if (!res.ok) {
      const contentType = res.headers.get("content-type") ?? "";
      let detail = `HTTP ${res.status}`;
      let code: string | null = null;
      if (contentType.includes("application/json")) {
        const body = await res.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
        const error = typeof body?.error === "string" ? body.error : null;
        code = typeof body?.code === "string" ? body.code : null;
        detail = [detail, code, error].filter(Boolean).join(" ");
      }
      throw new RunnerCredentialMintError(detail, {
        code: code ?? "runner_credential_mint_http_error",
        retryable: isRetryableMintHttpFailure(res.status, code),
        status: res.status,
      });
    }

    const body = await res.json().catch(() => null) as { apiKey?: unknown; credentialId?: unknown } | null;
    if (typeof body?.apiKey !== "string" || !body.apiKey.startsWith("sk_agent_")) {
      throw new RunnerCredentialMintError("invalid_agent_credential_payload", {
        code: "invalid_agent_credential_payload",
      });
    }
    return {
      apiKey: body.apiKey,
      credentialId: typeof body.credentialId === "string" ? body.credentialId : null,
    };
  }

  private async ensureManagedRunnerCredential(agentId: string, config: AgentConfig): Promise<AgentConfig> {
    if (config.agentCredentialKey) return config;
    const span = this.tracer.startSpan("daemon.runner_credential_mint", {
      parent: getActiveTraceContext(),
      surface: "daemon",
      kind: "client",
      attrs: { agentId, runtime: config.runtime },
    });
    try {
      const nextConfig = await this.mintManagedRunnerCredentialWithRetry(agentId, config, formatTraceparent(span.context));
      span.end("ok");
      return nextConfig;
    } catch (err) {
      span.end("error", { attrs: { error_class: errorClassOf(err) } });
      throw err;
    }
  }

  private async mintManagedRunnerCredentialWithRetry(
    agentId: string,
    config: AgentConfig,
    mintTraceparent: string,
  ): Promise<AgentConfig> {
    if (process.env.SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED === "1") {
      throw new RunnerCredentialMintError("runner credential mint is disabled by SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED", {
        code: "runner_credentials_disabled",
      });
    }

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS; attempt += 1) {
      try {
        const credential = await this.requestManagedRunnerCredentialOnce(agentId, config);
        return {
          ...config,
          agentCredentialKey: credential.apiKey,
          agentCredentialId: credential.credentialId,
        };
      } catch (err) {
        lastError = err;
        const detail = runnerCredentialErrorDetail(err);
        this.recordDaemonEvent("daemon.runner_credential_mint.retry", {
          agentId,
          runtime: config.runtime,
          attempt,
          max_attempts: RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS,
          http_status: detail.status,
          code: detail.code,
          reason: detail.message,
          retryable: detail.retryable,
        }, detail.retryable && attempt < RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS ? "ok" : "error", mintTraceparent);
        if (!detail.retryable || attempt >= RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS) break;
        await waitForRunnerCredentialRetry();
      }
    }

    const detail = runnerCredentialErrorDetail(lastError);
    this.recordDaemonEvent("daemon.runner_credential_mint.failed", {
      agentId,
      runtime: config.runtime,
      http_status: detail.status,
      code: detail.code,
      reason: detail.message,
      retryable: detail.retryable,
      max_attempts: RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS,
    }, "error", mintTraceparent);
    throw new RunnerCredentialMintError(
      `runner_credential_mint_failed: ${detail.message}. Managed runner startup requires /internal/computer credential mint; deploy server first or roll back the daemon binary.`,
      {
        code: detail.code,
        retryable: detail.retryable,
        status: detail.status,
      },
    );
  }

  private revokeManagedRunnerCredential(agentId: string, config: AgentConfig, launchId: string | null): void {
    const credentialId = config.agentCredentialId;
    if (!credentialId) return;
    const url = new URL(
      `/internal/computer/runners/${encodeURIComponent(agentId)}/credentials/${encodeURIComponent(credentialId)}`,
      this.serverUrl,
    );
    // Through the injectable fetch (defaults to daemonFetch) so tests that fake
    // the server see the DELETE instead of it leaving the process; the module
    // -level call used to send real requests from every stop under test.
    void this.fetchImpl(url.toString(), {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.daemonApiKey}`,
        "X-Raft-Client": "daemon-server-session-worker",
      },
    }).then((res) => {
      this.recordDaemonEvent("daemon.runner_credential.revoke", {
        agentId,
        launchId: launchId || undefined,
        credentialId,
        http_status: res.status,
      }, res.ok ? "ok" : "error");
    }).catch((err) => {
      this.recordDaemonEvent("daemon.runner_credential.revoke", {
        agentId,
        launchId: launchId || undefined,
        credentialId,
        reason: err instanceof Error ? err.message : String(err),
      }, "error");
    });
  }

  private sameEnvVars(left: Record<string, string> | null | undefined, right: Record<string, string> | null | undefined): boolean {
    const leftKeys = Object.keys(left ?? {});
    const rightKeys = Object.keys(right ?? {});
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    return leftKeys.every((key) => left?.[key] === right?.[key]);
  }

  private enqueueRuntimeProfileNotification(agentId: string, ap: AgentProcess, message: AgentMessage, kind: "migration" | "daemon_release_notice", key: string): void {
    const queued = queueAgentInboxMessage(ap, message);
    if (!queued.duplicate && ap.driver.supportsStdinNotification && ap.sessionId) {
      ap.notifications.add();
      if (!ap.notifications.hasTimer) {
        this.scheduleStdinNotification(agentId, ap, STDIN_NOTIFICATION_INITIAL_DELAY_MS);
      }
    }
    this.recordDaemonEvent("daemon.agent.runtime_profile.routed", {
      agentId,
      kind,
      key_present: Boolean(key),
      key_hash: hashRuntimeProfileKey(key),
      outcome: ap.sessionId ? "queued_busy" : "queued_before_session",
      runtime: ap.config.runtime,
      session_id_present: Boolean(ap.sessionId),
      launchId: ap.launchId || undefined,
      inbox_count: queued.inboxCount,
      duplicate_pending_delivery: queued.duplicate,
      pending_notification_count: ap.notifications.pendingCount,
      busy_delivery_mode: ap.driver.busyDeliveryMode,
      supports_stdin_notification: ap.driver.supportsStdinNotification,
    });
    logger.info(
      `[Agent ${agentId}] Queued runtime profile ${kind} ${key} for ${ap.sessionId ? "busy" : "pre-session"} ${ap.driver.id} delivery`,
    );
  }

  private queueRuntimeProfileNotificationDuringStart(
    agentId: string,
    message: AgentMessage,
    kind: "migration" | "daemon_release_notice",
    key: string,
  ): void {
    const startingInboxCount = this.startingInboxes.bufferDuringStart(agentId, message);
    this.assertStartPendingDeliveryInvariants("runtime-profile-during-start");
    const queuedStart = this.agentStarts.getQueued(agentId);
    this.recordDaemonEvent("daemon.agent.runtime_profile.routed", {
      agentId,
      kind,
      key_present: Boolean(key),
      key_hash: hashRuntimeProfileKey(key),
      outcome: "queued_during_start",
      startup_pending: true,
      starting_inbox_count: startingInboxCount,
      launchId: queuedStart?.launchId,
    });
    logger.info(`[Agent ${agentId}] Queued runtime profile ${kind} ${key} during startup`);
  }

  private containsOrdinaryInboxMessage(messages: AgentMessage[]): boolean {
    return messages.some((message) => !runtimeProfileNotificationFromMessage(message));
  }

  async stopAgent(agentId: string, { wait = false, silent = false }: { wait?: boolean; silent?: boolean } = {}) {
    const startEpochAtStop = this.lifecycleRecords.startEpoch(agentId);
    this.lifecycleRecords.recordStop(agentId);
    // RFC 071: a start held for the server capability ends now (no spawn).
    this.capabilityHolds.get(agentId)?.cancel();
    this.cancelQueuedAgentStart(agentId, "stop requested");
    this.lifecycleRecords.deletePendingStartRebind(agentId);
    this.lifecycleRecords.deleteRestartSnapshot(agentId);
    this.cancelRuntimeErrorProcessRestart(agentId);
    if (!silent) {
      this.resetSpawnFailBackoff(agentId, "suppressed");
    }
    if (this.lifecycleRecords.deleteTerminalFailure(agentId)) {
      this.closeNoProcessResidency(agentId, "suppressed", { negativeEvidenceBucket: "explicit_stop" });
    }
    const ap = this.agents.get(agentId);
    if (!ap) {
      // No process: the residency facts above are gone, so any start-pending
      // delivery buffered under terminal-recovery or cooldown residency would
      // now be an orphan (I4). Explicit stop is a user-driven lifecycle
      // boundary: drop the local buffer (the Server keeps the messages) and
      // prove the manager-wide invariants still hold before returning
      // (task #1102: this exact orphan took a whole machine offline).
      const droppedCount = this.startingInboxes.count(agentId);
      if (droppedCount > 0) {
        this.startingInboxes.cancelStart(agentId);
        this.recordDaemonEvent("daemon.agent.start_pending.dropped_on_stop", {
          agentId,
          dropped_count: droppedCount,
          silent,
        });
      }
      this.assertStartPendingDeliveryInvariants(silent ? "silent-stop-no-process" : "stop-no-process");
      if (!silent) {
        logger.info(`[Agent ${agentId}] Stop requested but no running process was found${droppedCount > 0 ? ` (dropped ${droppedCount} pending message(s))` : ""}`);
      }
      return;
    }

    ap.notifications.clearTimer();
    this.disposeAgentProcessTimers(ap);

    cleanupLaunchProxies(agentId);
    this.revokeManagedRunnerCredential(agentId, ap.config, ap.launchId);
    this.agents.delete(agentId);
    this.recordInboxDroppedOnExit(agentId, ap, silent ? "silent_stop" : "explicit_stop", ap.inbox.splice(0));
    if (!silent) {
      // Activity clientSeq belongs to the ingest generation, not one runtime
      // child. Launchless Stop/Start keeps daemonInstanceId, so resetting here
      // reopens 1 in the same dedup namespace. Preserve it for this manager
      // lifetime; a new manager rotates the daemon generation.
      // CC1 (id-set lifecycle): the per-agent consume-boundary high-water and
      // exact-id dedup set (CL-CC2 visible-state) are never otherwise pruned —
      // without this they grow unbounded across the agent's stop/start churn.
      // This delivery ledger is independent from the activity clientSeq clock
      // above. Only clear it on the explicit user-driven lifecycle boundary.
      // A silent respawn under the SAME launchId must KEEP the set,
      // else a not-yet-boundary-covered set-only id could be re-delivered and
      // miss dedup → re-wakeup (CL-CC2-4 boundary-aware-pruning precondition).
      this.agentVisibleDelivery.clearAgent(agentId);
      // Spawn-fail backoff state: explicit stop = fresh launch = reset counter (otherwise
      // a deliberate user-driven restart sees stale backoff and gets gated). Silent stop
      // preserves to prevent stop/start churn from bypassing the cap (same CC1 reasoning).
      this.resetSpawnFailBackoff(agentId, "suppressed");
      this.resetRuntimeErrorFingerprintFence(agentId, "explicit_stop", ap);
    }
    this.runtimeExitTraceAttrs.set(ap.runtime, {
      stop_source: silent ? "daemon_internal" : "explicit_request",
      stop_wait_requested: wait,
      stop_silent: silent,
    });
    await ap.runtime.stop({
      signal: "SIGTERM",
      forceAfterMs: wait ? 5000 : undefined,
      reason: silent ? "daemon_internal" : "explicit_request",
    });
    if (!silent) {
      // stop() can resolve after a later start has run, queued, or failed.
      // Compare the start generation, not launchId (which can be absent/reused)
      // or current process presence (a failed/idle replacement may be absent).
      if (this.lifecycleRecords.startEpochChanged(agentId, startEpochAtStop)) {
        logger.info(`[Agent ${agentId}] Suppressed stale stop status after replacement start`);
      } else {
        this.sendRuntimeProfileReportFor(agentId, ap.config, ap.sessionId, ap.launchId, "stop");
        // Report status change to server (user-initiated stop)
        this.sendAgentStatus(agentId, "inactive", ap.launchId);
        this.broadcastActivity(agentId, "offline", "Stopped", [], undefined, "stopped");
        logger.info(`[Agent ${agentId}] Stopped by request`);
      }
    }

    if (wait) {
      // Wait for runtime to exit, with the session-level force-kill fallback armed above.
      await new Promise<void>((resolve) => {
        const timeoutTimer = setTimeout(() => {
          if (!silent) {
            logger.warn(`[Agent ${agentId}] Stop timed out; force killing`);
          }
          // The session-level forceAfterMs SIGKILL timer is .unref()'d (won't
          // keep the event loop alive), so it may never fire if the daemon
          // process itself is exiting. Send SIGKILL here to prevent orphan
          // child processes surviving a daemon restart.
          this.recordDaemonEvent("daemon.agent.stop.timeout_sigkill", {
            agent_id: agentId,
            pid: typeof ap.runtime.pid === "number" ? ap.runtime.pid : undefined,
            timeout_ms: 5000,
            reason: "wait_timeout",
            signal: "SIGKILL",
          });
          void ap.runtime.stop({ signal: "SIGKILL" }).catch(() => {});
          resolve();
        }, 5000);
        ap.runtime.on("exit", () => {
          clearTimeout(timeoutTimer);
          resolve();
        });
        // If already exited before we attached the listener
        if (ap.runtime.closed) {
          clearTimeout(timeoutTimer);
          resolve();
        }
      });
    }
  }

  private beginTrackedMentionDelivery(
    agentId: string,
    message: AgentMessage,
    ap: AgentProcess | undefined,
    context: DeliveryTraceContext,
  ): "untracked" | "accepted" | "duplicate_pending" | "duplicate_drained" | "rejected" {
    const tracked = context.mentionDelivery;
    if (!tracked) return "untracked";
    const reject = (code: MentionDeliveryTerminalErrorCode) => {
      context.onMentionTerminalError?.(code);
      return "rejected" as const;
    };
    if (
      !context.deliveryId
      || context.deliveryId !== tracked.occurrenceId
      || tracked.messageId !== message.message_id
    ) {
      return reject("INSTRUMENT_FAILED");
    }
    // task #9: a per_turn runtime (cursor, gemini, copilot) has no process
    // between turns; its idle restart snapshot carries the same identity and
    // the delivery restarts it, so the mention is tracked against that.
    const identity = ap ?? this.noProcessMentionIdentity(agentId);
    if (!identity?.launchId || !identity.sessionId) return reject("IDENTITY_UNKNOWN");
    if (identity.launchId !== tracked.launchId || identity.sessionId !== tracked.sessionId) {
      return reject("IDENTITY_DRIFT");
    }
    const existing = this.trackedMentionDeliveries.get(tracked.occurrenceId);
    if (existing) {
      existing.context = context;
      if (existing.agentId !== agentId || existing.messageId !== tracked.messageId) {
        return reject("INSTRUMENT_FAILED");
      }
      if (existing.state === "drained") return "duplicate_drained";
      // task #9 follow-up: pending, but no process, start or start buffer holds
      // it any more (a continuation restart failed and dropped its input). The
      // redelivery is routed again instead of coalescing into a dead entry.
      if (
        existing.state === "pending"
        && !ap
        && !this.agentStarts.hasStarting(agentId)
        && !this.agentStarts.hasQueued(agentId)
        && !this.startingInboxes.has(agentId)
      ) {
        existing.message = message;
        return "accepted";
      }
      context.onMentionTransition?.("daemon_pending", "coalesced");
      return "duplicate_pending";
    }
    this.trackedMentionDeliveries.set(tracked.occurrenceId, {
      agentId,
      messageId: tracked.messageId,
      message,
      state: "received",
      context,
    });
    context.onMentionTransition?.("daemon_received", "accepted");
    return "accepted";
  }

  /** task #9: pending tracked mentions this process's first input names were told to it. */
  private markTrackedMentionsToldAtStart(agentId: string, processInstanceId: string, messages: readonly AgentMessage[]): void {
    if (messages.length === 0) return;
    const ids = new Set(messages.map((message) => message.message_id));
    for (const tracked of this.trackedMentionDeliveries.values()) {
      if (tracked.agentId === agentId && tracked.state === "pending" && ids.has(tracked.messageId)) {
        tracked.toldProcessInstanceId = processInstanceId;
      }
    }
  }

  /** The identity a delivery will restart an idle agent with, or null when it would not restart it. */
  private noProcessMentionIdentity(agentId: string): { launchId: string | null; sessionId: string | null } | null {
    const restarting = this.restartingIdentities.get(agentId);
    if (restarting) return restarting;
    const lifecycleRecord = this.agentLifecycleRecord(agentId);
    if (lifecycleRecord?.kind !== "idle" && lifecycleRecord?.kind !== "cooldown") return null;
    return { launchId: lifecycleRecord.restartSnapshot.launchId, sessionId: lifecycleRecord.restartSnapshot.sessionId };
  }

  /** A tracked mention the delivery could not hand to any process: terminal, and released. */
  private failTrackedMention(context: DeliveryTraceContext, code: MentionDeliveryTerminalErrorCode): void {
    const occurrenceId = context.mentionDelivery?.occurrenceId;
    if (!occurrenceId || !this.trackedMentionDeliveries.has(occurrenceId)) return;
    this.trackedMentionDeliveries.delete(occurrenceId);
    context.onMentionTerminalError?.(code);
  }

  private markTrackedMentionPending(context: DeliveryTraceContext, outcome: "accepted" | "coalesced" = "accepted"): void {
    const occurrenceId = context.mentionDelivery?.occurrenceId;
    if (!occurrenceId) return;
    const tracked = this.trackedMentionDeliveries.get(occurrenceId);
    if (!tracked) {
      context.onMentionTerminalError?.("INSTRUMENT_FAILED");
      return;
    }
    tracked.state = "pending";
    tracked.context = context;
    context.onMentionTransition?.("daemon_pending", outcome);
  }

  private completeTrackedMentionDelivery(context: DeliveryTraceContext): void {
    const occurrenceId = context.mentionDelivery?.occurrenceId;
    if (!occurrenceId) return;
    const tracked = this.trackedMentionDeliveries.get(occurrenceId);
    if (!tracked) {
      context.onMentionTerminalError?.("INSTRUMENT_FAILED");
      return;
    }
    if (tracked.state !== "drained") {
      tracked.state = "drained";
      tracked.context = context;
      context.onMentionTransition?.("daemon_drained", "accepted");
    }
    context.onMentionAck?.();
  }

  private completePendingTrackedMentions(agentId: string): void {
    for (const tracked of this.trackedMentionDeliveries.values()) {
      if (tracked.agentId !== agentId || tracked.state !== "pending") continue;
      this.completeTrackedMentionDelivery(tracked.context);
    }
  }

  /**
   * task #285: a busy tracked mention waits for the turn boundary. When that
   * boundary writes no fresh notice, the occurrence must still end here —
   * otherwise it stays pending, the agent goes idle with nothing to wake it,
   * and every server re-send of the occurrence lands on `duplicate_pending`
   * and is answered with silence, forever.
   */
  private settleUndeliveredTrackedMentionsAtTurnEnd(agentId: string, ap: AgentProcess): void {
    for (const [occurrenceId, tracked] of [...this.trackedMentionDeliveries.entries()]) {
      if (tracked.agentId !== agentId || tracked.state !== "pending") continue;
      const queued = ap.inbox.find((message) => message.message_id === tracked.messageId);
      // task #9: named in this process's first input → told. Still queued on a
      // per_turn runtime but not yet told → the restart after this turn carries
      // it, and that process's turn end settles it.
      if (tracked.toldProcessInstanceId === ap.processInstanceId) {
        this.completeTrackedMentionDelivery(tracked.context);
        continue;
      }
      if (queued && ap.driver.lifecycle.kind === "per_turn") continue;
      // Still queued: told only if its notice reached this session. Gone from the inbox: told
      // only if the runtime consumed it (check/read record it model-seen). A server purge
      // (e.g. membership removed) also removes the row, and that must not read as delivered.
      const toldRuntime = queued
        ? ap.notifications.hasContributedMessage(queued, ap.sessionId)
        : this.isVisibleMessageModelSeen(agentId, formatAgentMessageVisibleTarget(tracked.message), tracked.message);
      if (toldRuntime) {
        this.completeTrackedMentionDelivery(tracked.context);
      } else {
        tracked.context.onMentionTerminalError?.("DELIVERY_REJECTED");
        // Terminal: release the entry so later turn ends do not report it again.
        this.trackedMentionDeliveries.delete(occurrenceId);
      }
    }
  }

  deliverMessage(agentId: string, message: AgentMessage, traceContext: DeliveryTraceContext = {}): boolean | Promise<boolean> {
    if (traceContext.deliveryId || traceContext.transient) {
      this.deliveryTraceContexts.set(message, traceContext);
    }
    const transientDelivery = this.isTransientDelivery(message);
    const ap = this.agents.get(agentId);
    const trackedBegin = this.beginTrackedMentionDelivery(agentId, message, ap, traceContext);
    if (trackedBegin === "rejected") return false;
    if (trackedBegin === "duplicate_pending") return true;
    if (trackedBegin === "duplicate_drained") {
      traceContext.onMentionAck?.();
      return true;
    }

    // Delivery-side visible-boundary gate (methodology run 1, seam ①②). A seq the
    // model has ALREADY consumed (wake/stdin/check/read/held/preflight) must not be
    // re-injected through ANY delivery branch on a server reconnect re-push /
    // cross-replica mirror. deliverMessage previously had NO boundary gate, so a
    // re-delivered already-consumed seq re-entered the inbox AND re-incremented the
    // user-visible notification counter (re-notify). Placed at ENTRY so it covers
    // every push path (during-start startingInbox, sticky-queued, idle/busy inbox,
    // auto-restart-from-idle) BEFORE any inbox push / notifications.add() / restart
    // (Kai cut-point). Non-transient only; the authoritative consumed boundary is
    // the single source (DG-LIVE-EVIDENCE: live gating derives from the authoritative
    // consumed-boundary, not a re-pushed copy). seq<=boundary → drop.
    if (!transientDelivery && this.isVisibleMessageModelSeen(agentId, formatAgentMessageVisibleTarget(message), message)) {
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "dropped_already_consumed",
        accepted: true,
        process_present: Boolean(this.agents.get(agentId)),
      }));
      if (trackedBegin === "accepted") this.completeTrackedMentionDelivery(traceContext);
      return true;
    }

    if (!ap) {
      // task #9: a tracked mention accepted here reaches a process only through
      // the start it joins; it is settled at that process's first turn end.
      if (trackedBegin === "accepted") this.markTrackedMentionPending(traceContext);
      if (this.agentStarts.hasStarting(agentId) || this.agentStarts.hasQueued(agentId)) {
        if (transientDelivery) {
          const queuedStart = this.agentStarts.getQueued(agentId);
          this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
            outcome: "transient_dropped_during_start",
            accepted: true,
            process_present: false,
            startup_pending: true,
            launchId: queuedStart?.launchId,
          }));
          return true;
        }
        const queuedStart = this.agentStarts.getQueued(agentId);
        const startingInboxCount = this.startingInboxes.bufferDuringStart(agentId, message);
        this.assertStartPendingDeliveryInvariants("delivery-during-start");
        this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
          outcome: "queued_during_start",
          accepted: true,
          process_present: false,
          startup_pending: true,
          starting_inbox_count: startingInboxCount,
          launchId: queuedStart?.launchId,
        }));
        return true;
      }

      const lifecycleRecord = this.agentLifecycleRecord(agentId);
      if (lifecycleRecord?.kind === "terminal") {
        const { terminalFailure } = lifecycleRecord;
        if (transientDelivery) {
          this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
            outcome: "transient_dropped_terminal_runtime_error_no_process",
            accepted: true,
            process_present: false,
            cached_idle_config_present: false,
            terminal_runtime_failure: true,
            launchId: terminalFailure.launchId || undefined,
          }));
          return true;
        }
        const startingInboxCount = this.startingInboxes.bufferDuringStart(agentId, message);
        this.assertStartPendingDeliveryInvariants("delivery-terminal-runtime-error");
        this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
          outcome: "queued_terminal_runtime_error_no_process",
          accepted: true,
          process_present: false,
          cached_idle_config_present: false,
          terminal_runtime_failure: true,
          starting_inbox_count: startingInboxCount,
          launchId: terminalFailure.launchId || undefined,
        }));
        this.sendAgentStatus(agentId, "inactive", terminalFailure.launchId);
        this.broadcastActivity(agentId, "error", terminalFailure.detail, [], terminalFailure.launchId, "runtime_error");
        return true;
      }

      // Process not running — auto-restart if we have a cached config (normal exit)
      if (lifecycleRecord?.kind === "idle" || lifecycleRecord?.kind === "cooldown") {
        const cached = lifecycleRecord.restartSnapshot;
        const driver = this.driverResolver(cached.config.runtime || "claude");
        if (!transientDelivery && this.shouldDeferWakeMessage(agentId, driver, message)) {
          this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
            outcome: "deferred_wake_message",
            accepted: true,
            process_present: false,
            cached_idle_config_present: true,
            runtime: cached.config.runtime,
            session_id_present: Boolean(cached.sessionId),
            launchId: cached.launchId || undefined,
          }));
          return true;
        }
        logger.info(`[Agent ${agentId}] Starting from idle state for new message`);
        // SPAWN-FAIL BACKOFF gate: if previous spawn attempts exceeded the threshold and
        // we're inside an active cooldown window, defer this spawn — leave the message in
        // startingInboxes so it is delivered when cooldown expires + next msg arrives or
        // the next successful spawn drains. NEVER drops the message; only delays the spawn.
        // Task #355: re-read the clock once here and use that single instant for
        // the buffer, the invariant repair and the residency entry. If the
        // cooldown has already expired, fall through and start now instead.
        const cooldownNowMs = this.clockNow();
        if (lifecycleRecord.kind === "cooldown" && lifecycleRecord.spawnFailBackoff.untilMs > cooldownNowMs) {
          const state = lifecycleRecord.spawnFailBackoff;
          const startingInboxCount = this.withClockFrozen(cooldownNowMs, () => {
            const count = this.startingInboxes.bufferDuringStart(agentId, message);
            this.assertStartPendingDeliveryInvariants("delivery-spawn-fail-cooldown");
            this.enterSpawnFailCooldownResidency(agentId, cached, state.untilMs, "idle_auto_restart", "spawn_fail_cooldown_active");
            return count;
          });
          this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
            outcome: "spawn_fail_cooldown_active",
            accepted: true,
            process_present: false,
            cached_idle_config_present: true,
            runtime: cached.config.runtime,
            session_id_present: Boolean(cached.sessionId),
            launchId: cached.launchId || undefined,
            spawn_fail_attempts: state.attempts,
            spawn_fail_until_ms: state.untilMs,
            starting_inbox_count: startingInboxCount,
          }));
          return true;
        }
        const restartFromPendingInbox = !transientDelivery && this.startingInboxes.has(agentId);
        if (restartFromPendingInbox) {
          this.startingInboxes.bufferDuringStart(agentId, message);
        }
        this.cancelRuntimeErrorProcessRestart(agentId);
        this.lifecycleRecords.deleteRestartSnapshot(agentId);
        this.restartingIdentities.set(agentId, { launchId: cached.launchId, sessionId: cached.sessionId });
        const restartStopEpoch = this.lifecycleRecords.stopEpoch(agentId);
        this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
          outcome: "auto_restart_from_idle",
          accepted: true,
          process_present: false,
          cached_idle_config_present: true,
          runtime: cached.config.runtime,
          session_id_present: Boolean(cached.sessionId),
          launchId: cached.launchId || undefined,
        }));
        // The restarted process and the start-queue pump timer outlive this
        // delivery, so their later events must not inherit the delivery span
        // that happened to trigger the restart.
        return runWithoutActiveSpan(() => this.startAgent(
          agentId,
          cached.config,
          restartFromPendingInbox ? undefined : message,
          undefined,
          undefined,
          cached.launchId || undefined,
          restartFromPendingInbox ? false : transientDelivery,
        )).then(() => {
          this.restartingIdentities.delete(agentId);
          // Successful spawn resets backoff (single success → counter zero, no half-state).
          this.resetSpawnFailBackoff(agentId);
          this.assertStartPendingDeliveryInvariants("idle-auto-restart-success");
          return true;
        }, (err) => {
          this.restartingIdentities.delete(agentId);
          if (trackedBegin === "accepted") this.failTrackedMention(traceContext, "DELIVERY_REJECTED");
          logger.error(`[Agent ${agentId}] Failed to auto-restart`, err);
          if (this.suppressFailedRestartAfterStop(agentId, restartStopEpoch, "idle-auto-restart")) {
            return false;
          }
          if (this.reportRunnerCredentialMintFailure(agentId, err, cached.launchId, "idle_auto_restart")) {
            this.lifecycleRecords.setRestartSnapshot(agentId, cached);
            // Credential-mint failure has its own user-visible handling; still count for backoff
            // so a stream of mint-failures doesn't keep spawning.
            const report = this.recordSpawnFailure(agentId, "runner_credential_mint");
            this.assertStartPendingDeliveryInvariants("idle-auto-restart-runner-credential-mint-failure");
            if (report.backoffActive) {
              this.enterSpawnFailCooldownResidency(agentId, cached, report.untilMs, "idle_auto_restart", "runner_credential_mint");
            }
            this.recordDaemonEvent("daemon.agent.spawn.fail_backoff", {
              agentId,
              source: "idle_auto_restart",
              reason: "runner_credential_mint",
              attempts: report.attempts,
              cooldown_active: report.backoffActive,
              until_ms: report.untilMs,
            });
            return false;
          }
          this.lifecycleRecords.setRestartSnapshot(agentId, cached);
          const report = this.recordSpawnFailure(agentId, "spawn_error");
          this.assertStartPendingDeliveryInvariants("idle-auto-restart-spawn-failure");
          if (report.backoffActive) {
            this.enterSpawnFailCooldownResidency(agentId, cached, report.untilMs, "idle_auto_restart", "spawn_error");
          }
          this.recordDaemonEvent("daemon.agent.spawn.fail_backoff", {
            agentId,
            source: "idle_auto_restart",
            reason: "spawn_error",
            attempts: report.attempts,
            cooldown_active: report.backoffActive,
            until_ms: report.untilMs,
          });
          return false;
        });
      }

      if (!transientDelivery && (this.agentStarts.hasQueued(agentId) || this.agentStarts.hasStarting(agentId))) {
        const startingInboxCount = this.startingInboxes.bufferDuringStart(agentId, message);
        this.assertStartPendingDeliveryInvariants("delivery-queued-or-starting");
        this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
          outcome: this.agentStarts.hasStarting(agentId) ? "queued_for_starting_process" : "queued_for_queued_start",
          accepted: true,
          process_present: false,
          cached_idle_config_present: false,
          starting_inbox_count: startingInboxCount,
        }));
        return true;
      }

      logger.warn(`[Agent ${agentId}] Delivery received but no running process or cached idle config exists`);
      if (transientDelivery) {
        this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
          outcome: "transient_dropped_no_process",
          accepted: true,
          process_present: false,
          cached_idle_config_present: false,
        }));
        return true;
      }
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "rejected_no_process",
        accepted: false,
        process_present: false,
        cached_idle_config_present: false,
      }), "error");
      traceContext.onRejectedNoProcess?.();
      this.sendAgentStatus(agentId, "inactive", null);
      this.broadcastActivity(agentId, "offline", "Process unavailable; restart required", [], undefined, "runtime_unavailable");
      return false;
    }

    this.busyDelivery.reconcile(agentId, ap, "delivery_route");
    const isIdle = this.isApmIdle(ap);

    if (trackedBegin === "accepted" && !isIdle) {
      if (!ap.driver.supportsStdinNotification && ap.driver.lifecycle.kind === "per_turn") {
        // task #9: a per_turn runtime takes no input mid-turn. The mention waits
        // in the inbox; the restart after this turn's exit carries it, and it
        // is settled at that process's turn end.
        const queued = queueAgentInboxMessage(ap, message);
        this.markTrackedMentionPending(traceContext, queued.duplicate ? "coalesced" : "accepted");
        this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
          outcome: queued.duplicate ? "coalesced_busy_mention" : "queued_busy_mention",
          accepted: true,
          process_present: true,
          runtime: ap.config.runtime,
        }));
        return true;
      }
      if (!ap.driver.supportsStdinNotification || !ap.sessionId || !this.canDeliverToRuntimeSession(ap)) {
        traceContext.onMentionTerminalError?.("UNSUPPORTED_DELIVERY_PATH");
        return false;
      }
      const queued = queueAgentInboxMessage(ap, message);
      ap.notifications.add();
      // A tracked mention waits for the observed turn boundary. Do not turn
      // recovery into a second busy force-wake lane.
      ap.notifications.clearTimer();
      this.markTrackedMentionPending(traceContext, queued.duplicate ? "coalesced" : "accepted");
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: queued.duplicate ? "coalesced_busy_mention" : "queued_busy_mention",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        session_id_present: true,
        launchId: ap.launchId || undefined,
        inbox_count: queued.inboxCount,
        duplicate_pending_delivery: queued.duplicate,
        pending_notification_count: ap.notifications.pendingCount,
        notification_timer_present: false,
      }));
      return true;
    }

    if (!transientDelivery && this.shouldDeferWakeMessage(agentId, ap.driver, message)) {
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "deferred_wake_message",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        session_id_present: Boolean(ap.sessionId),
        launchId: ap.launchId || undefined,
        is_idle: isIdle,
        inbox_count: ap.inbox.length,
      }));
      if (trackedBegin === "accepted") {
        traceContext.onMentionTerminalError?.("UNSUPPORTED_DELIVERY_PATH");
        return false;
      }
      return true;
    }

    const stickyTerminalFailure = classifyStickyTerminalFailure(ap);
    if (stickyTerminalFailure) {
      if (transientDelivery) {
        this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
          outcome: "transient_dropped_terminal_runtime_error",
          accepted: true,
          process_present: true,
          runtime: ap.config.runtime,
          session_id_present: Boolean(ap.sessionId),
          launchId: ap.launchId || undefined,
          is_idle: isIdle,
          inbox_count: ap.inbox.length,
        }));
        return true;
      }
      // B.5: an AUTH-CLASS sticky terminal failure (token / login / credential /
      // invalid-key) CAN recover on a user-driven turn — a restored account makes
      // the same retry succeed. The sticky classifier reads `lastRuntimeError` /
      // `recentStderr`, which are never reset within a process lifetime, so a
      // stale auth error from a prior turn keeps re-gating delivery even after the
      // underlying cause is fixed (e.g. a delinquent account restored). For the
      // user turn, re-evaluate from the CURRENT turn: clear ONLY the stale
      // auth-class entries (non-sticky diagnostics/telemetry preserved), then fall
      // through to normal delivery to attempt the recovery turn. Other sticky
      // failures (model-not-supported) cannot recover from a mere user message —
      // they need explicit reconfiguration — so they stay gated as before.
      // Transient/autonomous wakes stay suppressed on the branch above (churn).
      if (stickyTerminalFailure.actionRequired) {
        if (ap.lastRuntimeError && isAuthClassTerminalLine(ap.lastRuntimeError)) {
          ap.lastRuntimeError = null;
        }
        ap.recentStderr = ap.recentStderr.filter((line) => !isAuthClassTerminalLine(line));
        this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
          outcome: "user_turn_recover_from_sticky_terminal_error",
          accepted: true,
          process_present: true,
          runtime: ap.config.runtime,
          session_id_present: Boolean(ap.sessionId),
          launchId: ap.launchId || undefined,
          is_idle: isIdle,
          inbox_count: ap.inbox.length,
        }));
        // fall through to normal idle delivery below to attempt the recovery turn.
      } else {
        if (trackedBegin === "accepted") {
          traceContext.onMentionTerminalError?.("DELIVERY_REJECTED");
          return false;
        }
        const queued = queueAgentInboxMessage(ap, message);
        this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
          outcome: "queued_terminal_runtime_error",
          accepted: true,
          process_present: true,
          runtime: ap.config.runtime,
          session_id_present: Boolean(ap.sessionId),
          launchId: ap.launchId || undefined,
          is_idle: isIdle,
          inbox_count: queued.inboxCount,
          duplicate_pending_delivery: queued.duplicate,
        }));
        this.sendAgentStatus(agentId, "inactive", ap.launchId);
        this.broadcastActivity(agentId, "error", stickyTerminalFailure.detail, [], undefined, "runtime_error");
        return true;
      }
    }

    if (trackedBegin === "accepted" && this.runtimeErrorDeliveryBackoffRemainingMs(ap) > 0) {
      traceContext.onMentionTerminalError?.(
        ap.runtimeErrorDeliveryBackoff.reason === "rate_limited" ? "QUOTA_LIMITED" : "DELIVERY_REJECTED",
      );
      return false;
    }
    if (!transientDelivery && this.queueDeliveryForRuntimeErrorBackoff(agentId, ap, message)) {
      return true;
    }

    if (isIdle && ap.driver.supportsStdinNotification && this.canDeliverToRuntimeSession(ap)) {
      // Agent's turn is complete and process is waiting for stdin input.
      // Send a content-free Inbox update to start a new turn; message bodies
      // stay in the daemon-local inbox until explicit check/read consumption.
      if (transientDelivery) {
        const exposeTransient = () => {
          this.commitApmIdleState(agentId, ap, false);
          this.startRuntimeTrace(agentId, ap, "stdin-idle-delivery", [message]);
          const stdinAccepted = this.deliverMessagesViaStdin(
            agentId,
            ap,
            [message],
            "idle",
            { transient: true },
          );
          this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
            outcome: "stdin_idle_transient_delivery",
            accepted: true,
            process_present: true,
            runtime: ap.config.runtime,
            session_id_present: true,
            session_ready_for_delivery: true,
            launchId: ap.launchId || undefined,
            stdin_delivery_accepted: stdinAccepted,
            delivered_messages_count: 1,
            inbox_count: ap.inbox.length,
          }));
          return true;
        };
        return exposeTransient();
      }
      ap.notifications.pruneContributedToPending(ap.inbox, ap.sessionId);
      const noticeFingerprint = computeInboxNoticeFingerprint([message]);
      const messageAlreadyPending = noticeFingerprint.length > 0
        && ap.inbox.some((pending) => computeInboxNoticeFingerprint([pending]) === noticeFingerprint);
      const messageAlreadyContributed = ap.notifications.hasContributedMessage(message, ap.sessionId);
      // Delivery-ack only means this content-free prompt was written to stdin;
      // it is not a consume/model-seen signal. Suppress only while the same row
      // is still pending locally, so a stale write memo can never hide a message.
      if (messageAlreadyPending && (messageAlreadyContributed || ap.notifications.isDuplicateNotice(noticeFingerprint, ap.sessionId))) {
        this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
          outcome: "suppressed_duplicate_stdin_idle_delivery",
          accepted: true,
          process_present: true,
          runtime: ap.config.runtime,
          session_id_present: true,
          session_ready_for_delivery: true,
          launchId: ap.launchId || undefined,
          is_idle: isIdle,
          inbox_count: ap.inbox.length,
          pending_notification_count: ap.notifications.pendingCount,
        }));
        logger.info(`[Agent ${agentId}] Suppressing duplicate idle stdin inbox update (unread-set unchanged since last write); pending=${ap.inbox.length}`);
        return true;
      }
      ap.inbox.push(message);
      const nextMessages = [...ap.inbox];
      this.commitApmIdleState(agentId, ap, false);
      this.startRuntimeTrace(agentId, ap, "stdin-idle-delivery", [message]);
      const stdinAccepted = this.deliverInboxUpdateViaStdin(
        agentId,
        ap,
        [message],
        "idle",
        "stdin_idle_delivery",
      );
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "stdin_idle_delivery",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        session_id_present: true,
        launchId: ap.launchId || undefined,
        stdin_delivery_accepted: stdinAccepted,
        delivered_messages_count: nextMessages.length,
      }));
      if (trackedBegin === "accepted") {
        if (stdinAccepted) {
          this.completeTrackedMentionDelivery(traceContext);
        } else {
          traceContext.onMentionTerminalError?.("DELIVERY_REJECTED");
        }
      }
      return true;
    }

    // Agent is busy — queue message in inbox
    if (transientDelivery) {
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "transient_dropped_busy",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        session_id_present: Boolean(ap.sessionId),
        launchId: ap.launchId || undefined,
        is_idle: isIdle,
        inbox_count: ap.inbox.length,
      }));
      return true;
    }
    const queued = queueAgentInboxMessage(ap, message);

    if (this.recoverStaleProcessForQueuedMessageIfNeeded(agentId, ap)) {
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "queued_stalled_recovery",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        session_id_present: Boolean(ap.sessionId),
        launchId: ap.launchId || undefined,
        inbox_count: queued.inboxCount,
        duplicate_pending_delivery: queued.duplicate,
      }));
      return true;
    }

    if (!ap.driver.supportsStdinNotification) {
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "queued_busy_non_stdin",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        session_id_present: Boolean(ap.sessionId),
        launchId: ap.launchId || undefined,
        inbox_count: queued.inboxCount,
        duplicate_pending_delivery: queued.duplicate,
      }));
      return true;
    }
    if (!ap.sessionId) {
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "queued_before_session",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        session_id_present: false,
        launchId: ap.launchId || undefined,
        inbox_count: queued.inboxCount,
        duplicate_pending_delivery: queued.duplicate,
      }));
      return true;
    } // agent not initialized yet

    if (!this.canDeliverToRuntimeSession(ap)) {
      const retryScheduled = this.scheduleSessionReadyDeliveryRetry(agentId, ap, "queued_before_session_ready");
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "queued_before_session_ready",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        session_id_present: true,
        session_ready_for_delivery: false,
        launchId: ap.launchId || undefined,
        is_idle: isIdle,
        inbox_count: queued.inboxCount,
        duplicate_pending_delivery: queued.duplicate,
        session_ready_delivery_retry_scheduled: retryScheduled || ap.sessionReadyDeliveryRetry.kind === "scheduled",
      }));
      return true;
    }

    if (ap.gatedSteering.compacting && ap.driver.acceptsStdinDuringCompaction !== true) {
      ap.notifications.add();
      ap.notifications.clearTimer();
      this.recordRuntimeTraceEvent(agentId, ap, "runtime.compaction_boundary.delivery_buffered", {
        pendingNotificationCount: ap.notifications.pendingCount,
        pendingMessages: ap.inbox.length,
        busyDeliveryMode: ap.driver.busyDeliveryMode,
      });
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "queued_compaction_boundary",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        session_id_present: true,
        launchId: ap.launchId || undefined,
        inbox_count: queued.inboxCount,
        duplicate_pending_delivery: queued.duplicate,
        pending_notification_count: ap.notifications.pendingCount,
        busy_delivery_mode: ap.driver.busyDeliveryMode,
        notification_timer_present: false,
      }));
      return true;
    }

    if (ap.gatedSteering.reviewing) {
      ap.notifications.add();
      ap.notifications.clearTimer();
      this.recordRuntimeTraceEvent(agentId, ap, "runtime.review_boundary.delivery_buffered", {
        pendingNotificationCount: ap.notifications.pendingCount,
        pendingMessages: ap.inbox.length,
        busyDeliveryMode: ap.driver.busyDeliveryMode,
      });
      this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
        outcome: "queued_review_boundary",
        accepted: true,
        process_present: true,
        runtime: ap.config.runtime,
        session_id_present: true,
        launchId: ap.launchId || undefined,
        inbox_count: queued.inboxCount,
        duplicate_pending_delivery: queued.duplicate,
        pending_notification_count: ap.notifications.pendingCount,
        busy_delivery_mode: ap.driver.busyDeliveryMode,
        notification_timer_present: false,
      }));
      return true;
    }

    ap.notifications.add();
    if (!ap.notifications.hasTimer) {
      this.scheduleStdinNotification(agentId, ap, STDIN_NOTIFICATION_INITIAL_DELAY_MS);
    }
    this.recordDaemonEvent("daemon.agent.delivery.routed", this.deliveryTraceAttrs(agentId, message, {
      outcome: "queued_busy_notification",
      accepted: true,
      process_present: true,
      runtime: ap.config.runtime,
      session_id_present: true,
      inbox_count: queued.inboxCount,
      duplicate_pending_delivery: queued.duplicate,
      pending_notification_count: ap.notifications.pendingCount,
      notification_timer_present: ap.notifications.hasTimer,
    }));
    return true;
  }

  async resetWorkspace(agentId: string) {
    const agentDataDir = path.join(this.dataDir, agentId);
    try {
      await rm(agentDataDir, { recursive: true, force: true });
      logger.info(`[Agent ${agentId}] Workspace reset complete (${agentDataDir})`);
    } catch (err) {
      logger.error(`[Agent ${agentId}] Workspace reset failed`, err);
      this.recordDaemonEvent("daemon.agent.workspace_reset_failed", {
        agentId,
        outcome: "error",
        reason: "workspace_reset_threw",
        error_class: errorClassOf(err),
      }, "error");
    }
  }

  async stopAll() {
    // Clear idle configs so no auto-restarts happen during shutdown.
    // Use silent: true so agents stay "active" in DB — on daemon reconnect,
    // the server's ready handler will auto-restart them.
    if (this.coldIdleSweepTimer) clearInterval(this.coldIdleSweepTimer);
    this.coldIdleSweepTimer = null;
    this.cancelAllQueuedAgentStarts("daemon shutdown");
    // RFC 071: starts held for the server capability end without a spawn.
    for (const wait of [...this.capabilityHolds.values()]) wait.cancel();
    this.lifecycleRecords.clearRestartSnapshots();

    // Snapshot PIDs before stopAgent clears the agents Map (line ~4267).
    const pids: number[] = [];
    for (const ap of this.agents.values()) {
      if (typeof ap.runtime.pid === "number") pids.push(ap.runtime.pid);
    }

    const ids = [...this.agents.keys()];

    const span = this.tracer.startSpan("daemon.agent.stop_all", {
      surface: "daemon",
      kind: "internal",
      attrs: {
        agent_count: ids.length,
        pid_count: pids.length,
        pids: pids.join(","),
      },
    });
    try {
      await runWithActiveSpan(span, () => this.stopAllAgents(ids, pids));
      span.end("ok");
    } catch (err) {
      span.end("error", { attrs: { error_class: errorClassOf(err) } });
      throw err;
    }
  }

  private async stopAllAgents(ids: string[], pids: number[]): Promise<void> {
    await Promise.all(ids.map((id) => this.stopAgent(id, { wait: true, silent: true })));

    // Shutdown process-tree orphan safeguard: the RuntimeSessions are torn down
    // by now, so the whole-tree survivor probe + SIGKILL is session-independent
    // by design and lives in the dedicated reaper (a distinct boundary from
    // per-session RuntimeSession IO, RS-011).
    const reapedSurvivors = await reapOrphanProcesses(
      pids,
      logger,
      (name, attrs, status) => this.recordDaemonEvent(name, attrs, status),
    );
    if (!reapedSurvivors) {
      this.recordDaemonEvent("daemon.agent.stop_all.completed", {
        agent_count: ids.length,
        survivor_count: 0,
        outcome: "all_dead",
      });
    }
  }

  getRunningAgentIds(): string[] {
    return [...this.agents.keys()];
  }

  private shouldDeferWakeMessage(agentId: string, driver: RuntimeDriver, message: AgentMessage): boolean {
    if (!driver.shouldDeferWakeMessage?.(message)) return false;
    logger.info(`[Agent ${agentId}] Deferred non-concrete wake message for ${driver.id}`);
    return true;
  }

  private completeDeprecatedRuntimeProfileMigration(
    agentId: string,
    migrationKey: string,
    launchId: string | null,
    traceparent: string | undefined,
    source: "agent_config" | "wake_message" | "runtime_profile_message",
  ): void {
    this.sendToServer({
      type: "agent:runtime_profile:migration:ack",
      agentId,
      migrationKey,
      launchId: launchId || undefined,
      traceparent,
    });
    this.sendToServer({
      type: "agent:runtime_profile:migration_done",
      agentId,
      migrationKey,
      launchId: launchId || undefined,
      traceparent,
    });
    this.recordDaemonEvent("daemon.runtime_profile.migration.deprecated_noop", {
      agentId,
      key_present: Boolean(migrationKey),
      key_hash: hashRuntimeProfileKey(migrationKey),
      launchId: launchId || undefined,
      source,
    });
    logger.info(`[Agent ${agentId}] Completed deprecated Runtime Profile migration ${migrationKey} as reset-session no-op`);
  }

  getAgentSessionId(agentId: string): string | null {
    return this.agents.get(agentId)?.sessionId ?? null;
  }

  getAgentLaunchId(agentId: string): string | null {
    return this.agents.get(agentId)?.launchId ?? null;
  }

  getIdleAgentSessionIds(): Array<{ agentId: string; sessionId: string; launchId: string | null }> {
    const result: Array<{ agentId: string; sessionId: string; launchId: string | null }> = [];
    for (const [agentId, { sessionId, launchId }] of this.lifecycleRecords.restartSnapshotEntries()) {
      if (this.agents.has(agentId)) continue;
      if (sessionId) result.push({ agentId, sessionId, launchId });
    }
    return result;
  }

  private buildRuntimeProfileReport(
    agentId: string,
    config: AgentConfig,
    sessionId: string | null,
    launchId: string | null,
    observedRuntimeHomeDir?: string | null,
    processInstanceId?: string,
  ): AgentRuntimeProfileWireReport {
    const workspacePath = path.join(this.dataDir, agentId);
    const runtimeHomeDir = observedRuntimeHomeDir
      || resolveRuntimeHomeDir(config, this.runtimeSessionHomeDir, workspacePath, { agentId, slockHome: this.slockHome });
    return {
      agentId,
      launchId,
      facts: {
        runtime: config.runtime,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        executionMode: config.executionMode || "byoc",
        workspacePathRef: {
          label: "workspace",
          path: workspacePath,
          reachable: true,
        },
        sessionRef: sessionId ? resolveRuntimeSessionRef(config.runtime, sessionId, runtimeHomeDir, workspacePath, {
          agentId,
          workingDirectory: workspacePath,
          // Join keys come from the CALLER's context (running agent OR idle
          // restart snapshot) — reading only live state here left the
          // restart/adopt path writing launchId:null markers, exactly the
          // V3 class this exists to close (Leiysky review on #3863).
          launchId: launchId || undefined,
          processInstanceId: processInstanceId ?? this.agents.get(agentId)?.processInstanceId,
        }) : null,
      },
    };
  }

  getAgentRuntimeProfileReport(agentId: string): AgentRuntimeProfileWireReport | null {
    const running = this.agents.get(agentId);
    if (running) {
      return this.buildRuntimeProfileReport(
        agentId,
        running.config,
        running.sessionId,
        running.launchId,
        running.runtime.currentRuntimeHomeDir,
        running.processInstanceId,
      );
    }
    const idle = this.lifecycleRecords.getRestartSnapshot(agentId);
    if (idle) {
      return this.buildRuntimeProfileReport(agentId, idle.config, idle.sessionId, idle.launchId, null, idle.processInstanceId);
    }
    return null;
  }

  getAgentRuntimeProfileReports(): AgentRuntimeProfileWireReport[] {
    const reports: AgentRuntimeProfileWireReport[] = [];
    const seen = new Set<string>();
    for (const agentId of this.agents.keys()) {
      const report = this.getAgentRuntimeProfileReport(agentId);
      if (report) {
        reports.push(report);
        seen.add(agentId);
      }
    }
    for (const agentId of this.lifecycleRecords.restartSnapshotAgentIds()) {
      if (seen.has(agentId)) continue;
      const report = this.getAgentRuntimeProfileReport(agentId);
      if (report) reports.push(report);
    }
    return reports;
  }

  deliverRuntimeProfileNotification(
    agentId: string,
    key: string,
    kind: "migration" | "daemon_release_notice",
    content: string,
    traceparent?: string,
    launchId?: string | null,
  ): boolean | Promise<boolean> {
    const span = this.tracer.startSpan("daemon.runtime_profile.control.inject", {
      parent: parseTraceparent(traceparent),
      surface: "daemon",
      kind: "consumer",
      attrs: {
        agentId,
        control_kind: kind,
        key_present: Boolean(key),
        key_hash: hashRuntimeProfileKey(key),
      },
    });
    if (kind === "migration") {
      this.completeDeprecatedRuntimeProfileMigration(
        agentId,
        key,
        launchId || null,
        formatTraceparent(span.context),
        "runtime_profile_message",
      );
      span.end("ok", { attrs: { outcome: "deprecated_noop_completed", launchId: launchId || undefined } });
      return true;
    }
    const now = new Date().toISOString();
    const message: AgentMessage = {
      channel_id: "system",
      channel_name: "system",
      channel_type: "dm",
      sender_id: "system",
      sender_name: "system",
      sender_type: "system",
      content,
      timestamp: now,
      message_id: `${RUNTIME_PROFILE_DAEMON_NOTICE_MESSAGE_PREFIX}${key}`,
      traceparent: formatTraceparent(span.context),
    };

    const ap = this.agents.get(agentId);
    const isIdle = ap ? this.isApmIdle(ap) : false;
    const sessionReadyForDelivery = ap ? this.canDeliverToRuntimeSession(ap) : false;
    if (ap && !(sessionReadyForDelivery && ap.driver.supportsStdinNotification && isIdle) && !(sessionReadyForDelivery && ap.runtime.descriptor.busyDelivery === "direct")) {
      this.enqueueRuntimeProfileNotification(agentId, ap, message, kind, key);
      span.end("ok", {
        attrs: {
          outcome: ap.sessionId ? "queued_busy" : "queued_before_session",
          runtime: ap.config.runtime,
          launchId: ap.launchId || undefined,
          session_id_present: Boolean(ap.sessionId),
          session_ready_for_delivery: sessionReadyForDelivery,
          supports_stdin_notification: ap.driver.supportsStdinNotification,
          busy_delivery_mode: ap.driver.busyDeliveryMode,
        },
      });
      return true;
    }

    if (ap && sessionReadyForDelivery && ap.driver.supportsStdinNotification && isIdle) {
      this.commitApmIdleState(agentId, ap, false);
      this.startRuntimeTrace(agentId, ap, "runtime-profile", [message]);
      const written = this.deliverMessagesViaStdin(agentId, ap, [message], "idle");
      span.end(written ? "ok" : "error", {
        attrs: {
          outcome: written ? "stdin_idle" : "stdin_failed",
          runtime: ap.config.runtime,
          launchId: ap.launchId || undefined,
          session_id_present: true,
          supports_stdin_notification: true,
          busy_delivery_mode: ap.driver.busyDeliveryMode,
        },
      });
      return written;
    }

    if (ap && sessionReadyForDelivery && ap.runtime.descriptor.busyDelivery === "direct") {
      const written = this.deliverMessagesViaStdin(agentId, ap, [message], "busy");
      span.end(written ? "ok" : "error", {
        attrs: {
          outcome: written ? "stdin_busy" : "stdin_failed",
          runtime: ap.config.runtime,
          launchId: ap.launchId || undefined,
          session_id_present: true,
          supports_stdin_notification: ap.driver.supportsStdinNotification,
          busy_delivery_mode: ap.driver.busyDeliveryMode,
        },
      });
      return written;
    }

    if (this.agentStarts.hasStarting(agentId) || this.agentStarts.hasQueued(agentId)) {
      const queuedStart = this.agentStarts.getQueued(agentId);
      this.queueRuntimeProfileNotificationDuringStart(agentId, message, kind, key);
      span.end("ok", {
        attrs: {
          outcome: "queued_during_start",
          startup_pending: true,
          launchId: queuedStart?.launchId,
        },
      });
      return true;
    }

    const lifecycleRecord = this.agentLifecycleRecord(agentId);
    if (lifecycleRecord?.kind === "idle" || lifecycleRecord?.kind === "cooldown") {
      const cached = lifecycleRecord.restartSnapshot;
      logger.info(`[Agent ${agentId}] Starting from idle state for runtime profile ${kind} ${key}`);
      // SPAWN-FAIL BACKOFF gate (mirror of auto_restart_from_idle path).
      if (lifecycleRecord.kind === "cooldown") {
        const state = lifecycleRecord.spawnFailBackoff;
        this.enterSpawnFailCooldownResidency(agentId, cached, state.untilMs, "runtime_profile_auto_restart", "spawn_fail_cooldown_active");
        span.end("ok", {
          attrs: {
            outcome: "spawn_fail_cooldown_active",
            runtime: cached.config.runtime,
            launchId: cached.launchId || undefined,
            spawn_fail_attempts: state.attempts,
            spawn_fail_until_ms: state.untilMs,
          },
        });
        return true;
      }
      this.lifecycleRecords.deleteRestartSnapshot(agentId);
      const restartStopEpoch = this.lifecycleRecords.stopEpoch(agentId);
      return this.startAgent(agentId, cached.config, message, undefined, undefined, cached.launchId || undefined).then(() => {
        this.resetSpawnFailBackoff(agentId);
        this.assertStartPendingDeliveryInvariants("runtime-profile-auto-restart-success");
        return true;
      }, (err) => {
        logger.error(`[Agent ${agentId}] Failed to auto-restart for runtime profile notification`, err);
        if (this.suppressFailedRestartAfterStop(agentId, restartStopEpoch, "runtime-profile-auto-restart")) {
          span.end("ok", {
            attrs: {
              outcome: "suppressed_after_stop",
              runtime: cached.config.runtime,
              launchId: cached.launchId || undefined,
            },
          });
          return false;
        }
        if (this.reportRunnerCredentialMintFailure(agentId, err, cached.launchId, "runtime_profile_auto_restart")) {
          this.lifecycleRecords.setRestartSnapshot(agentId, cached);
          const report = this.recordSpawnFailure(agentId, "runner_credential_mint");
          this.assertStartPendingDeliveryInvariants("runtime-profile-auto-restart-runner-credential-mint-failure");
          if (report.backoffActive) {
            this.enterSpawnFailCooldownResidency(agentId, cached, report.untilMs, "runtime_profile_auto_restart", "runner_credential_mint");
          }
          this.recordDaemonEvent("daemon.agent.spawn.fail_backoff", {
            agentId,
            source: "runtime_profile_auto_restart",
            reason: "runner_credential_mint",
            attempts: report.attempts,
            cooldown_active: report.backoffActive,
            until_ms: report.untilMs,
          });
          span.end("error", {
            attrs: {
              outcome: "runner_credential_mint_failed",
              runtime: cached.config.runtime,
              launchId: cached.launchId || undefined,
            },
          });
          return false;
        }
        this.lifecycleRecords.setRestartSnapshot(agentId, cached);
        const report = this.recordSpawnFailure(agentId, "spawn_error");
        this.assertStartPendingDeliveryInvariants("runtime-profile-auto-restart-spawn-failure");
        if (report.backoffActive) {
          this.enterSpawnFailCooldownResidency(agentId, cached, report.untilMs, "runtime_profile_auto_restart", "spawn_error");
        }
        this.recordDaemonEvent("daemon.agent.spawn.fail_backoff", {
          agentId,
          source: "runtime_profile_auto_restart",
          reason: "spawn_error",
          attempts: report.attempts,
          cooldown_active: report.backoffActive,
          until_ms: report.untilMs,
        });
        span.end("error", {
          attrs: {
            outcome: "restart_failed",
            runtime: cached.config.runtime,
            launchId: cached.launchId || undefined,
          },
        });
        return false;
      });
    }

    logger.warn(`[Agent ${agentId}] Runtime profile ${kind} ${key} has no runtime injection path yet; leaving unacked for retry`);
    span.end("ok", { attrs: { outcome: "no_path" } });
    return false;
  }

  private ackInjectedRuntimeProfileMessages(agentId: string, messages: AgentMessage[], launchId: string | null) {
    for (const message of messages) {
      const notification = runtimeProfileNotificationFromMessage(message);
      if (!notification) continue;
      if (notification.kind === "migration") {
        this.completeDeprecatedRuntimeProfileMigration(agentId, notification.key, launchId, message.traceparent, "runtime_profile_message");
        continue;
      }
      const title = runtimeProfileNotificationTitle(notification.kind);
      this.broadcastActivity(agentId, "working", title, [{ kind: "system", title, text: message.content }], launchId, "system_message");
      this.sendToServer({
        type: "agent:runtime_profile:daemon_release_notice:ack",
        agentId,
        noticeKey: notification.key,
        launchId: launchId || undefined,
        traceparent: message.traceparent,
      });
    }
  }

  private ackInjectedRuntimeProfileControl(
    agentId: string,
    control: NonNullable<AgentConfig["runtimeProfileControl"]>,
    launchId: string | null,
  ) {
    const span = this.tracer.startSpan("daemon.runtime_profile.control.inject", {
      parent: getActiveTraceContext(),
      surface: "daemon",
      kind: "internal",
      attrs: {
        agentId,
        control_kind: control.kind,
        key_present: Boolean(control.key),
        key_hash: hashRuntimeProfileKey(control.key),
        launchId: launchId || undefined,
        source: "agent_config",
      },
    });
    const title = runtimeProfileNotificationTitle(control.kind);
    if (control.kind === "migration") {
      this.completeDeprecatedRuntimeProfileMigration(agentId, control.key, launchId, formatTraceparent(span.context), "agent_config");
      span.end("ok", { attrs: { outcome: "deprecated_noop_completed" } });
      return;
    }
    this.broadcastActivity(agentId, "working", title, [{ kind: "system", title, text: control.message }], launchId, "system_message");
    this.sendToServer({
      type: "agent:runtime_profile:daemon_release_notice:ack",
      agentId,
      noticeKey: control.key,
      launchId: launchId || undefined,
      traceparent: formatTraceparent(span.context),
    });
    span.end("ok", { attrs: { outcome: "agent_config_ack_sent" } });
  }

  private sendRuntimeProfileWireReport(report: AgentRuntimeProfileWireReport, source: RuntimeProfileReportSource) {
    const span = this.tracer.startSpan("daemon.runtime_profile.report.sent", {
      parent: getActiveTraceContext(),
      surface: "daemon",
      kind: "producer",
      attrs: {
        agentId: report.agentId,
        launchId: report.launchId || undefined,
        runtime: report.facts.runtime,
        report_source: source,
        model_present: Boolean(report.facts.model),
        session_ref_present: Boolean(report.facts.sessionRef),
        workspace_ref_present: Boolean(report.facts.workspaceRef || report.facts.workspacePathRef),
      },
    });
    this.sendToServer({
      type: "agent:runtime_profile",
      agentId: report.agentId,
      facts: report.facts,
      launchId: report.launchId || undefined,
      traceparent: formatTraceparent(span.context),
      source,
    });
    span.end("ok");
  }

  private sendRuntimeProfileReportFor(
    agentId: string,
    config: AgentConfig,
    sessionId: string | null,
    launchId: string | null,
    source: RuntimeProfileReportSource,
  ) {
    this.sendRuntimeProfileWireReport(this.buildRuntimeProfileReport(agentId, config, sessionId, launchId), source);
  }

  private sendRuntimeProfileReport(agentId: string, source: RuntimeProfileReportSource) {
    const report = this.getAgentRuntimeProfileReport(agentId);
    if (!report) return;
    this.sendRuntimeProfileWireReport(report, source);
  }

  // Machine-level workspace scanning

  async scanAllWorkspaces(): Promise<WorkspaceDirectoryInfo[]> {
    return scanWorkspaceDirectories(this.dataDir);
  }

  async deleteWorkspaceDirectory(directoryName: string): Promise<boolean> {
    return deleteWorkspaceDirectory(this.dataDir, directoryName);
  }

  // Workspace file browsing

  async getFileTree(agentId: string, dirPath?: string, includeHidden = false): Promise<FileNode[]> {
    const agentDir = path.join(this.dataDir, agentId);
    try {
      await stat(agentDir);
    } catch {
      return [];
    }

    // Determine which directory to list
    let targetDir = agentDir;
    if (dirPath) {
      // Path traversal guard
      const resolved = path.resolve(agentDir, dirPath);
      if (!resolved.startsWith(agentDir + path.sep) && resolved !== agentDir) {
        return [];
      }
      const relativePath = path.relative(agentDir, resolved);
      if (isWorkspaceNeverVisibleHiddenPath(relativePath)) {
        return [];
      }
      if (!includeHidden && isWorkspaceHiddenPath(relativePath)) {
        return [];
      }
      targetDir = resolved;
    }

    return this.listDirectoryChildren(targetDir, agentDir, includeHidden);
  }

  async readFile(agentId: string, filePath: string): Promise<{ content: string | null; binary: boolean; size: number; mimeType?: string; encoding?: "utf-8" | "base64" }> {
    const agentDir = path.join(this.dataDir, agentId);
    const resolved = path.resolve(agentDir, filePath);
    if (!resolved.startsWith(agentDir + path.sep) && resolved !== agentDir) {
      throw new Error("Access denied");
    }
    const relativePath = path.relative(agentDir, resolved);
    if (isWorkspaceNeverVisibleHiddenPath(relativePath) || isWorkspaceSecretFilePath(relativePath)) {
      throw new Error("Preview is disabled for sensitive workspace files");
    }
    const info = await stat(resolved);
    if (info.isDirectory()) throw new Error("Cannot read a directory");

    const ext = path.extname(resolved).toLowerCase();
    if (WORKSPACE_TEXT_EXTENSIONS.has(ext) || ext === "") {
      if (info.size > WORKSPACE_TEXT_FILE_MAX_BYTES) throw new Error("File too large");
      const content = await readFile(resolved, "utf-8");
      return { content, binary: false, size: info.size, encoding: "utf-8" };
    }

    const imageMimeType = WORKSPACE_IMAGE_MIME_BY_EXTENSION[ext];
    if (imageMimeType) {
      if (info.size > WORKSPACE_IMAGE_PREVIEW_MAX_BYTES) {
        return { content: null, binary: true, size: info.size, mimeType: imageMimeType };
      }
      const content = await readFile(resolved, "base64");
      return { content, binary: true, size: info.size, mimeType: imageMimeType, encoding: "base64" };
    }

    return { content: null, binary: true, size: info.size };
  }

  // Skill scanning

  // Per-runtime skill search paths (relative to home dir for global, workspace dir for workspace).
  // To add a new runtime, add an entry here.
  private static readonly SKILL_PATHS: Record<string, { global: string[]; workspace: string[] }> = {
    claude: {
      // Claude reads shared skills via symlinks in ~/.claude/skills/, not from ~/.agents/skills/
      global: [".claude/skills", ".claude/commands"],
      workspace: [".claude/skills", ".claude/commands"],
    },
    codex: {
      // Codex natively scans ~/.agents/skills/ and has built-in .system skills
      global: [".codex/skills", ".codex/skills/.system", ".agents/skills"],
      workspace: [".codex/skills", ".agents/skills"],
    },
  };

  async getSessionTranscript(agentId: string, options: { anchorAt?: string } = {}): Promise<SessionTranscriptLookup> {
    const agent = this.agents.get(agentId);
    const idle = this.lifecycleRecords.getRestartSnapshot(agentId);
    const config = agent?.config ?? idle?.config ?? null;
    // SECURITY: only the sessionId bound to the agent process/config is ever read.
    // Caller-supplied session identifiers are not accepted (the WebSocket message
    // no longer carries one; see @botiverse/raft-shared ServerToMachineMessage).
    const actualSessionId = agent?.sessionId || idle?.sessionId || null;
    const workspaceDir = path.join(this.dataDir, agentId);

    if (!config) {
      // An OBSERVATION about this daemon's memory and its local directory only:
      // it does not say where (or whether) the agent ran.
      const workspaceDirPresent = await stat(workspaceDir).then((info) => info.isDirectory(), () => false);
      return {
        runtime: "unknown",
        sessionId: actualSessionId || "unknown",
        reachable: false,
        path: null,
        fallbackReason: "no agent config in this daemon's memory (no live process, no restart snapshot)",
        transcript: null,
        sizeBytes: 0,
        truncated: false,
        redacted: false,
        tier: "unknown",
        transcriptContent: "absent",
        reasonCode: "no_config_in_memory",
        lookupMethod: "in_memory_agent_config",
        searchedPaths: this.foldTranscriptLookupPaths([workspaceDir]),
        workspaceDirPresent,
        transcriptBytes: 0,
      };
    }

    const runtime = config.runtime;
    const homeDir = agent?.runtime.currentRuntimeHomeDir
      || ensureRuntimeHomeDir(config, this.runtimeSessionHomeDir, workspaceDir, { agentId, slockHome: this.slockHome });

    if (!actualSessionId) {
      return {
        runtime,
        sessionId: "unknown",
        reachable: false,
        path: null,
        fallbackReason: "no session id available",
        transcript: null,
        sizeBytes: 0,
        truncated: false,
        redacted: false,
        tier: runtimeTier(runtime),
        transcriptContent: "absent",
        reasonCode: "no_session_id",
        lookupMethod: null,
        searchedPaths: [],
        transcriptBytes: 0,
      };
    }

    // The resolver still writes the workspace handoff marker on a native miss
    // (the runtime-profile join depends on it); the feedback path reads the
    // typed resolution and never treats that file as a transcript.
    const resolved = resolveRuntimeSessionRefDetailed(runtime, actualSessionId, homeDir, workspaceDir, {
      agentId,
      workingDirectory: workspaceDir,
      launchId: this.agents.get(agentId)?.launchId || undefined,
      processInstanceId: this.agents.get(agentId)?.processInstanceId,
    });
    const ref = resolved.ref;
    const lookupMethod = asFeedbackTranscriptLookupMethod(resolved.lookupMethod);
    const searchedPaths = this.foldTranscriptLookupPaths(resolved.searchedPaths, homeDir);

    const tier = runtimeTier(runtime);
    const span = this.tracer.startSpan("daemon.session_transcript.read", {
      parent: getActiveTraceContext(),
      surface: "daemon",
      kind: "internal",
      attrs: {
        agentId,
        runtime,
        sessionId: actualSessionId,
        reachable: resolved.resolution === "native",
        resolution: resolved.resolution,
        tier,
        lookup_method: resolved.lookupMethod,
      },
    });

    const base = { runtime, sessionId: actualSessionId, tier, lookupMethod, searchedPaths };
    const notRead = (
      reasonCode: FeedbackTranscriptLookupReason,
      transcriptContent: FeedbackTranscriptContentKind,
      fallbackReason: string,
      extra: { sourceBytes?: number; path?: string | null; truncated?: boolean; truncationDirection?: "head" | "tail" | "window" } = {},
    ): SessionTranscriptLookup => ({
      ...base,
      reachable: false,
      path: extra.path ?? null,
      fallbackReason,
      transcript: null,
      sizeBytes: 0,
      truncated: extra.truncated ?? false,
      ...(extra.truncationDirection ? { truncationDirection: extra.truncationDirection } : {}),
      redacted: false,
      transcriptContent,
      reasonCode,
      transcriptBytes: 0,
      ...(extra.sourceBytes !== undefined ? { sourceBytes: extra.sourceBytes } : {}),
    });

    if (resolved.resolution !== "native" || !ref.path) {
      const reasonCode = resolved.lookupMethod === "none" ? "runtime_has_no_native_lookup" : "native_session_file_not_found";
      span.end("ok", { attrs: { transcript_present: false, reason_code: reasonCode } });
      return notRead(
        reasonCode,
        resolved.resolution === "daemon_handoff" ? "placeholder" : "absent",
        reasonCode === "runtime_has_no_native_lookup"
          ? `this daemon has no native session lookup for runtime ${runtime}`
          : `native session file not found (lookup ${resolved.lookupMethod})`,
      );
    }

    const allowedRoots = allowedTranscriptRootsForRuntime(runtime, homeDir, workspaceDir);
    let targetPath: string;
    let transcriptContent: FeedbackTranscriptUploadableContentKind = "native_session_file";
    try {
      const resolvedPath = path.resolve(ref.path);
      if (!(await isPathWithinAllowedRoots(resolvedPath, allowedRoots))) {
        throw new TranscriptPathRejectedError("resolved session path is outside allowed runtime directories");
      }
      // For SDK runtimes that store a session directory (e.g. kimi-sdk), read
      // the primary STATE file: the runtime's state, not necessarily a
      // conversation, so it is labelled native_state_file.
      const info = await lstat(resolvedPath);
      if (info.isSymbolicLink()) throw new TranscriptPathRejectedError("symbolic links are not allowed");
      targetPath = resolvedPath;
      if (info.isDirectory()) {
        targetPath = path.join(resolvedPath, "state.json");
        transcriptContent = "native_state_file";
      }
      if (!(await isPathWithinAllowedRoots(targetPath, allowedRoots))) {
        throw new TranscriptPathRejectedError("resolved session state path is outside allowed runtime directories");
      }
    } catch (err) {
      const rejected = err instanceof TranscriptPathRejectedError;
      span.end("error", { attrs: { error_class: err instanceof Error ? err.name : "Error", reason_code: rejected ? "path_rejected" : "read_failed" } });
      return notRead(rejected ? "path_rejected" : "read_failed", "absent", rejected ? "session path rejected" : "session path could not be inspected", { path: ref.path });
    }

    const read = await readAndRedactTranscriptDetailed(targetPath, SESSION_TRANSCRIPT_MAX_BYTES, options.anchorAt);
    if (!read.ok) {
      span.end("error", { attrs: { error_class: read.errorClass, reason_code: read.failure } });
      return notRead(read.failure, "absent", read.failure === "path_rejected" ? "session path rejected" : "session file could not be read", { path: ref.path });
    }
    const transcriptBytes = Buffer.byteLength(read.text, "utf8");
    if (read.sourceBytes === 0 || transcriptBytes === 0) {
      const reasonCode = read.sourceBytes === 0 ? "session_file_empty" : "window_empty";
      span.end("ok", { attrs: { transcript_present: false, reason_code: reasonCode, source_bytes: read.sourceBytes } });
      return notRead(reasonCode, "absent", reasonCode === "session_file_empty" ? "session file is empty" : "no complete record in the bounded read window", { sourceBytes: read.sourceBytes, path: ref.path, truncated: read.truncated, truncationDirection: read.truncationDirection });
    }
    span.end("ok", { attrs: { transcript_present: true, transcript_content: transcriptContent, size_bytes: transcriptBytes, source_bytes: read.sourceBytes, truncated: read.truncated, redacted: true } });
    return {
      ...base,
      reachable: true,
      path: ref.path,
      transcript: read.text,
      sizeBytes: transcriptBytes,
      truncated: read.truncated,
      truncationDirection: read.truncationDirection,
      redacted: true,
      transcriptContent,
      sourceBytes: read.sourceBytes,
      transcriptBytes,
    };
  }

  /**
   * Searched paths for the LOCAL lookup diagnostic only (home directories
   * folded to `~`, bounded). A custom dataDir stays absolute, which is why
   * these never enter the feedback result frame or transcript_outcome.
   */
  private foldTranscriptLookupPaths(paths: readonly string[], runtimeHomeDir?: string): string[] {
    const homes = [...new Set([runtimeHomeDir, this.runtimeSessionHomeDir, os.homedir()].filter((h): h is string => Boolean(h)))]
      .sort((a, b) => b.length - a.length);
    return paths.slice(0, TRANSCRIPT_LOOKUP_SEARCHED_PATHS_MAX).map((p) => {
      const home = homes.find((h) => p === h || p.startsWith(`${h}${path.sep}`));
      const folded = home ? `~${p.slice(home.length)}` : p;
      return folded.length > TRANSCRIPT_LOOKUP_SEARCHED_PATH_MAX_CHARS
        ? `…${folded.slice(folded.length - TRANSCRIPT_LOOKUP_SEARCHED_PATH_MAX_CHARS + 1)}`
        : folded;
    });
  }

  /**
   * Collect the agent's current session transcript and upload it as a trace
   * bundle linked to a feedback report. The transcript is read using only the
   * sessionId bound to the agent; no caller-supplied session id is accepted.
   */
  async collectFeedbackTranscript(
    agentId: string,
    feedbackReportId: string,
    reportWindow: FeedbackTranscriptReportWindowInput = defaultFeedbackTranscriptReportWindow(),
    options: {
      /** Tier 2 (task #272): owner opted in; `machineLogPaths` are the runner log candidates. */
      includeMachineLogTail?: boolean;
      machineLogPaths?: readonly string[];
      /** task #279: the running daemon's own version for the machine-state summary. */
      daemonVersion?: string;
      /** task #1228 ①: the server's request id, signed into the transcript claims. */
      requestId?: string;
    } = {},
  ): Promise<FeedbackTranscriptCollectionResult> {
    return collectFeedbackTranscriptAttachment({
      agentId,
      feedbackReportId,
      reportWindow,
      ...(options.requestId ? { requestId: options.requestId } : {}),
      getSessionTranscript: () => this.getSessionTranscript(agentId, { anchorAt: reportWindow.reportGeneratedAt }),
      getObservedFailureSummary: (window) => this.buildObservedFailureSummary(agentId, window),
      getMachineEvidence: (window) => this.buildFeedbackMachineEvidence(window, options.daemonVersion),
      machineLogTail: {
        include: options.includeMachineLogTail === true,
        collect: (window) => collectFeedbackMachineLogTailAttachment({
          agentId,
          feedbackReportId,
          window,
          source: { paths: options.machineLogPaths ?? [] },
          serverUrl: this.serverUrl,
          daemonApiKey: this.daemonApiKey,
          workerUrl: this.workerUrl,
          tracer: this.tracer,
          fetchImpl: this.fetchImpl,
        }),
      },
      serverUrl: this.serverUrl,
      daemonApiKey: this.daemonApiKey,
      workerUrl: this.workerUrl,
      tracer: this.tracer,
      fetchImpl: this.fetchImpl,
    });
  }

  /** Whether this daemon can upload feedback attachments at all (worker URL configured). */
  get feedbackUploadsConfigured(): boolean {
    return Boolean(this.workerUrl);
  }

  /**
   * task #1228 ①: upload the transcript_outcome object for one request. Call
   * only AFTER the result frame was sent. Never rejects; never retries.
   */
  uploadFeedbackTranscriptOutcome(
    agentId: string,
    feedbackReportId: string,
    requestId: string,
    result: FeedbackTranscriptCollectionResult,
    daemonVersion: string | null,
  ): Promise<FeedbackTranscriptOutcomeUploadStatus | "not_attempted"> {
    if (!this.workerUrl) return Promise.resolve("not_attempted");
    return uploadFeedbackTranscriptOutcome({
      result,
      agentId,
      feedbackReportId,
      requestId,
      daemonVersion,
      serverUrl: this.serverUrl,
      daemonApiKey: this.daemonApiKey,
      workerUrl: this.workerUrl,
      tracer: this.tracer,
      fetchImpl: this.fetchImpl,
    });
  }

  /**
   * Tier-1 machine-side context for a feedback upload.
   *
   * Fails to `null` rather than throwing, on purpose: this is a diagnostic
   * add-on riding on the channel users report problems through, so it must not
   * be able to break the upload. `null` means "could not build", NOT "nothing
   * happened" -- the summary's own empty list already carries that distinction
   * and is emitted normally.
   */
  /**
   * task #279: default machine evidence. Fails to nulls, never throws; each
   * value passes the shared redaction as an exit guard and is dropped (not
   * altered) if redaction would change it.
   */
  private async buildFeedbackMachineEvidence(
    window: { from: string; to: string },
    daemonVersion: string | undefined,
  ): Promise<{ traceTail: FeedbackTraceTail | null; machineState: FeedbackMachineState | null }> {
    const machineDir = this.machineDir;
    let traceTail: FeedbackTraceTail | null = null;
    let machineState: FeedbackMachineState | null = null;
    try {
      traceTail = machineDir ? redactedOrNull(await collectFeedbackTraceTail({ machineDir, window })) : null;
    } catch (err) {
      logger.warn(`[FeedbackEvidence] trace tail unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      machineState = redactedOrNull(await collectFeedbackMachineState({ slockHome: this.slockHome, daemonVersion }));
    } catch (err) {
      logger.warn(`[FeedbackEvidence] machine state unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { traceTail, machineState };
  }

  private async buildObservedFailureSummary(
    agentId: string,
    window: { from: string; to: string },
  ): Promise<ObservedFailureSummary | null> {
    const machineDir = this.machineDir;
    if (!machineDir) return null;
    try {
      return await collectObservedFailureSummary({
        machineDir,
        agentId,
        from: window.from,
        to: window.to,
      });
    } catch (err) {
      logger.warn(`[FeedbackTranscript] observed failure summary unavailable for agent=${agentId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async listSkills(agentId: string, runtimeHint?: string): Promise<{ global: SkillInfo[]; workspace: SkillInfo[] }> {
    const agent = this.agents.get(agentId);
    const idle = this.lifecycleRecords.getRestartSnapshot(agentId);
    const config = agent?.config ?? idle?.config ?? null;
    const runtime = runtimeHint || config?.runtime || "claude";
    const workspaceDir = path.join(this.dataDir, agentId);
    const hostHome = os.homedir();
    const home = agent?.runtime.currentRuntimeHomeDir
      || (config
        ? ensureRuntimeHomeDir(config, hostHome, workspaceDir, { agentId, slockHome: this.slockHome })
        : runtime === "codex"
          ? resolveCodexHomeRootFromEnv(process.env, { defaultHomeDir: hostHome, cwd: workspaceDir })
          : hostHome);

    const paths = AgentProcessManager.SKILL_PATHS[runtime] || AgentProcessManager.SKILL_PATHS.claude;

    const globalDirs = runtime === "codex"
      ? [
        path.join(home, "skills"),
        path.join(home, "skills", ".system"),
        path.join(home, ".agents", "skills"),
        ...(hasConfiguredCodexHome(config) ? [] : [path.join(hostHome, ".agents", "skills")]),
      ]
      : paths.global.map((p) => path.join(home, p));
    const workspaceDirs = paths.workspace.map((p) => path.join(workspaceDir, p));

    const globalResults = await Promise.all(
      globalDirs.map((dir) => this.scanSkillsDir(dir)),
    );
    const workspaceResults = await Promise.all(
      workspaceDirs.map((dir) => this.scanSkillsDir(dir)),
    );

    // Deduplicate by skill name (first occurrence wins)
    const dedup = (skills: SkillInfo[]) => {
      const seen = new Set<string>();
      return skills.filter((s) => {
        if (seen.has(s.name)) return false;
        seen.add(s.name);
        return true;
      });
    };

    // Shorten home directory to ~ in source paths
    const shorten = (skills: SkillInfo[]) =>
      skills.map((s) => ({
        ...s,
        sourcePath: s.sourcePath?.startsWith(home) ? "~" + s.sourcePath.slice(home.length) : s.sourcePath,
      }));

    return {
      global: shorten(dedup(globalResults.flat())),
      workspace: shorten(dedup(workspaceResults.flat())),
    };
  }

  private async scanSkillsDir(dir: string): Promise<SkillInfo[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const skills: SkillInfo[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        // Standard skill: directory (or symlink to directory) with SKILL.md
        const skillMd = path.join(dir, entry.name, "SKILL.md");
        try {
          const content = await readFile(skillMd, "utf-8");
          const skill = this.parseSkillMd(entry.name, content);
          skill.sourcePath = dir;
          skills.push(skill);
        } catch {
          // No SKILL.md — skip
        }
      } else if (entry.name.endsWith(".md")) {
        // Legacy command: bare .md file (e.g. ~/.claude/commands/foo.md)
        const cmdName = entry.name.replace(/\.md$/, "");
        try {
          const content = await readFile(path.join(dir, entry.name), "utf-8");
          const skill = this.parseSkillMd(cmdName, content);
          skill.sourcePath = dir;
          skills.push(skill);
        } catch {
          // Unreadable — skip
        }
      }
    }
    return skills;
  }

  private parseSkillMd(dirName: string, content: string): SkillInfo {
    const info: SkillInfo = {
      name: dirName,
      displayName: dirName,
      description: "",
      userInvocable: false,
    };

    const frontmatter = parseSkillFrontmatter(content);
    if (frontmatter.name !== undefined) info.displayName = frontmatter.name;
    // Trimmed here rather than in the parser: the parser reports YAML truth,
    // including the trailing newline that distinguishes clip from strip from
    // keep, and SkillInfo.description is a presentation field where that
    // newline is noise. Chomping stays observable to anyone parsing directly.
    if (frontmatter.description !== undefined) info.description = frontmatter.description.trim();
    if (frontmatter["user-invocable"] !== undefined) {
      info.userInvocable = frontmatter["user-invocable"] === "true";
    }
    return info;
  }

  // Private methods

  /**
   * Broadcast an activity change — emits a single agent:activity event that carries
   * both the status (for the dot indicator) and trajectory entries (for the activity log).
   *
   * TODO(lifecycle-v2/daemon-protocol): split this legacy frame into
   * structured lifecycle producers. Runtime progress, transient heartbeat,
   * provider/runtime error, process exit, and user-visible activity entries
   * should carry explicit reason/correlation/window attrs so the server no
   * longer infers lifecycle semantics from generic activity strings.
   */
  private broadcastActivity(
    agentId: string,
    activityKind: AgentActivityKind,
    detail: string,
    extraTrajectory: TrajectoryEntry[] = [],
    launchIdOverride?: string | null,
    detailKind?: AgentActivityDetailKind,
    activityDisplay: string = activityKind,
    // APM 1.6 6b: closed subagent lineage marker attached to the built status
    // entry so lineage-bearing activity groups under a subagent card. Never
    // inferred; carries only ids/bounded tokens, no raw content.
    subagentLineage?: SubagentLineage["subagent"],
    runtimeError?: RuntimeErrorActivityDiagnostic,
    deliveryConsumption?: DeliveryConsumptionActivityDiagnostic,
    compaction?: RuntimeCompactionInterruption,
  ) {
    const ap = this.agents.get(agentId);

    // Build trajectory: any extra entries (thinking/text/tool_start) + a status entry.
    // Tool starts and thinking progress already convey the activity. Keep their live
    // activity update, but do not add a redundant (or blank) status row to the log.
    const entries: TrajectoryEntry[] = [...extraTrajectory];
    const hasToolStart = entries.some((e) => e.kind === "tool_start");
    const isTrajectoryProgressFrame =
      detail === "" &&
      (detailKind === "thinking_started" || detailKind === "model_response_started") &&
      entries.every((e) => e.kind === "thinking" || e.kind === "text");
    if (!hasToolStart && !isTrajectoryProgressFrame) {
      entries.push({
        kind: "status",
        activity: activityKind,
        detail,
        detailKind,
        ...(subagentLineage ? { subagent: subagentLineage } : {}),
        ...(compaction ? { compaction } : {}),
      });
    }
    const launchId = launchIdOverride || ap?.launchId || undefined;
    const sentDetailKind = this.activitySink.publishFact({
      agentId,
      activityKind,
      detail,
      detailKind,
      entries,
      launchId,
      runtimeError,
      providerRequest: ap?.providerRequest,
      deliveryConsumption,
    }, this.activityProducerContext(ap));
    if (!sentDetailKind) return;

    // Manage heartbeat timer: keep re-sending transient activities (working/thinking)
    // every ACTIVITY_HEARTBEAT_MS to prevent the server's stale-activity sweep from
    // resetting the status to "online" during long-running operations.
    if (ap) {
      ap.lastActivityKind = activityKind;
      ap.lastActivity = activityDisplay;
      ap.lastActivityDetail = detail;
      ap.lastActivityDetailKind = sentDetailKind;
      if (activityKind === "working" || activityKind === "thinking") {
        if (ap.activityHeartbeat.kind === "inactive") {
          const timer = setInterval(() => {
            if (this.markRuntimeProgressStaleIfNeeded(agentId, ap)) return;
            this.recordRuntimeTraceEvent(agentId, ap, "activity.heartbeat.sent", {
              activity: ap.lastActivityKind,
              detailKind: ap.lastActivityDetailKind,
            });
            this.activitySink.publishHeartbeat({
              agentId,
              activityKind: ap.lastActivityKind,
              providerRequest: ap.providerRequest,
              detail: ap.lastActivityDetail,
              detailKind: ap.lastActivityDetailKind,
              launchId: launchIdOverride || ap.launchId || undefined,
            }, this.activityProducerContext(ap));
          }, ACTIVITY_HEARTBEAT_MS);
          ap.activityHeartbeat = { kind: "active", timer };
        }
      } else {
        // Non-transient activity (online/offline) — stop heartbeat
        this.clearActivityHeartbeat(ap);
      }
    }
  }

  /** What the produced-activity trace records about the agent process. */
  private activityProducerContext(ap: AgentProcess | undefined): ActivityProducerContext {
    const runtimeContext = ap?.config.runtimeContext;
    return {
      present: Boolean(ap),
      serverId: runtimeContext?.serverId,
      machineId: runtimeContext?.machineId,
      processInstanceId: ap?.processInstanceId,
      sessionIdPresent: Boolean(ap?.sessionId),
      runtime: ap?.config.runtime,
    };
  }

  /**
   * Respond to a server-issued `agent:activity_probe`. Echoes the
   * agent's current `lastActivity` back through the existing
   * `agent:activity` upstream channel with the matching `probeId`.
   *
   * Why this exists: the server's stale-activity sweep used to
   * synthesize `online` whenever a transient state went 90s without
   * an update. That invented state without consulting ground truth
   * and produced "agent shows green/idle but is actually working" UI
   * staleness (#engineering:72283cf7 task #340 RCA).
   *
   * The new flow: server sends `agent:activity_probe` for stale
   * agents, daemon replies here with the *real* current activity, and
   * the server only falls back to synth-online if the probe times out
   * (5s). The body is intentionally minimal — no entries, no
   * heartbeat side-effects, no state mutation. We just echo what we
   * already know.
   *
   * If the agent is no longer running locally (`ap` undefined), we
   * report `offline` so the server stops believing the agent is busy.
   */
  public respondToActivityProbe(agentId: string, probeId: string) {
    const ap = this.agents.get(agentId);
    const stickyTerminalFailure = ap ? classifyStickyTerminalFailure(ap) : null;
    const hasPendingInjectionDebt = Boolean(ap && ap.inbox.length > 0 && !stickyTerminalFailure);
    const activityKind: AgentActivityKind = hasPendingInjectionDebt ? "working" : ap?.lastActivityKind || "offline";
    const detail = hasPendingInjectionDebt ? "Message received" : ap?.lastActivityDetail || (ap ? "" : "Agent not running");
    const detailKind: AgentActivityDetailKind = hasPendingInjectionDebt ? "message_received" : ap?.lastActivityDetailKind ?? "runtime_unavailable";
    const launchId = ap?.launchId || undefined;
    this.activitySink.respondToProbe({ agentId, activityKind, detail, detailKind, launchId }, probeId, this.activityProducerContext(ap));
    if (hasPendingInjectionDebt) {
      this.recordDaemonEvent("daemon.agent.activity_probe.pending_delivery", {
        agentId,
        probeId,
        launchId,
        runtime: ap?.config.runtime,
        inbox_count: ap?.inbox.length,
        session_id_present: Boolean(ap?.sessionId),
        session_ready_for_delivery: ap ? this.canDeliverToRuntimeSession(ap) : false,
      });
    }
  }

  private flushPendingTrajectory(agentId: string) {
    const ap = this.agents.get(agentId);
    const pending = ap?.pendingTrajectory;
    if (!ap || !pending) return;

    clearTimeout(pending.timer);
    ap.pendingTrajectory = null;

    const text = pending.text.length > MAX_TRAJECTORY_TEXT
      ? pending.text.slice(0, MAX_TRAJECTORY_TEXT) + "\u2026"
      : pending.text;
    if (!text) return;

    const entry: TrajectoryEntry = pending.kind === "thinking"
      ? { kind: "thinking", text, ...(pending.subagent ? { subagent: pending.subagent } : {}) }
      : { kind: "text", text, ...(pending.subagent ? { subagent: pending.subagent } : {}) };
    const projection = trajectoryActivityProjection(pending.kind);
    this.broadcastActivity(agentId, projection.activityKind, "", [entry], undefined, projection.detailKind);
  }

  private queueTrajectoryText(
    agentId: string,
    kind: "thinking" | "text",
    text: string,
    // APM 1.6 6b: explicit subagent lineage from the source row, if any.
    subagent?: SubagentLineage["subagent"],
  ) {
    const ap = this.agents.get(agentId);
    if (!ap) {
      this.recordDaemonEvent("daemon.agent.activity.skipped", {
        agentId,
        event_kind: kind,
        reason: "agent_process_missing",
        text_length: text.length,
      });
      return;
    }

    const projection = trajectoryActivityProjection(kind);
    if (!text) {
      this.broadcastActivity(agentId, projection.activityKind, "", [], undefined, projection.detailKind);
      return;
    }

    const pending = ap.pendingTrajectory;
    // Only coalesce rows that share BOTH kind and subagent lineage so a subagent
    // thinking block can't merge into a top-level one (or vice versa).
    const sameLineage = JSON.stringify(pending?.subagent ?? null) === JSON.stringify(subagent ?? null);
    if (pending && pending.kind === kind && sameLineage) {
      pending.text += text;
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => this.flushPendingTrajectory(agentId), TRAJECTORY_COALESCE_MS);
      return;
    }

    this.flushPendingTrajectory(agentId);
    if (ap.lastActivityKind !== projection.activityKind || ap.lastActivityDetailKind !== projection.detailKind) {
      this.broadcastActivity(agentId, projection.activityKind, "", [], undefined, projection.detailKind);
    }
    ap.pendingTrajectory = {
      kind,
      text,
      ...(subagent ? { subagent } : {}),
      timer: setTimeout(() => this.flushPendingTrajectory(agentId), TRAJECTORY_COALESCE_MS),
    };
  }

  private clearCompactionWatchdog(ap: AgentProcess) {
    if (ap.compaction.kind === "active" && ap.compaction.watchdog) {
      clearTimeout(ap.compaction.watchdog);
    }
    ap.compaction = { kind: "none" };
  }

  private clearStalledRecoverySigtermWatchdog(ap: AgentProcess) {
    if (ap.exit.kind !== "live" || !ap.exit.stalledRecoverySigtermTimer) return;
    clearTimeout(ap.exit.stalledRecoverySigtermTimer);
    ap.exit = { ...ap.exit, stalledRecoverySigtermTimer: null };
  }

  private mergeRuntimeExitTraceAttrs(runtime: RuntimeSession, attrs: Record<string, unknown>) {
    this.runtimeExitTraceAttrs.set(runtime, {
      ...(this.runtimeExitTraceAttrs.get(runtime) ?? {}),
      ...attrs,
    });
  }

  private startStalledRecoverySigtermWatchdog(
    agentId: string,
    ap: AgentProcess,
    runtimeLabel: string,
    queuedMessagesAtSignal: number,
    staleForMs: number,
  ) {
    this.clearStalledRecoverySigtermWatchdog(ap);
    const timeoutMs = stalledRecoverySigtermTimeoutMs();
    const runtimeAtSignal = ap.runtime;

    const timer = setTimeout(() => {
      if (ap.exit.kind === "live" && ap.exit.stalledRecoverySigtermTimer === timer) {
        ap.exit = { ...ap.exit, stalledRecoverySigtermTimer: null };
      }
      const current = this.agents.get(agentId);
      if (
        !current ||
        current !== ap ||
        current.runtime !== runtimeAtSignal ||
        current.gatedSteering.expectedTerminationReason !== "stalled_recovery"
      ) {
        return;
      }

      this.mergeRuntimeExitTraceAttrs(runtimeAtSignal, {
        stalled_recovery_sigterm_timeout: true,
        stalled_recovery_sigterm_timeout_ms: timeoutMs,
      });
      this.recordDaemonEvent("daemon.agent.stalled_recovery.sigterm_timeout", {
        agentId,
        launchId: current.launchId || undefined,
        runtime: current.config.runtime,
        model: current.config.model,
        runtime_label: runtimeLabel,
        queued_messages_count: current.inbox.length,
        queued_messages_at_signal: queuedMessagesAtSignal,
        stale_age_ms_at_signal: staleForMs,
        timeout_ms: timeoutMs,
        process_pid_present: typeof runtimeAtSignal.pid === "number",
        session_id_present: Boolean(current.sessionId),
        supports_stdin_notification: current.driver.supportsStdinNotification,
        busy_delivery_mode: current.driver.busyDeliveryMode,
      }, "error");
      logger.warn(
        `[Agent ${agentId}] Stalled ${runtimeLabel} runtime did not exit after SIGTERM within ${timeoutMs}ms; force killing`,
      );
      try {
        void runtimeAtSignal.stop({ signal: "SIGKILL", reason: "stalled_recovery_sigterm_timeout" });
        this.recordDaemonEvent("daemon.runtime.stall.recovery_action", {
          ...this.processLifecycleIdentityAttrs(agentId, current),
          action: "sigkill_escalation",
          outcome: "initiated",
          delay_ms_bucket: bucketMs(timeoutMs),
        }, "error");
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.recordDaemonEvent("daemon.agent.stalled_recovery.sigkill_failed", {
          agentId,
          launchId: current.launchId || undefined,
          runtime: current.config.runtime,
          model: current.config.model,
          reason,
        }, "error");
        this.recordDaemonEvent("daemon.runtime.stall.recovery_action", {
          ...this.processLifecycleIdentityAttrs(agentId, current),
          action: "sigkill_escalation",
          outcome: "kill_failed",
          delay_ms_bucket: bucketMs(timeoutMs),
          kill_signal_sequence: "SIGTERM,SIGKILL",
          kill_attempts: 2,
          subprocess_os_state: probeSubprocessOsState(current.runtime.pid),
          daemon_child_tracking_present: this.agents.has(agentId),
        }, "error");
        logger.warn(`[Agent ${agentId}] Failed to force kill stalled ${runtimeLabel} process: ${reason}`);
      }
    }, timeoutMs);
    if (ap.exit.kind === "live") {
      ap.exit = { ...ap.exit, stalledRecoverySigtermTimer: timer };
    }
  }

  private startCompactionWatchdog(agentId: string, ap: AgentProcess) {
    this.clearCompactionWatchdog(ap);
    const startedAt = Date.now();
    const watchdog = setTimeout(() => {
      this.markCompactionStale(agentId, startedAt);
    }, COMPACTION_STALE_MS);
    ap.compaction = { kind: "active", startedAt, watchdog };
  }

  private markCompactionStale(agentId: string, startedAt: number) {
    const ap = this.agents.get(agentId);
    if (!ap || ap.compaction.kind !== "active" || ap.compaction.startedAt !== startedAt) return;
    ap.compaction = { ...ap.compaction, watchdog: null };
    this.broadcastActivity(agentId, "working", "Context compaction still running; no finish event observed", [], undefined, "compaction_stale");
  }

  private startReviewWatchdog(agentId: string, ap: AgentProcess) {
    this.clearReviewWatchdog(ap);
    const startedAt = Date.now();
    const watchdog = setTimeout(() => {
      this.markReviewStale(agentId, startedAt);
    }, REVIEW_STALE_MS);
    ap.review = { kind: "active", startedAt, watchdog };
  }

  private clearReviewWatchdog(ap: AgentProcess) {
    if (ap.review.kind === "active" && ap.review.watchdog) {
      clearTimeout(ap.review.watchdog);
    }
    ap.review = { kind: "none" };
  }

  private markReviewStale(agentId: string, startedAt: number) {
    const ap = this.agents.get(agentId);
    if (!ap || ap.review.kind !== "active" || ap.review.startedAt !== startedAt) return;
    ap.review = { ...ap.review, watchdog: null };
    this.broadcastActivity(agentId, "working", "Review mode still active; no finish event observed", [], undefined, "review_stale");
    // Restore delivery — suppress was gated on ap.gatedSteering.reviewing, which is now resolved via review_finished below.
    const reduction = reduceApmGatedReview(ap.gatedSteering, { kind: "review_finished" });
    this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
    this.flushReviewBoundaryMessages(agentId, ap);
  }

  private completeCompactionIfActive(
    agentId: string,
    detail = "Context compaction finished",
    options: { flushBoundaryMessages?: boolean } = {},
  ) {
    const ap = this.agents.get(agentId);
    if (!ap || ap.compaction.kind !== "active") return;
    this.clearCompactionWatchdog(ap);
    this.broadcastActivity(agentId, "working", detail, [{ kind: "compaction_finished" }], undefined, "compaction_finished");
    const reduction = reduceApmGatedCompaction(ap.gatedSteering, { kind: "compaction_finished" });
    this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
    if (options.flushBoundaryMessages ?? true) {
      this.flushCompactionBoundaryMessages(agentId, ap);
    }
    this.commitApmIdleState(agentId, ap, false);
  }

  private interruptCompactionIfActive(
    agentId: string,
    options: {
      detail?: string;
      detailKind?: AgentActivityDetailKind;
      entries?: TrajectoryEntry[];
      flushBoundaryMessages?: boolean;
      traceAttrs?: Record<string, unknown>;
    } = {},
  ) {
    const ap = this.agents.get(agentId);
    if (!ap || (ap.compaction.kind !== "active" && !ap.gatedSteering.compacting)) return false;
    this.clearCompactionWatchdog(ap);
    const reduction = reduceApmGatedCompaction(ap.gatedSteering, { kind: "compaction_interrupted" });
    this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
    if (options.traceAttrs) {
      this.recordRuntimeTraceEvent(agentId, ap, "runtime.context_compaction.interrupted", options.traceAttrs);
    }
    if (options.detail) {
      this.broadcastActivity(
        agentId,
        "error",
        options.detail,
        options.entries ?? [],
        undefined,
        options.detailKind ?? "runtime_error",
      );
    }
    if (options.flushBoundaryMessages) {
      this.flushCompactionBoundaryMessages(agentId, ap);
    }
    return true;
  }

  private flushReviewBoundaryMessages(agentId: string, ap: AgentProcess) {
    const reduction = reduceApmGatedReviewBoundaryFlush(ap.gatedSteering, {
      hasSession: Boolean(ap.sessionId),
      supportsStdinNotification: ap.driver.supportsStdinNotification,
      inboxLength: ap.inbox.length,
      pendingNotificationCount: ap.notifications.pendingCount,
    });
    for (const effect of reduction.effects) {
      this.executeApmGatedSteeringEffect(agentId, ap, effect);
    }
  }

  private interruptReviewIfActive(agentId: string) {
    const ap = this.agents.get(agentId);
    if (!ap?.gatedSteering.reviewing) return;
    const reduction = reduceApmGatedReview(ap.gatedSteering, { kind: "review_finished" });
    this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
  }

  private messagesTraceAttrs(messages?: AgentMessage[]): Record<string, unknown> {
    if (!messages || messages.length === 0) return {};
    const first = messages[0];
    const context = this.getDeliveryTraceContext(first);
    const notification = runtimeProfileNotificationFromMessage(first);
    if (notification) {
      return {
        messages_count: messages.length,
        message_id_present: Boolean(first.message_id),
        deliveryId: context.deliveryId,
        delivery_correlation_id: context.deliveryId,
        ...messageProducerFactTraceAttrs(messages),
        control_kind: notification.kind,
        key_present: Boolean(notification.key),
        runtime_profile_control_kind: notification.kind,
        runtime_profile_key_hash: hashRuntimeProfileKey(notification.key),
        runtime_profile_key_present: Boolean(notification.key),
      };
    }
    return {
      messages_count: messages.length,
      messageId: first.message_id,
      message_id_present: Boolean(first.message_id),
      deliveryId: context.deliveryId,
      delivery_correlation_id: context.deliveryId ?? first.message_id,
      ...messageProducerFactTraceAttrs(messages),
    };
  }

  private recordAttentionHintsShown(agentId: string, rows: readonly AgentInboxTargetRow[], source: string): void {
    for (const row of rows) {
      const hint = row.attentionHint;
      if (!hint) continue;
      this.recordDaemonEvent("attention_hint_shown", {
        agentId,
        trigger: hint.trigger,
        scope: hint.scope,
        suggested_command: hint.suggested_command,
        copy_version: hint.copy_version,
        epoch_ms: Date.now(),
        source,
        target: row.target,
        K: hint.thresholds.K,
        k: hint.thresholds.k,
        window_ms: hint.thresholds.window_ms,
      });
    }
  }

  private runtimeProfileTurnControlTraceAttrs(control: RuntimeProfileTurnControl | null): Record<string, unknown> {
    if (!control) return {};
    const pendingAgeMs = Math.max(0, Date.now() - control.injectedAtMs);
    return {
      runtime_profile_control_kind: control.kind,
      runtime_profile_control_source: control.source,
      runtime_profile_key_hash: control.keyHash || undefined,
      runtime_profile_key_present: control.keyPresent,
      runtime_profile_pending_age_ms: pendingAgeMs,
      runtime_profile_requires_ack: false,
    };
  }

  private activateRuntimeProfileTurnControl(
    ap: AgentProcess,
    control: RuntimeProfileTurnControl | null,
  ): void {
    ap.runtimeProfileTurnControl = control;
  }

  private runtimeProfileTurnControlFromMessages(
    messages?: AgentMessage[],
    source: RuntimeProfileControlSource = "message",
  ): RuntimeProfileTurnControl | null {
    const notifications = messages
      ?.map((message) => runtimeProfileNotificationFromMessage(message))
      .filter((candidate): candidate is { kind: RuntimeProfileControlKind; key: string } => Boolean(candidate)) ?? [];
    const notification = notifications.find((candidate) => candidate.kind === "migration")
      ?? notifications[0];
    if (!notification) return null;
    return runtimeProfileTurnControl(notification.kind, notification.key, source);
  }

  private finalizeRuntimeProfileTurnControl(agentId: string, ap: AgentProcess, terminal: "turn_end" | "runtime_error" | "runtime_stalled" | "process_exit"): Record<string, unknown> {
    const control = ap.runtimeProfileTurnControl;
    if (!control) return {};
    const attrs = this.runtimeProfileTurnControlTraceAttrs(control);
    ap.runtimeProfileTurnControl = null;
    return {
      ...attrs,
      runtime_profile_turn_terminal: terminal,
      runtime_profile_turn_outcome: control.kind === "migration"
        ? "reset_session_notice"
        : "notice_only",
    };
  }

  private startRuntimeTrace(
    agentId: string,
    ap: AgentProcess,
    reason: string,
    messages?: AgentMessage[],
    inputTraceAttrs: Record<string, unknown> = {},
  ): ActiveSpan {
    if (ap.runtimeTraceSpan) return ap.runtimeTraceSpan;
    ap.runtimeTraceCounters = createRuntimeTraceCounters();

    const messageControl = this.runtimeProfileTurnControlFromMessages(messages);
    if (messageControl) {
      this.activateRuntimeProfileTurnControl(ap, messageControl);
    }

    const span = this.tracer.startSpan("daemon.runtime.turn", {
      parent: getActiveTraceContext(),
      surface: "daemon",
      kind: "internal",
      attrs: {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        reason,
        hasSession: Boolean(ap.sessionId),
        sessionReadyForDelivery: ap.sessionReadyForDelivery,
        ...this.processLifecycleIdentityAttrs(agentId, ap),
        ...this.messagesTraceAttrs(messages),
        ...inputTraceAttrs,
        ...this.runtimeLaunchPolicyTraceAttrs(ap.config),
        ...this.runtimeProfileTurnControlTraceAttrs(ap.runtimeProfileTurnControl),
      },
    });
    span.addEvent("daemon.turn.started", {
      reason,
      sessionReadyForDelivery: ap.sessionReadyForDelivery,
      ...this.processLifecycleIdentityAttrs(agentId, ap),
      ...this.messagesTraceAttrs(messages),
      ...inputTraceAttrs,
      ...this.runtimeLaunchPolicyTraceAttrs(ap.config),
      ...this.runtimeProfileTurnControlTraceAttrs(ap.runtimeProfileTurnControl),
    });
    ap.runtimeTraceSpan = span;
    return span;
  }

  private endRuntimeTrace(ap: AgentProcess, status: "ok" | "error" | "cancelled", attrs?: Record<string, unknown>) {
    if (!ap.runtimeTraceSpan) return;
    ap.runtimeTraceSpan.end(status, attrs ? { attrs } : undefined);
    ap.runtimeTraceSpan = null;
  }

  // Adds the fact to the open turn span. A turn span is opened only when a
  // turn really starts, so a fact seen outside a turn becomes a standalone
  // event instead of opening a turn.
  private recordRuntimeTraceEvent(agentId: string, ap: AgentProcess, name: string, attrs?: Record<string, unknown>) {
    const eventAttrs = {
      ...this.processLifecycleIdentityAttrs(agentId, ap),
      ...attrs,
    };
    if (ap.runtimeTraceSpan) {
      ap.runtimeTraceSpan.addEvent(name, eventAttrs);
      return;
    }
    this.recordDaemonEvent(`daemon.${name}`, { agentId, runtime: ap.config.runtime, ...eventAttrs });
  }

  // task #917 — a rejected turn/start used to be restored and redelivered every
  // stdinNotificationRetryMs with no bound, so a provider that rejects every
  // prompt (Grok Build 402 "usage balance exhausted") looped into the same
  // session forever, and the same-fingerprint fence never saw it because it
  // only counted `error` events. Billing failures now stop at once; any other
  // rejected turn/start counts toward that fence. Busy rejections and steers are
  // ordinary back-pressure and never count.
  private stopOnTerminalDeliveryError(
    agentId: string,
    ap: AgentProcess,
    event: RuntimeDeliveryErrorEvent,
  ): boolean {
    if (event.code === "turn.agent_busy" || event.requestMethod !== "turn/start") return false;
    const diagnostics = buildRuntimeErrorDiagnosticEnvelope(event.message);
    let detail: string;
    if (diagnostics.spanAttrs.runtime_error_class === "BillingError") {
      detail = formatRuntimeBillingExhaustedMessage(ap.driver.id);
      this.recordDaemonEvent("daemon.agent.stdin_delivery.terminal_rejected", {
        agentId,
        launchId: ap.launchId || undefined,
        runtime: ap.config.runtime,
        model: ap.config.model,
        request_method: event.requestMethod,
        source: event.source,
        runtime_error_class: diagnostics.spanAttrs.runtime_error_class,
        runtime_error_fingerprint: diagnostics.spanAttrs.runtime_error_fingerprint,
      }, "error");
      this.sendAgentStatus(agentId, "inactive", ap.launchId);
      // RFC 071 §7: fingerprint of the raw rejection, not of the display copy in `detail`.
      this.cleanupTerminalRuntimeFailure(agentId, ap, detail, terminalFailureFromRawText("billing_rejected", event.message));
    } else {
      const fingerprint = typeof diagnostics.spanAttrs.runtime_error_fingerprint === "string"
        ? diagnostics.spanAttrs.runtime_error_fingerprint
        : null;
      const fence = this.noteRuntimeErrorFingerprintFence(agentId, ap, event.message, fingerprint, null, null);
      if (!fence) return false;
      detail = fence.detail;
      this.applyRuntimeErrorFingerprintFence(agentId, ap, fence);
    }
    this.broadcastActivity(
      agentId,
      "error",
      detail,
      [{ kind: "text", text: `Error: ${detail}` }],
      ap.launchId,
      "runtime_error",
      "error",
      undefined,
      buildRuntimeErrorActivityDiagnostic(event.message),
    );
    return true;
  }

  private restoreRuntimeDeliveryAfterAsyncRejection(
    agentId: string,
    ap: AgentProcess,
    event: RuntimeDeliveryErrorEvent,
  ): void {
    const pendingBefore = ap.notifications.pendingCount;
    const restoredMessages = ap.inbox.filter((message) =>
      ap.notifications.hasContributedMessage(message, ap.sessionId)
    );
    ap.notifications.clearNoticeFingerprint();
    const restoredNotificationCount = ap.driver.supportsStdinNotification && ap.sessionId && restoredMessages.length > 0
      ? ap.notifications.add(restoredMessages.length)
      : 0;
    if (event.requestMethod === "turn/start") {
      this.commitApmIdleState(agentId, ap, true);
    }
    const idleRetryScheduled = event.requestMethod === "turn/start" && restoredNotificationCount > 0
      ? ap.notifications.schedule(() => {
          this.flushAsyncRejectedIdleDelivery(agentId);
        }, this.stdinNotificationRetryMs)
      : false;

    const attrs = {
      request_method: event.requestMethod,
      source: event.source, error_code: event.code ?? "runtime.delivery_error",
      payloadBytes: event.payloadBytes,
      inbox_count: ap.inbox.length,
      restored_messages_count: restoredMessages.length,
      pending_notification_count_before: pendingBefore,
      pending_notification_count_after: ap.notifications.pendingCount,
      restored_notification_count: restoredNotificationCount,
      session_id_present: Boolean(ap.sessionId),
      supports_stdin_notification: ap.driver.supportsStdinNotification,
      busy_delivery_mode: ap.driver.busyDeliveryMode,
      restored_idle_state: event.requestMethod === "turn/start",
      idle_retry_scheduled: idleRetryScheduled,
    };
    this.recordRuntimeTraceEvent(agentId, ap, "runtime.delivery.async_rejected", attrs);
    this.recordDaemonEvent("daemon.agent.stdin_delivery.async_rejected", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      model: ap.config.model,
      ...attrs,
    }, "error");
  }

  private noteRuntimeProgress(ap: AgentProcess, eventKind?: ParsedEvent["kind"]) {
    ap.runtimeProgress.noteRuntimeEvent(eventKind);
    this.invalidateRecoveryErrorView(ap);
  }

  /**
   * Invalidate the decision-only error view on a liveness signal. The process is
   * alive and has moved past any error it logged earlier in the turn, so a stale
   * error must not keep restarting/re-routing a recovered agent. Error-class
   * agnostic; a genuinely current failure re-populates the view after this point.
   * Called on BOTH progress paths — ordinary runtime events and
   * `internal_progress` (raw runtime activity that stale-recovery already treats
   * as liveness). `recentStderr`/`lastRuntimeError` are untouched and stay full
   * for diagnostics, user-facing reporting, and sticky terminal-failure gating.
   */
  private invalidateRecoveryErrorView(ap: AgentProcess) {
    ap.decisionErrorWindow.noteRuntimeProgress();
  }

  private commitGatedSteeringDecisionState(
    agentId: string,
    ap: AgentProcess,
    nextState: ApmGatedSteeringDecisionState,
  ): void {
    const wasIdle = this.isApmIdle(ap);
    ap.gatedSteering = commitApmGatedSteeringDecisionState(nextState);
    if (!wasIdle && this.isApmIdle(ap)) {
      this.drainAppInboxAfterIdleTransition(agentId);
    }
  }

  private commitApmIdleState(agentId: string, ap: AgentProcess, nextIsIdle: boolean): void {
    const reduction = reduceApmIdleState(ap.gatedSteering, { isIdle: nextIsIdle });
    this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
  }

  private pruneAppInboxNoticeMemo(agentId: string, items: readonly AgentInboxAppItem[]): void {
    const delivered = this.appInboxNoticedItemIds.get(agentId);
    if (!delivered) return;
    const current = new Set(items.map((item) => item.itemId));
    for (const itemId of delivered) {
      if (!current.has(itemId)) delivered.delete(itemId);
    }
    if (delivered.size === 0) this.appInboxNoticedItemIds.delete(agentId);
  }

  private undeliveredAppInboxItems(
    agentId: string,
    items: readonly AgentInboxAppItem[],
  ): AgentInboxAppItem[] {
    const delivered = this.appInboxNoticedItemIds.get(agentId);
    if (!delivered) return [...items];
    return items.filter((item) => !delivered.has(item.itemId));
  }

  private markAppInboxNoticeDelivered(agentId: string, items: readonly AgentInboxAppItem[]): void {
    let delivered = this.appInboxNoticedItemIds.get(agentId);
    if (!delivered) {
      delivered = new Set();
      this.appInboxNoticedItemIds.set(agentId, delivered);
    }
    // The wake is a prompt to inspect the App Inbox, so one successful notice
    // covers all pending items visible at that point. Later distinct items are
    // outside this memo and still get their own wake.
    for (const item of items) delivered.add(item.itemId);
  }

  private drainAppInboxAfterIdleTransition(agentId: string): void {
    if (!this.#appInboxForAgent) return;
    if (this.appInboxIdleDrains.has(agentId)) return;
    let appItems: readonly AgentInboxAppItem[];
    try {
      appItems = this.#appInboxForAgent(agentId).list();
    } catch (error) {
      // This method runs synchronously inside a runtime event listener. Letting
      // a scoped-store failure escape here would crash the daemon instead of
      // leaving the occurrence on its bounded retry path.
      logger.error(`[Agent ${agentId}] Failed to read App Inbox after idle transition`, error);
      this.recordDaemonEvent("daemon.agent.app_inbox_notice", {
        owner_agent_id_present: true,
        outcome: "store_read_failed",
        message_identity_created: false,
      }, "error");
      return;
    }
    this.pruneAppInboxNoticeMemo(agentId, appItems);
    const pending = this.undeliveredAppInboxItems(agentId, appItems);
    if (pending.length === 0) return;

    this.appInboxIdleDrains.add(agentId);
    // The agent is live here; the drain only re-offers pending items and must
    // not upgrade an advisory notice into a wake (a per_turn deferral keeps
    // whatever wake intent the original notice had).
    void this.notifyAgentAppInbox(agentId, pending[0]!, { startStoppedAgent: false })
      .catch((error) => {
        logger.error(`[Agent ${agentId}] Failed to drain App Inbox after idle transition`, error);
        // Backstop for throws outside notifyAgentAppInbox's own traced failure
        // outcomes (see the store-read catch above).
        this.recordDaemonEvent("daemon.agent.app_inbox_notice", {
          owner_agent_id_present: true,
          outcome: "drain_threw",
          message_identity_created: false,
          error_class: errorClassOf(error),
        }, "error");
      })
      .finally(() => {
        this.appInboxIdleDrains.delete(agentId);
      });
  }

  private recordApmGatedSteeringEffectTrace(
    agentId: string,
    ap: AgentProcess,
    effect: ApmGatedSteeringEffect,
    attrs: Record<string, unknown>,
  ): void {
    this.recordDaemonEvent("daemon.apm.gated_effect", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      effect_kind: effect.kind,
      reason: effect.reason,
      target: "runtime-stdin",
      stdin_mode: effect.stdinMode,
      clause_id: effect.clauseId,
      pending_messages: ap.inbox.length,
      ...attrs,
    });
  }

  private executeApmGatedSteeringEffect(
    agentId: string,
    ap: AgentProcess,
    effect: ApmGatedSteeringEffect,
  ): boolean {
    switch (effect.kind) {
      case "notify_stdin":
        {
          const written = this.sendStdinNotification(agentId);
          this.recordApmGatedSteeringEffectTrace(agentId, ap, effect, {
            outcome: written ? "written" : "not_written",
          });
          return written;
        }
      case "deliver_stdin": {
        const runtimeErrorBackoffRemainingMs = this.runtimeErrorDeliveryBackoffRemainingMs(ap);
        if (runtimeErrorBackoffRemainingMs > 0) {
          const scheduled = this.scheduleRuntimeErrorDeliveryBackoffFlush(agentId, ap);
          this.recordApmGatedSteeringEffectTrace(agentId, ap, effect, {
            outcome: "suppressed_runtime_error_backoff",
            runtime_error_backoff_remaining_ms: runtimeErrorBackoffRemainingMs,
            runtime_error_backoff_attempts: ap.runtimeErrorDeliveryBackoff.attempts,
            runtime_error_backoff_reason: ap.runtimeErrorDeliveryBackoff.reason || undefined,
            runtime_error_backoff_timer_scheduled: scheduled || this.runtimeErrorDeliveryBackoffTimerScheduled(ap),
            delivered_messages_count: 0,
          });
          return false;
        }
        const messages = [...ap.inbox];
        ap.notifications.pruneContributedToPending(ap.inbox, ap.sessionId);
        ap.notifications.clearPending();
        ap.notifications.clearTimer();
        if (messages.length === 0) {
          this.recordApmGatedSteeringEffectTrace(agentId, ap, effect, {
            outcome: "empty",
            delivered_messages_count: 0,
          });
          return true;
        }
        const runtimeProfileMessages = messages.filter((message) => runtimeProfileNotificationFromMessage(message));
        const ordinaryMessageCandidates = messages.filter((message) => !runtimeProfileNotificationFromMessage(message));
        let ordinaryMessages = ap.notifications.filterUncontributedMessages(
          ordinaryMessageCandidates,
          ap.sessionId,
        );
        // RETIRED 2026-08-03 (task #524 regression, Tenny-authorized revert):
        // the turn_end delivery-debt re-arm introduced by #5911 is removed.
        // It re-delivered already-contributed messages on EVERY turn_end:
        // clearNoticeFingerprint() erased all dedup memory, the resulting write
        // re-recorded the same identity via recordNoticeWritten(), and the next
        // turn_end retriggered on that record — a fixpoint with no terminating
        // edge, since delivery never consumes the inbox. A non-reading agent
        // (wedged / rate-limited / mute-session) burned one turn admission plus
        // one injection per turn indefinitely, reopening the #58 retry-storm
        // class. Re-establish only under task #70's redesign: at-least-once
        // anchored on "debt genuinely unconsumed", with a suppression memo that
        // survives the turn boundary.
        const rearmedDeliveryDebt = false;
        if (runtimeProfileMessages.length === 0 && ordinaryMessages.length === 0) {
          this.recordApmGatedSteeringEffectTrace(agentId, ap, effect, {
            outcome: "suppressed_already_contributed",
            delivered_messages_count: 0,
          });
          return false;
        }
        let accepted = true;
        if (runtimeProfileMessages.length > 0) {
          ap.inbox.splice(0, ap.inbox.length, ...ordinaryMessageCandidates);
          accepted = this.deliverMessagesViaStdin(agentId, ap, runtimeProfileMessages, effect.stdinMode);
        }
        if (ordinaryMessages.length > 0) {
          accepted = this.deliverInboxUpdateViaStdin(
            agentId,
            ap,
            ordinaryMessages,
            effect.stdinMode,
            `stdin_${effect.stdinMode}_delivery`,
          ) && accepted;
        }
        this.recordApmGatedSteeringEffectTrace(agentId, ap, effect, {
          outcome: accepted ? "written" : "not_written",
          delivered_messages_count: runtimeProfileMessages.length + ordinaryMessages.length,
          rearmed_delivery_debt: rearmedDeliveryDebt,
        });
        return accepted;
      }
      default:
        return assertNeverApmEffect(effect);
    }
  }

  private flushCompactionBoundaryMessages(agentId: string, ap: AgentProcess): boolean {
    const reduction = reduceApmGatedCompactionBoundaryFlush(ap.gatedSteering, {
      hasSession: Boolean(ap.sessionId),
      supportsStdinNotification: ap.driver.supportsStdinNotification,
      inboxLength: ap.inbox.length,
      pendingNotificationCount: ap.notifications.pendingCount,
    });
    if (reduction.effects.length === 0) return false;

    ap.notifications.clearTimer();
    for (const effect of reduction.effects) {
      this.executeApmGatedSteeringEffect(agentId, ap, effect);
    }
    return true;
  }

  private launchIdentityAttrs(agentId: string, ap: AgentProcess, launchSource: string): LaunchIdentityAttrs {
    const runtimeContext = ap.config.runtimeContext;
    return {
      agent_launch_id: ap.launchId ?? null,
      agent_id: agentId,
      server_id: runtimeContext?.serverId ?? null,
      machine_id: runtimeContext?.machineId ?? null,
      runtime: ap.config.runtime,
      driver: ap.driver.id,
      launch_source: launchSource,
    };
  }

  /**
   * Phase-5 exported-row ENTER: opens the runtime-readiness wait row (task
   * #149). Idempotent — a second call while a row is open is a no-op so the
   * (agent_launch_id, state_instance_id) pair keeps exactly-one enter.
   */
  private openRuntimeReadinessTransition(
    agentId: string,
    ap: AgentProcess,
    launchSource: string,
    fenceKind: LaunchFenceKind,
    deadlineUnixMs: number | null,
  ): void {
    if (ap.readinessTransition) return;
    const identity = this.launchIdentityAttrs(agentId, ap, launchSource);
    const state: LaunchReadinessTransitionState = {
      stateInstanceId: randomUUID(),
      enterSeq: this.launchTransitionSeq++,
      identity,
      fenceKind,
      deadlineUnixMs,
      negativeEvidenceBucket: launchReadinessNegativeEvidence(identity),
    };
    ap.readinessTransition = state;
    this.recordDaemonEvent(LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN, buildLaunchReadinessEnterAttrs(state));
  }

  /**
   * Phase-5 exported-row CLOSE: closes the open runtime-readiness wait row with
   * a closed `close_result` (task #149). Idempotent — no-op when no row is open,
   * so overlapping close paths (ready event, timeout fire, process exit,
   * cleanup) emit exactly one close.
   */
  private closeRuntimeReadinessTransition(ap: AgentProcess, closeResult: LaunchCloseResult): void {
    const state = ap.readinessTransition;
    if (!state) return;
    ap.readinessTransition = null;
    this.recordDaemonEvent(
      LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN,
      buildLaunchReadinessCloseAttrs(state, closeResult, this.launchTransitionSeq++),
      closeResult === "advanced" ? "ok" : "error",
    );
  }

  /**
   * Phase-6 exported-row ENTER: opens the activation-delivery wait row when a
   * launch carries an initial activation (wake / buffered inbox) not yet
   * delivered (task #149). Idempotent + only opens when there is something to
   * deliver, so explicit starts with no activation produce no phase-6 row.
   */
  private openActivationTransition(agentId: string, ap: AgentProcess, launchSource: string): void {
    if (ap.activation.kind !== "idle") return;
    const identity = this.launchIdentityAttrs(agentId, ap, launchSource);
    const state: LaunchActivationTransitionState = {
      stateInstanceId: randomUUID(),
      enterSeq: this.launchTransitionSeq++,
      identity,
      negativeEvidenceBucket: launchReadinessNegativeEvidence(identity),
    };
    ap.activation = { kind: "open", transition: state };
    this.recordDaemonEvent(LAUNCH_ACTIVATION_DELIVERY_TRANSITION_SPAN, buildLaunchActivationEnterAttrs(state));
  }

  /**
   * Phase-6 exported-row CLOSE: closes the open activation-delivery wait with a
   * closed `close_result` (+ `delivered_via` on advanced). Idempotent — no-op
   * when no row is open, so overlapping paths (spawn-prompt, first stdin,
   * process exit, cleanup) emit exactly one close. Marks the initial activation
   * delivered on `advanced` so later normal deliveries are not re-counted.
   */
  private closeActivationTransition(ap: AgentProcess, closeResult: LaunchCloseResult, deliveredVia?: LaunchDeliveredVia): void {
    if (ap.activation.kind !== "open") {
      if (closeResult === "advanced" && ap.activation.kind === "idle") {
        ap.activation = { kind: "delivered" };
      }
      return;
    }
    const state = ap.activation.transition;
    ap.activation = closeResult === "advanced" ? { kind: "delivered" } : { kind: "closed" };
    this.recordDaemonEvent(
      LAUNCH_ACTIVATION_DELIVERY_TRANSITION_SPAN,
      buildLaunchActivationCloseAttrs(state, closeResult, this.launchTransitionSeq++, deliveredVia),
      closeResult === "advanced" ? "ok" : "error",
    );
  }

  private startRuntimeStartupTimeout(agentId: string, ap: AgentProcess, launchSource: string) {
    const timeoutMs = runtimeStartTimeoutMs();
    const fenced = timeoutMs > 0;
    this.openRuntimeReadinessTransition(
      agentId,
      ap,
      launchSource,
      fenced ? "runtime_startup_timeout" : "none",
      fenced ? Date.now() + timeoutMs : null,
    );
    if (!fenced) return;
    if (ap.startup.kind !== "waiting") return;
    const timer = setTimeout(() => {
      this.handleRuntimeStartupTimeout(agentId, ap, timeoutMs);
    }, timeoutMs);
    timer.unref?.();
    ap.startup = { ...ap.startup, timer };
  }

  private clearRuntimeStartupTimeout(ap: AgentProcess) {
    if (ap.startup.kind !== "waiting" || !ap.startup.timer) return;
    clearTimeout(ap.startup.timer);
    ap.startup = { ...ap.startup, timer: null };
  }

  private markRuntimeStartupReady(ap: AgentProcess) {
    if (ap.startup.kind === "ready") return;
    this.clearRuntimeStartupTimeout(ap);
    ap.startup = agentProcessStartupReady(ap.startup);
  }

  private runtimeStartupReadinessSatisfiedByEvent(ap: AgentProcess, event: ParsedEvent): boolean {
    if ((ap.driver.startupReadiness ?? "first_event") !== "initial_turn") {
      return true;
    }

    return event.kind !== "session_init"
      && event.kind !== "internal_progress"
      && event.kind !== "runtime_diagnostic"
      && event.kind !== "runtime_recovery";
  }

  private handleRuntimeStartupTimeout(agentId: string, ap: AgentProcess, timeoutMs: number) {
    const current = this.agents.get(agentId);
    if (current !== ap) return;
    const reduction = reduceApmStartupTimeoutTermination(ap.gatedSteering, {
      hasRuntimeProgressEvent: ap.startup.kind === "ready",
    });
    if (!reduction.shouldTerminate) {
      // Fence fired but APM permitted continuation: the readiness wait stays
      // open (deadline already elapsed) and closes later on ready/exit. Leaving
      // it open is intentional — an over-budget open readiness row is the
      // queryable "stuck past deadline" evidence.
      this.clearRuntimeStartupTimeout(ap);
      return;
    }
    this.closeRuntimeReadinessTransition(ap, "timeout");
    this.clearRuntimeStartupTimeout(ap);
    this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);

    const terminalFailureDetail = classifyTerminalFailure(ap);
    const detail = terminalFailureDetail?.detail ?? formatRuntimeStartTimeoutMessage(ap.driver.id);
    ap.lastRuntimeError = detail;
    ap.decisionErrorWindow.recordRuntimeError(detail);
    ap.runtimeProgress.markStale();

    const staleForMs = Math.max(timeoutMs, ap.runtimeProgress.ageMs());
    const diagnostic = buildRuntimeStallDiagnostic(ap, staleForMs, Math.max(1, Math.floor(staleForMs / 60_000)));
    const projection = projectApmRuntimeTerminationTrace({
      reason: "startup_timeout",
      timeoutMs,
    });
    this.recordRuntimeTraceEvent(agentId, ap, projection.runtimeEventName, {
      ...projection.runtimeEventAttrs,
      ...diagnostic.traceAttrs,
    });
    this.endRuntimeTrace(ap, "error", {
      ...projection.runtimeSpanAttrs,
      ...runtimeTraceCounterAttrs(ap),
      ...this.finalizeRuntimeProfileTurnControl(agentId, ap, "runtime_stalled"),
    });

    logger.warn(`[Agent ${agentId}] ${ap.driver.id} did not reach startup readiness within ${timeoutMs}ms; terminating process`);
    this.broadcastActivity(agentId, "error", detail, [{ kind: "text", text: `Error: ${detail}` }], ap.launchId, "runtime_error");
    this.sendAgentStatus(agentId, "inactive", ap.launchId);
    this.cacheStartupTimeoutRetryConfig(agentId, ap);
    try {
      this.runtimeExitTraceAttrs.set(ap.runtime, projection.processExitAttrs);
      void ap.runtime.stop({ signal: "SIGTERM", reason: projection.runtimeStopReason });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`[Agent ${agentId}] Failed to terminate startup-timed-out ${ap.driver.id} process: ${reason}`);
    }
  }

  private handleRuntimeStartupRequestError(agentId: string, ap: AgentProcess, event: StartupRequestErrorEvent) {
    const current = this.agents.get(agentId);
    if (current !== ap) return;
    this.closeRuntimeReadinessTransition(ap, "terminal");
    this.closeActivationTransition(ap, "terminal");
    this.clearRuntimeStartupTimeout(ap);
    this.interruptCompactionIfActive(agentId);
    this.interruptReviewIfActive(agentId);
    this.flushPendingTrajectory(agentId);

    const reduction = reduceApmStartupRequestErrorTermination(ap.gatedSteering);
    this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);

    ap.lastRuntimeError = event.message;
    ap.decisionErrorWindow.recordRuntimeError(event.message);
    ap.runtimeProgress.markStale();
    ap.notifications.clearPending();
    ap.notifications.clearTimer();

    const diagnostics = buildRuntimeErrorDiagnosticEnvelope(event.message);
    const visibleErrorMessage = diagnostics.spanAttrs.runtime_error_action_required === true
      ? formatRuntimeActionRequiredMessage(ap, event.message)
      : event.message;
    const failureAttrs = {
      turn_outcome: "failed",
      turn_subtype: "runtime_start_failed",
      turn_reason: "startup_request_error",
      runtime_start_failure_kind: "startup_request_error",
      startup_request_method: event.startupRequestMethod,
      ...diagnostics.eventAttrs,
    };

    noteRuntimeTraceCounter(ap.runtimeTraceCounters, event);
    this.recordRuntimeTraceEvent(agentId, ap, "runtime.event.received", {
      kind: event.kind,
      startup_request_method: event.startupRequestMethod,
    });
    this.recordRuntimeTraceEvent(agentId, ap, "runtime.start.request_failed", failureAttrs);
    this.endRuntimeTrace(ap, "error", {
      ...failureAttrs,
      ...diagnostics.spanAttrs,
      ...runtimeTraceCounterAttrs(ap),
      ...this.finalizeRuntimeProfileTurnControl(agentId, ap, "runtime_error"),
    });

    logger.warn(
      `[Agent ${agentId}] ${ap.driver.id} startup request ${event.startupRequestMethod} failed; terminating unusable runtime process`,
    );
    this.broadcastActivity(agentId, "error", visibleErrorMessage, [
      { kind: "text", text: `Error: ${visibleErrorMessage}` },
    ], ap.launchId, "runtime_error");
    this.sendAgentStatus(agentId, "inactive", ap.launchId);
    this.lifecycleRecords.deleteRestartSnapshot(agentId);
    try {
      this.runtimeExitTraceAttrs.set(ap.runtime, {
        stop_source: "startup_request_error",
        expectedTerminationReason: "startup_request_error",
        startup_request_method: event.startupRequestMethod,
        runtime_error_class: diagnostics.spanAttrs.runtime_error_class,
      });
      void ap.runtime.stop({ signal: "SIGTERM", reason: "startup_request_error" });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`[Agent ${agentId}] Failed to terminate startup-failed ${ap.driver.id} process: ${reason}`);
    }
  }

  private markRuntimeProgressStaleIfNeeded(agentId: string, ap: AgentProcess): boolean {
    if (ap.lastActivityKind !== "working" && ap.lastActivityKind !== "thinking") return false;
    if (ap.runtimeProgress.isStale) return true;

    const staleForMs = ap.runtimeProgress.ageMs();
    if (staleForMs < RUNTIME_PROGRESS_STALE_MS) return false; const toolDiagnosticSnapshots = ap.runtime.emitToolDiagnosticSnapshots?.({ trigger: "runtime_inactivity_tripwire", runtimeInactivityAgeMs: staleForMs, observationIntervalMs: RUNTIME_PROGRESS_STALE_MS }) ?? [];

    const subprocessPidAlive = this.probeRuntimeProcessLiveness(ap);
    if (subprocessPidAlive === true) {
      this.recordDaemonEvent("daemon.runtime.stall.suppressed_alive", {
        ...this.processLifecycleIdentityAttrs(agentId, ap),
        last_event_kind: ap.lastActivityKind || undefined,
        last_event_age_ms_bucket: bucketMs(ap.runtimeProgress.lastEventAgeMs()),
        subprocess_pid_alive: true,
        subprocess_socket_alive: !ap.runtime.closed,
        daemon_connected_to_server: this.serverConnected(),
      });
      this.recordRuntimeTraceEvent(agentId, ap, "runtime.progress.silent_alive", {
        staleForMs: bucketMs(staleForMs),
        lastActivity: ap.lastActivityKind || undefined,
        lastActivityDetailKind: ap.lastActivityDetailKind,
      });
      return false;
    }

    ap.runtimeProgress.markStale();
    const staleForMinutes = Math.max(1, Math.floor(staleForMs / 60_000));
    const diagnostic = buildRuntimeStallDiagnostic(ap, staleForMs, staleForMinutes);
    const projection = projectApmRuntimeProgressStalledTrace({
      turnReason: diagnostic.turnReason,
      staleForMs,
      lastActivity: ap.lastActivityKind,
      lastActivityDetailPresent: diagnostic.lastActivityDetailPresent,
      lastActivityDetailKind: diagnostic.lastActivityDetailKind,
    });
    this.recordRuntimeTraceEvent(agentId, ap, projection.runtimeEventName, {
      ...projection.runtimeEventAttrs,
      ...diagnostic.traceAttrs,
    });
    this.endRuntimeTrace(ap, "error", {
      ...projection.runtimeSpanAttrs,
      ...runtimeTraceCounterAttrs(ap),
      ...this.finalizeRuntimeProfileTurnControl(agentId, ap, "runtime_stalled"),
    });
    this.recordDaemonEvent("daemon.runtime.stall.detected", {
      ...this.processLifecycleIdentityAttrs(agentId, ap),
      last_event_kind: ap.lastActivityKind || undefined,
      last_event_age_ms_bucket: bucketMs(ap.runtimeProgress.lastEventAgeMs()),
      subprocess_pid_alive: subprocessPidAlive,
      subprocess_socket_alive: !ap.runtime.closed,
      daemon_connected_to_server: this.serverConnected(),
    }, "error");
    this.broadcastActivity(agentId, "error", projectRuntimeToolDiagnosticActivity(toolDiagnosticSnapshots, diagnostic.detail), [], undefined, "runtime_stalled");
    return true;
  }

  private probeRuntimeProcessLiveness(ap: AgentProcess): boolean | undefined {
    // Liveness is queried through the RuntimeSession boundary (RS-011) rather
    // than poking the raw pid here. See RuntimeSession.isAlive.
    return ap.runtime.isAlive();
  }

  private recoverStaleProcessForQueuedMessageIfNeeded(agentId: string, ap: AgentProcess): boolean {
    const staleForMs = ap.runtimeProgress.ageMs();
    const reduction = reduceApmStalledRecoveryTermination(ap.gatedSteering, {
      inboxLength: ap.inbox.length,
      supportsStdinNotification: ap.driver.supportsStdinNotification,
      busyDeliveryMode: ap.driver.busyDeliveryMode,
      hasSession: Boolean(ap.sessionId),
      hasDirectStdinRecoveryEvidence: hasDirectStdinRecoveryEvidence(ap),
      runtimeProgressIsStale: ap.runtimeProgress.isStale,
      staleForMs,
      staleThresholdMs: RUNTIME_PROGRESS_STALE_MS,
    });
    if (reduction.alreadyRecovering) {
      // Recovery is already in progress; additional messages remain queued.
      return true;
    }
    if (!reduction.shouldTerminate) return false;
    this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);

    const staleForMinutes = Math.max(1, Math.floor(staleForMs / 60_000));
    ap.runtimeProgress.markStale();
    const diagnostic = buildRuntimeStallDiagnostic(ap, staleForMs, staleForMinutes);
    const projection = projectApmRuntimeTerminationTrace({
      reason: "stalled_recovery",
      turnReason: diagnostic.turnReason,
      staleForMs,
      lastActivity: ap.lastActivityKind,
      lastActivityDetailPresent: diagnostic.lastActivityDetailPresent,
      lastActivityDetailKind: diagnostic.lastActivityDetailKind,
      pendingMessages: ap.inbox.length,
      recoveryAction: "terminate_for_queued_message",
    });
    this.recordRuntimeTraceEvent(agentId, ap, projection.runtimeEventName, {
      ...projection.runtimeEventAttrs,
      ...diagnostic.traceAttrs,
    });
    this.endRuntimeTrace(ap, "error", {
      ...projection.runtimeSpanAttrs,
      ...runtimeTraceCounterAttrs(ap),
      ...this.finalizeRuntimeProfileTurnControl(agentId, ap, "runtime_stalled"),
    });

    const runtimeLabel = runtimeDisplayName(ap.driver.id);
    logger.warn(
      `[Agent ${agentId}] ${runtimeLabel} process stalled for ${staleForMinutes}m with ${ap.inbox.length} queued message(s); terminating for restart`,
    );
    this.broadcastActivity(agentId, "working", `Restarting stalled ${runtimeLabel} runtime for queued message`, [], undefined, "stalled_recovery");
    try {
      this.runtimeExitTraceAttrs.set(ap.runtime, projection.processExitAttrs);
      this.startStalledRecoverySigtermWatchdog(agentId, ap, runtimeLabel, ap.inbox.length, staleForMs);
      void ap.runtime.stop({ signal: "SIGTERM", reason: projection.runtimeStopReason });
      this.recordDaemonEvent("daemon.runtime.stall.recovery_action", {
        ...this.processLifecycleIdentityAttrs(agentId, ap),
        action: "terminate_for_restart",
        outcome: "initiated",
        delay_ms_bucket: bucketMs(staleForMs),
      });
    } catch (err) {
      this.clearStalledRecoverySigtermWatchdog(ap);
      const reason = err instanceof Error ? err.message : String(err);
      this.recordDaemonEvent("daemon.runtime.stall.recovery_action", {
        ...this.processLifecycleIdentityAttrs(agentId, ap),
        action: "terminate_for_restart",
        outcome: "kill_failed",
        delay_ms_bucket: bucketMs(staleForMs),
        kill_signal_sequence: "SIGTERM",
        kill_attempts: 1,
        subprocess_os_state: probeSubprocessOsState(ap.runtime.pid),
        daemon_child_tracking_present: this.agents.has(agentId),
      }, "error");
      logger.warn(`[Agent ${agentId}] Failed to terminate stalled ${runtimeLabel} process: ${reason}`);
      return false;
    }
    return true;
  }

  /** Handle a single ParsedEvent from any runtime driver */
  private notePushedModelBodies(ap: AgentProcess, messages: readonly AgentMessage[]): void {
    const reportable = messages.filter((message) =>
      typeof message.seq === "number" && message.seq > 0
      && Boolean(message.channel_id)
      && !runtimeProfileNotificationFromMessage(message));
    if (reportable.length === 0) return;
    ap.pendingModelSeen = [...(ap.pendingModelSeen ?? []), ...reportable];
  }

  /**
   * The first model-driven event of this process after the input shows the
   * runtime took it (no driver echoes consumed input), so the pushed bodies
   * are reported now.
   */
  private flushModelSeen(agentId: string, ap: AgentProcess): void {
    const pending = ap.pendingModelSeen;
    if (!pending || pending.length === 0) return;
    ap.pendingModelSeen = [];
    const byChannel = new Map<string, Set<number>>();
    for (const message of pending) {
      const seqs = byChannel.get(message.channel_id) ?? new Set<number>();
      seqs.add(message.seq!);
      byChannel.set(message.channel_id, seqs);
    }
    const items = [...byChannel].map(([channelId, seqs]) => ({ channelId, seqs: [...seqs].sort((a, b) => a - b) }));
    for (let start = 0; start < items.length; start += MODEL_SEEN_MAX_ITEMS_PER_REPORT) {
      this.sendToServer({
        type: "agent:model-seen",
        agentId,
        launchId: ap.launchId || undefined,
        items: items.slice(start, start + MODEL_SEEN_MAX_ITEMS_PER_REPORT),
      });
    }
    this.recordDaemonEvent("daemon.agent.model_seen.reported", {
      agentId,
      launchId: ap.launchId || undefined,
      conversations_count: items.length,
      messages_count: pending.length,
    });
  }

  private handleParsedEvent(agentId: string, event: ParsedEvent, driver: RuntimeDriver) {
    const ap = this.agents.get(agentId);
    // task #1114: only model-driven runtime events prove that stdin writes were
    // consumed, and only when they belong to the live session/turn of this
    // process. The process-binding fence upstream already rejects events from a
    // stale launch; this gate covers a stale session or a turn-less event on
    // the live process (a bare event with no open turn cannot be attributed to
    // an unconsumed write).
    if (ap && isDeliveryConsumptionEvent(event.kind)) {
      const association = this.deliveryConsumptionAssociation(ap, event);
      if (association === "associated") {
        ap.deliveryConsumption.recordConsumption(event.kind, Date.now());
        this.flushModelSeen(agentId, ap);
      } else {
        this.recordDaemonEvent("daemon.agent.delivery.consumption.ignored", {
          agent_id: agentId,
          launch_id: ap.launchId || "",
          event_kind: event.kind,
          reason: association,
          session_id_present: Boolean(ap.sessionId),
          unconsumed_deliveries: ap.deliveryConsumption.snapshot().unconsumedDeliveries,
        });
      }
    }
    if (event.kind === "provider_request") {
      if (!ap) return;
      ap.providerRequest = event.activity;
      const { provider, phase } = event.activity;
      // `waiting` and `responding` fire on every provider HTTP request, so an
      // ordinary turn posted two activity rows that only restated "a model call
      // happened" — the surrounding tool/thinking rows already say that, and the
      // pair crowded them out of the log (@artin, 1.0.36). Those two phases stay
      // on `ap.providerRequest`, which rides along on later activity frames; only
      // the log row is gone. `failed`/`cancelled` are rare and are the sole
      // user-visible signal that a stall is the provider's, so they still post.
      if (phase === "waiting" || phase === "responding") return;
      const detail = phase === "failed" ? `Model service request failed (${provider})` : `Model request cancelled (${provider})`;
      this.broadcastActivity(agentId, ap.lastActivityKind ?? "working", detail, [], ap.launchId, "provider_request_status");
      // Display only: not model progress, readiness, consumption or lifecycle authority.
      return;
    }
    if (event.kind === "telemetry") {
      if (ap) this.recordRuntimeTelemetry(agentId, ap, event);
      return;
    }
    if (event.kind === "runtime_tooling") {
      if (ap) {
        this.recordRuntimeToolingObservation(agentId, ap, event);
      } else {
        this.recordDaemonEvent("daemon.runtime.tooling.exposure_without_process", {
          agentId,
          runtime: driver.id,
          ...runtimeToolingObservationAttrs(event),
        });
      }
      return;
    }
    if (event.kind === "delivery_error") {
      if (ap) {
        ap.deliveryConsumption.recordDeliveryError("runtime_delivery_error", Date.now());
        if (this.stopOnTerminalDeliveryError(agentId, ap, event)) return;
        this.restoreRuntimeDeliveryAfterAsyncRejection(agentId, ap, event);
        this.interruptCompactionIfActive(agentId, {
          detail: `Context compaction interrupted after runtime delivery failed: ${event.message}`,
          entries: [{ kind: "text", text: `Error: ${event.message}` }],
          flushBoundaryMessages: true,
          traceAttrs: {
            reason: "delivery_error",
            request_method: event.requestMethod,
            source: event.source,
            payloadBytes: event.payloadBytes,
          },
        });
      } else {
        this.recordDaemonEvent("daemon.agent.delivery_error.received_without_process", {
          agentId,
          event_kind: event.kind,
          runtime: driver.id,
          request_method: event.requestMethod,
          source: event.source,
          payloadBytes: event.payloadBytes,
        });
      }
      return;
    }
    if (ap && isStartupRequestErrorEvent(event)) {
      this.handleRuntimeStartupRequestError(agentId, ap, event);
      return;
    }
    if (ap) {
      const wasStalled = ap.runtimeProgress.isStale;
      if (this.runtimeStartupReadinessSatisfiedByEvent(ap, event)) {
        this.markRuntimeStartupReady(ap);
        this.closeRuntimeReadinessTransition(ap, "advanced");
      }
      // Model output with no open turn means the runtime started a turn by
      // itself, so the turn span opens here. Other events never open a turn.
      // Open before counting so this first event is kept in the new counters.
      if (isModelWorkEvent(event.kind)) {
        this.startRuntimeTrace(agentId, ap, "runtime-progress");
      }
      noteRuntimeTraceCounter(ap.runtimeTraceCounters, event);
      noteTurnOutcomeEvent(ap.turnOutcome, event);
      const eventAttrs = event.kind === "internal_progress"
        ? {
            kind: event.kind,
            source: event.source,
            itemType: event.itemType,
            payloadBytes: event.payloadBytes,
          }
        : event.kind === "subagent_progress"
          ? {
              kind: event.kind,
              source: event.source,
              phase: event.phase,
              parent_tool_use_id_present: Boolean(event.parentToolUseId),
              subagent_type_present: Boolean(event.subagentType),
              task_id_present: Boolean(event.taskId),
              last_tool_name_present: Boolean(event.lastToolName),
              payloadBytes: event.payloadBytes,
            }
        : event.kind === "runtime_diagnostic"
          ? runtimeDiagnosticTraceAttrs(event)
        : event.kind === "runtime_recovery"
          ? runtimeRecoveryTraceAttrs(event)
          : runtimeTurnEventTraceAttrs(event);
      this.recordRuntimeTraceEvent(agentId, ap, "runtime.event.received", eventAttrs);
      const recordProgressObservedAfterStall = () => {
        if (!wasStalled) return;
        this.recordRuntimeTraceEvent(agentId, ap, "runtime.progress.observed", { afterStall: true });
      };
      if (event.kind === "internal_progress") {
        ap.runtimeProgress.noteInternalProgress();
        recordProgressObservedAfterStall();
        this.invalidateRecoveryErrorView(ap);
        this.clearRuntimeErrorDeliveryBackoffAfterProgress(agentId, ap, event.kind);
        this.recordRuntimeTraceEvent(agentId, ap, "runtime.progress.internal_observed", {
          turn_outcome: "held",
          turn_subtype: "runtime_progress",
          turn_reason: "internal_activity_observed",
          signal: event.source,
          source: "runtime_event",
          runtime: ap.config.runtime,
          itemType: event.itemType,
          payloadBytes: event.payloadBytes,
        });
        // Surface quiet long turns once; the heartbeat carries subsequent liveness.
        this.maybeBroadcastRuntimeProgressActivity(agentId, ap, event);
        return;
      }

      if (event.kind === "subagent_progress") {
        this.noteRuntimeProgress(ap, event.kind);
        recordProgressObservedAfterStall();
        this.invalidateRecoveryErrorView(ap);
        this.clearRuntimeErrorDeliveryBackoffAfterProgress(agentId, ap, event.kind);
        this.recordSubagentProgressActivity(agentId, ap, event);
        return;
      }
      if (event.kind === "runtime_diagnostic") {
        this.noteRuntimeProgress(ap, event.kind);
        recordProgressObservedAfterStall();
        this.clearRuntimeErrorDeliveryBackoffAfterProgress(agentId, ap, event.kind);
        this.recordRuntimeDiagnosticActivity(agentId, ap, event);
        return;
      }
      if (event.kind === "runtime_recovery") {
        this.recordRuntimeRecoveryActivity(agentId, ap, event);
        return;
      }
      this.noteRuntimeProgress(ap, event.kind);
      if (this.runtimeErrorFingerprintFenceResetEvent(event.kind)) {
        this.resetRuntimeErrorFingerprintFence(agentId, `runtime_progress:${event.kind}`, ap);
      }
      recordProgressObservedAfterStall();
    } else if (event.kind !== "internal_progress") {
      this.recordDaemonEvent("daemon.agent.event.received_without_process", {
        agentId,
        event_kind: event.kind,
        runtime: driver.id,
      });
    }

    if (ap && runtimeEventEndsThinking(event.kind) && ap.lastActivityDetailKind === "thinking_started") {
      this.flushPendingTrajectory(agentId); this.broadcastActivity(agentId, "working", "Thinking finished", [], undefined, "thinking_end");
      this.recordRuntimeTraceEvent(agentId, ap, "runtime.thinking.finished", { reason: event.kind });
    }

    switch (event.kind) {
      case "session_init":
        if (ap) {
          const previousSessionId = ap.sessionId;
          // RFC 072 §7.2.3: the runtime's own report decides which session the
          // published context id belongs to; a different session than the one
          // this process started on gets a new id.
          bindContextGenerationToSession(ap.cliTransportDir, {
            runtime: ap.config.runtime,
            sessionId: event.sessionId,
            expectedSessionId: previousSessionId ?? ap.config.sessionId ?? null,
          });
          this.runtimeProcessBindingFence.rebindSession(agentId, ap, event.sessionId, "session_init");
          ap.sessionId = event.sessionId;
          const retryReason = prepareSessionInitDeliveryDebtRetry(ap, previousSessionId);
          if (retryReason) this.scheduleSessionReadyDeliveryRetry(agentId, ap, retryReason);
        }
        // TODO(lifecycle-v2/daemon-protocol): session_init should produce a
        // canonical runtime_ready/session_init lifecycle event with launchId
        // and sessionId. This legacy `agent:session` is retained only for the
        // server adapter path.
        this.sendToServer({ type: "agent:session", agentId, sessionId: event.sessionId, launchId: ap?.launchId || undefined });
        this.sendRuntimeProfileReport(agentId, "session_init");
        break;

      case "thinking": {
        this.completeCompactionIfActive(agentId, "Context compaction finished (inferred from resumed output)");
        this.queueTrajectoryText(agentId, "thinking", event.text, event.subagent);
        if (ap) {
          this.clearRuntimeErrorDeliveryBackoffAfterProgress(agentId, ap, event.kind);
          this.busyDelivery.applyAssistantContinuation(agentId, ap, event.kind, event.runtimeTurn);
        }
        break;
      }

      case "text": {
        this.completeCompactionIfActive(agentId, "Context compaction finished (inferred from resumed output)");
        this.queueTrajectoryText(agentId, "text", event.text, event.subagent);
        if (ap) {
          this.clearRuntimeErrorDeliveryBackoffAfterProgress(agentId, ap, event.kind);
          this.busyDelivery.applyAssistantContinuation(agentId, ap, event.kind, event.runtimeTurn);
        }
        break;
      }

      case "tool_call": {
        this.completeCompactionIfActive(agentId, "Context compaction finished (inferred from resumed tool use)");
        this.flushPendingTrajectory(agentId);
        const invocation = normalizeToolDisplayInvocation(event.name, event.input);
        if (ap) {
          noteRaftMessageSendAttempt(ap.runtimeTraceCounters, invocation.toolName);
          this.clearRuntimeErrorDeliveryBackoffAfterProgress(agentId, ap, event.kind);
          const reduction = reduceApmToolUse(ap.gatedSteering, { kind: "tool_call" });
          this.recordRuntimeTraceEvent(agentId, ap, "tool.call.started", { tool: invocation.toolName });
          this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
        }
        const inputSummary = summarizeToolInput(invocation.toolName, invocation.input);
        const detail = getToolActivityLabel(invocation.toolName);
        // APM 1.6 6b: preserve any explicit subagent lineage on the tool_start
        // entry so inner subagent tool calls group under a subagent. No lineage
        // → flat, ordinary tool_start (unchanged behavior).
        this.broadcastActivity(agentId, "working", detail, [{
          kind: "tool_start",
          toolName: invocation.toolName,
          toolInput: inputSummary,
          ...(event.subagent ? { subagent: event.subagent } : {}),
        }], undefined, event.subagent ? "subagent_activity" : this.toolActivityDetailKind(invocation.toolName));
        break;
      }

      case "tool_output": {
        const invocation = normalizeToolDisplayInvocation(event.name, {});
        if (ap) {
          this.clearRuntimeErrorDeliveryBackoffAfterProgress(agentId, ap, event.kind);
          const reduction = reduceApmToolUse(ap.gatedSteering, { kind: "tool_output" });
          this.recordRuntimeTraceEvent(agentId, ap, "tool.output.observed", { tool: invocation.toolName });
          this.recordRuntimeTraceEvent(agentId, ap, "runtime.continuation.expected");
          this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
        }
        this.broadcastActivity(agentId, "working", "Tool finished", [], undefined, "tool_end");
        break;
      }

      case "compaction_started":
        this.flushPendingTrajectory(agentId);
        // RFC 072 §7.2.3: the context may be gone from here on (interrupted or
        // stale compactions included), so the new context id is issued at
        // start; finished / interrupted / stale do not issue another.
        if (ap) {
          const contextId = writeContextGeneration(ap.cliTransportDir, { reason: "compaction", runtime: ap.config.runtime, passiveAx: ap.passiveAx });
          // A later resume of this session must not get the pre-compaction id;
          // a failed write forgets the session instead.
          if (ap.sessionId) rememberSessionContext(ap.cliTransportDir, ap.sessionId, contextId);
        }
        if (ap) this.recordRuntimeTraceEvent(agentId, ap, "runtime.context_compaction.started");
        if (ap) this.startCompactionWatchdog(agentId, ap);
        this.broadcastActivity(agentId, "working", "Compacting context", [{ kind: "compaction_started" }], undefined, "compacting_context");
        if (ap) {
          const reduction = reduceApmGatedCompaction(ap.gatedSteering, { kind: "compaction_started" });
          this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
        }
        break;

      case "compaction_finished":
        this.flushPendingTrajectory(agentId);
        if (ap) this.recordRuntimeTraceEvent(agentId, ap, "runtime.context_compaction.finished");
        if (ap) this.clearCompactionWatchdog(ap);
        this.broadcastActivity(agentId, "working", "Context compaction finished", [{ kind: "compaction_finished" }], undefined, "compaction_finished");
        if (ap) {
          const reduction = reduceApmGatedCompaction(ap.gatedSteering, { kind: "compaction_finished" });
          this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
          this.flushCompactionBoundaryMessages(agentId, ap);
        }
        break;

      case "compaction_interrupted": {
        this.flushPendingTrajectory(agentId);
        this.interruptCompactionIfActive(agentId);
        // Overflow recovery can be exhausted after a successful finish, when
        // there is no active compaction. Its terminal fact must still survive.
        const facts = projectCompactionInterruption(event);
        if (ap) this.recordRuntimeTraceEvent(agentId, ap, "runtime.context_compaction.interrupted", projectCompactionInterruptionTraceAttrs(event));
        this.broadcastActivity(
          agentId,
          facts.outcome === "aborted" ? "working" : "error",
          formatCompactionInterruption(facts),
          [], undefined,
          facts.outcome === "aborted" ? "system_message" : "runtime_error",
          undefined, undefined, undefined, undefined, facts,
        );
        break;
      }
      case "review_started":
        this.flushPendingTrajectory(agentId);
        if (ap) this.recordRuntimeTraceEvent(agentId, ap, "runtime.review_mode.started");
        this.broadcastActivity(agentId, "working", "Reviewing changes", [], undefined, "reviewing_changes");
        if (ap) {
          const reduction = reduceApmGatedReview(ap.gatedSteering, { kind: "review_started" });
          this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
          this.startReviewWatchdog(agentId, ap);
        }
        break;

      case "review_finished":
        this.flushPendingTrajectory(agentId);
        if (ap) {
          this.clearReviewWatchdog(ap);
          this.recordRuntimeTraceEvent(agentId, ap, "runtime.review_mode.finished");
        }
        this.broadcastActivity(agentId, "working", "Review finished", [], undefined, "review_finished");
        if (ap) {
          const reduction = reduceApmGatedReview(ap.gatedSteering, { kind: "review_finished" });
          this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
          this.flushReviewBoundaryMessages(agentId, ap);
        }
        break;

      case "turn_end":
        if (ap) {
          this.recordRuntimeTraceEvent(agentId, ap, "runtime.turn.completed");
          this.recordCodexZeroToolZeroSendCompletion(agentId, ap);
        }
        this.completeCompactionIfActive(agentId, "Context compaction finished (inferred from turn end)", {
          flushBoundaryMessages: false,
        });
        this.flushPendingTrajectory(agentId);
        const turnEndSessionId = event.sessionId ?? ap?.driver.currentSessionId ?? undefined;
        // RFC 071 §4.4 E2: decided inside `if (ap)` (a registered launch, so a
        // turn end after terminal cleanup never qualifies), sent after this
        // turn's agent:session frame below.
        let turnCompleted: AgentRuntimeOutcome | null = null;
        if (ap) {
          if (turnEndSessionId) {
            this.runtimeProcessBindingFence.rebindSession(agentId, ap, turnEndSessionId, "turn_end");
            ap.sessionId = turnEndSessionId;
          }
          this.markSessionReadyForDelivery(ap, "turn_end");
          clearSessionReadyDeliveryRetry(ap);
          const stickyTerminalFailure = classifyStickyTerminalFailure(ap);
          const batchEcho = ap.catchupBatchEcho && ap.catchupBatchEcho.launchId === ap.launchId
            ? ap.catchupBatchEcho
            : null;
          turnCompleted = turnCompletedOutcome(ap.turnOutcome, Boolean(stickyTerminalFailure), batchEcho);
          // The first turn end closes the batch turn whatever its outcome
          // (echo at most once), and opens the next turn's counters.
          ap.catchupBatchEcho = null;
          ap.turnOutcome = createTurnOutcomeCounters();
          if (!stickyTerminalFailure && ap.runtimeErrorDeliveryBackoff.reason === "runtime_error") {
            this.clearRuntimeErrorDeliveryBackoffWithTrace(agentId, ap, "turn_end_unclassified_runtime_error");
          }
          const reduction = reduceApmGatedTurnEnd(ap.gatedSteering, {
            inboxLength: stickyTerminalFailure ? 0 : ap.inbox.length,
            supportsStdinNotification: ap.driver.supportsStdinNotification,
            hasSession: this.canDeliverToRuntimeSession(ap),
            canDeliverWithoutSession: !ap.driver.requiresSessionInitForDelivery,
            terminateProcessOnTurnEnd: ap.driver.terminateProcessOnTurnEnd === true,
          });
          this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
          // Turn completed — check if there are queued messages to deliver
          const deliverStdinEffect = reduction.effects.find((effect) => effect.kind === "deliver_stdin");
          if (stickyTerminalFailure) {
            this.sendAgentStatus(agentId, "inactive", ap.launchId);
          }
          if (deliverStdinEffect) {
            const deliveredAtTurnEnd = this.executeApmGatedSteeringEffect(agentId, ap, deliverStdinEffect);
            if (deliveredAtTurnEnd) {
              this.completePendingTrackedMentions(agentId);
            } else {
              this.settleUndeliveredTrackedMentionsAtTurnEnd(agentId, ap);
              this.commitApmIdleState(agentId, ap, true);
              if (stickyTerminalFailure) {
                this.broadcastActivity(agentId, "error", stickyTerminalFailure.detail, [], undefined, "runtime_error");
              } else if (ap.lastRuntimeError && ap.runtimeErrorDeliveryBackoff.attempts > 0) {
                this.broadcastActivity(agentId, "error", this.formatVisibleRuntimeErrorMessage(ap, ap.lastRuntimeError), [], undefined, "runtime_error");
              } else {
                this.broadcastActivity(agentId, "online", "Idle", [], undefined, "idle");
              }
            }
          } else {
            this.settleUndeliveredTrackedMentionsAtTurnEnd(agentId, ap);
            // No pending messages — mark idle, process stays alive waiting for stdin
            if (stickyTerminalFailure) {
              this.broadcastActivity(agentId, "error", stickyTerminalFailure.detail, [], undefined, "runtime_error");
            } else if (ap.lastRuntimeError) {
              // Runtime CLIs such as Claude can emit `error` immediately followed
              // by `turn_end`. The process is stdin-wakeable again, but the last
              // user-visible state must remain the error until a new inbox message
              // starts, otherwise the failure is only discoverable in Activity.
              this.broadcastActivity(agentId, "error", this.formatVisibleRuntimeErrorMessage(ap, ap.lastRuntimeError), [], undefined, "runtime_error");
            } else {
              this.broadcastActivity(agentId, "online", "Idle", [], undefined, "idle");
            }
          }
          this.endRuntimeTrace(ap, stickyTerminalFailure ? "error" : "ok", {
            outcome: stickyTerminalFailure ? "runtime-error-with-turn-end" : "turn-completed",
            ...(stickyTerminalFailure ? { terminalRuntimeError: true } : {}),
            ...runtimeTraceCounterAttrs(ap),
            ...this.finalizeRuntimeProfileTurnControl(agentId, ap, stickyTerminalFailure ? "runtime_error" : "turn_end"),
          });
          if (ap.driver.terminateProcessOnTurnEnd) {
            logger.info(`[Agent ${agentId}] Turn completed; terminating ${ap.driver.id} process`);
            const projection = projectApmRuntimeTerminationTrace({ reason: "turn_end" });
            try {
              this.runtimeExitTraceAttrs.set(ap.runtime, projection.processExitAttrs);
              void ap.runtime.stop({ signal: "SIGTERM", reason: projection.runtimeStopReason });
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              logger.warn(`[Agent ${agentId}] Failed to terminate ${ap.driver.id} after turn_end: ${reason}`);
            }
          }
        }
        if (turnEndSessionId) {
          // TODO(lifecycle-v2/daemon-protocol): turn_end session resync should
          // reuse the canonical session_resynced/runtime_ready producer rather
          // than another legacy `agent:session` frame.
          this.sendToServer({ type: "agent:session", agentId, sessionId: turnEndSessionId, launchId: ap?.launchId || undefined });
          this.sendRuntimeProfileReport(agentId, "turn_end");
        }
        if (ap && turnCompleted) this.sendRuntimeOutcome(agentId, ap, turnCompleted);
        break;

      case "error": {
        this.interruptCompactionIfActive(agentId);
        this.interruptReviewIfActive(agentId);
        this.flushPendingTrajectory(agentId);
        const compaction = event.compaction ? projectCompactionInterruption(event.compaction) : undefined;
        if (ap && compaction) {
          this.recordRuntimeTraceEvent(agentId, ap, "runtime.context_compaction.interrupted", projectCompactionInterruptionTraceAttrs(compaction));
        }
        if (ap) {
          ap.lastRuntimeError = event.message;
          ap.decisionErrorWindow.recordRuntimeError(event.message);
          if (this.deliveryConsumptionAssociation(ap, event) === "associated") {
            const errorClass = buildRuntimeErrorDiagnosticEnvelope(event.message).spanAttrs.runtime_error_class;
            ap.deliveryConsumption.recordRuntimeError(typeof errorClass === "string" ? errorClass : "unclassified", Date.now());
          }
        }
        let visibleErrorMessage = event.message;
        let visibleErrorEntries: TrajectoryEntry[] | undefined;
        if (ap) {
          const runtimeErrorDiagnostics = buildRuntimeErrorDiagnosticEnvelope(event.message);
          const compactionDiagnosticAttrs = compaction?.failureDiagnostic
            ? {
                runtime_error_class: compaction.failureDiagnostic.errorClass,
                turn_reason: compaction.failureDiagnostic.errorReason,
                runtime_error_fingerprint: compaction.failureDiagnostic.fingerprint,
              }
            : {};
          const runtimeErrorFingerprint = typeof runtimeErrorDiagnostics.spanAttrs.runtime_error_fingerprint === "string"
            ? runtimeErrorDiagnostics.spanAttrs.runtime_error_fingerprint
            : null;
          if (runtimeErrorDiagnostics.spanAttrs.runtime_error_action_required === true) {
            visibleErrorMessage = formatRuntimeActionRequiredMessage(ap, event.message);
          } else if (runtimeErrorDiagnostics.spanAttrs.runtime_error_class === "InputTooLargeError") {
            visibleErrorMessage = formatRuntimeInputTooLargeMessage(ap.driver.id);
          }
          const backoffFailPoint = this.runtimeErrorDeliveryBackoffFailPointForTesting?.({
            agentId,
            message: event.message,
          }) ?? null;
          const structuredCompactionTerminalFailure = projectStructuredRuntimeTerminalFailure(event, ap.driver.id);
          const terminalFailure = backoffFailPoint && Object.prototype.hasOwnProperty.call(backoffFailPoint, "terminalFailure")
            ? backoffFailPoint.terminalFailure ?? null
            : structuredCompactionTerminalFailure ?? classifyTerminalFailure(ap);
          const stickyTerminalFailure = backoffFailPoint && Object.prototype.hasOwnProperty.call(backoffFailPoint, "stickyTerminalFailure")
            ? backoffFailPoint.stickyTerminalFailure ?? null
            : structuredCompactionTerminalFailure ?? classifyStickyTerminalFailure(ap);
          const backoffReasonOverride = backoffFailPoint && Object.prototype.hasOwnProperty.call(backoffFailPoint, "reason")
            ? backoffFailPoint.reason ?? null
            : undefined;
          const reduction = reduceApmGatedError(ap.gatedSteering, {
            terminalWakeable: Boolean(ap.driver.supportsStdinNotification && terminalFailure && !terminalFailure.actionRequired),
          });
          this.commitGatedSteeringDecisionState(agentId, ap, reduction.nextState);
          const fingerprintFence = this.noteRuntimeErrorFingerprintFence(
            agentId,
            ap,
            event.message,
            runtimeErrorFingerprint,
            terminalFailure,
            stickyTerminalFailure,
          );
          visibleErrorMessage = fingerprintFence?.detail ?? structuredCompactionTerminalFailure?.detail ?? visibleErrorMessage;
          visibleErrorEntries = terminalFailure?.entries;
          this.noteRuntimeErrorDeliveryBackoff(agentId, ap, event.message, terminalFailure, stickyTerminalFailure, backoffReasonOverride);
          this.recordRuntimeTraceEvent(agentId, ap, "runtime.error", {
            ...runtimeErrorDiagnostics.eventAttrs,
            ...compactionDiagnosticAttrs,
            ...runtimeTraceCounterAttrs(ap),
          });
          this.endRuntimeTrace(ap, "error", {
            ...runtimeErrorDiagnostics.spanAttrs,
            ...compactionDiagnosticAttrs,
            ...runtimeTraceCounterAttrs(ap),
            ...this.finalizeRuntimeProfileTurnControl(agentId, ap, "runtime_error"),
          });
          if (fingerprintFence) {
            this.applyRuntimeErrorFingerprintFence(agentId, ap, fingerprintFence);
          } else if (ap.driver.supportsStdinNotification && terminalFailure) {
            if (terminalFailure.actionRequired) {
              // task #352 — a plan-without-model 429 takes this branch too; the
              // stop source and class must say which kind of user action it is.
              const requiredAction = String(runtimeErrorDiagnostics.spanAttrs.runtime_error_action ?? "user_reauth");
              const stopSource = requiredAction === "user_reauth" ? "runtime_auth_error" : "runtime_action_required";
              logger.warn(`[Agent ${agentId}] ${ap.driver.id} runtime error requires user action (${requiredAction}); terminating runtime process`);
              try {
                this.runtimeExitTraceAttrs.set(ap.runtime, {
                  stop_source: stopSource,
                  runtime_error_class: String(runtimeErrorDiagnostics.spanAttrs.runtime_error_class ?? "AuthError"),
                });
                void ap.runtime.stop({ signal: "SIGTERM", reason: stopSource });
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                logger.warn(`[Agent ${agentId}] Failed to terminate ${ap.driver.id} after ${requiredAction} error: ${reason}`);
              }
            } else if (stickyTerminalFailure) {
              this.sendAgentStatus(agentId, "inactive", ap.launchId);
              // RFC 071 §7 / test W-2: the compaction diagnostic carries the raw
              // SDK text's fingerprint; event.message may be the display constant.
              this.cleanupTerminalRuntimeFailure(agentId, ap, stickyTerminalFailure.detail, terminalFailureFromRuntimeErrorEvent(event, compaction));
              logger.warn(`[Agent ${agentId}] ${ap.driver.id} terminal runtime error requires explicit recovery`);
            } else {
              ap.notifications.clearPending();
              ap.notifications.clearTimer();
              logger.info(`[Agent ${agentId}] Marked ${ap.driver.id} wakeable after terminal runtime error`);
            }
          }
        }
        const activityDiagnostic = compaction?.failureDiagnostic ?? buildRuntimeErrorActivityDiagnostic(event.message, {
          ...(typeof event.nativeReasonPresent === "boolean"
            ? { nativeReasonPresent: event.nativeReasonPresent }
            : {}),
          ...(event.reasonProvenance ? { reasonProvenance: event.reasonProvenance } : {}),
        });
        this.broadcastActivity(
          agentId,
          "error",
          visibleErrorMessage,
          visibleErrorEntries ?? (compaction ? [] : [{ kind: "text", text: `Error: ${visibleErrorMessage}` }]),
          undefined,
          "runtime_error",
          "error",
          undefined,
          activityDiagnostic,
          undefined,
          compaction,
        );
        break;
      }
    }
  }

  private recordRuntimeTelemetry(agentId: string, ap: AgentProcess, event: Extract<ParsedEvent, { kind: "telemetry" }>) {
    const sessionId = ap.driver.currentSessionId ?? event.sessionId ?? ap.sessionId ?? ap.config.sessionId;
    const telemetryAttrs = {
      ...sanitizeRuntimeTelemetryPayloadAttrs(event.attrs),
      ...this.runtimeTelemetryVersionAttrs(),
      ...(event.source ? { source: event.source } : {}),
      ...(event.usageKind ? { usageKind: event.usageKind } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...this.runtimeTelemetryResultIdentity(agentId, ap, event),
    };
    const attrs = {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      model: ap.config.model,
      telemetry_name: event.name,
      ...telemetryAttrs,
    };
    ap.runtimeTraceSpan?.addEvent(`runtime.telemetry.${event.name}`, telemetryAttrs);
    this.recordDaemonEvent(`daemon.runtime.telemetry.${event.name}`, attrs);
  }

  private recordRuntimeToolingObservation(
    agentId: string,
    ap: AgentProcess,
    event: Extract<ParsedEvent, { kind: "runtime_tooling" }>,
  ): void {
    const attrs = runtimeToolingObservationAttrs(event);
    this.recordRuntimeTraceEvent(agentId, ap, "runtime.tooling.exposure", attrs);
    this.recordDaemonEvent("daemon.runtime.tooling.exposure", {
      ...this.processLifecycleIdentityAttrs(agentId, ap),
      ...attrs,
    });
  }

  private recordCodexZeroToolZeroSendCompletion(agentId: string, ap: AgentProcess): void {
    const attrs = codexCommunicationGapAttrs(ap.driver.id, ap.runtimeTraceCounters);
    if (!attrs) return;
    this.recordRuntimeTraceEvent(agentId, ap, "runtime.turn.communication_gap", attrs);
    this.recordDaemonEvent("daemon.runtime.turn.communication_gap", {
      ...this.processLifecycleIdentityAttrs(agentId, ap),
      ...attrs,
    });
  }

  private runtimeTelemetryResultIdentity(
    agentId: string,
    ap: AgentProcess,
    event: Extract<ParsedEvent, { kind: "telemetry" }>,
  ): Record<string, string> {
    if (event.runtimeResultId) return { runtimeResultId: event.runtimeResultId };
    if (event.name !== "token_usage" || event.source !== "claude_result_usage") return {};
    const sequence = ++ap.runtimeTelemetryResultSeq;
    const scope = ap.launchId || agentId;
    return {
      runtimeResultId: `${scope}:claude_result_usage:${sequence}`,
      runtimeResultIdSource: "daemon_sequence",
    };
  }

  private runtimeTelemetryVersionAttrs(): Record<string, string | boolean> {
    return {
      ...(this.daemonVersion ? {
        daemonVersion: this.daemonVersion,
        daemon_version: this.daemonVersion,
        daemon_version_present: true,
      } : {
        daemon_version_present: false,
      }),
      ...(this.computerVersion ? {
        computerVersion: this.computerVersion,
        computer_version: this.computerVersion,
        computer_version_present: true,
      } : {
        computer_version_present: false,
      }),
    };
  }

  /**
   * RFC 071 §6: the batch of the start whose launch this spawn carries, with
   * the number of its rows the spawn rendered as input. The slot is taken
   * either way, so a batch the spawn did not render (for example a runtime
   * profile control prompt replaced it, F9) can never be echoed later.
   */
  private takeStartCatchupBatch(
    agentId: string,
    launchId: string | null,
    renderedRows: number,
  ): { launchId: string; batchId: string; renderedRows: number } | null {
    const slot = this.startCatchupBatches.get(agentId);
    if (!slot || !launchId || slot.launchId !== launchId) return null;
    this.startCatchupBatches.delete(agentId);
    // A batch with no rendered rows (including one a control prompt replaced,
    // F9) is armed with 0 rows and never echoed (turnCompletedOutcome).
    return { ...slot, renderedRows };
  }

  /**
   * RFC 071 §7 `agent:runtime:outcome` v1. Requires a launchId and this
   * daemon's instance id (no launch, no frame: the same as an old daemon).
   * clientSeq is the per-agent counter shared with agent:status/activity.
   */
  private sendRuntimeOutcome(agentId: string, ap: AgentProcess, outcome: AgentRuntimeOutcome): void {
    const launchId = ap.launchId || null;
    if (!launchId || !this.daemonInstanceId) return;
    const sessionId = ap.driver.currentSessionId ?? ap.sessionId ?? ap.config.sessionId ?? null;
    const observedAtMs = this.clockNow();
    this.sendToServer({
      type: "agent:runtime:outcome",
      v: 1,
      agentId,
      launchId,
      sessionId,
      daemonInstanceId: this.daemonInstanceId,
      clientSeq: this.activitySink.nextClientSeq(agentId),
      observedAtMs,
      outcome,
    });
    this.recordDaemonEvent("daemon.agent.runtime_outcome.sent", {
      agentId,
      launchId,
      kind: outcome.kind,
      ...(outcome.kind === "terminal_failure"
        ? { failure_kind: outcome.failureKind, fingerprint: outcome.fingerprint, runtime_error_class: outcome.errorClass }
        : {
            text_events_count: outcome.textEvents,
            tool_calls_count: outcome.toolCalls,
            catchup_batch_echoed: Boolean(outcome.catchupBatchId),
          }),
      session_id_present: Boolean(sessionId),
    });
  }

  /**
   * RFC 071 §4.3 rule 2: the process identity minted for this spawn. Every
   * accepted launch still waiting for a result is bound to it: the spawn's
   * own launch, and the starts folded into it (`supersededLaunchIds`). With
   * none waiting, the daemon started this runtime on its own (`respawn`).
   * Sent at most once per process.
   */
  private sendProcessSpawned(agentId: string, ap: AgentProcess, spawnLaunchId: string | null): void {
    if (ap.spawnReported) return;
    ap.spawnReported = true;
    const waiting = this.acceptedLaunches.get(agentId) ?? [];
    this.acceptedLaunches.delete(agentId);
    if (!spawnLaunchId || !this.daemonInstanceId) return;
    const supersededLaunchIds = waiting.filter((launchId) => launchId !== spawnLaunchId);
    this.sendToServer({
      type: "agent:process_spawned",
      agentId,
      daemonInstanceId: this.daemonInstanceId,
      processInstanceId: ap.processInstanceId,
      launchId: spawnLaunchId,
      clientSeq: this.activitySink.nextClientSeq(agentId),
      ...(supersededLaunchIds.length > 0 ? { supersededLaunchIds } : {}),
      ...(waiting.includes(spawnLaunchId) ? {} : { respawn: true }),
    });
  }

  /** RFC 071: settle every accepted launch of this agent that is still waiting. */
  private settleAllAcceptedLaunches(agentId: string, reason: AgentStartNotSpawnedReason): void {
    const waiting = this.acceptedLaunches.get(agentId);
    if (!waiting || waiting.length === 0) return;
    this.settleLaunches(agentId, [...waiting], { kind: "not_spawned", reason });
  }

  /**
   * RFC 071 `agent:start:outcome`: the final result of accepted launches that
   * `process_spawned` does not name. Only launches still waiting are settled,
   * so each launch gets exactly one result.
   */
  private settleLaunches(
    agentId: string,
    launchIds: string[],
    result: Extract<MachineToServerMessage, { type: "agent:start:outcome" }>["result"],
  ): void {
    const waiting = this.acceptedLaunches.get(agentId);
    if (!waiting) return;
    for (const launchId of launchIds) {
      const index = waiting.indexOf(launchId);
      if (index < 0) continue;
      waiting.splice(index, 1);
      if (!this.daemonInstanceId) continue;
      this.sendToServer({
        type: "agent:start:outcome",
        agentId,
        daemonInstanceId: this.daemonInstanceId,
        launchId,
        clientSeq: this.activitySink.nextClientSeq(agentId),
        result,
      });
    }
    if (waiting.length === 0) this.acceptedLaunches.delete(agentId);
  }

  /**
   * RFC 071 §4.3 rule 3: `process` is the closure-captured record of the
   * runtime that exited (it keeps its identity after the registry forgot it);
   * `spawnLaunchId` is its birth launch, null for a process the daemon
   * started on its own without one, and stays null after a server start is
   * rebound onto it (a rebind is never its birth). `launchId` is the last
   * launch it carried (a rebind moves it). Sent whenever the process carried
   * a server launch at birth or through a rebind; returns whether it was.
   */
  private sendProcessExited(
    agentId: string,
    process: AgentProcess,
    spawnLaunchId: string | null,
    code: number | null,
    signal: string | null,
  ): boolean {
    const lastLaunchId = process.launchId || spawnLaunchId;
    if (!lastLaunchId || !this.daemonInstanceId) return false;
    this.sendToServer({
      type: "agent:process_exited",
      agentId,
      daemonInstanceId: this.daemonInstanceId,
      processInstanceId: process.processInstanceId,
      spawnLaunchId: spawnLaunchId || null,
      launchId: lastLaunchId,
      clientSeq: this.activitySink.nextClientSeq(agentId),
      code,
      signal,
    });
    return true;
  }

  private sendAgentStatus(
    agentId: string,
    status: string,
    launchId: string | null,
    // task #1119: how the process ended (code/signal) when `status` reports an
    // exit, so the server's wake crash-loop breaker can record the signal.
    exit?: { code: number | null; signal: string | null },
  ) {
    const normalizedLaunchId = launchId || null;
    const ap = this.agents.get(agentId);
    this.recordDaemonEvent("daemon.agent.status.transition", this.lifecycleRecords.agentStatusTransitionAttrs({ agentId, status, launchId: normalizedLaunchId, observedAtMs: this.clockNow(), processInstanceId: ap?.processInstanceId, runtime: ap?.config.runtime, sessionIdPresent: ap ? Boolean(ap.sessionId) : undefined }));
    // RFC 069 §8: status is the only state channel, so it is sequenced with the
    // agent's activity (same counter) and tagged with this process's generation;
    // the server accepts it only in order and only from the connected process.
    this.sendToServer({
      type: "agent:status",
      agentId,
      status,
      launchId: normalizedLaunchId || undefined,
      ...(exit ? { exit } : {}),
      ...(this.daemonInstanceId ? { daemonInstanceId: this.daemonInstanceId } : {}),
      clientSeq: this.activitySink.nextClientSeq(agentId),
    });
  }

  /**
   * RFC 069 §8: a start that failed before the manager settled it (core-side
   * refusal, wiki retired, start pump overflow) still reports `inactive` on
   * the sequenced status channel, so the server orders it against this
   * process's other status frames instead of taking the legacy path.
   */
  reportStartFailureStatus(agentId: string, launchId: string | null | undefined): void {
    this.sendAgentStatus(agentId, "inactive", launchId ?? null);
  }

  private reportRunnerCredentialMintFailure(
    agentId: string,
    err: unknown,
    launchId: string | null,
    source: "idle_auto_restart" | "queued_continuation" | "runtime_profile_auto_restart",
  ): boolean {
    if (!(err instanceof RunnerCredentialMintError)) return false;
    const detail = runnerCredentialErrorDetail(err);
    this.recordDaemonEvent("daemon.runner_credential_mint.hard_fail", {
      agentId,
      launchId: launchId || undefined,
      source,
      http_status: detail.status,
      code: detail.code,
      reason: detail.message,
      retryable: detail.retryable,
    }, "error");
    const reason = err.message;
    this.sendAgentStatus(agentId, "inactive", launchId);
    this.broadcastActivity(
      agentId,
      "error",
      `Start failed: ${reason}`,
      [{ kind: "text", text: `Error: ${reason}` }],
      launchId,
      "runtime_error",
    );
    return true;
  }

  /** Send a batched notification to the agent via stdin about pending messages */
  private sendStdinNotification(agentId: string, options: { forceUnsupportedRetry?: boolean } = {}): boolean {
    const ap = this.agents.get(agentId);
    if (!ap) return false;

    const closedResult = this.busyDelivery.flushClosedNotificationDebt(agentId, ap);
    if (closedResult !== undefined) return closedResult;

    const count = ap.notifications.takePendingAndClearTimer();

    if (count === 0) return false;
    const idleResult = this.busyDelivery.flushNotificationDebtIfIdle(agentId, ap, count);
    if (idleResult !== undefined) return idleResult;
    if (!ap.sessionId) {
      ap.notifications.add(count);
      return false;
    }
    if (!this.canDeliverToRuntimeSession(ap)) {
      ap.notifications.add(count);
      this.recordDaemonEvent("daemon.agent.stdin_notification", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        outcome: "suppressed_session_not_ready",
        mode: "busy",
        pending_notification_count: count,
        inbox_count: ap.inbox.length,
        session_id_present: true,
        session_ready_for_delivery: false,
      });
      return false;
    }
    const runtimeErrorBackoffRemainingMs = this.runtimeErrorDeliveryBackoffRemainingMs(ap);
    if (runtimeErrorBackoffRemainingMs > 0) {
      ap.notifications.add(count);
      const scheduled = this.scheduleRuntimeErrorDeliveryBackoffFlush(agentId, ap);
      this.recordDaemonEvent("daemon.agent.stdin_notification", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        outcome: "suppressed_runtime_error_backoff",
        mode: "busy",
        pending_notification_count: count,
        inbox_count: ap.inbox.length,
        session_id_present: true,
        runtime_error_backoff_remaining_ms: runtimeErrorBackoffRemainingMs,
        runtime_error_backoff_attempts: ap.runtimeErrorDeliveryBackoff.attempts,
        runtime_error_backoff_reason: ap.runtimeErrorDeliveryBackoff.reason || undefined,
        runtime_error_backoff_timer_scheduled: scheduled || this.runtimeErrorDeliveryBackoffTimerScheduled(ap),
      });
      return false;
    }
    if (ap.gatedSteering.compacting && ap.driver.acceptsStdinDuringCompaction !== true) {
      this.recordRuntimeTraceEvent(agentId, ap, "runtime.compaction_boundary.delivery_suppressed", {
        pendingNotificationCount: count,
        pendingMessages: ap.inbox.length,
        busyDeliveryMode: ap.driver.busyDeliveryMode,
      });
      ap.notifications.add(count);
      logger.info(
        `[Agent ${agentId}] Suppressing stdin delivery until context compaction finishes; pending=${ap.inbox.length}`,
      );
      return false;
    }
    if (ap.gatedSteering.reviewing) {
      this.recordRuntimeTraceEvent(agentId, ap, "runtime.review_boundary.delivery_suppressed", {
        pendingNotificationCount: count,
        pendingMessages: ap.inbox.length,
        busyDeliveryMode: ap.driver.busyDeliveryMode,
      });
      ap.notifications.add(count);
      logger.info(
        `[Agent ${agentId}] Suppressing stdin delivery until review mode finishes; pending=${ap.inbox.length}`,
      );
      return false;
    }

    const inboxCount = ap.inbox.length;
    if (inboxCount === 0) return false;
    ap.notifications.pruneContributedToPending(ap.inbox, ap.sessionId);
    const changedMessageCandidates = ap.inbox.slice(Math.max(0, ap.inbox.length - count));
    const changedMessages = ap.notifications.filterUncontributedMessages(changedMessageCandidates, ap.sessionId);
    if (changedMessages.length === 0) {
      this.recordDaemonEvent("daemon.agent.stdin_notification", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        outcome: "suppressed_already_contributed",
        mode: "busy",
        pending_notification_count: count,
        inbox_count: ap.inbox.length,
        session_id_present: true,
      });
      logger.info(`[Agent ${agentId}] Suppressing stdin inbox notice because all candidate messages already contributed; pending=${ap.inbox.length}`);
      return false;
    }
    // Derived dedup-key (#58): if this exact unread-set was already written in
    // this session and not yet consumed, suppress instead of re-injecting (the
    // inbox-notice retry-storm class: a wedged/rate-limited runtime never
    // consumes, so the same changed set is re-projected every cycle). The
    // already-contributed filter above gives each pending message at-most-once
    // contribution across ordinary retries, progress flushes, and cooldown
    // flushes; the pending total still comes from ap.inbox. The debt was already
    // taken by takePendingAndClearTimer above, so a true duplicate needs no
    // re-queue. Empty fingerprint never dedups (fail toward sending).
    const noticeFingerprint = computeInboxNoticeFingerprint(changedMessages);
    if (ap.notifications.isDuplicateNotice(noticeFingerprint, ap.sessionId)) {
      this.recordDaemonEvent("daemon.agent.stdin_notification", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        outcome: "suppressed_duplicate",
        mode: "busy",
        pending_notification_count: count,
        inbox_count: ap.inbox.length,
        session_id_present: true,
      });
      logger.info(`[Agent ${agentId}] Suppressing duplicate stdin inbox notice (unread-set unchanged since last write); pending=${ap.inbox.length}`);
      return false;
    }
    if (!options.forceUnsupportedRetry && ap.notifications.isDuplicateEncodeFailedNotice(noticeFingerprint, ap.sessionId)) {
      ap.notifications.add(count);
      this.recordDaemonEvent("daemon.agent.stdin_notification", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        outcome: "suppressed_duplicate_encode_failed",
        mode: "busy",
        pending_notification_count: count,
        inbox_count: ap.inbox.length,
        session_id_present: true,
      });
      logger.info(`[Agent ${agentId}] Suppressing duplicate unsupported stdin inbox notice (unread-set unchanged since last encode failure); pending=${ap.inbox.length}`);
      return false;
    }
    const inboxRows = projectAgentInboxSnapshot(changedMessages);
    const notification = formatInboxUpdateRuntimeInput(changedMessages, ap.driver, inboxCount);
    const notificationByteCount = Buffer.byteLength(notification, "utf8");
    const projectionAttrs = inboxProjectionTraceAttrs(inboxRows, inboxCount);
    this.recordDaemonEvent("daemon.agent.inbox_projection.delta", {
      agentId,
      source: "busy_stdin_notification",
      ...projectionAttrs,
    });
    logger.info(`[Agent ${agentId}] Sending stdin inbox update: ${inboxRows.length} changed target(s), ${inboxCount} pending message(s)`);

    const sendResult = this.runtimeProcessBindingFence.send(
      agentId,
      ap,
      { mode: "busy", text: notification, sessionId: ap.sessionId },
      "busy_stdin_notification",
    );
    if (sendResult.ok) {
      this.recordDaemonEvent("daemon.agent.inbox_update.pushed", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        mode: "busy",
        source: "busy_stdin_notification",
        notification_byte_count: notificationByteCount,
        ...projectionAttrs,
      });
      this.recordDaemonEvent("daemon.agent.stdin_notification", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        outcome: "written",
        mode: "busy",
        pending_notification_count: count,
        inbox_count: inboxCount,
        inbox_target_count: inboxRows.length,
        session_id_present: true,
      });
      this.recordAttentionHintsShown(agentId, inboxRows, "busy_stdin_notification");
      // Register the written unread-set ONLY after a successful stdin write, so
      // a failed write leaves the prior memo intact and the retry resends the
      // same set without registering a fresh notify (Cody#1). Scoped to the
      // current session (Cody#2) — see RuntimeNotificationState.
      ap.notifications.recordNoticeWritten(noticeFingerprint, ap.sessionId, changedMessages);
      this.observeDeliveryWrite(agentId, ap, changedMessages.at(-1)?.message_id ?? null, "busy_stdin_notification");
      return true;
    } else {
      ap.notifications.add(count);
      const retryScheduled = ap.runtime.descriptor.busyDelivery === "direct" && sendResult.reason !== "unsupported"
        ? this.scheduleStdinNotification(agentId, ap, this.stdinNotificationRetryMs)
        : false;
      const outcome = runtimeSendFailureOutcome(sendResult);
      if (outcome === "encode_failed") {
        ap.notifications.recordNoticeEncodeFailed(noticeFingerprint, ap.sessionId);
      }
      this.recordDaemonEvent("daemon.agent.stdin_notification", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        outcome,
        mode: "busy",
        failure_reason: sendResult.reason,
        failure_error: sendResult.error,
        pending_notification_count: count,
        retry_scheduled: retryScheduled,
        notification_timer_present: ap.notifications.hasTimer,
        inbox_count: inboxCount,
        inbox_target_count: inboxRows.length,
        session_id_present: true,
      }, "error");
      return false;
    }
  }

  private recordInboxUpdateProjection(
    agentId: string,
    ap: AgentProcess,
    messages: readonly AgentMessage[],
    source: string,
    mode: "wake" | "idle" | "busy",
    renderedInput: string,
    totalPendingMessages = messages.length,
  ): Record<string, unknown> {
    const rows = projectAgentInboxSnapshot(messages);
    const projectionAttrs = inboxProjectionTraceAttrs(rows, totalPendingMessages);
    this.recordDaemonEvent("daemon.agent.inbox_projection.delta", {
      agentId,
      source,
      ...projectionAttrs,
    });
    this.recordDaemonEvent("daemon.agent.inbox_update.pushed", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      mode,
      source,
      notification_byte_count: Buffer.byteLength(renderedInput, "utf8"),
      cursors_advanced: "none",
      ...projectionAttrs,
    });
    return projectionAttrs;
  }

  private deliverInboxUpdateViaStdin(
    agentId: string,
    ap: AgentProcess,
    messages: AgentMessage[],
    mode: "idle" | "busy",
    source: string,
  ): boolean {
    if (messages.length === 0) return true;
    const runtimeProjection = this.projectThreadJoinContextsForRuntimeInput(agentId, messages);
    const renderedContextMessageSet = new Set(runtimeProjection.renderedContextMessages);
    const pendingNoticeMessages = messages.filter((message) => !renderedContextMessageSet.has(message));
    const rows = projectAgentInboxSnapshot(messages);
    const prompt = runtimeProjection.renderedContextMessages.length > 0
      ? formatConcreteMessagesRuntimeInput(
        runtimeProjection.renderedContextMessages,
        ap.driver,
        pendingNoticeMessages.length > 0
          ? formatInboxUpdateRuntimeInput(pendingNoticeMessages, ap.driver, ap.inbox.length)
          : undefined,
      )
      : formatInboxUpdateRuntimeInput(messages, ap.driver, ap.inbox.length);
    const projectionAttrs = this.recordInboxUpdateProjection(agentId, ap, messages, source, mode, prompt, ap.inbox.length);
    const inputTraceAttrs = buildRuntimeInputTraceAttrs({
      source,
      prompt,
      messages: runtimeProjection.messages,
      sessionIdPresent: Boolean(ap.sessionId),
      nativeStandingPrompt: Boolean(ap.driver.supportsNativeStandingPrompt),
    });
    this.recordRuntimeTraceEvent(agentId, ap, "runtime.input.prepared", inputTraceAttrs);

    const sendResult = this.runtimeProcessBindingFence.send(
      agentId,
      ap,
      { mode, text: prompt, sessionId: ap.sessionId },
      source,
    );
    if (!sendResult.ok) {
      const retryNotificationCount = mode === "idle" && ap.driver.supportsStdinNotification && ap.sessionId
        ? messages.length
        : 0;
      const retrySource = source.endsWith("_retry") ? source : `${source}_retry`;
      const retryScheduled = mode === "idle"
        ? this.scheduleIdleInboxDeliveryRetry(
          agentId,
          ap,
          retryNotificationCount,
          retrySource,
          "daemon.agent.stdin_delivery.idle_retry",
        )
        : false;
      if (mode === "idle") {
        this.commitApmIdleState(agentId, ap, true);
      }
      logger.warn(
        `[Agent ${agentId}] Failed to deliver ${mode} inbox update; ${messages.length === 1 ? "message remains" : "messages remain"} pending`,
      );
      this.recordDaemonEvent("daemon.agent.stdin_delivery", {
        agentId,
        launchId: ap.launchId || undefined,
        runtime: ap.config.runtime,
        model: ap.config.model,
        mode,
        messages_count: messages.length,
        session_id_present: Boolean(ap.sessionId),
        inbox_count: ap.inbox.length,
        pending_notification_count: ap.notifications.pendingCount,
        busy_delivery_mode: ap.driver.busyDeliveryMode,
        supports_stdin_notification: ap.driver.supportsStdinNotification,
        ...this.messagesTraceAttrs(messages),
        ...inputTraceAttrs,
        ...projectionAttrs,
        outcome: runtimeSendFailureOutcome(sendResult),
        failure_reason: sendResult.reason,
        failure_error: sendResult.error,
        requeued_messages_count: retryNotificationCount,
        retry_scheduled: retryScheduled,
        notification_timer_present: ap.notifications.hasTimer,
        cursors_advanced: "none",
      }, "error");
      return false;
    }

    // An idle write starts a new turn; stall age counts from here, not from the
    // previous turn's last runtime event.
    if (mode === "idle") ap.runtimeProgress.noteTurnStarted();
    if (this.containsOrdinaryInboxMessage(messages)) this.broadcastMessageReceivedActivity(agentId);
    const senders = [...new Set(messages.map((message) => `@${message.sender_name}`))].join(", ");
    logger.info(
      `[Agent ${agentId}] Delivering ${mode} inbox update for ${messages.length === 1 ? "message" : `${messages.length} messages`} from ${senders}`,
    );
    if (this.containsOrdinaryInboxMessage(messages)) {
      ap.lastRuntimeError = null;
    }
    if (runtimeProjection.renderedContextMessages.length > 0) {
      this.notePushedModelBodies(ap, runtimeProjection.renderedContextMessages);
      this.recordRenderedThreadJoinContextReceipts(agentId, runtimeProjection.renderedContextMessages);
      this.consumeVisibleMessages(agentId, {
        messages: runtimeProjection.renderedContextMessages,
        source: "stdin_thread_context_delivery",
      });
    }
    this.recordDaemonEvent("daemon.agent.stdin_delivery", {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      model: ap.config.model,
      mode,
      messages_count: messages.length,
      session_id_present: Boolean(ap.sessionId),
      inbox_count: ap.inbox.length,
      pending_notification_count: ap.notifications.pendingCount,
      busy_delivery_mode: ap.driver.busyDeliveryMode,
      supports_stdin_notification: ap.driver.supportsStdinNotification,
      ...this.messagesTraceAttrs(runtimeProjection.messages),
      ...inputTraceAttrs,
      ...projectionAttrs,
      outcome: "written", accepted_as: sendResult.acceptedAs,
      stdin_write_attempted: true,
      rendered_thread_context_count: runtimeProjection.renderedContextMessages.length,
      cursors_advanced: "none",
    });
    this.recordAttentionHintsShown(agentId, rows, source);
    if (pendingNoticeMessages.length > 0) {
      ap.notifications.recordNoticeWritten(
        computeInboxNoticeFingerprint(pendingNoticeMessages),
        ap.sessionId,
        pendingNoticeMessages,
      );
    }
    this.observeDeliveryWrite(
      agentId,
      ap,
      messages.at(-1)?.message_id ?? null,
      mode === "idle" ? "stdin_idle_delivery" : "stdin_turn_end_delivery",
    );
    // Phase-6: first successful post-ready delivery closes the activation wait.
    this.closeActivationTransition(ap, "advanced", "stdin");
    return true;
  }

  /** Deliver a message to an agent via stdin, formatting it the same way as the MCP bridge */
  private deliverMessagesViaStdin(
    agentId: string,
    ap: AgentProcess,
    messages: AgentMessage[],
    mode: "idle" | "busy",
    options: { transient?: boolean } = {},
  ): boolean {
    if (messages.length === 0) return true;
    const runtimeProfileMigrationMessages = messages.filter((message) => runtimeProfileNotificationFromMessage(message)?.kind === "migration");
    if (runtimeProfileMigrationMessages.length > 0) {
      for (const message of runtimeProfileMigrationMessages) {
        const notification = runtimeProfileNotificationFromMessage(message);
        if (notification?.kind === "migration") {
          this.completeDeprecatedRuntimeProfileMigration(agentId, notification.key, ap.launchId, message.traceparent, "runtime_profile_message");
        }
      }
      messages = messages.filter((message) => runtimeProfileNotificationFromMessage(message)?.kind !== "migration");
      this.recordDaemonEvent("daemon.agent.runtime_profile.deprecated_migration_filtered", {
        agentId,
        launchId: ap.launchId || undefined,
        runtime: ap.config.runtime,
        mode,
        filtered_messages_count: runtimeProfileMigrationMessages.length,
        remaining_messages_count: messages.length,
      });
      if (messages.length === 0) {
        if (mode === "idle") {
          this.commitApmIdleState(agentId, ap, true);
        }
        return true;
      }
    }
    const runtimeProjection = this.projectThreadJoinContextsForRuntimeInput(
      agentId,
      messages,
      options.transient !== true,
    );
    const traceAttrs = {
      agentId,
      launchId: ap.launchId || undefined,
      runtime: ap.config.runtime,
      model: ap.config.model,
      mode,
      messages_count: messages.length,
      session_id_present: Boolean(ap.sessionId),
      inbox_count: ap.inbox.length,
      pending_notification_count: ap.notifications.pendingCount,
      busy_delivery_mode: ap.driver.busyDeliveryMode,
      supports_stdin_notification: ap.driver.supportsStdinNotification,
      transient_delivery: options.transient === true,
      ...this.messagesTraceAttrs(runtimeProjection.messages),
    };

    const traceSource = options.transient ? `stdin_${mode}_transient_delivery` : `stdin_${mode}_delivery`;
    const prompt = formatRuntimeProfileControlPrompt(runtimeProjection.messages)
      ?? formatConcreteMessagesRuntimeInput(runtimeProjection.messages, ap.driver);
    const inputTraceAttrs = buildRuntimeInputTraceAttrs({
      source: traceSource,
      prompt,
      messages: runtimeProjection.messages,
      sessionIdPresent: Boolean(ap.sessionId),
      nativeStandingPrompt: Boolean(ap.driver.supportsNativeStandingPrompt),
    });
    this.recordRuntimeTraceEvent(agentId, ap, "runtime.input.prepared", inputTraceAttrs);

    const sendResult = this.runtimeProcessBindingFence.send(
      agentId,
      ap,
      { mode, text: prompt, sessionId: ap.sessionId },
      traceSource,
    );
    if (!sendResult.ok) {
      // Preserve queued work if the runtime cannot encode the live delivery yet.
      // This is especially important for protocol-steering runtimes where the
      // active turn id may disappear during a narrow state-transition window.
      if (!options.transient) {
        ap.inbox.unshift(...messages);
      }
      if (mode === "idle") {
        this.commitApmIdleState(agentId, ap, true);
      }
      logger.warn(
        `[Agent ${agentId}] Failed to deliver ${mode} stdin input; re-queued ${messages.length === 1 ? "message" : `${messages.length} messages`}`,
      );
      this.recordDaemonEvent("daemon.agent.stdin_delivery", {
        ...traceAttrs,
        ...inputTraceAttrs,
        outcome: runtimeSendFailureOutcome(sendResult),
        failure_reason: sendResult.reason,
        failure_error: sendResult.error,
        requeued_messages_count: options.transient ? 0 : messages.length,
      }, "error");
      return false;
    }

    if (mode === "idle") ap.runtimeProgress.noteTurnStarted();
    if (this.containsOrdinaryInboxMessage(messages)) this.broadcastMessageReceivedActivity(agentId);
    if (!options.transient) {
      this.notePushedModelBodies(ap, [...messages, ...runtimeProjection.renderedContextMessages]);
      this.recordRenderedThreadJoinContextReceipts(agentId, runtimeProjection.renderedContextMessages);
      this.consumeVisibleMessages(agentId, { messages, source: traceSource });
    }
    const senders = [...new Set(messages.map((message) => `@${message.sender_name}`))].join(", ");
    logger.info(
      `[Agent ${agentId}] Delivering ${mode} ${messages.length === 1 ? "message" : `${messages.length} messages`} via stdin from ${senders}`,
    );
    if (this.containsOrdinaryInboxMessage(messages)) {
      ap.lastRuntimeError = null;
    }
    this.ackInjectedRuntimeProfileMessages(agentId, messages, ap.launchId);
    this.recordDaemonEvent("daemon.agent.stdin_delivery", {
      ...traceAttrs,
      ...inputTraceAttrs,
      outcome: "written", accepted_as: sendResult.acceptedAs,
      stdin_write_attempted: true,
      rendered_thread_context_count: runtimeProjection.renderedContextMessages.length,
    });
    // Phase-6: first successful post-ready delivery closes the activation wait.
    this.closeActivationTransition(ap, "advanced", "stdin");
    return true;
  }

  /** List ONE level of a directory — directories returned without children (lazy-loaded on demand) */
  private async listDirectoryChildren(dir: string, rootDir: string, includeHidden = false): Promise<FileNode[]> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    const nodes: FileNode[] = [];
    for (const entry of entries) {
      const isHidden = entry.name.startsWith(".");
      if (entry.name === "node_modules") continue;
      if (isHidden && (!includeHidden || isWorkspaceNeverVisibleHiddenEntry(entry.name))) continue;
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);
      let info;
      try { info = await stat(fullPath); } catch { continue; }
      if (entry.isDirectory()) {
        // children omitted (undefined) — frontend will lazy-load on expand
        nodes.push({ name: entry.name, path: relativePath, isDirectory: true, size: 0, modifiedAt: info.mtime.toISOString(), isHidden });
      } else {
        nodes.push({ name: entry.name, path: relativePath, isDirectory: false, size: info.size, modifiedAt: info.mtime.toISOString(), isHidden });
      }
    }
    return nodes;
  }
}
