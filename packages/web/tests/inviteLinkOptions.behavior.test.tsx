import "./helpers/domSetup";

import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import InviteHumanDialog from "../src/components/member/InviteHumanDialog";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import { useServerStore } from "../src/store/serverStore";
import { resetServerFeatureFlagsForTests } from "../src/store/serverFeatureFlags";

/**
 * Invite-link usage cap / expiry / revoke controls (task #79 Phase 1).
 *
 * The rules protected here: (1) editing ONE control must never silently drop
 * the other limit ("keep" reuses the current link's value); (2) if the create
 * fails after the old link was already deleted, the dialog must not keep showing
 * the now-dead link; (3) revoke invalidates the link with no replacement.
 */

const originalGet = api.get;
const originalPost = api.post;
const originalDelete = api.delete;
const originalServerState = useServerStore.getState();

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  api.delete = originalDelete;
  useServerStore.setState(originalServerState, true);
  resetServerFeatureFlagsForTests();
});

function seedServer() {
  useServerStore.setState({
    current: { id: "server-1", slug: "server-1", name: "Server 1", role: "owner" },
    billing: null,
    loadBilling: async () => {},
  } as never);
}

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

// A pre-existing LIMITED link so the seed effect starts both controls at "keep".
function loadLimitedLink() {
  api.get = (async () => ({
    data: [{ id: "link-1", token: "join-token", maxUses: 10, expiresAt: FUTURE, useCount: 2 }],
  })) as typeof api.get;
}

function renderDialog() {
  return render(
    <MemoryRouter initialEntries={["/s/server-1"]}>
      <TestIntlProvider>
        <InviteHumanDialog onClose={() => {}} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

async function openLinkTab() {
  await waitFor(() => assert.ok(screen.getByTestId("invite-tab-link")));
  fireEvent.click(screen.getByTestId("invite-tab-link"));
  // The usage-cap control is a raft-ui Select (a combobox), matching the role
  // selector — not a native <select>.
  await waitFor(() => assert.ok(screen.getByRole("combobox", { name: "Uses" })));
}

/**
 * Pick a value on one of the link-limit selectors. They are raft-ui Selects
 * (button + listbox), so `fireEvent.change` does nothing — open the trigger and
 * click the option, the same way the role-selector test drives its Select.
 */
async function choose(comboName: string, optionName: string) {
  const trigger = screen.getByRole("combobox", { name: comboName });
  assert.equal(trigger.tagName, "BUTTON", "the limit control must be the raft-ui Select, not a native <select>");
  fireEvent.click(trigger);
  const option = await screen.findByRole("option", { name: optionName });
  fireEvent.pointerDown(option);
  fireEvent.click(option);
}

test("editing only the usage cap keeps the existing expiry (no silent loosening)", async () => {
  seedServer();
  loadLimitedLink();
  const posts: Array<Record<string, unknown>> = [];
  api.delete = (async () => ({ data: {} })) as typeof api.delete;
  api.post = (async (url: string, body?: unknown) => {
    if (url.includes("/join-links")) posts.push(body as Record<string, unknown>);
    return { data: { link: { id: "link-2", token: "t2", maxUses: 5, expiresAt: FUTURE, useCount: 0 } } };
  }) as typeof api.post;

  renderDialog();
  await openLinkTab();

  // Change ONLY the usage cap; leave expiry at its seeded "keep".
  await choose("Uses", "5");
  fireEvent.click(screen.getByRole("button", { name: /update link/i }));

  await waitFor(() => assert.equal(posts.length, 1, "one create issued"));
  assert.equal(posts[0]!.maxUses, 5, "new cap applied");
  assert.equal(posts[0]!.expiresAt, FUTURE, "existing expiry preserved, not dropped to null");
});

test("editing only the expiry keeps the existing usage cap (the other rUI Select works too)", async () => {
  seedServer();
  // Seed the current expiry at 30 days, then pick 7 — so the assertion proves the
  // NEW selection took effect, not that the old "keep" value was retained.
  const THIRTY_DAYS = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  api.get = (async () => ({
    data: [{ id: "link-1", token: "join-token", maxUses: 10, expiresAt: THIRTY_DAYS, useCount: 2 }],
  })) as typeof api.get;
  const posts: Array<Record<string, unknown>> = [];
  api.delete = (async () => ({ data: {} })) as typeof api.delete;
  api.post = (async (url: string, body?: unknown) => {
    if (url.includes("/join-links")) posts.push(body as Record<string, unknown>);
    return { data: { link: { id: "link-2", token: "t2", maxUses: 10, expiresAt: FUTURE, useCount: 0 } } };
  }) as typeof api.post;

  renderDialog();
  await openLinkTab();

  // Change ONLY the expiry (30d → 7d); leave the usage cap at its seeded "keep".
  await choose("Expires", "7 days");
  fireEvent.click(screen.getByRole("button", { name: /update link/i }));

  await waitFor(() => assert.equal(posts.length, 1, "one create issued"));
  assert.equal(posts[0]!.maxUses, 10, "existing cap preserved, not dropped to unlimited");
  const expiresAt = posts[0]!.expiresAt as string;
  const daysOut = (new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
  assert.ok(daysOut > 6.9 && daysOut < 7.1, `expiry set to the chosen 7 days, not the seeded 30 (got ${daysOut})`);
});

test("choosing unlimited/never through the Selects explicitly clears both limits", async () => {
  seedServer();
  loadLimitedLink();
  const posts: Array<Record<string, unknown>> = [];
  api.delete = (async () => ({ data: {} })) as typeof api.delete;
  api.post = (async (url: string, body?: unknown) => {
    if (url.includes("/join-links")) posts.push(body as Record<string, unknown>);
    return { data: { link: { id: "link-4", token: "t4", maxUses: null, expiresAt: null, useCount: 0 } } };
  }) as typeof api.post;

  renderDialog();
  await openLinkTab();

  await choose("Uses", "Unlimited");
  await choose("Expires", "Never");
  fireEvent.click(screen.getByRole("button", { name: /update link/i }));

  await waitFor(() => assert.equal(posts.length, 1, "one create issued"));
  assert.equal(posts[0]!.maxUses, null, "usage cap explicitly cleared");
  assert.equal(posts[0]!.expiresAt, null, "expiry explicitly cleared");
});

test("create failure after delete does not keep showing the dead link", async () => {
  seedServer();
  loadLimitedLink();
  let deleted = false;
  api.delete = (async () => { deleted = true; return { data: {} }; }) as typeof api.delete;
  api.post = (async () => { throw { response: { data: { error: "boom" } } }; }) as typeof api.post;

  renderDialog();
  await openLinkTab();
  fireEvent.click(screen.getByRole("button", { name: /update link/i }));

  await waitFor(() => assert.equal(deleted, true, "old link was deleted"));
  // The old token must be gone from the field, not shown as if still valid.
  await waitFor(() => {
    const field = screen.getByLabelText("Invite Link") as HTMLInputElement;
    assert.equal(field.value.includes("join-token"), false, "dead token no longer shown");
  });
});

test("revoke deletes the link and leaves none active", async () => {
  seedServer();
  loadLimitedLink();
  let revokedId: string | null = null;
  api.delete = (async (url: string) => {
    revokedId = url.split("/").pop() ?? null;
    return { data: {} };
  }) as typeof api.delete;

  renderDialog();
  await openLinkTab();
  await waitFor(() => assert.ok(screen.getByTestId("invite-link-revoke")));
  fireEvent.click(screen.getByTestId("invite-link-revoke"));

  await waitFor(() => assert.equal(revokedId, "link-1", "the current link was revoked"));
  // No replacement created: the revoke control is gone (no active link).
  await waitFor(() => assert.equal(screen.queryByTestId("invite-link-revoke"), null));
});

test("retry after a failed create resends the same chosen limits (not unlimited)", async () => {
  seedServer();
  loadLimitedLink();
  api.delete = (async () => ({ data: {} })) as typeof api.delete;
  const posts: Array<Record<string, unknown>> = [];
  let joinLinkPosts = 0;
  api.post = (async (url: string, body?: unknown) => {
    if (url.includes("/join-links")) {
      posts.push(body as Record<string, unknown>);
      joinLinkPosts += 1;
      if (joinLinkPosts === 1) throw { response: { data: { error: "boom" } } };
    }
    return { data: { link: { id: "link-3", token: "t3", maxUses: 5, expiresAt: FUTURE, useCount: 0 } } };
  }) as typeof api.post;

  renderDialog();
  await openLinkTab();
  await choose("Uses", "5");

  fireEvent.click(screen.getByRole("button", { name: /update link/i }));
  await waitFor(() => assert.equal(posts.length, 1, "first create attempted"));
  fireEvent.click(screen.getByRole("button", { name: /update link/i }));
  await waitFor(() => assert.equal(posts.length, 2, "retry attempted"));

  // The retry must carry the SAME limits as the first attempt — the transient
  // clear after the failed create must not reset the draft to unlimited/never.
  assert.deepEqual({ m: posts[0]!.maxUses, e: posts[0]!.expiresAt }, { m: 5, e: FUTURE });
  assert.deepEqual({ m: posts[1]!.maxUses, e: posts[1]!.expiresAt }, { m: 5, e: FUTURE });
});
