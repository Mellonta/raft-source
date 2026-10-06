import { and, eq, isNull } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agentPrivateSurfaces, channels } from "../db/schema";

// Agent-only private DM surfaces (agent_private_surfaces). Dependency-free so
// channelService and the writers can both use it.

/** The peer name an agent uses for its private reminder conversation: `dm:@reminders`. */
export const AGENT_REMINDERS_DM_PEER = "reminders";
export const AGENT_REMINDERS_DM_TARGET = `dm:@${AGENT_REMINDERS_DM_PEER}`;
export const AGENT_REMINDER_SYSTEM_SUBTYPE = "agent.reminder_due";
export const AGENT_REMINDERS_NOT_SENDABLE_MESSAGE =
  "dm:@reminders is your private reminder conversation; nobody else reads it. Act at the reminder's anchor instead.";

/** The channel id of the agent's private surface of `kind`, or null. */
export async function getAgentPrivateSurfaceChannelId(
  agentId: string,
  kind: "reminders",
  executor: DatabaseExecutor = getDb(),
): Promise<string | null> {
  const [row] = await executor.select({ channelId: agentPrivateSurfaces.channelId })
    .from(agentPrivateSurfaces)
    .innerJoin(channels, eq(channels.id, agentPrivateSurfaces.channelId))
    .where(and(
      eq(agentPrivateSurfaces.agentId, agentId),
      eq(agentPrivateSurfaces.kind, kind),
      isNull(channels.deletedAt),
    ))
    .limit(1);
  return row?.channelId ?? null;
}

/** Whether the channel is any agent's private surface (never agent-sendable). */
export async function isAgentPrivateSurfaceChannel(
  channelId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  const [row] = await executor.select({ channelId: agentPrivateSurfaces.channelId })
    .from(agentPrivateSurfaces)
    .where(eq(agentPrivateSurfaces.channelId, channelId))
    .limit(1);
  return Boolean(row);
}


/** The kind of the agent's own private surface this channel is, or null. */
export async function getAgentPrivateSurfaceKind(
  agentId: string,
  channelId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<"reminders" | null> {
  const [row] = await executor.select({ kind: agentPrivateSurfaces.kind })
    .from(agentPrivateSurfaces)
    .where(and(
      eq(agentPrivateSurfaces.agentId, agentId),
      eq(agentPrivateSurfaces.channelId, channelId),
    ))
    .limit(1);
  return row?.kind ?? null;
}
