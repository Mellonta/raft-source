import { useEffect, useMemo } from "react";
import { formatRuntimeLabelWithStatus } from "../../utils/runtimeAvailabilityLabel";
import { useIntl } from "react-intl";
import { isExternalAgentRuntime, REASONING_EFFORT_RUNTIMES, runtimeConfigModelValue } from "@botiverse/raft-shared";
import { useAgentDisplayState, useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { useMachineStore } from "../../store/machineStore";
import { resolveAgentMachineRow } from "../../utils/agentMachineRow";
import { useServerStore } from "../../store/serverStore";
import type { ServerMember } from "../../store/serverStore";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useAuthStore } from "../../store/authStore";
import { canViewAgentPrivateSurfaces } from "../../utils/agentVisibility";
import { formatAgentDisplayStateText } from "../../utils/activity";
import { hydrateRuntimeConfigForm } from "../../utils/runtimeConfigForm";
import { projectRuntimeModelLabelPresentation, useRuntimeModels } from "../../hooks/useRuntimeModels";
import AvatarSlot from "../ui/AvatarSlot";
import StatusDot from "../ui/StatusDot";
import Tooltip from "../ui/Tooltip";
import MentionHoverActivityPreview from "./MentionHoverActivityPreview";

interface ProfilePreviewCardContentProps {
  mentionType: "agent" | "user";
  mentionId: string;
  fallbackAgent?: Agent | null;
  fallbackMember?: ServerMember | null;
  /**
   * Best-effort handle for the mention (e.g. from the mention token) so the
   * card can still render a minimal, non-empty state when the referenced
   * entity is not in the local store and no fallback profile was supplied.
   * Without this, a missing entity used to render `null`, collapsing the
   * hover card into an empty black bar (joint-channel cross-server mentions).
   */
  fallbackLabel?: string;
  /**
   * Opens the agent's activity from the recent-activity heading.
   *
   * Deliberately a prop rather than a `useAppNavigate()` call inside this
   * component: dismissing the hover card is the caller's job (it owns
   * `previewActionsRef`), and every sibling navigation out of this card closes
   * it before navigating. Navigating from in here would leave the card
   * floating over the destination.
   */
  onOpenAgentActivity?: (agentId: string) => void;
}

export default function ProfilePreviewCardContent({ mentionType, mentionId, fallbackAgent, fallbackMember, fallbackLabel, onOpenAgentActivity }: ProfilePreviewCardContentProps) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const { formatClockWithSeconds } = useTimeFormatter();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const { capabilities } = useServerPermissions();
  const agent = useAgentStore((s) => (mentionType === "agent" ? s.agents.find((a) => a.id === mentionId) : undefined));
  const profileAgent = mentionType === "agent" ? agent ?? fallbackAgent : undefined;
  // task #259: same rule as the agent detail panel — no "No computer assigned" while the
  // machine store has no snapshot yet; the Computer line is simply not rendered until then.
  const machines = useMachineStore((s) => s.machines);
  const machineLoadStatus = useMachineStore((s) => s.loadStatus);
  const agentMachineRow = resolveAgentMachineRow(
    mentionType === "agent" ? profileAgent?.machineId : null,
    machines,
    machineLoadStatus,
  );
  const agentMachine = agentMachineRow.kind === "machine" ? agentMachineRow.machine : undefined;
  const trajectoryLog = useAgentStore((s) => (mentionType === "agent" ? s.trajectoryLogs[mentionId] : undefined));
  const ensureAgentProfile = useAgentStore((s) => s.ensureAgentProfile);
  const loadTrajectoryLog = useAgentStore((s) => s.loadTrajectoryLog);
  const displayState = useAgentDisplayState(mentionId, mentionType === "agent" ? profileAgent : undefined);
  const member = useServerStore((s) => (mentionType === "user" ? s.members.find((m) => m.userId === mentionId) : undefined));
  const profileMember = mentionType === "user" ? member ?? fallbackMember : undefined;
  const canViewPrivateAgentSurfaces = mentionType === "agent" && profileAgent
    ? canViewAgentPrivateSurfaces(profileAgent, currentUserId, capabilities.editAgents)
    : false;
  const isChannelSummaryAgent = mentionType === "agent" && profileAgent?.profileProjection === "channel_summary";
  // Only hydrate when the projection actually carried a private `runtimeConfig`.
  // Member/non-admin agent projections and the `agent:created` broadcast strip it
  // legitimately, and hydrating that shape used to build a Built-in config with no
  // provider and throw while deriving trace attributes. Gating on the payload —
  // not on the viewer's permission — is deliberate: an admin can still receive a
  // stripped agent from the broadcast before the full profile loads.
  //
  // With `null` here the card falls through to the public `profileAgent.runtime` /
  // `profileAgent.model` columns below, which is the intended degraded display. We
  // never synthesize a provider just to render, so no writeOnly key is requested.
  const runtimeConfig = useMemo(() => (
    mentionType === "agent" && profileAgent?.runtimeConfig
      ? hydrateRuntimeConfigForm(profileAgent)
      : null
  ), [mentionType, profileAgent]);
  // Passive surface: share one probe across hovers and reuse a recent live
  // catalog instead of making the Computer run the runtime's CLI on every hover.
  const runtimeModels = useRuntimeModels(profileAgent?.machineId, runtimeConfig?.runtime ?? "", { reuseRecentMs: 60_000 });

  useEffect(() => {
    if (!canViewPrivateAgentSurfaces || mentionType !== "agent" || trajectoryLog !== undefined) return;
    void loadTrajectoryLog(mentionId, 5);
  }, [canViewPrivateAgentSurfaces, loadTrajectoryLog, mentionId, mentionType, trajectoryLog]);

  useEffect(() => {
    // A signed-out visitor on a public server page must never reach for a
    // private profile. `/agents/:id` answers 401 for them, the shared response
    // interceptor then finds no refresh token, and "no refresh token" is a hard
    // failure whose verdict is logout — so it clears storage and sends them to
    // "/". The visible symptom was that merely HOVERING an agent avatar or an
    // @agent mention for 200ms bounced a reader off the page to the landing
    // screen (#wg-rbac task #115).
    //
    // Gated here rather than at each call site because the card has two hover
    // entries — MessageItem's avatar and MentionLink — and both mount it
    // unconditionally. Without a profile the card already renders its graceful
    // "unavailable" body, which is what a visitor saw anyway once the request
    // failed.
    if (!currentUserId || mentionType !== "agent" || profileAgent) return;
    void ensureAgentProfile(mentionId);
  }, [currentUserId, ensureAgentProfile, mentionId, mentionType, profileAgent]);

  const unavailableHandle = fallbackLabel ? `@${fallbackLabel.replace(/^@/, "")}` : null;

  return useMemo(() => {
    if (mentionType === "agent") {
      if (!profileAgent) {
        // Missing entity + no fallback profile (e.g. cross-server @mention not
        // in the local store). Render a minimal graceful card instead of
        // `null` so the hover card never collapses into an empty black bar.
        return (
          <div className="flex items-start gap-3 px-3 py-3">
            <AvatarSlot context="mention-card" type="agent" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold text-foreground-strong theme-brutal:text-black">{unavailableHandle ?? formatMessage({ id: "message.profilePreview.fallbackAgent" })}</div>
              <div className="truncate font-mono text-xs text-foreground-muted theme-brutal:text-black/60">{formatMessage({ id: "message.profilePreview.unavailable" })}</div>
            </div>
          </div>
        );
      }
      const displayName = profileAgent.displayName || profileAgent.name;
      const activityText = canViewPrivateAgentSurfaces
        ? displayState
          ? formatAgentDisplayStateText(intl, displayState)
          : undefined
        : displayState
          ? formatAgentDisplayStateText(intl, displayState, { withDetail: false })
          : formatMessage({ id: "activity.status.offline" });
      const renderedActivityText = activityText || formatMessage({ id: "activity.status.offline" });
      const runtimeId = runtimeConfig?.runtime ?? profileAgent.runtime ?? "unknown";
      const modelId = runtimeConfig ? runtimeConfigModelValue(runtimeConfig) : profileAgent.model || "default";
      const runtimeLabel = formatRuntimeLabelWithStatus(runtimeId, formatMessage);
      const modelPresentation = projectRuntimeModelLabelPresentation(runtimeId, modelId, runtimeModels, profileAgent.machineId);
      const modelLabel = modelPresentation.kind === "pending"
        ? formatMessage({ id: "common.loading" })
        : modelPresentation.label;
      const reasoningLabel = REASONING_EFFORT_RUNTIMES.has(runtimeId)
        ? runtimeConfig?.reasoningEffort || formatMessage({ id: "message.profilePreview.reasoningDefault" })
        : null;
      const isExternalAgent = profileAgent.external === true || isExternalAgentRuntime(runtimeId);
      const computerLabel = isExternalAgent
        ? formatMessage({ id: "message.profilePreview.externalRuntime" })
        : agentMachineRow.kind === "pending"
          ? null
          : agentMachine
            ? agentMachine.name
            : formatMessage({ id: "message.profilePreview.noComputerAssigned" });
      return (
        <>
          <div className="flex items-start gap-3 px-3 py-3">
            <AvatarSlot context="mention-card" type="agent" agentAvatarUrl={profileAgent.avatarUrl} className="mt-0.5 self-start" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-bold text-foreground-strong theme-brutal:text-black">{displayName}</span>
                <StatusDot activity={displayState?.activity ?? "offline"} external={displayState?.isExternal && !displayState.isOnline} size="sm" />
                <span className="truncate font-mono text-xs text-foreground-muted theme-brutal:text-black/60">
                  {renderedActivityText}
                </span>
              </div>
              <div className="truncate font-mono text-xs text-foreground-muted theme-brutal:text-black/60">@{profileAgent.name}</div>
              {!isChannelSummaryAgent ? <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 border-t border-line-muted theme-brutal:border-black/20 pt-2 text-[11px] leading-tight">
                {computerLabel !== null ? (
                  <>
                    <dt className="font-mono text-foreground-placeholder theme-brutal:text-black/45">{formatMessage({ id: "message.profilePreview.labelComputer" })}</dt>
                    <Tooltip content={computerLabel}><dd className="min-w-0 truncate font-mono text-foreground-muted theme-brutal:text-black/70">{computerLabel}</dd></Tooltip>
                  </>
                ) : null}
                <dt className="font-mono text-foreground-placeholder theme-brutal:text-black/45">{formatMessage({ id: "message.profilePreview.labelRuntime" })}</dt>
                <Tooltip content={runtimeLabel}><dd className="min-w-0 truncate font-mono text-foreground-muted theme-brutal:text-black/70">{runtimeLabel}</dd></Tooltip>
                <dt className="font-mono text-foreground-placeholder theme-brutal:text-black/45">{formatMessage({ id: "message.profilePreview.labelModel" })}</dt>
                <Tooltip content={modelLabel}><dd className="min-w-0 truncate font-mono text-foreground-muted theme-brutal:text-black/70">{modelLabel}</dd></Tooltip>
                {reasoningLabel ? (
                  <>
                    <dt className="font-mono text-foreground-placeholder theme-brutal:text-black/45">{formatMessage({ id: "message.profilePreview.labelReasoning" })}</dt>
                    <Tooltip content={reasoningLabel}><dd className="min-w-0 truncate font-mono capitalize text-foreground-muted theme-brutal:text-black/70">{reasoningLabel}</dd></Tooltip>
                  </>
                ) : null}
              </dl> : null}
            </div>
          </div>
          {profileAgent.description ? (
            <Tooltip content={profileAgent.description}>
            <div className="truncate border-t-2 border-line-muted theme-brutal:border-black px-3 py-2 text-xs text-foreground-muted theme-brutal:text-black/70">
              {profileAgent.description}
            </div>
            </Tooltip>
          ) : null}
          {canViewPrivateAgentSurfaces ? (
            <MentionHoverActivityPreview
              entries={trajectoryLog ?? []}
              formatTimestamp={formatClockWithSeconds}
              onOpenActivity={
                onOpenAgentActivity && profileAgent
                  ? () => onOpenAgentActivity(profileAgent.id)
                  : undefined
              }
            />
          ) : null}
        </>
      );
    }

    if (!profileMember) {
      // Missing entity + no fallback profile (cross-server human @mention not
      // in the local store). Minimal graceful card, never a null/black-bar.
      return (
        <div className="flex items-start gap-3 px-3 py-3">
          <AvatarSlot context="mention-card" type="human" humanPlaceholder />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-bold text-foreground-strong theme-brutal:text-black">{unavailableHandle ?? formatMessage({ id: "message.profilePreview.fallbackMember" })}</div>
            <div className="truncate font-mono text-xs text-foreground-muted theme-brutal:text-black/60">{formatMessage({ id: "message.profilePreview.unavailable" })}</div>
          </div>
        </div>
      );
    }
    const displayName = profileMember.displayName || profileMember.name;
    return (
      <>
        <div className="flex items-start gap-3 px-3 py-3">
          <AvatarSlot context="mention-card" type="human" humanAvatarUrl={profileMember.avatarUrl} gravatarHash={profileMember.gravatarHash} className="mt-0.5 self-start" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-bold text-foreground-strong theme-brutal:text-black">{displayName}</div>
            <div className="truncate font-mono text-xs text-foreground-muted theme-brutal:text-black/60">@{profileMember.name}</div>
          </div>
        </div>
        {profileMember.description ? (
          <Tooltip content={profileMember.description}>
          <div className="truncate border-t-2 border-line-muted theme-brutal:border-black px-3 py-2 text-xs text-foreground-muted theme-brutal:text-black/70">
            {profileMember.description}
          </div>
          </Tooltip>
        ) : null}
      </>
    );
  }, [mentionType, profileAgent, agentMachine, agentMachineRow.kind, runtimeConfig, runtimeModels, canViewPrivateAgentSurfaces, isChannelSummaryAgent, displayState, trajectoryLog, formatClockWithSeconds, profileMember, unavailableHandle, formatMessage, intl, onOpenAgentActivity]);
}
