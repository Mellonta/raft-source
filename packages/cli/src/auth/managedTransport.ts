import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";

export const SLOCK_CLI_TRANSPORT_DIR_ENV = "SLOCK_CLI_TRANSPORT_DIR";
export const SLOCK_AGENT_LAUNCH_DIR_ENV = "SLOCK_AGENT_LAUNCH_DIR";
const FORWARD_ATTEMPT_ENV = "SLOCK_CLI_MANAGED_FORWARD_ATTEMPT";

export class ManagedTransportError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ManagedTransportError";
  }
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function isRealDirectory(filePath: string): boolean {
  try {
    const stat = lstatSync(filePath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isRealFile(filePath: string): boolean {
  try {
    const stat = lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Resolve the current managed launch's daemon-owned wrapper when a host-global
 * CLI won PATH resolution. The transport directory is accepted only when it
 * exactly matches the daemon's non-secret SLOCK_HOME/agent/launch projection;
 * an arbitrary environment pathname is never executed.
 */
export function resolveManagedTransportWrapper(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const transportDir = env[SLOCK_CLI_TRANSPORT_DIR_ENV];
  if (!transportDir) return null;

  // A wrapper invocation already carries one of these credential carriers.
  // Do not recurse back into itself.
  if (
    env.SLOCK_AGENT_PROXY_TOKEN_FILE
    || env.SLOCK_AGENT_PROXY_TOKEN
    || env.SLOCK_AGENT_TOKEN_FILE
  ) {
    return null;
  }

  if (env[FORWARD_ATTEMPT_ENV]) {
    throw new ManagedTransportError(
      "MANAGED_WRAPPER_FORWARD_FAILED",
      "The managed Raft wrapper returned without providing credentials. Handoff stopped to prevent a loop; no local profile was used.",
    );
  }

  const slockHome = env.SLOCK_HOME;
  const agentId = env.SLOCK_AGENT_ID;
  const launchDir = env[SLOCK_AGENT_LAUNCH_DIR_ENV];
  if (!slockHome || !agentId || !launchDir) {
    throw new ManagedTransportError(
      "MANAGED_WRAPPER_UNAVAILABLE",
      "This command is inside a managed Raft runtime, but its current CLI wrapper identity is incomplete. Restart the managed runtime; no local profile was used.",
    );
  }

  const expectedDir = path.join(
    path.resolve(slockHome),
    "cli-transport",
    safePathPart(agentId),
    safePathPart(launchDir),
  );
  if (path.resolve(transportDir) !== expectedDir || !isRealDirectory(expectedDir)) {
    throw new ManagedTransportError(
      "MANAGED_WRAPPER_UNAVAILABLE",
      "This command is inside a managed Raft runtime, but its CLI transport directory does not match the current agent launch. Restart the managed runtime; no local profile was used.",
    );
  }

  if (platform === "win32") {
    // Node cannot safely execute a .cmd wrapper without a shell, while a shell
    // would reinterpret user command arguments. Fail closed instead of adding
    // a command-injection surface. Native managed Windows launches already put
    // the .cmd wrapper first in PATH; this branch is only the bypass recovery.
    throw new ManagedTransportError(
      "MANAGED_WRAPPER_REQUIRED",
      `The host-global Raft CLI was selected inside a managed runtime. Run the current daemon wrapper at ${path.join(expectedDir, "raft.cmd")} or restart the runtime; no local profile was used.`,
    );
  }

  const wrapperPath = path.join(expectedDir, "raft");
  if (!isRealFile(wrapperPath)) {
    throw new ManagedTransportError(
      "MANAGED_WRAPPER_UNAVAILABLE",
      `The current managed Raft wrapper is missing at ${wrapperPath}. Restart the managed runtime; no local profile was used.`,
    );
  }
  return wrapperPath;
}

export async function forwardManagedTransportIfNeeded(
  argv: string[],
  env: NodeJS.ProcessEnv,
  deps: {
    platform?: NodeJS.Platform;
    spawn?: typeof spawn;
  } = {},
): Promise<{ status: number | null; signal: NodeJS.Signals | null } | null> {
  const wrapperPath = resolveManagedTransportWrapper(env, deps.platform);
  if (!wrapperPath) return null;
  return new Promise((resolve, reject) => {
    const child = (deps.spawn ?? spawn)(wrapperPath, argv, {
      env: { ...env, [FORWARD_ATTEMPT_ENV]: "1" },
      stdio: "inherit",
      shell: false,
    });
    // Keep the event loop available: a signal addressed only to the global CLI
    // must also reach its wrapper/CLI child. Inherited descriptors preserve
    // pipes and TTY behavior without buffering message bodies or credentials.
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const handlers = signals.map((signal) => {
      const handler = () => { child.kill(signal); };
      process.on(signal, handler);
      return handler;
    });
    const cleanup = () => {
      signals.forEach((signal, i) => process.removeListener(signal, handlers[i]!));
    };
    child.once("error", () => {
      cleanup();
      reject(new ManagedTransportError(
        "MANAGED_WRAPPER_FORWARD_FAILED",
        "Could not start the current managed Raft wrapper; no local profile was used.",
      ));
    });
    child.once("exit", (status, signal) => {
      cleanup();
      resolve({ status, signal });
    });
  });
}
