import type { DatabaseExecutor } from "../db/index";
import { jointChannels, jointChannelServers } from "../db/schema";
import { isActionCardReadOnlyInServer } from "@botiverse/raft-shared";
import { publishChannelUpdate } from "./channelRealtimeEvents";
import { socketUserServerRoom } from "../socket/platformScope";
// Operation cards (B-mode approval replacement).
//
// `prepareActionCard` is called by an agent: it posts a system message in
// the target channel whose `actionMetadata.kind === "action-card"` carries
// the prepared action. The card is the entire body of that message (no extra
// text content rendered). Anyone with read access to the channel can see the
// card; only humans with the relevant authority for that action can click
// "execute" via `executeActionCard`.
//
// `executeActionCard` is called by a logged-in human. It atomically:
//   1. Reads the message + parses metadata
//   2. Verifies the caller is allowed to perform the underlying action
//   3. Performs the action under the *user's* identity (not the agent's)
//   4. Mutates `actionMetadata.state` to `executed` with a result reference
//   5. Broadcasts the updated message via Socket.io
//
// Idempotency: if state is already `executed`, the call is a no-op and
// returns the existing record (so a stale double-click doesn't re-create).

import type { Server as SocketServer } from "socket.io";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  actionCardActionSchema,
  buildActionCardPresentation,
  extractHandleName,
  looksLikeUuid,
  validateActionCardAction,
  type ActionCardAction,
  type ActionCardMetadata,
  type ActionCardResult,
  type ActionCardState,
  type ServerId,
  asServerId,
  asMachineId,
  renderThirdPartyInertText,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { actionCards, agents, channelAgents, channelHumans, channels, messages, oauthAccessRequests, oauthClientMaintainers, oauthClients, oauthGrants, serverMembers, users } from "../db/schema";
import * as channelService from "./channelService";
import * as agentService from "./agentService";
import * as serverService from "./serverService";
import * as machineService from "./machineService";
import * as messageService from "./messageService";
import * as oauthService from "./oauthService";
import * as productEventsService from "./productEventsService";
import * as integrationAuditService from "./integrationAuditService";
import { projectRichMessageSocketPayload } from "./messageRealtimeEvents";
import type { AgentOrchestrator } from "./agentOrchestrator";
import {
  ActionCardConversionFrozenError,
  ActionCardConfirmationRequiredError,
  ActionCardConfirmationVersionMismatchError,
  ActionCardReconfirmationRequiredError,
  assertActionCardConfirmationInTransaction,
  assertActionCardWritableInTransaction,
  lockActionCardSourceInTransaction,
  isActionCardConversionMutationForTest,
  resolveActionCardSourceChannelId,
} from "./actionCardConversionService";
import {
  assertChannelConversionWritable,
  getActiveChannelConversionFence,
  lockActionCardScope,
} from "./channelConversionFenceService";

let registerAppPreGuardObservationForTest: (() => void) | null = null;
let beforeExecutionLockForTest: (() => Promise<void>) | null = null;
let beforeActionCardAttemptAuditForTest: (() => Promise<void>) | null = null;

export function setRegisterAppPreGuardObservationForTest(observer: (() => void) | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("action-card observation hooks are test-only");
  }
  registerAppPreGuardObservationForTest = observer;
}

export function setBeforeActionCardExecutionLockForTest(
  hook: (() => Promise<void>) | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("action-card observation hooks are test-only");
  }
  beforeExecutionLockForTest = hook;
}

export function setBeforeActionCardAttemptAuditForTest(
  hook: (() => Promise<void>) | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("action-card observation hooks are test-only");
  }
  beforeActionCardAttemptAuditForTest = hook;
}
import { actorHasServerCapabilityInServer, actorRoleHasServerCapability, resolveActorContext } from "../lib/actorPermissions";
import { channelActorHasCapability, resolveChannelActorContext } from "../lib/channelActorPermissions";
import { oauthClientIsUserManagedPredicate } from "./oauthClientManagementPolicy";

export class ActionCardError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface PrepareActionCardArgs {
  serverId: string;
  requesterAgentId: string;
  /** Resolved channel id where the card is posted (already validated by route). */
  targetChannelId: string;
  action: ActionCardAction;
  io?: SocketServer | null;
  /**
   * Runs on the preparing transaction after the carrier message and the
   * action_cards row are written and before it commits (keyed Agent API
   * writes record their idempotency ledger row here). A rejection rolls the
   * card back.
   */
  beforeCommit?: (
    executor: DatabaseExecutor,
    result: { messageId: string; metadata: ActionCardMetadata },
  ) => Promise<void>;
}

export function bindMarketplaceAppName(rawName: string): {
  clientName: string;
  clientNameSha256: string;
} {
  return {
    clientName: renderThirdPartyInertText({ field: "app_name", value: rawName }),
    clientNameSha256: createHash("sha256").update(rawName, "utf8").digest("hex"),
  };
}

async function canonicalizeMarketplaceAppCardDisplay(
  action: ActionCardAction,
  db: ReturnType<typeof getDb>,
): Promise<ActionCardAction> {
  if (action.type !== "integration:install_marketplace_app") return action;

  const [client] = await db
    .select({
      clientKey: oauthClients.clientId,
      clientName: oauthClients.name,
    })
    .from(oauthClients)
    .where(and(
      eq(oauthClients.id, action.clientId),
      eq(oauthClients.clientId, action.clientKey),
      eq(oauthClients.appType, "third_party_global"),
      eq(oauthClients.enabled, true),
      oauthClientIsUserManagedPredicate(),
      eq(oauthClients.humanMarketplaceVisible, true),
      sql`${oauthClients.publishStatus} in ('published', 'unpublish_requested')`,
    ))
    .limit(1);
  if (!client) {
    throw new ActionCardError(409, "MARKETPLACE_APP_CHANGED", "Marketplace app is no longer installable; prepare a fresh login request");
  }

  const binding = bindMarketplaceAppName(client.clientName);
  if (binding.clientNameSha256 !== action.clientNameSha256) {
    throw new ActionCardError(409, "MARKETPLACE_APP_CHANGED", "Marketplace app identity changed; prepare a fresh login request");
  }
  return {
    ...action,
    clientName: binding.clientName,
    draftHint: `${action.agentName} requested ${binding.clientName}, which is public in the Raft Marketplace but is not installed on this Server. Installing is a Server owner/admin action; the Agent cannot install it automatically.`,
  };
}

/**
 * Every local surface that renders an action-card carrier. Joint carriers live
 * in canonical storage and are projected to each active participant server;
 * ordinary carriers have exactly their own channel.
 */
async function listActionCardCarrierSurfaces(
  channel: typeof channels.$inferSelect,
): Promise<Array<{ channelId: string; serverId: string }>> {
  const targets: Array<{ channelId: string; serverId: string }> = [];
  if (channel.type === "thread") {
    const projections = await channelService.getActiveJointThreadProjectionsByCanonicalThread(channel.id);
    targets.push(...projections.map(projection => ({ channelId: projection.localThreadChannelId, serverId: projection.localServerId })));
  } else {
    const projections = await channelService.getActiveJointChannelProjectionsByLocalChannel(channel.id);
    targets.push(...projections.map(projection => ({ channelId: projection.localChannelId, serverId: projection.serverId })));
  }
  if (targets.length === 0) targets.push({ channelId: channel.id, serverId: channel.serverId });
  return targets;
}

async function emitActionCardCarrierMessage(
  io: SocketServer,
  row: Pick<typeof messages.$inferSelect, "id">,
  event: "message:new" | "message:updated",
): Promise<void> {
  const [current] = await messageService.listMessagesByIds([row.id]);
  if (!current) return;
  const channel = await channelService.getChannel(current.channelId);
  if (!channel) return;
  const targets = await listActionCardCarrierSurfaces(channel);
  for (const target of targets) {
    if (event === "message:new") messageService.updateMaxSeq(target.serverId, current.seq);
    const [projected] = await messageService.projectJointMessagesToLocalChannel([current], target.channelId, target.serverId);
    const payload = projectRichMessageSocketPayload(messageService.stripViewerScopedAttachmentCommentMetadata(projected));
    if (channel.type !== "thread") {
      if (event === "message:new") {
        // message-realtime-producer: action-card.new.channel
        io.to(`channel:${target.channelId}`).emit("message:new", payload);
      } else {
        // message-realtime-producer: action-card.updated.channel
        io.to(`channel:${target.channelId}`).emit("message:updated", payload);
      }
      continue;
    }
    // Private/Joint Thread rooms may contain stale sockets after a membership
    // change. Use the existing authority-filtered follower audience instead.
    const followerIds = await messageService.getHumanThreadFollowerIds(target.channelId);
    for (const userId of followerIds) {
      if (event === "message:new") {
        io.in(socketUserServerRoom(userId, target.serverId)).socketsJoin(`channel:${target.channelId}`);
        // message-realtime-producer: action-card.new.thread-follower
        io.to(`user:${userId}`).emit("message:new", payload);
      } else {
        // message-realtime-producer: action-card.updated.thread-follower
        io.to(`user:${userId}`).emit("message:updated", payload);
      }
    }
  }
}

export async function emitActionCardMessageUpdated(io: SocketServer, row: Pick<typeof messages.$inferSelect, "id">): Promise<void> {
  await emitActionCardCarrierMessage(io, row, "message:updated");
}

/**
 * Resolve a single human reference (UUID-or-handle) to a userId scoped to
 * this server. UUID-looking inputs still must resolve through server
 * membership; otherwise action cards would bypass the handle path's
 * server boundary.
 */
async function resolveHumanRef(
  serverId: string,
  ref: string,
  fieldPath: string,
): Promise<string> {
  if (looksLikeUuid(ref)) {
    const isMember = await serverService.isMember(serverId, ref);
    if (!isMember) {
      throw new ActionCardError(
        422,
        "INVALID_HANDLE",
        `${fieldPath}: human is not a member of this server`,
      );
    }
    return ref;
  }
  const handle = extractHandleName(ref, "@");
  const userId = await channelService.resolveUserByName(serverId, handle);
  if (!userId) {
    throw new ActionCardError(
      422,
      "INVALID_HANDLE",
      `${fieldPath}: no human named "${handle}" in this server`,
    );
  }
  return userId;
}

/**
 * Resolve a single agent reference (UUID-or-handle) to an agentId scoped to
 * this server. Mirror of `resolveHumanRef` but routed through agent lookup.
 */
async function resolveAgentRef(
  serverId: string,
  ref: string,
  fieldPath: string,
): Promise<string> {
  if (looksLikeUuid(ref)) {
    const agent = await agentService.getAgent(ref);
    if (!agent || agent.serverId !== serverId) {
      throw new ActionCardError(
        422,
        "INVALID_HANDLE",
        `${fieldPath}: agent is not in this server`,
      );
    }
    return ref;
  }
  const handle = extractHandleName(ref, "@");
  const agentId = await channelService.resolveAgentByName(serverId, handle);
  if (!agentId) {
    throw new ActionCardError(
      422,
      "INVALID_HANDLE",
      `${fieldPath}: no agent named "${handle}" in this server`,
    );
  }
  return agentId;
}

/**
 * Resolve a channel reference (UUID-or-handle) to a channelId. Reuses
 * `resolveChannelByName` which already understands `#channel` / `dm:@peer`
 * forms and enforces private-channel visibility.
 */
async function resolveChannelRef(
  serverId: string,
  requesterAgentId: string,
  ref: string,
  fieldPath: string,
): Promise<string> {
  if (looksLikeUuid(ref)) {
    const channel = await channelService.getChannel(ref);
    const canAccess = channel?.serverId === serverId
      ? await channelService.canAgentAccessChannel(ref, requesterAgentId)
      : false;
    if (!channel || channel.serverId !== serverId || !canAccess) {
      throw new ActionCardError(
        422,
        "INVALID_HANDLE",
        `${fieldPath}: channel is not visible to this agent in this server`,
      );
    }
    return ref;
  }
  const normalized = ref.trim().startsWith("#") ? ref.trim() : `#${ref.trim()}`;
  const resolved = await channelService.resolveChannelByName(
    serverId,
    requesterAgentId,
    normalized,
  );
  if (!resolved) {
    throw new ActionCardError(
      422,
      "INVALID_HANDLE",
      `${fieldPath}: no channel named "${normalized}" visible to this agent`,
    );
  }
  return resolved.channelId;
}

/**
 * Resolve a computer reference to a machineId scoped to this server.
 * UUID-looking inputs still must belong to the server. Non-UUID inputs match
 * computer name exactly; ambiguous names fail closed so the card cannot
 * silently target the wrong machine.
 */
async function resolveComputerRef(
  serverId: string,
  ref: string,
  fieldPath: string,
): Promise<string> {
  if (looksLikeUuid(ref)) {
    const machine = await machineService.getMachine(asMachineId(ref));
    if (!machine || machine.serverId !== serverId) {
      throw new ActionCardError(
        422,
        "INVALID_HANDLE",
        `${fieldPath}: computer is not in this server`,
      );
    }
    return ref;
  }
  const handle = ref.trim();
  const matches = (await machineService.listMachines(serverId))
    .filter((machine) => machine.name === handle);
  if (matches.length === 0) {
    throw new ActionCardError(
      422,
      "INVALID_HANDLE",
      `${fieldPath}: no computer named "${handle}" in this server`,
    );
  }
  if (matches.length > 1) {
    throw new ActionCardError(
      422,
      "AMBIGUOUS_HANDLE",
      `${fieldPath}: more than one computer named "${handle}" in this server`,
    );
  }
  return matches[0].id;
}

/**
 * Walks an `ActionCardAction` payload and resolves every UUID-or-handle
 * field by principal type. Returns a new action object with all references
 * as UUIDs; callers persist this UUID-only form so card render / dialog /
 * execute paths never need a second resolution step. Per stdrc / xxchan
 * #engineering msg=f629320c (2026-05-11): agents only see handles; UUID
 * resolution happens server-side at prepare time.
 *
 * Cross-type pollution is rejected by construction: each field type uses
 * its own resolver and only its own resolver, so a handle dropped into the
 * wrong array (e.g. an agent handle in `initialHumans`) surfaces as
 * INVALID_HANDLE rather than silently matching the wrong principal.
 */
async function resolveActionHandles(
  serverId: string,
  requesterAgentId: string,
  action: ActionCardAction,
): Promise<ActionCardAction> {
  switch (action.type) {
    case "channel:create": {
      const resolvedInitialHumans = action.initialHumans
        ? await Promise.all(
            action.initialHumans.map((ref, i) =>
              resolveHumanRef(serverId, ref, `initialHumans[${i}]`),
            ),
          )
        : undefined;
      const resolvedInitialAgents = action.initialAgents
        ? await Promise.all(
            action.initialAgents.map((ref, i) =>
              resolveAgentRef(serverId, ref, `initialAgents[${i}]`),
            ),
          )
        : undefined;
      return {
        ...action,
        ...(resolvedInitialHumans ? { initialHumans: resolvedInitialHumans } : {}),
        ...(resolvedInitialAgents ? { initialAgents: resolvedInitialAgents } : {}),
      };
    }
    case "agent:create": {
      const suggestedComputer = action.suggestedComputer
        ? await resolveComputerRef(serverId, action.suggestedComputer, "suggestedComputer")
        : undefined;
      const requiredComputer = action.requiredComputer
        ? await resolveComputerRef(serverId, action.requiredComputer, "requiredComputer")
        : undefined;
      return {
        ...action,
        ...(suggestedComputer ? { suggestedComputer } : {}),
        ...(requiredComputer ? { requiredComputer } : {}),
      };
    }
    case "channel:add_member": {
      const channel = await resolveChannelRef(
        serverId,
        requesterAgentId,
        action.channel,
        "channel",
      );
      const humans = action.humans
        ? await Promise.all(
            action.humans.map((ref, i) =>
              resolveHumanRef(serverId, ref, `humans[${i}]`),
            ),
          )
        : undefined;
      const agents = action.agents
        ? await Promise.all(
            action.agents.map((ref, i) =>
              resolveAgentRef(serverId, ref, `agents[${i}]`),
            ),
          )
        : undefined;
      return {
        ...action,
        channel,
        ...(humans ? { humans } : {}),
        ...(agents ? { agents } : {}),
      };
    }
    case "integration:approve_agent_login":
    case "integration:install_marketplace_app":
      return action;
    case "integration:register_app": {
      const homepageUrl = validateIntegrationUrl(action.homepageUrl, "homepageUrl", action.unsafeDemoUrlOverride);
      const returnUrl = validateIntegrationUrl(action.returnUrl, "returnUrl", action.unsafeDemoUrlOverride);
      const agentManifestUrl = validateIntegrationUrl(action.agentManifestUrl, "agentManifestUrl", action.unsafeDemoUrlOverride);
      return {
        ...action,
        ...(homepageUrl ? { homepageUrl } : {}),
        returnUrl: returnUrl ?? action.returnUrl,
        ...(agentManifestUrl ? { agentManifestUrl } : {}),
      };
    }
    case "integration:update_app_registration": {
      const homepageUrl = action.homepageUrl === undefined
        ? undefined
        : validateIntegrationUrl(action.homepageUrl, "homepageUrl", action.unsafeDemoUrlOverride);
      const returnUrl = action.returnUrl === undefined
        ? undefined
        : validateIntegrationUrl(action.returnUrl, "returnUrl", action.unsafeDemoUrlOverride);
      const agentManifestUrl = action.agentManifestUrl === undefined
        ? undefined
        : validateIntegrationUrl(action.agentManifestUrl, "agentManifestUrl", action.unsafeDemoUrlOverride);
      return {
        ...action,
        ...(homepageUrl !== undefined ? { homepageUrl: homepageUrl ?? "" } : {}),
        ...(returnUrl !== undefined ? { returnUrl: returnUrl ?? "" } : {}),
        ...(agentManifestUrl !== undefined ? { agentManifestUrl: agentManifestUrl ?? "" } : {}),
      };
    }
    case "integration:recover_app_owner":
      return {
        ...action,
        targetAgent: await resolveAgentRef(serverId, action.targetAgent, "targetAgent"),
      };
  }
}

export async function prepareActionCard(args: PrepareActionCardArgs): Promise<{
  messageId: string;
  metadata: ActionCardMetadata;
}> {
  const parsed = actionCardActionSchema.safeParse(args.action);
  if (!parsed.success) {
    throw new ActionCardError(400, "INVALID_PAYLOAD", parsed.error.message);
  }
  if (parsed.data.type === "integration:update_app_registration") {
    throw new ActionCardError(
      410,
      "LEGACY_APP_UPDATE_DISABLED",
      "App registration update cards are disabled; the app owner must use the direct integration app update command",
    );
  }
  const crossFieldError = validateActionCardAction(parsed.data as ActionCardAction);
  if (crossFieldError) {
    throw new ActionCardError(400, "INVALID_PAYLOAD", crossFieldError);
  }
  const resolvedAction = await resolveActionHandles(
    args.serverId,
    args.requesterAgentId,
    parsed.data as ActionCardAction,
  );
  const action = await canonicalizeMarketplaceAppCardDisplay(resolvedAction, getDb());

  // Verify the requesting agent belongs to this server.
  const agent = await agentService.getAgent(args.requesterAgentId);
  if (!agent || agent.serverId !== args.serverId) {
    throw new ActionCardError(404, "AGENT_NOT_FOUND", "Requester agent not found in this server");
  }

  // Verify the target channel exists in this server.
  const target = await channelService.getChannel(args.targetChannelId);
  if (!target || target.serverId !== args.serverId) {
    throw new ActionCardError(404, "TARGET_NOT_FOUND", "Target channel not found in this server");
  }
  if (!await channelService.canAgentPostToChannel(args.targetChannelId, args.requesterAgentId)) {
    throw new ActionCardError(403, "TARGET_NOT_ACCESSIBLE", "Requester agent cannot post to this target");
  }

  // A channel:add_member card may be posted in one carrier while mutating a
  // different channel.  Its conversion authority is the action target, not
  // the carrier.  Other cards are scoped to the carrier (with Thread cards
  // resolving back to their parent source channel).
  const sourceScopeChannelId = action.type === "channel:add_member"
    ? action.channel
    : args.targetChannelId;
  const sourceChannelId = await resolveActionCardSourceChannelId(getDb(), sourceScopeChannelId);
  const targetServer = await serverService.getServer(args.serverId);
  const metadata: ActionCardMetadata = {
    kind: "action-card",
    // Target server is fixed here: the preparing agent's server. Execution
    // acts on it regardless of which joint projection the confirmer uses.
    sourceServerId: asServerId(args.serverId),
    targetServerName: targetServer?.name ?? null,
    action,
    presentation: buildActionCardPresentation(action),
    state: "prepared",
    executedAt: null,
    executedByUserId: null,
    executedByUserName: null,
    result: null,
  };

  // Carrier message renders as a regular agent chat row (per stdrc
  // #proj-approval msg=45ca8c31). The card itself is the message body —
  // MessageItem branches on `actionMetadata.kind === "action-card"` and
  // renders the structured card from the metadata. `content` is retained as
  // a plain-text fallback for inbox/activity previews and non-card clients.
  // We dual-write to the `action_cards` table for queryability + audit (per
  // stdrc msg=22a82192 / msg=174b7e16 — DB persistence, minimum schema).
  const db = getDb();
  const out = await db.transaction(async (tx) => {
    // Re-resolve and acquire the canonical source lock in this transaction;
    // the unlocked prepare-time lookup is only a hint.  This closes the
    // conversion-start ↔ card-insert race and prevents a card from being
    // persisted with a stale source identity.
    const freshSourceChannelId = await resolveActionCardSourceChannelId(tx, sourceScopeChannelId);
    if (freshSourceChannelId !== sourceChannelId) {
      throw new ActionCardError(409, "ACTION_CARD_SOURCE_CHANGED", "Action card target changed while it was being prepared");
    }
    if (freshSourceChannelId) {
      await lockActionCardScope(tx, args.serverId, freshSourceChannelId);
    }
    const activeFence = freshSourceChannelId ? await getActiveChannelConversionFence(tx, freshSourceChannelId) : null;
    if (freshSourceChannelId && !activeFence) {
      // A retained pending/running/failed job without its fence is a
      // migration/repair fault.  Do not persist a card into that ambiguous
      // authority window; the foundation writer primitive fails closed.
      await assertChannelConversionWritable(freshSourceChannelId, tx);
    }
    const cardState: ActionCardMetadata["state"] = activeFence ? "frozen" : "prepared";
    if (activeFence) {
      metadata.state = cardState;
      metadata.conversionJobId = activeFence.jobId;
      metadata.conversionEpoch = activeFence.conversionEpoch;
    }
    // Joint channels/threads keep one durable row in canonical storage that
    // every participant server projects; writing the carrier to the local
    // projection would hide it from peers and from canonical-backed history.
    const storageChannelId = await channelService.getMessageStorageChannelIdWithExecutor(tx, args.targetChannelId);
    const [msg] = await tx
      .insert(messages)
      .values({
        channelId: storageChannelId,
        senderType: "agent",
        senderId: args.requesterAgentId,
        content: summarize(action),
        messageType: "chat",
        actionMetadata: metadata,
      })
      .returning();
    await tx
      .insert(actionCards)
      .values({
        serverId: args.serverId,
        messageId: msg.id,
        requesterAgentId: args.requesterAgentId,
        actionType: action.type,
        payload: action,
        state: "prepared",
        conversionJobId: activeFence?.jobId ?? null,
        conversionSourceChannelId: freshSourceChannelId,
        conversionEpoch: activeFence?.conversionEpoch ?? null,
        freezeState: activeFence ? "frozen" : "ready",
      });
    if (args.beforeCommit) await args.beforeCommit(tx, { messageId: msg.id, metadata });
    return msg;
  });

  await messageService.recordInboxFactsForPersistedMessages([out], {
    inboxFactPolicy: {
      mode: "record",
      producer: "action_card.carrier",
      reason: "action-card carrier messages are delivered chat rows and count as channel activity",
    },
  });
  messageService.updateMaxSeq(args.serverId, out.seq);

  if (args.io && out) {
    await emitActionCardCarrierMessage(args.io, out, "message:new");
  }

  return { messageId: out.id, metadata };
}

export interface ExecuteActionCardArgs {
  messageId: string;
  serverId: ServerId;
  userId: string;
  expectedState?: ActionCardState;
  expectedConfirmationVersion?: number;
  io?: SocketServer | null;
  /**
   * Agent orchestrator — used to push private, transient completion notices
   * to the requesting agent. Inline executions need this for app-registration
   * secret handoff; the persisted action-card result must stay secret-free.
   */
  orchestrator?: AgentOrchestrator | null;
}

interface ExecutePreflight {
  /** action_cards.id — canonical product entity id, used as subject_id. */
  cardId: string;
  requesterAgentId: string;
  actionType: ActionCardAction["type"];
  /** Canonical prepared payload (action_cards.payload). */
  action: ActionCardAction;
  state: ActionCardState;
  freezeState: "ready" | "frozen" | "reconfirm_required";
  confirmationVersion: number;
  conversionJobId: string | null;
}

/** Resolve storage through the caller's active local projection, including Joint Threads. */
async function resolveActionCardLocalChannelId(channelId: string, serverId: string, executor: DatabaseExecutor): Promise<string | null> {
  const [projection] = await executor.select({ localChannelId: jointChannelServers.localChannelId })
    .from(jointChannels).innerJoin(jointChannelServers, and(
      eq(jointChannelServers.jointChannelId, jointChannels.id),
      eq(jointChannelServers.serverId, serverId), eq(jointChannelServers.status, "active"),
    )).where(and(eq(jointChannels.canonicalChannelId, channelId), eq(jointChannels.status, "active"))).limit(1);
  if (projection) return projection.localChannelId;
  const channel = await channelService.getChannel(channelId, { executor });
  if (channel?.serverId === serverId) return channelId;
  if (channel?.type === "thread") {
    const threadProjection = (await channelService.getActiveJointThreadProjectionsByCanonicalThread(channelId, executor))
      .find((candidate) => candidate.localServerId === serverId);
    if (threadProjection) return threadProjection.localThreadChannelId;
  }
  return null;
}

/**
 * Authorize a human to operate an action card and return the card's target
 * server (`action_cards.server_id`, fixed at prepare time). The action always
 * executes on that server, so every permission check runs there — not on the
 * server the confirmer happens to view the carrier from. A confirmer viewing a
 * Joint carrier from a peer server may operate it only when they are also an
 * eligible member of the target server's projection of that channel. A
 * carrier the target server cannot see at all (e.g. an agent-migration history
 * copy) stays read-only outside its source workspace.
 */
export async function assertActionCardWritableByUser(input: {
  messageId: string;
  channelId: string;
  serverId: string;
  userId: string;
  executor: ReturnType<typeof getDb>;
  lock?: boolean;
}): Promise<ServerId> {
  const [origin] = await input.executor.select({ serverId: actionCards.serverId })
    .from(actionCards).where(eq(actionCards.messageId, input.messageId)).limit(1);
  const targetServerId = origin ? asServerId(origin.serverId) : null;
  const crossServer = isActionCardReadOnlyInServer(targetServerId, input.serverId);
  const refuseCrossServer = async (): Promise<never> => {
    const targetServer = targetServerId ? await serverService.getServer(targetServerId) : null;
    throw new ActionCardError(
      403,
      "ACTION_CARD_SOURCE_WORKSPACE_REQUIRED",
      targetServer
        ? `This action card acts on server "${targetServer.name}". Only members of that server who can operate this channel there may confirm it.`
        : "Historical action cards can only be operated in their source workspace",
    );
  };
  if (!targetServerId) return refuseCrossServer();
  const localChannelId = await resolveActionCardLocalChannelId(input.channelId, targetServerId, input.executor);
  const authorityChannelId = localChannelId
    ? await channelService.getChannelMembershipAuthorityChannelId(localChannelId, input.executor) : null;
  if (!authorityChannelId) {
    if (crossServer) return refuseCrossServer();
    throw new ActionCardError(403, "FORBIDDEN", "Not allowed to operate action cards in this channel");
  }
  if (input.lock) {
    const [locked] = await input.executor.select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.id, authorityChannelId), eq(channels.serverId, targetServerId)))
      .for("update")
      .limit(1);
    if (!locked) {
      throw new ActionCardError(403, "FORBIDDEN", "Not allowed to operate action cards in this channel");
    }
  }
  const context = await resolveChannelActorContext(
    targetServerId,
    authorityChannelId,
    "user",
    input.userId,
    input.executor,
  );
  const allowed = context
    && !context.channelArchivedAt
    && !context.channelDeletedAt
    && context.serverRole !== "guest"
    && (context.serverRole === "owner" || context.serverRole === "admin" || context.isChannelMember);
  if (!allowed) {
    if (crossServer) return refuseCrossServer();
    throw new ActionCardError(403, "FORBIDDEN", "Join this channel before operating its action cards");
  }
  return targetServerId;
}

async function assertUserCanAddActionCardMembers(input: {
  channelId: string;
  serverId: string;
  userId: string;
  executor: ReturnType<typeof getDb>;
}): Promise<void> {
  const [locked] = await input.executor.select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.id, input.channelId), eq(channels.serverId, input.serverId)))
    .for("update")
    .limit(1);
  if (!locked) {
    throw new ActionCardError(404, "CHANNEL_NOT_FOUND", "Target channel no longer exists");
  }
  const context = await resolveChannelActorContext(
    input.serverId,
    input.channelId,
    "user",
    input.userId,
    input.executor,
  );
  if (!context || !channelActorHasCapability(context, "addChannelMembers")) {
    throw new ActionCardError(403, "FORBIDDEN", "Not allowed to add members to the target channel");
  }
}

interface IntegrationAppSecretHandoff {
  kind: "integration-app-secret";
  clientId: string;
  clientKey: string;
  clientName: string;
  clientSecret: string;
}

interface PerformActionOutput {
  result: ActionCardResult;
  requesterSecretHandoff?: IntegrationAppSecretHandoff;
  /**
   * A channel created this action whose realtime broadcast must run AFTER the
   * surrounding transaction commits. Carried out of the transaction so neither
   * the cross-replica Redis fanout (fanoutWithAck waits for ACKs, leaving the
   * transaction idle-in-transaction) NOR the pre-commit local socket emit
   * (a client would see a channel that rolls back into nonexistence) runs while
   * the transaction is open. Undefined for non-channel actions.
   */
  postCommitChannelPublish?: {
    channel: { id: string; serverId: string } & Record<string, unknown>;
    private: boolean;
    initialUserIds: string[];
    userId: string;
  };
}

/**
 * Validate that `args.messageId` is a real action card the caller can
 * access in this server, and resolve the canonical `action_cards.id`. Used
 * as a gate before emitting `execute_attempt` / `execute_fail` so random
 * UUID probes can't pollute the product funnel with orphan rows
 * (Leiysky/Dozy review 2026-05-13 #proj-permission:13b42cc0
 * msg=086dc014 / msg=9d0f10bd; subject grain per Dozy + meichen
 * msg=174ba78c).
 *
 * Throws `ActionCardError` on any validation failure. Does NOT emit any
 * funnel event — callers handle the emit ordering relative to this.
 */
async function preflightExecuteActionCard(
  args: ExecuteActionCardArgs,
  db: ReturnType<typeof getDb>,
): Promise<ExecutePreflight> {
  const [row] = await db.select().from(messages).where(eq(messages.id, args.messageId));
  if (!row) {
    throw new ActionCardError(404, "NOT_FOUND", "Card message not found");
  }
  const meta = (row.actionMetadata ?? null) as Partial<ActionCardMetadata> | null;
  if (!meta || meta.kind !== "action-card") {
    throw new ActionCardError(400, "NOT_OPERATION_CARD", "Message is not an operation card");
  }
  const localChannelId = await resolveActionCardLocalChannelId(row.channelId, args.serverId, db);
  const channel = localChannelId ? await channelService.getChannel(localChannelId) : null;
  if (!channel || channel.serverId !== args.serverId) {
    throw new ActionCardError(403, "WRONG_SERVER", "Card not in this server");
  }
  // Per-channel access gate. Same-server membership alone is not enough —
  // for private channels the caller must actually have read access. Mirrors
  // `/event` route. Without this, a same-server user who knows / guesses a
  // private-channel card's message id could pollute the funnel and even
  // mutate card state via mark-executed (Leiysky/Dozy/meichen review
  // 2026-05-13: msg=5cb29566 / msg=e2d25035 / DM e270834b).
  const allowed = await channelService.canUserAccessChannel(
    channel.id,
    args.userId,
    args.serverId,
  );
  if (!allowed) {
    throw new ActionCardError(403, "FORBIDDEN", "Not allowed to access this card's channel");
  }
  await assertActionCardWritableByUser({
      messageId: args.messageId,
    channelId: row.channelId,
    serverId: args.serverId,
    userId: args.userId,
    executor: db,
  });
  const action = (meta.action ?? null) as ActionCardAction | null;
  if (!action) {
    throw new ActionCardError(400, "MALFORMED_ACTION", "Card metadata missing action");
  }
  const [cardRow] = await db
    .select({
      id: actionCards.id,
      requesterAgentId: actionCards.requesterAgentId,
      actionType: actionCards.actionType,
      payload: actionCards.payload,
      state: actionCards.state,
      freezeState: actionCards.freezeState,
      confirmationVersion: actionCards.confirmationVersion,
      conversionJobId: actionCards.conversionJobId,
    })
    .from(actionCards)
    .where(eq(actionCards.messageId, args.messageId));
  if (!cardRow) {
    throw new ActionCardError(404, "NOT_FOUND", "Action card row not found");
  }
  if (!isDeepStrictEqual(action, cardRow.payload)) {
    throw new ActionCardError(409, "CARD_PAYLOAD_MISMATCH", "Action card carrier no longer matches its canonical payload");
  }
  return {
    cardId: cardRow.id,
    requesterAgentId: cardRow.requesterAgentId,
    actionType: cardRow.actionType as ActionCardAction["type"],
    action,
    state: meta.state ?? "prepared",
    freezeState: cardRow.freezeState,
    confirmationVersion: cardRow.confirmationVersion,
    conversionJobId: cardRow.conversionJobId,
  };
}

export async function assertActionCardVisibleToUser(args: {
  messageId: string;
  serverId: ServerId;
  userId: string;
}): Promise<void> {
  const db = getDb();
  const [row] = await db.select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, args.messageId));
  if (!row) {
    throw new ActionCardError(404, "NOT_FOUND", "Card message not found");
  }
  const localChannelId = await resolveActionCardLocalChannelId(row.channelId, args.serverId, db);
  const channel = localChannelId ? await channelService.getChannel(localChannelId) : null;
  if (!channel || channel.serverId !== args.serverId) {
    throw new ActionCardError(404, "NOT_FOUND", "Card message not found");
  }
  const canAccess = await channelService.canUserAccessChannel(channel.id, args.userId, args.serverId);
  if (!canAccess) {
    throw new ActionCardError(404, "NOT_FOUND", "Card message not found");
  }
}

export async function executeActionCard(args: ExecuteActionCardArgs): Promise<{
  messageId: string;
  metadata: ActionCardMetadata;
}> {
  await assertActionCardVisibleToUser(args);
  const db = getDb();

  // Preflight: validate this is a real action card the caller can access.
  // Validation failures (404 / 400 / 403) are NOT recorded in the funnel —
  // those are pre-funnel signals (route abuse, stale clients) and belong
  // in security/API metrics, not in `product_events`.
  const preflight = await preflightExecuteActionCard(args, db);

  // Idempotent stale double-click: state already executed. Inner method
  // will return the existing record as a no-op. Don't emit any funnel
  // event — it's not a new attempt.
  if (preflight.state === "executed") {
    return await executeActionCardInner(args, db, preflight);
  }

  if (preflight.freezeState === "frozen") {
    throw new ActionCardConversionFrozenError(preflight.confirmationVersion.toString());
  }
  if (preflight.freezeState === "reconfirm_required") {
    throw new ActionCardReconfirmationRequiredError();
  }
  if (preflight.conversionJobId !== null && preflight.confirmationVersion > 1 && args.expectedConfirmationVersion === undefined
    && !isActionCardConversionMutationForTest("confirmation_gate_bypass")) {
    throw new ActionCardConfirmationRequiredError();
  }
  if (args.expectedConfirmationVersion !== undefined && args.expectedConfirmationVersion !== preflight.confirmationVersion
    && !isActionCardConversionMutationForTest("confirmation_gate_bypass")) {
    throw new ActionCardConfirmationVersionMismatchError();
  }

  // The split-lock mutation faithfully restores the rejected predecessor:
  // validate in one source-lock transaction, release it, and later write the
  // attempt audit outside the execution transaction.  The permanent race
  // witness below must observe that audit leak when conversion/reconfirmation
  // wins the resulting window.
  if (isActionCardConversionMutationForTest("execute_audit_lock_split")) {
    await db.transaction((tx) => assertActionCardConfirmationInTransaction(
      tx,
      args.messageId,
      args.expectedConfirmationVersion,
    ));
  }

  // Let a deterministic test interleave a real conversion/reconfirmation
  // before the final execution transaction acquires its lock. The production
  // path has no work or audit write in this gap; the inner transaction below
  // performs the authoritative read and holds the lock continuously through
  // audit + business transition.
  await beforeExecutionLockForTest?.();

  if (isActionCardConversionMutationForTest("execute_audit_lock_split")) {
    await productEventsService.recordActionCardEvent({
      cardId: preflight.cardId,
      eventType: "action_card.execute_attempt",
      actor: { type: "human", id: args.userId },
      source: "server",
      metadata: { action_type: preflight.actionType },
    });
  }

  try {
    return await executeActionCardInner(args, db, preflight);
  } catch (err) {
    // Funnel hook: classify + record failure with low-cardinality bucket.
    // `action_type` is derived from the validated card metadata (server-
    // side source of truth), not from anything client-supplied.
    // A confirmation mismatch is rejected before the attempt audit boundary
    // inside the source-lock transaction.  Do not create a failure audit row
    // for this stale request: the card, audit and business state must remain
    // byte-for-byte unchanged when a competing cutover/reconfirmation wins.
    const code = typeof err === "object" && err !== null && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
    const rejectedBeforeAttempt =
      code === "CONFIRMATION_VERSION_REQUIRED"
      || code === "CONFIRMATION_VERSION_MISMATCH"
      || code === "action_card_conversion_frozen"
      || code === "action_card_reconfirmation_required"
      || code === "channel_conversion_in_progress"
      || code === "channel_conversion_fence_conflict";
    if (!rejectedBeforeAttempt || isActionCardConversionMutationForTest("execute_audit_lock_split")) {
      await productEventsService.recordActionCardEvent({
        cardId: preflight.cardId,
        eventType: "action_card.execute_fail",
        actor: { type: "human", id: args.userId },
        source: "server",
        metadata: {
          action_type: preflight.actionType,
          ...productEventsService.classifyExecuteError(err),
        },
      });
    }
    // Tell the preparer about a genuine execution failure. Stale races (the
    // card already resolved) and pre-attempt refusals are not failures of the
    // card itself.
    if (!rejectedBeforeAttempt && code !== "STATE_MISMATCH" && code !== "BAD_STATE") {
      await postActionCardResultReply({
        io: args.io,
        orchestrator: args.orchestrator,
        messageId: args.messageId,
        confirmerUserId: args.userId,
        outcome: {
          kind: "failed",
          action: preflight.action,
          reason: err instanceof ActionCardError ? err.message : "internal error",
        },
      });
    }
    throw err;
  }
}

async function executeActionCardInner(
  args: ExecuteActionCardArgs,
  db: ReturnType<typeof getDb>,
  preflight: ExecutePreflight,
): Promise<{ messageId: string; metadata: ActionCardMetadata }> {
  const userName = await loadUserDisplayName(args.userId);
  // Atomic read + transition: the canonical source lock is acquired by the
  // confirmation read and held by this transaction through the authoritative
  // attempt audit, business writer, card transition, and success audit.  In
  // particular, never release the lock between credential validation and the
  // execute_attempt insert: a concurrent cutover/reconfirm must serialize
  // behind this entire boundary.
  const result = await db.transaction(async (tx) => {
    // Even idempotent replays must carry the converted-card credential.  This
    // check is deliberately under the same source lock as the writable gate;
    // the preflight value is only an early, audit-before-side-effect guard.
    const sourceLockAuthority = await lockActionCardSourceInTransaction(tx, args.messageId);
    const lockedConfirmationVersion = await assertActionCardConfirmationInTransaction(
      tx,
      args.messageId,
      args.expectedConfirmationVersion,
      { sourceLockAuthority },
    );
    const [row] = await tx.select().from(messages).where(eq(messages.id, args.messageId));
    if (!row) {
      throw new ActionCardError(404, "NOT_FOUND", "Card message not found");
    }
    const meta = (row.actionMetadata ?? null) as Partial<ActionCardMetadata> | null;
    if (!meta || meta.kind !== "action-card") {
      throw new ActionCardError(400, "NOT_OPERATION_CARD", "Message is not an operation card");
    }
    const targetServerId = await assertActionCardWritableByUser({
      messageId: args.messageId,
      channelId: row.channelId,
      serverId: args.serverId,
      userId: args.userId,
      executor: tx as ReturnType<typeof getDb>,
      lock: true,
    });
    if (args.expectedState && meta.state !== args.expectedState) {
      throw new ActionCardError(409, "STATE_MISMATCH", `Card is ${meta.state}, expected ${args.expectedState}`);
    }
    if (meta.state === "executed") {
      // Idempotency: same shape, no re-execute.
      return { row, metadata: meta as ActionCardMetadata, executed: false, confirmationVersion: lockedConfirmationVersion };
    }
    if (meta.state !== "prepared") {
      throw new ActionCardError(409, "BAD_STATE", `Card is ${meta.state}; cannot execute`);
    }

    // Witness-only mutation: run the real register_app business path before
    // the conversion fence.  The controlled observer proves that moving this
    // call ahead of the gate is observable even though the surrounding
    // transaction later rolls back.
    if (isActionCardConversionMutationForTest("register_app_pre_guard")) {
      const [preGuardCard] = await tx.select({ payload: actionCards.payload })
        .from(actionCards).where(eq(actionCards.id, preflight.cardId)).limit(1);
      const parsedPreGuard = preGuardCard ? actionCardActionSchema.safeParse(preGuardCard.payload) : null;
      if (parsedPreGuard?.success && parsedPreGuard.data.type === "integration:register_app") {
        registerAppPreGuardObservationForTest?.();
        await performAction(
          targetServerId,
          args.userId,
          preflight.requesterAgentId,
          parsedPreGuard.data,
          args.io ?? null,
          tx as ReturnType<typeof getDb>,
          { messageId: args.messageId, confirmationVersion: preflight.confirmationVersion },
        );
        throw new Error("register_app pre-guard mutation must turn RED by reaching the external side-effect boundary");
      }
    }

    const writable = await assertActionCardWritableInTransaction(
      tx,
      args.messageId,
      args.expectedConfirmationVersion,
      { activeFenceError: "conversion", sourceLockAuthority },
    );

    // Witness the exact lock lifetime required by the conversion contract:
    // pause after the final persisted credential/fence read but before the
    // attempt audit insert. A competing conversion/reconfirmation may start,
    // but it must remain blocked until this transaction commits or rolls back.
    await beforeActionCardAttemptAuditForTest?.();

    // Funnel hook: this is deliberately inside the canonical source-lock
    // transaction and after the final persisted credential *and writable
    // fence* reads. If either gate fails, the transaction rolls back and no
    // attempt/failure audit row is left behind.
    await productEventsService.recordActionCardEvent({
      cardId: preflight.cardId,
      eventType: "action_card.execute_attempt",
      actor: { type: "human", id: args.userId },
      source: "server",
      metadata: { action_type: preflight.actionType },
      executor: tx,
    });

    // Authorize + execute under user identity. v1 has no field-level
    // overrides (agent:create's runtime/model/computer moved to the
    // dialog flow; channel actions are fully prefilled by the agent).
    const [claimedCard] = await tx
      .update(actionCards)
      .set({ updatedAt: new Date() })
      .where(and(
        eq(actionCards.id, preflight.cardId),
        eq(actionCards.state, "prepared"),
      ))
      .returning({ id: actionCards.id, payload: actionCards.payload });
    if (!claimedCard) {
      throw new ActionCardError(409, "STATE_MISMATCH", "Card is no longer prepared");
    }
    const reparsed = actionCardActionSchema.safeParse(claimedCard.payload);
    if (!reparsed.success) {
      throw new ActionCardError(400, "INVALID_PAYLOAD", reparsed.error.message);
    }
    const finalAction = reparsed.data as ActionCardAction;
    if (finalAction.type === "integration:update_app_registration") {
      throw new ActionCardError(
        410,
        "LEGACY_APP_UPDATE_DISABLED",
        "App registration update cards are disabled; the app owner must use the direct integration app update command",
      );
    }

    const executionOutput = await performAction(
      targetServerId,
      args.userId,
      preflight.requesterAgentId,
      finalAction,
      args.io ?? null,
      tx as ReturnType<typeof getDb>,
      { messageId: args.messageId, confirmationVersion: writable.confirmationVersion },
    );
    const executionResult = executionOutput.result;

    // Mutate metadata in-place to executed. We persist the *merged* action
    // so the audit trail reflects what was actually committed (not just
    // what the agent originally prepared).
    const nextMeta: ActionCardMetadata = {
      kind: "action-card",
    sourceServerId: targetServerId,
      action: finalAction,
      presentation: buildActionCardPresentation(finalAction),
      state: "executed",
      executedAt: new Date().toISOString(),
      executedByUserId: args.userId,
      executedByUserName: userName,
      result: executionResult,
    };
    // Update both the canonical action_cards row and the message metadata
    // cache atomically. Card row is the source of truth for state +
    // executor + result; metadata cache is what MessageItem reads at render
    // time.
    await tx
      .update(actionCards)
      .set({
        payload: finalAction,
        state: "executed",
        executedAt: new Date(),
        executedByUserId: args.userId,
        result: executionResult as unknown as object,
        updatedAt: new Date(),
      })
      .where(eq(actionCards.messageId, args.messageId));
    if (
      finalAction.type === "integration:register_app" ||
      finalAction.type === "integration:recover_app_owner" ||
      finalAction.type === "integration:approve_agent_login" ||
      finalAction.type === "integration:install_marketplace_app"
    ) {
      await integrationAuditService.recordIntegrationAuditEvent({
        serverId: targetServerId,
        clientId: executionResult.kind === "integration-app-registration" || executionResult.kind === "agent-integration-login" || executionResult.kind === "integration-app-owner-recovery" || executionResult.kind === "marketplace-app-installation"
          ? executionResult.clientId
          : null,
        eventType: "action_card.executed",
        outcome: "success",
        source: "action_card",
        actor: { type: "human", id: args.userId },
        requester: { type: "agent", id: preflight.requesterAgentId },
        subject: finalAction.type === "integration:approve_agent_login" && executionResult.kind === "agent-integration-login"
          ? { type: "agent", id: executionResult.agentId }
          : executionResult.kind === "integration-app-registration" || executionResult.kind === "integration-app-owner-recovery" || executionResult.kind === "marketplace-app-installation"
            ? { type: "app", id: executionResult.clientId }
            : null,
        target: { type: "action_card", id: preflight.cardId },
        requestId: args.messageId,
        metadata: {
          actionType: finalAction.type,
          clientKey: "clientKey" in finalAction ? finalAction.clientKey : undefined,
          mode: executionResult.kind === "integration-app-registration" ? executionResult.mode : undefined,
        },
      }, tx as ReturnType<typeof getDb>);
    }
    // The requesting agent becomes the app's initial owner. Keep ownerAgentId as
    // a compatibility shadow while capability checks move to the app-bound role.
    if (
      finalAction.type === "integration:register_app" &&
      executionResult.kind === "integration-app-registration" &&
      executionResult.mode === "register"
    ) {
      await tx
        .update(oauthClients)
        .set({ ownerAgentId: preflight.requesterAgentId })
        .where(and(
          eq(oauthClients.id, executionResult.clientId),
          isNull(oauthClients.ownerAgentId),
        ));
      await tx
        .insert(oauthClientMaintainers)
        .values({
          clientId: executionResult.clientId,
          principalType: "agent",
          agentId: preflight.requesterAgentId,
          role: "owner",
          assignedByType: "agent",
          assignedById: preflight.requesterAgentId,
        })
        .onConflictDoNothing();
    }
    const [updated] = await tx
      .update(messages)
      .set({ actionMetadata: nextMeta, updatedAt: new Date() })
      .where(eq(messages.id, args.messageId))
      .returning();
    await productEventsService.recordActionCardEvent({
      cardId: preflight.cardId,
      eventType: "action_card.execute_success",
      actor: { type: "human", id: args.userId },
      source: "server",
      metadata: {
        action_type: preflight.actionType,
      },
      executor: tx,
    });
    return {
      row: updated,
      metadata: nextMeta,
      executed: true,
      requesterSecretHandoff: executionOutput.requesterSecretHandoff,
      postCommitChannelPublish: executionOutput.postCommitChannelPublish,
    };
  });

  if (args.io && result.executed && result.row) {
    await emitActionCardMessageUpdated(args.io, result.row);
  }

  // Run the deferred realtime broadcast AFTER the transaction committed. Both
  // branches are deferred: the public publish's cross-replica fanout
  // (fanoutWithAck waits for ACK) must not hold the transaction
  // idle-in-transaction, and the private local emits must not surface a channel
  // that could roll back. On rollback we never reach here, so neither happens.
  if (result.executed && result.postCommitChannelPublish && args.io) {
    const { channel, private: isPrivate, initialUserIds, userId } = result.postCommitChannelPublish;
    if (isPrivate) {
      args.io.to(`channel:${channel.id}`).emit("channel:updated", { channel });
      for (const uid of initialUserIds) {
        args.io.to(`user:${uid}`).emit("channel:updated", { channel });
      }
      args.io.to(`user:${userId}`).emit("channel:updated", { channel });
    } else {
      await publishChannelUpdate(args.io, channel);
    }
  }

  if (result.executed && result.row) {
    if (result.requesterSecretHandoff && args.orchestrator) {
      await deliverRequesterSecretHandoff(
        args.orchestrator,
        result.metadata.sourceServerId ?? args.serverId,
        preflight.requesterAgentId,
        result.requesterSecretHandoff,
      );
    }
    await postActionCardResultReply({
      io: args.io,
      orchestrator: args.orchestrator,
      messageId: args.messageId,
      confirmerUserId: args.userId,
      outcome: { kind: "executed", action: result.metadata.action, result: result.metadata.result },
    });
  }

  return { messageId: args.messageId, metadata: result.metadata };
}

// `mergeOverrides` removed — overrides were only relevant for agent:create's
// inline runtime/model/machineId dropdowns, which moved to the create
// dialog flow. v1 has no other action types that take overrides; revisit if
// new shapes need partial human edits at commit time.

export interface MarkExecutedArgs {
  messageId: string;
  serverId: ServerId;
  userId: string;
  /**
   * Result reference produced by the user-facing API the dialog called.
   * For agent:create this comes from the post-dialog createAgent response.
   */
  result: ActionCardResult;
  expectedConfirmationVersion?: number;
  io?: SocketServer | null;
  /**
   * Agent orchestrator — used to push a wake to the requesting agent so it
   * knows the action card was committed and what resource resulted (per
   * stdrc 2026-05-10 #proj-approval msg=9081c5f5: "Agent 应该收到一个推送
   * ... 这个推送里得包含最终实际创建的那个东西的一些信息").
   */
  orchestrator?: AgentOrchestrator | null;
}

function expectedResultKindForAction(action: ActionCardAction): ActionCardResult["kind"] {
  switch (action.type) {
    case "channel:create":
      return "channel";
    case "agent:create":
      return "agent";
    case "channel:add_member":
      return "channel-members";
    case "integration:approve_agent_login":
      throw new ActionCardError(
        409,
        "INLINE_EXECUTE_REQUIRED",
        "integration:approve_agent_login must be executed by the server action path, not marked executed by a dialog",
      );
    case "integration:install_marketplace_app":
    case "integration:register_app":
    case "integration:update_app_registration":
    case "integration:recover_app_owner":
      throw new ActionCardError(
        409,
        "INLINE_EXECUTE_REQUIRED",
        `${action.type} must be executed by the server action path, not marked executed by a dialog`,
      );
  }
}

function assertActionResultKindMatches(action: ActionCardAction, result: ActionCardResult): void {
  const expectedKind = expectedResultKindForAction(action);
  if (result.kind !== expectedKind) {
    throw new ActionCardError(
      400,
      "ACTION_RESULT_KIND_MISMATCH",
      `${action.type} action cards must be marked executed with a ${expectedKind} result`,
    );
  }
}

/**
 * Mark an action card as executed without performing the underlying action
 * — used by the dialog-driven flow (agent:create). The frontend opens the
 * regular CreateAgentDialog with prefilled name/description, the user picks
 * computer/runtime/model and clicks Create, the existing createAgent API
 * runs, and then the frontend calls this endpoint to mark the card consumed
 * + record the result reference (so the card flips to Done with a
 * "→ @scout" link).
 *
 * Idempotent: if state is already executed, returns the existing record.
 */
export async function markActionCardExecuted(args: MarkExecutedArgs): Promise<{
  messageId: string;
  metadata: ActionCardMetadata;
}> {
  await assertActionCardVisibleToUser(args);
  const db = getDb();
  const userName = await loadUserDisplayName(args.userId);
  const result = await db.transaction(async (tx) => {
    // A converted card's confirmation is required even for an idempotent
    // mark call.  Keep this read under the canonical source lock so the
    // route cannot observe a stale version and then mutate the card.
    const lockedConfirmationVersion = await assertActionCardConfirmationInTransaction(
      tx,
      args.messageId,
      args.expectedConfirmationVersion,
    );
    const [row] = await tx.select().from(messages).where(eq(messages.id, args.messageId));
    if (!row) {
      throw new ActionCardError(404, "NOT_FOUND", "Card message not found");
    }
    const meta = (row.actionMetadata ?? null) as Partial<ActionCardMetadata> | null;
    if (!meta || meta.kind !== "action-card") {
      throw new ActionCardError(400, "NOT_ACTION_CARD", "Message is not an action card");
    }
    const targetServerId = await assertActionCardWritableByUser({
      messageId: args.messageId,
      channelId: row.channelId,
      serverId: args.serverId,
      userId: args.userId,
      executor: tx as ReturnType<typeof getDb>,
      lock: true,
    });
    if (meta.state === "executed") {
      return { row, metadata: meta as ActionCardMetadata, executed: false, confirmationVersion: lockedConfirmationVersion };
    }
    if (meta.state !== "prepared") {
      throw new ActionCardError(409, "BAD_STATE", `Card is ${meta.state}; cannot mark executed`);
    }
    await assertActionCardWritableInTransaction(tx, args.messageId, args.expectedConfirmationVersion);
    const action = meta.action as ActionCardAction;
    assertActionResultKindMatches(action, args.result);
    if (action.type === "agent:create") {
      if (!await actorHasServerCapabilityInServer(targetServerId, "user", args.userId, "createAgents", tx)) {
        throw new ActionCardError(
          403,
          "MISSING_CREATE_AGENTS_CAPABILITY",
          "The `createAgents` capability is required to commit this action card",
        );
      }
    }
    if (action.type === "channel:add_member" && args.result.kind === "channel-members") {
      if (args.result.channelId !== action.channel) {
        throw new ActionCardError(
          409,
          "CHANNEL_RESULT_MISMATCH",
          "Added-member result does not match the action card's target channel",
        );
      }
      await assertUserCanAddActionCardMembers({
        channelId: action.channel,
        serverId: targetServerId,
        userId: args.userId,
        executor: tx as ReturnType<typeof getDb>,
      });
      const humanIds = [...new Set(args.result.addedHumanIds)];
      const agentIds = [...new Set(args.result.addedAgentIds)];
      const [humanRows, agentRows] = await Promise.all([
        humanIds.length > 0
          ? tx.select({ id: channelHumans.userId }).from(channelHumans).where(and(
              eq(channelHumans.channelId, action.channel),
              inArray(channelHumans.userId, humanIds),
            ))
          : Promise.resolve([]),
        agentIds.length > 0
          ? tx.select({ id: channelAgents.agentId }).from(channelAgents).where(and(
              eq(channelAgents.channelId, action.channel),
              inArray(channelAgents.agentId, agentIds),
            ))
          : Promise.resolve([]),
      ]);
      if (humanRows.length !== humanIds.length || agentRows.length !== agentIds.length) {
        throw new ActionCardError(
          409,
          "MEMBERSHIP_RESULT_MISMATCH",
          "One or more reported channel members were not added",
        );
      }
    }
    if (
      action.type === "agent:create"
      && action.requiredComputer
      && args.result.kind === "agent"
    ) {
      const [createdAgent] = await tx
        .select({
          id: agents.id,
          serverId: agents.serverId,
          machineId: agents.machineId,
        })
        .from(agents)
        .where(eq(agents.id, args.result.id));
      if (!createdAgent || createdAgent.serverId !== targetServerId) {
        throw new ActionCardError(404, "AGENT_NOT_FOUND", "Created agent not found in this server");
      }
      if (createdAgent.machineId !== action.requiredComputer) {
        throw new ActionCardError(
          409,
          "REQUIRED_COMPUTER_MISMATCH",
          "Created agent does not match the action card's required computer",
        );
      }
    }
    const nextMeta: ActionCardMetadata = {
      kind: "action-card",
    sourceServerId: targetServerId,
      action,
      presentation: buildActionCardPresentation(action),
      state: "executed",
      executedAt: new Date().toISOString(),
      executedByUserId: args.userId,
      executedByUserName: userName,
      result: args.result,
    };
    await tx
      .update(actionCards)
      .set({
        state: "executed",
        executedAt: new Date(),
        executedByUserId: args.userId,
        result: args.result as unknown as object,
        updatedAt: new Date(),
      })
      .where(eq(actionCards.messageId, args.messageId));
    const [updated] = await tx
      .update(messages)
      .set({ actionMetadata: nextMeta, updatedAt: new Date() })
      .where(eq(messages.id, args.messageId))
      .returning();
    if (updated) {
      const [cardRow] = await tx.select({ id: actionCards.id })
        .from(actionCards).where(eq(actionCards.messageId, args.messageId)).limit(1);
      if (!cardRow) throw new ActionCardError(404, "NOT_FOUND", "Action card row not found");
      await productEventsService.recordActionCardEvent({
        cardId: cardRow.id,
        eventType: "action_card.execute_success",
        actor: { type: "human", id: args.userId },
        source: "server",
        metadata: {
          action_type: action.type,
        },
        executor: tx,
      });
    }
    return { row: updated, metadata: nextMeta, executed: true };
  });

  if (args.io && result.executed && result.row) {
    await emitActionCardMessageUpdated(args.io, result.row);
  }

  // Wake the requesting agent so it knows the card was committed and what
  // resource was produced. Per stdrc 2026-05-10 #proj-approval msg=9081c5f5:
  // include the *actual* created resource info (since the user may have
  // edited the agent's prefill before submitting the dialog).
  if (result.executed && result.row) {
    await postActionCardResultReply({
      io: args.io,
      orchestrator: args.orchestrator,
      messageId: args.messageId,
      confirmerUserId: args.userId,
      outcome: { kind: "executed", action: result.metadata.action, result: result.metadata.result },
    });
  }

  return { messageId: args.messageId, metadata: result.metadata };
}

function describeActionCardResult(result: ActionCardResult, action: ActionCardAction): string {
  switch (result.kind) {
    case "channel": {
      const visibility = action.type === "channel:create" && action.visibility === "private" ? " (private)" : "";
      return `created channel #${result.name}${visibility} (id ${result.id.slice(0, 8)})`;
    }
    case "agent":
      return `created agent @${result.name} (id ${result.id.slice(0, 8)})`;
    case "channel-members": {
      const count = new Set([...result.addedHumanIds, ...result.addedAgentIds]).size;
      return `added ${count} member${count === 1 ? "" : "s"} to #${result.channelName}`;
    }
    case "agent-integration-login":
      return `approved the Agent Login request for ${result.clientName}; rerun \`raft integration login --service ${result.clientKey}\` and continue`;
    case "marketplace-app-installation":
      return `installed ${result.clientName} on this Server; rerun \`raft integration login --service ${result.clientKey}\` and continue`;
    case "integration-app-registration":
      return result.mode === "register"
        ? `registered Login with Raft app ${result.clientName} (${result.clientKey}). The one-time client secret is delivered only through a private notice to the owning agent and is never posted here; if you did not receive it, run \`raft integration app rotate-secret --client ${result.clientKey} --output <new-private-path>\` as the app owner`
        : `updated Login with Raft app ${result.clientName} (${result.clientKey})`;
    case "integration-app-owner-recovery":
      return `recovered ownership of ${result.clientName} (${result.clientKey}) for @${result.ownerAgentName}`;
  }
}

/**
 * Tell the preparing agent how its card resolved. The receipt is a durable
 * system reply in the card's own thread (the canonical Joint thread when the
 * card lives in a Joint channel) that @mentions the requester, so it rides the
 * ordinary mention path: an unread inbox fact + wake/notice push for managed
 * and external agents alike, replayable after a missed delivery. Humans in the
 * channel already see the card, so the reply is transparent to them.
 *
 * Never put secret material here — the reply is persisted chat history.
 */
async function postActionCardResultReply(input: {
  io: SocketServer | null | undefined;
  orchestrator: AgentOrchestrator | null | undefined;
  messageId: string;
  confirmerUserId: string;
  outcome:
    | { kind: "executed"; action: ActionCardAction; result: ActionCardResult | null | undefined }
    | { kind: "failed"; action: ActionCardAction; reason: string };
}): Promise<void> {
  if (!input.io || !input.orchestrator) return;
  try {
    const db = getDb();
    const [card] = await db.select({
      requesterAgentId: actionCards.requesterAgentId,
      serverId: actionCards.serverId,
      carrierChannelId: messages.channelId,
    }).from(actionCards)
      .innerJoin(messages, eq(messages.id, actionCards.messageId))
      .where(eq(actionCards.messageId, input.messageId))
      .limit(1);
    if (!card) return;
    const [requester] = await db.select({ id: agents.id, name: agents.name, deletedAt: agents.deletedAt })
      .from(agents).where(eq(agents.id, card.requesterAgentId)).limit(1);
    if (!requester || requester.deletedAt) return;
    const carrierChannel = await channelService.getChannel(card.carrierChannelId);
    if (!carrierChannel) return;
    // Reply on the requester's own (target-server) surface; for Joint carriers
    // this persists into canonical storage and projects to every peer.
    const localCarrierChannelId = await resolveActionCardLocalChannelId(card.carrierChannelId, card.serverId, db);
    if (!localCarrierChannelId) return;
    let threadChannelId: string;
    let threadParentMessageId: string;
    if (carrierChannel.type === "thread") {
      if (!carrierChannel.parentMessageId) return;
      threadChannelId = localCarrierChannelId;
      threadParentMessageId = carrierChannel.parentMessageId;
    } else {
      const thread = await channelService.getOrCreateThreadForChannel(
        localCarrierChannelId,
        input.messageId,
        input.confirmerUserId,
        "user",
      );
      threadChannelId = thread.id;
      threadParentMessageId = input.messageId;
    }
    // Delivery to an agent in a thread follows thread attention; start (or
    // revive) the requester's follow at the current tail so this reply is the
    // unread item that wakes it.
    await channelService.recordThreadFollow(
      "agent",
      requester.id,
      threadChannelId,
      threadParentMessageId,
      "mentioned",
      { reactivateUnfollowed: true, preserveExistingReason: true, joinedThroughSeq: "latest" },
    );

    const [confirmer] = await db.select({ name: users.name, displayName: users.displayName })
      .from(users).where(eq(users.id, input.confirmerUserId)).limit(1);
    const confirmerRef = confirmer?.name ? `@${confirmer.name}` : (confirmer?.displayName ?? "a human");
    const targetServer = await serverService.getServer(card.serverId);
    const serverLabel = targetServer?.name ? ` on ${targetServer.name}` : "";
    const cardRef = `\`${input.messageId.slice(0, 8)}\` (${summarize(input.outcome.action)})`;
    const content = input.outcome.kind === "executed"
      ? [
          `@${requester.name} your action card ${cardRef} was executed by ${confirmerRef}${serverLabel}, acting with ${confirmerRef}'s permissions.`,
          input.outcome.result ? `Result: ${describeActionCardResult(input.outcome.result, input.outcome.action)}.` : null,
        ].filter((line): line is string => line !== null).join("\n")
      : `@${requester.name} your action card ${cardRef} failed when ${confirmerRef} tried to execute it${serverLabel}: ${input.outcome.reason}. The card is still pending and can be retried.`;

    await messageService.broadcastSystemMessageToLocalSurfaces(input.io, input.orchestrator, threadChannelId, content, {
      inboxFactPolicy: {
        mode: "record",
        producer: "action_card.result_reply",
        reason: "the preparing agent must learn how its action card resolved",
        causalActor: { type: "user", id: input.confirmerUserId },
      },
      personalAttentionTargets: [{ type: "agent", id: requester.id, name: requester.name }],
    });
  } catch (err) {
    console.error("[actionCards] failed to post result reply to requester:", err instanceof Error ? err.message : "unknown error");
  }
}

/**
 * Show-once secret handoff for an app registration. This is the only transient
 * requester notice left: the secret must never be persisted, so it cannot ride
 * the durable result reply. Managed agents receive it on their live session;
 * external runtimes have no transient channel and recover via owner rotation.
 */
async function deliverRequesterSecretHandoff(
  orchestrator: AgentOrchestrator,
  serverId: string,
  requesterAgentId: string,
  secretHandoff: IntegrationAppSecretHandoff,
): Promise<void> {
  const content = [
    `Private one-time client secret for Login with Raft app ${secretHandoff.clientName} (${secretHandoff.clientKey}). Store it now and never paste it into a public channel.`,
    `client_id: ${secretHandoff.clientKey}`,
    `client_secret: ${secretHandoff.clientSecret}`,
    `If you miss or lose this value, run \`raft integration app rotate-secret --client ${secretHandoff.clientKey} --output <new-private-path>\` as the app owner; that writes a replacement only to the new private file and invalidates the previous secret.`,
  ].join("\n");
  try {
    await messageService.deliverSystemNoticeToAgent(orchestrator, requesterAgentId, {
      serverId,
      channel_id: "action-cards",
      channel_name: "action-cards",
      channel_type: "channel",
      content,
    }, { transient: true });
  } catch {
    // Do not log the thrown value: transport errors can embed the payload.
    console.error("[actionCards] failed to wake requester on executed");
  }
}

async function loadUserDisplayName(userId: string): Promise<string | null> {
  const db = getDb();
  const { users } = await import("../db/schema");
  const [u] = await db
    .select({ name: users.name, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId));
  return u?.displayName ?? u?.name ?? null;
}

function scopesEqual(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((value, idx) => value === right[idx]);
}

async function assertUserCanManageIntegrations(
  dbOrTx: ReturnType<typeof getDb>,
  serverId: string,
  userId: string,
): Promise<void> {
  const [member] = await dbOrTx
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.userId, userId),
    ))
    .limit(1);
  if (!member) {
    throw new ActionCardError(403, "NOT_A_MEMBER", "You are not a member of this server");
  }
  if (!actorRoleHasServerCapability(member.role, "manageIntegrations")) {
    throw new ActionCardError(
      403,
      "FORBIDDEN",
      "Only server owners/admins can manage app registrations",
    );
  }
}

function isUnsafeDemoHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 6) {
    if (host === "::1") return true;
    const firstHextet = Number.parseInt(host.split(":")[0] ?? "", 16);
    return Number.isInteger(firstHextet)
      && (((firstHextet & 0xfe00) === 0xfc00) || ((firstHextet & 0xffc0) === 0xfe80));
  }
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

export function validateIntegrationUrl(raw: string | null | undefined, field: string, unsafeDemoUrlOverride?: boolean): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ActionCardError(400, "INVALID_URL", `${field} must be a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ActionCardError(400, "INVALID_URL", `${field} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new ActionCardError(400, "INVALID_URL", `${field} must not include credentials`);
  }
  if (isUnsafeDemoHost(parsed.hostname) && !unsafeDemoUrlOverride) {
    throw new ActionCardError(
      400,
      "UNSAFE_DEMO_URL_REQUIRES_OVERRIDE",
      `${field} points at localhost or a private address; re-prepare with unsafeDemoUrlOverride if this is an explicit demo`,
    );
  }
  return parsed.toString();
}

async function performAction(
  serverId: string,
  userId: string,
  requesterAgentId: string,
  action: ActionCardAction,
  io: SocketServer | null | undefined = null,
  dbOrTx: ReturnType<typeof getDb> = getDb(),
  actionCardContext?: { messageId: string; confirmationVersion: number },
): Promise<PerformActionOutput> {
  if (action.type === "integration:install_marketplace_app") {
    await assertUserCanManageIntegrations(dbOrTx, serverId, userId);
    if (requesterAgentId !== action.agentId) {
      throw new ActionCardError(409, "REQUESTER_MISMATCH", "Install card requester no longer matches the requesting agent");
    }
    const [binding] = await dbOrTx
      .select({
        clientId: oauthClients.id,
        clientKey: oauthClients.clientId,
        clientName: oauthClients.name,
        clientAllowedScopes: oauthClients.allowedScopes,
        agentId: agents.id,
        agentName: agents.name,
        agentDisplayName: agents.displayName,
      })
      .from(oauthClients)
      .innerJoin(agents, and(
        eq(agents.id, action.agentId),
        eq(agents.serverId, serverId),
        isNull(agents.deletedAt),
      ))
      .where(and(
        eq(oauthClients.id, action.clientId),
        eq(oauthClients.clientId, action.clientKey),
        eq(oauthClients.appType, "third_party_global"),
        eq(oauthClients.enabled, true),
        oauthClientIsUserManagedPredicate(),
        eq(oauthClients.humanMarketplaceVisible, true),
        sql`${oauthClients.publishStatus} in ('published', 'unpublish_requested')`,
      ))
      .limit(1);
    if (!binding) {
      throw new ActionCardError(409, "MARKETPLACE_APP_CHANGED", "Marketplace app is no longer installable with this card; prepare a fresh login request");
    }
    const currentNameBinding = bindMarketplaceAppName(binding.clientName);
    if (
      currentNameBinding.clientNameSha256 !== action.clientNameSha256
      || currentNameBinding.clientName !== action.clientName
    ) {
      throw new ActionCardError(409, "MARKETPLACE_APP_CHANGED", "Marketplace app identity changed; prepare a fresh login request");
    }
    if ((binding.agentDisplayName ?? binding.agentName) !== action.agentName) {
      throw new ActionCardError(409, "AGENT_BINDING_CHANGED", "Requesting agent identity changed; prepare a fresh login request");
    }
    const normalizedAllowedScopes = new Set(
      binding.clientAllowedScopes?.length
        ? binding.clientAllowedScopes
        : oauthService.defaultAgentLoginScopes({ allowedScopes: binding.clientAllowedScopes }),
    );
    if (action.scopes.some((scope) => !normalizedAllowedScopes.has(scope))) {
      throw new ActionCardError(409, "SCOPE_BINDING_CHANGED", "Requested scopes are no longer allowed; prepare a fresh login request");
    }
    const installed = await oauthService.installMarketplaceOAuthClient({
      serverId,
      clientId: action.clientId,
      installedByUserId: userId,
    }, dbOrTx);
    if (!installed) {
      throw new ActionCardError(409, "MARKETPLACE_APP_CHANGED", "Marketplace app is no longer installable with this card; prepare a fresh login request");
    }
    return {
      result: {
        kind: "marketplace-app-installation",
        clientId: binding.clientId,
        clientKey: binding.clientKey,
        clientName: action.clientName,
        serverId,
        agentId: binding.agentId,
        agentName: binding.agentDisplayName ?? binding.agentName,
        scopes: action.scopes,
      },
    };
  }
  if (action.type === "integration:approve_agent_login") {
    const [member] = await dbOrTx
      .select({ role: serverMembers.role })
      .from(serverMembers)
      .where(and(
        eq(serverMembers.serverId, serverId),
        eq(serverMembers.userId, userId),
      ))
      .limit(1);
    if (!member) {
      throw new ActionCardError(403, "NOT_A_MEMBER", "You are not a member of this server");
    }
    if (!actorRoleHasServerCapability(member.role, "manageExternalAuth")) {
      throw new ActionCardError(
        403,
        "FORBIDDEN",
        "Only server owners/admins can approve agent app login requests",
      );
    }

    const [row] = await dbOrTx
      .select({
        requestId: oauthAccessRequests.id,
        requestStatus: oauthAccessRequests.status,
        requestScopes: oauthAccessRequests.scopes,
        agentId: agents.id,
        agentName: agents.name,
        agentDisplayName: agents.displayName,
        clientId: oauthClients.id,
        clientName: oauthClients.name,
        clientKey: oauthClients.clientId,
      })
      .from(oauthAccessRequests)
      .innerJoin(agents, eq(agents.id, oauthAccessRequests.agentId))
      .innerJoin(oauthClients, eq(oauthClients.id, oauthAccessRequests.clientId))
      .where(and(
        eq(oauthAccessRequests.id, action.requestId),
        eq(oauthAccessRequests.serverId, serverId),
        eq(oauthAccessRequests.agentId, action.agentId),
        eq(oauthAccessRequests.clientId, action.clientId),
        oauthClientIsUserManagedPredicate(),
      ))
      .limit(1);

    if (!row) {
      throw new ActionCardError(404, "REQUEST_NOT_FOUND", "Agent app login request not found");
    }
    if (row.requestStatus === "denied") {
      throw new ActionCardError(409, "REQUEST_DENIED", "Agent app login request was denied");
    }

    let grantId: string | null = null;
    let approvedRequest = {
      id: row.requestId,
      scopes: row.requestScopes,
    };
    if (row.requestStatus === "pending") {
      const existingGrants = await dbOrTx.select().from(oauthGrants).where(and(
        eq(oauthGrants.serverId, serverId),
        eq(oauthGrants.agentId, row.agentId),
        eq(oauthGrants.clientId, row.clientId),
        isNull(oauthGrants.revokedAt),
      ));
      const matched = existingGrants.find((grant) => scopesEqual(grant.scopes ?? [], row.requestScopes ?? []));
      if (matched) {
        grantId = matched.id;
      } else {
        const [grant] = await dbOrTx.insert(oauthGrants).values({
          serverId,
          agentId: row.agentId,
          clientId: row.clientId,
          scopes: row.requestScopes,
          grantedByUserId: userId,
          grantSource: "person",
        }).returning();
        grantId = grant.id;
      }
      await oauthService.clearAgentAutoGrantBlock(dbOrTx, row.agentId, row.clientId);

      const [updated] = await dbOrTx.update(oauthAccessRequests).set({
        status: "approved",
        remember: true,
        resolvedByUserId: userId,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(oauthAccessRequests.id, row.requestId)).returning();
      approvedRequest = {
        id: updated.id,
        scopes: updated.scopes,
      };
    }

    return {
      result: {
        kind: "agent-integration-login",
        requestId: approvedRequest.id,
        agentId: row.agentId,
        agentName: row.agentDisplayName ?? row.agentName,
        clientId: row.clientId,
        clientKey: row.clientKey,
        clientName: row.clientName,
        scopes: approvedRequest.scopes ?? row.requestScopes ?? [],
        grantId,
      },
    };
  }
  if (action.type === "integration:register_app") {
    await assertUserCanManageIntegrations(dbOrTx, serverId, userId);
    if (action.clientKey) {
      const [existing] = await dbOrTx
        .select({ id: oauthClients.id })
        .from(oauthClients)
        .where(eq(oauthClients.clientId, action.clientKey))
        .limit(1);
      if (existing) {
        throw new ActionCardError(
          409,
          "CLIENT_KEY_TAKEN",
          "Client key is already taken; re-prepare with a different client key",
        );
      }
    }
    const homepageUrl = validateIntegrationUrl(action.homepageUrl, "homepageUrl", action.unsafeDemoUrlOverride);
    const returnUrl = validateIntegrationUrl(action.returnUrl, "returnUrl", action.unsafeDemoUrlOverride);
    const agentManifestUrl = validateIntegrationUrl(action.agentManifestUrl, "agentManifestUrl", action.unsafeDemoUrlOverride);
    if (!returnUrl) {
      throw new ActionCardError(400, "INVALID_URL", "returnUrl is required");
    }
    const created = await oauthService.createOAuthClient({
      serverId,
      createdByUserId: userId,
      name: action.name,
      description: action.description,
      category: action.category,
      homepageUrl,
      returnUrl,
      agentManifestUrl,
      clientId: action.clientKey,
      allowedScopes: action.scopes.length > 0 ? action.scopes : undefined,
    }, dbOrTx);
    return {
      result: {
        kind: "integration-app-registration",
        mode: "register",
        clientId: created.client.id,
        clientKey: created.client.clientId,
        clientName: created.client.name,
        returnUrl: created.client.returnUrl,
        homepageUrl: created.client.homepageUrl,
        agentManifestUrl: created.client.agentManifestUrl,
        scopes: action.scopes ?? [],
        unsafeDemoUrlOverride: action.unsafeDemoUrlOverride,
      },
      // task #137: carry plaintext only in-memory until the post-commit private
      // transient owner wake. Persisted action-card/audit/message state remains
      // secret-free, while owner-scoped rotate-secret stays the recovery path.
      requesterSecretHandoff: {
        kind: "integration-app-secret",
        clientId: created.client.id,
        clientKey: created.client.clientId,
        clientName: created.client.name,
        clientSecret: created.clientSecret,
      },
    };
  }
  if (action.type === "integration:recover_app_owner") {
    await assertUserCanManageIntegrations(dbOrTx, serverId, userId);
    const [client] = await dbOrTx
      .select({ id: oauthClients.id, clientId: oauthClients.clientId, name: oauthClients.name })
      .from(oauthClients)
      .where(and(
        eq(oauthClients.serverId, serverId),
        eq(oauthClients.clientId, action.clientKey),
        eq(oauthClients.appType, "server_local"),
      ))
      .limit(1)
      .for("update");
    if (!client) {
      throw new ActionCardError(404, "CLIENT_NOT_FOUND", "Server-local app registration not found for this client key");
    }

    const [targetAgent] = await dbOrTx
      .select({ id: agents.id, name: agents.name, displayName: agents.displayName })
      .from(agents)
      .where(and(
        eq(agents.id, action.targetAgent),
        eq(agents.serverId, serverId),
        isNull(agents.deletedAt),
      ))
      .limit(1);
    if (!targetAgent) {
      throw new ActionCardError(404, "TARGET_AGENT_NOT_FOUND", "Recovery target agent is not active in this server");
    }

    const [currentOwner] = await dbOrTx
      .select({
        id: oauthClientMaintainers.id,
        principalType: oauthClientMaintainers.principalType,
        agentId: oauthClientMaintainers.agentId,
      })
      .from(oauthClientMaintainers)
      .where(and(
        eq(oauthClientMaintainers.clientId, client.id),
        eq(oauthClientMaintainers.role, "owner"),
        isNull(oauthClientMaintainers.revokedAt),
      ))
      .limit(1);

    if (currentOwner?.principalType === "human") {
      throw new ActionCardError(409, "APP_OWNER_ACTIVE", "This app has an active owner; ask the owner to transfer it directly");
    }
    if (currentOwner?.agentId) {
      const [ownerAgent] = await dbOrTx
        .select({ deletedAt: agents.deletedAt })
        .from(agents)
        .where(and(eq(agents.id, currentOwner.agentId), eq(agents.serverId, serverId)))
        .limit(1);
      if (ownerAgent && ownerAgent.deletedAt === null) {
        throw new ActionCardError(409, "APP_OWNER_ACTIVE", "This app has an active owner; ask the owner to transfer it directly");
      }
    }

    const transferredAt = sql`now()`;
    if (currentOwner) {
      await dbOrTx
        .update(oauthClientMaintainers)
        .set({ revokedAt: transferredAt })
        .where(eq(oauthClientMaintainers.id, currentOwner.id));
    }
    await dbOrTx.insert(oauthClientMaintainers).values({
      clientId: client.id,
      principalType: "agent",
      agentId: targetAgent.id,
      role: "owner",
      assignedByType: "human",
      assignedById: userId,
      assignedAt: transferredAt,
    });
    await dbOrTx
      .update(oauthClients)
      .set({ ownerAgentId: targetAgent.id, updatedAt: transferredAt })
      .where(eq(oauthClients.id, client.id));
    await integrationAuditService.recordIntegrationAuditEvent({
      serverId,
      clientId: client.id,
      eventType: "app.owner_transferred",
      outcome: "success",
      source: "action_card",
      actor: { type: "human", id: userId },
      subject: { type: "app", id: client.id },
      target: { type: "agent", id: targetAgent.id },
      metadata: {
        clientKey: client.clientId,
        previousOwnerType: currentOwner?.principalType ?? null,
        previousOwnerId: currentOwner?.agentId ?? null,
        nextOwnerType: "agent",
        nextOwnerId: targetAgent.id,
        recovery: true,
      },
    }, dbOrTx);
    return {
      result: {
        kind: "integration-app-owner-recovery",
        clientId: client.id,
        clientKey: client.clientId,
        clientName: client.name,
        ownerAgentId: targetAgent.id,
        ownerAgentName: targetAgent.displayName ?? targetAgent.name,
      },
    };
  }
  if (action.type === "integration:update_app_registration") {
    throw new ActionCardError(
      410,
      "LEGACY_APP_UPDATE_DISABLED",
      "App registration update cards are disabled; the app owner must use the direct integration app update command",
    );
  }
  // Authorization: each action checks the caller is allowed to perform it as
  // a regular user in this server. We deliberately don't require admin role
  // here — the *operations* a card can prepare are the same things the user
  // could do via UI without special elevation. If we later add operations
  // gated to admin (e.g. delete channel), enforce via `requireServerRole`
  // before performing.
  const isMember = (await resolveActorContext(serverId, "user", userId, dbOrTx)).serverRole;
  if (!isMember) {
    throw new ActionCardError(403, "NOT_A_MEMBER", "You are not a member of this server");
  }

  switch (action.type) {
    case "channel:create": {
      let channelPublicToPublish: { channel: { id: string; serverId: string } & Record<string, unknown>; private: boolean; initialUserIds: string[]; userId: string } | undefined;
      const channelType = action.visibility === "private" ? "private" : "channel";
      const initialUserIds: string[] = [];
      for (const uid of [...new Set(action.initialHumans ?? [])]) {
        if (uid !== userId && (await resolveActorContext(serverId, "user", uid, dbOrTx)).serverRole) initialUserIds.push(uid);
      }
      const initialAgentIds: string[] = [];
      for (const aid of [...new Set(action.initialAgents ?? [])]) {
        const [agent] = await dbOrTx.select().from(agents).where(eq(agents.id, aid)).limit(1);
        if (agent?.serverId === serverId && !agent.deletedAt) initialAgentIds.push(aid);
      }
      const channel = await channelService.createChannel(
        serverId,
        action.name,
        action.description,
        channelType,
        {
          type: "user",
          id: userId,
          initialUserIds,
          initialAgentIds,
          executor: dbOrTx,
          actionCardMessageId: actionCardContext?.messageId,
          actionCardConfirmationVersion: actionCardContext?.confirmationVersion,
        },
      );
      // Mirror the broadcasts that POST /api/channels emits, per stdrc
      // contract: "the click path should be identical to filling the form
      // and submitting" (#proj-approval msg=2cff5887). Defer BOTH branches to
      // after commit: the public publish's cross-replica fanout (fanoutWithAck
      // waits for ACK) must not hold the transaction idle-in-transaction, and
      // the private local emits must not surface a channel that could roll back.
      channelPublicToPublish = {
        channel: { ...channel, joined: true },
        private: channel.type === "private",
        initialUserIds,
        userId,
      };
      return { result: { kind: "channel", id: channel.id, name: channel.name }, postCommitChannelPublish: channelPublicToPublish };
    }
    case "agent:create": {
      // agent:create is NOT one-click executable: the agent only proposes
      // semantic intent (name + description); technical fields (computer /
      // runtime / model) are user prerogatives and must be picked in the
      // CreateAgentDialog. The frontend opens that dialog when the user
      // clicks "Create Agent" on the card; after dialog success, the
      // frontend calls `/api/actions/:msgId/mark-executed` to mark the
      // card consumed. Per stdrc 2026-05-10 #proj-approval msg=cf3ba1b7:
      // "对于 Create agent 这种需要进一步让用户自己决策的，应该是点了
      // 按钮之后弹窗，让用户继续填".
      void io;
      throw new ActionCardError(
        409,
        "DIALOG_REQUIRED",
        "agent:create requires the create-agent dialog to pick computer/runtime/model; frontend should open the dialog and call mark-executed after success.",
      );
    }
    case "channel:add_member": {
      // channel:add_member follows the same dialog-driven contract as
      // agent:create — the agent only proposes a list, the human reviews
      // and confirms in `<AddMembersDialog>`, and the frontend calls
      // /api/actions/:msgId/mark-executed after the existing channel
      // /members endpoints succeed. Server-side execute is never called
      // for this action type.
      void io;
      throw new ActionCardError(
        409,
        "DIALOG_REQUIRED",
        "channel:add_member requires the add-members dialog so the human can review the prefilled list; frontend should open the dialog and call mark-executed after the add-members API succeeds.",
      );
    }
  }
}

function summarize(action: ActionCardAction): string {
  switch (action.type) {
    case "channel:create": {
      const vis = action.visibility === "private" ? " (private)" : "";
      return `Operation: create channel #${action.name}${vis}`;
    }
    case "agent:create":
      return `Operation: create agent @${action.name}`;
    case "channel:add_member": {
      const humanCount = action.humans?.length ?? 0;
      const agentCount = action.agents?.length ?? 0;
      const parts: string[] = [];
      if (humanCount > 0) parts.push(`${humanCount} human${humanCount === 1 ? "" : "s"}`);
      if (agentCount > 0) parts.push(`${agentCount} agent${agentCount === 1 ? "" : "s"}`);
      return `Operation: add ${parts.join(" + ") || "members"} to a channel`;
    }
    case "integration:approve_agent_login":
      return `Operation: approve ${action.clientName} for @${action.agentName}`;
    case "integration:install_marketplace_app":
      return `Operation: install Marketplace app ${action.clientName} (${action.clientKey}) on this Server`;
    case "integration:register_app":
      return `Operation: register Login with Raft app ${action.name} (${action.clientKey ?? "auto-generated client key"})`;
    case "integration:update_app_registration":
      return `Operation: update Login with Raft app ${action.clientKey}`;
    case "integration:recover_app_owner":
      return `Operation: recover Login with Raft app ${action.clientKey} ownership`;
  }
}
