/**
 * Tier-1 machine-side context for a feedback transcript upload: reads THIS
 * machine's local daemon trace corpus and summarizes the failures observed in
 * a requested window.
 *
 * The wire contract — the types, the closed span vocabulary, the converters,
 * and every statement about what this summary refuses to mean — lives in
 * `@botiverse/raft-shared`, because the server must validate an incoming
 * summary against the same closed set. Writing that set twice is what produced
 * the `non_member_mention` incident. Read the boundaries there; this file is
 * only the reader.
 *
 * Re-exported below so existing importers of this module keep working.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  FAILURE_STATUS,
  normalizeTraceInstant,
  toObservedFailureSpan,
  traceRecordStatus,
  traceRecordTime,
  type FailureAttribution,
  type ObservedFailureClass,
  type ObservedFailureSpan,
  type ObservedFailureSummary,
} from "@botiverse/raft-shared";

export {
  FAILURE_STATUS,
  OBSERVED_FAILURE_EMITTED_FIELDS,
  OBSERVED_FAILURE_MAX_CLASSES,
  OBSERVED_FAILURE_SPANS,
  UNKNOWN_FAILURE_SPAN,
  normalizeTraceInstant,
  parseObservedFailureSummary,
  toObservedFailureSpan,
} from "@botiverse/raft-shared";
export type {
  ExcludedRecordCounts,
  FailureAttribution,
  ObservationWindow,
  ObservedFailureClass,
  ObservedFailureSpan,
  ObservedFailureSummary,
} from "@botiverse/raft-shared";

export interface ObservedFailureSummaryInput {
  /** Machine state root; traces are read from `<machineDir>/traces`. */
  readonly machineDir: string;
  /** Reporting agent; the only value that can produce `"exact"`. */
  readonly agentId: string;
  readonly from: Date | string | number;
  readonly to: Date | string | number;
}

function structuredAgentId(record: Record<string, unknown>): string | null {
  const attrs = record.attrs;
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return null;
  const value = (attrs as Record<string, unknown>).agentId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface FailureBucket {
  span: ObservedFailureSpan;
  attribution: FailureAttribution;
  count: number;
  firstMs: number;
  lastMs: number;
}

/**
 * Read this machine's trace corpus and summarize observed failures.
 *
 * Fail-open by design: an unreadable trace directory or file yields an empty
 * observation rather than a thrown error, because a feedback upload must not
 * fail when diagnostics are unavailable. An empty result is therefore
 * indistinguishable from "nothing happened" - which is exactly why the caller
 * must present it as *observed*, and why `completeness` stays `"unknown"`.
 */
export async function collectObservedFailureSummary(
  input: ObservedFailureSummaryInput,
): Promise<ObservedFailureSummary> {
  const requestedFrom = normalizeTraceInstant(
    input.from instanceof Date ? input.from.getTime() : input.from,
  );
  const requestedTo = normalizeTraceInstant(
    input.to instanceof Date ? input.to.getTime() : input.to,
  );
  const fromMs = requestedFrom === null ? Number.NEGATIVE_INFINITY : Date.parse(requestedFrom);
  const toMs = requestedTo === null ? Number.POSITIVE_INFINITY : Date.parse(requestedTo);

  const excluded = { unparseable: 0, undatable: 0, otherAgent: 0 };
  let recordsRead = 0;
  let recordsInWindow = 0;
  let failureRecords = 0;
  let observedFromMs: number | null = null;
  let observedToMs: number | null = null;
  const buckets = new Map<string, FailureBucket>();

  const traceDir = path.join(input.machineDir, "traces");
  let names: string[] = [];
  try {
    names = await readdir(traceDir);
  } catch {
    names = [];
  }

  for (const name of names
    .filter((entry) => entry.startsWith("daemon-trace-") && entry.endsWith(".jsonl"))
    .sort()) {
    let text: string;
    try {
      text = await readFile(path.join(traceDir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      let record: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          excluded.unparseable += 1;
          continue;
        }
        record = parsed as Record<string, unknown>;
      } catch {
        excluded.unparseable += 1;
        continue;
      }
      recordsRead += 1;

      const at = normalizeTraceInstant(traceRecordTime(record));
      if (at === null) {
        excluded.undatable += 1;
        continue;
      }
      const atMs = Date.parse(at);
      if (atMs < fromMs || atMs > toMs) continue;

      const recordAgentId = structuredAgentId(record);
      if (recordAgentId !== null && recordAgentId !== input.agentId) {
        excluded.otherAgent += 1;
        continue;
      }

      recordsInWindow += 1;
      observedFromMs = observedFromMs === null ? atMs : Math.min(observedFromMs, atMs);
      observedToMs = observedToMs === null ? atMs : Math.max(observedToMs, atMs);

      if (traceRecordStatus(record) !== FAILURE_STATUS) continue;
      failureRecords += 1;

      const span = toObservedFailureSpan(record.name);
      const attribution: FailureAttribution = recordAgentId === null ? "machine-wide" : "exact";
      // Both components come from closed sets that contain no `|`, so this
      // separator cannot collide.
      const key = `${span}|${attribution}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.count += 1;
        existing.firstMs = Math.min(existing.firstMs, atMs);
        existing.lastMs = Math.max(existing.lastMs, atMs);
      } else {
        buckets.set(key, { span, attribution, count: 1, firstMs: atMs, lastMs: atMs });
      }
    }
  }

  const failures: ObservedFailureClass[] = [...buckets.values()]
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.span.localeCompare(b.span) ||
        a.attribution.localeCompare(b.attribution),
    )
    .map((entry) => ({
      span: entry.span,
      count: entry.count,
      firstAt: normalizeTraceInstant(entry.firstMs),
      lastAt: normalizeTraceInstant(entry.lastMs),
      attribution: entry.attribution,
    }));

  return {
    window: {
      requestedFrom: requestedFrom ?? "",
      requestedTo: requestedTo ?? "",
      observedFrom: normalizeTraceInstant(observedFromMs),
      observedTo: normalizeTraceInstant(observedToMs),
      recordsRead,
      recordsInWindow,
      failureRecords,
      nonFailureRecords: recordsInWindow - failureRecords,
      excluded,
      completeness: "unknown",
    },
    failures,
  };
}
