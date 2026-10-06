import assert from "node:assert/strict";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import { NavigationDepthTracker } from "../src/hooks/useAppNavigate";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import type { Server, ServerMember } from "../src/store/serverStore";

// Task #113 (Slack ⌘K): with nothing typed, the desktop overlay lists the
// conversations the user was in most recently — visit order first, activity
// fill after — as keyboard-navigable destination rows with the first row
// preselected; filters and the full page's history/frequent sections stay out
// of the palette until there is a query. The full page is untouched.

const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}

const originalGet = api.get;

function makeUser(): User {
  return {
    id: "user-1", email: "current@example.com", gravatarHash: "h", name: "current", displayName: "Current User",
    description: null, avatarUrl: null, emailVerified: true, preferredLanguage: null, preferredTimezone: null,
    autoTranslationEnabled: false, preferredTimeFormat: null, preferredMessageBodyFontSize: null,
    referralSource: null, referralSourceOther: null, referralSourceSkippedAt: null,
  };
}

function makeServer(): Server {
  return {
    id: "server-1", name: "Server", slug: "server", ownerId: "user-1", onboardingAgentId: null,
    hideHumansFromMembers: false, plan: "free", planDowngradedAt: null, role: "owner", createdAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeChannel(id: string, name: string, archivedAt: string | null = null): Channel {
  return { id, serverId: "server-1", name, description: null, type: "channel", createdAt: "2026-07-01T00:00:00.000Z", archivedAt, joined: true };
}

function makeAgentDm(): Channel {
  return {
    id: "dm-agent-1", serverId: "server-1", name: "dm", description: null, type: "dm", createdAt: "2026-07-01T00:00:00.000Z",
    archivedAt: null, joined: true, peerType: "agent", peerId: "agent-1", peerName: "Helper", peerAvatarUrl: null,
  } as Channel;
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

let stores: {
  useRecentConversationStore: typeof import("../src/store/recentConversationStore").useRecentConversationStore;
  useSearchContentStore: typeof import("../src/store/searchContentStore").useSearchContentStore;
} | null = null;

async function prepare(options: { visits?: string[]; activity?: Record<string, string> } = {}) {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
  storage.setItem("slock_access_token", "token");
  const { default: MessageSearchPage } = await import("../src/components/search/MessageSearchPage");
  const { useAgentStore } = await import("../src/store/agentStore");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useChannelStore } = await import("../src/store/channelStore");
  const { useMachineStore } = await import("../src/store/machineStore");
  const { useRecentConversationStore } = await import("../src/store/recentConversationStore");
  const { useSearchContentStore } = await import("../src/store/searchContentStore");
  const { useServerStore } = await import("../src/store/serverStore");
  const { useThreadStore } = await import("../src/store/threadStore");
  useAuthStore.setState({ user: makeUser(), accessToken: "token", refreshToken: "refresh", loading: false, initialized: true });
  useServerStore.setState({ current: makeServer(), members: [] as ServerMember[] });
  useChannelStore.setState({
    channels: [makeChannel("channel-1", "design"), makeChannel("channel-2", "design-system"), makeChannel("channel-3", "random"), makeChannel("channel-4", "old", "2026-08-01T00:00:00.000Z")],
    dmChannels: [makeAgentDm()],
    channelActivity: options.activity ?? {},
  });
  useAgentStore.setState({
    agents: [{ id: "agent-1", name: "helper", displayName: "Helper", description: null, avatarUrl: null, deletedAt: null } as never],
    agentActivities: {},
  });
  useMachineStore.setState({ machines: [] });
  useSearchContentStore.setState({ slot: null });
  useThreadStore.setState({ openParentMessageId: null, openThreadChannelId: null, openParentChannelId: null });
  useRecentConversationStore.setState({
    scopes: options.visits ? { "server-1:user-1": { channelIds: options.visits, lastTouchedAt: 1 } } : {},
  });
  stores = { useRecentConversationStore, useSearchContentStore };
  return MessageSearchPage;
}

const overlayEntryState = {
  backgroundLocation: { pathname: "/s/server/channel/channel-1", search: "" },
  searchFrom: "/s/server/channel/channel-1",
};

async function renderSearch(
  search: string,
  mode: "overlay" | "page",
  options: { visits?: string[]; activity?: Record<string, string>; entryState?: Record<string, unknown> | null } = {},
) {
  const MessageSearchPage = await prepare(options);
  // The overlay only exists in the desktop shell; the background location (the
  // conversation the overlay floats over) is read behind that same gate.
  if (mode === "overlay") (window as { raftDesktop?: unknown }).raftDesktop = { isDesktop: true };
  const element = mode === "overlay" ? <MessageSearchPage activateResultsInChat overlayChrome /> : <MessageSearchPage />;
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/s/server/search", search, state: mode === "overlay" ? (options.entryState === undefined ? overlayEntryState : options.entryState) : null }]}>
      <NavigationDepthTracker />
      <Routes>
        <Route path="/s/server/search" element={<>{element}<LocationProbe /></>} />
        <Route path="/s/server/channel/:channelId" element={<><div data-testid="channel-view">channel</div><LocationProbe /></>} />
        <Route path="/s/server/dm/:dmId" element={<><div data-testid="dm-view">dm</div><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(async () => {
  api.get = originalGet;
  stores?.useRecentConversationStore.setState({ scopes: {} });
  delete (window as { raftDesktop?: unknown }).raftDesktop;
  const { resetRememberedNonSearchLocation } = await import("../src/components/search/searchOverlayLocation");
  resetRememberedNonSearchLocation();
  cleanup();
});

/** The row wrapper carries the testid; the activation target is its button. */
function rowButton(testId: string): HTMLElement {
  const button = screen.getByTestId(testId).querySelector("button");
  assert.ok(button, `${testId} has a button`);
  return button;
}

const noMessages = () => { api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get; };

test("overlay empty state: recent conversations — visits first (most recent first), activity fill after, current + archived excluded; first row preselected with the Return hint; no filters, no history/frequent", async () => {
  noMessages();
  await renderSearch("", "overlay", {
    visits: ["channel-1", "channel-3", "channel-2"],
    activity: { "dm-agent-1": "2026-09-20T00:00:00.000Z", "channel-4": "2026-09-21T00:00:00.000Z" },
  });

  const section = await screen.findByTestId("search-overlay-recent");
  assert.match(section.textContent ?? "", /Recent conversations/);
  const rows = Array.from(section.querySelectorAll("[data-testid^='search-channel-result-']")).map((row) => row.getAttribute("data-testid"));
  assert.deepEqual(rows, ["search-channel-result-channel-3", "search-channel-result-channel-2"], "visit order, the conversation behind the overlay (channel-1) left out");
  assert.match(section.textContent ?? "", /Helper/, "the agent DM fills from activity after the visited rows");
  assert.ok(screen.queryByText("old") === null, "archived channels never count as recent");

  const first = screen.getByTestId("search-channel-result-channel-3");
  assert.equal(first.getAttribute("data-active"), "true", "Return would open the most recent conversation");
  assert.match(first.textContent ?? "", /↵/, "the active row shows the Return hint");
  assert.equal(screen.getByTestId("search-channel-result-channel-2").getAttribute("data-active"), null);

  assert.ok(screen.queryByText("From") === null, "filters wait for a query in the palette");
  assert.ok(screen.queryByText("Search History") === null);
  assert.ok(screen.queryByText("Frequently Used") === null);
  assert.equal((screen.getByRole("textbox") as HTMLInputElement).placeholder, "Channels, people, messages…");
});

test("overlay empty state: ↓ moves the cursor, Return opens the selected conversation in chat", async () => {
  noMessages();
  await renderSearch("", "overlay", { visits: ["channel-3", "channel-2"] });
  await screen.findByTestId("search-overlay-recent");

  const input = screen.getByRole("textbox");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  await waitFor(() => {
    assert.equal(screen.getByTestId("search-channel-result-channel-2").getAttribute("data-active"), "true");
  });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => {
    assert.ok(screen.getByTestId("channel-view"));
    assert.match(screen.getByTestId("location").textContent ?? "", /\/channel\/channel-2$/);
  });
  assert.equal(stores?.useSearchContentStore.getState().slot, null, "no col-3 slot in the overlay");
});

test("overlay empty state: clicking a recent row jumps to it in chat (task #95 contract carried over)", async () => {
  noMessages();
  await renderSearch("", "overlay", { visits: ["channel-3"] });
  await screen.findByTestId("search-channel-result-channel-3");
  fireEvent.click(rowButton("search-channel-result-channel-3"));
  await waitFor(() => {
    assert.match(screen.getByTestId("location").textContent ?? "", /\/channel\/channel-3$/);
  });
  assert.equal(stores?.useSearchContentStore.getState().slot, null);
});

test("overlay: nothing visited and no activity → the centered empty state, not an empty list", async () => {
  noMessages();
  await renderSearch("", "overlay");
  assert.ok(await screen.findByTestId("search-home"));
  assert.ok(screen.queryByTestId("search-overlay-recent") === null);
});

test("overlay with a query: filters return and the recent list is gone", async () => {
  noMessages();
  await renderSearch("?q=desig", "overlay", { visits: ["channel-3"] });
  await screen.findByTestId("search-view-all-results");
  assert.ok(screen.getByText("From"));
  assert.ok(screen.queryByTestId("search-overlay-recent") === null);
});

test("full page keeps its own empty state, placeholder and filters (web unchanged)", async () => {
  noMessages();
  await renderSearch("", "page", { visits: ["channel-3"] });
  assert.ok(await screen.findByTestId("search-home"));
  assert.ok(screen.queryByTestId("search-overlay-recent") === null);
  assert.ok(screen.getByText("From"));
  assert.match((screen.getByRole("textbox") as HTMLInputElement).placeholder, /Search channels, DMs, messages…/);
});

test("overlay entered WITHOUT explicit background state (rail / deep link, task #96 synthesized background): the conversation behind it is still left out", async () => {
  noMessages();
  const { rememberNonSearchLocation } = await import("../src/components/search/searchOverlayLocation");
  // MainLayout remembers the last non-search location; the resolver floats the
  // overlay over it when the entry carries no backgroundLocation.
  rememberNonSearchLocation({ pathname: "/s/server/channel/channel-3", search: "" });
  await renderSearch("", "overlay", { visits: ["channel-3", "channel-2"], entryState: null });

  const section = await screen.findByTestId("search-overlay-recent");
  const rows = Array.from(section.querySelectorAll("[data-testid^='search-channel-result-']")).map((row) => row.getAttribute("data-testid"));
  assert.deepEqual(rows, ["search-channel-result-channel-2"], "channel-3 (the synthesized background) is not offered as a 'switch back' target");
});

test("overlay entered with only searchFrom in state: that conversation is left out", async () => {
  noMessages();
  await renderSearch("", "overlay", { visits: ["channel-2", "channel-3"], entryState: { searchFrom: "/s/server/channel/channel-2?x=1" } });
  const section = await screen.findByTestId("search-overlay-recent");
  const rows = Array.from(section.querySelectorAll("[data-testid^='search-channel-result-']")).map((row) => row.getAttribute("data-testid"));
  assert.deepEqual(rows, ["search-channel-result-channel-3"]);
});
