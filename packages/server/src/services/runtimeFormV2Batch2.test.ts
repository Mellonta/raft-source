/**
 * Runtime form v2 batch 2: OpenCode (creatable) and the deprecated Kimi CLI,
 * Gemini CLI and Antigravity CLI (edit only). Each form carries no new contract
 * feature and no requiredClientCapabilities; a v2 submit must assemble exactly
 * the runtimeConfig the legacy web form sends for the same inputs, so the
 * legacy builder (packages/web/src/utils/runtimeConfigForm.ts buildRuntimeConfig)
 * is the oracle here, called with the arguments the legacy create/edit dialogs
 * pass for these runtimes.
 */
import assert from "node:assert/strict";
import { parseRuntimeFormV2 } from "@botiverse/raft-runtime-form";
import {
  parseRuntimeConfig,
  RUNTIME_CONFIG_VERSION,
  RUNTIME_MODELS,
  type RuntimeConfig,
  type RuntimeModelSourceOutcome,
} from "@botiverse/raft-shared";

import { buildRuntimeConfig } from "../../../web/src/utils/runtimeConfigForm";
import { RouteFailureError } from "../tracing/routeFailure";
import {
  buildRuntimeConfigFromFormValues,
  buildRuntimeFormV2,
  formValuesPointerForRuntimeConfigPointer,
  runtimeFormV2Entry,
  runtimeFormValuesFromRuntimeConfig,
  staticModelFallbackOptionSource,
  type RuntimeFormOptionSourceContext,
} from "./runtimeFormV2Registry";

const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

/** What the legacy web create/edit dialogs send for a runtime with no provider, fast mode, reasoning or command. */
function legacyRuntimeConfig(runtime: string, model: string, envVars: Record<string, string> | null, customModelMode = false) {
  return buildRuntimeConfig({
    runtime,
    model,
    customModelMode,
    customModelName: customModelMode ? model : undefined,
    providerMode: "default",
    providerApiUrl: "",
    providerApiKey: "",
    fastMode: false,
    // REASONING_EFFORT_RUNTIMES excludes opencode, kimi, gemini and antigravity: the dialogs send null.
    reasoningEffort: null,
    envVars,
    command: "",
  });
}

function submitted(runtime: string, values: Record<string, unknown>, options: Parameters<typeof buildRuntimeConfigFromFormValues>[2] = {}) {
  const built = buildRuntimeConfigFromFormValues(runtime, values, options);
  assert.ok(built.ok, JSON.stringify(built));
  return built.runtimeConfig;
}

/**
 * The server stores the parser's output for either request, and the legacy
 * builder returns the parser's output: compare those bytes, and the assembled
 * object itself key-order-insensitively.
 */
function assertSameAsLegacy(v2: Record<string, unknown>, legacy: RuntimeConfig, message: string) {
  assert.deepEqual(v2, legacy, message);
  const parsed = parseRuntimeConfig({ runtimeConfig: v2 });
  assert.ok(parsed.ok, message);
  assert.equal(JSON.stringify(parsed.config), JSON.stringify(legacy), message);
}

const MODEL_RUNTIMES = ["opencode", "kimi", "gemini"] as const;

test("each batch-2 form: fields, order, advanced envVars, no requiredClientCapabilities", () => {
  for (const runtime of MODEL_RUNTIMES) {
    const form = buildRuntimeFormV2(runtime);
    const parsed = parseRuntimeFormV2(wire(form));
    assert.ok(parsed, runtime);
    assert.equal(parsed.runtimeId, runtime);
    assert.deepEqual(parsed.fields.map((field) => [field.key, field.kind, field.required, field.advanced]), [
      ["model", "select", true, false],
      ["envVars", "string_map", false, true],
    ], runtime);
    assert.deepEqual(Object.keys(parsed.optionSources), ["model"], runtime);
    assert.deepEqual(parsed.requiredClientCapabilities, [], runtime);
    assert.equal("requiredClientCapabilities" in form, false, runtime);
    assert.deepEqual(runtimeFormV2Entry(runtime)!.validateProjection(), [], runtime);
  }
  const antigravity = parseRuntimeFormV2(wire(buildRuntimeFormV2("antigravity")));
  assert.ok(antigravity);
  assert.deepEqual(antigravity.fields.map((field) => [field.key, field.kind, field.required, field.advanced]), [
    ["envVars", "string_map", false, true],
  ]);
  assert.deepEqual(antigravity.optionSources, {});
  assert.deepEqual(antigravity.requiredClientCapabilities, []);
});

test("opencode, kimi, gemini: v2 values assemble exactly the legacy runtimeConfig", () => {
  const cases: Array<[string, string, Record<string, string> | null]> = [
    ["opencode", "deepseek/deepseek-v4-pro", { OPENCODE_FLAG: "1" }],
    ["opencode", "default", null],
    ["kimi", "default", { KIMI_X: "y" }],
    ["kimi", "kimi-k2-live", null],
    ["gemini", "gemini-2.5-pro", null],
    ["gemini", "default", { A: "b" }],
  ];
  for (const [runtime, model, envVars] of cases) {
    for (const editing of [false, true]) {
      const v2 = submitted(runtime, { model, envVars: envVars ?? {} }, { editing });
      assertSameAsLegacy(v2, legacyRuntimeConfig(runtime, model, envVars), `${runtime} ${model} editing=${editing}`);
    }
  }
  // The exact shape, spelled out once so a change in the legacy builder is visible here too.
  assert.deepEqual(submitted("opencode", { model: "default", envVars: { K: "v" } }), {
    version: RUNTIME_CONFIG_VERSION,
    runtime: "opencode",
    model: { kind: "preset", id: "default" },
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars: { K: "v" },
  });
});

test("model runtimes: edit values round-trip back to the stored runtimeConfig", () => {
  for (const runtime of MODEL_RUNTIMES) {
    const stored = legacyRuntimeConfig(runtime, runtime === "gemini" ? "gemini-2.5-flash" : "default", { KEEP: "1" });
    const values = runtimeFormValuesFromRuntimeConfig(stored);
    assert.deepEqual(values, { model: stored.model.kind === "preset" ? stored.model.id : "", envVars: { KEEP: "1" } }, runtime);
    assertSameAsLegacy(submitted(runtime, values!, { editing: true, existing: stored }), stored, runtime);
  }
});

test("a blank model is a clear field error, not a crash", () => {
  for (const runtime of MODEL_RUNTIMES) {
    for (const model of ["", "  ", undefined, 7]) {
      assert.deepEqual(
        buildRuntimeConfigFromFormValues(runtime, { model }),
        { ok: false, issue: { code: "model_required", pointer: "/formValues/model" } },
        `${runtime} ${String(model)}`,
      );
    }
  }
});

test("antigravity: the form has no model field; the stored model is written back unchanged", () => {
  const presetStored = legacyRuntimeConfig("antigravity", "default", { OLD: "1" });
  const customStored = legacyRuntimeConfig("antigravity", "some-agy-model", null, true);
  assert.deepEqual(customStored.model, { kind: "custom", name: "some-agy-model" });
  for (const stored of [presetStored, customStored]) {
    const values = runtimeFormValuesFromRuntimeConfig(stored);
    assert.deepEqual(values, { envVars: stored.envVars ?? {} });
    const next = submitted("antigravity", { envVars: { NEW: "2" } }, { editing: true, existing: stored });
    // Legacy edit keeps draftModel/draftCustomModelMode at the stored values
    // (the field is ignored for Antigravity), so it sends the stored model.
    const legacy = legacyRuntimeConfig(
      "antigravity",
      stored.model.kind === "custom" ? stored.model.name : stored.model.id,
      { NEW: "2" },
      stored.model.kind === "custom",
    );
    assertSameAsLegacy(next, legacy, JSON.stringify(stored.model));
    assert.deepEqual((next as { model: unknown }).model, stored.model);
    // A submitted "model" is ignored: the form has no such field.
    assert.deepEqual((submitted("antigravity", { model: "other" }, { editing: true, existing: stored }) as { model: unknown }).model, stored.model);
  }
  // Without a stored Antigravity config (create, or a different stored runtime)
  // the legacy default applies; create itself is refused later as deprecated.
  const fresh = submitted("antigravity", {});
  assertSameAsLegacy(fresh, legacyRuntimeConfig("antigravity", "", null), "no stored config");
  const fromOther = submitted("antigravity", {}, { editing: true, existing: legacyRuntimeConfig("gemini", "gemini-2.5-pro", null) });
  assert.deepEqual((fromOther as { model: unknown }).model, { kind: "preset", id: RUNTIME_MODELS.antigravity![0]!.id });
});

test("post-assembly issues point back at the field: model for the model runtimes, the whole form for antigravity", () => {
  for (const runtime of MODEL_RUNTIMES) {
    assert.equal(formValuesPointerForRuntimeConfigPointer(runtime, "/runtimeConfig/model"), "/formValues/model");
    assert.equal(formValuesPointerForRuntimeConfigPointer(runtime, "/runtimeConfig/envVars"), "/formValues/envVars");
  }
  assert.equal(formValuesPointerForRuntimeConfigPointer("antigravity", "/runtimeConfig/model"), "/formValues");
  assert.equal(formValuesPointerForRuntimeConfigPointer("antigravity", "/runtimeConfig/envVars"), "/formValues/envVars");
});

function optionSourceContext(
  detect: () => Promise<RuntimeModelSourceOutcome>,
  routing: "confirmed_local" | "handled" | "not_routed" = "confirmed_local",
  sourceId = "model",
) {
  const calls: string[] = [];
  const context = {
    sourceId,
    machineId: "machine-1",
    machine: {},
    agentOrchestrator: {
      detectMachineRuntimeModels: async (_machineId: string, runtime: string) => {
        calls.push(runtime);
        return detect();
      },
      detectMachineRuntimeModelsWithAuthority: async () => { throw new Error("not used"); },
    },
    routeToComputer: async () => routing,
  } as unknown as RuntimeFormOptionSourceContext;
  return { context, calls };
}

const staticSelect = (runtime: string) => ({
  protocolVersion: 1,
  runtimeId: runtime,
  schemaVersion: buildRuntimeFormV2(runtime).schemaVersion,
  sourceId: "model",
  kind: "select",
  pointer: "/model",
  options: (RUNTIME_MODELS[runtime] ?? []).map((model) => ({ value: model.id, label: model.label })),
  defaultValue: RUNTIME_MODELS[runtime]?.[0]?.id ?? "",
});

test("opencode and kimi: a live probe is the select; every non-live outcome, offline machine or probe failure falls back to the static list", async () => {
  for (const runtime of ["opencode", "kimi"]) {
    const entry = runtimeFormV2Entry(runtime)!;
    const live = optionSourceContext(async () => ({
      kind: "live",
      value: { models: [{ id: "a/one", label: "One" }, { id: "b/two", label: "Two" }], default: "b/two" },
    }));
    assert.deepEqual(await entry.resolveOptionSource(live.context), {
      kind: "source",
      source: { ...staticSelect(runtime), options: [{ value: "a/one", label: "One" }, { value: "b/two", label: "Two" }], defaultValue: "b/two" },
    }, runtime);
    assert.deepEqual(live.calls, [runtime], "probes the runtime itself");

    const nonLive: Array<() => Promise<RuntimeModelSourceOutcome>> = [
      async () => ({ kind: "missing_config" }),
      async () => ({ kind: "no_models" }),
      async () => ({ kind: "unsupported" }),
      async () => ({ kind: "error", retryable: true, code: "detect_timeout" }),
      async () => ({ kind: "live", value: { models: [] } }),
      async () => { throw new RouteFailureError("daemon_timeout", "timed out"); },
      async () => { throw new Error("boom"); },
    ];
    for (const [index, detect] of nonLive.entries()) {
      const { context } = optionSourceContext(detect);
      assert.deepEqual(await entry.resolveOptionSource(context), { kind: "source", source: staticSelect(runtime) }, `${runtime} #${index}`);
    }
    const offline = optionSourceContext(async () => { throw new Error("must not probe"); }, "not_routed");
    assert.deepEqual(await entry.resolveOptionSource(offline.context), { kind: "source", source: staticSelect(runtime) });
    assert.deepEqual(offline.calls, []);
    const replayed = optionSourceContext(async () => { throw new Error("must not probe"); }, "handled");
    assert.deepEqual(await entry.resolveOptionSource(replayed.context), { kind: "handled" });
    const unknown = optionSourceContext(async () => { throw new Error("must not probe"); }, "confirmed_local", "provider");
    assert.deepEqual(await entry.resolveOptionSource(unknown.context), { kind: "source", source: null });
  }
});

test("gemini: the static list, without asking the Computer", async () => {
  const { context, calls } = optionSourceContext(async () => { throw new Error("must not probe"); });
  assert.deepEqual(await runtimeFormV2Entry("gemini")!.resolveOptionSource(context), { kind: "source", source: staticSelect("gemini") });
  assert.deepEqual(calls, []);
  assert.ok(staticSelect("gemini").options.length > 1);
});

test("an empty static fallback list is an empty select", () => {
  const empty = staticModelFallbackOptionSource("opencode", []);
  assert.deepEqual(empty, { ...staticSelect("opencode"), options: [], defaultValue: "" });
});

test("stored configs of runtimes without a v2 form are not editable", () => {
  // Every catalog runtime has a v2 form since batch 4, so the example is an unknown id.
  const stored = { runtime: "not-a-runtime", model: { kind: "preset", id: "default" } } as unknown as RuntimeConfig;
  assert.equal(runtimeFormValuesFromRuntimeConfig(stored), null);
});
