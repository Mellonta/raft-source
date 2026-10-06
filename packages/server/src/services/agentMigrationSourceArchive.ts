import type { AgentOrchestrator } from "./agentOrchestrator";
import type { AgentMigrationTargetImportView } from "./agentMigrationService";
import { RouteFailureError } from "../tracing/routeFailure";

/** The source daemon reported an archive failure; carries its code-shaped cause when sent. */
export class AgentMigrationSourceArchiveError extends RouteFailureError {
  constructor(readonly archiveErrorCode: string | undefined) {
    super("unknown", "Migration source workspace archive failed");
    this.name = "AgentMigrationSourceArchiveError";
  }
}

/**
 * Ask the source daemon to archive the migrated-away workspace. Never throws:
 * a failure (source offline, old daemon, timeout, cross-disk error) no longer
 * fails the migration after the flip. It returns a code-shaped cause that the
 * caller records for the background retry.
 */
export async function archiveMigrationSourceWorkspace(
  orchestrator: Pick<AgentOrchestrator, "archiveAgentMigrationSourceWorkspace"> | undefined,
  migration: Pick<AgentMigrationTargetImportView, "sourceMachineId" | "migrationId" | "agentId"> & {
    /** Lets the source daemon refuse a workspace committed by a later migration. */
    migrationCreatedAt?: Date;
  },
): Promise<{ ok: true } | { ok: false; errorCode: string }> {
  if (
    !orchestrator
    || typeof orchestrator.archiveAgentMigrationSourceWorkspace !== "function"
  ) {
    return { ok: false, errorCode: "MIGRATION_SOURCE_WORKSPACE_ARCHIVE_UNAVAILABLE" };
  }
  try {
    await orchestrator.archiveAgentMigrationSourceWorkspace(migration.sourceMachineId, {
      migrationId: migration.migrationId,
      agentId: migration.agentId,
      ...(migration.migrationCreatedAt ? { migrationCreatedAt: migration.migrationCreatedAt.toISOString() } : {}),
    });
    return { ok: true };
  } catch (error) {
    console.error("internal.computer.agent-migrations source archive error:", error);
    if (error instanceof AgentMigrationSourceArchiveError && error.archiveErrorCode) {
      return { ok: false, errorCode: error.archiveErrorCode };
    }
    if (error instanceof RouteFailureError && error.subkind === "daemon_timeout") {
      return { ok: false, errorCode: "MIGRATION_SOURCE_WORKSPACE_ARCHIVE_TIMEOUT" };
    }
    return { ok: false, errorCode: "MIGRATION_SOURCE_WORKSPACE_ARCHIVE_FAILED" };
  }
}
