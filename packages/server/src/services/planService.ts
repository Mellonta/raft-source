import { createHash } from "node:crypto";
import { eq, and, isNull, sql, inArray, ne } from "drizzle-orm";
import { getDb, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import { isChannelReadOnlyByJointLimit } from "./jointChannelLimitState";
import { servers, agents, machines, channels, channelHumans, serverMembers, subscriptions } from "../db/schema";
import {
  PLAN_CONFIG,
  canUseProBillingFeatures,
  currentDate,
  formatBillingCapacityLimitMessage,
  getBillingCapacity,
  getBillingCapacityLimitState,
  getBillingUsage,
  getEffectiveLimits,
  type BillingCapacity,
  type BillingEntitlementProjection,
  type BillingUsage,
  type ServerPlan,
} from "@botiverse/raft-shared";

type ServerResourceLockProbeForTest = (event: {
  phase: "arrival" | "requested" | "acquired";
  serverId: string;
  namespace: number;
  resourceKey: string;
  mode: "exclusive" | "shared";
}) => Promise<void> | void;

let serverResourceLockProbeForTest: ServerResourceLockProbeForTest | null = null;
let beforeServerResourceLockQueryForTest: ServerResourceLockProbeForTest | null = null;

export function setServerResourceLockProbeForTest(probe: ServerResourceLockProbeForTest | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("server resource lock probes are test-only");
  }
  serverResourceLockProbeForTest = probe;
}

export function setBeforeServerResourceLockQueryForTest(
  hook: ServerResourceLockProbeForTest | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("server resource lock hooks are test-only");
  }
  beforeServerResourceLockQueryForTest = hook;
}

/** Get the plan for a server. */
export async function getServerPlan(serverId: string): Promise<ServerPlan> {
  const db = getDb();
  const [row] = await db
    .select({ plan: servers.plan })
    .from(servers)
    .where(eq(servers.id, serverId));
  return (row?.plan as ServerPlan) || "free";
}

function isSubscriptionEntitling(status: string): boolean {
  return status === "active" || status === "past_due";
}

function isInternalEntitlementPlan(plan: ServerPlan): boolean {
  return plan === "founder" || plan === "partner";
}

export type ServerBillingEntitlement = BillingEntitlementProjection & {
  source: "server" | "subscription";
  capacity: BillingCapacity;
};

type ServerBillingEntitlementRow = {
  serverId: string;
  serverPlan: ServerPlan;
  subscriptionPlan: "pro" | null;
  status: BillingEntitlementProjection["status"];
  billingInterval: BillingEntitlementProjection["billingInterval"];
  provisionedHumanSeats: number | null;
  provisionedAgentSeats: number | null;
  proPackQuantity: number | null;
  trialFreePackQuantity: number | null;
  firstPackTrialEndsAt: Date | null;
};

function projectServerBillingEntitlement(
  row: ServerBillingEntitlementRow | undefined,
  now: Date,
): ServerBillingEntitlement {
  const fallbackPlan = (row?.serverPlan as ServerPlan | undefined) ?? "free";
  const hasSubscription = Boolean(row?.subscriptionPlan);
  const hasEntitlingSubscription = Boolean(row?.subscriptionPlan && row.status && isSubscriptionEntitling(row.status));
  const hasInternalEntitlement = isInternalEntitlementPlan(fallbackPlan);
  const plan = (hasInternalEntitlement
    ? fallbackPlan
    : hasEntitlingSubscription
    ? row?.subscriptionPlan
    : hasSubscription
      ? "free"
      : fallbackPlan) as ServerPlan;
  const projection: BillingEntitlementProjection = {
    plan,
    status: row?.status ?? null,
    billingInterval: hasEntitlingSubscription && !hasInternalEntitlement ? row?.billingInterval ?? null : null,
    provisionedHumanSeats: hasEntitlingSubscription && !hasInternalEntitlement ? row?.provisionedHumanSeats ?? null : null,
    provisionedAgentSeats: hasEntitlingSubscription && !hasInternalEntitlement ? row?.provisionedAgentSeats ?? null : null,
    proPackQuantity: hasEntitlingSubscription && !hasInternalEntitlement ? row?.proPackQuantity ?? null : null,
    trialFreePackQuantity: hasEntitlingSubscription && !hasInternalEntitlement ? row?.trialFreePackQuantity ?? null : null,
    firstPackTrialEndsAt: hasEntitlingSubscription && !hasInternalEntitlement ? row?.firstPackTrialEndsAt ?? null : null,
  };

  return {
    ...projection,
    source: hasEntitlingSubscription && !hasInternalEntitlement ? "subscription" : "server",
    capacity: getBillingCapacity(projection, now),
  };
}

/** Batch entitlement read used by feature-flag evaluation to avoid per-flag N+1. */
export async function getServerBillingEntitlements(
  executor: DatabaseExecutor,
  serverIds: readonly string[],
  now: Date = currentDate(),
): Promise<Map<string, ServerBillingEntitlement>> {
  const uniqueServerIds = [...new Set(serverIds.filter(Boolean))];
  if (uniqueServerIds.length === 0) return new Map();

  const rows = await executor
    .select({
      serverId: servers.id,
      serverPlan: servers.plan,
      subscriptionPlan: subscriptions.plan,
      status: subscriptions.status,
      billingInterval: subscriptions.billingInterval,
      provisionedHumanSeats: subscriptions.provisionedHumanSeats,
      provisionedAgentSeats: subscriptions.provisionedAgentSeats,
      proPackQuantity: subscriptions.proPackQuantity,
      trialFreePackQuantity: subscriptions.trialFreePackQuantity,
      firstPackTrialEndsAt: subscriptions.firstPackTrialEndsAt,
    })
    .from(servers)
    .leftJoin(subscriptions, eq(subscriptions.serverId, servers.id))
    .where(and(inArray(servers.id, uniqueServerIds), isNull(servers.deletedAt)));

  const rowByServerId = new Map(rows.map((row) => [row.serverId, row]));
  return new Map(uniqueServerIds.map((serverId) => [
    serverId,
    projectServerBillingEntitlement(rowByServerId.get(serverId), now),
  ]));
}

export async function getServerBillingEntitlement(
  executor: DatabaseExecutor,
  serverId: string,
  now: Date = new Date(),
): Promise<ServerBillingEntitlement> {
  const entitlements = await getServerBillingEntitlements(executor, [serverId], now);
  return entitlements.get(serverId) ?? projectServerBillingEntitlement(undefined, now);
}

export async function getServerBillingUsage(
  executor: DatabaseExecutor,
  serverId: string,
): Promise<BillingUsage> {
  const [humanRow] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), ne(serverMembers.role, "guest")));
  const [agentRow] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(agents)
    .where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt)));
  return getBillingUsage(humanRow?.count ?? 0, agentRow?.count ?? 0);
}

export function assertHumanCapacityAvailable(
  entitlement: ServerBillingEntitlement,
  usage: BillingUsage,
): void {
  const limitState = getBillingCapacityLimitState(entitlement.capacity, usage, "human");
  if (limitState.reached) {
    throw new HumanSeatLimitError(
      formatBillingCapacityLimitMessage("human", limitState, PLAN_CONFIG[entitlement.plan].displayName),
    );
  }
}

export class HumanSeatLimitError extends Error {
  readonly code = "human_seat_limit_reached";

  constructor(message: string) {
    super(message);
    this.name = "HumanSeatLimitError";
  }
}

export class GuestJoinableChannelLimitError extends Error {
  readonly code = "guest_joinable_channel_limit_reached";

  constructor(public readonly limit: number) {
    super(`Server already has ${limit} Guest-joinable channels; disable Guest Join on another channel first`);
    this.name = "GuestJoinableChannelLimitError";
  }
}

export async function assertGuestJoinableChannelCapacityAvailable(
  executor: DatabaseExecutor,
  serverId: string,
  additionalChannels = 1,
): Promise<void> {
  const entitlement = await getServerBillingEntitlement(executor, serverId);
  const limit = getEffectiveLimits(entitlement.plan).maxGuestJoinableChannelsPerServer;
  if (limit < 0) return;
  const [usage] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(channels)
    .where(and(
      eq(channels.serverId, serverId),
      eq(channels.guestJoinable, true),
      ne(channels.name, "all"),
      isNull(channels.archivedAt),
      isNull(channels.deletedAt),
    ));
  if ((usage?.count ?? 0) + additionalChannels > limit) throw new GuestJoinableChannelLimitError(limit);
}

export function assertAgentCapacityAvailable(
  entitlement: ServerBillingEntitlement,
  usage: BillingUsage,
): void {
  const limitState = getBillingCapacityLimitState(entitlement.capacity, usage, "agent");
  if (limitState.reached) {
    throw new Error(formatBillingCapacityLimitMessage("agent", limitState, PLAN_CONFIG[entitlement.plan].displayName, " Upgrade for more."));
  }
}

async function refreshSubscriptionBeforeEntitlementGate(serverId: string, now: Date): Promise<void> {
  const { refreshSubscriptionForServerIfStale } = await import("./billingService");
  await refreshSubscriptionForServerIfStale(serverId, now);
}

export async function requireTeamBillingFeature(
  executor: DatabaseExecutor,
  serverId: string,
  featureName: string,
  now: Date = new Date(),
): Promise<void> {
  await refreshSubscriptionBeforeEntitlementGate(serverId, now);
  const entitlement = await getServerBillingEntitlement(executor, serverId, now);
  if (!canUseProBillingFeatures(entitlement.plan, now)) {
    throw new Error(`${featureName} requires the Pro plan.`);
  }
}

/** Count agents in a server. */
export async function countAgents(serverId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agents)
    .where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt)));
  return row?.count ?? 0;
}

/** Count non-deleted regular channels in a server (includes system #all). */
export async function countChannels(serverId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(channels)
    .where(and(eq(channels.serverId, serverId), inArray(channels.type, ["channel", "private"]), isNull(channels.deletedAt)));
  return row?.count ?? 0;
}

/**
 * Check if a channel is read-only due to quota.
 * When a server has more channels than the plan allows, the newest channels
 * (beyond the limit) become read-only. Oldest N channels remain writable.
 */
export async function isChannelReadOnlyByQuota(channelId: string, serverId: string, _now?: Date): Promise<boolean> {
  const plan = await getServerPlan(serverId);
  const maxChannels = getEffectiveLimits(plan, _now).maxChannels;
  if (maxChannels === -1) return false;

  const db = getDb();
  // Get all non-deleted regular channels ordered by createdAt ASC (oldest first)
  const allChannels = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.serverId, serverId), inArray(channels.type, ["channel", "private"]), isNull(channels.deletedAt)))
    .orderBy(channels.createdAt);

  if (allChannels.length <= maxChannels) return false;

  // The first maxChannels channels (oldest) are writable; the rest are read-only
  const writableIds = new Set(allChannels.slice(0, maxChannels).map((c) => c.id));
  return !writableIds.has(channelId);
}

/**
 * Joint channels are read-only once the parent joint's over-limit grace has
 * passed (contract v0.3 §18.8). The name is kept because every write path
 * (messages, uploads, attachments, comments, channels, internal, agent API)
 * already calls it; the rule itself lives in jointChannelLimitState and reads
 * one stored field, with no per-message billing lookups.
 */
export async function isChannelReadOnlyByBillingFeature(channelId: string, serverId: string, now: Date = new Date()): Promise<boolean> {
  return isChannelReadOnlyByJointLimit(channelId, serverId, now);
}

/** Count machines in a server. */
export async function countMachines(serverId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(machines)
    .where(eq(machines.serverId, serverId));
  return row?.count ?? 0;
}

/**
 * Get the message history cutoff date based on plan.
 * Returns undefined if unlimited (no filter needed).
 */
export function getHistoryCutoff(plan: ServerPlan, now: Date = new Date()): Date | undefined {
  const days = getEffectiveLimits(plan, now).messageHistoryDays;
  if (days === -1) return undefined;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);
  return cutoff;
}

// ── Atomic quota-guarded inserts ──

// Agent creation and pre-checkpoint setup reset are two competing answers to the same
// server-level question, so they must never drift onto different advisory namespaces.
// The numeric value is intentionally unimportant; sharing this symbol is the contract.
export const AGENT_CREATE_LOCK_NAMESPACE = 1;
export const GUEST_JOINABLE_CHANNEL_LOCK_NAMESPACE = 4;

/**
 * Convert a UUID string to a stable int for pg_advisory_xact_lock.
 * Uses first 8 hex chars → 32-bit signed integer.
 */
function serverIdToLockKey(serverId: string): number {
  const hex = serverId.replace(/-/g, "").slice(0, 8);
  return parseInt(hex, 16) | 0; // force 32-bit signed
}

function resourceToLockKey(namespace: number, resourceKey: string): number {
  const digest = createHash("sha256").update(`${namespace}:${resourceKey}`).digest();
  return digest.readInt32BE(0);
}

/**
 * Run a callback inside a transaction with a per-server advisory lock.
 * Concurrent calls for the same serverId + namespace will serialize.
 * The lock is released automatically when the transaction commits/rolls back.
 *
 * @param serverId - The server to lock on
 * @param namespace - Second lock key to separate agent vs machine locks (e.g. 1 for agents, 2 for machines)
 * @param fn - Callback receiving a transaction-scoped Drizzle instance
 */
export async function withServerLock<T>(
  serverId: string,
  namespace: number,
  fn: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${serverIdToLockKey(serverId)}, ${namespace})`);
    return fn(tx);
  });
}

export async function acquireServerLock(
  executor: DatabaseExecutor,
  serverId: string,
  namespace: number,
): Promise<void> {
  await executor.execute(sql`SELECT pg_advisory_xact_lock(${serverIdToLockKey(serverId)}, ${namespace})`);
}

/**
 * The one lock for the first-Agent checkpoint.
 *
 * Agent creation and pre-checkpoint setup reset must call this helper instead of choosing a
 * namespace independently. Source ratchets pin both call sites and this exact withServerLock
 * delegation; a separate PGlite tooth covers the caller-observed serialization contract.
 */
let agentCreateLockObserverForTests: ((serverId: string) => void) | null = null;

export function __setAgentCreateLockObserverForTests(
  observer: ((serverId: string) => void) | null,
): void {
  agentCreateLockObserverForTests = observer;
}

export function withAgentCreateLock<T>(
  serverId: string,
  fn: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  agentCreateLockObserverForTests?.(serverId);
  return withServerLock(serverId, AGENT_CREATE_LOCK_NAMESPACE, fn);
}

/**
 * Run a callback inside a transaction with a per-server, per-resource advisory lock.
 * Concurrent calls for the same serverId + namespace + resourceKey will serialize,
 * while unrelated resources in the same server can proceed independently.
 */
export async function withServerResourceLock<T>(
  serverId: string,
  namespace: number,
  resourceKey: string,
  fn: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.transaction(async (tx) => {
    await lockServerResourceInTransaction(tx, serverId, namespace, resourceKey);
    return fn(tx);
  });
}

/**
 * Acquire a per-server resource lock inside an existing transaction.
 *
 * `mode: "shared"` takes the shared form of the same advisory key: shared
 * holders never block each other and only conflict with an exclusive holder.
 * A transaction must not take a key shared and later exclusive — two such
 * transactions deadlock on the upgrade.
 */
export async function lockServerResourceInTransaction(
  tx: DatabaseExecutor,
  serverId: string,
  namespace: number,
  resourceKey: string,
  mode: "exclusive" | "shared" = "exclusive",
): Promise<void> {
  const probe = serverResourceLockProbeForTest;
  const event = { serverId, namespace, resourceKey, mode };
  await probe?.({ phase: "arrival", ...event });
  await beforeServerResourceLockQueryForTest?.({ phase: "arrival", ...event });
  const serverKey = serverIdToLockKey(serverId);
  const resourceLockKey = resourceToLockKey(namespace, resourceKey);
  const lock = mode === "shared"
    ? tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${serverKey}, ${resourceLockKey})`)
    : tx.execute(sql`SELECT pg_advisory_xact_lock(${serverKey}, ${resourceLockKey})`);
  // `requested` belongs to the lower primitive and is emitted only after the
  // real advisory SQL call has returned its in-flight promise. A wrapper may
  // observe arrival, but it cannot attest that PostgreSQL has been asked.
  await probe?.({ phase: "requested", ...event });
  await lock;
  await probe?.({ phase: "acquired", ...event });
}
