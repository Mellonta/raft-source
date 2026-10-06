import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act } from "react";
import { cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { renderWithIntl } from "./helpers/intl";
import api from "../src/api/client";
import ChatPanel from "../src/components/message/ChatPanel";
import type { Channel } from "../src/store/channelStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { useTaskStore } from "../src/store/taskStore";
import { settleFirstPageLoadMessages } from "./helpers/firstPageStub";

// task #17 (staging load speed): opening a channel fired members,
// notification-settings and recoverable-upload requests alongside the first
// message page; that concurrency stretched the page request from 0.5–0.8s to
// 1.1s+. ChatPanel (and its composer) now hold them until the page lands.

const originalGet = api.get;

window.matchMedia = window.matchMedia ?? (() => ({
  matches: false, media: "", onchange: null,
  addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
}));
globalThis.ResizeObserver = globalThis.ResizeObserver ?? class {
  observe() {} unobserve() {} disconnect() {}
} as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  useTaskStore.setState(useTaskStore.getInitialState(), true);
});

const SECONDARY = /\/(members|notification-settings)$|\/upload-sessions\//;

test("channel open holds secondary requests until the first message page lands", async () => {
  const channel: Channel = {
    id: "channel-first-page-gate",
    serverId: "server-first-page-gate",
    name: "first-page-gate",
    description: null,
    type: "channel",
    createdAt: "2026-10-04T00:00:00.000Z",
    joined: true,
    activityMuteSupported: true,
  };
  const requested: string[] = [];
  api.get = (async (url: string) => {
    requested.push(url);
    if (url.endsWith("/members")) return { data: { agents: [], humans: [] } };
    return { data: {} };
  }) as typeof api.get;

  let landFirstPage!: () => Promise<void>;
  useServerStore.setState({ current: { id: channel.serverId, slug: "gate", name: "Gate", role: "member" }, billing: null, members: [] } as never);
  useChannelStore.setState({ channels: [channel], dmChannels: [], channelActivity: { [channel.id]: null } });
  useTaskStore.setState({ tasks: [], currentChannelId: channel.id, loadTasks: async () => {} });
  useMessageStore.setState({
    messages: [], loading: false, loadingOlder: false, loadingNewer: false, hasMore: false, hasNewer: false,
    historyLimited: false, highlightedMessageId: null, contextLoadError: null, transientFocusRequest: null,
    loadMessages: async (channelId: string) => {
      landFirstPage = () => settleFirstPageLoadMessages(channelId);
    },
    loadMessageContext: async () => {}, loadMessageWindowSilent: async () => {},
    loadOlderMessages: async () => {}, loadNewerMessages: async () => {},
  });

  await act(async () => {
    renderWithIntl(<MemoryRouter><ChatPanel channel={channel} /></MemoryRouter>, { locale: "en" });
    await new Promise((r) => setTimeout(r, 0));
  });
  assert.ok(landFirstPage, "ChatPanel starts the first-page load");
  assert.deepEqual(requested.filter((url) => SECONDARY.test(url)), [], "no secondary request before the page lands");

  await act(async () => {
    await landFirstPage();
    await new Promise((r) => setTimeout(r, 0));
  });
  const after = requested.filter((url) => SECONDARY.test(url));
  assert.ok(after.some((url) => url.endsWith(`/channels/${channel.id}/members`)), "members load once the page lands");
  assert.ok(after.some((url) => url.endsWith(`/channels/${channel.id}/notification-settings`)), "notification settings load once the page lands");
});
