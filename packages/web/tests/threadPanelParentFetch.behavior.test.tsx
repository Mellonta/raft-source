import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act } from "react";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import ThreadPanel from "../src/components/message/ThreadPanel";
import { useAuthStore } from "../src/store/authStore";
import type { User } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import type { Channel } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import type { Message } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { useTaskStore } from "../src/store/taskStore";
import { useThreadStore } from "../src/store/threadStore";

// task #17 (staging load speed): opening a thread fetched the parent through
// GET /messages/context/:id (a 31-message window, ~1s on staging) even when the
// parent was already in the parent channel's bucket — and the cached copy wins
// anyway (pickFreshThreadParentMessage). A cached parent now renders with no
// request; an uncached one asks for the parent alone (before=0, after=0).

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

window.matchMedia = window.matchMedia ?? (() => ({
  matches: false, media: "", onchange: null,
  addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
}));
globalThis.IntersectionObserver = globalThis.IntersectionObserver ?? class {
  observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
} as typeof IntersectionObserver;
globalThis.ResizeObserver = globalThis.ResizeObserver ?? class {
  observe() {} unobserve() {} disconnect() {}
} as typeof ResizeObserver;
globalThis.CSS = globalThis.CSS ?? ({ escape: (value: string) => value } as typeof CSS);
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo ?? function scrollTo(options?: ScrollToOptions | number) {
  this.scrollTop = typeof options === "number" ? options : options?.top ?? 0;
};

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  useThreadStore.setState(useThreadStore.getInitialState(), true);
  useTaskStore.setState(useTaskStore.getInitialState(), true);
  window.history.pushState({}, "", "/");
});

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1", email: "ada@example.com", gravatarHash: "", name: "ada", displayName: "Ada",
    description: null, avatarUrl: null, emailVerified: true, preferredLanguage: null,
    preferredTimezone: "UTC", autoTranslationEnabled: false, preferredTranslationDisplay: "original",
    preferredTimeFormat: null, preferredMessageBodyFontSize: null, referralSource: null,
    referralSourceOther: null, referralSourceSkippedAt: null, ...overrides,
  };
}
function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "parent-channel", serverId: "server-tp-i18n", name: "parent", description: null,
    type: "channel", createdAt: "2026-07-03T00:00:00.000Z", joined: true, activityMuteSupported: false,
    ...overrides,
  };
}
function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "parent-message", channelId: "parent-channel", senderType: "user", senderId: "user-1",
    senderName: "Ada", messageType: "chat", content: "parent context", createdAt: "2026-07-03T00:00:00.000Z",
    seq: 1, ...overrides,
  };
}

function seedThreadPanel(parentCached: boolean) {
  const parentChannel = makeChannel();
  const threadChannel = makeChannel({ id: "thread-channel", type: "thread", name: "thread" });
  const parent = makeMessage({ threadId: threadChannel.id } as Partial<Message>);
  const reply = makeMessage({ id: "reply-1", channelId: threadChannel.id, content: "a reply", seq: 2 });
  const replies = [reply];

  useAuthStore.setState({ user: makeUser(), initialized: true });
  useServerStore.setState({
    current: {
      id: "server-tp-i18n", name: "TP", avatarUrl: null, slug: "tp-i18n", ownerId: "user-owner",
      onboardingAgentId: null, hideHumansFromMembers: false, plan: "free", planDowngradedAt: null,
      role: "member", createdAt: "2026-07-03T00:00:00.000Z",
    },
    billing: null, members: [], sidebarOrder: null, loadBilling: async () => {},
  });
  useChannelStore.setState({
    channels: [parentChannel, threadChannel],
    dmChannels: [],
    channelActivity: { [parentChannel.id]: null, [threadChannel.id]: null },
  });
  useMessageStore.setState({
    messages: [], channelMessages: { [parentChannel.id]: parentCached ? [parent] : [], [threadChannel.id]: replies },
    loading: false, loadingOlder: false, loadingNewer: false, hasMore: false, hasNewer: false,
    historyLimited: false, highlightedMessageId: null, contextLoadError: null, transientFocusRequest: null,
    unreadCounts: {}, drafts: {},
    loadMessages: async () => {}, loadMessageContext: async () => {}, loadMessageWindowSilent: async () => {},
    loadOlderMessages: async () => {}, loadNewerMessages: async () => {},
  });
  useThreadStore.setState({
    openParentMessageId: parent.id, openParentChannelId: parentChannel.id,
    openThreadChannelId: threadChannel.id, openThreadError: null, openThreadLoading: false,
    focusedMessageId: null,
    summaries: { [parent.id]: {
      threadChannelId: threadChannel.id, replyCount: replies.length, lastReplyAt: reply.createdAt,
      participantIds: [], unreadCount: 0, firstUnreadMessageId: null,
    } },
    followedThreads: [], taskUpdatesByMessageId: {},
  });
  useTaskStore.setState({
    tasks: [], serverTasks: [], currentChannelId: threadChannel.id, tasksByChannelId: {},
    taskMetadataByMessageId: {}, taskMessageIdByTaskId: {}, loadTasks: async () => {},
  });
  const contextRequests: Array<{ url: string; params: unknown }> = [];
  api.get = (async (url: string, config?: { params?: unknown }) => {
    if (url.startsWith("/messages/context/")) {
      contextRequests.push({ url, params: config?.params });
      return { data: { messages: [parent] } };
    }
    return { data: {} };
  }) as typeof api.get;
  return { contextRequests };
}

const render: typeof rtlRender = (ui, options) =>
  rtlRender(ui, { wrapper: TestIntlProvider, ...options });

async function renderThreadPanel() {
  await act(async () => {
    render(<MemoryRouter><ThreadPanel /></MemoryRouter>);
    await new Promise((r) => setTimeout(r, 0));
  });
}

test("a cached thread parent renders without a message-context request", async () => {
  const { contextRequests } = seedThreadPanel(true);
  await renderThreadPanel();

  assert.ok(screen.getAllByText("parent context").length > 0, "the cached parent renders in the panel");
  assert.deepEqual(contextRequests, [], "no /messages/context round-trip when the parent is cached");
});

test("an uncached thread parent is fetched alone, without a surrounding window", async () => {
  const { contextRequests } = seedThreadPanel(false);
  await renderThreadPanel();

  assert.deepEqual(contextRequests, [{
    url: "/messages/context/parent-message",
    params: { channelId: "parent-channel", before: 0, after: 0 },
  }]);
  assert.ok(screen.getAllByText("parent context").length > 0, "the fetched parent renders in the panel");
});
