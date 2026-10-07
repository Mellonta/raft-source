// Combine independently tested native builds only after validating both targets.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function mergeClientArtifacts(inputs, out) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const { version } = JSON.parse(await readFile(join(root, "packages/computer/package.json"), "utf8"));
  const nodeVersion = (await readFile(join(root, ".node-version"), "utf8")).trim();
  const files = new Map();
  const manifests = [];
  for (const target of ["linux-x64", "linux-arm64"]) {
    const source = join(inputs, target);
    const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
    if (manifest.version !== version || manifest.nodeVersion !== nodeVersion
        || Object.keys(manifest.targets).join() !== target) throw new Error(`Invalid ${target} manifest`);
    const binary = manifest.targets[target];
    const descriptors = [
      [binary, `raft-computer-${target}`], [binary.gz, `raft-computer-${target}.gz`],
      [manifest.photonWasm, "photon_rs_bg.wasm"],
    ];
    for (const [descriptor, name] of descriptors) {
      if (descriptor?.file !== name) throw new Error(`Missing or invalid ${name} descriptor`);
      const bytes = await readFile(join(source, name));
      if (bytes.length !== descriptor.size || createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256) {
        throw new Error(`Artifact checksum mismatch: ${name}`);
      }
      if (files.has(name) && !files.get(name).equals(bytes)) throw new Error(`Shared artifact differs: ${name}`);
      files.set(name, bytes);
    }
    manifests.push(manifest);
  }
  await mkdir(out, { recursive: true });
  for (const [name, bytes] of files) await writeFile(join(out, name), bytes);
  await writeFile(join(out, "manifest.json"), JSON.stringify({
    ...manifests[0], targets: Object.assign({}, ...manifests.map(m => m.targets)),
  }, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error("Usage: merge-client-artifacts.mjs INPUTS OUTPUT");
  await mergeClientArtifacts(process.argv[2], process.argv[3]);
}
