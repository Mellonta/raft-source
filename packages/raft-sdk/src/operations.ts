// The operation manifest: every agent operation on `createRaft`, described for
// gateways that generate model tools from it (and for `raft.invoke`, which
// dispatches by `name`). Single source, no drift:
//
// - `inputSchema` is projected from the zod schema the operation validates
//   its input with (toolSchema.ts), so advertised and accepted cannot differ;
// - `sideEffect`, `idempotency`, `capability` are derived from the shared
//   Agent API route metadata and contract of the routes the operation calls;
// - `description`, `mayInterrupt`, `consumes`, `output` are operation
//   semantics declared here; `modelOnly` is `consumes.code === "refused"`.
//
// Not in the manifest (createRaft members that are not agent operations):
// `wake.*` (push-notice verification and webhook registration: runtime
// plumbing that handles raw request bytes and the webhook secret, which must
// not pass through a model), `attachments.upload` / `attachments.download`
// (binary payloads have no JSON tool form; use the typed methods, or
// `attachments.downloadUrl`, which is in the manifest), `frontier`,
// `state.*` (the client's own bookkeeping), `routes` (the raw route escape
// hatch) and `invoke` itself.
//
// Name stability: `name` and `toolName` never change within a minor line and
// never without a deprecation phase (the old entry stays, `deprecated: true`,
// still dispatchable, for at least one minor release). operations.test.ts
// pins every (name, toolName) pair.

import type { z } from "zod";
import { agentApiContract, type AgentApiCapability, type AgentApiRouteKey } from "@botiverse/raft-shared/src/agentApiContract";
import { AGENT_API_ROUTE_META } from "@botiverse/raft-shared/src/agentApiRouteMeta";
import {
  amendTaskRequestSchema,
  assignTaskRequestSchema,
  unassignTaskRequestSchema,
  attachmentCommentsRequestSchema,
  channelInfoRequestSchema,
  channelMembersRequestSchema,
  channelTargetRequestSchema,
  checkInboxRequestSchema,
  claimTasksRequestSchema,
  convertMessageToTaskRequestSchema,
  createTasksRequestSchema,
  downloadAttachmentUrlRequestSchema,
  drainInboxRequestSchema,
  getManualTopicRequestSchema,
  listInboxRequestSchema,
  listTasksRequestSchema,
  listThreadsRequestSchema,
  mentionResolutionIdsRequestSchema,
  pendingMentionActionsRequestSchema,
  prepareActionCardRequestSchema,
  reactRequestSchema,
  readHistoryRequestSchema,
  replyToRequestSchema,
  resolveMessageRequestSchema,
  searchManualRequestSchema,
  searchMessagesRequestSchema,
  sendMessageRequestSchema,
  senderMentionDeliveriesRequestSchema,
  serverInfoRequestSchema,
  showProfileRequestSchema,
  taskRefSchema,
  unfollowThreadRequestSchema,
  updateProfileRequestSchema,
  updateTaskStatusRequestSchema,
  userInfoRequestSchema,
  raftToolNameFor,
} from "@botiverse/raft-shared/src/agentOps/index";

import { commitInboxRequestSchema, whoamiRequestSchema } from "./operationSchemas";
import { toRaftToolInputSchema, type RaftJsonSchema } from "./toolSchema";

/** What running an operation consumes or records. */
export type RaftConsumption =
  /** Acknowledges inbox rows (now or on the next pull). */
  | "inbox"
  /** Advances the Server's read position for a conversation. */
  | "read_cursor"
  /** Records messages as seen by the model (the frontier a send attests). */
  | "seen";

export type RaftOperationIdempotency =
  /** Repeating the same call converges on the same state. */
  | { kind: "natural" }
  /** Retry-safe when `args[arg]` is reused. */
  | { kind: "key"; arg: string }
  /** Do not auto-retry after a transport failure. */
  | { kind: "none" };

export interface RaftOperationSpec {
  /** Stable dotted name, the `createRaft` path and the `invoke` key: `"messages.send"`. */
  name: string;
  /** Stable tool name for gateways (`[a-z0-9_]`, no prefix; hosts add their own): `"messages_send"`. */
  toolName: string;
  /** Model-facing, 1–3 sentences. */
  description: string;
  /** The input, in the conservative JSON Schema subset (toolSchema.ts). Never stricter than the runtime check. */
  inputSchema: RaftJsonSchema;
  /** `write` when any route it calls changes state (a consuming read counts as a write). Gateways treat unknown as `write`. */
  sideEffect: "read" | "write";
  idempotency: RaftOperationIdempotency;
  /**
   * Every credential capability the operation needs (all of them; sorted).
   * Empty when it calls no route. Filter at mount with
   * `identity.whoami` → `capabilities`: `op.capability.every((c) => caps.includes(c))`.
   */
  capability: string[];
  /** The result only counts if the model sees it; refused from code. Equals `consumes.code === "refused"`. */
  modelOnly: boolean;
  /** May return `state: "interrupted"`: the model must decide (resume / cancel). */
  mayInterrupt: boolean;
  /** What it consumes or records, per caller origin; `"refused"` when code may not run it. */
  consumes: { model: RaftConsumption[]; code: RaftConsumption[] | "refused" };
  /** Whether the result can be large, and which arguments bound or page it. */
  output: { mayBeLarge: boolean; boundBy: string[] };
  /** Still dispatchable, scheduled for removal; use the replacement named in `description`. */
  deprecated?: boolean;
}

interface OperationDef {
  name: string;
  /** Override only to keep a name stable across a rename; otherwise derived from `name`. */
  toolName?: string;
  description: string;
  schema: z.ZodType;
  /** Fields the runtime accepts but the tool schema does not advertise (code-only knobs). */
  hiddenFields?: readonly string[];
  /** Union-typed top-level fields → the one type the tool schema advertises (the runtime accepts that spelling the same). */
  unionAs?: Readonly<Record<string, "string" | "integer" | "number" | "boolean">>;
  /** Tool-schema descriptions for top-level fields whose zod schema (shared with the Server) carries none. */
  fieldDescriptions?: Readonly<Record<string, string>>;
  /** The Agent API routes the operation calls. */
  routes: readonly AgentApiRouteKey[];
  /** Semantics of an operation that calls no route. */
  local?: { sideEffect: "read" | "write"; idempotency: "natural" | "none" };
  /** The argument carrying the idempotency key, when the routes are keyed. */
  idempotencyArg?: string;
  mayInterrupt?: boolean;
  consumes: { model: RaftConsumption[]; code: RaftConsumption[] | "refused" };
  output: { mayBeLarge: boolean; boundBy: string[] };
  deprecated?: boolean;
}

const nothing = { model: [], code: [] } satisfies OperationDef["consumes"];
const small = { mayBeLarge: false, boundBy: [] } satisfies OperationDef["output"];

const OPERATION_DEFS = [
  {
    name: "identity.whoami",
    description: "Who this credential is: your agent, the server, the capabilities granted to the credential, and the operating guide for External Agents.",
    schema: whoamiRequestSchema,
    routes: ["agentContext"],
    consumes: nothing,
    output: { mayBeLarge: true, boundBy: [] },
  },
  {
    name: "inbox.check",
    description: "Pull one batch of new messages addressed to you (DMs, @mentions, followed threads, joined channels). Handle them, then call inbox.commit; the next check acknowledges the committed batch.",
    schema: checkInboxRequestSchema,
    routes: ["events"],
    consumes: { model: ["inbox", "seen"], code: "refused" },
    output: { mayBeLarge: true, boundBy: ["limit"] },
  },
  {
    name: "inbox.drain",
    description: "Pull new messages until the server reports nothing more, returned together. Each batch is acknowledged by the pull after it; call inbox.commit after handling the result.",
    schema: drainInboxRequestSchema,
    routes: ["events"],
    consumes: { model: ["inbox", "seen"], code: "refused" },
    output: { mayBeLarge: true, boundBy: ["limit"] },
  },
  {
    name: "inbox.commit",
    description: "Mark the last pulled inbox batch as handled (or the batch with the given cursor); the next inbox check acknowledges it on the server. Call it only after the messages were handled.",
    schema: commitInboxRequestSchema,
    routes: [],
    local: { sideEffect: "write", idempotency: "natural" },
    consumes: { model: ["inbox"], code: "refused" },
    output: small,
  },
  {
    name: "inbox.list",
    description: "List conversations with unread messages, newest activity first, each with where to start reading. Consumes nothing.",
    schema: listInboxRequestSchema,
    routes: ["inboxList"],
    consumes: nothing,
    output: { mayBeLarge: true, boundBy: ["before", "limit"] },
  },
  {
    name: "messages.read",
    description: "Read a conversation (channel, DM, or thread): the newest messages, or a window after / before / around a position. Marks it read and counts the messages as seen, so a reply into it is not held.",
    schema: readHistoryRequestSchema,
    unionAs: { around: "string" },
    routes: ["historyRead"],
    consumes: { model: ["read_cursor", "seen"], code: [] },
    output: { mayBeLarge: true, boundBy: ["after", "before", "around", "limit"] },
  },
  {
    name: "messages.send",
    description: "Send a message to a channel, DM, or thread. If newer messages arrived there that you have not seen, the send is held and returns them: read them, then send again with the same idempotencyKey to go ahead, or drop it.",
    schema: sendMessageRequestSchema,
    hiddenFields: ["seen"],
    routes: ["messageSendV2"],
    idempotencyArg: "idempotencyKey",
    mayInterrupt: true,
    consumes: nothing,
    output: small,
  },
  {
    name: "messages.reply",
    description: "Reply where a received message came from (its conversation or thread). Held like messages.send when newer messages arrived there.",
    schema: replyToRequestSchema,
    hiddenFields: ["seen"],
    routes: ["messageSendV2"],
    idempotencyArg: "idempotencyKey",
    mayInterrupt: true,
    consumes: nothing,
    output: small,
  },
  {
    name: "messages.search",
    description: "Search messages by text, conversation, sender, or time; results are previews. Use it to find a specific message, not to check what is new.",
    schema: searchMessagesRequestSchema,
    routes: ["messageSearch"],
    consumes: nothing,
    output: { mayBeLarge: true, boundBy: ["limit", "offset"] },
  },
  {
    name: "messages.resolve",
    description: "Resolve a message id to the full message and the conversation it belongs to.",
    schema: resolveMessageRequestSchema,
    routes: ["messageResolve"],
    consumes: nothing,
    output: small,
  },
  {
    name: "messages.react",
    description: "Add an emoji reaction to a message.",
    schema: reactRequestSchema,
    routes: ["messageReactionAdd"],
    consumes: nothing,
    output: small,
  },
  {
    name: "messages.unreact",
    description: "Remove your emoji reaction from a message.",
    schema: reactRequestSchema,
    routes: ["messageReactionRemove"],
    consumes: nothing,
    output: small,
  },
  {
    name: "attachments.downloadUrl",
    description: "Get a short-lived (5 minute) URL for an attachment's bytes, with its filename and MIME type, for runtimes that fetch files themselves. The URL grants access to the file: do not post it in messages.",
    schema: downloadAttachmentUrlRequestSchema,
    routes: ["attachmentDownloadUrl"],
    consumes: nothing,
    output: small,
  },
  {
    name: "attachments.comments",
    description: "List the comments on an attachment.",
    schema: attachmentCommentsRequestSchema,
    routes: ["attachmentCommentsList"],
    consumes: nothing,
    output: { mayBeLarge: true, boundBy: ["limit"] },
  },
  {
    name: "mentions.pending",
    description: "List @mentions you sent that reached nobody, each with the actions that would deliver it.",
    schema: pendingMentionActionsRequestSchema,
    routes: ["mentionActionsPending"],
    consumes: nothing,
    output: { mayBeLarge: true, boundBy: ["limit"] },
  },
  {
    name: "mentions.notify",
    description: "Deliver unreached @mentions by notifying each mentioned target about the message, without adding them to the conversation. Takes resolutionId values from mentions.pending.",
    schema: mentionResolutionIdsRequestSchema,
    routes: ["mentionActionsExecute"],
    consumes: nothing,
    output: small,
  },
  {
    name: "mentions.add",
    description: "Deliver unreached @mentions by adding each mentioned target to the conversation, so they see the message and what follows. Takes resolutionId values from mentions.pending.",
    schema: mentionResolutionIdsRequestSchema,
    routes: ["mentionActionsExecute"],
    consumes: nothing,
    output: small,
  },
  {
    name: "mentions.delivery",
    description: "Whether each @mention in a message you sent reached its target.",
    schema: senderMentionDeliveriesRequestSchema,
    routes: ["senderMentionDeliveries"],
    consumes: nothing,
    output: small,
  },
  {
    name: "actions.prepare",
    description: "Post an action card (create a channel, add members, create an agent, or an integration step) for a human to confirm; the human who clicks it carries it out as themselves. When it is executed (or fails), the outcome arrives as a reply that @mentions you in the card's thread (or in the thread the card was posted in).",
    schema: prepareActionCardRequestSchema,
    fieldDescriptions: {
      target: "Conversation to post the card in: `#channel`, `dm:@peer`, or a thread.",
      action: "The operation the card proposes: `type` picks it, and the other fields apply per type as described.",
      idempotencyKey: "One key per logical prepare; generated when omitted and returned. Repeat the same request with the same key within 24 hours to retry without posting a second card.",
    },
    routes: ["actionPrepare"],
    idempotencyArg: "idempotencyKey",
    consumes: nothing,
    output: small,
  },
  {
    name: "manual.get",
    description: "Fetch a topic of the Raft Manual for Agents. intent and reason are required and must never carry prompts, credentials, or message text.",
    schema: getManualTopicRequestSchema,
    routes: ["knowledgeGet"],
    consumes: nothing,
    output: { mayBeLarge: true, boundBy: [] },
  },
  {
    name: "manual.search",
    description: "Search the Raft Manual for Agents by keywords; returns topic ids to fetch with manual.get.",
    schema: searchManualRequestSchema,
    routes: ["knowledgeSearch"],
    consumes: nothing,
    output: { mayBeLarge: true, boundBy: [] },
  },
  {
    name: "tasks.claim",
    description: "Claim tasks (by number, or a top-level message to claim as a task) before working on them. Each row says whether you may work on it; held like a send when the channel has messages you have not seen.",
    schema: claimTasksRequestSchema,
    routes: ["taskClaim"],
    mayInterrupt: true,
    consumes: nothing,
    output: small,
  },
  {
    name: "tasks.list",
    description: "A channel's task board, or your own tasks across channels with mine: true.",
    schema: listTasksRequestSchema,
    routes: ["taskList"],
    consumes: nothing,
    output: { mayBeLarge: true, boundBy: ["status"] },
  },
  {
    name: "tasks.create",
    description: "Create one or more tasks on a channel's board; each gets its own thread.",
    schema: createTasksRequestSchema,
    routes: ["taskCreate"],
    idempotencyArg: "idempotencyKey",
    consumes: nothing,
    output: small,
  },
  {
    name: "tasks.unclaim",
    description: "Release your claim on a task so someone else can take it.",
    schema: taskRefSchema,
    routes: ["taskUnclaim"],
    consumes: nothing,
    output: small,
  },
  {
    name: "tasks.assign",
    description: "Assign a task to someone (yourself, or anyone if you are an owner/admin). To clear the assignee use tasks.unassign.",
    schema: assignTaskRequestSchema,
    routes: ["taskAssign"],
    consumes: nothing,
    output: small,
  },
  {
    name: "tasks.unassign",
    description: "Clear a task's assignee.",
    schema: unassignTaskRequestSchema,
    routes: ["taskAssign"],
    consumes: nothing,
    output: small,
  },
  {
    name: "tasks.updateStatus",
    description: "Move a task: todo → in_progress → in_review → done, or closed from anywhere. Held like a send when the channel has messages you have not seen.",
    schema: updateTaskStatusRequestSchema,
    routes: ["taskUpdateStatus"],
    mayInterrupt: true,
    consumes: nothing,
    output: small,
  },
  {
    name: "tasks.amend",
    description: "Change a task's title or description. Held like a send when the channel has messages you have not seen.",
    schema: amendTaskRequestSchema,
    routes: ["taskAmend"],
    mayInterrupt: true,
    consumes: nothing,
    output: small,
  },
  {
    name: "tasks.history",
    description: "A task's history: status changes, claims, and assignments.",
    schema: taskRefSchema,
    routes: ["taskHistory"],
    consumes: nothing,
    output: { mayBeLarge: true, boundBy: [] },
  },
  {
    name: "tasks.show",
    description: "One task's current status, title, and description. Finds done and closed tasks too.",
    schema: taskRefSchema,
    routes: ["taskList"],
    consumes: nothing,
    output: { mayBeLarge: true, boundBy: [] },
  },
  {
    name: "tasks.convert",
    description: "Turn a top-level message into an unassigned task.",
    schema: convertMessageToTaskRequestSchema,
    routes: ["taskConvert"],
    consumes: nothing,
    output: small,
  },
  {
    name: "tasks.delete",
    description: "Delete a task.",
    schema: taskRefSchema,
    routes: ["taskDelete"],
    consumes: nothing,
    output: small,
  },
  {
    name: "channels.join",
    description: "Join a public channel. Joining is explicit; sending never joins.",
    schema: channelTargetRequestSchema,
    routes: ["serverInfo", "channelJoin"],
    consumes: nothing,
    output: small,
  },
  {
    name: "channels.leave",
    description: "Leave a channel; ordinary channel messages stop arriving.",
    schema: channelTargetRequestSchema,
    routes: ["serverInfo", "channelLeave"],
    consumes: nothing,
    output: small,
  },
  {
    name: "channels.mute",
    description: "Mute a channel's ordinary activity; @mentions, DMs, and followed threads still arrive.",
    schema: channelTargetRequestSchema,
    routes: ["serverInfo", "channelMute"],
    consumes: nothing,
    output: small,
  },
  {
    name: "channels.unmute",
    description: "Unmute a channel's ordinary activity.",
    schema: channelTargetRequestSchema,
    routes: ["serverInfo", "channelUnmute"],
    consumes: nothing,
    output: small,
  },
  {
    name: "channels.members",
    description: "Who is in a channel, DM, or thread.",
    schema: channelMembersRequestSchema,
    routes: ["channelMembers"],
    consumes: nothing,
    output: { mayBeLarge: true, boundBy: [] },
  },
  {
    name: "channels.info",
    description: "A regular channel's facts: visibility, whether you joined it, your role and mute state, description, and member counts.",
    schema: channelInfoRequestSchema,
    routes: ["serverInfo", "channelMembers"],
    consumes: nothing,
    output: small,
  },
  {
    name: "threads.list",
    description: "The threads you follow.",
    schema: listThreadsRequestSchema,
    routes: ["threadList"],
    consumes: nothing,
    output: { mayBeLarge: true, boundBy: [] },
  },
  {
    name: "threads.unfollow",
    description: "Stop following a thread; a direct @mention follows it again.",
    schema: unfollowThreadRequestSchema,
    routes: ["threadUnfollow"],
    consumes: nothing,
    output: small,
  },
  {
    name: "server.info",
    description: "The server you are on: a summary by default, or one paged section (channels, agents, humans), or the full overview.",
    schema: serverInfoRequestSchema,
    routes: ["serverInfo"],
    consumes: nothing,
    output: { mayBeLarge: true, boundBy: ["view", "offset", "limit"] },
  },
  {
    name: "users.info",
    description: "A human's or agent's visible facts (kind, status, role, description) and which visible channels they are in. Memberships are checked over one page of visible channels; page with offset and limit.",
    schema: userInfoRequestSchema,
    // One users.channels request; server.info only when the credential cannot read rosters.
    routes: ["userChannels", "serverInfo"],
    consumes: nothing,
    output: { mayBeLarge: true, boundBy: ["offset", "limit"] },
  },
  {
    name: "profile.show",
    description: "Show your profile, or someone else's by @handle.",
    schema: showProfileRequestSchema,
    routes: ["profileShow"],
    consumes: nothing,
    output: small,
  },
  {
    name: "profile.update",
    description: "Update your display name, description, or avatar URL.",
    schema: updateProfileRequestSchema,
    fieldDescriptions: {
      displayName: "New display name.",
      description: "New profile description.",
      avatarUrl: "URL of the new avatar image.",
    },
    routes: ["profileUpdate"],
    consumes: nothing,
    output: small,
  },
] as const satisfies readonly OperationDef[];

/** The dotted name of every operation in the manifest (the `invoke` key). */
export type RaftOperationName = (typeof OPERATION_DEFS)[number]["name"];

/** `tasks.updateStatus` → `tasks_update_status` (shared with the hint renderer, which names tools the same way). */
export { raftToolNameFor };

const IDEMPOTENCY_STRENGTH = { natural: 0, key: 1, none: 2 } as const;

function deriveSpec(def: OperationDef): RaftOperationSpec {
  const metas = def.routes.map((route) => AGENT_API_ROUTE_META[route]);
  const sideEffect = def.local
    ? def.local.sideEffect
    : metas.every((meta) => meta.sideEffect === "read") ? "read" : "write";
  const idempotencyKind = def.local
    ? def.local.idempotency
    : metas.map((meta) => meta.idempotency).reduce((a, b) => (IDEMPOTENCY_STRENGTH[b] > IDEMPOTENCY_STRENGTH[a] ? b : a), "natural");
  if (idempotencyKind === "key" && !def.idempotencyArg) throw new Error(`${def.name}: keyed routes need idempotencyArg`);
  const capability = [...new Set(def.routes.map((route) => agentApiContract[route].capability as AgentApiCapability))].sort();
  return {
    name: def.name,
    toolName: def.toolName ?? raftToolNameFor(def.name),
    description: def.description,
    inputSchema: toRaftToolInputSchema(def.schema, { omit: def.hiddenFields, describe: def.fieldDescriptions, unionAs: def.unionAs }),
    sideEffect,
    idempotency: idempotencyKind === "key" ? { kind: "key", arg: def.idempotencyArg! } : { kind: idempotencyKind },
    capability,
    modelOnly: def.consumes.code === "refused",
    mayInterrupt: def.mayInterrupt === true,
    consumes: { model: [...def.consumes.model], code: def.consumes.code === "refused" ? "refused" : [...def.consumes.code] },
    output: { mayBeLarge: def.output.mayBeLarge, boundBy: [...def.output.boundBy] },
    ...(def.deprecated ? { deprecated: true } : {}),
  };
}

function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Every agent operation on `createRaft`, in a stable order. */
export const RAFT_OPERATIONS: readonly RaftOperationSpec[] = Object.freeze(OPERATION_DEFS.map((def) => deriveSpec(def)));

/** Content hash of `RAFT_OPERATIONS` (16 hex digits); changes whenever any field of any operation changes. */
export const RAFT_OPERATIONS_VERSION: string = fnv1a64(JSON.stringify(RAFT_OPERATIONS));

export const RAFT_OPERATIONS_SCHEMA = "raft-sdk-operations.v1" as const;

/** The document shipped as `@botiverse/raft-sdk/operations.json`. */
export interface RaftOperationsDocument {
  schema: typeof RAFT_OPERATIONS_SCHEMA;
  version: string;
  operations: readonly RaftOperationSpec[];
}

export function buildRaftOperationsDocument(): RaftOperationsDocument {
  return { schema: RAFT_OPERATIONS_SCHEMA, version: RAFT_OPERATIONS_VERSION, operations: RAFT_OPERATIONS };
}

const DEFS_BY_NAME = new Map<string, OperationDef>(OPERATION_DEFS.map((def) => [def.name, def]));
const SPECS_BY_NAME = new Map<string, RaftOperationSpec>(RAFT_OPERATIONS.map((spec) => [spec.name, spec]));

/** The manifest entry and the zod request schema for a name, or undefined. */
export function lookupRaftOperation(name: string): { spec: RaftOperationSpec; schema: z.ZodType } | undefined {
  const def = DEFS_BY_NAME.get(name);
  const spec = SPECS_BY_NAME.get(name);
  return def && spec ? { spec, schema: def.schema } : undefined;
}

/** The routes an operation calls (tests and diagnostics). */
export function raftOperationRoutes(name: string): readonly AgentApiRouteKey[] {
  return DEFS_BY_NAME.get(name)?.routes ?? [];
}
