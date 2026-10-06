// The transcript_outcome attachment of a feedback report (task #1228 ①): a
// small strict JSON object saying what the lookup observed and what happened
// to the transcript upload, filed in the report ledger so support can read it
// where it already reads attachments.
//
// Best-effort by construction:
// - it is uploaded AFTER the result frame was sent, so it never delays or
//   rewrites the result;
// - its own failure is logged and never triggers another outcome upload;
// - it never claims its own storage (the object cannot know that); the result
//   frame says only that it will be attempted, i.e. its fate is unknown to the
//   server.
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  buildFeedbackTranscriptOutcome,
  currentDate,
  type Tracer,
} from "@botiverse/raft-shared";
import { uploadWithSignedCapability } from "./directUploadCapability";
import { feedbackTranscriptCollectorErrorResult, type FeedbackTranscriptCollectionResult } from "./feedbackTranscriptCollector";
import { logger } from "./logger";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Per-HTTP-step timeout of the outcome upload: it is small and must not linger. */
export const FEEDBACK_TRANSCRIPT_OUTCOME_UPLOAD_TIMEOUT_MS = 15_000;

export type FeedbackTranscriptOutcomeUploadStatus = "stored" | "unsupported" | "failed" | "not_built";

class TranscriptOutcomeUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptOutcomeUnsupportedError";
  }
}

export interface FeedbackTranscriptOutcomeUploadInput {
  result: FeedbackTranscriptCollectionResult;
  agentId: string;
  feedbackReportId: string;
  requestId: string;
  daemonVersion: string | null;
  serverUrl: string;
  daemonApiKey: string;
  workerUrl: string;
  tracer: Tracer;
  fetchImpl: FetchLike;
  timeoutMs?: number;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Never rejects. Exactly one attempt; a failure is logged, never retried here. */
export async function uploadFeedbackTranscriptOutcome(input: FeedbackTranscriptOutcomeUploadInput): Promise<FeedbackTranscriptOutcomeUploadStatus> {
  const tag = `report=${input.feedbackReportId} agent=${input.agentId} request=${input.requestId}`;
  try {
    const result = input.result.lookup && input.result.upload
      ? input.result
      : feedbackTranscriptCollectorErrorResult(input.result.error ?? "collector returned no typed outcome");
    const built = buildFeedbackTranscriptOutcome({
      feedbackReportId: input.feedbackReportId,
      agentId: input.agentId,
      requestId: input.requestId,
      daemonVersion: input.daemonVersion,
      generatedAt: currentDate().toISOString(),
      lookup: result.lookup!,
      upload: result.upload!,
    });
    if (!built.ok) {
      logger.warn(`[FeedbackTranscriptOutcome] not built for ${tag}: ${built.reason}${built.error ? ` (${built.error})` : ""}`);
      return "not_built";
    }
    const span = input.tracer.startSpan("daemon.feedback_transcript_outcome.upload", {
      surface: "daemon",
      kind: "producer",
      attrs: { agentId: input.agentId, feedbackReportId: input.feedbackReportId, requestId: input.requestId, outcome_bytes: built.bytes },
    });
    try {
      const gzipped = gzipSync(Buffer.from(built.json, "utf8"));
      const bundleSha256 = createHash("sha256").update(gzipped).digest("hex");
      await uploadWithSignedCapability({
        serverUrl: input.serverUrl,
        apiKey: input.daemonApiKey,
        workerUrl: input.workerUrl,
        scope: "daemon-trace-bundle:create",
        createPath: "/api/trace-bundles",
        createBody: { bundleSha256, bundleSizeBytes: gzipped.byteLength },
        attestationMetadata: {
          bundleId: randomUUID(),
          bundleSha256,
          bundleSizeBytes: gzipped.byteLength,
          bundleContentType: "application/json",
          bundleContentEncoding: "gzip",
          feedbackReportId: input.feedbackReportId,
          agentId: input.agentId,
          feedbackAttachmentKind: "transcript_outcome",
          feedbackTranscriptRequestId: input.requestId,
        },
        // An older server drops the unknown kind and signs anyway; an older
        // worker would file it as an untyped trace bundle (or refuse it). In
        // neither case may the object be uploaded.
        verifyCapability: (capability) => {
          if (capability.metadata?.feedbackAttachmentKind !== "transcript_outcome") {
            throw new TranscriptOutcomeUnsupportedError("server did not sign feedbackAttachmentKind=transcript_outcome (older server); outcome not uploaded");
          }
        },
        verifySession: (_capability, session) => {
          if (session.feedbackAttachmentKind !== "transcript_outcome") {
            throw new TranscriptOutcomeUnsupportedError("trace upload worker did not acknowledge feedbackAttachmentKind=transcript_outcome (older worker); outcome not uploaded");
          }
        },
        uploadBody: new Blob([new Uint8Array(gzipped)], { type: "application/json" }),
        fetchImpl: input.fetchImpl,
        timeoutMs: input.timeoutMs ?? FEEDBACK_TRANSCRIPT_OUTCOME_UPLOAD_TIMEOUT_MS,
      });
      span.end("ok");
      logger.info(`[FeedbackTranscriptOutcome] stored for ${tag}`);
      return "stored";
    } catch (err) {
      const unsupported = err instanceof TranscriptOutcomeUnsupportedError;
      span.end("error", { attrs: { error_class: err instanceof Error ? err.name : "Error", unsupported } });
      logger.warn(`[FeedbackTranscriptOutcome] ${unsupported ? "unsupported" : "upload failed"} for ${tag}: ${messageOf(err)}`);
      return unsupported ? "unsupported" : "failed";
    }
  } catch (err) {
    logger.warn(`[FeedbackTranscriptOutcome] failed for ${tag}: ${messageOf(err)}`);
    return "failed";
  }
}

/**
 * One feedback transcript request, in order: collect → send the result frame
 * → (only then) upload the outcome object. Resolves right after the send; the
 * outcome upload continues in `outcome`, which never rejects.
 */
export async function runFeedbackTranscriptRequest(input: {
  collect: () => Promise<FeedbackTranscriptCollectionResult>;
  send: (result: FeedbackTranscriptCollectionResult) => void;
  uploadOutcome: (result: FeedbackTranscriptCollectionResult) => Promise<unknown>;
  workerConfigured: boolean;
  tag: string;
}): Promise<{ outcome: Promise<void> }> {
  let result: FeedbackTranscriptCollectionResult;
  try {
    result = await input.collect();
  } catch (err) {
    logger.error(`[FeedbackTranscript] collection failed for ${input.tag}`, err);
    result = feedbackTranscriptCollectorErrorResult(messageOf(err));
  }
  result = { ...result, outcomeObject: input.workerConfigured ? "attempt_after_result" : "not_attempted_worker_not_configured" };
  try {
    input.send(result);
  } catch (err) {
    logger.warn(`[FeedbackTranscript] result frame not sent for ${input.tag}: ${messageOf(err)}`);
  }
  // Started synchronously after the send (so the order is fixed), absorbed
  // entirely (so it can never reject or retry).
  const outcome = input.workerConfigured
    ? (async () => {
      try {
        await input.uploadOutcome(result);
      } catch (err) {
        logger.warn(`[FeedbackTranscriptOutcome] failed for ${input.tag}: ${messageOf(err)}`);
      }
    })()
    : Promise.resolve();
  return { outcome };
}
