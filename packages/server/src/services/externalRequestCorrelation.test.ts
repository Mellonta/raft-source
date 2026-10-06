// Cross-system correlation on Raft's outbound provider calls: the active trace
// id goes out as `X-Raft-Trace-Id` (omitted outside a trace) and the
// provider's response request id is recorded on the provider call span.
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { withTraceRoot } from "../tracing/semanticTrace";
import { __setAgentRuntimeProviderTransportForTests, providerRequest } from "./agentRuntimeProviderService";
import { currentRaftTraceId, raftTraceIdHeaders, responseRequestId } from "./externalRequestCorrelation";

const TARGET = { baseUrl: "https://provider.example.test", token: "pt-test-token" };

function fakeTransport(responseHeaders: Record<string, string>) {
  const seen: Headers[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    seen.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", ...responseHeaders } });
  };
  __setAgentRuntimeProviderTransportForTests({ fetch });
  return seen;
}

afterEach(() => __setAgentRuntimeProviderTransportForTests(null));

test("responseRequestId prefers the provider's own id and keeps only a bounded printable token", () => {
  const headers = (values: Record<string, string>) => (name: string) => values[name];
  assert.equal(responseRequestId(headers({ "x-request-id": "req-1", "cf-ray": "ray-1", "x-antiproton-request-id": "ap-1" })), "ap-1");
  assert.equal(responseRequestId(headers({ "x-request-id": "req-1", "cf-ray": "ray-1" })), "req-1");
  assert.equal(responseRequestId(headers({ "cf-ray": "8c1f-SJC" })), "8c1f-SJC");
  assert.equal(responseRequestId(headers({ "x-request-id": "has space" })), null);
  assert.equal(responseRequestId(headers({ "x-request-id": "x".repeat(129) })), null);
  assert.equal(responseRequestId(headers({})), null);
});

test("no active trace: no trace id and no X-Raft-Trace-Id header", async () => {
  assert.equal(currentRaftTraceId(), null);
  assert.deepEqual(raftTraceIdHeaders(), {});
  const seen = fakeTransport({ "x-request-id": "req-untraced" });
  const result = await providerRequest(TARGET, "GET", "/provision/agents/by-raft-agent/a?raftServerId=s");
  assert.equal(result.kind, "response");
  assert.equal(seen[0]!.get("x-raft-trace-id"), null);
  assert.equal(result.kind === "response" ? result.requestId : undefined, "req-untraced");
});

test("inside a trace: the provider call sends the trace id and records the provider request id on its span", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const seen = fakeTransport({ "x-antiproton-request-id": "ap-req-42", "cf-ray": "ray-9" });
  let rootTraceId = "";
  await withTraceRoot(tracer, "test.root", { surface: "server", kind: "internal" }, async () => {
    rootTraceId = currentRaftTraceId() ?? "";
    await providerRequest(TARGET, "POST", "/provision/agents", { body: { secret: "sk_agent_x" }, idempotencyKey: "agent-1" });
  });
  assert.match(rootTraceId, /^[0-9a-f]{32}$/);
  assert.equal(seen[0]!.get("x-raft-trace-id"), rootTraceId);
  const span = sink.getAllSpans().find((candidate) => candidate.name === "server.agent_runtime_provider.request");
  assert.ok(span, "provider call span recorded");
  assert.equal(span.context.traceId, rootTraceId);
  assert.equal(span.kind, "client");
  assert.equal(span.attrs?.["provider.request_id"], "ap-req-42");
  assert.equal(span.attrs?.http_status, 200);
  assert.ok(!JSON.stringify(span).includes("sk_agent_x") && !JSON.stringify(span).includes("pt-test-token"), "no secrets on the span");
});
