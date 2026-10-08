import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { diagnosticsPush } from "./diagnosticsPush";

test("even forced diagnostics push is disabled before filesystem or network work", async () => {
  const slockHome = await mkdtemp(path.join(os.tmpdir(), "mellonta-diagnostics-"));
  const fetchImpl = vi.fn(async () => new Response("unexpected upload", { status: 500 }));
  try {
    const result = await diagnosticsPush({ slockHome }, {
      forceUploadNow: true, workerUrl: "https://worker.test", fetchImpl,
    });
    assert.deepEqual(result, { status: "failed", reason: "UPLOAD_DISABLED" });
    assert.equal(fetchImpl.mock.calls.length, 0);
    assert.deepEqual(await readdir(slockHome), []);
  } finally {
    await rm(slockHome, { recursive: true, force: true });
  }
});


test("local tracing and upstream discovery stay disabled with enable-like settings", async () => {
  const { computerLocalTraceDisabled, createComputerTracer } = await import("../lib/computerTracer");
  const { noopTracer } = await import("@botiverse/raft-shared");
  const { listChannelVersions } = await import("../channel");
  assert.equal(computerLocalTraceDisabled({ RAFT_COMPUTER_LOCAL_TRACE: "1" }), true);
  assert.equal(createComputerTracer("/unused", "computer.cli"), noopTracer);
  const fetchFn = vi.fn<typeof fetch>();
  await assert.rejects(listChannelVersions("latest", 10, { fetchFn }), /Upstream release discovery is disabled/);
  assert.equal(fetchFn.mock.calls.length, 0);
});


test("saved upstream endpoints and release overrides are rejected before network access", async () => {
  const { computerFetch } = await import("../proxy");
  const { fetchCdnLatestVersionResult } = await import("../computerRelease");
  const fetchFn = vi.fn<typeof fetch>();
  assert.throws(() => computerFetch("https://api.raft.build/api/auth/me"), /Botiverse-hosted services are disabled/);
  await assert.rejects(fetchCdnLatestVersionResult("https://cdn.raft.build/computer", fetchFn), /Botiverse-hosted services are disabled/);
  assert.equal(fetchFn.mock.calls.length, 0);
});
