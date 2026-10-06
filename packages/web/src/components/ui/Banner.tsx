import { AlertTriangle, CircleAlert, Info, CheckCircle2 } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import {
  Banner,
  BannerAction,
  BannerDescription,
  BannerTitle,
} from "raft-ui";

/**
 * Thin product adapter over the public RUI Banner composition. RUI owns the
 * visual recipe and status semantics while callers provide product content.
 */

export type BannerIntent = "destructive" | "warning" | "info" | "success";
export type BannerDensity = "sm" | "md" | "lg";

// Default icon per intent. NOT auto-rendered — the dominant
// inline pattern is iconless, so we render an icon only when the
// caller explicitly passes one. To get the conventional intent
// icon, callers can either pass `withIcon` (boolean) or any
// ReactNode via `icon`. The map exists so `withIcon` has a
// predictable lookup.
const INTENT_DEFAULT_ICON: Record<BannerIntent, ReactNode> = {
  destructive: <AlertTriangle size={18} />,
  warning: <CircleAlert size={18} />,
  info: <Info size={18} />,
  success: <CheckCircle2 size={18} />,
};

export interface BannerProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** Semantic status forwarded to the RUI recipe. */
  intent: BannerIntent;
  /** Density forwarded to the RUI size register. */
  density?: BannerDensity;
  /** Optional bold heading rendered above the body. */
  title?: ReactNode;
  /** Banner body. Most callsites pass a `<p>`-worthy string but any
   *  ReactNode (links, button rows) is fine. */
  children?: ReactNode;
  /** Convenience flag — render the conventional intent icon
   *  (AlertTriangle / CircleAlert / Info / CheckCircle2). When
   *  `false` (default), banner renders without an icon — matching
   *  the dominant inline pattern. */
  withIcon?: boolean;
  /** Override the icon entirely with a custom node. Takes
   *  precedence over `withIcon`. Useful for waiting indicators
   *  (pulsing dot) or task-specific icons. */
  icon?: ReactNode;
  /** Optional right-aligned action slot (e.g. a button or link). */
  actions?: ReactNode;
}

export default function AppBanner({
  intent,
  density = "md",
  title,
  children,
  icon,
  withIcon = false,
  actions,
  className = "",
  ...rest
}: BannerProps) {
  const resolvedIcon = icon !== undefined ? icon : (withIcon ? INTENT_DEFAULT_ICON[intent] : null);
  return (
    <Banner {...rest} status={intent} size={density} className={className}>
      {resolvedIcon}
      {title ? <BannerTitle>{title}</BannerTitle> : null}
      {children ? <BannerDescription>{children}</BannerDescription> : null}
      {actions ? <BannerAction>{actions}</BannerAction> : null}
    </Banner>
  );
}
