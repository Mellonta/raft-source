import { createHash } from "node:crypto";
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = resolve(process.argv[2] || join(root, "packages/computer/dist-native"));
const { version } = JSON.parse(await readFile(join(root, "packages/computer/package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+-mellonta\.\d+$/.test(version)) throw new Error("Expected a Mellonta release version");
const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
if (manifest.version !== version) throw new Error("Release manifest version does not match the source");
const targets = Object.keys(manifest.targets).sort();
if (!targets.length || targets.some(target => !["linux-x64", "linux-arm64"].includes(target))) {
  throw new Error("Expected Linux x64/ARM64 release targets");
}
const upstreamInstaller = await readFile(join(root, "scripts/mellonta/install-client.sh"), "utf8");
const installer = `#!/bin/sh
# Mellonta fork: install this exact, checksum-verified GitHub release.
export RAFT_COMPUTER_RELEASE_BASE="\${RAFT_COMPUTER_RELEASE_BASE:-https://github.com/Mellonta/raft-source/releases/download}"
export RAFT_COMPUTER_RELEASE_BACKEND=legacy-cdn
export RAFT_COMPUTER_VERSION="${version}"
export RAFT_COMPUTER_INSTALL_CHANNEL="\${RAFT_COMPUTER_INSTALL_CHANNEL:-pinned:${version}}"
${upstreamInstaller.replace(/^#![^\n]*\n/, "")}`;
await writeFile(join(out, "install.sh"), installer, { mode: 0o755 });
await copyFile(join(root, "LICENSE"), join(out, "LICENSE"));
await copyFile(join(root, "MELLONTA.md"), join(out, "MELLONTA.md"));
const files = [
  ...targets.flatMap(target => [`raft-computer-${target}`, `raft-computer-${target}.gz`]), "photon_rs_bg.wasm",
  "manifest.json", "install.sh", "LICENSE", "MELLONTA.md",
];
const hashes = [];
for (const file of files) {
  const bytes = await readFile(join(out, file));
  hashes.push(`${createHash("sha256").update(bytes).digest("hex")}  ${file}`);
}
await writeFile(join(out, "SHA256SUMS"), `${hashes.join("\n")}\n`);
console.log(`Prepared ${version}: ${out}`);
