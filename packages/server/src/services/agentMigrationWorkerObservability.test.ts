import assert from "node:assert/strict";
import type { Server as SocketServer } from "socket.io";
import {
  startAgentMigrationReceiptOutboxWorker,
} from "./agentMigrationReceiptService";
import {
  startAgentMigrationRemediationWorker,
} from "./agentMigrationRemediationWorker";
import type { AgentOrchestrator } from "./agentOrchestrator";
import {
  createAgentMigrationWorkerObservability,
  type AgentMigrationWorkerDrainOutcome,
  type AgentMigrationWorkerObservation,
  type AgentMigrationWorkerObservability,
} from "./agentMigrationWorkerObservability";

const BUILD_IDENTITY = {
  ok: true as const,
  identity: {
    sha: "0123456789abcdef0123456789abcdef01234567",
    builtAt: "2026-08-21T20:00:00.000Z",
    branch: "staging",
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function captureObservability(worker: "receipt_outbox" | "remediation") {
  const observations: AgentMigrationWorkerObservation[] = [];
  let nowMs = Date.parse("2026-08-21T20:01:00.000Z");
  const observability = createAgentMigrationWorkerObservability({
    worker,
    now: () => new Date(nowMs),
    runtimeId: "7f94335a-8ebc-4dbb-bec7-b13a991cb684",
    serverVersion: "1.9.6",
    buildIdentity: BUILD_IDENTITY,
    outcomeHeartbeatMs: 300_000,
    emit: (observation) => observations.push(observation),
  });
  return {
    observations,
    observability,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

async function waitForObservation(
  observations: AgentMigrationWorkerObservation[],
  predicate: (observation: AgentMigrationWorkerObservation) => boolean,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!observations.some(predicate)) {
    if (Date.now() >= deadline) throw new Error("OBSERVATION_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("worker observability emits one bounded, release-bound, privacy-safe lifecycle", () => {
  const capture = captureObservability("receipt_outbox");
  capture.observability.startup();
  capture.observability.startup();
  capture.observability.drain("empty");
  capture.advance(5_000);
  capture.observability.drain("served");
  capture.observability.drain("empty");
  capture.advance(295_000);
  capture.observability.drain("served");

  assert.deepEqual(capture.observations.map(({ event, outcome }) => ({ event, outcome })), [
    { event: "startup", outcome: "started" },
    { event: "drain", outcome: "empty" },
    { event: "drain", outcome: "served" },
  ]);
  assert.deepEqual(Object.keys(capture.observations[0]!).sort(), [
    "event",
    "observed_at",
    "outcome",
    "release_branch",
    "release_built_at",
    "release_identity",
    "release_sha",
    "runtime_id",
    "server_version",
    "worker",
  ]);
  assert.deepEqual(capture.observations[0], {
    event: "startup",
    worker: "receipt_outbox",
    outcome: "started",
    observed_at: "2026-08-21T20:01:00.000Z",
    runtime_id: "7f94335a-8ebc-4dbb-bec7-b13a991cb684",
    server_version: "1.9.6",
    release_identity: "available",
    release_sha: "0123456789abcdef0123456789abcdef01234567",
    release_branch: "staging",
    release_built_at: "2026-08-21T20:00:00.000Z",
  });
});

test("receipt retry exhaustion is reported every time, with ids and a code-shaped error only", () => {
  const capture = captureObservability("receipt_outbox");
  capture.observability.drain("failed");
  const row = {
    outboxId: "0d6f4f43-7f0e-4a51-9b55-2b1b8f0c9a11",
    migrationId: "5b0c2c1e-2a35-4f0a-8d7e-8b6d8f2b6a22",
    receiptKind: "completed",
    attemptCount: 20,
  };
  capture.observability.receiptRetryExhausted?.({
    ...row,
    lastError: "SYSTEM_MESSAGE_AGENT_DELIVERY_DROPPED:cross_replica_receipt_unavailable",
  });
  capture.observability.receiptRetryExhausted?.({ ...row, lastError: "free text with a secret-ish value" });

  const parked = capture.observations.filter((observation) => observation.event === "receipt_retry_exhausted");
  assert.equal(parked.length, 2, "not folded into the drain heartbeat");
  assert.deepEqual(
    parked.map(({ outcome, outbox_id, migration_id, receipt_kind, attempt_count, last_error_code }) => ({
      outcome, outbox_id, migration_id, receipt_kind, attempt_count, last_error_code,
    })),
    [
      {
        outcome: "parked",
        outbox_id: row.outboxId,
        migration_id: row.migrationId,
        receipt_kind: "completed",
        attempt_count: 20,
        last_error_code: "SYSTEM_MESSAGE_AGENT_DELIVERY_DROPPED:cross_replica_receipt_unavailable",
      },
      {
        outcome: "parked",
        outbox_id: row.outboxId,
        migration_id: row.migrationId,
        receipt_kind: "completed",
        attempt_count: 20,
        last_error_code: "unclassified",
      },
    ],
  );
  assert.equal(JSON.stringify(capture.observations).includes("secret-ish"), false);
});

test("worker observability emits a failure transition immediately, bounds repeats, and never controls work", () => {
  const capture = captureObservability("remediation");
  capture.observability.startup();
  capture.observability.drain("empty");
  capture.advance(5_000);
  capture.observability.drain("failed");
  capture.advance(5_000);
  capture.observability.drain("failed");
  assert.deepEqual(capture.observations.map(({ event, outcome }) => ({ event, outcome })), [
    { event: "startup", outcome: "started" },
    { event: "drain", outcome: "empty" },
    { event: "drain", outcome: "failed" },
  ]);

  const throwing = createAgentMigrationWorkerObservability({
    worker: "remediation",
    buildIdentity: BUILD_IDENTITY,
    emit: () => {
      throw new Error("sink unavailable");
    },
  });
  assert.doesNotThrow(() => {
    throwing.startup();
    throwing.drain("served");
  });
});

test("worker observability carries the bounded error identity on a failed drain", () => {
  const capture = captureObservability("receipt_outbox");
  capture.observability.startup();
  capture.observability.drain("failed", new TypeError("pg unavailable"));
  capture.advance(5_000);
  capture.observability.drain("failed", new Error("still down"));
  assert.deepEqual(
    capture.observations
      .filter((observation) => observation.event === "drain")
      .map(({ outcome, error_class }) => ({ outcome, error_class })),
    [{ outcome: "failed", error_class: "TypeError" }],
  );

  // Non-Error throws land on the typeof branch; success observations never
  // carry an error identity. An Error whose writable `name` was emptied is
  // neither a class nor a blank — it routes to the "unknown" sentinel.
  capture.advance(300_000);
  capture.observability.drain("failed", "plain string failure");
  const last = capture.observations.at(-1);
  assert.equal(last?.outcome, "failed");
  assert.equal(last?.error_class, "string");
  const nameless = new Error("nameless");
  nameless.name = "";
  capture.advance(300_000);
  capture.observability.drain("failed", nameless);
  assert.equal(capture.observations.at(-1)?.error_class, "unknown");
  capture.advance(300_000);
  capture.observability.drain("served");
  assert.equal(capture.observations.at(-1)?.error_class, undefined);
});

test("unavailable build identity never reflects invalid environment candidates", () => {
  const observations: AgentMigrationWorkerObservation[] = [];
  const observability = createAgentMigrationWorkerObservability({
    worker: "receipt_outbox",
    buildIdentity: {
      ok: false,
      code: "build_identity_unavailable",
      reason: "invalid",
      identity: {
        sha: "credential-shaped-value",
        branch: "private-branch-value",
        builtAt: "invalid-time-value",
      },
    },
    emit: (observation) => observations.push(observation),
  });
  observability.startup();
  assert.equal(observations[0]!.release_identity, "unavailable");
  assert.equal(observations[0]!.release_sha, null);
  assert.equal(observations[0]!.release_branch, null);
  assert.equal(observations[0]!.release_built_at, null);
  assert.equal(JSON.stringify(observations).includes("credential-shaped-value"), false);
});

test("receipt worker classifies empty, served, returned failure, and thrown failure without leaking drain data", async () => {
  const cases: Array<{
    name: string;
    result?: { attempted: number; sent: number; failed: number; migrationId?: string; payload?: string };
    error?: Error;
    expected: AgentMigrationWorkerDrainOutcome;
  }> = [
    { name: "empty", result: { attempted: 0, sent: 0, failed: 0 }, expected: "empty" },
    {
      name: "served",
      result: { attempted: 1, sent: 1, failed: 0, migrationId: "must-not-leak", payload: "must-not-leak" },
      expected: "served",
    },
    { name: "returned failure", result: { attempted: 1, sent: 0, failed: 1 }, expected: "failed" },
    { name: "thrown failure", error: new Error("raw-secret-must-not-enter-observation"), expected: "failed" },
  ];

  for (const entry of cases) {
    const capture = captureObservability("receipt_outbox");
    const drained = deferred<void>();
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const worker = startAgentMigrationReceiptOutboxWorker({
        io: {} as SocketServer,
        orchestrator: {} as AgentOrchestrator,
        intervalMs: 60_000,
        observability: capture.observability,
        drainOutbox: async () => {
          drained.resolve();
          if (entry.error) throw entry.error;
          return entry.result!;
        },
      });
      await drained.promise;
      await waitForObservation(capture.observations, (observation) => observation.outcome === entry.expected);
      worker.stop();
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(
      capture.observations.filter((observation) => observation.event === "startup").length,
      1,
      `${entry.name} must emit exactly one receipt-worker startup`,
    );
    const serialized = JSON.stringify(capture.observations);
    assert.equal(serialized.includes("must-not-leak"), false, entry.name);
    assert.equal(serialized.includes("raw-secret"), false, entry.name);
  }
});

test("remediation worker reports work only when a remediation path served", async () => {
  for (const entry of [
    { result: { autoStart: false, cancellation: false, deadline: false, sourceArchive: false }, expected: "empty" as const },
    { result: { autoStart: true, cancellation: false, deadline: false, sourceArchive: false }, expected: "served" as const },
    { result: { autoStart: false, cancellation: true, deadline: false, sourceArchive: false }, expected: "served" as const },
    { result: { autoStart: false, cancellation: false, deadline: true, sourceArchive: false }, expected: "served" as const },
    { result: { autoStart: false, cancellation: false, deadline: false, sourceArchive: true }, expected: "served" as const },
  ]) {
    const capture = captureObservability("remediation");
    const drained = deferred<void>();
    const worker = startAgentMigrationRemediationWorker({
      io: {} as SocketServer,
      orchestrator: {} as AgentOrchestrator,
      intervalMs: 60_000,
      observability: capture.observability,
      drainRemediation: async () => {
        drained.resolve();
        return entry.result;
      },
    });
    await drained.promise;
    await waitForObservation(capture.observations, (observation) => observation.outcome === entry.expected);
    worker.stop();
    assert.equal(
      capture.observations.filter((observation) => observation.event === "startup").length,
      1,
      "remediation worker must emit exactly one startup",
    );
  }
});
