// Drives a migration through the same service entry points the /migrate route
// and the source/target daemons use, so tests never depend on shortcuts that
// production cannot reach.
import {
  AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
  AGENT_MIGRATION_COMMIT_MARKER_PATH,
  AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
  AGENT_MIGRATION_MIN_CHUNK_BYTES,
  AGENT_MIGRATION_CAPABILITY,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  type AgentMigrationTransferSummary,
} from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agentMigrations } from "../db/schema";
import {
  agentMigrationGeneration,
  beginAgentMigrationProvisioning,
  completeAgentMigrationResumableUpload,
  flipAgentMigrationTargetImport,
  recordAgentMigrationChunkReceipt,
  recordAgentMigrationSourceQuiesced,
  registerAgentMigrationControlManifest,
  startAgentMigrationTargetImport,
  type AgentMigrationProvisioningResult,
  type AgentMigrationRow,
  type BeginAgentMigrationInput,
} from "../services/agentMigrationService";

async function getAgentMigrationRow(migrationId: string): Promise<AgentMigrationRow | null> {
  const [row] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, migrationId)).limit(1);
  return row ?? null;
}

// The token check reads the real clock, so the lease must outlive fixed test dates.
const TEST_TRANSPORT_LEASE_MS = 100 * 365 * 24 * 60 * 60 * 1000;

const DEFAULT_TRANSFER_SUMMARY: AgentMigrationTransferSummary = {
  includedFileCount: 1,
  includedBytes: 1,
  excludedRegenerableCount: 0,
  excludedRegenerableByCategory: { thirdPartyDependencies: 0, caches: 0, buildArtifacts: 0, otherRegenerable: 0 },
  keyWorkspaceEntries: { memoryMdPresent: false, notesPresent: false },
};

export async function beginTestAgentMigration(
  input: BeginAgentMigrationInput,
  executor?: DatabaseExecutor,
): Promise<AgentMigrationProvisioningResult> {
  return await beginAgentMigrationProvisioning({
    ...input,
    transportLeaseMs: TEST_TRANSPORT_LEASE_MS,
  }, executor);
}

/** The source daemon's half: quiesce, register control, upload the one chunk, commit (`ready`). */
export async function markTestAgentMigrationReady(
  provisioning: AgentMigrationProvisioningResult,
  options: { now?: Date; transferSummary?: AgentMigrationTransferSummary } = {},
): Promise<AgentMigrationRow> {
  const { migration, source } = provisioning;
  const now = options.now ?? new Date();
  const transferSummary = options.transferSummary ?? DEFAULT_TRANSFER_SUMMARY;
  const migrationGeneration = source.message.transportGeneration!;
  const leaseId = source.message.leaseId!;
  const actor = {
    migrationId: migration.id,
    serverId: migration.serverId,
    sourceMachineId: migration.sourceMachineId,
    transportToken: source.message.bearerToken,
    now,
  };
  await recordAgentMigrationSourceQuiesced({
    ...actor,
    receipt: {
      schemaVersion: "agent-migration-quiesce/v1",
      migrationId: migration.id,
      migrationGeneration,
      agentId: migration.agentId,
      sourceMachineId: migration.sourceMachineId,
      sourceRuntimeState: "stopped",
      stoppedAt: now.toISOString(),
      actor: "migration",
      launchSessionIdentity: "launch:test:session:test",
      expectedRuntimeRevision: String(source.message.expectedMigrationRevision),
    },
  });
  const chunk = { index: 0, offsetBytes: 0, sizeBytes: 1, sha256: "a".repeat(64) };
  const { controlSha256 } = await registerAgentMigrationControlManifest({
    ...actor,
    control: {
      schemaVersion: AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
      protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
      identity: {
        migrationId: migration.id,
        migrationGeneration,
        leaseId,
        agentId: migration.agentId,
        sourceMachineId: migration.sourceMachineId,
        targetMachineId: migration.targetMachineId,
      },
      capability: { required: [AGENT_MIGRATION_CAPABILITY] },
      bundle: {
        contentType: AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
        totalBytes: chunk.sizeBytes,
        sha256: chunk.sha256,
        chunkSizeBytes: AGENT_MIGRATION_MIN_CHUNK_BYTES,
        chunks: [chunk],
      },
      archive: {
        format: "tar+gzip",
        entryCount: transferSummary.includedFileCount,
        expandedBytes: transferSummary.includedBytes,
        maxEntryBytes: transferSummary.includedBytes,
        allowedEntryTypes: ["file", "symlink"],
      },
      transferSummary,
      commit: {
        mode: "atomic-rename",
        markerPath: AGENT_MIGRATION_COMMIT_MARKER_PATH,
        requireWholeBundleDigest: true,
        requireAllChunkDigests: true,
        existingWorkspace: "idle-or-same-commit",
      },
    },
  });
  await recordAgentMigrationChunkReceipt({
    migrationId: migration.id,
    serverId: migration.serverId,
    machineId: migration.sourceMachineId,
    role: "source",
    transportToken: source.message.bearerToken,
    migrationGeneration,
    leaseId,
    chunkIndex: chunk.index,
    sizeBytes: chunk.sizeBytes,
    sha256: chunk.sha256,
    now,
  });
  return await completeAgentMigrationResumableUpload({ ...actor, migrationGeneration, leaseId, controlSha256 });
}

async function targetStep(
  step: typeof startAgentMigrationTargetImport,
  migrationId: string,
  now?: Date,
): Promise<AgentMigrationRow> {
  const row = await getAgentMigrationRow(migrationId);
  if (!row) throw new Error("MIGRATION_NOT_FOUND");
  await step({
    migrationId: row.id,
    migrationGeneration: agentMigrationGeneration(row),
    serverId: row.serverId,
    targetMachineId: row.targetMachineId,
    now,
  });
  return (await getAgentMigrationRow(migrationId))!;
}

/** The target daemon's `start-transfer` step (`in_transit`). */
export async function startTestAgentMigrationTransfer(migrationId: string, now?: Date): Promise<AgentMigrationRow> {
  return await targetStep(startAgentMigrationTargetImport, migrationId, now);
}

/** The target daemon's `flip-machine` step (`arriving`). */
export async function flipTestAgentMigration(migrationId: string, now?: Date): Promise<AgentMigrationRow> {
  return await targetStep(flipAgentMigrationTargetImport, migrationId, now);
}

/** Begin, upload, start the transfer and flip: the migration waits for the target's `arrived` report. */
export async function beginArrivingTestAgentMigration(
  input: BeginAgentMigrationInput,
  options: { transferSummary?: AgentMigrationTransferSummary } = {},
): Promise<AgentMigrationRow> {
  const provisioning = await beginTestAgentMigration(input);
  await markTestAgentMigrationReady(provisioning, { now: input.now, transferSummary: options.transferSummary });
  await startTestAgentMigrationTransfer(provisioning.migration.id, input.now);
  return await flipTestAgentMigration(provisioning.migration.id, input.now);
}
