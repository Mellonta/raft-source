import { Button } from "raft-ui";
import { BellRing, Clock3, Link2, RefreshCw, Repeat } from "lucide-react";
import type { MouseEvent } from "react";
import { useIntl } from "react-intl";
import type { ReminderSummary } from "@botiverse/raft-shared";
import Banner from "../ui/Banner";
import EmptyState from "../ui/EmptyState";
import { formatRelativeTimeParts } from "../../utils/relativeTime";
import SurfaceListItem from "../ui/SurfaceListItem";
import SectionHeader from "../ui/SectionHeader";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";

function getRelativeTimeParts(value: string): { value: number; unit: Intl.RelativeTimeFormatUnit } {
  const date = new Date(value);
  const diffMs = date.getTime() - Date.now();
  const absMs = Math.abs(diffMs);

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (absMs < hour) return { value: Math.round(diffMs / minute), unit: "minute" };
  if (absMs < day) return { value: Math.round(diffMs / hour), unit: "hour" };
  return { value: Math.round(diffMs / day), unit: "day" };
}

// v0: human surface is read-only — the Cancel action lives on the agent
// side (MCP `cancel_reminder`). Do not wire a cancel button here until the
// v1 product decision on human-initiated cancel lands.
function ReminderCard({
  reminder,
  onOpenMsgRef,
}: {
  reminder: ReminderSummary;
  onOpenMsgRef?: (permalink: string) => void;
}) {
  const { locale } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const handleMsgRefClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!reminder.msgPermalink || !onOpenMsgRef) return;
    // Preserve default behavior for modifier clicks (new tab / new window / save).
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onOpenMsgRef(reminder.msgPermalink);
  };

  return (
    <SurfaceListItem>
      <div className="min-w-0">
        <div className="text-sm font-bold text-foreground-strong theme-brutal:text-black break-words">{reminder.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-foreground-muted theme-brutal:text-black/50">
          <span className="inline-flex items-center gap-1 font-medium text-foreground-muted theme-brutal:text-black/60">
            <Clock3 size={12} />
            {(() => {
              const parts = getRelativeTimeParts(reminder.fireAt);
              return formatRelativeTimeParts(parts.value, parts.unit, locale);
            })()}
          </span>
          <span className="font-mono">{formatShortDateTime(reminder.fireAt)}</span>
          {reminder.recurrence && (
            <span
              className="inline-flex items-center gap-1 border border-line-muted theme-brutal:border-black bg-accent-soft theme-brutal:bg-brutal-lavender/30 px-1.5 py-0.5 font-mono text-[11px] text-foreground-strong theme-brutal:text-black"
            >
              <Repeat size={11} />
              {reminder.recurrence.description}
            </span>
          )}
        </div>
        {reminder.msgRef && (
          <div className="mt-2">
            {reminder.msgPermalink ? (
              <a
                href={reminder.msgPermalink}
                onClick={handleMsgRefClick}
                className="inline-flex max-w-full cursor-default items-center gap-1 truncate border border-line-muted theme-brutal:border-black bg-layer-panel theme-brutal:bg-white px-1.5 py-0.5 font-mono text-[11px] text-foreground-strong theme-brutal:text-black hover:bg-fill-muted theme-brutal:hover:bg-soft-signal/30"
              >
                <Link2 size={11} className="shrink-0" />
                <span className="truncate">{reminder.msgRef}</span>
              </a>
            ) : (
              <span className="inline-flex max-w-full items-center gap-1 truncate border border-line-muted theme-brutal:border-black bg-layer-panel theme-brutal:bg-white px-1.5 py-0.5 font-mono text-[11px] text-foreground-muted theme-brutal:text-black/70">
                <Link2 size={11} className="shrink-0" />
                <span className="truncate">{reminder.msgRef}</span>
              </span>
            )}
          </div>
        )}
      </div>
    </SurfaceListItem>
  );
}

export default function AgentRemindersSection({
  reminders,
  loading,
  error,
  onRetry,
  onOpenMsgRef,
  variant = "section",
}: {
  reminders: ReminderSummary[];
  loading: boolean;
  error: string | null;
  onRetry?: () => void | Promise<void>;
  onOpenMsgRef?: (permalink: string) => void;
  variant?: "section" | "tab";
}) {
  const { formatMessage } = useIntl();
  const isTab = variant === "tab";
  return (
    <div
      className={
        isTab
          ? "flex-1 overflow-y-auto bg-layer-panel theme-brutal:bg-white px-5 py-5"
          : "px-5 py-4 border-t border-line-muted theme-brutal:border-black/10"
      }
    >
      {isTab ? (
        loading ? <div className="mb-3 text-xs font-bold text-foreground-muted theme-brutal:text-black/50">{formatMessage({ id: "common.loading" })}</div> : null
      ) : (
        <SectionHeader
          className="mb-3"
          icon={<BellRing size={14} className="text-foreground-muted theme-brutal:text-black/50" />}
          label={formatMessage({ id: "agent.reminders.pendingLabel" })}
          count={reminders.length}
          action={
            loading ? (
              <span className="text-xs font-bold text-foreground-muted theme-brutal:text-black/50">{formatMessage({ id: "common.loading" })}</span>
            ) : null
          }
        />
      )}

      {error ? (
        <Banner intent="warning" density="sm" className="font-bold">
          <div>{error}</div>
          {onRetry && (
            <Button variant="outline" size="sm"
              type="button"
              onClick={() => void onRetry()}
              className="mt-2 text-[11px]"
            >
              <span className="inline-flex items-center gap-1">
                <RefreshCw size={12} />
                {formatMessage({ id: "agent.reminders.retry" })}
              </span>
            </Button>
          )}
        </Banner>
      ) : reminders.length === 0 ? (
        isTab ? (
          <EmptyState
            className="flex h-full flex-col items-center justify-center bg-layer-panel theme-brutal:bg-white"
            icon={<BellRing size={28} />}
            title={formatMessage({ id: "emptyState.noRemindersTitle" })}
            description={formatMessage({ id: "emptyState.noRemindersDesc" })}
          />
        ) : (
          <div className="text-sm text-foreground-muted theme-brutal:text-black/50">{formatMessage({ id: "agent.reminders.noPending" })}</div>
        )
      ) : (
        <div className="space-y-3">
          {reminders.map((reminder) => (
            <ReminderCard
              key={reminder.reminderId}
              reminder={reminder}
              onOpenMsgRef={onOpenMsgRef}
            />
          ))}
        </div>
      )}
    </div>
  );
}
