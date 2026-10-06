// users.info / channels.info / tasks.show: the routes they call, input
// validation (nothing sent), and the data beside the text. Byte parity of the
// text with the CLI commands is pinned in packages/cli (sdkOpsParity.test.ts).
import assert from "node:assert/strict";

import { createAgentApiClient, type AgentApiClient } from "../agentApiClient";
import { channelInfo, showTask, userInfo } from "./index";

type Call = { method: string; path: string };

function client(script: (path: string) => Response, calls: Call[]): AgentApiClient {
  return createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example",
      auth: { authorization: "Bearer sk_agent_test" },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const path = `${url.pathname}${url.search}`;
        calls.push({ method: init?.method ?? "GET", path });
        return script(path);
      },
    },
  });
}

const serverInfoBody = {
  runtimeContext: { agentId: "agent-1", serverId: "server-1" },
  channels: [
    { id: "c-1", name: "general", joined: true, type: "channel", description: "everyone", muted: true },
    { id: "c-2", name: "proj-sdk", joined: false, type: "channel" },
    { id: "c-3", name: "ops", joined: true, type: "private" },
  ],
  agents: [{ name: "Tenny", status: "online", role: "admin" }],
  humans: [{ name: "tygg", role: "owner" }],
};

function script(path: string): Response {
  if (path === "/internal/agent-api/server") return Response.json(serverInfoBody);
  if (path === "/internal/agent-api/users/tygg/channels?offset=0&limit=2") {
    return Response.json({
      user: serverInfoBody.humans[0],
      kind: "human",
      memberships: [serverInfoBody.channels[0]],
      uncheckedCount: 1,
      page: { total: 3, offset: 0, limit: 2 },
    });
  }
  if (path.startsWith("/internal/agent-api/users/nobody/channels?")) return Response.json({ error: "User not found or not visible", code: "user_not_found" }, { status: 404 });
  if (path === "/internal/agent-api/channel-members?channel=%23general") return Response.json({ channel: { ref: "#general", type: "channel" }, agents: [{ name: "Tenny" }], humans: [{ name: "tygg" }] });
  if (path === "/internal/agent-api/channel-members?channel=%23proj-sdk") return Response.json({ error: "forbidden" }, { status: 403 });
  if (path === "/internal/agent-api/channel-members?channel=%23ops") return Response.json({ channel: { ref: "#ops", type: "private" }, agents: [], humans: [] });
  if (path.startsWith("/internal/agent-api/tasks?")) return Response.json({ tasks: [{ taskNumber: 7, status: "closed", title: "old", description: null }] });
  return Response.json({ error: "unexpected" }, { status: 500 });
}

test("users.info: one users.channels request; memberships are the subject's, not the caller's", async () => {
  const calls: Call[] = [];
  const outcome = await userInfo(client(script, calls), { name: "@tygg", limit: 2 });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(calls.map((c) => c.path), ["/internal/agent-api/users/tygg/channels?offset=0&limit=2"]);
  assert.equal(outcome.data.user.kind, "human");
  assert.deepEqual(outcome.data.user.value, { name: "tygg", role: "owner" });
  // The caller's server.info row, with the caller's attention flags cleared.
  assert.deepEqual(outcome.data.memberships, [{ id: "c-1", name: "general", joined: true, type: "channel", description: "everyone", muted: undefined, activityMuted: undefined }]);
  assert.equal(outcome.data.skippedChannels, 1);
  assert.deepEqual(outcome.data.page, { total: 3, offset: 0, limit: 2, nextCommand: "raft user info @tygg --offset 2 --limit 2" });
  assert.equal(outcome.next?.kind, "next_page");
  assert.match(outcome.text, /^#general \[public, joined\]$/m);
  assert.match(outcome.text, /^Skipped 1 visible channel roster checks/m);
});

test("users.info: user_not_found is NOT_FOUND with the visible-users next action", async () => {
  const calls: Call[] = [];
  const outcome = await userInfo(client(script, calls), { name: "nobody" });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error.code, "NOT_FOUND");
  assert.equal(outcome.error.status, undefined);
  assert.equal(outcome.error.message, "User not found or not visible: @nobody");
  assert.equal(outcome.error.nextAction, "Run `raft server info --agents --query <name>` or `raft server info --humans --query <name>` to inspect visible users.");
  assert.equal(calls.length, 1);
});

function manyChannels(count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: `c-${index}`, name: `ch-${index}`, joined: true, type: "channel" }));
}

function countingScript(channels: ReturnType<typeof manyChannels>, routeStatus: number | null) {
  return (path: string): Response => {
    if (path === "/internal/agent-api/server") return Response.json({ ...serverInfoBody, channels });
    const match = /^\/internal\/agent-api\/users\/[^/]+\/channels\?offset=(\d+)&limit=(\d+)$/.exec(path);
    if (!match) return Response.json({ error: "unexpected" }, { status: 500 });
    if (routeStatus === 403) return Response.json({ error: "Agent credential is not authorized for this capability", code: "capability_not_authorized", requiredCapability: "channels" }, { status: 403 });
    if (routeStatus === 501) return Response.json({ error: "The current runner session does not support this capability", code: "unsupported_capability" }, { status: 501 });
    if (routeStatus === 4031) return Response.json({ error: "missing required scope", requiredScope: "channel:read", reason: "missing_scope" }, { status: 403 });
    const offset = Number(match[1]);
    const limit = Number(match[2]);
    return Response.json({
      user: serverInfoBody.agents[0],
      kind: "agent",
      memberships: channels.slice(offset, offset + limit).filter((_, index) => index % 2 === 0),
      uncheckedCount: 0,
      page: { total: channels.length, offset, limit },
    });
  };
}

test("users.info: one request whatever the number of visible channels or the window", async () => {
  for (const [count, limit] of [[3, undefined], [300, undefined], [300, 200]] as const) {
    const calls: Call[] = [];
    const outcome = await userInfo(client(countingScript(manyChannels(count), null), calls), { name: "Tenny", ...(limit ? { limit } : {}) });
    assert.equal(outcome.ok, true);
    assert.equal(calls.length, 1, `${count} channels, limit ${limit}`);
    if (!outcome.ok) return;
    const window = Math.min(limit ?? 50, count);
    assert.equal(outcome.data.memberships.length, Math.ceil(window / 2));
    assert.equal(outcome.data.page.total, count);
  }
});

test("users.info: a credential the route refuses (capability, grant, runner session) costs server.info, and every inspected channel is skipped", async () => {
  for (const refusal of [403, 4031, 501]) {
    for (const count of [3, 300]) {
      const calls: Call[] = [];
      const outcome = await userInfo(client(countingScript(manyChannels(count), refusal), calls), { name: "@Tenny" });
      assert.equal(outcome.ok, true);
      if (!outcome.ok) return;
      assert.deepEqual(calls.map((c) => c.path), ["/internal/agent-api/users/Tenny/channels?offset=0&limit=50", "/internal/agent-api/server"]);
      assert.deepEqual(outcome.data.user, { kind: "agent", value: { name: "Tenny", status: "online", role: "admin" } });
      assert.deepEqual(outcome.data.memberships, []);
      assert.equal(outcome.data.skippedChannels, Math.min(50, count));
      assert.match(outcome.text, new RegExp(`^Skipped ${Math.min(50, count)} visible channel roster checks`, "m"));
    }
  }
  const calls: Call[] = [];
  const missing = await userInfo(client(countingScript(manyChannels(3), 403), calls), { name: "Tenny2" });
  assert.equal(!missing.ok && missing.error.code, "NOT_FOUND");
  assert.equal(!missing.ok && missing.error.message, "User not found or not visible: @Tenny2");
  assert.equal(calls.length, 2);
});

test("users.info: limit is at most 200; above it is INVALID_REQUEST and nothing is sent", async () => {
  const calls: Call[] = [];
  const outcome = await userInfo(client(countingScript(manyChannels(300), null), calls), { name: "Tenny", limit: 201 });
  assert.equal(!outcome.ok && outcome.error.code, "INVALID_REQUEST");
  assert.deepEqual(calls, []);
});

test("users.info: any other route failure is the route's failure (no server.info fallback)", async () => {
  const calls: Call[] = [];
  const outcome = await userInfo(client(() => Response.json({ error: "boom" }, { status: 500 }), calls), { name: "Tenny" });
  assert.equal(!outcome.ok && outcome.error.code, "UNAVAILABLE");
  assert.equal(calls.length, 1);
});

test("users.info / channels.info / tasks.show: invalid input is INVALID_REQUEST and nothing is sent", async () => {
  const calls: Call[] = [];
  const api = client(script, calls);
  for (const outcome of [
    await userInfo(api, { name: " @ " }),
    await userInfo(api, { name: "tygg", limit: 0 }),
    await userInfo(api, { name: "tygg", limit: 201 }),
    await userInfo(api, { name: "tygg", offset: -1 }),
    await userInfo(api, {} as never),
    await channelInfo(api, { target: "dm:@tygg" }),
    await channelInfo(api, { target: "#general:abcd1234" }),
    await channelInfo(api, { target: "  " }),
    await showTask(api, { target: "#general", taskNumber: 0 }),
    await showTask(api, { target: "", taskNumber: 1 }),
  ]) {
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error.code, "INVALID_REQUEST");
  }
  assert.deepEqual(calls, []);
});

test("channels.info: a refused roster drops the member counts; a missing channel is NOT_FOUND", async () => {
  const calls: Call[] = [];
  const api = client(script, calls);
  const refused = await channelInfo(api, { target: "proj-sdk" });
  assert.equal(refused.ok && refused.data.memberCounts, null);
  assert.ok(refused.ok && !refused.text.includes("Members:"));
  const counted = await channelInfo(api, { target: "#general" });
  assert.deepEqual(counted.ok && counted.data.memberCounts, { agents: 1, humans: 1 });
  const missing = await channelInfo(api, { target: "#nope" });
  assert.equal(!missing.ok && missing.error.code, "NOT_FOUND");
});

test("tasks.show reads the whole board (status=all), so closed tasks are found", async () => {
  const calls: Call[] = [];
  const outcome = await showTask(client(script, calls), { target: "#general", taskNumber: 7 });
  assert.equal(calls[0]?.path, "/internal/agent-api/tasks?channel=%23general&status=all");
  assert.equal(outcome.ok && outcome.text, "#7 [closed] in #general\nCurrent title: old\nCurrent description: (none set)\n");
  assert.equal(outcome.ok && outcome.data.task.taskNumber, 7);
});
