import { strict as assert } from "node:assert";
import { BasicTracer, MemoryTraceSink, traceEventRowsForSpan } from "@botiverse/raft-shared";
import { createTraceDbQueryTracer, runWithTraceSpan } from "./semanticTrace";
import {
  recordRisingWaveInboxBackendFailed,
  risingWaveInboxFailureAttrs,
} from "./risingWaveInboxTrace";

const TRACE_EVENT_ROW_TEST_RESOURCE = {
  serviceName: "slock-server",
  deploymentEnvironment: "test",
};

function codedError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

test("RW inbox failure producer emits typed row fields without raw sensitive details", () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "a".repeat(32),
    spanIdGenerator: () => "b".repeat(16),
  });
  const span = tracer.startSpan("server.http.request", {
    surface: "server",
    kind: "server",
  });
  const error = codedError(
    "connect failed for postgres://user:secret@rw.internal.example:4566/prod while running SELECT * FROM messages",
    "08006",
  );

  runWithTraceSpan(span, () => {
    recordRisingWaveInboxBackendFailed({
      route: "channel_unread",
      error,
      contractVersion: 2,
      queryName: "channels.unread_counts_by_user",
      terminalStatus: 500,
      poolState: {
        rw_pool_total: 10,
        rw_pool_idle: 0,
        rw_pool_waiting: 7,
      },
    });
  });
  span.end("error");

  const [recorded] = sink.getAllSpans();
  assert.ok(recorded);
  const [event] = recorded.events;
  assert.equal(event.name, "inbox.backend.failed");
  assert.equal(event.attrs?.["db.system"], "risingwave");
  assert.equal(event.attrs?.db_system, "risingwave");
  assert.equal(event.attrs?.error_kind, "rw_connect_error");
  assert.equal(event.attrs?.rw_failure_stage, "unknown");
  assert.equal(event.attrs?.sqlstate, "08006");
  assert.equal(event.attrs?.rw_pool_waiting, 7);
  assert.equal(event.attrs?.fallback_outcome, "not_attempted");

  const serializedAttrs = JSON.stringify(event.attrs);
  assert.doesNotMatch(serializedAttrs, /rw\.internal\.example/);
  assert.doesNotMatch(serializedAttrs, /secret/);
  assert.doesNotMatch(serializedAttrs, /SELECT \*/);
  assert.doesNotMatch(serializedAttrs, /postgres:\/\//);
  // Policy (2026-09-20): the failure REASON is carried; endpoint, credentials,
  // and query text are scrubbed out of it, not the whole message dropped.
  assert.equal(event.attrs?.error_message, "connect failed for <redacted-url> while running");

  const [row] = traceEventRowsForSpan(recorded, TRACE_EVENT_ROW_TEST_RESOURCE);
  assert.equal(row.db_system, "risingwave");
  assert.equal(row.inbox_backend, "rw_mv");
  assert.equal(row.inbox_route, "channel_unread");
  assert.equal(row.inbox_fallback_reason, "rw_error");
  assert.equal(row.inbox_contract_version, 2);
  assert.equal(row.query_name, "channels.unread_counts_by_user");
  assert.equal(row.error_kind, "rw_connect_error");
  assert.equal(row.error_subkind, "unknown");
  assert.equal(row.sqlstate, "08006");
  assert.equal(row.rw_pool_total, 10);
  assert.equal(row.rw_pool_idle, 0);
  assert.equal(row.rw_pool_waiting, 7);
  assert.equal(row.terminal_status, "500");
});

test("RW inbox classification distinguishes acquire timeout from query SQLSTATE", () => {
  const acquireAttrs = risingWaveInboxFailureAttrs({
    route: "all",
    error: new Error("timeout exceeded when trying to connect"),
    contractVersion: 2,
  });
  assert.equal(acquireAttrs.error_kind, "rw_acquire_timeout");
  assert.equal(acquireAttrs.rw_failure_stage, "acquire");
  assert.equal(acquireAttrs.driver_code, "PG_POOL_CONNECT_TIMEOUT");

  const queryAttrs = risingWaveInboxFailureAttrs({
    route: "all",
    error: codedError("relation does not exist: private table name", "42P01"),
    contractVersion: 2,
  });
  assert.equal(queryAttrs.error_kind, "rw_query_error");
  assert.equal(queryAttrs.rw_failure_stage, "query");
  assert.equal(queryAttrs.sqlstate, "42P01");
  assert.equal(queryAttrs.error_message, "relation does not exist: private table name");
});

test("RW inbox classification does not infer connect stage from in-flight reset errors", () => {
  const resetAttrs = risingWaveInboxFailureAttrs({
    route: "unread",
    error: codedError("read ECONNRESET while query was running", "ECONNRESET"),
    contractVersion: 2,
  });
  assert.equal(resetAttrs.error_kind, "rw_connect_error");
  assert.equal(resetAttrs.rw_failure_stage, "unknown");
  assert.equal(resetAttrs.driver_code, "ECONNRESET");
  assert.equal(resetAttrs.error_message, "read ECONNRESET while query was running");

  const refusedAttrs = risingWaveInboxFailureAttrs({
    route: "unread",
    error: codedError("connect ECONNREFUSED", "ECONNREFUSED"),
    contractVersion: 2,
  });
  assert.equal(refusedAttrs.error_kind, "rw_connect_error");
  assert.equal(refusedAttrs.rw_failure_stage, "connect");
});

test("RW inbox classification does not infer connect stage from socket message text", () => {
  const attrs = risingWaveInboxFailureAttrs({
    route: "mentions",
    error: new Error("socket terminated while query was running"),
    contractVersion: 2,
  });
  assert.equal(attrs.error_kind, "rw_connect_error");
  assert.equal(attrs.rw_failure_stage, "unknown");
  assert.equal(attrs.driver_code, "RW_DRIVER_UNKNOWN");
  assert.equal(attrs.error_message, "socket terminated while query was running");
});

test("generic db query failures are labeled postgresql and never receive RW-only fields", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "e".repeat(32),
    spanIdGenerator: () => "f".repeat(16),
  });
  const span = tracer.startSpan("server.http.request", {
    surface: "server",
    kind: "server",
  });
  await assert.rejects(
    () => runWithTraceSpan(span, async () => {
      const traceQuery = createTraceDbQueryTracer("regular.path");
      await traceQuery("regular.primary_query", async () => {
        throw new Error("primary failed");
      });
    }),
    /primary failed/,
  );
  span.end("error");

  const [recorded] = sink.getAllSpans();
  assert.ok(recorded);
  const [row] = traceEventRowsForSpan(recorded, TRACE_EVENT_ROW_TEST_RESOURCE);
  assert.equal(row.event_name, "db.query.failed");
  // Contract change (task #135): the PG default makes "not RW" distinguishable
  // from "unlabeled"; a generic failure must be postgresql, never risingwave.
  assert.equal(row.db_system, "postgresql");
  assert.notEqual(row.db_system, "risingwave");
  assert.equal(row.retryable, "false");
  assert.notEqual(row.timeout_bucket, null);
  assert.equal(row.inbox_backend, null);
  assert.equal(row.error_kind, null);
  assert.equal(row.timeout_ms, null);
  assert.equal(row.rw_pool_total, null);
});
