import { readFileSync } from "node:fs";
import type { TraceUploadWorkerEnv } from "./env";
import { writeTraceUploadLedger, type TraceBundleMetadata } from "./traces/bundles";
import {
  ingestTraceBundleObject,
  readTraceBundleRecords,
  TraceBundlePinMismatchError,
  traceIngestSpanKey,
  type LocalTraceRecord,
} from "./traces/otlp";
import { createNodeTraceUploadEnv } from "./nodeEnv";
import { installUnhandledRejectionGuard } from "./nodeExecutionContext";

// Re-ingest entrypoint for task #427: replays trace bundles whose rows never
// (or only partially) reached ScopeDB after the #426 crashes / exit137 OOMs.
//
// Route-B design (see #proj-o11y:c94f790f): the script has NO ScopeDB read
// path. A query seat (Leiysky) produces the manifest ("what is already
// present"); this script derives "what should be present" from the bundle
// objects it reads anyway. The verdict is the query seat's re-classification:
// rows == expected_spans per bundle (`=`, not `>=`).
//
// Idempotency lives in the classify -> replay -> re-classify loop, not in a
// single invocation: re-running with a STALE manifest would re-send spans.
// The guards against driving writes from a wrong/stale manifest:
//   - every candidate pins bundle_sha256; the object's actual hash must match
//     (also enforced inside ingestTraceBundleObject) or the candidate is
//     skipped and reported;
//   - candidates flagged `existing_rows_lack_span_key` (rows written before
//     the span_key attribute existed) are listed, never replayed;
//   - the complete group only rewrites a ledger whose scopedb_status is not
//     already "success" (the population is thousands of healthy uploads).

type ReingestCandidate = {
  upload_id: string;
  ledger_key: string;
};

type ManifestGroup = "zero" | "partial" | "complete";

type ManifestEntry = {
  group: ManifestGroup;
  row_count: number;
  existing_span_keys?: string[];
  existing_rows_lack_span_key?: boolean;
};

type ReingestManifest = {
  read_window?: { from?: string; to?: string; read_at?: string };
  entries: Record<string, ManifestEntry>;
};

type CandidateOutcome = {
  upload_id: string;
  ledger_key: string;
  action:
    | "replayed"
    | "replayed_partial"
    | "ledger_fixed"
    | "no_action"
    | "dry_run"
    | "skipped_unclassified"
    | "skipped_no_span_key"
    | "skipped_sha_mismatch"
    | "skipped_not_trace"
    | "failed";
  expected_spans?: number;
  spans_written?: number;
  events_skipped?: number;
  row_count?: number;
  error_class?: string;
  error_message?: string;
};

function errorFields(error: unknown): { error_class: string; error_message: string } {
  return {
    error_class: error instanceof Error ? error.name : "Error",
    error_message: error instanceof Error ? error.message : String(error),
  };
}

// Inputs are read from local files (--candidates/--manifest) or from R2
// object keys (--candidates-key/--manifest-key). The one-off ECS RunTask has
// no filesystem channel for inputs, so in production both travel as R2
// objects uploaded by the seat driving the run.
type InputSource = { path?: string; r2Key?: string };

function parseArgs(argv: string[]): { candidates: InputSource; manifest?: InputSource; dryRun: boolean } {
  const candidates: InputSource = {};
  let manifest: InputSource | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--candidates") candidates.path = argv[++i];
    else if (argv[i] === "--candidates-key") candidates.r2Key = argv[++i];
    else if (argv[i] === "--manifest") manifest = { path: argv[++i] };
    else if (argv[i] === "--manifest-key") manifest = { r2Key: argv[++i] };
    else if (argv[i] === "--dry-run") dryRun = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!candidates.path && !candidates.r2Key) throw new Error("--candidates <path> or --candidates-key <key> is required");
  return { candidates, manifest, dryRun };
}

async function readInputText(env: TraceUploadWorkerEnv, source: InputSource): Promise<string> {
  if (source.path) return readFileSync(source.path, "utf8");
  if (!env.TRACE_BUNDLES.get) throw new Error("TRACE_BUNDLES.get is required for R2 inputs");
  const object = await env.TRACE_BUNDLES.get(source.r2Key!);
  if (!object?.body) throw new Error(`Input object not found: ${source.r2Key}`);
  return new Response(object.body).text();
}

async function readLedgerRecord(
  env: TraceUploadWorkerEnv,
  ledgerKey: string,
): Promise<Record<string, unknown>> {
  if (!env.TRACE_BUNDLES.get) throw new Error("TRACE_BUNDLES.get is required for reingest");
  const object = await env.TRACE_BUNDLES.get(ledgerKey);
  if (!object?.body) throw new Error(`Ledger object not found: ${ledgerKey}`);
  const text = await new Response(object.body).text();
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) throw new Error(`Ledger is not an object: ${ledgerKey}`);
  return parsed as Record<string, unknown>;
}

function metadataFromLedger(ledger: Record<string, unknown>): TraceBundleMetadata {
  const required = ["upload_id", "bundle_id", "object_key", "bundle_sha256", "bundle_size_bytes", "server_id", "machine_id"];
  for (const field of required) {
    if (ledger[field] === undefined || ledger[field] === null) {
      throw new Error(`Ledger is missing required field ${field}`);
    }
  }
  return {
    uploadId: String(ledger.upload_id),
    bundleId: String(ledger.bundle_id),
    objectKey: String(ledger.object_key),
    bundleSha256: String(ledger.bundle_sha256),
    bundleSizeBytes: Number(ledger.bundle_size_bytes),
    serverId: String(ledger.server_id),
    machineId: String(ledger.machine_id),
    ...(ledger.deployment_environment ? { deploymentEnvironment: String(ledger.deployment_environment) } : {}),
  };
}

export async function reingestCandidates(
  env: TraceUploadWorkerEnv,
  candidates: ReingestCandidate[],
  manifest: ReingestManifest | undefined,
  dryRun: boolean,
): Promise<{ outcomes: CandidateOutcome[]; failures: number }> {
  const outcomes: CandidateOutcome[] = [];
  let failures = 0;

  for (const candidate of candidates) {
    const entry = manifest?.entries[candidate.upload_id];
    try {
      if (entry?.existing_rows_lack_span_key) {
        outcomes.push({ ...candidate, action: "skipped_no_span_key", row_count: entry.row_count });
        continue;
      }

      const ledger = await readLedgerRecord(env, candidate.ledger_key);
      const metadata = metadataFromLedger(ledger);
      if (metadata.uploadId !== candidate.upload_id) {
        throw new Error(`Ledger upload_id ${metadata.uploadId} does not match candidate ${candidate.upload_id}`);
      }
      const ledgerStatus = typeof ledger.scopedb_status === "string" ? ledger.scopedb_status : "unknown";

      // machine_evidence and transcript_outcome objects are one JSON document
      // each, not trace JSONL; their ledgers say scopedb "skipped" by design.
      // Never replay them as traces.
      if (ledger.feedback_attachment_kind === "machine_evidence" || ledger.feedback_attachment_kind === "transcript_outcome") {
        outcomes.push({ ...candidate, action: "skipped_not_trace" });
        continue;
      }

      // Stale-manifest rerun guard (review item 3): if the ledger already says
      // success, this bundle is done regardless of what the manifest claims —
      // a rerun after an interrupted live run then writes nothing.
      if (!dryRun && ledgerStatus === "success") {
        outcomes.push({ ...candidate, action: "no_action", row_count: entry?.row_count });
        continue;
      }

      // Complete group: ledger-only fix, and only if the ledger is not
      // already success (most of the population is healthy uploads).
      if (entry?.group === "complete") {
        if (dryRun) {
          outcomes.push({ ...candidate, action: "dry_run", row_count: entry.row_count });
        } else {
          await writeTraceUploadLedger(env, metadata, {
            r2_status: "success",
            scopedb_status: "success",
            spans_ingested: entry.row_count,
          });
          outcomes.push({ ...candidate, action: "ledger_fixed", row_count: entry.row_count });
        }
        continue;
      }

      if (!dryRun && !entry) {
        // Live runs require a classification for every candidate.
        outcomes.push({ ...candidate, action: "skipped_unclassified" });
        continue;
      }

      // Review item 1: the ZERO group gets NO filter, so its events are
      // replayed together with its spans (a filter would silently drop them).
      // Only the PARTIAL group filters, and its skipped events are reported.
      const isPartial = entry?.group === "partial";
      const existing = new Set(isPartial ? entry!.existing_span_keys! : []);
      const recordFilter = isPartial
        ? (record: LocalTraceRecord): boolean => !existing.has(traceIngestSpanKey(metadata, record))
        : undefined;

      if (dryRun) {
        // Dry-run: report expected_spans (the "should exist" half of the
        // closing check) plus what a live run would do, without writing.
        const { spans } = await readBundleSpans(env, metadata);
        const missing = recordFilter ? spans.filter(recordFilter).length : spans.length;
        outcomes.push({
          ...candidate,
          action: "dry_run",
          expected_spans: spans.length,
          spans_written: entry ? missing : undefined,
          row_count: entry?.row_count,
        });
        continue;
      }

      const result = await ingestTraceBundleObject(env, metadata, recordFilter ? { recordFilter } : undefined);
      // Review (non-blocking): expected_spans reported from the bundle itself
      // (spans_total when filtered), an instrument independent of the
      // manifest's row_count; the manifest-based figure is kept as
      // manifest_expected for cross-checking.
      const expectedSpans = result.spans_total ?? (entry!.row_count + result.spans_ingested);
      // Ledger goes to success only after the ingest path acked. A failure
      // here must surface: this is a script, not request-path bookkeeping, so
      // writeTraceUploadLedger (not the tryWrite variant) is used on purpose.
      await writeTraceUploadLedger(env, metadata, {
        r2_status: "success",
        scopedb_status: "success",
        spans_ingested: expectedSpans,
        events_ingested: result.events_ingested,
        batches_sent: result.batches_sent,
      });
      outcomes.push({
        ...candidate,
        action: isPartial ? "replayed_partial" : "replayed",
        expected_spans: expectedSpans,
        spans_written: result.spans_ingested,
        ...(result.events_skipped !== undefined ? { events_skipped: result.events_skipped } : {}),
        row_count: entry!.row_count,
      });
    } catch (error) {
      const { error_class, error_message } = errorFields(error);
      const action = error instanceof TraceBundlePinMismatchError ? "skipped_sha_mismatch" : "failed";
      if (action === "failed") failures += 1;
      outcomes.push({ ...candidate, action, error_class, error_message });
      console.error("[TraceReingest] candidate_failed", { upload_id: candidate.upload_id, error_class, error_message });
    }
  }
  return { outcomes, failures };
}

async function readBundleSpans(
  env: TraceUploadWorkerEnv,
  metadata: TraceBundleMetadata,
): Promise<{ spans: LocalTraceRecord[] }> {
  // Dry-run counting uses the same size/hash guards as live ingest: the sha
  // pin check happens inside readTraceBundleRecords.
  return readTraceBundleRecords(env, metadata);
}

export function parseCandidatesJson(text: string): ReingestCandidate[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("candidates file must be a JSON array");
  return parsed.map((item, index) => {
    if (typeof item !== "object" || item === null) throw new Error(`candidate ${index} is not an object`);
    const record = item as Record<string, unknown>;
    if (typeof record.upload_id !== "string" || typeof record.ledger_key !== "string") {
      throw new Error(`candidate ${index} needs string upload_id and ledger_key`);
    }
    return { upload_id: record.upload_id, ledger_key: record.ledger_key };
  });
}

export function parseManifestJson(text: string): ReingestManifest {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("manifest must be a JSON object");
  const manifest = parsed as ReingestManifest;
  if (typeof manifest.entries !== "object" || manifest.entries === null) {
    throw new Error("manifest.entries must be an object keyed by upload_id");
  }
  for (const [key, entry] of Object.entries(manifest.entries)) {
    if (!["zero", "partial", "complete"].includes(entry.group)) {
      throw new Error(`manifest entry ${key} has invalid group`);
    }
    // Boundary discipline: the manifest is external input driving production
    // writes, so contradictory entries are rejected here rather than
    // interpreted. A "partial" entry without its existing span keys would
    // otherwise degrade into a full replay (duplicate writes).
    if (entry.group === "zero" && entry.row_count !== 0) {
      throw new Error(`manifest entry ${key}: group "zero" requires row_count 0`);
    }
    // Entries flagged existing_rows_lack_span_key are never replayed (their
    // existing rows predate the span_key attribute, so per-span dedup cannot
    // recognise them) — they are exempt from the key requirement because no
    // key list can be produced for them. The flag is allowed on "partial" and
    // "complete" (a keyless bundle can still have a complete row count).
    if (entry.existing_rows_lack_span_key) {
      if (entry.group === "zero") {
        throw new Error(`manifest entry ${key}: existing_rows_lack_span_key contradicts group "zero"`);
      }
      continue;
    }
    if (entry.group === "partial") {
      const keys = entry.existing_span_keys;
      if (!Array.isArray(keys) || keys.length === 0) {
        throw new Error(`manifest entry ${key}: group "partial" requires non-empty existing_span_keys`);
      }
      if (keys.length !== entry.row_count) {
        throw new Error(`manifest entry ${key}: existing_span_keys length must equal row_count`);
      }
    }
  }
  return manifest;
}

const isMain = process.argv[1]?.endsWith("reingest.ts") || process.argv[1]?.endsWith("reingest.js");
if (isMain) {
  installUnhandledRejectionGuard();
  const args = parseArgs(process.argv.slice(2));
  const { dryRun } = args;
  if (!dryRun && !args.manifest) {
    console.error("Live runs require --manifest/--manifest-key (dry-run may omit it)");
    process.exit(2);
  }
  const env = createNodeTraceUploadEnv();
  (async () => ({
    candidates: parseCandidatesJson(await readInputText(env, args.candidates)),
    manifest: args.manifest ? parseManifestJson(await readInputText(env, args.manifest)) : undefined,
  }))()
    .then(({ candidates, manifest }) => reingestCandidates(env, candidates, manifest, dryRun))
    .then(({ outcomes, failures }) => {
      console.log(JSON.stringify({ dry_run: dryRun, failures, outcomes }, null, 2));
      process.exit(failures > 0 ? 1 : 0);
    })
    .catch((error) => {
      console.error("[TraceReingest] fatal", errorFields(error));
      process.exit(1);
    });
}
