import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { installerCommand, launchInstallerDetached } from "./externalInstaller";
import { MELLONTA_RELEASE_BASE } from "./computerRelease";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("./proxy", () => ({ computerFetch: fetchMock }));
afterEach(() => vi.resetAllMocks());
const version = "1.0.43-mellonta.1";

test.each(["x64", "arm64"])("%s upgrade verifies a fork installer and pins its authority despite inherited upstream settings", async (arch) => {
  const home = await mkdtemp(join(tmpdir(), "mellonta-upgrade-"));
  const bytes = "#!/bin/sh\necho fixture\n";
  const hash = createHash("sha256").update(bytes).digest("hex");
  const base = `${MELLONTA_RELEASE_BASE}/${version}`;
  fetchMock.mockImplementation(async (url: string) => {
    if (url === `${base}/SHA256SUMS`) return new Response(`${hash}  install.sh\n`);
    if (url === `${base}/install.sh`) return new Response(bytes);
    throw new Error(`Unexpected request: ${url}`);
  });
  try {
    const result = await installerCommand(["upgrade", "--version", version], {
      RAFT_HOME: home, RAFT_COMPUTER_RELEASE_BASE: "https://upstream.invalid",
      RAFT_COMPUTER_RELEASE_BACKEND: "mellonta", RAFT_COMPUTER_INSTALLER_DL_BASE: "https://hands.invalid",
      RAFT_COMPUTER_INSTALL_DIR: join(home, "bin with spaces"),
    }, "linux", arch);
    expect(result.command).toBe("/usr/bin/env");
    expect(result.args).toContain(`RAFT_COMPUTER_RELEASE_BASE=${MELLONTA_RELEASE_BASE}`);
    expect(result.args).toContain(`RAFT_COMPUTER_INSTALL_CHANNEL=pinned:${version}`);
    expect(result.args).toContain("RAFT_COMPUTER_FORCE=0");
    expect(result.args).toContain(`RAFT_COMPUTER_INSTALL_DIR=${join(home, "bin with spaces")}`);
    expect(await readFile(result.args[result.args.indexOf("/bin/sh") + 1], "utf8")).toBe(bytes);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a corrupt installer is rejected before creating local state or executing anything", async () => {
  const home = await mkdtemp(join(tmpdir(), "mellonta-corrupt-"));
  fetchMock.mockImplementation(async (url: string) => new Response(url.endsWith("SHA256SUMS") ? `${"a".repeat(64)}  install.sh\n` : "corrupt"));
  try {
    await expect(installerCommand(["upgrade", "--version", version], { RAFT_HOME: home, RAFT_COMPUTER_RELEASE_BACKEND: "mellonta" }, "linux", "x64")).rejects.toThrow("checksum mismatch");
    expect(await readdir(home)).toEqual([]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("upstream versions, unsupported channels and remote upgrades never download an upstream installer", async () => {
  await expect(installerCommand(["upgrade", "--version", "1.0.43"], { RAFT_COMPUTER_RELEASE_BACKEND: "mellonta" }, "linux", "x64")).rejects.toThrow("Mellonta version");
  await expect(installerCommand(["upgrade", "--channel", "alpha"], { RAFT_COMPUTER_RELEASE_BACKEND: "mellonta" }, "linux", "x64")).rejects.toThrow("only the main");
  await expect(launchInstallerDetached("/unused", ["upgrade"], "request", { RAFT_COMPUTER_RELEASE_BACKEND: "mellonta" })).rejects.toThrow("upgrades are local");
  expect(fetchMock).not.toHaveBeenCalled();
});
