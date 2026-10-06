import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";
import express from "express";
import type { TraceDeploymentIdentity } from "./tracing/traceDeploymentIdentity";

// Dedicated registry (avoids polluting the global default)
export const register = new Registry();
register.setDefaultLabels({ app: "slock-server" });

export function configureMetricsDeploymentIdentity(identity: TraceDeploymentIdentity) {
  register.setDefaultLabels({
    app: "slock-server",
    service_instance_id: identity.serviceInstanceId,
    deployment_instance_source: identity.deploymentInstanceSource,
    deployment_identity_state: identity.deploymentIdentityState,
    ...(identity.ecsTaskId ? { ecs_task_id: identity.ecsTaskId } : {}),
  });
}

// Collect default Node.js metrics (event loop lag, heap, GC, active handles)
collectDefaultMetrics({ register, prefix: "slock_" });

/** Presence marker for the private application metrics endpoint. */
export const appMetricsInfo = new Gauge({
  name: "slock_app_metrics_info",
  help: "Constant 1 when the slock-server private application metrics endpoint is exporting metrics",
  registers: [register],
});
appMetricsInfo.set(1);

// ---------------------------------------------------------------------------
// Socket.io metrics
// ---------------------------------------------------------------------------

/** Currently connected Socket.io clients */
export const socketConnectedClients = new Gauge({
  name: "slock_socketio_connected_clients",
  help: "Number of currently connected Socket.io clients",
  labelNames: ["transport"] as const,
  registers: [register],
});

/** Total Socket.io disconnections by reason */
export const socketDisconnects = new Counter({
  name: "slock_socketio_disconnects_total",
  help: "Total Socket.io disconnections",
  labelNames: ["reason"] as const,
  registers: [register],
});

/** Total sync:resume attempts and their outcomes */
export const syncResumeTotal = new Counter({
  name: "slock_socketio_sync_resume_total",
  help: "Total sync:resume requests",
  labelNames: ["outcome"] as const, // ok, error, has_more
  registers: [register],
});

// ---------------------------------------------------------------------------
// Redis metrics
// ---------------------------------------------------------------------------

/** Duration of syncMaxSeqFromRedis calls (hottest server→Redis path) */
export const redisSyncDuration = new Histogram({
  name: "slock_redis_sync_duration_seconds",
  help: "Latency of syncMaxSeqFromRedis calls",
  buckets: [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
  registers: [register],
});

/** Total Redis client errors by client name */
export const redisErrors = new Counter({
  name: "slock_redis_errors_total",
  help: "Total Redis client errors",
  labelNames: ["client"] as const, // redis, redis_pub, redis_sub, redis_replica_sub
  registers: [register],
});

/** Redis connection status per client (1=connected, 0=disconnected) */
export const redisConnected = new Gauge({
  name: "slock_redis_connected",
  help: "Redis connection status (1=connected, 0=disconnected)",
  labelNames: ["client"] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// HTTP request metrics
// ---------------------------------------------------------------------------

/**
 * Total HTTP requests observed by the main Express app.
 * Labels intentionally stay low-cardinality so this can be safely expanded on.
 */
export const httpRequestsTotal = new Counter({
  name: "slock_http_requests_total",
  help: "Total HTTP requests handled by the main app",
  labelNames: ["route_pattern", "method", "status_bucket"] as const,
  registers: [register],
});

/**
 * End-to-end request duration for the main Express app.
 * Uses the same low-cardinality labels as request totals.
 * The 2 s bucket is the SLO v1 latency threshold (task #431): "share of /api
 * requests done within 2 s" reads le="2" directly.
 */
export const httpRequestDuration = new Histogram({
  name: "slock_http_request_duration_seconds",
  help: "End-to-end HTTP request duration for the main app",
  labelNames: ["route_pattern", "method", "status_bucket"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10],
  registers: [register],
});

/**
 * SLO v1 SLI 4 (task #431): a message reaches the daemon within 60 s.
 * Counted per pending ack record (one per agent:deliver until it settles), not
 * per send, so 5 s ack retries do not inflate the denominator.
 * online_at_first_attempt: the target machine's socket was open on the
 * tracking replica when the record was created. SLI 4 uses "true" only; a
 * record created after a failed first send ("false") is an offline delivery.
 * Records live in replica memory: one that vanishes in a drain has no outcome,
 * so read SLI 4 as acked-within-60s / tracked, never acked / settled.
 */
export const agentDeliveryTrackedTotal = new Counter({
  name: "slock_agent_delivery_tracked_total",
  help: "Agent deliveries that started waiting for a daemon ack",
  labelNames: ["online_at_first_attempt"] as const,
  registers: [register],
});

/** First send to daemon ack, measured from the record's first attempt. */
export const agentDeliveryAckSeconds = new Histogram({
  name: "slock_agent_delivery_ack_seconds",
  help: "Time from first agent:deliver attempt to the daemon ack",
  labelNames: ["online_at_first_attempt"] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

/**
 * How each pending ack record ended: acked, gave_up (ack retries exhausted),
 * dropped (retry gate), routed (handed to the owning replica, which tracks it
 * again), terminal (mention terminal error or identity drift), agent_stopped,
 * converted_to_wake (daemon rejected delivery, server started the agent),
 * replica_shutdown.
 */
export const agentDeliveryOutcomesTotal = new Counter({
  name: "slock_agent_delivery_outcomes_total",
  help: "Outcomes of agent deliveries waiting for a daemon ack",
  labelNames: ["outcome", "online_at_first_attempt"] as const,
  registers: [register],
});

/**
 * Machine websocket connections refused by this replica. A refusal never
 * becomes an HTTP request, so it is invisible to the request metrics above.
 * reason="draining": a connection that arrived after the drain started
 * (task #268). Post-deploy readouts report it beside SLO v1 SLI 3.
 */
export const machineConnectionsRefusedTotal = new Counter({
  name: "slock_machine_connections_refused_total",
  help: "Machine websocket connections refused by this replica",
  labelNames: ["reason"] as const,
  registers: [register],
});

/**
 * Raw Slack Events API requests are registered before express.json() so their
 * signature-sensitive body stays byte-for-byte intact. That also puts them
 * before the general request-observability middleware. Keep a dedicated,
 * low-cardinality counter here so an operator can distinguish provider
 * non-delivery from a request rejected before durable ingress without logging
 * the body, signature, token, provider event ID, or internal row IDs.
 *
 * Each request records one `arrival` observation and one terminal observation.
 * `delivery` records only whether Slack retry headers were present; their
 * values are intentionally never labels.
 */
export const slackBridgeIngressObservationsTotal = new Counter({
  name: "slock_slack_bridge_ingress_observations_total",
  help: "Slack Events API ingress observations by closed stage, outcome, and retry-header presence",
  labelNames: ["stage", "outcome", "delivery"] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Database pool metrics
// ---------------------------------------------------------------------------

export const dbPoolConnections = new Gauge({
  name: "slock_db_pool_connections",
  help: "PostgreSQL pool connections by pool and state",
  labelNames: ["pool", "state"] as const, // total, idle
  registers: [register],
});

export const dbPoolWaitingRequests = new Gauge({
  name: "slock_db_pool_waiting_requests",
  help: "Requests waiting for a PostgreSQL pool connection",
  labelNames: ["pool"] as const,
  registers: [register],
});

export const pgPoolReadOnlyClientRecycledTotal = new Counter({
  name: "slock_pg_pool_read_only_client_recycled_total",
  help: "Postgres pool clients destroyed after SQLSTATE 25006/read-only transaction errors",
  labelNames: ["pool"] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Read-mutation worker metrics
// ---------------------------------------------------------------------------

/** Fair-worker drain cycles, including otherwise invisible empty polls. */
export const readMutationWorkerDrainsTotal = new Counter({
  name: "slock_read_mutation_worker_drains_total",
  help: "Read-mutation fair-worker drain cycles by closed outcome",
  labelNames: ["outcome"] as const, // empty, processed, failed, error
  registers: [register],
});

/** End-to-end duration of each fair-worker drain cycle. */
export const readMutationWorkerDrainDuration = new Histogram({
  name: "slock_read_mutation_worker_drain_duration_seconds",
  help: "End-to-end duration of read-mutation fair-worker drain cycles",
  labelNames: ["outcome"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

/**
 * Requests from pre-frontier clients for which Done snapshots the current
 * canonical content frontier at admission. This is the retirement signal for
 * the temporary backwards-compatibility branch.
 */
export const legacyDoneFrontierFallbacksTotal = new Counter({
  name: "slock_legacy_done_frontier_fallbacks_total",
  help: "Done admissions that defaulted an omitted frontier to the current canonical latest",
  labelNames: ["target_kind"] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Attachment lifecycle / GC metrics
// ---------------------------------------------------------------------------

export const attachmentLifecycleSweepsTotal = new Counter({
  name: "slock_attachment_lifecycle_sweeps_total",
  help: "Attachment lifecycle sweep attempts by closed outcome",
  labelNames: ["outcome"] as const,
  registers: [register],
});

export const attachmentLifecycleGcOutcomesTotal = new Counter({
  name: "slock_attachment_lifecycle_gc_outcomes_total",
  help: "Attachment object GC lease outcomes",
  labelNames: ["outcome"] as const,
  registers: [register],
});

export const attachmentLifecycleGcJobs = new Gauge({
  name: "slock_attachment_lifecycle_gc_jobs",
  help: "Current attachment object GC jobs by durable state",
  labelNames: ["state"] as const,
  registers: [register],
});

export const attachmentLifecycleGcOldestPendingSeconds = new Gauge({
  name: "slock_attachment_lifecycle_gc_oldest_pending_seconds",
  help: "Age in seconds of the oldest non-completed attachment object GC job",
  registers: [register],
});

// ---------------------------------------------------------------------------
// ScopeDB typed trace-event sink metrics
// ---------------------------------------------------------------------------

/** Whether the direct ScopeDB trace-event sink is enabled for this process. */
export const scopeDbTraceSinkEnabled = new Gauge({
  name: "slock_scopedb_trace_sink_enabled",
  help: "Whether the direct ScopeDB trace-event sink is enabled (1) or disabled (0)",
  registers: [register],
});

/** Number of typed trace rows currently waiting in the direct ScopeDB sink. */
export const scopeDbTraceSinkQueueRows = new Gauge({
  name: "slock_scopedb_trace_sink_queue_rows",
  help: "Typed trace rows currently queued for the direct ScopeDB sink",
  registers: [register],
});

/** Direct ScopeDB sink flush attempts by closed outcome. */
export const scopeDbTraceSinkFlushesTotal = new Counter({
  name: "slock_scopedb_trace_sink_flushes_total",
  help: "Direct ScopeDB trace-event sink flush attempts",
  labelNames: ["outcome"] as const, // success, error
  registers: [register],
});

/** Typed rows accepted by ScopeDB after a successful direct-sink flush. */
export const scopeDbTraceSinkRowsExportedTotal = new Counter({
  name: "slock_scopedb_trace_sink_rows_exported_total",
  help: "Typed trace rows exported successfully by the direct ScopeDB sink",
  registers: [register],
});

/** Typed rows dropped by the direct ScopeDB sink, grouped by a closed reason. */
export const scopeDbTraceSinkRowsDroppedTotal = new Counter({
  name: "slock_scopedb_trace_sink_rows_dropped_total",
  help: "Typed trace rows dropped by the direct ScopeDB sink",
  labelNames: ["reason"] as const, // queue_full, export_error
  registers: [register],
});

/** Unix timestamp of the most recent successful direct-sink flush. */
export const scopeDbTraceSinkLastSuccessTimestamp = new Gauge({
  name: "slock_scopedb_trace_sink_last_success_timestamp_seconds",
  help: "Unix timestamp of the most recent successful direct ScopeDB sink flush",
  registers: [register],
});

/** Unix timestamp of the most recent failed direct-sink flush. */
export const scopeDbTraceSinkLastErrorTimestamp = new Gauge({
  name: "slock_scopedb_trace_sink_last_error_timestamp_seconds",
  help: "Unix timestamp of the most recent failed direct ScopeDB sink flush",
  registers: [register],
});

// ---------------------------------------------------------------------------
// S3/R2 storage metrics
// ---------------------------------------------------------------------------

export const s3PutRequestsTotal = new Counter({
  name: "slock_s3_put_requests_total",
  help: "Total S3-compatible storage PutObject attempts",
  labelNames: ["bucket", "endpoint_host", "outcome"] as const,
  registers: [register],
});

export const s3PutDuration = new Histogram({
  name: "slock_s3_put_duration_seconds",
  help: "Latency of S3-compatible storage PutObject calls",
  labelNames: ["bucket", "endpoint_host", "outcome"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

export const s3SocketPoolSocketsInUse = new Gauge({
  name: "slock_s3_socket_pool_sockets_in_use",
  help: "Busy sockets in the S3-compatible storage HTTP agent",
  labelNames: ["bucket", "endpoint_host"] as const,
  registers: [register],
});

export const s3SocketPoolQueueLength = new Gauge({
  name: "slock_s3_socket_pool_queue_length",
  help: "Queued requests waiting for a socket in the S3-compatible storage HTTP agent",
  labelNames: ["bucket", "endpoint_host"] as const,
  registers: [register],
});

/**
 * Counts how many times the AWS SDK's @smithy/node-http-handler emitted its own
 * "socket usage at capacity" saturation warning for our S3 client. The SDK
 * fires this once-per-15s when sockets-in-use >= maxSockets AND queued
 * requests >= 2*maxSockets — i.e. the canonical "we are about to start
 * stalling" threshold the SDK author considered alert-worthy. This counter
 * is the dedicated alert signal: spikes mean we are racing the request rate
 * against the pool, regardless of whether each individual PutObject still
 * eventually completes.
 *
 * Per-put gauges (`s3_socket_pool_sockets_in_use` / `_queue_length`) describe
 * point-in-time state; this counter describes incident-threshold crossings.
 *
 * stdrc 2026-05-08 #engineering:dfe362e7 ("把tracing也加上") — observability
 * follow-up to PR #1457's hotfix.
 */
export const s3SocketPoolSaturationTotal = new Counter({
  name: "slock_s3_socket_pool_saturation_total",
  help: "Times the SDK socket pool saturation warning has fired for the S3-compatible storage client",
  labelNames: ["bucket", "endpoint_host"] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Metrics HTTP server
// ---------------------------------------------------------------------------

const METRICS_PORT = Number(process.env.METRICS_PORT) || 9091;

export function startMetricsServer() {
  const app = express();

  app.get("/metrics", async (_req, res) => {
    try {
      res.set("Content-Type", register.contentType);
      res.end(await register.metrics());
    } catch (err) {
      res.status(500).end(String(err));
    }
  });

  app.listen(METRICS_PORT, process.env.METRICS_HOST || "0.0.0.0", () => {
    console.log(`[Metrics] Prometheus endpoint on :${METRICS_PORT}/metrics`);
  });
}

/**
 * RFC-067 client product events by outcome: written | gated (user or workspace
 * controls) | unconfigured (no product store) | lost (store accepted fewer) |
 * rejected_<reason> (registry, timestamp, malformed body). decision_support:
 * counts are lower bounds.
 */
export const productEventIngestTotal = new Counter({
  name: "slock_product_event_ingest_total",
  help: "RFC-067 client product events by ingest outcome",
  labelNames: ["outcome"] as const,
  registers: [register],
});

/** RFC 073 durable tasks: lifecycle events per kind (created, succeeded, retry, needs_attention, fenced). */
export const durableTasksTotal = new Counter({
  name: "slock_durable_tasks_total",
  help: "Durable task lifecycle events by kind and closed outcome",
  labelNames: ["kind", "outcome"] as const,
  registers: [register],
});

/** Open durable tasks per kind, and how many of them are overdue (lease expired, not yet recovered). */
export const durableTasksOpenGauge = new Gauge({
  name: "slock_durable_tasks_open",
  help: "Open durable tasks per kind by lease status",
  labelNames: ["kind", "lease"] as const, // lease: active | overdue
  registers: [register],
});
