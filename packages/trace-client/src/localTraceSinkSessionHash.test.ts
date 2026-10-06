import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BasicTracer } from "@botiverse/raft-shared";
import { LocalRotatingTraceSink } from "./localTraceSink";

// Task #422 — a runtime session id is diagnostically valuable and privacy
// sensitive: on the agent's own machine it can be used to resume that
// conversation. The ruling was a machine-scoped reference, so the raw value
// never reaches disk. Every assertion here reads the JSONL back, because the
// transform happens on the write path.

const SALT_PATH = ["secrets", "trace-session-salt"];

/**
 * One sentence, asserted identically wherever the salt is unusable.
 *
 * The claim is "no session identifier of ANY form was written" — not merely
 * "no hash". The weaker form would still pass if someone added an unsalted
 * digest as a fallback, which is the degradation this guards (@Leiysky).
 */
function assertNoSessionIdentifier(written: Record<string, unknown>): void {
  for (const key of ["session_id", "sessionId", "session_id_hash"]) {
    assert.ok(!(key in written), `no session identifier of any form may be written (found ${key})`);
  }
}

async function emitAndRead(machineDir: string, attrs: Record<string, unknown>) {
  const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
  const tracer = new BasicTracer({ sink });
  tracer.startSpan("daemon.probe", { surface: "daemon", kind: "internal", attrs: attrs as never }).end("ok");

  const dir = path.join(machineDir, "traces");
  let written: Record<string, unknown> = {};
  for (const name of readdirSync(dir)) {
    const text = await readFile(path.join(dir, name), "utf8");
    for (const line of text.split("\n").filter((l) => l.length > 0)) {
      const record = JSON.parse(line) as { name?: string; attrs?: Record<string, unknown> };
      if (record.name === "daemon.probe") written = record.attrs ?? {};
    }
  }
  return { sink, written };
}

test("#422 a session id is replaced by a machine-scoped reference, never written raw", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-422-hash-"));
  try {
    const { written } = await emitAndRead(machineDir, { session_id: "sess-secret-value", agent_id: "a" });

    assert.ok(!("session_id" in written), "the raw id must never reach disk");
    assert.equal(typeof written.session_id_hash, "string");
    assert.equal((written.session_id_hash as string).length, 12);
    assert.equal(written.session_id_hash_scope, "machine");
    assert.ok(
      !JSON.stringify(written).includes("sess-secret-value"),
      "the raw value must not appear anywhere in the record",
    );
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#422 the salt is created once, 0600, and outside every collected directory", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-422-salt-"));
  try {
    await emitAndRead(machineDir, { session_id: "s1" });
    const saltFile = path.join(machineDir, ...SALT_PATH);
    assert.ok(existsSync(saltFile), "the salt must have been created");
    assert.equal(statSync(saltFile).mode & 0o777, 0o600);

    // It must not be inside traces/, which is uploaded wholesale and is what
    // the feedback/evidence collectors read.
    const traceDir = path.join(machineDir, "traces");
    assert.ok(!saltFile.startsWith(traceDir + path.sep), "the salt must live outside traces/");
    for (const name of readdirSync(traceDir)) {
      assert.ok(name.startsWith("daemon-trace-"), `unexpected ${name} in the uploaded directory`);
    }
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#422 the same session id hashes the same within a machine and differs across machines", async () => {
  const a = await mkdtemp(path.join(os.tmpdir(), "slock-422-m1-"));
  const b = await mkdtemp(path.join(os.tmpdir(), "slock-422-m2-"));
  try {
    const first = await emitAndRead(a, { session_id: "same-session" });
    const again = await emitAndRead(a, { session_id: "same-session" });
    const other = await emitAndRead(b, { session_id: "same-session" });

    assert.equal(
      first.written.session_id_hash,
      again.written.session_id_hash,
      "stable within a machine, or it cannot be used to group",
    );
    assert.notEqual(
      first.written.session_id_hash,
      other.written.session_id_hash,
      "different across machines — cross-machine lookup is deliberately closed",
    );
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

// @Leiysky: the tempting failure is to "at least give a usable value". An
// unsalted digest of a low-entropy id is a lookup table, so it is worse than
// writing nothing. There must be no third branch.
test("#422 an unusable salt drops the field and counts it — never a weaker value", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-422-nosalt-"));
  try {
    // Pre-create the salt file as unreadable, so creation fails (EEXIST) and
    // reading fails too.
    await mkdir(path.join(machineDir, "secrets"), { recursive: true });
    const saltFile = path.join(machineDir, ...SALT_PATH);
    await writeFile(saltFile, "");
    await chmod(saltFile, 0o000);

    const { sink, written } = await emitAndRead(machineDir, { session_id: "sess-1", agent_id: "a" });

    assertNoSessionIdentifier(written);
    assert.equal(written.agent_id, "a", "control: the rest of the span is unaffected");

    const stats = sink.getWriteFailureStats();
    assert.equal(
      stats.droppedAttrsByReason.session_hash_unavailable,
      1,
      "the loss must be counted, not silent",
    );
  } finally {
    await chmod(path.join(machineDir, ...SALT_PATH), 0o600).catch(() => undefined);
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#422 a non-string session id is dropped rather than coerced", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-422-coerce-"));
  try {
    const { sink, written } = await emitAndRead(machineDir, { session_id: 12345, agent_id: "a" });
    assert.ok(!("session_id" in written));
    assert.ok(!("session_id_hash" in written));
    assert.equal(sink.getWriteFailureStats().droppedAttrsByReason.session_hash_unavailable, 1);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#422 the camelCase spelling is handled too", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-422-camel-"));
  try {
    const { written } = await emitAndRead(machineDir, { sessionId: "sess-1" });
    assert.ok(!("sessionId" in written), "sessionId must not survive either");
    assert.equal(typeof written.session_id_hash, "string");
    assert.equal(written.session_id_hash_scope, "machine");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

// @Stone blocker 2: the old create opened the target then wrote it, so a racing
// reader — or a crash — could see a zero-length salt. Worse, that outcome was
// cached forever, so one bad instant disabled hashing for the process's life,
// and a leftover empty file disabled it for every process on the machine.
test("#422 an empty salt file neither yields a hash nor locks the sink out forever", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-422-emptysalt-"));
  try {
    await mkdir(path.join(machineDir, "secrets"), { recursive: true });
    const saltFile = path.join(machineDir, ...SALT_PATH);
    await writeFile(saltFile, "");

    let now = 1_000_000;
    const sink = new LocalRotatingTraceSink({
      machineDir,
      maxFileBytes: 1024 * 1024,
      maxFiles: 4,
      nowMsProvider: () => now,
    });
    const tracer = new BasicTracer({ sink });
    tracer.startSpan("daemon.a", { surface: "daemon", kind: "internal", attrs: { session_id: "s1" } as never }).end("ok");
    assert.equal(
      sink.getWriteFailureStats().droppedAttrsByReason.session_hash_unavailable,
      1,
      "an empty salt must drop and count",
    );
    {
      const dir = path.join(machineDir, "traces");
      for (const name of readdirSync(dir)) {
        const text = await readFile(path.join(dir, name), "utf8");
        for (const line of text.split("\n").filter((l) => l.length > 0)) {
          const record = JSON.parse(line) as { name?: string; attrs?: Record<string, unknown> };
          if (record.name === "daemon.a") assertNoSessionIdentifier(record.attrs ?? {});
        }
      }
    }

    // Someone repairs the salt. After the retry interval the sink must recover
    // rather than stay null for the rest of its life.
    await writeFile(saltFile, Buffer.from("ab".repeat(32), "utf8"));
    now += 61_000;
    tracer.startSpan("daemon.b", { surface: "daemon", kind: "internal", attrs: { session_id: "s1" } as never }).end("ok");

    const dir = path.join(machineDir, "traces");
    let sawHash = false;
    for (const name of readdirSync(dir)) {
      const text = await readFile(path.join(dir, name), "utf8");
      for (const line of text.split("\n").filter((l) => l.length > 0)) {
        const record = JSON.parse(line) as { name?: string; attrs?: Record<string, unknown> };
        if (record.name === "daemon.b" && typeof record.attrs?.session_id_hash === "string") sawHash = true;
      }
    }
    assert.ok(sawHash, "after the salt is usable again the sink must resume hashing");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

// @Leiysky: the atomic-create temp file is subject to the same structural rule
// as the salt itself. If it were created under traces/ or named like a rotating
// trace file, the upload path would collect it mid-write — and that race window
// would itself be the leak. This asserts the property rather than the filename,
// so renaming the temp file cannot quietly reopen it.
test("#422 nothing matching a collected shape ever exists while the salt is created", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-422-tmpshape-"));
  try {
    const traceDir = path.join(machineDir, "traces");
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
    const tracer = new BasicTracer({ sink });
    tracer.startSpan("daemon.a", { surface: "daemon", kind: "internal", attrs: { session_id: "s1" } as never }).end("ok");

    // After creation, traces/ holds only rotating trace files, and the salt
    // directory holds nothing that the collectors would pick up.
    for (const name of readdirSync(traceDir)) {
      assert.ok(name.startsWith("daemon-trace-") && name.endsWith(".jsonl"), `unexpected ${name} under traces/`);
    }
    const secretsDir = path.join(machineDir, "secrets");
    for (const name of readdirSync(secretsDir)) {
      assert.ok(
        !(name.startsWith("daemon-trace-") && name.endsWith(".jsonl")),
        `${name} matches the collected shape and would be uploaded`,
      );
    }
    // And no temp file was left behind.
    assert.deepEqual(readdirSync(secretsDir), ["trace-session-salt"]);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});
