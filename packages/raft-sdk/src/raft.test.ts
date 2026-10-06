import assert from "node:assert/strict";
import { createRaft } from "./index";

const credential = "sk_agent_raft_test";
const sample = { channel_type: "channel", channel_name: "general", message_id: "00000000-1111-2222-3333-444444444444", timestamp: "2026-08-31T08:00:00.000Z", sender_type: "human", sender_name: "richard", content: "hello everyone", seq: 1200 };

test("createRaft wires identity, inbox, read, send, and tasks over one credential with the contract's retry split", async () => {
  const calls: Array<{ method: string; path: string; init: RequestInit; body: unknown }> = [];
  const raft = createRaft({
    serverUrl: "https://raft.example/",
    credential,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const path = `${url.pathname}${url.search}`;
      calls.push({ method: init?.method ?? "GET", path, init: init ?? {}, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${credential}`);
      if (path === "/internal/agent-api/context") {
        return Response.json({ agent: { id: "a", name: "grace", displayName: null, description: null, runtime: "external", external: true }, server: { id: "s", slug: "botiverse", name: "Botiverse" }, credential: { capabilities: ["read", "send"] }, prompt: { audience: "self-hosted-runner", text: "guide" } });
      }
      if (path.startsWith("/internal/agent-api/events")) {
        return Response.json({ events: [sample], last_seen_msgId: sample.message_id, last_seen_seq: 1200, reply_target: "#general", has_more: false, ack_mode: "cursor" });
      }
      if (path.startsWith("/internal/agent-api/history")) {
        return Response.json({ target: "#general", messages: [sample, { ...sample, seq: 1201, message_id: "55555555-6666-7777-8888-999999999999" }], has_more: false, has_older: false, has_newer: false, last_read_seq: 1199, model_seen_up_to_seq: 1201 });
      }
      if (path === "/internal/agent-api/v2/send") return Response.json({ ok: true, state: "sent", messageId: "m-1", messageSeq: 1202 });
      if (path === "/internal/agent-api/tasks/claim") return Response.json({ results: [{ messageId: sample.message_id, success: true }] });
      return new Response("unexpected", { status: 500 });
    },
  });

  const me = await raft.identity.whoami();
  assert.equal(me.ok && me.data.agent.name, "grace");

  const batch = await raft.inbox.check();
  assert.equal(batch.ok && batch.data.messages[0]?.text, `[target=#general msg=00000000 time=2026-08-31 08:00:00Z type=human] @richard: hello everyone`);
  const eventsCall = calls.find((c) => c.path.startsWith("/internal/agent-api/events"));
  assert.equal(eventsCall?.path, "/internal/agent-api/events?since=latest&ack=cursor");
  assert.equal(eventsCall?.init.cache, "no-store");
  assert.equal(eventsCall?.init.redirect, "error");

  // Before reading, a send attests only the exact seq the drain rendered.
  await raft.messages.reply(batch.ok ? batch.data.messages[0]! : { target: "#general" }, { content: "hi", idempotencyKey: "k-1" });
  assert.deepEqual(calls.at(-1)?.body, { target: "#general", content: "hi", idempotencyKey: "k-1", seenExactSeqs: [1200] });

  // After a contiguous read, the frontier carries the Server's model-seen boundary.
  const page = await raft.messages.read({ target: "#general" });
  assert.equal(page.ok && page.data.modelSeenUpToSeq, 1201);
  await raft.messages.send({ target: "#general", content: "again", idempotencyKey: "k-2" });
  assert.deepEqual(calls.at(-1)?.body, { target: "#general", content: "again", idempotencyKey: "k-2", seenUpToSeq: 1201 });
  assert.deepEqual(raft.frontier.snapshot().targets["#general"], { upTo: 1201 });

  const claim = await raft.tasks.claim({ target: "#general", messageIds: ["00000000"] });
  assert.equal(claim.ok && claim.state, "claimed");
  if (claim.ok && claim.state === "claimed") assert.equal(claim.next?.command, `raft message send --target "#general:00000000"`);
});

test("createRaft restores an exported frontier and rejects bad configuration before any request", () => {
  const raft = createRaft({ serverUrl: "https://raft.example", credential, frontier: { version: 1, targets: { "#general": { upTo: 7, exact: [9] } }, aliases: {} } });
  assert.deepEqual(raft.frontier.attestation("#general"), { seenUpToSeq: 7, seenExactSeqs: [9] });
  assert.match(raft.routes.manifestVersion, /^[0-9a-f]{16}$/);
  assert.throws(() => createRaft({ serverUrl: "ftp://raft.example", credential }), /HTTP or HTTPS/);
  assert.throws(() => createRaft({ serverUrl: "https://raft.example", credential: "nope" }), /External Agent credential/);
});
