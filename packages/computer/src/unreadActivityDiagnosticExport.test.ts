import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  UNREAD_ACTIVITY_DIAGNOSTIC_SCHEMA_DIGEST,
  UNREAD_ACTIVITY_DIAGNOSTIC_SCHEMA_VERSION,
  UNREAD_ACTIVITY_DIAGNOSTIC_SYSTEM_IDENTIFIER_NOTE,
  validateUnreadActivityDiagnostic,
} from "@botiverse/raft-shared/unread-activity-diagnostic";

import {
  exportUnreadActivityDiagnosticSnapshot,
  UnreadActivityDiagnosticExportError,
  writeValidatedUnreadActivityDiagnosticSnapshot,
} from "./unreadActivityDiagnosticExport";

const SERVER_TOKEN = "0123456789abcdef0123456789abcdef";

function validSnapshot(): Record<string, unknown> {
  return {
    schema_version: UNREAD_ACTIVITY_DIAGNOSTIC_SCHEMA_VERSION,
    manifest_digest: UNREAD_ACTIVITY_DIAGNOSTIC_SCHEMA_DIGEST,
    diagnostic_correlation_id: SERVER_TOKEN,
    build_id: "server-build-fixture",
    value_at: "2026-09-25T00:00:00.000Z",
    membership_truncated: 0,
    views: [
      {
        requested_name: "activity_v1",
        served_name: "activity_v1",
        catalog_fingerprint: "catalog-fixture",
        system_identifier_note: UNREAD_ACTIVITY_DIAGNOSTIC_SYSTEM_IDENTIFIER_NOTE,
      },
    ],
    totals: [
      {
        row_present: true,
        status: "ok",
        value: 0,
        generation: "generation-fixture",
        value_at: "2026-09-25T00:00:00.000Z",
      },
    ],
    aggregates: {
      served_row_count: 1,
      suppressed_row_count: 0,
      watermark: 0,
      mute_rows_before: 0,
      mute_rows_at_or_after: 0,
      structural_target_count: 1,
      generation_gap_bucket: "same",
    },
  };
}

function canonicalFixture(): string {
  const validated = validateUnreadActivityDiagnostic(validSnapshot());
  assert.equal(validated.ok, true);
  if (!validated.ok) throw new Error("fixture must satisfy the shared validator");
  return validated.canonicalJson;
}

test("validated diagnostic writer atomically replaces the artifact with mode 0600 and no upload", async () => {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-unread-diagnostic-"));
  const outputPath = join(home, "diagnostics", "unread-activity.json");
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("unexpected upload");
  }) as typeof fetch;
  try {
    await mkdir(join(home, "diagnostics"), { recursive: true });
    await writeFile(outputPath, "old generation\n");
    if (process.platform !== "win32") await chmod(outputPath, 0o644);

    const canonicalJson = canonicalFixture();
    const receipt = await writeValidatedUnreadActivityDiagnosticSnapshot({
      outputPath,
      canonicalJson,
      viewCount: 1,
      serverCount: 1,
      maxViews: 64,
      maxServers: 32,
      maxBytes: 64 * 1024,
    });
    const persisted = await readFile(outputPath, "utf8");

    assert.equal(persisted, canonicalJson);
    assert.equal(receipt.bytes, Buffer.byteLength(persisted));
    assert.equal(receipt.views, 1);
    assert.equal(receipt.servers, 1);
    assert.equal(fetchCalls, 0, "saving a local artifact must not upload it");
    assert.deepEqual((await readdir(join(home, "diagnostics"))).filter((name) => name.endsWith(".tmp")), []);
    if (process.platform !== "win32") assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(home, { recursive: true, force: true });
  }
});

test("validated diagnostic writer rejects view, server, and byte overflow before creating a file", async () => {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-unread-diagnostic-bounds-"));
  try {
    for (const options of [
      { viewCount: 65, serverCount: 1, maxViews: 64, maxServers: 32, maxBytes: 64 * 1024 },
      { viewCount: 1, serverCount: 33, maxViews: 64, maxServers: 32, maxBytes: 64 * 1024 },
    ]) {
      const outputPath = join(home, `${options.viewCount}-${options.serverCount}.json`);
      await assert.rejects(
        writeValidatedUnreadActivityDiagnosticSnapshot({
          outputPath,
          canonicalJson: canonicalFixture(),
          ...options,
        }),
        (error: unknown) => {
          assert.ok(error instanceof UnreadActivityDiagnosticExportError);
          assert.equal(error.code, "DIAGNOSTIC_SNAPSHOT_ROW_LIMIT_EXCEEDED");
          return true;
        },
      );
      await assert.rejects(stat(outputPath), { code: "ENOENT" });
    }

    const bytePath = join(home, "bytes.json");
    await assert.rejects(
      writeValidatedUnreadActivityDiagnosticSnapshot({
        outputPath: bytePath,
        canonicalJson: canonicalFixture(),
        viewCount: 1,
        serverCount: 1,
        maxViews: 64,
        maxServers: 32,
        maxBytes: 8,
      }),
      (error: unknown) => {
        assert.ok(error instanceof UnreadActivityDiagnosticExportError);
        assert.equal(error.code, "DIAGNOSTIC_SNAPSHOT_BYTE_LIMIT_EXCEEDED");
        return true;
      },
    );
    await assert.rejects(stat(bytePath), { code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("validated diagnostic writer rejects non-object or invalid canonical JSON", async () => {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-unread-diagnostic-schema-"));
  try {
    for (const canonicalJson of ["not-json", "[]", "null", '"text"']) {
      await assert.rejects(
        writeValidatedUnreadActivityDiagnosticSnapshot({
          outputPath: join(home, "snapshot.json"),
          canonicalJson,
          viewCount: 0,
          serverCount: 0,
          maxViews: 64,
          maxServers: 32,
          maxBytes: 64 * 1024,
        }),
        (error: unknown) => {
          assert.ok(error instanceof UnreadActivityDiagnosticExportError);
          assert.equal(error.code, "DIAGNOSTIC_SNAPSHOT_SCHEMA_MISMATCH");
          return true;
        },
      );
    }
    assert.deepEqual(await readdir(home), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("validated diagnostic writer removes its temporary file after a final rename failure", async () => {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-unread-diagnostic-failure-"));
  try {
    const outputPath = join(home, "unread-activity.json");
    await mkdir(outputPath);
    await assert.rejects(
      writeValidatedUnreadActivityDiagnosticSnapshot({
        outputPath,
        canonicalJson: canonicalFixture(),
        viewCount: 1,
        serverCount: 1,
        maxViews: 64,
        maxServers: 32,
        maxBytes: 64 * 1024,
      }),
      (error: unknown) => {
        assert.ok(error instanceof UnreadActivityDiagnosticExportError);
        assert.equal(error.code, "DIAGNOSTIC_SNAPSHOT_WRITE_FAILED");
        return true;
      },
    );
    assert.deepEqual(await readdir(home), ["unread-activity.json"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("consumer uses the shared validator and preserves the server correlation token byte-for-byte", async () => {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-unread-diagnostic-consumer-"));
  const outputPath = join(home, "snapshot.json");
  let requestedServerId: string | undefined;
  try {
    const snapshot = Object.fromEntries(Object.entries(validSnapshot()).reverse());
    const validated = validateUnreadActivityDiagnostic(snapshot);
    assert.equal(validated.ok, true);
    if (!validated.ok) throw new Error("scrambled fixture must satisfy the shared validator");
    assert.notEqual(
      JSON.stringify(snapshot),
      validated.canonicalJson,
      "fixture must distinguish raw server key order from shared canonical bytes",
    );

    const receipt = await exportUnreadActivityDiagnosticSnapshot({
      client: {
        get: async (serverId?: string) => {
          requestedServerId = serverId;
          return { status: "success", snapshot };
        },
      },
      outputPath,
      serverId: "11111111-1111-4111-8111-111111111111",
    });

    const persistedJson = await readFile(outputPath, "utf8");
    const persisted = JSON.parse(persistedJson) as Record<string, unknown>;
    assert.equal(requestedServerId, "11111111-1111-4111-8111-111111111111");
    assert.equal(persistedJson, validated.canonicalJson);
    assert.equal(persisted.diagnostic_correlation_id, SERVER_TOKEN);
    assert.equal(receipt.servers, 1);
    assert.equal(receipt.views, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("schema/digest, forbidden, and unknown-field rejection have zero write or upload side effects", async () => {
  const badSnapshots = [
    { ...validSnapshot(), manifest_digest: "0".repeat(64) },
    { ...validSnapshot(), request_id: "fixture-request" },
    { ...validSnapshot(), surprise: true },
  ];
  const previousFetch = globalThis.fetch;
  let uploadCalls = 0;
  globalThis.fetch = (async () => {
    uploadCalls += 1;
    throw new Error("unexpected upload");
  }) as typeof fetch;
  try {
    for (const snapshot of badSnapshots) {
      let writeCalls = 0;
      await assert.rejects(
        exportUnreadActivityDiagnosticSnapshot(
          {
            client: { get: async () => ({ status: "success", snapshot }) },
            outputPath: "/must-not-be-written/unread-activity.json",
          },
          {
            writeValidated: async () => {
              writeCalls += 1;
              throw new Error("writer must not run");
            },
          },
        ),
        (error: unknown) => {
          assert.ok(error instanceof UnreadActivityDiagnosticExportError);
          assert.equal(error.code, "DIAGNOSTIC_SNAPSHOT_SCHEMA_MISMATCH");
          return true;
        },
      );
      assert.equal(writeCalls, 0);
    }
    assert.equal(uploadCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("validator rejection short-circuits before the writer and does not inspect or rewrite a token", async () => {
  let writerCalls = 0;
  let validatorInput: unknown;
  const snapshot = validSnapshot();
  await assert.rejects(
    exportUnreadActivityDiagnosticSnapshot(
      {
        client: { get: async () => ({ status: "success", snapshot }) },
        outputPath: "/must-not-be-written/unread-activity.json",
      },
      {
        validate: (payload) => {
          validatorInput = payload;
          return { ok: false, code: "invalid_shape" };
        },
        writeValidated: async () => {
          writerCalls += 1;
          throw new Error("writer must not run");
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof UnreadActivityDiagnosticExportError);
      assert.equal(error.code, "DIAGNOSTIC_SNAPSHOT_SCHEMA_MISMATCH");
      return true;
    },
  );
  assert.equal(validatorInput, snapshot);
  assert.equal(writerCalls, 0);
});

test("transport failures map to bounded local errors without server response detail", async () => {
  for (const [result, code] of [
    [{ status: "auth_required" }, "DIAGNOSTIC_SNAPSHOT_AUTH_REQUIRED"],
    [{ status: "forbidden" }, "DIAGNOSTIC_SNAPSHOT_FORBIDDEN"],
    [{ status: "error", code: "http_503" }, "DIAGNOSTIC_SNAPSHOT_SERVER_UNAVAILABLE"],
  ] as const) {
    await assert.rejects(
      exportUnreadActivityDiagnosticSnapshot({
        client: { get: async () => result },
        outputPath: "/must-not-be-written/unread-activity.json",
      }),
      (error: unknown) => {
        assert.ok(error instanceof UnreadActivityDiagnosticExportError);
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /private|credential|token/i);
        return true;
      },
    );
  }
});
