import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DaemonTraceBundleUploader } from "./traceBundleUpload";

// Task #408 item 3 — the case this card is about is a machine where nothing
// reached the server, so a server-side record is exactly what is missing. The
// state file lets the machine answer "when did I last try, and have I been
// failing since?" from its own disk.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fetchImpl(fail: () => boolean) {
  return (async (url: string) => {
    if (fail()) return jsonResponse({ error: "no" }, 500);
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

async function seed(traceDir: string, name: string): Promise<void> {
  const file = path.join(traceDir, name);
  await writeFile(file, '{"type":"span","schema_version":1,"trace_id":"t","span_id":"s"}\n');
  const old = new Date("2026-05-08T00:00:00.000Z");
  await utimes(file, old, old);
}

function statePath(machineDir: string): string {
  return path.join(machineDir, "trace-uploads", "uploader-state.json");
}

async function readState(machineDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(statePath(machineDir), "utf8")) as Record<string, unknown>;
}

function uploaderFor(machineDir: string, fail: () => boolean) {
  return new DaemonTraceBundleUploader({
    machineDir,
    serverUrl: "https://server.test",
    apiKey: "sk_machine_test",
    workerUrl: "https://worker.test/",
    minFileAgeMs: 0,
    fetchImpl: fetchImpl(fail),
  } as never);
}

test("#408 every pass records when it ran and what it saw", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-408-state-"));
  try {
    const traceDir = path.join(machineDir, "traces");
    await mkdir(traceDir, { recursive: true });
    await seed(traceDir, "daemon-trace-2026-09-19T05-00-00-000Z-1-0000.jsonl");

    await uploaderFor(machineDir, () => false).uploadOnce("interval");

    const state = await readState(machineDir);
    assert.equal(state.lastPassTrigger, "interval");
    assert.equal(state.lastPassCandidates, 1);
    assert.equal(state.lastPassUploaded, 1);
    assert.equal(state.consecutiveFailedPasses, 0);
    assert.ok(typeof state.lastPassAt === "string");
    assert.equal(state.lastSuccessAt, state.lastPassAt, "a successful pass is also the last success");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#408 a pass with nothing to do is not counted as a failure", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-408-state-idle-"));
  try {
    await mkdir(path.join(machineDir, "traces"), { recursive: true });
    await uploaderFor(machineDir, () => false).uploadOnce();

    const state = await readState(machineDir);
    assert.equal(state.lastPassCandidates, 0);
    assert.equal(
      state.consecutiveFailedPasses,
      0,
      "an idle machine must not look broken; there was nothing to upload",
    );
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#408 consecutive failing passes accumulate, and one success clears the streak", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-408-state-streak-"));
  try {
    const traceDir = path.join(machineDir, "traces");
    await mkdir(traceDir, { recursive: true });
    let failing = true;
    const uploader = uploaderFor(machineDir, () => failing);

    await seed(traceDir, "daemon-trace-2026-09-19T05-00-01-000Z-1-0000.jsonl");
    await uploader.uploadOnce();
    assert.equal((await readState(machineDir)).consecutiveFailedPasses, 1);

    await uploader.uploadOnce();
    assert.equal((await readState(machineDir)).consecutiveFailedPasses, 2, "the streak survives restarts of the loop");

    const beforeSuccess = await readState(machineDir);
    assert.equal(beforeSuccess.lastSuccessAt, undefined, "nothing has ever succeeded yet");

    failing = false;
    await uploader.uploadOnce();
    const after = await readState(machineDir);
    assert.equal(after.consecutiveFailedPasses, 0, "one success clears it");
    assert.ok(typeof after.lastSuccessAt === "string");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#408 the last success is remembered across later failing passes", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-408-state-remember-"));
  try {
    const traceDir = path.join(machineDir, "traces");
    await mkdir(traceDir, { recursive: true });
    let failing = false;
    const uploader = uploaderFor(machineDir, () => failing);

    await seed(traceDir, "daemon-trace-2026-09-19T05-00-01-000Z-1-0000.jsonl");
    await uploader.uploadOnce();
    const successAt = (await readState(machineDir)).lastSuccessAt;
    assert.ok(typeof successAt === "string");

    failing = true;
    await seed(traceDir, "daemon-trace-2026-09-19T05-00-02-000Z-1-0000.jsonl");
    await uploader.uploadOnce();

    const after = await readState(machineDir);
    assert.equal(after.lastSuccessAt, successAt, "how long it has been broken is the question this answers");
    assert.equal(after.consecutiveFailedPasses, 1);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#408 the state is replaced atomically and leaves no temp file behind", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-408-state-atomic-"));
  try {
    const traceDir = path.join(machineDir, "traces");
    await mkdir(traceDir, { recursive: true });
    await seed(traceDir, "daemon-trace-2026-09-19T05-00-00-000Z-1-0000.jsonl");
    const uploader = uploaderFor(machineDir, () => false);
    await uploader.uploadOnce();
    await uploader.uploadOnce();

    const entries = await readdir(path.join(machineDir, "trace-uploads"));
    assert.ok(entries.includes("uploader-state.json"));
    assert.deepEqual(
      entries.filter((name) => name.endsWith(".tmp")),
      [],
      "the normal path must not leave partial files around",
    );
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

// The "no leftover .tmp" assertion above does NOT prove atomicity — an
// in-place write satisfies it trivially, and I checked: swapping rename for a
// direct write leaves every other test in this file green. This one
// discriminates. Replacing by rename only needs the DIRECTORY to be writable,
// so it still succeeds when the target file itself is read-only; a direct write
// fails there and the state silently stops advancing.
test("#408 the state advances by replacement, not by writing into the old file", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-408-state-replace-"));
  try {
    const traceDir = path.join(machineDir, "traces");
    await mkdir(traceDir, { recursive: true });
    await seed(traceDir, "daemon-trace-2026-09-19T05-00-01-000Z-1-0000.jsonl");
    const uploader = uploaderFor(machineDir, () => false);

    await uploader.uploadOnce();
    const first = await readState(machineDir);
    assert.equal(first.lastPassUploaded, 1);

    // Make the existing state file unwritable. A rename-based replace does not
    // care; an in-place write cannot proceed.
    await chmod(statePath(machineDir), 0o444);

    // Two more candidates, so the second pass has a candidate count that cannot
    // coincide with the first. The earlier version compared `lastPassAt`, which
    // is flaky: two passes can land in the same millisecond, and on CI they did.
    await seed(traceDir, "daemon-trace-2026-09-19T05-00-02-000Z-1-0000.jsonl");
    await seed(traceDir, "daemon-trace-2026-09-19T05-00-03-000Z-1-0000.jsonl");
    await uploader.uploadOnce();

    const second = await readState(machineDir);
    assert.equal(
      second.lastPassCandidates,
      2,
      "the state must have advanced even though the old file was read-only",
    );
  } finally {
    await chmod(statePath(machineDir), 0o600).catch(() => undefined);
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#408 a corrupt state file never blocks an upload", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-408-state-corrupt-"));
  try {
    const traceDir = path.join(machineDir, "traces");
    await mkdir(traceDir, { recursive: true });
    await mkdir(path.join(machineDir, "trace-uploads"), { recursive: true });
    await writeFile(statePath(machineDir), "{ this is not json");
    await seed(traceDir, "daemon-trace-2026-09-19T05-00-00-000Z-1-0000.jsonl");

    const result = await uploaderFor(machineDir, () => false).uploadOnce();
    assert.equal(result.uploaded, 1, "bookkeeping must never stop the actual work");

    const state = await readState(machineDir);
    assert.equal(state.lastPassUploaded, 1, "and the file is replaced with something readable");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

// @Stone: an unchecked `as UploaderState` lets a string through, and `"3" + 1`
// is `"31"` — which would then be written back to the file AND onto the span,
// so one bad field becomes a permanent one.
test("#408 a well-formed state file with a wrong-typed field does not corrupt the next one", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-408-state-badtype-"));
  try {
    const traceDir = path.join(machineDir, "traces");
    await mkdir(traceDir, { recursive: true });
    await mkdir(path.join(machineDir, "trace-uploads"), { recursive: true });
    // Valid JSON, wrong types throughout.
    await writeFile(statePath(machineDir), JSON.stringify({
      lastPassAt: 12345,
      lastPassTrigger: null,
      lastPassCandidates: "many",
      lastPassUploaded: {},
      consecutiveFailedPasses: "3",
      lastSuccessAt: 99,
    }));
    await seed(traceDir, "daemon-trace-2026-09-19T05-00-01-000Z-1-0000.jsonl");

    // A failing pass, so the counter is incremented from whatever was read.
    await uploaderFor(machineDir, () => true).uploadOnce();

    const state = await readState(machineDir);
    assert.equal(
      state.consecutiveFailedPasses,
      1,
      'a string "3" must not become "31"; the unusable value is treated as 0',
    );
    assert.equal(typeof state.consecutiveFailedPasses, "number");
    assert.ok(!("lastSuccessAt" in state), "a non-string lastSuccessAt is dropped, not carried forward");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});
