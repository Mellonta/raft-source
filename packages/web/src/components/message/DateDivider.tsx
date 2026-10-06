import { MessageListDateDivider } from "raft-ui";
import { useIntl } from "react-intl";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";

/**
 * Day-boundary divider for the message timeline (task #44). Rendered before the
 * first message of each calendar day. Also used as the content of the sticky
 * current-day header (task #44), where `sticky` swaps the flat rule for a
 * self-contained pill so it reads over scrolling messages.
 *
 * Composes existing design-system pieces (no new primitive): the brutal
 * `border-t-2 border-black` rule (cf. `ui/ContextMenuDivider`) + the section
 * label treatment (`text-[10px] font-bold uppercase tracking-widest`, cf.
 * `ui/SectionHeader`).
 */
export function DateDivider({
  createdAt,
  sticky = false,
  testId,
}: {
  createdAt: string;
  sticky?: boolean;
  testId?: string;
}) {
  const { formatMessage } = useIntl();
  const { options } = useTimeFormatter();
  const label = formatDayLabel(createdAt, {
    locale: options.locale,
    timeZone: options.timeZone ?? undefined,
    todayLabel: formatMessage({ id: "message.dateDivider.today" }),
    yesterdayLabel: formatMessage({ id: "message.dateDivider.yesterday" }),
  });
  if (!label) return null;

  if (sticky) {
    return (
      <div className="pointer-events-none flex justify-center pt-1" data-testid={testId}>
        <span className="rounded-sm bg-layer-panel px-2 py-0.5 text-[10px] font-medium text-foreground-muted shadow-raft-xs theme-brutal:rounded-none theme-brutal:bg-white theme-brutal:font-bold theme-brutal:uppercase theme-brutal:tracking-widest theme-brutal:text-black/50">
          {label}
        </span>
      </div>
    );
  }
  return <MessageListDateDivider data-testid={testId}>{label}</MessageListDateDivider>;
}

/** "Today" / "Yesterday" / "Monday, June 30, 2026" in the viewer's timezone. */
function formatDayLabel(createdAt: string, options: {
  locale?: string | string[];
  timeZone?: string;
  todayLabel: string;
  yesterdayLabel: string;
}): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const { locale, timeZone } = options;
  const key = (d: Date) => d.toLocaleDateString("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone });
  const dateKey = key(date);
  if (dateKey === key(now)) return options.todayLabel;
  if (dateKey === key(yesterday)) return options.yesterdayLabel;

  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone,
  });
}
