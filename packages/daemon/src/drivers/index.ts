import type { RuntimeDriver } from "./types";
import { ClaudeDriver } from "./claude";
import { CodexDriver } from "./codex";
import { GrokDriver } from "./grok";
import { AntigravityDriver } from "./antigravity.deprecated";
import { CopilotDriver } from "./copilot";
import { CursorDriver } from "./cursor";
import { GeminiDriver } from "./gemini";
import { KimiDriver } from "./kimi";
import { KimiSdkDriver } from "./kimi-sdk";
import { OpenCodeDriver } from "./opencode";
import { BuiltInDriver, PiDriver } from "./pi";

export type {
  RuntimeDriver,
  RuntimeBusyDeliveryReadiness,
  ParsedEvent,
  SpawnContext,
  SpawnResult,
  RuntimeSession,
  RuntimeExitInfo,
  RuntimeSendResult,
  RuntimeSessionDescriptor,
  RuntimeTurnAttribution,
} from "./types";
export { createChildProcessRuntimeSession, ChildProcessRuntimeSession } from "./runtimeSession";
export {
  allowedTranscriptRootsForRuntime,
  ensureRuntimeHomeDir,
  resolveRuntimeHomeDir,
  resolveRuntimeSessionRef,
  resolveRuntimeSessionRefDetailed,
  writeRuntimeLifecycleDiagnosticRecord,
  writeRuntimeTerminalCauseRecord,
  type RuntimeLifecycleDiagnosticEvent,
  type ResolveRuntimeSessionRefOptions,
  type RuntimeSessionRefResolution,
  type RuntimeSessionResolution,
  type RuntimeTerminalCausePhase,
} from "./runtimeArtifacts";
export {
  projectCompactionInterruptionTraceAttrs,
  projectCompactionInterruption,
  formatCompactionInterruption,
  projectStructuredRuntimeTerminalFailure,
} from "../runtimeCompactionProjection";
export { resolveClaudeCommand } from "./claude";
export { buildCodexAppServerArgs, parseCodexJsonRpcLine, resolveCodexSpawn } from "./codex";

const driverFactories: Record<string, () => RuntimeDriver> = {
  builtin: () => new BuiltInDriver(),
  claude: () => new ClaudeDriver(),
  codex: () => new CodexDriver(),
  grok: () => new GrokDriver(),
  // Deprecated: retain for existing agents to run/resume. Shared availability
  // and server admission prohibit creating agents or switching into this runtime.
  antigravity: () => new AntigravityDriver(),
  copilot: () => new CopilotDriver(),
  cursor: () => new CursorDriver(),
  gemini: () => new GeminiDriver(),
  // Two separate Kimi runtimes (per #proj-runtime:cc818e65 6/16 consensus):
  //   - `kimi`     = legacy kimi-cli child-process driver. Backward-compat for
  //                  existing `runtime=kimi` agents. Frontend marks deprecated.
  //   - `kimi-sdk` = canonical in-process SDK driver. Frontend label "Kimi Code".
  // No alias / no auto-migration; explicit pick at agent-create time.
  kimi: () => new KimiDriver(),
  "kimi-sdk": () => new KimiSdkDriver(),
  opencode: () => new OpenCodeDriver(),
  pi: () => new PiDriver(),
};

/** Every runtime id `getDriver` accepts. */
export function registeredRuntimeIds(): string[] {
  return Object.keys(driverFactories);
}

/** Get the driver for a runtime ID. Throws if unknown. */
export function getDriver(runtimeId: string): RuntimeDriver {
  const createDriver = driverFactories[runtimeId];
  const driver = createDriver?.();
  if (!driver) {
    throw new Error(`Unknown runtime: ${runtimeId}. Available: ${Object.keys(driverFactories).join(", ")}`);
  }
  return driver;
}
