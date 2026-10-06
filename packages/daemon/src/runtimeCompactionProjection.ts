import type { ParsedEvent } from "./drivers/types";
import {
  getRuntimeDisplayName,
  RUNTIME_ERROR_CLASSES,
  RUNTIME_ERROR_REASON_PROVENANCES,
  RUNTIME_ERROR_REASONS,
  runtimeErrorReasonForClass,
  type RuntimeCompactionInterruption,
  type RuntimeErrorActivityDiagnostic,
} from "@botiverse/raft-shared";
import { formatRuntimeInputTooLargeMessage } from "./runtimeErrorDiagnostics";

export type RuntimeCompactionReason = "manual" | "threshold" | "overflow" | "unknown";
export type RuntimeCompactionOutcome = "compaction_failed_or_exhausted" | "aborted" | "unknown";
export type RuntimeCompactionFailureReason = "recovery_exhausted" | "input_too_large" | "compaction_failed" | "unknown";

type CompactionInput = {
  outcome?: unknown;
  reason?: unknown;
  failureReason?: unknown;
  willRetry?: unknown;
  failureDiagnostic?: unknown;
};

const RUNTIME_ERROR_CLASS_SET = new Set<string>(RUNTIME_ERROR_CLASSES);
const RUNTIME_ERROR_REASON_SET = new Set<string>(RUNTIME_ERROR_REASONS);
const RUNTIME_ERROR_REASON_PROVENANCE_SET = new Set<string>(RUNTIME_ERROR_REASON_PROVENANCES);

function normalizeCompactionFailureDiagnostic(value: unknown): RuntimeErrorActivityDiagnostic | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.errorClass !== "string"
    || !RUNTIME_ERROR_CLASS_SET.has(candidate.errorClass)
    || typeof candidate.errorReason !== "string"
    || !RUNTIME_ERROR_REASON_SET.has(candidate.errorReason)
    || candidate.errorReason !== runtimeErrorReasonForClass(candidate.errorClass as RuntimeErrorActivityDiagnostic["errorClass"])
    || typeof candidate.fingerprint !== "string"
    || !/^[0-9a-f]{16}$/.test(candidate.fingerprint)
    || candidate.reasonProvenance !== "runtime_error_event"
    || !RUNTIME_ERROR_REASON_PROVENANCE_SET.has(candidate.reasonProvenance)
    || candidate.nativeReasonPresent !== undefined
  ) return undefined;
  return {
    errorClass: candidate.errorClass as RuntimeErrorActivityDiagnostic["errorClass"],
    errorReason: candidate.errorReason as RuntimeErrorActivityDiagnostic["errorReason"],
    fingerprint: candidate.fingerprint,
    reasonProvenance: "runtime_error_event",
  };
}

export function normalizeRuntimeCompactionReason(value: unknown): RuntimeCompactionReason {
  switch (value) {
    case "manual":
    case "threshold":
    case "overflow":
      return value;
    default:
      return "unknown";
  }
}

function normalizeRuntimeCompactionOutcome(value: unknown): RuntimeCompactionOutcome {
  switch (value) {
    case "compaction_failed_or_exhausted":
    case "aborted":
      return value;
    default:
      return "unknown";
  }
}

function normalizeRuntimeCompactionFailureReason(value: unknown): RuntimeCompactionFailureReason {
  switch (value) {
    case "recovery_exhausted":
    case "input_too_large":
    case "compaction_failed":
      return value;
    default:
      return "unknown";
  }
}

export function projectCompactionInterruptionTraceAttrs(
  event: CompactionInput,
): Record<string, string> {
  const facts = projectCompactionInterruption(event);
  return {
    outcome: facts.outcome,
    reason: facts.reason,
    ...(facts.failureReason !== undefined
      ? { failure_reason: facts.failureReason }
      : {}),
    will_retry: String(facts.willRetry),
    ...(facts.failureDiagnostic
      ? {
          failure_error_class: facts.failureDiagnostic.errorClass,
          failure_error_reason: facts.failureDiagnostic.errorReason,
          failure_error_fingerprint: facts.failureDiagnostic.fingerprint,
        }
      : {}),
  };
}

export function projectCompactionInterruption(
  event: CompactionInput,
): RuntimeCompactionInterruption {
  const failureDiagnostic = normalizeCompactionFailureDiagnostic(event.failureDiagnostic);
  return {
    outcome: normalizeRuntimeCompactionOutcome(event.outcome),
    reason: normalizeRuntimeCompactionReason(event.reason),
    ...(event.failureReason !== undefined
      ? { failureReason: normalizeRuntimeCompactionFailureReason(event.failureReason) }
      : {}),
    willRetry: typeof event.willRetry === "boolean" ? event.willRetry : "unknown",
    ...(failureDiagnostic ? { failureDiagnostic } : {}),
  };
}

export function formatCompactionInterruption(facts: RuntimeCompactionInterruption): string {
  if (facts.outcome === "aborted") return "Context compaction aborted";
  if (facts.failureReason === "recovery_exhausted") return "Context compaction recovery exhausted: input is still too large after compacting and retrying";
  if (facts.failureReason === "input_too_large") return "Context compaction failed: the summarization request exceeded the model input limit";
  if (facts.failureReason === "compaction_failed") return "Context compaction failed; no successful summary was reported";
  return "Context compaction interrupted; completion was not confirmed";
}

export function projectStructuredRuntimeTerminalFailure(
  event: ParsedEvent,
  runtimeId: string,
): { detail: string; actionRequired: false; entries?: never } | null {
  return event.kind === "error" && event.terminalReason === "compaction_failed_or_exhausted"
    ? {
        // Older structured events lack a failure reason. Preserve their known
        // classifier, but never infer overflow from the terminal flag alone.
        detail: event.compaction?.failureReason === "input_too_large" || event.compaction?.failureReason === "recovery_exhausted"
          || (event.compaction === undefined && event.message === "InputTooLargeError")
          ? formatRuntimeInputTooLargeMessage(runtimeId)
          : `${getRuntimeDisplayName(runtimeId)} context compaction failed. No successful summary was reported; inspect the runtime diagnostics before retrying.`,
        actionRequired: false,
      }
    : null;
}
