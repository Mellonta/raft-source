import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { loginViaApi } from "../fixtures/auth";
import { dismissOwnerOnboarding } from "../fixtures/session";
import { waitForSeedState } from "../fixtures/seedState";
import type { PlaywrightSeedState } from "../fixtures/seedState";

const mermaid = (label: string) => [
  "```mermaid",
  "flowchart TD",
  `  A["${label} start"] --> B["design"]`,
  "  B --> C[\"implement\"]",
  "  C --> D[\"review\"]",
  "  D --> E[\"ship\"]",
  "```",
].join("\n");

async function createChannel(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/channels`, {
    headers: { Authorization: `Bearer ${accessToken}`, "X-Server-Id": seedState.server.id },
    data: { name: `workspace-scroll-${randomUUID().slice(0, 8)}` },
  });
  expect(response.ok()).toBeTruthy();
  return await response.json() as { id: string };
}

async function postMessage(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  channelId: string,
  content: string,
  parentMessageId?: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: { Authorization: `Bearer ${accessToken}`, "X-Server-Id": seedState.server.id },
    data: { channelId, content, ...(parentMessageId ? { parentMessageId } : {}) },
  });
  expect(response.ok()).toBeTruthy();
  return await response.json() as { id: string };
}

async function enableWorkspace(page: Page) {
  await page.route("**/api/feature-flags/evaluate", async (route) => {
    const body = route.request().postDataJSON() as { keys?: string[] };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        evaluations: (body.keys ?? []).map((key) => ({
          key,
          enabled: key === "chat_grid_layout_v0",
        })),
      }),
    });
  });
}

test("Workspace channel keeps native wheel ownership with a neighboring thread", async ({ page, request }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 980 });
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);
  await enableWorkspace(page);

  const channel = await createChannel(request, seedState, login.accessToken);
  const parent = await postMessage(
    request,
    seedState,
    login.accessToken,
    channel.id,
    ["Workspace scroll parent", mermaid("parent")].join("\n\n"),
  );
  await postMessage(request, seedState, login.accessToken, channel.id, "Thread reply", parent.id);
  let lastMessage = parent;
  for (let index = 0; index < 8; index += 1) {
    lastMessage = await postMessage(
      request,
      seedState,
      login.accessToken,
      channel.id,
      [`Workspace message ${index}`, mermaid(`diagram ${index}`)].join("\n\n"),
    );
  }

  await page.goto(`/s/${seedState.server.slug}/channel/${channel.id}`);
  await page.getByTestId("workspace-mode-toggle").click();

  const host = page.getByTestId("workspace-grid-chat-host");
  await expect(host).toBeVisible();
  const scroller = host.getByTestId("message-scroller");
  await expect.poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  const parentCard = host.locator(`#message-${parent.id}`);
  await parentCard.scrollIntoViewIfNeeded();
  await parentCard.hover();
  await parentCard.getByLabel("Reply in thread").click();
  await expect(page.getByRole("tab", { name: new RegExp(`Thread ${parent.id.slice(0, 8)}`) })).toBeVisible();
  await page.evaluate(() => {
    const url = new URL(window.location.href);
    const raw = url.searchParams.get("wg");
    if (!raw?.startsWith("v1.")) throw new Error("workspace layout intent is unavailable");
    const state = JSON.parse(decodeURIComponent(raw.slice(3))) as {
      model: {
        layout: {
          children?: Array<{
            id?: string;
            selected?: number;
            children?: Array<{ config?: { kind?: string } }>;
          }>;
        };
      };
    };
    const primary = state.model.layout.children?.[0];
    const tabs = primary?.children ?? [];
    const channelTab = tabs.find((tab) => tab.config?.kind === "channel");
    const threadTab = tabs.find((tab) => tab.config?.kind === "thread");
    if (!primary || !channelTab || !threadTab) throw new Error("expected channel and thread tabs");
    state.model.layout.children = [
      { ...primary, selected: 0, children: [channelTab] },
      { ...primary, id: "workspace-secondary", selected: 0, children: [threadTab] },
    ];
    url.searchParams.set("wg", `v1.${encodeURIComponent(JSON.stringify(state))}`);
    window.location.assign(url.toString());
  });
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("tablist", { name: "Workspace tabs" })).toHaveCount(2);
  await expect(host).toBeVisible();

  const lastCard = host.locator(`#message-${lastMessage.id}`);
  await lastCard.scrollIntoViewIfNeeded();
  const before = await scroller.evaluate((element) => element.scrollTop);
  const diagramViewport = lastCard.getByTestId("mermaid-pan-zoom-viewport");
  await diagramViewport.hover();
  await page.mouse.wheel(0, -500);
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(before - 20);

  const overlay = page.locator(".workspace-grid-demo-shell .flexlayout__layout_overlay");
  await expect(overlay).toHaveCSS("display", "none");

  await diagramViewport.hover();
  await page.getByRole("tab", { name: new RegExp(`workspace-scroll-`) }).first().evaluate((tab) => {
    const transfer = new DataTransfer();
    tab.dispatchEvent(new DragEvent("dragstart", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
    document.querySelector<HTMLElement>(".workspace-grid-demo-shell .flexlayout__layout")?.dispatchEvent(
      new DragEvent("dragenter", {
        bubbles: true,
        cancelable: true,
        clientX: tab.getBoundingClientRect().left,
        clientY: tab.getBoundingClientRect().bottom + 80,
        dataTransfer: transfer,
      }),
    );
  });
  await expect(overlay).toHaveCSS("display", "flex");
  await page.evaluate(() => {
    window.dispatchEvent(new DragEvent("dragend", {
      bubbles: true,
      cancelable: true,
      dataTransfer: new DataTransfer(),
    }));
  });
  await expect(overlay).toHaveCSS("display", "none");
  const afterCanceledDrag = await scroller.evaluate((element) => element.scrollTop);
  await page.mouse.wheel(0, -500);
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(afterCanceledDrag - 20);
});
