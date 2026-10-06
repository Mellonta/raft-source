import assert from "node:assert/strict";

import { openDesktopSettings } from "../src/components/layout/desktopSettingsShortcut";

function harness() {
  const calls: { modalSide?: string; navigatedTo?: string } = {};
  return {
    calls,
    openWorkspaceSettingsModal: (side: "left" | "right") => { calls.modalSide = side; },
    navigate: (path: string) => { calls.navigatedTo = path; },
  };
}

test("grid enabled → opens the workspace settings modal on the active rail side (no navigation)", () => {
  const h = harness();
  openDesktopSettings({
    workspaceEnabled: true,
    railSide: "right",
    serverSlug: "acme",
    openWorkspaceSettingsModal: h.openWorkspaceSettingsModal,
    navigate: h.navigate,
  });
  assert.equal(h.calls.modalSide, "right");
  assert.equal(h.calls.navigatedTo, undefined);
});

test("grid disabled → navigates to the /settings route (modal would not render)", () => {
  const h = harness();
  openDesktopSettings({
    workspaceEnabled: false,
    railSide: "left",
    serverSlug: "acme",
    openWorkspaceSettingsModal: h.openWorkspaceSettingsModal,
    navigate: h.navigate,
  });
  assert.equal(h.calls.navigatedTo, "/s/acme/settings");
  assert.equal(h.calls.modalSide, undefined);
});

test("grid disabled without an active server → no-op (no crash, no navigation)", () => {
  const h = harness();
  openDesktopSettings({
    workspaceEnabled: false,
    railSide: "left",
    serverSlug: null,
    openWorkspaceSettingsModal: h.openWorkspaceSettingsModal,
    navigate: h.navigate,
  });
  assert.equal(h.calls.navigatedTo, undefined);
  assert.equal(h.calls.modalSide, undefined);
});
