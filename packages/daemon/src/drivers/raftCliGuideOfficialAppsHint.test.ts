import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { OFFICIAL_APPS_HINT, OFFICIAL_APPS_HINT_VERSION, buildRaftCliGuideMarkdown, buildRaftCliOverviewMdx } from "./raftCliGuide";

// Contract rev3.1 §4b (task #302). The hint is a frozen renderer-hash target: a
// wording change must be a deliberate v2 (bump the version, re-pin the digest,
// record it in the contract), never a drive-by edit.
const FROZEN_V1_SHA256 = "cce7cb81ac289cd36ace659f0b3100362e949c67fa0a9108fd588651d7eade04";

test("official-apps hint v1 is byte-frozen", () => {
  assert.equal(OFFICIAL_APPS_HINT_VERSION, 1);
  assert.equal(createHash("sha256").update(OFFICIAL_APPS_HINT, "utf8").digest("hex"), FROZEN_V1_SHA256);
});

test("official-apps hint names no app, carries no URL, and points only at raft integration list", () => {
  assert.doesNotMatch(OFFICIAL_APPS_HINT, /https?:\/\/|www\./i);
  assert.doesNotMatch(OFFICIAL_APPS_HINT, /artifact|stamp|slack|lens|cortex|marketplace/i);
  assert.match(OFFICIAL_APPS_HINT, /`raft integration list`/);
  assert.match(OFFICIAL_APPS_HINT, /set by the platform, never by the app/);
  assert.match(OFFICIAL_APPS_HINT, /"not listed", not "unavailable"/);
});

test("the hint appears exactly once in the system prompt guide and in the generated Manual overview", () => {
  for (const text of [buildRaftCliGuideMarkdown(), buildRaftCliOverviewMdx()]) {
    assert.equal(text.split(OFFICIAL_APPS_HINT).length - 1, 1);
  }
});
