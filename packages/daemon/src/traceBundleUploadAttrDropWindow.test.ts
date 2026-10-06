import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BasicTracer } from "@botiverse/raft-shared";
import { LocalRotatingTraceSink } from "@botiverse/raft-trace-client";
import { DaemonTraceBundleUploader } from "./traceBundleUpload";

// Task #422 — the window reset is only real if the PRODUCTION path drains it.
// The first version of this fix had `drainAttrDropReport()` called by nothing
// but its own tests, so the daemon kept reading the never-cleared table and
// behaved exactly as before (@Stone). These tests therefore drive a real
// DaemonTraceBundleUploader against a real sink and read the span attrs it
// produces, rather than calling drain directly.

interface CapturedSpan {
  name: string;
  attrs: Record<string, unknown>;
}

function capturingTracer(captured: CapturedSpan[], inner: BasicTracer) {
  return {
    startSpan(name: string, options: { attrs?: Record<string, unknown>; surface?: string; kind?: string }) {
      const entry: CapturedSpan = { name, attrs: { ...(options.attrs ?? {}) } };
      captured.push(entry);
      const span = inner.startSpan(name, options as never);
      return {
        end(status?: string, endOptions?: { attrs?: Record<string, unknown> }) {
          Object.assign(entry.attrs, endOptions?.attrs ?? {});
          span.end(status as never, endOptions as never);
        },
        addEvent(eventName: string, attrs?: Record<string, unknown>) {
          span.addEvent(eventName, attrs as never);
        },
        setAttributes() {},
      };
    },
  } as never;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function seedCandidate(traceDir: string, suffix: string): Promise<void> {
  const file = path.join(traceDir, `daemon-trace-2026-09-19T05-00-0${suffix}-000Z-1-000${suffix}.jsonl`);
  await writeFile(file, '{"type":"span","schema_version":1,"trace_id":"t","span_id":"s"}\n');
  const old = new Date("2026-05-08T00:00:00.000Z");
  await utimes(file, old, old);
}

test("#422 the window drains through the real uploader: a key seen after pass 1 appears only in pass 2", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-422-pass-"));
  try {
    const traceDir = path.join(machineDir, "traces");
    await mkdir(traceDir, { recursive: true });

    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 16 });
    const inner = new BasicTracer({ sink });
    const captured: CapturedSpan[] = [];

    const uploader = new DaemonTraceBundleUploader({
      machineDir,
      serverUrl: "https://server.test",
      apiKey: "sk_machine_test",
      workerUrl: "https://worker.test/",
      minFileAgeMs: 0,
      tracer: capturingTracer(captured, inner),
      sinkReportProvider: {
        drain: () => sink.drainSinkReport(),
        noteUndelivered: () => sink.noteAttrDropReportUndelivered(),
      },
      fetchImpl: (async (url: string) => {
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
      }) as never,
    });

    // Window 1: drop `first_pass_id`, then upload.
    inner.startSpan("daemon.w1", { surface: "daemon", kind: "internal", attrs: { first_pass_id: "x" } as never }).end("ok");
    await seedCandidate(traceDir, "1");
    await uploader.uploadOnce();

    // The report belongs to the PASS, so it rides the pass span — one per
    // uploadOnce() — rather than an arbitrary file's span.
    const carrying = () =>
      captured.filter((s) => s.name === "daemon.bundle.upload_pass" && s.attrs.sink_attrs_dropped_window !== undefined);
    const pass1 = carrying().at(-1);
    assert.ok(pass1, "pass 1 must have produced an upload span carrying the report");
    assert.equal(pass1.attrs.sink_attrs_dropped_window_names, "first_pass_id");

    // Window 2: a different key.
    inner.startSpan("daemon.w2", { surface: "daemon", kind: "internal", attrs: { second_pass_id: "y" } as never }).end("ok");
    await seedCandidate(traceDir, "2");
    await uploader.uploadOnce();

    const pass2 = carrying().at(-1);
    assert.ok(pass2 && pass2 !== pass1, "pass 2 must have produced its own upload span");
    assert.equal(
      pass2.attrs.sink_attrs_dropped_window_names,
      "second_pass_id",
      "pass 2 reports only its own window",
    );
    assert.ok(
      !String(pass1.attrs.sink_attrs_dropped_window_names).includes("second_pass_id"),
      "reverse: pass 1 cannot contain a key that was only dropped afterwards",
    );
    // Cumulative keeps both.
    assert.equal(pass2.attrs.sink_attrs_dropped_cumulative, 2);
    assert.equal(pass2.attrs.sink_attrs_dropped_window, 1);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#422 a pass whose uploads all fail still reports its window, and does not replay it", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-422-undeliv-"));
  try {
    const traceDir = path.join(machineDir, "traces");
    await mkdir(traceDir, { recursive: true });

    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 16 });
    const inner = new BasicTracer({ sink });
    const captured: CapturedSpan[] = [];
    let failUploads = true;

    const uploader = new DaemonTraceBundleUploader({
      machineDir,
      serverUrl: "https://server.test",
      apiKey: "sk_machine_test",
      workerUrl: "https://worker.test/",
      minFileAgeMs: 0,
      tracer: capturingTracer(captured, inner),
      sinkReportProvider: {
        drain: () => sink.drainSinkReport(),
        noteUndelivered: () => sink.noteAttrDropReportUndelivered(),
      },
      fetchImpl: (async (url: string) => {
        if (failUploads) return jsonResponse({ error: "nope" }, 500);
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
      }) as never,
    });

    inner.startSpan("daemon.lost", { surface: "daemon", kind: "internal", attrs: { lost_window_id: "x" } as never }).end("ok");
    await seedCandidate(traceDir, "1");
    await uploader.uploadOnce();

    // Moving the report onto the pass span changed this case: the pass span is
    // emitted whether or not any upload succeeds, so the window IS reported
    // even when every upload fails. It is recorded locally like any other span
    // and travels with the next bundle.
    const failedPass = captured
      .filter((s) => s.name === "daemon.bundle.upload_pass" && s.attrs.sink_attrs_dropped_window !== undefined)
      .at(-1);
    assert.ok(failedPass, "a failing pass still reports its window");
    assert.equal(failedPass.attrs.sink_attrs_dropped_window_names, "lost_window_id");
    assert.equal(failedPass.attrs.uploaded, 0, "…even though nothing was uploaded");

    // And the window still advanced: the next pass reports only its own names.
    failUploads = false;
    inner.startSpan("daemon.next", { surface: "daemon", kind: "internal", attrs: { next_window_id: "y" } as never }).end("ok");
    await seedCandidate(traceDir, "2");
    await uploader.uploadOnce();

    const nextPass = captured
      .filter((s) => s.name === "daemon.bundle.upload_pass" && s.attrs.sink_attrs_dropped_window !== undefined)
      .at(-1);
    assert.ok(nextPass && nextPass !== failedPass);
    assert.equal(
      nextPass.attrs.sink_attrs_dropped_window_names,
      "next_window_id",
      "a name belongs to exactly one window; the previous one is not replayed",
    );
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});
