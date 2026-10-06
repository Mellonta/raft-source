// RFC 072 §7.10, CLI half (C13–C18): a thread read attests freshness only in
// the model context it happened in.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, test } from "vitest";

import { createCommandContext } from "../../core/context";
import { readMeta, resolveStateDbPath } from "../../state/agentLedger";
import { recordConsumedExactSeqs, recordConsumedRead } from "./_consumedSeqState";
import { messageSendCommand } from "./send";

const AGENT = "agent-thread-context";
const TARGET = "#room";
const ENV_KEYS = ["SLOCK_CLI_STATE_DIR", "SLOCK_CLI_CONSUMED_SEQ_STATE_DIR", "SLOCK_CLI_DRAFT_STATE_DIR", "SLOCK_CLI_TRANSPORT_DIR", "RAFT_HOME"] as const;
let prior: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let root = "";
let transportDir = "";

beforeEach(() => {
  prior = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-thread-context-"));
  transportDir = path.join(root, "transport");
  fs.mkdirSync(transportDir, { recursive: true, mode: 0o700 });
  process.env.SLOCK_CLI_STATE_DIR = path.join(root, "state");
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = path.join(root, "state");
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = path.join(root, "state");
  process.env.RAFT_HOME = root;
  delete process.env.SLOCK_CLI_TRANSPORT_DIR;
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (prior[key] === undefined) delete process.env[key];
    else process.env[key] = prior[key];
  }
});

/** Point the CLI at a daemon context signal; null removes the transport dir (no signal). */
function context(contextId: string | null, passiveAx: boolean | null = true): void {
  if (contextId === null) {
    delete process.env.SLOCK_CLI_TRANSPORT_DIR;
    return;
  }
  process.env.SLOCK_CLI_TRANSPORT_DIR = transportDir;
  fs.writeFileSync(
    path.join(transportDir, "context-generation"),
    JSON.stringify({ contextId, reason: "spawn", compactionReported: true, runtime: "claude", writtenAt: "t", ...(passiveAx === null ? {} : { passiveAx }) }),
    { mode: 0o600 },
  );
}

async function send(response: { state: string } = { state: "sent" }, target = TARGET): Promise<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  const ctx = createCommandContext({
    io: {
      stdin: Readable.from(["hello\n"]),
      stdout: { write: () => true },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => ({ agentId: AGENT, serverUrl: "http://stub.local", clientMode: "self-hosted-runner", profileSlug: "t" }) as never,
    createApiClient: () => ({
      request: async (_method: string, _path: string, body?: Record<string, unknown>) => {
        bodies.push(body ?? {});
        return { ok: true, status: 200, error: null, data: { ok: true, messageId: "m1", ...response } };
      },
    }) as never,
  });
  try {
    await messageSendCommand.handler(ctx, [], { target });
  } catch {
    // A held send throws after the request; the body is what these tests read.
  }
  return bodies[0] ?? {};
}

test("C13 a read from another context is not attested: no seenUpToSeq", async () => {
  context("ctx-A");
  recordConsumedRead(AGENT, TARGET, 50);
  context("ctx-B");
  const body = await send();
  assert.equal(Object.hasOwn(body, "seenUpToSeq"), false);
});

test("C14 a read in this context is attested", async () => {
  context("ctx-A");
  recordConsumedRead(AGENT, TARGET, 50);
  assert.equal((await send()).seenUpToSeq, 50);
});

test("C15 without a context signal, today's behaviour: the local value is attested", async () => {
  context(null);
  recordConsumedRead(AGENT, TARGET, 50);
  assert.equal((await send()).seenUpToSeq, 50);
  context("ctx-A");
  recordConsumedRead(AGENT, "#other", 7);
  context(null);
  assert.equal((await send()).seenUpToSeq, 50, "a signal-less send still reads the stored value");
});

test("C16 a row booked before context scoping (context_id empty) is not attested once a signal exists", async () => {
  context(null);
  recordConsumedRead(AGENT, TARGET, 50);
  // Simulate a pre-migration ledger row: context_id NULL is exactly what an ADD COLUMN leaves.
  context("ctx-A");
  const body = await send();
  assert.equal(Object.hasOwn(body, "seenUpToSeq"), false);
});

test("C17 the exported read record keeps its shape: { seq, readOrder } only", async () => {
  context("ctx-A");
  recordConsumedRead(AGENT, TARGET, 50);
  const file = path.join(root, "state", "slock-cli-consumed-seq", AGENT, "consumed-seqs.json");
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as { targets: Record<string, Record<string, unknown>> };
  assert.deepEqual(Object.keys(onDisk.targets[TARGET]!).sort(), ["readOrder", "seq"]);
});

test("C18 a new context replaces, not maxes: old 500, new read to 300 attests 300", async () => {
  context("ctx-A");
  recordConsumedRead(AGENT, TARGET, 500);
  recordConsumedExactSeqs(AGENT, { [TARGET]: [600] });
  context("ctx-B");
  recordConsumedRead(AGENT, TARGET, 300);
  const body = await send();
  assert.equal(body.seenUpToSeq, 300);
  assert.equal(Object.hasOwn(body, "seenExactSeqs") && (body.seenExactSeqs as number[]).includes(600), false, "exact seqs from ctx-A are dropped");
  // The new context's own exact observations must not be merged with ctx-A's.
  recordConsumedExactSeqs(AGENT, { [TARGET]: [700] });
  const withExact = await send();
  assert.deepEqual(withExact.seenExactSeqs, [700], "only this context's exact seqs are attested");
  // Within one context the high-water mark is still monotonic.
  recordConsumedRead(AGENT, TARGET, 200);
  assert.equal((await send()).seenUpToSeq, 300);
});

test("holds are counted by cause: context switch vs. evidence attached", async () => {
  context("ctx-A");
  recordConsumedRead(AGENT, TARGET, 50);
  const held = { state: "held", held: { latestMessages: [], unreadCount: 1 } };
  await send(held);
  assert.equal(readMeta(AGENT, "freshnessHold.withEvidence"), "1");
  context("ctx-B");
  await send(held);
  assert.equal(readMeta(AGENT, "freshnessHold.contextSwitch"), "1");
  assert.ok(fs.existsSync(resolveStateDbPath(AGENT)));
});

test("a hold on a target never read in any context moves neither counter", async () => {
  // A target no earlier test touched: the withheld set is per process.
  const fresh = "#never-read";
  context("ctx-A");
  const held = { state: "held", held: { latestMessages: [], unreadCount: 1 } };
  await send(held, fresh);
  assert.equal(readMeta(AGENT, "freshnessHold.contextSwitch"), undefined);
  assert.equal(readMeta(AGENT, "freshnessHold.withEvidence"), undefined);
  // Exact seqs alone from another context still count as a context switch.
  recordConsumedExactSeqs(AGENT, { [fresh]: [40] });
  context("ctx-B");
  await send(held, fresh);
  assert.equal(readMeta(AGENT, "freshnessHold.contextSwitch"), "1");
});

test("gate: with passiveAx missing or false, a read from another context is still attested (today's behaviour)", async () => {
  for (const passiveAx of [null, false] as const) {
    const target = `#gate-${String(passiveAx)}`;
    context("ctx-A", passiveAx);
    recordConsumedRead(AGENT, target, 50);
    context("ctx-B", passiveAx);
    assert.equal((await send({ state: "sent" }, target)).seenUpToSeq, 50, `passiveAx=${passiveAx}`);
  }
});
