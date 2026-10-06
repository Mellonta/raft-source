import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface PendingRestartMarker {
  readonly requestId: string;
  readonly originServerId: string;
  /** Per-server lifecycle operation ids for local multi-server restarts (task #803). */
  readonly requestIds?: Record<string, string>;
  readonly startedAt: string;
  readonly oldServicePid?: number;
  readonly oldRunnerPids?: Record<string, number>;
  readonly acceptedManagedServerIds?: string[];
}

export function pendingRestartMarkerPath(slockHome: string): string {
  return join(slockHome, "restart-pending.json");
}

export async function writePendingRestartMarker(
  slockHome: string,
  marker: PendingRestartMarker,
): Promise<void> {
  const path = pendingRestartMarkerPath(slockHome);
  const tmp = `${path}.tmp`;
  await mkdir(slockHome, { recursive: true });
  await writeFile(tmp, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export async function readPendingRestartMarker(
  slockHome: string,
): Promise<PendingRestartMarker | null> {
  try {
    const parsed = JSON.parse(
      await readFile(pendingRestartMarkerPath(slockHome), "utf8"),
    ) as Partial<PendingRestartMarker>;
    if (
      typeof parsed.requestId !== "string" ||
      typeof parsed.originServerId !== "string" ||
      typeof parsed.startedAt !== "string"
      || (parsed.oldServicePid !== undefined && typeof parsed.oldServicePid !== "number")
      || (parsed.oldRunnerPids !== undefined
        && (typeof parsed.oldRunnerPids !== "object"
          || parsed.oldRunnerPids === null
          || Object.values(parsed.oldRunnerPids).some((pid) => typeof pid !== "number")))
      || (parsed.acceptedManagedServerIds !== undefined
        && (!Array.isArray(parsed.acceptedManagedServerIds)
          || parsed.acceptedManagedServerIds.some((serverId) => typeof serverId !== "string")))
      || (parsed.requestIds !== undefined
        && (typeof parsed.requestIds !== "object"
          || parsed.requestIds === null
          || Object.values(parsed.requestIds).some((requestId) => typeof requestId !== "string")))
    ) {
      return null;
    }
    return parsed as PendingRestartMarker;
  } catch {
    return null;
  }
}

export async function clearPendingRestartMarker(slockHome: string): Promise<void> {
  await rm(pendingRestartMarkerPath(slockHome), { force: true });
}

/**
 * The lifecycle operation this server's runner must report for the pending
 * restart, or null when the restart carries nothing for this server. Local
 * CLI restarts bind one operation per attached server (`requestIds`); Web
 * restarts bind exactly the origin server (`requestId`/`originServerId`).
 */
export function pendingRestartRequestIdForServer(
  marker: PendingRestartMarker,
  serverId: string,
): string | null {
  if (marker.requestIds !== undefined) {
    const scoped = marker.requestIds[serverId];
    return typeof scoped === "string" && scoped.length > 0 ? scoped : null;
  }
  return marker.originServerId === serverId ? marker.requestId : null;
}

export function shouldReconcilePendingRestart(
  marker: PendingRestartMarker,
  serverId: string,
): boolean {
  return pendingRestartRequestIdForServer(marker, serverId) !== null;
}

/**
 * Retire one server's entry after its runner reported completion. The marker
 * is removed once no server still owes a report, so a multi-server restart is
 * not cleared by the first runner that comes back.
 */
export async function retirePendingRestartForServer(
  slockHome: string,
  marker: PendingRestartMarker,
  serverId: string,
): Promise<void> {
  const remaining = Object.fromEntries(
    Object.entries(marker.requestIds ?? {}).filter(([candidate]) => candidate !== serverId),
  );
  const originRetired = marker.originServerId === serverId;
  if (Object.keys(remaining).length === 0 && (originRetired || marker.requestIds !== undefined)) {
    await clearPendingRestartMarker(slockHome);
    return;
  }
  if (marker.requestIds === undefined) {
    // Legacy single-origin marker for another server: nothing to retire here.
    return;
  }
  await writePendingRestartMarker(slockHome, { ...marker, requestIds: remaining });
}
