import type { DeliveryConsumptionActivityDiagnostic } from "@botiverse/raft-shared";

/**
 * task #1116 — server-side normalizer for the daemon's typed
 * delivery-consumption carrier (task #1114 observation). The server passes the
 * carrier through to the socket payload and to `getActivity()` read-back; it
 * never interprets it, so the only job here is shape validation so a malformed
 * or hostile daemon frame cannot smuggle arbitrary payloads into the web.
 * Ids, classes, counts and times only — never message text or credentials.
 */

const DELIVERY_PATHS = new Set<NonNullable<DeliveryConsumptionActivityDiagnostic["lastDeliveryPath"]>>([
  "stdin_idle_delivery",
  "stdin_turn_end_delivery",
  "busy_stdin_notification",
  "app_inbox_notice",
]);
const CONSUMPTION_KINDS = new Set<NonNullable<DeliveryConsumptionActivityDiagnostic["lastConsumptionKind"]>>([
  "thinking",
  "text",
  "tool_call",
  "tool_output",
  "turn_end",
]);
const MAX_ID_LENGTH = 256;

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNullableNonNegativeInt(value: unknown): value is number | null {
  return value === null || isNonNegativeInt(value);
}

function isNullableShortString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= MAX_ID_LENGTH);
}

function normalizeLastRuntimeResult(
  value: unknown,
): { ok: true; value: DeliveryConsumptionActivityDiagnostic["lastRuntimeResult"] } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (!value || typeof value !== "object") return { ok: false };
  const candidate = value as Record<string, unknown>;
  if (!isNonNegativeInt(candidate.atMs)) return { ok: false };
  if (candidate.kind === "completed") {
    if (typeof candidate.empty !== "boolean") return { ok: false };
    return { ok: true, value: { kind: "completed", atMs: candidate.atMs, empty: candidate.empty } };
  }
  if (candidate.kind === "error") {
    if (typeof candidate.errorClass !== "string" || candidate.errorClass.length > MAX_ID_LENGTH) return { ok: false };
    return { ok: true, value: { kind: "error", atMs: candidate.atMs, errorClass: candidate.errorClass } };
  }
  return { ok: false };
}

export function normalizeDeliveryConsumptionActivityDiagnostic(
  value: DeliveryConsumptionActivityDiagnostic | Record<string, unknown> | null | undefined,
): DeliveryConsumptionActivityDiagnostic | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.launchId !== "string" || candidate.launchId.length === 0 || candidate.launchId.length > MAX_ID_LENGTH) return null;
  if (!isNonNegativeInt(candidate.episode) || candidate.episode < 1) return null;
  if (!isNonNegativeInt(candidate.unconsumedDeliveries)) return null;
  if (!isNullableNonNegativeInt(candidate.firstUnconsumedAtMs)) return null;
  if (!isNullableNonNegativeInt(candidate.lastDeliveryAtMs)) return null;
  if (!isNullableShortString(candidate.lastDeliveryKey)) return null;
  if (candidate.lastDeliveryPath !== null && !DELIVERY_PATHS.has(candidate.lastDeliveryPath as never)) return null;
  if (candidate.lastConsumptionKind !== null && !CONSUMPTION_KINDS.has(candidate.lastConsumptionKind as never)) return null;
  if (!isNullableNonNegativeInt(candidate.lastConsumptionAtMs)) return null;
  const lastRuntimeResult = normalizeLastRuntimeResult(candidate.lastRuntimeResult);
  if (!lastRuntimeResult.ok) return null;
  if (!isNullableShortString(candidate.lastDeliveryErrorClass)) return null;
  if (typeof candidate.processAlive !== "boolean") return null;
  return {
    launchId: candidate.launchId,
    episode: candidate.episode,
    unconsumedDeliveries: candidate.unconsumedDeliveries,
    firstUnconsumedAtMs: candidate.firstUnconsumedAtMs,
    lastDeliveryAtMs: candidate.lastDeliveryAtMs,
    lastDeliveryKey: candidate.lastDeliveryKey,
    lastDeliveryPath: candidate.lastDeliveryPath as DeliveryConsumptionActivityDiagnostic["lastDeliveryPath"],
    lastConsumptionKind: candidate.lastConsumptionKind as DeliveryConsumptionActivityDiagnostic["lastConsumptionKind"],
    lastConsumptionAtMs: candidate.lastConsumptionAtMs,
    lastRuntimeResult: lastRuntimeResult.value,
    lastDeliveryErrorClass: candidate.lastDeliveryErrorClass,
    processAlive: candidate.processAlive,
  };
}
