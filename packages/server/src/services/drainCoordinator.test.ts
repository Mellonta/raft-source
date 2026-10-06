import assert from "node:assert/strict";

import {
  createControlPlaneDrainSource,
  createDrainCoordinator,
  createMetadataDrainSource,
  readEcsTaskIdentity,
  startDrainCoordinator,
  type DrainSignalSource,
} from "./drainCoordinator";

/**
 * The drain coordinator is the only component that can fire the going-away
 * phase early enough to beat the ALB hard cut (task #261). Task #268 moved
 * the primary signal to the ECS control plane (DescribeTasks): the task's own
 * metadata endpoint flips at the cut, not at drain start. These tests pin
 * the properties that make the coordinator safe: it fires on STOPPED, it
 * fires exactly once even when several sources report in the same tick, a
 * failing source never kills the poller, a steady failure is reported once
 * and then summarised, and readiness transitions are surfaced for startup
 * diagnostics.
 */

const noop = () => {};

function scriptedSource(name: DrainSignalSource["name"], results: Array<boolean | Error>): DrainSignalSource & { calls: () => number } {
  let calls = 0;
  return {
    name,
    calls: () => calls,
    async probe() {
      calls += 1;
      const result = results[Math.min(calls - 1, results.length - 1)];
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test("fires onDrain exactly once when the control plane reports STOPPED", async () => {
  const fired: string[] = [];
  const source = scriptedSource("control_plane", [false, true, true]);
  const coordinator = createDrainCoordinator({ sources: [source], onDrain: (s) => fired.push(s), warn: noop });

  await coordinator.pollOnce();
  assert.deepEqual(fired, []);
  assert.equal(coordinator.draining, false);

  await coordinator.pollOnce();
  assert.deepEqual(fired, ["control_plane"]);
  assert.equal(coordinator.draining, true);
  assert.equal(coordinator.drainSource, "control_plane");

  await coordinator.pollOnce();
  assert.deepEqual(fired, ["control_plane"]);
  assert.equal(source.calls(), 2, "polling stops once the drain has fired");
});

test("two sources reading STOPPED in the same tick still produce exactly one drain", async () => {
  const fired: string[] = [];
  const controlPlane = scriptedSource("control_plane", [true]);
  const metadata = scriptedSource("metadata", [true]);
  const coordinator = createDrainCoordinator({
    sources: [controlPlane, metadata],
    onDrain: (s) => fired.push(s),
    warn: noop,
  });

  await coordinator.pollOnce();
  assert.equal(fired.length, 1, `expected one drain, got ${fired.length}`);
  assert.equal(coordinator.drainSource, fired[0]);

  await coordinator.pollOnce();
  assert.equal(fired.length, 1);
  assert.equal(controlPlane.calls(), 1);
  assert.equal(metadata.calls(), 1);
});

test("the drain source is the one that reported first, not the first in the list", async () => {
  const fired: string[] = [];
  const controlPlane = scriptedSource("control_plane", [false, false]);
  const metadata = scriptedSource("metadata", [false, true]);
  const coordinator = createDrainCoordinator({
    sources: [controlPlane, metadata],
    onDrain: (s) => fired.push(s),
    warn: noop,
  });

  await coordinator.pollOnce();
  await coordinator.pollOnce();
  assert.deepEqual(fired, ["metadata"]);
});

test("a failing source keeps the coordinator armed and does not block the other source", async () => {
  const fired: string[] = [];
  const warnings: string[] = [];
  const controlPlane = scriptedSource("control_plane", [new Error("AccessDeniedException"), new Error("AccessDeniedException")]);
  const metadata = scriptedSource("metadata", [false, true]);
  const coordinator = createDrainCoordinator({
    sources: [controlPlane, metadata],
    onDrain: (s) => fired.push(s),
    warn: (message) => { warnings.push(message); },
  });

  await coordinator.pollOnce();
  assert.deepEqual(fired, []);
  assert.equal(warnings.length, 1);

  await coordinator.pollOnce();
  assert.deepEqual(fired, ["metadata"]);
});

test("a steady failure warns once, then one summary every warnEvery failures", async () => {
  const warnings: string[] = [];
  const source = scriptedSource("control_plane", [new Error("AccessDeniedException")]);
  const coordinator = createDrainCoordinator({
    sources: [source],
    onDrain: noop,
    warn: (message) => { warnings.push(message); },
    warnEvery: 5,
  });

  for (let i = 0; i < 12; i += 1) await coordinator.pollOnce();
  // failures 1, 5, 10 warn; 2-4, 6-9, 11, 12 stay quiet.
  assert.equal(warnings.length, 3, warnings.join(" | "));
  assert.match(warnings[0], /failed/);
  assert.match(warnings[1], /still failing \(5 consecutive\)/);
  assert.match(warnings[2], /still failing \(10 consecutive\)/);
});

test("readiness is reported on transitions only: false on first failure, true when it recovers", async () => {
  const transitions: Array<[string, boolean]> = [];
  const source = scriptedSource("control_plane", [new Error("AccessDeniedException"), new Error("AccessDeniedException"), false, false, true]);
  const coordinator = createDrainCoordinator({
    sources: [source],
    onDrain: noop,
    warn: noop,
    onSourceReadiness: (s, ready) => transitions.push([s, ready]),
  });

  assert.equal(coordinator.readiness("control_plane"), undefined);
  await coordinator.pollOnce();
  await coordinator.pollOnce();
  assert.deepEqual(transitions, [["control_plane", false]]);
  assert.equal(coordinator.readiness("control_plane"), false);

  await coordinator.pollOnce();
  await coordinator.pollOnce();
  assert.deepEqual(transitions, [["control_plane", false], ["control_plane", true]]);
  assert.equal(coordinator.readiness("control_plane"), true);

  await coordinator.pollOnce();
  assert.equal(coordinator.draining, true);
});

test("metadata source: STOPPED fires, RUNNING does not, non-OK throws", async () => {
  const bodies: Array<{ ok: boolean; status?: number; body: unknown }> = [
    { ok: true, body: { DesiredStatus: "RUNNING" } },
    { ok: true, body: { DesiredStatus: "STOPPED" } },
    { ok: false, status: 500, body: {} },
  ];
  let calls = 0;
  const source = createMetadataDrainSource({
    metadataUri: "http://169.254.170.2/v4/abcd",
    fetchImpl: async (url) => {
      assert.equal(url, "http://169.254.170.2/v4/abcd/task");
      const entry = bodies[calls];
      calls += 1;
      return { ok: entry.ok, status: entry.status, json: async () => entry.body };
    },
  });

  assert.equal(await source.probe(), false);
  assert.equal(await source.probe(), true);
  await assert.rejects(source.probe(), /status=500/);
});

test("control-plane source: desiredStatus STOPPED fires (even while lastStatus is DEACTIVATING), RUNNING does not, a missing task throws", async () => {
  const answers: Array<{ desiredStatus?: string; lastStatus?: string } | undefined> = [
    { desiredStatus: "RUNNING", lastStatus: "RUNNING" },
    { desiredStatus: "STOPPED", lastStatus: "DEACTIVATING" },
    undefined,
  ];
  let calls = 0;
  const source = createControlPlaneDrainSource({
    cluster: "arn:aws:ecs:ap-southeast-1:123456789012:cluster/slock-server-staging",
    taskArn: "arn:aws:ecs:ap-southeast-1:123456789012:task/slock-server-staging/abc",
    describeTask: async ({ cluster, taskArn, signal }) => {
      assert.match(cluster, /slock-server-staging$/);
      assert.match(taskArn, /task\/slock-server-staging\/abc$/);
      assert.ok(signal instanceof AbortSignal);
      return answers[calls++];
    },
  });

  assert.equal(await source.probe(), false);
  assert.equal(await source.probe(), true);
  await assert.rejects(source.probe(), /no task/);
});

test("readEcsTaskIdentity returns cluster + task ARN from the metadata body, undefined otherwise", async () => {
  const ok = await readEcsTaskIdentity({
    metadataUri: "http://169.254.170.2/v4/abcd",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ Cluster: "arn:aws:ecs:r:1:cluster/c", TaskARN: "arn:aws:ecs:r:1:task/c/t", DesiredStatus: "RUNNING" }),
    }),
  });
  assert.deepEqual(ok, { cluster: "arn:aws:ecs:r:1:cluster/c", taskArn: "arn:aws:ecs:r:1:task/c/t" });

  const missing = await readEcsTaskIdentity({
    metadataUri: "http://169.254.170.2/v4/abcd",
    fetchImpl: async () => ({ ok: true, json: async () => ({ DesiredStatus: "RUNNING" }) }),
  });
  assert.equal(missing, undefined);

  const down = await readEcsTaskIdentity({
    metadataUri: "http://169.254.170.2/v4/abcd",
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  assert.equal(down, undefined);
});

/**
 * Wiring tests: the coordinator tests above prove the coordinator, but the
 * "silent degrade" this change guards against (IAM missing → every probe
 * fails → drain falls back to the late metadata path) lives in the wiring
 * layer, so that layer is exercised end to end with a fake metadata endpoint
 * and a fake DescribeTasks.
 */
/** start() fires its first poll without awaiting it; let it settle. */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function metadataFetch(desiredStatus: () => string) {
  return async () => ({
    ok: true,
    json: async () => ({
      Cluster: "arn:aws:ecs:ap-southeast-1:123456789012:cluster/slock-server-staging",
      TaskARN: "arn:aws:ecs:ap-southeast-1:123456789012:task/slock-server-staging/abc",
      DesiredStatus: desiredStatus(),
    }),
  });
}

test("wiring: AccessDenied then recovery surfaces ready=false then ready=true; STOPPED from the control plane drains with source control_plane", async () => {
  const readiness: boolean[] = [];
  const drains: string[] = [];
  let describeCalls = 0;
  const coordinator = await startDrainCoordinator({
    metadataUri: "http://169.254.170.2/v4/abcd",
    fetchImpl: metadataFetch(() => "RUNNING"),
    intervalMs: 3_600_000,
    warn: noop,
    onDrain: (source) => drains.push(source),
    onControlPlaneReadiness: (ready) => readiness.push(ready),
    describeTask: async ({ cluster, taskArn }) => {
      describeCalls += 1;
      assert.match(cluster, /cluster\/slock-server-staging$/);
      assert.match(taskArn, /task\/slock-server-staging\/abc$/);
      if (describeCalls <= 2) throw Object.assign(new Error("AccessDeniedException"), { name: "AccessDeniedException" });
      if (describeCalls === 3) return { desiredStatus: "RUNNING", lastStatus: "RUNNING" };
      return { desiredStatus: "STOPPED", lastStatus: "DEACTIVATING" };
    },
  });
  coordinator.stop();
  await settle();

  // start() already ran one poll (call 1: denied).
  await coordinator.pollOnce(); // call 2: denied (no new transition)
  assert.deepEqual(readiness, [false]);
  await coordinator.pollOnce(); // call 3: RUNNING → ready flips to true
  assert.deepEqual(readiness, [false, true]);
  assert.deepEqual(drains, []);
  await coordinator.pollOnce(); // call 4: STOPPED
  assert.deepEqual(drains, ["control_plane"]);
  assert.equal(coordinator.drainSource, "control_plane");
});

test("wiring: with no task identity in the metadata body the control-plane path is reported unavailable and the metadata path still drains", async () => {
  const readiness: Array<[boolean, string]> = [];
  const drains: string[] = [];
  let status = "RUNNING";
  const coordinator = await startDrainCoordinator({
    metadataUri: "http://169.254.170.2/v4/abcd",
    fetchImpl: async () => ({ ok: true, json: async () => ({ DesiredStatus: status }) }),
    intervalMs: 3_600_000,
    identityAttempts: 1,
    warn: noop,
    onDrain: (source) => drains.push(source),
    onControlPlaneReadiness: (ready, reason) => readiness.push([ready, reason instanceof Error ? reason.message : String(reason)]),
    describeTask: async () => {
      throw new Error("must not be called without an identity");
    },
  });
  coordinator.stop();
  await settle();

  assert.equal(readiness.length, 1);
  assert.equal(readiness[0][0], false);
  assert.match(readiness[0][1], /identity unavailable/);
  status = "STOPPED";
  await coordinator.pollOnce();
  assert.deepEqual(drains, ["metadata"]);
});

test("wiring: a throwing onDrain is logged as a drain failure, not as a probe failure of the source", async () => {
  const warnings: string[] = [];
  const readiness: boolean[] = [];
  const coordinator = await startDrainCoordinator({
    metadataUri: "http://169.254.170.2/v4/abcd",
    fetchImpl: metadataFetch(() => "RUNNING"),
    intervalMs: 3_600_000,
    warn: (message) => warnings.push(message),
    onDrain: () => {
      throw new Error("emitEvent exploded");
    },
    onControlPlaneReadiness: (ready) => readiness.push(ready),
    describeTask: async () => ({ desiredStatus: "STOPPED", lastStatus: "DEACTIVATING" }),
  });
  coordinator.stop();
  await settle();

  assert.equal(coordinator.draining, true);
  assert.deepEqual(readiness, [true], "the source stays ready; the throw belongs to the drain callback");
  assert.equal(warnings.filter((w) => /Drain callback threw/.test(w)).length, 1);
  assert.equal(warnings.filter((w) => /source control_plane failed/.test(w)).length, 0);
});
