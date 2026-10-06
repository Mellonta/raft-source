import type { ReactElement, ReactNode } from "react";
import { User } from "lucide-react";
import { Avatar, AvatarBadge, AvatarFallback } from "raft-ui";
import type { AvatarSize } from "raft-ui";
import { AgentAvatar } from "../agent/PixelAvatar";
import GravatarAvatar from "../member/GravatarAvatar";

/**
 * Product identity adapter: RUI owns the frame, theme shape and badge geometry.
 * The context only preserves existing layout sizes; image loading and pixel
 * artwork stay in their existing leaf renderers. AvatarFallback clips that
 * content using RUI's theme recipe, while AvatarBadge remains outside the clip.
 */
export type AvatarContext =
  | "profile-tile"
  | "account-tile"
  | "mention-card"
  | "panel-header"
  | "surface-list"
  | "members-row"
  | "creator-link"
  | "sidebar-list"
  | "compact-list"
  | "preview-mini";

interface ContextSpec {
  /** PixelAvatar `size` prop (used for agents). */
  agentPixel: number;
  /** GravatarAvatar `size` prop (used for humans). */
  gravatarSize: number;
  /** GravatarAvatar `iconSize` prop (used for humans, controls internal User
   *  icon fallback). */
  gravatarIcon: number;
  /** Lucide `<User size={...}>` for explicit `humanPlaceholder` path. */
  placeholderIcon: number;
  /** Text size for server initial placeholders. */
  serverInitialText: string;
}

const SPEC: Record<AvatarContext, ContextSpec> = {
  "profile-tile": {
    agentPixel: 60,
    gravatarSize: 60,
    gravatarIcon: 32,
    placeholderIcon: 32,
    serverInitialText: "text-2xl",
  },
  "account-tile": {
    agentPixel: 52,
    gravatarSize: 52,
    gravatarIcon: 24,
    placeholderIcon: 24,
    serverInitialText: "text-xl",
  },
  "mention-card": {
    agentPixel: 44,
    gravatarSize: 44,
    gravatarIcon: 24,
    placeholderIcon: 24,
    serverInitialText: "text-lg",
  },
  "panel-header": {
    agentPixel: 32,
    gravatarSize: 32,
    gravatarIcon: 16,
    placeholderIcon: 18,
    serverInitialText: "text-sm",
  },
  "surface-list": {
    agentPixel: 28,
    gravatarSize: 28,
    gravatarIcon: 16,
    placeholderIcon: 16,
    serverInitialText: "text-xs",
  },
  "members-row": {
    agentPixel: 26,
    gravatarSize: 24,
    gravatarIcon: 14,
    placeholderIcon: 14,
    serverInitialText: "text-xs",
  },
  "creator-link": {
    agentPixel: 20,
    gravatarSize: 20,
    gravatarIcon: 12,
    placeholderIcon: 12,
    serverInitialText: "text-[10px]",
  },
  "sidebar-list": {
    agentPixel: 16,
    gravatarSize: 16,
    gravatarIcon: 10,
    placeholderIcon: 10,
    serverInitialText: "text-[9px]",
  },
  "compact-list": {
    agentPixel: 18,
    gravatarSize: 18,
    gravatarIcon: 12,
    placeholderIcon: 12,
    serverInitialText: "text-[10px]",
  },
  "preview-mini": {
    agentPixel: 14,
    gravatarSize: 14,
    gravatarIcon: 10,
    placeholderIcon: 10,
    serverInitialText: "text-[8px]",
  },
};

/**
 * Keep the legacy AvatarSlot box and border explicit even when the matching
 * raft-ui public size is identical. Presence chrome must not make an identity
 * surface silently inherit a future Avatar scale change.
 */
const RAFT_AVATAR_SPEC: Record<AvatarContext, { size: AvatarSize; className: string }> = {
  "profile-tile": { size: "xl", className: "!size-16 !border-2" },
  "account-tile": { size: "xl", className: "!size-14 !border-2" },
  "mention-card": { size: "lg", className: "!size-12 !border-2" },
  "panel-header": { size: "md", className: "!size-9 !border-2" },
  "surface-list": { size: "sm", className: "!size-8 !border-2" },
  "members-row": { size: "sm", className: "!size-7 !border" },
  "creator-link": { size: "xs", className: "!size-[22px] !border" },
  "sidebar-list": { size: "2xs", className: "!size-[18px] !border" },
  "compact-list": { size: "xs", className: "!size-5 !border" },
  "preview-mini": { size: "3xs", className: "!size-[14px] !border" },
};

export interface AvatarSlotProps {
  context: AvatarContext;
  /** Entity kind — controls which inner renderer is used. */
  type: "agent" | "human" | "server" | "app";
  /** Agent's avatarUrl (`pixel:*` key or uploaded image URL). Used when
   *  `type="agent"`. */
  agentAvatarUrl?: string | null;
  /** Human's gravatar hash. Used when `type="human"`. */
  gravatarHash?: string | null;
  /** Human's uploaded avatar URL. Used before Gravatar when `type="human"`. */
  humanAvatarUrl?: string | null;
  /** Server's uploaded avatar URL. Used when `type="server"`. */
  serverAvatarUrl?: string | null;
  /** Server initial placeholder. Used when `type="server"` has no avatar. */
  serverInitial?: string | null;
  /** App logo URL. Used when `type="app"`. */
  appAvatarUrl?: string | null;
  /** App initials placeholder. Used when `type="app"` has no logo. */
  appInitials?: string | null;
  /** Optional email — GravatarAvatar derives a hash client-side when
   *  `gravatarHash` is missing. Used when `type="human"`. */
  email?: string | null;
  /** When `type="human"`, render a static User-icon placeholder instead of
   *  attempting a Gravatar lookup. Use when no gravatar identity is known. */
  humanPlaceholder?: boolean;
  /** Optional corner indicator. When present, the identity frame is rendered
   *  by raft-ui Avatar and the indicator is mounted through AvatarBadge so
   *  size and bottom-right placement stay canonical across call sites. */
  badge?: ReactElement;
  /** Trusted preview content can supply an uncommitted upload without replacing the themed frame. */
  children?: ReactNode;
  /** Additional classes — appended to the outer container. Useful for
   *  callsite-specific tweaks (e.g. `grayscale opacity-60` for deactivated
   *  agents). Do not use this to add a background color. */
  className?: string;
}

export function AvatarImageWithFallback({
  src,
  fallback,
  alt = "",
  className = "h-full w-full object-cover",
}: {
  src?: string | null;
  fallback: ReactNode;
  alt?: string;
  className?: string;
}) {
  return (
    <>
      {/* Positioned fallbacks paint above ordinary in-flow children. Give both
          layers an explicit stack order so a valid avatar always covers its
          placeholder; hiding the broken image reveals the fallback again. */}
      <span className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center">
        {fallback}
      </span>
      {src ? (
        <img
          key={src}
          src={src}
          alt={alt}
          className={`relative z-[1] ${className}`}
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      ) : null}
    </>
  );
}

export default function AvatarSlot({
  context,
  type,
  agentAvatarUrl,
  gravatarHash,
  humanAvatarUrl,
  serverAvatarUrl,
  serverInitial,
  appAvatarUrl,
  appInitials,
  email,
  humanPlaceholder,
  badge,
  children,
  className = "",
}: AvatarSlotProps) {
  const spec = SPEC[context];
  const raftSpec = RAFT_AVATAR_SPEC[context];
  let content: ReactNode;
  if (children !== undefined) {
    content = children;
  } else if (type === "agent") {
    content = <AgentAvatar avatarUrl={agentAvatarUrl ?? null} size={spec.agentPixel} className="!h-full !w-full" />;
  } else if (type === "server" || type === "app") {
    const initials = type === "server" ? serverInitial || "S" : appInitials || "A";
    const fallback = initials.trim().slice(0, type === "server" ? 1 : 2).toUpperCase() || (type === "server" ? "S" : "A");
    content = <AvatarImageWithFallback src={type === "server" ? serverAvatarUrl : appAvatarUrl} fallback={fallback} />;
  } else if (humanPlaceholder) {
    content = <User size={spec.placeholderIcon} />;
  } else {
    content = (
      <GravatarAvatar
        avatarUrl={humanAvatarUrl ?? null}
        gravatarHash={gravatarHash ?? null}
        email={email ?? undefined}
        size={spec.gravatarSize}
        iconSize={spec.gravatarIcon}
      />
    );
  }

  const identityClass = type === "server" || type === "app"
    ? `${spec.serverInitialText} font-display ${type === "app" ? "font-black" : "font-bold"} theme-brutal:bg-soft-signal theme-brutal:text-black`
    : "";
  return (
    <Avatar
      size={raftSpec.size}
      type={type === "agent" ? "agent" : "human"}
      className={`${raftSpec.className} ${identityClass} ${className}`.trim()}
      data-avatar-context={context}
      data-avatar-type={type}
    >
      {/* Keep the human placeholder's full circle perceptible beside filled
          agent artwork. Loaded images still cover this background. */}
      <AvatarFallback className={`relative overflow-hidden ${type === "human" ? "in-data-[theme=elegant]:bg-fill-strong" : ""}`}>
        {content}
      </AvatarFallback>
      {badge ? (
        <AvatarBadge render={<span />} className="flex rounded-full [&>span]:h-full [&>span]:w-full">
          {badge}
        </AvatarBadge>
      ) : null}
    </Avatar>
  );
}
