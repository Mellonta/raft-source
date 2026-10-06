import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import api from "../src/api/client";
import ResetPasswordPage from "../src/components/auth/ResetPasswordPage";
import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { useAuthStore } from "../src/store/authStore";

// Guards the fix that lets a reset link work while a session is already active
// (App.tsx renders ResetPasswordPage on `resetToken` alone, no longer gated on
// `!user`). The security-critical contract, per review: the page resets the
// LINK's own token server-side and must NEVER mutate the current session — so a
// logged-in user A opening user B's reset link resets B without touching A.

const initialAuthState = useAuthStore.getInitialState();

function renderReset(token: string) {
  const view = render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <ResetPasswordPage token={token} onBack={() => {}} />
      </IntlProviderWrapper>
    </LocaleProvider>,
  );
  const inputs = view.container.querySelectorAll<HTMLInputElement>('input[type="password"]');
  return { ...view, newPassword: inputs[0], confirmPassword: inputs[1] };
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  useAuthStore.setState(initialAuthState, true);
});

test("a successful reset clears ONLY the reset token, preserving other query params", async () => {
  window.history.replaceState({}, "", "/?reset=token-B&invite=inv&verify=vf");
  vi.spyOn(api, "post").mockImplementation(async () => ({ data: {} }));

  const { newPassword, confirmPassword, container } = renderReset("token-B");
  fireEvent.change(newPassword, { target: { value: "brand-new-pass-123" } });
  fireEvent.change(confirmPassword, { target: { value: "brand-new-pass-123" } });
  fireEvent.submit(container.querySelector("form")!);

  await waitFor(() => assert.doesNotMatch(window.location.search, /reset=/, "reset token must be cleared after success"));
  assert.match(window.location.search, /invite=inv/, "invite param must survive the reset cleanup");
  assert.match(window.location.search, /verify=vf/, "verify param must survive the reset cleanup");
});

test("logged-in A resetting B's token: submits B's token, A's session untouched", async () => {
  const userA = { id: "user-A", email: "a@example.com", emailVerified: true } as never;
  useAuthStore.setState({ user: userA } as never);

  const calls: Array<{ url: string; body: { token?: string; password?: string } }> = [];
  vi.spyOn(api, "post").mockImplementation(async (url: string, body: { token?: string; password?: string }) => {
    calls.push({ url, body });
    return { data: {} };
  });

  const { newPassword, confirmPassword, container } = renderReset("token-for-B");
  fireEvent.change(newPassword, { target: { value: "brand-new-pass-123" } });
  fireEvent.change(confirmPassword, { target: { value: "brand-new-pass-123" } });
  fireEvent.submit(container.querySelector("form")!);

  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].url, "/auth/reset-password");
  assert.equal(calls[0].body.token, "token-for-B", "must submit the link's own token, not the current user's");
  // A's session must be byte-identical — no implicit logout / login / user swap.
  assert.equal(useAuthStore.getState().user, userA, "the logged-in session must not be mutated by a reset");
});

test("invalid/expired token surfaces an error and does not clear the session", async () => {
  const userA = { id: "user-A", email: "a@example.com", emailVerified: true } as never;
  useAuthStore.setState({ user: userA } as never);
  vi.spyOn(api, "post").mockImplementation(async () => {
    throw Object.assign(new Error("bad"), { response: { data: { code: "invalid_or_expired" } } });
  });

  const { newPassword, confirmPassword, container } = renderReset("expired-token");
  fireEvent.change(newPassword, { target: { value: "brand-new-pass-123" } });
  fireEvent.change(confirmPassword, { target: { value: "brand-new-pass-123" } });
  fireEvent.submit(container.querySelector("form")!);

  // The error banner is `<Banner … className="mb-4 font-bold">{error}</Banner>`.
  await waitFor(() => {
    const banner = container.querySelector(".mb-4.font-bold");
    assert.ok(banner && banner.textContent && banner.textContent.trim().length > 0, "a failure must surface an error banner");
  });
  assert.equal(useAuthStore.getState().user, userA, "a failed reset must not disturb the session");
});

test("client-side validation blocks the request (short / mismatched password)", async () => {
  const calls: number[] = [];
  vi.spyOn(api, "post").mockImplementation(async () => { calls.push(1); return { data: {} }; });

  const { newPassword, confirmPassword, container } = renderReset("token");
  fireEvent.change(newPassword, { target: { value: "short" } });
  fireEvent.change(confirmPassword, { target: { value: "short" } });
  fireEvent.submit(container.querySelector("form")!);
  await Promise.resolve();
  assert.equal(calls.length, 0, "too-short password must not hit the server");

  fireEvent.change(newPassword, { target: { value: "long-enough-pass" } });
  fireEvent.change(confirmPassword, { target: { value: "different-pass-xx" } });
  fireEvent.submit(container.querySelector("form")!);
  await Promise.resolve();
  assert.equal(calls.length, 0, "mismatched confirmation must not hit the server");
});
