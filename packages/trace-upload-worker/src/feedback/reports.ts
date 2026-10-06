// Agent Report Issue uploads from the browser: create → PUT object → complete,
// stored under feedback-reports/ with their ledgers in the report's index folder.
import { SCOPE_ATTESTATION_MAX_CHARS } from "@botiverse/raft-shared";
import type { TraceUploadWorkerEnv } from "../env";
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
  isJsonObject,
  jsonResponse,
  readInteger,
  readJsonObject,
  readOptionalJsonObject,
  readOptionalString,
  readRequestBodyWithLimit,
  readSha256,
  readString,
  resolveWebCorsOrigin,
  sanitizeObjectPathSegment,
  webCorsVaryHeader,
  type JsonObject,
} from "../shared/http";
import { readWindowCoverageClaims } from "../shared/transcriptCoverage";
import { feedbackReportCompleteLedgerKey, feedbackReportLedgerKey } from "./ledgerKeys";

const FEEDBACK_REPORT_SCOPE = "feedback-report:create";

const FEEDBACK_REPORT_AUDIENCE = "feedback-worker";

export const FEEDBACK_REPORT_MAX_BYTES = 250 * 1024 * 1024;

export const FEEDBACK_REPORT_HOURLY_LIMIT = 100;

const FEEDBACK_REPORT_CORS_METHODS = "POST, PUT, OPTIONS";

export interface FeedbackReportUploadSessionClaims {
  v: 1;
  typ: "feedback-report-upload-session";
  reportId: string;
  artifactId: string;
  objectKey: string;
  bundleSha256: string;
  bundleSizeBytes: number;
  maxBytes: number;
  contentType: string;
  serverId: string;
  actorType: "user" | "machine";
  subjectId: string;
  machineId?: string;
  agentId?: string;
  source: string;
  // TOOTH-2 transport fields: propagate the six daemon-computed transcript
  // coverage keys through the upload session so downstream surfaces
  // (R2 customMetadata / ledger / webhook / detail) can read it verbatim.
  // anchor_source is a closed enum; createdAt is NOT an allowed value.
  transcriptCoverage?: string;
  transcriptFirstEventAt?: string;
  transcriptLastEventAt?: string;
  transcriptTruncated?: "true" | "false";
  transcriptTruncationDirection?: "head" | "tail" | "window";
  transcriptAnchorSource?: string;
  exp: number;
}

interface FeedbackReportCompleteSessionClaims {
  v: 1;
  typ: "feedback-report-complete-session";
  reportId: string;
  artifactId: string;
  objectKey: string;
  serverId: string;
  exp: number;
}

export async function createFeedbackReportUpload(request: Request, env: TraceUploadWorkerEnv): Promise<Response> {
  const body = await readJsonObject(request);
  const attestation = readString(body.attestation, "attestation", SCOPE_ATTESTATION_MAX_CHARS);
  const claims = await verifyScopeAttestation(attestation, env);
  validateFeedbackReportClaims(claims);

  const maxBytes = getConfiguredFeedbackReportMaxBytes(env);
  const bundleSha256 = readSha256(body.bundleSha256, "bundleSha256");
  const bundleSizeBytes = readInteger(body.bundleSizeBytes, "bundleSizeBytes", maxBytes);
  const contentType = readOptionalString(body.bundleContentType, "bundleContentType", 128) ?? "application/octet-stream";
  const filename = sanitizeObjectPathSegment(
    readOptionalString(body.bundleFilename, "bundleFilename", 256) ?? "feedback-bundle.bin",
  );
  const source = readOptionalString(body.source, "source", 64) ?? "unknown";
  const agentId = readOptionalString(body.agentId, "agentId", 128) ?? undefined;
  const subjectId = claims.actorType === "machine" ? claims.machineId ?? claims.sub : claims.sub;
  await enforceFeedbackReportRateLimit(env, {
    serverId: claims.serverId,
    actorType: claims.actorType === "machine" ? "machine" : "user",
    subjectId,
  });

  const reportId = crypto.randomUUID();
  const artifactId = crypto.randomUUID();
  const objectKey = `feedback-reports/${claims.serverId}/${reportId}/${artifactId}/${filename}`;

  const uploadSession: FeedbackReportUploadSessionClaims = {
    v: 1,
    typ: "feedback-report-upload-session",
    reportId,
    artifactId,
    objectKey,
    bundleSha256,
    bundleSizeBytes,
    maxBytes,
    contentType,
    serverId: claims.serverId,
    actorType: claims.actorType === "machine" ? "machine" : "user",
    subjectId,
    ...(claims.machineId ? { machineId: claims.machineId } : {}),
    ...(agentId ? { agentId } : {}),
    source,
    ...readWindowCoverageClaims(body.metadata),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const completeSession: FeedbackReportCompleteSessionClaims = {
    v: 1,
    typ: "feedback-report-complete-session",
    reportId,
    artifactId,
    objectKey,
    serverId: claims.serverId,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const uploadToken = await signToken(uploadSession, getUploadSessionSecret(env));
  const completeToken = await signToken(completeSession, getUploadSessionSecret(env));
  const uploadUrl = new URL(`/api/feedback-reports/${encodeURIComponent(reportId)}/object`, request.url);
  uploadUrl.searchParams.set("token", uploadToken);

  await writeFeedbackReportLedger(env, uploadSession, {
    status: "pending",
    metadata: readOptionalJsonObject(body.metadata, "metadata") ?? undefined,
    title: readOptionalString(body.title, "title", 256) ?? undefined,
    descriptionPresent: typeof body.description === "string" && body.description.trim().length > 0,
  });

  return jsonResponse({
    id: reportId,
    artifactId,
    upload: {
      method: "PUT",
      url: uploadUrl.toString(),
      headers: {
        "Content-Type": contentType,
      },
    },
    completeToken,
    expiresAt: new Date(Math.min(uploadSession.exp, completeSession.exp) * 1000).toISOString(),
  }, 200, feedbackReportCorsHeaders(env, request));
}

export async function putFeedbackReportObject(
  request: Request,
  env: TraceUploadWorkerEnv,
  reportId: string,
): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) throw new HttpError(401, "Missing upload token");
  const claims = await verifyToken<FeedbackReportUploadSessionClaims>(token, getUploadSessionSecret(env));
  if (claims.typ !== "feedback-report-upload-session" || claims.reportId !== reportId) {
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

  const result = await env.TRACE_BUNDLES.put(claims.objectKey, body, {
    httpMetadata: {
      contentType: claims.contentType,
    },
    customMetadata: {
      reportId: claims.reportId,
      artifactId: claims.artifactId,
      bundleSha256: claims.bundleSha256,
      bundleSizeBytes: String(claims.bundleSizeBytes),
      serverId: claims.serverId,
      actorType: claims.actorType,
      subjectId: claims.subjectId,
      source: claims.source,
      ...(claims.machineId ? { machineId: claims.machineId } : {}),
      ...(claims.agentId ? { agentId: claims.agentId } : {}),
      ...(claims.transcriptCoverage ? { transcriptCoverage: claims.transcriptCoverage } : {}),
      ...(claims.transcriptFirstEventAt ? { transcriptFirstEventAt: claims.transcriptFirstEventAt } : {}),
      ...(claims.transcriptLastEventAt ? { transcriptLastEventAt: claims.transcriptLastEventAt } : {}),
      ...(claims.transcriptTruncated ? { transcriptTruncated: claims.transcriptTruncated } : {}),
      ...(claims.transcriptTruncationDirection
        ? { transcriptTruncationDirection: claims.transcriptTruncationDirection }
        : {}),
      ...(claims.transcriptAnchorSource ? { transcriptAnchorSource: claims.transcriptAnchorSource } : {}),
    },
  });
  await writeFeedbackReportLedger(env, claims, { status: "uploaded" });

  return new Response(null, {
    status: 200,
    headers: {
      ...feedbackReportCorsHeaders(env, request),
      ...(result?.etag ? { etag: result.etag } : {}),
    },
  });
}

export async function completeFeedbackReport(
  request: Request,
  env: TraceUploadWorkerEnv,
  reportId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  const completeToken = readString(body.completeToken, "completeToken", 16 * 1024);
  const claims = await verifyToken<FeedbackReportCompleteSessionClaims>(completeToken, getUploadSessionSecret(env));
  if (claims.typ !== "feedback-report-complete-session" || claims.reportId !== reportId) {
    throw new HttpError(401, "Invalid complete token");
  }
  if (!env.TRACE_BUNDLES.get) throw new HttpError(409, "Feedback report upload has not completed");
  const uploadedLedger = await env.TRACE_BUNDLES.get(feedbackReportLedgerKey({
    serverId: claims.serverId,
    reportId: claims.reportId,
    artifactId: claims.artifactId,
  }));
  if (!uploadedLedger?.body) throw new HttpError(409, "Feedback report upload has not completed");
  const text = await new Response(uploadedLedger.body).text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(409, "Feedback report upload has not completed");
  }
  if (!isJsonObject(parsed)
    || parsed.status !== "uploaded"
    || parsed.object_key !== claims.objectKey
    || parsed.report_id !== claims.reportId
    || parsed.artifact_id !== claims.artifactId) {
    throw new HttpError(409, "Feedback report upload has not completed");
  }
  await writeFeedbackReportCompleteLedger(env, claims);

  return jsonResponse(
    { ok: true, id: claims.reportId, artifactId: claims.artifactId },
    200,
    feedbackReportCorsHeaders(env, request),
  );
}

function validateFeedbackReportClaims(claims: ScopeAttestationClaims): void {
  if (claims.typ !== "scope-attestation") throw new HttpError(401, "Invalid attestation type");
  if (claims.scope !== FEEDBACK_REPORT_SCOPE) throw new HttpError(403, "Invalid attestation scope");
  if (claims.aud !== FEEDBACK_REPORT_AUDIENCE) throw new HttpError(403, "Invalid attestation audience");
  if (!claims.serverId) throw new HttpError(403, "Missing feedback report identity");

  if (claims.actorType === "machine") {
    if (!claims.machineId) throw new HttpError(403, "Missing feedback report machine identity");
    const expectedResource = `servers/${claims.serverId}/machines/${claims.machineId}/feedback-reports`;
    if (claims.resource !== expectedResource) throw new HttpError(403, "Invalid attestation resource");
    return;
  }

  if (claims.actorType !== "user") throw new HttpError(403, "Invalid attestation actor");
  const expectedResource = `servers/${claims.serverId}/feedback-reports`;
  if (claims.resource !== expectedResource) throw new HttpError(403, "Invalid attestation resource");
}

async function writeFeedbackReportLedger(
  env: TraceUploadWorkerEnv,
  metadata: FeedbackReportUploadSessionClaims,
  status: {
    status: "pending" | "uploaded";
    metadata?: JsonObject;
    title?: string;
    descriptionPresent?: boolean;
  },
): Promise<void> {
  const record = {
    type: "feedback_report_artifact",
    schema_version: 1,
    updated_at: new Date().toISOString(),
    report_id: metadata.reportId,
    artifact_id: metadata.artifactId,
    object_key: metadata.objectKey,
    ledger_key: feedbackReportLedgerKey(metadata),
    bundle_sha256: metadata.bundleSha256,
    bundle_size_bytes: metadata.bundleSizeBytes,
    server_id: metadata.serverId,
    actor_type: metadata.actorType,
    subject_id: metadata.subjectId,
    source: metadata.source,
    ...(metadata.machineId ? { machine_id: metadata.machineId } : {}),
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
    ...status,
  };
  await env.TRACE_BUNDLES.put(feedbackReportLedgerKey(metadata), JSON.stringify(record, null, 2), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      reportId: metadata.reportId,
      artifactId: metadata.artifactId,
      bundleSha256: metadata.bundleSha256,
      serverId: metadata.serverId,
      ledgerType: "feedback-report-artifact",
    },
  });
}

async function writeFeedbackReportCompleteLedger(
  env: TraceUploadWorkerEnv,
  metadata: FeedbackReportCompleteSessionClaims,
): Promise<void> {
  const record = {
    type: "feedback_report_complete",
    schema_version: 1,
    updated_at: new Date().toISOString(),
    report_id: metadata.reportId,
    artifact_id: metadata.artifactId,
    object_key: metadata.objectKey,
    server_id: metadata.serverId,
  };
  await env.TRACE_BUNDLES.put(feedbackReportCompleteLedgerKey(metadata), JSON.stringify(record, null, 2), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      reportId: metadata.reportId,
      artifactId: metadata.artifactId,
      serverId: metadata.serverId,
      ledgerType: "feedback-report-complete",
    },
  });
}

export function isFeedbackReportPath(pathname: string): boolean {
  return pathname === "/api/feedback-reports"
    || pathname === "/api/reports"
    || /^\/api\/(?:feedback-reports|reports)\/[^/]+\/(?:object|complete)$/.test(pathname);
}

async function enforceFeedbackReportRateLimit(
  env: TraceUploadWorkerEnv,
  input: { serverId: string; actorType: "user" | "machine"; subjectId: string },
): Promise<void> {
  const limit = getConfiguredFeedbackReportHourlyLimit(env);
  if (limit <= 0 || !env.TRACE_BUNDLES.get) return;

  const key = feedbackReportRateLimitKey(input, new Date());
  const existing = await env.TRACE_BUNDLES.get(key);
  let count = 0;
  if (existing?.body) {
    const text = await new Response(existing.body).text().catch(() => "");
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.count === "number" && Number.isFinite(parsed.count) && parsed.count > 0) {
        count = Math.floor(parsed.count);
      }
    } catch {
      count = 0;
    }
  }

  if (count >= limit) {
    throw new HttpError(429, "Feedback report rate limit exceeded");
  }

  await env.TRACE_BUNDLES.put(key, JSON.stringify({
    type: "feedback_report_rate_limit",
    schema_version: 1,
    updated_at: new Date().toISOString(),
    server_id: input.serverId,
    actor_type: input.actorType,
    subject_id: input.subjectId,
    count: count + 1,
    limit,
  }, null, 2), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      ledgerType: "feedback-report-rate-limit",
      serverId: input.serverId,
      actorType: input.actorType,
      subjectId: input.subjectId,
    },
  });
}

function feedbackReportRateLimitKey(
  input: { serverId: string; actorType: "user" | "machine"; subjectId: string },
  date: Date,
): string {
  const hour = date.toISOString().slice(0, 13).replace(/[-:]/g, "");
  return [
    "feedback-report-rate-limits",
    sanitizeObjectPathSegment(input.serverId),
    input.actorType,
    sanitizeObjectPathSegment(input.subjectId),
    `${hour}.json`,
  ].join("/");
}

function getConfiguredFeedbackReportMaxBytes(env: TraceUploadWorkerEnv): number {
  if (!env.FEEDBACK_REPORT_MAX_BYTES) return FEEDBACK_REPORT_MAX_BYTES;
  const parsed = Number(env.FEEDBACK_REPORT_MAX_BYTES);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : FEEDBACK_REPORT_MAX_BYTES;
}

function getConfiguredFeedbackReportHourlyLimit(env: TraceUploadWorkerEnv): number {
  if (!env.FEEDBACK_REPORT_HOURLY_LIMIT) return FEEDBACK_REPORT_HOURLY_LIMIT;
  const parsed = Number(env.FEEDBACK_REPORT_HOURLY_LIMIT);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : FEEDBACK_REPORT_HOURLY_LIMIT;
}

export function feedbackReportCorsResponse(env: TraceUploadWorkerEnv, request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: feedbackReportCorsHeaders(env, request),
  });
}

export function feedbackReportCorsHeaders(env: TraceUploadWorkerEnv, request: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": resolveWebCorsOrigin(env, request),
    "Access-Control-Allow-Methods": FEEDBACK_REPORT_CORS_METHODS,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Server-Id",
    "Access-Control-Max-Age": "86400",
    ...webCorsVaryHeader(env),
  };
}
