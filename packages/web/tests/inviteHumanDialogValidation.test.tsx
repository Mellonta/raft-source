import "./helpers/domSetup";

import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { INVALID_EMAIL_MESSAGE, SERVER_GUEST_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import InviteHumanDialog from "../src/components/member/InviteHumanDialog";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import { useServerStore } from "../src/store/serverStore";
import { resetServerFeatureFlagsForTests } from "../src/store/serverFeatureFlags";

const originalGet = api.get;
const originalPost = api.post;
const originalServerState = useServerStore.getState();

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  useServerStore.setState(originalServerState, true);
  resetServerFeatureFlagsForTests();
});

function seedInviteServer() {
  useServerStore.setState({
    current: { id: "server-1", slug: "server-1", name: "Server 1", role: "owner" },
    billing: null,
    loadBilling: async () => {},
  } as never);
}

function seedFullInviteServer() {
  useServerStore.setState({
    current: { id: "server-1", slug: "server-1", name: "Server 1", role: "owner" },
    billing: {
      plan: "pro",
      displayName: "Pro",
      serverPlan: "pro",
      source: "subscription",
      capacity: { maxHumans: 1, maxAgents: 10, maxUniversalSeats: 1 },
      usage: { humans: 1, agents: 0, universalSeats: 1 },
      provisioned: { humans: 1, agents: 0, proPackQuantity: 1, trialFreePackQuantity: 0 },
    },
    loadBilling: async () => {},
  } as never);
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderInviteDialog(onClose = () => {}) {
  return render(
    <MemoryRouter initialEntries={["/s/server-1"]}>
      <TestIntlProvider>
        <LocationProbe />
        <InviteHumanDialog onClose={onClose} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

async function readyDialog() {
  api.get = (async () => ({
    data: [{ id: "link-1", token: "join-token" }],
  })) as typeof api.get;
  seedInviteServer();
  renderInviteDialog();
  assert.ok(await screen.findByText("Invite Human"));
}

test("InviteHumanDialog validates and trims email inputs before posting invites", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  api.post = ((url: string, body?: unknown) => {
    posts.push({ url, body });
    return Promise.resolve({ data: {} });
  }) as typeof api.post;

  await readyDialog();
  const input = screen.getAllByPlaceholderText("name@company.com")[0]!;
  const form = input.closest("form");
  assert.ok(form);

  // `foo@bar` satisfies HTML5 `type="email"` but fails validateEmailAddress
  // (domain has no dot), so the JS guard is the one that must fire.
  fireEvent.change(input, { target: { value: "foo@bar" } });
  fireEvent.submit(form);
  assert.ok(await screen.findByText(INVALID_EMAIL_MESSAGE));
  // Scoped to the invites endpoint, not "no POST at all". The dialog now reads
  // the server-guest gate to decide whether to offer a role, and that hook
  // POSTs `/feature-flags/evaluate` on mount — an unrelated call that would
  // otherwise fail this assertion while the property it names still holds.
  const invitePosts = posts.filter((post) => post.url.includes("/invites"));
  assert.equal(invitePosts.length, 0, "invalid emails must not reach the invites API");

  fireEvent.change(input, { target: { value: "  ada@example.com  " } });
  fireEvent.submit(form);
  await waitFor(() => {
    // Again scoped to invites, and the body now carries `role`. The role is
    // asserted as `member` rather than omitted: the dialog states it explicitly
    // instead of relying on a server default, so the value that leaves the
    // client is the value the inviter saw.
    assert.deepEqual(posts.filter((post) => post.url.includes("/invites")), [
      { url: "/servers/server-1/invites", body: { email: "ada@example.com", role: "member" } },
    ]);
  });
});

test("InviteHumanDialog routes successful invites to Administration settings", async () => {
  let closed = false;
  api.get = (async () => ({
    data: [{ id: "link-1", token: "join-token" }],
  })) as typeof api.get;
  api.post = (async () => ({ data: {} })) as typeof api.post;
  seedInviteServer();
  render(
    <MemoryRouter initialEntries={["/s/server-1"]}>
      <TestIntlProvider>
        <LocationProbe />
        <InviteHumanDialog onClose={() => {
          closed = true;
        }} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  assert.ok(await screen.findByText("Invite Human"));

  fireEvent.change(screen.getAllByPlaceholderText("name@company.com")[0]!, {
    target: { value: "ada@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send invites" }));

  await waitFor(() => {
    assert.equal(closed, true);
    assert.equal(screen.getByTestId("location").textContent, "/s/server-1/settings/administration");
  });
  assert.notEqual(
    screen.getByTestId("location").textContent,
    "/s/server-1/settings/server",
    "successful invites must not land on Server Profile",
  );
});

test("InviteHumanDialog allows Guest invites at the paid human seat limit but blocks Member invites", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  api.get = (async () => ({ data: [{ id: "link-1", token: "join-token" }] })) as typeof api.get;
  api.post = ((url: string, body?: unknown) => {
    posts.push({ url, body });
    if (url === "/feature-flags/evaluate") {
      return Promise.resolve({
        data: { evaluations: [{ key: SERVER_GUEST_FEATURE_FLAG_KEY, enabled: true }] },
      });
    }
    return Promise.resolve({ data: {} });
  }) as typeof api.post;
  seedFullInviteServer();
  renderInviteDialog();

  const email = await screen.findByPlaceholderText("name@company.com");
  fireEvent.change(email, { target: { value: "guest@example.com" } });

  const send = screen.getByRole("button", { name: "Send invites" });
  assert.equal(send.hasAttribute("disabled"), true, "Member invite must consume the unavailable seat");

  const role = await screen.findByRole("combobox", { name: "Role" });
  fireEvent.click(role);
  const guestOption = await screen.findByRole("option", { name: "Guest" });
  fireEvent.pointerDown(guestOption);
  fireEvent.click(guestOption);
  await waitFor(() => assert.equal(send.hasAttribute("disabled"), false));

  fireEvent.click(screen.getByRole("button", { name: "Add another" }));
  const secondEmail = screen.getAllByPlaceholderText("name@company.com")[1]!;
  assert.equal(send.hasAttribute("disabled"), false, "an ignored blank Member row must not block a Guest invite");
  fireEvent.change(secondEmail, { target: { value: "member@example.com" } });
  assert.equal(send.hasAttribute("disabled"), true, "a mixed batch needing a paid seat must be blocked atomically");
  fireEvent.change(secondEmail, { target: { value: "" } });
  assert.equal(send.hasAttribute("disabled"), false, "removing the seat-consuming target must recover immediately");

  fireEvent.click(send);
  await waitFor(() => {
    assert.deepEqual(posts.filter((post) => post.url.includes("/invites")), [
      { url: "/servers/server-1/invites", body: { email: "guest@example.com", role: "guest" } },
    ]);
  });
});
