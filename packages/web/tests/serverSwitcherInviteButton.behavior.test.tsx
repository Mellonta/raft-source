import "./helpers/installResizeObserver";
import assert from "node:assert/strict";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ServerSwitcherMenu from "../src/components/ui/ServerSwitcherMenu";
import { TestIntlProvider } from "./helpers/intl";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import type { ServerRole } from "@botiverse/raft-shared";

const baseServer: Server = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "Alpha",
  avatarUrl: null,
  slug: "alpha",
  ownerId: "user-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "pro",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-06-27T00:00:00.000Z",
};

function setStore(role: ServerRole) {
  useServerStore.setState({
    current: { ...baseServer, role },
    servers: [{ ...baseServer, role }],
    members: [],
    loading: false,
    updateServerOrder: async () => {},
    // InviteHumanDialog calls loadBilling() on mount — provide a no-op so the
    // dialog can open in the test environment.
    loadBilling: async () => {},
  } as never);
}

function renderMenu(role: ServerRole) {
  setStore(role);
  return render(
    <MemoryRouter initialEntries={["/s/alpha"]}>
      <TestIntlProvider>
        <ServerSwitcherMenu open onClose={() => {}} serverUnreadCounts={{}} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

test("owner sees the Invite people entry in the workspace switcher", () => {
  renderMenu("owner");
  assert.ok(screen.getByTestId("server-switcher-invite"), "owner must see the invite entry");
});

test("a member without invite capability does not see the invite entry", () => {
  renderMenu("member");
  assert.equal(
    screen.queryByTestId("server-switcher-invite"),
    null,
    "the invite entry must be gated by capabilities.inviteMembers",
  );
});

test("clicking Invite opens the invite dialog and it survives the menu closing", () => {
  // The menu dismisses itself on invite click (onClose), so the dialog — a child
  // of this component — must stay mounted after `open` flips to false.
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <MemoryRouter initialEntries={["/s/alpha"]}>
        <TestIntlProvider>
          <ServerSwitcherMenu open={open} onClose={() => setOpen(false)} serverUnreadCounts={{}} />
        </TestIntlProvider>
      </MemoryRouter>
    );
  }
  setStore("owner");
  render(<Harness />);

  assert.equal(screen.queryByRole("heading", { name: "Invite Human" }), null, "dialog starts closed");
  fireEvent.click(screen.getByTestId("server-switcher-invite"));

  // Menu itself is gone (open=false) but the dialog persists.
  assert.equal(screen.queryByTestId("server-switcher-menu"), null, "menu closed on invite click");
  assert.ok(
    screen.getByRole("heading", { name: "Invite Human" }),
    "invite dialog must stay mounted after the menu closes",
  );
});
