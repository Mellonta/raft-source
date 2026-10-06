import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BasicTracer } from "@botiverse/raft-shared";
import { LocalRotatingTraceSink } from "./localTraceSink";

// Task #419 — a failed trace write used to leave a half record behind with no
// log, no span and no count, and ingest rejects a bundle at its first
// unparseable line. These cover the count, the repair, and the guards that keep
// the repair from manufacturing the corruption it exists to prevent.

const NUL = String.fromCharCode(0);

/** A partial write followed by a throw cannot be provoked with a real disk. */
function partialThenThrow(bytesToWrite: number, code: string) {
  let armed = true;
  return (file: string, data: string) => {
    if (!armed) {
      writeFileSync(file, data, { flag: "a", encoding: "utf8" });
      return;
    }
    armed = false;
    writeFileSync(file, data.slice(0, bytesToWrite), { flag: "a", encoding: "utf8" });
    const err = new Error("simulated write failure") as Error & { code?: string };
    err.code = code;
    throw err;
  };
}

function throwOnce(code: string, real: (file: string, data: string) => void) {
  let armed = true;
  return (file: string, data: string, opts?: unknown) => {
    if (armed) {
      armed = false;
      const err = new Error("simulated failure") as Error & { code?: string };
      err.code = code;
      throw err;
    }
    real(file, data);
    void opts;
  };
}

function alwaysThrow(code: string) {
  return () => {
    const err = new Error("simulated failure") as Error & { code?: string };
    err.code = code;
    throw err;
  };
}

function emit(sink: LocalRotatingTraceSink, name: string): void {
  const tracer = new BasicTracer({ sink });
  tracer.startSpan(name, { surface: "daemon", kind: "producer" }).end("ok");
}

test("#419 a partial append is counted with its fs code and truncated so the file still parses", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-trace-partial-"));
  try {
    const sink = new LocalRotatingTraceSink({
      machineDir,
      maxFileBytes: 1024 * 1024,
      maxFiles: 4,
      fsOps: { appendFileSync: partialThenThrow(40, "ENOSPC") as never },
    });
    emit(sink, "daemon.first");
    emit(sink, "daemon.second");

    const stats = sink.getWriteFailureStats();
    assert.equal(stats.total, 1, "the failed append must be counted");
    assert.equal(stats.byOutcome.append_partial_truncated, 1);
    assert.equal(stats.lastCode, "ENOSPC", "the fs code must survive, not collapse to 'Error'");
    assert.equal(stats.rollbacks, 1);

    const dir = path.join(machineDir, "traces");
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    const text = await readFile(path.join(dir, files[0]!), "utf8");
    assert.ok(!text.includes(NUL), "no NUL bytes may be introduced");
    const lines = text.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 1, "only the surviving complete record remains");
    for (const line of lines) JSON.parse(line);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#419 an ensureFile failure is counted, never repairs, and never drops the 0600 mode", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-trace-ensure-"));
  try {
    let truncateCalls = 0;
    const realWrite = (file: string, data: string) => {
      writeFileSync(file, data, { flag: "a", encoding: "utf8", mode: 0o600 });
    };
    const sink = new LocalRotatingTraceSink({
      machineDir,
      maxFileBytes: 1024 * 1024,
      maxFiles: 4,
      fsOps: {
        // Step (2) of ensureFile: the file is created here, AFTER currentFile
        // has been repointed and BEFORE currentSize is refreshed.
        writeFileSync: throwOnce("ENOSPC", realWrite) as never,
        truncateSync: (() => {
          truncateCalls += 1;
        }) as never,
      },
    });
    emit(sink, "daemon.first");

    const stats = sink.getWriteFailureStats();
    assert.equal(stats.total, 1);
    assert.equal(stats.byOutcome.ensure_failed, 1, "the failure must be attributed to ensure_failed");
    assert.equal(truncateCalls, 0, "ensureFile failures must never reach the repair path");
    assert.equal(stats.lastCode, "ENOSPC");

    // The next write must re-enter rotation rather than letting appendFileSync
    // create the file itself with the default mode (#308: trace files are 600).
    emit(sink, "daemon.second");
    const dir = path.join(machineDir, "traces");
    const files = readdirSync(dir);
    assert.equal(files.length, 1, "a fresh file is created by the rotation path");
    const created = path.join(dir, files[0]!);
    assert.equal(statSync(created).mode & 0o777, 0o600, "trace files must stay 0600");
    const text = await readFile(created, "utf8");
    assert.ok(!text.includes(NUL), "no NUL bytes may be introduced");
    for (const line of text.split("\n").filter((l) => l.length > 0)) JSON.parse(line);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#419 when more bytes landed than we attempted, the file is abandoned instead of truncated", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-trace-foreign-"));
  try {
    let truncateCalls = 0;
    let armed = true;
    const sink = new LocalRotatingTraceSink({
      machineDir,
      maxFileBytes: 1024 * 1024,
      maxFiles: 4,
      fsOps: {
        appendFileSync: ((file: string, data: string) => {
          if (!armed) {
            writeFileSync(file, data, { flag: "a", encoding: "utf8" });
            return;
          }
          armed = false;
          // A co-writer lands a large block, then our own append fails.
          writeFileSync(file, `${data}${"x".repeat(5000)}`, { flag: "a", encoding: "utf8" });
          const err = new Error("simulated") as Error & { code?: string };
          err.code = "EIO";
          throw err;
        }) as never,
        truncateSync: (() => {
          truncateCalls += 1;
        }) as never,
      },
    });
    emit(sink, "daemon.first");

    const stats = sink.getWriteFailureStats();
    assert.equal(stats.total, 1);
    assert.equal(stats.lastCode, "EIO");
    assert.equal(truncateCalls, 0, "must not truncate over another writer's bytes");
    assert.equal(stats.byOutcome.append_partial_rotated, 1);
    assert.equal(stats.rotations, 1);

    // The next record must NOT be appended after the damaged tail.
    emit(sink, "daemon.second");
    assert.equal(readdirSync(path.join(machineDir, "traces")).length, 2, "writing moved to a new file");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#419 a failed truncate also abandons the file rather than appending after the fragment", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-trace-trunc-fail-"));
  try {
    const sink = new LocalRotatingTraceSink({
      machineDir,
      maxFileBytes: 1024 * 1024,
      maxFiles: 4,
      fsOps: {
        appendFileSync: partialThenThrow(40, "EIO") as never,
        truncateSync: alwaysThrow("EPERM") as never,
      },
    });
    emit(sink, "daemon.first");

    const stats = sink.getWriteFailureStats();
    assert.equal(stats.byOutcome.append_partial_rotated, 1);
    assert.equal(stats.rotations, 1);
    assert.equal(stats.rollbacks, 0);

    emit(sink, "daemon.second");
    const dir = path.join(machineDir, "traces");
    assert.equal(readdirSync(dir).length, 2, "the damaged file is left alone and a new one is used");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#419 an unrecognised error code is reported as a bounded value", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-trace-bounded-"));
  try {
    const sink = new LocalRotatingTraceSink({
      machineDir,
      maxFileBytes: 1024 * 1024,
      maxFiles: 4,
      fsOps: { appendFileSync: alwaysThrow("ESOMETHINGNEW") as never },
    });
    emit(sink, "daemon.only");

    const stats = sink.getWriteFailureStats();
    assert.equal(stats.total, 1);
    assert.equal(stats.lastCode, "other", "codes outside the allowlist must fold to 'other'");
    assert.equal(stats.byOutcome.append_no_bytes, 1, "nothing landed, so there is nothing to repair");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#419 BEHAVIOUR: a partial append must not leave an unparseable line in the file", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-trace-behaviour-"));
  try {
    const sink = new LocalRotatingTraceSink({
      machineDir,
      maxFileBytes: 1024 * 1024,
      maxFiles: 4,
      fsOps: { appendFileSync: partialThenThrow(40, "ENOSPC") as never },
    });
    emit(sink, "daemon.first");
    emit(sink, "daemon.second");

    const dir = path.join(machineDir, "traces");
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const text = await readFile(path.join(dir, name), "utf8");
      for (const line of text.split("\n").filter((l) => l.length > 0)) {
        JSON.parse(line);
      }
    }
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

// A prune victim that cannot be removed (a different owner, an immutable flag,
// held open on Windows -> EPERM/EBUSY/EACCES; `force: true` only swallows
// ENOENT) must not cost the write. Treating it as an ensureFile failure would
// abandon the freshly created file, drop the record, and have the next write
// create another file that fails to prune the same victim again: every record
// lost and the file count unbounded — worse than the defect this class fixes.
test("#419 an undeletable prune victim costs neither the record nor a bounded file count", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-trace-prune-"));
  try {
    const sink = new LocalRotatingTraceSink({
      machineDir,
      // Small budgets so rotation and pruning run on nearly every record.
      maxFileBytes: 1024,
      maxFiles: 2,
      fsOps: {
        rmSync: ((target: string) => {
          const err = new Error("simulated undeletable victim") as Error & { code?: string };
          err.code = "EPERM";
          void target;
          throw err;
        }) as never,
      },
    });

    const records = 40;
    for (let i = 0; i < records; i += 1) emit(sink, `daemon.record.${i}`);

    const dir = path.join(machineDir, "traces");
    const files = readdirSync(dir);

    // Every record must still be on disk and parseable.
    let lines = 0;
    for (const name of files) {
      const text = await readFile(path.join(dir, name), "utf8");
      for (const line of text.split("\n").filter((l) => l.length > 0)) {
        JSON.parse(line);
        lines += 1;
      }
    }
    assert.equal(lines, records, "no record may be dropped because pruning failed");

    // And the file count must not grow with the number of records.
    assert.ok(
      files.length < records / 2,
      `file count must not track record count: ${files.length} files for ${records} records`,
    );

    const stats = sink.getWriteFailureStats();
    assert.equal(stats.total, 0, "a prune failure is not a write failure");
    assert.ok(stats.pruneFailures > 0, "the prune failure must still be counted");
    assert.equal(stats.lastPruneCode, "EPERM");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

// Task #421 (@Stone's #419 follow-up) — selectPruneVictims returns victims
// oldest-first, so one undeletable file sits at the front of every prune. With
// a single try around the whole loop it threw on that file every rotation and
// every victim behind it was never reached: reclamation stopped permanently and
// the file count grew by one per rotation, unbounded. Per-victim try costs
// exactly one retained file instead.
test("#421 one undeletable victim does not block the victims behind it", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-trace-prune-block-"));
  try {
    const removed: string[] = [];
    let stuck: string | null = null;
    const sink = new LocalRotatingTraceSink({
      machineDir,
      maxFileBytes: 512,
      maxFiles: 2,
      fsOps: {
        rmSync: ((target: string) => {
          const name = path.basename(String(target));
          // The first file the sink ever tries to delete is the oldest, and it
          // stays undeletable for the rest of the run.
          if (stuck === null) stuck = name;
          if (name === stuck) {
            const err = new Error("simulated undeletable victim") as Error & { code?: string };
            err.code = "EPERM";
            throw err;
          }
          removed.push(name);
          rmSync(String(target), { force: true });
        }) as never,
      },
    });

    const records = 60;
    for (let i = 0; i < records; i += 1) emit(sink, `daemon.record.${i}`);

    assert.ok(stuck !== null, "the scenario must actually reach a prune");
    assert.ok(
      removed.length > 0,
      "victims behind the undeletable one must still be reclaimed; none were",
    );

    const files = readdirSync(path.join(machineDir, "traces"));
    assert.ok(
      files.length <= 4,
      `file count must stay bounded near the budget, got ${files.length} for ${records} records`,
    );
    assert.ok(files.includes(stuck), "the undeletable file is retained, which is the expected cost");

    const stats = sink.getWriteFailureStats();
    assert.equal(stats.total, 0, "a prune failure is still not a write failure");
    assert.ok(stats.pruneFailures > 0);
    assert.equal(stats.lastPruneCode, "EPERM");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});
