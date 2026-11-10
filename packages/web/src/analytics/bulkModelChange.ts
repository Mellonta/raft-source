import { browserPrivacyMode } from "@botiverse/raft-shared/src/browserPrivacy";
// Bulk "Change model" usage events (RFC-067 registry: bulk_model_change_*).
// Contract agreed with John in #raft-botiverse-user-analytics (2026-10-14).
// One operation_id per dialog open links opened / closed / submitted /
// finished. No model names, agent ids or error text are sent.

import type { ProductEventName, ProductEventProperties } from "@botiverse/raft-shared";
import { trackEvent } from "./track";

export type BulkModelChangeEntry = NonNullable<ProductEventProperties<"bulk_model_change_opened">["entry"]>;
export type BulkModelChangeClosedStep = NonNullable<ProductEventProperties<"bulk_model_change_closed">["step"]>;

/**
 * What is known about one agent after Apply. `restart_pending` and
 * `save_failed` come from a fresh read after the request failed; when that
 * read fails too the result is `unconfirmed`, even though the dialog shows it
 * as unfinished, because the change may have been saved.
 */
export type BulkModelChangeAgentResult = "succeeded" | "restart_pending" | "save_failed" | "unconfirmed";

export interface BulkModelChangeOperation {
  /** Random per dialog open; links the four events. */
  readonly id: string;
  /**
   * The server the dialog was opened in. Every event of the operation goes
   * there, even if the user switches servers while Apply is still running.
   */
  readonly serverId: string | undefined;
}

export function newBulkModelChangeOperation(serverId: string | undefined): BulkModelChangeOperation {
  return { id: browserPrivacyMode() ? "" : crypto.randomUUID(), serverId };
}

function trackOperationEvent<E extends ProductEventName>(
  operation: BulkModelChangeOperation,
  event: E,
  props: ProductEventProperties<E>,
): void {
  // No server at open: nothing to attribute to, and never the current one.
  if (!operation.serverId) return;
  trackEvent(event, props, { serverId: operation.serverId });
}

export function trackBulkModelChangeOpened(
  operation: BulkModelChangeOperation,
  entry: BulkModelChangeEntry,
  agentCount: number,
): void {
  trackOperationEvent(operation, "bulk_model_change_opened", { operation_id: operation.id, entry, agent_count: agentCount });
}

/** Closed before Apply. Not sent once Apply started: finished covers that. */
export function trackBulkModelChangeClosed(operation: BulkModelChangeOperation, step: BulkModelChangeClosedStep): void {
  trackOperationEvent(operation, "bulk_model_change_closed", { operation_id: operation.id, step });
}

export function trackBulkModelChangeSubmitted(
  operation: BulkModelChangeOperation,
  counts: { change: number; restartOnly: number; skip: number },
): void {
  trackOperationEvent(operation, "bulk_model_change_submitted", {
    operation_id: operation.id,
    change_count: counts.change,
    restart_only_count: counts.restartOnly,
    skip_count: counts.skip,
  });
}

export function summarizeBulkModelChangeResults(
  results: readonly BulkModelChangeAgentResult[],
): Omit<ProductEventProperties<"bulk_model_change_finished">, "operation_id" | "duration_ms"> {
  const count = (result: BulkModelChangeAgentResult) => results.filter((r) => r === result).length;
  const succeeded = count("succeeded");
  return {
    outcome: succeeded === results.length ? "all_succeeded" : succeeded === 0 ? "none_succeeded" : "partial",
    succeeded_count: succeeded,
    restart_pending_count: count("restart_pending"),
    save_failed_count: count("save_failed"),
    unconfirmed_count: count("unconfirmed"),
  };
}

export function trackBulkModelChangeFinished(
  operation: BulkModelChangeOperation,
  results: readonly BulkModelChangeAgentResult[],
  durationMs: number,
): void {
  trackOperationEvent(operation, "bulk_model_change_finished", {
    operation_id: operation.id,
    ...summarizeBulkModelChangeResults(results),
    duration_ms: Math.max(0, Math.round(durationMs)),
  });
}
