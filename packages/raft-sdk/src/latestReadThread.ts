// `readLatestReadThread`: the thread this agent read most recently with the
// Raft CLI on this machine. Node.js only. It reads the local record that
// `raft message read` keeps; it sends nothing to the Server and needs no
// credential, only the agent id that names the record.
//
// Read-only: it never creates, repairs, migrates, or rewrites the CLI's state.

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  cliReadStatePathSegments,
  configuredCliReadStateBase,
  isLocalStateAgentId,
  latestReadThreadFromCliReadState,
  RAFT_HOME_DEFAULT_DIRNAME,
} from "@botiverse/raft-shared/src/agentOps/index";

// The record's location (directory, file name, environment variables) is
// defined in shared, next to the reader, and the CLI writes through the same
// definitions. Nothing about the location is spelled out here.
const MAX_READ_STATE_BYTES = 32 * 1024 * 1024;

export interface ReadLatestReadThreadOptions {
  /** The agent whose reads to look at. Defaults to `SLOCK_AGENT_ID` from `env`. */
  agentId?: string;
  /**
   * The Raft home directory the CLI uses. Defaults to what the CLI resolves
   * from `env`: `RAFT_HOME`, then `SLOCK_HOME`, then `~/.slock`.
   */
  home?: string;
  /** Environment to resolve the defaults from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export type RaftLatestReadThread =
  | {
    state: "thread";
    /** The thread target, as `raft message read --target` takes it, for example `#general:1a2b3c4d`. */
    target: string;
    /** The channel or DM the thread belongs to, for example `#general`. */
    parentTarget: string;
  }
  | {
    state: "none";
    /**
     * - `no_agent_id`: no `agentId` was given and `SLOCK_AGENT_ID` is not set (or is not a valid id).
     * - `no_record`: the CLI has kept no read record for this agent here.
     * - `unreadable`: a record exists but is not a private regular file of this user, is too large, or is not JSON.
     * - `no_reads`: the record holds no read.
     * - `latest_read_is_not_a_thread`: the latest read was a channel or DM root. An older thread is never substituted.
     */
    reason: "no_agent_id" | "no_record" | "unreadable" | "no_reads" | "latest_read_is_not_a_thread";
  };

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/**
 * The thread this agent read most recently with `raft message read`, when
 * that read is still the latest read of any conversation.
 *
 * It is a fact about what was read, not about what the work belongs to: an
 * agent that read an unrelated thread afterwards gets that thread. Treat the
 * answer as a default to confirm, and keep private channel names out of
 * public places.
 */
export async function readLatestReadThread(options: ReadLatestReadThreadOptions = {}): Promise<RaftLatestReadThread> {
  const env = options.env ?? process.env;
  const agentId = firstNonEmpty(options.agentId, env.SLOCK_AGENT_ID);
  if (!agentId || !isLocalStateAgentId(agentId)) return { state: "none", reason: "no_agent_id" };

  const base = firstNonEmpty(options.home, configuredCliReadStateBase(env)) ?? join(homedir(), RAFT_HOME_DEFAULT_DIRNAME);
  const filePath = join(base, ...cliReadStatePathSegments(agentId));

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return { state: "none", reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "no_record" : "unreadable" };
  }
  let raw: unknown;
  try {
    const stat = await handle.stat();
    const ownedByUser = typeof process.getuid !== "function" || (stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
    if (!stat.isFile() || !ownedByUser || stat.size > MAX_READ_STATE_BYTES) return { state: "none", reason: "unreadable" };
    raw = JSON.parse(await handle.readFile("utf8"));
  } catch {
    return { state: "none", reason: "unreadable" };
  } finally {
    await handle.close();
  }
  return latestReadThreadFromCliReadState(raw);
}
