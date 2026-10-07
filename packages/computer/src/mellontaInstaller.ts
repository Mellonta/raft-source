// The fork's Linux releases are self-contained GitHub assets. Never bootstrap
// the upstream Hands installer, which can only install upstream products.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isSea } from "node:sea";
import { computerDir, resolveRaftHome } from "./paths";
import { computerFetch } from "./proxy";
import { latestManifestUrl, resolveUpgradeBaseUrl } from "./computerRelease";

const VERSION = /^\d+\.\d+\.\d+-mellonta\.\d+$/;

async function read(url: string, maximum: number): Promise<Buffer> {
  const response = await computerFetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Mellonta release download failed: HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error("Mellonta release metadata exceeds size limit");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

export async function mellontaInstallerCommand(args: string[], env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform, arch: string): Promise<{ command: string; args: string[] }> {
  if (platform !== "linux" || !["x64", "arm64"].includes(arch)) throw new Error("Mellonta releases support Linux x86-64 and ARM64 only");
  if (args[0] !== "upgrade") throw new Error("Unsupported Mellonta installer operation");
  let version: string | undefined;
  let channel: string | undefined;
  let downgrade = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--version" && args[i + 1]) version = args[++i];
    else if (args[i] === "--channel" && args[i + 1]) channel = args[++i];
    else if (args[i] === "--allow-downgrade") downgrade = true;
    else throw new Error("Unsupported Mellonta installer argument");
  }
  if (channel && channel !== "main") throw new Error("Mellonta publishes only the main release channel");
  if (version !== undefined && !VERSION.test(version)) throw new Error("An exact Mellonta version is required");
  const base = resolveUpgradeBaseUrl(env);
  const url = new URL(base);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid Mellonta release download base");
  }
  if (!version) version = JSON.parse((await read(latestManifestUrl(base), 65_536)).toString()).version;
  if (typeof version !== "string" || !VERSION.test(version)) throw new Error("Release pointer is not a Mellonta version");
  const release = `${base}/${version}`;
  const sums = (await read(`${release}/SHA256SUMS`, 65_536)).toString();
  const matches = sums.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(parts => parts[1] === "install.sh");
  if (matches.length !== 1 || matches[0].length !== 2 || !/^[a-f0-9]{64}$/.test(matches[0][0])) {
    throw new Error("Invalid Mellonta installer checksum");
  }
  const bytes = await read(`${release}/install.sh`, 1024 * 1024);
  if (createHash("sha256").update(bytes).digest("hex") !== matches[0][0]) throw new Error("Mellonta installer checksum mismatch");
  const directory = join(computerDir(resolveRaftHome(env)), "installer", "mellonta");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staged = join(await mkdtemp(join(directory, `${version}-`)), "install.sh");
  await writeFile(staged, bytes, { mode: 0o600 });
  return { command: "/usr/bin/env", args: [
    `RAFT_COMPUTER_RELEASE_BASE=${base}`, "RAFT_COMPUTER_RELEASE_BACKEND=legacy-cdn",
    `RAFT_COMPUTER_VERSION=${version}`, `RAFT_COMPUTER_INSTALL_CHANNEL=pinned:${version}`,
    `RAFT_COMPUTER_FORCE=${downgrade ? "1" : "0"}`, "RAFT_COMPUTER_NO_MODIFY_PATH=1",
    ...(env.RAFT_COMPUTER_INSTALL_DIR ? [`RAFT_COMPUTER_INSTALL_DIR=${env.RAFT_COMPUTER_INSTALL_DIR}`]
      : isSea() ? [`RAFT_COMPUTER_INSTALL_DIR=${dirname(process.execPath)}`] : []),
    "/bin/sh", staged, "--version", version,
  ] };
}
