import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "contracts/**/*.test.ts"],
    pool: "forks",
    // These suites ran on node:test, which imposes no per-test or per-hook timeout.
    testTimeout: 0,
    hookTimeout: 0,
  },
});
