import { and, asc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  MAX_JOINT_CHANNEL_FREE_SERVERS,
  MAX_JOINT_CHANNEL_SERVERS,
  canUseProBillingFeatures,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import { channels, jointChannelInvites, jointChannels, jointChannelServers, servers } from "../db/schema";
import { forEachBounded } from "../lib/boundedConcurrency";
import { getServerBillingEntitlements } from "./planService";
import { resolveParentJointId } from "./jointChannelLimitState";

// Contract v0.3 §18.5–§18.8. Every check here works on the top-level joint;
// callers holding a sub-thread joint id must resolve it first.

export type JointChannelLimitErrorCode = "joint_free_server_limit" | "joint_server_limit";

export class JointChannelLimitError extends Error {
  constructor(message: string, readonly code: JointChannelLimitErrorCode) {
    super(message);
    this.name = "JointChannelLimitError";
  }
}

const REFRESH_CONCURRENCY = 4;
const SWEEP_PAGE_SIZE = 200;

/**
 * Called after a background observer (sweep, billing sync) changes a parent
 * joint's `over_limit_since`, so open clients re-read the channel instead of
 * waiting for a reload (§18.8). Request paths (accept, disconnect) already
 * emit their own updates after commit. Wired to the socket layer by server.ts.
 */
export type JointLimitStateListener = (parentJointId: string) => Promise<void> | void;

let jointLimitStateListener: JointLimitStateListener | null = null;

export function onJointLimitStateChanged(listener: JointLimitStateListener | null): void {
  jointLimitStateListener = listener;
}

async function notifyJointLimitStateChanged(parentJointIds: readonly string[]): Promise<void> {
  const listener = jointLimitStateListener;
  if (!listener) return;
  for (const parentJointId of parentJointIds) {
    try {
      await listener(parentJointId);
    } catch (err) {
      // Best effort: the state is already stored; clients still see it on
      // their next fetch.
      console.warn(`[JointLimit] Failed to notify clients for joint ${parentJointId}:`, err instanceof Error ? err.message : err);
    }
  }
}

function sameOverLimitSince(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

/** Local channel id of one active projection, for emitting projection updates. */
export async function getActiveJointProjectionLocalChannelId(parentJointId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ localChannelId: jointChannelServers.localChannelId })
    .from(jointChannelServers)
    .where(and(eq(jointChannelServers.jointChannelId, parentJointId), eq(jointChannelServers.status, "active")))
    .limit(1);
  return row?.localChannelId ?? null;
}

export type JointLimitServers = {
  /** Active projections whose real server is not deleted (§18.5). */
  active: string[];
  /** Unexpired pending invite targets that are not already active. */
  pending: string[];
};

export async function listJointLimitServers(
  executor: DatabaseExecutor,
  parentJointId: string,
  now: Date,
): Promise<JointLimitServers> {
  const activeRows = await executor
    .select({ serverId: jointChannelServers.serverId })
    .from(jointChannelServers)
    .innerJoin(servers, eq(servers.id, jointChannelServers.serverId))
    .where(and(
      eq(jointChannelServers.jointChannelId, parentJointId),
      eq(jointChannelServers.status, "active"),
      isNull(servers.deletedAt),
    ));
  const active = [...new Set(activeRows.map((row) => row.serverId))];
  const activeSet = new Set(active);
  const pendingRows = await executor
    .selectDistinct({ serverId: jointChannelInvites.toServerId })
    .from(jointChannelInvites)
    .innerJoin(servers, eq(servers.id, jointChannelInvites.toServerId))
    .where(and(
      eq(jointChannelInvites.jointChannelId, parentJointId),
      eq(jointChannelInvites.status, "pending"),
      gt(jointChannelInvites.expiresAt, now),
      isNull(servers.deletedAt),
    ));
  const pending = pendingRows.map((row) => row.serverId).filter((id) => !activeSet.has(id));
  return { active, pending };
}

/** The one place that decides free vs paid for joint limits (§18.11 item 1). */
export async function freeServerIds(
  executor: DatabaseExecutor,
  serverIds: readonly string[],
  now: Date,
): Promise<Set<string>> {
  if (serverIds.length === 0) return new Set();
  const entitlements = await getServerBillingEntitlements(executor, serverIds, now);
  const free = new Set<string>();
  for (const serverId of serverIds) {
    const entitlement = entitlements.get(serverId);
    if (!entitlement || !canUseProBillingFeatures(entitlement.plan, now)) free.add(serverId);
  }
  return free;
}

/**
 * Refresh stale subscriptions for everyone the next admission will count.
 * Runs outside any transaction: the refresh can call the billing provider,
 * and must not hold the joint row lock while it does (§18.11 item 5).
 */
export async function refreshJointEntitlementsBeforeAdmission(
  parentJointId: string | null,
  extraServerIds: readonly string[],
  now: Date,
): Promise<void> {
  const { refreshSubscriptionForServerIfStale } = await import("./billingService");
  const ids = new Set(extraServerIds);
  if (parentJointId) {
    const listed = await listJointLimitServers(getDb(), parentJointId, now);
    for (const id of [...listed.active, ...listed.pending]) ids.add(id);
  }
  await forEachBounded([...ids], REFRESH_CONCURRENCY, async (serverId) => {
    await refreshSubscriptionForServerIfStale(serverId, now);
  });
}

export type JointAdmission =
  /** create / invite: counts active + pending + the new targets. */
  | { kind: "invite"; targetServerIds: readonly string[] }
  /** accept: counts active + the accepting server (§18.8, Tenny aae3d5ed). */
  | { kind: "accept"; serverId: string }
  /** convert: host only; called so all four entry points share one check. */
  | { kind: "convert"; hostServerId: string };

/**
 * Lock the parent joint row and reject an admission that would break a limit
 * (§18.7). Only new free servers are rejected by the free cap and only new
 * servers by the total cap, so a joint that is already over can still admit
 * paid servers (§18.8). Reads the database only; call
 * `refreshJointEntitlementsBeforeAdmission` first.
 */
export async function assertJointAdmission(
  tx: DatabaseTransaction,
  parentJointId: string | null,
  admission: JointAdmission,
  now: Date,
): Promise<void> {
  let base: string[] = [];
  if (parentJointId) {
    await tx.execute(sql`SELECT ${jointChannels.id} FROM ${jointChannels} WHERE ${jointChannels.id} = ${parentJointId} FOR UPDATE`);
    const listed = await listJointLimitServers(tx, parentJointId, now);
    base = admission.kind === "accept" ? listed.active : [...listed.active, ...listed.pending];
  }
  const baseSet = new Set(base);
  const adding = admission.kind === "invite"
    ? admission.targetServerIds
    : admission.kind === "accept" ? [admission.serverId] : [admission.hostServerId];
  const newIds = [...new Set(adding)].filter((id) => !baseSet.has(id));
  if (newIds.length === 0) return;
  const after = [...baseSet, ...newIds];

  if (after.length > MAX_JOINT_CHANNEL_SERVERS) {
    throw new JointChannelLimitError(
      `Joint channels are limited to ${MAX_JOINT_CHANNEL_SERVERS} servers.`,
      "joint_server_limit",
    );
  }
  const free = await freeServerIds(tx, after, now);
  if (free.size > MAX_JOINT_CHANNEL_FREE_SERVERS && newIds.some((id) => free.has(id))) {
    throw new JointChannelLimitError(
      `This joint channel already has ${MAX_JOINT_CHANNEL_FREE_SERVERS} free servers; one side needs to upgrade.`,
      "joint_free_server_limit",
    );
  }
}

/**
 * Record whether the parent joint is over the free-server cap among its
 * active participants (§18.8). The first observation sets `over_limit_since`;
 * later observations keep it; getting back within the cap clears it, so the
 * next overage starts a fresh round.
 */
export async function reconcileJointOverLimit(
  executor: DatabaseExecutor,
  parentJointId: string,
  now: Date,
): Promise<Date | null> {
  const { active } = await listJointLimitServers(executor, parentJointId, now);
  const free = await freeServerIds(executor, active, now);
  const over = free.size > MAX_JOINT_CHANNEL_FREE_SERVERS;
  const [row] = await executor
    .update(jointChannels)
    .set({ overLimitSince: over ? sql`COALESCE(${jointChannels.overLimitSince}, ${now})` : null })
    .where(eq(jointChannels.id, parentJointId))
    .returning({ overLimitSince: jointChannels.overLimitSince });
  return row?.overLimitSince ?? null;
}

/** Reconcile after membership changes that were keyed by any joint id. */
export async function reconcileJointOverLimitFor(
  executor: DatabaseExecutor,
  jointChannelId: string,
  now: Date,
): Promise<void> {
  const parentJointId = await resolveParentJointId(executor, jointChannelId);
  if (parentJointId) await reconcileJointOverLimit(executor, parentJointId, now);
}

function topLevelActiveJoints() {
  return and(eq(jointChannels.status, "active"), ne(channels.type, "thread"));
}

/** Billing-change hook: re-evaluate every top-level joint the server is active in. */
export async function reconcileJointsForServer(serverId: string, now: Date = new Date()): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ jointChannelId: jointChannels.id, overLimitSince: jointChannels.overLimitSince })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .innerJoin(channels, eq(channels.id, jointChannels.canonicalChannelId))
    .where(and(
      eq(jointChannelServers.serverId, serverId),
      eq(jointChannelServers.status, "active"),
      topLevelActiveJoints(),
    ));
  const changed: string[] = [];
  for (const row of rows) {
    const after = await reconcileJointOverLimit(db, row.jointChannelId, now);
    if (!sameOverLimitSince(row.overLimitSince, after)) changed.push(row.jointChannelId);
  }
  await notifyJointLimitStateChanged(changed);
}

export type JointOverLimitSweepResult = { scanned: number; over: number; started: number; cleared: number };

/**
 * Periodic observer (§18.8): finds joints that went over without anyone
 * posting, so notices appear and the grace expires on time. Existing joints
 * that are already over are first observed by the first sweep after launch,
 * which is exactly "grace starts at launch" (§18.9); no backfill needed.
 */
export async function sweepJointOverLimit(now: Date = new Date()): Promise<JointOverLimitSweepResult> {
  const db = getDb();
  const result: JointOverLimitSweepResult = { scanned: 0, over: 0, started: 0, cleared: 0 };
  let afterId: string | null = null;
  const changed: string[] = [];
  for (;;) {
    const page: { id: string; overLimitSince: Date | null }[] = await db
      .select({ id: jointChannels.id, overLimitSince: jointChannels.overLimitSince })
      .from(jointChannels)
      .innerJoin(channels, eq(channels.id, jointChannels.canonicalChannelId))
      .where(afterId ? and(topLevelActiveJoints(), gt(jointChannels.id, afterId)) : topLevelActiveJoints())
      .orderBy(asc(jointChannels.id))
      .limit(SWEEP_PAGE_SIZE);
    if (page.length === 0) break;
    afterId = page[page.length - 1]!.id;
    result.scanned += page.length;

    const participants = await db
      .select({ jointChannelId: jointChannelServers.jointChannelId, serverId: jointChannelServers.serverId })
      .from(jointChannelServers)
      .innerJoin(servers, eq(servers.id, jointChannelServers.serverId))
      .where(and(
        inArray(jointChannelServers.jointChannelId, page.map((row) => row.id)),
        eq(jointChannelServers.status, "active"),
        isNull(servers.deletedAt),
      ));
    const free = await freeServerIds(db, [...new Set(participants.map((row) => row.serverId))], now);
    const freeCount = new Map<string, number>();
    for (const row of participants) {
      if (free.has(row.serverId)) freeCount.set(row.jointChannelId, (freeCount.get(row.jointChannelId) ?? 0) + 1);
    }

    const toStart: string[] = [];
    const toClear: { id: string; overLimitSince: Date }[] = [];
    for (const row of page) {
      const over = (freeCount.get(row.id) ?? 0) > MAX_JOINT_CHANNEL_FREE_SERVERS;
      if (over) result.over += 1;
      if (over && !row.overLimitSince) toStart.push(row.id);
      if (!over && row.overLimitSince) toClear.push({ id: row.id, overLimitSince: row.overLimitSince });
    }
    if (toStart.length > 0) {
      const started = await db.update(jointChannels)
        .set({ overLimitSince: now })
        .where(and(inArray(jointChannels.id, toStart), isNull(jointChannels.overLimitSince)))
        .returning({ id: jointChannels.id });
      result.started += started.length;
      changed.push(...started.map((row) => row.id));
    }
    // Compare-and-clear: only clear the round this page read. A write path
    // may have recorded a new round between the read and this update.
    // Exact match relies on every writer storing a JS Date (millisecond
    // precision). A writer using SQL now() (microseconds) would never match
    // here, leaving a recovered joint to go read-only after its grace.
    for (const row of toClear) {
      const cleared = await db.update(jointChannels)
        .set({ overLimitSince: null })
        .where(and(eq(jointChannels.id, row.id), eq(jointChannels.overLimitSince, row.overLimitSince)))
        .returning({ id: jointChannels.id });
      result.cleared += cleared.length;
      if (cleared.length > 0) changed.push(row.id);
    }
    if (page.length < SWEEP_PAGE_SIZE) break;
  }
  await notifyJointLimitStateChanged(changed);
  return result;
}
