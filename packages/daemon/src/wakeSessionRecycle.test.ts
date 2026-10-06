import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildRecycleBriefing,
  decideWakeRecycle,
  planWakeSessionRecycle,
  readClaudeSessionResumeFacts,
  resolveWakeRecycleConfig,
  selectColdIdleRecycleStops,
  type ColdIdleRuntimeView,
  type SessionResumeFacts,
  type WakeRecycleConfig,
} from "./wakeSessionRecycle";
import type { AgentConfig } from "@botiverse/raft-shared";

const HOUR_MS = 3_600_000;

function enabledConfig(overrides: Partial<WakeRecycleConfig> = {}): WakeRecycleConfig {
  return { enabled: true, minContextTokens: 128_000, minColdGapMs: HOUR_MS, ...overrides };
}

function facts(overrides: Partial<SessionResumeFacts> = {}): SessionResumeFacts {
  return { transcriptPath: "/tmp/x.jsonl", lastActivityAtMs: 0, lastContextTokens: 500_000, ...overrides };
}

function decisionInput(overrides: Record<string, unknown> = {}) {
  return {
    config: enabledConfig(),
    runtime: "claude",
    sessionId: "session-1",
    hasResumePrompt: false,
    hasRuntimeProfileControl: false,
    facts: facts(),
    nowMs: 2 * HOUR_MS,
    ...overrides,
  } as Parameters<typeof decideWakeRecycle>[0];
}

test("recycling runs only with the server flag; =0 is a local kill switch that cannot turn it on", () => {
  assert.equal(resolveWakeRecycleConfig(undefined, null, {}).enabled, false, "older server: no field means off");
  assert.equal(resolveWakeRecycleConfig(false, null, {}).enabled, false);
  assert.equal(resolveWakeRecycleConfig(false, { RAFT_WAKE_RECYCLE: "1" }, { RAFT_WAKE_RECYCLE: "1" }).enabled, false, "env cannot turn it on");

  const config = resolveWakeRecycleConfig(true, null, {});
  assert.equal(config.enabled, true);
  assert.equal(resolveWakeRecycleConfig(true, null, { RAFT_WAKE_RECYCLE: "0" }).enabled, false);
  assert.equal(resolveWakeRecycleConfig(true, { RAFT_WAKE_RECYCLE: "0" }, {}).enabled, false);
  assert.equal(config.minContextTokens, 128_000);
  assert.equal(config.minColdGapMs, HOUR_MS);
});

test("per-agent env_vars override daemon process env for canary rollout", () => {
  const config = resolveWakeRecycleConfig(
    true,
    { RAFT_WAKE_RECYCLE: "1", RAFT_WAKE_RECYCLE_MIN_CONTEXT_TOKENS: "96000" },
    { RAFT_WAKE_RECYCLE: "0", RAFT_WAKE_RECYCLE_MIN_COLD_GAP_MS: "7200000" },
  );
  assert.equal(config.enabled, true);
  assert.equal(config.minContextTokens, 96_000);
  assert.equal(config.minColdGapMs, 7_200_000);
});

test("cold gap with large context recycles; the plan carries facts and briefing", () => {
  const plan = decideWakeRecycle(decisionInput());
  assert.equal(plan.action, "recycle");
  if (plan.action !== "recycle") return;
  assert.equal(plan.priorSessionId, "session-1");
  assert.equal(plan.idleMs, 2 * HOUR_MS);
  assert.equal(plan.priorContextTokens, 500_000);
  assert.equal(String(plan.briefing), ""); // v3: no announcement line at all
  assert.doesNotMatch(plan.briefing, /consult MEMORY|re-establish/); // v2: no instructions at decision time
});

test("every failed gate resolves to resume with its own reason", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ config: enabledConfig({ enabled: false }) }, "disabled"],
    [{ runtime: "cursor" }, "unsupported_runtime"],
    [{ runtime: "codex", facts: facts({ lastContextTokens: null }) }, "session_facts_unavailable"],
    [{ sessionId: null }, "no_prior_session"],
    [{ hasResumePrompt: true }, "explicit_resume_prompt"],
    [{ hasRuntimeProfileControl: true }, "runtime_profile_control"],
    [{ facts: facts({ lastActivityAtMs: null }) }, "session_facts_unavailable"],
    [{ facts: facts({ lastContextTokens: null }) }, "session_facts_unavailable"],
    [{ nowMs: HOUR_MS - 1 }, "cache_possibly_warm"],
    [{ facts: facts({ lastContextTokens: 128_000 }) }, "context_below_threshold"],
  ];
  for (const [overrides, reason] of cases) {
    const plan = decideWakeRecycle(decisionInput(overrides));
    assert.equal(plan.action, "resume", reason);
    if (plan.action === "resume") assert.equal(plan.reason, reason);
  }
});

test("briefing is empty: no announcement, no recap, no instructions", () => {
  const briefing = buildRecycleBriefing({ idleMs: 5 * 3_600_000, priorContextTokens: 480_000 });
  assert.equal(String(briefing), "");
  // v2 (2026-09-11): no retirement announcement, no idle/size stats, and no
  // recovery-order instructions — 13/13 canary wakes turned the v1 chrome
  // into a resume-protocol ritual instead of answering the waking message.
  assert.doesNotMatch(briefing, /retired|fresh session|idle|consult MEMORY|re-establish/i);
});

test("transcript tail yields last-activity time and last assistant context size", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wake-recycle-"));
  const projectDir = path.join(home, ".claude", "projects", "-workspace-agent");
  mkdirSync(projectDir, { recursive: true });
  const sessionId = "11111111-2222-3333-4444-555555555555";
  const records = [
    { type: "user", timestamp: "2026-08-30T00:00:00.000Z", message: { content: "hi" } },
    {
      type: "assistant",
      timestamp: "2026-08-30T00:00:10.000Z",
      message: { usage: { input_tokens: 12, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 2_000 } },
    },
    { type: "user", timestamp: "2026-08-30T01:00:00.000Z", message: { content: "tool result" } },
  ];
  writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n") + "\n");

  const result = await readClaudeSessionResumeFacts(sessionId, home);
  assert.equal(result.lastActivityAtMs, Date.parse("2026-08-30T01:00:00.000Z"));
  assert.equal(result.lastContextTokens, 402_012);
});

test("a session with no transcript on disk yields unknown facts (and therefore resume)", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wake-recycle-"));
  const result = await readClaudeSessionResumeFacts("99999999-0000-0000-0000-000000000000", home);
  assert.equal(result.transcriptPath, null);
  assert.equal(result.lastActivityAtMs, null);
  assert.equal(result.lastContextTokens, null);
});

test("cold-idle sweep selects only enabled, idle, cold runtimes with readable facts", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wake-recycle-"));
  const projectDir = path.join(home, ".claude", "projects", "-workspace-agent");
  mkdirSync(projectDir, { recursive: true });
  const nowMs = Date.now();
  const coldSession = "cccccccc-1111-2222-3333-444444444444";
  writeFileSync(path.join(projectDir, `${coldSession}.jsonl`), JSON.stringify({
    type: "assistant",
    timestamp: new Date(nowMs - 3 * HOUR_MS).toISOString(),
    message: { usage: { input_tokens: 5, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 0 } },
  }) + "\n");
  const enabledEnv = { RAFT_WAKE_RECYCLE: "1" };
  const view = (overrides: Partial<ColdIdleRuntimeView>): ColdIdleRuntimeView => ({
    agentId: "agent-cold",
    config: { runtime: "claude", sessionId: null, constructedWakeContext: true, envVars: enabledEnv } as unknown as ColdIdleRuntimeView["config"],
    idle: true,
    lastEventAtMs: nowMs - 3 * HOUR_MS,
    liveSessionId: coldSession,
    ...overrides,
  });

  const stops = await selectColdIdleRecycleStops([
    view({}),
    view({ agentId: "agent-busy", idle: false }),
    view({ agentId: "agent-warm-memory", lastEventAtMs: nowMs - 60_000 }),
    view({ agentId: "agent-disabled", config: { runtime: "claude", sessionId: null, constructedWakeContext: true, envVars: { RAFT_WAKE_RECYCLE: "0" } } as unknown as ColdIdleRuntimeView["config"] }),
    view({ agentId: "agent-codex", config: { runtime: "codex", sessionId: null, constructedWakeContext: true, envVars: enabledEnv } as unknown as ColdIdleRuntimeView["config"] }),
    view({ agentId: "agent-no-session", liveSessionId: null }),
  ], { nowMs, homeDir: home, processEnv: {} });

  assert.deepEqual(stops.map((s) => s.agentId), ["agent-cold"]);
  assert.equal(stops[0]!.sessionId, coldSession);
  assert.equal(stops[0]!.priorContextTokens, 400_005);
});

test("cold-idle sweep skips outstanding background tasks but allows terminated ones", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wake-recycle-"));
  const projectDir = path.join(home, ".claude", "projects", "-workspace-agent");
  mkdirSync(projectDir, { recursive: true });
  const nowMs = Date.now();
  const cold = {
    type: "assistant",
    timestamp: new Date(nowMs - 3 * HOUR_MS).toISOString(),
    message: { usage: { input_tokens: 5, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 0 } },
  };
  const created = { type: "user", timestamp: new Date(nowMs - 3 * HOUR_MS).toISOString(), message: { content: [{ type: "tool_result", tool_use_id: "t", content: "Monitor started (task babc123x, timeout 60000ms). You will be notified" }] } };
  const resolved = { type: "user", timestamp: new Date(nowMs - 3 * HOUR_MS).toISOString(), message: { content: "<task-notification><task-id>babc123x</task-id><status>completed</status></task-notification>" } };

  const armedSession = "ffffffff-1111-2222-3333-444444444444";
  writeFileSync(path.join(projectDir, `${armedSession}.jsonl`), [cold, created].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const clearedSession = "ffffffff-5555-6666-7777-888888888888";
  writeFileSync(path.join(projectDir, `${clearedSession}.jsonl`), [cold, created, resolved].map((r) => JSON.stringify(r)).join("\n") + "\n");

  const view = (agentId: string, sessionId: string): ColdIdleRuntimeView => ({
    agentId,
    config: { runtime: "claude", sessionId: null, constructedWakeContext: true, envVars: { RAFT_WAKE_RECYCLE: "1" } } as unknown as ColdIdleRuntimeView["config"],
    idle: true,
    lastEventAtMs: nowMs - 3 * HOUR_MS,
    liveSessionId: sessionId,
  });
  const stops = await selectColdIdleRecycleStops(
    [view("agent-armed", armedSession), view("agent-cleared", clearedSession)],
    { nowMs, homeDir: home, processEnv: {} },
  );
  assert.deepEqual(stops.map((s) => s.agentId), ["agent-cleared"]);
});

test("cold-idle sweep spares a runtime whose session sidecar (subagent) is still active", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wake-recycle-"));
  const projectDir = path.join(home, ".claude", "projects", "-workspace-agent");
  mkdirSync(projectDir, { recursive: true });
  const nowMs = Date.now();
  const sessionId = "eeeeeeee-1111-2222-3333-444444444444";
  writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), JSON.stringify({
    type: "assistant",
    timestamp: new Date(nowMs - 3 * HOUR_MS).toISOString(),
    message: { usage: { input_tokens: 5, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 0 } },
  }) + "\n");
  const sidecar = path.join(projectDir, sessionId, "subagents");
  mkdirSync(sidecar, { recursive: true });
  writeFileSync(path.join(sidecar, "agent-live.jsonl"), "{}\n"); // fresh mtime = live background work
  const stops = await selectColdIdleRecycleStops([{
    agentId: "agent-with-subagent",
    config: { runtime: "claude", sessionId: null, constructedWakeContext: true, envVars: { RAFT_WAKE_RECYCLE: "1" } } as unknown as ColdIdleRuntimeView["config"],
    idle: true,
    lastEventAtMs: nowMs - 3 * HOUR_MS,
    liveSessionId: sessionId,
  }], { nowMs, homeDir: home, processEnv: {} });
  assert.deepEqual(stops, []);
});

test("cold-idle sweep trusts the freshest clock: recent transcript activity vetoes a stale memory clock", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wake-recycle-"));
  const projectDir = path.join(home, ".claude", "projects", "-workspace-agent");
  mkdirSync(projectDir, { recursive: true });
  const nowMs = Date.now();
  const sessionId = "dddddddd-1111-2222-3333-444444444444";
  writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), JSON.stringify({
    type: "assistant",
    timestamp: new Date(nowMs - 30_000).toISOString(),
    message: { usage: { input_tokens: 5, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 0 } },
  }) + "\n");
  const stops = await selectColdIdleRecycleStops([{
    agentId: "agent-x",
    config: { runtime: "claude", sessionId: null, constructedWakeContext: true, envVars: { RAFT_WAKE_RECYCLE: "1" } } as unknown as ColdIdleRuntimeView["config"],
    idle: true,
    lastEventAtMs: nowMs - 3 * HOUR_MS,
    liveSessionId: sessionId,
  }], { nowMs, homeDir: home, processEnv: {} });
  assert.deepEqual(stops, []);
});

test("planWakeSessionRecycle recycles end to end from a real transcript tail", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wake-recycle-"));
  const projectDir = path.join(home, ".claude", "projects", "-workspace-agent");
  mkdirSync(projectDir, { recursive: true });
  const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const lastTurnAt = Date.now() - 3 * HOUR_MS;
  writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), JSON.stringify({
    type: "assistant",
    timestamp: new Date(lastTurnAt).toISOString(),
    message: { usage: { input_tokens: 5, cache_read_input_tokens: 600_000, cache_creation_input_tokens: 1_500 } },
  }) + "\n");

  const config = {
    runtime: "claude",
    sessionId,
    constructedWakeContext: true,
    envVars: { RAFT_WAKE_RECYCLE: "1" },
  } as unknown as AgentConfig;
  const plan = await planWakeSessionRecycle({ config, hasResumePrompt: false, homeDir: home, processEnv: {} });
  assert.equal(plan.action, "recycle");
  if (plan.action === "recycle") {
    assert.equal(plan.priorSessionId, sessionId);
    assert.equal(plan.priorContextTokens, 601_505);
  }

  const disabledPlan = await planWakeSessionRecycle({
    config: { ...config, envVars: { RAFT_WAKE_RECYCLE: "0" } } as AgentConfig,
    hasResumePrompt: false,
    homeDir: home,
    processEnv: {},
  });
  assert.equal(disabledPlan.action, "resume");
});
