import assert from "node:assert/strict";
import type { InboxItem } from "../src/store/inboxStore";

class MemoryStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string) {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.map.set(key, value);
  }

  removeItem(key: string) {
    this.map.delete(key);
  }
}

Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
Object.defineProperty(globalThis, "sessionStorage", { value: new MemoryStorage(), configurable: true });

const { default: api } = await import("../src/api/client");
const { triggerServerReset } = await import("../src/store/serverResetRegistry");
const { useInboxStore } = await import("../src/store/inboxStore");
const { useMessageStore } = await import("../src/store/messageStore");
const { useServerStore } = await import("../src/store/serverStore");
const { consumeReadStateUpdate, resetReadStateSyncForTests } = await import("../src/store/readStateSync");

const originalGet = api.get.bind(api);

function servedRow(readStateVersion: number, maxReadSeq: string, latestSeq: string) {
  return {
    kind: "channel",
    channelId: "scope-a",
    channelName: "alpha",
    channelType: "channel",
    lastMessageId: "message-latest",
    firstUnreadMessageId: "message-first-unread",
    firstMentionMessageId: null,
    lastMessageAt: "2026-09-25T00:00:00.000Z",
    lastMessagePreview: "alpha",
    lastMessageSenderType: "user",
    lastMessageSenderId: "user-a",
    lastMessageSenderName: "alice",
    unreadCount: 6,
    hasMention: false,
    readState: {
      kind: "present",
      readStateVersion,
      maxReadSeq,
      latestActivity: { messageId: "message-latest", seq: latestSeq },
    },
  };
}

async function loadWith(row: ReturnType<typeof servedRow>) {
  triggerServerReset();
  resetReadStateSyncForTests();
  useServerStore.setState({ current: { id: "server-a" } as never, serverEpoch: 1 });
  useMessageStore.setState({ currentUserId: "viewer" });
  useInboxStore.setState({ items: [], filter: "all", loaded: false } as Partial<ReturnType<typeof useInboxStore.getState>>);
  api.get = (async () => ({
    data: { items: [row], hasMore: false, totalCount: 1, totalUnreadCount: 6, activeUnreadCount: 6 },
  })) as typeof api.get;
}

test("a served row older than the ledger cannot resurrect unread the ledger already covers", async () => {
  try {
    await loadWith(servedRow(3, "4", "10"));
    // The client's own read reached the ledger (version 5, through seq 10) before RisingWave caught up.
    consumeReadStateUpdate({ serverId: "server-a", scopeId: "scope-a", maxReadSeq: 10, readStateVersion: 5 });
    await useInboxStore.getState().loadInbox({ reset: true });

    const [item] = useInboxStore.getState().items as InboxItem[];
    assert.equal(item?.unreadCount, 0);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
  } finally {
    api.get = originalGet as typeof api.get;
  }
});

test("a served row older than the ledger keeps its unread when newer activity lies beyond the ledger", async () => {
  try {
    await loadWith(servedRow(3, "4", "12"));
    consumeReadStateUpdate({ serverId: "server-a", scopeId: "scope-a", maxReadSeq: 10, readStateVersion: 5 });
    await useInboxStore.getState().loadInbox({ reset: true });

    const [item] = useInboxStore.getState().items as InboxItem[];
    assert.equal(item?.unreadCount, 6);
  } finally {
    api.get = originalGet as typeof api.get;
  }
});
