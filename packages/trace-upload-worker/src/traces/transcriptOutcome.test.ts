// task #1228 ①: the worker carries the signed transcript content label, byte
// counts and request id into the ledger, and accepts/validates/files the
// transcript_outcome object without ever treating it as traces.
import { createHash, createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { handleRequest, type TraceUploadWorkerEnv } from "../index";
import { reingestCandidates } from "../reingest";

const SECRET = "transcript-outcome-secret";
const AGENT_ID = "0b0e2a8e-1d2c-4f3a-9a1b-0c0d0e0f1a2b";

class MockR2Bucket {
  puts: Array<{ key: string; body: ArrayBuffer | string; options?: { customMetadata?: Record<string, string> } }> = [];
  async put(key: string, value: ArrayBuffer | string, options?: MockR2Bucket["puts"][number]["options"]) {
    this.puts.push({ key, body: value, options });
    return { etag: "etag" };
  }
  async get(key: string) {
    const put = [...this.puts].reverse().find((p) => p.key === key);
    if (!put) return null;
    return { body: new Response(put.body).body, customMetadata: put.options?.customMetadata };
  }
}

class Ctx {
  promises: Promise<unknown>[] = [];
  waitUntil(p: Promise<unknown>) { this.promises.push(p); }
}

function sign(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${createHmac("sha256", SECRET).update(payload).digest("base64url")}`;
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const gz = (text: string) => new Uint8Array(gzipSync(Buffer.from(text, "utf8")));

function env() {
  const bucket = new MockR2Bucket();
  const otlpCalls: number[] = [];
  return {
    bucket,
    otlpCalls,
    env: {
      SCOPE_ATTESTATION_SECRET: SECRET,
      TRACE_BUNDLES: bucket,
      TRACE_INGEST_OTLP_ENDPOINT: "https://telescope.test/v1/traces",
      TRACE_INGEST_FETCH: async () => { otlpCalls.push(1); return new Response(null, { status: 200 }); },
    } as unknown as TraceUploadWorkerEnv,
  };
}

function claims(metadata: Record<string, unknown>) {
  return {
    v: 1, typ: "scope-attestation", scope: "daemon-trace-bundle:create", sub: "machine:machine-1", actorType: "machine",
    machineId: "machine-1", serverId: "server-1", aud: "trace-ingest-worker", resource: "servers/server-1/machines/machine-1/trace-bundles",
    nonce: "n", exp: Math.floor(Date.now() / 1000) + 60, metadata,
  };
}

function outcomeObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "feedback_transcript_outcome",
    schemaVersion: 1,
    feedbackReportId: "1d6f0b7a-3c2e-4a59-9e8d-5f4b3a2c1e01",
    agentId: AGENT_ID,
    requestId: "req-1",
    daemonVersion: "1.0.43",
    generatedAt: "2026-10-04T08:00:01.000Z",
    lookup: {
      reachable: false, content: "placeholder", reasonCode: "native_session_file_not_found", runtime: "claude",
      lookupMethod: "claude_jsonl", workspaceDirPresent: null,
      sourceBytes: null, transcriptBytes: null, selectionBasis: "lookup_time",
    },
    upload: { status: "not_attempted", reason: "lookup_failed", stage: null, httpStatus: null, httpClass: null, uploadId: null, contentLabel: null },
    selfStorage: "not_self_attested",
    ...overrides,
  };
}

function outcomeMetadata(body: Uint8Array, extra: Record<string, unknown> = {}) {
  return {
    uploadId: "upload-oc",
    objectKey: "feedback-transcript-outcomes/server-1/machine-1/upload-oc.json.gz",
    bundleId: "bundle-oc",
    bundleSha256: sha(body),
    bundleSizeBytes: body.byteLength,
    maxBytes: 2048 + 1024,
    bundleContentType: "application/json",
    bundleContentEncoding: "gzip",
    feedbackReportId: "1d6f0b7a-3c2e-4a59-9e8d-5f4b3a2c1e01",
    agentId: AGENT_ID,
    feedbackTranscriptRequestId: "req-1",
    feedbackAttachmentKind: "transcript_outcome",
    ...extra,
  };
}

function transcriptMetadata(body: Uint8Array, extra: Record<string, unknown> = {}) {
  return {
    uploadId: "upload-tr",
    objectKey: "trace-bundles/server-1/machine-1/upload-tr.jsonl.gz",
    bundleId: "bundle-tr",
    bundleSha256: sha(body),
    bundleSizeBytes: body.byteLength,
    maxBytes: 50 * 1024 * 1024,
    bundleContentType: "application/json",
    bundleContentEncoding: "gzip",
    feedbackReportId: "1d6f0b7a-3c2e-4a59-9e8d-5f4b3a2c1e01",
    agentId: AGENT_ID,
    feedbackReportTimeSource: "web_report_bundle",
    feedbackTranscriptWindowCoverage: "covered",
    feedbackTranscriptContent: "native_session_file",
    feedbackTranscriptSourceBytes: 4096,
    feedbackTranscriptBytes: 1024,
    feedbackTranscriptRequestId: "req-1",
    ...extra,
  };
}

async function createAndPut(e: TraceUploadWorkerEnv, ctx: Ctx, metadata: Record<string, unknown>, body: Uint8Array<ArrayBuffer>) {
  const createRes = await handleRequest(new Request("https://worker.test/api/trace-bundles", {
    method: "POST",
    body: JSON.stringify({ attestation: sign(claims(metadata)), bundleSha256: sha(body), bundleSizeBytes: body.byteLength }),
  }), e);
  if (createRes.status !== 200) return { createRes, putRes: null, session: null };
  const session = await createRes.clone().json() as { upload: { url: string }; feedbackAttachmentKind?: string };
  const putRes = await handleRequest(new Request(session.upload.url, { method: "PUT", body }), e, ctx);
  return { createRes, putRes, session };
}

const reportLedger = (bucket: MockR2Bucket, uploadId: string) => {
  const put = [...bucket.puts].reverse().find((p) => p.key === `feedback-report-ledgers/server-1/1d6f0b7a-3c2e-4a59-9e8d-5f4b3a2c1e01/trace-${uploadId}.json`);
  return put ? JSON.parse(String(put.body)) as Record<string, unknown> : null;
};

describe("worker: transcript content label + byte counts + request id reach the ledger", () => {
  test("W1 signed label, byte counts and request id are carried into R2 metadata and both ledgers", async () => {
    const { env: e, bucket } = env();
    const body = gz('{"type":"user"}\n');
    const { putRes } = await createAndPut(e, new Ctx(), transcriptMetadata(body), body);
    assert.equal(putRes?.status, 200);
    const record = reportLedger(bucket, "upload-tr");
    assert.equal(record?.transcript_content, "native_session_file");
    assert.equal(record?.transcript_source_bytes, 4096);
    assert.equal(record?.transcript_bytes, 1024);
    assert.equal(record?.request_id, "req-1");
    const object = bucket.puts.find((p) => p.key === "trace-bundles/server-1/machine-1/upload-tr.jsonl.gz");
    assert.equal(object?.options?.customMetadata?.transcriptContent, "native_session_file");
    assert.equal(object?.options?.customMetadata?.requestId, "req-1");
  });

  test("W2 an invalid coverage claim does NOT erase the content label (read independently)", async () => {
    const { env: e, bucket } = env();
    const body = gz('{"type":"user"}\n');
    await createAndPut(e, new Ctx(), transcriptMetadata(body, { feedbackTranscriptWindowCoverage: "bogus" }), body);
    const record = reportLedger(bucket, "upload-tr");
    assert.equal(record?.transcript_coverage, undefined);
    assert.equal(record?.transcript_content, "native_session_file");
  });

  test("W3 an absent label is never defaulted to native; out-of-enum labels are not carried", async () => {
    for (const label of [undefined, "placeholder", "x"]) {
      const { env: e, bucket } = env();
      const body = gz('{"type":"user"}\n');
      await createAndPut(e, new Ctx(), transcriptMetadata(body, { feedbackTranscriptContent: label, feedbackTranscriptRequestId: undefined }), body);
      const record = reportLedger(bucket, "upload-tr");
      assert.ok(record, String(label));
      assert.equal("transcript_content" in record, false, String(label));
      assert.equal("request_id" in record, false);
    }
  });
});

describe("worker: transcript_outcome attachment kind", () => {
  test("W4 create acknowledges the kind; valid outcome stored at its own key, filed in the report ledger, NEVER ingested as traces", async () => {
    const { env: e, bucket, otlpCalls } = env();
    const ctx = new Ctx();
    const body = gz(JSON.stringify(outcomeObject()));
    const { session, putRes } = await createAndPut(e, ctx, outcomeMetadata(body), body);
    assert.equal(session?.feedbackAttachmentKind, "transcript_outcome");
    assert.equal(putRes?.status, 200, await putRes?.clone().text());
    await Promise.all(ctx.promises);
    assert.equal(ctx.promises.length, 0);
    assert.equal(otlpCalls.length, 0);
    assert.ok(bucket.puts.some((p) => p.key === "feedback-transcript-outcomes/server-1/machine-1/upload-oc.json.gz"));
    assert.ok(!bucket.puts.some((p) => p.key.startsWith("trace-bundles/")), "nothing under trace-bundles/");
    const record = reportLedger(bucket, "upload-oc");
    assert.equal(record?.feedback_attachment_kind, "transcript_outcome");
    assert.equal(record?.object_key, "feedback-transcript-outcomes/server-1/machine-1/upload-oc.json.gz");
    assert.equal(record?.request_id, "req-1");
    assert.equal(record?.scopedb_status, "skipped");
  });

  test("W5 create rejects an outcome without report/agent/request binding or not gzipped JSON", async () => {
    const body = gz(JSON.stringify(outcomeObject()));
    for (const extra of [{ agentId: undefined }, { feedbackReportId: undefined }, { feedbackTranscriptRequestId: undefined }, { bundleContentType: "text/plain" }, { bundleContentEncoding: undefined }]) {
      const { env: e } = env();
      const { createRes } = await createAndPut(e, new Ctx(), outcomeMetadata(body, extra), body);
      assert.equal(createRes.status, 400, JSON.stringify(extra));
    }
  });

  test("W6 PUT rejects: identity mismatch (report / agent / request), unknown field, out-of-enum value, over 2 KiB raw", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["other report", outcomeObject({ feedbackReportId: "2e7a1c8b-4d3f-4b6a-8f9e-6a5c4b3d2f02" })],
      ["other agent", outcomeObject({ agentId: "1b0e2a8e-1d2c-4f3a-9a1b-0c0d0e0f1a2b" })],
      ["other request", outcomeObject({ requestId: "req-2" })],
      ["unknown field", { ...outcomeObject(), note: "free text" }],
      ["bad enum", outcomeObject({ upload: { ...(outcomeObject().upload as object), status: "uploaded_maybe" } })],
      ["self-attested storage", outcomeObject({ selfStorage: "stored" })],
      ["over cap", outcomeObject({ daemonVersion: "x".repeat(4096) })],
    ];
    for (const [name, object] of cases) {
      const { env: e, bucket } = env();
      const body = gz(JSON.stringify(object));
      const { putRes } = await createAndPut(e, new Ctx(), outcomeMetadata(body), body);
      assert.ok(putRes && putRes.status >= 400 && putRes.status < 500, `${name}: ${putRes?.status}`);
      assert.equal(bucket.puts.length, 0, name);
    }
  });

  test("W6b PUT rejects an outcome carrying searchedPaths (absolute, home-folded or empty): outcomes carry no paths", async () => {
    const lookup = outcomeObject().lookup as Record<string, unknown>;
    for (const searchedPaths of [["/srv/custom-private-workspace/agent/x"], ["~/.claude/projects"], []]) {
      const { env: e, bucket } = env();
      const body = gz(JSON.stringify(outcomeObject({ lookup: { ...lookup, searchedPaths } })));
      const { putRes } = await createAndPut(e, new Ctx(), outcomeMetadata(body), body);
      assert.equal(putRes?.status, 400, JSON.stringify(searchedPaths));
      assert.equal(bucket.puts.length, 0, JSON.stringify(searchedPaths));
    }
  });

  test("W7 re-ingest never replays a transcript_outcome ledger as traces", async () => {
    const { env: e, bucket } = env();
    const body = gz(JSON.stringify(outcomeObject()));
    await createAndPut(e, new Ctx(), outcomeMetadata(body), body);
    const ledgerKey = "trace-ledgers/server-1/machine-1/upload-oc.json";
    assert.ok(bucket.puts.some((p) => p.key === ledgerKey));
    const { outcomes, failures } = await reingestCandidates(e, [{ upload_id: "upload-oc", ledger_key: ledgerKey }], { entries: { "upload-oc": { group: "zero", row_count: 0 } } }, false);
    assert.equal(failures, 0);
    assert.equal(outcomes[0]?.action, "skipped_not_trace");
  });
});
