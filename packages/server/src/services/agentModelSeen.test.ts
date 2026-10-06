import assert from "node:assert/strict";

import { contiguousSeenUpTo } from "./agentModelSeen";

const settled = (seqs: number[]) => seqs.map((seq) => ({ seq, createdAtMs: 0 }));
const NOW_SETTLED = 1_000;

test("the read position moves over reported messages that join it", () => {
  assert.equal(contiguousSeenUpTo(10, new Set([11, 12, 13]), settled([11, 12, 13]), NOW_SETTLED), 13);
});

test("the first message the model was not shown stops the read position", () => {
  // 12 was never shown: 13 stays an exact-seq observation only.
  assert.equal(contiguousSeenUpTo(10, new Set([11, 13]), settled([11, 12, 13]), NOW_SETTLED), 11);
});

test("a sparse report (one mention after a gap) does not move the read position", () => {
  assert.equal(contiguousSeenUpTo(10, new Set([50]), settled([11, 20, 50]), NOW_SETTLED), 10);
});

test("seqs of other conversations do not create gaps, and old seqs are ignored", () => {
  // The conversation only has 11 and 15 after the position; global seqs in between belong elsewhere.
  assert.equal(contiguousSeenUpTo(10, new Set([9, 11, 15]), settled([11, 15]), NOW_SETTLED), 15);
});

test("a row newer than the settle window stops the read position, since a lower seq may still be committing", () => {
  // Reported {100, 102}; 101 is in an uncommitted transaction, so it is not
  // visible yet. 102 is fresh, so the walk stops before it.
  const rows = [{ seq: 100, createdAtMs: 0 }, { seq: 102, createdAtMs: 5_000 }];
  assert.equal(contiguousSeenUpTo(99, new Set([100, 102]), rows, 1_000), 100);
});
