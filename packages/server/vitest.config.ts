import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // CI has no RisingWave (a hard dependency of the server): install the
    // test-only Postgres references of the RisingWave-served reads.
    setupFiles: ["src/test/setup/risingWaveReadReference.ts", "src/test/setup/readPositionSettle.ts"],
    pool: "forks",
    // The previous Node runner imposed no per-test or per-hook timeout. Keep
    // that contract and let the existing shard/job watchdogs bound hangs.
    testTimeout: 0,
    hookTimeout: 0,
  },
});
