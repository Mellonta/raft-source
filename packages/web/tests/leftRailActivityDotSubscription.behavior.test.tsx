import assert from "node:assert/strict";
import "./helpers/domSetup";
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import api from "../src/api/client";
import { LeftRail } from "../src/components/layout/LeftRail";
import { useWorkspaceGridNavigationStore } from "../src/components/workspace/workspaceGridNavigationStore";
import { TestIntlProvider } from "./helpers/intl";
import { useAuthStore } from "../src/store/authStore";
import { useInboxStore } from "../src/store/inboxStore";
import { resetInFlightLoadersForTest, useServerStore } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";

const originalApiGet = api.get;
const originalServerState = useServerStore.getState();

afterEach(() => {
  cleanup();
  // Module-level single-flight windows survive setState resets; clear them so a
  // case that stubbed api with a never-settling promise cannot strand the next.
  resetInFlightLoadersForTest();
  api.get = originalApiGet;
  localStorage.clear();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useInboxStore.setState(useInboxStore.getInitialState(), true);
  useServerStore.setState(originalServerState, true);
  useThreadStore.setState(useThreadStore.getInitialState(), true);
  useWorkspaceGridNavigationStore.setState(useWorkspaceGridNavigationStore.getInitialState(), true);
});

function seedActivityRail(
  loadInboxCalls: Array<{ reset?: boolean; background?: boolean }>,
  openThreadCalls: unknown[],
) {
  api.get = (() => new Promise(() => {})) as typeof api.get;
  useAuthStore.setState({
    user: {
      id: "user-activity-rail",
      email: "activity-rail@example.com",
      gravatarHash: "",
      name: "activity-rail",
      displayName: "Activity Rail",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationDisplay: "original",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({
    ...originalServerState,
    current: {
      id: "server-activity-rail",
      name: "Activity Rail Server",
      slug: "activity-rail",
      avatarUrl: null,
      ownerId: "user-activity-rail",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-08-20T00:00:00.000Z",
    },
    servers: [],
    members: [],
  } as never);
  useInboxStore.setState({
    pendingFocusKind: null,
    loadInbox: async (options) => {
      loadInboxCalls.push(options ?? {});
    },
  });
  useThreadStore.setState({
    openThreadChannelId: null,
    openThread: async (request) => {
      openThreadCalls.push(request);
    },
  });
}

function LocationRecorder({ paths }: { paths: string[] }) {
  const location = useLocation();
  useEffect(() => {
    paths.push(location.pathname);
  }, [location, paths]);
  return <div data-testid="activity-rail-location">{location.pathname}</div>;
}

test("the rail server avatar falls back to its initial after an image load error", () => {
  api.get = (() => new Promise(() => {})) as typeof api.get;
  useServerStore.setState({
    ...originalServerState,
    current: {
      id: "server-1",
      name: "Botiverse",
      slug: "botiverse",
      avatarUrl: "https://cdn.example.com/broken-server.png",
    } as never,
  });

  const { container } = render(
    <MemoryRouter initialEntries={["/s/botiverse/channel/general"]}>
      <TestIntlProvider>
        <LeftRail side="left" />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const switcher = container.querySelector<HTMLButtonElement>('button[aria-label*="Botiverse"]');
  assert.ok(switcher);
  const avatar = switcher.querySelector<HTMLImageElement>('img[src="https://cdn.example.com/broken-server.png"]');
  assert.ok(avatar);
  const frame = avatar.closest('[data-slot="avatar"]');
  assert.ok(frame, "the rail image needs the RUI frame that supplies its size");
  assert.equal(frame.getAttribute("data-size"), "md");
  assert.equal(frame.getAttribute("data-avatar-context"), "panel-header");
  assert.equal(switcher.textContent?.trim(), "B");

  fireEvent.error(avatar);
  assert.equal(avatar.hidden, true);
  assert.equal(switcher.textContent?.trim(), "B");

  act(() => {
    useServerStore.setState({
      current: {
        ...useServerStore.getState().current!,
        avatarUrl: "https://cdn.example.com/replacement-server.png",
      },
    });
  });
  const replacement = switcher.querySelector<HTMLImageElement>('img[src="https://cdn.example.com/replacement-server.png"]');
  assert.ok(replacement);
  assert.equal(replacement.hidden, false);
});

test("a fresh current-server Activity total outranks a stale summary while other-server attention remains", async () => {
  seedActivityRail([], []);
  const currentServer = useServerStore.getState().current!;
  useServerStore.setState({
    servers: [
      currentServer,
      {
        ...currentServer,
        id: "server-other",
        name: "Other Server",
        slug: "other-server",
      },
    ],
  });
  let summaryRequests = 0;
  api.get = (() => {
    summaryRequests += 1;
    return Promise.resolve({
      data: [
        {
          serverId: "server-activity-rail",
          unreadCount: 1,
          serverPushMuted: false,
          activityUnreadCount: 1,
        },
        {
          serverId: "server-other",
          unreadCount: 1,
          serverPushMuted: false,
          activityUnreadCount: 1,
        },
      ],
    });
  }) as typeof api.get;
  useInboxStore.setState({
    acceptedWindowGeneration: "activity-window:fresh",
    hasAcceptedWindow: true,
    loaded: true,
    totalUnreadCount: 0,
    activeUnreadCount: 0,
  });
  render(
    <MemoryRouter initialEntries={["/"]}>
      <TestIntlProvider>
        <LeftRail side="left" />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  // The boot summary fetch now lives in App's single boot entry (LeftRail's
  // effect only keeps event triggers). Simulate that entry directly so this
  // test's subject — the stale-vs-fresh dot logic — has a loaded summary.
  void useServerStore.getState().loadServerUnreadSummary();
  const activityButton = document.querySelector<HTMLButtonElement>('[data-testid="left-rail-tab-activity"]');
  assert.ok(activityButton, "Activity rail button renders");
  const currentActivityButton = () => document.querySelector<HTMLButtonElement>('[data-testid="left-rail-tab-activity"]');
  const serverSwitcherButton = () => document.querySelector<HTMLButtonElement>('button[aria-label*="Activity Rail Server"]');
  await waitFor(() => {
    // The rail must load the summary; not necessarily exactly once. The effect
    // deliberately re-fetches when local unread appears or clears (the "flip"
    // note in LeftRail), and the store coalesces only concurrent calls, so a
    // second sequential fetch is expected behaviour rather than a regression.
    assert.ok(summaryRequests >= 1, `left rail must load the server summary, saw ${summaryRequests}`);
    assert.equal(
      currentActivityButton()?.querySelector('span[aria-hidden="true"]'),
      null,
      "fresh Activity total=0 must suppress the stale current-server summary=1",
    );
    assert.notEqual(
      serverSwitcherButton()?.querySelector('span[aria-hidden="true"]'),
      null,
      "the same cross-server summary still reports other-server Activity attention",
    );
  });

  act(() => {
    useInboxStore.setState({ totalUnreadCount: 2, activeUnreadCount: 2 });
  });
  assert.notEqual(
    currentActivityButton()?.querySelector('span[aria-hidden="true"]'),
    null,
    "new current-server Activity unread lights the dot immediately",
  );

  act(() => {
    useInboxStore.setState({ totalUnreadCount: 1, activeUnreadCount: 1 });
  });
  assert.notEqual(
    currentActivityButton()?.querySelector('span[aria-hidden="true"]'),
    null,
    "reading one of several Activity items keeps the dot while unread remains",
  );

  act(() => {
    useInboxStore.setState({ totalUnreadCount: 0, activeUnreadCount: 0 });
  });
  assert.equal(
    currentActivityButton()?.querySelector('span[aria-hidden="true"]'),
    null,
    "mark-read total=0 clears the dot without waiting for summary refresh",
  );

  act(() => {
    useInboxStore.setState({ totalUnreadCount: 3, activeUnreadCount: 3 });
  });
  assert.notEqual(currentActivityButton()?.querySelector('span[aria-hidden="true"]'), null);
  act(() => {
    useInboxStore.setState({ totalUnreadCount: 0, activeUnreadCount: 0 });
  });
  assert.equal(
    currentActivityButton()?.querySelector('span[aria-hidden="true"]'),
    null,
    "mark-all-read total=0 clears the dot without waiting for summary refresh",
  );

  act(() => {
    useInboxStore.setState({
      acceptedWindowGeneration: "",
      hasAcceptedWindow: true,
      loaded: true,
      totalUnreadCount: 0,
      activeUnreadCount: 0,
    });
  });
  assert.equal(
    currentActivityButton()?.querySelector('span[aria-hidden="true"]'),
    null,
    "a background refresh in flight must keep the accepted total authoritative",
  );

  const chatButton = document.querySelector<HTMLButtonElement>('[data-testid="left-rail-tab-chat"]');
  assert.ok(chatButton);
  fireEvent.click(chatButton);
  assert.equal(
    currentActivityButton()?.querySelector('span[aria-hidden="true"]'),
    null,
    "leaving Activity must not OR the stale current-server summary back into the rail",
  );
});

test("classic Activity double-click navigates once and only adds first-unread focus", () => {
  const loadInboxCalls: Array<{ reset?: boolean; background?: boolean }> = [];
  const openThreadCalls: unknown[] = [];
  const paths: string[] = [];
  seedActivityRail(loadInboxCalls, openThreadCalls);
  useWorkspaceGridNavigationStore.setState({ active: false, enabled: false });

  render(
    <MemoryRouter initialEntries={["/s/activity-rail/channel/general"]}>
      <TestIntlProvider>
        <LocationRecorder paths={paths} />
        <LeftRail side="left" />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const activityButton = document.querySelector<HTMLButtonElement>('[data-testid="left-rail-tab-activity"]');
  assert.ok(activityButton);
  assert.deepEqual(paths, ["/s/activity-rail/channel/general"]);

  fireEvent.click(activityButton, { detail: 1 });
  assert.deepEqual(paths, ["/s/activity-rail/channel/general", "/s/activity-rail/activity"]);

  fireEvent.click(activityButton, { detail: 2 });
  fireEvent.doubleClick(activityButton);

  assert.deepEqual(
    paths,
    ["/s/activity-rail/channel/general", "/s/activity-rail/activity"],
    "the second click in the browser double-click sequence must not navigate again",
  );
  assert.equal(useInboxStore.getState().pendingFocusKind, "first-unread");
  assert.deepEqual(loadInboxCalls, [{ reset: true }]);
  assert.deepEqual(openThreadCalls, []);
  assert.equal(useThreadStore.getState().openThreadChannelId, null);
});

test("Workspace Activity double-click selects its rail once and only adds first-unread focus", () => {
  const loadInboxCalls: Array<{ reset?: boolean; background?: boolean }> = [];
  const openThreadCalls: unknown[] = [];
  const railModeCalls: string[] = [];
  seedActivityRail(loadInboxCalls, openThreadCalls);
  useWorkspaceGridNavigationStore.setState({
    active: true,
    enabled: true,
    railMode: null,
    activeRailSide: "left",
    railLayout: { left: ["activity"], right: [] },
    sidebars: {
      left: { activeItem: null, collapsed: true },
      right: { activeItem: null, collapsed: true },
    },
  });
  const setRailMode = useWorkspaceGridNavigationStore.getState().setRailMode;
  useWorkspaceGridNavigationStore.setState({
    setRailMode: (mode, side, userId) => {
      railModeCalls.push(mode ?? "null");
      setRailMode(mode, side, userId);
    },
  });

  render(
    <MemoryRouter initialEntries={["/s/activity-rail/channel/general"]}>
      <TestIntlProvider>
        <LeftRail side="left" />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const activityButton = document.querySelector<HTMLButtonElement>('[data-testid="left-rail-tab-activity"]');
  assert.ok(activityButton);

  fireEvent.click(activityButton, { detail: 1 });
  assert.deepEqual(railModeCalls, ["activity"]);
  assert.equal(useWorkspaceGridNavigationStore.getState().sidebars.left.activeItem, "activity");

  fireEvent.click(activityButton, { detail: 2 });
  fireEvent.doubleClick(activityButton);

  assert.deepEqual(railModeCalls, ["activity"], "the second click must not re-select Workspace Activity");
  assert.equal(useInboxStore.getState().pendingFocusKind, "first-unread");
  assert.deepEqual(loadInboxCalls, [{ reset: true }]);
  assert.deepEqual(openThreadCalls, []);
  assert.equal(useThreadStore.getState().openThreadChannelId, null);
});
