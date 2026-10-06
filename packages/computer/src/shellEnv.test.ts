import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as shellEnv from "./shellEnv";

// slock#8610: Raft Desktop's app-hosted `__service` needs the SAME login-shell
// environment contract as the CLI-hosted carrier (task #326). The capture must
// run BEFORE the service module graph loads, so the `./shell-env` entry has to
// stay free of that graph.

test("the shell-env entry exposes the service-boot seam", () => {
  for (const name of ["bootstrapServiceEnv", "captureShellEnv", "printEnvMode"] as const) {
    assert.equal(typeof shellEnv[name], "function", name);
  }
  assert.equal(shellEnv.LOGIN_CARRIER_ENV_VAR, "RAFT_COMPUTER_LOGIN_CARRIER");
  assert.equal(shellEnv.SHELL_ENV_STATE_ENV_VAR, "RAFT_COMPUTER_SHELL_ENV_STATE");
});

test("the boot seam imports only node builtins, the narrow clock helpers and the supervisor-kind constant (never the service graph)", async () => {
  const allowed = new Set([
    "node:child_process", "node:fs", "node:net", "node:crypto", "node:os", "node:path",
    "@botiverse/raft-shared/src/clock", "./osSupervisorLifecycle",
  ]);
  for (const file of ["./shellEnvCapture.ts", "./shellEnv.ts"]) {
    const src = await readFile(new URL(file, import.meta.url), "utf8");
    const specs = [...src.matchAll(/^(?:import|export)[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]);
    for (const spec of specs) {
      if (file === "./shellEnv.ts" && spec === "./shellEnvCapture") continue;
      assert.ok(allowed.has(spec), `${file} imports ${spec}`);
    }
  }
  const lifecycle = await readFile(new URL("./osSupervisorLifecycle.ts", import.meta.url), "utf8");
  for (const m of lifecycle.matchAll(/^import\s+(type\s+)?[^;]*from\s+"([^"]+)"/gm)) {
    assert.ok(m[1], `osSupervisorLifecycle.ts must only import types (found runtime import of ${m[2]})`);
  }
});

test("package.json publishes ./shell-env next to ./lib", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, { default: string; types: string }> };
  assert.equal(pkg.exports["./shell-env"]?.default, "./dist/shell-env/index.js");
  assert.equal(pkg.exports["./shell-env"]?.types, "./dist/shell-env/index.d.ts");
});
