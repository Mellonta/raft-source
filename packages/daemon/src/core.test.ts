import { AgentProxyBindError } from "./spawnFailureErrors";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { asAxSurfaceText, type AxSurfaceText,
  AGENT_MIGRATION_CAPABILITY,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS,
  DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1,
  SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1,
  createTraceScopeTracer,
  eventsForSpan,
  formatTraceparent,
  parseTraceparent,
  type AgentConfig,
  type ComputerLifecycleExecutionAck,
  type MachineToServerMessage,
  type RuntimeAccountUsageProvider,
  type RuntimeAccountUsageSnapshot,
  type ServerToMachineMessage,
  AGENT_MIGRATION_COMMIT_MARKER_PATH,
} from "@botiverse/raft-shared";
import {
  CLEANER_APP_ID,
  CLEANER_CONFIG_DEFAULTS,
  CLEANER_NOTIFICATION_CLASS,
} from "@botiverse/raft-shared/src/apps/cleaner/configProtocol";
import { REMINDER_FIRE_REQUEST_CAPABILITY } from "@botiverse/raft-shared/src/apps/reminder/protocol";
import { AgentProcessManager } from "./agentProcessManager";
import { OUTBOX_NORMAL_CAP, RuntimeOutcomeOutbox, nodeOutboxFs, type OutboxFrame } from "./runtimeOutcomeOutbox";
import { installDaemonFetchMockForTests } from "./daemonFetch";
import type { AgentAppInboxStore } from "./agentAppInbox";
import { AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY } from "./agentMigrationWorkspaceArchive";
import {
  DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  DaemonCore,
  selectWakeDeliveryIndex,
  detectRuntimes,
  migrationTransferFailureCode,
  migrationTransferFailureDetailCode,
  retryMigrationTargetStep,
  type MigrationTargetImportView,
  parseDaemonCliArgs,
  readDaemonVersion,
  resolveRaftCliPath,
  sanitizeCatalogModels,
  subscribeDaemonLogs,
} from "./core";
import { streamAgentMigrationResumableBundle, validateAgentMigrationControlManifest } from "./agentMigrationResumableBundle";
import { getDaemonMachineLockId } from "./machineLock";
import type { RuntimeDriver, ParsedEvent, SpawnContext, SpawnResult } from "./drivers/index";
import type { ConnectionOptions, WebSocketLike } from "./connection";
import { FakeClock } from "./testing/fakeClock";
import { traceRows } from "./testing/traceRows";
import { makeDeterministicTracer } from "./testing/deterministicTracer";

test("migration transfer classification preserves the bounded entry-count failure", () => {
  assert.equal(
    migrationTransferFailureCode(new Error(
      "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED:entryCount=250001:maxEntries=250000:topPathCounts=src%2F,250001",
    )),
    "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
  );
  assert.equal(
    migrationTransferFailureCode(new Error("MIGRATION_PRIVATE_DRIVER_FAILURE:password=secret")),
    undefined,
  );
});

test("migration transfer detail code keeps the real cause without free text", () => {
  assert.equal(
    migrationTransferFailureDetailCode(new Error("MIGRATION_WORKSPACE_ALREADY_EXISTS")),
    "MIGRATION_WORKSPACE_ALREADY_EXISTS",
  );
  assert.equal(
    migrationTransferFailureDetailCode(new Error(
      "MIGRATION_TARGET_IMPORT_ARRIVED_FAILED:503:migration_source_workspace_archive_failed",
    )),
    "MIGRATION_TARGET_IMPORT_ARRIVED_FAILED:503:migration_source_workspace_archive_failed",
  );
  assert.equal(
    migrationTransferFailureDetailCode(new Error("MIGRATION_PRIVATE_DRIVER_FAILURE:password=secret")),
    "MIGRATION_PRIVATE_DRIVER_FAILURE",
  );
  const enospc = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  assert.equal(migrationTransferFailureDetailCode(enospc), "NODE_ENOSPC");
  const fetchFailed = new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
  assert.equal(migrationTransferFailureDetailCode(fetchFailed), "FETCH_ECONNRESET");
  assert.equal(migrationTransferFailureDetailCode(new TypeError("fetch failed")), "FETCH_FAILED");
  assert.equal(migrationTransferFailureDetailCode(new RangeError("Invalid string length")), "JS_RangeError");
  assert.equal(migrationTransferFailureDetailCode("not an error"), undefined);
});
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

  kill(_signal?: NodeJS.Signals | number): boolean {
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
    return true;
  }
}

class FakeDriver implements RuntimeDriver {
  readonly id = "codex";
  readonly lifecycle: RuntimeDriver["lifecycle"];
  readonly communication = {
    chat: "slock_cli",
    runtimeControl: "none",
  } as const;
  readonly session = { recovery: "resume_or_fresh" } as const;
  readonly model = { detectedModelsVerifiedAs: "suggestion_only" } as const;
  readonly supportsStdinNotification: boolean;
  readonly busyDeliveryMode = "none" as const;
  readonly spawnCalls: SpawnContext[] = [];
  readonly children: FakeChildProcess[] = [];
  /** Thrown by spawn: a start that fails before any process exists (e.g. an unavailable model). */
  failSpawn: Error | null = null;

  constructor(opts: { supportsStdinNotification?: boolean } = {}) {
    this.supportsStdinNotification = opts.supportsStdinNotification ?? false;
    this.lifecycle = this.supportsStdinNotification
      ? { kind: "persistent", stdin: "notification", inFlightWake: "queue" }
      : { kind: "per_turn", start: "immediate", exit: "natural", inFlightWake: "spawn_new" };
  }

  spawn(ctx: SpawnContext): SpawnResult {
    this.spawnCalls.push(ctx);
    if (this.failSpawn) throw this.failSpawn;
    const child = new FakeChildProcess();
    this.children.push(child);
    return { process: child as unknown as ChildProcess };
  }

  parseLine(line: string): ParsedEvent[] {
    if (line === "turn_end") return [{ kind: "turn_end", sessionId: "session-1" }];
    if (line === "text") return [{ kind: "text", text: "model output" }];
    return [];
  }

  encodeStdinMessage(_text: string, _sessionId: string | null): string | null {
    return this.supportsStdinNotification ? _text : null;
  }

  buildSystemPrompt(_config: AgentConfig, _agentId: string): AxSurfaceText {
    return asAxSurfaceText("test prompt");
  }
}

class FakeWebSocket extends EventEmitter implements WebSocketLike {
  readyState = 0;
  readonly sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  }

  terminate(): void {
    this.readyState = 3;
    this.emit("close", 1006, Buffer.from(""));
  }

  emitOpen(options: { machineContext?: boolean } = {}): void {
    this.readyState = 1;
    this.emit("open");
    if (options.machineContext !== false) {
      this.emitServerMessage({
        type: "machine:context",
        machineId: "machine-test",
        serverId: "server-test",
      });
    }
  }

  emitServerMessage(message: ServerToMachineMessage): void {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "codex-agent",
    displayName: "Codex Agent",
    description: "test agent",
    model: "gpt-5.3-codex",
    runtime: "codex",
    reasoningEffort: null,
    envVars: null,
    sessionId: null,
    serverUrl: "http://localhost:3001",
    authToken: "",
    agentCredentialKey: "sk_agent_existing",
    ...overrides,
  };
}

/** RFC 071 outbox: open the socket as an ack-capable server, optionally acking every outbox frame at once. */
function openAckingServer(socket: FakeWebSocket, options: { autoAck?: boolean } = {}): void {
  if (options.autoAck !== false) {
    const send = socket.send.bind(socket);
    socket.send = (data: string) => {
      send(data);
      const msg = JSON.parse(data) as { type?: string; agentId?: string; daemonInstanceId?: string; clientSeq?: number; gapId?: string };
      const outbox = ["agent:runtime:outcome", "agent:process_spawned", "agent:process_exited", "agent:start:outcome"];
      if (msg.type && outbox.includes(msg.type)) {
        setImmediate(() => socket.emitServerMessage({ type: "agent:outcome:ack", agentId: msg.agentId!, daemonInstanceId: msg.daemonInstanceId, clientSeq: msg.clientSeq }));
      } else if (msg.type === "agent:runtime:outcome_gap" || msg.type === "agent:runtime:outcome_cross_instance_unknown") {
        setImmediate(() => socket.emitServerMessage({ type: "agent:outcome:ack", agentId: msg.agentId!, gapId: msg.gapId }));
      }
    };
  }
  socket.emitOpen({ machineContext: false });
  socket.emitServerMessage({
    type: "machine:context",
    machineId: "machine-test",
    serverId: "server-test",
    capabilities: [SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1],
  });
}

test("daemon CLI accepts machine API key from a file instead of argv", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-api-key-file-test-"));
  try {
    const keyFile = path.join(tmp, "machine.key");
    await writeFile(keyFile, "sk_machine_secret\n", { mode: 0o600 });

    const parsed = parseDaemonCliArgs([
      "--server-url",
      "https://api.slock.ai",
      "--api-key-file",
      keyFile,
    ]);

    assert.deepEqual(parsed, {
      serverUrl: "https://api.slock.ai",
      apiKey: "sk_machine_secret",
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("readDaemonVersion accepts a Computer SEA build constant and ignores runtime env", () => {
  const previous = process.env.RAFT_DAEMON_VERSION;
  process.env.RAFT_DAEMON_VERSION = "42.0.0-env-must-not-win";
  try {
    const missingPackageUrl = new URL("file:///no-such-computer-sea/core.js").href;
    assert.equal(readDaemonVersion(missingPackageUrl, "0.72.4-sea"), "0.72.4-sea");
    assert.equal(readDaemonVersion(missingPackageUrl), "0.0.0-dev");
  } finally {
    if (previous === undefined) delete process.env.RAFT_DAEMON_VERSION;
    else process.env.RAFT_DAEMON_VERSION = previous;
  }
});

test("DaemonCore ready stamps the Computer SEA baked daemon version", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-sea-version-ready-test-"));
  const sockets: FakeWebSocket[] = [];
  const previous = process.env.RAFT_DAEMON_VERSION;
  let core: DaemonCore | null = null;

  try {
    process.env.RAFT_DAEMON_VERSION = "42.0.0-env-must-not-win";
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      daemonVersion: "0.72.4-sea",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    const ready = socket.sent.find((msg): msg is Extract<MachineToServerMessage, { type: "ready" }> =>
      typeof msg === "object" && msg !== null && (msg as { type?: string }).type === "ready"
    );
    assert.equal(ready?.daemonVersion, "0.72.4-sea");
    assert.equal(ready?.capabilities?.includes(COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS), false);
    assert.equal(ready?.capabilities?.includes(REMINDER_FIRE_REQUEST_CAPABILITY), true);

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    if (previous === undefined) delete process.env.RAFT_DAEMON_VERSION;
    else process.env.RAFT_DAEMON_VERSION = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore binds App storage to authenticated machine context and revokes it on mismatch", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-scoped-app-storage-test-"));
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const legacyPath = path.join(rootDir, "agent-inbox", "agent-1.json");
  const legacyReminderPath = path.join(rootDir, "reminders", "mirror.json");
  const scopedPath = path.join(
    rootDir,
    "app-storage",
    "v1",
    "machine-1",
    "server-1",
    "system.agent-inbox",
    "agents",
    "agent-1",
    "state.json",
  );
  let core: DaemonCore | null = null;
  try {
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, '{"version":3,"items":[]}\n');
    await mkdir(path.dirname(legacyReminderPath), { recursive: true });
    await writeFile(legacyReminderPath, '{"version":4,"records":[]}\n');
    await mkdir(path.dirname(scopedPath), { recursive: true });
    await writeFile(scopedPath, "{invalid-json\n");
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir: path.join(rootDir, "agents"),
      slockHome: rootDir,
      tracer,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen({ machineContext: false });
    const storageAccess = core as unknown as {
      getAgentAppInbox(agentId: string): AgentAppInboxStore;
    };
    assert.throws(
      () => storageAccess.getAgentAppInbox("agent-1"),
      /before authenticated machine context/,
    );

    socket.emitServerMessage({
      type: "machine:context",
      machineId: "machine-1",
      serverId: "server-1",
    });
    assert.throws(
      () => storageAccess.getAgentAppInbox("agent-1"),
      /Unexpected token in agent app inbox persisted JSON/,
    );
    const storageTraces = traceRows(sink, traceId);
    const heartbeats = storageTraces.filter((span) =>
      span.name === "daemon.app_storage.heartbeat"
    );
    assert.equal(heartbeats.length, 6);
    assert.equal(heartbeats.every((span) => span.attrs?.server_id === "server-1"), true);
    const writerEpoch = heartbeats[0]?.attrs?.writer_epoch;
    assert.equal(typeof writerEpoch, "string");
    assert.equal(heartbeats.every((span) => span.attrs?.writer_epoch === writerEpoch), true);
    const invalidPayload = storageTraces.find((span) =>
      span.name === "daemon.app_storage.counter"
      && span.attrs?.app === "system.agent-inbox"
      && span.attrs?.family === "invalid_payload"
    );
    assert.deepEqual(invalidPayload?.attrs && {
      operation: invalidPayload.attrs.operation,
      reason: invalidPayload.attrs.reason,
      serverId: invalidPayload.attrs.server_id,
      writerEpoch: invalidPayload.attrs.writer_epoch,
      corruptionClass: invalidPayload.attrs.corruption_class,
    }, {
      operation: "decode",
      reason: "invalid_payload",
      serverId: "server-1",
      writerEpoch,
      corruptionClass: "edge",
    });
    await rm(scopedPath);
    const inbox = storageAccess.getAgentAppInbox("agent-1");
    const minted = inbox.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: {
        kind: "reminder",
        id: "11111111-1111-4111-8111-111111111111",
        revision: "1",
      },
    });
    assert.equal(minted.ok, true);
    assert.match(await readFile(scopedPath, "utf8"), /11111111-1111-4111-8111-111111111111/);
    await assert.rejects(stat(legacyPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    await assert.rejects(
      stat(legacyReminderPath),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    const quarantined = await readdir(path.join(
      rootDir,
      "app-storage-quarantine",
      "v1",
      "unscoped",
    ));
    assert.equal(
      quarantined.filter((name) => name.endsWith("-mirror.json")).length,
      1,
      "legacy global Reminder mirror is quarantined exactly once",
    );

    socket.emitServerMessage({
      type: "machine:context",
      machineId: "machine-1",
      serverId: "server-2",
    });
    assert.throws(() => inbox.clear(), /capability is revoked/);
    assert.throws(
      () => storageAccess.getAgentAppInbox("agent-2"),
      /after authenticated machine context conflict/,
    );
  } finally {
    if (core) await core.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("DaemonCore refreshes one runtime usage provider and emits only the sanitized correlated snapshot", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-runtime-usage-test-"));
  const sockets: FakeWebSocket[] = [];
  const calls: RuntimeAccountUsageProvider[] = [];
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const sanitizedSnapshot: RuntimeAccountUsageSnapshot = {
    protocolVersion: 2,
    provider: "kimi",
    collectedAt: "2026-08-01T20:00:00.000Z",
    staleAfter: "2026-08-01T20:30:00.000Z",
    collectorVersion: "test",
    accounts: [{
      accountKey: "a".repeat(64),
      health: "ok",
      windows: [{
        id: "weekly_0",
        label: "Weekly limit",
        status: "ok",
        usedRatio: 0.4,
        resetsAt: "2026-08-07T13:07:35.341Z",
      }],
    }],
  };
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    tracer,
    runtimeDetector: () => ({ ids: [], versions: {} }),
    runtimeAccountUsageCollector: async (provider) => {
      calls.push(provider);
      return sanitizedSnapshot;
    },
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:runtime_account_usage:refresh",
      requestId: "usage-request-1",
      provider: "kimi",
      reason: "stale_or_missing",
    });
    await waitFor(
      () => socket.sent.some((message) => (message as { type?: string }).type === "machine:runtime_account_usage:snapshot"),
      "runtime usage snapshot",
    );

    assert.deepEqual(calls, ["kimi"]);
    const response = socket.sent.find((message): message is Extract<MachineToServerMessage, { type: "machine:runtime_account_usage:snapshot" }> =>
      typeof message === "object" && message !== null && (message as { type?: string }).type === "machine:runtime_account_usage:snapshot"
    );
    assert.deepEqual(response, {
      type: "machine:runtime_account_usage:snapshot",
      requestId: "usage-request-1",
      snapshot: sanitizedSnapshot,
    });
    const trace = traceRows(sink, traceId).find((candidate) => candidate.name === "daemon.runtime_account_usage.refresh");
    assert.equal(trace?.attrs?.outcome, "snapshot_sent");
    assert.equal(trace?.attrs?.provider, "kimi");
    assert.equal(trace?.attrs?.reason, "stale_or_missing");
    assert.equal(trace?.attrs?.account_count, 1);
    assert.equal(trace?.attrs?.window_count, 1);
    assert.equal(trace?.attrs?.health_classes, "ok");
    assert.equal(trace?.attrs?.parse_unavailable_count, 0);
    assert.equal(trace?.attrs?.account_key, undefined);
    assert.equal(trace?.attrs?.resets_at, undefined);
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore pushes each ready runtime's model catalog after ready, and again after a rescan", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-model-catalog-test-"));
  const sockets: FakeWebSocket[] = [];
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    // claude has a static model source; the unknown runtime has neither a
    // driver nor a static list, so it must produce no catalog frame.
    runtimeDetector: () => ({ ids: ["claude", "no-such-runtime"], versions: {} }),
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();
    const catalogs = () => socket.sent.filter((message): message is Extract<MachineToServerMessage, { type: "machine:runtime_models:catalog" }> =>
      typeof message === "object" && message !== null && (message as { type?: string }).type === "machine:runtime_models:catalog");
    await waitFor(() => catalogs().length === 1, "claude catalog after ready");

    const readyIndex = socket.sent.findIndex((message) => (message as { type?: string }).type === "ready");
    const catalogIndex = socket.sent.indexOf(catalogs()[0]!);
    assert.ok(readyIndex >= 0 && readyIndex < catalogIndex, "the catalog follows ready");
    const [claude] = catalogs();
    assert.equal(claude!.runtime, "claude");
    assert.ok(claude!.models.length > 0);
    for (const model of claude!.models) {
      assert.deepEqual(Object.keys(model).sort(), ["id", "label"], "only id and label cross the wire");
    }

    socket.emitServerMessage({ type: "machine:runtimes:rescan" });
    await waitFor(() => catalogs().length === 2, "claude catalog after rescan");
    assert.deepEqual(catalogs().map((message) => message.runtime), ["claude", "claude"]);
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore does not re-detect model catalogs on a quick reconnect; rescan always pushes", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-model-catalog-throttle-test-"));
  const sockets: FakeWebSocket[] = [];
  let claudeVersion = "2.1.0";
  let core: DaemonCore | null = null;
  const catalogsOn = (socket: FakeWebSocket | undefined) =>
    (socket?.sent ?? []).filter((message) => (message as { type?: string }).type === "machine:runtime_models:catalog");
  const readyOn = (socket: FakeWebSocket | undefined) =>
    (socket?.sent ?? []).some((message) => (message as { type?: string }).type === "ready");

  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: ["claude"], versions: { claude: claudeVersion } }),
      connectionOptions: {
        minReconnectDelayMs: 1,
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    sockets[0]?.emitOpen();
    await waitFor(() => catalogsOn(sockets[0]).length === 1, "catalog on first connect");

    // Quick reconnect, same runtimes and versions: no second detection round.
    sockets[0]?.terminate();
    await waitFor(() => sockets.length === 2, "replacement websocket");
    sockets[1]?.emitOpen();
    await waitFor(() => readyOn(sockets[1]), "ready after reconnect");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(catalogsOn(sockets[1]).length, 0, "a reconnect inside the interval must not re-detect");

    // rescan is explicit and always pushes.
    sockets[1]?.emitServerMessage({ type: "machine:runtimes:rescan" });
    await waitFor(() => catalogsOn(sockets[1]).length === 1, "catalog after rescan");

    // A changed runtime version does not lift the start floor: two daemons that
    // share one identity (task #354) can present different inventories on every
    // flap, so a signature change must not become a way around it. rescan (or the
    // next connect after the floor) picks the change up.
    claudeVersion = "2.2.0";
    sockets[1]?.terminate();
    await waitFor(() => sockets.length === 3, "second replacement websocket");
    sockets[2]?.emitOpen();
    await waitFor(() => readyOn(sockets[2]), "ready after the version change");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(catalogsOn(sockets[2]).length, 0, "a version change inside the start floor waits");
    sockets[2]?.emitServerMessage({ type: "machine:runtimes:rescan" });
    await waitFor(() => catalogsOn(sockets[2]).length === 1, "rescan picks the version change up");

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore starts at most one connect-triggered catalog round per interval even when every round is cut short (task #354 flapping)", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-model-catalog-flap-test-"));
  const sockets: FakeWebSocket[] = [];
  let core: DaemonCore | null = null;
  const catalogsOn = (socket: FakeWebSocket | undefined) =>
    (socket?.sent ?? []).filter((message) => (message as { type?: string }).type === "machine:runtime_models:catalog");
  const readyOn = (socket: FakeWebSocket | undefined) =>
    (socket?.sent ?? []).some((message) => (message as { type?: string }).type === "ready");

  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      // Two runtimes: the connection drops right after the first frame, so no
      // round ever completes and the completion-based throttle never engages.
      runtimeDetector: () => ({ ids: ["claude", "gemini"], versions: {} }),
      connectionOptions: {
        minReconnectDelayMs: 1,
        wsFactory: () => {
          const socket = new FakeWebSocket();
          const send = socket.send.bind(socket);
          socket.send = (data: string) => {
            send(data);
            if ((JSON.parse(data) as { type?: string }).type === "machine:runtime_models:catalog") socket.terminate();
          };
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    sockets[0]?.emitOpen();
    await waitFor(() => catalogsOn(sockets[0]).length === 1, "first round starts");

    for (let flap = 1; flap <= 3; flap += 1) {
      await waitFor(() => sockets.length === flap + 1, `replacement websocket ${flap}`);
      sockets[flap]?.emitOpen();
      await waitFor(() => readyOn(sockets[flap]), `ready after flap ${flap}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(catalogsOn(sockets[flap]).length, 0, `no new round inside the start interval (flap ${flap})`);
      sockets[flap]?.terminate();
    }

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("sanitizeCatalogModels caps entries, strips control characters and never rewrites ids", () => {
  const many = Array.from({ length: 350 }, (_, index) => ({ id: `m-${index}`, label: `M ${index}` }));
  assert.equal(sanitizeCatalogModels(many).length, 300);
  assert.deepEqual(sanitizeCatalogModels([
    { id: "gpt-5.6-sol", label: " GPT-5.6-Sol\u0007 " },
    { id: "no-label", label: "" },
    { id: "bad\nid", label: "Bad" },
    { id: "", label: "Empty id" },
    { id: "long", label: "x".repeat(200) },
  ]), [
    { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
    { id: "no-label", label: "no-label" },
    { id: "long", label: "x".repeat(80) },
  ]);
});

test("DaemonCore joins overlapping probes: two usage refreshes run the collector once and both requests get the snapshot", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-probe-gate-test-"));
  const sockets: FakeWebSocket[] = [];
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const snapshot: RuntimeAccountUsageSnapshot = {
    protocolVersion: 2,
    provider: "kimi",
    collectedAt: "2026-08-01T20:00:00.000Z",
    staleAfter: "2026-08-01T20:30:00.000Z",
    collectorVersion: "test",
    accounts: [],
  };
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    runtimeDetector: () => ({ ids: [], versions: {} }),
    runtimeAccountUsageCollector: async () => {
      calls += 1;
      await gate;
      return snapshot;
    },
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();
    for (const requestId of ["usage-overlap-1", "usage-overlap-2"]) {
      socket.emitServerMessage({ type: "machine:runtime_account_usage:refresh", requestId, provider: "kimi", reason: "stale_or_missing" });
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, "the second refresh joins the one already running");
    release();
    const snapshots = () => socket.sent.filter((message) => (message as { type?: string }).type === "machine:runtime_account_usage:snapshot");
    await waitFor(() => snapshots().length === 2, "both snapshots");
    assert.deepEqual(snapshots().map((message) => (message as { requestId?: string }).requestId).sort(), ["usage-overlap-1", "usage-overlap-2"]);
    assert.equal(calls, 1);
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore advertises machine-wide Computer controls only for supervisor-relay builds", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-computer-control-cap-test-"));
  const sockets: FakeWebSocket[] = [];
  let core: DaemonCore | null = null;

  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      onComputerControl: () => {},
      computerControlViaSupervisor: true,
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();
    const ready = socket.sent.find((msg): msg is Extract<MachineToServerMessage, { type: "ready" }> =>
      typeof msg === "object" && msg !== null && (msg as { type?: string }).type === "ready"
    );
    assert.equal(ready?.capabilities?.includes(COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS), true);

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore marks the connection before probing and recomputes ready after a 1006 during detection", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-ready-reconnect-test-"));
  const sockets: FakeWebSocket[] = [];
  const lifecycleEvents: string[] = [];
  let detectionCount = 0;
  let core: DaemonCore | null = null;

  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      lifecycleHooks: {
        onConnect: () => lifecycleEvents.push("connect"),
        onDisconnect: () => lifecycleEvents.push("disconnect"),
      },
      runtimeDetector: () => {
        detectionCount += 1;
        lifecycleEvents.push(`detect-${detectionCount}`);
        if (detectionCount === 1) sockets[0]?.terminate();
        return detectionCount === 1
          ? { ids: ["codex"], versions: {} as Record<string, string> }
          : { ids: ["claude"], versions: { claude: "2.1.0" } };
      },
      connectionOptions: {
        minReconnectDelayMs: 1,
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    sockets[0]?.emitOpen();
    await waitFor(() => sockets.length === 2, "replacement websocket after 1006");
    sockets[1]?.emitOpen();
    await waitFor(
      () => sockets[1]?.sent.some((message) => (message as { type?: string }).type === "ready") ?? false,
      "fresh ready after reconnect",
    );

    assert.deepEqual(lifecycleEvents.slice(0, 4), ["connect", "detect-1", "disconnect", "connect"]);
    assert.equal(lifecycleEvents[4], "detect-2");
    assert.equal(
      sockets[0]?.sent.some((message) => (message as { type?: string }).type === "ready"),
      false,
      "the disconnected socket must not retain a stale ready snapshot",
    );
    const ready = sockets[1]?.sent.find((message) => (message as { type?: string }).type === "ready") as
      | Extract<MachineToServerMessage, { type: "ready" }>
      | undefined;
    assert.deepEqual(ready?.runtimes, ["claude"], "reconnect must recompute current runtime inventory");
    assert.deepEqual(ready?.runtimeVersions, { claude: "2.1.0" }, "ready must carry the recomputed runtime version inventory");

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore reports restart completion only after the new generation sends ready", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-computer-restart-ready-test-"));
  const sockets: FakeWebSocket[] = [];
  let core: DaemonCore | null = null;

  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      onComputerRestartReconcile: (emitDone) => {
        emitDone({ requestId: "restart-1", ok: true });
      },
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    assert.equal(socket.sent.length, 0, "no terminal receipt before connect/ready");
    socket.emitOpen();
    await flush();

    const messages = socket.sent.filter(
      (msg): msg is MachineToServerMessage =>
        typeof msg === "object" && msg !== null && "type" in msg,
    );
    const types = messages.map((msg) => msg.type);
    assert.ok(types.indexOf("ready") >= 0);
    assert.ok(types.indexOf("computer:restart:done") > types.indexOf("ready"));
    assert.deepEqual(
      messages.find((msg) => msg.type === "computer:restart:done"),
      { type: "computer:restart:done", requestId: "restart-1", ok: true },
    );

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(predicate(), `timed out waiting for ${label}`);
}

test("snapshot-authorized scoped Reminder holds item and wake until Server acceptance", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-reminder-local-test-"));
  const dataDir = path.join(rootDir, "agents");
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const reminderClock = new FakeClock();
  const sockets: FakeWebSocket[] = [];
  const reminderId = "11111111-1111-4111-8111-111111111111";
  const legalLongMultilineTitle = `Local\n${"x".repeat(494)}`;
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    slockHome: rootDir,
    reminderClock,
    runtimeDetector: () => ({ ids: [], versions: {} }),
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
        appInboxForAgent: options?.appInboxForAgent,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig({ sessionId: "session-1" }),
      launchId: "launch-1",
    });
    await waitFor(() => driver.children.length === 1, "Reminder target Agent process");
    const child = driver.children[0]!;
    child.stdout.emit("data", Buffer.from("turn_end\n"));
    await flush();

    socket.emitServerMessage({
      type: "reminder.snapshot",
      agentId: "agent-1",
      reminders: [],
    });

    socket.emitServerMessage({
      type: "reminder.upsert",
      agentId: "agent-1",
      reminder: {
        reminderId,
        ownerAgentId: "agent-1",
        msgId: null,
        title: legalLongMultilineTitle,
        fireAt: new Date(10_000).toISOString(),
        version: 3,
        recurrence: null,
      },
    });
    assert.ok(socket.sent.some((message) =>
      (message as { type?: string }).type === "reminder.armed"
    ));

    // A local due timer is only a request. Losing transport cannot bypass the
    // Server clock/revision authority by minting a user-visible item.
    socket.readyState = 3;
    reminderClock.advanceBy(10_000);
    await flush();

    assert.equal(child.stdinWrites.some((chunk) => chunk.includes("App items pending: 1")), false);
    assert.equal(socket.sent.some((message) =>
      (message as { type?: string }).type === "reminder.fire_request"
    ), false, "offline request is retained in the durable outbox");

    const appInbox = driver.spawnCalls[0]?.agentAppInbox;
    assert.ok(appInbox, "Core passes its per-agent Inbox store to the matching runtime");
    assert.deepEqual(appInbox.list(), []);
    const mirror = JSON.parse(await readFile(
      path.join(
        rootDir,
        "app-storage",
        "v1",
        "machine-test",
        "server-test",
        "system.reminder",
        "agents",
        "agent-1",
        "state.json",
      ),
      "utf8",
    )) as {
      records: Array<{
        receipts: Array<{
          job: { ownerAgentId: string };
          serverAcked: boolean;
          wakeEnqueued: boolean;
          requestId: string;
        }>;
      }>;
    };
    assert.deepEqual(
      mirror.records.flatMap((record) =>
        record.receipts.map((receipt) => [
          receipt.job.ownerAgentId,
          receipt.serverAcked,
          receipt.wakeEnqueued,
          typeof receipt.requestId,
        ])
      ),
      [["agent-1", false, false, "string"]],
      "the durable request remains retryable without exposing an item",
    );
  } finally {
    await core.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("DaemonCore dispatches generic app-config into the built-in local App runtime", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-cleaner-core-dispatch-test-"));
  const dataDir = path.join(rootDir, "agents");
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const sockets: FakeWebSocket[] = [];
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    slockHome: rootDir,
    runtimeDetector: () => ({ ids: [], versions: {} }),
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
        appInboxForAgent: options?.appInboxForAgent,
      }),
  });

  try {
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-cleaner",
      config: makeConfig({ sessionId: "session-cleaner" }),
      launchId: "launch-cleaner",
    });
    await waitFor(() => driver.spawnCalls.length === 1, "Cleaner target Agent process");
    const inbox = driver.spawnCalls[0]?.agentAppInbox;
    assert.ok(inbox, "Core exposes its per-owner typed Inbox to the runtime");

    const input = {
      appId: CLEANER_APP_ID,
      notificationClass: CLEANER_NOTIFICATION_CLASS,
      sourceRef: { kind: "memory_hint", agentId: "agent-cleaner" },
    } as const;
    assert.equal(inbox.mint(input).ok, false, "action remains closed before config dispatch");

    socket.emitServerMessage({
      type: "app_config.upsert",
      agentId: "agent-cleaner",
      config: {
        appId: CLEANER_APP_ID,
        ownerAgentId: "agent-cleaner",
        revision: 4,
        effective: { ...CLEANER_CONFIG_DEFAULTS },
      },
    });

    const minted = inbox.mint(input);
    assert.equal(minted.ok, true, "Core dispatch must install the applied config action");
    if (minted.ok) {
      assert.equal(
        minted.item.actionCli,
        `raft app config --app ${CLEANER_APP_ID} --set threshold_bytes=${CLEANER_CONFIG_DEFAULTS.thresholdBytes * 2}`,
      );
    }
  } finally {
    await core.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("unarmable Reminder emits rejection and never claims armed", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-reminder-reject-test-"));
  const sockets: FakeWebSocket[] = [];
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir: path.join(rootDir, "agents"),
    slockHome: rootDir,
    reminderClock: new FakeClock(),
    runtimeDetector: () => ({ ids: [], versions: {} }),
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });
  try {
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    socket.emitServerMessage({
      type: "reminder.snapshot",
      agentId: "agent-1",
      reminders: [],
    });
    socket.emitServerMessage({
      type: "reminder.upsert",
      agentId: "agent-1",
      reminder: {
        reminderId: "22222222-2222-4222-8222-222222222222",
        ownerAgentId: "agent-1",
        msgId: null,
        title: "invalid local schedule",
        fireAt: "not-an-iso-date",
        version: 1,
        recurrence: null,
      },
    });
    assert.equal(socket.sent.some((message) => (message as { type?: string }).type === "reminder.armed"), false);
    assert.ok(socket.sent.some((message) =>
      (message as { type?: string; reason?: string }).type === "reminder.arm_rejected"
      && (message as { reason?: string }).reason === "invalid_fire_at"
    ));
  } finally {
    await core.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function withHttpServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : String(err));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

test("daemon credential-proxy trace contract preserves only typed cutover evidence", () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const scopedTracer = createTraceScopeTracer(tracer, {}, {
    spanAttrContracts: DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  });
  const span = scopedTracer.startSpan("daemon.agent_proxy.request", {
    surface: "daemon",
    kind: "client",
    attrs: {
      route_family: "tasks/claim",
      method: "POST",
      trace_context_state: "continued",
      proxy_launch_id_present: true,
      correlation_id: "0123456789abcdef",
      raw_url: "https://example.test/private?token=secret",
    },
  });
  span.end("error", {
    attrs: {
      outcome: "upstream_5xx",
      http_status: 503,
      normalized_code: "server_5xx",
      response_started: true,
      raw_error: "secret body",
    },
  });

  const [recorded] = traceRows(sink, traceId);
  assert.equal(recorded.attrs?.route_family, "tasks/claim");
  assert.equal(recorded.attrs?.method, "POST");
  assert.equal(recorded.attrs?.trace_context_state, "continued");
  assert.equal(recorded.attrs?.proxy_launch_id_present, true);
  assert.equal(recorded.attrs?.correlation_id, "0123456789abcdef");
  assert.equal(recorded.attrs?.outcome, "upstream_5xx");
  assert.equal(recorded.attrs?.http_status, 503);
  assert.equal(recorded.attrs?.normalized_code, "server_5xx");
  assert.equal(recorded.attrs?.response_started, true);
  assert.equal(recorded.attrs?.raw_url, undefined);
  assert.equal(recorded.attrs?.raw_error, undefined);
});

test("daemon start-dispatch receipt trace keeps only closed identity and queue evidence", () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const scopedTracer = createTraceScopeTracer(tracer, {}, {
    spanAttrContracts: DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  });
  const span = scopedTracer.startSpan("daemon.agent.start_dispatch.receipt", {
    surface: "daemon",
    kind: "consumer",
    attrs: {
      agent_id: "agent-1",
      launch_id: "launch-1",
      start_dispatch_id: "dispatch-1",
      queue_state: "queued",
      queue_depth: 2,
      queue_age_ms: 125,
      outcome: "accepted",
      raw_start_packet: "secret",
    },
  });
  span.end("ok");

  const [recorded] = traceRows(sink, traceId);
  assert.equal(recorded.attrs?.agent_id, "agent-1");
  assert.equal(recorded.attrs?.launch_id, "launch-1");
  assert.equal(recorded.attrs?.start_dispatch_id, "dispatch-1");
  assert.equal(recorded.attrs?.queue_state, "queued");
  assert.equal(recorded.attrs?.queue_depth, 2);
  assert.equal(recorded.attrs?.queue_age_ms, 125);
  assert.equal(recorded.attrs?.outcome, "accepted");
  assert.equal(recorded.attrs?.raw_start_packet, undefined);
});

test("daemon process-error trace keeps canonical process identity without raw failure state", () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const scopedTracer = createTraceScopeTracer(tracer, {}, {
    spanAttrContracts: DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  });
  const span = scopedTracer.startSpan("daemon.agent.process.error", {
    surface: "daemon",
    kind: "internal",
    attrs: {
      agent_id: "agent-1",
      server_id: "server-1",
      machine_id: "machine-1",
      launch_id: "launch-1",
      start_dispatch_id: "dispatch-1",
      process_instance_id: "process-1",
      session_id_present: true,
      runtime: "codex",
      runtime_version: "1.2.3",
      error_class: "Error",
      model: "private-model",
      session_id: "private-session",
      pid: 1234,
      error: "Bearer sk-private https://provider.example/private",
    },
  });
  span.end("error");

  const [recorded] = traceRows(sink, traceId);
  assert.equal(recorded.attrs?.agent_id, "agent-1");
  assert.equal(recorded.attrs?.server_id, "server-1");
  assert.equal(recorded.attrs?.machine_id, "machine-1");
  assert.equal(recorded.attrs?.launch_id, "launch-1");
  assert.equal(recorded.attrs?.start_dispatch_id, "dispatch-1");
  assert.equal(recorded.attrs?.process_instance_id, "process-1");
  assert.equal(recorded.attrs?.runtime, "codex");
  assert.equal(recorded.attrs?.runtime_version, "1.2.3");
  assert.equal(recorded.attrs?.error_class, "Error");
  assert.equal(recorded.attrs?.model, undefined);
  assert.equal(recorded.attrs?.session_id, undefined);
  assert.equal(recorded.attrs?.pid, undefined);
  assert.equal(recorded.attrs?.error, undefined);
});

test("daemon runtime-progress suppression trace contract preserves only idle-fence evidence", () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const scopedTracer = createTraceScopeTracer(tracer, {}, {
    spanAttrContracts: DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  });
  const span = scopedTracer.startSpan("daemon.runtime.progress.activity.suppressed", {
    surface: "daemon",
    kind: "internal",
    attrs: {
      agentId: "agent-1",
      launchId: "launch-1",
      runtime: "grok",
      outcome: "apm_idle",
      source: "grok_acp_notification",
      itemType: "_x.ai/queue/changed",
      payloadBytes: 42,
      raw_payload: "secret",
    },
  });
  span.end("ok");

  const [recorded] = traceRows(sink, traceId);
  assert.equal(recorded.attrs?.agentId, "agent-1");
  assert.equal(recorded.attrs?.launchId, "launch-1");
  assert.equal(recorded.attrs?.runtime, "grok");
  assert.equal(recorded.attrs?.outcome, "apm_idle");
  assert.equal(recorded.attrs?.source, "grok_acp_notification");
  assert.equal(recorded.attrs?.itemType, "_x.ai/queue/changed");
  assert.equal(recorded.attrs?.payloadBytes, 42);
  assert.equal(recorded.attrs?.raw_payload, undefined);
});

test("daemon Pi provider failure trace contract keeps only the closed-set diagnostic", () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const scopedTracer = createTraceScopeTracer(tracer, {}, {
    spanAttrContracts: DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  });
  const span = scopedTracer.startSpan("daemon.pi.prompt", {
    surface: "daemon",
    kind: "internal",
    attrs: {
      agentId: "agent-1",
      launchId: "launch-1",
      runtime: "builtin",
    },
  });
  span.addEvent("daemon.pi.provider_request.failed", {
    phase: "prompt_request",
    response_started: true,
    reason: "provider_auth_denied",
    http_status: 403,
    runtime_session_id_present: true,
    runtime_session_id: "session-1",
    launch_id_present: true,
    launch_id: "launch-1",
    body: "unsafe response body",
    headers: { authorization: "Bearer sk-unsafe-header" },
    token: "sk-unsafe-token",
    url: "https://gateway.example/private",
    payload: { prompt: "unsafe prompt" },
  });
  span.end("error");

  const [failure] = eventsForSpan(sink, traceId, "daemon.pi.prompt")
    .filter((event) => event.name === "daemon.pi.provider_request.failed");
  assert.equal(failure?.attrs?.phase, "prompt_request");
  assert.equal(failure?.attrs?.response_started, true);
  assert.equal(failure?.attrs?.reason, "provider_auth_denied");
  assert.equal(failure?.attrs?.http_status, 403);
  // #424: the flag was renamed into the same family as the value it describes,
  // and the bare id is gone (dropped by the sink, no hash form). The fixture
  // still supplies a raw `runtime_session_id` above, so this proves the contract
  // drops it rather than the fixture never providing one.
  assert.equal(failure?.attrs?.runtime_session_id, undefined);
  assert.equal(failure?.attrs?.runtime_session_id_present, true);
  assert.equal(failure?.attrs?.launch_id, "launch-1");
  assert.equal(failure?.attrs?.body, undefined);
  assert.equal(failure?.attrs?.headers, undefined);
  assert.equal(failure?.attrs?.token, undefined);
  assert.equal(failure?.attrs?.url, undefined);
  assert.equal(failure?.attrs?.payload, undefined);
});

test("daemon Built-in session trace contract keeps isolation evidence and drops raw secret/path attrs", () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const scopedTracer = createTraceScopeTracer(tracer, {}, {
    spanAttrContracts: DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  });

  const span = scopedTracer.startSpan("daemon.builtin.session.create", {
    surface: "daemon",
    kind: "internal",
    attrs: {
      agentId: "agent-1",
      launchId: "launch-1",
      runtime: "builtin",
      model: "openai/gpt-custom",
      session_id_present: true,
      requested_model: "openai/gpt-custom",
      config_source: "agent_config",
      host_user_state: "forbidden",
      provider_id: "openai-compatible",
      model_kind: "custom",
      base_url_present: true,
      base_url_host_class: "public",
      provider_key_present: true,
      provider_key_source: "runtime_config_plaintext",
      provider_env_key: "OPENAI_API_KEY",
      base_url_env_key: "OPENAI_BASE_URL",
      base_url_value: "https://gateway.example.test/v1",
      api_key_value: "sk-openai-test",
      raw_provider_payload: { apiKey: "sk-ds-test" },
      agent_dir_path: "/Users/local/.pi",
    },
  });
  span.addEvent("daemon.builtin.session.services_ready", {
    available_models_count: 1,
    diagnostics_count: 0,
    diagnostic_info_count: 0,
    diagnostic_warning_count: 0,
    agent_dir_source: "managed_builtin",
    config_source: "agent_config",
    host_user_state: "forbidden",
    provider_id: "openai-compatible",
    model_kind: "custom",
    base_url_present: true,
    base_url_host_class: "public",
    provider_key_present: true,
    provider_key_source: "runtime_config_plaintext",
    provider_env_key: "OPENAI_API_KEY",
    base_url_env_key: "OPENAI_BASE_URL",
    base_url_value: "https://gateway.example.test/v1",
    api_key_value: "sk-openai-test",
    raw_provider_payload: { apiKey: "sk-ds-test" },
    agent_dir_path: "/Users/local/.pi",
  });
  span.end("ok", {
    attrs: {
      outcome: "started",
      available_models_count: 1,
      diagnostics_count: 0,
      diagnostic_info_count: 0,
      diagnostic_warning_count: 0,
      requested_model: "openai/gpt-custom",
      resolved_model: "openai/gpt-custom",
      resolved_model_present: true,
      config_source: "agent_config",
      host_user_state: "forbidden",
      provider_id: "openai-compatible",
      model_kind: "custom",
      base_url_present: true,
      base_url_host_class: "public",
      provider_key_present: true,
      provider_key_source: "runtime_config_plaintext",
      provider_env_key: "OPENAI_API_KEY",
      base_url_env_key: "OPENAI_BASE_URL",
      base_url_value: "https://gateway.example.test/v1",
      api_key_value: "sk-openai-test",
      raw_provider_payload: { apiKey: "sk-ds-test" },
      agent_dir_path: "/Users/local/.pi",
    },
  });

  const recorded = traceRows(sink, traceId).find((candidate) => candidate.name === "daemon.builtin.session.create");
  assert.ok(recorded);
  assert.equal(recorded.attrs?.config_source, "agent_config");
  assert.equal(recorded.attrs?.host_user_state, "forbidden");
  assert.equal(recorded.attrs?.provider_id, "openai-compatible");
  assert.equal(recorded.attrs?.model_kind, "custom");
  assert.equal(recorded.attrs?.model_id, undefined);
  assert.equal(recorded.attrs?.base_url_present, true);
  assert.equal(recorded.attrs?.base_url_host_class, "public");
  assert.equal(recorded.attrs?.provider_key_present, true);
  assert.equal(recorded.attrs?.provider_key_source, "runtime_config_plaintext");
  assert.equal(recorded.attrs?.provider_env_key, undefined);
  assert.equal(recorded.attrs?.base_url_env_key, undefined);
  assert.equal(recorded.attrs?.base_url_value, undefined);
  assert.equal(recorded.attrs?.api_key_value, undefined);
  assert.equal(recorded.attrs?.raw_provider_payload, undefined);
  assert.equal(recorded.attrs?.agent_dir_path, undefined);

  const servicesReady = eventsForSpan(sink, traceId, "daemon.builtin.session.create")
    .find((event) => event.name === "daemon.builtin.session.services_ready");
  assert.equal(servicesReady?.attrs?.agent_dir_source, "managed_builtin");
  assert.equal(servicesReady?.attrs?.config_source, "agent_config");
  assert.equal(servicesReady?.attrs?.host_user_state, "forbidden");
  assert.equal(servicesReady?.attrs?.provider_id, "openai-compatible");
  assert.equal(servicesReady?.attrs?.model_kind, "custom");
  assert.equal(servicesReady?.attrs?.model_id, undefined);
  assert.equal(servicesReady?.attrs?.base_url_present, true);
  assert.equal(servicesReady?.attrs?.base_url_host_class, "public");
  assert.equal(servicesReady?.attrs?.provider_key_present, true);
  assert.equal(servicesReady?.attrs?.provider_key_source, "runtime_config_plaintext");
  assert.equal(servicesReady?.attrs?.provider_env_key, undefined);
  assert.equal(servicesReady?.attrs?.base_url_env_key, undefined);
  assert.equal(servicesReady?.attrs?.base_url_value, undefined);
  assert.equal(servicesReady?.attrs?.api_key_value, undefined);
  assert.equal(servicesReady?.attrs?.raw_provider_payload, undefined);
  assert.equal(servicesReady?.attrs?.agent_dir_path, undefined);

  assert.equal(recorded.status, "ok");
  assert.equal(recorded.attrs?.outcome, "started");
  assert.equal(recorded.attrs?.resolved_model, "openai/gpt-custom");
  assert.equal(recorded.attrs?.provider_env_key, undefined);
  assert.equal(recorded.attrs?.base_url_env_key, undefined);
  assert.equal(recorded.attrs?.base_url_value, undefined);
  assert.equal(recorded.attrs?.api_key_value, undefined);
  assert.equal(recorded.attrs?.raw_provider_payload, undefined);
  assert.equal(recorded.attrs?.agent_dir_path, undefined);
});

test("daemon object-store trace contract keeps closed diagnostics and drops secret, URL, and path attrs", () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const scopedTracer = createTraceScopeTracer(tracer, {}, {
    spanAttrContracts: DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  });

  const span = scopedTracer.startSpan("daemon.migration_transport.object_store", {
    surface: "daemon",
    kind: "internal",
    attrs: {
      outcome: "failed",
      role: "source",
      transfer_kind: "upload",
      migration_ref: "mig_AAAAAAAAAAAAAAAAAAAAAA",
      stage: "upload_complete",
      operation: "chunk_upload",
      agent_id_present: true,
      migration_id_present: true,
      session_id_present: true,
      error_class: "MigrationStepResponseError",
      error_code: "MIGRATION_UPLOAD_COMPLETE_FAILED",
      upstream_error_code: "migration_chunks_missing",
      http_status: 503,
      status: 503,
      url: "https://object-store.example.test/bundle?X-Amz-Signature=secret",
      signed_url: "https://object-store.example.test/bundle?token=secret",
      bearer_token: "raft-secret-token",
      bundle_path: "/tmp/raft-agent-migration-upload-secret/bundle.tar.gz",
      raw_response_body: "Migration chunks missing for private workspace /Users/alice",
      unknown_scalar: "must-not-survive",
    },
  });
  span.end("error");

  const recorded = traceRows(sink, traceId).find((candidate) =>
    candidate.name === "daemon.migration_transport.object_store"
  );
  assert.ok(recorded);
  assert.equal(recorded.attrs?.outcome, "failed");
  assert.equal(recorded.attrs?.role, "source");
  assert.equal(recorded.attrs?.transfer_kind, "upload");
  assert.equal(recorded.attrs?.migration_ref, "mig_AAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(recorded.attrs?.stage, "upload_complete");
  assert.equal(recorded.attrs?.operation, "chunk_upload");
  assert.equal(recorded.attrs?.migration_id_present, true);
  assert.equal(recorded.attrs?.error_class, "MigrationStepResponseError");
  assert.equal(recorded.attrs?.error_code, "MIGRATION_UPLOAD_COMPLETE_FAILED");
  assert.equal(recorded.attrs?.upstream_error_code, "migration_chunks_missing");
  assert.equal(recorded.attrs?.http_status, 503);
  assert.equal(recorded.attrs?.status, undefined);
  assert.equal(recorded.attrs?.url, undefined);
  assert.equal(recorded.attrs?.signed_url, undefined);
  assert.equal(recorded.attrs?.bearer_token, undefined);
  assert.equal(recorded.attrs?.bundle_path, undefined);
  assert.equal(recorded.attrs?.raw_response_body, undefined);
  assert.equal(recorded.attrs?.unknown_scalar, undefined);
});

async function captureUploadCompleteConflictTrace(responseBody: {
  code: string;
  error: string;
}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-upload-complete-trace-test-"));
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const sockets: FakeWebSocket[] = [];
  const migrationId = "migration-upload-complete-trace";
  const migrationRef = "mig_TRACEUPLOADCOMPLETEAAA";
  const transportGeneration = "transport-generation-upload-complete-trace";
  const leaseId = "lease-upload-complete-trace";
  const transportLostReports: Array<Record<string, unknown>> = [];
  const transferServer = await withHttpServer(async (req, res) => {
    if (
      req.method === "POST"
      && req.url === `/internal/computer/agent-migrations/by-id/${migrationId}/resumable/source-quiesced`
    ) {
      await readRequestBody(req);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (
      req.method === "POST"
      && req.url === `/internal/computer/agent-migrations/by-id/${migrationId}/resumable/control`
    ) {
      const body = JSON.parse((await readRequestBody(req)).toString("utf8")) as {
        control: Parameters<typeof validateAgentMigrationControlManifest>[0];
      };
      const validated = validateAgentMigrationControlManifest(body.control);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ controlSha256: validated.sha256 }));
      return;
    }
    if (
      req.method === "POST"
      && req.url?.startsWith(`/internal/computer/agent-migrations/by-id/${migrationId}/resumable/stream-chunks/`)
    ) {
      await readRequestBody(req);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, uploaded: true }));
      return;
    }
    if (
      req.method === "GET"
      && req.url?.startsWith(`/internal/computer/agent-migrations/by-id/${migrationId}/resumable/chunks?`)
    ) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        complete: true,
        migrationGeneration: transportGeneration,
        leaseId,
        chunks: [],
      }));
      return;
    }
    if (
      req.method === "POST"
      && req.url === `/internal/computer/agent-migrations/by-id/${migrationId}/resumable/upload-complete`
    ) {
      await readRequestBody(req);
      res.statusCode = 409;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(responseBody));
      return;
    }
    if (
      req.method === "POST"
      && req.url === `/internal/computer/agent-migrations/by-id/${migrationId}/transport-lost`
    ) {
      transportLostReports.push(
        JSON.parse((await readRequestBody(req)).toString("utf8")) as Record<string, unknown>,
      );
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  let core: DaemonCore | null = null;

  try {
    await mkdir(path.join(dataDir, "agent-upload-complete-trace"), { recursive: true });
    await writeFile(
      path.join(dataDir, "agent-upload-complete-trace", "notes.md"),
      "trace correlation sentinel\n",
    );
    core = new DaemonCore({
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: dataDir,
      tracer,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-upload-complete-trace",
      migrationId,
      migrationRef,
      migrationGeneration: `agent_migration:${migrationId}:7`,
      sessionId: "session-upload-complete-trace",
      provider: "object_store",
      leaseSource: "server",
      role: "source",
      transferKind: "upload",
      bearerToken: "source-token-must-not-enter-trace",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: `/internal/computer/agent-migrations/by-id/${migrationId}/resumable`,
      leaseId,
      transportGeneration,
      sourceMachineId: "source-machine-upload-complete-trace",
      targetMachineId: "target-machine-upload-complete-trace",
      expectedMigrationRevision: 7,
    });

    await waitFor(() => transportLostReports.length === 1, "typed upload-complete transport-loss report");
    await waitFor(
      () => {
        const spans = traceRows(sink, traceId);
        return spans.some((span) =>
          span.name === "daemon.migration_transport.object_store"
          && span.attrs?.outcome === "failed"
          && span.attrs?.stage === "upload_complete"
        ) && spans.some((span) =>
          span.name === "daemon.migration_transport.object_store"
          && span.attrs?.outcome === "transport_lost_reported"
        );
      },
      "correlated upload-complete failure trace spans",
    );
    const failedSpan = traceRows(sink, traceId).find((span) =>
      span.name === "daemon.migration_transport.object_store"
      && span.attrs?.outcome === "failed"
      && span.attrs?.stage === "upload_complete"
    );
    assert.ok(failedSpan, "upload-complete conflict must emit a correlated failed span");
    assert.equal(failedSpan.attrs?.migration_ref, migrationRef);
    assert.equal(failedSpan.attrs?.role, "source");
    assert.equal(failedSpan.attrs?.transfer_kind, "upload");
    assert.equal(failedSpan.attrs?.http_status, 409);

    const reportedSpan = traceRows(sink, traceId).find((span) =>
      span.name === "daemon.migration_transport.object_store"
      && span.attrs?.outcome === "transport_lost_reported"
    );
    assert.ok(reportedSpan);
    assert.equal(reportedSpan.attrs?.migration_ref, migrationRef);
    assert.equal(reportedSpan.attrs?.role, "source");
    assert.equal(reportedSpan.attrs?.stage, "transport_lost_report");
    assert.equal(reportedSpan.attrs?.upstream_error_code, undefined);
    const traceFamilyAttrs = traceRows(sink, traceId)
      .filter((span) => span.name.startsWith("daemon.migration_transport."))
      .map((span) => span.attrs ?? {});
    return {
      failedAttrs: failedSpan.attrs ?? {},
      transportLostReport: transportLostReports[0] ?? {},
      traceFamilyAttrs,
    };
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("DaemonCore traces an upload-complete conflict with a safe exact join and typed stage", async () => {
  const hostileValues = [
    "token=sk_live_trace_secret",
    "https://evil.example/trace-secret",
    "/Users/alice/private-workspace",
  ];
  const { failedAttrs, transportLostReport, traceFamilyAttrs } = await captureUploadCompleteConflictTrace({
    code: "not_a_migration_code",
    error: hostileValues.join(" "),
  });

  assert.equal(failedAttrs.error_code, "MIGRATION_UPLOAD_COMPLETE_FAILED");
  assert.equal(failedAttrs.upstream_error_code, "http_409");
  assert.equal(traceFamilyAttrs.length, 4, "transfer, lease, failure, and loss-report rows must all be covered");
  for (const attrs of traceFamilyAttrs) {
    assert.equal(attrs.migration_ref, "mig_TRACEUPLOADCOMPLETEAAA");
    assert.equal(attrs.role, "source");
  }
  const serializedDiagnostics = JSON.stringify({ traceFamilyAttrs, transportLostReport });
  for (const hostileValue of hostileValues) {
    assert.equal(
      serializedDiagnostics.includes(hostileValue),
      false,
      `failed diagnostics must not contain hostile value ${hostileValue}`,
    );
  }
});

test("DaemonCore preserves exact lowercase and uppercase typed migration response codes", async () => {
  for (const upstreamCode of ["migration_chunks_missing", "MIGRATION_LEASE_EXPIRED"]) {
    const { failedAttrs } = await captureUploadCompleteConflictTrace({
      code: upstreamCode,
      error: "this branch must not replace a typed code",
    });

    assert.equal(failedAttrs.upstream_error_code, upstreamCode);
    assert.equal(failedAttrs.http_status, 409);
    assert.notEqual(failedAttrs.upstream_error_code, "http_409");
  }
});

test("DaemonCore streams a source bundle: each chunk is recorded and uploaded before the control is registered", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-streamed-source-test-"));
  const sockets: FakeWebSocket[] = [];
  const migrationId = "migration-streamed-source";
  const transportGeneration = "transport-generation-streamed";
  const leaseId = "lease-streamed";
  const events: string[] = [];
  const recorded = new Map<number, { sizeBytes: number; sha256: string }>();
  const stored = new Map<number, Buffer>();
  let registeredControl: Parameters<typeof validateAgentMigrationControlManifest>[0] | null = null;
  const base = `/internal/computer/agent-migrations/by-id/${migrationId}/resumable`;
  const transferServer = await withHttpServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    const streamChunk = req.url?.match(new RegExp(`^${base}/stream-chunks/(\\d+)$`));
    if (req.method === "POST" && streamChunk) {
      const body = JSON.parse((await readRequestBody(req)).toString("utf8")) as {
        migrationGeneration: string;
        leaseId: string;
        sizeBytes: number;
        sha256: string;
      };
      assert.equal(body.migrationGeneration, transportGeneration);
      assert.equal(body.leaseId, leaseId);
      const index = Number(streamChunk[1]);
      recorded.set(index, { sizeBytes: body.sizeBytes, sha256: body.sha256 });
      events.push(`stream:${index}`);
      json(200, { ok: true, uploaded: false, url: `${transferServer.baseUrl}/object-store/chunk-${index}` });
      return;
    }
    const objectPut = req.url?.match(/^\/object-store\/chunk-(\d+)$/);
    if (req.method === "PUT" && objectPut) {
      const index = Number(objectPut[1]);
      stored.set(index, await readRequestBody(req));
      events.push(`put:${index}`);
      res.statusCode = 200;
      res.setHeader("ETag", `"etag-${index}"`);
      res.end();
      return;
    }
    const receipt = req.url?.match(new RegExp(`^${base}/chunks/(\\d+)/receipt$`));
    if (req.method === "POST" && receipt) {
      const body = JSON.parse((await readRequestBody(req)).toString("utf8")) as { role: string; etag?: string };
      assert.equal(body.role, "source");
      events.push(`receipt:${receipt[1]}:${body.etag ?? ""}`);
      json(200, { ok: true, outcome: "recorded" });
      return;
    }
    if (req.method === "POST" && req.url === `${base}/control`) {
      const body = JSON.parse((await readRequestBody(req)).toString("utf8")) as {
        control: Parameters<typeof validateAgentMigrationControlManifest>[0];
      };
      registeredControl = body.control;
      events.push("control");
      json(200, { controlSha256: validateAgentMigrationControlManifest(body.control).sha256 });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith(`${base}/chunks?`)) {
      json(200, { complete: true, migrationGeneration: transportGeneration, leaseId, chunks: [] });
      return;
    }
    if (req.method === "POST" && req.url === `${base}/upload-complete`) {
      await readRequestBody(req);
      events.push("complete");
      json(200, { ok: true, state: "ready" });
      return;
    }
    if (req.method === "POST" && (req.url === `${base}/source-quiesced` || req.url === `${base}/source-progress`)) {
      await readRequestBody(req);
      json(200, { ok: true });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  let core: DaemonCore | null = null;
  try {
    await mkdir(path.join(dataDir, "agent-streamed"), { recursive: true });
    await writeFile(path.join(dataDir, "agent-streamed", "MEMORY.md"), "streamed source\n");
    await writeFile(path.join(dataDir, "agent-streamed", "payload.bin"), randomBytes(200_000));
    core = new DaemonCore({
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-streamed",
      migrationId,
      migrationRef: "mig_STREAMEDSOURCEAAAAAAAA",
      migrationGeneration: `agent_migration:${migrationId}:7`,
      sessionId: "session-streamed",
      provider: "object_store",
      leaseSource: "server",
      role: "source",
      transferKind: "upload",
      bearerToken: "source-token",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: base,
      leaseId,
      transportGeneration,
      sourceMachineId: "source-machine-streamed",
      targetMachineId: "target-machine-streamed",
      expectedMigrationRevision: 7,
    });

    await waitFor(() => events.includes("complete"), "streamed upload completes");
    assert.deepEqual(events, ["stream:0", "put:0", 'receipt:0:"etag-0"', "control", "complete"]);
    assert.ok(registeredControl);
    const control = registeredControl as Parameters<typeof validateAgentMigrationControlManifest>[0];
    assert.equal(control.archive.entryCount, 2);
    assert.deepEqual(recorded.get(0), {
      sizeBytes: control.bundle.chunks[0]!.sizeBytes,
      sha256: control.bundle.chunks[0]!.sha256,
    });
    assert.equal(createHash("sha256").update(stored.get(0)!).digest("hex"), control.bundle.chunks[0]!.sha256);
    assert.equal(
      existsSync(path.join(dataDir, "migrations")) ? (await readdir(path.join(dataDir, "migrations"), { recursive: true })).some((name) => String(name).endsWith("bundle.tar.gz")) : false,
      false,
      "a streamed bundle is never written to disk",
    );
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore downloads target chunks three at a time, imports the bundle and drives start-transfer, flip-machine and arrived by migration id", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-target-import-test-"));
  const sourceWorkspace = path.join(dataDir, "source-workspace");
  const sockets: FakeWebSocket[] = [];
  const agentId = "agent-target-import";
  const migrationId = "migration-target-import";
  const migrationRef = "mig_TARGETIMPORTAAAAAAAAAA";
  const migrationGeneration = `agent_migration:${migrationId}:7`;
  const transportGeneration = "transport-generation-target-import";
  const leaseId = "lease-target-import";
  const base = `/internal/computer/agent-migrations/by-id/${migrationId}/resumable`;
  const byId = `/internal/computer/agent-migrations/by-id/${migrationId}`;
  await mkdir(sourceWorkspace, { recursive: true });
  await writeFile(path.join(sourceWorkspace, "MEMORY.md"), "arrived on target\n");
  // Incompressible, so the bundle spans several 1 MiB chunks.
  await writeFile(path.join(sourceWorkspace, "payload.bin"), randomBytes(5 * 1024 * 1024));
  const chunks = new Map<number, Buffer>();
  const bundle = await streamAgentMigrationResumableBundle({
    agentId,
    migrationId,
    migrationGeneration: transportGeneration,
    leaseId,
    sourceMachineId: "source-machine-target-import",
    targetMachineId: "target-machine-target-import",
    workspacePath: sourceWorkspace,
    maxBytes: 104857600,
    chunkSizeBytes: 1024 * 1024,
    async uploadChunk(chunk, bytes) {
      chunks.set(chunk.index, Buffer.from(bytes));
    },
  });
  assert.ok(bundle.control.bundle.chunks.length >= 5);
  const receipted = new Set<number>();
  let downloadsInFlight = 0;
  let maxDownloadsInFlight = 0;
  const steps: Array<{ step: string; body: Record<string, unknown> }> = [];
  const view = (state: string) => ({
    migrationId,
    migrationRef,
    migrationGeneration,
    state,
    sourceMachineId: "source-machine-target-import",
    targetMachineId: "target-machine-target-import",
    agentId,
    manifestPath: null,
    manifestSha256: null,
    canDriveTargetImport: true,
  });
  const stepStates: Record<string, string> = { "start-transfer": "in_transit", "flip-machine": "in_transit", arrived: "arrived" };
  const transferServer = await withHttpServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url?.startsWith(`${base}/control?`)) {
      json(200, { control: bundle.control, controlSha256: bundle.controlSha256, uploadComplete: true });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith(`${base}/chunks?`)) {
      const missing = bundle.control.bundle.chunks.filter((chunk) => !receipted.has(chunk.index));
      json(200, {
        complete: missing.length === 0,
        migrationGeneration: transportGeneration,
        leaseId,
        chunks: missing.map((chunk) => ({
          index: chunk.index,
          sizeBytes: chunk.sizeBytes,
          sha256: chunk.sha256,
          method: "GET",
          url: `${transferServer.baseUrl}/object-store/chunk-${chunk.index}`,
        })),
      });
      return;
    }
    const objectGet = req.url?.match(/^\/object-store\/chunk-(\d+)$/);
    if (req.method === "GET" && objectGet) {
      downloadsInFlight += 1;
      maxDownloadsInFlight = Math.max(maxDownloadsInFlight, downloadsInFlight);
      await new Promise((resolve) => setTimeout(resolve, 50));
      downloadsInFlight -= 1;
      res.statusCode = 200;
      res.end(chunks.get(Number(objectGet[1])));
      return;
    }
    const receipt = req.url?.match(new RegExp(`^${base}/chunks/(\\d+)/receipt$`));
    if (req.method === "POST" && receipt) {
      const body = JSON.parse((await readRequestBody(req)).toString("utf8")) as { role: string };
      assert.equal(body.role, "target");
      receipted.add(Number(receipt[1]));
      json(200, { ok: true, outcome: "recorded" });
      return;
    }
    if (req.method === "GET" && req.url === byId) {
      json(200, { migration: view("ready") });
      return;
    }
    const step = req.url?.startsWith(`${byId}/`) ? req.url.slice(byId.length + 1) : null;
    if (req.method === "POST" && step && step in stepStates) {
      steps.push({ step, body: JSON.parse((await readRequestBody(req)).toString("utf8")) as Record<string, unknown> });
      json(200, { migration: view(stepStates[step]!) });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  const { sink, tracer } = makeDeterministicTracer();
  let core: DaemonCore | null = null;
  try {
    core = new DaemonCore({
      tracer,
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId,
      migrationId,
      migrationRef,
      migrationGeneration,
      sessionId: "session-target-import",
      provider: "object_store",
      leaseSource: "server",
      role: "target",
      transferKind: "download",
      bearerToken: "target-token",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: base,
      leaseId,
      transportGeneration,
      sourceMachineId: "source-machine-target-import",
      targetMachineId: "target-machine-target-import",
      expectedMigrationRevision: 7,
    });

    await waitFor(() => steps.some((entry) => entry.step === "arrived"), "target import reports arrival");
    assert.deepEqual(steps.map((entry) => entry.step), ["start-transfer", "flip-machine", "arrived"]);
    assert.deepEqual(steps.map((entry) => entry.body.migrationGeneration), [migrationGeneration, migrationGeneration, migrationGeneration]);
    assert.equal(typeof steps[2]!.body.reportSha256, "string");
    assert.equal(await readFile(path.join(dataDir, agentId, "MEMORY.md"), "utf8"), "arrived on target\n");
    assert.equal(receipted.size, bundle.control.bundle.chunks.length);
    assert.equal(maxDownloadsInFlight, 3, "chunks download three at a time");

    // The transfer span ends after the arrival request returns.
    await waitFor(
      () => traceRows(sink).some((row) => row.name === "daemon.migration_transport.transfer"),
      "transfer span ends",
    );
    const rows = traceRows(sink);
    const transfer = rows.find((row) => row.name === "daemon.migration_transport.transfer");
    assert.ok(transfer);
    assert.equal(transfer.attrs?.download_concurrency, 3);
    const placement = rows.filter((row) => row.name === "daemon.migration_transport.placement");
    assert.deepEqual(placement.map((row) => row.attrs?.stage), ["verify", "unpack", "commit"]);
    for (const row of placement) {
      assert.equal(row.context.parentSpanId, transfer.context.spanId, "each local step is a child of the transfer span");
      assert.equal(row.status, "ok");
      assert.equal(row.attrs?.migration_ref, migrationRef);
      assert.equal(row.attrs?.role, "target");
      assert.equal(row.attrs?.chunk_count, bundle.control.bundle.chunks.length);
      assert.equal(row.attrs?.file_count, 2);
      assert.equal(row.attrs?.expanded_bytes, bundle.control.archive.expandedBytes);
    }
    const timing = rows.filter((row) =>
      row.name === "daemon.migration_transport.resumable"
      && (row.attrs?.outcome === "control_received" || row.attrs?.outcome === "chunks_downloaded"));
    assert.deepEqual(
      timing.map((row) => [row.attrs?.stage, row.attrs?.outcome]),
      [["control_wait", "control_received"], ["chunk_download", "chunks_downloaded"]],
      "control wait and download are timed on the target's own clock, in order",
    );
    for (const row of timing) {
      assert.equal(row.context.parentSpanId, transfer.context.spanId, "timing events attach to the transfer span");
      assert.equal(row.attrs?.chunk_count, bundle.control.bundle.chunks.length);
      assert.equal(typeof row.attrs?.duration_ms, "number");
      assert.ok((row.attrs?.duration_ms as number) >= 0);
    }

    // Arrived and flipped: the compressed workspace copy is gone, the report stays.
    const committed = rows.find((row) =>
      row.name === "daemon.migration_transport.resumable" && row.attrs?.outcome === "committed");
    assert.equal(committed?.attrs?.chunks_removed, true);
    assert.equal(
      committed?.attrs?.chunks_freed_bytes,
      bundle.control.bundle.chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0),
    );
    const leftover = (await readdir(path.join(dataDir, "migrations"), { recursive: true }))
      .map((entry) => path.basename(String(entry)));
    assert.ok(leftover.includes("arrival-report-v2.json"));
    assert.ok(!leftover.some((name) => name === "chunks" || name.endsWith(".chunk") || name.startsWith("extracting-")));
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore preserves the exact transfer-summary conflict in the typed failure trace", async () => {
  const { failedAttrs } = await captureUploadCompleteConflictTrace({
    code: "MIGRATION_TRANSFER_SUMMARY_CONFLICT",
    error: "transfer summary does not match the control manifest",
  });

  assert.equal(failedAttrs.error_code, "MIGRATION_TRANSFER_SUMMARY_CONFLICT");
  assert.equal(failedAttrs.upstream_error_code, "MIGRATION_TRANSFER_SUMMARY_CONFLICT");
  assert.equal(failedAttrs.http_status, 409);
});

test("DaemonCore keeps the resumable typed failure projection closed", async () => {
  const { failedAttrs } = await captureUploadCompleteConflictTrace({
    code: "MIGRATION_PRIVATE_DRIVER_FAILURE",
    error: "private implementation detail must remain outside the typed projection",
  });

  assert.equal(failedAttrs.error_code, "MIGRATION_UPLOAD_COMPLETE_FAILED");
  assert.equal(failedAttrs.upstream_error_code, "MIGRATION_PRIVATE_DRIVER_FAILURE");
  assert.equal(failedAttrs.http_status, 409);
});

test("DaemonCore keeps migration ref and role exact when one Computer switches from source A to target B", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-trace-role-switch-test-"));
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const sockets: FakeWebSocket[] = [];
  const transportLostUrls: string[] = [];
  const transferServer = await withHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url?.endsWith("/transport-lost")) {
      await readRequestBody(req);
      transportLostUrls.push(req.url);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 400;
    res.end("invalid test transfer");
  });
  let core: DaemonCore | null = null;

  try {
    core = new DaemonCore({
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: dataDir,
      tracer,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();

    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-role-switch",
      migrationId: "migration-a",
      migrationRef: "mig_SOURCEAAAAAAAAAAAAAAAA",
      migrationGeneration: "agent_migration:migration-a:1",
      sessionId: "session-a",
      provider: "object_store",
      leaseSource: "server",
      role: "source",
      transferKind: "upload",
      bearerToken: "source-token-not-traced",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: "/internal/computer/agent-migrations/by-id/migration-a/resumable",
      leaseId: "lease-a",
      transportGeneration: "transport-generation-a",
      sourceMachineId: "source-machine-a",
      targetMachineId: "target-machine-a",
      expectedMigrationRevision: 1,
    });
    await waitFor(
      () => traceRows(sink, traceId).filter((span) =>
        span.name === "daemon.migration_transport.lease" && span.attrs?.outcome === "applied"
      ).length === 1,
      "source A lease trace",
    );

    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-role-switch",
      migrationId: "migration-b",
      migrationRef: "mig_TARGETBBBBBBBBBBBBBBBB",
      migrationGeneration: "agent_migration:migration-b:1",
      sessionId: "session-b",
      provider: "object_store",
      leaseSource: "server",
      role: "target",
      transferKind: "download",
      bearerToken: "target-token-not-traced",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: "/internal/computer/agent-migrations/by-id/migration-b/resumable",
      leaseId: "lease-b",
      transportGeneration: "transport-generation-b",
      sourceMachineId: "source-machine-b",
      targetMachineId: "target-machine-b",
      expectedMigrationRevision: 1,
    });
    await waitFor(
      () => traceRows(sink, traceId).filter((span) =>
        span.name === "daemon.migration_transport.lease" && span.attrs?.outcome === "applied"
      ).length === 2,
      "target B lease trace",
    );
    await waitFor(
      () => transportLostUrls.some((url) => url.includes("/by-id/migration-b/transport-lost")),
      "target B transport-loss completion",
    );

    const appliedLeaseTuples = traceRows(sink, traceId)
      .filter((span) => span.name === "daemon.migration_transport.lease" && span.attrs?.outcome === "applied")
      .map((span) => ({
        migrationRef: span.attrs?.migration_ref,
        role: span.attrs?.role,
        transferKind: span.attrs?.transfer_kind,
      }));
    assert.deepEqual(appliedLeaseTuples, [
      {
        migrationRef: "mig_SOURCEAAAAAAAAAAAAAAAA",
        role: "source",
        transferKind: "upload",
      },
      {
        migrationRef: "mig_TARGETBBBBBBBBBBBBBBBB",
        role: "target",
        transferKind: "download",
      },
    ]);
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("resolveRaftCliPath prefers bundled dist cli when present", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-cli-path-test-"));

  try {
    const daemonDistDir = path.join(tmp, "packages", "daemon", "dist");
    const bundledCliPath = path.join(daemonDistDir, "cli", "index.js");
    await mkdir(path.dirname(bundledCliPath), { recursive: true });
    await writeFile(bundledCliPath, "export {};\n", "utf8");

    const moduleUrl = new URL(`file://${path.join(daemonDistDir, "core.js")}`).href;
    assert.equal(resolveRaftCliPath(moduleUrl), bundledCliPath);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("detectRuntimes treats driver probe unavailable as authoritative", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "slock-runtime-detect-test-"));
  const binDir = path.join(tmp, "bin");
  const oldPath = process.env.PATH;
  const { sink, tracer, traceId } = makeDeterministicTracer();

  try {
    await mkdir(binDir, { recursive: true });
    const opencodeBin = path.join(binDir, "opencode");
    await writeFile(opencodeBin, "#!/bin/sh\necho '1.14.20'\n", "utf8");
    await chmod(opencodeBin, 0o755);

    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    const detection = detectRuntimes(tracer);

    assert.equal(detection.ids.includes("opencode"), false);
    assert.match(detection.versions.opencode ?? "", /requires >= 1\.14\.30/);
    const span = traceRows(sink, traceId).find((candidate) => candidate.name === "daemon.runtime.detect");
    assert.equal(span?.attrs?.known_runtime_count, 12);
    assert.equal(span?.attrs?.detected_runtime_count, detection.ids.length);
    const opencodeEvent = eventsForSpan(sink, traceId, "daemon.runtime.detect")
      .find((event) => event.attrs?.runtime === "opencode");
    assert.equal(opencodeEvent?.attrs?.outcome, "unavailable");
    assert.equal(opencodeEvent?.attrs?.version_present, true);
    assert.equal(opencodeEvent?.attrs?.binary_path_present, false);
  } finally {
    if (oldPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = oldPath;
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test("DaemonCore scopes daemon traces with daemon and computer versions", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-trace-scope-test-"));
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const oldComputerVersion = process.env.RAFT_COMPUTER_VERSION;
  let core: DaemonCore | null = null;

  try {
    process.env.RAFT_COMPUTER_VERSION = "77.7.7-env-must-not-win";
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      daemonVersion: "0.55.6",
      computerVersion: "0.0.23",
      dataDir,
      tracer,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    const readySpan = traceRows(sink, traceId).find((span) => span.name === "daemon.ready.sent");
    assert.ok(readySpan);
    assert.equal(readySpan.attrs?.daemon_version, "0.55.6");
    assert.equal(readySpan.attrs?.daemon_version_present, true);
    assert.equal(readySpan.attrs?.computer_version, "0.0.23");
    assert.equal(readySpan.attrs?.computer_version_present, true);

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    if (oldComputerVersion === undefined) {
      delete process.env.RAFT_COMPUTER_VERSION;
    } else {
      process.env.RAFT_COMPUTER_VERSION = oldComputerVersion;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore sends a machine shutdown notice before disconnecting", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-shutdown-notice-test-"));
  const sockets: FakeWebSocket[] = [];
  const oldComputerVersion = process.env.RAFT_COMPUTER_VERSION;
  let core: DaemonCore | null = null;

  try {
    process.env.RAFT_COMPUTER_VERSION = "77.7.7-env-must-not-win";
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      computerVersion: "0.0.23",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    await core.stop();
    core = null;

    const shutdownNotice = socket.sent.find((message) =>
      typeof message === "object"
      && message !== null
      && (message as { type?: unknown }).type === "machine:shutdown"
    ) as { type: "machine:shutdown"; reason: string } | undefined;
    assert.deepEqual(shutdownNotice, { type: "machine:shutdown", reason: "computer_stop" });
    assert.equal(socket.readyState, 3);
  } finally {
    if (core) await core.stop();
    if (oldComputerVersion === undefined) {
      delete process.env.RAFT_COMPUTER_VERSION;
    } else {
      process.env.RAFT_COMPUTER_VERSION = oldComputerVersion;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore replays durable lifecycle acknowledgements and receipts phases independently", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-lifecycle-ack-test-"));
  const sockets: FakeWebSocket[] = [];
  const receipts: Array<{ operationId: string; phase: string }> = [];
  let resolveReceipt!: () => void;
  const receiptObserved = new Promise<void>((resolve) => { resolveReceipt = resolve; });
  let core: DaemonCore | null = null;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      getComputerLifecycleAcks: () => [
        { operationId: "11111111-1111-4111-8111-111111111111", action: "restart", phase: "shutdown" },
        { operationId: "11111111-1111-4111-8111-111111111111", action: "restart", phase: "ready", loadedComputerVersion: "0.72.6" },
      ],
      onComputerLifecycleReceipt: (operationId, phase) => {
        receipts.push({ operationId, phase });
        resolveReceipt();
      },
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    const ready = socket.sent.find((message) => (message as { type?: string }).type === "ready") as {
      lifecycleAcks?: unknown[];
    };
    assert.equal(ready.lifecycleAcks?.length, 2);

    socket.emitServerMessage({
      type: "computer:lifecycle:receipt",
      operationId: "11111111-1111-4111-8111-111111111111",
      phase: "ready",
    });
    await receiptObserved;
    assert.deepEqual(receipts, [{
      operationId: "11111111-1111-4111-8111-111111111111",
      phase: "ready",
    }]);

    await core.stop();
    core = null;
    const shutdown = socket.sent.find((message) => (message as { type?: string }).type === "machine:shutdown") as {
      lifecycleAcks?: Array<{ phase: string }>;
    };
    assert.deepEqual(shutdown.lifecycleAcks?.map((ack) => ack.phase), ["shutdown"]);
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore awaits fresh ready attestation instead of emitting cached lifecycle evidence", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-fresh-ready-ack-test-"));
  const sockets: FakeWebSocket[] = [];
  let releaseAttestation!: (acks: ComputerLifecycleExecutionAck[]) => void;
  const attested = new Promise<ComputerLifecycleExecutionAck[]>((resolve) => { releaseAttestation = resolve; });
  let core: DaemonCore | null = null;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      getComputerLifecycleAcks: () => [{
        operationId: "11111111-1111-4111-8111-111111111111",
        action: "upgrade",
        phase: "ready",
        loadedComputerVersion: "stale",
      }],
      getComputerLifecycleReadyAcks: () => attested,
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    assert.equal(socket.sent.some((message) => (message as { type?: string }).type === "ready"), false);

    releaseAttestation([{
      operationId: "11111111-1111-4111-8111-111111111111",
      action: "upgrade",
      phase: "ready",
      loadedComputerVersion: "0.72.9",
      serviceGeneration: "fresh-generation",
      managedSetRevision: "fresh-revision",
      oldProcessIdentitiesDead: true,
      deadProcessIdentities: ["service:old"],
    }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const ready = socket.sent.find((message) => (message as { type?: string }).type === "ready") as {
      lifecycleAcks?: Array<{ loadedComputerVersion?: string; serviceGeneration?: string }>;
    };
    assert.deepEqual(ready.lifecycleAcks, [{
      operationId: "11111111-1111-4111-8111-111111111111",
      action: "upgrade",
      phase: "ready",
      loadedComputerVersion: "0.72.9",
      serviceGeneration: "fresh-generation",
      managedSetRevision: "fresh-revision",
      oldProcessIdentitiesDead: true,
      deadProcessIdentities: ["service:old"],
    }]);
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore establishes online before legacy adoption and replays ready with the new exact acknowledgements", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-lifecycle-origin-adoption-test-"));
  const sockets: FakeWebSocket[] = [];
  const operationId = "11111111-1111-4111-8111-111111111111";
  let lifecycleAcks: ComputerLifecycleExecutionAck[] = [];
  let core: DaemonCore | null = null;
  let reconcileCalls = 0;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      getComputerLifecycleReadyAcks: async () => lifecycleAcks,
      reconcileComputerLifecycleOrigin: async () => {
        reconcileCalls += 1;
        const readyBeforeAdoption = sockets[0]!.sent.filter((message) =>
          (message as { type?: string }).type === "ready"
        );
        assert.equal(readyBeforeAdoption.length, 1, "ordinary ready must establish online first");
        assert.deepEqual(
          (readyBeforeAdoption[0] as { lifecycleAcks?: unknown[] }).lifecycleAcks,
          [],
          "the first ready must not fabricate the legacy receipt",
        );
        lifecycleAcks = [
          { operationId, action: "upgrade", phase: "shutdown" },
          {
            operationId,
            action: "upgrade",
            phase: "ready",
            loadedComputerVersion: "1.0.17",
            serviceGeneration: "generation-new",
            managedSetRevision: "revision-new",
            oldProcessIdentitiesDead: true,
            deadProcessIdentities: ["service:5500", "runner:server-test:5555"],
          },
        ];
        return true;
      },
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    sockets[0]!.emitOpen();
    await waitFor(
      () => sockets[0]!.sent.filter((message) => (message as { type?: string }).type === "ready").length === 2,
      "post-adoption ready replay",
    );
    const ready = sockets[0]!.sent.filter((message) =>
      (message as { type?: string }).type === "ready"
    ) as Array<{ lifecycleAcks?: ComputerLifecycleExecutionAck[] }>;
    assert.equal(reconcileCalls, 1);
    assert.deepEqual(ready[1]?.lifecycleAcks, lifecycleAcks);
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore retries one exact legacy adoption after ready visibility and replays the accepted acknowledgements", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-lifecycle-origin-retry-test-"));
  const sockets: FakeWebSocket[] = [];
  const clock = new FakeClock();
  const operationId = "11111111-1111-4111-8111-111111111111";
  let lifecycleAcks: ComputerLifecycleExecutionAck[] = [];
  let core: DaemonCore | null = null;
  let reconcileCalls = 0;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      getComputerLifecycleReadyAcks: async () => lifecycleAcks,
      reconcileComputerLifecycleOrigin: async () => {
        reconcileCalls += 1;
        if (reconcileCalls === 1) {
          return {
            status: "retryable_ready_pending",
            operationId,
            code: "computer_lifecycle_completion_ready_pending",
          };
        }
        lifecycleAcks = [
          { operationId, action: "upgrade", phase: "shutdown" },
          {
            operationId,
            action: "upgrade",
            phase: "ready",
            loadedComputerVersion: "1.0.17",
            serviceGeneration: "generation-new",
            managedSetRevision: "revision-new",
            oldProcessIdentitiesDead: true,
            deadProcessIdentities: ["service:5500", "runner:server-test:5555"],
          },
        ];
        return { status: "adopted", operationId };
      },
      connectionOptions: {
        clock,
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    sockets[0]!.emitOpen();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reconcileCalls, 1);
    assert.equal(sockets[0]!.sent.filter((message) => (message as { type?: string }).type === "ready").length, 1);

    clock.advanceBy(50);
    await waitFor(() => reconcileCalls === 2, "same-epoch lifecycle-origin retry");
    await waitFor(
      () => sockets[0]!.sent.filter((message) => (message as { type?: string }).type === "ready").length === 2,
      "post-retry adoption ready replay",
    );
    const ready = sockets[0]!.sent.filter((message) =>
      (message as { type?: string }).type === "ready"
    ) as Array<{ lifecycleAcks?: ComputerLifecycleExecutionAck[] }>;
    assert.deepEqual(ready[1]?.lifecycleAcks, lifecycleAcks);
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore stops a ready-pending legacy adoption when the exact operation identity drifts", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-lifecycle-origin-identity-drift-test-"));
  const sockets: FakeWebSocket[] = [];
  const clock = new FakeClock();
  const operationIdA = "11111111-1111-4111-8111-111111111111";
  const operationIdB = "22222222-2222-4222-8222-222222222222";
  let core: DaemonCore | null = null;
  let reconcileCalls = 0;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      getComputerLifecycleReadyAcks: async () => [
        { operationId: operationIdB, action: "upgrade", phase: "shutdown" },
        {
          operationId: operationIdB,
          action: "upgrade",
          phase: "ready",
          loadedComputerVersion: "1.0.17",
          serviceGeneration: "generation-new",
          managedSetRevision: "revision-new",
          oldProcessIdentitiesDead: true,
          deadProcessIdentities: ["service:5500", "runner:server-test:5555"],
        },
      ],
      reconcileComputerLifecycleOrigin: async () => {
        reconcileCalls += 1;
        if (reconcileCalls === 1) {
          return {
            status: "retryable_ready_pending",
            operationId: operationIdA,
            code: "computer_lifecycle_completion_ready_pending",
          };
        }
        return { status: "adopted", operationId: operationIdB };
      },
      connectionOptions: {
        clock,
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    sockets[0]!.emitOpen();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reconcileCalls, 1);
    assert.equal(sockets[0]!.sent.filter((message) => (message as { type?: string }).type === "ready").length, 1);

    clock.advanceBy(50);
    await waitFor(() => reconcileCalls === 2, "operation-identity drift retry");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      sockets[0]!.sent.filter((message) => (message as { type?: string }).type === "ready").length,
      1,
      "an adopted result for a different K operation must not emit a second ready/ack",
    );

    clock.advanceBy(5_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reconcileCalls, 2, "operation identity drift must terminally stop the retry chain");
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore bounds persistent ready-pending legacy adoption at three exact attempts", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-lifecycle-origin-bound-test-"));
  const sockets: FakeWebSocket[] = [];
  const clock = new FakeClock();
  const operationId = "11111111-1111-4111-8111-111111111111";
  let core: DaemonCore | null = null;
  let reconcileCalls = 0;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      reconcileComputerLifecycleOrigin: async () => {
        reconcileCalls += 1;
        return { status: "retryable_ready_pending", operationId, code: "computer_offline" };
      },
      connectionOptions: {
        clock,
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    sockets[0]!.emitOpen();
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      clock.advanceBy(50);
      await waitFor(() => reconcileCalls === attempt, `legacy adoption attempt ${attempt}`);
    }
    clock.advanceBy(5_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reconcileCalls, 3);
    assert.equal(sockets[0]!.sent.filter((message) => (message as { type?: string }).type === "ready").length, 1);
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore cancels a ready-pending legacy adoption retry when its connection generation closes", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-lifecycle-origin-disconnect-test-"));
  const sockets: FakeWebSocket[] = [];
  const clock = new FakeClock();
  let core: DaemonCore | null = null;
  let reconcileCalls = 0;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      reconcileComputerLifecycleOrigin: async () => {
        reconcileCalls += 1;
        return {
          status: "retryable_ready_pending",
          operationId: "11111111-1111-4111-8111-111111111111",
          code: "computer_offline",
        };
      },
      connectionOptions: {
        clock,
        minReconnectDelayMs: 10_000,
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    sockets[0]!.emitOpen();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reconcileCalls, 1);
    sockets[0]!.terminate();
    clock.advanceBy(5_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reconcileCalls, 1);
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore does not retry a permanent legacy adoption rejection", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-lifecycle-origin-permanent-test-"));
  const sockets: FakeWebSocket[] = [];
  const clock = new FakeClock();
  let core: DaemonCore | null = null;
  let reconcileCalls = 0;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      reconcileComputerLifecycleOrigin: async () => {
        reconcileCalls += 1;
        return { status: "not_adopted" };
      },
      connectionOptions: {
        clock,
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    sockets[0]!.emitOpen();
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock.advanceBy(5_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reconcileCalls, 1);
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore executes mixed-version computer control replay only once", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-control-replay-test-"));
  const sockets: FakeWebSocket[] = [];
  const operationId = "22222222-2222-4222-8222-222222222222";
  let durable = false;
  let executions = 0;
  let resolveHandled!: () => void;
  const handled = new Promise<void>((resolve) => { resolveHandled = resolve; });
  let core: DaemonCore | null = null;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      getComputerLifecycleAcks: () => durable
        ? [{ operationId, action: "restart", phase: "shutdown" }]
        : [],
      onComputerControl: () => {
        executions += 1;
        durable = true;
        resolveHandled();
      },
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    socket.emitServerMessage({ type: "computer:restart", operationId, requestId: operationId });
    await handled;
    socket.emitServerMessage({ type: "computer:restart", requestId: operationId });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(executions, 1);
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore returns request-scoped closed failures when Computer control is rejected", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-control-rejected-test-"));
  const sockets: FakeWebSocket[] = [];
  let core: DaemonCore | null = null;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      onComputerControl: async () => {
        throw new Error("CONTROL_BUSY: another machine control is in flight");
      },
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    socket.emitServerMessage({
      type: "computer:restart",
      operationId: "33333333-3333-4333-8333-333333333333",
      requestId: "33333333-3333-4333-8333-333333333333",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      socket.sent.find((message) =>
        (message as { type?: string }).type === "computer:restart:done"
      ),
      {
        type: "computer:restart:done",
        requestId: "33333333-3333-4333-8333-333333333333",
        ok: false,
        error: "control_busy",
      },
    );
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore ready reports migration transport as not provisioned when no transport is configured", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-migration-transport-ready-none-test-"));
  const sockets: FakeWebSocket[] = [];
  let core: DaemonCore | null = null;

  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    const ready = socket.sent.find((msg): msg is Extract<MachineToServerMessage, { type: "ready" }> =>
      typeof msg === "object" && msg !== null && (msg as { type?: string }).type === "ready"
    );
    assert.ok(ready, "daemon should send ready on connect");
    assert.deepEqual(ready.migrationTransport, {
      provisioned: false,
      endpoint: null,
      leaseSource: null,
      capabilities: [AGENT_MIGRATION_CAPABILITY],
      // No live transfer run in a fresh process: the server may re-provision.
      activeLeases: [],
      observedAt: ready.migrationTransport?.observedAt,
    });
    assert.match(ready.migrationTransport?.observedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal((ready.capabilities ?? []).some((capability) => capability.startsWith("migration:")), false);

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore archives a completed migration source workspace and returns an idempotent receipt", async () => {
  const slockHome = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-migration-source-archive-test-"));
  const dataDir = path.join(slockHome, "agents");
  const source = path.join(dataDir, "agent-archive");
  const sockets: FakeWebSocket[] = [];
  let core: DaemonCore | null = null;

  try {
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "MEMORY.md"), "archive-from-core\n");
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      slockHome,
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration:source_workspace_archive",
      requestId: "11111111-1111-4111-8111-111111111112",
      migrationId: "migration-archive",
      agentId: "agent-archive",
    });
    await waitFor(
      () => socket.sent.some((message) =>
        (message as { requestId?: string }).requestId === "11111111-1111-4111-8111-111111111112"
        && (message as { outcome?: string }).outcome === "archived"),
      "migration source workspace archive receipt",
    );

    const archive = path.join(
      slockHome,
      AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY,
      "agent-archive",
      "migration-archive",
    );
    assert.equal(await readFile(path.join(archive, "MEMORY.md"), "utf8"), "archive-from-core\n");
    await assert.rejects(readFile(path.join(source, "MEMORY.md")), { code: "ENOENT" });

    socket.emitServerMessage({
      type: "machine:migration:source_workspace_archive",
      requestId: "22222222-2222-4222-8222-222222222223",
      migrationId: "migration-archive",
      agentId: "agent-archive",
    });
    await waitFor(
      () => socket.sent.some((message) =>
        (message as { requestId?: string }).requestId === "22222222-2222-4222-8222-222222222223"
        && (message as { outcome?: string }).outcome === "already_archived"),
      "idempotent migration source workspace archive receipt",
    );

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await rm(slockHome, { recursive: true, force: true });
  }
});

test("DaemonCore refuses to archive a source workspace that a later migration committed", async () => {
  const slockHome = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-migration-source-archive-newer-"));
  const dataDir = path.join(slockHome, "agents");
  const source = path.join(dataDir, "agent-back");
  const sockets: FakeWebSocket[] = [];
  let core: DaemonCore | null = null;

  try {
    // The agent moved back onto this computer: its workspace carries a commit
    // marker newer than the migration whose source cleanup is being retried.
    await mkdir(path.join(source, ".raft-migration"), { recursive: true });
    await writeFile(path.join(source, "MEMORY.md"), "live-again\n");
    await writeFile(path.join(source, ...AGENT_MIGRATION_COMMIT_MARKER_PATH.split("/")), `${JSON.stringify({
      schemaVersion: "agent-migration-commit/v1",
      migrationId: "migration-newer",
      migrationGeneration: "gen",
      leaseId: "lease",
      agentId: "agent-back",
      sourceMachineId: "machine-c",
      targetMachineId: "machine-b",
      controlSha256: "0".repeat(64),
      bundleSha256: "0".repeat(64),
      committedAt: "2026-09-02T00:00:00.000Z",
    })}\n`);
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      slockHome,
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration:source_workspace_archive",
      requestId: "33333333-3333-4333-8333-333333333334",
      migrationId: "migration-older",
      agentId: "agent-back",
      migrationCreatedAt: "2026-09-01T00:00:00.000Z",
    });
    await waitFor(
      () => socket.sent.some((message) =>
        (message as { requestId?: string }).requestId === "33333333-3333-4333-8333-333333333334"
        && (message as { outcome?: string }).outcome === "error"
        && (message as { errorCode?: string }).errorCode === "MIGRATION_WORKSPACE_ARCHIVE_NEWER_OWNER"),
      "archive refused for a newer owner",
    );
    assert.equal(await readFile(path.join(source, "MEMORY.md"), "utf8"), "live-again\n", "live workspace untouched");

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await rm(slockHome, { recursive: true, force: true });
  }
});

test("DaemonCore applies object-store migration transfer lease and re-emits provider-neutral ready", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-migration-transport-server-lease-test-"));
  const sockets: FakeWebSocket[] = [];
  let quiesceReceived = false;
  const transferServer = await withHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/internal/computer/agent-migrations/by-id/migration-1/resumable/source-quiesced") {
      await readRequestBody(req);
      quiesceReceived = true;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  let core: DaemonCore | null = null;

  try {
    core = new DaemonCore({
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-1",
      migrationId: "migration-1",
      migrationRef: "mig_AAAAAAAAAAAAAAAAAAAAAA",
      migrationGeneration: "agent_migration:migration-1:3",
      sessionId: "session-1",
      provider: "object_store",
      leaseSource: "server",
      role: "source",
      transferKind: "upload",
      bearerToken: "lease-token-1",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: "/internal/computer/agent-migrations/by-id/migration-1/resumable",
      leaseId: "lease-1",
      transportGeneration: "transport-generation-1",
      sourceMachineId: "source-machine-1",
      targetMachineId: "target-machine-1",
      expectedMigrationRevision: 3,
    });

    const readyMessages = () => socket.sent.filter((msg): msg is Extract<MachineToServerMessage, { type: "ready" }> =>
      typeof msg === "object" && msg !== null && (msg as { type?: string }).type === "ready"
    );
    await waitFor(
      () => readyMessages().some((msg) => msg.migrationTransport?.leaseSource === "server"),
      "server migration transport ready",
    );

    const serverReady = readyMessages().find((msg) => msg.migrationTransport?.leaseSource === "server");
    assert.equal(serverReady?.migrationTransport?.provisioned, true);
    assert.equal(serverReady?.migrationTransport?.endpoint, null);
    assert.deepEqual(serverReady?.migrationTransport?.capabilities, [AGENT_MIGRATION_CAPABILITY]);
    assert.equal(serverReady?.migrationTransport?.provider, "object_store");
    assert.equal(serverReady?.migrationTransport?.role, "source");
    assert.equal(serverReady?.migrationTransport?.transferKind, "upload");
    assert.equal(serverReady?.migrationTransport?.expiresAt, "2999-07-09T13:00:00.000Z");
    assert.equal(serverReady?.migrationTransport?.maxBytes, 104857600);
    assert.equal("token" in (serverReady?.migrationTransport ?? {}), false);
    assert.equal("bearerToken" in (serverReady?.migrationTransport ?? {}), false);
    assert.match(serverReady?.migrationTransport?.observedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    await waitFor(() => quiesceReceived, "resumable source run after ready");

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore generation-fences and idempotently acknowledges an in-flight resumable migration cancel", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-cancel-test-"));
  const resumableResiduePath = path.join(
    dataDir,
    "migrations",
    "migration-cancel",
    "transport-generation-cancel",
    "chunks",
    "0.part",
  );
  const sockets: FakeWebSocket[] = [];
  const cancelAcks: Array<Record<string, unknown>> = [];
  let transportLostReports = 0;
  let downloadAttempts = 0;
  const transferServer = await withHttpServer(async (req, res) => {
    if (
      req.method === "GET"
      && req.url?.startsWith("/internal/computer/agent-migrations/by-id/migration-cancel/resumable/control")
    ) {
      downloadAttempts += 1;
      res.statusCode = 409;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: "migration_control_not_ready" }));
      return;
    }
    if (req.method === "POST" && req.url === "/internal/computer/agent-migrations/by-id/migration-cancel/cancel-ack") {
      cancelAcks.push(JSON.parse((await readRequestBody(req)).toString("utf8")) as Record<string, unknown>);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/internal/computer/agent-migrations/by-id/migration-cancel/transport-lost") {
      transportLostReports += 1;
      await readRequestBody(req);
      res.statusCode = 200;
      res.end("ok");
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  let core: DaemonCore | null = null;

  try {
    await mkdir(path.dirname(resumableResiduePath), { recursive: true });
    await writeFile(resumableResiduePath, "partial chunk");
    core = new DaemonCore({
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: dataDir,
      machineStateDir: path.join(dataDir, "machines"),
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-cancel",
      migrationId: "migration-cancel",
      migrationRef: "mig_FFFFFFFFFFFFFFFFFFFFFF",
      migrationGeneration: "agent_migration:migration-cancel:3",
      sessionId: "session-cancel",
      provider: "object_store",
      leaseSource: "server",
      role: "target",
      transferKind: "download",
      bearerToken: "target-token",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: "/internal/computer/agent-migrations/by-id/migration-cancel/resumable",
      leaseId: "lease-cancel",
      transportGeneration: "transport-generation-cancel",
      sourceMachineId: "source-machine",
      targetMachineId: "target-machine",
      expectedMigrationRevision: 3,
    });
    await waitFor(() => downloadAttempts >= 1, "initial target download attempt");

    const cancelMessage = {
      type: "machine:migration:cancel" as const,
      agentId: "agent-cancel",
      migrationId: "migration-cancel",
      migrationRef: "mig_FFFFFFFFFFFFFFFFFFFFFF",
      transportGeneration: "transport-generation-cancel",
      cancelGeneration: "migration_cancel_generation_1",
      migrationRevision: 4,
      sessionId: "session-cancel",
      role: "target" as const,
      disposition: "pre_flip_source_authoritative" as const,
      stopAgent: false,
    };
    socket.emitServerMessage(cancelMessage);

    await waitFor(() => cancelAcks.length === 1, "migration cancellation acknowledgement");
    assert.equal(cancelAcks[0]!.migrationRef, "mig_FFFFFFFFFFFFFFFFFFFFFF");
    assert.equal(cancelAcks[0]!.transportGeneration, "transport-generation-cancel");
    assert.equal(cancelAcks[0]!.cancelGeneration, "migration_cancel_generation_1");
    assert.equal(cancelAcks[0]!.outcome, "cleaned");
    assert.equal(transportLostReports, 0);
    await assert.rejects(() => readFile(resumableResiduePath), { code: "ENOENT" });

    const receiptPath = path.join(dataDir, "migrations", "session-cancel", "cancel-receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    assert.equal(receipt.cancelGeneration, "migration_cancel_generation_1");
    socket.emitServerMessage(cancelMessage);
    await waitFor(() => cancelAcks.length === 2, "idempotent duplicate acknowledgement");
    assert.equal(cancelAcks[1]!.outcome, "cleaned");

    socket.emitServerMessage({ ...cancelMessage, transportGeneration: "stale-transport-generation" });
    await waitFor(() => cancelAcks.length === 3, "stale generation rejection acknowledgement");
    assert.equal(cancelAcks[2]!.outcome, "needs_attention");
    assert.equal(cancelAcks[2]!.errorMessage, "MIGRATION_CANCEL_GENERATION_STALE");

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore removes only post-flip target migration-generation residue before acknowledging and preserves target authority", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-post-flip-cancel-test-"));
  const migrationId = "migration-post-flip-cancel";
  const transportGeneration = "transport-generation-post-flip-cancel";
  const sessionId = "session-post-flip-cancel";
  const agentId = "agent-post-flip-cancel";
  const generationRoot = path.join(dataDir, "migrations", migrationId, transportGeneration);
  const resumableResiduePath = path.join(generationRoot, "chunks", "0.part");
  const siblingGenerationPath = path.join(dataDir, "migrations", migrationId, "other-generation", "chunks", "0.part");
  const siblingMigrationPath = path.join(dataDir, "migrations", "other-migration", transportGeneration, "chunks", "0.part");
  const finalWorkspacePath = path.join(dataDir, agentId);
  const targetWorkspaceSentinel = path.join(finalWorkspacePath, "MEMORY.md");
  const markerPath = path.join(dataDir, "migrations", sessionId, "cancel-state.json");
  const sockets: FakeWebSocket[] = [];
  const cancelAcks: Array<Record<string, unknown>> = [];
  let residuePresentWhenAcked: boolean | null = null;
  let targetWorkspaceWhenAcked: string | null = null;
  const transferServer = await withHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === `/internal/computer/agent-migrations/by-id/${migrationId}/cancel-ack`) {
      try {
        await readFile(resumableResiduePath);
        residuePresentWhenAcked = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        residuePresentWhenAcked = false;
      }
      targetWorkspaceWhenAcked = await readFile(targetWorkspaceSentinel, "utf8");
      cancelAcks.push(JSON.parse((await readRequestBody(req)).toString("utf8")) as Record<string, unknown>);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  let core: DaemonCore | null = null;

  try {
    await mkdir(path.dirname(resumableResiduePath), { recursive: true });
    await mkdir(path.dirname(siblingGenerationPath), { recursive: true });
    await mkdir(path.dirname(siblingMigrationPath), { recursive: true });
    await mkdir(finalWorkspacePath, { recursive: true });
    await mkdir(path.dirname(markerPath), { recursive: true });
    await writeFile(resumableResiduePath, "migration-owned partial chunk");
    await writeFile(siblingGenerationPath, "other generation");
    await writeFile(siblingMigrationPath, "other migration");
    await writeFile(targetWorkspaceSentinel, "authoritative target workspace");
    await writeFile(markerPath, `${JSON.stringify({
      schemaVersion: "agent-migration-cancel/v1",
      agentId,
      migrationId,
      migrationRef: "mig_PPPPPPPPPPPPPPPPPPPPPP",
      transportGeneration,
      sessionId,
      finalWorkspacePath: path.resolve(finalWorkspacePath),
      workspacePlacementStarted: true,
      workspacePlaced: true,
      flipCommitted: true,
    })}\n`);

    core = new DaemonCore({
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: dataDir,
      machineStateDir: path.join(dataDir, "machines"),
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration:cancel",
      agentId,
      migrationId,
      migrationRef: "mig_PPPPPPPPPPPPPPPPPPPPPP",
      transportGeneration,
      cancelGeneration: "migration_cancel_generation_post_flip_1",
      migrationRevision: 7,
      sessionId,
      role: "target",
      disposition: "post_flip_target_authoritative",
      stopAgent: true,
    });

    await waitFor(() => cancelAcks.length === 1, "post-flip migration cancellation acknowledgement");
    assert.equal(cancelAcks[0]!.outcome, "stopped");
    assert.equal(residuePresentWhenAcked, false, "exact generation residue must be gone before ACK");
    assert.equal(targetWorkspaceWhenAcked, "authoritative target workspace");
    await assert.rejects(() => readFile(generationRoot), { code: "ENOENT" });
    assert.equal(await readFile(siblingGenerationPath, "utf8"), "other generation");
    assert.equal(await readFile(siblingMigrationPath, "utf8"), "other migration");
    assert.equal(await readFile(targetWorkspaceSentinel, "utf8"), "authoritative target workspace");

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore aborts a post-flip source run and removes its exact generation residue before acknowledging", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-post-flip-source-cancel-test-"));
  const migrationId = "migration-post-flip-source-cancel";
  const transportGeneration = "transport-generation-post-flip-source-cancel";
  const sessionId = "session-post-flip-source-cancel";
  const agentId = "agent-post-flip-source-cancel";
  const resumableResiduePath = path.join(
    dataDir,
    "migrations",
    migrationId,
    transportGeneration,
    "source-residue",
    "partial.tar",
  );
  const sockets: FakeWebSocket[] = [];
  const cancelAcks: Array<Record<string, unknown>> = [];
  let sourceQuiesceStarted = false;
  let residuePresentWhenAcked: boolean | null = null;
  let transportLostReports = 0;
  const transferServer = await withHttpServer(async (req, res) => {
    if (
      req.method === "POST"
      && req.url === `/internal/computer/agent-migrations/by-id/${migrationId}/resumable/source-quiesced`
    ) {
      await readRequestBody(req);
      sourceQuiesceStarted = true;
      await new Promise<void>((resolve) => res.once("close", resolve));
      return;
    }
    if (req.method === "POST" && req.url === `/internal/computer/agent-migrations/by-id/${migrationId}/cancel-ack`) {
      try {
        await readFile(resumableResiduePath);
        residuePresentWhenAcked = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        residuePresentWhenAcked = false;
      }
      cancelAcks.push(JSON.parse((await readRequestBody(req)).toString("utf8")) as Record<string, unknown>);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === `/internal/computer/agent-migrations/by-id/${migrationId}/transport-lost`) {
      transportLostReports += 1;
      await readRequestBody(req);
      res.statusCode = 200;
      res.end("ok");
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  let core: DaemonCore | null = null;

  try {
    await mkdir(path.dirname(resumableResiduePath), { recursive: true });
    await writeFile(resumableResiduePath, "source migration residue");
    core = new DaemonCore({
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: dataDir,
      machineStateDir: path.join(dataDir, "machines"),
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId,
      migrationId,
      migrationRef: "mig_SSSSSSSSSSSSSSSSSSSSSS",
      migrationGeneration: `agent_migration:${migrationId}:6`,
      sessionId,
      provider: "object_store",
      leaseSource: "server",
      role: "source",
      transferKind: "upload",
      bearerToken: "source-token",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: `/internal/computer/agent-migrations/by-id/${migrationId}/resumable`,
      leaseId: "lease-post-flip-source-cancel",
      transportGeneration,
      sourceMachineId: "source-machine",
      targetMachineId: "target-machine",
      expectedMigrationRevision: 6,
    });
    await waitFor(() => sourceQuiesceStarted, "source quiesce request before cancellation");

    socket.emitServerMessage({
      type: "machine:migration:cancel",
      agentId,
      migrationId,
      migrationRef: "mig_SSSSSSSSSSSSSSSSSSSSSS",
      transportGeneration,
      cancelGeneration: "migration_cancel_generation_post_flip_source_1",
      migrationRevision: 7,
      sessionId,
      role: "source",
      disposition: "post_flip_target_authoritative",
      stopAgent: false,
    });

    await waitFor(() => cancelAcks.length === 1, "post-flip source cancellation acknowledgement");
    assert.equal(cancelAcks[0]!.outcome, "cleaned");
    assert.equal(residuePresentWhenAcked, false, "source generation residue must be gone before ACK");
    assert.equal(transportLostReports, 0, "aborted cancellation must not report transport lost");

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore rejects malformed migration transfer leases without exposing token in ready", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-migration-transport-invalid-lease-test-"));
  const sockets: FakeWebSocket[] = [];
  let core: DaemonCore | null = null;

  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-1",
      migrationId: "migration-1",
      migrationRef: "mig_GGGGGGGGGGGGGGGGGGGGGG",
      migrationGeneration: "agent_migration:migration-1:3",
      sessionId: "session-1",
      provider: "object_store",
      leaseSource: "server",
      role: "source",
      transferKind: "upload",
      bearerToken: "",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: "/internal/computer/agent-migrations/by-id/migration-1/resumable",
      leaseId: "lease-1",
      transportGeneration: "transport-generation-1",
      sourceMachineId: "source-machine-1",
      targetMachineId: "target-machine-1",
      expectedMigrationRevision: 3,
    });
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-1",
      migrationId: "migration-2",
      migrationRef: "mig_HHHHHHHHHHHHHHHHHHHHHH",
      migrationGeneration: "agent_migration:migration-2:3",
      sessionId: "session-2",
      provider: "object_store",
      leaseSource: "server",
      role: "source",
      transferKind: "upload",
      bearerToken: "lease-token-2",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: "/internal/computer/agent-migrations/by-id/migration-2/resumable",
      // A lease missing a required field is refused.
      leaseId: "",
      transportGeneration: "transport-generation-2",
      sourceMachineId: "source-machine-2",
      targetMachineId: "target-machine-2",
      expectedMigrationRevision: 3,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const readyMessages = socket.sent.filter((msg): msg is Extract<MachineToServerMessage, { type: "ready" }> =>
      typeof msg === "object" && msg !== null && (msg as { type?: string }).type === "ready"
    );
    assert.equal(readyMessages.some((msg) => msg.migrationTransport?.leaseSource === "server"), false);

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore derives default agent dataDir from SLOCK_HOME", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-home-test-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  let capturedDataDir: string | undefined;
  let capturedDaemonInstanceId: string | undefined;

  try {
    process.env.SLOCK_HOME = rootDir;
    new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      agentManagerFactory: (_sendToServer, _daemonApiKey, options) => {
        capturedDataDir = options?.dataDir;
        capturedDaemonInstanceId = options?.daemonInstanceId;
        return {
          setTracer: () => {},
          stopAll: async () => {},
          getRunningAgentIds: () => [],
          resendPendingServerWakes: () => {},
          startAgent: async () => {},
          stopAgent: () => {},
          resetWorkspace: () => {},
          deliverMessage: () => {},
          listWorkspace: async () => [],
          readWorkspaceFile: async () => null,
          deleteWorkspaceDirectory: async () => false,
          scanAllWorkspaces: async () => [],
          getAgentRuntimeProfileReports: () => [],
          handleRuntimeProfileNotification: () => {},
          listSkills: async () => ({ global: [], workspace: [] }),
          detectRuntimeModels: () => null,
        } as unknown as AgentProcessManager;
      },
    });

    assert.equal(capturedDataDir, path.join(rootDir, "agents"));
    assert.match(capturedDaemonInstanceId ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(process.env.SLOCK_HOME, rootDir);
  } finally {
    if (oldSlockHome === undefined) {
      delete process.env.SLOCK_HOME;
    } else {
      process.env.SLOCK_HOME = oldSlockHome;
    }
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("DaemonCore echoes skills list requestId on success and fallback replies", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-skills-request-id-test-"));
  const sockets: FakeWebSocket[] = [];
  let failNext = false;
  let core: DaemonCore | null = null;

  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir: path.join(rootDir, "agents"),
      slockCliPath: "/tmp/slock-cli.js",
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
      agentManagerFactory: () => ({
        setTracer: () => {},
        stopAll: async () => {},
        getRunningAgentIds: () => [],
        resendPendingServerWakes: () => {},
        getAgentSessionId: () => null,
        getAgentLaunchId: () => null,
        getIdleAgentSessionIds: () => [],
        startAgent: async () => {},
        stopAgent: () => {},
        resetWorkspace: () => {},
        deliverMessage: () => {},
        listWorkspace: async () => [],
        readWorkspaceFile: async () => null,
        deleteWorkspaceDirectory: async () => false,
        scanAllWorkspaces: async () => [],
        getAgentRuntimeProfileReports: () => [],
        handleRuntimeProfileNotification: () => {},
        listSkills: async () => {
          if (failNext) {
            failNext = false;
            throw new Error("skill scan failed");
          }
          return {
            global: [{ name: "global", displayName: "Global", description: "global", userInvocable: true }],
            workspace: [],
          };
        },
        detectRuntimeModels: () => null,
      }) as unknown as AgentProcessManager,
    });
    core.start();

    const socket = sockets[0]!;
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:skills:list",
      agentId: "agent-1",
      runtime: "codex",
      requestId: "skills-request-1",
    });
    await waitFor(
      () => socket.sent.some((msg) =>
        typeof msg === "object" && msg !== null &&
          (msg as MachineToServerMessage).type === "agent:skills:list_result" &&
          (msg as Extract<MachineToServerMessage, { type: "agent:skills:list_result" }>).requestId === "skills-request-1"
      ),
      "skills list success reply",
    );

    failNext = true;
    socket.emitServerMessage({
      type: "agent:skills:list",
      agentId: "agent-1",
      requestId: "skills-request-2",
    });
    await waitFor(
      () => socket.sent.some((msg) =>
        typeof msg === "object" && msg !== null &&
          (msg as MachineToServerMessage).type === "agent:skills:list_result" &&
          (msg as Extract<MachineToServerMessage, { type: "agent:skills:list_result" }>).requestId === "skills-request-2"
      ),
      "skills list fallback reply",
    );

    const replies = socket.sent.filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:skills:list_result" }> =>
      typeof msg === "object" && msg !== null && (msg as MachineToServerMessage).type === "agent:skills:list_result"
    );
    assert.equal(replies.find((msg) => msg.requestId === "skills-request-1")?.global[0]?.name, "global");
    assert.deepEqual(replies.find((msg) => msg.requestId === "skills-request-2")?.global, []);
  } finally {
    if (core) await core.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("resolveRaftCliPath falls back to workspace cli dist in source tree", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-cli-path-test-"));

  try {
    const daemonSrcDir = path.join(tmp, "packages", "daemon", "src");
    const workspaceCliPath = path.join(tmp, "packages", "cli", "dist", "index.js");
    await mkdir(path.dirname(workspaceCliPath), { recursive: true });
    await writeFile(workspaceCliPath, "export {};\n", "utf8");

    const moduleUrl = new URL(`file://${path.join(daemonSrcDir, "core.ts")}`).href;
    assert.equal(resolveRaftCliPath(moduleUrl), workspaceCliPath);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("DaemonCore prevents two daemon instances from sharing one machine key", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-machine-lock-test-"));
  const dataDir = path.join(rootDir, "agents");
  await mkdir(dataDir, { recursive: true });
  const firstSockets: FakeWebSocket[] = [];
  const secondSockets: FakeWebSocket[] = [];

  const makeCore = (sockets: FakeWebSocket[]) => new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    slockCliPath: "/tmp/slock-cli.js",
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });

  const first = makeCore(firstSockets);
  const second = makeCore(secondSockets);
  let firstStopped = false;
  let secondStarted = false;

  try {
    first.start();
    assert.equal(firstSockets.length, 1);

    assert.throws(() => second.start(), /Another Slock daemon is already running/);
    assert.equal(secondSockets.length, 0, "conflicting daemon must fail before opening a websocket");

    await first.stop();
    firstStopped = true;

    second.start();
    secondStarted = true;
    assert.equal(secondSockets.length, 1, "released lock should allow a later daemon to start");
  } finally {
    if (!firstStopped) await first.stop();
    if (secondStarted) await second.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("DaemonCore blocks legacy daemon startup after the key is adopted by Computer", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-computer-guard-test-"));
  const dataDir = path.join(rootDir, "agents");
  const oldSlockHome = process.env.SLOCK_HOME;
  const apiKey = "sk_machine_test";
  const serverId = "11111111-1111-4111-8111-111111111111";
  const legacyApiKeyFingerprint = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
  const sockets: FakeWebSocket[] = [];

  await mkdir(path.join(rootDir, "computer", "servers", serverId), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(rootDir, "computer", "servers", serverId, "runner.state.json"),
    JSON.stringify(
      {
        kind: "computer-attachment",
        serverId,
        serverSlug: "alpha",
        serverMachineId: "cmp-1",
        apiKey: "sk_computer_test",
        serverUrl: "https://daemon.example.com",
        adoptedFromLegacy: true,
        legacyMachineId: "mch-1",
        legacyApiKeyFingerprint,
      },
      null,
      2,
    ),
    "utf8",
  );

  process.env.SLOCK_HOME = rootDir;
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey,
    dataDir,
    slockCliPath: "/tmp/slock-cli.js",
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });

  let coreStarted = false;
  try {
    assert.throws(
      () => {
        core.start();
        coreStarted = true;
      },
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "LegacyDaemonKeyAdoptedByComputerError");
        assert.match(error.message, /Legacy Raft daemon startup refused/);
        assert.match(error.message, /already migrated to Raft Computer for \/alpha/);
        assert.match(error.message, /do not restart raft-daemon with the migrated key/);
        assert.match(error.message, /raft-computer start \/alpha/);
        assert.match(error.message, /raft-computer status \/alpha/);
        return true;
      },
    );
    assert.equal(sockets.length, 0, "guard must fail before opening a websocket");
    await assert.rejects(
      () => stat(path.join(rootDir, "machines", getDaemonMachineLockId(apiKey), "daemon.lock", "owner.json")),
      { code: "ENOENT" },
    );
  } finally {
    if (coreStarted) await core.stop();
    if (oldSlockHome === undefined) {
      delete process.env.SLOCK_HOME;
    } else {
      process.env.SLOCK_HOME = oldSlockHome;
    }
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("DaemonCore releases machine lock even when agent shutdown fails", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-machine-stop-failure-test-"));
  const dataDir = path.join(rootDir, "agents");
  await mkdir(dataDir, { recursive: true });
  const sockets: FakeWebSocket[] = [];
  const shutdownError = new Error("stop failed");

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    slockCliPath: "/tmp/slock-cli.js",
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: () => ({
      stopAll: () => Promise.reject(shutdownError),
      getRunningAgentIds: () => [],
      resendPendingServerWakes: () => {},
      getAgentSessionId: () => null,
      getAgentLaunchId: () => null,
      getIdleAgentSessionIds: () => [],
      getAgentRuntimeProfileReports: () => [],
    }) as unknown as AgentProcessManager,
  });

  const replacement = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    slockCliPath: "/tmp/slock-cli.js",
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });

  let replacementStarted = false;
  try {
    core.start();
    await assert.rejects(() => core.stop(), /stop failed/);

    replacement.start();
    replacementStarted = true;
    assert.equal(sockets.length, 2, "replacement daemon should start after failed shutdown releases the lock");
  } finally {
    if (replacementStarted) await replacement.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("DaemonCore overrides server-provided agent serverUrl with the live daemon connection target", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig({ serverUrl: "http://localhost:3001" }),
    });
    await waitFor(() => driver.spawnCalls.length === 1, "agent spawn");

    assert.equal(driver.spawnCalls.length, 1);
    assert.equal(driver.spawnCalls[0]?.config.serverUrl, "https://daemon.example.com");
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore ACKs an accepted start dispatch and never spawns its replay twice", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    const startMessage = {
      type: "agent:start",
      agentId: "agent-1",
      startDispatchId: "dispatch-1",
      launchId: "launch-1",
      config: makeConfig(),
    } satisfies Extract<ServerToMachineMessage, { type: "agent:start" }>;
    socket.emitServerMessage(startMessage);

    await waitFor(
      () => socket.sent.some((message) =>
        (message as { type?: string; startDispatchId?: string }).type === "agent:start:ack"
        && (message as { startDispatchId?: string }).startDispatchId === "dispatch-1"),
      "accepted start dispatch ACK",
    );
    await waitFor(() => driver.spawnCalls.length === 1, "initial agent spawn");

    socket.emitServerMessage(startMessage);
    await waitFor(
      () => socket.sent.filter((message) =>
        (message as { type?: string; startDispatchId?: string }).type === "agent:start:ack"
        && (message as { startDispatchId?: string }).startDispatchId === "dispatch-1").length === 2,
      "duplicate start dispatch ACK",
    );

    const receipts = socket.sent.filter(
      (message): message is Extract<MachineToServerMessage, { type: "agent:start:ack" }> =>
        (message as { type?: string }).type === "agent:start:ack",
    );
    assert.equal(driver.spawnCalls.length, 1, "replayed dispatch must not spawn a second process");
    assert.deepEqual(receipts.map((receipt) => ({
      agentId: receipt.agentId,
      launchId: receipt.launchId,
      startDispatchId: receipt.startDispatchId,
      queueState: receipt.queueState,
    })), [
      {
        agentId: "agent-1",
        launchId: "launch-1",
        startDispatchId: "dispatch-1",
        queueState: receipts[0]?.queueState,
      },
      {
        agentId: "agent-1",
        launchId: "launch-1",
        startDispatchId: "dispatch-1",
        queueState: receipts[0]?.queueState,
      },
    ]);
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RFC 071: DaemonCore advertises runtime outcomes, acks processInstanceId only on a rebind, and threads catchupBatchId to the echo", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const sockets: FakeWebSocket[] = [];

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
        daemonInstanceId: options?.daemonInstanceId,
      }),
  });
  type Sent = MachineToServerMessage;
  const sentOfType = <T extends Sent["type"]>(socket: FakeWebSocket, type: T) =>
    socket.sent.filter((msg): msg is Extract<Sent, { type: T }> => (msg as { type?: string }).type === type);

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    openAckingServer(socket);
    await waitFor(() => sentOfType(socket, "ready").length > 0, "ready");
    const ready = sentOfType(socket, "ready")[0]!;
    assert.equal(ready.capabilities?.includes(DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1), true);
    assert.ok(ready.daemonInstanceId);

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      startDispatchId: "dispatch-1",
      launchId: "launch-1",
      config: makeConfig({ sessionId: "session-1" }),
      resumeMessages: [{
        channel_id: "channel-1",
        channel_name: "general",
        channel_type: "channel",
        sender_id: "user-1",
        sender_name: "richard",
        sender_type: "human",
        content: "owed while paused",
        timestamp: "2026-09-29T10:00:00.000Z",
        message_id: "m1",
        seq: 1,
      }],
      catchupBatchId: "batch-1",
    });
    await waitFor(() => sentOfType(socket, "agent:process_spawned").length === 1, "process spawned");
    const spawned = sentOfType(socket, "agent:process_spawned")[0]!;
    assert.equal(spawned.launchId, "launch-1");
    assert.equal(spawned.daemonInstanceId, ready.daemonInstanceId, "the same daemon instance as ready");
    const firstAck = sentOfType(socket, "agent:start:ack").find((ack) => ack.startDispatchId === "dispatch-1");
    assert.ok(firstAck && firstAck.queueState !== "running" && firstAck.queueState !== "rebound", `fresh spawn ack (got ${firstAck?.queueState})`);
    assert.equal("processInstanceId" in firstAck, false, "a starting/queued ack never carries a processInstanceId");

    driver.children[0]!.stdout.emit("data", Buffer.from("text\nturn_end\n"));
    await waitFor(() => sentOfType(socket, "agent:runtime:outcome").length === 1, "turn_completed");
    const completed = sentOfType(socket, "agent:runtime:outcome")[0]!;
    assert.deepEqual(completed.outcome, { kind: "turn_completed", textEvents: 1, toolCalls: 0, catchupBatchId: "batch-1", catchupRenderedRows: 1 });
    assert.equal(completed.launchId, "launch-1");

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      startDispatchId: "dispatch-2",
      launchId: "launch-2",
      config: makeConfig({ sessionId: "session-1" }),
    });
    await waitFor(() => sentOfType(socket, "agent:start:ack").some((ack) => ack.startDispatchId === "dispatch-2"), "rebind ack");
    const rebindAck = sentOfType(socket, "agent:start:ack").find((ack) => ack.startDispatchId === "dispatch-2")!;
    assert.equal(rebindAck.queueState, "running");
    assert.equal(rebindAck.processInstanceId, spawned.processInstanceId);

    driver.children[0]!.emit("exit", 1, null);
    await waitFor(() => sentOfType(socket, "agent:process_exited").length === 1, "process exited");
    const exited = sentOfType(socket, "agent:process_exited")[0]!;
    assert.deepEqual(
      { processInstanceId: exited.processInstanceId, spawnLaunchId: exited.spawnLaunchId, launchId: exited.launchId, code: exited.code },
      { processInstanceId: spawned.processInstanceId, spawnLaunchId: "launch-1", launchId: "launch-2", code: 1 },
    );
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RFC 071: DaemonCore settles a start it rejects before any process as not_spawned(start_rejected), exactly once", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const sockets: FakeWebSocket[] = [];
  const previousDisabled = process.env.SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED;
  process.env.SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED = "1";
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        tracer: options?.tracer,
        daemonInstanceId: options?.daemonInstanceId,
      }),
  });
  type Outcome = Extract<MachineToServerMessage, { type: "agent:start:outcome" }>;
  const outcomes = (socket: FakeWebSocket) =>
    socket.sent.filter((msg): msg is Outcome => (msg as { type?: string }).type === "agent:start:outcome");
  try {
    core.start();
    const socket = sockets[0]!;
    openAckingServer(socket);
    // Credential mint refused (no key, minting disabled): no process can exist.
    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      startDispatchId: "dispatch-1",
      launchId: "launch-1",
      config: makeConfig({ agentCredentialKey: undefined }),
    });
    // Retired start type: rejected outright.
    socket.emitServerMessage({
      type: "agent:start:wiki",
      agentId: "agent-2",
      launchId: "launch-2",
      config: makeConfig(),
      wikiWorkspacePack: { protocolVersion: 1, packId: "pack-1", files: [] },
    });
    // The process manager settles its own failure: spawn failed before a
    // child existed. DaemonCore's failure report must not add a second result.
    driver.spawn = () => { throw new Error("spawn ENOENT"); };
    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-3",
      startDispatchId: "dispatch-3",
      launchId: "launch-3",
      config: makeConfig(),
    });
    await waitFor(() => outcomes(socket).length >= 3, "three start outcomes");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(driver.spawnCalls.length, 0);
    assert.equal(socket.sent.filter((msg) => (msg as { type?: string }).type === "agent:process_spawned").length, 0);
    assert.deepEqual(outcomes(socket).map((frame) => [frame.agentId, frame.launchId, frame.result]).sort(), [
      ["agent-1", "launch-1", { kind: "not_spawned", reason: "start_rejected" }],
      ["agent-2", "launch-2", { kind: "not_spawned", reason: "start_rejected" }],
      ["agent-3", "launch-3", { kind: "not_spawned", reason: "spawn_failed" }],
    ]);
  } finally {
    if (previousDisabled === undefined) delete process.env.SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED;
    else process.env.SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED = previousDisabled;
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RFC 071 outbox through DaemonCore: an old server gets nothing; a supporting server gets the queue in order; blocked storage and unreliable storage refuse starts locally", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const outboxDir = path.join(dataDir, ".runtime-outcome-outbox");
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const sockets: FakeWebSocket[] = [];
  let failWrites = false;
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    runtimeOutcomeOutboxFs: {
      writeTempAndSync: (temp, data) => {
        if (failWrites) throw new Error("ENOSPC");
        nodeOutboxFs.writeTempAndSync(temp, data);
      },
      rename: (from, to) => nodeOutboxFs.rename(from, to),
      syncDir: (dir) => nodeOutboxFs.syncDir(dir),
    },
    connectionOptions: {
      minReconnectDelayMs: 1,
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        tracer: options?.tracer,
        daemonInstanceId: options?.daemonInstanceId,
      }),
  });
  const ofType = (socket: FakeWebSocket | undefined, type: string) =>
    (socket?.sent ?? []).filter((msg) => (msg as { type?: string }).type === type) as Array<Record<string, unknown>>;
  const start = (socket: FakeWebSocket, agentId: string, launchId: string, extra: Partial<Extract<ServerToMachineMessage, { type: "agent:start" }>> = {}) =>
    socket.emitServerMessage({ type: "agent:start", agentId, launchId, startDispatchId: `dispatch-${launchId}`, config: makeConfig(), ...extra });

  try {
    core.start();
    // (11) An old server: machine:context without the ack capability. A never-engaged
    // agent's compat run produces no outbox frame: nothing is sent or queued.
    sockets[0]!.emitOpen();
    start(sockets[0]!, "agent-1", "launch-1");
    await waitFor(() => driver.spawnCalls.length === 1, "spawn on the old server");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(ofType(sockets[0], "agent:process_spawned").length, 0, "nothing is sent to a server that does not ack");
    const onOld = existsSync(path.join(outboxDir, "agent-1.json"))
      ? (JSON.parse(await readFile(path.join(outboxDir, "agent-1.json"), "utf8")) as { entries: unknown[] }).entries : [];
    assert.deepEqual(onOld, [], "and nothing is queued for it");

    // A supporting server on the next connection: nothing old to deliver (queued delivery with
    // original identity is covered by the outbox tests and the reconnect test below).
    sockets[0]!.terminate();
    await waitFor(() => sockets.length === 2, "replacement websocket");
    openAckingServer(sockets[1]!);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(ofType(sockets[1], "agent:process_spawned").length, 0);

    // Blocked storage: an older epoch fills the outbox; even a human start at a new epoch is refused.
    const filler = new RuntimeOutcomeOutbox({ dir: outboxDir, daemonInstanceId: "d-old", send: () => {} });
    for (let seq = 1; seq <= OUTBOX_NORMAL_CAP; seq += 1) {
      filler.enqueue({ type: "agent:process_exited", agentId: "agent-2", daemonInstanceId: "d-old", processInstanceId: `p-${seq}`, spawnLaunchId: "l", launchId: "l", clientSeq: seq, code: 0, signal: null });
    }
    (core as unknown as { runtimeOutcomeOutbox: RuntimeOutcomeOutbox }).runtimeOutcomeOutbox.load();
    start(sockets[1]!, "agent-2", "launch-2", { humanStart: true, takeoverEpoch: 1 });
    await waitFor(() => ofType(sockets[1], "agent:start:outcome").some((frame) => frame.launchId === "launch-2"), "storage-blocked outcome");
    const blocked = ofType(sockets[1], "agent:start:outcome").find((frame) => frame.launchId === "launch-2")!;
    assert.deepEqual(blocked.result, { kind: "not_spawned", reason: "terminal_failure_outcome_storage_blocked" });
    assert.equal(driver.spawnCalls.length, 1, "the blocked human start spawned nothing");

    // A human start while storage works: it spawns and its process_spawned is stored and sent.
    start(sockets[1]!, "agent-3", "launch-3a", { humanStart: true });
    await waitFor(() => driver.spawnCalls.length === 2, "the human start spawned");
    await waitFor(() => ofType(sockets[1], "agent:process_spawned").some((frame) => frame.agentId === "agent-3"), "spawned frame");
    // Unreliable storage: the exit cannot be stored, so it is not sent (persist-then-send) and agent-3 is unreliable.
    failWrites = true;
    driver.children[1]!.emit("exit", 0, null);
    driver.children[1]!.emit("close", 0, null);
    await waitFor(() => ofType(sockets[1], "agent:runtime:outcome_unreliable").some((frame) => frame.agentId === "agent-3"), "unreliable notice");
    await waitFor(() => !(core as unknown as { agentManager: AgentProcessManager }).agentManager.getRunningAgentIds().includes("agent-3"), "agent-3 process gone");
    assert.equal(ofType(sockets[1], "agent:process_exited").filter((frame) => frame.agentId === "agent-3").length, 0);
    // Storage heals; the agent stays unreliable (the refusal below is stored and sent).
    failWrites = false;
    start(sockets[1]!, "agent-3", "launch-3b");
    await waitFor(() => ofType(sockets[1], "agent:start:outcome").some((frame) => frame.launchId === "launch-3b"), "automatic refusal");
    const refused = ofType(sockets[1], "agent:start:outcome").find((frame) => frame.launchId === "launch-3b")!;
    assert.deepEqual(refused.result, { kind: "not_spawned", reason: "terminal_failure_needs_manual" });
    assert.equal(driver.spawnCalls.length, 2);
    // Storage fails again: a human start whose resolution record cannot be
    // written is a failed recovery, refused storage_blocked (sent directly),
    // and agent-3 stays unreliable.
    failWrites = true;
    start(sockets[1]!, "agent-3", "launch-3c", { humanStart: true });
    await waitFor(() => ofType(sockets[1], "agent:start:outcome").some((frame) => frame.launchId === "launch-3c"), "failed-recovery refusal");
    assert.deepEqual(ofType(sockets[1], "agent:start:outcome").find((frame) => frame.launchId === "launch-3c")!.result,
      { kind: "not_spawned", reason: "terminal_failure_outcome_storage_blocked" });
    assert.equal(driver.spawnCalls.length, 2, "the failed recovery spawned nothing");

    // The next ready stops advertising outcomes for the unreliable agent.
    sockets[1]!.terminate();
    await waitFor(() => sockets.length === 3, "third websocket");
    sockets[2]!.emitOpen();
    await waitFor(() => ofType(sockets[2], "ready").length === 1, "ready");
    assert.deepEqual(ofType(sockets[2], "ready")[0]!.runtimeOutcomeUnreliableAgents, ["agent-3"]);

    // That connection is an older server (no ack capability). It gets no
    // RFC 071 frame, but a known unreliable agent is not exempt there: the
    // automatic start is refused locally, nothing spawns.
    start(sockets[2]!, "agent-3", "launch-3d");
    await waitFor(() => ofType(sockets[2], "agent:status").some((frame) => frame.agentId === "agent-3" && frame.launchId === "launch-3d" && frame.status === "inactive"), "refusal on the older server");
    assert.equal(driver.spawnCalls.length, 2, "no spawn for an unreliable agent on an older server");
    assert.equal(ofType(sockets[2], "agent:start:outcome").length, 0, "the older server gets no outbox frame");
    assert.equal(ofType(sockets[2], "agent:runtime:outcome_unreliable").length, 0);
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RFC 071 outbox through DaemonCore: a durable unreliable marker survives a daemon restart; automatic starts stay refused until an admitted human start clears it", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const outboxDir = path.join(dataDir, ".runtime-outcome-outbox");
  // The previous daemon instance: its queue write failed, so it left only the marker.
  const previous = new RuntimeOutcomeOutbox({
    dir: outboxDir,
    daemonInstanceId: "d-previous",
    send: () => {},
    fs: { ...nodeOutboxFs, writeTempAndSync: (temp, data) => {
      if (path.basename(temp).startsWith("agent-9.json")) throw new Error("ENOSPC");
      nodeOutboxFs.writeTempAndSync(temp, data);
    } },
  });
  previous.enqueue({ type: "agent:process_exited", agentId: "agent-9", daemonInstanceId: "d-previous", processInstanceId: "p", spawnLaunchId: "l", launchId: "l", clientSeq: 1, code: 1, signal: null });
  assert.equal(existsSync(path.join(outboxDir, "agent-9@unreliable.json")), true);

  const driver = new FakeDriver({ supportsStdinNotification: true });
  const sockets: FakeWebSocket[] = [];
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      minReconnectDelayMs: 1,
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        tracer: options?.tracer,
        daemonInstanceId: options?.daemonInstanceId,
      }),
  });
  const ofType = (socket: FakeWebSocket | undefined, type: string) =>
    (socket?.sent ?? []).filter((msg) => (msg as { type?: string }).type === type) as Array<Record<string, unknown>>;
  const start = (socket: FakeWebSocket, launchId: string, extra: Partial<Extract<ServerToMachineMessage, { type: "agent:start" }>> = {}) =>
    socket.emitServerMessage({ type: "agent:start", agentId: "agent-9", launchId, startDispatchId: `dispatch-${launchId}`, config: makeConfig(), ...extra });
  try {
    core.start();
    openAckingServer(sockets[0]!);
    await waitFor(() => ofType(sockets[0], "ready").length === 1, "ready");
    assert.deepEqual(ofType(sockets[0], "ready")[0]!.runtimeOutcomeUnreliableAgents, ["agent-9"], "unreliable after the restart");

    start(sockets[0]!, "launch-auto");
    await waitFor(() => ofType(sockets[0], "agent:start:outcome").some((frame) => frame.launchId === "launch-auto"), "automatic refusal");
    assert.deepEqual(ofType(sockets[0], "agent:start:outcome").find((frame) => frame.launchId === "launch-auto")!.result,
      { kind: "not_spawned", reason: "terminal_failure_needs_manual" });
    assert.equal(driver.spawnCalls.length, 0);
    assert.equal(existsSync(path.join(outboxDir, "agent-9@unreliable.json")), true, "an automatic start does not clear the marker");

    start(sockets[0]!, "launch-human", { humanStart: true });
    await waitFor(() => driver.spawnCalls.length === 1, "the human start spawns");
    assert.equal(existsSync(path.join(outboxDir, "agent-9@unreliable.json")), false, "marker removed");
    const resolution = JSON.parse(await readFile(path.join(outboxDir, "agent-9@resolution.json"), "utf8")) as { launchId: string };
    assert.equal(resolution.launchId, "launch-human");
    const reloaded = new RuntimeOutcomeOutbox({ dir: outboxDir, daemonInstanceId: "d-next", send: () => {} });
    reloaded.load();
    assert.equal(reloaded.isUnreliable("agent-9"), false, "cleared durably");
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function withGatedCore(
  fn: (ctx: {
    core: DaemonCore;
    driver: FakeDriver;
    socket: FakeWebSocket;
    sockets: FakeWebSocket[];
    outboxDir: string;
    ctl: { failOpenProcessWrite: boolean; failExitQueueWrite: boolean };
    ofType: (type: string) => Array<Record<string, unknown>>;
    start: (launchId: string, extra?: Partial<Extract<ServerToMachineMessage, { type: "agent:start" }>>) => void;
  }) => Promise<void>,
  options: { acks?: boolean; autoAck?: boolean; seedOutbox?: (outboxDir: string) => void } = {},
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const outboxDir = path.join(dataDir, ".runtime-outcome-outbox");
  // What an earlier daemon run left on disk (loaded at start).
  options.seedOutbox?.(outboxDir);
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const sockets: FakeWebSocket[] = [];
  const ctl = { failOpenProcessWrite: false, failExitQueueWrite: false };
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    runtimeOutcomeOutboxFs: {
      writeTempAndSync: (temp, data) => {
        // Fail only the open-launch write that adds a process (the spawn gate).
        if (ctl.failOpenProcessWrite && path.basename(temp).includes("@open-launches") && data.includes('"processes":[{')) throw new Error("ENOSPC");
        // Fail the agent's queue write that would store a process_exited frame.
        if (ctl.failExitQueueWrite && path.basename(temp).startsWith("agent-7.json.tmp-") && data.includes('"agent:process_exited"')) throw new Error("EIO");
        nodeOutboxFs.writeTempAndSync(temp, data);
      },
      rename: (from, to) => nodeOutboxFs.rename(from, to),
      syncDir: (dir) => nodeOutboxFs.syncDir(dir),
    },
    connectionOptions: {
      minReconnectDelayMs: 1,
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        tracer: options?.tracer,
        daemonInstanceId: options?.daemonInstanceId,
        runtimeProcessGate: options?.runtimeProcessGate,
      }),
  });
  try {
    core.start();
    if (options.acks === false) sockets[0]!.emitOpen(); // an older server: machine:context without the ack capability
    else openAckingServer(sockets[0]!, { autoAck: options.autoAck });
    await waitFor(() => (sockets[0]?.sent ?? []).some((msg) => (msg as { type?: string }).type === "ready"), "ready");
    await fn({
      core,
      driver,
      socket: sockets[0]!,
      sockets,
      outboxDir,
      ctl,
      ofType: (type) => (sockets[0]?.sent ?? []).filter((msg) => (msg as { type?: string }).type === type) as Array<Record<string, unknown>>,
      start: (launchId, extra = {}) => sockets[0]!.emitServerMessage({
        type: "agent:start", agentId: "agent-7", launchId, startDispatchId: `dispatch-${launchId}`, config: makeConfig(), ...extra,
      }),
    });
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("RFC 071 open launches through DaemonCore: a running process is durably open (a hard crash would leave it unknown); a graceful stop stores the exit and a restart is clean", async () => {
  await withGatedCore(async ({ core, driver, outboxDir, ofType, start }) => {
    start("launch-1");
    await waitFor(() => driver.spawnCalls.length === 1, "spawn");
    await waitFor(() => ofType("agent:process_spawned").length === 1, "spawned frame");
    const open = JSON.parse(await readFile(path.join(outboxDir, "agent-7@open-launches.json"), "utf8")) as { requests: unknown[]; processes: Array<{ processInstanceId: string }> };
    assert.deepEqual(open.requests, [], "the request has its result");
    assert.equal(open.processes.length, 1, "the running process is open");
    assert.equal(open.processes[0]!.processInstanceId, ofType("agent:process_spawned")[0]!.processInstanceId);
    // What a restart after a hard crash (kill -9) would load now: the documented cost.
    const crashed = new RuntimeOutcomeOutbox({ dir: outboxDir, daemonInstanceId: "d-after-crash", send: () => {} });
    crashed.load();
    assert.equal(crashed.isUnreliable("agent-7"), true);
    rmSync(path.join(outboxDir, "agent-7@unreliable.json"), { force: true }); // undo that probe's marker

    await core.stop();
    const restarted = new RuntimeOutcomeOutbox({ dir: outboxDir, daemonInstanceId: "d-next", send: () => {} });
    restarted.load();
    assert.equal(restarted.isUnreliable("agent-7"), false, "graceful stop: the exit is stored, nothing is open");
    const after = JSON.parse(await readFile(path.join(outboxDir, "agent-7@open-launches.json"), "utf8")) as { processes: unknown[] };
    assert.deepEqual(after.processes, []);
  });
});

test("RFC 071 open launches through DaemonCore: if the process cannot be recorded open, it is not spawned (storage_blocked) and the agent is unreliable", async () => {
  await withGatedCore(async ({ core, driver, ctl, ofType, start }) => {
    ctl.failOpenProcessWrite = true;
    start("launch-1", { humanStart: true });
    await waitFor(() => ofType("agent:start:outcome").some((frame) => frame.launchId === "launch-1"), "refusal");
    assert.deepEqual(ofType("agent:start:outcome").find((frame) => frame.launchId === "launch-1")!.result,
      { kind: "not_spawned", reason: "terminal_failure_outcome_storage_blocked" });
    assert.equal(driver.spawnCalls.length, 0, "nothing spawned");
    assert.equal((core as unknown as { runtimeOutcomeOutbox: RuntimeOutcomeOutbox }).runtimeOutcomeOutbox.isUnreliable("agent-7"), true);
  });
});

test("RFC 071 open launches through DaemonCore (old server): the process cannot be recorded open -> no spawn, unreliable; the next start is not stranded", async () => {
  await withGatedCore(async ({ core, driver, ctl, ofType, start }) => {
    ctl.failOpenProcessWrite = true;
    start("launch-1");
    await waitFor(() => ofType("agent:status").some((frame) => frame.launchId === "launch-1" && frame.status === "inactive"), "spawn refused");
    assert.equal(driver.spawnCalls.length, 0, "nothing spawned on the older server");
    const outbox = (core as unknown as { runtimeOutcomeOutbox: RuntimeOutcomeOutbox }).runtimeOutcomeOutbox;
    assert.equal(outbox.isUnreliable("agent-7"), true);
    ctl.failOpenProcessWrite = false;
    start("launch-2");
    await waitFor(() => driver.spawnCalls.length === 1, "the old server never sends a human start: the next start spawns");
    assert.equal(ofType("agent:start:outcome").length + ofType("agent:runtime:outcome_unreliable").length, 0, "the older server gets no RFC 071 frame");
  }, { acks: false });
});

test("RFC 071 open launches through DaemonCore: an internal start without a launchId is durably open (keyed by processInstanceId); its exit is recorded and clears it", async () => {
  await withGatedCore(async ({ core, driver, outboxDir }) => {
    const manager = (core as unknown as { agentManager: AgentProcessManager }).agentManager;
    await manager.startAgent("agent-7", makeConfig());
    assert.equal(driver.spawnCalls.length, 1);
    const open = JSON.parse(await readFile(path.join(outboxDir, "agent-7@open-launches.json"), "utf8")) as { processes: Array<{ processInstanceId: string; spawnLaunchId: string | null }> };
    assert.equal(open.processes.length, 1, "the internal process is recorded before it runs");
    assert.equal(open.processes[0]!.spawnLaunchId, null, "no server launchId is invented");
    // What a restart after a hard crash would load now.
    const crashed = new RuntimeOutcomeOutbox({ dir: outboxDir, daemonInstanceId: "d-after-crash", send: () => {} });
    crashed.load();
    assert.equal(crashed.isUnreliable("agent-7"), true, "restart with the entry open -> unreliable");
    rmSync(path.join(outboxDir, "agent-7@unreliable.json"), { force: true }); // undo that probe's marker

    driver.children[0]!.emit("exit", 0, null);
    driver.children[0]!.emit("close", 0, null);
    await waitFor(() => (JSON.parse(readFileSync(path.join(outboxDir, "agent-7@open-launches.json"), "utf8")) as { processes: unknown[] }).processes.length === 0, "the durable exit clears it");
    const restarted = new RuntimeOutcomeOutbox({ dir: outboxDir, daemonInstanceId: "d-next", send: () => {} });
    restarted.load();
    assert.equal(restarted.isUnreliable("agent-7"), false);
  });
});

test("RFC 071 open launches through DaemonCore: an internal start without a launchId whose record cannot be written does not spawn, and the agent is unreliable", async () => {
  await withGatedCore(async ({ core, driver, ctl }) => {
    ctl.failOpenProcessWrite = true;
    const manager = (core as unknown as { agentManager: AgentProcessManager }).agentManager;
    await assert.rejects(manager.startAgent("agent-7", makeConfig()), (err: Error) => err.name === "RuntimeOutcomeStorageBlockedError");
    assert.equal(driver.spawnCalls.length, 0, "nothing spawned");
    assert.equal((core as unknown as { runtimeOutcomeOutbox: RuntimeOutcomeOutbox }).runtimeOutcomeOutbox.isUnreliable("agent-7"), true);
  });
});

type OpenLaunchesOnDisk = { requests: Array<{ launchId: string }>; processes: Array<{ processInstanceId: string; spawnLaunchId: string | null }> };

function openLaunchesOnDisk(outboxDir: string): OpenLaunchesOnDisk {
  return JSON.parse(readFileSync(path.join(outboxDir, "agent-7@open-launches.json"), "utf8")) as OpenLaunchesOnDisk;
}

/**
 * P1 is started by the daemon itself (no launchId), then server starts L1 and
 * L2 are rebound onto it. Its registry entry ends (close) and P2 is spawned
 * for L3 while P1's exit has not arrived yet. Returns the identities.
 */
async function internalProcessReboundThenReplaced(ctx: {
  core: DaemonCore;
  driver: FakeDriver;
  outboxDir: string;
  ofType: (type: string) => Array<Record<string, unknown>>;
  start: (launchId: string) => void;
}): Promise<{ p1: string; p2: string }> {
  const manager = (ctx.core as unknown as { agentManager: AgentProcessManager }).agentManager;
  await manager.startAgent("agent-7", makeConfig());
  assert.equal(ctx.driver.spawnCalls.length, 1);
  const p1 = openLaunchesOnDisk(ctx.outboxDir).processes[0]!.processInstanceId;
  assert.equal(openLaunchesOnDisk(ctx.outboxDir).processes[0]!.spawnLaunchId, null, "precondition: an internal start, no birth launch");
  for (const launchId of ["launch-1", "launch-2"]) {
    ctx.start(launchId);
    await waitFor(() => ctx.ofType("agent:start:outcome").some((frame) => frame.launchId === launchId), `${launchId} result`);
    assert.deepEqual(ctx.ofType("agent:start:outcome").find((frame) => frame.launchId === launchId)!.result, { kind: "rebound", processInstanceId: p1 });
  }
  // P1 leaves the registry before its exit event arrives.
  ctx.driver.children[0]!.emit("close", 1, null);
  await waitFor(() => !(manager as unknown as { agents: Map<string, unknown> }).agents.has("agent-7"), "P1 closed");
  ctx.start("launch-3");
  await waitFor(() => ctx.ofType("agent:process_spawned").some((frame) => frame.launchId === "launch-3"), "P2 spawned for launch-3");
  const p2 = ctx.ofType("agent:process_spawned").find((frame) => frame.launchId === "launch-3")!.processInstanceId as string;
  assert.notEqual(p2, p1);
  assert.deepEqual(
    openLaunchesOnDisk(ctx.outboxDir).processes.map((entry) => [entry.processInstanceId, entry.spawnLaunchId]).sort(),
    [[p1, null], [p2, "launch-3"]].sort(),
    "precondition: both processes are open",
  );
  return { p1, p2 };
}

test("RFC 071 outbox through DaemonCore: an internal process rebound to L1 then L2 whose exit arrives after P2 spawned for L3 sends process_exited for the OLD identity (spawnLaunchId null, launchId L2); only P1's entry clears, P2's stays open", async () => {
  await withGatedCore(async (ctx) => {
    const { p1, p2 } = await internalProcessReboundThenReplaced(ctx);
    ctx.driver.children[0]!.emit("exit", 1, null);
    await waitFor(() => ctx.ofType("agent:process_exited").length === 1, "P1 exit frame");
    const exited = ctx.ofType("agent:process_exited")[0]!;
    assert.deepEqual(
      { processInstanceId: exited.processInstanceId, spawnLaunchId: exited.spawnLaunchId, launchId: exited.launchId, daemonInstanceId: exited.daemonInstanceId },
      { processInstanceId: p1, spawnLaunchId: null, launchId: "launch-2", daemonInstanceId: ctx.ofType("agent:process_spawned")[0]!.daemonInstanceId },
      "the old process identity; its birth had no launch, the last launch it carried is L2",
    );
    await waitFor(() => openLaunchesOnDisk(ctx.outboxDir).processes.length === 1, "P1's entry cleared once its exit was stored");
    assert.deepEqual(openLaunchesOnDisk(ctx.outboxDir).processes.map((entry) => [entry.processInstanceId, entry.spawnLaunchId]), [[p2, "launch-3"]], "P2's entry stays open");
    const manager = (ctx.core as unknown as { agentManager: AgentProcessManager }).agentManager;
    assert.equal((manager as unknown as { agents: Map<string, { processInstanceId: string }> }).agents.get("agent-7")?.processInstanceId, p2, "P2 still runs");
  });
});

test("RFC 071 outbox through DaemonCore: that exit clears P1's entry only after its frame is durably stored (a failed store keeps it and the agent is unreliable)", async () => {
  await withGatedCore(async (ctx) => {
    const { p1, p2 } = await internalProcessReboundThenReplaced(ctx);
    ctx.ctl.failExitQueueWrite = true;
    ctx.driver.children[0]!.emit("exit", 1, null);
    const outbox = (ctx.core as unknown as { runtimeOutcomeOutbox: RuntimeOutcomeOutbox }).runtimeOutcomeOutbox;
    await waitFor(() => outbox.isUnreliable("agent-7"), "the exit could not be stored");
    await flush();
    assert.equal(ctx.ofType("agent:process_exited").length, 0, "nothing sent that was not stored");
    assert.deepEqual(
      openLaunchesOnDisk(ctx.outboxDir).processes.map((entry) => [entry.processInstanceId, entry.spawnLaunchId]).sort(),
      [[p1, null], [p2, "launch-3"]].sort(),
      "P1 stays open (unknown), P2 untouched",
    );
  });
});

test("RFC 071 outbox through DaemonCore (old server): an unreliable agent is not stranded: the next server start and the daemon's own restart spawn it", async () => {
  await withGatedCore(async ({ core, driver, ctl, ofType, start }) => {
    ctl.failOpenProcessWrite = true;
    start("launch-1");
    await waitFor(() => ofType("agent:status").some((frame) => frame.launchId === "launch-1" && frame.status === "inactive"), "first start refused");
    ctl.failOpenProcessWrite = false;
    assert.equal(gatedOutbox(core).isUnreliable("agent-7"), true);

    // The old server never sends a human start: a server start goes through.
    start("launch-2");
    await waitFor(() => driver.spawnCalls.length === 1, "the server start spawns");
    driver.children[0]!.kill();
    await waitFor(() => !gatedManager(core).getRunningAgentIds().includes("agent-7"), "stopped");

    // The daemon's own restart too.
    await gatedManager(core).startAgent("agent-7", makeConfig());
    assert.equal(driver.spawnCalls.length, 2);
    assert.equal(ofType("agent:activity").some((frame) => typeof frame.detail === "string" && /Automatic start refused/.test(frame.detail as string)), false, "nothing refused");
    assert.equal(gatedOutbox(core).isUnreliable("agent-7"), true, "the state is kept for an acking server");
  }, { acks: false });
});

test("RFC 071 outbox through DaemonCore (acking server): the refusal says to start the agent manually, without the old-server sentence", async () => {
  await withGatedCore(async ({ core, driver, ctl, ofType }) => {
    ctl.failOpenProcessWrite = true;
    const manager = (core as unknown as { agentManager: AgentProcessManager }).agentManager;
    await assert.rejects(manager.startAgent("agent-7", makeConfig()));
    ctl.failOpenProcessWrite = false;
    await manager.startAgent("agent-7", makeConfig());
    assert.equal(driver.spawnCalls.length, 0);
    const shown = ofType("agent:activity").filter((frame) => typeof frame.detail === "string" && /Automatic start refused/.test(frame.detail as string));
    assert.equal(shown.at(-1)?.detail, "Automatic start refused: runtime outcome evidence for this agent is incomplete; start it manually");
  });
});

// --- RFC 071: one automatic-start rule, human recovery bound to its launch, old-epoch gaps (review of #8688, round 6) ---

type GatedContext = Parameters<Parameters<typeof withGatedCore>[0]>[0];

function gatedOutbox(core: DaemonCore): RuntimeOutcomeOutbox {
  return (core as unknown as { runtimeOutcomeOutbox: RuntimeOutcomeOutbox }).runtimeOutcomeOutbox;
}

function gatedManager(core: DaemonCore): AgentProcessManager {
  return (core as unknown as { agentManager: AgentProcessManager }).agentManager;
}

/** The server acks every evidence frame of agent-7 still queued; un-acked markers stay (they are never acked here). */
function ackEvidenceFrames(ctx: GatedContext): void {
  for (const entry of [...gatedOutbox(ctx.core).state("agent-7").entries]) {
    if (entry.t !== "normal") continue;
    ctx.socket.emitServerMessage({ type: "agent:outcome:ack", agentId: "agent-7", daemonInstanceId: entry.daemonInstanceId, clientSeq: entry.clientSeq });
  }
}

/** Evidence frames of agent-7 still queued (they wait behind the un-acked gap: stop-and-wait). */
function queuedFrames(ctx: GatedContext, type: string): Array<Record<string, unknown>> {
  return gatedOutbox(ctx.core).state("agent-7").entries
    .flatMap((entry) => entry.t === "normal" && entry.frame.type === type ? [entry.frame as unknown as Record<string, unknown>] : []);
}

/** Un-acked gap / cross markers of agent-7 as `[takeoverEpoch, gapId]`. */
function unackedMarkers(ctx: GatedContext): Array<[number, string]> {
  return gatedOutbox(ctx.core).state("agent-7").entries
    .filter((entry) => entry.t !== "normal")
    .map((entry) => [entry.takeoverEpoch, (entry as { gapId: string }).gapId]);
}

/** A critical-frame gap: one E1 more than the queue holds folds an E1 into a gap; the server acks the rest, not the gap. */
function makeCriticalGap(ctx: GatedContext, firstSeq: number): void {
  const outbox = gatedOutbox(ctx.core);
  for (let seq = firstSeq; seq <= firstSeq + OUTBOX_NORMAL_CAP; seq += 1) {
    outbox.enqueue({
      type: "agent:runtime:outcome", v: 1, agentId: "agent-7", launchId: `launch-e1-${seq}`, sessionId: "s", daemonInstanceId: "d-e1",
      clientSeq: seq, observedAtMs: 1, outcome: { kind: "terminal_failure", failureKind: "compaction_failed", fingerprint: "c4722931c8a1f172", errorClass: "RuntimeError" },
    } as OutboxFrame);
  }
  ackEvidenceFrames(ctx);
}

async function exitRunning(ctx: GatedContext, index: number, code: number): Promise<void> {
  ctx.driver.children[index]!.emit("exit", code, null);
  ctx.driver.children[index]!.emit("close", code, null);
  await waitFor(() => !(gatedManager(ctx.core) as unknown as { agents: Map<string, unknown> }).agents.has("agent-7"), "the process is gone");
}

function refusedShown(ctx: GatedContext): number {
  return ctx.ofType("agent:activity").filter((frame) => typeof frame.detail === "string" && /Automatic start refused/.test(frame.detail as string)).length;
}

test("RFC 071 automatic-start rule through DaemonCore: an un-acked gap refuses the daemon's own start; a human agent:start is admitted on its own grant and spawns; a restart right after it (same launchId, no new fault, gap still current) is refused: the grant is spent", async () => {
  await withGatedCore(async (ctx) => {
    const manager = gatedManager(ctx.core);
    makeCriticalGap(ctx, 1);
    assert.equal(unackedMarkers(ctx).length, 1, "precondition: one un-acked critical-frame gap");

    await manager.startAgent("agent-7", makeConfig());
    assert.equal(ctx.driver.spawnCalls.length, 0, "the internal start is refused: the gap is un-acked");
    assert.equal(refusedShown(ctx), 1, "and the refusal is shown");

    // The human start carries no new epoch: the gap stays current.
    ctx.start("launch-human", { humanStart: true });
    await waitFor(() => ctx.driver.spawnCalls.length === 1, "the admitted human start spawns on its own grant");
    assert.deepEqual(queuedFrames(ctx, "agent:process_spawned").map((frame) => frame.launchId), ["launch-human"]);
    assert.equal(unackedMarkers(ctx).length, 1, "the gap is kept, never deleted to pass");

    await exitRunning(ctx, 0, 1);
    // The daemon's restart of that process carries the same launchId (restart snapshot).
    await manager.startAgent("agent-7", makeConfig(), undefined, undefined, undefined, "launch-human");
    assert.equal(ctx.driver.spawnCalls.length, 1, "the restart is automatic again: refused");
    assert.equal(unackedMarkers(ctx).length, 1);
  }, { autoAck: false });
});

test("RFC 071 automatic-start rule through DaemonCore: an automatic agent:start with a larger epoch exempts no old gap; a human agent:start that durably takes over a new epoch makes it non-blocking; a new gap of that epoch blocks again", async () => {
  await withGatedCore(async (ctx) => {
    const manager = gatedManager(ctx.core);
    makeCriticalGap(ctx, 1);
    const [[oldEpoch]] = unackedMarkers(ctx) as [[number, string]];

    ctx.start("launch-auto", { takeoverEpoch: oldEpoch + 5 });
    await waitFor(() => queuedFrames(ctx, "agent:start:outcome").some((frame) => frame.launchId === "launch-auto"), "automatic start result");
    assert.deepEqual(queuedFrames(ctx, "agent:start:outcome").find((frame) => frame.launchId === "launch-auto")!.result,
      { kind: "not_spawned", reason: "terminal_failure_needs_manual" }, "a larger epoch on an automatic start exempts nothing");
    await manager.startAgent("agent-7", makeConfig());
    assert.equal(ctx.driver.spawnCalls.length, 0, "the old gap still blocks the daemon's own start");

    ackEvidenceFrames(ctx);
    ctx.start("launch-human", { humanStart: true, takeoverEpoch: oldEpoch + 6 });
    await waitFor(() => ctx.driver.spawnCalls.length === 1, "the human takeover spawns");
    const onDisk = JSON.parse(readFileSync(path.join(ctx.outboxDir, "agent-7.json"), "utf8")) as { humanTakeoverEpoch?: number };
    assert.equal(onDisk.humanTakeoverEpoch, oldEpoch + 6, "the takeover is durable");

    await exitRunning(ctx, 0, 0);
    await manager.startAgent("agent-7", makeConfig());
    assert.equal(ctx.driver.spawnCalls.length, 2, "no new fault since the takeover: the internal restart proceeds");
    assert.deepEqual(unackedMarkers(ctx).map(([epoch]) => epoch), [oldEpoch], "the old gap is still un-acked (kept, not deleted)");

    await exitRunning(ctx, 1, 0);
    ackEvidenceFrames(ctx);
    makeCriticalGap(ctx, 10_000);
    assert.deepEqual(unackedMarkers(ctx).map(([epoch]) => epoch), [oldEpoch, oldEpoch + 6], "a new gap in the new epoch");
    await manager.startAgent("agent-7", makeConfig());
    assert.equal(ctx.driver.spawnCalls.length, 2, "the new gap blocks the next internal restart");
  }, { autoAck: false });
});

/** An earlier run under an acking server: one E1 more than the queue holds folded an E1 into a gap; the server acked the rest, never the gap. */
function seedCriticalGap(outboxDir: string): void {
  const earlier = new RuntimeOutcomeOutbox({ dir: outboxDir, daemonInstanceId: "d-earlier", send: () => {} });
  earlier.onServerContext(true);
  for (let seq = 1; seq <= OUTBOX_NORMAL_CAP + 1; seq += 1) {
    earlier.enqueue({
      type: "agent:runtime:outcome", v: 1, agentId: "agent-7", launchId: `launch-e1-${seq}`, sessionId: "s", daemonInstanceId: "d-earlier",
      clientSeq: seq, observedAtMs: 1, outcome: { kind: "terminal_failure", failureKind: "compaction_failed", fingerprint: "c4722931c8a1f172", errorClass: "RuntimeError" },
    });
  }
  for (const entry of [...earlier.state("agent-7").entries]) {
    if (entry.t === "normal") earlier.ack({ agentId: "agent-7", daemonInstanceId: entry.daemonInstanceId, clientSeq: entry.clientSeq });
  }
  earlier.stop();
}

test("RFC 071 outbox through DaemonCore (old server, regression): 200 start/exit cycles queue nothing, form no gap, and never refuse an automatic start; the daemon's own start still spawns", async () => {
  await withGatedCore(async (ctx) => {
    const outbox = gatedOutbox(ctx.core);
    const agents = (gatedManager(ctx.core) as unknown as { agents: Map<string, unknown> }).agents;
    for (let cycle = 0; cycle < 200; cycle += 1) {
      ctx.start(`launch-${cycle}`);
      await waitFor(() => ctx.driver.spawnCalls.length === cycle + 1, `cycle ${cycle}: the automatic start spawns`);
      ctx.driver.children[cycle]!.emit("exit", cycle % 2, null);
      ctx.driver.children[cycle]!.emit("close", cycle % 2, null);
      await waitFor(() => !agents.has("agent-7"), `cycle ${cycle}: exited`);
      assert.deepEqual(outbox.state("agent-7").entries, [], `cycle ${cycle}: nothing is queued for a server that never consumes it`);
      assert.equal(outbox.refusesAutomaticStart("agent-7"), false, `cycle ${cycle}: automatic starts are not refused`);
    }
    assert.equal(outbox.isUnreliable("agent-7"), false);
    await gatedManager(ctx.core).startAgent("agent-7", makeConfig());
    assert.equal(ctx.driver.spawnCalls.length, 201, "the daemon's own start spawns");
    const open = JSON.parse(readFileSync(path.join(ctx.outboxDir, "agent-7@open-launches.json"), "utf8")) as { requests: unknown[]; processes: unknown[] };
    assert.deepEqual([open.requests.length, open.processes.length], [0, 1], "every settled launch and exited process was closed; only the running one is open");
  }, { acks: false });
});

test("RFC 071 outbox through DaemonCore (reconnect to an upgraded server): last known was old; before the new connection's context a running process exits (kept) and a start is requested (held); the context says acks: the exit is sent with its original identity and the held start runs", async () => {
  await withGatedCore(async (ctx) => {
    const manager = gatedManager(ctx.core);
    const outbox = gatedOutbox(ctx.core);
    const agents = (manager as unknown as { agents: Map<string, unknown> }).agents;
    ctx.start("launch-1");
    await waitFor(() => ctx.driver.spawnCalls.length === 1, "a compat process runs on the old server");
    assert.deepEqual(outbox.state("agent-7").entries, [], "precondition: nothing queued for the old server");

    ctx.socket.close();
    await waitFor(() => ctx.sockets.length === 2, "reconnect");
    ctx.sockets[1]!.emitOpen({ machineContext: false }); // the new (upgraded) server's context has not arrived yet
    assert.equal(outbox.currentServerCapability(), "unknown", "the last known 'old' does not stand in");

    ctx.driver.children[0]!.emit("exit", 1, null);
    ctx.driver.children[0]!.emit("close", 1, null);
    await waitFor(() => !agents.has("agent-7"), "the process exited");
    const kept = outbox.state("agent-7").entries.flatMap((entry) => entry.t === "normal" && entry.frame.type === "agent:process_exited" ? [entry.frame] : []);
    assert.equal(kept.length, 1, "the exit is kept");

    const held = manager.startAgent("agent-7", makeConfig());
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(ctx.driver.spawnCalls.length, 1, "the start is held, not refused");

    ctx.sockets[1]!.emitServerMessage({ type: "machine:context", machineId: "machine-test", serverId: "server-test", capabilities: [SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1] });
    await held;
    await waitFor(() => ctx.driver.spawnCalls.length === 2, "the held start runs after the context");
    await waitFor(() => ctx.sockets[1]!.sent.some((msg) => (msg as { type?: string }).type === "agent:process_exited"), "the exit is sent");
    const sentExit = ctx.sockets[1]!.sent.find((msg) => (msg as { type?: string }).type === "agent:process_exited") as Record<string, unknown>;
    assert.deepEqual([sentExit.daemonInstanceId, sentExit.clientSeq, sentExit.processInstanceId], [kept[0]!.daemonInstanceId, kept[0]!.clientSeq, kept[0]!.processInstanceId], "with its original identity");
  }, { acks: false });
});

test("RFC 071 automatic-start rule through DaemonCore (old server): a critical gap does not refuse the daemon's own restart or a server automatic agent:start; the gap is kept", async () => {
  await withGatedCore(async (ctx) => {
    const manager = gatedManager(ctx.core);
    assert.equal(unackedMarkers(ctx).length, 1, "precondition: the critical-frame gap an earlier run left is kept on the old server");

    await manager.startAgent("agent-7", makeConfig(), { channel_name: "general", sender_name: "richard", content: "wake while the gap is open" } as never);
    assert.equal(ctx.driver.spawnCalls.length, 1, "the internal restart spawns");
    ctx.driver.children[0]!.kill();
    await waitFor(() => !manager.getRunningAgentIds().includes("agent-7"), "stopped");

    ctx.start("launch-auto");
    await waitFor(() => ctx.driver.spawnCalls.length === 2, "the server's automatic start spawns");
    assert.equal(unackedMarkers(ctx).length, 1, "the gap is kept");
  }, { acks: false, seedOutbox: seedCriticalGap });
});

test("RFC 071 outbox through DaemonCore: a start that fails before its process exists, or whose spawn fails without an exit event, leaves no open process behind, so a restart is clean", async () => {
  for (const failure of ["before_spawn", "spawn_error"] as const) {
    await withGatedCore(async (ctx) => {
      if (failure === "before_spawn") ctx.driver.failSpawn = new Error("Model deepseek/deepseek-v4-flash is not available for the builtin runtime on this computer");
      ctx.start("launch-1");
      if (failure === "spawn_error") {
        await waitFor(() => ctx.driver.children.length === 1, "spawned");
        // What Node does on EACCES / ENOENT: `error`, then `close` with the negative errno; never `exit`.
        ctx.driver.children[0]!.emit("error", Object.assign(new Error("spawn claude EACCES"), { code: "EACCES" }));
        ctx.driver.children[0]!.emit("close", -13, null);
      }
      await waitFor(() => existsSync(path.join(ctx.outboxDir, "agent-7@open-launches.json"))
        && openLaunchesOnDisk(ctx.outboxDir).requests.length === 0
        && openLaunchesOnDisk(ctx.outboxDir).processes.length === 0, `${failure}: nothing left open`);
      const restarted = new RuntimeOutcomeOutbox({ dir: ctx.outboxDir, daemonInstanceId: "d-next", send: () => {} });
      restarted.load();
      assert.equal(restarted.isUnreliable("agent-7"), false, `${failure}: a restart is clean`);
      restarted.stop();
    }, { acks: false });
  }
});

test("DaemonCore mints a runner credential before starting an agent", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];
  const mintCalls: Array<{ url: string; headers: Headers; body: any }> = [];
  const revokeCalls: Array<{ url: string; headers: Headers; method?: string }> = [];
  const restoreFetch = installDaemonFetchMockForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      revokeCalls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        method: init.method,
      });
      return new Response(null, { status: 204 });
    }
    mintCalls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response(JSON.stringify({ apiKey: "sk_agent_minted", credentialId: "cred-1" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig({ agentCredentialKey: null }),
    });
    await waitFor(() => mintCalls.length === 1 && driver.spawnCalls.length === 1, "runner credential mint and agent spawn");

    assert.equal(mintCalls.length, 1);
    const mintUrl = new URL(mintCalls[0]!.url);
    assert.equal(mintUrl.pathname, "/internal/computer/runners/agent-1/credentials");
    assert.equal(mintCalls[0]!.headers.get("Authorization"), "Bearer sk_machine_test");
    assert.deepEqual(mintCalls[0]!.body.scopes, ["send", "read", "mentions", "tasks", "reactions", "server", "channels", "knowledge", "mcp"]);
    assert.equal(driver.spawnCalls.length, 1);
    assert.equal(driver.spawnCalls[0]?.config.agentCredentialKey, "sk_agent_minted");
    assert.equal(driver.spawnCalls[0]?.config.agentCredentialId, "cred-1");

    driver.children[0]?.kill();
    await waitFor(() => revokeCalls.length === 1, "managed runner credential revoke");
    const revokeUrl = new URL(revokeCalls[0]!.url);
    assert.equal(revokeUrl.pathname, "/internal/computer/runners/agent-1/credentials/cred-1");
    assert.equal(revokeCalls[0]!.headers.get("Authorization"), "Bearer sk_machine_test");
  } finally {
    restoreFetch();
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore hard-fails start when runner credential mint is disabled by kill switch", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const restoreFetch = installDaemonFetchMockForTests((async () => new Response(JSON.stringify({
    error: "Experimental internal surface is disabled",
    code: "experimental_surface_disabled",
  }), {
    status: 503,
    headers: { "content-type": "application/json" },
  })) as typeof fetch);

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
        daemonInstanceId: options?.daemonInstanceId,
      }),
    tracer,
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig({ agentCredentialKey: null }),
    });
    await waitFor(
      () => socket.sent.some((message) => (message as { type?: string }).type === "agent:activity"),
      "hard-fail status/activity",
    );

    assert.equal(driver.spawnCalls.length, 0);
    // RFC 069 §8: the start failure reports on the sequenced status channel.
    const status = socket.sent.find((message) => (message as { type?: string }).type === "agent:status") as
      | { agentId?: string; status?: string; daemonInstanceId?: string; clientSeq?: number }
      | undefined;
    assert.equal(status?.agentId, "agent-1");
    assert.equal(status?.status, "inactive");
    assert.equal(typeof status?.daemonInstanceId, "string");
    assert.equal(typeof status?.clientSeq, "number");
    const activity = socket.sent.find((message) => (message as { type?: string }).type === "agent:activity");
    assert.ok(activity);
    assert.equal((activity as { activity?: string }).activity, undefined);
    assert.equal((activity as { detailKind?: string }).detailKind, "runtime_unavailable");
    assert.match(JSON.stringify(activity), /Runner credential mint failed/);
    const failureSpan = traceRows(sink, traceId).find((span) => span.name === "daemon.runner_credential_mint.failed");
    assert.ok(failureSpan, "hard-fail should trace runner credential mint failure");
    assert.equal(failureSpan.attrs?.code, "experimental_surface_disabled");
  } finally {
    restoreFetch();
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore retries transient runner credential mint failure before spawn", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];
  let calls = 0;
  const restoreFetch = installDaemonFetchMockForTests((async () => {
    calls += 1;
    if (calls < 3) {
      return new Response(JSON.stringify({ error: "temporary unavailable", code: "server_restarting" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ apiKey: "sk_agent_minted_after_retry", credentialId: "cred-retry" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig({ agentCredentialKey: null }),
    });
    await waitFor(() => driver.spawnCalls.length === 1, "agent spawn after transient runner credential retry");

    assert.equal(calls, 3);
    assert.equal(driver.spawnCalls[0]?.config.agentCredentialKey, "sk_agent_minted_after_retry");
    assert.equal(driver.spawnCalls[0]?.config.agentCredentialId, "cred-retry");
  } finally {
    // Stop before dropping the mock: stop revokes the minted credential over
    // the same fetch, and nothing may leave the process.
    await core.stop();
    restoreFetch();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore acknowledges direct delivery using the embedded message seq when the envelope seq is missing", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig(),
    });
    await waitFor(() => driver.spawnCalls.length === 1, "agent spawn before delivery");

    socket.emitServerMessage({
      type: "agent:deliver",
      agentId: "agent-1",
      seq: 0,
      message: {
        channel_id: "channel-1",
        channel_name: "general",
        channel_type: "channel",
        sender_id: "user-1",
        sender_name: "tygg",
        sender_type: "human",
        content: "weak-network direct delivery",
        timestamp: new Date(0).toISOString(),
        seq: 42,
        message_id: "msg-42",
      },
    });
    await flush();

    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:deliver:ack"
      && msg.agentId === "agent-1"
      && msg.seq === 42
    ));
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore exposes tracked busy transition receipts and ACKs only after turn-end drain", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const sockets: FakeWebSocket[] = [];
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
      }),
  });

  try {
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      launchId: "launch-1",
      config: makeConfig({ sessionId: "session-1" }),
    });
    await waitFor(() => driver.spawnCalls.length === 1, "agent spawn before tracked delivery");

    socket.emitServerMessage({
      type: "agent:deliver",
      agentId: "agent-1",
      seq: 43,
      deliveryId: "mention-occurrence-43",
      mentionDelivery: {
        occurrenceId: "mention-occurrence-43",
        messageId: "mention-message-43",
        machineId: "machine-test",
        launchId: "launch-1",
        sessionId: "session-1",
      },
      message: {
        channel_id: "channel-1",
        channel_name: "general",
        channel_type: "channel",
        sender_id: "user-1",
        sender_name: "tygg",
        sender_type: "human",
        content: "tracked busy mention",
        timestamp: new Date(0).toISOString(),
        seq: 43,
        message_id: "mention-message-43",
      },
    });
    await flush();

    assert.deepEqual(
      socket.sent
        .filter((msg: any) => msg.type === "agent:delivery:transition")
        .map((msg: any) => msg.stage),
      ["daemon_received", "daemon_pending"],
    );
    assert.equal(socket.sent.some((msg: any) => msg.type === "agent:deliver:ack"), false);

    driver.children[0]!.stdout.emit("data", Buffer.from("turn_end\n"));
    await flush();

    assert.deepEqual(
      socket.sent
        .filter((msg: any) => msg.type === "agent:delivery:transition")
        .map((msg: any) => msg.stage),
      ["daemon_received", "daemon_pending", "daemon_drained"],
    );
    const ack = socket.sent.find((msg: any) => msg.type === "agent:deliver:ack") as any;
    assert.ok(ack);
    assert.equal(ack.deliveryId, "mention-occurrence-43");
    assert.equal(ack.mentionDelivery?.occurrenceId, "mention-occurrence-43");
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore does not acknowledge delivery when no process or idle cache can accept it", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:deliver",
      agentId: "agent-1",
      seq: 42,
      message: {
        channel_id: "channel-1",
        channel_name: "general",
        channel_type: "channel",
        sender_id: "user-1",
        sender_name: "tygg",
        sender_type: "human",
        content: "delivery with no local runtime state",
        timestamp: new Date(0).toISOString(),
        seq: 42,
        message_id: "msg-42",
      },
    });
    await flush();

    assert.equal(socket.sent.some((msg: any) => msg.type === "agent:deliver:ack"), false);
    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:status"
      && msg.agentId === "agent-1"
      && msg.status === "inactive"
    ));
    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:activity"
      && msg.agentId === "agent-1"
      && msg.activity === undefined
      && msg.detailKind === "runtime_unavailable"
      && msg.detail === "Process unavailable; restart required"
    ));
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore queues delivery that races with a freshly queued start", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig(),
    });
    socket.emitServerMessage({
      type: "agent:deliver",
      agentId: "agent-1",
      seq: 42,
      message: {
        channel_id: "channel-1",
        channel_name: "all",
        channel_type: "channel",
        sender_id: "system",
        sender_name: "system",
        sender_type: "system",
        content: "startup-race onboarding delivery",
        timestamp: new Date(0).toISOString(),
        seq: 42,
        message_id: "msg-42",
      },
    });

    await waitFor(() => driver.spawnCalls.length === 1, "agent spawn");

    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:deliver:ack"
      && msg.agentId === "agent-1"
      && msg.seq === 42
    ));
    assert.match(driver.spawnCalls[0]!.prompt, /#all/);
    assert.match(driver.spawnCalls[0]!.prompt, /msg-42/);
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore completes legacy runtime profile migration without injection path", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:runtime_profile:migration",
      agentId: "agent-1",
      migrationKey: "migration-1",
      message: "Runtime Profile changed: Model changed",
      launchId: "launch-1",
    });
    await flush();

    assert.equal(socket.sent.some((msg: any) =>
      msg.type === "agent:runtime_profile:migration:ack"
      && msg.agentId === "agent-1"
      && msg.migrationKey === "migration-1"
      && msg.launchId === "launch-1"
    ), true);
    assert.equal(socket.sent.some((msg: any) =>
      msg.type === "agent:runtime_profile:migration_done"
      && msg.agentId === "agent-1"
      && msg.migrationKey === "migration-1"
      && msg.launchId === "launch-1"
    ), true);
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore treats legacy runtime profile wake messages as reset no-ops", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig({ sessionId: "session-1" }),
      wakeMessage: {
        channel_id: "system",
        channel_name: "system",
        channel_type: "dm",
        sender_id: "system",
        sender_name: "system",
        sender_type: "system",
        content: "Runtime Profile changed: Runtime changed",
        timestamp: new Date(0).toISOString(),
        seq: 42,
        message_id: "runtime-profile-migration-migration-1",
      },
      unreadSummary: { "#general": 2 },
      launchId: "launch-1",
    });
    await waitFor(() => driver.spawnCalls.length === 1, "agent spawn");

    const prompt = driver.spawnCalls[0]?.prompt;
    assert.ok(prompt);
    assert.doesNotMatch(prompt, /Runtime Profile notice/);
    assert.doesNotMatch(prompt, /Runtime Profile changed: Runtime changed/);
    assert.doesNotMatch(prompt, /\[target=dm:@system/);
    assert.match(prompt, /You have unread messages from while you were offline/);
    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:runtime_profile:migration:ack"
      && msg.agentId === "agent-1"
      && msg.migrationKey === "migration-1"
      && msg.launchId === "launch-1"
    ));
    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:runtime_profile:migration_done"
      && msg.agentId === "agent-1"
      && msg.migrationKey === "migration-1"
      && msg.launchId === "launch-1"
    ));
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore acknowledges runtime profile control mounted in agent config", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig({
        sessionId: null,
        runtimeProfileControl: {
          kind: "daemon_release_notice",
          key: "release-1",
          message: "Runtime Profile notice: daemon upgraded 0.52.2 -> 0.53.0.",
        },
      }),
      launchId: "launch-1",
    });
    await waitFor(() => driver.spawnCalls.length === 1, "agent spawn");

    assert.equal(driver.spawnCalls[0]?.config.runtimeProfileControl?.key, "release-1");
    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:runtime_profile:daemon_release_notice:ack"
      && msg.agentId === "agent-1"
      && msg.noticeKey === "release-1"
      && msg.launchId === "launch-1"
    ));
    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:activity"
      && msg.agentId === "agent-1"
      && msg.detail === "Runtime Profile notice"
      && msg.entries?.some((entry: any) =>
        entry.kind === "system"
        && entry.title === "Runtime Profile notice"
        && entry.text.includes("Runtime Profile notice: daemon upgraded")
      )
    ));
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore completes runtime profile migration immediately for idle runtimes", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const serverSpan = tracer.startSpan("server.runtime_profile.control.delivery", {
    surface: "server",
    kind: "producer",
  });

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    tracer,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig({ sessionId: "session-1" }),
      launchId: "launch-1",
    });
    await waitFor(() => driver.children.length === 1, "agent child process");
    const child = driver.children[0];
    assert.ok(child, "driver should spawn a child process");
    child.stdout.emit("data", Buffer.from("turn_end\n"));
    await flush();

    socket.emitServerMessage({
      type: "agent:runtime_profile:migration",
      agentId: "agent-1",
      migrationKey: "migration-1",
      message: "Runtime Profile changed: Model changed",
      launchId: "launch-1",
      traceparent: formatTraceparent(serverSpan.context),
    });
    await flush();

    const runtimeProfileWrite = child.stdinWrites.find((chunk) => chunk.includes("Runtime Profile changed: Model changed"));
    assert.equal(runtimeProfileWrite, undefined);
    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:runtime_profile:migration:ack"
      && msg.agentId === "agent-1"
      && msg.migrationKey === "migration-1"
      && msg.launchId === "launch-1"
    ));
    const ack = socket.sent.find((msg: any) =>
      msg.type === "agent:runtime_profile:migration:ack"
      && msg.agentId === "agent-1"
      && msg.migrationKey === "migration-1"
    ) as any;
    assert.ok(ack?.traceparent, "runtime profile ack should carry traceparent");
    const ackParent = parseTraceparent(ack.traceparent);
    assert.ok(ackParent);
    assert.equal(ackParent.traceId, traceId);
    const receivedSpan = traceRows(sink, traceId).find((span) => span.name === "daemon.runtime_profile.control.received");
    const injectSpan = traceRows(sink, traceId).find((span) => span.name === "daemon.runtime_profile.control.inject");
    const stdinSpan = traceRows(sink, traceId).find((span) => span.name === "daemon.agent.stdin_delivery");
    assert.ok(receivedSpan, "daemon should trace runtime profile control receive");
    assert.ok(injectSpan, "daemon should trace runtime profile no-op completion");
    assert.equal(stdinSpan, undefined);
    assert.equal(receivedSpan.context.parentSpanId, serverSpan.context.spanId);
    assert.equal(receivedSpan.attrs?.control_kind, "migration");
    assert.equal(receivedSpan.attrs?.key_present, true);
    assert.equal(injectSpan.context.parentSpanId, receivedSpan.context.spanId);
    assert.equal(injectSpan.attrs?.outcome, "deprecated_noop_completed");
    assert.equal(ackParent.spanId, injectSpan.context.spanId);
    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:runtime_profile:migration_done"
      && msg.agentId === "agent-1"
      && msg.migrationKey === "migration-1"
      && msg.launchId === "launch-1"
    ));
    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:activity"
      && msg.agentId === "agent-1"
      && msg.detail === "Runtime Profile reset"
      && msg.entries?.some((entry: any) =>
        entry.kind === "system"
        && entry.title === "Runtime Profile reset"
        && entry.text.includes("Runtime Profile changed: Model changed")
      )
    ) === false);
  } finally {
    serverSpan.end();
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore logs runtime profile daemon release notices to activity after injection", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const sockets: FakeWebSocket[] = [];

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig({ sessionId: "session-1" }),
      launchId: "launch-1",
    });
    await waitFor(() => driver.children.length === 1, "agent child process");
    const child = driver.children[0];
    assert.ok(child, "driver should spawn a child process");
    child.stdout.emit("data", Buffer.from("turn_end\n"));
    await flush();

    socket.emitServerMessage({
      type: "agent:runtime_profile:daemon_release_notice",
      agentId: "agent-1",
      noticeKey: "notice-1",
      message: "Runtime Profile notice: daemon upgraded 0.40.0 -> 0.40.2.",
      launchId: "launch-1",
    });
    await flush();

    assert.ok(child.stdinWrites.some((chunk) => chunk.includes("Runtime Profile notice: daemon upgraded 0.40.0 -> 0.40.2.")));

    // N24/N26 regression guard: daemon_release_notice deliveries MUST NOT
    // tell the agent to "complete the required runtime control action
    // before responding to normal inbox messages" — release_notice has
    // no associated tool call. The old wording poisoned stateful-session
    // drivers (claude), whose `--resume` carries history across turns:
    // a daemon upgrade stacks multiple release_notice deliveries on an
    // idle agent in one second, each carrying the contradictory
    // instruction. The agent then silently drops outbound sends, waiting
    // for an action that does not exist (confirmed N24 root cause:
    // 4 claude/opus agents, migration_status=stable, all wedged).
    const releaseNoticeWrite = child.stdinWrites.find((chunk) =>
      chunk.includes("Runtime Profile notice: daemon upgraded 0.40.0 -> 0.40.2."),
    );
    assert.ok(releaseNoticeWrite);
    assert.match(releaseNoticeWrite, /Runtime Profile notice/);
    assert.match(
      releaseNoticeWrite,
      /No chat reply or runtime control action is required/,
    );
    assert.doesNotMatch(
      releaseNoticeWrite,
      /Complete the required runtime control action before reading or responding/,
    );

    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:runtime_profile:daemon_release_notice:ack"
      && msg.agentId === "agent-1"
      && msg.noticeKey === "notice-1"
      && msg.launchId === "launch-1"
    ));
    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:activity"
      && msg.agentId === "agent-1"
      && msg.detail === "Runtime Profile notice"
      && msg.entries?.some((entry: any) =>
        entry.kind === "system"
        && entry.title === "Runtime Profile notice"
        && entry.text.includes("Runtime Profile notice: daemon upgraded 0.40.0 -> 0.40.2.")
      )
    ));
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore preserves delivery trace context on ack", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const serverSpan = tracer.startSpan("server.agent.delivery", { surface: "server", kind: "producer" });

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    tracer,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig(),
    });
    await waitFor(() => driver.spawnCalls.length === 1, "agent spawn before delivery");

    socket.emitServerMessage({
      type: "agent:deliver",
      agentId: "agent-1",
      seq: 42,
      deliveryId: "delivery-42",
      traceparent: formatTraceparent(serverSpan.context),
      message: {
        channel_id: "channel-1",
        channel_name: "general",
        channel_type: "channel",
        sender_id: "user-1",
        sender_name: "tygg",
        sender_type: "human",
        content: "weak-network traced direct delivery",
        timestamp: new Date(0).toISOString(),
        seq: 42,
        message_id: "msg-42",
      },
    });
    await flush();

    const ack = socket.sent.find((msg: any) => msg.type === "agent:deliver:ack");
    assert.ok(ack, "daemon should ack delivery");
    assert.equal((ack as any).seq, 42);
    assert.equal((ack as any).deliveryId, "delivery-42");
    const ackParent = parseTraceparent((ack as any).traceparent);
    assert.ok(ackParent, "ack should carry traceparent");
    assert.equal(ackParent.traceId, traceId);

    const daemonSpan = traceRows(sink, traceId).find((span) => span.name === "daemon.agent.delivery");
    assert.ok(daemonSpan, "daemon delivery span should be recorded");
    assert.equal(daemonSpan.context.parentSpanId, serverSpan.context.spanId);
    assert.equal(daemonSpan.attrs?.deliveryId, "delivery-42");
    assert.equal(daemonSpan.attrs?.delivery_correlation_id, "delivery-42");
    assert.equal(ackParent.spanId, daemonSpan.context.spanId);
    // The agent manager's routing fact is recorded while the delivery span is
    // active, so it nests under the delivery instead of floating as a root.
    // Same-millisecond events keep no meaningful order between the span's own
    // events and the manager's point fact, so check the two separately.
    const deliveryEvents = eventsForSpan(sink, traceId, "daemon.agent.delivery");
    assert.deepEqual(deliveryEvents.filter((event) => event.name !== "daemon.agent.delivery.routed").map((event) => event.name), [
      "daemon.receive",
      "daemon.deliver_to_agent_manager",
      "daemon.ack.sent",
    ]);
    const routed = deliveryEvents.filter((event) => event.name === "daemon.agent.delivery.routed");
    assert.equal(routed.length, 1);
    assert.equal(routed[0]?.attrs?.accepted, true);
    assert.equal(routed[0]?.attrs?.process_present, true);
  } finally {
    serverSpan.end();
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore keeps an idle auto-restart outside the delivery span", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer, traceId } = makeDeterministicTracer();
  // The restart strips the managed runner credential and mints a fresh one.
  const restoreFetch = installDaemonFetchMockForTests((async () =>
    new Response(JSON.stringify({ apiKey: "sk_agent_minted_on_restart", credentialId: "cred-restart" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    })) as typeof fetch);
  const serverSpan = tracer.startSpan("server.agent.delivery", { surface: "server", kind: "producer" });

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    tracer,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();
    socket.emitServerMessage({ type: "agent:start", agentId: "agent-1", config: makeConfig() });
    await waitFor(() => driver.spawnCalls.length === 1, "first agent spawn");
    // A clean exit leaves the agent idle with a restart snapshot, so the next
    // delivery has to restart it from inside deliverMessage.
    driver.children[0]!.kill();
    await flush();

    socket.emitServerMessage({
      type: "agent:deliver",
      agentId: "agent-1",
      seq: 43,
      deliveryId: "delivery-43",
      traceparent: formatTraceparent(serverSpan.context),
      message: {
        channel_id: "channel-1",
        channel_name: "general",
        channel_type: "channel",
        sender_id: "user-1",
        sender_name: "tygg",
        sender_type: "human",
        content: "wake an idle agent",
        timestamp: new Date(0).toISOString(),
        seq: 43,
        message_id: "msg-43",
      },
    });
    await waitFor(() => driver.spawnCalls.length === 2, "auto-restart spawn after delivery");
    await waitFor(
      () => traceRows(sink, traceId).some((row) => row.name === "daemon.agent.delivery" && row.attrs?.deliveryId === "delivery-43"),
      "delivery span to end after the restart accepted it",
    );

    const delivery = traceRows(sink, traceId).find((row) => row.name === "daemon.agent.delivery" && row.attrs?.deliveryId === "delivery-43");
    assert.ok(delivery, "delivery span should be recorded");
    const routed = eventsForSpan(sink, traceId, "daemon.agent.delivery").find((event) => event.name === "daemon.agent.delivery.routed");
    assert.equal(routed?.attrs?.outcome, "auto_restart_from_idle", "the routing fact belongs to the delivery");

    // The restart outlives the delivery: its start facts must not hang off the
    // delivery span that happened to trigger it.
    const rows = traceRows(sink);
    for (const name of ["daemon.agent.start.requested", "daemon.agent.start.queued", "daemon.agent.start.dequeued"]) {
      const facts = rows.filter((row) => row.name === name);
      assert.equal(facts.length, 2, `one ${name} fact per start`);
      for (const row of facts) assert.equal(row.context.parentSpanId, null, `${name} must not inherit the delivery span`);
    }
    const spawns = rows.filter((row) => row.name === "daemon.agent.spawn");
    assert.equal(spawns.length, 2);
    for (const row of spawns) assert.notEqual(row.context.parentSpanId, delivery.context.spanId);
  } finally {
    serverSpan.end();
    // Stop before dropping the mock: stop revokes the minted credential over
    // the same fetch, and nothing may leave the process.
    await core.stop();
    restoreFetch();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore writes local rotating trace file under machine directory when enabled", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-local-trace-core-test-"));
  const dataDir = path.join(rootDir, "agents");
  const machineStateDir = path.join(rootDir, "machines");
  const sockets: FakeWebSocket[] = [];
  let stopped = false;

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    machineStateDir,
    localTrace: true,
    localTraceMaxFileBytes: 1024 * 1024,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();
    socket.emitServerMessage({
      type: "agent:deliver",
      agentId: "agent-1",
      seq: 7,
      message: {
        id: "message-1",
        message_id: "message-1",
        seq: 7,
        channel_id: "channel-1",
        channel_name: "general",
        channel_type: "channel",
        sender_id: "user-1",
        sender_name: "tygg",
        sender_type: "human",
        content: "hello",
        created_at: "2026-05-05T00:00:00.000Z",
        attachments: [],
      } as any,
    });
    await flush();
    await core.stop();
    stopped = true;

    const machineDirs = await readdir(machineStateDir);
    assert.equal(machineDirs.length, 1);
    const traceDir = path.join(machineStateDir, machineDirs[0], "traces");
    const traceFiles = await readdir(traceDir);
    assert.equal(traceFiles.length, 1);
    const raw = await readFile(path.join(traceDir, traceFiles[0]), "utf8");
    assert.match(raw, /daemon\.lifecycle\.start/);
    assert.match(raw, /daemon\.connection\.connect"/);
    assert.match(raw, /daemon\.ready\.sent/);
    assert.match(raw, /daemon\.lifecycle\.stop/);
    assert.match(raw, /daemon\.agent\.delivery/);
    assert.equal(raw.includes("agent-1"), true);
    assert.equal(raw.includes("message-1"), true);
    assert.equal(raw.includes("hello"), false);
  } finally {
    if (!stopped) await core.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

async function assertDaemonSpawnFailureProjection(options: {
  rawSpawnDetail: string;
  /** task #1120: classification is by typed code; the classified case must throw a typed error. */
  spawnError?: (rawDetail: string) => Error;
  expectedReason: string;
  expectedClassification: string;
  expectedUserMessage: string;
  sensitivePattern: RegExp;
}): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const logMessages: string[] = [];
  const unsubscribeLogs = subscribeDaemonLogs((event) => {
    if (event.level === "ERROR") logMessages.push(event.message);
  });

  class FailingDriver extends FakeDriver {
    override spawn(ctx: SpawnContext): SpawnResult {
      this.spawnCalls.push(ctx);
      throw options.spawnError ? options.spawnError(options.rawSpawnDetail) : new Error(options.rawSpawnDetail);
    }
  }
  const driver = new FailingDriver();

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      }),
    tracer,
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig(),
      launchId: "launch-1",
    });
    await waitFor(
      () => socket.sent.some((message) => (message as { type?: string }).type === "agent:activity"),
      "spawn failure activity",
    );

    assert.equal(driver.spawnCalls.length, 1);
    const status = socket.sent.find((message) =>
      (message as { type?: string; agentId?: string }).type === "agent:status" &&
      (message as { agentId?: string }).agentId === "agent-1"
    );
    assert.ok(status);
    assert.equal((status as { status?: string }).status, "inactive");

    const activity = socket.sent.find((message) =>
      (message as { type?: string; agentId?: string }).type === "agent:activity" &&
      (message as { agentId?: string }).agentId === "agent-1"
    );
    assert.ok(activity);
    assert.equal((activity as { detail?: string }).detail, options.expectedUserMessage);
    assert.doesNotMatch((activity as { detail?: string }).detail ?? "", options.sensitivePattern);
    assert.ok(
      logMessages.some((message) => message.includes(options.rawSpawnDetail)),
      "the same raw spawn detail must remain available in daemon logs",
    );

    const failureSpan = traceRows(sink, traceId).find((span) => span.name === "daemon.agent.spawn.failed");
    assert.ok(failureSpan, "spawn failure should emit daemon.agent.spawn.failed trace");
    assert.equal(failureSpan.attrs?.failure_reason, options.expectedReason);
    assert.equal(failureSpan.attrs?.failure_classification, options.expectedClassification);
    assert.equal(failureSpan.attrs?.agentId, "agent-1");
    assert.equal(failureSpan.attrs?.launchId, "launch-1");
    assert.equal(failureSpan.attrs?.failure_detail, undefined);
    assert.doesNotMatch(JSON.stringify(failureSpan.attrs), options.sensitivePattern);
  } finally {
    unsubscribeLogs();
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("DaemonCore keeps unclassified spawn detail in logs but out of user activity and traces", async () => {
  await assertDaemonSpawnFailureProjection({
    rawSpawnDetail:
      "bootstrap exploded: credential=credential-poison endpoint=https://private.example token=token-poison",
    expectedReason: "runtime_spawn_failed",
    expectedClassification: "unclassified_fallback",
    expectedUserMessage: "Runtime failed to start. Check the Computer logs for details and retry.",
    sensitivePattern: /credential-poison|private\.example|token-poison/,
  });
});

test("DaemonCore emits structured trace and user-friendly activity on classified spawn failure", async () => {
  await assertDaemonSpawnFailureProjection({
    rawSpawnDetail: "Agent Credential Proxy local proxy failed to bind 127.0.0.1 after 3 attempts: "
      + "listen EACCES; Bearer sk-reviewer-secret https://provider.example/private",
    spawnError: (rawDetail) => new AgentProxyBindError(rawDetail),
    expectedReason: "agent_proxy_bind_failed",
    expectedClassification: "classified",
    expectedUserMessage:
      "Local agent proxy could not start. Check if another daemon or service is using the required local port.",
    sensitivePattern: /sk-reviewer-secret|provider\.example/,
  });
});

// WAKE-SLOT EXCLUSION, added 2026-08-20. @Hipp found during review of #6700 that this clause was
// load-bearing with NO test: deleting `&& !delivery.mentionDelivery` would silently make mentions
// unrecoverable and nothing would go red.
//
// WHY IT IS LOAD-BEARING. The chosen wake delivery is SPLICED OUT of the replay list, so it never
// passes through handleMessage — and handleMessage is where the occurrence transitions
// (daemon_received / daemon_pending / daemon_drained) are emitted. A mention promoted to the wake
// slot would therefore be delivered while its occurrence stayed at "recorded, never delivered":
// exactly the unrecoverable state this spine exists to remove. Excluding mentions here keeps them
// on the instrumented path; it does not withhold them, and it does not stop the agent starting,
// because agent:start is what triggers the start, not the presence of a wake message.
//
// Tested through the extracted pure function rather than the live path on purpose: reaching the
// real call site needs a timing race against agent start, and a flaky arm here would be worse
// than no arm — it would produce reassurance at random.
const wakeD = (over: Record<string, unknown> = {}) => ({
  type: "agent:deliver", agentId: "agent-1", seq: 1, message: {}, ...over,
}) as never;

test("selectWakeDeliveryIndex never promotes a mention delivery to the wake slot", () => {
  // the whole list is mentions ⇒ nothing may be promoted
  assert.equal(selectWakeDeliveryIndex([
    wakeD({ mentionDelivery: { occurrenceId: "o1" } }),
    wakeD({ mentionDelivery: { occurrenceId: "o2" } }),
  ]), -1, "a list of only mentions must yield no wake delivery");

  // a mention must never be chosen even when it is first
  assert.equal(selectWakeDeliveryIndex([
    wakeD({ mentionDelivery: { occurrenceId: "o1" } }),
    wakeD({}),
  ]), 1, "the non-mention must be chosen over an earlier mention");

  // NEGATIVE CONTROL: without mentions the function still picks, so -1 above is about the
  // exclusion and not about the function being inert.
  assert.equal(selectWakeDeliveryIndex([wakeD({}), wakeD({})]), 0, "a plain delivery is promotable");

  // NOTE: no `transient` assertion lives in this arm. The first draft had one, labelled "fixture
  // precondition, never this arm's subject" — and @Hipp's criterion ⓓ killed it: suppressing the
  // UNRELATED transient clause reddened this arm, so it was not green "only because of" the
  // mention exclusion. A comment saying an assertion is out of scope does not put it out of scope.
  // transient gets its own arm below.
});

test("selectWakeDeliveryIndex never promotes a transient delivery to the wake slot", () => {
  assert.equal(selectWakeDeliveryIndex([wakeD({ transient: true })]), -1,
    "a transient-only list must yield no wake delivery");
  assert.equal(selectWakeDeliveryIndex([wakeD({ transient: true }), wakeD({})]), 1,
    "the durable delivery must be chosen over an earlier transient one");
  // NEGATIVE CONTROL, so -1 above is about `transient` and not about the function being inert.
  assert.equal(selectWakeDeliveryIndex([wakeD({})]), 0, "a plain delivery is promotable");
});

test("DaemonCore answers an agent:deliver for an agent with no process and no snapshot with a typed agent:delivery:rejected (task #1113)", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const sockets: FakeWebSocket[] = [];
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
      }),
  });
  try {
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    // No agent:start ever reached this daemon (e.g. it restarted): deliver straight away.
    socket.emitServerMessage({
      type: "agent:deliver",
      agentId: "agent-1",
      seq: 0,
      deliveryId: "delivery-77",
      message: {
        channel_id: "channel-1",
        channel_name: "general",
        channel_type: "channel",
        sender_id: "user-1",
        sender_name: "tygg",
        sender_type: "human",
        content: "wake me",
        timestamp: new Date(0).toISOString(),
        seq: 77,
        message_id: "msg-77",
      },
    });
    await flush();
    assert.equal(driver.spawnCalls.length, 0, "the daemon has no config to spawn from");
    const rejections = socket.sent.filter((msg: any) => msg.type === "agent:delivery:rejected") as any[];
    assert.equal(rejections.length, 1, "exactly one typed rejection reaches the Server");
    assert.equal(rejections[0].agentId, "agent-1");
    assert.equal(rejections[0].seq, 77);
    assert.equal(rejections[0].deliveryId, "delivery-77");
    assert.equal(rejections[0].reason, "no_process");
    assert.ok(!socket.sent.some((msg: any) => msg.type === "agent:deliver:ack"), "a rejected delivery is never acked as delivered");
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("retired Wiki wire requests reject without installing a workspace or starting an Agent", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-retired-wiki-"));
  const socket = new FakeWebSocket();
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    runtimeDetector: () => ({ ids: [], versions: {} }),
    connectionOptions: { wsFactory: () => socket },
  });
  try {
    core.start();
    socket.emitOpen();
    await waitFor(() => socket.sent.some((m) => (m as { type?: string }).type === "ready"), "ready");
    const ready = socket.sent.find((m) => (m as { type?: string }).type === "ready") as Extract<MachineToServerMessage, { type: "ready" }>;
    assert.equal(ready.capabilities?.includes("wiki-workspace-pack:v1"), false);
    const pack = { protocolVersion: 1 as const, packId: "retired", files: [] };
    socket.emitServerMessage({ type: "agent:workspace:ensure-wiki", agentId: "retired-agent", requestId: "retired-request", pack });
    socket.emitServerMessage({ type: "agent:start:wiki", agentId: "retired-agent", config: makeConfig(), wikiWorkspacePack: pack });
    const response = socket.sent.find((m) => (m as { type?: string }).type === "agent:workspace:wiki_ensured") as Extract<MachineToServerMessage, { type: "agent:workspace:wiki_ensured" }>;
    assert.equal(response.success, false);
    assert.deepEqual(response.files, []);
    assert.match(response.error ?? "", /retired/);
    assert.ok(socket.sent.some((m) => (m as { type?: string; status?: string }).type === "agent:status" && (m as { status?: string }).status === "inactive"));
    assert.equal(existsSync(path.join(dataDir, "agents", "retired-agent")), false);
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("target control steps retry transient failures and never replay a step that already committed", async () => {
  const view = (state: string, generation: string) => ({
    migrationId: "migration",
    migrationRef: "mig_FFFFFFFFFFFFFFFFFFFFFF",
    migrationGeneration: generation,
    state,
    sourceMachineId: "source",
    targetMachineId: "target",
    agentId: "agent",
    manifestPath: null,
    manifestSha256: null,
    canDriveTargetImport: true,
  }) as unknown as MigrationTargetImportView;
  const noWait = async () => undefined;

  // Lost response: the flip committed server-side; the retry reads the view and stops.
  const posted: string[] = [];
  const flipped = await retryMigrationTargetStep({
    step: "flip-machine",
    body: { migrationGeneration: "g6" },
    post: async (body) => {
      posted.push(body.migrationGeneration);
      throw new TypeError("fetch failed");
    },
    fetchView: async () => view("arriving", "g7"),
    wait: noWait,
  });
  assert.equal(flipped.state, "arriving");
  assert.deepEqual(posted, ["g6"], "a committed step is not replayed");

  // Deploy 503, not committed: resend the identical request until it succeeds.
  const attempts: string[] = [];
  const arrived = await retryMigrationTargetStep({
    step: "arrived",
    body: { migrationGeneration: "g7", reportPath: "r", reportSha256: "s" },
    post: async (body) => {
      attempts.push(body.migrationGeneration);
      if (attempts.length < 3) throw new Error("MIGRATION_TARGET_IMPORT_ARRIVED_FAILED:503:http_error");
      return view("completed", "g9");
    },
    fetchView: async () => view("arriving", "g7"),
    wait: noWait,
  });
  assert.equal(arrived.state, "completed");
  assert.deepEqual(attempts, ["g7", "g7", "g7"]);

  // A superseded generation (canceled / re-provisioned) ends the run; it never borrows the new one.
  const superseded: string[] = [];
  await assert.rejects(retryMigrationTargetStep({
    step: "flip-machine",
    body: { migrationGeneration: "g6" },
    post: async (body) => {
      superseded.push(body.migrationGeneration);
      throw new Error("MIGRATION_TARGET_IMPORT_FLIP_MACHINE_FAILED:502:http_error");
    },
    fetchView: async () => view("in_transit", "g6-new"),
    wait: noWait,
  }), /MIGRATION_TARGET_STEP_GENERATION_SUPERSEDED/);
  assert.deepEqual(superseded, ["g6"]);

  // A 4xx decision is final.
  let decisions = 0;
  await assert.rejects(retryMigrationTargetStep({
    step: "start-transfer",
    body: { migrationGeneration: "g4" },
    post: async () => {
      decisions += 1;
      throw new Error("MIGRATION_TARGET_IMPORT_START_TRANSFER_FAILED:409:migration_not_ready");
    },
    fetchView: async () => view("ready", "g4"),
    wait: noWait,
  }), /409/);
  assert.equal(decisions, 1);

  // The retry budget is bounded.
  let clock = 0;
  await assert.rejects(retryMigrationTargetStep({
    step: "arrived",
    body: { migrationGeneration: "g7" },
    post: async () => { throw new Error("MIGRATION_TARGET_IMPORT_ARRIVED_FAILED:502:http_error"); },
    fetchView: async () => view("arriving", "g7"),
    wait: async (ms) => { clock += ms; },
    nowMs: () => clock,
  }), /502/);
  assert.ok(clock <= 5 * 60_000);
});

test("source bundle-build progress is throttled, flushes the last skipped report, and stops after a 404", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-progress-test-"));
  const migrationId = "migration-progress";
  const reports: Array<Record<string, unknown>> = [];
  let status = 200;
  const server = await withHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === `/internal/computer/agent-migrations/by-id/${migrationId}/resumable/source-progress`) {
      reports.push(JSON.parse((await readRequestBody(req)).toString("utf8")) as Record<string, unknown>);
      res.statusCode = status;
      res.end("{}");
      return;
    }
    res.statusCode = 500;
    res.end();
  });
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const core = new DaemonCore({
    serverUrl: server.baseUrl,
    apiKey: "sk_machine_test",
    dataDir,
    slockHome: dataDir,
    runtimeDetector: () => ({ ids: [], versions: {} }),
  });
  try {
    const reporter = (core as unknown as {
      createMigrationSourceProgressReporter: (
        lease: Record<string, unknown>,
        signal: AbortSignal,
      ) => (progress: { phase: "scanning" | "packing" | "hashing"; files: number; bytes: number }) => void;
    }).createMigrationSourceProgressReporter({
      migrationId,
      transportGeneration: "generation-progress",
      bearerToken: "token-progress",
      controlUrl: `/internal/computer/agent-migrations/by-id/${migrationId}/resumable`,
    }, new AbortController().signal);
    const waitForReports = async (count: number) => {
      for (let attempt = 0; attempt < 600 && reports.length < count; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };

    reporter({ phase: "scanning", files: 1, bytes: 10 });
    now += 29_999;
    reporter({ phase: "scanning", files: 2, bytes: 20 });
    now += 1;
    reporter({ phase: "scanning", files: 3, bytes: 30 });
    await waitForReports(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(reports, [
      { migrationGeneration: "generation-progress", phase: "scanning", files: 3, bytes: 30 },
    ]);

    // A report skipped by the throttle is flushed when the interval ends.
    now += 29_000;
    reporter({ phase: "scanning", files: 5, bytes: 50 });
    now += 1_000;
    await waitForReports(2);
    assert.deepEqual(reports[1], { migrationGeneration: "generation-progress", phase: "scanning", files: 5, bytes: 50 });

    status = 404;
    now += 30_000;
    reporter({ phase: "packing", files: 1, bytes: 5 });
    await waitForReports(3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    now += 30_000;
    reporter({ phase: "packing", files: 2, bytes: 9 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(reports.length, 3, "a 404 disables further reports for this run");
  } finally {
    Date.now = realNow;
    await core.stop();
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
