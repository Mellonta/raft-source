import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import type { PlaywrightSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

type ListedChannel = {
  id: string;
  name: string;
  archivedAt?: string | null;
};

function authHeaders(seedState: PlaywrightSeedState, accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-Server-Id": seedState.server.id,
  };
}

async function installControlledServerRootDefault(
  page: Page,
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
) {
  const response = await request.get(`${seedState.urls.api}/api/channels?archived=include`, {
    headers: authHeaders(seedState, accessToken),
  });
  expect(response.ok()).toBeTruthy();
  const channels = await response.json() as ListedChannel[];
  const sourceChannel = channels.find((channel) => channel.id === seedState.channel.id);
  expect(sourceChannel).toBeDefined();

  const controlledDefault = {
    ...sourceChannel!,
    id: "00000000-0000-4000-8000-000000000612",
    name: "e2e-search-root-default",
    archivedAt: null,
  };
  const controlledSource = {
    ...sourceChannel!,
    name: "e2e-search-source",
  };

  // Freeze this page's channel-list authority to a cloned accessible row whose
  // identity is deliberately not the shared seed channel. This protects the
  // server-root selection contract without mutating the shared server.
  const controlledChannels = [controlledDefault, controlledSource];
  await page.route("**/api/channels?archived=include", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(controlledChannels),
    });
  });
  await page.route(`**/api/channels/${seedState.channel.id}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(controlledSource),
    });
  });

  return `/s/${seedState.server.slug}/channel/${controlledDefault.id}`;
}

async function expectDesktopServerRootRedirect(page: Page, defaultChannelPath: string) {
  await expect(page).toHaveURL(new RegExp(`${defaultChannelPath}$`));
  await expect.poll(() =>
    page.evaluate(() => window.history.state?.usr?.sidebarDisclosureRestore),
  ).toBe(true);
}

test.describe("Search Escape routing", () => {
  test.beforeEach(async ({ request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);
  });

  test("global empty Search exits through the server root, while a query exits to its source channel", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    const channelPath = `/s/${seedState.server.slug}/channel/${seedState.channel.id}`;
    const defaultChannelPath = await installControlledServerRootDefault(
      page,
      request,
      seedState,
      login.accessToken,
    );

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(channelPath);
    await expect(page.locator("textarea")).toBeVisible();

    await page.getByTestId("left-rail-tab-search").click();
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/search$`));

    const searchInput = page.locator('input[placeholder*="Search" i]').first();
    await expect(searchInput).toBeFocused();
    await searchInput.press("Escape");
    await expectDesktopServerRootRedirect(page, defaultChannelPath);

    await page.goto(`${channelPath}?msg=${seedState.messages.focusMessageId}`);
    await expect(page.locator("textarea")).toBeVisible();
    const querySourceUrl = page.url();
    await page.getByTestId("left-rail-tab-search").click();
    const querySearchInput = page.locator('input[placeholder*="Search" i]').first();
    await expect(querySearchInput).toBeFocused();
    await querySearchInput.fill(seedState.messages.latestContent);
    await querySearchInput.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/search\\?q=`));
    await querySearchInput.press("Escape");
    await expect(page).toHaveURL(querySourceUrl);
  });

  test("empty channel-header Search exits to the exact source channel", async ({
    page,
  }) => {
    const seedState = await waitForSeedState();
    const channelPath = `/s/${seedState.server.slug}/channel/${seedState.channel.id}`;

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(channelPath);
    await expect(page.locator("textarea")).toBeVisible();

    await page.getByRole("button", { name: "Search this channel" }).click();
    await expect(page).toHaveURL(
      new RegExp(
        `/s/${seedState.server.slug}/search\\?channelId=${seedState.channel.id}&defer=1$`,
      ),
    );

    const searchInput = page.locator('input[placeholder*="Search" i]').first();
    await expect(searchInput).toBeFocused();
    await searchInput.press("Escape");
    await expect(page).toHaveURL(new RegExp(`${channelPath}$`));
  });

  test("empty Search opened with Command/Ctrl+K exits to the exact source channel", async ({
    page,
  }) => {
    const seedState = await waitForSeedState();
    const channelPath = `/s/${seedState.server.slug}/channel/${seedState.channel.id}`;

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(channelPath);
    await expect(page.locator("textarea")).toBeVisible();

    const searchShortcut = await page.evaluate(() =>
      /mac|iphone|ipad|ipod/i.test(navigator.platform) ? "Meta+k" : "Control+k",
    );
    await page.keyboard.press(searchShortcut);
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/search$`));

    const searchInput = page.locator('input[placeholder*="Search" i]').first();
    await expect(searchInput).toBeFocused();
    await searchInput.press("Escape");
    await expect(page).toHaveURL(new RegExp(`${channelPath}$`));
  });

  test("empty non-deferred channel-filter Search exits through the server root", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    const defaultChannelPath = await installControlledServerRootDefault(
      page,
      request,
      seedState,
      login.accessToken,
    );
    const filteredSearchPath =
      `/s/${seedState.server.slug}/search?channelId=${seedState.channel.id}`;

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(filteredSearchPath);

    const searchInput = page.locator('input[placeholder*="Search" i]').first();
    await expect(searchInput).toBeFocused();
    await searchInput.press("Escape");
    await expectDesktopServerRootRedirect(page, defaultChannelPath);
  });
});
