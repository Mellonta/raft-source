import assert from "node:assert/strict";
import "./helpers/domSetup";
import { createElement, Fragment } from "react";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import api from "../src/api/client";
import ChannelFilesPanel from "../src/components/message/ChannelFilesPanel";
import { resetAttachmentPreviewSummaryCache } from "../src/components/message/attachmentPreviewSummaryCache";
import type { ChannelFileEntry } from "../src/components/message/ChannelFilesPanel";
import type { Channel } from "../src/store/channelStore";
import { useDocumentPreviewStore } from "../src/store/documentPreviewStore";
import { useMediaPreviewStore } from "../src/store/mediaPreviewStore";
import { resetServerFeatureFlagsForTests } from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { renderWithIntl } from "./helpers/intl";

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);
const originalWindowOpen = window.open;
const originalAnchorClick = HTMLAnchorElement.prototype.click;

const channel: Channel = {
  id: "channel-1",
  serverId: "server-1",
  name: "general",
  description: null,
  type: "channel",
  createdAt: "2026-08-10T00:00:00.000Z",
  joined: true,
  activityMuteSupported: false,
};

const file = {
  id: "file-1",
  messageId: "message-1",
  channelId: channel.id,
  filename: "seed-this-is-an-extremely-long-filename-for-narrow-layout.md",
  mimeType: "text/markdown",
  sizeBytes: 631,
  width: null,
  height: null,
  thumbnailUrl: null,
  createdAt: "2026-08-10T15:40:00.000Z",
  uploader: {
    type: "user" as const,
    id: "user-1",
    name: "developer",
    displayName: "Developer",
  },
  source: {
    type: "channel" as const,
    channelId: channel.id,
    parentMessageId: null,
    parentMessageShortId: null,
  },
};

const threadFile: ChannelFileEntry = {
  ...file,
  id: "thread-file-1",
  messageId: "thread-message-1",
  source: {
    type: "thread",
    channelId: channel.id,
    parentMessageId: "parent-message-1",
    parentMessageShortId: "parent-m",
  },
};

function LocationProbe() {
  const location = useLocation();
  return createElement(
    "output",
    { "data-testid": "location-probe" },
    `${location.pathname}${location.search}`,
  );
}

function seedServer() {
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Design",
      slug: "design",
      ownerId: "user-1",
      role: "owner",
      plan: "free",
    } as Server,
  });
}

function mockApis(
  flagEnabled: boolean,
  attachmentRequests: string[],
  files: ChannelFileEntry[] = [file],
) {
  api.get = (async (url: string) => {
    if (url === `/channels/${channel.id}/files`) {
      return { data: { files, nextCursor: null } };
    }
    if (url === `/attachments/${file.id}/preview`) {
      attachmentRequests.push(url);
      return {
        data: {
          status: "ok",
          data: { kind: "markdown", markdown: "# Release notes\n\nPreview me." },
          truncated: false,
        },
      };
    }
    if (url.startsWith(`/attachments/${file.id}/url`)) {
      attachmentRequests.push(url);
      return { data: { url: "https://cdn.example.test/file.md", expiresAt: null } };
    }
    return { data: {} };
  }) as typeof api.get;
  api.post = (async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return {
        data: {
          evaluations: [{ key: "topbar_overflow_v0", enabled: flagEnabled }],
        },
      };
    }
    return { data: {} };
  }) as typeof api.post;
}

function renderPanel(locale: "en" | "zh-cn" = "en") {
  return renderWithIntl(
    createElement(
      MemoryRouter,
      { initialEntries: [`/s/design/channel/${channel.id}`] },
      createElement(
        Fragment,
        null,
        createElement(ChannelFilesPanel, { channel }),
        createElement(LocationProbe),
      ),
    ),
    { locale },
  );
}

async function getRegisteredOverflowTrigger(trigger: HTMLElement) {
  const fileId = trigger.getAttribute("data-file-id");
  assert.ok(fileId, "file-menu trigger must identify its file");
  return waitFor(() => {
    const matches = screen
      .getAllByTestId("channel-file-overflow-trigger")
      .filter((candidate) => candidate.getAttribute("data-file-id") === fileId);
    assert.equal(matches.length, 1, "file must have one mounted overflow trigger");
    const current = matches[0];
    assert.equal(current.isConnected, true);
    assert.equal(current.getAttribute("aria-expanded"), "false");
    return current;
  });
}

async function openOverflowMenu(trigger: HTMLElement) {
  const activeTrigger = await getRegisteredOverflowTrigger(trigger);
  // Focus can update the tooltip composed around this trigger. Flush the
  // interaction through React before inspecting the resulting menu state.
  await act(async () => {
    activeTrigger.focus();
    fireEvent.keyDown(activeTrigger, { key: "ArrowDown" });
  });
  assert.equal(activeTrigger.getAttribute("aria-expanded"), "true");
  return screen.getByTestId("channel-file-overflow-menu");
}

afterEach(() => {
  cleanup();
  api.get = originalGet as typeof api.get;
  api.post = originalPost as typeof api.post;
  window.open = originalWindowOpen;
  HTMLAnchorElement.prototype.click = originalAnchorClick;
  resetAttachmentPreviewSummaryCache();
  useDocumentPreviewStore.getState().close();
  useDocumentPreviewStore.getState().setLoadingId(null);
  useMediaPreviewStore.getState().close();
  useMediaPreviewStore.getState().setLoadingId(null);
  resetServerFeatureFlagsForTests();
  useServerStore.setState({ current: null });
});

test("file list keeps markdown row preview primary and moves file commands into a vertical-ellipsis menu", async () => {
  seedServer();
  const attachmentRequests: string[] = [];
  mockApis(true, attachmentRequests);
  const openedUrls: string[] = [];
  const downloadedUrls: string[] = [];
  window.open = ((url?: string | URL) => {
    openedUrls.push(String(url));
    return null;
  }) as typeof window.open;
  HTMLAnchorElement.prototype.click = function click() {
    downloadedUrls.push(this.href);
  };

  renderPanel();

  const trigger = await screen.findByTestId("channel-file-overflow-trigger");
  assert.equal(
    trigger.getAttribute("aria-label"),
    `Actions for ${file.filename}`,
  );
  assert.ok(trigger.querySelector(".lucide-ellipsis-vertical"));
  const responsiveActions = screen.getByTestId("channel-file-responsive-actions");
  assert.ok(responsiveActions.classList.contains("channel-file-responsive-actions"));
  assert.ok(screen.getByTestId("channel-file-inline-actions").classList.contains("channel-file-inline-actions"));
  assert.ok(screen.getByTestId("channel-file-inline-jump").querySelector(".lucide-map-pin"));
  assert.ok(screen.getByTestId("channel-file-inline-download").querySelector(".lucide-download"));
  const inlineJump = screen.getByTestId("channel-file-inline-jump");
  const inlineDownload = screen.getByTestId("channel-file-inline-download");
  assert.equal(inlineJump.getAttribute("title"), null);
  assert.equal(inlineDownload.getAttribute("title"), null);
  assert.equal(inlineJump.getAttribute("data-slot"), "button");
  assert.equal(inlineDownload.getAttribute("data-slot"), "button");

  fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
  await waitFor(() => {
    const entry = useDocumentPreviewStore.getState().entry;
    assert.equal(entry?.attachment.id, file.id);
    assert.equal(entry?.preview.kind, "markdown");
  });
  assert.deepEqual(openedUrls, []);
  assert.deepEqual(downloadedUrls, []);
  assert.deepEqual(attachmentRequests, [`/attachments/${file.id}/preview`]);

  const menu = await openOverflowMenu(trigger);
  assert.deepEqual(
    Array.from(menu.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim()),
    ["Jump to original message", "Download file"],
  );
  assert.ok(screen.getByTestId("channel-file-overflow-jump").querySelector(".lucide-map-pin"));

  fireEvent.click(screen.getByTestId("channel-file-overflow-jump"));
  await waitFor(() => assert.equal(
    screen.getByTestId("location-probe").textContent,
    `/s/design/channel/${channel.id}?msg=${file.messageId}`,
  ));

  await openOverflowMenu(trigger);
  fireEvent.click(screen.getByTestId("channel-file-overflow-download"));
  await waitFor(() => assert.deepEqual(downloadedUrls, ["https://cdn.example.test/file.md"]));
  assert.deepEqual(attachmentRequests, [
    `/attachments/${file.id}/preview`,
    `/attachments/${file.id}/url?disposition=attachment`,
  ]);
});

test("thread files jump to the exact source reply inside their parent thread", async () => {
  seedServer();
  mockApis(true, [], [threadFile]);
  renderPanel();

  await openOverflowMenu(await screen.findByTestId("channel-file-overflow-trigger"));
  fireEvent.click(screen.getByTestId("channel-file-overflow-jump"));

  await waitFor(() => assert.equal(
    screen.getByTestId("location-probe").textContent,
    `/s/design/channel/${channel.id}?msg=${threadFile.messageId}&thread=${channel.id}%3A${threadFile.source.parentMessageId}`,
  ));
});

test("file row previews route media through the shared preview surfaces before signed-url fallback", async () => {
  seedServer();
  const files: ChannelFileEntry[] = [
    { ...file, id: "html-file-1", filename: "index.html", mimeType: "text/html" },
    { ...file, id: "video-file-1", filename: "demo.mp4", mimeType: "video/mp4" },
    { ...file, id: "audio-file-1", filename: "clip.mp3", mimeType: "audio/mpeg" },
    { ...file, id: "zip-file-1", filename: "archive.zip", mimeType: "application/zip" },
  ];
  const attachmentRequests: string[] = [];
  api.get = (async (url: string) => {
    if (url === `/channels/${channel.id}/files`) {
      return { data: { files, nextCursor: null } };
    }
    if (url === "/attachments/html-file-1/html-preview-url") {
      attachmentRequests.push(url);
      return { data: { url: "https://cdn.example.test/index.html", expiresAt: null } };
    }
    if (url === "/attachments/video-file-1/url?disposition=inline") {
      attachmentRequests.push(url);
      return { data: { url: "https://cdn.example.test/demo.mp4", expiresAt: null } };
    }
    if (url === "/attachments/audio-file-1/url?disposition=inline") {
      attachmentRequests.push(url);
      return { data: { url: "https://cdn.example.test/clip.mp3", expiresAt: null } };
    }
    if (url === "/attachments/zip-file-1/url") {
      attachmentRequests.push(url);
      return { data: { url: "https://cdn.example.test/archive.zip", expiresAt: null } };
    }
    if (url === "/feature-flags/evaluate") {
      return {
        data: {
          evaluations: [{ key: "topbar_overflow_v0", enabled: true }],
        },
      };
    }
    return { data: {} };
  }) as typeof api.get;
  const openedUrls: string[] = [];
  window.open = ((url?: string | URL) => {
    openedUrls.push(String(url));
    return null;
  }) as typeof window.open;

  renderPanel();

  const clickFile = async (filename: string) => {
    const row = (await screen.findByText(filename)).closest("button");
    assert.ok(row);
    fireEvent.click(row);
  };

  await clickFile("index.html");
  await waitFor(() => {
    const entry = useMediaPreviewStore.getState().entry;
    assert.equal(entry?.kind, "html");
    assert.equal(entry?.attachment.id, "html-file-1");
  });
  useMediaPreviewStore.getState().close();

  await clickFile("demo.mp4");
  await waitFor(() => {
    const entry = useMediaPreviewStore.getState().entry;
    assert.equal(entry?.kind, "video");
    assert.equal(entry?.attachment.id, "video-file-1");
  });
  useMediaPreviewStore.getState().close();

  await clickFile("clip.mp3");
  await waitFor(() => {
    const entry = useMediaPreviewStore.getState().entry;
    assert.equal(entry?.kind, "audio");
    assert.equal(entry?.attachment.id, "audio-file-1");
  });
  useMediaPreviewStore.getState().close();

  await clickFile("archive.zip");
  await waitFor(() => assert.deepEqual(openedUrls, ["https://cdn.example.test/archive.zip"]));

  assert.deepEqual(attachmentRequests, [
    "/attachments/html-file-1/html-preview-url",
    "/attachments/video-file-1/url?disposition=inline",
    "/attachments/audio-file-1/url?disposition=inline",
    "/attachments/zip-file-1/url",
  ]);
});

test("retired flag disabled keeps the file menu and desktop jump/download actions", async () => {
  seedServer();
  mockApis(false, []);
  renderPanel();

  await screen.findByText(file.filename);
  await waitFor(() => {
    assert.ok(screen.getByTestId("channel-file-inline-jump").querySelector(".lucide-map-pin"));
    assert.ok(screen.getByTestId("channel-file-inline-download"));
  });
  assert.ok(screen.getByTestId("channel-file-overflow-trigger"));
});

test("mouse activation opens the file menu on Base UI's scheduled browser frame", async () => {
  seedServer();
  mockApis(true, []);
  renderPanel();

  const trigger = await screen.findByTestId("channel-file-overflow-trigger");
  await waitFor(() => assert.equal(trigger.getAttribute("aria-expanded"), "false"));

  // Hold the mouse path at Base UI's registration boundary. The trigger is
  // mounted, but its root-owned aria/event contract is not available yet.
  // The helper must not dispatch mouse-down until this test publishes the
  // contract; once released, the real Base UI handler must still defer open
  // state to the captured browser frame.
  trigger.removeAttribute("aria-expanded");
  const originalGetAttribute = trigger.getAttribute;
  let fileIdReads = 0;
  let releaseFirstCandidateRead: (() => void) | undefined;
  const firstCandidateRead = new Promise<void>((resolve) => {
    releaseFirstCandidateRead = resolve;
  });
  trigger.getAttribute = function getAttribute(name: string) {
    const value = originalGetAttribute.call(this, name);
    if (name === "data-file-id" && value === file.id) {
      fileIdReads += 1;
      if (fileIdReads === 2) releaseFirstCandidateRead?.();
    }
    return value;
  };

  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalWindowRequestAnimationFrame = window.requestAnimationFrame;
  let scheduledFrame: FrameRequestCallback | undefined;
  const requestFrame = ((callback: FrameRequestCallback) => {
    scheduledFrame = callback;
    return 1;
  }) as typeof requestAnimationFrame;
  let activationAttempts = 0;
  const holdUntilRegistered = (event: MouseEvent) => {
    if (event.button !== 0) return;
    activationAttempts += 1;
    if (trigger.getAttribute("aria-expanded") !== "false") event.stopImmediatePropagation();
  };
  document.addEventListener("mousedown", holdUntilRegistered, true);

  try {
    globalThis.requestAnimationFrame = requestFrame;
    window.requestAnimationFrame = requestFrame;

    const activation = getRegisteredOverflowTrigger(trigger).then((activeTrigger) => {
      fireEvent.mouseDown(activeTrigger, { button: 0 });
      return activeTrigger;
    });
    await firstCandidateRead;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(activationAttempts, 0, "unregistered trigger must receive no mouse activation");
    assert.equal(scheduledFrame, undefined);
    assert.equal(screen.queryByTestId("channel-file-overflow-menu"), null);

    trigger.setAttribute("aria-expanded", "false");
    const activeTrigger = await activation;
    assert.equal(activeTrigger, trigger);
    assert.equal(activationAttempts, 1, "registered trigger must receive exactly one mouse activation");
    assert.equal(activeTrigger.getAttribute("aria-expanded"), "false");
    assert.equal(screen.queryByTestId("channel-file-overflow-menu"), null);
    assert.ok(scheduledFrame, "mouse-down must schedule the menu-open frame");

    await act(async () => scheduledFrame?.(performance.now()));
    assert.equal(activeTrigger.getAttribute("aria-expanded"), "true");
    assert.ok(screen.getByTestId("channel-file-overflow-menu"));
  } finally {
    trigger.getAttribute = originalGetAttribute;
    document.removeEventListener("mousedown", holdUntilRegistered, true);
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    window.requestAnimationFrame = originalWindowRequestAnimationFrame;
  }
});

test("keyboard activation waits for Base UI to publish the trigger contract", async () => {
  seedServer();
  mockApis(true, []);
  renderPanel();

  const trigger = await screen.findByTestId("channel-file-overflow-trigger");
  await waitFor(() => assert.equal(trigger.getAttribute("aria-expanded"), "false"));

  // Hold keyboard delivery at the same structural boundary as Base UI's
  // detached-trigger registration: the DOM button exists, but the root-owned
  // aria/event contract has not been forwarded yet. The second file-id read
  // proves the helper has inspected the mounted candidate before this test
  // explicitly publishes aria-expanded=false and releases the boundary.
  trigger.removeAttribute("aria-expanded");
  const originalGetAttribute = trigger.getAttribute;
  let fileIdReads = 0;
  let releaseFirstCandidateRead: (() => void) | undefined;
  const firstCandidateRead = new Promise<void>((resolve) => {
    releaseFirstCandidateRead = resolve;
  });
  trigger.getAttribute = function getAttribute(name: string) {
    const value = originalGetAttribute.call(this, name);
    if (name === "data-file-id" && value === file.id) {
      fileIdReads += 1;
      if (fileIdReads === 2) releaseFirstCandidateRead?.();
    }
    return value;
  };
  let activationAttempts = 0;
  const holdUntilRegistered = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown") return;
    activationAttempts += 1;
    if (trigger.getAttribute("aria-expanded") !== "false") event.stopImmediatePropagation();
  };
  document.addEventListener("keydown", holdUntilRegistered, true);

  try {
    const opening = openOverflowMenu(trigger).then(
      (menu) => ({ menu, error: null }),
      (error: unknown) => ({ menu: null, error }),
    );
    await firstCandidateRead;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(activationAttempts, 0, "unregistered trigger must receive no activation");

    trigger.setAttribute("aria-expanded", "false");
    const { menu, error } = await opening;
    if (error) throw error;
    assert.equal(activationAttempts, 1, "registered trigger must receive exactly one activation");
    assert.ok(menu);
    assert.ok(menu.querySelector('[role="menuitem"]'));
  } finally {
    trigger.getAttribute = originalGetAttribute;
    document.removeEventListener("keydown", holdUntilRegistered, true);
  }
});

test("keyboard activation reacquires the mounted trigger after replacement", async () => {
  seedServer();
  mockApis(true, []);
  const first = renderPanel();

  const staleTrigger = await screen.findByTestId("channel-file-overflow-trigger");
  await waitFor(() => assert.equal(staleTrigger.getAttribute("aria-expanded"), "false"));
  first.unmount();
  assert.equal(staleTrigger.isConnected, false);
  renderPanel();

  const menu = await openOverflowMenu(staleTrigger);
  const activeTrigger = screen.getByTestId("channel-file-overflow-trigger");
  assert.notEqual(activeTrigger, staleTrigger);
  assert.equal(activeTrigger.isConnected, true);
  assert.equal(activeTrigger.getAttribute("aria-expanded"), "true");
  assert.ok(menu.querySelector('[role="menuitem"]'));
});

test("the file menu follows the active Chinese locale", async () => {
  seedServer();
  mockApis(true, []);
  renderPanel("zh-cn");

  const trigger = await screen.findByTestId("channel-file-overflow-trigger");
  assert.equal(trigger.getAttribute("aria-label"), `${file.filename} 的操作`);
  const menu = await openOverflowMenu(trigger);
  assert.deepEqual(
    Array.from(menu.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim()),
    ["跳转到原消息", "下载文件"],
  );
});
