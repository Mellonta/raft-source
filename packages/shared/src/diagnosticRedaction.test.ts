import assert from "node:assert/strict";
import { redactDiagnosticText } from "./diagnosticRedaction";
import { DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES } from "./test/diagnosticRedactionCredentialSamples";

describe("redactDiagnosticText", () => {
  test("masks every known credential sample in both URL modes", () => {
    for (const { label, sample, mustNotContain } of DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES) {
      for (const urls of ["query", "drop"] as const) {
        const out = redactDiagnosticText(sample, { urls });
        assert.ok(!out.includes(mustNotContain), `${label} (${urls}) leaked: ${out}`);
      }
    }
  });

  test("keeps the URL origin and path in query mode and drops the whole URL in drop mode", () => {
    const line = "fetch https://api.example.test/v1/thing?token=abc failed";
    assert.equal(redactDiagnosticText(line), "fetch https://api.example.test/v1/thing?[REDACTED_QUERY] failed");
    assert.equal(redactDiagnosticText(line, { urls: "drop" }), "fetch [url] failed");
  });

  test("leaves ordinary log text untouched", () => {
    const line = "2026-09-15T04:00:00.000Z [INFO] [Daemon] agent agent-1 started (pid 4242) in 130ms";
    assert.equal(redactDiagnosticText(line), line);
  });

  test("masks home-directory paths and emails as identity, not as secrets", () => {
    const out = redactDiagnosticText("cwd /Users/alice/work/repo reported by alice@example.test");
    assert.ok(!out.includes("/Users/alice"));
    assert.ok(!out.includes("alice@example.test"));
  });

  test("masks an orphan PEM BEGIN with no END (file read while being written)", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
    const out = redactDiagnosticText(["ok line", "-----BEGIN PRIVATE KEY-----", body].join("\n"));
    assert.ok(!out.includes(body), "unpaired BEGIN must still mask the key body");
  });

  test("masks an orphan PEM END with no BEGIN (rotation cut the block head)", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
    const out = redactDiagnosticText([body, "-----END PRIVATE KEY-----", "later line"].join("\n"));
    assert.ok(!out.includes(body), "unpaired END must still mask the key body before it");
  });

  test("a complete PEM block does not swallow surrounding log text", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
    const out = redactDiagnosticText([
      "before line",
      "-----BEGIN PRIVATE KEY-----",
      body,
      "-----END PRIVATE KEY-----",
      "after line",
    ].join("\n"));
    assert.ok(!out.includes(body));
    assert.ok(out.includes("before line"), "text before a complete block must survive");
    assert.ok(out.includes("after line"), "text after a complete block must survive");
  });
});
