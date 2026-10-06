import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  missingRuntimeFormV2Capabilities,
  parseRuntimeFormV2,
  RUNTIME_FORM_V2_RESERVED_CLIENT_CAPABILITIES,
} from "@botiverse/raft-runtime-form";

import { WEB_RUNTIME_FORM_V2_CAPABILITIES } from "../src/hooks/useRuntimeFormV2";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../runtime-form/fixtures/${name}`, import.meta.url), "utf8")) as unknown;

test("web implements every reserved runtime form v2 capability, so Codex, Grok, Claude, Cursor, Copilot and Pi open on v2", () => {
  assert.deepEqual([...WEB_RUNTIME_FORM_V2_CAPABILITIES].sort(), [...RUNTIME_FORM_V2_RESERVED_CLIENT_CAPABILITIES].sort());
  for (const name of [
    "codex.form.json", "codex.edit.json", "grok.form.json", "choices.form.json", "capabilities.form.json",
    "claude.form.json", "claude.edit.json", "cursor.form.json", "cursor.edit.json", "copilot.form.json",
    "pi.form.json", "pi.edit.json", "pi.edit.configured.json",
  ]) {
    const form = parseRuntimeFormV2(fixture(name));
    assert.ok(form, name);
    assert.deepEqual(missingRuntimeFormV2Capabilities(form, WEB_RUNTIME_FORM_V2_CAPABILITIES), [], name);
  }
  // A capability web does not know still sends the form back to legacy.
  const future = parseRuntimeFormV2({ ...(fixture("codex.form.json") as object), requiredClientCapabilities: ["choice.labels", "future.capability"] });
  assert.deepEqual(missingRuntimeFormV2Capabilities(future!, WEB_RUNTIME_FORM_V2_CAPABILITIES), ["future.capability"]);
});
