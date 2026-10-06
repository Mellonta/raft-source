/**
 * `client` feature-flag rule stage (task #1144): the single definition shared by the server evaluator,
 * the server rule writers and the Feature Flag Admin (validation + preview). Migration 0287's CHECK
 * constraints mirror {@link clientRuleShapeError}.
 *
 * A client rule targets the servers in `values` AND requires every constraint it sets: client OS,
 * minimum build number, build type. A client fact that is missing, unknown or malformed never
 * satisfies a constraint (fail closed); the rule is then skipped and evaluation moves on.
 */

export const FEATURE_FLAG_CLIENT_OS_VALUES = ["android", "ios", "ohos"] as const;
export type FeatureFlagClientOs = (typeof FEATURE_FLAG_CLIENT_OS_VALUES)[number];

/**
 * Android reports `BuildConfig.BUILD_TYPE` (release / alpha / debug; the CI-only `connectedTest` never
 * matches); iOS and OHOS report release / debug only, and TestFlight and App Store are both `release`.
 */
export const FEATURE_FLAG_CLIENT_BUILD_TYPES = ["release", "alpha", "debug"] as const;
export type FeatureFlagClientBuildType = (typeof FEATURE_FLAG_CLIENT_BUILD_TYPES)[number];

/** What the calling client reported about itself. Every field is optional. */
export interface FeatureFlagClientFacts {
  os?: FeatureFlagClientOs | null;
  buildNumber?: number | null;
  buildType?: FeatureFlagClientBuildType | null;
}

export interface FeatureFlagClientRuleConstraints {
  clientOs?: readonly string[] | null;
  minClientBuild?: number | null;
  clientBuildTypes?: readonly string[] | null;
}

export interface FeatureFlagRuleShapeInput extends FeatureFlagClientRuleConstraints {
  stage: string;
  values: readonly string[];
  percentageBasisPoints: number | null;
  variant: string | null;
}

export interface FeatureFlagRuleForConflictCheck {
  id: string;
  stage: string;
  decision: string;
  values: readonly string[];
  percentageBasisPoints?: number | null;
}

export type FeatureFlagClientRuleBypassKind =
  | "server_allow"
  | "audience_allow"
  | "lab_allow"
  | "plan_allow"
  | "percentage_allow"
  | "default_enabled";

export interface FeatureFlagClientRuleBypassConflict {
  kind: FeatureFlagClientRuleBypassKind;
  clientRuleId: string;
  /** The later rule that would grant the flag; null for `default_enabled`. */
  bypassRuleId: string | null;
  /** Set for `server_allow`, where the overlap is per server. */
  serverId?: string;
}

const BUILD_NUMBER_RE = /^[0-9]{1,15}$/;

function isOneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function uniqueNonEmptySubset(values: readonly string[], allowed: readonly string[]): boolean {
  return values.length > 0 && new Set(values).size === values.length && values.every((value) => allowed.includes(value));
}

/**
 * Human-readable reason a rule's client fields are invalid, or null when they are valid. Pure: callers
 * wrap it in their own error type. Non-client stages must not carry client fields.
 */
export function clientRuleShapeError(rule: FeatureFlagRuleShapeInput): string | null {
  const clientOs = rule.clientOs ?? null;
  const minClientBuild = rule.minClientBuild ?? null;
  const clientBuildTypes = rule.clientBuildTypes ?? null;
  if (rule.stage !== "client") {
    return clientOs !== null || minClientBuild !== null || clientBuildTypes !== null
      ? "clientOs, minClientBuild, and clientBuildTypes are only valid on client-stage rules."
      : null;
  }
  if (rule.values.length === 0 || new Set(rule.values).size !== rule.values.length) {
    return "Client rules require one or more unique target server IDs.";
  }
  if (rule.percentageBasisPoints !== null || rule.variant !== null) {
    return "Client rules cannot set percentageBasisPoints or variants.";
  }
  if (clientOs === null && minClientBuild === null && clientBuildTypes === null) {
    return "Client rules require at least one of clientOs, minClientBuild, clientBuildTypes.";
  }
  if (clientOs !== null && !uniqueNonEmptySubset(clientOs, FEATURE_FLAG_CLIENT_OS_VALUES)) {
    return `clientOs must be a non-empty list of unique values from: ${FEATURE_FLAG_CLIENT_OS_VALUES.join(", ")}.`;
  }
  if (clientBuildTypes !== null && !uniqueNonEmptySubset(clientBuildTypes, FEATURE_FLAG_CLIENT_BUILD_TYPES)) {
    return `clientBuildTypes must be a non-empty list of unique values from: ${FEATURE_FLAG_CLIENT_BUILD_TYPES.join(", ")}.`;
  }
  if (minClientBuild !== null && (!Number.isSafeInteger(minClientBuild) || minClientBuild < 0)) {
    return "minClientBuild must be a non-negative integer.";
  }
  return null;
}

/** True only when the client reported every fact the rule constrains, and each one passes. */
export function clientRuleConstraintsSatisfied(
  rule: FeatureFlagClientRuleConstraints,
  client: FeatureFlagClientFacts | null | undefined,
): boolean {
  const clientOs = rule.clientOs ?? null;
  const minClientBuild = rule.minClientBuild ?? null;
  const clientBuildTypes = rule.clientBuildTypes ?? null;
  if (clientOs !== null && (!client?.os || !clientOs.includes(client.os))) return false;
  if (clientBuildTypes !== null && (!client?.buildType || !clientBuildTypes.includes(client.buildType))) return false;
  if (minClientBuild !== null) {
    const build = client?.buildNumber;
    if (typeof build !== "number" || !Number.isSafeInteger(build) || build < minClientBuild) return false;
  }
  return clientOs !== null || minClientBuild !== null || clientBuildTypes !== null;
}

/**
 * Parses client facts from an untrusted request body. Unknown or malformed values become null ("not
 * reported") and never throw, so evaluation keeps working for any client.
 */
export function parseFeatureFlagClientFacts(body: Record<string, unknown>): Required<FeatureFlagClientFacts> {
  const rawBuild = body.buildNumber;
  const buildNumber = typeof rawBuild === "string" && BUILD_NUMBER_RE.test(rawBuild)
    ? Number(rawBuild)
    : typeof rawBuild === "number" && Number.isSafeInteger(rawBuild) && rawBuild >= 0
      ? rawBuild
      : null;
  return {
    os: isOneOf(FEATURE_FLAG_CLIENT_OS_VALUES, body.os) ? body.os : null,
    buildNumber,
    buildType: isOneOf(FEATURE_FLAG_CLIENT_BUILD_TYPES, body.buildType) ? body.buildType : null,
  };
}

/**
 * Evaluation is first-match in stage order (user, platform, client, server, audience, lab, plan,
 * percentage, default). When a client `allow` does not match (e.g. build too old), evaluation falls
 * through, so any LATER stage that can grant the flag hands old builds the flag anyway and the client
 * constraints mean nothing. A flag with a client allow therefore conflicts with:
 * - a server `allow` listing the same server;
 * - any audience / lab / plan `allow` (which servers they match cannot be decided statically);
 * - any percentage `allow` above 0 (global);
 * - `default_enabled = true` (the final fallback).
 * user / platform rules run BEFORE the client stage and cannot bypass it, so they are not listed.
 * Writers must reject any conflict (in both directions); previews should warn.
 */
export function findClientRuleBypassConflicts(input: {
  rules: readonly FeatureFlagRuleForConflictCheck[];
  defaultEnabled?: boolean;
}): FeatureFlagClientRuleBypassConflict[] {
  const conflicts: FeatureFlagClientRuleBypassConflict[] = [];
  const clientAllows = input.rules.filter((rule) => rule.stage === "client" && rule.decision === "allow");
  if (clientAllows.length === 0) return conflicts;
  const laterAllows = input.rules.filter((rule) => rule.decision === "allow");
  for (const clientRule of clientAllows) {
    for (const later of laterAllows) {
      switch (later.stage) {
        case "server":
          for (const serverId of new Set(clientRule.values)) {
            if (later.values.includes(serverId)) {
              conflicts.push({ kind: "server_allow", clientRuleId: clientRule.id, bypassRuleId: later.id, serverId });
            }
          }
          break;
        case "audience":
        case "lab":
        case "plan":
          conflicts.push({
            kind: `${later.stage}_allow` as FeatureFlagClientRuleBypassKind,
            clientRuleId: clientRule.id,
            bypassRuleId: later.id,
          });
          break;
        case "percentage":
          if ((later.percentageBasisPoints ?? 0) > 0) {
            conflicts.push({ kind: "percentage_allow", clientRuleId: clientRule.id, bypassRuleId: later.id });
          }
          break;
        default:
          break;
      }
    }
    if (input.defaultEnabled) {
      conflicts.push({ kind: "default_enabled", clientRuleId: clientRule.id, bypassRuleId: null });
    }
  }
  return conflicts;
}
