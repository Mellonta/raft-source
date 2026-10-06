import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import api from "../src/api/client";
import AppLoginPage, { appLoginRedirect } from "../src/pages/AppLoginPage";
import { useAuthStore } from "../src/store/authStore";
import { TestIntlProvider } from "./helpers/intl";

// HarmonyOS web login: the signed-in user must explicitly confirm before the
// app gets its one-time code; cancel and expiry hand control back to the app.

const originalGet = api.get;
const originalPost = api.post;
const originalAssign = appLoginRedirect.assign;
let assigned: string[] = [];

function signIn() {
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "cindy@example.com",
      gravatarHash: "",
      name: "cindy zhao",
      displayName: "cindy zhao",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationDisplay: "translated",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
    loading: false,
    initialized: true,
  } as never);
}

beforeEach(() => {
  assigned = [];
  window.history.pushState({}, "", "/login/app?request=req-1");
  appLoginRedirect.assign = (url: string) => { assigned.push(url); };
  signIn();
});

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  appLoginRedirect.assign = originalAssign;
  window.history.pushState({}, "", "/");
});

test("confirming sends the browser to the app callback with the one-time code", async () => {
  const posts: string[] = [];
  api.get = (async () => ({ data: { expiresAt: "2099-01-01T00:00:00.000Z" } })) as never;
  api.post = (async (url: string) => {
    posts.push(url);
    return { data: { redirectUrl: "raft://login/callback?code=abc" } };
  }) as never;

  render(<TestIntlProvider><AppLoginPage /></TestIntlProvider>);
  assert.ok(await screen.findByText("Sign in to Raft"));
  assert.ok(screen.getByText(/cindy@example.com|cindy zhao/));
  // Nothing happens until the user confirms.
  assert.deepEqual(posts, []);

  const approve = await screen.findByRole("button", { name: "Confirm sign-in" });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(approve);
  });

  assert.deepEqual(posts, ["/auth/app-login/requests/req-1/approve"]);
  assert.deepEqual(assigned, ["raft://login/callback?code=abc"]);
  assert.ok(await screen.findByTestId("app-login-returned"));

  // If the browser dropped the automatic jump, a tap retries the same callback.
  fireEvent.click(screen.getByRole("button", { name: "Open the app" }));
  assert.deepEqual(assigned, ["raft://login/callback?code=abc", "raft://login/callback?code=abc"]);
});

test("cancel returns access_denied to the app", async () => {
  api.get = (async () => ({ data: { expiresAt: "2099-01-01T00:00:00.000Z" } })) as never;
  api.post = (async (url: string) => {
    assert.equal(url, "/auth/app-login/requests/req-1/deny");
    return { data: { redirectUrl: "raft://login/callback?error=access_denied" } };
  }) as never;

  render(<TestIntlProvider><AppLoginPage /></TestIntlProvider>);
  const cancel = await screen.findByRole("button", { name: "Cancel" });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(cancel);
  });
  assert.deepEqual(assigned, ["raft://login/callback?error=access_denied"]);
});

test("an expired request explains it and offers the way back to the app", async () => {
  api.get = (async () => {
    throw { response: { data: { code: "request_expired", redirectUrl: "raft://login/callback?error=expired" } } };
  }) as never;

  render(<TestIntlProvider><AppLoginPage /></TestIntlProvider>);
  assert.ok(await screen.findByText("This sign-in request has expired. Start sign-in again from the app."));
  assert.ok(screen.queryByRole("button", { name: "Confirm sign-in" }) === null);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Back to the app" }));
  });
  assert.deepEqual(assigned, ["raft://login/callback?error=expired"]);
});
