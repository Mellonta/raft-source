import assert from "node:assert/strict";

import { createAgentApiClient, type AgentApiClient } from "../agentApiClient";
import {
  amendTask,
  channelMembers,
  createTasks,
  isInterrupted,
  joinChannel,
  leaveChannel,
  listTasks,
  listThreads,
  muteChannel,
  serverInfo,
  showProfile,
  unfollowThread,
  updateTaskStatus,
} from "./index";

type Scripted = (path: string, init: RequestInit) => Response | Promise<Response>;

function client(script: Scripted, calls: Array<{ method: string; path: string; body: unknown }> = []): AgentApiClient {
  return createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example",
      auth: { authorization: "Bearer sk_agent_test" },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const path = `${url.pathname}${url.search}`;
        calls.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return script(path, init ?? {});
      },
    },
  });
}

const T = "2026-08-31T08:00:00.000Z";
const serverInfoBody = {
  runtimeContext: { agentId: "agent-1", serverId: "server-1" },
  serverRole: "member",
  channels: [
    { id: "11111111-1111-4111-8111-111111111111", name: "general", joined: true, type: "channel", description: "everyone" },
    { id: "22222222-2222-4222-8222-222222222222", name: "proj-sdk", joined: false, type: "channel" },
  ],
  agents: [{ name: "Tenny", status: "online", role: "admin" }],
  humans: [{ name: "tygg", role: "owner" }],
};

test("tasks: list renders the CLI board, create points at the task thread, held writes are interrupts whose resume is the identical command", async () => {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const api = client((path) => {
    if (path.startsWith("/internal/agent-api/tasks?")) {
      return Response.json({ tasks: [
        { taskNumber: 1, status: "in_progress", title: "design", claimedById: "a-1", claimedByName: "Grace", createdByName: "tygg", messageId: "4bb76880-a400-4f82-a4ff-f1c1a61f2f2d" },
        { taskNumber: 2, status: "todo", title: "review", createdByName: "tygg" },
      ] });
    }
    if (path === "/internal/agent-api/tasks") return Response.json({ tasks: [{ taskNumber: 3, messageId: "aaaaaaaa-0000-0000-0000-000000000000", title: "new work", status: "todo", claimedByType: null, claimedById: null, claimedAt: null, requiresResourceReceipt: false }] });
    if (path === "/internal/agent-api/tasks/update-status") return Response.json({ state: "held", freshnessContextMode: "withheld", withheldMessageCount: 2 });
    if (path === "/internal/agent-api/tasks/amend") return Response.json({ task: { taskNumber: 1, title: "design (v2)", description: null, revision: 4 }, event: { id: "eeeeeeee-0000-4000-8000-000000000000", seq: 9, eventType: "amended", actorType: "agent", actorName: "Grace", payload: {}, createdAt: T } });
    return new Response("unexpected", { status: 500 });
  }, calls);

  const board = await listTasks(api, { target: "#proj-sdk", status: "all" });
  assert.equal(calls[0]?.path, "/internal/agent-api/tasks?channel=%23proj-sdk&status=all");
  assert.equal(board.ok && board.state, "board");
  if (board.ok) {
    assert.match(board.text, /^## Task Board for #proj-sdk \(2 tasks\)/);
    assert.match(board.text, /#1 \[in_progress\] → @Grace \(by @tygg\) msg=4bb76880 Current title: design/);
    assert.deepEqual(board.next?.args, { target: "#proj-sdk", taskNumbers: [2] }, "an open todo task is the next thing to claim");
  }
  const invalid = await listTasks(api, {});
  assert.equal(invalid.ok, false);

  const created = await createTasks(api, { target: "#proj-sdk", tasks: [{ title: "new work" }] });
  assert.equal(created.ok && created.state, "created");
  const createCall = calls.find((c) => c.path === "/internal/agent-api/tasks" && c.method === "POST");
  const generatedKey = (createCall?.body as { idempotencyKey?: string } | undefined)?.idempotencyKey;
  assert.match(generatedKey ?? "", /^[0-9a-f-]{36}$/, "a key is generated when the caller gives none");
  if (created.ok) {
    assert.equal(created.data.idempotencyKey, generatedKey, "the generated key is returned so the caller can retry with it");
    assert.equal(created.next?.command, `raft message send --target "#proj-sdk:aaaaaaaa"`);
    assert.match(created.text, /^Created 1 task\(s\) in #proj-sdk:/);
  }

  const held = await updateTaskStatus(api, { target: "#proj-sdk", taskNumber: 1, status: "in_review" });
  assert.equal(held.ok && held.state, "interrupted");
  if (isInterrupted(held)) {
    assert.equal(held.interrupt.withheld, true);
    assert.deepEqual(held.interrupt.resume, { argv: ["task", "update", "--target", "#proj-sdk", "--number", "1", "--status", "in_review"] });
    assert.equal(held.interrupt.cancel, undefined, "a held task write saved nothing: no cancel");
    assert.deepEqual(held.next?.args, { target: "#proj-sdk" });
  }

  const heldAmend = await amendTask(
    client(() => Response.json({ state: "held", newMessageCount: 1, heldMessages: [], omittedMessageCount: 1, seenUpToSeq: 7 })),
    { target: "#proj-sdk", taskNumber: 2, title: "t", description: null },
  );
  if (!isInterrupted(heldAmend)) return assert.fail("expected an interrupt");
  assert.deepEqual(heldAmend.interrupt.resume.argv, ["task", "amend", "--target", "#proj-sdk", "--number", "2", "--title", "t", "--clear-description"]);
  assert.equal(heldAmend.interrupt.contextComplete, true);
  assert.equal(heldAmend.interrupt.cancel, undefined);

  const amended = await amendTask(api, { target: "#proj-sdk", taskNumber: 1, title: "design (v2)" });
  assert.equal(amended.ok && amended.state, "amended");
  if (amended.ok && amended.state === "amended") assert.match(amended.text, /^#1 amended — revision 4, event seq 9\./);
});

test("channels: join is idempotent, leave and mute resolve #name through server info, members renders the CLI text", async () => {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const api = client((path, init) => {
    if (path === "/internal/agent-api/server") return Response.json(serverInfoBody);
    if (path.endsWith("/join")) return Response.json({ ok: true });
    if (path.endsWith("/leave")) return Response.json({ ok: true, attention: { ordinaryActivity: "Ordinary channel activity no longer reaches you." } });
    if (path.endsWith("/mute")) return Response.json({ activityMuted: true, muteFromSeq: 500, attention: { stillArrives: ["personal @mentions", "DMs"], unmuteCommand: 'raft channel unmute --target "#general"' } });
    if (path.startsWith("/internal/agent-api/channel-members")) return Response.json({ channel: { ref: "#general", type: "channel" }, agents: [{ name: "Tenny", status: "online", role: "admin" }], humans: [{ name: "tygg", role: "owner" }] });
    return new Response(`unexpected ${init.method} ${path}`, { status: 500 });
  }, calls);

  const already = await joinChannel(api, { target: "#general" });
  assert.equal(already.ok && already.state, "already_joined");
  const joined = await joinChannel(api, { target: "#proj-sdk" });
  assert.equal(joined.ok && joined.state, "joined");
  if (joined.ok) assert.equal(joined.data.channelId, "22222222-2222-4222-8222-222222222222");
  const missing = await joinChannel(api, { target: "#nope" });
  assert.equal(missing.ok ? null : missing.error.code, "NOT_FOUND");
  const bad = await joinChannel(api, { target: "dm:@tygg" });
  assert.equal(bad.ok ? null : bad.error.code, "INVALID_REQUEST");

  const notJoined = await leaveChannel(api, { target: "#proj-sdk" });
  assert.equal(notJoined.ok && notJoined.state, "not_joined");
  const left = await leaveChannel(api, { target: "#general" });
  assert.equal(left.ok && left.state, "left");
  assert.ok(calls.some((c) => c.path === "/internal/agent-api/channels/11111111-1111-4111-8111-111111111111/leave"));
  if (left.ok) assert.match(left.text, /^Left #general\. .*\nOrdinary channel activity no longer reaches you\.$/s);

  const muted = await muteChannel(api, { target: "#general" });
  assert.equal(muted.ok && muted.state, "muted");
  if (muted.ok) {
    assert.deepEqual(muted.data.stillArrives, ["personal @mentions", "DMs"]);
    assert.equal(muted.text, [
      "Muted #general.", "Activity muted: yes", "Mute from seq: 500", "Still arrives:", "- personal @mentions", "- DMs",
      'To unmute: raft channel unmute --target "#general"',
    ].join("\n"));
  }

  const members = await channelMembers(api, { target: "#general" });
  assert.equal(members.ok && members.state, "members");
  if (members.ok) {
    assert.match(members.text, /^## Channel Members\n\nChannel: #general \(channel\)\n/);
    assert.match(members.text, /  - @Tenny \(online\) \(admin\)\n/);
  }
});

test("threads: list renders the CLI text and unfollow requires a thread target", async () => {
  const api = client((path) => {
    if (path === "/internal/agent-api/threads") return Response.json({ threads: [{ target: "#proj-sdk:2ad6c504", threadChannelId: "11111111-2222-4333-8444-555555555555", parentChannelRef: "#proj-sdk", parentMessageId: "2ad6c504-c31b-47e3-a5fd-42258ecc3f6f", parentMessageShortId: "2ad6c504", followedAt: T, reason: "mentioned", doneAt: null }] });
    if (path === "/internal/agent-api/threads/unfollow") return Response.json({ ok: true });
    return new Response("unexpected", { status: 500 });
  });
  const threads = await listThreads(api);
  assert.equal(threads.ok && threads.state, "threads");
  if (threads.ok) assert.match(threads.text, /^Followed threads \(1\):\n- #proj-sdk:2ad6c504 \(11111111-2222-4333-8444-555555555555, parent=#proj-sdk, followedAt=/);
  const bad = await unfollowThread(api, { target: "#proj-sdk" });
  assert.equal(bad.ok ? null : bad.error.code, "INVALID_REQUEST");
  const done = await unfollowThread(api, { target: "#proj-sdk:2ad6c504", reason: "work complete" });
  assert.equal(done.ok && done.state, "unfollowed");
});

test("server info: summary by default, paged sections with the CLI's More: line, and the profile card", async () => {
  const api = client((path) => {
    if (path === "/internal/agent-api/server") return Response.json(serverInfoBody);
    if (path.startsWith("/internal/agent-api/profile")) return Response.json({ kind: "agent", id: "a-1", isSelf: true, name: "grace", displayName: "Grace", description: "Raft SDK developer", avatarUrl: null, status: "active", serverRole: "member", runtime: "claude", model: "claude-fable-5-1", reasoningEffort: "medium", executionMode: null, computerId: null, computerName: null, computerHostname: null, daemonVersion: null, creator: null, createdAgents: [], createdAt: T, deletedAt: null });
    return new Response("unexpected", { status: 500 });
  });
  const summary = await serverInfo(api);
  assert.equal(summary.ok && summary.data.view, "summary");
  if (summary.ok) {
    assert.match(summary.text, /^## Server\n\nChannels: 2 visible \(1 joined\)\nAgents: 1\nHumans: 1\n/);
    assert.equal(summary.next?.command, "raft server info --channels");
  }
  const page = await serverInfo(api, { view: "channels", limit: 1 });
  assert.equal(page.ok && page.data.page?.total, 2);
  if (page.ok) {
    assert.match(page.text, /^## Server Channels\n/);
    assert.match(page.text, /#general \[public, joined\] — everyone\nShowing 1-1 of 2\.\nMore: raft server info --channels --offset 1 --limit 1\n$/);
    assert.deepEqual(page.next?.args, { view: "channels", offset: 1, limit: 1 });
  }
  const last = await serverInfo(api, { view: "channels", limit: 1, offset: 1 });
  assert.equal(last.ok && last.next, null);

  const profile = await showProfile(api);
  assert.equal(profile.ok && profile.state, "profile");
  if (profile.ok) {
    assert.match(profile.text, /^## Profile\n\n- Type: agent\n- Handle: @grace\n- Display Name: Grace\n/);
    assert.match(profile.text, /- Runtime: Claude Code\n/, "the CLI's runtime display name, from the shared catalog");
  }
});

test("tasks: create sends the caller's idempotencyKey, never retries by itself, and hands the key back on a retryable failure", async () => {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const ok = await createTasks(
    client(() => Response.json({ tasks: [{ taskNumber: 3, messageId: "aaaaaaaa-0000-4000-8000-000000000000", title: "t", status: "todo", claimedByType: null, claimedById: null, claimedAt: null, requiresResourceReceipt: false }] }), calls),
    { target: "#proj-sdk", tasks: [{ title: "t" }], idempotencyKey: "create-1" },
  );
  assert.equal((calls[0]?.body as { idempotencyKey?: string }).idempotencyKey, "create-1");
  assert.equal(ok.ok && ok.data.idempotencyKey, "create-1");

  let attempts = 0;
  const down = await createTasks(client(() => { attempts += 1; throw new Error("down"); }), { target: "#proj-sdk", tasks: [{ title: "t" }], idempotencyKey: "create-2" });
  assert.equal(attempts, 1, "no automatic retry: a Server without keyed create would create the tasks twice");
  assert.equal(down.ok, false);
  if (!down.ok) {
    assert.equal(down.error.code, "TRANSPORT_ERROR");
    assert.deepEqual(down.next?.args, { idempotencyKey: "create-2" });
  }
});
