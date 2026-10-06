import assert from "node:assert/strict";
import { cleanup, render } from "@testing-library/react";
import { ThemeProvider } from "raft-ui";
import type { AvatarSlotProps } from "../src/components/ui/AvatarSlot";
import AvatarSlot from "../src/components/ui/AvatarSlot";

window.matchMedia = ((media: string) => ({
  matches: false, media, onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  dispatchEvent: () => true,
})) as typeof window.matchMedia;

afterEach(cleanup);

// Matches store-bound badge callers that intentionally accept only agentId.
// RUI's injected positioning props must never depend on their forwarding them.
function OpaqueStatusIndicator() {
  return <span data-testid="status-indicator" className="inline-block size-2" />;
}

test("an opaque status component stays inside RUI's native corner shell", () => {
  const { container, getByTestId } = render(
    <AvatarSlot context="sidebar-list" type="agent" badge={<OpaqueStatusIndicator />} />,
  );
  const badge = container.querySelector('[data-slot="avatar-badge"]');
  assert.ok(badge instanceof HTMLElement);
  assert.equal(badge.tagName, "SPAN");
  assert.equal(getByTestId("status-indicator").parentElement, badge);
  assert.equal(badge.parentElement?.getAttribute("data-slot"), "avatar");
  assert.ok(badge.classList.contains("absolute"), "RUI's corner geometry reaches a native element");
  assert.ok(badge.classList.contains("flex"), "inline indicators must not be displaced by a text baseline");
  assert.ok(badge.classList.contains("[&>span]:h-full"));
  assert.ok(badge.classList.contains("[&>span]:w-full"));
});


const identities: AvatarSlotProps[] = [
  { context: "panel-header", type: "human", humanPlaceholder: true },
  { context: "panel-header", type: "human", humanAvatarUrl: "https://example.test/avatar.png" },
  { context: "compact-list", type: "agent", agentAvatarUrl: "pixel:mug" },
  { context: "sidebar-list", type: "agent", badge: <OpaqueStatusIndicator /> },
  { context: "account-tile", type: "server", serverInitial: "S" },
  { context: "surface-list", type: "app", appInitials: "AP" },
];

for (const theme of ["brutal", "elegant"] as const) {
  test(`all ${theme} identities share the themed frame and clip content without clipping badges`, () => {
    const { container, rerender } = render(
      <ThemeProvider theme={theme} mode="light" syncDom={false}>
        {identities.map((props, i) => <AvatarSlot key={i} {...props} />)}
      </ThemeProvider>,
    );
    const avatars = container.querySelectorAll('[data-slot="avatar"]');
    assert.equal(avatars.length, identities.length);
    for (const avatar of avatars) {
      const content = avatar.querySelector('[data-slot="avatar-fallback"]');
      assert.ok(content);
      assert.equal(content.parentElement, avatar);
      assert.ok(content.classList.contains("overflow-hidden"));
      assert.equal(avatar.classList.contains("rounded-full"), theme === "elegant");
      assert.equal(content.classList.contains("rounded-full"), theme === "elegant");
      const badge = avatar.querySelector('[data-slot="avatar-badge"]');
      if (badge) assert.equal(badge.parentElement, avatar);
    }
    rerender(
      <ThemeProvider theme="elegant" mode="dark" syncDom={false}>
        {identities.map((props, i) => <AvatarSlot key={i} {...props} />)}
      </ThemeProvider>,
    );
    assert.equal(container.querySelectorAll('[data-slot="avatar"].rounded-full').length, identities.length);
  });
}
