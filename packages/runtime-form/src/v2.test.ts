import assert from "node:assert/strict";

import { releasedRuntimeFormDefinition } from "./index";
import { parseRuntimeFormV2, toRuntimeFormV2 } from "./v2";

const builtinPi = () => toRuntimeFormV2(releasedRuntimeFormDefinition("builtin-pi.create.v3")!);
const kimi = () => toRuntimeFormV2(releasedRuntimeFormDefinition("kimi-sdk.create.v1")!);

/** The parts of a wire body these tests edit, loosely typed like any JSON a server might send. */
type FormJson = {
  [key: string]: unknown;
  uiSchema: { [key: string]: unknown; order: string[]; localization: Record<string, { label?: string }> };
  dataSchema: { required: string[]; properties: Record<string, Record<string, unknown>> };
};

test("the server producer marks option-backed fields and switches to protocol 2", () => {
  const form = builtinPi();
  assert.equal(form.protocolVersion, 2);
  assert.equal((form.dataSchema.properties.providerId as Record<string, unknown>)["x-optionSource"], "provider");
  assert.equal((form.dataSchema.properties.model as Record<string, unknown>)["x-optionSource"], "model");
  assert.equal("x-optionSource" in form.dataSchema.properties.apiKey, false);
  // The frozen v1 record is untouched.
  assert.equal(releasedRuntimeFormDefinition("builtin-pi.create.v3")!.protocolVersion, 1);
});

test("Built-in Pi renders by field kind, in order, with advanced and visibility", () => {
  const parsed = parseRuntimeFormV2(builtinPi());
  assert.ok(parsed);
  assert.deepEqual(parsed.fields.map((field) => [field.key, field.kind]), [
    ["providerId", "select"],
    ["apiKey", "secret"],
    ["baseUrl", "url"],
    ["supportsImageInput", "boolean"],
    ["model", "dependent_select"],
    ["loadLocalPlugins", "boolean"],
    ["envVars", "string_map"],
  ]);
  const byKey = Object.fromEntries(parsed.fields.map((field) => [field.key, field]));
  assert.equal(byKey.model.dependsOn, "providerId");
  assert.equal(byKey.loadLocalPlugins.label, "Load local Pi extensions");
  assert.deepEqual(parsed.fields.filter((field) => field.advanced).map((field) => field.key), ["loadLocalPlugins", "envVars"]);
  assert.deepEqual(parsed.fields.filter((field) => field.required).map((field) => field.key), ["providerId", "apiKey", "model"]);
  assert.equal(byKey.baseUrl.visibleWhen[0]?.key, "providerId");
  assert.deepEqual(parsed.blockingFieldKeys, []);
});

test("Kimi renders its model as a select and effort as choices derived from the selected model", () => {
  const parsed = parseRuntimeFormV2(kimi());
  assert.ok(parsed);
  assert.deepEqual(parsed.fields.map((field) => [field.key, field.kind]), [
    ["model", "select"],
    ["reasoningEffort", "derived_select"],
    ["envVars", "string_map"],
  ]);
  assert.deepEqual(parsed.fields[1]?.derivedFrom, {
    key: "model",
    attribute: "supportedReasoningEfforts",
    defaultAttribute: "defaultReasoningEffort",
  });
});

test("a derived field that names a missing field falls back to plain text", () => {
  const form = kimi() as unknown as FormJson;
  form.dataSchema.properties.reasoningEffort!["x-optionsFrom"] = { field: "gone", attribute: "x" };
  assert.equal(parseRuntimeFormV2(form)?.fields.find((field) => field.key === "reasoningEffort")?.kind, "text");
});

test("a v2 client tolerates everything a server is allowed to add", () => {
  const form = builtinPi() as unknown as FormJson;
  form.somethingNew = { nested: true };
  form.uiSchema.somethingNew = [1, 2];
  form.dataSchema.properties.apiKey.somethingNew = "x";
  form.dataSchema.properties.newOptionalFlag = { type: "boolean", title: "New flag" };
  form.dataSchema.properties.newWidget = { type: "color", title: "Colour" };
  form.uiSchema.localization.providerId.label = "Model provider";
  form.uiSchema.order = ["model", "providerId"];

  const parsed = parseRuntimeFormV2(form);
  assert.ok(parsed, "unknown additions must not reject the form");
  const keys = parsed.fields.map((field) => field.key);
  assert.deepEqual(keys.slice(0, 2), ["model", "providerId"], "declared order first");
  assert.ok(keys.includes("newOptionalFlag") && keys.includes("apiKey"), "undeclared fields are appended, not dropped");
  assert.equal(parsed.fields.find((field) => field.key === "newWidget")?.kind, "unsupported");
  assert.deepEqual(parsed.blockingFieldKeys, [], "an optional unknown kind does not block");
  assert.equal(parsed.fields.find((field) => field.key === "providerId")?.label, "Model provider");
});

test("a required field of an unknown kind blocks saving but still yields the form", () => {
  const form = kimi() as unknown as FormJson;
  form.dataSchema.properties.region = { type: "geo", title: "Region" };
  form.dataSchema.required.push("region");
  const parsed = parseRuntimeFormV2(form);
  assert.ok(parsed);
  assert.deepEqual(parsed.blockingFieldKeys, ["region"]);
  assert.equal(parsed.fields.length, 4);
});

test("labels fall back to the title, then the key", () => {
  const form = kimi() as unknown as FormJson;
  delete form.uiSchema.localization.envVars;
  form.dataSchema.properties.bare = { type: "string" };
  const parsed = parseRuntimeFormV2(form);
  assert.equal(parsed?.fields.find((field) => field.key === "envVars")?.label, "Environment Variables");
  assert.equal(parsed?.fields.find((field) => field.key === "bare")?.label, "bare");
});

test("only a body that is not a v2 form is rejected", () => {
  assert.equal(parseRuntimeFormV2(releasedRuntimeFormDefinition("builtin-pi.create.v3")), null, "v1 body");
  assert.equal(parseRuntimeFormV2({ protocolVersion: 2 }), null, "no dataSchema");
  assert.equal(parseRuntimeFormV2("nope"), null);
});
