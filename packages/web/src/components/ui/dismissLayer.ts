/**
 * Marker for every surface that dismisses on an outside press: modal and menu
 * backdrops, floating menus / popovers / pickers that close from their own
 * document mousedown / pointerdown listener, lightboxes.
 *
 * Why a marker: hosts that own native chrome cannot infer "a click outside this
 * element closes it" from the DOM. The Raft desktop shell is a frameless
 * window whose title bar is a native drag region — Chromium hands mouse-downs
 * there to the window manager before the page sees them, so an open layer can
 * never be dismissed by clicking the bar. The shell keys off this attribute to
 * suspend the drag region while any such layer is open (task #121).
 *
 * Contract: put it on the element that exists ONLY while the layer is open (the
 * popup / backdrop itself), never on an always-mounted container, and only for
 * layers an outside press actually closes — a hover card that merely hides on
 * mouse-out must not carry it. `tests/dismissLayerContract.test.ts` checks that
 * every outside-press listener lives in a file that declares the marker.
 */
export const DISMISS_LAYER_ATTR = "data-dismiss-layer";

/** Spread onto the layer element: `<div {...dismissLayerProps}>`. */
export const dismissLayerProps = { [DISMISS_LAYER_ATTR]: "" } as const;

/**
 * Explicit opt-OUT for a surface that looks like a layer to a host's generic
 * fallbacks (e.g. it carries role="dialog") but does NOT dismiss on an outside
 * press right now — a hover / focus-opened card that closes on mouse-out. The
 * value "false" wins over any role-based inference, on the element and its
 * subtree. Prefer this over removing the role: the role is the accessibility
 * contract, the marker is the interaction contract.
 */
export const notDismissLayerProps = { [DISMISS_LAYER_ATTR]: "false" } as const;

/** True when `el` (or an ancestor) opts out via `data-dismiss-layer="false"`. */
export function isDismissLayerExempt(el: Element): boolean {
  return el.closest(`[${DISMISS_LAYER_ATTR}="false"]`) !== null;
}
