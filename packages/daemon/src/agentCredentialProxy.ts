import { AgentProxyBindError } from "./spawnFailureErrors";
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";
import {
  AGENT_API_EVENTS_ACK_HEADER,
  AGENT_API_EVENTS_ACK_LEASE,
  agentApiHistoryConsumptionScopeSchema,
  type AgentApiHistoryConsumptionScope,
  errorClassOf,
  isThirdPartyEventId,
  normalizeThirdPartyEventId,
  formatTraceparent,
  noopTracer,
  parseAgentApiAppSourceAckReject,
  parseTraceparent,
  sourceRefIdentityKey,
  type ActiveSpan,
  type AgentInboxSourceRef,
  type AgentMessage,
  type TraceStatus,
  type Tracer,
} from "@botiverse/raft-shared";
import type { ApmHeldFreshnessEnvelopeBody } from "./apmStateMachine";
import {
  maxInboxMessageSeq,
  normalizeInboxVisibleMessages,
  planAgentInboxSideEffect,
  sortInboxMessagesBySeq,
  type AgentInboxStateMachineEffect,
} from "./agentInboxStateMachine";
import { projectAgentInboxSnapshot } from "./agentInboxProjection";
import type { AgentInboxTargetRow } from "./agentInboxProjection";
import type { AgentAppInboxStore } from "./agentAppInbox";
import { daemonFetch, type DaemonFetchOptions } from "./daemonFetch";
import { logger } from "./logger";
import {
  createThirdPartyEventDeliveryReporter,
  thirdPartyEventIdsFromEvents,
} from "./thirdPartyEventDeliveryReporter";

type ProxyRegistration = {
  serverUrl: string;
  apiKey: string;
  agentId: string;
  launchId: string | null;
  activeCapabilities: string;
  inboxCoordinator?: AgentProxyInboxCoordinator;
  /** Phase 1 typed app Inbox store (Computer-local). Optional for legacy tests. */
  appInbox?: AgentAppInboxStore;
  tracer: Tracer;
  daemonVersion: string | null;
  computerVersion: string | null;
  /**
   * Passive AX gate this launch was spawned with (task #359). When on, the
   * daemon ledger (process-scoped, not context-scoped) must not attest model-
   * seen state for v2 sends: the CLI already scopes thread evidence to the
   * current context, and a pre-compaction boundary would reopen that gap.
   */
  passiveAx: boolean;
  /** Task #178: third-party events served under lease, keyed by batch id. Lives with the registration, so a relaunch voids them. */
  thirdPartyLeases?: Map<string, ThirdPartyEventLease>;
};

// Task #178 — serve = lease, ack = consume + report. A leased event stays in
// the Local Inbox: a later /events re-serves it under a new batch (voiding the
// old one) and an expired lease simply rejects a late ack. Leases live only in
// memory: a daemon restart means "never acked" and the server re-pushes.
type ThirdPartyEventLease = {
  batchId: string;
  eventIds: Set<string>;
  messages: AgentProxyVisibleMessage[];
  expiresAt: number;
  timer: NodeJS.Timeout;
};
const THIRD_PARTY_EVENT_LEASE_MS = 60_000;
let thirdPartyEventLeaseMs = THIRD_PARTY_EVENT_LEASE_MS;
export function __setThirdPartyEventLeaseMsForTest(ms: number | undefined): void {
  thirdPartyEventLeaseMs = ms ?? THIRD_PARTY_EVENT_LEASE_MS;
}

function thirdPartyEventIdOf(message: unknown): string | null {
  const id = (message as { third_party_event?: { id?: unknown } | null } | null)?.third_party_event?.id;
  return isThirdPartyEventId(id) ? normalizeThirdPartyEventId(id) : null;
}

function voidThirdPartyLeasesCovering(registration: ProxyRegistration, eventIds: Iterable<string>): void {
  const leases = registration.thirdPartyLeases;
  if (!leases) return;
  const ids = new Set(eventIds);
  for (const [batchId, lease] of leases) {
    for (const id of lease.eventIds) {
      if (ids.has(id)) {
        clearTimeout(lease.timer);
        leases.delete(batchId);
        break;
      }
    }
  }
}

function leaseThirdPartyEvents(
  registration: ProxyRegistration,
  messages: AgentProxyVisibleMessage[],
): { batch_id: string; event_ids: string[]; expires_at: string } {
  const leases = (registration.thirdPartyLeases ??= new Map());
  const eventIds = new Set<string>();
  for (const message of messages) {
    const id = thirdPartyEventIdOf(message);
    if (id) eventIds.add(id);
  }
  voidThirdPartyLeasesCovering(registration, eventIds);
  const batchId = randomUUID();
  const expiresAt = Date.now() + thirdPartyEventLeaseMs;
  const timer = setTimeout(() => {
    leases.delete(batchId);
  }, thirdPartyEventLeaseMs);
  timer.unref?.();
  leases.set(batchId, { batchId, eventIds, messages, expiresAt, timer });
  return { batch_id: batchId, event_ids: [...eventIds], expires_at: new Date(expiresAt).toISOString() };
}

function clearThirdPartyLeases(registration: ProxyRegistration): void {
  for (const lease of registration.thirdPartyLeases?.values() ?? []) clearTimeout(lease.timer);
  registration.thirdPartyLeases?.clear();
}

type ProxyHandle = {
  proxyUrl: string;
  proxyToken: string;
};

type ProxyServerState = {
  server: http.Server;
  proxyUrl: string;
};

type ProxyServerFactory = (handler: http.RequestListener) => http.Server;

type AppSourceAckAcceptedResponse = {
  ok: true;
  itemId: string;
  appId: string;
  notificationClass: string;
  sourceRef: AgentInboxSourceRef;
  ackAttemptId: string;
};

export type AgentProxyVisibleMessage = {
  third_party_event?: Pick<NonNullable<AgentMessage["third_party_event"]>, "id">;
  seq?: number;
  id?: string;
  message_id?: string;
  channel_id?: string;
  channelId?: string;
  sender_id?: string;
  senderId?: string;
  channel_type?: string;
  channel_name?: string;
  parent_channel_type?: string;
  parent_channel_name?: string;
  sender_type?: string;
  sender_name?: string;
  sender_description?: string | null;
  senderType?: string;
  senderName?: string;
  senderDescription?: string | null;
  content?: string;
  timestamp?: string;
  createdAt?: string;
};

export type AgentProxyInboxCoordinator = {
  getBoundary(target: string): number | undefined;
  getPendingMessages(target: string): AgentProxyVisibleMessage[];
  isMessageModelSeen?(input: { target: string; message: AgentProxyVisibleMessage }): boolean;
  /** Exact model-seen seqs for a target, ascending (task #360); merged into a send's `seenExactSeqs`. */
  getExactSeenSeqs?(target: string): number[];
  /**
   * Local Inbox contract for daemon-managed runners:
   * `/internal/agent-api/events` and `slock message check` MUST drain this
   * daemon-local queue before asking the remote server for events. The server
   * `/events` endpoint is a sync/repair fallback after local pending is empty,
   * not the primary source while the daemon has already accepted delivery.
   */
  getAllPendingMessages?(): AgentProxyVisibleMessage[];
  recordInboxSnapshot?(input: AgentProxyInboxProjectionTraceInput): void;
  consumeVisibleMessages(input: {
    historyScope?: AgentApiHistoryConsumptionScope;
    target?: string;
    messages: AgentProxyVisibleMessage[];
    boundarySeq?: number;
    source: "server_held_context" | "agent_api_events_local" | "agent_api_events_server" | "agent_api_history" | "agent_api_send_commit" | "side_effect_preflight_context";
  }): void;
  recordFreshnessDecision?(input: AgentProxyFreshnessDecision): void;
  recordDrainOutcome?(input: AgentProxyDrainOutcome): void;
  recordProxyFailure?(input: AgentProxyFailure): void;
  recordTransportNormalizedError?(input: AgentProxyTransportNormalizedError): void;
};

export type AgentProxyInboxProjectionTraceInput = {
  source: "agent_api_inbox_check";
  rows: AgentInboxTargetRow[];
  pendingMessageCount: number;
};

export type AgentProxyFreshnessAction = "send" | "task_claim" | "task_update";

export type AgentProxyFreshnessDecision = {
  action: AgentProxyFreshnessAction;
  decision: "local_hold" | "syncing_hold" | "forward" | "bypass";
  freshnessContextMode?: "inline" | "withheld";
  producerFactId?: string;
  target?: string;
  inboxTrustState: "trusted" | "untrusted";
  reason: string;
  pendingCount?: number;
  pendingMaxSeq?: number;
  modelSeenSeq?: number;
  heldMessageCount?: number;
  omittedMessageCount?: number;
};

export type AgentProxyDrainOutcome = {
  /** `daemon_pending` is Local Inbox served directly; `server_events` is the remote fallback after Local Inbox is empty. */
  source: "daemon_pending" | "server_events";
  sinceCursorKind: "latest" | "seq" | null;
  notifiedCount: number;
  drainedCount: number;
  hasMore?: boolean;
};

export type AgentProxyFailure = {
  method: string;
  pathname: string;
  queryKeys: string[];
  correlationId?: string;
  errorName: string;
  errorMessage: string;
  errorCause?: string;
  routeFamily?: AgentProxyTransportRouteFamily;
  failureClass?: AgentProxyFailureClass;
  responseStarted?: boolean;
  responseComplete?: boolean;
  causeCode?: string;
  upstreamLayer?: AgentProxyTransportNormalizedError["upstreamLayer"];
  upstreamStatus?: number;
  launchId?: string | null;
  targetHostClass?: AgentProxyTransportNormalizedError["targetHostClass"];
  downstreamCaller?: AgentProxyTransportNormalizedError["downstreamCaller"];
  upstream?: AgentProxyTransportNormalizedError["upstream"];
  responseStatusCode?: number;
  responseCode?: string;
  responseError?: string;
  suggestedNextAction?: string;
  lifecycleInvalidAgentId?: string;
  lifecycleInvalidContext?: string;
};

export type AgentProxyFailureClass =
  | "pre_response_transport"
  | "mid_response_transport"
  | "upstream_http_response";

export type AgentProxyTransportRouteFamily =
  | "action/prepare"
  | "agent-api/attachments"
  | "agent-api/attachments/comments"
  | "agent-api/events"
  | "agent-api/inbox"
  | "agent-api/messages/resolve"
  | "agent-api/messages/reactions"
  | "agent-api/send"
  | "attachments/download"
  | "attachments/upload"
  | "channel-members"
  | "channels/join"
  | "channels/leave"
  | "integrations"
  | "knowledge"
  | "profile"
  | "reminders"
  | "runtime-version"
  | "resolve-channel"
  | "server"
  | "tasks"
  | "tasks/claim"
  | "tasks/update"
  | "threads"
  | "threads/unfollow"
  | "unknown";

export type AgentProxyTransportNormalizedError = {
  normalizedCode: "transport_failure" | "server_5xx" | "local_daemon_state_invalid";
  routeFamily: AgentProxyTransportRouteFamily;
  /**
   * Same byte meaning as daemon.proxy.failed: true after any upstream
   * response bytes were observed; false for connect/early transport failures.
   */
  responseStarted: boolean;
  responseComplete: boolean;
  failureClass: AgentProxyFailureClass;
  causeCode: string;
  upstreamLayer:
    | "dns"
    | "tcp"
    | "tls"
    | "fly_edge"
    | "http_status"
    | "read_timeout"
    | "body_decode_failure"
    | "proxy_connect"
    | "unknown";
  upstreamStatus?: number;
  originalMessage?: string;
  launchId?: string | null;
  targetHostClass: "api.slock.ai" | "api.raft.build" | "custom_server" | "local_daemon";
  downstreamCaller: "cli" | "runtime" | "daemon_internal";
  upstream: "server" | "local_daemon";
};

const registrations = new Map<string, ProxyRegistration>();

const THIRD_PARTY_EVENT_DELIVERY_REPORT_RETRY_BASE_MS = 5_000;
let thirdPartyEventDeliveryReportRetryBaseMs = THIRD_PARTY_EVENT_DELIVERY_REPORT_RETRY_BASE_MS;
const thirdPartyEventDeliveryReporter = createThirdPartyEventDeliveryReporter({
  // The agent's newest registration: a relaunch replaces the runner credential.
  resolveTarget: (agentId) => {
    let latest: ProxyRegistration | null = null;
    for (const registration of registrations.values()) {
      if (registration.agentId === agentId) latest = registration;
    }
    return latest ? { serverUrl: latest.serverUrl, apiKey: latest.apiKey } : null;
  },
  fetch: (url, init) => daemonFetch(url, init, process.env, { isolationKey: AGENT_CREDENTIAL_PROXY_FETCH_ISOLATION_KEY }),
  retryBaseMs: () => thirdPartyEventDeliveryReportRetryBaseMs,
  onOutcome: (outcome) => {
    if (outcome.outcome === "reported") return;
    logger.warn(
      `[Agent ${outcome.agentId}] Third-party event delivery report ${outcome.outcome} (events=${outcome.eventCount}, pending=${outcome.pendingCount}${outcome.httpStatus ? `, http=${outcome.httpStatus}` : ""})`,
    );
  },
});
let proxyServerState: ProxyServerState | null = null;
let proxyServerStartPromise: Promise<ProxyServerState> | null = null;
let proxyServerFactory: ProxyServerFactory = createProxyServer;
const DECODED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding"]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/**
 * Undici is supposed to decode compressed upstream bodies transparently, but
 * that does not hold on every Node build (observed on the Node 26 SEA
 * binaries with an upstream that compresses regardless of accept-encoding).
 * When it fails, responseHeadersForLocalProxy has already stripped
 * content-encoding per the decoded-forwarding contract, so the CLI receives
 * headerless gzip — the 2026-09-10 "INVALID_JSON_RESPONSE / empty body"
 * fleet incident. Decode here by sniffing: a declared encoding whose magic
 * bytes are still present means undici did NOT decode; anything else passes
 * through untouched, so an already-decoded body is never double-inflated.
 */
async function decodedUpstreamBuffer(
  upstream: Response,
  onDecodeFailed: (encoding: string) => void,
): Promise<Buffer> {
  const raw = Buffer.from(await upstream.arrayBuffer());
  const encoding = (upstream.headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (!encoding || encoding === "identity") return raw;
  try {
    if ((encoding === "gzip" || encoding === "x-gzip") && raw.subarray(0, 2).equals(GZIP_MAGIC)) return gunzipSync(raw);
    if (encoding === "deflate") return inflateSync(raw);
    if (encoding === "br") return brotliDecompressSync(raw);
  } catch {
    // Usually an already-decoded body under a stale header (harmless). If it
    // was really encoded, the CLI gets unreadable bytes, so make it countable.
    onDecodeFailed(encoding);
    return raw;
  }
  return raw;
}
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const LOCAL_HELD_CONTEXT_LIMIT = 3;
const AGENT_CREDENTIAL_PROXY_HOST = "127.0.0.1";
const AGENT_CREDENTIAL_PROXY_BIND_MAX_ATTEMPTS = 3;
const AGENT_CREDENTIAL_PROXY_FETCH_ISOLATION_KEY = "agent-credential-proxy";
const AGENT_CREDENTIAL_PROXY_UPLOAD_FETCH_ISOLATION_KEY = "agent-credential-proxy:attachment-upload";
const DEFAULT_AGENT_CREDENTIAL_PROXY_UPLOAD_HEADERS_TIMEOUT_MS = 5 * 60_000;

function attachmentUploadHeadersTimeoutMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(env.SLOCK_DAEMON_ATTACHMENT_UPLOAD_HEADERS_TIMEOUT_MS || "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_AGENT_CREDENTIAL_PROXY_UPLOAD_HEADERS_TIMEOUT_MS;
}

function agentCredentialProxyFetchOptions(
  pathname: string,
  env: NodeJS.ProcessEnv,
): DaemonFetchOptions {
  if (pathname === "/internal/agent-api/upload") {
    return {
      isolationKey: AGENT_CREDENTIAL_PROXY_UPLOAD_FETCH_ISOLATION_KEY,
      headersTimeoutMs: attachmentUploadHeadersTimeoutMs(env),
    };
  }
  return { isolationKey: AGENT_CREDENTIAL_PROXY_FETCH_ISOLATION_KEY };
}

function shouldRelayAgentAttachmentRedirect(pathname: string): boolean {
  return /^\/internal\/agent-api\/attachments\/[^/]+$/.test(pathname);
}

export function __setThirdPartyEventDeliveryReportRetryBaseMsForTest(ms: number | undefined): void {
  thirdPartyEventDeliveryReportRetryBaseMs = ms ?? THIRD_PARTY_EVENT_DELIVERY_REPORT_RETRY_BASE_MS;
}

export function __agentCredentialProxyFetchOptionsForTest(
  pathname: string,
  env: NodeJS.ProcessEnv,
): DaemonFetchOptions {
  return agentCredentialProxyFetchOptions(pathname, env);
}

function createProxyRequestHandler(): http.RequestListener {
  return (req, res) => {
    void handleProxyRequest(req, res);
  };
}

function createProxyServer(handler: http.RequestListener): http.Server {
  return http.createServer(handler);
}

function listenOnLoopback(server: http.Server): Promise<ProxyServerState> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address.port !== "number") {
        reject(new Error("local proxy listen succeeded without a TCP port"));
        return;
      }
      resolve({
        server,
        proxyUrl: `http://${AGENT_CREDENTIAL_PROXY_HOST}:${address.port}`,
      });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, AGENT_CREDENTIAL_PROXY_HOST);
  });
}

function closeServerBestEffort(server: http.Server): void {
  try {
    server.close();
  } catch {
    // The server may not have reached the listening state.
  }
}

async function startProxyServer(): Promise<ProxyServerState> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= AGENT_CREDENTIAL_PROXY_BIND_MAX_ATTEMPTS; attempt += 1) {
    const server = proxyServerFactory(createProxyRequestHandler());
    try {
      const state = await listenOnLoopback(server);
      state.server.on("error", (err) => {
        logger.warn(`[Agent Credential Proxy] local proxy failed after bind: ${(err as Error).message}`);
      });
      state.server.unref();
      return state;
    } catch (err) {
      lastError = err;
      closeServerBestEffort(server);
      logger.warn(
        `[Agent Credential Proxy] local proxy bind attempt ${attempt}/${AGENT_CREDENTIAL_PROXY_BIND_MAX_ATTEMPTS} failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
  throw new AgentProxyBindError(
    `Agent Credential Proxy local proxy failed to bind ${AGENT_CREDENTIAL_PROXY_HOST} ` +
    `after ${AGENT_CREDENTIAL_PROXY_BIND_MAX_ATTEMPTS} attempts: ${detail}`,
  );
}

async function ensureServer(): Promise<ProxyServerState> {
  if (proxyServerState) return proxyServerState;
  if (!proxyServerStartPromise) {
    proxyServerStartPromise = startProxyServer();
  }
  try {
    proxyServerState = await proxyServerStartPromise;
    return proxyServerState;
  } finally {
    proxyServerStartPromise = null;
  }
}

export async function __resetAgentCredentialProxyForTest(): Promise<void> {
  registrations.clear();
  thirdPartyEventDeliveryReporter.reset();
  thirdPartyEventDeliveryReportRetryBaseMs = THIRD_PARTY_EVENT_DELIVERY_REPORT_RETRY_BASE_MS;
  const state = proxyServerState;
  proxyServerState = null;
  proxyServerStartPromise = null;
  proxyServerFactory = createProxyServer;
  if (!state) return;
  await new Promise<void>((resolve) => {
    state.server.close(() => resolve());
  });
}

export function __setAgentCredentialProxyServerFactoryForTest(factory: ProxyServerFactory | null): void {
  proxyServerFactory = factory ?? createProxyServer;
}

function responseHeadersForLocalProxy(
  upstream: Response,
  proxyCarrier?: {
    correlationId: string;
    routeFamily: AgentProxyTransportRouteFamily;
    targetHostClass: AgentProxyTransportNormalizedError["targetHostClass"];
    launchId: string | null;
  },
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of upstream.headers.entries()) {
    // Node fetch transparently decodes gzip/br responses but preserves the
    // upstream encoding headers. The local proxy forwards decoded bytes, so
    // advertising the original compressed encoding makes downstream CLI fetch
    // attempt a second decode and surface null JSON payloads.
    if (DECODED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  if (proxyCarrier) {
    headers["x-raft-correlation-id"] = proxyCarrier.correlationId;
    headers["x-raft-proxy-stream-carrier"] = "1";
    headers["x-raft-proxy-route-family"] = proxyCarrier.routeFamily;
    headers["x-raft-proxy-target-host-class"] = proxyCarrier.targetHostClass;
    if (proxyCarrier.launchId) headers["x-raft-proxy-launch-id"] = proxyCarrier.launchId;
  }
  return headers;
}

async function handleProxyRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const auth = req.headers.authorization;
  const token = typeof auth === "string" && auth.startsWith("Bearer ")
    ? auth.slice("Bearer ".length)
    : "";
  const registration = registrations.get(token);
  if (!registration) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid local agent proxy token", code: "invalid_agent_proxy_token" }));
    return;
  }

  const method = req.method ?? "GET";
  const correlationId = randomBytes(8).toString("hex");
  let target: URL | undefined;
  const inboundTraceparent = firstRequestHeader(req.headers.traceparent);
  const parent = parseTraceparent(inboundTraceparent);
  const traceContextState = parent
    ? "continued"
    : inboundTraceparent
      ? "malformed"
      : "new_root";
  let localPathname = "unknown";
  try {
    localPathname = new URL(req.url ?? "/", "http://agent-proxy.local").pathname;
  } catch {
    // Keep a closed unknown route for malformed request targets. The proxy
    // span must still close even when the upstream URL cannot be constructed.
  }
  const proxySpan: ActiveSpan = registration.tracer.startSpan("daemon.agent_proxy.request", {
    parent,
    surface: "daemon",
    kind: "client",
    attrs: {
      route_family: routeFamilyForPath(localPathname),
      // route_family folds v1 and v2 send together; keep the version visible
      // so a client route change cannot hide behind the family (task #360).
      route_path_version: localPathname.startsWith("/internal/agent-api/v2/") ? "v2" : "v1",
      method: normalizedProxyMethod(method),
      trace_context_state: traceContextState,
      proxy_launch_id_present: registration.launchId !== null,
      correlation_id: correlationId,
    },
  });
  const noteUpstreamDecodeFailed = (encoding: string): void => {
    proxySpan.addEvent("daemon.agent_proxy.upstream_decode_failed", {
      encoding,
      route_family: routeFamilyForPath(localPathname),
    });
  };
  let proxySpanStatus: TraceStatus = "error";
  let proxySpanEndAttrs: Record<string, unknown> = {
    outcome: "proxy_failure",
    normalized_code: "transport_failure",
    response_started: false,
    response_complete: false,
    failure_class: "pre_response_transport",
  };
  let upstreamResponseStarted = false;
  let upstreamResponseComplete = false;
  try {
    target = new URL(req.url ?? "/", registration.serverUrl);
    // The local bearer authorizes this agent's Raft server only. Absolute,
    // scheme-relative and backslash targets can otherwise replace the origin
    // before we attach the server-side credential.
    if (target.origin !== new URL(registration.serverUrl).origin) {
      proxySpanEndAttrs = {
        outcome: "target_rejected",
        normalized_code: "agent_proxy_origin_mismatch",
        http_status: 403,
      };
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Agent proxy target must use the registered server origin", code: "agent_proxy_origin_mismatch" }));
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      const normalizedName = name.toLowerCase();
      if (value === undefined) continue;
      if (normalizedName === "host") continue;
      if (normalizedName === "authorization") continue;
      if (normalizedName === "content-length") continue;
      // Never forward the caller's accept-encoding: undici only transparently
      // decodes compressed responses when IT negotiated the encoding, and a
      // user-supplied accept-encoding disables that (observed on Node 26).
      // Forwarding it hands us gzip bytes while responseHeadersForLocalProxy
      // strips content-encoding per the decoded-forwarding contract — the CLI
      // then parses raw gzip as JSON (INVALID_JSON_RESPONSE / "empty body").
      if (normalizedName === "accept-encoding") continue;
      if (HOP_BY_HOP_REQUEST_HEADERS.has(normalizedName)) continue;
      if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item);
      } else {
        headers.set(name, value);
      }
    }
    // First line of defense: ask the upstream for an unencoded body outright.
    // decodedUpstreamBuffer above is the backstop for upstreams that compress
    // regardless (CloudFront does, for large cached responses).
    headers.set("accept-encoding", "identity");
    headers.set("Authorization", `Bearer ${registration.apiKey}`);
    headers.set("X-Agent-Id", registration.agentId);
    headers.set("X-Raft-Client", "cli");
    headers.set("X-Slock-Agent-Active-Capabilities", registration.activeCapabilities);
    // The caller-supplied context is only a parent. Always create a daemon
    // child span and overwrite the carrier so the server/preflight requests
    // are causally joined without trusting the local caller's span identity.
    headers.set("traceparent", formatTraceparent(proxySpan.context));

    let body: BodyInit | undefined;
    let rawBodyBuffer: Buffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      rawBodyBuffer = await readRequestBody(req);
      const bodyBuffer = new ArrayBuffer(rawBodyBuffer.byteLength);
      new Uint8Array(bodyBuffer).set(rawBodyBuffer);
      body = bodyBuffer;
      headers.delete("content-length");
    }
    let sendTarget: string | undefined;
    let sideEffectFreshnessContextMode: "inline" | "withheld" | undefined;
    // v2 sends feed the ledger from their response but keep the v2 response
    // unreprojected, so their mode only steers consumption.
    let sendV2ConsumeFreshnessContextMode: "inline" | "withheld" | undefined;
    const sideEffectAction = agentApiSideEffectAction(target.pathname);
    const isMessageSendV2 = target.pathname === MESSAGE_SEND_V2_PATH;

    if (method === "GET" && target.pathname === "/internal/agent-api/runtime-version") {
      if (!registration.daemonVersion) {
        proxySpanEndAttrs = {
          outcome: "local_response_unavailable",
          local_response_kind: "runtime_version",
          http_status: 503,
        };
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: "The current daemon process did not expose a version.",
          code: "daemon_runtime_version_unavailable",
        }));
        return;
      }
      proxySpanStatus = "ok";
      proxySpanEndAttrs = {
        outcome: "local_response",
        local_response_kind: "runtime_version",
        http_status: 200,
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        daemonVersion: registration.daemonVersion,
        computerVersion: registration.computerVersion,
        observation: "live_daemon_process",
      }));
      return;
    }

    if (method === "GET" && target.pathname === "/internal/agent-api/inbox") {
      const localInbox = localAgentApiInboxResponse(registration);
      if (localInbox) {
        proxySpanStatus = "ok";
        proxySpanEndAttrs = {
          outcome: "local_response",
          local_response_kind: "inbox",
          http_status: localInbox.status,
        };
        res.writeHead(localInbox.status, { "content-type": "application/json" });
        res.end(JSON.stringify(localInbox.body));
        return;
      }
    }

    if (method === "POST" && (
      target.pathname === "/internal/agent-api/inbox/seal"
      || target.pathname === "/internal/agent-api/inbox/unseal"
    )) {
      const localSeal = localAgentApiInboxSealResponse(
        registration,
        rawBodyBuffer ?? Buffer.alloc(0),
        target.pathname.endsWith("/unseal") ? "unseal" : "seal",
      );
      proxySpanStatus = localSeal.status < 400 ? "ok" : "error";
      proxySpanEndAttrs = {
        outcome: "local_response",
        local_response_kind: `inbox_${target.pathname.endsWith("/unseal") ? "unseal" : "seal"}`,
        http_status: localSeal.status,
      };
      res.writeHead(localSeal.status, { "content-type": "application/json" });
      res.end(JSON.stringify(localSeal.body));
      return;
    }

    // Explicit app-item ack (Phase 1). inbox check itself never consumes.
    // Body was already drained into rawBodyBuffer for non-GET methods above.
    if (method === "POST" && target.pathname === "/internal/agent-api/inbox/ack") {
      const localAck = await localAgentApiInboxAckResponse(registration, headers, rawBodyBuffer ?? Buffer.alloc(0));
      proxySpanStatus = localAck.status < 400 ? "ok" : "error";
      proxySpanEndAttrs = {
        outcome: "local_response",
        local_response_kind: "inbox_ack",
        http_status: localAck.status,
      };
      res.writeHead(localAck.status, { "content-type": "application/json" });
      res.end(JSON.stringify(localAck.body));
      return;
    }

    // Task #178: the CLI acks a leased batch of third-party events after it
    // has written them out. Never forwarded: the lease is daemon state.
    if (method === "POST" && target.pathname === "/internal/agent-api/third-party-events/ack") {
      const localAck = localAgentApiThirdPartyEventsAckResponse(registration, rawBodyBuffer ?? Buffer.alloc(0));
      proxySpanStatus = localAck.status < 400 ? "ok" : "error";
      proxySpanEndAttrs = {
        outcome: "local_response",
        local_response_kind: "third_party_events_ack",
        http_status: localAck.status,
        ...localAck.attrs,
      };
      res.writeHead(localAck.status, { "content-type": "application/json" });
      res.end(JSON.stringify(localAck.body));
      return;
    }

    // Local Inbox first: a managed runner's message check is a projection of
    // the daemon's accepted-but-not-yet-visible inbox. Do not forward to the
    // server while local pending exists, or a busy runtime can receive a
    // pending notification and then see "No new messages."
    if (method === "GET" && target.pathname === "/internal/agent-api/events") {
      // Task #178: a CLI that will ack after output declares it; only then are
      // third-party events leased instead of consumed-and-reported on finish.
      const leaseThirdParty = firstRequestHeader(req.headers[AGENT_API_EVENTS_ACK_HEADER])?.trim().toLowerCase() === AGENT_API_EVENTS_ACK_LEASE;
      const localEvents = await localAgentApiEventsResponse(registration, target, { leaseThirdPartyEvents: leaseThirdParty });
      if (localEvents) {
        proxySpanStatus = "ok";
        proxySpanEndAttrs = {
          outcome: "local_response",
          local_response_kind: "events",
          http_status: localEvents.status,
        };
        const servedThirdPartyEventIds = thirdPartyEventIdsFromEvents(
          Array.isArray(localEvents.body.events) ? localEvents.body.events : [],
        );
        if (servedThirdPartyEventIds.length > 0) {
          // "lease" (task #178): consumed and reported only when the CLI acks
          // the batch after writing it out (third-party-events/ack branch).
          // "finish_fallback" (task #175): for CLIs without the ack, reported
          // once the response has been written. `finish` means "handed to the
          // OS", not "the client read it", so a CLI dying mid-read loses the
          // event; the attr lets that fallback share be read from traces
          // until every CLI acks and the path is removed.
          proxySpanEndAttrs.third_party_ack_mode = leaseThirdParty ? "lease" : "finish_fallback";
          proxySpanEndAttrs.third_party_served_count = servedThirdPartyEventIds.length;
          if (!leaseThirdParty) {
            res.once("finish", () => thirdPartyEventDeliveryReporter.report(registration.agentId, servedThirdPartyEventIds));
          }
        }
        res.writeHead(localEvents.status, { "content-type": "application/json" });
        res.end(JSON.stringify(localEvents.body));
        return;
      }
    }

    if (method === "POST" && sideEffectAction) {
      const rawBody = rawBodyBuffer?.toString("utf8") ?? "";
      const prepared = await prepareAgentApiSideEffectForward(registration, headers, rawBody, sideEffectAction);
      if (prepared.localResponse) {
        proxySpanStatus = "ok";
        proxySpanEndAttrs = {
          outcome: "local_response",
          local_response_kind: "freshness_hold",
          http_status: 200,
        };
        const responseText = JSON.stringify(prepared.localResponse);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(responseText);
        return;
      }
      body = prepared.bodyText;
      if (sideEffectAction === "send") sendTarget = prepared.target;
      sideEffectFreshnessContextMode = prepared.freshnessContextMode;
      headers.set("content-type", "application/json");
      headers.delete("content-length");
    } else if (method === "POST" && isMessageSendV2) {
      // task #360 follow-up: the CLI sends through v2 since #7035, which the
      // side-effect preflight above never matched, so the daemon's model-seen
      // facts never reached a real send. Forward-only: lift `seenUpToSeq` and
      // union exact seqs; never answer a v2 send locally (the hold stays the
      // Server's). A passiveAx launch skips the enrichment: the daemon ledger
      // is process-scoped, not context-scoped. The response still feeds the
      // ledger (held context, own commit) exactly as v1 does.
      const rawBody = rawBodyBuffer?.toString("utf8") ?? "";
      const prepared = registration.passiveAx
        ? describeSendBodyForConsumption(rawBody)
        : await prepareAgentApiSideEffectForward(registration, headers, rawBody, "send", { localHold: false });
      body = prepared.bodyText;
      sendTarget = prepared.target;
      sendV2ConsumeFreshnessContextMode = prepared.freshnessContextMode;
      headers.set("content-type", "application/json");
      headers.delete("content-length");
    }

    const upstream = await daemonFetch(
      target,
      {
        method,
        headers,
        body,
        redirect: shouldRelayAgentAttachmentRedirect(target.pathname) ? "manual" : "follow",
      },
      process.env,
      agentCredentialProxyFetchOptions(target.pathname, process.env),
    );
    upstreamResponseStarted = true;

    const shouldBufferReviewerIsolationResponse =
      sideEffectFreshnessContextMode === "withheld"
      && Boolean(sideEffectAction);
    if (
      upstream.status >= 500 ||
      shouldBufferReviewerIsolationResponse
      || shouldBufferJsonResponse(upstream, target.pathname, registration)
    ) {
      let responseText: string;
      try {
        responseText = (await decodedUpstreamBuffer(upstream, noteUpstreamDecodeFailed)).toString("utf8");
        upstreamResponseComplete = true;
      } catch (err) {
        const transportError = transportNormalizedErrorForError(target, err, registration.launchId, {
          responseStarted: true,
          responseComplete: false,
        });
        const failure = proxyFailureForError(method, target, err, {
          correlationId,
          transportError,
        });
        logger.warn(formatProxyFailureLogMessage(registration, failure));
        registration.inboxCoordinator?.recordProxyFailure?.(failure);
        registration.inboxCoordinator?.recordTransportNormalizedError?.(transportError);
        proxySpanStatus = "error";
        proxySpanEndAttrs = proxyFailureSpanAttrs(transportError);
        writeProxyFailureResponse(res, failure);
        return;
      }
      if (upstream.status >= 500) {
        const transportError = transportNormalizedErrorForHttpStatus(target, upstream.status, registration.launchId);
        const failure = proxyFailureForUpstreamHttpResponse(method, target, upstream.status, {
          correlationId,
          transportError,
        });
        proxySpanStatus = "error";
        proxySpanEndAttrs = {
          outcome: "upstream_5xx",
          http_status: upstream.status,
          normalized_code: transportError.normalizedCode,
          response_started: transportError.responseStarted,
          response_complete: transportError.responseComplete,
          failure_class: transportError.failureClass,
          cause_code: transportError.causeCode,
        };
        logger.warn(formatProxyFailureLogMessage(registration, failure));
        registration.inboxCoordinator?.recordProxyFailure?.(failure);
        registration.inboxCoordinator?.recordTransportNormalizedError?.(transportError);
        writeProxyFailureResponse(res, failure);
        return;
      }
      proxySpanStatus = "ok";
      proxySpanEndAttrs = {
        outcome: "upstream_response",
        http_status: upstream.status,
      };
      await consumeVisibleResponse(registration, target, sendTarget, sideEffectFreshnessContextMode ?? sendV2ConsumeFreshnessContextMode, responseText);
      const downstreamResponseText = sideEffectFreshnessContextMode === "withheld"
        ? reprojectReviewerIsolationResponse(responseText, upstream.status, target.pathname)
        : responseText;
      res.writeHead(upstream.status, responseHeadersForLocalProxy(upstream));
      res.end(downstreamResponseText);
      return;
    }

    proxySpanStatus = "ok";
    proxySpanEndAttrs = {
      outcome: "upstream_response",
      http_status: upstream.status,
    };
    res.writeHead(upstream.status, responseHeadersForLocalProxy(upstream, {
      correlationId,
      routeFamily: routeFamilyForPath(target.pathname),
      targetHostClass: daemonUpstreamTargetHostClass(target),
      launchId: registration.launchId,
    }));
    const streamEncoding = (upstream.headers.get("content-encoding") ?? "").trim().toLowerCase();
    if (upstream.body && streamEncoding && streamEncoding !== "identity") {
      // Encoded body on the streaming path: buffer-decode so the stripped
      // content-encoding header stays honest (JSON-ish responses in practice;
      // attachments are served unencoded and keep the streaming path below).
      res.end(await decodedUpstreamBuffer(upstream, noteUpstreamDecodeFailed));
      upstreamResponseComplete = true;
    } else if (upstream.body) {
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      upstreamResponseComplete = true;
      res.end();
    } else {
      upstreamResponseComplete = true;
      res.end();
    }
  } catch (err) {
    const transportError = transportNormalizedErrorForError(target, err, registration.launchId, {
      responseStarted: upstreamResponseStarted,
      responseComplete: upstreamResponseComplete,
    });
    const failure = proxyFailureForError(method, target, err, {
      correlationId,
      transportError,
    });
    logger.warn(
      formatProxyFailureLogMessage(registration, failure),
    );
    registration.inboxCoordinator?.recordProxyFailure?.(failure);
    registration.inboxCoordinator?.recordTransportNormalizedError?.(transportError);
    proxySpanStatus = "error";
    proxySpanEndAttrs = proxyFailureSpanAttrs(transportError);
    writeProxyFailureResponse(res, failure);
  } finally {
    proxySpan.end(proxySpanStatus, { attrs: proxySpanEndAttrs });
  }
}

function firstRequestHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  return value?.[0];
}

function normalizedProxyMethod(method: string): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "OTHER" {
  const normalized = method.toUpperCase();
  if (
    normalized === "GET" ||
    normalized === "POST" ||
    normalized === "PUT" ||
    normalized === "PATCH" ||
    normalized === "DELETE" ||
    normalized === "HEAD" ||
    normalized === "OPTIONS"
  ) {
    return normalized;
  }
  return "OTHER";
}

function writeProxyFailureResponse(res: http.ServerResponse, failure: AgentProxyFailure): void {
  if (res.writableEnded) return;
  if (res.headersSent) {
    // A streaming response may have already committed upstream headers and
    // partial bytes to the runtime. HTTP cannot be changed to a 502 JSON
    // envelope at that point; attempting to write headers again throws
    // ERR_HTTP_HEADERS_SENT. Close this local stream and keep the structured
    // failure in logs / inboxCoordinator instead.
    res.destroy();
    return;
  }
  const body: Record<string, unknown> = {
    error: failure.responseError ?? "failed to proxy local agent request",
    code: failure.responseCode ?? "agent_proxy_failed",
    detail: failure.errorMessage,
  };
  const proxyDiagnostics = proxyDiagnosticsForFailure(failure);
  if (proxyDiagnostics) body.proxy = proxyDiagnostics;
  if (failure.lifecycleInvalidAgentId) body.agent_id = failure.lifecycleInvalidAgentId;
  if (failure.lifecycleInvalidContext) body.invariant_context = failure.lifecycleInvalidContext;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (failure.correlationId) headers["x-raft-correlation-id"] = failure.correlationId;
  if (failure.suggestedNextAction) body.suggested_next_action = failure.suggestedNextAction;
  res.writeHead(failure.responseStatusCode ?? 502, headers);
  res.end(JSON.stringify(body));
}

function proxyFailureSpanAttrs(error: AgentProxyTransportNormalizedError): Record<string, unknown> {
  return {
    outcome: "proxy_failure",
    normalized_code: error.normalizedCode,
    response_started: error.responseStarted,
    response_complete: error.responseComplete,
    failure_class: error.failureClass,
    cause_code: error.causeCode,
    ...(error.upstreamStatus === undefined ? {} : { http_status: error.upstreamStatus }),
  };
}

function formatProxyFailureLogMessage(
  registration: ProxyRegistration,
  failure: AgentProxyFailure,
): string {
  return (
    `[Agent Credential Proxy] request failed ` +
    `(agent=${registration.agentId}, launch=${registration.launchId ?? "none"}, ` +
    `correlation=${failure.correlationId ?? "none"}, method=${failure.method}, path=${failure.pathname}, ` +
    `route_family=${failure.routeFamily ?? "unknown"}, failure_class=${failure.failureClass ?? "unknown"}, ` +
    `upstream_layer=${failure.upstreamLayer ?? "unknown"}, cause_code=${failure.causeCode ?? "UNKNOWN"}, ` +
    `response_started=${failure.responseStarted ?? false}, response_complete=${failure.responseComplete ?? false}, ` +
    `query_keys=${failure.queryKeys.join(",") || "none"}): ` +
    `${failure.errorName}: ${failure.errorMessage}${failure.errorCause ? ` (cause=${failure.errorCause})` : ""}`
  );
}

function proxyDiagnosticsForFailure(failure: AgentProxyFailure): Record<string, unknown> | undefined {
  if (!failure.correlationId && !failure.routeFamily && !failure.upstreamLayer) return undefined;
  const body: Record<string, unknown> = {
    layer: failure.upstream === "local_daemon" ? "local_daemon" : "local_daemon_proxy",
  };
  if (failure.correlationId) body.correlation_id = failure.correlationId;
  if (failure.routeFamily) body.route_family = failure.routeFamily;
  if (failure.failureClass) body.failure_class = failure.failureClass;
  if (failure.responseStarted !== undefined) body.response_started = failure.responseStarted;
  if (failure.responseComplete !== undefined) body.response_complete = failure.responseComplete;
  if (failure.causeCode) body.cause_code = failure.causeCode;
  if (failure.upstreamLayer) body.upstream_layer = failure.upstreamLayer;
  if (failure.upstreamStatus !== undefined) body.upstream_status = failure.upstreamStatus;
  if (failure.targetHostClass) body.target_host_class = failure.targetHostClass;
  if (failure.launchId !== undefined && failure.launchId !== null) body.launch_id = failure.launchId;
  if (failure.downstreamCaller) body.downstream_caller = failure.downstreamCaller;
  if (failure.upstream) body.upstream = failure.upstream;
  return body;
}

function proxyFailureForError(
  method: string,
  target: URL | undefined,
  err: unknown,
  context: {
    correlationId?: string;
    transportError?: AgentProxyTransportNormalizedError;
  } = {},
): AgentProxyFailure {
  const queryKeys = target ? [...new Set([...target.searchParams.keys()])].sort() : [];
  const cause = err instanceof Error ? err.cause : undefined;
  const errorMessage = truncateProxyErrorMessage(err instanceof Error ? err.message : String(err));
  const lifecycleInvalid = parseAgentNoProcessResidencyInvariant(errorMessage);
  const transportError = context.transportError;
  const failure: AgentProxyFailure = {
    method,
    pathname: target?.pathname ?? "unknown",
    queryKeys,
    errorName: errorClassOf(err),
    errorMessage,
  };
  if (context.correlationId) failure.correlationId = context.correlationId;
  if (transportError) {
    failure.routeFamily = transportError.routeFamily;
    failure.failureClass = transportError.failureClass;
    failure.responseStarted = transportError.responseStarted;
    failure.responseComplete = transportError.responseComplete;
    failure.causeCode = transportError.causeCode;
    failure.upstreamLayer = transportError.upstreamLayer;
    if (transportError.upstreamStatus !== undefined) failure.upstreamStatus = transportError.upstreamStatus;
    failure.launchId = transportError.launchId;
    failure.targetHostClass = transportError.targetHostClass;
    failure.downstreamCaller = transportError.downstreamCaller;
    failure.upstream = transportError.upstream;
  }
  if (lifecycleInvalid) {
    failure.responseStatusCode = 409;
    failure.responseCode = "agent_lifecycle_state_invalid";
    failure.responseError = "local daemon agent lifecycle state invalid";
    failure.lifecycleInvalidAgentId = lifecycleInvalid.agentId;
    failure.lifecycleInvalidContext = lifecycleInvalid.context;
  }
  const errorCause = describeProxyErrorCause(cause);
  if (errorCause) failure.errorCause = errorCause;
  if (
    failure.routeFamily === "attachments/upload" &&
    failure.upstreamLayer === "read_timeout" &&
    failure.errorCause?.startsWith("UND_ERR_HEADERS_TIMEOUT")
  ) {
    failure.responseCode = "ATTACHMENT_UPLOAD_TIMEOUT";
    failure.responseError = "Attachment upload timed out before the server responded";
    failure.suggestedNextAction =
      "The server may still have accepted the file. Wait briefly, then retry once if needed; if it fails again, share the Correlation value with an operator.";
  }
  return failure;
}

function proxyFailureForUpstreamHttpResponse(
  method: string,
  target: URL,
  status: number,
  context: {
    correlationId: string;
    transportError: AgentProxyTransportNormalizedError;
  },
): AgentProxyFailure {
  const queryKeys = [...new Set([...target.searchParams.keys()])].sort();
  return {
    method,
    pathname: target.pathname,
    queryKeys,
    correlationId: context.correlationId,
    errorName: "UpstreamHttpResponse",
    errorMessage: `upstream returned HTTP ${status}`,
    responseStatusCode: status,
    responseCode: "agent_proxy_failed",
    responseError: "upstream HTTP response failed",
    routeFamily: context.transportError.routeFamily,
    failureClass: context.transportError.failureClass,
    responseStarted: context.transportError.responseStarted,
    responseComplete: context.transportError.responseComplete,
    causeCode: context.transportError.causeCode,
    upstreamLayer: context.transportError.upstreamLayer,
    upstreamStatus: context.transportError.upstreamStatus,
    launchId: context.transportError.launchId,
    targetHostClass: context.transportError.targetHostClass,
    downstreamCaller: context.transportError.downstreamCaller,
    upstream: context.transportError.upstream,
  };
}

function parseAgentNoProcessResidencyInvariant(
  message: string,
): { context: string; agentId: string } | undefined {
  const match = /^Agent no-process residency invariant violation after ([^:]+): .+ for ([0-9a-f-]{36})\b/i.exec(message);
  if (!match) return undefined;
  return { context: match[1], agentId: match[2] };
}

function describeProxyErrorCause(cause: unknown): string | undefined {
  if (!cause) return undefined;
  if (cause instanceof Error) {
    const errorWithCode = cause as Error & { code?: unknown };
    const code = typeof errorWithCode.code === "string" ? errorWithCode.code : undefined;
    return truncateProxyErrorMessage([code, cause.message].filter(Boolean).join(" "));
  }
  if (typeof cause === "object") {
    const causeObject = cause as { code?: unknown; message?: unknown };
    const code = typeof causeObject.code === "string" ? causeObject.code : undefined;
    const message = typeof causeObject.message === "string" ? causeObject.message : undefined;
    const detail = [code, message].filter(Boolean).join(" ");
    if (detail) return truncateProxyErrorMessage(detail);
  }
  return truncateProxyErrorMessage(String(cause));
}

function truncateProxyErrorMessage(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized.length > 500 ? `${normalized.slice(0, 497)}...` : normalized;
}

function transportNormalizedErrorForHttpStatus(target: URL, status: number, launchId: string | null): AgentProxyTransportNormalizedError {
  const failureClass = proxyFailureClassForPhase("upstream_http_response");
  return {
    normalizedCode: "server_5xx",
    routeFamily: routeFamilyForPath(target.pathname),
    responseStarted: true,
    responseComplete: true,
    failureClass,
    causeCode: `HTTP_${status}`,
    upstreamLayer: "http_status",
    upstreamStatus: status,
    launchId,
    targetHostClass: daemonUpstreamTargetHostClass(target),
    // Today the local credential proxy is only used by CLI wrappers. If runtime
    // or daemon-internal callers use it later, plumb the caller identity here.
    downstreamCaller: "cli",
    upstream: "server",
  };
}

function transportNormalizedErrorForError(
  target: URL | undefined,
  err: unknown,
  launchId: string | null,
  phase: { responseStarted?: boolean; responseComplete?: boolean } = {},
): AgentProxyTransportNormalizedError {
  const localDaemonStateInvalid = parseAgentNoProcessResidencyInvariant(
    sanitizeTransportOriginalMessage(err instanceof Error ? err.message : String(err)),
  );
  const responseStarted = phase.responseStarted ?? false;
  const responseComplete = phase.responseComplete ?? false;
  const sourceFailureClass: AgentProxyFailureClass = responseStarted && !responseComplete
    ? "mid_response_transport"
    : "pre_response_transport";
  const failureClass = proxyFailureClassForPhase(sourceFailureClass);
  return {
    normalizedCode: localDaemonStateInvalid ? "local_daemon_state_invalid" : "transport_failure",
    routeFamily: routeFamilyForPath(target?.pathname ?? "unknown"),
    responseStarted,
    responseComplete,
    failureClass,
    causeCode: scrubbedProxyCauseCode(err, localDaemonStateInvalid ? "LOCAL_DAEMON_STATE_INVALID" : undefined),
    upstreamLayer: localDaemonStateInvalid ? "unknown" : target ? upstreamLayerForProxyError(err) : "unknown",
    originalMessage: sanitizeTransportOriginalMessage(err instanceof Error ? err.message : String(err)),
    launchId,
    targetHostClass: localDaemonStateInvalid ? "local_daemon" : target ? daemonUpstreamTargetHostClass(target) : "custom_server",
    // Today the local credential proxy is only used by CLI wrappers. If runtime
    // or daemon-internal callers use it later, plumb the caller identity here.
    downstreamCaller: "cli",
    upstream: localDaemonStateInvalid ? "local_daemon" : "server",
  };
}

function proxyFailureClassForPhase(source: AgentProxyFailureClass): AgentProxyFailureClass {
  return source;
}

export function __transportNormalizedErrorForErrorForTest(
  target: URL | undefined,
  err: unknown,
  launchId: string | null,
  phase: { responseStarted?: boolean; responseComplete?: boolean } = {},
): AgentProxyTransportNormalizedError {
  return transportNormalizedErrorForError(target, err, launchId, phase);
}

export function routeFamilyForPath(pathname: string): AgentProxyTransportRouteFamily {
  if (pathname === "/internal/agent-api/runtime-version") return "runtime-version";
  if (pathname === "/internal/agent-api/v2/send") return "agent-api/send";
  if (pathname === "/internal/agent-api/send") return "agent-api/send";
  if (pathname === "/internal/agent-api/events") return "agent-api/events";
  if (pathname === "/internal/agent-api/inbox" || pathname.startsWith("/internal/agent-api/inbox/")) return "agent-api/inbox";
  if (pathname === "/internal/agent-api/receive-ack") return "agent-api/events";
  if (pathname === "/internal/agent-api/tasks/claim") return "tasks/claim";
  if (pathname === "/internal/agent-api/tasks/update-status") return "tasks/update";
  if (pathname === "/internal/agent-api/tasks" || pathname.startsWith("/internal/agent-api/tasks/")) return "tasks";
  if (/^\/internal\/agent-api\/attachments\/[^/]+\/comments/.test(pathname)) return "agent-api/attachments/comments";
  if (pathname.startsWith("/internal/agent-api/attachments/")) return "agent-api/attachments";
  if (/^\/internal\/agent-api\/messages\/[^/]+\/resolve$/.test(pathname)) return "agent-api/messages/resolve";
  if (/^\/internal\/agent-api\/messages\/[^/]+\/reactions$/.test(pathname)) return "agent-api/messages/reactions";
  if (pathname === "/internal/agent-api/server") return "server";
  if (pathname.startsWith("/internal/agent-api/history")) return "agent-api/events";
  if (pathname.startsWith("/internal/agent-api/search")) return "agent-api/events";
  if (pathname.startsWith("/internal/agent-api/channel-members")) return "channel-members";
  if (pathname.startsWith("/internal/agent-api/knowledge")) return "knowledge";
  if (pathname === "/internal/agent-api/profile" || pathname.startsWith("/internal/agent-api/profile/")) return "profile";
  if (pathname === "/internal/agent-api/integrations" || pathname.startsWith("/internal/agent-api/integrations/")) return "integrations";
  if (pathname === "/internal/agent-api/upload") return "attachments/upload";
  if (pathname === "/internal/agent-api/resolve-channel") return "resolve-channel";
  if (pathname === "/internal/agent-api/threads") return "threads";
  if (pathname === "/internal/agent-api/threads/unfollow") return "threads/unfollow";
  if (pathname === "/internal/agent-api/prepare-action") return "action/prepare";
  if (pathname === "/internal/agent-api/reminders" || pathname.startsWith("/internal/agent-api/reminders/")) return "reminders";
  if (/^\/internal\/agent-api\/channels\/[^/]+\/join$/.test(pathname)) return "channels/join";
  if (/^\/internal\/agent-api\/channels\/[^/]+\/leave$/.test(pathname)) return "channels/leave";
  return "unknown";
}

function daemonUpstreamTargetHostClass(url: URL): AgentProxyTransportNormalizedError["targetHostClass"] {
  const hostname = url.hostname.toLowerCase();
  // The daemon proxy target is the upstream Slock server. Localhost here means
  // a local/custom server, not CLI -> daemon loopback.
  if (hostname === "api.slock.ai") return "api.slock.ai";
  if (hostname === "api.raft.build") return "api.raft.build";
  return "custom_server";
}

function upstreamLayerForProxyError(err: unknown): AgentProxyTransportNormalizedError["upstreamLayer"] {
  const code = errorCode(err).toUpperCase();
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || message.includes("dns")) return "dns";
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "UND_ERR_SOCKET" ||
    message.includes("socket")
  ) return "tcp";
  if (code.includes("TLS") || message.includes("certificate") || message.includes("tls")) return "tls";
  if (isExplicitUndiciReadTimeoutCode(code)) return "read_timeout";
  if (message.includes("proxy")) return "proxy_connect";
  if (message.includes("fly")) return "fly_edge";
  return "unknown";
}

function isExplicitUndiciReadTimeoutCode(code: string): boolean {
  return code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT";
}

function errorCode(err: unknown): string {
  if (typeof err === "object" && err && "code" in err && typeof (err as { code?: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  if (typeof err === "object" && err && "cause" in err) return errorCode((err as { cause?: unknown }).cause);
  return "";
}

function scrubbedProxyCauseCode(err: unknown, fallback = "UNKNOWN"): string {
  if (fallback !== "UNKNOWN") return fallback;
  const code = errorCode(err).toUpperCase();
  const mappedCode = safeProxyCauseCode(code);
  if (mappedCode) return mappedCode;
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause && cause !== err) {
    const mappedCause = safeProxyCauseCode(errorCode(cause).toUpperCase());
    if (mappedCause) return mappedCause;
  }
  const name = err instanceof Error ? err.name : "";
  const mappedName = safeProxyCauseCode(name.toUpperCase());
  if (mappedName) return mappedName;
  return "UPSTREAM_TRANSPORT_FAILURE";
}

const SAFE_PROXY_CAUSE_CODES = new Set([
  "ABORT_ERR",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "UPSTREAM_TRANSPORT_FAILURE",
]);

function safeProxyCauseCode(code: string): string | undefined {
  return SAFE_PROXY_CAUSE_CODES.has(code) ? code : undefined;
}

function sanitizeTransportOriginalMessage(message: string): string {
  return truncateProxyErrorMessage(message)
    .replace(/sk_(?:agent|machine|computer)_[A-Za-z0-9_-]+/g, "sk_[redacted]")
    .replace(/sap_[A-Za-z0-9_-]+/g, "sap_[redacted]")
    .replace(/https?:\/\/\S+/g, "[url]");
}

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function messageSeq(message: AgentProxyVisibleMessage): number {
  return Number(message.seq ?? 0);
}

function isThirdPartyAgentEvent(message: AgentProxyVisibleMessage): boolean {
  const thirdPartyEvent = (message as AgentProxyVisibleMessage & { third_party_event?: { id?: unknown } | null }).third_party_event;
  return typeof thirdPartyEvent?.id === "string" && thirdPartyEvent.id.length > 0;
}

export function hasStableLocalMessageId(message: AgentProxyVisibleMessage): boolean {
  const id = message.message_id ?? message.id;
  return (typeof id === "string" && id.length > 0) || isThirdPartyAgentEvent(message);
}

function localAgentApiInboxResponse(
  registration: ProxyRegistration,
): { status: number; body: Record<string, unknown> } | undefined {
  const coordinator = registration.inboxCoordinator;
  if (!coordinator && !registration.appInbox) return undefined;
  const pending = coordinator?.getAllPendingMessages?.() ?? [];
  const rows = projectAgentInboxSnapshot(pending);
  const appItems = registration.appInbox?.list() ?? [];
  const acknowledgedAppSources = registration.appInbox?.listAcknowledgedSources() ?? [];
  const seals = registration.appInbox?.listSeals() ?? [];
  const items = [
    ...rows.map((row) => ({ source: "message_target" as const, row })),
    ...appItems,
  ];
  coordinator?.recordInboxSnapshot?.({
    source: "agent_api_inbox_check",
    rows,
    pendingMessageCount: pending.length,
  });
  return {
    status: 200,
    body: {
      // message_target rows keep the legacy pure-read projection (byte-compatible).
      rows,
      // Typed union for Phase 1+ consumers (app items carry no msg id/seq/sender).
      items,
      pending_targets: rows.length,
      pending_messages: pending.length,
      pending_app_items: appItems.length,
      acknowledged_app_sources: acknowledgedAppSources,
      seals,
    },
  };
}

function isAgentInboxSourceRef(value: unknown): value is AgentInboxSourceRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.kind === "string"
    && typeof record.id === "string"
    && (record.revision === undefined || typeof record.revision === "string");
}

function parseExactAppSourceAckSuccess(
  body: Record<string, unknown>,
  expected: {
    itemId: string;
    appId: string;
    notificationClass: string;
    sourceRef: AgentInboxSourceRef;
    ackAttemptId: string;
  },
): AppSourceAckAcceptedResponse | null {
  if (body.ok !== true) return null;
  if (body.itemId !== expected.itemId) return null;
  if (body.appId !== expected.appId) return null;
  if (body.notificationClass !== expected.notificationClass) return null;
  if (body.ackAttemptId !== expected.ackAttemptId) return null;
  if (!isAgentInboxSourceRef(body.sourceRef)) return null;
  if (sourceRefIdentityKey(body.sourceRef) !== sourceRefIdentityKey(expected.sourceRef)) return null;
  return {
    ok: true,
    itemId: body.itemId,
    appId: body.appId,
    notificationClass: body.notificationClass,
    sourceRef: body.sourceRef,
    ackAttemptId: body.ackAttemptId,
  };
}

async function localAgentApiInboxAckResponse(
  registration: ProxyRegistration,
  headers: Headers,
  bodyRaw: Buffer,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const store = registration.appInbox;
  if (!store) {
    return {
      status: 404,
      body: { error: "app inbox not available for this runner", code: "app_inbox_unavailable" },
    };
  }
  let parsed: { itemId?: unknown };
  try {
    parsed = JSON.parse(bodyRaw.toString("utf8") || "{}") as { itemId?: unknown };
  } catch {
    return { status: 400, body: { error: "invalid JSON body", code: "invalid_json" } };
  }
  const itemId = typeof parsed.itemId === "string" ? parsed.itemId.trim() : "";
  if (!itemId) {
    return { status: 400, body: { error: "itemId required", code: "item_id_required" } };
  }
  const item = store.list().find((entry) => entry.itemId === itemId);
  if (!item) {
    return { status: 404, body: { error: "item not found", code: "item_not_found" } };
  }
  const protectingSeal = store.findProtectingSeal(item);
  if (protectingSeal) {
    return {
      status: 409,
      body: {
        error: `Inbox source ${item.sourceRef.id} is sealed by ${protectingSeal.owner} until ${protectingSeal.until}; unseal it explicitly before acknowledging`,
        code: "item_sealed",
      },
    };
  }
  const acked = store.ack(itemId);
  if (acked) {
    return { status: 200, body: { ok: true, itemId, remaining_app_items: store.list().length } };
  }
  const intent = store.beginServerAuthorizedAckIntent({
    itemId: item.itemId,
    ackAttemptId: randomUUID(),
  });
  if (!intent) {
    return { status: 404, body: { error: "item not found", code: "item_not_found" } };
  }

  const upstreamBody = JSON.stringify({
    itemId: item.itemId,
    appId: item.appId,
    notificationClass: item.notificationClass,
    sourceRef: item.sourceRef,
    ackAttemptId: intent.ackAttemptId,
  });
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  const target = new URL("/internal/agent-api/app-sources/ack", registration.serverUrl);
  const upstream = await daemonFetch(
    target,
    {
      method: "POST",
      headers,
      body: upstreamBody,
      redirect: "follow",
    },
    process.env,
    agentCredentialProxyFetchOptions(target.pathname, process.env),
  );
  const upstreamText = await upstream.text();
  let upstreamJson: Record<string, unknown>;
  try {
    upstreamJson = JSON.parse(upstreamText || "{}") as Record<string, unknown>;
  } catch {
    upstreamJson = { error: upstreamText || "invalid upstream response", code: "invalid_upstream_response" };
  }
  if (upstream.status >= 400) {
    const authoritativeReject = parseAgentApiAppSourceAckReject(upstream.status, upstreamJson);
    if (!authoritativeReject) {
      return { status: upstream.status, body: upstreamJson };
    }
    store.clearServerAuthorizedAckIntent({ itemId: item.itemId, ackAttemptId: intent.ackAttemptId });
    return { status: upstream.status, body: authoritativeReject };
  }
  const accepted = parseExactAppSourceAckSuccess(upstreamJson, {
    itemId: intent.itemId,
    appId: intent.appId,
    notificationClass: intent.notificationClass,
    sourceRef: intent.sourceRef,
    ackAttemptId: intent.ackAttemptId,
  });
  if (!accepted) {
    return {
      status: 502,
      body: {
        error: "Server app-source ACK response did not match the persisted exact local item intent; retry will reuse the same attempt",
        code: "invalid_app_source_ack_response",
      },
    };
  }
  const completed = store.completeServerAuthorizedAck({ itemId: item.itemId, ackAttemptId: intent.ackAttemptId });
  if (!completed) {
    return {
      status: 409,
      body: {
        error: "Server accepted source ACK but local exact item could not be retired; refresh Inbox and retry",
        code: "local_ack_completion_failed",
      },
    };
  }
  return {
    status: upstream.status,
    body: {
      ...upstreamJson,
      itemId: item.itemId,
      remaining_app_items: store.list().length,
    },
  };
}

function localAgentApiInboxSealResponse(
  registration: ProxyRegistration,
  bodyRaw: Buffer,
  action: "seal" | "unseal",
): { status: number; body: Record<string, unknown> } {
  const store = registration.appInbox;
  if (!store) {
    return {
      status: 404,
      body: { error: "app inbox not available for this runner", code: "app_inbox_unavailable" },
    };
  }
  let parsed: { sources?: unknown; owner?: unknown; until?: unknown };
  try {
    parsed = JSON.parse(bodyRaw.toString("utf8") || "{}") as typeof parsed;
  } catch {
    return { status: 400, body: { error: "invalid JSON body", code: "invalid_json" } };
  }
  const rawSources = Array.isArray(parsed.sources) ? parsed.sources : [];
  const sources = rawSources.filter((source): source is {
    appId: string;
    notificationClass: string;
    sourceRef: AgentInboxSourceRef;
  } => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return false;
    const value = source as Record<string, unknown>;
    return typeof value.appId === "string"
      && value.appId.trim().length > 0
      && typeof value.notificationClass === "string"
      && value.notificationClass.trim().length > 0
      && isAgentInboxSourceRef(value.sourceRef);
  });
  const identityKeys = sources.map((source) => `${source.appId}\0${source.notificationClass}\0${sourceRefIdentityKey(source.sourceRef)}`);
  if (sources.length === 0 || sources.length !== rawSources.length || new Set(identityKeys).size !== sources.length) {
    return { status: 400, body: { error: "sources must contain at least one exact app source identity", code: "sources_required" } };
  }
  if (action === "seal") {
    const owner = typeof parsed.owner === "string" ? parsed.owner.trim() : "";
    const until = typeof parsed.until === "string" ? parsed.until.trim() : "";
    if (!owner || owner.length > 120 || /[\u0000-\u001f\u007f]/.test(owner)) {
      return { status: 400, body: { error: "owner must be a single-line string of at most 120 characters", code: "invalid_owner" } };
    }
    if (!until || until.length > 500 || /[\u0000-\u001f\u007f]/.test(until)) {
      return { status: 400, body: { error: "until must be a single-line string of at most 500 characters", code: "invalid_until" } };
    }
    const sealed = store.sealSources({
      sources,
      owner,
      until,
    });
    return sealed
      ? { status: 200, body: { ok: true, affected: sealed.length } }
      : { status: 400, body: { error: "one or more seal source identities are invalid", code: "invalid_seal_source" } };
  }
  const unsealed = store.unsealSources({
    sources,
  });
  return unsealed
    ? { status: 200, body: { ok: true, affected: unsealed.length } }
    : { status: 409, body: { error: "one or more source identities are not sealed", code: "source_not_sealed" } };
}

function parseAgentApiEventsQuery(target: URL): {
  limit: number;
  sinceSeq: number | null;
  sinceCursorKind: "latest" | "seq" | null;
  error?: Record<string, string>;
} {
  const limit = Math.min(Math.max(Number(target.searchParams.get("limit")) || 50, 1), 200);
  const sinceRaw = target.searchParams.get("since")?.trim() ?? "";
  if (!sinceRaw) return { limit, sinceSeq: null, sinceCursorKind: null };
  if (sinceRaw === "latest") return { limit, sinceSeq: null, sinceCursorKind: "latest" };
  const parsed = Number(sinceRaw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return {
      limit,
      sinceSeq: null,
      sinceCursorKind: null,
      error: {
        error: "since must be a non-negative integer (messageSeq) or 'latest'",
        code: "since_invalid",
      },
    };
  }
  return { limit, sinceSeq: Math.floor(parsed), sinceCursorKind: "seq" };
}

async function localAgentApiEventsResponse(
  registration: ProxyRegistration,
  target: URL,
  options: { leaseThirdPartyEvents: boolean } = { leaseThirdPartyEvents: false },
): Promise<{ status: number; body: Record<string, unknown> } | undefined> {
  const coordinator = registration.inboxCoordinator;
  if (!coordinator) return undefined;
  const pending = coordinator.getAllPendingMessages?.() ?? [];
  const parsedQuery = parseAgentApiEventsQuery(target);
  if (parsedQuery.error && pending.length > 0) {
    return { status: 400, body: parsedQuery.error };
  }
  if (pending.length === 0) return undefined;

  // Managed-runner `/events` is the check_messages projection over the daemon
  // Local Inbox. The server endpoint is only a sync/repair fallback once this
  // local source of truth is empty; otherwise a busy runtime can be notified
  // about pending inbox messages and then incorrectly see "No new messages."
  const normalized = sortInboxMessagesBySeq(normalizeInboxVisibleMessages(pending));
  const filtered = parsedQuery.sinceSeq !== null
    ? normalized.filter((message) => {
        const seq = messageSeq(message);
        // Local pending rows are already known to be unconsumed. A stable id
        // remains sufficient when a mirror/re-serialization path omitted seq;
        // do not hide that row behind a numeric cursor and fall through to a
        // misleading empty upstream response.
        if ((!Number.isFinite(seq) || seq <= 0) && hasStableLocalMessageId(message)) return true;
        return Number.isFinite(seq) && seq > parsedQuery.sinceSeq!;
      })
    : normalized;
  const events = filtered.slice(0, parsedQuery.limit);
  const hasMore = filtered.length > events.length;
  const newestEvent = events[events.length - 1];
  const lastSeenMsgId = newestEvent?.message_id ?? newestEvent?.id ?? null;
  const lastSeenSeq = newestEvent?.seq ?? parsedQuery.sinceSeq;

  // Task #178: under an ack lease, third-party events are neither consumed nor
  // reported here; they stay pending until the CLI acks the batch (or are
  // re-served under a new batch by a later /events). Ordinary messages keep
  // their existing local consumption.
  const leasedThirdParty = options.leaseThirdPartyEvents
    ? events.filter((message) => thirdPartyEventIdOf(message) !== null)
    : [];
  const consumable = leasedThirdParty.length > 0
    ? events.filter((message) => thirdPartyEventIdOf(message) === null)
    : events;
  if (consumable.length > 0) {
    // Local drain of the daemon Local Inbox is still an /events projection: it
    // can be sparse and is often reached from a wake/@mention signal. Record
    // exact ids for duplicate suppression, but do not advance model-seen
    // high-water; only verified contiguous content consumption may do that.
    coordinator.consumeVisibleMessages({ messages: consumable, source: "agent_api_events_local" });
  }
  const thirdPartyLease = leasedThirdParty.length > 0 ? leaseThirdPartyEvents(registration, leasedThirdParty) : null;
  coordinator.recordDrainOutcome?.({
    source: "daemon_pending",
    sinceCursorKind: parsedQuery.sinceCursorKind,
    notifiedCount: pending.length,
    drainedCount: events.length,
    hasMore,
  });

  return {
    status: 200,
    body: {
      events,
      last_seen_msgId: lastSeenMsgId,
      last_seen_seq: lastSeenSeq,
      reply_target: null,
      pending_notice_ids: [] as string[],
      wake_reason: null as string | null,
      has_more: hasMore,
      ...(thirdPartyLease ? { third_party_lease: thirdPartyLease } : {}),
    },
  };
}

function localAgentApiThirdPartyEventsAckResponse(
  registration: ProxyRegistration,
  bodyRaw: Buffer,
): { status: number; body: Record<string, unknown>; attrs: Record<string, unknown> } {
  let parsed: { batchId?: unknown; eventIds?: unknown };
  try {
    parsed = JSON.parse(bodyRaw.toString("utf8") || "{}") as { batchId?: unknown; eventIds?: unknown };
  } catch {
    return { status: 400, body: { error: "invalid JSON body", code: "invalid_json" }, attrs: { third_party_ack_outcome: "invalid" } };
  }
  const batchId = typeof parsed.batchId === "string" ? parsed.batchId.trim() : "";
  const rawIds: unknown[] = Array.isArray(parsed.eventIds) ? parsed.eventIds : [];
  if (!batchId || rawIds.length === 0 || !rawIds.every(isThirdPartyEventId)) {
    return {
      status: 400,
      body: { error: "batchId and a non-empty array of event ids are required", code: "ack_body_invalid" },
      attrs: { third_party_ack_outcome: "invalid" },
    };
  }
  const lease = registration.thirdPartyLeases?.get(batchId);
  if (!lease || lease.expiresAt <= Date.now()) {
    // Expired, voided by a later /events, or from another registration: the
    // events are still pending locally and will be served again. Nothing is
    // consumed or reported.
    if (lease) {
      clearTimeout(lease.timer);
      registration.thirdPartyLeases?.delete(batchId);
    }
    return {
      status: 409,
      body: { error: "lease is not live; the events will be served again on the next check", code: "lease_not_live" },
      attrs: { third_party_ack_outcome: "lease_not_live" },
    };
  }
  clearTimeout(lease.timer);
  registration.thirdPartyLeases?.delete(batchId);
  const acked = new Set<string>();
  for (const id of rawIds as string[]) {
    const normalized = normalizeThirdPartyEventId(id);
    if (lease.eventIds.has(normalized)) acked.add(normalized);
  }
  const messages = lease.messages.filter((message) => {
    const id = thirdPartyEventIdOf(message);
    return id !== null && acked.has(id);
  });
  if (messages.length > 0) {
    registration.inboxCoordinator?.consumeVisibleMessages({ messages, source: "agent_api_events_local" });
  }
  const ackedIds = [...acked];
  if (ackedIds.length > 0) thirdPartyEventDeliveryReporter.report(registration.agentId, ackedIds);
  return {
    status: 200,
    body: { ok: true, batchId, acked: ackedIds },
    attrs: { third_party_ack_outcome: "acked", third_party_ack_count: ackedIds.length },
  };
}

function recordFreshnessDecision(
  coordinator: AgentProxyInboxCoordinator | undefined,
  decision: AgentProxyFreshnessDecision,
): void {
  coordinator?.recordFreshnessDecision?.(decision);
}

const MESSAGE_SEND_V2_PATH = "/internal/agent-api/v2/send";

/** Both message send routes; v1 and v2 share the request and response shape. */
function isAgentApiSendPath(pathname: string): boolean {
  return pathname === "/internal/agent-api/send" || pathname === MESSAGE_SEND_V2_PATH;
}

function describeSendBodyForConsumption(rawBody: string): { bodyText: string; target?: string; freshnessContextMode?: "inline" | "withheld" } {
  try {
    const body = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {};
    return {
      bodyText: rawBody,
      target: sideEffectTarget("send", body),
      freshnessContextMode: body.freshnessContextMode === "withheld" ? "withheld" : "inline",
    };
  } catch {
    return { bodyText: rawBody };
  }
}

/** Exported for the route-coverage guard test. */
export function __agentApiSideEffectActionForTest(pathname: string): AgentProxyFreshnessAction | "send_v2_forward_only" | undefined {
  if (pathname === MESSAGE_SEND_V2_PATH) return "send_v2_forward_only";
  return agentApiSideEffectAction(pathname);
}

function agentApiSideEffectAction(pathname: string): AgentProxyFreshnessAction | undefined {
  if (pathname === "/internal/agent-api/send") return "send";
  if (pathname === "/internal/agent-api/tasks/claim") return "task_claim";
  if (pathname === "/internal/agent-api/tasks/update-status") return "task_update";
  return undefined;
}

function sideEffectTarget(action: AgentProxyFreshnessAction, body: Record<string, unknown>): string | undefined {
  const field = action === "send" ? body.target : body.channel;
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

async function loadRecentTargetMessages(
  registration: ProxyRegistration,
  headers: Headers,
  target: string,
): Promise<AgentProxyVisibleMessage[]> {
  const historyUrl = new URL("/internal/agent-api/history", registration.serverUrl);
  historyUrl.searchParams.set("channel", target);
  historyUrl.searchParams.set("limit", "3");
  const historyHeaders = new Headers(headers);
  historyHeaders.delete("content-length");
  historyHeaders.delete("content-type");
  const res = await daemonFetch(
    historyUrl,
    { method: "GET", headers: historyHeaders },
    process.env,
    { isolationKey: AGENT_CREDENTIAL_PROXY_FETCH_ISOLATION_KEY },
  );
  if (!res.ok) return [];
  const parsed = await res.json().catch(() => null) as { messages?: AgentProxyVisibleMessage[] } | null;
  return Array.isArray(parsed?.messages) ? normalizeInboxVisibleMessages(parsed!.messages, target) : [];
}

async function applyAgentInboxStateMachineEffects(
  coordinator: AgentProxyInboxCoordinator,
  effects: AgentInboxStateMachineEffect[],
): Promise<void> {
  for (const effect of effects) {
    if (effect.type === "record_freshness_decision") {
      recordFreshnessDecision(coordinator, effect.decision);
      continue;
    }
    coordinator.consumeVisibleMessages({
      target: effect.target,
      messages: effect.messages,
      boundarySeq: effect.boundarySeq,
      source: effect.source,
    });
  }
}

const MAX_FORWARDED_EXACT_SEEN_SEQS = 2_500;

/**
 * Task #360: rows the daemon delivered in full but recorded by exact id only
 * (a wake reply, a thread-join package) sit above the contiguous boundary, so
 * `seenUpToSeq` alone leaves them counted as unread and the Server holds the
 * send. Union the daemon's exact seqs above the boundary into the request's
 * `seenExactSeqs` (keeping the CLI's own), which the Server excludes exactly.
 */
function mergeDaemonExactSeenSeqs(body: Record<string, unknown>, daemonSeqs: readonly number[]): void {
  const boundary = typeof body.seenUpToSeq === "number" && Number.isFinite(body.seenUpToSeq) ? Math.floor(body.seenUpToSeq) : 0;
  const above = daemonSeqs.filter((seq) => Number.isInteger(seq) && seq > boundary);
  if (above.length === 0) return;
  const existing = Array.isArray(body.seenExactSeqs)
    ? body.seenExactSeqs.map((seq) => Math.floor(Number(seq))).filter((seq) => Number.isInteger(seq) && seq > 0)
    : [];
  body.seenExactSeqs = [...new Set([...existing, ...above])]
    .sort((a, b) => a - b)
    .slice(-MAX_FORWARDED_EXACT_SEEN_SEQS);
}

async function prepareAgentApiSideEffectForward(
  registration: ProxyRegistration,
  headers: Headers,
  rawBody: string,
  action: AgentProxyFreshnessAction,
  options: { localHold: boolean } = { localHold: true },
): Promise<
  {
    bodyText: string;
    target?: string;
    freshnessContextMode?: "inline" | "withheld";
    localResponse?: ApmHeldFreshnessEnvelopeBody<AgentProxyVisibleMessage>;
  }
> {
  let body: Record<string, unknown>;
  try {
    body = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {};
  } catch {
    return { bodyText: rawBody };
  }

  const target = sideEffectTarget(action, body);
  const freshnessContextMode = body.freshnessContextMode === "withheld"
    ? "withheld"
    : "inline";
  const coordinator = registration.inboxCoordinator;
  if (!target || !coordinator) {
    return { bodyText: JSON.stringify(body), target, freshnessContextMode };
  }
  const pending = coordinator.getPendingMessages(target);
  const existingBoundary = typeof body.seenUpToSeq === "number" && Number.isFinite(body.seenUpToSeq)
    ? Math.max(0, Math.floor(body.seenUpToSeq))
    : undefined;

  const continueAnyway = action === "send" && body.continueAnyway === true;
  // A blind seat must not materialize target bodies merely to perform a
  // first-touch freshness preflight. Forward the metadata-only mode to the
  // server, whose freshness query can return the strict count-only hold.
  const shouldLoadRecent = freshnessContextMode !== "withheld"
    && pending.length === 0
    && !continueAnyway
    && Math.max(existingBoundary ?? 0, coordinator.getBoundary(target) ?? 0) <= 0;
  const recent = shouldLoadRecent ? await loadRecentTargetMessages(registration, headers, target) : [];
  const plan = planAgentInboxSideEffect({
    agentId: registration.agentId,
    action,
    target,
    continueAnyway,
    freshnessContextMode,
    existingSeenUpToSeq: existingBoundary,
    modelSeenSeq: coordinator.getBoundary(target),
    pendingMessages: pending,
    recentMessages: recent,
    isMessageModelSeen: (messageInput) => coordinator.isMessageModelSeen?.(messageInput) === true,
    heldContextLimit: LOCAL_HELD_CONTEXT_LIMIT,
  });
  if (!options.localHold && plan.localResponse) {
    // A hold the agent will not see must not record its context as consumed.
    if (action === "send") mergeDaemonExactSeenSeqs(body, coordinator.getExactSeenSeqs?.(target) ?? []);
    return { bodyText: JSON.stringify(body), target, freshnessContextMode };
  }
  await applyAgentInboxStateMachineEffects(coordinator, plan.effects);
  if (typeof plan.forwardSeenUpToSeq === "number") {
    if (action === "send") body.seenUpToSeq = plan.forwardSeenUpToSeq;
  }
  if (action === "send" && !plan.localResponse) mergeDaemonExactSeenSeqs(body, coordinator.getExactSeenSeqs?.(target) ?? []);
  return {
    bodyText: JSON.stringify(body),
    target,
    freshnessContextMode,
    localResponse: plan.localResponse,
  };
}

function shouldBufferJsonResponse(upstream: Response, pathname: string, registration: ProxyRegistration): boolean {
  if (!registration.inboxCoordinator) return false;
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return false;
  return isAgentApiSendPath(pathname) ||
    pathname === "/internal/agent-api/events" ||
    pathname === "/internal/agent-api/history" ||
    /^\/internal\/agent-api\/messages\/[^/]+\/resolve$/.test(pathname);
}

async function consumeVisibleResponse(
  registration: ProxyRegistration,
  targetUrl: URL,
  sendTarget: string | undefined,
  requestedFreshnessContextMode: "inline" | "withheld" | undefined,
  responseText: string,
): Promise<void> {
  const coordinator = registration.inboxCoordinator;
  if (!coordinator) return;
  let parsed: {
    consumption_scope?: AgentApiHistoryConsumptionScope;
    state?: string;
    seenUpToSeq?: number;
    messageId?: string;
    messageSeq?: number;
    heldMessages?: AgentProxyVisibleMessage[];
    freshnessContextMode?: "inline" | "withheld";
    events?: AgentProxyVisibleMessage[];
    messages?: AgentProxyVisibleMessage[];
  };
  try {
    parsed = JSON.parse(responseText) as typeof parsed;
  } catch {
    return;
  }
  if (
    isAgentApiSendPath(targetUrl.pathname)
    && parsed.state === "held"
    && requestedFreshnessContextMode !== "withheld"
    && parsed.freshnessContextMode !== "withheld"
    && Array.isArray(parsed.heldMessages)
  ) {
    coordinator.consumeVisibleMessages({
      target: sendTarget,
      messages: normalizeInboxVisibleMessages(parsed.heldMessages, sendTarget),
      boundarySeq: typeof parsed.seenUpToSeq === "number" ? parsed.seenUpToSeq : undefined,
      source: "server_held_context",
    });
    return;
  }
  if (isAgentApiSendPath(targetUrl.pathname) && parsed.state === "sent") {
    const messageSeq = typeof parsed.messageSeq === "number" && Number.isFinite(parsed.messageSeq)
      ? Math.floor(parsed.messageSeq)
      : undefined;
    if (sendTarget && messageSeq && messageSeq > 0) {
      coordinator.consumeVisibleMessages({
        target: sendTarget,
        messages: normalizeInboxVisibleMessages([{ id: parsed.messageId }], sendTarget),
        source: "agent_api_send_commit",
      });
    }
    return;
  }
  if (targetUrl.pathname === "/internal/agent-api/events" && Array.isArray(parsed.events)) {
    const messages = normalizeInboxVisibleMessages(parsed.events);
    // Server `/events` sync/repair forward is a sparse server view, not
    // contiguous content consumption. Record exact ids for duplicate
    // suppression, but do not advance the model-seen high-water boundary.
    coordinator.consumeVisibleMessages({ messages, source: "agent_api_events_server" });
    coordinator.recordDrainOutcome?.({
      source: "server_events",
      sinceCursorKind: parseAgentApiEventsQuery(targetUrl).sinceCursorKind,
      notifiedCount: 0,
      drainedCount: messages.length,
      hasMore: Boolean((parsed as { has_more?: unknown }).has_more),
    });
    return;
  }
  if (targetUrl.pathname === "/internal/agent-api/history" && Array.isArray(parsed.messages)) {
    const target = targetUrl.searchParams.get("channel") ?? undefined;
    const messages = normalizeInboxVisibleMessages(parsed.messages, target);
    const scope = agentApiHistoryConsumptionScopeSchema.safeParse(parsed.consumption_scope);
    const historyScope = scope.success && scope.data.agent_id === registration.agentId
      && scope.data.target === target ? scope.data : undefined;
    coordinator.consumeVisibleMessages({ target, messages, boundarySeq: maxInboxMessageSeq(messages), source: "agent_api_history", ...(historyScope && { historyScope }) });
  }
}

function reprojectReviewerIsolationResponse(
  responseText: string,
  status: number,
  pathname: string,
): string {
  const genericFailure = JSON.stringify({
    error: "Reviewer-isolation request failed; upstream detail withheld.",
    code: "reviewer_isolation_request_failed",
  });
  try {
    const parsed = JSON.parse(responseText) as Record<string, unknown>;
    if (status < 200 || status >= 300) return genericFailure;
    if (parsed.state === "held") {
      const rawCount = typeof parsed.withheldMessageCount === "number"
        ? parsed.withheldMessageCount
        : parsed.newMessageCount;
      const withheldMessageCount = typeof rawCount === "number" && Number.isFinite(rawCount)
        ? Math.max(0, Math.floor(rawCount))
        : 0;
      return JSON.stringify({
        state: "held",
        freshnessContextMode: "withheld",
        withheldMessageCount,
      });
    }
    if (pathname === "/internal/agent-api/send" && parsed.state === "sent") {
      return JSON.stringify({
        ...(parsed.ok === true ? { ok: true } : {}),
        state: "sent",
        ...(typeof parsed.messageId === "string" ? { messageId: parsed.messageId } : {}),
        ...(typeof parsed.messageSeq === "number" && Number.isFinite(parsed.messageSeq)
          ? { messageSeq: parsed.messageSeq }
          : {}),
      });
    }
    return responseText;
  } catch {
    return genericFailure;
  }
}

export async function registerAgentCredentialProxy(input: {
  agentId: string;
  launchId?: string | null;
  serverUrl: string;
  apiKey: string;
  activeCapabilities: string;
  inboxCoordinator?: AgentProxyInboxCoordinator;
  appInbox?: AgentAppInboxStore;
  tracer?: Tracer;
  daemonVersion?: string | null;
  computerVersion?: string | null;
  passiveAx?: boolean;
}): Promise<ProxyHandle> {
  const server = await ensureServer();
  const proxyToken = `sap_${randomBytes(32).toString("base64url")}`;
  registrations.set(proxyToken, {
    serverUrl: input.serverUrl,
    apiKey: input.apiKey,
    agentId: input.agentId,
    launchId: input.launchId ?? null,
    activeCapabilities: input.activeCapabilities,
    inboxCoordinator: input.inboxCoordinator,
    appInbox: input.appInbox,
    tracer: input.tracer ?? noopTracer,
    daemonVersion: input.daemonVersion?.trim() || null,
    computerVersion: input.computerVersion?.trim() || null,
    passiveAx: input.passiveAx === true,
  });
  return {
    proxyUrl: server.proxyUrl,
    proxyToken,
  };
}

export function unregisterAgentCredentialProxyForLaunch(input: {
  agentId: string;
  launchId?: string | null;
}): number {
  let removed = 0;
  const launchId = input.launchId ?? null;
  for (const [token, registration] of registrations) {
    if (registration.agentId === input.agentId && registration.launchId === launchId) {
      clearThirdPartyLeases(registration);
      registrations.delete(token);
      removed += 1;
    }
  }
  return removed;
}

export function unregisterAgentCredentialProxiesForAgent(agentId: string): number {
  let removed = 0;
  for (const [token, registration] of registrations) {
    if (registration.agentId !== agentId) continue;
    clearThirdPartyLeases(registration);
    registrations.delete(token);
    removed += 1;
  }
  return removed;
}
