import { DISTRIBUTION_POLICY } from "@botiverse/raft-shared";
import { mellontaInstallerCommand } from "./mellontaInstaller";
// The external installer is the only thing that installs, upgrades or
// repairs Computer. Computer resolves one immutable installer, verifies its
// bytes and executes it directly. Shell/PowerShell bootstraps are only for
// users installing Computer for the first time. Installer behavior:
// https://botiverse.github.io/k-carrier/installer.html
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { Channel } from "./lib/channelState";
import type { ComputerLastUpgradeReceipt } from "@botiverse/raft-shared";
import { computerDir, resolveRaftHome } from "./paths";
import { computerFetch } from "./proxy";

const DEFAULT_INSTALLER_BASE = "https://hands.build/dl/raft-computer-installer";
const MAX_INSTALLER_BYTES = 64 * 1024 * 1024;

/** Public downloads carry no account headers and have bounded bodies/time. */
async function download(url: string, maximum: number): Promise<Buffer> {
  const response = await computerFetch(url, { signal: AbortSignal.timeout(180_000), headers: { "user-agent": "raft-computer-installer-client" } });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`installer_download_failed: HTTP ${response.status}`);
  }
  const blocks: Buffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error("installer_download_too_large");
      blocks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(blocks, size);
}

/** Bootstrap arguments for one exact version, or for the saved channel. */
export function installerArgs(input: { targetVersion?: string; channel?: Channel; allowDowngrade?: boolean }): string[] {
  const downgrade = input.allowDowngrade ? ["--allow-downgrade"] : [];
  if (input.targetVersion) return ["upgrade", "--version", input.targetVersion, ...downgrade];
  const channel = input.channel ?? "latest";
  if (channel.startsWith("pinned:")) return ["upgrade", "--version", channel.slice("pinned:".length)];
  // "latest" is Computer's spelling of the installer's "main". Every other
  // saved channel (alpha, or a named feature channel from task #816) is
  // forwarded as its own slug: the installer, not this adapter, decides which
  // slugs it serves, so an unsupported channel fails loudly there instead of
  // being silently rewritten to main.
  return ["upgrade", "--channel", channel === "latest" ? "main" : channel];
}

/** Resolve once, verify, and return a direct executable invocation (never a shell). */
export async function installerCommand(args: string[], env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform, arch: string = process.arch): Promise<{ command: string; args: string[] }> {
  if (DISTRIBUTION_POLICY.forkReleases) return mellontaInstallerCommand(args, env, platform, arch);
  const target = `${platform}-${arch}`;
  if (!["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"].includes(target)) {
    throw new Error("unsupported_installer_target");
  }
  const base = new URL(env.RAFT_COMPUTER_INSTALLER_DL_BASE ?? DEFAULT_INSTALLER_BASE);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) || base.username || base.password || base.search || base.hash) {
    throw new Error("invalid_installer_download_base");
  }
  const channel = env.RAFT_COMPUTER_INSTALLER_CHANNEL ?? "main";
  const channelUrl = `${base.href.replace(/\/$/, "")}/${encodeURIComponent(channel)}/${target}`;
  const response = await computerFetch(channelUrl, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  await response.body?.cancel();
  const location = response.headers.get("location");
  if (response.status !== 302 || !location) throw new Error("installer_release_unavailable");
  const release = new URL(location, channelUrl);
  const prefix = `${base.pathname.replace(/\/$/, "")}/releases/`;
  const rest = release.pathname.slice(prefix.length);
  if (release.origin !== base.origin || !release.pathname.startsWith(prefix)
    || !new RegExp(`^[a-zA-Z0-9_-]+/${target}$`).test(rest) || release.search || release.hash || release.username || release.password) {
    throw new Error("invalid_immutable_installer_release");
  }
  const filename = `raft-computer-installer${platform === "win32" ? ".exe" : ""}`;
  const relative = `native/${target}/${filename}`;
  const sums = (await download(`${release.href}?kind=sha256sums`, 65_536)).toString("utf8");
  const matches = sums.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((parts) => parts[1] === relative);
  if (matches.length !== 1 || matches[0].length !== 2 || !/^[a-fA-F0-9]{64}$/.test(matches[0][0])) throw new Error("invalid_installer_checksum");
  const expected = matches[0][0].toLowerCase();
  // Immutable content-addressed paths prevent a concurrent launch from seeing
  // another release replace its executable. Cached bytes are rechecked each time.
  const directory = join(computerDir(resolveRaftHome(env)), "installer", "bin", target, expected);
  const command = join(directory, filename);
  const valid = async () => {
    try {
      const info = await lstat(command);
      return info.isFile() && info.size <= MAX_INSTALLER_BYTES
        && createHash("sha256").update(await readFile(command)).digest("hex") === expected;
    } catch { return false; }
  };
  if (!await valid()) {
    const bytes = await download(release.href, MAX_INSTALLER_BYTES);
    if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("installer_checksum_mismatch");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(directory, ".download-"));
    try {
      const staged = join(temporary, filename);
      await writeFile(staged, bytes, { mode: 0o700 });
      try { await rename(staged, command); }
      catch (error) { if (!await valid()) throw error; }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  await chmod(command, 0o700);
  return { command, args: [...args] };
}

/** Execute directly on this terminal; installation policy belongs to the binary. */
export async function runInstallerAttended(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const invocation = await installerCommand(args, env);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { stdio: "inherit",
      env: { ...env, RAFT_COMPUTER_INSTALLER_CALLER: "waiting-cli-v1" } });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** A detached native installer survives service replacement. Acceptance is not completion. */
export async function launchInstallerDetached(slockHome: string, args: string[], requestId: string,
  env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  if (DISTRIBUTION_POLICY.forkReleases) {
    throw new Error("Remote upgrades are disabled in the Mellonta build. On the client, run raft-computer upgrade --target-version X.Y.Z-mellonta.N, or rerun scripts/mellonta/setup-client.sh.");
  }
  const childEnv = { ...env, RAFT_COMPUTER_INSTALLER_CALLER: undefined, RAFT_HOME: slockHome, SLOCK_HOME: slockHome, RAFT_COMPUTER_NON_INTERACTIVE: "1",
    RAFT_COMPUTER_OPERATION_ID: requestId, RAFT_COMPUTER_APPROVED_BY: `remote:${requestId}` };
  const invocation = await installerCommand(args, childEnv);
  const logDir = join(computerDir(slockHome), "installer", "launches");
  mkdirSync(logDir, { recursive: true });
  const log = openSync(join(logDir, `${createHash("sha256").update(requestId).digest("hex")}.log`), "a");
  let child;
  try {
    child = spawn(invocation.command, invocation.args, { detached: true, stdio: ["ignore", log, log], env: childEnv });
  } finally { closeSync(log); }
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
  return child.pid ?? null;
}

/** Read only a settled, request-bound proof from the installer, never infer it from launch. */
export async function readInstallerUpgradeEvidence(slockHome: string, requestId: string): Promise<{ targetVersion: string; deadProcessIdentities: string[] } | null> {
  const name = createHash("sha256").update(requestId).digest("hex");
  try {
    const file = await open(join(computerDir(slockHome), "installer", "receipts", `${name}.json`), "r");
    let raw: Buffer;
    try {
      const buffer = Buffer.alloc(65_537);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65_536) return null;
      raw = buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
    const receipt = JSON.parse(raw.toString("utf8"));
    if (receipt.protocol !== "raft-computer-installer/v3" || receipt.id !== requestId
      || receipt.operation !== "upgrade" || receipt.outcome !== "promoted" || receipt.exitCode !== 0
      || typeof receipt.targetVersion !== "string") return null;
    const dead = JSON.parse(receipt.detail?.deadProcessIdentities);
    if (!Array.isArray(dead) || !dead.length || dead.some((value) => typeof value !== "string" || !value)) return null;
    return { targetVersion: receipt.targetVersion, deadProcessIdentities: dead };
  } catch {
    return null;
  }
}

// ---- Remote upgrade v2 (task #873) ----
// The Computer that launched the installer is gone by the time the receipt
// exists, so the request identity is parked in a tiny marker; the successor
// reads the receipt through it once, purely to carry a one-line reason.
const LAST_REMOTE_UPGRADE_MARKER = "last-remote-upgrade.json";

export async function recordRemoteUpgradeLaunch(slockHome: string, input: { requestId: string; targetVersion?: string }): Promise<void> {
  const dir = join(computerDir(slockHome), "installer");
  mkdirSync(dir, { recursive: true });
  await writeFile(join(dir, LAST_REMOTE_UPGRADE_MARKER), JSON.stringify({ ...input, launchedAt: new Date().toISOString() }), "utf8");
}

export async function readLastRemoteUpgradeReceipt(slockHome: string): Promise<ComputerLastUpgradeReceipt | null> {
  try {
    const marker = JSON.parse(await readFile(join(computerDir(slockHome), "installer", LAST_REMOTE_UPGRADE_MARKER), "utf8"));
    if (typeof marker?.requestId !== "string") return null;
    const name = createHash("sha256").update(marker.requestId).digest("hex");
    const raw = await readFile(join(computerDir(slockHome), "installer", "receipts", `${name}.json`), "utf8");
    if (raw.length > 65_536) return null;
    const receipt = JSON.parse(raw);
    if (receipt.protocol !== "raft-computer-installer/v3" || receipt.id !== marker.requestId || receipt.operation !== "upgrade") return null;
    const targetVersion = typeof receipt.targetVersion === "string" ? receipt.targetVersion : marker.targetVersion;
    if (typeof targetVersion !== "string") return null;
    const outcome: ComputerLastUpgradeReceipt["outcome"] = receipt.outcome === "promoted"
      ? "promoted"
      // The installer writes kebab-case (`rolled-back`, rust/report.rs); the
      // snake_case spelling is accepted for receipts written before that.
      : receipt.outcome === "rolled-back" || receipt.outcome === "rolled_back" || receipt.rolledBack === true
        ? "rolled_back"
        : receipt.exitCode === 2
          ? "held"
          : receipt.exitCode === 3
            ? "unresolved"
            : "failed";
    const reason = typeof receipt.reason === "string" ? receipt.reason
      : typeof receipt.error === "string" ? receipt.error
      : typeof receipt.detail?.reason === "string" ? receipt.detail.reason
      : undefined;
    return { targetVersion, outcome, ...(reason ? { reason } : {}) };
  } catch {
    return null;
  }
}
