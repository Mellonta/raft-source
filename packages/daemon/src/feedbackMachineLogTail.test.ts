import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES, PEM_PRIVATE_KEY_BEGIN } from "../../shared/src/test/diagnosticRedactionCredentialSamples";
import { boundAndRedactLogTail, collectFeedbackMachineLogTailAttachment, redactLogTailText } from "./feedbackMachineLogTail";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "feedback-log-tail-"));
  dirs.push(dir);
  return dir;
}

interface Captured {
  metadata: Record<string, unknown> | null;
  uploaded: string | null;
}

function harness(paths: string[], limits?: { maxBytes?: number; maxLines?: number; maxLineChars?: number }) {
  const captured: Captured = { metadata: null, uploaded: null };
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body;
    if (url.includes("/internal/machine/scope-attestation")) {
      const parsed = JSON.parse(String(body)) as { metadata: Record<string, unknown> };
      captured.metadata = parsed.metadata;
      return new Response(JSON.stringify({
        attestation: "signed", scope: "daemon-trace-bundle:create", audience: "trace-ingest-worker",
        resource: "servers/s/machines/m/trace-bundles",
        metadata: { ...parsed.metadata, uploadId: "upload-1", objectKey: "k" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/api/trace-bundles")) {
      return new Response(JSON.stringify({ id: "bundle-tail-1", upload: { url: "https://worker.test/put", method: "PUT", headers: {} } }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const blob = body as Blob;
    captured.uploaded = gunzipSync(Buffer.from(await blob.arrayBuffer())).toString("utf8");
    return new Response("", { status: 200 });
  };
  const run = (workerUrl: string | null = "https://worker.test") => collectFeedbackMachineLogTailAttachment({
    agentId: "agent-1",
    feedbackReportId: "report-1",
    window: WINDOW,
    source: { paths },
    serverUrl: "https://server.test",
    daemonApiKey: "key",
    workerUrl,
    tracer: new BasicTracer({ sink: new MemoryTraceSink() }),
    fetchImpl: fetchImpl as never,
    limits,
  });
  return { run, captured };
}

const WINDOW = { from: "2026-09-15T11:45:00.000Z", to: "2026-09-15T12:00:00.000Z" };
const PEM_BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
// Built at runtime so secret scanners don't flag this test sample.
const PEM_BLOCK = `${PEM_PRIVATE_KEY_BEGIN}\n${PEM_BODY}\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n-----END PRIVATE KEY-----`;
const URL_MARKER = "https://synthetic-host.example.test/private/path/segment?token=abc#frag";

describe("feedback machine log tail (tier 2)", () => {
  test("uploads the redacted, window-filtered tail of the first readable candidate; other agents' lines kept; kind and bounds attested", async () => {
    const dir = await tempDir();
    const missing = path.join(dir, "runner.log");
    const legacy = path.join(dir, "server-runner.log");
    // Real newlines throughout: the PEM block spans lines exactly as a runner
    // log would carry it, and the credential samples keep their own newlines.
    const inWindow = [
      "2026-09-15T11:50:00.000Z [INFO] [Daemon] agent agent-1 started",
      "2026-09-15T11:51:00.000Z [WARN] [Daemon] agent agent-2 wake failed: provider_timeout",
      `2026-09-15T11:52:00.000Z [INFO] dumped key ${PEM_BLOCK}`,
      `2026-09-15T11:53:00.000Z [INFO] fetch ${URL_MARKER} failed`,
      ...DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES.map((s) => `2026-09-15T11:54:00.000Z [INFO] ${s.sample}`),
    ];
    const before = "2026-09-15T11:30:00.000Z [INFO] before-window line about agent-1";
    const after = "2026-09-15T12:05:00.000Z [INFO] after-window line about agent-1";
    await writeFile(legacy, `${[before, ...inWindow, after].join("\n")}\n`);
    const { run, captured } = harness([missing, legacy]);
    const result = await run();
    assert.equal(result.reachable, true);
    assert.equal(result.traceBundleId, "bundle-tail-1");
    assert.equal(result.truncated, false);
    const uploaded = captured.uploaded!;
    // Machine-wide: the other agent's line is present, not filtered out.
    assert.ok(uploaded.includes("agent agent-2 wake failed"));
    // Window applied to CONTENT, not only attested.
    assert.ok(!uploaded.includes("before-window line"), "line before the window must not upload");
    assert.ok(!uploaded.includes("after-window line"), "line after the window must not upload");
    // Multi-line PEM masked even though the file was carried line by line.
    assert.ok(!uploaded.includes(PEM_BODY), "PEM body leaked");
    assert.ok(!uploaded.includes(PEM_PRIVATE_KEY_BEGIN));
    // Whole URL dropped: no host, path, query or fragment survives.
    for (const fragment of ["synthetic-host", "/private/path", "token=abc", "#frag"]) {
      assert.ok(!uploaded.includes(fragment), `URL part leaked: ${fragment}`);
    }
    assert.ok(uploaded.includes("fetch [url] failed"));
    for (const { label, mustNotContain } of DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES) {
      assert.ok(!uploaded.includes(mustNotContain), `${label} leaked into the uploaded tail`);
    }
    assert.equal(captured.metadata?.feedbackAttachmentKind, "machine_log_tail");
    assert.equal(captured.metadata?.feedbackMachineLogTailIncludesOtherAgents, "true");
    assert.equal(captured.metadata?.feedbackMachineLogTailLinesOutsideWindow, 2);
    assert.equal(captured.metadata?.feedbackMachineLogTailUndatedLines, 0);
    assert.equal(captured.metadata?.feedbackMachineLogTailTruncated, "false");
    assert.equal(captured.metadata?.feedbackReportWindowStartAt, WINDOW.from);
    assert.equal(captured.metadata?.feedbackReportGeneratedAt, WINDOW.to);
    assert.equal(captured.metadata?.bundleContentType, "text/plain");
  });

  test("continuation lines follow the previous dated line; undated lines with nothing to inherit are dropped and counted", () => {
    const text = [
      "orphan continuation with no date",
      "2026-09-15T11:40:00.000Z [ERROR] outside, then its stack",
      "    at outsideFrame (file.js:1:1)",
      "2026-09-15T11:50:00.000Z [ERROR] inside, then its stack",
      "    at insideFrame (file.js:2:2)",
      '{"json":"dump continues inside"}',
      "2026-09-15T12:10:00.000Z [INFO] outside again",
    ].join("\n");
    const out = boundAndRedactLogTail(text, { maxLines: 100, maxLineChars: 2000 }, WINDOW);
    assert.deepEqual(out.lines, [
      "2026-09-15T11:50:00.000Z [ERROR] inside, then its stack",
      "    at insideFrame (file.js:2:2)",
      '{"json":"dump continues inside"}',
    ]);
    assert.equal(out.linesOutsideWindow, 3);
    assert.equal(out.undatedLines, 1);
    assert.equal(out.sourceLineCount, 7);
  });

  test("a PEM block cut by the byte cap (orphan END) or the line cap (orphan BEGIN) is still masked", async () => {
    // Byte cap lands inside the block: the read starts mid-key, so only the
    // tail of the body and the END marker are present.
    const cutHead = `${PEM_BODY}\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n-----END PRIVATE KEY-----\n2026-09-15T11:55:00.000Z [INFO] after key`;
    const redactedHead = redactLogTailText(cutHead);
    assert.ok(!redactedHead.includes(PEM_BODY), `orphan END leaked: ${redactedHead}`);
    assert.ok(redactedHead.includes("after key"));
    // Line/byte end lands inside the block: BEGIN present, END missing.
    const cutTail = `2026-09-15T11:55:00.000Z [INFO] key follows\n${PEM_PRIVATE_KEY_BEGIN}\n${PEM_BODY}`;
    const redactedTail = redactLogTailText(cutTail);
    assert.ok(!redactedTail.includes(PEM_BODY), `orphan BEGIN leaked: ${redactedTail}`);
    assert.ok(redactedTail.includes("key follows"));

    // End to end through the byte-capped file read.
    const dir = await tempDir();
    const file = path.join(dir, "runner.log");
    const filler = Array.from({ length: 20 }, (_, i) => `2026-09-15T11:50:00.000Z [INFO] filler ${i} ${"x".repeat(40)}`).join("\n");
    const tail = `2026-09-15T11:56:00.000Z [INFO] dumped ${PEM_BLOCK}\n2026-09-15T11:57:00.000Z [INFO] last line`;
    await writeFile(file, `${filler}\n${tail}\n`);
    // Cap so the read begins inside the PEM block.
    const bodyOffsetFromEnd = Buffer.byteLength(`${PEM_BODY}\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n-----END PRIVATE KEY-----\n2026-09-15T11:57:00.000Z [INFO] last line\n`) - 10;
    const { run, captured } = harness([file], { maxBytes: bodyOffsetFromEnd });
    const result = await run();
    assert.equal(result.reachable, true);
    assert.equal(result.truncated, true);
    assert.ok(!captured.uploaded!.includes(PEM_BODY.slice(-20)), `PEM tail leaked through byte cap: ${captured.uploaded}`);
    assert.ok(captured.uploaded!.includes("last line"));
  });

  test("bounds by lines after filtering, drops the partial first line, and reports truncation", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "runner.log");
    const body = Array.from({ length: 50 }, (_, i) => `2026-09-15T11:50:${String(i).padStart(2, "0")}.000Z line-${String(i).padStart(3, "0")} ${"x".repeat(20)}`).join("\n") + "\n";
    await writeFile(file, body);
    const { run, captured } = harness([file], { maxBytes: 600, maxLines: 5 });
    const result = await run();
    assert.equal(result.reachable, true);
    assert.equal(result.truncated, true);
    assert.equal(result.lineCount, 5);
    const uploaded = captured.uploaded!.trimEnd().split("\n");
    assert.equal(uploaded.length, 5);
    assert.match(uploaded.at(-1)!, /line-049 x{20}$/);
    for (const line of uploaded) assert.match(line, /^2026-09-15T11:50:\d{2}\.000Z line-\d{3} x{20}$/, "no partial line survives the byte cut");
    assert.equal(captured.metadata?.feedbackMachineLogTailTruncated, "true");
  });

  test("no readable candidate → reachable:false, nothing uploaded; symlinks are not followed", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "real.log");
    await writeFile(target, "2026-09-15T11:50:00.000Z secret line\n");
    const link = path.join(dir, "runner.log");
    await symlink(target, link);
    const { run, captured } = harness([path.join(dir, "absent.log"), link]);
    const result = await run();
    assert.equal(result.reachable, false);
    assert.equal(captured.uploaded, null);
    assert.equal(captured.metadata, null);
  });

  test("missing worker URL is a typed fallback, not an upload", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "runner.log");
    await writeFile(file, "2026-09-15T11:50:00.000Z a\n2026-09-15T11:51:00.000Z b\n");
    const { run, captured } = harness([file]);
    const result = await run(null);
    assert.equal(result.reachable, true);
    assert.equal(result.fallbackReason, "daemon worker URL is not configured");
    assert.equal(captured.uploaded, null);
  });

  test("boundAndRedactLogTail caps line length after redaction and passes everything through without a window", () => {
    const out = boundAndRedactLogTail(`short\n${"y".repeat(50)}\n`, { maxLines: 10, maxLineChars: 10 });
    assert.deepEqual(out.lines, ["short", `${"y".repeat(10)}...[truncated]`]);
    assert.equal(out.sourceLineCount, 2);
    assert.equal(out.truncatedByLines, false);
  });
});
