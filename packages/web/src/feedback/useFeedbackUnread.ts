import { browserPrivacyMode } from "@botiverse/raft-shared/src/browserPrivacy";
import { useEffect, useSyncExternalStore } from "react";
import { hasChatSurfaces } from "../embed";
import { useAuthStore } from "../store/authStore";
import { feedbackUnreadSnapshot, retainFeedbackUnread, subscribeFeedbackUnread } from "./feedbackUnreadState";

const isCurrentUser = (id: string) => useAuthStore.getState().user?.id === id;

export function useFeedbackUnread(requested = true) {
  // The rail and settings-list dots are not drawn in a host-shell embed, so the
  // unread poll behind them is not started there.
  const enabled = !browserPrivacyMode() && requested && hasChatSurfaces();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  useEffect(() => enabled && userId ? retainFeedbackUnread(userId, isCurrentUser) : undefined, [enabled, userId]);
  return useSyncExternalStore(subscribeFeedbackUnread, () => enabled ? feedbackUnreadSnapshot(userId) : 0, () => 0);
}
