export { verifyBundledPiOAuth } from "./bundledPiOAuth";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { accessSync } from "node:fs";
import { mkdir, readFile, rename, rm, statfs, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import {
  DISTRIBUTION_POLICY,
  createTraceScopeTracer,
  AGENT_MIGRATION_CAPABILITY,
  COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS,
  currentDate,
  currentTimeMs,
  errorClassOf,
  formatTraceparent,
  getStaticRuntimeModelSourceSet,
  noopTracer,
  parseTraceparent,
  RUNTIMES,
  type ActiveSpan,
  type AgentConfig,
  type ComputerLastUpgradeReceipt,
  type ComputerLifecycleExecutionAck,
  type AgentMigrationTransportLeaseMessage,
  type AgentMigrationTransportReady,
  type MachineToServerMessage,
  type MentionDeliveryTerminalErrorCode,
  type MachineShutdownReason,
  type RuntimeModelSourceOutcome,
  type RuntimeAccountUsageProvider,
  type RuntimeAccountUsageSnapshot,
  type ServerToMachineMessage,
  type TraceContext,
  type TraceScope,
  type TraceSpanAttrContracts,
  type TraceStatus,
  type Tracer,
  DAEMON_CAPABILITY_SEQUENCED_STATUS,
  isValidMachineDiskStatus,
  DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1,
  SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1,
  type AgentStartNotSpawnedReason,
} from "@botiverse/raft-shared";
import {
  RUNTIME_OUTCOME_OUTBOX_DIR_NAME,
  RUNTIME_OUTCOME_STORAGE_BLOCKED_TEXT,
  RuntimeOutcomeOutbox,
  AUTOMATIC_START_REFUSAL_TEXT,
  isOutboxFrame,
  type OutboxFs,
  type OutboxStartAdmission,
  type RecoveryGrant,
} from "./runtimeOutcomeOutbox";
import {
  APP_CONFIG_TRACE_IDENTITY_KEYS,
  APP_SNAPSHOT_TRACE_IDENTITY_KEYS,
  APP_SOURCE_TRACE_IDENTITY_KEYS,
} from "@botiverse/raft-shared/src/appRuntimeTrace";
import { AgentProcessManager, classifySpawnFailure, type RuntimeProcessGate } from "./agentProcessManager";
import { getDriver } from "./drivers/index";
import { readCommandVersion, resolveCommandOnPath } from "./drivers/probe";
import {
  DaemonConnection,
  systemClock,
  type ConnectionOptions,
  type Clock,
} from "./connection";
import { createAgentAppInboxStore, type AgentAppInboxStore } from "./agentAppInbox";
import {
  createScopedAppStorageFactory,
  type ScopedAppStorageFactory,
} from "./scopedAppStorage";
import {
  createScopedAppStorageObserver,
  type ScopedAppStorageObserver,
} from "./scopedAppStorageObservability";
import {
  BUILT_IN_READY_CAPABILITIES,
  createBuiltInLocalScheduleRuntime,
} from "./registry.manifest";
import { logger } from "./logger";
import { runFeedbackTranscriptRequest } from "./feedbackTranscriptOutcomeUpload";
import {
  acquireDaemonMachineLock,
  resolveDefaultMachineStateRoot,
  type DaemonMachineOwnerProvenance,
  type DaemonMachineLockHandle,
} from "./machineLock";
import {
  LocalRotatingTraceSink,
  computeTraceJitter,
  createTraceClient,
  getActiveTraceContext,
  NO_JITTER,
  runWithActiveSpan,
  type TraceJitter,
} from "@botiverse/raft-trace-client";
import { DaemonTraceBundleUploader } from "./traceBundleUpload";
import { ProbeGate } from "./probeGate";
import { SLOCK_HOME_ENV, listLegacyRaftStatePaths, resolveRaftHome, resolveRaftHomePath } from "./raftHome";
import { regenerateExistingOpencliWrappers } from "./drivers/cliTransport";
import { daemonFetch } from "./daemonFetch";
import {
  buildProviderProbeResultMessage,
  buildUnclaimedProviderProbeResult,
  claimProbeMaterialization,
  runProviderProbeCanary,
  type ProbeMaterialization,
} from "./providerProbe";
import { isProviderProbeRuntime } from "@botiverse/raft-shared";
import { VERSION as PI_SDK_VERSION } from "@earendil-works/pi-coding-agent";
import { asProviderProbeId } from "@botiverse/raft-shared";
import { assertLegacyDaemonKeyNotAdoptedByComputer } from "./computerMigrationGuard";
import { buildRuntimeModelSourceResultMessage } from "./runtimeModelSourceProjection";
import {
  archiveCompletedAgentMigrationSourceWorkspace,
  quarantinePreexistingAgentWorkspace,
  type AgentMigrationWorkspaceArchiveOutcome,
} from "./agentMigrationWorkspaceArchive";
import {
  createRaftDiskWalkBudget,
  measureRaftDiskFootprint,
  removeMigrationGenerationBulk,
  runRaftDiskJanitor,
  scheduleRaftDiskJanitor,
  type RaftDiskFootprint,
} from "./raftDiskJanitor";
import type { AgentMigrationExportProgress } from "./agentMigrationExport";
import {
  classifyAgentMigrationTargetResidue,
  commitMarkerMatches,
  readCommitMarker,
  migrationStatePathSegment,
  missingAgentMigrationChunks,
  stageAndCommitAgentMigrationResumableBundle,
  streamAgentMigrationResumableBundle,
  validateAgentMigrationControlManifest,
  verifyAndStoreAgentMigrationChunk,
  type AgentMigrationControlChunk,
  type AgentMigrationControlManifest,
  type AgentMigrationPlacementStep,
} from "./agentMigrationResumableBundle";

export * from "./legacySupervisor";
import { readSecretFileSync } from "./secretFile";
import {
  createRuntimeAccountUsageCollector,
  type RuntimeAccountUsageCollector,
} from "./runtimeAccountUsage/collector";

/**
 * Default endpoint for daemon trace bundle uploads. Always baked as the
 * fallback when no explicit URL is configured — per product decision, the
 * same hosted URL applies across environments (real users connect to
 * hosted prod anyway), with two explicit escape hatches:
 *
 *   1. `SLOCK_DAEMON_TRACE_UPLOAD_DISABLED=1` — highest priority off-switch
 *   2. `SLOCK_DAEMON_TRACE_UPLOAD_URL` — explicit override for any env
 *
 * Self-host / staging / play / local deployments that want no upload must
 * set `DISABLED=1`; those that want their own worker set the URL explicitly.
 */
const DEFAULT_TRACE_UPLOAD_URL = "https://slock-trace-upload.botiverse.dev";
const RUNNER_CREDENTIAL_SCOPES = ["send", "read", "mentions", "tasks", "reactions", "server", "channels", "knowledge", "mcp"] as const;
const RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS = 3;
const RUNNER_CREDENTIAL_MINT_RETRY_DELAY_MS = 250;
const MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_INITIAL_MS = 25;
const MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_MAX_MS = 250;
// Matches the source's upload concurrency.
const MIGRATION_TARGET_CHUNK_DOWNLOAD_CONCURRENCY = 3;
const DISK_STATUS_FIRST_REPORT_DELAY_MS = 60_000;
const DISK_STATUS_REPORT_INTERVAL_MS = 60 * 60 * 1_000;
const STUCK_TOOL_V0_IDENTITY_ATTRS = [
  "schema_version",
  "server_id",
  "machine_id",
  "agent_id",
  "launch_id",
  // #424: the raw value is dropped by the sink and has no hash form; the fact
  // it carried ("this tool had a session") survives on the flag below, which is
  // #422 class B. Listing the bare key promised something the disk never gets.
  "runtime_session_id_present",
  "runtime_turn_id",
  "tool_execution_instance_id",
  "runtime_tool_call_id_present",
  "process_instance_id",
  // #424: `producer_fact_id` removed — scrubbed by the #460 ruling and its emit
  // deleted in #422, so the contract was naming a key nothing can supply.
  "runtime",
  "runtime_version",
  "tool_class",
] as const;

export const DAEMON_CORE_TRACE_ATTR_CONTRACTS = {
  // task #1127. Registering this span is also how "never record argument
  // values" stops being a promise: the contract filter drops anything not
  // listed, so a later attempt to attach the stderr body cannot survive.
  "daemon.agent.tool_argument_parse_failed": {
    spanAttrs: [
      "agentId",
      "launchId",
      "runtime",
      "model",
    ],
  },
  "daemon.runtime_account_usage.refresh": {
    spanAttrs: [
      "outcome",
      "provider",
      "reason",
      "account_count",
      "window_count",
      "health_classes",
      "parse_unavailable_count",
      "error_class",
    ],
  },
  "daemon.app_config.receive": {
    spanAttrs: [
      ...APP_CONFIG_TRACE_IDENTITY_KEYS,
      ...APP_SNAPSHOT_TRACE_IDENTITY_KEYS,
      "message_type",
      "outcome",
      "reason",
    ],
  },
  "daemon.app_inbox.mint": {
    spanAttrs: [...APP_SOURCE_TRACE_IDENTITY_KEYS, "outcome", "retention"],
  },
  "daemon.app_inbox.ack": {
    spanAttrs: [...APP_SOURCE_TRACE_IDENTITY_KEYS, "outcome", "retention"],
  },
  "daemon.agent.app_inbox_notice": {
    spanAttrs: [
      ...APP_SOURCE_TRACE_IDENTITY_KEYS,
      "outcome",
      "mode",
      "pending_app_items",
      "message_identity_created",
    ],
  },
  "daemon.app_source.receive": {
    spanAttrs: [
      ...APP_SOURCE_TRACE_IDENTITY_KEYS,
      ...APP_SNAPSHOT_TRACE_IDENTITY_KEYS,
      "message_type",
      "outcome",
    ],
  },
  "daemon.app_source.snapshot_request": {
    spanAttrs: [
      ...APP_SNAPSHOT_TRACE_IDENTITY_KEYS,
      "outcome",
      "reason",
    ],
  },
  "daemon.app_source.arm": {
    spanAttrs: [...APP_SOURCE_TRACE_IDENTITY_KEYS, "outcome", "reason"],
  },
  "daemon.app_source.fire": {
    spanAttrs: [
      ...APP_SOURCE_TRACE_IDENTITY_KEYS,
      "outcome",
      "reason",
      "wake_enqueued",
      "catchup",
    ],
    endAttrs: [
      "item_id",
      "outcome",
      "reason",
      "wake_enqueued",
      "catchup",
      "error_class",
    ],
  },
  "daemon.app_source.receipt": {
    spanAttrs: [...APP_SOURCE_TRACE_IDENTITY_KEYS, "outcome", "catchup"],
  },
  "daemon.app_source.fire_request": {
    spanAttrs: [...APP_SOURCE_TRACE_IDENTITY_KEYS, "request_id", "catchup"],
    endAttrs: ["outcome", "error_class"],
  },
  "daemon.app_storage.failure": {
    spanAttrs: [
      "operation",
      "store",
      "app",
      "server_id",
      "writer_epoch",
      "outcome",
      "reason",
      "failure_generation",
      "corruption_class",
    ],
  },
  "daemon.app_storage.counter": {
    spanAttrs: [
      "operation",
      "store",
      "app",
      "server_id",
      "writer_epoch",
      "family",
      "count",
      "outcome",
      "reason",
      "observed_at",
      "failure_generation",
      "corruption_class",
    ],
  },
  "daemon.app_storage.alert": {
    spanAttrs: [
      "store",
      "app",
      "server_id",
      "writer_epoch",
      "family",
      "reason",
      "operation",
      "outcome",
      "failure_reason",
      "count",
      "window_ms",
      "observed_at",
      "corruption_class",
    ],
  },
  "daemon.app_storage.heartbeat": {
    spanAttrs: ["heartbeat", "family", "server_id", "writer_epoch", "observed_at"],
  },
  "daemon.app_storage.instrumentation": {
    spanAttrs: [
      "store",
      "app",
      "server_id",
      "writer_epoch",
      "family",
      "outcome",
      "reason",
      "observed_at",
    ],
  },
  "daemon.app_schedule.occurrence": {
    spanAttrs: [
      ...APP_SOURCE_TRACE_IDENTITY_KEYS,
      "occurrence",
      "phase",
      "outcome",
      "observed_at",
      "reason",
      "scheduled_due",
      "fire_delay_ms",
    ],
  },
  "daemon.app_schedule.delivery_alert": {
    spanAttrs: [
      ...APP_SOURCE_TRACE_IDENTITY_KEYS,
      "occurrence",
      "reason",
      "scheduled_due",
      "fire_delay_ms",
      "fired",
      "app_item_materialized",
      "wake_request_accepted",
      "turn_outcome",
      "acknowledged",
      "observed_at",
    ],
  },
  "daemon.lifecycle.start": {
    spanAttrs: ["machine_dir_present", "local_trace_enabled"],
    endAttrs: ["error_class"],
    eventAttrs: {
      "daemon.machine_lock.acquired": ["machine_dir_present"],
    },
  },
  "daemon.lifecycle.stop": {
    spanAttrs: ["machine_lock_present"],
  },
  "daemon.runner_credential_mint": {
    spanAttrs: ["agentId", "runtime"],
    endAttrs: ["error_class"],
  },
  "daemon.runner_credential_mint.retry": {
    spanAttrs: ["agentId", "runtime", "attempt", "max_attempts", "http_status", "code", "reason", "retryable"],
  },
  "daemon.runner_credential_mint.failed": {
    spanAttrs: ["agentId", "runtime", "http_status", "code", "reason", "retryable", "max_attempts"],
  },
  "daemon.agent.spawn.failed": {
    spanAttrs: [
      "agentId",
      "launchId",
      "start_dispatch_id",
      "runtime",
      "model",
      "failure_reason",
      "failure_classification",
      "session_id_present",
    ],
  },
  "daemon.runtime.node_host_launch": {
    spanAttrs: ["agentId", "launchId", "runtime", "candidate_source", "host_kind", "electron_run_as_node"],
    endAttrs: ["error_class"],
  },
  "daemon.agent.process.error": {
    spanAttrs: ["agent_id", "server_id", "machine_id", "launch_id", "start_dispatch_id", "process_instance_id", "session_id_present", "runtime", "runtime_version", "error_class"],
  },
  "daemon.codex.request_instruction_shape": {
    spanAttrs: [
      "agent_id",
      "server_id",
      "machine_id",
      "launch_id",
      "process_instance_id",
      "session_id",
      "session_id_present",
      "runtime",
      "runtime_version",
      "instruction_shape_schema_version",
      "source",
      "observation_phase",
      "session_request_method",
      "codex_app_server_version_state",
      "codex_app_server_version",
      "compaction_count_source",
      "compaction_starts_count",
      "compaction_finishes_count",
      "standing_instructions_present",
      "standing_instructions_state",
      "standing_instructions_utf8_bytes",
      "standing_instructions_sha256",
      "developer_instructions_present",
      "developer_instructions_state",
      "developer_instructions_utf8_bytes",
      "developer_instructions_sha256",
      "base_instructions_present",
      "base_instructions_state",
      "base_instructions_utf8_bytes",
      "base_instructions_sha256",
      "developer_instructions_match_standing",
    ],
  },
  "daemon.agent.start": {
    spanAttrs: ["agent_id", "launch_id", "start_dispatch_id", "runtime"],
    endAttrs: ["outcome", "error_class"],
  },
  "daemon.agent.start_dispatch.receipt": {
    spanAttrs: [
      "agent_id",
      "launch_id",
      "start_dispatch_id",
      "queue_state",
      "queue_depth",
      "queue_age_ms",
      "outcome",
    ],
  },
  "launch_residency_transition": {
    spanAttrs: [
      "span_name",
      "phase",
      "agent_launch_id",
      "agent_id",
      "server_id",
      "machine_id",
      "runtime",
      "driver",
      "launch_source",
      "state_instance_id",
      "transition_seq",
      "residency_transition_seq",
      "transition_kind",
      "phase_result",
      "close_result",
      "state",
      "residency",
      "agent_launch_id_present",
      "is_wait_state",
      "fence_kind",
      "deadline_unix_ms",
      "failure_kind",
      "negative_evidence_bucket",
    ],
  },
  "daemon.agent.delivery": {
    spanAttrs: ["agentId", "deliveryId", "delivery_correlation_id", "messageId", "message_id_present", "seq"],
    eventAttrs: {
      "daemon.receive": ["seq", "deliveryId"],
      "daemon.deliver_to_agent_manager": ["accepted"],
      "daemon.delivery.buffered_for_start": ["pending_count"],
      "daemon.ack.sent": ["seq"],
    },
    endAttrs: ["outcome", "ackSeq", "deliveryId", "error_class", "pending_count"],
  },
  "daemon.agent_proxy.request": {
    spanAttrs: [
      "route_family",
      "method",
      "trace_context_state",
      "proxy_launch_id_present",
      "correlation_id",
    ],
    endAttrs: [
      "outcome",
      "local_response_kind",
      "http_status",
      "normalized_code",
      "response_started",
    ],
  },
  "daemon.runtime_profile.control.received": {
    spanAttrs: ["agentId", "control_kind", "key_present", "launchId"],
    endAttrs: ["outcome", "error_class"],
  },
  "daemon.computer_control.received": {
    spanAttrs: ["action", "handled", "operation_id", "request_id"],
  },
  "daemon.computer_control.replayed": {
    spanAttrs: ["action", "operation_id", "outcome"],
  },
  "daemon.ready.sent": {
    spanAttrs: ["runtimes_count", "running_agents_count", "idle_agents_count", "runtime_profile_reports_count"],
  },
  "daemon.runtime_profile.report.sent": {
    spanAttrs: ["agentId", "launchId", "runtime", "report_source", "model_present", "session_ref_present", "workspace_ref_present"],
  },
  "daemon.runtime.progress.activity.suppressed": {
    spanAttrs: ["agentId", "launchId", "runtime", "outcome", "source", "itemType", "payloadBytes"],
  },
  "daemon.runtime_models.detect": {
    spanAttrs: ["runtime", "request_id"],
    eventAttrs: {
      "daemon.pi.models.services_ready": ["available_models_count", "diagnostics_count", "diagnostic_info_count", "diagnostic_warning_count"],
      "daemon.pi.models.result": ["available_models_count", "returned_models_count", "diagnostics_count", "diagnostic_info_count", "diagnostic_warning_count", "outcome"],
    },
    endAttrs: ["outcome", "models_count", "default_model_present", "verified_as", "error_class"],
  },
  // task #510: per-prompt span. `prompts_in_flight` is the cross-agent concurrency
  // observable — under the old process-env-patch lock it could never exceed 1
  // (every Pi prompt serialized process-wide); > 1 proves the queue is gone.
  // `queued_ms` is the queued -> prompt-start wait that users experienced as the
  // 60-165s stall.
  "daemon.pi.prompt": {
    spanAttrs: ["agentId", "launchId", "runtime", "queued_ms", "duration_ms", "prompts_in_flight_after"],
    eventAttrs: {
      "daemon.pi.prompt.start": ["agentId", "queued_ms", "prompts_in_flight"],
      "daemon.pi.provider_request.failed": [
        "phase",
        "response_started",
        "reason",
        "http_status",
        // #424: renamed from `session_id_present` and the bare
        // `runtime_session_id` removed — same value, one family. See pi.ts.
        "runtime_session_id_present",
        "launch_id_present",
        "launch_id",
      ],
    },
  },
  "daemon.runtime.tool.execution.started": {
    spanAttrs: [
      ...STUCK_TOOL_V0_IDENTITY_ATTRS,
      "execution_state",
      "process_capability",
    ],
  },
  "daemon.runtime.tool.process.spawned": {
    spanAttrs: [
      ...STUCK_TOOL_V0_IDENTITY_ATTRS,
      "process_state",
      "process_tree_tracking",
      "stdio_mode",
    ],
  },
  "daemon.runtime.tool.progress.observed": {
    spanAttrs: [
      ...STUCK_TOOL_V0_IDENTITY_ATTRS,
      "progress_source",
      "observed_bytes_bucket",
      "update_count_bucket",
    ],
  },
  "daemon.runtime.tool.process.exited": {
    spanAttrs: [
      ...STUCK_TOOL_V0_IDENTITY_ATTRS,
      "process_state",
      "exit_kind",
      "process_runtime_ms",
    ],
  },
  "daemon.runtime.tool.execution.finished": {
    spanAttrs: [
      ...STUCK_TOOL_V0_IDENTITY_ATTRS,
      "execution_state",
      "execution_runtime_ms",
      "process_exit_observed_before_finish",
    ],
  },
  "daemon.runtime.tool.diagnostic.snapshot": {
    spanAttrs: [
      ...STUCK_TOOL_V0_IDENTITY_ATTRS,
      "diagnostic_trigger",
      "classification",
      "tool_pending",
      "process_liveness",
      "process_liveness_source",
      "progress_state",
      "tool_age_ms",
      "last_progress_age_ms",
      "observation_interval_ms",
      "runtime_inactivity_age_ms",
      "negative_evidence_bucket",
    ],
  },
  "daemon.pi.session.create": {
    spanAttrs: ["agentId", "launchId", "runtime", "model", "session_id_present", "requested_model"],
    eventAttrs: {
      "daemon.pi.session.services_ready": ["available_models_count", "diagnostics_count", "diagnostic_info_count", "diagnostic_warning_count", "agent_dir_source"],
      "daemon.pi.session.model_resolved": ["available_models_count", "requested_model", "requested_model_explicit", "resolved_model", "resolved_model_present"],
      "daemon.pi.session.missing_model": ["available_models_count", "requested_model"],
      "daemon.pi.session.started": ["requested_model", "resolved_model", "session_id_present"],
    },
    endAttrs: ["outcome", "available_models_count", "diagnostics_count", "diagnostic_info_count", "diagnostic_warning_count", "requested_model", "resolved_model", "resolved_model_present", "error_class"],
  },
  "daemon.builtin.session.create": {
    spanAttrs: ["agentId", "launchId", "runtime", "model", "session_id_present", "requested_model", "config_source", "host_user_state", "provider_id", "model_kind", "model_id", "base_url_present", "base_url_host_class", "provider_key_present", "provider_key_source"],
    eventAttrs: {
      "daemon.builtin.session.services_ready": ["available_models_count", "diagnostics_count", "diagnostic_info_count", "diagnostic_warning_count", "agent_dir_source", "config_source", "host_user_state", "provider_id", "model_kind", "model_id", "base_url_present", "base_url_host_class", "provider_key_present", "provider_key_source"],
      "daemon.builtin.session.model_resolved": ["available_models_count", "requested_model", "requested_model_explicit", "resolved_model", "resolved_model_present", "config_source", "host_user_state", "provider_id", "model_kind", "model_id", "base_url_present", "base_url_host_class", "provider_key_present", "provider_key_source"],
      "daemon.builtin.session.missing_model": ["available_models_count", "requested_model", "config_source", "host_user_state", "provider_id", "model_kind", "model_id", "base_url_present", "base_url_host_class", "provider_key_present", "provider_key_source"],
      "daemon.builtin.session.started": ["requested_model", "resolved_model", "session_id_present", "config_source", "host_user_state", "provider_id", "model_kind", "model_id", "base_url_present", "base_url_host_class", "provider_key_present", "provider_key_source"],
    },
    endAttrs: ["outcome", "available_models_count", "diagnostics_count", "diagnostic_info_count", "diagnostic_warning_count", "requested_model", "resolved_model", "resolved_model_present", "error_class", "config_source", "host_user_state", "provider_id", "model_kind", "model_id", "base_url_present", "base_url_host_class", "provider_key_present", "provider_key_source"],
  },
  "daemon.connection.local_disconnect_observed": {
    spanAttrs: ["running_agents_count", "idle_agents_count"],
  },
  "daemon.migration_transport.object_store": {
    spanAttrs: [
      "outcome",
      "role",
      "transfer_kind",
      "migration_ref",
      "stage",
      "operation",
      "agent_id_present",
      "migration_id_present",
      "session_id_present",
      "error_class",
      "error_code",
      "upstream_error_code",
      "http_status",
    ],
  },
  "daemon.migration_transport.resumable": {
    spanAttrs: [
      "outcome",
      "role",
      "transfer_kind",
      "migration_ref",
      "stage",
      "operation",
      "error_class",
      "error_code",
      "upstream_error_code",
      "http_status",
      "attempt",
      "retry_delay_ms",
      "chunk_count",
      "bundle_size_bucket",
      "control_bytes",
      "commit_outcome",
      "residue_class",
      "duration_ms",
      "chunks_removed",
      "chunks_freed_bytes",
    ],
  },
  "daemon.migration_transport.lease": {
    spanAttrs: [],
    endAttrs: [
      "outcome",
      "role",
      "transfer_kind",
      "migration_ref",
      "stage",
      "error_class",
      "agent_id_present",
      "migration_id_present",
      "session_id_present",
    ],
  },
  "daemon.migration_transport.transfer": {
    spanAttrs: ["role", "transfer_kind", "migration_ref", "stage", "download_concurrency"],
    endAttrs: ["outcome", "error_class"],
  },
  "daemon.migration_transport.placement": {
    spanAttrs: ["role", "transfer_kind", "migration_ref", "stage", "chunk_count", "file_count", "expanded_bytes"],
    endAttrs: ["outcome", "error_class"],
  },
  "daemon.agent.activity.produced": {
    // isHeartbeat/is_heartbeat (#460 V1) and process_instance_id (#460 V3)
    // were emitted by agentProcessManager but scrubbed here (pilot violation
    // V4): this list is a RUNTIME allowlist (SpanAttrContractTracer), so an
    // emission-site key that is not added here silently dies before disk.
    // Witness for the pair lives in agentProcessManager.builtin.e2e.test.ts
    // behind a contract-wrapped tracer (production-isomorphic oracle).
    // producerFactId/producer_fact_id and activity_kind/detail_kind are ALSO
    // emitted-and-scrubbed today; deliberately NOT added here — banned-join-
    // key discipline for the fact id (#460 classification ruling) means
    // widening needs its own ruling, not a drive-by.
    spanAttrs: ["agentId", "agent_id", "server_id", "machine_id", "activity", "detail_present", "entry_kinds", "ap_present", "launchId", "launch_id", "launch_id_present", "clientSeq", "client_seq", "client_seq_present", "correlation_id", "session_id_present", "runtime", "isHeartbeat", "is_heartbeat", "process_instance_id"],
  },
  "daemon.agent.status.transition": {
    spanAttrs: [
      "agentId",
      "agent_id",
      "agent_status",
      "previous_status",
      "previous_status_present",
      "status_changed",
      "launchId",
      "launch_id",
      "launch_id_present",
      "previous_launch_id_present",
      "launch_id_changed",
      "status_transition_seq",
      "observed_at_ms",
      "process_instance_id",
      "runtime",
      "session_id_present",
    ],
  },
  "daemon.agent.activity.skipped": {
    spanAttrs: ["agentId", "event_kind", "reason", "text_length"],
  },
  "daemon.agent.event.received_without_process": {
    spanAttrs: ["agentId", "event_kind", "runtime"],
  },
} satisfies TraceSpanAttrContracts;
export { subscribeDaemonLogs, type DaemonLogEvent, type DaemonLogLevel } from "./logger";
export {
  deleteWorkspaceDirectory,
  resolveWorkspaceDirectoryPath,
  scanWorkspaceDirectories,
} from "./workspaces";

export const DAEMON_CLI_USAGE = "Usage: slock-daemon --server-url <url> --api-key-file <path>";

export interface ParsedDaemonCliArgs {
  serverUrl: string;
  apiKey: string;
}

export interface RuntimeDetection {
  ids: string[];
  versions: Record<string, string>;
  diagnostics?: Record<string, string>;
}

export type DefaultAgentEnvVarsProvider = (
  config: Pick<AgentConfig, "runtime" | "model" | "envVars">,
) => Promise<Record<string, string> | null> | Record<string, string> | null;

class RunnerCredentialMintError extends Error {
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

async function waitForAmbientBackoff(delayMs: number, signal?: AbortSignal): Promise<void> {
  // Accepted ambient timer: retry sleeps are bounded by upstream attempt limits or lease TTLs, not business-clock driven.
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForRunnerCredentialRetry(): Promise<void> {
  await waitForAmbientBackoff(RUNNER_CREDENTIAL_MINT_RETRY_DELAY_MS);
}

function isRetryableMigrationObjectStoreDownloadStatus(status: number): boolean {
  return status === 404
    || status === 408
    || status === 409
    || status === 425
    || status === 429
    || status >= 500;
}

function isRetryableResumableMigrationStatus(status: number, retryNotFound: boolean): boolean {
  return (retryNotFound && status === 404)
    || status === 408
    || status === 425
    || status === 429
    || status >= 500;
}

// Bundle-build progress is reported at most this often. The server slides the
// prep deadline only when the reported counts grew, so a stuck build that keeps
// reporting still times out.
const MIGRATION_SOURCE_PROGRESS_INTERVAL_MS = 30_000;
const MIGRATION_TARGET_STEP_RETRY_INITIAL_MS = 1_000;
const MIGRATION_TARGET_STEP_RETRY_MAX_MS = 30_000;
// Long enough to ride out a rolling server deploy; bounded well inside the
// arrival deadline so a genuinely broken server still fails the run.
const MIGRATION_TARGET_STEP_RETRY_BUDGET_MS = 5 * 60_000;

/** States in which a target control step has already taken effect. */
const MIGRATION_TARGET_STEP_APPLIED_STATES: Record<"start-transfer" | "flip-machine" | "arrived", readonly string[]> = {
  "start-transfer": ["in_transit", "arriving", "starting", "completed"],
  "flip-machine": ["arriving", "starting", "completed"],
  "arrived": ["starting", "completed"],
};

/** Network failures and 408/425/429/5xx responses may succeed on retry; 4xx decisions do not. */
export function isTransientMigrationStepFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = /^MIGRATION_TARGET_IMPORT_[A-Z_]+_FAILED:(\d{3})(?::|$)/.exec(error.message)?.[1]
    ?? /^MIGRATION_TARGET_IMPORT_LOOKUP_FAILED:(\d{3})$/.exec(error.message)?.[1];
  if (status) {
    const code = Number(status);
    return code === 408 || code === 425 || code === 429 || code >= 500;
  }
  // fetch() rejects with a TypeError ("fetch failed") on connection-level errors.
  return error instanceof TypeError || systemErrorCode(error) !== null || systemErrorCode(error.cause) !== null;
}

/**
 * Target control steps used to be sent once: a 5xx or dropped connection
 * during a server deploy failed the whole migration, even after the flip.
 * Retry transient failures with backoff, and before each retry read the
 * current view: the lost attempt may have committed, in which case the step is
 * done and must not be replayed. If it did not commit, the identical request
 * is resent; a generation change aborts the run instead (the server rejects
 * stale generations, and a retry must never borrow the new one).
 */
export async function retryMigrationTargetStep<B extends { migrationGeneration: string }>(input: {
  step: keyof typeof MIGRATION_TARGET_STEP_APPLIED_STATES;
  body: B;
  post: (body: B) => Promise<MigrationTargetImportView>;
  fetchView: () => Promise<MigrationTargetImportView>;
  onRetry?: (error: unknown, delayMs: number) => void;
  wait?: (delayMs: number) => Promise<void>;
  nowMs?: () => number;
}): Promise<MigrationTargetImportView> {
  const nowMs = input.nowMs ?? currentTimeMs;
  const wait = input.wait ?? ((delayMs: number) => waitForAmbientBackoff(delayMs));
  const retryUntilMs = nowMs() + MIGRATION_TARGET_STEP_RETRY_BUDGET_MS;
  let delayMs = MIGRATION_TARGET_STEP_RETRY_INITIAL_MS;
  while (true) {
    try {
      return await input.post(input.body);
    } catch (error) {
      if (!isTransientMigrationStepFailure(error) || nowMs() + delayMs > retryUntilMs) throw error;
      input.onRetry?.(error, delayMs);
    }
    await wait(delayMs);
    delayMs = Math.min(delayMs * 2, MIGRATION_TARGET_STEP_RETRY_MAX_MS);
    let current: MigrationTargetImportView;
    try {
      current = await input.fetchView();
    } catch (error) {
      if (!isTransientMigrationStepFailure(error) || nowMs() + delayMs > retryUntilMs) throw error;
      continue;
    }
    if (MIGRATION_TARGET_STEP_APPLIED_STATES[input.step].includes(current.state)) return current;
    // Never adopt a generation this run did not start with: a changed
    // generation means the run was superseded (canceled, re-provisioned), and
    // retrying under the new one would bypass the stale-generation guard.
    if (current.migrationGeneration !== input.body.migrationGeneration) {
      throw new Error("MIGRATION_TARGET_STEP_GENERATION_SUPERSEDED");
    }
  }
}

function migrationTransferFailureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 500);
}

export function migrationTransferFailureCode(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : String(err);
  const code = /^(MIGRATION_[A-Z0-9_]+)/.exec(message)?.[1];
  return code && RESUMABLE_MIGRATION_SPECIFIC_ERROR_CODES.has(code) ? code : undefined;
}

/**
 * Best-effort, non-secret classification of any transfer failure. `code` above
 * stays limited to the codes older servers understand; this is sent alongside
 * as `detailCode` so the server can keep the real cause instead of collapsing
 * everything else into MIGRATION_TRANSPORT_LOST.
 */
export function migrationTransferFailureDetailCode(err: unknown): string | undefined {
  const known = migrationTransferFailureCode(err);
  if (known) return known;
  if (err instanceof MigrationStepResponseError) {
    return `${err.errorCode}:${err.httpStatus}:${err.upstreamErrorCode}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  const prefixed = /^(MIGRATION_[A-Z0-9_]+(?::[0-9]{3}(?::[A-Za-z0-9_]+)?)?)/.exec(message)?.[1];
  if (prefixed) return prefixed.slice(0, 160);
  if (!(err instanceof Error)) return undefined;
  const nodeCode = systemErrorCode(err) ?? systemErrorCode((err as { cause?: unknown }).cause);
  if (nodeCode) return err.message === "fetch failed" ? `FETCH_${nodeCode}` : `NODE_${nodeCode}`;
  if (err.message === "fetch failed") return "FETCH_FAILED";
  return /^[A-Za-z]{1,40}$/.test(err.name) ? `JS_${err.name}` : undefined;
}

function systemErrorCode(value: unknown): string | null {
  const code = value && typeof value === "object" ? (value as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^E[A-Z0-9_]{1,40}$/.test(code) ? code : null;
}

const RESUMABLE_MIGRATION_SPECIFIC_ERROR_CODES = new Set([
  "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
  "MIGRATION_WORKSPACE_ALREADY_EXISTS",
  "MIGRATION_WORKSPACE_COMPLETE_OLD_COPY",
  "MIGRATION_CHUNK_DIGEST_MISMATCH",
  "MIGRATION_WHOLE_BUNDLE_DIGEST_MISMATCH",
  "MIGRATION_LEASE_EXPIRED",
  "MIGRATION_GENERATION_STALE",
  "MIGRATION_CONTROL_MANIFEST_INVALID",
  "MIGRATION_CONTROL_MANIFEST_TOO_LARGE",
  "MIGRATION_TRANSFER_SUMMARY_CONFLICT",
]);

function normalizeResumableMigrationSpecificErrorCode(value: string): string | null {
  const normalized = value.toUpperCase();
  return RESUMABLE_MIGRATION_SPECIFIC_ERROR_CODES.has(normalized) ? normalized : null;
}

type MigrationTraceStage =
  | "lease"
  | "source_quiesce"
  | "control_register"
  | "control_wait"
  | "chunk_plan"
  | "chunk_upload"
  | "chunk_download"
  | "chunk_receipt"
  | "upload_complete"
  | "arrival_report"
  | "cancel_cleanup"
  | "transport_lost_report"
  | "verify"
  | "unpack"
  | "commit"
  | "transfer";

class MigrationStepResponseError extends Error {
  constructor(
    readonly errorCode: string,
    readonly stage: MigrationTraceStage,
    readonly httpStatus: number,
    readonly upstreamErrorCode: string,
    messageSuffix: string,
  ) {
    super(
      RESUMABLE_MIGRATION_SPECIFIC_ERROR_CODES.has(errorCode)
        ? errorCode
        : `${errorCode}:${httpStatus}:${messageSuffix}`,
    );
    this.name = "MigrationStepResponseError";
  }
}

type MigrationStepResponseDiagnostics = {
  messageSuffix: string;
  upstreamErrorCode: string;
};

function normalizeMigrationUpstreamErrorCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^(?:migration_[a-z0-9_]{1,110}|MIGRATION_[A-Z0-9_]{1,110})$/.test(normalized)
    ? normalized
    : null;
}

async function migrationStepResponseDiagnostics(
  response: Response,
): Promise<MigrationStepResponseDiagnostics> {
  try {
    const body = await response.clone().json() as { code?: unknown; error?: unknown };
    const upstreamErrorCode = normalizeMigrationUpstreamErrorCode(body.code);
    if (upstreamErrorCode) {
      return { messageSuffix: upstreamErrorCode, upstreamErrorCode };
    }
    if (typeof body.error === "string" && body.error.length > 0) {
      return {
        messageSuffix: "upstream_error",
        upstreamErrorCode: `http_${response.status}`,
      };
    }
  } catch {
    // Fall through to the bounded HTTP classification.
  }
  return {
    messageSuffix: "http_error",
    upstreamErrorCode: `http_${response.status}`,
  };
}

async function migrationStepResponseError(
  errorCode: string,
  response: Response,
  stage: MigrationTraceStage,
): Promise<Error> {
  const diagnostics = await migrationStepResponseDiagnostics(response);
  const specific = normalizeResumableMigrationSpecificErrorCode(diagnostics.messageSuffix);
  return new MigrationStepResponseError(
    specific ?? errorCode,
    stage,
    response.status,
    diagnostics.upstreamErrorCode,
    diagnostics.messageSuffix,
  );
}

function migrationObjectStoreFailureTraceAttrs(err: unknown): Record<string, unknown> {
  if (err instanceof MigrationStepResponseError) {
    return {
      stage: err.stage,
      error_code: err.errorCode,
      upstream_error_code: err.upstreamErrorCode,
      http_status: err.httpStatus,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    stage: "transfer",
    error_code: /^(MIGRATION_[A-Z0-9_]+)/.exec(message)?.[1],
  };
}

function migrationTraceIdentityAttrs(
  lease: AgentMigrationTransportLeaseMessage,
  stage: MigrationTraceStage,
): Record<string, unknown> {
  return {
    migration_ref: lease.migrationRef,
    role: lease.role,
    transfer_kind: lease.transferKind,
    stage,
  };
}

/**
 * Runs `work` over `items` with at most `limit` in flight. After the first
 * failure no new item starts; in-flight items settle, then that failure throws.
 */
async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  // Cast so TypeScript does not narrow to null: workers assign it inside closures.
  let failure = null as { error: unknown } | null;
  const worker = async () => {
    while (!failure && next < items.length) {
      const item = items[next++]!;
      try {
        await work(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
}

function migrationObjectStoreBundleSizeBucket(bytes: number): string {
  if (bytes < 1024 * 1024) return "lt_1_mib";
  if (bytes < 16 * 1024 * 1024) return "1_to_16_mib";
  if (bytes < 128 * 1024 * 1024) return "16_to_128_mib";
  if (bytes < 512 * 1024 * 1024) return "128_to_512_mib";
  if (bytes < 1024 * 1024 * 1024) return "512_mib_to_1_gib";
  if (bytes < 3 * 1024 * 1024 * 1024) return "1_to_3_gib";
  return "gte_3_gib";
}

async function migrationStepErrorSuffix(response: Response): Promise<string> {
  return (await migrationStepResponseDiagnostics(response)).messageSuffix;
}

declare const __RAFT_DAEMON_VERSION__: string | undefined;

const MODEL_CATALOG_RECONNECT_MIN_INTERVAL_MS = 30 * 60_000;
/**
 * Floor between the STARTS of two connect-triggered rounds, complete or not. A
 * connection that flaps faster than a round can finish (task #354: a reconnect
 * every ~21 s for two hours) never completes one, so the completion-based
 * throttle alone would re-spawn every runtime CLI on every reconnect.
 */
const MODEL_CATALOG_RECONNECT_MIN_START_INTERVAL_MS = 5 * 60_000;
const MODEL_CATALOG_MAX_MODELS = 300;
const MODEL_CATALOG_MAX_ID_LENGTH = 200;
const MODEL_CATALOG_MAX_LABEL_LENGTH = 80;
const CATALOG_CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Labels come straight from each runtime CLI's output, so bound what crosses the
 * wire: at most MODEL_CATALOG_MAX_MODELS entries, control characters stripped,
 * labels trimmed to MODEL_CATALOG_MAX_LABEL_LENGTH. An entry whose id is empty,
 * too long or has control characters is dropped (an id is an identity, not
 * display text, so it is never rewritten); an empty label falls back to the id.
 */
export function sanitizeCatalogModels(
  models: ReadonlyArray<{ id: string; label: string }>,
): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  for (const model of models) {
    if (out.length >= MODEL_CATALOG_MAX_MODELS) break;
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id || id.length > MODEL_CATALOG_MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(id)) continue;
    const label = (typeof model.label === "string" ? model.label : "").replace(CATALOG_CONTROL_CHARS, "").trim();
    out.push({ id, label: (label || id).slice(0, MODEL_CATALOG_MAX_LABEL_LENGTH) });
  }
  return out;
}

export interface DaemonCoreOptions {
  serverUrl: string;
  apiKey: string;
  daemonVersion?: string;
  computerVersion?: string | null;
  slockCliPath?: string;
  dataDir?: string;
  /** Test/embedded override; production resolves the canonical Raft home. */
  slockHome?: string;
  machineStateDir?: string;
  /** RFC 071 outbox directory (default: `<agents data dir>/.runtime-outcome-outbox`). */
  runtimeOutcomeOutboxDir?: string;
  /** Tests only: the durable-write steps of the outbox. */
  runtimeOutcomeOutboxFs?: OutboxFs;
  machineOwnerProvenance?: DaemonMachineOwnerProvenance;
  hostname?: string;
  osDescription?: string;
  runtimeDetector?: () => RuntimeDetection;
  connectionOptions?: Partial<Pick<ConnectionOptions, "inboundWatchdogMs" | "minReconnectDelayMs" | "wsFactory" | "proxyEnv" | "clock">>;
  connectionFactory?: (options: ConnectionOptions) => DaemonConnection;
  agentManagerFactory?: (
    sendToServer: (msg: MachineToServerMessage) => void,
    daemonApiKey: string,
    options?: { dataDir?: string; serverUrl: string; defaultAgentEnvVarsProvider?: DefaultAgentEnvVarsProvider; slockCliPath?: string; slockHome?: string; tracer?: Tracer; daemonInstanceId?: string; appInboxForAgent?: (agentId: string) => AgentAppInboxStore; runtimeProcessGate?: RuntimeProcessGate },
  ) => AgentProcessManager;
  defaultAgentEnvVarsProvider?: DefaultAgentEnvVarsProvider;
  /** Seam for tests — injected into the ReminderCache so timers can be faked. */
  reminderClock?: Clock;
  tracer?: Tracer;
  localTrace?: boolean;
  localTraceMaxFileBytes?: number;
  localTraceMaxFileAgeMs?: number;
  localTraceMaxFiles?: number;
  lifecycleHooks?: {
    onConnect?: () => void;
    onDisconnect?: () => void;
    onHandshakeRejected?: (event: { statusCode: number; reason: string | null }) => void;
  };
  /** Remote upgrade v2: summary of the last installer receipt, carried on `ready`. */
  getComputerLastUpgradeReceipt?: () => Promise<ComputerLastUpgradeReceipt | null>;
  /** Durable managed-Computer operation acknowledgements waiting for receipt. */
  getComputerLifecycleAcks?: () => ComputerLifecycleExecutionAck[];
  /** Fresh, async machine attestation used only for ready-phase evidence. */
  getComputerLifecycleReadyAcks?: () => Promise<ComputerLifecycleExecutionAck[]>;
  /** Remove one phase only after the server confirms it was reduced. */
  onComputerLifecycleReceipt?: (operationId: string, phase: "shutdown" | "ready") => void | Promise<void>;
  /**
   * Runs after the first ready is written on this connection. A managed
   * Computer may durably adopt one exact legacy K receipt. A narrowly typed
   * ready-pending result is retried on this connection generation only;
   * adoption asks core to replay ready with the new acknowledgement.
   * Booleans remain accepted for older embedded callers.
   */
  reconcileComputerLifecycleOrigin?: () =>
    ComputerLifecycleOriginReconcileResult
    | Promise<ComputerLifecycleOriginReconcileResult>;
  /**
   * Hook for managed-Computer remote control. When this runner is launched
   * by a Computer service, the service passes this so a `computer:restart`
   * / `computer:upgrade` WS command is relayed to the Computer supervisor's
   * restart/upgrade IPC mutation.
   * Absent for a raw daemon → those commands are ignored (no-op).
   *
   * For `upgrade`, the handler receives a `ComputerControlContext` carrying
   * the triggering `requestId` and upstream emitters. The managed runner is a
   * transport relay only: its supervisor owns download/swap/restart and emits
   * progress back over local IPC for this live WS. On success the replacement
   * runner used to report `done` here; v2 reads the reconnect version instead. On failure the
   * relay reports `done{ok:false}` in place.
   */
  onComputerControl?: (action: "restart" | "upgrade", ctx: ComputerControlContext) => void | Promise<void>;
  /**
   * Advertise only when machine-wide controls relay to the Computer
   * supervisor. Older Computer builds handled the same wire command inside a
   * single runner and must not be mistaken for this stronger contract.
   */
  computerControlViaSupervisor?: boolean;
  /** Report a persisted restart request only after this new runner generation
   * has connected and sent ready. The hook owns marker read/clear. */
  onComputerRestartReconcile?: (
    emitDone: (done: { requestId: string; ok: boolean; error?: string }) => void,
  ) => void | Promise<void>;
  /** Test seam; production collectors keep credentials and raw provider responses local. */
  runtimeAccountUsageCollector?: RuntimeAccountUsageCollector;
}

export type ComputerLifecycleOriginReconcileResult =
  | boolean
  | { status: "adopted"; operationId: string }
  | {
      status: "retryable_ready_pending";
      operationId: string;
      code: "computer_offline" | "computer_lifecycle_completion_ready_pending";
    }
  | { status: "not_adopted" };

const COMPUTER_LIFECYCLE_ORIGIN_RECONCILE_MAX_ATTEMPTS = 3;
const COMPUTER_LIFECYCLE_ORIGIN_RECONCILE_RETRY_MS = 50;

/**
 * Context handed to `onComputerControl`. For `upgrade` it carries the exact
 * target; the Computer launches the installer and reports nothing (v2).
 */
export interface ComputerControlContext {
  /** Canonical lifecycle operation identifier. */
  operationId?: string;
  /** Remote upgrade v2: exact target the Server resolved; the installer runs against it. */
  targetVersion?: string;
  /** Echoes the triggering `computer:upgrade{requestId}`; undefined if the
   *  command carried none. */
  requestId?: string;
}

export interface MigrationTargetImportView {
  migrationId: string;
  migrationRef: string;
  migrationGeneration: string;
  state: string;
  sourceMachineId: string;
  targetMachineId: string;
  agentId: string;
  manifestPath: string | null;
  manifestSha256: string | null;
  canDriveTargetImport: true;
}

type AgentMigrationCancelMessage = Extract<ServerToMachineMessage, { type: "machine:migration:cancel" }>;

interface MigrationTransferRunState {
  lease: AgentMigrationTransportLeaseMessage;
  controller: AbortController;
  promise: Promise<void>;
  workspacePlacementStarted: boolean;
  workspacePlaced: boolean;
  flipCommitted: boolean;
}

interface MigrationCancellationMarker {
  schemaVersion: "agent-migration-cancel/v1";
  agentId: string;
  migrationId: string;
  migrationRef: string;
  transportGeneration: string;
  sessionId: string;
  finalWorkspacePath: string;
  workspacePlacementStarted: boolean;
  workspacePlaced: boolean;
  flipCommitted: boolean;
}

interface AppliedMigrationCancellationReceipt {
  schemaVersion: "agent-migration-cancel-receipt/v1";
  agentId: string;
  migrationId: string;
  migrationRef: string;
  transportGeneration: string;
  cancelGeneration: string;
  role: "source" | "target";
  outcome: "cleaned" | "stopped";
}

export function parseDaemonCliArgs(args: string[]): ParsedDaemonCliArgs | null {
  let serverUrl = "";
  let apiKey = "";
  let apiKeyFile = process.env.SLOCK_DAEMON_API_KEY_FILE ?? "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--server-url" && args[i + 1]) serverUrl = args[++i];
    if (args[i] === "--api-key" && args[i + 1]) apiKey = args[++i];
    if (args[i] === "--api-key-file" && args[i + 1]) apiKeyFile = args[++i];
  }

  if (!apiKey && apiKeyFile) {
    try {
      apiKey = readSecretFileSync(apiKeyFile);
    } catch {
      apiKey = "";
    }
  }

  if (!serverUrl || !apiKey) return null;
  return { serverUrl, apiKey };
}

function readBakedDaemonVersion(): string | undefined {
  return typeof __RAFT_DAEMON_VERSION__ === "string" ? __RAFT_DAEMON_VERSION__ : undefined;
}

export function readDaemonVersion(
  moduleUrl: string = import.meta.url,
  bakedVersion: unknown = readBakedDaemonVersion(),
): string {
  // Computer SEA builds inline daemon core and have no daemon package.json at
  // runtime. The native bundler replaces an otherwise-absent identifier with
  // the daemon package version. Runtime environment variables cannot override
  // the package or baked process identity.
  const baked = bakedVersion;
  if (typeof baked === "string" && baked.length > 0) return baked;
  try {
    const require = createRequire(moduleUrl);
    return require("../package.json").version as string;
  } catch {
    return "0.0.0-dev";
  }
}

/**
 * Resolve the absolute path to the bundled `slock` cli entry script.
 * The CLI dist is copied into the daemon's own dist/cli/ during build,
 * so it ships inside the daemon package — no external @botiverse/raft
 * resolution needed at install time. This path is injected into agent
 * processes as `SLOCK_CLI_BIN` so the agent can invoke it via Bash
 * without depending on PATH.
 */
export function resolveRaftCliPath(moduleUrl: string = import.meta.url): string {
  const thisDir = path.dirname(fileURLToPath(moduleUrl));
  const bundledDistPath = path.resolve(thisDir, "cli", "index.js");

  try {
    accessSync(bundledDistPath);
    return bundledDistPath;
  } catch {
    const workspaceDistPath = path.resolve(thisDir, "..", "..", "cli", "dist", "index.js");
    accessSync(workspaceDistPath);
    return workspaceDistPath;
  }
}

/**
 * Non-fatal wrapper around {@link resolveRaftCliPath} for the constructor's
 * eager resolution. Returns "" when the CLI dist can't be located on disk
 * (e.g. SEA single-binary), deferring the hard requirement to agent-spawn time
 * where cliTransport throws a precise "slockCliPath is required" error. Lets
 * the daemon construct + connect + report ready regardless.
 */
export function resolveRaftCliPathOrEmpty(moduleUrl: string = import.meta.url): string {
  try {
    return resolveRaftCliPath(moduleUrl);
  } catch {
    return "";
  }
}

/**
 * Run the bundled `slock` CLI in-process with `argv` as its arguments.
 *
 * The busybox/self-re-exec answer to "how does an agent call `slock` on a SEA
 * single-binary Computer". A SEA binary can't spawn `node <cli-script>` (no
 * node, no sidecar script), so instead the SEA binary re-execs itself in a CLI
 * mode (`<exe> __cli <args>`) and this runs the CLI it bundled. The CLI entry
 * runs `program.parseAsync(process.argv)` on import, so we rewrite argv to look
 * like a normal `slock <args>` invocation and then load it. A fresh process is
 * spawned per agent `slock` call (the cliTransport wrapper execs `<exe> __cli`),
 * so there is no module-cache reuse concern. Importing the entry here also pulls
 * the CLI into the SEA bundle's import graph (it is otherwise only referenced by
 * path via {@link resolveRaftCliPath} and would not be embedded).
 */
export async function runBundledRaftCli(argv: string[]): Promise<void> {
  process.argv = [process.execPath, "slock", ...argv];
  // Static specifier (so esbuild embeds the CLI into the SEA bundle), but the
  // CLI dist ships no .d.ts beside index.js → TS7016. It is a side-effecting
  // "run the CLI" import, not a typed module.
  // @ts-expect-error - untyped CLI entry; importing it runs program.parseAsync.
  await import("@botiverse/raft/dist/index.js");
}

export function detectRuntimes(tracer: Tracer = noopTracer): RuntimeDetection {
  const ids: string[] = [];
  const versions: Record<string, string> = {};
  const diagnostics: Record<string, string> = {};
  const span = tracer.startSpan("daemon.runtime.detect", {
    surface: "daemon",
    kind: "internal",
    attrs: {
      known_runtime_count: RUNTIMES.length,
    },
  });

  for (const runtime of RUNTIMES) {
    const driver = getDriver(runtime.id);
    let probeErrorPresent = false;
    try {
      if (driver.probe) {
        const probe = driver.probe();
        if (!probe.available) {
          if (probe.version) versions[runtime.id] = probe.version;
          if (probe.diagnostic) diagnostics[runtime.id] = probe.diagnostic;
          span.addEvent("daemon.runtime.detect.checked", {
            runtime: runtime.id,
            outcome: "unavailable",
            version_present: Boolean(probe.version),
            diagnostic_present: Boolean(probe.diagnostic),
            ...(probe.diagnostic ? { diagnostic: probe.diagnostic } : {}),
            binary_path_present: false,
          });
          continue;
        }
        ids.push(runtime.id);
        if (probe.version) versions[runtime.id] = probe.version;
        if (probe.diagnostic) diagnostics[runtime.id] = probe.diagnostic;
        span.addEvent("daemon.runtime.detect.checked", {
          runtime: runtime.id,
          outcome: "available",
          version_present: Boolean(probe.version),
          diagnostic_present: Boolean(probe.diagnostic),
          ...(probe.diagnostic ? { diagnostic: probe.diagnostic } : {}),
          binary_path_present: false,
        });
        continue;
      }
    } catch {
      // Fall through to legacy PATH probing. Detection should be best-effort.
      probeErrorPresent = true;
    }

    const detectionBinaries = [runtime.binary];
    let detectedByPath = false;
    for (const binary of detectionBinaries) {
      const resolved = resolveCommandOnPath(binary);
      if (!resolved) continue;

      ids.push(runtime.id);
      detectedByPath = true;
      const version = readCommandVersion(binary);
      if (version) {
        versions[runtime.id] = version;
      }
      span.addEvent("daemon.runtime.detect.checked", {
        runtime: runtime.id,
        outcome: "available",
        version_present: Boolean(version),
        binary_path_present: true,
        probe_error_present: probeErrorPresent,
      });
      break;
    }
    if (!detectedByPath) {
      span.addEvent("daemon.runtime.detect.checked", {
        runtime: runtime.id,
        outcome: "unavailable",
        version_present: false,
        binary_path_present: false,
        probe_error_present: probeErrorPresent,
      });
    }
  }

  span.end("ok", {
    attrs: {
      detected_runtime_count: ids.length,
    },
  });
  return { ids, versions, ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}) };
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function formatChannelTarget(msg: ServerToMachineMessage & { type: "agent:deliver" }): string {
  return msg.message.channel_type === "dm"
    ? `dm:@${msg.message.channel_name}`
    : `#${msg.message.channel_name}`;
}

function summarizeIncomingMessage(msg: ServerToMachineMessage): string {
  switch (msg.type) {
    case "machine:context":
      return `(machine=${msg.machineId}, server=${msg.serverId})`;
    case "agent:start":
      return `(agent=${msg.agentId}, runtime=${msg.config.runtime}, model=${msg.config.model}, session=${msg.config.sessionId || "new"}${msg.wakeMessage ? ", wake=true" : ""})`;
    case "agent:start:wiki":
      return `(agent=${msg.agentId}, runtime=${msg.config.runtime}, model=${msg.config.model}, session=${msg.config.sessionId || "new"}, wikiPack=${msg.wikiWorkspacePack.packId.slice(0, 12)}${msg.wakeMessage ? ", wake=true" : ""})`;
    case "agent:stop":
      return `(agent=${msg.agentId})`;
    case "agent:wake:outcome":
      return `(agent=${msg.agentId}, wake=${msg.wakeRequestId.slice(0, 8)}, outcome=${msg.outcome}${msg.reason ? `, reason=${msg.reason}` : ""})`;
    case "agent:reset-workspace":
      return `(agent=${msg.agentId})`;
    case "agent:deliver":
      return `(agent=${msg.agentId}, seq=${msg.seq}, from=@${msg.message.sender_name}, target=${formatChannelTarget(msg)})`;
    case "agent:inbox:purge":
      return `(agent=${msg.agentId}, channels=${msg.channelIds.length}, reason=${msg.reason || "server_purge"})`;
    case "agent:runtime_profile:migration":
      return `(agent=${msg.agentId}, migration=${msg.migrationKey})`;
    case "agent:runtime_profile:daemon_release_notice":
      return `(agent=${msg.agentId}, notice=${msg.noticeKey})`;
    case "agent:workspace:list":
      return `(agent=${msg.agentId}, dir=${msg.dirPath || "."}, hidden=${msg.includeHidden ? "yes" : "no"})`;
    case "agent:workspace:read":
      return `(agent=${msg.agentId}, path=${msg.path})`;
    case "agent:workspace:ensure-wiki":
      return `(agent=${msg.agentId}, pack=${msg.pack.packId.slice(0, 12)})`;
    case "agent:skills:list":
      return `(agent=${msg.agentId}, runtime=${msg.runtime || "auto"}, req=${msg.requestId || "legacy"})`;
    case "agent:diagnostic:session_transcript":
      return `(agent=${msg.agentId})`;
    case "agent:diagnostic:feedback_transcript":
      return `(agent=${msg.agentId}, feedbackReportId=${msg.feedbackReportId})`;
    case "agent:activity_probe":
      return `(agent=${msg.agentId}, probe=${msg.probeId.slice(0, 8)}, purpose=${msg.purpose})`;
    case "machine:workspace:delete":
      return `(directory=${msg.directoryName})`;
    case "machine:runtime_models:detect":
      return `(runtime=${msg.runtime}, req=${msg.requestId})`;
    case "machine:runtime_account_usage:refresh":
      return `(provider=${msg.provider}, reason=${msg.reason}, req=${msg.requestId})`;
    case "machine:runtimes:rescan":
      return "(rescan runtimes)";
    case "machine:migration:source_workspace_archive":
      return `(agent=${msg.agentId}, migration=${msg.migrationId})`;
    case "machine:migration_transport:lease":
      return `(agent=${msg.agentId}, migration_ref=${msg.migrationRef}, session=${msg.sessionId}, provider=${msg.provider}, role=${msg.role}, kind=${msg.transferKind})`;
    case "machine:migration:cancel":
      return `(agent=${msg.agentId}, migration_ref=${msg.migrationRef}, role=${msg.role}, disposition=${msg.disposition})`;
    case "reminder.upsert":
      return `(agent=${msg.agentId}, id=${msg.reminder.reminderId}, v${msg.reminder.version}, fireAt=${msg.reminder.fireAt})`;
    case "reminder.cancel":
      return `(agent=${msg.agentId}, id=${msg.reminderId}, v${msg.version})`;
    case "reminder.snapshot":
      return `(agent=${msg.agentId}, count=${msg.reminders.length})`;
    default:
      return "";
  }
}

type AgentStartMessage =
  | Extract<ServerToMachineMessage, { type: "agent:start" }>
  | Extract<ServerToMachineMessage, { type: "agent:start:wiki" }>;
type AgentDeliverMessage = Extract<ServerToMachineMessage, { type: "agent:deliver" }>;
type AgentStartAckMessage = Extract<MachineToServerMessage, { type: "agent:start:ack" }>;

/** RFC 071 outbox: the daemon refused this start locally; no process was created. */
class LocalStartRefusedError extends Error {
  constructor(readonly reason: AgentStartNotSpawnedReason) {
    super(reason === "terminal_failure_outcome_storage_blocked"
      ? RUNTIME_OUTCOME_STORAGE_BLOCKED_TEXT
      : AUTOMATIC_START_REFUSAL_TEXT);
    this.name = "LocalStartRefusedError";
  }
}

/**
 * Which buffered delivery may be promoted to the START WAKE MESSAGE, or -1 for none.
 *
 * A mention delivery must NEVER be chosen. The chosen delivery is SPLICED OUT of the replay list,
 * so it never passes through handleMessage — and handleMessage is where the mention occurrence
 * transitions (daemon_received / daemon_pending / daemon_drained) are emitted. A mention promoted
 * to wake message would therefore complete delivery while its occurrence stayed at
 * "recorded, never delivered": precisely the unrecoverable state this whole spine exists to remove.
 * Excluding mentions here is what keeps them on the instrumented path, not what withholds them —
 * they are still replayed, and the agent still starts, because agent:start is what triggers the
 * start, not the presence of a wake message.
 *
 * Extracted as a pure exported function on 2026-08-20 so it can be tested at all. @Hipp found
 * during review of #6700 that this clause was load-bearing and had NO test: deleting
 * `&& !delivery.mentionDelivery` would silently make mentions unrecoverable and nothing would go
 * red. It was untestable in place because reaching it needs a timing race against agent start,
 * and a flaky test here would be worse than none.
 */
export function selectWakeDeliveryIndex(deliveries: readonly AgentDeliverMessage[]): number {
  return deliveries.findIndex((delivery) => delivery.transient !== true && !delivery.mentionDelivery);
}

export class DaemonCore {
  private readonly options: DaemonCoreOptions;
  private readonly daemonVersion: string;
  private readonly daemonInstanceId = randomUUID();
  // When this runner is launched by a managed Computer service, the service
  // passes the Computer bundle version explicitly. Reported in `ready` so the
  // server can surface it distinctly from the underlying daemonVersion.
  private readonly computerVersion: string | null;
  private readonly slockCliPath: string;
  private readonly slockHome: string;
  /**
   * Archive requests are retried by the server (and a cross-disk copy can
   * outlive the server's 15s wait), so a retry for the same agent joins the
   * in-flight run instead of starting a second copy beside it.
   */
  private readonly migrationSourceArchiveRuns = new Map<string, {
    migrationId: string;
    run: Promise<AgentMigrationWorkspaceArchiveOutcome>;
  }>();
  private readonly agentsDataDir: string;
  // One-shot guard: rewrite stale per-agent opencli wrappers to the current
  // self-healing form on the first connect of this daemon process (a SEA
  // computer switch / daemon upgrade restarts the daemon → triggers this).
  private opencliWrappersRegenerated = false;
  private readonly runtimeDetector: () => RuntimeDetection;
  private readonly agentManager: AgentProcessManager;
  private readonly connection: DaemonConnection;
  private readonly runtimeOutcomeOutbox: RuntimeOutcomeOutbox;
  /** RFC 071 outbox: whether the current connection's server acknowledges outbox frames. */
  private serverAcksRuntimeOutcomes = false;
  /** RFC 071 outbox: `breakerGeneration` per accepted launch, echoed as `generation` (bounded per agent). */
  private readonly launchGenerations = new Map<string, Map<string, number>>();
  private readonly appScheduleClock: Clock;
  private readonly lifecycleOriginClock: Clock;
  private lifecycleOriginConnectionGeneration = 0;
  /** Runtimes from the last `ready`; the catalog push covers exactly these. */
  private lastReadyRuntimes: readonly string[] = [];
  /** Runtime ids + versions from the last `ready`; a change lifts the reconnect throttle. */
  private lastReadyRuntimeSignature = "";
  private catalogPublishInFlight = false;
  private catalogPublishQueued: { force: boolean } | null = null;
  private lastCatalogPublish: { atMs: number; runtimeSignature: string } | null = null;
  private lastCatalogRoundStartMs: number | null = null;
  private lifecycleOriginRetryTimer: unknown = null;
  private readonly localScheduleRuntime: ReturnType<typeof createBuiltInLocalScheduleRuntime>;
  private readonly appInboxes = new Map<string, AgentAppInboxStore>();
  private migrationTransferLease: AgentMigrationTransportLeaseMessage | null = null;
  private readonly migrationTransferRuns = new Map<string, MigrationTransferRunState>();
  private tracer: Tracer;
  private readonly injectedTracer: boolean;
  private machineLock: DaemonMachineLockHandle | null = null;
  private observedServerId: string | null = null;
  private observedMachineId: string | null = null;
  private authenticatedMachineContext: { serverId: string; machineId: string } | null = null;
  private scopedAppStorageFactory: ScopedAppStorageFactory | null = null;
  private scopedAppStorageObserver: ScopedAppStorageObserver | null = null;
  private machineContextConflict = false;
  private localTraceSink: LocalRotatingTraceSink | null = null;
  private traceBundleUploader: DaemonTraceBundleUploader | null = null;
  private diskJanitor: { stop(): void } | null = null;
  private raftDiskFootprint: { atMs: number; value: Promise<RaftDiskFootprint> } | null = null;
  private diskStatusTimer: ReturnType<typeof setTimeout> | null = null;
  private diskStatusReportsEnabled = true;
  private readonly coreStartingAgentIds = new Set<string>();
  private readonly coreStartPendingDeliveries = new Map<string, AgentDeliverMessage[]>();
  private readonly acceptedStartDispatches = new Map<string, AgentStartAckMessage>();
  private readonly acceptingStartDispatches = new Map<string, Promise<AgentStartAckMessage>>();
  private readonly handledComputerControlOperationIds = new Set<string>();
  private readonly runtimeAccountUsageCollector: RuntimeAccountUsageCollector;
  /** Overlapping model / usage probes for the same key join one run instead of each spawning a CLI (probeGate.ts). Uncapped across keys so no probe waits past the server's request budget. */
  private readonly probeGate = new ProbeGate();
  private static readonly START_DISPATCH_RECEIPT_CACHE_SIZE = 1_024;

  constructor(options: DaemonCoreOptions) {
    this.options = options;
    this.daemonVersion = options.daemonVersion ?? readDaemonVersion();
    this.computerVersion = options.computerVersion?.trim() || null;
    // Resolve eagerly but NON-FATALLY: the slock CLI path is only needed when
    // an agent actually spawns (cliTransport injects it + throws a clear error
    // if empty). A daemon must still be able to construct + connect + report
    // ready when the CLI dist isn't a resolvable sidecar file — e.g. a SEA
    // single-binary where the CLI is bundled into the executable, not on disk.
    // Crashing the whole runner at construction (pre-connect) was wrong.
    this.slockCliPath = options.slockCliPath ?? resolveRaftCliPathOrEmpty();
    this.slockHome = options.slockHome ? path.resolve(options.slockHome) : resolveRaftHome();
    if (!options.slockHome) process.env[SLOCK_HOME_ENV] = this.slockHome;
    this.injectedTracer = Boolean(options.tracer);
    this.tracer = this.withDaemonTraceScope(options.tracer ?? noopTracer);
    this.runtimeDetector = options.runtimeDetector ?? (() => detectRuntimes(this.tracer));
    this.runtimeAccountUsageCollector = options.runtimeAccountUsageCollector
      ?? createRuntimeAccountUsageCollector({
        localAccountSlot: this.slockHome,
        collectorVersion: this.daemonVersion,
        now: currentTimeMs,
      });
    this.appScheduleClock = options.reminderClock ?? systemClock;
    this.lifecycleOriginClock = options.connectionOptions?.clock ?? systemClock;

    let connection!: DaemonConnection;

    this.agentsDataDir = options.dataDir ?? resolveRaftHomePath("agents", this.slockHome);
    const traceUploadDisabled = !DISTRIBUTION_POLICY.diagnosticUploads
      || process.env.SLOCK_DAEMON_TRACE_UPLOAD_DISABLED === "1";
    const agentManagerOptions = {
      dataDir: this.agentsDataDir,
      serverUrl: options.serverUrl,
      defaultAgentEnvVarsProvider: options.defaultAgentEnvVarsProvider,
      slockCliPath: this.slockCliPath,
      slockHome: this.slockHome,
      tracer: this.tracer,
      daemonVersion: this.daemonVersion,
      daemonInstanceId: this.daemonInstanceId,
      computerVersion: this.computerVersion,
      workerUrl: traceUploadDisabled ? undefined : (process.env.SLOCK_DAEMON_TRACE_UPLOAD_URL || DEFAULT_TRACE_UPLOAD_URL),
      serverConnected: () => connection?.connected ?? false,
      appInboxForAgent: (agentId: string) => this.getAgentAppInbox(agentId),
      // RFC 071 outbox: every spawn/rebind first durably records the process as open.
      runtimeProcessGate: {
        openProcess: (agentId: string, processInstanceId: string, spawnLaunchId: string | null) =>
          this.runtimeOutcomeOutbox.openProcess(agentId, processInstanceId, spawnLaunchId),
        processExitedLocally: (agentId: string, processInstanceId: string) =>
          this.runtimeOutcomeOutbox.processExitedLocally(agentId, processInstanceId),
        processNotStarted: (agentId: string, processInstanceId: string) =>
          this.runtimeOutcomeOutbox.processNotStarted(agentId, processInstanceId),
        startRefusal: (agentId: string, launchId: string | null, recoveryGrant: RecoveryGrant | null) =>
          this.runtimeOutcomeOutbox.startDecision(agentId, launchId, recoveryGrant),
        waitForCapability: () => this.runtimeOutcomeOutbox.waitForCapability(),
      },
    };

    this.runtimeOutcomeOutbox = new RuntimeOutcomeOutbox({
      dir: options.runtimeOutcomeOutboxDir ?? path.join(this.agentsDataDir, RUNTIME_OUTCOME_OUTBOX_DIR_NAME),
      daemonInstanceId: this.daemonInstanceId,
      send: (msg) => connection.send(msg),
      fs: options.runtimeOutcomeOutboxFs,
      trace: (name, attrs, status) => this.recordDaemonEvent(name, attrs, status),
    });
    // RFC 071: the agent manager's evidence frames go through the durable
    // outbox (write-ahead, stop-and-wait); everything else is sent directly.
    const sendAgentFrame = (msg: MachineToServerMessage) => this.routeAgentManagerFrame(msg, connection);
    this.agentManager = options.agentManagerFactory
      ? options.agentManagerFactory(sendAgentFrame, options.apiKey, agentManagerOptions)
      : new AgentProcessManager(sendAgentFrame, options.apiKey, agentManagerOptions);

    this.localScheduleRuntime = createBuiltInLocalScheduleRuntime({
      agentsDataDir: this.agentsDataDir,
      clock: this.appScheduleClock,
      getInbox: (agentId) => this.getAgentAppInbox(agentId),
      notifyInbox: (agentId, item, notice) =>
        this.agentManager.notifyAgentAppInbox(agentId, item, notice),
      cleanerMeasureRaftDiskFootprint: () => this.measureRaftDiskFootprintCached(),
      send: (message) => connection.send(message),
      trace: (name, attrs, status) =>
        this.recordDaemonEvent(name, { ...attrs }, status),
      // Lazy lookup: this.tracer is replaced once the local trace sink is
      // installed, so the runtime must not capture the startup tracer.
      tracer: {
        startSpan: (name, spanOptions) => this.tracer.startSpan(name, spanOptions),
        emitEvent: (name, eventOptions) => this.tracer.emitEvent(name, eventOptions),
      },
    });

    const connectionFactory = options.connectionFactory ?? ((connOptions: ConnectionOptions) => new DaemonConnection(connOptions));

    connection = connectionFactory({
      serverUrl: options.serverUrl,
      apiKey: options.apiKey,
      ...options.connectionOptions,
      onMessage: (msg) => this.handleMessage(msg),
      onConnect: () => this.handleConnect(),
      onDisconnect: () => this.handleDisconnect(),
      onHandshakeRejected: (event) => this.handleHandshakeRejected(event),
      onTraceEvent: (name, attrs, status, parent) => this.recordDaemonEvent(name, attrs, status, parent),
      // Lazy lookup for the same reason as the app runtime tracer above.
      tracer: {
        startSpan: (name, spanOptions) => this.tracer.startSpan(name, spanOptions),
        emitEvent: (name, eventOptions) => this.tracer.emitEvent(name, eventOptions),
      },
    });

    this.connection = connection;
    this.localScheduleRuntime.start();
  }

  private getAgentAppInbox(agentId: string): AgentAppInboxStore {
    if (this.machineContextConflict) {
      this.recordDaemonEvent("daemon.app_storage.access_denied", {
        app_id: "system.agent-inbox",
        outcome: "denied",
        reason: "machine_context_conflict",
      }, "error");
      throw new Error("agent app inbox unavailable after authenticated machine context conflict");
    }
    const storageFactory = this.scopedAppStorageFactory;
    if (!storageFactory) {
      this.recordDaemonEvent("daemon.app_storage.access_denied", {
        app_id: "system.agent-inbox",
        outcome: "denied",
        reason: "machine_context_missing",
      }, "error");
      throw new Error("agent app inbox unavailable before authenticated machine context");
    }
    let store = this.appInboxes.get(agentId);
    if (!store) {
      const legacyDisposition = storageFactory.quarantineLegacyFile(
        `agent-inbox/${agentId}.json`,
        "system.agent-inbox",
      );
      if (legacyDisposition === "quarantined") {
        this.recordDaemonEvent("daemon.app_storage.legacy_quarantined", {
          app_id: "system.agent-inbox",
          owner_agent_id_present: true,
          reason: "unscoped_owner_unknown",
        }, "error");
      }
      store = createAgentAppInboxStore({
        registry: this.localScheduleRuntime.inboxRegistry,
        storage: storageFactory.open({
          appId: "system.agent-inbox",
          agentId,
        }),
        beforeAck: (item) => this.localScheduleRuntime.beforeAck(agentId, item),
        beforeServerAuthorizedAck: (item) => this.localScheduleRuntime.beforeServerAuthorizedAck(agentId, item),
        ownerAgentId: agentId,
        trace: (name, attrs, status) =>
          this.recordDaemonEvent(name, attrs, status),
      });
      this.appInboxes.set(agentId, store);
    }
    return store;
  }

  private resolveMachineStateRoot(): string {
    if (this.options.machineStateDir) return this.options.machineStateDir;
    if (this.options.dataDir) return path.join(path.dirname(this.options.dataDir), "machines");
    return resolveDefaultMachineStateRoot();
  }

  private shouldEnableLocalTrace(): boolean {
    if (this.injectedTracer) return false;
    if (!this.options.localTrace) return false;
    return process.env.SLOCK_DAEMON_LOCAL_TRACE !== "0";
  }

  private resolveTraceJitter(): TraceJitter {
    if (process.env.SLOCK_DAEMON_TRACE_JITTER_DISABLED === "1") return NO_JITTER;
    const lockId = this.machineLock?.lockId;
    return lockId ? computeTraceJitter(lockId) : NO_JITTER;
  }

  /**
   * Where the Computer redirects this daemon's stdout/stderr
   * (`<home>/computer/servers/<serverId>/runner.log`, legacy
   * `server-runner.log`; see packages/computer/src/paths.ts). Mirrored here
   * rather than imported: the daemon must not depend on the Computer package,
   * and deployed Computers already write these paths, so tier 2 works without
   * a Computer release. Empty until the server has told us which server we
   * are attached to.
   */
  private runnerLogPathCandidates(): string[] {
    const serverId = this.authenticatedMachineContext?.serverId ?? this.observedServerId;
    if (!serverId || !/^[A-Za-z0-9_-]{1,128}$/.test(serverId)) return [];
    const serverDir = path.join(this.slockHome, "computer", "servers", serverId);
    return [path.join(serverDir, "runner.log"), path.join(serverDir, "server-runner.log")];
  }

  private installLocalTraceSink(machineDir: string): void {
    if (!this.shouldEnableLocalTrace()) return;
    const jitter = this.resolveTraceJitter();
    this.localTraceSink = new LocalRotatingTraceSink({
      machineDir,
      maxFileBytes: this.options.localTraceMaxFileBytes ?? readPositiveIntegerEnv("SLOCK_DAEMON_TRACE_MAX_FILE_BYTES", 5 * 1024 * 1024),
      maxFileAgeMs: this.options.localTraceMaxFileAgeMs ?? readPositiveIntegerEnv("SLOCK_DAEMON_TRACE_MAX_FILE_AGE_MS", 5 * 60 * 1000),
      maxFileAgeJitterMs: jitter.maxFileAgeJitterMs,
      maxFiles: this.options.localTraceMaxFiles ?? readPositiveIntegerEnv("SLOCK_DAEMON_TRACE_MAX_FILES", 8),
    });
    this.tracer = this.withDaemonTraceScope(createTraceClient({
      source: "daemon",
      sinks: [this.localTraceSink],
    }));
    this.agentManager.setTracer(this.tracer);
    this.agentManager.setCliTransportTraceDir(path.join(machineDir, "traces"));
    this.agentManager.setMachineDir(machineDir);
  }

  private installTraceBundleUploader(machineDir: string): void {
    if (!DISTRIBUTION_POLICY.diagnosticUploads) return;
    if (!this.shouldEnableLocalTrace()) return;
    if (this.traceBundleUploader) return;

    // Highest priority off-switch: SLOCK_DAEMON_TRACE_UPLOAD_DISABLED=1
    if (process.env.SLOCK_DAEMON_TRACE_UPLOAD_DISABLED === "1") return;

    // Explicit URL override wins; otherwise fall back to the baked default.
    // Self-host / local / staging etc. must use DISABLED=1 to opt out or
    // set their own SLOCK_DAEMON_TRACE_UPLOAD_URL to redirect.
    const workerUrl = process.env.SLOCK_DAEMON_TRACE_UPLOAD_URL || DEFAULT_TRACE_UPLOAD_URL;
    this.traceBundleUploader = new DaemonTraceBundleUploader({
      machineDir,
      serverUrl: this.options.serverUrl,
      apiKey: this.options.apiKey,
      workerUrl,
      tracer: this.tracer,
      currentFileProvider: () => this.localTraceSink?.getCurrentFile() ?? null,
      sinkReportProvider: {
        drain: () => this.localTraceSink?.drainSinkReport() ?? null,
        noteUndelivered: () => this.localTraceSink?.noteAttrDropReportUndelivered(),
      },
      jitter: this.resolveTraceJitter(),
    });
    this.traceBundleUploader.start();
  }

  /**
   * Bounded daily cleanup of Raft Computer's own migration data under
   * SLOCK_HOME (never agent workspaces). Several daemons may share one
   * SLOCK_HOME; every removal is idempotent.
   */
  private installDiskJanitor(): void {
    if (this.diskJanitor || process.env.SLOCK_DAEMON_DISK_JANITOR_DISABLED === "1") return;
    this.diskJanitor = scheduleRaftDiskJanitor({ pass: () => this.runDiskJanitorPass() });
  }

  private async runDiskJanitorPass(): Promise<void> {
    const startedAtMs = currentTimeMs();
    try {
      const result = await runRaftDiskJanitor({ slockHome: this.slockHome });
      for (const removal of result.backupsRemoved) {
        this.recordDaemonEvent("daemon.disk_janitor.backup_removed", {
          owner_agent_id: removal.ownerAgentId,
          backup_kind: removal.backupKind,
          age_days: removal.ageDays,
          freed_bytes: removal.freedBytes,
        });
      }
      // A fresh measurement after the sweep, so reports compare before/after.
      this.raftDiskFootprint = null;
      const footprint = await this.measureRaftDiskFootprintCached();
      this.recordDaemonEvent("daemon.disk_janitor.run", {
        outcome: "ok",
        migration_generations_cleaned: result.migrationGenerationsCleaned,
        migration_freed_bytes: result.migrationFreedBytes,
        backups_removed: result.backupsRemoved.length,
        backups_freed_bytes: result.backupsFreedBytes,
        sweep_outcome: result.sweepOutcome,
        duration_ms: currentTimeMs() - startedAtMs,
        ...footprint,
      });
    } catch (error) {
      this.recordDaemonEvent("daemon.disk_janitor.run", {
        outcome: "failed",
        error_class: errorClassOf(error),
        duration_ms: currentTimeMs() - startedAtMs,
      }, "error");
    }
  }

  /** One bounded walk per hour at most, shared by every caller. */
  private measureRaftDiskFootprintCached(): Promise<RaftDiskFootprint> {
    const nowMs = currentTimeMs();
    if (this.raftDiskFootprint && nowMs - this.raftDiskFootprint.atMs < 60 * 60 * 1_000) {
      return this.raftDiskFootprint.value;
    }
    const value = measureRaftDiskFootprint(this.slockHome);
    this.raftDiskFootprint = { atMs: nowMs, value };
    value.catch(() => {
      if (this.raftDiskFootprint?.value === value) this.raftDiskFootprint = null;
    });
    return value;
  }

  start() {
    logger.info("[Slock Daemon] Starting...");
    // RFC 071: reload un-acked evidence; it is resent with its original identities.
    this.runtimeOutcomeOutbox.load();
    logger.info(`[Slock Daemon] ${SLOCK_HOME_ENV}=${this.slockHome}`);
    for (const legacy of listLegacyRaftStatePaths(this.slockHome)) {
      logger.warn(
        `[Slock Daemon] Legacy Slock state exists outside ${SLOCK_HOME_ENV}: ${legacy.path}. ` +
          `This daemon will use ${legacy.destination}; migrate manually if that ${legacy.description} should move with this installation.`,
      );
    }
    assertLegacyDaemonKeyNotAdoptedByComputer({
      slockHome: this.slockHome,
      apiKey: this.options.apiKey,
    });
    let lifecycleSpan: ActiveSpan | null = null;
    if (!this.machineLock) {
      // The trace sink only exists after the lock is taken, so the start time
      // is captured first and given to the span once the sink is ready.
      const startTimeMs = currentTimeMs();
      this.machineLock = acquireDaemonMachineLock({
        apiKey: this.options.apiKey,
        serverUrl: this.options.serverUrl,
        rootDir: this.resolveMachineStateRoot(),
        ownerProvenance: this.options.machineOwnerProvenance,
      });
      logger.info(`[Slock Daemon] Acquired machine lock: ${this.machineLock.lockDir}`);
      this.installLocalTraceSink(this.machineLock.machineDir);
      this.installTraceBundleUploader(this.machineLock.machineDir);
      this.installDiskJanitor();
      lifecycleSpan = this.tracer.startSpan("daemon.lifecycle.start", {
        surface: "daemon",
        kind: "internal",
        startTimeMs,
        attrs: {
          machine_dir_present: true,
          local_trace_enabled: this.shouldEnableLocalTrace(),
        },
      });
      lifecycleSpan.addEvent("daemon.machine_lock.acquired", { machine_dir_present: true });
    }
    try {
      this.connection.connect();
    } catch (err) {
      lifecycleSpan?.end("error", { attrs: { error_class: errorClassOf(err) } });
      this.traceBundleUploader?.stop();
      this.traceBundleUploader = null;
      this.machineLock.release();
      this.machineLock = null;
      throw err;
    }
    lifecycleSpan?.end("ok");
  }

  async stop() {
    logger.info("[Slock Daemon] Shutting down...");
    const shutdownReason = this.resolveMachineShutdownReason();
    const span = this.tracer.startSpan("daemon.lifecycle.stop", {
      surface: "daemon",
      kind: "internal",
      attrs: {
        machine_lock_present: Boolean(this.machineLock),
        shutdown_reason: shutdownReason,
      },
    });
    this.localScheduleRuntime.stop();
    this.invalidateLifecycleOriginReconcile();
    this.scopedAppStorageObserver?.stop();
    this.scopedAppStorageObserver = null;
    this.traceBundleUploader?.stop();
    this.traceBundleUploader = null;
    this.diskJanitor?.stop();
    this.diskJanitor = null;
    this.diskStatusReportsEnabled = false;
    if (this.diskStatusTimer !== null) clearTimeout(this.diskStatusTimer);
    this.diskStatusTimer = null;
    try {
      // A graceful stop stores every exit (closing the open-launch records) before the outbox stops.
      await this.agentManager.stopAll();
      span.addEvent("daemon.agents.stopped");
    } finally {
      this.runtimeOutcomeOutbox.stop();
      if (this.connection.connected) {
        const lifecycleAcks = this.options.getComputerLifecycleAcks?.()
          .filter((ack) => ack.phase === "shutdown");
        this.connection.send({
          type: "machine:shutdown",
          reason: shutdownReason,
          ...(lifecycleAcks && lifecycleAcks.length > 0 ? { lifecycleAcks } : {}),
        });
        span.addEvent("daemon.connection.shutdown_notice_sent", {
          outcome: "sent",
          shutdown_reason: shutdownReason,
        });
      } else {
        span.addEvent("daemon.connection.shutdown_notice_sent", {
          outcome: "skipped",
          reason: "not_connected",
          shutdown_reason: shutdownReason,
        });
      }
      this.connection.disconnect();
      span.addEvent("daemon.connection.disconnect_requested");
      this.machineLock?.release();
      if (this.machineLock) span.addEvent("daemon.machine_lock.released");
      this.machineLock = null;
      span.end("ok");
    }
  }

  private resolveMachineShutdownReason(): MachineShutdownReason {
    return this.computerVersion ? "computer_stop" : "daemon_stop";
  }

  get connected(): boolean {
    return this.connection.connected;
  }

  getRunningAgentIds(): string[] {
    return this.agentManager.getRunningAgentIds();
  }

  // Records a point in time fact as a trace event. The event attaches to the
  // given parent, or to the span that is active right now.
  private recordDaemonEvent(
    name: string,
    attrs?: Record<string, unknown>,
    status: TraceStatus = "ok",
    parent?: TraceContext | null,
  ): void {
    this.tracer.emitEvent(name, {
      parent: parent ?? getActiveTraceContext(),
      surface: "daemon",
      attrs: { ...attrs, status },
    });
  }

  // Error-system boundary: the handleConnect/emitReady lifecycle hooks are
  // best-effort by design — a failed hook must never suppress the ready
  // report — but the failure's bounded identity still exits through a span
  // (closed site/reason + error_class), never only the logger.
  private recordConnectLifecycleError(site: string, reason: string, error: unknown): void {
    this.recordDaemonEvent("daemon.connect.lifecycle_error", {
      site,
      outcome: "error",
      reason,
      error_class: errorClassOf(error),
    }, "error");
  }

  private getMigrationTransportReady(): AgentMigrationTransportReady {
    return { ...this.getMigrationTransportReadyBase(), activeLeases: this.activeMigrationTransferLeases() };
  }

  /** Resumable transfer runs alive in this process; a restart empties this. */
  private activeMigrationTransferLeases(): NonNullable<AgentMigrationTransportReady["activeLeases"]> {
    const leases = new Map<string, NonNullable<AgentMigrationTransportReady["activeLeases"]>[number]>();
    for (const run of this.migrationTransferRuns.values()) {
      if (!run.lease.transportGeneration || run.controller.signal.aborted) continue;
      const entry = {
        migrationId: run.lease.migrationId,
        transportGeneration: run.lease.transportGeneration,
        role: run.lease.role,
      };
      leases.set(`${entry.migrationId}:${entry.transportGeneration}:${entry.role}`, entry);
    }
    return [...leases.values()];
  }

  private getMigrationTransportReadyBase(): AgentMigrationTransportReady {
    const transferLease = this.getActiveMigrationTransferLease();
    const capabilities = [AGENT_MIGRATION_CAPABILITY];
    if (transferLease) {
      return {
        provisioned: true,
        endpoint: null,
        leaseSource: "server",
        provider: transferLease.provider,
        role: transferLease.role,
        transferKind: transferLease.transferKind,
        expiresAt: transferLease.expiresAt,
        maxBytes: transferLease.maxBytes,
        capabilities,
        observedAt: currentDate().toISOString(),
      };
    }

    return {
      provisioned: false,
      endpoint: null,
      leaseSource: null,
      capabilities,
      observedAt: currentDate().toISOString(),
    };
  }

  /**
   * Computer-scoped provider probe. The command carries no credential: the
   * daemon claims a one-time materialization with its own machine auth, runs
   * the bounded canary through the real provider adapter, and returns a
   * closed-category result. A claim failure still produces a failure result so
   * the Server never waits out the budget for a decidable carrier error.
   */
  private async handleProviderProbe(
    msg: Extract<ServerToMachineMessage, { type: "machine:provider_probe:request" }>,
  ): Promise<void> {
    const probeId = asProviderProbeId(msg.probeId);
    // Wave 1 only knows the Built-in canary adapter; a different runtime label
    // is a protocol violation and must never produce a Built-in receipt (F3).
    if (!isProviderProbeRuntime(msg.runtime)) {
      this.connection.send(await buildUnclaimedProviderProbeResult({
        requestId: msg.requestId,
        probeId,
      }));
      return;
    }
    let materialization: ProbeMaterialization;
    try {
      materialization = await claimProbeMaterialization({
        serverUrl: this.options.serverUrl,
        daemonApiKey: this.options.apiKey,
        probeId,
        claimRequestId: msg.requestId,
      });
    } catch {
      this.connection.send(await buildUnclaimedProviderProbeResult({
        requestId: msg.requestId,
        probeId,
      }));
      return;
    }
    const execution = await runProviderProbeCanary({ materialization, model: msg.model });
    this.connection.send(await buildProviderProbeResultMessage({
      requestId: msg.requestId,
      probeId,
      execution,
      authority: materialization.authority,
      daemonVersion: this.daemonVersion,
      computerVersion: this.computerVersion,
      runtimeVersion: PI_SDK_VERSION,
    }));
  }

  private getActiveMigrationTransferLease(): AgentMigrationTransportLeaseMessage | null {
    const lease = this.migrationTransferLease;
    if (!lease) return null;
    const expiresAtMs = Date.parse(lease.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= currentTimeMs()) return null;
    return lease;
  }

  private validateMigrationTransferLease(lease: AgentMigrationTransportLeaseMessage): void {
    if (!lease.agentId.trim()) throw new Error("migration transfer lease agent id is required");
    if (!lease.migrationId.trim()) throw new Error("migration transfer lease migration id is required");
    if (!/^mig_[A-Za-z0-9_-]{22}$/.test(lease.migrationRef)) throw new Error("migration transfer lease migrationRef is invalid");
    if (!lease.migrationGeneration.trim()) throw new Error("migration transfer lease migrationGeneration is required");
    if (!lease.sessionId.trim()) throw new Error("migration transfer lease session id is required");
    if (lease.provider !== "object_store") throw new Error(`unsupported migration transfer provider: ${lease.provider}`);
    if (lease.leaseSource !== "server") throw new Error(`unsupported migration transfer lease source: ${lease.leaseSource}`);
    if (lease.role !== "source" && lease.role !== "target") throw new Error(`unsupported migration transfer role: ${lease.role}`);
    if (lease.transferKind !== "upload" && lease.transferKind !== "download") {
      throw new Error(`unsupported migration transfer kind: ${lease.transferKind}`);
    }
    if (!lease.bearerToken.trim()) throw new Error("migration transfer lease bearer token is required");
    const expiresAtMs = Date.parse(lease.expiresAt);
    if (!lease.expiresAt.trim() || !Number.isFinite(expiresAtMs) || expiresAtMs <= currentTimeMs()) {
      throw new Error("migration transfer lease expiresAt must be a future timestamp");
    }
    if (!Number.isInteger(lease.maxBytes) || lease.maxBytes <= 0) {
      throw new Error("migration transfer lease maxBytes must be a positive integer");
    }
    if (
      !lease.controlUrl.trim()
      || !lease.leaseId.trim()
      || !lease.transportGeneration.trim()
      || !lease.sourceMachineId.trim()
      || !lease.targetMachineId.trim()
      || !Number.isSafeInteger(lease.expectedMigrationRevision)
    ) {
      throw new Error("MIGRATION_TRANSFER_LEASE_INVALID");
    }
  }

  private handleMigrationTransportLease(lease: AgentMigrationTransportLeaseMessage): void {
    const span = this.tracer.startSpan("daemon.migration_transport.lease", {
      surface: "daemon",
      kind: "internal",
    });
    try {
      const outcomeAttrs = this.applyMigrationTransferLease(lease, span.context);
      span.end("ok", { attrs: outcomeAttrs });
    } catch (err) {
      logger.error("[Slock Daemon] Failed to apply migration transport lease", err);
      span.end("error", {
        attrs: {
          outcome: "failed",
          lease_present: true,
          error_class: errorClassOf(err),
        },
      });
    }
  }

  // Applies the lease and returns the trace attrs that describe the outcome.
  private applyMigrationTransferLease(
    lease: AgentMigrationTransportLeaseMessage,
    leaseSpan: TraceContext,
  ): Record<string, unknown> {
    this.validateMigrationTransferLease(lease);
    if (
      this.migrationTransferLease?.agentId === lease.agentId
      && this.migrationTransferLease?.migrationId === lease.migrationId
      && this.migrationTransferLease?.migrationGeneration === lease.migrationGeneration
      && this.migrationTransferLease?.sessionId === lease.sessionId
      && this.migrationTransferLease?.role === lease.role
    ) {
      this.migrationTransferLease = lease;
      this.emitReadyIfConnected();
      this.startMigrationTransferRun(lease, leaseSpan);
      return {
        ...migrationTraceIdentityAttrs(lease, "lease"),
        outcome: "unchanged",
        agent_id_present: true,
        migration_id_present: true,
        session_id_present: true,
        migration_generation: lease.migrationGeneration,
        provider: lease.provider,
        role: lease.role,
        transfer_kind: lease.transferKind,
      };
    }

    this.migrationTransferLease = lease;
    this.emitReadyIfConnected();
    this.startMigrationTransferRun(lease, leaseSpan);
    return {
      ...migrationTraceIdentityAttrs(lease, "lease"),
      outcome: "applied",
      agent_id_present: true,
      migration_id_present: true,
      session_id_present: true,
      migration_generation: lease.migrationGeneration,
      provider: lease.provider,
      role: lease.role,
      transfer_kind: lease.transferKind,
      bearer_token_present: Boolean(lease.bearerToken),
    };
  }

  private startMigrationTransferRun(lease: AgentMigrationTransportLeaseMessage, leaseSpan: TraceContext): void {
    const key = [
      lease.agentId,
      lease.migrationId,
      lease.migrationGeneration,
      lease.sessionId,
      lease.role,
      lease.transportGeneration,
    ].join(":");
    if (this.migrationTransferRuns.has(key)) return;
    const controller = new AbortController();
    const run: MigrationTransferRunState = {
      lease,
      controller,
      promise: Promise.resolve(),
      workspacePlacementStarted: false,
      workspacePlaced: false,
      flipCommitted: false,
    };
    // The transfer runs longer than the lease message that started it, so it
    // gets its own span. Stage events inside the transfer attach to it.
    const span = this.tracer.startSpan("daemon.migration_transport.transfer", {
      parent: leaseSpan,
      surface: "daemon",
      kind: "internal",
      attrs: {
        ...migrationTraceIdentityAttrs(lease, "transfer"),
        ...(lease.role === "target" ? { download_concurrency: MIGRATION_TARGET_CHUNK_DOWNLOAD_CONCURRENCY } : {}),
      },
    });
    const promise = runWithActiveSpan(span, () => this.runMigrationTransferLease(lease, run))
      .then(() => {
        span.end("ok");
      })
      .catch(async (err: unknown) => {
        if (controller.signal.aborted) {
          span.end("cancelled", { attrs: { outcome: "canceled" } });
          this.recordDaemonEvent("daemon.migration_transport.object_store", {
            ...migrationTraceIdentityAttrs(lease, "transfer"),
            outcome: "canceled",
          }, "ok", span.context);
          return;
        }
        span.end("error", { attrs: { outcome: "failed", error_class: errorClassOf(err) } });
        logger.error("[Slock Daemon] Migration object-store transfer failed", err);
        this.recordDaemonEvent("daemon.migration_transport.object_store", {
          ...migrationTraceIdentityAttrs(lease, "transfer"),
          outcome: "failed",
          agent_id_present: Boolean(lease.agentId),
          migration_id_present: Boolean(lease.migrationId),
          session_id_present: Boolean(lease.sessionId),
          error_class: errorClassOf(err),
          ...migrationObjectStoreFailureTraceAttrs(err),
        }, "error", span.context);
        try {
          await this.reportMigrationTransportLost(lease, err);
        } catch (reportErr) {
          logger.error("[Slock Daemon] Failed to report migration transport loss", reportErr);
          this.recordDaemonEvent("daemon.migration_transport.object_store", {
            ...migrationTraceIdentityAttrs(lease, "transport_lost_report"),
            outcome: "transport_lost_report_failed",
            migration_id_present: Boolean(lease.migrationId),
            error_class: errorClassOf(reportErr),
          }, "error", span.context);
        }
      })
      .finally(() => {
        if (this.migrationTransferRuns.get(key) === run) this.migrationTransferRuns.delete(key);
      });
    run.promise = promise;
    this.migrationTransferRuns.set(key, run);
    void promise;
  }

  private async runMigrationTransferLease(
    lease: AgentMigrationTransportLeaseMessage,
    run: MigrationTransferRunState,
  ): Promise<void> {
    if (lease.role === "source") {
      await this.uploadResumableMigrationBundle(lease, run.controller.signal);
      return;
    }
    await this.downloadAndCommitResumableMigrationBundle(lease, run);
  }

  private migrationResumableControlUrl(
    lease: AgentMigrationTransportLeaseMessage,
    suffix: string,
  ): URL {
    const base = new URL(lease.controlUrl, this.options.serverUrl).toString().replace(/\/$/, "");
    return new URL(`${base}${suffix}`, this.options.serverUrl);
  }

  private migrationResumableControlHeaders(lease: AgentMigrationTransportLeaseMessage): Record<string, string> {
    return {
      ...this.internalComputerHeaders(),
      "X-Raft-Migration-Token": lease.bearerToken,
    };
  }

  /**
   * Throttled, fire-and-forget bundle-build progress for the server. Reports
   * never overlap and never fail the migration; a server without the endpoint
   * (404) disables reporting for this run. A report skipped by the throttle is
   * sent once the interval ends, so the latest counts are not lost before a
   * long quiet stretch.
   */
  private createMigrationSourceProgressReporter(
    lease: AgentMigrationTransportLeaseMessage,
    signal: AbortSignal,
  ): (progress: AgentMigrationExportProgress) => void {
    let lastSentAt = currentDate().getTime();
    let inFlight = false;
    let disabled = false;
    let pending: AgentMigrationExportProgress | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const clearFlush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
    };
    signal.addEventListener("abort", clearFlush, { once: true });
    const send = (progress: AgentMigrationExportProgress) => {
      lastSentAt = currentDate().getTime();
      pending = null;
      clearFlush();
      inFlight = true;
      void daemonFetch(this.migrationResumableControlUrl(lease, "/source-progress"), {
        method: "POST",
        headers: {
          ...this.migrationResumableControlHeaders(lease),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ migrationGeneration: lease.transportGeneration, ...progress }),
        signal,
      }).then((response) => {
        if (response.status === 404) disabled = true;
      }, () => undefined).finally(() => {
        inFlight = false;
      });
    };
    const report = (progress: AgentMigrationExportProgress) => {
      if (disabled || signal.aborted) return;
      const waitMs = lastSentAt + MIGRATION_SOURCE_PROGRESS_INTERVAL_MS - currentDate().getTime();
      if (inFlight || waitMs > 0) {
        pending = progress;
        if (!flushTimer) {
          flushTimer = setTimeout(() => {
            flushTimer = null;
            if (pending) report(pending);
          }, Math.max(waitMs, 1_000));
          flushTimer.unref?.();
        }
        return;
      }
      send(progress);
    };
    return report;
  }

  private async uploadResumableMigrationBundle(
    lease: AgentMigrationTransportLeaseMessage,
    signal: AbortSignal,
  ): Promise<void> {
    if (lease.transferKind !== "upload") throw new Error("MIGRATION_RESUMABLE_SOURCE_LEASE_INVALID");
    signal.throwIfAborted();
    const launchId = this.agentManager.getAgentLaunchId(lease.agentId) ?? "none";
    const sessionId = this.agentManager.getAgentSessionId(lease.agentId) ?? "none";
    await this.agentManager.stopAgent(lease.agentId, { wait: true, silent: true });
    if (this.agentManager.getRunningAgentIds().includes(lease.agentId)) {
      throw new Error("MIGRATION_SOURCE_QUIESCE_FAILED");
    }
    const quiesceResponse = await daemonFetch(
      this.migrationResumableControlUrl(lease, "/source-quiesced"),
      {
        method: "POST",
        headers: {
          ...this.migrationResumableControlHeaders(lease),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          receipt: {
            schemaVersion: "agent-migration-quiesce/v1",
            migrationId: lease.migrationId,
            migrationGeneration: lease.transportGeneration,
            agentId: lease.agentId,
            sourceMachineId: lease.sourceMachineId,
            sourceRuntimeState: "stopped",
            stoppedAt: currentDate().toISOString(),
            actor: "migration",
            launchSessionIdentity: `launch:${launchId}:session:${sessionId}`,
            expectedRuntimeRevision: String(lease.expectedMigrationRevision),
          },
        }),
        signal,
      },
    );
    if (!quiesceResponse.ok) {
      throw await migrationStepResponseError(
        "MIGRATION_SOURCE_QUIESCE_REPORT_FAILED",
        quiesceResponse,
        "source_quiesce",
      );
    }

    const streamed = await streamAgentMigrationResumableBundle({
      agentId: lease.agentId,
      migrationId: lease.migrationId,
      migrationGeneration: lease.transportGeneration,
      leaseId: lease.leaseId,
      sourceMachineId: lease.sourceMachineId,
      targetMachineId: lease.targetMachineId,
      workspacePath: path.join(this.agentsDataDir, lease.agentId),
      maxBytes: lease.maxBytes,
      signal,
      onProgress: this.createMigrationSourceProgressReporter(lease, signal),
      uploadChunk: (chunk, bytes) => this.uploadStreamedMigrationChunk(lease, chunk, bytes, signal),
    });
    if (streamed.resizedEntryCount > 0) {
      logger.warn(
        `[Daemon] Migration ${lease.migrationRef}: ${streamed.resizedEntryCount} file(s) changed size while packing `
        + `and were cut or zero-padded to their listed size: ${streamed.resizedEntries.join(", ")}`,
      );
    }
    await this.registerAndCompleteResumableUpload(lease, streamed, signal);
  }

  /** Streamed bundles: records the chunk with the server, then uploads it unless it is already there. */
  private async uploadStreamedMigrationChunk(
    lease: AgentMigrationTransportLeaseMessage,
    chunk: AgentMigrationControlChunk,
    bytes: Buffer,
    signal: AbortSignal,
  ): Promise<void> {
    const prepareResponse = await this.fetchResumableTransferWithRetry(
      lease,
      "chunk_plan",
      false,
      signal,
      () => daemonFetch(this.migrationResumableControlUrl(lease, `/stream-chunks/${chunk.index}`), {
        method: "POST",
        headers: {
          ...this.migrationResumableControlHeaders(lease),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          migrationGeneration: lease.transportGeneration,
          leaseId: lease.leaseId,
          sizeBytes: chunk.sizeBytes,
          sha256: chunk.sha256,
        }),
        signal,
      }),
    );
    if (!prepareResponse.ok) {
      throw await migrationStepResponseError("MIGRATION_CHUNK_PLAN_FAILED", prepareResponse, "chunk_plan");
    }
    const prepared = await prepareResponse.json() as { uploaded?: boolean; url?: string | null };
    if (prepared.uploaded === true) return;
    if (typeof prepared.url !== "string" || !prepared.url) throw new Error("MIGRATION_CHUNK_PLAN_MISMATCH");
    const uploadUrl = prepared.url;
    const upload = await this.fetchResumableTransferWithRetry(
      lease,
      "chunk_upload",
      false,
      signal,
      () => daemonFetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(chunk.sizeBytes),
        },
        body: bytes as Uint8Array<ArrayBuffer>,
        signal,
      }),
    );
    if (!upload.ok) throw new Error(`MIGRATION_CHUNK_UPLOAD_FAILED:${upload.status}`);
    await this.reportResumableChunkReceipt(lease, "source", chunk, upload.headers.get("etag"), signal);
  }

  /** Registers the control and completes the upload; every chunk was already streamed up. */
  private async registerAndCompleteResumableUpload(
    lease: AgentMigrationTransportLeaseMessage,
    built: { control: AgentMigrationControlManifest; controlSha256: string; controlBytes: number },
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const controlResponse = await daemonFetch(
      this.migrationResumableControlUrl(lease, "/control"),
      {
        method: "POST",
        headers: {
          ...this.migrationResumableControlHeaders(lease),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ control: built.control }),
        signal,
      },
    );
    if (!controlResponse.ok) {
      throw await migrationStepResponseError(
        "MIGRATION_CONTROL_REGISTER_FAILED",
        controlResponse,
        "control_register",
      );
    }
    const registered = await controlResponse.json() as { controlSha256?: string };
    if (registered.controlSha256 !== built.controlSha256) {
      throw new Error("MIGRATION_CONTROL_DIGEST_MISMATCH");
    }

    signal.throwIfAborted();
    const plan = await this.fetchResumableChunkPlan(lease, "source", signal);
    if (!plan.complete) throw new Error("MIGRATION_CHUNKS_MISSING");
    const completed = await daemonFetch(
      this.migrationResumableControlUrl(lease, "/upload-complete"),
      {
        method: "POST",
        headers: {
          ...this.migrationResumableControlHeaders(lease),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          migrationGeneration: lease.transportGeneration,
          leaseId: lease.leaseId,
          controlSha256: built.controlSha256,
        }),
        signal,
      },
    );
    if (!completed.ok) {
      throw await migrationStepResponseError(
        "MIGRATION_UPLOAD_COMPLETE_FAILED",
        completed,
        "upload_complete",
      );
    }
    this.recordDaemonEvent("daemon.migration_transport.resumable", {
      ...migrationTraceIdentityAttrs(lease, "upload_complete"),
      outcome: "uploaded",
      chunk_count: built.control.bundle.chunks.length,
      bundle_size_bucket: migrationObjectStoreBundleSizeBucket(built.control.bundle.totalBytes),
      control_bytes: built.controlBytes,
    });
  }

  private async downloadAndCommitResumableMigrationBundle(
    lease: AgentMigrationTransportLeaseMessage,
    run: MigrationTransferRunState,
  ): Promise<void> {
    if (lease.transferKind !== "download") throw new Error("MIGRATION_RESUMABLE_TARGET_LEASE_INVALID");
    const signal = run.controller.signal;
    signal.throwIfAborted();
    // Both durations are measured on this machine's clock, so they can be
    // read without subtracting timestamps taken on the source computer.
    const waitStartedAtMs = currentTimeMs();
    const { control, controlSha256 } = await this.waitForResumableControl(lease, signal);
    const controlReceivedAtMs = currentTimeMs();
    this.recordDaemonEvent("daemon.migration_transport.resumable", {
      ...migrationTraceIdentityAttrs(lease, "control_wait"),
      outcome: "control_received",
      chunk_count: control.bundle.chunks.length,
      duration_ms: controlReceivedAtMs - waitStartedAtMs,
    });
    if (
      control.identity.migrationId !== lease.migrationId
      || control.identity.migrationGeneration !== lease.transportGeneration
      || control.identity.leaseId !== lease.leaseId
      || control.identity.agentId !== lease.agentId
      || control.identity.targetMachineId !== lease.targetMachineId
    ) {
      throw new Error("MIGRATION_CONTROL_IDENTITY_MISMATCH");
    }
    const finalWorkspacePath = path.join(this.agentsDataDir, lease.agentId);
    let residue = await classifyAgentMigrationTargetResidue({
      control,
      controlSha256,
      slockHome: this.slockHome,
      finalWorkspacePath,
    });
    const staleWorkspace = residue.classification === "user-owned"
      || (residue.classification === "complete-old-copy"
        && residue.committed
        && !commitMarkerMatches(residue.committed, control, controlSha256));
    if (staleWorkspace) {
      // Until the flip the server keeps authority on the source, so this
      // directory is not the agent's live workspace, unless the agent is
      // somehow running here, in which case nothing is touched.
      if (this.agentManager.getRunningAgentIds().includes(lease.agentId)) {
        throw new Error("MIGRATION_WORKSPACE_ALREADY_EXISTS");
      }
      const { quarantinePath } = await quarantinePreexistingAgentWorkspace({
        slockHome: this.slockHome,
        dataDir: this.agentsDataDir,
        agentId: lease.agentId,
        migrationId: lease.migrationId,
      });
      this.recordDaemonEvent("daemon.migration_transport.resumable", {
        ...migrationTraceIdentityAttrs(lease, "chunk_download"),
        outcome: "preexisting_workspace_quarantined",
        residue_class: residue.classification,
        quarantine_path_present: Boolean(quarantinePath),
      });
      residue = await classifyAgentMigrationTargetResidue({
        control,
        controlSha256,
        slockHome: this.slockHome,
        finalWorkspacePath,
      });
    }
    const chunksDirectory = path.join(residue.generationRootPath, "chunks");
    const missing = new Set(await missingAgentMigrationChunks({ control, chunksDirectory }));
    for (const chunk of control.bundle.chunks) {
      if (!missing.has(chunk.index)) {
        await this.reportResumableChunkReceipt(lease, "target", chunk, null, signal);
      }
    }
    while (true) {
      signal.throwIfAborted();
      const plan = await this.fetchResumableChunkPlan(lease, "target", signal);
      if (plan.complete) break;
      if (plan.chunks.length === 0) {
        await waitForAmbientBackoff(MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_INITIAL_MS, signal);
        continue;
      }
      const planned = plan.chunks.map((chunk) => {
        const expected = control.bundle.chunks[chunk.index];
        if (
          !expected
          || chunk.method !== "GET"
          || chunk.sizeBytes !== expected.sizeBytes
          || chunk.sha256 !== expected.sha256
        ) {
          throw new Error("MIGRATION_CHUNK_PLAN_MISMATCH");
        }
        return { chunk, expected };
      });
      await forEachWithConcurrency(planned, MIGRATION_TARGET_CHUNK_DOWNLOAD_CONCURRENCY, async ({ chunk, expected }) => {
        const response = await this.fetchResumableTransferWithRetry(
          lease,
          "chunk_download",
          true,
          signal,
          () => daemonFetch(chunk.url, { method: "GET", signal }),
        );
        if (!response.ok || !response.body) {
          throw new Error(`MIGRATION_CHUNK_DOWNLOAD_FAILED:${response.status}`);
        }
        await verifyAndStoreAgentMigrationChunk({
          control,
          chunkIndex: chunk.index,
          chunk: Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
          chunksDirectory,
        });
        await this.reportResumableChunkReceipt(lease, "target", expected, null, signal);
      });
    }
    this.recordDaemonEvent("daemon.migration_transport.resumable", {
      ...migrationTraceIdentityAttrs(lease, "chunk_download"),
      outcome: "chunks_downloaded",
      chunk_count: control.bundle.chunks.length,
      duration_ms: currentTimeMs() - controlReceivedAtMs,
    });

    const targetImport = await this.fetchMigrationTargetImportView(lease.migrationId);
    if (targetImport.migrationRef !== lease.migrationRef) {
      throw new Error("MIGRATION_TARGET_IMPORT_REF_MISMATCH");
    }
    await this.writeMigrationCancellationMarker(lease, run, finalWorkspacePath);
    signal.throwIfAborted();
    const started = await this.postMigrationTargetImportStep(
      lease.migrationId,
      "start-transfer",
      { migrationGeneration: targetImport.migrationGeneration },
    );
    run.workspacePlacementStarted = true;
    await this.writeMigrationCancellationMarker(lease, run, finalWorkspacePath);
    const committed = await stageAndCommitAgentMigrationResumableBundle({
      control,
      controlSha256,
      slockHome: this.slockHome,
      chunksDirectory,
      finalWorkspacePath,
    }, {
      traceStep: (step, work) => this.traceMigrationPlacementStep(lease, control, step, work),
    });
    run.workspacePlaced = true;
    await this.writeMigrationCancellationMarker(lease, run, finalWorkspacePath);
    signal.throwIfAborted();
    const flipped = await this.postMigrationTargetImportStep(
      lease.migrationId,
      "flip-machine",
      { migrationGeneration: started.migrationGeneration },
    );
    run.flipCommitted = true;
    await this.writeMigrationCancellationMarker(lease, run, finalWorkspacePath);
    signal.throwIfAborted();
    const reportPath = path.join(residue.generationRootPath, "arrival-report-v2.json");
    const reportPayload = `${JSON.stringify({
      schemaVersion: "agent-arrival/v2",
      migrationId: lease.migrationId,
      migrationGeneration: lease.transportGeneration,
      agentId: lease.agentId,
      sourceMachineId: control.identity.sourceMachineId,
      targetMachineId: control.identity.targetMachineId,
      controlSha256,
      bundleSha256: control.bundle.sha256,
      chunkCount: control.bundle.chunks.length,
      commitOutcome: committed.outcome,
      residueClass: residue.classification,
      finalWorkspacePath: committed.finalWorkspacePath,
      arrivedAt: currentDate().toISOString(),
    })}\n`;
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, reportPayload, { mode: 0o600 });
    const reportSha256 = createHash("sha256").update(reportPayload).digest("hex");
    await this.postMigrationTargetImportStep(
      lease.migrationId,
      "arrived",
      {
        migrationGeneration: flipped.migrationGeneration,
        reportPath,
        reportSha256,
      },
    );
    await rm(this.migrationCancellationDirectory(lease.sessionId), { recursive: true, force: true });
    // Arrived and flipped: the Server no longer asks this generation for its
    // chunks, so the compressed workspace copy goes; the JSON report stays.
    const chunksFreedBytes = await removeMigrationGenerationBulk(
      residue.generationRootPath,
      createRaftDiskWalkBudget(),
    ).catch(() => null);
    this.recordDaemonEvent("daemon.migration_transport.resumable", {
      ...migrationTraceIdentityAttrs(lease, "arrival_report"),
      outcome: "committed",
      chunk_count: control.bundle.chunks.length,
      commit_outcome: committed.outcome,
      residue_class: residue.classification,
      ...(chunksFreedBytes === null ? { chunks_removed: false } : { chunks_removed: true, chunks_freed_bytes: chunksFreedBytes }),
    });
  }

  private async traceMigrationPlacementStep<T>(
    lease: AgentMigrationTransportLeaseMessage,
    control: AgentMigrationControlManifest,
    step: AgentMigrationPlacementStep,
    work: () => Promise<T>,
  ): Promise<T> {
    const span = this.tracer.startSpan("daemon.migration_transport.placement", {
      parent: getActiveTraceContext(),
      surface: "daemon",
      kind: "internal",
      attrs: {
        ...migrationTraceIdentityAttrs(lease, step),
        chunk_count: control.bundle.chunks.length,
        file_count: control.archive.entryCount,
        expanded_bytes: control.archive.expandedBytes,
      },
    });
    try {
      const result = await work();
      span.end("ok", { attrs: { outcome: "ok" } });
      return result;
    } catch (err) {
      span.end("error", { attrs: { outcome: "failed", error_class: errorClassOf(err) } });
      throw err;
    }
  }

  private async waitForResumableControl(
    lease: AgentMigrationTransportLeaseMessage,
    signal: AbortSignal,
  ): Promise<{
    control: AgentMigrationControlManifest;
    controlSha256: string;
  }> {
    const expiresAtMs = Date.parse(lease.expiresAt);
    let delayMs = MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_INITIAL_MS;
    while (currentTimeMs() < expiresAtMs) {
      signal.throwIfAborted();
      const url = this.migrationResumableControlUrl(lease, "/control");
      url.searchParams.set("role", "target");
      const response = await daemonFetch(url, {
        method: "GET",
        headers: this.migrationResumableControlHeaders(lease),
        signal,
      });
      if (response.ok) {
        const body = await response.json() as {
          control?: AgentMigrationControlManifest;
          controlSha256?: string;
          uploadComplete?: boolean;
        };
        if (body.control && body.controlSha256 && body.uploadComplete) {
          const validated = validateAgentMigrationControlManifest(body.control);
          if (validated.sha256 !== body.controlSha256) {
            throw new Error("MIGRATION_CONTROL_DIGEST_MISMATCH");
          }
          return { control: body.control, controlSha256: body.controlSha256 };
        }
      } else if (response.status !== 409 && !isRetryableMigrationObjectStoreDownloadStatus(response.status)) {
        throw await migrationStepResponseError(
          "MIGRATION_CONTROL_DOWNLOAD_FAILED",
          response,
          "control_wait",
        );
      }
      const remainingMs = expiresAtMs - currentTimeMs();
      if (remainingMs <= 0) break;
      await waitForAmbientBackoff(Math.min(delayMs, remainingMs), signal);
      delayMs = Math.min(delayMs * 2, MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_MAX_MS);
    }
    throw new Error("MIGRATION_LEASE_EXPIRED");
  }

  private async fetchResumableChunkPlan(
    lease: AgentMigrationTransportLeaseMessage,
    role: "source" | "target",
    signal: AbortSignal,
  ): Promise<{
    complete: boolean;
    chunks: Array<{ index: number; sizeBytes: number; sha256: string; method: "PUT" | "GET"; url: string }>;
  }> {
    const url = this.migrationResumableControlUrl(lease, "/chunks");
    url.searchParams.set("role", role);
    url.searchParams.set("cursor", "0");
    const response = await this.fetchResumableTransferWithRetry(
      lease,
      "chunk_plan",
      false,
      signal,
      () => daemonFetch(url, {
        method: "GET",
        headers: this.migrationResumableControlHeaders(lease),
        signal,
      }),
    );
    if (!response.ok) {
      throw await migrationStepResponseError(
        "MIGRATION_CHUNK_PLAN_FAILED",
        response,
        "chunk_plan",
      );
    }
    const body = await response.json() as {
      complete?: boolean;
      migrationGeneration?: string;
      leaseId?: string;
      chunks?: Array<{ index: number; sizeBytes: number; sha256: string; method: "PUT" | "GET"; url: string }>;
    };
    if (
      body.migrationGeneration !== lease.transportGeneration
      || body.leaseId !== lease.leaseId
      || typeof body.complete !== "boolean"
      || !Array.isArray(body.chunks)
    ) {
      throw new Error("MIGRATION_CHUNK_PLAN_MISMATCH");
    }
    return { complete: body.complete, chunks: body.chunks };
  }

  private async reportResumableChunkReceipt(
    lease: AgentMigrationTransportLeaseMessage,
    role: "source" | "target",
    chunk: { index: number; sizeBytes: number; sha256: string },
    etag: string | null,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.fetchResumableTransferWithRetry(
      lease,
      "chunk_receipt",
      false,
      signal,
      () => daemonFetch(
        this.migrationResumableControlUrl(lease, `/chunks/${chunk.index}/receipt`),
        {
          method: "POST",
          headers: {
            ...this.migrationResumableControlHeaders(lease),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            role,
            migrationGeneration: lease.transportGeneration,
            leaseId: lease.leaseId,
            chunkIndex: chunk.index,
            sizeBytes: chunk.sizeBytes,
            sha256: chunk.sha256,
            ...(etag ? { etag } : {}),
          }),
          signal,
        },
      ),
    );
    if (!response.ok) {
      throw await migrationStepResponseError(
        "MIGRATION_CHUNK_RECEIPT_FAILED",
        response,
        "chunk_receipt",
      );
    }
  }

  private async fetchResumableTransferWithRetry(
    lease: AgentMigrationTransportLeaseMessage,
    operation: "chunk_upload" | "chunk_download" | "chunk_plan" | "chunk_receipt",
    retryNotFound: boolean,
    signal: AbortSignal,
    request: () => Promise<Response>,
  ): Promise<Response> {
    const expiresAtMs = Date.parse(lease.expiresAt);
    let attempt = 0;
    let delayMs = MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_INITIAL_MS;
    let lastStatus: number | null = null;
    let lastErrorClass: string | null = null;

    while (currentTimeMs() < expiresAtMs) {
      signal.throwIfAborted();
      attempt += 1;
      try {
        const response = await request();
        if (response.ok || !isRetryableResumableMigrationStatus(response.status, retryNotFound)) {
          return response;
        }
        lastStatus = response.status;
        lastErrorClass = null;
        await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        lastStatus = null;
        lastErrorClass = errorClassOf(error);
      }

      const remainingMs = expiresAtMs - currentTimeMs();
      if (remainingMs <= 0) break;
      const sleepMs = Math.min(delayMs, remainingMs);
      this.recordDaemonEvent("daemon.migration_transport.resumable", {
        ...migrationTraceIdentityAttrs(lease, operation === "chunk_upload"
          ? "chunk_upload"
          : operation === "chunk_download"
            ? "chunk_download"
            : operation === "chunk_plan"
              ? "chunk_plan"
              : "chunk_receipt"),
        outcome: "retry",
        operation,
        attempt,
        http_status: lastStatus,
        error_class: lastErrorClass,
        retry_delay_ms: sleepMs,
      });
      await waitForAmbientBackoff(sleepMs, signal);
      delayMs = Math.min(delayMs * 2, MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_MAX_MS);
    }
    throw new Error("MIGRATION_LEASE_EXPIRED");
  }

  private migrationCancellationDirectory(sessionId: string): string {
    return path.join(this.slockHome, "migrations", migrationStatePathSegment(sessionId));
  }

  private migrationCancellationMarkerPath(sessionId: string): string {
    return path.join(this.migrationCancellationDirectory(sessionId), "cancel-state.json");
  }

  private migrationCancellationReceiptPath(sessionId: string): string {
    return path.join(this.migrationCancellationDirectory(sessionId), "cancel-receipt.json");
  }

  private async writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporaryPath, filePath);
  }

  private async writeMigrationCancellationMarker(
    lease: AgentMigrationTransportLeaseMessage,
    run: MigrationTransferRunState,
    finalWorkspacePath: string,
  ): Promise<void> {
    const marker: MigrationCancellationMarker = {
      schemaVersion: "agent-migration-cancel/v1",
      agentId: lease.agentId,
      migrationId: lease.migrationId,
      migrationRef: lease.migrationRef,
      transportGeneration: lease.transportGeneration,
      sessionId: lease.sessionId,
      finalWorkspacePath: path.resolve(finalWorkspacePath),
      workspacePlacementStarted: run.workspacePlacementStarted,
      workspacePlaced: run.workspacePlaced,
      flipCommitted: run.flipCommitted,
    };
    await this.writeJsonAtomically(this.migrationCancellationMarkerPath(lease.sessionId), marker);
  }

  private async readMigrationCancellationMarker(sessionId: string): Promise<MigrationCancellationMarker | null> {
    try {
      const value = JSON.parse(await readFile(this.migrationCancellationMarkerPath(sessionId), "utf8")) as Partial<MigrationCancellationMarker>;
      if (
        value.schemaVersion !== "agent-migration-cancel/v1"
        || typeof value.agentId !== "string"
        || typeof value.migrationId !== "string"
        || typeof value.migrationRef !== "string"
        || typeof value.transportGeneration !== "string"
        || typeof value.sessionId !== "string"
        || typeof value.finalWorkspacePath !== "string"
        || typeof value.workspacePlacementStarted !== "boolean"
        || typeof value.workspacePlaced !== "boolean"
        || typeof value.flipCommitted !== "boolean"
      ) {
        throw new Error("MIGRATION_CANCEL_MARKER_INVALID");
      }
      return value as MigrationCancellationMarker;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private async readMigrationCancellationReceipt(sessionId: string): Promise<AppliedMigrationCancellationReceipt | null> {
    try {
      const value = JSON.parse(await readFile(this.migrationCancellationReceiptPath(sessionId), "utf8")) as Partial<AppliedMigrationCancellationReceipt>;
      if (
        value.schemaVersion !== "agent-migration-cancel-receipt/v1"
        || typeof value.agentId !== "string"
        || typeof value.migrationId !== "string"
        || typeof value.migrationRef !== "string"
        || typeof value.transportGeneration !== "string"
        || typeof value.cancelGeneration !== "string"
        || (value.role !== "source" && value.role !== "target")
        || (value.outcome !== "cleaned" && value.outcome !== "stopped")
      ) {
        throw new Error("MIGRATION_CANCEL_RECEIPT_INVALID");
      }
      return value as AppliedMigrationCancellationReceipt;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private async handleMigrationCancellation(message: AgentMigrationCancelMessage): Promise<void> {
    const span = this.tracer.startSpan("daemon.migration_transport.cancel_cleanup", {
      surface: "daemon",
      kind: "internal",
      attrs: {
        role: message.role,
        migration_ref: message.migrationRef,
      },
    });
    const cleaned = await runWithActiveSpan(span, () => this.cleanUpCancelledMigration(message));
    span.end(cleaned ? "ok" : "error");
  }

  // Returns false when the cleanup failed. The failure is already reported
  // to the server and recorded as a trace event.
  private async cleanUpCancelledMigration(message: AgentMigrationCancelMessage): Promise<boolean> {
    try {
      if (!message.agentId.trim() || !message.migrationId.trim()) throw new Error("MIGRATION_CANCEL_IDENTITY_INVALID");
      if (!/^mig_[A-Za-z0-9_-]{22}$/.test(message.migrationRef)) throw new Error("MIGRATION_CANCEL_REF_INVALID");
      if (!message.transportGeneration.trim()) throw new Error("MIGRATION_TRANSPORT_GENERATION_INVALID");
      if (!message.cancelGeneration.trim()) throw new Error("MIGRATION_CANCEL_GENERATION_INVALID");
      if (!Number.isInteger(message.migrationRevision) || message.migrationRevision < 1) {
        throw new Error("MIGRATION_CANCEL_REVISION_INVALID");
      }
      const sessionKey = message.sessionId ?? message.migrationId;
      const priorReceipt = await this.readMigrationCancellationReceipt(sessionKey);
      if (priorReceipt) {
        if (
          priorReceipt.agentId !== message.agentId
          || priorReceipt.migrationId !== message.migrationId
          || priorReceipt.migrationRef !== message.migrationRef
          || priorReceipt.transportGeneration !== message.transportGeneration
          || priorReceipt.cancelGeneration !== message.cancelGeneration
          || priorReceipt.role !== message.role
        ) {
          throw new Error("MIGRATION_CANCEL_GENERATION_STALE");
        }
        await this.reportMigrationCancellation(message, priorReceipt.outcome);
        return true;
      }

      const matchingRuns = [...this.migrationTransferRuns.values()].filter((run) =>
        run.lease.agentId === message.agentId
        && run.lease.migrationId === message.migrationId
        && run.lease.migrationRef === message.migrationRef
        && run.lease.transportGeneration === message.transportGeneration
        && run.lease.role === message.role
      );
      const activeLeaseMatches = Boolean(
        this.migrationTransferLease?.agentId === message.agentId
        && this.migrationTransferLease?.migrationId === message.migrationId
        && this.migrationTransferLease?.migrationRef === message.migrationRef
        && this.migrationTransferLease?.transportGeneration === message.transportGeneration
        && this.migrationTransferLease?.role === message.role
      );
      for (const run of matchingRuns) run.controller.abort(new Error("MIGRATION_CANCEL_REQUESTED"));
      await Promise.allSettled(matchingRuns.map((run) => run.promise));

      let markerMatches = false;
      if (message.sessionId) {
        const marker = await this.readMigrationCancellationMarker(message.sessionId);
        if (marker) {
          const expectedFinalWorkspacePath = path.resolve(this.agentsDataDir, message.agentId);
          if (
            marker.agentId !== message.agentId
            || marker.migrationId !== message.migrationId
            || marker.migrationRef !== message.migrationRef
            || marker.transportGeneration !== message.transportGeneration
            || marker.sessionId !== message.sessionId
            || path.resolve(marker.finalWorkspacePath) !== expectedFinalWorkspacePath
          ) {
            throw new Error("MIGRATION_CANCEL_MARKER_IDENTITY_MISMATCH");
          }
          markerMatches = true;
          if (
            message.disposition === "pre_flip_source_authoritative"
            && marker.workspacePlacementStarted
            && !marker.flipCommitted
          ) {
            await rm(expectedFinalWorkspacePath, { recursive: true, force: true });
          }
        }
      }
      if (matchingRuns.length === 0 && !activeLeaseMatches && !markerMatches) {
        throw new Error("MIGRATION_CANCEL_GENERATION_UNOBSERVED");
      }
      if (message.sessionId) {
        // The legacy staged bundle and the cancellation marker share this
        // migration-owned directory. Clear it before recreating only the
        // durable idempotency receipt below.
        await rm(this.migrationCancellationDirectory(message.sessionId), { recursive: true, force: true });
      }
      // Resumable chunks, control state, and the arrival report live under
      // the immutable migration + transport-generation root. They remain
      // migration-owned after the authority flip, so both Computers must
      // remove this exact root before acknowledging cancellation. Keep the
      // target workspace separate: post-flip authority stays on the target.
      await rm(path.join(
        this.slockHome,
        "migrations",
        migrationStatePathSegment(message.migrationId),
        migrationStatePathSegment(message.transportGeneration),
      ), { recursive: true, force: true });
      if (message.stopAgent) {
        await this.agentManager.stopAgent(message.agentId, { wait: true });
      }
      if (activeLeaseMatches) {
        this.migrationTransferLease = null;
        this.emitReadyIfConnected();
      }
      const outcome = message.stopAgent ? "stopped" : "cleaned";
      const receipt: AppliedMigrationCancellationReceipt = {
        schemaVersion: "agent-migration-cancel-receipt/v1",
        agentId: message.agentId,
        migrationId: message.migrationId,
        migrationRef: message.migrationRef,
        transportGeneration: message.transportGeneration,
        cancelGeneration: message.cancelGeneration,
        role: message.role,
        outcome,
      };
      await this.writeJsonAtomically(this.migrationCancellationReceiptPath(sessionKey), receipt);
      await this.reportMigrationCancellation(message, outcome);
      this.recordDaemonEvent("daemon.migration_transport.object_store", {
        stage: "cancel_cleanup",
        outcome: "cancel_acknowledged",
        role: message.role,
        migration_ref: message.migrationRef,
      });
      return true;
    } catch (err) {
      logger.error("[Slock Daemon] Migration cancellation cleanup failed", err);
      this.recordDaemonEvent("daemon.migration_transport.object_store", {
        stage: "cancel_cleanup",
        outcome: "cancel_cleanup_failed",
        role: message.role,
        migration_ref: message.migrationRef,
        error_class: errorClassOf(err),
        error_code: /^(MIGRATION_[A-Z0-9_]+)/.exec(
          err instanceof Error ? err.message : String(err),
        )?.[1],
      }, "error");
      try {
        await this.reportMigrationCancellation(
          message,
          "needs_attention",
          errorClassOf(err),
          err instanceof Error ? err.message : String(err),
        );
      } catch (reportErr) {
        logger.error("[Slock Daemon] Failed to report migration cancellation attention state", reportErr);
      }
      return false;
    }
  }

  private async reportMigrationCancellation(
    message: AgentMigrationCancelMessage,
    outcome: "cleaned" | "stopped" | "needs_attention",
    errorCode?: string,
    errorMessage?: string,
  ): Promise<void> {
    const url = new URL(`/internal/computer/agent-migrations/by-id/${encodeURIComponent(message.migrationId)}/cancel-ack`, this.options.serverUrl);
    const response = await daemonFetch(url, {
      method: "POST",
      headers: {
        ...this.internalComputerHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        migrationRef: message.migrationRef,
        transportGeneration: message.transportGeneration,
        cancelGeneration: message.cancelGeneration,
        role: message.role,
        outcome,
        errorCode,
        errorMessage,
      }),
    });
    if (!response.ok) {
      throw new Error(`MIGRATION_CANCEL_ACK_FAILED:${response.status}`);
    }
  }

  private async reportMigrationTransportLost(lease: AgentMigrationTransportLeaseMessage, err: unknown): Promise<void> {
    const url = new URL(`/internal/computer/agent-migrations/by-id/${encodeURIComponent(lease.migrationId)}/transport-lost`, this.options.serverUrl);
    const response = await daemonFetch(url, {
      method: "POST",
      headers: {
        ...this.internalComputerHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        role: lease.role,
        transferKind: lease.transferKind,
        code: migrationTransferFailureCode(err),
        // Lets the server ignore a stale run after re-provisioning (additive).
        ...(lease.transportGeneration ? { transportGeneration: lease.transportGeneration } : {}),
        detailCode: migrationTransferFailureDetailCode(err),
        message: migrationTransferFailureMessage(err),
      }),
    });
    if (!response.ok) {
      throw new Error(`MIGRATION_TRANSPORT_LOST_REPORT_FAILED:${response.status}`);
    }
    this.recordDaemonEvent("daemon.migration_transport.object_store", {
      ...migrationTraceIdentityAttrs(lease, "transport_lost_report"),
      outcome: "transport_lost_reported",
      migration_id_present: Boolean(lease.migrationId),
    });
  }

  private archiveMigrationSourceWorkspaceSerialized(
    agentId: string,
    migrationId: string,
    migrationCreatedAt?: string,
  ): Promise<AgentMigrationWorkspaceArchiveOutcome> {
    const inFlight = this.migrationSourceArchiveRuns.get(agentId);
    if (inFlight?.migrationId === migrationId) return inFlight.run;
    // A different migration of the same agent waits for the in-flight one:
    // both touch the same source directory and backup root.
    const run = (inFlight?.run.catch(() => undefined) ?? Promise.resolve())
      .then(() => this.assertMigrationSourceWorkspaceArchivable(agentId, migrationCreatedAt))
      .then(() => archiveCompletedAgentMigrationSourceWorkspace({
        slockHome: this.slockHome,
        dataDir: this.agentsDataDir,
        agentId,
        migrationId,
      }))
      .finally(() => {
        if (this.migrationSourceArchiveRuns.get(agentId)?.run === run) {
          this.migrationSourceArchiveRuns.delete(agentId);
        }
      });
    this.migrationSourceArchiveRuns.set(agentId, { migrationId, run });
    return run;
  }

  /**
   * The server checks the holder before asking, but a background retry reaches
   * the daemon after that check committed. The daemon is the last line: never
   * archive a workspace whose agent runs here, or one that a later migration
   * committed onto this computer (the agent moved back).
   */
  private async assertMigrationSourceWorkspaceArchivable(agentId: string, migrationCreatedAt?: string): Promise<void> {
    if (this.agentManager.getRunningAgentIds().includes(agentId)) {
      throw new Error("MIGRATION_WORKSPACE_ARCHIVE_AGENT_RUNNING");
    }
    const createdAtMs = migrationCreatedAt ? Date.parse(migrationCreatedAt) : Number.NaN;
    if (!Number.isFinite(createdAtMs)) return;
    const marker = await readCommitMarker(path.join(this.agentsDataDir, agentId));
    if (marker && Date.parse(marker.committedAt) > createdAtMs) {
      throw new Error("MIGRATION_WORKSPACE_ARCHIVE_NEWER_OWNER");
    }
  }

  private async fetchMigrationTargetImportView(migrationId: string): Promise<MigrationTargetImportView> {
    const url = new URL(`/internal/computer/agent-migrations/by-id/${encodeURIComponent(migrationId)}`, this.options.serverUrl);
    const response = await daemonFetch(url, {
      method: "GET",
      headers: this.internalComputerHeaders(),
    });
    if (!response.ok) {
      throw new Error(`MIGRATION_TARGET_IMPORT_LOOKUP_FAILED:${response.status}`);
    }
    const body = await response.json() as { migration?: MigrationTargetImportView };
    if (!body.migration) throw new Error("MIGRATION_TARGET_IMPORT_VIEW_MISSING");
    return body.migration;
  }

  private async postMigrationTargetImportStep(
    migrationId: string,
    step: "start-transfer" | "flip-machine" | "arrived",
    body: {
      migrationGeneration: string;
      reportPath?: string;
      reportSha256?: string;
    },
  ): Promise<MigrationTargetImportView> {
    return await retryMigrationTargetStep({
      step,
      body,
      post: (attemptBody) => this.postMigrationTargetImportStepOnce(migrationId, step, attemptBody, true),
      fetchView: () => this.fetchMigrationTargetImportView(migrationId),
      onRetry: (error, delayMs) => this.recordDaemonEvent("daemon.migration_transport.target_step", {
        step,
        outcome: "retry",
        error_class: errorClassOf(error),
        delay_ms: delayMs,
      }),
    });
  }

  private async postMigrationTargetImportStepOnce(
    migrationId: string,
    step: "start-transfer" | "flip-machine" | "arrived",
    body: {
      migrationGeneration: string;
      reportPath?: string;
      reportSha256?: string;
    },
    allowStartGenerationRefresh: boolean,
  ): Promise<MigrationTargetImportView> {
    const url = new URL(`/internal/computer/agent-migrations/by-id/${encodeURIComponent(migrationId)}/${step}`, this.options.serverUrl);
    const response = await daemonFetch(url, {
      method: "POST",
      headers: {
        ...this.internalComputerHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const suffix = await migrationStepErrorSuffix(response);
      if (step === "start-transfer" && response.status === 409 && suffix === "migration_generation_stale" && allowStartGenerationRefresh) {
        const current = await this.fetchMigrationTargetImportView(migrationId);
        if (current.state === "in_transit") return current;
        if (current.state === "ready" && current.migrationGeneration !== body.migrationGeneration) {
          return await this.postMigrationTargetImportStepOnce(migrationId, step, {
            ...body,
            migrationGeneration: current.migrationGeneration,
          }, false);
        }
      }
      throw new Error(`MIGRATION_TARGET_IMPORT_${step.toUpperCase().replace("-", "_")}_FAILED:${response.status}:${suffix}`);
    }
    const responseBody = await response.json() as { migration?: MigrationTargetImportView };
    if (!responseBody.migration) throw new Error("MIGRATION_TARGET_IMPORT_VIEW_MISSING");
    return responseBody.migration;
  }

  private internalComputerHeaders(): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.options.apiKey}`,
      "X-Raft-Client": "daemon-migration-object-store",
    };
  }

  private withDaemonTraceScope(tracer: Tracer): Tracer {
    const scopedTracer = () => createTraceScopeTracer(tracer, this.daemonTraceScope(), {
      spanAttrContracts: DAEMON_CORE_TRACE_ATTR_CONTRACTS,
    });
    return {
      startSpan: (name, options) => scopedTracer().startSpan(name, options),
      emitEvent: (name, options) => scopedTracer().emitEvent(name, options),
    };
  }

  private daemonTraceScope(): TraceScope {
    return {
      resource: {
        daemonVersion: this.daemonVersion,
        computerVersion: this.computerVersion,
      },
      actor: {
        serverId: this.observedServerId,
        machineId: this.observedMachineId,
      },
    };
  }

  private observeRuntimeContext(config: AgentConfig): void {
    const ctx = config.runtimeContext;
    if (!this.authenticatedMachineContext) {
      if (ctx?.serverId) this.observedServerId = ctx.serverId;
      if (ctx?.machineId) this.observedMachineId = ctx.machineId;
    }
  }

  private bindAuthenticatedMachineContext(
    context: Extract<ServerToMachineMessage, { type: "machine:context" }>,
  ): void {
    const current = this.authenticatedMachineContext;
    if (current) {
      if (current.machineId === context.machineId && current.serverId === context.serverId) return;
      this.machineContextConflict = true;
      this.scopedAppStorageFactory?.revoke();
      this.scopedAppStorageFactory = null;
      this.scopedAppStorageObserver?.stop();
      this.scopedAppStorageObserver = null;
      this.appInboxes.clear();
      this.recordDaemonEvent("daemon.machine_context.conflict", {
        machine_id_match: current.machineId === context.machineId,
        server_id_match: current.serverId === context.serverId,
      }, "error");
      logger.error("[Daemon] Authenticated machine context changed within one process; App storage is fail-closed until restart");
      return;
    }

    this.authenticatedMachineContext = {
      machineId: context.machineId,
      serverId: context.serverId,
    };
    this.observedMachineId = context.machineId;
    this.observedServerId = context.serverId;
    this.scopedAppStorageObserver = createScopedAppStorageObserver({
      clock: this.appScheduleClock,
      trace: (name, attrs, status) => this.recordDaemonEvent(name, attrs, status),
      serverId: context.serverId,
      writerEpoch: this.daemonInstanceId,
    });
    this.scopedAppStorageFactory = createScopedAppStorageFactory({
      slockHome: this.slockHome,
      owner: this.authenticatedMachineContext,
      writerEpoch: this.daemonInstanceId,
      onFailure: (event) => {
        this.recordDaemonEvent("daemon.app_storage.failure", {
          operation: event.operation,
          store: event.store,
          app: event.appId,
          server_id: event.serverId,
          writer_epoch: event.writerEpoch,
          outcome: event.outcome,
          reason: event.reason,
          ...(event.failureInstanceId === undefined
            ? {}
            : { failure_generation: event.failureInstanceId }),
          ...(event.observation === undefined
            ? {}
            : { corruption_class: event.observation }),
        }, "error");
        this.scopedAppStorageObserver?.observe(event);
      },
    });
    this.localScheduleRuntime.bindScopedStorage(this.scopedAppStorageFactory);
    this.recordDaemonEvent("daemon.machine_context.bound", {
      machine_id_present: true,
      server_id_present: true,
    });
  }

  private async requestRunnerCredentialOnce(agentId: string, config: AgentConfig): Promise<{ apiKey: string; credentialId: string | null }> {
    const url = new URL(`/internal/computer/runners/${encodeURIComponent(agentId)}/credentials`, this.options.serverUrl);
    const res = await daemonFetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
        "X-Raft-Client": "daemon-server-session-worker",
      },
      body: JSON.stringify({
        scopes: RUNNER_CREDENTIAL_SCOPES,
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

  private async mintRunnerCredential(
    agentId: string,
    config: AgentConfig,
    parent: TraceContext | null,
  ): Promise<{ apiKey: string; credentialId: string | null }> {
    if (config.agentCredentialKey) {
      return { apiKey: config.agentCredentialKey, credentialId: config.agentCredentialId ?? null };
    }
    const span = this.tracer.startSpan("daemon.runner_credential_mint", {
      parent,
      surface: "daemon",
      kind: "client",
      attrs: { agentId, runtime: config.runtime },
    });
    try {
      const credential = await this.mintRunnerCredentialWithRetry(agentId, config, span.context);
      span.end("ok");
      return credential;
    } catch (err) {
      span.end("error", { attrs: { error_class: errorClassOf(err) } });
      throw err;
    }
  }

  private async mintRunnerCredentialWithRetry(
    agentId: string,
    config: AgentConfig,
    mintSpan: TraceContext,
  ): Promise<{ apiKey: string; credentialId: string | null }> {
    if (process.env.SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED === "1") {
      throw new RunnerCredentialMintError("runner credential mint is disabled by SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED", {
        code: "runner_credentials_disabled",
      });
    }

    // `rfcs/034-slock-credential-rfc.zh.html#section-credential-model`:
    // Computer/server-session worker asks the server to mint an agent-scoped
    // runner credential. New daemon builds must not silently fall back to the
    // legacy `/internal/agent/:id/*` machine-on-behalf data plane. Server is
    // deployed first; daemon binary rollback is the release-safety mechanism.
    // Retry only retryable mint failures, then hard-fail agent:start loudly.
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.requestRunnerCredentialOnce(agentId, config);
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
        }, detail.retryable && attempt < RUNNER_CREDENTIAL_MINT_MAX_ATTEMPTS ? "ok" : "error", mintSpan);
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
    }, "error", mintSpan);
    throw new RunnerCredentialMintError(
      `runner_credential_mint_failed: ${detail.message}. Managed runner startup requires /internal/computer credential mint; deploy server first or roll back the daemon binary.`,
      {
        code: detail.code,
        retryable: detail.retryable,
        status: detail.status,
      },
    );
  }

  private sendDeliveryAck(msg: AgentDeliverMessage, traceparent?: string): void {
    const ackSeq = msg.seq > 0 ? msg.seq : msg.message.seq ?? 0;
    const ack: MachineToServerMessage = {
      type: "agent:deliver:ack",
      agentId: msg.agentId,
      seq: ackSeq,
      deliveryId: msg.deliveryId,
      mentionDelivery: msg.mentionDelivery,
      ...(traceparent ? { traceparent } : {}),
    };
    this.connection.send(ack);
  }

  private sendMentionDeliveryTransition(
    msg: AgentDeliverMessage,
    stage: "daemon_received" | "daemon_pending" | "daemon_drained",
    outcome: "accepted" | "coalesced",
    traceparent?: string,
  ): void {
    if (!msg.mentionDelivery) return;
    this.connection.send({
      type: "agent:delivery:transition",
      agentId: msg.agentId,
      stage,
      outcome,
      mentionDelivery: msg.mentionDelivery,
      ...(traceparent ? { traceparent } : {}),
    });
  }

  /** task #1113: no process and no snapshot — hand the wake back to the Server with the delivery key. */
  private sendDeliveryRejectedNoProcess(msg: AgentDeliverMessage, traceparent?: string): void {
    this.connection.send({
      type: "agent:delivery:rejected",
      agentId: msg.agentId,
      seq: msg.seq > 0 ? msg.seq : msg.message.seq ?? 0,
      ...(msg.deliveryId ? { deliveryId: msg.deliveryId } : {}),
      reason: "no_process",
      ...(msg.mentionDelivery ? { mentionDelivery: msg.mentionDelivery } : {}),
      ...(traceparent ? { traceparent } : {}),
    });
  }

  private sendMentionDeliveryTerminalError(
    msg: AgentDeliverMessage,
    // task #154: single authoritative union from @botiverse/raft-shared
    // (previously a third inline copy that silently lacked REDELIVERY_EXHAUSTED).
    code: MentionDeliveryTerminalErrorCode,
    traceparent?: string,
  ): void {
    if (!msg.mentionDelivery) return;
    this.connection.send({
      type: "agent:delivery:terminal_error",
      agentId: msg.agentId,
      code,
      mentionDelivery: msg.mentionDelivery,
      ...(traceparent ? { traceparent } : {}),
    });
  }

  private rememberAcceptedStartDispatch(receipt: AgentStartAckMessage): void {
    this.acceptedStartDispatches.delete(receipt.startDispatchId);
    this.acceptedStartDispatches.set(receipt.startDispatchId, receipt);
    while (
      this.acceptedStartDispatches.size
      > DaemonCore.START_DISPATCH_RECEIPT_CACHE_SIZE
    ) {
      const oldest = this.acceptedStartDispatches.keys().next().value;
      if (typeof oldest !== "string") break;
      this.acceptedStartDispatches.delete(oldest);
    }
  }

  private sendStartDispatchReceipt(
    receipt: AgentStartAckMessage,
    outcome: "accepted" | "duplicate",
    startSpan: TraceContext,
  ): void {
    this.recordDaemonEvent("daemon.agent.start_dispatch.receipt", {
      agent_id: receipt.agentId,
      launch_id: receipt.launchId,
      start_dispatch_id: receipt.startDispatchId,
      queue_state: receipt.queueState,
      queue_depth: receipt.queueDepth,
      queue_age_ms: receipt.queueAgeMs,
      outcome,
    }, "ok", startSpan);
    this.connection.send({
      ...receipt,
      traceparent: formatTraceparent(startSpan),
    });
  }

  /**
   * RFC 071 outbox: route the agent manager's frames. Evidence frames get the
   * launch's `generation` and go through the outbox. A refusal for blocked
   * storage cannot be stored either, so it is sent best effort.
   */
  private routeAgentManagerFrame(msg: MachineToServerMessage, connection: DaemonConnection): void {
    if (!isOutboxFrame(msg)) {
      connection.send(msg);
      return;
    }
    const generation = this.launchGenerations.get(msg.agentId)?.get(msg.launchId);
    const frame = generation === undefined ? msg : { ...msg, generation };
    // Only to a server that acks: an older one does not understand the reason
    // (it gets no outbox frame; the refusal is queued like any other).
    if (this.serverAcksRuntimeOutcomes && frame.type === "agent:start:outcome" && frame.result.kind === "not_spawned"
      && frame.result.reason === "terminal_failure_outcome_storage_blocked") {
      connection.send(frame);
      return;
    }
    this.runtimeOutcomeOutbox.enqueue(frame);
  }

  private recordLaunchGeneration(msg: AgentStartMessage): void {
    if (!msg.launchId || msg.breakerGeneration === undefined) return;
    const byLaunch = this.launchGenerations.get(msg.agentId) ?? new Map<string, number>();
    byLaunch.set(msg.launchId, msg.breakerGeneration);
    while (byLaunch.size > 32) byLaunch.delete(byLaunch.keys().next().value!);
    this.launchGenerations.set(msg.agentId, byLaunch);
  }

  /**
   * RFC 071 outbox local refusal (see `RuntimeOutcomeOutbox.decideStart`).
   * A known storage failure or lost critical evidence refuses whatever
   * server is attached; only the ack-dependent parts (reserve, backlog-only
   * markers) need an acking server:
   *  - a start (human too) whose open request / epoch cannot be written, or
   *    (acks) with no reserve: `terminal_failure_outcome_storage_blocked`;
   *  - an AUTOMATIC start while the agent is unreliable, or has an un-acked
   *    marker of lost critical evidence no human takeover covers (any
   *    server), or (acks) a backlog-only marker: `terminal_failure_needs_manual`;
   *  - an admitted human start durably clears the unreliable state (the only
   *    way to clear it), records its takeover, and gets a recovery grant
   *    bound to its launch: the only thing that lets it through the spawn /
   *    rebind gate (passed explicitly to `startAgent`).
   */
  private localStartAdmission(msg: AgentStartMessage): OutboxStartAdmission {
    return this.runtimeOutcomeOutbox.admitServerStart(msg.agentId, {
      takeoverEpoch: msg.takeoverEpoch,
      humanStart: msg.humanStart,
      launchId: msg.launchId,
    });
  }

  private reportAgentStartFailure(msg: AgentStartMessage, err: unknown, startSpan?: TraceContext): void {
    // RFC 071: a launch the process manager did not settle (spawned, rebound,
    // or its own not_spawned) failed here before any process existed.
    this.agentManager.settleServerStartNotSpawned(
      msg.agentId,
      msg.launchId,
      err instanceof LocalStartRefusedError ? err.reason : "start_rejected",
    );
    const classification = classifySpawnFailure(err);
    logger.error(`[Agent ${msg.agentId}] Start failed (${classification.reason}): ${classification.detail}`);
    this.recordDaemonEvent("daemon.agent.spawn.failed", {
      agentId: msg.agentId,
      launchId: msg.launchId,
      start_dispatch_id: msg.startDispatchId,
      runtime: msg.config.runtime,
      model: msg.config.model,
      failure_reason: classification.reason,
      failure_classification: classification.reason === "runtime_spawn_failed"
        ? "unclassified_fallback"
        : "classified",
      session_id_present: Boolean(msg.config.sessionId),
      // The shown refusal text (with the way out) where this daemon refused the start itself.
      ...(err instanceof LocalStartRefusedError ? { local_refusal_detail: err.message } : {}),
    }, "error", startSpan);
    this.agentManager.reportStartFailureStatus(msg.agentId, msg.launchId);
    // Accepted ambient clock: telemetry records the daemon's observed wall-clock time for this failure.
    this.connection.send({
      type: "agent:activity",
      agentId: msg.agentId,
      detail: classification.userMessage,
      detailKind: "runtime_unavailable",
      launchId: msg.launchId,
      observedAtMs: Date.now(),
      isHeartbeat: false,
      // task #1123: the typed reason travels beside the human text so the web
      // picks copy by reason instead of parsing the detail string.
      spawnFailure: {
        reason: classification.reason,
        ...(classification.reason === "model_not_found" && typeof msg.config.model === "string" && msg.config.model
          ? { model: msg.config.model.slice(0, 128) }
          : {}),
      },
    });
  }

  // One consumer span covers the whole start request, including duplicate
  // deliveries. It is passed down by value and never made active, because
  // the agent process started here outlives it.
  private handleAgentStartMessage(msg: AgentStartMessage): void {
    const span = this.tracer.startSpan("daemon.agent.start", {
      parent: parseTraceparent(msg.traceparent),
      surface: "daemon",
      kind: "consumer",
      attrs: {
        agent_id: msg.agentId,
        launch_id: msg.launchId,
        start_dispatch_id: msg.startDispatchId,
        runtime: msg.config.runtime,
      },
    });
    const endWithFailure = (err: unknown) => {
      this.reportAgentStartFailure(msg, err, span.context);
      span.end("error", { attrs: { outcome: "failed", error_class: errorClassOf(err) } });
    };

    if (!msg.startDispatchId) {
      this.startAgentFromMessage(msg, span.context).then(
        () => span.end("ok", { attrs: { outcome: "started" } }),
        endWithFailure,
      );
      return;
    }

    const accepted = this.acceptedStartDispatches.get(msg.startDispatchId);
    if (accepted) {
      this.sendStartDispatchReceipt(accepted, "duplicate", span.context);
      span.end("ok", { attrs: { outcome: "duplicate" } });
      return;
    }
    const accepting = this.acceptingStartDispatches.get(msg.startDispatchId);
    if (accepting) {
      void accepting.then((receipt) => {
        this.sendStartDispatchReceipt(receipt, "duplicate", span.context);
        span.end("ok", { attrs: { outcome: "duplicate" } });
      }).catch((err: unknown) => {
        span.end("error", { attrs: { outcome: "duplicate_failed", error_class: errorClassOf(err) } });
      });
      return;
    }

    let resolveAccepted!: (receipt: AgentStartAckMessage) => void;
    let rejectAccepted!: (err: unknown) => void;
    const acceptance = new Promise<AgentStartAckMessage>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    // The first receipt path observes failure through startAgentFromMessage;
    // this promise exists only to fan acceptance out to duplicate deliveries.
    void acceptance.catch(() => {});
    this.acceptingStartDispatches.set(msg.startDispatchId, acceptance);
    this.startAgentFromMessage(msg, span.context, (receipt) => {
      this.rememberAcceptedStartDispatch(receipt);
      resolveAccepted(receipt);
      this.sendStartDispatchReceipt(receipt, "accepted", span.context);
    }).then(() => {
      span.end("ok", { attrs: { outcome: "started" } });
    }, (err: unknown) => {
      rejectAccepted(err);
      endWithFailure(err);
    }).finally(() => {
      this.acceptingStartDispatches.delete(msg.startDispatchId!);
    });
  }

  private async startAgentFromMessage(
    msg: AgentStartMessage,
    startSpan: TraceContext,
    onAccepted?: (receipt: AgentStartAckMessage) => void,
  ): Promise<void> {
    // RFC 071: from here this launch owes one final result (spawned, rebound,
    // or not_spawned); reportAgentStartFailure settles it if nothing else did.
    this.recordLaunchGeneration(msg);
    // A start refused at admission already has its result (`admission_full`).
    if (!this.agentManager.noteServerStartAccepted(msg.agentId, msg.launchId)) {
      this.reportAgentStartFailure(msg, new Error("Too many starts are still waiting for a result on this agent"), startSpan);
      return;
    }
    // RFC 071 outbox local refusal: before the agent counts as starting, so a
    // refused start leaves no starting state behind.
    const admission = this.localStartAdmission(msg);
    if (admission.refusal) throw new LocalStartRefusedError(admission.refusal);
    const recoveryGrant = admission.recoveryGrant;
    this.coreStartingAgentIds.add(msg.agentId);
    // Reminder sync fallback: a starting agent may own reminders that no
    // connect-time snapshot covered (e.g. it arrived by migration after this
    // connection was established). Guarded no-op when already synchronized.
    this.localScheduleRuntime.requestReminderSnapshotIfUnsynchronized(msg.agentId);
    this.localScheduleRuntime.requestAppConfigSnapshotIfMissing(msg.agentId);
    let wakeDeliveryAck: AgentDeliverMessage | null = null;
    let replayDeliveries: AgentDeliverMessage[] = [];
    try {
      this.observeRuntimeContext(msg.config);
      const agentCredential = await this.mintRunnerCredential(msg.agentId, msg.config, startSpan);
      const config = { ...msg.config, agentCredentialKey: agentCredential.apiKey, agentCredentialId: agentCredential.credentialId };

      const pendingDeliveries = this.coreStartPendingDeliveries.get(msg.agentId) || [];
      this.coreStartPendingDeliveries.delete(msg.agentId);
      let wakeMessage = msg.wakeMessage;
      let wakeMessageTransient = msg.wakeMessageTransient ?? false;
      replayDeliveries = [...pendingDeliveries];
      if (!wakeMessage) {
        const wakeIndex = selectWakeDeliveryIndex(replayDeliveries);
        if (wakeIndex >= 0) {
          const [wakeDelivery] = replayDeliveries.splice(wakeIndex, 1);
          if (wakeDelivery) {
            wakeDeliveryAck = wakeDelivery;
            wakeMessage = wakeDelivery.message;
            wakeMessageTransient = wakeDelivery.transient ?? false;
          }
        }
      }

      const startPromise = this.agentManager.startAgent(
        msg.agentId,
        config,
        wakeMessage,
        msg.unreadSummary,
        msg.resumePrompt,
        msg.launchId,
        wakeMessageTransient,
        msg.resumeMessages,
        msg.startDispatchId,
        startSpan,
        msg.catchupBatchId,
        recoveryGrant,
      );
      if (msg.startDispatchId) {
        const acceptance = this.agentManager.getAgentStartAcceptance(msg.agentId);
        // Machine-local evidence for the dispatch → ack → frame chain (#1129):
        // the runner log must show which launch this daemon acknowledged.
        logger.info(
          `[Agent ${msg.agentId}] Start accepted ` +
          `(launchId=${msg.launchId ?? "none"}, dispatchId=${msg.startDispatchId}, queue=${acceptance.queueState})`,
        );
        onAccepted?.({
          type: "agent:start:ack",
          agentId: msg.agentId,
          launchId: msg.launchId,
          startDispatchId: msg.startDispatchId,
          queueState: acceptance.queueState,
          queueDepth: acceptance.queueDepth,
          queueAgeMs: acceptance.queueAgeMs,
          ...(acceptance.processInstanceId ? { processInstanceId: acceptance.processInstanceId } : {}),
        });
      }
      await startPromise;

      this.coreStartingAgentIds.delete(msg.agentId);
      if (wakeDeliveryAck && !wakeDeliveryAck.mentionDelivery) {
        this.sendDeliveryAck(wakeDeliveryAck);
      }
      for (const delivery of replayDeliveries) {
        this.handleMessage(delivery);
      }
    } catch (err) {
      this.coreStartPendingDeliveries.delete(msg.agentId);
      // A start that failed before its gate cannot keep its grant.
      this.runtimeOutcomeOutbox.releaseRecoveryGrant(recoveryGrant);
      throw err;
    } finally {
      this.coreStartingAgentIds.delete(msg.agentId);
    }
  }

  private handleMessage(msg: ServerToMachineMessage) {
    const summary = summarizeIncomingMessage(msg);
    logger.info(`[Daemon] Received ${msg.type}${summary ? ` ${summary}` : ""}`);
    if (this.localScheduleRuntime.handleServerMessage(msg)) return;

    switch (msg.type) {
      case "machine:context":
        this.bindAuthenticatedMachineContext(msg);
        // RFC 071 outbox: deliver only to a server that acknowledges; an older
        // server (or a context conflict) pauses delivery and keeps the queue.
        this.serverAcksRuntimeOutcomes = !this.machineContextConflict
          && (msg.capabilities ?? []).includes(SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1);
        this.runtimeOutcomeOutbox.onServerContext(this.serverAcksRuntimeOutcomes);
        break;

      case "agent:outcome:ack":
        this.runtimeOutcomeOutbox.ack(msg);
        break;

      case "agent:start":
        this.observeRuntimeContext(msg.config);
        logger.info(`[Agent ${msg.agentId}] Start requested (runtime=${msg.config.runtime}, model=${msg.config.model}, session=${msg.config.sessionId || "new"}${msg.wakeMessage ? ", wake=true" : ""})`);
        this.handleAgentStartMessage(msg);
        break;

      case "agent:start:wiki":
        this.agentManager.noteServerStartAccepted(msg.agentId, msg.launchId);
        this.reportAgentStartFailure(msg, new Error("Wiki has been retired"));
        break;

      case "agent:workspace:ensure-wiki":
        this.connection.send({
          type: "agent:workspace:wiki_ensured",
          agentId: msg.agentId,
          requestId: msg.requestId,
          success: false,
          packId: msg.pack.packId,
          files: [],
          error: "Wiki has been retired",
        });
        break;

      case "agent:stop":
        logger.info(`[Agent ${msg.agentId}] Stop requested`);
        this.agentManager.stopAgent(msg.agentId);
        break;

      case "agent:wake:outcome":
        this.agentManager.handleServerWakeOutcome(msg);
        break;

      case "agent:reset-workspace":
        logger.info(`[Agent ${msg.agentId}] Workspace reset requested`);
        this.agentManager.resetWorkspace(msg.agentId);
        break;

      case "agent:inbox:purge":
        logger.info(`[Agent ${msg.agentId}] Inbox purge requested (${msg.channelIds.length} channels, reason=${msg.reason || "server_purge"})`);
        this.agentManager.purgeInboxMessagesForChannels(msg.agentId, msg.channelIds, msg.reason || "server_purge");
        break;

      case "agent:deliver":
      {
        const parent = parseTraceparent(msg.traceparent);
        const span = this.tracer.startSpan("daemon.agent.delivery", {
          parent,
          surface: "daemon",
          kind: "consumer",
          attrs: {
            agentId: msg.agentId,
            deliveryId: msg.deliveryId,
            delivery_correlation_id: msg.deliveryId ?? msg.message.message_id,
            messageId: msg.message.message_id,
            message_id_present: Boolean(msg.message.message_id),
            seq: msg.seq,
          },
        });
        logger.info(`[Agent ${msg.agentId}] Delivery received (seq=${msg.seq}, from=@${msg.message.sender_name}, target=${formatChannelTarget(msg)})`);
        try {
          span.addEvent("daemon.receive", { seq: msg.seq, deliveryId: msg.deliveryId });
          if (msg.mentionDelivery) {
            const machineId = this.authenticatedMachineContext?.machineId ?? this.observedMachineId;
            if (
              !machineId
              || msg.mentionDelivery.machineId !== machineId
              || msg.mentionDelivery.occurrenceId !== msg.deliveryId
              || msg.mentionDelivery.messageId !== msg.message.message_id
            ) {
              this.sendMentionDeliveryTerminalError(
                msg,
                machineId && msg.mentionDelivery.machineId !== machineId ? "IDENTITY_DRIFT" : "INSTRUMENT_FAILED",
                formatTraceparent(span.context),
              );
              span.end("ok", { attrs: { outcome: "mention-identity-rejected" } });
              break;
            }
          }
          if (this.coreStartingAgentIds.has(msg.agentId)) {
            const pending = this.coreStartPendingDeliveries.get(msg.agentId) || [];
            pending.push(msg);
            this.coreStartPendingDeliveries.set(msg.agentId, pending);
            span.addEvent("daemon.delivery.buffered_for_start", { pending_count: pending.length });
            span.end("ok", { attrs: { outcome: "buffered-for-start", pending_count: pending.length } });
            break;
          }

          // The routing facts the agent manager records for this delivery
          // (`daemon.agent.delivery.routed`, consumption, stdin retries) belong
          // under this span. Work that outlives the delivery, such as an idle
          // auto-restart spawn, leaves the scope inside the agent manager.
          const acceptedOrPromise = runWithActiveSpan(span, () => this.agentManager.deliverMessage(msg.agentId, msg.message, {
            deliveryId: msg.deliveryId,
            transient: msg.transient ?? false,
            mentionDelivery: msg.mentionDelivery,
            onMentionTransition: (stage, outcome) => this.sendMentionDeliveryTransition(
              msg,
              stage,
              outcome,
              formatTraceparent(span.context),
            ),
            onMentionTerminalError: (code) => this.sendMentionDeliveryTerminalError(
              msg,
              code,
              formatTraceparent(span.context),
            ),
            onMentionAck: () => this.sendDeliveryAck(msg, formatTraceparent(span.context)),
            onRejectedNoProcess: () => this.sendDeliveryRejectedNoProcess(msg, formatTraceparent(span.context)),
          }));
          Promise.resolve(acceptedOrPromise).then((accepted) => {
            span.addEvent("daemon.deliver_to_agent_manager", { accepted });
            if (!accepted) {
              span.end("ok", { attrs: { outcome: "not-accepted" } });
              return;
            }
            if (msg.mentionDelivery) {
              span.end("ok", { attrs: { outcome: "mention-accepted-awaiting-terminal-ack", deliveryId: msg.deliveryId } });
              return;
            }
            const ackSeq = msg.seq > 0 ? msg.seq : msg.message.seq ?? 0;
            span.addEvent("daemon.ack.sent", { seq: ackSeq });
            this.sendDeliveryAck(msg, formatTraceparent(span.context));
            span.end("ok", { attrs: { outcome: "ack-sent", ackSeq, deliveryId: msg.deliveryId } });
          }, (err: unknown) => {
            logger.error(`[Agent ${msg.agentId}] Delivery handling failed`, err);
            span.end("error", { attrs: { error_class: errorClassOf(err) } });
          });
        } catch (err) {
          span.end("error", { attrs: { error_class: errorClassOf(err) } });
          throw err;
        }
        break;
      }

      case "agent:runtime_profile:migration": {
        const span = this.tracer.startSpan("daemon.runtime_profile.control.received", {
          parent: parseTraceparent(msg.traceparent),
          surface: "daemon",
          kind: "consumer",
          attrs: {
            agentId: msg.agentId,
            control_kind: "migration",
            key_present: Boolean(msg.migrationKey),
            launchId: msg.launchId || undefined,
          },
        });
        logger.info(`[Agent ${msg.agentId}] Runtime profile migration received (${msg.migrationKey})`);
        Promise.resolve(
          this.agentManager.deliverRuntimeProfileNotification(msg.agentId, msg.migrationKey, "migration", msg.message, formatTraceparent(span.context), msg.launchId || null),
        ).then((accepted) => {
          span.end("ok", { attrs: { outcome: accepted ? "accepted" : "no_injection_path" } });
        }, (err: unknown) => {
          logger.error(`[Agent ${msg.agentId}] Runtime profile migration handling failed`, err);
          span.end("error", { attrs: { error_class: errorClassOf(err) } });
        });
        break;
      }

      case "agent:runtime_profile:daemon_release_notice": {
        const span = this.tracer.startSpan("daemon.runtime_profile.control.received", {
          parent: parseTraceparent(msg.traceparent),
          surface: "daemon",
          kind: "consumer",
          attrs: {
            agentId: msg.agentId,
            control_kind: "daemon_release_notice",
            key_present: Boolean(msg.noticeKey),
            launchId: msg.launchId || undefined,
          },
        });
        logger.info(`[Agent ${msg.agentId}] Runtime profile daemon release notice received (${msg.noticeKey})`);
        Promise.resolve(
          this.agentManager.deliverRuntimeProfileNotification(msg.agentId, msg.noticeKey, "daemon_release_notice", msg.message, formatTraceparent(span.context), msg.launchId || null),
        ).then((accepted) => {
          span.end("ok", { attrs: { outcome: accepted ? "accepted" : "no_injection_path" } });
        }, (err: unknown) => {
          logger.error(`[Agent ${msg.agentId}] Runtime profile daemon release notice handling failed`, err);
          span.end("error", { attrs: { error_class: errorClassOf(err) } });
        });
        break;
      }

      case "agent:workspace:list":
        this.agentManager.getFileTree(msg.agentId, msg.dirPath, Boolean(msg.includeHidden)).then((files) => {
          this.connection.send({ type: "agent:workspace:file_tree", agentId: msg.agentId, files, dirPath: msg.dirPath, includeHidden: Boolean(msg.includeHidden) });
        });
        break;

      case "agent:workspace:read":
        this.agentManager.readFile(msg.agentId, msg.path).then(({ content, binary, size, mimeType, encoding }) => {
          this.connection.send({
            type: "agent:workspace:file_content",
            agentId: msg.agentId,
            requestId: msg.requestId,
            content,
            binary,
            size,
            mimeType,
            encoding,
          });
        }).catch(() => {
          this.connection.send({
            type: "agent:workspace:file_content",
            agentId: msg.agentId,
            requestId: msg.requestId,
            content: null,
            binary: false,
            size: 0,
          });
        });
        break;

      case "agent:skills:list":
      {
        const span = this.tracer.startSpan("daemon.agent.skills.list", {
          surface: "daemon",
          kind: "internal",
          attrs: {
            agent_id: msg.agentId,
            runtime: msg.runtime || "auto",
            request_id_present: Boolean(msg.requestId),
            ...(msg.requestId ? { request_id: msg.requestId } : {}),
          },
        });
        this.agentManager.listSkills(msg.agentId, msg.runtime).then(({ global, workspace }) => {
          this.connection.send({ type: "agent:skills:list_result", agentId: msg.agentId, requestId: msg.requestId, global, workspace });
          span.end("ok", {
            attrs: {
              outcome: "skills_returned",
              global_count: global.length,
              workspace_count: workspace.length,
            },
          });
        }).catch((err: unknown) => {
          logger.error(`[Daemon] Failed to list skills for ${msg.agentId}`, err);
          this.connection.send({ type: "agent:skills:list_result", agentId: msg.agentId, requestId: msg.requestId, global: [], workspace: [] });
          span.end("error", {
            attrs: {
              outcome: "skills_list_failed",
              error_class: errorClassOf(err),
            },
          });
        });
        break;
      }

      case "agent:diagnostic:session_transcript":
        this.agentManager.getSessionTranscript(msg.agentId).then((result) => {
          this.connection.send({ type: "agent:diagnostic:session_transcript_result", agentId: msg.agentId, requestId: msg.requestId, ...result });
        }).catch((err: unknown) => {
          logger.error(`[Daemon] Failed to get session transcript for ${msg.agentId}`, err);
          this.connection.send({
            type: "agent:diagnostic:session_transcript_result",
            agentId: msg.agentId,
            requestId: msg.requestId,
            runtime: "unknown",
            sessionId: "unknown",
            reachable: false,
            path: null,
            transcript: null,
            sizeBytes: 0,
            truncated: false,
            redacted: false,
            tier: "unknown",
            error: err instanceof Error ? err.message : String(err),
          });
        });
        break;

      case "agent:diagnostic:feedback_transcript": {
        // task #1228 ①: collect → send the result frame → only then upload the
        // transcript_outcome object (best-effort, never retried, never able to
        // delay or rewrite the result).
        const daemonVersion = readBakedDaemonVersion();
        void runFeedbackTranscriptRequest({
          collect: () => this.agentManager.collectFeedbackTranscript(msg.agentId, msg.feedbackReportId, {
            reportGeneratedAt: msg.feedbackReportGeneratedAt ?? currentDate().toISOString(),
            reportTimeSource: msg.feedbackReportTimeSource ?? "server_request_received",
          }, {
            includeMachineLogTail: msg.includeMachineLogTail === true,
            machineLogPaths: this.runnerLogPathCandidates(),
            daemonVersion,
            requestId: msg.requestId,
          }),
          send: (result) => {
            this.connection.send({
              type: "agent:diagnostic:feedback_transcript_result",
              agentId: msg.agentId,
              feedbackReportId: msg.feedbackReportId,
              requestId: msg.requestId,
              ...result,
            });
          },
          uploadOutcome: (result) => this.agentManager.uploadFeedbackTranscriptOutcome(
            msg.agentId,
            msg.feedbackReportId,
            msg.requestId,
            result,
            daemonVersion ?? null,
          ),
          workerConfigured: this.agentManager.feedbackUploadsConfigured,
          tag: `report=${msg.feedbackReportId} agent=${msg.agentId} request=${msg.requestId}`,
        });
        break;
      }

      case "agent:activity_probe":
        // Server is asking for ground-truth current activity. Echo
        // back via the same `agent:activity` upstream channel,
        // tagged with the probeId so server can correlate. Keeps
        // this surface unobtrusive: probe response goes through the
        // existing ingest pipeline, with launch-guard / lifecycle
        // checks intact. See agentProcessManager.respondToActivityProbe.
        this.agentManager.respondToActivityProbe(msg.agentId, msg.probeId);
        break;

      case "machine:workspace:scan":
        logger.info("[Daemon] Scanning all workspace directories");
        this.agentManager.scanAllWorkspaces().then((directories) => {
          this.connection.send({ type: "machine:workspace:scan_result", directories });
        });
        break;

      case "machine:workspace:delete":
        logger.info(`[Daemon] Deleting workspace directory: ${msg.directoryName}`);
        this.agentManager.deleteWorkspaceDirectory(msg.directoryName).then((success) => {
          this.connection.send({ type: "machine:workspace:delete_result", directoryName: msg.directoryName, success });
        });
        break;

      // Re-detect installed runtimes on demand. `emitReady` already re-runs the
      // detector and pushes the fresh capabilities, and the server fans those out
      // as `machine:capabilities` — so re-emitting IS the answer, no bespoke
      // result message needed.
      case "machine:runtimes:rescan":
        if (this.connection.connected) {
          void this.emitReady().then((readySent) => {
            if (readySent) this.requestRuntimeModelCatalogPublish(true);
          });
        }
        break;

      case "machine:migration:source_workspace_archive": {
        void this.archiveMigrationSourceWorkspaceSerialized(msg.agentId, msg.migrationId, msg.migrationCreatedAt).then(
          (outcome) => {
            this.connection.send({
              type: "machine:migration:source_workspace_archive_result",
              requestId: msg.requestId,
              migrationId: msg.migrationId,
              agentId: msg.agentId,
              outcome,
            });
          },
          (error: unknown) => {
            logger.error(`[Daemon] Failed to archive migrated workspace for ${msg.agentId}`, error);
            const errorCode = migrationTransferFailureDetailCode(error);
            this.connection.send({
              type: "machine:migration:source_workspace_archive_result",
              requestId: msg.requestId,
              migrationId: msg.migrationId,
              agentId: msg.agentId,
              outcome: "error",
              ...(errorCode ? { errorCode } : {}),
            });
          },
        );
        break;
      }

      case "machine:provider_probe:request": {
        void this.handleProviderProbe(msg);
        break;
      }

      case "machine:runtime_models:detect": {
        const driver = getDriver(msg.runtime);
        const span = this.tracer.startSpan("daemon.runtime_models.detect", {
          surface: "daemon",
          kind: "internal",
          attrs: {
            runtime: msg.runtime,
            requestId: msg.requestId,
          },
        });
        const joinedInFlight = this.probeGate.activeKeys.includes(`runtime_models:${msg.runtime}`);
        const detect = this.detectRuntimeModelOutcome(msg.runtime, span);
        void detect.then((detectedOutcome) => {
          const resultMessage = buildRuntimeModelSourceResultMessage(
            msg.requestId,
            detectedOutcome,
            driver?.model.detectedModelsVerifiedAs ?? "suggestion_only",
          );
          const outcome = resultMessage.outcome!;
          this.connection.send(resultMessage);
          if (outcome.kind === "live") {
            span.end("ok", {
              attrs: {
                outcome: "models_returned",
                models_count: outcome.value.models.length,
                joined_in_flight: joinedInFlight,
                default_model_present: Boolean(outcome.value.default),
                verified_as: driver?.model.detectedModelsVerifiedAs ?? "suggestion_only",
              },
            });
          } else {
            span.end("ok", {
              attrs: {
                outcome: outcome.kind,
                models_count: 0,
                joined_in_flight: joinedInFlight,
              },
            });
          }
        }).catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          this.connection.send({
            type: "machine:runtime_models:result",
            requestId: msg.requestId,
            outcome: { kind: "error", retryable: true },
            error: reason,
          });
          span.end("error", {
            attrs: {
              outcome: "error",
              error_class: errorClassOf(err),
            },
          });
        });
        break;
      }

      case "machine:runtime_account_usage:refresh": {
        const provider: RuntimeAccountUsageProvider = msg.provider;
        void this.probeGate.run(`runtime_account_usage:${provider}`, () => this.runtimeAccountUsageCollector(provider)).then((snapshot: RuntimeAccountUsageSnapshot) => {
          this.connection.send({
            type: "machine:runtime_account_usage:snapshot",
            requestId: msg.requestId,
            snapshot,
          });
          this.recordDaemonEvent("daemon.runtime_account_usage.refresh", {
            outcome: "snapshot_sent",
            provider,
            reason: msg.reason,
            account_count: snapshot.accounts.length,
            window_count: snapshot.accounts.reduce((total, account) => total + account.windows.length, 0),
            health_classes: [...new Set(snapshot.accounts.map((account) => account.health))].sort().join(",") || "none",
            parse_unavailable_count: snapshot.accounts.reduce(
              (total, account) => total + account.windows.filter((window) => window.status === "parse_unavailable").length,
              0,
            ),
          });
        }).catch((err: unknown) => {
          logger.warn(`[Daemon] Runtime account usage refresh failed (${provider}): ${err instanceof Error ? err.message : String(err)}`);
          this.recordDaemonEvent("daemon.runtime_account_usage.refresh", {
            outcome: "collector_error",
            provider,
            reason: msg.reason,
            error_class: errorClassOf(err),
          });
        });
        break;
      }

      case "machine:migration_transport:lease":
        this.handleMigrationTransportLease(msg);
        break;

      case "machine:migration:cancel":
        void this.handleMigrationCancellation(msg);
        break;

      case "ping":
        this.connection.send({ type: "pong" });
        break;

      case "computer:restart":
      case "computer:upgrade": {
        // Managed-Computer remote control. Only acts when this runner was
        // launched by a Computer service (onComputerControl wired); a raw
        // daemon has no service to drive and ignores it.
        const action = msg.type === "computer:restart" ? "restart" : "upgrade";
        const operationId = msg.operationId ?? msg.requestId;
        const requestId = msg.requestId ?? msg.operationId;
        const alreadyDurable = operationId
          ? this.options.getComputerLifecycleAcks?.().some((ack) =>
              (ack.operationId ?? ack.requestId) === operationId
            ) ?? false
          : false;
        if (operationId && (alreadyDurable || this.handledComputerControlOperationIds.has(operationId))) {
          this.recordDaemonEvent("daemon.computer_control.replayed", {
            action,
            operation_id: operationId,
            outcome: "ignored",
          });
          break;
        }
        if (operationId) this.handledComputerControlOperationIds.add(operationId);
        this.recordDaemonEvent("daemon.computer_control.received", {
          action,
          handled: Boolean(this.options.onComputerControl),
          ...(operationId ? { operation_id: operationId } : {}),
          ...(requestId ? { request_id: requestId } : {}),
        });
        if (this.options.onComputerControl) {
          const ctx: ComputerControlContext = {
            operationId,
            requestId,
            ...(msg.type === "computer:upgrade" && typeof msg.targetVersion === "string" ? { targetVersion: msg.targetVersion } : {}),
          };
          // May be async while the runner relays supervisor progress; don't
          // block the message loop — surface failures via logs/trace.
          void Promise.resolve()
            .then(() => this.options.onComputerControl!(action, ctx))
            .catch((err) => {
              const message = err instanceof Error ? err.message : String(err);
              const failure = /(?:^|\b)CONTROL_BUSY(?:\b|:)/.test(message)
                ? "control_busy"
                : /(?:^|\b)SELF_RELAUNCH_UNAVAILABLE(?:\b|:)/.test(message)
                  ? "self_relaunch_unavailable"
                  : "computer_control_failed";
              logger.error(
                `[Daemon] computer:${action} control handler failed: ${message}`,
              );
              if (!requestId) return;
              if (action === "restart") {
                this.connection.send({
                  type: "computer:restart:done",
                  requestId,
                  ok: false,
                  error: failure,
                });
              }
              // upgrade: nothing to report; the machine's reconnect version is the readback.
            });
        } else {
          logger.info(`[Daemon] Ignoring computer:${action} — not launched by a Computer service.`);
        }
        break;
      }

      case "computer:lifecycle:receipt": {
        if (this.options.onComputerLifecycleReceipt) {
          void Promise.resolve(this.options.onComputerLifecycleReceipt(msg.operationId, msg.phase))
            .catch((err) => {
              logger.warn(
                `[Daemon] lifecycle receipt persistence failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        }
        break;
      }
    }
  }

  /**
   * One detection path for both the on-demand `runtime_models:detect` request and
   * the unsolicited catalog push. Shares the probe gate key, so a push and a
   * request for the same runtime join one detection instead of spawning twice.
   */
  private detectRuntimeModelOutcome(runtime: string, span: ActiveSpan): Promise<RuntimeModelSourceOutcome> {
    const driver = getDriver(runtime);
    const staticSource = driver ? getStaticRuntimeModelSourceSet(runtime) : undefined;
    if (typeof driver?.detectModels === "function") {
      return this.probeGate.run(`runtime_models:${runtime}`, () => driver.detectModels!({ tracer: this.tracer, span }));
    }
    return Promise.resolve(staticSource ? { kind: "live", value: staticSource } : { kind: "unsupported" });
  }

  /**
   * Push each detected runtime's model list (id + the runtime's own label) so the
   * server holds the single copy every model-name surface reads. Runtimes run one
   * at a time to avoid spawning every CLI at once on connect. Only a live result
   * is sent: an error, missing login or unsupported runtime leaves the server's
   * previous copy in place rather than blanking it.
   */
  /**
   * Single-flight entry for the catalog push. Detection spawns each runtime's CLI
   * (some take seconds), so a flapping connection must not re-run it on every
   * reconnect: a connect-triggered push is skipped when a complete round ran
   * within MODEL_CATALOG_RECONNECT_MIN_INTERVAL_MS and the runtime ids/versions
   * are unchanged, or when any round (complete or not) started within
   * MODEL_CATALOG_RECONNECT_MIN_START_INTERVAL_MS. `rescan` forces a round. A trigger arriving mid-round is
   * folded into one follow-up round after the current one.
   */
  private requestRuntimeModelCatalogPublish(force: boolean): void {
    if (this.catalogPublishInFlight) {
      this.catalogPublishQueued = { force: force || (this.catalogPublishQueued?.force ?? false) };
      return;
    }
    const runtimeSignature = this.lastReadyRuntimeSignature;
    const now = currentTimeMs();
    if (!force) {
      if (
        this.lastCatalogPublish?.runtimeSignature === runtimeSignature
        && now - this.lastCatalogPublish.atMs < MODEL_CATALOG_RECONNECT_MIN_INTERVAL_MS
      ) {
        return;
      }
      if (this.lastCatalogRoundStartMs !== null && now - this.lastCatalogRoundStartMs < MODEL_CATALOG_RECONNECT_MIN_START_INTERVAL_MS) {
        return;
      }
    }
    this.lastCatalogRoundStartMs = now;
    this.catalogPublishInFlight = true;
    void this.publishRuntimeModelCatalogs()
      .then((completed) => {
        // Only a round that reached every runtime while connected counts; a
        // round cut short by a disconnect must not suppress the next connect.
        if (completed) this.lastCatalogPublish = { atMs: currentTimeMs(), runtimeSignature };
      })
      .finally(() => {
        this.catalogPublishInFlight = false;
        const queued = this.catalogPublishQueued;
        this.catalogPublishQueued = null;
        if (queued && this.connection.connected) this.requestRuntimeModelCatalogPublish(queued.force);
      });
  }

  /**
   * Returns true only when every runtime's result reached the same connection the
   * round started on. The connection generation moves on every disconnect and
   * connect, so a flap between two runtimes (even one that reconnects before the
   * next check) marks the round incomplete and the next connect pushes again.
   */
  private async publishRuntimeModelCatalogs(): Promise<boolean> {
    const generation = this.lifecycleOriginConnectionGeneration;
    const sameConnection = () => this.connection.connected && generation === this.lifecycleOriginConnectionGeneration;
    for (const runtime of this.lastReadyRuntimes) {
      if (!sameConnection()) return false;
      const span = this.tracer.startSpan("daemon.runtime_models.catalog", {
        surface: "daemon",
        kind: "internal",
        attrs: { runtime },
      });
      try {
        const outcome = await this.detectRuntimeModelOutcome(runtime, span);
        const models = outcome.kind === "live" ? sanitizeCatalogModels(outcome.value.models) : [];
        if (models.length > 0) {
          if (!sameConnection()) {
            span.end("ok", { attrs: { outcome: "connection_changed", models_count: models.length } });
            return false;
          }
          this.connection.send({ type: "machine:runtime_models:catalog", runtime, models });
        }
        span.end("ok", { attrs: { outcome: models.length > 0 ? "sent" : outcome.kind, models_count: models.length } });
      } catch (err) {
        span.end("error", { attrs: { outcome: "error", error_class: errorClassOf(err) } });
      }
    }
    return sameConnection();
  }

  private emitReadyIfConnected(): void {
    if (this.connection.connected) void this.emitReady();
  }

  private async emitReady(expectedLifecycleGeneration?: number): Promise<boolean> {
    const { ids: runtimes, versions: runtimeVersions, diagnostics: runtimeDiagnostics = {} } = this.runtimeDetector();
    this.lastReadyRuntimes = runtimes;
    this.lastReadyRuntimeSignature = JSON.stringify(runtimes.map((id) => [id, runtimeVersions[id] ?? null]));
    const runtimeInfo = runtimes.map((id) => runtimeVersions[id] ? `${id} (${runtimeVersions[id]})` : id);
    logger.info(`[Daemon] Detected runtimes: ${runtimeInfo.join(", ") || "none"}`);
    for (const [runtime, diagnostic] of Object.entries(runtimeDiagnostics)) {
      logger.warn(`[Daemon] Runtime ${runtime} diagnostic: ${diagnostic}`);
    }
    const runningAgentIds = this.agentManager.getRunningAgentIds();
    const idleAgentSessions = this.agentManager.getIdleAgentSessionIds();
    const runtimeProfileReports = this.agentManager.getAgentRuntimeProfileReports();

    let lifecycleAcks = this.options.getComputerLifecycleAcks?.() ?? [];
    if (this.options.getComputerLifecycleReadyAcks) {
      try {
        lifecycleAcks = await this.options.getComputerLifecycleReadyAcks();
      } catch (error) {
        logger.warn(`[Daemon] Computer lifecycle attestation skipped: ${error instanceof Error ? error.message : String(error)}`);
        this.recordConnectLifecycleError("lifecycle_attestation", "attestation_threw", error);
        lifecycleAcks = [];
      }
    }
    let lastUpgradeReceipt: ComputerLastUpgradeReceipt | null = null;
    if (this.options.getComputerLastUpgradeReceipt) {
      try {
        lastUpgradeReceipt = await this.options.getComputerLastUpgradeReceipt();
      } catch (error) {
        this.recordConnectLifecycleError("last_upgrade_receipt", "receipt_read_threw", error);
        lastUpgradeReceipt = null;
      }
    }
    if (expectedLifecycleGeneration !== undefined
      && (expectedLifecycleGeneration !== this.lifecycleOriginConnectionGeneration
        || !this.connection.connected)) {
      return false;
    }
    this.connection.send({
      type: "ready",
      capabilities: [
        "agent:start",
        "agent:stop",
        "agent:deliver",
        "workspace:files",
        DAEMON_CAPABILITY_SEQUENCED_STATUS,
        // RFC 071: agent:runtime:outcome v1, process spawned/exited, rebind
        // ack processInstanceId, catchupBatchId echo.
        DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1,
        ...BUILT_IN_READY_CAPABILITIES,
        ...(this.options.computerControlViaSupervisor
          ? [COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS]
          : []),
      ],
      daemonInstanceId: this.daemonInstanceId,
      ...(this.runtimeOutcomeOutbox.unreliableAgents().length > 0
        ? { runtimeOutcomeUnreliableAgents: this.runtimeOutcomeOutbox.unreliableAgents() }
        : {}),
      runtimes,
      runtimeVersions,
      runningAgents: runningAgentIds,
      hostname: this.options.hostname ?? os.hostname(),
      os: this.options.osDescription ?? `${os.platform()} ${os.arch()}`,
      daemonVersion: this.daemonVersion,
      ...(this.computerVersion ? { computerVersion: this.computerVersion } : {}),
      migrationTransport: this.getMigrationTransportReady(),
      ...((this.options.getComputerLifecycleAcks || this.options.getComputerLifecycleReadyAcks)
        ? { lifecycleAcks }
        : {}),
      ...(lastUpgradeReceipt ? { lastUpgradeReceipt } : {}),
    });
    // Fresh disk report shortly after every (re)connect, then hourly.
    this.scheduleDiskStatusReport(DISK_STATUS_FIRST_REPORT_DELAY_MS);
    this.recordDaemonEvent("daemon.ready.sent", {
      runtimes_count: runtimes.length,
      running_agents_count: runningAgentIds.length,
      idle_agents_count: idleAgentSessions.length,
      runtime_profile_reports_count: runtimeProfileReports.length,
    });
    return true;
  }

  private scheduleDiskStatusReport(delayMs: number): void {
    if (this.diskStatusTimer !== null) clearTimeout(this.diskStatusTimer);
    this.diskStatusTimer = setTimeout(() => {
      this.diskStatusTimer = null;
      void this.sendDiskStatus().finally(() => {
        if (this.diskStatusReportsEnabled) this.scheduleDiskStatusReport(DISK_STATUS_REPORT_INTERVAL_MS);
      });
    }, delayMs);
    this.diskStatusTimer.unref?.();
  }

  private async sendDiskStatus(): Promise<void> {
    const info = await statfs(this.agentsDataDir).catch(() => null);
    if (!info || !this.connection.connected) return;
    const disk = { availableBytes: info.bavail * info.bsize, totalBytes: info.blocks * info.bsize };
    if (!isValidMachineDiskStatus(disk)) return;
    this.connection.send({ type: "machine:disk_status", ...disk });
  }

  private invalidateLifecycleOriginReconcile(): number {
    this.lifecycleOriginConnectionGeneration += 1;
    if (this.lifecycleOriginRetryTimer !== null) {
      this.lifecycleOriginClock.clearTimeout(this.lifecycleOriginRetryTimer);
      this.lifecycleOriginRetryTimer = null;
    }
    return this.lifecycleOriginConnectionGeneration;
  }

  private async reconcileComputerLifecycleOrigin(
    connectionGeneration: number,
    attempt: number,
    expectedOperationId?: string,
  ): Promise<void> {
    if (!this.options.reconcileComputerLifecycleOrigin
      || !this.connection.connected
      || connectionGeneration !== this.lifecycleOriginConnectionGeneration) {
      return;
    }
    try {
      const result = await this.options.reconcileComputerLifecycleOrigin();
      if (!this.connection.connected
        || connectionGeneration !== this.lifecycleOriginConnectionGeneration) {
        return;
      }
      const normalized = typeof result === "boolean"
        ? result
          ? { status: "adopted" as const, operationId: expectedOperationId }
          : { status: "not_adopted" as const }
        : result;
      const observedOperationId = "operationId" in normalized
        ? normalized.operationId
        : undefined;
      if (expectedOperationId && observedOperationId !== expectedOperationId) {
        logger.warn("[Daemon] Computer lifecycle origin reconcile stopped after operation identity changed");
        return;
      }
      if (normalized.status === "adopted") {
        await this.emitReady(connectionGeneration);
        return;
      }
      if (normalized.status !== "retryable_ready_pending") return;
      if (attempt >= COMPUTER_LIFECYCLE_ORIGIN_RECONCILE_MAX_ATTEMPTS) {
        logger.warn(
          `[Daemon] Computer lifecycle origin reconcile stopped after ${attempt} ready-pending attempts`,
        );
        return;
      }
      const operationId = expectedOperationId ?? normalized.operationId;
      this.lifecycleOriginRetryTimer = this.lifecycleOriginClock.setTimeout(() => {
        this.lifecycleOriginRetryTimer = null;
        void this.reconcileComputerLifecycleOrigin(
          connectionGeneration,
          attempt + 1,
          operationId,
        );
      }, COMPUTER_LIFECYCLE_ORIGIN_RECONCILE_RETRY_MS);
    } catch (err) {
      logger.warn(
        `[Daemon] Computer lifecycle origin reconcile skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.recordConnectLifecycleError("lifecycle_origin_reconcile", "reconcile_threw", err);
    }
  }

  private handleConnect() {
    const lifecycleOriginConnectionGeneration = this.invalidateLifecycleOriginReconcile();
    // Computer readiness tracks the live websocket handshake, not runtime
    // inventory. Publish that lifecycle edge before any synchronous probe can
    // delay the event loop (notably PowerShell Get-Command on fresh Windows
    // hosts). A failed hook must not suppress the daemon's fresh ready report.
    try {
      this.options.lifecycleHooks?.onConnect?.();
    } catch (err) {
      logger.warn(`[Daemon] Connection lifecycle hook failed: ${err instanceof Error ? err.message : String(err)}`);
      this.recordConnectLifecycleError("lifecycle_hook", "lifecycle_hook_threw", err);
    }

    // One-shot on first connect: bring existing per-agent opencli wrappers to
    // the current self-healing form. A long-running agent whose wrapper predates
    // a package-tree mutation (e.g. an npm→SEA computer switch) otherwise keeps a
    // stale hardcoded path until it respawns. The per-spawn writer handles new
    // launches; this covers agents that don't respawn across the switch.
    if (!this.opencliWrappersRegenerated) {
      this.opencliWrappersRegenerated = true;
      try {
        const { scanned, rewritten } = regenerateExistingOpencliWrappers(this.agentsDataDir);
        if (scanned > 0) {
          logger.info(`[Daemon] Refreshed ${rewritten}/${scanned} opencli wrapper(s) to current self-healing form`);
        }
      } catch (err) {
        logger.warn(`[Daemon] opencli wrapper refresh skipped: ${err instanceof Error ? err.message : String(err)}`);
        this.recordConnectLifecycleError("opencli_wrapper_refresh", "wrapper_refresh_threw", err);
      }
    }
    const initialReady = this.emitReady(lifecycleOriginConnectionGeneration);
    void initialReady.then((readySent) => {
      if (readySent) this.requestRuntimeModelCatalogPublish(false);
    });
    if (this.options.reconcileComputerLifecycleOrigin) {
      void initialReady
        .then((readySent) => readySent
          ? this.reconcileComputerLifecycleOrigin(lifecycleOriginConnectionGeneration, 1)
          : undefined)
        .catch((err) => {
          logger.warn(
            `[Daemon] Computer lifecycle origin reconcile skipped: ${err instanceof Error ? err.message : String(err)}`,
          );
          this.recordConnectLifecycleError("lifecycle_origin_reconcile", "reconcile_threw", err);
        });
    }
    // task #1103: wake requests parked while offline go out once per connect edge.
    this.agentManager.resendPendingServerWakes();
    const runningAgentIds = this.agentManager.getRunningAgentIds();
    const idleAgentSessions = this.agentManager.getIdleAgentSessionIds();
    const runtimeProfileReports = this.agentManager.getAgentRuntimeProfileReports();

    if (this.options.onComputerRestartReconcile) {
      void Promise.resolve()
        .then(() =>
          this.options.onComputerRestartReconcile!((done) => {
            this.connection.send({ type: "computer:restart:done", ...done });
            this.recordDaemonEvent("daemon.computer_restart.reconciled", {
              request_id: done.requestId,
              ok: done.ok,
            });
          }),
        )
        .catch((err) => {
          logger.error(
            `[Daemon] computer restart reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          this.recordConnectLifecycleError("computer_restart_reconcile", "reconcile_threw", err);
        });
    }

    for (const agentId of runningAgentIds) {
      const sessionId = this.agentManager.getAgentSessionId(agentId);
      const launchId = this.agentManager.getAgentLaunchId(agentId);
      if (sessionId) {
        // TODO(lifecycle-v2/daemon-protocol): reconnect session replay should
        // be a canonical session_resynced/runtime_ready event with reconnect
        // window identity, not only legacy `agent:session`.
        this.connection.send({ type: "agent:session", agentId, sessionId, launchId: launchId || undefined });
      }
    }

    // Idle agents (Codex and others that exit normally between turns) also need
    // session resync so the server can preserve resume state across reconnects.
    for (const { agentId, sessionId, launchId } of idleAgentSessions) {
      // TODO(lifecycle-v2/daemon-protocol): idle session replay needs the same
      // canonical session_resynced/runtime_ready producer as running agents;
      // keep this legacy frame until the server no longer relies on adapter
      // inference for reconnect readiness.
      this.connection.send({ type: "agent:session", agentId, sessionId, launchId: launchId || undefined });
    }

    for (const report of runtimeProfileReports) {
      const span = this.tracer.startSpan("daemon.runtime_profile.report.sent", {
        surface: "daemon",
        kind: "producer",
        attrs: {
          agentId: report.agentId,
          launchId: report.launchId || undefined,
          runtime: report.facts.runtime,
          report_source: "connect",
          model_present: Boolean(report.facts.model),
          session_ref_present: Boolean(report.facts.sessionRef),
          workspace_ref_present: Boolean(report.facts.workspaceRef || report.facts.workspacePathRef),
        },
      });
      this.connection.send({
        type: "agent:runtime_profile",
        agentId: report.agentId,
        facts: report.facts,
        launchId: report.launchId || undefined,
        traceparent: formatTraceparent(span.context),
        source: "connect",
      });
      span.end("ok");
    }

    // Refill from the server's authoritative view. snapshot() applies
    // per-agent, so each request only replaces that agent's entries — no
    // global clear (which would race: the last snapshot to arrive would wipe
    // timers installed by earlier ones).
    const agentsForSnapshot = new Set<string>(runningAgentIds);
    for (const { agentId } of idleAgentSessions) {
      agentsForSnapshot.add(agentId);
    }
    this.localScheduleRuntime.onConnect();
    for (const agentId of agentsForSnapshot) {
      this.localScheduleRuntime.requestSnapshot(agentId);
    }

  }

  private handleDisconnect() {
    this.serverAcksRuntimeOutcomes = false;
    this.runtimeOutcomeOutbox.onDisconnected();
    this.invalidateLifecycleOriginReconcile();
    logger.warn("[Daemon] Lost connection — agents continue running locally");
    this.recordDaemonEvent("daemon.connection.local_disconnect_observed", {
      running_agents_count: this.agentManager.getRunningAgentIds().length,
      idle_agents_count: this.agentManager.getIdleAgentSessionIds().length,
    }, "cancelled");
    this.options.lifecycleHooks?.onDisconnect?.();
  }

  private handleHandshakeRejected(event: { statusCode: number; reason: string | null }) {
    this.options.lifecycleHooks?.onHandshakeRejected?.(event);
  }
}
