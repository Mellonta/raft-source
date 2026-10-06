// machine_evidence: the feedback diagnostics (observed-failure summary, trace
// tail projection, machine state) travel as their own object with their own
// signed attestation. The worker must (1) acknowledge the kind so a daemon can
// tell a new worker from an old one, (2) strictly parse and identity-check the
// object before storing it, (3) never route it into OTLP trace ingest.
import { createHash, createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import {
  FEEDBACK_MACHINE_EVIDENCE_MAX_BYTES,
  SCOPE_ATTESTATION_MAX_CHARS,
  buildBoundedFeedbackMachineEvidence,
} from "@botiverse/raft-shared";
import { handleRequest, type TraceUploadWorkerEnv } from "../index";
import { reingestCandidates } from "../reingest";
import { feedbackReportCompleteLedgerKey, feedbackReportLedgerKey, feedbackReportTraceLedgerKey } from "../feedback/ledgerKeys";

const SECRET = "machine-evidence-secret";
const AGENT_ID = "0b0e2a8e-1d2c-4f3a-9a1b-0c0d0e0f1a2b";

class MockR2Bucket {
  puts: Array<{ key: string; body: ArrayBuffer | string; options?: { customMetadata?: Record<string, string>; httpMetadata?: Record<string, string> } }> = [];
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

function sha256Hex(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function env(): { env: TraceUploadWorkerEnv; bucket: MockR2Bucket; otlpCalls: number[] } {
  const bucket = new MockR2Bucket();
  const otlpCalls: number[] = [];
  return {
    bucket,
    otlpCalls,
    env: {
      SCOPE_ATTESTATION_SECRET: SECRET,
      TRACE_BUNDLES: bucket,
      // Ingest IS configured: machine_evidence must still not go there.
      TRACE_INGEST_OTLP_ENDPOINT: "https://telescope.test/v1/traces",
      TRACE_INGEST_FETCH: async () => { otlpCalls.push(1); return new Response(null, { status: 200 }); },
    },
  };
}

function evidenceJson(overrides: { agentId?: string; feedbackReportId?: string } = {}): string {
  const built = buildBoundedFeedbackMachineEvidence({
    feedbackReportId: overrides.feedbackReportId ?? "1d6f0b7a-3c2e-4a59-9e8d-5f4b3a2c1e01",
    agentId: overrides.agentId ?? AGENT_ID,
    observedFailureSummary: null,
    feedbackTraceTail: null,
    feedbackMachineState: { daemonVersion: "1.0.40", computerServiceVersion: null, kStableVersion: null, hostLifecycleOwner: "cli", dispatcherPathKind: "stable" },
  });
  assert.ok(built.ok);
  return built.json;
}

function claims(metadata: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    typ: "scope-attestation",
    scope: "daemon-trace-bundle:create",
    sub: "machine:machine-1",
    actorType: "machine",
    machineId: "machine-1",
    serverId: "server-1",
    aud: "trace-ingest-worker",
    resource: "servers/server-1/machines/machine-1/trace-bundles",
    nonce: "n",
    exp: Math.floor(Date.now() / 1000) + 60,
    metadata,
    ...overrides,
  };
}

function evidenceMetadata(gz: Uint8Array, extra: Record<string, unknown> = {}) {
  return {
    uploadId: "upload-ev",
    objectKey: "feedback-machine-evidence/server-1/machine-1/upload-ev.json.gz",
    bundleId: "bundle-ev",
    bundleSha256: sha256Hex(gz),
    bundleSizeBytes: gz.byteLength,
    maxBytes: FEEDBACK_MACHINE_EVIDENCE_MAX_BYTES + 4096,
    bundleContentType: "application/json",
    bundleContentEncoding: "gzip",
    feedbackReportId: "1d6f0b7a-3c2e-4a59-9e8d-5f4b3a2c1e01",
    agentId: AGENT_ID,
    feedbackAttachmentKind: "machine_evidence",
    ...extra,
  };
}

async function create(e: TraceUploadWorkerEnv, attestation: string, gz: Uint8Array) {
  return handleRequest(new Request("https://worker.test/api/trace-bundles", {
    method: "POST",
    body: JSON.stringify({ attestation, bundleSha256: sha256Hex(gz), bundleSizeBytes: gz.byteLength }),
  }), e);
}

async function createAndPut(e: TraceUploadWorkerEnv, ctx: Ctx, gz: Uint8Array<ArrayBuffer>, metadataExtra: Record<string, unknown> = {}, putBody?: Uint8Array<ArrayBuffer>) {
  const createRes = await create(e, sign(claims(evidenceMetadata(gz, metadataExtra))), gz);
  assert.equal(createRes.status, 200, await createRes.clone().text());
  const session = await createRes.json() as { upload: { url: string }; feedbackAttachmentKind?: string };
  const putRes = await handleRequest(new Request(session.upload.url, { method: "PUT", body: putBody ?? gz }), e, ctx);
  return { session, putRes };
}

function gz(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(gzipSync(Buffer.from(text, "utf8")));
}

describe("trace upload worker: machine_evidence attachment kind", () => {
  test("create acknowledges the signed kind so a daemon can tell this worker from an older one", async () => {
    const { env: e } = env();
    const body = gz(evidenceJson());
    const res = await create(e, sign(claims(evidenceMetadata(body))), body);
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { feedbackAttachmentKind?: string }).feedbackAttachmentKind, "machine_evidence");

    const plain = await create(e, sign(claims({ ...evidenceMetadata(body), feedbackAttachmentKind: undefined, objectKey: "trace-bundles/server-1/machine-1/u.jsonl.gz" })), body);
    assert.equal(plain.status, 200);
    assert.equal("feedbackAttachmentKind" in (await plain.json() as object), false);
  });

  test("create rejects machine_evidence without the report/agent binding or with a non-JSON-gzip content type", async () => {
    const { env: e } = env();
    const body = gz(evidenceJson());
    for (const extra of [{ agentId: undefined }, { feedbackReportId: undefined }, { bundleContentType: "text/plain" }, { bundleContentEncoding: undefined }]) {
      const res = await create(e, sign(claims(evidenceMetadata(body, extra))), body);
      assert.equal(res.status, 400, JSON.stringify(extra));
    }
  });

  test("valid evidence is stored with its kind, filed under the report, and NEVER sent to OTLP trace ingest", async () => {
    const { env: e, bucket, otlpCalls } = env();
    const ctx = new Ctx();
    const body = gz(evidenceJson());
    const { putRes } = await createAndPut(e, ctx, body);
    assert.equal(putRes.status, 200, await putRes.clone().text());
    await Promise.all(ctx.promises);
    assert.equal(ctx.promises.length, 0, "no ingest scheduled");
    assert.equal(otlpCalls.length, 0, "no OTLP call");
    const object = bucket.puts.find((p) => p.key === "feedback-machine-evidence/server-1/machine-1/upload-ev.json.gz");
    assert.ok(object, "evidence object stored at its own key");
    assert.equal(object.options?.customMetadata?.feedbackAttachmentKind, "machine_evidence");
    const ledger = bucket.puts.find((p) => p.key === "feedback-report-ledgers/server-1/1d6f0b7a-3c2e-4a59-9e8d-5f4b3a2c1e01/trace-upload-ev.json");
    assert.ok(ledger, "filed in the report folder");
    const record = JSON.parse(String(ledger.body)) as Record<string, unknown>;
    assert.equal(record.feedback_attachment_kind, "machine_evidence");
    assert.equal(record.scopedb_status, "skipped");
    assert.equal(record.agent_id, AGENT_ID);
  });

  test("identity mismatch: object naming a different agent or report than the attestation is rejected, nothing stored", async () => {
    for (const mismatch of [{ agentId: "1b0e2a8e-1d2c-4f3a-9a1b-0c0d0e0f1a2b" }, { feedbackReportId: "2e7a1c8b-4d3f-4b6a-8f9e-6a5c4b3d2f02" }]) {
      const { env: e, bucket } = env();
      const body = gz(evidenceJson(mismatch));
      const { putRes } = await createAndPut(e, new Ctx(), body);
      assert.equal(putRes.status, 400, JSON.stringify(mismatch));
      assert.match(((await putRes.json()) as { error: string }).error, /does not match the attestation/);
      assert.equal(bucket.puts.length, 0);
    }
  });

  test("identity mismatch: an attestation whose resource names another machine or server is refused", async () => {
    const { env: e } = env();
    const body = gz(evidenceJson());
    for (const overrides of [
      { machineId: "machine-2" },
      { serverId: "server-2" },
      { resource: "servers/server-1/machines/machine-2/trace-bundles" },
    ]) {
      const res = await create(e, sign(claims(evidenceMetadata(body), overrides)), body);
      assert.equal(res.status, 403, JSON.stringify(overrides));
    }
  });

  test("signature tampering: re-encoded claims under the original signature are refused", async () => {
    const { env: e } = env();
    const body = gz(evidenceJson());
    const token = sign(claims(evidenceMetadata(body)));
    const [, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify(claims(evidenceMetadata(body, { agentId: "1b0e2a8e-1d2c-4f3a-9a1b-0c0d0e0f1a2b" })))).toString("base64url");
    const res = await create(e, `${forged}.${signature}`, body);
    assert.equal(res.status, 401);
  });

  test("bytes changed after signing are refused (sha mismatch)", async () => {
    const { env: e, bucket } = env();
    const body = gz(evidenceJson());
    const changed = new Uint8Array(body);
    changed[changed.length - 5] ^= 0xff;
    const { putRes } = await createAndPut(e, new Ctx(), body, {}, changed);
    assert.equal(putRes.status, 400);
    assert.match(((await putRes.json()) as { error: string }).error, /bundleSha256 mismatch/);
    assert.equal(bucket.puts.length, 0);
  });

  test("raw JSON exactly at the 256 KiB cap is accepted; one byte over is 413", async () => {
    const json = evidenceJson();
    // Trailing whitespace is valid JSON; it pins the raw byte count exactly.
    const atCap = json + " ".repeat(FEEDBACK_MACHINE_EVIDENCE_MAX_BYTES - Buffer.byteLength(json));
    assert.equal(Buffer.byteLength(atCap), FEEDBACK_MACHINE_EVIDENCE_MAX_BYTES);
    const ok = env();
    const accepted = await createAndPut(ok.env, new Ctx(), gz(atCap));
    assert.equal(accepted.putRes.status, 200, await accepted.putRes.clone().text());

    const over = env();
    const rejected = await createAndPut(over.env, new Ctx(), gz(`${atCap} `));
    assert.equal(rejected.putRes.status, 413);
    assert.equal(over.bucket.puts.length, 0);
  });

  test("free text or an unknown field in the object is rejected by the strict parser", async () => {
    const { env: e, bucket } = env();
    const tainted = JSON.parse(evidenceJson()) as Record<string, unknown>;
    tainted.note = "sk_agent_LIVE_TOKEN_abcdef123456";
    const { putRes } = await createAndPut(e, new Ctx(), gz(JSON.stringify(tainted)));
    assert.equal(putRes.status, 400);
    assert.equal(bucket.puts.length, 0);
  });

  test("attestation length gate is the shared SCOPE_ATTESTATION_MAX_CHARS budget", async () => {
    const { env: e } = env();
    const body = gz(evidenceJson());
    const atBudget = await create(e, "a".repeat(SCOPE_ATTESTATION_MAX_CHARS), body);
    assert.equal(atBudget.status, 401, "at the budget the token is read and fails only on signature");
    const over = await create(e, "a".repeat(SCOPE_ATTESTATION_MAX_CHARS + 1), body);
    assert.equal(over.status, 400);
    assert.match(((await over.json()) as { error: string }).error, /attestation is too long/);
  });

  test("re-ingest never replays a machine_evidence ledger as traces", async () => {
    const { env: e, bucket } = env();
    const body = gz(evidenceJson());
    await createAndPut(e, new Ctx(), body);
    const ledgerKey = "trace-ledgers/server-1/machine-1/upload-ev.json";
    assert.ok(bucket.puts.some((p) => p.key === ledgerKey));
    const { outcomes, failures } = await reingestCandidates(e, [{ upload_id: "upload-ev", ledger_key: ledgerKey }], { entries: { "upload-ev": { group: "zero", row_count: 0 } } }, false);
    assert.equal(failures, 0);
    assert.equal(outcomes[0]?.action, "skipped_not_trace");
  });
});

test("a signed report or agent id that is not a UUID is refused at create, before any key is built", async () => {
  const body = gz(evidenceJson());
  for (const bad of ["../x", "..", "report-1", `${AGENT_ID}/../x`]) {
    for (const field of ["feedbackReportId", "agentId"]) {
      const { env: e, bucket } = env();
      const res = await create(e, sign(claims(evidenceMetadata(body, { [field]: bad }))), body);
      assert.equal(res.status, 400, `${field}=${bad}`);
      assert.match(await res.text(), new RegExp(`attestation\\.metadata\\.${field} is invalid`));
      assert.equal(bucket.puts.length, 0);
    }
  }
});

test("report ledger keys are only built from a UUID report id", () => {
  assert.throws(() => feedbackReportTraceLedgerKey({ serverId: "server-1", feedbackReportId: "../x", uploadId: "u" }), /UUID/);
  assert.throws(() => feedbackReportLedgerKey({ serverId: "server-1", reportId: "..", artifactId: "a" }), /UUID/);
  assert.throws(() => feedbackReportCompleteLedgerKey({ serverId: "server-1", reportId: "r/../x", artifactId: "a" }), /UUID/);
  assert.equal(
    feedbackReportTraceLedgerKey({ serverId: "server-1", feedbackReportId: AGENT_ID, uploadId: "u" }),
    `feedback-report-ledgers/server-1/${AGENT_ID}/trace-u.json`,
  );
});
