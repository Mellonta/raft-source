import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/core.ts"],
  format: "esm",
  target: "node20",
  platform: "node",
  // platform:node defaults to .mjs fixed extensions; the bin wrappers
  // (scripts/write-dist-bins.mjs) and package.json exports reference
  // dist/index.js / dist/core.js, so keep .js.
  fixedExtension: false,
  clean: true,
  dts: false,
});
