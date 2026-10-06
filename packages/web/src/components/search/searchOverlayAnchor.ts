import type { CSSProperties } from "react";

/**
 * Desktop search-overlay anchor contract (WAWQAQ, 2026-09-24: "Slack 的锚点是挂
 * 在上面的搜索框那里"). In Slack the search panel grows out of the top search
 * field: the panel's top edge sits on the field's top edge, the panel is centred
 * on the field, and the panel header IS the input. The desktop shell owns the top
 * bar (raft-desktop DesktopTopBar), so it publishes the field's geometry as CSS
 * custom properties on <html>; the overlay consumes them here. Anything without
 * the variables — the web app, an older desktop shell — falls back to the
 * previous centred placement, so this is a pure CSS contract with no gating.
 */
export const DESKTOP_SEARCH_ANCHOR_VARS = {
  /** px from the viewport top to the search field's top edge */
  top: "--desktop-search-anchor-top",
  /** px from the viewport left to the search field's horizontal centre */
  centerX: "--desktop-search-anchor-center-x",
  /** px width of the search field (informational; the panel keeps a readable minimum) */
  width: "--desktop-search-anchor-width",
} as const;

// Fallback = the pre-anchor placement EXACTLY (Web / shells that publish no
// anchor must not move). The old card sat in Modal's `p-4` container with
// `my-[8vh] self-start` inside an `m-auto` wrapper and `h-[min(680px,80vh)]`:
// vertically centred while card + 16vh margins fit the viewport, otherwise
// pinned at 16px + 8vh. That is max(8vh + 16px, (100vh - H) / 2) with the old
// height H = min(680px, 80vh). (Checked: 1000px window → 160px both ways,
// 800px → 80px, 700px → 72px.)
export const SEARCH_OVERLAY_FALLBACK_HEIGHT = "min(680px, 80vh)";
export const SEARCH_OVERLAY_FALLBACK_TOP = `max(calc(8vh + 16px), calc((100vh - ${SEARCH_OVERLAY_FALLBACK_HEIGHT}) / 2))`;

/**
 * Inline style for the overlay card. Fixed to the anchor: top on the field's top
 * edge, horizontally centred on the field, width the same readable panel width
 * as before, height bounded by the space below the anchor. The `var()` fallbacks
 * reproduce the old centred card (see SEARCH_OVERLAY_FALLBACK_TOP).
 */
export function searchOverlayCardStyle(): CSSProperties {
  const top = `var(${DESKTOP_SEARCH_ANCHOR_VARS.top}, ${SEARCH_OVERLAY_FALLBACK_TOP})`;
  return {
    position: "fixed",
    top,
    left: `var(${DESKTOP_SEARCH_ANCHOR_VARS.centerX}, 50%)`,
    transform: "translateX(-50%)",
    // As wide as the anchor field when the shell publishes one (the panel reads
    // as the field expanding, Slack), never narrower than the readable minimum.
    width: `max(var(${DESKTOP_SEARCH_ANCHOR_VARS.width}, 0px), min(720px, 92vw))`,
    // Fallback height = the old cap (the calc() term never bites with the
    // fallback top); it only bites when an anchored top would push the card
    // past the window bottom.
    height: `min(${SEARCH_OVERLAY_FALLBACK_HEIGHT}, calc(100vh - ${top} - 24px))`,
  };
}
