import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir, copyFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, request } from "playwright";
import {
  createEvidenceWriter,
  observeLogin,
  prepareTransportEvidence,
  readApiRequestOccupancyEvidence,
  readReadinessServerEvidence,
  SEGMENT_BYTES,
  traceIdFromTraceparent,
} from "./transportEvidence";
import type { EvidenceConfig } from "./transportEvidence";
import { loginViaApiWithCredentials } from "../../packages/web/tests/e2e/fixtures/auth";
import {
  __setWebHttpClientTraceSinkForTest,
  startWebHttpClientSpan,
} from "../../packages/web/src/utils/webHttpClientTrace";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = path.join(root, "scripts/e2e/fixtures/api.ts");
// In CI this runs in the configured Playwright browser step instead.
const browserContractSkip = Boolean(process.env.CI) && process.env.SLOCK_E2E_BROWSER_CONTRACT !== "1";

async function directory(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "login-evidence-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return realpath(dir);
}
async function rows(dir: string, prefix = "server.jsonl") {
  const files = (await readdir(dir)).filter((name) => name.startsWith(prefix));
  return (await Promise.all(files.map((name) => readFile(path.join(dir, name), "utf8"))))
    .flatMap((text) => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
}
async function start(t: TestContext, config: EvidenceConfig, mode = "normal", observe = true) {
  const child = fork(fixture, [], {
    execArgv: ["--import", "@oxc-node/core/register"], silent: true,
    env: { ...process.env, SLOCK_E2E_TRANSPORT_DIR: config.directory, SLOCK_E2E_TRANSPORT_RUN_ID: config.runId,
      FIXTURE_MODE: mode, FIXTURE_OBSERVE: observe ? "on" : "off" },
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  onTestFinished(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  const [message] = await once(child, "message");
  return { child, exited, url: `http://127.0.0.1:${message.port}` };
}
async function close(service: Awaited<ReturnType<typeof start>>) {
  service.child.send("close");
  assert.deepEqual(await service.exited, { code: 0, signal: null });
}

async function waitUntil(check: () => Promise<boolean>, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(message);
}

for (const mode of ["normal", "close", "reset"] as const) {
  test(`real isolated login: ${mode} has distinct lifecycle evidence`, { timeout: 15000 }, async (t) => {
    const dir = await directory(t);
    const config = prepareTransportEvidence(dir)!;
    const service = await start(t, config, mode);
    const api = await request.newContext();
    onTestFinished(() => api.dispose());
    let original: unknown;
    const operation = observeLogin(config, { retry: 0, workerIndex: 3, parallelIndex: 0 }, async (headers) => {
      try {
        const response = await api.post(`${service.url}/api/auth/login`, {
          headers: { ...headers, authorization: "SECRET_HEADER" },
          data: { email: "SECRET_EMAIL", password: "SECRET_PASSWORD" },
        });
        return await response.json();
      } catch (error) { original = error; throw error; }
    });
    if (mode === "normal") assert.equal((await operation).accessToken, "SECRET_RESPONSE_TOKEN");
    else await assert.rejects(operation, (error) => error === original);
    await close(service);
    const events = await rows(dir);
    const apiEvents = await rows(dir, "server-api.jsonl");
    const client = await rows(dir, "client-0.jsonl");
    const arrival = events.find((row) => row.event === "login_arrival");
    assert.equal(arrival.requestId, client[0].requestId);
    assert.ok(events.some((row) => row.event === "connection_open" && row.connectionId === arrival.connectionId));
    assert.ok(events.some((row) => row.event === "process_start"));
    assert.ok(events.some((row) => row.event === "process_exit" && row.exitCode === 0));
    const apiBegin = apiEvents.find((row) => row.event === "api_request_begin");
    assert.equal(typeof apiBegin.apiRequestId, "number");
    assert.equal(apiBegin.connectionId, arrival.connectionId);
    if (mode === "normal") {
      assert.ok(events.some((row) => row.event === "login_finish" && row.status === 200));
      assert.ok(apiEvents.some((row) => row.event === "api_request_finish" && row.apiRequestId === apiBegin.apiRequestId));
      assert.ok(apiEvents.some((row) => row.event === "api_request_teardown" && row.apiRequestId === apiBegin.apiRequestId && row.finished));
      assert.equal(client.at(-1).event, "login_success");
    } else {
      assert.equal(events.filter((row) => row.event === "login_finish").length, 0);
      assert.ok(apiEvents.some((row) => row.event === "api_request_failed" && row.apiRequestId === apiBegin.apiRequestId));
      assert.ok(apiEvents.some((row) => row.event === "api_request_teardown" && row.apiRequestId === apiBegin.apiRequestId && !row.finished));
      assert.ok(events.some((row) => row.event === "connection_close"));
      assert.equal(client.at(-1).event, "login_failure");
      const marker = JSON.parse(await readFile(path.join(dir, "first-failure-client-0.json"), "utf8"));
      assert.equal(marker.requestId, arrival.requestId);
      assert.ok(marker.serverSnapshots.length > 0);
      const closeIndex = events.findIndex((row) => row.event === "listener_close");
      const exitIndex = events.findIndex((row) => row.event === "process_exit");
      assert.ok(closeIndex >= 0 && closeIndex < exitIndex);
      // For reset, listener_close occurs only when the parent later asks it to stop.
      // Prove listener survival by a fresh TCP request before that stop in a separate test below.
    }
    const all = (await Promise.all((await readdir(dir)).map((name) => readFile(path.join(dir, name), "utf8")))).join("");
    assert.doesNotMatch(all, /SECRET_|authorization|password|accessToken|refreshToken/);
    if (process.env.EVIDENCE_SAMPLE_DIR) {
      const destination = path.join(process.env.EVIDENCE_SAMPLE_DIR, mode);
      await mkdir(destination, { recursive: true });
      for (const name of await readdir(dir)) await copyFile(path.join(dir, name), path.join(destination, name));
    }
  });
}

test("reset leaves the same listener alive; close removes it", { timeout: 15000 }, async (t) => {
  for (const mode of ["reset-once", "close"]) {
    const config = prepareTransportEvidence(await directory(t))!;
    const service = await start(t, config, mode);
    const api = await request.newContext();
    onTestFinished(() => api.dispose());
    await assert.rejects(api.post(`${service.url}/api/auth/login`));
    if (mode === "reset-once") assert.equal((await api.post(`${service.url}/api/auth/login`)).status(), 200);
    else await assert.rejects(api.post(`${service.url}/api/auth/login`));
    const events = await rows(config.directory);
    assert.equal(events.some((row) => row.event === "listener_close"), mode === "close");
    await close(service);
  }
});

test("E2E server transport retains only correlated readiness route lifecycle stages", { timeout: 15000 }, async (t) => {
  const config = prepareTransportEvidence(await directory(t))!;
  const service = await start(t, config);
  const api = await request.newContext();
  onTestFinished(() => api.dispose());
  __setWebHttpClientTraceSinkForTest({ record: () => undefined });
  onTestFinished(() => __setWebHttpClientTraceSinkForTest(null));
  const clientSpans = ["dm-channels", "channel", "messages"].map(() => startWebHttpClientSpan("GET"));
  const traceparents = clientSpans.map((span) => span.traceparent);
  const traceIds = traceparents.map((traceparent) => traceIdFromTraceparent(traceparent)!);
  assert.equal(traceIdFromTraceparent(traceparents[0]), traceIds[0]);
  assert.equal(traceIdFromTraceparent(`00-${"0".repeat(32)}-${"b".repeat(16)}-01`), null);
  assert.equal(traceIdFromTraceparent("SECRET_HEADER"), null);

  const routes = [
    "/api/channels/dm?secret=hidden",
    "/api/channels/SECRET_TARGET?secret=hidden",
    "/api/messages/channel/SECRET_TARGET?secret=hidden",
  ];
  for (const [index, route] of routes.entries()) {
    const response = await api.get(`${service.url}${route}`, {
      headers: { traceparent: traceparents[index]!, authorization: "SECRET_HEADER" },
    });
    assert.equal(response.status(), 200);
    clientSpans[index]!.end({ statusCode: response.status() });
  }
  await api.get(`${service.url}/api/messages/channel/SECRET_TARGET`, {
    headers: { traceparent: "malformed", authorization: "SECRET_HEADER" },
  });
  await close(service);

  const evidence = readReadinessServerEvidence(config, traceIds);
  assert.equal(evidence.state, "matched");
  assert.deepEqual(evidence.records.map((record) => ({
    traceId: record.traceId,
    requestKind: record.requestKind,
    stage: record.stage,
    status: record.status,
    finished: record.finished,
  })), [
    { traceId: traceIds[0], requestKind: "dm-channels", stage: "arrival", status: undefined, finished: undefined },
    { traceId: traceIds[0], requestKind: "dm-channels", stage: "response-finished", status: 200, finished: undefined },
    { traceId: traceIds[1], requestKind: "channel", stage: "arrival", status: undefined, finished: undefined },
    { traceId: traceIds[1], requestKind: "channel", stage: "response-finished", status: 200, finished: undefined },
    { traceId: traceIds[2], requestKind: "messages", stage: "arrival", status: undefined, finished: undefined },
    { traceId: traceIds[2], requestKind: "messages", stage: "response-finished", status: 200, finished: undefined },
  ]);
  assert.deepEqual(readReadinessServerEvidence(config, ["e".repeat(32)]), {
    state: "not-observed",
    records: [],
  });
  assert.deepEqual(readReadinessServerEvidence(undefined, [traceIds[0]!]), {
    state: "unavailable",
    reason: "transport-config-unavailable",
    records: [],
  });
  const afterAllResponsesFinished = Date.now();
  const settledOccupancy = readApiRequestOccupancyEvidence(config, [{
    traceId: traceIds[2]!,
    clientStartedAtEpochMs: afterAllResponsesFinished,
    assertionEndedAtEpochMs: afterAllResponsesFinished,
  }]);
  assert.equal(settledOccupancy.state, "matched");
  assert.equal(settledOccupancy.snapshots[0]?.atClientStart.state, "known");
  assert.equal(settledOccupancy.snapshots[0]?.atClientStart.observedActiveRequestCount, 0,
    "six distinct/opened connection ids are not evidence of six simultaneous active requests");
  const all = (await Promise.all((await readdir(config.directory)).map((name) =>
    readFile(path.join(config.directory, name), "utf8")
  ))).join("");
  assert.doesNotMatch(all, /SECRET_|authorization|hidden|secret/);
});

test("six concurrent API requests prove occupied connections until one release admits the queued target", {
  timeout: 30000,
  skip: browserContractSkip,
}, async (t) => {
  const config = prepareTransportEvidence(await directory(t))!;
  const service = await start(t, config, "hold-six");
  const browser = await chromium.launch({ headless: true });
  onTestFinished(() => browser.close());
  const page = await browser.newPage();
  await page.goto(service.url);

  for (let index = 0; index < 6; index++) {
    await page.evaluate(({ traceparent, index }) => {
      void fetch(`/api/hold?private=${index}`, { headers: { traceparent, authorization: "SECRET_HEADER" } });
    }, {
      index,
      traceparent: `00-${String(index + 1).padStart(32, "a")}-${String(index + 1).padStart(16, "b")}-01`,
    });
  }
  await waitUntil(async () => (
    (await rows(config.directory, "server-api.jsonl"))
      .filter((row) => row.event === "api_request_begin").length === 6
  ), "all six held API requests must reach Node");

  const targetTraceId = "f".repeat(32);
  const targetTraceparent = `00-${targetTraceId}-${"e".repeat(16)}-01`;
  const clientStarted = new Promise<number>((resolve) => {
    page.on("request", (request) => {
      if (request.headers().traceparent === targetTraceparent) resolve(Date.now());
    });
  });
  await page.evaluate((traceparent) => {
    void fetch("/api/target?private=hidden", { headers: { traceparent, authorization: "SECRET_HEADER" } });
  }, targetTraceparent);
  const clientStartedAtEpochMs = await clientStarted;
  await delay(100);

  const blocked = readApiRequestOccupancyEvidence(config, [{
    traceId: targetTraceId,
    clientStartedAtEpochMs,
    assertionEndedAtEpochMs: Date.now(),
  }]);
  assert.equal(blocked.state, "matched");
  assert.equal(blocked.coverage, "complete-from-process-start");
  assert.equal(blocked.snapshots[0]?.atClientStart.state, "known");
  assert.equal(blocked.snapshots[0]?.atClientStart.observedActiveRequestCount, 6);
  assert.equal(blocked.snapshots[0]?.atClientStart.observedActiveConnectionCount, 6);
  assert.equal(blocked.snapshots[0]?.targetServerRequest.state, "not-observed");
  assert.deepEqual(blocked.snapshots[0]?.releasesBeforeAssertionEnd, []);

  const released = once(service.child, "message");
  service.child.send("release-one");
  assert.deepEqual((await released)[0], { released: true });
  await waitUntil(async () => (
    (await rows(config.directory, "server-api.jsonl"))
      .some((row) => row.event === "api_request_begin" && row.traceId === targetTraceId)
  ), "the queued target must reach Node after a slot is released");

  const admitted = readApiRequestOccupancyEvidence(config, [{
    traceId: targetTraceId,
    clientStartedAtEpochMs,
    assertionEndedAtEpochMs: Date.now(),
  }]);
  assert.equal(admitted.state, "matched");
  assert.equal(admitted.snapshots[0]?.targetServerRequest.state, "arrived");
  assert.equal(admitted.snapshots[0]?.releasesBeforeAssertionEnd.length, 1);
  assert.equal(admitted.snapshots[0]?.releasesBeforeAssertionEnd[0]?.stage, "response-finished");

  const all = (await Promise.all((await readdir(config.directory)).map((name) =>
    readFile(path.join(config.directory, name), "utf8")
  ))).join("");
  assert.doesNotMatch(all, /SECRET_|authorization|private|hidden|\/api\//);
  await close(service);
});

test("the real browser occupancy contract is routed to Playwright CI without broadening unit-fast", async () => {
  const workflow = await readFile(path.join(root, ".github/workflows/test.yml"), "utf8");
  const unitFast = workflow.slice(workflow.indexOf("  unit-fast:"), workflow.indexOf("  unit-daemon:"));
  assert.doesNotMatch(unitFast, /playwright install/);
  assert.match(workflow, /container:\n\s+image: mcr\.microsoft\.com\/playwright:/);
  assert.match(workflow, /- name: E2E API occupancy browser contract[\s\S]*?SLOCK_E2E_BROWSER_CONTRACT: "1"[\s\S]*?six concurrent API requests prove occupied connections/);
});

test("occupancy is instance-scoped and connection close or process exit releases only matching requests", async (t) => {
  const config = prepareTransportEvidence(await directory(t))!;
  const startedAt = Date.now() - 1_000;
  const evidenceRow = (
    instanceId: string,
    sequence: number,
    offsetMs: number,
    event: string,
    fields: Record<string, unknown> = {},
  ) => ({
    version: 1,
    runId: config.runId,
    instanceId,
    sequence,
    time: new Date(startedAt + offsetMs).toISOString(),
    event,
    ...fields,
  });
  const evidenceRows = [
    evidenceRow("instance-a", 1, 0, "process_start"),
    evidenceRow("instance-a", 2, 1, "connection_open", { connectionId: 1 }),
    evidenceRow("instance-a", 3, 2, "api_request_begin", { apiRequestId: 1, connectionId: 1 }),
    evidenceRow("instance-a", 4, 5, "connection_close", { connectionId: 1 }),
    evidenceRow("instance-b", 1, 0, "process_start"),
    evidenceRow("instance-b", 2, 1, "connection_open", { connectionId: 1 }),
    evidenceRow("instance-b", 3, 2, "api_request_begin", { apiRequestId: 1, connectionId: 1 }),
    evidenceRow("instance-b", 4, 6, "process_exit"),
    evidenceRow("instance-c", 1, 0, "process_start"),
    evidenceRow("instance-c", 2, 1, "connection_open", { connectionId: 1 }),
    evidenceRow("instance-c", 3, 2, "api_request_begin", { apiRequestId: 1, connectionId: 1 }),
    evidenceRow("instance-d", 1, 0, "process_start"),
    evidenceRow("instance-d", 2, 1, "connection_open", { connectionId: 1 }),
    evidenceRow("instance-d", 3, 2, "api_request_begin", { apiRequestId: 1, connectionId: 1 }),
    evidenceRow("instance-d", 4, 3, "api_request_finish", { apiRequestId: 1, connectionId: 1 }),
    evidenceRow("instance-d", 5, 4, "api_request_teardown", { apiRequestId: 1, connectionId: 1 }),
  ];
  await writeFile(path.join(config.directory, "server-api.jsonl"),
    evidenceRows.map((row) => JSON.stringify(row)).join("\n") + "\n");

  const evidence = readApiRequestOccupancyEvidence(config, [
    {
      traceId: "a".repeat(32),
      clientStartedAtEpochMs: startedAt + 4,
      assertionEndedAtEpochMs: startedAt + 7,
    },
    {
      traceId: "b".repeat(32),
      clientStartedAtEpochMs: startedAt + 7,
      assertionEndedAtEpochMs: startedAt + 7,
    },
  ]);
  assert.equal(evidence.state, "matched");
  assert.equal(evidence.coverage, "complete-from-process-start");
  assert.equal(evidence.snapshots[0]?.atClientStart.state, "known");
  assert.equal(evidence.snapshots[0]?.atClientStart.observedActiveRequestCount, 3);
  assert.equal(evidence.snapshots[0]?.atClientStart.observedActiveConnectionCount, 3);
  assert.deepEqual(evidence.snapshots[0]?.atClientStart.active.map((request) => request.serverInstanceId), [
    "instance-a",
    "instance-b",
    "instance-c",
  ]);
  assert.deepEqual(evidence.snapshots[0]?.releasesBeforeAssertionEnd.map((release) => ({
    serverInstanceId: release.serverInstanceId,
    stage: release.stage,
  })), [
    { serverInstanceId: "instance-a", stage: "connection-closed" },
    { serverInstanceId: "instance-b", stage: "process-exited" },
  ]);
  assert.equal(evidence.snapshots[1]?.atClientStart.state, "known");
  assert.equal(evidence.snapshots[1]?.atClientStart.observedActiveRequestCount, 1,
    "a terminal event for the same numeric request id in another instance must not clear this request");
  assert.equal(evidence.snapshots[1]?.atClientStart.active[0]?.serverInstanceId, "instance-c");
});

test("partial retention or missing connection correlation reports occupancy as unknown", async (t) => {
  const config = prepareTransportEvidence(await directory(t))!;
  const startedAt = Date.now() - 1_000;
  await writeFile(path.join(config.directory, "server-api.jsonl"), [
    {
      version: 1, runId: config.runId, instanceId: "partial-instance", sequence: 7,
      time: new Date(startedAt).toISOString(), event: "api_request_begin", apiRequestId: 1,
    },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const evidence = readApiRequestOccupancyEvidence(config, [{
    traceId: "c".repeat(32),
    clientStartedAtEpochMs: startedAt + 1,
    assertionEndedAtEpochMs: startedAt + 1,
  }]);
  assert.equal(evidence.state, "matched");
  assert.equal(evidence.coverage, "partial-retention");
  assert.equal(evidence.snapshots[0]?.atClientStart.state, "unknown");
  assert.deepEqual(evidence.snapshots[0]?.atClientStart.unknownReasons, [
    "partial-retention",
    "missing-connection-correlation",
  ]);
  assert.equal(evidence.snapshots[0]?.atClientStart.observedActiveRequestCount, 1);
  assert.equal(evidence.snapshots[0]?.atClientStart.observedActiveConnectionCount, 0);
});

test("bounded checkpoints recover post-rotation occupancy and fail closed on a later sequence gap", {
  timeout: 30000,
}, async (t) => {
  const config = prepareTransportEvidence(await directory(t))!;
  const service = await start(t, config, "hold-six");
  const api = await request.newContext();
  onTestFinished(() => api.dispose());
  const heldTraceId = "9".repeat(32);
  const held = api.get(`${service.url}/api/hold?private=held`, {
    headers: {
      traceparent: `00-${heldTraceId}-${"8".repeat(16)}-01`,
      authorization: "SECRET_HEADER",
    },
  });
  await waitUntil(async () => (
    (await rows(config.directory, "server-api.jsonl"))
      .some((row) => row.event === "api_request_begin" && row.traceId === heldTraceId)
  ), "held request must reach Node before rotation");

  let retained: Array<Record<string, unknown>> = [];
  for (let batch = 0; batch < 40; batch++) {
    await Promise.all(Array.from({ length: 40 }, (_, index) => (
      api.get(`${service.url}/api/chatter?private=${batch}-${index}`, {
        headers: { authorization: "SECRET_HEADER" },
      })
    )));
    retained = await rows(config.directory, "server-api.jsonl");
    if (
      !retained.some((row) => row.event === "process_start")
      && retained.some((row) => row.event === "api_occupancy_checkpoint")
    ) break;
  }
  assert.equal(retained.some((row) => row.event === "process_start"), false,
    "the control must evict process-start rather than silently using old complete coverage");
  const checkpoint = retained.findLast((row) => row.event === "api_occupancy_checkpoint");
  assert.ok(checkpoint);
  assert.equal(typeof checkpoint.instanceId, "string");
  assert.equal(typeof checkpoint.sequence, "number");
  assert.ok(retained.some((row) => (
    row.instanceId === checkpoint.instanceId && row.sequence === checkpoint.sequence + 1
  )), "checkpoint must bind the same writer instance and immediately preceding log sequence");
  assert.equal(checkpoint.activeTruncated, 0);
  assert.ok(Array.isArray(checkpoint.activeRequests));
  assert.ok(checkpoint.activeRequests.some((entry: Record<string, unknown>) => (
    entry.apiRequestId === 1 && typeof entry.connectionId === "number"
  )));

  const clientStartedAtEpochMs = Date.now();
  const beforeRelease = readApiRequestOccupancyEvidence(config, [{
    traceId: "7".repeat(32),
    clientStartedAtEpochMs,
    assertionEndedAtEpochMs: clientStartedAtEpochMs,
  }]);
  assert.equal(beforeRelease.state, "matched");
  assert.equal(beforeRelease.coverage, "complete-from-checkpoint");
  assert.equal(beforeRelease.snapshots[0]?.atClientStart.state, "known");
  assert.equal(beforeRelease.snapshots[0]?.atClientStart.observedActiveRequestCount, 1);
  assert.equal(beforeRelease.snapshots[0]?.atClientStart.observedActiveConnectionCount, 1);

  const released = once(service.child, "message");
  service.child.send("release-one");
  assert.deepEqual((await released)[0], { released: true });
  assert.equal((await held).status(), 200);
  const afterReleaseAtEpochMs = Date.now();
  const afterRelease = readApiRequestOccupancyEvidence(config, [{
    traceId: "7".repeat(32),
    clientStartedAtEpochMs,
    assertionEndedAtEpochMs: afterReleaseAtEpochMs,
  }]);
  assert.equal(afterRelease.state, "matched");
  assert.equal(afterRelease.snapshots[0]?.atClientStart.state, "known");
  assert.equal(afterRelease.snapshots[0]?.releasesBeforeAssertionEnd.length, 1);
  assert.equal(afterRelease.snapshots[0]?.releasesBeforeAssertionEnd[0]?.stage, "response-finished");

  await close(service);
  const afterExitAtEpochMs = Date.now();
  const afterExit = readApiRequestOccupancyEvidence(config, [{
    traceId: "6".repeat(32),
    clientStartedAtEpochMs: afterExitAtEpochMs,
    assertionEndedAtEpochMs: afterExitAtEpochMs,
  }]);
  assert.equal(afterExit.state, "matched");
  assert.equal(afterExit.coverage, "complete-from-checkpoint");
  assert.equal(afterExit.snapshots[0]?.atClientStart.state, "known");
  assert.equal(afterExit.snapshots[0]?.atClientStart.observedActiveRequestCount, 0);

  const current = path.join(config.directory, "server-api.jsonl");
  const currentLines = (await readFile(current, "utf8")).trim().split("\n");
  const latestCheckpointIndex = currentLines.findLastIndex((line) => JSON.parse(line).event === "api_occupancy_checkpoint");
  assert.ok(latestCheckpointIndex >= 0 && latestCheckpointIndex + 1 < currentLines.length);
  currentLines.splice(latestCheckpointIndex + 1, 1);
  await writeFile(current, currentLines.join("\n") + "\n");
  const withGap = readApiRequestOccupancyEvidence(config, [{
    traceId: "6".repeat(32),
    clientStartedAtEpochMs: afterExitAtEpochMs,
    assertionEndedAtEpochMs: afterExitAtEpochMs,
  }]);
  assert.equal(withGap.state, "matched");
  assert.equal(withGap.coverage, "partial-retention");
  assert.equal(withGap.snapshots[0]?.atClientStart.state, "unknown");
  assert.deepEqual(withGap.snapshots[0]?.atClientStart.unknownReasons, ["partial-retention"]);

  const all = (await Promise.all((await readdir(config.directory)).map((name) =>
    readFile(path.join(config.directory, name), "utf8")
  ))).join("");
  assert.doesNotMatch(all, /SECRET_|authorization|private|held|chatter|\/api\//);
});

test("a checkpoint remains instance-scoped and later close or exit releases its active requests", async (t) => {
  const config = prepareTransportEvidence(await directory(t))!;
  const startedAt = Date.now() - 1_000;
  const evidenceRows = [
    {
      version: 1, runId: config.runId, instanceId: "checkpoint-close", sequence: 50,
      time: new Date(startedAt).toISOString(), event: "api_occupancy_checkpoint", activeTruncated: 0,
      activeRequests: [{ apiRequestId: 1, connectionId: 1, beganAtEpochMs: startedAt - 10 }],
    },
    {
      version: 1, runId: config.runId, instanceId: "checkpoint-close", sequence: 51,
      time: new Date(startedAt + 3).toISOString(), event: "connection_close", connectionId: 1,
    },
    {
      version: 1, runId: config.runId, instanceId: "checkpoint-exit", sequence: 80,
      time: new Date(startedAt).toISOString(), event: "api_occupancy_checkpoint", activeTruncated: 0,
      activeRequests: [{ apiRequestId: 1, connectionId: 1, beganAtEpochMs: startedAt - 20 }],
    },
    {
      version: 1, runId: config.runId, instanceId: "checkpoint-exit", sequence: 81,
      time: new Date(startedAt + 4).toISOString(), event: "process_exit",
    },
  ];
  await writeFile(path.join(config.directory, "server-api.jsonl"),
    evidenceRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const evidence = readApiRequestOccupancyEvidence(config, [
    {
      traceId: "5".repeat(32),
      clientStartedAtEpochMs: startedAt + 2,
      assertionEndedAtEpochMs: startedAt + 5,
    },
    {
      traceId: "4".repeat(32),
      clientStartedAtEpochMs: startedAt + 5,
      assertionEndedAtEpochMs: startedAt + 5,
    },
  ]);
  assert.equal(evidence.state, "matched");
  assert.equal(evidence.coverage, "complete-from-checkpoint");
  assert.equal(evidence.snapshots[0]?.atClientStart.state, "known");
  assert.equal(evidence.snapshots[0]?.atClientStart.observedActiveRequestCount, 2);
  assert.deepEqual(evidence.snapshots[0]?.releasesBeforeAssertionEnd.map((release) => ({
    serverInstanceId: release.serverInstanceId,
    stage: release.stage,
  })), [
    { serverInstanceId: "checkpoint-close", stage: "connection-closed" },
    { serverInstanceId: "checkpoint-exit", stage: "process-exited" },
  ]);
  assert.equal(evidence.snapshots[1]?.atClientStart.state, "known");
  assert.equal(evidence.snapshots[1]?.atClientStart.observedActiveRequestCount, 0);
});

test("a truncated checkpoint cannot claim complete occupancy", async (t) => {
  const config = prepareTransportEvidence(await directory(t))!;
  const startedAt = Date.now() - 1_000;
  await writeFile(path.join(config.directory, "server-api.jsonl"), [
    {
      version: 1, runId: config.runId, instanceId: "truncated-checkpoint", sequence: 90,
      time: new Date(startedAt).toISOString(), event: "api_occupancy_checkpoint", activeTruncated: 1,
      activeRequests: [{ apiRequestId: 1, connectionId: 1, beganAtEpochMs: startedAt - 10 }],
    },
    {
      version: 1, runId: config.runId, instanceId: "truncated-checkpoint", sequence: 91,
      time: new Date(startedAt + 1).toISOString(), event: "api_request_begin", apiRequestId: 2, connectionId: 2,
    },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const evidence = readApiRequestOccupancyEvidence(config, [{
    traceId: "3".repeat(32),
    clientStartedAtEpochMs: startedAt + 2,
    assertionEndedAtEpochMs: startedAt + 2,
  }]);
  assert.equal(evidence.state, "matched");
  assert.equal(evidence.coverage, "partial-retention");
  assert.equal(evidence.snapshots[0]?.atClientStart.state, "unknown");
  assert.deepEqual(evidence.snapshots[0]?.atClientStart.unknownReasons, ["partial-retention"]);
});

test("a probe before every retained row cannot inherit completeness from a later checkpoint", async (t) => {
  const config = prepareTransportEvidence(await directory(t))!;
  const probeAt = Date.now() - 1_000;
  await writeFile(path.join(config.directory, "server-api.jsonl"), [
    {
      version: 1, runId: config.runId, instanceId: "future-checkpoint", sequence: 100,
      time: new Date(probeAt + 10).toISOString(), event: "api_occupancy_checkpoint", activeTruncated: 0,
      activeRequests: [{ apiRequestId: 1, connectionId: 1, beganAtEpochMs: probeAt - 10 }],
    },
    {
      version: 1, runId: config.runId, instanceId: "future-checkpoint", sequence: 101,
      time: new Date(probeAt + 20).toISOString(), event: "api_request_finish", apiRequestId: 1, connectionId: 1,
    },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const evidence = readApiRequestOccupancyEvidence(config, [{
    traceId: "2".repeat(32),
    clientStartedAtEpochMs: probeAt,
    assertionEndedAtEpochMs: probeAt,
  }]);
  assert.equal(evidence.state, "matched");
  assert.equal(evidence.coverage, "partial-retention");
  assert.equal(evidence.snapshots[0]?.atClientStart.state, "unknown");
  assert.deepEqual(evidence.snapshots[0]?.atClientStart.unknownReasons, ["partial-retention"]);
  assert.equal(evidence.snapshots[0]?.atClientStart.observedActiveRequestCount, 0);
});

test("checkpoint coverage crosses the probe boundary before claiming continuity", async (t) => {
  const config = prepareTransportEvidence(await directory(t))!;
  const checkpointAt = Date.now() - 1_000;
  const probeAt = checkpointAt + 5;
  const checkpoint = {
    version: 1, runId: config.runId, instanceId: "cross-probe-gap", sequence: 100,
    time: new Date(checkpointAt).toISOString(), event: "api_occupancy_checkpoint", activeTruncated: 0,
    activeRequests: [{ apiRequestId: 1, connectionId: 1, beganAtEpochMs: checkpointAt - 10 }],
  };
  const afterProbe = {
    version: 1, runId: config.runId, instanceId: "cross-probe-gap", sequence: 102,
    time: new Date(probeAt + 5).toISOString(), event: "api_request_teardown",
    apiRequestId: 1, connectionId: 1, finished: true,
  };
  const file = path.join(config.directory, "server-api.jsonl");
  await writeFile(file, [checkpoint, afterProbe].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const withGap = readApiRequestOccupancyEvidence(config, [{
    traceId: "1".repeat(32),
    clientStartedAtEpochMs: probeAt,
    assertionEndedAtEpochMs: probeAt,
  }]);
  assert.equal(withGap.state, "matched");
  assert.equal(withGap.coverage, "partial-retention");
  assert.equal(withGap.snapshots[0]?.atClientStart.state, "unknown");

  const beforeProbeClose = {
    version: 1, runId: config.runId, instanceId: "cross-probe-gap", sequence: 101,
    time: new Date(probeAt - 1).toISOString(), event: "connection_close", connectionId: 1,
  };
  await writeFile(file, [checkpoint, beforeProbeClose, afterProbe]
    .map((row) => JSON.stringify(row)).join("\n") + "\n");
  const continuous = readApiRequestOccupancyEvidence(config, [{
    traceId: "1".repeat(32),
    clientStartedAtEpochMs: probeAt,
    assertionEndedAtEpochMs: probeAt,
  }]);
  assert.equal(continuous.state, "matched");
  assert.equal(continuous.coverage, "complete-from-checkpoint");
  assert.equal(continuous.snapshots[0]?.atClientStart.state, "known");
  assert.equal(continuous.snapshots[0]?.atClientStart.observedActiveRequestCount, 0);
});

test("bounded release details retain the exact truncated count", async (t) => {
  const config = prepareTransportEvidence(await directory(t))!;
  const startedAt = Date.now() - 1_000;
  const rows = [
    {
      version: 1, runId: config.runId, instanceId: "bounded-instance", sequence: 1,
      time: new Date(startedAt).toISOString(), event: "process_start",
    },
    ...Array.from({ length: 33 }, (_, index) => ({
      version: 1, runId: config.runId, instanceId: "bounded-instance", sequence: index + 2,
      time: new Date(startedAt + 1).toISOString(), event: "api_request_begin",
      apiRequestId: index + 1, connectionId: index + 1,
    })),
    ...Array.from({ length: 33 }, (_, index) => ({
      version: 1, runId: config.runId, instanceId: "bounded-instance", sequence: index + 35,
      time: new Date(startedAt + 3).toISOString(), event: "api_request_finish",
      apiRequestId: index + 1, connectionId: index + 1,
    })),
  ];
  await writeFile(path.join(config.directory, "server-api.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const evidence = readApiRequestOccupancyEvidence(config, [{
    traceId: "d".repeat(32),
    clientStartedAtEpochMs: startedAt + 2,
    assertionEndedAtEpochMs: startedAt + 4,
  }]);
  assert.equal(evidence.state, "matched");
  assert.equal(evidence.snapshots[0]?.atClientStart.observedActiveRequestCount, 33);
  assert.equal(evidence.snapshots[0]?.atClientStart.active.length, 32);
  assert.equal(evidence.snapshots[0]?.atClientStart.activeTruncated, 1);
  assert.equal(evidence.snapshots[0]?.releasesBeforeAssertionEnd.length, 32);
  assert.equal(evidence.snapshots[0]?.releasesTruncated, 1);
});

test("observer preserves default fatal error and SIGTERM behavior", { timeout: 15000 }, async (t) => {
  for (const action of ["unhandled-error", "SIGTERM"]) {
    for (const observe of [false, true]) {
      const config = prepareTransportEvidence(await directory(t))!;
      const service = await start(t, config, "normal", observe);
      if (action === "SIGTERM") service.child.kill("SIGTERM");
      else service.child.send(action);
      const result = await service.exited;
      assert.deepEqual(result, action === "SIGTERM" ? { code: null, signal: "SIGTERM" } : { code: 1, signal: null });
      if (observe) {
        const events = await rows(config.directory);
        assert.equal(events.some((row) => row.event === "process_uncaught"), action === "unhandled-error");
        assert.equal(events.some((row) => row.event === "process_exit"), action === "unhandled-error",
          "default signal termination is unobserved, never fabricated as a normal exit");
      }
    }
  }
});

test("rotation is bounded; pinned first failure survives later failures and chatter", async (t) => {
  const config = prepareTransportEvidence(await directory(t))!;
  const emit = createEvidenceWriter(config, "server");
  emit("process_start");
  const sentinel = new Error("SECRET_PASSWORD");
  await assert.rejects(observeLogin(config, { retry: 0, workerIndex: 0, parallelIndex: 0 }, async () => { throw sentinel; }), (err) => err === sentinel);
  const pinned = await readFile(path.join(config.directory, "first-failure-client-0-server.jsonl"), "utf8");
  const marker = await readFile(path.join(config.directory, "first-failure-client-0.json"), "utf8");
  for (let i = 0; i < 5000; i++) emit("connection_open", { connectionId: i });
  await assert.rejects(observeLogin(config, { retry: 1, workerIndex: 1, parallelIndex: 0 }, async () => { throw sentinel; }));
  assert.equal(await readFile(path.join(config.directory, "first-failure-client-0-server.jsonl"), "utf8"), pinned);
  assert.equal(await readFile(path.join(config.directory, "first-failure-client-0.json"), "utf8"), marker);
  assert.equal((await readdir(config.directory)).filter((name) => name.startsWith("server.jsonl")).length, 2);
  for (const name of await readdir(config.directory)) assert.ok((await stat(path.join(config.directory, name))).size <= SEGMENT_BYTES);
});

test("missing server evidence and unwritable storage preserve errors without cause claims", async (t) => {
  const dir = await directory(t);
  const config = prepareTransportEvidence(path.join(dir, "logs"))!;
  const original = Object.defineProperty(new Error("SECRET_EXCEPTION"), "code", { get() { throw new Error("diagnostic accessor failed"); } });
  await assert.rejects(observeLogin(config, undefined, async () => { throw original; }), (error) => error === original);
  const marker = JSON.parse(await readFile(path.join(config.directory, "first-failure-client-setup.json"), "utf8"));
  assert.deepEqual(marker.serverSnapshots, []);
  assert.match(marker.interpretation, /missing events do not establish a cause/);
  const invalid = path.join(dir, "not-a-directory");
  await writeFile(invalid, "occupied");
  await assert.rejects(observeLogin({ ...config, directory: invalid }, undefined, async () => { throw original; }), (error) => error === original);
  assert.equal(await observeLogin(undefined, undefined, async (headers) => { assert.equal(headers, undefined); return 42; }), 42);
});

for (const recovered of [false, true]) {
  test(`real Playwright ${recovered ? "retry recovery" : "terminal failure"} retains first-attempt artifacts`, { timeout: 30000 }, async (t) => {
    const dir = await directory(t);
    const config = prepareTransportEvidence(path.join(dir, "playwright-report/transport"))!;
    const service = await start(t, config, recovered ? "reset-once" : "reset");
    const pw = path.join(root, "packages/web/node_modules/@playwright/test/index.mjs");
    const auth = path.join(root, "packages/web/tests/e2e/fixtures/auth.ts");
    await writeFile(path.join(dir, "login.spec.ts"), `import { test } from ${JSON.stringify(pw)};\nimport { loginViaApiWithCredentials } from ${JSON.stringify(auth)};\ntest('login transport', async ({request}) => { await loginViaApiWithCredentials(request, { urls: { api: ${JSON.stringify(service.url)} } } as never, {email: 'SECRET_EMAIL', password: 'SECRET_PASSWORD'}); });\n`);
    const report = path.join(dir, "test-results/results.json");
    await writeFile(path.join(dir, "playwright.config.ts"), `export default { testDir: '.', retries: ${recovered ? 1 : 0}, workers: 1, outputDir: './test-results', reporter: [['json', {outputFile: ${JSON.stringify(report)}}]] };`);
    const child = spawn(process.execPath, [path.join(root, "node_modules/playwright/cli.js"), "test", "--config", path.join(dir, "playwright.config.ts")], {
      cwd: dir, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SLOCK_E2E_TRANSPORT_DIR: config.directory, SLOCK_E2E_TRANSPORT_RUN_ID: config.runId },
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    const [code] = await once(child, "exit");
    assert.equal(code, recovered ? 0 : 1, output);
    const result = JSON.parse(await readFile(report, "utf8"));
    const testResult = result.suites[0].specs[0].tests[0];
    assert.equal(testResult.results[0].status, "failed");
    assert.match(testResult.results[0].error.message, /ECONNRESET|socket hang up/);
    if (recovered) assert.equal(testResult.results[1].status, "passed");
    const marker = JSON.parse(await readFile(path.join(config.directory, "first-failure-client-0.json"), "utf8"));
    assert.ok(marker.serverSnapshots.length > 0);
    assert.equal((await rows(config.directory, "client-0.jsonl"))[0].retry, 0);
    const classifier = spawn(process.execPath, [path.join(root, "scripts/ci/playwright-artifact-decision.mjs")], {
      env: { ...process.env, PLAYWRIGHT_STEP_OUTCOME: recovered ? "success" : "failure", PLAYWRIGHT_JSON_REPORT: report, GITHUB_OUTPUT: path.join(dir, "upload.txt") },
      stdio: "ignore",
    });
    assert.equal((await once(classifier, "exit"))[0], 0);
    assert.match(await readFile(path.join(dir, "upload.txt"), "utf8"), /should-upload=true/);
    const workflow = await readFile(path.join(root, ".github/workflows/test.yml"), "utf8");
    assert.match(workflow, /packages\/web\/playwright-report\//);
    assert.match(workflow, /retention-days: 7/);
    await close(service);
  });
}


test("actual Playwright API launcher and auth fixture emit correlated evidence", { timeout: 60000 }, async (t) => {
  const dir = await directory(t);
  const config = prepareTransportEvidence(path.join(dir, "transport"))!;
  const statePath = path.join(dir, "state.json");
  const child = fork(path.join(root, "packages/server/src/test/startPlaywrightServer.ts"), [], {
    cwd: path.join(root, "packages/server"), execArgv: ["--import", "@oxc-node/core/register"], silent: true,
    env: { ...process.env, DATABASE_URL: "pglite://", SLOCK_TEST_SERVER_PORT: "0", SLOCK_TEST_STATE_PATH: statePath,
      SLOCK_E2E_TRANSPORT_DIR: config.directory, SLOCK_E2E_TRANSPORT_RUN_ID: config.runId },
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  child.stdout?.resume();
  onTestFinished(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await exited; });
  let seed;
  for (let i = 0; i < 400; i++) {
    try { seed = JSON.parse(await readFile(statePath, "utf8")); break; } catch { /* startup incomplete */ }
    assert.equal(child.exitCode, null, stderr);
    await delay(100);
  }
  assert.ok(seed, "real API server must finish seeding");
  const previousDir = process.env.SLOCK_E2E_TRANSPORT_DIR;
  const previousRun = process.env.SLOCK_E2E_TRANSPORT_RUN_ID;
  process.env.SLOCK_E2E_TRANSPORT_DIR = config.directory;
  process.env.SLOCK_E2E_TRANSPORT_RUN_ID = config.runId;
  onTestFinished(() => {
    if (previousDir === undefined) delete process.env.SLOCK_E2E_TRANSPORT_DIR;
    else process.env.SLOCK_E2E_TRANSPORT_DIR = previousDir;
    if (previousRun === undefined) delete process.env.SLOCK_E2E_TRANSPORT_RUN_ID;
    else process.env.SLOCK_E2E_TRANSPORT_RUN_ID = previousRun;
  });
  const api = await request.newContext();
  onTestFinished(() => api.dispose());
  const result = await loginViaApiWithCredentials(api, seed, { email: seed.user.email, password: seed.user.password });
  assert.ok(result.accessToken);
  const client = await rows(config.directory, "client-setup.jsonl");
  const server = await rows(config.directory);
  assert.equal(client.at(-1).event, "login_success");
  assert.ok(server.some((row) => row.event === "login_finish" && row.requestId === client[0].requestId));
  const text = (await readdir(config.directory)).map((name) => readFile(path.join(config.directory, name), "utf8"));
  for (const body of await Promise.all(text)) {
    assert.ok(!body.includes(seed.user.password));
    assert.ok(!body.includes(result.accessToken));
  }
});

test("actual shard runner passes collection identity and preserves child failure", { timeout: 15000 }, async (t) => {
  const dir = await directory(t);
  const web = path.join(dir, "packages/web");
  const runner = path.join(web, "scripts/runE2eShard.ts");
  await mkdir(path.dirname(runner), { recursive: true });
  await mkdir(path.join(dir, "scripts/e2e"), { recursive: true });
  await copyFile(path.join(root, "packages/web/scripts/runE2eShard.ts"), runner);
  await copyFile(path.join(root, "scripts/e2e/transportEvidence.ts"), path.join(dir, "scripts/e2e/transportEvidence.ts"));
  await mkdir(path.join(web, "tests/e2e/tests"), { recursive: true });
  await writeFile(path.join(web, "tests/e2e/tests/probe.spec.ts"), "// stub command does not execute tests\n");
  await writeFile(path.join(web, "e2e-shard-manifest.json"), JSON.stringify({
    shardCount: 1, shards: [{ shard: 1, expectedDurationMs: 1, files: ["tests/e2e/tests/probe.spec.ts"] }],
  }));
  const artifacts = path.join(web, "playwright-report/transport");
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, "stale.json"), "old run");
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "pnpm"), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(process.env.SLOCK_E2E_TRANSPORT_DIR + '/probe.json', JSON.stringify({runId: process.env.SLOCK_E2E_TRANSPORT_RUN_ID}));\nprocess.exit(7);\n`, { mode: 0o755 });
  const child = spawn(process.execPath, ["--import", "@oxc-node/core/register", runner, "1"], {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  assert.equal((await once(child, "exit"))[0], 7, output);
  const probe = JSON.parse(await readFile(path.join(artifacts, "probe.json"), "utf8"));
  assert.match(probe.runId, /^[a-f0-9-]{36}$/);
  assert.ok(output.includes(`runId=${probe.runId}`));
  await assert.rejects(stat(path.join(artifacts, "stale.json")), { code: "ENOENT" });
});
