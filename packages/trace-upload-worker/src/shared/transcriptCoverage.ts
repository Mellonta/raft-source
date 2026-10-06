// Transcript window-coverage facts a daemon attaches to feedback-linked uploads.
// Read by both the feedback report upload and the trace bundle upload.
import {
  FEEDBACK_TRACE_BUNDLE_TRANSCRIPT_METADATA_KEYS,
  type FeedbackTraceBundleTranscriptMetadataKey,
  type FeedbackTranscriptReportTimeSource,
  type FeedbackTranscriptWindowCoverage,
} from "@botiverse/raft-shared";
import type { FeedbackReportUploadSessionClaims } from "../feedback/reports";
import { readOptionalJsonObject, type JsonObject } from "./http";

export type TranscriptWindowCoverageClaims = Pick<
  FeedbackReportUploadSessionClaims,
  | "transcriptCoverage"
  | "transcriptFirstEventAt"
  | "transcriptLastEventAt"
  | "transcriptTruncated"
  | "transcriptTruncationDirection"
  | "transcriptAnchorSource"
>;

// TOOTH-2: extract transcript window-coverage fields from the daemon's
// upload metadata. anchor_source is a CLOSED enum that MUST match the shared
// authoritative `FeedbackTranscriptReportTimeSource` produced by the daemon /
// server ({web_report_bundle | server_request_received}); anything else is
// rejected (fails closed) rather than defaulting to covered — R1's fail-loud,
// R4's never-default.
//
// #6243 originally hardcoded a diverging literal pair here ({model_read_at |
// reported_at}) that NO producer emits, so every real report was rejected and
// coverage keys were silently dropped. Single-source the accepted values from the
// shared type so this can never drift from the producer again.
//
// The `satisfies Record<FeedbackTranscriptReportTimeSource, true>` makes the set
// exhaustive in BOTH directions: a rename/removal in the shared union fails here
// (the key no longer exists) and an ADDITION also fails (the map is no longer a
// total record of the union). Without the exhaustiveness check a new producer
// value would compile clean while this guard silently rejected it — the very
// silent-drop class this fix closes.
const FEEDBACK_TRANSCRIPT_REPORT_TIME_SOURCES: ReadonlySet<string> = new Set(
  Object.keys({
    web_report_bundle: true,
    server_request_received: true,
  } satisfies Record<FeedbackTranscriptReportTimeSource, true>),
);

const FEEDBACK_TRANSCRIPT_WINDOW_COVERAGES: ReadonlySet<string> = new Set(
  Object.keys({
    covered: true,
    outside_report_window: true,
    timestamps_unavailable: true,
    report_time_invalid: true,
  } satisfies Record<FeedbackTranscriptWindowCoverage, true>),
);

const readMetadataString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const FEEDBACK_TRACE_BUNDLE_TRANSCRIPT_METADATA_READERS = {
  feedbackReportTimeSource(meta: JsonObject): string | undefined {
    return readMetadataString(meta.feedbackReportTimeSource)
      ?? readMetadataString(meta.feedbackTranscriptAnchorSource);
  },
  feedbackTranscriptFirstEventAt(meta: JsonObject): string | undefined {
    return readMetadataString(meta.feedbackTranscriptFirstEventAt);
  },
  feedbackTranscriptLastEventAt(meta: JsonObject): string | undefined {
    return readMetadataString(meta.feedbackTranscriptLastEventAt);
  },
  feedbackTranscriptTruncated(meta: JsonObject): string | undefined {
    const value = readMetadataString(meta.feedbackTranscriptTruncated);
    return value === "true" || value === "false" ? value : undefined;
  },
  feedbackTranscriptTruncationDirection(meta: JsonObject): string | undefined {
    const value = readMetadataString(meta.feedbackTranscriptTruncationDirection);
    return value === "head" || value === "tail" || value === "window" ? value : undefined;
  },
  feedbackTranscriptWindowCoverage(meta: JsonObject): string | undefined {
    return readMetadataString(meta.feedbackTranscriptWindowCoverage)
      ?? readMetadataString(meta.feedbackTranscriptCoverage);
  },
} satisfies Record<FeedbackTraceBundleTranscriptMetadataKey, (meta: JsonObject) => string | undefined>;

export function readWindowCoverageClaims(metadataValue: unknown): Partial<
  TranscriptWindowCoverageClaims
> {
  const meta = readOptionalJsonObject(metadataValue, "metadata");
  if (!meta) return {};
  const metadataReaders = FEEDBACK_TRACE_BUNDLE_TRANSCRIPT_METADATA_READERS;
  const metadataKeys = Object.keys(
    FEEDBACK_TRACE_BUNDLE_TRANSCRIPT_METADATA_KEYS,
  ) as FeedbackTraceBundleTranscriptMetadataKey[];
  const metadataClaims = Object.fromEntries(
    metadataKeys.map((key) => [key, metadataReaders[key](meta)]),
  ) as Partial<Record<FeedbackTraceBundleTranscriptMetadataKey, string>>;
  const coverage = metadataClaims.feedbackTranscriptWindowCoverage;
  const anchorSource = metadataClaims.feedbackReportTimeSource;
  // R4: the predicate must never default to covered; an out-of-enum anchor is
  // rejected (we simply do not claim coverage). Closed enum enforcement:
  if (anchorSource !== undefined && !FEEDBACK_TRANSCRIPT_REPORT_TIME_SOURCES.has(anchorSource)) {
    // Out-of-enum source → do not propagate a coverage claim; consumers must fail
    // loud on absence / contradictory coverage keys (see fullCoveragePredicate).
    return {};
  }
  if (coverage !== undefined && !FEEDBACK_TRANSCRIPT_WINDOW_COVERAGES.has(coverage)) {
    return {};
  }
  const claims: Partial<
    TranscriptWindowCoverageClaims
  > = {};
  claims.transcriptCoverage = coverage;
  claims.transcriptFirstEventAt = metadataClaims.feedbackTranscriptFirstEventAt;
  claims.transcriptLastEventAt = metadataClaims.feedbackTranscriptLastEventAt;
  claims.transcriptTruncated = metadataClaims.feedbackTranscriptTruncated as "true" | "false" | undefined;
  claims.transcriptTruncationDirection = metadataClaims.feedbackTranscriptTruncationDirection as "head" | "tail" | "window" | undefined;
  if (anchorSource !== undefined) claims.transcriptAnchorSource = anchorSource;
  return claims;
}
