import assert from "node:assert/strict";
import { summarizeHostedRuntimeUsage } from "../src/components/agent/hostedRuntimeUsage";
import type { HostedRuntimeUsageRow } from "../src/components/agent/hostedRuntimeUsage";

const at = "2026-10-01T00:00:00.000Z";
const tokens = (model: string, kind: string, quantity: number): HostedRuntimeUsageRow =>
  ({ at, resource: "model.tokens", dimensions: { model, kind }, unit: "tokens", quantity });
const toolCall = (tool: string, outcome: string, quantity: number): HostedRuntimeUsageRow =>
  ({ at, resource: "tool.call", dimensions: { tool, outcome }, unit: "calls", quantity });

test("tokens are summed by kind across models and buckets; cache writes combine 5m and 1h", () => {
  const summary = summarizeHostedRuntimeUsage([
    tokens("m1", "input", 100),
    tokens("m2", "input", 50),
    tokens("m1", "output", 40),
    tokens("m1", "reasoning", 7),
    tokens("m1", "cache_read", 300),
    tokens("m1", "cache_write_5m", 20),
    tokens("m2", "cache_write_1h", 5),
  ]);
  assert.deepEqual(summary.tokens, { input: 150, output: 40, reasoning: 7, cacheRead: 300, cacheWrite: 25, total: 522 });
  assert.equal(summary.hasUsage, true);
});

test("tool calls count succeeded and failed; other outcomes only count toward the total", () => {
  const summary = summarizeHostedRuntimeUsage([
    toolCall("bash", "succeeded", 3),
    toolCall("bash", "failed", 1),
    toolCall("web", "succeeded", 2),
    toolCall("web", "cancelled", 1),
  ]);
  assert.deepEqual(summary.toolCalls, { total: 7, succeeded: 5, failed: 1 });
});

test("unknown resources, durations and token kinds are tolerated; unknown kinds only count toward the total", () => {
  const summary = summarizeHostedRuntimeUsage([
    { at, resource: "tool.duration", dimensions: { tool: "bash" }, unit: "ms", quantity: 9_000 },
    { at, resource: "sandbox.cpu", dimensions: {}, unit: "cpu_seconds", quantity: 12 },
    tokens("m1", "audio_input", 4),
    { at, resource: "model.tokens", dimensions: { model: "m1", kind: "input" }, unit: "tokens", quantity: Number.NaN },
  ]);
  assert.deepEqual(summary.tokens, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 4 });
  assert.deepEqual(summary.toolCalls, { total: 0, succeeded: 0, failed: 0 });
});

test("top models are ranked by total tokens and capped", () => {
  const summary = summarizeHostedRuntimeUsage([
    tokens("small", "input", 10),
    tokens("big", "input", 500),
    tokens("big", "output", 100),
    tokens("mid", "output", 200),
    tokens("tiny", "input", 1),
  ], { topModelCount: 3 });
  assert.deepEqual(summary.topModels, [
    { model: "big", tokens: 600 },
    { model: "mid", tokens: 200 },
    { model: "small", tokens: 10 },
  ]);
});

test("no rows means no usage", () => {
  const summary = summarizeHostedRuntimeUsage([]);
  assert.equal(summary.hasUsage, false);
  assert.deepEqual(summary.topModels, []);
});
