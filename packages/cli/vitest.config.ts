import { defineConfig } from "vitest/config";

// Display-time assertions (e.g. "+08:00" in message search output) follow the
// host timezone. CI pins TZ=Asia/Singapore for this suite in
// .github/workflows/test.yml; pin the same zone here so local runs on any
// host match CI instead of failing outside UTC+8. Set before the fork pool
// spawns so every worker inherits it.
process.env.TZ = "Asia/Singapore";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    // These suites ran on node:test, which imposes no per-test or per-hook timeout.
    testTimeout: 0,
    hookTimeout: 0,
  },
});
