// Route-scoped request limits for POST /internal/machine/scope-attestation.
//
// Daemons <= a8039c677 put the feedback diagnostics inside trace-bundle
// attestation metadata (~180 KB on a busy machine). The global 100 KB JSON
// parser answered them with an HTML 413 before the route ran, and the
// transcript upload never happened. This ONE route parses up to 1 MiB, after
// machine auth, so unauthenticated callers never get a large body parsed. Every other route keeps its own limit. The server
// strips those fields before signing (see deriveDaemonTraceBundleMetadata).
import type { ErrorRequestHandler } from "express";

export const SCOPE_ATTESTATION_PATH = "/internal/machine/scope-attestation";
export const SCOPE_ATTESTATION_REQUEST_MAX_BYTES = 1024 * 1024;
/** A JSON 413 (not Express's HTML page) so the daemon can classify it. */
export const scopeAttestationBodyErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if ((err as { type?: unknown } | null)?.type === "entity.too.large") {
    res.status(413).json({
      error: `Scope attestation request body exceeds ${SCOPE_ATTESTATION_REQUEST_MAX_BYTES} bytes`,
      code: "scope_attestation_body_too_large",
      limitBytes: SCOPE_ATTESTATION_REQUEST_MAX_BYTES,
    });
    return;
  }
  next(err);
};
