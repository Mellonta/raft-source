import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import packageJson from "../package.json" with { type: "json" };
import tsdownConfig, { binBundledDeps, libBundledDeps } from "../tsdown.config";

type BundleConfigShape = {
  deps?: {
    alwaysBundle?: unknown;
    neverBundle?: unknown;
  };
  banner?: { js?: unknown };
};

const configs = (Array.isArray(tsdownConfig) ? tsdownConfig : [tsdownConfig]) as BundleConfigShape[];
const config = configs[0];
const libConfig = configs[1];

// tsdown matches alwaysBundle against the full specifier, so the config
// converts each package name to a subpath-covering regex. Assert the source
// name lists (the contract) plus that every pattern covers subpaths.
function assertPatternsCover(names: string[], patterns: RegExp[]) {
  assert.equal(patterns.length, names.length);
  for (const name of names) {
    assert.ok(
      patterns.some((pattern) => pattern.test(name) && pattern.test(`${name}/subpath`)),
      `alwaysBundle must cover ${name} and its subpaths`,
    );
  }
}

test("tsdown config bundles CLI helper deps but leaves daemon package external to staged hydration", () => {
  assert.ok(config, "tsdown config must export an object");
  assert.deepEqual(binBundledDeps, [
    "commander",
    "proper-lockfile",
    "undici",
    "@botiverse/raft-shared",
    "@botiverse/raft-trace-client",
  ]);
  assertPatternsCover(binBundledDeps, config.deps?.alwaysBundle as RegExp[]);
  assert.equal(config.deps?.neverBundle, undefined);
  assert.match(String(config.banner?.js ?? ""), /createRequire/);
});

test("tsdown lib entry inlines the source-only tracing packages so the /lib bundle self-contains", () => {
  assert.ok(libConfig, "lib entry config must exist");
  assert.deepEqual(libBundledDeps, ["@botiverse/raft-shared", "@botiverse/raft-trace-client"]);
  assertPatternsCover(libBundledDeps, libConfig.deps?.alwaysBundle as RegExp[]);
});

test("tsdown config documents why daemon stays external and source-only dependencies are inlined", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../tsdown.config.ts", import.meta.url)),
    "utf8",
  );
  assert.match(source, /daemon package stays external/);
  assert.match(source, /upgrade flow hydrates it into/);
  assert.match(source, /source-only TS workspace packages/);
  assert.match(source, /ERR_MODULE_NOT_FOUND/);
});

test("package build executes the published bin under native Node after writing it", async () => {
  assert.match(packageJson.scripts.build, /write-dist-bins\.mjs && node scripts\/verify-published-dist\.mjs$/);

  const source = await readFile(
    fileURLToPath(new URL("../scripts/verify-published-dist.mjs", import.meta.url)),
    "utf8",
  );
  assert.match(source, /spawnSync\(process\.execPath, \[binPath, "--version"\]/);
  assert.match(source, /result\.stdout\.trim\(\) !== packageJson\.version/);
  assert.match(source, /const env = \{\};/);
  assert.doesNotMatch(source, /\.\.\.process\.env/);
});
