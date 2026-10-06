/**
 * Runtime form protocol v2: a server-described form that clients render by field
 * type, not by field name, and that they must accept even when it contains
 * things they have never seen. See README.md, "Protocol v2".
 *
 * v1 pinned every field, title and order per schemaVersion, so any server change
 * broke installed clients. In v2 the server may add optional fields, change copy,
 * add options and reorder freely; only a new required field or a new field kind a
 * client cannot render is breaking, and a client shows that as "update to edit"
 * instead of dropping the form.
 */
import type { AgentCreateFormDefinition } from "@botiverse/raft-shared";

import type { RuntimeFormV2Definition, RuntimeFormV2OptionsFrom } from "./generated/runtimeFormV2";

export const RUNTIME_FORM_V2_PROTOCOL_VERSION = 2;

/** Field schema key naming the optionSources entry that supplies its choices. */
export const RUNTIME_FORM_V2_OPTION_SOURCE_KEY = "x-optionSource";

export type {
  RuntimeFormV2Definition,
  RuntimeFormV2Option,
  RuntimeFormV2OptionSource,
  RuntimeFormV2SubmitRef,
  RuntimeFormV2Submission,
} from "./generated/runtimeFormV2";

/**
 * Server producer: the v2 body for a form the server builds for v1. The shape is
 * the same; v2 adds protocolVersion 2 and marks each option-backed field with
 * the source that supplies it, so a client can render it without knowing its name.
 */
export function toRuntimeFormV2(
  definition: AgentCreateFormDefinition,
  derivedOptions: Record<string, RuntimeFormV2OptionsFrom> = DERIVED_OPTIONS[definition.runtimeId] ?? {},
): RuntimeFormV2Definition {
  const v2 = structuredClone(definition) as unknown as RuntimeFormV2Definition;
  v2.protocolVersion = RUNTIME_FORM_V2_PROTOCOL_VERSION;
  for (const [sourceId, source] of Object.entries(v2.optionSources ?? {})) {
    const key = propertyKey(source.pointer);
    const field = key ? v2.dataSchema.properties[key] : undefined;
    if (field) field[RUNTIME_FORM_V2_OPTION_SOURCE_KEY] = sourceId;
  }
  for (const [key, from] of Object.entries(derivedOptions)) {
    const field = v2.dataSchema.properties[key];
    if (field) field[RUNTIME_FORM_V2_OPTIONS_FROM_KEY] = from;
  }
  return v2;
}

/**
 * Client capability names a v2 form may list in `requiredClientCapabilities`.
 * Reserved by the contract and frozen: a name keeps its meaning forever.
 */
export const RUNTIME_FORM_V2_RESERVED_CLIENT_CAPABILITIES = [
  "select.custom_value",
  "choice.labels",
  "option_source.status",
] as const;

export type RuntimeFormV2ClientCapability = (typeof RUNTIME_FORM_V2_RESERVED_CLIENT_CAPABILITIES)[number];

/**
 * `OptionSource.status` (capability `option_source.status`), best to worst.
 * One status per source; when a source combines several probes the worst wins.
 */
export const RUNTIME_FORM_V2_OPTION_SOURCE_STATUSES = ["live", "fallback", "unavailable"] as const;
export type RuntimeFormV2OptionSourceStatus = (typeof RUNTIME_FORM_V2_OPTION_SOURCE_STATUSES)[number];

/** `OptionSource.reason`: why a source is not live. Clients must also accept names not listed here. */
export const RUNTIME_FORM_V2_OPTION_SOURCE_REASONS = [
  "probe_timeout",
  "probe_failed",
  "missing_config",
  "no_models",
  "unsupported",
  "machine_offline",
] as const;
export type RuntimeFormV2OptionSourceReason = (typeof RUNTIME_FORM_V2_OPTION_SOURCE_REASONS)[number];

/** The worse of two source statuses (unavailable > fallback > live). */
export function worseRuntimeFormV2OptionSourceStatus(
  a: RuntimeFormV2OptionSourceStatus,
  b: RuntimeFormV2OptionSourceStatus,
): RuntimeFormV2OptionSourceStatus {
  const rank = (status: RuntimeFormV2OptionSourceStatus) => RUNTIME_FORM_V2_OPTION_SOURCE_STATUSES.indexOf(status);
  return rank(b) > rank(a) ? b : a;
}

/**
 * What the parser records when `requiredClientCapabilities` is present but not
 * a list of strings. No client implements it, so such a form is unavailable
 * (fail closed) rather than rendered on a guess.
 */
export const RUNTIME_FORM_V2_MALFORMED_CAPABILITY = "(malformed requiredClientCapabilities)";

function requiredClientCapabilities(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return [RUNTIME_FORM_V2_MALFORMED_CAPABILITY];
  return [...new Set(value as string[])];
}

/**
 * The capabilities a form requires that this client does not implement. Non-empty
 * means the whole v2 form is unavailable to this client: fall back to v1/legacy,
 * never render part of it (README, "Protocol v2").
 */
export function missingRuntimeFormV2Capabilities(
  form: Pick<ParsedRuntimeFormV2, "requiredClientCapabilities">,
  supported: ReadonlySet<string>,
): string[] {
  return form.requiredClientCapabilities.filter((capability) => !supported.has(capability));
}

/** Field schema key: choices come from the option selected in another field. */
export const RUNTIME_FORM_V2_OPTIONS_FROM_KEY = "x-optionsFrom";

/**
 * Fields whose choices follow the option selected in another field. v1 left
 * these to per-runtime client code (the web special-cased Kimi effort); v2
 * states them so a client needs no runtime knowledge.
 */
const DERIVED_OPTIONS: Record<string, Record<string, RuntimeFormV2OptionsFrom>> = {
  "kimi-sdk": {
    reasoningEffort: { field: "model", attribute: "supportedReasoningEfforts", defaultAttribute: "defaultReasoningEffort" },
  },
};

export type RuntimeFormV2FieldKind =
  | "text"
  | "secret"
  | "url"
  | "boolean"
  | "string_map"
  | "select"
  | "dependent_select"
  | "derived_select"
  | "unsupported";

/** Display copy for one choice (FieldCopy.choices, capability `choice.labels`). */
export type RuntimeFormV2ChoiceCopy = { label: string; description?: string };

export type RuntimeFormV2Field = {
  key: string;
  kind: RuntimeFormV2FieldKind;
  required: boolean;
  advanced: boolean;
  label: string;
  hint?: string;
  placeholder?: string;
  /** For select/dependent_select: the optionSources id to load choices from. */
  optionSourceId?: string;
  /** For dependent_select: the field key whose value selects the option list. */
  dependsOn?: string;
  /** For derived_select: choices are `attribute` of the option selected in `key`. */
  derivedFrom?: { key: string; attribute: string; defaultAttribute?: string };
  /** Copy for this field's choices by option value (`choice.labels`); see runtimeFormV2Choices. */
  choices?: Record<string, RuntimeFormV2ChoiceCopy>;
  /** Shown only when every rule matches; empty means always shown. */
  visibleWhen: Array<{ key: string; in: string[] }>;
};

export type RuntimeFormV2OptionSourceRef = {
  sourceId: string;
  kind: "select" | "dependent_select";
  key: string;
  dependsOn?: string;
};

export type ParsedRuntimeFormV2 = {
  runtimeId: string;
  schemaVersion: string;
  fields: RuntimeFormV2Field[];
  optionSources: Record<string, RuntimeFormV2OptionSourceRef>;
  /**
   * A required field this client cannot render. The form still shows, but the
   * client must not submit it and should ask the user to update.
   */
  blockingFieldKeys: string[];
  /**
   * Capabilities the client must implement to use this form at all ([] when the
   * server sends none). See missingRuntimeFormV2Capabilities.
   */
  requiredClientCapabilities: string[];
  /** Edit only: the agent's current values by field key (writeOnly fields absent). */
  values?: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stringOr = (value: unknown, fallback?: string) => (typeof value === "string" ? value : fallback);

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function propertyKey(pointer: unknown): string | null {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) return null;
  const key = pointer.slice(1);
  return key && !key.includes("/") ? key : null;
}

/**
 * Client parser. Tolerant by contract: unknown keys anywhere are ignored, an
 * unknown field kind becomes "unsupported" rather than rejecting the form.
 * Returns null only when the body is not a v2 form at all.
 */
export function parseRuntimeFormV2(value: unknown): ParsedRuntimeFormV2 | null {
  if (!isRecord(value) || value.protocolVersion !== RUNTIME_FORM_V2_PROTOCOL_VERSION) return null;
  const dataSchema = isRecord(value.dataSchema) ? value.dataSchema : null;
  const properties = dataSchema && isRecord(dataSchema.properties) ? dataSchema.properties : null;
  if (!properties) return null;

  const uiSchema = isRecord(value.uiSchema) ? value.uiSchema : {};
  const layout = isRecord(uiSchema.layout) ? uiSchema.layout : {};
  const localization = isRecord(uiSchema.localization) ? uiSchema.localization : {};
  const required = new Set(stringArray(dataSchema?.required));
  const advanced = new Set(stringArray(layout.advanced).map(propertyKey).filter((key): key is string => key !== null));

  const optionSources: Record<string, RuntimeFormV2OptionSourceRef> = {};
  if (isRecord(value.optionSources)) {
    for (const [sourceId, source] of Object.entries(value.optionSources)) {
      if (!isRecord(source)) continue;
      const key = propertyKey(source.pointer);
      if (!key || (source.kind !== "select" && source.kind !== "dependent_select")) continue;
      const dependsOn = source.kind === "dependent_select" ? propertyKey(source.dependsOn) : undefined;
      if (source.kind === "dependent_select" && !dependsOn) continue;
      optionSources[sourceId] = { sourceId, kind: source.kind, key, ...(dependsOn ? { dependsOn } : {}) };
    }
  }

  const visibility = new Map<string, Array<{ key: string; in: string[] }>>();
  for (const rule of Array.isArray(uiSchema.visibility) ? uiSchema.visibility : []) {
    if (!isRecord(rule) || !isRecord(rule.when)) continue;
    const key = propertyKey(rule.pointer);
    const on = propertyKey(rule.when.pointer);
    if (!key || !on) continue;
    visibility.set(key, [...(visibility.get(key) ?? []), { key: on, in: stringArray(rule.when.in) }]);
  }

  const declaredOrder = stringArray(uiSchema.order).filter((key) => key in properties);
  const order = [...new Set([...declaredOrder, ...Object.keys(properties)])];

  const fields: RuntimeFormV2Field[] = [];
  for (const key of order) {
    const schema = properties[key];
    if (!isRecord(schema)) continue;
    const copy = isRecord(localization[key]) ? localization[key] : {};
    const sourceId = stringOr(schema[RUNTIME_FORM_V2_OPTION_SOURCE_KEY]);
    const source = sourceId ? optionSources[sourceId] : undefined;
    const derived = derivedFrom(schema[RUNTIME_FORM_V2_OPTIONS_FROM_KEY], properties);
    const field: RuntimeFormV2Field = {
      key,
      kind: fieldKind(schema, source, derived),
      required: required.has(key),
      advanced: advanced.has(key),
      label: stringOr(copy.label, stringOr(schema.title, key))!,
      visibleWhen: visibility.get(key) ?? [],
    };
    const hint = stringOr(copy.hint);
    const placeholder = stringOr(copy.placeholder);
    if (hint) field.hint = hint;
    if (placeholder) field.placeholder = placeholder;
    if (source) {
      field.optionSourceId = source.sourceId;
      if (source.dependsOn) field.dependsOn = source.dependsOn;
    }
    if (derived) field.derivedFrom = derived;
    const choices = choiceCopy(copy.choices);
    if (choices) field.choices = choices;
    fields.push(field);
  }

  return {
    runtimeId: stringOr(value.runtimeId, "")!,
    schemaVersion: stringOr(value.schemaVersion, "")!,
    fields,
    optionSources,
    blockingFieldKeys: fields.filter((field) => field.kind === "unsupported" && field.required).map((field) => field.key),
    requiredClientCapabilities: requiredClientCapabilities(value.requiredClientCapabilities),
    ...(isRecord(value.values) ? { values: value.values } : {}),
  };
}

/** FieldCopy.choices, keeping only entries with a string label; unknown keys inside an entry are ignored. */
function choiceCopy(value: unknown): Record<string, RuntimeFormV2ChoiceCopy> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, RuntimeFormV2ChoiceCopy> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry) || typeof entry.label !== "string") continue;
    out[key] = { label: entry.label, ...(typeof entry.description === "string" ? { description: entry.description } : {}) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function derivedFrom(value: unknown, properties: Record<string, unknown>): RuntimeFormV2Field["derivedFrom"] {
  if (!isRecord(value) || typeof value.field !== "string" || typeof value.attribute !== "string") return undefined;
  if (!(value.field in properties)) return undefined;
  const defaultAttribute = stringOr(value.defaultAttribute);
  return { key: value.field, attribute: value.attribute, ...(defaultAttribute ? { defaultAttribute } : {}) };
}

function fieldKind(
  schema: Record<string, unknown>,
  source: RuntimeFormV2OptionSourceRef | undefined,
  derived: RuntimeFormV2Field["derivedFrom"],
): RuntimeFormV2FieldKind {
  if (schema.type === "string") {
    if (source) return source.kind;
    if (derived) return "derived_select";
    if (schema.writeOnly === true) return "secret";
    if (schema.format === "uri") return "url";
    return "text";
  }
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "object" && isRecord(schema.additionalProperties) && schema.additionalProperties.type === "string") {
    return "string_map";
  }
  return "unsupported";
}
