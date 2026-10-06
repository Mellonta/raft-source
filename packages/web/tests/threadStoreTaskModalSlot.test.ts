import assert from "node:assert/strict";
import { useThreadStore } from "../src/store/threadStore";
import type { ThreadSummary } from "../src/store/threadStore";
import api from "../src/api/client";

const originalGet = api.get.bind(api);

function resetStore() {
  useThreadStore.setState({
    openParentMessageId: null,
    openThreadChannelId: null,
    openParentChannelId: null,
    openServerSlug: null,
    openIntent: null,
    openThreadError: null,
    openThreadLoading: false,
    focusedMessageId: null,
    openedAt: 0,
    taskModal: null,
    summaries: {},
    replyScopes: {},
    followedThreads: [],
  });
}

function makeSummary(threadChannelId: string): ThreadSummary {
  return {
    threadChannelId,
    replyCount: 1,
    lastReplyAt: new Date().toISOString(),
    participantIds: ["agent-1"],
    unreadCount: 0,
    firstUnreadMessageId: null,
  };
}

function restoreApi() {
  api.get = originalGet;
}

function openSideThread() {
  useThreadStore.setState({
    openParentMessageId: "parent-side",
    openParentChannelId: "channel-side",
    openThreadChannelId: "thread-side",
    openServerSlug: "acme",
    openIntent: "thread",
    focusedMessageId: null,
    openedAt: 123,
  });
}

function assertSideThreadUntouched() {
  const state = useThreadStore.getState();
  assert.deepEqual(
    {
      openParentMessageId: state.openParentMessageId,
      openParentChannelId: state.openParentChannelId,
      openThreadChannelId: state.openThreadChannelId,
      openServerSlug: state.openServerSlug,
      openIntent: state.openIntent,
      openedAt: state.openedAt,
    },
    {
      openParentMessageId: "parent-side",
      openParentChannelId: "channel-side",
      openThreadChannelId: "thread-side",
      openServerSlug: "acme",
      openIntent: "thread",
      openedAt: 123,
    },
    "the side thread's identity must not move when the task modal opens/closes",
  );
}

test("openThread with intent=task fills the independent slot and leaves the side thread identity untouched", async () => {
  resetStore();
  openSideThread();
  useThreadStore.setState({ summaries: { "parent-task": makeSummary("thread-task") } });
  let getCalled = false;
  api.get = (async () => {
    getCalled = true;
    return { data: {} };
  }) as typeof api.get;

  try {
    await useThreadStore.getState().openThread({
      parentChannelId: "channel-task",
      parentMessageId: "parent-task",
      intent: "task",
    });

    assertSideThreadUntouched();
    const slot = useThreadStore.getState().taskModal;
    assert.equal(slot?.parentMessageId, "parent-task");
    assert.equal(slot?.parentChannelId, "channel-task");
    assert.equal(slot?.threadChannelId, "thread-task", "known summary seeds the slot without a lookup");
    assert.equal(slot?.loading, false);
    assert.equal(getCalled, false);
  } finally {
    restoreApi();
    resetStore();
  }
});

test("closing the task modal empties the slot only — the side thread needs no restore", async () => {
  resetStore();
  openSideThread();
  useThreadStore.setState({ summaries: { "parent-task": makeSummary("thread-task") } });

  try {
    await useThreadStore.getState().openTaskModal({
      parentChannelId: "channel-task",
      parentMessageId: "parent-task",
    });
    assert.equal(useThreadStore.getState().taskModal?.parentMessageId, "parent-task");

    useThreadStore.getState().closeTaskModal();

    assert.equal(useThreadStore.getState().taskModal, null);
    assertSideThreadUntouched();
  } finally {
    resetStore();
  }
});

test("opening an ordinary side thread clears the task modal slot", async () => {
  resetStore();
  useThreadStore.setState({ summaries: { "parent-task": makeSummary("thread-task") } });

  try {
    await useThreadStore.getState().openTaskModal({
      parentChannelId: "channel-task",
      parentMessageId: "parent-task",
    });
    assert.notEqual(useThreadStore.getState().taskModal, null);

    useThreadStore.setState({ summaries: { "parent-new": makeSummary("thread-new") } });
    await useThreadStore.getState().openThread({
      parentChannelId: "channel-new",
      parentMessageId: "parent-new",
    });

    assert.equal(useThreadStore.getState().taskModal, null);
    assert.equal(useThreadStore.getState().openParentMessageId, "parent-new");
    assert.equal(useThreadStore.getState().openThreadChannelId, "thread-new");
  } finally {
    resetStore();
  }
});

test("openTaskModal resolves an unknown thread channel with the same read-only lookup as openThread", async () => {
  resetStore();
  openSideThread();
  const getCalls: string[] = [];
  api.get = (async (url: string) => {
    getCalls.push(url);
    return {
      data: {
        threadChannelId: "thread-task",
        replyCount: 2,
        lastReplyAt: null,
        participantIds: [],
      },
    };
  }) as typeof api.get;

  try {
    await useThreadStore.getState().openTaskModal({
      parentChannelId: "channel-task",
      parentMessageId: "parent-task",
    });

    assert.deepEqual(getCalls, ["/channels/channel-task/threads/parent-task"]);
    const slot = useThreadStore.getState().taskModal;
    assert.equal(slot?.threadChannelId, "thread-task");
    assert.equal(slot?.loading, false);
    assert.equal(slot?.error, null);
    assert.equal(
      useThreadStore.getState().summaries["parent-task"]?.threadChannelId,
      "thread-task",
    );
    assertSideThreadUntouched();
  } finally {
    restoreApi();
    resetStore();
  }
});

test("a failed slot lookup lands on the slot's own error state, never on the side thread's", async () => {
  resetStore();
  openSideThread();
  api.get = (async () => {
    throw new Error("boom");
  }) as typeof api.get;

  try {
    await useThreadStore.getState().openTaskModal({
      parentChannelId: "channel-task",
      parentMessageId: "parent-task",
    });

    const state = useThreadStore.getState();
    assert.deepEqual(state.taskModal?.error, {
      parentChannelId: "channel-task",
      parentMessageId: "parent-task",
    });
    assert.equal(state.taskModal?.loading, false);
    assert.equal(state.openThreadError, null);
    assertSideThreadUntouched();
  } finally {
    restoreApi();
    resetStore();
  }
});

test("retryTaskModal re-runs the slot lookup after an error", async () => {
  resetStore();
  openSideThread();
  let fail = true;
  api.get = (async () => {
    if (fail) throw new Error("boom");
    return {
      data: {
        threadChannelId: "thread-task",
        replyCount: 0,
        lastReplyAt: null,
        participantIds: [],
      },
    };
  }) as typeof api.get;

  try {
    await useThreadStore.getState().openTaskModal({
      parentChannelId: "channel-task",
      parentMessageId: "parent-task",
    });
    assert.notEqual(useThreadStore.getState().taskModal?.error, null);

    fail = false;
    await useThreadStore.getState().retryTaskModal();

    const slot = useThreadStore.getState().taskModal;
    assert.equal(slot?.error, null);
    assert.equal(slot?.threadChannelId, "thread-task");
    assertSideThreadUntouched();
  } finally {
    restoreApi();
    resetStore();
  }
});
