import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { DEFAULT_UPGRADE_BASE_URL, fetchCdnLatestVersion, resolveUpgradeBaseUrl } from "./computerRelease.js";
import { createComputerReleaseSource } from "./kReleaseSource.js";

afterEach(() => vi.unstubAllEnvs());

test("default updates resolve only the fork's GitHub manifests and artifacts", async () => {
  vi.stubEnv("RAFT_COMPUTER_RELEASE_BACKEND", undefined);
  vi.stubEnv("RAFT_COMPUTER_UPGRADE_BASE_URL", undefined);
  const version = "1.0.28-mellonta.2";
  const urls: string[] = [];
  const pointer = "https://github.com/Mellonta/raft-source/releases/latest/download/manifest.json";
  const exact = `${DEFAULT_UPGRADE_BASE_URL}/${version}/manifest.json`;
  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    assert.ok(url === pointer || url === exact, `unexpected release request: ${url}`);
    return new Response(JSON.stringify({
      version,
      targets: { "linux-x64": { file: "raft-computer-linux-x64", sha256: "ab".repeat(32), size: 1234 } },
    }));
  });
  const base = resolveUpgradeBaseUrl();
  assert.equal(base, DEFAULT_UPGRADE_BASE_URL);
  const source = createComputerReleaseSource(base, {
    fetchFn,
    getHandsDeviceIdFn: async () => { throw new Error("must not create a Hands identity"); },
    createHandsUpdaterFn: () => { throw new Error("must not query Hands"); },
  });
  const result = await source.checkForUpdate({ currentVersion: "1.0.28-mellonta.1", platformKey: "linux-x64" });
  assert.deepEqual(result, {
    version, url: `${DEFAULT_UPGRADE_BASE_URL}/${version}/raft-computer-linux-x64`,
    sha256: "ab".repeat(32), size: 1234,
  });
  assert.equal(await fetchCdnLatestVersion(base, fetchFn), version);
  assert.deepEqual(urls, [pointer, exact, pointer]);
});
