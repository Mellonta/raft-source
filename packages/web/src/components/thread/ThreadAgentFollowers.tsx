import { Button, Popover, PopoverContent, PopoverTrigger, toast } from "raft-ui";
import { AlertCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { getSocket } from "../../api/socket";
import {
  requestThreadAgentFollowers,
  useThreadAgentFollowerStore,
} from "../../store/threadAgentFollowerStore";
import { useProfileStore } from "../../store/profileStore";
import { useServerStore } from "../../store/serverStore";
import { AgentActivityInfo, JointPeerBadge, agentStatusFallbackActivity } from "../agent/ChannelMembers";
import { ChannelMemberRow } from "../channel/ChannelMemberList";
import type { Agent } from "../../store/agentStore";
import { setCachedAgentProfile } from "../profile/profileFallbackCache";
import AvatarSlot from "../ui/AvatarSlot";
import Tooltip from "../ui/Tooltip";

/** The follower endpoint reports transport-ish statuses (for example
 *  "online"); normalize to the shared AgentStatus union the activity stores
 *  and profiles speak (task #701). */
function followerAgentStatus(status: string | null | undefined): Agent["status"] {
  return status === "active" || status === "online"
    ? "active"
    : status === "stopped" ? "stopped" : "inactive";
}

export default function ThreadAgentFollowers({
  threadChannelId,
  variant,
}: {
  threadChannelId: string;
  variant: "card" | "header";
}) {
  const { formatMessage } = useIntl();
  const roster = useThreadAgentFollowerStore((state) => state.rosters[threadChannelId]);
  const load = useThreadAgentFollowerStore((state) => state.load);
  const remove = useThreadAgentFollowerStore((state) => state.remove);
  const restore = useThreadAgentFollowerStore((state) => state.restore);
  const openProfile = useProfileStore((state) => state.openProfile);
  const currentServerId = useServerStore((state) => state.current?.id);
  const [open, setOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    requestThreadAgentFollowers(threadChannelId);
  }, [threadChannelId]);

  useEffect(() => {
    const socket = getSocket();
    const handleMessageNew = (message: { channelId?: string } | null | undefined) => {
      if (message?.channelId !== threadChannelId) return;
      requestThreadAgentFollowers(threadChannelId, true);
    };
    socket.on("message:new", handleMessageNew);
    return () => {
      socket.off("message:new", handleMessageNew);
    };
  }, [threadChannelId]);

  const agents = roster?.agents ?? [];
  const label = roster?.error
    ? formatMessage({ id: "thread.followers.loadFailed" })
    : formatMessage({ id: "thread.followers.label" }, { count: agents.length });

  const handleRemove = async (agentId: string, agentLabel: string) => {
    setRemovingId(agentId);
    try {
      const undoToken = await remove(threadChannelId, agentId);
      if (!undoToken) return;
      toast.success(
        formatMessage({ id: "thread.followers.removed" }, { agent: agentLabel }),
        {
          timeout: 5_000,
          dismissible: false,
          contentClassName: "thread-follower-removal-toast",
          action: {
            label: formatMessage({ id: "thread.followers.undo" }),
            onClick: () => {
              void restore(threadChannelId, agentId, undoToken).then((restored) => {
                if (restored) toast.success(formatMessage({ id: "thread.followers.restored" }, { agent: agentLabel }));
              });
            },
          },
        },
      );
    } catch {
      toast.error(formatMessage({ id: "thread.followers.removeFailed" }));
    } finally {
      setRemovingId(null);
    }
  };

  // Do not show a zero-count affordance. While the count is unknown there is
  // nothing actionable yet; a failed load still exposes Retry via an error-only
  // trigger rather than presenting the failure as "0 followers".
  if (!roster || roster.loading && !roster.loaded) return null;
  if (roster.loaded && agents.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content={label}>
      <PopoverTrigger
        render={(
          <Button
            type="button"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            size={variant === "header" ? "sm" : undefined}
            variant="outline"
            className={variant === "header"
              ? "h-7 gap-1 px-1.5 text-xs font-bold"
              : "inline-flex h-5 items-center gap-1 rounded border border-line-muted theme-brutal:border-black/25 bg-layer-panel theme-brutal:bg-white px-1.5 text-[10px] font-bold text-foreground-muted theme-brutal:text-black/60 hover:border-line-muted theme-brutal:hover:border-black"}
            aria-label={label}
            data-testid={`thread-followers-${variant}-trigger`}
          >
            <span className="flex -space-x-1" aria-hidden="true">
              {roster.error ? (
                <AlertCircle size={variant === "header" ? 14 : 12} />
              ) : agents.slice(0, 3).map((agent) => (
                <AvatarSlot key={agent.id} context={variant === "header" ? "sidebar-list" : "preview-mini"} type="agent" agentAvatarUrl={agent.avatarUrl} />
              ))}
            </span>
            {roster.error ? null : <span>{agents.length}</span>}
          </Button>
        )}
      />
      </Tooltip>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={6}
        // The trigger lives in a thread header that reflows when a profile
        // panel opens or the pane is resized. raft-ui disables anchor
        // tracking by default, which would leave this popover stranded at
        // the trigger's old coordinates.
        disableAnchorTracking={false}
        className="w-72 p-0"
        data-testid="thread-followers-popover"
      >
        <div className="border-b-2 border-line-muted theme-brutal:border-black bg-layer-panel theme-brutal:bg-brutal-cream px-3 py-2 text-sm font-bold">
          {formatMessage({ id: "thread.followers.title" })}
        </div>
        <div className="max-h-72 overflow-y-auto p-2">
          {roster?.loading && !roster.loaded ? (
            <div className="px-2 py-4 text-center text-xs font-bold text-foreground-placeholder theme-brutal:text-black/45" data-testid="thread-followers-loading">
              {formatMessage({ id: "thread.followers.loading" })}
            </div>
          ) : roster?.error ? (
            <div className="flex flex-col items-center gap-2 px-2 py-4 text-center text-xs font-bold text-foreground-muted theme-brutal:text-black/60" data-testid="thread-followers-error">
              <AlertCircle size={18} />
              {formatMessage({ id: "thread.followers.loadFailed" })}
              <Button variant="outline" size="sm" type="button" className="bg-layer-panel theme-brutal:bg-white px-2 py-1" onClick={() => void load([threadChannelId], true)}>
                {formatMessage({ id: "thread.followers.retry" })}
              </Button>
            </div>
          ) : agents.length === 0 ? (
            <div className="px-2 py-4 text-center text-xs font-bold text-foreground-placeholder theme-brutal:text-black/45" data-testid="thread-followers-empty">
              {formatMessage({ id: "thread.followers.empty" })}
            </div>
          ) : agents.map((agent) => {
            const agentLabel = agent.displayName || agent.name;
            const canRemoveAgent = roster?.canManage && agent.canRemove !== false;
            const serverLabel = agent.serverName || agent.serverSlug;
            const removeLabel = canRemoveAgent
              ? formatMessage({ id: "thread.followers.remove" }, { agent: agentLabel })
              : formatMessage({ id: "thread.followers.peerRemoveUnavailable" }, {
                agent: agentLabel,
                server: serverLabel || formatMessage({ id: "thread.followers.peerServer" }),
              });
            const openAgentProfile = () => {
              setCachedAgentProfile(currentServerId, {
                ...agent,
                // Normalize before seeding the fallback cache so peer rows
                // can open a complete profile.
                status: followerAgentStatus(agent.status),
                description: null,
                model: "",
                runtime: "",
                serverRole: null,
                reasoningEffort: null,
                executionMode: "cloud",
                envVars: null,
                machineId: null,
                creatorType: null,
                creatorId: null,
                creator: null,
                createdAgents: [],
                deletedAt: null,
                createdAt: "",
              });
              openProfile("agent", agent.id);
            };
            return (
              // artin (task #701): reuse the members list's row wholesale, so
              // the avatar's activity badge and the status sub-line stay
              // structurally identical to that surface.
              <div key={agent.id} data-testid="thread-follower-row">
                <ChannelMemberRow
                  type="agent"
                  agentId={agent.id}
                  agentAvatarUrl={agent.avatarUrl}
                  agentFallbackActivity={agentStatusFallbackActivity(followerAgentStatus(agent.status))}
                  name={(
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate">{agentLabel}</span>
                      {agent.isCurrentServer === false && serverLabel ? (
                        <span className="min-w-0">
                          <JointPeerBadge label={serverLabel} />
                        </span>
                      ) : null}
                    </span>
                  )}
                  secondary={<AgentActivityInfo agentId={agent.id} fallbackStatus={followerAgentStatus(agent.status)} />}
                  onRowClick={openAgentProfile}
                  trailing={roster?.canManage ? (
                    <Tooltip content={removeLabel}>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        className={`size-7 ${canRemoveAgent ? "" : "cursor-not-allowed opacity-45"}`}
                        disabled={!canRemoveAgent || removingId === agent.id}
                        onClick={() => {
                          if (!canRemoveAgent) return;
                          void handleRemove(agent.id, agentLabel);
                        }}
                        aria-label={removeLabel}
                        data-testid="thread-follower-remove"
                      >
                        <X size={14} />
                      </Button>
                    </Tooltip>
                  ) : undefined}
                />
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
