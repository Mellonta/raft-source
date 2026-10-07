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
