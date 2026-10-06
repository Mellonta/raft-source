/**
 * task #17 (staging load speed): opening a thread took 0.2–1s before the first
 * request left the page. Every mounted message row subscribed to the raw
 * `openParentMessageId` / `openParentChannelId`, only to derive one boolean, so
 * each thread open/close re-rendered EVERY row of the (non-windowed) timeline.
 * A row now subscribes to its own boolean: only the old and new parent re-render.
 *
 * Counting: each row sits in its own <Profiler> under a parent that never
 * re-renders, and the change under test is a thread-store update only, so a
 * Profiler commit means that row itself re-rendered.
 */
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import { Profiler, act } from "react";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MessageItem from "../src/components/message/MessageItem";
import type { Message } from "../src/store/messageStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import { useSavedStore } from "../src/store/savedStore";
import { useServerStore } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";
import { TestIntlProvider } from "./helpers/intl";

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}
Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });

const CHANNEL_ID = "channel-thread-open";

function row(id: string, seq: number): Message {
  return {
    id,
    channelId: CHANNEL_ID,
    senderType: "user",
    senderId: "user-current",
    senderName: "Current User",
    content: `message ${id}`,
    createdAt: `2026-10-04T10:0${seq}:00Z`,
    seq,
  } as Message;
}
const ROWS = [row("m1", 1), row("m2", 2), row("m3", 3), row("m4", 4)];

function seedStores() {
  useAuthStore.setState({
    user: { id: "user-current", name: "current-user", displayName: "Current User" },
    accessToken: "token",
    initialized: true,
  } as never);
  useServerStore.setState({ current: { id: "server-1", name: "S", slug: "s" }, members: [] } as never);
  useChannelStore.setState({
    channels: [{ id: CHANNEL_ID, name: "general", type: "channel" }],
    dms: [],
    selectedChannelId: CHANNEL_ID,
  } as never);
  useSavedStore.setState({ saved: [], savedIds: new Set(), loading: false, hasMore: false } as never);
  useMessageStore.setState({ messages: { [CHANNEL_ID]: ROWS }, drafts: {} } as never);
  useThreadStore.setState({ openParentMessageId: null, openParentChannelId: null } as never);
}

afterEach(() => {
  cleanup();
  useThreadStore.setState(useThreadStore.getInitialState(), true);
});

test("[render-perf] opening and switching threads re-renders only the old and new parent rows", () => {
  seedStores();
  const commits = new Map<string, number>();
  const count = (id: string) => commits.set(id, (commits.get(id) ?? 0) + 1);
  render(
    <TestIntlProvider>
      <MemoryRouter>
        {ROWS.map((message) => (
          <Profiler key={message.id} id={message.id} onRender={(id) => count(id)}>
            <MessageItem message={message} mentionMap={{}} channels={[]} parentChannelId={CHANNEL_ID} />
          </Profiler>
        ))}
      </MemoryRouter>
    </TestIntlProvider>,
  );

  commits.clear();
  act(() => {
    useThreadStore.setState({ openParentMessageId: "m2", openParentChannelId: CHANNEL_ID } as never);
  });
  assert.ok((commits.get("m2") ?? 0) >= 1, "the newly opened parent must re-render (selected state)");
  assert.deepEqual(
    ["m1", "m3", "m4"].filter((id) => commits.has(id)),
    [],
    "rows that are not the thread parent must not re-render when a thread opens",
  );

  commits.clear();
  act(() => {
    useThreadStore.setState({ openParentMessageId: "m3", openParentChannelId: CHANNEL_ID } as never);
  });
  assert.deepEqual([...commits.keys()].sort(), ["m2", "m3"], "switching threads touches only the old and new parent");
});
