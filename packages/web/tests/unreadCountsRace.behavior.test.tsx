import assert from "node:assert/strict";
import { parseUnreadSnapshot } from "../src/store/messageStore";

test("sidebar mention flags ignore read mention history from unread summaries", () => {
  const snapshot = parseUnreadSnapshot({
    channels: {
      "channel-read-mention": {
        unreadCount: 0,
        hasMention: false,
        hasAnyMention: true,
      },
      "channel-unread-mention": {
        unreadCount: 1,
        hasMention: true,
        hasAnyMention: true,
      },
      "channel-unread-plain": {
        unreadCount: 2,
        hasMention: false,
        hasAnyMention: false,
      },
    },
  });

  assert.deepEqual(snapshot.unreadCounts, {
    "channel-unread-mention": 1,
    "channel-unread-plain": 2,
  });
  assert.deepEqual(snapshot.mentionFlags, {
    "channel-unread-mention": true,
  });
});

test("unread summary hasNew marks non-joined channels without inventing a count", () => {
  const snapshot = parseUnreadSnapshot({
    channels: {
      "channel-not-joined": { unreadCount: 0, hasMention: false, hasAnyMention: false, hasNew: true },
      "channel-joined": { unreadCount: 3, hasMention: false, hasAnyMention: false },
    },
  });
  assert.deepEqual(snapshot.unreadCounts, { "channel-joined": 3 });
  assert.deepEqual(snapshot.newFlags, { "channel-not-joined": true });
});
