import assert from "node:assert/strict";
import { capAgentUnreadSummary } from "./channelService";

test("the resume unread summary keeps DMs first, then the most unread, and folds the rest into one line", () => {
  const counts: Record<string, number> = { "dm:@alice": 1 };
  for (let i = 0; i < 30; i += 1) counts[`#room-${String(i).padStart(2, "0")}`] = i + 1;
  const capped = capAgentUnreadSummary(counts, 5);
  assert.deepEqual(Object.keys(capped), [
    "dm:@alice", "#room-29", "#room-28", "#room-27", "#room-26", "(26 more conversations — run `raft inbox check` to list them)",
  ]);
  // Folded unread: rooms 00..25 hold 1..26.
  assert.equal(capped["(26 more conversations — run `raft inbox check` to list them)"], (26 * 27) / 2);
  assert.equal(capAgentUnreadSummary({ "#a": 1 }, 5)["#a"], 1);
});
