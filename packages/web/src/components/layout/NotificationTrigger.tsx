import { forwardRef, useState } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Bell } from "lucide-react";
import { useIntl } from "react-intl";
import {
  NotificationCenter,
  PopoverTrigger,
  Status,
  useThemeFamily,
} from "raft-ui";
import ConnectedNotificationCenter from "./NotificationCenter";
import Tooltip from "../ui/Tooltip";
import { useVisibleNotifications } from "./useSystemNotifications";
import type { NotificationEntry } from "./useSystemNotifications";

export interface NotificationTriggerProps {
  flavor: "rail-bottom" | "mobile-navbar";
  notifications?: NotificationEntry[];
}

export default function NotificationTrigger({
  flavor,
  notifications: notificationsProp,
}: NotificationTriggerProps) {
  // oxlint-disable-next-line react-doctor/no-event-handler -- flavor is static per mounted trigger.
  const liveNotifications = useVisibleNotifications(flavor === "mobile-navbar" ? "mobile" : "desktop");
  // oxlint-disable-next-line react-doctor/no-event-handler -- pre-existing prop-derived test override.
  const notifications = notificationsProp ?? liveNotifications;
  const [open, setOpen] = useState(false);
  const { formatMessage } = useIntl();
  const hasUnread = notifications.length > 0;
  const ariaLabel = hasUnread
    ? formatMessage({ id: "layout.notifications.centerActiveAria" }, { count: notifications.length })
    : formatMessage({ id: "layout.notifications.centerAria" });

  const button = (
    <NotificationTriggerButton
      open={open}
      hasUnread={hasUnread}
      ariaLabel={ariaLabel}
      testId={flavor === "rail-bottom" ? "notification-trigger-rail" : "notification-trigger-mobile"}
      sizeClass={flavor === "rail-bottom" ? "size-10" : "size-8"}
      icon={<Bell size={flavor === "rail-bottom" ? 18 : 16} className="text-foreground-muted theme-brutal:text-black" />}
    />
  );

  return (
    <NotificationCenter open={open} onOpenChange={setOpen}>
      <div className={`relative ${flavor === "rail-bottom" ? "flex h-11 w-full items-center justify-center" : "shrink-0"}`}>
        {flavor === "mobile-navbar" ? (
          <Tooltip
            content={formatMessage({ id: "layout.notifications.centerTooltip" })}
            contentProps={{ side: "bottom" }}
          >
            <PopoverTrigger render={button} />
          </Tooltip>
        ) : (
          // The generic raft-ui trigger keeps the rail-owned 40px Bell visual;
          // NotificationCenterTrigger is a complete orange button recipe.
          <PopoverTrigger openOnHover delay={0} closeDelay={120} render={button} />
        )}
        <ConnectedNotificationCenter
          notifications={notifications}
          flavor={flavor === "rail-bottom" ? "desktop" : "mobile"}
        />
      </div>
    </NotificationCenter>
  );
}

type NotificationTriggerButtonProps = Omit<ComponentPropsWithoutRef<"button">, "children"> & {
  open: boolean;
  hasUnread: boolean;
  ariaLabel: string;
  testId: string;
  sizeClass: string;
  icon: ReactNode;
};

const NotificationTriggerButton = forwardRef<HTMLButtonElement, NotificationTriggerButtonProps>(function NotificationTriggerButton({
  open,
  hasUnread,
  ariaLabel,
  testId,
  sizeClass,
  icon,
  className = "",
  ...buttonProps
}, ref) {
  const theme = useThemeFamily();
  return (
    <button
      {...buttonProps}
      ref={ref}
      type="button"
      aria-label={ariaLabel}
      data-state={open ? "open" : "closed"}
      data-has-unread={hasUnread ? "true" : "false"}
      data-testid={testId}
      className={`relative inline-flex ${sizeClass} items-center justify-center rounded-md border border-transparent transition-colors theme-brutal:rounded-none theme-brutal:border-2 ${
        open
          ? "bg-fill-muted shadow-raft-sm theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal-sm"
          : "bg-transparent hover:bg-fill-muted theme-brutal:hover:border-black theme-brutal:hover:bg-white"
      } ${className}`}
    >
      <span className="relative inline-flex items-center justify-center">
        {icon}
        {hasUnread ? (
          <Status
            aria-hidden
            attention
            size="md"
            variant={theme === "elegant" ? "primary" : "accent"}
            className="pointer-events-none absolute -top-1 -end-1"
            data-testid={`${testId}-unread-dot`}
          />
        ) : null}
      </span>
    </button>
  );
});
