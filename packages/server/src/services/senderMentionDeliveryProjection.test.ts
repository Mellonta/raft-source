import assert from "node:assert/strict";
import { MENTION_DELIVERY_TERMINAL_ERROR_CODES } from "@botiverse/raft-shared";
import {
  SENDER_MENTION_DELIVERY_OUTCOMES,
  SENDER_MENTION_DELIVERY_REASON_CATEGORIES,
  TERMINAL_CODE_CATEGORY,
  projectMentionDeliveryForSender,
} from "./senderMentionDeliveryProjection";

/**
 * task #153. The sender may learn that a mentioned target could not receive the
 * message, and the category that tells them what to do next — wait, or re-route.
 * Ruled by @Tenny (`4a6a06b8`) after @xxchan did not answer and @Box's declared
 * fallback applied: outcome + category, and nothing that explains WHY the seat
 * broke.
 *
 * Kept pure for the same reason `evaluateMentionDeliveryOccurrence` is pure: a
 * mutant must be able to prove which branch ran without a database shape in the
 * way.
 */

const HANDLE = "@someone";

test("T1: a quota-blocked target reaches the sender as lost + quota", () => {
  // The test this repo has never had: every existing sender-visibility test
  // covers membership (not_member) or resolution (unknown_or_not_visible).
  const row = projectMentionDeliveryForSender(HANDLE, {
    status: "TERMINAL_ERROR",
    occurrenceId: "occ-1",
    code: "QUOTA_LIMITED",
    version: 3,
  });
  assert.equal(row.outcome, "lost");
  assert.equal(row.reasonCategory, "quota");
});

test("T1b: a rejected delivery reaches the sender as lost + runtime_error", () => {
  const row = projectMentionDeliveryForSender(HANDLE, {
    status: "TERMINAL_ERROR",
    occurrenceId: "occ-2",
    code: "DELIVERY_REJECTED",
    version: 1,
  });
  assert.equal(row.outcome, "lost");
  assert.equal(row.reasonCategory, "runtime_error");
});

test("T3a-per-outcome: EVERY outcome has an exact key shape, decided and asserted", () => {
  // @Tenny's requirement once `outcome` grew past two values: state the rule per
  // outcome, not just for `lost`. The one unacceptable design is letting field
  // ABSENCE carry meaning ambiguously, because absence and a forgotten
  // assignment read identically and mean opposite things.
  //
  //   delivered ⇒ category FORBIDDEN (nothing failed)
  //   pending   ⇒ category FORBIDDEN (nothing has failed yet)
  //   lost      ⇒ category REQUIRED  (it is what makes `lost` actionable)
  //   unknown   ⇒ category FORBIDDEN (we do not know what happened to the
  //               target, so a cause-of-failure label would be a claim we
  //               cannot support — the same error `unknown` exists to prevent)
  const cases: Array<[string, Parameters<typeof projectMentionDeliveryForSender>[1], string[]]> = [
    ["delivered", { status: "ACKED", occurrenceId: "o", version: 1 }, ["outcome", "targetHandle"]],
    ["pending", { status: "BROKEN_HOP", occurrenceId: "o", hop: "DAEMON_RECEIVE", version: 1 }, ["outcome", "targetHandle"]],
    ["lost", { status: "TERMINAL_ERROR", occurrenceId: "o", code: "QUOTA_LIMITED", version: 1 }, ["outcome", "reasonCategory", "targetHandle"]],
    ["unknown", { status: "INSTRUMENT_FAILED", occurrenceId: "o", missingReceipt: "MENTION_RECORDED", version: 1 }, ["outcome", "targetHandle"]],
  ];
  for (const [label, input, expectedKeys] of cases) {
    const row = projectMentionDeliveryForSender(HANDLE, input);
    assert.equal(row.outcome, label, `${label}: wrong outcome`);
    assert.deepEqual(Object.keys(row).sort(), expectedKeys, `${label}: key shape drifted`);
  }
});

test("T3a: the projection key set is EXACTLY the ruled allowlist", () => {
  // Exact set, not "does not contain X" — a later field addition must fail
  // loudly rather than ride along. Same lesson as #1127's trace-attr contract:
  // put the guarantee in a filter, not a comment.
  const row = projectMentionDeliveryForSender(HANDLE, {
    status: "TERMINAL_ERROR",
    occurrenceId: "occ-3",
    code: "QUOTA_LIMITED",
    version: 9,
  });
  assert.deepEqual(Object.keys(row).sort(), ["outcome", "reasonCategory", "targetHandle"]);
});

test("T3b: nothing that explains WHY the seat broke may appear", () => {
  for (const code of ["QUOTA_LIMITED", "DELIVERY_REJECTED", "INSTRUMENT_FAILED"] as const) {
    const row = projectMentionDeliveryForSender(HANDLE, {
      status: "TERMINAL_ERROR",
      occurrenceId: "occ-secret",
      code,
      version: 4,
    });
    const serialised = JSON.stringify(row);
    // Ruling A: no raw code, no reset time, no model/provider, no occurrence id.
    assert.equal(serialised.includes(code), false, `raw terminal code leaked for ${code}`);
    assert.equal(serialised.includes("occ-secret"), false, "occurrence id leaked");
  }
});

test("T3c: the closed category set is exactly the four ruled members", () => {
  // Adding a fifth category — or folding `not_in_conversation` in here — fails.
  assert.deepEqual(
    [...SENDER_MENTION_DELIVERY_REASON_CATEGORIES].sort(),
    ["not_launched", "quota", "runtime_error", "unclassified"],
  );
});

test("T3d: lost ALWAYS carries a category — absence is never how we say 'unknown'", () => {
  // @Tenny's precision requirement: "field absent" and "implementation forgot to
  // fill it" read identically and mean opposite things. So the function is total
  // over lost, and the unknowable case has an explicit name.
  const terminalCodes = [
    "IDENTITY_UNKNOWN",
    "IDENTITY_DRIFT",
    "QUOTA_LIMITED",
    "DELIVERY_REJECTED",
    "UNSUPPORTED_DELIVERY_PATH",
  ] as const;
  for (const code of terminalCodes) {
    const row = projectMentionDeliveryForSender(HANDLE, {
      status: "TERMINAL_ERROR",
      occurrenceId: "occ",
      code,
      version: 1,
    });
    if (row.outcome === "lost") {
      assert.ok(
        row.reasonCategory && SENDER_MENTION_DELIVERY_REASON_CATEGORIES.includes(row.reasonCategory),
        `lost without a category for ${code}`,
      );
    }
  }
});

test("T4: delivered and lost are DISTINGUISHABLE values, which is the card's actual requirement", () => {
  const delivered = projectMentionDeliveryForSender(HANDLE, {
    status: "ACKED",
    occurrenceId: "occ-a",
    version: 2,
  });
  const lost = projectMentionDeliveryForSender(HANDLE, {
    status: "TERMINAL_ERROR",
    occurrenceId: "occ-b",
    code: "QUOTA_LIMITED",
    version: 2,
  });
  assert.equal(delivered.outcome, "delivered");
  assert.equal(lost.outcome, "lost");
  assert.notEqual(delivered.outcome, lost.outcome);
});

test("still-in-flight is `pending`, not `lost` — the sender must not be told to stop waiting", () => {
  const row = projectMentionDeliveryForSender(HANDLE, {
    status: "BROKEN_HOP",
    occurrenceId: "occ-c",
    hop: "DAEMON_RECEIVE",
    version: 1,
  });
  assert.equal(row.outcome, "pending");
});

test("INSTRUMENT_FAILED does not claim the target could not receive", () => {
  // "I cannot see" and "they did not get it" have OPPOSITE remediations, and
  // this repo already pays for conflating them (internalAgentApi.ts:2297-2306).
  // Pending @Tenny's ruling (甲 outcome=unknown / 乙 lost+unclassified); what is
  // asserted here is only the part both options agree on: it must NOT be
  // reported as a plain `lost` with a seat-availability cause.
  const row = projectMentionDeliveryForSender(HANDLE, {
    status: "INSTRUMENT_FAILED",
    occurrenceId: "occ-d",
    missingReceipt: "MENTION_RECORDED",
    version: 1,
  });
  assert.notEqual(row.reasonCategory, "quota");
  assert.notEqual(row.reasonCategory, "runtime_error");
  assert.notEqual(row.reasonCategory, "not_launched");
});

test("the outcome set is closed", () => {
  assert.ok(SENDER_MENTION_DELIVERY_OUTCOMES.includes("delivered"));
  assert.ok(SENDER_MENTION_DELIVERY_OUTCOMES.includes("pending"));
  assert.ok(SENDER_MENTION_DELIVERY_OUTCOMES.includes("lost"));
});

test("T5: INSTRUMENT_FAILED as a terminal CODE is `unknown`, not `lost` — @Tenny's ruling (甲)", () => {
  // Added after mutation M1 survived: the ruled decision had no tooth. The
  // status-level branch was covered, the terminal-CODE path was not, and folding
  // it into `lost` passed the whole suite. A ruling with no failing mutant is
  // a comment.
  const row = projectMentionDeliveryForSender(HANDLE, {
    status: "TERMINAL_ERROR",
    occurrenceId: "occ-if",
    code: "INSTRUMENT_FAILED",
    version: 1,
  });
  assert.equal(row.outcome, "unknown");
  assert.equal(row.reasonCategory, undefined);
});

test("T6: the code→category mapping is asserted EXACTLY, not merely 'some valid category'", () => {
  // Added after mutation M5 survived: mapping every identity code to `quota`
  // passed, because the suite only checked that a member of the closed set came
  // back. A wrong-but-valid category is the worst output this card can produce —
  // "quota" tells the sender to wait for a reset that will never arrive.
  const expected: Record<string, { outcome: string; reasonCategory?: string }> = {
    QUOTA_LIMITED: { outcome: "lost", reasonCategory: "quota" },
    DELIVERY_REJECTED: { outcome: "lost", reasonCategory: "runtime_error" },
    IDENTITY_UNKNOWN: { outcome: "lost", reasonCategory: "unclassified" },
    IDENTITY_DRIFT: { outcome: "lost", reasonCategory: "unclassified" },
    UNSUPPORTED_DELIVERY_PATH: { outcome: "lost", reasonCategory: "unclassified" },
    REDELIVERY_EXHAUSTED: { outcome: "lost", reasonCategory: "unclassified" },
    INSTRUMENT_FAILED: { outcome: "unknown" },
  };
  for (const [code, want] of Object.entries(expected)) {
    const row = projectMentionDeliveryForSender(HANDLE, {
      status: "TERMINAL_ERROR",
      occurrenceId: "o",
      code: code as never,
      version: 1,
    });
    assert.equal(row.outcome, want.outcome, `${code}: outcome`);
    assert.equal(row.reasonCategory, want.reasonCategory, `${code}: category`);
  }
});

test("T7: every terminal code the server can emit has a category — checked against the RUNTIME list", () => {
  // The runtime half of the standing acceptance @Stone ruled in `86e2504d`,
  // after @Xinran measured that the previous `switch` + `never` + `default`
  // shape went SILENTLY GREEN when only the guard's two lines were deleted
  // (their shape B — the minimal, and therefore the likeliest, edit).
  //
  // The table's `Record<MentionDeliveryTerminalErrorCode, …>` annotation is the
  // type tooth and it covers more than I first credited it with: adding a code
  // with no entry, deleting a key, and even widening to `Partial<Record<…>>` all
  // go red at typecheck (measured).
  //
  // What it does NOT cover is the widening plus a `?? "unclassified"` absorbing
  // the `undefined` — that is @Xinran's shape B rebuilt out of table parts, and
  // it typechecks clean. This test is the tooth for exactly that shape; it was
  // measured red against it before being written down.
  //
  // It compares against `MENTION_DELIVERY_TERMINAL_ERROR_CODES`, the array the
  // union is derived from, so there is no second hand-copied list to drift —
  // that duplication is the defect task #154 exists for.
  assert.deepEqual(
    Object.keys(TERMINAL_CODE_CATEGORY).sort(),
    [...MENTION_DELIVERY_TERMINAL_ERROR_CODES].sort(),
  );
  for (const code of MENTION_DELIVERY_TERMINAL_ERROR_CODES) {
    assert.ok(
      SENDER_MENTION_DELIVERY_REASON_CATEGORIES.includes(TERMINAL_CODE_CATEGORY[code]),
      `${code} maps outside the ruled category set`,
    );
  }
});
