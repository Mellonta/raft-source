import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TestIntlProvider } from "./helpers/intl";
import EditChannelDialog from "../src/components/channel/EditChannelDialog";
import { useChannelStore } from "../src/store/channelStore";
import { useServerStore } from "../src/store/serverStore";
import { useAuthStore } from "../src/store/authStore";
import { resetServerFeatureFlagsForTests, setServerFeatureFlagForTests } from "../src/store/serverFeatureFlags";
import { SERVER_GUEST_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

// Guest access section visibility (#wg-rbac task #114, Cindy 2026-09-22).
//
// A private channel cannot hold a guest policy at all: the channel PATCH route
// forces guestVisible and guestJoinable to false for it. The switches used to
// render permanently greyed out, which reads as "you can turn this on later"
// for something that can never turn on. They are now absent.
//
// #all is carved out in BOTH the UI and the server, because hiding #all is
// implemented AS `type: "private"` — its guest-visible switch is live, so a
// blanket type check would silently remove a control that works. That carve-out
// is what the third case below pins.
//
// TWO CONVENTIONS THIS FILE KEEPS, both learned the hard way here:
//
// 1. Absence is asserted as `assert.ok(queryByTestId(...) === null, msg)`, never
//    `assert.equal(queryByTestId(...), null)`. The two behave identically while
//    the test passes. When one FAILS, the second form hands the reporter a live
//    DOM element as `actual`, and the run dies with "Worker exited unexpectedly"
//    after ~120s with zero test results — no assertion message, no file name.
//    Measured against the pre-fix source: element form 125s and unreportable,
//    boolean form 5.9s and a readable failure. A guard whose failure mode is an
//    unattributable crash is barely a guard.
// 2. It is a behaviour file, not part of editChannelDialog.i18n.behavior, whose
//    subject is untranslated-copy residue.

const CHANNEL_ID = "c1";
const PROBE_NAME = "ai-research";

afterEach(() => {
  cleanup();
  useChannelStore.setState({ channels: [] } as never);
  useServerStore.setState({ servers: [], current: null, members: [] } as never);
  useAuthStore.setState({ user: null } as never);
  resetServerFeatureFlagsForTests();
});

/** Guest access is gated on the server guest flag plus the manageGuestAccess
 *  capability, which comes from the server store's role. With neither seeded the
 *  section never renders and every absence assertion below would pass vacuously. */
function seedGuestChannel(channelOver: Record<string, unknown> = {}) {
  const server = { id: "s1", slug: "s1", name: "S", role: "owner", plan: "pro" };
  useAuthStore.setState({ user: { id: "u1", name: "U" }, initialized: true } as never);
  useServerStore.setState({
    servers: [server],
    current: server,
    members: [],
    loading: false,
    sidebarOrder: {
      channelOrder: [], agentOrder: [], dmOrder: [],
      channelSortMode: "manual" as const, jointChannelSortMode: "manual" as const,
      dmSortMode: "manual" as const, pinnedSortMode: "manual" as const,
      pinned: [], pinnedChannelIds: [], pinnedAgentIds: [], pinnedOrder: [],
      hiddenDmIds: [], channelPanelTabOrder: [], agentPanelTabOrder: [], pinnedVersion: 0,
    },
  } as never);
  useChannelStore.setState({
    channels: [{
      id: CHANNEL_ID, name: PROBE_NAME, description: "", type: "channel",
      serverId: "s1", archivedAt: null, jointServers: [], ...channelOver,
    }],
  } as never);
  setServerFeatureFlagForTests("s1", SERVER_GUEST_FEATURE_FLAG_KEY, true);
  return String(channelOver.name ?? PROBE_NAME);
}

function renderDialog(name: string) {
  return render(
    <TestIntlProvider locale="zh-cn">
      <MemoryRouter>
        <EditChannelDialog
          channelId={CHANNEL_ID}
          initialName={name}
          initialDescription=""
          onLeaveChannel={async () => {}}
          onClose={() => {}}
        />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

test("a public channel still offers the guest access section", () => {
  renderDialog(seedGuestChannel());
  assert.ok(
    screen.queryByTestId("channel-settings-guest-access"),
    "the control case must render, or the absence assertions below prove nothing",
  );
  assert.ok(screen.queryByTestId("channel-settings-guest-visible-switch"));
  assert.ok(screen.queryByTestId("channel-settings-guest-joinable-switch"));
});

test("a private channel hides the guest access section instead of greying it out", () => {
  renderDialog(seedGuestChannel({ type: "private" }));
  assert.ok(screen.queryByTestId("channel-settings-guest-access") === null,
    "a private channel must not render the guest access section");
  // Absence of the section is the fix; absence of each switch is what the user
  // sees. Asserted separately so a future layout change cannot satisfy one while
  // leaving a stray switch behind.
  assert.ok(screen.queryByTestId("channel-settings-guest-visible-switch") === null, "channel-settings-guest-visible-switch must be absent");
  assert.ok(screen.queryByTestId("channel-settings-guest-joinable-switch") === null, "channel-settings-guest-joinable-switch must be absent");
  assert.ok(screen.queryByTestId("channel-settings-guest-joinable-usage") === null, "channel-settings-guest-joinable-usage must be absent");
});

test("a hidden #all channel is private but keeps its live guest-visible switch", () => {
  renderDialog(seedGuestChannel({ name: "all", type: "private" }));
  assert.ok(
    screen.queryByTestId("channel-settings-guest-access"),
    "hiding #all sets type=private; that must not take its guest section away",
  );
  const visible = screen.getByTestId("channel-settings-guest-visible-switch");
  assert.equal(visible.hasAttribute("disabled"), false,
    "#all's guest-visible switch is operable and must not be greyed out");
  assert.ok(screen.queryByTestId("channel-settings-guest-joinable-switch") === null,
    "#all never offers guest-joinable");
});
