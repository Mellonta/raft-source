import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { APP_AGENT_REMINDER_WRITE_GROUP, currentDate } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import {
  agentPrivateSurfaces,
  agents,
  appAgentMessages,
  channelAgents,
  channels,
  messages,
} from "../db/schema";
import type { AgentOrchestrator } from "./agentOrchestrator";
import type { VerifiedAppInstallationCredential } from "./appInstallationCredentialService";
import { broadcastSystemMessage, recordInboxFactsForPersistedMessages } from "./messageService";
import { isApprovedOfficialAppClient } from "./officialAppAutoInstallService";
import { AGENT_REMINDER_SYSTEM_SUBTYPE } from "./agentPrivateSurfaces";

type RaceHooks = { beforeSurfaceInsert?: () => Promise<void>; beforeLedgerInsert?: () => Promise<void> };
let raceHooksForTests: RaceHooks = {};

/** Test-only: park writers at the two race points to force real concurrency. */
export function __setAppAgentReminderRaceHooksForTests(hooks: RaceHooks): void {
  if (process.env.NODE_ENV !== "test") throw new Error("App agent reminder race hooks are test-only");
  raceHooksForTests = hooks;
}

export class AppAgentReminderMessageError extends Error {
  constructor(readonly status: 403 | 404, message: string) {
    super(message);
    this.name = "AppAgentReminderMessageError";
  }
}

/**
 * Find or create the agent's reminder DM. Concurrent first writes race on the
 * (agent_id, kind) key: the loser drops the channel it made and uses the
 * winner's.
 */
async function findOrCreateRemindersSurface(
  tx: DatabaseExecutor,
  agent: { id: string; serverId: string },
  now: Date,
): Promise<typeof channels.$inferSelect> {
  const select = async () => {
    const [row] = await tx.select({ channel: channels })
      .from(agentPrivateSurfaces)
      .innerJoin(channels, eq(channels.id, agentPrivateSurfaces.channelId))
      .where(and(
        eq(agentPrivateSurfaces.agentId, agent.id),
        eq(agentPrivateSurfaces.kind, "reminders"),
      ))
      .limit(1);
    return row?.channel ?? null;
  };
  const existing = await select();
  if (existing && !existing.deletedAt) return existing;
  if (existing) {
    // A soft-deleted surface must not block reminders forever: drop the stale
    // pointer and create a fresh conversation below.
    await tx.delete(agentPrivateSurfaces).where(and(
      eq(agentPrivateSurfaces.agentId, agent.id),
      eq(agentPrivateSurfaces.kind, "reminders"),
    ));
  }

  const channelId = randomUUID();
  await tx.insert(channels).values({
    id: channelId,
    serverId: agent.serverId,
    name: `agent-reminders-${agent.id}`,
    description: "Private agent reminder conversation",
    type: "dm",
    createdAt: now,
  });
  // read-position: new conversation, no history before this join (no row = position 0)
  await tx.insert(channelAgents).values({ channelId, agentId: agent.id, addedAt: now });
  await raceHooksForTests.beforeSurfaceInsert?.();
  const [inserted] = await tx.insert(agentPrivateSurfaces).values({
    agentId: agent.id,
    kind: "reminders",
    serverId: agent.serverId,
    channelId,
    createdAt: now,
  }).onConflictDoNothing().returning();
  if (inserted) {
    const [channel] = await tx.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    return channel;
  }
  await tx.delete(channelAgents).where(eq(channelAgents.channelId, channelId));
  await tx.delete(channels).where(eq(channels.id, channelId));
  const winner = await select();
  if (!winner) throw new Error("AGENT_REMINDERS_SURFACE_CREATE_FAILED");
  return winner;
}

/** Same audience rule as migration receipts: exactly the owning agent, no humans. */
async function assertAgentOnlyAudience(
  tx: DatabaseExecutor,
  channel: typeof channels.$inferSelect,
  agent: { id: string; serverId: string },
) {
  if (channel.type !== "dm" || channel.deletedAt || channel.serverId !== agent.serverId) {
    console.error("[app-agent-reminder] surface invariant violated", { agentId: agent.id, channelId: channel.id, reason: "SURFACE_INVALID" });
    throw new Error("AGENT_REMINDERS_SURFACE_INVALID");
  }
  const [shape] = await tx.select({
    agentCount: sql<number>`(SELECT count(*)::int FROM channel_agents WHERE channel_id = ${channel.id})`,
    exactAgentCount: sql<number>`(SELECT count(*)::int FROM channel_agents WHERE channel_id = ${channel.id} AND agent_id = ${agent.id})`,
    humanCount: sql<number>`(SELECT count(*)::int FROM channel_humans WHERE channel_id = ${channel.id})`,
    identityCount: sql<number>`(SELECT count(*)::int FROM dm_channel_identities WHERE channel_id = ${channel.id})`,
  }).from(channels).where(eq(channels.id, channel.id)).limit(1);
  if (
    !shape
    || shape.agentCount !== 1
    || shape.exactAgentCount !== 1
    || shape.humanCount !== 0
    || shape.identityCount !== 0
  ) {
    console.error("[app-agent-reminder] surface invariant violated", { agentId: agent.id, channelId: channel.id, reason: "AUDIENCE_INVALID", shape });
    throw new Error("AGENT_REMINDERS_SURFACE_AUDIENCE_INVALID");
  }
}

export type AppAgentReminderWriteResult = {
  messageId: string;
  created: boolean;
  channelId: string;
  agentId: string;
  /** Present only when this call created the message. */
  persistedMessage?: typeof messages.$inferSelect;
};

class IdempotencyReplay extends Error {}

/**
 * Write one reminder message into the agent's private `dm:@reminders`
 * conversation for an official app installation holding
 * `agent_reminder_write`. Idempotent per (client, agent, idempotency key).
 */
export async function writeAppAgentReminderMessage(input: {
  credential: VerifiedAppInstallationCredential;
  agentId: string;
  idempotencyKey: string;
  text: string;
}): Promise<AppAgentReminderWriteResult> {
  const { credential } = input;
  if (!credential.groups.includes(APP_AGENT_REMINDER_WRITE_GROUP)) {
    throw new AppAgentReminderMessageError(403, `Installation lacks the ${APP_AGENT_REMINDER_WRITE_GROUP} group`);
  }
  const db = getDb();
  const readReplay = async (executor: DatabaseExecutor) => {
    const [row] = await executor.select({ messageId: appAgentMessages.messageId, channelId: messages.channelId })
      .from(appAgentMessages)
      .innerJoin(messages, eq(messages.id, appAgentMessages.messageId))
      .where(and(
        eq(appAgentMessages.clientId, credential.clientId),
        eq(appAgentMessages.agentId, input.agentId),
        eq(appAgentMessages.idempotencyKey, input.idempotencyKey),
      ))
      .limit(1);
    if (!row) return null;
    return { messageId: row.messageId, created: false, channelId: row.channelId, agentId: input.agentId };
  };

  try {
    return await db.transaction(async (tx) => {
      if (!await isApprovedOfficialAppClient(credential.clientId, tx)) {
        throw new AppAgentReminderMessageError(403, "Only official apps may write agent reminder messages");
      }
      const [agent] = await tx.select({ id: agents.id, serverId: agents.serverId })
        .from(agents)
        .where(and(
          eq(agents.id, input.agentId),
          eq(agents.serverId, credential.serverId),
          isNull(agents.deletedAt),
        ))
        .limit(1);
      if (!agent) throw new AppAgentReminderMessageError(404, "Agent not found");

      // A repeated key returns the first message even if `text` differs: the
      // key names one occurrence, and reminder-app rebuilds the same text for
      // it on every retry.
      const replay = await readReplay(tx);
      if (replay) return replay;

      const now = currentDate();
      const channel = await findOrCreateRemindersSurface(tx, agent, now);
      await assertAgentOnlyAudience(tx, channel, agent);

      const [message] = await tx.insert(messages).values({
        id: randomUUID(),
        channelId: channel.id,
        senderType: "user",
        senderId: "system",
        messageType: "system",
        content: input.text,
        searchText: input.text,
        // notify-exclude: the agent IS the intended reader and must see this
        // unread, so no causalActor.
        systemSubtype: AGENT_REMINDER_SYSTEM_SUBTYPE,
        createdAt: now,
        updatedAt: now,
      }).returning();
      await recordInboxFactsForPersistedMessages([message], {
        inboxFactPolicy: {
          mode: "record",
          producer: "app.agent_reminder",
          reason: "A due reminder is durable activity for its agent",
        },
        executor: tx,
        channel,
      });
      await raceHooksForTests.beforeLedgerInsert?.();
      const [ledger] = await tx.insert(appAgentMessages).values({
        clientId: credential.clientId,
        agentId: agent.id,
        idempotencyKey: input.idempotencyKey,
        messageId: message.id,
        createdAt: now,
      }).onConflictDoNothing().returning();
      // A concurrent request with the same key committed first: discard ours.
      if (!ledger) throw new IdempotencyReplay();
      return { messageId: message.id, created: true, channelId: channel.id, agentId: agent.id, persistedMessage: message };
    });
  } catch (error) {
    if (!(error instanceof IdempotencyReplay)) throw error;
    const replay = await readReplay(db);
    if (!replay) throw new Error("APP_AGENT_MESSAGE_REPLAY_MISSING");
    return replay;
  }
}

/**
 * Nudge the agent about a committed reminder. The message is already durable
 * and unread, so a failure here never fails the write.
 */
export async function deliverAppAgentReminderMessage(input: {
  io: SocketServer | null;
  orchestrator: AgentOrchestrator | null;
  result: AppAgentReminderWriteResult;
}): Promise<"accepted" | "failed"> {
  const message = input.result.persistedMessage;
  if (!message) return "accepted";
  if (!input.io || !input.orchestrator) return "failed";
  try {
    await broadcastSystemMessage(input.io, input.orchestrator, message.channelId, message.content, {
      inboxFactPolicy: {
        mode: "record",
        producer: "app.agent_reminder",
        reason: "Durable facts were committed with the reminder message",
      },
      persistedMessage: message,
      targetAgentIds: [input.result.agentId],
      awaitAgentDelivery: true,
      bypassAgentMute: true,
      agentDeliveryOptions: { intrinsic: true, requireQueueReceipt: true },
    });
    return "accepted";
  } catch (error) {
    console.error("[AppAgentReminder] delivery failed:", error instanceof Error ? error.message : String(error));
    return "failed";
  }
}
