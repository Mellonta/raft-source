import {
  MENTION_DELIVERY_TERMINAL_ERROR_CODES as SHARED_CODES,
} from "@botiverse/raft-shared";
import {
  MENTION_DELIVERY_TERMINAL_ERROR_CODES as SERVICE_CODES,
} from "./mentionDeliveryOccurrenceService";

// task #154: the terminal error code union previously existed in three places
// and silently diverged (shared: 6 members, server service: 7, daemon inline: 6).
// The class that matters now is RE-DUPLICATION: the unified definition must not
// be quietly copied again. Reference identity is the cheapest possible guard —
// if anyone replaces the re-export with a local array, this fails.
describe("MentionDeliveryTerminalErrorCode single-source contract", () => {
  it("the server service re-exports the shared array by reference, not a copy", () => {
    expect(SERVICE_CODES).toBe(SHARED_CODES);
  });

  it("the canonical set is exactly the seven production codes", () => {
    expect([...SHARED_CODES]).toEqual([
      "IDENTITY_UNKNOWN",
      "IDENTITY_DRIFT",
      "QUOTA_LIMITED",
      "DELIVERY_REJECTED",
      "UNSUPPORTED_DELIVERY_PATH",
      "INSTRUMENT_FAILED",
      "REDELIVERY_EXHAUSTED",
    ]);
  });
});
