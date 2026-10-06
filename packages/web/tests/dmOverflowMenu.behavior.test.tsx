import assert from "node:assert/strict";
import { test } from "vitest";
import "./helpers/domSetup";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import type { Locale } from "../src/i18n/locale";
import api from "../src/api/client";
import ChatPanel from "../src/components/message/ChatPanel";
import { useAuthStore } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import { useProfileStore } from "../src/store/profileStore";
import { resetInFlightLoadersForTest, useServerStore } from "../src/store/serverStore";
import { useTaskStore } from "../src/store/taskStore";
import { resetServerFeatureFlagsForTests } from "../src/store/serverFeatureFlags";

// task #703 / #1281: a DM gets the SAME top-right overflow component as a
// channel (artin: 用统一组件). The sheet's DM mode shows preferences only: pin
// and collapse-long-messages. It no longer shows a members section; per-DM
// Activity mute is a documented non-feature and must NOT appear.

const originalGet = api.get.bind(api);
const originalPatch = api.patch.bind(api);

afterEach(() => {
  cleanup();
  resetInFlightLoadersForTest();
  api.get = originalGet as typeof api.get;
  api.patch = originalPatch as typeof api.patch;
  localStorage.clear();
  resetServerFeatureFlagsForTests();
  useProfileStore.setState({ profileType: null, profileId: null, openSource: null });
});

function flushAsyncWork() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function makeSidebarOrder() {
  return {
    channelOrder: [],
    agentOrder: [],
    dmOrder: [],
    channelSortMode: "manual" as const,
    jointChannelSortMode: "manual" as const,
    dmSortMode: "manual" as const,
    pinnedSortMode: "manual" as const,
    pinned: [],
    pinnedChannelIds: [],
    pinnedAgentIds: [],
    pinnedOrder: [],
    hiddenDmIds: [],
    channelPanelTabOrder: [],
    agentPanelTabOrder: [],
    pinnedVersion: 0,
  };
}

function makeDm(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "dm-peer",
    serverId: "server-dm-overflow",
    name: "dm-peer",
    description: null,
    type: "dm",
    peerType: "user",
    peerId: "peer-1",
    peerDisplayName: "Peer One",
    createdAt: "2026-09-30T00:00:00.000Z",
    joined: true,
    ...overrides,
  };
}

function makeRegularChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "channel-general",
    serverId: "server-dm-overflow",
    name: "general",
    description: "Team room",
    type: "channel",
    createdAt: "2026-09-30T00:00:00.000Z",
    joined: true,
    archivedAt: null,
    ...overrides,
  } as Channel;
}

function meAsHuman() {
  return {
    id: "user-dm-overflow",
    name: "dm-overflow-user",
    displayName: null,
    description: null,
    avatarUrl: null,
    gravatarHash: "abc123",
    role: "owner",
    serverRole: "owner",
    channelRole: "member",
    effectiveChannelRole: "member",
    channelAdminBasis: "none",
    canChangeChannelRole: false,
  };
}

function peerAsAgent(id = "peer-agent-1", name = "Peer One") {
  return {
    id,
    name,
    displayName: null,
    description: null,
    avatarUrl: null,
    gravatarHash: "",
    role: "member",
    serverRole: "member",
    channelRole: "member",
    effectiveChannelRole: "member",
    channelAdminBasis: "none",
    canChangeChannelRole: false,
  };
}

function peerAsHuman(id = "peer-human-1", name = "Peer One") {
  return { ...meAsHuman(), id, name, role: "member", serverRole: "member" };
}

function stubApiGet(members: { agents: unknown[]; humans: unknown[] }) {
  const requested: string[] = [];
  api.get = (async (url: string) => {
    requested.push(url);
    if (url.endsWith("/members")) return { data: { ...members, externalMembers: [] } };
    if (url.endsWith("/message-display-settings")) return { data: { collapseLongMessages: true, prefsVersion: 1 } };
    return { data: {} };
  }) as typeof api.get;
  return requested;
}

function renderChatPanel(channel: Channel, options: { locale?: Locale } = {}) {
  useAuthStore.setState({
    user: { id: "user-dm-overflow", name: "dm-overflow-user" },
  } as never);
  useServerStore.setState({
    current: {
      id: "server-dm-overflow",
      name: "DM Overflow Server",
      avatarUrl: null,
      slug: "dm-overflow-server",
      ownerId: "user-owner",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-09-30T00:00:00.000Z",
    },
    billing: null,
    members: [{ userId: "user-dm-overflow", role: "owner" }],
    sidebarOrder: makeSidebarOrder(),
  });
  useChannelStore.setState({
    channels: channel.type === "dm" ? [] : [channel],
    dmChannels: channel.type === "dm" ? [channel] : [],
    channelActivity: { [channel.id]: null },
  });
  useTaskStore.setState({
    tasks: [],
    currentChannelId: channel.id,
    loadTasks: async () => {},
  });
  useMessageStore.setState({
    messages: [],
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    hasMore: false,
    hasNewer: false,
    historyLimited: false,
    highlightedMessageId: null,
    contextLoadError: null,
    transientFocusRequest: null,
    loadMessages: async () => {},
    loadMessageContext: async () => {},
    loadMessageWindowSilent: async () => {},
    loadOlderMessages: async () => {},
    loadNewerMessages: async () => {},
  });

  const Wrapper = ({ children }: { children: ReactNode }) => (
    <TestIntlProvider locale={options.locale}>{children}</TestIntlProvider>
  );
  return render(
    <MemoryRouter>
      <ChatPanel channel={channel} readOnly />
    </MemoryRouter>,
    { wrapper: Wrapper },
  );
}

async function openDmSettings() {
  fireEvent.click(screen.getByTestId("channel-overflow-trigger"));
  return screen.findByTestId("channel-overflow-sheet");
}

test("DM header shares the channel overflow component; the sheet is DM-shaped (preferences, no members)", async () => {
  const requested = stubApiGet({ agents: [], humans: [meAsHuman(), peerAsHuman()] });

  try {
    await act(async () => {
      renderChatPanel(makeDm());
      await flushAsyncWork();
    });
    // Same triggers as a channel: search + overflow.
    assert.ok(screen.getByTestId("channel-topbar-search"), "DM shares the search trigger");
    const sheet = await openDmSettings();
    assert.ok(sheet, "DM opens the same overflow sheet component");
    const title = screen.getByTestId("channel-overflow-title-text");
    assert.ok(title.textContent?.includes("Peer One"));
    assert.ok(!title.textContent?.includes("#"), "DM title is the plain peer name, no channel # prefix");
    assert.ok(screen.getByTestId("channel-overflow-visibility-badge"), "the sheet carries the DM badge");
    assert.equal(screen.queryAllByTestId("channel-overflow-members-strip").length, 0, "DM settings has no members strip");
    assert.equal(screen.queryAllByTestId("channel-overflow-members-entry").length, 0, "DM settings has no members entry");
    // Count assertions, not node diffs (a failing DOM-node diff stalls the file).
    assert.equal(screen.queryAllByTestId("channel-overflow-members-add-tile").length, 0, "no add-member tile for a DM");
    assert.equal(screen.queryAllByTestId("channel-overflow-mute-switch").length, 0, "per-DM mute is a documented non-feature");
    assert.equal(screen.queryAllByTestId("channel-settings-panel").length, 0, "a DM has no name/description form");
    assert.equal(screen.queryAllByTestId("channel-settings-pin-switch").length, 1, "DM keeps the shared preferences section");
    assert.equal(
      requested.filter((url) => url.includes("/notification-settings")).length,
      0,
      "DM must not request notification (Activity mute) settings",
    );
  } finally {
    cleanup();
  }
});

test("regular channel settings still exposes the members section", async () => {
  stubApiGet({ agents: [peerAsAgent()], humans: [meAsHuman(), peerAsHuman()] });

  try {
    await act(async () => {
      renderChatPanel(makeRegularChannel());
      await flushAsyncWork();
    });
    const sheet = await openDmSettings();
    assert.ok(sheet, "regular channel opens the shared overflow sheet");
    assert.ok(screen.getByTestId("channel-overflow-members-strip"), "regular channel keeps the members strip");
    assert.ok(screen.getByTestId("channel-overflow-members-entry"), "regular channel keeps the members navigation entry");
    assert.equal(screen.queryAllByTestId("channel-settings-pin-switch").length, 1, "regular channel preferences still render");
  } finally {
    cleanup();
  }
});

test("collapse-long-messages is offered for DMs: loads once and PATCHes the inverted value", async () => {
  const requested = stubApiGet({ agents: [], humans: [meAsHuman(), peerAsHuman()] });
  const patched: Array<{ url: string; body: unknown }> = [];
  api.patch = (async (url: string, body: unknown) => {
    patched.push({ url, body });
    return { data: { collapseLongMessages: false, prefsVersion: 2 } };
  }) as typeof api.patch;

  try {
    await act(async () => {
      renderChatPanel(makeDm());
      await flushAsyncWork();
    });
    assert.deepEqual(
      requested.filter((url) => url.endsWith("/message-display-settings")),
      ["/channels/dm-peer/message-display-settings"],
      "DM loads its display prefs exactly once",
    );
    await openDmSettings();
    const toggle = screen.getByTestId("channel-settings-collapse-switch");
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    await act(async () => {
      fireEvent.click(toggle);
      await flushAsyncWork();
    });
    assert.deepEqual(patched, [{
      url: "/channels/dm-peer/message-display-settings",
      body: { collapseLongMessages: false },
    }]);
  } finally {
    cleanup();
  }
});

test("pin toggle reflects and writes the sidebar pinned refs for a DM", async () => {
  stubApiGet({ agents: [], humans: [meAsHuman(), peerAsHuman()] });
  const pinWrites: unknown[] = [];
  useServerStore.setState({
    updateSidebarOrder: async (updates: { pinned?: unknown[] }) => {
      if (updates.pinned) {
        pinWrites.push(updates.pinned);
        useServerStore.setState({
          sidebarOrder: { ...useServerStore.getState().sidebarOrder, pinned: updates.pinned },
        });
      }
    },
  } as never);

  try {
    await act(async () => {
      renderChatPanel(makeDm());
      await flushAsyncWork();
    });
    await openDmSettings();
    const toggle = screen.getByTestId("channel-settings-pin-switch");
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    await act(async () => {
      fireEvent.click(toggle);
      await flushAsyncWork();
    });
    assert.deepEqual(pinWrites, [[{ kind: "channel", id: "dm-peer" }]], "pin writes the DM's channel ref");
    assert.equal(screen.getByTestId("channel-settings-pin-switch").getAttribute("aria-checked"), "true");
  } finally {
    cleanup();
  }
});

test("DM settings has no path into the channel members page", async () => {
  for (const peerType of ["user", "agent"] as const) {
    const peer = peerType === "agent" ? peerAsAgent() : peerAsHuman();
    stubApiGet({
      agents: peerType === "agent" ? [peer] : [],
      humans: peerType === "agent" ? [meAsHuman()] : [meAsHuman(), peer],
    });
    try {
      await act(async () => {
        renderChatPanel(makeDm({ peerType, peerId: peer.id }));
        await flushAsyncWork();
      });
      await openDmSettings();
      assert.equal(screen.queryAllByTestId("channel-overflow-members-entry").length, 0, "DM settings does not expose members navigation");
      assert.equal(screen.queryAllByTestId("member-page-add").length, 0, "DM settings never opens the members page add entry");
      assert.equal(screen.queryAllByTestId("member-page-section-humans-panel").length, 0, "DM settings does not mount the members page");
      assert.equal(screen.queryAllByTestId("member-page-section-agents-panel").length, 0, "DM settings does not mount the agents members page");
    } finally {
      cleanup();
    }
  }
});
