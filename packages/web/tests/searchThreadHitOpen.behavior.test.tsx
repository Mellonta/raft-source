import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act } from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import MessageSearchPage from "../src/components/search/MessageSearchPage";
import ThreadPanel from "../src/components/message/ThreadPanel";
import ChatPanel from "../src/components/message/ChatPanel";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import type { User } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import type { Channel } from "../src/store/channelStore";
import { CONTEXT_BEYOND_HISTORY_ERROR, useMessageStore } from "../src/store/messageStore";
import type { Message } from "../src/store/messageStore";
import { useSearchContentStore } from "../src/store/searchContentStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { useTaskStore } from "../src/store/taskStore";
import { useThreadStore } from "../src/store/threadStore";

// Task #14: clicking a search hit that is a thread reply opened an empty
// "Thread / No replies yet" panel for a thread that had 15 replies. Two faults:
//   1. the search page dropped the hit's own thread channel id and re-resolved
//      the thread through `GET /channels/:parent/threads/:parentMsg`;
//   2. threadStore read ANY 404 from that lookup as "no thread yet", so a failed
//      lookup (channel not visible / wrong server) rendered as an empty thread.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
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
  useSearchContentStore.setState({ slot: null });
});

function makeUser(): User {
  return {
    id: "user-1", email: "ada@example.com", gravatarHash: "", name: "ada", displayName: "Ada",
    description: null, avatarUrl: null, emailVerified: true, preferredLanguage: null,
    preferredTimezone: "UTC", autoTranslationEnabled: false, preferredTranslationDisplay: "original",
    preferredTimeFormat: null, preferredMessageBodyFontSize: null, referralSource: null,
    referralSourceOther: null, referralSourceSkippedAt: null,
  };
}

function makeServer(): Server {
  return {
    id: "server-1", name: "Server", avatarUrl: null, slug: "server", ownerId: "user-owner",
    onboardingAgentId: null, hideHumansFromMembers: false, plan: "free", planDowngradedAt: null,
    role: "member", createdAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "channel-1", serverId: "server-1", name: "all", description: null,
    type: "channel", createdAt: "2026-07-01T00:00:00.000Z", joined: true, activityMuteSupported: false,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "parent-1", channelId: "channel-1", senderType: "user", senderId: "user-1",
    senderName: "Ada", messageType: "chat", content: "parent context", createdAt: "2026-07-01T00:00:00.000Z",
    seq: 1, ...overrides,
  };
}

const reply = makeMessage({ id: "reply-1", channelId: "thread-1", content: "needle reply in thread", seq: 2 });

function seedStores() {
  localStorage.setItem("slock_access_token", "token");
  useAuthStore.setState({ user: makeUser(), accessToken: "token", refreshToken: "refresh", loading: false, initialized: true });
  useServerStore.setState({ current: makeServer(), members: [], billing: null, loadBilling: async () => {} } as never);
  useChannelStore.setState({
    channels: [makeChannel(), makeChannel({ id: "thread-1", type: "thread", name: "thread" })],
    dmChannels: [],
  } as never);
  useAgentStore.setState({ agents: [], agentActivities: {} } as never);
  useTaskStore.setState({ tasks: [], serverTasks: [], tasksByChannelId: {}, loadTasks: async () => {} } as never);
  useSearchContentStore.setState({ slot: null });
}

const threadHit = {
  id: "reply-1",
  channelId: "thread-1",
  threadId: "thread-1",
  parentMessageId: "parent-1",
  parentMessageContent: "parent context",
  parentChannelId: "channel-1",
  parentChannelName: "all",
  parentChannelType: "channel",
  parentChannelArchivedAt: null,
  senderId: "user-1",
  senderType: "user",
  senderName: "Ada",
  channelName: "thread",
  channelType: "thread",
  channelArchivedAt: null,
  content: "needle reply in thread",
  snippet: "needle reply in thread",
  createdAt: "2026-07-01T04:00:00.000Z",
};

function StoreDrivenThreadPanel() {
  // The /search col-3 thread slot renders a store-driven ThreadPanel (see
  // MainLayout renderContentSlot); mount that same shape next to the page.
  const open = useThreadStore((s) => s.openParentMessageId);
  return open ? <ThreadPanel composerAutoFocus={false} /> : null;
}

test("clicking a thread search hit opens the thread by its own id and renders its replies", async () => {
  seedStores();
  const gets: string[] = [];
  api.get = (async (url: string) => {
    gets.push(url);
    if (url === "/messages/search") return { data: { hasMore: false, results: [threadHit] } };
    if (url.startsWith("/messages/channel/thread-1")) {
      return { data: { messages: [reply], hasOlder: false, hasNewer: false } };
    }
    if (url.startsWith("/messages/context/reply-1")) {
      return { data: { messages: [reply], hasOlder: false, hasNewer: false } };
    }
    if (url.startsWith("/messages/context/parent-1")) {
      return { data: { messages: [makeMessage()] } };
    }
    if (url === "/channels/channel-1/threads/parent-1") {
      // The pre-fix path: the parent lookup failing as it did in prod.
      throw { response: { status: 404, data: { error: "Channel not found or not visible" } } };
    }
    return { data: {} };
  }) as typeof api.get;

  rtlRender(
    <MemoryRouter initialEntries={["/s/server/search?q=needle"]}>
      <TestIntlProvider>
        <MessageSearchPage />
        <StoreDrivenThreadPanel />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const hit = await waitFor(() => {
    const button = Array.from(document.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.includes("needle reply in thread"));
    assert.ok(button instanceof HTMLElement, "thread hit rendered");
    return button;
  });
  fireEvent.click(hit, { detail: 1 });

  await waitFor(() => assert.equal(useThreadStore.getState().openThreadChannelId, "thread-1"), { timeout: 2000 });
  const state = useThreadStore.getState();
  assert.equal(state.openParentChannelId, "channel-1");
  assert.equal(state.openParentMessageId, "parent-1");
  assert.equal(state.openThreadError, null);
  assert.deepEqual(useSearchContentStore.getState().slot, { kind: "thread", id: "thread-1", messageId: "reply-1" });
  assert.equal(
    gets.includes("/channels/channel-1/threads/parent-1"),
    false,
    "a thread hit already names its thread channel — no parent-message re-resolution",
  );

  await waitFor(() => {
    const scroller = screen.getByTestId("thread-message-scroller");
    assert.match(scroller.textContent ?? "", /needle reply in thread/, "the reply renders in the thread panel");
  });
  assert.ok(screen.queryByText(en["message.threadPanel.noRepliesTitle"]) === null, "not the empty state");
});

async function openViaParentLookup(lookupError: unknown, locale: "en" | "zh-cn" = "en") {
  seedStores();
  let attempts = 0;
  api.get = (async (url: string) => {
    if (url === "/channels/channel-1/threads/parent-1") {
      attempts += 1;
      throw lookupError;
    }
    if (url.startsWith("/messages/context/")) {
      return { data: { messages: [makeMessage()], hasOlder: false, hasNewer: false } };
    }
    return { data: {} };
  }) as typeof api.get;
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    rtlRender(
      <MemoryRouter>
        <TestIntlProvider locale={locale}>
          <StoreDrivenThreadPanel />
        </TestIntlProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      await useThreadStore.getState().openThread({ parentChannelId: "channel-1", parentMessageId: "parent-1" });
    });
  } finally {
    console.error = originalConsoleError;
  }
  return { attempts: () => attempts };
}

test("a failed thread lookup renders an error with Retry, not the empty thread state", async () => {
  const { attempts } = await openViaParentLookup({
    response: { status: 404, data: { error: "Channel not found or not visible" } },
  });

  assert.ok(await screen.findByText(en["message.threadPanel.loadFailedTitle"]));
  assert.ok(screen.queryByText(en["message.threadPanel.noRepliesTitle"]) === null);
  const retry = screen.getByTestId("thread-retry");
  assert.equal(attempts(), 1);

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await act(async () => {
      fireEvent.click(retry);
      await Promise.resolve();
    });
  } finally {
    console.error = originalConsoleError;
  }
  await waitFor(() => assert.equal(attempts(), 2, "Retry re-issues the lookup"));
});

test("a failed thread lookup error state is localized under zh-cn", async () => {
  await openViaParentLookup({ response: { status: 500, data: { error: "Failed to get thread info" } } }, "zh-cn");

  assert.ok(await screen.findByText(zh["message.threadPanel.loadFailedTitle"]));
  assert.ok(screen.getByRole("button", { name: zh["message.threadPanel.retry"] }));
  assert.ok(screen.queryByText(zh["message.threadPanel.noRepliesTitle"]) === null);
});

test("a message with genuinely no thread yet still renders the empty thread state", async () => {
  await openViaParentLookup({
    response: { status: 404, data: { code: "THREAD_NOT_FOUND", error: "No thread found for this message" } },
  });

  assert.ok(await screen.findByText(en["message.threadPanel.noRepliesTitle"]));
  assert.ok(screen.queryByTestId("thread-retry") === null);
  assert.ok(screen.queryByText(en["message.threadPanel.loadFailedTitle"]) === null);
});

test("re-opening search on another server does not reuse the previous server's cached hits", async () => {
  seedStores();
  const searches: Array<string | undefined> = [];
  api.get = (async (url: string) => {
    if (url === "/messages/search") {
      const serverId = useServerStore.getState().current?.id;
      searches.push(serverId);
      return {
        data: {
          hasMore: false,
          results: serverId === "server-1"
            ? [threadHit]
            : [{ ...threadHit, id: "reply-b", channelId: "thread-b", content: "needle on server b", snippet: "needle on server b" }],
        },
      };
    }
    return { data: {} };
  }) as typeof api.get;

  const renderPage = () => rtlRender(
    <MemoryRouter initialEntries={["/s/server/search?q=needle"]}>
      <TestIntlProvider>
        <MessageSearchPage />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const first = renderPage();
  await waitFor(() => assert.match(document.body.textContent ?? "", /needle reply in thread/));
  first.unmount();

  // MainLayout is keyed by server id, so a server switch remounts the page
  // while the module-level results snapshot survives.
  useServerStore.setState({ current: { ...makeServer(), id: "server-2", slug: "server-b" } } as never);
  renderPage();
  assert.doesNotMatch(
    document.body.textContent ?? "",
    /needle reply in thread/,
    "the previous server's hits must not seed the new server's page",
  );
  await waitFor(() => assert.match(document.body.textContent ?? "", /needle on server b/));
  assert.equal(searches.at(-1), "server-2", "the new server issues its own search");
});

// Task #14 follow-up: the reported thread was ~34 days old on a Free server
// (30-day history). The focused reply's context 404s behind the cutoff, the
// panel falls back to the latest page, which is empty with historyLimited —
// that must render the plan history notice, never "No replies yet".
for (const focused of [true, false]) {
  test(`a thread whose replies are all behind the plan history cutoff shows the history-limit notice (${focused ? "focused reply" : "latest page"})`, async () => {
    seedStores();
    const gets: string[] = [];
    api.get = (async (url: string) => {
      gets.push(url);
      if (url.startsWith("/messages/context/reply-1")) {
        throw { response: { status: 404, data: { error: "Message not found" } } };
      }
      if (url.startsWith("/messages/context/parent-1")) {
        throw { response: { status: 404, data: { error: "Message not found" } } };
      }
      if (url.startsWith("/messages/channel/thread-1")) {
        return { data: { messages: [], historyLimited: true } };
      }
      return { data: {} };
    }) as typeof api.get;
    useThreadStore.setState({
      openParentChannelId: "channel-1",
      openParentMessageId: "parent-1",
      openThreadChannelId: "thread-1",
      openThreadError: null,
      openThreadLoading: false,
      focusedMessageId: focused ? "reply-1" : null,
    } as never);

    rtlRender(
      <MemoryRouter>
        <TestIntlProvider>
          <StoreDrivenThreadPanel />
        </TestIntlProvider>
      </MemoryRouter>,
    );

    // Opened on a specific reply → "this message is beyond the plan history";
    // opened on the thread itself → the generic plan history notice. Both
    // carry the billing entry point.
    const banner = await screen.findByTestId(focused ? "history-limit-target-banner" : "history-limit-banner");
    assert.match(
      banner.textContent ?? "",
      focused
        ? /This message is older than the \d+-day history available on the Free plan\. Upgrade to view it\./
        : /Message history is limited to \d+ days on the Free plan\./,
    );
    assert.ok(within(banner).getByRole("button", { name: en["message.chatPanel.viewBilling"] }));
    assert.ok(screen.queryByText(en["message.threadPanel.noRepliesTitle"]) === null, "not the empty-thread state");
    assert.ok(gets.some((url) => url.startsWith("/messages/channel/thread-1")));
  });
}

// Product decision: Free-plan search keeps returning hits older than the
// cutoff. Jumping to one (a channel hit) must say the message is beyond the
// plan's history range, with the billing CTA — not "Message not found".
for (const locale of ["en", "zh-cn"] as const) {
  test(`a cut-off channel jump target renders the beyond-history notice (${locale})`, () => {
    seedStores();
    api.get = (async () => ({ data: {} })) as typeof api.get;
    const channel = makeChannel();
    const visible = makeMessage({ id: "m-visible", content: "recent message", seq: 40 });
    useMessageStore.setState({
      currentChannelId: channel.id,
      channelMessages: { [channel.id]: [visible] },
      channelWindowMeta: {
        [channel.id]: {
          hasMore: false, hasNewer: false, historyLimited: true,
          loading: false, loadingOlder: false, loadingNewer: false,
          contextLoadError: CONTEXT_BEYOND_HISTORY_ERROR,
        },
      },
      loadMessages: async () => {}, loadMessageContext: async () => {}, loadMessageWindowSilent: async () => {},
      loadOlderMessages: async () => {}, loadNewerMessages: async () => {},
    } as never);
    const messages = locale === "en" ? en : zh;

    rtlRender(
      <MemoryRouter>
        <TestIntlProvider locale={locale}>
          <ChatPanel channel={channel} readOnly />
        </TestIntlProvider>
      </MemoryRouter>,
    );

    const banner = screen.getByTestId("history-limit-target-banner");
    if (locale === "en") {
      assert.match(banner.textContent ?? "", /This message is older than the \d+-day history available on the Free plan\. Upgrade to view it\./);
    } else {
      assert.match(banner.textContent ?? "", /\p{Script=Han}/u);
    }
    assert.ok(within(banner).getByRole("button", { name: messages["message.chatPanel.viewBilling"] }));
    assert.ok(screen.queryByText(messages["message.chatPanel.messageNotFound"]) === null, "not the generic not-found banner");
  });
}

for (const plan of ["free", "pro"] as const) {
  test(`search hits older than the plan history range carry an "Upgrade to view" badge (${plan})`, async () => {
    seedStores();
    useServerStore.setState({ current: { ...makeServer(), plan } } as never);
    const day = 24 * 60 * 60 * 1000;
    api.get = (async (url: string) => {
      if (url === "/messages/search") {
        return {
          data: {
            hasMore: false,
            results: [
              { ...threadHit, id: "old-hit", content: "needle old", snippet: "needle old", createdAt: new Date(Date.now() - 40 * day).toISOString() },
              { ...threadHit, id: "new-hit", channelId: "thread-2", parentMessageId: "parent-2", content: "needle new", snippet: "needle new", createdAt: new Date(Date.now() - 2 * day).toISOString() },
            ],
          },
        };
      }
      return { data: {} };
    }) as typeof api.get;

    rtlRender(
      <MemoryRouter initialEntries={[`/s/server/search?q=needle-${plan}`]}>
        <TestIntlProvider>
          <MessageSearchPage />
        </TestIntlProvider>
      </MemoryRouter>,
    );

    await waitFor(() => assert.match(document.body.textContent ?? "", /needle new/));
    const badges = screen.queryAllByTestId("search-hit-beyond-history");
    if (plan === "free") {
      assert.equal(badges.length, 1, "only the hit older than 30 days is flagged");
      assert.equal(badges[0]?.textContent, en["search.beyondHistory"]);
      const oldHit = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("needle old"));
      assert.ok(oldHit?.contains(badges[0]!));
    } else {
      assert.equal(badges.length, 0, "unlimited-history plans flag nothing");
    }
  });
}
