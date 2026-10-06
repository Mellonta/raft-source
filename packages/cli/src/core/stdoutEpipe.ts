import type { EventEmitter } from "node:events";

/**
 * `raft … | head` closes the pipe early. That is the reader's choice, not a
 * CLI failure: swallow EPIPE (and the follow-up writes to the destroyed
 * stream) instead of dumping an unhandled stack into the caller's output.
 * Never exits: the command finishes and keeps the exit code it set, so a
 * held or failed command stays non-zero under `set -o pipefail`. Any other
 * stdout error stays fatal.
 */
export function installStdoutEpipeGuard(stdout: EventEmitter): void {
  stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") return;
    throw err;
  });
}
