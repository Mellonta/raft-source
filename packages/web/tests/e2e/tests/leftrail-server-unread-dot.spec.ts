import { expect, test } from "@playwright/test";
import { loginViaApi } from "../fixtures/auth";
import { waitForSeedState } from "../fixtures/seedState";

/**
 * Task #685 (Artea 2026-09-28): when another server has unread activity, the
 * attention dot on the rail's server button was cut in half. raft-ui hangs the
 * dot off the button's top-right corner on purpose, and the button carried
 * overflow-hidden, so everything outside the button was clipped.
 *
 * What this pins: in a real browser, the whole dot is painted. Every ancestor
 * that clips (computed overflow other than `visible`) must contain the dot's
 * full box. jsdom cannot answer this — it has no layout.
 *
 * The cross-server unread summary is served by RisingWave, which the e2e
 * stack does not run, so that one response is stubbed with a real second
 * server's id. Everything that is measured (rail, button, dot) renders for real.
 */
for (const preset of ["brutal", "elegant-light"] as const) {
  test(`${preset}: the other-server unread dot is painted whole`, async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    const runId = Date.now().toString(36);
    const peer = await request.post(`${seedState.urls.api}/api/servers`, {
      headers: { Authorization: `Bearer ${login.accessToken}` },
      data: { name: `ZZ Unread Peer ${runId}`, slug: `zz-unread-peer-${runId}` },
    });
    expect(peer.ok(), await peer.text()).toBeTruthy();
    const peerServer = (await peer.json()) as { id: string };
    // The peer only has to exist for the rail to count it; remove it afterwards
    // so repeated runs do not pile servers up on the shared owner.
    try {
      await page.route("**/api/servers/unread-summary", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify([
            { serverId: seedState.server.id, unreadCount: 0, serverPushMuted: false, activityUnreadCount: 0 },
            { serverId: peerServer.id, unreadCount: 3, serverPushMuted: false, activityUnreadCount: 2 },
          ]),
        }),
      );
      await page.addInitScript((themePreset) => {
        localStorage.removeItem("slock-theme-preferences-v2");
        localStorage.setItem("slock-theme-preset", themePreset);
      }, preset);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`/s/${seedState.server.slug}`);

      const dot = page.locator(
        '[data-slot="app-rail-header"] [data-slot="app-rail-item-indicator"]',
      ).first();
      await expect(dot).toBeVisible({ timeout: 15_000 });

      const clipped = await dot.evaluate((el) => {
        const d = el.getBoundingClientRect();
        const failures: string[] = [];
        for (let node = el.parentElement; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.overflowX === "visible" && style.overflowY === "visible" && style.clipPath === "none") continue;
          const r = node.getBoundingClientRect();
          const inside = d.left >= r.left - 0.5 && d.right <= r.right + 0.5 && d.top >= r.top - 0.5 && d.bottom <= r.bottom + 0.5;
          if (!inside) {
            const name = node.getAttribute("data-slot") ?? node.tagName.toLowerCase();
            failures.push(`${name} (overflow ${style.overflowX}/${style.overflowY}) cuts the dot: dot ${[d.left, d.top, d.right, d.bottom].map(Math.round)} vs box ${[r.left, r.top, r.right, r.bottom].map(Math.round)}`);
          }
        }
        return { failures, width: d.width, height: d.height };
      });

      expect(clipped.width).toBeGreaterThan(0);
      expect(clipped.height).toBeGreaterThan(0);
      expect(clipped.failures).toEqual([]);
    } finally {
      const removed = await request.delete(`${seedState.urls.api}/api/servers/${peerServer.id}`, {
        headers: { Authorization: `Bearer ${login.accessToken}`, "X-Server-Id": peerServer.id },
      });
      expect.soft(removed.ok(), `peer cleanup: ${removed.status()}`).toBeTruthy();
    }
  });
}
