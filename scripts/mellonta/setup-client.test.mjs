import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("setup-client.sh", import.meta.url));
const version = "2.3.4-mellonta.9";
const releaseBase = "https://github.com/Mellonta/raft-source/releases/download";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mellonta-client-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "user");
  const state = join(home, "state with spaces ' $literal");
  const bin = join(state, "bin");
  const tools = join(root, "tools");
  for (const dir of [home, tools]) mkdirSync(dir, { recursive: true });
  function executable(path, body) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }
  const nodeScript = (body) => `#!${process.execPath}\n${body}\n`;
  executable(join(tools, "uname"), '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n');
  // GNU realpath -m is present on Linux; emulate it for the macOS unit run.
  executable(join(tools, "realpath"), nodeScript(`console.log(require('node:path').resolve(process.argv.at(-1)));`));
  executable(join(tools, "sha256sum"), nodeScript(`
    const fs = require('node:fs');
    console.log(require('node:crypto').createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex') + '  ' + process.argv[2]);
  `));
  executable(join(tools, "curl"), nodeScript(`
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const url = args.find(a => a.startsWith('https://'));
    fs.appendFileSync(process.env.MOCK_DOWNLOADS, url + '\\n');
    if (url.endsWith('/releases/latest')) {
      process.stdout.write('https://github.com/Mellonta/raft-source/releases/tag/' + process.env.MOCK_VERSION);
    } else {
      const target = args[args.indexOf('-o') + 1];
      const installer = fs.readFileSync(process.env.MOCK_INSTALLER);
      if (url.endsWith('/install.sh')) fs.writeFileSync(target, installer);
      else if (url.endsWith('/SHA256SUMS')) {
        const hash = process.env.MOCK_BAD_CHECKSUM ? '0'.repeat(64) : require('node:crypto').createHash('sha256').update(installer).digest('hex');
        fs.writeFileSync(target, hash + '  install.sh\\n');
      } else process.exit(99);
    }
  `));
  const binary = join(root, "mock-computer");
  executable(binary, nodeScript(`
    const fs = require('node:fs');
    const env = Object.fromEntries(['RAFT_HOME', 'SLOCK_HOME', 'RAFT_COMPUTER_RELEASE_BASE', 'RAFT_COMPUTER_RELEASE_BACKEND', 'RAFT_COMPUTER_UPGRADE_BASE_URL'].map(k => [k, process.env[k]]));
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.MOCK_CALLS, JSON.stringify({ args, env }) + '\\n');
    if (args[0] === 'stop' && process.env.MOCK_STOP_FAIL) process.exit(33);
    if (args[0] === '--version') console.log(process.env.MOCK_VERSION);
  `));
  const installer = join(root, "mock-installer");
  executable(installer, `#!/bin/sh
set -eu
test "$RAFT_COMPUTER_RELEASE_BACKEND" = legacy-cdn
test "$RAFT_COMPUTER_RELEASE_BASE" = '${releaseBase}'
test "$RAFT_COMPUTER_FORCE" = 1
test "$RAFT_COMPUTER_NO_MODIFY_PATH" = 1
test "$RAFT_COMPUTER_INSTALL_CHANNEL" = "pinned:$RAFT_COMPUTER_VERSION"
test "$1" = --version && test "$2" = "$RAFT_COMPUTER_VERSION"
test "$3" = --channel && test "$4" = "pinned:$RAFT_COMPUTER_VERSION"
printf '%s\\n' installer >> "$MOCK_DOWNLOADS"
test -z "$MOCK_INSTALL_FAIL"
mkdir -p "$RAFT_COMPUTER_INSTALL_DIR" "$RAFT_HOME/computer/k-quarantine"
cp "$MOCK_BINARY" "$RAFT_COMPUTER_INSTALL_DIR/raft-computer"
printf wasm > "$RAFT_COMPUTER_INSTALL_DIR/photon_rs_bg.wasm"
printf 'pinned:%s\\n' "$RAFT_COMPUTER_VERSION" > "$RAFT_HOME/computer/channel"
`);
  const env = {
    ...process.env, HOME: home, PATH: `${tools}:${process.env.PATH}`,
    RAFT_HOME: undefined, SLOCK_HOME: undefined, RAFT_COMPUTER_INSTALL_DIR: undefined,
    RAFT_COMPUTER_RELEASE_BACKEND: "hands", RAFT_COMPUTER_RELEASE_BASE: "https://old.example",
    RAFT_COMPUTER_UPGRADE_BASE_URL: "https://old.example", RAFT_COMPUTER_INSTALL_CHANNEL: "alpha",
    MOCK_VERSION: version, MOCK_INSTALLER: installer, MOCK_BINARY: binary,
    MOCK_INSTALL_FAIL: "", MOCK_STOP_FAIL: "", MOCK_BAD_CHECKSUM: "",
    MOCK_DOWNLOADS: join(root, "downloads"), MOCK_CALLS: join(root, "calls"),
  };
  const run = (args = [], extraEnv = {}) => spawnSync("bash", [script,
    "--server-url", "http://raft.example:8080/", "--workspace", "/my-team",
    "--home", state, "--install-dir", bin, "--install-only", ...args,
  ], { cwd: root, env: { ...env, ...extraEnv }, encoding: "utf8" });
  const existing = () => {
    mkdirSync(join(state, "computer"), { recursive: true });
    writeFileSync(join(state, "computer/old-session"), "old credentials");
    executable(join(bin, "raft-computer"), readFileSync(binary));
  };
  const calls = () => existsSync(env.MOCK_CALLS) ? readFileSync(env.MOCK_CALLS, "utf8").trim().split("\n").map(JSON.parse) : [];
  return { root, home, state, bin, env, run, existing, calls };
}

function success(result) { assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); }

test("help does not require Linux or a configured server", () => {
  const result = spawnSync("bash", [script, "--help"], { encoding: "utf8" });
  success(result);
  assert.match(result.stdout, /Node, npm, Docker, and a source checkout are not required/);
});

test("latest release is verified, pinned, and launchers override stale shell settings", (t) => {
  const f = fixture(t);
  success(f.run());
  assert.equal(readFileSync(join(f.state, "computer/channel"), "utf8"), `pinned:${version}\n`);
  assert.match(readFileSync(f.env.MOCK_DOWNLOADS, "utf8"), new RegExp(`/download/${version}/install.sh`));
  for (const [launcher, args] of [["connect.sh", ["setup", "/my-team", "--server-url", "http://raft.example:8080"]], ["start.sh", ["start", "/my-team"]], ["raft-computer", ["status"]]]) {
    success(spawnSync("bash", [join(f.state, "mellonta", launcher), ...(launcher === "raft-computer" ? ["status"] : [])], {
      env: { ...f.env, RAFT_HOME: "/wrong", SLOCK_HOME: "/also-wrong" }, encoding: "utf8",
    }));
    const call = f.calls().at(-1);
    assert.deepEqual(call.args, args);
    assert.equal(call.env.RAFT_HOME, f.state);
    assert.equal(call.env.SLOCK_HOME, f.state);
    assert.equal(call.env.RAFT_COMPUTER_RELEASE_BACKEND, "legacy-cdn");
    assert.equal(call.env.RAFT_COMPUTER_UPGRADE_BASE_URL, releaseBase);
  }
  assert.equal(existsSync(join(f.home, ".bashrc")), false);
});

test("reset removes old state and updater archives but preserves a binary inside the state home", (t) => {
  const f = fixture(t);
  f.existing();
  mkdirSync(join(f.home, ".claude"));
  writeFileSync(join(f.home, ".claude/credentials"), "provider login");
  success(f.run(["--reset", "--version", version]));
  assert.equal(existsSync(join(f.state, "computer/old-session")), false);
  assert.equal(existsSync(join(f.state, "computer/k-quarantine")), false);
  assert.equal(readFileSync(join(f.bin, "photon_rs_bg.wasm"), "utf8"), "wasm");
  assert.equal(readFileSync(join(f.home, ".claude/credentials"), "utf8"), "provider login");
  assert.deepEqual(f.calls().map(c => c.args), [["stop"], ["stop"]]);
  assert.doesNotMatch(readFileSync(f.env.MOCK_DOWNLOADS, "utf8"), /releases\/latest/);
});

test("rerunning without reset retains credentials", (t) => {
  const f = fixture(t);
  f.existing();
  success(f.run());
  assert.equal(readFileSync(join(f.state, "computer/old-session"), "utf8"), "old credentials");
});

for (const fault of ["MOCK_BAD_CHECKSUM", "MOCK_INSTALL_FAIL", "MOCK_STOP_FAIL"]) {
  test(`${fault} never erases the selected home`, (t) => {
    const f = fixture(t);
    f.existing();
    assert.notEqual(f.run(["--reset"], { [fault]: "1" }).status, 0);
    assert.equal(readFileSync(join(f.state, "computer/old-session"), "utf8"), "old credentials");
    if (fault === "MOCK_BAD_CHECKSUM") assert.deepEqual(f.calls(), []);
  });
}

test("reset refuses a live PID even when the stop command reports success", (t) => {
  const f = fixture(t);
  f.existing();
  mkdirSync(join(f.state, "computer/run"));
  writeFileSync(join(f.state, "computer/run/service.pid"), String(process.pid));
  const result = f.run(["--reset"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /still running/);
  assert.equal(existsSync(join(f.state, "computer/old-session")), true);
});

test("reset refuses the user home, unrecognized directories, and symlinks before downloading", (t) => {
  const f = fixture(t);
  mkdirSync(f.state);
  writeFileSync(join(f.state, "unrelated"), "keep");
  const link = join(f.root, "link");
  symlinkSync(f.state, link);
  for (const path of [f.home, f.state, link]) {
    const result = f.run(["--reset", "--home", path]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing|symlink/);
  }
  assert.equal(existsSync(f.env.MOCK_DOWNLOADS), false);
  assert.equal(readFileSync(join(f.state, "unrelated"), "utf8"), "keep");
});
