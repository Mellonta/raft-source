import { expect, test } from "@playwright/test";
import { loginViaApi } from "../fixtures/auth";
import { waitForSeedState } from "../fixtures/seedState";

/**
 * Pins the LeftRail ServerName slot as a SQUARE rectangle. stdrc
 * 2026-05-02 #proj-uiux:648f8735 bdf8050e: "桌面上这里不是正方形啊，
 * 得永远想办法保持这里是正方形。无论其他组件怎么改，这里需要一个
 * UI 测试钉住".
 *
 * The top-left LeftRail "ServerName" slot is the rectangle that
 * contains the server-initial button (`bg-black` square inside the
 * yellow rail). Its bounding box width MUST equal its height — at
 * every viewport. Today: 62×62 default, 48×48 on short.
 *
 * Tested at three viewports:
 *   - tall desktop (1280×800)        → 62×62
 *   - short desktop (1280×500)       → 48×48 (h-panel-header shrinks)
 *   - tall narrow (1024×800)         → 62×62 (lg+ keeps default)
 */
test.describe("LeftRail ServerName slot is always square", () => {
  for (const viewport of [
    { width: 1280, height: 800, expected: 62, label: "tall desktop" },
    { width: 1280, height: 500, expected: 48, label: "short desktop" },
    { width: 1024, height: 800, expected: 62, label: "narrow tall" },
  ] as const) {
    test(`${viewport.label} ${viewport.width}×${viewport.height} → ${viewport.expected}×${viewport.expected}`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      const seedState = await waitForSeedState();
      await loginViaApi(request, seedState);
      await page.goto(seedState.urls.web);
      // Wait for the rail to mount (md+ only). Since the RUI migration
      // (#7347) the ServerName slot is the AppRail header — the wrapper
      // around the server-initial button at the top of the yellow rail —
      // addressed by its data-slot hook, not the old class chain.
      const railSlot = page.locator(
        '[data-slot="app-rail-root"] > [data-slot="app-rail-header"]',
      ).first();
      await expect(railSlot).toBeVisible({ timeout: 10_000 });

      const rect = await railSlot.boundingBox();
      expect(rect).not.toBeNull();
      const { width, height } = rect!;
      // The ServerName slot must be square (width === height). Allow a
      // 0.5px tolerance for fractional sub-pixel rounding.
      expect(Math.abs(width - height)).toBeLessThanOrEqual(0.5);
      expect(Math.round(width)).toBe(viewport.expected);
      expect(Math.round(height)).toBe(viewport.expected);
    });
  }
});
