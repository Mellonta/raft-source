import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  rememberNonSearchLocation,
  resetRememberedNonSearchLocation,
  resolveSearchOverlayBackground,
} from "../src/components/search/searchOverlayLocation";

// Task #96 review counterexamples against real React Router composition. The
// location override lives INSIDE the /s/:slug/* child's Routes — exactly where
// MainLayout applies it — so a background from another server would throw
// React Router's "pathname must begin with parent route path" here too.
// 1. a remembered server-a location must never be presented under /s/b/search;
// 2. a server-home background (fallback OR remembered home) must not trigger the
//    DefaultRoute-like index redirect that rewrites the real /search URL.

afterEach(() => {
  cleanup();
  resetRememberedNonSearchLocation();
  delete (window as { raftDesktop?: unknown }).raftDesktop;
});

function DefaultLike() {
  const location = useLocation();
  const suppress = (location.state as { suppressDefaultRouteRedirect?: unknown } | null)?.suppressDefaultRouteRedirect === true;
  if (!suppress) return <Navigate to="channel/first" replace />;
  return <div data-testid="home-empty-state">home</div>;
}

function Probe() {
  const location = useLocation();
  return <output data-testid="real-location">{location.pathname}{location.search}</output>;
}

// Mirrors MainLayout: the /s/:slug/* element resolves the background and renders
// its nested <Routes location={bg ?? location}> plus the overlay marker.
function ServerShell() {
  const location = useLocation();
  const bg = resolveSearchOverlayBackground(location);
  return (
    <>
      <Routes location={bg ?? location}>
        <Route index element={<DefaultLike />} />
        <Route path="channel/:id" element={<div data-testid="channel-view">channel</div>} />
        <Route path="search" element={<div data-testid="full-page-search">full page</div>} />
      </Routes>
      {bg ? <div data-testid="overlay">overlay</div> : null}
    </>
  );
}

function App({ initial }: { initial: string }) {
  return (
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/s/:slug/*" element={<ServerShell />} />
      </Routes>
      <Probe />
    </MemoryRouter>
  );
}

test("desktop: /s/b/search with a remembered server-a location → overlay over b's home; the foreign pathname never reaches b's nested Routes", () => {
  (window as { raftDesktop?: unknown }).raftDesktop = { isDesktop: true };
  rememberNonSearchLocation({ pathname: "/s/a/channel/old", search: "" });
  render(<App initial="/s/b/search" />);
  assert.ok(screen.getByTestId("overlay"));
  assert.ok(screen.getByTestId("home-empty-state"));
  assert.equal(screen.queryByTestId("full-page-search"), null);
  assert.equal(screen.getByTestId("real-location").textContent, "/s/b/search");
});

test("desktop: remembered server home as the background does not redirect to the first channel (review reproduction)", () => {
  (window as { raftDesktop?: unknown }).raftDesktop = { isDesktop: true };
  rememberNonSearchLocation({ pathname: "/s/b", search: "" });
  render(<App initial="/s/b/search?q=x" />);
  assert.ok(screen.getByTestId("overlay"));
  assert.ok(screen.getByTestId("home-empty-state"));
  assert.equal(screen.queryByTestId("channel-view"), null);
  assert.equal(screen.getByTestId("real-location").textContent, "/s/b/search?q=x", "the real search URL is untouched");
});

test("desktop: a remembered trailing-slash home ('/s/b/') is normalized and does not redirect either (review P2)", () => {
  (window as { raftDesktop?: unknown }).raftDesktop = { isDesktop: true };
  rememberNonSearchLocation({ pathname: "/s/b/", search: "" });
  render(<App initial="/s/b/search?q=x" />);
  assert.ok(screen.getByTestId("overlay"));
  assert.ok(screen.getByTestId("home-empty-state"));
  assert.equal(screen.queryByTestId("channel-view"), null);
  assert.equal(screen.getByTestId("real-location").textContent, "/s/b/search?q=x");
});

test("desktop: cold /s/b/search with nothing remembered keeps the overlay with no redirect", () => {
  (window as { raftDesktop?: unknown }).raftDesktop = { isDesktop: true };
  render(<App initial="/s/b/search?q=x" />);
  assert.ok(screen.getByTestId("overlay"));
  assert.equal(screen.queryByTestId("channel-view"), null);
  assert.equal(screen.getByTestId("real-location").textContent, "/s/b/search?q=x");
});

test("desktop: a remembered channel on the same server is presented behind the overlay", () => {
  (window as { raftDesktop?: unknown }).raftDesktop = { isDesktop: true };
  rememberNonSearchLocation({ pathname: "/s/b/channel/c", search: "" });
  render(<App initial="/s/b/search" />);
  assert.ok(screen.getByTestId("overlay"));
  assert.ok(screen.getByTestId("channel-view"));
});

test("web: /s/b/search stays the full-page search (no overlay, no synthesized background)", () => {
  render(<App initial="/s/b/search" />);
  assert.equal(screen.queryByTestId("overlay"), null);
  assert.ok(screen.getByTestId("full-page-search"));
});

// Task #102: the overlay's "view all results" hop navigates to the SAME /search
// URL plus `?presentation=page`. Against real React Router composition that URL
// must render the nested full-page search route and no overlay — and must KEEP
// doing so after the page's own stateless `replace` rewrites (opening a preview
// writes `?open=…` with `navigate(..., { replace: true })` and no state — the
// PR #8012 review counterexample). A plain /search entry stays an overlay.
function PreviewOpener() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <button
      type="button"
      data-testid="open-preview"
      onClick={() => {
        // Mirrors MainLayout's searchContentStore → URL sync: rebuild from the
        // current URL, replace, NO state.
        const params = new URLSearchParams(location.search);
        params.set("open", "channel:c");
        params.set("msg", "m1");
        navigate({ pathname: location.pathname, search: `?${params.toString()}` }, { replace: true });
      }}
    >
      open preview
    </button>
  );
}

test("desktop: /s/b/search?presentation=page renders the full results page, not the overlay, and survives a stateless preview-open rewrite", () => {
  (window as { raftDesktop?: unknown }).raftDesktop = { isDesktop: true };
  rememberNonSearchLocation({ pathname: "/s/b/channel/c", search: "" });
  render(
    <MemoryRouter initialEntries={[{ pathname: "/s/b/search", search: "?q=kubernetes&presentation=page", state: { searchFrom: "/s/b/channel/c" } }]}>
      <Routes>
        <Route path="/s/:slug/*" element={<ServerShell />} />
      </Routes>
      <Probe />
      <PreviewOpener />
    </MemoryRouter>,
  );
  assert.ok(screen.getByTestId("full-page-search"), "the real /search route renders");
  assert.equal(screen.queryByTestId("overlay"), null, "no overlay is floated");
  assert.equal(screen.queryByTestId("channel-view"), null, "the remembered channel is not rendered behind");
  assert.equal(screen.getByTestId("real-location").textContent, "/s/b/search?q=kubernetes&presentation=page");

  fireEvent.click(screen.getByTestId("open-preview"));
  assert.equal(screen.getByTestId("real-location").textContent, "/s/b/search?q=kubernetes&presentation=page&open=channel%3Ac&msg=m1");
  assert.ok(screen.getByTestId("full-page-search"), "still the full page after the stateless replace");
  assert.equal(screen.queryByTestId("overlay"), null, "the overlay must not re-wrap the page on preview open");
});

test("desktop: without the marker the same URL is still the overlay (the invariant is untouched for every other entry)", () => {
  (window as { raftDesktop?: unknown }).raftDesktop = { isDesktop: true };
  rememberNonSearchLocation({ pathname: "/s/b/channel/c", search: "" });
  render(<App initial="/s/b/search?q=kubernetes" />);
  assert.ok(screen.getByTestId("overlay"));
  assert.ok(screen.getByTestId("channel-view"));
  assert.equal(screen.queryByTestId("full-page-search"), null);
});
