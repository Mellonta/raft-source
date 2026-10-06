export interface ServerSwitcherLayout {
  /** Hard cap so the menu is never taller than the window itself. */
  maxHeight: number;
  /** Pixels to shift the menu UP (via translateY(-shiftUp)) so it fits in view. */
  shiftUp: number;
}

/**
 * Keep the server-switcher menu fully inside the viewport, footer reachable.
 *
 * The menu opens `absolute top-1` from a trigger that can sit anywhere down the rail
 * (or, on mobile, the sidebar), so a long server list plus its pinned footer can run
 * past the bottom of the window. Rather than clamp the height to only the space BELOW
 * the trigger (which starves the footer when the trigger is low), cap the height to the
 * window and shift the menu UP by however much it would overflow — bounded so its top
 * never crosses the gutter. The list then scrolls internally and the footer stays
 * visible for any trigger position (task #83).
 *
 * Pure (no DOM) so the geometry is unit-testable. `menuTop` is the menu's ANCHORED top
 * (measured with no shift applied); `menuHeight` is its rendered height AFTER the caller
 * has applied `maxHeight` (so `min(menuHeight, maxHeight)` is the true on-screen height —
 * the min also guards a caller that measured before capping).
 */
export function computeServerSwitcherLayout(
  menuTop: number,
  menuHeight: number,
  viewportHeight: number,
  gutter = 8,
): ServerSwitcherLayout {
  const maxHeight = Math.max(0, viewportHeight - 2 * gutter);
  const effectiveHeight = Math.min(menuHeight, maxHeight);
  const overflowBelow = menuTop + effectiveHeight - (viewportHeight - gutter);
  const shiftUp = overflowBelow > 0
    ? Math.min(overflowBelow, Math.max(0, menuTop - gutter))
    : 0;
  return { maxHeight, shiftUp };
}
