import { spawn } from "node:child_process";
import path from "node:path";
import { clearClockTimeout, CURSOR_MODEL_DETECTION_TIMEOUT_MS, hydrateRuntimeConfig, setClockTimeout, runtimeConfigToLaunchFields, runtimeModelSourceOutcomeFromSet, type AgentConfig, type RuntimeModelInfo, type RuntimeModelSet, type RuntimeModelSourceOutcome , type AxSurfaceText } from "@botiverse/raft-shared";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent } from "./types";
import { buildCliTransportSystemPrompt, prepareCliTransport } from "./cliTransport";
import { withWindowsUserEnvironment, type ProbeDeps } from "./probe";
import {
  installManagedMcpRuntimeJsonOverlay,
  prepareManagedMcpRuntimeProxy,
} from "../managedMcpRuntimeProxy";

interface CursorModelsCommandResult {
  status: number | null;
  stdout?: string | Buffer | null;
  error?: Error;
  /** The probe was killed at its deadline rather than failing on its own. */
  timedOut?: boolean;
}

type CursorModelsAsyncCommand = () => Promise<CursorModelsCommandResult>;

export async function buildCursorSpawnEnv(ctx: SpawnContext, deps: ProbeDeps = {}): Promise<NodeJS.ProcessEnv> {
  const { spawnEnv } = await prepareCliTransport(ctx, { NO_COLOR: "1" });
  return withWindowsUserEnvironment(spawnEnv, deps);
}

export function buildCursorManagedMcpConfig(
  config: Record<string, unknown>,
  managedMcp: { name: string; url: string },
): Record<string, unknown> {
  return {
    ...config,
    mcpServers: {
      ...(config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
        ? config.mcpServers as Record<string, unknown>
        : {}),
      [managedMcp.name]: { url: managedMcp.url },
    },
  };
}

export function buildCursorArgs(ctx: SpawnContext): string[] {
  const args = [
    "--print",
    "--output-format", "stream-json",
    "--force",
  ];

  const launchRuntimeFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
  if (launchRuntimeFields.model && launchRuntimeFields.model !== "default") {
    args.push("--model", launchRuntimeFields.model);
  }

  if (ctx.config.sessionId) {
    args.push("--resume", ctx.config.sessionId);
  }

  args.push(ctx.prompt);
  return args;
}

/**
 * Cursor CLI driver.
 *
 * Uses `--print --output-format stream-json` which emits the same NDJSON
 * event format as Claude Code (system/init, assistant, result).
 *
 * No stdin streaming support — each turn is a separate process invocation.
 */
export class CursorDriver implements RuntimeDriver {
  readonly id = "cursor";
  readonly lifecycle = {
    kind: "per_turn",
    start: "immediate",
    exit: "natural",
    inFlightWake: "spawn_new",
  } as const;
  readonly communication = {
    chat: "slock_cli",
    runtimeControl: "none",
  } as const;
  readonly session = {
    recovery: "resume_or_fresh",
  } as const;
  readonly model = {
    detectedModelsVerifiedAs: "launchable",
    toLaunchSpec: (modelId: string) => ({ args: ["--model", modelId] }),
  } as const;
  readonly supportsStdinNotification = false;
  readonly busyDeliveryMode = "none" as const;

  async spawn(ctx: SpawnContext): Promise<SpawnResult> {
    const managedMcp = await prepareManagedMcpRuntimeProxy({
      agentId: ctx.agentId,
      launchId: ctx.launchId,
      serverUrl: ctx.config.serverUrl,
      agentCredentialKey: ctx.config.agentCredentialKey,
    });
    if (managedMcp) {
      installManagedMcpRuntimeJsonOverlay({
        agentId: ctx.agentId,
        launchId: ctx.launchId,
        filePath: path.join(ctx.workingDirectory, ".cursor", "mcp.json"),
        apply: (config) => buildCursorManagedMcpConfig(config, managedMcp),
      });
    }

    const args = buildCursorArgs(ctx);

    const spawnEnv = await buildCursorSpawnEnv(ctx);

    const proc = spawn("cursor-agent", args, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
      shell: process.platform === "win32",
    });

    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }

    const events: ParsedEvent[] = [];

    switch (event.type) {
      case "system":
        if (event.subtype === "init" && event.session_id) {
          events.push({ kind: "session_init", sessionId: event.session_id });
        } else if (event.subtype === "status" && event.status === "compacting") {
          events.push({ kind: "compaction_started" });
        } else if (event.subtype === "compact_boundary") {
          events.push({ kind: "compaction_finished" });
        }
        break;

      case "assistant": {
        const content = event.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "thinking" && block.thinking) {
              events.push({ kind: "thinking", text: block.thinking });
            } else if (block.type === "text" && block.text) {
              events.push({ kind: "text", text: block.text });
            } else if (block.type === "tool_use") {
              events.push({ kind: "tool_call", name: block.name || "unknown_tool", input: block.input });
            }
          }
        }
        break;
      }

      case "result": {
        const subtype = typeof event.subtype === "string" ? event.subtype : "success";
        if (subtype !== "success" || event.is_error) {
          const parts: string[] = [];
          if (Array.isArray(event.errors)) {
            for (const err of event.errors) {
              if (typeof err === "string" && err.trim()) parts.push(err.trim());
            }
          }
          if (typeof event.result === "string" && event.result.trim()) {
            parts.push(event.result.trim());
          }
          const detail = parts.join(" | ") || "Execution failed";
          events.push({ kind: "error", message: detail });
        }
        events.push({ kind: "turn_end", sessionId: event.session_id });
        break;
      }
    }

    return events;
  }

  encodeStdinMessage(
    _text: string,
    _sessionId: string | null,
    _opts?: { mode?: "idle" | "busy" },
  ): string | null {
    // Cursor CLI does not support stdin streaming
    return null;
  }

  buildSystemPrompt(config: AgentConfig, _agentId: string): AxSurfaceText {
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: [],
    });
  }

  async detectModels(): Promise<RuntimeModelSourceOutcome> {
    return detectCursorModelSource();
  }

}

export function parseCursorModelsOutput(output: string): RuntimeModelSet | null {
  const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, "");
  const models: RuntimeModelInfo[] = [];
  let defaultModel: string | undefined;

  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^available models$/i.test(line) || /^tip:/i.test(line)) continue;
    if (/^no models available/i.test(line) || /^failed to load models:/i.test(line)) continue;

    let modelLine = line;
    const markerMatch = modelLine.match(/\s+\(([^)]+)\)$/);
    const markers = markerMatch?.[1]?.split(",").map((part) => part.trim().toLowerCase()) ?? [];
    if (markers.length > 0 && markers.every((part) => part === "current" || part === "default")) {
      const markerStart = markerMatch?.index ?? modelLine.length;
      modelLine = modelLine.slice(0, markerStart).trim();
    }

    const match = modelLine.match(/^(\S+)(?:\s+-\s+(.+))?$/);
    if (!match) continue;

    const id = match[1]?.trim();
    if (!id || id.startsWith("-")) continue;

    const label = match[2]?.trim() || id;
    models.push({ id, label, verified: "launchable" });
    if (markers.includes("default")) defaultModel = id;
  }

  if (models.length === 0) return null;
  return { models, default: defaultModel };
}

export async function detectCursorModelSource(
  runCommand: CursorModelsAsyncCommand = () => runCursorModelsCommandAsync(),
): Promise<RuntimeModelSourceOutcome> {
  const result = await runCommand();
  if (result.timedOut) return { kind: "error", retryable: true, code: "detect_timeout" };
  if (result.error || result.status !== 0) {
    return { kind: "error", retryable: true };
  }
  return runtimeModelSourceOutcomeFromSet(parseCursorModelsOutput(String(result.stdout || "")));
}

export function buildCursorModelProbeEnv(deps: ProbeDeps = {}): NodeJS.ProcessEnv {
  return withWindowsUserEnvironment({
    ...(deps.env ?? process.env),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  }, deps);
}

/** Cap on probe stdout: a model listing is a few KB; spawnSync's old default was 1 MiB. */
export const CURSOR_MODEL_PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface CursorModelsProbeOptions {
  timeoutMs?: number;
  command?: string;
  args?: string[];
  maxOutputBytes?: number;
  platform?: NodeJS.Platform;
  /** Kill the probe and every process it started. */
  killTree?: (pid: number, platform: NodeJS.Platform) => void;
}

/**
 * Kill a probe's whole process tree. POSIX probes run in their own process
 * group (detached), so signalling -pid reaches a wrapper's children; Windows
 * has no groups, so `taskkill /T` walks the tree.
 */
export function killCursorProbeTree(pid: number, platform: NodeJS.Platform): void {
  try {
    if (platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // already gone
  }
}

/**
 * Async `cursor-agent models`. The old spawnSync froze the whole daemon for up
 * to its timeout. stdin is closed so a login prompt cannot wait for input,
 * output is capped, and the deadline or the cap kills the probe's process tree
 * (a surviving child would otherwise linger or hold stdout open).
 */
export function runCursorModelsCommandAsync(options: CursorModelsProbeOptions = {}): Promise<CursorModelsCommandResult> {
  const {
    timeoutMs = CURSOR_MODEL_DETECTION_TIMEOUT_MS,
    command = "cursor-agent",
    args = ["models"],
    maxOutputBytes = CURSOR_MODEL_PROBE_MAX_OUTPUT_BYTES,
    platform = process.platform,
    killTree = killCursorProbeTree,
  } = options;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timer: unknown;
    const output = () => Buffer.concat(chunks).toString("utf8");
    const finish = (result: CursorModelsCommandResult) => {
      if (settled) return;
      settled = true;
      clearClockTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        env: buildCursorModelProbeEnv(),
        stdio: ["ignore", "pipe", "ignore"],
        detached: platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      resolve({ status: null, error: error as Error });
      return;
    }
    const kill = () => {
      if (child.pid !== undefined) killTree(child.pid, platform);
      else child.kill("SIGKILL");
    };
    timer = setClockTimeout(() => {
      kill();
      finish({ status: null, stdout: output(), timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        kill();
        finish({ status: null, error: new Error(`cursor-agent models output exceeded ${maxOutputBytes} bytes`) });
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (error) => finish({ status: null, stdout: output(), error }));
    child.on("close", (status) => finish({ status, stdout: output() }));
  });
}
