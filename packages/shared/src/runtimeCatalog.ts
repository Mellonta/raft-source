// Runtime catalog: the runtime ids Raft knows, their display names, and the
// external-agent runtime. Kept dependency-light on purpose: the CLI and the SDK
// render runtime labels in agent-facing text (profile cards), and the SDK must
// not pull the whole shared root index into its bundle to do so. The root
// index re-exports everything here, so existing imports are unchanged.

export const EXTERNAL_AGENT_RUNTIME_ID = "external" as const;
export const EXTERNAL_AGENT_RUNTIME_MODEL = "external" as const;
export const EXTERNAL_AGENT_RUNTIME_DISPLAY_NAME = "External agent" as const;

export function isExternalAgentRuntime(runtime: string | null | undefined): boolean {
  return runtime === EXTERNAL_AGENT_RUNTIME_ID;
}

export interface RuntimeInfo {
  /** Short ID used in DB, protocol, and config (e.g. "claude") */
  id: string;
  /** Human-readable name (e.g. "Claude Code") */
  displayName: string;
  /** Stable, designed short label for compact runtime icons (e.g. "CC") */
  abbreviation: string;
  /** CLI binary name to detect on PATH (e.g. "claude") */
  binary: string;
  /** Whether this runtime is currently supported */
  supported: boolean;
  /** Deprecated runtimes are hidden from selectors + detection display, but kept for backward compat with existing agents on that runtime. */
  deprecated?: boolean;
}

export const RUNTIMES: RuntimeInfo[] = [
  { id: "claude", displayName: "Claude Code", abbreviation: "CC", binary: "claude", supported: true },
  { id: "codex", displayName: "Codex CLI", abbreviation: "CX", binary: "codex", supported: true },
  { id: "grok", displayName: "Grok Build", abbreviation: "GK", binary: "grok", supported: true },
  { id: "builtin", displayName: "Built-in Pi", abbreviation: "BP", binary: "", supported: true },
  { id: "antigravity", displayName: "Antigravity CLI", abbreviation: "AG", binary: "agy", supported: true, deprecated: true },
  // Kimi: prefer the in-process SDK (`kimi-sdk` → "Kimi Code") for new agents.
  // The legacy `kimi` (kimi-cli child-process) entry stays for backward compat
  // with existing `runtime=kimi` agents but is labelled deprecated.
  { id: "kimi-sdk", displayName: "Kimi Code", abbreviation: "KC", binary: "", supported: true },
  { id: "kimi", displayName: "Kimi CLI", abbreviation: "KL", binary: "kimi", supported: true, deprecated: true },
  { id: "copilot", displayName: "Copilot CLI", abbreviation: "CP", binary: "copilot", supported: true },
  { id: "cursor", displayName: "Cursor CLI", abbreviation: "CU", binary: "cursor-agent", supported: true },
  // Gemini CLI: deprecated — no longer maintained upstream, replaced by
  // Antigravity CLI (`antigravity` → "Antigravity CLI"). Kept for backward
  // compat with existing `runtime=gemini` agents but hidden from selectors.
  { id: "gemini", displayName: "Gemini CLI", abbreviation: "GM", binary: "gemini", supported: true, deprecated: true },
  { id: "opencode", displayName: "OpenCode", abbreviation: "OC", binary: "opencode", supported: true },
  { id: "pi", displayName: "Pi", abbreviation: "PI", binary: "pi", supported: true },
];

/**
 * Label suffix for a runtime in a machine's runtime picker. A runtime is offered
 * only when the daemon reports it in `machineRuntimeIds` (its capability list) —
 * that gating is intentional: a runtime the daemon can't run must not be
 * selectable. This helper only chooses the *wording* for an unavailable one:
 *
 * - unsupported → " (coming soon)"
 * - in-process runtime (`binary === ""`, e.g. Built-in, Kimi Code) that the
 *   daemon doesn't report → " (update computer)": there is nothing to install
 *   locally; the daemon/computer simply predates the runtime, so "(not
 *   installed)" would be misleading.
 * - local CLI runtime (`binary !== ""`) the daemon didn't detect → " (not installed)"
 * - available → "" (no suffix)
 */
export type RuntimeAvailabilitySuffix =
  | { kind: "none" }
  | { kind: "comingSoon" }
  | { kind: "updateComputer" }
  | { kind: "notInstalled" };

/**
 * Locale-free runtime availability classifier (the machineRunLabel pattern):
 * returns a KIND, never display text. Web consumers map the kind to a catalog
 * id so the zh UI renders （未安装）/（需更新计算机）instead of the old hardcoded
 * English suffixes (" (not installed)" etc.).
 */
export function runtimeAvailabilitySuffix(r: RuntimeInfo, machineRuntimeIds: readonly string[]): RuntimeAvailabilitySuffix {
  if (!r.supported) return { kind: "comingSoon" };
  if (machineRuntimeIds.includes(r.id)) return { kind: "none" };
  return r.binary === "" ? { kind: "updateComputer" } : { kind: "notInstalled" };
}

export function isRuntimeDeprecated(runtimeId: string): boolean {
  return RUNTIMES.some((runtime) => runtime.id === runtimeId && Boolean(runtime.deprecated));
}

export function isRuntimeSelectableForNewAgent(runtime: RuntimeInfo): boolean {
  return runtime.supported && !runtime.deprecated;
}

export function getCreatableRuntimeOptions(): RuntimeInfo[] {
  return RUNTIMES.filter(isRuntimeSelectableForNewAgent);
}

export function isRuntimeVisibleForExistingAgent(runtime: RuntimeInfo, currentRuntime: string): boolean {
  return !runtime.deprecated || runtime.id === currentRuntime;
}

export function getExistingAgentRuntimeOptions(currentRuntime: string): RuntimeInfo[] {
  return RUNTIMES.filter((runtime) => isRuntimeVisibleForExistingAgent(runtime, currentRuntime));
}

export function isRuntimeSetupCandidate(runtime: RuntimeInfo): boolean {
  return runtime.supported && !runtime.deprecated && runtime.id !== "builtin";
}

export function getSetupRuntimeOptions(): RuntimeInfo[] {
  return RUNTIMES.filter(isRuntimeSetupCandidate);
}

export function getMachineRuntimeDisplayOptions(): RuntimeInfo[] {
  return RUNTIMES.filter((runtime) => runtime.supported && !runtime.deprecated);
}

/** Map runtime ID → display name. Falls back to the ID itself. */
export function getRuntimeDisplayName(id: string): string {
  if (isExternalAgentRuntime(id)) return EXTERNAL_AGENT_RUNTIME_DISPLAY_NAME;
  return RUNTIMES.find((r) => r.id === id)?.displayName ?? id;
}
