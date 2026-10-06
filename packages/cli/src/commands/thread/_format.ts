import type { AgentApiThreadListItem } from "@botiverse/raft-shared";
import { formatAgentThreadList } from "@botiverse/raft-shared";

import { axSurface } from "../../core/renderer";

// The text lives in `@botiverse/raft-shared` (`agentText/threadsProfile.ts`) so
// the SDK renders the same bytes; this file keeps the axSurface registration.
export const formatThreadList = axSurface(
  "Followed thread list for the bound agent, including exact thread targets usable with raft message read or raft thread unfollow.",
  (threads: AgentApiThreadListItem[]): string => formatAgentThreadList(threads),
  {
    examples: [{
      args: [[{
        target: "#engineering:abcd1234",
        threadChannelId: "11111111-2222-4333-8444-555555555555",
        parentChannelRef: "#engineering",
        parentMessageId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        parentMessageShortId: "abcd1234",
        followedAt: "2026-09-10T12:00:00.000Z",
        reason: "mentioned",
        doneAt: null,
      }]],
    }],
  },
);
