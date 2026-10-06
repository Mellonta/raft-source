import assert from "node:assert/strict";
import {
  ChatBridgeToolTimeoutError,
  executeResponseRequest,
  executeJsonRequest,
} from "./chatBridgeRequest";

function createTimeoutDurationClock(timeoutMs: number): () => number {
  let nowMs = 1_000;
  return () => {
    const current = nowMs;
    nowMs += timeoutMs;
    return current;
  };
}

test("executeJsonRequest returns parsed JSON for successful requests", async () => {
  const warnings: string[] = [];
  const { response, data, durationMs } = await executeJsonRequest<{ ok: boolean }>(
    "https://example.com/history",
    { method: "GET" },
    {
      toolName: "read_history",
      target: "#engineering",
      timeoutMs: 50,
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      warn: (message) => warnings.push(message),
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(data, { ok: true });
  assert.equal(typeof durationMs, "number");
  assert.equal(warnings.length, 0);
});

test("executeJsonRequest aborts locally and logs a structured timeout when fetch stalls", async () => {
  const warnings: string[] = [];

  await assert.rejects(
    () =>
      executeJsonRequest(
        "https://example.com/history",
        { method: "GET" },
        {
          toolName: "read_history",
          target: "#engineering",
          timeoutMs: 10,
          now: createTimeoutDurationClock(10),
          fetchImpl: async (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new DOMException("This operation was aborted", "AbortError"));
              });
            }),
          warn: (message) => warnings.push(message),
        },
      ),
    (err: unknown) => {
      assert.ok(err instanceof ChatBridgeToolTimeoutError);
      assert.equal(err.toolName, "read_history");
      assert.equal(err.target, "#engineering");
      assert.equal(err.timeoutMs, 10);
      assert.equal(err.durationMs, 10);
      return true;
    },
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] || "", /\[ChatBridgeTimeout\]/);
  assert.match(warnings[0] || "", /tool=read_history/);
  assert.match(warnings[0] || "", /target=#engineering/);
  assert.match(warnings[0] || "", /outcome=timeout/);
});

test("executeResponseRequest returns the raw response for binary/file flows", async () => {
  const warnings: string[] = [];
  const { response, durationMs } = await executeResponseRequest(
    "https://example.com/file",
    { method: "GET" },
    {
      toolName: "view_file",
      target: "attachment-1",
      timeoutMs: 50,
      fetchImpl: async () =>
        new Response("hello", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      warn: (message) => warnings.push(message),
    },
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "hello");
  assert.equal(typeof durationMs, "number");
  assert.equal(warnings.length, 0);
});

test("executeResponseRequest aborts locally and logs a structured timeout when fetch stalls", async () => {
  const warnings: string[] = [];

  await assert.rejects(
    () =>
      executeResponseRequest(
        "https://example.com/file",
        { method: "GET" },
        {
          toolName: "view_file",
          target: "attachment-1",
          timeoutMs: 10,
          now: createTimeoutDurationClock(10),
          fetchImpl: async (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new DOMException("This operation was aborted", "AbortError"));
              });
            }),
          warn: (message) => warnings.push(message),
        },
      ),
    (err: unknown) => {
      assert.ok(err instanceof ChatBridgeToolTimeoutError);
      assert.equal(err.toolName, "view_file");
      assert.equal(err.target, "attachment-1");
      assert.equal(err.timeoutMs, 10);
      assert.equal(err.durationMs, 10);
      return true;
    },
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] || "", /\[ChatBridgeTimeout\]/);
  assert.match(warnings[0] || "", /tool=view_file/);
  assert.match(warnings[0] || "", /target=attachment-1/);
  assert.match(warnings[0] || "", /outcome=timeout/);
});

// A proxy or body-parser error page is HTML. The status must be read BEFORE
// the body is parsed, so a 413 surfaces as a 413 and not as a JSON parse error.
test("executeJsonRequest reports a non-JSON error response by its HTTP status, not as a parse error", async () => {
  const html = "<!DOCTYPE html><html><body><pre>PayloadTooLargeError: request entity too large</pre></body></html>";
  await assert.rejects(
    executeJsonRequest("https://slock.test/internal/machine/scope-attestation", { method: "POST" }, {
      toolName: "daemon_direct_upload.scope_attestation",
      fetchImpl: async () => new Response(html, { status: 413, headers: { "Content-Type": "text/html" } }),
      warn: () => {},
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as Error & { status?: number }).status, 413);
      assert.match(err.message, /\b413\b/);
      assert.doesNotMatch(err.message, /Unexpected token|JSON/);
      return true;
    },
  );
});

test("executeJsonRequest keeps a JSON error body's message beside the status", async () => {
  await assert.rejects(
    executeJsonRequest("https://slock.test/x", { method: "POST" }, {
      toolName: "t",
      fetchImpl: async () => new Response(JSON.stringify({ error: "Scope attestation request body exceeds 1 MiB", code: "scope_attestation_body_too_large" }), { status: 413, headers: { "Content-Type": "application/json" } }),
      warn: () => {},
    }),
    (err: unknown) => {
      assert.equal((err as Error & { status?: number }).status, 413);
      assert.match((err as Error).message, /413/);
      assert.match((err as Error).message, /exceeds 1 MiB/);
      return true;
    },
  );
});
