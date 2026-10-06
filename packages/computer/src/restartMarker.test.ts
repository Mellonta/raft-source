import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPendingRestartMarker,
  readPendingRestartMarker,
  shouldReconcilePendingRestart,
  writePendingRestartMarker,
} from "./restartMarker";

test("pending restart marker survives the service blip and is origin-gated", async () => {
  const home = await mkdtemp(join(tmpdir(), "computer-restart-marker-"));
  try {
    const marker = {
      requestId: "restart-1",
      originServerId: "server-a",
      startedAt: "2026-07-11T04:24:51.000Z",
    };
    await writePendingRestartMarker(home, marker);

    assert.deepEqual(await readPendingRestartMarker(home), marker);
    assert.equal(shouldReconcilePendingRestart(marker, "server-a"), true);
    assert.equal(shouldReconcilePendingRestart(marker, "server-b"), false);

    await clearPendingRestartMarker(home);
    assert.equal(await readPendingRestartMarker(home), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// task #803: local CLI restarts bind one lifecycle operation per attached
// server; each runner must report its own operation and the marker must
// survive until every bound server has reported.
test("per-server restart request ids resolve and retire independently", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const {
    pendingRestartRequestIdForServer,
    readPendingRestartMarker,
    retirePendingRestartForServer,
    shouldReconcilePendingRestart,
    writePendingRestartMarker,
  } = await import("./restartMarker");
  const slockHome = await mkdtemp(path.join(os.tmpdir(), "restart-marker-803-"));
  try {
    const marker = {
      requestId: "op-a",
      originServerId: "server-a",
      requestIds: { "server-a": "op-a", "server-b": "op-b" },
      startedAt: "2026-09-13T08:52:49.980Z",
    };
    await writePendingRestartMarker(slockHome, marker);
    const read = await readPendingRestartMarker(slockHome);
    assert.ok(read);
    assert.equal(pendingRestartRequestIdForServer(read!, "server-a"), "op-a");
    assert.equal(pendingRestartRequestIdForServer(read!, "server-b"), "op-b");
    assert.equal(pendingRestartRequestIdForServer(read!, "server-c"), null);
    assert.equal(shouldReconcilePendingRestart(read!, "server-b"), true);
    assert.equal(shouldReconcilePendingRestart(read!, "server-c"), false);

    // First runner back retires only its own entry.
    await retirePendingRestartForServer(slockHome, read!, "server-a");
    const afterA = await readPendingRestartMarker(slockHome);
    assert.ok(afterA, "marker must survive until server-b reports");
    assert.equal(pendingRestartRequestIdForServer(afterA!, "server-a"), null);
    assert.equal(pendingRestartRequestIdForServer(afterA!, "server-b"), "op-b");

    await retirePendingRestartForServer(slockHome, afterA!, "server-b");
    assert.equal(await readPendingRestartMarker(slockHome), null);

    // Legacy Web-origin marker (no requestIds) keeps the single-origin rule.
    const legacy = { requestId: "web-1", originServerId: "server-a", startedAt: "2026-09-13T00:00:00.000Z" };
    await writePendingRestartMarker(slockHome, legacy);
    assert.equal(pendingRestartRequestIdForServer(legacy, "server-a"), "web-1");
    assert.equal(pendingRestartRequestIdForServer(legacy, "server-b"), null);
    await retirePendingRestartForServer(slockHome, legacy, "server-b");
    assert.ok(await readPendingRestartMarker(slockHome), "another server must not clear a legacy marker");
    await retirePendingRestartForServer(slockHome, legacy, "server-a");
    assert.equal(await readPendingRestartMarker(slockHome), null);
  } finally {
    await rm(slockHome, { recursive: true, force: true });
  }
});
