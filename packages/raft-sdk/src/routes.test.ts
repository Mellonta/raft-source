import assert from "node:assert/strict";
import { AGENT_API_ROUTE_MANIFEST } from "@botiverse/raft-shared/src/generated/agentApiRoutes";
import { agentApiContract } from "@botiverse/raft-shared/src/agentApiContract";
import { createRaftClient, createRaftRoutes, describeRaftRoute, listRaftRoutes } from "./index";

const credential = "sk_agent_routes_test";

test("routes layer reaches every route in the shared manifest, by construction", () => {
  const client = createRaftClient({ serverUrl: "https://raft.example", credential, fetch: async () => Response.json({}) });
  for (const entry of AGENT_API_ROUTE_MANIFEST) {
    const resource = (client.routes as unknown as Record<string, Record<string, unknown>>)[entry.client.resource];
    assert.equal(typeof resource?.[entry.client.method], "function", `${entry.key} → routes.${entry.client.resource}.${entry.client.method}`);
  }
  assert.equal(listRaftRoutes().length, AGENT_API_ROUTE_MANIFEST.length);
  assert.equal(client.routes.list().length, Object.keys(agentApiContract).length);
  assert.match(client.routes.manifestVersion, /^[0-9a-f]{16}$/);
});

test("route descriptions carry the shared operating metadata, not HTTP-method guesses", () => {
  const events = describeRaftRoute("events");
  assert.equal(events.method, "GET");
  assert.equal(events.sideEffect, "destructive_read");
  assert.equal(events.retryPolicy, "single_attempt");
  assert.deepEqual(events.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false });

  const resolve = describeRaftRoute("resolveChannel");
  assert.equal(resolve.method, "POST");
  assert.equal(resolve.sideEffect, "read");
  assert.equal(resolve.retryPolicy, "retry");

  const send = describeRaftRoute("messageSend");
  assert.equal(send.destructive, false);
  assert.equal(send.annotations.destructiveHint, false);
  assert.equal(describeRaftRoute("taskDelete").annotations.destructiveHint, true);
  assert.equal(send.idempotency, "key");
  assert.equal(send.retryPolicy, "retry_when_keyed");
  assert.equal(send.capability, "send");

  assert.equal(describeRaftRoute("reminderCreate").audience, "managed");
  assert.equal(describeRaftRoute("pushWebhookRegister").audience, "external");
});

test("reads retry on transport failure while writes make exactly one attempt", async () => {
  const attempts: string[] = [];
  const routes = createRaftRoutes({
    serverUrl: "https://raft.example",
    authorization: `Bearer ${credential}`,
    readAttempts: 3,
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      attempts.push(`${init?.method ?? "GET"} ${path}`);
      if (attempts.filter((a) => a.endsWith(path)).length < 3) throw new Error("connection reset");
      return Response.json({ runtimeContext: { agentId: "agent-1", serverId: "server-1" }, channels: [], agents: [], humans: [] });
    },
  });

  const info = await routes.server.info();
  assert.equal(info.ok, true);
  assert.equal(attempts.filter((a) => a === "GET /internal/agent-api/server").length, 3);

  const claim = await routes.tasks.claim({ body: { channel: "#sdk", task_numbers: [1] } });
  assert.equal(claim.ok, false);
  assert.equal(claim.ok ? null : claim.error.kind, "transport");
  assert.equal(attempts.filter((a) => a === "POST /internal/agent-api/tasks/claim").length, 1);

  // A keyed write is not statically retry-safe either: one attempt at this layer.
  const sent = await routes.messages.send({ body: { target: "#sdk", content: "hi", idempotencyKey: "k-1" } });
  assert.equal(sent.ok, false);
  assert.equal(attempts.filter((a) => a === "POST /internal/agent-api/send").length, 1);
});

test("empty-response routes succeed on 204 and reject a body", async () => {
  let respondWithBody = false;
  const routes = createRaftRoutes({
    serverUrl: "https://raft.example",
    authorization: `Bearer ${credential}`,
    fetch: async (_input, init) => {
      assert.equal(init?.method, "DELETE");
      return respondWithBody ? Response.json({ ok: true }) : new Response(null, { status: 204 });
    },
  });
  const removed = await routes.pushWebhook.unregister();
  assert.deepEqual(removed, { ok: true, routeKey: "pushWebhookDelete", status: 204, data: null });

  respondWithBody = true;
  const drifted = await routes.pushWebhook.unregister();
  assert.equal(drifted.ok, false);
  assert.equal(drifted.ok ? null : drifted.error.reason, "response_contract_mismatch");
});

test("PUT routes serialise the body and send the contract path", async () => {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const routes = createRaftRoutes({
    serverUrl: "https://raft.example",
    authorization: `Bearer ${credential}`,
    fetch: async (input, init) => {
      calls.push({ method: init?.method ?? "GET", path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
      return Response.json({
        registered: true, url: "https://hooks.example.test/raft", enabled: true, disabledReason: null, disabledAt: null,
        lastAttemptAt: null, lastDeliveryAt: null, lastError: null, consecutiveFailures: 0, nextAttemptAt: null,
      });
    },
  });
  const secret = "0123456789abcdef".repeat(4);
  const result = await routes.pushWebhook.register({ body: { url: "https://hooks.example.test/raft", secret } });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ method: "PUT", path: "/internal/agent-api/push-webhook", body: { url: "https://hooks.example.test/raft", secret } }]);
});

test("every route takes exactly one named { params, query, body } object; anything else is refused before sending", async () => {
  const sent: Array<{ path: string; body: unknown }> = [];
  const routes = createRaftRoutes({
    serverUrl: "https://raft.example",
    authorization: `Bearer ${credential}`,
    fetch: async (input, init) => {
      sent.push({ path: new URL(String(input)).pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({ messageId: "m-1", metadata: { kind: "action-card" } });
    },
  });
  const body = { target: "#sdk", action: { type: "channel:create", name: "x", visibility: "public" } } as const;

  // Compile-time: the old positional shapes, a missing required body, and a part the route does not have.
  // @ts-expect-error — positional body is not a call shape any more
  await routes.actions.prepare(body).catch(() => undefined);
  // @ts-expect-error — the body is required for this route
  await routes.actions.prepare({}).catch(() => undefined);
  // @ts-expect-error — actionPrepare has no params
  await routes.actions.prepare({ params: { x: 1 }, body }).catch(() => undefined);
  assert.equal(sent.length, 0, "none of the ill-typed calls reached the network");

  // Runtime backstop for callers without type checking.
  const threeArgs = await (routes.actions.prepare as unknown as (...a: unknown[]) => Promise<{ ok: boolean; error?: { reason: string } }>)(undefined, undefined, { body });
  assert.equal(threeArgs.ok, false);
  assert.equal(threeArgs.error?.reason, "request_contract_mismatch");
  assert.equal(sent.length, 0);

  const ok = await routes.actions.prepare({ body });
  assert.equal(ok.ok, true);
  assert.deepEqual(sent, [{ path: "/internal/agent-api/prepare-action", body }]);

  const byKey = await routes.request("actionPrepare", { body });
  assert.equal(byKey.ok, true);
  assert.equal(sent.length, 2);
});
