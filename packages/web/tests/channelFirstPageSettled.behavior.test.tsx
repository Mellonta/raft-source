/**
 * task #17 (staging load speed): opening a channel fired members,
 * notification-settings, read-receipt and recoverable-upload requests alongside
 * `GET /messages/channel/:id`; that concurrency stretched the page request from
 * 0.5–0.8s to 1.1s+. Those fetches now wait on `useChannelFirstPageSettled`.
 * The gate must open when the page lands, stay open across background reloads
 * (so it never re-fires what it guards), and open on a timeout so a load path
 * that never records window state cannot block them forever.
 */
import assert from "node:assert/strict";
import { afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  CHANNEL_FIRST_PAGE_MAX_WAIT_MS,
  useChannelFirstPageSettled,
} from "../src/hooks/useChannelFirstPageSettled";
import type { Message } from "../src/store/messageStore";
import { useMessageStore } from "../src/store/messageStore";

const CHANNEL = "channel-first-page";

function message(id: string): Message {
  return { id, channelId: CHANNEL, senderType: "user", senderId: "u1", content: id, createdAt: "2026-10-04T00:00:00Z", seq: 1 } as Message;
}

function setWindow(loading: boolean, bucket: Message[]) {
  useMessageStore.setState((state) => ({
    channelMessages: { ...state.channelMessages, [CHANNEL]: bucket },
    channelWindowMeta: { ...state.channelWindowMeta, [CHANNEL]: { ...state.channelWindowMeta[CHANNEL], loading } },
  }) as never);
}

afterEach(() => {
  vi.useRealTimers();
  useMessageStore.setState(useMessageStore.getInitialState(), true);
});

test("stays closed while the first page loads and opens when it lands", () => {
  const { result } = renderHook(() => useChannelFirstPageSettled(CHANNEL));
  assert.equal(result.current, false, "a never-loaded channel is not settled");

  act(() => setWindow(true, []));
  assert.equal(result.current, false, "still loading");

  act(() => setWindow(false, [message("m1")]));
  assert.equal(result.current, true, "the page landed");
});

test("an empty channel settles when its load finishes", () => {
  const { result } = renderHook(() => useChannelFirstPageSettled(CHANNEL));
  act(() => setWindow(true, []));
  act(() => setWindow(false, []));
  assert.equal(result.current, true);
});

test("once open, a background reload does not close the gate again", () => {
  const { result } = renderHook(() => useChannelFirstPageSettled(CHANNEL));
  act(() => setWindow(false, []));
  assert.equal(result.current, true);

  act(() => setWindow(true, []));
  assert.equal(result.current, true, "latched for this channel");
});

test("opens after the max wait when no window state is ever recorded", () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useChannelFirstPageSettled(CHANNEL));
  assert.equal(result.current, false);

  act(() => { vi.advanceTimersByTime(CHANNEL_FIRST_PAGE_MAX_WAIT_MS - 1); });
  assert.equal(result.current, false, "not before the bound");
  act(() => { vi.advanceTimersByTime(1); });
  assert.equal(result.current, true, "opens at the bound");
});

test("switching channels closes the gate for the new channel until its page lands", () => {
  act(() => setWindow(false, [message("m1")]));
  const { result, rerender } = renderHook(({ id }) => useChannelFirstPageSettled(id), { initialProps: { id: CHANNEL } });
  assert.equal(result.current, true);

  rerender({ id: "other-channel" });
  assert.equal(result.current, false, "the other channel has no page yet");
});
