import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("setup-ubuntu.sh", import.meta.url));
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
function bash(code, env = {}) {
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", code], {
    encoding: "utf8", env: { ...process.env, VITE_DEV_ALLOWED_HOSTS: undefined, ...env },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

test("help describes existing Docker reuse and requires no privileged setup", () => {
  const result = bash(`bash ${quote(script)} --help`);
  assert.match(result.stdout, /Docker configuration, storage, group membership, and services are not modified/);
  assert.match(result.stdout, /\/data\/raft/);
});

test("generated launchers load pinned tools and external state without relying on bashrc", (t) => {
  const root = mkdtempSync(join(tmpdir(), "raft-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, "data with spaces");
  const source = join(data, "raft");
  const config = join(data, ".raft-config");
  const nodeBin = join(data, ".nvm/versions/node/v24.15.0/bin");
  for (const dir of [source, config, nodeBin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(source, "raftdev"), `#!/bin/bash
printf '%s\\n' "$*" "$RAFTDEV_STATE_DIR" "$SLOCK_HOME" "$VITE_DEV_ALLOWED_HOSTS" "$TMPDIR" "$XDG_CACHE_HOME" "$(command -v node)"
`);
  chmodSync(join(source, "raftdev"), 0o700);
  writeFileSync(join(nodeBin, "node"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(nodeBin, "node"), 0o700);
  const generate = (hostsSet, hosts) => bash(`source ${quote(script)}
write_runtime_files ${[config, source, data, nodeBin, join(data, ".nvm"), "raft", hostsSet, hosts].map(quote).join(" ")}`);
  generate("1", "a.b.com,.example.net");
  const result = bash(`bash ${quote(join(config, "start.sh"))}`);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "start raft", join(data, ".raftdev"), join(data, ".raft"), "a.b.com,.example.net",
    join(data, ".tmp"), join(data, ".cache"), join(nodeBin, "node"),
  ]);
  // A rerun preserves operator edits unless the caller explicitly updates hosts.
  const settings = join(config, "settings.sh");
  writeFileSync(settings, `${readFileSync(settings, "utf8")}export MY_LOCAL_SETTING=keep\n`);
  generate("0", "ignored.example");
  assert.match(bash(`bash ${quote(join(config, "start.sh"))}`).stdout, /a\.b\.com,\.example\.net/);
  generate("1", "new.example");
  assert.match(readFileSync(settings, "utf8"), /MY_LOCAL_SETTING=keep/);
  assert.match(bash(`bash ${quote(join(config, "start.sh"))}`).stdout, /new\.example/);
  assert.match(bash(`bash ${quote(join(config, "start.sh"))}`, { VITE_DEV_ALLOWED_HOSTS: "launch.example" }).stdout, /launch\.example/);
});

test("host values are data when setup writes runtime settings", (t) => {
  const root = mkdtempSync(join(tmpdir(), "raft-setup-quote-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "config");
  mkdirSync(config);
  const hosts = "a.b.com,$(printf injected),'quoted'";
  const result = bash(`source ${quote(script)}
write_runtime_files ${[config, root, root, root, root, "raft", "1", hosts].map(quote).join(" ")}
source ${quote(join(config, "runtime.sh"))}
printf '%s' "$VITE_DEV_ALLOWED_HOSTS"`);
  assert.equal(result.stdout, hosts);
});
