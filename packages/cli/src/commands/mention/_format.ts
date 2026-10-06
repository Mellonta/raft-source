import { axSurface } from "../../core/renderer";
import {
  AGENT_MENTION_PENDING_MAX_LIMIT,
  formatAgentMentionActionResults,
  formatAgentMentionNotifyRecoveryCommand,
  formatAgentPendingMentionActions,
  formatAgentSenderMentionDeliveries,
  normalizeAgentMentionActionResults,
  normalizeAgentPendingMentionActions,
  normalizeAgentUnresolvedMentionHandles,
  toAgentSenderPendingMentionAction,
  toAgentSenderUnresolvedMentionWarning,
  type AgentMentionActionKind,
  type AgentMentionActionResult,
  type AgentMentionActionResultStatus,
  type AgentPendingMentionAction,
  type AgentSenderMentionDeliveryRow,
  type AgentSenderPendingMentionAction,
  type AgentSenderUnresolvedMentionWarning,
} from "@botiverse/raft-shared";

// The text and the normalisers live in `@botiverse/raft-shared`
// (`agentText/mentions.ts`) so the SDK renders the same bytes; this file keeps
// the axSurface registrations and their examples.

export type MentionActionKind = AgentMentionActionKind;
export type PendingMentionAction = AgentPendingMentionAction;
export type SenderPendingMentionAction = AgentSenderPendingMentionAction;
export type SenderUnresolvedMentionWarning = AgentSenderUnresolvedMentionWarning;
export type MentionActionResultStatus = AgentMentionActionResultStatus;
export type MentionActionResult = AgentMentionActionResult;
export type SenderMentionDeliveryRow = AgentSenderMentionDeliveryRow;
export const MENTION_PENDING_MAX_LIMIT = AGENT_MENTION_PENDING_MAX_LIMIT;
export const toSenderPendingMentionAction = toAgentSenderPendingMentionAction;
export const toSenderUnresolvedMentionWarning = toAgentSenderUnresolvedMentionWarning;
export const normalizePendingMentionActions = normalizeAgentPendingMentionActions;
export const normalizeUnresolvedMentionHandles = normalizeAgentUnresolvedMentionHandles;
export const normalizeMentionActionResults = normalizeAgentMentionActionResults;

export const formatMentionNotifyRecoveryCommand = axSurface(
  "Per-token mention recovery command line.",
  (resolutionId: string): string | null => formatAgentMentionNotifyRecoveryCommand(resolutionId),
  {
    examples: [{ args: ["00000000-1111-2222-3333-444444444444"] }],
  },
);

export const formatPendingMentionActions = axSurface(
  "Undelivered-mentions partial result / pending list.",
  (
    actions: PendingMentionAction[],
    opts: { source?: "send" | "pending"; unresolvedMentionHandles?: string[]; hasMore?: boolean; limit?: number } = {},
  ): string => formatAgentPendingMentionActions(actions, opts),
  {
    examples: [{ title: "send partial result", args: [[{ resolutionId: "00000000-1111-2222-3333-444444444444", messageId: "55555555-6666-7777-8888-999999999999", targetType: "agent", targetHandle: "@bob", reason: "not_in_conversation", availableActions: ["notify", "add"], expiresAt: "2026-09-01T08:00:00.000Z" }], { source: "send", unresolvedMentionHandles: ["@type-o-handle"] }] }],
  },
);

export const formatMentionActionResults = axSurface(
  "notify/add action outcome rows.",
  (action: MentionActionKind, results: MentionActionResult[]): string => formatAgentMentionActionResults(action, results),
  {
    examples: [{ args: ["notify", [{ resolutionId: "00000000-1111-2222-3333-444444444444", status: "queued", action: "notify", targetHandle: "@bob" }]] }],
  },
);

export const formatSenderMentionDeliveries = axSurface(
  "Per-target mention delivery outcome for a message the bound agent sent.",
  (messageId: string, deliveries: SenderMentionDeliveryRow[]): string => formatAgentSenderMentionDeliveries(messageId, deliveries),
  {
    examples: [{
      title: "one target lost to quota, one still in flight",
      args: [
        "55555555-6666-7777-8888-999999999999",
        [
          { targetHandle: "@bob", outcome: "lost", reasonCategory: "quota" },
          { targetHandle: "@carol", outcome: "pending" },
        ],
      ],
    }],
  },
);
