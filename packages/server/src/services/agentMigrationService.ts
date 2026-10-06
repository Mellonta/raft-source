import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
  AGENT_MIGRATION_COMMIT_MARKER_PATH,
  AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
  AGENT_MIGRATION_DEFAULT_CHUNK_BYTES,
  AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES,
  AGENT_MIGRATION_MAX_CHUNKS,
  AGENT_MIGRATION_MAX_CONTROL_MANIFEST_BYTES,
  AGENT_MIGRATION_MIN_CHUNK_BYTES,
  AGENT_MIGRATION_CAPABILITY,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  AGENT_MIGRATION_SOURCE_BUILD_PHASES,
  MAX_AGENT_MIGRATION_TRANSPORT_BYTES,
  agentMigrationSourceBuildProgressReportSchema,
  agentMigrationTransferSummarySchema,
  currentDate,
  type AgentMigrationControlManifest,
  type AgentMigrationSourceQuiesceReceipt,
  type AgentMigrationTerminalFailureCode,
  type AgentMigrationTransferSummary,
  type AgentMigrationUpdatedPayload,
  type ServerToMachineMessage,
} from "@botiverse/raft-shared";
import { getDb, isDatabaseInitialized, type DatabaseExecutor } from "../db/index";
import { FencedAuthorizationDeniedError, lockActorMembershipRow } from "../lib/actorMembershipFence";
import { userCanActOnAgentResource } from "../lib/actorPermissions";
import {
  agentMigrationChunkReceipts,
  agentMigrationReceiptChannels,
  agentMigrations,
  agentRuntimeProfiles,
  agents,
  channelAgents,
  channels,
  machines,
} from "../db/schema";
import { createAgentLifecycleEvent, type AgentLifecycleEvent } from "./agentLifecycleEvents";
import {
  enqueueAgentMigrationCanceledReceipt,
  enqueueAgentMigrationCompletedReceipt,
  enqueueAgentMigrationAbortedReceipt,
  enqueueAgentMigrationFailedReceipt,
  type AgentMigrationReceiptEnqueueHooks,
} from "./agentMigrationReceiptService";
import { getStorage, type StorageBackend } from "./storageService";

export type AgentMigrationRow = typeof agentMigrations.$inferSelect;
export type AgentMigrationState = AgentMigrationRow["state"];
export type AgentMigrationTransportFailureCode = AgentMigrationTerminalFailureCode;

export const ACTIVE_AGENT_MIGRATION_STATES = [
  "provisioning",
  "prep",
  "ready",
  "in_transit",
  "arriving",
  "starting",
] as const;
export type ActiveAgentMigrationState = typeof ACTIVE_AGENT_MIGRATION_STATES[number];
const TRANSFER_ACTIVE_AGENT_MIGRATION_STATES = [
  "provisioning",
  "prep",
  "ready",
  "in_transit",
  "arriving",
  "starting",
] as const satisfies readonly ActiveAgentMigrationState[];
export type AgentMigrationCancelDisposition = NonNullable<AgentMigrationRow["cancelDisposition"]>;
export type AgentMigrationCancelRole = "source" | "target";
export type AgentMigrationCancelMessage = Extract<ServerToMachineMessage, { type: "machine:migration:cancel" }>;
export interface AgentMigrationCancellationRequestResult {
  migration: AgentMigrationRow;
  disposition: AgentMigrationCancelDisposition;
  dispatch: "required" | "none";
}
export type AgentMigrationAutoStartFailureStage = "orchestrator" | "start_agent";
export type AgentMigrationAutoStartFailureCode =
  | "orchestrator_unavailable"
  | "start_not_dispatched"
  | "start_threw";
export interface AgentMigrationCancellationCleanupClaim {
  migration: AgentMigrationRow;
  dispatch: "required" | "none";
  leaseId: string | null;
  deliveries: Array<{ machineId: string; message: AgentMigrationCancelMessage }>;
}
export type AgentMigrationAutoStartRemediationCandidateVariant = "typed_failed" | "orphaned_dispatch" | "orphaned_arrival";
export interface AgentMigrationAutoStartRemediationClaim {
  migration: AgentMigrationRow;
  action: "dispatch" | "terminal";
  leaseId: string | null;
  candidateVariant: AgentMigrationAutoStartRemediationCandidateVariant;
}
export const AGENT_MIGRATION_CANCEL_MAX_DISPATCH_ATTEMPTS = 3;
export const AGENT_MIGRATION_CANCEL_ATTENTION_WINDOW_MS = 2 * 60 * 1000;
export const AGENT_MIGRATION_CANCEL_CLEANUP_LEASE_MS = 30_000;
export const AGENT_MIGRATION_AUTO_START_MAX_RETRY_ATTEMPTS = 3;
export const AGENT_MIGRATION_AUTO_START_REMEDIATION_WINDOW_MS = 2 * 60 * 1000;
// `starting` has no deadline of its own. If the `/arrived` request dies after
// writing `starting` but before it records an auto-start outcome, nothing else
// would ever pick the row up and the agent stays wake-gated. After this grace
// (well past the daemon's 30s `/arrived` reclaim) remediation adopts the row.
export const AGENT_MIGRATION_ORPHANED_ARRIVAL_GRACE_MS = 5 * 60 * 1000;
export const AGENT_MIGRATION_AUTO_START_REMEDIATION_LEASE_MS = 30_000;
export const DEFAULT_AGENT_MIGRATION_TRANSPORT_MAX_BYTES = MAX_AGENT_MIGRATION_TRANSPORT_BYTES;
export const AGENT_MIGRATION_AUTO_START_LEASE_MS = 30_000;
// The lease (tokens and presigned URLs) must outlive the longest migration;
// the deadlines, not the lease, stop a stalled one.
const DEFAULT_AGENT_MIGRATION_TRANSPORT_LEASE_MS = 6 * 60 * 60 * 1000;
const AGENT_MIGRATION_CHUNK_URL_BATCH_LIMIT = 64;

export interface AgentMigrationDeadlines {
  prepDeadlineAt: Date;
  transferDeadlineAt: Date;
  arrivalDeadlineAt: Date;
}

/**
 * Task #93 line C: the acting human a migration write re-authorizes under row locks inside its own transaction. Only the
 * human routes pass it; the Computer route and the remediation worker have no human actor and stay unfenced.
 */
export interface AgentMigrationActorFence {
  serverId: string;
  userId: string;
  capability: "migrateAgents" | "controlAgentRuntime";
}

export interface BeginAgentMigrationInput {
  agentId: string;
  targetMachineId: string;
  initiatedByUserId?: string | null;
  actorFence?: AgentMigrationActorFence;
  now?: Date;
  prepDeadlineMs?: number;
  transferDeadlineMs?: number;
  arrivalDeadlineMs?: number;
}

export interface BeginAgentMigrationProvisioningInput extends BeginAgentMigrationInput {
  transportProvider?: "object_store";
  transportSessionId?: string;
  transportLeaseMs?: number;
  transportMaxBytes?: number;
}

export type AgentMigrationTransportLeaseMessage = Extract<ServerToMachineMessage, { type: "machine:migration_transport:lease" }>;

export interface AgentMigrationTransportLeaseDelivery {
  machineId: string;
  role: "source" | "target";
  message: AgentMigrationTransportLeaseMessage;
}

export interface AgentMigrationProvisioningResult {
  migration: AgentMigrationRow;
  source: AgentMigrationTransportLeaseDelivery;
  target: AgentMigrationTransportLeaseDelivery;
}

export interface AgentMigrationObjectStoreTransferProvision {
  provider: "object_store";
  sessionId: string;
  leaseMs: number;
  maxBytes: number;
}

export interface AgentMigrationTransferLeaseState {
  provider?: AgentMigrationTransportLeaseMessage["provider"] | null;
  role?: "source" | "target" | null;
  transferKind?: AgentMigrationTransportLeaseMessage["transferKind"] | null;
  leaseSource?: AgentMigrationTransportLeaseMessage["leaseSource"] | null;
  migrationId?: string | null;
  migrationGeneration?: string | null;
  sessionId?: string | null;
  expiresAt?: string | Date | null;
  maxBytes?: number | null;
}

export type AgentMigrationTransferLeaseReadyVerdict =
  | { ready: true }
  | {
      ready: false;
      code: "MIGRATION_TRANSPORT_NOT_PROVISIONED" | "MIGRATION_TRANSPORT_LOST";
      reason:
        | "missing"
        | "provider_mismatch"
        | "role_mismatch"
        | "transfer_kind_mismatch"
        | "lease_source_mismatch"
        | "migration_mismatch"
        | "generation_mismatch"
        | "session_mismatch"
        | "expires_at_invalid"
        | "expired"
        | "max_bytes_invalid"
        | "max_bytes_exceeds_grant";
    };

export type ZenMigratingDeliveryDecision =
  | { action: "deliver"; reason: "no-active-migration" | "target-starting" }
  | { action: "queue"; reason: "zen-migrating" }
  | { action: "deadline-expired"; reason: "prep-deadline" | "transfer-deadline" | "arrival-deadline" };

export interface AgentMigrationGateStatus {
  migration: AgentMigrationRow | null;
}

export interface AgentMigrationTargetImportView {
  migrationId: string;
  migrationRef: string;
  migrationGeneration: string;
  state: AgentMigrationState;
  sourceMachineId: string;
  targetMachineId: string;
  agentId: string;
  manifestPath: string | null;
  manifestSha256: string | null;
  canDriveTargetImport: true;
}

export interface AgentMigrationTargetArrivalResult {
  migration: AgentMigrationTargetImportView;
  autoStart: "dispatch" | "observe" | "none";
}

export interface AgentMigrationChunkTransferPlanEntry {
  index: number;
  sizeBytes: number;
  sha256: string;
  method: "PUT" | "GET";
  url: string;
}

export interface AgentMigrationChunkTransferPlan {
  migrationId: string;
  migrationGeneration: string;
  leaseId: string;
  controlSha256: string;
  chunks: AgentMigrationChunkTransferPlanEntry[];
  nextCursor: number | null;
  complete: boolean;
}

const DEFAULT_PREP_DEADLINE_MS = 10 * 60 * 1000;
// Between the source quiesce and the control registration the source daemon
// builds the whole bundle locally and reports nothing. Large workspaces or slow
// disks need more than one idle window for that (prod: 4/4 attempts from one
// machine aborted at prep-deadline before registering control).
const SOURCE_BUNDLE_BUILD_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_TRANSFER_DEADLINE_MS = 60 * 60 * 1000;
// Progress slides the transfer deadline to at least this far ahead.
const TRANSFER_IDLE_WINDOW_MS = 30 * 60 * 1000;
/** However steadily it progresses, no migration runs past this from creation. */
export const AGENT_MIGRATION_MAX_DURATION_MS = 6 * 60 * 60 * 1000;
// States whose deadlines progress can slide; arrival and later keep theirs.
const PROGRESS_DEADLINE_STATES = ["provisioning", "prep", "ready", "in_transit"] as const;
const DEFAULT_ARRIVAL_DEADLINE_MS = 10 * 60 * 1000;

function addMs(now: Date, ms: number): Date {
  return new Date(now.getTime() + ms);
}

function positiveDeadlineMs(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_ARRIVAL_DEADLINE_MS;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createTransportToken(): string {
  return `slock_migration_${randomBytes(32).toString("base64url")}`;
}

function createMigrationSupportRef(): string {
  return `mig_${randomBytes(16).toString("base64url")}`;
}

function createMigrationCancelGeneration(): string {
  return `migration_cancel_${randomBytes(24).toString("base64url")}`;
}

function parseLeaseExpiry(value: string | Date | null | undefined): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function transferKindForRole(role: "source" | "target"): AgentMigrationTransportLeaseMessage["transferKind"] {
  return role === "source" ? "upload" : "download";
}

function storagePresignExpiresInSeconds(leaseMs: number): number {
  return Math.max(60, Math.ceil(leaseMs / 1000));
}

function arrivalWindowMs(row: Pick<AgentMigrationRow, "transferDeadlineAt" | "arrivalDeadlineAt">): number {
  return positiveDeadlineMs(row.arrivalDeadlineAt.getTime() - row.transferDeadlineAt.getTime());
}

function isActiveState(state: AgentMigrationState): state is ActiveAgentMigrationState {
  return (ACTIVE_AGENT_MIGRATION_STATES as readonly string[]).includes(state);
}

function isTransferActiveState(
  state: AgentMigrationState,
): state is typeof TRANSFER_ACTIVE_AGENT_MIGRATION_STATES[number] {
  return (TRANSFER_ACTIVE_AGENT_MIGRATION_STATES as readonly string[]).includes(state);
}

export function agentMigrationGeneration(row: Pick<AgentMigrationRow, "id" | "revision">): string {
  return `agent_migration:${row.id}:${row.revision}`;
}

export async function provisionAgentMigrationObjectStoreTransfer(input: {
  sessionId?: string;
  leaseMs?: number;
  maxBytes?: number;
  storage?: StorageBackend | null;
} = {}): Promise<AgentMigrationObjectStoreTransferProvision> {
  const storage = input.storage ?? getStorage();
  if (!storage?.getPresignedPutUrl || !storage.getPresignedUrl) {
    throw new Error("MIGRATION_TRANSPORT_PROVISION_FAILED");
  }
  const sessionId = input.sessionId ?? randomUUID();
  const leaseMs = input.leaseMs ?? DEFAULT_AGENT_MIGRATION_TRANSPORT_LEASE_MS;
  const maxBytes = input.maxBytes ?? DEFAULT_AGENT_MIGRATION_TRANSPORT_MAX_BYTES;
  // Chunks are presigned per transfer; this only checks the backend can presign.
  return { provider: "object_store", sessionId, leaseMs, maxBytes };
}

export function evaluateAgentMigrationTransferLeaseReady(input: {
  migration: Pick<
    AgentMigrationRow,
    "id" | "revision" | "transportSessionId" | "transportLeaseSource" | "transportMaxBytes"
  >;
  lease: AgentMigrationTransferLeaseState | null | undefined;
  role: "source" | "target";
  now?: Date;
}): AgentMigrationTransferLeaseReadyVerdict {
  const { migration, lease, role } = input;
  if (!lease) return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "missing" };
  if (lease.provider !== "object_store") {
    return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "provider_mismatch" };
  }
  if (lease.role !== role) {
    return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "role_mismatch" };
  }
  if (lease.transferKind !== transferKindForRole(role)) {
    return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "transfer_kind_mismatch" };
  }
  if (lease.leaseSource !== "server" || migration.transportLeaseSource !== "server") {
    return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "lease_source_mismatch" };
  }
  if (lease.migrationId !== migration.id) {
    return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "migration_mismatch" };
  }
  if (lease.migrationGeneration !== agentMigrationGeneration(migration)) {
    return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "generation_mismatch" };
  }
  if (!migration.transportSessionId || lease.sessionId !== migration.transportSessionId) {
    return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "session_mismatch" };
  }
  const expiresAtMs = parseLeaseExpiry(lease.expiresAt);
  if (expiresAtMs === null) {
    return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "expires_at_invalid" };
  }
  if ((input.now ?? currentDate()).getTime() >= expiresAtMs) {
    return { ready: false, code: "MIGRATION_TRANSPORT_LOST", reason: "expired" };
  }
  if (!Number.isFinite(lease.maxBytes ?? NaN) || (lease.maxBytes ?? 0) <= 0) {
    return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "max_bytes_invalid" };
  }
  if (migration.transportMaxBytes && (lease.maxBytes ?? 0) > migration.transportMaxBytes) {
    return { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "max_bytes_exceeds_grant" };
  }
  return { ready: true };
}

export async function recordAgentMigrationSourceQuiesced(input: {
  migrationId: string;
  serverId: string;
  sourceMachineId: string;
  transportToken: string;
  receipt: AgentMigrationSourceQuiesceReceipt;
  now?: Date;
}): Promise<AgentMigrationRow> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations)
      .where(eq(agentMigrations.id, input.migrationId))
      .limit(1)
      .for("update");
    assertResumableMigrationActor(row, {
      serverId: input.serverId,
      machineId: input.sourceMachineId,
      role: "source",
      transportToken: input.transportToken,
    });
    if (!row.transportGeneration || !row.transportLeaseId) {
      throw new Error("MIGRATION_RESUMABLE_PROTOCOL_REQUIRED");
    }
    const receipt = input.receipt;
    if (
      receipt.schemaVersion !== "agent-migration-quiesce/v1"
      || receipt.migrationId !== row.id
      || receipt.migrationGeneration !== row.transportGeneration
      || receipt.agentId !== row.agentId
      || receipt.sourceMachineId !== row.sourceMachineId
      || receipt.sourceRuntimeState !== "stopped"
      || receipt.actor !== "migration"
      || !receipt.launchSessionIdentity
      || receipt.expectedRuntimeRevision !== String(row.transportExpectedMigrationRevision)
      || !Number.isFinite(Date.parse(receipt.stoppedAt))
    ) {
      throw new Error("MIGRATION_SOURCE_QUIESCE_RECEIPT_INVALID");
    }
    if (row.sourceQuiesceReceipt) {
      if (canonicalJson(row.sourceQuiesceReceipt) !== canonicalJson(receipt)) {
        throw new Error("MIGRATION_SOURCE_QUIESCE_RECEIPT_CONFLICT");
      }
      return row;
    }
    const [updated] = await tx.update(agentMigrations)
      .set({
        sourceQuiesceReceipt: receipt,
        sourceQuiescedAt: now,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(and(eq(agentMigrations.id, row.id), eq(agentMigrations.revision, row.revision)))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    return await extendDeadlinesOnProgress(tx, updated, now, SOURCE_BUNDLE_BUILD_WINDOW_MS);
  });
}

/**
 * Bundle-build progress from the source between quiesce and control
 * registration. Only a report that moved forward (a later phase, or more files
 * or bytes in the same phase) is stored and slides the prep deadline by one
 * idle window; a repeated or stale report is accepted but changes nothing, so a
 * daemon stuck in a loop that keeps reporting still times out. Outside that
 * window (not yet quiesced, already registered, or terminal) reports are
 * ignored. Does not bump `revision`.
 */
export async function recordAgentMigrationSourceBuildProgress(input: {
  migrationId: string;
  serverId: string;
  sourceMachineId: string;
  transportToken: string;
  report: unknown;
  now?: Date;
}): Promise<{ migration: AgentMigrationRow; advanced: boolean }> {
  const parsed = agentMigrationSourceBuildProgressReportSchema.safeParse(input.report);
  if (!parsed.success) throw new Error("MIGRATION_SOURCE_PROGRESS_INVALID");
  const report = parsed.data;
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations)
      .where(eq(agentMigrations.id, input.migrationId))
      .limit(1)
      .for("update");
    assertResumableMigrationActor(row, {
      serverId: input.serverId,
      machineId: input.sourceMachineId,
      role: "source",
      transportToken: input.transportToken,
    });
    if (report.migrationGeneration !== row.transportGeneration) {
      throw new Error("MIGRATION_GENERATION_STALE");
    }
    if (
      (row.state !== "provisioning" && row.state !== "prep")
      || !row.sourceQuiescedAt
      || row.transportControlRegisteredAt
    ) {
      return { migration: row, advanced: false };
    }
    if (!sourceBuildProgressAdvanced(row.sourceBuildProgress, report)) {
      return { migration: row, advanced: false };
    }
    const [updated] = await tx.update(agentMigrations)
      .set({
        sourceBuildProgress: {
          phase: report.phase,
          files: report.files,
          bytes: report.bytes,
          reportedAt: now.toISOString(),
        },
      })
      .where(eq(agentMigrations.id, row.id))
      .returning();
    return { migration: await extendDeadlinesOnProgress(tx, updated, now), advanced: true };
  });
}

function sourceBuildProgressAdvanced(
  previous: AgentMigrationRow["sourceBuildProgress"],
  report: { phase: (typeof AGENT_MIGRATION_SOURCE_BUILD_PHASES)[number]; files: number; bytes: number },
): boolean {
  if (!previous) return true;
  const previousPhase = AGENT_MIGRATION_SOURCE_BUILD_PHASES.indexOf(previous.phase);
  const reportPhase = AGENT_MIGRATION_SOURCE_BUILD_PHASES.indexOf(report.phase);
  if (reportPhase !== previousPhase) return reportPhase > previousPhase;
  return report.files > previous.files || report.bytes > previous.bytes;
}

export async function registerAgentMigrationControlManifest(input: {
  migrationId: string;
  serverId: string;
  sourceMachineId: string;
  transportToken: string;
  control: AgentMigrationControlManifest;
  now?: Date;
}): Promise<{ migration: AgentMigrationRow; controlSha256: string; missingChunkIndexes: number[] }> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations)
      .where(eq(agentMigrations.id, input.migrationId))
      .limit(1)
      .for("update");
    assertResumableMigrationActor(row, {
      serverId: input.serverId,
      machineId: input.sourceMachineId,
      role: "source",
      transportToken: input.transportToken,
    });
    if (!row.sourceQuiesceReceipt || !row.sourceQuiescedAt) {
      throw new Error("MIGRATION_SOURCE_NOT_QUIESCED");
    }
    const validation = validateControlManifestForMigration(input.control, row);
    if (row.transportControlSha256 && row.transportControlSha256 !== validation.sha256) {
      throw new Error("MIGRATION_CONTROL_MANIFEST_CONFLICT");
    }
    let migration = row;
    if (!row.transportControlSha256) {
      const [updated] = await tx.update(agentMigrations)
        .set({
          transportControlManifest: input.control,
          transportControlSha256: validation.sha256,
          transportControlRegisteredAt: now,
          revision: row.revision + 1,
          updatedAt: now,
        })
        .where(and(eq(agentMigrations.id, row.id), eq(agentMigrations.revision, row.revision)))
        .returning();
      if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
      migration = updated;
      await tx.insert(agentMigrationChunkReceipts)
        .values(input.control.bundle.chunks.map((chunk) => ({
          migrationId: row.id,
          transportGeneration: input.control.identity.migrationGeneration,
          leaseId: input.control.identity.leaseId,
          chunkIndex: chunk.index,
          sizeBytes: chunk.sizeBytes,
          sha256: chunk.sha256,
          createdAt: now,
          updatedAt: now,
        })))
        .onConflictDoNothing();
      // Bundling the whole workspace is the slowest source step; count it as progress.
      await extendDeadlinesOnProgress(tx, updated, now);
    }
    const receipts = await tx.select().from(agentMigrationChunkReceipts)
      .where(and(
        eq(agentMigrationChunkReceipts.migrationId, row.id),
        eq(agentMigrationChunkReceipts.transportGeneration, input.control.identity.migrationGeneration),
      ))
      .orderBy(asc(agentMigrationChunkReceipts.chunkIndex));
    assertChunkRowsMatchControl(receipts, input.control);
    return {
      migration,
      controlSha256: validation.sha256,
      missingChunkIndexes: receipts.filter((receipt) => !receipt.sourceReceiptAt).map((receipt) => receipt.chunkIndex),
    };
  });
}

export async function getAgentMigrationResumableControl(input: {
  migrationId: string;
  serverId: string;
  machineId: string;
  role: "source" | "target";
  transportToken: string;
}): Promise<{ control: AgentMigrationControlManifest; controlSha256: string; uploadComplete: boolean }> {
  const db = getDb();
  const [row] = await db.select().from(agentMigrations)
    .where(eq(agentMigrations.id, input.migrationId))
    .limit(1);
  assertResumableMigrationActor(row, input);
  if (!row.transportControlManifest || !row.transportControlSha256) {
    throw new Error("MIGRATION_CONTROL_MANIFEST_MISSING");
  }
  validateControlManifestForMigration(row.transportControlManifest, row);
  return {
    control: row.transportControlManifest,
    controlSha256: row.transportControlSha256,
    uploadComplete: Boolean(row.transportUploadCompletedAt),
  };
}

export async function planAgentMigrationChunkTransfers(input: {
  migrationId: string;
  serverId: string;
  machineId: string;
  role: "source" | "target";
  transportToken: string;
  cursor?: number;
  storage?: StorageBackend | null;
}): Promise<AgentMigrationChunkTransferPlan> {
  const db = getDb();
  const [row] = await db.select().from(agentMigrations)
    .where(eq(agentMigrations.id, input.migrationId))
    .limit(1);
  assertResumableMigrationActor(row, input);
  if (
    !row.transportControlManifest
    || !row.transportControlSha256
    || !row.transportGeneration
    || !row.transportLeaseId
    || !row.transportSessionId
    || !row.transportExpiresAt
  ) {
    throw new Error("MIGRATION_CONTROL_MANIFEST_MISSING");
  }
  if (input.role === "target" && !row.transportUploadCompletedAt) {
    throw new Error("MIGRATION_NOT_READY");
  }
  if (currentDate().getTime() >= row.transportExpiresAt.getTime()) {
    throw new Error("MIGRATION_LEASE_EXPIRED");
  }
  const storage = input.storage ?? getStorage();
  if (!storage?.getPresignedPutUrl || !storage.getPresignedUrl) {
    throw new Error("MIGRATION_TRANSPORT_PROVISION_FAILED");
  }
  const receipts = await db.select().from(agentMigrationChunkReceipts)
    .where(and(
      eq(agentMigrationChunkReceipts.migrationId, row.id),
      eq(agentMigrationChunkReceipts.transportGeneration, row.transportGeneration),
    ))
    .orderBy(asc(agentMigrationChunkReceipts.chunkIndex));
  assertChunkRowsMatchControl(receipts, row.transportControlManifest);
  const cursor = Number.isSafeInteger(input.cursor) && (input.cursor ?? 0) >= 0 ? input.cursor ?? 0 : 0;
  const candidates = receipts.filter((receipt) =>
    receipt.chunkIndex >= cursor
    && (input.role === "source"
      ? receipt.sourceReceiptAt === null
      : receipt.sourceReceiptAt !== null && receipt.targetReceiptAt === null));
  const batch = candidates.slice(0, AGENT_MIGRATION_CHUNK_URL_BATCH_LIMIT);
  const expiresIn = storagePresignExpiresInSeconds(
    Math.max(1_000, row.transportExpiresAt.getTime() - currentDate().getTime()),
  );
  const chunks = await Promise.all(batch.map(async (receipt) => ({
    index: receipt.chunkIndex,
    sizeBytes: receipt.sizeBytes,
    sha256: receipt.sha256,
    method: input.role === "source" ? "PUT" as const : "GET" as const,
    url: input.role === "source"
      ? await storage.getPresignedPutUrl!(
          resumableChunkStorageKey(row.transportSessionId!, row.transportGeneration!, receipt.chunkIndex),
          { expiresIn, contentType: "application/octet-stream" },
        )
      : await storage.getPresignedUrl!(
          resumableChunkStorageKey(row.transportSessionId!, row.transportGeneration!, receipt.chunkIndex),
          { expiresIn, responseContentType: "application/octet-stream" },
        ),
  })));
  const nextCandidate = candidates[batch.length];
  return {
    migrationId: row.id,
    migrationGeneration: row.transportGeneration,
    leaseId: row.transportLeaseId,
    controlSha256: row.transportControlSha256,
    chunks,
    nextCursor: nextCandidate?.chunkIndex ?? null,
    complete: candidates.length === 0,
  };
}

/**
 * Streamed bundles: the source uploads each chunk as soon as it is packed,
 * before the control manifest (which needs the whole bundle) exists. This
 * records the chunk's size and digest as its receipt row and returns an upload
 * URL; the source then reports the receipt and registers the control as usual,
 * which must match these rows exactly. A chunk already recorded with the same
 * digest is reused; a different digest for the same index is refused.
 */
export async function prepareAgentMigrationStreamedChunk(input: {
  migrationId: string;
  serverId: string;
  sourceMachineId: string;
  transportToken: string;
  migrationGeneration: string;
  leaseId: string;
  chunkIndex: number;
  sizeBytes: number;
  sha256: string;
  now?: Date;
  storage?: StorageBackend | null;
}): Promise<{ uploaded: boolean; url: string | null }> {
  if (
    !Number.isSafeInteger(input.chunkIndex)
    || input.chunkIndex < 0
    || input.chunkIndex >= AGENT_MIGRATION_MAX_CHUNKS
    || !Number.isSafeInteger(input.sizeBytes)
    || input.sizeBytes <= 0
    // Streaming sources cut fixed default-size chunks; the chunk-count cap bounds the total.
    || input.sizeBytes > AGENT_MIGRATION_DEFAULT_CHUNK_BYTES
    || !/^[0-9a-f]{64}$/.test(input.sha256)
  ) {
    throw new Error("MIGRATION_STREAMED_CHUNK_INVALID");
  }
  const storage = input.storage ?? getStorage();
  if (!storage?.getPresignedPutUrl) {
    throw new Error("MIGRATION_TRANSPORT_PROVISION_FAILED");
  }
  const db = getDb();
  const now = input.now ?? currentDate();
  const { row, receipt } = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations)
      .where(eq(agentMigrations.id, input.migrationId))
      .limit(1)
      .for("update");
    assertResumableMigrationActor(row, {
      serverId: input.serverId,
      machineId: input.sourceMachineId,
      role: "source",
      transportToken: input.transportToken,
    });
    if (
      input.migrationGeneration !== row.transportGeneration
      || input.leaseId !== row.transportLeaseId
    ) {
      throw new Error("MIGRATION_GENERATION_STALE");
    }
    if (!row.transportSessionId) throw new Error("MIGRATION_RESUMABLE_PROTOCOL_REQUIRED");
    if (!row.sourceQuiesceReceipt || !row.sourceQuiescedAt) {
      throw new Error("MIGRATION_SOURCE_NOT_QUIESCED");
    }
    // Once the control is registered its chunk set is fixed.
    if (!row.transportControlSha256) {
      await tx.insert(agentMigrationChunkReceipts)
        .values({
          migrationId: row.id,
          transportGeneration: input.migrationGeneration,
          leaseId: input.leaseId,
          chunkIndex: input.chunkIndex,
          sizeBytes: input.sizeBytes,
          sha256: input.sha256,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }
    const [receipt] = await tx.select().from(agentMigrationChunkReceipts)
      .where(and(
        eq(agentMigrationChunkReceipts.migrationId, row.id),
        eq(agentMigrationChunkReceipts.transportGeneration, input.migrationGeneration),
        eq(agentMigrationChunkReceipts.chunkIndex, input.chunkIndex),
      ))
      .limit(1);
    if (
      !receipt
      || receipt.leaseId !== input.leaseId
      || receipt.sizeBytes !== input.sizeBytes
      || receipt.sha256 !== input.sha256
    ) {
      throw new Error("MIGRATION_CHUNK_RECEIPT_MISMATCH");
    }
    return { row, receipt };
  });
  if (receipt.sourceReceiptAt) return { uploaded: true, url: null };
  const expiresIn = storagePresignExpiresInSeconds(
    Math.max(1_000, row.transportExpiresAt!.getTime() - currentDate().getTime()),
  );
  return {
    uploaded: false,
    url: await storage.getPresignedPutUrl(
      resumableChunkStorageKey(row.transportSessionId!, row.transportGeneration!, input.chunkIndex),
      { expiresIn, contentType: "application/octet-stream" },
    ),
  };
}

/**
 * The prep window used to be a fixed 10 minutes from creation, covering stop,
 * bundle, and the whole chunked upload; large workspaces or slow links hit it
 * while still making progress (prod: most September failures). Each unit of
 * source progress (control registered, a new chunk receipt) now slides the
 * window forward by the default prep idle time, never past the transfer
 * deadline. The source quiesce slides it by the longer bundle-build window.
 *
 * The transfer deadline (a fixed hour from creation) slides the same way on
 * source or target progress, by one transfer idle window, with the arrival
 * deadline keeping its distance; neither goes past
 * AGENT_MIGRATION_MAX_DURATION_MS after creation, so a migration that keeps
 * creeping forward still cannot keep the agent stopped for a day. A stalled
 * migration still aborts after one idle window. Does not bump `revision`: it
 * changes no state and must not race the step writers.
 */
async function extendDeadlinesOnProgress(
  tx: DatabaseExecutor,
  row: AgentMigrationRow,
  now: Date,
  prepWindowMs: number = DEFAULT_PREP_DEADLINE_MS,
): Promise<AgentMigrationRow> {
  if (!(PROGRESS_DEADLINE_STATES as readonly string[]).includes(row.state)) return row;
  // Provisioning starts in the same write that creates the migration.
  const startedAt = row.transportProvisioningStartedAt ?? row.createdAt;
  const hardCapMs = startedAt.getTime() + AGENT_MIGRATION_MAX_DURATION_MS;
  const transferMs = Math.max(
    row.transferDeadlineAt.getTime(),
    Math.min(now.getTime() + TRANSFER_IDLE_WINDOW_MS, hardCapMs),
  );
  const prepMs = row.state === "provisioning" || row.state === "prep"
    ? Math.max(row.prepDeadlineAt.getTime(), Math.min(now.getTime() + prepWindowMs, transferMs))
    : row.prepDeadlineAt.getTime();
  if (transferMs === row.transferDeadlineAt.getTime() && prepMs === row.prepDeadlineAt.getTime()) return row;
  // GREATEST: a concurrent writer holding older values can only move a deadline later.
  const later = (column: AnyPgColumn, ms: number) =>
    sql`GREATEST(${column}, ${new Date(ms).toISOString()}::timestamptz)`;
  const [extended] = await tx.update(agentMigrations)
    .set({
      prepDeadlineAt: later(agentMigrations.prepDeadlineAt, prepMs),
      transferDeadlineAt: later(agentMigrations.transferDeadlineAt, transferMs),
      arrivalDeadlineAt: later(agentMigrations.arrivalDeadlineAt, transferMs + arrivalWindowMs(row)),
    })
    .where(and(eq(agentMigrations.id, row.id), eq(agentMigrations.state, row.state)))
    .returning();
  return extended ?? row;
}

export async function recordAgentMigrationChunkReceipt(input: {
  migrationId: string;
  serverId: string;
  machineId: string;
  role: "source" | "target";
  transportToken: string;
  migrationGeneration: string;
  leaseId: string;
  chunkIndex: number;
  sizeBytes: number;
  sha256: string;
  etag?: string | null;
  now?: Date;
}): Promise<{ outcome: "recorded" | "reused" }> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations)
      .where(eq(agentMigrations.id, input.migrationId))
      .limit(1)
      .for("update");
    assertResumableMigrationActor(row, input);
    if (
      input.migrationGeneration !== row.transportGeneration
      || input.leaseId !== row.transportLeaseId
    ) {
      throw new Error("MIGRATION_GENERATION_STALE");
    }
    const [receipt] = await tx.select().from(agentMigrationChunkReceipts)
      .where(and(
        eq(agentMigrationChunkReceipts.migrationId, row.id),
        eq(agentMigrationChunkReceipts.transportGeneration, input.migrationGeneration),
        eq(agentMigrationChunkReceipts.chunkIndex, input.chunkIndex),
      ))
      .limit(1)
      .for("update");
    if (
      !receipt
      || receipt.leaseId !== input.leaseId
      || receipt.sizeBytes !== input.sizeBytes
      || receipt.sha256 !== input.sha256
    ) {
      throw new Error("MIGRATION_CHUNK_RECEIPT_MISMATCH");
    }
    const alreadyRecorded = input.role === "source"
      ? receipt.sourceReceiptAt !== null
      : receipt.targetReceiptAt !== null;
    if (alreadyRecorded) return { outcome: "reused" };
    await tx.update(agentMigrationChunkReceipts)
      .set(input.role === "source"
        ? { sourceEtag: input.etag ?? null, sourceReceiptAt: now, updatedAt: now }
        : { targetReceiptAt: now, updatedAt: now })
      .where(and(
        eq(agentMigrationChunkReceipts.migrationId, row.id),
        eq(agentMigrationChunkReceipts.transportGeneration, input.migrationGeneration),
        eq(agentMigrationChunkReceipts.chunkIndex, input.chunkIndex),
      ));
    await extendDeadlinesOnProgress(tx, row, now);
    return { outcome: "recorded" };
  });
}

export async function completeAgentMigrationResumableUpload(input: {
  migrationId: string;
  serverId: string;
  sourceMachineId: string;
  transportToken: string;
  migrationGeneration: string;
  leaseId: string;
  controlSha256: string;
  now?: Date;
}): Promise<AgentMigrationRow> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations)
      .where(eq(agentMigrations.id, input.migrationId))
      .limit(1)
      .for("update");
    assertResumableMigrationActor(row, {
      serverId: input.serverId,
      machineId: input.sourceMachineId,
      role: "source",
      transportToken: input.transportToken,
    });
    if (
      row.transportGeneration !== input.migrationGeneration
      || row.transportLeaseId !== input.leaseId
      || row.transportControlSha256 !== input.controlSha256
      || !row.transportControlManifest
    ) {
      throw new Error("MIGRATION_GENERATION_STALE");
    }
    const validation = validateControlManifestForMigration(row.transportControlManifest, row);
    if (validation.sha256 !== row.transportControlSha256) {
      throw new Error("MIGRATION_CONTROL_MANIFEST_INVALID");
    }
    if (row.transferSummary && !isDeepStrictEqual(row.transferSummary, validation.transferSummary)) {
      throw new Error("MIGRATION_TRANSFER_SUMMARY_CONFLICT");
    }
    const receipts = await tx.select().from(agentMigrationChunkReceipts)
      .where(and(
        eq(agentMigrationChunkReceipts.migrationId, row.id),
        eq(agentMigrationChunkReceipts.transportGeneration, input.migrationGeneration),
      ))
      .orderBy(asc(agentMigrationChunkReceipts.chunkIndex));
    assertChunkRowsMatchControl(receipts, row.transportControlManifest);
    if (receipts.some((receipt) => !receipt.sourceReceiptAt)) {
      throw new Error("MIGRATION_CHUNKS_MISSING");
    }
    if (row.transportUploadCompletedAt && row.state === "ready") return row;
    if (row.state !== "provisioning" && row.state !== "prep") {
      throw new Error("MIGRATION_NOT_IN_PREP");
    }
    const [updated] = await tx.update(agentMigrations)
      .set({
        state: "ready",
        manifestPath: `object-store:${row.transportSessionId}/control.json`,
        manifestSha256: input.controlSha256,
        transferSummary: validation.transferSummary,
        transportProvisionedAt: row.transportProvisionedAt ?? now,
        transportUploadCompletedAt: now,
        transportErrorCode: null,
        transportErrorMessage: null,
        readyAt: now,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(and(eq(agentMigrations.id, row.id), eq(agentMigrations.revision, row.revision)))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    return updated;
  });
}

function assertResumableMigrationActor(
  row: AgentMigrationRow | undefined,
  input: {
    serverId: string;
    machineId: string;
    role: "source" | "target";
    transportToken: string;
  },
): asserts row is AgentMigrationRow {
  if (
    !row
    || row.serverId !== input.serverId
    || (input.role === "source" ? row.sourceMachineId : row.targetMachineId) !== input.machineId
  ) {
    throw new Error("MIGRATION_NOT_FOUND");
  }
  if (!isTransferActiveState(row.state)) throw new Error("MIGRATION_NOT_ACTIVE");
  if (
    row.transportProtocol !== AGENT_MIGRATION_RESUMABLE_PROTOCOL
    || !row.transportGeneration
    || !row.transportLeaseId
    || row.transportExpectedMigrationRevision === null
  ) {
    throw new Error("MIGRATION_RESUMABLE_PROTOCOL_REQUIRED");
  }
  const expectedHash = input.role === "source"
    ? row.sourceTransportTokenHash
    : row.targetTransportTokenHash;
  if (!expectedHash || !safeHashEquals(expectedHash, sha256(input.transportToken))) {
    throw new Error("MIGRATION_TRANSPORT_TOKEN_INVALID");
  }
  if (!row.transportExpiresAt || currentDate().getTime() >= row.transportExpiresAt.getTime()) {
    throw new Error("MIGRATION_LEASE_EXPIRED");
  }
}

function validateControlManifestForMigration(
  control: AgentMigrationControlManifest,
  row: AgentMigrationRow,
): { sha256: string; bytes: number; transferSummary: AgentMigrationTransferSummary } {
  if (
    !control
    || typeof control !== "object"
    || control.schemaVersion !== AGENT_MIGRATION_CONTROL_SCHEMA_VERSION
    || control.protocol !== AGENT_MIGRATION_RESUMABLE_PROTOCOL
    || !control.identity
    || !control.capability
    || !Array.isArray(control.capability.required)
    || !control.bundle
    || !Array.isArray(control.bundle.chunks)
    || !control.archive
    || !Array.isArray(control.archive.allowedEntryTypes)
    || !control.commit
    || control.identity.migrationId !== row.id
    || control.identity.migrationGeneration !== row.transportGeneration
    || control.identity.leaseId !== row.transportLeaseId
    || control.identity.agentId !== row.agentId
    || control.identity.sourceMachineId !== row.sourceMachineId
    || control.identity.targetMachineId !== row.targetMachineId
    || control.bundle.contentType !== AGENT_MIGRATION_BUNDLE_CONTENT_TYPE
    || !Number.isSafeInteger(control.bundle.totalBytes)
    || control.bundle.totalBytes <= 0
    || control.bundle.totalBytes > (row.transportMaxBytes ?? 0)
    || !/^[0-9a-f]{64}$/.test(control.bundle.sha256)
    || !Number.isSafeInteger(control.bundle.chunkSizeBytes)
    || control.bundle.chunkSizeBytes < AGENT_MIGRATION_MIN_CHUNK_BYTES
    || control.bundle.chunks.length === 0
    || control.bundle.chunks.length > AGENT_MIGRATION_MAX_CHUNKS
    || !Array.isArray(control.capability?.required)
    || control.capability.required.length !== 1
    || control.capability.required[0] !== AGENT_MIGRATION_CAPABILITY
    || control.archive.format !== "tar+gzip"
    || control.archive.allowedEntryTypes.length !== 2
    || control.archive.allowedEntryTypes[0] !== "file"
    || control.archive.allowedEntryTypes[1] !== "symlink"
    || !Number.isSafeInteger(control.archive.entryCount)
    || control.archive.entryCount < 0
    || control.archive.entryCount > AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES
    || !Number.isSafeInteger(control.archive.expandedBytes)
    || control.archive.expandedBytes < 0
    || !Number.isSafeInteger(control.archive.maxEntryBytes)
    || control.archive.maxEntryBytes < 0
    || control.archive.maxEntryBytes > control.archive.expandedBytes
    || control.commit.mode !== "atomic-rename"
    || control.commit.markerPath !== AGENT_MIGRATION_COMMIT_MARKER_PATH
    || control.commit.requireWholeBundleDigest !== true
    || control.commit.requireAllChunkDigests !== true
    || control.commit.existingWorkspace !== "idle-or-same-commit"
  ) {
    throw new Error("MIGRATION_CONTROL_MANIFEST_INVALID");
  }
  let offsetBytes = 0;
  for (let index = 0; index < control.bundle.chunks.length; index += 1) {
    const chunk = control.bundle.chunks[index];
    if (
      chunk.index !== index
      || chunk.offsetBytes !== offsetBytes
      || !Number.isSafeInteger(chunk.sizeBytes)
      || chunk.sizeBytes <= 0
      || chunk.sizeBytes > control.bundle.chunkSizeBytes
      || !/^[0-9a-f]{64}$/.test(chunk.sha256)
    ) {
      throw new Error("MIGRATION_CONTROL_MANIFEST_INVALID");
    }
    offsetBytes += chunk.sizeBytes;
  }
  if (offsetBytes !== control.bundle.totalBytes) {
    throw new Error("MIGRATION_CONTROL_MANIFEST_INVALID");
  }
  const transferSummary = agentMigrationTransferSummarySchema.safeParse(control.transferSummary);
  if (
    !transferSummary.success
    || transferSummary.data.includedFileCount !== control.archive.entryCount
    || transferSummary.data.includedBytes !== control.archive.expandedBytes
  ) {
    throw new Error("MIGRATION_CONTROL_MANIFEST_INVALID");
  }
  const payload = Buffer.from(canonicalJson(control), "utf8");
  if (payload.byteLength > AGENT_MIGRATION_MAX_CONTROL_MANIFEST_BYTES) {
    throw new Error("MIGRATION_CONTROL_MANIFEST_TOO_LARGE");
  }
  return {
    sha256: createHash("sha256").update(payload).digest("hex"),
    bytes: payload.byteLength,
    transferSummary: transferSummary.data,
  };
}

function assertChunkRowsMatchControl(
  receipts: Array<typeof agentMigrationChunkReceipts.$inferSelect>,
  control: AgentMigrationControlManifest,
): void {
  if (receipts.length !== control.bundle.chunks.length) {
    throw new Error("MIGRATION_CHUNK_RECEIPT_SET_MISMATCH");
  }
  for (const expected of control.bundle.chunks) {
    const receipt = receipts[expected.index];
    if (
      !receipt
      || receipt.chunkIndex !== expected.index
      || receipt.sizeBytes !== expected.sizeBytes
      || receipt.sha256 !== expected.sha256
      || receipt.leaseId !== control.identity.leaseId
      || receipt.transportGeneration !== control.identity.migrationGeneration
    ) {
      throw new Error("MIGRATION_CHUNK_RECEIPT_SET_MISMATCH");
    }
  }
}

function resumableChunkStorageKey(sessionId: string, generation: string, chunkIndex: number): string {
  const safeGeneration = createHash("sha256").update(generation).digest("hex").slice(0, 24);
  return `agent-migrations/${sessionId}/resumable/${safeGeneration}/chunks/${chunkIndex}`;
}

function safeHashEquals(leftHex: string, rightHex: string): boolean {
  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = sortJsonValue((value as Record<string, unknown>)[key]);
      return result;
    }, {});
}

function targetImportView(row: AgentMigrationRow): AgentMigrationTargetImportView {
  return {
    migrationId: row.id,
    migrationRef: row.supportRef,
    migrationGeneration: agentMigrationGeneration(row),
    state: row.state,
    sourceMachineId: row.sourceMachineId,
    targetMachineId: row.targetMachineId,
    agentId: row.agentId,
    manifestPath: row.manifestPath,
    manifestSha256: row.manifestSha256,
    canDriveTargetImport: true,
  };
}

function assertTargetImportRow(input: {
  row: AgentMigrationRow | undefined;
  serverId: string;
  targetMachineId: string;
}): AgentMigrationRow {
  const { row, serverId, targetMachineId } = input;
  if (!row || row.serverId !== serverId || row.targetMachineId !== targetMachineId) {
    throw new Error("MIGRATION_NOT_FOUND");
  }
  return row;
}

function assertMigrationGeneration(row: AgentMigrationRow, migrationGeneration: string): void {
  if (!migrationGeneration || migrationGeneration !== agentMigrationGeneration(row)) {
    throw new Error("MIGRATION_GENERATION_STALE");
  }
}

async function agentHolderMachineId(
  executor: DatabaseExecutor,
  agentId: string,
): Promise<string | null> {
  const [row] = await executor.select({ machineId: agents.machineId })
    .from(agents)
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
    .limit(1);
  return row?.machineId ?? null;
}

async function isAgentHeldByTarget(executor: DatabaseExecutor, row: AgentMigrationRow): Promise<boolean> {
  return await agentHolderMachineId(executor, row.agentId) === row.targetMachineId;
}

async function finalizeAgentHolderProjection(
  executor: DatabaseExecutor,
  migration: AgentMigrationRow,
  now: Date,
): Promise<void> {
  const [updatedAgent] = await executor.update(agents)
    .set({
      machineId: migration.targetMachineId,
      sessionId: null,
      updatedAt: now,
    })
    .where(and(
      eq(agents.id, migration.agentId),
      eq(agents.machineId, migration.targetMachineId),
      isNull(agents.deletedAt),
    ))
    .returning({ id: agents.id });
  if (!updatedAgent) throw new Error("MIGRATION_SOURCE_MACHINE_MISMATCH");
}

async function finalizeRuntimeProfileProjection(
  executor: DatabaseExecutor,
  migration: AgentMigrationRow,
  now: Date,
): Promise<void> {
  const [profile] = await executor.select()
    .from(agentRuntimeProfiles)
    .where(eq(agentRuntimeProfiles.agentId, migration.agentId))
    .limit(1);
  if (!profile) return;
  const [updatedProfile] = await executor.update(agentRuntimeProfiles)
    .set({
      machineId: migration.targetMachineId,
      baselineMachineId: migration.targetMachineId,
      baselineRuntimeProfileFingerprint: profile.pendingAfterRuntimeProfileFingerprint ?? profile.runtimeProfileFingerprint,
      baselineRuntime: profile.pendingAfterRuntime ?? profile.runtime,
      baselineModel: profile.pendingAfterModel ?? profile.model,
      baselineReasoningEffort: profile.pendingAfterReasoningEffort ?? profile.reasoningEffort,
      baselineExecutionMode: profile.pendingAfterExecutionMode ?? profile.executionMode,
      baselineDaemonVersion: profile.pendingAfterDaemonVersion ?? profile.daemonVersion,
      sessionRefLabel: null,
      sessionRefPath: null,
      sessionRefMachineId: null,
      sessionRefRuntime: null,
      sessionRefReachable: null,
      sessionRefReason: null,
      migrationStatus: "stable",
      pendingKind: null,
      pendingKey: null,
      pendingBeforeRuntimeProfileFingerprint: null,
      pendingAfterRuntimeProfileFingerprint: null,
      pendingBeforeMachineId: null,
      pendingAfterMachineId: null,
      pendingBeforeRuntime: null,
      pendingAfterRuntime: null,
      pendingBeforeModel: null,
      pendingAfterModel: null,
      pendingBeforeReasoningEffort: null,
      pendingAfterReasoningEffort: null,
      pendingBeforeExecutionMode: null,
      pendingAfterExecutionMode: null,
      pendingBeforeDaemonVersion: null,
      pendingAfterDaemonVersion: null,
      pendingPreviousSessionLabel: null,
      pendingPreviousSessionPath: null,
      pendingPreviousSessionMachineId: null,
      pendingPreviousSessionRuntime: null,
      pendingPreviousSessionReachable: null,
      pendingPreviousSessionReason: null,
      pendingReleaseNotesUrl: null,
      migrationDeliveredAt: null,
      migrationDeliveredLaunchId: null,
      migratingSince: null,
      lastMigrationNudgeAt: null,
      migrationNudgeCount: 0,
      migrationHandledAt: now,
      migrationHandledLaunchId: null,
      revision: profile.revision + 1,
      updatedAt: now,
    })
    .where(and(
      eq(agentRuntimeProfiles.agentId, migration.agentId),
      eq(agentRuntimeProfiles.revision, profile.revision),
    ))
    .returning({ agentId: agentRuntimeProfiles.agentId });
  if (!updatedProfile) throw new Error("MIGRATION_CONCURRENT_UPDATE");
}

export function createAgentMigrationLifecycleEvent(input: {
  migration: AgentMigrationRow;
  occurredAt?: Date | string;
}): AgentLifecycleEvent {
  const { migration } = input;
  const eventType = "migration_aborted";
  return createAgentLifecycleEvent({
    serverId: migration.serverId,
    agentId: migration.agentId,
    machineId: migration.flippedAt ? migration.targetMachineId : migration.sourceMachineId,
    eventType,
    actor: "server",
    source: "server",
    reason: "migration_abort",
    correlationId: `agent_migration:${migration.supportRef}`,
    idempotencyKey: `agent_migration:${migration.supportRef}:${eventType}:${migration.revision}`,
    occurredAt: input.occurredAt,
    attrs: {
      migration_ref: migration.supportRef,
      migration_state: migration.state,
      source_machine_id: migration.sourceMachineId,
      target_machine_id: migration.targetMachineId,
    },
  });
}

function deadlineForState(row: Pick<AgentMigrationRow, "state" | "prepDeadlineAt" | "transferDeadlineAt" | "arrivalDeadlineAt">): {
  deadline: Date;
  reason: Extract<ZenMigratingDeliveryDecision, { action: "deadline-expired" }>["reason"];
} {
  if (row.state === "provisioning" || row.state === "prep") return { deadline: row.prepDeadlineAt, reason: "prep-deadline" };
  if (row.state === "arriving") {
    return { deadline: row.arrivalDeadlineAt, reason: "arrival-deadline" };
  }
  if (row.state === "starting") throw new Error("MIGRATION_STARTING_HAS_NO_DEADLINE");
  return { deadline: row.transferDeadlineAt, reason: "transfer-deadline" };
}

export function planZenMigratingDelivery(input: {
  migration: Pick<AgentMigrationRow, "state" | "prepDeadlineAt" | "transferDeadlineAt" | "arrivalDeadlineAt"> | null;
  now?: Date;
}): ZenMigratingDeliveryDecision {
  if (!input.migration || !isActiveState(input.migration.state)) {
    return { action: "deliver", reason: "no-active-migration" };
  }
  if (input.migration.state === "starting") {
    return { action: "deliver", reason: "target-starting" };
  }
  const now = input.now ?? currentDate();
  const { deadline, reason } = deadlineForState(input.migration);
  if (now.getTime() > deadline.getTime()) {
    return { action: "deadline-expired", reason };
  }
  return { action: "queue", reason: "zen-migrating" };
}

async function abortElapsedDeadlineMigration(
  migration: AgentMigrationRow,
  deadlineReason: Extract<ZenMigratingDeliveryDecision, { action: "deadline-expired" }>["reason"],
  now: Date,
  executor: DatabaseExecutor,
): Promise<AgentMigrationRow | null> {
  return await executor.transaction(async (tx) => {
    const aborted = await abortElapsedDeadlineMigrationRow(migration, deadlineReason, now, tx);
    if (!aborted) return null;
    // Tell the agent, best-effort: a missing receipt surface (legacy rows) must
    // never keep an expired migration active. The savepoint keeps a receipt
    // failure from rolling back the abort itself.
    try {
      await tx.transaction(async (savepoint) => {
        await enqueueAgentMigrationAbortedReceipt(savepoint, aborted, now);
      });
    } catch (error) {
      console.warn(`[AgentMigration] Aborted receipt skipped for ${aborted.id}:`, error instanceof Error ? error.message : error);
    }
    return aborted;
  });
}

/** The columns the deadline sweep writes when it aborts `migration`; reads project the same values without writing. */
function elapsedDeadlineAbortValues(
  migration: Pick<AgentMigrationRow, "revision">,
  deadlineReason: Extract<ZenMigratingDeliveryDecision, { action: "deadline-expired" }>["reason"],
  now: Date,
) {
  return {
    state: "aborted",
    abortReason: deadlineReason,
    abortedAt: now,
    transportTeardownAt: now,
    revision: migration.revision + 1,
    updatedAt: now,
  } as const satisfies Partial<AgentMigrationRow>;
}

async function abortElapsedDeadlineMigrationRow(
  migration: AgentMigrationRow,
  deadlineReason: Extract<ZenMigratingDeliveryDecision, { action: "deadline-expired" }>["reason"],
  now: Date,
  executor: DatabaseExecutor,
): Promise<AgentMigrationRow | null> {
  const [updated] = await executor.update(agentMigrations)
    .set(elapsedDeadlineAbortValues(migration, deadlineReason, now))
    .where(and(
      eq(agentMigrations.id, migration.id),
      eq(agentMigrations.revision, migration.revision),
      inArray(agentMigrations.state, [...TRANSFER_ACTIVE_AGENT_MIGRATION_STATES]),
    ))
    .returning();
  return updated ?? null;
}

/**
 * The only writer of deadline aborts. Reads (the delivery gate, the status API)
 * never write: they treat an expired row as not gating and report it as aborted
 * until this sweep persists the abort. The remediation worker calls this every
 * tick to abort one expired pre-start row. `starting` is excluded: it has no
 * deadline and is handled by auto-start remediation (see
 * AGENT_MIGRATION_ORPHANED_ARRIVAL_GRACE_MS).
 */
export async function sweepElapsedAgentMigrationDeadline(input: {
  now?: Date;
} = {}): Promise<AgentMigrationRow | null> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [candidate] = await tx.select()
      .from(agentMigrations)
      .where(or(
        and(
          inArray(agentMigrations.state, ["provisioning", "prep"]),
          lt(agentMigrations.prepDeadlineAt, now),
        ),
        and(
          inArray(agentMigrations.state, ["ready", "in_transit"]),
          lt(agentMigrations.transferDeadlineAt, now),
        ),
        and(
          eq(agentMigrations.state, "arriving"),
          lt(agentMigrations.arrivalDeadlineAt, now),
        ),
      ))
      .orderBy(asc(agentMigrations.updatedAt))
      .for("update", { skipLocked: true })
      .limit(1);
    if (!candidate) return null;
    const decision = planZenMigratingDelivery({ migration: candidate, now });
    if (decision.action !== "deadline-expired") return null;
    return await abortElapsedDeadlineMigration(candidate, decision.reason, now, tx);
  });
}

/**
 * The agent's non-terminal migration as of `now`, without writing. A row whose
 * deadline has elapsed is returned as the deadline sweep will persist it
 * (`aborted`), so readers see the same answer before and after the sweep runs.
 */
async function readActiveAgentMigration(
  db: DatabaseExecutor,
  agentId: string,
  now: Date,
): Promise<{ active: AgentMigrationRow | null; expired: AgentMigrationRow | null }> {
  const [row] = await db.select()
    .from(agentMigrations)
    .where(and(
      eq(agentMigrations.agentId, agentId),
      inArray(agentMigrations.state, [...ACTIVE_AGENT_MIGRATION_STATES]),
    ))
    .limit(1);
  if (!row) return { active: null, expired: null };
  const decision = planZenMigratingDelivery({ migration: row, now });
  if (decision.action === "deadline-expired") {
    return { active: null, expired: { ...row, ...elapsedDeadlineAbortValues(row, decision.reason, now) } };
  }
  return { active: row, expired: null };
}

/**
 * Delivery gate. Pure read: a migration past its deadline no longer gates, so
 * delivery proceeds to wherever the agent row points (the source before the
 * flip, the target after it) exactly as it would after the abort. The abort
 * itself is left to sweepElapsedAgentMigrationDeadline.
 */
export async function getAgentMigrationGateStatus(
  agentId: string,
  executor?: DatabaseExecutor,
  now: Date = currentDate(),
): Promise<AgentMigrationGateStatus> {
  if (!executor && !isDatabaseInitialized()) return { migration: null };
  const { active } = await readActiveAgentMigration(executor ?? getDb(), agentId, now);
  return { migration: active };
}

export async function getActiveAgentMigration(
  agentId: string,
  executor?: DatabaseExecutor,
  now: Date = currentDate(),
): Promise<AgentMigrationRow | null> {
  return (await getAgentMigrationGateStatus(agentId, executor, now)).migration;
}

export async function getLatestAgentMigration(
  agentId: string,
  executor?: DatabaseExecutor,
  now: Date = currentDate(),
): Promise<AgentMigrationRow | null> {
  const db = executor ?? getDb();
  const { active, expired } = await readActiveAgentMigration(db, agentId, now);
  if (active) return active;
  if (expired) return expired;
  const [row] = await db.select()
    .from(agentMigrations)
    .where(eq(agentMigrations.agentId, agentId))
    .orderBy(desc(agentMigrations.updatedAt), desc(agentMigrations.createdAt), desc(agentMigrations.id))
    .limit(1);
  return row ?? null;
}

/**
 * Task #93 line C lock acquisition for a human-initiated migration write, taken first in that write's transaction.
 *
 * Order, compatible with transitionMemberRole and owner promotion (`servers` FOR UPDATE, then member rows) and with the
 * migration writers in this file, which all write `agents` before `agent_migrations`:
 *   1. `servers` row FOR SHARE. Every migration write inserts rows whose foreign key references `servers`, which takes a
 *      key-share lock at insert time. Without this lock first, a role transition holding `servers` and waiting on the
 *      actor's member row deadlocks with this write holding that row and waiting on `servers`.
 *   2. The actor's `server_members` row FOR SHARE. A missing row throws ServerMembershipRevokedError before any write.
 *   3. The Agent row FOR UPDATE, then the capability-or-creator decision on the locked role and creator.
 * The caller's resource rows (`machines`, `agent_migrations`) come after.
 */
async function lockAgentMigrationActorAuthority(
  executor: DatabaseExecutor,
  agentId: string,
  fence: AgentMigrationActorFence,
): Promise<void> {
  await executor.execute(sql`
    SELECT id
    FROM servers
    WHERE id = ${fence.serverId}
    FOR SHARE
  `);
  const role = await lockActorMembershipRow(executor, fence.serverId, fence.userId, "share");
  const [agent] = await executor
    .select({ serverId: agents.serverId, creatorType: agents.creatorType, creatorId: agents.creatorId })
    .from(agents)
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
    .for("update");
  if (!agent || agent.serverId !== fence.serverId) throw new FencedAuthorizationDeniedError("not_found");
  if (!userCanActOnAgentResource(role, fence.userId, agent, fence.capability)) {
    throw new FencedAuthorizationDeniedError("forbidden");
  }
}

async function insertAgentMigration(
  input: BeginAgentMigrationInput,
  executor: DatabaseExecutor,
  supportRefFactory: () => string = createMigrationSupportRef,
): Promise<AgentMigrationRow> {
  if (input.actorFence) await lockAgentMigrationActorAuthority(executor, input.agentId, input.actorFence);
  const now = input.now ?? currentDate();
  const transferDeadlineAt = addMs(now, input.transferDeadlineMs ?? DEFAULT_TRANSFER_DEADLINE_MS);
  const deadlines: AgentMigrationDeadlines = {
    prepDeadlineAt: addMs(now, input.prepDeadlineMs ?? DEFAULT_PREP_DEADLINE_MS),
    transferDeadlineAt,
    arrivalDeadlineAt: addMs(transferDeadlineAt, input.arrivalDeadlineMs ?? DEFAULT_ARRIVAL_DEADLINE_MS),
  };

  const [agent] = await executor.select()
    .from(agents)
    .where(and(eq(agents.id, input.agentId), isNull(agents.deletedAt)))
    .limit(1);
  if (!agent) throw new Error("AGENT_NOT_FOUND");
  if (!agent.machineId) throw new Error("AGENT_HAS_NO_SOURCE_MACHINE");

  // Lock both machine rows in a stable order so migration creation serializes
  // with Computer deletion after terminal history becomes FK-independent.
  const migrationMachines = await executor.select()
    .from(machines)
    .where(and(
      eq(machines.serverId, agent.serverId),
      inArray(machines.id, [agent.machineId, input.targetMachineId]),
    ))
    .orderBy(asc(machines.id))
    .for("update");
  const sourceMachine = migrationMachines.find((machine) => machine.id === agent.machineId);
  const targetMachine = migrationMachines.find((machine) => machine.id === input.targetMachineId);
  if (!sourceMachine) throw new Error("AGENT_HAS_NO_SOURCE_MACHINE");
  if (!targetMachine || targetMachine.serverId !== agent.serverId) {
    throw new Error("TARGET_MACHINE_NOT_IN_AGENT_SERVER");
  }
  if (targetMachine.id === agent.machineId) {
    throw new Error("TARGET_MACHINE_MATCHES_SOURCE");
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [row] = await executor.insert(agentMigrations)
      .values({
        serverId: agent.serverId,
        agentId: agent.id,
        sourceMachineId: agent.machineId,
        targetMachineId: targetMachine.id,
        sourceMachineNameSnapshot: sourceMachine.name,
        targetMachineNameSnapshot: targetMachine.name,
        receiptChannelId: null,
        supportRef: supportRefFactory(),
        contractVersion: 2,
        // grant_key is NOT NULL UNIQUE but no longer read; the schema migration (phase C) drops it.
        grantKey: `agent_migration:${randomUUID()}`,
        initiatedByUserId: input.initiatedByUserId ?? null,
        prepDeadlineAt: deadlines.prepDeadlineAt,
        transferDeadlineAt: deadlines.transferDeadlineAt,
        arrivalDeadlineAt: deadlines.arrivalDeadlineAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: agentMigrations.supportRef })
      .returning();
    if (row) {
      const receiptChannelId = randomUUID();
      await executor.insert(channels).values({
        id: receiptChannelId,
        serverId: row.serverId,
        name: `migration-receipt-${row.supportRef}`,
        description: "Private migration completion receipt",
        type: "dm",
        createdAt: now,
      });
      // read-position: new conversation, no history before this join (no row = position 0)
      await executor.insert(channelAgents).values({
        channelId: receiptChannelId,
        agentId: row.agentId,
        addedAt: now,
      });
      const [withReceiptSurface] = await executor.update(agentMigrations)
        .set({ receiptChannelId })
        .where(and(
          eq(agentMigrations.id, row.id),
          isNull(agentMigrations.receiptChannelId),
        ))
        .returning();
      if (!withReceiptSurface) throw new Error("MIGRATION_RECEIPT_SURFACE_CREATE_FAILED");
      await executor.insert(agentMigrationReceiptChannels).values({
        channelId: receiptChannelId,
        migrationId: row.id,
        serverId: row.serverId,
        agentId: row.agentId,
        createdAt: now,
      });
      return withReceiptSurface;
    }
  }
  throw new Error("MIGRATION_SUPPORT_REF_COLLISION_RETRY_EXHAUSTED");
}

function buildTransportLeaseDelivery(input: {
  migration: AgentMigrationRow;
  role: "source" | "target";
  token: string;
}): AgentMigrationTransportLeaseDelivery {
  const { migration, role, token } = input;
  if (
    !migration.transportSessionId
    || !migration.transportExpiresAt
    || !migration.transportMaxBytes
    || !migration.transportGeneration
    || !migration.transportLeaseId
    || migration.transportExpectedMigrationRevision === null
  ) {
    throw new Error("MIGRATION_TRANSPORT_NOT_PROVISIONED");
  }
  return {
    machineId: role === "source" ? migration.sourceMachineId : migration.targetMachineId,
    role,
    message: {
      type: "machine:migration_transport:lease",
      agentId: migration.agentId,
      migrationId: migration.id,
      migrationRef: migration.supportRef,
      migrationGeneration: agentMigrationGeneration(migration),
      sessionId: migration.transportSessionId,
      role,
      provider: "object_store",
      transferKind: transferKindForRole(role),
      leaseSource: "server",
      bearerToken: token,
      expiresAt: migration.transportExpiresAt.toISOString(),
      maxBytes: migration.transportMaxBytes,
      controlUrl: `/internal/computer/agent-migrations/by-id/${encodeURIComponent(migration.id)}/resumable`,
      leaseId: migration.transportLeaseId,
      transportGeneration: migration.transportGeneration,
      sourceMachineId: migration.sourceMachineId,
      targetMachineId: migration.targetMachineId,
      expectedMigrationRevision: migration.transportExpectedMigrationRevision,
    },
  };
}

async function insertAgentMigrationProvisioning(
  input: BeginAgentMigrationProvisioningInput,
  executor: DatabaseExecutor,
): Promise<AgentMigrationProvisioningResult> {
  const now = input.now ?? currentDate();
  const transportSessionId = input.transportSessionId ?? randomUUID();
  const transportGeneration = `agent_migration_transport:${randomUUID()}`;
  const sourceToken = createTransportToken();
  const targetToken = createTransportToken();
  const row = await insertAgentMigration(input, executor);
  const [updated] = await executor.update(agentMigrations)
    .set({
      state: "provisioning",
      transportSessionId,
      transportProvider: input.transportProvider ?? "object_store",
      transportLeaseSource: "server",
      transportExpiresAt: addMs(now, input.transportLeaseMs ?? DEFAULT_AGENT_MIGRATION_TRANSPORT_LEASE_MS),
      transportMaxBytes: input.transportMaxBytes ?? DEFAULT_AGENT_MIGRATION_TRANSPORT_MAX_BYTES,
      // Informational only (phase C drops it); every migration uses AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES.
      transportMaxArchiveEntries: AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES,
      sourceTransportTokenHash: sha256(sourceToken),
      targetTransportTokenHash: sha256(targetToken),
      transportProvisioningStartedAt: now,
      transportProtocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
      transportGeneration,
      transportLeaseId: transportSessionId,
      transportExpectedMigrationRevision: row.revision + 1,
      revision: row.revision + 1,
      updatedAt: now,
    })
    .where(and(eq(agentMigrations.id, row.id), eq(agentMigrations.revision, row.revision)))
    .returning();
  if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
  return {
    migration: updated,
    source: buildTransportLeaseDelivery({ migration: updated, role: "source", token: sourceToken }),
    target: buildTransportLeaseDelivery({ migration: updated, role: "target", token: targetToken }),
  };
}

/** Minimum age of a transport lease before a reconnect may replace it (the first lease may still be in flight). */
export const AGENT_MIGRATION_LEASE_REPROVISION_MIN_AGE_MS = 30_000;

/**
 * A source or target daemon restarted before the flip and lost its in-memory
 * transfer run; the server only keeps token hashes, so the old lease cannot be
 * re-sent. Rotate to a new transport generation (fresh tokens, session, object
 * key, receipts scope) and hand both daemons new leases. Everything bound to
 * the old generation (control manifest, quiesce receipt, upload completion,
 * transfer summary) is reset so the source re-quiesces and re-uploads; a
 * still-running old run is rejected as stale and exits. Pre-flip only: after
 * the flip the target's step retry and orphaned-arrival remediation apply.
 */
export async function reprovisionAgentMigrationTransport(input: {
  migrationId: string;
  expectedTransportGeneration: string;
  provision: AgentMigrationObjectStoreTransferProvision;
  now?: Date;
}): Promise<AgentMigrationProvisioningResult | null> {
  const now = input.now ?? currentDate();
  return await getDb().transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations)
      .where(eq(agentMigrations.id, input.migrationId))
      .for("update")
      .limit(1);
    if (
      !row
      || (row.state !== "provisioning" && row.state !== "prep")
      || row.transportProtocol !== AGENT_MIGRATION_RESUMABLE_PROTOCOL
      || row.transportGeneration !== input.expectedTransportGeneration
      || (row.transportProvisioningStartedAt
        && now.getTime() - row.transportProvisioningStartedAt.getTime() < AGENT_MIGRATION_LEASE_REPROVISION_MIN_AGE_MS)
    ) {
      return null;
    }
    const sourceToken = createTransportToken();
    const targetToken = createTransportToken();
    const [updated] = await tx.update(agentMigrations)
      .set({
        transportSessionId: input.provision.sessionId,
        transportExpiresAt: addMs(now, input.provision.leaseMs),
        transportMaxBytes: input.provision.maxBytes,
        sourceTransportTokenHash: sha256(sourceToken),
        targetTransportTokenHash: sha256(targetToken),
        transportProvisioningStartedAt: now,
        transportGeneration: `agent_migration_transport:${randomUUID()}`,
        transportLeaseId: input.provision.sessionId,
        transportExpectedMigrationRevision: row.revision + 1,
        transportControlManifest: null,
        transportControlSha256: null,
        transportControlRegisteredAt: null,
        transportUploadCompletedAt: null,
        sourceQuiesceReceipt: null,
        sourceQuiescedAt: null,
        transferSummary: null,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(and(eq(agentMigrations.id, row.id), eq(agentMigrations.revision, row.revision)))
      .returning();
    if (!updated) return null;
    return {
      migration: updated,
      source: buildTransportLeaseDelivery({ migration: updated, role: "source", token: sourceToken }),
      target: buildTransportLeaseDelivery({ migration: updated, role: "target", token: targetToken }),
    };
  });
}

/**
 * The target daemon restarted before the flip. Its download is resumable from
 * the chunks already on its disk, and the upload may be complete, so keep the
 * transport generation and only re-issue the target's lease with a fresh token
 * (the old token is only stored hashed). Covers every pre-flip state, including
 * `ready`/`in_transit`. Bookkeeping only: no revision bump, so the source's
 * in-flight steps are unaffected.
 */
export async function reissueAgentMigrationTargetLease(input: {
  migrationId: string;
  expectedTransportGeneration: string;
  now?: Date;
}): Promise<AgentMigrationTransportLeaseDelivery | null> {
  const now = input.now ?? currentDate();
  return await getDb().transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations)
      .where(eq(agentMigrations.id, input.migrationId))
      .for("update")
      .limit(1);
    if (
      !row
      || !AGENT_MIGRATION_TARGET_LEASE_REISSUE_STATES.includes(row.state)
      || row.transportProtocol !== AGENT_MIGRATION_RESUMABLE_PROTOCOL
      || row.transportGeneration !== input.expectedTransportGeneration
      || !row.transportExpiresAt
      || row.transportExpiresAt.getTime() <= now.getTime()
      || (row.transportProvisioningStartedAt
        && now.getTime() - row.transportProvisioningStartedAt.getTime() < AGENT_MIGRATION_LEASE_REPROVISION_MIN_AGE_MS)
    ) {
      return null;
    }
    const targetToken = createTransportToken();
    const [updated] = await tx.update(agentMigrations)
      .set({ targetTransportTokenHash: sha256(targetToken), updatedAt: now })
      .where(and(
        eq(agentMigrations.id, row.id),
        eq(agentMigrations.revision, row.revision),
        eq(agentMigrations.transportGeneration, input.expectedTransportGeneration),
      ))
      .returning();
    if (!updated) return null;
    return buildTransportLeaseDelivery({ migration: updated, role: "target", token: targetToken });
  });
}

const AGENT_MIGRATION_TARGET_LEASE_REISSUE_STATES: readonly AgentMigrationRow["state"][] = [
  "provisioning",
  "prep",
  "ready",
  "in_transit",
];

/**
 * Whether a lost run on `role` may be recovered for this row right now; lets
 * callers skip provisioning an object-store session for ineligible rows.
 */
export function agentMigrationLostRunRecovery(
  row: AgentMigrationRow,
  role: "source" | "target",
  now: Date = currentDate(),
): "rotate_generation" | "reissue_target_lease" | null {
  if (row.transportProtocol !== AGENT_MIGRATION_RESUMABLE_PROTOCOL || !row.transportGeneration) return null;
  if (
    row.transportProvisioningStartedAt
    && now.getTime() - row.transportProvisioningStartedAt.getTime() < AGENT_MIGRATION_LEASE_REPROVISION_MIN_AGE_MS
  ) {
    return null;
  }
  if (role === "target") {
    return AGENT_MIGRATION_TARGET_LEASE_REISSUE_STATES.includes(row.state) ? "reissue_target_lease" : null;
  }
  // The source only matters until its upload completed (`ready`).
  return row.state === "provisioning" || row.state === "prep" ? "rotate_generation" : null;
}

/** Pre-flip resumable migrations in which this machine is the source or target. */
export async function listAgentMigrationsAwaitingTransportOnMachine(machineId: string): Promise<AgentMigrationRow[]> {
  return await getDb().select().from(agentMigrations)
    .where(and(
      inArray(agentMigrations.state, ["provisioning", "prep", "ready", "in_transit"]),
      eq(agentMigrations.transportProtocol, AGENT_MIGRATION_RESUMABLE_PROTOCOL),
      or(eq(agentMigrations.sourceMachineId, machineId), eq(agentMigrations.targetMachineId, machineId)),
    ));
}

export async function beginAgentMigrationProvisioning(
  input: BeginAgentMigrationProvisioningInput,
  executor: DatabaseExecutor = getDb(),
): Promise<AgentMigrationProvisioningResult> {
  if ("transaction" in executor) {
    return await executor.transaction(async (tx) => insertAgentMigrationProvisioning(input, tx));
  }
  return await insertAgentMigrationProvisioning(input, executor);
}

export async function markAgentMigrationTransportProvisionFailed(input: {
  migrationId: string;
  code?: string;
  message?: string | null;
  now?: Date;
}): Promise<AgentMigrationRow | null> {
  const db = getDb();
  const now = input.now ?? currentDate();
  const code = input.code ?? "MIGRATION_TRANSPORT_PROVISION_FAILED";
  return await db.transaction(async (tx) => {
    const [updated] = await tx.update(agentMigrations)
      .set({
        state: "failed",
        failureReason: code,
        transportProvisionFailedAt: now,
        transportTeardownAt: now,
        transportErrorCode: code,
        transportErrorMessage: input.message ?? null,
        revision: sql`${agentMigrations.revision} + 1`,
        updatedAt: now,
      })
      .where(and(eq(agentMigrations.id, input.migrationId), eq(agentMigrations.state, "provisioning")))
      .returning();
    if (!updated) return null;
    await enqueueAgentMigrationFailedReceipt(tx, updated, now);
    return updated;
  });
}

export async function markAgentMigrationTransportLostForComputer(input: {
  migrationId: string;
  serverId: string;
  machineId: string;
  code?: AgentMigrationTransportFailureCode;
  /** Unfiltered daemon cause; `failureReason` stays within the known code set. */
  detailCode?: string | null;
  /** Transport generation of the reporting run (newer daemons); stale runs must not fail a re-provisioned migration. */
  transportGeneration?: string | null;
  message?: string | null;
  now?: Date;
}): Promise<AgentMigrationRow> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, input.migrationId)).limit(1);
    if (
      !row
      || row.serverId !== input.serverId
      || (row.sourceMachineId !== input.machineId && row.targetMachineId !== input.machineId)
    ) {
      throw new Error("MIGRATION_NOT_FOUND");
    }
    const code = input.code ?? "MIGRATION_TRANSPORT_LOST";
    if (row.state === "failed" && row.failureReason === code) {
      return row;
    }
    if (input.transportGeneration && row.transportGeneration && input.transportGeneration !== row.transportGeneration) {
      // A run from a replaced generation; the current generation is unaffected.
      return row;
    }
    if (!isTransferActiveState(row.state)) {
      throw new Error("MIGRATION_NOT_ACTIVE");
    }

    const [updated] = await tx.update(agentMigrations)
      .set({
        state: "failed",
        failureReason: code,
        transportLostAt: now,
        transportTeardownAt: now,
        transportErrorCode: input.detailCode ?? code,
        transportErrorMessage: input.message ?? null,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(and(eq(agentMigrations.id, row.id), eq(agentMigrations.revision, row.revision)))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    await enqueueAgentMigrationFailedReceipt(tx, updated, now);
    return updated;
  });
}

export async function getAgentMigrationTargetImport(input: {
  migrationId: string;
  serverId: string;
  targetMachineId: string;
}): Promise<AgentMigrationTargetImportView> {
  const db = getDb();
  const [row] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, input.migrationId)).limit(1);
  return targetImportView(assertTargetImportRow({ row, serverId: input.serverId, targetMachineId: input.targetMachineId }));
}

export async function assertAgentMigrationTargetArrivalArchivable(input: {
  migrationId: string;
  migrationGeneration: string;
  serverId: string;
  targetMachineId: string;
  now?: Date;
}): Promise<AgentMigrationTargetImportView> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, input.migrationId)).limit(1);
    const migration = assertTargetImportRow({ row, serverId: input.serverId, targetMachineId: input.targetMachineId });
    const archivableState = migration.state === "arriving"
      || migration.state === "starting"
      || migration.state === "completed";
    // Without an archive receipt, a replay must present the current generation:
    // stale authority must never trigger another source archive request (the
    // background retry owns failed archives, behind its agent-moved guards).
    if (
      archivableState
      && migration.sourceWorkspaceArchivedAt
      && await isAgentHeldByTarget(tx, migration)
    ) {
      return targetImportView(migration);
    }
    assertMigrationGeneration(migration, input.migrationGeneration);
    if (!archivableState) throw new Error("MIGRATION_NOT_ARRIVING");
    if (
      migration.state === "arriving"
      && now.getTime() > migration.arrivalDeadlineAt.getTime()
    ) {
      throw new Error("MIGRATION_ARRIVAL_DEADLINE_EXPIRED");
    }
    if (!await isAgentHeldByTarget(tx, migration)) throw new Error("MIGRATION_SOURCE_MACHINE_MISMATCH");
    return targetImportView(migration);
  });
}

export async function recordAgentMigrationSourceWorkspaceArchived(input: {
  migrationId: string;
  migrationGeneration: string;
  serverId: string;
  targetMachineId: string;
  now?: Date;
}): Promise<AgentMigrationTargetImportView> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, input.migrationId)).limit(1);
    const migration = assertTargetImportRow({ row, serverId: input.serverId, targetMachineId: input.targetMachineId });
    if (
      migration.sourceWorkspaceArchivedAt
      && (migration.state === "arriving" || migration.state === "starting" || migration.state === "completed")
      && await isAgentHeldByTarget(tx, migration)
    ) {
      return targetImportView(migration);
    }
    assertMigrationGeneration(migration, input.migrationGeneration);
    if (migration.state !== "arriving" && migration.state !== "starting" && migration.state !== "completed") {
      throw new Error("MIGRATION_NOT_ARRIVING");
    }
    if (!await isAgentHeldByTarget(tx, migration)) throw new Error("MIGRATION_SOURCE_MACHINE_MISMATCH");

    const [updated] = await tx.update(agentMigrations)
      .set({
        sourceWorkspaceArchivedAt: now,
        revision: migration.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrations.id, migration.id),
        eq(agentMigrations.revision, migration.revision),
        isNull(agentMigrations.sourceWorkspaceArchivedAt),
      ))
      .returning();
    if (updated) return targetImportView(updated);

    const [current] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, migration.id)).limit(1);
    if (
      current?.sourceWorkspaceArchivedAt
      && (current.state === "arriving" || current.state === "starting" || current.state === "completed")
      && await isAgentHeldByTarget(tx, current)
    ) {
      return targetImportView(current);
    }
    throw new Error("MIGRATION_CONCURRENT_UPDATE");
  });
}

export const AGENT_MIGRATION_SOURCE_ARCHIVE_MAX_ATTEMPTS = 12;
export const AGENT_MIGRATION_SOURCE_ARCHIVE_CLAIM_LEASE_MS = 2 * 60 * 1000;
const AGENT_MIGRATION_SOURCE_ARCHIVE_BASE_BACKOFF_MS = 60 * 1000;
const AGENT_MIGRATION_SOURCE_ARCHIVE_MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const SOURCE_ARCHIVE_ERROR_CODE_PATTERN = /^[A-Za-z0-9_:.-]{1,160}$/;
const SOURCE_ARCHIVE_AGENT_MOVED_CODES: ReadonlySet<string> = new Set([
  "MIGRATION_WORKSPACE_ARCHIVE_AGENT_RUNNING",
  "MIGRATION_WORKSPACE_ARCHIVE_NEWER_OWNER",
]);

function sourceArchiveBackoffMs(attempts: number): number {
  return Math.min(
    AGENT_MIGRATION_SOURCE_ARCHIVE_BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1),
    AGENT_MIGRATION_SOURCE_ARCHIVE_MAX_BACKOFF_MS,
  );
}

// The source-archive bookkeeping below deliberately does not bump `revision`:
// it is independent of the transfer/auto-start state machine, whose writers
// are revision-guarded and must not lose a race to a background cleanup.

/** Record a failed source-archive attempt; schedules a retry or abandons after the cap. */
export async function recordAgentMigrationSourceArchiveAttemptFailed(input: {
  migrationId: string;
  errorCode?: string | null;
  now?: Date;
}): Promise<AgentMigrationRow | null> {
  const now = input.now ?? currentDate();
  const errorCode = input.errorCode && SOURCE_ARCHIVE_ERROR_CODE_PATTERN.test(input.errorCode)
    ? input.errorCode
    : "MIGRATION_SOURCE_WORKSPACE_ARCHIVE_FAILED";
  return await getDb().transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations)
      .where(eq(agentMigrations.id, input.migrationId))
      .for("update")
      .limit(1);
    if (!row || row.sourceWorkspaceArchivedAt || row.sourceWorkspaceArchiveAbandonedAt) return row ?? null;
    const attempts = row.sourceWorkspaceArchiveAttempts + 1;
    // The source daemon refused because the workspace is live again (the agent
    // runs there, or a newer migration committed it): retrying cannot succeed.
    const agentMoved = SOURCE_ARCHIVE_AGENT_MOVED_CODES.has(errorCode);
    const exhausted = agentMoved || attempts >= AGENT_MIGRATION_SOURCE_ARCHIVE_MAX_ATTEMPTS;
    const [updated] = await tx.update(agentMigrations)
      .set({
        sourceWorkspaceArchiveAttempts: attempts,
        sourceWorkspaceArchiveLastError: agentMoved ? "agent_moved" : errorCode,
        sourceWorkspaceArchiveRetryAt: exhausted ? null : new Date(now.getTime() + sourceArchiveBackoffMs(attempts)),
        sourceWorkspaceArchiveAbandonedAt: exhausted ? now : null,
        updatedAt: now,
      })
      .where(eq(agentMigrations.id, row.id))
      .returning();
    return updated ?? null;
  });
}

export type AgentMigrationSourceArchiveRetryClaim =
  | { action: "archive"; migration: AgentMigrationRow }
  | { action: "abandoned"; migration: AgentMigrationRow; reason: "agent_moved" };

/**
 * Claim one completed/starting migration whose source archive failed and is
 * due for a retry. Guards against archiving a live workspace: if the agent no
 * longer runs on this migration's target, or a newer migration of the agent
 * exists, the pending archive is abandoned instead (task #4's target-side
 * quarantine handles any leftover directory on a later move back).
 */
export async function claimAgentMigrationSourceArchiveRetry(input: {
  now?: Date;
  leaseMs?: number;
} = {}): Promise<AgentMigrationSourceArchiveRetryClaim | null> {
  const now = input.now ?? currentDate();
  const leaseMs = input.leaseMs ?? AGENT_MIGRATION_SOURCE_ARCHIVE_CLAIM_LEASE_MS;
  return await getDb().transaction(async (tx) => {
    const [candidate] = await tx.select()
      .from(agentMigrations)
      .where(and(
        inArray(agentMigrations.state, ["starting", "completed"]),
        isNull(agentMigrations.sourceWorkspaceArchivedAt),
        isNull(agentMigrations.sourceWorkspaceArchiveAbandonedAt),
        // Only rows whose archive was attempted and failed under this policy;
        // historical rows are never silently swept or backfilled.
        gt(agentMigrations.sourceWorkspaceArchiveAttempts, 0),
        lte(agentMigrations.sourceWorkspaceArchiveRetryAt, now),
      ))
      .orderBy(asc(agentMigrations.sourceWorkspaceArchiveRetryAt))
      .for("update", { skipLocked: true })
      .limit(1);
    if (!candidate) return null;

    const [newer] = await tx.select({ id: agentMigrations.id })
      .from(agentMigrations)
      .where(and(
        eq(agentMigrations.agentId, candidate.agentId),
        gt(agentMigrations.createdAt, candidate.createdAt),
      ))
      .limit(1);
    if (newer || !await isAgentHeldByTarget(tx, candidate)) {
      const [abandoned] = await tx.update(agentMigrations)
        .set({
          sourceWorkspaceArchiveAbandonedAt: now,
          sourceWorkspaceArchiveRetryAt: null,
          sourceWorkspaceArchiveLastError: "agent_moved",
          updatedAt: now,
        })
        .where(eq(agentMigrations.id, candidate.id))
        .returning();
      return abandoned ? { action: "abandoned", migration: abandoned, reason: "agent_moved" } : null;
    }

    const [claimed] = await tx.update(agentMigrations)
      .set({ sourceWorkspaceArchiveRetryAt: new Date(now.getTime() + leaseMs) })
      .where(eq(agentMigrations.id, candidate.id))
      .returning();
    return claimed ? { action: "archive", migration: claimed } : null;
  });
}

/** Background counterpart of recordAgentMigrationSourceWorkspaceArchived (no daemon generation). */
export async function recordAgentMigrationSourceWorkspaceArchivedById(input: {
  migrationId: string;
  now?: Date;
}): Promise<AgentMigrationRow | null> {
  const now = input.now ?? currentDate();
  const [updated] = await getDb().update(agentMigrations)
    .set({
      sourceWorkspaceArchivedAt: now,
      sourceWorkspaceArchiveRetryAt: null,
      updatedAt: now,
    })
    .where(and(
      eq(agentMigrations.id, input.migrationId),
      isNull(agentMigrations.sourceWorkspaceArchivedAt),
    ))
    .returning();
  return updated ?? null;
}

export async function startAgentMigrationTargetImport(input: {
  migrationId: string;
  migrationGeneration: string;
  serverId: string;
  targetMachineId: string;
  now?: Date;
}): Promise<AgentMigrationTargetImportView> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, input.migrationId)).limit(1);
    const migration = assertTargetImportRow({ row, serverId: input.serverId, targetMachineId: input.targetMachineId });
    assertMigrationGeneration(migration, input.migrationGeneration);
    if (migration.state !== "ready") throw new Error("MIGRATION_NOT_READY");
    if (now.getTime() > migration.transferDeadlineAt.getTime()) throw new Error("MIGRATION_TRANSFER_DEADLINE_EXPIRED");

    const [updated] = await tx.update(agentMigrations)
      .set({ state: "in_transit", revision: migration.revision + 1, updatedAt: now })
      .where(and(eq(agentMigrations.id, migration.id), eq(agentMigrations.revision, migration.revision)))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    return targetImportView(updated);
  });
}

export async function flipAgentMigrationTargetImport(input: {
  migrationId: string;
  migrationGeneration: string;
  serverId: string;
  targetMachineId: string;
  now?: Date;
}): Promise<AgentMigrationTargetImportView> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, input.migrationId)).limit(1);
    const migration = assertTargetImportRow({ row, serverId: input.serverId, targetMachineId: input.targetMachineId });
    if ((migration.state === "arriving" || migration.state === "completed") && await isAgentHeldByTarget(tx, migration)) {
      return targetImportView(migration);
    }
    assertMigrationGeneration(migration, input.migrationGeneration);
    if (migration.state !== "in_transit") throw new Error("MIGRATION_NOT_FLIPPABLE");
    if (now.getTime() > migration.transferDeadlineAt.getTime()) throw new Error("MIGRATION_TRANSFER_DEADLINE_EXPIRED");
    const nextArrivalDeadlineAt = addMs(now, arrivalWindowMs(migration));

    const [updatedAgent] = await tx.update(agents)
      .set({ machineId: migration.targetMachineId, updatedAt: now })
      .where(and(
        eq(agents.id, migration.agentId),
        eq(agents.machineId, migration.sourceMachineId),
        isNull(agents.deletedAt),
        sql`EXISTS (
          SELECT 1
          FROM ${agentMigrations}
          WHERE ${agentMigrations.id} = ${migration.id}
            AND ${agentMigrations.revision} = ${migration.revision}
            AND ${agentMigrations.state} = 'in_transit'
        )`,
      ))
      .returning({ id: agents.id });
    if (!updatedAgent) {
      const [current] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, migration.id)).limit(1);
      if (current && (current.state === "arriving" || current.state === "completed") && await isAgentHeldByTarget(tx, current)) {
        return targetImportView(current);
      }
      throw new Error("MIGRATION_SOURCE_MACHINE_MISMATCH");
    }

    const [updated] = await tx.update(agentMigrations)
      .set({
        state: "arriving",
        flippedAt: now,
        arrivalDeadlineAt: nextArrivalDeadlineAt,
        revision: migration.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrations.id, migration.id),
        eq(agentMigrations.revision, migration.revision),
        eq(agentMigrations.state, "in_transit"),
      ))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    return targetImportView(updated);
  });
}

export async function markAgentMigrationTargetImportArrived(input: {
  migrationId: string;
  migrationGeneration: string;
  serverId: string;
  targetMachineId: string;
  reportPath?: string | null;
  reportSha256?: string | null;
  now?: Date;
}): Promise<AgentMigrationTargetArrivalResult> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, input.migrationId)).limit(1);
    const migration = assertTargetImportRow({ row, serverId: input.serverId, targetMachineId: input.targetMachineId });
    if (migration.state === "completed" && await isAgentHeldByTarget(tx, migration)) {
      return { migration: targetImportView(migration), autoStart: "none" };
    }
    if (migration.state === "starting" && await isAgentHeldByTarget(tx, migration)) {
      if (migration.failureReason === null) {
        if (now.getTime() < migration.updatedAt.getTime() + AGENT_MIGRATION_AUTO_START_LEASE_MS) {
          return { migration: targetImportView(migration), autoStart: "observe" };
        }
        const [reclaimed] = await tx.update(agentMigrations)
          .set({
            revision: migration.revision + 1,
            updatedAt: now,
          })
          .where(and(
            eq(agentMigrations.id, migration.id),
            eq(agentMigrations.revision, migration.revision),
            eq(agentMigrations.state, "starting"),
            isNull(agentMigrations.failureReason),
          ))
          .returning();
        if (reclaimed) return { migration: targetImportView(reclaimed), autoStart: "dispatch" };
        const [current] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, migration.id)).limit(1);
        if (!current) throw new Error("MIGRATION_NOT_FOUND");
        return { migration: targetImportView(current), autoStart: "observe" };
      }
      if (migration.failureReason !== "auto_start_failed") {
        return { migration: targetImportView(migration), autoStart: "observe" };
      }
      const [claimed] = await tx.update(agentMigrations)
        .set({
          failureReason: null,
          autoStartRemediationLeaseId: null,
          autoStartRemediationLeaseExpiresAt: null,
          revision: migration.revision + 1,
          updatedAt: now,
        })
        .where(and(
          eq(agentMigrations.id, migration.id),
          eq(agentMigrations.revision, migration.revision),
          eq(agentMigrations.state, "starting"),
          eq(agentMigrations.failureReason, "auto_start_failed"),
        ))
        .returning();
      if (claimed) return { migration: targetImportView(claimed), autoStart: "dispatch" };
      const [current] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, migration.id)).limit(1);
      if (!current) throw new Error("MIGRATION_NOT_FOUND");
      return { migration: targetImportView(current), autoStart: "observe" };
    }
    assertMigrationGeneration(migration, input.migrationGeneration);
    if (migration.state !== "arriving") throw new Error("MIGRATION_NOT_ARRIVING");
    if (
      !migration.sourceWorkspaceArchivedAt
      && now.getTime() > migration.arrivalDeadlineAt.getTime()
    ) {
      throw new Error("MIGRATION_ARRIVAL_DEADLINE_EXPIRED");
    }
    if (!await isAgentHeldByTarget(tx, migration)) throw new Error("MIGRATION_SOURCE_MACHINE_MISMATCH");
    await finalizeAgentHolderProjection(tx, migration, now);
    await finalizeRuntimeProfileProjection(tx, migration, now);

    const [updated] = await tx.update(agentMigrations)
      .set({
        state: "starting",
        arrivalReportPath: input.reportPath ?? null,
        arrivalReportSha256: input.reportSha256 ?? null,
        failureReason: null,
        autoStartRemediationLeaseId: null,
        autoStartRemediationLeaseExpiresAt: null,
        arrivedAt: now,
        revision: migration.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrations.id, migration.id),
        eq(agentMigrations.revision, migration.revision),
        eq(agentMigrations.state, "arriving"),
      ))
      .returning();
    if (!updated) {
      const [current] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, migration.id)).limit(1);
      if (current && (current.state === "starting" || current.state === "completed") && await isAgentHeldByTarget(tx, current)) {
        return {
          migration: targetImportView(current),
          autoStart: current.state === "completed"
            ? "none"
            : current.failureReason === "auto_start_failed"
              ? "dispatch"
              : "observe",
        };
      }
      throw new Error("MIGRATION_CONCURRENT_UPDATE");
    }
    return { migration: targetImportView(updated), autoStart: "dispatch" };
  });
}

export async function completeAgentMigrationAutoStart(input: {
  migrationId: string;
  agentId: string;
  targetMachineId: string;
  remediationLeaseId?: string | null;
  now?: Date;
  actorFence?: AgentMigrationActorFence;
}, receiptHooks: AgentMigrationReceiptEnqueueHooks = {}): Promise<AgentMigrationRow> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    if (input.actorFence) await lockAgentMigrationActorAuthority(tx, input.agentId, input.actorFence);
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, input.migrationId)).limit(1);
    if (!row || row.agentId !== input.agentId || row.targetMachineId !== input.targetMachineId) {
      throw new Error("MIGRATION_NOT_FOUND");
    }
    // Completion means the agent runs on the target. Source cleanup is tracked
    // separately (source_workspace_archive_*) and retried in the background.
    if (row.state === "completed" && await isAgentHeldByTarget(tx, row)) return row;
    if (row.state !== "starting") throw new Error("MIGRATION_NOT_STARTING");
    if (!await isAgentHeldByTarget(tx, row)) throw new Error("MIGRATION_SOURCE_MACHINE_MISMATCH");

    if (input.remediationLeaseId) {
      const ownsLiveLease =
        row.autoStartRemediationLeaseId === input.remediationLeaseId
        && row.autoStartRemediationLeaseExpiresAt
        && row.autoStartRemediationLeaseExpiresAt.getTime() > now.getTime();
      if (!ownsLiveLease) {
        throw new Error("MIGRATION_AUTO_START_REMEDIATION_LEASE_STALE");
      }
    }

    const [updated] = await tx.update(agentMigrations)
      .set({
        state: "completed",
        failureReason: null,
        autoStartRemediationLeaseId: null,
        autoStartRemediationLeaseExpiresAt: null,
        completedAt: now,
        transportTeardownAt: now,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrations.id, row.id),
        eq(agentMigrations.revision, row.revision),
        eq(agentMigrations.state, "starting"),
        ...(input.remediationLeaseId
          ? [
              eq(agentMigrations.autoStartRemediationLeaseId, input.remediationLeaseId),
              gt(agentMigrations.autoStartRemediationLeaseExpiresAt, now),
            ]
          : []),
      ))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    await enqueueAgentMigrationCompletedReceipt(tx, updated, now, receiptHooks);
    return updated;
  });
}

export async function recordAgentMigrationAutoStartFailure(input: {
  migrationId: string;
  agentId: string;
  targetMachineId: string;
  stage: AgentMigrationAutoStartFailureStage;
  code: AgentMigrationAutoStartFailureCode;
  remediationLeaseId?: string | null;
  now?: Date;
}): Promise<AgentMigrationRow> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentMigrations).where(eq(agentMigrations.id, input.migrationId)).limit(1);
    if (!row || row.agentId !== input.agentId || row.targetMachineId !== input.targetMachineId) {
      throw new Error("MIGRATION_NOT_FOUND");
    }
    if (row.state === "completed" && await isAgentHeldByTarget(tx, row)) return row;
    if (row.state !== "starting") throw new Error("MIGRATION_NOT_STARTING");
    if (input.remediationLeaseId) {
      const ownsLiveLease =
        row.autoStartRemediationLeaseId === input.remediationLeaseId
        && row.autoStartRemediationLeaseExpiresAt
        && row.autoStartRemediationLeaseExpiresAt.getTime() > now.getTime();
      if (!ownsLiveLease) {
        throw new Error("MIGRATION_AUTO_START_REMEDIATION_LEASE_STALE");
      }
    }
    const [updated] = await tx.update(agentMigrations)
      .set({
        failureReason: "auto_start_failed",
        autoStartFailureStage: input.stage,
        autoStartFailureCode: input.code,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrations.id, row.id),
        eq(agentMigrations.revision, row.revision),
        eq(agentMigrations.state, "starting"),
        ...(input.remediationLeaseId
          ? [
              eq(agentMigrations.autoStartRemediationLeaseId, input.remediationLeaseId),
              gt(agentMigrations.autoStartRemediationLeaseExpiresAt, now),
            ]
          : []),
      ))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    return updated;
  });
}

export async function claimAgentMigrationAutoStartRemediation(input: {
  workerId: string;
  now?: Date;
  leaseMs?: number;
}): Promise<AgentMigrationAutoStartRemediationClaim | null> {
  const db = getDb();
  const now = input.now ?? currentDate();
  const leaseMs = input.leaseMs ?? AGENT_MIGRATION_AUTO_START_REMEDIATION_LEASE_MS;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("MIGRATION_AUTO_START_REMEDIATION_LEASE_INVALID");

  return await db.transaction(async (tx) => {
    const typedFailedPredicate = and(
      eq(agentMigrations.failureReason, "auto_start_failed"),
      sql`${agentMigrations.autoStartFailureStage} IS NOT NULL`,
      sql`${agentMigrations.autoStartFailureCode} IS NOT NULL`,
    );
    const orphanedDispatchPredicate = and(
      isNull(agentMigrations.failureReason),
      sql`${agentMigrations.autoStartFailureStage} IS NOT NULL`,
      sql`${agentMigrations.autoStartFailureCode} IS NOT NULL`,
      sql`${agentMigrations.autoStartRemediationLeaseId} IS NOT NULL`,
      lte(agentMigrations.autoStartRemediationLeaseExpiresAt, now),
    );
    const orphanedArrivalPredicate = and(
      isNull(agentMigrations.failureReason),
      isNull(agentMigrations.autoStartFailureStage),
      isNull(agentMigrations.autoStartFailureCode),
      // No lease-id filter: a remediation claim that crashed before recording an
      // outcome leaves an expired lease on this same shape (the outer lease
      // predicate below admits it again).
      lte(agentMigrations.arrivedAt, new Date(now.getTime() - AGENT_MIGRATION_ORPHANED_ARRIVAL_GRACE_MS)),
    );
    const [candidate] = await tx.select()
      .from(agentMigrations)
      .where(and(
        eq(agentMigrations.state, "starting"),
        or(typedFailedPredicate, orphanedDispatchPredicate, orphanedArrivalPredicate),
        or(
          isNull(agentMigrations.autoStartRemediationLeaseExpiresAt),
          lte(agentMigrations.autoStartRemediationLeaseExpiresAt, now),
        ),
      ))
      .orderBy(asc(agentMigrations.autoStartLastRetryAt), asc(agentMigrations.updatedAt))
      .for("update")
      .limit(1);
    if (!candidate) return null;
    const candidateVariant: AgentMigrationAutoStartRemediationCandidateVariant =
      candidate.failureReason === "auto_start_failed"
        ? "typed_failed"
        : candidate.autoStartFailureStage === null
          ? "orphaned_arrival"
          : "orphaned_dispatch";
    const candidateVariantPredicate = candidateVariant === "typed_failed"
      ? typedFailedPredicate
      : candidateVariant === "orphaned_arrival"
        ? orphanedArrivalPredicate
        : orphanedDispatchPredicate;
    const candidateLeasePredicate = candidate.autoStartRemediationLeaseId
      ? and(
          eq(agentMigrations.autoStartRemediationLeaseId, candidate.autoStartRemediationLeaseId),
          candidate.autoStartRemediationLeaseExpiresAt
            ? eq(agentMigrations.autoStartRemediationLeaseExpiresAt, candidate.autoStartRemediationLeaseExpiresAt)
            : isNull(agentMigrations.autoStartRemediationLeaseExpiresAt),
        )
      : and(
          isNull(agentMigrations.autoStartRemediationLeaseId),
          isNull(agentMigrations.autoStartRemediationLeaseExpiresAt),
        );

    const deadlineAt = candidate.autoStartRetryDeadlineAt
      ?? new Date(now.getTime() + AGENT_MIGRATION_AUTO_START_REMEDIATION_WINDOW_MS);
    const exhausted =
      candidate.autoStartRetryAttempts >= AGENT_MIGRATION_AUTO_START_MAX_RETRY_ATTEMPTS ||
      now.getTime() >= deadlineAt.getTime();

    if (exhausted) {
      const [terminal] = await tx.update(agentMigrations)
        .set({
          state: "failed",
          failureReason: "auto_start_failed",
          transportTeardownAt: now,
          autoStartRemediationLeaseId: null,
          autoStartRemediationLeaseExpiresAt: null,
          revision: candidate.revision + 1,
          updatedAt: now,
        })
        .where(and(
          eq(agentMigrations.id, candidate.id),
          eq(agentMigrations.revision, candidate.revision),
          eq(agentMigrations.state, "starting"),
          candidateVariantPredicate,
          candidateLeasePredicate,
        ))
        .returning();
      if (!terminal) return null;
      await enqueueAgentMigrationFailedReceipt(tx, terminal, now);
      return { migration: terminal, action: "terminal", leaseId: null, candidateVariant };
    }

    const leaseId = `${input.workerId}:${randomUUID()}`;
    const [claimed] = await tx.update(agentMigrations)
      .set({
        failureReason: null,
        autoStartRetryAttempts: candidate.autoStartRetryAttempts + 1,
        autoStartRetryDeadlineAt: deadlineAt,
        autoStartLastRetryAt: now,
        autoStartRemediationLeaseId: leaseId,
        autoStartRemediationLeaseExpiresAt: new Date(now.getTime() + leaseMs),
        revision: candidate.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrations.id, candidate.id),
        eq(agentMigrations.revision, candidate.revision),
        eq(agentMigrations.state, "starting"),
        candidateVariantPredicate,
        candidateLeasePredicate,
      ))
      .returning();
    if (!claimed) return null;
    return { migration: claimed, action: "dispatch", leaseId, candidateVariant };
  });
}

function cancellationDispositionFor(row: AgentMigrationRow): AgentMigrationCancelDisposition {
  return row.flippedAt
    || row.state === "arriving"
    || row.state === "starting"
    || row.state === "completed"
    || row.state === "cancel_requested_post_flip"
    || row.state === "canceled_post_flip"
    ? "post_flip_target_authoritative"
    : "pre_flip_source_authoritative";
}

function cancellationSuccessOutcomeFor(
  disposition: AgentMigrationCancelDisposition,
  role: AgentMigrationCancelRole,
): "cleaned" | "stopped" {
  return disposition === "post_flip_target_authoritative" && role === "target"
    ? "stopped"
    : "cleaned";
}

function canceledStateFor(disposition: AgentMigrationCancelDisposition): Extract<AgentMigrationState, "canceled_pre_flip" | "canceled_post_flip"> {
  return disposition === "pre_flip_source_authoritative" ? "canceled_pre_flip" : "canceled_post_flip";
}

function cancellationCleanupPending(row: Pick<AgentMigrationRow,
  "state" | "cancelGeneration" | "cancelTransportGeneration" | "cancelDisposition" | "cancelSourceAckAt" | "cancelTargetAckAt" | "cancelNeedsAttentionAt"
>): boolean {
  return (row.state === "canceled_pre_flip" || row.state === "canceled_post_flip")
    && Boolean(row.cancelGeneration)
    && Boolean(row.cancelTransportGeneration)
    && Boolean(row.cancelDisposition)
    && !row.cancelNeedsAttentionAt
    && (!row.cancelSourceAckAt || !row.cancelTargetAckAt);
}

function terminalCleanupError(row: Pick<AgentMigrationRow, "cancelAttentionDeadlineAt" | "cancelDispatchAttempts">, now: Date): string | null {
  if (row.cancelAttentionDeadlineAt && now.getTime() > row.cancelAttentionDeadlineAt.getTime()) {
    return "cancel_ack_deadline_exceeded";
  }
  if (row.cancelDispatchAttempts >= AGENT_MIGRATION_CANCEL_MAX_DISPATCH_ATTEMPTS) {
    return "cancel_dispatch_retry_exhausted";
  }
  return null;
}

export function projectAgentMigrationUpdatedPayload(row: AgentMigrationRow): AgentMigrationUpdatedPayload {
  const disposition = row.cancelDisposition ?? (
    row.state === "cancel_requested_pre_flip" || row.state === "canceled_pre_flip"
      ? "pre_flip_source_authoritative"
      : row.state === "cancel_requested_post_flip" || row.state === "canceled_post_flip"
        ? "post_flip_target_authoritative"
        : null
  );
  return {
    agentId: row.agentId,
    migrationRef: row.supportRef,
    state: row.state,
    revision: row.revision,
    authority: cancellationDispositionFor(row) === "post_flip_target_authoritative" ? "target" : "source",
    disposition,
    needsAttention: Boolean(row.cancelNeedsAttentionAt),
    dispatchAttempts: row.cancelDispatchAttempts,
    attentionDeadlineAt: row.cancelAttentionDeadlineAt?.toISOString() ?? null,
    sourceAcknowledgedAt: row.cancelSourceAckAt?.toISOString() ?? null,
    targetAcknowledgedAt: row.cancelTargetAckAt?.toISOString() ?? null,
    targetOutcome: row.cancelTargetOutcome,
    canceledAt: row.canceledAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function buildAgentMigrationCancellationDeliveries(
  row: AgentMigrationRow,
): Array<{ machineId: string; message: AgentMigrationCancelMessage }> {
  if (
    (row.state !== "cancel_requested_pre_flip"
      && row.state !== "cancel_requested_post_flip"
      && row.state !== "canceled_pre_flip"
      && row.state !== "canceled_post_flip")
    || !row.cancelGeneration
    || !row.cancelTransportGeneration
    || !row.cancelDisposition
  ) {
    throw new Error("MIGRATION_CANCEL_NOT_REQUESTED");
  }
  const base = {
    type: "machine:migration:cancel" as const,
    agentId: row.agentId,
    migrationId: row.id,
    migrationRef: row.supportRef,
    transportGeneration: row.cancelTransportGeneration,
    cancelGeneration: row.cancelGeneration,
    migrationRevision: row.revision,
    sessionId: row.transportSessionId,
    disposition: row.cancelDisposition,
  };
  return [
    {
      machineId: row.sourceMachineId,
      message: { ...base, role: "source", stopAgent: false },
    },
    {
      machineId: row.targetMachineId,
      message: {
        ...base,
        role: "target",
        stopAgent: row.cancelDisposition === "post_flip_target_authoritative",
      },
    },
  ];
}

export async function requestAgentMigrationCancellation(input: {
  agentId: string;
  migrationRef: string;
  expectedRevision: number;
  initiatedByUserId: string;
  reason: string;
  now?: Date;
  actorFence?: AgentMigrationActorFence;
}): Promise<AgentMigrationCancellationRequestResult> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    if (input.actorFence) await lockAgentMigrationActorAuthority(tx, input.agentId, input.actorFence);
    const [row] = await tx.select()
      .from(agentMigrations)
      .where(and(
        eq(agentMigrations.agentId, input.agentId),
        eq(agentMigrations.supportRef, input.migrationRef),
      ))
      .for("update")
      .limit(1);
    if (!row) throw new Error("MIGRATION_NOT_FOUND");

    const disposition = row.cancelDisposition ?? cancellationDispositionFor(row);
    if (row.state === "cancel_requested_pre_flip" || row.state === "cancel_requested_post_flip") {
      const errorCode = terminalCleanupError(row, now);
      const [terminal] = await tx.update(agentMigrations)
        .set({
          state: canceledStateFor(disposition),
          cancelNeedsAttentionAt: errorCode ? now : row.cancelNeedsAttentionAt,
          cancelErrorCode: errorCode ?? row.cancelErrorCode,
          cancelErrorMessage: errorCode
            ? "Cancellation cleanup did not complete inside the bounded retry window"
            : row.cancelErrorMessage,
          canceledAt: row.canceledAt ?? now,
          transportTeardownAt: row.transportTeardownAt ?? now,
          cancelCleanupLeaseId: null,
          cancelCleanupLeaseExpiresAt: null,
          revision: row.revision + 1,
          updatedAt: now,
        })
        .where(eq(agentMigrations.id, row.id))
        .returning();
      if (!terminal) throw new Error("MIGRATION_CONCURRENT_UPDATE");
      await enqueueAgentMigrationCanceledReceipt(tx, terminal, now);
      return { migration: terminal, disposition, dispatch: errorCode ? "none" : "required" };
    }
    if (
      row.state === "canceled_pre_flip"
      || row.state === "canceled_post_flip"
      || row.state === "completed"
      || row.state === "aborted"
      || row.state === "failed"
    ) {
      return { migration: row, disposition, dispatch: "none" };
    }
    if (row.revision !== input.expectedRevision) throw new Error("MIGRATION_REVISION_STALE");

    const [updated] = await tx.update(agentMigrations)
      .set({
        state: canceledStateFor(disposition),
        cancelGeneration: createMigrationCancelGeneration(),
        cancelTransportGeneration: row.transportGeneration ?? agentMigrationGeneration(row),
        cancelDisposition: disposition,
        cancelRequestedAt: now,
        cancelRequestedByUserId: input.initiatedByUserId,
        cancelReason: input.reason,
        cancelDispatchAttempts: 1,
        cancelLastDispatchAt: now,
        cancelAttentionDeadlineAt: addMs(now, AGENT_MIGRATION_CANCEL_ATTENTION_WINDOW_MS),
        cancelSourceAckAt: null,
        cancelSourceOutcome: null,
        cancelTargetAckAt: null,
        cancelTargetOutcome: null,
        cancelNeedsAttentionAt: null,
        cancelErrorCode: null,
        cancelErrorMessage: null,
        cancelCleanupLeaseId: null,
        cancelCleanupLeaseExpiresAt: null,
        canceledAt: now,
        transportTeardownAt: now,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(eq(agentMigrations.id, row.id))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    await enqueueAgentMigrationCanceledReceipt(tx, updated, now);
    return { migration: updated, disposition, dispatch: "required" };
  });
}

export async function acknowledgeAgentMigrationCancellation(input: {
  migrationId: string;
  migrationRef: string;
  transportGeneration: string;
  cancelGeneration: string;
  serverId: string;
  machineId: string;
  role: AgentMigrationCancelRole;
  outcome: "cleaned" | "stopped" | "needs_attention";
  cleanupLeaseId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  now?: Date;
}): Promise<AgentMigrationRow> {
  const db = getDb();
  const now = input.now ?? currentDate();
  return await db.transaction(async (tx) => {
    const [row] = await tx.select()
      .from(agentMigrations)
      .where(eq(agentMigrations.id, input.migrationId))
      .for("update")
      .limit(1);
    const expectedMachineId = input.role === "source" ? row?.sourceMachineId : row?.targetMachineId;
    if (
      !row
      || row.supportRef !== input.migrationRef
      || row.serverId !== input.serverId
      || expectedMachineId !== input.machineId
    ) {
      throw new Error("MIGRATION_NOT_FOUND");
    }
    if (!row.cancelGeneration || row.cancelGeneration !== input.cancelGeneration) {
      throw new Error("MIGRATION_CANCEL_GENERATION_STALE");
    }
    if (!row.cancelTransportGeneration || row.cancelTransportGeneration !== input.transportGeneration) {
      throw new Error("MIGRATION_GENERATION_STALE");
    }
    const cancellationState = row.state === "cancel_requested_pre_flip"
      || row.state === "cancel_requested_post_flip"
      || row.state === "canceled_pre_flip"
      || row.state === "canceled_post_flip";
    if (!cancellationState || !row.cancelDisposition) {
      throw new Error("MIGRATION_CANCEL_NOT_REQUESTED");
    }
    if (
      input.outcome !== "needs_attention"
      && input.outcome !== cancellationSuccessOutcomeFor(row.cancelDisposition, input.role)
    ) {
      throw new Error("MIGRATION_CANCEL_OUTCOME_MISMATCH");
    }
    if (input.outcome === "needs_attention") {
      if (input.cleanupLeaseId) {
        const ownsLiveLease =
          row.cancelCleanupLeaseId === input.cleanupLeaseId
          && row.cancelCleanupLeaseExpiresAt
          && row.cancelCleanupLeaseExpiresAt.getTime() > now.getTime();
        if (!ownsLiveLease) {
          throw new Error("MIGRATION_CANCEL_CLEANUP_LEASE_STALE");
        }
      }
      if (
        row.cancelNeedsAttentionAt
        && row.cancelErrorCode === (input.errorCode ?? "cleanup_incomplete")
        && row.cancelErrorMessage === (input.errorMessage ?? null)
      ) {
        return row;
      }
      const [updated] = await tx.update(agentMigrations)
        .set({
          cancelNeedsAttentionAt: now,
          cancelErrorCode: input.errorCode ?? "cleanup_incomplete",
          cancelErrorMessage: input.errorMessage ?? null,
          cancelCleanupLeaseId: null,
          cancelCleanupLeaseExpiresAt: null,
          revision: row.revision + 1,
          updatedAt: now,
        })
        .where(and(
          eq(agentMigrations.id, row.id),
          ...(input.cleanupLeaseId
            ? [
                eq(agentMigrations.cancelCleanupLeaseId, input.cleanupLeaseId),
                gt(agentMigrations.cancelCleanupLeaseExpiresAt, now),
              ]
            : []),
        ))
        .returning();
      if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
      return updated;
    }

    const alreadyAcknowledged = input.role === "source" ? row.cancelSourceAckAt : row.cancelTargetAckAt;
    if (alreadyAcknowledged) return row;
    const sourceAckAt = input.role === "source" ? now : row.cancelSourceAckAt;
    const targetAckAt = input.role === "target" ? now : row.cancelTargetAckAt;
    const terminal = Boolean(sourceAckAt && targetAckAt);
    const terminalState = row.state === "cancel_requested_pre_flip" || row.state === "canceled_pre_flip"
      ? "canceled_pre_flip"
      : "canceled_post_flip";
    const [updated] = await tx.update(agentMigrations)
      .set({
        state: terminal ? terminalState : row.state,
        ...(input.role === "source"
          ? { cancelSourceAckAt: now, cancelSourceOutcome: input.outcome }
          : { cancelTargetAckAt: now, cancelTargetOutcome: input.outcome }),
        cancelNeedsAttentionAt: terminal ? null : row.cancelNeedsAttentionAt,
        cancelErrorCode: terminal ? null : row.cancelErrorCode,
        cancelErrorMessage: terminal ? null : row.cancelErrorMessage,
        cancelCleanupLeaseId: terminal ? null : row.cancelCleanupLeaseId,
        cancelCleanupLeaseExpiresAt: terminal ? null : row.cancelCleanupLeaseExpiresAt,
        canceledAt: terminal ? (row.canceledAt ?? now) : row.canceledAt,
        transportTeardownAt: terminal ? now : row.transportTeardownAt,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(eq(agentMigrations.id, row.id))
      .returning();
    if (!updated) throw new Error("MIGRATION_CONCURRENT_UPDATE");
    return updated;
  });
}

export async function claimAgentMigrationCancellationCleanup(input: {
  workerId: string;
  now?: Date;
  leaseMs?: number;
}): Promise<AgentMigrationCancellationCleanupClaim | null> {
  const db = getDb();
  const now = input.now ?? currentDate();
  const leaseMs = input.leaseMs ?? AGENT_MIGRATION_CANCEL_CLEANUP_LEASE_MS;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("MIGRATION_CANCEL_CLEANUP_LEASE_INVALID");

  return await db.transaction(async (tx) => {
    const [candidate] = await tx.select()
      .from(agentMigrations)
      .where(and(
        inArray(agentMigrations.state, ["canceled_pre_flip", "canceled_post_flip"]),
        isNull(agentMigrations.cancelNeedsAttentionAt),
        or(isNull(agentMigrations.cancelSourceAckAt), isNull(agentMigrations.cancelTargetAckAt)),
        or(
          isNull(agentMigrations.cancelCleanupLeaseExpiresAt),
          lte(agentMigrations.cancelCleanupLeaseExpiresAt, now),
        ),
      ))
      .orderBy(asc(agentMigrations.cancelLastDispatchAt), asc(agentMigrations.updatedAt))
      .for("update")
      .limit(1);
    if (!candidate || !cancellationCleanupPending(candidate)) return null;

    const errorCode = terminalCleanupError(candidate, now);
    if (errorCode) {
      const [attention] = await tx.update(agentMigrations)
        .set({
          cancelNeedsAttentionAt: now,
          cancelErrorCode: errorCode,
          cancelErrorMessage: "Cancellation cleanup did not complete inside the bounded retry window",
          cancelCleanupLeaseId: null,
          cancelCleanupLeaseExpiresAt: null,
          revision: candidate.revision + 1,
          updatedAt: now,
        })
        .where(and(
          eq(agentMigrations.id, candidate.id),
          eq(agentMigrations.revision, candidate.revision),
        ))
        .returning();
      if (!attention) throw new Error("MIGRATION_CANCEL_CLEANUP_CAS_LOST");
      await enqueueAgentMigrationCanceledReceipt(tx, attention, now);
      return { migration: attention, dispatch: "none", leaseId: null, deliveries: [] };
    }

    const leaseId = `${input.workerId}:${randomUUID()}`;
    const [claimed] = await tx.update(agentMigrations)
      .set({
        cancelCleanupLeaseId: leaseId,
        cancelCleanupLeaseExpiresAt: new Date(now.getTime() + leaseMs),
        cancelDispatchAttempts: candidate.cancelDispatchAttempts + 1,
        cancelLastDispatchAt: now,
        revision: candidate.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrations.id, candidate.id),
        eq(agentMigrations.revision, candidate.revision),
        or(
          isNull(agentMigrations.cancelCleanupLeaseExpiresAt),
          lte(agentMigrations.cancelCleanupLeaseExpiresAt, now),
        ),
      ))
      .returning();
    if (!claimed) return null;
    return {
      migration: claimed,
      dispatch: "required",
      leaseId,
      deliveries: buildAgentMigrationCancellationDeliveries(claimed),
    };
  });
}
