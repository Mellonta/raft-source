/**
 * raft-agent-status.v1 — a field-level standard inside activity ingest: an
 * activity event may carry `status` (the agent's state AFTER the event, as
 * derived by the runtime's compat layer) and an optional one-line `detail`.
 * Raft keeps the latest status by `occurredAt` and applies its own presence
 * floor. See manual/agent-knowledge/external-agent.md.
 */
export const RAFT_AGENT_STATUS_STANDARD = "raft-agent-status.v1" as const;
export const RAFT_AGENT_STATUS_VALUES = ["online", "thinking", "working", "error", "offline"] as const;
export type RaftAgentStatus = (typeof RAFT_AGENT_STATUS_VALUES)[number];
export const RAFT_AGENT_STATUS_DETAIL_LIMIT = 200;
/**
 * Hook-outcome values the `status` field carried before raft-agent-status.v1
 * (tool started/succeeded/failed). Still accepted on hook events and ignored
 * for status, so existing bridges keep working.
 */
export const EXTERNAL_AGENT_ACTIVITY_LEGACY_STATUS_VALUES = ["started", "succeeded", "failed", "completed"] as const;

export function isRaftAgentStatus(value: unknown): value is RaftAgentStatus {
  return typeof value === "string" && (RAFT_AGENT_STATUS_VALUES as readonly string[]).includes(value);
}

export function isExternalAgentActivityLegacyStatus(value: unknown): boolean {
  return typeof value === "string" && (EXTERNAL_AGENT_ACTIVITY_LEGACY_STATUS_VALUES as readonly string[]).includes(value);
}
