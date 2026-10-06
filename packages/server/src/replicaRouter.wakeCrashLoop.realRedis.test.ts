// Real-Redis teeth for the wake crash-loop breaker store (RFC 071 F1).
// The Redis store wrote the whole episode as JSON, but the decoder rebuilt it
// without the task #1221 fields, so the catch-up obligation and the
// needs-action reason read back as absent after any write. Only the in-memory
// store round-tripped them, and that is the store every other test uses.
// Gated like the probe-relay real-Redis suite: CI runs it in the
// probe-concurrency job with a Redis service; local runs need
// WAKE_CRASH_LOOP_REAL_REDIS_URL.
import assert from "node:assert/strict";
import { getRedis, getRedisPub, getRedisReplicaSub, getRedisSub, initRedis } from "./redis";
import { compareAndSetWakeCrashLoopState, getWakeCrashLoopState } from "./replicaRouter";
import { redisReplicaStateStore } from "./services/replicaStateStore";
import { WakeCrashLoopBreaker, type WakeCrashLoopEpisodeState } from "./services/wakeCrashLoopBreaker";

const REAL_REDIS_URL = process.env.WAKE_CRASH_LOOP_REAL_REDIS_URL;
const REAL_REDIS_REQUIRED = process.env.WAKE_CRASH_LOOP_REAL_REDIS_REQUIRED === "1";

function skipUnlessRealRedis(): boolean {
  if (REAL_REDIS_URL) return false;
  if (REAL_REDIS_REQUIRED) throw new Error("WAKE_CRASH_LOOP_REAL_REDIS_REQUIRED=1 but WAKE_CRASH_LOOP_REAL_REDIS_URL is unset");
  return true;
}

const agentIds: string[] = [];
function freshAgentId(): string {
  const id = `f1-wake-crash-loop-${Math.random().toString(36).slice(2)}`;
  agentIds.push(id);
  return id;
}

beforeAll(() => {
  if (REAL_REDIS_URL) initRedis(REAL_REDIS_URL);
});

afterAll(async () => {
  if (!REAL_REDIS_URL) return;
  for (const id of agentIds) await getRedis().del(`slock:agent:${id}:wake_crash_loop`);
  for (const client of [getRedis(), getRedisPub(), getRedisSub(), getRedisReplicaSub()]) client.disconnect();
});

test("real Redis: every episode field written through the store reads back equal", async () => {
  if (skipUnlessRealRedis()) return;
  const agentId = freshAgentId();
  const state: Required<WakeCrashLoopEpisodeState> = {
    episode: 4,
    earlyExitCount: 2,
    blocked: true,
    blockedAtMs: 1_700_000_003_000,
    lastStartAtMs: 1_700_000_000_000,
    lastStartLaunchId: "launch-2",
    lastStartCounted: true,
    firstExitAtMs: 1_700_000_001_000,
    lastExitAtMs: 1_700_000_002_000,
    lastExitKind: "machine_disconnected",
    lastSignal: "SIGKILL",
    lastLaunchId: "launch-2",
    needsActionReason: "model_not_configured",
    catchupOwed: true,
    catchupCarriedLaunchId: "launch-3",
  };
  assert.equal(await compareAndSetWakeCrashLoopState(agentId, 0, state), true);
  assert.deepEqual(await getWakeCrashLoopState(agentId), { state, version: 1 });
});

test("real Redis: the task #1221 catch-up obligation survives the store and clears only on the carrying start", async () => {
  if (skipUnlessRealRedis()) return;
  const agentId = freshAgentId();
  const breaker = new WakeCrashLoopBreaker(redisReplicaStateStore);
  await breaker.recordStart(agentId, "launch-1", 1_000);
  assert.equal(await breaker.recordNonRetryableStartFailure(agentId, { launchId: "launch-1", reason: "model_not_configured", nowMs: 1_100 }), true);
  assert.equal(await breaker.isBlocked(agentId), true);
  assert.equal(await breaker.isCatchupOwed(agentId), true, "the owed catch-up must be read back from Redis");
  assert.equal((await getWakeCrashLoopState(agentId))?.state.needsActionReason, "model_not_configured");

  // A person restarts: the block lifts, the catch-up stays owed and is carried by this start.
  await breaker.recordStart(agentId, "launch-2", 2_000, { human: true });
  assert.equal(await breaker.isCatchupOwed(agentId), true);
  await breaker.markCatchupCarried(agentId, "launch-2");
  assert.equal((await getWakeCrashLoopState(agentId))?.state.catchupCarriedLaunchId, "launch-2");
  assert.equal(await breaker.confirmCatchupDelivered(agentId, "launch-other"), false);
  assert.equal(await breaker.confirmCatchupDelivered(agentId, "launch-2"), true, "the carrying start's active report clears the obligation");
  assert.equal(await breaker.isCatchupOwed(agentId), false);
});
