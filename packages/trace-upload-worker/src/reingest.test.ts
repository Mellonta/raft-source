import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  parseCandidatesJson,
  parseManifestJson,
  reingestCandidates,
} from "./reingest";
import type { TraceUploadWorkerEnv } from "./env";
import { traceIngestSpanKey } from "./traces/otlp";

class MockR2Bucket {
  puts: Array<{ key: string; body: ArrayBuffer | string; options?: Record<string, unknown> }> = [];

  async put(key: string, value: ArrayBuffer | string, options?: Record<string, unknown>) {
    this.puts.push({ key, body: value, options });
    return { etag: "mock-etag" };
  }

  async get(key: string) {
    for (let idx = this.puts.length - 1; idx >= 0; idx -= 1) {
      if (this.puts[idx].key === key) {
        const put = this.puts[idx];
        return {
          body: new Response(put.body as BodyInit).body,
          httpMetadata: put.options?.httpMetadata,
          customMetadata: put.options?.customMetadata,
        };
      }
    }
    return null;
  }
}

function sha256Hex(body: Buffer | Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function eventRecord(name: string, spanId = "aaaaaaaaaaaaaaaa") {
  return {
    type: "event",
    schema_version: 1,
    trace_id: "0123456789abcdef0123456789abcdef",
    span_id: spanId,
    name,
    surface: "daemon",
    time: "2026-09-29T11:00:00.005Z",
    attrs: {},
  };
}

function spanRecord(spanId: string) {
  return {
    type: "span",
    schema_version: 1,
    trace_id: "0123456789abcdef0123456789abcdef",
    span_id: spanId,
    parent_span_id: null,
    name: "daemon.agent.delivery.routed",
    surface: "daemon",
    kind: "internal",
    status: "ok",
    start_time: "2026-09-29T11:00:00.000Z",
    end_time: "2026-09-29T11:00:00.012Z",
    duration_ms: 12,
    attrs: { serverId: "server-1", machineId: "machine-1" },
  };
}

type Fixture = {
  uploadId: string;
  ledgerKey: string;
  objectKey: string;
  bundleSha256: string;
  spanIds: string[];
};

/** Builds a bundle + ledger pair in the bucket; returns the identifiers. */
function makeFixture(bucket: MockR2Bucket, uploadId: string, spanIds: string[], ledgerStatus: string, eventMessages: string[] = []): Fixture {
  const lines = [
    ...spanIds.map((id) => JSON.stringify(spanRecord(id))),
    ...eventMessages.map((m) => JSON.stringify(eventRecord(m))),
  ];
  const bundle = Buffer.from(lines.join("\n") + "\n");
  const bundleSha256 = sha256Hex(bundle);
  const objectKey = `trace-bundles/server-1/machine-1/${uploadId}.jsonl`;
  const ledgerKey = `trace-ledgers/server-1/machine-1/${uploadId}.json`;
  bucket.puts.push({
    key: objectKey,
    body: bufferToArrayBuffer(bundle),
    options: { httpMetadata: { contentType: "application/x-ndjson" } },
  });
  bucket.puts.push({
    key: ledgerKey,
    body: JSON.stringify({
      type: "daemon_trace_upload",
      schema_version: 1,
      upload_id: uploadId,
      bundle_id: `bundle-${uploadId}`,
      object_key: objectKey,
      ledger_key: ledgerKey,
      bundle_sha256: bundleSha256,
      bundle_size_bytes: bundle.byteLength,
      server_id: "server-1",
      machine_id: "machine-1",
      r2_status: "success",
      scopedb_status: ledgerStatus,
    }),
  });
  return { uploadId, ledgerKey, objectKey, bundleSha256, spanIds };
}

function bufferToArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function baseEnv() {
  const bucket = new MockR2Bucket();
  const postedSpanKeys: string[] = [];
  const postedLogs: string[] = [];
  const env: TraceUploadWorkerEnv = {
    SCOPE_ATTESTATION_SECRET: "test-secret",
    TRACE_BUNDLES: bucket as unknown as TraceUploadWorkerEnv["TRACE_BUNDLES"],
    TRACE_INGEST_OTLP_ENDPOINT: "https://telescope.test/v1/traces",
    TRACE_INGEST_FETCH: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(init?.body as string);
      for (const rl of payload.resourceLogs ?? []) {
        for (const sl of rl.scopeLogs ?? []) {
          postedLogs.push(...(sl.logRecords ?? []).map((r: Record<string, unknown>) => JSON.stringify(r)));
        }
      }
      for (const rs of payload.resourceSpans ?? []) {
        for (const ss of rs.scopeSpans ?? []) {
          for (const span of ss.spans ?? []) {
            const attr = (span.attributes ?? []).find(
              (a: { key: string }) => a.key === "slock.trace_ingest.span_key",
            );
            postedSpanKeys.push(attr?.value?.stringValue ?? "");
          }
        }
      }
      return new Response(null, { status: 200 });
    },
  } as TraceUploadWorkerEnv;
  return { env, bucket, postedSpanKeys, postedLogs };
}

function ledgerPuts(bucket: MockR2Bucket, uploadId: string) {
  return bucket.puts.filter((p) => p.key.includes(uploadId) && p.key.startsWith("trace-ledgers/"));
}

test("reingest: zero group replays every span and marks the ledger success", async () => {
  const { env, bucket, postedSpanKeys } = baseEnv();
  const fx = makeFixture(bucket, "up-zero", ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"], "pending");
  const manifest = { entries: { "up-zero": { group: "zero" as const, row_count: 0 } } };

  const { outcomes, failures } = await reingestCandidates(
    env,
    [{ upload_id: fx.uploadId, ledger_key: fx.ledgerKey }],
    manifest,
    false,
  );

  assert.equal(failures, 0);
  assert.equal(outcomes[0].action, "replayed");
  assert.equal(outcomes[0].spans_written, 2);
  assert.equal(postedSpanKeys.length, 2);
  assert.ok(postedSpanKeys.every((k) => k.startsWith(`server-1:machine-1:${fx.bundleSha256}:`)));
  const ledgers = ledgerPuts(bucket, fx.uploadId);
  assert.equal(ledgers.length, 2); // fixture seed + the run's success write
  const ledger = JSON.parse(ledgers.at(-1)!.body as string);
  assert.equal(ledger.scopedb_status, "success");
  assert.equal(ledger.spans_ingested, 2);
});

test("reingest: partial group writes exactly the missing spans (per-span_key dedup)", async () => {
  const { env, bucket, postedSpanKeys } = baseEnv();
  const fx = makeFixture(bucket, "up-partial", ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc"], "pending");
  const existing = [
    traceIngestSpanKey(
      { serverId: "server-1", machineId: "machine-1", bundleSha256: fx.bundleSha256 },
      spanRecord("aaaaaaaaaaaaaaaa") as never,
    ),
  ];
  const manifest = {
    entries: { "up-partial": { group: "partial" as const, row_count: 1, existing_span_keys: existing } },
  };

  const { outcomes, failures } = await reingestCandidates(
    env,
    [{ upload_id: fx.uploadId, ledger_key: fx.ledgerKey }],
    manifest,
    false,
  );

  assert.equal(failures, 0);
  assert.equal(outcomes[0].action, "replayed_partial");
  assert.equal(outcomes[0].spans_written, 2);
  assert.equal(postedSpanKeys.length, 2);
  assert.ok(!postedSpanKeys.includes(existing[0]));
  assert.equal(outcomes[0].expected_spans, 3);
});

test("reingest: complete group with pending ledger only rewrites the ledger", async () => {
  const { env, bucket, postedSpanKeys } = baseEnv();
  const fx = makeFixture(bucket, "up-complete", ["aaaaaaaaaaaaaaaa"], "pending");
  const manifest = { entries: { "up-complete": { group: "complete" as const, row_count: 1 } } };

  const { outcomes } = await reingestCandidates(
    env,
    [{ upload_id: fx.uploadId, ledger_key: fx.ledgerKey }],
    manifest,
    false,
  );

  assert.equal(outcomes[0].action, "ledger_fixed");
  assert.equal(postedSpanKeys.length, 0);
  const ledgers = ledgerPuts(bucket, fx.uploadId);
  assert.equal(ledgers.length, 2); // fixture seed + the ledger-only fix
  assert.equal(JSON.parse(ledgers.at(-1)!.body as string).scopedb_status, "success");
});

test("reingest: complete group with success ledger writes nothing", async () => {
  const { env, bucket, postedSpanKeys } = baseEnv();
  const fx = makeFixture(bucket, "up-healthy", ["aaaaaaaaaaaaaaaa"], "success");
  const manifest = { entries: { "up-healthy": { group: "complete" as const, row_count: 1 } } };
  const putsBefore = bucket.puts.length;

  const { outcomes } = await reingestCandidates(
    env,
    [{ upload_id: fx.uploadId, ledger_key: fx.ledgerKey }],
    manifest,
    false,
  );

  assert.equal(outcomes[0].action, "no_action");
  assert.equal(postedSpanKeys.length, 0);
  assert.equal(bucket.puts.length, putsBefore);
});

test("reingest: sha pin mismatch skips and reports without writing", async () => {
  const { env, bucket, postedSpanKeys } = baseEnv();
  const fx = makeFixture(bucket, "up-tampered", ["aaaaaaaaaaaaaaaa"], "pending");
  // Tamper: replace the bundle object with different content after pinning.
  bucket.puts.push({ key: fx.objectKey, body: bufferToArrayBuffer(Buffer.from("tampered\n")) });
  const manifest = { entries: { "up-tampered": { group: "zero" as const, row_count: 0 } } };
  const putsBefore = bucket.puts.length;

  const { outcomes, failures } = await reingestCandidates(
    env,
    [{ upload_id: fx.uploadId, ledger_key: fx.ledgerKey }],
    manifest,
    false,
  );

  assert.equal(failures, 0);
  assert.equal(outcomes[0].action, "skipped_sha_mismatch");
  assert.equal(postedSpanKeys.length, 0);
  assert.equal(bucket.puts.length, putsBefore);
});

test("reingest: candidates flagged as lacking span_key are listed, never replayed", async () => {
  const { env, bucket, postedSpanKeys } = baseEnv();
  const fx = makeFixture(bucket, "up-legacy", ["aaaaaaaaaaaaaaaa"], "pending");
  const manifest = {
    entries: { "up-legacy": { group: "partial" as const, row_count: 1, existing_rows_lack_span_key: true } },
  };

  const { outcomes, failures } = await reingestCandidates(
    env,
    [{ upload_id: fx.uploadId, ledger_key: fx.ledgerKey }],
    manifest,
    false,
  );

  assert.equal(failures, 0);
  assert.equal(outcomes[0].action, "skipped_no_span_key");
  assert.equal(postedSpanKeys.length, 0);
});

test("reingest: live run skips candidates missing from the manifest", async () => {
  const { env, bucket, postedSpanKeys } = baseEnv();
  const fx = makeFixture(bucket, "up-unknown", ["aaaaaaaaaaaaaaaa"], "pending");

  const { outcomes } = await reingestCandidates(
    env,
    [{ upload_id: fx.uploadId, ledger_key: fx.ledgerKey }],
    { entries: {} },
    false,
  );

  assert.equal(outcomes[0].action, "skipped_unclassified");
  assert.equal(postedSpanKeys.length, 0);
});

test("reingest: dry-run reports expected_spans and writes nothing", async () => {
  const { env, bucket, postedSpanKeys } = baseEnv();
  const fx = makeFixture(bucket, "up-dry", ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"], "pending");
  const putsBefore = bucket.puts.length;

  const { outcomes, failures } = await reingestCandidates(
    env,
    [{ upload_id: fx.uploadId, ledger_key: fx.ledgerKey }],
    undefined,
    true,
  );

  assert.equal(failures, 0);
  assert.equal(outcomes[0].action, "dry_run");
  assert.equal(outcomes[0].expected_spans, 2);
  assert.equal(postedSpanKeys.length, 0);
  assert.equal(bucket.puts.length, putsBefore);
});

test("reingest: second run over a regenerated manifest writes nothing (loop idempotency)", async () => {
  const { env, bucket, postedSpanKeys } = baseEnv();
  const fxZero = makeFixture(bucket, "up-r2-zero", ["aaaaaaaaaaaaaaaa"], "pending");
  const candidates = [{ upload_id: fxZero.uploadId, ledger_key: fxZero.ledgerKey }];

  const run1 = await reingestCandidates(env, candidates, {
    entries: { "up-r2-zero": { group: "zero", row_count: 0 } },
  }, false);
  assert.equal(run1.outcomes[0].action, "replayed");
  assert.equal(postedSpanKeys.length, 1);

  // The query seat re-classifies: ScopeDB now has the span, and the script's
  // own ledger write marked it success.
  const regenerated = { entries: { "up-r2-zero": { group: "complete" as const, row_count: 1 } } };
  const putsBefore = bucket.puts.length;
  const run2 = await reingestCandidates(env, candidates, regenerated, false);

  assert.equal(run2.outcomes[0].action, "no_action");
  assert.equal(postedSpanKeys.length, 1);
  assert.equal(bucket.puts.length, putsBefore);
});

test("reingest: input parsing rejects malformed candidates and manifests", () => {
  assert.throws(() => parseCandidatesJson("{}"), /JSON array/);
  assert.throws(() => parseCandidatesJson('[{"upload_id":1,"ledger_key":"x"}]'), /string upload_id/);
  assert.throws(() => parseManifestJson("[]"), /JSON object/);
  assert.throws(
    () => parseManifestJson('{"entries":{"a":{"group":"bogus","row_count":0}}}'),
    /invalid group/,
  );
});

// Gzip regression: bundles in R2 are gzip-encoded; the replay path must use
// the same decompression guards as live ingest.
test("reingest: gzipped bundles replay through the same guards", async () => {
  const { env, bucket, postedSpanKeys } = baseEnv();
  const uploadId = "up-gzip";
  const bundle = gzipSync(Buffer.from(JSON.stringify(spanRecord("aaaaaaaaaaaaaaaa")) + "\n"));
  const bundleSha256 = sha256Hex(bundle);
  const objectKey = `trace-bundles/server-1/machine-1/${uploadId}.jsonl.gz`;
  const ledgerKey = `trace-ledgers/server-1/machine-1/${uploadId}.json`;
  bucket.puts.push({
    key: objectKey,
    body: bufferToArrayBuffer(bundle),
    options: { httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" } },
  });
  bucket.puts.push({
    key: ledgerKey,
    body: JSON.stringify({
      upload_id: uploadId,
      bundle_id: `bundle-${uploadId}`,
      object_key: objectKey,
      bundle_sha256: bundleSha256,
      bundle_size_bytes: bundle.byteLength,
      server_id: "server-1",
      machine_id: "machine-1",
      scopedb_status: "pending",
    }),
  });

  const { outcomes, failures } = await reingestCandidates(
    env,
    [{ upload_id: uploadId, ledger_key: ledgerKey }],
    { entries: { [uploadId]: { group: "zero", row_count: 0 } } },
    false,
  );

  assert.equal(failures, 0);
  assert.equal(outcomes[0].action, "replayed");
  assert.equal(postedSpanKeys.length, 1);
});

test("reingest: zero group replays events together with spans (no silent drop)", async () => {
  const { env, bucket, postedSpanKeys, postedLogs } = baseEnv();
  const fx = makeFixture(bucket, "up-zero-events", ["aaaaaaaaaaaaaaaa"], "pending", ["daemon.event.one", "daemon.event.two"]);
  const manifest = { entries: { "up-zero-events": { group: "zero" as const, row_count: 0 } } };

  const { outcomes, failures } = await reingestCandidates(
    env,
    [{ upload_id: fx.uploadId, ledger_key: fx.ledgerKey }],
    manifest,
    false,
  );

  assert.equal(failures, 0);
  assert.equal(outcomes[0].action, "replayed");
  assert.equal(postedSpanKeys.length, 1);
  // Events ride the same replay: the log batch is posted, and the ledger
  // records them.
  assert.equal(postedLogs.length, 2);
  assert.ok(postedLogs.some((l) => l.includes("daemon.event.one")));
  const ledger = JSON.parse(ledgerPuts(bucket, fx.uploadId).at(-1)!.body as string);
  assert.equal(ledger.events_ingested, 2);
});

test("reingest: partial replay reports skipped events instead of dropping them silently", async () => {
  const { env, bucket, postedSpanKeys, postedLogs } = baseEnv();
  const fx = makeFixture(bucket, "up-partial-events", ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"], "pending", ["daemon.event.one"]);
  const existing = [
    traceIngestSpanKey(
      { serverId: "server-1", machineId: "machine-1", bundleSha256: fx.bundleSha256 },
      spanRecord("aaaaaaaaaaaaaaaa") as never,
    ),
  ];
  const manifest = {
    entries: { "up-partial-events": { group: "partial" as const, row_count: 1, existing_span_keys: existing } },
  };

  const { outcomes } = await reingestCandidates(
    env,
    [{ upload_id: fx.uploadId, ledger_key: fx.ledgerKey }],
    manifest,
    false,
  );

  assert.equal(outcomes[0].action, "replayed_partial");
  assert.equal(postedSpanKeys.length, 1);
  assert.equal(postedLogs.length, 0); // events skipped, not silently: reported
  assert.equal(outcomes[0].events_skipped, 1);
});

test("reingest: rerun with the SAME (stale) manifest writes nothing", async () => {
  const { env, bucket, postedSpanKeys } = baseEnv();
  const fx = makeFixture(bucket, "up-stale", ["aaaaaaaaaaaaaaaa"], "pending");
  const candidates = [{ upload_id: fx.uploadId, ledger_key: fx.ledgerKey }];
  const manifest = { entries: { "up-stale": { group: "zero" as const, row_count: 0 } } };

  const run1 = await reingestCandidates(env, candidates, manifest, false);
  assert.equal(run1.outcomes[0].action, "replayed");
  assert.equal(postedSpanKeys.length, 1);

  // Interrupted-run scenario: rerun with the unchanged manifest. The ledger
  // written by run 1 says success, so the rerun is a no-op.
  const putsBefore = bucket.puts.length;
  const run2 = await reingestCandidates(env, candidates, manifest, false);
  assert.equal(run2.outcomes[0].action, "no_action");
  assert.equal(postedSpanKeys.length, 1);
  assert.equal(bucket.puts.length, putsBefore);
});

test("reingest: manifest boundary validation rejects contradictory entries", () => {
  // zero with rows present
  assert.throws(
    () => parseManifestJson('{"entries":{"a":{"group":"zero","row_count":5}}}'),
    /row_count 0/,
  );
  // partial without keys would degrade into a full replay (duplicates)
  assert.throws(
    () => parseManifestJson('{"entries":{"a":{"group":"partial","row_count":2}}}'),
    /non-empty existing_span_keys/,
  );
  // partial whose keys do not cover the row count
  assert.throws(
    () => parseManifestJson('{"entries":{"a":{"group":"partial","row_count":2,"existing_span_keys":["k1"]}}}'),
    /length must equal row_count/,
  );
  // lack_span_key flag contradicts a zero classification
  assert.throws(
    () => parseManifestJson('{"entries":{"a":{"group":"zero","row_count":0,"existing_rows_lack_span_key":true}}}'),
    /contradicts group "zero"/,
  );
  // ...but a flagged entry needs no key list (none can be produced), on
  // partial or complete alike (Stone round 3: the flag would otherwise be
  // unusable — its entries can satisfy neither key rule)
  const flagged = parseManifestJson(JSON.stringify({ entries: {
    p: { group: "partial", row_count: 7, existing_rows_lack_span_key: true },
    c: { group: "complete", row_count: 42, existing_rows_lack_span_key: true },
  } }));
  assert.equal(Object.keys(flagged.entries).length, 2);
  // well-formed entries pass
  const ok = parseManifestJson(JSON.stringify({ entries: {
    a: { group: "zero", row_count: 0 },
    b: { group: "partial", row_count: 1, existing_span_keys: ["k1"] },
    c: { group: "complete", row_count: 42 },
  } }));
  assert.equal(Object.keys(ok.entries).length, 3);
});

test("reingest: flagged entry without existing_span_keys parses and is listed, never replayed", async () => {
  const { env, bucket, postedSpanKeys } = baseEnv();
  const fx = makeFixture(bucket, "up-flagged-nokeys", ["aaaaaaaaaaaaaaaa"], "pending");
  const manifest = parseManifestJson(JSON.stringify({ entries: {
    "up-flagged-nokeys": { group: "partial", row_count: 3, existing_rows_lack_span_key: true },
  } }));

  const { outcomes, failures } = await reingestCandidates(
    env,
    [{ upload_id: fx.uploadId, ledger_key: fx.ledgerKey }],
    manifest,
    false,
  );

  assert.equal(failures, 0);
  assert.equal(outcomes[0].action, "skipped_no_span_key");
  assert.equal(postedSpanKeys.length, 0);
});
