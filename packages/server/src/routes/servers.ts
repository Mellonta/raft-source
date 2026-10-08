import { DISTRIBUTION_POLICY } from "@botiverse/raft-shared";
import { Router, type Request, type RequestHandler, type Router as RouterType } from "express";
import { kickAppNotificationDelivery } from "../services/appNotificationDeliveryService";
import multer from "multer";
import { randomUUID } from "node:crypto";
import type { Server as SocketServer } from "socket.io";
import { and, eq, inArray, isNull } from "drizzle-orm";
import * as serverService from "../services/serverService";
import * as machineService from "../services/machineService";
import * as agentService from "../services/agentService";
import * as channelService from "../services/channelService";
import * as inviteService from "../services/inviteService";
import * as onboardingService from "../services/onboardingService";
import * as userService from "../services/userService";
import * as serverAgreementService from "../services/serverAgreementService";
import { countAgents, countMachines, countChannels, getHistoryCutoff, HumanSeatLimitError } from "../services/planService";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { planMentionRedriveHttpStatus } from "../services/agentOrchestrator";
import { buildMachineReadModel } from "../services/machineReadModel";
import {
  getComputerLinkedMachineAttachers,
  getComputerLinkedMachineCreators,
  getComputerLinkedMachineIds,
} from "../services/computerCredentialService";
import { getLatestComputerReleaseNotes, getLatestComputerVersion } from "../services/computerVersionService";
import {
  evaluateBroadcastPolicy,
  normalizeComputerPlatform,
  projectComputerBroadcastPolicyDecision,
  type ComputerBroadcastPolicyDecision,
  type ComputerSourceFact,
} from "../services/computerBroadcastPolicyService";
import {
  buildServerSystemNotificationsResponse,
  projectMachineSystemNotifications,
} from "../services/systemNotificationService";
import { createUserComputerLifecycleOperation, markComputerLifecycleCommandSent } from "../services/computerLifecycleOperationService";
import { isTranslationProviderConfigured } from "../services/messageTranslationService";
import { isReceiverStatePushEnabled } from "../services/receiverStatePushService";
import { getServerSettings } from "../services/serverSettingsService";
import { projectServerPublicProfile } from "../services/serverProfileProjection";
import {
  createServerSetupStateService,
  DrizzleServerSetupStateRepository,
  resolveServerSetupLiveFacts,
  resetServerSetup,
  ServerSetupStateError,
  type ServerSetupAction,
} from "../services/serverSetupStateService";
import { hasServerCompletedSetupForProjection } from "../services/serverSetupCompletionService";
import { handleMachineLocalRouting, sendMachineAffinityUnavailable } from "../machineLocalReplay";
import {
  isRemoteUpgradeSupported, asMachineId, COMPOSER_RESOURCE_REFERENCES_FEATURE_FLAG_KEY, COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS, currentDate, INVALID_EMAIL_MESSAGE, PUBLIC_SERVER_FEATURE_FLAG_KEY, RUNTIME_ACCOUNT_USAGE_PROVIDERS, SERVER_GUEST_FEATURE_FLAG_KEY, SERVER_SYSTEM_NOTIFICATIONS_CONTRACT_VERSION, validateEmailAddress, validateNewServerSlug, type RuntimeAccountUsageProvider, type ServerCapability, type ServerModelLabelCatalog, type ServerPlan, type ServerRole } from "@botiverse/raft-shared";
import { releasedRuntimeFormDefinition } from "@botiverse/raft-runtime-form";
import { canInspectAgentPrivateSurfaces } from "./agents";
import { actorRoleHasServerCapability, getActorServerRoleInServer } from "../lib/actorPermissions";
import { FencedAuthorizationDeniedError, ServerMembershipRevokedError, withActorMembershipFence } from "../lib/actorMembershipFence";
import { createScopeAttestation } from "../lib/scopeAttestation";
import { getDb } from "../db/index";
import { agents as agentsTable, channelAgents, channelHumans, channels, computerLifecycleOperations, machines as machinesTable, servers } from "../db/schema";
import { requireServerMatchesParam } from "../middleware/auth";
import { addTraceEvent, createTraceDbQueryTracer, errorClassOf, tracePhase } from "../tracing/semanticTrace";
import { traceRouteFailure } from "../tracing/routeFailure";
import { respondToRisingWaveOverload, sendJsonServerError } from "./errorResponse";
import type { DbQueryTracer } from "../tracing/dbQueryTrace";
import {
  createAvatarUpload,
  MAX_PROFILE_AVATAR_BYTES,
  PROFILE_AVATAR_BAD_FORMAT_MESSAGE,
  PROFILE_AVATAR_TOO_LARGE_MESSAGE,
  runSingleAvatarUpload,
  storeServerAvatar,
} from "../services/avatarService";
import {
  projectNewAgentRuntimeOptions,
  resolveRuntimeAdmissionPolicy,
} from "../services/runtimeAdmissionService";
import { serverLabsRouter } from "./serverLabs";
import { runtimeFormV1Entry } from "../services/runtimeFormDefinitionService";
import { runtimeFormV2Entry } from "../services/runtimeFormV2Registry";
import { BuiltInModelCatalogError } from "../services/builtinModelCatalogCompatibility";
import { evaluateFeatureFlag, REMOTE_COMPUTER_UPGRADE_V2_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import {
  createComputerUpgradeRequest,
  listLatestComputerUpgradeRequests,
  projectComputerUpgradeRequest,
} from "../services/computerUpgradeRequestService";
import { RouteFailureError } from "../tracing/routeFailure";
import { computeActivityUnreadCounts } from "../services/activityUnreadSummaryService";
import { runtimeAccountUsageCacheService } from "../services/runtimeAccountUsageCacheService";
import { machineRuntimeModelCatalogService } from "../services/machineRuntimeModelCatalogService";
import { MachineCatalogStaleError } from "../services/machineCatalogAuthority";
import * as mentionDeliveryOccurrenceService from "../services/mentionDeliveryOccurrenceService";
import { listInstalledApps } from "../services/rapRegistryStore";
import { getBuiltInComposerReference } from "../services/rapBuiltinAppManifests";
import { UUID_RE } from "../lib/messageId";
import { guardUuidPathParams } from "../lib/uuidPathParams";

export const serverRouter: RouterType = Router();
// Uniform 404 for non-UUID path params (task #12). `messageId` on the
// diagnostic routes is deliberately excluded: those handlers answer a
// contract-shaped {status:"NOT_JOINABLE"} body, kept intact inline.
guardUuidPathParams(serverRouter, {
  id: "Server",
  inviteId: "Invite",
  linkId: "Join link",
  machineId: "Machine",
  agentId: "Agent",
  reportId: "Report",
});
const serverAvatarUpload = createAvatarUpload();

const SCOPE_ATTESTATION_TTL_MS = 10 * 60 * 1000;
const ONBOARDING_WIZARD_STEPS = new Set([
  "add-computer",
  "detect-runtime",
  "create-agent",
  "referral-source",
  "invite-teammates",
  "join-community",
  "enable-notifications",
  "complete",
]);
// `defer` is retired (task #172): the endpoint no longer accepts it, so the runtime never
// writes a new `deferred` row. A POST with action `defer` now returns INVALID_SETUP_ACTION.
const SERVER_SETUP_ACTIONS = new Set<ServerSetupAction>(["start", "complete"]);

type ComputerBroadcastPolicyEvaluator = (
  input: Parameters<typeof evaluateBroadcastPolicy>[0],
) => ComputerBroadcastPolicyDecision | Promise<ComputerBroadcastPolicyDecision>;

function computerBroadcastPolicyEvaluator(app: { get(name: string): unknown }): ComputerBroadcastPolicyEvaluator {
  return (app.get("computerBroadcastPolicyEvaluator") as ComputerBroadcastPolicyEvaluator | undefined)
    ?? evaluateBroadcastPolicy;
}

async function readComputerSourceFact(
  orchestrator: AgentOrchestrator,
  machineId: string,
): Promise<ComputerSourceFact | null> {
  if (typeof orchestrator.getMachineComputerVersionFact === "function") {
    return orchestrator.getMachineComputerVersionFact(machineId);
  }
  if (typeof orchestrator.getMachineComputerVersion !== "function") {
    return null;
  }
  const version = await orchestrator.getMachineComputerVersion(machineId);
  return { version, observedAt: null, provenance: null };
}

function snapshotComputerBroadcastPolicyDecision(
  decision: ComputerBroadcastPolicyDecision,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(decision)) as Record<string, unknown>;
}

function serverSetupErrorStatus(error: ServerSetupStateError): number {
  switch (error.code) {
    case "ACTOR_NOT_HUMAN":
    case "CROSS_USER_TRANSITION":
    case "INSUFFICIENT_PERMISSION":
      return 403;
    case "STATE_NOT_FOUND":
      return 404;
    case "OFFICIAL_ONBOARDING_AGENT_NOT_USABLE":
    case "SERVER_ALREADY_SET_UP":
      return 409;
    case "LIVE_FACTS_UNAVAILABLE":
      return 424;
  }
}

function routeServerSetupStateService(orchestrator: AgentOrchestrator) {
  return createServerSetupStateService({
    repository: new DrizzleServerSetupStateRepository(),
    resolveActorRole: (serverId, actor) => getActorServerRoleInServer(serverId, actor.type, actor.id),
    resolveServerCompleted: (serverId) => hasServerCompletedSetupForProjection(getDb(), serverId),
    resolveLiveFacts: (serverId, userId) => resolveServerSetupLiveFacts(serverId, userId, orchestrator),
  });
}

const LOCAL_COMPUTER_LIFECYCLE_ACTIONS = new Set(["start", "stop", "restart", "upgrade"] as const);

function canManageMachineResource(
  callerRole: ServerRole | null,
  userId: string,
  machine: { userId: string },
  capability: ServerCapability,
): boolean {
  return machine.userId === userId || actorRoleHasServerCapability(callerRole, capability);
}

function isRuntimeAccountUsageProvider(value: string): value is RuntimeAccountUsageProvider {
  return (RUNTIME_ACCOUNT_USAGE_PROVIDERS as readonly string[]).includes(value);
}

async function canInspectRuntimeAccountUsage(
  serverId: string,
  machineId: string,
  userId: string,
): Promise<boolean> {
  const [callerRole, attachers] = await Promise.all([
    getActorServerRoleInServer(serverId, "user", userId),
    getComputerLinkedMachineAttachers(serverId),
  ]);
  return attachers.get(machineId) === userId
    || actorRoleHasServerCapability(callerRole, "editMachines");
}

function serializeServerNotificationPrefs(prefs: serverService.MemberNotificationPreferences) {
  return {
    serverPushMuted: prefs.serverPushMuted,
    serverPushMentionsOnly: prefs.serverPushMentionsOnly,
    serverPushMode: prefs.serverPushMode,
  };
}

function emitServerNotificationPrefsUpdated(
  req: { app: { get(key: string): unknown }; params: { id: string }; userId?: string },
  prefs: serverService.MemberNotificationPreferences,
): void {
  if (!prefs.changed || !isReceiverStatePushEnabled()) return;
  const io = req.app.get("io") as SocketServer | undefined;
  io?.to(`user:${req.userId}`).emit("notification_prefs:updated", {
    serverId: req.params.id,
    scopeId: req.params.id,
    prefs: serializeServerNotificationPrefs(prefs),
    prefsVersion: prefs.prefsVersion,
  });
}

function emitServerOrderUpdated(
  req: { app: { get(key: string): unknown }; userId?: string },
  order: serverService.ServerSwitcherOrderPreferences,
): void {
  if (!req.userId || !isReceiverStatePushEnabled()) return;
  const io = req.app.get("io") as SocketServer | undefined;
  io?.to(`user:${req.userId}`).emit("server_order:updated", {
    serverIds: order.serverOrder,
    serverOrderVersion: order.serverOrderVersion,
  });
}

function emitPinnedUpdated(
  req: { app: { get(key: string): unknown }; userId?: string },
  order: serverService.SidebarOrderPreferences & { pinned: serverService.SidebarPinnedRef[] },
): void {
  if (!req.userId || !isReceiverStatePushEnabled()) return;
  const io = req.app.get("io") as SocketServer | undefined;
  io?.to(`user:${req.userId}`).emit("pinned:updated", {
    pinned: order.pinned,
    pinnedVersion: order.pinnedVersion,
  });
}

type CreateScopeAttestationRequest = {
  scope: string;
};

function normalizeOrderIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    if (seen.has(item)) continue;
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

function normalizePinnedRefs(value: unknown): serverService.SidebarPinnedRef[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const refs: serverService.SidebarPinnedRef[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      !("kind" in item) ||
      !("id" in item) ||
      (item.kind !== "channel" && item.kind !== "agent" && item.kind !== "human") ||
      typeof item.id !== "string"
    ) {
      return null;
    }
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind: item.kind, id: item.id });
  }
  return refs;
}

const MAX_SIDEBAR_CUSTOM_SECTIONS = 50;
const MAX_SIDEBAR_SECTION_PLACEMENTS = 1000;
function normalizeCustomSections(value: unknown): serverService.SidebarCustomSection[] | null {
  if (!Array.isArray(value) || value.length > MAX_SIDEBAR_CUSTOM_SECTIONS) return null;
  const seen = new Set<string>();
  const sections: serverService.SidebarCustomSection[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const raw = item as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (
      typeof raw.id !== "string"
      || raw.id.length === 0
      || raw.id.length > 80
      || raw.id.startsWith("system:")
      || name.length === 0
      || name.length > 80
      || (raw.emoji !== null && raw.emoji !== undefined && (typeof raw.emoji !== "string" || raw.emoji.length > 16))
      || typeof raw.sortMode !== "string"
      || !SIDEBAR_SORT_MODES.has(raw.sortMode)
      || seen.has(raw.id)
    ) return null;
    seen.add(raw.id);
    sections.push({
      id: raw.id,
      name,
      emoji: typeof raw.emoji === "string" && raw.emoji.length > 0 ? raw.emoji : null,
      sortMode: raw.sortMode as serverService.SidebarCustomSection["sortMode"],
    });
  }
  return sections;
}

function normalizeSectionPlacements(value: unknown): serverService.SidebarSectionPlacement[] | null {
  if (!Array.isArray(value) || value.length > MAX_SIDEBAR_SECTION_PLACEMENTS) return null;
  const placements: serverService.SidebarSectionPlacement[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const raw = item as Record<string, unknown>;
    if (
      (raw.kind !== "channel" && raw.kind !== "agent")
      || typeof raw.id !== "string"
      || typeof raw.sectionId !== "string"
      || typeof raw.position !== "number"
      || !Number.isFinite(raw.position)
    ) return null;
    placements.push({ kind: raw.kind, id: raw.id, sectionId: raw.sectionId, position: raw.position });
  }
  return placements;
}

const SIDEBAR_SORT_MODES = new Set(["manual", "recent", "az"]);
const CHANNEL_PANEL_TAB_IDS = new Set(["chat", "tasks", "files"]);
const AGENT_PANEL_TAB_IDS = new Set(["profile", "chat", "dms", "reminders", "workspace", "integrations", "mcp", "activity"]);
type ServerMemberProfile = NonNullable<Awaited<ReturnType<typeof serverService.getServerMemberProfile>>>;
type ChannelScopedHumanProfile = Pick<ServerMemberProfile, "userId" | "name" | "displayName" | "description" | "avatarUrl"> & {
  serverId: string;
  serverName: string;
  serverSlug: string;
  email: null;
  gravatarHash: "";
  role: null;
  joinedAt: null;
  membershipStatus: "active";
  createdAgents: [];
  profileProjection: "channel_summary";
};

function normalizeSidebarSortMode(value: unknown): "manual" | "recent" | "az" | null {
  return typeof value === "string" && SIDEBAR_SORT_MODES.has(value)
    ? (value as "manual" | "recent" | "az")
    : null;
}

function arraysEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, idx) => value === b[idx]);
}

function toChannelScopedHumanProfile(profile: ServerMemberProfile | null): ChannelScopedHumanProfile | null {
  if (!profile) return profile;
  return {
    // Joint-channel human profile visibility is identity-only. Do not leak
    // peer-server private/member graph details such as role, email-derived
    // gravatar hash, join date, or agents created outside the shared channel.
    userId: profile.userId,
    serverId: profile.serverId,
    serverName: profile.serverName,
    serverSlug: profile.serverSlug,
    name: profile.name,
    displayName: profile.displayName,
    description: profile.description,
    avatarUrl: profile.avatarUrl,
    email: null,
    gravatarHash: "",
    role: null,
    joinedAt: null,
    membershipStatus: "active",
    createdAgents: [],
    profileProjection: "channel_summary",
  };
}

function parseCreateScopeAttestationRequest(raw: unknown): CreateScopeAttestationRequest {
  if (!raw || typeof raw !== "object") {
    throw new Error("Request body must be a JSON object");
  }

  const body = raw as Record<string, unknown>;
  const scope = typeof body.scope === "string"
    ? body.scope.trim()
    : "";

  if (!scope) {
    throw new Error("scope is required");
  }

  return { scope };
}

function getAgreementRequestMetadata(req: { ip?: string; get: (name: string) => string | undefined }) {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  };
}

async function canCreateScopeAttestation(serverId: string, userId: string, scope: string) {
  const role = await getActorServerRoleInServer(serverId, "user", userId);
  if (!role) {
    return null;
  }

  switch (scope) {
    case "web-trace-batch:create":
      return true;
    case "feedback-report:create":
      return actorRoleHasServerCapability(role, "editAgents");
    default:
      return null;
  }
}

function scopeAttestationAudience(scope: string): string | null {
  switch (scope) {
    case "web-trace-batch:create":
      return "trace-ingest-worker";
    case "feedback-report:create":
      return "feedback-worker";
    default:
      return null;
  }
}

function scopeAttestationResource(scope: string, serverId: string): string | null {
  switch (scope) {
    case "web-trace-batch:create":
      return `servers/${serverId}/web-traces`;
    case "feedback-report:create":
      return `servers/${serverId}/feedback-reports`;
    default:
      return null;
  }
}

function filterOrderIds(ids: string[], allowedIds: Set<string>): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!allowedIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return next;
}

async function getAllowedSidebarIds(serverId: string, userId: string, opts: { traceQuery?: DbQueryTracer } = {}) {
  const [channels, agents, dms, removedPeerDmIds, durableDmPinTargets, memberIds] = await Promise.all([
    channelService.listChannels(serverId, userId, { traceQuery: opts.traceQuery }),
    agentService.listAgents(serverId, false, { traceQuery: opts.traceQuery }),
    channelService.listDMChannels(serverId, userId, { traceQuery: opts.traceQuery }),
    channelService.listUserDMChannelIdsIncludingRemoved(serverId, userId, { traceQuery: opts.traceQuery }),
    channelService.listUserDMPinTargetsIncludingRemoved(serverId, userId, { traceQuery: opts.traceQuery }),
    serverService.listServerMemberIds(serverId),
  ]);
  const dmIds = new Set([...dms.map((dm) => dm.id), ...removedPeerDmIds]);
  const dmPeerByChannelId = new Map<string, serverService.SidebarPinnedRef>();
  const dmChannelIdByPeerRef = new Map<string, string>();
  for (const dm of dms) {
    const kind = dm.peerType === "agent" ? "agent" : "human";
    const ref: serverService.SidebarPinnedRef = { kind, id: dm.peerId };
    const key = sidebarPinnedRefKey(ref);
    dmPeerByChannelId.set(dm.id, ref);
    if (!dmChannelIdByPeerRef.has(key)) {
      dmChannelIdByPeerRef.set(key, dm.id);
    }
  }
  for (const target of durableDmPinTargets) {
    const ref: serverService.SidebarPinnedRef = { kind: target.peerType, id: target.peerId };
    const key = sidebarPinnedRefKey(ref);
    if (!dmPeerByChannelId.has(target.channelId)) {
      dmPeerByChannelId.set(target.channelId, ref);
    }
    if (!dmChannelIdByPeerRef.has(key)) {
      dmChannelIdByPeerRef.set(key, target.channelId);
    }
  }

  return {
    channelIds: new Set(channels.map((channel) => channel.id)),
    agentIds: new Set(agents.map((agent) => agent.id)),
    humanIds: new Set(memberIds),
    dmIds,
    dmPeerByChannelId,
    dmChannelIdByPeerRef,
    channelsCount: channels.length,
    agentsCount: agents.length,
    dmsCount: dms.length,
    removedPeerDmIdsCount: removedPeerDmIds.length,
    durableDmPinTargetsCount: durableDmPinTargets.length,
  };
}

type SidebarPinContext = Awaited<ReturnType<typeof getAllowedSidebarIds>>;

function canonicalizeSidebarSections(
  customSections: serverService.SidebarCustomSection[],
  sectionOrder: string[],
  placements: serverService.SidebarSectionPlacement[],
  context: SidebarPinContext,
): Pick<serverService.SidebarOrderPreferences, "customSections" | "sectionOrder" | "sectionPlacements"> {
  const customIds = new Set(customSections.map((section) => section.id));
  const systemIds = ["system:pinned", "system:joint", "system:channels", "system:dms"];
  const allowedSectionIds = new Set([...systemIds, ...customIds]);
  const orderedSectionIds: string[] = [];
  const seenSections = new Set<string>();
  for (const sectionId of [...sectionOrder, ...systemIds, ...customSections.map((section) => section.id)]) {
    if (!allowedSectionIds.has(sectionId) || seenSections.has(sectionId)) continue;
    seenSections.add(sectionId);
    orderedSectionIds.push(sectionId);
  }

  const seenItems = new Set<string>();
  const nextPlacements: serverService.SidebarSectionPlacement[] = [];
  const positions = new Map<string, number>();
  for (const placement of [...placements].sort((a, b) => a.position - b.position)) {
    if (!customIds.has(placement.sectionId)) continue;
    if (placement.kind === "channel" && !context.channelIds.has(placement.id) && !context.dmIds.has(placement.id)) continue;
    if (placement.kind === "agent" && !context.agentIds.has(placement.id)) continue;
    const itemKey = `${placement.kind}:${placement.id}`;
    if (seenItems.has(itemKey)) continue;
    seenItems.add(itemKey);
    const position = positions.get(placement.sectionId) ?? 0;
    positions.set(placement.sectionId, position + 1);
    nextPlacements.push({ ...placement, position });
  }
  return { customSections, sectionOrder: orderedSectionIds, sectionPlacements: nextPlacements };
}

function sidebarPinnedRefKey(ref: serverService.SidebarPinnedRef): string {
  return `${ref.kind}:${ref.id}`;
}

function refFromLegacyPinnedId(id: string, context: SidebarPinContext): serverService.SidebarPinnedRef | null {
  if (context.channelIds.has(id)) return { kind: "channel", id };
  const dmPeer = context.dmPeerByChannelId.get(id);
  if (dmPeer) return dmPeer;
  if (context.agentIds.has(id)) return { kind: "agent", id };
  return null;
}

function canonicalizePinnedRefs(
  refs: serverService.SidebarPinnedRef[],
  context: SidebarPinContext,
): serverService.SidebarPinnedRef[] {
  const pinned: serverService.SidebarPinnedRef[] = [];
  const seen = new Set<string>();
  for (const rawRef of refs) {
    const ref = rawRef.kind === "channel"
      ? (context.dmPeerByChannelId.get(rawRef.id) ?? rawRef)
      : rawRef;
    if (ref.kind === "channel" && !context.channelIds.has(ref.id)) continue;
    const key = sidebarPinnedRefKey(ref);
    if (
      ref.kind === "agent"
      && !context.agentIds.has(ref.id)
      && !context.dmChannelIdByPeerRef.has(key)
    ) continue;
    if (
      ref.kind === "human"
      && !context.humanIds.has(ref.id)
      && !context.dmChannelIdByPeerRef.has(key)
    ) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    pinned.push(ref);
  }
  return pinned;
}

function synthesizePinnedRefsFromLegacy(
  order: Pick<serverService.SidebarOrderPreferences, "pinnedChannelIds" | "pinnedAgentIds" | "pinnedOrder">,
  context: SidebarPinContext,
): serverService.SidebarPinnedRef[] {
  const pinned: serverService.SidebarPinnedRef[] = [];
  const seen = new Set<string>();
  const addRef = (ref: serverService.SidebarPinnedRef | null) => {
    if (!ref) return;
    const key = sidebarPinnedRefKey(ref);
    if (seen.has(key)) return;
    seen.add(key);
    pinned.push(ref);
  };

  for (const id of order.pinnedOrder) {
    addRef(refFromLegacyPinnedId(id, context));
  }
  for (const id of order.pinnedChannelIds) {
    addRef(refFromLegacyPinnedId(id, context));
  }
  for (const id of order.pinnedAgentIds) {
    if (context.agentIds.has(id)) addRef({ kind: "agent", id });
  }

  return pinned;
}

function projectLegacyPinnedFields(
  pinned: serverService.SidebarPinnedRef[],
  context: SidebarPinContext,
): Pick<serverService.SidebarOrderPreferences, "pinnedChannelIds" | "pinnedAgentIds" | "pinnedOrder"> {
  const pinnedChannelIds: string[] = [];
  const pinnedAgentIds: string[] = [];
  const pinnedOrder: string[] = [];
  const seenChannelIds = new Set<string>();
  const seenAgentIds = new Set<string>();
  const addChannelId = (id: string) => {
    if (seenChannelIds.has(id)) return;
    seenChannelIds.add(id);
    pinnedChannelIds.push(id);
    pinnedOrder.push(id);
  };
  const addAgentId = (id: string) => {
    if (seenAgentIds.has(id)) return;
    seenAgentIds.add(id);
    pinnedAgentIds.push(id);
    pinnedOrder.push(id);
  };

  for (const ref of pinned) {
    if (ref.kind === "channel") {
      addChannelId(ref.id);
    } else if (ref.kind === "agent") {
      addAgentId(ref.id);
    } else {
      const dmChannelId = context.dmChannelIdByPeerRef.get(sidebarPinnedRefKey(ref));
      if (dmChannelId) addChannelId(dmChannelId);
    }
  }

  return { pinnedChannelIds, pinnedAgentIds, pinnedOrder };
}

function mergeLegacyPinnedFields(
  projected: Pick<serverService.SidebarOrderPreferences, "pinnedChannelIds" | "pinnedAgentIds" | "pinnedOrder">,
  legacy: Pick<serverService.SidebarOrderPreferences, "pinnedChannelIds" | "pinnedAgentIds" | "pinnedOrder">,
  context: SidebarPinContext,
): Pick<serverService.SidebarOrderPreferences, "pinnedChannelIds" | "pinnedAgentIds" | "pinnedOrder"> {
  const appendMissing = (base: string[], extra: string[]) => {
    const seen = new Set(base);
    const merged = [...base];
    for (const id of extra) {
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
    }
    return merged;
  };

  const refForOrderId = (id: string): serverService.SidebarPinnedRef | null => {
    const legacyRef = refFromLegacyPinnedId(id, context);
    if (legacyRef) return legacyRef;
    const agentRef: serverService.SidebarPinnedRef = { kind: "agent", id };
    if (context.dmChannelIdByPeerRef.has(sidebarPinnedRefKey(agentRef))) return agentRef;
    const humanRef: serverService.SidebarPinnedRef = { kind: "human", id };
    return context.dmChannelIdByPeerRef.has(sidebarPinnedRefKey(humanRef)) ? humanRef : null;
  };
  const legacyOrderRefKeys = new Set(
    legacy.pinnedOrder
      .map(refForOrderId)
      .filter((ref): ref is serverService.SidebarPinnedRef => ref !== null)
      .map(sidebarPinnedRefKey),
  );
  const newOnlyProjectedOrder = projected.pinnedOrder.filter((id) => {
    const ref = refForOrderId(id);
    return !ref || !legacyOrderRefKeys.has(sidebarPinnedRefKey(ref));
  });

  return {
    pinnedChannelIds: appendMissing(projected.pinnedChannelIds, legacy.pinnedChannelIds),
    pinnedAgentIds: appendMissing(projected.pinnedAgentIds, legacy.pinnedAgentIds),
    // Preserve an older client's exact order IDs (notably a deleted-agent DM
    // channel id) when the typed projection names the same logical pin by peer
    // entity id. Append only typed pins that legacy storage cannot express.
    pinnedOrder: appendMissing(legacy.pinnedOrder, newOnlyProjectedOrder),
  };
}

function isLegacyExpressiblePinnedRef(ref: serverService.SidebarPinnedRef, context: SidebarPinContext): boolean {
  return ref.kind !== "human" || context.dmChannelIdByPeerRef.has(sidebarPinnedRefKey(ref));
}

function hydrateSidebarPinnedResponse(
  order: serverService.SidebarOrderPreferences,
  context: SidebarPinContext,
): serverService.SidebarOrderPreferences & { pinned: serverService.SidebarPinnedRef[] } {
  const sections = canonicalizeSidebarSections(order.customSections, order.sectionOrder, order.sectionPlacements, context);
  if (order.pinned == null) {
    return {
      ...order,
      ...sections,
      pinned: synthesizePinnedRefsFromLegacy(order, context),
    };
  }
  const pinned = canonicalizePinnedRefs(order.pinned, context);
  const legacyProjection = mergeLegacyPinnedFields(projectLegacyPinnedFields(pinned, context), order, context);
  return {
    ...order,
    ...sections,
    pinned,
    ...legacyProjection,
  };
}

// List user's servers
serverRouter.get("/", async (req, res) => {
  try {
    const servers = await serverService.getOrderedUserServers(req.userId!);
    res.json(servers);
  } catch {
    res.status(500).json({ error: "Failed to list servers" });
  }
});

// Get current user's persisted switcher order across joined servers.
serverRouter.get("/order", async (req, res) => {
  try {
    const order = await serverService.getServerSwitcherOrder(req.userId!);
    res.json(order);
  } catch {
    res.status(500).json({ error: "Failed to get server order" });
  }
});

// Persist current user's server switcher order across joined servers.
serverRouter.patch("/order", async (req, res) => {
  try {
    const rawServerOrder = req.body?.serverOrder;
    const normalizedServerOrder = normalizeOrderIds(rawServerOrder);
    if (!normalizedServerOrder) {
      res.status(400).json({ error: "serverOrder must be an array of string IDs" });
      return;
    }

    const previousOrder = await serverService.getServerSwitcherOrder(req.userId!);
    const order = await serverService.updateServerSwitcherOrder(req.userId!, normalizedServerOrder);
    if (order.serverOrderVersion !== previousOrder.serverOrderVersion) {
      emitServerOrderUpdated(req, order);
    }
    res.json(order);
  } catch {
    res.status(500).json({ error: "Failed to update server order" });
  }
});

// Aggregate unread counts by server for the current user.
// Used by the web sidebar to show "other servers have unread" indicators.
serverRouter.get("/unread-summary", async (req, res) => {
  try {
    addTraceEvent("unread_summary.load.started");
    const memberships = await tracePhase(
      () => serverService.getUserServers(req.userId!, {
        traceQuery: createTraceDbQueryTracer("server_memberships.loaded"),
      }),
      (_durationMs, result) => ({
        name: "server_memberships.loaded",
        attrs: {
          servers_count: result.length,
        },
      }),
    );
    const summaryInputs = memberships.map((membership) => {
      const historyCutoff = getHistoryCutoff((membership.plan ?? "free") as ServerPlan);
      return {
        serverId: membership.id,
        historyCutoff,
      };
    });
    const unreadCounts = await tracePhase(
      () => channelService.getSidebarUnreadSummaryCounts(memberships.map((membership) => membership.id), req.userId!, {
        traceQuery: createTraceDbQueryTracer("unread_summary.loaded"),
      }),
      (_durationMs, result) => {
        const counts = Object.values(result);
        return {
          name: "unread_summary.loaded",
          attrs: {
            servers_count: memberships.length,
            servers_with_unread_count: counts.filter((count) => count > 0).length,
            total_unread_count: counts.reduce((sum, count) => sum + count, 0),
          },
        };
      },
    );
    // task #235: per-server Activity unread — see activityUnreadSummaryService
    // for the authority/fail-closed contract. The batch loader gets this
    // phase's db tracer so the ONE set-based statement stays visible in the
    // request trace like the other summary queries.
    const activityUnreadByServer = await tracePhase(
      () => computeActivityUnreadCounts(summaryInputs, req.userId!, (inputs, userId) =>
        channelService.getActivityUnreadTotalsBatch(inputs, userId, {
          traceQuery: createTraceDbQueryTracer("activity_unread_summary.loaded"),
        })),
      (_durationMs, counts) => ({
        name: "activity_unread_summary.loaded",
        attrs: {
          servers_count: summaryInputs.length,
          computed_count: counts.size,
          failed_count: summaryInputs.length - counts.size,
        },
      }),
    );
    const summary = memberships.map((membership) => {
      const activityUnreadCount = activityUnreadByServer.get(membership.id);
      return {
        serverId: membership.id,
        unreadCount: unreadCounts[membership.id] ?? 0,
        serverPushMuted: !!membership.serverPushMuted,
        // Attached only when known — the wire distinguishes 0 from absent.
        ...(activityUnreadCount !== undefined ? { activityUnreadCount } : {}),
      };
    });
    addTraceEvent("response.ready", {
      servers_count: summary.length,
      servers_with_unread_count: summary.filter((item) => item.unreadCount > 0).length,
      total_unread_count: summary.reduce((sum, item) => sum + item.unreadCount, 0),
    });
    res.json(summary);
  } catch (err) {
    if (respondToRisingWaveOverload(err, res)) return;
    res.status(500).json({ error: "Failed to get unread summary" });
  }
});

// Create server
serverRouter.post("/", async (req, res) => {
  try {
    const { name, slug } = req.body;
    if (!name || !slug) {
      res.status(400).json({ error: "Name and slug are required" });
      return;
    }
    const slugError = validateNewServerSlug(slug);
    if (slugError) {
      res.status(400).json({ error: slugError });
      return;
    }
    const server = await serverService.createServer(name, slug, req.userId!);
    res.json(server);
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg.includes("already taken")) {
      res.status(409).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to create server" });
    }
  }
});

// Join the canonical community server. User-scoped (no `:id` path), so any
// authenticated user can join without providing X-Server-Id. Reuses the
// same `addMember` path as accept-invite but does not require an invite
// token — all registered users are allowed to join the community server.
// Registration order: must come BEFORE the `/:id` lockdown below so
// "community" is not treated as a server id.
serverRouter.post("/join-community", async (req, res) => {
  try {
    const agreementId = typeof req.body?.agreementId === "string" ? req.body.agreementId : null;
    const rawSlug = req.body?.slug;
    if (rawSlug !== undefined && !inviteService.isCommunityServerSlug(rawSlug)) {
      res.status(400).json({ error: "Unsupported community server slug" });
      return;
    }
    const result = await inviteService.joinCommunityServer(req.userId!, {
      agreementId,
      slug: rawSlug,
      ...getAgreementRequestMetadata(req),
    });
    // Committed: deliver the server.member_added App Notification now.
    kickAppNotificationDelivery();
    const io = req.app.get("io") as SocketServer | undefined;
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    if (io) {
      io.to(`server:${result.serverId}`).emit("server:member-added", {
        serverId: result.serverId,
        userId: req.userId!,
      });
      if (agentOrchestrator) {
        void onboardingService.triggerNewMemberOnboarding(io, agentOrchestrator, result.serverId, req.userId!).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[Onboarding] Failed to trigger member onboarding after community join for ${req.userId}: ${msg}`);
        });
      }
    }
    res.json(result);
  } catch (err: any) {
    const agreementResponse = serverAgreementService.agreementErrorResponse(err);
    if (agreementResponse) {
      res.status(agreementResponse.status).json(agreementResponse.body);
      return;
    }
    const msg = err?.message || "";
    if (msg.includes("not available")) {
      res.status(404).json({ error: msg });
    } else if (msg.includes("already")) {
      res.status(400).json({ error: msg });
    } else if (msg.includes("seat limit") || msg.includes("limit reached")) {
      res.status(403).json({ error: msg });
    } else {
      sendJsonServerError(req, res, {
        error: "Failed to join community server",
        logPrefix: "Join community error:",
        err,
      });
    }
  }
});

// Lockdown middleware for all `/:id/*` sub-routes: X-Server-Id header must
// match the URL `:id` and the caller must be a non-deleted member. The
// no-`:id` routes above (list, create, unread-summary, join-community) are
// intentionally not covered — they are user-scoped, not server-scoped.
// Registration order matters: this must come AFTER the no-`:id` handlers so
// they can match first (otherwise "/unread-summary" would be captured as `:id`).
// Introduced 2026-04-19 for #proj-security task #10 (msg=256c4eda).
// Labs has an exact 403 cross-server contract, so it performs its own scope
// check before the generic server router's legacy 400 mismatch response.
serverRouter.use("/:id/labs", serverLabsRouter);
serverRouter.use("/:id", requireServerMatchesParam);

const guestHiddenServerSurfaces: string[] = [
  "/:id/apps",
  "/:id/settings",
  "/:id/onboarding-settings",
  "/:id/setup-projection",
  "/:id/usage",
  "/:id/member-graph",
  "/:id/invites",
  "/:id/join-links",
];

// Guests retain the minimal server identity needed to enter the workspace,
// but server-wide settings, directories, profiles, counts, Apps, Agents, and
// Computers stay hidden. Channel roster/read policy is resolved separately.
serverRouter.use(guestHiddenServerSurfaces, async (req, res, next) => {
  const callerRole = await getActorServerRoleInServer(String(req.params.id), "user", req.userId!);
  if (callerRole === "guest") {
    res.status(403).json({ error: "Guests cannot access server management data" });
    return;
  }
  next();
});

serverRouter.get("/:id/agreement", async (req, res) => {
  try {
    const canManageServer = await serverService.userCanEditServerSettings(req.params.id, req.userId!);
    if (!canManageServer) {
      res.status(403).json({ error: "Only server owners and admins can manage the pre-join agreement" });
      return;
    }
    const active = await serverAgreementService.getActiveAgreement(req.params.id);
    res.json({
      enabled: !!active,
      agreement: active,
    });
  } catch {
    res.status(500).json({ error: "Failed to load pre-join agreement" });
  }
});

// Reference-only RAP App projection for composer autocomplete. Product-owned
// presentation metadata is an explicit allowlist: registry membership alone
// must not leak internal apps into the picker. This exposes stable installed
// identities and display names, never grants, private config, or an invocation
// surface. `requireServerMatchesParam` above owns both server scoping and
// membership before this handler runs.
serverRouter.get("/:id/apps", async (req, res) => {
  try {
    const gate = await evaluateFeatureFlag({
      key: COMPOSER_RESOURCE_REFERENCES_FEATURE_FLAG_KEY,
      userId: req.userId,
      serverId: req.params.id,
      platform: "web",
    });
    if (!gate.enabled) {
      return res.status(404).json({ error: "Not found" });
    }
    const installed = await listInstalledApps(req.params.id);
    const apps = installed.flatMap((app) => {
      const reference = getBuiltInComposerReference(app.appId);
      return reference ? [{ appId: app.appId, displayName: reference.displayName }] : [];
    });
    res.json({ apps });
  } catch {
    res.status(500).json({ error: "Failed to load apps" });
  }
});

serverRouter.put("/:id/agreement", async (req, res) => {
  try {
    const canManageServer = await serverService.userCanEditServerSettings(req.params.id, req.userId!);
    if (!canManageServer) {
      res.status(403).json({ error: "Only server owners and admins can manage the pre-join agreement" });
      return;
    }
    const enabled = req.body?.enabled === true;
    const active = await serverAgreementService.configureAgreement(req.params.id, req.userId!, {
      enabled,
      title: typeof req.body?.title === "string" ? req.body.title : "",
      bodyMarkdown: typeof req.body?.bodyMarkdown === "string" ? req.body.bodyMarkdown : "",
    });
    res.json({
      enabled: !!active,
      agreement: active,
    });
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg.includes("required") || msg.includes("characters")) {
      res.status(400).json({ error: msg });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to update pre-join agreement",
      logPrefix: "Update pre-join agreement error:",
      err,
    });
  }
});

// Archive (soft-delete) server — owner only
serverRouter.delete("/:id", async (req, res) => {
  try {
    const isOwner = await serverService.userIsServerOwnerIncludingDeleted(req.params.id, req.userId!);
    if (!isOwner) {
      res.status(403).json({ error: "Only the server owner can delete a server" });
      return;
    }
    const memberIds = await serverService.listServerMemberIds(req.params.id);
    const deletion = await serverService.deleteServer(req.params.id);
    if (!deletion) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const io = req.app.get("io") as SocketServer | undefined;
    if (deletion.newlyDeleted) {
      // Non-authoritative domain event for clients already in the deleted server room.
      // The per-user membership removal below is the contract that clears stale server lists.
      io?.to(`server:${req.params.id}`).emit("server:deleted", {
        serverId: req.params.id,
      });
      for (const userId of memberIds) {
        io?.to(`user:${userId}`).emit("server:membership-removed", {
          serverId: req.params.id,
        });
      }
    }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to delete server" });
  }
});

// Update server profile (name) — owner/admin
serverRouter.patch("/:id", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!actorRoleHasServerCapability(callerRole, "editServerSettings")) {
      res.status(403).json({ error: "Only server owners and admins can edit the server profile" });
      return;
    }

    const { name, hideHumansFromMembers } = req.body ?? {};
    const updates: { name?: string; hideHumansFromMembers?: boolean } = {};

    if (name !== undefined) {
      if (typeof name !== "string") {
        res.status(400).json({ error: "Name must be a string" });
        return;
      }
      const trimmed = name.trim();
      if (!trimmed) {
        res.status(400).json({ error: "Name is required" });
        return;
      }
      if (trimmed.length > 100) {
        res.status(400).json({ error: "Name must be 100 characters or fewer" });
        return;
      }
      updates.name = trimmed;
    }

    if (hideHumansFromMembers !== undefined) {
      if (typeof hideHumansFromMembers !== "boolean") {
        res.status(400).json({ error: "hideHumansFromMembers must be a boolean" });
        return;
      }
      updates.hideHumansFromMembers = hideHumansFromMembers;
    }

    if (updates.name === undefined && updates.hideHumansFromMembers === undefined) {
      res.status(400).json({ error: "At least one field is required" });
      return;
    }

    const updated = await serverService.updateServerProfile(req.params.id, updates);
    if (!updated) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    res.json(updated);
  } catch {
    res.status(500).json({ error: "Failed to update server" });
  }
});

// Upload server avatar — owner/admin
serverRouter.post("/:id/avatar", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!actorRoleHasServerCapability(callerRole, "editServerSettings")) {
      res.status(403).json({ error: "Only server owners and admins can edit the server profile" });
      return;
    }

    const server = await serverService.getServer(req.params.id);
    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const uploaded = await runSingleAvatarUpload(serverAvatarUpload, req);
    if (!uploaded) {
      res.status(400).json({ error: "No avatar file provided" });
      return;
    }

    const avatarUrl = await storeServerAvatar(server.id, server.avatarUrl, uploaded.buffer);
    const updated = await serverService.updateServerProfile(server.id, { avatarUrl });
    if (!updated) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    res.json(updated);
  } catch (err: any) {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({
        error: PROFILE_AVATAR_TOO_LARGE_MESSAGE,
        errorCode: "PROFILE_AVATAR_TOO_LARGE",
        maxBytes: MAX_PROFILE_AVATAR_BYTES,
      });
      return;
    }
    if (err.message?.includes(PROFILE_AVATAR_BAD_FORMAT_MESSAGE)) {
      res.status(400).json({
        error: err.message,
        errorCode: "PROFILE_AVATAR_BAD_FORMAT",
      });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to upload avatar",
      logPrefix: "Server avatar upload error:",
      err,
    });
  }
});

// Leave server — any member can self-remove as long as at least one owner remains.
serverRouter.post("/:id/leave", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!callerRole) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    if (callerRole === "owner") {
      const ownerCount = await serverService.countOwners(req.params.id);
      if (ownerCount <= 1) {
        res.status(405).json({ error: "A server must have at least one owner. Add another owner before leaving." });
        return;
      }
    }

    await serverService.removeMember(req.params.id, req.userId!, {
      reason: "left",
      actorUserId: req.userId!,
    });

    const io = req.app.get("io") as SocketServer | undefined;
    if (io) {
      io.to(`server:${req.params.id}`).emit("server:member:left", {
        serverId: req.params.id,
        userId: req.userId,
      });
    }

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to leave server" });
  }
});

// Get the Server profile selected by the caller's disclosure permission.
serverRouter.get("/:id", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!callerRole) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const server = await serverService.getServer(req.params.id);
    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    res.json(
      actorRoleHasServerCapability(callerRole, "viewServerProfile")
        ? server
        : projectServerPublicProfile(server),
    );
  } catch {
    res.status(500).json({ error: "Failed to get server" });
  }
});

// Read-only Server settings grouped by product surface. Personal notification,
// translation and onboarding-preference routes remain separate self-state APIs.
serverRouter.get("/:id/settings", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!actorRoleHasServerCapability(callerRole, "viewServerSettings")) {
      res.status(403).json({ error: "The `viewServerSettings` capability is required to view server settings" });
      return;
    }
    const payload = await getServerSettings(req.params.id, req.userId!);
    if (!payload) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    res.json(payload);
  } catch {
    res.status(500).json({ error: "Failed to get server settings" });
  }
});

// Backward-compatible projection for clients that still read the old endpoint.
serverRouter.get("/:id/onboarding-settings", async (req, res) => {
  try {
    const payload = await getServerSettings(req.params.id, req.userId!);
    if (!payload) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    res.json(payload.settings.onboardSettings);
  } catch {
    res.status(500).json({ error: "Failed to get onboarding settings" });
  }
});

serverRouter.get("/:id/setup-projection", async (req, res) => {
  const actor = { type: "user" as const, id: req.userId! };
  const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
  const projection = await routeServerSetupStateService(orchestrator).resolveServerSetup({
    serverId: req.params.id,
    actor,
  });
  res.json(projection);
});

serverRouter.post("/:id/setup-transition", async (req, res) => {
  const action = req.body?.action;
  if (typeof action !== "string" || !SERVER_SETUP_ACTIONS.has(action as ServerSetupAction)) {
    res.status(400).json({ error: "INVALID_SETUP_ACTION" });
    return;
  }

  const actor = { type: "user" as const, id: req.userId! };
  const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
  const service = routeServerSetupStateService(orchestrator);
  try {
    await service.transitionServerSetupState({
      serverId: req.params.id,
      userId: req.userId!,
      actor,
      action: action as ServerSetupAction,
    });
    res.json(await service.resolveServerSetup({ serverId: req.params.id, actor }));
  } catch (error) {
    if (error instanceof ServerSetupStateError) {
      res.status(serverSetupErrorStatus(error)).json({ error: error.code });
      return;
    }
    res.status(500).json({ error: "SERVER_SETUP_TRANSITION_FAILED" });
  }
});

// "Start over": roll an unfinished server back to empty.
//
// The only exit from a setup that cannot be finished — an offline computer that is never
// coming back, a runtime stuck on "checking", a laptop that was sold. It is safe precisely
// because the server has never had an agent: there is nothing here to lose. The service
// re-checks that for itself before it destroys anything; the projection may offer the
// button, but it does not get to authorise the demolition.
serverRouter.post("/:id/setup-reset", async (req, res) => {
  const actor = { type: "user" as const, id: req.userId! };
  const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
  const service = routeServerSetupStateService(orchestrator);
  try {
    const result = await resetServerSetup({ serverId: req.params.id, actor });
    res.json({
      ...(await service.resolveServerSetup({ serverId: req.params.id, actor })),
      // What we actually did, so the UI can tell the user their old machines will need
      // connecting again. Revoking a computer does not uninstall it — that daemon is still
      // sitting on their laptop with a key that will never work again.
      revokedComputers: result.revokedComputers,
    });
  } catch (error) {
    if (error instanceof ServerSetupStateError) {
      res.status(serverSetupErrorStatus(error)).json({ error: error.code });
      return;
    }
    res.status(500).json({ error: "SERVER_SETUP_RESET_FAILED" });
  }
});

// "Let's Go": the owner takes the handoff.
//
// This is a COMMAND, not a side effect of something else. It used to ride on
// `PATCH /api/auth/me {signupSurveyServerId}`, which fired the briefing and let the
// briefing's delivery timestamp stand in for "the user pressed the button". Those are two
// different facts, and they came apart in both directions (a dropped briefing left an owner
// who HAD pressed it stuck on "Starting…"; an old server that never had a briefing read as
// still owing a handoff). So: stamp the acknowledgment first, synchronously, and only then
// fire the briefing best-effort. Idempotent — pressing twice changes nothing.
serverRouter.post("/:id/setup-handoff", async (req, res) => {
  try {
    const server = await serverService.getServer(req.params.id);
    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    // The handoff belongs to the owner. An admin can help set a server up; they cannot
    // accept someone else's handoff.
    if (server.ownerId !== req.userId!) {
      res.status(403).json({ error: "INSUFFICIENT_PERMISSION" });
      return;
    }

    await serverService.markSetupHandoffAcknowledged(
      req.params.id,
      req.userId!,
      req.sessionFamilyId,
    );

    // Best-effort, and deliberately after the stamp: whether Cindy can be reached right now
    // has nothing to do with whether this person finished onboarding. If she is still
    // booting, the briefing is retried on her next activation (onboardingService owns that).
    const io = req.app.get("io") as SocketServer | undefined;
    const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    if (io && orchestrator && server.onboardingAgentId) {
      void onboardingService
        .triggerOwnerOnboardingOnAgentActivation(io, orchestrator, req.params.id, server.onboardingAgentId)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[Onboarding] Failed to brief onboarding agent on handoff: ${msg}`);
        });
    }

    const actor = { type: "user" as const, id: req.userId! };
    const service = routeServerSetupStateService(req.app.get("agentOrchestrator") as AgentOrchestrator);
    res.json(await service.resolveServerSetup({ serverId: req.params.id, actor }));
  } catch {
    res.status(500).json({ error: "SERVER_SETUP_HANDOFF_FAILED" });
  }
});

// Update onboarding settings:
// - owner/admin can set onboardingAgentId
// - any member can update their own setupModalReminderOptOut
serverRouter.patch("/:id/onboarding-settings", async (req, res) => {
  try {
    const member = await serverService.isMember(req.params.id, req.userId!);
    if (!member) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const rawOnboardingAgentId = req.body?.onboardingAgentId;
    const rawAgentAllChannelGreetingEnabled = req.body?.agentAllChannelGreetingEnabled;
    // Accept both names during rollout; canonical key is setupModalReminderOptOut.
    const rawSetupModalReminderOptOut = req.body?.setupModalReminderOptOut ?? req.body?.onboardingReminderOptOut;
    const rawDismissedAddComputerStep = req.body?.dismissedAddComputerStep;
    const rawDismissedCreateAgentStep = req.body?.dismissedCreateAgentStep;
    const rawDismissedInviteStep = req.body?.dismissedInviteStep;
    const rawDismissedCommunityStep = req.body?.dismissedCommunityStep;
    const rawDismissedNotificationStep = req.body?.dismissedNotificationStep;
    const rawOnboardingWizardCurrentStep = req.body?.onboardingWizardCurrentStep;

    const updatesAgent =
      rawOnboardingAgentId === null || typeof rawOnboardingAgentId === "string";
    const updatesGreeting = typeof rawAgentAllChannelGreetingEnabled === "boolean";
    const updatesReminder = typeof rawSetupModalReminderOptOut === "boolean";
    const updatesAddComputerStep = typeof rawDismissedAddComputerStep === "boolean";
    const updatesCreateAgentStep = typeof rawDismissedCreateAgentStep === "boolean";
    const updatesInviteStep = typeof rawDismissedInviteStep === "boolean";
    const updatesCommunityStep = typeof rawDismissedCommunityStep === "boolean";
    const updatesNotificationStep = typeof rawDismissedNotificationStep === "boolean";
    const updatesWizardCurrentStep =
      rawOnboardingWizardCurrentStep === null ||
      (
        typeof rawOnboardingWizardCurrentStep === "string" &&
        ONBOARDING_WIZARD_STEPS.has(rawOnboardingWizardCurrentStep)
      );

    if (rawOnboardingAgentId !== undefined && !updatesAgent) {
      res.status(400).json({ error: "onboardingAgentId must be a string or null" });
      return;
    }
    if (rawSetupModalReminderOptOut !== undefined && !updatesReminder) {
      res.status(400).json({ error: "setupModalReminderOptOut must be a boolean" });
      return;
    }
    if (rawAgentAllChannelGreetingEnabled !== undefined && !updatesGreeting) {
      res.status(400).json({ error: "agentAllChannelGreetingEnabled must be a boolean" });
      return;
    }
    if (rawDismissedAddComputerStep !== undefined && !updatesAddComputerStep) {
      res.status(400).json({ error: "dismissedAddComputerStep must be a boolean" });
      return;
    }
    if (rawDismissedCreateAgentStep !== undefined && !updatesCreateAgentStep) {
      res.status(400).json({ error: "dismissedCreateAgentStep must be a boolean" });
      return;
    }
    if (rawDismissedInviteStep !== undefined && !updatesInviteStep) {
      res.status(400).json({ error: "dismissedInviteStep must be a boolean" });
      return;
    }
    if (rawDismissedCommunityStep !== undefined && !updatesCommunityStep) {
      res.status(400).json({ error: "dismissedCommunityStep must be a boolean" });
      return;
    }
    if (rawDismissedNotificationStep !== undefined && !updatesNotificationStep) {
      res.status(400).json({ error: "dismissedNotificationStep must be a boolean" });
      return;
    }
    if (rawOnboardingWizardCurrentStep !== undefined && !updatesWizardCurrentStep) {
      res.status(400).json({ error: "onboardingWizardCurrentStep must be a valid onboarding wizard step or null" });
      return;
    }
    if (
      rawOnboardingAgentId === undefined
      && rawSetupModalReminderOptOut === undefined
      && rawAgentAllChannelGreetingEnabled === undefined
      && rawDismissedAddComputerStep === undefined
      && rawDismissedCreateAgentStep === undefined
      && rawDismissedInviteStep === undefined
      && rawDismissedCommunityStep === undefined
      && rawDismissedNotificationStep === undefined
      && rawOnboardingWizardCurrentStep === undefined
    ) {
      res.status(400).json({ error: "At least one field is required" });
      return;
    }

    if (rawOnboardingAgentId !== undefined || rawAgentAllChannelGreetingEnabled !== undefined) {
      const canManageServer = await serverService.userCanEditServerSettings(req.params.id, req.userId!);
      if (!canManageServer) {
        res.status(403).json({ error: "Only server owners and admins can update onboarding settings" });
        return;
      }

      if (rawOnboardingAgentId) {
        const agent = await agentService.getAgent(rawOnboardingAgentId);
        if (!agent || agent.serverId !== req.params.id) {
          res.status(400).json({ error: "Onboarding agent not found in this server" });
          return;
        }
      }

      await serverService.updateServerOnboardingSettings(req.params.id, {
        ...(rawOnboardingAgentId !== undefined ? { onboardingAgentId: rawOnboardingAgentId ?? null } : {}),
        ...(rawAgentAllChannelGreetingEnabled !== undefined ? { agentAllChannelGreetingEnabled: rawAgentAllChannelGreetingEnabled } : {}),
      });
    }

    if (
      updatesReminder
      || updatesAddComputerStep
      || updatesCreateAgentStep
      || updatesInviteStep
      || updatesCommunityStep
      || updatesNotificationStep
      || updatesWizardCurrentStep
    ) {
      const now = new Date();
      await serverService.updateMemberOnboardingPreferences(req.params.id, req.userId!, {
        ...(updatesReminder ? { setupModalReminderOptOut: rawSetupModalReminderOptOut } : {}),
        ...(updatesAddComputerStep ? { dismissedAddComputerStepAt: rawDismissedAddComputerStep ? now : null } : {}),
        ...(updatesCreateAgentStep ? { dismissedCreateAgentStepAt: rawDismissedCreateAgentStep ? now : null } : {}),
        ...(updatesInviteStep ? { dismissedInviteStepAt: rawDismissedInviteStep ? now : null } : {}),
        ...(updatesCommunityStep ? { dismissedCommunityStepAt: rawDismissedCommunityStep ? now : null } : {}),
        ...(updatesNotificationStep ? { dismissedNotificationStepAt: rawDismissedNotificationStep ? now : null } : {}),
        ...(updatesWizardCurrentStep ? { onboardingWizardCurrentStep: rawOnboardingWizardCurrentStep } : {}),
      });
    }

    const [settings, prefs] = await Promise.all([
      serverService.getServerOnboardingSettings(req.params.id),
      serverService.getMemberOnboardingPreferences(req.params.id, req.userId!),
    ]);
    if (!settings || !prefs) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    res.json({
      onboardingAgentId: settings.onboardingAgentId ?? null,
      agentAllChannelGreetingEnabled: settings.agentAllChannelGreetingEnabled,
      onboardingWizardEnabled: settings.onboardingWizardEnabled,
      setupModalReminderOptOut: prefs.setupModalReminderOptOut,
      // Backward-compatible alias for older clients.
      onboardingReminderOptOut: prefs.setupModalReminderOptOut,
      dismissedAddComputerStepAt: prefs.dismissedAddComputerStepAt,
      dismissedCreateAgentStepAt: prefs.dismissedCreateAgentStepAt,
      dismissedInviteStepAt: prefs.dismissedInviteStepAt,
      dismissedCommunityStepAt: prefs.dismissedCommunityStepAt,
      dismissedNotificationStepAt: prefs.dismissedNotificationStepAt,
      onboardingWizardCurrentStep: prefs.onboardingWizardCurrentStep,
      onboardingDmSentAt: prefs.onboardingDmSentAt,
      onboardingDmSentByAgentId: prefs.onboardingDmSentByAgentId,
    });
  } catch {
    res.status(500).json({ error: "Failed to update onboarding settings" });
  }
});

// RFC-067: the workspace-wide product analytics switch.
serverRouter.get("/:id/product-analytics-settings", async (req, res) => {
  try {
    const role = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    const enabled = role ? await serverService.getServerProductAnalyticsEnabled(req.params.id) : null;
    if (!role || enabled === null) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    res.json({
      productAnalyticsEnabled: enabled,
      canManageProductAnalytics: actorRoleHasServerCapability(role, "editServerSettings"),
    });
  } catch {
    res.status(500).json({ error: "Failed to get product analytics settings" });
  }
});

serverRouter.patch("/:id/product-analytics-settings", async (req, res) => {
  try {
    const role = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!role) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    if (!actorRoleHasServerCapability(role, "editServerSettings")) {
      res.status(403).json({ error: "Only server owners and admins can update product analytics settings" });
      return;
    }
    const raw = req.body?.productAnalyticsEnabled;
    if (typeof raw !== "boolean") {
      res.status(400).json({ error: "productAnalyticsEnabled must be a boolean" });
      return;
    }
    const enabled = await serverService.updateServerProductAnalyticsEnabled(req.params.id, raw);
    if (enabled === null) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    res.json({ productAnalyticsEnabled: enabled, canManageProductAnalytics: true });
  } catch {
    res.status(500).json({ error: "Failed to update product analytics settings" });
  }
});

// Get translation settings for the current server.
serverRouter.get("/:id/translation-settings", async (req, res) => {
  try {
    const role = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!role) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const settings = await serverService.getServerTranslationSettings(req.params.id);
    if (!settings) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    res.json({
      translationEnabled: settings.translationEnabled,
      translationAvailable: isTranslationProviderConfigured(),
      canManageTranslation: actorRoleHasServerCapability(role, "editServerSettings"),
    });
  } catch {
    res.status(500).json({ error: "Failed to get translation settings" });
  }
});

// Update translation settings for the current server.
serverRouter.patch("/:id/translation-settings", async (req, res) => {
  try {
    const role = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!role) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    if (!actorRoleHasServerCapability(role, "editServerSettings")) {
      res.status(403).json({ error: "Only server owners and admins can update translation settings" });
      return;
    }

    const rawTranslationEnabled = req.body?.translationEnabled;
    if (typeof rawTranslationEnabled !== "boolean") {
      res.status(400).json({ error: "translationEnabled must be a boolean" });
      return;
    }

    const settings = await serverService.updateServerTranslationSettings(req.params.id, {
      translationEnabled: rawTranslationEnabled,
    });
    if (!settings) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    res.json({
      translationEnabled: settings.translationEnabled,
      translationAvailable: isTranslationProviderConfigured(),
      canManageTranslation: true,
    });
  } catch {
    res.status(500).json({ error: "Failed to update translation settings" });
  }
});

// Get notification settings for the current member in this server.
serverRouter.get("/:id/notification-settings", async (req, res) => {
  try {
    const member = await serverService.isMember(req.params.id, req.userId!);
    if (!member) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const prefs = await serverService.getMemberNotificationPreferences(req.params.id, req.userId!);
    if (!prefs) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    res.json({
      ...serializeServerNotificationPrefs(prefs),
      prefsVersion: prefs.prefsVersion,
    });
  } catch {
    res.status(500).json({ error: "Failed to get notification settings" });
  }
});

// Update notification settings for the current member in this server.
serverRouter.patch("/:id/notification-settings", async (req, res) => {
  try {
    const member = await serverService.isMember(req.params.id, req.userId!);
    if (!member) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const rawServerPushMode = req.body?.serverPushMode;
    const rawServerPushMuted = req.body?.serverPushMuted;
    const validMode = rawServerPushMode === "all" || rawServerPushMode === "mentions" || rawServerPushMode === "none";
    if (rawServerPushMode !== undefined && !validMode) {
      res.status(400).json({ error: "serverPushMode must be one of all, mentions, none" });
      return;
    }
    if (rawServerPushMode === undefined && typeof rawServerPushMuted !== "boolean") {
      res.status(400).json({ error: "serverPushMode or serverPushMuted is required" });
      return;
    }

    const prefs = await serverService.updateMemberNotificationPreferences(req.params.id, req.userId!, {
      ...(validMode
        ? { serverPushMode: rawServerPushMode as serverService.ServerPushMode }
        : { serverPushMuted: rawServerPushMuted as boolean }),
    });
    if (!prefs) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    emitServerNotificationPrefsUpdated(req, prefs);
    res.json({
      ...serializeServerNotificationPrefs(prefs),
      prefsVersion: prefs.prefsVersion,
    });
  } catch {
    res.status(500).json({ error: "Failed to update notification settings" });
  }
});

// Create a short-lived server-scoped scope attestation
serverRouter.post("/:id/scope-attestation", async (req, res) => {
  if (!DISTRIBUTION_POLICY.diagnosticUploads) {
    res.status(403).json({ error: "Diagnostic uploads are disabled in this self-hosted build" });
    return;
  }
  try {
    const { scope } = parseCreateScopeAttestationRequest(req.body);
    const allowed = await canCreateScopeAttestation(req.params.id, req.userId!, scope);

    if (allowed == null) {
      res.status(400).json({ error: `Unsupported scope: ${scope}` });
      return;
    }

    if (!allowed) {
      res.status(403).json({ error: "You are not authorized for the requested scope" });
      return;
    }

    const [user, server, traceUserId] = await Promise.all([
      userService.getUser(req.userId!),
      serverService.getServer(req.params.id),
      userService.getTraceUserId(req.userId!),
    ]);

    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const expiresAt = new Date(Date.now() + SCOPE_ATTESTATION_TTL_MS);
    const attestation = createScopeAttestation({
      v: 1,
      typ: "scope-attestation",
      scope,
      sub: req.userId!,
      actorType: "user",
      traceUserId,
      email: user?.email || null,
      serverId: server.id,
      serverSlug: server.slug,
      aud: scopeAttestationAudience(scope),
      resource: scopeAttestationResource(scope, server.id),
      nonce: randomUUID(),
      exp: Math.floor(expiresAt.getTime() / 1000),
    });

    res.json({
      attestation,
      scope,
      audience: scopeAttestationAudience(scope),
      resource: scopeAttestationResource(scope, server.id),
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create scope attestation";
    if (message.includes("not configured")) {
      res.status(503).json({ error: message });
      return;
    }
    if (message === "Request body must be a JSON object" || message === "scope is required" || message.startsWith("Unsupported scope:")) {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: "Failed to create scope attestation" });
  }
});

// Get server resource usage (agent + machine counts)
serverRouter.get("/:id/usage", async (req, res) => {
  try {
    const member = await serverService.isMember(req.params.id, req.userId!);
    if (!member) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const [agents, machines, channels] = await Promise.all([
      countAgents(req.params.id),
      countMachines(req.params.id),
      countChannels(req.params.id),
    ]);
    res.json({ agents, machines, channels });
  } catch {
    res.status(500).json({ error: "Failed to get usage" });
  }
});

// Get server members
serverRouter.get("/:id/members", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (callerRole === "guest") {
      res.status(403).json({ error: "Guests cannot access server management data" });
      return;
    }
    const member = await serverService.isMember(req.params.id, req.userId!);
    if (!member) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const [members, hideHumanDirectory] = await Promise.all([
      serverService.getServerMembers(req.params.id, req.userId!),
      serverService.shouldHideHumanDirectoryFromRequester(req.params.id, req.userId!),
    ]);
    res.json(hideHumanDirectory
      ? members.filter((item) => item.userId === req.userId)
      : members);
  } catch {
    res.status(500).json({ error: "Failed to get members" });
  }
});

// Get member ↔ active public channel graph for the current server.
serverRouter.get("/:id/member-graph", async (req, res) => {
  try {
    const member = await serverService.isMember(req.params.id, req.userId!);
    if (!member) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    if (await serverService.shouldHideHumanDirectoryFromRequester(req.params.id, req.userId!)) {
      res.status(403).json({ error: "Member graph is not available" });
      return;
    }

    const [serverMembers, serverAgents, visibleChannelRows] = await Promise.all([
      serverService.getServerMembers(req.params.id, req.userId!),
      agentService.listAgents(req.params.id, false),
      channelService.listChannels(req.params.id, req.userId!),
    ]);
    const visibleChannels = visibleChannelRows.filter((channel) => channel.type === "channel" && !channel.archivedAt);

    const channelById = new Map(visibleChannels.map((channel) => [channel.id, channel]));
    const visibleChannelIds = visibleChannels.map((channel) => channel.id);
    const virtualAllChannelIds = new Set(
      visibleChannels
        .filter((channel) => channelService.isEnabledAllChannel(channel))
        .map((channel) => channel.id),
    );
    const memberChannelIds = new Map<string, Set<string>>();
    const edges: Array<{ channelId: string; memberType: "human" | "agent"; memberId: string }> = [];

    function addEdge(memberType: "human" | "agent", memberId: string, channelId: string) {
      if (!channelById.has(channelId)) return;
      const graphMemberId = `${memberType}:${memberId}`;
      let channelIds = memberChannelIds.get(graphMemberId);
      if (!channelIds) {
        channelIds = new Set<string>();
        memberChannelIds.set(graphMemberId, channelIds);
      }
      channelIds.add(channelId);
      edges.push({ channelId, memberType, memberId });
    }

    const channelCounts = new Map<string, { humans: number; agents: number }>();
    for (const channel of visibleChannels) {
      channelCounts.set(channel.id, { humans: 0, agents: 0 });
    }

    if (visibleChannelIds.length > 0) {
      const db = getDb();
      const [humanEdges, agentEdges] = await Promise.all([
        db
          .select({
            channelId: channelHumans.channelId,
            userId: channelHumans.userId,
          })
          .from(channelHumans)
          .where(inArray(channelHumans.channelId, visibleChannelIds)),
        db
          .select({
            channelId: channelAgents.channelId,
            agentId: channelAgents.agentId,
          })
          .from(channelAgents)
          .innerJoin(agentsTable, eq(channelAgents.agentId, agentsTable.id))
          .where(and(
            inArray(channelAgents.channelId, visibleChannelIds),
            isNull(agentsTable.deletedAt),
          )),
      ]);

      for (const row of humanEdges) {
        if (virtualAllChannelIds.has(row.channelId)) continue;
        addEdge("human", row.userId, row.channelId);
        const counts = channelCounts.get(row.channelId);
        if (counts) counts.humans += 1;
      }
      for (const row of agentEdges) {
        if (virtualAllChannelIds.has(row.channelId)) continue;
        addEdge("agent", row.agentId, row.channelId);
        const counts = channelCounts.get(row.channelId);
        if (counts) counts.agents += 1;
      }
    }

    for (const channelId of virtualAllChannelIds) {
      const counts = channelCounts.get(channelId);
      for (const human of serverMembers) {
        addEdge("human", human.userId, channelId);
        if (counts) counts.humans += 1;
      }
      for (const agent of serverAgents) {
        addEdge("agent", agent.id, channelId);
        if (counts) counts.agents += 1;
      }
    }

    const humans = serverMembers.map((human) => ({
      type: "human" as const,
      id: human.userId,
      name: human.name,
      displayName: human.displayName,
      avatarUrl: human.avatarUrl,
      gravatarHash: human.gravatarHash,
      role: human.role,
      channelIds: [...(memberChannelIds.get(`human:${human.userId}`) ?? new Set<string>())],
    }));
    const agents = serverAgents.map((agent) => ({
      type: "agent" as const,
      id: agent.id,
      name: agent.name,
      displayName: agent.displayName,
      avatarUrl: agent.avatarUrl,
      status: agent.status,
      runtime: agent.runtime,
      channelIds: [...(memberChannelIds.get(`agent:${agent.id}`) ?? new Set<string>())],
    }));
    const channelsForGraph = visibleChannels.map((channel) => {
      const counts = channelCounts.get(channel.id) ?? { humans: 0, agents: 0 };
      return {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        archivedAt: channel.archivedAt ?? null,
        humanCount: counts.humans,
        agentCount: counts.agents,
        memberCount: counts.humans + counts.agents,
      };
    });

    res.json({
      humans,
      agents,
      channels: channelsForGraph,
      edges,
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to get member graph",
      logPrefix: "Failed to get member graph:",
      err,
    });
  }
});

// Get current member's persisted sidebar order
serverRouter.get("/:id/sidebar-order", async (req, res) => {
  try {
    addTraceEvent("sidebar_order.load.started");
    const member = await tracePhase(
      () => serverService.isMember(req.params.id, req.userId!, {
        traceQuery: createTraceDbQueryTracer("server.membership.checked"),
      }),
      (_durationMs, isMember) => ({
        name: "server.membership.checked",
        attrs: { is_member: isMember },
      }),
    );
    if (!member) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const sidebarOrder = await tracePhase(
      () => serverService.getSanitizedMemberSidebarOrder(req.params.id, req.userId!, {
        traceQuery: createTraceDbQueryTracer("sidebar_order.loaded"),
      }),
      (_durationMs, order) => ({
        name: "sidebar_order.loaded",
        attrs: {
          sidebar_order_present: Boolean(order),
          channel_order_count: order?.channelOrder.length ?? 0,
          agent_order_count: order?.agentOrder.length ?? 0,
          dm_order_count: order?.dmOrder.length ?? 0,
          channel_sort_mode: order?.channelSortMode ?? "manual",
          joint_channel_sort_mode: order?.jointChannelSortMode ?? "manual",
          dm_sort_mode: order?.dmSortMode ?? "manual",
          pinned_channel_count: order?.pinnedChannelIds.length ?? 0,
          pinned_agent_count: order?.pinnedAgentIds.length ?? 0,
          pinned_order_count: order?.pinnedOrder.length ?? 0,
          hidden_dm_count: order?.hiddenDmIds.length ?? 0,
          channel_panel_tab_order_count: order?.channelPanelTabOrder.length ?? 0,
          agent_panel_tab_order_count: order?.agentPanelTabOrder.length ?? 0,
        },
      }),
    );
    if (!sidebarOrder) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    const allowedIds = await getAllowedSidebarIds(req.params.id, req.userId!, {
      traceQuery: createTraceDbQueryTracer("sidebar_order.pinned_context_loaded"),
    });
    const responseOrder = hydrateSidebarPinnedResponse(sidebarOrder, allowedIds);
    addTraceEvent("response.ready", {
      channel_order_count: responseOrder.channelOrder.length,
      agent_order_count: responseOrder.agentOrder.length,
      dm_order_count: responseOrder.dmOrder.length,
      channel_sort_mode: responseOrder.channelSortMode,
      joint_channel_sort_mode: responseOrder.jointChannelSortMode,
      dm_sort_mode: responseOrder.dmSortMode,
      pinned_count: responseOrder.pinned.length,
      pinned_channel_count: responseOrder.pinnedChannelIds.length,
      pinned_agent_count: responseOrder.pinnedAgentIds.length,
      pinned_order_count: responseOrder.pinnedOrder.length,
      hidden_dm_count: responseOrder.hiddenDmIds.length,
      channel_panel_tab_order_count: responseOrder.channelPanelTabOrder.length,
      agent_panel_tab_order_count: responseOrder.agentPanelTabOrder.length,
    });
    res.json(responseOrder);
  } catch {
    res.status(500).json({ error: "Failed to get sidebar order" });
  }
});

// Persist current member's sidebar order
serverRouter.patch("/:id/sidebar-order", async (req, res) => {
  try {
    const member = await serverService.isMember(req.params.id, req.userId!);
    if (!member) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const rawChannelOrder = req.body?.channelOrder;
    const rawAgentOrder = req.body?.agentOrder;
    const rawDmOrder = req.body?.dmOrder;
    const rawChannelSortMode = req.body?.channelSortMode;
    const rawJointChannelSortMode = req.body?.jointChannelSortMode;
    const rawDmSortMode = req.body?.dmSortMode;
    const rawPinnedSortMode = req.body?.pinnedSortMode;
    const rawPinnedChannelIds = req.body?.pinnedChannelIds;
    const rawPinnedAgentIds = req.body?.pinnedAgentIds;
    const rawPinnedOrder = req.body?.pinnedOrder;
    const rawPinned = req.body?.pinned;
    const rawHiddenDmIds = req.body?.hiddenDmIds;
    const rawChannelPanelTabOrder = req.body?.channelPanelTabOrder;
    const rawAgentPanelTabOrder = req.body?.agentPanelTabOrder;
    const rawCustomSections = req.body?.customSections;
    const rawSectionOrder = req.body?.sectionOrder;
    const rawSectionPlacements = req.body?.sectionPlacements;
    const rawSectionsVersion = req.body?.sectionsVersion;
    const normalizedChannelOrder = rawChannelOrder === undefined ? undefined : normalizeOrderIds(rawChannelOrder);
    const normalizedAgentOrder = rawAgentOrder === undefined ? undefined : normalizeOrderIds(rawAgentOrder);
    const normalizedDmOrder = rawDmOrder === undefined ? undefined : normalizeOrderIds(rawDmOrder);
    const normalizedChannelSortMode = rawChannelSortMode === undefined ? undefined : normalizeSidebarSortMode(rawChannelSortMode);
    const normalizedJointChannelSortMode = rawJointChannelSortMode === undefined ? undefined : normalizeSidebarSortMode(rawJointChannelSortMode);
    const normalizedDmSortMode = rawDmSortMode === undefined ? undefined : normalizeSidebarSortMode(rawDmSortMode);
    const normalizedPinnedSortMode = rawPinnedSortMode === undefined ? undefined : normalizeSidebarSortMode(rawPinnedSortMode);
    const normalizedPinnedChannelIds = rawPinnedChannelIds === undefined ? undefined : normalizeOrderIds(rawPinnedChannelIds);
    const normalizedPinnedAgentIds = rawPinnedAgentIds === undefined ? undefined : normalizeOrderIds(rawPinnedAgentIds);
    const normalizedPinnedOrder = rawPinnedOrder === undefined ? undefined : normalizeOrderIds(rawPinnedOrder);
    const normalizedPinned = rawPinned === undefined ? undefined : normalizePinnedRefs(rawPinned);
    const normalizedHiddenDmIds = rawHiddenDmIds === undefined ? undefined : normalizeOrderIds(rawHiddenDmIds);
    const normalizedChannelPanelTabOrder = rawChannelPanelTabOrder === undefined ? undefined : normalizeOrderIds(rawChannelPanelTabOrder);
    const normalizedAgentPanelTabOrder = rawAgentPanelTabOrder === undefined ? undefined : normalizeOrderIds(rawAgentPanelTabOrder);
    const normalizedCustomSections = rawCustomSections === undefined ? undefined : normalizeCustomSections(rawCustomSections);
    const normalizedSectionOrder = rawSectionOrder === undefined ? undefined : normalizeOrderIds(rawSectionOrder);
    const normalizedSectionPlacements = rawSectionPlacements === undefined ? undefined : normalizeSectionPlacements(rawSectionPlacements);

    if (
      (rawChannelOrder !== undefined && !normalizedChannelOrder) ||
      (rawAgentOrder !== undefined && !normalizedAgentOrder) ||
      (rawDmOrder !== undefined && !normalizedDmOrder) ||
      (rawChannelSortMode !== undefined && !normalizedChannelSortMode) ||
      (rawJointChannelSortMode !== undefined && !normalizedJointChannelSortMode) ||
      (rawDmSortMode !== undefined && !normalizedDmSortMode) ||
      (rawPinnedSortMode !== undefined && !normalizedPinnedSortMode) ||
      (rawPinnedChannelIds !== undefined && !normalizedPinnedChannelIds) ||
      (rawPinnedAgentIds !== undefined && !normalizedPinnedAgentIds) ||
      (rawPinnedOrder !== undefined && !normalizedPinnedOrder) ||
      (rawPinned !== undefined && !normalizedPinned) ||
      (rawHiddenDmIds !== undefined && !normalizedHiddenDmIds) ||
      (rawChannelPanelTabOrder !== undefined && !normalizedChannelPanelTabOrder) ||
      (rawAgentPanelTabOrder !== undefined && !normalizedAgentPanelTabOrder)
      || (rawCustomSections !== undefined && !normalizedCustomSections)
      || (rawSectionOrder !== undefined && !normalizedSectionOrder)
      || (rawSectionPlacements !== undefined && !normalizedSectionPlacements)
      || (rawSectionsVersion !== undefined && (!Number.isInteger(rawSectionsVersion) || rawSectionsVersion < 0))
    ) {
      res.status(400).json({ error: "Invalid sidebar order, pinned, or custom section fields" });
      return;
    }

    const hasLegacyPinnedFields = normalizedPinnedChannelIds !== undefined || normalizedPinnedAgentIds !== undefined || normalizedPinnedOrder !== undefined;
    if (normalizedPinned !== undefined && hasLegacyPinnedFields) {
      res.status(400).json({ error: "pinned cannot be combined with pinnedChannelIds, pinnedAgentIds, or pinnedOrder" });
      return;
    }

    if (normalizedChannelOrder === undefined && normalizedAgentOrder === undefined && normalizedDmOrder === undefined && normalizedChannelSortMode === undefined && normalizedJointChannelSortMode === undefined && normalizedDmSortMode === undefined && normalizedPinnedSortMode === undefined && normalizedPinnedChannelIds === undefined && normalizedPinnedAgentIds === undefined && normalizedPinnedOrder === undefined && normalizedPinned === undefined && normalizedHiddenDmIds === undefined && normalizedChannelPanelTabOrder === undefined && normalizedAgentPanelTabOrder === undefined && normalizedCustomSections === undefined && normalizedSectionOrder === undefined && normalizedSectionPlacements === undefined) {
      res.status(400).json({ error: "At least one field is required" });
      return;
    }

    const allowedIds = await getAllowedSidebarIds(req.params.id, req.userId!);
    const channelAndDmIds = new Set([...allowedIds.channelIds, ...allowedIds.dmIds]);
    const pinnableIds = new Set([...channelAndDmIds, ...allowedIds.agentIds]);
    const hasPinnedUpdateFields = normalizedPinnedSortMode !== undefined || normalizedPinned !== undefined || hasLegacyPinnedFields;
    const hasSectionUpdateFields = normalizedCustomSections !== undefined || normalizedSectionOrder !== undefined || normalizedSectionPlacements !== undefined;
    let currentPinnedOrder: serverService.SidebarOrderPreferences | null = null;
    if (hasPinnedUpdateFields || hasSectionUpdateFields) {
      currentPinnedOrder = await serverService.getMemberSidebarOrder(req.params.id, req.userId!);
      if (!currentPinnedOrder) {
        res.status(404).json({ error: "Member not found" });
        return;
      }
    }
    if (hasSectionUpdateFields && rawSectionsVersion !== currentPinnedOrder!.sectionsVersion) {
      res.status(409).json({
        error: "Sidebar sections changed on another client",
        code: "SIDEBAR_SECTIONS_VERSION_CONFLICT",
        sectionsVersion: currentPinnedOrder!.sectionsVersion,
      });
      return;
    }
    let pinnedUpdate: Pick<serverService.SidebarOrderPreferences, "pinned" | "pinnedChannelIds" | "pinnedAgentIds" | "pinnedOrder"> | undefined;
    if (normalizedPinned !== undefined) {
      const pinned = canonicalizePinnedRefs(normalizedPinned ?? [], allowedIds);
      pinnedUpdate = { pinned, ...projectLegacyPinnedFields(pinned, allowedIds) };
    } else if (hasLegacyPinnedFields) {
      const currentOrder = currentPinnedOrder!;
      const legacyInput = {
        pinnedChannelIds: normalizedPinnedChannelIds ?? currentOrder.pinnedChannelIds,
        pinnedAgentIds: normalizedPinnedAgentIds ?? currentOrder.pinnedAgentIds,
        pinnedOrder: normalizedPinnedOrder ?? currentOrder.pinnedOrder,
      };
      const filteredLegacyInput = {
        pinnedChannelIds: filterOrderIds(legacyInput.pinnedChannelIds, channelAndDmIds),
        pinnedAgentIds: filterOrderIds(legacyInput.pinnedAgentIds, allowedIds.agentIds),
        pinnedOrder: filterOrderIds(legacyInput.pinnedOrder, pinnableIds),
      };
      const nextExpressiblePinned = synthesizePinnedRefsFromLegacy(filteredLegacyInput, allowedIds);
      const preservedNewOnlyPinned = (currentOrder.pinned == null ? [] : canonicalizePinnedRefs(currentOrder.pinned, allowedIds))
        .filter((ref) => !isLegacyExpressiblePinnedRef(ref, allowedIds));
      const pinned = canonicalizePinnedRefs([...nextExpressiblePinned, ...preservedNewOnlyPinned], allowedIds);
      pinnedUpdate = { pinned, ...filteredLegacyInput };
    }
    const sectionUpdate = hasSectionUpdateFields
      ? canonicalizeSidebarSections(
          normalizedCustomSections ?? currentPinnedOrder!.customSections,
          normalizedSectionOrder ?? currentPinnedOrder!.sectionOrder,
          normalizedSectionPlacements ?? currentPinnedOrder!.sectionPlacements,
          allowedIds,
        )
      : undefined;
    const sidebarOrder = await serverService.updateMemberSidebarOrder(req.params.id, req.userId!, {
      channelOrder: normalizedChannelOrder == null ? undefined : filterOrderIds(normalizedChannelOrder, allowedIds.channelIds),
      agentOrder: normalizedAgentOrder == null ? undefined : filterOrderIds(normalizedAgentOrder, allowedIds.agentIds),
      dmOrder: normalizedDmOrder == null ? undefined : filterOrderIds(normalizedDmOrder, allowedIds.dmIds),
      channelSortMode: normalizedChannelSortMode ?? undefined,
      jointChannelSortMode: normalizedJointChannelSortMode ?? undefined,
      dmSortMode: normalizedDmSortMode ?? undefined,
      pinnedSortMode: normalizedPinnedSortMode ?? undefined,
      pinned: pinnedUpdate?.pinned,
      pinnedChannelIds: pinnedUpdate?.pinnedChannelIds,
      pinnedAgentIds: pinnedUpdate?.pinnedAgentIds,
      pinnedOrder: pinnedUpdate?.pinnedOrder,
      hiddenDmIds: normalizedHiddenDmIds == null ? undefined : filterOrderIds(normalizedHiddenDmIds, allowedIds.dmIds),
      channelPanelTabOrder: normalizedChannelPanelTabOrder == null ? undefined : filterOrderIds(normalizedChannelPanelTabOrder, CHANNEL_PANEL_TAB_IDS),
      agentPanelTabOrder: normalizedAgentPanelTabOrder == null ? undefined : filterOrderIds(normalizedAgentPanelTabOrder, AGENT_PANEL_TAB_IDS),
      customSections: sectionUpdate?.customSections,
      sectionOrder: sectionUpdate?.sectionOrder,
      sectionPlacements: sectionUpdate?.sectionPlacements,
      sectionsVersion: hasSectionUpdateFields ? rawSectionsVersion : undefined,
    });
    if (!sidebarOrder) {
      if (hasSectionUpdateFields) {
        const latestOrder = await serverService.getMemberSidebarOrder(req.params.id, req.userId!);
        if (latestOrder) {
          res.status(409).json({
            error: "Sidebar sections changed on another client",
            code: "SIDEBAR_SECTIONS_VERSION_CONFLICT",
            sectionsVersion: latestOrder.sectionsVersion,
          });
          return;
        }
      }
      res.status(404).json({ error: "Member not found" });
      return;
    }
    const responseOrder = hydrateSidebarPinnedResponse(sidebarOrder, allowedIds);
    if (currentPinnedOrder && responseOrder.pinnedVersion !== currentPinnedOrder.pinnedVersion) {
      emitPinnedUpdated(req, responseOrder);
    }
    res.json(responseOrder);
  } catch {
    res.status(500).json({ error: "Failed to update sidebar order" });
  }
});

// Update a human member's role (owner/admin with role transition limits)
serverRouter.patch("/:id/members/:memberId", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!actorRoleHasServerCapability(callerRole, "changeMemberRoles")) {
      res.status(403).json({ error: "Only server owners and admins can change member roles" });
      return;
    }

    const { role } = req.body as { role?: ServerRole };
    if (!role || !(["owner", "admin", "member", "guest"] as const).includes(role)) {
      res.status(400).json({ error: "Role must be owner, admin, member, or guest" });
      return;
    }
    const guestGate = await evaluateFeatureFlag({
      key: SERVER_GUEST_FEATURE_FLAG_KEY,
      serverId: req.params.id,
      userId: req.userId!,
    });
    const result = await serverService.transitionMemberRole({
      serverId: req.params.id,
      actorUserId: req.userId!,
      targetUserId: req.params.memberId,
      nextRole: role,
      guestTransitionsEnabled: guestGate.enabled,
    });
    if (result.changed) {
      const io = req.app.get("io") as SocketServer | undefined;
      if (result.nextRole === "guest") {
        // Reconnect under the new role so the socket cannot retain server or
        // hidden-channel rooms admitted while it was a regular member.
        io?.in(`user:${req.params.memberId}`).disconnectSockets();
      }
      for (const channelId of result.removedAllChannelIds) {
        io?.in(`user:${req.params.memberId}`).socketsLeave(`channel:${channelId}`);
      }
      io?.to(`server:${req.params.id}`).emit("server:member-updated", {
        serverId: req.params.id,
        userId: req.params.memberId,
        previousRole: result.previousRole,
        role: result.nextRole,
      });
    }
    res.json({ ok: true, changed: result.changed });
  } catch (err) {
    if (err instanceof serverService.ServerMemberRoleTransitionError) {
      if (err.code === "target_not_member") {
        res.status(404).json({ error: "Member not found" });
        return;
      }
      if (err.code === "last_owner") {
        res.status(400).json({ error: "A server must have at least one owner" });
        return;
      }
      res.status(403).json({ error: "You are not allowed to make that role change" });
      return;
    }
    if (err instanceof HumanSeatLimitError) {
      res.status(409).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: "Failed to update member role" });
  }
});

// Get a human profile in the context of this server, even if they were removed.
serverRouter.get("/:id/members/:memberId/profile", async (req, res) => {
  try {
    const member = await serverService.isMember(req.params.id, req.userId!);
    if (!member) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    let profile: ServerMemberProfile | ChannelScopedHumanProfile | null = await serverService.getServerMemberProfile(req.params.id, req.params.memberId, req.userId!);
    if (callerRole === "guest") {
      profile = await channelService.canUserSeeHumanThroughLocalChannel(req.params.id, req.userId!, req.params.memberId)
        ? toChannelScopedHumanProfile(profile)
        : null;
    } else if (
      profile
      && await serverService.shouldHideHumanDirectoryFromRequester(req.params.id, req.userId!)
      && !serverService.shouldExposeHumanInHiddenDirectory(profile, req.userId!)
      && !await channelService.canUserSeeHumanThroughLocalChannel(req.params.id, req.userId!, req.params.memberId)
    ) {
      profile = null;
    }
    if (!profile || profile.membershipStatus !== "active") {
      const peerServerId = await channelService.getJointVisibleHumanServerId(req.params.id, req.userId!, req.params.memberId);
      if (peerServerId && peerServerId !== req.params.id) {
        const peerProfile = await serverService.getServerMemberProfile(peerServerId, req.params.memberId, req.userId!);
        if (peerProfile) {
          profile = toChannelScopedHumanProfile(peerProfile);
        }
      }
    }
    if (!profile) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json(profile);
  } catch {
    res.status(500).json({ error: "Failed to get member profile" });
  }
});

// Remove a human member from the server.
serverRouter.delete("/:id/members/:memberId", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!actorRoleHasServerCapability(callerRole, "removeMembers")) {
      res.status(403).json({ error: "Only server owners and admins can remove members" });
      return;
    }

    if (req.params.memberId === req.userId) {
      res.status(400).json({ error: "You cannot remove yourself" });
      return;
    }

    const targetRole = await getActorServerRoleInServer(req.params.id, "user", req.params.memberId);
    if (!targetRole) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    if (targetRole === "owner") {
      if (callerRole !== "owner") {
        res.status(403).json({ error: "Only server owners can remove owners" });
        return;
      }
      const ownerCount = await serverService.countOwners(req.params.id);
      if (ownerCount <= 1) {
        res.status(400).json({ error: "A server must have at least one owner" });
        return;
      }
    } else if (callerRole !== "owner" && targetRole !== "member") {
      res.status(403).json({ error: "Only an owner can remove admins" });
      return;
    }

    await serverService.removeMember(req.params.id, req.params.memberId, {
      reason: "removed",
      actorUserId: req.userId!,
    });
    const io = req.app.get("io") as SocketServer | undefined;
    io?.to(`server:${req.params.id}`).emit("server:member-removed", {
      serverId: req.params.id,
      userId: req.params.memberId,
    });
    io?.to(`user:${req.params.memberId}`).emit("server:membership-removed", {
      serverId: req.params.id,
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to remove member" });
  }
});

// ── Invites ──

// Create invite (admin/owner only)
serverRouter.post("/:id/invites", async (req, res) => {
  try {
    const rawEmail = typeof req.body.email === "string" ? req.body.email.trim() : "";
    if (!rawEmail) {
      res.status(400).json({ error: "Email is required" });
      return;
    }
    const emailError = validateEmailAddress(rawEmail);
    if (emailError) {
      res.status(400).json({ error: emailError });
      return;
    }

    // Only owner and admin can invite. Members do not hold inviteMembers, so
    // this gate already restricts who may pick a role below — no second check.
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!actorRoleHasServerCapability(callerRole, "inviteMembers")) {
      res.status(403).json({ error: "Only server owners and admins can send invites" });
      return;
    }

    const rawRole = req.body.role;
    if (rawRole !== undefined && rawRole !== "member" && rawRole !== "guest") {
      res.status(400).json({ error: "role must be one of: member, guest" });
      return;
    }
    const role: inviteService.InvitableServerRole = rawRole ?? "member";
    if (role === "guest") {
      // Refused, not silently downgraded. An inviter who picked Guest and
      // received a Member invite would have handed out more access than they
      // chose, and nothing in the response would have said so.
      const guestGate = await evaluateFeatureFlag({
        key: SERVER_GUEST_FEATURE_FLAG_KEY,
        serverId: req.params.id,
        userId: req.userId!,
      });
      if (!guestGate.enabled) {
        res.status(400).json({ error: "Guest access is not enabled for this server" });
        return;
      }
    }

    const invite = await inviteService.createInvite(req.params.id, rawEmail, req.userId!, role);
    res.json(invite);
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg === INVALID_EMAIL_MESSAGE || msg.includes("seat limit") || msg.includes("limit reached")) {
      res.status(400).json({ error: msg });
    } else if (msg.includes("already")) {
      res.status(409).json({ error: msg });
    } else {
      sendJsonServerError(req, res, {
        error: "Failed to create invite",
        logPrefix: "Create invite error:",
        err,
      });
    }
  }
});

// List pending invites (admin/owner only)
serverRouter.get("/:id/invites", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!actorRoleHasServerCapability(callerRole, "inviteMembers")) {
      res.status(403).json({ error: "Only server owners and admins can view invites" });
      return;
    }

    const invites = await inviteService.listPendingInvites(req.params.id);
    res.json(invites);
  } catch {
    res.status(500).json({ error: "Failed to list invites" });
  }
});

// Revoke invite (admin/owner only)
serverRouter.delete("/:id/invites/:inviteId", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!actorRoleHasServerCapability(callerRole, "inviteMembers")) {
      res.status(403).json({ error: "Only server owners and admins can revoke invites" });
      return;
    }

    await inviteService.revokeInvite(req.params.inviteId, req.params.id);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to revoke invite" });
  }
});

// Create multi-use join link (admin/owner only)
serverRouter.post("/:id/join-links", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!actorRoleHasServerCapability(callerRole, "inviteMembers")) {
      res.status(403).json({ error: "Only server owners and admins can create join links" });
      return;
    }

    const { expiresAt, maxUses } = req.body ?? {};
    const parsedExpiresAt = expiresAt ? new Date(expiresAt) : null;
    const parsedMaxUses = maxUses === undefined || maxUses === null || maxUses === "" ? null : Number(maxUses);

    if (parsedExpiresAt && Number.isNaN(parsedExpiresAt.getTime())) {
      res.status(400).json({ error: "expiresAt must be a valid date" });
      return;
    }
    if (parsedMaxUses != null && (!Number.isInteger(parsedMaxUses) || parsedMaxUses < 1)) {
      res.status(400).json({ error: "maxUses must be a positive integer" });
      return;
    }

    const { token, link } = await inviteService.createJoinLink(req.params.id, req.userId!, {
      expiresAt: parsedExpiresAt,
      maxUses: parsedMaxUses,
    });

    res.json({ token, link });
  } catch (err: any) {
    const msg = err?.message || "";
    if (msg.includes("Max uses") || msg.includes("Expires at") || msg.includes("seat limit") || msg.includes("limit reached")) {
      res.status(400).json({ error: msg });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to create join link",
      logPrefix: "Create join link error:",
      err,
    });
  }
});

// List active join links (admin/owner only)
serverRouter.get("/:id/join-links", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!actorRoleHasServerCapability(callerRole, "inviteMembers")) {
      res.status(403).json({ error: "Only server owners and admins can view join links" });
      return;
    }

    const links = await inviteService.listJoinLinks(req.params.id);
    res.json(links);
  } catch {
    res.status(500).json({ error: "Failed to list join links" });
  }
});

// Revoke join link (admin/owner only)
serverRouter.delete("/:id/join-links/:linkId", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!actorRoleHasServerCapability(callerRole, "inviteMembers")) {
      res.status(403).json({ error: "Only server owners and admins can revoke join links" });
      return;
    }

    await inviteService.revokeJoinLink(req.params.linkId, req.params.id);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to revoke join link" });
  }
});

// Canonical active system-notification snapshot for this receiver + server.
//
// Phase 1 has no read receipt and intentionally keeps dismiss receipts
// client-local. The stable notification id is the dismiss key; a later response
// omitting an id resolves that condition. Receiver authority is evaluated on
// every request through the current action-specific `viewMachines` capability;
// a future role/capability change therefore replaces stale rows immediately.
serverRouter.get("/:id/system-notifications", async (req, res) => {
  const generatedAt = currentDate();
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!callerRole) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    res.set("Cache-Control", "private, no-store");
    if (!actorRoleHasServerCapability(callerRole, "viewMachines")) {
      res.json(buildServerSystemNotificationsResponse(generatedAt, []));
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const [machineRows, activeAgentCountByMachine, computerLinkedMachineIds] = await Promise.all([
      machineService.listMachines(req.params.id, {
        traceQuery: createTraceDbQueryTracer("system_notifications.machines.loaded"),
      }),
      machineService.countRunningAgentsByMachine(req.params.id, {
        traceQuery: createTraceDbQueryTracer("system_notifications.active_agents.loaded"),
      }),
      getComputerLinkedMachineIds(req.params.id),
    ]);
    const machineReadModels = await Promise.all(
      machineRows.map((machine) => buildMachineReadModel(machine, agentOrchestrator, {
        isComputer: computerLinkedMachineIds.has(machine.id),
      })),
    );
    const notifications = projectMachineSystemNotifications({
      machines: machineReadModels,
      activeAgentCountByMachine,
      evaluatedAt: generatedAt,
    });
    addTraceEvent("system_notifications.snapshot.ready", {
      contract_version: SERVER_SYSTEM_NOTIFICATIONS_CONTRACT_VERSION,
      receiver_role: callerRole,
      machine_count: machineReadModels.length,
      managed_computer_count: machineReadModels.filter((machine) => machine.isComputer).length,
      notification_count: notifications.length,
      notification_types: notifications.map((notification) => notification.type).join(","),
    });
    res.json(buildServerSystemNotificationsResponse(generatedAt, notifications));
  } catch {
    res.status(500).json({ error: "Failed to list system notifications" });
  }
});

// List machines for server
serverRouter.get("/:id/machines", async (req, res) => {
  try {
    addTraceEvent("machines.list.started");
    const callerRole = await tracePhase(
      () => getActorServerRoleInServer(req.params.id, "user", req.userId!),
      (_durationMs, result) => ({
        name: "server.machine_list_authority.checked",
        attrs: {
          caller_role: result,
          allowed: actorRoleHasServerCapability(result, "viewMachines"),
        },
      }),
    );
    if (!callerRole) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    if (!actorRoleHasServerCapability(callerRole, "viewMachines")) {
      res.status(403).json({ error: "The `viewMachines` capability is required to list machines" });
      return;
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const machines = await tracePhase(
      () => machineService.listMachines(req.params.id, {
        traceQuery: createTraceDbQueryTracer("machines.loaded"),
      }),
      (_durationMs, result) => ({
        name: "machines.loaded",
        attrs: {
          machines_count: result.length,
        },
      }),
    );
    const [computerLinkedMachineAttachers, computerLinkedMachineCreators] = await Promise.all([
      getComputerLinkedMachineAttachers(req.params.id),
      getComputerLinkedMachineCreators(req.params.id),
    ]);
    const agentCountsByMachine = await machineService.countActiveAgentsByMachine(req.params.id, {
      traceQuery: createTraceDbQueryTracer("machines.agent_counts.loaded"),
    });
    const enriched = await tracePhase(
      () => Promise.all(
        machines.map(async (m) => {
          const readModel = await buildMachineReadModel(m, agentOrchestrator, {
            isComputer: computerLinkedMachineAttachers.has(m.id),
            computerAttachedByCurrentUser: computerLinkedMachineAttachers.get(m.id) === req.userId,
            agentCount: agentCountsByMachine.get(m.id) ?? 0,
          });
          return {
            ...readModel,
            creator: computerLinkedMachineCreators.get(m.id) ?? null,
          };
        }),
      ),
      (_durationMs, result) => ({
        name: "machines.read_models.built",
        attrs: {
          machines_count: result.length,
          online_machines_count: result.filter((machine) => machine.status === "online").length,
          daemon_version_present_count: result.filter((machine) => Boolean(machine.daemonVersion)).length,
        },
      }),
    );
    const latestComputerVersion = await tracePhase(
      () => getLatestComputerVersion(),
      (_durationMs, result) => ({
        name: "latest_computer_version.loaded",
        attrs: {
          computer_version_present: Boolean(result),
        },
      }),
    );
    const evaluatePolicy = computerBroadcastPolicyEvaluator(req.app);
    let policyNow: Date | null = null;
    const latestUpgradeRequests = await listLatestComputerUpgradeRequests(
      enriched.filter((machine) => machine.isComputer).map((machine) => machine.id),
    );
    const machinesWithComputerUpgradeState = await Promise.all(enriched.map(async (machine) => {
      const {
        computerVersionObservedAt,
        computerVersionProvenance,
        ...publicMachine
      } = machine;
      if (!machine.isComputer) {
        return {
          ...publicMachine,
          computerUpgradeAvailable: null,
          computerBroadcastPolicy: null,
          remoteUpgradeSupported: null,
        };
      }
      policyNow ??= new Date(agentOrchestrator.getCurrentTimeMs());
      const decision = await evaluatePolicy({
        source: {
          version: machine.computerVersion,
          observedAt: computerVersionObservedAt,
          provenance: computerVersionProvenance,
        },
        platform: normalizeComputerPlatform(machine.os),
        now: policyNow,
        serverId: req.params.id,
      });
      const upgradeRequestRow = latestUpgradeRequests.get(machine.id);
      return {
        ...publicMachine,
        computerUpgradeAvailable: decision.eligibility === "eligible",
        computerBroadcastPolicy: projectComputerBroadcastPolicyDecision(decision),
        upgradeRequest: upgradeRequestRow ? projectComputerUpgradeRequest(upgradeRequestRow) : null,
        remoteUpgradeSupported: isRemoteUpgradeSupported(machine.computerVersion),
      };
    }));
    addTraceEvent("response.ready", {
      machines_count: machinesWithComputerUpgradeState.length,
      online_machines_count: machinesWithComputerUpgradeState.filter((machine) => machine.status === "online").length,
      daemon_version_present_count: machinesWithComputerUpgradeState.filter((machine) => Boolean(machine.daemonVersion)).length,
      latest_computer_version_present: Boolean(latestComputerVersion),
    });
    res.json({
      machines: machinesWithComputerUpgradeState,
      // Retired: the daemon is no longer published as its own release, so
      // there is no separate "latest daemon" target. The key stays for older
      // web clients, which treat null as "never outdated".
      latestDaemonVersion: null,
      // Artifact availability hint only. Per-machine policy decisions are the
      // sole authority for display target/copy and dispatch admission.
      latestComputerVersion,
      // Display-only notes for exactly `latestComputerVersion` (null when
      // unknown). Additive: older web clients ignore it.
      latestComputerReleaseNotes: getLatestComputerReleaseNotes(),
    });
  } catch {
    res.status(500).json({ error: "Failed to list machines" });
  }
});

// Register a new machine (admin/owner only)
serverRouter.post("/:id/machines", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!callerRole) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    if (!actorRoleHasServerCapability(callerRole, "registerMachines")) {
      res.status(403).json({ error: "The `registerMachines` capability is required to register machines" });
      return;
    }
    const { name } = req.body;
    if (!name) {
      res.status(400).json({ error: "Name is required" });
      return;
    }
    // Task #93 line G: the registration re-checks `registerMachines` under a share lock on the caller's own member row
    // inside the machines advisory lock, so a removal or demotion that commits after the check above registers nothing.
    const result = await machineService.registerMachine(req.params.id, req.userId!, name, { capability: "registerMachines" });
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const machine = await buildMachineReadModel(result.machine, agentOrchestrator);
    const io = req.app.get("io") as SocketServer | undefined;
    io?.to(`server:${req.params.id}`).emit("machine:updated", {
      serverId: req.params.id,
      machineId: machine.id,
    });
    // Return the API key only once — it cannot be retrieved again
    res.json({ machine, apiKey: result.apiKey });
  } catch (err: any) {
    if (err instanceof ServerMembershipRevokedError) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    if (err instanceof FencedAuthorizationDeniedError) {
      res.status(403).json({ error: "The `registerMachines` capability is required to register machines" });
      return;
    }
    const msg = err?.message || "";
    if (msg.includes("limit reached")) {
      res.status(400).json({ error: msg });
    } else {
      res.status(500).json({ error: "Failed to register machine" });
    }
  }
});

// Update a machine (admin/owner only)
serverRouter.patch("/:id/machines/:machineId", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!callerRole) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const machine = await machineService.getMachine(asMachineId(req.params.machineId));
    if (!machine || machine.serverId !== req.params.id) {
      res.status(404).json({ error: "Machine not found in this server" });
      return;
    }
    if (!canManageMachineResource(callerRole, req.userId!, machine, "editMachines")) {
      res.status(403).json({ error: "The `editMachines` capability or machine creator authority is required to edit machines" });
      return;
    }
    const { name, description } = req.body ?? {};
    const updates: { name?: string; description?: string | null } = {};
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        res.status(400).json({ error: "Name is required" });
        return;
      }
      updates.name = name.trim();
    }
    if (description !== undefined) {
      if (description !== null && typeof description !== "string") {
        res.status(400).json({ error: "Description must be a string" });
        return;
      }
      const nextDescription = typeof description === "string" ? description.trim() : null;
      if (nextDescription && nextDescription.length > 500) {
        res.status(400).json({ error: "Description must be 500 characters or less" });
        return;
      }
      updates.description = nextDescription || null;
    }
    if (updates.name === undefined && updates.description === undefined) {
      res.status(400).json({ error: "Name or description is required" });
      return;
    }
    // Task #91: re-authorize inside the write transaction under a share lock on the caller's membership row,
    // so a concurrent removal or demotion either waits for this write or makes it fail. Member row first,
    // machine row second.
    const updated = await withActorMembershipFence(req.params.id, req.userId!, async (tx, lockedRole) => {
      const [lockedMachine] = await tx
        .select({ id: machinesTable.id, serverId: machinesTable.serverId, userId: machinesTable.userId })
        .from(machinesTable)
        .where(eq(machinesTable.id, req.params.machineId))
        .for("update");
      if (!lockedMachine || lockedMachine.serverId !== req.params.id) throw new FencedAuthorizationDeniedError("not_found");
      if (!canManageMachineResource(lockedRole, req.userId!, lockedMachine, "editMachines")) {
        throw new FencedAuthorizationDeniedError("forbidden");
      }
      return machineService.updateMachine(req.params.machineId, updates, { executor: tx });
    });
    const io = req.app.get("io") as SocketServer | undefined;
    io?.to(`server:${req.params.id}`).emit("machine:updated", {
      serverId: req.params.id,
      machineId: req.params.machineId,
    });
    res.json(updated);
  } catch (error) {
    if (error instanceof ServerMembershipRevokedError) {
      res.status(403).json({ error: error.message });
      return;
    }
    if (error instanceof FencedAuthorizationDeniedError) {
      if (error.reason === "not_found") {
        res.status(404).json({ error: "Machine not found in this server" });
      } else {
        res.status(403).json({ error: "The `editMachines` capability or machine creator authority is required to edit machines" });
      }
      return;
    }
    res.status(500).json({ error: "Failed to update machine" });
  }
});

// Delete a machine (admin/owner only)
serverRouter.delete("/:id/machines/:machineId", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!callerRole) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const machine = await machineService.getMachine(asMachineId(req.params.machineId));
    if (!machine || machine.serverId !== req.params.id) {
      res.status(404).json({ error: "Machine not found in this server" });
      return;
    }
    if (!canManageMachineResource(callerRole, req.userId!, machine, "removeMachines")) {
      res.status(403).json({ error: "The `removeMachines` capability or machine creator authority is required to remove machines" });
      return;
    }
    const linkedComputerIds = await getComputerLinkedMachineIds(req.params.id);
    const isComputerMachine = linkedComputerIds.has(req.params.machineId);
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    if (isComputerMachine) {
      const routing = await handleMachineLocalRouting(
        req,
        res,
        req.params.machineId,
        () => agentOrchestrator.hasMachineLocally(req.params.machineId),
      );
      if (routing === "handled") return;
    }
    // Task #91: the delete is re-authorized inside the write transaction (member row first, machine row second). The machine
    // row is taken FOR UPDATE here because deleteMachine locks it FOR UPDATE again inside; a shared lock would need an upgrade.
    // Disconnecting the Computer below is a runtime effect (task #93).
    await withActorMembershipFence(req.params.id, req.userId!, async (tx, lockedRole) => {
      const [lockedMachine] = await tx
        .select({ id: machinesTable.id, serverId: machinesTable.serverId, userId: machinesTable.userId })
        .from(machinesTable)
        .where(eq(machinesTable.id, req.params.machineId))
        .for("update");
      if (!lockedMachine || lockedMachine.serverId !== req.params.id) throw new FencedAuthorizationDeniedError("not_found");
      if (!canManageMachineResource(lockedRole, req.userId!, lockedMachine, "removeMachines")) {
        throw new FencedAuthorizationDeniedError("forbidden");
      }
      await machineService.deleteMachine(req.params.machineId, { executor: tx });
    });
    if (isComputerMachine) {
      await agentOrchestrator.disconnectMachineForUnlink(req.params.machineId);
    }
    const io = req.app.get("io") as SocketServer | undefined;
    io?.to(`server:${req.params.id}`).emit("machine:updated", {
      serverId: req.params.id,
      machineId: req.params.machineId,
    });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ServerMembershipRevokedError) {
      res.status(403).json({ error: err.message });
      return;
    }
    if (err instanceof FencedAuthorizationDeniedError) {
      if (err.reason === "not_found") {
        res.status(404).json({ error: "Machine not found in this server" });
      } else {
        res.status(403).json({ error: "The `removeMachines` capability or machine creator authority is required to remove machines" });
      }
      return;
    }
    if (err instanceof machineService.MachineDeleteConflictError) {
      res.status(409).json({ error: err.message, code: err.code });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to delete machine",
      code: "machine_delete_failed",
      logPrefix: "[Servers] Failed to delete machine",
      err,
    });
  }
});

// Regenerate API key for a machine (admin/owner only)
serverRouter.post("/:id/machines/:machineId/rotate-key", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!callerRole) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const machine = await machineService.getMachine(asMachineId(req.params.machineId));
    if (!machine || machine.serverId !== req.params.id) {
      res.status(404).json({ error: "Machine not found in this server" });
      return;
    }
    if (!canManageMachineResource(callerRole, req.userId!, machine, "rotateMachineKeys")) {
      res.status(403).json({ error: "The `rotateMachineKeys` capability or machine creator authority is required to rotate machine keys" });
      return;
    }
    // Task #91: rotate under the caller's membership share lock (member row first, machine row second). The new key is
    // returned only after commit, and the auth cache is evicted only after commit.
    const apiKey = await withActorMembershipFence(req.params.id, req.userId!, async (tx, lockedRole) => {
      const [lockedMachine] = await tx
        .select({ id: machinesTable.id, serverId: machinesTable.serverId, userId: machinesTable.userId })
        .from(machinesTable)
        .where(eq(machinesTable.id, req.params.machineId))
        .for("update");
      if (!lockedMachine || lockedMachine.serverId !== req.params.id) throw new FencedAuthorizationDeniedError("not_found");
      if (!canManageMachineResource(lockedRole, req.userId!, lockedMachine, "rotateMachineKeys")) {
        throw new FencedAuthorizationDeniedError("forbidden");
      }
      return machineService.regenerateApiKey(req.params.machineId, { executor: tx });
    });
    machineService.clearAuthCache(req.params.machineId);
    res.json({ apiKey });
  } catch (error) {
    if (error instanceof ServerMembershipRevokedError) {
      res.status(403).json({ error: error.message });
      return;
    }
    if (error instanceof FencedAuthorizationDeniedError) {
      if (error.reason === "not_found") {
        res.status(404).json({ error: "Machine not found in this server" });
      } else {
        res.status(403).json({ error: "The `rotateMachineKeys` capability or machine creator authority is required to rotate machine keys" });
      }
      return;
    }
    res.status(500).json({ error: "Failed to regenerate API key" });
  }
});

// Remote restart / upgrade of a managed Computer (admin/owner only).
// Relays a command over the machine's live WS to the Computer service IPC
// (restart → restart-service, upgrade → upgrade-start). Only valid for a
// machine presented by a managed Computer that is currently online.
serverRouter.post("/:id/machines/:machineId/computer/:action", async (req, res) => {
  try {
    const action = req.params.action;
    if (action !== "restart" && action !== "upgrade") {
      addTraceEvent("computer.control.rejected", {
        action,
        reason: "unknown_action",
        server_id: req.params.id,
        machine_id: req.params.machineId,
      });
      res.status(400).json({ error: "Unknown action", code: "unknown_action" });
      return;
    }
    const requestedTargetVersion = req.body?.targetVersion;
    if (
      (action === "upgrade" && (
        typeof requestedTargetVersion !== "string"
        || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(requestedTargetVersion)
      ))
      || (action === "restart" && requestedTargetVersion !== undefined)
    ) {
      res.status(400).json({
        error: "A valid targetVersion is required only for upgrade",
        code: "invalid_target_version",
      });
      return;
    }
    addTraceEvent("computer.control.requested", {
      action,
      server_id: req.params.id,
      machine_id: req.params.machineId,
    });
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!callerRole) {
      addTraceEvent("computer.control.rejected", {
        action,
        reason: "server_not_found",
        server_id: req.params.id,
        machine_id: req.params.machineId,
      });
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const machine = await machineService.getMachine(asMachineId(req.params.machineId));
    if (!machine || machine.serverId !== req.params.id) {
      addTraceEvent("computer.control.rejected", {
        action,
        reason: "machine_not_found",
        server_id: req.params.id,
        machine_id: req.params.machineId,
      });
      res.status(404).json({ error: "Machine not found in this server" });
      return;
    }
    if (!canManageMachineResource(callerRole, req.userId!, machine, "controlComputers")) {
      addTraceEvent("computer.control.rejected", {
        action,
        reason: "forbidden",
        server_id: req.params.id,
        machine_id: req.params.machineId,
      });
      res.status(403).json({ error: "The `controlComputers` capability or machine creator authority is required to control Computers" });
      return;
    }
    const computerLinkedMachineIds = await getComputerLinkedMachineIds(req.params.id);
    if (!computerLinkedMachineIds.has(machine.id)) {
      addTraceEvent("computer.control.rejected", {
        action,
        reason: "not_a_computer",
        server_id: req.params.id,
        machine_id: machine.id,
      });
      res.status(409).json({ error: "Restart/upgrade is only available for managed Computers", code: "not_a_computer" });
      return;
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;

    // The control command rides the machine's live WS, which is replica-local.
    // Replay to the owning replica when this machine isn't connected here
    // (mirrors the workspace-scan route). A machine with no owning replica
    // anywhere is genuinely offline.
    const routing = await handleMachineLocalRouting(
      req,
      res,
      req.params.machineId,
      () => agentOrchestrator.hasMachineLocally(req.params.machineId),
    );
    if (routing === "handled") return;
    if (routing !== "confirmed_local") {
      addTraceEvent("computer.control.rejected", {
        action,
        reason: "computer_offline",
        server_id: req.params.id,
        machine_id: machine.id,
      });
      res.status(409).json({ error: "Computer is not online", code: "computer_offline" });
      return;
    }
    if (action === "upgrade") {
      // Remote upgrade v2 (task #873): resolve the exact target, record one
      // request row, send the command. The machine's next reconnect is the only
      // readback. Behind a flag so the web button stays greyed until switched on.
      // The broadcast policy below reads this same flag (it is the single gate
      // for every Server-initiated upgrade send); checking it here first just
      // gives a clearer 403 than the policy's `broadcast_disabled` 409.
      const gate = await evaluateFeatureFlag({
        key: REMOTE_COMPUTER_UPGRADE_V2_FEATURE_FLAG_KEY,
        userId: req.userId!,
        serverId: req.params.id,
      });
      if (!gate.enabled) {
        addTraceEvent("computer.control.rejected", {
          action,
          reason: "remote_upgrade_disabled",
          server_id: req.params.id,
          machine_id: machine.id,
        });
        res.status(403).json({ error: "Remote Computer upgrade is not enabled for this server", code: "remote_upgrade_disabled" });
        return;
      }
      const sourceFact = await readComputerSourceFact(agentOrchestrator, machine.id);
      // Older Computers are not driven from the web (the button is greyed and
      // the panel shows the local upgrade hint); refuse here too so the state
      // cannot be bypassed by a direct request.
      if (isRemoteUpgradeSupported(sourceFact?.version) !== true) {
        addTraceEvent("computer.control.rejected", {
          action,
          reason: "computer_remote_upgrade_unsupported",
          server_id: req.params.id,
          machine_id: machine.id,
          computer_version: sourceFact?.version ?? "",
        });
        res.status(409).json({
          error: "This Computer version cannot be upgraded from the web. Upgrade it once on the machine itself.",
          code: "computer_remote_upgrade_unsupported",
        });
        return;
      }
      const decision = await computerBroadcastPolicyEvaluator(req.app)({
        source: sourceFact,
        platform: normalizeComputerPlatform(machine.os),
        requestedTargetVersion,
        now: new Date(agentOrchestrator.getCurrentTimeMs()),
        serverId: req.params.id,
      });
      if (decision.eligibility !== "eligible" || !decision.targetVersion) {
        addTraceEvent("computer.control.rejected", {
          action,
          reason: "computer_broadcast_not_eligible",
          server_id: req.params.id,
          machine_id: machine.id,
        });
        res.status(decision.reasonCode === "hands_unavailable" ? 503 : 409).json({
          error: "This Computer source is not eligible for an upgrade right now.",
          code: "computer_broadcast_not_eligible",
          policy: projectComputerBroadcastPolicyDecision(decision),
        });
        return;
      }
      const { row, created } = await createComputerUpgradeRequest({
        serverId: req.params.id,
        machineId: machine.id,
        targetVersion: decision.targetVersion,
        requestedByUserId: req.userId!,
        now: new Date(agentOrchestrator.getCurrentTimeMs()),
      });
      if (created) {
        const { sent } = await agentOrchestrator.sendComputerUpgrade(machine.id, row.targetVersion, row.id);
        if (!sent) {
          res.status(409).json({ error: "Computer is not online", code: "computer_offline" });
          return;
        }
      }
      addTraceEvent("upgrade_request.recorded", {
        request_id: row.id,
        server_id: req.params.id,
        machine_id: machine.id,
        target_version: row.targetVersion,
        created,
      });
      res.status(created ? 201 : 200).json({ upgradeRequest: projectComputerUpgradeRequest(row) });
      return;
    }
    // Minimum supported Computer is the next release (xxchan 09-22): no
    // version floors or historical-ingress remaps remain here.
    const dispatchTargetVersion = (await readComputerSourceFact(agentOrchestrator, machine.id))?.version ?? null;
    if (!dispatchTargetVersion) {
      addTraceEvent("computer.control.rejected", {
        action,
        reason: "computer_control_unsupported",
        server_id: req.params.id,
        machine_id: machine.id,
      });
      res.status(409).json({
        error: "Raft couldn't verify the Computer version. Reconnect the Computer, then try again.",
        code: "computer_control_unsupported",
      });
      return;
    }
    const dispatchAction = action;
    const supervisorCapable = agentOrchestrator.hasMachineCapability(
      machine.id,
      COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS,
    );
    const dispatchAdapter = supervisorCapable ? "supervisor-v1" : "runner-first-hop-v1";
    // Task #91: the operation + dispatch admission is re-authorized inside the write transaction (member row first, machine
    // row second, FOR SHARE: admission never updates the machine row). Sending the command and marking it sent below are the
    // runtime effect and its bookkeeping (task #93).
    const connectionEpochBefore = agentOrchestrator.getMachineConnectionEpoch?.(machine.id) ?? null;
    const operation = await withActorMembershipFence(req.params.id, req.userId!, async (tx, lockedRole) => {
      const [lockedMachine] = await tx
        .select({ id: machinesTable.id, serverId: machinesTable.serverId, userId: machinesTable.userId })
        .from(machinesTable)
        .where(eq(machinesTable.id, machine.id))
        .for("share");
      if (!lockedMachine || lockedMachine.serverId !== req.params.id) throw new FencedAuthorizationDeniedError("not_found");
      if (!canManageMachineResource(lockedRole, req.userId!, lockedMachine, "controlComputers")) {
        throw new FencedAuthorizationDeniedError("forbidden");
      }
      return createUserComputerLifecycleOperation({
        serverId: req.params.id,
        machineId: machine.id,
        actorUserId: req.userId!,
        action,
        dispatchMode: "server",
        connectionEpochBefore,
        targetVersion: dispatchTargetVersion,
        dispatch: {
          action: dispatchAction,
          targetVersion: dispatchTargetVersion,
          adapter: dispatchAdapter,
        },
      }, { executor: tx });
    });
    if (!operation?.dispatch) {
      res.status(409).json({
        error: "Another Computer lifecycle operation is already in progress for this machine",
        code: "computer_operation_in_progress",
      });
      return;
    }
    addTraceEvent("operation.intent.recorded", {
      operation_id: operation.operationId,
      dispatch_operation_id: operation.dispatch.operationId,
      action,
      server_id: req.params.id,
      machine_id: machine.id,
      dispatch_mode: "server",
    });
    const { sent, requestId } = await agentOrchestrator.sendComputerControl(
      machine.id,
      operation.dispatch.action,
      operation.dispatch.operationId,
    );
    if (!sent) {
      addTraceEvent("operation.command.deferred", {
        operation_id: operation.operationId,
        dispatch_operation_id: operation.dispatch.operationId,
        action: operation.dispatch.action,
        reason: "connection_changed_before_send",
        server_id: req.params.id,
        machine_id: machine.id,
        request_id: requestId,
      });
      res.status(202).json({ ok: true, action, requestId, queued: true });
      return;
    }
    await markComputerLifecycleCommandSent(operation.dispatch.operationId);
    addTraceEvent("computer.control.sent", {
      action: operation.dispatch.action,
      user_action: action,
      server_id: req.params.id,
      machine_id: machine.id,
      request_id: requestId,
      computer_version: dispatchTargetVersion,
    });
    addTraceEvent("operation.command.sent", {
      operation_id: operation.operationId,
      dispatch_operation_id: operation.dispatch.operationId,
      action: operation.dispatch.action,
      server_id: req.params.id,
      machine_id: machine.id,
      request_id: requestId,
      computer_version: dispatchTargetVersion,
    });
    res.json({ ok: true, action, requestId, operationId: operation.operationId });
  } catch (error) {
    if (error instanceof ServerMembershipRevokedError) {
      res.status(403).json({ error: error.message });
      return;
    }
    if (error instanceof FencedAuthorizationDeniedError) {
      if (error.reason === "not_found") {
        res.status(404).json({ error: "Machine not found in this server" });
      } else {
        res.status(403).json({ error: "The `controlComputers` capability or machine creator authority is required to control Computers" });
      }
      return;
    }
    addTraceEvent("computer.control.failed", {
      action: req.params.action,
      server_id: req.params.id,
      machine_id: req.params.machineId,
      error_class: errorClassOf(error),
    });
    res.status(500).json({ error: "Failed to relay Computer control command" });
  }
});

serverRouter.post("/:id/machines/:machineId/computer-lifecycle-operations", async (req, res) => {
  const action = req.body?.action;
  const operationId = req.body?.operationId;
  const parentOperationId = req.body?.parentOperationId;
  let targetVersion = req.body?.targetVersion;
  const completionMode = req.body?.completionMode;
  if (typeof action !== "string" || !LOCAL_COMPUTER_LIFECYCLE_ACTIONS.has(action as "start" | "stop" | "restart" | "upgrade")) {
    res.status(400).json({ error: "Unknown Computer lifecycle action", code: "unknown_action" });
    return;
  }
  if (typeof operationId !== "string" || !UUID_RE.test(operationId)) {
    res.status(400).json({ error: "A valid operationId is required", code: "invalid_operation_id" });
    return;
  }
  if (typeof parentOperationId !== "string" || !UUID_RE.test(parentOperationId)) {
    res.status(400).json({ error: "A valid parentOperationId is required", code: "invalid_parent_operation_id" });
    return;
  }
  if ((action === "upgrade" && targetVersion !== undefined && (typeof targetVersion !== "string"
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(targetVersion)))
    || (action !== "upgrade" && targetVersion !== undefined)) {
    res.status(400).json({ error: "A valid targetVersion is required only for upgrade", code: "invalid_target_version" });
    return;
  }
  if (completionMode !== undefined && (action !== "upgrade" || completionMode !== "legacy_k_promoted")) {
    res.status(400).json({ error: "Unknown Computer lifecycle completion mode", code: "invalid_completion_mode" });
    return;
  }
  const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
  if (!callerRole) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  const machine = await machineService.getMachine(asMachineId(req.params.machineId));
  if (!machine || machine.serverId !== req.params.id) {
    res.status(404).json({ error: "Machine not found in this server" });
    return;
  }
  if (!canManageMachineResource(callerRole, req.userId!, machine, "controlComputers")) {
    res.status(403).json({ error: "The `controlComputers` capability or machine creator authority is required to control Computers" });
    return;
  }
  const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
  const routing = await handleMachineLocalRouting(
    req,
    res,
    machine.id,
    () => orchestrator.hasMachineLocally(machine.id),
  );
  if (routing === "handled") return;
  const connectionEpoch = routing === "confirmed_local"
    ? orchestrator.getMachineConnectionEpoch?.(machine.id) ?? null
    : null;
  if (action === "start" && connectionEpoch) {
    res.status(409).json({ error: "Computer is already online", code: "computer_already_online" });
    return;
  }
  if (action !== "start" && !connectionEpoch) {
    res.status(409).json({ error: "Computer is not online", code: "computer_offline" });
    return;
  }
  if (action === "upgrade" && targetVersion === undefined) {
    // An operation's recorded target is immutable. Replays must not depend on
    // today's alpha selection or Hands availability. Authenticate and route the
    // caller first, and do not adopt another actor's or parent's operation.
    const [existing] = await getDb().select().from(computerLifecycleOperations)
      .where(eq(computerLifecycleOperations.id, operationId)).limit(1);
    if (existing) {
      if (existing.serverId !== req.params.id || existing.machineId !== machine.id
        || existing.actorUserId !== req.userId || existing.parentOperationId !== parentOperationId
        || existing.action !== action || existing.dispatchMode !== "local" || !existing.targetVersion) {
        res.status(409).json({ error: "Operation identity does not match", code: "computer_lifecycle_operation_conflict" });
        return;
      }
      targetVersion = existing.targetVersion;
    }
  }
  if (action === "upgrade" && targetVersion === undefined) {
    const decision = await computerBroadcastPolicyEvaluator(req.app)({
      source: await readComputerSourceFact(orchestrator, machine.id),
      platform: normalizeComputerPlatform(machine.os),
      now: new Date(orchestrator.getCurrentTimeMs()),
      serverId: req.params.id,
    });
    if (decision.eligibility !== "eligible" || !decision.targetVersion) {
      res.status(decision.reasonCode === "hands_unavailable" ? 503 : 409).json({
        error: "Hands could not select a newer alpha release for this Computer.",
        code: "computer_upgrade_unavailable",
        policy: projectComputerBroadcastPolicyDecision(decision),
      });
      return;
    }
    targetVersion = decision.targetVersion;
  }
  // `dispatchMode=local` is the established lifecycle name for an explicit,
  // user-authenticated per-machine operation; it is not a claim about network
  // locality. Machine creators and roles with `controlComputers` may perform
  // this deliberate manual override. The Computer caller has already resolved
  // its exact target through Hands, or the Server resolved alpha above for
  // an older caller that omitted the target. The legacy completion path still needs a live
  // source readback because it is adopting an upgrade that K already completed.
  const source = completionMode === "legacy_k_promoted"
    ? await readComputerSourceFact(orchestrator, machine.id)
    : null;
  if (completionMode === "legacy_k_promoted") {
    if (!source) {
      res.status(409).json({
        error: "The live Computer ready attestation is not visible yet.",
        code: "computer_lifecycle_completion_ready_pending",
      });
      return;
    }
    if (typeof targetVersion !== "string"
      || source.version !== targetVersion
      || source.provenance !== "owner_connection"
      || typeof source.observedAt !== "string") {
      res.status(409).json({
        error: "The live Computer does not attest this completed target.",
        code: "computer_lifecycle_completion_target_mismatch",
      });
      return;
    }
  }
  const legacyCompletionIdentity = completionMode === "legacy_k_promoted"
    ? {
        completionMode,
        connectionEpoch,
        sourceVersion: source!.version,
        sourceObservedAt: source!.observedAt,
        sourceProvenance: source!.provenance,
      }
    : null;
  // Task #91: the operation admission is re-authorized inside the write transaction (member row first, machine row second,
  // FOR SHARE). This handler has no outer try/catch, so only fence denials are mapped here; anything else still propagates.
  let operation: Awaited<ReturnType<typeof createUserComputerLifecycleOperation>>;
  try {
    operation = await withActorMembershipFence(req.params.id, req.userId!, async (tx, lockedRole) => {
      const [lockedMachine] = await tx
        .select({ id: machinesTable.id, serverId: machinesTable.serverId, userId: machinesTable.userId })
        .from(machinesTable)
        .where(eq(machinesTable.id, machine.id))
        .for("share");
      if (!lockedMachine || lockedMachine.serverId !== req.params.id) throw new FencedAuthorizationDeniedError("not_found");
      if (!canManageMachineResource(lockedRole, req.userId!, lockedMachine, "controlComputers")) {
        throw new FencedAuthorizationDeniedError("forbidden");
      }
      return createUserComputerLifecycleOperation({
    operationId,
    parentOperationId,
    serverId: req.params.id,
    machineId: machine.id,
    actorUserId: req.userId!,
    action: action as "start" | "stop" | "restart" | "upgrade",
    dispatchMode: "local",
    connectionEpochBefore: connectionEpoch,
    ...(action === "upgrade"
      ? {
          targetVersion: targetVersion as string,
          ...(legacyCompletionIdentity
            ? { broadcastPolicyDecision: legacyCompletionIdentity }
            : {}),
        }
      : {}),
      }, { executor: tx });
    });
  } catch (error) {
    if (error instanceof ServerMembershipRevokedError) {
      res.status(403).json({ error: error.message });
      return;
    }
    if (error instanceof FencedAuthorizationDeniedError) {
      if (error.reason === "not_found") {
        res.status(404).json({ error: "Machine not found in this server" });
      } else {
        res.status(403).json({ error: "The `controlComputers` capability or machine creator authority is required to control Computers" });
      }
      return;
    }
    throw error;
  }
  if (!operation) {
    res.status(409).json({ error: "Lifecycle operations are only available for managed Computers", code: "not_a_computer" });
    return;
  }
  addTraceEvent("operation.intent.recorded", {
    operation_id: operation.operationId,
    action,
    server_id: req.params.id,
    machine_id: machine.id,
    dispatch_mode: "local",
  });
  res.status(201).json({
    ...operation,
    action,
    ...(action === "upgrade" ? { targetVersion } : {}),
  });
});

// Scan workspace directories on a machine (admin/owner only)
serverRouter.get("/:id/machines/:machineId/workspaces", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!callerRole) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const machine = await machineService.getMachine(asMachineId(req.params.machineId));
    if (!machine || machine.serverId !== req.params.id) {
      res.status(404).json({ error: "Machine not found in this server" });
      return;
    }
    if (!canManageMachineResource(callerRole, req.userId!, machine, "editMachines")) {
      res.status(403).json({ error: "You do not have permission to view machine workspaces" });
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;

    const routing = await handleMachineLocalRouting(
      req,
      res,
      req.params.machineId,
      () => agentOrchestrator.hasMachineLocally(req.params.machineId),
    );
    if (routing === "handled") return;
    if (routing !== "confirmed_local") {
      sendMachineAffinityUnavailable(res, req.params.machineId);
      return;
    }

    const directories = await agentOrchestrator.scanMachineWorkspaces(req.params.machineId);

    // The daemon lists every workspace under the Computer's shared data root, and a
    // Computer attached to several servers holds each server's agents there side by
    // side under one `machines` row per server. Directory names are agent ids, so
    // this server's own agent records -- live or soft-deleted -- are the only proof
    // of ownership available. Anything else is another tenant's workspace or one
    // this server cannot account for, and is not reported: labelling it "orphan"
    // invited exactly the cross-server deletion the delete route now refuses.
    const ownAgents = await agentService.listAgents(req.params.id, true);
    const agentMap = new Map(ownAgents.map((a) => [a.id, a]));

    const enriched = directories.flatMap((dir) => {
      const agent = agentMap.get(dir.directoryName);
      if (!agent) return [];
      const status: "active" | "stopped" | "deleted" = agent.deletedAt
        ? "deleted"
        : agent.status === "inactive" ? "stopped" : "active";
      return [{
        ...dir,
        status,
        agentName: agent.displayName || agent.name || null,
        agentStatus: agent.status,
      }];
    });

    res.json(enriched);
  } catch (err: any) {
    sendJsonServerError(req, res, {
      error: "Failed to scan workspaces",
      code: "machine_workspace_scan_failed",
      logPrefix: "[Servers] Failed to scan machine workspaces",
      err,
    });
  }
});

// Project raw Computer capabilities through this server's new-agent admission policy.
serverRouter.get("/:id/machines/:machineId/runtime-options", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!callerRole) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const machine = await machineService.getMachine(asMachineId(req.params.machineId));
    if (!machine || machine.serverId !== req.params.id) {
      res.status(404).json({ error: "Computer not found" });
      return;
    }
    if (!canManageMachineResource(callerRole, req.userId!, machine, "editMachines")) {
      res.status(403).json({ error: "The `editMachines` capability or machine creator authority is required to inspect runtime options" });
      return;
    }
    const policy = await resolveRuntimeAdmissionPolicy({
      serverId: req.params.id,
      userId: req.userId!,
    });
    res.json({
      context: "new_agent",
      machineId: machine.id,
      options: projectNewAgentRuntimeOptions(machine.runtimes ?? [], policy),
    });
  } catch {
    res.status(500).json({ error: "Failed to load runtime options" });
  }
});

// Private runtime-account usage cache. The attaching human and current server
// admins may inspect the normalized summary; ordinary members remain excluded.
// Provider credentials and raw responses never enter this cache. Account
// identity may cross this boundary only as the schema-validated masked label.
serverRouter.get("/:id/machines/:machineId/runtime-account-usage/:provider", async (req, res) => {
  try {
    if (!isRuntimeAccountUsageProvider(req.params.provider)) {
      res.status(404).json({ error: "Runtime account usage provider not found" });
      return;
    }
    const machine = await machineService.getMachine(asMachineId(req.params.machineId));
    if (!machine || machine.serverId !== req.params.id) {
      res.status(404).json({ error: "Computer not found" });
      return;
    }
    if (!await canInspectRuntimeAccountUsage(req.params.id, machine.id, req.userId!)) {
      res.status(403).json({ error: "The `editMachines` capability or attaching-human authority is required to inspect runtime account usage" });
      return;
    }

    res.setHeader("Cache-Control", "private, no-store");
    const result = await runtimeAccountUsageCacheService.read(machine.id, req.params.provider);
    if (result.state === "missing") {
      res.json(result);
      return;
    }
    res.json(result);
  } catch {
    res.status(500).json({ error: "Failed to load runtime account usage" });
  }
});

serverRouter.post("/:id/machines/:machineId/runtime-account-usage/:provider/refresh", async (req, res) => {
  try {
    if (!isRuntimeAccountUsageProvider(req.params.provider)) {
      res.status(404).json({ error: "Runtime account usage provider not found" });
      return;
    }
    const machine = await machineService.getMachine(asMachineId(req.params.machineId));
    if (!machine || machine.serverId !== req.params.id) {
      res.status(404).json({ error: "Computer not found" });
      return;
    }
    if (!await canInspectRuntimeAccountUsage(req.params.id, machine.id, req.userId!)) {
      res.status(403).json({ error: "The `editMachines` capability or attaching-human authority is required to refresh runtime account usage" });
      return;
    }

    const reason = req.body?.reason === "stale_or_missing" ? "stale_or_missing" : "manual";
    const acquired = await runtimeAccountUsageCacheService.tryAcquireRefresh(machine.id, req.params.provider);
    if (!acquired) {
      res.status(202).json({ accepted: false, state: "cooldown" });
      return;
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    if (reason !== "manual") {
      // Background-triggered refreshes stay fire-and-forget: the snapshot
      // arrives through the normal push path and lands in the cache.
      const sent = await agentOrchestrator.requestRuntimeAccountUsageRefresh(
        machine.id,
        req.params.provider,
        reason,
      );
      res.status(202).json({
        accepted: sent,
        state: sent ? "requested" : "computer_offline",
      });
      return;
    }
    // Manual refreshes wait for the computer's correlated snapshot through the
    // machine response relay, so the caller renders the fresh value in place
    // instead of polling. The cache write happens once, in the orchestrator's
    // inbound switch, before the relay resolves this request.
    try {
      const reply = await agentOrchestrator.requestRuntimeAccountUsageRefreshAndAwait(
        machine.id,
        req.params.provider,
      );
      res.status(200).json({ accepted: true, state: "fresh", snapshot: reply.snapshot });
    } catch (error) {
      if (error instanceof RouteFailureError && error.subkind === "daemon_timeout") {
        res.status(200).json({ accepted: true, state: "timeout" });
        return;
      }
      if (error instanceof RouteFailureError && error.subkind === "daemon_offline") {
        res.status(202).json({ accepted: false, state: "computer_offline" });
        return;
      }
      throw error;
    }
  } catch {
    res.status(500).json({ error: "Failed to refresh runtime account usage" });
  }
});

// Runtime form definitions. v1 is version-pinned and served only for the
// runtimes with a frozen v1 form (runtimeFormV1Entry); v2 is the current form of
// any runtime in the v2 registry (runtimeFormV2Registry). Every other runtime
// continues to use the legacy Web form.
const handleRuntimeFormDefinition = (protocol: 1 | 2): RequestHandler<{ id: string; machineId: string; runtimeId: string }> => async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!callerRole) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const machine = await machineService.getMachine(asMachineId(req.params.machineId));
    if (!machine || machine.serverId !== req.params.id) {
      res.status(404).json({ error: "Computer not found" });
      return;
    }
    if (!canManageMachineResource(callerRole, req.userId!, machine, "editMachines")) {
      res.status(403).json({ error: "The `editMachines` capability or machine creator authority is required to inspect runtime form definitions" });
      return;
    }
    const v1 = protocol === 1 ? runtimeFormV1Entry(req.params.runtimeId) : null;
    const v2 = protocol === 2 ? runtimeFormV2Entry(req.params.runtimeId) : null;
    if (!v1 && !v2) {
      res.status(404).json({
        error: "Runtime form definition not found",
        issues: [{ code: "unknown_form_runtime", pointer: "/runtimeId" }],
      });
      return;
    }
    // v1 clients pin a schemaVersion; v2 clients take the current form as it is.
    if (v1 && req.query.schemaVersion !== v1.ref.schemaVersion) {
      res.status(409).json({
        error: "Runtime form schema is stale or unknown",
        issues: [{ code: "stale_form_schema", pointer: "/schemaVersion" }],
      });
      return;
    }
    // A released version is answered from its frozen sample, never from current
    // code, so a server change cannot break clients that already shipped it
    // (packages/runtime-form/README.md).
    const definition = v2
      ? v2.buildForm()
      : releasedRuntimeFormDefinition(v1!.ref.schemaVersion) ?? v1!.buildDefinition();
    const projectionIssues = (v2 ?? v1!).validateProjection();
    if (projectionIssues.length > 0) {
      res.status(500).json({ error: "Runtime form projection drift", issues: projectionIssues });
      return;
    }
    res.json(definition);
  } catch {
    res.status(500).json({ error: "Failed to load runtime form definition" });
  }
};
serverRouter.get("/:id/machines/:machineId/runtime-form-definitions/:runtimeId", handleRuntimeFormDefinition(1));
serverRouter.get("/:id/machines/:machineId/runtime-forms/v2/:runtimeId", handleRuntimeFormDefinition(2));

const handleRuntimeFormOptionSource = (protocol: 1 | 2): RequestHandler<{ id: string; machineId: string; runtimeId: string; sourceId: string }> => async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!callerRole) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const machine = await machineService.getMachine(asMachineId(req.params.machineId));
    if (!machine || machine.serverId !== req.params.id) {
      res.status(404).json({ error: "Computer not found" });
      return;
    }
    if (!canManageMachineResource(callerRole, req.userId!, machine, "editMachines")) {
      res.status(403).json({ error: "The `editMachines` capability or machine creator authority is required to inspect runtime form option sources" });
      return;
    }
    // Option values are the same on both protocols; v1 serves them only for the
    // runtimes that have a v1 form.
    const v1 = protocol === 1 ? runtimeFormV1Entry(req.params.runtimeId) : null;
    const entry = protocol === 2 || v1 ? runtimeFormV2Entry(req.params.runtimeId) : null;
    if (!entry) {
      res.status(404).json({
        error: "Runtime form option source not found",
        issues: [{ code: "unknown_form_runtime", pointer: "/runtimeId" }],
      });
      return;
    }
    if (v1 && req.query.schemaVersion !== v1.ref.schemaVersion) {
      res.status(409).json({
        error: "Runtime form schema is stale or unknown",
        issues: [{ code: "stale_form_schema", pointer: "/schemaVersion" }],
      });
      return;
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const resolution = await entry.resolveOptionSource({
      sourceId: req.params.sourceId,
      machineId: req.params.machineId,
      machine,
      // A client's retry of a non-live source (`option_source.status`), v2 only.
      refresh: protocol === 2 && req.query.refresh === "1",
      agentOrchestrator,
      routeToComputer: () => handleMachineLocalRouting(
        req,
        res,
        req.params.machineId,
        () => agentOrchestrator.hasMachineLocally(req.params.machineId),
      ),
    });
    if (resolution.kind === "handled") return;
    if (resolution.kind === "reply") {
      res.status(resolution.status).json(resolution.body);
      return;
    }
    const source = resolution.source;
    if (!source) {
      res.status(404).json({
        error: "Runtime form option source not found",
        issues: [{ code: "unknown_option_source", pointer: "/sourceId" }],
      });
      return;
    }
    const projectionIssues = (v1 ?? entry).validateProjection();
    if (projectionIssues.length > 0) {
      res.status(500).json({ error: "Runtime form projection drift", issues: projectionIssues });
      return;
    }
    res.json(source);
  } catch (err) {
    if (err instanceof MachineCatalogStaleError) {
      res
        .status(409)
        .json({ error: err.message, code: err.code, recovery: "retry" });
      return;
    }
    if (err instanceof BuiltInModelCatalogError) {
      res.status(409).json({
        error: err.message,
        code: err.code,
        requestedModel: err.requestedModel,
        daemonVersion: err.daemonVersion,
        computerVersion: err.computerVersion,
        catalogRuntimeVersion: err.catalogRuntimeVersion,
        recovery: err.recovery,
      });
      return;
    }
    res.status(500).json({ error: "Failed to load runtime form option source" });
  }
};
serverRouter.get(
  "/:id/machines/:machineId/runtime-form-definitions/:runtimeId/option-sources/:sourceId",
  handleRuntimeFormOptionSource(1),
);
serverRouter.get(
  "/:id/machines/:machineId/runtime-forms/v2/:runtimeId/option-sources/:sourceId",
  handleRuntimeFormOptionSource(2),
);

// Detect runtime models on a machine on-demand (used by Create/Edit agent picker)
// Ask the computer to re-detect its installed runtimes. The fresh list arrives
// over the normal capabilities push, so this returns as soon as the request is
// away rather than pretending to wait for a result.
serverRouter.post("/:id/machines/:machineId/runtimes/rescan", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!callerRole) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const machine = await machineService.getMachine(asMachineId(req.params.machineId));
    if (!machine || machine.serverId !== req.params.id) {
      res.status(404).json({ error: "Computer not found" });
      return;
    }
    if (!canManageMachineResource(callerRole, req.userId!, machine, "editMachines")) {
      res.status(403).json({ error: "The `editMachines` capability or machine creator authority is required to rescan runtimes" });
      return;
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    const requested = await agentOrchestrator?.rescanMachineRuntimes(req.params.machineId);
    if (!requested) {
      res.status(409).json({ error: "Computer is offline" });
      return;
    }
    res.json({ requested: true });
  } catch {
    res.status(500).json({ error: "Failed to request a runtime rescan" });
  }
});

/**
 * Member-readable model-label catalog (task #700). One shared source every
 * display surface resolves model names from: the daemon reports each
 * runtime's model list, the server stores it per machine, and the
 * runtime-config dropdown, name rows, machine page, panel badge and profile
 * card all read this same copy. Deliberately only ids, labels and report
 * timestamps — nothing else from the computer.
 */
serverRouter.get("/:id/model-label-catalog", async (req, res) => {
  const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
  if (!callerRole) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  // Any member — guests included — renders agent name rows, so any member may
  // read the display catalog; the payload is only ids, labels and timestamps.
  const machines = await machineService.listMachines(req.params.id);
  const response: ServerModelLabelCatalog = { machines: {} };
  for (const machine of machines) {
    const catalog = await machineRuntimeModelCatalogService.read(machine.id);
    if (Object.keys(catalog.runtimes).length > 0) {
      response.machines[machine.id] = catalog;
    }
  }
  res.json(response);
});

serverRouter.get("/:id/machines/:machineId/runtime-models/:runtime", async (req, res) => {
  let observedDaemonVersion: string | null = null;
  addTraceEvent("runtime_models.detect.started", {
    runtime: req.params.runtime,
  });
  try {
    const callerRole = await tracePhase(
      () => getActorServerRoleInServer(req.params.id, "user", req.userId!),
      (_durationMs, role) => ({
        name: "server.membership.checked",
        attrs: { is_member: Boolean(role) },
      }),
    );
    if (!callerRole) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const machine = await tracePhase(
      () => machineService.getMachine(asMachineId(req.params.machineId)),
      (_durationMs, result) => ({
        name: "machine.loaded",
        attrs: {
          machine_found: Boolean(result),
          server_match: Boolean(result && result.serverId === req.params.id),
        },
      }),
    );
    if (!machine || machine.serverId !== req.params.id) {
      res.status(404).json({ error: "Machine not found in this server" });
      return;
    }
    if (!canManageMachineResource(callerRole, req.userId!, machine, "editMachines")) {
      res.status(403).json({ error: "The `editMachines` capability or machine creator authority is required to inspect runtime models" });
      return;
    }
    observedDaemonVersion = machine.daemonVersion;

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;

    const routing = await handleMachineLocalRouting(
      req,
      res,
      req.params.machineId,
      () => agentOrchestrator.hasMachineLocally(req.params.machineId),
    );
    if (routing === "handled") return;
    if (routing !== "confirmed_local") {
      addTraceEvent("machine.routing.checked", {
        machine_local: false,
        fly_instance_present: false,
      });
      addTraceEvent("runtime_models.detect.skipped", {
        reason: "machine_offline",
        runtime: req.params.runtime,
      });
      res.json({ kind: "error", retryable: true, code: "computer_offline" });
      return;
    }
    addTraceEvent("machine.routing.checked", {
      machine_local: true,
      fly_instance_present: false,
    });

    const result = await tracePhase(
      () => agentOrchestrator.detectMachineRuntimeModels(req.params.machineId, req.params.runtime),
      (_durationMs, detectResult) => ({
        name: "runtime_models.detected",
        attrs: {
          runtime: req.params.runtime,
          daemon_version: observedDaemonVersion ?? "unknown",
          daemon_version_present: observedDaemonVersion != null,
          ...(!observedDaemonVersion ? { daemon_version_reason: "version_unknown_no_handshake" } : {}),
          outcome: detectResult.kind,
          models_count: detectResult.kind === "live" ? detectResult.value.models.length : 0,
          default_model_present: detectResult.kind === "live" && Boolean(detectResult.value.default),
        },
      }),
    );
    addTraceEvent("response.ready", {
      runtime: req.params.runtime,
      outcome: result.kind,
      models_count: result.kind === "live" ? result.value.models.length : 0,
      default_model_present: result.kind === "live" && Boolean(result.value.default),
    });
    res.json(result.kind === "live"
      ? {
          ...result,
          models: result.value.models,
          ...(result.value.default ? { default: result.value.default } : {}),
        }
      : result);
  } catch (err: any) {
    traceRouteFailure("runtime_models.detect.failed", err, {
      runtime: req.params.runtime,
      daemon_version: observedDaemonVersion ?? "unknown",
      daemon_version_present: observedDaemonVersion != null,
      ...(!observedDaemonVersion ? { daemon_version_reason: "version_unknown_no_handshake" } : {}),
    });
    res.json({
      kind: "error", retryable: true,
      ...(err instanceof RouteFailureError && err.subkind === "daemon_offline"
        ? { code: "computer_offline" }
        : err instanceof RouteFailureError && err.subkind === "daemon_timeout"
          ? { code: "detect_timeout" }
          : {}),
    });
  }
});

async function authorizeMentionDeliveryDiagnostic(req: Request) {
  const serverId = req.params.id;
  const machineId = req.params.machineId;
  const agentId = req.params.agentId;
  if (typeof serverId !== "string" || typeof machineId !== "string" || typeof agentId !== "string") return null;
  const callerRole = await getActorServerRoleInServer(serverId, "user", req.userId!);
  if (!callerRole) return null;
  const machine = await machineService.getMachine(asMachineId(machineId));
  if (!machine || machine.serverId !== serverId) return null;
  const agent = await agentService.getAgent(agentId);
  if (!agent || agent.serverId !== serverId || agent.machineId !== machineId) return null;
  if (!await canInspectAgentPrivateSurfaces(serverId, req.userId!, agent)) return null;
  return agent;
}

serverRouter.get("/:id/machines/:machineId/agents/:agentId/diagnostic/mention-delivery/:messageId", async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.messageId)) {
      res.status(404).json({ status: "NOT_JOINABLE" });
      return;
    }
    if (!await authorizeMentionDeliveryDiagnostic(req)) {
      res.status(404).json({ status: "NOT_ACCESSIBLE" });
      return;
    }
    const result = await mentionDeliveryOccurrenceService.lookupMentionDeliveryOccurrence(
      req.params.messageId,
      req.params.agentId,
    );
    res.status(result.status === "NOT_JOINABLE" ? 404 : 200).json(result);
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to inspect mention delivery",
      code: "mention_delivery_lookup_failed",
      logPrefix: "[Servers] Failed to inspect mention delivery",
      err,
    });
  }
});

serverRouter.post("/:id/machines/:machineId/agents/:agentId/diagnostic/mention-delivery/:messageId/redrive", async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.messageId)) {
      res.status(404).json({ status: "NOT_JOINABLE" });
      return;
    }
    if (!await authorizeMentionDeliveryDiagnostic(req)) {
      res.status(404).json({ status: "NOT_ACCESSIBLE" });
      return;
    }
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    if (
      Object.keys(body).length !== 1
      || !Object.hasOwn(body, "expectedVersion")
      || !Number.isSafeInteger(body.expectedVersion)
      || (body.expectedVersion as number) < 0
    ) {
      res.status(400).json({ status: "INVALID_REQUEST" });
      return;
    }
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const result = await agentOrchestrator.redriveMentionDelivery(
      req.params.messageId,
      req.params.agentId,
      body.expectedVersion as number,
    );
    // Mapping lives in planMentionRedriveHttpStatus so it is reachable without an HTTP app —
    // this path had zero arms across route, authorize fn and orchestrator method (@Kabi, 6700).
    res.status(planMentionRedriveHttpStatus(result.status)).json(result);
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to redrive mention delivery",
      code: "mention_delivery_redrive_failed",
      logPrefix: "[Servers] Failed to redrive mention delivery",
      err,
    });
  }
});

// Get the runtime session transcript for an agent on a machine (creator/admin only).
// This diagnostic surface is intentionally scoped under the explicit server/machine/agent
// hierarchy so the caller proves ownership of all three resources; the daemon reads
// ONLY the sessionId currently bound to the agent row and refuses caller-supplied ids.
serverRouter.get("/:id/machines/:machineId/agents/:agentId/diagnostic/session-transcript", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!callerRole) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const machine = await machineService.getMachine(asMachineId(req.params.machineId));
    if (!machine || machine.serverId !== req.params.id) {
      res.status(404).json({ error: "Machine not found in this server" });
      return;
    }

    const agent = await agentService.getAgent(req.params.agentId);
    if (!agent || agent.serverId !== req.params.id) {
      res.status(404).json({ error: "Agent not found in this server" });
      return;
    }
    if (agent.machineId !== req.params.machineId) {
      res.status(400).json({ error: "Agent is not assigned to this machine" });
      return;
    }
    if (!await canInspectAgentPrivateSurfaces(req.params.id, req.userId!, agent)) {
      res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to view agent diagnostics" });
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;

    const routing = await handleMachineLocalRouting(
      req,
      res,
      req.params.machineId,
      () => agentOrchestrator.hasMachineLocally(req.params.machineId),
    );
    if (routing === "handled") return;
    if (routing !== "confirmed_local") {
      sendMachineAffinityUnavailable(res, req.params.machineId);
      return;
    }

    const result = await agentOrchestrator.getAgentSessionTranscript(req.params.agentId);
    res.json(result);
  } catch (err: any) {
    sendJsonServerError(req, res, {
      error: "Failed to get session transcript",
      code: "session_transcript_failed",
      logPrefix: "[Servers] Failed to get session transcript",
      err,
    });
  }
});

// Request async collection of the agent's session transcript as a trace bundle
// linked to an existing feedback report. The caller must have already created the
// feedback report and obtained consent for transcript collection.
serverRouter.post("/:id/machines/:machineId/agents/:agentId/feedback/:reportId/transcript", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!callerRole) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const machine = await machineService.getMachine(asMachineId(req.params.machineId));
    if (!machine || machine.serverId !== req.params.id) {
      res.status(404).json({ error: "Machine not found in this server" });
      return;
    }

    const agent = await agentService.getAgent(req.params.agentId);
    if (!agent || agent.serverId !== req.params.id) {
      res.status(404).json({ error: "Agent not found in this server" });
      return;
    }
    if (agent.machineId !== req.params.machineId) {
      res.status(400).json({ error: "Agent is not assigned to this machine" });
      return;
    }
    if (!await canInspectAgentPrivateSurfaces(req.params.id, req.userId!, agent)) {
      res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to request transcript collection" });
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;

    const routing = await handleMachineLocalRouting(
      req,
      res,
      req.params.machineId,
      () => agentOrchestrator.hasMachineLocally(req.params.machineId),
    );
    if (routing === "handled") return;
    if (routing !== "confirmed_local") {
      sendMachineAffinityUnavailable(res, req.params.machineId);
      return;
    }

    const feedbackReportId = req.params.reportId;
    const requestedReportGeneratedAt = req.body?.reportGeneratedAt;
    if (
      requestedReportGeneratedAt !== undefined
      && (
        typeof requestedReportGeneratedAt !== "string"
        || !/^\d{4}-\d{2}-\d{2}T/.test(requestedReportGeneratedAt)
        || !Number.isFinite(Date.parse(requestedReportGeneratedAt))
      )
    ) {
      res.status(400).json({ error: "reportGeneratedAt must be an ISO timestamp" });
      return;
    }
    const reportGeneratedAt = typeof requestedReportGeneratedAt === "string"
      ? new Date(Date.parse(requestedReportGeneratedAt)).toISOString()
      : currentDate().toISOString();
    const reportTimeSource = typeof requestedReportGeneratedAt === "string"
      ? "web_report_bundle"
      : "server_request_received";
    // Tier 2 (task #272): the machine's runner log tail is free text about
    // every agent on that machine, so only the machine OWNER may attach it,
    // and only by explicit opt-in per report. Checked here on the receiving
    // side against the machine row — hiding the checkbox in the web UI is not
    // the authorization.
    const requestedMachineLogTail = req.body?.includeMachineLogTail;
    if (requestedMachineLogTail !== undefined && typeof requestedMachineLogTail !== "boolean") {
      res.status(400).json({ error: "includeMachineLogTail must be a boolean" });
      return;
    }
    const includeMachineLogTail = requestedMachineLogTail === true;
    if (includeMachineLogTail && machine.userId !== req.userId) {
      res.status(403).json({
        error: "Only the human who attached this machine may include its runner log tail in a report",
        code: "machine_log_tail_owner_required",
      });
      return;
    }
    // Fire-and-forget: do not await the daemon response so the HTTP call returns quickly.
    agentOrchestrator.collectFeedbackTranscript(req.params.agentId, feedbackReportId, {
      reportGeneratedAt,
      reportTimeSource,
    }, { includeMachineLogTail }).then(
      (outcome) => {
        console.info(`[FeedbackTranscript] collected for report=${feedbackReportId} agent=${req.params.agentId}`, {
          reachable: outcome.reachable,
          traceBundleId: outcome.traceBundleId,
          fallbackReason: outcome.fallbackReason,
          error: outcome.error,
          transcriptWindow: outcome.transcriptWindow,
          machineLogTail: outcome.machineLogTail,
          machineEvidence: outcome.machineEvidence,
          lookup: outcome.lookup,
          upload: outcome.upload,
          outcomeObject: outcome.outcomeObject,
        });
      },
      (err: unknown) => {
        console.error(`[FeedbackTranscript] failed for report=${feedbackReportId} agent=${req.params.agentId}`, err);
      },
    );

    res.status(202).json({ accepted: true, feedbackReportId, agentId: req.params.agentId });
  } catch (err: any) {
    sendJsonServerError(req, res, {
      error: "Failed to request feedback transcript collection",
      code: "feedback_transcript_collection_failed",
      logPrefix: "[Servers] Failed to request feedback transcript collection",
      err,
    });
  }
});

// Delete a workspace directory on a machine (admin/owner only)
serverRouter.delete("/:id/machines/:machineId/workspaces/:directoryName", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (!callerRole) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const machine = await machineService.getMachine(asMachineId(req.params.machineId));
    if (!machine || machine.serverId !== req.params.id) {
      res.status(404).json({ error: "Machine not found in this server" });
      return;
    }
    if (!canManageMachineResource(callerRole, req.userId!, machine, "controlComputers")) {
      res.status(403).json({ error: "The `controlComputers` capability or machine creator authority is required to delete machine workspaces" });
      return;
    }

    // Same shared data root as the scan above: the directory must belong to one of
    // this server's own agents. A soft-deleted agent still qualifies, because its
    // leftover workspace is the legitimate cleanup this route exists for. Any other
    // name -- another server's agent on the same Computer, or nothing this server
    // knows -- is reported as absent rather than forbidden, so the response does not
    // confirm what lives on the host.
    const ownAgents = await agentService.listAgents(req.params.id, true);
    if (!ownAgents.some((agent) => agent.id === req.params.directoryName)) {
      res.status(404).json({ error: "Workspace not found in this server" });
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;

    const routing = await handleMachineLocalRouting(
      req,
      res,
      req.params.machineId,
      () => agentOrchestrator.hasMachineLocally(req.params.machineId),
    );
    if (routing === "handled") return;
    if (routing !== "confirmed_local") {
      sendMachineAffinityUnavailable(res, req.params.machineId);
      return;
    }

    const success = await agentOrchestrator.deleteMachineWorkspaceDir(
      req.params.machineId,
      req.params.directoryName,
    );
    if (!success) {
      res.status(500).json({ error: "Failed to delete workspace directory" });
      return;
    }
    res.json({ ok: true });
  } catch (err: any) {
    sendJsonServerError(req, res, {
      error: "Failed to delete workspace",
      code: "machine_workspace_delete_failed",
      logPrefix: "[Servers] Failed to delete machine workspace",
      err,
    });
  }
});

// Task #70 — the public-server toggle. OWNER ONLY, and deliberately its own
// endpoint rather than a field on PATCH /:id.
//
// PATCH /:id is gated on `editServerSettings`, which admins also hold. @cindyz
// specified owner-only for this one, so folding it in would have silently handed
// it to admins — and nothing in that route would have looked wrong. Keeping it
// separate makes the narrower authority visible at the point it is enforced.
//
// GET returns the exact channel list that becomes world-readable, so the UI can
// show "these channels will be visible to anyone" instead of asking the owner to
// infer it. That list is the same predicate the anonymous route uses.
serverRouter.get("/:id/public-visibility", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (callerRole !== "owner") {
      res.status(403).json({ error: "Only the server owner can manage public visibility" });
      return;
    }
    const gate = await evaluateFeatureFlag({
      key: PUBLIC_SERVER_FEATURE_FLAG_KEY,
      serverId: req.params.id,
      userId: req.userId!,
      platform: "web",
    });
    if (!gate.enabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const [server] = await getDb()
      .select({
        publiclyVisible: servers.publiclyVisible,
        publicGuestJoinEnabled: servers.publicGuestJoinEnabled,
        slug: servers.slug,
      })
      .from(servers)
      .where(eq(servers.id, req.params.id))
      .limit(1);
    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const exposed = await getDb()
      .select({ id: channels.id, name: channels.name, description: channels.description })
      .from(channels)
      .where(and(
        eq(channels.serverId, req.params.id),
        eq(channels.type, "channel"),
        eq(channels.guestVisible, true),
        isNull(channels.deletedAt),
        isNull(channels.archivedAt),
      ))
      .orderBy(channels.name);
    res.json({
      publiclyVisible: server.publiclyVisible,
      publicGuestJoinEnabled: server.publicGuestJoinEnabled,
      slug: server.slug,
      exposedChannels: exposed,
    });
  } catch {
    res.status(500).json({ error: "Failed to read public visibility" });
  }
});

serverRouter.patch("/:id/public-visibility", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (callerRole !== "owner") {
      res.status(403).json({ error: "Only the server owner can manage public visibility" });
      return;
    }
    const gate = await evaluateFeatureFlag({
      key: PUBLIC_SERVER_FEATURE_FLAG_KEY,
      serverId: req.params.id,
      userId: req.userId!,
      platform: "web",
    });
    if (!gate.enabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const { publiclyVisible } = req.body ?? {};
    if (typeof publiclyVisible !== "boolean") {
      res.status(400).json({ error: "publiclyVisible must be a boolean" });
      return;
    }
    const [updated] = await getDb()
      .update(servers)
      .set({
        publiclyVisible,
        ...(publiclyVisible ? {} : { publicGuestJoinEnabled: false }),
        updatedAt: new Date(),
      })
      .where(eq(servers.id, req.params.id))
      .returning({
        publiclyVisible: servers.publiclyVisible,
        publicGuestJoinEnabled: servers.publicGuestJoinEnabled,
      });
    if (!updated) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    res.json(updated);
  } catch {
    res.status(500).json({ error: "Failed to update public visibility" });
  }
});

serverRouter.patch("/:id/public-guest-join", async (req, res) => {
  try {
    const callerRole = await getActorServerRoleInServer(req.params.id, "user", req.userId!);
    if (callerRole !== "owner") {
      res.status(403).json({ error: "Only the server owner can manage public Guest admission" });
      return;
    }
    const [publicGate, guestGate] = await Promise.all([
      evaluateFeatureFlag({ key: PUBLIC_SERVER_FEATURE_FLAG_KEY, serverId: req.params.id, userId: req.userId!, platform: "web" }),
      evaluateFeatureFlag({ key: SERVER_GUEST_FEATURE_FLAG_KEY, serverId: req.params.id, userId: req.userId!, platform: "web" }),
    ]);
    if (!publicGate.enabled || !guestGate.enabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const { publicGuestJoinEnabled } = req.body ?? {};
    if (typeof publicGuestJoinEnabled !== "boolean") {
      res.status(400).json({ error: "publicGuestJoinEnabled must be a boolean" });
      return;
    }
    const [updated] = await getDb().transaction(async (tx) => {
      const [server] = await tx.select({ publiclyVisible: servers.publiclyVisible })
        .from(servers).where(eq(servers.id, req.params.id)).limit(1).for("update");
      if (!server) return [];
      if (publicGuestJoinEnabled && !server.publiclyVisible) return [{ refused: true as const }];
      return tx.update(servers)
        .set({ publicGuestJoinEnabled, updatedAt: new Date() })
        .where(eq(servers.id, req.params.id))
        .returning({ publicGuestJoinEnabled: servers.publicGuestJoinEnabled });
    });
    if (!updated) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    if ("refused" in updated) {
      res.status(409).json({ error: "Public access must be enabled before visitors can join as Guest" });
      return;
    }
    res.json(updated);
  } catch {
    res.status(500).json({ error: "Failed to update public Guest admission" });
  }
});
