import assert from "node:assert/strict";
import { cleanup, render } from "@testing-library/react";
import { useRecordRecentConversation } from "../src/components/search/useRecordRecentConversation";
import { useAuthStore } from "../src/store/authStore";
import { useRecentConversationStore } from "../src/store/recentConversationStore";
import { useServerStore } from "../src/store/serverStore";
import type { User } from "../src/store/authStore";
import type { Server } from "../src/store/serverStore";

// Task #113 — the channel / DM routes record the conversation the user is in;
// the ⌘K overlay reads that history as "recent conversations".

function Probe({ channelId }: { channelId: string | null }) {
  useRecordRecentConversation(channelId);
  return null;
}

afterEach(() => {
  cleanup();
  useRecentConversationStore.setState({ scopes: {} });
});

test("records resolved conversations most-recent-first, skips null, and does not rewrite on a repeat of the head", () => {
  useAuthStore.setState({ user: { id: "user-1" } as User });
  useServerStore.setState({ current: { id: "server-1", slug: "server" } as Server });

  const view = render(<Probe channelId={null} />);
  assert.deepEqual(useRecentConversationStore.getState().scopes, {}, "unresolved routes write nothing");

  view.rerender(<Probe channelId="c1" />);
  assert.deepEqual(useRecentConversationStore.getState().scopes["server-1:user-1"]?.channelIds, ["c1"]);

  view.rerender(<Probe channelId="c2" />);
  assert.deepEqual(useRecentConversationStore.getState().scopes["server-1:user-1"]?.channelIds, ["c2", "c1"]);

  const before = useRecentConversationStore.getState();
  useRecentConversationStore.getState().recordVisit("server-1:user-1", "c2");
  assert.equal(useRecentConversationStore.getState(), before, "re-visiting the head is a no-op (no re-render storm)");

  view.rerender(<Probe channelId="c1" />);
  assert.deepEqual(useRecentConversationStore.getState().scopes["server-1:user-1"]?.channelIds, ["c1", "c2"]);
});

test("without a server or user nothing is recorded", () => {
  useAuthStore.setState({ user: null });
  useServerStore.setState({ current: null });
  render(<Probe channelId="c1" />);
  assert.deepEqual(useRecentConversationStore.getState().scopes, {});
});
