/**
 * Runtime form protocol v2: one registry entry per runtime that has a v2 form
 * (packages/runtime-form/README.md, "Protocol v2").
 *
 * An entry owns everything the server needs to serve and accept that runtime's
 * v2 form: the definition, its option sources, the mapping between a stored
 * runtimeConfig and form values (both directions), and which runtimeConfig
 * values are write-only secrets. The v2 routes, GET /api/agents/:id/runtime-form
 * and the v2 submit path consult only this registry, so giving a runtime a v2
 * form means adding an entry here and nothing else.
 *
 * Being registered here does not make a runtime visible to v1 clients: the v1
 * definition routes and `formDefinitionRef` on the runtime admission row stay
 * on the frozen v1 set in runtimeFormDefinitionService. The admission row
 * carries a separate `runtimeFormV2` marker for every registered runtime.
 */
import {
  toRuntimeFormV2,
  type RuntimeFormV2ChoiceCopy,
  type RuntimeFormV2ClientCapability,
  type RuntimeFormV2Definition,
  type RuntimeFormV2OptionSourceReason,
  type RuntimeFormV2OptionSourceStatus,
  type RuntimeFormV2SubmitRef,
} from "@botiverse/raft-runtime-form";
import {
  BASE_REASONING_EFFORTS,
  getDefaultModel,
  getRuntimeProviderDisplayName,
  isRuntimeDeprecated,
  PI_BUILTIN_PROVIDER_DEFAULT_MODELS,
  PI_BUILTIN_PROVIDER_ENV_KEYS,
  PI_BUILTIN_PROVIDER_MODELS,
  REASONING_EFFORTS,
  RUNTIME_CONFIG_VERSION,
  RUNTIME_MODELS,
  type AgentCreateFormIssue,
  type AgentCreateFormOption,
  type AgentCreateFormOptionSource,
  type RuntimeConfig,
  type RuntimeFormV2Marker,
  type RuntimeModelInfo,
  type RuntimeModelSourceOutcome,
} from "@botiverse/raft-shared";

import type { MachineLocalRoutingResult } from "../machineLocalReplay";
import { RouteFailureError } from "../tracing/routeFailure";
import type { AgentOrchestrator } from "./agentOrchestrator";
import {
  BuiltInModelCatalogError,
  filterBuiltInPiFormOptionSourceForCatalog,
  requireBuiltInCatalogCapability,
} from "./builtinModelCatalogCompatibility";
import {
  buildBuiltInPiFormDefinition,
  buildBuiltInPiFormOptionSource,
  buildKimiSdkFormDefinition,
  buildKimiSdkFormOptionSource,
  validateBuiltInPiDefinitionProjection,
  validateKimiSdkDefinitionProjection,
} from "./runtimeFormDefinitionService";
import {
  optionSourceReasonForOutcome,
  optionSourceReasonForProbeError,
  optionSourceStatusFields,
} from "./runtimeFormV2SourceStatus";

export const RUNTIME_FORM_V2_MARKER: RuntimeFormV2Marker = Object.freeze({ protocolVersion: 2 });

export interface RuntimeFormOptionSourceContext {
  sourceId: string;
  machineId: string;
  machine: { daemonVersion?: string | null; computerVersion?: string | null };
  /**
   * `?refresh=1` on the v2 endpoint (a client's retry, `option_source.status`):
   * bypass any cache. The server keeps no option-source cache today, so every
   * request already probes the Computer (whose probe gate single-flights);
   * an entry that ever caches must honour this.
   */
  refresh?: boolean;
  agentOrchestrator: Pick<AgentOrchestrator, "detectMachineRuntimeModels" | "detectMachineRuntimeModelsWithAuthority">;
  /**
   * Machine-affinity routing: make sure this replica owns the Computer's
   * socket, replaying the request to the owner otherwise. "handled" means a
   * response was already sent.
   */
  routeToComputer(): Promise<MachineLocalRoutingResult>;
}

/**
 * An option-source response body. The additive fields are sent only to forms
 * that list the matching capability: `customValueAllowed` (`select.custom_value`)
 * and `status`/`reason`/`retryable` (`option_source.status`).
 */
export type RuntimeFormV2OptionSourceBody = AgentCreateFormOptionSource & {
  customValueAllowed?: boolean;
  status?: RuntimeFormV2OptionSourceStatus;
  reason?: RuntimeFormV2OptionSourceReason;
  retryable?: boolean;
};

export type RuntimeFormOptionSourceResolution =
  /** null: the runtime has no source by that id (404 unknown_option_source). */
  | { kind: "source"; source: RuntimeFormV2OptionSourceBody | null }
  /** The response was already sent (replayed to another replica). */
  | { kind: "handled" }
  | { kind: "reply"; status: number; body: Record<string, unknown> };

export type FormValuesBuildResult =
  | { ok: true; runtimeConfig: Record<string, unknown>; formDefinitionRef: RuntimeFormV2SubmitRef }
  | { ok: false; issue: AgentCreateFormIssue };

type RuntimeConfigBuild =
  | { ok: true; runtimeConfig: Record<string, unknown> }
  | { ok: false; issue: AgentCreateFormIssue };

/** A runtimeConfig value the server keeps but never sends to a client. */
export interface RuntimeConfigWriteOnlySecret {
  /** Where the secret sits in runtimeConfig, e.g. ["provider", "apiKey"]. */
  path: readonly [string, ...string[]];
  /**
   * An update that omits the secret keeps the stored one only while it would
   * still authenticate the same thing (same provider, same endpoint, ...).
   */
  keepsIdentity(incoming: Record<string, unknown>, existing: Record<string, unknown>): boolean;
  /**
   * Whether this stored config carries the secret at all. Where it does, reads
   * always show the key as "" (present, blank), matching the pre-registry
   * output for released clients even when nothing is stored.
   */
  appliesTo(config: Record<string, unknown>): boolean;
  /**
   * Whether the v1 agent read (withAgentProjection: GET /api/agents and
   * /api/agents/:id) blanks it too. Default true. False only where released
   * clients read the secret back from that response to save it again; the v2
   * edit values never carry it either way.
   */
  redactOnAgentRead?: boolean;
}

export interface RuntimeFormValuesOptions {
  editing?: boolean;
  /**
   * Edit only: the agent's stored runtimeConfig, for values the form does not
   * show but the saved config keeps (Antigravity's model).
   */
  existing?: RuntimeConfig | null;
}

export interface RuntimeFormV2Entry {
  runtimeId: string;
  /** The form served on v2 create, and the base of the v2 edit response. */
  buildForm(): RuntimeFormV2Definition;
  /** Self-check of the served projection; any issue is a 500 drift. */
  validateProjection(): AgentCreateFormIssue[];
  resolveOptionSource(context: RuntimeFormOptionSourceContext): Promise<RuntimeFormOptionSourceResolution>;
  /**
   * Submitted field values → runtimeConfig. `envVars` is already read from the
   * values. The result then goes through the same validation as any request.
   */
  runtimeConfigFromValues(
    values: Record<string, unknown>,
    envVars: Record<string, string> | null,
    options: RuntimeFormValuesOptions,
  ): RuntimeConfigBuild;
  /** Stored runtimeConfig → field values for edit; writeOnly fields never included. Null: not editable here. */
  valuesFromRuntimeConfig(runtimeConfig: Record<string, unknown>): Record<string, unknown> | null;
  writeOnlySecrets?: readonly RuntimeConfigWriteOnlySecret[];
  /**
   * v2 submit only: reconcile the validated runtimeConfig with the Computer's
   * live model list (reconcileRuntimeFormV2SubmissionWithLiveModels). Absent:
   * the static validation is final.
   */
  reconcileWithLiveModels?(
    runtimeConfig: RuntimeConfig,
    submittedReasoningEffort: string | null,
    models: readonly RuntimeModelInfo[],
  ): LiveModelReconciliation;
}

export type LiveModelReconciliation =
  | { kind: "unchanged" }
  | { kind: "updated"; runtimeConfig: RuntimeConfig }
  | { kind: "rejected"; issue: AgentCreateFormIssue };

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const formValueIssue = (code: string, key: string): RuntimeConfigBuild =>
  ({ ok: false, issue: { code, pointer: `/formValues/${key}` } });

function readEnvVars(value: unknown): Record<string, string> | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isPlainRecord(value)) return undefined;
  const entries = Object.entries(value).filter(([key]) => key.trim() !== "");
  if (entries.some(([, item]) => typeof item !== "string")) return undefined;
  return entries.length > 0 ? Object.fromEntries(entries) as Record<string, string> : null;
}

function modelValueOf(runtimeConfig: Record<string, unknown>): string {
  const model = isPlainRecord(runtimeConfig.model) ? runtimeConfig.model : {};
  return typeof model.id === "string" ? model.id : typeof model.name === "string" ? model.name : "";
}

const envVarsOf = (runtimeConfig: Record<string, unknown>) =>
  isPlainRecord(runtimeConfig.envVars) ? runtimeConfig.envVars : {};

const builtinEntry: RuntimeFormV2Entry = {
  runtimeId: "builtin",
  // v2-only copy lives here, never in the v1 definition: changing that would
  // force a schemaVersion bump that breaks every installed app still on v1
  // (packages/runtime-form/README.md, "Bumping a version"). Only v2 clients
  // show a hint under the Built-in Pi model field.
  buildForm() {
    const form = toRuntimeFormV2(buildBuiltInPiFormDefinition());
    const uiSchema = form.uiSchema ?? {};
    const localization = uiSchema.localization ?? {};
    localization.model = {
      ...localization.model,
      hint: "Use a model ID the selected provider supports.",
    };
    uiSchema.localization = localization;
    form.uiSchema = uiSchema;
    return form;
  },
  validateProjection: () => validateBuiltInPiDefinitionProjection(),
  async resolveOptionSource(context) {
    const routing = await context.routeToComputer();
    if (routing === "handled") return { kind: "handled" };
    if (routing !== "confirmed_local") {
      return {
        kind: "reply",
        status: 409,
        body: {
          error: "The target Computer's Built-in model catalog is unavailable",
          code: "builtin_catalog_unavailable",
          recovery: "retry",
        },
      };
    }
    let detection;
    try {
      detection = await context.agentOrchestrator.detectMachineRuntimeModelsWithAuthority(context.machineId, "builtin");
    } catch (error) {
      if (!(error instanceof RouteFailureError)) throw error;
      throw new BuiltInModelCatalogError(
        "builtin_catalog_unavailable",
        "The target Computer's Built-in model catalog is unavailable. Retry after the Computer reconnects.",
        {
          daemonVersion: context.machine.daemonVersion ?? null,
          computerVersion: context.machine.computerVersion ?? null,
          recovery: "retry",
        },
      );
    }
    const catalog = requireBuiltInCatalogCapability(detection.outcome, {
      machineId: context.machineId,
      daemonVersion: detection.daemonVersion,
      computerVersion: detection.computerVersion,
    });
    const unfilteredSource = buildBuiltInPiFormOptionSource(context.sourceId);
    return {
      kind: "source",
      source: unfilteredSource
        ? filterBuiltInPiFormOptionSourceForCatalog(unfilteredSource, catalog.supportedModelIds)
        : null,
    };
  },
  runtimeConfigFromValues(values, envVars, options) {
    const provider = buildBuiltInPiFormOptionSource("provider");
    const model = buildBuiltInPiFormOptionSource("model");
    if (provider?.kind !== "select" || model?.kind !== "dependent_select") {
      return { ok: false, issue: { code: "option_sources_invalid", pointer: "/formValues" } };
    }
    const providerId = typeof values.providerId === "string" ? values.providerId : "";
    const option = provider.options.find((candidate) => candidate.value === providerId);
    if (!option) return formValueIssue("select_valid_provider", "providerId");
    const apiKey = typeof values.apiKey === "string" ? values.apiKey.trim() : "";
    // writeOnly fields are never sent to a client, so on edit a blank one means
    // "keep the stored value"; the PATCH path retains it (and refuses when the
    // provider changed). This follows capabilities.writeOnlyPointers, not the name.
    const apiKeyMayBeBlank = options.editing === true
      && buildBuiltInPiFormDefinition().capabilities.writeOnlyPointers.includes("/apiKey");
    if (!apiKey && !apiKeyMayBeBlank) return formValueIssue("api_key_required", "apiKey");
    const modelValue = typeof values.model === "string" ? values.model.trim() : "";
    if (!modelValue) return formValueIssue("model_required", "model");
    const customModel = model.customValueAllowedByValue[providerId] === true;
    if (!customModel && !(model.optionsByValue[providerId] ?? []).some((candidate) => candidate.value === modelValue)) {
      return formValueIssue("select_valid_provider_model", "model");
    }
    const gateway = option.providerKind === "gateway";
    const baseUrl = typeof values.baseUrl === "string" ? values.baseUrl.trim() : "";
    if (gateway && !/^https?:\/\//i.test(baseUrl)) return formValueIssue("base_url_invalid", "baseUrl");
    return {
      ok: true,
      runtimeConfig: {
        version: RUNTIME_CONFIG_VERSION,
        runtime: "builtin",
        provider: gateway
          ? { kind: "gateway", providerId, baseUrl, ...(apiKey ? { apiKey } : {}), supportsImageInput: values.supportsImageInput === true }
          : { kind: "preset", providerId, ...(apiKey ? { apiKey } : {}) },
        model: customModel ? { kind: "custom", name: modelValue } : { kind: "preset", id: modelValue },
        mode: { kind: "default" },
        reasoningEffort: null,
        envVars,
        hostUserState: "forbidden",
        loadLocalPlugins: values.loadLocalPlugins === true,
      },
    };
  },
  valuesFromRuntimeConfig(runtimeConfig) {
    const provider = isPlainRecord(runtimeConfig.provider) ? runtimeConfig.provider : null;
    // Managed provider connections have no v2 form yet.
    if (!provider || (provider.kind !== "preset" && provider.kind !== "gateway")) return null;
    return {
      providerId: typeof provider.providerId === "string" ? provider.providerId : "",
      ...(provider.kind === "gateway"
        ? { baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : "", supportsImageInput: provider.supportsImageInput === true }
        : {}),
      model: modelValueOf(runtimeConfig),
      loadLocalPlugins: runtimeConfig.loadLocalPlugins === true,
      envVars: envVarsOf(runtimeConfig),
    };
  },
  writeOnlySecrets: [
    {
      // Omitting the provider secret keeps it only while runtime, provider kind,
      // provider id and (for a gateway) base URL are unchanged. Explicit
      // blank/null values and provider switches still reach the parser and fail
      // closed; clients can never recover the retained value.
      path: ["provider", "apiKey"],
      appliesTo: (config) => isPlainRecord(config.provider) && config.provider.kind !== "connection",
      keepsIdentity(incoming, existing) {
        const next = incoming.provider as Record<string, unknown>;
        const saved = existing.provider as Record<string, unknown>;
        if (next.kind === "connection" || saved.kind === "connection") return false;
        if (next.kind !== saved.kind || next.providerId !== saved.providerId) return false;
        return saved.kind !== "gateway"
          || (typeof next.baseUrl === "string" && typeof saved.baseUrl === "string" && next.baseUrl.trim() === saved.baseUrl.trim());
      },
    },
  ],
};

const kimiSdkEntry: RuntimeFormV2Entry = {
  runtimeId: "kimi-sdk",
  buildForm: () => toRuntimeFormV2(buildKimiSdkFormDefinition()),
  validateProjection: () => validateKimiSdkDefinitionProjection(),
  async resolveOptionSource(context) {
    if (context.sourceId !== "model") return { kind: "source", source: null };
    const routing = await context.routeToComputer();
    if (routing === "handled") return { kind: "handled" };
    if (routing !== "confirmed_local") {
      return {
        kind: "reply",
        status: 409,
        body: {
          error: "Computer is offline",
          issues: [{ code: "runtime_model_source_unavailable", pointer: "/optionSources/model" }],
        },
      };
    }
    const detected = await context.agentOrchestrator.detectMachineRuntimeModels(context.machineId, "kimi-sdk");
    if (detected.kind === "missing_config") {
      // Normal first-install shape: the machine has no ~/.kimi-code/config.toml
      // yet because nothing has been provisioned. The reviewed product
      // contract already allows creation in this state (it may still fail at
      // runtime, where the user can actually fix it); the form must not
      // hard-block it. Offer the declared managed default for missing_config
      // only — every other non-live outcome keeps its typed 409 (this is the
      // hard failure users saw as "model list unavailable" on fresh machines).
      return {
        kind: "source",
        source: buildKimiSdkFormOptionSource({
          models: RUNTIME_MODELS["kimi-sdk"] ?? [],
          defaultModel: getDefaultModel("kimi-sdk"),
        }),
      };
    }
    if (detected.kind !== "live") {
      return {
        kind: "reply",
        status: 409,
        body: {
          error: "Kimi model source is unavailable",
          issues: [{ code: `runtime_model_source_${detected.kind}`, pointer: "/optionSources/model" }],
        },
      };
    }
    return {
      kind: "source",
      source: buildKimiSdkFormOptionSource({ models: detected.value.models, defaultModel: detected.value.default }),
    };
  },
  runtimeConfigFromValues(values, envVars) {
    const modelValue = typeof values.model === "string" ? values.model.trim() : "";
    if (!modelValue) return formValueIssue("model_required", "model");
    const effort = values.reasoningEffort;
    if (effort !== undefined && effort !== null && typeof effort !== "string") {
      return formValueIssue("invalid_reasoning_effort", "reasoningEffort");
    }
    return {
      ok: true,
      runtimeConfig: {
        version: RUNTIME_CONFIG_VERSION,
        runtime: "kimi-sdk",
        model: { kind: "preset", id: modelValue },
        mode: { kind: "default" },
        reasoningEffort: typeof effort === "string" && effort !== "" ? effort : null,
        envVars,
      },
    };
  },
  valuesFromRuntimeConfig: (runtimeConfig) => ({
    model: modelValueOf(runtimeConfig),
    reasoningEffort: typeof runtimeConfig.reasoningEffort === "string" ? runtimeConfig.reasoningEffort : "",
    envVars: envVarsOf(runtimeConfig),
  }),
};

/**
 * v2-only forms for runtimes the legacy web form handles with just a model
 * picker and environment variables. There is no v1 form for them: the label
 * `schemaVersion` only names the form the server built.
 */
function simpleFormRef(runtimeId: string) {
  return { protocolVersion: 1 as const, runtimeId, schemaVersion: `${runtimeId}.${isRuntimeDeprecated(runtimeId) ? "edit" : "create"}.v1` };
}

function buildSimpleForm(runtimeId: string, model: { hint?: string } | null): RuntimeFormV2Definition {
  const ref = simpleFormRef(runtimeId);
  return toRuntimeFormV2({
    ...ref,
    dataSchema: {
      type: "object",
      additionalProperties: false,
      required: model ? ["model"] : [],
      properties: {
        ...(model ? { model: { type: "string", title: "Model", minLength: 1 } } : {}),
        envVars: { type: "object", title: "Environment Variables", additionalProperties: { type: "string" } },
      },
    },
    uiSchema: {
      order: model ? ["model", "envVars"] : ["envVars"],
      layout: { advanced: ["/envVars"] },
      visibility: [],
      localization: {
        ...(model ? { model: { label: "Model", ...(model.hint ? { hint: model.hint } : {}) } } : {}),
        envVars: { label: "Environment Variables", hint: "These will be injected into the runtime command environment." },
      },
    },
    capabilities: { providerKinds: [], writeOnlyPointers: [], forbiddenPointers: ["/hostUserState"] },
    optionSources: model ? { model: { ...ref, sourceId: "model", kind: "select", pointer: "/model" } } : {},
  }, {});
}

/** The model select built from a list of models (live, or the bundled RUNTIME_MODELS fallback). */
function modelSelectOptionSource(
  runtimeId: string,
  models: readonly { id: string; label: string }[],
  defaultModel: string | undefined,
): AgentCreateFormOptionSource {
  const options = models.map((model) => ({ value: model.id, label: model.label }));
  return {
    ...simpleFormRef(runtimeId),
    sourceId: "model",
    kind: "select",
    pointer: "/model",
    options,
    defaultValue: defaultModel && options.some((option) => option.value === defaultModel)
      ? defaultModel
      : (options[0]?.value ?? ""),
  };
}

/**
 * The select a live-probed runtime serves when its probe is not live: the
 * bundled RUNTIME_MODELS list, which is what the legacy web form offers in that
 * state. An empty list is an empty select; submitting then fails with
 * model_required on /formValues/model.
 */
export function staticModelFallbackOptionSource(
  runtimeId: string,
  models: readonly { id: string; label: string }[] = RUNTIME_MODELS[runtimeId] ?? [],
): AgentCreateFormOptionSource {
  return modelSelectOptionSource(runtimeId, models, undefined);
}

function simpleProjectionIssues(form: RuntimeFormV2Definition, hasModel: boolean): AgentCreateFormIssue[] {
  const properties = Object.keys(form.dataSchema.properties).sort().join("\0");
  const expected = (hasModel ? ["envVars", "model"] : ["envVars"]).join("\0");
  const sources = Object.keys(form.optionSources ?? {}).join("\0");
  if (properties !== expected || (form.dataSchema.required ?? []).join("\0") !== (hasModel ? "model" : "")) {
    return [{ code: "definition_data_schema_drift", pointer: "/dataSchema" }];
  }
  if (sources !== (hasModel ? "model" : "") || (hasModel && form.optionSources?.model?.pointer !== "/model")) {
    return [{ code: "definition_option_source_topology_drift", pointer: "/optionSources" }];
  }
  return [];
}

/** The legacy web builder's shape for a runtime without provider, fast mode, reasoning or command. */
function simpleRuntimeConfig(runtimeId: string, model: Record<string, unknown>, envVars: Record<string, string> | null) {
  return {
    version: RUNTIME_CONFIG_VERSION,
    runtime: runtimeId,
    model,
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars,
  };
}

/**
 * A runtime whose form is a model select plus environment variables. `live`:
 * options come from the Computer's model probe and fall back to the bundled
 * list whenever the probe is not live; otherwise the bundled list is the source.
 */
function modelFormEntry(runtimeId: string, options: { live: boolean; hint?: string }): RuntimeFormV2Entry {
  return {
    runtimeId,
    buildForm: () => buildSimpleForm(runtimeId, { hint: options.hint }),
    validateProjection: () => simpleProjectionIssues(buildSimpleForm(runtimeId, { hint: options.hint }), true),
    async resolveOptionSource(context) {
      if (context.sourceId !== "model") return { kind: "source", source: null };
      const fallback = { kind: "source", source: staticModelFallbackOptionSource(runtimeId) } as const;
      if (!options.live) return fallback;
      const routing = await context.routeToComputer();
      if (routing === "handled") return { kind: "handled" };
      if (routing !== "confirmed_local") return fallback;
      let detected;
      try {
        detected = await context.agentOrchestrator.detectMachineRuntimeModels(context.machineId, runtimeId);
      } catch {
        // Offline, timed out or failed probes keep the form usable, as legacy does.
        return fallback;
      }
      if (detected.kind !== "live" || detected.value.models.length === 0) return fallback;
      return { kind: "source", source: modelSelectOptionSource(runtimeId, detected.value.models, detected.value.default) };
    },
    runtimeConfigFromValues(values, envVars) {
      // Like legacy, no custom model and no server-side list check: the probed
      // list is advisory and the runtime validates the model at launch.
      const modelValue = typeof values.model === "string" ? values.model.trim() : "";
      if (!modelValue) return formValueIssue("model_required", "model");
      return { ok: true, runtimeConfig: simpleRuntimeConfig(runtimeId, { kind: "preset", id: modelValue }, envVars) };
    },
    valuesFromRuntimeConfig: (runtimeConfig) => ({ model: modelValueOf(runtimeConfig), envVars: envVarsOf(runtimeConfig) }),
  };
}

/**
 * Antigravity chooses its model itself; the legacy web form ignores the model
 * field (runtimeIgnoresModel) and saves the stored model back unchanged. The
 * v2 form therefore has no model field, and a submit keeps the stored model.
 */
const antigravityEntry: RuntimeFormV2Entry = {
  runtimeId: "antigravity",
  buildForm: () => buildSimpleForm("antigravity", null),
  validateProjection: () => simpleProjectionIssues(buildSimpleForm("antigravity", null), false),
  resolveOptionSource: async () => ({ kind: "source", source: null }),
  runtimeConfigFromValues(_values, envVars, options) {
    const stored = options.existing?.runtime === "antigravity" ? options.existing.model : null;
    const model = stored?.kind === "custom"
      ? { kind: "custom", name: stored.name }
      : stored?.kind === "preset"
        ? { kind: "preset", id: stored.id }
        : { kind: "preset", id: getDefaultModel("antigravity") };
    return { ok: true, runtimeConfig: simpleRuntimeConfig("antigravity", model, envVars) };
  },
  valuesFromRuntimeConfig: (runtimeConfig) => ({ envVars: envVarsOf(runtimeConfig) }),
};

/**
 * Runtimes whose form has a live model list (batch 3a: Codex, Grok; batch 3b:
 * Claude, Cursor, Copilot). These forms use the capability
 * `option_source.status` (every model source says whether it is live), plus
 * `choice.labels` where the form has a reasoning effort and
 * `select.custom_value` where the legacy form offers a custom model. The legacy
 * web form (packages/web/src/components/agent/RuntimeConfigFields.tsx with
 * utils/reasoningEffortOptions.ts and utils/runtimeConfigForm.ts) is the oracle
 * for fields, options and the runtimeConfig a submit assembles.
 */
interface ReasoningModelFormOptions {
  /** `select.custom_value`: a typed model that is not listed is stored as a custom model (supportsRuntimeCustomModelName). */
  customModel: boolean;
  /** A boolean field mapped to runtimeConfig.mode (RUNTIME_FAST_MODE_RUNTIMES). */
  fastMode: boolean;
  /**
   * A reasoning effort that follows the selected model (REASONING_EFFORT_RUNTIMES),
   * with `choice.labels` for its English copy. Cursor has none.
   */
  reasoning: boolean;
  /**
   * Claude only (supportsRuntimeApiUrl): a Default/Custom provider select with
   * an API URL and a write-only API key for Custom (runtimeConfig.provider).
   */
  customProvider?: boolean;
  /** Claude only (supportsRuntimeCommand): the executable to launch (runtimeConfig.command). */
  command?: boolean;
  modelHint: string;
}

/**
 * Effort labels and descriptions, English: the server has no locale for form
 * copy, so every v2 label is English (like "Model"). The strings are the legacy
 * web picker's en messages (agent.reasoningEffort.<id>, <id>Description), which
 * runtimeFormV2Batch3a.test.ts keeps equal; web and mobile show them as sent.
 */
const REASONING_EFFORT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth for the hardest problems",
  ultra: "Maximum reasoning with automatic task delegation",
};

export function reasoningEffortChoices(): Record<string, RuntimeFormV2ChoiceCopy> {
  return Object.fromEntries(REASONING_EFFORTS.map((effort) => [
    effort.id,
    { label: effort.label, ...(REASONING_EFFORT_DESCRIPTIONS[effort.id] ? { description: REASONING_EFFORT_DESCRIPTIONS[effort.id] } : {}) },
  ]));
}

function reasoningModelCapabilities(options: ReasoningModelFormOptions): RuntimeFormV2ClientCapability[] {
  return [
    ...(options.customModel ? ["select.custom_value" as const] : []),
    ...(options.reasoning ? ["choice.labels" as const] : []),
    "option_source.status",
  ];
}

/**
 * Claude's provider choice, as the legacy select offers it. The copy is the
 * legacy web form's English (agent.runtimeConfig.default / .custom / .providerHint).
 */
const CUSTOM_PROVIDER_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "custom", label: "Custom" },
] as const;

/** Every field key of a form built with these options, in order. */
function reasoningModelFieldKeys(options: ReasoningModelFormOptions): string[] {
  return [
    ...(options.customProvider ? ["provider", "apiUrl", "apiKey"] : []),
    "model",
    ...(options.reasoning ? ["reasoningEffort"] : []),
    ...(options.fastMode ? ["fastMode"] : []),
    ...(options.command ? ["command"] : []),
    "envVars",
  ];
}

const reasoningModelRequired = (options: ReasoningModelFormOptions) =>
  // The provider is required so that a client which cannot load its (static)
  // source blocks the save instead of hiding the field and dropping a custom
  // provider. API URL and API key are shown only for Custom, so they are not in
  // `required`; the server refuses a Custom provider without them.
  options.customProvider ? ["provider", "model"] : ["model"];

function buildReasoningModelForm(runtimeId: string, options: ReasoningModelFormOptions): RuntimeFormV2Definition {
  const ref = simpleFormRef(runtimeId);
  const base = toRuntimeFormV2({
    ...ref,
    dataSchema: {
      type: "object",
      additionalProperties: false,
      required: reasoningModelRequired(options),
      properties: {
        ...(options.customProvider
          ? {
              provider: { type: "string", title: "Provider", minLength: 1 },
              apiUrl: { type: "string", title: "API URL", format: "uri" },
              apiKey: { type: "string", title: "API Key", writeOnly: true },
            }
          : {}),
        model: { type: "string", title: "Model", minLength: 1 },
        ...(options.reasoning ? { reasoningEffort: { type: "string", title: "Reasoning" } } : {}),
        ...(options.fastMode ? { fastMode: { type: "boolean", title: "Fast mode" } } : {}),
        ...(options.command ? { command: { type: "string", title: "Claude Command" } } : {}),
        envVars: { type: "object", title: "Environment Variables", additionalProperties: { type: "string" } },
      },
    },
    uiSchema: {
      order: reasoningModelFieldKeys(options),
      layout: { advanced: [...(options.command ? ["/command"] : []), "/envVars"] },
      visibility: options.customProvider
        ? [
            { pointer: "/apiUrl", when: { pointer: "/provider", in: ["custom"] } },
            { pointer: "/apiKey", when: { pointer: "/provider", in: ["custom"] } },
          ]
        : [],
      localization: {
        ...(options.customProvider
          ? {
              provider: {
                label: "Provider",
                hint: "Default leaves Claude Code provider settings untouched. Custom sets ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY for this agent.",
              },
              apiUrl: { label: "API URL", placeholder: "https://gateway.example.com" },
              apiKey: { label: "API Key", placeholder: "sk-ant-..." },
            }
          : {}),
        model: { label: "Model", hint: options.modelHint },
        ...(options.reasoning
          ? { reasoningEffort: { label: "Reasoning", hint: "Available values depend on the selected model." } }
          : {}),
        ...(options.fastMode
          ? { fastMode: { label: "Fast mode", hint: "Launch this runtime with higher speed at a higher cost per token." } }
          : {}),
        ...(options.command
          ? {
              command: {
                label: "Claude Command",
                hint: "Executable path or command name; Slock adds the Claude stream-json runtime arguments.",
                placeholder: "claude",
              },
            }
          : {}),
        envVars: { label: "Environment Variables", hint: "These will be injected into the runtime command environment." },
      },
    },
    capabilities: {
      // providerKinds names Built-in provider kinds only; Claude's choice is the provider field.
      providerKinds: [],
      writeOnlyPointers: options.customProvider ? ["/apiKey"] : [],
      forbiddenPointers: ["/hostUserState"],
    },
    optionSources: {
      ...(options.customProvider ? { provider: { ...ref, sourceId: "provider", kind: "select", pointer: "/provider" } } : {}),
      model: { ...ref, sourceId: "model", kind: "select", pointer: "/model" },
    },
  }, options.reasoning
    ? { reasoningEffort: { field: "model", attribute: "supportedReasoningEfforts", defaultAttribute: "defaultReasoningEffort" } }
    : {});
  if (options.reasoning) {
    const localization = base.uiSchema?.localization ?? {};
    localization.reasoningEffort = { ...localization.reasoningEffort, choices: reasoningEffortChoices() };
  }
  const { protocolVersion, runtimeId: id, schemaVersion, ...rest } = base;
  return { protocolVersion, runtimeId: id, schemaVersion, requiredClientCapabilities: reasoningModelCapabilities(options), ...rest };
}

/**
 * A model's effort metadata as the legacy picker resolves it
 * (reasoningEffortOptionsForModel): a live entry that declares efforts wins,
 * else the bundled entry for the same id, else the live entry. Every option
 * carries its efforts: the declared set in catalog order (unknown ids dropped),
 * or the BASE set for a model that declares none, which is what the server's
 * static rule (allowedReasoningEffortsForModel) accepts for it.
 */
function reasoningModelOption(runtimeId: string, model: RuntimeModelInfo): AgentCreateFormOption {
  const bundled = RUNTIME_MODELS[runtimeId]?.find((candidate) => candidate.id === model.id);
  const info = model.supportedReasoningEfforts?.length ? model : bundled ?? model;
  const declared = info.supportedReasoningEfforts?.length ? info.supportedReasoningEfforts : null;
  const efforts = REASONING_EFFORTS
    .map((effort) => effort.id)
    .filter((id) => (declared ? declared.includes(id) : BASE_REASONING_EFFORTS.includes(id)));
  const defaultEffort = declared && info.defaultReasoningEffort && efforts.includes(info.defaultReasoningEffort as never)
    ? info.defaultReasoningEffort
    : undefined;
  return {
    value: model.id,
    label: model.label,
    supportedReasoningEfforts: efforts,
    ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
  };
}

/**
 * The model source of a live-list form: the live list when the probe is live,
 * else the bundled RUNTIME_MODELS list (legacy does the same) marked `fallback`
 * with the reason, or `unavailable` with no options when there is no bundled
 * list. Options carry their efforts only on a form with a reasoning effort.
 */
export function reasoningModelOptionSource(
  runtimeId: string,
  models: readonly RuntimeModelInfo[],
  defaultModel: string | undefined,
  reason: RuntimeFormV2OptionSourceReason | null,
  options: Pick<ReasoningModelFormOptions, "customModel"> & { reasoning?: boolean },
): RuntimeFormV2OptionSourceBody {
  const select = modelSelectOptionSource(runtimeId, models, defaultModel);
  const listed = options.reasoning === false
    ? select
    : { ...select, options: models.map((model) => reasoningModelOption(runtimeId, model)) } as AgentCreateFormOptionSource;
  return {
    ...listed,
    ...(options.customModel ? { customValueAllowed: true } : {}),
    ...optionSourceStatusFields(reason, models.length > 0),
  };
}

/**
 * Claude's provider select: static, so it has no `status` (that describes a
 * probed list) and never allows a typed value.
 */
function customProviderOptionSource(runtimeId: string): RuntimeFormV2OptionSourceBody {
  return {
    ...simpleFormRef(runtimeId),
    sourceId: "provider",
    kind: "select",
    pointer: "/provider",
    options: CUSTOM_PROVIDER_OPTIONS.map((option) => ({ ...option })),
    defaultValue: "default",
    customValueAllowed: false,
  };
}

type ModelProbe =
  | { kind: "handled" }
  | { kind: "live"; models: readonly RuntimeModelInfo[]; default?: string }
  | { kind: "not_live"; reason: RuntimeFormV2OptionSourceReason };

async function probeModels(context: RuntimeFormOptionSourceContext, runtimeId: string): Promise<ModelProbe> {
  const routing = await context.routeToComputer();
  if (routing === "handled") return { kind: "handled" };
  if (routing !== "confirmed_local") return { kind: "not_live", reason: "machine_offline" };
  let outcome: RuntimeModelSourceOutcome;
  try {
    outcome = await context.agentOrchestrator.detectMachineRuntimeModels(context.machineId, runtimeId);
  } catch (error) {
    return { kind: "not_live", reason: optionSourceReasonForProbeError(error) };
  }
  const reason = optionSourceReasonForOutcome(outcome);
  if (reason !== null || outcome.kind !== "live") return { kind: "not_live", reason: reason ?? "probe_failed" };
  return { kind: "live", models: outcome.value.models, default: outcome.value.default };
}

function reasoningModelProjectionIssues(form: RuntimeFormV2Definition, options: ReasoningModelFormOptions): AgentCreateFormIssue[] {
  const expected = [...reasoningModelFieldKeys(options)].sort().join("\0");
  if (
    Object.keys(form.dataSchema.properties).sort().join("\0") !== expected
    || (form.dataSchema.required ?? []).join("\0") !== reasoningModelRequired(options).join("\0")
  ) {
    return [{ code: "definition_data_schema_drift", pointer: "/dataSchema" }];
  }
  const sources = options.customProvider ? "provider\0model" : "model";
  if (
    Object.keys(form.optionSources ?? {}).join("\0") !== sources
    || form.optionSources?.model?.pointer !== "/model"
    || (options.customProvider && form.optionSources?.provider?.pointer !== "/provider")
  ) {
    return [{ code: "definition_option_source_topology_drift", pointer: "/optionSources" }];
  }
  if ((form.requiredClientCapabilities ?? []).join("\0") !== reasoningModelCapabilities(options).join("\0")) {
    return [{ code: "definition_capabilities_drift", pointer: "/requiredClientCapabilities" }];
  }
  return [];
}

/**
 * Claude's custom-provider API key: write-only in the v2 form (never in
 * `values`; a blank one on edit keeps the stored key while the API URL is
 * unchanged).
 *
 * `redactOnAgentRead: false`: the v1 agent read (GET /api/agents[/:id]) keeps
 * returning it to editors, because installed mobile apps prefill the key from
 * that read and refuse to save a Custom provider with a blank key (MembersPage
 * providerKeyInvalid); blanking it there would force every such user to retype
 * the key. Flip to true once released clients treat it as write-only.
 */
const CLAUDE_CUSTOM_PROVIDER_API_KEY: RuntimeConfigWriteOnlySecret = {
  path: ["provider", "apiKey"],
  appliesTo: (config) => isPlainRecord(config.provider) && config.provider.kind === "custom",
  keepsIdentity(incoming, existing) {
    const next = isPlainRecord(incoming.provider) ? incoming.provider : {};
    const saved = isPlainRecord(existing.provider) ? existing.provider : {};
    return next.kind === "custom" && saved.kind === "custom"
      && typeof next.apiUrl === "string" && typeof saved.apiUrl === "string"
      && next.apiUrl.trim() === saved.apiUrl.trim();
  },
  redactOnAgentRead: false,
};

type ProviderBuild =
  | { ok: true; provider: Record<string, unknown> }
  | { ok: false; issue: AgentCreateFormIssue };

/** The legacy builder's Claude provider (buildRuntimeConfig, supportsRuntimeApiUrl). */
function customProviderFromValues(
  runtimeId: string,
  values: Record<string, unknown>,
  options: RuntimeFormValuesOptions,
): ProviderBuild {
  const mode = typeof values.provider === "string" ? values.provider.trim() : "";
  if (mode === "default") return { ok: true, provider: { kind: "default" } };
  if (mode !== "custom") return formValueIssue("select_valid_provider", "provider") as ProviderBuild;
  const apiUrl = typeof values.apiUrl === "string" ? values.apiUrl.trim() : "";
  if (!/^https?:\/\//i.test(apiUrl)) return formValueIssue("api_url_invalid", "apiUrl") as ProviderBuild;
  const apiKey = typeof values.apiKey === "string" ? values.apiKey.trim() : "";
  if (apiKey) return { ok: true, provider: { kind: "custom", apiUrl, apiKey } };
  // A blank write-only key on edit means "keep the stored one": omit it so the
  // PATCH path (retainOmittedWriteOnlySecrets) restores it. Only while it would
  // still authenticate the same endpoint; otherwise ask for a key here instead
  // of failing later without a field pointer.
  const existing = options.existing;
  const provider = { kind: "custom", apiUrl };
  if (
    options.editing === true
    && existing?.runtime === runtimeId
    && CLAUDE_CUSTOM_PROVIDER_API_KEY.keepsIdentity({ provider }, existing as unknown as Record<string, unknown>)
  ) {
    return { ok: true, provider };
  }
  return formValueIssue("api_key_required", "apiKey") as ProviderBuild;
}

function reasoningModelFormEntry(runtimeId: string, options: ReasoningModelFormOptions): RuntimeFormV2Entry {
  const bundledIds = () => new Set((RUNTIME_MODELS[runtimeId] ?? []).map((model) => model.id));
  return {
    runtimeId,
    buildForm: () => buildReasoningModelForm(runtimeId, options),
    validateProjection: () => reasoningModelProjectionIssues(buildReasoningModelForm(runtimeId, options), options),
    async resolveOptionSource(context) {
      if (options.customProvider && context.sourceId === "provider") {
        return { kind: "source", source: customProviderOptionSource(runtimeId) };
      }
      if (context.sourceId !== "model") return { kind: "source", source: null };
      const probe = await probeModels(context, runtimeId);
      if (probe.kind === "handled") return { kind: "handled" };
      if (probe.kind === "live") {
        return { kind: "source", source: reasoningModelOptionSource(runtimeId, probe.models, probe.default, null, options) };
      }
      return {
        kind: "source",
        source: reasoningModelOptionSource(runtimeId, RUNTIME_MODELS[runtimeId] ?? [], undefined, probe.reason, options),
      };
    },
    runtimeConfigFromValues(values, envVars, valueOptions) {
      const modelValue = typeof values.model === "string" ? values.model.trim() : "";
      if (!modelValue) return formValueIssue("model_required", "model");
      // A form without a reasoning field ignores a stray value, like fastMode below.
      const effort = options.reasoning ? values.reasoningEffort : null;
      if (effort !== undefined && effort !== null && typeof effort !== "string") {
        return formValueIssue("invalid_reasoning_effort", "reasoningEffort");
      }
      const fastMode = values.fastMode;
      if (fastMode !== undefined && fastMode !== null && typeof fastMode !== "boolean") {
        return formValueIssue("invalid_boolean", "fastMode");
      }
      const command = options.command ? values.command : null;
      if (command !== undefined && command !== null && typeof command !== "string") {
        return formValueIssue("invalid_command", "command");
      }
      let provider: Record<string, unknown> | null = null;
      if (options.customProvider) {
        const built = customProviderFromValues(runtimeId, values, valueOptions);
        if (!built.ok) return built;
        provider = built.provider;
      }
      // `select.custom_value`: a listed value is a preset, an unlisted typed one
      // a custom model. "Listed" here is the bundled list; a model that only the
      // Computer's live list names is turned back into a preset by
      // reconcileWithLiveModels once the submit knows the Computer.
      const model = options.customModel && !bundledIds().has(modelValue)
        ? { kind: "custom", name: modelValue }
        : { kind: "preset", id: modelValue };
      return {
        ok: true,
        runtimeConfig: {
          version: RUNTIME_CONFIG_VERSION,
          runtime: runtimeId,
          ...(provider ? { provider } : {}),
          model,
          mode: options.fastMode && fastMode === true ? { kind: "fast" } : { kind: "default" },
          reasoningEffort: typeof effort === "string" && effort.trim() !== "" ? effort.trim() : null,
          envVars,
          ...(typeof command === "string" && command.trim() ? { command: command.trim() } : {}),
        },
      };
    },
    valuesFromRuntimeConfig(runtimeConfig) {
      const provider = isPlainRecord(runtimeConfig.provider) ? runtimeConfig.provider : null;
      const custom = provider?.kind === "custom";
      return {
        // The API key is write-only: never part of the values.
        ...(options.customProvider
          ? {
              provider: custom ? "custom" : "default",
              ...(custom ? { apiUrl: typeof provider.apiUrl === "string" ? provider.apiUrl : "" } : {}),
            }
          : {}),
        model: modelValueOf(runtimeConfig),
        ...(options.reasoning
          ? { reasoningEffort: typeof runtimeConfig.reasoningEffort === "string" ? runtimeConfig.reasoningEffort : "" }
          : {}),
        ...(options.fastMode
          ? { fastMode: isPlainRecord(runtimeConfig.mode) && runtimeConfig.mode.kind === "fast" }
          : {}),
        ...(options.command ? { command: typeof runtimeConfig.command === "string" ? runtimeConfig.command : "" } : {}),
        envVars: envVarsOf(runtimeConfig),
      };
    },
    ...(options.customProvider ? { writeOnlySecrets: [CLAUDE_CUSTOM_PROVIDER_API_KEY] } : {}),
    reconcileWithLiveModels(runtimeConfig, submittedReasoningEffort, models) {
      const modelValue = runtimeConfig.model.kind === "custom" ? runtimeConfig.model.name : runtimeConfig.model.id;
      const live = models.find((model) => model.id === modelValue);
      // Not in the live list: a custom model, or a bundled one this Computer
      // does not report. The static rule already applied stays final.
      if (!live) return { kind: "unchanged" };
      if (!options.reasoning) {
        // Nothing to decide but the model kind: a live-listed one is a preset.
        return runtimeConfig.model.kind === "custom"
          ? { kind: "updated", runtimeConfig: { ...runtimeConfig, model: { kind: "preset", id: modelValue } } as RuntimeConfig }
          : { kind: "unchanged" };
      }
      const efforts = reasoningModelOption(runtimeId, live).supportedReasoningEfforts ?? [];
      if (submittedReasoningEffort !== null && !efforts.includes(submittedReasoningEffort)) {
        return { kind: "rejected", issue: { code: "reasoning_effort_not_supported", pointer: "/formValues/reasoningEffort" } };
      }
      return {
        kind: "updated",
        runtimeConfig: {
          ...runtimeConfig,
          model: { kind: "preset", id: modelValue },
          reasoningEffort: submittedReasoningEffort as RuntimeConfig["reasoningEffort"],
        } as RuntimeConfig,
      };
    },
  };
}

const codexEntry = reasoningModelFormEntry("codex", {
  customModel: true,
  fastMode: true,
  reasoning: true,
  modelHint: "Models available from this computer's Codex CLI. You can also type a model ID.",
});

// No custom model: the legacy form offers none for Grok (supportsRuntimeCustomModelName).
const grokEntry = reasoningModelFormEntry("grok", {
  customModel: false,
  fastMode: false,
  reasoning: true,
  modelHint: "Models available from this computer's Grok CLI.",
});

// Batch 3b. Each follows the legacy predicates in utils/runtimeConfigForm.ts
// (supportsRuntimeCustomModelName, supportsRuntimeApiUrl, supportsRuntimeCommand,
// supportsRuntimeFastMode) and REASONING_EFFORT_RUNTIMES. Claude and Copilot's
// Computer "probe" answers with the declared static catalog
// (STATIC_RUNTIME_MODEL_SOURCE_IDS); Cursor's asks the Cursor CLI.
const claudeEntry = reasoningModelFormEntry("claude", {
  customModel: true,
  fastMode: true,
  reasoning: true,
  customProvider: true,
  command: true,
  modelHint: "Models Claude Code accepts. You can also type a model ID.",
});

const cursorEntry = reasoningModelFormEntry("cursor", {
  customModel: true,
  fastMode: false,
  reasoning: false,
  modelHint: "Models available from this computer's Cursor CLI. You can also type a model ID.",
});

const copilotEntry = reasoningModelFormEntry("copilot", {
  customModel: true,
  fastMode: false,
  reasoning: true,
  modelHint: "Models GitHub Copilot CLI accepts. You can also type a model ID.",
});

/**
 * Batch 4: Pi (the Pi CLI runtime on the Computer, runtime "pi"; not Built-in
 * Pi, which is "builtin"). The legacy web form is the oracle
 * (packages/web/src/components/agent/RuntimeConfigFields.tsx, the
 * `piProviderSupported` branch, with utils/runtimeConfigForm.ts
 * buildRuntimeConfig):
 *
 * - Provider: "Configured" (the Computer's own Pi auth.json; runtimeConfig
 *   provider `{ kind: "default" }`) or one of the Pi built-in providers
 *   (PI_BUILTIN_PROVIDER_ENV_KEYS, today DeepSeek; `{ kind: "pi-builtin",
 *   providerId, apiKey }`). Pi has no saved provider connections: the legacy
 *   dialogs load them only for Built-in, and the parser has no `connection`
 *   provider for Pi.
 * - Configured: the model list comes from the Computer's Pi probe, and a typed
 *   custom model is allowed (supportsRuntimeCustomModelName).
 * - A built-in provider: an API key, and the provider's own model list
 *   (PI_BUILTIN_PROVIDER_MODELS); legacy locks the model picker to that list
 *   (no Custom) and resets the model to the provider's default on a switch.
 * - A reasoning effort in both cases (REASONING_EFFORT_RUNTIMES). Pi models
 *   never declare efforts (the probe reports none and RUNTIME_MODELS.pi has
 *   none), so every listed model offers the BASE set, as the legacy picker does.
 *
 * The v2 contract has no select whose list depends on another field and also
 * accepts a typed value (dependent_select is either a list or free text per
 * parent value), so the two model lists are two fields, each shown for its
 * provider: `model` (a select with `select.custom_value`) and `providerModel`
 * (a dependent_select on the provider). Each has its own effort field, derived
 * from it, because a derived field follows exactly one parent. Both effort
 * fields fill runtimeConfig.reasoningEffort; the submit reads the pair that
 * belongs to the chosen provider.
 */
const PI_CONFIGURED_PROVIDER = "configured";
const PI_BUILTIN_PROVIDER_IDS = Object.keys(PI_BUILTIN_PROVIDER_ENV_KEYS);
const PI_FIELD_KEYS = ["provider", "apiKey", "model", "reasoningEffort", "providerModel", "providerReasoningEffort", "envVars"] as const;
const PI_REQUIRED = ["provider", "model", "providerModel"] as const;
const PI_CAPABILITIES: RuntimeFormV2ClientCapability[] = ["select.custom_value", "choice.labels", "option_source.status"];
const PI_EFFORT_DERIVATION = { attribute: "supportedReasoningEfforts", defaultAttribute: "defaultReasoningEffort" } as const;

function buildPiForm(): RuntimeFormV2Definition {
  const ref = simpleFormRef("pi");
  const configured = { pointer: "/provider", in: [PI_CONFIGURED_PROVIDER] };
  const builtin = { pointer: "/provider", in: [...PI_BUILTIN_PROVIDER_IDS] };
  const reasoningCopy = { label: "Reasoning", hint: "Available values depend on the selected model.", choices: reasoningEffortChoices() };
  const base = toRuntimeFormV2({
    ...ref,
    dataSchema: {
      type: "object",
      additionalProperties: false,
      // `model` and `providerModel` are each shown for one kind of provider;
      // a client checks `required` only for fields it shows. The API key is
      // shown only for a built-in provider and asked for by the server.
      required: [...PI_REQUIRED],
      properties: {
        provider: { type: "string", title: "Provider", minLength: 1 },
        apiKey: { type: "string", title: "API Key", writeOnly: true },
        model: { type: "string", title: "Model", minLength: 1 },
        reasoningEffort: { type: "string", title: "Reasoning" },
        providerModel: { type: "string", title: "Model", minLength: 1 },
        providerReasoningEffort: { type: "string", title: "Reasoning" },
        envVars: { type: "object", title: "Environment Variables", additionalProperties: { type: "string" } },
      },
    },
    uiSchema: {
      order: [...PI_FIELD_KEYS],
      layout: { advanced: ["/envVars"] },
      visibility: [
        { pointer: "/apiKey", when: builtin },
        { pointer: "/model", when: configured },
        { pointer: "/reasoningEffort", when: configured },
        { pointer: "/providerModel", when: builtin },
        { pointer: "/providerReasoningEffort", when: builtin },
      ],
      localization: {
        // The legacy web form's English (agent.runtimeConfig.provider / .piProviderHint).
        provider: {
          label: "Provider",
          hint: "Configured uses your machine's Pi auth.json. Other options inject the matching API key as an env var so the Pi SDK picks it up — no auth.json edit on your machine.",
        },
        apiKey: { label: "API Key", placeholder: "sk-..." },
        model: { label: "Model", hint: "Models available from this computer's Pi configuration. You can also type a model ID." },
        reasoningEffort: reasoningCopy,
        providerModel: { label: "Model", hint: "Models the selected provider offers." },
        providerReasoningEffort: reasoningCopy,
        envVars: { label: "Environment Variables", hint: "These will be injected into the runtime command environment." },
      },
    },
    capabilities: {
      // providerKinds names Built-in provider kinds only; Pi's choice is the provider field.
      providerKinds: [],
      writeOnlyPointers: ["/apiKey"],
      forbiddenPointers: ["/hostUserState"],
    },
    optionSources: {
      provider: { ...ref, sourceId: "provider", kind: "select", pointer: "/provider" },
      model: { ...ref, sourceId: "model", kind: "select", pointer: "/model" },
      providerModel: { ...ref, sourceId: "providerModel", kind: "dependent_select", pointer: "/providerModel", dependsOn: "/provider" },
    },
  }, {
    reasoningEffort: { field: "model", ...PI_EFFORT_DERIVATION },
    providerReasoningEffort: { field: "providerModel", ...PI_EFFORT_DERIVATION },
  });
  const { protocolVersion, runtimeId, schemaVersion, ...rest } = base;
  return { protocolVersion, runtimeId, schemaVersion, requiredClientCapabilities: [...PI_CAPABILITIES], ...rest };
}

/** The provider select: static (no probe, so no `status`), no typed value. */
function piProviderOptionSource(): RuntimeFormV2OptionSourceBody {
  return {
    ...simpleFormRef("pi"),
    sourceId: "provider",
    kind: "select",
    pointer: "/provider",
    options: [
      { value: PI_CONFIGURED_PROVIDER, label: "Configured" },
      ...PI_BUILTIN_PROVIDER_IDS.map((providerId) => ({ value: providerId, label: getRuntimeProviderDisplayName(providerId) })),
    ],
    defaultValue: PI_CONFIGURED_PROVIDER,
    customValueAllowed: false,
  };
}

/**
 * A built-in provider's models, from the Pi SDK catalog; static, so no
 * `status`. Each option offers the BASE efforts (reasoningModelOption: these
 * ids are not in RUNTIME_MODELS.pi and declare none).
 */
function piProviderModelOptionSource(): RuntimeFormV2OptionSourceBody {
  return {
    ...simpleFormRef("pi"),
    sourceId: "providerModel",
    kind: "dependent_select",
    pointer: "/providerModel",
    dependsOn: "/provider",
    optionsByValue: Object.fromEntries(PI_BUILTIN_PROVIDER_IDS.map((providerId) => [
      providerId,
      (PI_BUILTIN_PROVIDER_MODELS[providerId] ?? []).map((model) => reasoningModelOption("pi", model)),
    ])),
    defaultValueByValue: Object.fromEntries(PI_BUILTIN_PROVIDER_IDS.map((providerId) => [
      providerId,
      PI_BUILTIN_PROVIDER_DEFAULT_MODELS[providerId as keyof typeof PI_BUILTIN_PROVIDER_DEFAULT_MODELS] ?? "",
    ])),
    customValueAllowedByValue: Object.fromEntries(PI_BUILTIN_PROVIDER_IDS.map((providerId) => [providerId, false])),
  };
}

function piProjectionIssues(form: RuntimeFormV2Definition): AgentCreateFormIssue[] {
  if (
    Object.keys(form.dataSchema.properties).sort().join("\0") !== [...PI_FIELD_KEYS].sort().join("\0")
    || (form.dataSchema.required ?? []).join("\0") !== PI_REQUIRED.join("\0")
  ) {
    return [{ code: "definition_data_schema_drift", pointer: "/dataSchema" }];
  }
  if (
    Object.keys(form.optionSources ?? {}).join("\0") !== "provider\0model\0providerModel"
    || form.optionSources?.provider?.pointer !== "/provider"
    || form.optionSources?.model?.pointer !== "/model"
    || form.optionSources?.providerModel?.pointer !== "/providerModel"
    || form.optionSources?.providerModel?.dependsOn !== "/provider"
  ) {
    return [{ code: "definition_option_source_topology_drift", pointer: "/optionSources" }];
  }
  if ((form.requiredClientCapabilities ?? []).join("\0") !== PI_CAPABILITIES.join("\0")) {
    return [{ code: "definition_capabilities_drift", pointer: "/requiredClientCapabilities" }];
  }
  // Every served provider model must be one the strict parser accepts.
  for (const providerId of PI_BUILTIN_PROVIDER_IDS) {
    const models = PI_BUILTIN_PROVIDER_MODELS[providerId] ?? [];
    const defaultModel = PI_BUILTIN_PROVIDER_DEFAULT_MODELS[providerId as keyof typeof PI_BUILTIN_PROVIDER_DEFAULT_MODELS];
    if (models.length === 0 || !models.some((model) => model.id === defaultModel)) {
      return [{ code: "definition_model_registry_drift", pointer: `/optionSources/providerModel/optionsByValue/${providerId}` }];
    }
  }
  return [];
}

/**
 * The Pi built-in provider key: write-only in the v2 form (never in `values`;
 * a blank one on edit keeps the stored key while the provider is unchanged).
 *
 * `redactOnAgentRead: false`, like Claude's key: the legacy web edit form
 * prefills the key from the v1 agent read (AgentDetailPanel,
 * runtimeConfigPiProviderApiKey) and refuses to save a blank one, and the
 * strict parser rejects a blank `pi-builtin` key, so a blanked read would not
 * even hydrate there. Flip to true once released clients treat it as write-only.
 */
const PI_BUILTIN_PROVIDER_API_KEY: RuntimeConfigWriteOnlySecret = {
  path: ["provider", "apiKey"],
  appliesTo: (config) => isPlainRecord(config.provider) && config.provider.kind === "pi-builtin",
  keepsIdentity(incoming, existing) {
    const next = isPlainRecord(incoming.provider) ? incoming.provider : {};
    const saved = isPlainRecord(existing.provider) ? existing.provider : {};
    return next.kind === "pi-builtin" && saved.kind === "pi-builtin"
      && typeof next.providerId === "string" && typeof saved.providerId === "string"
      && next.providerId.trim() === saved.providerId.trim();
  },
  redactOnAgentRead: false,
};

const KNOWN_REASONING_EFFORT_IDS: ReadonlySet<string> = new Set(REASONING_EFFORTS.map((effort) => effort.id));

/** A submitted effort: "" or null is the runtime default; anything else must be a known effort. */
function piEffort(values: Record<string, unknown>, key: string): { ok: true; value: string | null } | { ok: false; issue: AgentCreateFormIssue } {
  const effort = values[key];
  if (effort === undefined || effort === null || (typeof effort === "string" && effort.trim() === "")) return { ok: true, value: null };
  if (typeof effort !== "string" || !KNOWN_REASONING_EFFORT_IDS.has(effort.trim())) {
    return { ok: false, issue: { code: "invalid_reasoning_effort", pointer: `/formValues/${key}` } };
  }
  return { ok: true, value: effort.trim() };
}

const piEntry: RuntimeFormV2Entry = {
  runtimeId: "pi",
  buildForm: buildPiForm,
  validateProjection: () => piProjectionIssues(buildPiForm()),
  async resolveOptionSource(context) {
    if (context.sourceId === "provider") return { kind: "source", source: piProviderOptionSource() };
    if (context.sourceId === "providerModel") return { kind: "source", source: piProviderModelOptionSource() };
    if (context.sourceId !== "model") return { kind: "source", source: null };
    const probe = await probeModels(context, "pi");
    if (probe.kind === "handled") return { kind: "handled" };
    const options = { customModel: true, reasoning: true };
    if (probe.kind === "live") {
      return { kind: "source", source: reasoningModelOptionSource("pi", probe.models, probe.default, null, options) };
    }
    // Not live: the bundled "Configured Default / Auto" entry, marked fallback,
    // like every other probed runtime (the legacy web form offers no list here
    // and only a typed model; see the batch 4 notes in the README).
    return { kind: "source", source: reasoningModelOptionSource("pi", RUNTIME_MODELS.pi ?? [], undefined, probe.reason, options) };
  },
  runtimeConfigFromValues(values, envVars, options) {
    const providerChoice = typeof values.provider === "string" ? values.provider.trim() : "";
    const base = { version: RUNTIME_CONFIG_VERSION, runtime: "pi", mode: { kind: "default" }, envVars };
    if (providerChoice === PI_CONFIGURED_PROVIDER) {
      const modelValue = typeof values.model === "string" ? values.model.trim() : "";
      if (!modelValue) return formValueIssue("model_required", "model");
      const effort = piEffort(values, "reasoningEffort");
      if (!effort.ok) return effort;
      // `select.custom_value`: a listed value is a preset, an unlisted typed one
      // a custom model; reconcileWithLiveModels turns a model only the live list
      // names back into a preset.
      const bundled = (RUNTIME_MODELS.pi ?? []).some((model) => model.id === modelValue);
      return {
        ok: true,
        runtimeConfig: {
          ...base,
          provider: { kind: "default" },
          model: bundled ? { kind: "preset", id: modelValue } : { kind: "custom", name: modelValue },
          reasoningEffort: effort.value,
        },
      };
    }
    if (!PI_BUILTIN_PROVIDER_IDS.includes(providerChoice)) return formValueIssue("select_valid_provider", "provider");
    const modelValue = typeof values.providerModel === "string" ? values.providerModel.trim() : "";
    if (!modelValue) return formValueIssue("model_required", "providerModel");
    // Legacy locks the picker to the provider's list (no Custom).
    if (!(PI_BUILTIN_PROVIDER_MODELS[providerChoice] ?? []).some((model) => model.id === modelValue)) {
      return formValueIssue("select_valid_provider_model", "providerModel");
    }
    const effort = piEffort(values, "providerReasoningEffort");
    if (!effort.ok) return effort;
    const apiKey = typeof values.apiKey === "string" ? values.apiKey.trim() : "";
    const provider: Record<string, unknown> = { kind: "pi-builtin", providerId: providerChoice, ...(apiKey ? { apiKey } : {}) };
    // A blank write-only key on edit means "keep the stored one": omit it so the
    // PATCH path (retainOmittedWriteOnlySecrets) restores it, only while the
    // provider is the same; otherwise ask for a key at the field.
    if (
      !apiKey
      && !(options.editing === true
        && options.existing?.runtime === "pi"
        && PI_BUILTIN_PROVIDER_API_KEY.keepsIdentity({ provider }, options.existing as unknown as Record<string, unknown>))
    ) {
      return formValueIssue("api_key_required", "apiKey");
    }
    return {
      ok: true,
      runtimeConfig: { ...base, provider, model: { kind: "preset", id: modelValue }, reasoningEffort: effort.value },
    };
  },
  valuesFromRuntimeConfig(runtimeConfig) {
    const provider = isPlainRecord(runtimeConfig.provider) ? runtimeConfig.provider : null;
    const effort = typeof runtimeConfig.reasoningEffort === "string" ? runtimeConfig.reasoningEffort : "";
    const envVars = envVarsOf(runtimeConfig);
    // The API key is write-only: never part of the values.
    if (provider?.kind === "pi-builtin") {
      return {
        provider: typeof provider.providerId === "string" ? provider.providerId : "",
        providerModel: modelValueOf(runtimeConfig),
        providerReasoningEffort: effort,
        envVars,
      };
    }
    return { provider: PI_CONFIGURED_PROVIDER, model: modelValueOf(runtimeConfig), reasoningEffort: effort, envVars };
  },
  writeOnlySecrets: [PI_BUILTIN_PROVIDER_API_KEY],
  reconcileWithLiveModels(runtimeConfig, submittedReasoningEffort, models) {
    // Only the Configured provider's model comes from the Computer; a built-in
    // provider's model is checked against its own catalog.
    if (runtimeConfig.provider?.kind === "pi-builtin") return { kind: "unchanged" };
    const modelValue = runtimeConfig.model.kind === "custom" ? runtimeConfig.model.name : runtimeConfig.model.id;
    const live = models.find((model) => model.id === modelValue);
    if (!live) return { kind: "unchanged" };
    const efforts = reasoningModelOption("pi", live).supportedReasoningEfforts ?? [];
    if (submittedReasoningEffort !== null && !efforts.includes(submittedReasoningEffort)) {
      return { kind: "rejected", issue: { code: "reasoning_effort_not_supported", pointer: "/formValues/reasoningEffort" } };
    }
    return {
      kind: "updated",
      runtimeConfig: {
        ...runtimeConfig,
        model: { kind: "preset", id: modelValue },
        reasoningEffort: submittedReasoningEffort as RuntimeConfig["reasoningEffort"],
      } as RuntimeConfig,
    };
  },
};

const REGISTRY = new Map<string, RuntimeFormV2Entry>([
  [builtinEntry.runtimeId, builtinEntry],
  [kimiSdkEntry.runtimeId, kimiSdkEntry],
  // Batch 2. Kimi CLI, Gemini CLI and Antigravity are deprecated: the admission
  // row offers them (and so their v2 marker) only as an edited agent's current
  // runtime, and a create with them is refused like any deprecated runtime.
  ["opencode", modelFormEntry("opencode", { live: true, hint: "Models available from this computer's OpenCode configuration." })],
  ["kimi", modelFormEntry("kimi", { live: true, hint: "Models available from this computer's Kimi CLI configuration." })],
  ["gemini", modelFormEntry("gemini", { live: false })],
  [antigravityEntry.runtimeId, antigravityEntry],
  // Batch 3a: the first forms that need client capabilities. Grok's admission
  // row (and so its v2 marker) follows the grok runtime feature flag like its
  // legacy visibility; a create with Grok is still refused while the flag is off.
  [codexEntry.runtimeId, codexEntry],
  [grokEntry.runtimeId, grokEntry],
  // Batch 3b: Claude, Cursor and Copilot. None has a v1 form.
  [claudeEntry.runtimeId, claudeEntry],
  [cursorEntry.runtimeId, cursorEntry],
  [copilotEntry.runtimeId, copilotEntry],
  // Batch 4: Pi. No v1 form.
  [piEntry.runtimeId, piEntry],
]);

export function runtimeFormV2Entry(runtimeId: unknown): RuntimeFormV2Entry | null {
  return typeof runtimeId === "string" ? REGISTRY.get(runtimeId) ?? null : null;
}

export function runtimeFormV2RuntimeIds(): string[] {
  return [...REGISTRY.keys()];
}

/**
 * Test seam: register an entry (for example a runtime that has a v2 form but no
 * v1 ref) and return the function that restores the previous registration.
 */
export function registerRuntimeFormV2EntryForTests(entry: RuntimeFormV2Entry): () => void {
  const previous = REGISTRY.get(entry.runtimeId);
  REGISTRY.set(entry.runtimeId, entry);
  return () => {
    if (previous) REGISTRY.set(entry.runtimeId, previous);
    else REGISTRY.delete(entry.runtimeId);
  };
}

/**
 * Test seam: take a runtime out of the registry (every catalog runtime has a v2
 * form since batch 4, so this is how a test gets a real runtime without one)
 * and return the function that puts it back.
 */
export function removeRuntimeFormV2EntryForTests(runtimeId: string): () => void {
  const previous = REGISTRY.get(runtimeId);
  REGISTRY.delete(runtimeId);
  return () => {
    if (previous) REGISTRY.set(runtimeId, previous);
  };
}

/** The v2 form the server sends today for a registered runtime. */
export function buildRuntimeFormV2(runtimeId: string): RuntimeFormV2Definition {
  const entry = runtimeFormV2Entry(runtimeId);
  if (!entry) throw new Error(`runtime ${runtimeId} has no v2 form`);
  return entry.buildForm();
}

/**
 * The envelope of a v2 submit: `{ protocolVersion: 2, runtimeId }` naming a
 * runtime in this registry. v1 refs are validated by
 * validateRuntimeFormDefinitionRef and never reach here.
 */
export function validateRuntimeFormV2SubmitRef(value: unknown): AgentCreateFormIssue[] {
  if (!isPlainRecord(value)) return [{ code: "form_definition_ref_required", pointer: "/formDefinitionRef" }];
  if (value.protocolVersion !== 2) return [{ code: "unsupported_form_protocol", pointer: "/formDefinitionRef/protocolVersion" }];
  if (!runtimeFormV2Entry(value.runtimeId)) return [{ code: "unknown_form_runtime", pointer: "/formDefinitionRef/runtimeId" }];
  return [];
}

/**
 * Protocol v2 submit: a client sends the form's values keyed by dataSchema field
 * name, and the server assembles the runtimeConfig. Clients therefore need no
 * knowledge of how a runtime nests its config (packages/runtime-form README,
 * "Protocol v2"). The result then goes through the same validation as a
 * runtimeConfig a client built itself.
 */
export function buildRuntimeConfigFromFormValues(
  runtimeId: unknown,
  values: unknown,
  options: RuntimeFormValuesOptions = {},
): FormValuesBuildResult {
  const entry = runtimeFormV2Entry(runtimeId);
  if (!entry) return { ok: false, issue: { code: "unknown_form_runtime", pointer: "/formDefinitionRef/runtimeId" } };
  if (!isPlainRecord(values)) return { ok: false, issue: { code: "form_values_required", pointer: "/formValues" } };
  const envVars = readEnvVars(values.envVars);
  if (envVars === undefined) return { ok: false, issue: { code: "invalid_string_map", pointer: "/formValues/envVars" } };
  const built = entry.runtimeConfigFromValues(values, envVars, options);
  if (!built.ok) return built;
  return { ok: true, runtimeConfig: built.runtimeConfig, formDefinitionRef: { protocolVersion: 2, runtimeId: entry.runtimeId } };
}

/**
 * v2 submit, after the assembled runtimeConfig passed the ordinary validation:
 * reconcile it with the Computer's live model list (the live-list forms: Codex,
 * Grok, Claude, Cursor, Copilot, and Pi's Configured provider).
 *
 * The ordinary validation knows only the bundled RUNTIME_MODELS: a reasoning
 * effort a model does not declare there is dropped (parseRuntimeConfig's
 * per-model gate), so a live-only model's `max` would silently become null, and
 * a model only the live list names would be stored as custom. Here, when the
 * probe is live and lists the selected model, the live option decides: the
 * model is a preset, and the submitted effort is kept if the option offers it
 * and refused (400 /formValues/reasoningEffort) if not. When the probe is not
 * live, fails, or does not list the model, the static rule stands (unchanged).
 * Only asks the Computer when there is something to decide (an effort, or a
 * custom model). Legacy (non-v2) submits never come here.
 */
export async function reconcileRuntimeFormV2SubmissionWithLiveModels(input: {
  runtimeConfig: RuntimeConfig;
  submittedReasoningEffort: unknown;
  machineId: string | null | undefined;
  detect: (machineId: string, runtime: string) => Promise<RuntimeModelSourceOutcome>;
}): Promise<LiveModelReconciliation> {
  const entry = runtimeFormV2Entry(input.runtimeConfig.runtime);
  if (!entry?.reconcileWithLiveModels || !input.machineId) return { kind: "unchanged" };
  const effort = typeof input.submittedReasoningEffort === "string" && input.submittedReasoningEffort
    ? input.submittedReasoningEffort
    : null;
  if (effort === null && input.runtimeConfig.model.kind !== "custom") return { kind: "unchanged" };
  let outcome: RuntimeModelSourceOutcome;
  try {
    outcome = await input.detect(input.machineId, input.runtimeConfig.runtime);
  } catch {
    return { kind: "unchanged" };
  }
  if (outcome.kind !== "live" || outcome.value.models.length === 0) return { kind: "unchanged" };
  return entry.reconcileWithLiveModels(input.runtimeConfig, effort, outcome.value.models);
}

/**
 * A v2 client only has field values, so issues found after assembly (the
 * validation chain reports /runtimeConfig/...) are pointed back at the field the
 * value came from. The assembled config is produced by
 * buildRuntimeConfigFromFormValues, so the mapping is deterministic: the
 * deepest pointer segment that names a form field wins (provider/apiKey ->
 * apiKey, model/id -> model); anything else points at the whole form.
 */
export function formValuesPointerForRuntimeConfigPointer(runtimeId: unknown, pointer: string): string {
  if (!pointer.startsWith("/runtimeConfig")) return pointer;
  const fields = new Set(Object.keys(runtimeFormV2Entry(runtimeId)?.buildForm().dataSchema.properties ?? {}));
  const segments = pointer.split("/").slice(2);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (fields.has(segments[index]!)) return `/formValues/${segments[index]}`;
  }
  return "/formValues";
}

/**
 * The inverse of buildRuntimeConfigFromFormValues, for editing: the stored
 * runtimeConfig as form values keyed by field name. writeOnly fields are never
 * included. Null when the config is not one a v2 form can edit (runtimes
 * without a v2 form, managed provider connections).
 */
export function runtimeFormValuesFromRuntimeConfig(runtimeConfig: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(runtimeConfig)) return null;
  return runtimeFormV2Entry(runtimeConfig.runtime)?.valuesFromRuntimeConfig(runtimeConfig) ?? null;
}

function valueAt(record: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = record;
  for (const key of path) {
    if (!isPlainRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function withValueAt(record: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown> {
  const [key, ...rest] = path;
  if (key === undefined) return record;
  if (rest.length === 0) return { ...record, [key]: value };
  const child = record[key];
  return { ...record, [key]: withValueAt(isPlainRecord(child) ? child : {}, rest, value) };
}

/**
 * API read path: blank every declared write-only secret (except one declared
 * `redactOnAgentRead: false`); the stored value never leaves the server.
 */
export function redactWriteOnlyRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  let redacted = config as unknown as Record<string, unknown>;
  for (const secret of runtimeFormV2Entry(config.runtime)?.writeOnlySecrets ?? []) {
    if (secret.redactOnAgentRead === false) continue;
    const parent = valueAt(redacted, secret.path.slice(0, -1));
    if (!isPlainRecord(parent) || !secret.appliesTo(redacted)) continue;
    redacted = withValueAt(redacted, secret.path, "");
  }
  return redacted as unknown as RuntimeConfig;
}

/**
 * Update path: a request that omits a declared write-only secret keeps the
 * stored one while the runtime is unchanged and the secret's identity holds
 * (RuntimeConfigWriteOnlySecret.keepsIdentity). Anything else is passed through
 * unchanged, so a missing secret still fails the parser.
 */
export function retainOmittedWriteOnlySecrets(incoming: unknown, existing: RuntimeConfig): unknown {
  if (!isPlainRecord(incoming) || typeof incoming.runtime !== "string") return incoming;
  const runtime = incoming.runtime.trim();
  if (runtime !== existing.runtime) return incoming;
  const saved = existing as unknown as Record<string, unknown>;
  let result = incoming;
  for (const secret of runtimeFormV2Entry(runtime)?.writeOnlySecrets ?? []) {
    const parentPath = secret.path.slice(0, -1);
    const key = secret.path[secret.path.length - 1]!;
    const incomingParent = valueAt(result, parentPath);
    if (!isPlainRecord(incomingParent) || Object.hasOwn(incomingParent, key)) continue;
    const kept = valueAt(saved, secret.path);
    if (typeof kept !== "string" || !kept) continue;
    if (!isPlainRecord(valueAt(saved, parentPath)) || !secret.keepsIdentity(result, saved)) continue;
    result = withValueAt(result, secret.path, kept);
  }
  return result;
}
