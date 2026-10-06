// machine_evidence objects (feedback diagnostics) are validated BEFORE they are
// stored: raw UTF-8 JSON size under the shared cap, strict shared parser, and
// identity equal to what the server signed. They are never trace JSONL and are
// never routed into OTLP ingest (see putTraceBundleObject).
import { FEEDBACK_MACHINE_EVIDENCE_MAX_BYTES, parseFeedbackMachineEvidence } from "@botiverse/raft-shared";
import { HttpError } from "../shared/http";

export async function gunzipWithLimit(body: ArrayBuffer, maxBytes: number, what = "machine evidence"): Promise<Uint8Array> {
  const reader = new Response(body).body!.pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch {
        throw new HttpError(400, `${what} is not valid gzip`);
      }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, `${what} exceeds ${maxBytes} raw bytes`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function validateMachineEvidenceObject(
  body: ArrayBuffer,
  signed: { feedbackReportId?: string; agentId?: string },
): Promise<void> {
  const raw = await gunzipWithLimit(body, FEEDBACK_MACHINE_EVIDENCE_MAX_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new HttpError(400, "machine evidence is not valid UTF-8 JSON");
  }
  let envelope: ReturnType<typeof parseFeedbackMachineEvidence>;
  try {
    envelope = parseFeedbackMachineEvidence(parsed);
  } catch (err) {
    throw new HttpError(400, `machine evidence rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (envelope.feedbackReportId !== signed.feedbackReportId || envelope.agentId !== signed.agentId) {
    throw new HttpError(400, "machine evidence report/agent does not match the attestation");
  }
}
