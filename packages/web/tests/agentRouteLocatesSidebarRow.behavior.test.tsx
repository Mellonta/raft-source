/**
 * Task #702 (artin): opening an agent page (/s/<server>/agent/<id>) lands the
 * rail on the People tab; the left Agents list must locate that agent on
 * open — its row is scrolled into view as soon as the list renders it.
 */
import assert from "node:assert/strict";
import { afterEach, beforeAll, test } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Sidebar from "../src/components/layout/Sidebar";
import { TestIntlProvider } from "./helpers/intl";
import type { Agent } from "../src/store/agentStore";
import { useAgentStore } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import { useServerStore } from "../src/store/serverStore";

const AGENT_ID = "agent-702";

const scrolled: Array<{ element: Element; block: string | undefined; behavior: string | undefined }> = [];
beforeAll(() => {
  // jsdom performs no layout and ships no scrollIntoView.
  Element.prototype.scrollIntoView = function scrollIntoView(
    this: Element,
    options?: boolean | ScrollIntoViewOptions,
  ) {
    const block = typeof options === "object" ? options?.block : undefined;
    const behavior = typeof options === "object" ? options?.behavior : undefined;
    scrolled.push({ element: this, block, behavior });
  } as typeof Element.prototype.scrollIntoView;
});

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    name: "agent-name",
    displayName: "Agent fallback",
    avatarUrl: null,
    description: null,
    status: "active",
    model: "gpt",
    runtime: "codex",
    serverRole: null,
    reasoningEffort: null,
    executionMode: "cloud",
    envVars: null,
    machineId: null,
    creatorType: null,
    creatorId: null,
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function setupStores() {
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Dev",
      slug: "dev",
      role: "owner",
      avatarUrl: null,
      hideHumansFromMembers: false,
    },
    members: [],
    sidebarOrder: {
      channelOrder: [],
      agentOrder: [],
      dmOrder: [],
      channelSortMode: "manual",
      jointChannelSortMode: "manual",
      dmSortMode: "manual",
      pinnedSortMode: "manual",
      pinned: [],
      pinnedChannelIds: [],
      pinnedAgentIds: [],
      pinnedOrder: [],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
      customSections: [],
    },
  } as never);
  useAgentStore.setState({
    agents: [agent({ id: AGENT_ID, name: "locate-agent", displayName: "Locate Agent" })],
    agentActivities: {},
  } as never);
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {}, loading: false } as never);
}

afterEach(() => {
  scrolled.length = 0;
  cleanup();
  useAgentStore.setState({ agents: [], agentActivities: {} } as never);
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {}, loading: true } as never);
  useServerStore.setState({ current: null, members: [] } as never);
});

test("opening the agent page scrolls the agent's row into view in the People tab", async () => {
  setupStores();
  render(
    <MemoryRouter initialEntries={[`/s/dev/agent/${AGENT_ID}`]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const row = await waitFor(() => {
    const el = document.querySelector(`[data-agent-id="${AGENT_ID}"]`);
    assert.ok(el, "the agent row renders in the People tab's Agents list");
    return el as Element;
  });

  await waitFor(() => {
    assert.ok(
      scrolled.some((entry) => entry.element === row && entry.block === "center" && entry.behavior === "smooth"),
      "the agent's own row is scrolled to the list center",
    );
  });
});

test("a non-agent route does not scroll any agent row", async () => {
  setupStores();
  render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(scrolled.length, 0, "chat mode never locates agent rows");
});

test("a crafted agent id never crashes the sidebar and does not scroll", async () => {
  setupStores();
  // `serverRouteAgentId` URL-decodes, so this path yields the id `x"]` —
  // unescaped it would produce an invalid selector and throw inside the
  // effect, taking the whole render tree down.
  render(
    <MemoryRouter initialEntries={["/s/dev/agent/x%22%5D"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(scrolled.length, 0, "nothing matches the crafted id, so nothing scrolls");
  // The sidebar is still alive (the whole tree would be gone on a throw).
  assert.ok(document.querySelector('[data-agent-id]'), "the agents list still renders");
});
