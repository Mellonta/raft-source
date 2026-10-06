import assert from "node:assert/strict";

import { SeenFrontier } from "./frontier";
import { validateOpRequest } from "./outcome";
import { readHistoryRequestSchema } from "./messages";

test("without a context the frontier behaves as before contexts existed", () => {
  const frontier = new SeenFrontier();
  frontier.recordExact("#a", [5, 9]);
  frontier.recordUpTo("#a", 7);
  assert.deepEqual(frontier.attestation("#a"), { seenUpToSeq: 7, seenExactSeqs: [9] });
  frontier.recordUpTo("#a", 3);
  assert.deepEqual(frontier.attestation("#a"), { seenUpToSeq: 7, seenExactSeqs: [9] }, "never lowers");
  assert.deepEqual(frontier.snapshot(), { version: 1, targets: { "#a": { upTo: 7, exact: [9] } }, aliases: {} });
});

test("bookings carry their context; attestation uses only the current context's (seenPolicy rules)", () => {
  const frontier = new SeenFrontier();
  frontier.setContext("A");
  frontier.recordUpTo("#a", 10);
  frontier.recordExact("#a", [12]);
  assert.deepEqual(frontier.attestation("#a"), { seenUpToSeq: 10, seenExactSeqs: [12] });
  assert.deepEqual(frontier.inContext("B").attestation("#a"), { seenExactSeqs: [] }, "another context sees nothing");
  assert.deepEqual(frontier.inContext(null).attestation("#a"), { seenUpToSeq: 10, seenExactSeqs: [12] }, "no context: everything attests");

  // A booking from another context replaces, it does not merge (a lower mark is taken as is).
  frontier.inContext("B").recordUpTo("#a", 4);
  assert.deepEqual(frontier.inContext("B").attestation("#a"), { seenUpToSeq: 4, seenExactSeqs: [] });
  assert.deepEqual(frontier.attestation("#a"), { seenExactSeqs: [] }, "A's evidence is gone");

  // Sparse bookings from another context replace the exact set but keep the other context's mark.
  frontier.recordExact("#a", [20]);
  assert.deepEqual(frontier.attestation("#a"), { seenExactSeqs: [20] });
  assert.deepEqual(frontier.inContext("B").attestation("#a"), { seenUpToSeq: 4, seenExactSeqs: [] });

  // recordHeld books in the current context.
  assert.equal(frontier.recordHeld({ target: "#b", seenUpToSeq: 30, withheld: false, contextComplete: true }), true);
  assert.deepEqual(frontier.attestation("#b"), { seenUpToSeq: 30, seenExactSeqs: [] });
  assert.deepEqual(frontier.inContext("B").attestation("#b"), { seenExactSeqs: [] });
});

test("snapshot and absorb keep contexts; absorb adopts the snapshot's context only when none is set", () => {
  const frontier = new SeenFrontier();
  frontier.setContext("A");
  frontier.recordUpTo("#a", 10);
  frontier.recordExact("#a", [12]);
  frontier.recordAlias("#A", "#a");
  const snapshot = frontier.snapshot();
  assert.deepEqual(snapshot, {
    version: 1,
    targets: { "#a": { upTo: 10, exact: [12], upToContextId: "A", exactContextId: "A" } },
    aliases: { "#A": "#a" },
    contextId: "A",
  });
  const restored = SeenFrontier.fromSnapshot(snapshot);
  assert.equal(restored.contextId, "A");
  assert.deepEqual(restored.attestation("#A"), { seenUpToSeq: 10, seenExactSeqs: [12] });
  assert.deepEqual(restored.snapshot(), snapshot);

  const explicit = new SeenFrontier();
  explicit.setContext("B");
  explicit.absorb(snapshot);
  assert.equal(explicit.contextId, "B");
  assert.deepEqual(explicit.attestation("#a"), { seenExactSeqs: [] });

  // A snapshot written before contexts existed restores unscoped.
  const legacy = SeenFrontier.fromSnapshot({ version: 1, targets: { "#a": { upTo: 3 } }, aliases: {} });
  assert.equal(legacy.contextId, null);
  assert.deepEqual(legacy.attestation("#a"), { seenUpToSeq: 3, seenExactSeqs: [] });
});

test("validateOpRequest names the field and never echoes the value", () => {
  assert.equal(validateOpRequest(readHistoryRequestSchema, { target: "#a", limit: 5 }), null);
  const failure = validateOpRequest(readHistoryRequestSchema, { target: "sk_agent_secret_value", limit: "sk_agent_other_secret" });
  assert.equal(failure?.error.code, "INVALID_REQUEST");
  assert.match(failure!.error.message, /^Invalid request: limit: .*Nothing was sent\.$/);
  assert.doesNotMatch(failure!.text, /sk_agent/);
});
