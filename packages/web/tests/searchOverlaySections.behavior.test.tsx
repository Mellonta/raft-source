import assert from "node:assert/strict";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import { NavigationDepthTracker } from "../src/hooks/useAppNavigate";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import type { Server, ServerMember } from "../src/store/serverStore";

// Task #102 — desktop ⌘K overlay restructured on the Slack model:
//   [exact destination]  →  "Search for “q” / view all results ↵"  →  other
//   destinations  →  a short message preview.
// Return on the top row either enters the exact destination or hands the query
// and filters to the FULL results page (`?presentation=page`), where
// the list + col-3 context preview live. The full page itself (no overlay props)
// keeps its previous behaviour: no action row, full list, Load More.

const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}

const originalGet = api.get;

function installBrowserStubs() {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
}

function makeUser(): User {
  return {
    id: "user-1",
    email: "current@example.com",
    gravatarHash: "currenthash",
    name: "current",
    displayName: "Current User",
    description: null,
    avatarUrl: null,
    emailVerified: true,
    preferredLanguage: null,
    preferredTimezone: null,
    autoTranslationEnabled: false,
    preferredTimeFormat: null,
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
  };
}

function makeServer(): Server {
  return {
    id: "server-1",
    name: "Server",
    slug: "server",
    ownerId: "user-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role: "owner",
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeChannel(id: string, name: string): Channel {
  return {
    id,
    serverId: "server-1",
    name,
    description: null,
    type: "channel",
    createdAt: "2026-07-01T00:00:00.000Z",
    archivedAt: null,
    joined: true,
  };
}

function makeMessageHit(index: number) {
  return {
    id: `msg-${index}`,
    channelId: "channel-1",
    threadId: null,
    parentMessageId: null,
    parentMessageContent: null,
    parentChannelId: "channel-1",
    parentChannelName: "design",
    parentChannelType: "channel",
    parentChannelArchivedAt: null,
    senderId: "user-1",
    senderType: "user",
    senderName: "Current User",
    senderAvatarUrl: null,
    channelName: "design",
    channelType: "channel",
    channelArchivedAt: null,
    // No query token in the body: the hit highlighter would otherwise split the
    // text into <mark> fragments and defeat plain text matching.
    content: `note ${index}`,
    snippet: `note ${index}`,
    createdAt: `2026-07-0${index}T00:00:00.000Z`,
  };
}

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}{location.search}|{JSON.stringify(location.state ?? null)}
    </output>
  );
}

async function prepare() {
  installBrowserStubs();
  localStorage.setItem("slock_access_token", "token");
  const { default: MessageSearchPage } = await import("../src/components/search/MessageSearchPage");
  const { useAgentStore } = await import("../src/store/agentStore");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useChannelStore } = await import("../src/store/channelStore");
  const { useSearchContentStore } = await import("../src/store/searchContentStore");
  const { useServerStore } = await import("../src/store/serverStore");
  const { useThreadStore } = await import("../src/store/threadStore");
  useAuthStore.setState({ user: makeUser(), accessToken: "token", refreshToken: "refresh", loading: false, initialized: true });
  useServerStore.setState({ current: makeServer(), members: [] as ServerMember[] });
  useChannelStore.setState({
    channels: [makeChannel("channel-1", "design"), makeChannel("channel-2", "design-system")] as Channel[],
    dmChannels: [] as Channel[],
  });
  useAgentStore.setState({ agents: [], agentActivities: {} });
  useSearchContentStore.setState({ slot: null });
  useThreadStore.setState({ openParentMessageId: null, openThreadChannelId: null, openParentChannelId: null });
  return MessageSearchPage;
}

const overlayEntryState = {
  backgroundLocation: { pathname: "/s/server/channel/channel-1", search: "" },
  searchFrom: "/s/server/channel/channel-1",
};

async function renderSearch(search: string, mode: "overlay" | "page") {
  const MessageSearchPage = await prepare();
  const element = mode === "overlay" ? <MessageSearchPage activateResultsInChat overlayChrome /> : <MessageSearchPage />;
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/s/server/search", search, state: mode === "overlay" ? overlayEntryState : null }]}>
      <NavigationDepthTracker />
      <Routes>
        <Route path="/s/server/search" element={<>{element}<LocationProbe /></>} />
        <Route path="/s/server/channel/:channelId" element={<><div data-testid="channel-view">channel</div><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

function stubMessageSearch(total = 7) {
  api.get = (async () => ({
    data: { hasMore: true, results: Array.from({ length: total }, (_, i) => makeMessageHit(i + 1)) },
  })) as typeof api.get;
}

function readLocation() {
  const [url, state] = (screen.getByTestId("location").textContent ?? "").split("|");
  return { url, state: JSON.parse(state || "null") as Record<string, unknown> | null };
}

afterEach(() => {
  api.get = originalGet;
  cleanup();
});

test("overlay: no exact destination → the 'view all results' row is first and preselected; destinations and a capped message preview follow; no Load More", async () => {
  stubMessageSearch(7);
  await renderSearch("?q=desig", "overlay");

  const viewAll = await screen.findByTestId("search-view-all-results");
  assert.equal(viewAll.getAttribute("data-active"), "true", "top row is the default Return target");
  assert.match(viewAll.textContent ?? "", /Search for “desig”/);
  assert.equal(screen.getByTestId("search-overlay-head").querySelector("[data-testid^='search-channel-result-']"), null, "a prefix match is NOT hoisted above the action row");

  // Destinations still render below (both channels match the prefix).
  assert.ok(screen.getByTestId("search-channel-result-channel-1"));
  assert.ok(screen.getByTestId("search-channel-result-channel-2"));
  const head = screen.getByTestId("search-overlay-head");
  const firstChannelRow = screen.getByTestId("search-channel-result-channel-1");
  assert.ok(head.compareDocumentPosition(firstChannelRow) & Node.DOCUMENT_POSITION_FOLLOWING, "destinations come after the head");

  // Message preview: 5 of the 7 hits, no pager.
  await screen.findByText("note 5");
  assert.equal(screen.queryByText("note 6"), null, "overlay previews at most 5 message hits");
  assert.equal(screen.queryByText("Load More"), null, "paging belongs to the full results page");
});

test("overlay: Return on the 'view all results' row hands query + filters to the full results page (same URL + ?presentation=page, searchFrom kept in state)", async () => {
  stubMessageSearch(3);
  await renderSearch("?q=desig&range=7d&defer=1", "overlay");
  await screen.findByTestId("search-view-all-results");

  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

  await waitFor(() => {
    const { url, state } = readLocation();
    assert.equal(url, "/s/server/search?q=desig&range=7d&presentation=page", "query and filters carried, the overlay-only defer flag dropped, the page marker added");
    assert.deepEqual(state, { searchFrom: "/s/server/channel/channel-1" }, "only the back target rides in state");
  });
});

test("overlay: clicking the row does the same as Return", async () => {
  stubMessageSearch(3);
  await renderSearch("?q=desig", "overlay");
  fireEvent.click(await screen.findByTestId("search-view-all-results"));
  await waitFor(() => {
    assert.match(readLocation().url, /[?&]presentation=page(&|$)/);
  });
});

test("overlay: an exact destination is hoisted above the action row and preselected; Return enters it", async () => {
  stubMessageSearch(3);
  await renderSearch("?q=design", "overlay");

  const head = await screen.findByTestId("search-overlay-head");
  const exactRow = await screen.findByTestId("search-channel-result-channel-1");
  assert.ok(head.contains(exactRow), "the exact #design row lives in the head");
  const viewAll = screen.getByTestId("search-view-all-results");
  assert.ok(exactRow.compareDocumentPosition(viewAll) & Node.DOCUMENT_POSITION_FOLLOWING, "exact destination precedes the action row");
  assert.equal(exactRow.getAttribute("data-active"), "true", "Return would enter #design");
  assert.equal(viewAll.getAttribute("data-active"), null);
  assert.ok(!head.contains(screen.getByTestId("search-channel-result-channel-2")), "the fuzzy #design-system match stays in the destinations section");

  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => {
    assert.ok(screen.getByTestId("channel-view"));
    assert.match(readLocation().url, /^\/s\/server\/channel\/channel-1/);
  });
});

test("overlay: the cursor follows the keyboard, then returns to the top row when the query changes (palette behaviour)", async () => {
  stubMessageSearch(3);
  await renderSearch("?q=design", "overlay");
  const input = screen.getByRole("textbox");
  const exactRow = await screen.findByTestId("search-channel-result-channel-1");
  assert.equal(exactRow.getAttribute("data-active"), "true");

  fireEvent.keyDown(input, { key: "ArrowDown" });
  assert.equal(screen.getByTestId("search-view-all-results").getAttribute("data-active"), "true", "ArrowDown moves onto the action row");

  // Typing one more character removes the exact match: the top row is now the
  // action row and it must be the selection again — not a stale survivor index.
  act(() => {
    fireEvent.change(input, { target: { value: "design!" } });
  });
  await waitFor(() => {
    const viewAll = screen.getByTestId("search-view-all-results");
    assert.match(viewAll.textContent ?? "", /design!/);
    assert.equal(viewAll.getAttribute("data-active"), "true");
  });

  // And back to an exact query: the exact destination is first and selected again.
  act(() => {
    fireEvent.change(input, { target: { value: "design" } });
  });
  await waitFor(() => {
    assert.equal(screen.getByTestId("search-channel-result-channel-1").getAttribute("data-active"), "true");
  });
});

test("full page (no overlay props): unchanged — no action row, full list with Load More, count eyebrow", async () => {
  stubMessageSearch(7);
  await renderSearch("?q=design", "page");
  await screen.findByText("note 7");
  assert.equal(screen.queryByTestId("search-view-all-results"), null);
  assert.equal(screen.queryByTestId("search-overlay-head"), null);
  assert.ok(screen.getByText("Load More"));
  assert.ok(screen.getByText("9 results"), "2 destinations + 7 hits");
});
