import { SPAWN_FAILURE_REASONS, type SpawnFailureActivityDiagnostic } from "@botiverse/raft-shared";

/**
 * task #1123 — server-side normalizer for the daemon's typed spawn-failure
 * carrier. The server passes it through to the socket payload and to the
 * activity read-back; it never interprets it, so the only job is shape
 * validation so a malformed or hostile daemon frame cannot smuggle arbitrary
 * payloads into the web. A closed reason enum and a bounded model name only.
 */
const MAX_MODEL_LENGTH = 128;
const REASONS: ReadonlySet<string> = new Set<string>(SPAWN_FAILURE_REASONS);

export function normalizeSpawnFailureActivityDiagnostic(
  value: SpawnFailureActivityDiagnostic | Record<string, unknown> | null | undefined,
): SpawnFailureActivityDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.reason !== "string" || !REASONS.has(candidate.reason)) return null;
  const reason = candidate.reason as SpawnFailureActivityDiagnostic["reason"];
  if (candidate.model === undefined) return { reason };
  if (typeof candidate.model !== "string" || candidate.model.length === 0 || candidate.model.length > MAX_MODEL_LENGTH) return null;
  // Only model_not_found / model_not_configured carry a model; drop it elsewhere rather than echo.
  return reason === "model_not_found" || reason === "model_not_configured" ? { reason, model: candidate.model } : { reason };
}
