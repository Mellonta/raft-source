import assert from "node:assert/strict";
import {
  assertSurfaceProducerFactLineage,
  stripSurfaceProducerFactLineage,
} from "@botiverse/raft-shared";
import { buildFeedbackExportBundle, snapshotAgentMachine } from "../src/utils/feedbackExportBundle";

test("feedback export v2 distinguishes ephemeral activity buffer from durable trajectory history", () => {
  const bundle = buildFeedbackExportBundle({
    generatedAt: "2026-04-16T13:52:00.000Z",
    appVersion: "0.1.0+abc123",
    daemonVersion: "1.2.3",
    description: "agent stalled after reconnect",
    reporter: {
      id: "u-1",
      email: "dev@slock.ai",
      name: "Dev",
      displayName: "Dev User",
    },
    server: {
      id: "s-1",
      slug: "demo",
      name: "Demo",
    },
    agent: {
      id: "a-1",
      name: "cindy",
      displayName: "Cindy",
      description: "Onboarding assistant",
      status: "active",
      runtime: "codex",
      model: "gpt-5.4",
      reasoningEffort: "medium",
      machineId: "m-1",
      machineName: "Mac mini",
      machineStatus: "online",
      machineOs: "darwin",
      machineComputerVersion: "1.0.40",
      machineLastHeartbeat: "2026-04-16T13:51:30.000Z",
    },
    recentMessages: [{ id: "msg-1" }],
    ephemeralActivityBuffer: [{ activity: "working" }],
    durableTrajectoryLog: [{
      entry: {
        kind: "slock_action",
        producerFactId: "freshness_decision_fact:feedback-readout",
        title: "Send held by freshness check",
        text: "new messages: 1",
      },
      timestamp: 1,
    }],
    browser: {
      url: "https://example.test",
      userAgent: "Mozilla/5.0",
      language: "en-US",
      languages: ["en-US"],
      platform: "MacIntel",
      timezone: "Asia/Shanghai",
      viewport: { width: 1440, height: 900 },
      screen: { width: 1440, height: 900 },
    },
  });

  assert.equal(bundle.schemaVersion, "slock-feedback-export-v2");
  assert.equal(bundle.logs.ephemeralActivityBuffer.durability, "ephemeral");
  assert.equal(bundle.logs.ephemeralActivityBuffer.source, "client_socket_buffer");
  assert.equal(bundle.logs.durableTrajectoryLog.durability, "durable");
  assert.equal(bundle.logs.durableTrajectoryLog.source, "server_activity_log");
  assert.deepEqual(bundle.activityLog, [{ activity: "working" }]);
  assert.deepEqual(bundle.trajectoryLog, [
    {
      entry: {
        kind: "slock_action",
        producerFactId: "freshness_decision_fact:feedback-readout",
        title: "Send held by freshness check",
        text: "new messages: 1",
      },
      timestamp: 1,
    },
  ]);
  assert.deepEqual(bundle.logs.ephemeralActivityBuffer.entries, [{ activity: "working" }]);
  assert.deepEqual(bundle.logs.durableTrajectoryLog.entries, [
    {
      entry: {
        kind: "slock_action",
        producerFactId: "freshness_decision_fact:feedback-readout",
        title: "Send held by freshness check",
        text: "new messages: 1",
      },
      timestamp: 1,
    },
  ]);
  assertSurfaceProducerFactLineage(
    bundle,
    ["freshness_decision_fact:feedback-readout"],
    "feedback export bundle",
  );
  assert.throws(
    () => assertSurfaceProducerFactLineage(
      stripSurfaceProducerFactLineage(bundle),
      ["freshness_decision_fact:feedback-readout"],
      "feedback export bundle stripped",
    ),
    /producerFactId mismatch/,
  );
});

test("feedback export v2 keeps omitted log sections explicit", () => {
  const bundle = buildFeedbackExportBundle({
    appVersion: null,
    daemonVersion: null,
    description: "",
    reporter: {
      id: null,
      email: null,
      name: null,
      displayName: null,
    },
    server: {
      id: null,
      slug: null,
      name: null,
    },
    agent: {
      id: "a-2",
      name: "agent-2",
      displayName: null,
      description: null,
      status: "inactive",
      runtime: "codex",
      model: "gpt-5.4-mini",
      reasoningEffort: null,
      machineId: null,
      machineName: null,
      machineStatus: null,
      machineOs: null,
      machineComputerVersion: null,
      machineLastHeartbeat: null,
    },
    recentMessages: null,
    ephemeralActivityBuffer: null,
    durableTrajectoryLog: null,
    includeRecentMessages: true,
    includeEphemeralActivityBuffer: true,
    includeDurableTrajectoryLog: false,
    browser: {
      url: "https://example.test",
      userAgent: "Mozilla/5.0",
      language: "en-US",
      languages: ["en-US"],
      platform: "MacIntel",
      timezone: "Asia/Shanghai",
      viewport: { width: 1280, height: 720 },
      screen: { width: 1280, height: 720 },
    },
  });

  assert.equal(bundle.issue.description, null);
  assert.equal(bundle.logs.recentMessages.included, true);
  assert.equal(bundle.logs.ephemeralActivityBuffer.included, true);
  assert.equal(bundle.logs.durableTrajectoryLog.included, false);
  assert.equal(bundle.logs.ephemeralActivityBuffer.entries, null);
  assert.equal(bundle.logs.durableTrajectoryLog.entries, null);
  assert.equal(bundle.activityLog, null);
  assert.equal(bundle.trajectoryLog, null);
});

test("agent machine snapshot carries the machine's own OS, versions and heartbeat", () => {
  assert.deepEqual(snapshotAgentMachine({
    name: "Mac mini",
    status: "online",
    os: "darwin",
    computerVersion: "1.0.40",
    daemonVersion: "1.0.41",
    lastHeartbeat: "2026-04-16T13:51:30.000Z",
  }), {
    machineName: "Mac mini",
    machineStatus: "online",
    machineOs: "darwin",
    machineComputerVersion: "1.0.40",
    machineLastHeartbeat: "2026-04-16T13:51:30.000Z",
    daemonVersion: "1.0.41",
  });
});

test("agent machine snapshot keeps unknown facts null", () => {
  const unknown = {
    machineName: null,
    machineStatus: null,
    machineOs: null,
    machineComputerVersion: null,
    machineLastHeartbeat: null,
    daemonVersion: null,
  };
  assert.deepEqual(snapshotAgentMachine(null), unknown);
  assert.deepEqual(snapshotAgentMachine(undefined), unknown);
  assert.deepEqual(snapshotAgentMachine({
    name: "raw daemon",
    status: "offline",
    os: "  ",
    daemonVersion: "1.0.16",
    lastHeartbeat: null,
  }), {
    ...unknown,
    machineName: "raw daemon",
    machineStatus: "offline",
    daemonVersion: "1.0.16",
  });
});
