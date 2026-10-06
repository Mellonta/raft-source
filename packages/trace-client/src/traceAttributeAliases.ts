/**
 * Legacy camelCase spellings of promoted trace attributes and their canonical
 * snake_case keys.
 *
 * The trace backend promotes and groups by the canonical keys only (`agent_id`,
 * `machine_id`, ...). Producers that still emit the legacy spelling are visible
 * per machine but not per agent. The upload worker keeps the same table for
 * de-duplicating equal pairs at the OTLP boundary
 * (packages/trace-upload-worker/src/traces/traceAttributeAliases.ts); it never fills
 * in a missing canonical key, so producers must emit it themselves.
 */
export const LEGACY_TO_CANONICAL_TRACE_ATTRS = {
  serverId: "server_id",
  machineId: "machine_id",
  agentId: "agent_id",
  launchId: "launch_id",
  sessionId: "session_id",
  requestId: "request_id",
  operationId: "operation_id",
  producerFactId: "producer_fact_id",
  daemonInstanceId: "daemon_instance_id",
  clientSeq: "client_seq",
  isHeartbeat: "is_heartbeat",
  daemonVersion: "daemon_version",
  computerVersion: "computer_version",
} as const;

export type LegacyTraceAttributeKey = keyof typeof LEGACY_TO_CANONICAL_TRACE_ATTRS;

export interface WithCanonicalTraceAttributesOptions {
  /**
   * Legacy keys to canonicalize. Defaults to the whole table. Producers that
   * emit *events* should pass only keys whose canonical field is allowed on
   * events by the shared trace field registry
   * (`packages/shared/src/tracing/fields.ts`, `placement`), so the registry
   * and the emitted rows keep agreeing.
   */
  keys?: readonly LegacyTraceAttributeKey[];
}

/**
 * Add the canonical spelling for every legacy key that is present without its
 * canonical twin. An existing canonical value always wins, legacy keys are kept
 * for older readers, and the input is never mutated. Returns the same object
 * when nothing needs adding.
 */
export function withCanonicalTraceAttributes<T extends Record<string, unknown>>(
  attrs: T,
  options: WithCanonicalTraceAttributesOptions = {},
): T {
  const legacyKeys = options.keys ?? (Object.keys(LEGACY_TO_CANONICAL_TRACE_ATTRS) as LegacyTraceAttributeKey[]);
  let out: Record<string, unknown> | undefined;
  for (const legacyKey of legacyKeys) {
    const canonicalKey = LEGACY_TO_CANONICAL_TRACE_ATTRS[legacyKey];
    if (!Object.hasOwn(attrs, legacyKey) || Object.hasOwn(attrs, canonicalKey)) continue;
    const value = attrs[legacyKey];
    if (value === undefined) continue;
    out ??= { ...attrs };
    out[canonicalKey] = value;
  }
  return (out ?? attrs) as T;
}
