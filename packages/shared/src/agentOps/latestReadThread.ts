// The thread an agent read most recently, from the read record the Raft CLI
// publishes on the machine. The CLI's source of truth is its agent ledger
// (`packages/cli/src/state/agentLedger.ts`); after every read it writes this
// JSON file as a view (`targets[target] = { seq, readOrder }`) for readers
// that cannot open the ledger, such as the SDK on Node 20.
//
// Pure: takes the parsed JSON of that record and answers one question. No
// filesystem, no network, no credential. The SDK wraps it with the file read;
// the CLI's own test writes a record through the CLI and reads it back through
// this function, so the two cannot drift apart silently.
//
// Rules:
// 1. Recency is the local read order, not the message seq: seqs are
//    Server-global, so a busy channel read earlier can carry a higher seq than
//    the thread read last. Records written before read order existed fall back
//    to their seq, as the CLI does.
// 2. The latest read of ANY kind decides. When it is a channel or DM root,
//    there is no latest thread: an older thread is not a substitute, because
//    it is not what the agent had in front of it.
// 3. Only full-body reads count. A target that carries exact seqs alone came
//    from a sparse drain (`raft message check`), which the CLI does not treat
//    as having read the conversation.

// Where the record lives. ONE definition, used by the CLI that writes the
// record and by the SDK that reads it, so a change here moves both. Pure
// values and string functions only (this package also runs in browsers); the
// callers join the path and touch the filesystem.
//
//   <base>/<CLI_READ_STATE_NAMESPACE>/<agentId>/<CLI_READ_STATE_FILENAME>
//   <base> = $SLOCK_CLI_CONSUMED_SEQ_STATE_DIR, else the Raft home
//   Raft home = $RAFT_HOME, else $SLOCK_HOME, else ~/<RAFT_HOME_DEFAULT_DIRNAME>
export const CLI_READ_STATE_NAMESPACE = "slock-cli-consumed-seq";
export const CLI_READ_STATE_FILENAME = "consumed-seqs.json";
export const CLI_READ_STATE_BASE_ENV = "SLOCK_CLI_CONSUMED_SEQ_STATE_DIR";
export const RAFT_HOME_ENVS = ["RAFT_HOME", "SLOCK_HOME"] as const;
export const RAFT_HOME_DEFAULT_DIRNAME = ".slock";

type Env = Record<string, string | undefined>;

/** The Raft home the environment configures, or undefined when the default (`~/.slock`) applies. */
export function configuredRaftHome(env: Env): string | undefined {
  for (const name of RAFT_HOME_ENVS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** The base directory the environment configures for the read record, or undefined when the default applies. */
export function configuredCliReadStateBase(env: Env): string | undefined {
  return env[CLI_READ_STATE_BASE_ENV]?.trim() || configuredRaftHome(env);
}

/** An agent id is a path segment of the record's location, so it must be a plain one. */
export function isLocalStateAgentId(agentId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(agentId);
}

/** The record's location under the base directory, as path segments. */
export function cliReadStatePathSegments(agentId: string): [string, string, string] {
  if (!isLocalStateAgentId(agentId)) throw new Error("Invalid local state agent identity");
  return [CLI_READ_STATE_NAMESPACE, agentId, CLI_READ_STATE_FILENAME];
}

export type LatestReadThread =
  | { state: "thread"; target: string; parentTarget: string }
  | { state: "none"; reason: "no_reads" | "latest_read_is_not_a_thread" };

function positiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** `#channel:thread` → `#channel`, `dm:@peer:thread` → `dm:@peer`; null for a channel or DM root. */
export function parentTargetOfThread(target: string): string | null {
  const from = target.startsWith("dm:@") ? "dm:@".length : target.startsWith("#") ? 1 : -1;
  if (from < 0) return null;
  const separator = target.indexOf(":", from);
  return separator > 0 && separator < target.length - 1 ? target.slice(0, separator) : null;
}

export function latestReadThreadFromCliReadState(raw: unknown): LatestReadThread {
  const targets = raw && typeof raw === "object" ? (raw as { targets?: unknown }).targets : undefined;
  let latestTarget: string | undefined;
  let latestOrder = 0;
  if (targets && typeof targets === "object" && !Array.isArray(targets)) {
    for (const [target, value] of Object.entries(targets as Record<string, unknown>)) {
      if (target.length === 0) continue;
      const record = typeof value === "number" ? { seq: value } : value && typeof value === "object" ? value as { seq?: unknown; readOrder?: unknown } : {};
      const order = positiveFinite((record as { readOrder?: unknown }).readOrder) ?? positiveFinite(record.seq);
      if (order !== undefined && order > latestOrder) {
        latestOrder = order;
        latestTarget = target;
      }
    }
  }
  if (latestTarget === undefined) return { state: "none", reason: "no_reads" };
  const parentTarget = parentTargetOfThread(latestTarget);
  if (parentTarget === null) return { state: "none", reason: "latest_read_is_not_a_thread" };
  return { state: "thread", target: latestTarget, parentTarget };
}
