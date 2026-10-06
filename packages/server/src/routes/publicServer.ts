import { Router, type Router as ExpressRouter } from "express";
import { kickAppNotificationDelivery } from "../services/appNotificationDeliveryService";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { getDb } from "../db/index";
import { agents, channels, messages, serverMembers, servers, users } from "../db/schema";
import { UUID_RE } from "../lib/messageId";
import { requireAuth, requireVerified } from "../middleware/auth";
import * as channelService from "../services/channelService";
import * as onboardingService from "../services/onboardingService";
import * as serverAgreementService from "../services/serverAgreementService";
import * as serverService from "../services/serverService";
import { isStoredServerScopedAvatarUrl, isStoredUserAvatarUrl } from "../services/avatarService";
import { projectServerPublicProfile } from "../services/serverProfileProjection";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import {
  evaluateFeatureFlag,
  PUBLIC_SERVER_FEATURE_FLAG_KEY,
  SERVER_GUEST_FEATURE_FLAG_KEY,
} from "../services/featureFlagService";
import { sendJsonServerError } from "./errorResponse";

/**
 * Task #70 — the logged-out read surface for a public server.
 *
 * This is deliberately a SEPARATE narrow path rather than letting an anonymous
 * caller through the ordinary authorization chain (@cindyz approved this shape).
 * That chain assumes a principal everywhere — `req.userId!` appears in ~571
 * places and `canUserAccessChannel` in ~59 — so threading "no principal" through
 * it means auditing every one of them. Every widening here has to be written
 * out in this file, where it is visible, instead of arriving as a side effect of
 * someone relaxing a shared helper.
 *
 * Two properties this file exists to guarantee:
 *
 *  1. **Revocation applies on the next request.** Every request re-reads
 *     `publiclyVisible` from the row. There is no cache, anonymous session or
 *     token, so a reader's next list/page request is refused after the toggle
 *     turns off. Content already downloaded by the browser cannot be revoked,
 *     nor can a database query be cancelled after it has passed this check.
 *
 *  2. **Public means public.** The slug is guessable, so this surface must never
 *     be described as "only people with the link". A semi-private mode needs
 *     tokens plus expiry and is separate work.
 */
export const publicServerRouter: ExpressRouter = Router();

// A browser/CDN cache would outlive the database decision and violate the
// next-request revocation contract even if every request handler re-queries it.
publicServerRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

/** The one place that decides a server is readable by anyone. */
async function findPubliclyVisibleServer(slug: string) {
  const [row] = await getDb()
    .select({
      id: servers.id,
      name: servers.name,
      slug: servers.slug,
      avatarUrl: servers.avatarUrl,
      publicGuestJoinEnabled: servers.publicGuestJoinEnabled,
    })
    .from(servers)
    .where(and(
      eq(servers.slug, slug),
      eq(servers.publiclyVisible, true),
      isNull(servers.deletedAt),
    ))
    .limit(1);
  if (!row) return null;
  return {
    ...projectServerPublicProfile(row),
    publicGuestJoinEnabled: row.publicGuestJoinEnabled,
  };
}

/**
 * The channel predicate, spelled out rather than reused.
 *
 * `guestVisible` alone is NOT sufficient: it is also set on channels of other
 * kinds, and an anonymous reader must never reach a private, dm, joint or
 * thread surface. Requiring `type = "channel"` explicitly means a future change
 * to what `guestVisible` means cannot quietly widen the anonymous surface.
 */
function anonymousReadableChannel(serverId: string, channelId?: string) {
  const conditions = [
    eq(channels.serverId, serverId),
    eq(channels.type, "channel"),
    eq(channels.guestVisible, true),
    isNull(channels.deletedAt),
    isNull(channels.archivedAt),
  ];
  if (channelId) conditions.push(eq(channels.id, channelId));
  return and(...conditions);
}

/**
 * Authorize a message-page request in one indexed query. Keeping the server
 * toggle and channel predicate in the same query preserves next-request
 * revocation without adding a separate database round trip to every page.
 */
async function findAnonymousReadableChannel(slug: string, channelId: string) {
  const [row] = await getDb()
    .select({ id: channels.id, serverId: servers.id })
    .from(channels)
    .innerJoin(servers, and(
      eq(servers.id, channels.serverId),
      eq(servers.slug, slug),
      eq(servers.publiclyVisible, true),
      isNull(servers.deletedAt),
    ))
    .where(and(
      eq(channels.id, channelId),
      eq(channels.type, "channel"),
      eq(channels.guestVisible, true),
      isNull(channels.deletedAt),
      isNull(channels.archivedAt),
    ))
    .limit(1);
  return row ?? null;
}

/**
 * Anonymous history is an explicit public projection, not the authenticated
 * message DTO. In particular it excludes actor ids, task/action metadata,
 * mentions, reactions and attachment metadata; widening this response requires
 * an intentional change at this boundary.
 */
async function listPublicMessages(channelId: string, serverId: string, limit: number, beforeMessageId?: string) {
  const conditions = [eq(messages.channelId, channelId)];
  if (beforeMessageId !== undefined) {
    const [cursor] = await getDb()
      .select({ seq: messages.seq })
      .from(messages)
      .where(and(eq(messages.id, beforeMessageId), eq(messages.channelId, channelId)))
      .limit(1);
    if (!cursor) return null;
    conditions.push(lt(messages.seq, cursor.seq));
  }
  const rows = await getDb()
    .select({
      id: messages.id,
      senderType: messages.senderType,
      senderName: sql<string>`CASE
        WHEN ${messages.messageType} = 'system' THEN 'System'
        WHEN ${messages.senderType} = 'user' THEN COALESCE(${users.displayName}, ${users.name}, 'Unknown user')
        WHEN ${messages.senderType} = 'agent' THEN COALESCE(${agents.displayName}, ${agents.name}, 'Unknown agent')
        ELSE 'External'
      END`,
      userAvatarUrl: users.avatarUrl,
      userDescription: users.description,
      agentAvatarUrl: agents.avatarUrl,
      agentDescription: agents.description,
      messageType: messages.messageType,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .leftJoin(users, and(
      eq(messages.senderType, "user"),
      sql`${messages.senderId} = ${users.id}::text`,
    ))
    .leftJoin(agents, and(
      eq(messages.senderType, "agent"),
      sql`${messages.senderId} = ${agents.id}::text`,
      eq(agents.serverId, serverId),
    ))
    .where(and(...conditions))
    .orderBy(desc(messages.seq))
    .limit(limit);
  const summaries = await channelService.getThreadSummariesForParentMessages(rows.map((row) => row.id));
  return rows.reverse().map((row) => ({
    id: row.id,
    senderType: row.senderType,
    sender: {
      displayName: row.senderName,
      // Human uploads are capability URLs served by the public avatar route.
      // Historical third-party profile URLs are deliberately not projected.
      avatarUrl: row.senderType === "user"
        ? (isStoredUserAvatarUrl(row.userAvatarUrl) ? row.userAvatarUrl : null)
        : row.senderType === "agent"
          ? (isStoredServerScopedAvatarUrl(row.agentAvatarUrl, serverId) ? row.agentAvatarUrl : null)
          : null,
      description: row.senderType === "user"
        ? row.userDescription
        : row.senderType === "agent"
          ? row.agentDescription
          : null,
    },
    messageType: row.messageType,
    content: row.content,
    createdAt: row.createdAt,
    threadId: summaries[row.id]?.threadChannelId ?? null,
    replyCount: summaries[row.id]?.replyCount ?? 0,
  }));
}

async function findPublicThread(slug: string, threadChannelId: string) {
  const [thread] = await getDb()
    .select({
      id: channels.id,
      serverId: channels.serverId,
      parentMessageId: channels.parentMessageId,
    })
    .from(channels)
    .where(and(
      eq(channels.id, threadChannelId),
      eq(channels.type, "thread"),
      isNull(channels.deletedAt),
      isNull(channels.archivedAt),
    ))
    .limit(1);
  if (!thread?.parentMessageId) return null;

  const [parent] = await getDb()
    .select({ channelId: messages.channelId })
    .from(messages)
    .where(eq(messages.id, thread.parentMessageId))
    .limit(1);
  if (!parent) return null;

  const readableParent = await findAnonymousReadableChannel(slug, parent.channelId);
  if (!readableParent || readableParent.serverId !== thread.serverId) return null;
  return thread;
}

// GET /api/public/servers/:slug — server card + the channels a stranger may read.
publicServerRouter.get("/servers/:slug", async (req, res) => {
  try {
    const server = await findPubliclyVisibleServer(req.params.slug);
    // 404, not 403: a non-public server must not be distinguishable from one
    // that does not exist, or this endpoint becomes a server-slug oracle.
    if (!server) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const [publicGate, guestGate] = await Promise.all([
      evaluateFeatureFlag({ key: PUBLIC_SERVER_FEATURE_FLAG_KEY, serverId: server.id, platform: "web" }),
      evaluateFeatureFlag({ key: SERVER_GUEST_FEATURE_FLAG_KEY, serverId: server.id, platform: "web" }),
    ]);
    if (!publicGate.enabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const visible = await getDb()
      .select({ id: channels.id, name: channels.name, description: channels.description })
      .from(channels)
      .where(anonymousReadableChannel(server.id))
      .orderBy(channels.name);

    const { publicGuestJoinEnabled, ...publicServer } = server;
    res.json({
      server: publicServer,
      channels: visible,
      canJoinAsGuest: publicGuestJoinEnabled && guestGate.enabled,
    });
  } catch {
    res.status(500).json({ error: "Failed to load public server" });
  }
});

// GET /api/public/servers/:slug/threads/:threadChannelId/messages — replies
// inherit the anonymous-read decision from their ordinary parent channel.
// The thread row alone is never authority: every request rechecks the server
// toggle and the parent's guest-visible ordinary-channel predicate.
publicServerRouter.get("/servers/:slug/threads/:threadChannelId/messages", async (req, res) => {
  try {
    const thread = await findPublicThread(req.params.slug, req.params.threadChannelId);
    if (!thread) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const publicGate = await evaluateFeatureFlag({ key: PUBLIC_SERVER_FEATURE_FLAG_KEY, serverId: thread.serverId, platform: "web" });
    if (!publicGate.enabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 50;
    const rawBefore = typeof req.query.beforeMessageId === "string"
      ? req.query.beforeMessageId
      : undefined;
    const beforeMessageId = rawBefore && UUID_RE.test(rawBefore) ? rawBefore : undefined;
    if (rawBefore !== undefined && beforeMessageId === undefined) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const page = await listPublicMessages(thread.id, thread.serverId, limit, beforeMessageId);
    if (!page) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ messages: page });
  } catch {
    res.status(500).json({ error: "Failed to load public thread" });
  }
});

// POST /api/public/servers/:slug/join-as-guest
//
// Authentication is deliberately attached to this one route rather than the
// router: all GETs above remain the same narrow anonymous projection. The
// caller cannot assert an admission source or role; this endpoint always means
// "public-page self admission" and can only create a Guest membership.
publicServerRouter.post("/servers/:slug/join-as-guest", requireAuth, requireVerified, async (req, res) => {
  try {
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
    if (!slug) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const agreementId = typeof req.body?.agreementId === "string" ? req.body.agreementId : null;
    const result = await getDb().transaction(async (tx) => {
      const [server] = await tx
        .select({
          id: servers.id,
          name: servers.name,
          slug: servers.slug,
          publiclyVisible: servers.publiclyVisible,
          publicGuestJoinEnabled: servers.publicGuestJoinEnabled,
        })
        .from(servers)
        .where(and(eq(servers.slug, slug), isNull(servers.deletedAt)))
        .limit(1)
        .for("update");
      if (!server) return null;

      const publicGate = await evaluateFeatureFlag(
        { key: PUBLIC_SERVER_FEATURE_FLAG_KEY, serverId: server.id, userId: req.userId!, platform: "web" },
        tx,
      );
      const guestGate = await evaluateFeatureFlag(
        { key: SERVER_GUEST_FEATURE_FLAG_KEY, serverId: server.id, userId: req.userId!, platform: "web" },
        tx,
      );
      if (!publicGate.enabled || !guestGate.enabled || !server.publiclyVisible || !server.publicGuestJoinEnabled) {
        return null;
      }

      const [existing] = await tx
        .select({ role: serverMembers.role })
        .from(serverMembers)
        .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, req.userId!)))
        .limit(1);
      if (existing) return { ...server, role: existing.role, joined: false };

      await serverAgreementService.requireSelfServeAgreement(tx, server.id, { agreementId });
      const joined = await serverService.addMember(server.id, req.userId!, "guest", {
        executor: tx,
        agreementAudit: {
          actorUserId: req.userId!,
          source: "join",
          agreementId,
          ipAddress: req.ip ?? null,
          userAgent: req.get("user-agent") ?? null,
        },
      });
      if (!joined) {
        const [raced] = await tx.select({ role: serverMembers.role }).from(serverMembers)
          .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, req.userId!))).limit(1);
        return raced ? { ...server, role: raced.role, joined: false } : null;
      }
      return { ...server, role: "guest" as const, joined: true };
    });

    if (!result) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (result.joined) {
      // Committed: deliver the server.member_added App Notification now.
      kickAppNotificationDelivery();
      const io = req.app.get("io") as SocketServer | undefined;
      const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
      if (io) {
        io.to(`server:${result.id}`).emit("server:member-added", { serverId: result.id, userId: req.userId! });
        if (agentOrchestrator) {
          void onboardingService.triggerNewMemberOnboarding(io, agentOrchestrator, result.id, req.userId!).catch((err: unknown) => {
            console.warn(`[Onboarding] Failed after public Guest join for ${req.userId}: ${err instanceof Error ? err.message : String(err)}`);
          });
          void onboardingService.triggerAllChannelUnlockOnboarding(io, agentOrchestrator, result.id).catch((err: unknown) => {
            console.warn(`[Onboarding] Failed #all unlock after public Guest join for ${req.userId}: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }
    }
    res.json({ serverId: result.id, serverName: result.name, serverSlug: result.slug, role: result.role, joined: result.joined });
  } catch (err: unknown) {
    const agreementResponse = serverAgreementService.agreementErrorResponse(err);
    if (agreementResponse) {
      res.status(agreementResponse.status).json(agreementResponse.body);
      return;
    }
    const message = err instanceof Error ? err.message : "";
    if (message.includes("seat limit") || message.includes("limit reached")) {
      res.status(403).json({ error: message });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to join public server", logPrefix: "Public Guest join error:", err });
  }
});

// GET /api/public/servers/:slug/channels/:channelId/messages
publicServerRouter.get("/servers/:slug/channels/:channelId/messages", async (req, res) => {
  try {
    // Re-resolved on every page request, but as one join rather than a server
    // lookup followed by a channel lookup. See property 1 above.
    const channel = await findAnonymousReadableChannel(req.params.slug, req.params.channelId);
    if (!channel) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const gate = await evaluateFeatureFlag({
      key: PUBLIC_SERVER_FEATURE_FLAG_KEY,
      serverId: channel.serverId,
      platform: "web",
    });
    if (!gate.enabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 50;
    const rawBefore = typeof req.query.beforeMessageId === "string"
      ? req.query.beforeMessageId
      : undefined;
    const beforeMessageId = rawBefore && UUID_RE.test(rawBefore) ? rawBefore : undefined;
    if (rawBefore !== undefined && beforeMessageId === undefined) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const rows = await listPublicMessages(channel.id, channel.serverId, limit, beforeMessageId);
    if (!rows) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ messages: rows });
  } catch {
    res.status(500).json({ error: "Failed to load public channel messages" });
  }
});
