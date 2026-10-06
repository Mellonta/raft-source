import type { AgentActivity, AgentActivityDetailKind } from "@botiverse/raft-shared";
import { createIntl, createIntlCache } from "react-intl";
import type { IntlShape } from "react-intl";
import type { MessageId } from "../i18n/messages";
import { en } from "../i18n/messages/en";
import { formatRelativeTime } from "./relativeTime";

export type ActivityMessageValues = Record<string, string | number>;

export interface ActivityMessageDescriptor {
  id: MessageId;
  values?: ActivityMessageValues;
}

export interface ActivityTextDescriptor {
  primary: ActivityMessageDescriptor | { raw: string };
}

const enActivityIntl = createIntl(
  { locale: "en", defaultLocale: "en", messages: en },
  createIntlCache(),
);

/**
 * Maps agent activity state → Tailwind CSS classes for the status dot.
 */
export function getActivityDotClass(activity: AgentActivity): string {
  switch (activity) {
    case "online":
      return "bg-brutal-lime";
    // Status lights are fixed semantic colors — bg-status-busy, not the
    // skinnable soft-signal accent (see index.css token comment).
    // Static: an ambient state never loops (task #136). An infinite pulse kept
    // the compositor producing frames at display refresh rate for as long as
    // any agent worked — measured 144 fps / 80% GPU with a modal open vs 2 fps
    // / 3% with the dots paused. Busy yellow alone distinguishes it.
    case "thinking":
      return "bg-status-busy";
    case "working":
      return "bg-status-busy";
    case "error":
      return "bg-brutal-orange";
    case "offline":
    default:
      return "bg-gray-400";
  }
}

function extractErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim()) {
    return record.message.trim();
  }
  if (typeof record.error_description === "string" && record.error_description.trim()) {
    return record.error_description.trim();
  }
  if (typeof record.error === "string" && record.error.trim()) {
    return record.error.trim();
  }
  const nested = extractErrorMessage(record.error);
  if (nested) return nested;
  if (Array.isArray(record.errors)) {
    for (const item of record.errors) {
      const message = extractErrorMessage(item);
      if (message) return message;
    }
  }
  return null;
}

export function getActivityErrorDisplayDetail(detail?: string): string {
  const trimmed = detail?.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const message = extractErrorMessage(JSON.parse(trimmed));
      if (message) return message;
    } catch {
      // Fall through to the raw detail below.
    }
  }
  return trimmed;
}

export function getActivityTextDescriptor(
  activity: AgentActivity,
  detail?: string,
  detailKind?: AgentActivityDetailKind,
): ActivityTextDescriptor {
  // task #1116: the daemon observed deliveries it wrote that the runtime never
  // consumed. Dedicated copy regardless of the carried activity kind, so the
  // reader sees the observation rather than a misleading "Idle".
  if (detailKind === "delivery_unconsumed") {
    return { primary: { id: "activity.status.deliveryUnconsumed" } };
  }
  // task #1119: the server paused automatic wakes after consecutive early
  // exits; only a manual start lifts it, so say that instead of "Offline".
  if (detailKind === "wake_crash_loop_blocked") {
    return { primary: { id: "activity.status.wakeCrashLoopBlocked" } };
  }
  // RFC 071 §9: the terminal-failure breaker stopped automatic wakes. The
  // server's detail says until when (or that a manual start is needed) and
  // why; without it, the generic copy.
  if (detailKind === "terminal_failure_paused") {
    return { primary: detail ? { raw: detail } : { id: "activity.status.terminalFailurePaused" } };
  }
  switch (activity) {
    case "online":
      return { primary: { id: "activity.status.online" } };
    case "thinking":
      return { primary: { id: "activity.status.thinkingEllipsis" } };
    case "working":
      if (detailKind === "starting" || detailKind === "runtime_starting") {
        return { primary: { id: "activity.status.startingEllipsis" } };
      }
      if (detailKind === "compacting_context") {
        return { primary: { id: "activity.status.compactingContextEllipsis" } };
      }
      return { primary: detail ? { raw: detail } : { id: "activity.status.workingEllipsis" } };
    case "error": {
      const errorDetail = getActivityErrorDisplayDetail(detail);
      return {
        primary: errorDetail
          ? { id: "activity.status.errorWithDetail", values: { detail: errorDetail } }
          : { id: "activity.status.error" },
      };
    }
    case "offline":
      // task #1123: a failed start is reported as offline + runtime_unavailable
      // with a human detail chosen by the daemon's typed reason. The activity
      // log must show that detail, not collapse it into a bare "Offline".
      if (detailKind === "runtime_unavailable" && detail) {
        return { primary: { raw: detail } };
      }
      return {
        primary: {
          id: detailKind === "stopped"
            ? "activity.status.stoppedUnavailable"
            : "activity.status.offline",
        },
      };
    default:
      return { primary: { raw: activity } };
  }
}

export function formatActivityTextDescriptor(
  formatMessage: IntlShape["formatMessage"],
  descriptor: ActivityTextDescriptor,
): string {
  const { primary } = descriptor;
  if ("raw" in primary) return primary.raw;
  return String(formatMessage({ id: primary.id }, primary.values));
}

export function formatActivityText(
  formatMessage: IntlShape["formatMessage"],
  activity: AgentActivity,
  detail?: string,
  detailKind?: AgentActivityDetailKind,
): string {
  return formatActivityTextDescriptor(
    formatMessage,
    getActivityTextDescriptor(activity, detail, detailKind),
  );
}

/** The display-state fields `formatAgentDisplayStateText` reads. */
export interface AgentDisplayTextInput {
  activity: AgentActivity;
  activityDetail: string;
  activityDetailKind: AgentActivityDetailKind;
  isOnline: boolean;
  isExternal?: boolean;
  lastSeenAt?: string | null;
}

/**
 * Localized status text for an agent display state. Same as
 * `formatActivityText`, except an external agent that is not online but was
 * seen before reads "Last active <time ago>".
 * `withDetail: false` withholds the activity detail (public projections).
 */
export function formatAgentDisplayStateText(
  intl: Pick<IntlShape, "formatMessage" | "locale">,
  state: AgentDisplayTextInput,
  options: { withDetail?: boolean } = {},
): string {
  if (state.isExternal && !state.isOnline && state.lastSeenAt) {
    const time = formatRelativeTime(state.lastSeenAt, intl.locale);
    if (time) return String(intl.formatMessage({ id: "activity.status.lastActive" }, { time }));
  }
  return options.withDetail === false
    ? formatActivityText(intl.formatMessage, state.activity, "")
    : formatActivityText(intl.formatMessage, state.activity, state.activityDetail, state.activityDetailKind);
}

/**
 * Maps agent activity state → full display text (always returns a string).
 * When detail is provided and applicable, shows the granular label.
 *
 * Prefer `getActivityTextDescriptor` at user-visible call sites. This fallback
 * formats through the English catalog so non-React/store consumers stay free of
 * app-locale wiring without reintroducing return-prose literals.
 */
export function getActivityText(activity: AgentActivity, detail?: string, detailKind?: AgentActivityDetailKind): string {
  return formatActivityText(enActivityIntl.formatMessage, activity, detail, detailKind);
}
