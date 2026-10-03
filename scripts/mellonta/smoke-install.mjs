// Exercise the actual release installer against locally served release assets.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = resolve(process.argv[2] || join(root, "packages/computer/dist-native"));
const { version } = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
const home = await mkdtemp(join(tmpdir(), "mellonta-install-"));
const server = createServer(async (req, res) => {
  const name = basename(req.url || "");
  if (req.url !== `/${version}/${name}`) { res.writeHead(404).end(); return; }
  try {
    const size = (await stat(join(out, name))).size;
    res.writeHead(200, { "content-length": size });
    createReadStream(join(out, name)).pipe(res);
  } catch { res.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const env = {
  ...process.env, HOME: home, RAFT_HOME: join(home, "state"), SLOCK_HOME: join(home, "state"),
  RAFT_COMPUTER_INSTALL_DIR: join(home, "bin"), RAFT_COMPUTER_NO_MODIFY_PATH: "1",
  RAFT_COMPUTER_RELEASE_BASE: `http://127.0.0.1:${server.address().port}`,
};
async function run(command, args) {
  let stdout = "";
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  await new Promise((done, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? done() : reject(new Error(`${command} exited ${code}`)));
  });
  return stdout.trim();
}
try {
  await run("sh", [join(out, "install.sh")]);
  assert.equal(await run(join(home, "bin/raft-computer"), ["--version"]), version);
  assert.equal((await readFile(join(home, "state/computer/channel"), "utf8")).trim(), `pinned:${version}`);
  assert.ok((await stat(join(home, "bin/photon_rs_bg.wasm"))).size > 0);
  console.log(`Installer smoke passed: ${version}`);
} finally {
  await new Promise((done) => server.close(done));
  await rm(home, { recursive: true, force: true });
}
