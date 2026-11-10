import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { prepareManagedMcpRuntimeProxy } from "./managedMcpRuntimeProxy";
import { DaemonTraceBundleUploader } from "./traceBundleUpload";
import { collectFeedbackTranscriptAttachment } from "./feedbackTranscriptCollector";
import { uploadWithSignedCapability } from "./directUploadCapability";
import { createProviderHttpClient, daemonFetch, setDaemonFetchImplForTests } from "./daemonFetch";

beforeEach(() => vi.stubEnv("RAFT_PRIVACY_MODE", "1"));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

test("managed MCP is skipped before discovery or opening a listener", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const listenSpy = vi.spyOn(http, "createServer");
  assert.equal(await prepareManagedMcpRuntimeProxy({
    agentId: "agent-1",
    launchId: "launch-1",
    serverUrl: "https://server.test",
    agentCredentialKey: "sk_agent_test",
  }), null);
  assert.equal(fetchSpy.mock.calls.length, 0);
  assert.equal(listenSpy.mock.calls.length, 0);
});

test("daemon and provider transports block vendor destinations and preserve configured model requests", async () => {
  const send = vi.fn(async () => new Response("ok"));
  setDaemonFetchImplForTests(send as never);
  const client = createProviderHttpClient({}, "privacy-test");
  try {
    await assert.rejects(daemonFetch("https://api.slock.ai/internal/report"), /vendor services/);
    await assert.rejects(client.fetch("https://hands.build/"), /vendor services/);
    assert.equal(send.mock.calls.length, 0);
    assert.equal(await (await client.fetch("https://model.company.example/v1/responses")).text(), "ok");
    assert.equal(send.mock.calls.length, 1);
  } finally {
    client.dispose();
    setDaemonFetchImplForTests(undefined);
  }
});

test("trace files remain local even with an explicit upload URL and enable-like environment", async () => {
  vi.stubEnv("SLOCK_DAEMON_TRACE_UPLOAD_DISABLED", "0");
  vi.useFakeTimers();
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "mellonta-trace-"));
  try {
    await mkdir(path.join(machineDir, "traces"));
    await writeFile(path.join(machineDir, "traces", "daemon-trace-private.jsonl"), "private trace\n");
    const fetchImpl = vi.fn(async () => new Response("unexpected upload", { status: 500 }));
    const uploader = new DaemonTraceBundleUploader({
      machineDir, serverUrl: "https://server.test", apiKey: "sk_machine_test",
      workerUrl: "https://worker.test", minFileAgeMs: 0, fetchImpl,
    });
    uploader.start();
    assert.equal(vi.getTimerCount(), 0);
    assert.deepEqual(await uploader.uploadOnce(), { attempted: 0, uploaded: 0, deferred: 0 });
    assert.equal(fetchImpl.mock.calls.length, 0);
    uploader.stop();
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("trace and session-transcript uploads cannot obtain an upload capability", async () => {
  const fetchImpl = vi.fn(async () => new Response("unexpected upload", { status: 500 }));
  await assert.rejects(uploadWithSignedCapability({
    serverUrl: "https://server.test", apiKey: "sk_machine_test",
    workerUrl: "https://worker.test", scope: "daemon-trace-bundle:create",
    createBody: {}, uploadBody: "private transcript", fetchImpl,
  }), /Diagnostic uploads are disabled/);
  await assert.rejects(uploadWithSignedCapability({
    serverUrl: "https://server.test", apiKey: "sk_machine_test",
    workerUrl: "https://worker.test", scope: "feedback-report:create",
    createBody: {}, uploadBody: "private report", fetchImpl,
  }), /Diagnostic uploads are disabled/);
  assert.equal(fetchImpl.mock.calls.length, 0);
});

test("a request from an older server cannot read a private transcript to build feedback", async () => {
  const read = vi.fn();
  const result = await collectFeedbackTranscriptAttachment({ getSessionTranscript: read } as never);
  assert.equal(result.reachable, false);
  assert.equal(read.mock.calls.length, 0);
});
