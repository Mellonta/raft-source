import assert from "node:assert/strict";
import { createRaftClient } from "./index";

const credential = "sk_agent_context_test_sentinel";
const body = {
  agent: {
    id: "agent-1", name: "bobo", displayName: "BoBo", description: null,
    runtime: "external", external: true, future_agent_field: "discard",
  },
  server: { id: "server-1", slug: "botiverse", name: "Botiverse", future_server_field: "discard" },
  credential: { capabilities: ["send", "read"] },
  prompt: { audience: "self-hosted-runner", text: "# Guide" },
};

test("agent.context returns the bound agent, server slug and name, and capabilities", async () => {
  const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
  const client = createRaftClient({
    serverUrl: "https://raft.example/",
    credential,
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json(body);
    },
  });

  const result = await client.agent.context();

  assert.deepEqual(calls, [{
    url: "https://raft.example/internal/agent-api/context",
    method: "GET",
    authorization: `Bearer ${credential}`,
  }]);
  assert.deepEqual(result, {
    ok: true,
    status: 200,
    data: {
      agent: {
        id: "agent-1", name: "bobo", displayName: "BoBo", description: null,
        runtime: "external", external: true,
      },
      server: { id: "server-1", slug: "botiverse", name: "Botiverse" },
      capabilities: ["send", "read"],
      guide: "# Guide",
    },
  });
});

test("agent.context maps a managed agent's null prompt to a null guide", async () => {
  const client = createRaftClient({
    serverUrl: "https://raft.example",
    credential,
    fetch: async () => Response.json({ ...body, prompt: null }),
  });
  const result = await client.agent.context();
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.data.guide : "unreached", null);
});

test("agent.context failures carry a stable code and no response body", async () => {
  const secret = "server-private-detail";
  const http = createRaftClient({
    serverUrl: "https://raft.example",
    credential,
    fetch: async () => Response.json({ error: secret }, { status: 401 }),
  });
  const httpResult = await http.agent.context();
  assert.equal(httpResult.ok, false);
  if (httpResult.ok) return;
  assert.equal(httpResult.status, 401);
  assert.equal(httpResult.error.code, "HTTP_ERROR");
  assert.equal(JSON.stringify(httpResult).includes(secret), false);

  const invalid = createRaftClient({
    serverUrl: "https://raft.example",
    credential,
    fetch: async () => Response.json({ ...body, server: { id: "server-1" } }),
  });
  const invalidResult = await invalid.agent.context();
  assert.equal(invalidResult.ok, false);
  assert.equal(invalidResult.ok ? null : invalidResult.error.code, "INVALID_RESPONSE");

  const transport = createRaftClient({
    serverUrl: "https://raft.example",
    credential,
    fetch: async () => { throw new Error(secret); },
  });
  const transportResult = await transport.agent.context();
  assert.equal(transportResult.ok, false);
  if (transportResult.ok) return;
  assert.equal(transportResult.error.code, "TRANSPORT_ERROR");
  assert.equal(JSON.stringify(transportResult).includes(secret), false);
});
