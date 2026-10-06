import { useIntl } from "react-intl";
import AttentionDot from "../components/ui/AttentionDot";
import { useFeedbackUnread } from "./useFeedbackUnread";

/** Settings destinations share the Bell's server-owned unread count. */
export default function FeedbackUnreadDot({ className }: { className?: string }) {
  const count = useFeedbackUnread();
  const { formatMessage } = useIntl();
  if (count === 0) return null;
  const label = formatMessage({ id: "layout.systemNotifications.feedbackRepliesTitle" });
  return <AttentionDot className={className} role="img" aria-label={label} data-testid="feedback-unread-dot" />;
}
