import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/testing/seaHostHarness.sea-suite.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
