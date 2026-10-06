// RFC 070 phase 1 behavior baseline: at-wake session recycling.
//
// Named protected object (invariant): a cold wake (>1h since last transcript
// activity) whose prior Claude session context exceeds the recycle threshold
// starts WITHOUT `--resume` (spawn config sessionId is null) and its first
// runtime input opens with the reconstructed wake briefing, while warm or
// disabled wakes resume the prior session unchanged.
//
// RED proof: revert the wakeRecycle hook in startAgentNow (or force
// `planWakeSessionRecycle` to always resume) and the first test fails with
// spawn config sessionId "session-recycle-1" !== null; restoring the hook
// returns it to green. Helpers are slimmed copies per this repo's APM test
// convention (see agentProcessManager.claude.test.ts header).

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import type { ChildProcess } from "node:child_process";
import { asAxSurfaceText, type AgentConfig, type AxSurfaceText, type MachineToServerMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import { installManagedRunnerCredentialFetch } from "./testing/managedRunnerCredentialFetch";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent } from "./drivers/index";
import { drainAgentManagerForTests, releaseAgentManagerForTests } from "./testing/agentManagerTeardown";
import { takeRecordedNetworkAttempts } from "./testing/networkGuard";

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  readonly stdinWrites: string[] = [];
  stdin = {
    write: (chunk: string) => {
      this.stdinWrites.push(chunk);
      return true;
    },
  };

  killed = false;

  kill(): boolean {
    this.killed = true;
    // SIGTERM, as the daemon sends: node reports code 143 with the signal.
    this.emit("exit", 143, "SIGTERM");
    this.emit("close", 143, "SIGTERM");
    return true;
  }
}

class FakeClaudeDriver implements RuntimeDriver {
  readonly acceptsStdinDuringCompaction = true;
  readonly id = "claude";
  readonly lifecycle = { kind: "persistent", stdin: "direct", inFlightWake: "steer" } as const;
  readonly communication = { chat: "slock_cli", runtimeControl: "none" } as const;
  readonly session = { recovery: "resume_or_fresh" } as const;
  readonly model = { detectedModelsVerifiedAs: "launchable" } as const;
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly liveSessionReadyAt = "turn_end" as const;
  readonly supportsNativeStandingPrompt = true;
  readonly spawnCalls: SpawnContext[] = [];
  readonly processes: FakeChildProcess[] = [];

  spawn(ctx: SpawnContext): SpawnResult {
    this.spawnCalls.push(ctx);
    const child = new FakeChildProcess();
    this.processes.push(child);
    return { process: child as unknown as ChildProcess };
  }

  parseLine(): ParsedEvent[] {
    return [];
  }

  encodeStdinMessage(text?: string): string | null {
    return text ? JSON.stringify({ text }) : null;
  }

  buildSystemPrompt(): AxSurfaceText {
    return asAxSurfaceText("claude standing prompt");
  }
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "claude-agent",
    displayName: "Claude Agent",
    description: "test agent",
    model: "sonnet",
    runtime: "claude",
    reasoningEffort: null,
    constructedWakeContext: true,
    envVars: null,
    sessionId: null,
    serverUrl: "http://localhost:3001",
    authToken: "sk_machine_test",
    agentCredentialKey: "sk_agent_test",
    // No credential id by default: a stop would revoke it over the injected
    // fetch, and tests that do not fake the server must not send anything.
    agentCredentialId: null,
    ...overrides,
  };
}

async function writeSessionTranscript(
  homeDir: string,
  sessionId: string,
  args: { lastActivityAtMs: number; contextTokens: number },
): Promise<void> {
  const projectDir = path.join(homeDir, ".claude", "projects", "-workspace-agent");
  await mkdir(projectDir, { recursive: true });
  const record = {
    type: "assistant",
    timestamp: new Date(args.lastActivityAtMs).toISOString(),
    message: {
      usage: {
        input_tokens: 12,
        cache_read_input_tokens: args.contextTokens - 12,
        cache_creation_input_tokens: 0,
      },
    },
  };
  await writeFile(path.join(projectDir, `${sessionId}.jsonl`), JSON.stringify(record) + "\n");
}

async function withManager(
  fn: (ctx: { driver: FakeClaudeDriver; manager: AgentProcessManager; dataDir: string; sent: MachineToServerMessage[] }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-wake-recycle-test-"));
  const sent: MachineToServerMessage[] = [];
  const driver = new FakeClaudeDriver();
  const manager = new AgentProcessManager(
    (msg) => sent.push(msg),
    "sk_machine_test",
    {
      dataDir,
      serverUrl: "https://daemon.example.com",
      driverResolver: () => driver,
      runtimeSessionHomeDir: dataDir,
    },
  );
  try {
    await fn({ driver, manager, dataDir, sent });
  } finally {
    await releaseAgentManagerForTests(manager);
    await rm(dataDir, { recursive: true, force: true });
  }
}

const HOUR_MS = 3_600_000;

test("cold wake with large prior context spawns fresh with the wake briefing", async () => {
  await withManager(async ({ driver, manager, dataDir }) => {
    const sessionId = "session-recycle-1";
    await writeSessionTranscript(dataDir, sessionId, {
      lastActivityAtMs: Date.now() - 3 * HOUR_MS,
      contextTokens: 500_000,
    });
    await manager.startAgent(
      "agent-recycle",
      makeConfig({ sessionId, envVars: { RAFT_WAKE_RECYCLE: "1" } }),
      undefined,
      { "#general": 3 },
    );

    assert.equal(driver.spawnCalls.length, 1);
    const spawn = driver.spawnCalls[0]!;
    assert.equal(spawn.config.sessionId, null, "recycled start must not resume the prior session");
    assert.match(spawn.prompt, /^<memory-index|^<recent-messages|^<objects-in-play|^<recent-actions/); // first input opens directly with a context block
    assert.doesNotMatch(spawn.prompt, /retired|fresh session|~\d+k tokens/); // v2: no announcement, no stats
    // The resume-shaped ladder still delivers the unread summary after the briefing.
    assert.match(spawn.prompt, /#general: 3 unread/);
  });
});


test("fresh start injects the MEMORY.md block when the server flag is on", async () => {
  await withManager(async ({ driver, manager, dataDir }) => {
    const agentDir = path.join(dataDir, "agent-fresh-mem");
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "MEMORY.md"), "# Memory marker seven\n- durable fact\n");
    await manager.startAgent("agent-fresh-mem", makeConfig({ sessionId: null }));

    assert.equal(driver.spawnCalls.length, 1);
    const spawn = driver.spawnCalls[0]!;
    assert.match(spawn.prompt, /<memory-index file="MEMORY\.md"/);
    assert.match(spawn.prompt, /Memory marker seven/);
  });
});

test("warm wake resumes the prior session without a briefing", async () => {
  await withManager(async ({ driver, manager, dataDir }) => {
    const sessionId = "session-warm-1";
    await writeSessionTranscript(dataDir, sessionId, {
      lastActivityAtMs: Date.now() - 10 * 60_000,
      contextTokens: 500_000,
    });
    await manager.startAgent(
      "agent-warm",
      makeConfig({ sessionId, envVars: { RAFT_WAKE_RECYCLE: "1" } }),
    );

    assert.equal(driver.spawnCalls.length, 1);
    const spawn = driver.spawnCalls[0]!;
    assert.equal(spawn.config.sessionId, sessionId);
    assert.doesNotMatch(spawn.prompt, /wake briefing/);
  });
});

test("recycle stays inert when the kill switch is set", async () => {
  await withManager(async ({ driver, manager, dataDir }) => {
    const sessionId = "session-flag-off";
    await writeSessionTranscript(dataDir, sessionId, {
      lastActivityAtMs: Date.now() - 3 * HOUR_MS,
      contextTokens: 500_000,
    });
    await manager.startAgent("agent-flag-off", makeConfig({ sessionId, envVars: { RAFT_WAKE_RECYCLE: "0" } }));

    assert.equal(driver.spawnCalls.length, 1);
    const spawn = driver.spawnCalls[0]!;
    assert.equal(spawn.config.sessionId, sessionId);
    assert.doesNotMatch(spawn.prompt, /wake briefing/);
  });
});

test("without the server flag (older server or flag off) a cold wake resumes and a fresh start gets no MEMORY.md block, even with env set to 1", async () => {
  await withManager(async ({ driver, manager, dataDir }) => {
    const sessionId = "session-no-flag";
    await writeSessionTranscript(dataDir, sessionId, {
      lastActivityAtMs: Date.now() - 3 * HOUR_MS,
      contextTokens: 500_000,
    });
    await manager.startAgent(
      "agent-no-flag",
      makeConfig({ sessionId, constructedWakeContext: undefined, envVars: { RAFT_WAKE_RECYCLE: "1", RAFT_STARTUP_MEMORY_BLOCK: "1" } }),
    );
    const agentDir = path.join(dataDir, "agent-no-flag-fresh");
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "MEMORY.md"), "# Memory marker nine\n- durable fact\n");
    await manager.startAgent(
      "agent-no-flag-fresh",
      makeConfig({ sessionId: null, constructedWakeContext: false, envVars: { RAFT_STARTUP_MEMORY_BLOCK: "1" } }),
    );

    assert.equal(driver.spawnCalls.length, 2);
    assert.equal(driver.spawnCalls[0]!.config.sessionId, sessionId, "no flag: the cold wake resumes the prior session");
    assert.doesNotMatch(driver.spawnCalls[0]!.prompt, /<memory-index|<recent-messages|<objects-in-play/);
    assert.doesNotMatch(driver.spawnCalls[1]!.prompt, /<memory-index|Memory marker nine/, "no flag: no startup memory block");
  });
});

// Cold-idle sweep under inbox-notice delivery (2026-09-18 fix). Messages the
// agent was notified about and left unread used to count as pending work, so
// the sweep never fired for agents idling with unread notices (Maria: 4 stops
// in 8 days while dozens of 300-900k sessions sat cold). RED proof: restore the
// `ap.inbox.length === 0` gate and the first test never stops the process;
// drop the notified-deferral guard in the exit path and the same test restarts
// the agent immediately on its oldest unread message (spawnCalls === 2).

function coldIdleFixture(seq: number) {
  return {
    seq,
    message_id: `msg-${seq}`,
    channel_name: "general",
    channel_type: "channel",
    sender_name: "someone",
    sender_type: "human",
    content: `unread ${seq}`,
    timestamp: new Date().toISOString(),
  } as any;
}

async function startIdleColdAgent(
  ctx: { driver: FakeClaudeDriver; manager: AgentProcessManager; dataDir: string },
  agentId: string,
  sessionId: string,
) {
  // Start warm (resume), then age the transcript and progress clock so the
  // live process looks cold and idle to the sweep.
  await writeSessionTranscript(ctx.dataDir, sessionId, { lastActivityAtMs: Date.now() - 60_000, contextTokens: 500_000 });
  await ctx.manager.startAgent(agentId, makeConfig({ sessionId, envVars: { RAFT_WAKE_RECYCLE: "1" } }));
  await writeSessionTranscript(ctx.dataDir, sessionId, { lastActivityAtMs: Date.now() - 3 * HOUR_MS, contextTokens: 500_000 });
  const ap = (ctx.manager as any).agents.get(agentId);
  ap.sessionId = sessionId;
  ap.gatedSteering = { ...ap.gatedSteering, isIdle: true };
  ap.runtimeProgress.noteInternalProgress(Date.now() - 3 * HOUR_MS);
  return ap;
}

test("cold-idle sweep stops an idle process whose only queued messages were already notified, without restarting it", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdleColdAgent(ctx, "agent-sweep-notified", "session-sweep-notified");
    assert.equal(ctx.driver.spawnCalls.length, 1);
    const unread = [coldIdleFixture(101), coldIdleFixture(102)];
    ap.inbox.push(...unread);
    ap.notifications.recordNoticeWritten("fp-unread", ap.sessionId, unread);
    const restarts: unknown[] = [];
    const realStartAgent = (ctx.manager as any).startAgent.bind(ctx.manager);
    (ctx.manager as any).startAgent = (...args: unknown[]) => {
      restarts.push(args[2]);
      return realStartAgent(...args);
    };

    await (ctx.manager as any).sweepColdIdleRuntimes();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(ctx.driver.processes[0]!.killed, true, "the cold idle process was stopped");
    assert.equal(ap.gatedSteering.expectedTerminationReason, "cold_idle_recycle", "sweep stop is an expected termination");
    assert.deepEqual(restarts, [], "notified-but-unread messages must not wake an immediate restart");
    // The stop leaves an idle, restartable record (not terminal), so a later
    // server wake or app-inbox reminder can bring the agent back. The
    // notified messages stay unread on the server and ride the next start's
    // resume catch-up (see the cold-wake test above for the unread summary).
    const lifecycle = (ctx.manager as any).lifecycleRecords;
    assert.ok(lifecycle.getRestartSnapshot("agent-sweep-notified"), "a restart snapshot is kept");
    assert.equal(lifecycle.getTerminalFailure("agent-sweep-notified"), undefined, "the sweep stop is not terminal");
  });
});

test("cold-idle sweep leaves a process alone while a queued message has not been notified yet", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdleColdAgent(ctx, "agent-sweep-untold", "session-sweep-untold");
    const told = coldIdleFixture(201);
    const untold = coldIdleFixture(202);
    ap.inbox.push(told, untold);
    ap.notifications.recordNoticeWritten("fp-told", ap.sessionId, [told]);

    await (ctx.manager as any).sweepColdIdleRuntimes();

    assert.equal(ctx.driver.processes[0]!.killed, false, "an untold message is pending work");
    assert.equal(ap.gatedSteering.expectedTerminationReason, null);
  });
});

test("a message that arrives untold during a cold-idle stop still wakes the agent", async () => {
  // A restart strips the runner credential and mints a new one; answer the
  // mint here so the restart under test does not reach the network.
  onTestFinished(installManagedRunnerCredentialFetch());
  await withManager(async (ctx) => {
    const ap = await startIdleColdAgent(ctx, "agent-sweep-race", "session-sweep-race");
    const told = coldIdleFixture(301);
    const untold = coldIdleFixture(302);
    ap.inbox.push(told, untold);
    ap.notifications.recordNoticeWritten("fp-race", ap.sessionId, [told]);
    const wakes: unknown[] = [];
    const realStartAgent = (ctx.manager as any).startAgent.bind(ctx.manager);
    (ctx.manager as any).startAgent = (...args: unknown[]) => {
      wakes.push(args[2]);
      return realStartAgent(...args);
    };

    // The stop was decided while only `told` was queued; `untold` raced in.
    (ctx.manager as any).commitGatedSteeringDecisionState("agent-sweep-race", ap, {
      ...ap.gatedSteering,
      expectedTerminationReason: "cold_idle_recycle",
    });
    await ap.runtime.stop({ signal: "SIGTERM", reason: "cold_idle_recycle" });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(wakes.length, 1, "the untold message restarts the agent");
    assert.equal((wakes[0] as { seq: number }).seq, 302, "and it, not the deferred unread, is the wake message");
    // The restart is queued and mints its runner credential later. Let it
    // finish while this test's mint answer is installed; otherwise the mint
    // reaches the network during the next test.
    const deadline = Date.now() + 5_000;
    while (ctx.driver.processes.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(ctx.driver.processes.length, 2, "the restart spawned before the test ends");
  });
});

test("test teardown fences a restart still queued when the test ends: nothing reaches the network afterwards", async () => {
  const restoreMint = installManagedRunnerCredentialFetch();
  await withManager(async (ctx) => {
    const ap = await startIdleColdAgent(ctx, "agent-teardown-fence", "session-teardown-fence");
    const untold = coldIdleFixture(402);
    ap.inbox.push(untold);
    (ctx.manager as any).commitGatedSteeringDecisionState("agent-teardown-fence", ap, {
      ...ap.gatedSteering,
      expectedTerminationReason: "cold_idle_recycle",
    });
    await ap.runtime.stop({ signal: "SIGTERM", reason: "cold_idle_recycle" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ctx.driver.processes.length, 1, "precondition: the restart is still pending");

    // What withManager's teardown does, followed by the mint answer going away.
    await drainAgentManagerForTests(ctx.manager);
    restoreMint();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(takeRecordedNetworkAttempts(), [], "no mint after teardown");
    assert.equal(ctx.driver.processes.length, 1, "no spawn after teardown");
  });
});

test("a sweep stop is a clean exit even when a recovered runtime error is still latched", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdleColdAgent(ctx, "agent-sweep-stale-error", "session-sweep-stale-error");
    // The agent hit a rate limit hours ago and has been working fine since;
    // `lastRuntimeError` is only cleared by an ordinary message delivery.
    ap.lastRuntimeError = "You've hit your weekly limit · resets Sep 23 at 9am (Asia/Shanghai)";

    await (ctx.manager as any).sweepColdIdleRuntimes();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(ctx.driver.processes[0]!.killed, true);
    const activities = ctx.sent.filter((m) => m.type === "agent:activity") as Array<{ activity: string; detail?: string }>;
    assert.equal(
      activities.some((a) => a.detail === "Process idle"),
      true,
      "the sweep stop must close as a normal idle exit",
    );
    assert.equal(
      activities.some((a) => a.activity === "error" || /crash/i.test(a.detail ?? "")),
      false,
      "a stale runtime error must not make the sweep stop look like a crash",
    );
  });
});
