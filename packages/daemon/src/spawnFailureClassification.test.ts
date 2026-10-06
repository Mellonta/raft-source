import assert from "node:assert/strict";
import { classifySpawnFailure } from "./spawnFailureClassification";
import { RuntimeVersionTooOldError } from "./runtimeLaunchVersion";
import {
  AgentProxyBindError,
  ProviderConnectionMaterializationError,
  RuntimeExecutableNotFoundError,
  RuntimeModelNotFoundError,
} from "./spawnFailureErrors";

test("classifySpawnFailure identifies a known-incompatible runtime CLI version", () => {
  const error = new RuntimeVersionTooOldError({
    runtimeId: "claude",
    displayName: "Claude Code",
    actualVersion: "2.1.59",
    testedGoodVersion: "2.1.220",
  });
  const result = classifySpawnFailure(error);
  assert.equal(result.reason, "runtime_version_too_old");
  assert.equal(result.userMessage, error.message);
});

// task #1120 — feedback 958a8809: Pi threw "Pi model not found: <model>" and the
// text-matching classifier told the user the runtime executable was missing.
// Classification is by typed code now; message text never decides.
test("classifySpawnFailure names a missing model as model_not_found by error code, not as a missing executable", () => {
  const error = new RuntimeModelNotFoundError({ runtimeId: "builtin", model: "deepseek/deepseek-v4-flash-vision-exp" });
  const result = classifySpawnFailure(error);
  assert.equal(result.reason, "model_not_found");
  assert.match(result.userMessage, /deepseek\/deepseek-v4-flash-vision-exp/, "the user message names the model");
  assert.doesNotMatch(result.userMessage, /executable|PATH/i, "must not send the user to reinstall the CLI");
  assert.equal(result.detail, error.message);
  // The same words in an untyped Error are just text: generic fallback, not a model verdict.
  assert.equal(classifySpawnFailure(new Error("Pi model not found: x")).reason, "runtime_spawn_failed");
});

test("classifySpawnFailure decides every known reason by code, never by message text", () => {
  const cases: Array<{ input: unknown; reason: string }> = [
    { input: new RuntimeExecutableNotFoundError({ runtimeId: "codex", message: "Cannot resolve a compatible Codex CLI app-server entry point" }), reason: "runtime_not_found" },
    { input: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }), reason: "runtime_not_found" },
    { input: new AgentProxyBindError("Agent Credential Proxy local proxy failed to bind 127.0.0.1 after 3 attempts"), reason: "agent_proxy_bind_failed" },
    { input: new ProviderConnectionMaterializationError({ kind: "http", status: 503, message: "Provider connection materialization failed (HTTP 503): secret=x" }), reason: "provider_connection_materialization_failed" },
    { input: Object.assign(new Error("runner_credential_mint_failed: fetch failed"), { spawnFailureCode: "runner_credential_mint_failed" }), reason: "runner_credential_mint_failed" },
    // Text that used to match by accident now falls through to the generic fallback.
    { input: new Error("spawn claude ENOENT"), reason: "runtime_spawn_failed" },
    { input: new Error("Agent Credential Proxy local proxy failed to bind"), reason: "runtime_spawn_failed" },
    { input: new Error("Provider connection materialization failed (HTTP 503)"), reason: "runtime_spawn_failed" },
    { input: new Error("codex: command not found"), reason: "runtime_spawn_failed" },
    { input: Object.assign(new Error("weird"), { code: "EPERM" }), reason: "runtime_spawn_failed" },
  ];
  for (const specimen of cases) {
    assert.equal(classifySpawnFailure(specimen.input).reason, specimen.reason, String((specimen.input as Error).message));
  }
  const http = classifySpawnFailure(new ProviderConnectionMaterializationError({ kind: "http", status: 503, message: "x secret=poison" }));
  assert.equal(http.userMessage, "Provider connection materialization failed (HTTP 503). Check Server Settings → AI Providers and retry.");
  const env = classifySpawnFailure(new ProviderConnectionMaterializationError({ kind: "invalid_environment", message: "y" }));
  assert.match(env.userMessage, /invalid environment/);
});
