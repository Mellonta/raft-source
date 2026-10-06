// Shared types for Slock — used by server, web, and machine (daemon process)

import { makeIsMember } from "./typeGuards";
import { EXTERNAL_AGENT_RUNTIME_DISPLAY_NAME, EXTERNAL_AGENT_RUNTIME_ID, EXTERNAL_AGENT_RUNTIME_MODEL, RUNTIMES, RuntimeInfo } from "./runtimeCatalog";
import { currentDate } from "./clock";
import {
  PI_BUILTIN_PROVIDER_API_KEY_ENV_KEYS_GENERATED,
  PI_BUILTIN_PROVIDER_BLOCKED_HOST_ENV_KEYS_GENERATED,
  PI_BUILTIN_PROVIDER_CONNECTION_PROBES_GENERATED,
  PI_BUILTIN_PROVIDER_DEFAULT_MODELS_GENERATED,
  PI_BUILTIN_PROVIDER_MODELS_GENERATED,
} from "./piBuiltinModels.generated";
import { formatRuntimeProviderModelLabel } from "./runtimeProviderDisplay";
import { hydrateLegacyRuntimeConfigWithTrace } from "./runtimeConfigLegacy";
import type { AttentionHint } from "./attentionDependencyOracle";
import type { EXTERNAL_AGENT_ACTIVITY_LEGACY_STATUS_VALUES, RaftAgentStatus } from "./agentStatusStandard";
import type {
  ComputerBoundDueReceiptMessage,
  ServerBoundDueReceiptMessage,
} from "./apps/reminder/protocol";

export { DISTRIBUTION_POLICY } from "./distributionPolicy";
export { formatUtcTimestamp } from "./utcTimestamp";

export {
  joinRaftChannelByTarget,
  parseRaftRegularChannelTarget,
  type RaftChannelJoinClient,
  type RaftChannelJoinClientResult,
  type RaftChannelJoinError,
  type RaftChannelJoinFailure,
  type RaftChannelJoinOperation,
  type RaftChannelJoinRequest,
  type RaftChannelJoinResult,
  type RaftChannelJoinSuccess,
  type RaftChannelJoinTransportError,
} from "./agentApiChannelJoin";

export {
  AGENT_MIGRATION_STATES,
  MAX_AGENT_MIGRATION_TRANSPORT_BYTES,
  MAX_AGENT_MIGRATION_TRANSFER_FILE_COUNT,
  MAX_AGENT_MIGRATION_TRANSFER_BYTES,
  MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT,
  AGENT_MIGRATION_SOURCE_BUILD_PHASES,
  agentMigrationSourceBuildProgressReportSchema,
  agentMigrationSupportRefSchema,
  agentMigrationTransferSummarySchema,
  agentMigrationUpdatedPayloadSchema,
  type AgentMigrationSourceBuildProgress,
  type AgentMigrationTransferSummary,
  type AgentMigrationUpdatedPayload,
} from "./agentMigration";
export {
  AGENT_MIGRATION_TERMINAL_FAILURE_CODES,
  AGENT_MIGRATION_USER_ERROR_CODES,
  type AgentMigrationTerminalFailureCode,
  type AgentMigrationUserErrorCode,
} from "./agentMigrationErrors";
export {
  FEATURE_FLAG_ADMIN_COLUMN_PROJECTIONS,
  FEATURE_FLAG_ADMIN_OPERATOR_ROLE,
  FORBIDDEN_FEATURE_FLAG_ADMIN_PRIVILEGES,
  REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES,
  FeatureFlagAdminPrivilegeError,
  featureFlagAdminPrivilegeLabel,
  readFeatureFlagAdminPrivilegeMatrix,
  verifyFeatureFlagAdminPrivileges,
  type FeatureFlagAdminPrivilegeCheck,
  type FeatureFlagAdminPrivilegeQuery,
} from "./featureFlagAdminPrivileges";
import type { DisplayLocale } from "./displayLocales";
import type { ProviderConnectionLaunchProjection } from "./providerConnections";
import type { ProviderProbeCategory, ProviderProbeDaemonCategory, ProviderProbeId } from "./providerProbes";
import type { RuntimeAccountUsageProvider, RuntimeAccountUsageSnapshot } from "./runtimeAccountUsage";
import type { RuntimeModelCatalogEntry } from "./runtimeModelCatalog";
import type { AgentVisibleExternalMessageProvenance } from "./externalProjection";
import type { FeedbackTranscriptLookupOutcome, FeedbackTranscriptOutcomeObjectPlan, FeedbackTranscriptUploadOutcome } from "./feedbackTranscriptOutcome";

// Joint channel limits (contract v0.3 §18.6). Servers include the host and
// unexpired pending invite targets; the free-server cap uses the same billing
// projection as every other paid gate (`canUseProBillingFeatures`).
export const MAX_JOINT_CHANNEL_SERVERS = 30;
export const MAX_JOINT_CHANNEL_FREE_SERVERS = 2;
// §18.8: a joint that goes over the free-server cap after joining stays
// writable for this long, then becomes read-only until back within the cap.
export const JOINT_CHANNEL_OVER_LIMIT_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

export type AgentMessageSenderType = "human" | "agent" | "system" | "third_party_app";

export interface AgentThreadContextMessage {
  message_id: string;
  sender_name: string;
  sender_description?: string | null;
  sender_type: AgentMessageSenderType;
  content: string;
  timestamp: string;
  seq?: number;
  external_message?: AgentVisibleExternalMessageProvenance;
}

export interface AgentThreadJoinContext {
  reason: "mentioned";
  parent_target: string;
  thread_target: string;
  suggested_read_history_target: string;
  /** The parent/root message anchors what problem this thread is actually about. */
  parent_message: AgentThreadContextMessage;
  /** A small recent window keeps the first reply from feeling like a blind guess. */
  recent_messages: AgentThreadContextMessage[];
  history_truncated: boolean;
}

export interface AgentThreadFollowReactivation {
  /** Exact Raft thread target that can be passed back to `raft thread unfollow`. */
  thread_target: string;
}
// Agent message delivered between server/machine/MCP bridge
export interface AgentMessage {
  channel_id: string;
  channel_name: string;
  channel_type: "channel" | "private" | "joint" | "dm" | "thread";
  sender_id: string;
  sender_name: string;
  sender_description?: string | null;
  sender_type: AgentMessageSenderType;
  content: string;
  timestamp: string;
  seq?: number;
  /** The message UUID — first 8 chars can be used as thread target (e.g. #channel:shortid) */
  message_id?: string;
  /** True only when this delivered message directly mentioned the receiving agent. */
  mentioned?: boolean;
  /**
   * True only for notify-only mention delivery to a recipient who was not
   * added to the target. Renderers must show the honest reply limitation
   * without changing the persisted message content.
   */
  non_member_mention?: boolean;
  /** For thread messages: the parent channel name (e.g. "general") or peer name for DM threads */
  parent_channel_name?: string;
  /** For thread messages: the parent channel ID */
  parent_channel_id?: string;
  /** For thread messages: the parent channel type ("channel", "private", "joint", or "dm") */
  parent_channel_type?: "channel" | "private" | "joint" | "dm";
  /** Attached files */
  attachments?: { id: string; filename: string; mimeType: string; sizeBytes?: number }[];
  /** Task fields — present when the message is (or could be) a task */
  task_status?: "todo" | "in_progress" | "in_review" | "done" | "closed" | null;
  task_number?: number | null;
  task_assignee_type?: "human" | "agent" | null;
  task_assignee_id?: string | null;
  task_assignee_name?: string | null;
  /**
   * Latest mutable task text for an amended task host message. The immutable
   * `content` above remains the original message and must never be rewritten.
   */
  task_current_projection?: {
    title: string;
    description: string | null;
    revision: number;
    superseded: boolean;
    amended_at: string | null;
    amended_by_type: "user" | "agent" | "system" | null;
    amended_by_name: string | null;
    source: "tasks_current_projection";
  };
  /** Present when the agent was auto-joined into a thread and would otherwise only see the triggering @message. */
  thread_join_context?: AgentThreadJoinContext;
  /** Present only when this direct @mention reactivated an explicitly unfollowed thread. */
  thread_follow_reactivation?: AgentThreadFollowReactivation;
  /**
   * Structured D(t) attention-oracle hint. This is not the Agent API
   * `.attention` management-result envelope; consumers should branch on the
   * `schema` discriminator before interpreting the payload.
   */
  attention_hint?: AttentionHint;
  /** Internal trace context for daemon-injected synthetic control messages. Not rendered to the agent. */
  traceparent?: string;
  /**
   * Optional producer-fact lineage for message-shaped readouts derived from an
   * APM/lifecycle decision. Consumers must treat this as an opaque join key,
   * not user content or authorization.
   */
  producerFactId?: string;
  /** Structured third-party event delivery with explicit source provenance. */
  third_party_event?: {
    id: string;
    kind: "event" | "notification" | "action_request";
    client_id: string;
    client_name: string;
    external_event_id?: string | null;
    payload_hash: string;
    payload: Record<string, unknown>;
    expires_at: string;
    source: {
      /** Public OAuth client id / app key, stable for display and integrations. */
      client_id: string;
      client_name: string;
      /** Internal OAuth client row id, stable for audit/revoke joins. */
      oauth_client_id: string;
      /** Hash of the resource-bound token row id; never the bearer token. */
      access_token_id_hash?: string | null;
      resource: string;
    };
  };
  /** Ordinary external-origin conversation content; always inert. */
  external_message?: AgentVisibleExternalMessageProvenance;
}

export * from "./observedFailureSummary";
export * from "./diagnosticRedaction";
export * from "./feedbackMachineEvidence";
export * from "./feedbackTranscriptOutcome";
export * from "./scopeAttestationBudget";
export * from "./activityMute";
export * from "./channelPermissions";
export * from "./raftPermalinks";
export * from "./raftRefs";
export * from "./dmPeerRef";
export * from "./liveExecutablePath";
export * from "./thirdPartyInertRenderer";
export * from "./agentRuntimeProvider";
export * from "./producerFactLineage";
export * from "./apmHeldFreshness";
export * from "./emailValidation";
export * from "./serverSlugValidation";
export * from "./tracing/index";
export * from "./raftCliGuide";
export * from "./tracing/eventRows";
export * from "./tracing/fields";
export * from "./tracing/memory";
export * from "./tracing/assertions";
export * from "./toolDisplay";
export * from "./attachmentPreview";
export * from "./typeGuards";
export * from "./brandedIds";
export * from "./actionCards";
export * from "./featureFlags";
export * from "./productEvents";
export * from "./externalProjection";
export * from "./slackBridgeDelivery";
export * from "./slackBridgeProvisioning";
export * from "./agentApiContract";
export * from "./thirdPartyEventId";
export * from "./agentApiRouteMeta";
export * from "./agentApiDescription";
export * from "./agentMessageText";
export * from "./agentOps/index";
export * from "./agentText/index";
export * from "./agentApiRawClient";
export * from "./agentApiClient";
export * from "./agentApiMessageClient";
export * from "./daemonApiContract";
export * from "./authRefreshTiming";
export * from "./socketHandshakeErrors";
export * from "./safeReturnPath";
export * from "./integrationInvitePaths";
export * from "./clock";
export * from "./daemonApiRawClient";
export * from "./daemonApiClient";
export * from "./agentInbox";
export * from "./agentInboxProjection";
export * from "./agentInboxApp";
export * from "./attentionDependencyOracle";
export * from "./runtimeProviderDisplay";
export * from "./runtimeAccountUsage";
export * from "./runtimeModelCatalog";
export * from "./externalAgentIntegration";
export * from "./translationLanguages";
export * from "./displayLocales";
export * from "./computerReleaseNotes";
export * from "./timeFormatPreference";
export * from "./legalAcceptance";
export * from "./agentScopes";
export * from "./oauthScopes";
export * from "./oauthRedirect";
export * from "./oauthClientCategories";
export * from "./appNotifications";
export * from "./startupMemoryContract";
// sync-core now lives in its own workspace package; this stays as a
// compatibility re-export so existing `@botiverse/raft-shared` consumers keep working.
export * from "@botiverse/raft-sync-core";
export * from "./onboardingStateMachineContract";
export * from "./knowledgeContext";
export * from "./capabilityInventories";

// ── Reminders (contract types) ────────────────────────────────────────────────
// Server DB owns lifecycle/recurrence. The Computer keeps a durable, versioned
// local mirror and owns due-time delivery into typed Agent Inbox. It reports
// `armed` after durable installation and asynchronously reports `fire_receipt`
// after local item+wake; neither due-time path creates a Raft message.

export type ReminderStatus = "scheduled" | "fired" | "canceled";
// Single source of truth for runtime validation: `satisfies` keeps this list
// aligned with the ReminderStatus union (a drift is a compile error), and the
// type-guard narrows a raw string to ReminderStatus without a cast.
export const REMINDER_STATUSES = ["scheduled", "fired", "canceled"] as const satisfies readonly ReminderStatus[];
export const isReminderStatus = (s: string): s is ReminderStatus =>
  (REMINDER_STATUSES as readonly string[]).includes(s);

/**
 * Wire-shape recurrence descriptor. The server stores a richer structured
 * form (see `services/recurrence.ts`), but the daemon timer cache and UI
 * only need the kind + a human-readable description. Unknown kinds written
 * by a newer server surface as `kind="unsupported"` so older clients render
 * "(recurring, unknown rule)" instead of crashing.
 */
export interface ReminderRecurrence {
  kind: "interval" | "daily" | "weekly" | "unsupported";
  description: string;
}

/** Daemon-side cache shape: the minimum needed to hold a local timer. */
export interface ReminderJob {
  reminderId: string;
  ownerAgentId: string;
  msgId: string | null;
  title: string;
  /** ISO-8601 UTC */
  fireAt: string;
  version: number;
  /** Non-null when this reminder auto-reschedules after fire. */
  recurrence: ReminderRecurrence | null;
}

/**
 * Server-authoritative summary shape for humans / UI. The sidebar pending
 * list, agent profile pending section, and any list API consume this.
 * Includes fields the daemon timer cache doesn't need (status, createdAt,
 * msgRef, msgPermalink) so the UI never has to reach into daemon state.
 */
export interface ReminderSummary {
  reminderId: string;
  ownerAgentId: string;
  title: string;
  /** ISO-8601 UTC */
  fireAt: string;
  /** ISO-8601 UTC. Non-null after a reminder has fired at least once. */
  firedAt?: string | null;
  /** ISO-8601 UTC */
  createdAt: string;
  status: ReminderStatus;
  /** Rendered AX label (e.g. `#engineering:abc123`), or null for free-form reminders. */
  msgRef: string | null;
  /** Clickable absolute URL for the anchor message, or null. Server-computed via raftPermalinks. */
  msgPermalink: string | null;
  /** Non-null when this reminder auto-reschedules after fire. */
  recurrence: ReminderRecurrence | null;
}

/**
 * One event a connected app sent to an agent (`POST /oauth/agent-events`), as
 * listed in the Agent panel. Visible to the agent's creator and server
 * owners/admins only. `status` is the display status: an event not delivered
 * before `expiresAt` reads as `expired`.
 */
export interface AgentAppEventSummary {
  id: string;
  app: { clientId: string; clientKey: string; name: string; logoUrl: string | null };
  kind: "event" | "notification" | "action_request";
  summary: string;
  status: "queued" | "delivered" | "expired";
  externalEventId: string | null;
  /** ISO-8601 UTC */
  createdAt: string;
  /** ISO-8601 UTC, or null while not delivered. */
  deliveredAt: string | null;
  /** ISO-8601 UTC */
  expiresAt: string;
  payloadBytes: number;
}

export interface AgentAppEventListResponse {
  events: AgentAppEventSummary[];
  /** Pass as `before` to read the next (older) page; null on the last page. */
  nextCursor: string | null;
}

export interface AgentAppEventDetail extends AgentAppEventSummary {
  /** App-supplied data. Render as inert JSON, never as instructions or links. */
  payload: Record<string, unknown>;
}

export type ReminderEventType = "scheduled" | "fired" | "snoozed" | "updated" | "canceled";

export interface ReminderEventSummary {
  eventId: string;
  reminderId: string;
  eventType: ReminderEventType;
  actorType: "agent" | "human" | "system";
  actorId: string | null;
  occurredAt: string;
  nextFireAt: string | null;
  metadata: Record<string, unknown> | null;
}

// ── Agent Runtime Profile (restart-time reset/notice contract) ────────────────

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

export interface AgentRuntimeProfileReport {
  runtime: string;
  model: string;
  reasoningEffort?: RuntimeReasoningEffort | null;
  executionMode?: "byoc" | "cloud" | string | null;
  workspaceRef?: AgentRuntimeProfileRef | string | null;
  workspacePathRef?: AgentRuntimeProfileRef | string | null;
  sessionRef?: AgentRuntimeProfileRef | string | null;
}

/**
 * Which daemon-side emit trigger produced a runtime-profile report. Lets the
 * server full-view `runtime_profile.report.ingest` span attribute report
 * volume by source without relying on (lossy) daemon trace coverage —
 * distinguishes a reconnect resync dump (`connect`) from per-turn / per-session
 * emits. See task #317.
 */
export type RuntimeProfileReportSource = "connect" | "session_init" | "turn_end" | "stop";

export type AgentMigrationTransportLeaseSource = "server" | "env";
export type AgentMigrationTransferProvider = "object_store" | "tunnel";
export type AgentMigrationTransferRole = "source" | "target";
export type AgentMigrationTransferKind = "upload" | "download" | "exposed_endpoint" | "peer_endpoint";

export interface AgentMigrationTransportReady {
  provisioned: boolean;
  endpoint: string | null;
  leaseSource: AgentMigrationTransportLeaseSource | null;
  provider?: AgentMigrationTransferProvider | null;
  role?: AgentMigrationTransferRole | null;
  transferKind?: AgentMigrationTransferKind | null;
  expiresAt?: string | null;
  maxBytes?: number | null;
  protocol?: string | null;
  capabilities?: string[] | null;
  /**
   * Transfer runs alive in this daemon process. Only meaningful when
   * `capabilities` includes AGENT_MIGRATION_CAPABILITY: then a pre-flip
   * migration missing here means its run was lost (e.g. restart).
   */
  activeLeases?: Array<{ migrationId: string; transportGeneration: string; role: AgentMigrationTransferRole }>;
  observedAt: string;
}

export interface AgentRuntimeProfileChange {
  field: string;
  before?: unknown;
  after?: unknown;
}

export interface AgentRuntimeProfileSnapshot {
  runtimeProfileFingerprint?: string;
  daemonVersion?: string | null;
  machineId?: string | null;
  machineName?: string | null;
  runtime?: string | null;
  model?: string | null;
  reasoningEffort?: RuntimeReasoningEffort | null;
  executionMode?: "byoc" | "cloud" | string | null;
  workspaceRef?: AgentRuntimeProfileRef | string | null;
  workspacePathRef?: AgentRuntimeProfileRef | string | null;
  sessionRef?: AgentRuntimeProfileRef | string | null;
  observedAt?: string | null;
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

// Server ↔ Machine WebSocket protocol
/** One conversation's messages the model was shown: `channelId` is the conversation (thread channel for threads). */
export interface AgentModelSeenItem {
  channelId: string;
  seqs: number[];
}

/** Most conversations one `agent:model-seen` report may carry; the Server ignores the rest, the daemon splits. */
export const MODEL_SEEN_MAX_ITEMS_PER_REPORT = 50;

export const DAEMON_CAPABILITY_MODEL_SEEN_BOUNDARY = "agent:model-seen-boundary";
/**
 * RFC 069 §8: the daemon reports agent state only through sequenced, replayed
 * `agent:status` frames (`daemonInstanceId` + `clientSeq`, same counter as
 * activity). A server that sees this capability lets activity frames change
 * display only, never the state that wake decisions read.
 */
export const DAEMON_CAPABILITY_SEQUENCED_STATUS = "agent:status-sequenced";
/**
 * RFC 071 §7: the daemon reports launch-bound runtime outcomes
 * (`agent:runtime:outcome` v1: E1 `terminal_failure`, E2 `turn_completed`)
 * and process identity (`agent:process_spawned`, `agent:process_exited`,
 * `processInstanceId` on a rebind `agent:start:ack`), and echoes
 * `catchupBatchId` from `agent:start`. Without it the terminal-failure
 * breaker never counts for this machine (RFC 7 "Old daemons").
 */
export const DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1 = "agent:runtime-outcome-v1";
/**
 * RFC 071 outbox (server capability, on `machine:context.capabilities`): the
 * server acknowledges every outbox frame with `agent:outcome:ack`. A daemon
 * sends outbox frames only to a server that advertises this; otherwise it
 * pauses and keeps its queue.
 */
export const SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1 = "agent:runtime-outcome-ack-v1";
export const COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS = "computer:supervisor-mutations-v1";

/**
 * Summary of the most recent external-installer upgrade receipt on a machine,
 * read once by the successor process and carried on `ready`. Only the
 * failure reason is consumed (one human-readable line); the outcome is the
 * version comparison the Server performs itself.
 */
export interface ComputerLastUpgradeReceipt {
  targetVersion: string;
  outcome: "promoted" | "rolled_back" | "failed" | "held" | "unresolved";
  reason?: string;
}
export const COMPUTER_LIFECYCLE_ACTIONS = ["start", "stop", "restart", "upgrade"] as const;
export type ComputerLifecycleAction = (typeof COMPUTER_LIFECYCLE_ACTIONS)[number];
export const COMPUTER_LIFECYCLE_TERMINALS = [
  "completed",
  "failed",
  "unconfirmed",
  "superseded",
  "rolled_back",
] as const;
export type ComputerLifecycleTerminal = (typeof COMPUTER_LIFECYCLE_TERMINALS)[number];
export interface ComputerLifecycleExecutionAck {
  /** Canonical identifier. Optional only during the requestId compatibility window. */
  operationId?: string;
  /** Legacy alias; when both are present they must identify the same operation. */
  requestId?: string;
  action: ComputerLifecycleAction;
  phase: "shutdown" | "ready";
  loadedComputerVersion?: string;
  /** Present only on a machine-wide D=Upgrade ready acknowledgement. */
  serviceGeneration?: string;
  managedSetRevision?: string;
  oldProcessIdentitiesDead?: boolean;
  deadProcessIdentities?: string[];
}
/** @deprecated Wire-only retirement compatibility; never install these files. */
export interface WikiWorkspacePackFile {
  relativePath: string;
  content: string;
  sha256: string;
  size: number;
}

export interface WikiWorkspacePack {
  protocolVersion: 1;
  packId: string;
  files: WikiWorkspacePackFile[];
}

export interface WikiWorkspaceFileReceipt {
  relativePath: string;
  sha256: string;
  size: number;
}

export type MentionDeliveryIdentitySnapshot = {
  occurrenceId: string;
  messageId: string;
  machineId: string;
  launchId: string;
  sessionId: string;
};

export type MentionDeliveryTransitionStage =
  | "daemon_received"
  | "daemon_pending"
  | "daemon_drained";

// Single authoritative definition of the terminal error codes on the
// mention-delivery wire (daemon → server `agent:delivery:terminal_error`) and
// in server persistence. task #154: this union previously existed in THREE
// places (here, packages/server/src/services/mentionDeliveryOccurrenceService.ts
// with an extra REDELIVERY_EXHAUSTED, and an inline copy in
// packages/daemon/src/core.ts) and the copies silently diverged — a reader of
// any one copy undercounted the codes. Everything now derives from this array;
// adding a member here propagates to every consumer at compile time.
export const MENTION_DELIVERY_TERMINAL_ERROR_CODES = [
  "IDENTITY_UNKNOWN",
  "IDENTITY_DRIFT",
  "QUOTA_LIMITED",
  "DELIVERY_REJECTED",
  "UNSUPPORTED_DELIVERY_PATH",
  "INSTRUMENT_FAILED",
  "REDELIVERY_EXHAUSTED",
] as const;

export type MentionDeliveryTerminalErrorCode = typeof MENTION_DELIVERY_TERMINAL_ERROR_CODES[number];

/** Bounded provenance of the winning terminal decision; absent on legacy rows.
 * The daemon code is the code actually received, not inferred from the final code.
 * No message bodies, runtime identities, or arbitrary diagnostic attributes.
 */
export type MentionDeliveryTerminalDecision = {
  layer: "daemon" | "server";
  stage: "terminal_receipt" | "stage_receipt" | "ack_receipt" | "recovery"
    | "retry" | "redrive" | "instrumentation_fallback" | "recovery_exhausted";
  originalDaemonCode: MentionDeliveryTerminalErrorCode | null;
};


/** RFC 071 §7: which terminal path ended the launch. */
export const AGENT_RUNTIME_TERMINAL_FAILURE_KINDS = [
  "compaction_failed",
  "compaction_input_too_large",
  "compaction_recovery_exhausted",
  "sticky_runtime_error",
  "fingerprint_fence",
  "billing_rejected",
] as const;
export type AgentRuntimeTerminalFailureKind = (typeof AGENT_RUNTIME_TERMINAL_FAILURE_KINDS)[number];

/** RFC 071 outbox: what a gap / cross-instance marker folded. */
export interface AgentRuntimeOutcomeGapCounts {
  e1: number;
  turnCompleted: number;
  spawned: number;
  exited: number;
  startOutcome: number;
}

/** RFC 071 §7: the `outcome` of an `agent:runtime:outcome` v1 frame. */
export type AgentRuntimeOutcome =
  | {
      kind: "terminal_failure";
      failureKind: AgentRuntimeTerminalFailureKind;
      /** 16 hex, from the RAW SDK/runtime text (never the display constant). */
      fingerprint: string;
      errorClass: RuntimeErrorClass;
    }
  | {
      kind: "turn_completed";
      textEvents: number;
      toolCalls: number;
      /** Only on the turn whose input rendered that batch, and only once per batch (RFC 071 §6). */
      catchupBatchId?: string;
      /**
       * With `catchupBatchId`: how many batch rows were rendered into that
       * turn's input. Always >= 1: a batch with zero rendered rows is never
       * echoed, so a cursor-only coverage (no rows) is the server's to settle
       * from read cursors, never from an echo.
       */
      catchupRenderedRows?: number;
    };

/**
 * Why no process was created for a launch the daemon accepted (RFC 071
 * `agent:start:outcome`). Sent only when the daemon KNOWS no process exists
 * for the launch; never for timeouts, disconnects or unknown results.
 *  - `start_rejected`: refused before the start reached the process manager
 *    (validation, credential, retired start type);
 *  - `spawn_failed`: the start failed before any runtime process existed;
 *  - `cancelled`: stopped or cancelled before any runtime process existed;
 *  - `deferred`: the runtime defers its spawn until a concrete message; a later
 *    spawn for the same launch reports `agent:process_spawned` with `respawn`;
 *  - `admission_full`: refused before acceptance because the agent already has
 *    the maximum number of launches still waiting for a final result.
 */
export const AGENT_START_NOT_SPAWNED_REASONS = [
  "start_rejected",
  "spawn_failed",
  "cancelled",
  "deferred",
  "admission_full",
  /** The daemon refused an automatic start locally: its outcome evidence has an un-acked gap, or is unreliable. */
  "terminal_failure_needs_manual",
  /** The daemon refused a start (human or automatic): its outcome outbox cannot reserve room for this launch until acks drain. */
  "terminal_failure_outcome_storage_blocked",
] as const;
export type AgentStartNotSpawnedReason = (typeof AGENT_START_NOT_SPAWNED_REASONS)[number];

export type AgentWakeRefusedReason =
  | "manual_stop"
  | "wake_lock_held"
  /** task #1119: automatic wakes are paused after consecutive early exits; a human start lifts it. */
  | "wake_crash_loop_blocked"
  /**
   * RFC 071: the terminal-failure breaker is open and its backoff has not
   * passed; the next wake after it (or a manual start) retries.
   */
  | "terminal_failure_paused"
  /** RFC 071: one probe launch is already running under a lease. */
  | "terminal_failure_probe_in_flight"
  /**
   * RFC 071: an earlier process could not be confirmed stopped, or this
   * machine cannot report outcomes after protection; only a manual start
   * proceeds.
   */
  | "terminal_failure_needs_manual"
  /** RFC 071 outbox: the daemon's outcome storage is blocked until acknowledgements drain. */
  | "terminal_failure_outcome_storage_blocked"
  | "agent_not_found"
  | "machine_mismatch"
  | "server_error";

export type ServerToMachineMessage =
  /**
   * Authenticated websocket ownership context. The Server sends this as the
   * first frame after accepting a machine connection so the daemon can bind
   * Computer-local App state to a logical Server identity before use.
   */
  | { type: "machine:context"; machineId: string; serverId: string; /** Additive: server capabilities, e.g. `SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1`. */ capabilities?: string[] }
  /**
   * RFC 071 outbox: the server applied (or deliberately ignored) one outbox
   * entry. A normal entry is named by `(daemonInstanceId, clientSeq)`; a gap
   * or cross-instance marker by its `gapId`. The daemon deletes only the
   * exactly matching entry.
   */
  | { type: "agent:outcome:ack"; agentId: string; daemonInstanceId?: string; clientSeq?: number; gapId?: string }
  /**
   * `catchupBatchId` (RFC 071 §6/§7, optional): identifies the resume
   * catch-up batch carried in `resumeMessages`. A daemon with
   * `DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1` echoes it once, on the
   * `turn_completed` outcome of the turn whose input rendered that batch.
   * Old daemons ignore it; then nothing is echoed and nothing is fulfilled.
   *
   * RFC 071 outbox (all optional, additive):
   *  - `breakerGeneration`: the breaker generation at claim; every outbox
   *    frame of this launch echoes it as `generation`.
   *  - `takeoverEpoch`: bumped by the server on each human takeover; a new
   *    value seals the daemon's open gap markers of the older epoch.
   *  - `humanStart`: an explicit human start (RFC 071 §5 E3). The daemon's
   *    local refusal of automatic starts does not apply to it.
   */
  | { type: "agent:start"; agentId: string; config: AgentConfig; wakeMessage?: AgentMessage; wakeMessageTransient?: boolean; resumeMessages?: AgentMessage[]; unreadSummary?: Record<string, number>; resumePrompt?: string; launchId?: string; startDispatchId?: string; traceparent?: string; catchupBatchId?: string; breakerGeneration?: number; takeoverEpoch?: number; humanStart?: boolean }
  /**
   * Retired wire request: new Computers reject it without launching an Agent.
   * Retained for rolling upgrades; new Servers never emit it.
   */
  | { type: "agent:start:wiki"; agentId: string; config: AgentConfig; wikiWorkspacePack: WikiWorkspacePack; wakeMessage?: AgentMessage; wakeMessageTransient?: boolean; resumeMessages?: AgentMessage[]; unreadSummary?: Record<string, number>; resumePrompt?: string; launchId?: string; startDispatchId?: string; traceparent?: string; catchupBatchId?: string; breakerGeneration?: number; takeoverEpoch?: number; humanStart?: boolean }
  | { type: "agent:stop"; agentId: string }
  /**
   * Answer to a daemon `agent:wake:request` (task #1103). `dispatched` means
   * the Server issued its ordinary `agent:start` for this agent; `refused` is
   * terminal for this request and carries why, so the daemon can surface it
   * instead of retrying locally.
   */
  | { type: "agent:wake:outcome"; agentId: string; wakeRequestId: string; outcome: "dispatched" | "refused"; reason?: AgentWakeRefusedReason }
  // Remote control of a managed Computer (web → server → machine WS → the
  // Computer's own service IPC). `computer:restart` → restart-service;
  // `computer:upgrade` → upgrade-start (§12 self-update). Additive: raw
  // daemons (and Computers running older bundles) ignore unknown types via
  // the daemon's unmatched-switch fallthrough, so this is backward-safe.
  | { type: "computer:restart"; operationId?: string; requestId?: string }
  // v2 (task #873): the Server resolves the exact target; the Computer runs
  // the external installer against it and reports nothing until it is back.
  | { type: "computer:upgrade"; operationId?: string; requestId?: string; targetVersion?: string }
  | { type: "computer:lifecycle:receipt"; operationId: string; phase: "shutdown" | "ready" }
  | { type: "agent:reset-workspace"; agentId: string }
  | { type: "agent:deliver"; agentId: string; message: AgentMessage; seq: number; traceparent?: string; deliveryId?: string; transient?: boolean; mentionDelivery?: MentionDeliveryIdentitySnapshot }
  | { type: "agent:inbox:purge"; agentId: string; channelIds: string[]; reason?: string }
  | { type: "agent:workspace:list"; agentId: string; dirPath?: string; includeHidden?: boolean }
  | { type: "agent:workspace:read"; agentId: string; path: string; requestId: string }
  | { type: "agent:workspace:ensure-wiki"; agentId: string; requestId: string; pack: WikiWorkspacePack }
  | { type: "agent:skills:list"; agentId: string; runtime?: string; requestId?: string }
  | { type: "agent:diagnostic:session_transcript"; agentId: string; requestId: string }
  /**
   * `includeMachineLogTail` (task #272 tier 2): the machine OWNER opted in to
   * attach the redacted runner log tail for this one report. The server sets
   * it only after checking the reporter owns the machine; older daemons ignore
   * the field and upload the transcript exactly as before.
   */
  | { type: "agent:diagnostic:feedback_transcript"; agentId: string; feedbackReportId: string; requestId: string; feedbackReportGeneratedAt?: string; feedbackReportTimeSource?: FeedbackTranscriptReportTimeSource; includeMachineLogTail?: boolean }
  /**
   * Ask the daemon to re-emit current activity ground-truth for an agent.
   * Replaces the server-side "synthesize online when transient state is
   * stale" behaviour so the server stops inventing state.
   *
   * Daemon responds via the existing `agent:activity` upstream channel
   * with `probeId` echoed back so the server can correlate. Old daemons
   * that don't recognize this type fall through their unknown-type
   * switch silently (server-side fallback timer kicks in after 5s →
   * synth `online` like today).
   *
   * Introduced 2026-05-02 #engineering:72283cf7 task #340 (#1).
   */
  | { type: "agent:activity_probe"; agentId: string; probeId: string; purpose: "sweep" | "manual" }
  | { type: "machine:workspace:scan" }
  | { type: "machine:workspace:delete"; directoryName: string }
  | { type: "machine:runtime_models:detect"; requestId: string; runtime: string }
  /**
   * Ask the owning Computer to run one bounded provider probe for an opaque
   * probe intent. Carries no credential, endpoint or connection id: the daemon
   * resolves the one-time materialization itself with machine auth. Older
   * daemons ignore the additive message, which the Server detects through the
   * missing `provider-probe:v1` capability before dispatch.
   */
  | {
      type: "machine:provider_probe:request";
      requestId: string;
      probeId: string;
      runtime: string;
      model: string;
    }
  /**
   * Ask the owning Computer to refresh one provider's sanitized account-usage
   * snapshot. This is never sent by a cache-read endpoint without the
   * owner/gate/cooldown checks. Older daemons ignore the additive message.
   */
  | {
      type: "machine:runtime_account_usage:refresh";
      requestId: string;
      provider: RuntimeAccountUsageProvider;
      reason: "manual" | "stale_or_missing" | "scheduled";
    }
  // Ask the computer to re-detect which runtimes are installed. The daemon answers
  // by re-emitting its ready/capabilities report, so there is no separate result
  // message — the existing capabilities push IS the response. Older daemons simply
  // ignore this, so callers must not block on it.
  | { type: "machine:runtimes:rescan" }
  | {
      type: "machine:migration:source_workspace_archive";
      requestId: string;
      migrationId: string;
      agentId: string;
      /**
       * Creation time of the migration being cleaned up (added; optional). A
       * daemon refuses to archive a workspace committed by a later migration.
       */
      migrationCreatedAt?: string;
    }
  | {
      type: "machine:migration_transport:lease";
      agentId: string;
      migrationId: string;
      migrationRef: string;
      migrationGeneration: string;
      sessionId: string;
      role: "source" | "target";
      provider: "object_store";
      transferKind: "upload" | "download";
      leaseSource: "server";
      bearerToken: string;
      expiresAt: string;
      maxBytes: number;
      controlUrl: string;
      leaseId: string;
      transportGeneration: string;
      sourceMachineId: string;
      targetMachineId: string;
      expectedMigrationRevision: number;
      sourceQuiesceReceipt?: import("./agentMigrationResumable").AgentMigrationSourceQuiesceReceipt;
    }
  | { type: "agent:runtime_profile:migration"; agentId: string; migrationKey: string; message: string; launchId?: string; traceparent?: string }
  | {
      type: "machine:migration:cancel";
      agentId: string;
      migrationId: string;
      migrationRef: string;
      transportGeneration: string;
      cancelGeneration: string;
      migrationRevision: number;
      sessionId: string | null;
      role: "source" | "target";
      disposition: "pre_flip_source_authoritative" | "post_flip_target_authoritative";
      stopAgent: boolean;
    }
  | { type: "agent:runtime_profile:daemon_release_notice"; agentId: string; noticeKey: string; message: string; launchId?: string; traceparent?: string }
  | { type: "reminder.upsert"; agentId: string; reminder: ReminderJob }
  | { type: "reminder.cancel"; agentId: string; reminderId: string; version: number }
  | { type: "reminder.snapshot"; agentId: string; reminders: ReminderJob[] }
  | ComputerBoundDueReceiptMessage
  /**
   * Server→Computer app config transport (task #204). Typed envelope only —
   * no notification/timer/measure payload. Additive for older daemons.
   */
  | {
      type: "app_config.upsert";
      agentId: string;
      config: import("./appConfigTransport").AppConfigWireSnapshot;
    }
  | {
      type: "app_config.snapshot";
      agentId: string;
      configs: import("./appConfigTransport").AppConfigWireSnapshot[];
    }
  | { type: "ping" };

export type AgentMigrationTransportLeaseMessage = Extract<ServerToMachineMessage, { type: "machine:migration_transport:lease" }>;

/**
 * Scrubbed, classified runtime-error facts that are safe to cross the daemon
 * protocol boundary. Keep every vocabulary closed: upstream exception names,
 * messages, paths, payloads, and arbitrary diagnostic fields do not belong on
 * this carrier.
 */
export const RUNTIME_ERROR_CLASSES = [
  "RuntimeError",
  "InputTooLargeError",
  "RateLimitError",
  "AuthError",
  "LauncherError",
  "NotFoundError",
  "ModelConfigError",
  "TimeoutError",
  "ProviderConnectionError",
  "ProviderStreamError",
  "ProviderServerError",
  "ProviderApiError",
  "OperationAbortedError",
  /** task #1127 — the model produced tool-call arguments the runtime could not deserialize. */
  "ToolArgumentParseError",
  /** task #917 — the provider's billing or credit balance is exhausted (HTTP 402). Retrying cannot succeed. */
  "BillingError",
] as const;
export type RuntimeErrorClass = (typeof RUNTIME_ERROR_CLASSES)[number];

export const RUNTIME_ERROR_REASONS = [
  "unclassified_runtime_error",
  "input_too_large",
  "rate_limited",
  "auth_failed",
  "launcher_error",
  "not_found",
  "model_config_error",
  "provider_timeout",
  "provider_connection_error",
  "provider_stream_error",
  "provider_server_error",
  "provider_api_error",
  "operation_aborted",
  /** task #1127 — pairs with ToolArgumentParseError. */
  "model_tool_args_invalid",
  /** task #917 — pairs with BillingError. */
  "billing_exhausted",
] as const;
export type RuntimeErrorReason = (typeof RUNTIME_ERROR_REASONS)[number];

export const RUNTIME_ERROR_REASON_PROVENANCES = [
  "runtime_error_event",
  "codex_native_reason",
  "daemon_fallback",
  /**
   * task #1127 — the reason was recovered from a pinned upstream stderr
   * sentence because no structured event carries the fact. Distinct from
   * `daemon_fallback`, which means the daemon guessed from whatever text it had:
   * this one names a specific, tested signature, so the share of typed errors
   * resting on text remains countable rather than hidden in the fallback bucket.
   */
  "codex_stderr_signature",
] as const;
export type RuntimeErrorReasonProvenance = (typeof RUNTIME_ERROR_REASON_PROVENANCES)[number];

/**
 * The one canonical class → reason pairing. The server rejects any carrier whose
 * reason disagrees with this, so keeping a second copy on the daemon side would
 * turn a compile error into a silently dropped carrier.
 */
export function runtimeErrorReasonForClass(errorClass: RuntimeErrorClass): RuntimeErrorReason {
  switch (errorClass) {
    case "InputTooLargeError": return "input_too_large";
    case "RateLimitError": return "rate_limited";
    case "AuthError": return "auth_failed";
    case "LauncherError": return "launcher_error";
    case "NotFoundError": return "not_found";
    case "ModelConfigError": return "model_config_error";
    case "TimeoutError": return "provider_timeout";
    case "ProviderConnectionError": return "provider_connection_error";
    case "ProviderStreamError": return "provider_stream_error";
    case "ProviderServerError": return "provider_server_error";
    case "ProviderApiError": return "provider_api_error";
    case "OperationAbortedError": return "operation_aborted";
    case "ToolArgumentParseError": return "model_tool_args_invalid";
    case "BillingError": return "billing_exhausted";
    case "RuntimeError": return "unclassified_runtime_error";
  }
}

export interface RuntimeErrorActivityDiagnostic {
  errorClass: RuntimeErrorClass;
  errorReason: RuntimeErrorReason;
  /** 16-hex SHA-256 prefix of daemon-scrubbed text. Never hash raw text. */
  fingerprint: string;
  reasonProvenance: RuntimeErrorReasonProvenance;
  /** Absent means that the runtime event contract cannot answer this fact. */
  nativeReasonPresent?: boolean;
}

/**
 * task #1116 — typed carrier for the daemon's delivery-consumption observation
 * (task #1114). Ids, classes, counts and times only; never message text or
 * credentials. Attached to `agent:activity` with detailKind
 * "delivery_unconsumed" and passed through by the server unchanged.
 */
export interface DeliveryConsumptionActivityDiagnostic {
  launchId: string;
  episode: number;
  unconsumedDeliveries: number;
  firstUnconsumedAtMs: number | null;
  lastDeliveryAtMs: number | null;
  /** deliveryId ?? message_id ?? app-inbox item id. */
  lastDeliveryKey: string | null;
  lastDeliveryPath: "stdin_idle_delivery" | "stdin_turn_end_delivery" | "busy_stdin_notification" | "app_inbox_notice" | null;
  lastConsumptionKind: "thinking" | "text" | "tool_call" | "tool_output" | "turn_end" | null;
  lastConsumptionAtMs: number | null;
  lastRuntimeResult: { kind: "completed"; atMs: number; empty: boolean } | { kind: "error"; atMs: number; errorClass: string } | null;
  lastDeliveryErrorClass: string | null;
  processAlive: boolean;
}

/**
 * task #1119 — typed carrier for the server's wake crash-loop breaker state,
 * attached to `agent:activity` with detailKind "wake_crash_loop_blocked".
 * Counts, classes, ids and times only.
 */
export interface WakeCrashLoopActivityDiagnostic {
  episode: number;
  earlyExitCount: number;
  threshold: number;
  windowMs: number;
  blocked: boolean;
  blockedAtMs: number | null;
  firstExitAtMs: number | null;
  lastExitAtMs: number | null;
  lastExitKind: "machine_disconnected" | "agent_process_exited" | null;
  lastSignal: string | null;
  lastLaunchId: string | null;
}

export type FeedbackTranscriptReportTimeSource = "web_report_bundle" | "server_request_received";

/**
 * task #1120/#1123 — stable, machine-readable reason a daemon could not
 * launch an agent. Decided by typed error code on the daemon (never by message
 * text) and carried to the web unchanged so copy is chosen by reason, not by
 * parsing the detail string. Adding a member is compatible; older servers and
 * web builds ignore the carrier, older daemons never send it.
 */
export const SPAWN_FAILURE_REASONS = [
  "agent_proxy_bind_failed",
  "runner_credential_mint_failed",
  "provider_connection_materialization_failed",
  "runtime_not_found",
  "model_not_found",
  "runtime_version_too_old",
  "runtime_spawn_failed",
  "runtime_login_required",
  "runtime_config_invalid",
  "model_not_configured",
] as const;
export type SpawnFailureReason = (typeof SPAWN_FAILURE_REASONS)[number];

/**
 * task #1221 — start failures that retrying cannot fix: the runtime refused
 * this agent's configuration (model not configured, config invalid) or needs a
 * human login. The server stops automatic relaunches after one of these until
 * a person restarts the agent or changes its runtime configuration.
 */
export const NON_RETRYABLE_SPAWN_FAILURE_REASONS: readonly SpawnFailureReason[] = [
  "model_not_configured",
  "runtime_login_required",
  "runtime_config_invalid",
];

/**
 * task #1123 — typed carrier on the `runtime_unavailable` activity frame the
 * daemon sends when a start fails. `model` is present only for
 * `model_not_found` (the configured model name, not provider output).
 */
export interface SpawnFailureActivityDiagnostic {
  reason: SpawnFailureReason;
  model?: string;
}
/** Tier-2 (task #272) machine log tail outcome, reported beside the transcript result. Absent from older daemons. */
export interface FeedbackMachineLogTailOutcome {
  reachable: boolean;
  traceBundleId?: string;
  fallbackReason?: string;
  error?: string;
  lineCount?: number;
  sourceLineCount?: number;
  truncated?: boolean;
}
/**
 * Outcome of the machine_evidence attachment, reported beside the transcript
 * result. Additive and absent from older daemons. Never decides the transcript
 * result: the transcript is uploaded and reported regardless of this outcome.
 *   uploaded    stored by the worker as kind machine_evidence
 *   omitted     not uploaded: even with every trace record dropped the object exceeds the byte cap
 *   unsupported the server or worker did not acknowledge the machine_evidence kind (older deployment); nothing uploaded
 *   failed      generation, signing or upload failed (see `error`)
 *   timeout     did not finish within the bounded wait; the transcript result was returned without it
 */
export interface FeedbackMachineEvidenceOutcome {
  status: "uploaded" | "omitted" | "unsupported" | "failed" | "timeout";
  traceBundleId?: string;
  error?: string;
  reason?: "over_byte_cap";
  /** Raw UTF-8 JSON bytes of the object (uploaded) or of its smallest form (omitted). */
  bytes?: number;
  truncated?: boolean;
  droppedOverBytes?: number;
  /** Sections whose provider failed; they were sent as null. */
  unavailable?: ("observedFailureSummary" | "feedbackTraceTail" | "feedbackMachineState")[];
}
export type FeedbackTranscriptWindowCoverage =
  | "covered"
  | "outside_report_window"
  | "timestamps_unavailable"
  | "report_time_invalid";
export type FeedbackTranscriptTruncationDirection = "head" | "tail" | "window";

export interface FeedbackTraceBundleTranscriptMetadata {
  feedbackReportTimeSource?: FeedbackTranscriptReportTimeSource;
  feedbackTranscriptFirstEventAt?: string;
  feedbackTranscriptLastEventAt?: string;
  feedbackTranscriptTruncated?: "true" | "false";
  feedbackTranscriptTruncationDirection?: FeedbackTranscriptTruncationDirection;
  feedbackTranscriptWindowCoverage?: FeedbackTranscriptWindowCoverage;
}

export const FEEDBACK_TRACE_BUNDLE_TRANSCRIPT_METADATA_KEYS = {
  feedbackReportTimeSource: true,
  feedbackTranscriptFirstEventAt: true,
  feedbackTranscriptLastEventAt: true,
  feedbackTranscriptTruncated: true,
  feedbackTranscriptTruncationDirection: true,
  feedbackTranscriptWindowCoverage: true,
} satisfies Record<keyof FeedbackTraceBundleTranscriptMetadata, true>;
export type FeedbackTraceBundleTranscriptMetadataKey =
  keyof typeof FEEDBACK_TRACE_BUNDLE_TRANSCRIPT_METADATA_KEYS;

export interface FeedbackTranscriptWindow {
  reportGeneratedAt: string;
  reportTimeSource: FeedbackTranscriptReportTimeSource;
  reportWindowStartAt: string;
  toleranceMs: number;
  coverage: FeedbackTranscriptWindowCoverage;
  transcriptFirstEventAt?: string;
  transcriptLastEventAt?: string;
}

export type MachineToServerMessage =
  /**
   * TODO(lifecycle-v2/daemon-protocol): `agent:status`,
   * `agent:activity`, and `agent:session` are legacy lifecycle signal
   * frames. The server currently adapts them into canonical lifecycle events
   * in `legacyAgentLifecycleAdapter`. The next protocol should add structured
   * daemon lifecycle events for runtime_ready/runtime_interrupted,
   * activity/progress, session_init/resync, runtime_stalled/provider_error,
   * and process_exit with explicit reason/correlation/window attrs. Once the
   * supported daemon window speaks that protocol, delete these lifecycle
   * compatibility frames from the reducer path.
   */
  | {
      type: "agent:status";
      agentId: string;
      status: string;
      launchId?: string;
      /**
       * task #1119: when `status` reports a process exit, the daemon attaches
       * how the process ended so the server's crash-loop breaker can record
       * the signal (ids/classes only). Absent on older daemons.
       */
      exit?: { code: number | null; signal: string | null };
      /**
       * RFC 069 §8 (with `DAEMON_CAPABILITY_SEQUENCED_STATUS`): the sending
       * daemon process and its per-agent sequence, shared with
       * `agent:activity`. Sequences compare only within one
       * `daemonInstanceId`. Absent on older daemons.
       */
      daemonInstanceId?: string;
      clientSeq?: number;
    }
  /**
   * `probeId` (optional) — when this activity message is the daemon's
   * response to a prior `agent:activity_probe`, the daemon echoes back
   * the server-issued `probeId`. Server uses it to correlate the
   * response with its pending probe and cancel the fallback timer.
   * Self-initiated activity broadcasts (heartbeat, transition, etc.)
   * leave `probeId` unset.
   *
   * `clientSeq` (optional) — daemon-side per-agent monotonic counter
   * (starts at 1 on daemon process start, increments on each emit).
   * `daemonInstanceId` identifies that daemon process lifetime. Server uses
   * `(daemonInstanceId, launchId, clientSeq)` as the dedupe key on ingest
   * and drops messages whose `clientSeq` is not strictly greater than
   * the highest seen for that daemon/launch generation. The process identity
   * stays stable across WS reconnects but changes across daemon restarts, so
   * reconnect replays remain deduped without carrying a stale watermark into
   * a new daemon process. Old daemons leave it unset and use the server-owned
   * legacy ingest epoch compatibility path.
   * Activity has no durable cross-process outbox: a daemon restart accepts
   * in-flight activity loss and never redelivers pre-restart facts under the
   * new process identity. This is what makes generations independent. Adding
   * a durable activity outbox would require content-level cross-generation
   * dedupe before replay can be enabled.
   *
   * Roll out the optional carrier server/shared first, then daemon producers.
   * Until every daemon sends it, absence must remain on the typed legacy
   * compatibility path rather than being interpreted as a process identity.
   * Introduced 2026-05-02 #engineering:72283cf7 task #340 PR B.
   */
  /**
   * `isHeartbeat` is the producer-declared replay-provenance bit
   * (lifecycle-v2 #457/#460): the daemon's activity heartbeat timer knows at
   * emission time that it re-broadcasts stale lastActivity, so it declares
   * true; every other send (genuine broadcast, probe response) declares
   * false explicitly. Absence = legacy daemon cohort, which the server
   * classifies through the content-identity compat shim only. Closed
   * three-state semantics — never infer it server-side from seq or
   * producerFactId (both advance on heartbeat replays).
   * Introduced 2026-07-04 #proj-runtime:19709f22 task #460 PR-beta-2.
   */
  | { type: "agent:activity"; agentId: string; activity?: string; activityKind?: AgentActivityKind; detail: string; detailKind?: AgentActivityDetailKind; entries?: DaemonTrajectoryEntry[]; launchId?: string; daemonInstanceId?: string; probeId?: string; clientSeq?: number; producerFactId?: string; observedAtMs?: number; isHeartbeat?: boolean; runtimeError?: RuntimeErrorActivityDiagnostic; deliveryConsumption?: DeliveryConsumptionActivityDiagnostic; spawnFailure?: SpawnFailureActivityDiagnostic; providerRequest?: import("./providerRequestActivity").ProviderRequestActivity }
  | { type: "agent:session"; agentId: string; sessionId: string; launchId?: string }
  | { type: "agent:session:invalidate"; agentId: string; sessionId: string; launchId?: string; reason: "missing" | "provider_replay_rejected" }
  | { type: "agent:runtime_profile"; agentId: string; facts: AgentRuntimeProfileReport; launchId?: string; traceparent?: string; source?: RuntimeProfileReportSource }
  | { type: "agent:runtime_profile:migration:ack"; agentId: string; migrationKey: string; launchId?: string; traceparent?: string }
  | { type: "agent:runtime_profile:migration_done"; agentId: string; migrationKey: string; launchId?: string; traceparent?: string }
  | { type: "agent:runtime_profile:daemon_release_notice:ack"; agentId: string; noticeKey: string; launchId?: string; traceparent?: string }
  /**
   * The daemon has an app-inbox item due for an agent that has no local
   * process and no in-memory restart snapshot (e.g. every idle agent after a
   * daemon restart). The Server owns the agent config, so it decides and
   * dispatches the start (task #1103). `wakeRequestId` is derived from the
   * agent and the inbox item, so a duplicate fire or a resend after reconnect
   * carries the same id and the Server can replay its outcome.
   */
  | { type: "agent:wake:request"; agentId: string; wakeRequestId: string; reason: "app_inbox_notice"; appId: string; sourceRef: { kind: string; id: string; revision?: string }; pendingAppItems: number; traceparent?: string }
  /**
   * `processInstanceId` (RFC 071 §4.3 rule 2, optional): the registered
   * process that now carries `launchId`. Set only when `queueState` is
   * `running`/`rebound` AND a process is registered (a rebind); a
   * `queued`/`starting` ack never carries one, because the daemon mints the
   * id only after the spawn (it arrives on `agent:process_spawned`).
   */
  | { type: "agent:start:ack"; agentId: string; startDispatchId: string; launchId?: string; queueState: "queued" | "starting" | "running" | "rebound"; queueDepth: number; queueAgeMs: number; traceparent?: string; processInstanceId?: string }
  /**
   * RFC 071 §7 (with `DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1`): a launch-bound
   * runtime outcome. E1 `terminal_failure` is sent once, from the daemon's
   * terminal cleanup, before the process record is removed; its fingerprint
   * is computed from the RAW runtime text, never from display copy. E2
   * `turn_completed` is sent at turn end only for a registered launch whose
   * turn produced model output with zero runtime errors. `clientSeq` is the
   * per-agent counter shared with `agent:status`/`agent:activity` (RFC 069
   * §8); it compares only within one `daemonInstanceId`. A server ignores a
   * frame with an unknown `v`. Servers without a handler drop the type.
   */
  | {
      type: "agent:runtime:outcome";
      v: 1;
      agentId: string;
      launchId: string;
      sessionId: string | null;
      daemonInstanceId: string;
      clientSeq: number;
      observedAtMs: number;
      traceparent?: string;
      outcome: AgentRuntimeOutcome;
      /** RFC 071 outbox: `breakerGeneration` of this launch's agent:start, when it had one. */
      generation?: number;
    }
  /**
   * RFC 071 §4.3 rule 2: sent right after a successful spawn, with the
   * process identity the daemon minted for it. `launchId` is the launch the
   * process was spawned for.
   */
  | {
      type: "agent:process_spawned";
      agentId: string;
      daemonInstanceId: string;
      processInstanceId: string;
      launchId: string;
      clientSeq: number;
      /**
       * Other launches the daemon accepted and folded into this spawn (a start
       * that arrived while this one was queued or starting). Each is bound to
       * this process identity; none of them gets a process of its own.
       */
      supersededLaunchIds?: string[];
      /**
       * True when no accepted server start was waiting for this spawn: the
       * daemon restarted the runtime on its own (idle/cold restart, a deferred
       * spawn woken by a message) under an already-settled `launchId`.
       */
      respawn?: boolean;
      /** RFC 071 outbox: `breakerGeneration` of `launchId`'s agent:start, when it had one. */
      generation?: number;
    }
  /**
   * RFC 071: the final result for an accepted launch that is not reported by
   * `agent:process_spawned`. Every launch the daemon accepts from
   * `agent:start` ends in exactly one of: named in a `process_spawned`
   * (`launchId` or `supersededLaunchIds`), `rebound` onto a running process,
   * or `not_spawned` with a reason. `not_spawned` is sent only when the
   * daemon knows no process was created for the launch.
   */
  | {
      type: "agent:start:outcome";
      agentId: string;
      daemonInstanceId: string;
      launchId: string;
      clientSeq: number;
      result:
        | { kind: "rebound"; processInstanceId: string }
        | { kind: "not_spawned"; reason: AgentStartNotSpawnedReason };
      /** RFC 071 outbox: `breakerGeneration` of this launch's agent:start, when it had one. */
      generation?: number;
    }
  /**
   * RFC 071 outbox markers. Overflow folds the oldest un-acked critical
   * frames of one daemon instance and takeover epoch into a gap; the counts
   * say what was folded. The server must treat the range conservatively.
   */
  | {
      type: "agent:runtime:outcome_gap";
      agentId: string;
      daemonInstanceId: string;
      gapId: string;
      fromSeq: number;
      toSeq: number;
      counts: AgentRuntimeOutcomeGapCounts;
      takeoverEpoch: number;
    }
  /** Gaps of more daemon instances than the outbox keeps, merged. */
  | {
      type: "agent:runtime:outcome_cross_instance_unknown";
      agentId: string;
      gapId: string;
      instances: string[];
      counts: AgentRuntimeOutcomeGapCounts;
      takeoverEpoch: number;
    }
  /** The daemon's outcome storage for this agent failed (write/fsync error or corrupt file): evidence may be missing. Best effort. */
  | { type: "agent:runtime:outcome_unreliable"; agentId: string; daemonInstanceId: string; takeoverEpoch: number }
  /**
   * RFC 071 §4.3 rule 3: sent from the runtime's own `exit` event with the
   * identity of the process that exited (closure-captured, not the current
   * registry entry), whether or not the daemon still has it registered.
   * `spawnLaunchId` is the launch it was spawned for: `null` when the daemon
   * started it on its own without a server launch (an internal restart) and
   * a server start was later rebound onto it (the rebind is never treated as
   * its birth). `launchId` is the associated launch: the last server launch
   * it carried (a rebind changes it). The process is identified by
   * `(daemonInstanceId, processInstanceId)`, the identity the server bound
   * through `process_spawned` or the `rebound` start outcome; a null
   * `spawnLaunchId` is settled by that identity only. The only exit evidence
   * the terminal-failure breaker uses.
   */
  | { type: "agent:process_exited"; agentId: string; daemonInstanceId: string; processInstanceId: string; spawnLaunchId: string | null; launchId: string; clientSeq: number; code: number | null; signal: string | null; /** RFC 071 outbox: `breakerGeneration` of `launchId`'s agent:start, when it had one. */ generation?: number }
  | { type: "agent:deliver:ack"; agentId: string; seq: number; traceparent?: string; deliveryId?: string; mentionDelivery?: MentionDeliveryIdentitySnapshot }
  /**
   * Message bodies the daemon itself put in front of the model (startup
   * catch-up, wake with thread context, full-body stdin delivery), reported
   * once the runtime showed it took the input. The Server moves the agent's
   * read position over them only where they join it without a gap. Sent with
   * or without `agent:model-seen-boundary`; that capability additionally
   * means pulls are reported elsewhere (design-model-seen-boundary).
   */
  | { type: "agent:model-seen"; agentId: string; launchId?: string; items: AgentModelSeenItem[] }
  | { type: "agent:delivery:transition"; agentId: string; stage: MentionDeliveryTransitionStage; outcome: "accepted" | "coalesced"; mentionDelivery: MentionDeliveryIdentitySnapshot; traceparent?: string }
  | { type: "agent:delivery:terminal_error"; agentId: string; code: MentionDeliveryTerminalErrorCode; mentionDelivery: MentionDeliveryIdentitySnapshot; traceparent?: string }
  /**
   * The daemon received an `agent:deliver` for an agent that has no running
   * process and no cached idle/restart config (task #1113). It cannot wake the
   * agent itself; the Server owns the config and must fall back to an
   * `agent:start` that carries this message. Keyed like the delivery ack
   * (deliveryId, else agentId+seq) so duplicates are idempotent.
   */
  | { type: "agent:delivery:rejected"; agentId: string; seq: number; deliveryId?: string; reason: "no_process"; mentionDelivery?: MentionDeliveryIdentitySnapshot; traceparent?: string }
  | { type: "agent:workspace:file_tree"; agentId: string; files: FileNode[]; dirPath?: string; includeHidden?: boolean }
  | { type: "agent:workspace:file_content"; agentId: string; requestId: string; content: string | null; binary: boolean; size?: number; mimeType?: string; encoding?: "utf-8" | "base64" }
  | { type: "agent:workspace:wiki_ensured"; agentId: string; requestId: string; success: boolean; packId: string; files: WikiWorkspaceFileReceipt[]; error?: string }
  | { type: "agent:skills:list_result"; agentId: string; requestId?: string; global: SkillInfo[]; workspace: SkillInfo[] }
  | { type: "agent:diagnostic:session_transcript_result"; agentId: string; requestId: string; runtime: string; sessionId: string; reachable: boolean; path: string | null; fallbackReason?: string; transcript: string | null; sizeBytes: number; truncated: boolean; redacted: boolean; tier: string; error?: string }
  | {
      type: "agent:diagnostic:feedback_transcript_result"; agentId: string; feedbackReportId: string; requestId: string; traceBundleId?: string; reachable: boolean; fallbackReason?: string; error?: string; transcriptWindow?: FeedbackTranscriptWindow; machineLogTail?: FeedbackMachineLogTailOutcome; machineEvidence?: FeedbackMachineEvidenceOutcome;
      // task #1228 ① (additive; absent from older daemons, ignored by older servers).
      outcomeVersion?: 1;
      lookup?: FeedbackTranscriptLookupOutcome;
      upload?: FeedbackTranscriptUploadOutcome;
      outcomeObject?: FeedbackTranscriptOutcomeObjectPlan;
    }
  | { type: "machine:workspace:scan_result"; directories: WorkspaceDirectoryInfo[] }
  | { type: "machine:workspace:delete_result"; directoryName: string; success: boolean }
  | {
      type: "machine:migration:source_workspace_archive_result";
      requestId: string;
      migrationId: string;
      agentId: string;
      // "source_absent": nothing of the agent is left on the source (added; older
      // servers treat any non-"error" outcome as success).
      outcome: "archived" | "already_archived" | "source_absent" | "error";
      /** Code-shaped failure cause when outcome is "error" (added; optional). */
      errorCode?: string;
    }
  | {
      type: "machine:runtime_models:result";
      requestId: string;
      /**
       * Typed source truth. New servers prefer this field; the legacy fields
       * below remain during the daemon/server rolling-upgrade window.
       */
      outcome?: RuntimeModelSourceOutcome;
      models?: RuntimeModelInfo[];
      default?: string;
      error?: string;
    }
  /**
   * Unsolicited: this machine's current model list for one runtime, with the
   * runtime's own display names. The server keeps one copy per (machine,
   * runtime) and every model-name surface reads it, so the runtime config
   * selector and the rest of the UI show the same name. Sent only for a live
   * detection result; replaces the previous copy whole.
   */
  | {
      /**
       * Proactive model-list report (task #700): the daemon reports each
       * runtime's model list so every display surface can read one shared
       * catalog instead of re-deriving names. Sent on connect (after
       * `ready`, per runtime in `ready.runtimes`) and again after a runtime
       * rescan; whole-list replacement per runtime. Only `live` detections
       * are sent — errors/unsupported keep the server's previous copy.
       */
      type: "machine:runtime_models:catalog";
      runtime: string;
      models: RuntimeModelCatalogEntry[];
    }
  | {
      type: "machine:provider_probe:result";
      requestId: string;
      probeId: ProviderProbeId;
      outcome: "success" | "failure";
      category: ProviderProbeDaemonCategory | null;
      latencyMs: number | null;
      responseSha256: string | null;
      responseBytes: number | null;
      resultDigest: string;
      authorityEcho: { connectionEpochId: string; replicaGeneration: string };
      daemonVersion: string | null;
      computerVersion: string | null;
      runtimeVersion: string | null;
      reply: string | null;
    }
  /** Closed, sanitized payload; provider credentials/raw responses never cross this boundary. */
  | {
      type: "machine:runtime_account_usage:snapshot";
      requestId?: string;
      snapshot: RuntimeAccountUsageSnapshot;
    }
  /**
   * Space on the disk holding agent data, sent on connect and hourly. Servers
   * that predate it ignore the unknown type.
   */
  | { type: "machine:disk_status"; availableBytes: number; totalBytes: number }
  /**
   * Best-effort graceful shutdown notice sent immediately before the daemon
   * closes its WebSocket. The server uses it to distinguish an intentional
   * Computer/daemon stop from an unplanned transport disconnect.
   */
  | { type: "machine:shutdown"; reason: MachineShutdownReason; lifecycleAcks?: ComputerLifecycleExecutionAck[] }
  | ServerBoundDueReceiptMessage
  | { type: "reminder.snapshot.request"; agentId: string }
  /** Request Server→Computer refill of typed app config envelopes for one agent. */
  | { type: "app_config.snapshot.request"; agentId: string }
  | { type: "ping" }
  | { type: "pong" }
  /**
   * Terminal completion of a remote machine-wide Computer restart. The old
   * generation persists the request before exiting; the newly ready origin
   * runner emits this receipt after reconnect.
   */
  | { type: "computer:restart:done"; requestId: string; ok: boolean; error?: string }
  | { type: "ready"; capabilities?: string[]; /** RFC 069 §8: this daemon process's generation. */ daemonInstanceId?: string; /** RFC 071 outbox: agents whose outcome storage is unreliable; `agent:runtime-outcome-v1` does not apply to them. */ runtimeOutcomeUnreliableAgents?: string[]; runtimes: string[]; runtimeVersions?: Record<string, string>; runningAgents: string[]; hostname?: string; os?: string; daemonVersion?: string; computerVersion?: string; migrationTransport?: AgentMigrationTransportReady; lifecycleAcks?: ComputerLifecycleExecutionAck[]; lastUpgradeReceipt?: ComputerLastUpgradeReceipt };

export type MachineShutdownReason =
  | "computer_stop"
  | "daemon_stop"
  | "unknown";

export interface AgentRuntimeContext {
  /** The agent process receiving this context. */
  agentId?: string | null;
  /** Server/org context this launch is serving. */
  serverId?: string | null;
  /** Server-side machine UUID that owns this launch. */
  machineId?: string | null;
  /** Human-readable machine name from Slock. */
  machineName?: string | null;
  /** Human-authored machine description from Slock, when set. */
  machineDescription?: string | null;
  /** Daemon-reported host name, when known. */
  machineHostname?: string | null;
  /** Daemon-reported OS/platform, when known. */
  machineOs?: string | null;
  /** Connected daemon version, when known. */
  daemonVersion?: string | null;
  /** Local workspace path for this agent process, filled by the daemon. */
  workspacePath?: string | null;
}

export const RUNTIME_CONFIG_VERSION = 1 as const;

export type RuntimeId =
  | "builtin"
  | "claude"
  | "codex"
  | "grok"
  | "antigravity"
  | "kimi-sdk"
  | "kimi"
  | "copilot"
  | "cursor"
  | "gemini"
  | "opencode"
  | "pi"
  | "external";

/**
 * Claude Code runtime provider config.
 *
 * `apiKey` is intentionally still a plaintext persisted field in the current
 * runtime-config capability. This is a known gap, not a managed-secret or
 * SecretRef contract.
 */
export type ClaudeRuntimeProviderConfig = // Runtime-scoped; provider kinds from other runtime arms fail closed.
  | { kind: "default" }
  | { kind: "custom"; apiUrl: string; apiKey: string };

/**
 * Pi runtime provider config.
 *
 * `apiKey` is intentionally still a plaintext persisted field in the current
 * runtime-config capability. This is a known gap, not a managed-secret or
 * SecretRef contract.
 */
export type PiRuntimeProviderConfig = // Runtime-scoped; provider kinds from other runtime arms fail closed.
  | { kind: "default" }
  // Pi runtime built-in provider with a web-supplied API key. Maps to the
  // env var that the Pi SDK reads for that provider (see
  // PI_BUILTIN_PROVIDER_ENV_KEYS) so no auth.json mutation is needed.
  | { kind: "pi-builtin"; providerId: string; apiKey: string };

/**
 * Built-in / Quick Start provider config.
 *
 * `apiKey` is intentionally still a plaintext persisted field in the current
 * runtime-config capability. This is a known gap, not a managed-secret,
 * secret-store, or SecretRef contract.
 */
export type BuiltInRuntimeProviderConfig =
  | {
      /** Server-managed credential reference; contains no provider secret. */
      kind: "connection";
      connectionId: string;
    }
  | {
      kind: "preset";
      providerId: BuiltInRuntimeProviderId;
      apiKey: string;
    }
  | {
      kind: "gateway";
      providerId: BuiltInRuntimeGatewayProviderId;
      baseUrl: string;
      apiKey: string;
      /**
       * Operator-declared capability for a custom gateway model. Omission is
       * migration-compatible and has the same conservative meaning as false.
       */
      supportsImageInput?: boolean;
    };

export const BUILTIN_RUNTIME_PROVIDER_ENV_KEYS = PI_BUILTIN_PROVIDER_API_KEY_ENV_KEYS_GENERATED;
export type BuiltInRuntimeProviderId = keyof typeof BUILTIN_RUNTIME_PROVIDER_ENV_KEYS;

export const BUILTIN_RUNTIME_PROVIDERS = Object.entries(BUILTIN_RUNTIME_PROVIDER_ENV_KEYS).map(([id, envKey]) => ({ id, envKey })) as
  ReadonlyArray<{ id: BuiltInRuntimeProviderId; envKey: typeof BUILTIN_RUNTIME_PROVIDER_ENV_KEYS[BuiltInRuntimeProviderId] }>;

export const PI_BUILTIN_PROVIDER_ENV_KEYS: Record<string, string> = {
  deepseek: BUILTIN_RUNTIME_PROVIDER_ENV_KEYS.deepseek,
};

export const BUILTIN_RUNTIME_PROVIDER_BLOCKED_HOST_ENV_KEYS = Array.from(new Set(
  Object.values(PI_BUILTIN_PROVIDER_BLOCKED_HOST_ENV_KEYS_GENERATED).flat(),
)) as readonly string[];

export const BUILTIN_RUNTIME_GATEWAY_PROVIDERS = [
  { id: "openai-compatible", envKey: "OPENAI_API_KEY", baseUrlEnvKey: "OPENAI_BASE_URL" },
  { id: "anthropic-compatible", envKey: "ANTHROPIC_API_KEY", baseUrlEnvKey: "ANTHROPIC_BASE_URL" },
] as const;

export type BuiltInRuntimeGatewayProviderId = typeof BUILTIN_RUNTIME_GATEWAY_PROVIDERS[number]["id"];
export type BuiltInRuntimeAnyProviderId = BuiltInRuntimeProviderId | BuiltInRuntimeGatewayProviderId;

export const BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS: Record<BuiltInRuntimeGatewayProviderId, string> =
  Object.fromEntries(BUILTIN_RUNTIME_GATEWAY_PROVIDERS.map((provider) => [provider.id, provider.envKey])) as Record<BuiltInRuntimeGatewayProviderId, string>;

export const BUILTIN_RUNTIME_GATEWAY_PROVIDER_BASE_URL_ENV_KEYS: Record<BuiltInRuntimeGatewayProviderId, string> =
  Object.fromEntries(BUILTIN_RUNTIME_GATEWAY_PROVIDERS.map((provider) => [provider.id, provider.baseUrlEnvKey])) as Record<BuiltInRuntimeGatewayProviderId, string>;

export const BUILTIN_RUNTIME_CONTROLLED_ENV_KEYS = Array.from(new Set([
  ...Object.values(BUILTIN_RUNTIME_PROVIDER_ENV_KEYS),
  ...Object.values(BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS),
  ...Object.values(BUILTIN_RUNTIME_GATEWAY_PROVIDER_BASE_URL_ENV_KEYS),
])) as readonly string[];

export const BUILTIN_RUNTIME_HOST_PROVIDER_ENV_SCRUB_KEYS = Array.from(new Set([
  ...BUILTIN_RUNTIME_CONTROLLED_ENV_KEYS,
  ...BUILTIN_RUNTIME_PROVIDER_BLOCKED_HOST_ENV_KEYS,
])) as readonly string[];

/**
 * Per-provider model list shown when the user picks a Pi builtin provider in
 * the create-agent UI. Sourced from `piBuiltinModels.generated.ts` which is
 * auto-generated from `@earendil-works/pi-ai`'s `getModels(provider)` (run
 * `pnpm --filter @botiverse/raft-daemon generate:pi-builtin-models`).
 *
 * Model `id` is the full Pi-style `<provider>/<model>` string so it composes
 * with the existing model-label rendering in detectPiModelsFromRegistry.
 * Entries are sorted by the generator's newer/stronger-first heuristic; the
 * provider default is emitted separately in `PI_BUILTIN_PROVIDER_DEFAULT_MODELS`
 * so display order does not become default authority.
 *
 * The generator is locked in as the source of truth: a CI gate
 * (`pnpm --filter @botiverse/raft-daemon check:pi-builtin-models-fresh`)
 * regenerates and fails on any diff, so we can't drift from the SDK.
 */
export const PI_BUILTIN_PROVIDER_MODELS = PI_BUILTIN_PROVIDER_MODELS_GENERATED;
export const PI_BUILTIN_PROVIDER_DEFAULT_MODELS = PI_BUILTIN_PROVIDER_DEFAULT_MODELS_GENERATED;
export const PI_BUILTIN_PROVIDER_CONNECTION_PROBES = PI_BUILTIN_PROVIDER_CONNECTION_PROBES_GENERATED;

export type RuntimeModelConfig =
  | { kind: "preset"; id: string }
  | { kind: "custom"; name: string };

export type RuntimeModeConfig =
  | { kind: "default" }
  | { kind: "fast" };

interface RuntimeConfigBase { // Persisted source fields; launch/env mirrors are derived, not parsed back.
  version: typeof RUNTIME_CONFIG_VERSION;
  model: RuntimeModelConfig;
  mode: RuntimeModeConfig;
  reasoningEffort?: RuntimeReasoningEffort | null;
  envVars?: Record<string, string> | null;
}

export type ClaudeRuntimeConfig = RuntimeConfigBase & {
  runtime: "claude";
  provider?: ClaudeRuntimeProviderConfig;
  command?: string | null;
};

export type PiRuntimeConfig = RuntimeConfigBase & {
  runtime: "pi";
  provider?: PiRuntimeProviderConfig;
  command?: never;
};

export type BuiltInRuntimeConfig = RuntimeConfigBase & {
  runtime: "builtin";
  provider: BuiltInRuntimeProviderConfig;
  hostUserState: "forbidden";
  /** Opt in to extensions installed in the host Pi agent directory. */
  loadLocalPlugins?: boolean;
  command?: never;
};

export type ProviderlessRuntimeId = Exclude<RuntimeId, "builtin" | "claude" | "pi">; // Providerless in v1.

export type ProviderlessRuntimeConfig = RuntimeConfigBase & {
  runtime: ProviderlessRuntimeId;
  provider?: never; // Reject accidental provider payloads instead of silently ignoring them.
  command?: never;
};

export type RuntimeConfig = // Persisted source of truth; validate before deriving LaunchPlan/env.
  | BuiltInRuntimeConfig
  | ClaudeRuntimeConfig
  | PiRuntimeConfig
  | ProviderlessRuntimeConfig;

export interface AgentConfig {
  name: string;
  displayName: string | null;
  description: string | null;
  model: string;
  runtime: string;
  runtimeConfig?: RuntimeConfig | null;
  /** Ephemeral, credential-free metadata for a server-managed provider launch. */
  providerConnection?: ProviderConnectionLaunchProjection | null;
  reasoningEffort: RuntimeReasoningEffort | null;
  executionMode?: "byoc" | "cloud" | string | null;
  envVars: Record<string, string> | null;
  sessionId: string | null;
  serverUrl: string;
  authToken: string;
  /**
   * Optional per-agent `sk_agent_*` credential — the bearer for the
   * `/internal/agent-api/*` surface where the acting agent is read from the
   * credential row, not a `:id` path param.
   *
   * Authority is the shared credential RFC (post-split — see
   * `#wg-raft-computer:0de1186e` discussion; pre-split equivalent is the
   * §3 credential isolation + §5 auth axis sections of the Computer RFC
   * v8.3.x). This docstring intentionally avoids naming a specific RFC
   * filename so the runner credential code does not need to follow doc
   * renames; cross-refs land in the contract index (task #9 follow-up).
   *
   * Server session worker runner credential contract:
   *   - The daemon stores this value in process memory and exposes a local
   *     proxy affordance to the `slock` wrapper (see `prepareCliTransport`).
   *   - The raw key, or any file pointer to it, MUST NOT be present in the
   *     spawned runtime env, workspace files, or CLI args. The
   *     local `slock` wrapper points short-lived CLI subprocesses at a
   *     launch-scoped local proxy; same-uid shells are contained by proxy
   *     capability enforcement and launch cleanup, not by file permissions.
   *   - When this key is present, the runner env MUST NOT also receive the
   *     legacy machine-token file path. Legacy token fallback is only for
   *     failed runner credential mint.
   *   - The daemon host process itself MUST NOT outbound-call
   *     `/internal/agent-api/*` with this credential — only the spawned
   *     runner (via the `slock` CLI wrapper) can use the local proxy. This
   *     isolates the agent-self surface to the runner's process boundary.
   *
   * Null until the Computer (sk_computer_*) mints a managed-runner credential
   * for this agent and threads it through `agent:start`.
   */
  agentCredentialKey?: string | null;
  /**
   * Server-side credential row id for a managed-runner credential minted for
   * this launch. Present only for daemon-managed runner credentials so the
   * server session worker can revoke the row when the launch ends.
   */
  agentCredentialId?: string | null;
  runtimeContext?: AgentRuntimeContext | null;
  /**
   * Spawn-time runtime-profile control. Server attaches this on
   * `agent:start` when the agent has a pending release notice that must be
   * surfaced before any inbox processing. Legacy migration controls may still
   * appear from older deployments, but runtime switches now reset the session
   * automatically; daemons acknowledge those legacy controls as no-ops instead
   * of surfacing them to the runtime — see
   * `agentRuntimeProfileService.getPendingRuntimeProfileControl()`.
   *
   * This is the spawn-time twin of the message-shaped runtime-profile
   * notification (the inbox path). Spawn-time can't deliver via stdin
   * because the agent process doesn't exist yet, so the control rides
   * along as a config field; once alive, the same control class is
   * delivered through the message pipeline (`agent:deliver` carrying
   * a `runtime_profile_*` message_id prefix) and wrapped by
   * `formatRuntimeProfileControlPrompt` instead.
   *
   * - `kind`    — `"daemon_release_notice"` for current deployments. `"migration"`
   *               is retained only as a legacy wire value; current daemons
   *               complete it without prompt/tool involvement.
   * - `key`     — opaque server-issued identifier. The daemon auto-acks on
   *               injection; agents never need to send it.
   * - `message` — fully rendered body the agent reads.
   */
  runtimeProfileControl?: {
    kind: AgentRuntimeProfilePendingKind;
    key: string;
    message: string;
  } | null;
  /**
   * Server-evaluated `constructed_wake_context` feature flag (RFC 070): at-wake
   * session recycling with a constructed briefing, the cold-idle sweep, and the
   * startup MEMORY.md block. Absent or false means off; older servers never
   * send it, so the behavior stays off until a server turns it on. The
   * `RAFT_WAKE_RECYCLE=0` / `RAFT_STARTUP_MEMORY_BLOCK=0` env vars remain local
   * off switches and cannot turn it on.
   */
  constructedWakeContext?: boolean;
  /**
   * Server-evaluated `subagent_delegation_prompt` feature flag. When true, a
   * daemon driver that declares sub-agent support adds the "Working through
   * sub-agents" section to the standing prompt. Absent or false means off;
   * older servers never send it, and drivers without sub-agent support ignore
   * it, so the prompt stays byte-identical to the ungated one.
   */
  subagentDelegation?: boolean;
  /**
   * Server-evaluated `passive_ax` feature flag (RFC 072 §7, the passive AX
   * "peripheral vision": command-guidance holds and context-scoped thread
   * evidence). Absent or false means off; older servers never send it. The
   * daemon composes it with the local `RAFT_PASSIVE_AX=0` kill switch (which
   * cannot turn it on) and publishes the result in the context-generation
   * record the CLI reads; on the daemon's effective spawn config this field
   * already holds that composed value.
   */
  passiveAx?: boolean;
  /**
   * Installed-app discovery catalog (task #319). The daemon renders these
   * entries into the agent's system prompt so the agent knows which apps
   * exist on this server and when to reach for them — before it has logged
   * in to any of them.
   *
   * Contract:
   *   - Server-scoped, not agent-scoped: `services` is identical for every
   *     agent on a server, so it rides `agent:start` config rather than
   *     being fetched per-agent (the host is forbidden from outbound-calling
   *     `/internal/agent-api/*` with `agentCredentialKey`).
   *   - Only enabled, user-managed apps are included, and only those with a
   *     non-empty `whenToUse` — an app with no hint contributes nothing to
   *     the prompt.
   *   - All three strings are already inert-rendered server-side; the
   *     daemon MUST NOT unescape or re-render reference tokens.
   *   - Snapshot semantics: the catalog reflects the moment of agent:start;
   *     apps installed/disabled mid-session appear on the NEXT launch. An
   *     agent needing a fresher view can run `raft integration list`.
   *   - Optional and absent on old servers; an absent or empty catalog
   *     degrades to the historical prompt (no apps section).
   */
  installedApps?: AgentInstalledAppCatalogEntry[] | null;
}

/** One entry of {@link AgentConfig.installedApps} — the prompt-facing
 * app directory. `whenToUse` is always non-empty here (server filters). */
export interface AgentInstalledAppCatalogEntry {
  name: string;
  description: string | null;
  whenToUse: string;
}

export type ProfileVisibilityMembershipStatus = "active" | "left" | "removed";

export interface ProfileCreatedAgentSummary {
  id: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  runtime: string;
  external?: boolean;
  status: AgentStatus;
}

export type ProfileCreatorSummary =
  | {
      type: "human";
      id: string;
      name: string;
      displayName: string | null;
      avatarUrl: string | null;
      gravatarHash: string;
    }
  | {
      type: "agent";
      id: string;
      name: string;
      displayName: string | null;
      avatarUrl: string | null;
      deletedAt: string | null;
    };

export interface HumanProfileView {
  kind: "human";
  id: string;
  isSelf: boolean;
  name: string;
  displayName: string | null;
  description: string | null;
  avatarUrl: string | null;
  email: string | null;
  role: "owner" | "admin" | "member" | "guest" | null;
  joinedAt: string | null;
  membershipStatus: ProfileVisibilityMembershipStatus;
  createdAgents: ProfileCreatedAgentSummary[];
}

export interface AgentProfileView {
  kind: "agent";
  id: string;
  isSelf: boolean;
  name: string;
  displayName: string | null;
  description: string | null;
  avatarUrl: string | null;
  status: AgentStatus;
  serverRole: "owner" | "admin" | "member" | null;
  runtime: string;
  external?: boolean;
  model: string;
  runtimeConfig?: RuntimeConfig | null;
  lastRuntimeError?: AgentRuntimeErrorState | null;
  reasoningEffort: ReasoningEffort | null;
  executionMode: "byoc" | "cloud" | string | null;
  computerId: string | null;
  computerName: string | null;
  computerHostname: string | null;
  daemonVersion: string | null;
  creator: ProfileCreatorSummary | null;
  createdAgents: ProfileCreatedAgentSummary[];
  createdAt: string;
  deletedAt: string | null;
}

export type ProfileView = HumanProfileView | AgentProfileView;

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
  isHidden?: boolean;
  children?: FileNode[];
}

/** Summary info for a single agent workspace directory on a machine */
export interface WorkspaceDirectoryInfo {
  /** Directory name (= agentId UUID) */
  directoryName: string;
  /** Total size in bytes of all files */
  totalSizeBytes: number;
  /** Most recent modification time */
  lastModified: string;
  /** Number of top-level files */
  fileCount: number;
}

/** A Claude Code skill (slash command) from SKILL.md */
export interface SkillInfo {
  /** Skill directory name */
  name: string;
  /** Display name from SKILL.md frontmatter */
  displayName: string;
  /** Description from SKILL.md frontmatter */
  description: string;
  /** Whether the skill is user-invocable */
  userInvocable: boolean;
  /** Source directory path where this skill was found */
  sourcePath?: string;
}

// Agent activity states. Single source of truth: the literal tuple derives the
// type, the runtime guard, and the legacy VALID_ACTIVITIES set, so they can
// never drift apart.
export const AGENT_ACTIVITIES = ["online", "thinking", "working", "error", "offline"] as const;
export type AgentActivity = (typeof AGENT_ACTIVITIES)[number];
export type AgentActivityKind = AgentActivity;
export const isAgentActivity = makeIsMember(AGENT_ACTIVITIES);
export const isAgentActivityKind = isAgentActivity;

export const AGENT_ACTIVITY_DETAIL_KINDS = [
  "none",
  "message_received",
  "freshness_hold",
  "starting",
  "runtime_starting",
  "idle",
  "running_command",
  "checking_messages",
  "compacting_context",
  "compaction_finished",
  "compaction_stale",
  "reviewing_changes",
  "review_finished",
  "review_stale",
  "runtime_reconnecting",
  "runtime_error",
  "runtime_crashed",
  "runtime_unavailable",
  "runtime_stalled",
  /**
   * task #1116 — the daemon wrote stdin deliveries to a live process and no
   * model-driven runtime event followed for a whole episode (see
   * DeliveryConsumptionActivityDiagnostic). Observation only.
   */
  "delivery_unconsumed",
  /**
   * task #1119 — the server paused automatic wakes for this agent after
   * consecutive early exits (see WakeCrashLoopActivityDiagnostic). Only a
   * human start lifts it.
   */
  "wake_crash_loop_blocked",
  /**
   * RFC 071 §9 — the server's terminal-failure breaker stopped automatic
   * wakes for this agent: paused until a time after repeated terminal runtime
   * failures, or a manual start is needed. The server-authored detail says
   * which. A manual start lifts it.
   */
  "terminal_failure_paused",
  "stalled_recovery",
  "stopped",
  "ready",
  "runtime_interrupted",
  "machine_disconnected",
  "computer_started",
  "computer_restarted",
  "computer_upgraded",
  "computer_operation_failed",
  "daemon_activity",
  "external_activity",
  "synthetic_repair",
  "slock_action",
  "system_message",
  // Generic structured runtime-progress heartbeat (Claude --include-partial-messages
  // stream events / system status) — a "working" liveness signal with no rendered
  // content. NOT a subagent. (APM 1.6 6a)
  "runtime_progress",
  // Passive provider HTTP observation; not model progress or lifecycle authority.
  "provider_request_status",
  // Strong daemon execution-boundary events. These are intentionally distinct
  // from heartbeat/display rows so the server reducer can derive live activity
  // and elapsed/error transitions without parsing text or trajectory entries.
  "model_request_started",
  "model_response_started",
  "tool_started",
  "tool_end",
  "thinking_started",
  "thinking_end",
  // A subagent (Claude `Agent` tool) lifecycle/activity row, marked from explicit
  // parent_tool_use_id / task-lifecycle lineage — never inferred from display text.
  // (APM 1.6 6b)
  "subagent_activity",
  "other",
] as const;
export type AgentActivityDetailKind = (typeof AGENT_ACTIVITY_DETAIL_KINDS)[number];
export const isAgentActivityDetailKind = makeIsMember(AGENT_ACTIVITY_DETAIL_KINDS);
export type AgentStatus = "active" | "inactive" | "stopped";
export interface AgentRuntimeErrorState {
  message: string;
  at: string;
  launchId?: string | null;
  actionRequired: boolean;
  /** #688(c): typed diagnostic tuple durable with the crash state. Absent for
   * untyped/legacy error authority (stays null), present only when a valid typed
   * RuntimeErrorActivityDiagnostic carrier established the authority. */
  errorClass?: RuntimeErrorClass;
  errorReason?: RuntimeErrorReason;
  fingerprint?: string;
  reasonProvenance?: RuntimeErrorReasonProvenance;
}

export const VALID_ACTIVITIES = new Set<AgentActivityKind>(AGENT_ACTIVITIES);

// Runtime catalog (RuntimeInfo, RUNTIMES, display names, external runtime): its own
// dependency-light module so SDK bundles can render runtime labels without this index.
export * from "./runtimeCatalog";

// ── Agent Trajectory ──

export const EXTERNAL_AGENT_ACTIVITY_EVENT_SCHEMA = "raft-activity.v1" as const;
export const EXTERNAL_AGENT_ACTIVITY_DRAIN_SCHEMA = "raft-activity-drain.v1" as const;
export const EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA = "raft-agent-activity-ingest.v1" as const;
export const EXTERNAL_AGENT_ACTIVITY_PROVENANCE = "external/plugin-reported" as const;
export const EXTERNAL_AGENT_ACTIVITY_TEXT_LIMIT = 4096;
export const EXTERNAL_AGENT_ACTIVITY_TOOL_NAME_LIMIT = 120;

export * from "./agentStatusStandard";

export type ExternalAgentActivityHookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PostToolBatch"
  | "UserPromptSubmit"
  | "Stop"
  | "SessionStart"
  | "SessionEnd"
  | (string & {});

export interface ExternalAgentActivityEvent {
  schema?: typeof EXTERNAL_AGENT_ACTIVITY_EVENT_SCHEMA | string;
  eventId?: string;
  event_id?: string;
  sessionId?: string;
  session_id?: string;
  hookEventName?: ExternalAgentActivityHookEventName;
  hook_event_name?: ExternalAgentActivityHookEventName;
  toolName?: string;
  tool_name?: string;
  /**
   * raft-agent-status.v1 agent status after this event (`online` idle/ready,
   * `thinking`, `working`, `error`, `offline`). Legacy hook-outcome values
   * (`started`/`succeeded`/`failed`/`completed`) are accepted and ignored for
   * status. An event may carry `status` without `hookEventName`.
   */
  status?: RaftAgentStatus | (typeof EXTERNAL_AGENT_ACTIVITY_LEGACY_STATUS_VALUES)[number];
  /** Optional one-line human detail for `status` (at most 200 characters). */
  detail?: string;
  occurredAt?: string;
  occurred_at?: string;
  durationMs?: number;
  duration_ms?: number;
  errorClass?: string;
  error_class?: string;
  toolInput?: unknown;
  tool_input?: unknown;
  toolOutput?: unknown;
  tool_output?: unknown;
  toolInputTruncated?: boolean;
  tool_input_truncated?: boolean;
  toolOutputTruncated?: boolean;
  tool_output_truncated?: boolean;
  truncated?: boolean;
}

export interface ExternalAgentActivityDrainResponse {
  schema: typeof EXTERNAL_AGENT_ACTIVITY_DRAIN_SCHEMA;
  events: ExternalAgentActivityEvent[];
  dropped?: number;
}

export interface ExternalAgentActivityIngestRequest {
  schema: typeof EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA;
  coreSessionId?: string;
  adapterInstance?: string;
  events: ExternalAgentActivityEvent[];
  dropped?: number;
}

export interface TrajectoryProducerLineage {
  /**
   * Optional producer-fact lineage for entries derived from an APM or lifecycle
   * decision. Consumers must treat this as a join key only, not user content.
   */
  producerFactId?: string;
}

/**
 * Structured subagent lineage carried by trajectory entries that belong to a
 * Claude subagent (the `Agent` tool). Presence of this marker is the ONLY signal
 * that an entry is subagent-scoped — subagent-ness must never be inferred from
 * display text (APM 1.6 6b). Every field is a closed id / bounded token, never
 * raw prompt or raw output (Q8/provenance discipline). Consumers group
 * lineage-bearing rows under a subagent; rows without this marker stay flat and
 * must never render an empty subagent card.
 */
export interface SubagentLineage {
  subagent?: {
    /** Outer `Agent` tool_use id that owns this subagent turn. */
    parentToolUseId?: string;
    /** Declared subagent role (e.g. "Explore"), a bounded label, never content. */
    subagentType?: string;
    /** Claude `system` task-lifecycle envelope id (task_started/task_progress/…). */
    taskId?: string;
    /** Bounded lifecycle phase of the subagent, from the `system` envelope kind. */
    phase?: "started" | "progress" | "notification" | "active";
  };
}

/** Bounded runtime facts; never provider text, summaries, or prompt contents. */
export interface RuntimeCompactionInterruption {
  outcome: "compaction_failed_or_exhausted" | "aborted" | "unknown";
  reason: "manual" | "threshold" | "overflow" | "unknown";
  failureReason?: "recovery_exhausted" | "input_too_large" | "compaction_failed" | "unknown";
  willRetry: boolean | "unknown";
  /** Safe diagnostic projected from this exact compaction_end event. */
  failureDiagnostic?: RuntimeErrorActivityDiagnostic;
}

/** A single entry in the agent's trajectory log — rich activity data from stream-json */
export type TrajectoryEntry =
  | ({ kind: "thinking"; text: string } & TrajectoryProducerLineage & SubagentLineage)
  | ({ kind: "tool_start"; toolName: string; toolInput: string } & TrajectoryProducerLineage & SubagentLineage)
  | ({ kind: "text"; text: string } & TrajectoryProducerLineage & SubagentLineage)
  // Durable history of an agent-visible action performed through Slock itself
  // (send / claim / reminder / profile update, etc.). This is not a live-status
  // subtitle, and it must not carry agent-facing recovery instructions.
  | ({ kind: "slock_action"; title: string; text: string } & TrajectoryProducerLineage)
  | ({ kind: "system"; title: string; text: string } & TrajectoryProducerLineage)
  | ({ kind: "compaction_started" } & TrajectoryProducerLineage)
  | ({ kind: "compaction_finished" } & TrajectoryProducerLineage)
  | ({ kind: "status"; activity: AgentActivityKind; activityKind?: AgentActivityKind; detail: string; detailKind?: AgentActivityDetailKind; compaction?: RuntimeCompactionInterruption } & TrajectoryProducerLineage & SubagentLineage);

/**
 * Daemon-to-server trajectory payload. Daemons emit the full trajectory union
 * defined below (not status-only); the optional `activity`/`activityKind` fields
 * on `status` exist solely for the one-version legacy ingest window and are
 * rewritten by the server before persistence or broadcast.
 */
export type DaemonTrajectoryEntry =
  | Exclude<TrajectoryEntry, { kind: "status" }>
  | ({
      kind: "status";
      activity?: AgentActivityKind;
      activityKind?: AgentActivityKind;
      detail: string;
      detailKind?: AgentActivityDetailKind;
      compaction?: RuntimeCompactionInterruption;
    } & TrajectoryProducerLineage & SubagentLineage);

/** Normalize backend activity string to a valid frontend AgentActivity.
 *  Maps unknown values to sensible defaults. */
export function normalizeActivity(raw: string | undefined, dbStatus?: string): AgentActivityKind {
  if (isAgentActivity(raw)) return raw;
  // Fallback from DB status
  if (dbStatus === "active") return "working";
  return "offline";
}

export function normalizeActivityDetailKind(raw: string | undefined): AgentActivityDetailKind {
  return isAgentActivityDetailKind(raw) ? raw : "other";
}

// ── Runtimes ──


/**
 * External-agent presence: an external agent is online when its credential was
 * seen (any authenticated agent-API call, or an open wake-hint stream's
 * heartbeat) within this window; otherwise the UI shows "last active".
 */
export const EXTERNAL_AGENT_ONLINE_WINDOW_MS = 120_000;

/**
 * Server → web socket event (`agent:seen`), pushed to the agent's server room
 * when an external agent's credential-use timestamp is persisted.
 */
export interface AgentSeenEvent {
  agentId: string;
  /** ISO timestamp — same value `GET /agents` serves as `lastSeenAt`. */
  lastSeenAt: string;
}


export type RuntimeCapabilityStatus = "available" | "not_installed" | "update_required";
export type RuntimeAdmissionStatus = "available_for_new" | "grandfathered_current";
export type RuntimeAdmissionReason = "feature_flag_off" | "deprecated" | null;

/**
 * A context-specific server projection for choosing a runtime.
 *
 * Capability and admission intentionally stay orthogonal: a daemon may report
 * a runtime that rollout policy does not admit for new use, while an existing
 * agent may retain a grandfathered runtime only while its machine still
 * reports that capability.
 */
export interface RuntimeSelectionOption {
  runtimeId: string;
  capabilityStatus: RuntimeCapabilityStatus;
  admissionStatus: RuntimeAdmissionStatus;
  admissionReason: RuntimeAdmissionReason;
  current: boolean;
  availableForNew: boolean;
  manageableForCurrentAgent: boolean;
  canSelectInThisContext: boolean;
  /**
   * Presence opts this row into the versioned Create Agent form protocol.
   * Omission is the migration-safe legacy contract; clients must not infer a
   * form renderer from runtimeId.
   */
  formDefinitionRef?: RuntimeFormDefinitionRef;
  /**
   * Presence means the server serves this runtime's form on protocol v2
   * (GET .../runtime-forms/v2/:runtimeId; packages/runtime-form README,
   * "Protocol v2"). Independent of `formDefinitionRef`: a runtime may have a v2
   * form without any v1 definition, and v1 clients never see it. Additive;
   * clients that do not know it ignore it.
   */
  runtimeFormV2?: RuntimeFormV2Marker;
}

export interface RuntimeFormV2Marker {
  protocolVersion: 2;
}

export interface RuntimeFormDefinitionRef {
  protocolVersion: 1;
  runtimeId: string;
  schemaVersion: string;
}

export const KIMI_SDK_FORM_SCHEMA_VERSION = "kimi-sdk.create.v1";
export const KIMI_SDK_FORM_DEFINITION_REF = {
  protocolVersion: 1,
  runtimeId: "kimi-sdk",
  schemaVersion: KIMI_SDK_FORM_SCHEMA_VERSION,
} as const satisfies RuntimeFormDefinitionRef;

export type AgentCreateStringFieldSchema = {
  type: "string";
  title: string;
  minLength?: number;
  format?: "uri";
  writeOnly?: boolean;
};

export type AgentCreateStringMapFieldSchema = {
  type: "object";
  title: string;
  additionalProperties: { type: "string" };
};

export type AgentCreateBooleanFieldSchema = {
  type: "boolean";
  title: string;
};

/** The deliberately small JSON Schema subset supported by the Web renderer. */
export interface AgentCreateDataSchema {
  type: "object";
  additionalProperties: false;
  required: string[];
  properties: Record<string, AgentCreateStringFieldSchema | AgentCreateStringMapFieldSchema | AgentCreateBooleanFieldSchema>;
}

export interface AgentCreateUiSchema {
  order: string[];
  layout: { advanced: string[] };
  visibility: Array<{
    pointer: string;
    when: { pointer: string; in: string[] };
  }>;
  localization: Record<string, {
    label: string;
    hint?: string;
    placeholder?: string;
  }>;
}

export interface AgentCreateFormOption {
  value: string;
  label: string;
  providerKind?: "preset" | "gateway";
  /** Live, per-model runtime capabilities. Omitted means no effort picker. */
  supportedReasoningEfforts?: string[];
  /** Must be one of supportedReasoningEfforts when present. */
  defaultReasoningEffort?: string;
}

interface AgentCreateFormOptionSourceBase {
  protocolVersion: 1;
  runtimeId: string;
  schemaVersion: string;
  sourceId: string;
  pointer: string;
}

/** A definition carries only bounded, version-bound source references. */
export type AgentCreateFormOptionSourceRef =
  | (AgentCreateFormOptionSourceBase & {
      kind: "select";
    })
  | (AgentCreateFormOptionSourceBase & {
      kind: "dependent_select";
      dependsOn: string;
    });

/** Values are fetched separately from the permission-aware source endpoint. */
export type AgentCreateFormOptionSource =
  | (AgentCreateFormOptionSourceBase & {
      kind: "select";
      options: AgentCreateFormOption[];
      defaultValue: string;
    })
  | (AgentCreateFormOptionSourceBase & {
      kind: "dependent_select";
      dependsOn: string;
      optionsByValue: Record<string, AgentCreateFormOption[]>;
      defaultValueByValue: Record<string, string>;
      customValueAllowedByValue: Record<string, boolean>;
    });

export interface AgentCreateFormDefinition {
  protocolVersion: 1;
  runtimeId: string;
  schemaVersion: string;
  dataSchema: AgentCreateDataSchema;
  uiSchema: AgentCreateUiSchema;
  capabilities: {
    providerKinds: Array<"preset" | "gateway">;
    writeOnlyPointers: string[];
    forbiddenPointers: string[];
  };
  optionSources: Record<string, AgentCreateFormOptionSourceRef>;
}

/** Web-internal materialized form after all exact source refs resolve. */
export type ResolvedAgentCreateFormDefinition = Omit<AgentCreateFormDefinition, "optionSources"> & {
  optionSources: Record<string, AgentCreateFormOptionSource>;
};

export interface AgentCreateFormIssue {
  code: string;
  pointer: string;
}

export interface RuntimeSelectionCatalog {
  context: "new_agent" | "existing_agent" | "setup";
  machineId: string | null;
  options: RuntimeSelectionOption[];
}


export {
  __resetFailpointsForTests,
  __setFailpointsForTests,
  failpoints,
  InMemoryFailpointRegistry,
  noopFailpointRegistry,
} from "./testing/failpoints";
export type {
  FailpointEffect,
  FailpointMode,
  FailpointRegistry,
  FailpointSpec,
  FailpointTraceEntry,
  InMemoryFailpointRegistryOptions,
  MaybePromise,
} from "./testing/failpoints";

// ── Runtime Models ──

export interface RuntimeModelInfo {
  /** Model ID passed to CLI (e.g. "sonnet", "gpt-5.3-codex") */
  id: string;
  /** Human-readable label (e.g. "Sonnet", "GPT-5.3 Codex") */
  label: string;
  /** Runtime-reported reasoning effort IDs accepted by this model, when known. */
  supportedReasoningEfforts?: string[];
  /** Runtime-reported default reasoning effort for this model, when known. */
  defaultReasoningEffort?: string;
  /** Runtime-reported service tier IDs accepted by this model, when known. */
  serviceTiers?: string[];
  /** Runtime-reported default service tier for this model, when known. */
  defaultServiceTier?: string;
  /**
   * Whether this model is expected to launch with the current runtime config.
   * Official CLI model catalogs can be marked launchable when launch is a
   * direct model-id argument; suggestion_only is for entries that may need
   * user provider config the machine has not verified.
   */
  verified?: "launchable" | "suggestion_only";
}

/**
 * A runtime's model catalog as reported by a specific machine, or declared by
 * a runtime whose source is an explicit closed static catalog. The `default`
 * field, when present, is the source's configured-default model.
 */
export interface RuntimeModelSet {
  models: RuntimeModelInfo[];
  default?: string;
  /**
   * Additive proof that a live model list came from the target runtime's own
   * versioned catalog. Absent on legacy daemons; callers that require the
   * Built-in preset compatibility guarantee must fail closed when it is absent.
   */
  catalog?: RuntimeModelCatalogCapability;
}

export interface RuntimeModelCatalogCapability {
  protocolVersion: 1;
  runtime: "builtin";
  runtimeVersion: string;
}

/**
 * Terminal model-source truth reported by a Computer.
 *
 * Bundled fallback options remain presentation metadata, never live availability.
 */
export type RuntimeModelSourceOutcome =
  | { kind: "live"; value: RuntimeModelSet }
  | { kind: "missing_config"; recovery?: string }
  | { kind: "no_models"; recovery?: string }
  | { kind: "unsupported" }
  | { kind: "error"; retryable: boolean; code?: RuntimeModelDetectionErrorCode };

export const RUNTIME_MODEL_DETECTION_ERROR_CODES = [
  "runtime_not_found",
  "runtime_not_authenticated",
  "detect_timeout",
  "protocol_unsupported",
  "detect_failed",
  "computer_offline",
] as const;
export type RuntimeModelDetectionErrorCode = (typeof RUNTIME_MODEL_DETECTION_ERROR_CODES)[number];

// Grok 1.x can take over five seconds to initialize its model catalog.
export const GROK_MODEL_DETECTION_TIMEOUT_MS = 15_000;
// `cursor-agent models` asks Cursor's backend for the account's catalog and can
// exceed five seconds. With the daemon probe and the server request both at 5s
// the server gave up first, so the live list never arrived.
export const CURSOR_MODEL_DETECTION_TIMEOUT_MS = 15_000;
// One server-side budget for every runtime (artin 2026-09-27: 统一放宽到 20s).
// It must stay above the longest daemon probe (Grok/Cursor 15s) so the daemon
// can report its own timeout instead of losing the race.
export const MODEL_DETECTION_REQUEST_TIMEOUT_MS = 20_000;
export function runtimeModelDetectionRequestTimeoutMs(_runtime: string): number {
  return MODEL_DETECTION_REQUEST_TIMEOUT_MS;
}

export function isRuntimeModelDetectionErrorCode(value: unknown): value is RuntimeModelDetectionErrorCode {
  return typeof value === "string" && (RUNTIME_MODEL_DETECTION_ERROR_CODES as readonly string[]).includes(value);
}

/** Convert a detector's catalog into the closed source-outcome contract. */
export function runtimeModelSourceOutcomeFromSet(
  value: RuntimeModelSet | null | undefined,
): RuntimeModelSourceOutcome {
  return value?.models.length
    ? { kind: "live", value }
    : { kind: "no_models" };
}

/**
 * Runtimes whose bundled catalog is the runtime's declared closed source, not
 * a fallback for failed machine detection. Keep this list narrow: every other
 * runtime must prove availability from its Computer or report a non-live
 * outcome.
 */
export const STATIC_RUNTIME_MODEL_SOURCE_IDS = [
  "claude",
  "copilot",
  "gemini",
] as const;

/**
 * Verification applied by each declared static source when the daemon stamps
 * its catalog. The server also uses this contract when adapting an old daemon
 * that can only report `error: "unsupported"` for these runtimes.
 */
export const STATIC_RUNTIME_MODEL_SOURCE_VERIFICATION = {
  claude: "launchable",
  copilot: "launchable",
  gemini: "suggestion_only",
} as const satisfies Record<
  (typeof STATIC_RUNTIME_MODEL_SOURCE_IDS)[number],
  NonNullable<RuntimeModelInfo["verified"]>
>;

export function hasStaticRuntimeModelSource(runtimeId: string): boolean {
  return (STATIC_RUNTIME_MODEL_SOURCE_IDS as readonly string[]).includes(runtimeId);
}

export const RUNTIME_MODELS: Record<string, RuntimeModelInfo[]> = {
  [EXTERNAL_AGENT_RUNTIME_ID]: [
    { id: EXTERNAL_AGENT_RUNTIME_MODEL, label: EXTERNAL_AGENT_RUNTIME_DISPLAY_NAME },
  ],
  builtin: Object.values(PI_BUILTIN_PROVIDER_MODELS)
    .flat()
    .map((model) => ({ id: model.id, label: model.label || formatRuntimeProviderModelLabel(model.id), verified: "launchable" as const })),
  claude: [
    { id: "opus", label: "Claude Opus" },
    { id: "fable", label: "Claude Fable" },
    { id: "sonnet", label: "Claude Sonnet" },
    { id: "haiku", label: "Claude Haiku" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    { id: "claude-fable-5", label: "Claude Fable 5" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
  codex: [
    {
      id: "gpt-6-astra",
      label: "GPT-6-Astra",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningEffort: "low",
      verified: "launchable",
    },
    {
      id: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningEffort: "medium",
      verified: "launchable",
    },
    {
      id: "gpt-5.6-terra",
      label: "GPT-5.6 Terra",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningEffort: "medium",
      verified: "launchable",
    },
    {
      id: "gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      verified: "launchable",
    },
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
    { id: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
    { id: "gpt-5.2", label: "GPT-5.2" },
    { id: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" },
    { id: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
    { id: "gpt-5-codex", label: "GPT-5 Codex" },
    { id: "gpt-5", label: "GPT-5" },
  ],
  grok: [
    {
      id: "grok-4.5",
      label: "Grok 4.5",
      supportedReasoningEfforts: ["high", "medium", "low"],
      defaultReasoningEffort: "high",
      verified: "launchable",
    },
    // New choice without changing the bundled default; live detection owns availability.
    { id: "grok-4.6", label: "Grok 4.6", verified: "suggestion_only" },
    {
      id: "grok-composer-2.5-fast",
      label: "Composer 2.5",
      verified: "launchable",
    },
  ],
  antigravity: [
    { id: "default", label: "AGY configured default", verified: "suggestion_only" },
  ],
  copilot: [
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.2", label: "GPT-5.2" },
    { id: "claude-4-sonnet", label: "Claude 4 Sonnet" },
    { id: "claude-4.5-sonnet", label: "Claude 4.5 Sonnet" },
  ],
  cursor: [
    { id: "composer-2-fast", label: "Composer 2 Fast" },
    { id: "composer-2", label: "Composer 2" },
    { id: "auto", label: "Auto" },
  ],
  gemini: [
    { id: "default", label: "Configured Default / Auto", verified: "suggestion_only" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash (Preview)" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  ],
  opencode: [
    { id: "default", label: "Configured Default / Auto", verified: "suggestion_only" },
    { id: "deepseek/deepseek-v4-pro", label: formatRuntimeProviderModelLabel("deepseek/deepseek-v4-pro"), verified: "suggestion_only" },
    { id: "openrouter/anthropic/claude-opus-4.5", label: formatRuntimeProviderModelLabel("openrouter/anthropic/claude-opus-4.5"), verified: "suggestion_only" },
    { id: "fusecode/opus[1m]", label: formatRuntimeProviderModelLabel("fusecode/opus[1m]"), verified: "suggestion_only" },
  ],
  pi: [
    { id: "default", label: "Configured Default / Auto", verified: "suggestion_only" },
  ],
  // Kimi CLI resolves model keys from each user's local config, so the safest
  // built-in option is to defer to whatever default model the CLI already uses.
  kimi: [
    { id: "default", label: "Configured Default" },
  ],
  // kimi-sdk runs the Kimi Code SDK in-process. The daemon's
  // `detectKimiSdkModels()` reads the live model list from the user's
  // `<kimiHome>/config.toml` (populated by `kimi login` from Moonshot's
  // `/models` endpoint) and reports it to the server, so the picker reflects
  // whatever the user has actually provisioned — including new rollouts
  // (e.g. K2.7) without a daemon bump.
  //
  // This static entry is explanatory/default-seeding metadata plus ONE bounded
  // exception: the create-form option source may offer it as the managed
  // default when the machine reports missing_config (the normal first-install
  // shape — nothing provisioned yet). An empty grant (no_models) or a detector
  // error remains a typed non-live source and must never make this entry
  // selectable. Keeping one entry prevents getDefaultModel("kimi-sdk") from
  // falling through to Claude's "sonnet".
  "kimi-sdk": [
    { id: "kimi-code/kimi-for-coding", label: "Kimi for Coding (default)", verified: "launchable" },
  ],
};

/** Return a declared static catalog with daemon-equivalent verification. */
export function getStaticRuntimeModelSourceSet(
  runtimeId: string,
): RuntimeModelSet | undefined {
  if (!hasStaticRuntimeModelSource(runtimeId)) return undefined;

  const runtime = runtimeId as (typeof STATIC_RUNTIME_MODEL_SOURCE_IDS)[number];
  const verified = STATIC_RUNTIME_MODEL_SOURCE_VERIFICATION[runtime];
  return {
    models: (RUNTIME_MODELS[runtime] ?? []).map((model) => ({
      ...model,
      verified: model.verified ?? verified,
    })),
  };
}

/** Get the default model ID for a runtime. */
export function getDefaultModel(runtimeId: string): string {
  const models = RUNTIME_MODELS[runtimeId];
  return models?.[0]?.id ?? "sonnet";
}

/** Get a model's display label. Falls back to the raw model ID. */
export function getModelLabel(runtimeId: string, modelId: string): string {
  const models = RUNTIME_MODELS[runtimeId];
  return models?.find((m) => m.id === modelId)?.label ?? modelId;
}

export interface RuntimeConfigHydrationInput {
  runtime?: string | null;
  model?: string | null;
  runtimeConfig?: unknown;
  reasoningEffort?: RuntimeReasoningEffort | null;
  envVars?: Record<string, string> | null;
}

export interface RuntimeConfigLaunchFields {
  runtime: string;
  model: string;
  mode: RuntimeModeConfig;
  reasoningEffort: RuntimeReasoningEffort | null;
  envVars: Record<string, string> | null;
  command?: string | null;
}

export type LaunchPlan = RuntimeConfigLaunchFields & { // Derived launch view; RuntimeConfig is the persisted source of truth, while LaunchPlan materializes legacy driver fields/env + trace after validation.
  configSource: RuntimeConfigSource;
  trace: RuntimeConfigLaunchTraceAttrs;
};

export type RuntimeConfigParseOutcome = "accepted" | "rejected" | "legacy_sanitized";

export type RuntimeConfigParseReason =
  | "not_object"
  | "unsupported_version"
  | "missing_runtime"
  | "unknown_field"
  | "invalid_model"
  | "invalid_mode"
  | "cross_runtime_provider"
  | "invalid_provider"
  | "invalid_env_vars"
  | "unsupported_command"
  | "invalid_command"
  | "invalid_reasoning_effort"
  | "unsupported_reasoning_effort"
  | "unsupported_fast_mode";

export interface RuntimeConfigParseTraceAttrs {
  outcome: RuntimeConfigParseOutcome;
  runtime?: string;
  provider_kind?: string;
  provider_id?: BuiltInRuntimeAnyProviderId;
  model_id?: string;
  model_kind?: RuntimeModelConfig["kind"];
  base_url_present?: boolean;
  base_url_host_class?: BuiltInRuntimeGatewayBaseUrlHostClass;
  reason?: RuntimeConfigParseReason;
  unknown_fields_dropped_count?: number;
}

export interface RuntimeConfigLaunchTraceAttrs {
  outcome: "materialized";
  runtime: string;
  provider_kind: string;
  provider_id?: BuiltInRuntimeAnyProviderId;
  model_id?: string;
  model_kind?: RuntimeModelConfig["kind"];
  base_url_present?: boolean;
  base_url_host_class?: BuiltInRuntimeGatewayBaseUrlHostClass;
  config_source: RuntimeConfigSource;
  provider_key_present: boolean;
  provider_key_source?: "runtime_config_plaintext";
  env_key_count: number;
}

export type BuiltInRuntimeGatewayBaseUrlHostClass = "localhost" | "private" | "public";

export type RuntimeConfigSource =
  | "agent_config"
  | "host_claude_config"
  | "host_runtime_config"
  | "local_pi_config";

export type RuntimeConfigParseResult =
  | { ok: true; config: RuntimeConfig; trace: RuntimeConfigParseTraceAttrs }
  | { ok: false; error: string; trace: RuntimeConfigParseTraceAttrs };

const CONTROLLED_RUNTIME_ENV_KEYS: Record<string, readonly string[]> = {
  // Built-in owns all provider credential/base-url env keys for its launch
  // plan. Scrub both keys we materialize and host provider keys Pi may read
  // directly, including defensive aliases such as ANTHROPIC_OAUTH_TOKEN.
  builtin: BUILTIN_RUNTIME_HOST_PROVIDER_ENV_SCRUB_KEYS,
  claude: ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_CUSTOM_MODEL_OPTION"],
  // Pi-runtime builtin-provider env vars (e.g. DEEPSEEK_API_KEY). Owned by
  // PiRuntimeProviderConfig.pi-builtin → buildLaunchPlan, not by
  // user-supplied envVars: reading from PI_BUILTIN_PROVIDER_ENV_KEYS keeps
  // this list in sync as new providers are added.
  pi: Object.values(PI_BUILTIN_PROVIDER_ENV_KEYS),
};

const RUNTIME_CONFIG_FIELDS = [
  "version",
  "runtime",
  "provider",
  "model",
  "mode",
  "reasoningEffort",
  "envVars",
  "command",
  "hostUserState",
  "loadLocalPlugins",
] as const;
const MODEL_CONFIG_FIELDS = ["kind", "id", "name"] as const;
const MODE_CONFIG_FIELDS = ["kind"] as const;
const CLAUDE_DEFAULT_PROVIDER_FIELDS = ["kind"] as const;
const CLAUDE_CUSTOM_PROVIDER_FIELDS = ["kind", "apiUrl", "apiKey"] as const;
const PI_DEFAULT_PROVIDER_FIELDS = ["kind"] as const;
const PI_BUILTIN_PROVIDER_FIELDS = ["kind", "providerId", "apiKey"] as const;
const BUILTIN_PRESET_PROVIDER_FIELDS = ["kind", "providerId", "apiKey"] as const;
const BUILTIN_GATEWAY_PROVIDER_FIELDS = ["kind", "providerId", "baseUrl", "apiKey", "supportsImageInput"] as const;
const BUILTIN_CONNECTION_PROVIDER_FIELDS = ["kind", "connectionId"] as const;
const UNKNOWN_PROVIDER_FIELDS = ["kind"] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownFieldCount(record: Record<string, unknown>, knownFields: readonly string[]): number {
  const known = new Set(knownFields);
  return Object.keys(record).filter((key) => !known.has(key)).length;
}

function hasUnknownFields(record: Record<string, unknown>, knownFields: readonly string[]): boolean {
  return unknownFieldCount(record, knownFields) > 0;
}

function providerKnownFieldsFor(runtime: string | undefined, provider: Record<string, unknown>): readonly string[] {
  const kind = typeof provider.kind === "string" ? provider.kind : undefined;
  if (runtime === "builtin") {
    if (kind === "preset" || kind === "managed") return BUILTIN_PRESET_PROVIDER_FIELDS;
    if (kind === "gateway") return BUILTIN_GATEWAY_PROVIDER_FIELDS;
    if (kind === "connection") return BUILTIN_CONNECTION_PROVIDER_FIELDS;
  }
  if (runtime === "claude") {
    if (kind === "default") return CLAUDE_DEFAULT_PROVIDER_FIELDS;
    if (kind === "custom") return CLAUDE_CUSTOM_PROVIDER_FIELDS;
  }
  if (runtime === "pi") {
    if (kind === "default") return PI_DEFAULT_PROVIDER_FIELDS;
    if (kind === "pi-builtin") return PI_BUILTIN_PROVIDER_FIELDS;
  }
  return UNKNOWN_PROVIDER_FIELDS;
}

function providerKind(config: RuntimeConfig): string {
  return config.provider?.kind ?? "none";
}

function providerKeyPresent(config: RuntimeConfig): boolean {
  if (config.runtime === "builtin") {
    // Hydration may omit provider when private runtimeConfig was stripped.
    return Boolean(config.provider && config.provider.kind !== "connection" && config.provider.apiKey.length > 0);
  }
  if (config.runtime === "claude") return config.provider?.kind === "custom" && config.provider.apiKey.length > 0;
  if (config.runtime === "pi") return config.provider?.kind === "pi-builtin" && config.provider.apiKey.length > 0;
  return false;
}

function builtInSelectionTraceAttrs(config: RuntimeConfig): Pick<RuntimeConfigParseTraceAttrs, "provider_id" | "model_id" | "model_kind" | "base_url_present" | "base_url_host_class"> {
  if (config.runtime !== "builtin") return {};
  // Match runtimeConfigLegacy: member projections / agent:created can strip
  // private runtimeConfig, so Built-in may hydrate without provider. Trace
  // attrs must fail soft — never throw on read paths.
  const provider = config.provider;
  return {
    ...(provider && provider.kind !== "connection" ? { provider_id: provider.providerId } : {}),
    model_kind: config.model.kind,
    ...(config.model.kind === "preset" ? { model_id: config.model.id } : {}),
    ...(provider?.kind === "gateway"
      ? {
          base_url_present: true,
          base_url_host_class: classifyBuiltInGatewayBaseUrlHost(provider.baseUrl),
        }
      : {}),
  };
}

export function isBuiltInRuntimeProviderId(value: string): value is BuiltInRuntimeProviderId {
  return Object.prototype.hasOwnProperty.call(BUILTIN_RUNTIME_PROVIDER_ENV_KEYS, value);
}

export function isBuiltInRuntimeGatewayProviderId(value: string): value is BuiltInRuntimeGatewayProviderId {
  return Object.prototype.hasOwnProperty.call(BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS, value);
}

function normalizeEnvVars(envVars: unknown): Record<string, string> | null {
  if (!isPlainRecord(envVars)) return null;
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(envVars)) {
    if (typeof key === "string" && typeof value === "string") {
      normalized[key] = value;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

const RUNTIME_CONFIG_ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseStrictEnvVars(value: unknown): Record<string, string> | null | string {
  if (value === undefined || value === null) return null;
  if (!isPlainRecord(value)) return "runtimeConfig.envVars must be an object";
  const normalized: Record<string, string> = {};
  for (const [key, envValue] of Object.entries(value)) {
    if (typeof envValue !== "string") return "runtimeConfig.envVars keys and values must be strings";
    if (!RUNTIME_CONFIG_ENV_KEY_REGEX.test(key)) {
      return `Invalid runtimeConfig.envVars key "${key}": must match [A-Za-z_][A-Za-z0-9_]*`;
    }
    if (key.includes("\0") || envValue.includes("\0")) {
      return "runtimeConfig.envVars keys and values must not contain null bytes";
    }
    normalized[key] = envValue;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

export function getControlledRuntimeEnvKeys(runtime: string): readonly string[] {
  return CONTROLLED_RUNTIME_ENV_KEYS[runtime] ?? [];
}

export function stripControlledRuntimeEnvVars(
  runtime: string,
  envVars: Record<string, string> | null | undefined,
): Record<string, string> | null {
  const normalized = normalizeEnvVars(envVars);
  if (!normalized) return null;
  const controlled = new Set(getControlledRuntimeEnvKeys(runtime));
  for (const key of controlled) {
    delete normalized[key];
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function isPresetRuntimeModel(runtime: string, model: string): boolean {
  return (RUNTIME_MODELS[runtime] ?? []).some((candidate) => candidate.id === model);
}

function isBuiltInProviderModel(providerId: string, modelId: string): boolean {
  return (PI_BUILTIN_PROVIDER_MODELS[providerId] ?? []).some((candidate) => candidate.id === modelId);
}

function customProviderConfigError(provider: { apiUrl: string; apiKey: string }): string | null {
  if (!provider.apiUrl.trim()) return "runtimeConfig.provider.apiUrl is required";
  if (!provider.apiKey.trim()) return "runtimeConfig.provider.apiKey is required";
  let parsed: URL;
  try {
    parsed = new URL(provider.apiUrl);
  } catch {
    return "runtimeConfig.provider.apiUrl must be a valid URL";
  }
  if (parsed.username || parsed.password) {
    return "runtimeConfig.provider.apiUrl must not contain credentials";
  }
  return null;
}

function builtInGatewayProviderConfigError(provider: { baseUrl: string; apiKey: string }): string | null {
  if (!provider.baseUrl.trim()) return "runtimeConfig.provider.baseUrl is required";
  if (!provider.apiKey.trim()) return "runtimeConfig.provider.apiKey is required";
  let parsed: URL;
  try {
    parsed = new URL(provider.baseUrl);
  } catch {
    return "runtimeConfig.provider.baseUrl must be a valid URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "runtimeConfig.provider.baseUrl must use http:// or https://";
  }
  if (parsed.username || parsed.password) {
    return "runtimeConfig.provider.baseUrl must not contain credentials";
  }
  return null;
}

function classifyBuiltInGatewayBaseUrlHost(baseUrl: string): BuiltInRuntimeGatewayBaseUrlHostClass {
  let hostname = "";
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "public";
  }
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || hostname.startsWith("127.")) return "localhost";
  const ipv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map((part) => Number(part));
    const [a, b] = octets;
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return "private";
  }
  if (
    hostname === "0.0.0.0"
    || hostname === "::"
    || hostname.startsWith("fc")
    || hostname.startsWith("fd")
    || hostname.startsWith("fe80:")
  ) {
    return "private";
  }
  return "public";
}

function isKnownReasoningEffort(value: unknown): value is KnownReasoningEffort {
  return (
    value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    || value === "max"
    || value === "ultra"
  );
}

function runtimeConfigError(reason: RuntimeConfigParseReason, error: string, runtime?: string, providerKindValue?: string): RuntimeConfigParseResult {
  return {
    ok: false,
    error,
    trace: {
      outcome: "rejected",
      ...(runtime ? { runtime } : {}),
      ...(providerKindValue ? { provider_kind: providerKindValue } : {}),
      reason,
    },
  };
}

function parseStrictModelConfig(runtime: string, value: unknown): RuntimeModelConfig | string {
  if (!isPlainRecord(value)) return "runtimeConfig.model must be an object";
  if (hasUnknownFields(value, MODEL_CONFIG_FIELDS)) return "runtimeConfig.model contains unknown fields";
  if (value.kind === "custom") {
    return typeof value.name === "string" && value.name.trim()
      ? { kind: "custom", name: value.name.trim() }
      : "runtimeConfig.model.name is required";
  }
  if (value.kind === "preset") {
    return typeof value.id === "string" && value.id.trim()
      ? { kind: "preset", id: value.id.trim() }
      : "runtimeConfig.model.id is required";
  }
  return "runtimeConfig.model.kind is invalid";
}

function parseStrictModeConfig(value: unknown): RuntimeModeConfig | string {
  if (value === undefined || value === null) return { kind: "default" };
  if (!isPlainRecord(value)) return "runtimeConfig.mode must be an object";
  if (hasUnknownFields(value, MODE_CONFIG_FIELDS)) return "runtimeConfig.mode contains unknown fields";
  if (value.kind === "default" || value.kind === "fast") return { kind: value.kind };
  return "runtimeConfig.mode.kind is invalid";
}

function parseStrictProviderConfig(
  runtime: string,
  value: unknown,
): BuiltInRuntimeProviderConfig | ClaudeRuntimeProviderConfig | PiRuntimeProviderConfig | string | undefined {
  if (value === undefined || value === null) {
    if (runtime === "claude" || runtime === "pi") return { kind: "default" };
    if (runtime === "builtin") return "runtimeConfig.provider is required for runtime: builtin";
    return undefined;
  }
  if (!isPlainRecord(value)) return "runtimeConfig.provider must be an object";
  const rawKind = typeof value.kind === "string" ? value.kind : undefined;
  if (runtime === "builtin") {
    if (rawKind === "connection") {
      if (hasUnknownFields(value, providerKnownFieldsFor(runtime, value))) return "runtimeConfig.provider contains unknown fields";
      if (typeof value.connectionId !== "string" || !value.connectionId.trim()) {
        return "runtimeConfig.provider.connectionId is required";
      }
      return { kind: "connection", connectionId: value.connectionId.trim() };
    }
    if (rawKind === "preset") {
      if (hasUnknownFields(value, providerKnownFieldsFor(runtime, value))) return "runtimeConfig.provider contains unknown fields";
      if (typeof value.providerId !== "string" || !value.providerId.trim()) return "runtimeConfig.provider.providerId is required";
      if (typeof value.apiKey !== "string" || !value.apiKey.trim()) return "runtimeConfig.provider.apiKey is required";
      const providerId = value.providerId.trim();
      if (!isBuiltInRuntimeProviderId(providerId)) {
        return `runtimeConfig.provider.providerId ${providerId} is not a known Built-in provider`;
      }
      return { kind: "preset", providerId, apiKey: value.apiKey.trim() };
    }
    if (rawKind === "gateway") {
      if (hasUnknownFields(value, providerKnownFieldsFor(runtime, value))) return "runtimeConfig.provider contains unknown fields";
      if (typeof value.providerId !== "string" || !value.providerId.trim()) return "runtimeConfig.provider.providerId is required";
      if (typeof value.baseUrl !== "string" || !value.baseUrl.trim()) return "runtimeConfig.provider.baseUrl is required";
      if (typeof value.apiKey !== "string" || !value.apiKey.trim()) return "runtimeConfig.provider.apiKey is required";
      if (value.supportsImageInput !== undefined && typeof value.supportsImageInput !== "boolean") {
        return "runtimeConfig.provider.supportsImageInput must be a boolean";
      }
      const providerId = value.providerId.trim();
      if (!isBuiltInRuntimeGatewayProviderId(providerId)) {
        return `runtimeConfig.provider.providerId ${providerId} is not a known Built-in gateway provider`;
      }
      const provider = {
        kind: "gateway" as const,
        providerId,
        baseUrl: value.baseUrl.trim(),
        apiKey: value.apiKey.trim(),
        ...(value.supportsImageInput === undefined
          ? {}
          : { supportsImageInput: value.supportsImageInput }),
      };
      const error = builtInGatewayProviderConfigError(provider);
      if (error) return error;
      return provider;
    }
    if (rawKind === "default" || rawKind === "custom" || rawKind === "pi-builtin") {
      return "runtimeConfig.provider is not supported for runtime: builtin";
    }
    return "runtimeConfig.provider.kind is invalid";
  }
  if (runtime === "claude") {
    if (rawKind === "default") {
      return hasUnknownFields(value, providerKnownFieldsFor(runtime, value))
        ? "runtimeConfig.provider contains unknown fields"
        : { kind: "default" };
    }
    if (rawKind === "custom") {
      if (hasUnknownFields(value, providerKnownFieldsFor(runtime, value))) return "runtimeConfig.provider contains unknown fields";
      if (typeof value.apiUrl !== "string" || !value.apiUrl.trim()) return "runtimeConfig.provider.apiUrl is required";
      if (typeof value.apiKey !== "string" || !value.apiKey.trim()) return "runtimeConfig.provider.apiKey is required";
      const provider = { kind: "custom" as const, apiUrl: value.apiUrl.trim(), apiKey: value.apiKey.trim() };
      const error = customProviderConfigError(provider);
      if (error) return error;
      return provider;
    }
    if (rawKind === "pi-builtin") return "runtimeConfig.provider is not supported for runtime: claude";
    return "runtimeConfig.provider.kind is invalid";
  }
  if (runtime === "pi") {
    if (rawKind === "default") {
      return hasUnknownFields(value, providerKnownFieldsFor(runtime, value))
        ? "runtimeConfig.provider contains unknown fields"
        : { kind: "default" };
    }
    if (rawKind === "pi-builtin") {
      if (hasUnknownFields(value, providerKnownFieldsFor(runtime, value))) return "runtimeConfig.provider contains unknown fields";
      if (typeof value.providerId !== "string" || !value.providerId.trim()) return "runtimeConfig.provider.providerId is required";
      if (typeof value.apiKey !== "string" || !value.apiKey.trim()) return "runtimeConfig.provider.apiKey is required";
      if (!Object.prototype.hasOwnProperty.call(PI_BUILTIN_PROVIDER_ENV_KEYS, value.providerId.trim())) {
        return `runtimeConfig.provider.providerId ${value.providerId.trim()} is not a known Pi builtin provider`;
      }
      return { kind: "pi-builtin", providerId: value.providerId.trim(), apiKey: value.apiKey.trim() };
    }
    if (rawKind === "custom") return "runtimeConfig.provider is not supported for runtime: pi";
    return "runtimeConfig.provider.kind is invalid";
  }
  return `runtimeConfig.provider is not supported for runtime: ${runtime}`;
}

type ReasoningEffortParseResult =
  | { ok: true; value: RuntimeReasoningEffort | null }
  | { ok: false; error: string };

function parseStrictReasoningEffortConfig(runtime: string, value: unknown): ReasoningEffortParseResult {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!REASONING_EFFORT_RUNTIMES.has(runtime)) {
    return { ok: false, error: `runtimeConfig.reasoningEffort is not supported for runtime: ${runtime}` };
  }
  if (
    typeof value !== "string"
    || !value
    || value.trim() !== value
    || value.includes("\0")
    || (runtime !== "kimi-sdk" && !isKnownReasoningEffort(value))
  ) {
    return { ok: false, error: `Invalid reasoning effort: ${value}` };
  }
  return { ok: true, value };
}

function composeRuntimeConfig(input: {
  runtime: string;
  provider?: BuiltInRuntimeProviderConfig | ClaudeRuntimeProviderConfig | PiRuntimeProviderConfig;
  model: RuntimeModelConfig;
  mode: RuntimeModeConfig;
  reasoningEffort?: RuntimeReasoningEffort | null;
  envVars?: Record<string, string> | null;
  command?: string | null;
  loadLocalPlugins?: boolean;
}): RuntimeConfig {
  const base = {
    version: RUNTIME_CONFIG_VERSION,
    model: input.model,
    mode: input.mode,
    reasoningEffort: input.reasoningEffort ?? null,
    envVars: input.envVars ?? null,
  };
  if (input.runtime === "builtin") {
    return {
      ...base,
      runtime: "builtin",
      provider: input.provider as BuiltInRuntimeProviderConfig,
      hostUserState: "forbidden",
      ...(input.loadLocalPlugins !== undefined ? { loadLocalPlugins: input.loadLocalPlugins } : {}),
    };
  }
  if (input.runtime === "claude") {
    return {
      ...base,
      runtime: "claude",
      provider: input.provider as ClaudeRuntimeProviderConfig | undefined,
      ...(input.command ? { command: input.command } : {}),
    };
  }
  if (input.runtime === "pi") {
    return {
      ...base,
      runtime: "pi",
      provider: input.provider as PiRuntimeProviderConfig | undefined,
    };
  }
  return {
    ...base,
    runtime: input.runtime as ProviderlessRuntimeId,
  };
}

export function hydrateRuntimeConfig(input: RuntimeConfigHydrationInput): RuntimeConfig {
  return hydrateRuntimeConfigWithTrace(input).config;
}

/**
 * Reconstruct a complete current RuntimeConfig for read/launch paths from the
 * persisted structured runtimeConfig plus older agent columns
 * (`runtime`/`model`/`reasoningEffort`/`envVars`). "Hydrate" here means filling
 * the canonical object from storage-era shapes; it is not the strict write
 * validator. Current create/update requests must use parseRuntimeConfig.
 */
export function hydrateRuntimeConfigWithTrace(input: RuntimeConfigHydrationInput): { config: RuntimeConfig; trace: RuntimeConfigParseTraceAttrs } {
  return hydrateLegacyRuntimeConfigWithTrace(input, {
    runtimeConfigVersion: RUNTIME_CONFIG_VERSION,
    runtimeModels: RUNTIME_MODELS,
    runtimeConfigFields: RUNTIME_CONFIG_FIELDS,
    modelConfigFields: MODEL_CONFIG_FIELDS,
    modeConfigFields: MODE_CONFIG_FIELDS,
    getDefaultModel,
    builtinProviderEnvKeys: BUILTIN_RUNTIME_PROVIDER_ENV_KEYS,
    builtinGatewayProviderEnvKeys: BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS,
    piBuiltinProviderEnvKeys: PI_BUILTIN_PROVIDER_ENV_KEYS,
    providerKnownFieldsFor,
    stripControlledRuntimeEnvVars,
    composeRuntimeConfig,
  });
}

export function parseRuntimeConfig(input: RuntimeConfigHydrationInput): RuntimeConfigParseResult {
  const raw = input.runtimeConfig;
  if (raw === undefined || raw === null) {
    const config = hydrateRuntimeConfig(input);
    if (config.runtime === "builtin") {
      return runtimeConfigError("invalid_provider", "runtimeConfig.provider is required for runtime: builtin", config.runtime, providerKind(config));
    }
    const providerError = config.runtime === "claude" && config.provider?.kind === "custom"
      ? customProviderConfigError(config.provider)
      : null;
    if (providerError) return runtimeConfigError(reasonForValidationError(providerError), providerError, config.runtime, providerKind(config));
    const reasoningEffort = parseStrictReasoningEffortConfig(config.runtime, config.reasoningEffort);
    if (!reasoningEffort.ok) {
      return runtimeConfigError(reasonForValidationError(reasoningEffort.error), reasoningEffort.error, config.runtime, providerKind(config));
    }
    return {
      ok: true,
      config,
      trace: { outcome: "accepted", runtime: config.runtime, provider_kind: providerKind(config), ...builtInSelectionTraceAttrs(config) },
    };
  }
  if (!isPlainRecord(raw)) return runtimeConfigError("not_object", "runtimeConfig must be an object");
  if (hasUnknownFields(raw, RUNTIME_CONFIG_FIELDS)) {
    return runtimeConfigError(
      "unknown_field",
      "runtimeConfig contains unknown fields",
      typeof raw.runtime === "string" ? raw.runtime : undefined,
      isPlainRecord(raw.provider) && typeof raw.provider.kind === "string" ? raw.provider.kind : undefined,
    );
  }
  if (raw.version !== RUNTIME_CONFIG_VERSION) {
    return runtimeConfigError("unsupported_version", "runtimeConfig version is unsupported");
  }
  const runtime = typeof raw.runtime === "string" ? raw.runtime.trim() : "";
  if (!runtime) return runtimeConfigError("missing_runtime", "runtimeConfig.runtime is required");
  // Installed mobile clients (kotlinx.serialization with encodeDefaults and
  // explicit nulls) send every optional field, unset ones as `null`. An
  // explicit null means "not set", exactly like an omitted key, so it must not
  // fail validation; any other non-boolean value is still refused, and a null
  // never turns local extensions on.
  const hostUserState = raw.hostUserState === null ? undefined : raw.hostUserState;
  const loadLocalPlugins = raw.loadLocalPlugins === null ? undefined : raw.loadLocalPlugins;
  if (runtime === "builtin" && hostUserState !== undefined && hostUserState !== "forbidden") {
    return runtimeConfigError("unknown_field", "runtimeConfig.hostUserState must be forbidden for runtime: builtin", runtime);
  }

  if (loadLocalPlugins !== undefined && (runtime !== "builtin" || typeof loadLocalPlugins !== "boolean")) {
    return runtimeConfigError("unknown_field", "runtimeConfig.loadLocalPlugins must be a boolean for runtime: builtin", runtime);
  }

  const model = parseStrictModelConfig(runtime, raw.model);
  if (typeof model === "string") return runtimeConfigError("invalid_model", model, runtime);

  const mode = parseStrictModeConfig(raw.mode);
  if (typeof mode === "string") return runtimeConfigError("invalid_mode", mode, runtime);
  if (mode.kind === "fast" && !RUNTIME_FAST_MODE_RUNTIMES.has(runtime)) {
    return runtimeConfigError("unsupported_fast_mode", `runtimeConfig.mode is not supported for runtime: ${runtime}`, runtime);
  }

  const rawProviderKind = isPlainRecord(raw.provider) && typeof raw.provider.kind === "string" ? raw.provider.kind : undefined;
  const provider = parseStrictProviderConfig(runtime, raw.provider);
  if (typeof provider === "string") {
    const reason: RuntimeConfigParseReason = provider.includes("not supported")
      ? "cross_runtime_provider"
      : provider.includes("unknown fields")
        ? "unknown_field"
        : "invalid_provider";
    return runtimeConfigError(reason, provider, runtime, rawProviderKind);
  }
  if (runtime === "builtin" && provider?.kind === "preset") {
    if (model.kind === "custom") {
      const result = runtimeConfigError("invalid_model", "runtimeConfig.model.kind custom is not supported for runtime: builtin", runtime, rawProviderKind);
      return { ...result, trace: { ...result.trace, provider_id: provider.providerId, model_kind: model.kind } };
    }
    if (!isBuiltInProviderModel(provider.providerId, model.id)) {
      const result = runtimeConfigError("invalid_model", `runtimeConfig.model.id is not supported for Built-in provider ${provider.providerId}`, runtime, rawProviderKind);
      return { ...result, trace: { ...result.trace, provider_id: provider.providerId, model_kind: model.kind, model_id: model.id } };
    }
  }
  if (runtime === "builtin" && provider?.kind === "gateway" && model.kind !== "custom") {
    const result = runtimeConfigError("invalid_model", "runtimeConfig.model.kind preset is not supported for Built-in gateway providers", runtime, rawProviderKind);
    return {
      ...result,
      trace: {
        ...result.trace,
        provider_id: provider.providerId,
        model_kind: model.kind,
        ...(model.kind === "preset" ? { model_id: model.id } : {}),
        base_url_present: true,
        base_url_host_class: classifyBuiltInGatewayBaseUrlHost(provider.baseUrl),
      },
    };
  }

  const envVars = parseStrictEnvVars(raw.envVars);
  if (typeof envVars === "string") {
    return runtimeConfigError("invalid_env_vars", envVars, runtime, rawProviderKind);
  }

  let command: string | undefined;
  if (raw.command !== undefined && raw.command !== null) {
    if (runtime !== "claude") {
      return runtimeConfigError("unsupported_command", `runtimeConfig.command is not supported for runtime: ${runtime}`, runtime, rawProviderKind);
    }
    if (typeof raw.command !== "string" || !raw.command.trim()) {
      return runtimeConfigError("invalid_command", "runtimeConfig.command is required", runtime, rawProviderKind);
    }
    command = raw.command.trim();
    if (command.includes("\0")) {
      return runtimeConfigError("invalid_command", "runtimeConfig.command must not contain null bytes", runtime, rawProviderKind);
    }
  }

  const reasoningEffort = parseStrictReasoningEffortConfig(runtime, raw.reasoningEffort ?? input.reasoningEffort ?? null);
  if (!reasoningEffort.ok) {
    return runtimeConfigError(reasonForValidationError(reasoningEffort.error), reasoningEffort.error, runtime, rawProviderKind);
  }
  // Fail-closed per-model gate (task #496): max/ultra are Codex-GPT-5.6-only
  // (declared via `supportedReasoningEfforts`). Drop an effort a KNOWN preset model
  // doesn't allow, so e.g. Claude + ultra normalizes to null instead of persisting
  // / launching an invalid combo. The UI picker already hides it; this guards the
  // API/daemon path (Jianwei's fail-closed point). Custom models pass through —
  // their capability is unknown, so we don't over-restrict them.
  const gatedReasoningEffort = runtime !== "kimi-sdk" && reasoningEffort.value !== null
    && isKnownReasoningEffort(reasoningEffort.value) && model.kind === "preset"
    && !isReasoningEffortAllowedForModel(runtime, model.id, reasoningEffort.value)
    ? null
    : reasoningEffort.value;

  const config = composeRuntimeConfig({
    runtime,
    provider,
    model,
    mode,
    reasoningEffort: gatedReasoningEffort,
    loadLocalPlugins: loadLocalPlugins as boolean | undefined,
    envVars: stripControlledRuntimeEnvVars(runtime, envVars),
    command,
  });
  return {
    ok: true,
    config,
    trace: { outcome: "accepted", runtime: config.runtime, provider_kind: providerKind(config), ...builtInSelectionTraceAttrs(config) },
  };
}

export function runtimeConfigModelValue(config: RuntimeConfig): string {
  return config.model.kind === "custom" ? config.model.name : config.model.id;
}

function reasonForValidationError(error: string): RuntimeConfigParseReason {
  if (error.includes("provider is not supported") || error.includes("provider.kind")) return "cross_runtime_provider";
  if (error.includes("mode is not supported")) return "unsupported_fast_mode";
  if (error.includes("mode.kind")) return "invalid_mode";
  if (error.includes("reasoningEffort is not supported")) return "unsupported_reasoning_effort";
  if (error.includes("Invalid reasoning effort")) return "invalid_reasoning_effort";
  if (error.includes("command is not supported")) return "unsupported_command";
  if (error.includes("command")) return "invalid_command";
  if (error.includes("model")) return "invalid_model";
  return "invalid_provider";
}

export function runtimeConfigSource(config: RuntimeConfig): RuntimeConfigSource {
  if (config.runtime === "builtin") return "agent_config";
  if (config.runtime === "claude") {
    return config.provider?.kind === "custom" ? "agent_config" : "host_claude_config";
  }
  if (config.runtime === "pi") {
    return config.provider?.kind === "pi-builtin" ? "agent_config" : "local_pi_config";
  }
  return config.provider ? "agent_config" : "host_runtime_config";
}

export function buildLaunchPlan(config: RuntimeConfig): LaunchPlan {
  // Compatibility bridge for existing runtime drivers: RuntimeConfig is the
  // persisted source of truth, while drivers still consume flat launch fields
  // plus env vars. Never infer provider/model/mode semantics back from this
  // LaunchPlan; re-parse or hydrate RuntimeConfig instead.
  const normalized = config;
  const generatedEnvVars: Record<string, string> = {};
  if (normalized.runtime === "builtin") {
    if (normalized.provider.kind === "preset") {
      const envKey = BUILTIN_RUNTIME_PROVIDER_ENV_KEYS[normalized.provider.providerId];
      if (envKey) generatedEnvVars[envKey] = normalized.provider.apiKey;
    }
    if (normalized.provider.kind === "gateway") {
      const apiKeyEnvKey = BUILTIN_RUNTIME_GATEWAY_PROVIDER_ENV_KEYS[normalized.provider.providerId];
      const baseUrlEnvKey = BUILTIN_RUNTIME_GATEWAY_PROVIDER_BASE_URL_ENV_KEYS[normalized.provider.providerId];
      if (apiKeyEnvKey) generatedEnvVars[apiKeyEnvKey] = normalized.provider.apiKey;
      if (baseUrlEnvKey) generatedEnvVars[baseUrlEnvKey] = normalized.provider.baseUrl;
    }
    // A managed connection is resolved server-side for an exact launch. The
    // shared projection deliberately emits no credential or provider env.
  }
  if (normalized.runtime === "claude") {
    if (normalized.provider?.kind === "custom") {
      generatedEnvVars.ANTHROPIC_BASE_URL = normalized.provider.apiUrl;
      generatedEnvVars.ANTHROPIC_API_KEY = normalized.provider.apiKey;
    }
    if (normalized.model.kind === "custom") {
      generatedEnvVars.ANTHROPIC_CUSTOM_MODEL_OPTION = normalized.model.name;
    }
  }
  if (normalized.runtime === "pi" && normalized.provider?.kind === "pi-builtin") {
    const envKey = PI_BUILTIN_PROVIDER_ENV_KEYS[normalized.provider.providerId];
    if (envKey) generatedEnvVars[envKey] = normalized.provider.apiKey;
  }
  const envVars = {
    ...(normalized.envVars ?? {}),
    ...generatedEnvVars,
  };
  return { // Compatibility output for launch paths only; persist/re-parse RuntimeConfig for decisions instead of inferring config semantics back from env vars.
    runtime: normalized.runtime,
    model: runtimeConfigModelValue(normalized),
    mode: normalized.mode,
    configSource: runtimeConfigSource(normalized),
    reasoningEffort: normalized.reasoningEffort ?? null,
    envVars: Object.keys(envVars).length > 0 ? envVars : null,
    ...(normalized.command ? { command: normalized.command } : {}),
    trace: {
      outcome: "materialized",
      runtime: normalized.runtime,
      provider_kind: providerKind(normalized),
      ...builtInSelectionTraceAttrs(normalized),
      config_source: runtimeConfigSource(normalized),
      provider_key_present: providerKeyPresent(normalized),
      ...(providerKeyPresent(normalized) ? { provider_key_source: "runtime_config_plaintext" as const } : {}),
      env_key_count: Object.keys(envVars).length,
    },
  };
}

export function runtimeConfigToLaunchFields(config: RuntimeConfig): RuntimeConfigLaunchFields {
  const { trace: _, configSource: _configSource, ...launchFields } = buildLaunchPlan(config);
  return launchFields;
}

// ── Reasoning Effort ──

export type KnownReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
/**
 * Persisted agent-row reasoning values remain the closed, database-backed
 * vocabulary. Runtime-owned vocabularies live inside RuntimeConfig instead.
 */
export type ReasoningEffort = KnownReasoningEffort;
export type RuntimeReasoningEffort = ReasoningEffort | (string & {});

export const REASONING_EFFORTS: { id: KnownReasoningEffort; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
  { id: "ultra", label: "Ultra" },
];

/**
 * The reasoning efforts available to any reasoning-capable model that does NOT
 * declare an explicit `supportedReasoningEfforts` gate. `max`/`ultra` are opt-in
 * only — Codex GPT-5.6 (sol/terra) declares them; they must never leak to models
 * that inherit this base set (e.g. Claude). tygg/stdrc 2026-07-10 task #496.
 */
export const BASE_REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

/**
 * The reasoning efforts a model actually allows: its declared
 * `supportedReasoningEfforts` when present, else the base set. Single source of
 * truth for the picker (UI) and the persist/launch gate (backend), so `max`/
 * `ultra` cannot appear or be accepted for a model that doesn't declare them.
 */
export function allowedReasoningEffortsForModel(runtime: string, modelId: string): readonly string[] {
  const supported = RUNTIME_MODELS[runtime]?.find((m) => m.id === modelId)?.supportedReasoningEfforts;
  if (runtime === "kimi-sdk") return supported ?? [];
  return supported && supported.length > 0 ? supported : BASE_REASONING_EFFORTS;
}

/** Whether `effort` is allowed for the model — used to gate/normalize backend input. */
export function isReasoningEffortAllowedForModel(runtime: string, modelId: string, effort: ReasoningEffort): boolean {
  return allowedReasoningEffortsForModel(runtime, modelId).includes(effort);
}

/** Runtimes that support configurable reasoning effort. */
export const REASONING_EFFORT_RUNTIMES = new Set(["builtin", "claude", "codex", "grok", "copilot", "pi", "kimi-sdk"]);

/** Runtimes that support the shared fast-mode launch variant. */
export const RUNTIME_FAST_MODE_RUNTIMES = new Set(["claude", "codex"]);

// ── Task Board ──

/**
 * Task lifecycle status.
 *
 * `closed` is a terminal state that means "won't do" — the task was
 * deliberately abandoned (cancelled / won't-fix / duplicate / out-of-scope),
 * distinct from `done` which means "completed". A closed task can be
 * reopened by transitioning back to `todo`.
 *
 * Transition rules live in taskService.VALID_TRANSITIONS; route input
 * validation in routes/tasks.ts whitelists the literal values.
 *
 * stdrc 2026-05-08 #proj-task:5ca7dfa3:
 *   "Task除了 done，还应该该有一个closed 的状态，显示为红色，
 *    表示的是关掉并且不准备做了"
 */
export type TaskStatus = "todo" | "in_progress" | "in_review" | "done" | "closed";
// Single source of truth for runtime validation (see REMINDER_STATUSES above).
export const TASK_STATUSES = ["todo", "in_progress", "in_review", "done", "closed"] as const satisfies readonly TaskStatus[];

/**
 * Refusal reason a claim carries when the task is already assigned to the
 * caller. It is a *refusal* — no state was written, so the row's `success` is
 * false — but it authorises work, because it proves the caller already holds
 * the task.
 *
 * Shared rather than written out at each site because the server produces this
 * string and the CLI branches on it: the claim exit status treats it as
 * authorising work (so an agent re-confirming its own claim is not told the
 * claim failed), and the result formatter gives it its own line. Comparing
 * against a copied literal would mean a pure copy edit on the producer could
 * silently flip the consumer's branch, with production broken and tests still
 * green because each side held its own copy of the old wording.
 *
 * One symbol keeps the sides from diverging at all, rather than relying on a
 * test to notice that they have (@Kaiming, `#proj-runtime:941d4a53`).
 */
export const TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU = "already claimed by you";
export const isTaskStatus = (s: string): s is TaskStatus =>
  (TASK_STATUSES as readonly string[]).includes(s);

/**
 * Structured receipt for a task that creates or owns an external resource.
 *
 * The task row, rather than a free-form chat message, is the authority source.
 * Every value is required and non-blank before the task may move to `done`.
 * `expiry` is an ISO timestamp and automatically schedules an expiry follow-up owned by
 * the resolved teardown Agent.
 */
export interface TaskResourceReceipt {
  object: string;
  purpose: string;
  teardown_owner: string;
  security_privacy: string;
  expiry: string;
  runbook: string;
  tracking: string;
}

export interface TaskInfo {
  id: string;
  /** Same as id — task IS the message */
  messageId: string;
  channelId: string;
  channelName?: string | null;
  channelType?: "channel" | "private" | "joint" | "dm" | "thread";
  taskNumber: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  createdByType: "user" | "agent";
  createdById: string;
  createdByName?: string;
  claimedByType?: "user" | "agent" | null;
  claimedById?: string | null;
  claimedByName?: string | null;
  claimedAt?: string | null;
  completedAt?: string | null;
  requiresResourceReceipt?: boolean;
  resourceReceipt?: TaskResourceReceipt | null;
  resourceReceiptRecordedAt?: string | null;
  resourceTeardownOwnerAgentId?: string | null;
  resourceExpiryFollowupId?: string | null;
  createdAt: string;
}

export * from "./serverPermissions";
export * from "./taskPermissions";

// ── Server Plans ──

/** Plan identifiers stored in the database. */
export type ServerPlan = "free" | "founder" | "partner" | "pro";

/** Plans shown in the pricing comparison UI (includes coming-soon tiers). */
export type DisplayPlan = "free" | "pro" | "enterprise";

export interface PlanLimits {
  maxMachines: number;       // -1 = unlimited
  maxAgents: number;         // -1 = unlimited
  maxChannels: number;       // -1 = unlimited
  maxGuestJoinableChannelsPerServer: number; // -1 = unlimited
  messageHistoryDays: number; // -1 = unlimited
  includedAgents: number;    // [UNUSED] legacy extra-agent billing field
}

export interface PlanConfig {
  displayName: string;
  limits: PlanLimits;
  comingSoon: boolean;
  price: number;             // monthly price in dollars (0 = free)
  priceLabel?: string;       // display-only override for non-numeric pricing copy
  priceCadence?: string | null;
  extraAgentPrice: number;   // [UNUSED] extra-agent billing disabled — always 0 for now
  displayFeatures?: string[];
  displayDescription?: string;
  displayNote?: string;
}

export interface BillingCapacity {
  maxHumans: number;          // -1 = unlimited
  maxAgents: number;          // -1 = unlimited
  maxUniversalSeats: number;  // -1 = not universal-seat based or unlimited
}

export interface BillingUsage {
  humans: number;
  agents: number;
  universalSeats: number;
}

export type BillingCapacityKind = "human" | "agent";

export interface BillingCapacityLimitState {
  reached: boolean;
  limitType: "human" | "agent" | "universal" | null;
  usage: number;
  limit: number;
  nextUsage: number;
}

export interface BillingEntitlementProjection {
  plan: ServerPlan;
  status?: "active" | "past_due" | "canceled" | "incomplete" | null;
  billingInterval?: BillingInterval | null;
  provisionedHumanSeats?: number | null;
  provisionedAgentSeats?: number | null;
  /** Purchased Pro seats. Kept as proPackQuantity for storage/API compatibility. */
  proPackQuantity?: number | null;
  /** Deprecated storage/API fields; current Pro Seat billing always projects zero/null. */
  trialFreePackQuantity?: number | null;
  firstPackTrialEndsAt?: string | Date | null;
}

export interface BillingPriceSummary {
  billingInterval: BillingInterval;
  monthlyUsd: number;
  annualUsd: number | null;
  discountPercent: number;
  baseMonthlyUsd: number;
  overageMonthlyUsd: number;
  seatQuantity: number;
  packQuantity: number;
  humanSeatQuantity: number;
  agentSeatQuantity: number;
  agentSeatBlockQuantity: number;
}

export const PRO_SEAT_MONTHLY_USD = 10;
export const PRO_AGENT_SEAT_BLOCK_SIZE = 10;
export const PRO_AGENT_SEAT_FRACTION = 1 / PRO_AGENT_SEAT_BLOCK_SIZE;
export const PRO_SEAT_ANNUAL_MONTHLY_USD = 8.8;
export const PRO_SEAT_ANNUAL_USD = 105.6;
export const PRO_PACK_ANNUAL_DISCOUNT_PERCENT = 12;
export const PRO_HUMAN_SEAT_MONTHLY_USD = PRO_SEAT_MONTHLY_USD;
export const PRO_AGENT_SEAT_BLOCK_MONTHLY_USD = PRO_SEAT_MONTHLY_USD;
export const PRO_SEAT_LINE_ANNUAL_MONTHLY_USD = PRO_SEAT_ANNUAL_MONTHLY_USD;
export const PRO_HUMAN_SEAT_ANNUAL_USD = PRO_SEAT_ANNUAL_USD;
export const PRO_AGENT_SEAT_BLOCK_ANNUAL_USD = PRO_SEAT_ANNUAL_USD;
export const PRO_PACK_HUMAN_SEATS = 1;
export const PRO_PACK_AGENT_SEATS = PRO_AGENT_SEAT_BLOCK_SIZE;
export const PRO_PACK_MONTHLY_USD = PRO_SEAT_MONTHLY_USD;
export const PRO_PACK_ANNUAL_MONTHLY_USD = PRO_SEAT_ANNUAL_MONTHLY_USD;
export const PRO_PACK_ANNUAL_USD = PRO_SEAT_ANNUAL_USD;
export const DEFAULT_MAX_GUEST_JOINABLE_CHANNELS_PER_SERVER = -1;

export const PLAN_CONFIG: Record<ServerPlan, PlanConfig> = {
  free: {
    displayName: "Free",
    limits: { maxMachines: -1, maxAgents: -1, maxChannels: -1, maxGuestJoinableChannelsPerServer: DEFAULT_MAX_GUEST_JOINABLE_CHANNELS_PER_SERVER, messageHistoryDays: 30, includedAgents: -1 },
    comingSoon: false,
    price: 0,
    extraAgentPrice: 0,
    displayFeatures: [
      "Channels",
      "Tasks",
      "Agents on your own computers",
      "Agent reminders",
      "Basic observability",
      "30 days of message history",
      "100 MB file uploads/month",
    ],
  },
  founder: {
    displayName: "Founder",
    limits: { maxMachines: -1, maxAgents: -1, maxChannels: -1, maxGuestJoinableChannelsPerServer: DEFAULT_MAX_GUEST_JOINABLE_CHANNELS_PER_SERVER, messageHistoryDays: -1, includedAgents: -1 },
    comingSoon: false,
    price: 0,
    extraAgentPrice: 0,
  },
  partner: {
    displayName: "Partner",
    limits: { maxMachines: -1, maxAgents: -1, maxChannels: -1, maxGuestJoinableChannelsPerServer: DEFAULT_MAX_GUEST_JOINABLE_CHANNELS_PER_SERVER, messageHistoryDays: -1, includedAgents: -1 },
    comingSoon: false,
    price: 0,
    extraAgentPrice: 0,
  },
  pro: {
    displayName: "Pro",
    limits: { maxMachines: -1, maxAgents: PRO_PACK_AGENT_SEATS, maxChannels: -1, maxGuestJoinableChannelsPerServer: DEFAULT_MAX_GUEST_JOINABLE_CHANNELS_PER_SERVER, messageHistoryDays: -1, includedAgents: PRO_PACK_AGENT_SEATS },
    comingSoon: false,
    price: PRO_SEAT_MONTHLY_USD,
    extraAgentPrice: 0,
  },
};

/** Display-only plan configs for the pricing comparison UI. */
export const DISPLAY_PLAN_CONFIG: Record<DisplayPlan, PlanConfig> = {
  free: PLAN_CONFIG.free,
  pro: {
    displayName: "Pro",
    limits: { maxMachines: -1, maxAgents: -1, maxChannels: -1, maxGuestJoinableChannelsPerServer: DEFAULT_MAX_GUEST_JOINABLE_CHANNELS_PER_SERVER, messageHistoryDays: -1, includedAgents: -1 },
    comingSoon: false,
    price: PRO_SEAT_MONTHLY_USD,
    priceCadence: "/ seat / month",
    extraAgentPrice: 0,
    displayFeatures: [
      "Everything in Free",
      "Unlimited message history",
      "Higher file upload limits",
      "Joint channels",
      "More professional features coming soon",
    ],
    displayDescription: "For builders and teams scaling agent collaboration.",
    displayNote: `$${PRO_SEAT_ANNUAL_MONTHLY_USD.toFixed(2)} / seat / month when billed yearly. Each human uses 1 seat; each agent uses ${PRO_AGENT_SEAT_FRACTION} seat.`,
  },
  enterprise: {
    displayName: "Enterprise",
    limits: { maxMachines: -1, maxAgents: -1, maxChannels: -1, maxGuestJoinableChannelsPerServer: DEFAULT_MAX_GUEST_JOINABLE_CHANNELS_PER_SERVER, messageHistoryDays: -1, includedAgents: -1 },
    comingSoon: false,
    price: 0,
    priceLabel: "Coming soon",
    priceCadence: null,
    extraAgentPrice: 0,
    displayFeatures: [
      "Everything in Pro",
      "Private deployment options",
      "SSO and advanced access control",
      "Dedicated onboarding and rollout support",
    ],
    displayDescription: "For advanced deployment and governance needs.",
  },
};

/** Plans shown in the pricing comparison UI. */
export const DISPLAY_PLANS: DisplayPlan[] = ["free", "pro", "enterprise"];
export type BillingInterval = "monthly" | "annual";
export const DEFAULT_BILLING_INTERVAL: BillingInterval = "annual";
export const FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;
export const FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
export const PRO_SINGLE_FILE_UPLOAD_LIMIT_BYTES = 200 * 1024 * 1024;

export function getSingleFileUploadLimitBytes(plan: ServerPlan, now: Date = new Date()): number {
  return canUseProBillingFeatures(plan, now)
    ? PRO_SINGLE_FILE_UPLOAD_LIMIT_BYTES
    : FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES;
}

export function getSingleFileUploadLimitLabel(plan: ServerPlan, now: Date = new Date()): string {
  return canUseProBillingFeatures(plan, now) ? "200MB" : "50MB";
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.ceil(value));
}

export function getFinitePlanLimitExcess(usage: number, limit: number): number {
  if (!Number.isFinite(limit) || limit < 0) return 0;
  return Math.max(0, nonNegativeInteger(usage) - nonNegativeInteger(limit));
}

/** Start date of the extended free trial for Free plan users. */
export const TRIAL_START_DATE = new Date("2026-04-18T00:00:00Z");

/**
 * End instant of the free full-featured trial.
 * 2026-06-05: extended +7 (51 → 58) per @tygg #proj-release directive (task #7) —
 * trial end 2026-06-08 → 2026-06-15 UTC; TRIAL_START_DATE unchanged.
 * 2026-06-13: final billing acceptance window ends 2026-06-22 UTC (58 → 65);
 * 2026-06-21: keep the trial active through all of 2026-06-22 in every time zone.
 */
export const TRIAL_END_DATE = new Date("2026-06-23T12:00:00Z");

/** Duration retained for UI/compatibility consumers; the actual cutoff is TRIAL_END_DATE. */
export const TRIAL_DURATION_DAYS = (TRIAL_END_DATE.getTime() - TRIAL_START_DATE.getTime()) / (24 * 60 * 60 * 1000);

/** Check if the free trial period is currently active. */
export function isTrialActive(now: Date = new Date()): boolean {
  return now >= TRIAL_START_DATE && now < TRIAL_END_DATE;
}

export function calculateProPackQuantity(provisionedHumans: number, provisionedAgents: number): number {
  return Math.max(1, Math.ceil(nonNegativeInteger(provisionedHumans) + nonNegativeInteger(provisionedAgents) * PRO_AGENT_SEAT_FRACTION));
}

export function normalizeBillingInterval(value: unknown): BillingInterval {
  return value === "monthly" ? "monthly" : "annual";
}

export function calculateAgentSeatBlockQuantity(agentSeats: number): number {
  return Math.ceil(nonNegativeInteger(agentSeats) / PRO_AGENT_SEAT_BLOCK_SIZE);
}

export function calculateProSeatPrice(
  humanSeatQuantity: number,
  agentSeatQuantity: number,
  billingInterval: BillingInterval = DEFAULT_BILLING_INTERVAL,
): BillingPriceSummary {
  const humans = Math.max(1, nonNegativeInteger(humanSeatQuantity));
  const requestedAgents = nonNegativeInteger(agentSeatQuantity);
  const agentBlocks = calculateAgentSeatBlockQuantity(requestedAgents);
  const seatQuantity = calculateProPackQuantity(humans, requestedAgents);
  const provisionedAgents = seatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE;
  const unitMonthlyUsd = billingInterval === "annual" ? PRO_SEAT_ANNUAL_MONTHLY_USD : PRO_SEAT_MONTHLY_USD;
  const monthlyUsd = seatQuantity * unitMonthlyUsd;
  return {
    billingInterval,
    monthlyUsd,
    annualUsd: billingInterval === "annual"
      ? seatQuantity * PRO_SEAT_ANNUAL_USD
      : null,
    discountPercent: billingInterval === "annual" ? PRO_PACK_ANNUAL_DISCOUNT_PERCENT : 0,
    baseMonthlyUsd: monthlyUsd,
    overageMonthlyUsd: 0,
    seatQuantity,
    packQuantity: seatQuantity,
    humanSeatQuantity: humans,
    agentSeatQuantity: provisionedAgents,
    agentSeatBlockQuantity: agentBlocks,
  };
}

export function calculateProPrice(packQuantity: number, billingInterval: BillingInterval = DEFAULT_BILLING_INTERVAL): BillingPriceSummary {
  const seatQuantity = Math.max(1, nonNegativeInteger(packQuantity));
  const unitMonthlyUsd = billingInterval === "annual" ? PRO_SEAT_ANNUAL_MONTHLY_USD : PRO_SEAT_MONTHLY_USD;
  const monthlyUsd = seatQuantity * unitMonthlyUsd;
  return {
    billingInterval,
    monthlyUsd,
    annualUsd: billingInterval === "annual" ? seatQuantity * PRO_SEAT_ANNUAL_USD : null,
    discountPercent: billingInterval === "annual" ? PRO_PACK_ANNUAL_DISCOUNT_PERCENT : 0,
    baseMonthlyUsd: monthlyUsd,
    overageMonthlyUsd: 0,
    seatQuantity,
    packQuantity: seatQuantity,
    humanSeatQuantity: seatQuantity,
    agentSeatQuantity: seatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE,
    agentSeatBlockQuantity: seatQuantity,
  };
}

export function calculateProMonthlyPrice(packQuantity: number): BillingPriceSummary {
  return calculateProPrice(packQuantity, "monthly");
}

function getTrialFreeLimits(now: Date): PlanLimits {
  return isTrialActive(now)
    ? { maxMachines: -1, maxAgents: -1, maxChannels: -1, maxGuestJoinableChannelsPerServer: DEFAULT_MAX_GUEST_JOINABLE_CHANNELS_PER_SERVER, messageHistoryDays: -1, includedAgents: -1 }
    : PLAN_CONFIG.free.limits;
}

/** Get the effective limits for a plan. */
export function getEffectiveLimits(plan: ServerPlan, now: Date = new Date()): PlanLimits {
  if (plan === "free") return getTrialFreeLimits(now);
  return PLAN_CONFIG[plan].limits;
}

export function getBillingCapacity(entitlement: BillingEntitlementProjection, now: Date = new Date()): BillingCapacity {
  switch (entitlement.plan) {
    case "founder":
    case "partner":
      return { maxHumans: -1, maxAgents: -1, maxUniversalSeats: -1 };
    case "pro": {
      const fallbackPacks = Math.max(1, nonNegativeInteger(entitlement.proPackQuantity ?? 1));
      return {
        maxHumans: -1,
        maxAgents: -1,
        maxUniversalSeats: fallbackPacks,
      };
    }
    case "free": {
      const limits = getEffectiveLimits("free", now);
      return { maxHumans: -1, maxAgents: limits.maxAgents, maxUniversalSeats: -1 };
    }
  }
}

export function getBillingUsage(humans: number, agents: number): BillingUsage {
  const safeHumans = nonNegativeInteger(humans);
  const safeAgents = nonNegativeInteger(agents);
  return {
    humans: safeHumans,
    agents: safeAgents,
    universalSeats: safeHumans + safeAgents * PRO_AGENT_SEAT_FRACTION,
  };
}

export function getBillingCapacityLimitState(
  capacity: BillingCapacity,
  usage: BillingUsage,
  kind: BillingCapacityKind,
): BillingCapacityLimitState {
  if (kind === "human" && capacity.maxHumans !== -1 && usage.humans + 1 > capacity.maxHumans) {
    return {
      reached: true,
      limitType: "human",
      usage: usage.humans,
      limit: capacity.maxHumans,
      nextUsage: usage.humans + 1,
    };
  }
  if (kind === "agent" && capacity.maxAgents !== -1 && usage.agents + 1 > capacity.maxAgents) {
    return {
      reached: true,
      limitType: "agent",
      usage: usage.agents,
      limit: capacity.maxAgents,
      nextUsage: usage.agents + 1,
    };
  }
  if (capacity.maxUniversalSeats !== -1) {
    const nextUniversalSeats = usage.universalSeats + (kind === "human" ? 1 : PRO_AGENT_SEAT_FRACTION);
    if (nextUniversalSeats > capacity.maxUniversalSeats) {
      return {
        reached: true,
        limitType: "universal",
        usage: usage.universalSeats,
        limit: capacity.maxUniversalSeats,
        nextUsage: nextUniversalSeats,
      };
    }
  }
  return {
    reached: false,
    limitType: null,
    usage: kind === "human" ? usage.humans : usage.agents,
    limit: -1,
    nextUsage: kind === "human" ? usage.humans + 1 : usage.agents + 1,
  };
}

export function getBillingCapacityLimitLabel(kind: BillingCapacityKind, limitType: BillingCapacityLimitState["limitType"]): string {
  if (limitType === "universal") return "Seat limit";
  if (limitType === "human" || kind === "human") return "Human seat limit";
  return "Agent limit";
}

export function formatBillingCapacityLimitMessage(
  kind: BillingCapacityKind,
  capacityState: BillingCapacityLimitState,
  planDisplayName: string,
  suffix = "",
): string {
  const label = getBillingCapacityLimitLabel(kind, capacityState.limitType);
  return `${label} reached (${capacityState.usage}/${capacityState.limit} on ${planDisplayName} plan).${suffix}`;
}

export function formatProAgentSeatFraction(): string {
  return Number.isInteger(PRO_AGENT_SEAT_FRACTION)
    ? String(PRO_AGENT_SEAT_FRACTION)
    : String(Number(PRO_AGENT_SEAT_FRACTION.toFixed(6)));
}

export function canUseProBillingFeatures(plan: ServerPlan, now: Date = new Date()): boolean {
  return plan === "pro" || plan === "founder" || plan === "partner" || (plan === "free" && isTrialActive(now));
}

export const canUseTeamBillingFeatures = canUseProBillingFeatures;

// ── Downgrade Grace Period ──

export const DOWNGRADE_GRACE_PERIOD_DAYS = 7;

// ── Onboarding: #all reveal ──

/**
 * Under the onboarding opener, the virtual `#all` channel is born hidden and
 * reveals once the server has grown into a team — total members (humans +
 * agents) reaching this threshold. Baseline onboarding is owner (1 human) +
 * the Cindy OA (1 agent) = 2, so a 3rd member of either kind unlocks #all.
 */
export const ALL_CHANNEL_TEAM_THRESHOLD = 3;

// ── Name Validation ──

/**
 * Regex for valid `name` fields (user, agent, channel).
 * Must start with a letter; rest can be letters, digits, underscore, hyphen.
 * Disallows: pure numbers, leading digits, spaces, @, #, and other special characters.
 */
export const NAME_REGEX = /^[\p{L}][\p{L}\p{N}_-]*$/u;
export const NAME_MIN_LENGTH = 1;
export const NAME_MAX_LENGTH = 32;
export const RESERVED_AGENT_NAMES = [
  "all",
  "human",
  "humans",
  "agent",
  "agents",
  "here",
  "idle",
  "busy",
  "system",
  // `dm:@reminders` names each agent's private reminder conversation.
  "reminders",
] as const;

/** Validate a name and return an error message, or null if valid.
 *  Pass `minLength` to override the default minimum (e.g. 5 for user/server names). */
/**
 * Why a name is invalid, as data rather than an English sentence.
 *
 * `validateName` interpolates a label into an English frame, so a UI that
 * localizes only the label produces a MIXED-LANGUAGE string ("频道名称 is
 * required") -- worse than leaving it English. Localized surfaces take the
 * reason and format the whole sentence from their own catalog.
 */
export type NameValidationReason =
  | { code: "required" }
  | { code: "tooShort"; minLength: number }
  | { code: "tooLong"; maxLength: number }
  | { code: "pattern" };

export function validateNameReason(
  name: string,
  minLength = NAME_MIN_LENGTH,
): NameValidationReason | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { code: "required" };
  if (trimmed.length < minLength) return { code: "tooShort", minLength };
  if (trimmed.length > NAME_MAX_LENGTH) return { code: "tooLong", maxLength: NAME_MAX_LENGTH };
  if (!NAME_REGEX.test(trimmed)) return { code: "pattern" };
  return null;
}

/**
 * English-sentence form, for server responses and unmigrated callers. Built on
 * validateNameReason so the two can never disagree about what is valid.
 */
export function validateName(name: string, label = "Name", minLength = NAME_MIN_LENGTH): string | null {
  const reason = validateNameReason(name, minLength);
  if (!reason) return null;
  switch (reason.code) {
    case "required":
      return `${label} is required`;
    case "tooShort":
      return `${label} must be at least ${reason.minLength} characters`;
    case "tooLong":
      return `${label} must be at most ${reason.maxLength} characters`;
    case "pattern":
      return `${label} must start with a letter and can only contain letters, numbers, hyphens, and underscores`;
  }
}

export function isReservedAgentName(name: string): boolean {
  const normalized = name.trim().replace(/^@/, "").toLowerCase();
  return (RESERVED_AGENT_NAMES as readonly string[]).includes(normalized);
}

export type AgentNameValidationReason =
  | NameValidationReason
  | { code: "reserved"; handle: string };

export function validateAgentNameReason(name: string): AgentNameValidationReason | null {
  if (name.trim().length === 0) return { code: "required" };
  if (isReservedAgentName(name)) {
    return { code: "reserved", handle: name.trim().replace(/^@/, "").toLowerCase() };
  }
  return validateNameReason(name);
}

export function validateAgentName(name: string, label = "Agent name"): string | null {
  const reason = validateAgentNameReason(name);
  if (!reason) return null;
  if (reason.code === "reserved") {
    return `${label} @${reason.handle} is reserved. Choose another name.`;
  }
  return validateName(name, label);
}

// ── Announcements ──

/** A single page inside a paginated announcement. */
export interface AnnouncementPage {
  title?: string;
  body: string;
}

/** Fully translated content for one renderable display locale. */
export interface AnnouncementContent {
  title: string;
  pages: AnnouncementPage[];
}

/** Announcement content is authored only for display locales shipped by Raft. */
export type AnnouncementContentByLocale = Partial<Record<DisplayLocale, AnnouncementContent>>;

/** An account-level popup announcement. Shown exactly once per user (by id)
 *  until dismissed; a new announcement always means a new id. */
export interface Announcement {
  id: string;
  title: string;
  pages: AnnouncementPage[];
  publishedAt: string;
  startsAt: string;
  endsAt: string | null;
  locale: DisplayLocale;
}

// ── Daemon Version ──

const SEMVER_TRIPLE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Parse `MAJOR.MINOR.PATCH` strictly. Returns null on any non-digit
 *  segment (incl. NaN-producing inputs like `"abc"` or `"0.0.62-rc1"`).
 *  Used by the comparison helpers below so a malformed input never
 *  silently becomes [NaN] and confuses the loop. */
function parseSemverTriple(v: string): [number, number, number] | null {
  const m = v.match(SEMVER_TRIPLE);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Check if a daemon version is outdated (below the latest known version).
 *  Returns false on missing or unparseable inputs (prefer-miss-over-mistrigger
 *  per [[feedback_client_gate_live_only_field]] family — a malformed version
 *  must not trigger "update available" or hard-disable the upgrade button). */
export function isDaemonOutdated(version: string | null | undefined, latestVersion: string | null | undefined): boolean {
  if (!version || !latestVersion) return false;
  const cur = parseSemverTriple(version);
  const latest = parseSemverTriple(latestVersion);
  if (cur === null || latest === null) return false;
  for (let i = 0; i < 3; i++) {
    if (cur[i] < latest[i]) return true;
    if (cur[i] > latest[i]) return false;
  }
  return false; // equal = not outdated
}

// ── Computer Version ──

/** Check if a managed-Computer (`@botiverse/raft-computer`) version is below
 *  the latest known. Same semantics as `isDaemonOutdated` (and the menu-bar
 *  app's `semverGreater` — Yingjun guardian note: don't fork "what counts as
 *  newer" between web / menu-bar, otherwise the menu says "update available"
 *  while the dashboard says nothing). Returns false on missing or
 *  unparseable inputs (prefer-miss-over-mis-trigger). */
export function isComputerOutdated(version: string | null | undefined, latestVersion: string | null | undefined): boolean {
  return isDaemonOutdated(version, latestVersion);
}

/** Full SemVer 2.0.0 (prerelease and build metadata allowed, no leading zeros
 *  in numeric parts). The form the server's upgrade policy accepts for a
 *  Computer's reported version and a published release; staging / rc / branch
 *  builds report prerelease versions such as `1.0.41-staging.<ts>.sha.<sha>`. */
const COMPUTER_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export function isComputerSemver(value: string): boolean {
  if (!COMPUTER_SEMVER.test(value)) return false;
  const pre = value.split("+", 1)[0]!.split("-").slice(1).join("-");
  return !pre.split(".").some((part) => /^0\d+$/.test(part));
}

/** SemVer precedence of two Computer versions (-1 / 0 / 1); build metadata is
 *  ignored and a prerelease sorts below its release. The server's upgrade
 *  policy uses this for `already_current`; the web uses it for "is a newer
 *  version available". Both inputs must pass `isComputerSemver`. */
export function compareComputerVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const withoutBuild = value.split("+", 1)[0]!;
    const separator = withoutBuild.indexOf("-");
    return {
      core: (separator < 0 ? withoutBuild : withoutBuild.slice(0, separator)).split(".").map(BigInt),
      pre: separator < 0 ? null : withoutBuild.slice(separator + 1).split("."),
    };
  };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i]! < b.core[i]! ? -1 : 1;
  }
  if (a.pre === null || b.pre === null) return a.pre === b.pre ? 0 : a.pre === null ? 1 : -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * First Computer release that runs remote upgrade v2 (task #873): launches the
 * installer against an exact target and reports nothing until it is back.
 * Older Computers are not driven from the web; the web shows a one-time hint
 * to upgrade locally instead.
 */
export const COMPUTER_REMOTE_UPGRADE_MIN_VERSION = "1.0.37";

/** null when the version is unknown; otherwise whether the web may drive an
 *  upgrade. Full SemVer, fail-closed: a version that is not SemVer is not
 *  supported, and a prerelease sorts below its release (1.0.37-rc.1 is below
 *  1.0.37). The server projection and the upgrade route's guard both use this. */
export function isRemoteUpgradeSupported(version: string | null | undefined): boolean | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  if (!isComputerSemver(trimmed)) return false;
  return compareComputerVersions(trimmed, COMPUTER_REMOTE_UPGRADE_MIN_VERSION) >= 0;
}

// ── Server system notification feed ──
//
// Machine operational notices used to be re-derived independently by Web and
// KMP from `/machines`. This wire contract makes the server the sole authority
// for receiver eligibility, condition evaluation, copy parameters, severity,
// and dedupe identity. Consumers render this snapshot, keep dismissal state
// locally by `notification.id`, and must not re-evaluate machine state.
export const SERVER_SYSTEM_NOTIFICATIONS_CONTRACT_VERSION = "server-system-notifications-v1" as const;
export const MACHINE_SYSTEM_NOTIFICATION_SCHEMA_VERSION = 1 as const;

export type ServerSystemNotificationKind = "error" | "warning" | "info";
/** Same threshold as the cleaner's low-disk check (apps/cleaner/configProtocol). */
export const MACHINE_DISK_LOW_FREE_PERCENT = 10;
/**
 * At or above this much free space a disk is never "low", whatever the
 * percentage: 10% of a 2 TB disk is still 200 GB.
 */
export const MACHINE_DISK_LOW_MAX_AVAILABLE_BYTES = 20 * 1024 ** 3;

/** Latest disk report of a connected machine; byte counts are whole numbers. */
export interface MachineDiskStatus {
  availableBytes: number;
  totalBytes: number;
}

export function isValidMachineDiskStatus(value: unknown): value is MachineDiskStatus {
  if (!value || typeof value !== "object") return false;
  const { availableBytes, totalBytes } = value as Record<string, unknown>;
  return typeof availableBytes === "number" && typeof totalBytes === "number"
    && Number.isSafeInteger(availableBytes) && Number.isSafeInteger(totalBytes)
    && availableBytes >= 0 && totalBytes > 0 && availableBytes <= totalBytes;
}

/** The one low-disk rule shared by the cleaner, the server and the web. */
export function isMachineDiskLow(disk: MachineDiskStatus | null | undefined): boolean {
  if (!disk) return false;
  return disk.availableBytes < MACHINE_DISK_LOW_MAX_AVAILABLE_BYTES
    && disk.availableBytes / disk.totalBytes * 100 < MACHINE_DISK_LOW_FREE_PERCENT;
}

export type MachineSystemNotificationType = "machine.offline" | "machine.outdated";
export type MachineSystemNotificationTitleCopyKey =
  | "machine.offline.title.one"
  | "machine.offline.title.many"
  | "machine.outdated.title.one"
  | "machine.outdated.title.many";
export type MachineSystemNotificationBodyCopyKey =
  | "machine.offline.body.active.one"
  | "machine.offline.body.active.many"
  | "machine.offline.body.idle.one"
  | "machine.offline.body.idle.many"
  | "machine.outdated.body";

export interface MachineSystemNotificationMachine {
  id: string;
  name: string;
}

export interface MachineSystemNotificationEvaluation {
  /** Eligibility is evaluated only against server-authoritative state. */
  clock: "server";
  evaluatedAt: string;
  /** No client timer: once canonical machine status is offline, it is eligible. */
  offlineAfterMs: 0;
  statusAuthority: "canonical_machine_read_model";
  /** Managed Computers intentionally use their separate aggregate attention contract. */
  runKind: "raw_daemon";
  /** Outdated means the raw daemon version trails the server release target. */
  versionAuthority: "latest_daemon_release";
}

export interface MachineSystemNotification {
  id: string;
  type: MachineSystemNotificationType;
  schemaVersion: typeof MACHINE_SYSTEM_NOTIFICATION_SCHEMA_VERSION;
  state: "active";
  kind: Exclude<ServerSystemNotificationKind, "info">;
  title: string;
  body: string;
  /** Stable localization descriptor; title/body remain English fallbacks. */
  copy: {
    titleKey: MachineSystemNotificationTitleCopyKey;
    bodyKey: MachineSystemNotificationBodyCopyKey;
    actionLabelKey: "common.view";
    params: {
      machineNames: string;
      machineCount: number;
      activeAgentCount: number;
      targetDaemonVersion: string | null;
    };
  };
  action: {
    label: "View";
    targetType: "machine";
    targetId: string;
  };
  payload: {
    machines: MachineSystemNotificationMachine[];
    activeAgentCount: number;
    targetDaemonVersion: string | null;
    evaluation: MachineSystemNotificationEvaluation;
  };
}

export interface ServerSystemNotificationsResponse {
  contractVersion: typeof SERVER_SYSTEM_NOTIFICATIONS_CONTRACT_VERSION;
  generatedAt: string;
  /** The response is the complete active set for this receiver and server. */
  snapshotMode: "replace";
  /** Opening the center does not create a read receipt; dismiss stays local. */
  clientState: {
    read: "none";
    dismiss: "local_by_notification_id";
  };
  notifications: MachineSystemNotification[];
}

/** True iff BOTH versions are present AND parse as `MAJOR.MINOR.PATCH`. The
 *  Computer-Upgrade gate uses this as a precondition to "we positively know
 *  there's nothing to upgrade" — otherwise a malformed string slipping in
 *  (cosmic ray / corrupted ready msg / future tag like `0.0.62-rc1`) would
 *  silently get treated as "up to date" and disable the button. Pair with
 *  `!isComputerOutdated(...)` for the full positive-no-upgrade check. */
export function bothComputerVersionsKnown(version: string | null | undefined, latestVersion: string | null | undefined): boolean {
  if (!version || !latestVersion) return false;
  return parseSemverTriple(version) !== null && parseSemverTriple(latestVersion) !== null;
}

export {
  TRACE_JOIN_KEYS,
  TRACE_ENTITY_FILTERABLE_DIMENSIONS,
  TRACE_FAMILY_REGISTRY,
  InvalidTraceEntityDimensionError,
  assertTraceFamilyEntityFilterable,
  traceFamilyRegistration,
  type TraceFamilyConsumer,
  type TraceFamilyName,
  type TraceFamilyRegistration,
  type TraceJoinKey,
  type TraceEntityFilterableDimension,
  type TracePrivacyTier,
} from "./tracing/traceFamilyRegistry";

export {
  STATE_TRANSITION_DOMAINS,
  STATE_TRANSITION_JOIN_FIELDS,
  STATE_TRANSITION_KEY_FIELDS,
  STATE_TRANSITION_META_FIELDS,
  buildStateTransitionTraceAttrs,
  type StateTransitionDomain,
  type StateTransitionOutcome,
  type StateTransitionTraceAttrs,
  type StateTransitionTraceInput,
  type StateTransitionTraceJoin,
  type StateTransitionTraceKey,
  type StateTransitionTraceMeta,
} from "./tracing/stateTransitionTrace";

export {
  STATE_VIOLATION_JOIN_FIELDS,
  STATE_VIOLATION_KEY_FIELDS,
  STATE_VIOLATION_KINDS,
  STATE_VIOLATION_META_FIELDS,
  buildStateViolationTraceAttrs,
  type StateViolationKind,
  type StateViolationTraceAttrs,
  type StateViolationTraceInput,
  type StateViolationTraceJoin,
  type StateViolationTraceKey,
  type StateViolationTraceMeta,
} from "./tracing/stateViolationTrace";

// ── Signup survey ──
//
// Asked once, between email verification and identity setup.
//
// The "how did you hear about us" half is NOT new: `referralSource` already exists
// on users, is already written by PATCH /api/auth/me, and already has a canonical
// option set that the owner-onboarding modal asks with. These are those exact
// values, lifted here so both surfaces read one list instead of two copies drifting.
// Changing a value here is a data migration, not a copy edit.
export const REFERRAL_SOURCES = [
  { id: "twitter_x", label: "Twitter / X" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "friend_colleague", label: "A friend or colleague" },
  { id: "search", label: "Search" },
  { id: "hn_reddit", label: "Hacker News / Reddit" },
  { id: "podcast_blog_newsletter", label: "Podcast / blog / newsletter" },
  { id: "other", label: "Other" },
] as const;

// The role IS new (no prior field existed; `users.role` is server membership, not
// occupation). Aimed at who actually adopts an agent platform, and at what would
// genuinely change how the onboarding agent introduces Raft.
export const SIGNUP_ROLES = [
  { id: "software_engineer", label: "Software engineer" },
  { id: "engineering_leader", label: "Tech lead" },
  { id: "founder", label: "Founder" },
  { id: "product", label: "Product manager" },
  { id: "design", label: "Designer" },
  { id: "data_ml", label: "Data / ML" },
  { id: "devops_it", label: "DevOps / IT" },
  { id: "student", label: "Student or learner" },
  { id: "other", label: "Other" },
] as const;

export type ReferralSourceId = typeof REFERRAL_SOURCES[number]["id"];
export type SignupRoleId = typeof SIGNUP_ROLES[number]["id"];

/**
 * Retired option ids: still accepted on write and labelled on read, just no longer
 * offered. Empty today. `hn_reddit` deliberately stays a single combined option:
 * it already has real rows behind it, and splitting it would strand them.
 */
export const REFERRAL_SOURCES_LEGACY = [] as ReadonlyArray<{ id: string; label: string }>;

export function isReferralSourceId(value: unknown): value is ReferralSourceId {
  return typeof value === "string" && REFERRAL_SOURCES.some((source) => source.id === value);
}

/** Write-side validation: current options, plus retired ids older clients may still send. */
export function isAcceptedReferralSourceId(value: unknown): boolean {
  return isReferralSourceId(value)
    || (typeof value === "string" && REFERRAL_SOURCES_LEGACY.some((source) => source.id === value));
}

/** Read-side label, including retired ids so historical rows still render. */
export function referralSourceLabel(id: string | null | undefined): string | null {
  return [...REFERRAL_SOURCES, ...REFERRAL_SOURCES_LEGACY].find((source) => source.id === id)?.label ?? null;
}

export function isSignupRoleId(value: unknown): value is SignupRoleId {
  return typeof value === "string" && SIGNUP_ROLES.some((role) => role.id === value);
}

/** Human-readable role, for the onboarding agent's briefing. */
export function signupRoleLabel(id: string | null | undefined): string | null {
  return SIGNUP_ROLES.find((role) => role.id === id)?.label ?? null;
}

export * from "./canonicalMessageManifest";
export * from "./canonicalMessageV2";
export * from "./agentMigrationResumable";
export * from "./discussionGraph";
export * from "./managedMcp";
export * from "./providerConnections";
export * from "./providerProbes";


// ── Identity setup: who still owes us a handle ──
//
// A brand-new account is created with a placeholder handle (`pending_<hex>`) and no
// `profileSetupCompletedAt`, and it is sent to "Set up your account". The completion
// TIMESTAMP is the record of that; the HANDLE is the fact itself.
//
// They can disagree. A migration backfill that misses a row leaves a long-standing user
// with a real handle and a NULL timestamp — and reading the NULL alone drags them back
// through signup, asking them to choose a username they picked years ago (and cannot
// change afterwards). So the absence of a record never outweighs the presence of the
// thing it was supposed to record: a real handle means identity setup is done, stamp or
// no stamp. Only a placeholder still owes us anything.
export const PROFILE_SETUP_PLACEHOLDER_PREFIX = "pending_";

export function hasPlaceholderHandle(name: string | null | undefined): boolean {
  return !!name && name.toLowerCase().startsWith(PROFILE_SETUP_PLACEHOLDER_PREFIX);
}

export function accountNeedsIdentitySetup(user: {
  name?: string | null;
  profileSetupCompletedAt?: string | Date | null;
}): boolean {
  // Ask the FACT, not the flag that summarises it.
  //
  // This used to short-circuit on `profileSetupCompletedAt` — stamped means set up, whatever
  // the name says. So anything that stamped the date without giving the person a handle
  // produced a user who sailed through the gate still called `pending_7ec59ca5…`, and Cindy
  // greeted them by that. (I made exactly that user by hand and briefly reported the greeting
  // as a product bug; the guard I had climbed around was the one meant to prevent it.)
  //
  // "Has this person got a name" is the question the gate exists to ask, and the row already
  // answers it. The stamp was a proxy for that answer, and a proxy can disagree with the thing
  // it stands for.
  //
  // The legacy case still fails open by construction: a NULL stamp with a real handle is a row
  // the backfill missed, not a person who never set up — and a real handle is a real handle.
  return hasPlaceholderHandle(user.name) || !user.name;
}
export * from "./inboxScopeReadFrontier";

export * from "./channelConversionState";
export * from "./providerRequestActivity";
