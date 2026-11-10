/**
 * Pi creates its sessions under a temporary `process.env` patch (the agent's
 * configured env vars): the Pi SDK reads provider and config values from
 * `process.env` and has no per-session env. The patch is held across awaits,
 * so for that window the daemon's environment is another agent's. Every place
 * that builds a child's environment from the daemon's own must read
 * {@link ambientProcessEnv}, never `process.env`, or an agent spawned during
 * the window inherits the patched agent's variables (task #28).
 */

let processEnvPatchTail: Promise<void> = Promise.resolve();

/** Pre-patch values of the keys the active patch replaced (undefined = was unset). */
let activePatchPrevious: ReadonlyMap<string, string | undefined> | null = null;

async function runWithProcessEnvPatchLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = processEnvPatchTail;
  let release!: () => void;
  processEnvPatchTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function withProcessEnvPatch<T>(
  patch: Record<string, string> | null | undefined,
  fn: () => Promise<T>,
  opts: { removeFirst?: readonly string[] } = {},
): Promise<T> {
  const keys = new Set([...(opts.removeFirst ?? []), ...Object.keys(patch ?? {})]);
  // This flag belongs to the Computer service. A Pi session's temporary
  // process-wide environment must never change the daemon's reporting policy.
  for (const key of keys) {
    if (key.toUpperCase() === "RAFT_PRIVACY_MODE") keys.delete(key);
  }
  if (keys.size === 0) return fn();

  return runWithProcessEnvPatchLock(async () => {
    const previous = new Map<string, string | undefined>();
    for (const key of keys) {
      previous.set(key, process.env[key]);
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (keys.has(key)) process.env[key] = value;
    }
    activePatchPrevious = previous;
    try {
      return await fn();
    } finally {
      activePatchPrevious = null;
      for (const [key, value] of previous) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
}

/**
 * A copy of the daemon's own environment: `process.env` with any active Pi
 * session-create patch undone. Use it wherever a child's env is built from
 * the daemon's.
 */
export function ambientProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (activePatchPrevious) {
    for (const [key, value] of activePatchPrevious) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  return env;
}
