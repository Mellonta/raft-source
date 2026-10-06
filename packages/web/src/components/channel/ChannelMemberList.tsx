import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Badge, Button } from "raft-ui";
import type { AgentActivity, ServerRole } from "@botiverse/raft-shared";
import { UserMinus, X } from "lucide-react";
import AvatarSlot from "../ui/AvatarSlot";
import SectionEyebrow from "../ui/SectionEyebrow";
import Tooltip from "../ui/Tooltip";
import AgentActivityDot from "../agent/AgentActivityDot";

export function ChannelMemberListShell({
  children,
  className = "",
  framed = true,
  "data-testid": dataTestId,
}: {
  children: ReactNode;
  className?: string;
  /** Framed = bordered box with its own scroll (dialogs). Unframed = flat
      sections that scroll with the surrounding sheet (drawer panel). */
  framed?: boolean;
  "data-testid"?: string;
}) {
  return (
    <div
      className={
        framed
          ? `max-h-72 overflow-y-auto border border-line-muted bg-layer-panel shadow-raft-sm theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal-sm ${className}`
          : className
      }
      data-testid={dataTestId}
    >
      {children}
    </div>
  );
}

export function ChannelMemberSectionHeader({ children }: { children: ReactNode }) {
  return (
    <SectionEyebrow as="div" uppercase={false} className="bg-fill-muted px-3 py-1.5 text-foreground-muted theme-brutal:bg-white/50 theme-brutal:text-black">
      {children}
    </SectionEyebrow>
  );
}

function ChannelMemberActivityBadge({
  agentId,
  fallbackActivity,
}: {
  agentId: string;
  fallbackActivity?: AgentActivity;
}) {
  return (
    <AgentActivityDot
      agentId={agentId}
      fallbackActivity={fallbackActivity}
      size="md"
      data-channel-member-avatar-badge-shell="true"
    />
  );
}

/** Channel membership only needs one visible distinction: whether the actor
 *  effectively administers this channel. Server owner/admin inheritance and
 *  an explicit channel grant intentionally share the same user-facing label. */
export function MemberRoleTag({ role }: { role: ServerRole }) {
  const { formatMessage } = useIntl();
  if (role === "member") return null;
  const isGuest = role === "guest";
  return (
    <Badge
      data-testid={isGuest ? "member-page-role-channel-guest" : "member-page-role-channel-admin"}
      appearance="soft"
      variant={isGuest ? "information" : "muted"}
      uppercase={false}
      className="shrink-0 font-mono"
    >
      {formatMessage({ id: isGuest
        ? "channel.membersPage.role.channelGuest"
        : "channel.membersPage.role.channelAdmin" })}
    </Badge>
  );
}

export function ChannelMemberRoleAndActions({
  role,
  actions,
}: {
  role: ServerRole;
  actions: ReactNode;
}) {
  return (
    <span
      className="flex shrink-0 self-center items-center gap-2 md:grid"
      data-testid="member-page-trailing"
    >
      <span
        className={`flex shrink-0 items-center md:col-start-1 md:row-start-1 md:justify-self-end ${actions ? "md:group-hover:invisible md:group-focus-within:invisible" : ""}`}
      >
        <MemberRoleTag role={role} />
      </span>
      {actions ? (
        <span className="shrink-0 self-center md:invisible md:col-start-1 md:row-start-1 md:justify-self-end md:group-hover:visible md:group-focus-within:visible">
          {actions}
        </span>
      ) : null}
    </span>
  );
}

export function ChannelMemberRow({
  type,
  name,
  secondary,
  agentId,
  agentAvatarUrl,
  agentFallbackActivity,
  humanAvatarUrl,
  gravatarHash,
  onAvatarClick,
  onRowClick,
  trailing,
}: {
  type: "agent" | "human";
  name: ReactNode;
  secondary?: ReactNode;
  agentId?: string;
  agentAvatarUrl?: string | null;
  agentFallbackActivity?: AgentActivity;
  humanAvatarUrl?: string | null;
  gravatarHash?: string | null;
  onAvatarClick?: () => void;
  /** Whole-row click (member page: row → profile). Mutually exclusive
   *  with onAvatarClick — a button cannot nest inside a button, so the
   *  avatar renders inert when the row itself is the click target. */
  onRowClick?: () => void;
  trailing?: ReactNode;
}) {
  const avatar = (
    <AvatarSlot
      context="members-row"
      type={type}
      agentAvatarUrl={agentAvatarUrl}
      humanAvatarUrl={humanAvatarUrl}
      gravatarHash={gravatarHash}
      badge={type === "agent" && agentId ? (
        <ChannelMemberActivityBadge agentId={agentId} fallbackActivity={agentFallbackActivity} />
      ) : undefined}
      className={onAvatarClick || onRowClick ? "transition-colors hover:brightness-90" : undefined}
    />
  );

  const body = (
    <>
      <div className="min-w-0 flex-1">
        <div className={`truncate text-sm text-foreground-strong ${type === "human" ? "font-bold" : "font-medium"}`}>
          {name}
        </div>
        {secondary ? (
          <div className="truncate text-xs text-foreground-muted">
            {secondary}
          </div>
        ) : null}
      </div>
      {trailing}
    </>
  );

  if (onRowClick) {
    // The row body (avatar + name + sub-line) IS the profile button; the
    // trailing slot (role tag, remove button) renders as a sibling so
    // interactive controls never nest inside a button.
    return (
      <div className="group flex items-start gap-2 px-3 py-2 transition-colors [@media(max-height:600px)]:py-1 hover:bg-fill-muted">
        <button
          type="button"
          onClick={onRowClick}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
        >
          <span className="relative mt-1 shrink-0">{avatar}</span>
          <div className="min-w-0 flex-1">
            <div className={`truncate text-sm text-foreground-strong ${type === "human" ? "font-bold" : "font-medium"}`}>
              {name}
            </div>
            {secondary ? (
              <div className="truncate text-xs text-foreground-muted">
                {secondary}
              </div>
            ) : null}
          </div>
        </button>
        {trailing}
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-2 px-3 py-2 transition-colors [@media(max-height:600px)]:py-1 hover:bg-fill-muted">
      {onAvatarClick ? (
        <button
          type="button"
          onClick={onAvatarClick}
          className="relative mt-1 shrink-0"
        >
          {avatar}
        </button>
      ) : (
        <span className="relative mt-1 shrink-0">{avatar}</span>
      )}
      {body}
    </div>
  );
}

export function ChannelMemberRemoveButton({
  label,
  onClick,
  revealOnRowHover = true,
  visibleLabel,
  icon,
}: {
  label: string;
  onClick: () => void;
  /** Desktop hover-reveal. Uses visibility (not display) so the button's
   *  space is always reserved — the trailing badge never shifts when the
   *  control appears (Artea 2026-08-05: reveal jitter). Mobile always
   *  shows it (no hover). */
  revealOnRowHover?: boolean;
  /** Member-management rows render icon-only with a suitable icon (Artea,
   *  2026-09-17); other compact lists keep the bare icon affordance. */
  visibleLabel?: string;
  icon?: ReactNode;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        onClick={onClick}
        className={`${revealOnRowHover ? "flex md:invisible md:group-hover:visible md:group-focus-within:visible" : "flex"} ${visibleLabel ? "h-7 px-2 text-xs" : icon ? "h-7 w-7" : "size-6 mt-1"} shrink-0 items-center justify-center rounded-sm border border-line-muted bg-danger-soft text-danger-strong transition-colors hover:bg-danger/30 theme-brutal:rounded-none theme-brutal:border-black theme-brutal:bg-brutal-red/20 theme-brutal:text-black theme-brutal:hover:bg-brutal-red/60`}
        aria-label={label}
      >
        {visibleLabel ?? icon ?? <X size={12} />}
      </button>
    </Tooltip>
  );
}

export function ChannelMemberHoverActions({
  roleAction,
  removeAction,
}: {
  roleAction?: {
    label: string;
    ariaLabel?: string;
    onClick: () => void;
    disabled?: boolean;
  };
  removeAction?: {
    label: string;
    onClick: () => void;
  };
}) {
  if (!roleAction && !removeAction) return null;

  return (
    <span className="flex items-center gap-2" data-testid="channel-member-hover-actions">
      {roleAction && (
        <Button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            roleAction.onClick();
          }}
          disabled={roleAction.disabled}
          size="sm"
          variant="outline"
          className="h-7 whitespace-nowrap px-2 text-xs"
          data-testid="channel-member-role-action"
          aria-label={roleAction.ariaLabel}
        >
          {roleAction.label}
        </Button>
      )}
      {removeAction && (
        <ChannelMemberRemoveButton
          label={removeAction.label}
          onClick={removeAction.onClick}
          revealOnRowHover={false}
          icon={<UserMinus size={14} aria-hidden />}
        />
      )}
    </span>
  );
}
