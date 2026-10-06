// HTTP entry: routes each request to the trace or feedback handlers. See README.md
// for what the service does; src/node.ts is the runtime entry point.
import type { ExecutionContextLike, TraceUploadWorkerEnv } from "./env";
import {
  completeFeedbackReport,
  createFeedbackReportUpload,
  feedbackReportCorsHeaders,
  feedbackReportCorsResponse,
  isFeedbackReportPath,
  putFeedbackReportObject,
} from "./feedback/reports";
import { HttpError, jsonResponse } from "./shared/http";
import { createTraceBundleUpload, putTraceBundleObject } from "./traces/bundles";
import { ingestWebTraceBatch, webTraceCorsHeaders, webTraceCorsResponse } from "./traces/web";

export async function handleRequest(request: Request, env: TraceUploadWorkerEnv, ctx?: ExecutionContextLike): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/healthz") {
      return jsonResponse({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/trace-bundles") {
      return await createTraceBundleUpload(request, env);
    }
    if (isFeedbackReportPath(url.pathname)) {
      if (request.method === "OPTIONS") {
        return feedbackReportCorsResponse(env, request);
      }
      if (request.method === "POST" && (url.pathname === "/api/feedback-reports" || url.pathname === "/api/reports")) {
        return await createFeedbackReportUpload(request, env);
      }
    }
    if (url.pathname === "/api/web-traces") {
      if (request.method === "OPTIONS") {
        return webTraceCorsResponse(env, request);
      }
      if (request.method === "POST") {
        return await ingestWebTraceBatch(request, env);
      }
    }
    const objectMatch = url.pathname.match(/^\/api\/trace-bundles\/([^/]+)\/object$/);
    if (request.method === "PUT" && objectMatch) {
      return await putTraceBundleObject(request, env, decodeURIComponent(objectMatch[1]), ctx);
    }
    const feedbackObjectMatch = url.pathname.match(/^\/api\/(?:feedback-reports|reports)\/([^/]+)\/object$/);
    if (request.method === "PUT" && feedbackObjectMatch) {
      return await putFeedbackReportObject(request, env, decodeURIComponent(feedbackObjectMatch[1]));
    }
    const feedbackCompleteMatch = url.pathname.match(/^\/api\/(?:feedback-reports|reports)\/([^/]+)\/complete$/);
    if (request.method === "POST" && feedbackCompleteMatch) {
      return await completeFeedbackReport(request, env, decodeURIComponent(feedbackCompleteMatch[1]));
    }
    return jsonResponse({ error: "Not found" }, 404);
  } catch (err) {
    const headers = url.pathname === "/api/web-traces"
      ? webTraceCorsHeaders(env, request)
      : isFeedbackReportPath(url.pathname)
        ? feedbackReportCorsHeaders(env, request)
        : {};
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.message }, err.status, headers);
    }
    return jsonResponse({ error: "Internal server error" }, 500, headers);
  }
}

export type { TraceUploadRuntimeEnv, TraceUploadWorkerEnv } from "./env";
export { ingestTraceBundleObject, isLocalTraceRecord } from "./traces/otlp";
