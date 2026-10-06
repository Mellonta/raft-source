// External Agent inbox push: a signed NOTICE (`raft-agent-inbox-notice.v1`),
// the external counterpart of a managed agent's "Inbox update". It says which
// conversations have new unread messages (target, counts, first/latest message
// ids, sender, flags) and carries no message bodies. The agent reads and
// acknowledges through its own pull (`GET /internal/agent-api/events?ack=cursor`,
// `raft message check`, `raft inbox check`); a notice never moves any cursor.
//
// Hot path: when this replica delivers a message to an external agent's inbox
// (`external-inbox-delivered` with the message), its row is merged into the
// agent's pending notice (in memory, per replica) and POSTed at once, or with
// the next POST if one is in flight. Notices are idempotent; direct notices
// never coordinate across replicas, but every sweep send is claimed on the
// registration row, so one replica sends it.
//
// Durability without a queue: a periodic sweep sends a notice for any agent
// whose inbox has unread written after its last delivered notice (a notice
// lost to a crash or a failing endpoint), and a reminder (at most one per
// pending state, claimed in reminded_max_seq) for any agent whose inbox still has unread when its last delivered notice is
// older than AGENT_INBOX_NOTICE_REMIND_AFTER_MS (the hot-path notice is sent
// without reading the chain, so the agent's pull may have beaten the chain to
// the row).
import { createHmac, randomUUID } from "node:crypto";
import {
  clearClockInterval,
  clearClockTimeout,
  createScopedTracer,
  currentDate,
  formatAgentInboxDelta,
  isExternalAgentRuntime,
  noopTracer,
  projectAgentInboxSnapshot,
  setClockInterval,
  setClockTimeout,
  type AgentInboxTargetRow,
  type AgentMessage,
  type Tracer,
} from "@botiverse/raft-shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agentCredentials, agentInboxEventsPendingAcks, agentInboxPushRegistrations, agents } from "../db/schema";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { addTraceEvent, errorClassOf, runWithTraceSpan } from "../tracing/semanticTrace";
import { agentIdHashAttrs, serverIdHashAttrs } from "../tracing/traceIdentity";
import type { AgentOrchestrator } from "./agentOrchestrator";
import {
  appWebhookDeliveryErrorCode,
  postPublicHttps,
  type WebhookPost,
  type WebhookPostTiming,
} from "./appNotificationDeliveryService";
import {
  AppWebhookConfigError,
  decryptWebhookSigningSecret,
  encryptWebhookSigningSecret,
  normalizeAppWebhookEndpoint,
} from "./appWebhookConfigService";
import { currentRaftTraceId, raftTraceIdHeaders } from "./externalRequestCorrelation";
import * as messageService from "./messageService";

export const AGENT_INBOX_NOTICE_SCHEMA = "raft-agent-inbox-notice.v1";
/** Consecutive 401/404/410 responses that disable a registration. */
export const AGENT_INBOX_PUSH_REJECTION_LIMIT = 3;
/** Backoff after the Nth consecutive failure (the last entry repeats). */
export const AGENT_INBOX_PUSH_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
/**
 * Backoff after a 400 (the receiver refused the body as invalid): retried on
 * this long schedule, since the receiver may deploy a fix; never disables.
 */
export const AGENT_INBOX_PUSH_BAD_REQUEST_RETRY_DELAYS_MS: readonly number[] = [5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000, 6 * 60 * 60_000];
const RETRY_AFTER_MIN_MS = 1_000;
const RETRY_AFTER_MAX_MS = 60 * 60_000;
/** Socket timeout of the POST (starts after the DNS lookup)… */
const REQUEST_TIMEOUT_MS = 10_000;
/** …and the bound on the whole POST, DNS lookup included. */
export const AGENT_INBOX_NOTICE_POST_TIMEOUT_MS = 12_000;
/** The sweep's inbox read (RisingWave chain + Postgres), which has no query timeout of its own. */
export const AGENT_INBOX_NOTICE_SWEEP_READ_TIMEOUT_MS = 5_000;
/**
 * Lease a direct (or retry) notice holds on its registration while its POST is
 * in flight: the POST bound plus a margin. The sweep's claim already skips
 * leased rows, so this keeps one notice per registration on the wire.
 */
export const AGENT_INBOX_NOTICE_DIRECT_LEASE_MS = AGENT_INBOX_NOTICE_POST_TIMEOUT_MS + 3_000;
export const AGENT_INBOX_NOTICE_SWEEP_INTERVAL_MS = 60_000;
/**
 * Unread still pending this long after the last delivered notice is re-notified
 * (a reminder), at most once per pending state (reminded_max_seq).
 */
export const AGENT_INBOX_NOTICE_REMIND_AFTER_MS = 5 * 60_000;
const SWEEP_BATCH_SIZE = 50;
const SECRET_MAX_LENGTH = 512;

export type AgentInboxPushDisabledReason = "endpoint_rejected" | "credential_revoked" | "agent_inactive";

export class AgentInboxPushError extends Error {
  constructor(
    readonly code: "INVALID_URL" | "INVALID_SECRET" | "AGENT_NOT_EXTERNAL" | "AGENT_NOT_FOUND" | "CREDENTIAL_INACTIVE" | "PUSH_UNAVAILABLE",
    message: string,
  ) {
    super(message);
  }
}

export interface AgentInboxPushStatus {
  registered: boolean;
  url: string | null;
  enabled: boolean;
  disabledReason: AgentInboxPushDisabledReason | null;
  disabledAt: string | null;
  lastAttemptAt: string | null;
  lastDeliveryAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextAttemptAt: string | null;
}

type RegistrationRow = typeof agentInboxPushRegistrations.$inferSelect;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function toStatus(row: RegistrationRow | undefined): AgentInboxPushStatus {
  if (!row) {
    return {
      registered: false,
      url: null,
      enabled: false,
      disabledReason: null,
      disabledAt: null,
      lastAttemptAt: null,
      lastDeliveryAt: null,
      lastError: null,
      consecutiveFailures: 0,
      nextAttemptAt: null,
    };
  }
  return {
    registered: true,
    url: row.endpointUrl,
    enabled: row.disabledAt === null,
    disabledReason: (row.disabledReason as AgentInboxPushDisabledReason | null) ?? null,
    disabledAt: iso(row.disabledAt),
    lastAttemptAt: iso(row.lastAttemptAt),
    lastDeliveryAt: iso(row.lastDeliveryAt),
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
    nextAttemptAt: row.disabledAt === null ? iso(row.nextAttemptAt) : null,
  };
}

/**
 * The receiver supplies the signing secret. It must carry at least 32 bytes of
 * entropy in a printable form: 64+ hex characters, or 43+ characters otherwise
 * (32 random bytes in base64/base64url). Visibly low-entropy strings are refused.
 */
export function validateAgentInboxPushSecret(raw: unknown): string {
  const reject = (message: string): never => {
    throw new AgentInboxPushError("INVALID_SECRET", message);
  };
  if (typeof raw !== "string") return reject("secret is required");
  if (raw.length > SECRET_MAX_LENGTH) return reject(`secret must be at most ${SECRET_MAX_LENGTH} characters`);
  if (!/^[\x21-\x7e]+$/.test(raw)) return reject("secret must be printable ASCII without whitespace");
  const hex = /^[0-9a-fA-F]+$/.test(raw);
  const minLength = hex ? 64 : 43;
  if (raw.length < minLength) {
    return reject("secret must carry at least 32 bytes of entropy: 64+ hex characters or 43+ base64url characters");
  }
  if (new Set(raw).size < (hex ? 10 : 16)) return reject("secret is too repetitive to be random");
  return raw;
}

function normalizeEndpoint(raw: unknown): string {
  try {
    return normalizeAppWebhookEndpoint(raw);
  } catch (error) {
    if (error instanceof AppWebhookConfigError) {
      throw new AgentInboxPushError("INVALID_URL", error.message.replace(/^endpointUrl/, "url"));
    }
    throw error;
  }
}

export async function getAgentInboxPushStatus(
  input: { agentId: string; serverId: string },
  executor: DatabaseExecutor = getDb(),
): Promise<AgentInboxPushStatus> {
  const [row] = await executor.select().from(agentInboxPushRegistrations).where(and(
    eq(agentInboxPushRegistrations.agentId, input.agentId),
    eq(agentInboxPushRegistrations.serverId, input.serverId),
  )).limit(1);
  return toStatus(row);
}

/**
 * Create or replace the agent's registration, bound to the calling credential.
 * Replacing rotates the secret atomically (one row update) and re-enables a
 * disabled registration. The delivery lease is left alone, so a delivery in
 * flight is never doubled.
 */
export async function putAgentInboxPushRegistration(input: {
  agentId: string;
  serverId: string;
  credentialId: string;
  url: unknown;
  secret: unknown;
  now?: Date;
}, executor: DatabaseExecutor = getDb()): Promise<AgentInboxPushStatus> {
  const endpointUrl = normalizeEndpoint(input.url);
  const secret = validateAgentInboxPushSecret(input.secret);
  const now = input.now ?? currentDate();

  const [agent] = await executor.select({ runtime: agents.runtime, serverId: agents.serverId }).from(agents).where(and(
    eq(agents.id, input.agentId),
    isNull(agents.deletedAt),
  )).limit(1);
  if (!agent || agent.serverId !== input.serverId) throw new AgentInboxPushError("AGENT_NOT_FOUND", "Agent not found");
  if (!isExternalAgentRuntime(agent.runtime)) {
    throw new AgentInboxPushError(
      "AGENT_NOT_EXTERNAL",
      "Inbox push is only available to External Agents; managed agents receive their inbox through the daemon",
    );
  }
  const [credential] = await executor.select({ id: agentCredentials.id }).from(agentCredentials).where(and(
    eq(agentCredentials.id, input.credentialId),
    eq(agentCredentials.agentId, input.agentId),
    isNull(agentCredentials.revokedAt),
  )).limit(1);
  if (!credential) throw new AgentInboxPushError("CREDENTIAL_INACTIVE", "Credential is not active");

  let encrypted: ReturnType<typeof encryptWebhookSigningSecret>;
  try {
    encrypted = encryptWebhookSigningSecret(secret);
  } catch (error) {
    if (error instanceof AppWebhookConfigError) {
      throw new AgentInboxPushError("PUSH_UNAVAILABLE", "Inbox push is not configured on this server");
    }
    throw error;
  }
  const values = {
    serverId: input.serverId,
    credentialId: input.credentialId,
    endpointUrl,
    secretCiphertext: encrypted.ciphertext,
    secretIv: encrypted.iv,
    secretAuthTag: encrypted.authTag,
    disabledAt: null,
    disabledReason: null,
    nextAttemptAt: now,
    consecutiveFailures: 0,
    consecutiveRejections: 0,
    lastError: null,
    updatedAt: now,
  };
  const [row] = await executor.insert(agentInboxPushRegistrations)
    .values({ agentId: input.agentId, ...values, createdAt: now })
    .onConflictDoUpdate({ target: agentInboxPushRegistrations.agentId, set: values })
    .returning();
  addTraceEvent("agent_inbox_push.registration.put", { outcome: "stored" });
  activeWorker?.kick(input.agentId);
  return toStatus(row);
}

export async function deleteAgentInboxPushRegistration(
  input: { agentId: string; serverId: string },
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  const deleted = await executor.delete(agentInboxPushRegistrations).where(and(
    eq(agentInboxPushRegistrations.agentId, input.agentId),
    eq(agentInboxPushRegistrations.serverId, input.serverId),
  )).returning({ id: agentInboxPushRegistrations.id });
  return deleted.length > 0;
}


// ---------------------------------------------------------------------------
// Notice

/** One conversation in a notice: the inbox row, without seqs or attention hints. */
export type AgentInboxNoticeTarget = Pick<AgentInboxTargetRow,
  "target" | "channelId" | "channelType" | "pendingCount" | "firstPendingMsgId" | "latestMsgId"
  | "latestSenderName" | "latestSenderType" | "flags">;

export interface AgentInboxNotice {
  schema: typeof AGENT_INBOX_NOTICE_SCHEMA;
  noticeId: string;
  recipientAgentId: string;
  occurredAt: string;
  /** `formatAgentInboxDelta(targets)`: the same "Inbox update" text a managed agent gets. */
  text: string;
  targets: AgentInboxNoticeTarget[];
}

const NOTICE_TARGET_KEYS = [
  "target", "channelId", "channelType", "pendingCount", "firstPendingMsgId", "latestMsgId",
  "latestSenderName", "latestSenderType", "flags",
] as const satisfies readonly (keyof AgentInboxNoticeTarget)[];

function toNoticeTarget(row: AgentInboxTargetRow): AgentInboxNoticeTarget {
  const target: Partial<AgentInboxNoticeTarget> = {};
  for (const key of NOTICE_TARGET_KEYS) {
    if (row[key] !== undefined) Object.assign(target, { [key]: row[key] });
  }
  return target as AgentInboxNoticeTarget;
}

/** Pending rows of one agent, merged by target (seqs kept internally for "latest"). */
class PendingNotice {
  readonly rows = new Map<string, AgentInboxTargetRow>();
  /** Earliest message write among the pending rows (latency: write -> 2xx). */
  oldestWriteAtMs: number | null = null;

  addMessage(message: AgentMessage): void {
    for (const row of projectAgentInboxSnapshot([message])) this.addRow(row);
    const writtenAt = typeof message.timestamp === "string" ? Date.parse(message.timestamp) : Number.NaN;
    if (Number.isFinite(writtenAt)) this.oldestWriteAtMs = Math.min(this.oldestWriteAtMs ?? writtenAt, writtenAt);
  }

  addRow(row: AgentInboxTargetRow): void {
    const existing = this.rows.get(row.target);
    if (!existing) {
      this.rows.set(row.target, { ...row, flags: [...row.flags] });
      return;
    }
    const newer = (row.latestSeq ?? 0) >= (existing.latestSeq ?? 0) ? row : existing;
    const older = newer === row ? existing : row;
    this.rows.set(row.target, {
      ...newer,
      pendingCount: existing.pendingCount + row.pendingCount,
      firstPendingMsgId: (older.firstPendingSeq ?? 0) <= (newer.firstPendingSeq ?? 0)
        ? older.firstPendingMsgId ?? newer.firstPendingMsgId
        : newer.firstPendingMsgId ?? older.firstPendingMsgId,
      firstPendingSeq: Math.min(older.firstPendingSeq ?? Infinity, newer.firstPendingSeq ?? Infinity) === Infinity
        ? undefined
        : Math.min(older.firstPendingSeq ?? Infinity, newer.firstPendingSeq ?? Infinity),
      flags: [...new Set([...existing.flags, ...row.flags])].sort(),
    });
  }

  /** Merge another pending notice in (a failed notice put back under newer rows). */
  absorb(other: PendingNotice): void {
    for (const row of other.rows.values()) this.addRow(row);
    if (other.oldestWriteAtMs !== null) {
      this.oldestWriteAtMs = Math.min(this.oldestWriteAtMs ?? other.oldestWriteAtMs, other.oldestWriteAtMs);
    }
  }

  get empty(): boolean {
    return this.rows.size === 0;
  }

  toNotice(agentId: string, now: Date): AgentInboxNotice {
    const rows = [...this.rows.values()].sort((a, b) => (b.latestSeq ?? 0) - (a.latestSeq ?? 0) || a.target.localeCompare(b.target));
    return {
      schema: AGENT_INBOX_NOTICE_SCHEMA,
      noticeId: `ntc_${randomUUID()}`,
      recipientAgentId: agentId,
      occurredAt: now.toISOString(),
      text: formatAgentInboxDelta(rows),
      targets: rows.map(toNoticeTarget),
    };
  }
}

export function signAgentInboxPushBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

type AttemptOutcome =
  | { kind: "delivered" }
  | { kind: "rejected"; error: string }
  | { kind: "bad_request"; error: string }
  | { kind: "retry"; error: string; retryAfterMs: number | null };

function parseRetryAfterMs(value: string | undefined, now: Date): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  let ms: number | null = null;
  if (/^\d+$/.test(trimmed)) ms = Number(trimmed) * 1000;
  else {
    const date = Date.parse(trimmed);
    if (Number.isFinite(date)) ms = date - now.getTime();
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  return Math.min(Math.max(ms, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
}

function classify(status: number, errorCode: string | null, retryAfter: string | undefined, now: Date): AttemptOutcome {
  if (status >= 200 && status < 300) return { kind: "delivered" };
  if (status === 401 || status === 404 || status === 410) return { kind: "rejected", error: `http_${status}` };
  if (status === 400) return { kind: "bad_request", error: "http_400" };
  if (status === 429) return { kind: "retry", error: "http_429", retryAfterMs: parseRetryAfterMs(retryAfter, now) };
  return { kind: "retry", error: status > 0 ? `http_${status}` : (errorCode ?? "network_error"), retryAfterMs: null };
}

export function agentInboxPushRetryDelayMs(
  consecutiveFailures: number,
  schedule: readonly number[] = AGENT_INBOX_PUSH_RETRY_DELAYS_MS,
): number {
  const index = Math.min(Math.max(consecutiveFailures, 1), schedule.length) - 1;
  return schedule[index]!;
}

class StepTimeout extends Error {
  constructor(step: string, ms: number) {
    super(`${step} timed out after ${ms} ms`);
    this.name = "AgentInboxNoticeStepTimeout";
  }
}

/** Race a step against its bound. The step keeps running in the background; its result is ignored. */
function withStepTimeout<T>(step: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: unknown;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setClockTimeout(() => reject(new StepTimeout(step, ms)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearClockTimeout(timer));
}

/** The registration and its live delivery authority, or why it may not push. */
async function loadSendable(agentId: string, executor: DatabaseExecutor) {
  const [row] = await executor.select({
    registration: agentInboxPushRegistrations,
    credentialRevokedAt: agentCredentials.revokedAt,
    runtime: agents.runtime,
    agentServerId: agents.serverId,
    agentDeletedAt: agents.deletedAt,
  }).from(agentInboxPushRegistrations)
    .innerJoin(agentCredentials, eq(agentCredentials.id, agentInboxPushRegistrations.credentialId))
    .innerJoin(agents, eq(agents.id, agentInboxPushRegistrations.agentId))
    .where(eq(agentInboxPushRegistrations.agentId, agentId))
    .limit(1);
  if (!row || row.registration.disabledAt !== null) return null;
  const disabledReason: AgentInboxPushDisabledReason | null = row.credentialRevokedAt
    ? "credential_revoked"
    : row.agentDeletedAt || !isExternalAgentRuntime(row.runtime) || row.agentServerId !== row.registration.serverId
      ? "agent_inactive"
      : null;
  return { registration: row.registration, disabledReason };
}

export type AgentInboxNoticeMode = "direct" | "retry" | "sweep";
/** Why the sweep sends: unread written after the last notice, or a reminder of unread still pending. */
export type AgentInboxNoticeSweepReason = "new" | "remind";

export interface AgentInboxNoticeResult {
  outcome: "delivered" | "rejected" | "bad_request" | "retry" | "backoff" | "disabled" | "unregistered";
  /** When a failed notice should be tried again (in-memory retry on this replica). */
  retryInMs?: number;
}

/**
 * POST one notice for the agent and record the outcome on the registration.
 * Failure counters are updated with SQL arithmetic, so replicas notifying
 * concurrently never lose a count; a success resets them.
 */
export async function sendAgentInboxNotice(input: {
  agentId: string;
  pending: PendingNotice;
  mode: AgentInboxNoticeMode;
  reason?: AgentInboxNoticeSweepReason;
  post?: WebhookPost;
  tracer?: Tracer;
  clock?: () => Date;
  executor?: DatabaseExecutor;
}): Promise<AgentInboxNoticeResult> {
  const executor = input.executor ?? getDb();
  const clock = input.clock ?? currentDate;
  const t = agentInboxPushRegistrations;
  const sendable = await loadSendable(input.agentId, executor);
  if (!sendable) return { outcome: "unregistered" };
  const { registration } = sendable;
  const now = clock();
  if (sendable.disabledReason) {
    await executor.update(t).set({
      disabledAt: now, disabledReason: sendable.disabledReason, lastError: sendable.disabledReason, updatedAt: now,
    }).where(and(eq(t.id, registration.id), isNull(t.disabledAt)));
    addTraceEvent("agent_inbox_push.disabled", { reason: sendable.disabledReason });
    return { outcome: "disabled" };
  }
  // A failing endpoint is on its backoff; the notice waits (merged) until then.
  if (registration.consecutiveFailures > 0 && registration.nextAttemptAt.getTime() > now.getTime()) {
    return { outcome: "backoff", retryInMs: registration.nextAttemptAt.getTime() - now.getTime() };
  }

  // A sweep send already holds the lease it claimed (claimSweepNotice). A direct
  // or retry send takes the same lease before its POST, so a sweep on another
  // replica doesn't send a second "new" for this registration while the POST is
  // in flight (seen in prod 10-05: a slow receiver plus the 1-minute sweep made
  // pairs). No CAS: the direct notice carries the newest state and goes anyway.
  // A failed or crashed send needs no cleanup; the lease just expires.
  const directLease = input.mode === "sweep" ? null : new Date(now.getTime() + AGENT_INBOX_NOTICE_DIRECT_LEASE_MS);
  if (directLease) {
    await executor.update(t).set({ leaseExpiresAt: directLease, updatedAt: now }).where(eq(t.id, registration.id));
  }

  const baseTracer = input.tracer ?? noopTracer;
  // Tag the notice (and anything under it) with the receiving agent's and its
  // server's hashes, so duplicate/late notices group per agent or server in one query.
  const tracer = createScopedTracer(baseTracer, {
    ...agentIdHashAttrs(input.agentId),
    ...serverIdHashAttrs(registration.serverId),
  });
  const notice = input.pending.toNotice(input.agentId, now);
  const span = tracer.startSpan("server.agent_push.notice", {
    surface: "server",
    kind: "internal",
    attrs: { mode: input.mode, ...(input.reason ? { reason: input.reason } : {}), targets_count: notice.targets.length },
  });
  try {
    return await runWithTraceSpan(span, async (): Promise<AgentInboxNoticeResult> => {
      const body = JSON.stringify(notice);
      let status = 0;
      let retryAfter: string | undefined;
      let errorCode: string | null = null;
      let responseRequestId: string | null = null;
      let timing: WebhookPostTiming | undefined;
      try {
        const secret = decryptWebhookSigningSecret({
          ciphertext: registration.secretCiphertext,
          iv: registration.secretIv,
          authTag: registration.secretAuthTag,
        });
        const response = await withStepTimeout("POST", AGENT_INBOX_NOTICE_POST_TIMEOUT_MS, (input.post ?? postPublicHttps)({
          endpointUrl: registration.endpointUrl,
          body,
          timeoutMs: REQUEST_TIMEOUT_MS,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body, "utf8").toString(),
            "user-agent": "Raft-Agent-Inbox/2.0",
            "x-raft-delivery-id": notice.noticeId,
            "x-raft-signature-256": signAgentInboxPushBody(secret, body),
            // This notice span's trace id, for the receiver to log (correlation);
            // omitted when no tracer records the span.
            ...raftTraceIdHeaders(baseTracer === noopTracer ? null : currentRaftTraceId()),
          },
        }));
        status = response.status;
        retryAfter = response.retryAfter;
        responseRequestId = response.requestId ?? null;
        timing = response.timing;
      } catch (error) {
        errorCode = appWebhookDeliveryErrorCode(error);
      }
      const finishedAt = clock();
      const outcome = classify(status, errorCode, retryAfter, finishedAt);
      const latencyMs = input.pending.oldestWriteAtMs === null ? null : finishedAt.getTime() - input.pending.oldestWriteAtMs;
      const endAttrs = {
        mode: input.mode,
        ...(input.reason ? { reason: input.reason } : {}),
        outcome: outcome.kind,
        http_status: status || null,
        targets_count: notice.targets.length,
        pending_count: notice.targets.reduce((sum, target) => sum + target.pendingCount, 0),
        // Earliest message in the notice: its write to the receiver's answer.
        latency_ms: latencyMs,
        error_code: outcome.kind === "delivered" ? null : outcome.error,
        "push.response_request_id": responseRequestId,
        // Cumulative ms from the start of the POST: DNS lookup, TCP connect, TLS
        // handshake, first response byte. connect/tls are absent on a reused socket.
        ...(timing ? {
          "push.dns_ms": timing.dnsMs,
          "push.connect_ms": timing.connectMs ?? null,
          "push.tls_ms": timing.tlsMs ?? null,
          "push.ttfb_ms": timing.ttfbMs ?? null,
          "push.socket_reused": timing.socketReused,
        } : {}),
      };

      if (outcome.kind === "delivered") {
        await executor.update(t).set({
          consecutiveFailures: 0,
          consecutiveRejections: 0,
          lastAttemptAt: finishedAt,
          lastDeliveryAt: finishedAt,
          lastError: null,
          updatedAt: finishedAt,
        }).where(eq(t.id, registration.id));
        span.end("ok", { attrs: endAttrs });
        return { outcome: "delivered" };
      }

      const [counted] = await executor.update(t).set({
        consecutiveFailures: sql`${t.consecutiveFailures} + 1`,
        consecutiveRejections: outcome.kind === "rejected" ? sql`${t.consecutiveRejections} + 1` : 0,
        lastAttemptAt: finishedAt,
        lastError: outcome.error,
        updatedAt: finishedAt,
      }).where(eq(t.id, registration.id)).returning({
        consecutiveFailures: t.consecutiveFailures,
        consecutiveRejections: t.consecutiveRejections,
      });
      if (!counted) {
        span.end("ok", { attrs: endAttrs });
        return { outcome: "unregistered" };
      }
      if (outcome.kind === "rejected" && counted.consecutiveRejections >= AGENT_INBOX_PUSH_REJECTION_LIMIT) {
        await executor.update(t).set({ disabledAt: finishedAt, disabledReason: "endpoint_rejected" })
          .where(and(eq(t.id, registration.id), isNull(t.disabledAt)));
        addTraceEvent("agent_inbox_push.disabled", { reason: "endpoint_rejected" });
        span.end("ok", { attrs: { ...endAttrs, disabled: true } });
        return { outcome: "disabled" };
      }
      if (outcome.kind === "bad_request") {
        console.warn("[AgentInboxPush] receiver refused a notice with 400; retrying on the long schedule");
      }
      const retryInMs = outcome.kind === "retry" && outcome.retryAfterMs !== null
        ? outcome.retryAfterMs
        : agentInboxPushRetryDelayMs(
            counted.consecutiveFailures,
            outcome.kind === "bad_request" ? AGENT_INBOX_PUSH_BAD_REQUEST_RETRY_DELAYS_MS : AGENT_INBOX_PUSH_RETRY_DELAYS_MS,
          );
      await executor.update(t).set({ nextAttemptAt: new Date(finishedAt.getTime() + retryInMs) }).where(eq(t.id, registration.id));
      span.end("ok", { attrs: { ...endAttrs, retry_in_ms: retryInMs } });
      return { outcome: outcome.kind, retryInMs };
    }, tracer).catch((error: unknown) => {
      span.end("error", { attrs: { mode: input.mode, error_class: errorClassOf(error) } });
      throw error;
    });
  } finally {
    // Hand the registration back right away, but only if the lease is still ours
    // (a newer direct send may have taken its own). Best effort: if this fails the
    // lease simply expires.
    if (directLease) {
      await executor.update(t).set({ leaseExpiresAt: null }).where(and(
        eq(t.id, registration.id),
        sql`date_trunc('milliseconds', ${t.leaseExpiresAt}) = ${directLease.toISOString()}::timestamptz`,
      )).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Sweep

/**
 * The inbox rows a notice for this agent would carry right now, from its
 * durable inbox (bounded read), and whether any unread was written after its
 * last delivered notice. Null when the inbox cannot be read.
 */
async function readUnreadForNotice(
  agentOrchestrator: AgentOrchestrator,
  agentId: string,
  lastDeliveryAt: Date | null,
): Promise<{ pending: PendingNotice; newSinceLastNotice: boolean; maxSeq: number } | null> {
  const pulled = await withStepTimeout(
    "inbox read",
    AGENT_INBOX_NOTICE_SWEEP_READ_TIMEOUT_MS,
    messageService.pullExternalAgentInboxUnshared(agentOrchestrator, agentId),
  );
  if (pulled.status !== "pulled") return null;
  // Rows a cursor-mode pull already handed over are known to the agent; they
  // stay unread only until its next pull acknowledges them. Neither a lost
  // notice nor a reminder applies to them (a reminder there just triggers the
  // acknowledging pull of an agent that read once and went idle).
  const [handed] = await getDb().select({ seqs: agentInboxEventsPendingAcks.seqs })
    .from(agentInboxEventsPendingAcks)
    .where(eq(agentInboxEventsPendingAcks.agentId, agentId))
    .limit(1);
  const handedOver = new Set(Array.isArray(handed?.seqs) ? handed.seqs : []);
  const pending = new PendingNotice();
  let newSinceLastNotice = false;
  let maxSeq = 0;
  for (const message of pulled.messages) {
    if (typeof message.seq === "number" && handedOver.has(message.seq)) continue;
    pending.addMessage(message);
    if (typeof message.seq === "number") maxSeq = Math.max(maxSeq, message.seq);
    const writtenAt = typeof message.timestamp === "string" ? Date.parse(message.timestamp) : Number.NaN;
    if (lastDeliveryAt === null || !Number.isFinite(writtenAt) || writtenAt > lastDeliveryAt.getTime()) newSinceLastNotice = true;
  }
  return { pending, newSinceLastNotice, maxSeq };
}

/**
 * Claim one sweep send on the registration row so exactly one replica sends it
 * (every replica sweeps the same rows). A reminder claims its pending state in
 * reminded_max_seq, so a backlog left unread is reminded once, not every
 * interval and not once per replica. A "new" notice claims with a
 * compare-and-set on last_attempt_at; a direct notice that touched the row in
 * between wins, which is fine: it covers the same unread. Both hold a short
 * lease (lease_expires_at, one POST timeout) until the send finishes, when
 * last_attempt_at is overwritten with the finish time; a crash mid-send just
 * lets the lease expire.
 */
async function claimSweepNotice(input: {
  agentId: string;
  reason: AgentInboxNoticeSweepReason;
  maxSeq: number;
  observedLastAttemptAt: Date | null;
  now: Date;
}): Promise<Date | null> {
  const t = agentInboxPushRegistrations;
  const lease = { leaseExpiresAt: new Date(input.now.getTime() + AGENT_INBOX_NOTICE_POST_TIMEOUT_MS) };
  const [claimed] = await getDb().update(t)
    .set(input.reason === "remind"
      ? { remindedMaxSeq: input.maxSeq, lastAttemptAt: input.now, updatedAt: input.now, ...lease }
      : { lastAttemptAt: input.now, updatedAt: input.now, ...lease })
    .where(and(
      eq(t.agentId, input.agentId),
      // Another replica's sweep send is in flight: last_attempt_at and
      // last_delivery_at only move when it finishes, so without this lease a
      // sweep reading the row mid-send would claim the same "new" notice again.
      sql`(${t.leaseExpiresAt} IS NULL OR ${t.leaseExpiresAt} < ${input.now.toISOString()}::timestamptz)`,
      input.reason === "remind"
        ? sql`coalesce(${t.remindedMaxSeq}, 0) < ${input.maxSeq}`
        : input.observedLastAttemptAt === null
          ? isNull(t.lastAttemptAt)
          : sql`date_trunc('milliseconds', ${t.lastAttemptAt}) = ${input.observedLastAttemptAt.toISOString()}::timestamptz`,
    ))
    .returning({ id: t.id });
  return claimed ? lease.leaseExpiresAt : null;
}

/**
 * Send a notice for each enabled registration (not backing off) whose inbox has
 * unread, when some was written after its last delivered notice ("new") or
 * that notice is older than the reminder interval and the pending state was
 * not reminded of already ("remind"). Idempotent: every
 * replica may run it; a duplicate notice is harmless.
 */
export async function sweepAgentInboxNotices(input: {
  agentOrchestrator: AgentOrchestrator;
  post?: WebhookPost;
  tracer?: Tracer;
  clock?: () => Date;
  agentIds?: readonly string[];
  skip?: (agentId: string) => boolean;
  remindAfterMs?: number;
}): Promise<{ checked: number; sent: number; failed: number }> {
  const clock = input.clock ?? currentDate;
  const remindAfterMs = input.remindAfterMs ?? AGENT_INBOX_NOTICE_REMIND_AFTER_MS;
  const tracer = input.tracer ?? noopTracer;
  const t = agentInboxPushRegistrations;
  const span = tracer.startSpan("server.agent_push.sweep", { surface: "server", kind: "internal" });
  const totals = { checked: 0, sent: 0, failed: 0 };
  try {
    const now = clock();
    const due = await getDb().select({
      agentId: t.agentId,
      lastDeliveryAt: t.lastDeliveryAt,
      lastAttemptAt: t.lastAttemptAt,
      remindedMaxSeq: t.remindedMaxSeq,
    })
      .from(t)
      .where(and(
        isNull(t.disabledAt),
        sql`(${t.consecutiveFailures} = 0 OR ${t.nextAttemptAt} <= ${now.toISOString()}::timestamptz)`,
        ...(input.agentIds ? [sql`${t.agentId} IN ${input.agentIds}`] : []),
      ))
      .limit(SWEEP_BATCH_SIZE);
    for (const { agentId, lastDeliveryAt, lastAttemptAt, remindedMaxSeq } of due) {
      if (input.skip?.(agentId)) continue;
      totals.checked += 1;
      try {
        const unread = await readUnreadForNotice(input.agentOrchestrator, agentId, lastDeliveryAt);
        if (!unread) continue;
        if (unread.pending.empty) {
          if (remindedMaxSeq !== null) {
            await getDb().update(t).set({ remindedMaxSeq: null })
              .where(and(eq(t.agentId, agentId), eq(t.remindedMaxSeq, remindedMaxSeq)));
          }
          continue;
        }
        const reason: AgentInboxNoticeSweepReason | null = unread.newSinceLastNotice
          ? "new"
          : (lastDeliveryAt === null || now.getTime() - lastDeliveryAt.getTime() >= remindAfterMs)
            && unread.maxSeq > (remindedMaxSeq ?? 0)
            ? "remind"
            : null;
        if (!reason) continue;
        const leaseExpiresAt = await claimSweepNotice({ agentId, reason, maxSeq: unread.maxSeq, observedLastAttemptAt: lastAttemptAt, now });
        if (!leaseExpiresAt) {
          addTraceEvent("agent_inbox_push.sweep_claim_lost", { reason });
          continue;
        }
        let delivered = false;
        try {
          const result = await runWithTraceSpan(span, () => sendAgentInboxNotice({
            agentId, pending: unread.pending, mode: "sweep", reason, post: input.post, tracer, clock,
          }), tracer);
          delivered = result.outcome === "delivered";
        } finally {
          // End the lease; a failed or thrown reminder also releases its claim
          // so the backoff retry can send it.
          await getDb().update(t).set({
            leaseExpiresAt: null,
            ...(!delivered && reason === "remind" ? { remindedMaxSeq: sql`CASE WHEN ${t.remindedMaxSeq} = ${unread.maxSeq} THEN ${remindedMaxSeq} ELSE ${t.remindedMaxSeq} END` } : {}),
          }).where(and(
            eq(t.agentId, agentId),
            // Only our own lease: a send that outlived it may have been re-claimed.
            sql`date_trunc('milliseconds', ${t.leaseExpiresAt}) = ${leaseExpiresAt.toISOString()}::timestamptz`,
          ));
        }
        if (delivered) totals.sent += 1;
        else totals.failed += 1;
      } catch (error) {
        totals.failed += 1;
        console.error("[AgentInboxPush] sweep notice failed", serializeErrorForLog(error));
      }
    }
    span.end("ok", { attrs: { checked: totals.checked, sent: totals.sent, failed: totals.failed } });
    return totals;
  } catch (error) {
    span.end("error", { attrs: { error_class: errorClassOf(error) } });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Worker

interface AgentNoticeState {
  pending: PendingNotice;
  inFlight: boolean;
  retryTimer: unknown;
}

interface ActiveWorker {
  kick(agentId: string): void;
}

let activeWorker: ActiveWorker | null = null;

/**
 * Per replica: notices on delivery (merged per agent while one is in flight or
 * backing off, retried in memory with the latest merged state) and the
 * periodic sweep.
 */
export function startAgentInboxPushWorker(input: {
  agentOrchestrator: AgentOrchestrator;
  post?: WebhookPost;
  /** Required: the drain/notice spans must reach the server's trace sink (no silent noop in production wiring). */
  tracer: Tracer;
  clock?: () => Date;
  sweepIntervalMs?: number;
  /** Test seam: the in-memory retry timer's delay for a given backoff. */
  retryTimerMs?: (backoffMs: number) => number;
}) {
  const states = new Map<string, AgentNoticeState>();
  let stopped = false;
  let sweeping = false;

  const stateFor = (agentId: string): AgentNoticeState => {
    let state = states.get(agentId);
    if (!state) {
      state = { pending: new PendingNotice(), inFlight: false, retryTimer: null };
      states.set(agentId, state);
    }
    return state;
  };

  const send = async (agentId: string, mode: AgentInboxNoticeMode): Promise<void> => {
    const state = states.get(agentId);
    if (!state || state.inFlight || state.pending.empty || stopped) return;
    if (mode !== "retry" && state.retryTimer !== null) return; // waiting out a backoff
    state.inFlight = true;
    const taken = state.pending;
    state.pending = new PendingNotice();
    let result: AgentInboxNoticeResult;
    try {
      result = await sendAgentInboxNotice({ agentId, pending: taken, mode, post: input.post, tracer: input.tracer, clock: input.clock });
    } catch (error) {
      console.error("[AgentInboxPush] notice failed", serializeErrorForLog(error));
      result = { outcome: "retry", retryInMs: AGENT_INBOX_PUSH_RETRY_DELAYS_MS[0] };
    } finally {
      state.inFlight = false;
    }
    if (result.outcome === "delivered" || result.outcome === "disabled" || result.outcome === "unregistered") {
      if (result.outcome !== "delivered") state.pending = new PendingNotice();
      if (!state.pending.empty) void send(agentId, "direct");
      else if (state.retryTimer === null) states.delete(agentId);
      return;
    }
    // Failed or backing off: the newer rows supersede, the failed ones are
    // merged back; one retry later sends the latest merged state.
    taken.absorb(state.pending);
    state.pending = taken;
    if (state.retryTimer !== null || stopped) return;
    state.retryTimer = setClockTimeout(() => {
      state.retryTimer = null;
      void send(agentId, "retry");
    }, (input.retryTimerMs ?? ((ms: number) => ms))(result.retryInMs ?? AGENT_INBOX_PUSH_RETRY_DELAYS_MS[0]!));
  };

  const onDelivered = (agentId: unknown, message?: unknown) => {
    if (typeof agentId !== "string" || stopped) return;
    const candidate = message as AgentMessage | undefined;
    if (!candidate || typeof candidate !== "object") return;
    if (!Number.isInteger(candidate.seq) || (candidate.seq ?? 0) <= 0 || candidate.third_party_event) return;
    stateFor(agentId).pending.addMessage(candidate);
    void send(agentId, "direct");
  };
  input.agentOrchestrator.on("external-inbox-delivered", onDelivered);

  const sweep = (agentIds?: readonly string[]) => {
    if (sweeping && !agentIds) return;
    if (!agentIds) sweeping = true;
    sweepAgentInboxNotices({
      agentOrchestrator: input.agentOrchestrator,
      post: input.post,
      tracer: input.tracer,
      clock: input.clock,
      agentIds,
      // An agent with a notice pending or in flight here is covered already.
      skip: (agentId) => states.has(agentId),
    })
      .catch((error) => console.error("[AgentInboxPush] sweep failed", serializeErrorForLog(error)))
      .finally(() => {
        if (!agentIds) sweeping = false;
      });
  };
  const handle = setClockInterval(() => sweep(), input.sweepIntervalMs ?? AGENT_INBOX_NOTICE_SWEEP_INTERVAL_MS);
  if (typeof handle === "object" && handle && "unref" in handle && typeof handle.unref === "function") handle.unref();
  const worker: ActiveWorker = { kick: (agentId) => sweep([agentId]) };
  activeWorker = worker;
  return {
    /** Resolves when no notice is in flight or pending on this replica (tests). */
    async idle() {
      while ([...states.values()].some((state) => state.inFlight || (!state.pending.empty && state.retryTimer === null))) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    stop() {
      stopped = true;
      input.agentOrchestrator.off("external-inbox-delivered", onDelivered);
      clearClockInterval(handle);
      for (const state of states.values()) if (state.retryTimer !== null) clearClockTimeout(state.retryTimer);
      states.clear();
      if (activeWorker === worker) activeWorker = null;
    },
  };
}

export { PendingNotice as AgentInboxPendingNotice };
