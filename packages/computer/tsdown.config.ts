import { defineConfig } from "tsdown";

// Inline CLI/runtime helper deps so basic surfaces keep working even
// when the install root is moved by the upgrade swap before npm has
// populated ambient node_modules. The daemon package stays external:
// it ships the bundled slock CLI runtime asset that must remain in a real
// package root, so the upgrade flow hydrates it into the staged install
// before swap.
//
// `@botiverse/raft-shared` + `@botiverse/raft-trace-client` MUST be inlined: they are
// `private: true` source-only TS workspace packages (`main: src/index.ts`,
// no build, bundler-style `.js` ESM specifiers). Left external, the bundled
// CLI / SEA / npm-published artifact resolves `import "@botiverse/raft-shared"` to
// a non-existent compiled file at runtime (ERR_MODULE_NOT_FOUND). Loader-based
// typecheck/test hide it via TS-aware resolution; only real ESM Node import
// / SEA runtime / npm install expose it (#3223 follow-up).
//
// Exported for src/bundleConfig.test.ts, which guards these lists.
export const binBundledDeps = [
  "commander",
  "proper-lockfile",
  "undici",
  "@botiverse/raft-shared",
  "@botiverse/raft-trace-client",
];

// Same as the bin entry: inline the source-only workspace tracing packages
// so the `@botiverse/raft-computer/lib` subpath bundle is self-contained for
// its `import`-only consumers (menu-bar app, direct node, future SDK). Left
// external, `createComputerApi`/`createComputerTracer` throw
// ERR_MODULE_NOT_FOUND on `@botiverse/raft-shared` at runtime.
export const libBundledDeps = ["@botiverse/raft-shared", "@botiverse/raft-trace-client"];

// tsdown matches alwaysBundle against the FULL specifier, and a bare "undici"
// would leave `undici/...` subpath imports external — so convert each name to
// a prefix regex covering its subpaths.
const subpathPattern = (name: string) =>
  new RegExp(`^${name.replace(/[^a-zA-Z0-9]/g, "\\$&")}(\\/|$)`);

// Two build configs share one tsdown invocation:
//   1. CLI bin (`src/index.ts` → `dist/index.js`) — keeps the shebang +
//      createRequire shim banner so the `raft-computer` bin is directly
//      executable.
//   2. Library subpath (`src/lib/index.ts` → `dist/lib/index.{js,d.ts}`)
//      — NO banner: this entry is `import`-only via the §3 sub-path
//      export `@botiverse/raft-computer/lib`. A shebang on a library entry is
//      a smell (Node tolerates it but consumers shouldn't see it), and
//      the lib surface (re-exports of type-pin v2 + closed-set tuples)
//      has no runtime use for the bundled-dep createRequire shim.
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: "esm",
    target: "node20",
    platform: "node",
    // tsdown's code splitting is always on; the published bin is a single
    // self-contained file, so inline the `import("./cli.js")` dynamic import
    // in src/index.ts instead of emitting a chunk.
    outputOptions: { codeSplitting: false },
    // platform:node defaults to .mjs fixed extensions; the bin wrapper
    // (scripts/write-dist-bins.mjs) and package.json reference .js paths.
    fixedExtension: false,
    clean: true,
    dts: false,
    shims: true,
    deps: {
      alwaysBundle: binBundledDeps.map(subpathPattern),
    },
    banner: {
      js:
        "#!/usr/bin/env node\n" +
        "import { createRequire as __slockCreateRequire } from \"node:module\";\n" +
        "const require = __slockCreateRequire(import.meta.url);",
    },
  },
  {
    // Lib JS bundle (no declarations — the dedicated dts-only config below
    // owns dist/lib/index.d.ts).
    entry: { "lib/index": "src/lib/index.ts", "shell-env/index": "src/shellEnv.ts" },
    format: "esm",
    target: "node20",
    platform: "node",
    // platform:node defaults to .mjs fixed extensions; the package.json
    // `./lib` export points at ./dist/lib/index.js, so keep .js.
    fixedExtension: false,
    // `clean: false` — the bin config above already cleaned `dist/`; if
    // both ran `clean: true` they would race and one would wipe the other.
    clean: false,
    dts: false,
    deps: {
      alwaysBundle: libBundledDeps.map(subpathPattern),
    },
  },
  {
    // Lib declarations only. `onlyBundle: []` is the guard: NOTHING from
    // node_modules may be inlined into the published type file — the build
    // fails naming the offending package. This is what keeps zod-openapi's
    // global `declare module 'zod/v4'` augmentation (which rewrites
    // consumers' own zod typing) out of the artifact for good.
    entry: { "lib/index": "src/lib/index.ts", "shell-env/index": "src/shellEnv.ts" },
    format: "esm",
    target: "node20",
    platform: "node",
    fixedExtension: false,
    clean: false,
    // The tsc resolver handles the source-only workspace packages correctly.
    // tsconfig.dts.json maps their package specifiers to real source paths:
    // tsc skips declaration emit for files reached through bare node_modules
    // specifiers, which otherwise silently empties the virtual barrel
    // (MISSING_EXPORT at bundle time).
    dts: { emitDtsOnly: true, resolver: "tsc", tsconfig: "tsconfig.dts.json" },
    deps: {
      alwaysBundle: libBundledDeps.map(subpathPattern),
      onlyBundle: [],
    },
  },
]);
