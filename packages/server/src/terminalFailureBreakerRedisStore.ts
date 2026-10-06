/**
 * RFC 071 — Redis-backed store for the terminal-failure breaker, and the
 * combined two-key claim script (§4.3 step 3).
 *
 * Key `slock:agent:{agentId}:terminal_failure_breaker`, hash {version, state},
 * written with the same versioned Lua compare-and-set as the task #1119 key
 * (`CAS_WAKE_CRASH_LOOP_LUA`). Without Redis, a process-local store that
 * shares the #1119 in-memory store, so the combined claim still covers both.
 *
 * The combined script relies on the current single-node client
 * (`new Redis(url)`, redis.ts). A move to Redis Cluster must first put both
 * keys in one hash slot (a `{agentId}` hash tag), which renames both keys and
 * needs a migration (RFC 071 §4.3).
 */
import { getRedis, isRedisAvailable } from "./redis";
import {
  CAS_WAKE_CRASH_LOOP_LUA,
  WAKE_CRASH_LOOP_UNBLOCKED_TTL_SEC,
  encodeWakeCrashLoopState,
  getWakeCrashLoopState,
  localWakeCrashLoopStateStore,
  wakeCrashLoopKey,
} from "./replicaRouter";
import type { WakeCrashLoopStateRecord } from "./services/wakeCrashLoopBreaker";
import {
  TERMINAL_BREAKER_UNREADABLE,
  decodeTerminalFailureBreakerState,
  encodeTerminalFailureBreakerState,
  terminalBreakerTtlSeconds,
  type TerminalFailureBreakerState,
} from "./terminalFailureBreaker";
import {
  InMemoryTerminalFailureBreakerStore,
  type TerminalAndWakeCrashLoopWrite,
  type TerminalFailureBreakerStore,
  type TerminalFailureBreakerStoredRecord,
} from "./terminalFailureBreakerStore";

export const terminalFailureBreakerKey = (agentId: string) => `slock:agent:${agentId}:terminal_failure_breaker`;

/**
 * KEYS[1] = terminal hash, KEYS[2] = #1119 wake crash-loop hash.
 * ARGV[1..3] = terminal expected version ("0" when absent), state, ttl ("0" = persist);
 * ARGV[4..6] = the same for the #1119 record.
 * Writes BOTH only when BOTH stored versions equal the expected ones; returns 1/0.
 */
export const CAS_TERMINAL_AND_WAKE_CRASH_LOOP_LUA = `
local t = redis.call('HGET', KEYS[1], 'version')
if t == false then t = '0' end
local w = redis.call('HGET', KEYS[2], 'version')
if w == false then w = '0' end
if t ~= ARGV[1] or w ~= ARGV[4] then return 0 end
redis.call('HSET', KEYS[1], 'version', tostring(tonumber(t) + 1), 'state', ARGV[2])
if tonumber(ARGV[3]) > 0 then redis.call('EXPIRE', KEYS[1], ARGV[3]) else redis.call('PERSIST', KEYS[1]) end
redis.call('HSET', KEYS[2], 'version', tostring(tonumber(w) + 1), 'state', ARGV[5])
if tonumber(ARGV[6]) > 0 then redis.call('EXPIRE', KEYS[2], ARGV[6]) else redis.call('PERSIST', KEYS[2]) end
return 1
`;

/** No-Redis fallback: shares the #1119 process-local store so the combined claim covers both. */
export const localTerminalFailureBreakerStore = new InMemoryTerminalFailureBreakerStore(localWakeCrashLoopStateStore);

export async function getTerminalFailureBreakerState(agentId: string): Promise<TerminalFailureBreakerStoredRecord | null> {
  if (!isRedisAvailable()) return localTerminalFailureBreakerStore.getTerminalFailureBreakerState(agentId);
  const data = await getRedis().hgetall(terminalFailureBreakerKey(agentId));
  if (data.state === undefined && data.version === undefined) return null;
  const version = Number(data.version);
  if (!Number.isInteger(version) || version <= 0) {
    // No usable version: nothing can compare-and-set against it. Same as #1119.
    console.warn(`[TerminalFailureBreaker] state for agent ${agentId} has no usable version (version=${String(data.version)})`);
    return null;
  }
  const state = decodeTerminalFailureBreakerState(data.state);
  if (state === TERMINAL_BREAKER_UNREADABLE) {
    // RFC 071 §4.1: read as closed + owedOverflow, never as a recovery.
    console.warn(`[TerminalFailureBreaker] state for agent ${agentId} is unreadable (version=${version}); closed with every unread row owed`);
  }
  return { state, version };
}

export async function compareAndSetTerminalFailureBreakerState(
  agentId: string,
  expectedVersion: number,
  state: TerminalFailureBreakerState,
): Promise<boolean> {
  if (!isRedisAvailable()) return localTerminalFailureBreakerStore.compareAndSetTerminalFailureBreakerState(agentId, expectedVersion, state);
  const result = await getRedis().eval(
    CAS_WAKE_CRASH_LOOP_LUA,
    1,
    terminalFailureBreakerKey(agentId),
    String(expectedVersion),
    encodeTerminalFailureBreakerState(state),
    String(terminalBreakerTtlSeconds(state)),
  );
  return result === 1;
}

export async function compareAndSetTerminalAndWakeCrashLoop(agentId: string, write: TerminalAndWakeCrashLoopWrite): Promise<boolean> {
  if (!isRedisAvailable()) return localTerminalFailureBreakerStore.compareAndSetTerminalAndWakeCrashLoop(agentId, write);
  const wake = write.wakeCrashLoop.state;
  const result = await getRedis().eval(
    CAS_TERMINAL_AND_WAKE_CRASH_LOOP_LUA,
    2,
    terminalFailureBreakerKey(agentId),
    wakeCrashLoopKey(agentId),
    String(write.terminal.expectedVersion),
    encodeTerminalFailureBreakerState(write.terminal.state),
    String(terminalBreakerTtlSeconds(write.terminal.state)),
    String(write.wakeCrashLoop.expectedVersion),
    encodeWakeCrashLoopState(wake),
    // The #1119 TTL rule, exactly as compareAndSetWakeCrashLoopState applies it.
    String(wake.blocked ? 0 : WAKE_CRASH_LOOP_UNBLOCKED_TTL_SEC),
  );
  return result === 1;
}

/** The Redis-backed store (with the in-memory fallback when Redis is not configured). */
export const redisTerminalFailureBreakerStore: TerminalFailureBreakerStore = {
  getTerminalFailureBreakerState,
  compareAndSetTerminalFailureBreakerState,
  getWakeCrashLoopState: (agentId: string): Promise<WakeCrashLoopStateRecord | null> => getWakeCrashLoopState(agentId),
  compareAndSetTerminalAndWakeCrashLoop,
};
