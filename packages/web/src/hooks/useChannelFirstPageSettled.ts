import { useEffect, useState } from "react";
import { useMessageStore } from "../store/messageStore";
import type { MessageState } from "../store/messageStore";

/** Upper bound on how long secondary fetches wait for the first page. */
export const CHANNEL_FIRST_PAGE_MAX_WAIT_MS = 2000;

/**
 * True once a channel's first message page is available: its bucket already
 * holds messages (cached revisit), or its window has finished loading (empty
 * channel or failed load included).
 */
export function selectChannelFirstPageSettled(state: MessageState, channelId: string | null): boolean {
  if (!channelId) return false;
  if ((state.channelMessages[channelId]?.length ?? 0) > 0) return true;
  const meta = state.channelWindowMeta[channelId];
  return !!meta && !meta.loading;
}

/**
 * Gate for per-channel fetches that the first paint does not need (members,
 * notification settings, read receipts, recoverable uploads). Opening a
 * channel used to fire them alongside `GET /messages/channel/:id`; on staging
 * that concurrency stretched the page request from 0.5–0.8s to 1.1s+, and the
 * page is what the user waits for (task #17). They now start once the page is
 * in, or after CHANNEL_FIRST_PAGE_MAX_WAIT_MS so nothing waits forever on a
 * load path that never records window state.
 */
export function useChannelFirstPageSettled(
  channelId: string | null,
  maxWaitMs = CHANNEL_FIRST_PAGE_MAX_WAIT_MS,
): boolean {
  const settled = useMessageStore((state) => selectChannelFirstPageSettled(state, channelId));
  // Latched per channel: a later background reload must not flip the gate and
  // re-run the fetches it guards.
  const [openedChannelId, setOpenedChannelId] = useState<string | null>(null);

  // Latch as soon as the page is in (React's adjust-state-during-render
  // pattern), so the effect below only owns the fallback timer.
  if (settled && channelId && openedChannelId !== channelId) {
    setOpenedChannelId(channelId);
  }

  useEffect(() => {
    if (!channelId || settled || openedChannelId === channelId) return;
    const timer = setTimeout(() => setOpenedChannelId(channelId), maxWaitMs);
    return () => clearTimeout(timer);
  }, [channelId, maxWaitMs, openedChannelId, settled]);

  return channelId !== null && (settled || openedChannelId === channelId);
}
