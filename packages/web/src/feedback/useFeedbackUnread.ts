import { DISTRIBUTION_POLICY } from "@botiverse/raft-shared/src/distributionPolicy";
import { useEffect, useSyncExternalStore } from "react";
import { useAuthStore } from "../store/authStore";
import { feedbackUnreadSnapshot, retainFeedbackUnread, subscribeFeedbackUnread } from "./feedbackUnreadState";

const isCurrentUser = (id: string) => useAuthStore.getState().user?.id === id;

export function useFeedbackUnread(enabled = true) {
  enabled = enabled && DISTRIBUTION_POLICY.upstreamServices;
  const userId = useAuthStore((state) => state.user?.id ?? null);
  useEffect(() => enabled && userId ? retainFeedbackUnread(userId, isCurrentUser) : undefined, [enabled, userId]);
  return useSyncExternalStore(subscribeFeedbackUnread, () => enabled ? feedbackUnreadSnapshot(userId) : 0, () => 0);
}
