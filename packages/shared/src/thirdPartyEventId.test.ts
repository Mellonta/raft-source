import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  THIRD_PARTY_EVENT_DELIVERED_REPORT_MAX_IDS,
  THIRD_PARTY_EVENT_ID_PATTERN,
  isThirdPartyEventId,
  normalizeThirdPartyEventId,
} from "./thirdPartyEventId";

const here = path.dirname(fileURLToPath(import.meta.url));

test("third-party event ids are UUIDs, matched case-insensitively and normalized to lowercase", () => {
  const lower = "0f3b6c2e-8d41-4a7b-9c55-1e2f3a4b5c6d";
  const upper = lower.toUpperCase();
  assert.equal(isThirdPartyEventId(lower), true);
  assert.equal(isThirdPartyEventId(upper), true);
  assert.equal(normalizeThirdPartyEventId(upper), lower);
  for (const bad of ["", "0f3b6c2e", "not-a-uuid", `${lower}x`, ` ${lower}`, 42, null, undefined]) {
    assert.equal(isThirdPartyEventId(bad), false, String(bad));
  }
  assert.equal(THIRD_PARTY_EVENT_ID_PATTERN.flags.includes("i"), true);
  assert.equal(THIRD_PARTY_EVENT_DELIVERED_REPORT_MAX_IDS, 200);
});

// Task #176 — the daemon reporter and the server validator must consume the
// shared contract instead of re-declaring the pattern or the cap. Both files
// are read from the monorepo so a re-introduced local copy fails here.
test("daemon reporter and server validator import the shared event id contract and define no local copy", () => {
  const files = {
    daemon: path.resolve(here, "../../daemon/src/thirdPartyEventDeliveryReporter.ts"),
    server: path.resolve(here, "../../server/src/routes/internalAgentApi.ts"),
  };
  for (const [name, file] of Object.entries(files)) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /isThirdPartyEventId|THIRD_PARTY_EVENT_ID_PATTERN/, `${name} uses the shared id contract`);
    assert.match(source, /THIRD_PARTY_EVENT_DELIVERED_REPORT_MAX_IDS/, `${name} uses the shared report cap`);
    assert.doesNotMatch(
      source,
      /\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/,
      `${name} must not re-declare the third-party event id pattern`,
    );
    assert.doesNotMatch(source, /^const (EVENT_ID_PATTERN|THIRD_PARTY_EVENT_ID_PATTERN|REPORT_BATCH_MAX_IDS|THIRD_PARTY_EVENT_DELIVERED_REPORT_MAX_IDS)\b/m, `${name} must not define a local copy`);
  }
});
