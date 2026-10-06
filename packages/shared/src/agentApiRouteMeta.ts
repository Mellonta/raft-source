// Per-route operating metadata for the credential-derived Agent API.
//
// The route contract (`agentApiContract.ts`) says WHAT each route accepts and
// returns. This file says HOW a client may treat it: whether it changes state,
// whether repeating it is safe, and which agent runtimes it serves. Clients
// derive retry policy from it, the SDK derives tool annotations from it, and
// the generated route manifest carries it so every projection (CLI, SDK, tool
// schema) reads one vocabulary.
//
// The vocabulary maps 1:1 onto MCP tool annotations (`readOnlyHint`,
// `destructiveHint`, `idempotentHint`), which the managed MCP catalog already
// uses, so consumers do not learn two dialects.
//
// Rules of classification (keep these when adding a route):
// - `sideEffect` is NOT inferred from the HTTP method. `GET /events` with the
//   default `ack=immediate` acknowledges (consumes) inbox rows before the
//   response is sent, so it is a `destructive_read`; `POST /resolve-channel`
//   changes nothing, so it is a `read`.
// - `idempotency: "natural"` means repeating the same request converges on the
//   same state (join twice = joined). `"key"` means the body carries an
//   idempotency key that makes replays safe. `"none"` means a repeat may act
//   twice or fail the second time; clients must never auto-retry it.
// - `destructive` follows MCP's `destructiveHint`: the route may remove,
//   archive, rotate, transfer, or overwrite existing state that someone else
//   depends on (delete a task, leave a channel, rotate a secret, change a task's
//   status or assignee, replace a profile or a webhook registration). Additive
//   writes are NOT destructive even though they change state: sending a
//   message, adding a reaction, joining a channel, creating a task, claiming an
//   unassigned task. Reversible per-agent attention preferences (mute/unmute)
//   are not destructive either. An approval UX keys off this flag, so it must
//   stay rare: only the routes whose outcome cannot simply be undone by
//   posting again. A `destructive_read` is destructive (it consumes).
// - `audience` records who the Server serves on that route today. `managed`
//   routes answer External Agents with a typed refusal (for example
//   `reminders_unsupported_for_external_agents`); clients can surface that
//   before the request instead of after.

import type { AgentApiRouteKey } from "./agentApiContract";

export const AGENT_API_SIDE_EFFECTS = ["read", "destructive_read", "write"] as const;
export type AgentApiSideEffect = (typeof AGENT_API_SIDE_EFFECTS)[number];

export const AGENT_API_IDEMPOTENCY = ["natural", "key", "none"] as const;
export type AgentApiIdempotency = (typeof AGENT_API_IDEMPOTENCY)[number];

export const AGENT_API_AUDIENCES = ["both", "external", "managed"] as const;
export type AgentApiAudience = (typeof AGENT_API_AUDIENCES)[number];

export interface AgentApiRouteMeta {
  sideEffect: AgentApiSideEffect;
  idempotency: AgentApiIdempotency;
  /** May remove, archive, rotate, transfer, or overwrite existing state (MCP `destructiveHint`). */
  destructive: boolean;
  audience: AgentApiAudience;
}

const read: AgentApiRouteMeta = { sideEffect: "read", idempotency: "natural", destructive: false, audience: "both" };
// Additive writes: repeating or undoing them is another ordinary post.
const naturalWrite: AgentApiRouteMeta = { sideEffect: "write", idempotency: "natural", destructive: false, audience: "both" };
const keyedWrite: AgentApiRouteMeta = { sideEffect: "write", idempotency: "key", destructive: false, audience: "both" };
const write: AgentApiRouteMeta = { sideEffect: "write", idempotency: "none", destructive: false, audience: "both" };
// Destructive writes: remove, archive, rotate, transfer, or overwrite shared state.
const naturalDestructive: AgentApiRouteMeta = { sideEffect: "write", idempotency: "natural", destructive: true, audience: "both" };
const destructive: AgentApiRouteMeta = { sideEffect: "write", idempotency: "none", destructive: true, audience: "both" };
const managedWrite: AgentApiRouteMeta = { sideEffect: "write", idempotency: "none", destructive: false, audience: "managed" };
const managedNaturalDestructive: AgentApiRouteMeta = { sideEffect: "write", idempotency: "natural", destructive: true, audience: "managed" };

export const AGENT_API_ROUTE_META = {
  feedbackLocatorIngest: naturalWrite,
  feedbackLocatorList: read,
  // Default `ack=immediate` consumes the returned rows before the response;
  // `ack=cursor` (External Agents) defers that to the next request.
  events: { sideEffect: "destructive_read", idempotency: "none", destructive: true, audience: "both" },
  historyRead: read,
  knowledgeGet: read,
  knowledgeSearch: read,
  managedMcpTools: read,
  managedMcpCall: destructive,
  messageSend: keyedWrite,
  messageSendV2: keyedWrite,
  messageResolve: read,
  messageSearch: read,
  messageReactionAdd: naturalWrite,
  messageReactionRemove: naturalDestructive,
  channelJoin: naturalWrite,
  channelLeave: naturalDestructive,
  channelMute: naturalWrite,
  channelUnmute: naturalWrite,
  channelArchive: naturalDestructive,
  channelUnarchive: naturalWrite,
  channelMembers: read,
  resolveChannel: read,
  threadUnfollow: naturalDestructive,
  threadList: read,
  inboxList: read,
  agentContext: read,
  serverInfo: read,
  userChannels: read,
  serverUpdate: naturalDestructive,
  mentionActionsPending: read,
  senderMentionDeliveries: read,
  mentionActionsExecute: write,
  taskClaim: write,
  taskList: read,
  taskCreate: keyedWrite,
  taskUnclaim: destructive,
  taskAssign: naturalDestructive,
  taskUpdateStatus: naturalDestructive,
  taskResourceReceipt: write,
  taskDelete: destructive,
  taskConvert: write,
  taskAmend: destructive,
  taskHistory: read,
  reminderList: read,
  reminderCreate: managedWrite,
  reminderCancel: naturalDestructive,
  reminderSnooze: managedNaturalDestructive,
  reminderUpdate: managedNaturalDestructive,
  appSourceAck: naturalWrite,
  reminderLog: read,
  appConfigGet: read,
  appConfigPatch: destructive,
  profileShow: read,
  profileUpdate: naturalDestructive,
  profileAvatarUpdate: naturalDestructive,
  integrationList: read,
  integrationMarketplaceSearch: read,
  integrationToken: write,
  integrationLogin: naturalWrite,
  integrationAppPrepare: write,
  integrationAppRotateSecret: destructive,
  integrationAppTransferOwner: naturalDestructive,
  integrationAppUpdate: naturalDestructive,
  integrationAppManage: destructive,
  integrationAppLogoUpdate: naturalDestructive,
  integrationAppList: read,
  integrationAppStatus: read,
  actionPrepare: keyedWrite,
  attachmentUpload: write,
  attachmentUploadCapabilities: read,
  attachmentUploadSessionCreate: write,
  attachmentUploadSessionComplete: naturalWrite,
  attachmentUploadSessionCancel: naturalDestructive,
  attachmentUploadSessionStatus: read,
  attachmentDownload: read,
  // Minting a presigned URL changes no state; each call mints a fresh URL.
  attachmentDownloadUrl: read,
  attachmentCommentsList: read,
  pushWebhookStatus: { sideEffect: "read", idempotency: "natural", destructive: false, audience: "external" },
  // Registering replaces the existing registration and its secret.
  pushWebhookRegister: { sideEffect: "write", idempotency: "natural", destructive: true, audience: "external" },
  pushWebhookDelete: { sideEffect: "write", idempotency: "natural", destructive: true, audience: "external" },
  mentionsList: read,
} as const satisfies Record<AgentApiRouteKey, AgentApiRouteMeta>;

type AssertNever<T extends never> = T;
type _AgentApiRouteMetaMissingRoutes = AssertNever<Exclude<AgentApiRouteKey, keyof typeof AGENT_API_ROUTE_META>>;
type _AgentApiRouteMetaExtraRoutes = AssertNever<Exclude<keyof typeof AGENT_API_ROUTE_META, AgentApiRouteKey>>;

export function getAgentApiRouteMeta(key: AgentApiRouteKey): AgentApiRouteMeta {
  return AGENT_API_ROUTE_META[key];
}

/** MCP-style tool annotations derived from route metadata. */
export interface AgentApiToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
}

export function toAgentApiToolAnnotations(meta: AgentApiRouteMeta): AgentApiToolAnnotations {
  return {
    readOnlyHint: meta.sideEffect === "read",
    destructiveHint: meta.destructive,
    idempotentHint: meta.idempotency !== "none",
  };
}

/**
 * Transport retry policy a client may apply without changing the outcome.
 * `read` routes may be retried; keyed writes may be retried only when the
 * request carries its idempotency key (the caller decides, hence "keyed");
 * everything else is exactly one attempt.
 */
export type AgentApiRetryPolicy = "retry" | "retry_when_keyed" | "single_attempt";

export function getAgentApiRetryPolicy(meta: AgentApiRouteMeta): AgentApiRetryPolicy {
  if (meta.sideEffect === "read") return "retry";
  if (meta.sideEffect === "write" && meta.idempotency === "key") return "retry_when_keyed";
  if (meta.sideEffect === "write" && meta.idempotency === "natural") return "retry";
  return "single_attempt";
}
