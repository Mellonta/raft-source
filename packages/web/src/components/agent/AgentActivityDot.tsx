import { useEffect } from "react";
import { useIntl } from "react-intl";
import { useAgentActivityTraceJoin, useAgentDisplayState } from "../../store/agentStore";
import type { AgentActivity } from "@botiverse/raft-shared";
import StatusDot from "../ui/StatusDot";
import type { StatusDotProps } from "../ui/StatusDot";
import { traceAgentActivityStatusDotApplied } from "../../utils/webAgentActivityTrace";
import { formatAgentDisplayStateText } from "../../utils/activity";

/**
 * Isolated component that subscribes to a single agent's activity and renders
 * a colored `<StatusDot />`. This is the zustand-bound flavor — for static
 * activity values, use `<StatusDot activity={...} />` directly.
 *
 * Pass `size` / `className` through for non-avatar status labels. Avatar
 * activity belongs in raft-ui's `<AvatarBadge>`; AvatarBadge
 * owns its corner geometry and responsive scale.
 */
export default function AgentActivityDot({
  agentId,
  fallbackActivity = "offline",
  size,
  className,
  ...rest
}: { agentId: string; fallbackActivity?: AgentActivity } & Omit<StatusDotProps, "activity" | "tone">) {
  const intl = useIntl();
  const fallbackStatus = fallbackActivity === "offline" ? "stopped" : "active";
  const displayState = useAgentDisplayState(agentId, { status: fallbackStatus });
  const traceJoin = useAgentActivityTraceJoin(agentId);
  const title = rest.title ?? formatAgentDisplayStateText(intl, displayState);
  useEffect(() => {
    traceAgentActivityStatusDotApplied({
      agentId,
      activity: displayState.activity,
      isOnline: displayState.isOnline,
      isExternal: displayState.isExternal,
      join: traceJoin,
    });
  }, [agentId, displayState.activity, displayState.isOnline, displayState.isExternal, traceJoin]);
  return <StatusDot activity={displayState.activity} external={displayState.isExternal && !displayState.isOnline} size={size} className={className} {...rest} title={title} />;
}
