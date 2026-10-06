/**
 * jsdom has no layout, so every getBoundingClientRect() reports zero and the
 * component-owned fold in raft-ui can never measure an item body as
 * overflowing. Tests that need a folded card (and its footer entry) install
 * this stub: the item-content slots report the tall box a multi-line body
 * would have in a real browser; everything else keeps jsdom's zero rects.
 * Pair the install with the returned restore in afterEach so a failing test
 * cannot leak the stub into its neighbours.
 */
const CONTENT_SELECTOR = '[data-slot="message-forwarded-bundle-item-content"]';
const CONTENT_HEIGHT = 320;

const nativeGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

export function installForwardFoldMeasurementStub(): () => void {
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(
    this: HTMLElement,
  ): DOMRect {
    if (typeof this.matches === "function" && this.matches(CONTENT_SELECTOR)) {
      const rect = nativeGetBoundingClientRect.call(this);
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: CONTENT_HEIGHT,
        top: rect.top,
        right: rect.right,
        bottom: rect.top + CONTENT_HEIGHT,
        left: rect.left,
        toJSON: () => ({}),
      } as unknown as DOMRect;
    }
    return nativeGetBoundingClientRect.call(this);
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = nativeGetBoundingClientRect;
  };
}
