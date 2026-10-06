import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  UNREAD_ACTIVITY_DIAGNOSTIC_CAPS,
  UNREAD_ACTIVITY_DIAGNOSTIC_D3F_COVERAGE,
  UNREAD_ACTIVITY_DIAGNOSTIC_SCHEMA_DIGEST,
  UNREAD_ACTIVITY_DIAGNOSTIC_SCHEMA_VERSION,
  UNREAD_ACTIVITY_DIAGNOSTIC_SYSTEM_IDENTIFIER_NOTE,
  canonicalUnreadActivityDiagnosticJson,
  unreadActivityDiagnosticCanonicalManifestJson,
  validateUnreadActivityDiagnostic,
  type UnreadActivityDiagnosticDocument,
} from "./unreadActivityDiagnostic";

test("manifest digest is the sha256 of the executable manifest only", () => {
  const actual = createHash("sha256")
    .update(unreadActivityDiagnosticCanonicalManifestJson())
    .digest("hex");
  assert.equal(actual, UNREAD_ACTIVITY_DIAGNOSTIC_SCHEMA_DIGEST);
});

test("web D3-f is covered only at the reviewed PR #8304 head", () => {
  assert.equal(UNREAD_ACTIVITY_DIAGNOSTIC_D3F_COVERAGE.web.covered, true);
  assert.equal(
    UNREAD_ACTIVITY_DIAGNOSTIC_D3F_COVERAGE.web.head,
    "8db008ffeacd1b111b9b4f6270fca16a19a65863",
  );
  assert.equal(UNREAD_ACTIVITY_DIAGNOSTIC_D3F_COVERAGE.web.task, 664);
  assert.equal(UNREAD_ACTIVITY_DIAGNOSTIC_D3F_COVERAGE.computer.covered, true);
  assert.equal(UNREAD_ACTIVITY_DIAGNOSTIC_D3F_COVERAGE.desktop.covered, true);
});

test("a valid document returns canonical json and does not throw", () => {
  const result = validateUnreadActivityDiagnostic(validDocument());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.canonicalJson, canonicalUnreadActivityDiagnosticJson(result.document));
  assert.equal(result.document.schema_version, UNREAD_ACTIVITY_DIAGNOSTIC_SCHEMA_VERSION);
});

test("forbidden, unknown, and schema mismatch fail closed", () => {
  const withEmail = validDocument() as unknown as Record<string, unknown>;
  withEmail.email = "a@b.c";
  const emailResult = validateUnreadActivityDiagnostic(withEmail);
  assert.equal(emailResult.ok, false);
  if (!emailResult.ok) assert.equal(emailResult.code, "forbidden_field");

  const extra = validDocument() as unknown as Record<string, unknown>;
  extra.note = "x";
  const extraResult = validateUnreadActivityDiagnostic(extra);
  assert.equal(extraResult.ok, false);
  if (!extraResult.ok) assert.equal(extraResult.code, "unknown_field");

  const mismatch = validDocument();
  mismatch.schema_version = "other" as typeof mismatch.schema_version;
  const mismatchResult = validateUnreadActivityDiagnostic(mismatch);
  assert.equal(mismatchResult.ok, false);
  if (!mismatchResult.ok) assert.equal(mismatchResult.code, "schema_mismatch");
});

test("a missing row is not a zero", () => {
  const doc = validDocument();
  doc.totals[0] = {
    row_present: false,
    status: "unknown",
    value: 0,
    generation: null,
    value_at: "2026-09-25T00:00:00Z",
  };
  const result = validateUnreadActivityDiagnostic(doc);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "invalid_shape");
});

test("caps stay separate", () => {
  assert.equal(UNREAD_ACTIVITY_DIAGNOSTIC_CAPS.maxServers, 32);
  assert.equal(UNREAD_ACTIVITY_DIAGNOSTIC_CAPS.maxRows, 64);
  assert.equal(UNREAD_ACTIVITY_DIAGNOSTIC_CAPS.maxCanonicalBytes, 65536);
});

function validDocument(): UnreadActivityDiagnosticDocument {
  return {
    schema_version: UNREAD_ACTIVITY_DIAGNOSTIC_SCHEMA_VERSION,
    manifest_digest: UNREAD_ACTIVITY_DIAGNOSTIC_SCHEMA_DIGEST,
    diagnostic_correlation_id: "ab".repeat(16),
    build_id: "e2b25f539",
    value_at: "2026-09-25T00:00:00Z",
    membership_truncated: 0,
    views: [
      {
        requested_name: "rw_activity_totals_v2",
        served_name: "rw_activity_totals_v2",
        catalog_fingerprint: "f05c52f9",
        system_identifier_note: UNREAD_ACTIVITY_DIAGNOSTIC_SYSTEM_IDENTIFIER_NOTE,
      },
    ],
    totals: [
      {
        row_present: true,
        status: "ok",
        value: 0,
        generation: "g1",
        value_at: "2026-09-25T00:00:00Z",
      },
    ],
    aggregates: {
      served_row_count: 1,
      suppressed_row_count: 0,
      watermark: 1,
      mute_rows_before: 1,
      mute_rows_at_or_after: 0,
      structural_target_count: 1,
      generation_gap_bucket: "0",
    },
  };
}
