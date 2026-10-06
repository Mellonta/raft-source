import assert from "node:assert/strict";
import { createRaft, RAFT_STATE_SCHEMA, type RaftState, type RaftStateStore } from "./index";

const credential = "sk_agent_state_test";
const T = "2026-08-31T08:00:00.000Z";
const msg = (seq: number, content = `m${seq}`) => ({ channel_type: "channel", channel_name: "general", message_id: `${String(seq).padStart(8, "0")}-0000-0000-0000-000000000000`, timestamp: T, sender_type: "human", sender_name: "richard", content, seq });

/** A Server that honours cursor acks: rows stay pending until a pull's `since` covers them. */
function fakeServer(seqs: number[], limit = 2) {
  let pending = seqs.map((s) => msg(s));
  const acked: number[] = [];
  const pulls: string[] = [];
  const sends: Array<Record<string, unknown>> = [];
  let holdNextSend = false;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/internal/agent-api/events") {
      pulls.push(url.search);
      const since = url.searchParams.get("since");
      if (since && since !== "latest") {
        const bound = Number(since);
        for (const r of pending) if (r.seq <= bound) acked.push(r.seq);
        pending = pending.filter((r) => r.seq > bound);
      }
      const page = pending.slice(0, limit);
      return Response.json({ events: page, last_seen_msgId: null, last_seen_seq: page.length ? Math.max(...page.map((r) => r.seq)) : (since && since !== "latest" ? Number(since) : null), reply_target: null, has_more: pending.length > page.length, ack_mode: "cursor" });
    }
    if (url.pathname === "/internal/agent-api/v2/send") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sends.push(body);
      if (holdNextSend) {
        holdNextSend = false;
        return Response.json({ ok: true, state: "held", outcome: "held", subtype: "freshness", reason: "newer_messages_available", decision: "syncing_hold", producerFactId: "f", available_actions: [], heldMessages: [msg(90, "newer")], newMessageCount: 1, shownMessageCount: 1, omittedMessageCount: 0, seenUpToSeq: 90 });
      }
      return Response.json({ ok: true, state: "sent", messageId: "m-1", messageSeq: 91 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { fetch, acked, pulls, sends, holdNext: () => { holdNextSend = true; }, get pendingSeqs() { return pending.map((r) => r.seq); } };
}

/** A store shaped like Antiproton's: compare-and-set inside one synchronous step. */
function casStore() {
  let value: RaftState | null = null;
  const saves: Array<{ version: number; expectedVersion: number | undefined }> = [];
  const store: RaftStateStore = {
    load: async () => (value ? structuredClone(value) : null),
    save: async (state, { expectedVersion }) => {
      if (expectedVersion !== undefined && value?.version !== expectedVersion) throw new Error("stale");
      if (expectedVersion === undefined && value !== null) throw new Error("stale");
      saves.push({ version: state.version, expectedVersion });
      value = structuredClone(state);
    },
  };
  return { store, saves, get value() { return value; } };
}

test("per-call flow across processes: commit() then check(); nothing is acknowledged before commit", async () => {
  const server = fakeServer([1200, 1201, 1202]);
  const { store, saves, value: _v } = casStore();
  void _v;
  const newClient = () => createRaft({ serverUrl: "https://raft.example", credential, fetch: server.fetch, state: store });

  // Call 1 (process A): nothing to commit yet, pull batch 1.
  let raft = newClient();
  assert.deepEqual(await raft.inbox.commit(), { cursor: null, saved: true });
  const b1 = await raft.inbox.check();
  assert.equal(b1.ok && b1.data.messages.map((m) => m.seq).join(), "1200,1201");
  assert.equal(server.pulls.at(-1), "?since=latest&ack=cursor");
  assert.deepEqual(server.acked, [], "a pull acknowledges nothing");
  assert.equal(saves.at(-1)?.version, 1);

  // Call 2 (process B): commit batch 1 from saved state, then pull.
  raft = newClient();
  const committed = await raft.inbox.commit();
  assert.deepEqual(committed, { cursor: 1201, saved: true });
  const b2 = await raft.inbox.check();
  assert.equal(server.pulls.at(-1), "?since=1201&ack=cursor");
  assert.deepEqual(server.acked, [1200, 1201]);
  assert.equal(b2.ok && b2.data.messages.map((m) => m.seq).join(), "1202");
  assert.deepEqual(saves.map((s) => [s.version, s.expectedVersion]), [[1, undefined], [2, 1], [3, 2]]);
});

test("a call that dies before commit gets the same batch again; the SDK never commits on its own", async () => {
  const server = fakeServer([1200, 1201]);
  const { store } = casStore();
  const newClient = () => createRaft({ serverUrl: "https://raft.example", credential, fetch: server.fetch, state: store });

  const first = await newClient().inbox.check();
  assert.equal(first.ok && first.data.messages.length, 2);
  // Crash: no commit. Next call pulls without committing.
  const again = await newClient().inbox.check();
  assert.equal(again.ok && again.data.messages.map((m) => m.seq).join(), "1200,1201", "same batch, still pending");
  assert.deepEqual(server.acked, []);
  assert.equal(server.pulls.every((p) => p === "?since=latest&ack=cursor"), true);
});

test("commit accepts serialisable input and never moves the cursor backwards", async () => {
  const server = fakeServer([10, 11, 12, 13]);
  const { store } = casStore();
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch: server.fetch, state: store });
  assert.deepEqual(await raft.inbox.commit({ cursor: 11 }), { cursor: 11, saved: true });
  assert.deepEqual(await raft.inbox.commit({ cursor: 5 }), { cursor: 11, saved: true });
  const batch = await raft.inbox.check();
  assert.equal(server.pulls.at(-1), "?since=11&ack=cursor");
  assert.equal(batch.ok && batch.data.messages.map((m) => m.seq).join(), "12,13");
  assert.equal(raft.state.snapshot().schema, RAFT_STATE_SCHEMA);
  assert.equal(raft.state.snapshot().pendingCursor, 13);
});

test("an interrupted send is remembered; sending the same content in a later call (the resume) reuses its key", async () => {
  const server = fakeServer([]);
  const { store, value: _v } = casStore();
  void _v;
  const newClient = () => createRaft({ serverUrl: "https://raft.example", credential, fetch: server.fetch, state: store });

  server.holdNext();
  let raft = newClient();
  const held = await raft.messages.send({ target: "#general", content: "on it" });
  assert.equal(held.ok && held.state, "interrupted");
  const key = server.sends[0]!.idempotencyKey;
  if (held.ok && held.state === "interrupted") {
    assert.equal(held.interrupt.resume.idempotencyKey, key);
    assert.equal(held.interrupt.resume.argv, undefined, "in-process: no argv, the SDK stores no draft");
    assert.equal(held.interrupt.cancel, undefined);
    assert.equal(raft.frontier.recordHeld(held.interrupt), true);
    assert.equal(await raft.state.save(), true);
  }

  raft = newClient(); // next model step, new process
  const sent = await raft.messages.send({ target: "#general", content: "on it" });
  assert.equal(sent.ok && sent.state, "sent");
  assert.equal(server.sends[1]!.idempotencyKey, key, "same logical message, same key");
  assert.equal(server.sends[1]!.seenUpToSeq, 90, "the recorded held boundary was restored and attested");
  assert.deepEqual(raft.state.snapshot().continuations, [], "cleared after the send went through");

  // Different content is a different message: fresh key.
  const other = await raft.messages.send({ target: "#general", content: "something else" });
  assert.equal(other.ok && other.state, "sent");
  assert.notEqual(server.sends[2]!.idempotencyKey, key);
});

test("a stale or failed save never fails the operation and is reported", async () => {
  const server = fakeServer([1, 2]);
  const errors: Array<{ phase: string }> = [];
  const store: RaftStateStore = {
    load: async () => ({ schema: RAFT_STATE_SCHEMA, version: 4, cursor: null, pendingCursor: null, frontier: { version: 1, targets: {}, aliases: {} } }),
    save: async () => { throw new Error("stale"); },
  };
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch: server.fetch, state: store, onStateSaveError: (_e, ctx) => errors.push(ctx) });
  const batch = await raft.inbox.check();
  assert.equal(batch.ok, true, "the pull succeeded even though the save failed");
  assert.deepEqual(errors, [{ phase: "save", version: 4 }]);
  assert.deepEqual(await raft.inbox.commit(), { cursor: 2, saved: false });
});

test("an unreadable or foreign state value starts empty instead of failing", async () => {
  const server = fakeServer([7]);
  const raft = createRaft({
    serverUrl: "https://raft.example",
    credential,
    fetch: server.fetch,
    state: { load: async () => ({ schema: "something-else" }) as never, save: async () => {} },
  });
  const batch = await raft.inbox.check();
  assert.equal(server.pulls.at(-1), "?since=latest&ack=cursor");
  assert.equal(batch.ok && batch.data.messages.length, 1);
});
