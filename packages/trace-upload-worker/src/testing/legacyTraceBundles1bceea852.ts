// FROZEN COPY — test fixture only. This is packages/trace-upload-worker/src/
// traces/bundles.ts exactly as it was on staging 1bceea852 (machine_evidence
// known, transcript_outcome NOT known; no transcript content label / byte
// counts / request id in the ledger), with only two rewrites: import paths for
// this directory, and the shared `isFeedbackAttachmentKind` replaced by the
// closed kind list as it was on 1bceea852 (the shared list now includes
// transcript_outcome, and the frozen worker must not learn it). It stands in
// for an OLD deployed worker in cross-version tests (new daemon -> old
// worker). Do not "fix" or update it.
// Daemon / Computer trace bundle uploads: attestation → PUT object → trace ledger,
// then best-effort OTLP ingest. Bundles attested with a feedbackReportId are also
// filed in that report's index folder.
import { SCOPE_ATTESTATION_MAX_CHARS } from "@botiverse/raft-shared";
import type { ExecutionContextLike, TraceUploadWorkerEnv } from "../env";
import { feedbackReportTraceLedgerKey } from "../feedback/ledgerKeys";
import { readWindowCoverageClaims } from "../shared/transcriptCoverage";
import {
  SESSION_TTL_SECONDS,
  getUploadSessionSecret,
  sha256Hex,
  signToken,
  verifyScopeAttestation,
  verifyToken,
  type ScopeAttestationClaims,
} from "../shared/auth";
import {
  HttpError,
  jsonResponse,
  readInteger,
  readJsonObject,
  readOptionalString,
  readRequestBodyWithLimit,
  readSha256,
  readString,
} from "../shared/http";
import { validateMachineEvidenceObject } from "../traces/machineEvidence";
import { ingestTraceBundleObject } from "../traces/otlp";
import type { TraceProjectionSkipReasonClass } from "../traces/traceEventProjector";
import { initialV2ProjectorStatus, type V2ProjectorStatus } from "../traces/v2Projection";

// The closed attachment-kind set as it was on 1bceea852.
const FEEDBACK_ATTACHMENT_KINDS_1BCEEA852 = ["session_transcript", "machine_log_tail", "machine_evidence"] as const;
type FeedbackAttachmentKind = (typeof FEEDBACK_ATTACHMENT_KINDS_1BCEEA852)[number];
function isFeedbackAttachmentKind(value: unknown): value is FeedbackAttachmentKind {
  return typeof value === "string" && (FEEDBACK_ATTACHMENT_KINDS_1BCEEA852 as readonly string[]).includes(value);
}

const TRACE_UPLOAD_SCOPE = "daemon-trace-bundle:create";

export const TRACE_UPLOAD_AUDIENCE = "trace-ingest-worker";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

interface TraceUploadSessionClaims {
  v: 1;
  typ: "trace-upload-session";
  uploadId: string;
  objectKey: string;
  bundleId: string;
  bundleSha256: string;
  bundleSizeBytes: number;
  maxBytes: number;
  contentType: string;
  contentEncoding?: string;
  serverId: string;
  machineId: string;
  deploymentEnvironment?: string;
  feedbackReportId?: string;
  agentId?: string;
  transcriptCoverage?: string;
  transcriptFirstEventAt?: string;
  transcriptLastEventAt?: string;
  transcriptTruncated?: "true" | "false";
  transcriptTruncationDirection?: "head" | "tail" | "window";
  transcriptAnchorSource?: string;
  feedbackAttachmentKind?: FeedbackAttachmentKind;
  exp: number;
}

// Which report attachment a feedback-linked trace bundle carries
// (FeedbackAttachmentKind, closed enum shared with the server). The server
// signs it into the attestation; readers use it to tell the runtime transcript,
// the machine log tail and the machine evidence apart without sniffing content.

export type TraceBundleMetadata = {
  uploadId: string;
  bundleId: string;
  objectKey: string;
  bundleSha256: string;
  bundleSizeBytes: number;
  serverId: string;
  machineId: string;
  deploymentEnvironment?: string;
  feedbackReportId?: string;
  agentId?: string;
  transcriptCoverage?: string;
  transcriptFirstEventAt?: string;
  transcriptLastEventAt?: string;
  transcriptTruncated?: "true" | "false";
  transcriptTruncationDirection?: "head" | "tail" | "window";
  transcriptAnchorSource?: string;
  feedbackAttachmentKind?: FeedbackAttachmentKind;
};

export async function createTraceBundleUpload(request: Request, env: TraceUploadWorkerEnv): Promise<Response> {
  const body = await readJsonObject(request);
  const attestation = readString(body.attestation, "attestation", SCOPE_ATTESTATION_MAX_CHARS);
  const claims = await verifyScopeAttestation(attestation, env);
  validateTraceUploadClaims(claims);

  const metadata = claims.metadata ?? {};
  const uploadId = readString(metadata.uploadId, "attestation.metadata.uploadId", 128);
  const objectKey = readString(metadata.objectKey, "attestation.metadata.objectKey", 1024);
  const maxBytes = readInteger(metadata.maxBytes, "attestation.metadata.maxBytes", getConfiguredMaxBytes(env));
  const bundleId = readString(metadata.bundleId, "attestation.metadata.bundleId", 128);
  const bundleSha256 = readSha256(metadata.bundleSha256, "attestation.metadata.bundleSha256");
  const bundleSizeBytes = readInteger(metadata.bundleSizeBytes, "attestation.metadata.bundleSizeBytes", maxBytes);
  const contentType = readOptionalString(metadata.bundleContentType, "attestation.metadata.bundleContentType", 128) ?? "application/x-ndjson";
  const contentEncoding = readOptionalString(metadata.bundleContentEncoding, "attestation.metadata.bundleContentEncoding", 64) ?? undefined;
  const deploymentEnvironment = readOptionalString(
    metadata.deploymentEnvironment,
    "attestation.metadata.deploymentEnvironment",
    64,
  ) ?? undefined;
  const feedbackReportId = readOptionalString(metadata.feedbackReportId, "attestation.metadata.feedbackReportId", 128) ?? undefined;
  const agentId = readOptionalString(metadata.agentId, "attestation.metadata.agentId", 128) ?? undefined;
  const transcriptCoverageClaims = readWindowCoverageClaims(metadata);
  // A signed kind this worker does not know is refused, never silently
  // dropped: dropping it would store the object as an untyped trace bundle
  // and report success to a producer that asked for something else.
  if (metadata.feedbackAttachmentKind !== undefined && !isFeedbackAttachmentKind(metadata.feedbackAttachmentKind)) {
    throw new HttpError(400, "attestation.metadata.feedbackAttachmentKind is not supported by this worker");
  }
  const feedbackAttachmentKind: FeedbackAttachmentKind | undefined = metadata.feedbackAttachmentKind;
  if (feedbackAttachmentKind === "machine_evidence") {
    // The evidence object is bound to one report and one agent, and its PUT
    // is parsed as gzipped JSON; anything else is not a machine_evidence object.
    if (!feedbackReportId || !agentId) throw new HttpError(400, "machine_evidence requires feedbackReportId and agentId");
    if (contentType !== "application/json" || contentEncoding !== "gzip") {
      throw new HttpError(400, "machine_evidence must be gzipped application/json");
    }
  }

  if (readSha256(body.bundleSha256, "bundleSha256") !== bundleSha256) {
    throw new HttpError(400, "bundleSha256 does not match signed metadata");
  }
  if (readInteger(body.bundleSizeBytes, "bundleSizeBytes", maxBytes) !== bundleSizeBytes) {
    throw new HttpError(400, "bundleSizeBytes does not match signed metadata");
  }

  const session: TraceUploadSessionClaims = {
    v: 1,
    typ: "trace-upload-session",
    uploadId,
    objectKey,
    bundleId,
    bundleSha256,
    bundleSizeBytes,
    maxBytes,
    contentType,
    ...(contentEncoding ? { contentEncoding } : {}),
    serverId: claims.serverId,
    machineId: claims.machineId ?? "",
    ...(deploymentEnvironment ? { deploymentEnvironment } : {}),
    ...(feedbackReportId ? { feedbackReportId } : {}),
    ...(agentId ? { agentId } : {}),
    ...transcriptCoverageClaims,
    ...(feedbackAttachmentKind ? { feedbackAttachmentKind } : {}),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const token = await signToken(session, getUploadSessionSecret(env));
  const uploadUrl = new URL(`/api/trace-bundles/${encodeURIComponent(uploadId)}/object`, request.url);
  uploadUrl.searchParams.set("token", token);

  return jsonResponse({
    id: uploadId,
    // Acknowledges the signed kind. A daemon uploading a non-transcript kind
    // checks this before its PUT: a worker that does not echo the kind does
    // not understand it, and the object must not be uploaded there.
    ...(feedbackAttachmentKind ? { feedbackAttachmentKind } : {}),
    upload: {
      method: "PUT",
      url: uploadUrl.toString(),
      headers: {
        "Content-Type": contentType,
        ...(contentEncoding ? { "Content-Encoding": contentEncoding } : {}),
      },
    },
  });
}

export async function putTraceBundleObject(
  request: Request,
  env: TraceUploadWorkerEnv,
  uploadId: string,
  ctx?: ExecutionContextLike,
): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) throw new HttpError(401, "Missing upload token");
  const claims = await verifyToken<TraceUploadSessionClaims>(token, getUploadSessionSecret(env));
  if (claims.typ !== "trace-upload-session" || claims.uploadId !== uploadId) {
    throw new HttpError(401, "Invalid upload token");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedContentLength = Number(contentLength);
    if (!Number.isInteger(parsedContentLength) || parsedContentLength < 0) {
      throw new HttpError(400, "Invalid Content-Length");
    }
    if (parsedContentLength > claims.maxBytes) throw new HttpError(413, "Bundle exceeds maxBytes");
    if (parsedContentLength !== claims.bundleSizeBytes) throw new HttpError(400, "bundleSizeBytes mismatch");
  }

  const body = await readRequestBodyWithLimit(request, claims.maxBytes);
  if (body.byteLength !== claims.bundleSizeBytes) throw new HttpError(400, "bundleSizeBytes mismatch");
  const actualSha256 = await sha256Hex(body);
  if (actualSha256 !== claims.bundleSha256) throw new HttpError(400, "bundleSha256 mismatch");
  const isMachineEvidence = claims.feedbackAttachmentKind === "machine_evidence";
  if (isMachineEvidence) await validateMachineEvidenceObject(body, claims);

  const result = await env.TRACE_BUNDLES.put(claims.objectKey, body, {
    httpMetadata: {
      contentType: claims.contentType,
      ...(claims.contentEncoding ? { contentEncoding: claims.contentEncoding } : {}),
    },
    customMetadata: {
      uploadId: claims.uploadId,
      bundleId: claims.bundleId,
      bundleSha256: claims.bundleSha256,
      bundleSizeBytes: String(claims.bundleSizeBytes),
      serverId: claims.serverId,
      machineId: claims.machineId,
      ...(claims.deploymentEnvironment ? { deploymentEnvironment: claims.deploymentEnvironment } : {}),
      ...(claims.feedbackReportId ? { feedbackReportId: claims.feedbackReportId } : {}),
      ...(claims.agentId ? { agentId: claims.agentId } : {}),
      ...(claims.transcriptCoverage ? { transcriptCoverage: claims.transcriptCoverage } : {}),
      ...(claims.transcriptFirstEventAt ? { transcriptFirstEventAt: claims.transcriptFirstEventAt } : {}),
      ...(claims.transcriptLastEventAt ? { transcriptLastEventAt: claims.transcriptLastEventAt } : {}),
      ...(claims.transcriptTruncated ? { transcriptTruncated: claims.transcriptTruncated } : {}),
      ...(claims.transcriptTruncationDirection
        ? { transcriptTruncationDirection: claims.transcriptTruncationDirection }
        : {}),
      ...(claims.transcriptAnchorSource ? { transcriptAnchorSource: claims.transcriptAnchorSource } : {}),
      ...(claims.feedbackAttachmentKind ? { feedbackAttachmentKind: claims.feedbackAttachmentKind } : {}),
    },
  });
  // machine_evidence is one JSON object, not trace JSONL: it is filed in the
  // ledgers (so the report folder lists it) but never handed to OTLP ingest.
  await writeTraceUploadLedger(env, claims, {
    r2_status: "success",
    scopedb_status: !isMachineEvidence && env.TRACE_INGEST_OTLP_ENDPOINT ? "pending" : "skipped",
    v2_projector_status: isMachineEvidence ? "skipped" : initialV2ProjectorStatus(env),
  });
  if (!isMachineEvidence) await scheduleTraceBundleIngest(env, claims, ctx);

  return new Response(null, {
    status: 200,
    headers: {
      ...(result?.etag ? { etag: result.etag } : {}),
    },
  });
}

async function scheduleTraceBundleIngest(
  env: TraceUploadWorkerEnv,
  claims: TraceUploadSessionClaims,
  ctx?: ExecutionContextLike,
): Promise<void> {
  if (!env.TRACE_INGEST_OTLP_ENDPOINT) return;

  // Carry every ledger field: the ingest outcome rewrites the ledger (and the
  // report-folder copy), which must not drop the transcript coverage facts.
  const metadata: TraceBundleMetadata = {
    uploadId: claims.uploadId,
    bundleId: claims.bundleId,
    objectKey: claims.objectKey,
    bundleSha256: claims.bundleSha256,
    bundleSizeBytes: claims.bundleSizeBytes,
    serverId: claims.serverId,
    machineId: claims.machineId,
    deploymentEnvironment: claims.deploymentEnvironment,
    feedbackReportId: claims.feedbackReportId,
    agentId: claims.agentId,
    transcriptCoverage: claims.transcriptCoverage,
    transcriptFirstEventAt: claims.transcriptFirstEventAt,
    transcriptLastEventAt: claims.transcriptLastEventAt,
    transcriptTruncated: claims.transcriptTruncated,
    transcriptTruncationDirection: claims.transcriptTruncationDirection,
    transcriptAnchorSource: claims.transcriptAnchorSource,
    feedbackAttachmentKind: claims.feedbackAttachmentKind,
  };
  const promise = ingestTraceBundleObject(env, metadata)
    .then(async (result) => {
      await tryWriteTraceUploadLedger(env, metadata, {
        r2_status: "success",
        scopedb_status: "success",
        spans_ingested: result.spans_ingested,
        ...(result.events_ingested ? { events_ingested: result.events_ingested } : {}),
        batches_sent: result.batches_sent,
        v2_projector_status: result.v2_projector_status,
        v2_spans_projected: result.v2_spans_projected,
        v2_rows_projected: result.v2_rows_projected,
        v2_spans_skipped: result.v2_spans_skipped,
        v2_skip_reason_classes: result.v2_skip_reason_classes,
        ...(result.v2_error_class ? { v2_error_class: result.v2_error_class } : {}),
      });
    })
    .catch(async (err) => {
      await tryWriteTraceUploadLedger(env, metadata, {
        r2_status: "success",
        scopedb_status: "failed",
        v2_projector_status: "skipped",
        error_class: err instanceof Error ? err.name : "Error",
        error_message_present: err instanceof Error && Boolean(err.message),
      });
      console.warn("[TraceUploadWorker] trace bundle ingest failed:", err instanceof Error ? err.message : String(err));
    });
  ctx?.waitUntil(promise);
}

export async function writeTraceUploadLedger(
  env: TraceUploadWorkerEnv,
  metadata: TraceBundleMetadata,
  status: {
    r2_status: "success";
    scopedb_status: "pending" | "success" | "failed" | "skipped";
    v2_projector_status?: "pending" | V2ProjectorStatus;
    spans_ingested?: number;
    events_ingested?: number;
    batches_sent?: number;
    v2_spans_projected?: number;
    v2_rows_projected?: number;
    v2_spans_skipped?: number;
    v2_skip_reason_classes?: readonly TraceProjectionSkipReasonClass[];
    v2_error_class?: string;
    error_class?: string;
    error_message_present?: boolean;
  },
): Promise<void> {
  const record = {
    type: "daemon_trace_upload",
    schema_version: 1,
    updated_at: new Date().toISOString(),
    upload_id: metadata.uploadId,
    bundle_id: metadata.bundleId,
    object_key: metadata.objectKey,
    ledger_key: traceUploadLedgerKey(metadata),
    bundle_sha256: metadata.bundleSha256,
    bundle_size_bytes: metadata.bundleSizeBytes,
    server_id: metadata.serverId,
    machine_id: metadata.machineId,
    ...(metadata.deploymentEnvironment ? { deployment_environment: metadata.deploymentEnvironment } : {}),
    ...(metadata.feedbackReportId ? { feedback_report_id: metadata.feedbackReportId } : {}),
    ...(metadata.agentId ? { agent_id: metadata.agentId } : {}),
    ...(metadata.transcriptCoverage ? { transcript_coverage: metadata.transcriptCoverage } : {}),
    ...(metadata.transcriptFirstEventAt
      ? { transcript_first_event_at: metadata.transcriptFirstEventAt }
      : {}),
    ...(metadata.transcriptLastEventAt
      ? { transcript_last_event_at: metadata.transcriptLastEventAt }
      : {}),
    ...(metadata.transcriptTruncated ? { transcript_truncated: metadata.transcriptTruncated } : {}),
    ...(metadata.transcriptTruncationDirection
      ? { transcript_truncation_direction: metadata.transcriptTruncationDirection }
      : {}),
    ...(metadata.transcriptAnchorSource ? { transcript_anchor_source: metadata.transcriptAnchorSource } : {}),
    ...(metadata.feedbackAttachmentKind ? { feedback_attachment_kind: metadata.feedbackAttachmentKind } : {}),
    span_key_identity: "serverId:machineId:bundleSha256:trace_id:span_id",
    ...status,
  };
  const options = {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      uploadId: metadata.uploadId,
      bundleId: metadata.bundleId,
      bundleSha256: metadata.bundleSha256,
      serverId: metadata.serverId,
      machineId: metadata.machineId,
      ledgerType: "daemon-trace-upload",
      ...(metadata.feedbackReportId ? { feedbackReportId: metadata.feedbackReportId } : {}),
      ...(metadata.agentId ? { agentId: metadata.agentId } : {}),
    },
  };
  const body = JSON.stringify(record, null, 2);
  await env.TRACE_BUNDLES.put(traceUploadLedgerKey(metadata), body, options);
  // A bundle collected for a feedback report (runtime transcript, machine log
  // tail) is also filed under that report's ledger folder, so everything one
  // report produced is found by listing a single prefix. Those bundles otherwise
  // sit among every machine's routine traces under trace-ledgers/.
  if (metadata.feedbackReportId) {
    await env.TRACE_BUNDLES.put(
      feedbackReportTraceLedgerKey({ ...metadata, feedbackReportId: metadata.feedbackReportId }),
      body,
      options,
    );
  }
}

// Ledger writes from the background ingest chain are bookkeeping, not request
// serving: a storage failure there must never reject the chain. Task #426: an
// R2 503 on this PUT used to escape the detached promise as an
// unhandledRejection and kill the process. Failures are logged on a stable,
// countable line instead (`[TraceUploadLedger] write_failed`).
async function tryWriteTraceUploadLedger(
  env: TraceUploadWorkerEnv,
  metadata: TraceBundleMetadata,
  status: Parameters<typeof writeTraceUploadLedger>[2],
): Promise<void> {
  try {
    await writeTraceUploadLedger(env, metadata, status);
  } catch (error) {
    console.error("[TraceUploadLedger] write_failed", {
      upload_id: metadata.uploadId,
      bundle_id: metadata.bundleId,
      error_class: error instanceof Error ? error.name : "Error",
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}

function traceUploadLedgerKey(metadata: { serverId: string; machineId: string; uploadId: string }): string {
  return `trace-ledgers/${metadata.serverId}/${metadata.machineId}/${metadata.uploadId}.json`;
}

function validateTraceUploadClaims(claims: ScopeAttestationClaims): void {
  if (claims.typ !== "scope-attestation") throw new HttpError(401, "Invalid attestation type");
  if (claims.scope !== TRACE_UPLOAD_SCOPE) throw new HttpError(403, "Invalid attestation scope");
  if (claims.aud !== TRACE_UPLOAD_AUDIENCE) throw new HttpError(403, "Invalid attestation audience");
  if (!claims.serverId || !claims.machineId) throw new HttpError(403, "Missing trace upload identity");
  const expectedResource = `servers/${claims.serverId}/machines/${claims.machineId}/trace-bundles`;
  if (claims.resource !== expectedResource) throw new HttpError(403, "Invalid attestation resource");
}

function getConfiguredMaxBytes(env: TraceUploadWorkerEnv): number {
  if (!env.TRACE_UPLOAD_MAX_BYTES) return DEFAULT_MAX_BYTES;
  const parsed = Number(env.TRACE_UPLOAD_MAX_BYTES);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

/**
 * The 1bceea852 worker's request router, restricted to the trace-bundle
 * create/PUT routes the daemon uses. Every other path is a 404, as it would
 * be for routes this fixture does not model.
 */
export async function legacyHandleRequest1bceea852(request: Request, env: TraceUploadWorkerEnv, ctx?: ExecutionContextLike): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "POST" && url.pathname === "/api/trace-bundles") {
      return await createTraceBundleUpload(request, env);
    }
    const objectMatch = url.pathname.match(/^\/api\/trace-bundles\/([^/]+)\/object$/);
    if (request.method === "PUT" && objectMatch) {
      return await putTraceBundleObject(request, env, decodeURIComponent(objectMatch[1]), ctx);
    }
    return jsonResponse({ error: "Not found" }, 404);
  } catch (err) {
    if (err instanceof HttpError) return jsonResponse({ error: err.message }, err.status);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
}
