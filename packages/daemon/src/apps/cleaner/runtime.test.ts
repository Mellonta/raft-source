import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readdirSync, readFileSync } from "node:fs";
import {
  AGENT_INBOX_PREVIEW_MAX_CHARS,
  BasicTracer,
} from "@botiverse/raft-shared";
import { LocalRotatingTraceSink } from "@botiverse/raft-trace-client";
import {
  CLEANER_APP_ID,
  CLEANER_CONFIG_BOUNDS,
  CLEANER_CONFIG_DEFAULTS,
} from "@botiverse/raft-shared/src/apps/cleaner/configProtocol";
import {
  CLEANER_MEMORY_HINT_REWAKE_COOLDOWN_MS,
  CLEANER_MEMORY_HINT_REWAKE_GROWTH_RATIO,
  CLEANER_WORKSPACE_CLEANUP_TIP,
  CLEANER_WORKSPACE_CLEANUP_TIP_MIN_INTERVAL_MS,
  SystemCleanerRuntime,
  memoryHintTitle,
  type CleanerClock,
  type CleanerConfigEnvelope,
  type CleanerMeasurement,
  type CleanerDiskMeasurement,
} from "./runtime";

interface FakeTimer {
  id: number;
  atMs: number;
  fn: () => void;
  active: boolean;
}

class FakeClock implements CleanerClock {
  private nextId = 1;
  private readonly timers = new Map<number, FakeTimer>();
  nowMs = 1_000;

  now(): number {
    return this.nowMs;
  }

  schedule(fn: () => void, ms: number): unknown {
    const timer: FakeTimer = { id: this.nextId++, atMs: this.nowMs + ms, fn, active: true };
    this.timers.set(timer.id, timer);
    return timer.id;
  }

  cancel(timer: unknown): void {
    const found = this.timers.get(timer as number);
    if (found) found.active = false;
  }

  activeIds(): number[] {
    return [...this.timers.values()].filter((timer) => timer.active).map((timer) => timer.id);
  }

  activeCount(): number {
    return this.activeIds().length;
  }

  earliestActiveId(): number {
    const timer = [...this.timers.values()]
      .filter((candidate) => candidate.active)
      .sort((left, right) => left.atMs - right.atMs || left.id - right.id)[0];
    assert.ok(timer, "expected an active timer");
    return timer.id;
  }

  fire(id: number, options?: { evenIfCleared?: boolean }): void {
    const timer = this.timers.get(id);
    assert.ok(timer, `unknown timer ${id}`);
    assert.ok(timer.active || options?.evenIfCleared, `timer ${id} is cleared`);
    timer.active = false;
    this.nowMs = Math.max(this.nowMs, timer.atMs);
    timer.fn();
  }
}

const MIN_THRESHOLD_BYTES = CLEANER_CONFIG_BOUNDS.thresholdBytes.min;
const MAX_THRESHOLD_BYTES = CLEANER_CONFIG_BOUNDS.thresholdBytes.max;
const MIN_INTERVAL_MS = CLEANER_CONFIG_BOUNDS.intervalMs.min;
const MAX_INTERVAL_MS = CLEANER_CONFIG_BOUNDS.intervalMs.max;

function config(overrides?: Partial<CleanerConfigEnvelope>): CleanerConfigEnvelope {
  return {
    appId: CLEANER_APP_ID,
    ownerAgentId: "owner-a",
    enabled: true,
    thresholdBytes: CLEANER_CONFIG_DEFAULTS.thresholdBytes,
    intervalMs: CLEANER_CONFIG_DEFAULTS.intervalMs,
    revision: 1,
    ...overrides,
  };
}

function runtimeFixture(input?: {
  measurement?: CleanerMeasurement | ((ownerAgentId: string) => CleanerMeasurement | Promise<CleanerMeasurement>);
  diskMeasurement?: () => Promise<CleanerDiskMeasurement>;
  onWake?: () => void;
  measurementTimeoutMs?: number;
  trace?: (name: string, attrs: Readonly<Record<string, unknown>>) => void;
}) {
  const clock = new FakeClock();
  const measurements: Array<{ ownerAgentId: string; literalFileName: string; absolutePath: string }> = [];
  const wakes: Array<{ ownerAgentId: string; itemId: string }> = [];
  const traces: Array<{ name: string; attrs: Readonly<Record<string, unknown>> }> = [];
  const runtime = new SystemCleanerRuntime({
    agentsDataDir: "/computer/agents",
    clock,
    measurementTimeoutMs: input?.measurementTimeoutMs,
    measureMemoryFile: async (measurementInput) => {
      measurements.push(measurementInput);
      const result = input?.measurement ?? {
        kind: "measured",
        bytes: CLEANER_CONFIG_DEFAULTS.thresholdBytes * 2,
      };
      return typeof result === "function" ? result(measurementInput.ownerAgentId) : result;
    },
    measureDiskSpace: input?.diskMeasurement ?? (async () => ({ kind: "measured", availableBytes: 50, totalBytes: 100 })),
    wake: async (ownerAgentId, item) => {
      wakes.push({ ownerAgentId, itemId: item.itemId });
      input?.onWake?.();
    },
    trace: (name, attrs) => {
      traces.push({ name, attrs });
      input?.trace?.(name, attrs);
    },
  });
  return { runtime, clock, measurements, wakes, traces };
}

async function firePeriodic(fixture: ReturnType<typeof runtimeFixture>, timerId?: number): Promise<void> {
  fixture.clock.fire(timerId ?? fixture.clock.earliestActiveId());
  await fixture.runtime.waitForIdle();
}

test("closed Cleaner action is executable only after applied config; payload action injection fails closed", () => {
  const { runtime } = runtimeFixture();
  const beforeConfig = runtime.inbox.mint({
    appId: CLEANER_APP_ID,
    notificationClass: "memory_size_hint",
    sourceRef: { kind: "memory_hint", agentId: "owner-a" },
  });
  assert.equal(beforeConfig.ok, false, "empty/unresolved action must not mint");
  if (!beforeConfig.ok) assert.equal(beforeConfig.code, "invalid_primary_action");

  assert.deepEqual(runtime.applyConfig(config()), { kind: "applied", activeSchedules: 1 });
  const injected = runtime.inbox.mint({
    appId: CLEANER_APP_ID,
    notificationClass: "memory_size_hint",
    sourceRef: { kind: "memory_hint", agentId: "owner-a" },
    requestedPrimaryAction: {
      kind: "run_command",
      commandId: "cleaner.configure",
      shell: "rm -rf /",
    } as never,
  });
  assert.equal(injected.ok, false);
  if (!injected.ok) assert.equal(injected.code, "raw_command_forbidden");

  const minted = runtime.inbox.mint({
    appId: CLEANER_APP_ID,
    notificationClass: "memory_size_hint",
    sourceRef: { kind: "memory_hint", agentId: "owner-a" },
  });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  assert.deepEqual(minted.item.primaryAction, { kind: "run_command", commandId: "cleaner.configure" });
  assert.equal(
    minted.item.actionCli,
    `raft app config --app system.cleaner --set threshold_bytes=${CLEANER_CONFIG_DEFAULTS.thresholdBytes * 2}`,
  );
});

test("periodic check measures only the literal owner's MEMORY.md and mints+wakes one transient item", async () => {
  const fixture = runtimeFixture({
    measurement: (ownerAgentId) => ({
      kind: "measured",
      bytes: ownerAgentId === "owner-a" ? CLEANER_CONFIG_DEFAULTS.thresholdBytes + 1 : 1,
    }),
  });
  fixture.runtime.applyConfig(config());
  fixture.runtime.applyConfig(config({ ownerAgentId: "owner-b" }));
  const ownerATimer = fixture.clock.activeIds()[0]!;

  await firePeriodic(fixture, ownerATimer);

  assert.deepEqual(fixture.measurements, [{
    ownerAgentId: "owner-a",
    literalFileName: "MEMORY.md",
    absolutePath: path.join("/computer/agents", "owner-a", "MEMORY.md"),
  }]);
  const items = fixture.runtime.inbox.list();
  assert.equal(items.length, 1);
  assert.equal(items[0]!.retention, "transient");
  assert.deepEqual(items[0]!.sourceRef, { kind: "memory_hint", id: "owner-a" });
  assert.equal(
    items[0]!.actionCli,
    `raft app config --app system.cleaner --set threshold_bytes=${CLEANER_CONFIG_DEFAULTS.thresholdBytes * 2}`,
  );
  assert.match(items[0]!.title ?? "", /64\.0 KiB.*64\.0 KiB/);
  assert.ok((items[0]!.title?.length ?? 0) <= AGENT_INBOX_PREVIEW_MAX_CHARS);
  assert.ok((items[0]!.summary?.length ?? 0) <= AGENT_INBOX_PREVIEW_MAX_CHARS);
  assert.deepEqual(fixture.wakes.map((wake) => wake.ownerAgentId), ["owner-a"]);
  assert.equal(fixture.runtime.activeScheduleCount("owner-a"), 1);
  assert.equal(fixture.runtime.activeScheduleCount("owner-b"), 1);
});

test("memory hint suggests clearing unused workspace files at most once a week per agent", async () => {
  const fixture = runtimeFixture();
  fixture.runtime.applyConfig(config());
  const memoryTitle = () => fixture.runtime.inbox.list()
    .find((item) => item.sourceRef.kind === "memory_hint")?.title ?? "";
  const presents = () => fixture.traces
    .filter((trace) => trace.name === "daemon.cleaner.present" && trace.attrs.workspace_cleanup_tip !== undefined)
    .map((trace) => trace.attrs.workspace_cleanup_tip);
  const skipped = () => fixture.traces
    .filter((trace) => trace.name === "daemon.cleaner.present" && trace.attrs.workspace_cleanup_tip !== undefined)
    .map((trace) => trace.attrs.workspace_cleanup_tip_skipped);
  const drops = () => fixture.traces.filter((trace) => trace.name === "daemon.cleaner.drop");

  await firePeriodic(fixture);
  const firstTipAtMs = fixture.clock.now();
  assert.ok(memoryTitle().includes(CLEANER_WORKSPACE_CLEANUP_TIP), "first hint carries the tip");
  assert.deepEqual(presents(), [true]);
  assert.deepEqual(skipped(), [undefined]);

  // The hint itself re-presents at most daily (see the rewake cooldown test).
  fixture.clock.nowMs = firstTipAtMs + CLEANER_MEMORY_HINT_REWAKE_COOLDOWN_MS;
  await firePeriodic(fixture);
  assert.ok(fixture.clock.now() - firstTipAtMs < CLEANER_WORKSPACE_CLEANUP_TIP_MIN_INTERVAL_MS);
  assert.ok(!memoryTitle().includes(CLEANER_WORKSPACE_CLEANUP_TIP), "a repeat within the week omits it");
  assert.deepEqual(presents(), [true, false]);
  assert.deepEqual(skipped(), [undefined, "weekly_cap"]);
  assert.equal(drops().length, 0, "holding back the tip is not a drop; the hint still presented");
  assert.equal(fixture.wakes.length, 2, "the weekly cap holds back only the tip, not the daily hint");

  fixture.clock.nowMs = firstTipAtMs + CLEANER_WORKSPACE_CLEANUP_TIP_MIN_INTERVAL_MS;
  await firePeriodic(fixture);
  assert.ok(memoryTitle().includes(CLEANER_WORKSPACE_CLEANUP_TIP), "a week later it returns");
  assert.deepEqual(presents(), [true, false, true]);
  assert.deepEqual(skipped(), [undefined, "weekly_cap", undefined]);
});

test("memory hint titles with the cleanup tip stay under the inbox cap", () => {
  for (const intervalMs of [MIN_INTERVAL_MS, MAX_INTERVAL_MS, MIN_INTERVAL_MS + 1_001]) {
    for (const thresholdBytes of [MIN_THRESHOLD_BYTES, MAX_THRESHOLD_BYTES]) {
      const title = memoryHintTitle(MAX_THRESHOLD_BYTES * 1024 - 1, thresholdBytes, intervalMs, true);
      assert.ok(title.length <= AGENT_INBOX_PREVIEW_MAX_CHARS, `${title.length}: ${title}`);
    }
  }
});

test("cleaner events keep their owner agent through the local trace sink's id allowlist", async () => {
  // The sink drops id-shaped keys it does not allowlist; it allows owner_agent_id
  // and item_id, not ownerAgentId/itemId. Without this, prod could count cleaner
  // hints and drops but not say whose they were.
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "cleaner-trace-owner-"));
  try {
    const tracer = new BasicTracer({
      sink: new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 }),
    });
    const outcomes: CleanerMeasurement[] = [
      { kind: "measured", bytes: CLEANER_CONFIG_DEFAULTS.thresholdBytes + 1 },
      { kind: "measured", bytes: 1 },
    ];
    const fixture = runtimeFixture({
      measurement: () => outcomes.shift()!,
      trace: (name, attrs) => tracer.emitEvent(name, { surface: "daemon", attrs: attrs as never }),
    });
    fixture.runtime.applyConfig(config());
    await firePeriodic(fixture);
    await firePeriodic(fixture);

    const dir = path.join(machineDir, "traces");
    const written = readdirSync(dir).flatMap((name) => readFileSync(path.join(dir, name), "utf8")
      .split("\n").filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { name: string; attrs?: Record<string, unknown> }));
    const present = written.find((record) => record.name === "daemon.cleaner.present");
    const drop = written.find((record) => record.name === "daemon.cleaner.drop" && record.attrs?.reason === "superseded");
    assert.ok(present && drop, "one hint was presented, then dropped once under threshold");
    for (const record of [present, drop]) {
      assert.equal(record.attrs?.owner_agent_id, "owner-a", record.name);
      assert.equal(record.attrs?.app_id, CLEANER_APP_ID, record.name);
      assert.equal(record.attrs?.ownerAgentId, undefined, record.name);
    }
    assert.equal(present.attrs?.item_id, fixture.wakes[0]!.itemId);
    assert.equal(present.attrs?.workspace_cleanup_tip, true, "#8833's tip flag survives the sink too");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("under-threshold and not-established measurements produce zero current item while rearming", async () => {
  const outcomes: CleanerMeasurement[] = [
    { kind: "measured", bytes: CLEANER_CONFIG_DEFAULTS.thresholdBytes + 1 },
    { kind: "measured", bytes: CLEANER_CONFIG_DEFAULTS.thresholdBytes },
    { kind: "not_established", reason: "missing" },
  ];
  const fixture = runtimeFixture({ measurement: () => outcomes.shift()! });
  fixture.runtime.applyConfig(config());
  await firePeriodic(fixture);
  assert.equal(fixture.runtime.inbox.list().length, 1);

  await firePeriodic(fixture);
  assert.equal(fixture.runtime.inbox.list().length, 0, "under-threshold drops the old current hint");

  await firePeriodic(fixture);
  assert.equal(fixture.runtime.inbox.list().length, 0);
  assert.equal(fixture.runtime.activeScheduleCount("owner-a"), 1);
  assert.equal(fixture.wakes.length, 1);
  assert.ok(fixture.traces.some((entry) => entry.name === "daemon.cleaner.measurement" && entry.attrs.reason === "missing"));
});

test("config reseed cancels old period, stale dequeued callback is inert, and next run uses new config", async () => {
  const fixture = runtimeFixture({ measurement: { kind: "measured", bytes: 300_000 } });
  fixture.runtime.applyConfig(config({
    revision: 1,
    thresholdBytes: CLEANER_CONFIG_DEFAULTS.thresholdBytes,
    intervalMs: MIN_INTERVAL_MS,
  }));
  const oldTimer = fixture.clock.activeIds()[0]!;
  fixture.runtime.applyConfig(config({
    revision: 2,
    thresholdBytes: CLEANER_CONFIG_DEFAULTS.thresholdBytes * 2,
    intervalMs: MIN_INTERVAL_MS * 2,
  }));

  assert.equal(fixture.runtime.activeScheduleCount("owner-a"), 1);
  assert.equal(fixture.clock.activeCount(), 1, "reseed must retire the old schedule");
  fixture.clock.fire(oldTimer, { evenIfCleared: true });
  await fixture.runtime.waitForIdle();
  assert.equal(fixture.measurements.length, 0, "a dequeued retired callback must not measure");
  assert.equal(fixture.clock.activeCount(), 1);

  await firePeriodic(fixture);
  assert.equal(fixture.measurements.length, 1);
  const item = fixture.runtime.inbox.list()[0]!;
  assert.match(item.title ?? "", /128\.0 KiB/);
  assert.equal(
    item.actionCli,
    `raft app config --app system.cleaner --set threshold_bytes=${CLEANER_CONFIG_DEFAULTS.thresholdBytes * 4}`,
  );
  assert.equal(fixture.runtime.activeScheduleCount("owner-a"), 1);
});

test("two owner config revisions leave one current item and obsolete action disappears at apply", async () => {
  const fixture = runtimeFixture({ measurement: { kind: "measured", bytes: 500_000 } });
  fixture.runtime.applyConfig(config({ revision: 1 }));
  await firePeriodic(fixture);
  const first = fixture.runtime.inbox.list();
  assert.equal(first.length, 1);
  assert.equal(
    first[0]!.actionCli,
    `raft app config --app system.cleaner --set threshold_bytes=${CLEANER_CONFIG_DEFAULTS.thresholdBytes * 2}`,
  );

  fixture.runtime.applyConfig(config({
    revision: 2,
    thresholdBytes: CLEANER_CONFIG_DEFAULTS.thresholdBytes * 2,
  }));
  assert.equal(fixture.runtime.inbox.list().length, 0, "config apply removes obsolete current action");
  await firePeriodic(fixture);
  const second = fixture.runtime.inbox.list();
  assert.equal(second.length, 1);
  assert.deepEqual(second[0]!.sourceRef, { kind: "memory_hint", id: "owner-a" });
  assert.equal(
    second[0]!.actionCli,
    `raft app config --app system.cleaner --set threshold_bytes=${CLEANER_CONFIG_DEFAULTS.thresholdBytes * 4}`,
  );
});

test("disabled config cancels schedule/item and a previously dequeued callback has zero effects", async () => {
  const fixture = runtimeFixture();
  fixture.runtime.applyConfig(config({ revision: 1 }));
  await firePeriodic(fixture);
  assert.equal(fixture.runtime.inbox.list().length, 1);
  const armed = fixture.clock.activeIds()[0]!;

  fixture.runtime.applyConfig(config({ revision: 2, enabled: false }));
  assert.equal(fixture.runtime.activeScheduleCount("owner-a"), 0);
  assert.equal(fixture.runtime.inbox.list().length, 0);
  const measurementCount = fixture.measurements.length;
  fixture.clock.fire(armed, { evenIfCleared: true });
  await fixture.runtime.waitForIdle();
  assert.equal(fixture.measurements.length, measurementCount);
  assert.equal(fixture.wakes.length, 1);
  assert.equal(fixture.runtime.inbox.list().length, 0);
});

test("threshold below maximum clamps the action and preview does not claim it doubles", async () => {
  const fixture = runtimeFixture({ measurement: { kind: "measured", bytes: MAX_THRESHOLD_BYTES } });
  fixture.runtime.applyConfig(config({ thresholdBytes: Math.floor(MAX_THRESHOLD_BYTES * 0.75) }));
  await firePeriodic(fixture);
  const item = fixture.runtime.inbox.list()[0]!;
  assert.equal(
    item.actionCli,
    `raft app config --app system.cleaner --set threshold_bytes=${MAX_THRESHOLD_BYTES}`,
  );
  assert.match(item.summary ?? "", /raises to maximum/i);
  assert.doesNotMatch(item.summary ?? "", /doubles/i);
});

test("threshold already at maximum offers config view and copy never claims a raise", async () => {
  const fixture = runtimeFixture({ measurement: { kind: "measured", bytes: MAX_THRESHOLD_BYTES + 1 } });
  fixture.runtime.applyConfig(config({ thresholdBytes: MAX_THRESHOLD_BYTES }));
  await firePeriodic(fixture);
  const item = fixture.runtime.inbox.list()[0]!;
  assert.equal(item.actionCli, "raft app config --app system.cleaner");
  assert.match(item.summary ?? "", /already at maximum.*set it lower/i);
  assert.doesNotMatch(item.summary ?? "", /raises/i);
  assert.doesNotMatch(item.summary ?? "", /doubles/i);
});

test("restart keeps no old measurement/item, then config snapshot arms exactly one later remeasure", async () => {
  const first = runtimeFixture();
  first.runtime.applyConfig(config());
  await firePeriodic(first);
  assert.equal(first.runtime.inbox.list().length, 1);
  first.runtime.clear();
  assert.equal(first.runtime.inbox.list().length, 0);
  assert.equal(first.clock.activeCount(), 0);

  const second = runtimeFixture();
  const receipt = second.runtime.replaceSnapshot([config()]);
  assert.deepEqual(receipt, [{ kind: "applied", activeSchedules: 1 }]);
  assert.equal(second.runtime.inbox.list().length, 0);
  assert.equal(second.measurements.length, 0, "snapshot/restart does not restore or immediately replay a measurement");
  assert.equal(second.runtime.activeScheduleCount("owner-a"), 1);
  await firePeriodic(second);
  assert.equal(second.runtime.inbox.list().length, 1);
});

test("measurement timeout creates no item and the periodic schedule survives", async () => {
  const fixture = runtimeFixture({
    measurement: () => new Promise<CleanerMeasurement>(() => {}),
    measurementTimeoutMs: 50,
  });
  fixture.runtime.applyConfig(config({ intervalMs: MIN_INTERVAL_MS }));
  fixture.clock.fire(fixture.clock.earliestActiveId());
  // runPeriod rearms the canonical minimum period and arms a 50ms deadline.
  await Promise.resolve();
  fixture.clock.fire(fixture.clock.earliestActiveId());
  await fixture.runtime.waitForIdle();
  assert.equal(fixture.runtime.inbox.list().length, 0);
  assert.equal(fixture.runtime.activeScheduleCount("owner-a"), 1);
  assert.ok(fixture.traces.some((entry) => entry.name === "daemon.cleaner.measurement" && entry.attrs.reason === "timeout"));
});

test("invalid snapshot is atomic and owner ids cannot escape the agents root", () => {
  const fixture = runtimeFixture();
  fixture.runtime.applyConfig(config());
  const before = fixture.clock.activeIds();
  const result = fixture.runtime.replaceSnapshot([
    config({ ownerAgentId: "owner-b" }),
    config({ ownerAgentId: "../escape", revision: 2 }),
  ]);
  assert.deepEqual(result, { kind: "invalid", reason: "owner_agent_id_invalid" });
  assert.deepEqual(fixture.runtime.getAppliedConfig("owner-a"), config());
  assert.deepEqual(fixture.clock.activeIds(), before);
});

test("all four canonical schema bounds fail closed before scheduling", () => {
  const fixture = runtimeFixture();
  const cases: Array<[Partial<CleanerConfigEnvelope>, string]> = [
    [{ thresholdBytes: MIN_THRESHOLD_BYTES - 1 }, "threshold_bytes_invalid"],
    [{ thresholdBytes: MAX_THRESHOLD_BYTES + 1 }, "threshold_bytes_invalid"],
    [{ intervalMs: MIN_INTERVAL_MS - 1 }, "interval_ms_invalid"],
    [{ intervalMs: MAX_INTERVAL_MS + 1 }, "interval_ms_invalid"],
  ];
  for (const [override, reason] of cases) {
    assert.deepEqual(fixture.runtime.applyConfig(config(override)), { kind: "invalid", reason });
  }
  assert.equal(fixture.clock.activeCount(), 0);
  assert.equal(fixture.runtime.inbox.list().length, 0);
});


test("low disk space never reaches or wakes the agent and retracts a hint left by an older runtime", async () => {
  let availableBytes = 9;
  const fixture = runtimeFixture({
    diskMeasurement: async () => ({ kind: "measured", availableBytes, totalBytes: 100 }),
  });
  fixture.runtime.applyConfig(config());
  const legacy = fixture.runtime.inbox.mint({
    appId: CLEANER_APP_ID,
    notificationClass: "disk_space_hint",
    sourceRef: { kind: "disk_hint", agentId: "owner-a" },
    title: "Agent data disk: 9 B free, below 10%; recheck in 1h",
    summary: "Clean only inside your own workspace.",
  });
  assert.ok(legacy.ok);
  const diskDecisions = () => fixture.traces
    .filter(({ name, attrs }) => name === "daemon.cleaner.decision" && attrs.notificationClass === "disk_space_hint")
    .map(({ attrs }) => attrs.decision);

  await firePeriodic(fixture);
  assert.deepEqual(fixture.runtime.inbox.list().map((item) => item.notificationClass), ["memory_size_hint"]);
  assert.ok(fixture.wakes.every((wake) => wake.itemId !== legacy.item.itemId));
  assert.deepEqual(diskDecisions(), ["disk_low"]);
  assert.equal(fixture.traces.filter(({ name, attrs }) =>
    name === "daemon.cleaner.present" && attrs.notificationClass === "disk_space_hint").length, 0);

  availableBytes = 0;
  await firePeriodic(fixture);
  assert.deepEqual(diskDecisions(), ["disk_low", "disk_low"]);
  assert.deepEqual(fixture.runtime.inbox.list().map((item) => item.notificationClass), ["memory_size_hint"]);
  availableBytes = 10;
  await firePeriodic(fixture);
  assert.deepEqual(diskDecisions(), ["disk_low", "disk_low"], "10% free is not low");
  assert.equal(fixture.wakes.length, 1, "only the memory hint ever woke");
});

test("missing memory and an unreadable disk produce no item and no wake", async () => {
  let disk: CleanerDiskMeasurement = { kind: "measured", availableBytes: 1, totalBytes: 100 };
  const fixture = runtimeFixture({
    measurement: { kind: "not_established", reason: "missing" },
    diskMeasurement: async () => disk,
  });
  fixture.runtime.applyConfig(config());
  await firePeriodic(fixture);
  assert.ok(fixture.traces.some(({ name, attrs }) => name === "daemon.cleaner.decision" && attrs.decision === "disk_low"));
  disk = { kind: "not_established", reason: "read_failed" };
  await firePeriodic(fixture);
  assert.ok(fixture.traces.some(({ name, attrs }) =>
    name === "daemon.cleaner.measurement" && attrs.notificationClass === "disk_space_hint" && attrs.established === false));
  assert.equal(fixture.runtime.inbox.list().length, 0);
  assert.equal(fixture.wakes.length, 0);
  assert.equal(fixture.runtime.activeScheduleCount("owner-a"), 1);
});

test("an unchanged memory hint wakes once per day; marked growth or clearing the threshold resets that", async () => {
  const threshold = CLEANER_CONFIG_DEFAULTS.thresholdBytes;
  let bytes = threshold * 2;
  const fixture = runtimeFixture({ measurement: () => ({ kind: "measured", bytes }) });
  fixture.runtime.applyConfig(config());
  const wakeReasons = () => fixture.traces
    .filter(({ name, attrs }) => name === "daemon.cleaner.present" && attrs.notificationClass !== "disk_space_hint")
    .map(({ attrs }) => attrs.wake_reason);
  const cooldownDrops = () => fixture.traces
    .filter(({ name, attrs }) => name === "daemon.cleaner.drop" && attrs.reason === "rewake_cooldown").length;

  await firePeriodic(fixture);
  const firstAtMs = fixture.clock.now();
  assert.deepEqual(wakeReasons(), ["first"]);
  const itemId = fixture.runtime.inbox.list()[0]!.itemId;

  // The agent reads the hint (ack) but MEMORY.md stays the same size.
  assert.ok(fixture.runtime.inbox.ack(itemId));
  await firePeriodic(fixture);
  await firePeriodic(fixture);
  assert.deepEqual(wakeReasons(), ["first"], "hourly checks within a day neither re-present nor wake");
  assert.equal(cooldownDrops(), 2);
  assert.equal(fixture.runtime.inbox.list().length, 0, "an acknowledged hint is not re-minted during the cooldown");
  assert.equal(fixture.wakes.length, 1);

  bytes = Math.ceil(threshold * 2 * CLEANER_MEMORY_HINT_REWAKE_GROWTH_RATIO);
  await firePeriodic(fixture);
  assert.deepEqual(wakeReasons(), ["first", "grew"]);
  assert.equal(fixture.wakes.length, 2);

  fixture.clock.nowMs = firstAtMs + 2 * CLEANER_MEMORY_HINT_REWAKE_COOLDOWN_MS;
  await firePeriodic(fixture);
  assert.deepEqual(wakeReasons(), ["first", "grew", "cooldown_elapsed"]);

  bytes = 1;
  await firePeriodic(fixture);
  bytes = threshold * 2;
  await firePeriodic(fixture);
  assert.deepEqual(wakeReasons(), ["first", "grew", "cooldown_elapsed", "first"], "dropping under the threshold resets the cooldown");
  assert.equal(fixture.wakes.length, 4);
});

test("disk measurement finishing after owner removal cannot publish into a replacement config", async () => {
  let finish!: (measurement: CleanerDiskMeasurement) => void;
  const fixture = runtimeFixture({
    measurement: { kind: "measured", bytes: 1 },
    diskMeasurement: () => new Promise((resolve) => { finish = resolve; }),
  });
  fixture.runtime.applyConfig(config());
  fixture.clock.fire(fixture.clock.earliestActiveId());
  await Promise.resolve();
  fixture.runtime.replaceOwnerSnapshot("owner-a", null);
  fixture.runtime.applyConfig(config());
  finish({ kind: "measured", availableBytes: 0, totalBytes: 100 });
  await fixture.runtime.waitForIdle();
  assert.equal(fixture.runtime.inbox.list().length, 0);
  assert.equal(fixture.wakes.length, 0);
});

test("disk timeout does not block a memory hint and checks retry next period", async () => {
  let observedWake!: () => void;
  const wakeObserved = new Promise<void>((resolve) => { observedWake = resolve; });
  const fixture = runtimeFixture({
    diskMeasurement: () => new Promise(() => {}),
    measurementTimeoutMs: 50,
    onWake: observedWake,
  });
  fixture.runtime.applyConfig(config());
  fixture.clock.fire(fixture.clock.earliestActiveId());
  await wakeObserved;
  assert.deepEqual(fixture.runtime.inbox.list().map((item) => item.notificationClass), ["memory_size_hint"]);
  fixture.clock.fire(fixture.clock.earliestActiveId());
  await fixture.runtime.waitForIdle();
  assert.equal(fixture.runtime.activeScheduleCount("owner-a"), 1);
  assert.ok(fixture.traces.some(({ attrs }) => attrs.notificationClass === "disk_space_hint" && attrs.reason === "timeout"));
});

test("a large disk with 20 GiB or more free is not low even under 10%", async () => {
  const GIB = 1024 ** 3;
  const fixture = runtimeFixture({
    measurement: { kind: "measured", bytes: 1 },
    diskMeasurement: async () => ({ kind: "measured", availableBytes: 100 * GIB, totalBytes: 2048 * GIB }),
  });
  fixture.runtime.applyConfig(config());
  await firePeriodic(fixture);
  assert.ok(!fixture.traces.some(({ name, attrs }) => name === "daemon.cleaner.decision" && attrs.decision === "disk_low"));
});
