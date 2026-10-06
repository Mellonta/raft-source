import { createHash, randomUUID } from "node:crypto";
import { asc, eq, inArray, sql, and, or } from "drizzle-orm";
import { getDb, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import {
  featureFlagConfigVersions,
  featureFlagAudienceMembers,
  featureFlagAudiences,
  featureFlagRules,
  featureFlags,
  labDefinitions,
  servers,
  serverLabAccess,
  serverLabEnrollments,
} from "../db/schema";
import { getServerBillingEntitlements, type ServerBillingEntitlement } from "./planService";
import {
  AGENT_MIGRATION_FEATURE_FLAG_KEY as SHARED_AGENT_MIGRATION_FEATURE_FLAG_KEY,
  APPLE_WEB_LOGIN_FEATURE_FLAG_KEY as SHARED_APPLE_WEB_LOGIN_FEATURE_FLAG_KEY,
  CHAT_GRID_LAYOUT_FEATURE_FLAG_KEY as SHARED_CHAT_GRID_LAYOUT_FEATURE_FLAG_KEY,
  CHANNEL_TO_JOINT_CONVERSION_FEATURE_FLAG_KEY as SHARED_CHANNEL_TO_JOINT_CONVERSION_FEATURE_FLAG_KEY,
  COMPOSER_RESOURCE_REFERENCES_FEATURE_FLAG_KEY as SHARED_COMPOSER_RESOURCE_REFERENCES_FEATURE_FLAG_KEY,
  PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY as SHARED_PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
  PUBLIC_SERVER_FEATURE_FLAG_KEY as SHARED_PUBLIC_SERVER_FEATURE_FLAG_KEY,
  SERVER_LABS_UI_FEATURE_FLAG_KEY as SHARED_SERVER_LABS_UI_FEATURE_FLAG_KEY,
  SERVER_GUEST_FEATURE_FLAG_KEY as SHARED_SERVER_GUEST_FEATURE_FLAG_KEY,
  REMOTE_COMPUTER_UPGRADE_V2_FEATURE_FLAG_KEY as SHARED_REMOTE_COMPUTER_UPGRADE_V2_FEATURE_FLAG_KEY,
  canUseProBillingFeatures,
  clientRuleConstraintsSatisfied,
  clientRuleShapeError,
  currentDate,
  findClientRuleBypassConflicts,
  type FeatureFlagClientFacts,
  type FeatureFlagClientRuleBypassConflict,
  type FeatureFlagRuleForConflictCheck,
  type FeatureFlagRuleShapeInput,
} from "@botiverse/raft-shared";

export const FEATURE_FLAG_CONFIG_SCOPE_GLOBAL = "global";
export const ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY = "attachment_comments_v0";
export const ATTACHMENT_DIRECT_UPLOAD_FEATURE_FLAG_KEY = "attachment_direct_upload_v0";
/**
 * Recent search on a dense term walks only the caller's server
 * (message_server_timeline). Absent = off (global walk); turn on only after the
 * timeline verified 0/0; kill_switch reverts to the global walk without a deploy.
 */
export const SEARCH_SERVER_TIMELINE_WALK_FEATURE_FLAG_KEY = "search_server_timeline_walk";
export const ATTACHMENT_ORIGINAL_STORAGE_V2_FEATURE_FLAG_KEY = "attachment_original_storage_v2";
export const ATTACHMENT_PREVIEW_UNIFIED_FEATURE_FLAG_KEY = "attachment_preview_unified_v0";
export const PUBLIC_DERIVED_STORAGE_V2_FEATURE_FLAG_KEY = "public_derived_storage_v2";
export const ONBOARDING_OPENER_V2_FEATURE_FLAG_KEY = "onboarding_opener_v2";
export const ONBOARDING_OWNER_WIZARD_FEATURE_FLAG_KEY = "onboarding_owner_wizard_v0";
export const AGENT_MIGRATION_FEATURE_FLAG_KEY = SHARED_AGENT_MIGRATION_FEATURE_FLAG_KEY;
export const APPLE_WEB_LOGIN_FEATURE_FLAG_KEY = SHARED_APPLE_WEB_LOGIN_FEATURE_FLAG_KEY;
export const CHAT_GRID_LAYOUT_FEATURE_FLAG_KEY = SHARED_CHAT_GRID_LAYOUT_FEATURE_FLAG_KEY;
export const CHANNEL_TO_JOINT_CONVERSION_FEATURE_FLAG_KEY = SHARED_CHANNEL_TO_JOINT_CONVERSION_FEATURE_FLAG_KEY;
export const COMPOSER_RESOURCE_REFERENCES_FEATURE_FLAG_KEY = SHARED_COMPOSER_RESOURCE_REFERENCES_FEATURE_FLAG_KEY;
export const READ_RECEIPTS_FEATURE_FLAG_KEY = "read_receipts_v0";
export const MOBILE_PUSH_DELIVERY_FEATURE_FLAG_KEY = "mobile_push_delivery_v0";
export const GROK_RUNTIME_FEATURE_FLAG_KEY = "grok_runtime_v0";
export const LLM_TRANSLATION_FEATURE_FLAG_KEY = "llm_translation_v0";
export const PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY = SHARED_PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY;
export const PUBLIC_SERVER_FEATURE_FLAG_KEY = SHARED_PUBLIC_SERVER_FEATURE_FLAG_KEY;
export const SERVER_LABS_UI_FEATURE_FLAG_KEY = SHARED_SERVER_LABS_UI_FEATURE_FLAG_KEY;
export const SERVER_GUEST_FEATURE_FLAG_KEY = SHARED_SERVER_GUEST_FEATURE_FLAG_KEY;
export const REMOTE_COMPUTER_UPGRADE_V2_FEATURE_FLAG_KEY = SHARED_REMOTE_COMPUTER_UPGRADE_V2_FEATURE_FLAG_KEY;
/**
 * RFC 070 constructed wake context (at-wake session recycling with a
 * constructed briefing, the cold-idle sweep, and the startup MEMORY.md block).
 * Server-scoped, default OFF: evaluated at each agent start and sent to the
 * daemon as `AgentConfig.constructedWakeContext`; a missing flag or any
 * evaluation failure leaves the behavior off.
 */
export const CONSTRUCTED_WAKE_CONTEXT_FEATURE_FLAG_KEY = "constructed_wake_context";

/**
 * Sub-agent delegation prompt: named agents whose runtime can start sub-agents
 * are told to stay on Raft (think, reply fast, coordinate) and hand hands-on
 * work to parallel sub-agents. Server-scoped, default OFF: evaluated at each
 * agent start and sent to the daemon as `AgentConfig.subagentDelegation`; a
 * missing flag or any evaluation failure leaves the prompt unchanged.
 */
export const SUBAGENT_DELEGATION_FEATURE_FLAG_KEY = "subagent_delegation_prompt";

/**
 * RFC 072 §7 passive AX ("peripheral vision": command-guidance holds and
 * context-scoped thread evidence). Server-scoped, default OFF: evaluated at
 * each agent start and sent to the daemon as `AgentConfig.passiveAx`; a
 * missing flag or any evaluation failure leaves it off. The daemon composes
 * it with its local `RAFT_PASSIVE_AX=0` kill switch and hands the result to
 * the CLI through the context-generation record (task #359).
 */
export const PASSIVE_AX_FEATURE_FLAG_KEY = "passive_ax";

const FEATURE_FLAG_LOCK_NAMESPACE = 0x46464c47; // "FFLG"
const FEATURE_FLAG_CONFIG_VERSION_LOCK_NAMESPACE = 0x46464356; // "FFCV"
const FEATURE_FLAG_CONFIG_VERSION_LOCK_KEY = 0;
const RULE_STAGE_ORDER = ["user", "platform", "client", "server", "audience", "lab", "plan", "percentage"] as const;
const LAB_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const AUDIENCE_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;

export class FeatureFlagRuleValidationError extends Error {
  override readonly name = "FeatureFlagRuleValidationError";
}

export class FeatureFlagConfigVersionConflictError extends Error {
  override readonly name = "FeatureFlagConfigVersionConflictError";

  constructor(readonly currentVersion: number) {
    super("Feature flag config version changed.");
  }
}

export class FeatureFlagServerRuleAlreadyExistsError extends Error {
  override readonly name = "FeatureFlagServerRuleAlreadyExistsError";
}

export class FeatureFlagPlatformRuleAlreadyExistsError extends Error {
  override readonly name = "FeatureFlagPlatformRuleAlreadyExistsError";
}

export type FeatureFlagRandomizationUnit = "user" | "server";
export type FeatureFlagPlatform = "web" | "mobile";
// `client` stage definitions are shared with the Feature Flag Admin (task #1144).
export {
  FEATURE_FLAG_CLIENT_BUILD_TYPES,
  FEATURE_FLAG_CLIENT_OS_VALUES,
  clientRuleConstraintsSatisfied,
  findClientRuleBypassConflicts,
  parseFeatureFlagClientFacts,
  type FeatureFlagClientBuildType,
  type FeatureFlagClientFacts,
  type FeatureFlagClientOs,
} from "@botiverse/raft-shared";
export type FeatureFlagRuleStage = (typeof RULE_STAGE_ORDER)[number];
export type FeatureFlagRuleDecision = "allow" | "deny";
export type FeatureFlagOperatorActor = {
  type: "human" | "agent";
  id: string;
};

export type FeatureFlagReason =
  | "missing_flag"
  | "kill_switch"
  | "flag_disabled"
  | "missing_user_unit"
  | "missing_server_unit"
  | "user_rule"
  | "platform_rule"
  | "client_rule"
  | "server_rule"
  | "audience_rule"
  | "lab_rule"
  | "plan_rule"
  | "percentage_rule"
  | "default";

export interface FeatureFlagEvaluation {
  key: string;
  enabled: boolean;
  reason: FeatureFlagReason;
  variant?: string;
}

export interface EvaluateFeatureFlagInput {
  key: string;
  userId?: string | null;
  serverId?: string | null;
  platform?: FeatureFlagPlatform | null;
  client?: FeatureFlagClientFacts | null;
}

type FeatureFlagRow = typeof featureFlags.$inferSelect;
type FeatureFlagRuleRow = typeof featureFlagRules.$inferSelect;
type EffectiveLabKeysByServer = ReadonlyMap<string, ReadonlySet<string>>;

type FeatureFlagEvaluationPreload = {
  matchingAudienceKeysByIdentity: ReadonlyMap<string, ReadonlySet<string>>;
  effectiveLabKeysByServer: EffectiveLabKeysByServer;
  billingEntitlementByServer: ReadonlyMap<string, ServerBillingEntitlement>;
  now: Date;
};

function featureFlagLockKey(flagKey: string): number {
  const digest = createHash("sha256").update(flagKey).digest();
  return digest.readInt32BE(0);
}

/**
 * Global serialization point for authoritative rollout writers. Callers that
 * also need a per-flag lock must acquire this lock first on every code path.
 */
export async function acquireFeatureFlagConfigVersionLock(tx: DatabaseTransaction): Promise<void> {
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      ${FEATURE_FLAG_CONFIG_VERSION_LOCK_NAMESPACE},
      ${FEATURE_FLAG_CONFIG_VERSION_LOCK_KEY}
    )
  `);
}

/** Shared per-flag lock used by both legacy mutations and the rollout writer. */
export async function acquireFeatureFlagLock(tx: DatabaseTransaction, flagKey: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${FEATURE_FLAG_LOCK_NAMESPACE}, ${featureFlagLockKey(flagKey)})`);
}

export async function withFeatureFlagLock<T>(
  flagKey: string,
  fn: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.transaction(async (tx) => {
    await acquireFeatureFlagLock(tx, flagKey);
    return fn(tx);
  });
}

export async function getFeatureFlagConfigVersion(executor: DatabaseExecutor = getDb()): Promise<number> {
  const [row] = await executor
    .select({ version: featureFlagConfigVersions.version })
    .from(featureFlagConfigVersions)
    .where(eq(featureFlagConfigVersions.scope, FEATURE_FLAG_CONFIG_SCOPE_GLOBAL));
  return row?.version ?? 0;
}

export async function bumpFeatureFlagConfigVersion(
  input: {
    updatedBy?: string | null;
    lastAuditEventId?: string | null;
  } = {},
  executor: DatabaseExecutor = getDb(),
): Promise<number> {
  const now = new Date();
  const [row] = await executor
    .insert(featureFlagConfigVersions)
    .values({
      scope: FEATURE_FLAG_CONFIG_SCOPE_GLOBAL,
      version: 1,
      updatedAt: now,
      updatedBy: input.updatedBy ?? null,
      lastAuditEventId: input.lastAuditEventId ?? null,
    })
    .onConflictDoUpdate({
      target: featureFlagConfigVersions.scope,
      set: {
        version: sql`${featureFlagConfigVersions.version} + 1`,
        updatedAt: now,
        updatedBy: input.updatedBy ?? null,
        lastAuditEventId: input.lastAuditEventId ?? null,
      },
    })
    .returning({ version: featureFlagConfigVersions.version });
  return row.version;
}

export function computeFeatureFlagBucket(args: {
  key: string;
  salt: string;
  unit: FeatureFlagRandomizationUnit;
  unitId: string;
}): number {
  const digest = createHash("sha256")
    .update(`${args.salt}:${args.key}:${args.unit}:${args.unitId}`)
    .digest();
  return digest.readUInt32BE(0) % 10_000;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/** App-level mirror of the `client` CHECK constraints (shared with the Feature Flag Admin). */
export function assertClientRuleShape(input: FeatureFlagRuleShapeInput): void {
  const error = clientRuleShapeError(input);
  if (error) throw new FeatureFlagRuleValidationError(error);
}

/**
 * Rejects a write that INTRODUCES a client-rule bypass (see findClientRuleBypassConflicts): a later stage
 * or the default that could grant the flag to a client failing a client allow rule. Conflicts that already
 * existed before the write do not block it, so narrowing and cleanup stay possible (same contract as the
 * Feature Flag Admin and the rollout guardrail). Checked in both directions.
 */
async function assertNoNewClientRuleBypass(
  tx: DatabaseTransaction,
  flagKey: string,
  before: FeatureFlagRuleForConflictCheck[],
  after: FeatureFlagRuleForConflictCheck[],
  defaultEnabledAfter?: boolean,
): Promise<void> {
  const [flag] = await tx.select({ defaultEnabled: featureFlags.defaultEnabled }).from(featureFlags).where(eq(featureFlags.key, flagKey));
  const defaultEnabledBefore = flag?.defaultEnabled ?? false;
  const conflictKey = (conflict: FeatureFlagClientRuleBypassConflict) =>
    `${conflict.kind}|${conflict.clientRuleId}|${conflict.bypassRuleId ?? ""}|${conflict.serverId ?? ""}`;
  const existing = new Set(
    findClientRuleBypassConflicts({ rules: before, defaultEnabled: defaultEnabledBefore }).map(conflictKey),
  );
  const conflict = findClientRuleBypassConflicts({
    rules: after,
    defaultEnabled: defaultEnabledAfter ?? defaultEnabledBefore,
  }).find((candidate) => !existing.has(conflictKey(candidate)));
  if (!conflict) return;
  const bypass = conflict.kind === "default_enabled"
    ? "the flag's defaultEnabled"
    : `${conflict.kind.replace("_", " ")} rule ${conflict.bypassRuleId}${conflict.serverId ? ` (server ${conflict.serverId})` : ""}`;
  throw new FeatureFlagRuleValidationError(
    `Client allow rule ${conflict.clientRuleId} would be bypassed by ${bypass}: a client that fails the client `
      + "rule would fall through and still get the flag.",
  );
}

function conflictCheckRows(rows: FeatureFlagRuleRow[]): FeatureFlagRuleForConflictCheck[] {
  return rows.map((row) => ({
    id: row.id,
    stage: row.stage,
    decision: row.decision,
    values: asStringArray(row.values),
    percentageBasisPoints: row.percentageBasisPoints,
  }));
}

function assertLabRuleShape(input: {
  flagKey: string;
  stage: FeatureFlagRuleStage;
  values: string[];
  percentageBasisPoints: number | null;
  variant: string | null;
}): void {
  if (input.stage !== "lab") return;
  if (input.flagKey === SERVER_LABS_UI_FEATURE_FLAG_KEY) {
    throw new FeatureFlagRuleValidationError(
      "server_labs_ui_v0 cannot use Lab feature-flag rules because it gates the Labs UI itself.",
    );
  }
  if (
    input.values.length === 0
    || input.values.some((labKey) => !LAB_KEY_RE.test(labKey))
    || new Set(input.values).size !== input.values.length
  ) {
    throw new FeatureFlagRuleValidationError("Lab feature-flag rules require one or more unique valid lab keys.");
  }
  if (input.percentageBasisPoints !== null) {
    throw new FeatureFlagRuleValidationError("Lab feature-flag rules cannot set percentageBasisPoints.");
  }
  if (input.variant !== null) {
    throw new FeatureFlagRuleValidationError("Lab feature-flag rule variants are not supported in v1.");
  }
}

function assertAudienceRuleShape(input: {
  stage: FeatureFlagRuleStage;
  values: string[];
  percentageBasisPoints: number | null;
  variant: string | null;
}): void {
  if (input.stage !== "audience") return;
  if (
    input.values.length === 0
    || input.values.some((key) => !AUDIENCE_KEY_RE.test(key))
    || new Set(input.values).size !== input.values.length
  ) {
    throw new FeatureFlagRuleValidationError("Audience rules require one or more unique valid audience keys.");
  }
  if (input.percentageBasisPoints !== null || input.variant !== null) {
    throw new FeatureFlagRuleValidationError("Audience rules cannot set percentageBasisPoints or variants.");
  }
}

async function assertEnabledAudienceKeys(
  executor: DatabaseExecutor,
  stage: FeatureFlagRuleStage,
  values: string[],
): Promise<void> {
  if (stage !== "audience") return;
  const rows = await executor
    .select({ key: featureFlagAudiences.key })
    .from(featureFlagAudiences)
    .innerJoin(featureFlagAudienceMembers, eq(featureFlagAudienceMembers.audienceKey, featureFlagAudiences.key))
    .where(and(
      inArray(featureFlagAudiences.key, values),
      eq(featureFlagAudiences.enabled, true),
    ));
  const found = new Set(rows.map((row) => row.key));
  if (values.some((key) => !found.has(key))) {
    throw new FeatureFlagRuleValidationError("Audience rules may reference only enabled, non-empty audiences.");
  }
}

function rulesForStage(rules: FeatureFlagRuleRow[], stage: FeatureFlagRuleStage): FeatureFlagRuleRow[] {
  return rules
    .filter((rule) => rule.stage === stage)
    .sort((a, b) => a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime());
}

function fromRule(key: string, rule: FeatureFlagRuleRow, reason: FeatureFlagReason): FeatureFlagEvaluation {
  const enabled = rule.decision === "allow";
  return {
    key,
    enabled,
    reason,
    ...(enabled && rule.variant ? { variant: rule.variant } : {}),
  };
}

function matchExplicitRule(
  flag: FeatureFlagRow,
  rules: FeatureFlagRuleRow[],
  stage: "user" | "platform" | "server" | "plan",
  value: string | null | undefined,
): FeatureFlagEvaluation | null {
  if (!value) return null;
  for (const rule of rulesForStage(rules, stage)) {
    if (asStringArray(rule.values).includes(value)) {
      return fromRule(flag.key, rule, `${stage}_rule` as FeatureFlagReason);
    }
  }
  return null;
}

function matchClientRule(
  flag: FeatureFlagRow,
  rules: FeatureFlagRuleRow[],
  input: Pick<EvaluateFeatureFlagInput, "serverId" | "client">,
): FeatureFlagEvaluation | null {
  if (!input.serverId) return null;
  for (const rule of rulesForStage(rules, "client")) {
    if (!asStringArray(rule.values).includes(input.serverId)) continue;
    const constraints = {
      clientOs: rule.clientOs == null ? null : asStringArray(rule.clientOs),
      minClientBuild: rule.minClientBuild,
      clientBuildTypes: rule.clientBuildTypes == null ? null : asStringArray(rule.clientBuildTypes),
    };
    if (clientRuleConstraintsSatisfied(constraints, input.client)) {
      return fromRule(flag.key, rule, "client_rule");
    }
  }
  return null;
}

function matchPlanRule(
  flag: FeatureFlagRow,
  rules: FeatureFlagRuleRow[],
  entitlement: ServerBillingEntitlement,
  now: Date,
): FeatureFlagEvaluation | null {
  for (const rule of rulesForStage(rules, "plan")) {
    const values = asStringArray(rule.values);
    const exactMatch = values.includes(entitlement.plan);
    const proCohortAllowMatch = rule.decision === "allow"
      && entitlement.plan !== "pro"
      && values.includes("pro")
      && canUseProBillingFeatures(entitlement.plan, now);
    if (exactMatch || proCohortAllowMatch) {
      return fromRule(flag.key, rule, "plan_rule");
    }
  }
  return null;
}

function matchLabRule(
  flag: FeatureFlagRow,
  rules: FeatureFlagRuleRow[],
  effectiveLabKeys: ReadonlySet<string> | undefined,
): FeatureFlagEvaluation | null {
  if (!effectiveLabKeys || effectiveLabKeys.size === 0) return null;
  for (const rule of rulesForStage(rules, "lab")) {
    if (asStringArray(rule.values).some((labKey) => effectiveLabKeys.has(labKey))) {
      return fromRule(flag.key, rule, "lab_rule");
    }
  }
  return null;
}

function matchAudienceRule(
  flag: FeatureFlagRow,
  rules: FeatureFlagRuleRow[],
  input: Pick<EvaluateFeatureFlagInput, "userId" | "serverId">,
  matchingAudienceKeysByIdentity: ReadonlyMap<string, ReadonlySet<string>>,
): FeatureFlagEvaluation | null {
  const matchingAudienceKeys = new Set<string>();
  if (input.userId) {
    for (const key of matchingAudienceKeysByIdentity.get(`user:${input.userId}`) ?? []) matchingAudienceKeys.add(key);
  }
  if (input.serverId) {
    for (const key of matchingAudienceKeysByIdentity.get(`server:${input.serverId}`) ?? []) matchingAudienceKeys.add(key);
  }
  if (matchingAudienceKeys.size === 0) return null;
  for (const rule of rulesForStage(rules, "audience")) {
    if (asStringArray(rule.values).some((key) => matchingAudienceKeys.has(key))) {
      return fromRule(flag.key, rule, "audience_rule");
    }
  }
  return null;
}

function matchPercentageRule(
  flag: FeatureFlagRow,
  rules: FeatureFlagRuleRow[],
  input: Pick<EvaluateFeatureFlagInput, "userId" | "serverId">,
): FeatureFlagEvaluation | null {
  const unitId = flag.randomizationUnit === "server" ? input.serverId : input.userId;
  if (!unitId) return null;
  const bucket = computeFeatureFlagBucket({
    key: flag.key,
    salt: flag.salt,
    unit: flag.randomizationUnit,
    unitId,
  });

  for (const rule of rulesForStage(rules, "percentage")) {
    const threshold = rule.percentageBasisPoints;
    if (threshold !== null && bucket < threshold) {
      return fromRule(flag.key, rule, "percentage_rule");
    }
  }
  return null;
}

function missingRandomizationUnitReason(
  flag: FeatureFlagRow,
  input: Pick<EvaluateFeatureFlagInput, "userId" | "serverId">,
): Extract<FeatureFlagReason, "missing_user_unit" | "missing_server_unit"> | null {
  if (flag.randomizationUnit === "user" && !input.userId) return "missing_user_unit";
  if (flag.randomizationUnit === "server" && !input.serverId) return "missing_server_unit";
  return null;
}

function evaluateFlagRow(
  flag: FeatureFlagRow | null,
  rules: FeatureFlagRuleRow[],
  input: EvaluateFeatureFlagInput,
  preload: FeatureFlagEvaluationPreload,
): FeatureFlagEvaluation {
  const key = input.key;
  if (!flag) {
    return { key, enabled: false, reason: "missing_flag" };
  }
  if (flag.killSwitch) {
    return { key, enabled: false, reason: "kill_switch" };
  }
  if (!flag.enabled) {
    return { key, enabled: false, reason: "flag_disabled" };
  }

  const userRule = matchExplicitRule(flag, rules, "user", input.userId);
  if (userRule) return userRule;

  const platformRule = matchExplicitRule(flag, rules, "platform", input.platform);
  if (platformRule) return platformRule;

  const clientRule = matchClientRule(flag, rules, input);
  if (clientRule) return clientRule;

  const serverRule = matchExplicitRule(flag, rules, "server", input.serverId);
  if (serverRule) return serverRule;

  const audienceRule = matchAudienceRule(flag, rules, input, preload.matchingAudienceKeysByIdentity);
  if (audienceRule) return audienceRule;

  if (input.serverId) {
    const labRule = matchLabRule(flag, rules, preload.effectiveLabKeysByServer.get(input.serverId));
    if (labRule) return labRule;
  }

  if (input.serverId && rulesForStage(rules, "plan").length > 0) {
    const entitlement = preload.billingEntitlementByServer.get(input.serverId);
    if (entitlement) {
      const planRule = matchPlanRule(flag, rules, entitlement, preload.now);
      if (planRule) return planRule;
    }
  }

  const missingUnitReason = missingRandomizationUnitReason(flag, input);
  if (missingUnitReason) {
    return { key, enabled: false, reason: missingUnitReason };
  }

  const percentageRule = matchPercentageRule(flag, rules, input);
  if (percentageRule) return percentageRule;

  return {
    key,
    enabled: flag.defaultEnabled,
    reason: "default",
    ...(flag.defaultEnabled && flag.defaultVariant ? { variant: flag.defaultVariant } : {}),
  };
}

function distinctRuleValues(rules: FeatureFlagRuleRow[], stage: FeatureFlagRuleStage): string[] {
  return [...new Set(
    rules
      .filter((rule) => rule.stage === stage)
      .flatMap((rule) => asStringArray(rule.values)),
  )];
}

async function preloadEffectiveLabKeysByServer(
  executor: DatabaseExecutor,
  serverIds: string[],
  labKeys: string[],
): Promise<Map<string, Set<string>>> {
  const effectiveByServer = new Map<string, Set<string>>();
  if (serverIds.length === 0 || labKeys.length === 0) return effectiveByServer;

  try {
    const rows = await executor
      .select({
        serverId: serverLabEnrollments.serverId,
        labKey: serverLabEnrollments.labKey,
      })
      .from(serverLabEnrollments)
      .innerJoin(
        serverLabAccess,
        and(
          eq(serverLabAccess.serverId, serverLabEnrollments.serverId),
          eq(serverLabAccess.enabled, true),
        ),
      )
      .innerJoin(
        labDefinitions,
        and(
          eq(labDefinitions.key, serverLabEnrollments.labKey),
          eq(labDefinitions.state, "open"),
        ),
      )
      .where(and(
        inArray(serverLabEnrollments.serverId, serverIds),
        inArray(serverLabEnrollments.labKey, labKeys),
        eq(serverLabEnrollments.enabled, true),
      ));

    for (const row of rows) {
      const labKeysForServer = effectiveByServer.get(row.serverId) ?? new Set<string>();
      labKeysForServer.add(row.labKey);
      effectiveByServer.set(row.serverId, labKeysForServer);
    }
  } catch (error) {
    console.warn("[feature-flag-lab-preload] treating unavailable Lab cohort data as no-match", {
      error: error instanceof Error ? error.message : "unknown",
    });
  }
  return effectiveByServer;
}

async function preloadMatchingAudienceKeysByIdentity(
  executor: DatabaseExecutor,
  audienceKeys: string[],
  userIds: string[],
  serverIds: string[],
): Promise<Map<string, Set<string>>> {
  const matches = new Map<string, Set<string>>();
  if (audienceKeys.length === 0 || (userIds.length === 0 && serverIds.length === 0)) return matches;
  const identityClauses = [
    ...(userIds.length > 0
      ? [and(eq(featureFlagAudienceMembers.kind, "user"), inArray(featureFlagAudienceMembers.targetId, userIds))]
      : []),
    ...(serverIds.length > 0
      ? [and(eq(featureFlagAudienceMembers.kind, "server"), inArray(featureFlagAudienceMembers.targetId, serverIds))]
      : []),
  ];
  const rows = await executor
    .select({
      audienceKey: featureFlagAudienceMembers.audienceKey,
      kind: featureFlagAudienceMembers.kind,
      targetId: featureFlagAudienceMembers.targetId,
    })
    .from(featureFlagAudienceMembers)
    .innerJoin(featureFlagAudiences, and(
      eq(featureFlagAudiences.key, featureFlagAudienceMembers.audienceKey),
      eq(featureFlagAudiences.enabled, true),
    ))
    .where(and(
      inArray(featureFlagAudienceMembers.audienceKey, audienceKeys),
      or(...identityClauses),
    ));
  for (const row of rows) {
    const identity = `${row.kind}:${row.targetId}`;
    const keys = matches.get(identity) ?? new Set<string>();
    keys.add(row.audienceKey);
    matches.set(identity, keys);
  }
  return matches;
}

/**
 * CONTRACT: one evaluation per input, positionally aligned with `inputs`.
 *
 * Batching here is about LOADING, not about answering. Flag rows, rules and the
 * audience/lab/plan preloads are fetched once for the whole batch (still a fixed
 * number of queries regardless of batch size), but the decision itself is a pure
 * function of (flag row, rules, identity) and is computed separately for every
 * input. A batch may therefore mix keys, users, servers and platforms freely.
 *
 * This used to collapse the batch by key and answer each key from whichever
 * input appeared first, which silently returned another identity's answer for a
 * per-server rollout. Evaluating per input is what the parameter type already
 * promises; collapsing was the bug.
 */
export async function evaluateFeatureFlags(
  inputs: EvaluateFeatureFlagInput[],
  executor: DatabaseExecutor = getDb(),
): Promise<FeatureFlagEvaluation[]> {
  const keys = [...new Set(inputs.map((input) => input.key).filter(Boolean))];
  if (keys.length === 0) {
    return inputs.map((input) => ({ key: input.key, enabled: false, reason: "missing_flag" as const }));
  }
  const now = currentDate();

  const flagRows = await executor
    .select()
    .from(featureFlags)
    .where(inArray(featureFlags.key, keys));
  const flagByKey = new Map(flagRows.map((flag) => [flag.key, flag]));
  const ruleRows = flagRows.length > 0
    ? await executor
        .select()
        .from(featureFlagRules)
        .where(inArray(featureFlagRules.flagKey, flagRows.map((flag) => flag.key)))
        .orderBy(asc(featureFlagRules.priority), asc(featureFlagRules.createdAt))
    : [];
  const rulesByKey = new Map<string, FeatureFlagRuleRow[]>();
  for (const rule of ruleRows) {
    const list = rulesByKey.get(rule.flagKey) ?? [];
    list.push(rule);
    rulesByKey.set(rule.flagKey, list);
  }

  const audienceKeys = distinctRuleValues(ruleRows, "audience");
  const audienceFlagKeys = new Set(ruleRows.filter((rule) => rule.stage === "audience").map((rule) => rule.flagKey));
  const audienceInputs = inputs.filter((input) => audienceFlagKeys.has(input.key));
  const audienceUserIds = [...new Set(audienceInputs.map((input) => input.userId).filter((id): id is string => Boolean(id)))];
  const audienceServerIds = [...new Set(audienceInputs.map((input) => input.serverId).filter((id): id is string => Boolean(id)))];
  const matchingAudienceKeysByIdentity = await preloadMatchingAudienceKeysByIdentity(
    executor,
    audienceKeys,
    audienceUserIds,
    audienceServerIds,
  );

  const labKeys = distinctRuleValues(ruleRows, "lab");
  const labFlagKeys = new Set(ruleRows.filter((rule) => rule.stage === "lab").map((rule) => rule.flagKey));
  const labServerIds = [...new Set(inputs
    .filter((input) => labFlagKeys.has(input.key))
    .map((input) => input.serverId)
    .filter((serverId): serverId is string => Boolean(serverId)))];
  const effectiveLabKeysByServer = await preloadEffectiveLabKeysByServer(executor, labServerIds, labKeys);

  const planFlagKeys = new Set(ruleRows.filter((rule) => rule.stage === "plan").map((rule) => rule.flagKey));
  const planServerIds = [...new Set(inputs
    .filter((input) => planFlagKeys.has(input.key))
    .map((input) => input.serverId)
    .filter((serverId): serverId is string => Boolean(serverId)))];
  const billingEntitlementByServer = await getServerBillingEntitlements(executor, planServerIds, now);
  const preload: FeatureFlagEvaluationPreload = {
    matchingAudienceKeysByIdentity,
    effectiveLabKeysByServer,
    billingEntitlementByServer,
    now,
  };

  return inputs.map((input) => {
    const key = input.key;
    const evaluation = evaluateFlagRow(
      flagByKey.get(key) ?? null,
      rulesByKey.get(key) ?? [],
      input,
      preload,
    );
    return evaluation;
  });
}

export async function evaluateFeatureFlag(
  input: EvaluateFeatureFlagInput,
  executor: DatabaseExecutor = getDb(),
): Promise<FeatureFlagEvaluation> {
  const [evaluation] = await evaluateFeatureFlags([input], executor);
  return evaluation ?? { key: input.key, enabled: false, reason: "missing_flag" };
}

export async function listFeatureFlags(executor: DatabaseExecutor = getDb()) {
  return executor.select().from(featureFlags).orderBy(asc(featureFlags.key));
}

export async function getFeatureFlag(key: string, executor: DatabaseExecutor = getDb()) {
  const [flag] = await executor.select().from(featureFlags).where(eq(featureFlags.key, key));
  return flag ?? null;
}

export async function createFeatureFlag(input: {
  key: string;
  description?: string | null;
  enabled?: boolean;
  killSwitch?: boolean;
  randomizationUnit: FeatureFlagRandomizationUnit;
  defaultEnabled?: boolean;
  defaultVariant?: string | null;
  salt?: string;
}) {
  return withFeatureFlagLock(input.key, async (tx) => {
    const [created] = await tx.insert(featureFlags).values({
      key: input.key,
      description: input.description ?? null,
      enabled: input.enabled ?? true,
      killSwitch: input.killSwitch ?? false,
      randomizationUnit: input.randomizationUnit,
      defaultEnabled: input.defaultEnabled ?? false,
      defaultVariant: input.defaultVariant ?? null,
      salt: input.salt ?? randomUUID(),
    }).returning();
    await bumpFeatureFlagConfigVersion({ updatedBy: "legacy-server-admin" }, tx);
    return created;
  });
}

export async function updateFeatureFlag(
  key: string,
  patch: Partial<Omit<typeof featureFlags.$inferInsert, "key" | "createdAt">>,
) {
  return withFeatureFlagLock(key, async (tx) => {
    if (patch.defaultEnabled === true) {
      const rules = await tx.select().from(featureFlagRules).where(eq(featureFlagRules.flagKey, key));
      await assertNoNewClientRuleBypass(tx, key, conflictCheckRows(rules), conflictCheckRows(rules), true);
    }
    const [updated] = await tx
      .update(featureFlags)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(featureFlags.key, key))
      .returning();
    if (updated) {
      await bumpFeatureFlagConfigVersion({ updatedBy: "legacy-server-admin" }, tx);
    }
    return updated ?? null;
  });
}

export async function deleteFeatureFlag(key: string) {
  return withFeatureFlagLock(key, async (tx) => {
    const rows = await tx.delete(featureFlags).where(eq(featureFlags.key, key)).returning({ key: featureFlags.key });
    if (rows.length > 0) {
      await bumpFeatureFlagConfigVersion({ updatedBy: "legacy-server-admin" }, tx);
    }
    return rows.length > 0;
  });
}

export async function listFeatureFlagRules(flagKey: string, executor: DatabaseExecutor = getDb()) {
  return executor
    .select()
    .from(featureFlagRules)
    .where(eq(featureFlagRules.flagKey, flagKey))
    .orderBy(asc(featureFlagRules.stage), asc(featureFlagRules.priority), asc(featureFlagRules.createdAt));
}

export async function createFirstServerAllowFeatureFlagRule(input: {
  flagKey: string;
  serverIds: string[];
  expectedConfigVersion: number;
  actor: FeatureFlagOperatorActor;
  auditEventId?: string | null;
}) {
  const db = getDb();
  const serverIds = [...new Set(input.serverIds)].sort();
  if (serverIds.length === 0) {
    throw new FeatureFlagRuleValidationError("First server allow rule requires one or more server ids.");
  }
  return db.transaction(async (tx) => {
    await acquireFeatureFlagConfigVersionLock(tx);
    await acquireFeatureFlagLock(tx, input.flagKey);

    const currentVersion = await getFeatureFlagConfigVersion(tx);
    if (currentVersion !== input.expectedConfigVersion) {
      throw new FeatureFlagConfigVersionConflictError(currentVersion);
    }

    const [flag] = await tx
      .select({ key: featureFlags.key })
      .from(featureFlags)
      .where(eq(featureFlags.key, input.flagKey))
      .limit(1)
      .for("update");
    if (!flag) return null;

    const existingRules = await tx
      .select()
      .from(featureFlagRules)
      .where(eq(featureFlagRules.flagKey, input.flagKey))
      .orderBy(asc(featureFlagRules.stage), asc(featureFlagRules.priority), asc(featureFlagRules.createdAt))
      .for("update");
    if (existingRules.some((rule) => rule.stage === "server")) {
      throw new FeatureFlagServerRuleAlreadyExistsError(
        "A server rule already exists; only the first server allow rule can be created through this helper.",
      );
    }
    await assertNoNewClientRuleBypass(tx, input.flagKey, conflictCheckRows(existingRules), [
      ...conflictCheckRows(existingRules),
      { id: "(new rule)", stage: "server", decision: "allow", values: serverIds },
    ]);

    const [created] = await tx.insert(featureFlagRules).values({
      flagKey: input.flagKey,
      stage: "server",
      priority: 0,
      decision: "allow",
      values: serverIds,
      percentageBasisPoints: null,
      variant: null,
    }).returning();
    const configVersion = await bumpFeatureFlagConfigVersion({
      updatedBy: `operator:${input.actor.type}:${input.actor.id}`,
      lastAuditEventId: input.auditEventId ?? null,
    }, tx);
    return { rule: created, configVersion };
  });
}

/**
 * Dedicated production operator seam for the Apple web-only rollout. This
 * cannot accept a caller-selected platform, values list, decision, priority,
 * default, or variant: the only possible mutation is the first canonical
 * platform allow rule with values=["web"].
 */
export async function createFirstWebPlatformAllowFeatureFlagRule(input: {
  flagKey: string;
  expectedConfigVersion: number;
  actor: FeatureFlagOperatorActor;
  auditEventId?: string | null;
}) {
  const db = getDb();
  return db.transaction(async (tx) => {
    await acquireFeatureFlagConfigVersionLock(tx);
    await acquireFeatureFlagLock(tx, input.flagKey);

    const currentVersion = await getFeatureFlagConfigVersion(tx);
    if (currentVersion !== input.expectedConfigVersion) {
      throw new FeatureFlagConfigVersionConflictError(currentVersion);
    }

    const [flag] = await tx
      .select({ key: featureFlags.key })
      .from(featureFlags)
      .where(eq(featureFlags.key, input.flagKey))
      .limit(1)
      .for("update");
    if (!flag) return null;

    const existingRules = await tx
      .select({ id: featureFlagRules.id })
      .from(featureFlagRules)
      .where(and(
        eq(featureFlagRules.flagKey, input.flagKey),
        eq(featureFlagRules.stage, "platform"),
      ))
      .limit(1)
      .for("update");
    if (existingRules.length > 0) {
      throw new FeatureFlagPlatformRuleAlreadyExistsError(
        "A platform rule already exists; only the first web platform allow rule can be created through this helper.",
      );
    }

    const [created] = await tx.insert(featureFlagRules).values({
      flagKey: input.flagKey,
      stage: "platform",
      priority: 0,
      decision: "allow",
      values: ["web"],
      percentageBasisPoints: null,
      variant: null,
    }).returning();
    const configVersion = await bumpFeatureFlagConfigVersion({
      updatedBy: `operator:${input.actor.type}:${input.actor.id}`,
      lastAuditEventId: input.auditEventId ?? null,
    }, tx);
    return { rule: created, configVersion };
  });
}

export async function createFeatureFlagRule(input: {
  flagKey: string;
  stage: FeatureFlagRuleStage;
  priority?: number;
  decision: FeatureFlagRuleDecision;
  values?: string[];
  percentageBasisPoints?: number | null;
  variant?: string | null;
  clientOs?: string[] | null;
  minClientBuild?: number | null;
  clientBuildTypes?: string[] | null;
}) {
  const values = input.values ?? [];
  assertClientRuleShape({
    stage: input.stage,
    values,
    percentageBasisPoints: input.percentageBasisPoints ?? null,
    variant: input.variant ?? null,
    clientOs: input.clientOs ?? null,
    minClientBuild: input.minClientBuild ?? null,
    clientBuildTypes: input.clientBuildTypes ?? null,
  });
  assertLabRuleShape({
    flagKey: input.flagKey,
    stage: input.stage,
    values,
    percentageBasisPoints: input.percentageBasisPoints ?? null,
    variant: input.variant ?? null,
  });
  return withFeatureFlagLock(input.flagKey, async (tx) => {
    assertAudienceRuleShape({
      stage: input.stage,
      values,
      percentageBasisPoints: input.percentageBasisPoints ?? null,
      variant: input.variant ?? null,
    });
    await assertEnabledAudienceKeys(tx, input.stage, values);
    const existing = await tx.select().from(featureFlagRules).where(eq(featureFlagRules.flagKey, input.flagKey));
    await assertNoNewClientRuleBypass(tx, input.flagKey, conflictCheckRows(existing), [
      ...conflictCheckRows(existing),
      {
        id: "(new rule)",
        stage: input.stage,
        decision: input.decision,
        values,
        percentageBasisPoints: input.percentageBasisPoints ?? null,
      },
    ]);
    const [created] = await tx.insert(featureFlagRules).values({
      flagKey: input.flagKey,
      stage: input.stage,
      priority: input.priority ?? 0,
      decision: input.decision,
      values: [...new Set(values)],
      percentageBasisPoints: input.percentageBasisPoints ?? null,
      variant: input.variant ?? null,
      clientOs: input.clientOs ?? null,
      minClientBuild: input.minClientBuild ?? null,
      clientBuildTypes: input.clientBuildTypes ?? null,
    }).returning();
    await bumpFeatureFlagConfigVersion({ updatedBy: "legacy-server-admin" }, tx);
    return created;
  });
}

export async function updateFeatureFlagRule(
  flagKey: string,
  ruleId: string,
  patch: Partial<Omit<typeof featureFlagRules.$inferInsert, "id" | "flagKey" | "createdAt">>,
) {
  return withFeatureFlagLock(flagKey, async (tx) => {
    const [current] = await tx
      .select()
      .from(featureFlagRules)
      .where(and(eq(featureFlagRules.flagKey, flagKey), eq(featureFlagRules.id, ruleId)));
    if (!current) return null;
    assertLabRuleShape({
      flagKey,
      stage: patch.stage ?? current.stage,
      values: patch.values ?? asStringArray(current.values),
      percentageBasisPoints: patch.percentageBasisPoints === undefined
        ? current.percentageBasisPoints
        : patch.percentageBasisPoints,
      variant: patch.variant === undefined ? current.variant : patch.variant,
    });
    const nextStage = patch.stage ?? current.stage;
    const nextValues = patch.values ?? asStringArray(current.values);
    assertAudienceRuleShape({
      stage: nextStage,
      values: nextValues,
      percentageBasisPoints: patch.percentageBasisPoints === undefined
        ? current.percentageBasisPoints
        : patch.percentageBasisPoints,
      variant: patch.variant === undefined ? current.variant : patch.variant,
    });
    assertClientRuleShape({
      stage: nextStage,
      values: nextValues,
      percentageBasisPoints: patch.percentageBasisPoints === undefined
        ? current.percentageBasisPoints
        : patch.percentageBasisPoints,
      variant: patch.variant === undefined ? current.variant : patch.variant,
      clientOs: patch.clientOs === undefined
        ? (current.clientOs == null ? null : asStringArray(current.clientOs))
        : (patch.clientOs as string[] | null),
      minClientBuild: patch.minClientBuild === undefined ? current.minClientBuild : patch.minClientBuild,
      clientBuildTypes: patch.clientBuildTypes === undefined
        ? (current.clientBuildTypes == null ? null : asStringArray(current.clientBuildTypes))
        : (patch.clientBuildTypes as string[] | null),
    });
    await assertEnabledAudienceKeys(tx, nextStage, nextValues);
    const siblings = await tx.select().from(featureFlagRules).where(eq(featureFlagRules.flagKey, flagKey));
    await assertNoNewClientRuleBypass(tx, flagKey, conflictCheckRows(siblings), conflictCheckRows(siblings).map((row) => (
      row.id === ruleId
        ? {
          ...row,
          stage: nextStage,
          decision: patch.decision ?? current.decision,
          values: nextValues,
          percentageBasisPoints: patch.percentageBasisPoints === undefined
            ? current.percentageBasisPoints
            : patch.percentageBasisPoints,
        }
        : row
    )));
    const normalizedPatch = patch.values === undefined
      ? patch
      : { ...patch, values: [...new Set(patch.values as string[])] };
    const [updated] = await tx
      .update(featureFlagRules)
      .set({ ...normalizedPatch, updatedAt: new Date() })
      .where(and(eq(featureFlagRules.flagKey, flagKey), eq(featureFlagRules.id, ruleId)))
      .returning();
    if (updated) {
      await bumpFeatureFlagConfigVersion({ updatedBy: "legacy-server-admin" }, tx);
    }
    return updated ?? null;
  });
}

export async function deleteFeatureFlagRule(flagKey: string, ruleId: string) {
  return withFeatureFlagLock(flagKey, async (tx) => {
    const rows = await tx
      .delete(featureFlagRules)
      .where(and(eq(featureFlagRules.flagKey, flagKey), eq(featureFlagRules.id, ruleId)))
      .returning({ id: featureFlagRules.id });
    if (rows.length > 0) {
      await bumpFeatureFlagConfigVersion({ updatedBy: "legacy-server-admin" }, tx);
    }
    return rows.length > 0;
  });
}

export async function setFeatureFlagKillSwitch(key: string, killSwitch: boolean) {
  return updateFeatureFlag(key, { killSwitch });
}
