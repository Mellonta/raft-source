import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TestIntlProvider } from "./helpers/intl";
import { SidebarConversationFinder } from "../src/components/layout/SidebarConversationFinder";
import { isElectronDesktopShell } from "../src/utils/desktopShell";

// The "Find a conversation…" sidebar jump box is Electron-desktop only: web
// withdraws it (@artin 2026-09-11, #kabi-desktop). Sidebar.tsx gates the block on
// `railMode === "chat" && isElectronDesktopShell()`.
//
// This file pins BOTH halves that the release gate asks for, in both directions:
//   1. the desktop-shell predicate is true only with the electron preload flag
//      (a flipped predicate turns this RED)
//   2. the gated element renders under the desktop reading, and does not render
//      under the web reading (dropping the gate in Sidebar.tsx turns the web half
//      of the Sidebar-level assertion RED — see the sibling behaviour test)
//
// Web-only runs are a degenerate reading for "shows in Electron": that half is
// proven on a real desktop shell by @archer, per the release gate. Both are needed.
//
// Run: `pnpm --filter @botiverse/raft-web test:dom`.

type DesktopWindow = { raftDesktop?: { isDesktop?: boolean } };

function setDesktopFlag(isDesktop: boolean | undefined) {
  if (isDesktop === undefined) {
    delete (window as DesktopWindow).raftDesktop;
    return;
  }
  (window as DesktopWindow).raftDesktop = { isDesktop };
}

const originalFlag = (window as DesktopWindow).raftDesktop;

afterEach(() => {
  cleanup();
  if (originalFlag === undefined) {
    delete (window as DesktopWindow).raftDesktop;
  } else {
    (window as DesktopWindow).raftDesktop = originalFlag;
  }
});

const finderProps = {
  channels: [],
  dmChannels: [],
  agents: [],
  members: [],
  currentUserId: null,
  onOpenChannel: () => {},
  onOpenDm: () => {},
  onOpenAgentDm: () => {},
  onOpenHumanDm: () => {},
};

test("desktop-shell predicate discriminates web from the electron preload flag", () => {
  setDesktopFlag(undefined);
  assert.equal(isElectronDesktopShell(), false, "web (no preload flag) must not read as desktop");

  setDesktopFlag(false);
  assert.equal(isElectronDesktopShell(), false, "an explicit false must not read as desktop");

  setDesktopFlag(true);
  assert.equal(isElectronDesktopShell(), true, "the electron preload flag must read as desktop");
});

test("the two readings the Sidebar gate depends on are different values", () => {
  // A criterion whose two sides read the same value cannot fail for the right
  // reason; this is the guard for the assertion below.
  setDesktopFlag(true);
  const desktopReading = isElectronDesktopShell();
  setDesktopFlag(undefined);
  const webReading = isElectronDesktopShell();

  assert.equal(desktopReading, true);
  assert.equal(webReading, false);
  assert.notEqual(desktopReading, webReading, "desktop and web readings must discriminate");
});

test("the conversation finder element exists and carries its stable testid", () => {
  // Positive control for the element the gate protects: without this, a
  // `queryByTestId(...) === null` assertion elsewhere could pass because the
  // testid itself is wrong rather than because the element is hidden.
  setDesktopFlag(true);
  render(
    <TestIntlProvider>
      <MemoryRouter>
        <SidebarConversationFinder {...finderProps} />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  assert.ok(
    screen.getByTestId("sidebar-conversation-finder-input"),
    "the finder input must render (positive control for the testid used by the gate assertion)",
  );
});

// Task #100: in a narrow finder the channel NAME is the identifier and must not
// be the part that truncates first — "proj-frontend" and "proj-frontend-perf"
// both read "proj-fr…" while a shrink-0 45% description column kept its width.
// The label takes its natural width; the description is the flexible part.
test("finder rows give the channel name width priority over its description", () => {
  setDesktopFlag(true);
  const longDescription = "Frontend performance working group — budgets, traces and regressions";
  render(
    <TestIntlProvider>
      <MemoryRouter>
        <SidebarConversationFinder
          {...finderProps}
          channels={[
            { id: "c1", name: "proj-frontend", description: "Raft web frontend", type: "channel" },
            { id: "c2", name: "proj-frontend-perf", description: longDescription, type: "channel" },
          ] as never}
        />
      </MemoryRouter>
    </TestIntlProvider>,
  );
  const input = screen.getByTestId("sidebar-conversation-finder-input");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "front" } });

  const label = screen.getByText("proj-frontend-perf");
  const row = label.closest("button");
  assert.ok(row, "result row must render");
  const sublabel = within(row).getByText(longDescription);
  const group = label.parentElement;
  assert.ok(group && group === sublabel.parentElement, "label and sublabel share one text group");
  for (const cls of ["grid", "min-w-0", "flex-1", "grid-cols-[minmax(0,auto)_minmax(0,1fr)]"]) assert.ok(group.classList.contains(cls), `text group needs ${cls}`);
  for (const cls of ["min-w-0", "truncate"]) assert.ok(label.classList.contains(cls), `label needs ${cls}`);
  for (const cls of ["min-w-0", "truncate"]) assert.ok(sublabel.classList.contains(cls), `sublabel needs ${cls}`);
  assert.ok(!sublabel.classList.contains("shrink-0") && !sublabel.classList.contains("max-w-[45%]"), "description must yield, not reserve width");
});
