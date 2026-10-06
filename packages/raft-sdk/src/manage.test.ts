import assert from "node:assert/strict";
import { createRaftClient } from "./index";

const credential = "sk_agent_manage_test_sentinel";
const secret = "server-private-detail";

const agentProfile = {
  kind: "agent", id: "agent-1", isSelf: true, name: "bobo", displayName: "BoBo",
  description: null, avatarUrl: null, status: "active", serverRole: "member",
  runtime: "external", model: "external", reasoningEffort: null, executionMode: null,
  computerId: null, computerName: null, computerHostname: null, daemonVersion: null,
  creator: null, createdAgents: [], createdAt: "2026-09-27T00:00:00Z", deletedAt: null,
};
const appConfig = {
  appId: "system.cleaner", revision: 3, schema: {}, defaults: {}, overrides: {}, effective: {},
};

type Call = { url: string; method: string; body: unknown; authorization: string | null; contentType: string | null };

function recorder(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body instanceof FormData ? init.body : init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      authorization: headers.get("authorization"),
      contentType: headers.get("content-type"),
    };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetch };
}

test("profile, server, action, and app config calls hit the contract routes with the credential", async () => {
  const { calls, fetch } = recorder((call) => {
    if (call.url.endsWith("/server")) return Response.json({ id: "server-1", name: "Renamed" });
    if (call.url.endsWith("/prepare-action")) {
      return Response.json({ messageId: "message-1", metadata: { kind: "action-card" } }, { status: 201 });
    }
    if (call.url.includes("/apps/")) return Response.json(appConfig);
    return Response.json(agentProfile);
  });
  const client = createRaftClient({ serverUrl: "https://raft.example/", credential, fetch });

  const shown = await client.profile.show();
  const other = await client.profile.show({ target: "@alice" });
  const updated = await client.profile.update({ displayName: "BoBo" });
  const renamed = await client.server.update({ name: "Renamed" });
  const prepared = await client.actions.prepare({
    target: "#ops",
    action: { type: "channel:create", name: "launch" },
  });
  const config = await client.apps.getConfig("system.cleaner");
  const patched = await client.apps.patchConfig("system.cleaner", { expectedRevision: 3, set: { maxBytes: 1 } });

  for (const result of [shown, other, updated, renamed, prepared, config, patched]) {
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  assert.equal(shown.ok ? shown.data.name : null, "bobo");
  assert.equal(renamed.ok ? renamed.data.name : null, "Renamed");
  assert.equal(prepared.ok ? prepared.status : null, 201);
  assert.equal(prepared.ok ? prepared.data.messageId : null, "message-1");
  assert.equal(patched.ok ? patched.data.revision : null, 3);

  assert.deepEqual(calls.map(({ url, method }) => [method, url]), [
    ["GET", "https://raft.example/internal/agent-api/profile"],
    ["GET", "https://raft.example/internal/agent-api/profile?target=%40alice"],
    ["POST", "https://raft.example/internal/agent-api/profile"],
    ["PATCH", "https://raft.example/internal/agent-api/server"],
    ["POST", "https://raft.example/internal/agent-api/prepare-action"],
    ["GET", "https://raft.example/internal/agent-api/apps/system.cleaner/config"],
    ["PATCH", "https://raft.example/internal/agent-api/apps/system.cleaner/config"],
  ]);
  assert.deepEqual(calls[2]?.body, { displayName: "BoBo" });
  assert.deepEqual(calls[6]?.body, { expectedRevision: 3, set: { maxBytes: 1 }, unset: [] });
  assert.ok(calls.every((call) => call.authorization === `Bearer ${credential}`));
});

test("writes make one attempt even when the client allows retries", async () => {
  let attempts = 0;
  const client = createRaftClient({
    serverUrl: "https://raft.example",
    credential,
    retry: { attempts: 3 },
    fetch: async () => { attempts += 1; throw new Error(secret); },
  });
  const result = await client.actions.prepare({ target: "#ops", action: { type: "channel:create", name: "x" } });
  assert.equal(attempts, 1);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.error.code, "TRANSPORT_ERROR");
  assert.equal(JSON.stringify(result).includes(secret), false);

  attempts = 0;
  await client.profile.show();
  assert.equal(attempts, 3, "reads keep the configured retry budget");
});

test("HTTP rejections keep the Server errorCode but never the body text", async () => {
  const client = createRaftClient({
    serverUrl: "https://raft.example",
    credential,
    fetch: async () => Response.json(
      { error: secret, errorCode: "RAP_APP_CONFIG_REVISION_STALE", currentRevision: 4 },
      { status: 409 },
    ),
  });
  const result = await client.apps.patchConfig("system.cleaner", { expectedRevision: 3, set: {}, unset: ["a"] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 409);
  assert.deepEqual(result.error, {
    code: "HTTP_ERROR",
    message: "The Raft Server rejected the request.",
    errorCode: "RAP_APP_CONFIG_REVISION_STALE",
  });
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("contract-invalid requests fail before transport and invalid responses are rejected", async () => {
  let fetches = 0;
  const client = createRaftClient({
    serverUrl: "https://raft.example",
    credential,
    fetch: async () => { fetches += 1; return Response.json({ id: "server-1" }); },
  });
  const badRequest = await client.server.update({ name: "   " });
  assert.equal(fetches, 0);
  assert.equal(badRequest.ok ? null : badRequest.error.code, "INVALID_REQUEST");

  const badResponse = await client.server.update({ name: "Renamed" });
  assert.equal(fetches, 1);
  assert.equal(badResponse.ok ? null : badResponse.error.code, "INVALID_RESPONSE");
});

test("updateAvatar sends one multipart avatar field and validates the returned profile", async () => {
  const { calls, fetch } = recorder(() => Response.json({ ...agentProfile, avatarUrl: "https://cdn.example/a.png" }));
  const client = createRaftClient({
    serverUrl: "https://raft.example",
    credential,
    headers: { "content-type": "application/json", "x-sdk-test": "avatar" },
    retry: { attempts: 3 },
    fetch,
  });
  const result = await client.profile.updateAvatar({
    data: new Uint8Array([137, 80, 78, 71]),
    filename: "avatar.png",
    mimeType: "image/png",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.ok ? result.data.avatarUrl : null, "https://cdn.example/a.png");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://raft.example/internal/agent-api/profile/avatar");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.authorization, `Bearer ${credential}`);
  assert.equal(calls[0]?.contentType, null, "fetch must set the multipart boundary");
  const form = calls[0]?.body as FormData;
  const file = form.get("avatar") as File;
  assert.equal(file.name, "avatar.png");
  assert.equal(file.type, "image/png");
  assert.equal(file.size, 4);
});

test("updateAvatar rejects bad input locally and hides Server error text", async () => {
  let fetches = 0;
  const client = createRaftClient({
    serverUrl: "https://raft.example",
    credential,
    fetch: async () => { fetches += 1; return Response.json({ error: secret }, { status: 400 }); },
  });
  const wrongType = await client.profile.updateAvatar({
    data: new Uint8Array([1]), filename: "a.svg", mimeType: "image/svg+xml" as never,
  });
  const tooLarge = await client.profile.updateAvatar({
    data: new Uint8Array(5 * 1024 * 1024 + 1), filename: "a.png", mimeType: "image/png",
  });
  const empty = await client.profile.updateAvatar({ data: new Uint8Array(0), filename: "a.png", mimeType: "image/png" });
  for (const result of [wrongType, tooLarge, empty]) {
    assert.equal(result.ok ? null : result.error.code, "INVALID_REQUEST");
  }
  assert.equal(fetches, 0);

  const rejected = await client.profile.updateAvatar({ data: new Uint8Array([1]), filename: "a.png", mimeType: "image/png" });
  assert.equal(fetches, 1);
  assert.equal(rejected.ok ? null : rejected.error.code, "HTTP_ERROR");
  assert.equal(JSON.stringify(rejected).includes(secret), false);
});
