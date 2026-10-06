import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const webRoot = resolve(import.meta.dirname, "..");
const packagePath = createRequire(import.meta.url).resolve("vitest/package.json");
const cli = resolve(dirname(packagePath), JSON.parse(readFileSync(packagePath, "utf8")).bin.vitest);

function probe(unhandled = false) {
  const root = mkdtempSync(resolve(webRoot, ".console-rpc-probe-"));
  try {
    // Load the shipped DOM runner config. Only substitute the test corpus and
    // a slow reporter, so this exercises the real console transport selection.
    writeFileSync(resolve(root, "vitest.config.mjs"), `
import config from ${JSON.stringify(pathToFileURL(resolve(webRoot, "vitest.config.ts")).href)};
export default { ...config, root: ${JSON.stringify(root)}, test: {
  ...config.test, setupFiles: [], include: ['probe.test.mjs'], maxWorkers: 2,
  reporters: ['default', { async onUserConsoleLog() {
    await new Promise(resolve => setTimeout(resolve, 100));
  } }],
} };
`);
    writeFileSync(resolve(root, "probe.test.mjs"), `
import { test, afterAll, expect } from 'vitest';
test('the assertion passes', async () => {
  console.log('STDOUT_RETAINED');
  console.error('STDERR_RETAINED');
  expect(2 + 2).toBe(4);
  ${unhandled ? "Promise.reject(new Error('REAL_UNHANDLED_REJECTION')); await new Promise(resolve => setTimeout(resolve, 20));" : ""}
});
afterAll(() => {
  console.log('TEARDOWN_LOG');
  // Reproduce a console call arriving while the reporter is still handling
  // the earlier log. All assertions pass even when console RPC teardown fails.
  setTimeout(() => console.warn('LATE_LOG'), 10).unref();
});
`);
    return spawnSync(process.execPath, [cli, "run", "--config", resolve(root, "vitest.config.mjs")], {
      cwd: root, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, RAFT_WEB_TEST_DOM: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("DOM console output survives a slow reporter without failing worker teardown", () => {
  const result = probe();
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /STDOUT_RETAINED/);
  assert.match(output, /STDERR_RETAINED/);
  assert.doesNotMatch(output, /EnvironmentTeardownError/);
});

test("direct DOM console transport still fails real unhandled rejections", () => {
  const result = probe(true);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /REAL_UNHANDLED_REJECTION/);
  assert.match(output, /Unhandled Rejection/);
});
