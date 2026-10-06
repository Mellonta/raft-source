import assert from "node:assert/strict";

import { computerLocalTraceDisabled } from "./computerTracer";

test("computerLocalTraceDisabled uses RAFT_COMPUTER_LOCAL_TRACE", () => {
  assert.equal(computerLocalTraceDisabled({}), false);
  assert.equal(computerLocalTraceDisabled({ RAFT_COMPUTER_LOCAL_TRACE: "0" }), true);
  assert.equal(computerLocalTraceDisabled({ RAFT_COMPUTER_LOCAL_TRACE: "1" }), false);
});
