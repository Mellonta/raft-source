import { Card } from "raft-ui";
import type { ReactNode } from "react";

/**
 * Canonical "subtle preview surface" skin (route B, locked by stdrc 2026-05-16
 * #proj-theme:441c8b2b: 1px black/15 border, white bg, no shadow, hover deepens
 * border + adds a faint bg). This is the ONE place the preview-card skin lives
 * — both `<QuotedMessageCard>` and `<AttachmentChip>` route their outer wrapper
 * through `<PreviewShell>` so hover state stays aligned across surfaces
 * (stdrc 2026-05-22 #proj-theme:441c8b2b 7d19c377 / 4365db5a — direct
 * component reuse, not just a shared border fragment).
 *
 * No `active:` token: the press state inherits the hover styling (`:hover`
 * keeps matching while `:active` is true). This matches QuotedMessageCard's
 * pre-refactor hover-only behavior (stdrc 2026-05-23 #proj-theme:441c8b2b
 * cfd10230: "复用之前的 Quoted Message Card 的 active 和 hover 的颜色") and
 * sidesteps a Chromium compositing edge case where
 * `color-mix(in oklab, X, transparent)` × element `opacity` paints cyan
 * instead of pale yellow.
 *
 * Layout is caller-supplied via `className`: PreviewShell only owns the
 * polymorphic root + skin tokens. QuotedMessageCard passes `group w-full
 * text-left` for the block-preview case; AttachmentChip passes its
 * fixed-size `inline-flex h-20 w-44 …` layout.
 */

/** Static border recipe only — exported for any future surface that wants
 *  the border tokens without the full bg + hover-bg skin. */
export const PREVIEW_SHELL_BORDER = "border border-line-muted hover:border-line-strong theme-brutal:border-black/15 theme-brutal:hover:border-black/30";

/** Full default skin: border + white bg + faint hover bg + explicitly NO
 *  shadow. `shadow-none` is load-bearing: RUI Card's brutal default carries
 *  `shadow-raft-md`, which would leak the hard offset shadow onto every
 *  PreviewShell surface (message-link cards included) without this neutralizer.
 *  No `active:` token — press inherits hover. */
export const PREVIEW_SHELL_SKIN = `${PREVIEW_SHELL_BORDER} bg-layer-panel hover:bg-fill-muted theme-brutal:bg-white theme-brutal:hover:bg-black/5 shadow-none`;

/** Muted / unavailable variant — visually unchanged from the prior
 *  QuotedMessageCard `unavailable` skin (kept distinct per stdrc: error
 *  semantic is separate from the route-B default). */
export const PREVIEW_SHELL_SKIN_MUTED =
  "border border-line-muted bg-fill-muted italic text-foreground-placeholder hover:shadow-raft-sm theme-brutal:border-2 theme-brutal:border-black/30 theme-brutal:bg-black/5 theme-brutal:text-black/40 theme-brutal:hover:shadow-brutal-sm";

export type PreviewShellVariant = "default" | "muted";

export interface PreviewShellProps {
  variant?: PreviewShellVariant;
  /** Click → renders a polymorphic <button>; otherwise a <div>. */
  onClick?: () => void;
  /** Layout + any per-callsite overrides. Appended AFTER the skin so callers
   *  can override individual tokens via Tailwind's `!` important modifier
   *  (e.g. AttachmentChip's `!bg-soft-signal/30` loading state). */
  className?: string;
  "data-testid"?: string;
  title?: string;
  "aria-busy"?: "true" | "false";
  children: ReactNode;
}

/**
 * Polymorphic root + skin for the canonical preview surface. Layout is
 * caller-owned (passed via `className`).
 */
export default function PreviewShell({
  variant = "default",
  onClick,
  className,
  children,
  ...rest
}: PreviewShellProps) {
  const Root = onClick ? "button" : "div";
  const skin = variant === "muted" ? PREVIEW_SHELL_SKIN_MUTED : PREVIEW_SHELL_SKIN;
  return (
    <Card
      render={<Root />}
      {...(onClick ? { type: "button" as const, onClick } : {})}
      {...rest}
      className={`${skin}${className ? ` ${className}` : ""}`}
    >
      {children}
    </Card>
  );
}
