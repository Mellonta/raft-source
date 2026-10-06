import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, Request, Response } from "express";
import { normalizeObservedRoutePattern } from "../middleware/requestObservability";
import { addTraceEvent, errorClassOf, getCurrentTraceContext } from "../tracing/semanticTrace";
import { sanitizeRouteErrorMessage } from "../tracing/routeFailure";
import { DmTargetResolutionError } from "../services/dmTargetResolutionError";

interface JsonServerErrorOptions {
  error: string;
  code?: string;
  status?: number;
  logPrefix: string;
  err: unknown;
}

/**
 * Answer a DM target the caller can fix (ambiguous same-name peer, unknown
 * peer kind) with its 4xx status, stable code and suggestedNextAction. For
 * routes whose catch does not end in sendJsonServerError.
 */
export function respondToDmTargetResolutionError(err: unknown, res: Response): boolean {
  if (!(err instanceof DmTargetResolutionError)) return false;
  res.status(err.status).json(err.toResponseBody());
  return true;
}

/**
 * Body for a send whose transaction lost a deadlock/serialization race on every
 * bounded retry. It rolled back, so resending (same idempotency key) is safe.
 */
export function transientSendConflictBody() {
  return {
    error: "The message was not sent because of a temporary database conflict. Retry the send.",
    code: "send_transient_conflict",
    retryable: true,
    suggestedNextAction: "retry the same send (reuse the idempotencyKey)",
  };
}

export function sendJsonServerError(
  req: Request,
  res: Response,
  options: JsonServerErrorOptions,
): void {
  // A route that wraps channel resolution in a generic catch must still tell
  // the caller how to fix an ambiguous or malformed DM target.
  if (respondToDmTargetResolutionError(options.err, res)) return;
  const status = options.status ?? 500;
  const correlationId = getCurrentTraceContext()?.traceId ?? randomUUID();
  const errorClass = errorClassOf(options.err);
  const rawMessage = options.err instanceof Error ? options.err.message : String(options.err ?? "");
  const sanitizedMessage = sanitizeRouteErrorMessage(rawMessage);
  const route = normalizeObservedRoutePattern(req);

  console.error(options.logPrefix, {
    correlationId,
    method: req.method,
    route,
    status,
    errorClass,
    errorMessage: sanitizedMessage,
  });

  addTraceEvent("server.route.error_response", {
    event_kind: "route_error_response",
    outcome: "error",
    reason: "unexpected_server_error",
    http_status: status,
    correlation_id: correlationId,
    error_class: errorClass,
    error_message: sanitizedMessage,
    "http.route": route,
  });

  res.setHeader("X-Slock-Error-Id", correlationId);
  res.status(status).json({
    error: options.error,
    ...(options.code ? { code: options.code } : {}),
    correlationId,
  });
}

export const globalJsonServerErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  // A DM target the caller can fix (ambiguous same-name peer, unknown peer
  // kind): answer with its 4xx status and machine-readable code.
  if (respondToDmTargetResolutionError(err, res)) return;

  const candidateStatus = Number((err as { status?: unknown; statusCode?: unknown } | null)?.status
    ?? (err as { statusCode?: unknown } | null)?.statusCode);
  if (Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus < 500) {
    next(err);
    return;
  }

  const status = Number.isInteger(candidateStatus) && candidateStatus >= 500 && candidateStatus < 600
    ? candidateStatus
    : 500;

  sendJsonServerError(req, res, {
    error: "Internal server error",
    code: "internal_server_error",
    status,
    logPrefix: "[Server] Unhandled route error",
    err,
  });
};
