import { DISTRIBUTION_POLICY } from "@botiverse/raft-shared";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { clearClockTimeout, compareComputerVersions, isComputerSemver, setClockTimeout } from "@botiverse/raft-shared";
import {
  evaluateFeatureFlag,
  REMOTE_COMPUTER_UPGRADE_V2_FEATURE_FLAG_KEY,
} from "./featureFlagService";

// Keep the existing response/snapshot field names for older Web/Computer clients.
// They describe a Hands release selection now, not a Server-maintained allowlist.
export interface ComputerPlatform {
  os: "linux" | "macos" | "windows";
  architecture: "x64" | "arm64";
}
export type ComputerSourceFactProvenance = "owner_connection" | "replica_meta";
export interface ComputerSourceFact {
  version: string | null;
  observedAt: string | null;
  provenance: ComputerSourceFactProvenance | null;
}
export interface ComputerHandsReleaseIdentity {
  releaseId: string;
  buildId: string;
  channel: "main";
  version: string;
  sha256: string;
  size: number;
  url: string;
}
export interface ComputerBroadcastPolicyDecision {
  eligibility: "eligible" | "no_broadcast";
  reasonCode: "eligible" | "source_missing" | "source_unparseable" | "platform_unknown"
    | "hands_unavailable" | "hands_response_invalid" | "hands_artifact_missing"
    | "already_current" | "requested_target_mismatch"
    // Broadcast gate (task #804). Deliberately two codes, not one: "an operator
    // turned this off" and "the gate itself could not be read" both stop the
    // broadcast, but they are different incidents and must stay distinguishable
    // in stored receipts.
    | "broadcast_disabled" | "broadcast_gate_unavailable"
    // Historical reason codes remain readable in stored receipts and clients.
    | "policy_row_missing" | "policy_expired";
  policyRevision: string | null;
  sourceVersion: string | null;
  sourceObservedAt: string | null;
  sourceProvenance: ComputerSourceFactProvenance | null;
  platform: ComputerPlatform | null;
  targetVersion: string | null;
  targetRole: "K" | "post_K" | "independent_bugfix" | null;
  migrationClass: "controlled_reinstall_repair" | "seamless" | null;
  policyRow: null;
  handsRelease?: ComputerHandsReleaseIdentity;
}
export interface EvaluateComputerBroadcastPolicyInput {
  source: ComputerSourceFact | null;
  platform: ComputerPlatform | null;
  requestedTargetVersion?: string | null;
  now: Date;
  /**
   * Server the machine belongs to. Required for the broadcast gate to be
   * openable: the flag evaluator resolves a randomization unit before it can
   * reach the flag default, so a null serverId evaluates to `false` even for a
   * flag whose default is on. Omitting it yields a switch that can be closed
   * but never opened.
   */
  serverId?: string | null;
}
export interface ComputerHandsResolutionDependencies {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /**
   * Override for the broadcast gate. Tests inject this; production leaves it
   * unset and the real feature flag is read.
   */
  isBroadcastEnabled?: (serverId: string | null) => boolean | Promise<boolean>;
}
// Task #805 (artin, 2026-09-13): the Server-driven check that users see on the
// Computer page always resolves the STABLE channel (`main`). Alpha is a manual
// path (`install.sh --channel alpha`) and is never broadcast from here. This one
// function feeds the machine list, the control POST, lifecycle-operation
// creation and orchestrator dispatch, so there is exactly one place to change.
export const COMPUTER_HANDS_MAIN_URL =
  "https://hands.build/public/v2/apps/raft-computer-cli/latest?channel=main&product_type=cli-binary";

// Full SemVer, shared with the web so both read a version the same way.
const versionSchema = z.string().refine(isComputerSemver);
const releaseSchema = z.object({
  app: z.object({ slug: z.literal("raft-computer-cli"), platform: z.literal("node") }),
  // Fail closed on any other channel: a response for `alpha` (or an alias that
  // echoes a different name) must never be projected as the stable target.
  channel: z.literal("main"),
  build: z.object({ id: z.string().min(1), version: versionSchema }),
  scoped: z.object({ release_id: z.string().min(1) }),
  assets: z.array(z.object({
    platform: z.string(), arch: z.string(), variant: z.string().nullable(), filetype: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size_bytes: z.number().int().positive().safe(),
    download_url: z.string().url().refine((url) => new URL(url).protocol === "https:"),
  })),
});
type HandsRelease = z.infer<typeof releaseSchema>;

// Only collapse concurrent reads (e.g. a machine-list response). No stale cache
// can keep a withdrawn release eligible at a later dispatch attempt.
let pendingRelease: Promise<HandsRelease> | null = null;
async function fetchRelease(deps: ComputerHandsResolutionDependencies): Promise<HandsRelease> {
  const controller = new AbortController();
  const timer = setClockTimeout(() => controller.abort(), deps.timeoutMs ?? 5_000);
  try {
    const response = await (deps.fetchFn ?? fetch)(COMPUTER_HANDS_MAIN_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      redirect: "error",
    });
    if (!response.ok) throw new Error("Hands unavailable");
    return releaseSchema.parse(await response.json());
  } finally {
    clearClockTimeout(timer);
  }
}
function readRelease(deps: ComputerHandsResolutionDependencies): Promise<HandsRelease> {
  if (deps.fetchFn || deps.timeoutMs !== undefined) return fetchRelease(deps);
  pendingRelease ??= fetchRelease(deps).finally(() => { pendingRelease = null; });
  return pendingRelease;
}

export function normalizeComputerPlatform(rawOs: string | null | undefined): ComputerPlatform | null {
  if (!rawOs) return null;
  const normalized = rawOs.trim().toLowerCase().replace(/[_-]+/g, " ");
  const architecture = /\barm64\b|\baarch64\b/.test(normalized)
    ? "arm64"
    : /\bx64\b|\bx86 64\b|\bamd64\b/.test(normalized)
      ? "x64"
      : null;
  if (!architecture) return null;
  const os = /\bdarwin\b|\bmacos\b|\bmac os\b/.test(normalized)
    ? "macos"
    : /\blinux\b/.test(normalized)
      ? "linux"
      : /\bwindows\b|\bwin32\b/.test(normalized)
        ? "windows"
        : null;
  return os ? { os, architecture } : null;
}

type BroadcastGate =
  | { enabled: true }
  | { enabled: false; reasonCode: "broadcast_disabled" | "broadcast_gate_unavailable" };

async function readBroadcastGate(
  serverId: string | null,
  deps: ComputerHandsResolutionDependencies,
): Promise<BroadcastGate> {
  if (!DISTRIBUTION_POLICY.upstreamServices) return { enabled: false, reasonCode: "broadcast_disabled" };
  try {
    const enabled = deps.isBroadcastEnabled
      ? await deps.isBroadcastEnabled(serverId)
      : (await evaluateFeatureFlag({
          key: REMOTE_COMPUTER_UPGRADE_V2_FEATURE_FLAG_KEY,
          serverId,
        })).enabled;
    return enabled ? { enabled: true } : { enabled: false, reasonCode: "broadcast_disabled" };
  } catch {
    // An unreadable gate is not permission to broadcast. It gets its own reason
    // code so that "someone turned this off" stays distinguishable from "the
    // flag store was unreachable" in receipts and dispatch-failure reasons.
    return { enabled: false, reasonCode: "broadcast_gate_unavailable" };
  }
}

export async function evaluateBroadcastPolicy(
  input: EvaluateComputerBroadcastPolicyInput,
  deps: ComputerHandsResolutionDependencies = {},
): Promise<ComputerBroadcastPolicyDecision> {
  const decision: ComputerBroadcastPolicyDecision = {
    eligibility: "no_broadcast", reasonCode: "hands_unavailable", policyRevision: null,
    sourceVersion: input.source?.version ?? null,
    sourceObservedAt: input.source?.observedAt ?? null,
    sourceProvenance: input.source?.provenance ?? null,
    platform: input.platform, targetVersion: null, targetRole: null, migrationClass: null, policyRow: null,
  };
  // Broadcast gate (task #804). This runs FIRST, before the source/platform
  // checks and before Hands is contacted at all: a closed gate must not cause
  // an outbound request, and must not depend on the machine being well-formed.
  //
  // One flag gates every Server-initiated upgrade send: this gate reads
  // `remote_computer_upgrade_v2`, the same flag the v2 upgrade route checks
  // up front. It used to read a separate broadcast-only flag; two
  // flags for one action meant a server with only v2 enabled still had the
  // Upgrade button hidden. Every caller of this policy (machine list
  // projection, v2 upgrade route, lifecycle-operation creation, orchestrator
  // dispatch revalidation) therefore opens and closes together.
  //
  // Fail-closed by construction. A missing flag evaluates to `enabled: false`
  // (`missing_flag`), so the default state of this system is dark and turning
  // upgrades on requires someone to deliberately create and enable the flag.
  // That restores the property the deleted policy artifact used to provide:
  // publishing code is not broadcast authorization. The reason codes
  // (`broadcast_disabled` / `broadcast_gate_unavailable`) keep their names
  // because they are stored in receipts and read by clients.
  const gate = await readBroadcastGate(input.serverId ?? null, deps);
  if (!gate.enabled) return { ...decision, reasonCode: gate.reasonCode };

  if (!input.source?.version) return { ...decision, reasonCode: "source_missing" };
  if (!versionSchema.safeParse(input.source.version).success) return { ...decision, reasonCode: "source_unparseable" };
  if (!input.platform) return { ...decision, reasonCode: "platform_unknown" };
  let release: HandsRelease;
  try {
    release = await readRelease(deps);
  } catch (error) {
    return { ...decision, reasonCode: error instanceof z.ZodError || error instanceof SyntaxError
      ? "hands_response_invalid" : "hands_unavailable" };
  }
  const os = { macos: "darwin", linux: "linux", windows: "win32" }[input.platform.os];
  const assets = release.assets.filter((asset) => asset.platform === os
    && asset.arch === input.platform!.architecture && asset.variant === null && asset.filetype === "binary");
  if (assets.length !== 1) return { ...decision, reasonCode: "hands_artifact_missing" };
  const asset = assets[0]!;
  const selected: ComputerBroadcastPolicyDecision = {
    ...decision,
    policyRevision: `hands:main:${release.scoped.release_id}`,
    targetVersion: release.build.version, targetRole: "post_K", migrationClass: "seamless",
    handsRelease: { releaseId: release.scoped.release_id, buildId: release.build.id, channel: "main",
      version: release.build.version, sha256: asset.sha256, size: asset.size_bytes, url: asset.download_url },
  };
  if (input.requestedTargetVersion != null && input.requestedTargetVersion !== release.build.version) {
    return { ...selected, reasonCode: "requested_target_mismatch" };
  }
  if (compareComputerVersions(release.build.version, input.source.version) <= 0) {
    return { ...selected, reasonCode: "already_current" };
  }
  return { ...selected, eligibility: "eligible", reasonCode: "eligible" };
}

export function projectComputerBroadcastPolicyDecision(
  decision: ComputerBroadcastPolicyDecision,
): Pick<
  ComputerBroadcastPolicyDecision,
  "eligibility" | "targetVersion" | "targetRole" | "migrationClass" | "policyRevision" | "reasonCode"
> {
  return {
    eligibility: decision.eligibility,
    targetVersion: decision.targetVersion,
    targetRole: decision.targetRole,
    migrationClass: decision.migrationClass,
    policyRevision: decision.policyRevision,
    reasonCode: decision.reasonCode,
  };
}

// Revalidate an unsent queued command against the same Hands identity. A new
// stable release or changed artifact must not silently retarget an existing operation.
export function isQueuedComputerUpgradePolicyCompatible(
  persistedSnapshot: unknown,
  currentDecision: ComputerBroadcastPolicyDecision,
): boolean {
  if (!persistedSnapshot || typeof persistedSnapshot !== "object" || Array.isArray(persistedSnapshot)) return false;
  const persisted = persistedSnapshot as Partial<ComputerBroadcastPolicyDecision>;
  return persisted.eligibility === "eligible" && currentDecision.eligibility === "eligible"
    && persisted.reasonCode === "eligible" && currentDecision.reasonCode === "eligible"
    && persisted.sourceVersion === currentDecision.sourceVersion
    && persisted.targetVersion === currentDecision.targetVersion
    && isDeepStrictEqual(persisted.platform, currentDecision.platform)
    && Boolean(persisted.handsRelease) && Boolean(currentDecision.handsRelease)
    && isDeepStrictEqual(persisted.handsRelease, currentDecision.handsRelease);
}
