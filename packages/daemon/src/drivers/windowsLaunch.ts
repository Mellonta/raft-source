import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { RuntimeExecutableNotFoundError } from "../spawnFailureErrors";
import { NodeHostUnavailableError, resolveNodeHostLaunch } from "./nodeHostLaunch";
import { resolveCommandOnPath, type ProbeDeps } from "./probe";

/**
 * Runtime launches never go through cmd.exe.
 *
 * With `shell: true` on Windows, Node joins the argv with spaces into a single
 * cmd.exe command line without quoting anything. Runtime argv carries model
 * names, session ids, JSON settings and, for per-turn runtimes, the whole
 * prompt — so spaces split arguments, newlines cut the command short, and
 * cmd.exe metacharacters are interpreted instead of passed through.
 *
 * Node also refuses to spawn a `.cmd`/`.bat` file without a shell, so a batch
 * shim on PATH is resolved to what it would have run and launched directly:
 * npm/pnpm shims (`"%dp0%\node_modules\pkg\cli.js" %*`) become
 * `<node> <entry> ...args`, and shims wrapping an `.exe` become that `.exe`.
 * A shim we cannot resolve is a launch error, never a cmd.exe fallback.
 */
export interface DirectLaunch {
  command: string;
  args: string[];
  /** Set when the launch needs a different environment (e.g. Electron node mode). */
  env?: NodeJS.ProcessEnv;
  shell: false;
}

export interface WindowsLaunchDeps extends ProbeDeps {
  /**
   * Runtime-specific resolution for a batch wrapper on PATH, tried before the
   * generic shim parser (e.g. Cursor's wrapper runs a PowerShell script that
   * picks a versioned node.exe + index.js). Return null to fall through.
   */
  resolveBatchLaunch?: (shimPath: string, args: string[]) => DirectLaunch | null;
}

export function isWindowsBatchFile(command: string): boolean {
  const ext = path.win32.extname(command).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

const SHIM_TARGET_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".exe", ".cmd", ".bat"]);
const SHIM_DIR_PREFIX = /^(?:%~dp0|%dp0%)\\*/i;

/**
 * Quoted paths a batch shim runs, in file order: npm and pnpm shims reference
 * the target relative to the shim (`%dp0%` / `%~dp0`), scoop shims by absolute
 * path. `node.exe` is the interpreter an npm shim prefers, not the CLI itself;
 * anything still holding a `%variable%` is not a path we can know.
 */
export function windowsShimTargets(shimPath: string, deps: WindowsLaunchDeps = {}): string[] {
  const readFileSyncFn = deps.readFileSyncFn ?? ((filePath: string) => readFileSync(filePath, "utf8"));
  let raw: string;
  try {
    raw = String(readFileSyncFn(shimPath, "utf8"));
  } catch {
    return [];
  }
  const winPath = path.win32;
  const shimDir = winPath.dirname(shimPath);
  const targets: string[] = [];
  for (const match of raw.matchAll(/"([^"\r\n]+)"/g)) {
    const quoted = match[1]!;
    const relative = quoted.replace(SHIM_DIR_PREFIX, "");
    const candidate = relative === quoted ? quoted : winPath.join(shimDir, relative);
    if (candidate.includes("%") || !winPath.isAbsolute(candidate)) continue;
    if (!SHIM_TARGET_EXTENSIONS.has(winPath.extname(candidate).toLowerCase())) continue;
    if (winPath.basename(candidate).toLowerCase() === "node.exe") continue;
    const target = winPath.normalize(candidate);
    if (target.toLowerCase() === winPath.normalize(shimPath).toLowerCase()) continue;
    if (!targets.includes(target)) targets.push(target);
  }
  return targets;
}

/** Why a Windows runtime launch could not be resolved; recorded on the spawn failure. */
export type WindowsLaunchFailureReason = "not_on_path" | "batch_target_unresolved" | "node_unavailable";

function launchFailure(runtimeId: string, reason: WindowsLaunchFailureReason, message: string): RuntimeExecutableNotFoundError {
  return new RuntimeExecutableNotFoundError({ runtimeId, message, reason });
}

function resolveNodeForShim(runtimeId: string, shimPath: string, deps: WindowsLaunchDeps): { command: string; env?: NodeJS.ProcessEnv } {
  try {
    const host = resolveNodeHostLaunch({
      env: deps.env ?? process.env,
      execPath: deps.execPath,
      execIsElectron: deps.execIsElectron,
      execIsSea: deps.execIsSea,
      hasNodeRuntime: deps.hasNodeRuntime,
    });
    return { command: host.command, env: host.env };
  } catch (error) {
    if (!(error instanceof NodeHostUnavailableError)) throw error;
  }
  // The daemon host cannot run JavaScript (single-file build). Use the
  // interpreter the shim itself would have picked: its sibling node.exe, then
  // node on PATH.
  const existsSyncFn = deps.existsSyncFn ?? existsSync;
  const sibling = path.win32.join(path.win32.dirname(shimPath), "node.exe");
  if (existsSyncFn(sibling)) return { command: sibling };
  const onPath = resolveCommandOnPath("node", deps);
  if (onPath && !isWindowsBatchFile(onPath)) return { command: onPath };
  throw launchFailure(
    runtimeId,
    "node_unavailable",
    `Cannot start ${runtimeId} on Windows: ${path.win32.basename(shimPath)} runs a Node.js script, but node.exe was not found next to it or on PATH. Install Node.js (https://nodejs.org) and restart Raft Computer, or install a native ${runtimeId} executable.`,
  );
}

const MAX_SHIM_DEPTH = 3;

/**
 * Turn an already-resolved Windows command path into a direct launch.
 */
export function resolveWindowsDirectLaunch(
  runtimeId: string,
  command: string,
  args: string[],
  deps: WindowsLaunchDeps = {},
): DirectLaunch {
  const existsSyncFn = deps.existsSyncFn ?? existsSync;
  let current = command;
  let shim = command;
  for (let depth = 0; depth <= MAX_SHIM_DEPTH; depth += 1) {
    if (!isWindowsBatchFile(current)) {
      if (![".js", ".mjs", ".cjs"].includes(path.win32.extname(current).toLowerCase())) {
        return { command: current, args, shell: false };
      }
      const node = resolveNodeForShim(runtimeId, shim, deps);
      return { command: node.command, args: [current, ...args], ...(node.env ? { env: node.env } : {}), shell: false };
    }
    const next = windowsShimTargets(current, deps).find((candidate) => existsSyncFn(candidate));
    if (!next) break;
    shim = current;
    current = next;
  }
  throw launchFailure(
    runtimeId,
    "batch_target_unresolved",
    `Cannot start ${runtimeId} on Windows: ${path.win32.basename(command)} is a batch wrapper (.cmd/.bat) whose target program could not be found, and Raft does not start runtimes through cmd.exe. Reinstall ${runtimeId} with npm (npm install -g) or install its native .exe, then restart Raft Computer.`,
  );
}

/**
 * Launch spec for a runtime CLI found by name. Off Windows the name is passed
 * to spawn unchanged (PATH lookup by the OS), as before.
 */
export function resolveRuntimeLaunch(
  runtimeId: string,
  commandName: string,
  args: string[],
  deps: WindowsLaunchDeps = {},
): DirectLaunch {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return { command: commandName, args, shell: false };
  const command = resolveCommandOnPath(commandName, deps);
  if (!command) {
    throw launchFailure(
      runtimeId,
      "not_on_path",
      `Cannot start ${runtimeId} on Windows: \`${commandName}\` was not found on PATH. Install it, check that \`${commandName}\` runs in a new terminal, then restart Raft Computer.`,
    );
  }
  if (deps.resolveBatchLaunch && isWindowsBatchFile(command)) {
    const launch = deps.resolveBatchLaunch(command, args);
    if (launch) return launch;
  }
  return resolveWindowsDirectLaunch(runtimeId, command, args, deps);
}
