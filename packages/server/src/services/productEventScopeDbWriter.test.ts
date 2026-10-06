import assert from "node:assert/strict";
import { register } from "../metrics";
import {
  PRODUCT_EVENTS_INGEST_STATEMENT,
  ScopeDbProductEventSink,
  type ProductEventRow,
} from "./productEventScopeDbWriter";

function row(index: number): ProductEventRow {
  return {
    uuid: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    event: "activity_open",
    source: "web",
    timestamp: "2026-10-05T10:00:00.000Z",
    received_at: "2026-10-05T10:00:01.000Z",
    analytics_id: null,
    server_id: null,
    client_session_id: "tab-1",
    app_version: null,
    platform: null,
    properties: { from: "rail" },
  };
}

async function ingestCount(outcome: string): Promise<number> {
  const metric = await register.getSingleMetric("slock_product_event_ingest_total")?.get();
  return metric?.values.find((value) => value.labels.outcome === outcome)?.value ?? 0;
}

test("rows are written in batches with the product ingest statement", async () => {
  const inserts: Array<{ lines: number; statement: string }> = [];
  const sink = new ScopeDbProductEventSink({ endpoint: "x", apiKey: "y", batchSize: 2, flushIntervalMs: 60_000 }, {
    insert: async (data: string, statement: string) => {
      inserts.push({ lines: data.split("\n").length, statement });
      return { num_rows_inserted: data.split("\n").length };
    },
  } as never);
  const writtenBefore = await ingestCount("written");

  sink.enqueue([row(1)]);
  assert.equal(inserts.length, 0, "below batch size: waits for the timer");
  sink.enqueue([row(2), row(3)]);
  await sink.flush();

  assert.deepEqual(inserts.map((insert) => insert.lines), [2, 1]);
  assert.ok(inserts.every((insert) => insert.statement === PRODUCT_EVENTS_INGEST_STATEMENT));
  assert.equal((await ingestCount("written")) - writtenBefore, 3);
});

test("a failed write and a full queue are counted as lost, never thrown", async () => {
  const sink = new ScopeDbProductEventSink({ endpoint: "x", apiKey: "y", batchSize: 2, maxQueueSize: 3, flushIntervalMs: 60_000 }, {
    insert: async () => {
      throw new Error("insert failed for 11111111-1111-4111-8111-111111111111");
    },
  } as never);
  const lostBefore = await ingestCount("lost");

  sink.enqueue([row(1)]);
  sink.enqueue([row(2), row(3), row(4), row(5)]); // 5 queued > max 3: 2 dropped
  await sink.flush();

  assert.equal((await ingestCount("lost")) - lostBefore, 5);
});

test("concurrent flushes share one drain, so shutdown waits for every queued row", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const written: number[] = [];
  const sink = new ScopeDbProductEventSink({ endpoint: "x", apiKey: "y", batchSize: 2, flushIntervalMs: 60_000 }, {
    insert: async (data: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      written.push(data.split("\n").length);
      return { num_rows_inserted: data.split("\n").length };
    },
  } as never);

  sink.enqueue([row(1), row(2)]); // full batch: starts a drain
  sink.enqueue([row(3), row(4), row(5)]); // more rows while it runs
  await Promise.all([sink.flush(), sink.flush()]);

  assert.equal(maxInFlight, 1, "never two writes at once");
  assert.equal(written.reduce((a, b) => a + b, 0), 5, "the awaited flush covers rows queued mid-drain");
});
