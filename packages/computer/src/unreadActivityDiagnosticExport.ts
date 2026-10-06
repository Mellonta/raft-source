import { Buffer } from "node:buffer";

import {
  UNREAD_ACTIVITY_DIAGNOSTIC_CAPS,
  validateUnreadActivityDiagnostic,
  type ValidateUnreadActivityDiagnosticResult,
} from "@botiverse/raft-shared/unread-activity-diagnostic";

import type {
  UnreadActivityDiagnosticClient,
  UnreadActivityDiagnosticResult,
} from "./apiClient";
import { writeDurableTextFile } from "./durableFile";

export type UnreadActivityDiagnosticExportErrorCode =
  | "DIAGNOSTIC_SNAPSHOT_AUTH_REQUIRED"
  | "DIAGNOSTIC_SNAPSHOT_FORBIDDEN"
  | "DIAGNOSTIC_SNAPSHOT_SERVER_UNAVAILABLE"
  | "DIAGNOSTIC_SNAPSHOT_SCHEMA_MISMATCH"
  | "DIAGNOSTIC_SNAPSHOT_ROW_LIMIT_EXCEEDED"
  | "DIAGNOSTIC_SNAPSHOT_BYTE_LIMIT_EXCEEDED"
  | "DIAGNOSTIC_SNAPSHOT_WRITE_FAILED";

export class UnreadActivityDiagnosticExportError extends Error {
  constructor(
    readonly code: UnreadActivityDiagnosticExportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UnreadActivityDiagnosticExportError";
  }
}

export interface WriteValidatedUnreadActivityDiagnosticSnapshotOptions {
  outputPath: string;
  /** Canonical JSON returned by the one shared schema validator. */
  canonicalJson: string;
  viewCount: number;
  serverCount: number;
  maxViews: number;
  maxServers: number;
  maxBytes: number;
}

export interface UnreadActivityDiagnosticWriteReceipt {
  outputPath: string;
  bytes: number;
  views: number;
  servers: number;
}

export interface UnreadActivityDiagnosticWriterDeps {
  writeTextFile?: typeof writeDurableTextFile;
}

export interface ExportUnreadActivityDiagnosticSnapshotOptions {
  client: Pick<UnreadActivityDiagnosticClient, "get">;
  outputPath: string;
  serverId?: string;
}

export interface ExportUnreadActivityDiagnosticSnapshotDeps
  extends UnreadActivityDiagnosticWriterDeps {
  validate?: (payload: unknown) => ValidateUnreadActivityDiagnosticResult;
  writeValidated?: typeof writeValidatedUnreadActivityDiagnosticSnapshot;
}

function finiteNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertBoundedCount(value: number, limit: number): void {
  if (
    !finiteNonNegativeInteger(value)
    || !finiteNonNegativeInteger(limit)
    || value > limit
  ) {
    throw new UnreadActivityDiagnosticExportError(
      "DIAGNOSTIC_SNAPSHOT_ROW_LIMIT_EXCEEDED",
      `Unread/Activity diagnostic snapshot has an invalid or excessive row count (${String(value)} > ${String(limit)}).`,
    );
  }
}

function assertCanonicalObjectJson(canonicalJson: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalJson);
  } catch {
    throw new UnreadActivityDiagnosticExportError(
      "DIAGNOSTIC_SNAPSHOT_SCHEMA_MISMATCH",
      "Unread/Activity diagnostic validator returned invalid canonical JSON.",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UnreadActivityDiagnosticExportError(
      "DIAGNOSTIC_SNAPSHOT_SCHEMA_MISMATCH",
      "Unread/Activity diagnostic validator must return one canonical JSON object.",
    );
  }
}

/**
 * Persist one snapshot only after the shared Server/Web/Desktop/Computer
 * validator has checked the manifest, field classes, schema digest, caps, and
 * privacy rules. This writer deliberately owns no field allowlist and performs
 * no unread query or correlation-id derivation.
 *
 * The function has no HTTP, telemetry, attachment, or upload dependency:
 * saving one bounded local file is its only side effect.
 */
export async function writeValidatedUnreadActivityDiagnosticSnapshot(
  options: WriteValidatedUnreadActivityDiagnosticSnapshotOptions,
  deps: UnreadActivityDiagnosticWriterDeps = {},
): Promise<UnreadActivityDiagnosticWriteReceipt> {
  assertBoundedCount(options.viewCount, options.maxViews);
  assertBoundedCount(options.serverCount, options.maxServers);
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new UnreadActivityDiagnosticExportError(
      "DIAGNOSTIC_SNAPSHOT_SCHEMA_MISMATCH",
      "Unread/Activity diagnostic byte limit is invalid.",
    );
  }
  assertCanonicalObjectJson(options.canonicalJson);

  const bytes = Buffer.byteLength(options.canonicalJson, "utf8");
  if (bytes > options.maxBytes) {
    throw new UnreadActivityDiagnosticExportError(
      "DIAGNOSTIC_SNAPSHOT_BYTE_LIMIT_EXCEEDED",
      `Unread/Activity diagnostic snapshot is ${bytes} bytes; limit is ${options.maxBytes}.`,
    );
  }

  try {
    await (deps.writeTextFile ?? writeDurableTextFile)(options.outputPath, options.canonicalJson);
  } catch (cause) {
    throw new UnreadActivityDiagnosticExportError(
      "DIAGNOSTIC_SNAPSHOT_WRITE_FAILED",
      "Could not save the unread/Activity diagnostic snapshot.",
      { cause },
    );
  }
  return {
    outputPath: options.outputPath,
    bytes,
    views: options.viewCount,
    servers: options.serverCount,
  };
}

function throwTransportError(result: Exclude<UnreadActivityDiagnosticResult, { status: "success" }>): never {
  if (result.status === "auth_required") {
    throw new UnreadActivityDiagnosticExportError(
      "DIAGNOSTIC_SNAPSHOT_AUTH_REQUIRED",
      "Unread/Activity diagnostic export requires a current Raft login.",
    );
  }
  if (result.status === "forbidden") {
    throw new UnreadActivityDiagnosticExportError(
      "DIAGNOSTIC_SNAPSHOT_FORBIDDEN",
      "The selected server is not available to the current Raft login.",
    );
  }
  throw new UnreadActivityDiagnosticExportError(
    "DIAGNOSTIC_SNAPSHOT_SERVER_UNAVAILABLE",
    `The server could not provide an unread/Activity diagnostic snapshot (${result.code}).`,
  );
}

/**
 * Fetch, validate, and save one self-only diagnostic snapshot. The server
 * creates `diagnostic_correlation_id`; this consumer never generates,
 * derives, hashes, or rewrites it. The exact shared validator output is what
 * reaches disk.
 */
export async function exportUnreadActivityDiagnosticSnapshot(
  options: ExportUnreadActivityDiagnosticSnapshotOptions,
  deps: ExportUnreadActivityDiagnosticSnapshotDeps = {},
): Promise<UnreadActivityDiagnosticWriteReceipt> {
  const fetched = await options.client.get(options.serverId);
  if (fetched.status !== "success") throwTransportError(fetched);

  const validated = (deps.validate ?? validateUnreadActivityDiagnostic)(fetched.snapshot);
  if (!validated.ok) {
    throw new UnreadActivityDiagnosticExportError(
      "DIAGNOSTIC_SNAPSHOT_SCHEMA_MISMATCH",
      `The server returned an incompatible unread/Activity diagnostic snapshot (${validated.code}).`,
    );
  }

  return await (deps.writeValidated ?? writeValidatedUnreadActivityDiagnosticSnapshot)(
    {
      outputPath: options.outputPath,
      canonicalJson: validated.canonicalJson,
      viewCount: validated.document.views.length,
      serverCount: validated.document.totals.length,
      maxViews: UNREAD_ACTIVITY_DIAGNOSTIC_CAPS.maxRows,
      maxServers: UNREAD_ACTIVITY_DIAGNOSTIC_CAPS.maxServers,
      maxBytes: UNREAD_ACTIVITY_DIAGNOSTIC_CAPS.maxCanonicalBytes,
    },
    deps.writeTextFile ? { writeTextFile: deps.writeTextFile } : {},
  );
}
