import assert from "node:assert/strict";
import {
  ingestThreadLiveReply,
  mergeThreadBucketWithinWindow,
  mergeThreadMessageUpdates,
  mergeThreadMessages,
  sameMessageList,
  subscribeThreadLiveReplies,
} from "../src/components/message/ThreadPanel";
import type { Message } from "../src/store/messageStore";

/**
 * Behavioral replacement for `threadPanelReactionRerender.test.ts` (a source-proxy
 * asserting ThreadPanel.tsx source contains a `sameReactions` function with
 * specific comparison lines). That proxy can't see behavior — it survives any
 * mutation that keeps the regex-matched text but breaks the logic.
 *
 * Behavior: `sameMessageList` is the equality used to stabilize the thread
 * message-list ref (mergeThreadMessages returns `existing` iff sameMessageList).
 * A reaction-only diff MUST be detected (return false → new ref → row re-renders
 * the new reactions); the original bug (#290) was the short-circuit IGNORING
 * reactions, leaving the thread UI stale until refresh.
 *
 * Mutant-kill (#39 RED): break `sameReactions` (e.g. drop the count check) so a
 * reaction-only diff reads as "same" → this test (expecting false) goes RED,
 * while the source-regex proxy stays GREEN.
 */

function msg(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "m1",
    seq: 1,
    content: "hello",
    createdAt: "2026-06-24T00:00:00.000Z",
    reactions: [{ emoji: "👍", count: 1, reactorIds: ["u1"] }],
    ...over,
  } as never;
}

function threadMsg(over: Partial<Message> = {}): Message {
  return {
    id: "reply-1",
    seq: undefined,
    channelId: "thread-channel-1",
    senderType: "user",
    senderId: "u-1",
    senderName: "Playwright Owner",
    messageType: "chat",
    content: "hello",
    createdAt: "2026-06-17T03:15:00.000Z",
    ...over,
  };
}

function threadHistory(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => threadMsg({
    id: `reply-${index}`,
    seq: index + 1,
    content: `reply ${index}`,
    createdAt: new Date(Date.UTC(2026, 6, 17, 0, 0, index)).toISOString(),
  }));
}

test("sameMessageList returns true for identical lists (no spurious ref churn)", () => {
  const a = [msg()];
  const b = [msg()];
  assert.equal(sameMessageList(a, b), true);
});

test("sameMessageList detects a reaction-only diff (count change) — returns false", () => {
  const a = [msg({ reactions: [{ emoji: "👍", count: 1, reactorIds: ["u1"] }] })];
  const b = [msg({ reactions: [{ emoji: "👍", count: 2, reactorIds: ["u1", "u2"] }] })];
  assert.equal(
    sameMessageList(a, b),
    false,
    "a reaction-only change (count 1→2) must be detected so the thread row re-renders the new reactions (#290)",
  );
});

test("sameMessageList detects a reaction emoji swap — returns false", () => {
  const a = [msg({ reactions: [{ emoji: "👍", count: 1, reactorIds: ["u1"] }] })];
  const b = [msg({ reactions: [{ emoji: "🎉", count: 1, reactorIds: ["u1"] }] })];
  assert.equal(sameMessageList(a, b), false, "an emoji swap must be detected as a diff");
});

test("sameMessageList compares normalized preview facts without requiring a legacy roster", () => {
  const a = [msg({
    reactions: [{ emoji: "👍", count: 2, previewK: [{ id: "u1", displayName: "Ada" }] }],
  })];
  const equal = [msg({
    reactions: [{ emoji: "👍", count: 2, previewK: [{ id: "u1", displayName: "Ada" }] }],
  })];
  const changed = [msg({
    reactions: [{ emoji: "👍", count: 2, previewK: [{ id: "u2", displayName: "Ben" }] }],
  })];

  assert.equal(sameMessageList(a, equal), true);
  assert.equal(sameMessageList(a, changed), false);
});

test("mergeThreadMessages replaces a stale-profile optimistic reply with its real socket echo", () => {
  const optimistic = threadMsg({
    id: "optimistic-local-send",
    senderId: "stale-user-id",
    senderName: "Playwright Owner",
    content: "stale profile send",
    createdAt: "2026-06-17T03:15:00.000Z",
  });
  const persisted = threadMsg({
    id: "server-message-1",
    seq: 1,
    senderId: "u-1",
    senderName: "Playwright Owner",
    content: optimistic.content,
    createdAt: "2026-06-17T03:15:01.000Z",
  });

  const merged = mergeThreadMessages([optimistic], [persisted]);

  assert.deepEqual(merged.map((message) => message.id), ["server-message-1"]);
});

test("mergeThreadMessages reconciles optimistic replies one-to-one", () => {
  const firstOptimistic = threadMsg({
    id: "optimistic-first",
    content: "same text twice",
    createdAt: "2026-06-17T03:15:00.000Z",
  });
  const secondOptimistic = threadMsg({
    id: "optimistic-second",
    content: "same text twice",
    createdAt: "2026-06-17T03:15:02.000Z",
  });
  const firstPersisted = threadMsg({
    id: "server-message-1",
    seq: 1,
    content: "same text twice",
    createdAt: "2026-06-17T03:15:01.000Z",
  });

  const merged = mergeThreadMessages([firstOptimistic, secondOptimistic], [firstPersisted]);

  assert.deepEqual(merged.map((message) => message.id), ["server-message-1", "optimistic-second"]);
});

test("mergeThreadMessages drops each optimistic reply at most once when two real echoes arrive", () => {
  const firstOptimistic = threadMsg({
    id: "optimistic-first",
    content: "same text twice",
    createdAt: "2026-06-17T03:15:00.000Z",
  });
  const secondOptimistic = threadMsg({
    id: "optimistic-second",
    content: "same text twice",
    createdAt: "2026-06-17T03:15:02.000Z",
  });
  const firstPersisted = threadMsg({
    id: "server-message-1",
    seq: 1,
    content: "same text twice",
    createdAt: "2026-06-17T03:15:01.000Z",
  });
  const secondPersisted = threadMsg({
    id: "server-message-2",
    seq: 2,
    content: "same text twice",
    createdAt: "2026-06-17T03:15:03.000Z",
  });

  const merged = mergeThreadMessages([firstOptimistic, secondOptimistic], [firstPersisted, secondPersisted]);

  assert.deepEqual(merged.map((message) => message.id), ["server-message-1", "server-message-2"]);
});

test("mergeThreadMessages keeps unrelated optimistic replies when a real message does not match", () => {
  const optimistic = threadMsg({
    id: "optimistic-local-send",
    content: "pending text",
    createdAt: "2026-06-17T03:15:00.000Z",
  });
  const persisted = threadMsg({
    id: "server-message-1",
    seq: 1,
    content: "different text",
    createdAt: "2026-06-17T03:15:01.000Z",
  });

  const merged = mergeThreadMessages([optimistic], [persisted]);

  assert.deepEqual(merged.map((message) => message.id).sort(), ["optimistic-local-send", "server-message-1"]);
});

test("a partial attachment-comment privacy update cannot replace a full thread message", () => {
  const persisted = threadMsg({
    id: "attachment-comment-1",
    seq: 2,
    content: "anchored review comment",
    commentRef: {
      attachmentId: "attachment-1",
      filename: "review.md",
      hostMessageId: "parent-message-1",
      hostSource: null,
      anchorLabel: "L3",
    },
  });
  const privacyScrubUpdate = {
    id: persisted.id,
    channelId: persisted.channelId,
    commentRef: null,
  } as Message;

  const merged = mergeThreadMessageUpdates([persisted], [privacyScrubUpdate]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.content, "anchored review comment");
  assert.equal(merged[0]?.seq, 2);
  assert.deepEqual(merged[0]?.commentRef, persisted.commentRef);
});

test("a partial thread update never appends an incomplete unknown message", () => {
  const persisted = threadMsg({ id: "reply-1", content: "existing reply" });
  const existing = [persisted];
  const unknownPrivacyScrubUpdate = {
    id: "attachment-comment-not-loaded",
    channelId: persisted.channelId,
    commentRef: null,
  } as Message;

  const merged = mergeThreadMessageUpdates(existing, [unknownPrivacyScrubUpdate]);

  assert.equal(merged, existing);
});

test("sync resume cannot hydrate older replies outside an empty latest-50 thread window", () => {
  const resumeHistory = threadHistory(103);

  const projected = mergeThreadBucketWithinWindow([], resumeHistory, false);

  assert.equal(projected.length, 50);
  assert.equal(projected[0]?.id, "reply-53");
  assert.equal(projected.at(-1)?.id, "reply-102");
  assert.equal(projected.some((message) => message.id === "reply-0"), false);
});

test("an empty focused-history window ignores replay until its HTTP page arrives", () => {
  const projected = mergeThreadBucketWithinWindow([], threadHistory(103), true);

  assert.deepEqual(projected, []);
});

test("sync resume respects each deliberately prepended lower history boundary", () => {
  const resumeHistory = threadHistory(103);
  const latest = resumeHistory.slice(53);

  const afterResume = mergeThreadBucketWithinWindow(latest, resumeHistory, false);
  assert.equal(afterResume, latest, "an all-history replay must not expand the initial HTTP window");

  const afterFirstPrepend = [...resumeHistory.slice(3, 53), ...latest];
  const afterFirstResume = mergeThreadBucketWithinWindow(afterFirstPrepend, resumeHistory, false);
  assert.equal(afterFirstResume, afterFirstPrepend);
  assert.equal(afterFirstResume[0]?.id, "reply-3");
  assert.equal(afterFirstResume.some((message) => message.id === "reply-0"), false);

  const fullyLoaded = [...resumeHistory.slice(0, 3), ...afterFirstPrepend];
  const afterFinalResume = mergeThreadBucketWithinWindow(fullyLoaded, resumeHistory, false);
  assert.equal(afterFinalResume, fullyLoaded);
  assert.equal(afterFinalResume[0]?.id, "reply-0");
});

test("thread bucket projection still accepts realtime tail rows and in-window updates", () => {
  const history = threadHistory(55);
  const latest = history.slice(5);
  const updated = { ...latest[10]!, content: "edited in place" };
  const realtime = threadMsg({ id: "reply-55", seq: 56, content: "new tail" });

  const projected = mergeThreadBucketWithinWindow(
    latest,
    [history[0]!, updated, realtime],
    false,
  );

  assert.equal(projected.length, 51);
  assert.equal(projected.some((message) => message.id === "reply-0"), false);
  assert.equal(projected.find((message) => message.id === updated.id)?.content, "edited in place");
  assert.equal(projected.at(-1)?.id, "reply-55");
});

test("thread bucket projection accepts missing rows inside the loaded sequence window", () => {
  const history = threadHistory(12);
  const withGap = history.slice(5, 12).filter((message) => message.seq !== 9);

  const projected = mergeThreadBucketWithinWindow(withGap, [history[8]!], false);

  assert.deepEqual(projected.map((message) => message.seq), [6, 7, 8, 9, 10, 11, 12]);
});

test("same-id canonical updates remain legal even when their sequence moves below the loaded boundary", () => {
  const window = threadHistory(12).slice(5);
  const canonicalUpdate = { ...window[0]!, seq: 2, content: "canonical correction" };

  const projected = mergeThreadBucketWithinWindow(window, [canonicalUpdate], false);

  assert.equal(projected.find((message) => message.id === canonicalUpdate.id)?.seq, 2);
  assert.equal(projected.find((message) => message.id === canonicalUpdate.id)?.content, "canonical correction");
});

test("latest windows accept optimistic tails but reject unrelated unsequenced replay rows", () => {
  const window = threadHistory(12).slice(5);
  const optimistic = threadMsg({ id: "optimistic-local-send", content: "pending tail" });
  const unsequencedReplay = threadMsg({ id: "unsequenced-replay", content: "not a local send" });

  const projected = mergeThreadBucketWithinWindow(window, [unsequencedReplay, optimistic], false);

  assert.equal(projected.some((message) => message.id === unsequencedReplay.id), false);
  assert.equal(projected.some((message) => message.id === optimistic.id), true);
});

test("optimistic-only windows reconcile at the latest edge but stay closed in focused history", () => {
  const optimistic = threadMsg({
    id: "optimistic-local-send",
    content: "pending tail",
    createdAt: "2026-06-17T03:15:00.000Z",
  });
  const persisted = threadMsg({
    id: "server-message-1",
    seq: 1,
    content: optimistic.content,
    createdAt: "2026-06-17T03:15:01.000Z",
  });

  const latestProjected = mergeThreadBucketWithinWindow([optimistic], [persisted], false);
  assert.deepEqual(latestProjected.map((message) => message.id), [persisted.id]);

  const focusedProjected = mergeThreadBucketWithinWindow([optimistic], [persisted], true);
  assert.deepEqual(focusedProjected.map((message) => message.id), [optimistic.id]);
});

test("an optimistic-only latest window bounds a full resume replay to the latest persisted tail", () => {
  const resumeHistory = threadHistory(103);
  const optimistic = threadMsg({ id: "optimistic-local-send", content: "pending tail" });

  const projected = mergeThreadBucketWithinWindow([optimistic], resumeHistory, false);

  assert.equal(projected.length, 51);
  assert.equal(projected.filter((message) => typeof message.seq === "number").length, 50);
  assert.equal(projected.some((message) => message.id === "reply-0"), false);
  assert.equal(projected.some((message) => message.id === "reply-53"), true);
  assert.equal(projected.some((message) => message.id === optimistic.id), true);
});

test("the bounded full replay still reconciles an optimistic row with its persisted echo", () => {
  const resumeHistory = threadHistory(103);
  const optimistic = threadMsg({
    id: "optimistic-local-send",
    content: "pending tail",
    createdAt: "2026-06-17T03:15:00.000Z",
  });
  const echo = threadMsg({
    id: "server-message-104",
    seq: 104,
    content: optimistic.content,
    createdAt: "2026-06-17T03:15:01.000Z",
  });

  const projected = mergeThreadBucketWithinWindow(
    [optimistic],
    [...resumeHistory, echo],
    false,
  );

  assert.equal(projected.length, 50);
  assert.equal(projected.some((message) => message.id === optimistic.id), false);
  assert.equal(projected.some((message) => message.id === echo.id), true);
  assert.equal(projected.some((message) => message.id === "reply-0"), false);
});

test("optimistic-only latest windows keep local optimistic rows without admitting unsequenced replay", () => {
  const resumeHistory = threadHistory(103);
  const firstOptimistic = threadMsg({ id: "optimistic-first", content: "first pending tail" });
  const secondOptimistic = threadMsg({ id: "optimistic-second", content: "second pending tail" });
  const unsequencedReplay = threadMsg({ id: "unsequenced-replay", content: "not a local send" });

  const projected = mergeThreadBucketWithinWindow(
    [firstOptimistic],
    [...resumeHistory, unsequencedReplay, secondOptimistic],
    false,
  );

  assert.equal(projected.filter((message) => typeof message.seq === "number").length, 50);
  assert.equal(projected.some((message) => message.id === firstOptimistic.id), true);
  assert.equal(projected.some((message) => message.id === secondOptimistic.id), true);
  assert.equal(projected.some((message) => message.id === unsequencedReplay.id), false);
  assert.equal(projected.some((message) => message.id === "reply-0"), false);
});

test("an optimistic tail does not erase the persisted lower boundary", () => {
  const history = threadHistory(12);
  const optimistic = threadMsg({ id: "optimistic-local-send", content: "pending tail" });
  const window = [...history.slice(5), optimistic];

  const projected = mergeThreadBucketWithinWindow(window, [history[0]!], false);

  assert.equal(projected.some((message) => message.id === history[0]!.id), false);
  assert.equal(projected.some((message) => message.id === optimistic.id), true);
});

test("focused optimistic-only windows still accept canonical updates to an existing row", () => {
  const optimistic = threadMsg({ id: "optimistic-local-send", content: "pending tail" });
  const canonicalUpdate = { ...optimistic, content: "canonical pending tail" };

  const projected = mergeThreadBucketWithinWindow([optimistic], [canonicalUpdate], true);

  assert.equal(projected[0]?.content, canonicalUpdate.content);
});

test("focused thread windows keep both replay boundaries intact", () => {
  const history = threadHistory(120);
  const focusedWindow = history.slice(40, 90);
  const adjacentNewer = history[90]!;
  const gappedNewer = history[95]!;

  const projected = mergeThreadBucketWithinWindow(
    focusedWindow,
    [history[0]!, adjacentNewer, gappedNewer],
    true,
  );

  assert.equal(projected[0]?.id, "reply-40");
  assert.equal(projected.at(-1)?.id, "reply-90");
  assert.equal(projected.some((message) => message.id === "reply-0"), false);
  assert.equal(projected.some((message) => message.id === "reply-95"), false);
});

// ingestThreadLiveReply — the shared ingest both message:new and thread:updated
// funnel through. The core fix: a reply arriving ONLY via thread:updated (as for
// a DM/private-parent thread you opened but don't follow, where message:new never
// reaches you) must land in the open list; and because both events fire on a
// public thread, the count must de-dupe across BOTH entries and BOTH orders —
// tracked by a window-independent counted-id set, not list membership.
function liveState(messages: Message[] = []) {
  return { messages, seenReplyIds: new Set<string>() };
}

test("ingestThreadLiveReply appends a reply arriving only via thread:updated (the core fix)", () => {
  const state = liveState(threadHistory(3)); // reply-0..2, seq 1..3
  const live = threadMsg({ id: "reply-live", seq: 4, content: "arrived via thread:updated" });

  const { messages, countedNew } = ingestThreadLiveReply(state, live, { hasNewer: false, isNearBottom: true });

  assert.equal(messages.some((m) => m.id === "reply-live"), true, "the live reply must appear in the open thread");
  assert.equal(countedNew, false, "at the bottom the view auto-scrolls, so no unread bump");
});

test("ingestThreadLiveReply counts a new reply when the reader is scrolled up", () => {
  const state = liveState(threadHistory(3));
  const { messages, countedNew } = ingestThreadLiveReply(state, threadMsg({ id: "reply-live", seq: 4 }), {
    hasNewer: false,
    isNearBottom: false,
  });
  assert.equal(messages.some((m) => m.id === "reply-live"), true);
  assert.equal(countedNew, true, "away from the bottom, a new reply surfaces as a 'new messages' bump");
});

test("ingestThreadLiveReply surfaces a gapped reply as new without inserting it out of order", () => {
  const state = liveState(threadHistory(3)); // max seq 3
  const { messages, countedNew } = ingestThreadLiveReply(state, threadMsg({ id: "reply-far", seq: 99 }), {
    hasNewer: true,
    isNearBottom: true,
  });
  assert.equal(messages, state.messages, "with a newer window loaded, a gapped reply must not be inserted");
  assert.equal(countedNew, true, "it is surfaced as new so the reader can jump to it");
});

// The reviewer's blocking case: BOTH events deliver the same reply (public
// thread). Count must increment exactly once, in EITHER arrival order.
test("ingestThreadLiveReply counts a reply once when message:new then thread:updated both deliver it", () => {
  const state = liveState(threadHistory(3));
  const reply = threadMsg({ id: "reply-live", seq: 4 });
  const opts = { hasNewer: false, isNearBottom: false }; // scrolled up → would count

  const first = ingestThreadLiveReply(state, reply, opts);
  state.messages = first.messages; // simulate setMessages committing the merge
  const second = ingestThreadLiveReply(state, reply, opts);

  assert.equal(first.countedNew, true);
  assert.equal(second.countedNew, false, "the second event for the same reply must not count again");
  assert.equal(state.messages.filter((m) => m.id === "reply-live").length, 1, "the reply is present exactly once");
});

test("ingestThreadLiveReply counts a reply once when thread:updated then message:new both deliver it", () => {
  const state = liveState(threadHistory(3));
  const reply = threadMsg({ id: "reply-live", seq: 4 });
  const opts = { hasNewer: false, isNearBottom: false };

  const first = ingestThreadLiveReply(state, reply, opts); // thread:updated first
  state.messages = first.messages;
  const second = ingestThreadLiveReply(state, reply, opts); // message:new second

  assert.equal(first.countedNew, true);
  assert.equal(second.countedNew, false, "order must not matter — still counted once");
});

test("ingestThreadLiveReply counts a gapped reply once across both events (dedup independent of the list)", () => {
  const state = liveState(threadHistory(3)); // max seq 3
  const gapped = threadMsg({ id: "reply-far", seq: 99 });
  const opts = { hasNewer: true, isNearBottom: true };

  const first = ingestThreadLiveReply(state, gapped, opts);
  // The gapped reply was NOT inserted, so a list-id check can't catch the second
  // event — only the counted-id set can.
  const second = ingestThreadLiveReply(state, gapped, opts);

  assert.equal(first.countedNew, true);
  assert.equal(second.countedNew, false, "a gapped, un-inserted reply must still not double-count");
  assert.equal(state.messages.some((m) => m.id === "reply-far"), false);
});

test("ingestThreadLiveReply does not re-count a bottom-received reply after the reader scrolls up", () => {
  const state = liveState(threadHistory(3));
  const reply = threadMsg({ id: "reply-live", seq: 4 });

  // Arrives while pinned to the bottom: shown, not counted.
  const atBottom = ingestThreadLiveReply(state, reply, { hasNewer: false, isNearBottom: true });
  state.messages = atBottom.messages;
  assert.equal(atBottom.countedNew, false);

  // Reader scrolls up; a second event (or replay) carries the SAME reply.
  const scrolledUp = ingestThreadLiveReply(state, reply, { hasNewer: false, isNearBottom: false });
  assert.equal(scrolledUp.countedNew, false, "a reply already shown must not be counted just because the reader scrolled up");
});

test("ingestThreadLiveReply never counts a reply that was already in the loaded window (replay)", () => {
  const loaded = threadHistory(3); // reply-0..2 already loaded from the initial fetch
  const state = liveState(loaded);
  const replay = { ...loaded[1]! }; // reply-1 re-delivered live

  const r = ingestThreadLiveReply(state, replay, { hasNewer: false, isNearBottom: false });
  assert.equal(r.countedNew, false, "an already-loaded reply replayed live must not be counted");
  assert.equal(r.messages.filter((m) => m.id === "reply-1").length, 1);
});

// Real socket-wiring regression: exercises subscribeThreadLiveReplies through a
// fake socket (both listeners registered, funnel through the shared seen-set,
// cleanup unregisters) — so a broken wiring is caught even if the pure helper is
// green. Covers both arrival orders: count must land exactly once.
function fakeSocket() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    on(event: string, h: (...args: unknown[]) => void) {
      (handlers.get(event) ?? handlers.set(event, new Set()).get(event)!).add(h);
    },
    off(event: string, h: (...args: unknown[]) => void) {
      handlers.get(event)?.delete(h);
    },
    emit(event: string, payload: unknown) {
      for (const h of handlers.get(event) ?? []) h(payload);
    },
    count(event: string) { return handlers.get(event)?.size ?? 0; },
  };
}

function wireLiveReplies(socket: ReturnType<typeof fakeSocket>, threadChannelId: string) {
  let messages: Message[] = [];
  let newCount = 0;
  const dispose = subscribeThreadLiveReplies({
    socket,
    threadChannelId,
    parentMessageId: "parent-1",
    normalizeReply: (raw) => {
      const m = raw as Message | null;
      return m && typeof m === "object" && m.channelId === threadChannelId ? m : null;
    },
    getScroll: () => ({ hasNewer: false, isNearBottom: false }), // scrolled up → a new reply would count
    setMessages: (updater) => { messages = updater(messages); },
    bumpNewCount: () => { newCount += 1; },
  });
  return { dispose, getMessages: () => messages, getCount: () => newCount };
}

test("subscribeThreadLiveReplies counts a reply once when message:new then thread:updated fire", () => {
  const socket = fakeSocket();
  const wired = wireLiveReplies(socket, "thread-channel-1");
  assert.equal(socket.count("message:new"), 1, "message:new listener must be registered");
  assert.equal(socket.count("thread:updated"), 1, "thread:updated listener must be registered");

  const reply = threadMsg({ id: "reply-live", seq: 1 });
  socket.emit("message:new", reply);
  socket.emit("thread:updated", { threadChannelId: "thread-channel-1", parentMessageId: "parent-1", latestReply: reply });

  assert.equal(wired.getMessages().filter((m) => m.id === "reply-live").length, 1, "reply present once");
  assert.equal(wired.getCount(), 1, "counted exactly once across both events");
});

test("subscribeThreadLiveReplies counts a reply once when thread:updated then message:new fire", () => {
  const socket = fakeSocket();
  const wired = wireLiveReplies(socket, "thread-channel-1");

  const reply = threadMsg({ id: "reply-live", seq: 1 });
  socket.emit("thread:updated", { threadChannelId: "thread-channel-1", parentMessageId: "parent-1", latestReply: reply });
  socket.emit("message:new", reply);

  assert.equal(wired.getCount(), 1, "order must not matter — counted once");
});

test("subscribeThreadLiveReplies stops delivering after dispose", () => {
  const socket = fakeSocket();
  const wired = wireLiveReplies(socket, "thread-channel-1");
  wired.dispose();
  assert.equal(socket.count("message:new"), 0);
  assert.equal(socket.count("thread:updated"), 0);
  socket.emit("message:new", threadMsg({ id: "reply-after-dispose", seq: 1 }));
  assert.equal(wired.getMessages().length, 0, "a disposed subscription must not apply replies");
  assert.equal(wired.getCount(), 0);
});

test("subscribeThreadLiveReplies ignores a thread:updated frame for a different thread", () => {
  const socket = fakeSocket();
  const wired = wireLiveReplies(socket, "thread-channel-1");
  socket.emit("thread:updated", {
    threadChannelId: "other-thread",
    parentMessageId: "other-parent",
    latestReply: threadMsg({ id: "reply-other", seq: 1, channelId: "other-thread" }),
  });
  assert.equal(wired.getMessages().length, 0, "a frame for another thread must not touch this panel");
  assert.equal(wired.getCount(), 0);
});
