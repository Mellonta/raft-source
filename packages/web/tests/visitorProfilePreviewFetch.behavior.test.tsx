import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render, waitFor } from "@testing-library/react";

import { TestIntlProvider } from "./helpers/intl";
import ProfilePreviewCardContent from "../src/components/message/ProfilePreviewCardContent";
import api from "../src/api/client";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";

// #wg-rbac task #115: hovering an agent avatar (or an @agent mention) on a
// public server page logged a signed-out visitor OUT and redirected them to the
// landing page.
//
// The chain, each link measured rather than assumed:
//   hover 200ms -> this card mounts -> GET /agents/:id (an authenticated route)
//   -> 401 -> the response interceptor tries a refresh -> a visitor has no
//   refresh token -> getAuthVerdict({hasRefreshToken:false}) === "logout"
//   -> clearAuthAndRedirect() -> window.location.href = "/"
//
// So the guard belongs on the request: a viewer with no session can never be
// authorized for this endpoint, and the card renders its "unavailable" body
// without it. The signed-in case below is the control — without it a fix that
// simply never fetched would also pass.

const ORIGINAL_GET = api.get.bind(api);

afterEach(() => {
  cleanup();
  (api as unknown as { get: typeof ORIGINAL_GET }).get = ORIGINAL_GET;
  useAgentStore.setState({ agents: [], trajectoryLogs: {} } as never);
  useAuthStore.setState({ user: null } as never);
});

function recordRequests() {
  const urls: string[] = [];
  (api as unknown as { get: unknown }).get = async (url: string) => {
    urls.push(url);
    const error = new Error("Unauthorized") as Error & { response?: { status: number } };
    error.response = { status: 401 };
    throw error;
  };
  return urls;
}

function renderCard() {
  return render(
    <TestIntlProvider locale="en">
      <ProfilePreviewCardContent mentionType="agent" mentionId="agent-1" fallbackLabel="someagent" />
    </TestIntlProvider>,
  );
}

test("a signed-out visitor's profile card issues no request", async () => {
  const urls = recordRequests();
  useAuthStore.setState({ user: null, initialized: true } as never);
  useAgentStore.setState({ agents: [], trajectoryLogs: {} } as never);

  renderCard();

  // Effects run on mount; give any queued microtask a chance to fire before
  // concluding nothing was requested.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(urls, [], "a visitor must not request a private agent profile");
});

test("a signed-in viewer still hydrates the profile", async () => {
  const urls = recordRequests();
  useAuthStore.setState({ user: { id: "u1", name: "U" }, initialized: true } as never);
  useAgentStore.setState({ agents: [], trajectoryLogs: {} } as never);

  renderCard();

  await waitFor(() => {
    assert.ok(urls.includes("/agents/agent-1"), "a signed-in viewer must still load the profile");
  });
});
