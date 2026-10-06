import assert from "node:assert/strict";
import { spawn, spawnSync as realSpawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  forwardManagedTransportIfNeeded,
  ManagedTransportError,
  resolveManagedTransportWrapper,
  SLOCK_AGENT_LAUNCH_DIR_ENV,
  SLOCK_CLI_TRANSPORT_DIR_ENV,
} from "./managedTransport";

// The same subprocess contracts can also exercise the packed npm bin after
// `pnpm build`, without depending on a stale dist/ during ordinary source tests.
function cliArgs(args: string[]): string[] {
  return process.env.RAFT_TEST_CLI_ENTRY
    ? [path.resolve(process.env.RAFT_TEST_CLI_ENTRY), ...args]
    : ["--import", "@oxc-node/core/register", "src/index.ts", ...args];
}
const cliRoot = path.resolve(import.meta.dirname, "../..");
// Source entry loads the CLI graph twice on a successful handoff. Leave room
// for the full suite running on a shared worker; assertions use readiness and
// process results, never this timeout, as evidence of successful forwarding.
const subprocessTimeout = 90_000;

function fixture(): { root: string; wrapperDir: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(path.join(os.tmpdir(), "raft-managed-forward-"));
  const wrapperDir = path.join(root, "cli-transport", "agent-1", "launch-1");
  mkdirSync(wrapperDir, { recursive: true });
  writeFileSync(path.join(wrapperDir, "raft"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return {
    root,
    wrapperDir,
    env: {
      SLOCK_HOME: root,
      SLOCK_AGENT_ID: "agent-1",
      [SLOCK_AGENT_LAUNCH_DIR_ENV]: "launch-1",
      [SLOCK_CLI_TRANSPORT_DIR_ENV]: wrapperDir,
      RAFT_PROFILE: "foreign-profile",
      SLOCK_AGENT_PROXY_TOKEN: undefined,
      SLOCK_AGENT_PROXY_TOKEN_FILE: undefined,
      SLOCK_AGENT_TOKEN_FILE: undefined,
      SLOCK_CLI_MANAGED_FORWARD_ATTEMPT: undefined,
    },
  };
}

test("managed transport: a host-global CLI resolves the exact current-launch wrapper", () => {
  const { root, wrapperDir, env } = fixture();
  try {
    assert.equal(resolveManagedTransportWrapper(env, "linux"), path.join(wrapperDir, "raft"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed transport: forwarding executes the wrapper instead of continuing with ambient profile", async () => {
  const { root, env } = fixture();
  try {
    const calls: Array<{ command: string; argv: readonly string[] }> = [];
    const result = await forwardManagedTransportIfNeeded(["message", "check"], env, {
      platform: "linux",
      spawn: ((command: string, argv: readonly string[], options: import("node:child_process").SpawnOptions) => {
        calls.push({ command, argv });
        assert.equal(options.shell, false);
        assert.equal(options.stdio, "inherit");
        assert.equal(options.env?.SLOCK_CLI_MANAGED_FORWARD_ATTEMPT, "1");
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      }) as typeof spawn,
    });
    assert.equal(result?.status, 0);
    assert.deepEqual(calls, [{
      command: path.join(env[SLOCK_CLI_TRANSPORT_DIR_ENV]!, "raft"),
      argv: ["message", "check"],
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed transport: arbitrary or symlink transport directories fail closed", () => {
  const { root, env } = fixture();
  try {
    env[SLOCK_CLI_TRANSPORT_DIR_ENV] = path.join(root, "foreign");
    assert.throws(
      () => resolveManagedTransportWrapper(env, "linux"),
      (error: unknown) => error instanceof ManagedTransportError && error.code === "MANAGED_WRAPPER_UNAVAILABLE",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed transport: wrapper-authenticated invocation does not recurse", () => {
  const { root, env } = fixture();
  try {
    env.SLOCK_AGENT_PROXY_TOKEN_FILE = path.join(root, "proxy-token");
    assert.equal(resolveManagedTransportWrapper(env, "linux"), null);
    env.SLOCK_CLI_MANAGED_FORWARD_ATTEMPT = "1";
    assert.equal(resolveManagedTransportWrapper(env, "linux"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed transport: an attempted handoff without wrapper credentials fails instead of looping", () => {
  const { root, env } = fixture();
  try {
    env.SLOCK_CLI_MANAGED_FORWARD_ATTEMPT = "1";
    assert.throws(
      () => resolveManagedTransportWrapper(env, "linux"),
      (error: unknown) => error instanceof ManagedTransportError && error.code === "MANAGED_WRAPPER_FORWARD_FAILED",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed transport: the real CLI preserves a wrapper termination signal", { skip: process.platform === "win32" }, () => {
  const { root, wrapperDir, env } = fixture();
  try {
    writeFileSync(path.join(wrapperDir, "raft"), '#!/bin/sh\nkill -TERM "$$"\n', { mode: 0o755 });
    const result = realSpawnSync(process.execPath, cliArgs(["message", "check"]), {
      cwd: cliRoot,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: subprocessTimeout,
    });
    assert.equal(result.signal, "SIGTERM", result.stderr);
    assert.equal(result.status, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed transport: the real CLI entry forwards before parsing or profile auth", { skip: process.platform === "win32" }, () => {
  const { root, wrapperDir, env } = fixture();
  const argsFile = path.join(root, "forwarded-args");
  try {
    writeFileSync(
      path.join(wrapperDir, "raft"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\nexit 23\n`,
      { mode: 0o755 },
    );
    const result = realSpawnSync(
      process.execPath,
      cliArgs(["message", "check"]),
      {
        cwd: cliRoot,
        env: { ...process.env, ...env },
        encoding: "utf8",
        timeout: subprocessTimeout,
      },
    );
    assert.equal(result.status, 23, result.stderr);
    assert.equal(readFileSync(argsFile, "utf8"), "message\ncheck\n");
    assert.doesNotMatch(result.stderr, /PROFILE_FILE|MISSING_TOKEN|unknown command/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed transport: real CLI preserves stdin, both output streams, literal arguments and exit code", { skip: process.platform === "win32" }, () => {
  const { root, wrapperDir, env } = fixture();
  try {
    const receiver = path.join(root, "receiver.mjs");
    writeFileSync(receiver, `import { readFileSync } from 'node:fs';
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input: readFileSync(0, 'utf8') }));
process.stderr.write('receiver-stderr');
process.exitCode = 27;
`);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(path.join(wrapperDir, "raft"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(receiver)} "$@"\n`, { mode: 0o755 });
    const args = ["message", "send", "--target", "#synthetic", "$(touch should-not-exist)", "a'b", "two words", "line\nbreak", ""];
    const result = realSpawnSync(process.execPath, cliArgs(args), {
      cwd: cliRoot, env: { ...process.env, ...env }, encoding: "utf8",
      input: "synthetic message\nsecond line\n", timeout: subprocessTimeout,
    });
    assert.equal(result.status, 27, result.stderr);
    assert.equal(result.stderr, "receiver-stderr");
    assert.deepEqual(JSON.parse(result.stdout), { args, input: "synthetic message\nsecond line\n" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed transport: a signal sent only to the global CLI reaches the child", { skip: process.platform === "win32", timeout: subprocessTimeout }, async () => {
  const { root, wrapperDir, env } = fixture();
  const receiver = path.join(root, "receiver.mjs");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(receiver, `process.on('SIGTERM', () => { process.stdout.write('terminated'); process.exit(42); });
process.stdout.write('ready');
setTimeout(() => process.exit(99), 15000);
`);
  writeFileSync(path.join(wrapperDir, "raft"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(receiver)}\n`, { mode: 0o755 });
  const child = spawn(process.execPath, cliArgs(["message", "check"]), {
    cwd: cliRoot, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const exited = once(child, "close");
    await Promise.race([
      once(child.stdout, "data"),
      exited.then(() => { throw new Error(`CLI exited before receiver readiness: ${stderr}`); }),
    ]);
    assert.equal(stdout, "ready");
    child.kill("SIGTERM");
    const [status, signal] = await exited;
    assert.equal(status, 42, stderr);
    assert.equal(signal, null);
    assert.equal(stdout, "readyterminated");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed transport: a broken wrapper reentering the CLI fails with a bounded error", { skip: process.platform === "win32" }, () => {
  const { root, wrapperDir, env } = fixture();
  try {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(path.join(wrapperDir, "raft"), `#!/bin/sh\nexec ${[process.execPath, ...cliArgs([])].map(quote).join(" ")} "$@"\n`, { mode: 0o755 });
    const result = realSpawnSync(process.execPath, cliArgs(["message", "check"]), {
      cwd: cliRoot, env: { ...process.env, ...env }, encoding: "utf8", timeout: subprocessTimeout,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Code: MANAGED_WRAPPER_FORWARD_FAILED/);
    assert.doesNotMatch(result.stderr, /PROFILE_FILE|MISSING_TOKEN/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed transport: symlink wrappers, missing identity and Windows bypass fail closed", () => {
  const { root, wrapperDir, env } = fixture();
  try {
    const wrapper = path.join(wrapperDir, "raft");
    rmSync(wrapper);
    symlinkSync(path.join(root, "not-a-wrapper"), wrapper);
    assert.throws(() => resolveManagedTransportWrapper(env, "linux"), /wrapper is missing/);
    assert.throws(() => resolveManagedTransportWrapper({ ...env, SLOCK_AGENT_ID: "" }, "linux"), /identity is incomplete/);
    assert.throws(() => resolveManagedTransportWrapper(env, "win32"), (error: unknown) => error instanceof ManagedTransportError && error.code === "MANAGED_WRAPPER_REQUIRED");
    assert.equal(resolveManagedTransportWrapper({ RAFT_PROFILE: "external" }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed transport: login-shell PATH override still authenticates as the current managed agent", { skip: process.platform === "win32" }, () => {
  const { root, wrapperDir, env } = fixture();
  try {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const globalDir = path.join(root, "global-bin");
    mkdirSync(globalDir);
    const launch = `exec ${[process.execPath, ...cliArgs([])].map(quote).join(" ")} "$@"\n`;
    writeFileSync(path.join(globalDir, "raft"), `#!/bin/sh\n${launch}`, { mode: 0o755 });
    const loginProfile = path.join(root, ".bash_profile");
    writeFileSync(loginProfile, `export PATH=${quote(globalDir)}:"$PATH"\n`);
    const tokenFile = path.join(root, "synthetic-token");
    const token = "synthetic-managed-forward-test-only";
    writeFileSync(tokenFile, token, { mode: 0o600 });
    writeFileSync(path.join(wrapperDir, "raft"), `#!/bin/sh
unset RAFT_PROFILE SLOCK_PROFILE RAFT_PROFILE_DIR SLOCK_PROFILE_DIR
export SLOCK_AGENT_ID=agent-1 SLOCK_SERVER_URL=http://127.0.0.1:1
export SLOCK_AGENT_PROXY_URL=http://127.0.0.1:1 SLOCK_AGENT_PROXY_TOKEN_FILE=${quote(tokenFile)}
${launch}`, { mode: 0o755 });
    // Do not depend on host /etc/profile preserving HOME or choosing our
    // temporary profile. Run a login shell with only this fixture's startup
    // rules, then prove it selected the global entry before invoking it.
    const result = realSpawnSync("/bin/bash", ["--noprofile", "--login", "-c", '. "$RAFT_TEST_LOGIN_PROFILE"; command -v raft; raft auth whoami'], {
      cwd: cliRoot, encoding: "utf8", timeout: subprocessTimeout,
      env: { ...process.env, ...env, RAFT_TEST_LOGIN_PROFILE: loginProfile, PATH: `${wrapperDir}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(result.error, undefined);
    // whoami also confirms identity with the server through the managed
    // proxy; the fixture proxy (127.0.0.1:1) is unreachable, so the command
    // fails explicitly while still printing the locally resolved context.
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Could not confirm identity with the server/);
    const newline = result.stdout.indexOf("\n");
    assert.equal(result.stdout.slice(0, newline), path.join(globalDir, "raft"));
    const identity = JSON.parse(result.stdout.slice(newline + 1));
    assert.equal(identity.data.serverConfirmed, false);
    assert.equal(identity.data.agentId, "agent-1");
    assert.equal(identity.data.clientMode, "managed-runner");
    assert.equal(identity.data.secretSource, "agent-proxy-token-file");
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
    assert.equal(identity.data.profileSlug, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed transport: unexecutable wrapper returns a typed error and removes signal handlers", { skip: process.platform === "win32" }, async () => {
  const { root, wrapperDir, env } = fixture();
  try {
    rmSync(path.join(wrapperDir, "raft"));
    writeFileSync(path.join(wrapperDir, "raft"), "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    const before = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => process.listenerCount(signal));
    await assert.rejects(forwardManagedTransportIfNeeded(["auth", "whoami"], env),
      (error: unknown) => error instanceof ManagedTransportError && error.code === "MANAGED_WRAPPER_FORWARD_FAILED");
    assert.deepEqual(["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => process.listenerCount(signal)), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
