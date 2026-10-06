// `raft … --help | head` closes stdout early. The CLI must exit quietly, not
// print an unhandled EPIPE stack into the caller's output.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { test, vi } from "vitest";

import { SLOCK_CLI_TRANSPORT_DIR_ENV } from "./auth/managedTransport";
import { installStdoutEpipeGuard } from "./core/stdoutEpipe";

test("a reader that closes stdout early gets a quiet exit, not an EPIPE stack", async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
  // Exercise the repository entry, not a daemon-managed wrapper.
  delete env[SLOCK_CLI_TRANSPORT_DIR_ENV];
  const child = spawn(process.execPath, ["--import", "@oxc-node/core/register", "src/index.ts", "task", "create", "--help"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Close the read end before anything is written, like `| head -0`.
  child.stdout.destroy();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const [code] = await once(child, "exit");
  assert.doesNotMatch(stderr, /EPIPE|Unhandled 'error' event/);
  assert.equal(code, 0);
});

test("EPIPE keeps quiet but never decides success: a non-zero exit code survives", () => {
  const stream = new EventEmitter();
  installStdoutEpipeGuard(stream);
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  const prior = process.exitCode;
  process.exitCode = 3; // e.g. a held command whose guidance was cut off by `| head`
  try {
    stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    stream.emit("error", Object.assign(new Error("write after destroy"), { code: "ERR_STREAM_DESTROYED" }));
    assert.equal(exit.mock.calls.length, 0, "the guard never exits on its own");
    assert.equal(process.exitCode, 3);
    assert.throws(() => stream.emit("error", Object.assign(new Error("boom"), { code: "EIO" })), /boom/);
  } finally {
    process.exitCode = prior;
    exit.mockRestore();
  }
});
