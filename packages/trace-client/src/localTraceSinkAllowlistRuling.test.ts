import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BasicTracer } from "@botiverse/raft-shared";
import { LocalRotatingTraceSink } from "./localTraceSink";

// Task #422 items (2) and (3) — the per-key determination (@Leiysky, corrected
// by @Stone on runtime_turn_id and tool_execution_instance_id) and the rule
// that a `*_present` flag must never claim a field the record does not carry.
//
// Asserted on the JSONL read back off disk, because both the allowlist and the
// flag handling act on the write path.

async function writeAndRead(attrs: Record<string, unknown>): Promise<{ written: Record<string, unknown>; machineDir: string }> {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-422c-"));
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
  return { written, machineDir };
}

test("#422 the keys the determination allows now reach disk", async () => {
  const { written, machineDir } = await writeAndRead({
    start_dispatch_id: "disp-1",
    runtime_turn_id: "turn-1",
    tool_execution_instance_id: "exec-1",
    request_id: "req-1",
  });
  try {
    assert.equal(written.start_dispatch_id, "disp-1", "server-minted, same class as launch_id");
    assert.equal(written.runtime_turn_id, "turn-1", "daemon-generated; a turn is not a session");
    assert.equal(written.tool_execution_instance_id, "exec-1");
    assert.equal(written.request_id, "req-1");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#422 the keys the determination drops still do not reach disk", async () => {
  const { written, machineDir } = await writeAndRead({
    requestId: "req-1",
    runtime_session_id: "sess-1",
    producer_fact_id: "fact-1",
    producerFactId: "fact-2",
    feedbackReportId: "report-1",
  });
  try {
    for (const key of ["requestId", "runtime_session_id", "producer_fact_id", "producerFactId", "feedbackReportId"]) {
      assert.ok(!(key in written), `${key} is on the drop list and must not be written`);
    }
    // producer_fact_id is dropped by the #460 ruling, not by an allowlist gap —
    // adding it would overturn a decision, not fix an oversight.
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#422 only one spelling of the request id survives", async () => {
  const { written, machineDir } = await writeAndRead({ request_id: "keep", requestId: "drop" });
  try {
    assert.equal(written.request_id, "keep");
    assert.ok(!("requestId" in written), "two spellings of one id would split every query on it");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

// Item (3). A producer flag answers "did the source have one"; a reader asks
// "did it land". Only the sink knows the second, so it writes the flag and the
// producer's version is dropped rather than carried alongside.
test("#422 session presence is reported by the sink, from what it actually did", async () => {
  const { written, machineDir } = await writeAndRead({
    session_id: "sess-1",
    session_id_present: true,
    agent_id: "a",
  });
  try {
    assert.equal(typeof written.session_id_hash, "string");
    assert.equal(written.session_id_hash_present, true, "the sink asserts what it wrote");
    assert.ok(!("session_id_present" in written), "the producer's flag is superseded, not duplicated");
    assert.ok(!("session_id" in written), "and the raw id still never lands");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

// Class B (@Leiysky's three-class rule, after @Stone raised this case). This
// flag is NOT removed: it claims "the source had a session", which stays true
// even though `runtime_session_id` never reaches disk — and unlike `session_id`
// there is no hash form to carry that fact instead. The reason it is treated
// differently from `session_id_present` is the availability of a carrier, not
// the shape of the name.
test("#422 a flag claiming a source-side fact survives, when nothing else carries it", async () => {
  const { written, machineDir } = await writeAndRead({
    runtime_session_id: "sess-1",
    runtime_session_id_present: true,
    runtime_turn_id: "turn-1",
  });
  try {
    assert.ok(!("runtime_session_id" in written), "precondition: the value itself is still dropped");
    assert.equal(
      written.runtime_session_id_present,
      true,
      "'the source had one' is a true claim, and this flag is its only carrier",
    );
    assert.ok(
      !("runtime_session_id_hash" in written),
      "condition attached to the ruling: the day this exists, the flag moves to class A",
    );
    assert.equal(written.runtime_turn_id, "turn-1", "control: the turn id beside it is unaffected");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

// The false-claim case, for contrast: same shape of key, opposite ruling,
// because `session_id_hash_present` does carry the fact.
test("#422 a flag whose fact has a carrier is replaced by that carrier, not kept", async () => {
  const { written, machineDir } = await writeAndRead({ session_id: "sess-1", session_id_present: true });
  try {
    assert.ok(!("session_id_present" in written), "class A: removed…");
    assert.equal(written.session_id_hash_present, true, "…because this says the same thing, truthfully");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("#422 an unusable salt reports session presence as false, not as absent", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-422c-nosalt-"));
  try {
    // A pre-existing empty salt file: creation sees EEXIST, the read finds
    // nothing usable, so no reference can be produced.
    await mkdir(path.join(machineDir, "secrets"), { recursive: true });
    await writeFile(path.join(machineDir, "secrets", "trace-session-salt"), "");

    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
    const tracer = new BasicTracer({ sink });
    tracer.startSpan("daemon.probe", { surface: "daemon", kind: "internal", attrs: { session_id: "s", agent_id: "a" } as never }).end("ok");

    const dir = path.join(machineDir, "traces");
    let written: Record<string, unknown> = {};
    for (const name of readdirSync(dir)) {
      const text = await readFile(path.join(dir, name), "utf8");
      for (const line of text.split("\n").filter((l) => l.length > 0)) {
        const record = JSON.parse(line) as { name?: string; attrs?: Record<string, unknown> };
        if (record.name === "daemon.probe") written = record.attrs ?? {};
      }
    }

    assert.ok(!("session_id_hash" in written), "no reference could be produced");
    assert.equal(
      written.session_id_hash_present,
      false,
      '"we had a session id and could not reference it" must not look like "there was no session"',
    );
    assert.equal(written.agent_id, "a", "control: the rest of the span is unaffected");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

// @Leiysky named this one in item (3) and I first reported it as non-existent —
// wrongly: it is emitted at `daemon/src/connection.ts` (and on the server side,
// which this sink cannot reach). On the daemon span the value is scrubbed by the
// #460 ruling, so the flag asserts a field the record does not carry.
test("#422 producer_fact_id_present is removed, because the value beside it is scrubbed", async () => {
  const { written, machineDir } = await writeAndRead({
    producer_fact_id: "daemon_activity:agent-1:launch-1:7",
    producerFactId: "daemon_activity:agent-1:launch-1:7",
    producer_fact_id_present: true,
    producerFactIdPresent: true,
    client_seq_present: true,
  });
  try {
    for (const key of ["producer_fact_id", "producerFactId"]) {
      assert.ok(!(key in written), `precondition: ${key} is scrubbed by the #460 ruling`);
    }
    for (const key of ["producer_fact_id_present", "producerFactIdPresent"]) {
      assert.ok(!(key in written), `${key} would claim a field the record does not have`);
    }
    assert.equal(
      written.client_seq_present,
      true,
      "control: a presence flag whose value is NOT dropped is untouched — this is not a rule about *_present",
    );
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});
