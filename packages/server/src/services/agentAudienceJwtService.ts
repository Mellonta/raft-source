import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { currentDate } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, oauthClients, oauthGrants, oauthAgentAutoGrantBlocks, serverAgentMembers, servers } from "../db/schema";
import { oidcIssuer, signAgentAccessJwt } from "./oidcService";
import { recordIntegrationAuditEvent } from "./integrationAuditService";

export class AgentAudienceJwtError extends Error {
  constructor(readonly code: "AGENT_JWT_DISABLED" | "AGENT_JWT_NOT_AUTHORIZED" | "AGENT_JWT_CONFIGURATION_INVALID") {
    super(code);
  }
}

const policySchema = z.array(z.object({
  serverId: z.string().uuid(),
  clientId: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
}).strict()).max(100);
const scopes = ["openid", "profile"];

// Operator opt-in is bound to a registered Server-local client, never a URL
// or an audience supplied independently of that client. Default: disabled.
function requireEnabledAudience(serverId: string, clientId: string): void {
  const raw = process.env.RAFT_AGENT_JWT_AUDIENCES?.trim();
  if (!raw) throw new AgentAudienceJwtError("AGENT_JWT_DISABLED");
  let policy: z.infer<typeof policySchema>;
  try {
    policy = policySchema.parse(JSON.parse(raw));
  } catch {
    throw new AgentAudienceJwtError("AGENT_JWT_CONFIGURATION_INVALID");
  }
  if (!policy.some((entry) => entry.serverId === serverId && entry.clientId === clientId)) {
    throw new AgentAudienceJwtError("AGENT_JWT_DISABLED");
  }
}

export async function issueAgentAudienceJwt(input: { serverId: string; agentId: string; service: string }) {
  requireEnabledAudience(input.serverId, input.service);
  return getDb().transaction(async (tx) => {
    const [server] = await tx.select({ id: servers.id, slug: servers.slug }).from(servers).where(and(
      eq(servers.id, input.serverId), isNull(servers.deletedAt),
    )).for("share");
    const [agent] = await tx.select({ id: agents.id, name: agents.name, displayName: agents.displayName, status: agents.status }).from(agents).where(and(
      eq(agents.id, input.agentId), eq(agents.serverId, input.serverId), isNull(agents.deletedAt),
    )).for("share");
    const [membership] = await tx.select({ role: serverAgentMembers.role }).from(serverAgentMembers).where(and(
      eq(serverAgentMembers.serverId, input.serverId), eq(serverAgentMembers.agentId, input.agentId),
    )).for("share");
    if (!server || !agent || agent.status === "stopped" || !membership) {
      throw new AgentAudienceJwtError("AGENT_JWT_NOT_AUTHORIZED");
    }
    // Serialize first-use grant creation and client disable/scope contraction.
    // Marketplace installs are deliberately outside the v1 issuance surface.
    const [client] = await tx.select({ id: oauthClients.id, clientId: oauthClients.clientId, allowedScopes: oauthClients.allowedScopes, createdByUserId: oauthClients.createdByUserId }).from(oauthClients).where(and(
      eq(oauthClients.serverId, server.id), eq(oauthClients.clientId, input.service),
      eq(oauthClients.appType, "server_local"), eq(oauthClients.enabled, true),
    )).for("update");
    if (!client || !scopes.every((scope) => client.allowedScopes?.includes(scope))) {
      throw new AgentAudienceJwtError("AGENT_JWT_NOT_AUTHORIZED");
    }
    const grants = await tx.select({ id: oauthGrants.id, scopes: oauthGrants.scopes, revokedAt: oauthGrants.revokedAt }).from(oauthGrants).where(and(
      eq(oauthGrants.serverId, server.id), eq(oauthGrants.agentId, agent.id), eq(oauthGrants.clientId, client.id),
    )).for("update");
    let grant = grants.find((candidate) => candidate.revokedAt === null && scopes.every((scope) => candidate.scopes.includes(scope)));
    if (!grant) {
      // Never silently resurrect explicitly revoked authority. A
      // person must explicitly regrant access before a later retry.
      const [blocked] = await tx.select({ agentId: oauthAgentAutoGrantBlocks.agentId })
        .from(oauthAgentAutoGrantBlocks).where(and(
          eq(oauthAgentAutoGrantBlocks.agentId, agent.id),
          eq(oauthAgentAutoGrantBlocks.clientId, client.id),
          eq(oauthAgentAutoGrantBlocks.serverId, server.id),
        )).limit(1).for("share");
      if (blocked || grants.some((candidate) => candidate.revokedAt !== null)) {
        throw new AgentAudienceJwtError("AGENT_JWT_NOT_AUTHORIZED");
      }
      // Existing Agent Login auto-grants Server-local clients. This does the
      // same without producing an unused authorization code or access token.
      [grant] = await tx.insert(oauthGrants).values({
        serverId: server.id, agentId: agent.id, clientId: client.id,
        scopes, grantedByUserId: client.createdByUserId, grantSource: "agent_login",
      }).returning();
    }
    const now = currentDate();
    const jti = randomUUID();
    const token = signAgentAccessJwt({
      issuer: oidcIssuer(undefined, server.slug),
      agentId: agent.id, clientId: client.clientId, serverId: server.id,
      serverSlug: server.slug, serverRole: membership.role,
      agentName: agent.name, displayName: agent.displayName ?? agent.name,
      jti, now,
    });
    const expiresAt = new Date((Math.floor(now.getTime() / 1000) + 300) * 1000).toISOString();
    // The ambient transaction keeps the audit and first-use grant atomic.
    // Fail closed if the audit cannot be persisted; never store the JWT itself.
    await recordIntegrationAuditEvent({
      serverId: server.id, clientId: client.id,
      eventType: "agent.jwt_issued", outcome: "success", source: "cli",
      actor: { type: "agent", id: agent.id },
      subject: { type: "agent", id: agent.id },
      target: { type: "oauth_grant", id: grant.id },
      metadata: { clientKey: client.clientId, grantId: grant.id, jti, expiresAt },
    });
    return { access_token: token, token_type: "Bearer" as const, audience: client.clientId, expires_in: 300 as const, expires_at: expiresAt };
  });
}
