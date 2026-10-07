import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { mergeClientArtifacts } from "./merge-client-artifacts.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { version } = JSON.parse(await readFile(join(root, "packages/computer/package.json"), "utf8"));
const nodeVersion = (await readFile(join(root, ".node-version"), "utf8")).trim();

async function fixture(t, differingWasm = false) {
  const directory = await mkdtemp(join(tmpdir(), "mellonta-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const target of ["linux-x64", "linux-arm64"]) {
    const dir = join(directory, target);
    await mkdir(dir);
    async function artifact(file, bytes) {
      await writeFile(join(dir, file), bytes);
      return { file, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    }
    const bytes = Buffer.from(target);
    const name = `raft-computer-${target}`;
    const binary = await artifact(name, bytes);
    binary.gz = await artifact(name + ".gz", gzipSync(bytes));
    const photonWasm = await artifact("photon_rs_bg.wasm", Buffer.from(differingWasm ? target : "wasm"));
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ name: "raft-computer", version, nodeVersion, photonWasm, targets: { [target]: binary } }));
  }
  return { directory, out: join(directory, "release") };
}

test("combined release contains both verified architectures and checksums for both installers' targets", async t => {
  const { directory, out } = await fixture(t);
  await mergeClientArtifacts(directory, out);
  const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.targets).sort(), ["linux-arm64", "linux-x64"]);
  const run = spawnSync(process.execPath, [join(root, "scripts/mellonta/prepare-release.mjs"), out], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const sums = await readFile(join(out, "SHA256SUMS"), "utf8");
  for (const line of sums.trim().split("\n")) {
    const [hash, file] = line.split(/\s+/);
    assert.equal(createHash("sha256").update(await readFile(join(out, file))).digest("hex"), hash);
  }
  for (const target of ["linux-arm64", "linux-x64"]) assert.ok(sums.includes(`raft-computer-${target}.gz`));
});

test("a corrupt ARM build cannot produce a partial release", async t => {
  const { directory, out } = await fixture(t);
  await writeFile(join(directory, "linux-arm64/raft-computer-linux-arm64"), "corrupt");
  await assert.rejects(mergeClientArtifacts(directory, out), /checksum mismatch/);
  await assert.rejects(access(out));
});

test("architectures must agree on the shared WASM artifact", async t => {
  const { directory, out } = await fixture(t, true);
  await assert.rejects(mergeClientArtifacts(directory, out), /Shared artifact differs/);
  await assert.rejects(access(out));
});

test("a missing architecture cannot produce a partial release", async t => {
  const { directory, out } = await fixture(t);
  await rm(join(directory, "linux-arm64"), { recursive: true });
  await assert.rejects(mergeClientArtifacts(directory, out));
  await assert.rejects(access(out));
});
