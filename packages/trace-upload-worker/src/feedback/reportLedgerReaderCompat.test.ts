// task #1228 ①: report-ledger compatibility for readers (Lens lives in
// botiverse/lens and is not in this repo, so its rule is EMULATED here).
//
// Old Lens rule (Lensmith): syncReport validates each ledger entry's
// object_key against `trace-bundles/<serverId>/` BEFORE it classifies the
// entry, and an unknown/missing kind defaults to "transcript". The
// transcript_outcome entry must therefore live at a non-trace-bundles key, and
// its presence must not change which entry resolves as the transcript.
//
// The committed fixture (testing/fixtures/feedback-report-ledger.transcript-outcome.json)
// is pinned to what the REAL worker handlers write: the current handler for a
// labelled transcript and an outcome, the frozen a8039c677 handler for an old
// untagged transcript.
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import * as shared from "@botiverse/raft-shared";
import { handleRequest, type TraceUploadWorkerEnv } from "../index";
import { legacyHandleRequest } from "../testing/legacyTraceBundlesA8039c677";

const SECRET = "ledger-compat-secret";
const AGENT_ID = "0b0e2a8e-1d2c-4f3a-9a1b-0c0d0e0f1a2b";
const FIXTURE_PATH = path.join(__dirname, "..", "testing", "fixtures", "feedback-report-ledger.transcript-outcome.json");

type LedgerRecord = Record<string, unknown>;

class MockR2Bucket {
  puts: Array<{ key: string; body: ArrayBuffer | string }> = [];
  async put(key: string, value: ArrayBuffer | string) {
    this.puts.push({ key, body: value });
    return { etag: "etag" };
  }
  async get() { return null; }
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const gz = (text: string) => new Uint8Array(gzipSync(Buffer.from(text, "utf8")));
function sign(metadata: Record<string, unknown>): string {
  const claims = {
    v: 1, typ: "scope-attestation", scope: "daemon-trace-bundle:create", sub: "machine:machine-1", actorType: "machine",
    machineId: "machine-1", serverId: "server-1", aud: "trace-ingest-worker", resource: "servers/server-1/machines/machine-1/trace-bundles",
    nonce: "n", exp: Math.floor(Date.now() / 1000) + 60, metadata,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${createHmac("sha256", SECRET).update(payload).digest("base64url")}`;
}

async function upload(worker: typeof handleRequest, e: TraceUploadWorkerEnv, metadata: Record<string, unknown>, body: Uint8Array<ArrayBuffer>) {
  const create = await worker(new Request("https://worker.test/api/trace-bundles", {
    method: "POST",
    body: JSON.stringify({ attestation: sign({ ...metadata, bundleSha256: sha(body), bundleSizeBytes: body.byteLength }), bundleSha256: sha(body), bundleSizeBytes: body.byteLength }),
  }), e);
  assert.equal(create.status, 200, await create.clone().text());
  const session = await create.json() as { upload: { url: string } };
  const put = await worker(new Request(session.upload.url, { method: "PUT", body }), e);
  assert.equal(put.status, 200, await put.clone().text());
}

const OUTCOME = {
  type: "feedback_transcript_outcome",
  schemaVersion: 1,
  feedbackReportId: "1d6f0b7a-3c2e-4a59-9e8d-5f4b3a2c1e01",
  agentId: AGENT_ID,
  requestId: "req-2",
  daemonVersion: "1.0.43",
  generatedAt: "2026-10-04T08:00:01.000Z",
  lookup: {
    reachable: false, content: "placeholder", reasonCode: "native_session_file_not_found", runtime: "claude",
    lookupMethod: "claude_jsonl", workspaceDirPresent: null,
    sourceBytes: null, transcriptBytes: null, selectionBasis: "lookup_time",
  },
  upload: { status: "not_attempted", reason: "lookup_failed", stage: null, httpStatus: null, httpClass: null, uploadId: null, contentLabel: null },
  selfStorage: "not_self_attested",
};

const common = { bundleContentType: "application/json", bundleContentEncoding: "gzip", maxBytes: 50 * 1024 * 1024, feedbackReportId: "1d6f0b7a-3c2e-4a59-9e8d-5f4b3a2c1e01", agentId: AGENT_ID };

/** Report-ledger entries as the real handlers write them (no OTLP endpoint → deterministic statuses). */
async function produceLedger(): Promise<LedgerRecord[]> {
  const bucket = new MockR2Bucket();
  const e = { SCOPE_ATTESTATION_SECRET: SECRET, TRACE_BUNDLES: bucket } as unknown as TraceUploadWorkerEnv;
  // 1. new daemon, labelled transcript (request req-1)
  await upload(handleRequest, e, {
    ...common, uploadId: "upload-transcript-new", bundleId: "bundle-transcript-new",
    objectKey: "trace-bundles/server-1/machine-1/upload-transcript-new.jsonl.gz",
    feedbackReportTimeSource: "web_report_bundle", feedbackTranscriptWindowCoverage: "covered",
    feedbackTranscriptContent: "native_session_file", feedbackTranscriptSourceBytes: 4096, feedbackTranscriptBytes: 1024,
    feedbackTranscriptRequestId: "req-1",
  }, gz('{"type":"user"}\n'));
  // 2. a later request's outcome object (req-2, lookup failed)
  await upload(handleRequest, e, {
    ...common, uploadId: "upload-outcome", bundleId: "bundle-outcome", maxBytes: 3072,
    objectKey: "feedback-transcript-outcomes/server-1/machine-1/upload-outcome.json.gz",
    feedbackAttachmentKind: "transcript_outcome", feedbackTranscriptRequestId: "req-2",
  }, gz(JSON.stringify(OUTCOME)));
  // 3. an OLD daemon's untagged transcript through the frozen a8039c677 worker
  await upload(legacyHandleRequest, e, {
    ...common, uploadId: "upload-transcript-old", bundleId: "bundle-transcript-old",
    objectKey: "trace-bundles/server-1/machine-1/upload-transcript-old.jsonl.gz",
    feedbackReportTimeSource: "server_request_received", feedbackTranscriptWindowCoverage: "covered",
  }, gz('{"type":"runtime_session_handoff"}\n'));
  return bucket.puts
    .filter((p) => p.key.startsWith("feedback-report-ledgers/server-1/1d6f0b7a-3c2e-4a59-9e8d-5f4b3a2c1e01/"))
    .map((p) => normalize(JSON.parse(String(p.body)) as LedgerRecord));
}

/** Fields whose values depend on the clock or the zlib build. */
function normalize(record: LedgerRecord): LedgerRecord {
  return { ...record, updated_at: "<normalized>", bundle_sha256: "<normalized>", bundle_size_bytes: "<normalized>" };
}

function loadFixture(): { entries: LedgerRecord[] } {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { entries: LedgerRecord[] };
}

/** EMULATION of old Lens's syncReport: prefix check first, then classify; unknown kind → transcript. */
function oldLensTranscriptKeys(entries: LedgerRecord[]): string[] {
  const keys: string[] = [];
  for (const entry of entries) {
    const objectKey = String(entry.object_key ?? "");
    if (!objectKey.startsWith(`trace-bundles/${String(entry.server_id)}/`)) continue;
    const kind = entry.feedback_attachment_kind;
    const classified = kind === "machine_log_tail" ? "machine_log_tail" : "transcript";
    if (classified === "transcript") keys.push(objectKey);
  }
  return keys;
}

/** The same reader WITHOUT the prefix check: the control that shows the prefix is load-bearing. */
function naiveReaderTranscriptKeys(entries: LedgerRecord[]): string[] {
  return entries.filter((e) => e.feedback_attachment_kind !== "machine_log_tail").map((e) => String(e.object_key));
}

describe("report ledger: transcript_outcome compatibility with existing readers", () => {
  test("L1 the committed fixture equals what the real handlers write (labelled transcript, outcome, old untagged transcript)", async () => {
    const produced = await produceLedger();
    assert.deepEqual(produced, loadFixture().entries);
  });

  test("L2 old Lens (object_key prefix checked BEFORE classification) skips the outcome entry", () => {
    const { entries } = loadFixture();
    const outcome = entries.find((e) => e.feedback_attachment_kind === "transcript_outcome");
    assert.ok(outcome, "fixture has an outcome entry");
    assert.ok(!oldLensTranscriptKeys(entries).includes(String(outcome.object_key)));
  });

  test("L3 the outcome entry's presence does not change which objects resolve as transcripts", () => {
    const { entries } = loadFixture();
    const without = entries.filter((e) => e.feedback_attachment_kind !== "transcript_outcome");
    assert.deepEqual(oldLensTranscriptKeys(entries), oldLensTranscriptKeys(without));
    assert.deepEqual(oldLensTranscriptKeys(entries), [
      "trace-bundles/server-1/machine-1/upload-transcript-new.jsonl.gz",
      "trace-bundles/server-1/machine-1/upload-transcript-old.jsonl.gz",
    ]);
  });

  test("L4 control: a reader WITHOUT the prefix check would mis-import the outcome as a transcript (the prefix is load-bearing)", () => {
    const { entries } = loadFixture();
    const outcome = entries.find((e) => e.feedback_attachment_kind === "transcript_outcome")!;
    assert.ok(naiveReaderTranscriptKeys(entries).includes(String(outcome.object_key)));
  });

  test("L5 consumer rule (shared helper): labelled → native kind + request association; untagged → source_unverified + association unknown; outcome → not a transcript", () => {
    const classify = (shared as Record<string, unknown>).classifyFeedbackReportLedgerEntry as (r: LedgerRecord) => Record<string, unknown>;
    assert.equal(typeof classify, "function", "shared classifyFeedbackReportLedgerEntry exists");
    const { entries } = loadFixture();
    const byUpload = (id: string) => entries.find((e) => e.upload_id === id)!;
    assert.deepEqual(classify(byUpload("upload-transcript-new")), { attachment: "transcript", source: "native_session_file", requestAssociation: "req-1" });
    assert.deepEqual(classify(byUpload("upload-transcript-old")), { attachment: "transcript", source: "source_unverified", requestAssociation: "unknown" });
    assert.deepEqual(classify(byUpload("upload-outcome")), { attachment: "transcript_outcome", source: null, requestAssociation: "req-2" });
  });
});
