// Tier 2 of the feedback diagnostic upload (task #272): the machine's runner
// log tail, uploaded ONLY when the machine owner ticked the opt-in box for
// this one report. Tier 1 (the observed-failure summary) rides along by
// default and is a closed set of fields; this tier carries free text, which
// is why it is opt-in, owner-only, bounded, and redacted with the shared rule
// set before it leaves the machine.
//
// What this deliberately does NOT do:
//   - filter lines by agent. The runner log is machine-wide; every agent on
//     the machine writes into it. Filtering by substring would only fake
//     isolation, so the consent copy says other agents' lines are included
//     and the attestation says so too (`feedbackMachineLogTailIncludesOtherAgents`).
//   - guarantee coverage. The read is the LAST bytes of the file; the Computer
//     rotates the log at respawn, so the report window may not be in it at
//     all. Lines are then FILTERED to the report window by their leading
//     timestamp (continuation lines follow the previous dated line), and the
//     counts of lines read / outside the window / undated travel with the
//     upload so an empty or short tail is interpretable.
//   - keep URLs. Like the transcript path, whole URLs are dropped; a runner log
//     line's URL host/path is not something this surface has authorization to
//     keep.
import { createHash, randomUUID } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { redactDiagnosticText, type Tracer } from "@botiverse/raft-shared";
import { uploadWithSignedCapability } from "./directUploadCapability";
import { logger } from "./logger";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const FEEDBACK_MACHINE_LOG_TAIL_MAX_BYTES = 512 * 1024;
export const FEEDBACK_MACHINE_LOG_TAIL_MAX_LINES = 2000;
export const FEEDBACK_MACHINE_LOG_TAIL_MAX_LINE_CHARS = 2000;

export interface FeedbackMachineLogTailResult {
  /** False when no candidate log file could be read. */
  reachable: boolean;
  traceBundleId?: string;
  fallbackReason?: string;
  error?: string;
  /** Lines actually uploaded (after the line cap). */
  lineCount?: number;
  /** Lines present in the bytes read (before the line cap). */
  sourceLineCount?: number;
  /** True when the byte cap or the line cap dropped anything. */
  truncated?: boolean;
}

export interface FeedbackMachineLogTailSource {
  /** Candidate paths in preference order; the first regular file wins. */
  paths: readonly string[];
}

async function readTailBytes(filePath: string, maxBytes: number): Promise<{ text: string; truncatedByBytes: boolean } | null> {
  const info = await lstat(filePath).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isFile()) return null;
  const fd = await open(filePath, "r");
  try {
    const readStart = Math.max(0, info.size - maxBytes);
    const toRead = info.size - readStart;
    const buf = Buffer.alloc(toRead);
    let bytesRead = 0;
    while (bytesRead < toRead) {
      const result = await fd.read(buf, bytesRead, toRead - bytesRead, readStart + bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    let body = buf.subarray(0, bytesRead);
    // Drop the partial first line when the byte cap cut into the file.
    if (readStart > 0) {
      const newline = body.indexOf(0x0a);
      body = newline === -1 ? Buffer.alloc(0) : body.subarray(newline + 1);
    }
    return { text: body.toString("utf8"), truncatedByBytes: readStart > 0 };
  } finally {
    await fd.close();
  }
}

const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;
const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const LINE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\b/;

/**
 * Redact the WHOLE text before it is split into lines, so multi-line rules
 * (PEM private key blocks) can match. A bounded read or a line cap can cut
 * inside such a block, leaving an orphan END (head cut) or an orphan BEGIN
 * (tail cut); both halves are still key material, so they are masked too.
 */
export function redactLogTailText(text: string): string {
  let out = redactDiagnosticText(text, { urls: "drop" });
  const end = PEM_END.exec(out);
  if (end && !PEM_BEGIN.test(out.slice(0, end.index))) {
    out = `***REDACTED***${out.slice(end.index + end[0].length)}`;
  }
  const begin = PEM_BEGIN.exec(out);
  if (begin && !PEM_END.test(out.slice(begin.index))) {
    out = `${out.slice(0, begin.index)}***REDACTED***`;
  }
  return out;
}

export interface BoundedLogTail {
  lines: string[];
  /** Non-empty lines in the bytes read, before window filtering and the line cap. */
  sourceLineCount: number;
  /** Timestamped lines (plus their continuations) outside [from, to]. */
  linesOutsideWindow: number;
  /** Lines with no timestamp and no preceding timestamped line to inherit from. */
  undatedLines: number;
  truncatedByLines: boolean;
}

/**
 * Window semantics: a line with a leading ISO timestamp is in the tail only
 * when that instant lies within [from, to]. A line without a timestamp is a
 * continuation (stack trace, JSON dump) and inherits the previous dated
 * line's decision; one with nothing to inherit from is dropped and counted.
 * The whole text is redacted FIRST (see redactLogTailText), then filtered,
 * then capped by line count and line length.
 */
export function boundAndRedactLogTail(
  text: string,
  limits: { maxLines: number; maxLineChars: number },
  window?: { from: string; to: string },
): BoundedLogTail {
  const all = redactLogTailText(text).split(/\r?\n/).filter((line) => line.length > 0);
  const fromMs = window ? Date.parse(window.from) : Number.NaN;
  const toMs = window ? Date.parse(window.to) : Number.NaN;
  const filterByWindow = Number.isFinite(fromMs) && Number.isFinite(toMs);
  const inWindow: string[] = [];
  let linesOutsideWindow = 0;
  let undatedLines = 0;
  let inherited: boolean | null = null;
  for (const line of all) {
    if (!filterByWindow) {
      inWindow.push(line);
      continue;
    }
    const stamp = LINE_TIMESTAMP.exec(line);
    if (stamp) {
      const ms = Date.parse(stamp[1]!);
      inherited = Number.isFinite(ms) && ms >= fromMs && ms <= toMs;
    } else if (inherited === null) {
      undatedLines += 1;
      continue;
    }
    if (inherited) inWindow.push(line);
    else linesOutsideWindow += 1;
  }
  const kept = inWindow.slice(-limits.maxLines);
  const lines = kept.map((line) =>
    line.length > limits.maxLineChars ? `${line.slice(0, limits.maxLineChars)}...[truncated]` : line);
  return {
    lines,
    sourceLineCount: all.length,
    linesOutsideWindow,
    undatedLines,
    truncatedByLines: inWindow.length > kept.length,
  };
}

export async function collectFeedbackMachineLogTailAttachment(input: {
  agentId: string;
  feedbackReportId: string;
  /** The SAME window the transcript and tier-1 summary were assessed against. */
  window: { from: string; to: string };
  source: FeedbackMachineLogTailSource;
  serverUrl: string;
  daemonApiKey: string;
  workerUrl: string | null;
  tracer: Tracer;
  fetchImpl: FetchLike;
  limits?: { maxBytes?: number; maxLines?: number; maxLineChars?: number };
}): Promise<FeedbackMachineLogTailResult> {
  const maxBytes = input.limits?.maxBytes ?? FEEDBACK_MACHINE_LOG_TAIL_MAX_BYTES;
  const maxLines = input.limits?.maxLines ?? FEEDBACK_MACHINE_LOG_TAIL_MAX_LINES;
  const maxLineChars = input.limits?.maxLineChars ?? FEEDBACK_MACHINE_LOG_TAIL_MAX_LINE_CHARS;

  let read: { path: string; text: string; truncatedByBytes: boolean } | null = null;
  for (const candidate of input.source.paths) {
    try {
      const tail = await readTailBytes(candidate, maxBytes);
      if (tail) {
        read = { path: candidate, ...tail };
        break;
      }
    } catch (err) {
      logger.warn(`[FeedbackMachineLogTail] could not read ${candidate}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!read) return { reachable: false, fallbackReason: "no readable runner log" };
  if (!input.workerUrl) return { reachable: true, fallbackReason: "daemon worker URL is not configured" };

  const bounded = boundAndRedactLogTail(read.text, { maxLines, maxLineChars }, input.window);
  const truncated = read.truncatedByBytes || bounded.truncatedByLines;
  const span = input.tracer.startSpan("daemon.feedback_machine_log_tail.upload", {
    surface: "daemon",
    kind: "producer",
    attrs: {
      agentId: input.agentId,
      feedbackReportId: input.feedbackReportId,
      line_count: bounded.lines.length,
      source_line_count: bounded.sourceLineCount,
      truncated,
    },
  });
  try {
    const body = `${bounded.lines.join("\n")}\n`;
    const gzipped = gzipSync(Buffer.from(body, "utf8"));
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
        bundleContentType: "text/plain",
        bundleContentEncoding: "gzip",
        feedbackReportId: input.feedbackReportId,
        agentId: input.agentId,
        feedbackAttachmentKind: "machine_log_tail",
        feedbackReportWindowStartAt: input.window.from,
        feedbackReportGeneratedAt: input.window.to,
        feedbackMachineLogTailLineCount: bounded.lines.length,
        feedbackMachineLogTailSourceLineCount: bounded.sourceLineCount,
        feedbackMachineLogTailLinesOutsideWindow: bounded.linesOutsideWindow,
        feedbackMachineLogTailUndatedLines: bounded.undatedLines,
        feedbackMachineLogTailTruncated: truncated ? "true" : "false",
        feedbackMachineLogTailIncludesOtherAgents: "true",
      },
      uploadBody: new Blob([new Uint8Array(gzipped)], { type: "text/plain" }),
      fetchImpl: input.fetchImpl,
    });
    const traceBundleId = typeof uploadResult.session.id === "string" ? uploadResult.session.id : bundleId;
    logger.info(`[FeedbackMachineLogTail] uploaded for report=${input.feedbackReportId} agent=${input.agentId} traceBundleId=${traceBundleId} lines=${bounded.lines.length} size=${bundleSizeBytes}`);
    span.end("ok", { attrs: { traceBundleId, bundleSizeBytes } });
    return { reachable: true, traceBundleId, lineCount: bounded.lines.length, sourceLineCount: bounded.sourceLineCount, truncated };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[FeedbackMachineLogTail] upload failed for report=${input.feedbackReportId} agent=${input.agentId}: ${message}`);
    span.end("error", { attrs: { error_class: err instanceof Error ? err.name : "Error", error_message: message } });
    return { reachable: true, error: message, lineCount: bounded.lines.length, sourceLineCount: bounded.sourceLineCount, truncated };
  }
}
