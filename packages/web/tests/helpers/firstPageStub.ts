import { useMessageStore } from "../../src/store/messageStore";

/**
 * `loadMessages` stub that records a loaded (empty) first page, as the real
 * loader does. ChatPanel holds members, notification settings and read
 * receipts until the first page settles (task #17); a bare `async () => {}`
 * stub never settles it, so those loads would only start after the 2s
 * fallback.
 */
export async function settleFirstPageLoadMessages(channelId: string): Promise<void> {
  useMessageStore.setState((state) => ({
    channelWindowMeta: {
      ...state.channelWindowMeta,
      [channelId]: { ...state.channelWindowMeta[channelId], loading: false },
    },
  }) as never);
}
