import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, render, screen } from "@testing-library/react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { __testInternals } from "../src/components/layout/MainLayout";
import { resolveSearchOverlayBackground } from "../src/components/search/searchOverlayLocation";
import { useSearchContentStore } from "../src/store/searchContentStore";
import { useServerStore } from "../src/store/serverStore";

// PR #8012 review P1 (task #102): on the desktop full results page, opening a
// preview must NOT bounce the page back into the overlay. MainLayout's REAL
// searchContentStore → URL sync (`useSearchContentUrlSync`) rewrites the URL with
// `navigate(..., { replace: true })` and no history state — which is exactly why
// the page marker rides in the URL (`?presentation=page`) rather than in state.
// BrowserRouter because the hook reads `window.location.*` on purpose (see its
// comment about concurrent subscribers).

const { useSearchContentUrlSync } = __testInternals;
const originalServerState = useServerStore.getState();

function Shell() {
  useSearchContentUrlSync();
  const location = useLocation();
  const bg = resolveSearchOverlayBackground(location);
  return (
    <>
      <Routes location={bg ?? location}>
        <Route path="/s/:slug/search" element={<div data-testid="full-page-search">full page</div>} />
        <Route path="/s/:slug/channel/:id" element={<div data-testid="channel-view">channel</div>} />
        <Route path="/s/:slug" element={<div data-testid="home">home</div>} />
      </Routes>
      {bg ? <div data-testid="overlay">overlay</div> : null}
      <output data-testid="real-location">{location.pathname}{location.search}</output>
    </>
  );
}

beforeEach(() => {
  (window as { raftDesktop?: unknown }).raftDesktop = { isDesktop: true };
  useServerStore.setState({ current: { id: "srv-b", slug: "b", name: "B" } as never });
  useSearchContentStore.setState({ slot: null });
});

afterEach(() => {
  cleanup();
  useSearchContentStore.setState({ slot: null });
  useServerStore.setState(originalServerState, true);
  delete (window as { raftDesktop?: unknown }).raftDesktop;
  window.history.replaceState(null, "", "/");
});

test("desktop full results page: opening a col-3 preview (store → URL sync, stateless replace) keeps the full page — no overlay bounce", async () => {
  // React Router keeps location.state under history.state.usr.
  window.history.replaceState({ usr: { searchFrom: "/s/b/channel/c" } }, "", "/s/b/search?q=kubernetes&presentation=page");
  render(
    <BrowserRouter>
      <Shell />
    </BrowserRouter>,
  );
  assert.ok(screen.getByTestId("full-page-search"));
  assert.equal(screen.queryByTestId("overlay"), null);

  // The user clicks a message hit: the page opens it in col 3 via the store; the
  // real sync subscriber rewrites the URL.
  await act(async () => {
    useSearchContentStore.getState().open({ kind: "channel", id: "c", messageId: "m1" });
  });
  const url = screen.getByTestId("real-location").textContent ?? "";
  assert.match(url, /^\/s\/b\/search\?/);
  assert.match(url, /(^|[?&])open=channel%3Ac(&|$)/, "preview slot written to the URL");
  assert.match(url, /(^|[?&])msg=m1(&|$)/);
  assert.match(url, /(^|[?&])presentation=page(&|$)/, "the page marker survived the stateless rewrite");
  assert.equal((window.history.state as { usr?: unknown } | null)?.usr ?? null, null, "history state is indeed gone after the sync's replace — the marker cannot live there");
  assert.ok(screen.getByTestId("full-page-search"), "still the full page");
  assert.equal(screen.queryByTestId("overlay"), null, "the overlay must not re-wrap the page on preview open");

  // Closing the preview rewrites again (drops open/msg) — still the page.
  await act(async () => {
    useSearchContentStore.getState().close();
  });
  const after = screen.getByTestId("real-location").textContent ?? "";
  assert.doesNotMatch(after, /[?&]open=/);
  assert.match(after, /(^|[?&])presentation=page(&|$)/);
  assert.ok(screen.getByTestId("full-page-search"));
  assert.equal(screen.queryByTestId("overlay"), null);
});

test("desktop overlay (no marker): the sync stays isolated — opening a slot neither rewrites the overlay URL nor changes presentation", async () => {
  window.history.replaceState({ usr: { backgroundLocation: { pathname: "/s/b/channel/c", search: "" } } }, "", "/s/b/search?q=kubernetes");
  render(
    <BrowserRouter>
      <Shell />
    </BrowserRouter>,
  );
  assert.ok(screen.getByTestId("overlay"));
  assert.ok(screen.getByTestId("channel-view"));
  await act(async () => {
    useSearchContentStore.getState().open({ kind: "channel", id: "c", messageId: "m1" });
  });
  assert.equal(screen.getByTestId("real-location").textContent, "/s/b/search?q=kubernetes", "overlay URL untouched (pre-existing #96 isolation)");
  assert.ok(screen.getByTestId("overlay"));
});
