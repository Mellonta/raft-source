import "./helpers/domSetup";

import assert from "node:assert/strict";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ServerSwitcherMenu from "../src/components/ui/ServerSwitcherMenu";
import { TestIntlProvider } from "./helpers/intl";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";

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

function seed() {
  useServerStore.setState({
    current: baseServer,
    servers: [baseServer],
    members: [],
    loading: false,
    updateServerOrder: async () => {},
    loadBilling: async () => {},
  } as never);
}

const OriginalResizeObserver = globalThis.ResizeObserver;
afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = OriginalResizeObserver;
});

// The task #83 fit re-runs on layout changes via a ResizeObserver; it must subscribe to
// the menu while open and tear the subscription down so it can't fire after unmount.
test("observes the menu while open and disconnects it on unmount", () => {
  const observed: Element[] = [];
  let disconnects = 0;
  class SpyResizeObserver {
    observe(el: Element): void { observed.push(el); }
    unobserve(): void {}
    disconnect(): void { disconnects += 1; }
  }
  (globalThis as typeof globalThis & { ResizeObserver: typeof SpyResizeObserver })
    .ResizeObserver = SpyResizeObserver;

  seed();
  const { unmount } = render(
    <MemoryRouter initialEntries={["/s/alpha"]}>
      <TestIntlProvider>
        <ServerSwitcherMenu open onClose={() => {}} serverUnreadCounts={{}} testId="switcher" />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(observed.length >= 1, "subscribes the observer while open");
  assert.equal(observed[0].getAttribute("data-testid"), "switcher", "observes the menu element");

  unmount();
  assert.ok(disconnects >= 1, "disconnects the observer on unmount");
});
