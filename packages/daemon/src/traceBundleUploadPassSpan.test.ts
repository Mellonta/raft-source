import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DaemonTraceBundleUploader } from "./traceBundleUpload";

// Task #408 item 1 — today a pass emits a span per uploaded FILE, so a pass that
// uploads nothing emits nothing, and "scanned and found zero" is indistinguishable
// from "the uploader never ran". #408 is a machine that quietly stopped uploading,
// which is the first of those two. The pass span makes them different.

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function okFetch(fail = false) {
  return (async (url: string) => {
    if (fail) return jsonResponse({ error: "no" }, 500);
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
}

async function seed(traceDir: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const file = path.join(traceDir, `daemon-trace-2026-09-19T05-00-${String(i).padStart(2, "0")}-000Z-1-0000.jsonl`);
    await writeFile(file, '{"type":"span","schema_version":1,"trace_id":"t","span_id":"s"}\n');
    const old = new Date("2026-05-08T00:00:00.000Z");
    await utimes(file, old, old);
  }
}

function makeUploader(machineDir: string, captured: CapturedSpan[], opts: Record<string, unknown> = {}) {
  return new DaemonTraceBundleUploader({
    machineDir,
    serverUrl: "https://server.test",
    apiKey: "sk_machine_test",
    workerUrl: "https://worker.test/",
    minFileAgeMs: 0,
    tracer: capturingTracer(captured),
    fetchImpl: okFetch(),
    ...opts,
  } as never);
}

test("#408 a pass that finds nothing still emits a span — zero is not the same as never running", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-408-zero-"));
  try {
    await mkdir(path.join(machineDir, "traces"), { recursive: true });
    const captured: CapturedSpan[] = [];
    await makeUploader(machineDir, captured).uploadOnce("interval");

    const pass = captured.find((s) => s.name === "daemon.bundle.upload_pass");
    assert.ok(pass, "an empty pass must still be reported");
    assert.equal(pass.attrs.candidates, 0);
    assert.equal(pass.attrs.uploaded, 0);
    assert.equal(pass.attrs.readdir_failed, false, "an empty directory is not a read failure");
    assert.equal(pass.status, "ok");
    assert.equal(pass.attrs.upload_trigger, "interval");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#408 an unreadable trace directory is distinguishable from an empty one", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-408-unreadable-"));
  const traceDir = path.join(machineDir, "traces");
  try {
    await mkdir(traceDir, { recursive: true });
    await chmod(traceDir, 0o000);

    const captured: CapturedSpan[] = [];
    await makeUploader(machineDir, captured).uploadOnce();

    const pass = captured.find((s) => s.name === "daemon.bundle.upload_pass");
    assert.ok(pass);
    assert.equal(pass.attrs.candidates, 0, "same zero as a healthy idle machine…");
    assert.equal(pass.attrs.readdir_failed, true, "…but the cause is now recorded");
    assert.equal(pass.status, "error");
  } finally {
    await chmod(traceDir, 0o700).catch(() => undefined);
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#408 the pass span counts candidates, uploads and failures", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-408-counts-"));
  try {
    const traceDir = path.join(machineDir, "traces");
    await mkdir(traceDir, { recursive: true });
    await seed(traceDir, 3);

    const captured: CapturedSpan[] = [];
    await makeUploader(machineDir, captured).uploadOnce();

    const pass = captured.find((s) => s.name === "daemon.bundle.upload_pass");
    assert.ok(pass);
    assert.equal(pass.attrs.candidates, 3);
    assert.equal(pass.attrs.uploaded, 3);
    assert.equal(pass.attrs.failed, 0);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#408 failures are counted on the pass, not hidden by the per-file spans", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-408-failed-"));
  try {
    const traceDir = path.join(machineDir, "traces");
    await mkdir(traceDir, { recursive: true });
    await seed(traceDir, 2);

    const captured: CapturedSpan[] = [];
    await makeUploader(machineDir, captured, { fetchImpl: okFetch(true) }).uploadOnce();

    const pass = captured.find((s) => s.name === "daemon.bundle.upload_pass");
    assert.ok(pass);
    assert.equal(pass.attrs.candidates, 2);
    assert.equal(pass.attrs.uploaded, 0);
    assert.equal(pass.attrs.failed, 2, "a pass where every upload failed must say so in one place");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#408 files beyond the per-run cap are reported as deferred, not as failures", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-408-cap-"));
  try {
    const traceDir = path.join(machineDir, "traces");
    await mkdir(traceDir, { recursive: true });
    await seed(traceDir, 5);

    const captured: CapturedSpan[] = [];
    await makeUploader(machineDir, captured, { maxFilesPerRun: 2 }).uploadOnce();

    const pass = captured.find((s) => s.name === "daemon.bundle.upload_pass");
    assert.ok(pass);
    assert.equal(pass.attrs.candidates, 5);
    assert.equal(pass.attrs.considered, 2);
    assert.equal(pass.attrs.uploaded, 2);
    assert.equal(pass.attrs.failed, 0, "the untried files are not failures");
    assert.equal(pass.attrs.deferred, 3, "a backlog is visible rather than looking like success");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

// @Stone: if anything in the pass throws, the span must still be ended —
// an unended span is no record, which is the same "never ran" appearance this
// span exists to remove. Today the inner calls swallow their own failures, but
// that is a convention, and a diagnostic should not rest on one.
test("#408 a pass that throws still leaves a span behind", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-408-throw-"));
  try {
    await mkdir(path.join(machineDir, "traces"), { recursive: true });
    const captured: CapturedSpan[] = [];
    const uploader = makeUploader(machineDir, captured, {
      sinkReportProvider: {
        drain: () => {
          throw new TypeError("simulated pass failure");
        },
        noteUndelivered: () => {},
      },
    });

    await assert.rejects(
      () => uploader.uploadOnce(),
      /simulated pass failure/,
      "the exception must still propagate — this is a record, not a swallow",
    );

    const pass = captured.find((s) => s.name === "daemon.bundle.upload_pass");
    assert.ok(pass, "the pass must be recorded even when it threw");
    assert.equal(pass.status, "error");
    assert.equal(pass.attrs.pass_exception_class, "TypeError");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});
