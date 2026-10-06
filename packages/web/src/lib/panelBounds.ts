/**
 * Single source of truth for side-panel resize bounds.
 *
 * These numbers were duplicated: the signed-in shell (MainLayout) and the public server page each declared their own,
 * and they had silently drifted apart — the public page allowed wider sidebars and a narrower thread panel, so the
 * same control behaved differently depending on whether you were signed in (cindyz, 2026-09-21: "这个为什么会不一样啊").
 * Importing from here makes the alignment structural rather than a coincidence two files have to keep re-agreeing on.
 */

/** Left sidebar / rail-adjacent columns. */
export const SIDEBAR_PANEL_BOUNDS = { min: 180, max: 320, defaultWidth: 240 } as const;

/** Thread side column. Its max is viewport-derived, so it is a function rather than a constant. */
export const THREAD_PANEL_MIN_WIDTH = 360;
export const THREAD_PANEL_DEFAULT_WIDTH = 400;

/**
 * Widest the thread column may be dragged: 60% of the viewport, never below the default. Recomputed at drag start
 * rather than on every window resize, so an ordinary browser resize stays CSS-only.
 */
export function getThreadPanelDynamicMax(): number {
  return typeof window !== "undefined" ? Math.max(400, Math.floor(window.innerWidth * 0.6)) : 400;
}
