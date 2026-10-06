import { useEffect, useLayoutEffect } from "react";
import { useIntl } from "react-intl";
import {
  AvatarImage,
  LiveAgentActivityBar,
  LiveAgentActivityBarAvatar,
  LiveAgentActivityBarContent,
  LiveAgentActivityBarRow,
  LiveAgentActivityBarText,
  Status,
} from "raft-ui";
import type { StatusProps } from "raft-ui";
import type { AgentActivity } from "@botiverse/raft-shared";
import { LIVE_AGENT_ACTIVITY_VISIBLE_MS } from "../../utils/liveAgentActivity";
import type { LiveAgentActivityItem } from "../../utils/liveAgentActivity";
import { useLiveAgentActivityStore } from "../../store/liveAgentActivityStore";
import { useAppearanceStore } from "../../store/appearanceStore";
import { formatActivityTextDescriptor } from "../../utils/activity";
import { AgentAvatar, isCustomAvatar } from "../agent/PixelAvatar";
import Tooltip from "../ui/Tooltip";

export function useClearLiveAgentActivityOnServerChange(serverId: string | undefined) {
  useLayoutEffect(() => {
    useLiveAgentActivityStore.getState().clear();
  }, [serverId]);
}

/**
 * Activity → RUI Status variant. Preserves the five StatusDot semantics:
 * online = green, thinking/working = busy yellow (static — task #136), error = orange/red,
 * offline = neutral gray. In brutal the status lights keep their FIXED
 * semantic colors (they must not follow the skin — see the --color-status-busy
 * comment in index.css), so warning/danger are re-hued back to the exact
 * production values; elegant takes RUI's semantic variant colors as designed.
 */
const ACTIVITY_STATUS_VARIANT: Record<AgentActivity, NonNullable<StatusProps["variant"]>> = {
  online: "success",
  thinking: "warning",
  working: "warning",
  error: "danger",
  offline: "default",
};

const ACTIVITY_STATUS_BRUTAL_COLOR: Partial<Record<AgentActivity, string>> = {
  thinking: "theme-brutal:[--status-color:var(--color-status-busy)]",
  working: "theme-brutal:[--status-color:var(--color-status-busy)]",
  error: "theme-brutal:[--status-color:var(--color-brutal-orange)]",
};

export default function ConnectedLiveAgentActivityBar() {
  const latest = useLiveAgentActivityStore((state) => state.items[0] ?? null);
  const visible = useAppearanceStore((state) => state.showLiveAgentActivityBar);

  useEffect(() => {
    if (!latest) return;

    const remainingMs = LIVE_AGENT_ACTIVITY_VISIBLE_MS - (Date.now() - latest.createdAt);
    const timeout = window.setTimeout(() => {
      useLiveAgentActivityStore.getState().pruneExpired();
    }, Math.max(0, remainingMs) + 50);

    return () => window.clearTimeout(timeout);
  }, [latest]);

  if (!visible || !latest) return null;

  return <LiveAgentActivityBarPresentation latest={latest} />;
}

export function LiveAgentActivityBarPresentation({
  latest,
}: {
  latest: LiveAgentActivityItem | null;
}) {
  const { formatMessage } = useIntl();
  if (!latest) return null;
  const text = latest.textDescriptor
    ? formatActivityTextDescriptor(formatMessage, latest.textDescriptor)
    : latest.text;
  const activity = latest.activity ?? "offline";

  return (
    // RUI's brutal recipe pads px-4; production's bar is px-3 — keep brutal
    // pixel-identical while the recipe owns everything else.
    <LiveAgentActivityBar beam={false} className="theme-brutal:px-3!">
      <LiveAgentActivityBarRow>
        <LiveAgentActivityBarAvatar className="[&>[data-slot=avatar-fallback]]:hidden">
          {latest.agentAvatarUrl && isCustomAvatar(latest.agentAvatarUrl) ? (
            <AvatarImage src={latest.agentAvatarUrl} alt="" />
          ) : (
            <AgentAvatar avatarUrl={latest.agentAvatarUrl} size={20} className="!h-full !w-full" />
          )}
        </LiveAgentActivityBarAvatar>
        <LiveAgentActivityBarContent>
          <Status
            aria-hidden
            size="md"
            variant={ACTIVITY_STATUS_VARIANT[activity]}
            className={["theme-brutal:border-black", ACTIVITY_STATUS_BRUTAL_COLOR[activity]].filter(Boolean).join(" ")}
            data-activity={activity}
          />
          <Tooltip content={text}>
            <LiveAgentActivityBarText data-slot="live-agent-activity-bar-text">{text}</LiveAgentActivityBarText>
          </Tooltip>
        </LiveAgentActivityBarContent>
      </LiveAgentActivityBarRow>
    </LiveAgentActivityBar>
  );
}
