import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import { AppShell } from "../src/App";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { PENDING_INVITE_STORAGE_KEY } from "../src/utils/socialAuth";

// Routing/side-effect-layer coverage for the "reset link works while signed in"
// fix (App.tsx renders ResetPasswordPage on resetToken alone). Renders the real
// <AppShell/> so the logged-in-only side effects (pending-invite resume,
// last-location resume) are actually exercised — a direct ResetPasswordPage
// mount would not catch them. Contract: reset wins, the ?reset token is NOT
// clobbered, and a stored invite is NOT consumed while resetting (so it resumes
// afterward).

const originalGet = api.get;
const originalPost = api.post;

function signInVerified() {
  useAuthStore.setState({
    user: {
      id: "user-A",
      email: "a@example.com",
      gravatarHash: "",
      name: "a",
      displayName: "A",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      profileSetupCompletedAt: "2026-08-21T00:00:00.000Z",
    },
    initialized: true,
    restoreState: "authenticated",
    loadUser: async () => {},
  } as never);
  useServerStore.setState({
    servers: [],
    current: null,
    members: [],
    loading: false,
    loadServers: async () => {},
  } as never);
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  localStorage.clear();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

test("signed-in user with a reset token sees the reset form; a pending invite is NOT consumed or allowed to clobber ?reset", async () => {
  signInVerified();
  // A stored pending invite that the logged-in resume effect would normally take.
  window.localStorage.setItem(PENDING_INVITE_STORAGE_KEY, "invite-token");
  // The reset token arrives as a query param (getUrlParams reads window.location.search).
  // Include an unrelated param to prove reset never strips foreign query state.
  window.history.replaceState({}, "", "/?reset=reset-token-B&ref=welcome-email");

  const posts: Array<{ url: string }> = [];
  api.post = (async (url: string) => { posts.push({ url }); return { data: {} }; }) as typeof api.post;
  api.get = (async () => ({ data: {} })) as typeof api.get;

  const { container } = render(
    <TestIntlProvider locale="en">
      <MemoryRouter initialEntries={["/?reset=reset-token-B&ref=welcome-email"]}>
        <AppShell />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  // The reset form renders (two password inputs) rather than the app / invite page.
  await waitFor(() => assert.equal(container.querySelectorAll('input[type="password"]').length, 2, "reset form should render for a signed-in user"));
  // The pending invite must NOT be consumed while a reset is in progress…
  assert.equal(window.localStorage.getItem(PENDING_INVITE_STORAGE_KEY), "invite-token", "reset must not consume the pending invite");
  // …and nothing should have auto-accepted the invite.
  assert.deepEqual(posts.filter((p) => p.url === "/auth/accept-invite"), [], "no invite acceptance during reset");
  // The reset token must remain in the address bar (not clobbered to ?invite=…).
  assert.match(window.location.search, /reset=reset-token-B/, "?reset must survive (refresh-continuable)");
  // Unrelated query params must be preserved (reset never rewrites foreign state).
  assert.match(window.location.search, /ref=welcome-email/, "unrelated query params must be preserved");
});

test("onBack (leave-reset path) removes ONLY reset, keeping invite/verify for the reload to resume", async () => {
  signInVerified();
  window.history.replaceState({}, "", "/?reset=reset-token-B&invite=inv&verify=vf");
  // onBack calls window.location.reload() after the replaceState we observe; in
  // jsdom reload is a harmless no-op, so window.location still reflects the
  // replaceState (search minus reset, other params kept).
  api.get = (async () => ({ data: {} })) as typeof api.get;
  api.post = (async () => ({ data: {} })) as typeof api.post;

  const { container } = render(
    <TestIntlProvider locale="en">
      <MemoryRouter initialEntries={["/?reset=reset-token-B&invite=inv&verify=vf"]}>
        <AppShell />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  await waitFor(() => assert.ok(container.querySelector('input[type="password"]'), "reset form should render"));
  // Click the in-form "back to sign in" link (the non-submit button).
  const back = Array.from(container.querySelectorAll("button")).find((b) => b.getAttribute("type") !== "submit");
  assert.ok(back, "reset form should expose a back control");
  fireEvent.click(back!);

  assert.doesNotMatch(window.location.search, /reset=/, "onBack must drop the reset token");
  assert.match(window.location.search, /invite=inv/, "onBack must keep the invite param");
  assert.match(window.location.search, /verify=vf/, "onBack must keep the verify param");
});
