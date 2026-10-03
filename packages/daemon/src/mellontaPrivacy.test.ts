import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";
import { prepareManagedMcpRuntimeProxy } from "./managedMcpRuntimeProxy.js";
import { DaemonTraceBundleUploader } from "./traceBundleUpload.js";
import { uploadWithSignedCapability } from "./directUploadCapability.js";

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
    assert.deepEqual(await uploader.uploadOnce(), { attempted: 0, uploaded: 0 });
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
  assert.equal(fetchImpl.mock.calls.length, 0);
});
