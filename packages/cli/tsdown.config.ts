import { defineConfig } from "tsdown";

// The Computer app copies this single file into
// `<app>/Contents/Resources/cli/index.js` and executes it with Electron's
// Node runtime (ELECTRON_RUN_AS_NODE, no asar). That sidecar has no package root
// and no ambient node_modules, so EVERY runtime dep must be inlined — any
// package left external makes the packaged CLI fail to load with `Cannot find
// package '<dep>'`, which hangs every agent whose shim runs it. Keep this list
// == the package's runtime `dependencies`. `commander` is CJS and still requires
// Node built-ins, so the ESM bundle also needs a createRequire shim. (`ajv` +
// `safe-regex2` were added for integration manifest validation but not inlined,
// which shipped a broken desktop CLI in 0.1.15.)
//
// Exported for src/bundleConfig.test.ts, which guards the list against drift
// from package.json `dependencies`.
export const inlinedRuntimeDeps = ["commander", "undici", "ajv", "safe-regex2"];

// tsdown matches alwaysBundle against the FULL specifier, and a bare "ajv"
// would leave `ajv/dist/2020.js` external and break the single-file sidecar —
// so convert each name to a prefix regex covering its subpaths.
const subpathPattern = (name: string) =>
  new RegExp(`^${name.replace(/[^a-zA-Z0-9]/g, "\\$&")}(\\/|$)`);

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node20",
  platform: "node",
  // tsdown's code splitting is always on; this entry ships as a SINGLE file
  // (see above), so inline the `void import("./main.js")` dynamic import in
  // src/index.ts instead of emitting a chunk.
  outputOptions: { codeSplitting: false },
  // platform:node defaults to .mjs fixed extensions; package.json bin and the
  // post-build scripts reference dist/index.js, so keep .js.
  fixedExtension: false,
  clean: true,
  dts: false,
  shims: true,
  deps: {
    alwaysBundle: inlinedRuntimeDeps.map(subpathPattern),
  },
  banner: {
    js:
      "#!/usr/bin/env node\n" +
      "import { createRequire as __raftCreateRequire } from \"node:module\";\n" +
      "const require = __raftCreateRequire(import.meta.url);",
  },
});
