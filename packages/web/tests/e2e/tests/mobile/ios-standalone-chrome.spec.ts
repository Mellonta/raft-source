import { expect, test } from "@playwright/test";
import { expectCssColor } from "../../fixtures/colorAssertions";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";

test.use({ viewport: { width: 390, height: 844 } });

test.describe("mobile iOS standalone chrome", () => {
  test("lets the app wrapper own the safe-area color per route", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    await loginViaApi(request, seedState);

    await page.goto(`/s/${seedState.server.slug}`);
    await expect(page.getByText(seedState.server.name)).toBeVisible();

    const rootColors = await page.evaluate(() => {
      const appRoot = document.querySelector<HTMLElement>("#root > div");
      return {
        themeColor: document
          .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
          ?.content,
        statusBarStyle: document
          .querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]')
          ?.content,
        html: getComputedStyle(document.documentElement).backgroundColor,
        body: getComputedStyle(document.body).backgroundColor,
        appRoot: appRoot ? getComputedStyle(appRoot).backgroundColor : null,
      };
    });

    expect(rootColors.themeColor).toBe("#FFD440");
    expect(rootColors.statusBarStyle).toBe("black-translucent");
    await expectCssColor(page, rootColors.html, "#FFFFFF");
    await expectCssColor(page, rootColors.body, "#FFFFFF");
    await expectCssColor(page, rootColors.appRoot, "#FFD440");

    await page.goto(`/s/${seedState.server.slug}/tasks`);
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
    const tasksRootColors = await page.evaluate(() => {
      const appRoot = document.querySelector<HTMLElement>("#root > div");
      return {
        themeColor: document
          .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
          ?.content,
        appRoot: appRoot ? getComputedStyle(appRoot).backgroundColor : null,
      };
    });
    expect(tasksRootColors.themeColor).toBe("#FFD440");
    await expectCssColor(page, tasksRootColors.appRoot, "#FFD440");

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expect(page.getByPlaceholder(`Message #${seedState.channel.name}`)).toBeVisible();

    const detailColors = await page.evaluate(() => {
      const appRoot = document.querySelector<HTMLElement>("#root > div");
      return {
        themeColor: document
          .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
          ?.content,
        appRoot: appRoot ? getComputedStyle(appRoot).backgroundColor : null,
      };
    });

    expect(detailColors.themeColor).toBe("#FFFFFF");
    await expectCssColor(page, detailColors.appRoot, "#FFFFFF");
  });

  test("elegant presets float the mobile tab bar on a transparent shell (task #678)", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    await loginViaApi(request, seedState);

    const setDeviceThemePreferences = async (mode: "light" | "dark") => {
      await page.evaluate((nextMode) => {
        window.localStorage.setItem(
          "slock-theme-preferences-v2",
          JSON.stringify({ mode: nextMode, lightThemeId: "elegant", darkThemeId: "elegant" }),
        );
      }, mode);
      await page.reload();
    };

    const readShell = async () =>
      page.evaluate(() => {
        const appRoot = document.querySelector<HTMLElement>("#root > div");
        const overlay = document.querySelector<HTMLElement>('[data-testid="mobile-bottom-bar-overlay"]');
        const scroller = document.querySelector<HTMLElement>(
          '[data-testid="sidebar-scroll-surface"]',
        );
        return {
          themeColor: document
            .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
            ?.content,
          appRoot: appRoot ? getComputedStyle(appRoot).backgroundColor : null,
          pageCanvas: getComputedStyle(document.documentElement).backgroundColor,
          overlayPosition: overlay ? getComputedStyle(overlay).position : null,
          overlayBottom: overlay ? getComputedStyle(overlay).bottom : null,
          scrollerPaddingBottom: scroller ? getComputedStyle(scroller).paddingBottom : null,
        };
      });

    await page.goto(`/s/${seedState.server.slug}`);
    await expect(page.getByText(seedState.server.name)).toBeVisible();

    for (const mode of ["light", "dark"] as const) {
      await setDeviceThemePreferences(mode);
      await expect(page.getByText(seedState.server.name)).toBeVisible();

      const shell = await readShell();
      // The shell carries no distinct chrome band any more: it resolves to the
      // page canvas itself, so the content shows behind the floating capsule.
      await expectCssColor(page, shell.appRoot, shell.pageCanvas, 1);
      expect(shell.appRoot).not.toBe("rgb(255, 212, 64)");
      expect(shell.overlayPosition).toBe("fixed");
      expect(shell.overlayBottom).toBe("0px");
      // The scrolling surface reserves the capsule clearance (68px + inset).
      expect(shell.scrollerPaddingBottom).toBe("68px");
    }

    // A live-activity strip above the capsule raises the clearance (~48px).
    await page.evaluate(() => {
      const slot = document.createElement("div");
      slot.setAttribute("data-testid", "mobile-live-activity-slot");
      slot.appendChild(document.createElement("div")); // the rendered strip
      document.body.appendChild(slot);
    });
    expect((await readShell()).scrollerPaddingBottom).toBe("116px");
    await page.evaluate(() => {
      document.querySelector('[data-testid="mobile-live-activity-slot"]')?.remove();
    });

    // The list can still scroll its last row clear of the floating capsule.
    const lastRow = page.locator("[data-sidebar-channel-id]").last();
    await lastRow.scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(
        '[data-testid="sidebar-scroll-surface"]',
      );
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    const rowBox = await lastRow.boundingBox();
    const navBox = await page.locator('[data-slot="mobile-nav-root"]').boundingBox();
    expect(rowBox).not.toBeNull();
    expect(navBox).not.toBeNull();
    expect((rowBox?.y ?? 0) + (rowBox?.height ?? 0)).toBeLessThanOrEqual((navBox?.y ?? 0) + 1);
  });
});
