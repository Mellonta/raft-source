// The path to re-exec the running Computer/daemon binary.
//
// `process.execPath` is captured once at process start. A K upgrade starts the
// candidate from `<stateDir>/slots/experiment/artifact.bin` and, once it is
// healthy, promotes it by RENAMING the experiment slot directory to `stable`
// without restarting the process (k-carrier storage.rs). From then on the
// running binary lives at `slots/stable/artifact.bin`, but `process.execPath`
// still names the vanished experiment path. Anything that spawns the binary
// again — agent `raft` wrappers, `__run` respawns, service self-restart — must
// resolve the live path instead of trusting the startup string.
//
// Pure: callers inject the filesystem probes so this module stays fs-free.

export interface LiveExecutablePathDeps {
  execPath: string;
  platform: string;
  exists: (path: string) => boolean;
  /** Linux `/proc/self/exe` target, or null when unavailable. */
  readProcSelfExe?: () => string | null;
  /** File identity (e.g. `dev:ino`) of a path, or null when unknown. */
  identityOf?: (path: string) => string | null;
  /** Identity of the running binary, captured at process start. */
  startupIdentity?: string | null;
}

const K_EXPERIMENT_SLOT_RE = /^(.*[\\/]slots[\\/])experiment([\\/][^\\/]+)$/;
const PROC_DELETED_SUFFIX = " (deleted)";

// K stages the NEXT candidate into `slots/experiment` before it stops the
// running service (k-carrier engine.rs: stage → quiesce → stop). On a machine
// promoted earlier and never restarted, the startup path then exists again but
// names the new candidate, not the running binary. So a path is only taken when
// it IS the running file: Linux asks the kernel (/proc/self/exe); elsewhere the
// file identity recorded at start must match.
export function resolveLiveExecutablePath(deps: LiveExecutablePathDeps): string {
  const { execPath, platform, exists } = deps;
  if (platform === "linux" && deps.readProcSelfExe) {
    const target = deps.readProcSelfExe();
    // The kernel follows renames; a deleted file is not re-executable.
    if (target && !target.endsWith(PROC_DELETED_SUFFIX) && exists(target)) return target;
  }
  const promoted = kPromotedSlotPath(execPath);
  const candidates = promoted ? [execPath, promoted] : [execPath];
  const startup = deps.startupIdentity ?? null;
  if (startup && deps.identityOf) {
    for (const candidate of candidates) {
      if (exists(candidate) && deps.identityOf(candidate) === startup) return candidate;
    }
    return execPath;
  }
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return execPath;
}

/** `…/slots/experiment/<file>` → `…/slots/stable/<file>`; null otherwise. */
export function kPromotedSlotPath(execPath: string): string | null {
  const match = K_EXPERIMENT_SLOT_RE.exec(execPath);
  return match ? `${match[1]}stable${match[2]}` : null;
}
