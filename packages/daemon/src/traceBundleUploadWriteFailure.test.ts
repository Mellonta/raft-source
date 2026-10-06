import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DaemonTraceBundleUploader } from "./traceBundleUpload";

// Task #419 — the sink cannot report its own write failures through a span,
// because it is the span writer. The counts ride out on the next upload that
// does succeed, so this covers that hand-off in both directions.

const EMPTY_ATTR_DROPS = {
  windowByReason: {},
  windowNames: {},
  windowNamesFull: false,
  cumulativeByReason: {},
  reportsUndelivered: 0,
  prunedNames: [],
  prunedNamesOverflow: 0,
  prunedTotal: 0,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

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

async function runUpload(statsProvider: (() => unknown) | undefined): Promise<CapturedSpan[]> {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-419-upload-"));
  try {
    const traceDir = path.join(machineDir, "traces");
    await mkdir(traceDir, { recursive: true });
    const closedFile = path.join(traceDir, "daemon-trace-2026-09-19T05-00-00-000Z-1-0000.jsonl");
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
      sinkReportProvider: {
        drain: () => {
          const writeFailures = (statsProvider as (() => unknown) | undefined)?.();
          return writeFailures
            ? { writeFailures, attrDrops: EMPTY_ATTR_DROPS } as never
            : null;
        },
        noteUndelivered: () => {},
      },
      fetchImpl: (async (url: string) => {
        if (String(url).includes("/api/trace-bundles")) {
          return jsonResponse({
            uploadId: "upload-1",
            uploadUrl: "https://worker.test/object",
            token: "tok",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        }
        return jsonResponse({ ok: true });
      }) as never,
    });

    await uploader.uploadOnce();
    return captured;
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
}

test("#419 sink write failures are surfaced as bounded attrs on the upload span", async () => {
  const captured = await runUpload(() => ({
    total: 3,
    lastCode: "ENOSPC",
    lastOutcome: "append_partial_truncated",
    rollbacks: 2,
    rotations: 1,
  }));

  const span = captured.find((entry) => entry.name === "daemon.bundle.upload_pass");
  assert.ok(span, "the upload span must be started");
  assert.equal(span.attrs.sink_write_failures, 3);
  assert.equal(span.attrs.sink_write_truncated, 2);
  assert.equal(span.attrs.sink_write_rotated, 1);
  assert.equal(span.attrs.sink_write_last_error_code, "ENOSPC");
  assert.equal(span.attrs.sink_write_last_outcome, "append_partial_truncated");
});

test("#419 a healthy sink adds no write-failure attrs at all", async () => {
  for (const provider of [
    undefined,
    () => null,
    () => ({ total: 0, lastCode: null, lastOutcome: null, rollbacks: 0, rotations: 0 }),
  ]) {
    const captured = await runUpload(provider as never);
    const span = captured.find((entry) => entry.name === "daemon.bundle.upload_pass");
    assert.ok(span, "the upload span must be started");
    for (const key of Object.keys(span.attrs)) {
      assert.ok(!key.startsWith("sink_write_"), `unexpected attr ${key} on a healthy sink`);
    }
  }
});

