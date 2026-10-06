// The machine_evidence attachment of a feedback report: observed-failure
// summary, trace-tail projection and machine state, uploaded as ONE separate
// object with its OWN signed attestation.
//
// Why separate: these diagnostics used to ride inside the transcript upload's
// signed attestation, and a busy trace window pushed that token past the
// worker's attestation budget, so the transcript itself was never stored. The
// transcript attestation now carries no diagnostics and no digest of them;
// nothing here can delay or fail the transcript. Every failure mode of this
// path (generation, size, signing, an older server/worker, upload, timeout)
// ends in an explicit outcome reported beside the transcript result.
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  buildBoundedFeedbackMachineEvidence,
  FEEDBACK_MACHINE_EVIDENCE_MAX_BYTES,
  type FeedbackMachineEvidenceOutcome,
  type FeedbackMachineEvidenceSection,
  type FeedbackMachineState,
  type FeedbackTraceTail,
  type ObservedFailureSummary,
  type Tracer,
} from "@botiverse/raft-shared";
import { uploadWithSignedCapability } from "./directUploadCapability";
import { logger } from "./logger";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** How long the transcript result may wait for the evidence after the transcript itself finished. */
export const FEEDBACK_MACHINE_EVIDENCE_WAIT_MS = 10_000;

/** The server or worker does not know the machine_evidence kind (older deployment). */
export class MachineEvidenceUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachineEvidenceUnsupportedError";
  }
}

export interface FeedbackMachineEvidenceInput {
  agentId: string;
  feedbackReportId: string;
  /** The transcript's own window: one report, one period. */
  window: { from: string; to: string };
  getObservedFailureSummary: (window: { from: string; to: string }) => Promise<ObservedFailureSummary | null>;
  getMachineEvidence: (window: { from: string; to: string }) => Promise<{
    traceTail: FeedbackTraceTail | null;
    machineState: FeedbackMachineState | null;
  }>;
  serverUrl: string;
  daemonApiKey: string;
  workerUrl: string;
  tracer: Tracer;
  fetchImpl: FetchLike;
  maxBytes?: number;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Never rejects: every failure becomes an outcome. */
export async function uploadFeedbackMachineEvidence(input: FeedbackMachineEvidenceInput): Promise<FeedbackMachineEvidenceOutcome> {
  const tag = `report=${input.feedbackReportId} agent=${input.agentId}`;
  const unavailable: FeedbackMachineEvidenceSection[] = [];
  const [summary, machine] = await Promise.all([
    // Promise.resolve().then(...) turns a provider that throws synchronously
    // into the same rejection an async failure produces.
    Promise.resolve().then(() => input.getObservedFailureSummary(input.window)).catch((err: unknown) => {
      logger.warn(`[FeedbackMachineEvidence] observed failure summary failed for ${tag}: ${messageOf(err)}`);
      unavailable.push("observedFailureSummary");
      return null;
    }),
    Promise.resolve().then(() => input.getMachineEvidence(input.window)).catch((err: unknown) => {
      logger.warn(`[FeedbackMachineEvidence] trace tail / machine state failed for ${tag}: ${messageOf(err)}`);
      unavailable.push("feedbackTraceTail", "feedbackMachineState");
      return { traceTail: null, machineState: null };
    }),
  ]);
  const sections = unavailable.length > 0 ? { unavailable } : {};

  const built = buildBoundedFeedbackMachineEvidence({
    feedbackReportId: input.feedbackReportId,
    agentId: input.agentId,
    observedFailureSummary: summary,
    feedbackTraceTail: machine.traceTail,
    feedbackMachineState: machine.machineState,
    maxBytes: input.maxBytes ?? FEEDBACK_MACHINE_EVIDENCE_MAX_BYTES,
  });
  if (!built.ok) {
    logger.warn(`[FeedbackMachineEvidence] omitted for ${tag}: ${built.bytes} bytes even without trace records (cap ${built.maxBytes})`);
    return { status: "omitted", reason: built.reason, bytes: built.bytes, ...sections };
  }
  const shape = {
    bytes: built.bytes,
    truncated: built.envelope.bounds.truncated,
    droppedOverBytes: built.envelope.bounds.dropped.overBytes,
    ...sections,
  };

  const span = input.tracer.startSpan("daemon.feedback_machine_evidence.upload", {
    surface: "daemon",
    kind: "producer",
    attrs: {
      agentId: input.agentId,
      feedbackReportId: input.feedbackReportId,
      evidence_bytes: built.bytes,
      truncated: shape.truncated,
      dropped_over_bytes: shape.droppedOverBytes,
    },
  });
  try {
    const gzipped = gzipSync(Buffer.from(built.json, "utf8"));
    const bundleSha256 = createHash("sha256").update(gzipped).digest("hex");
    const bundleId = randomUUID();
    const uploaded = await uploadWithSignedCapability({
      serverUrl: input.serverUrl,
      apiKey: input.daemonApiKey,
      workerUrl: input.workerUrl,
      scope: "daemon-trace-bundle:create",
      createPath: "/api/trace-bundles",
      createBody: { bundleSha256, bundleSizeBytes: gzipped.byteLength },
      attestationMetadata: {
        bundleId,
        bundleSha256,
        bundleSizeBytes: gzipped.byteLength,
        bundleContentType: "application/json",
        bundleContentEncoding: "gzip",
        feedbackReportId: input.feedbackReportId,
        agentId: input.agentId,
        feedbackAttachmentKind: "machine_evidence",
        feedbackReportWindowStartAt: input.window.from,
        feedbackReportGeneratedAt: input.window.to,
      },
      // An older server drops an unknown kind and signs anyway; an older
      // worker ignores it and would file the object as an untyped trace
      // bundle. Either way the object must not be uploaded.
      verifyCapability: (capability) => {
        if (capability.metadata?.feedbackAttachmentKind !== "machine_evidence") {
          throw new MachineEvidenceUnsupportedError("server did not sign feedbackAttachmentKind=machine_evidence (older server); evidence not uploaded");
        }
      },
      verifySession: (_capability, session) => {
        if (session.feedbackAttachmentKind !== "machine_evidence") {
          throw new MachineEvidenceUnsupportedError("trace upload worker did not acknowledge feedbackAttachmentKind=machine_evidence (older worker); evidence not uploaded");
        }
      },
      uploadBody: new Blob([new Uint8Array(gzipped)], { type: "application/json" }),
      fetchImpl: input.fetchImpl,
    });
    const traceBundleId = typeof uploaded.session.id === "string" ? uploaded.session.id : bundleId;
    logger.info(`[FeedbackMachineEvidence] uploaded for ${tag} traceBundleId=${traceBundleId} bytes=${built.bytes} truncated=${shape.truncated}`);
    span.end("ok", { attrs: { traceBundleId } });
    return { status: "uploaded", traceBundleId, ...shape };
  } catch (err) {
    const unsupported = err instanceof MachineEvidenceUnsupportedError;
    const message = messageOf(err);
    logger.warn(`[FeedbackMachineEvidence] ${unsupported ? "unsupported" : "upload failed"} for ${tag}: ${message}`);
    span.end("error", { attrs: { error_class: err instanceof Error ? err.name : "Error", error_message: message } });
    return { status: unsupported ? "unsupported" : "failed", error: message, ...shape };
  }
}

/**
 * Wait for the evidence at most `waitMs`. On timeout the transcript result is
 * returned without it (status "timeout"); the late outcome is still logged.
 */
/**
 * Starts the machine_evidence upload and absorbs every failure from the moment
 * the promise exists: a synchronous throw, an envelope that cannot be built, or
 * a late rejection all become a `failed` outcome. The returned promise never
 * rejects, so neither the transcript result nor an unhandled rejection can come
 * from diagnostics.
 */
export function startFeedbackMachineEvidence(
  start: () => Promise<FeedbackMachineEvidenceOutcome>,
  tag: string,
): Promise<FeedbackMachineEvidenceOutcome> {
  return Promise.resolve()
    .then(start)
    .catch((err: unknown): FeedbackMachineEvidenceOutcome => {
      logger.warn(`[FeedbackMachineEvidence] failed for ${tag}: ${messageOf(err)}`);
      return { status: "failed", error: messageOf(err) };
    });
}

export async function settleMachineEvidenceWithin(
  evidence: Promise<FeedbackMachineEvidenceOutcome>,
  waitMs: number,
  tag: string,
): Promise<FeedbackMachineEvidenceOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), waitMs);
    timer.unref?.();
  });
  const winner = await Promise.race([evidence, timedOut]);
  clearTimeout(timer);
  if (winner !== "timeout") return winner;
  void evidence.then((late) => {
    logger.warn(`[FeedbackMachineEvidence] finished after the ${waitMs}ms wait for ${tag}: status=${late.status}${late.error ? ` error=${late.error}` : ""}`);
  });
  logger.warn(`[FeedbackMachineEvidence] not finished within ${waitMs}ms for ${tag}; transcript result returned without it`);
  return { status: "timeout", error: `machine evidence did not finish within ${waitMs}ms; the transcript result was returned without it` };
}
