import { existsSync, readlinkSync, statSync } from "node:fs";
import { resolveLiveExecutablePath } from "@botiverse/raft-shared";

/** `dev:ino` of a file, or null when the platform cannot report one. */
export function executableFileIdentity(path: string): string | null {
  try {
    const stat = statSync(path);
    return stat.ino > 0 ? `${stat.dev}:${stat.ino}` : null;
  } catch {
    return null;
  }
}

// Captured at module load, i.e. before any later K promotion or staging can
// rename or replace the file behind process.execPath.
const STARTUP_EXECUTABLE_IDENTITY = executableFileIdentity(process.execPath);

/**
 * The running SEA binary's re-execable path. K promotes an upgrade by renaming
 * the experiment slot to stable under the running service, so the startup
 * `process.execPath` can name a vanished `slots/experiment/…` path; respawning
 * a `__run` child or the service from it would fail with ENOENT.
 */
export function liveSeaExecutablePath(execPath: string = process.execPath): string {
  return resolveLiveExecutablePath({
    execPath,
    platform: process.platform,
    exists: existsSync,
    readProcSelfExe: () => {
      try {
        return readlinkSync("/proc/self/exe");
      } catch {
        return null;
      }
    },
    identityOf: executableFileIdentity,
    startupIdentity: STARTUP_EXECUTABLE_IDENTITY,
  });
}

