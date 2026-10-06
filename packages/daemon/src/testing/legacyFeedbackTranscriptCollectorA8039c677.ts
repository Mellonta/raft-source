// FROZEN COPY — test fixture only. This is packages/daemon/src/
// feedbackTranscriptCollector.ts exactly as it was on staging a8039c677 (the
// last daemon that put observedFailureSummary / feedbackTraceTail /
// feedbackMachineState INSIDE the transcript attestation), with only its
// import paths rewritten for this directory. It stands in for an OLD deployed
// daemon in cross-version tests (old daemon -> new server -> new worker). Do
// not "fix" or update it: its value is that it still sends the old shape.
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  currentDate,
  type FeedbackMachineLogTailOutcome,
  type FeedbackMachineState,
  type FeedbackTraceTail,
  type FeedbackTranscriptReportTimeSource,
  type FeedbackTranscriptWindow,
  type ObservedFailureSummary,
  type Tracer,
} from "@botiverse/raft-shared";
import { uploadWithSignedCapability } from "../directUploadCapability";
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
   * built; the upload then proceeds without the field, because a diagnostic
   * add-on must never break the channel users report problems through.
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
  // Bound to the transcript's own window, and built before the worker-URL
  // check so a missing worker cannot change what the summary would contain.
  const observedFailureSummary = await input.getObservedFailureSummary({
    from: transcriptWindow.reportWindowStartAt,
    to: transcriptWindow.reportGeneratedAt,
  });
  // task #279: same window, same discipline (fail-open to null).
  const machineEvidence = await input.getMachineEvidence({
    from: transcriptWindow.reportWindowStartAt,
    to: transcriptWindow.reportGeneratedAt,
  }).catch(() => ({ traceTail: null, machineState: null }));
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
        // The module output verbatim. Nothing is stringified, annotated, or
        // merged into it here: the field either is what the module produced or
        // is absent. Omitted when the summary could not be built, which is the
        // only reason it is ever missing on a current daemon.
        ...(observedFailureSummary ? { observedFailureSummary } : {}),
        // task #279: module outputs verbatim, absent only when not buildable.
        ...(machineEvidence.traceTail ? { feedbackTraceTail: machineEvidence.traceTail } : {}),
        ...(machineEvidence.machineState ? { feedbackMachineState: machineEvidence.machineState } : {}),
      },
      uploadBody: new Blob([new Uint8Array(gzipped)], { type: "application/json" }),
      fetchImpl: input.fetchImpl,
    });

    const traceBundleId = typeof uploadResult.session.id === "string" ? uploadResult.session.id : bundleId;
    logger.info(`[FeedbackTranscript] uploaded for report=${input.feedbackReportId} agent=${input.agentId} traceBundleId=${traceBundleId} size=${bundleSizeBytes}`);
    span.end("ok", { attrs: { traceBundleId, bundleSizeBytes, transcript_window_coverage: transcriptWindow.coverage } });
    return { reachable: true, traceBundleId, transcriptWindow, ...(machineLogTail ? { machineLogTail } : {}) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[FeedbackTranscript] upload failed for report=${input.feedbackReportId} agent=${input.agentId}: ${message}`);
    span.end("error", { attrs: { error_class: err instanceof Error ? err.name : "Error", error_message: message } });
    return { reachable: true, error: message, transcriptWindow, ...(machineLogTail ? { machineLogTail } : {}) };
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
