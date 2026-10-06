import assert from "node:assert/strict";
import type { AgentMessage } from "@botiverse/raft-shared";
import { AgentVisibleDeliveryLedger } from "./agentVisibleDeliveryLedger";

function pendingMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "User",
    sender_type: "human",
    content: "pending",
    timestamp: "2026-01-01T00:00:00.000Z",
    message_id: "m-1",
    seq: 1,
    ...overrides,
  };
}

test("AgentVisibleDeliveryLedger attention delivery records exact ids but does not advance boundary", () => {
  const ledger = new AgentVisibleDeliveryLedger();

  const consumed = ledger.recordConsumed("agent-1", {
    messages: [{ seq: 42, message_id: "m-42", channel_type: "channel", channel_name: "general" }],
    source: "spawn_wake_message",
  });

  assert.ok(consumed);
  assert.equal(
    ledger.getBoundary("agent-1", "#general"),
    undefined,
    "wake delivery is an attention signal and must not advance the model-seen high-water boundary",
  );
  assert.equal(ledger.getMessageIdSet("agent-1", "#general")?.has("m-42"), true);
  assert.equal(ledger.isModelSeen("agent-1", "#general", { seq: 41, message_id: "m-41" }), false);
  assert.equal(ledger.isModelSeen("agent-1", "#general", { seq: 42 }), false);
  assert.equal(ledger.isModelSeen("agent-1", "#general", { message_id: "m-42" }), true);
  assert.equal(consumed.shouldSuppress(pendingMessage({ message_id: "m-42", seq: 42 })), true);
});

test("AgentVisibleDeliveryLedger local events and stdin wake hints cannot advance boundary", () => {
  for (const source of ["agent_api_events_local", "stdin_idle_delivery", "stdin_thread_context_delivery"] as const) {
    const ledger = new AgentVisibleDeliveryLedger();

    ledger.recordConsumed("agent-1", {
      messages: [{ seq: 50, message_id: `m-${source}`, channel_type: "channel", channel_name: "general" }],
      source,
    });

    assert.equal(
      ledger.getBoundary("agent-1", "#general"),
      undefined,
      `${source} is an attention/delivery signal and must not advance model-seen high-water`,
    );
    assert.equal(ledger.isModelSeen("agent-1", "#general", { seq: 49, message_id: `gap-${source}` }), false);
    assert.equal(ledger.isModelSeen("agent-1", "#general", { message_id: `m-${source}` }), true);
  }
});

test("AgentVisibleDeliveryLedger proof-of-catch: set-only sources cannot advance boundary", () => {
  const ledger = new AgentVisibleDeliveryLedger();

  ledger.recordConsumed("agent-1", {
    messages: [{ seq: 50, message_id: "m-50", channel_type: "channel", channel_name: "general" }],
    source: "agent_api_history",
  });

  assert.equal(
    ledger.getBoundary("agent-1", "#general"),
    undefined,
    "regression catch: server/history visibility must not advance model-seen high-water boundary",
  );
  assert.equal(ledger.getMessageIdSet("agent-1", "#general")?.has("m-50"), true);
  assert.equal(ledger.isModelSeen("agent-1", "#general", { seq: 49, message_id: "m-49" }), false);
  assert.equal(ledger.isModelSeen("agent-1", "#general", { message_id: "m-50" }), true);
});

test("AgentVisibleDeliveryLedger proof-of-catch: explicit target mismatch is rejected", () => {
  const ledger = new AgentVisibleDeliveryLedger();

  assert.throws(
    () =>
      ledger.recordConsumed("agent-1", {
        target: "#private",
        messages: [{ seq: 7, message_id: "m-7", channel_type: "channel", channel_name: "general" }],
        source: "spawn_wake_message",
      }),
    /target mismatch/,
  );
  assert.equal(ledger.hasAgentState("agent-1"), false, "rejected visibility projection must not enter ledger state");
});

test("AgentVisibleDeliveryLedger keeps thread and parent channel targets isolated", () => {
  const ledger = new AgentVisibleDeliveryLedger();

  const consumed = ledger.recordConsumed("agent-1", {
    messages: [{
      seq: 70,
      message_id: "thread-70",
      channel_type: "thread",
      channel_name: "abcdef123456",
      parent_channel_name: "general",
      parent_channel_type: "channel",
    }],
    source: "spawn_wake_message",
  });

  assert.ok(consumed);
  assert.equal(ledger.getBoundary("agent-1", "#general"), undefined);
  assert.equal(ledger.getBoundary("agent-1", "#general:abcdef12"), undefined);
  assert.equal(consumed.shouldSuppress(pendingMessage({
    channel_id: "parent",
    channel_name: "general",
    channel_type: "channel",
    message_id: "thread-70",
    seq: 70,
  })), false);
  assert.equal(consumed.shouldSuppress(pendingMessage({
    channel_id: "thread",
    channel_name: "abcdef123456",
    channel_type: "thread",
    parent_channel_name: "general",
    parent_channel_type: "channel",
    message_id: "thread-70",
    seq: 70,
  })), true);
});

function eventMessage(id = "12345678-0000-4000-8000-000000000000"): AgentMessage {
  return pendingMessage({
    channel_type: "dm", channel_name: "third-party-agent-events:agent-1",
    message_id: id, seq: 42,
    third_party_event: {
      id, kind: "event", client_id: "app", client_name: "App",
      payload_hash: "a".repeat(64), payload: {}, expires_at: "2026-09-24T00:00:00Z",
      source: { client_id: "app", client_name: "App", oauth_client_id: "app-row", resource: "agent-inbound" },
    },
  });
}

for (const explicit of [false, true]) {
  test(`third-party event consumption uses the visible event scope (explicit=${explicit})`, () => {
    const ledger = new AgentVisibleDeliveryLedger();
    const message = eventMessage();
    const target = "agent-event:12345678";
    const consumed = ledger.recordConsumed("agent-1", {
      ...(explicit ? { target } : {}), messages: [message], source: "agent_api_history",
    });
    assert.ok(consumed);
    assert.deepEqual(consumed.targets, [target]);
    assert.equal(ledger.isModelSeen("agent-1", target, message), true);
    assert.equal(ledger.getBoundary("agent-1", target), undefined);
    assert.equal(ledger.isModelSeen("agent-1", target, { message_id: "unseen", seq: 41 }), false);
    assert.equal(ledger.isModelSeen("agent-1", "dm:@third-party-agent-events:agent-1", message), false);
    assert.equal(consumed.shouldSuppress(message), true);
    assert.equal(consumed.shouldSuppress(eventMessage("87654321-0000-4000-8000-000000000000")), false);
    assert.equal(consumed.shouldSuppress({ ...message, third_party_event: undefined }), false);
  });
}

test("third-party event identity rejects another explicit target even without channel metadata, atomically", () => {
  const ledger = new AgentVisibleDeliveryLedger();
  const message = { ...eventMessage(), channel_type: undefined, channel_name: undefined };
  assert.throws(() => ledger.recordConsumed("agent-1", {
    target: "agent-event:87654321",
    messages: [{ id: "otherwise-valid" }, message], source: "agent_api_history",
  }), /target mismatch/);
  assert.equal(ledger.hasAgentState("agent-1"), false);
});


test("full event target rejects a different UUID with the same short prefix before writing", () => {
  const ledger = new AgentVisibleDeliveryLedger();
  assert.throws(() => ledger.recordConsumed("agent-1", {
    target: "agent-event:12345678-0000-4000-8000-000000000001",
    messages: [eventMessage()], source: "agent_api_history",
  }), /target mismatch/);
  assert.equal(ledger.hasAgentState("agent-1"), false);
});

test("DM legacy history consumption requires authorized scope and exact returned identity", () => {
  const agentId = "11111111-1111-4111-8111-111111111111";
  const channelId = "22222222-2222-4222-8222-222222222222";
  const target = "dm:@peer";
  const pending = pendingMessage({
    channel_id: channelId,
    channel_type: "dm",
    channel_name: "self",
    message_id: "old-dm-message",
    seq: 9,
  });
  const input = {
    target,
    source: "agent_api_history",
    messages: [
      {
        id: "old-dm-message",
        seq: 9,
        channel_id: channelId,
        channel_type: "dm",
        channel_name: "peer",
      },
    ],
    historyScope: {
      agent_id: agentId,
      channel_id: channelId,
      channel_type: "dm",
      target,
    },
  };
  const ledger = new AgentVisibleDeliveryLedger();
  const consumed = ledger.recordConsumed(agentId, input as any)!;
  assert.equal(consumed.shouldSuppress(pending), true);
  assert.equal(
    consumed.shouldSuppress({ ...pending, message_id: "unseen", seq: 8 }),
    false,
  );
  assert.equal(
    consumed.shouldSuppress({
      ...pending,
      message_id: "same-seq-different-id",
    }),
    false,
  );
  assert.equal(
    consumed.shouldSuppress({ ...pending, channel_id: "different-channel" }),
    false,
  );
  assert.equal(
    consumed.shouldSuppress({ ...pending, channel_id: undefined } as any),
    false,
  );
  assert.equal(ledger.getBoundary(agentId, target), undefined);
  for (const broken of [
    { ...input, historyScope: undefined },
    { ...input, source: "agent_api_events_server" },
    {
      ...input,
      historyScope: { ...input.historyScope, agent_id: "different-agent" },
    },
    { ...input, historyScope: { ...input.historyScope, target: "dm:@other" } },
    {
      ...input,
      messages: [{ ...input.messages[0], channel_id: "different-channel" }],
    },
  ])
    assert.equal(
      new AgentVisibleDeliveryLedger()
        .recordConsumed(agentId, broken as any)!
        .shouldSuppress(pending),
      false,
    );
  assert.equal(
    consumed.shouldSuppress({
      ...pending,
      channel_name: "peer",
      channel_id: "different-channel",
    }),
    false,
  );
});

test("DM thread legacy correction is channel-bound, exact-ID-only and rejects parent/channel substitutions", () => {
  const agentId = "11111111-1111-4111-8111-111111111111";
  const channelId = "22222222-2222-4222-8222-222222222222";
  const target = "dm:@peer:abcdef12";
  const ledger = new AgentVisibleDeliveryLedger();
  const consumed = ledger.recordConsumed(agentId, {
    target,
    source: "agent_api_history",
    historyScope: {
      agent_id: agentId,
      channel_id: channelId,
      channel_type: "thread",
      target,
    },
    messages: [
      {
        id: "thread-shown",
        seq: 90,
        channel_id: channelId,
        channel_type: "thread",
        channel_name: "abcdef12",
        parent_channel_type: "dm",
        parent_channel_name: "peer",
      },
    ],
  })!;
  const stale = pendingMessage({
    message_id: "thread-shown",
    seq: 90,
    channel_id: channelId,
    channel_type: "thread",
    channel_name: "abcdef12",
    parent_channel_type: "dm",
    parent_channel_name: "self",
  });
  assert.equal(consumed.shouldSuppress(stale), true);
  assert.equal(
    consumed.shouldSuppress({ ...stale, message_id: "not-returned" }),
    false,
  );
  assert.equal(
    consumed.shouldSuppress({ ...stale, parent_channel_type: "channel" }),
    false,
  );
  assert.equal(
    consumed.shouldSuppress({ ...stale, channel_id: "different-thread" }),
    false,
  );
  assert.equal(
    consumed.shouldSuppress({
      ...stale,
      channel_name: "abcdef12",
      parent_channel_name: "peer",
      channel_id: "different-thread",
    }),
    false,
  );
  assert.equal(ledger.getBoundary(agentId, target), undefined);
});

// task #360: exact model-seen seqs are kept per target (never advancing the
// boundary) so the send preflight can tell the Server exactly which rows
// above the boundary the model has already seen.
test("AgentVisibleDeliveryLedger keeps exact seen seqs per target without advancing the boundary", () => {
  const ledger = new AgentVisibleDeliveryLedger();
  ledger.recordConsumed("agent-1", {
    messages: [
      { seq: 120, message_id: "m-120", channel_type: "channel", channel_name: "general" },
      { seq: 105, message_id: "m-105", channel_type: "channel", channel_name: "general" },
    ],
    source: "stdin_idle_delivery",
  });
  assert.equal(ledger.getBoundary("agent-1", "#general"), undefined);
  assert.deepEqual(ledger.getExactSeenSeqs("agent-1", "#general"), [105, 120]);
  assert.deepEqual(ledger.getExactSeenSeqs("agent-1", "#other"), []);
  ledger.clearAgent("agent-1");
  assert.deepEqual(ledger.getExactSeenSeqs("agent-1", "#general"), []);
});

test("AgentVisibleDeliveryLedger caps exact seen seqs per target, keeping the newest", async () => {
  const { MAX_EXACT_SEEN_SEQS_PER_TARGET } = await import("./agentVisibleDeliveryLedger");
  const ledger = new AgentVisibleDeliveryLedger();
  const total = MAX_EXACT_SEEN_SEQS_PER_TARGET + 10;
  ledger.recordConsumed("agent-1", {
    messages: Array.from({ length: total }, (_, i) => ({ seq: i + 1, message_id: `m-${i + 1}`, channel_type: "channel", channel_name: "general" })),
    source: "agent_api_events_local",
  });
  const seqs = ledger.getExactSeenSeqs("agent-1", "#general");
  assert.equal(seqs.length, MAX_EXACT_SEEN_SEQS_PER_TARGET);
  assert.equal(seqs[0], 11);
  assert.equal(seqs.at(-1), total);
});
