import assert from "node:assert/strict";
import { DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES } from "../../shared/src/test/diagnosticRedactionCredentialSamples";
import { redactTranscript } from "./sessionTranscriptReader";

// task #272 tier 2 gate: the transcript path must mask the SAME credential
// samples as every other diagnostic producer. Before this change it had a
// private rule list that let a bare JWT (no `Bearer` prefix) through.
describe("session transcript redaction", () => {
  test("masks every shared credential sample", () => {
    for (const { label, sample, mustNotContain } of DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES) {
      const out = redactTranscript(`{"text":${JSON.stringify(sample)}}`);
      assert.ok(!out.includes(mustNotContain), `${label} leaked through transcript redaction: ${out}`);
    }
  });

  test("still drops whole URLs from transcripts", () => {
    assert.equal(redactTranscript("see https://example.test/a?b=c now"), "see [url] now");
  });
});
