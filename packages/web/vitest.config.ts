import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const dom = process.env.RAFT_WEB_TEST_DOM === "1";

function testIncludes(): string[] {
  const raw = process.env.RAFT_WEB_TEST_INCLUDE;
  if (!raw) return [dom ? "tests/**/*.test.tsx" : "tests/**/*.test.ts"];

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("RAFT_WEB_TEST_INCLUDE must be a JSON string array");
  }
  return parsed;
}

const domSetup = resolve(webRoot, "tests/helpers/domSetup.ts");
const timersReset = resolve(webRoot, "tests/helpers/realTimersAfterEach.ts");

export default defineConfig({
  root: webRoot,
  test: {
    globals: true,
    environment: "node",
    include: testIncludes(),
    setupFiles: dom
      ? [resolve(webRoot, "tests/helpers/compileCacheSetup.ts"), timersReset, domSetup]
      : [timersReset],
    // node:test restored per-test mocks automatically; keep that contract for vi.spyOn.
    restoreMocks: true,
    pool: "forks",
    isolate: true,
    // DOM teardown can log while Vitest 5 closes its console RPC (#11153).
    // Keep stdout/stderr visible through the fork's native streams instead;
    // assertions and unhandled errors retain their normal failure behavior.
    disableConsoleIntercept: dom,
    // DOM collection is memory-heavy. At the default worker count, the
    // heaviest files can starve their one-second RTL waits under host load.
    // (Vitest 4 removed `minWorkers`; it is derived automatically outside watch mode.)
    ...(dom ? { maxWorkers: "50%" } : {}),
    resolveSnapshotPath: (testPath) => `${testPath}.snapshot`,
    // The previous Node runner imposed no per-test or per-hook timeout. Keep
    // that contract and let the existing CI job watchdog bound hangs.
    testTimeout: 0,
    hookTimeout: 0,
  },
});
