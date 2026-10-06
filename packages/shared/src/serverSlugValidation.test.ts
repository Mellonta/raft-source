import assert from "node:assert/strict";
import {
  SERVER_SLUG_MIN_LENGTH,
  validateNewServerSlug,
  validateNewServerSlugReason,
  validateServerSlugReferenceReason,
} from "./serverSlugValidation";

test("new server slug validation enforces the create-server minimum length", () => {
  assert.equal(SERVER_SLUG_MIN_LENGTH, 5);
  assert.deepEqual(validateNewServerSlugReason(""), { code: "required" });
  assert.deepEqual(validateNewServerSlugReason("abcd"), { code: "too_short", minLength: 5 });
  assert.deepEqual(validateNewServerSlugReason("1team"), { code: "pattern" });
  assert.deepEqual(validateNewServerSlugReason("Team-one"), { code: "pattern" });
  assert.deepEqual(validateNewServerSlugReason("team_one"), { code: "pattern" });
  assert.equal(validateNewServerSlugReason("team-1"), null);
});

test("new server slug validation keeps API-compatible error copy", () => {
  assert.equal(validateNewServerSlug(""), "Slug is required");
  assert.equal(validateNewServerSlug("abcd"), "Slug must be at least 5 characters");
  assert.equal(
    validateNewServerSlug("Team-one"),
    "Slug must start with a letter and contain only lowercase letters, numbers, and hyphens",
  );
  assert.equal(validateNewServerSlug("team-one"), null);
});

test("server slug reference validation accepts existing short slugs", () => {
  assert.deepEqual(validateServerSlugReferenceReason(""), { code: "required" });
  assert.deepEqual(validateServerSlugReferenceReason(undefined), { code: "required" });
  assert.equal(validateServerSlugReferenceReason("abcd"), null);
  assert.equal(validateServerSlugReferenceReason("ab"), null);
  assert.equal(validateServerSlugReferenceReason("a"), null);
  assert.deepEqual(validateServerSlugReferenceReason("1team"), { code: "pattern" });
  assert.deepEqual(validateServerSlugReferenceReason("Team"), { code: "pattern" });
  assert.deepEqual(validateServerSlugReferenceReason("te_am"), { code: "pattern" });
  assert.equal(validateServerSlugReferenceReason("team-1"), null);
});
