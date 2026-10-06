import assert from "node:assert/strict";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import {
  getActiveSpan,
  getActiveTraceContext,
  runWithActiveSpan,
  runWithoutActiveSpan,
} from "./activeSpan";

function makeTracer() {
  const sink = new MemoryTraceSink();
  return { sink, tracer: new BasicTracer({ sink }) };
}

test("no active span outside of runWithActiveSpan", () => {
  assert.equal(getActiveSpan(), null);
  assert.equal(getActiveTraceContext(), null);
});

test("runWithActiveSpan exposes the span context across awaits and restores it after", async () => {
  const { tracer } = makeTracer();
  const span = tracer.startSpan("root", { surface: "daemon" });

  const seen = await runWithActiveSpan(span, async () => {
    const before = getActiveTraceContext();
    await new Promise((resolve) => setImmediate(resolve));
    const after = getActiveTraceContext();
    return { before, after };
  });

  assert.deepEqual(seen.before, span.context);
  assert.deepEqual(seen.after, span.context);
  assert.equal(getActiveTraceContext(), null);
  span.end("ok");
});

test("a child started with the active context joins the parent trace", () => {
  const { sink, tracer } = makeTracer();
  const parent = tracer.startSpan("parent", { surface: "daemon" });
  runWithActiveSpan(parent, () => {
    tracer.startSpan("child", { parent: getActiveTraceContext(), surface: "daemon" }).end("ok");
  });
  parent.end("ok");

  const spans = sink.getAllSpans();
  const child = spans.find((span) => span.name === "child");
  assert.equal(child?.context.traceId, parent.context.traceId);
  assert.equal(child?.context.parentSpanId, parent.context.spanId);
});

test("runWithoutActiveSpan clears the span for its work only", () => {
  const { tracer } = makeTracer();
  const span = tracer.startSpan("root", { surface: "daemon" });
  runWithActiveSpan(span, () => {
    assert.equal(runWithoutActiveSpan(() => getActiveSpan()), null);
    assert.equal(getActiveSpan(), span);
  });
  span.end("ok");
});
