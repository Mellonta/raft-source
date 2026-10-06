import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { getDb } from "../db/index";
import { agents, channels, messageMentions, messages, servers, users } from "../db/schema";
import { AgentOrchestrator } from "./agentOrchestrator";
import {
  ensureMentionDeliveryOccurrences,
  getMentionDeliveryOccurrence,
  MENTION_DELIVERY_MAX_RECOVERY_ROUNDS,
  recordMentionDeliveryAck,
  recordMentionDeliveryDaemonTransition,
  recordMentionDeliveryServerDecision,
} from "./mentionDeliveryOccurrenceService";

/**
 * task #285, orchestrator seam. Recovery runs on every agent:session persist (each session_init
 * and turn_end) and every machine ready. These tests drive the real recovery path and the real
 * ack-retry bookkeeping; only the machine socket and the local inbox enqueue are replaced.
 *
 * - A daemon that never terminalises a held occurrence (daemon 1.0.26 in the field) must stop being
 *   re-sent once its recovery budget is spent. This is the only thing that stops the loop for
 *   daemons without the turn-end settlement.
 * - A healthy occurrence whose ack-retry cycle is still running must not spend budget on every
 *   session event, or it would be terminalised before it drains.
 */

const at = new Date("2026-09-15T00:00:00.000Z");

afterEach(async () => {
  await closeTestDatabase();
});

class SocketStubOrchestrator extends AgentOrchestrator {
  sends = 0;
  enqueues = 0;

  override hasMachineLocally(): boolean {
    return true;
  }

  protected override async sendToMachine(): Promise<boolean> {
    this.sends += 1;
    return true;
  }

  protected override async enqueueToLocalInboxIfStillActive(
    ..._args: Parameters<AgentOrchestrator["enqueueToLocalInboxIfStillActive"]>
  ): Promise<boolean> {
    this.enqueues += 1;
    return true;
  }

  recover(agentId: string, identity: { machineId: string; launchId: string; sessionId: string }): Promise<void> {
    return (this as any).recoverDurableMentionDeliveriesForAgent(agentId, identity);
  }

  /** The machine went offline during the cycle: the ack-retry entry stays in the map, parked. */
  parkCycle(agentId: string): void {
    const pendingAcks = (this as any).pendingAgentDeliveryAcks as Map<string, { msg: { agentId: string } }>;
    const entries = [...pendingAcks.values()].filter((pending) => pending.msg.agentId === agentId);
    assert.equal(entries.length, 1, "precondition: exactly one ack-retry entry to park");
    (this as any).parkPendingAgentDeliveryAck(entries[0], "machine_offline");
  }

  /** The ack-retry cycle ended without an ACK (24 attempts exhausted): its in-memory entry is gone. */
  endCycleWithoutAck(agentId: string): void {
    (this as any).clearPendingAgentDeliveryAcksForAgent(agentId);
  }
}

async function seedDaemonHeldOccurrence() {
  await openTestDatabase("pglite://");
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `recovery-${suffix}@raft.test`, name: `owner-${suffix}`, passwordHash: "hash", emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: `Recovery ${suffix.slice(0, 8)}`, slug: `recovery-${suffix}`, ownerId: owner.id,
  }).returning();
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: `agent-${suffix}`, runtime: "codex" }).returning();
  const [channel] = await db.insert(channels).values({ serverId: server.id, name: `channel-${suffix}`, type: "channel" }).returning();
  const [message] = await db.insert(messages).values({
    channelId: channel.id, senderType: "user", senderId: owner.id, content: `hello @${agent.name}`, seq: 1,
  }).returning();
  const [mention] = await db.insert(messageMentions).values({
    messageId: message.id, messageSeq: 1, serverId: server.id, channelId: channel.id,
    targetType: "agent", targetId: agent.id, handleAtSendTime: agent.name,
  }).returning();
  const payload = {
    channel_id: channel.id, channel_name: channel.name, channel_type: "channel" as const,
    sender_id: owner.id, sender_name: owner.name, sender_type: "human" as const,
    content: message.content, timestamp: at.toISOString(), message_id: message.id, seq: 1,
  };
  const identity = { machineId: "00000000-0000-4000-8000-000000000005", launchId: "launch-1", sessionId: "session-1" };
  await ensureMentionDeliveryOccurrences([{
    occurrenceId: mention.id, messageId: message.id, serverId: server.id, agentId: agent.id, deliveryPayload: payload,
  }]);
  await recordMentionDeliveryServerDecision({ occurrenceId: mention.id, payload, identity });
  await recordMentionDeliveryDaemonTransition({
    occurrenceId: mention.id, agentId: agent.id, messageId: message.id, identity, stage: "daemon_received",
  });
  const pending = await recordMentionDeliveryDaemonTransition({
    occurrenceId: mention.id, agentId: agent.id, messageId: message.id, identity, stage: "daemon_pending",
  });
  assert.ok(pending, "fixture must reach daemon_pending");
  return { agent, message, mention, identity };
}

test("task #285: a never-terminalised occurrence stops being re-sent once each budgeted ack-retry cycle has ended", async () => {
  const { agent, message, identity } = await seedDaemonHeldOccurrence();
  const orch = new SocketStubOrchestrator();
  try {
    for (let cycle = 1; cycle <= MENTION_DELIVERY_MAX_RECOVERY_ROUNDS; cycle += 1) {
      await orch.recover(agent.id, identity);
      assert.equal(orch.sends, cycle, `cycle ${cycle} is within the budget and re-sends`);
      orch.endCycleWithoutAck(agent.id);
    }

    await orch.recover(agent.id, identity);
    assert.equal(orch.sends, MENTION_DELIVERY_MAX_RECOVERY_ROUNDS, "past the budget, recovery must not send again");
    assert.equal(orch.enqueues, MENTION_DELIVERY_MAX_RECOVERY_ROUNDS);
    const row = await getMentionDeliveryOccurrence(message.id, agent.id);
    assert.equal(row?.state, "terminal_error");
    assert.equal(row?.terminalErrorCode, "REDELIVERY_EXHAUSTED");

    await orch.recover(agent.id, identity);
    assert.equal(orch.sends, MENTION_DELIVERY_MAX_RECOVERY_ROUNDS, "and it stays out of later recoveries");
  } finally {
    orch.endCycleWithoutAck(agent.id);
  }
});

test("task #285: session events during one running ack-retry cycle spend one round, so a healthy occurrence still drains and ACKs", async () => {
  const { agent, message, mention, identity } = await seedDaemonHeldOccurrence();
  const orch = new SocketStubOrchestrator();
  try {
    // One cycle, many triggers: session_init, then several turn_end persists before the daemon drains.
    const triggers = MENTION_DELIVERY_MAX_RECOVERY_ROUNDS + 3;
    for (let trigger = 1; trigger <= triggers; trigger += 1) {
      await orch.recover(agent.id, identity);
    }
    const during = await getMentionDeliveryOccurrence(message.id, agent.id);
    assert.equal(during?.terminalErrorAt, null, "session events inside one cycle must not terminalise a healthy occurrence");
    assert.equal(during?.recoveryCount, 1, "one running cycle is one round");
    assert.equal(orch.sends, triggers, "every trigger still re-sent, so more triggers than the budget really ran");

    await recordMentionDeliveryDaemonTransition({
      occurrenceId: mention.id, agentId: agent.id, messageId: message.id, identity, stage: "daemon_drained",
    });
    const acked = await recordMentionDeliveryAck({ occurrenceId: mention.id, agentId: agent.id, messageId: message.id, identity });
    assert.ok(acked, "the healthy occurrence can still ACK");
    assert.equal((await getMentionDeliveryOccurrence(message.id, agent.id))?.state, "acked");
  } finally {
    orch.endCycleWithoutAck(agent.id);
  }
});

test("task #285: a parked ack-retry cycle is not in flight, so triggers after an offline park still spend budget and stop", async () => {
  const { agent, message, identity } = await seedDaemonHeldOccurrence();
  const orch = new SocketStubOrchestrator();
  try {
    await orch.recover(agent.id, identity);
    orch.parkCycle(agent.id);
    // The parked entry never exhausts and is never cleared: each later trigger must count.
    for (let trigger = 2; trigger <= MENTION_DELIVERY_MAX_RECOVERY_ROUNDS + 3; trigger += 1) {
      await orch.recover(agent.id, identity);
    }
    const row = await getMentionDeliveryOccurrence(message.id, agent.id);
    assert.equal(row?.terminalErrorCode, "REDELIVERY_EXHAUSTED", "a parked cycle must not shield the occurrence from the budget");
    assert.equal(orch.sends, MENTION_DELIVERY_MAX_RECOVERY_ROUNDS, "sends stop once the budget is spent");
  } finally {
    orch.endCycleWithoutAck(agent.id);
  }
});
