// Shared best-effort redaction for diagnostic text that leaves a machine:
// runtime session transcripts (daemon), runner log tails (daemon feedback tier
// 2, Computer diagnostics push). One rule set, consumed by every producer, so
// a gap found on one surface is closed on all of them at once (task #272; the
// daemon transcript path previously had its own four-rule list that let a bare
// JWT through).
//
// This is a SCRUBBER, not a guarantee. It masks the credential shapes we know
// about; callers must still gate any new upload surface on the machine owner's
// explicit opt-in and say so in the consent copy.

export interface DiagnosticRedactionOptions {
  /**
   * `query` (default) keeps the URL origin/path and masks query, user and
   * password — enough to debug routing. `drop` replaces the whole URL with
   * `[url]`, which the transcript path has always done.
   */
  urls?: "query" | "drop";
}

const MASK = "***REDACTED***";

// Order matters only where a later rule could match the replacement text;
// none of these match `***REDACTED***` or `[url]`.
const SECRET_PATTERNS: readonly RegExp[] = [
  // PEM private key blocks (multi-line), before any single-line rule could eat
  // a fragment of them.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Orphan PEM markers, fail-closed (XX, task #263). A complete block is masked
  // by the rule above, so anything still carrying a marker is unpaired: the file
  // was mid-write when it was read, or rotation/truncation cut the block. Either
  // way the base64 body is live key material and must not survive.
  // BEGIN with no END: mask to the end of the text.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g,
  // END with no BEGIN: mask from the start of the text to that marker.
  /^[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Raft-issued keys.
  /sk_[a-z]+_[A-Za-z0-9._-]+/g,
  /sap_[A-Za-z0-9_-]+/g,
  // Bearer tokens and any Authorization header value, with or without a scheme.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bAuthorization\s*[:=]\s*["']?[^\s"',;]+/gi,
  // Common vendor key shapes.
  /\b(?:sk|sk-ant|sk-proj|xox[baprs]?)-[A-Za-z0-9_-]{8,}\b/g,
  // GitHub tokens (classic ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_).
  /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // AWS access key ids and any *secret*/*token*/*password*/*key* assignment,
  // including snake_case names such as aws_secret_access_key.
  // IAM AccessKeyId: the public API contract allows 16–128 chars; issued ids
  // are usually 20 today, but the rule must not encode "usually". Covers the
  // documented unique-id prefixes for access keys and STS temporary keys.
  /\b(?:AKIA|ASIA)[0-9A-Z]{12,124}\b/g,
  // Google API keys: documented shape is "AIza" + 35 URL-safe chars (39 total).
  // Trailing lookahead instead of \b: the last char may be `-` or `_`, and a
  // `-` before a space is not a word boundary (XX, #7792 review).
  /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
  // xAI API keys: "xai-" prefix; exact length is not published, so this is a
  // lower bound on the shape (Kabi, #263 R6: shape unverified against a spec).
  /\bxai-[A-Za-z0-9]{20,}\b/g,
  // Bare JWT / JWS (base64url header, no Bearer prefix).
  /\beyJ[A-Za-z0-9._-]{20,}/g,
  // key=value style secrets in logs and config echoes.
  // Quotes may be JSON-escaped (`\"`) when the text is itself embedded in a
  // JSON transcript record, so the quote run tolerates backslashes.
  /\b[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password|passwd)[A-Za-z0-9_.-]*[\\"']*\s*[:=]\s*[\\"']*[^\s"',;\\]{4,}/gi,
  // Long hex blobs (hashes, raw keys).
  /\b[A-Fa-f0-9]{40,}\b/g,
];

// Applied after the secret rules so a masked value inside a path stays masked.
const IDENTITY_PATTERNS: readonly RegExp[] = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\/Users\/[^\s"'<>:]+(?:\/[^\s"'<>:]+)*/g,
  /\/home\/[^\s"'<>:]+(?:\/[^\s"'<>:]+)*/g,
  /[A-Za-z]:\\Users\\[^\s"'<>:]+(?:\\[^\s"'<>:]+)*/g,
];

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.search) url.search = "?[REDACTED_QUERY]";
    if (url.username) url.username = "[REDACTED_USER]";
    if (url.password) url.password = "[REDACTED_PASSWORD]";
    return url.toString();
  } catch {
    return value.replace(/\?.*$/, "?[REDACTED_QUERY]");
  }
}

export function redactDiagnosticText(text: string, options: DiagnosticRedactionOptions = {}): string {
  const urls = options.urls ?? "query";
  let out = text.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => (urls === "drop" ? "[url]" : redactUrl(url)));
  for (const re of SECRET_PATTERNS) out = out.replace(re, MASK);
  for (const re of IDENTITY_PATTERNS) out = out.replace(re, MASK);
  return out;
}
