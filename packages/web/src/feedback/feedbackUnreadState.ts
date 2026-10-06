import api from "../api/client";

// Shared by desktop/mobile notification hosts. Do not import the feedback SDK:
// the workspace and its CSS must stay behind the existing lazy boundary.
const listeners = new Set<() => void>();
let owner: string | null = null;
let unread = 0;
let consumers = 0;
let revision = 0;
let generation = 0;
let isCurrentUser = (_userId: string): boolean => false;
let pending: AbortController | null = null;
let stopPolling: (() => void) | null = null;

function emit() {
  for (const listener of listeners) listener();
}

function validCount(count: number) {
  return Number.isSafeInteger(count) && count >= 0;
}

/** Detail GET advances Hands' read-through cursor. Invalidate older list reads. */
export function acceptFeedbackUnread(userId: string | null, count: number) {
  if (!userId || userId !== owner || !isCurrentUser(userId) || !validCount(count)) return;
  revision += 1;
  unread = count;
  emit();
}

async function refresh() {
  if (!owner || !isCurrentUser(owner) || pending || document.visibilityState === "hidden") return;
  const userId = owner;
  const version = revision;
  const controller = new AbortController();
  pending = controller;
  try {
    const { data } = await api.get<{ unread_total: number }>("/product-feedback/tickets", {
      params: { limit: 1 },
      signal: controller.signal,
    });
    if (!controller.signal.aborted && version === revision && owner === userId
      && isCurrentUser(userId) && validCount(data.unread_total)) {
      unread = data.unread_total;
      emit();
    }
  } catch {
    // A transient outage is not evidence that the user has read their replies.
    // Keep the last count and retry on the next visible poll/focus.
  } finally {
    if (pending === controller) pending = null;
  }
}

export function retainFeedbackUnread(userId: string, validateUser: (id: string) => boolean) {
  isCurrentUser = validateUser;
  if (owner !== userId) {
    stopPolling?.();
    stopPolling = null;
    pending?.abort();
    pending = null;
    owner = userId;
    generation += 1;
    unread = 0;
    consumers = 0;
    revision += 1;
    emit();
  }
  consumers += 1;
  if (!stopPolling) {
    const onVisible = () => void refresh();
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(onVisible, 60_000);
    stopPolling = () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
    void refresh();
  }
  return () => {
    if (owner !== userId) return;
    consumers -= 1;
    if (consumers > 0) return;
    stopPolling?.();
    stopPolling = null;
    pending?.abort();
    pending = null;
    owner = null;
    generation += 1;
    unread = 0;
    revision += 1;
    emit();
  };
}

export const subscribeFeedbackUnread = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const feedbackUnreadSnapshot = (userId: string | null) => userId && owner === userId ? unread : 0;

// Capture the mounted session, so a detail response from a prior login cannot
// update another account (or a later login to the same account).
export function captureFeedbackUnreadUpdate() {
  const userId = owner;
  const session = generation;
  return (count: number) => {
    if (session === generation) acceptFeedbackUnread(userId, count);
  };
}
