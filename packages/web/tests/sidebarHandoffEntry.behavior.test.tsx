import assert from "node:assert/strict";
import "./helpers/domSetup";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import api from "../src/api/client";
import Sidebar from "../src/components/layout/Sidebar";
import { TestIntlProvider } from "./helpers/intl";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";

// Task #110 (@WAWQAQ): the Agents "+" menu offers THREE entries on the desktop —
// Create Agent, Create external agent, and "Take over a local session" (its own
// dialog) — and the usual two on the web. Harness mirrors sidebarAddCindyAction.

const originalApiGet = api.get;

afterEach(() => {
  api.get = originalApiGet;
  cleanup();
  delete (globalThis as { raftDesktop?: unknown }).raftDesktop;
  delete (window as { raftDesktop?: unknown }).raftDesktop;
});

function installApiStub() {
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") return { data: { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 } };
    return { data: [] };
  }) as typeof api.get;
}

function installDesktopBridge() {
  const value = {
    isDesktop: true,
    handoff: {
      listSessions: () => Promise.resolve([]),
      sessionExcerpt: () => Promise.resolve({ firstUserMessage: null, recentExcerpt: "" }),
    },
    computer: {
      getLocalInfo: () => Promise.resolve({ hostname: "local-host" }),
      getStatus: () => Promise.resolve({ servers: [] }),
    },
  };
  (globalThis as { raftDesktop?: unknown }).raftDesktop = value;
  (window as { raftDesktop?: unknown }).raftDesktop = value;
}

function seedSidebar() {
  installApiStub();
  localStorage.clear();
  useAuthStore.setState({
    user: {
      id: "user-1", email: "owner@example.com", gravatarHash: "hash", name: "owner", displayName: "Owner",
      description: null, avatarUrl: null, emailVerified: true, preferredLanguage: null, preferredTimezone: null,
      autoTranslationEnabled: false, preferredTranslationDisplay: "original", preferredTimeFormat: null,
      preferredMessageBodyFontSize: null, referralSource: null, referralSourceOther: null, referralSourceSkippedAt: null,
    },
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({
    current: {
      id: "server-1", name: "Server", avatarUrl: null, slug: "server", ownerId: "user-1", onboardingAgentId: null,
      hideHumansFromMembers: false, plan: "free", planDowngradedAt: null, role: "owner", createdAt: "2026-06-28T00:00:00.000Z",
    },
    servers: [],
    members: [],
    membersLoadError: false,
    loading: false,
    sidebarOrder: {
      channelOrder: [], agentOrder: [], dmOrder: [], channelSortMode: "manual", jointChannelSortMode: "manual",
      dmSortMode: "manual", pinnedSortMode: "manual", pinned: [], pinnedChannelIds: [], pinnedAgentIds: [],
      pinnedOrder: [], hiddenDmIds: [], channelPanelTabOrder: [], agentPanelTabOrder: [], pinnedVersion: 0,
    },
  } as never);
  useChannelStore.setState({ channels: [], dmChannels: [], loading: false } as never);
  useMachineStore.setState({ machines: [], loading: false } as never);
  useAgentStore.setState({ agents: [], loading: false, showCreateAgent: false, createAgentOnboarding: false } as never);
}

function renderSidebar() {
  render(
    <MemoryRouter initialEntries={["/s/server/members"]}>
      <TestIntlProvider>
        <Sidebar workspaceRailMode="members" />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

async function openAgentMenu() {
  const trigger = await screen.findByRole("button", { name: "Add agent" });
  fireEvent.click(trigger);
  await waitFor(() => assert.ok(screen.getByRole("menu")));
  return screen.getAllByRole("menuitem").map((item) => item.textContent?.trim());
}

test("desktop: the Agents + menu has three entries and the third opens the Take-over dialog", async () => {
  seedSidebar();
  installDesktopBridge();
  renderSidebar();
  const items = await openAgentMenu();
  assert.deepEqual(items, ["Create Agent", "Create External Agent", "Take over a local session"]);

  fireEvent.click(screen.getByTestId("sidebar-menu-handoff-session"));
  await waitFor(() => assert.ok(screen.getByTestId("handoff-dialog")));
  assert.ok(screen.queryByRole("menu") === null, "the menu closes when the dialog opens");
});

test("web (no desktop bridge): the Agents + menu keeps its two entries", async () => {
  seedSidebar();
  renderSidebar();
  const items = await openAgentMenu();
  assert.deepEqual(items, ["Create Agent", "Create External Agent"]);
  assert.ok(screen.queryByTestId("sidebar-menu-handoff-session") === null);
});
