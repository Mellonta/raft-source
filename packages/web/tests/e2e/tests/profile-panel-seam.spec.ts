import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { loginViaApi } from "../fixtures/auth";
import { waitForSeedState } from "../fixtures/seedState";

// #proj-frontend task #683: where the profile pane meets its neighbour there
// must be exactly one divider, and a conversation next to it must either stay
// readable or fold away. The divider belongs to the profile pane's own box, so
// nothing inside the neighbouring column (the composer bar) can cover it.

async function openChatWithProfile(page: Page, request: Parameters<typeof loginViaApi>[0], opts: { width: number; profileWidth?: number; sidebarWidth?: number }) {
  const seed = await waitForSeedState();
  await loginViaApi(request, seed);
  await page.addInitScript(({ profileWidth, sidebarWidth }) => {
    if (profileWidth) localStorage.setItem("slock:profilePanelWidth", String(profileWidth));
    if (sidebarWidth) localStorage.setItem("slock:sidebarWidth", String(sidebarWidth));
  }, { profileWidth: opts.profileWidth, sidebarWidth: opts.sidebarWidth });
  await page.setViewportSize({ width: opts.width, height: 900 });
  await page.goto(`/s/${seed.server.slug}/channel/${seed.channel.id}?profile=agent:${seed.agent.id}`);
  await expect(page.getByTestId("profile-panel")).toBeVisible();
}

const box = (page: Page, testId: string) => page.getByTestId(testId).evaluate((el) => {
  const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
  return { left: r.left, width: r.width, borderLeft: parseFloat(cs.borderLeftWidth), display: cs.display };
});

test("chat | profile: one divider on the profile pane, not covered beside the composer", async ({ page, request }) => {
  await openChatWithProfile(page, request, { width: 1292 });
  const profile = await box(page, "profile-panel");
  expect(profile.borderLeft).toBeGreaterThan(0);

  // Resize handles are hit areas only.
  const handleBorders = await page.getByTestId("profile-panel").evaluate((el) =>
    Array.from(el.querySelectorAll<HTMLElement>(".cursor-col-resize")).map((h) => parseFloat(getComputedStyle(h).borderLeftWidth)));
  expect(handleBorders.length).toBeGreaterThan(0);
  expect(handleBorders.every((w) => w === 0)).toBe(true);

  // Along the composer's height, the divider pixel is painted by the profile pane.
  const composer = await page.locator('[data-testid="thread-main-column"] form').last().boundingBox();
  expect(composer).not.toBeNull();
  const owner = await page.evaluate(({ x, y }) => {
    const top = document.elementFromPoint(x, y);
    return top?.closest('[data-testid="profile-panel"]') ? "profile" : top?.closest('[data-testid="thread-main-column"]') ? "chat" : "other";
  }, { x: profile.left + 0.5, y: composer!.y + composer!.height / 2 });
  expect(owner).toBe("profile");
});

test("chat | wide profile: the conversation keeps a readable width", async ({ page, request }) => {
  await openChatWithProfile(page, request, { width: 1100, profileWidth: 580 });
  const chat = await box(page, "thread-main-column");
  expect(chat.width).toBeGreaterThanOrEqual(320);
});

test("too narrow for two panes: the conversation folds and the profile meets the sidebar with no second line", async ({ page, request }) => {
  await openChatWithProfile(page, request, { width: 1050, sidebarWidth: 320 });
  expect((await box(page, "thread-main-column")).display).toBe("none");
  const profile = await box(page, "profile-panel");
  expect(profile.borderLeft).toBe(0);
});

test("thread | profile with the channel folded: the thread draws no edge beside the sidebar; the profile owns the divider", async ({ page, request }) => {
  const seed = await waitForSeedState();
  await loginViaApi(request, seed);
  await page.setViewportSize({ width: 1780, height: 900 });
  await page.goto(`/s/${seed.server.slug}/channel/${seed.channel.id}?thread=${seed.channel.id}:${seed.messages.focusMessageId}&profile=agent:${seed.agent.id}`);
  await expect(page.getByTestId("profile-panel")).toBeVisible();
  expect((await box(page, "thread-main-column")).display).toBe("none");

  const threadRootLeft = await page.getByTestId("thread-side-column").evaluate((el) =>
    parseFloat(getComputedStyle(el.querySelector('[data-slot="thread-panel-root"]')!).borderLeftWidth));
  expect(threadRootLeft).toBe(0);
  const threadRight = await page.getByTestId("thread-side-column").evaluate((el) => parseFloat(getComputedStyle(el).borderRightWidth));
  expect(threadRight).toBe(0);
  expect((await box(page, "profile-panel")).borderLeft).toBeGreaterThan(0);
});
