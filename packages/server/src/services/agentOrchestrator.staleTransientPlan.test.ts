import assert from "node:assert/strict";
import { planStaleTransientNormalizationAction } from "./agentOrchestrator";

test("planStaleTransientNormalizationAction keeps non-transient snapshots unchanged", () => {
  assert.equal(
    planStaleTransientNormalizationAction({
      isTransient: false,
      ageSec: 999,
      staleAfterSec: 90,
    }),
    "keep-current",
  );
});

test("planStaleTransientNormalizationAction keeps fresh transient snapshots unchanged", () => {
  assert.equal(
    planStaleTransientNormalizationAction({
      isTransient: true,
      ageSec: 30,
      staleAfterSec: 90,
    }),
    "keep-current",
  );
});

test("planStaleTransientNormalizationAction normalizes stale transient snapshots to online", () => {
  assert.equal(
    planStaleTransientNormalizationAction({
      isTransient: true,
      ageSec: 91,
      staleAfterSec: 90,
    }),
    "normalize-online",
  );
});
