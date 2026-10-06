// Client product-event ingest (RFC-067 §6).
//
// Web and desktop send registered interaction events in batches. Each batch is
// for one server (the request's X-Server-Id, membership already checked) and
// one signed-in user. The user's Raft id never reaches the store: rows carry
// the analytics id from productAnalyticsGate, and only when the user and the
// workspace allow client events. Anything outside the registry is rejected
// and counted, never stored.

import type { Application } from "express";
import { z } from "zod";
import {
  PRODUCT_EVENT_STRING_TOKEN,
  validateProductEvent,
  type AnalyticsId,
  type ProductEventRejection,
  type ServerId,
} from "@botiverse/raft-shared";
import { productEventIngestTotal } from "../metrics";
import {
  createProductEventSinkFromEnv,
  type ProductEventRow,
  type ProductEventSink,
} from "./productEventScopeDbWriter";

export const PRODUCT_EVENT_SINK_APP_KEY = "productEventSink";

export const MAX_CLIENT_EVENTS_PER_BATCH = 100;
// Client clocks drift and batches wait in a queue; anything outside this
// window is a broken clock or a replay, not an event worth keeping.
const MAX_EVENT_AGE_MS = 24 * 60 * 60_000;
const MAX_EVENT_FUTURE_MS = 5 * 60_000;

const shortToken = z.string().max(64).regex(PRODUCT_EVENT_STRING_TOKEN);
const propertyValue = z.union([z.string().max(256), z.number(), z.boolean()]);

export const clientEventBatchSchema = z.object({
  source: z.enum(["web", "desktop"]),
  app_version: z.string().max(64).regex(/^[0-9A-Za-z._+-]+$/).optional(),
  platform: shortToken.optional(),
  events: z.array(z.object({
    uuid: z.uuid(),
    event: z.string().max(64),
    timestamp: z.iso.datetime({ offset: true }),
    client_session_id: z.uuid().optional(),
    properties: z.record(z.string().max(64), propertyValue).optional(),
  }).strict()).min(1).max(MAX_CLIENT_EVENTS_PER_BATCH),
}).strict();

export type ClientEventBatch = z.infer<typeof clientEventBatchSchema>;

type IngestRejection = ProductEventRejection | "timestamp_out_of_range" | "duplicate";

// replica-local: best-effort dedup only. A client never retries a batch, so
// duplicates are rare; readers still dedupe by uuid across replicas.
const RECENT_UUID_LIMIT = 50_000;
const recentUuids = new Set<string>();

/** True the first time this replica sees `uuid` (within the recent window). */
export function rememberEventUuid(uuid: string): boolean {
  if (recentUuids.has(uuid)) return false;
  recentUuids.add(uuid);
  if (recentUuids.size > RECENT_UUID_LIMIT) {
    // Sets iterate in insertion order: drop the oldest.
    const oldest = recentUuids.values().next().value;
    if (oldest !== undefined) recentUuids.delete(oldest);
  }
  return true;
}

export interface ClientEventRowsResult {
  rows: ProductEventRow[];
  rejected: Partial<Record<IngestRejection, number>>;
}

export function buildClientEventRows(input: {
  batch: ClientEventBatch;
  analyticsId: AnalyticsId;
  serverId: ServerId;
  receivedAt: Date;
}): ClientEventRowsResult {
  const rows: ProductEventRow[] = [];
  const rejected: Partial<Record<IngestRejection, number>> = {};
  const reject = (reason: IngestRejection) => {
    rejected[reason] = (rejected[reason] ?? 0) + 1;
  };
  const now = input.receivedAt.getTime();
  for (const event of input.batch.events) {
    if (!rememberEventUuid(event.uuid)) {
      reject("duplicate");
      continue;
    }
    const properties = event.properties ?? {};
    const validation = validateProductEvent(event.event, properties, input.batch.source);
    if (!validation.ok) {
      reject(validation.reason);
      continue;
    }
    const occurredAt = Date.parse(event.timestamp);
    if (occurredAt < now - MAX_EVENT_AGE_MS || occurredAt > now + MAX_EVENT_FUTURE_MS) {
      reject("timestamp_out_of_range");
      continue;
    }
    rows.push({
      uuid: event.uuid,
      event: validation.event,
      source: input.batch.source,
      timestamp: new Date(occurredAt).toISOString(),
      received_at: input.receivedAt.toISOString(),
      analytics_id: input.analyticsId,
      server_id: input.serverId,
      client_session_id: event.client_session_id ?? null,
      app_version: input.batch.app_version ?? null,
      platform: input.batch.platform ?? null,
      properties,
    });
  }
  return { rows, rejected };
}

export function getProductEventSink(app: Application): ProductEventSink | null {
  if (app.get(PRODUCT_EVENT_SINK_APP_KEY) === undefined) {
    app.set(PRODUCT_EVENT_SINK_APP_KEY, createProductEventSinkFromEnv());
  }
  return app.get(PRODUCT_EVENT_SINK_APP_KEY) as ProductEventSink | null;
}

export type IngestOutcome = "written" | "gated" | "unconfigured" | "lost" | "rejected_malformed" | `rejected_${IngestRejection}`;

export function countIngest(outcome: IngestOutcome, count: number): void {
  if (count > 0) productEventIngestTotal.inc({ outcome }, count);
}
