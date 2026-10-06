import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { ProviderRequestActivity } from "@botiverse/raft-shared";
import { createProviderHttpClient } from "./daemonFetch";
import { providerRequestFetch } from "./providerRequestFetch";

test("real provider HTTP reports waiting then received headers without observing the body", async () => {
  let reply!: ServerResponse;
  let requests = 0;
  const server = createServer((_req, res) => { requests++; reply = res; });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const states: ProviderRequestActivity[] = [];
  const client = createProviderHttpClient({}, "request-status", { provider: "deepseek", observe: (state) => states.push(state) });
  try {
    const requested = once(server, "request");
    const response = client.fetch(`http://127.0.0.1:${address.port}/private-path`, { method: "POST", body: "private-prompt" });
    await requested;
    assert.deepEqual(states.map((state) => state.phase), ["waiting"]);
    reply.writeHead(200, { "content-type": "text/event-stream" });
    reply.flushHeaders();
    const result = await response;
    assert.equal(states.at(-1)?.phase, "responding");
    reply.end("original response bytes");
    assert.equal(await result.text(), "original response bytes");
    assert.deepEqual(states.map((state) => state.phase), ["waiting", "responding"]);
    assert.equal(new Set(states.map((state) => state.requestId)).size, 1);
    assert.equal(requests, 1);
    assert.equal(JSON.stringify(states).includes("private"), false);
  } finally {
    client.dispose(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("real redirect response retains identity, metadata and an unlocked cloneable body", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "/final" }); res.end(); }
    else { res.end("original bytes"); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let original!: Response;
  try {
    const result = await providerRequestFetch(async (input, init) => {
      original = await fetch(input, init); return original;
    }, `http://127.0.0.1:${address.port}/redirect`, undefined, { provider: "custom" });
    assert.equal(result, original);
    assert.equal(result.redirected, true);
    assert.equal(result.url, `http://127.0.0.1:${address.port}/final`);
    assert.equal(result.body?.locked, false);
    const clone = result.clone();
    assert.deepEqual(await Promise.all([result.text(), clone.text()]), ["original bytes", "original bytes"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("diagnostics preserve options, HTTP failures and caller cancellation even if observer throws", async () => {
  const init = { method: "POST", body: "original body", signal: new AbortController().signal };
  const states: ProviderRequestActivity[] = [];
  for (const status of [200, 401, 503]) {
    const response = new Response("original failure", { status });
    const result = await providerRequestFetch(async (input, actualInit) => {
      assert.equal(input, "https://local-test.invalid");
      assert.equal(actualInit, init);
      return response;
    }, "https://local-test.invalid", init, { provider: "custom", observe: (state) => { states.push(state); throw new Error("observer unavailable"); } });
    assert.equal(result, response);
    assert.equal(states.at(-1)?.phase, status === 200 ? "responding" : "failed");
    assert.equal(states.at(-1)?.httpStatus, status);
  }
  const failure = new Error("original failure");
  await assert.rejects(providerRequestFetch(async () => { throw failure; }, "https://local-test.invalid", init,
    { provider: "custom" }), (error) => error === failure);
  const controller = new AbortController();
  const cancelled = providerRequestFetch(async (_input, options) => {
    assert.equal(options?.signal, controller.signal);
    return new Promise<Response>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }));
  }, "https://local-test.invalid", { signal: controller.signal }, { provider: "custom", observe: (state) => states.push(state) });
  controller.abort(failure);
  await assert.rejects(cancelled, (error) => error === failure);
  assert.equal(states.at(-1)?.phase, "cancelled");
});
