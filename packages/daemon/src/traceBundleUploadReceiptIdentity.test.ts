import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DaemonTraceBundleUploader } from "./traceBundleUpload";
import { LocalRotatingTraceSink } from "@botiverse/raft-trace-client";
import { BasicTracer } from "@botiverse/raft-shared";
import { readdirSync } from "node:fs";

// Task #408 — the server mints the uploadId and derives the R2 object key from
// it. The daemon received both in the attestation metadata and threw them away,
// so a local receipt recorded only `bundleId`, a local randomUUID that joins to
// nothing. "Did this file actually land in storage?" then had to be answered by
// matching timestamps, which is what the #417 investigation kept running into.

const UPLOAD_ID = "11111111-2222-3333-4444-555555555555";
const OBJECT_KEY = `trace-bundles/server-1/machine-1/${UPLOAD_ID}.jsonl.gz`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface CapturedSpan {
  name: string;
  status?: string;
  attrs: Record<string, unknown>;
}

function capturingTracer(captured: CapturedSpan[]) {
  return {
    startSpan(name: string, options: { attrs?: Record<string, unknown> }) {
      const entry: CapturedSpan = { name, attrs: { ...(options.attrs ?? {}) } };
      captured.push(entry);
      return {
        end(status?: string, endOptions?: { attrs?: Record<string, unknown> }) {
          entry.status = status;
          Object.assign(entry.attrs, endOptions?.attrs ?? {});
        },
        addEvent() {},
        setAttributes() {},
      };
    },
  } as never;
}

async function runUpload(metadata: Record<string, unknown> | undefined) {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-408-receipt-"));
  const traceDir = path.join(machineDir, "traces");
  await mkdir(traceDir, { recursive: true });
  const name = "daemon-trace-2026-09-19T05-00-00-000Z-1-0000.jsonl";
  const closedFile = path.join(traceDir, name);
  await writeFile(closedFile, '{"type":"span","schema_version":1,"trace_id":"t","span_id":"s"}\n');
  const old = new Date("2026-05-08T00:00:00.000Z");
  await utimes(closedFile, old, old);

  const captured: CapturedSpan[] = [];
  const uploader = new DaemonTraceBundleUploader({
    machineDir,
    serverUrl: "https://server.test",
    apiKey: "sk_machine_test",
    workerUrl: "https://worker.test/",
    minFileAgeMs: 0,
    tracer: capturingTracer(captured),
    fetchImpl: (async (url: string) => {
      // The server mints uploadId/objectKey on the attestation endpoint; the
      // worker's create endpoint is a separate call that does not carry them.
      if (String(url).includes("/internal/machine/scope-attestation")) {
        return jsonResponse({
          attestation: "att",
          scope: "daemon-trace-bundle:create",
          audience: "worker",
          resource: "res",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          ...(metadata ? { metadata } : {}),
        });
      }
      if (String(url).includes("/api/trace-bundles")) {
        return jsonResponse({ upload: { method: "PUT", url: "https://worker.test/object" } });
      }
      return jsonResponse({ ok: true });
    }) as never,
  });

  await uploader.uploadOnce();
  return { machineDir, name, captured };
}

test("#408 the receipt records the server uploadId and objectKey", async () => {
  const { machineDir, name, captured } = await runUpload({
    uploadId: UPLOAD_ID,
    objectKey: OBJECT_KEY,
    bundleId: "ignored-server-echo",
  });
  try {
    const receiptPath = path.join(machineDir, "trace-uploads", `${name}.uploaded.json`);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;

    assert.equal(receipt.uploadId, UPLOAD_ID, "the receipt must carry the server's join key");
    assert.equal(receipt.objectKey, OBJECT_KEY);
    assert.ok(typeof receipt.bundleId === "string", "the local bundleId is still recorded");
    assert.notEqual(receipt.bundleId, receipt.uploadId, "they are different identifiers");

    const span = captured.find((entry) => entry.name === "daemon.bundle.upload");
    assert.ok(span, "the upload span must exist");
    assert.equal(span.attrs.uploadId, UPLOAD_ID);
    assert.equal(span.attrs.upload_id_present, true);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#408 an older server that sends no identity produces a receipt that does not claim one", async () => {
  for (const metadata of [undefined, {}, { uploadId: "" }, { uploadId: 42 }]) {
    const { machineDir, name, captured } = await runUpload(metadata as Record<string, unknown> | undefined);
    try {
      const receiptPath = path.join(machineDir, "trace-uploads", `${name}.uploaded.json`);
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;

      assert.ok(!("uploadId" in receipt), `uploadId must be absent, not a placeholder (metadata=${JSON.stringify(metadata)})`);
      assert.ok(!("objectKey" in receipt));
      assert.ok(typeof receipt.uploadedAt === "string", "the receipt is still written");

      const span = captured.find((entry) => entry.name === "daemon.bundle.upload");
      assert.equal(span?.attrs.uploadId, undefined, "no uploadId attr when there is none");
      assert.equal(span?.attrs.upload_id_present, false, "absence is recorded explicitly");
    } finally {
      await rm(machineDir, { recursive: true, force: true });
    }
  }
});

// The capturingTracer above reads span attrs BEFORE they reach the sink, so it
// cannot see attribute sanitization. `LocalRotatingTraceSink.sanitizeAttrs`
// drops any attribute whose normalized name ends in `_id` unless it is in the
// DIAGNOSTIC_ID_ATTRS allowlist — which holds the camelCase `uploadId`. Spelled
// `upload_id` the join key is silently deleted on the way to disk and the record
// keeps only `upload_id_present`: the key appears to exist while carrying no
// value. This test therefore asserts on the bytes actually written. (@Stone.)
test("#408 the uploadId survives the local sink and reaches the trace file", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-408-sink-"));
  try {
    const traceDir = path.join(machineDir, "traces");
    await mkdir(traceDir, { recursive: true });
    const candidate = path.join(traceDir, "daemon-trace-2026-09-19T05-00-00-000Z-1-0000.jsonl");
    await writeFile(candidate, '{"type":"span","schema_version":1,"trace_id":"t","span_id":"s"}\n');
    const old = new Date("2026-05-08T00:00:00.000Z");
    await utimes(candidate, old, old);

    // A real sink and a real tracer: the span goes through sanitizeAttrs.
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 8 });
    const tracer = new BasicTracer({ sink });

    const uploader = new DaemonTraceBundleUploader({
      machineDir,
      serverUrl: "https://server.test",
      apiKey: "sk_machine_test",
      workerUrl: "https://worker.test/",
      minFileAgeMs: 0,
      tracer: tracer as never,
      currentFileProvider: () => sink.getCurrentFile(),
      fetchImpl: (async (url: string) => {
        if (String(url).includes("/internal/machine/scope-attestation")) {
          return jsonResponse({
            attestation: "att",
            scope: "daemon-trace-bundle:create",
            audience: "worker",
            resource: "res",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            metadata: { uploadId: UPLOAD_ID, objectKey: OBJECT_KEY },
          });
        }
        if (String(url).includes("/api/trace-bundles")) {
          return jsonResponse({ upload: { method: "PUT", url: "https://worker.test/object" } });
        }
        return jsonResponse({ ok: true });
      }) as never,
    });

    await uploader.uploadOnce();

    const records: Array<Record<string, unknown>> = [];
    for (const name of readdirSync(traceDir)) {
      const text = await readFile(path.join(traceDir, name), "utf8");
      for (const line of text.split("\n").filter((l) => l.length > 0)) {
        try {
          records.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // the seeded candidate line is a fixture, not a real record
        }
      }
    }

    const uploadSpans = records.filter((record) => record.name === "daemon.bundle.upload");
    assert.ok(uploadSpans.length > 0, "the upload span must have been written to disk");
    const attrs = uploadSpans[0]!.attrs as Record<string, unknown> | undefined;
    assert.ok(attrs, "the written span must carry attrs");
    assert.equal(
      attrs.uploadId,
      UPLOAD_ID,
      "the join key must survive sanitizeAttrs; spelled upload_id it is silently dropped",
    );
    assert.equal(attrs.upload_id_present, true);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});
