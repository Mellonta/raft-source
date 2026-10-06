import { test } from "@playwright/test";
import { expectCssColor } from "../fixtures/colorAssertions";
import { loginViaApi } from "../fixtures/auth";
import { waitForSeedState } from "../fixtures/seedState";

/**
 * Pins the desktop layout color contract from stdrc 2026-05-02
 * #proj-uiux:95e25b5b. After research-driven iteration through
 * paper / yellow / cool-gray / warm-yellow candidates, the chosen
 * three-band hierarchy is:
 *
 *   LeftRail (yellow #FFD440)
 *     │
 *     │  Sidebar column (cream #FFFAEF — desktop only)
 *     │    └─ Sidebar header h-[62px] also cream
 *     │
 *     │  Main panel column (white #FFFFFF)
 *     │    └─ Chat header h-[62px] also white
 *     │    └─ Messages scroller white
 *
 * Mobile (<md) flips the rule: every full-screen tab interior is
 * white including the sidebar (since there's no side-by-side to
 * differentiate against).
 *
 * Vertical column dividers are border-r-2 / border-l-2 to match
 * the horizontal border-b-2 used by panel headers.
 *
 * This spec asserts the rendered backgroundColor for each region
 * via getComputedStyle, so any regression on the theme tokens lights
 * up here. Elements are located by their RUI data-slot hooks
 * (post-#7347), not by Tailwind class names. */
test.describe("layout color contract (desktop)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("LeftRail = yellow / Sidebar = cream / Main = white", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    await loginViaApi(request, seedState);
    await page.goto(seedState.urls.web);
    // Wait for the desktop shell to be present. Since the RUI migration
    // (#7347) the layout regions are addressed by their stable data-slot
    // hooks, not Tailwind class names — the COLOR contract below is
    // unchanged, only the element lookup moved.
    await page.waitForSelector('[data-slot="app-rail-root"]', { timeout: 10_000 });
    await page.waitForSelector('[data-slot="sidebar-root"]', { timeout: 10_000 });
    await page.waitForSelector('[data-slot="conversation-panel-root"]', { timeout: 10_000 });

    const colors = await page.evaluate(() => {
      // The LeftRail is the RUI AppRail root (brutal: bg-primary → yellow).
      const leftRail = document.querySelector(
        '[data-slot="app-rail-root"]',
      ) as HTMLElement | null;
      // The sidebar column (brutal: theme-brutal:bg-brutal-cream → cream).
      const sidebar = document.querySelector(
        '[data-slot="sidebar-root"]',
      ) as HTMLElement | null;
      // The main panel (white in every theme).
      const mainCandidate = document.querySelector(
        '[data-slot="conversation-panel-root"]',
      ) as HTMLElement | null;
      return {
        leftRail: leftRail ? getComputedStyle(leftRail).backgroundColor : null,
        sidebar: sidebar ? getComputedStyle(sidebar).backgroundColor : null,
        main: mainCandidate
          ? getComputedStyle(mainCandidate).backgroundColor
          : null,
      };
    });

    // brutal-yellow: the contract value is #FFD440 = rgb(255, 212, 64).
    // Since #7347 the rail takes RUI's `bg-primary` token
    // (oklch(0.883 0.162 91.89)), whose color-space round-trip lands at
    // [255,212,65] — hence tolerance 1, not a changed contract.
    await expectCssColor(page, colors.leftRail, "#FFD440", 1);
    // brutal-cream = #FFFAEF = rgb(255, 250, 239)
    await expectCssColor(page, colors.sidebar, "#FFFAEF");
    // bg-white = #FFFFFF
    await expectCssColor(page, colors.main, "#FFFFFF");
  });
});
