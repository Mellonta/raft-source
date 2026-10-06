import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import { mergedMessages } from "../src/i18n/messages/index";
import { RUNTIME_ERROR_LABEL_ID, classifyRuntimeError } from "../src/utils/classifyRuntimeError";

// task #1127 — a Codex tool-argument parse failure must reach the user as
// dedicated copy, and must do so from the daemon's typed reason rather than
// from the web re-matching the upstream sentence.

test("toolArgsInvalid resolves to real copy in both catalogs", () => {
  for (const locale of ["en", "zh-cn"] as const) {
    const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
    const text = intl.formatMessage({ id: RUNTIME_ERROR_LABEL_ID.toolArgsInvalid });
    assert.ok(text.length > 0, `${locale} copy must exist`);
    assert.ok(!text.includes("agent.runtimeError."), `${locale} copy must resolve, got: ${text}`);
    // The point of the message is to tell the user which side is at fault.
    assert.ok(/Codex/.test(text), `${locale} copy should name the runtime that rejected the call: ${text}`);
  }
});

test("en and zh copy both point the user at the model, not at their own input", () => {
  const en = createIntl({ locale: "en", defaultLocale: "en", messages: mergedMessages("en") })
    .formatMessage({ id: RUNTIME_ERROR_LABEL_ID.toolArgsInvalid });
  const zh = createIntl({ locale: "zh-cn", defaultLocale: "en", messages: mergedMessages("zh-cn") })
    .formatMessage({ id: RUNTIME_ERROR_LABEL_ID.toolArgsInvalid });
  assert.match(en, /model/i);
  assert.match(zh, /模型/);
});

test("the web does NOT text-match the upstream sentence — the typed carrier is the only route", () => {
  // If this ever starts returning "toolArgsInvalid", a second classifier for the
  // same fact has appeared on the web side and the daemon signature is no longer
  // the single place that owns it.
  assert.equal(
    classifyRuntimeError(
      "ERROR codex_core::tools::router: error=failed to parse function arguments: invalid type: floating point 14380.0, expected i32",
    ),
    null,
  );
});
