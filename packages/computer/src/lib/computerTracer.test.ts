// Exercise upstream mechanisms explicitly; mellontaPrivacy.test.ts verifies the shipped policy.
vi.mock("@botiverse/raft-shared/src/distributionPolicy", async (importOriginal) => ({
  ...await importOriginal<typeof import("@botiverse/raft-shared/src/distributionPolicy")>(),
  DISTRIBUTION_POLICY: { forkReleases: false, managedMcp: true, diagnosticUploads: true, tracing: true, productAnalytics: true, upstreamServices: true, externalAvatars: true },
}));

import assert from "node:assert/strict";

import { computerLocalTraceDisabled } from "./computerTracer";

test("computerLocalTraceDisabled uses RAFT_COMPUTER_LOCAL_TRACE", () => {
  assert.equal(computerLocalTraceDisabled({}), false);
  assert.equal(computerLocalTraceDisabled({ RAFT_COMPUTER_LOCAL_TRACE: "0" }), true);
  assert.equal(computerLocalTraceDisabled({ RAFT_COMPUTER_LOCAL_TRACE: "1" }), false);
});
