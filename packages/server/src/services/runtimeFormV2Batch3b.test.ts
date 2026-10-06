/**
 * Runtime form v2 batch 3b: Claude, Cursor and Copilot.
 *
 * Oracles:
 * - the legacy web form: its runtime predicates and runtimeConfig builder
 *   (packages/web/src/utils/runtimeConfigForm.ts), its effort picker
 *   (utils/reasoningEffortOptions.ts) and REASONING_EFFORT_RUNTIMES, which
 *   decide the fields each runtime gets;
 * - the contract's probe outcome → reason/retryable table
 *   (runtimeFormV2SourceStatus.ts).
 */
import assert from "node:assert/strict";
import { parseRuntimeFormV2 } from "@botiverse/raft-runtime-form";
import {
  BASE_REASONING_EFFORTS,
  getStaticRuntimeModelSourceSet,
  parseRuntimeConfig,
  REASONING_EFFORT_RUNTIMES,
  RUNTIME_CONFIG_VERSION,
  RUNTIME_MODELS,
  type ReasoningEffort,
  type RuntimeConfig,
  type RuntimeModelInfo,
  type RuntimeModelSourceOutcome,
} from "@botiverse/raft-shared";

import { reasoningEffortOptionsForModel } from "../../../web/src/utils/reasoningEffortOptions";
import {
  buildRuntimeConfig,
  supportsRuntimeApiUrl,
  supportsRuntimeCommand,
  supportsRuntimeCustomModelName,
  supportsRuntimeFastMode,
} from "../../../web/src/utils/runtimeConfigForm";
import { RouteFailureError } from "../tracing/routeFailure";
import { runtimeFormV1Entry } from "./runtimeFormDefinitionService";
import {
  buildRuntimeConfigFromFormValues,
  buildRuntimeFormV2,
  formValuesPointerForRuntimeConfigPointer,
  reasoningEffortChoices,
  reconcileRuntimeFormV2SubmissionWithLiveModels,
  redactWriteOnlyRuntimeConfig,
  retainOmittedWriteOnlySecrets,
  runtimeFormV2Entry,
  runtimeFormValuesFromRuntimeConfig,
  type RuntimeFormOptionSourceContext,
} from "./runtimeFormV2Registry";
import { RUNTIME_FORM_V2_REASON_RETRYABLE } from "./runtimeFormV2SourceStatus";

const BATCH_3B = ["claude", "cursor", "copilot"] as const;

const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

// ── Forms: fields and capabilities follow the legacy predicates ──

test("claude, cursor and copilot forms: fields by kind, in order", () => {
  const expectations: Record<string, Array<[string, string, boolean, boolean]>> = {
    claude: [
      ["provider", "select", true, false],
      ["apiUrl", "url", false, false],
      ["apiKey", "secret", false, false],
      ["model", "select", true, false],
      ["reasoningEffort", "derived_select", false, false],
      ["fastMode", "boolean", false, false],
      ["command", "text", false, true],
      ["envVars", "string_map", false, true],
    ],
    cursor: [
      ["model", "select", true, false],
      ["envVars", "string_map", false, true],
    ],
    copilot: [
      ["model", "select", true, false],
      ["reasoningEffort", "derived_select", false, false],
      ["envVars", "string_map", false, true],
    ],
  };
  for (const runtime of BATCH_3B) {
    const parsed = parseRuntimeFormV2(wire(buildRuntimeFormV2(runtime)));
    assert.ok(parsed, runtime);
    assert.deepEqual(parsed.fields.map((field) => [field.key, field.kind, field.required, field.advanced]), expectations[runtime], runtime);
    assert.deepEqual(parsed.blockingFieldKeys, [], runtime);
    assert.deepEqual(runtimeFormV2Entry(runtime)!.validateProjection(), [], runtime);
    // A v2-only form: the v1 routes and the admission row's v1 ref never see it.
    assert.equal(runtimeFormV1Entry(runtime), null, runtime);
  }
  // Claude's API URL and key show only for a Custom provider.
  const claude = parseRuntimeFormV2(wire(buildRuntimeFormV2("claude")))!;
  for (const key of ["apiUrl", "apiKey"]) {
    assert.deepEqual(claude.fields.find((field) => field.key === key)?.visibleWhen, [{ key: "provider", in: ["custom"] }], key);
  }
  assert.deepEqual((buildRuntimeFormV2("claude").capabilities as { writeOnlyPointers: string[] }).writeOnlyPointers, ["/apiKey"]);
});

test("each runtime declares exactly the capabilities its legacy form needs", () => {
  for (const runtime of BATCH_3B) {
    const form = buildRuntimeFormV2(runtime);
    const parsed = parseRuntimeFormV2(wire(form))!;
    const keys = parsed.fields.map((field) => field.key);
    const reasoning = REASONING_EFFORT_RUNTIMES.has(runtime);
    // Every runtime here has a Computer-probed model list.
    const expected = [
      ...(supportsRuntimeCustomModelName(runtime) ? ["select.custom_value"] : []),
      ...(reasoning ? ["choice.labels"] : []),
      "option_source.status",
    ];
    assert.deepEqual(form.requiredClientCapabilities, expected, runtime);
    assert.equal(keys.includes("reasoningEffort"), reasoning, `${runtime}: reasoning`);
    assert.equal(keys.includes("fastMode"), supportsRuntimeFastMode(runtime), `${runtime}: fast mode`);
    assert.equal(keys.includes("provider") && keys.includes("apiUrl") && keys.includes("apiKey"), supportsRuntimeApiUrl(runtime), `${runtime}: provider`);
    assert.equal(keys.includes("command"), supportsRuntimeCommand(runtime), `${runtime}: command`);
    const effort = parsed.fields.find((field) => field.key === "reasoningEffort");
    assert.deepEqual(effort?.choices, reasoning ? reasoningEffortChoices() : undefined, `${runtime}: effort labels`);
    if (effort) {
      assert.deepEqual(effort.derivedFrom, { key: "model", attribute: "supportedReasoningEfforts", defaultAttribute: "defaultReasoningEffort" });
    }
  }
  assert.deepEqual(buildRuntimeFormV2("claude").requiredClientCapabilities, ["select.custom_value", "choice.labels", "option_source.status"]);
  assert.deepEqual(buildRuntimeFormV2("cursor").requiredClientCapabilities, ["select.custom_value", "option_source.status"]);
  assert.deepEqual(buildRuntimeFormV2("copilot").requiredClientCapabilities, ["select.custom_value", "choice.labels", "option_source.status"]);
});

// ── Option sources ──

function sourceContext(detect: () => Promise<RuntimeModelSourceOutcome>, routing: "confirmed_local" | "handled" | "not_routed" = "confirmed_local", sourceId = "model") {
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
    routeToComputer: async () => {
      calls.push("route");
      return routing;
    },
  } as unknown as RuntimeFormOptionSourceContext;
  return { context, calls };
}

async function resolvedSource(runtime: string, detect: () => Promise<RuntimeModelSourceOutcome>, routing?: "confirmed_local" | "handled" | "not_routed") {
  const resolution = await runtimeFormV2Entry(runtime)!.resolveOptionSource(sourceContext(detect, routing).context);
  assert.equal(resolution.kind, "source");
  return wire((resolution as { source: unknown }).source);
}

/** Every probe outcome, with the reason and retryable the contract table assigns. */
const NON_LIVE_CASES: Array<[string, () => Promise<RuntimeModelSourceOutcome>, string, boolean, ("not_routed" | undefined)?]> = [
  ["missing_config", async () => ({ kind: "missing_config" }), "missing_config", false],
  ["no_models", async () => ({ kind: "no_models" }), "no_models", true],
  ["live but empty", async () => ({ kind: "live", value: { models: [] } }), "no_models", true],
  ["unsupported", async () => ({ kind: "unsupported" }), "unsupported", false],
  ["error detect_timeout", async () => ({ kind: "error", retryable: true, code: "detect_timeout" }), "probe_timeout", true],
  ["error computer_offline", async () => ({ kind: "error", retryable: true, code: "computer_offline" }), "machine_offline", true],
  ["error detect_failed", async () => ({ kind: "error", retryable: false, code: "detect_failed" }), "probe_failed", true],
  ["server wait timed out", async () => { throw new RouteFailureError("daemon_timeout", "timed out"); }, "probe_timeout", true],
  ["machine socket not ready", async () => { throw new RouteFailureError("daemon_offline", "offline"); }, "machine_offline", true],
  ["probe threw", async () => { throw new Error("boom"); }, "probe_failed", true],
  ["not routed to this replica", async () => { throw new Error("must not probe"); }, "machine_offline", true, "not_routed"],
];

const LIVE: RuntimeModelInfo[] = [
  { id: "live-a", label: "Live A", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" },
  { id: "live-b", label: "Live B" },
];

test("status per probe outcome for each runtime: live has no reason; every non-live outcome serves the bundled list with the table's reason and retryable", async () => {
  for (const runtime of BATCH_3B) {
    const live = await resolvedSource(runtime, async () => ({ kind: "live", value: { models: LIVE, default: "live-b" } }));
    assert.equal(live.status, "live", runtime);
    assert.equal("reason" in live, false, runtime);
    assert.equal("retryable" in live, false, runtime);
    assert.equal(live.defaultValue, "live-b", runtime);
    assert.equal(live.customValueAllowed, true, runtime);
    assert.deepEqual((live.options as Array<{ value: string }>).map((option) => option.value), ["live-a", "live-b"], runtime);

    for (const [label, detect, reason, retryable, routing] of NON_LIVE_CASES) {
      const source = await resolvedSource(runtime, detect, routing);
      assert.equal(source.status, "fallback", `${runtime} ${label}`);
      assert.equal(source.reason, reason, `${runtime} ${label}`);
      assert.equal(source.retryable, retryable, `${runtime} ${label}`);
      assert.equal(source.retryable, RUNTIME_FORM_V2_REASON_RETRYABLE[reason as keyof typeof RUNTIME_FORM_V2_REASON_RETRYABLE], `${runtime} ${label}`);
      assert.deepEqual(
        (source.options as Array<{ value: string }>).map((option) => option.value),
        RUNTIME_MODELS[runtime]!.map((model) => model.id),
        `${runtime} ${label}: the bundled list, as legacy offers (runtimeModelFallbackOptions)`,
      );
      assert.equal(source.defaultValue, RUNTIME_MODELS[runtime]![0]!.id, `${runtime} ${label}`);
    }
    const replayed = await runtimeFormV2Entry(runtime)!.resolveOptionSource(sourceContext(async () => { throw new Error("no"); }, "handled").context);
    assert.deepEqual(replayed, { kind: "handled" }, runtime);
  }
});

test("claude and copilot: the Computer's static catalog is served as a live list", async () => {
  for (const runtime of ["claude", "copilot"]) {
    const catalog = getStaticRuntimeModelSourceSet(runtime)!;
    const source = await resolvedSource(runtime, async () => ({ kind: "live", value: catalog }));
    assert.equal(source.status, "live");
    assert.deepEqual((source.options as Array<{ value: string }>).map((option) => option.value), catalog.models.map((model) => model.id));
  }
});

test("model options carry efforts exactly like the legacy picker where the runtime has a reasoning effort, and none for Cursor", async () => {
  for (const runtime of BATCH_3B) {
    for (const [models, source] of [
      [LIVE, await resolvedSource(runtime, async () => ({ kind: "live", value: { models: LIVE } }))],
      [RUNTIME_MODELS[runtime]!, await resolvedSource(runtime, async () => ({ kind: "missing_config" }))],
    ] as const) {
      for (const option of source.options as Array<{ value: string; supportedReasoningEfforts?: string[]; defaultReasoningEffort?: string }>) {
        if (!REASONING_EFFORT_RUNTIMES.has(runtime)) {
          assert.deepEqual(Object.keys(option), ["value", "label"], `${runtime} ${option.value}: no efforts`);
          continue;
        }
        const legacy = reasoningEffortOptionsForModel(runtime, option.value, models).map((effort) => effort.value);
        assert.deepEqual(option.supportedReasoningEfforts, legacy, `${runtime} ${option.value}`);
      }
    }
  }
  // Claude declares no efforts for its models: the BASE set, no default (task #496: never max/ultra).
  const claude = await resolvedSource("claude", async () => ({ kind: "unsupported" }));
  for (const option of claude.options as Array<{ supportedReasoningEfforts: string[]; defaultReasoningEffort?: string }>) {
    assert.deepEqual(option.supportedReasoningEfforts, [...BASE_REASONING_EFFORTS]);
    assert.equal("defaultReasoningEffort" in option, false);
  }
});

test("claude's provider source is static: Default/Custom, never probes, no status, no typed value", async () => {
  const { context, calls } = sourceContext(async () => { throw new Error("must not probe"); }, "confirmed_local", "provider");
  const resolution = await runtimeFormV2Entry("claude")!.resolveOptionSource(context);
  assert.equal(resolution.kind, "source");
  const source = wire((resolution as { source: unknown }).source);
  assert.deepEqual(calls, []);
  assert.deepEqual(source.options, [{ value: "default", label: "Default" }, { value: "custom", label: "Custom" }]);
  assert.equal(source.defaultValue, "default");
  assert.equal(source.pointer, "/provider");
  assert.equal("status" in source, false);
  assert.equal(source.customValueAllowed, false);
  // Cursor and Copilot have no provider source.
  for (const runtime of ["cursor", "copilot"]) {
    const other = await runtimeFormV2Entry(runtime)!.resolveOptionSource(sourceContext(async () => { throw new Error("no"); }, "confirmed_local", "provider").context);
    assert.deepEqual(other, { kind: "source", source: null }, runtime);
  }
});

// ── Submit: the legacy runtimeConfig ──

function legacy(runtime: string, input: {
  model: string;
  custom?: boolean;
  fast?: boolean;
  effort?: ReasoningEffort | null;
  envVars?: Record<string, string> | null;
  provider?: { apiUrl: string; apiKey: string };
  command?: string;
}) {
  return buildRuntimeConfig({
    runtime,
    model: input.model,
    customModelMode: input.custom === true,
    customModelName: input.custom ? input.model : undefined,
    providerMode: input.provider ? "custom" : "default",
    providerApiUrl: input.provider?.apiUrl ?? "",
    providerApiKey: input.provider?.apiKey ?? "",
    fastMode: input.fast === true,
    reasoningEffort: input.effort ?? null,
    envVars: input.envVars ?? null,
    command: input.command ?? "",
  });
}

function submitted(runtime: string, values: Record<string, unknown>, options: Parameters<typeof buildRuntimeConfigFromFormValues>[2] = {}) {
  const built = buildRuntimeConfigFromFormValues(runtime, values, options);
  assert.ok(built.ok, JSON.stringify(built));
  return built.runtimeConfig;
}

function assertSameAsLegacy(v2: Record<string, unknown>, expected: RuntimeConfig, message: string) {
  const parsed = parseRuntimeConfig({ runtimeConfig: v2 });
  assert.ok(parsed.ok, `${message}: ${parsed.ok ? "" : parsed.error}`);
  assert.equal(JSON.stringify(parsed.config), JSON.stringify(expected), message);
}

test("claude, cursor and copilot: v2 values assemble exactly the legacy runtimeConfig", () => {
  const cases: Array<[string, Record<string, unknown>, Parameters<typeof legacy>[1]]> = [
    ["claude", { provider: "default", model: "sonnet", reasoningEffort: "high", fastMode: true, command: "", envVars: { K: "v" } }, { model: "sonnet", effort: "high", fast: true, envVars: { K: "v" } }],
    ["claude", { provider: "default", model: "opus", reasoningEffort: null, fastMode: false, command: " /opt/claude " }, { model: "opus", command: "/opt/claude" }],
    ["claude", { provider: "custom", apiUrl: " https://gw.example.test ", apiKey: " sk-1 ", model: "claude-opus-5-5", reasoningEffort: "" }, { model: "claude-opus-5-5", provider: { apiUrl: "https://gw.example.test", apiKey: "sk-1" } }],
    // Custom model: a typed value that is not listed.
    ["claude", { provider: "default", model: "vendor/private-model", reasoningEffort: "low" }, { model: "vendor/private-model", custom: true, effort: "low" }],
    // A hidden field's stale value (API URL under Default) is ignored, like legacy.
    ["claude", { provider: "default", apiUrl: "https://stale.example.test", apiKey: "stale", model: "haiku" }, { model: "haiku" }],
    ["cursor", { model: "composer-2", envVars: { C: "1" } }, { model: "composer-2", envVars: { C: "1" } }],
    ["cursor", { model: "my-org/cursor-custom" }, { model: "my-org/cursor-custom", custom: true }],
    ["copilot", { model: "gpt-5.4", reasoningEffort: "xhigh" }, { model: "gpt-5.4", effort: "xhigh" }],
    ["copilot", { model: "vendor/copilot-custom", reasoningEffort: "medium" }, { model: "vendor/copilot-custom", custom: true, effort: "medium" }],
  ];
  for (const [runtime, values, legacyInput] of cases) {
    assertSameAsLegacy(submitted(runtime, values), legacy(runtime, legacyInput), `${runtime} ${JSON.stringify(values)}`);
  }
  // Stray values of fields a form does not have are ignored (legacy never sends them for these runtimes).
  assertSameAsLegacy(submitted("cursor", { model: "auto", reasoningEffort: "high", fastMode: true, command: "x" }), legacy("cursor", { model: "auto" }), "cursor strays");
  assertSameAsLegacy(submitted("copilot", { model: "gpt-5.2", fastMode: true, command: "x" }), legacy("copilot", { model: "gpt-5.2" }), "copilot strays");
});

test("edit values round-trip the stored config; the API key is never part of the values", () => {
  const stored: RuntimeConfig[] = [
    legacy("claude", { model: "sonnet", effort: "high", fast: true, envVars: { KEEP: "1" }, command: "/opt/claude", provider: { apiUrl: "https://gw.example.test", apiKey: "sk-stored" } }),
    legacy("claude", { model: "vendor/private-model", custom: true }),
    legacy("cursor", { model: "my-org/cursor-custom", custom: true, envVars: { C: "1" } }),
    legacy("copilot", { model: "gpt-5.4", effort: "low" }),
  ];
  for (const config of stored) {
    const values = runtimeFormValuesFromRuntimeConfig(config);
    assert.ok(values, config.runtime);
    assert.equal(JSON.stringify(values).includes("sk-stored"), false, config.runtime);
    assert.equal("apiKey" in values, false, config.runtime);
    // Saving the values unchanged (the key left blank) stores the same config once the PATCH path restores the key.
    const saved = retainOmittedWriteOnlySecrets(submitted(config.runtime, { ...values, apiKey: "" }, { editing: true, existing: config }), config);
    assertSameAsLegacy(saved as Record<string, unknown>, config, JSON.stringify(config));
  }
  assert.deepEqual(runtimeFormValuesFromRuntimeConfig(stored[0]!), {
    provider: "custom", apiUrl: "https://gw.example.test", model: "sonnet", reasoningEffort: "high", fastMode: true, command: "/opt/claude", envVars: { KEEP: "1" },
  });
  assert.deepEqual(runtimeFormValuesFromRuntimeConfig(stored[1]!), {
    provider: "default", model: "vendor/private-model", reasoningEffort: "", fastMode: false, command: "", envVars: {},
  });
  assert.deepEqual(runtimeFormValuesFromRuntimeConfig(stored[2]!), { model: "my-org/cursor-custom", envVars: { C: "1" } });
  assert.deepEqual(runtimeFormValuesFromRuntimeConfig(stored[3]!), { model: "gpt-5.4", reasoningEffort: "low", envVars: {} });
});

test("submit errors point at the field", () => {
  const issue = (runtime: string, values: Record<string, unknown>, options: Parameters<typeof buildRuntimeConfigFromFormValues>[2] = {}) => {
    const built = buildRuntimeConfigFromFormValues(runtime, values, options);
    return built.ok ? null : built.issue;
  };
  for (const runtime of BATCH_3B) {
    assert.deepEqual(issue(runtime, { provider: "default", model: " " }), { code: "model_required", pointer: "/formValues/model" }, runtime);
  }
  assert.deepEqual(issue("copilot", { model: "m", reasoningEffort: 3 }), { code: "invalid_reasoning_effort", pointer: "/formValues/reasoningEffort" });
  assert.deepEqual(issue("claude", { provider: "default", model: "m", fastMode: "yes" }), { code: "invalid_boolean", pointer: "/formValues/fastMode" });
  assert.deepEqual(issue("claude", { provider: "default", model: "m", command: 7 }), { code: "invalid_command", pointer: "/formValues/command" });
  for (const provider of [undefined, "", "gateway", 1]) {
    assert.deepEqual(issue("claude", { provider, model: "m" }), { code: "select_valid_provider", pointer: "/formValues/provider" }, String(provider));
  }
  assert.deepEqual(issue("claude", { provider: "custom", apiUrl: "gw.example.test", apiKey: "k", model: "m" }), { code: "api_url_invalid", pointer: "/formValues/apiUrl" });
  // Create: a Custom provider needs a key.
  assert.deepEqual(issue("claude", { provider: "custom", apiUrl: "https://gw.example.test", apiKey: " ", model: "m" }), { code: "api_key_required", pointer: "/formValues/apiKey" });
  // Post-assembly issues map back to the field.
  assert.equal(formValuesPointerForRuntimeConfigPointer("claude", "/runtimeConfig/provider/apiUrl"), "/formValues/apiUrl");
  assert.equal(formValuesPointerForRuntimeConfigPointer("claude", "/runtimeConfig/provider/apiKey"), "/formValues/apiKey");
  assert.equal(formValuesPointerForRuntimeConfigPointer("claude", "/runtimeConfig/command"), "/formValues/command");
});

// ── Claude's API key is write-only ──

const claudeCustom = (apiUrl: string, apiKey: string) => legacy("claude", { model: "sonnet", provider: { apiUrl, apiKey } });

test("edit with a blank API key keeps the stored key only while the API URL is unchanged", () => {
  const stored = claudeCustom("https://gw.example.test", "sk-stored");
  const values = { provider: "custom", apiUrl: " https://gw.example.test ", apiKey: "", model: "opus" };
  const built = submitted("claude", values, { editing: true, existing: stored });
  assert.deepEqual(built.provider, { kind: "custom", apiUrl: "https://gw.example.test" }, "the key is omitted, not blank");
  const kept = retainOmittedWriteOnlySecrets(built, stored) as { provider: Record<string, unknown> };
  assert.equal(kept.provider.apiKey, "sk-stored");

  const issue = (options: Parameters<typeof buildRuntimeConfigFromFormValues>[2], override: Record<string, unknown> = {}) => {
    const result = buildRuntimeConfigFromFormValues("claude", { ...values, ...override }, options);
    return result.ok ? null : result.issue;
  };
  const keyRequired = { code: "api_key_required", pointer: "/formValues/apiKey" };
  assert.deepEqual(issue({ editing: true, existing: stored }, { apiUrl: "https://other.example.test" }), keyRequired, "another endpoint");
  assert.deepEqual(issue({ editing: true, existing: legacy("claude", { model: "sonnet" }) }), keyRequired, "stored provider is Default");
  assert.deepEqual(issue({ editing: true, existing: legacy("codex", { model: "gpt-5.5" }) }), keyRequired, "another runtime");
  assert.deepEqual(issue({ editing: false, existing: stored }), keyRequired, "create never inherits");
  // A typed key replaces the stored one.
  const replaced = retainOmittedWriteOnlySecrets(submitted("claude", { ...values, apiKey: "sk-new" }, { editing: true, existing: stored }), stored) as { provider: Record<string, unknown> };
  assert.equal(replaced.provider.apiKey, "sk-new");
  // The v1 PATCH path: an omitted key is restored only for the same endpoint.
  const v1Moved = retainOmittedWriteOnlySecrets({ ...stored, provider: { kind: "custom", apiUrl: "https://other.example.test" } }, stored) as { provider: Record<string, unknown> };
  assert.equal("apiKey" in v1Moved.provider, false);
});

test("v1 agent reads keep Claude's key for released clients (redactOnAgentRead: false); Built-in's stays blanked", () => {
  // Installed mobile apps prefill the Claude custom-provider key from GET
  // /api/agents/:id and refuse to save a blank one; see CLAUDE_CUSTOM_PROVIDER_API_KEY.
  const stored = claudeCustom("https://gw.example.test", "sk-stored");
  assert.equal(redactWriteOnlyRuntimeConfig(stored), stored);
  assert.deepEqual(runtimeFormV2Entry("claude")!.writeOnlySecrets?.map((secret) => [secret.path, secret.redactOnAgentRead]), [[["provider", "apiKey"], false]]);
  assert.equal(runtimeFormV2Entry("cursor")!.writeOnlySecrets, undefined);
  assert.equal(runtimeFormV2Entry("copilot")!.writeOnlySecrets, undefined);
});

// ── Submit: the live model list ──

async function reconcile(runtime: string, values: Record<string, unknown>, models: RuntimeModelInfo[]) {
  const parsed = parseRuntimeConfig({ runtimeConfig: submitted(runtime, values) });
  assert.ok(parsed.ok);
  return reconcileRuntimeFormV2SubmissionWithLiveModels({
    runtimeConfig: parsed.config,
    submittedReasoningEffort: values.reasoningEffort ?? null,
    machineId: "machine-1",
    detect: async () => ({ kind: "live", value: { models } }),
  });
}

test("a model only the live list names is stored as a preset; efforts follow the live option", async () => {
  // Cursor: no effort to decide, only the model kind.
  const cursor = await reconcile("cursor", { model: "cursor-live-only" }, [{ id: "cursor-live-only", label: "Live" }]);
  assert.equal(cursor.kind, "updated");
  assert.deepEqual((cursor as { runtimeConfig: RuntimeConfig }).runtimeConfig.model, { kind: "preset", id: "cursor-live-only" });
  assert.equal((cursor as { runtimeConfig: RuntimeConfig }).runtimeConfig.reasoningEffort, null);
  assert.deepEqual(await reconcile("cursor", { model: "my-org/unlisted" }, [{ id: "other", label: "Other" }]), { kind: "unchanged" });
  // Copilot: a live-declared effort is kept, an undeclared one refused.
  const copilot = await reconcile("copilot", { model: "copilot-live", reasoningEffort: "max" }, [{ id: "copilot-live", label: "Live", supportedReasoningEfforts: ["max"] }]);
  assert.equal(copilot.kind, "updated");
  assert.equal((copilot as { runtimeConfig: RuntimeConfig }).runtimeConfig.reasoningEffort, "max");
  assert.deepEqual(
    await reconcile("copilot", { model: "gpt-5.4", reasoningEffort: "high" }, [{ id: "gpt-5.4", label: "GPT-5.4", supportedReasoningEfforts: ["low"] }]),
    { kind: "rejected", issue: { code: "reasoning_effort_not_supported", pointer: "/formValues/reasoningEffort" } },
  );
  // Claude: the reconciled config keeps the provider and command.
  const claude = await reconcile("claude", { provider: "custom", apiUrl: "https://gw.example.test", apiKey: "sk", model: "claude-live", reasoningEffort: "low", command: "/opt/claude" }, [{ id: "claude-live", label: "Live" }]);
  assert.equal(claude.kind, "updated");
  const claudeConfig = (claude as { runtimeConfig: RuntimeConfig & { command?: string } }).runtimeConfig;
  assert.deepEqual(claudeConfig.provider, { kind: "custom", apiUrl: "https://gw.example.test", apiKey: "sk" });
  assert.equal(claudeConfig.command, "/opt/claude");
  assert.deepEqual(claudeConfig.model, { kind: "preset", id: "claude-live" });
  assert.equal(claudeConfig.reasoningEffort, "low");
});
