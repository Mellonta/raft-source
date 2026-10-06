import assert from "node:assert/strict";

import { routeFamilyForPath } from "./agentCredentialProxy";

// Locks the attachment-comments classifier ordering (PR3 review finding):
// the comments-specific match must sit ABOVE the generic
// `/internal/agent-api/attachments/*` match or it is unreachable.
test("proxy routeFamilyForPath classifies attachment comments ahead of generic attachments", () => {
  assert.equal(
    routeFamilyForPath("/internal/agent-api/attachments/00000000-0000-4000-8000-000000000001/comments"),
    "agent-api/attachments/comments",
  );
  assert.equal(
    routeFamilyForPath("/internal/agent-api/attachments/00000000-0000-4000-8000-000000000001"),
    "agent-api/attachments",
  );
});

test("proxy routeFamilyForPath classifies thread list separately from thread unfollow", () => {
  assert.equal(routeFamilyForPath("/internal/agent-api/threads"), "threads");
  assert.equal(routeFamilyForPath("/internal/agent-api/threads/unfollow"), "threads/unfollow");
});
