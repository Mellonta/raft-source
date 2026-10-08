// Exercise upstream mechanisms explicitly; mellontaPrivacy.test.ts verifies the shipped policy.
vi.mock("@botiverse/raft-shared/src/distributionPolicy", async (importOriginal) => ({
  ...await importOriginal<typeof import("@botiverse/raft-shared/src/distributionPolicy")>(),
  DISTRIBUTION_POLICY: { forkReleases: false, managedMcp: true, diagnosticUploads: true, tracing: true, productAnalytics: true, upstreamServices: true, externalAvatars: true },
}));

import "./helpers/domSetup";
import assert from "node:assert/strict";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import api from "../src/api/client";
import { useAuthStore } from "../src/store/authStore";
import type { User } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { useFeedbackUnread } from "../src/feedback/useFeedbackUnread";
import { acceptFeedbackUnread } from "../src/feedback/feedbackUnreadState";
import { handsFeedbackTransport } from "../src/feedback/handsFeedbackTransport";
import { LeftRail } from "../src/components/layout/LeftRail";
import { MobileTabBar } from "../src/components/layout/MainLayout";
import SettingsSidebarList from "../src/components/settings/SettingsSidebarList";
import SettingsNavList from "../src/components/settings/SettingsNavList";
import { useWorkspaceGridNavigationStore } from "../src/components/workspace/workspaceGridNavigationStore";
import NotificationTrigger from "../src/components/layout/NotificationTrigger";
import { TestIntlProvider } from "./helpers/intl";

const originalMatchMedia = window.matchMedia;
const originalWorkspace = useWorkspaceGridNavigationStore.getState();
const originalGet = api.get;
const originalUser = useAuthStore.getState().user;
const originalServer = useServerStore.getState().current;
function user(id: string) { useAuthStore.setState({ user: { id } as User }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  api.get = originalGet;
  useWorkspaceGridNavigationStore.setState(originalWorkspace, true);
  useAuthStore.setState({ user: originalUser });
  useServerStore.setState({ current: originalServer });
});

test("anonymous hosts do not fetch; desktop/mobile share one fetch and authoritative total", async () => {
  let calls = 0;
  api.get = (async (_url, config) => {
    calls += 1;
    assert.deepEqual(config?.params, { limit: 1 });
    return { data: { unread_total: 4, tickets: [{ unread_count: 20 }] } };
  }) as typeof api.get;
  useAuthStore.setState({ user: null });
  const a = renderHook(useFeedbackUnread);
  const b = renderHook(useFeedbackUnread);
  assert.equal(calls, 0);
  await act(async () => user("alice"));
  await waitFor(() => assert.equal(a.result.current, 4));
  assert.equal(b.result.current, 4);
  assert.equal(calls, 1);
  a.unmount();
  act(() => acceptFeedbackUnread("alice", 2));
  assert.equal(b.result.current, 2);
});

test("late list cannot resurrect unread after detail; transient failure retains count", async () => {
  user("alice");
  const oldList = deferred<{ data: { unread_total: number } }>();
  let listCalls = 0;
  api.get = (async (url) => {
    if (url === "/product-feedback/tickets") {
      listCalls += 1;
      if (listCalls === 1) return { data: { unread_total: 3 } };
      if (listCalls === 2) return oldList.promise;
      throw new Error("offline");
    }
    return { data: {
      ticket: { id: "ticket", kind: "feedback", status: "open", unread: false, unread_count: 0 },
      comments: [], attachments: [], next_comment_cursor: null, unread_total: 1,
    } };
  }) as typeof api.get;
  const { result } = renderHook(useFeedbackUnread);
  await waitFor(() => assert.equal(result.current, 3));
  act(() => window.dispatchEvent(new window.Event("focus")));
  await act(async () => {
    await handsFeedbackTransport.getTicket({ ticketId: "ticket", commentLimit: 50 });
  });
  assert.equal(result.current, 1, "other unread tickets survive reading one ticket");
  await act(async () => oldList.resolve({ data: { unread_total: 3 } }));
  assert.equal(result.current, 1);
  await act(async () => window.dispatchEvent(new window.Event("focus")));
  assert.equal(result.current, 1);
});

test("account changes clear immediately and ignore the prior account response", async () => {
  user("alice");
  const stale = deferred<{ data: { unread_total: number } }>();
  let calls = 0;
  let oldSignal: AbortSignal | undefined;
  api.get = (async (_url, config) => {
    calls += 1;
    if (calls === 1) { oldSignal = config?.signal as AbortSignal; return stale.promise; }
    return { data: { unread_total: 0 } };
  }) as typeof api.get;
  const { result } = renderHook(useFeedbackUnread);
  await act(async () => user("bob"));
  assert.equal(oldSignal?.aborted, true);
  await act(async () => stale.resolve({ data: { unread_total: 99 } }));
  assert.equal(result.current, 0);
  act(() => acceptFeedbackUnread("alice", 5));
  assert.equal(result.current, 0);
  await act(async () => useAuthStore.setState({ user: null }));
  act(() => window.dispatchEvent(new window.Event("focus")));
  assert.equal(calls, 2);
});

test("hidden pages wait until visible and unmounted hosts stop refreshing", async () => {
  user("alice");
  let calls = 0;
  const descriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  api.get = (async () => { calls += 1; return { data: { unread_total: 1 } }; }) as typeof api.get;
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const { result, unmount } = renderHook(useFeedbackUnread);
    assert.equal(calls, 0);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => document.dispatchEvent(new window.Event("visibilitychange")));
    assert.equal(result.current, 1);
    unmount();
    act(() => window.dispatchEvent(new window.Event("focus")));
    assert.equal(calls, 1);
  } finally {
    if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});

function Location() { return <output data-testid="route">{useLocation().pathname}</output>; }
for (const flavor of ["rail-bottom", "mobile-navbar"] as const) {
  test(`${flavor}: entry fetch lights Bell, view navigates without clearing, detail clears`, async () => {
    user("alice");
    useServerStore.setState({ current: { id: "server", slug: "botiverse", role: "member", plan: "free" } as Server });
    api.get = (async (url) => {
      if (url === "/product-feedback/tickets") return { data: { unread_total: 2 } };
      return { data: {
        ticket: { id: "ticket", kind: "feedback", status: "open", unread: false, unread_count: 0 },
        comments: [], attachments: [], next_comment_cursor: null, unread_total: 0,
      } };
    }) as typeof api.get;
    render(<MemoryRouter initialEntries={["/s/botiverse/"]}><TestIntlProvider>
      <NotificationTrigger flavor={flavor} /><Location />
    </TestIntlProvider></MemoryRouter>);
    const trigger = screen.getByTestId(flavor === "rail-bottom" ? "notification-trigger-rail" : "notification-trigger-mobile");
    await waitFor(() => assert.equal(trigger.getAttribute("data-has-unread"), "true"));
    fireEvent.click(trigger);
    assert.ok(screen.getByText("2 feedback conversations have unread replies."));
    fireEvent.click(screen.getByRole("button", { name: "View feedback" }));
    assert.equal(screen.getByTestId("route").textContent, "/s/botiverse/settings/feedback");
    assert.equal(trigger.getAttribute("data-has-unread"), "true");
    await act(async () => { await handsFeedbackTransport.getTicket({ ticketId: "ticket", commentLimit: 50 }); });
    assert.equal(trigger.getAttribute("data-has-unread"), "false");
    assert.ok(!screen.queryByText("Feedback has new replies"));
  });
}

for (const workspace of [false, true]) {
  test(`settings (${workspace ? "workspace" : "classic"}): entrances and feedback rows share unread until detail is read`, async () => {
    user("alice");
    useServerStore.setState({ current: { id: "server", slug: "botiverse", role: "member", plan: "free" } as Server });
    useWorkspaceGridNavigationStore.setState({ active: workspace, enabled: workspace });
    window.matchMedia = ((media: string) => ({
      matches: false, media, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    })) as typeof window.matchMedia;
    let listCalls = 0;
    let detailCalls = 0;
    api.get = (async (url) => {
      if (url === "/product-feedback/tickets") {
        listCalls += 1;
        return { data: { unread_total: 2 } };
      }
      if (String(url).startsWith("/product-feedback/tickets/")) {
        detailCalls += 1;
        return { data: {
          ticket: { id: "ticket", kind: "feedback", status: "open", unread: false, unread_count: 0 },
          comments: [], attachments: [], next_comment_cursor: null, unread_total: 0,
        } };
      }
      return new Promise(() => {});
    }) as typeof api.get;
    let selected = "";
    render(<MemoryRouter initialEntries={["/s/botiverse/"]}><TestIntlProvider>
      <LeftRail side="left" />
      <MobileTabBar />
      <SettingsSidebarList activeId="account" groups={[{ label: "Settings", items: [
        { id: "feedback", label: "Feedback", icon: null, testId: "feedback-row", onClick: () => { selected = "feedback"; } },
        { id: "account", label: "Account", icon: null },
      ] }]} />
      <SettingsNavList activeTab="account" onSelect={(id) => { selected = id; }} />
    </TestIntlProvider></MemoryRouter>);
    const rail = screen.getByTestId(workspace ? "workspace-settings-trigger" : "left-rail-settings");
    const indicator = () => rail.querySelector('[data-slot="app-rail-item-indicator"]');
    await waitFor(() => assert.ok(indicator()));
    assert.equal(screen.getAllByTestId("feedback-unread-dot").length, 3, "mobile tab + classic feedback row + workspace feedback row");
    assert.equal(listCalls, 1, "settings and Bell retain one polling session");
    fireEvent.click(screen.getByTestId("feedback-row"));
    fireEvent.click(screen.getByTestId("workspace-settings-nav-feedback"));
    assert.equal(selected, "feedback");
    assert.equal(detailCalls, 0, "navigation alone never advances the read cursor");
    assert.ok(indicator());
    await act(async () => { await handsFeedbackTransport.getTicket({ ticketId: "ticket", commentLimit: 50 }); });
    assert.ok(!indicator());
    assert.equal(screen.queryAllByTestId("feedback-unread-dot").length, 0);
    assert.equal(screen.getByTestId("notification-trigger-rail").getAttribute("data-has-unread"), "false");
  });
}

test("disabled feedback consumer does not fetch or expose another host's unread", async () => {
  user("alice");
  let calls = 0;
  api.get = (async () => { calls += 1; return { data: { unread_total: 4 } }; }) as typeof api.get;
  const disabled = renderHook(() => useFeedbackUnread(false));
  assert.equal(calls, 0);
  const enabled = renderHook(() => useFeedbackUnread(true));
  await waitFor(() => assert.equal(enabled.result.current, 4));
  assert.equal(disabled.result.current, 0);
  enabled.unmount();
  act(() => window.dispatchEvent(new window.Event("focus")));
  assert.equal(calls, 1);
});
