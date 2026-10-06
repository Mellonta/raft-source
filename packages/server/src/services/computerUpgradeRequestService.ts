import { and, desc, eq, inArray, isNull, lte } from "drizzle-orm";

import { getDb, type DatabaseExecutor } from "../db/index";
import { computerUpgradeRequests } from "../db/schema";
import type { ComputerLastUpgradeReceipt } from "@botiverse/raft-shared";

/**
 * Remote upgrade v2 (task #873). One request row per web-triggered upgrade.
 * The installer guarantees success-or-rollback, so the Server keeps exactly
 * three facts: what was asked, what version the machine reported when it came
 * back, and whether it came back in time. Nothing in between is modelled.
 */

export const UPGRADE_REQUEST_DEADLINE_MS = 30 * 60 * 1000;

export type ComputerUpgradeRequestRow = typeof computerUpgradeRequests.$inferSelect;
export type ComputerUpgradeRequestOutcome = NonNullable<ComputerUpgradeRequestRow["outcome"]>;

export interface ComputerUpgradeRequestProjection {
  id: string;
  targetVersion: string;
  requestedAt: string;
  state: "pending" | ComputerUpgradeRequestOutcome;
  observedVersion: string | null;
  reason: string | null;
  resolvedAt: string | null;
}

export function projectComputerUpgradeRequest(row: ComputerUpgradeRequestRow): ComputerUpgradeRequestProjection {
  return {
    id: row.id,
    targetVersion: row.targetVersion,
    requestedAt: row.requestedAt.toISOString(),
    state: row.outcome ?? "pending",
    observedVersion: row.observedVersion,
    reason: row.reason,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

export async function getOpenComputerUpgradeRequest(
  machineId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<ComputerUpgradeRequestRow | null> {
  const [row] = await executor
    .select()
    .from(computerUpgradeRequests)
    .where(and(eq(computerUpgradeRequests.machineId, machineId), isNull(computerUpgradeRequests.outcome)))
    .orderBy(desc(computerUpgradeRequests.requestedAt))
    .limit(1);
  return row ?? null;
}

/** Creates the request unless one is already open for the machine, which is returned instead. */
export async function createComputerUpgradeRequest(input: {
  serverId: string;
  machineId: string;
  targetVersion: string;
  requestedByUserId: string;
  now?: Date;
  deadlineMs?: number;
}, executor: DatabaseExecutor = getDb()): Promise<{ row: ComputerUpgradeRequestRow; created: boolean }> {
  const existing = await getOpenComputerUpgradeRequest(input.machineId, executor);
  if (existing) return { row: existing, created: false };
  const now = input.now ?? new Date();
  const [row] = await executor.insert(computerUpgradeRequests).values({
    serverId: input.serverId,
    machineId: input.machineId,
    targetVersion: input.targetVersion,
    requestedByUserId: input.requestedByUserId,
    requestedAt: now,
    deadlineAt: new Date(now.getTime() + (input.deadlineMs ?? UPGRADE_REQUEST_DEADLINE_MS)),
  }).returning();
  return { row: row!, created: true };
}

/**
 * The only observation: the version a machine reports when it (re)connects.
 * Equal to the target → done. Different → failed, with the installer's
 * one-line reason when the successor carried a receipt. No open request →
 * nothing to do.
 */
export async function observeComputerVersionForUpgradeRequests(input: {
  machineId: string;
  reportedVersion: string | null | undefined;
  receipt?: ComputerLastUpgradeReceipt | null;
  now?: Date;
}, executor: DatabaseExecutor = getDb()): Promise<ComputerUpgradeRequestRow | null> {
  const version = input.reportedVersion?.trim();
  if (!version) return null;
  const open = await getOpenComputerUpgradeRequest(input.machineId, executor);
  if (!open) return null;
  const now = input.now ?? new Date();
  const done = version === open.targetVersion;
  const receipt = input.receipt && input.receipt.targetVersion === open.targetVersion ? input.receipt : null;
  const reason = done
    ? null
    : receipt?.reason ?? (receipt ? `installer_${receipt.outcome}` : "version_unchanged");
  const [row] = await executor
    .update(computerUpgradeRequests)
    .set({
      outcome: done ? "done" : "failed",
      observedVersion: version,
      reason,
      resolvedAt: now,
    })
    .where(and(eq(computerUpgradeRequests.id, open.id), isNull(computerUpgradeRequests.outcome)))
    .returning();
  return row ?? null;
}

/** Requests whose machine did not come back before the deadline. */
export async function expireComputerUpgradeRequests(
  now: Date = new Date(),
  executor: DatabaseExecutor = getDb(),
): Promise<ComputerUpgradeRequestRow[]> {
  return executor
    .update(computerUpgradeRequests)
    .set({ outcome: "no_response", reason: "no_reconnect_before_deadline", resolvedAt: now })
    .where(and(isNull(computerUpgradeRequests.outcome), lte(computerUpgradeRequests.deadlineAt, now)))
    .returning();
}

/** Latest request per machine (open first, otherwise the most recent resolved one). */
export async function listLatestComputerUpgradeRequests(
  machineIds: string[],
  executor: DatabaseExecutor = getDb(),
): Promise<Map<string, ComputerUpgradeRequestRow>> {
  const result = new Map<string, ComputerUpgradeRequestRow>();
  if (machineIds.length === 0) return result;
  const rows = await executor
    .select()
    .from(computerUpgradeRequests)
    .where(inArray(computerUpgradeRequests.machineId, machineIds))
    .orderBy(desc(computerUpgradeRequests.requestedAt));
  for (const row of rows) {
    const current = result.get(row.machineId);
    if (!current) { result.set(row.machineId, row); continue; }
    if (current.outcome !== null && row.outcome === null) result.set(row.machineId, row);
  }
  return result;
}
