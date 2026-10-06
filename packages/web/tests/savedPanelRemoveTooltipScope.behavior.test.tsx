import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter } from "react-router-dom";
import SavedPanel from "../src/components/saved/SavedPanel";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useSavedStore } from "../src/store/savedStore";
import type { SavedEntry } from "../src/store/savedStore";
import { useServerStore } from "../src/store/serverStore";

const savedEntry: SavedEntry = {
  messageId: "saved-message-1",
  channelId: "channel-general",
  channelName: "general",
  channelType: "channel",
  content: "Saved tooltip scope check",
  senderType: "agent",
  senderId: "agent-cindy",
  senderName: "Cindy",
  createdAt: "2026-07-12T00:00:00.000Z",
  savedAt: "2026-07-12T00:00:00.000Z",
  parentChannelId: null,
  parentChannelName: null,
  parentChannelType: null,
  parentMessageId: null,
};

function seedStores() {
  useAuthStore.setState({
    user: {
      id: "user-saved-tooltip",
      email: "saved-tooltip@example.com",
      gravatarHash: "",
      name: "saved-tooltip-user",
      displayName: null,
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationDisplay: "translated",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
  });
  useServerStore.setState({
    current: {
      id: "server-saved-tooltip",
      name: "Saved Tooltip Server",
      avatarUrl: null,
      slug: "saved-tooltip",
      ownerId: "user-saved-tooltip",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-12T00:00:00.000Z",
    },
    servers: [],
    members: [],
  });
  useAgentStore.setState({
    agents: [{
      id: "agent-cindy",
      name: "cindy",
      displayName: "Cindy",
      description: null,
      avatarUrl: null,
      status: "online",
      runtime: "codex",
      channelIds: [],
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    }],
    loading: false,
  });
  useSavedStore.setState({
    saved: [savedEntry],
    savedIds: new Set([savedEntry.messageId]),
    loading: false,
    hasMore: false,
    total: 1,
    loadSaved: async () => {},
    loadMore: async () => {},
    unsaveMessage: async () => {},
  });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("Saved remove action does not render hover or floating tooltips", () => {
  seedStores();

  render(
    <MemoryRouter initialEntries={["/s/saved-tooltip/saved"]}>
      <SavedPanel />
    </MemoryRouter>,
  );

  const row = screen.getByRole("button", { name: /Saved tooltip scope check/ });
  assert.equal(row.classList.contains("group"), false, "hovering the saved row must not reveal any group state");

  const removeButton = screen.getByRole("button", { name: "Remove from Saved" });
  assert.ok(removeButton, "remove action is accessible via aria-label");

  // Per creator direction: both the floating tooltip and the inline hover tooltip are removed
  assert.ok(
    screen.queryByText("Remove from Saved") === null,
    "neither floating nor hover tooltip should be rendered in the document",
  );
});
