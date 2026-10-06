// ScopeDB adapter for RFC-067 product events.
//
// Product events live in their own ScopeDB workspace with their own key:
// ScopeDB has no per-table grants, so the key boundary is what keeps product
// data apart from diagnostics (RFC-067 §3.5, §7). Rows follow PostHog's event
// shape (docs/analytics/product-events.md) and carry only analytics_id as the
// user key, never a Raft user id.
//
// Requests only enqueue; a background flush writes batches with a committed
// insert, so ScopeDB sees a few large writes instead of one per request.

import { Client } from "scopedb";
import type { AnalyticsId, ProductEventSource, ServerId } from "@botiverse/raft-shared";
import { productEventIngestTotal } from "../metrics";
import { errorClassOf } from "../tracing/semanticTrace";
import type { ScopeDbPersistenceTier } from "./scopeDbSdkPolicy";

export const PRODUCT_EVENTS_SCOPEDB_PERSISTENCE_TIER: ScopeDbPersistenceTier = "decision_support";

export const PRODUCT_EVENTS_TABLE = "product.events";

export interface ProductEventRow {
  uuid: string;
  event: string;
  source: ProductEventSource;
  /** ISO time the action happened. */
  timestamp: string;
  /** ISO time the row was received. */
  received_at: string;
  analytics_id: AnalyticsId | null;
  server_id: ServerId | null;
  client_session_id: string | null;
  app_version: string | null;
  platform: string | null;
  properties: Readonly<Record<string, string | number | boolean>>;
}

export interface ProductEventSink {
  /** Queues rows for the next flush. Never throws; losses are counted. */
  enqueue(rows: readonly ProductEventRow[]): void;
  /** Writes everything queued so far (server shutdown, tests). */
  flush(): Promise<void>;
}

const COLUMNS: ReadonlyArray<readonly [keyof ProductEventRow, string]> = [
  ["uuid", "string"],
  ["event", "string"],
  ["source", "string"],
  ["timestamp", "timestamp"],
  ["received_at", "timestamp"],
  ["analytics_id", "string"],
  ["server_id", "string"],
  ["client_session_id", "string"],
  ["app_version", "string"],
  ["platform", "string"],
  ["properties", "object"],
];

export const PRODUCT_EVENTS_INGEST_STATEMENT = [
  "SELECT",
  COLUMNS.map(([column, type]) => `$0["${column}"]::${type} AS ${column}`).join(", "),
  `INSERT INTO ${PRODUCT_EVENTS_TABLE}`,
  `(${COLUMNS.map(([column]) => column).join(", ")})`,
].join(" ");

function countRows(outcome: "written" | "lost", count: number): void {
  if (count > 0) productEventIngestTotal.inc({ outcome }, count);
}

export class ScopeDbProductEventSink implements ProductEventSink {
  private readonly client: Pick<Client, "insert">;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxQueueSize: number;
  private queue: ProductEventRow[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  // Single flight: one drain at a time; every flush() caller (timer, full
  // batch, shutdown) awaits the same drain, which empties the whole queue.
  private draining: Promise<void> | null = null;

  constructor(
    config: { endpoint: string; apiKey: string; batchSize?: number; flushIntervalMs?: number; maxQueueSize?: number },
    client?: Pick<Client, "insert">,
  ) {
    this.client = client ?? new Client(config.endpoint, { apiKey: config.apiKey });
    this.batchSize = Math.max(1, config.batchSize ?? 500);
    this.flushIntervalMs = Math.max(1, config.flushIntervalMs ?? 2_000);
    this.maxQueueSize = Math.max(this.batchSize, config.maxQueueSize ?? 20_000);
  }

  enqueue(rows: readonly ProductEventRow[]): void {
    this.queue.push(...rows);
    const overflow = this.queue.length - this.maxQueueSize;
    if (overflow > 0) {
      this.queue.splice(0, overflow);
      countRows("lost", overflow);
    }
    if (this.queue.length >= this.batchSize) void this.flush();
    else this.scheduleFlush();
  }

  flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.draining) {
      this.draining = this.drain().finally(() => {
        this.draining = null;
      });
    }
    return this.draining;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      await this.writeBatch(this.queue.splice(0, this.batchSize));
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  private async writeBatch(rows: ProductEventRow[]): Promise<void> {
    // Persistence tier: decision_support. Committed insert; rows lost to a
    // failed write or a full queue are counted, never retried.
    try {
      const result = await this.client.insert(
        rows.map((row) => JSON.stringify(row)).join("\n"),
        PRODUCT_EVENTS_INGEST_STATEMENT,
      );
      countRows("written", result.num_rows_inserted);
      countRows("lost", rows.length - result.num_rows_inserted);
    } catch (err) {
      countRows("lost", rows.length);
      // Error class only: the store's error text may echo row contents.
      console.warn("[product-events] ScopeDB write failed:", errorClassOf(err));
    }
  }
}

/** Null until the product workspace's endpoint and key are configured. */
export function createProductEventSinkFromEnv(env: NodeJS.ProcessEnv = process.env): ProductEventSink | null {
  const endpoint = env.SCOPEDB_PRODUCT_ENDPOINT;
  const apiKey = env.SCOPEDB_PRODUCT_WRITE_KEY;
  if (!endpoint || !apiKey) return null;
  return new ScopeDbProductEventSink({ endpoint, apiKey });
}
