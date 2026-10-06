import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

import { resolveLiveExecutablePath } from "@botiverse/raft-shared";
import { executableFileIdentity } from "./liveExecutable";

// XX review of #8395 on the real filesystem: a rename keeps the file identity,
// a re-staged candidate at the old path has a new one, so the identity recorded
// at start tells the running binary apart from the next candidate.
test("file identity survives the K promotion rename and differs for a re-staged candidate", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "raft-live-exec-"));
  try {
    const experiment = path.join(root, "slots", "experiment", "artifact.bin");
    const stable = path.join(root, "slots", "stable", "artifact.bin");
    mkdirSync(path.dirname(experiment), { recursive: true });
    writeFileSync(experiment, "running build");
    const startup = executableFileIdentity(experiment);
    assert.ok(startup, "this platform reports file identity");

    renameSync(path.dirname(experiment), path.dirname(stable)); // promote
    mkdirSync(path.dirname(experiment), { recursive: true });
    writeFileSync(experiment, "next candidate"); // stage the next upgrade

    assert.equal(executableFileIdentity(stable), startup);
    assert.notEqual(executableFileIdentity(experiment), startup);
    assert.equal(
      resolveLiveExecutablePath({
        execPath: experiment,
        platform: "darwin",
        exists: (p) => executableFileIdentity(p) !== null,
        identityOf: executableFileIdentity,
        startupIdentity: startup,
      }),
      stable,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
