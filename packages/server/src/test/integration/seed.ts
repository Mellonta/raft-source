import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../../db/index";
import { channels, servers, users } from "../../db/schema";
import { createServer, addMember } from "../../services/serverService";
import { createChannel, addHuman } from "../../services/channelService";
import { createMessage } from "../../services/messageService";
import { fixturePasswordHash } from "./credentials";
import { measureIntegrationPhase } from "./lifecycle";

type Human = typeof users.$inferSelect;
type Server = typeof servers.$inferSelect;
type Channel = typeof channels.$inferSelect;

export function createSeed(db: Database) {
  return {
    human(values: Partial<typeof users.$inferInsert> = {}): Promise<Human> {
      return measureIntegrationPhase("seed", async () => {
        const name = `human-${randomUUID().slice(0, 8)}`;
        const [human] = await db.insert(users).values({
          name,
          email: `${name}@test.invalid`,
          displayName: values.name ?? name,
          passwordHash: await fixturePasswordHash("password123"),
          emailVerified: true,
          profileSetupCompletedAt: new Date(),
          ...values,
        }).returning();
        return human;
      });
    },
    server(input: { owner: Human; members?: Human[]; name?: string; slug?: string }): Promise<Server> {
      return measureIntegrationPhase("seed", async () => {
        const server = await createServer(input.name ?? "Test server", input.slug ?? `server-${randomUUID().slice(0, 8)}`, input.owner.id);
        for (const member of input.members ?? []) await addMember(server.id, member.id);
        return server;
      });
    },
    channel(input: { server: Server; members: Human[]; name?: string; visibility?: "channel" | "private"; archivedAt?: Date }): Promise<Channel> {
      return measureIntegrationPhase("seed", async () => {
        const channel = await createChannel(input.server.id, input.name ?? `channel-${randomUUID().slice(0, 8)}`, undefined, input.visibility);
        for (const member of input.members) await addHuman(channel.id, member.id);
        if (input.archivedAt) {
          const [archived] = await db.update(channels).set({ archivedAt: input.archivedAt }).where(eq(channels.id, channel.id)).returning();
          return archived;
        }
        return channel;
      });
    },
    message(input: { channel: Channel; author: Human; content: string }) {
      return measureIntegrationPhase("seed", () => createMessage(input.channel.id, "user", input.author.id, input.content));
    },
  };
}
