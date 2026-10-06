import assert from "node:assert/strict";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SearchOverlay from "../src/components/search/SearchOverlay";
import { DESKTOP_SEARCH_ANCHOR_VARS, SEARCH_OVERLAY_FALLBACK_TOP, searchOverlayCardStyle } from "../src/components/search/searchOverlayAnchor";
import { TestIntlProvider } from "./helpers/intl";
import { useServerStore } from "../src/store/serverStore";

const originalServerState = useServerStore.getState();

afterEach(() => {
  cleanup();
  useServerStore.setState(originalServerState, true);
});

function mount(onClose: () => void) {
  useServerStore.setState({ current: { id: "srv-1", slug: "x", name: "X" } as never });
  return render(
    <MemoryRouter initialEntries={["/s/x/search"]}>
      <TestIntlProvider>
        <SearchOverlay onClose={onClose} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

test("SearchOverlay renders the search over a backdrop and hosts the search input", () => {
  const view = mount(() => {});
  // Modal portals to document.body, so query the card via getByTestId (document-wide).
  const card = view.getByTestId("desktop-search-overlay");
  assert.ok(card, "overlay card renders");
  // The hosted MessageSearchPage input is present (this IS the real search).
  assert.ok(card.querySelector("input"), "search input is hosted in the overlay");
});

test("Escape closes the overlay", () => {
  let closed = 0;
  mount(() => { closed += 1; });
  fireEvent.keyDown(document, { key: "Escape" });
  assert.equal(closed, 1);
});

test("Escape does NOT close when the search already handled it (filter menu) or during IME composition", () => {
  let closed = 0;
  mount(() => { closed += 1; });

  // A filter menu inside the search consumes Escape and preventDefaults it — the
  // overlay must stay open (only the menu closes).
  const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  handled.preventDefault();
  document.dispatchEvent(handled);
  assert.equal(closed, 0, "a preventDefaulted Escape must not dismiss the overlay");

  // IME composition Escape must never dismiss.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true }));
  assert.equal(closed, 0, "an IME-composition Escape must not dismiss");

  // A plain, unhandled Escape still closes.
  fireEvent.keyDown(document, { key: "Escape" });
  assert.equal(closed, 1);
});

test("a backdrop click closes the overlay, but a click inside the card does not", () => {
  let closed = 0;
  const view = mount(() => { closed += 1; });
  const card = view.getByTestId("desktop-search-overlay");
  // Modal closes on a backdrop click (target === currentTarget). The card's parent
  // is the centering backdrop div that carries Modal's close handler.
  const backdrop = card.parentElement as HTMLElement;

  fireEvent.click(card);
  assert.equal(closed, 0, "clicking inside the search card must not dismiss");

  fireEvent.click(backdrop);
  assert.equal(closed, 1, "clicking the backdrop dismisses");
});

// WAWQAQ 2026-09-24: the panel must hang off the top-bar search field like Slack's,
// not float mid-screen with a second input. The desktop shell publishes the
// field geometry as CSS variables; the card is fixed to them with a centred
// fallback (web / older shell), so one style serves both.
test("the overlay card is anchored to the desktop search field via CSS variables, with the centred fallback baked in", () => {
  // The style object is the contract (jsdom's CSS engine strips min()/calc()
  // values before they reach the DOM, so the size rules are asserted here).
  const style = searchOverlayCardStyle();
  assert.equal(style.position, "fixed");
  assert.equal(style.top, `var(${DESKTOP_SEARCH_ANCHOR_VARS.top}, ${SEARCH_OVERLAY_FALLBACK_TOP})`);
  assert.equal(style.left, `var(${DESKTOP_SEARCH_ANCHOR_VARS.centerX}, 50%)`);
  assert.equal(style.transform, "translateX(-50%)");
  assert.equal(style.width, `max(var(${DESKTOP_SEARCH_ANCHOR_VARS.width}, 0px), min(720px, 92vw))`);
  assert.equal(style.height, `min(min(680px, 80vh), calc(100vh - var(${DESKTOP_SEARCH_ANCHOR_VARS.top}, ${SEARCH_OVERLAY_FALLBACK_TOP}) - 24px))`);

  // And the rendered card carries it (the parts jsdom keeps) with no leftover
  // flow placement fighting the fixed anchor.
  const view = mount(() => {});
  const card = view.getByTestId("desktop-search-overlay") as HTMLElement;
  const attr = card.getAttribute("style") ?? "";
  assert.match(attr, /position:\s*fixed/);
  // The old placement: centred while the card fits, else pinned at 8vh + 16px.
  assert.equal(SEARCH_OVERLAY_FALLBACK_TOP, "max(calc(8vh + 16px), calc((100vh - min(680px, 80vh)) / 2))");
  assert.match(attr, /left:\s*var\(--desktop-search-anchor-center-x, 50%\)/);
  assert.doesNotMatch(card.className, /my-\[8vh\]|self-start/);
});

test("the overlay backdrop is transparent: no dim, no blur behind the palette (Slack), click-outside still closes", () => {
  let closed = 0;
  const view = mount(() => { closed += 1; });
  const card = view.getByTestId("desktop-search-overlay") as HTMLElement;
  const backdrop = card.closest(".fixed.inset-0") as HTMLElement | null;
  assert.ok(backdrop, "modal root present");
  assert.doesNotMatch(backdrop.className, /backdrop-blur|bg-layer-backdrop|bg-black\/60/);
  assert.match(backdrop.className, /bg-transparent/);
  const clickLayer = backdrop.firstElementChild as HTMLElement;
  clickLayer.click();
  assert.equal(closed, 1, "clicking outside the card still dismisses");
});

test("the overlay's modal root carries the dismiss-layer marker hosts key off (task #121)", () => {
  const view = mount(() => {});
  const card = view.getByTestId("desktop-search-overlay") as HTMLElement;
  const backdrop = card.closest('[data-slot="modal-backdrop"]');
  assert.ok(backdrop, "Modal root is marked data-slot=modal-backdrop");
  assert.ok(backdrop!.hasAttribute("data-dismiss-layer"), "and carries the shared dismiss-layer marker");
});

test("the overlay card is raft-ui's popover surface, not the legacy card-brutal utility (Elegant corners come from the theme family)", () => {
  const view = mount(() => {});
  const card = view.getByTestId("desktop-search-overlay") as HTMLElement;
  assert.equal(card.dataset.slot, "popover-content", "surface = PopoverPopup");
  assert.ok(!card.classList.contains("card-brutal"), "no hand-rolled card-brutal surface");
  assert.ok(!card.classList.contains("bg-white"), "no forced white background (Elegant Dark)");
  const footer = view.getByTestId("desktop-search-overlay-footer");
  assert.ok(![...footer.classList].some((c) => /bg-/.test(c)), "footer inherits the surface background");
});
