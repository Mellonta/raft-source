import assert from "node:assert/strict";
import {
  CODEX_TOOL_ARGUMENT_PARSE_UPSTREAM_FIXTURE,
  isCodexToolArgumentParseErrorChunk,
} from "./codexToolArgumentParseSignature";
import { DAEMON_CORE_TRACE_ATTR_CONTRACTS } from "./core";

/**
 * task #1127. This signature is the one sanctioned text match in the Codex
 * driver, so its teeth are two-sided on purpose: every positive row proves the
 * signature still fires on the upstream sentence, and every negative row proves
 * it has not widened into a neighbour that a different mechanism already owns.
 */

test("matches the upstream incident line verbatim", () => {
  // artin Mac 2026-09-14 19:18:44Z, Codex CLI 0.153.4, upstream openai/codex#33452.
  assert.equal(isCodexToolArgumentParseErrorChunk(CODEX_TOOL_ARGUMENT_PARSE_UPSTREAM_FIXTURE), true);
});

test("matches regardless of the serde tail, which varies with the model's output", () => {
  // The type name and the offending value are inputs, not part of the signature.
  for (const tail of [
    "invalid type: floating point 14380.0, expected i32",
    "invalid type: string \"7\", expected u64",
    "invalid type: null, expected a sequence",
    "missing field `timeout_ms`",
  ]) {
    assert.equal(
      isCodexToolArgumentParseErrorChunk(
        `ERROR codex_core::tools::router: error=failed to parse function arguments: ${tail}`,
      ),
      true,
      `expected the signature to survive the serde tail: ${tail}`,
    );
  }
});

test("does NOT match the sibling router error the repo already carries a fixture for", () => {
  // Same tracing target, different failure, owned by isStdinClassRecoveryLine.
  // Matching on the target alone would silently reclassify this as a model
  // output-format problem and send the user to change models for a stdin bug.
  assert.equal(
    isCodexToolArgumentParseErrorChunk(
      "ERROR codex_core::tools::router: error=write_stdin failed: stdin is closed for this session",
    ),
    false,
  );
});

test("does NOT match a parse failure from outside the tool router", () => {
  assert.equal(
    isCodexToolArgumentParseErrorChunk(
      "ERROR codex_core::config: error=failed to parse function arguments: invalid type: floating point 1.0, expected i32",
    ),
    false,
  );
});

test("tolerates multi-line chunks, because stderr is not line-split upstream", () => {
  // drivers/runtimeSession.ts attaches stderr with `chunk.toString().trim()` —
  // no decoder, no newline buffering. A chunk can carry several lines at once,
  // so a line-anchored match would miss the real thing in production while
  // still passing a single-line test.
  const chunk = [
    "INFO codex_core::codex: turn started",
    "ERROR codex_core::tools::router: error=failed to parse function arguments: invalid type: floating point 14380.0, expected i32",
    "INFO codex_core::codex: turn continuing",
  ].join("\n");
  assert.equal(isCodexToolArgumentParseErrorChunk(chunk), true);
});

test("ignores empty and unrelated chunks", () => {
  for (const text of [
    "",
    "   ",
    "Reconnecting... 1/5",
    "Falling back from WebSockets to HTTP",
    "ERROR codex_core::tools::router: error=report_agent_job_result handler received unsupported payload",
  ]) {
    assert.equal(isCodexToolArgumentParseErrorChunk(text), false, `unexpected match on: ${text}`);
  }
});

test("the pinned upstream fixture still contains both halves of the signature", () => {
  // If someone edits the fixture to something Codex does not emit, the rest of
  // this file would keep passing against a sentence that exists nowhere.
  assert.match(CODEX_TOOL_ARGUMENT_PARSE_UPSTREAM_FIXTURE, /codex_core::tools::router/);
  assert.match(CODEX_TOOL_ARGUMENT_PARSE_UPSTREAM_FIXTURE, /failed to parse function arguments:/);
});

test("the trace contract pins the span to identity+model, so argument values cannot be added later", () => {
  const contract = (DAEMON_CORE_TRACE_ATTR_CONTRACTS as Record<string, { spanAttrs: string[] }>)[
    "daemon.agent.tool_argument_parse_failed"
  ];
  assert.ok(contract, "the span must be registered, or its attrs pass through unfiltered");
  assert.deepEqual(contract.spanAttrs, ["agentId", "launchId", "runtime", "model"]);
  // The rejected arguments are model output; no attr may exist to carry them.
  for (const forbidden of ["stderr", "error", "arguments", "detail", "message"]) {
    assert.equal(contract.spanAttrs.includes(forbidden), false, `${forbidden} must not be contracted`);
  }
});
