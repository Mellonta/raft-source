import { BellRing, Check, UserPlus, UserX } from "lucide-react";
import { useIntl } from "react-intl";
import type { PendingMentionAction } from "../../store/messageStore";
import AvatarSlot from "../ui/AvatarSlot";
import { Button } from "raft-ui";
import { AgentAvatar } from "../agent/PixelAvatar";

export type PendingMentionActionLocalState = "notified" | "added";

interface PendingMentionActionStripProps {
  actions: PendingMentionAction[];
  actionState: Record<string, PendingMentionActionLocalState>;
  actionRemoving: Record<string, boolean>;
  actionExecuting: Record<string, PendingMentionActionLocalState>;
  channelName: string;
  onMarkAction: (resolutionId: string, state: PendingMentionActionLocalState) => void;
  onAddAllActions: (resolutionIds: string[]) => void;
  onDismissAction: (resolutionId: string) => void;
}

function pendingMentionCanNotify(action: PendingMentionAction): boolean {
  return action.availableActions.some((available) => available === "notify" || available === "notify_only");
}

function pendingMentionCanAdd(action: PendingMentionAction): boolean {
  return action.availableActions.some((available) => available === "add" || available === "invite");
}

function pendingMentionTargetLabel(action: PendingMentionAction): string {
  const handle = action.targetHandle || action.targetType;
  if ((action.targetType === "user" || action.targetType === "agent") && handle && !handle.startsWith("@")) {
    return `@${handle}`;
  }
  return handle;
}

function pendingMentionTargetInitial(action: PendingMentionAction): string {
  const label = pendingMentionTargetLabel(action).replace(/^@/, "").trim();
  return (label[0] || "?").toUpperCase();
}

function PendingMentionTargetAvatar({ action }: { action: PendingMentionAction }) {
  if ((action.targetType === "agent" || action.targetType === "user") && action.targetAvatarUrl) {
    return (
      <span data-testid="pending-mention-target-avatar">
        <AvatarSlot
          context="compact-list"
          type={action.targetType === "agent" ? "agent" : "human"}
          agentAvatarUrl={action.targetAvatarUrl}
          humanAvatarUrl={action.targetAvatarUrl}
        >
          <AgentAvatar avatarUrl={action.targetAvatarUrl} size={18} className="!h-full !w-full" />
        </AvatarSlot>
      </span>
    );
  }

  return (
    <span
      className="absolute left-0 top-0"
      data-testid="pending-mention-target-initial"
    >
      <AvatarSlot context="compact-list" type="app" appInitials={pendingMentionTargetInitial(action)} />
    </span>
  );
}

function channelMentionLabel(channelName: string): string {
  return channelName.startsWith("#") ? channelName : `#${channelName}`;
}

export function PendingMentionActionStrip({
  actions,
  actionState,
  actionRemoving,
  actionExecuting,
  channelName,
  onMarkAction,
  onAddAllActions,
  onDismissAction,
}: PendingMentionActionStripProps) {
  const { formatMessage } = useIntl();
  const addableResolutionIds = actions
    .filter((action) => (
      pendingMentionCanAdd(action)
      && !actionState[action.resolutionId]
      && !actionRemoving[action.resolutionId]
    ))
    .map((action) => action.resolutionId);
  const showAddAll = addableResolutionIds.length > 1;
  const isAddingAll = addableResolutionIds.some((resolutionId) => Boolean(actionExecuting[resolutionId]));

  return (
    <div
      className="mb-2 w-full rounded-lg border border-line-muted bg-layer-panel px-3 py-2 shadow-raft-xs theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-brutal-cream theme-brutal:shadow-brutal-sm"
      data-testid="pending-mention-action-strip"
    >
      <div className="flex flex-col gap-2" data-testid="pending-mention-action-rows">
        {actions.map((action) => {
          const localState = actionState[action.resolutionId];
          const targetLabel = pendingMentionTargetLabel(action);
          const channelLabel = channelMentionLabel(channelName);
          const executingState = actionExecuting[action.resolutionId];
          const isRemoving = Boolean(actionRemoving[action.resolutionId]);
          const canNotify = pendingMentionCanNotify(action) && !localState;
          const canAdd = pendingMentionCanAdd(action) && !localState;
          const statusCopy = localState === "added"
            ? formatMessage(
              { id: "message.pendingMention.addedStatus" },
              { target: targetLabel, channel: channelLabel },
            )
            : localState === "notified"
              ? formatMessage(
                { id: "message.pendingMention.queuedStatus" },
                { target: targetLabel, channel: channelLabel },
              )
              : formatMessage(
                { id: "message.pendingMention.notNotified" },
                { target: targetLabel, channel: channelLabel },
              );
          return (
            <div
              key={action.resolutionId}
              className={`flex min-w-0 flex-col items-stretch gap-2 transition-opacity duration-300 sm:flex-row sm:flex-wrap sm:items-center ${isRemoving ? "opacity-0" : "opacity-100"}`}
            >
              <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1">
                <UserX size={14} className="shrink-0 text-foreground-hint" />
                <div className="relative h-5 w-5 shrink-0" aria-hidden="true">
                  <PendingMentionTargetAvatar action={action} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-bold text-foreground-strong">{targetLabel}</div>
                  <div
                    className="line-clamp-2 text-[11px] leading-4 text-foreground-muted sm:line-clamp-none sm:truncate"
                    data-testid="pending-mention-action-status"
                  >
                    {statusCopy}
                  </div>
                </div>
              </div>
              <div
                className="flex w-full shrink-0 items-center justify-end gap-1.5 sm:ml-auto sm:w-auto"
                data-testid="pending-mention-action-buttons"
              >
                {localState === "added" ? (
                  <span className="inline-flex items-center gap-1 rounded-md border border-line-hairline bg-fill-muted px-2 py-0.5 text-[12px] font-bold text-foreground-hint cursor-default theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black/20 theme-brutal:bg-black/[0.04] theme-brutal:text-black/40">
                    <Check size={12} strokeWidth={3} />
                    {formatMessage({ id: "message.pendingMention.added" })}
                  </span>
                ) : canAdd ? (
                  <Button
                    type="button"
                    variant="accent"
                    size="sm"
                    disabled={Boolean(executingState)}
                    onClick={() => onMarkAction(action.resolutionId, "added")}
                  >
                    <UserPlus size={12} />
                    {formatMessage({ id: "message.pendingMention.add" })}
                  </Button>
                ) : null}
                {localState === "notified" ? (
                  <span className="inline-flex items-center gap-1 rounded-md border border-line-hairline bg-fill-muted px-2 py-0.5 text-[12px] font-bold text-foreground-hint cursor-default theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black/20 theme-brutal:bg-black/[0.04] theme-brutal:text-black/40">
                    <Check size={12} strokeWidth={3} />
                    {formatMessage({ id: "message.pendingMention.queued" })}
                  </span>
                ) : canNotify ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={Boolean(executingState)}
                    onClick={() => onMarkAction(action.resolutionId, "notified")}
                  >
                    <BellRing size={12} />
                    {formatMessage({ id: "message.pendingMention.notify" })}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="muted"
                  size="sm"
                  onClick={() => onDismissAction(action.resolutionId)}
                >
                  {formatMessage({ id: "message.pendingMention.dismiss" })}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      {showAddAll && (
        <div
          className="mt-2 flex justify-end border-t border-line-hairline pt-2"
          data-testid="pending-mention-action-footer"
        >
          <Button
            type="button"
            variant="accent"
            size="sm"
            disabled={isAddingAll}
            onClick={() => onAddAllActions(addableResolutionIds)}
          >
            <UserPlus size={12} />
            {formatMessage({ id: "message.pendingMention.addAll" })}
          </Button>
        </div>
      )}
    </div>
  );
}
