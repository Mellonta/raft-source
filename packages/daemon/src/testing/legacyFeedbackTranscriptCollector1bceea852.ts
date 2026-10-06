// FROZEN COPY — test fixture only. This is packages/daemon/src/
// feedbackTranscriptCollector.ts exactly as it was on staging 1bceea852 (the
// last daemon that uploads the workspace handoff placeholder as if it were a
// transcript and signs no content label / byte counts / request id), with only
// its import paths rewritten for this directory. It stands in for an OLD
// deployed daemon in cross-version tests (old daemon -> new server -> new
// worker). Do not "fix" or update it.
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  currentDate,
  type FeedbackMachineEvidenceOutcome,
  type FeedbackMachineLogTailOutcome,
  type FeedbackMachineState,
  type FeedbackTraceTail,
  type FeedbackTranscriptReportTimeSource,
  type FeedbackTranscriptWindow,
  type ObservedFailureSummary,
  type Tracer,
} from "@botiverse/raft-shared";
import { uploadWithSignedCapability } from "../directUploadCapability";
import {
  FEEDBACK_MACHINE_EVIDENCE_WAIT_MS,
  settleMachineEvidenceWithin,
  startFeedbackMachineEvidence,
  uploadFeedbackMachineEvidence,
} from "../feedbackMachineEvidenceUpload";
import { assessFeedbackTranscriptWindow, FEEDBACK_TRANSCRIPT_REPORT_WINDOW_TOLERANCE_MS } from "../feedbackTranscriptWindow";
import { logger } from "../logger";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FeedbackTranscriptReportWindowInput {
  reportGeneratedAt: string;
  reportTimeSource: FeedbackTranscriptReportTimeSource;
}

export interface FeedbackTranscriptCollectionResult {
  traceBundleId?: string;
  reachable: boolean;
  fallbackReason?: string;
  error?: string;
  transcriptWindow?: FeedbackTranscriptWindow;
  /** Tier 2 outcome; present only when the owner opted in for this report. */
  machineLogTail?: FeedbackMachineLogTailOutcome;
  /** machine_evidence outcome; never decides the fields above. */
  machineEvidence?: FeedbackMachineEvidenceOutcome;
}

interface FeedbackTranscriptSourceResult {
  runtime: string;
  sessionId: string;
  reachable: boolean;
  fallbackReason?: string;
  transcript: string | null;
  sizeBytes: number;
  truncated?: boolean;
  truncationDirection?: "head" | "tail" | "window";
}

export function defaultFeedbackTranscriptReportWindow(): FeedbackTranscriptReportWindowInput {
  return {
    reportGeneratedAt: currentDate().toISOString(),
    reportTimeSource: "server_request_received",
  };
}

export async function collectFeedbackTranscriptAttachment(input: {
  agentId: string;
  feedbackReportId: string;
  reportWindow: FeedbackTranscriptReportWindowInput;
  getSessionTranscript: () => Promise<FeedbackTranscriptSourceResult>;
  /**
   * Tier-1 machine-side context. REQUIRED, not optional: the two-tier ruling
   * makes tier 1 travel with every upload and adds no toggle, so a call site
   * must not be able to forget it — an optional provider would be a switch
   * wearing a different name. Return `null` only when the summary could not be
   * built. It travels in the separate machine_evidence object, never in the
   * transcript attestation; a throw, a hang or an upload failure there is
   * reported in `machineEvidence` and never touches the transcript.
   *
   * Receives the SAME window the transcript was assessed against. The two
   * halves of one report must describe one period; letting the machine-side
   * context choose its own range would produce a report whose parts quietly
   * disagree about when.
   */
  getObservedFailureSummary: (window: {
    from: string;
    to: string;
  }) => Promise<ObservedFailureSummary | null>;
  /**
   * Tier-2 machine log tail (task #272). Unlike tier 1 this IS a toggle by
   * ruling: free text leaves the machine only when its OWNER ticked the box
   * for this one report, so the flag is explicit and defaults to nothing.
   * Runs even when the transcript is unreachable — that is precisely the case
   * (stuck or crashed runtime) where the runner log is the only evidence.
   */
  machineLogTail?: {
    include: boolean;
    collect: (window: { from: string; to: string }) => Promise<FeedbackMachineLogTailOutcome>;
  };
  /**
   * task #279: default machine-side evidence, REQUIRED like tier 1 (no toggle).
   * Both are field projections (see shared feedbackMachineEvidence); `null`
   * means "could not build" and the upload proceeds without the field.
   */
  getMachineEvidence: (window: { from: string; to: string }) => Promise<{
    traceTail: FeedbackTraceTail | null;
    machineState: FeedbackMachineState | null;
  }>;
  /** Max wait for the machine_evidence outcome after the transcript finished. */
  machineEvidenceWaitMs?: number;
  /** Raw byte cap of the evidence object (tests); defaults to the shared cap. */
  machineEvidenceMaxBytes?: number;
  serverUrl: string;
  daemonApiKey: string;
  workerUrl: string | null;
  tracer: Tracer;
  fetchImpl: FetchLike;
}): Promise<FeedbackTranscriptCollectionResult> {
  const transcriptResult = await input.getSessionTranscript();
  if (!transcriptResult.reachable || !transcriptResult.transcript) {
    // No transcript to anchor a window on; fall back to the report instant
    // minus the standard tolerance so tier 2 still describes one period.
    const reportGeneratedMs = Date.parse(input.reportWindow.reportGeneratedAt);
    const fallbackWindow = Number.isFinite(reportGeneratedMs)
      ? {
        from: new Date(reportGeneratedMs - FEEDBACK_TRANSCRIPT_REPORT_WINDOW_TOLERANCE_MS).toISOString(),
        to: new Date(reportGeneratedMs).toISOString(),
      }
      : null;
    const machineLogTail = input.machineLogTail?.include && fallbackWindow
      ? await collectMachineLogTailSafely(input.machineLogTail.collect, fallbackWindow, input)
      : undefined;
    return {
      reachable: false,
      fallbackReason: transcriptResult.fallbackReason ?? "transcript not reachable",
      ...(machineLogTail ? { machineLogTail } : {}),
    };
  }

  const transcriptWindow = assessFeedbackTranscriptWindow({
    transcript: transcriptResult.transcript,
    ...input.reportWindow,
  });
  const reportWindow = { from: transcriptWindow.reportWindowStartAt, to: transcriptWindow.reportGeneratedAt };
  // Diagnostics (summary, trace tail, machine state) are generated and
  // uploaded CONCURRENTLY as their own machine_evidence object. The promise
  // never rejects; the transcript below neither carries them nor waits on them
  // beyond a bounded settle at the end.
  const evidenceWorkerUrl = input.workerUrl;
  const machineEvidencePromise = evidenceWorkerUrl
    ? startFeedbackMachineEvidence(() => uploadFeedbackMachineEvidence({
      agentId: input.agentId,
      feedbackReportId: input.feedbackReportId,
      window: reportWindow,
      getObservedFailureSummary: input.getObservedFailureSummary,
      getMachineEvidence: input.getMachineEvidence,
      serverUrl: input.serverUrl,
      daemonApiKey: input.daemonApiKey,
      workerUrl: evidenceWorkerUrl,
      tracer: input.tracer,
      fetchImpl: input.fetchImpl,
      ...(input.machineEvidenceMaxBytes !== undefined ? { maxBytes: input.machineEvidenceMaxBytes } : {}),
    }), `report=${input.feedbackReportId} agent=${input.agentId}`)
    : null;
  const settleMachineEvidence = () => machineEvidencePromise
    ? settleMachineEvidenceWithin(
      machineEvidencePromise,
      input.machineEvidenceWaitMs ?? FEEDBACK_MACHINE_EVIDENCE_WAIT_MS,
      `report=${input.feedbackReportId} agent=${input.agentId}`,
    )
    : Promise.resolve(undefined);
  // Same window as the transcript and tier 1: one report, one period.
  const machineLogTail = input.machineLogTail?.include
    ? await collectMachineLogTailSafely(input.machineLogTail.collect, {
      from: transcriptWindow.reportWindowStartAt,
      to: transcriptWindow.reportGeneratedAt,
    }, input)
    : undefined;
  if (!input.workerUrl) {
    return {
      reachable: true,
      fallbackReason: "daemon worker URL is not configured",
      transcriptWindow,
      ...(machineLogTail ? { machineLogTail } : {}),
    };
  }

  const span = input.tracer.startSpan("daemon.feedback_transcript.upload", {
    surface: "daemon",
    kind: "producer",
    attrs: {
      agentId: input.agentId,
      feedbackReportId: input.feedbackReportId,
      runtime: transcriptResult.runtime,
      sessionId: transcriptResult.sessionId,
      transcript_size_bytes: transcriptResult.sizeBytes,
      transcript_window_coverage: transcriptWindow.coverage,
      transcript_window_report_time_source: transcriptWindow.reportTimeSource,
    },
  });

  try {
    const gzipped = gzipSync(Buffer.from(transcriptResult.transcript, "utf8"));
    const bundleSha256 = createHash("sha256").update(gzipped).digest("hex");
    const bundleSizeBytes = gzipped.byteLength;
    const bundleId = randomUUID();
    const uploadResult = await uploadWithSignedCapability({
      serverUrl: input.serverUrl,
      apiKey: input.daemonApiKey,
      workerUrl: input.workerUrl,
      scope: "daemon-trace-bundle:create",
      createPath: "/api/trace-bundles",
      createBody: { bundleSha256, bundleSizeBytes },
      attestationMetadata: {
        bundleId,
        bundleSha256,
        bundleSizeBytes,
        bundleContentType: "application/json",
        bundleContentEncoding: "gzip",
        feedbackReportId: input.feedbackReportId,
        agentId: input.agentId,
        feedbackReportGeneratedAt: transcriptWindow.reportGeneratedAt,
        feedbackReportTimeSource: transcriptWindow.reportTimeSource,
        feedbackReportWindowStartAt: transcriptWindow.reportWindowStartAt,
        feedbackTranscriptWindowToleranceMs: transcriptWindow.toleranceMs,
        feedbackTranscriptWindowCoverage: transcriptWindow.coverage,
        ...(transcriptResult.truncated !== undefined
          ? { feedbackTranscriptTruncated: transcriptResult.truncated ? "true" : "false" }
          : {}),
        ...(transcriptResult.truncationDirection
          ? { feedbackTranscriptTruncationDirection: transcriptResult.truncationDirection }
          : {}),
        ...(transcriptWindow.transcriptFirstEventAt
          ? { feedbackTranscriptFirstEventAt: transcriptWindow.transcriptFirstEventAt }
          : {}),
        ...(transcriptWindow.transcriptLastEventAt
          ? { feedbackTranscriptLastEventAt: transcriptWindow.transcriptLastEventAt }
          : {}),
        // NO diagnostics and NO digest of them here: they are the separate
        // machine_evidence object. Anything optional in this signed token
        // competes with the transcript for the attestation budget.
      },
      uploadBody: new Blob([new Uint8Array(gzipped)], { type: "application/json" }),
      fetchImpl: input.fetchImpl,
    });

    const traceBundleId = typeof uploadResult.session.id === "string" ? uploadResult.session.id : bundleId;
    logger.info(`[FeedbackTranscript] uploaded for report=${input.feedbackReportId} agent=${input.agentId} traceBundleId=${traceBundleId} size=${bundleSizeBytes}`);
    span.end("ok", { attrs: { traceBundleId, bundleSizeBytes, transcript_window_coverage: transcriptWindow.coverage } });
    const machineEvidence = await settleMachineEvidence();
    return {
      reachable: true,
      traceBundleId,
      transcriptWindow,
      ...(machineLogTail ? { machineLogTail } : {}),
      ...(machineEvidence ? { machineEvidence } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[FeedbackTranscript] upload failed for report=${input.feedbackReportId} agent=${input.agentId}: ${message}`);
    span.end("error", { attrs: { error_class: err instanceof Error ? err.name : "Error", error_message: message } });
    const machineEvidence = await settleMachineEvidence();
    return {
      reachable: true,
      error: message,
      transcriptWindow,
      ...(machineLogTail ? { machineLogTail } : {}),
      ...(machineEvidence ? { machineEvidence } : {}),
    };
  }
}

// A diagnostic add-on must never take the transcript upload down with it.
async function collectMachineLogTailSafely(
  collect: (window: { from: string; to: string }) => Promise<FeedbackMachineLogTailOutcome>,
  window: { from: string; to: string },
  input: { agentId: string; feedbackReportId: string },
): Promise<FeedbackMachineLogTailOutcome> {
  try {
    return await collect(window);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[FeedbackMachineLogTail] collection failed for report=${input.feedbackReportId} agent=${input.agentId}: ${message}`);
    return { reachable: false, error: message };
  }
}
