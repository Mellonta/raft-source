import { usesPostgresReadBackend } from "./db/readBackend";
import { getChannelConversionAudienceCutover, applyChannelConversionAudienceRealtimeCutover } from "./services/channelConversionService";
import { startChannelConversionWorker } from "./services/channelConversionWorker";
import { emitChannelConversionCompletion, emitChannelConversionState, emitJointLimitStateChange } from "./routes/channels";
import "dotenv/config";

// Safety net: log unhandled rejections instead of crashing the process
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled rejection at:", promise, "reason:", reason);
});

import { createServer } from "node:http";
import { initDatabase, setDbTracer, startPoolMetricsReporting } from "./db/index";
import { installAuditedGlobalFetch } from "./db/ambientTransaction";
import { createApp } from "./app";
import { setupSocket } from "./socket/index";
import { setupMachineWebSocket } from "./routes/daemon";
import { AgentOrchestrator } from "./services/agentOrchestrator";
import { startOnboardingBriefingOnActivation } from "./services/onboardingBriefingOnActivation";
import { setIO as setBillingIO, cleanupWebhookEvents } from "./services/billingService";
import { cleanupExpiredSessions } from "./services/sessionService";
import { pruneExpiredAgentApiIdempotencyKeys } from "./services/agentApiIdempotencyService";
import { pruneExpiredAgentAppEvents } from "./services/agentAppEventsService";
import { serializeErrorForLog } from "./tracing/safeErrorLog";
import { setStorageTracer } from "./services/storageService";
import {
  createDurableAttachmentUploadSessionService,
  startAttachmentUploadSessionCleanup,
} from "./services/attachmentUploadSessionService";
import { startAttachmentLifecycleSweep } from "./services/attachmentLifecycleService";
import { startReminderArmWatchdog } from "./services/reminderArmWatchdog";
import { startMobilePushOutboxWorker } from "./services/pushService";
import { startReadMutationWorker } from "./services/readMutationSequencer";
import { startAppNotificationDeliveryWorker } from "./services/appNotificationDeliveryService";
import { startAgentInboxPushWorker } from "./services/agentInboxPushService";
import { startComputerOutageNotificationWorker } from "./services/computerOutageNotificationService";
import { startAgentMigrationReceiptOutboxWorker } from "./services/agentMigrationReceiptService";
import { startAgentMigrationRemediationWorker } from "./services/agentMigrationRemediationWorker";
import { startDurableTaskRecovery } from "./services/durableTasks";
import { getProductEventSink } from "./services/productEventIngest";
import { durableTaskRegistry } from "./services/durableTaskRegistry";
import { startChannelMembershipRoleOutboxWorker } from "./services/channelMembershipRoleOutbox";
import { startAgentRuntimeProvisionWorker } from "./services/agentRuntimeProvisionService";
import { enforceDowngradeLimits } from "./services/downgradeEnforcement";
import { onJointLimitStateChanged, sweepJointOverLimit } from "./services/jointChannelLimitService";
import { initRedis, shutdownRedis } from "./redis";
import { configureMetricsDeploymentIdentity, startMetricsServer } from "./metrics";
import { createServerTracerFromEnv } from "./tracing/serverTracer";
import { startEventLoopDelaySampler } from "./tracing/eventLoopDelay";
import { setReplicaRouterTracer } from "./replicaRouter";
import { resolveTraceDeploymentIdentity } from "./tracing/traceDeploymentIdentity";
import { errorClassOf, recordTraceEvent, withTraceRoot } from "./tracing/semanticTrace";
import { getWebCorsOriginOption } from "./config/appUrl";
import { createSlackBridgeServerRuntimeFromEnv } from "./services/slackBridgeServerRuntime";
import {
  deliverExternalInboundCommittedMessageToAgents,
  emitExternalProjectionMessageToFrontend,
  emitExternalReactionMessageUpdateToFrontend,
  runExternalInboundCommitSideEffects,
} from "./services/messageService";
import { shutdownServerRuntime } from "./serverShutdown";
import { startDrainCoordinator, type DrainSignalSourceName } from "./services/drainCoordinator";
import { DEFAULT_DRAIN_CLOSE_SPREAD_MS } from "./services/machineDrain";
import { sharedSseStreamRegistry } from "./services/sseStreamRegistry";
import { initializeTranslationProviderConfig } from "./services/messageTranslationService";
import { isRisingWaveConfigured } from "./db/risingwave";


const PORT = Number(process.env.PORT) || 3001;
const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_URL_READ_REPLICA = process.env.DATABASE_URL_READ_REPLICA;

const CORS_ORIGIN = getWebCorsOriginOption();

if (!DATABASE_URL) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET environment variable is required");
  process.exit(1);
}

// Upstream requires RisingWave. Mellonta deployments explicitly select the
// PostgreSQL backend; both choices serve all inbox and unread read paths.
if (process.env.NODE_ENV === "production" && !usesPostgresReadBackend() && !isRisingWaveConfigured()) {
  console.error("RISINGWAVE_DATABASE_URL environment variable is required in production (RisingWave is a hard dependency)");
  process.exit(1);
}

async function bootstrap() {
  // Install the audited global fetch BEFORE any request path runs. No-op unless
  // RAFT_TX_POOL_AUDIT_FILE is set, so production fetch is untouched.
  installAuditedGlobalFetch();

  // Translation configuration is loaded before the HTTP server starts. In
  // deployed SSM mode a missing/invalid parameter set must fail closed rather
  // than leaving a server that advertises translation but cannot safely run it.
  await initializeTranslationProviderConfig();

  // Initialize PostgreSQL database
  await initDatabase(DATABASE_URL!, DATABASE_URL_READ_REPLICA);
  console.log("[Slock] Database connected");

  // Initialize Redis (optional — enables multi-replica support)
  const REDIS_URL = process.env.REDIS_URL;
  if (REDIS_URL) {
    initRedis(REDIS_URL);
    console.log("[Slock] Redis initialized");
  }

  // Storage must be resolved only after its tracer is installed; otherwise
  // the startup-owned direct-upload service would permanently cache an
  // untraced S3 backend.
  const traceDeploymentIdentity = await resolveTraceDeploymentIdentity();
  configureMetricsDeploymentIdentity(traceDeploymentIdentity);
  const serverTracer = createServerTracerFromEnv(process.env, traceDeploymentIdentity);
  setDbTracer(serverTracer.tracer);
  setStorageTracer(serverTracer.tracer);
  setReplicaRouterTracer(serverTracer.tracer);
  startPoolMetricsReporting();

  // Resolve direct-upload capability once at server startup. Clients consume
  // the resulting server-owned threshold/limit projection; they never copy
  // storage or plan constants locally.
  const attachmentUploadSessionService = createDurableAttachmentUploadSessionService();
  let slackBridgeSocket: ReturnType<typeof setupSocket> | null = null;
  // Error-system boundary: background bridge errors must surface in telemetry,
  // not only the console. The bridge ticks run inside their own root spans, so
  // this event is tied to the tick that failed. The classification here is the
  // bounded identity (exception name / typeof); closed reasons live with each
  // call site inside the bridge.
  const reportSlackBridgeError = (site: string) => (error: unknown) => {
    console.error(`[SlackBridge] ${site} failed:`, error);
    recordTraceEvent("server.slack_bridge.error", {
      site,
      outcome: "error",
      reason: "bridge_worker_threw",
      error_class: errorClassOf(error),
    });
  };
  // Cross replica routed handlers and the hourly maintenance sweeps run outside
  // any request trace. Each run gets its own root span (closed site plus
  // bounded attrs). A failure ends the span with error and records the
  // `server.background.error` event inside it.
  const runBackgroundWork = (
    name: "server.background.maintenance" | "server.background.routed_handler",
    attrs: Record<string, string>,
    work: () => Promise<unknown>,
  ) => withTraceRoot(
    serverTracer.tracer,
    name,
    { surface: "server", kind: "internal", attrs },
    work,
    "server.background.error",
  );
  const slackBridge = await createSlackBridgeServerRuntimeFromEnv(process.env, {
    tracer: serverTracer.tracer,
    onLifecycleError: reportSlackBridgeError("lifecycle"),
    onOutboundError: reportSlackBridgeError("outbound"),
    onInboundMessageCommitted: async ({ messageId }) => {
      await runExternalInboundCommitSideEffects(
        async () => {
          if (!slackBridgeSocket) throw new Error("Slack Bridge Socket.IO runtime is unavailable");
          await emitExternalProjectionMessageToFrontend(slackBridgeSocket, messageId);
        },
        async () => {
          // Agents on the bound channel/thread must see the inbound message
          // too. Without this the Slack-side human thinks the agent is alive
          // but never gets an answer (Inferact report, task #221).
          const agentOrchestrator = app.get("agentOrchestrator") as AgentOrchestrator | undefined;
          if (agentOrchestrator) {
            await deliverExternalInboundCommittedMessageToAgents(agentOrchestrator, messageId);
          }
        },
      );
    },
    onInboundReactionCommitted: async ({ messageId }) => {
      if (!slackBridgeSocket) throw new Error("Slack Bridge Socket.IO runtime is unavailable");
      await emitExternalReactionMessageUpdateToFrontend(slackBridgeSocket, messageId);
    },
  });
  const app = createApp({
    attachmentUploadSessionService: attachmentUploadSessionService ?? undefined,
    slackBridge,
  });
  app.set("slackBridgePrivacyRevalidator", slackBridge?.revalidateChannelPrivacy);

  // Create HTTP server
  const server = createServer(app);

  // The production ALB holds idle keep-alive connections for 300s (measured
  // 2026-09-29, slock-prod-alb idle_timeout). The server must out-idle the
  // balancer so the balancer is always the side that closes first; with the
  // Node default (5s) the server closes sockets the ALB still considers
  // reusable, and the next request on such a socket races the close and
  // fails with 502 (task #261). headersTimeout must exceed keepAliveTimeout
  // (Node requirement).
  server.keepAliveTimeout = Number(process.env.SLOCK_HTTP_KEEP_ALIVE_TIMEOUT_MS) || 310_000;
  server.headersTimeout = Number(process.env.SLOCK_HTTP_HEADERS_TIMEOUT_MS) || 320_000;

  app.set("serverTracer", serverTracer.tracer);

  // Setup Agent Orchestrator
  const agentOrchestrator = new AgentOrchestrator(undefined, undefined, serverTracer.tracer);
  app.set("agentOrchestrator", agentOrchestrator);

  // Initialize cross-replica routing (Redis pub/sub) if Redis is available
  const { initReplicaRouter } = await import("./replicaRouter");
  const replicaReplayEndpoint = await resolveReplicaReplayEndpoint(PORT);
  await initReplicaRouter(
    (machineId, message) => {
      runBackgroundWork(
        "server.background.routed_handler",
        { site: "routed_machine_command", machine_id: machineId },
        () => agentOrchestrator.handleRoutedMachineCommand(machineId, message),
      ).catch((err) => {
        console.error(`[ReplicaRouter] Failed to handle routed machine command for ${machineId}:`, err);
      });
    },
    (agentId, machineId, message) => {
      runBackgroundWork(
        "server.background.routed_handler",
        { site: "routed_inbox_delivery", agent_id: agentId },
        () => agentOrchestrator.handleRoutedInboxDelivery(agentId, machineId, message),
      ).catch((err) => {
        console.error(`[ReplicaRouter] Failed to handle routed inbox delivery for ${agentId}:`, err);
      });
    },
    (agentId) => {
      agentOrchestrator.handleRoutedExternalWakeSignal(agentId);
    },
    replicaReplayEndpoint,
    async (machineId, principalKind) => {
      try {
        await runBackgroundWork(
          "server.background.routed_handler",
          { site: "machine_principal_fence", machine_id: machineId, principal_kind: principalKind },
          () => agentOrchestrator.fenceMachinePrincipalConnections(machineId, principalKind),
        );
      } catch (err) {
        console.error(`[ReplicaRouter] Failed to fence ${principalKind} connection for ${machineId}:`, err);
      }
    },
    (agentId, machineId, message, deliveryOptions) => (
      agentOrchestrator.handleRoutedInboxDeliveryWithReceipt(agentId, machineId, message, deliveryOptions)
    ),
    (request) => agentOrchestrator.handleStartIntent(request),
  );

  // Setup Machine WebSocket BEFORE Socket.io (since Socket.io intercepts all upgrade events)
  setupMachineWebSocket(server, agentOrchestrator, serverTracer.tracer);

  // Setup Socket.io with auth (must be after machine WS to avoid intercepting /daemon/connect)
  const io = setupSocket(server, CORS_ORIGIN);
  slackBridgeSocket = io;
  app.set("io", io);
  agentOrchestrator.setIO(io);
  setBillingIO(io);
  onJointLimitStateChanged((parentJointId) => emitJointLimitStateChange(io, parentJointId));

  // Brief Cindy whenever she actually comes up — not only when a user happens to press a
  // button that starts her. A computer switched on the next morning wakes her through the
  // daemon, which touches no HTTP route, and that was the one path the briefing retry did
  // not cover.
  startOnboardingBriefingOnActivation({ io, orchestrator: agentOrchestrator });

  // Hourly maintenance — downgrade enforcement + webhook event cleanup
  const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const runMaintenance = () => {
    runBackgroundWork(
      "server.background.maintenance",
      { site: "enforce_downgrade_limits" },
      () => enforceDowngradeLimits(agentOrchestrator, serverTracer.tracer),
    ).catch((err) => {
      console.error("[Slock] Enforcement check failed:", err);
    });
    // Contract v0.3 §18.8: observe joints that went over their free-server
    // cap with nobody posting, so the notice appears and the grace expires on
    // time. Idempotent: only the first observation sets over_limit_since.
    runBackgroundWork(
      "server.background.maintenance",
      { site: "joint_over_limit_sweep" },
      () => sweepJointOverLimit(),
    ).catch((err) => {
      console.error("[Slock] Joint over-limit sweep failed:", serializeErrorForLog(err));
    });
    runBackgroundWork(
      "server.background.maintenance",
      { site: "cleanup_webhook_events" },
      () => cleanupWebhookEvents(),
    ).catch((err) => {
      console.error("[Slock] Webhook event cleanup failed:", err);
    });
    // Expired sessions, replay receipts and refresh-token lineage rows
    // (`session_token_predecessors`) are only bounded by this sweep.
    runBackgroundWork(
      "server.background.maintenance",
      { site: "cleanup_expired_sessions" },
      () => cleanupExpiredSessions(),
    ).catch((err) => {
      console.error("[Slock] Session cleanup failed:", serializeErrorForLog(err));
    });
    // Agent API idempotency keys are valid for 24 hours; expired ledger rows
    // are only bounded by this sweep (bounded batches per tick).
    runBackgroundWork(
      "server.background.maintenance",
      { site: "prune_agent_api_idempotency_keys" },
      () => pruneExpiredAgentApiIdempotencyKeys(),
    ).catch((err) => {
      console.error("[Slock] Agent API idempotency key cleanup failed:", serializeErrorForLog(err));
    });
    // Events apps send to agents are kept 30 days after they expire (Agent
    // panel history); only this sweep bounds the table (bounded batches per tick).
    runBackgroundWork(
      "server.background.maintenance",
      { site: "prune_agent_app_events" },
      () => pruneExpiredAgentAppEvents(),
    ).catch((err) => {
      console.error("[Slock] Agent app event cleanup failed:", serializeErrorForLog(err));
    });
  };
  setTimeout(runMaintenance, 10_000); // Run once 10s after startup
  setInterval(runMaintenance, MAINTENANCE_INTERVAL_MS);

  const stopAttachmentUploadSessionCleanup = attachmentUploadSessionService
    ? startAttachmentUploadSessionCleanup(attachmentUploadSessionService, serverTracer.tracer)
    : () => {};
  // Disabled by default until artifact inventory/parity and the rollout
  // capability authorize physical lifecycle work.
  const stopAttachmentLifecycleSweep = startAttachmentLifecycleSweep({ tracer: serverTracer.tracer });

  // Reminder arm watchdog: resyncs missing Computer armed(revision) receipts.
  // It never fires/wakes; due-time authority is Computer-local.
  const reminderArmWatchdog = startReminderArmWatchdog({ orchestrator: agentOrchestrator, tracer: serverTracer.tracer });
  const mobilePushOutboxWorker = startMobilePushOutboxWorker({ tracer: serverTracer.tracer });
  const readMutationWorker = startReadMutationWorker({ tracer: serverTracer.tracer });
  const appNotificationDeliveryWorker = startAppNotificationDeliveryWorker({ tracer: serverTracer.tracer });
  const agentInboxPushWorker = startAgentInboxPushWorker({ agentOrchestrator, tracer: serverTracer.tracer });
  const computerOutageNotificationWorker = startComputerOutageNotificationWorker();
  const agentMigrationReceiptOutboxWorker = startAgentMigrationReceiptOutboxWorker({
    io,
    orchestrator: agentOrchestrator,
  });
  const agentMigrationRemediationWorker = startAgentMigrationRemediationWorker({
    io,
    orchestrator: agentOrchestrator,
  });
  // RFC 073: recover durable tasks whose inline run was lost. Off unless DURABLE_TASKS_ENABLED=true.
  const durableTaskRecovery = startDurableTaskRecovery({ registry: durableTaskRegistry, tracer: serverTracer.tracer });
  const conversionWorker = startChannelConversionWorker(async job => {
    applyChannelConversionAudienceRealtimeCutover(io, await getChannelConversionAudienceCutover(job.id));
    if (job.status === "done" || job.status === "canceled" || job.status === "failed") await emitChannelConversionCompletion(io, job.id, job.sourceChannelId);
    else await emitChannelConversionState(io, job.sourceChannelId);
  }, sourceChannelId => emitChannelConversionState(io, sourceChannelId), slackBridge?.revalidateChannelPrivacy, serverTracer.tracer);
  const channelMembershipRoleOutboxWorker = startChannelMembershipRoleOutboxWorker({ io, tracer: serverTracer.tracer });
  const agentRuntimeProvisionWorker = startAgentRuntimeProvisionWorker();

  // Start Prometheus metrics endpoint
  startMetricsServer();

  // Start server
  server.listen({ port: PORT, host: process.env.HOST || undefined }, () => {
    slackBridge?.start();
    console.log(`[Slock] Server listening on http://localhost:${PORT}`);
    serverTracer.tracer.emitEvent("slock.server.started", { surface: "server" });
    startEventLoopDelaySampler(serverTracer.tracer);
  });

  // Going-away phase (task #261): when ECS begins draining this task, close
  // long-lived connections deliberately — daemon WebSockets get 1001
  // (going-away) so daemons reconnect to a healthy task within their normal
  // 0–5s jitter instead of being hard-cut by the ALB at deregistration
  // expiry, and SSE streams are ended so those clients reconnect
  // immediately. Idempotent: the drain detector fires it early and SIGTERM
  // re-runs it as a fallback. Must only run once draining has started, or
  // reconnecting daemons would be routed back onto this task.
  // Bounded exit. Long-lived connections were already closed by the
  // going-away phase, so the drain above should settle in milliseconds;
  // the deadline only covers stragglers and must stay below the ECS task
  // stopTimeout (30s by default), after which SIGKILL cuts us anyway.
  const shutdownDeadlineMs = Number(process.env.SLOCK_SHUTDOWN_DEADLINE_MS) || 25_000;
  // Total budget for the going-away stagger. Daemons below computer-v1.0.38
  // have no reconnect jitter (fixed ~1s), so this stagger is the only thing
  // spreading their reconnects. Sized with the ALB deregistration delay,
  // which is the window it runs inside (task #261).
  const drainSpreadMs = Number(process.env.SLOCK_DRAIN_CLOSE_SPREAD_MS) || DEFAULT_DRAIN_CLOSE_SPREAD_MS;

  let goingAwayStarted = false;
  const beginGoingAway = (trigger: "ecs_drain" | "signal", source: DrainSignalSourceName | "sigterm") => {
    if (goingAwayStarted) return;
    goingAwayStarted = true;
    // The SIGTERM fallback must finish its stagger before the deadline;
    // the ECS-drain trigger fires minutes early and can afford the full
    // configured spread.
    const spreadMs = trigger === "ecs_drain"
      ? drainSpreadMs
      : Math.min(drainSpreadMs, Math.max(0, shutdownDeadlineMs - 5_000));
    // `drain_trigger_source` is the acceptance signal for the drain window
    // (task #268): the drained side must read `control_plane`. `metadata`
    // means the control-plane probe never fired (IAM not applied, API
    // unreachable) and the drain ran at the ALB cut, i.e. too late.
    console.log(`[Slock] Entering drain: sending going-away to long-lived connections (trigger=${trigger}, drain_trigger_source=${source}, spreadMs=${spreadMs})`);
    serverTracer.tracer.emitEvent("slock.server.drain_started", {
      surface: "server",
      attrs: { drain_trigger: trigger, drain_trigger_source: source, drain_spread_ms: spreadMs },
    });
    void agentOrchestrator.closeMachineConnectionsForDrain({ spreadMs }).then(({ closed, spanMs }) => {
      // Measured values, not configured ones: the acceptance readings for
      // task #261 compare the actual span against the configured budget.
      console.log(`[Slock] Drain going-away: closed ${closed} machine connection(s), actual span ${spanMs}ms (configured spreadMs=${spreadMs})`);
    });
    const sseEnded = sharedSseStreamRegistry.endAll();
    if (sseEnded > 0) console.log(`[Slock] Drain going-away: ended ${sseEnded} SSE stream(s)`);
    io.disconnectSockets(true);
  };

  // The ALB severs connections to a draining target the moment the
  // deregistration delay expires, and ECS sends SIGTERM at roughly the same
  // moment, so a SIGTERM-triggered going-away can never beat the hard cut.
  // The signal has to come from the start of draining. Measured on staging
  // 2026-09-29 (task #268): the task's own metadata v4 endpoint only flips
  // DesiredStatus to STOPPED at the cut (+306..317 s, closed 0), while the
  // ECS control plane reports desiredStatus=STOPPED from drain start. So the
  // primary probe is DescribeTasks on this task (needs ecs:DescribeTasks on
  // the task role, modules/server-service), with the metadata endpoint as a
  // second path into the same latch. SLOCK_DRAIN_DETECTOR_DISABLED=1 is the
  // operational kill switch.
  const ecsMetadataUri = process.env.SLOCK_DRAIN_DETECTOR_DISABLED === "1"
    ? undefined
    : process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (ecsMetadataUri) {
    startDrainCoordinator({
      metadataUri: ecsMetadataUri,
      onDrain: (source) => beginGoingAway("ecs_drain", source),
      onControlPlaneReadiness: (ready, reason) => {
        // Startup diagnostics, not the verdict: IAM is eventually consistent,
        // so the first probes after an apply may fail and then recover. The
        // acceptance reads drain_trigger_source on the drained side.
        console.log(`[Slock] drain_control_plane_ready=${ready}${ready ? "" : ` (${reason instanceof Error ? reason.message : String(reason)})`}`);
        serverTracer.tracer.emitEvent("slock.server.drain_control_plane_ready", { surface: "server", attrs: { drain_control_plane_ready: ready } });
      },
    }).catch((err: unknown) => {
      // Backstop only: startDrainCoordinator is written not to throw. An
      // unobserved rejection here would be the #426 failure shape (a detached
      // promise taking the process down), so it is observed and logged.
      console.warn("[Slock] Drain coordinator failed to start; drain will fall back to SIGTERM:", err);
    });
  }

  // Graceful shutdown — close WebSocket connections before exiting
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[Slock] Shutting down...");
    // Fallback going-away: if the drain detector never fired (no metadata
    // endpoint, or the signal arrived without a drain window), close
    // long-lived connections now so they do not hold `server.close()` open
    // until the deadline.
    beginGoingAway("signal", "sigterm");
    stopAttachmentUploadSessionCleanup();
    stopAttachmentLifecycleSweep();
    reminderArmWatchdog.stop();
    mobilePushOutboxWorker.stop();
    readMutationWorker.stop();
    appNotificationDeliveryWorker.stop();
    agentInboxPushWorker.stop();
    computerOutageNotificationWorker.stop();
    agentMigrationReceiptOutboxWorker.stop();
    agentMigrationRemediationWorker.stop();
    durableTaskRecovery.stop();
    channelMembershipRoleOutboxWorker.stop();
    agentRuntimeProvisionWorker.stop();
    conversionWorker.stop();
    shutdownServerRuntime({
      stopAcceptingHttp: () => new Promise<void>((resolve) => {
        server.close((error) => {
          if (error) console.warn("[Slock] Failed to drain HTTP server:", error);
          resolve();
        });
      }),
      releaseMachineOwnership: async () => {
        const [orchestratorResult, slackBridgeResult] = await Promise.allSettled([
          agentOrchestrator.shutdown(),
          slackBridge?.stop() ?? Promise.resolve(),
        ]);
        if (orchestratorResult.status === "rejected") {
          console.warn("[Slock] Failed to shutdown agent orchestrator:", orchestratorResult.reason);
        }
        if (slackBridgeResult.status === "rejected") {
          console.warn("[Slock] Failed to stop Slack Bridge:", slackBridgeResult.reason);
        }
      },
      // RFC-067: write queued product events before exit (best effort).
      flushTraces: () => Promise.allSettled([
        serverTracer.shutdown(),
        getProductEventSink(app)?.flush(),
      ]).then(() => undefined),
      shutdownSharedState: shutdownRedis,
      warn: (message, reason) => console.warn(`[Slock] ${message}:`, reason),
    }).then(() => {
      process.exit(0);
    }).catch((err) => {
      console.warn("[Slock] Failed to complete server shutdown:", err);
      process.exit(0);
    });
    // Bounded exit: long-lived connections were already closed by the
    // going-away phase, so the drain above should settle in milliseconds.
    // The deadline only covers stragglers; it must stay below the ECS task
    // stopTimeout (30s default) or SIGKILL cuts us anyway.
    setTimeout(() => process.exit(0), shutdownDeadlineMs).unref();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

type EcsTaskMetadata = {
  Containers?: Array<{
    Networks?: Array<{
      IPv4Addresses?: string[];
    }>;
  }>;
};

async function resolveReplicaReplayEndpoint(port: number): Promise<string | null> {
  const configured = process.env.SLOCK_REPLICA_REPLAY_BASE_URL || process.env.REPLICA_REPLAY_BASE_URL;
  if (configured) return configured;

  const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!metadataUri) return null;

  try {
    const response = await fetch(`${metadataUri}/task`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) {
      console.warn(`[ReplicaRouter] ECS task metadata returned ${response.status}; replica replay endpoint disabled`);
      return null;
    }
    const task = await response.json() as EcsTaskMetadata;
    const privateIp = task.Containers
      ?.flatMap((container) => container.Networks ?? [])
      .flatMap((network) => network.IPv4Addresses ?? [])
      .find((ip) => Boolean(ip));
    if (!privateIp) {
      console.warn("[ReplicaRouter] ECS task metadata did not include a private IPv4 address; replica replay endpoint disabled");
      return null;
    }
    return `http://${privateIp}:${port}`;
  } catch (err) {
    console.warn("[ReplicaRouter] Failed to resolve ECS replica replay endpoint; replica replay disabled", err);
    return null;
  }
}

bootstrap().catch((err) => {
  console.error("[Slock] Fatal error:", err);
  process.exit(1);
});
