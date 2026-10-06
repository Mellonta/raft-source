import { isUuid } from "../shared/http";

// R2 layout of the feedback report index: everything one report produced is
// listed under feedback-report-ledgers/<serverId>/<reportId>/ (lens reads it).
// The report id is a path segment, so a key is only ever built from a UUID.

function reportSegment(reportId: string): string {
  if (!isUuid(reportId)) throw new Error("feedback report id must be a UUID");
  return reportId;
}

export function feedbackReportTraceLedgerKey(metadata: { serverId: string; feedbackReportId: string; uploadId: string }): string {
  return `feedback-report-ledgers/${metadata.serverId}/${reportSegment(metadata.feedbackReportId)}/trace-${metadata.uploadId}.json`;
}

export function feedbackReportLedgerKey(metadata: { serverId: string; reportId: string; artifactId: string }): string {
  return `feedback-report-ledgers/${metadata.serverId}/${reportSegment(metadata.reportId)}/${metadata.artifactId}.json`;
}

export function feedbackReportCompleteLedgerKey(metadata: { serverId: string; reportId: string; artifactId: string }): string {
  return `feedback-report-ledgers/${metadata.serverId}/${reportSegment(metadata.reportId)}/${metadata.artifactId}.complete.json`;
}
