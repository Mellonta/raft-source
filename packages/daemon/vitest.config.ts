import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Local runs regenerate snapshots for review; CI only checks committed output.
    update: !process.env.CI,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Unit tests never reach the network; see src/testing/networkGuard.ts.
    setupFiles: ["./src/testing/networkGuard.ts"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
