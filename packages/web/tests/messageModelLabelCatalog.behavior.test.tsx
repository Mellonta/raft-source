/**
 * Task #700 (Kai's review): the model name on an agent's message row is the
 * shared catalog's name. The row is memoized, so a catalog that arrives after
 * first paint must still update the visible name — the row subscribes through
 * `useCatalogModelLabel` instead of reading the store at render time.
 */
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MessageItem from "../src/components/message/MessageItem";
import type { Message } from "../src/store/messageStore";
import { useAgentStore } from "../src/store/agentStore";
import { useAppearanceStore } from "../src/store/appearanceStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import { useModelLabelCatalogStore } from "../src/store/modelLabelCatalogStore";
import { useSavedStore } from "../src/store/savedStore";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}
Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });

const CHANNEL_ID = "channel-model-label";
const MACHINE_ID = "machine-model-label";
const AGENT_ID = "agent-model-label";

function agentMessage(): Message {
  return {
    id: "message-model-label",
    channelId: CHANNEL_ID,
    senderType: "agent",
    senderId: AGENT_ID,
    senderName: "Kirby",
    content: "hello from the machine",
    createdAt: "2026-09-29T09:00:00Z",
    seq: 2,
  } as Message;
}

function seedStores() {
  useAuthStore.setState({
    user: { id: "user-current", name: "current-user", displayName: "Current User" },
    accessToken: "token",
    initialized: true,
  } as never);
  useServerStore.setState({ current: { id: "server-1", name: "S", slug: "s" }, members: [] } as never);
  useAgentStore.setState({
    agents: [{
      id: AGENT_ID,
      name: "kirby",
      displayName: "Kirby",
      runtime: "codex",
      model: "gpt-6-astra",
      machineId: MACHINE_ID,
      type: "agent",
    }],
    agentActivities: {},
  } as never);
  useChannelStore.setState({
    channels: [{ id: CHANNEL_ID, name: "general", type: "channel" }],
    dms: [],
    selectedChannelId: CHANNEL_ID,
  } as never);
  useSavedStore.setState({ saved: [], savedIds: new Set(), loading: false, hasMore: false } as never);
  useMessageStore.setState({ messages: { [CHANNEL_ID]: [agentMessage()] }, drafts: {} } as never);
  useAppearanceStore.setState({ showAgentModelName: true } as never);
  useModelLabelCatalogStore.setState({ byServer: {}, inflight: {} });
}

afterEach(cleanup);

test("an agent row picks up the shared catalog name arriving after first paint", async () => {
  seedStores();
  const view = render(
    <TestIntlProvider>
      <MemoryRouter>
        <MessageItem message={agentMessage()} mentionMap={{}} channels={[]} parentChannelId={CHANNEL_ID} />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  // First paint: no catalog yet, the bundled fallback answers (staging table
  // spells this one "GPT-6-Astra").
  await waitFor(() => assert.ok(view.queryByText("GPT-6-Astra"), "fallback name renders first"));

  // The catalog arrives (daemon report stored server side, fetched by the app).
  // Assert synchronously after the store update: rows also re-render
  // incidentally (timers/other stores), so a tolerant `waitFor` would pass
  // even without the row's own subscription — the guarantee under test is
  // that the row updates BECAUSE of this store change.
  act(() => {
    useModelLabelCatalogStore.setState({
      byServer: {
        "server-1": {
          catalog: {
            machines: {
              [MACHINE_ID]: {
                runtimes: {
                  codex: { models: [{ id: "gpt-6-astra", label: "Astra From Machine" }], updatedAt: "t" },
                },
              },
            },
          },
          fetchedAt: Date.now(),
        },
      },
      inflight: {},
    });
  });

  assert.ok(
    view.queryByText("Astra From Machine"),
    "the memoized row must re-render on the catalog store update itself",
  );
  assert.equal(view.queryByText("GPT-6-Astra"), null, "the fallback name is replaced");
});
