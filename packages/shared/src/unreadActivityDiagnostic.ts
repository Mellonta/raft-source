/**
 * Unread/Activity diagnostic v1.
 *
 * D3-f coverage is part of this module, not only a chat note:
 * Computer (Wug, task 882) and Desktop (desktop-dev, task 123) are covered.
 * Web D3-f is covered only at PR #8304 head 8db008ffe.
 * Server does not run D3-f.
 */

export const UNREAD_ACTIVITY_DIAGNOSTIC_SCHEMA_VERSION =
  "unread-activity-diagnostic.v1" as const;

export const UNREAD_ACTIVITY_DIAGNOSTIC_CAPS = {
  maxServers: 32,
  maxRows: 64,
  maxCanonicalBytes: 65536,
} as const;

export const UNREAD_ACTIVITY_DIAGNOSTIC_SYSTEM_IDENTIFIER_NOTE =
  "View name, build id, and catalog fingerprint identify a system artifact, not a person.";

export const UNREAD_ACTIVITY_DIAGNOSTIC_D3F_COVERAGE = {
  computer: { executor: "Wug", task: 882, covered: true },
  desktop: { executor: "desktop-dev", task: 123, covered: true },
  web: {
    executor: "Josh",
    task: 664,
    covered: true,
    head: "8db008ffeacd1b111b9b4f6270fca16a19a65863",
  },
} as const;

export const UNREAD_ACTIVITY_DIAGNOSTIC_CODES = [
  "schema_mismatch",
  "forbidden_field",
  "unknown_field",
  "invalid_shape",
] as const;

export type UnreadActivityDiagnosticCode =
  (typeof UNREAD_ACTIVITY_DIAGNOSTIC_CODES)[number];

export type UnreadActivityDiagnosticPrivacyClass =
  | "allowed"
  | "digest_only"
  | "forbidden";

export interface UnreadActivityDiagnosticField {
  path: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  required: boolean;
  nullable: boolean;
  privacyClass: UnreadActivityDiagnosticPrivacyClass;
  enum?: readonly string[];
  caps?: { maxItems?: number; maxBytes?: number };
  invariantIds: readonly string[];
}

const STATUS_VALUES = [
  "ok",
  "stale",
  "mixed_generation",
  "unknown",
  "error",
] as const;

export type UnreadActivityDiagnosticStatus = (typeof STATUS_VALUES)[number];

export const unreadActivityDiagnosticManifest = [
  field("schema_version", "string", true, false, "allowed", ["schema_version"], {
    enum: [UNREAD_ACTIVITY_DIAGNOSTIC_SCHEMA_VERSION],
  }),
  field("manifest_digest", "string", true, false, "allowed", ["manifest_digest"]),
  field("diagnostic_correlation_id", "string", true, false, "digest_only", [
    "token_format",
  ]),
  field("build_id", "string", true, false, "allowed", ["system_identifier"]),
  field("value_at", "string", true, false, "allowed", ["value_at"]),
  field("membership_truncated", "number", true, false, "allowed", [
    "membership_cap",
  ]),
  field("views", "array", true, false, "allowed", ["row_cap"], {
    caps: { maxItems: UNREAD_ACTIVITY_DIAGNOSTIC_CAPS.maxRows },
  }),
  field("views[].requested_name", "string", true, false, "allowed", [
    "system_identifier",
  ]),
  field("views[].served_name", "string", true, false, "allowed", [
    "system_identifier",
  ]),
  field("views[].catalog_fingerprint", "string", true, false, "allowed", [
    "system_identifier",
  ]),
  field("views[].system_identifier_note", "string", true, false, "allowed", [
    "system_identifier_note",
  ]),
  field("totals", "array", true, false, "allowed", ["server_cap"], {
    caps: { maxItems: UNREAD_ACTIVITY_DIAGNOSTIC_CAPS.maxServers },
  }),
  field("totals[].row_present", "boolean", true, false, "allowed", ["row_present"]),
  field("totals[].status", "string", true, false, "allowed", ["status_enum"], {
    enum: STATUS_VALUES,
  }),
  field("totals[].value", "number", true, true, "allowed", ["zero_requires_generation"]),
  field("totals[].generation", "string", true, true, "allowed", ["generation"]),
  field("totals[].value_at", "string", true, false, "allowed", ["value_at"]),
  field("totals[].last_nonempty_at", "string", false, false, "allowed", [
    "last_nonempty_same_source",
  ]),
  field("aggregates", "object", true, false, "allowed", ["aggregates"]),
  field("aggregates.served_row_count", "number", true, false, "allowed", ["count"]),
  field("aggregates.suppressed_row_count", "number", true, false, "allowed", [
    "count",
  ]),
  field("aggregates.watermark", "number", true, false, "allowed", ["count"]),
  field("aggregates.mute_rows_before", "number", true, false, "allowed", ["count"]),
  field("aggregates.mute_rows_at_or_after", "number", true, false, "allowed", [
    "count",
  ]),
  field("aggregates.structural_target_count", "number", true, false, "allowed", [
    "count",
  ]),
  field("aggregates.generation_gap_bucket", "string", true, false, "allowed", [
    "generation_gap_bucket",
  ]),
] as const satisfies readonly UnreadActivityDiagnosticField[];

const FORBIDDEN_KEYS = new Set([
  "body",
  "preview",
  "title",
  "name",
  "email",
  "username",
  "userId",
  "user_id",
  "sessionId",
  "session_id",
  "agentId",
  "agent_id",
  "requestId",
  "request_id",
  "messageId",
  "message_id",
  "token",
  "password",
  "credential",
  "env",
  "mute_from_seq",
  "last_read_seq",
]);

const TOP_LEVEL_KEYS = new Set([
  "schema_version",
  "manifest_digest",
  "diagnostic_correlation_id",
  "build_id",
  "value_at",
  "membership_truncated",
  "views",
  "totals",
  "aggregates",
]);

const VIEW_KEYS = new Set([
  "requested_name",
  "served_name",
  "catalog_fingerprint",
  "system_identifier_note",
]);

const TOTAL_KEYS = new Set([
  "row_present",
  "status",
  "value",
  "generation",
  "value_at",
  "last_nonempty_at",
]);

const AGGREGATE_KEYS = new Set([
  "served_row_count",
  "suppressed_row_count",
  "watermark",
  "mute_rows_before",
  "mute_rows_at_or_after",
  "structural_target_count",
  "generation_gap_bucket",
]);

export interface UnreadActivityDiagnosticView {
  requested_name: string;
  served_name: string;
  catalog_fingerprint: string;
  system_identifier_note: string;
}

export interface UnreadActivityDiagnosticTotal {
  row_present: boolean;
  status: UnreadActivityDiagnosticStatus;
  value: number | null;
  generation: string | null;
  value_at: string;
  last_nonempty_at?: string;
}

export interface UnreadActivityDiagnosticAggregates {
  served_row_count: number;
  suppressed_row_count: number;
  watermark: number;
  mute_rows_before: number;
  mute_rows_at_or_after: number;
  structural_target_count: number;
  generation_gap_bucket: string;
}

export interface UnreadActivityDiagnosticDocument {
  schema_version: typeof UNREAD_ACTIVITY_DIAGNOSTIC_SCHEMA_VERSION;
  manifest_digest: string;
  diagnostic_correlation_id: string;
  build_id: string;
  value_at: string;
  membership_truncated: number;
  views: UnreadActivityDiagnosticView[];
  totals: UnreadActivityDiagnosticTotal[];
  aggregates: UnreadActivityDiagnosticAggregates;
}

export type ValidateUnreadActivityDiagnosticResult =
  | {
      ok: true;
      canonicalJson: string;
      document: UnreadActivityDiagnosticDocument;
    }
  | { ok: false; code: UnreadActivityDiagnosticCode };

/** SHA-256 hex of the canonical executable manifest. The test rejects drift. */
export const UNREAD_ACTIVITY_DIAGNOSTIC_SCHEMA_DIGEST =
  "159a26e3b9112dd024f82cec655ea73d33941732399d9aba0f234f51f9c2f8ee";

export function unreadActivityDiagnosticCanonicalManifestJson(): string {
  return canonicalJson(unreadActivityDiagnosticManifest);
}

export function canonicalUnreadActivityDiagnosticJson(value: unknown): string {
  return canonicalJson(value);
}

export function validateUnreadActivityDiagnostic(
  payload: unknown,
): ValidateUnreadActivityDiagnosticResult {
  const forbidden = findForbiddenKey(payload);
  if (forbidden) return { ok: false, code: "forbidden_field" };
  if (!isRecord(payload)) return { ok: false, code: "invalid_shape" };
  for (const key of Object.keys(payload)) {
    if (!TOP_LEVEL_KEYS.has(key)) return { ok: false, code: "unknown_field" };
  }
  if (
    payload.schema_version !== UNREAD_ACTIVITY_DIAGNOSTIC_SCHEMA_VERSION ||
    payload.manifest_digest !== UNREAD_ACTIVITY_DIAGNOSTIC_SCHEMA_DIGEST
  ) {
    return { ok: false, code: "schema_mismatch" };
  }
  if (!isToken(payload.diagnostic_correlation_id)) {
    return { ok: false, code: "invalid_shape" };
  }
  if (typeof payload.build_id !== "string" || payload.build_id.length === 0) {
    return { ok: false, code: "invalid_shape" };
  }
  if (typeof payload.value_at !== "string" || payload.value_at.length === 0) {
    return { ok: false, code: "invalid_shape" };
  }
  if (!isNonNegativeInteger(payload.membership_truncated)) {
    return { ok: false, code: "invalid_shape" };
  }
  if (!Array.isArray(payload.views) || !Array.isArray(payload.totals)) {
    return { ok: false, code: "invalid_shape" };
  }
  if (payload.views.length > UNREAD_ACTIVITY_DIAGNOSTIC_CAPS.maxRows) {
    return { ok: false, code: "invalid_shape" };
  }
  if (payload.totals.length > UNREAD_ACTIVITY_DIAGNOSTIC_CAPS.maxServers) {
    return { ok: false, code: "invalid_shape" };
  }
  const views: UnreadActivityDiagnosticView[] = [];
  for (const view of payload.views) {
    const parsed = parseView(view);
    if (parsed === "unknown") return { ok: false, code: "unknown_field" };
    if (parsed === null) return { ok: false, code: "invalid_shape" };
    views.push(parsed);
  }
  const totals: UnreadActivityDiagnosticTotal[] = [];
  for (const total of payload.totals) {
    const parsed = parseTotal(total);
    if (parsed === "unknown") return { ok: false, code: "unknown_field" };
    if (parsed === null) return { ok: false, code: "invalid_shape" };
    totals.push(parsed);
  }
  const aggregates = parseAggregates(payload.aggregates);
  if (aggregates === "unknown") return { ok: false, code: "unknown_field" };
  if (aggregates === null) return { ok: false, code: "invalid_shape" };
  const document: UnreadActivityDiagnosticDocument = {
    schema_version: UNREAD_ACTIVITY_DIAGNOSTIC_SCHEMA_VERSION,
    manifest_digest: UNREAD_ACTIVITY_DIAGNOSTIC_SCHEMA_DIGEST,
    diagnostic_correlation_id: payload.diagnostic_correlation_id,
    build_id: payload.build_id,
    value_at: payload.value_at,
    membership_truncated: payload.membership_truncated,
    views,
    totals,
    aggregates,
  };
  let canonicalJson: string;
  try {
    canonicalJson = canonicalUnreadActivityDiagnosticJson(document);
  } catch {
    return { ok: false, code: "invalid_shape" };
  }
  if (utf8ByteLength(canonicalJson) > UNREAD_ACTIVITY_DIAGNOSTIC_CAPS.maxCanonicalBytes) {
    return { ok: false, code: "invalid_shape" };
  }
  return { ok: true, canonicalJson, document };
}

function field(
  path: string,
  type: UnreadActivityDiagnosticField["type"],
  required: boolean,
  nullable: boolean,
  privacyClass: UnreadActivityDiagnosticPrivacyClass,
  invariantIds: readonly string[],
  extra?: { enum?: readonly string[]; caps?: { maxItems?: number; maxBytes?: number } },
): UnreadActivityDiagnosticField {
  return {
    path,
    type,
    required,
    nullable,
    privacyClass,
    invariantIds,
    ...(extra?.enum ? { enum: extra.enum } : {}),
    ...(extra?.caps ? { caps: extra.caps } : {}),
  };
}

function parseView(value: unknown): UnreadActivityDiagnosticView | null | "unknown" {
  if (!isRecord(value)) return null;
  for (const key of Object.keys(value)) {
    if (!VIEW_KEYS.has(key)) return "unknown";
  }
  if (
    typeof value.requested_name !== "string" ||
    typeof value.served_name !== "string" ||
    typeof value.catalog_fingerprint !== "string" ||
    value.system_identifier_note !==
      UNREAD_ACTIVITY_DIAGNOSTIC_SYSTEM_IDENTIFIER_NOTE
  ) {
    return null;
  }
  return {
    requested_name: value.requested_name,
    served_name: value.served_name,
    catalog_fingerprint: value.catalog_fingerprint,
    system_identifier_note: value.system_identifier_note,
  };
}

function parseTotal(
  value: unknown,
): UnreadActivityDiagnosticTotal | null | "unknown" {
  if (!isRecord(value)) return null;
  for (const key of Object.keys(value)) {
    if (!TOTAL_KEYS.has(key)) return "unknown";
  }
  if (typeof value.row_present !== "boolean") return null;
  if (!isStatus(value.status)) return null;
  if (typeof value.value_at !== "string" || value.value_at.length === 0) return null;
  if (!(value.value === null || isNonNegativeInteger(value.value))) return null;
  if (!(value.generation === null || typeof value.generation === "string")) return null;
  if (value.last_nonempty_at !== undefined && typeof value.last_nonempty_at !== "string") {
    return null;
  }
  if (!value.row_present && value.value !== null) return null;
  if (!value.row_present && value.status === "ok") return null;
  if (value.value === 0) {
    if (!value.row_present || value.generation === null || value.generation.length === 0) {
      return null;
    }
  }
  const total: UnreadActivityDiagnosticTotal = {
    row_present: value.row_present,
    status: value.status,
    value: value.value,
    generation: value.generation,
    value_at: value.value_at,
  };
  if (value.last_nonempty_at !== undefined) total.last_nonempty_at = value.last_nonempty_at;
  return total;
}

function parseAggregates(
  value: unknown,
): UnreadActivityDiagnosticAggregates | null | "unknown" {
  if (!isRecord(value)) return null;
  for (const key of Object.keys(value)) {
    if (!AGGREGATE_KEYS.has(key)) return "unknown";
  }
  const counts = [
    value.served_row_count,
    value.suppressed_row_count,
    value.watermark,
    value.mute_rows_before,
    value.mute_rows_at_or_after,
    value.structural_target_count,
  ];
  if (!counts.every(isNonNegativeInteger)) return null;
  if (typeof value.generation_gap_bucket !== "string") return null;
  return {
    served_row_count: value.served_row_count as number,
    suppressed_row_count: value.suppressed_row_count as number,
    watermark: value.watermark as number,
    mute_rows_before: value.mute_rows_before as number,
    mute_rows_at_or_after: value.mute_rows_at_or_after as number,
    structural_target_count: value.structural_target_count as number,
    generation_gap_bucket: value.generation_gap_bucket,
  };
}

function isStatus(value: unknown): value is UnreadActivityDiagnosticStatus {
  return typeof value === "string" && (STATUS_VALUES as readonly string[]).includes(value);
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32,}$/.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(findForbiddenKey);
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || findForbiddenKey(value[key])) return true;
  }
  return false;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("not json");
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
