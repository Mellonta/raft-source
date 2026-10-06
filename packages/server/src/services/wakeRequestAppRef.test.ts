import assert from "node:assert/strict";
import { wakeRequestAppRefTraceAttrs } from "./wakeRequestAppRef";
import { BUILT_IN_RAP_APPS } from "./rapBuiltinAppManifests";

// The wake request arrives from an authenticated machine, but its CONTENT is
// untrusted: a modified or older daemon can put any string into `appId` /
// `sourceRef.id`. These assertions are about what reaches the span, not about
// whether the wake happens — the wake is unaffected in every case below.

const KNOWN_APP_ID = String(BUILT_IN_RAP_APPS[0]!.appId);

test("a valid app reference is preserved, and marked as checked", () => {
  const attrs = wakeRequestAppRefTraceAttrs({
    appId: KNOWN_APP_ID,
    ownerAgentId: "agent-1",
    sourceRef: { kind: "reminder", id: "3f1e1a5c-0000-4000-8000-000000000000" },
  });

  assert.equal(attrs.app_id, KNOWN_APP_ID);
  assert.equal(attrs.source_id, "3f1e1a5c-0000-4000-8000-000000000000");
  assert.equal(attrs.app_ref_invalid, false, "checked and accepted is not the same as unchecked");
});

test("an unknown app id is rejected, and its values never reach the span", () => {
  const attrs = wakeRequestAppRefTraceAttrs({
    appId: "attacker.supplied.app",
    ownerAgentId: "agent-1",
    sourceRef: { kind: "k", id: "free text the server never validated" },
  });

  assert.equal(attrs.app_ref_invalid, true);
  assert.equal(attrs.app_ref_invalid_reason, "unknown_app_id");
  for (const key of ["app_id", "source_id", "item_id", "app_correlation_id"]) {
    assert.ok(!(key in attrs), `${key} must not reach the span from an unvalidated reference`);
  }
});

test("a malformed sourceRef is rejected even when the app id is known", () => {
  // The app id being real is exactly the case where it is tempting to trust the
  // rest of the payload. It is the same sender either way.
  const attrs = wakeRequestAppRefTraceAttrs({
    appId: KNOWN_APP_ID,
    ownerAgentId: "agent-1",
    sourceRef: { kind: "", id: "" },
  });

  assert.equal(attrs.app_ref_invalid, true);
  assert.equal(attrs.app_ref_invalid_reason, "source_ref_malformed");
  assert.ok(!("source_id" in attrs));
});

test("no app reference at all is not a rejection", () => {
  // Most wakes carry none. If this returned `app_ref_invalid` the flag would
  // fire constantly and stop distinguishing anything.
  const attrs = wakeRequestAppRefTraceAttrs({ ownerAgentId: "agent-1" });
  assert.deepEqual(attrs, {});
});

test("the known-app set is the server's own, and is not empty", () => {
  // Positive control. If BUILT_IN_RAP_APPS were ever empty, every reference
  // would be rejected and the tests above would still pass for the wrong
  // reason — "nothing is valid" reads the same as "this one is invalid".
  assert.ok(BUILT_IN_RAP_APPS.length > 0, "the server must declare at least one app of its own");
  assert.ok(
    BUILT_IN_RAP_APPS.every((app) => typeof app.appId === "string" && app.appId.length > 0),
    "every declared app needs a usable id",
  );
});
