// task #1228 ①: the transcript content label, byte counts and request id a
// daemon signs into a feedback-linked upload. Read INDEPENDENTLY of the
// window-coverage claims (readWindowCoverageClaims drops everything on an
// invalid coverage value; that must not erase these). Never defaulted: an
// absent or out-of-enum value is simply not carried, and readers treat a
// transcript without `transcript_content` as source-unverified.
import {
  FEEDBACK_TRACE_BUNDLE_TRANSCRIPT_RESULT_METADATA_KEYS,
  isFeedbackTranscriptUploadableContentKind,
  readFeedbackTranscriptByteCount,
  readFeedbackTranscriptRequestId,
  type FeedbackTraceBundleTranscriptResultMetadataKey,
  type FeedbackTranscriptUploadableContentKind,
} from "@botiverse/raft-shared";
import { readOptionalJsonObject } from "./http";

export interface TranscriptResultClaims {
  transcriptContent?: FeedbackTranscriptUploadableContentKind;
  /** Size of the source file on disk at read time. */
  transcriptSourceBytes?: number;
  /** Uncompressed bytes uploaded (after windowing/redaction); a difference is not by itself truncation. */
  transcriptBytes?: number;
  requestId?: string;
}

export function readTranscriptResultClaims(metadataValue: unknown): TranscriptResultClaims {
  const meta = readOptionalJsonObject(metadataValue, "metadata");
  if (!meta) return {};
  const claims: TranscriptResultClaims = {};
  const readers = {
    feedbackTranscriptContent(value: unknown) {
      if (isFeedbackTranscriptUploadableContentKind(value)) claims.transcriptContent = value;
    },
    feedbackTranscriptSourceBytes(value: unknown) {
      const n = readFeedbackTranscriptByteCount(value);
      if (n !== null) claims.transcriptSourceBytes = n;
    },
    feedbackTranscriptBytes(value: unknown) {
      const n = readFeedbackTranscriptByteCount(value);
      if (n !== null) claims.transcriptBytes = n;
    },
    feedbackTranscriptRequestId(value: unknown) {
      const id = readFeedbackTranscriptRequestId(value);
      if (id) claims.requestId = id;
    },
  } satisfies Record<FeedbackTraceBundleTranscriptResultMetadataKey, (value: unknown) => void>;
  for (const key of Object.keys(FEEDBACK_TRACE_BUNDLE_TRANSCRIPT_RESULT_METADATA_KEYS) as FeedbackTraceBundleTranscriptResultMetadataKey[]) {
    readers[key](meta[key]);
  }
  return claims;
}
