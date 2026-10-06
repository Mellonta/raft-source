import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalRotatingTraceSink } from "@botiverse/raft-trace-client";
import { BasicTracer } from "@botiverse/raft-shared";
import { DaemonTraceBundleUploader } from "./traceBundleUpload";

// Task #408 item 2 — #408 is prune deleting rotating trace files before they
// were ever uploaded. Nothing recorded that, so the loss was invisible: the
// files are simply gone, and a gone file leaves no evidence of having existed.
//
// The sink records what it DELETED (a fact it holds with certainty) and the
// uploader, which owns the receipts, decides which of those were never sent.

interface CapturedSpan {
  name: string;
  attrs: Record<string, unknown>;
}

function capturingTracer(captured: CapturedSpan[]) {
  return {
    startSpan(name: string, options: { attrs?: Record<string, unknown> }) {
      const entry: CapturedSpan = { name, attrs: { ...(options.attrs ?? {}) } };
      captured.push(entry);
      return {
        end(_status?: string, endOptions?: { attrs?: Record<string, unknown> }) {
          Object.assign(entry.attrs, endOptions?.attrs ?? {});
        },
        addEvent() {},
        setAttributes() {},
      };
    },
  } as never;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const okFetch = (async (url: string) => {
  if (String(url).includes("/internal/machine/scope-attestation")) {
    return jsonResponse({
      attestation: "att",
      scope: "daemon-trace-bundle:create",
      audience: "worker",
      resource: "res",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }
  if (String(url).includes("/api/trace-bundles")) {
    return jsonResponse({ upload: { method: "PUT", url: "https://worker.test/object" } });
  }
  return jsonResponse({ ok: true });
}) as never;

async function seed(traceDir: string, name: string): Promise<string> {
  const file = path.join(traceDir, name);
  await writeFile(file, '{"type":"span","schema_version":1,"trace_id":"t","span_id":"s"}\n');
  const old = new Date("2026-05-08T00:00:00.000Z");
  await utimes(file, old, old);
  return file;
}

function uploaderFor(machineDir: string, sink: LocalRotatingTraceSink, captured: CapturedSpan[]) {
  return new DaemonTraceBundleUploader({
    machineDir,
    serverUrl: "https://server.test",
    apiKey: "sk_machine_test",
    workerUrl: "https://worker.test/",
    minFileAgeMs: 0,
    tracer: capturingTracer(captured),
    sinkReportProvider: {
      drain: () => sink.drainSinkReport(),
      noteUndelivered: () => sink.noteAttrDropReportUndelivered(),
    },
    fetchImpl: okFetch,
  } as never);
}

function passSpan(captured: CapturedSpan[]): CapturedSpan | undefined {
  return captured.filter((s) => s.name === "daemon.bundle.upload_pass").at(-1);
}

test("#408 a file pruned before it was ever uploaded is counted, with its denominator", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-408-pruned-"));
  try {
    const traceDir = path.join(machineDir, "traces");
    await mkdir(traceDir, { recursive: true });

    // A tiny budget so writing forces a rotation and a prune.
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 256, maxFiles: 2 });
    const tracer = new BasicTracer({ sink });
    for (let i = 0; i < 12; i += 1) {
      tracer.startSpan(`daemon.fill.${i}`, { surface: "daemon", kind: "internal" }).end("ok");
    }

    const captured: CapturedSpan[] = [];
    await uploaderFor(machineDir, sink, captured).uploadOnce();

    const pass = passSpan(captured);
    assert.ok(pass, "the pass span must exist");
    assert.ok((pass.attrs.pruned_total as number) > 0, "prune must actually have deleted something");
    assert.equal(
      pass.attrs.pruned_without_receipt,
      pass.attrs.pruned_total,
      "nothing had been uploaded, so every pruned file is a loss",
    );
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#408 a file pruned after it was uploaded is not counted as a loss", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-408-receipted-"));
  try {
    const traceDir = path.join(machineDir, "traces");
    await mkdir(traceDir, { recursive: true });
    const captured: CapturedSpan[] = [];
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 8 });
    const uploader = uploaderFor(machineDir, sink, captured);

    // Upload a file first, so it has a receipt…
    const name = "daemon-trace-2026-09-19T05-00-00-000Z-1-0000.jsonl";
    await seed(traceDir, name);
    await uploader.uploadOnce();

    // …then have the sink prune it.
    await writeFile(path.join(machineDir, "marker"), "x");
    const tiny = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 256, maxFiles: 1 });
    const tracer = new BasicTracer({ sink: tiny });
    for (let i = 0; i < 12; i += 1) {
      tracer.startSpan(`daemon.fill.${i}`, { surface: "daemon", kind: "internal" }).end("ok");
    }

    const report = tiny.drainSinkReport();
    assert.ok(report.attrDrops.prunedNames.includes(name), "the receipted file must have been pruned");

    // Drive a pass with that sink's report and confirm the receipted name is
    // excluded from the loss count.
    const captured2: CapturedSpan[] = [];
    const uploader2 = new DaemonTraceBundleUploader({
      machineDir,
      serverUrl: "https://server.test",
      apiKey: "sk_machine_test",
      workerUrl: "https://worker.test/",
      minFileAgeMs: 0,
      tracer: capturingTracer(captured2),
      sinkReportProvider: {
        drain: () => ({
          writeFailures: tiny.getWriteFailureStats(),
          attrDrops: { ...report.attrDrops, prunedNames: [name], prunedTotal: 1, prunedNamesOverflow: 0 },
        }),
        noteUndelivered: () => {},
      },
      fetchImpl: okFetch,
    } as never);
    await uploader2.uploadOnce();

    const pass = passSpan(captured2);
    assert.ok(pass);
    assert.equal(pass.attrs.pruned_total, 1, "the denominator still counts it");
    assert.equal(pass.attrs.pruned_without_receipt, 0, "but it is not a loss — it had been uploaded");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#408 a healthy pass with no prunes reports no pruned attrs at all", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-408-noprune-"));
  try {
    const traceDir = path.join(machineDir, "traces");
    await mkdir(traceDir, { recursive: true });
    await seed(traceDir, "daemon-trace-2026-09-19T05-00-00-000Z-1-0000.jsonl");

    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 8 });
    const captured: CapturedSpan[] = [];
    await uploaderFor(machineDir, sink, captured).uploadOnce();

    const pass = passSpan(captured);
    assert.ok(pass);
    assert.equal(pass.attrs.pruned_total, undefined, "no prunes, no keys");
    assert.equal(pass.attrs.pruned_without_receipt, undefined);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#408 an undeletable victim is not reported as pruned — it is still on disk", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-408-undeletable-"));
  try {
    const sink = new LocalRotatingTraceSink({
      machineDir,
      maxFileBytes: 256,
      maxFiles: 1,
      fsOps: {
        rmSync: (() => {
          const err = new Error("simulated") as Error & { code?: string };
          err.code = "EPERM";
          throw err;
        }) as never,
      },
    } as never);
    const tracer = new BasicTracer({ sink });
    for (let i = 0; i < 12; i += 1) {
      tracer.startSpan(`daemon.fill.${i}`, { surface: "daemon", kind: "internal" }).end("ok");
    }

    const report = sink.drainSinkReport();
    assert.equal(report.attrDrops.prunedTotal, 0, "a file that could not be deleted was not lost");
    assert.deepEqual([...report.attrDrops.prunedNames], []);
    assert.ok(sink.getWriteFailureStats().pruneFailures > 0, "the failure is still counted, as a prune failure");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});
