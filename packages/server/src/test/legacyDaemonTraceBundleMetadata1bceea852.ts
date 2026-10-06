// FROZEN COPY — test fixture only. This is the daemon trace-bundle metadata
// signer of packages/server/src/routes/internal.ts (deriveDaemonTraceBundleMetadata
// and the helpers it calls) exactly as it was on staging 1bceea852: it knows
// machine_evidence but NOT transcript_outcome, and drops the transcript content
// label / byte counts / request id (they are not in its key set). Rewrites:
// exported under a versioned name; `isFeedbackAttachmentKind` is the closed
// kind list as it was on 1bceea852 (the shared list now includes
// transcript_outcome); `safeAddTraceEvent` is a no-op. The machine_evidence
// agent binding (a DB check in the route) is not modelled. It stands in for an
// OLD deployed server's signer in cross-version tests (new daemon -> old
// server). Do not "fix" or update it.
import { randomUUID } from "node:crypto";
import {
  FEEDBACK_MACHINE_EVIDENCE_MAX_UPLOAD_BYTES,
  FEEDBACK_MACHINE_EVIDENCE_SECTIONS,
  FEEDBACK_TRACE_BUNDLE_TRANSCRIPT_METADATA_KEYS,
  type FeedbackTraceBundleTranscriptMetadataKey,
} from "@botiverse/raft-shared";

const TRACE_BUNDLE_MAX_BYTES = 50 * 1024 * 1024;
const FEEDBACK_ATTACHMENT_KINDS_1BCEEA852 = ["session_transcript", "machine_log_tail", "machine_evidence"] as const;
function isFeedbackAttachmentKind(value: unknown): value is (typeof FEEDBACK_ATTACHMENT_KINDS_1BCEEA852)[number] {
  return typeof value === "string" && (FEEDBACK_ATTACHMENT_KINDS_1BCEEA852 as readonly string[]).includes(value);
}
function safeAddTraceEvent(_name: string, _attrs: () => Record<string, unknown>): void {}

const ALLOWED_PRODUCER_DEPLOYMENT_ENVIRONMENTS = new Set([
  "production",
  "staging",
  "dev",
  "test",
  "slockdev",
]);

function resolveServerDeploymentEnvironment(): string {
  return process.env.DEPLOYMENT_ENV || process.env.NODE_ENV || "unknown";
}

function selectDaemonTraceBundleDeploymentEnvironment(
  claimedEnvironment: string | undefined,
  serverEnvironment: string,
): string {
  if (claimedEnvironment === undefined) return serverEnvironment;
  if (!ALLOWED_PRODUCER_DEPLOYMENT_ENVIRONMENTS.has(claimedEnvironment)) {
    throw new Error(`metadata.deploymentEnvironment "${claimedEnvironment}" is not in the allowed producer set`);
  }
  if (claimedEnvironment === serverEnvironment) return claimedEnvironment;
  if (claimedEnvironment === "dev" && serverEnvironment !== "production") return "dev";
  throw new Error(`metadata.deploymentEnvironment "${claimedEnvironment}" is inconsistent with server deployment "${serverEnvironment}"`);
}

export function legacyDeriveDaemonTraceBundleMetadata1bceea852(
  ctx: { serverId: string; machineId: string },
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const bundleId = readAttestationString(metadata.bundleId, "metadata.bundleId", 128);
  const bundleSha256 = readAttestationSha256(metadata.bundleSha256, "metadata.bundleSha256");
  const bundleSizeBytes = readAttestationInteger(metadata.bundleSizeBytes, "metadata.bundleSizeBytes", TRACE_BUNDLE_MAX_BYTES);
  const uploadId = randomUUID();
  // Every daemon-supplied string that is signed is bounded to what the worker
  // accepts, so the server never mints a claim the worker would refuse.
  const bundleContentType = readOptionalBoundedAttestationString(metadata.bundleContentType, "metadata.bundleContentType", 128)
    ?? "application/x-ndjson";
  const bundleContentEncoding = readOptionalBoundedAttestationString(metadata.bundleContentEncoding, "metadata.bundleContentEncoding", 64)
    ?? "gzip";
  const claimedDeploymentEnvironment = typeof metadata.deploymentEnvironment === "string"
    && metadata.deploymentEnvironment.length > 0
    ? metadata.deploymentEnvironment
    : undefined;
  const deploymentEnvironment = selectDaemonTraceBundleDeploymentEnvironment(
    claimedDeploymentEnvironment,
    resolveServerDeploymentEnvironment(),
  );
  const result: Record<string, unknown> = {
    uploadId,
    objectKey: `trace-bundles/${ctx.serverId}/${ctx.machineId}/${uploadId}.jsonl.gz`,
    bundleId,
    bundleSha256,
    bundleSizeBytes,
    maxBytes: TRACE_BUNDLE_MAX_BYTES,
    bundleContentType,
    bundleContentEncoding,
    deploymentEnvironment,
  };
  const feedbackReportId = readOptionalBoundedAttestationString(metadata.feedbackReportId, "metadata.feedbackReportId", 128);
  if (feedbackReportId) result.feedbackReportId = feedbackReportId;
  const agentId = readOptionalBoundedAttestationString(metadata.agentId, "metadata.agentId", 128);
  if (agentId) result.agentId = agentId;
  const feedbackReportGeneratedAt = readOptionalAttestationTimestamp(
    metadata.feedbackReportGeneratedAt,
    "metadata.feedbackReportGeneratedAt",
  );
  if (feedbackReportGeneratedAt) result.feedbackReportGeneratedAt = feedbackReportGeneratedAt;
  const feedbackReportWindowStartAt = readOptionalAttestationTimestamp(
    metadata.feedbackReportWindowStartAt,
    "metadata.feedbackReportWindowStartAt",
  );
  if (feedbackReportWindowStartAt) result.feedbackReportWindowStartAt = feedbackReportWindowStartAt;
  const feedbackTranscriptFirstEventAt = readOptionalAttestationTimestamp(
    metadata.feedbackTranscriptFirstEventAt,
    "metadata.feedbackTranscriptFirstEventAt",
  );
  if (feedbackTranscriptFirstEventAt) result.feedbackTranscriptFirstEventAt = feedbackTranscriptFirstEventAt;
  const feedbackTranscriptLastEventAt = readOptionalAttestationTimestamp(
    metadata.feedbackTranscriptLastEventAt,
    "metadata.feedbackTranscriptLastEventAt",
  );
  if (feedbackTranscriptLastEventAt) result.feedbackTranscriptLastEventAt = feedbackTranscriptLastEventAt;
  const transcriptHandlers = {
    feedbackReportTimeSource(value: unknown): void {
      if (value === "web_report_bundle" || value === "server_request_received") {
        result.feedbackReportTimeSource = value;
      }
    },
    feedbackTranscriptFirstEventAt(): void {
      if (feedbackTranscriptFirstEventAt) result.feedbackTranscriptFirstEventAt = feedbackTranscriptFirstEventAt;
    },
    feedbackTranscriptLastEventAt(): void {
      if (feedbackTranscriptLastEventAt) result.feedbackTranscriptLastEventAt = feedbackTranscriptLastEventAt;
    },
    feedbackTranscriptTruncated(value: unknown): void {
      if (value === "true" || value === "false") {
        result.feedbackTranscriptTruncated = value;
      }
    },
    feedbackTranscriptTruncationDirection(value: unknown): void {
      if (value === "head" || value === "tail" || value === "window") {
        result.feedbackTranscriptTruncationDirection = value;
      }
    },
    feedbackTranscriptWindowCoverage(value: unknown): void {
      if (
        value === "covered"
        || value === "outside_report_window"
        || value === "timestamps_unavailable"
        || value === "report_time_invalid"
      ) {
        result.feedbackTranscriptWindowCoverage = value;
      }
    },
  } satisfies Record<FeedbackTraceBundleTranscriptMetadataKey, (value: unknown) => void>;
  for (const key of Object.keys(FEEDBACK_TRACE_BUNDLE_TRANSCRIPT_METADATA_KEYS) as FeedbackTraceBundleTranscriptMetadataKey[]) {
    transcriptHandlers[key](metadata[key]);
  }
  if (
    typeof metadata.feedbackTranscriptWindowToleranceMs === "number"
    && Number.isSafeInteger(metadata.feedbackTranscriptWindowToleranceMs)
    && metadata.feedbackTranscriptWindowToleranceMs >= 0
    && metadata.feedbackTranscriptWindowToleranceMs <= 60 * 60 * 1000
  ) {
    result.feedbackTranscriptWindowToleranceMs = metadata.feedbackTranscriptWindowToleranceMs;
  }
  // Feedback diagnostics (tier-1 observed-failure summary, task #279 trace
  // tail + machine state) are NEVER signed. They travel as their own
  // machine_evidence object; anything optional in this token competes with
  // the transcript for the worker's SCOPE_ATTESTATION_MAX_CHARS budget, and a
  // busy trace window used to make the TRANSCRIPT fail. Daemons <= a8039c677
  // still send them here: strip, warn, and record it. Nothing is lost — the
  // worker never read these claims.
  const unsignedDiagnostics = FEEDBACK_MACHINE_EVIDENCE_SECTIONS.filter((key) => metadata[key] !== undefined).sort();
  if (unsignedDiagnostics.length > 0) {
    console.warn(
      `[trace-bundle] stripping unsigned feedback diagnostics from machine ${ctx.machineId}: ${unsignedDiagnostics.join(",")} (older daemon; diagnostics now travel as machine_evidence)`,
    );
    safeAddTraceEvent("machine.trace_bundle.evidence_unsigned", () => ({
      event_kind: "legacy_diagnostics_stripped",
      outcome: "dropped",
      reason: "diagnostics_not_signed",
      machine_id: ctx.machineId,
      fields: unsignedDiagnostics.join(","),
    }));
  }
  // Tier 2 (task #272): the machine log tail is a distinct attachment KIND on
  // the same bundle path. The kind is a closed enum so a reader can tell a
  // transcript from a log tail without sniffing content; the tail's counters
  // are bounded and dropped-with-warn when malformed rather than failing the
  // upload.
  if (metadata.feedbackAttachmentKind !== undefined) {
    if (isFeedbackAttachmentKind(metadata.feedbackAttachmentKind)) {
      result.feedbackAttachmentKind = metadata.feedbackAttachmentKind;
    } else {
      console.warn(`[trace-bundle] dropping unknown feedbackAttachmentKind from machine ${ctx.machineId}`);
    }
  }
  // machine_evidence: one gzipped JSON object, bound to a report and an agent,
  // filed outside trace-bundles/ so nothing that scans trace bundles reads it
  // as traces. Its content type, encoding, key and size bound are the
  // server's, not the daemon's. The agent binding to THIS machine is checked
  // in the route (it needs the database).
  if (result.feedbackAttachmentKind === "machine_evidence") {
    if (!result.feedbackReportId) throw new Error("metadata.feedbackReportId is required for machine_evidence");
    if (!result.agentId) throw new Error("metadata.agentId is required for machine_evidence");
    if (bundleSizeBytes > FEEDBACK_MACHINE_EVIDENCE_MAX_UPLOAD_BYTES) {
      throw new Error("metadata.bundleSizeBytes exceeds the machine_evidence limit");
    }
    result.objectKey = `feedback-machine-evidence/${ctx.serverId}/${ctx.machineId}/${uploadId}.json.gz`;
    result.maxBytes = FEEDBACK_MACHINE_EVIDENCE_MAX_UPLOAD_BYTES;
    result.bundleContentType = "application/json";
    result.bundleContentEncoding = "gzip";
  }
  if (result.feedbackAttachmentKind === "machine_log_tail") {
    for (const key of [
      "feedbackMachineLogTailLineCount",
      "feedbackMachineLogTailSourceLineCount",
      "feedbackMachineLogTailLinesOutsideWindow",
      "feedbackMachineLogTailUndatedLines",
    ] as const) {
      const value = metadata[key];
      if (value === undefined) continue;
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000) {
        result[key] = value;
      } else {
        console.warn(`[trace-bundle] dropping malformed ${key} from machine ${ctx.machineId}`);
      }
    }
    for (const key of ["feedbackMachineLogTailTruncated", "feedbackMachineLogTailIncludesOtherAgents"] as const) {
      const value = metadata[key];
      if (value === undefined) continue;
      if (value === "true" || value === "false") {
        result[key] = value;
      } else {
        console.warn(`[trace-bundle] dropping malformed ${key} from machine ${ctx.machineId}`);
      }
    }
  }
  return result;
}

function readOptionalBoundedAttestationString(value: unknown, name: string, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.length > maxLength) throw new Error(`${name} is too long`);
  return value;
}

function readOptionalAttestationTimestamp(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} is invalid`);
  return new Date(parsed).toISOString();
}

function readAttestationString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  if (value.length > maxLength) throw new Error(`${name} is too long`);
  return value;
}

function readAttestationSha256(value: unknown, name: string): string {
  const result = readAttestationString(value, name, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function readAttestationInteger(value: unknown, name: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${name} is invalid`);
  if (value > max) throw new Error(`${name} exceeds maxBytes`);
  return value;
}
