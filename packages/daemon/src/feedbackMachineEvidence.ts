// task #279 — default machine-side evidence for feedback uploads.
//
// Both collectors are EXTRACTORS: they construct new objects from named,
// validated fields and never spread, filter, or forward the input. See the
// shared contract (feedbackMachineEvidence.ts in @botiverse/raft-shared) for
// what "no free text" does and does not cover.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  FEEDBACK_TRACE_TAIL_MAX_RECORDS,
  normalizeTraceInstant,
  projectFeedbackTraceRecord,
  redactDiagnosticText,
  validatedSemver,
  type DispatcherPathKind,
  type FeedbackMachineState,
  type FeedbackTraceRecord,
  type FeedbackTraceTail,
  type HostLifecycleOwnerKind,
} from "@botiverse/raft-shared";

export interface FeedbackTraceTailInput {
  /** Machine state root; traces are read from `<machineDir>/traces`. */
  machineDir: string;
  window: { from: string; to: string };
  maxRecords?: number;
}

/**
 * Project the daemon trace corpus for [from, to] into fixed-tuple records.
 * Fail-open: unreadable directory/files yield an empty tail (the upload must
 * not fail because diagnostics are unavailable). Emptiness means "not
 * observed", never "nothing happened"; `completeness` stays "unknown".
 */
export async function collectFeedbackTraceTail(input: FeedbackTraceTailInput): Promise<FeedbackTraceTail> {
  const maxRecords = Math.min(input.maxRecords ?? FEEDBACK_TRACE_TAIL_MAX_RECORDS, FEEDBACK_TRACE_TAIL_MAX_RECORDS);
  const requestedFrom = normalizeTraceInstant(input.window.from) ?? new Date(0).toISOString();
  const requestedTo = normalizeTraceInstant(input.window.to) ?? new Date(0).toISOString();
  const fromMs = Date.parse(requestedFrom);
  const toMs = Date.parse(requestedTo);
  const dropped = { unparseable: 0, undatable: 0, outsideWindow: 0, overCap: 0 };
  let recordsRead = 0;
  const inWindow: FeedbackTraceRecord[] = [];

  const traceDir = path.join(input.machineDir, "traces");
  let names: string[] = [];
  try {
    names = (await readdir(traceDir)).filter((n) => n.startsWith("daemon-trace-") && n.endsWith(".jsonl")).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    let text: string;
    try {
      text = await readFile(path.join(traceDir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        dropped.unparseable += 1;
        continue;
      }
      recordsRead += 1;
      const projected = projectFeedbackTraceRecord(parsed);
      if (projected === null) {
        dropped.undatable += 1;
        continue;
      }
      const at = Date.parse(projected.startedAt);
      if (at < fromMs || at > toMs) {
        dropped.outsideWindow += 1;
        continue;
      }
      inWindow.push(projected);
    }
  }
  inWindow.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const records = inWindow.length > maxRecords ? inWindow.slice(inWindow.length - maxRecords) : inWindow;
  dropped.overCap = inWindow.length - records.length;
  return {
    window: {
      requestedFrom,
      requestedTo,
      observedFrom: records[0]?.startedAt ?? null,
      observedTo: records.at(-1)?.startedAt ?? null,
      recordsRead,
      recordsEmitted: records.length,
      dropped,
      completeness: "unknown",
    },
    records,
  };
}

export interface FeedbackMachineStateInput {
  /** RAFT home (the Computer lives under `<home>/computer`). */
  slockHome: string;
  daemonVersion: string | undefined;
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Classify a dispatcher path without emitting it. Mirrors the Computer's own
 * stability rules (task #808 / #7755): OS temp roots and K slot paths are
 * never stable dispatcher locations.
 */
export function classifyDispatcherPath(raw: unknown, slockHome: string): DispatcherPathKind {
  if (raw === null || raw === undefined) return "missing";
  if (typeof raw !== "string" || raw.length === 0) return "unknown";
  const normalized = raw.replace(/\\/g, "/");
  const kSlots = path.join(slockHome, "computer", "k", "slots").replace(/\\/g, "/");
  if (normalized.startsWith(kSlots)) return "k_slot";
  if (/(^|\/)(tmp|temp|T)\//i.test(normalized) || /\/private\/var\/folders\//.test(normalized) || /^\/tmp\//.test(normalized)) return "temp";
  if (!path.isAbsolute(raw)) return "unknown";
  return "stable";
}

/** Versions and lifecycle kinds only; no paths, no free text. */
export async function collectFeedbackMachineState(input: FeedbackMachineStateInput): Promise<FeedbackMachineState> {
  const computerDir = path.join(input.slockHome, "computer");
  const serviceVersion = await readJsonObject(path.join(computerDir, "service-version.json"));
  let kStableVersion: string | null = null;
  try {
    kStableVersion = validatedSemver((await readFile(path.join(computerDir, "k", "slots", "stable", "VERSION"), "utf8")).trim());
  } catch {
    kStableVersion = null;
  }
  const marker = await readJsonObject(path.join(computerDir, "host-lifecycle-owner.json"));
  const owner: HostLifecycleOwnerKind = marker === null
    ? "none"
    : marker.owner === "cli" || marker.owner === "app"
      ? marker.owner
      : "unknown";
  return {
    daemonVersion: validatedSemver(input.daemonVersion),
    computerServiceVersion: validatedSemver(serviceVersion?.version),
    kStableVersion,
    hostLifecycleOwner: owner,
    dispatcherPathKind: marker === null ? "missing" : classifyDispatcherPath(marker.dispatcherPath, input.slockHome),
  };
}

/**
 * Exit guard, not the argument: the structures above are field-projected, but
 * every upload passes the shared redaction once more. If redaction changes
 * the serialized form the value is dropped rather than shipped altered.
 */
export function redactedOrNull<T>(value: T): T | null {
  const serialized = JSON.stringify(value);
  return redactDiagnosticText(serialized) === serialized ? value : null;
}
