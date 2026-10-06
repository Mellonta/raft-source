import assert from "node:assert/strict";

import { kPromotedSlotPath, resolveLiveExecutablePath } from "./liveExecutablePath";

const EXPERIMENT = "/home/raft/.slock/computer/k/slots/experiment/artifact.bin";
const STABLE = "/home/raft/.slock/computer/k/slots/stable/artifact.bin";

test("an existing startup path is used as is", () => {
  assert.equal(resolveLiveExecutablePath({ execPath: EXPERIMENT, platform: "linux", exists: () => true }), EXPERIMENT);
});

test("after K renames experiment to stable, Linux follows /proc/self/exe", () => {
  const exists = (p: string) => p === STABLE;
  assert.equal(
    resolveLiveExecutablePath({ execPath: EXPERIMENT, platform: "linux", exists, readProcSelfExe: () => STABLE }),
    STABLE,
  );
  // A deleted binary is not re-executable; fall through to the slot mapping.
  assert.equal(
    resolveLiveExecutablePath({ execPath: EXPERIMENT, platform: "linux", exists, readProcSelfExe: () => `${EXPERIMENT} (deleted)` }),
    STABLE,
  );
});

test("without /proc (macOS, Windows) the promoted stable slot is used", () => {
  const exists = (p: string) => p === STABLE;
  assert.equal(resolveLiveExecutablePath({ execPath: EXPERIMENT, platform: "darwin", exists }), STABLE);
  const winExp = "C:\\Users\\r\\.slock\\computer\\k\\slots\\experiment\\artifact.bin";
  const winStable = "C:\\Users\\r\\.slock\\computer\\k\\slots\\stable\\artifact.bin";
  assert.equal(resolveLiveExecutablePath({ execPath: winExp, platform: "win32", exists: (p) => p === winStable }), winStable);
});

test("a missing path outside a K experiment slot is returned unchanged", () => {
  assert.equal(kPromotedSlotPath("/usr/local/bin/raft-computer"), null);
  assert.equal(kPromotedSlotPath(STABLE), null);
  assert.equal(
    resolveLiveExecutablePath({ execPath: "/opt/gone/node", platform: "darwin", exists: () => false }),
    "/opt/gone/node",
  );
});

// XX review of #8395: K stages the NEXT candidate into slots/experiment before
// it stops the running service, so the startup path can exist again and name a
// different binary than the one running.
test("a re-staged experiment slot is not mistaken for the running binary", () => {
  const exists = (p: string) => p === EXPERIMENT || p === STABLE;
  const identityOf = (p: string) => (p === STABLE ? "1:100" : p === EXPERIMENT ? "1:200" : null);
  // Linux: the kernel's view wins even though the startup path exists.
  assert.equal(
    resolveLiveExecutablePath({ execPath: EXPERIMENT, platform: "linux", exists, readProcSelfExe: () => STABLE, identityOf, startupIdentity: "1:100" }),
    STABLE,
  );
  // No /proc (macOS): the startup identity picks the promoted stable file.
  assert.equal(
    resolveLiveExecutablePath({ execPath: EXPERIMENT, platform: "darwin", exists, identityOf, startupIdentity: "1:100" }),
    STABLE,
  );
  // Before any promotion the running binary is still at the startup path.
  assert.equal(
    resolveLiveExecutablePath({ execPath: EXPERIMENT, platform: "darwin", exists, identityOf: () => "1:200", startupIdentity: "1:200" }),
    EXPERIMENT,
  );
});
