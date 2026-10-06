import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { releasedRuntimeFormDefinition } from "./index";
import { parseRuntimeFormV2, toRuntimeFormV2 } from "./v2";
import {
  applyRuntimeFormV2Change,
  initialRuntimeFormV2Values,
  isRuntimeFormV2FieldVisible,
  runtimeFormV2Choices,
  runtimeFormV2SourceStatus,
  runtimeFormV2Submission,
  validateRuntimeFormV2,
  type RuntimeFormV2Sources,
} from "./v2State";

const pi = parseRuntimeFormV2(toRuntimeFormV2(releasedRuntimeFormDefinition("builtin-pi.create.v3")!))!;
const kimi = parseRuntimeFormV2(toRuntimeFormV2(releasedRuntimeFormDefinition("kimi-sdk.create.v1")!))!;
const field = (form: typeof pi, key: string) => form.fields.find((candidate) => candidate.key === key)!;

const piSources: RuntimeFormV2Sources = {
  provider: {
    sourceId: "provider", kind: "select", pointer: "/providerId",
    options: [
      { value: "deepseek", label: "DeepSeek", providerKind: "preset" },
      { value: "openai-compatible", label: "OpenAI compatible", providerKind: "gateway" },
    ],
    defaultValue: "deepseek",
  },
  model: {
    sourceId: "model", kind: "dependent_select", pointer: "/model", dependsOn: "/providerId",
    optionsByValue: { deepseek: [{ value: "deepseek/v4", label: "V4" }, { value: "deepseek/flash", label: "Flash" }], "openai-compatible": [] },
    defaultValueByValue: { deepseek: "deepseek/v4" },
    customValueAllowedByValue: { deepseek: false, "openai-compatible": true },
  },
};
const kimiSources: RuntimeFormV2Sources = {
  model: {
    sourceId: "model", kind: "select", pointer: "/model",
    options: [
      { value: "k2", label: "K2", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" },
      { value: "k1", label: "K1" },
    ],
    defaultValue: "k2",
  },
};

test("initial values follow sources: parents first, then dependents and derived choices", () => {
  const values = initialRuntimeFormV2Values(pi, piSources);
  assert.equal(values.providerId, "deepseek");
  assert.equal(values.model, "deepseek/v4");
  assert.equal(values.loadLocalPlugins, false);
  assert.deepEqual(values.envVars, {});
  const kimiValues = initialRuntimeFormV2Values(kimi, kimiSources);
  assert.equal(kimiValues.reasoningEffort, "high");
});

test("changing a parent resets what depends on it, and visibility follows", () => {
  let values = initialRuntimeFormV2Values(pi, piSources);
  assert.equal(isRuntimeFormV2FieldVisible(field(pi, "baseUrl"), values), false);
  values = applyRuntimeFormV2Change(pi, piSources, values, "providerId", "openai-compatible");
  assert.equal(values.model, "", "a gateway starts with an empty custom model");
  assert.equal(isRuntimeFormV2FieldVisible(field(pi, "baseUrl"), values), true);
  assert.deepEqual(runtimeFormV2Choices(field(pi, "model"), piSources, values), { kind: "free_text" });

  let kimiValues = initialRuntimeFormV2Values(kimi, kimiSources);
  kimiValues = applyRuntimeFormV2Change(kimi, kimiSources, kimiValues, "model", "k1");
  assert.equal(kimiValues.reasoningEffort, "", "a model without an effort menu falls back to the default");
  assert.deepEqual(runtimeFormV2Choices(field(kimi, "reasoningEffort"), kimiSources, kimiValues), { kind: "select", options: [], allowEmpty: true, allowCustom: false });
});

test("validation covers required, URL and choice membership on visible fields only", () => {
  let values = initialRuntimeFormV2Values(pi, piSources);
  assert.deepEqual(validateRuntimeFormV2(pi, piSources, values), { apiKey: "required" });
  values = { ...values, apiKey: "k", model: "not-offered" };
  assert.deepEqual(validateRuntimeFormV2(pi, piSources, values), { model: "not_a_choice" });
  values = applyRuntimeFormV2Change(pi, piSources, { ...values, model: "deepseek/v4" }, "providerId", "openai-compatible");
  values = { ...values, model: "any/model", baseUrl: "ftp://x" };
  assert.deepEqual(validateRuntimeFormV2(pi, piSources, values), { baseUrl: "invalid_url" });
});

test("the submission carries visible fields only, trimmed, and an empty derived choice as null", () => {
  const values = { ...initialRuntimeFormV2Values(pi, piSources), apiKey: " k ", baseUrl: "https://hidden.example" };
  const submitted = runtimeFormV2Submission(pi, values);
  assert.equal(submitted.apiKey, "k");
  assert.equal("baseUrl" in submitted, false, "a hidden field is not submitted");
  const kimiSubmitted = runtimeFormV2Submission(kimi, { ...initialRuntimeFormV2Values(kimi, kimiSources), reasoningEffort: "" });
  assert.equal(kimiSubmitted.reasoningEffort, null);
});

test("edit starts from the agent's stored values, and dependents follow the stored parent", () => {
  const editForm = { ...pi, values: { providerId: "deepseek", model: "deepseek/flash", loadLocalPlugins: true, envVars: { A: "1" }, supportsImageInput: "not-a-boolean" } };
  const values = initialRuntimeFormV2Values(editForm, piSources);
  assert.equal(values.model, "deepseek/flash", "stored choice kept, not reset to the default");
  assert.equal(values.loadLocalPlugins, true);
  assert.deepEqual(values.envVars, { A: "1" });
  assert.equal(values.supportsImageInput, false, "a stored value of the wrong kind falls back to the default");
  assert.equal(values.apiKey, "", "writeOnly fields start blank (blank on edit keeps the stored secret)");
});

test("on edit a blank secret is valid (it keeps the stored value); on create it is required", () => {
  const values = initialRuntimeFormV2Values(pi, piSources);
  assert.deepEqual(validateRuntimeFormV2(pi, piSources, values), { apiKey: "required" });
  assert.deepEqual(validateRuntimeFormV2(pi, piSources, values, { editing: true }), {});
});

// Batch 3a capabilities, against the shared fixtures the server sends
// (fixtures/codex.*, grok.form.json) and the hand-written choices sample.
const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const fixture = (name: string) => JSON.parse(readFileSync(`${FIXTURES}${name}`, "utf8")) as Record<string, unknown>;
const codex = parseRuntimeFormV2(fixture("codex.form.json"))!;
const codexEdit = parseRuntimeFormV2(fixture("codex.edit.json"))!;
const codexSources = (name: string): RuntimeFormV2Sources => ({ model: fixture(name) as RuntimeFormV2Sources[string] });

test("select.custom_value: a combobox; any non-empty typed value is valid, required still needs one", () => {
  const sources = codexSources("codex.option-source.live.json");
  const values = initialRuntimeFormV2Values(codex, sources);
  assert.equal(values.model, "gpt-5.6-sol", "the source default");
  const choices = runtimeFormV2Choices(field(codex, "model"), sources, values);
  assert.equal(choices?.kind === "select" && choices.allowCustom, true);
  assert.deepEqual(validateRuntimeFormV2(codex, sources, { ...values, model: "my-org/typed" }), {});
  assert.deepEqual(validateRuntimeFormV2(codex, sources, { ...values, model: "  " }), { model: "required" });
  assert.equal(runtimeFormV2Submission(codex, { ...values, model: " my-org/typed " }, sources).model, "my-org/typed");
  // Without the flag the same unlisted value is not a choice.
  const strict = { model: { ...sources.model!, customValueAllowed: undefined } } as RuntimeFormV2Sources;
  assert.deepEqual(validateRuntimeFormV2(codex, strict, { ...values, model: "my-org/typed" }), { model: "not_a_choice" });
});

test("select.custom_value on edit: a stored value that is not listed is kept and submitted as typed", () => {
  for (const name of ["codex.option-source.live.json", "codex.option-source.fallback.json"]) {
    const sources = codexSources(name);
    const values = initialRuntimeFormV2Values(codexEdit, sources);
    assert.equal(values.model, "my-org/codex-custom", name);
    assert.equal(values.fastMode, true, name);
    assert.deepEqual(validateRuntimeFormV2(codexEdit, sources, values, { editing: true }), {}, name);
    const submitted = runtimeFormV2Submission(codexEdit, values, sources);
    assert.equal(submitted.model, "my-org/codex-custom", name);
    assert.equal(submitted.fastMode, true, name);
    // No option describes a typed model, so its effort menu is empty (not shown):
    // the stored effort is not "not a choice" and goes back unchanged.
    const effort = runtimeFormV2Choices(field(codexEdit, "reasoningEffort"), sources, values);
    assert.deepEqual(effort?.kind === "select" && effort.options, [], name);
    assert.equal(submitted.reasoningEffort, "high", name);
  }
});

test("choice.labels: choices label > option label > raw value; description only from choices; unknown keys ignored", () => {
  const form = parseRuntimeFormV2(fixture("choices.form.json"))!;
  const sources: RuntimeFormV2Sources = { tier: fixture("choices.option-source.json") as RuntimeFormV2Sources[string] };
  const values = initialRuntimeFormV2Values(form, sources);
  const tier = runtimeFormV2Choices(field(form, "tier"), sources, values);
  assert.ok(tier?.kind === "select");
  assert.deepEqual(tier.options.map((option) => [option.value, option.label, option.description]), [
    ["fast", "Fast tier", "Lower latency"],
    ["steady", "Steady (no choices key: the option's own label)", undefined],
  ]);
  const bare = runtimeFormV2Choices(field(form, "tier"), { tier: { ...sources.tier!, options: [{ value: "raw", label: "" }] } }, values);
  assert.deepEqual(bare?.kind === "select" && bare.options.map((option) => option.label), ["raw"], "no label anywhere: the raw value");
  const effort = runtimeFormV2Choices(field(form, "effort"), sources, values);
  assert.ok(effort?.kind === "select");
  assert.deepEqual(effort.options.map((option) => [option.value, option.label, option.description]), [
    ["low", "Low", "Fast responses with lighter reasoning"],
    ["high", "High", undefined],
    ["max", "max", undefined],
  ]);
  assert.equal(values.effort, "low", "derived default");
  // The served Codex/Grok effort labels come from choices.
  const codexValues = initialRuntimeFormV2Values(codex, codexSources("codex.option-source.live.json"));
  const codexEffort = runtimeFormV2Choices(field(codex, "reasoningEffort"), codexSources("codex.option-source.live.json"), codexValues);
  assert.deepEqual(codexEffort?.kind === "select" && codexEffort.options.map((option) => option.label), ["Low", "Medium", "High", "Extra High", "Max", "Ultra"]);
  assert.equal(codexValues.reasoningEffort, "medium");
});

test("option_source.status: fallback informs; unavailable blocks a required field and hides an optional one", () => {
  const fallback = codexSources("codex.option-source.fallback.json");
  assert.deepEqual(runtimeFormV2SourceStatus(field(codex, "model"), fallback), { status: "fallback", reason: "missing_config", retryable: false });
  assert.deepEqual(validateRuntimeFormV2(codex, fallback, initialRuntimeFormV2Values(codex, fallback)), {}, "a fallback list is usable");
  assert.equal(runtimeFormV2SourceStatus(field(codex, "model"), codexSources("codex.option-source.live.json")), null);

  const unavailable = codexSources("codex.option-source.unavailable.json");
  const values = initialRuntimeFormV2Values(codex, unavailable);
  assert.deepEqual(runtimeFormV2SourceStatus(field(codex, "model"), unavailable), { status: "unavailable", reason: "machine_offline", retryable: true });
  assert.equal(isRuntimeFormV2FieldVisible(field(codex, "model"), values, unavailable), true, "a required field stays to explain");
  assert.deepEqual(validateRuntimeFormV2(codex, unavailable, values), { model: "source_unavailable" });
  // Even a stored/typed value cannot be submitted while the required source is unavailable.
  assert.deepEqual(validateRuntimeFormV2(codexEdit, unavailable, initialRuntimeFormV2Values(codexEdit, unavailable), { editing: true }), { model: "source_unavailable" });

  // The same source behind an optional field: hidden, nothing to validate, the stored value survives an edit.
  const optional = { ...codexEdit, fields: codexEdit.fields.map((candidate) => candidate.key === "model" ? { ...candidate, required: false } : candidate) };
  const optionalValues = initialRuntimeFormV2Values(optional, unavailable);
  assert.equal(isRuntimeFormV2FieldVisible(field(optional, "model"), optionalValues, unavailable), false);
  assert.deepEqual(validateRuntimeFormV2(optional, unavailable, optionalValues), {});
  assert.equal(runtimeFormV2Submission(optional, { ...optionalValues, model: "" }, unavailable).model, "my-org/codex-custom");
  const optionalCreate = { ...optional, values: undefined };
  assert.equal("model" in runtimeFormV2Submission(optionalCreate, initialRuntimeFormV2Values(optionalCreate, unavailable), unavailable), false);

  // An unknown status or reason is tolerated: an unknown status is ignored, an unknown reason is passed on.
  const odd = { model: { ...unavailable.model!, status: "degraded" } } as unknown as RuntimeFormV2Sources;
  assert.equal(runtimeFormV2SourceStatus(field(codex, "model"), odd), null);
  const oddReason = { model: { ...unavailable.model!, reason: "brand_new_reason" } } as unknown as RuntimeFormV2Sources;
  assert.equal(runtimeFormV2SourceStatus(field(codex, "model"), oddReason)?.reason, "brand_new_reason");
});

// Batch 3b: Claude's provider fields, against the shared fixtures the server sends.
const claude = parseRuntimeFormV2(fixture("claude.form.json"))!;
const claudeEdit = parseRuntimeFormV2(fixture("claude.edit.json"))!;
const claudeSources: RuntimeFormV2Sources = {
  provider: fixture("claude.option-source.provider.json") as RuntimeFormV2Sources[string],
  model: fixture("claude.option-source.fallback.json") as RuntimeFormV2Sources[string],
};

test("claude: API URL and key show only for a Custom provider and are not submitted under Default", () => {
  const values = initialRuntimeFormV2Values(claude, claudeSources);
  assert.equal(values.provider, "default");
  assert.equal(values.model, "opus");
  for (const key of ["apiUrl", "apiKey"]) assert.equal(isRuntimeFormV2FieldVisible(field(claude, key), values, claudeSources), false, key);
  assert.deepEqual(validateRuntimeFormV2(claude, claudeSources, values), {});
  const submitted = runtimeFormV2Submission(claude, { ...values, apiUrl: "https://stale.example.test", apiKey: "stale" }, claudeSources);
  assert.equal("apiUrl" in submitted || "apiKey" in submitted, false);

  const custom = applyRuntimeFormV2Change(claude, claudeSources, values, "provider", "custom");
  for (const key of ["apiUrl", "apiKey"]) assert.equal(isRuntimeFormV2FieldVisible(field(claude, key), custom, claudeSources), true, key);
  assert.equal(field(claude, "apiKey").kind, "secret");
  assert.deepEqual(validateRuntimeFormV2(claude, claudeSources, { ...custom, apiUrl: "gw.example.test" }), { apiUrl: "invalid_url" });
});

test("claude edit: the stored key is never in the values; a blank key is valid and submitted blank (the server keeps the stored one)", () => {
  assert.equal(claudeEdit.values && "apiKey" in claudeEdit.values, false);
  const values = initialRuntimeFormV2Values(claudeEdit, claudeSources);
  assert.equal(values.provider, "custom");
  assert.equal(values.apiUrl, "https://gateway.example.test");
  assert.equal(values.apiKey, "");
  assert.deepEqual(validateRuntimeFormV2(claudeEdit, claudeSources, values, { editing: true }), {});
  const submitted = runtimeFormV2Submission(claudeEdit, values, claudeSources);
  assert.equal(submitted.apiKey, "");
  assert.equal(submitted.command, "/usr/local/bin/claude");
  assert.equal(submitted.fastMode, true);
  assert.equal(submitted.reasoningEffort, "high");
});

test("cursor: no effort field; a typed model is kept", () => {
  const cursorForm = parseRuntimeFormV2(fixture("cursor.form.json"))!;
  const sources: RuntimeFormV2Sources = { model: fixture("cursor.option-source.fallback.json") as RuntimeFormV2Sources[string] };
  assert.deepEqual(cursorForm.fields.map((candidate) => candidate.key), ["model", "envVars"]);
  const values = initialRuntimeFormV2Values(cursorForm, sources);
  assert.deepEqual(validateRuntimeFormV2(cursorForm, sources, { ...values, model: "my-org/typed" }), {});
  assert.deepEqual(runtimeFormV2SourceStatus(field(cursorForm, "model"), sources), { status: "fallback", reason: "missing_config", retryable: false });
});
