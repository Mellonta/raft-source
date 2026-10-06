import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectObservedFailureSummary,
  normalizeTraceInstant,
  toObservedFailureSpan,
  UNKNOWN_FAILURE_SPAN,
} from "./observedFailureSummary";

const AGENT = "agent-under-report";
const OTHER_AGENT = "some-other-agent";
const CREDENTIAL = "sk_agent_LIVE_TOKEN_abcdef123456";

let machineDir: string;

async function writeTrace(records: unknown[], file = "daemon-trace-0001.jsonl"): Promise<void> {
  await mkdir(path.join(machineDir, "traces"), { recursive: true });
  await writeFile(
    path.join(machineDir, "traces", file),
    records.map((record) => (typeof record === "string" ? record : JSON.stringify(record))).join("\n"),
    "utf8",
  );
}

function span(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "span",
    name: "daemon.connection.error",
    status: "error",
    start_time: "2026-09-15T12:00:00.000Z",
    end_time: "2026-09-15T12:00:01.000Z",
    ...overrides,
  };
}

function collect(): Promise<Awaited<ReturnType<typeof collectObservedFailureSummary>>> {
  return collectObservedFailureSummary({
    machineDir,
    agentId: AGENT,
    from: "2026-09-15T00:00:00.000Z",
    to: "2026-09-16T00:00:00.000Z",
  });
}

beforeEach(async () => {
  machineDir = await mkdtemp(path.join(os.tmpdir(), "observed-failure-"));
});

afterEach(async () => {
  await rm(machineDir, { recursive: true, force: true });
});

describe("observed failure summary", () => {
  test("empty corpus reports an observation window and an empty list, never 'no failures'", async () => {
    const summary = await collect();
    assert.deepEqual(summary.failures, []);
    // The window must still be emitted, otherwise the empty list is unreadable.
    assert.equal(summary.window.requestedFrom, "2026-09-15T00:00:00.000Z");
    assert.equal(summary.window.requestedTo, "2026-09-16T00:00:00.000Z");
    assert.equal(summary.window.observedFrom, null);
    assert.equal(summary.window.observedTo, null);
    assert.equal(summary.window.recordsRead, 0);
    assert.equal(summary.window.recordsInWindow, 0);
    assert.equal(summary.window.failureRecords, 0);
    assert.equal(summary.window.completeness, "unknown");
    // Nothing in the output may assert the absence of failure.
    assert.ok(!JSON.stringify(summary).includes("noFailures"));
  });

  test("a missing trace directory is an empty observation, not a thrown error", async () => {
    const summary = await collectObservedFailureSummary({
      machineDir: path.join(machineDir, "does-not-exist"),
      agentId: AGENT,
      from: "2026-09-15T00:00:00.000Z",
      to: "2026-09-16T00:00:00.000Z",
    });
    assert.deepEqual(summary.failures, []);
    assert.equal(summary.window.completeness, "unknown");
  });

  test("only status 'error' counts as a failure", async () => {
    await writeTrace([
      span({ status: "error" }),
      span({ status: "ok" }),
      span({ status: "cancelled", name: "daemon.connection.disconnected" }),
      span({ status: "warn" }),
      span({ status: undefined }),
      span({ status: 500 }),
    ]);
    const summary = await collect();
    assert.equal(summary.window.recordsInWindow, 6);
    assert.equal(summary.window.failureRecords, 1);
    assert.equal(summary.window.nonFailureRecords, 5);
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0]?.count, 1);
  });

  test("cancelled connection lifecycle rows never reach the failures list", async () => {
    await writeTrace([
      span({ status: "cancelled", name: "daemon.connection.disconnected" }),
      span({ status: "cancelled", name: "daemon.connection.local_disconnect_observed" }),
    ]);
    const summary = await collect();
    assert.deepEqual(summary.failures, []);
    assert.equal(summary.window.failureRecords, 0);
    assert.equal(summary.window.nonFailureRecords, 2);
  });

  test("a span name outside the vocabulary is reported as unknown and never echoed", async () => {
    await writeTrace([
      span({ name: `daemon.connection.error?token=${CREDENTIAL}` }),
      span({ name: "/Users/someone/.slock/agents/abc123/workspace" }),
    ]);
    const summary = await collect();
    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes(CREDENTIAL), "credential must not reach the summary");
    assert.ok(!serialized.includes("sk_agent"), "credential prefix must not reach the summary");
    assert.ok(!serialized.includes("/Users/"), "path must not reach the summary");
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0]?.span, UNKNOWN_FAILURE_SPAN);
    // Collapsing to `unknown` must not lose the failure.
    assert.equal(summary.failures[0]?.count, 2);
  });

  test("timestamps are re-serialized, not copied from the corpus", async () => {
    await writeTrace([span({ start_time: "2026-09-15T12:00:00+02:00" })]);
    const summary = await collect();
    assert.equal(summary.failures[0]?.firstAt, "2026-09-15T10:00:00.000Z");
    assert.ok(!JSON.stringify(summary).includes("+02:00"));
  });

  test("a record with an unusable timestamp is excluded and counted, not silently dropped", async () => {
    await writeTrace([
      span({ start_time: "not-a-time" }),
      span({ start_time: CREDENTIAL }),
      span({ start_time: "2026-13-45T99:99:99Z" }),
      span({ start_time: undefined }),
    ]);
    const summary = await collect();
    assert.deepEqual(summary.failures, []);
    assert.equal(summary.window.recordsRead, 4);
    assert.equal(summary.window.excluded.undatable, 4);
    assert.equal(summary.window.recordsInWindow, 0);
    assert.ok(!JSON.stringify(summary).includes(CREDENTIAL));
  });

  test("unparseable lines are counted and do not abort the read", async () => {
    await writeTrace(["{not json", "", span() as unknown as string, "[1,2,3]", "null"]);
    const summary = await collect();
    assert.equal(summary.window.excluded.unparseable, 3);
    assert.equal(summary.window.failureRecords, 1);
  });

  test("attribution comes only from the structured attrs.agentId", async () => {
    await writeTrace([
      span({ attrs: { agentId: AGENT } }),
      span({}),
      span({ attrs: {} }),
      span({ attrs: { agentId: "" } }),
      // A matching id anywhere but `attrs.agentId` must not produce `exact`.
      span({ agentId: AGENT }),
      span({ attrs: { agent_id: AGENT } }),
      span({ name: "daemon.connection.error", attrs: { note: AGENT } }),
    ]);
    const summary = await collect();
    const exact = summary.failures.filter((entry) => entry.attribution === "exact");
    const machineWide = summary.failures.filter((entry) => entry.attribution === "machine-wide");
    assert.equal(exact.length, 1);
    assert.equal(exact[0]?.count, 1);
    assert.equal(machineWide.length, 1);
    assert.equal(machineWide[0]?.count, 6);
  });

  test("another agent's records are excluded rather than folded into machine-wide", async () => {
    await writeTrace([
      span({ attrs: { agentId: OTHER_AGENT } }),
      span({ attrs: { agentId: AGENT } }),
    ]);
    const summary = await collect();
    assert.equal(summary.window.excluded.otherAgent, 1);
    assert.equal(summary.window.failureRecords, 1);
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0]?.attribution, "exact");
  });

  test("records outside the requested window are not counted", async () => {
    await writeTrace([
      span({ start_time: "2026-09-14T23:59:59.999Z" }),
      span({ start_time: "2026-09-15T12:00:00.000Z" }),
      span({ start_time: "2026-09-16T00:00:00.001Z" }),
    ]);
    const summary = await collect();
    assert.equal(summary.window.recordsRead, 3);
    assert.equal(summary.window.recordsInWindow, 1);
    assert.equal(summary.window.observedFrom, "2026-09-15T12:00:00.000Z");
    assert.equal(summary.window.observedTo, "2026-09-15T12:00:00.000Z");
  });

  test("observedFrom/To span the counted records across files", async () => {
    await writeTrace([span({ start_time: "2026-09-15T09:00:00.000Z" })], "daemon-trace-0001.jsonl");
    await writeTrace([span({ start_time: "2026-09-15T18:00:00.000Z", status: "ok" })], "daemon-trace-0002.jsonl");
    const summary = await collect();
    assert.equal(summary.window.observedFrom, "2026-09-15T09:00:00.000Z");
    assert.equal(summary.window.observedTo, "2026-09-15T18:00:00.000Z");
    assert.equal(summary.window.recordsInWindow, 2);
    assert.equal(summary.window.failureRecords, 1);
  });

  test("files that are not daemon trace files are ignored", async () => {
    await writeTrace([span()], "daemon-trace-0001.jsonl");
    await writeTrace([span()], "not-a-trace.jsonl");
    await writeTrace([span()], "daemon-trace-0002.txt");
    const summary = await collect();
    assert.equal(summary.window.recordsRead, 1);
  });
});

describe("boundary converters", () => {
  test("known span names pass through unchanged", () => {
    assert.equal(toObservedFailureSpan("daemon.connection.error"), "daemon.connection.error");
    assert.equal(toObservedFailureSpan("daemon.runtime.process.exit"), "daemon.runtime.process.exit");
  });

  test("unknown and non-string span names collapse to unknown", () => {
    for (const value of [`x${CREDENTIAL}`, "", null, undefined, 42, {}, []]) {
      assert.equal(toObservedFailureSpan(value), UNKNOWN_FAILURE_SPAN);
    }
  });

  test("valid instants normalize to ISO UTC", () => {
    assert.equal(normalizeTraceInstant("2026-09-15T12:14:06.000Z"), "2026-09-15T12:14:06.000Z");
    assert.equal(normalizeTraceInstant("2026-09-15T12:14:06+02:00"), "2026-09-15T10:14:06.000Z");
    assert.equal(normalizeTraceInstant(1_789_000_000_000), new Date(1_789_000_000_000).toISOString());
  });

  test("invalid instants become null instead of passing text through", () => {
    for (const value of ["not-a-time", CREDENTIAL, "", null, undefined, NaN, Infinity, {}, []]) {
      assert.equal(normalizeTraceInstant(value), null);
    }
  });
});
