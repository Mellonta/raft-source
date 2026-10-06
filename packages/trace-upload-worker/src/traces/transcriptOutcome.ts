// transcript_outcome objects (task #1228 ①) are validated BEFORE they are
// stored: raw UTF-8 JSON under the shared 2 KiB cap, the strict shared parser,
// and report / agent / request identity equal to what the server signed. They
// are never trace JSONL and are never routed into OTLP ingest.
import { FEEDBACK_TRANSCRIPT_OUTCOME_MAX_BYTES, parseFeedbackTranscriptOutcome } from "@botiverse/raft-shared";
import { HttpError } from "../shared/http";
import { gunzipWithLimit } from "./machineEvidence";

export async function validateTranscriptOutcomeObject(
  body: ArrayBuffer,
  signed: { feedbackReportId?: string; agentId?: string; requestId?: string },
): Promise<void> {
  const raw = await gunzipWithLimit(body, FEEDBACK_TRANSCRIPT_OUTCOME_MAX_BYTES, "transcript outcome");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new HttpError(400, "transcript outcome is not valid UTF-8 JSON");
  }
  let envelope: ReturnType<typeof parseFeedbackTranscriptOutcome>;
  try {
    envelope = parseFeedbackTranscriptOutcome(parsed);
  } catch (err) {
    throw new HttpError(400, `transcript outcome rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (
    envelope.feedbackReportId !== signed.feedbackReportId
    || envelope.agentId !== signed.agentId
    || envelope.requestId !== signed.requestId
  ) {
    throw new HttpError(400, "transcript outcome report/agent/request does not match the attestation");
  }
}
