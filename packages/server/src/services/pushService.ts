import http2 from "node:http2";
import { lookup as dnsLookup } from "node:dns/promises";
import { Agent as HttpsAgent } from "node:https";
import { isIP } from "node:net";
import { revokeSocketAccess } from "../socket/accessRevocation";
import { revokeSessionFamilyInTransaction } from "./sessionService";
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { clearClockTimeout, currentDate, currentTimeMs, noopTracer, setClockInterval, setClockTimeout, type Tracer } from "@botiverse/raft-shared";
import { setImmediate as waitUntilNextTurn, setTimeout as sleepTimer } from "node:timers/promises";
import { and, asc, eq, exists, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import jwt from "jsonwebtoken";
import webpush from "web-push";
import { getDb, registerDatabaseCloseHookForTests, type DatabaseExecutor } from "../db/index";
import { chunkForBindParameters, insertParametersPerRow } from "../db/bindParameterBudget";
import {
  agents,
  attachments,
  channels,
  messages,
  mobilePushOutbox,
  pushRegistrations,
  pushSubscriptions,
  serverMembers,
  servers,
  sessionFamilies,
  sessions,
  users,
} from "../db/schema";
import { addTraceEvent, errorClassOf, runWithTraceSpan } from "../tracing/semanticTrace";
import { UUID_RE } from "../lib/messageId";
import type { InboxNotificationFactInput } from "./inboxNotificationService";
import {
  formatPushBody,
  formatPushServerLabel,
  formatPushSurfaceTitle,
  summarizePushBody,
} from "./pushDisplay";
import {
  evaluateFeatureFlag,
  MOBILE_PUSH_DELIVERY_FEATURE_FLAG_KEY,
} from "./featureFlagService";
import { withChannelWriterFence } from "./channelConversionFenceService";
import { createAppWebhookPinnedLookup } from "./appNotificationDeliveryService";
import { isPublicWebhookAddress } from "./appWebhookConfigService";
import { recordExternalSinkInsideTransaction } from "../db/ambientTransaction";
import { getActivityUnreadTotalsBatch } from "./channelService";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:contact@raft.build";
const DEFAULT_PUSH_TTL_SECONDS = 60 * 60;
const MOBILE_PUSH_MAX_ATTEMPTS = 3;
const MOBILE_PUSH_RETRY_BASE_MS = 250;
const APNS_REQUEST_TIMEOUT_MS = 5_000;
const MOBILE_PUSH_OUTBOX_BATCH_SIZE = 100;
const MOBILE_PUSH_OUTBOX_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
export const PUSH_FAMILY_CAPABILITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const vapidConfigured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (vapidConfigured) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn("[PushService] VAPID keys not configured — web push disabled");
}

type WebPushResolvedAddress = { address: string; family: number };
type WebPushLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<WebPushResolvedAddress[]>;

type WebPushRuntime = {
  enabled: boolean;
  lookup: WebPushLookup;
  sendNotification: typeof webpush.sendNotification;
};

const defaultWebPushRuntime: WebPushRuntime = {
  enabled: vapidConfigured,
  lookup: (hostname, options) => dnsLookup(hostname, options),
  sendNotification: (subscription, payload, options) => webpush.sendNotification(subscription, payload, options),
};

let webPushRuntime: WebPushRuntime = defaultWebPushRuntime;

export function __setWebPushRuntimeForTests(runtime: Partial<WebPushRuntime>) {
  webPushRuntime = { ...defaultWebPushRuntime, ...runtime };
}

export function __resetWebPushRuntimeForTests() {
  webPushRuntime = defaultWebPushRuntime;
}

/**
 * Hostname of a Web Push endpoint the server may deliver to: an absolute,
 * credential-free `https:` URL naming a public DNS host. IP literals and
 * loopback or link-local style names are refused so a subscriber cannot point
 * the server's push egress at internal services; the resolved addresses are
 * checked again at send time. Returns null for anything else.
 */
export function webPushEndpointHostname(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || isIP(hostname)) return null;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return null;
  if (hostname.endsWith(".local") || hostname.endsWith(".internal")) return null;
  return hostname;
}

/**
 * Resolves a stored endpoint to the address the connection will be pinned to.
 * `null` means the endpoint is permanently undeliverable (not a public HTTPS
 * host, or it resolves to a private or special-use address); a lookup failure
 * propagates so transient DNS trouble is not mistaken for a bad endpoint.
 */
async function resolvePublicWebPushAddress(endpoint: string): Promise<WebPushResolvedAddress | null> {
  const hostname = webPushEndpointHostname(endpoint);
  if (!hostname) return null;
  const addresses = await webPushRuntime.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => !isPublicWebhookAddress(entry.address))) return null;
  return addresses[0];
}

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
  serverName?: string;
  channelName?: string | null;
  parentChannelKind?: "channel" | "joint" | "dm" | null;
  senderId?: string;
  senderType?: "user" | "agent";
  senderName?: string;
  messagePreview?: string;
  mentioned?: boolean;
  alwaysShow?: boolean;
}

export type PushRegistrationProvider = "apns";
export type PushRegistrationEnv = "sandbox" | "production";

export interface PushRegistrationInput {
  installationId: string;
  provider: PushRegistrationProvider;
  userId: string;
  serverId: string;
  sessionFamilyId: string;
  deviceToken: string;
  topic: string;
  env: PushRegistrationEnv;
  appVersion?: string | null;
}

export type PushFamilyRevokeResult = "revoked" | "already_revoked" | "invalid";

function capabilitySigningKey(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET environment variable is required");
  return secret;
}

function capabilitySignature(familyId: string, nonce: string): string {
  return createHmac("sha256", capabilitySigningKey())
    .update("push-family-revoke-v1\0")
    .update(familyId)
    .update("\0")
    .update(nonce)
    .digest("base64url");
}

function formatFamilyRevokeCapability(familyId: string, nonce: string): string {
  return `${familyId}.${nonce}.${capabilitySignature(familyId, nonce)}`;
}

function parseFamilyRevokeCapability(capability: string): { familyId: string; nonce: string; signature: string } | null {
  if (capability.length > 256) return null;
  const [familyId, nonce, signature, extra] = capability.split(".");
  if (extra !== undefined || !familyId || !nonce || !signature) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(familyId)
    || !/^[A-Za-z0-9_-]{22}$/.test(nonce)
    || !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
    return null;
  }
  return { familyId, nonce, signature };
}

function capabilitySignatureMatches(familyId: string, nonce: string, signature: string): boolean {
  const expected = Buffer.from(capabilitySignature(familyId, nonce));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function ensureFamilyRevokeCapability(
  input: { familyId: string; userId: string },
  executor: DatabaseExecutor = getDb(),
): Promise<string | null> {
  const candidateNonce = randomBytes(16).toString("base64url");
  const [family] = await executor
    .update(sessionFamilies)
    .set({ revokeCapabilityNonce: sql`COALESCE(${sessionFamilies.revokeCapabilityNonce}, ${candidateNonce})` })
    .where(and(
      eq(sessionFamilies.id, input.familyId),
      eq(sessionFamilies.userId, input.userId),
      isNull(sessionFamilies.revokedAt),
    ))
    .returning({ id: sessionFamilies.id, nonce: sessionFamilies.revokeCapabilityNonce });
  return family?.nonce ? formatFamilyRevokeCapability(family.id, family.nonce) : null;
}

export async function revokePushFamilyByCapability(
  capability: string,
  now = currentDate(),
): Promise<PushFamilyRevokeResult> {
  const parsed = parseFamilyRevokeCapability(capability);
  if (!parsed || !capabilitySignatureMatches(parsed.familyId, parsed.nonce, parsed.signature)) return "invalid";

  let revokedUserId: string | undefined;
  const result = await getDb().transaction(async (tx) => {
    const [family] = await tx.select({
      id: sessionFamilies.id,
      userId: sessionFamilies.userId,
      nonce: sessionFamilies.revokeCapabilityNonce,
      revokedAt: sessionFamilies.revokedAt,
      capabilityRetainUntil: sessionFamilies.capabilityRetainUntil,
    }).from(sessionFamilies).where(eq(sessionFamilies.id, parsed.familyId));
    if (!family?.nonce || family.nonce !== parsed.nonce) return "invalid";

    if (family.revokedAt) {
      if (family.capabilityRetainUntil && family.capabilityRetainUntil.getTime() > now.getTime()) {
        revokedUserId = family.userId;
        return "already_revoked";
      }
      await tx.update(sessionFamilies).set({
        revokeCapabilityNonce: null,
        capabilityRetainUntil: null,
      }).where(eq(sessionFamilies.id, family.id));
      return "invalid";
    }

    await revokeSessionFamilyInTransaction(tx, family.userId, family.id, "capability", now);
    revokedUserId = family.userId;
    return "revoked";
  });
  // Also retry eviction for an already-revoked capability after fanout failure.
  if (revokedUserId) await revokeSocketAccess({ userId: revokedUserId, familyId: parsed.familyId });
  if (result === "revoked") addTraceEvent("push.family.revoked", { reason: "capability" });
  return result;
}

export interface MobilePushIdentityPayload {
  serverId: string;
  channelId: string;
  threadId?: string;
  parentChannelId?: string;
  parentMessageId?: string;
  messageId: string;
  kind: "channel" | "dm" | "thread";
  /** Absent when the badge could not be read; the device then keeps its current badge. */
  badge?: number;
}

export interface MobilePushPayload extends MobilePushIdentityPayload {
  alertTitle: string;
  alertBody: string;
}

export interface ApnsDeliveryInput {
  registrationId: string;
  installationId: string;
  deviceToken: string;
  topic: string;
  env: PushRegistrationEnv;
  payload: MobilePushPayload;
}

export interface ApnsDeliveryResult {
  status: "sent" | "skipped";
  reason?: "provider_not_configured";
}

export interface ApnsPushProvider {
  send(input: ApnsDeliveryInput): Promise<ApnsDeliveryResult>;
}

function mobilePushCollapseId(payload: Pick<MobilePushIdentityPayload, "serverId" | "channelId">): string {
  return createHash("sha256")
    .update("mobile-push-conversation-v1\0")
    .update(payload.serverId)
    .update("\0")
    .update(payload.channelId)
    .digest("base64url");
}

interface ApnsHttpRequest {
  authority: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

interface ApnsHttpResponse {
  statusCode: number;
  body: string;
}

type ApnsHttpClient = (request: ApnsHttpRequest) => Promise<ApnsHttpResponse>;

export interface MobilePushDeliveryRuntime {
  sleep(ms: number): Promise<void>;
  jitterMs(attempt: number): number;
  schedule(work: () => Promise<void>): void;
}

export class ApnsDeliveryError extends Error {
  statusCode?: number;
  reason?: string;

  constructor(message: string, opts: { statusCode?: number; reason?: string } = {}) {
    super(message);
    this.name = "ApnsDeliveryError";
    this.statusCode = opts.statusCode;
    this.reason = opts.reason;
  }
}

class ConfiguredApnsPushProvider implements ApnsPushProvider {
  async send(input: ApnsDeliveryInput): Promise<ApnsDeliveryResult> {
    // APNs is an external HTTP/2 round-trip (the push build runs inside a
    // write-lock transaction to serialize with channel conversion — intentional);
    // report it so the audit can distinguish the known case from any new one.
    recordExternalSinkInsideTransaction("apns");
    if (!isApnsConfigured()) {
      return { status: "skipped", reason: "provider_not_configured" };
    }

    const nowSeconds = Math.floor(currentTimeMs() / 1000);
    const token = jwt.sign(
      { iss: process.env.APNS_TEAM_ID, iat: nowSeconds },
      apnsPrivateKey(),
      {
        algorithm: "ES256",
        header: {
          alg: "ES256",
          kid: process.env.APNS_KEY_ID,
        },
      },
    );
    const authority = input.env === "sandbox"
      ? "https://api.sandbox.push.apple.com"
      : "https://api.push.apple.com";
    const response = await apnsHttpClient({
      authority,
      path: `/3/device/${input.deviceToken}`,
      headers: {
        authorization: `bearer ${token}`,
        "content-type": "application/json",
        "apns-expiration": String(nowSeconds + DEFAULT_PUSH_TTL_SECONDS),
        "apns-priority": "10",
        "apns-push-type": "alert",
        "apns-topic": input.topic,
        "apns-collapse-id": mobilePushCollapseId(input.payload),
      },
      body: {
        aps: {
          alert: {
            title: input.payload.alertTitle,
            body: input.payload.alertBody,
          },
          ...(input.payload.badge !== undefined ? { badge: input.payload.badge } : {}),
          sound: "default",
          // Group by the parent channel when this push is a thread reply.
          // channelId on a thread is the thread's own channel, so using it
          // splits one channel into a card per topic.
          "thread-id": `${input.payload.serverId}:${input.payload.parentChannelId || input.payload.channelId}`,
          category: "RAFT_MESSAGE",
        },
        serverId: input.payload.serverId,
        channelId: input.payload.channelId,
        ...(input.payload.threadId ? { threadId: input.payload.threadId } : {}),
        ...(input.payload.parentChannelId ? { parentChannelId: input.payload.parentChannelId } : {}),
        ...(input.payload.parentMessageId ? { parentMessageId: input.payload.parentMessageId } : {}),
        messageId: input.payload.messageId,
        kind: input.payload.kind,
      },
    });

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return { status: "sent" };
    }

    throw new ApnsDeliveryError("APNs rejected mobile push", {
      statusCode: response.statusCode,
      reason: parseApnsErrorReason(response.body),
    });
  }
}

let apnsPushProvider: ApnsPushProvider = new ConfiguredApnsPushProvider();
let apnsHttpClient: ApnsHttpClient = createApnsHttpClient(APNS_REQUEST_TIMEOUT_MS);
type MobilePushOutboxMutationForTest = "conversion_authority_bypass";
let mobilePushOutboxMutationForTest: MobilePushOutboxMutationForTest | null = null;
let afterMobilePushOutboxClaimForTest: (() => Promise<void> | void) | null = null;
// Include the deferred turn in ownership: a case may finish before work starts.
const mobilePushTasks = new Set<Promise<void>>();
const mobilePushTaskFailures: Error[] = [];

function scheduleMobilePushTask(work: () => Promise<void>): void {
  const task = (async () => {
    await waitUntilNextTurn();
    await work();
  })();
  mobilePushTasks.add(task);
  void task.then(
    () => { mobilePushTasks.delete(task); },
    (error) => {
      mobilePushTasks.delete(task);
      if (process.env.NODE_ENV === "test") {
        mobilePushTaskFailures.push(error instanceof Error ? error : new Error(String(error)));
      }
      console.error("[PushService] Failed to dispatch queued mobile push notifications:", error);
    },
  );
}

export async function drainMobilePushTasksForTests(): Promise<void> {
  while (mobilePushTasks.size) await Promise.allSettled([...mobilePushTasks]);
  if (mobilePushTaskFailures.length) {
    throw new AggregateError(mobilePushTaskFailures.splice(0), "Mobile push background work failed");
  }
}

registerDatabaseCloseHookForTests(drainMobilePushTasksForTests);

let mobilePushDeliveryRuntime: MobilePushDeliveryRuntime = {
  sleep: async (ms) => {
    await sleepTimer(ms);
  },
  jitterMs: (attempt) => MOBILE_PUSH_RETRY_BASE_MS * attempt + randomInt(0, MOBILE_PUSH_RETRY_BASE_MS),
  schedule: scheduleMobilePushTask,
};

function isApnsConfigured(): boolean {
  return Boolean(
    process.env.APNS_KEY_ID
      && process.env.APNS_TEAM_ID
      && process.env.APNS_PRIVATE_KEY
  );
}

function apnsPrivateKey(): string {
  return process.env.APNS_PRIVATE_KEY!.replace(/\\n/g, "\n");
}

function parseApnsErrorReason(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}

export class ApnsRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`APNs request did not complete within ${timeoutMs}ms`);
    this.name = "ApnsRequestTimeoutError";
  }
}

/**
 * The outbox drain calls APNs while holding the channel writer fence, so every
 * request must end within a bounded time: an unanswered connect or stream would
 * otherwise keep that transaction open until Postgres kills it. A timeout is a
 * transient failure and goes through the normal bounded retry.
 *
 * @internal Exported so the timeout can be verified against a local HTTP/2 server.
 */
export function createApnsHttpClient(timeoutMs: number): ApnsHttpClient {
  return (request) => new Promise((resolve, reject) => {
    const client = http2.connect(request.authority);
    let statusCode = 0;
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearClockTimeout(timer);
      client.close();
      fn();
    };

    const timer = setClockTimeout(() => {
      if (settled) return;
      settled = true;
      client.destroy();
      reject(new ApnsRequestTimeoutError(timeoutMs));
    }, timeoutMs);

    client.once("error", (err) => finish(() => reject(err)));

    const stream = client.request({
      ":method": "POST",
      ":path": request.path,
      ...request.headers,
    });

    stream.once("response", (headers) => {
      const headerStatus = headers[":status"];
      statusCode = typeof headerStatus === "number" ? headerStatus : Number(headerStatus ?? 0);
    });
    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.once("error", (err) => finish(() => reject(err)));
    stream.once("end", () => finish(() => resolve({
      statusCode,
      body: Buffer.concat(chunks).toString("utf8"),
    })));
    stream.end(JSON.stringify(request.body));
  });
}

export function __setApnsPushProviderForTests(provider: ApnsPushProvider) {
  apnsPushProvider = provider;
}

export function __resetApnsPushProviderForTests() {
  apnsPushProvider = new ConfiguredApnsPushProvider();
}

export function __setMobilePushOutboxMutationForTests(mutation: MobilePushOutboxMutationForTest | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("mobile push outbox mutations are test-only");
  mobilePushOutboxMutationForTest = mutation;
}

export function __setAfterMobilePushOutboxClaimForTests(hook: (() => Promise<void> | void) | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("mobile push outbox claim hooks are test-only");
  afterMobilePushOutboxClaimForTest = hook;
}

export function __setApnsHttpClientForTests(client: ApnsHttpClient) {
  apnsHttpClient = client;
}

export function __resetApnsHttpClientForTests() {
  apnsHttpClient = createApnsHttpClient(APNS_REQUEST_TIMEOUT_MS);
}

export function __setMobilePushDeliveryRuntimeForTests(runtime: Partial<MobilePushDeliveryRuntime>) {
  mobilePushDeliveryRuntime = {
    ...mobilePushDeliveryRuntime,
    ...runtime,
  };
}

export function __resetMobilePushDeliveryRuntimeForTests() {
  mobilePushDeliveryRuntime = {
    sleep: async (ms) => {
      await sleepTimer(ms);
    },
    jitterMs: (attempt) => MOBILE_PUSH_RETRY_BASE_MS * attempt + randomInt(0, MOBILE_PUSH_RETRY_BASE_MS),
    schedule: scheduleMobilePushTask,
  };
}

export function isPushEnabled(): boolean {
  return webPushRuntime.enabled;
}

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY;
}

export async function saveSubscription(userId: string, endpoint: string, p256dh: string, auth: string) {
  const db = getDb();
  await db
    .insert(pushSubscriptions)
    .values({ userId, endpoint, p256dh, auth })
    .onConflictDoUpdate({
      target: [pushSubscriptions.userId, pushSubscriptions.endpoint],
      set: { p256dh, auth, updatedAt: new Date() },
    });
}

export async function removeSubscription(userId: string, endpoint: string) {
  const db = getDb();
  await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}

export async function upsertPushRegistration(input: PushRegistrationInput, executor: DatabaseExecutor = getDb()) {
  const [row] = await executor
    .insert(pushRegistrations)
    .values({
      installationId: input.installationId,
      provider: input.provider,
      userId: input.userId,
      serverId: input.serverId,
      sessionFamilyId: input.sessionFamilyId,
      deviceToken: input.deviceToken,
      topic: input.topic,
      env: input.env,
      appVersion: input.appVersion ?? null,
      revokedAt: null,
      revokedReason: null,
      updatedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: [pushRegistrations.installationId, pushRegistrations.provider],
      set: {
        userId: input.userId,
        serverId: input.serverId,
        sessionFamilyId: input.sessionFamilyId,
        deviceToken: input.deviceToken,
        topic: input.topic,
        env: input.env,
        appVersion: input.appVersion ?? null,
        revokedAt: null,
        revokedReason: null,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  addTraceEvent("push.registration.upserted", {
    registration_id: row.id,
    provider: input.provider,
    env: input.env,
    server_id: input.serverId,
    user_id: input.userId,
  });

  return row;
}

export async function unbindPushInstallation(
  input: { installationId: string; userId: string; serverId: string },
  executor: DatabaseExecutor = getDb(),
): Promise<number> {
  const result = await executor
    .update(pushRegistrations)
    .set({
      userId: null,
      serverId: null,
      sessionFamilyId: null,
      updatedAt: sql`now()`,
    })
    .where(and(
      eq(pushRegistrations.installationId, input.installationId),
      eq(pushRegistrations.userId, input.userId),
      eq(pushRegistrations.serverId, input.serverId),
    ))
    .returning({ id: pushRegistrations.id });

  addTraceEvent("push.registration.unbound", {
    server_id: input.serverId,
    user_id: input.userId,
    unbound_count: result.length,
  });

  return result.length;
}

export async function revokePushRegistration(
  input: { registrationId: string; reason: string },
  executor: DatabaseExecutor = getDb(),
): Promise<void> {
  await executor
    .update(pushRegistrations)
    .set({
      userId: null,
      serverId: null,
      revokedAt: sql`now()`,
      revokedReason: input.reason,
      updatedAt: sql`now()`,
    })
    .where(eq(pushRegistrations.id, input.registrationId));

  addTraceEvent("push.registration.revoked", {
    registration_id: input.registrationId,
    reason: input.reason,
  });
}

function isTerminalApnsTokenError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { statusCode?: unknown; reason?: unknown };
  return candidate.statusCode === 410 || candidate.reason === "BadDeviceToken";
}

function apnsDropReason(err: unknown): string {
  if (!err || typeof err !== "object") return "unknown_error";
  const candidate = err as { statusCode?: unknown; reason?: unknown };
  if (typeof candidate.reason === "string" && candidate.reason) return candidate.reason;
  if (typeof candidate.statusCode === "number") return `status_${candidate.statusCode}`;
  return err instanceof Error ? err.name : "unknown_error";
}

async function deliverMobilePushWithRetry(
  input: ApnsDeliveryInput,
  executor: DatabaseExecutor,
): Promise<"sent" | "skipped" | "revoked" | "dropped"> {
  for (let attempt = 1; attempt <= MOBILE_PUSH_MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await apnsPushProvider.send(input);
      addTraceEvent("push.mobile.delivery.attempt", {
        provider: "apns",
        env: input.env,
        registration_id: input.registrationId,
        message_id: input.payload.messageId,
        attempt,
        status: result.status,
        reason: result.reason ?? null,
      });
      return result.status;
    } catch (err) {
      if (isTerminalApnsTokenError(err)) {
        const reason = apnsDropReason(err);
        await revokePushRegistration({ registrationId: input.registrationId, reason }, executor);
        addTraceEvent("push.mobile.delivery.drop", {
          provider: "apns",
          env: input.env,
          registration_id: input.registrationId,
          message_id: input.payload.messageId,
          attempt,
          status: "revoked",
          reason,
        });
        return "revoked";
      }

      if (attempt === MOBILE_PUSH_MAX_ATTEMPTS) {
        addTraceEvent("push.mobile.delivery.drop", {
          provider: "apns",
          env: input.env,
          registration_id: input.registrationId,
          message_id: input.payload.messageId,
          attempt,
          status: "dropped",
          reason: apnsDropReason(err),
        });
        return "dropped";
      }

      const retryDelayMs = mobilePushDeliveryRuntime.jitterMs(attempt);
      addTraceEvent("push.mobile.delivery.retry_scheduled", {
        provider: "apns",
        env: input.env,
        registration_id: input.registrationId,
        message_id: input.payload.messageId,
        attempt,
        next_attempt: attempt + 1,
        retry_delay_ms: retryDelayMs,
        reason: apnsDropReason(err),
      });
      await mobilePushDeliveryRuntime.sleep(retryDelayMs);
    }
  }

  return "dropped";
}

async function filterMobilePushFactsByServerMode(
  facts: readonly InboxNotificationFactInput[],
  executor: DatabaseExecutor,
): Promise<InboxNotificationFactInput[]> {
  if (facts.length === 0) return [];
  const receiverIds = [...new Set(facts.map((fact) => fact.receiverId))];
  const serverIds = [...new Set(facts.map((fact) => fact.serverId))];
  const memberships = await executor
    .select({
      userId: serverMembers.userId,
      serverId: serverMembers.serverId,
      mode: serverMembers.serverPushMode,
    })
    .from(serverMembers)
    .where(and(
      inArray(serverMembers.userId, receiverIds),
      inArray(serverMembers.serverId, serverIds),
    ));
  const modeByTarget = new Map(
    memberships.map((membership) => [
      `${membership.userId}:${membership.serverId}`,
      membership.mode,
    ]),
  );

  return facts.filter((fact) => {
    const mode = modeByTarget.get(`${fact.receiverId}:${fact.serverId}`);
    const allowed = mode === "all" || (mode === "mentions" && fact.personalMention === true);
    if (!allowed) {
      addTraceEvent("push.mobile.fact.suppressed", {
        receiver_type: fact.receiverType,
        receiver_id: fact.receiverId,
        server_id: fact.serverId,
        source_channel_id: fact.sourceChannelId,
        message_id: fact.messageId,
        mode: mode ?? "missing_membership",
        personal_mention: fact.personalMention === true,
      });
    }
    return allowed;
  });
}

async function filterMobilePushFactsByFeatureGate(
  facts: readonly InboxNotificationFactInput[],
  executor: DatabaseExecutor,
): Promise<InboxNotificationFactInput[]> {
  if (facts.length === 0) return [];
  const evaluationByTarget = new Map<string, Awaited<ReturnType<typeof evaluateFeatureFlag>>>();
  for (const fact of facts) {
    const targetKey = `${fact.receiverId}:${fact.serverId}`;
    if (evaluationByTarget.has(targetKey)) continue;
    evaluationByTarget.set(targetKey, await evaluateFeatureFlag({
      key: MOBILE_PUSH_DELIVERY_FEATURE_FLAG_KEY,
      userId: fact.receiverId,
      serverId: fact.serverId,
      platform: "mobile",
    }, executor));
  }

  return facts.filter((fact) => {
    const evaluation = evaluationByTarget.get(`${fact.receiverId}:${fact.serverId}`);
    if (evaluation?.enabled) return true;
    addTraceEvent("push.mobile.delivery.skipped", {
      reason: "feature_gate",
      gate_key: MOBILE_PUSH_DELIVERY_FEATURE_FLAG_KEY,
      gate_reason: evaluation?.reason ?? "missing_evaluation",
      receiver_id: fact.receiverId,
      server_id: fact.serverId,
      message_id: fact.messageId,
    });
    return false;
  });
}

export async function dispatchMobilePushForInboxFacts(
  facts: readonly InboxNotificationFactInput[],
  executor: DatabaseExecutor = getDb(),
  options: { badgeByReceiverId?: ReadonlyMap<string, number | undefined> } = {},
): Promise<{ attempted: number; sent: number; skipped: number; revoked: number; dropped: number }> {
  const unreadEligibleFacts = facts.filter((fact) =>
    fact.receiverType === "user"
      && fact.unreadEligible !== false
  );
  const featureEnabledFacts = await filterMobilePushFactsByFeatureGate(unreadEligibleFacts, executor);
  const eligibleFacts = await filterMobilePushFactsByServerMode(featureEnabledFacts, executor);
  if (eligibleFacts.length === 0) return { attempted: 0, sent: 0, skipped: 0, revoked: 0, dropped: 0 };

  let attempted = 0;
  let sent = 0;
  let skipped = 0;
  let revoked = 0;
  let dropped = 0;

  for (const fact of eligibleFacts) {
    const registrations = await executor
      .select({
        id: pushRegistrations.id,
        installationId: pushRegistrations.installationId,
        deviceToken: pushRegistrations.deviceToken,
        topic: pushRegistrations.topic,
        env: pushRegistrations.env,
      })
      .from(pushRegistrations)
      .innerJoin(sessionFamilies, and(
        eq(pushRegistrations.sessionFamilyId, sessionFamilies.id),
        isNull(sessionFamilies.revokedAt),
      ))
      .where(and(
        eq(pushRegistrations.provider, "apns"),
        eq(pushRegistrations.userId, fact.receiverId),
        isNull(pushRegistrations.revokedAt),
        exists(
          executor
            .select({ id: sessions.id })
            .from(sessions)
            .where(and(
              eq(sessions.familyId, sessionFamilies.id),
              gt(sessions.expiresAt, currentDate()),
            )),
        ),
      ));

    addTraceEvent("push.mobile.targets.built", {
      provider: "apns",
      receiver_type: fact.receiverType,
      receiver_id: fact.receiverId,
      server_id: fact.serverId,
      source_channel_id: fact.sourceChannelId,
      message_id: fact.messageId,
      target_count: registrations.length,
    });

    const payload = await buildMobilePushPayload(fact, executor, {
      badgeResolved: options.badgeByReceiverId?.has(fact.receiverId) ?? false,
      badge: options.badgeByReceiverId?.get(fact.receiverId),
    });

    for (const registration of registrations) {
      attempted += 1;
      const outcome = await deliverMobilePushWithRetry({
        registrationId: registration.id,
        installationId: registration.installationId,
        deviceToken: registration.deviceToken,
        topic: registration.topic,
        env: registration.env as PushRegistrationEnv,
        payload,
      }, executor);
      if (outcome === "sent") sent += 1;
      if (outcome === "skipped") skipped += 1;
      if (outcome === "revoked") revoked += 1;
      if (outcome === "dropped") dropped += 1;
    }
  }

  addTraceEvent("push.mobile.delivery.summary", {
    provider: "apns",
    fact_count: eligibleFacts.length,
    attempted,
    sent,
    skipped,
    revoked,
    dropped,
  });

  return { attempted, sent, skipped, revoked, dropped };
}

/**
 * The phone badge: the sum of the user's in-app Activity badges, read through
 * the SAME function the app uses, so the two can never count by different rules.
 * It reads RisingWave (a hard dependency: unconfigured or a failed read throws),
 * so callers must not hold a Postgres transaction open around it: a slow
 * RisingWave read would leave that transaction idle, holding a pooled server
 * connection. The outbox drain loads it before entering the channel writer fence.
 */
export async function loadMobilePushBadge(receiverId: string, executor: DatabaseExecutor = getDb()): Promise<number> {
  const memberships = await executor
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(eq(serverMembers.userId, receiverId));
  const totals = await getActivityUnreadTotalsBatch(
    memberships.map((row) => ({ serverId: row.serverId })),
    receiverId,
  );
  const unreadCount = [...totals.values()].reduce((sum, row) => sum + row.totalUnreadCount, 0);
  return Math.min(9_999, Math.max(1, Number.isFinite(unreadCount) ? unreadCount : 1));
}

/**
 * The badge is decoration on a notification that must still be delivered: when
 * RisingWave cannot answer, send the push without a badge (the device keeps its
 * current one) rather than failing, retrying and finally dropping the push.
 */
export async function loadMobilePushBadgeOrUnknown(
  receiverId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<number | undefined> {
  try {
    return await loadMobilePushBadge(receiverId, executor);
  } catch (err) {
    console.warn(`[PushService] badge unavailable, sending without badge: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

async function buildMobilePushPayload(
  fact: InboxNotificationFactInput,
  executor: DatabaseExecutor,
  options: { badge?: number; badgeResolved?: boolean } = {},
): Promise<MobilePushPayload> {
  const [messageRow] = await executor
    .select({
      content: messages.content,
      messageType: messages.messageType,
      senderType: messages.senderType,
      senderId: messages.senderId,
    })
    .from(messages)
    .where(eq(messages.id, fact.messageId))
    .limit(1);
  const [attachmentRow] = await executor
    .select({ count: sql<number>`COUNT(*)` })
    .from(attachments)
    .where(eq(attachments.messageId, fact.messageId));
  const [serverRow] = await executor
    .select({ name: servers.name, slug: servers.slug })
    .from(servers)
    .where(eq(servers.id, fact.serverId))
    .limit(1);
  const [sourceChannel] = await executor
    .select({
      name: channels.name,
      type: channels.type,
      parentMessageId: channels.parentMessageId,
    })
    .from(channels)
    .where(eq(channels.id, fact.sourceChannelId))
    .limit(1);

  let senderName = messageRow?.messageType === "system" ? "Raft" : "Unknown sender";
  if (messageRow?.senderType === "user" && UUID_RE.test(messageRow.senderId)) {
    const [sender] = await executor
      .select({ name: users.name, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, messageRow.senderId))
      .limit(1);
    senderName = sender?.displayName?.trim() || sender?.name?.trim() || senderName;
  } else if (messageRow?.senderType === "agent" && UUID_RE.test(messageRow.senderId)) {
    const [sender] = await executor
      .select({ name: agents.name, displayName: agents.displayName })
      .from(agents)
      .where(eq(agents.id, messageRow.senderId))
      .limit(1);
    senderName = sender?.displayName?.trim() || sender?.name?.trim() || senderName;
  }

  const badge = options.badgeResolved || options.badge !== undefined
    ? options.badge
    : await loadMobilePushBadgeOrUnknown(fact.receiverId, executor);


  const attachmentCount = Number(attachmentRow?.count ?? 0);
  const messagePreview = messageRow
    ? summarizePushBody(messageRow.content, Number.isFinite(attachmentCount) ? attachmentCount : 0)
    : "You have a new message";
  const alertBody = messageRow
    ? formatPushBody(senderName, messagePreview, fact.personalMention === true)
    : messagePreview;
  const serverLabel = formatPushServerLabel(serverRow?.name, serverRow?.slug ?? "Raft");

  if (fact.kind !== "thread") {
    const surface = fact.kind === "dm"
      ? "DM"
      : sourceChannel?.name?.trim()
        ? `#${sourceChannel.name.trim()}`
        : "Message";
    return {
      serverId: fact.serverId,
      channelId: fact.sourceChannelId,
      messageId: fact.messageId,
      kind: fact.kind,
      badge,
      alertTitle: formatPushSurfaceTitle(surface, serverLabel),
      alertBody,
    };
  }

  const parentMessageId = sourceChannel?.parentMessageId ?? undefined;
  let parentChannelId: string | undefined;
  let parentChannelName: string | undefined;
  let parentChannelType: (typeof channels.$inferSelect)["type"] | undefined;
  if (parentMessageId) {
    const [parentMessage] = await executor
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, parentMessageId))
      .limit(1);
    parentChannelId = parentMessage?.channelId;
    if (parentChannelId) {
      const [parentChannel] = await executor
        .select({ name: channels.name, type: channels.type })
        .from(channels)
        .where(eq(channels.id, parentChannelId))
        .limit(1);
      parentChannelName = parentChannel?.name?.trim() || undefined;
      parentChannelType = parentChannel?.type;
    }
  }

  const threadScope = parentChannelType === "dm"
    ? "DM"
    : parentChannelName
      ? `#${parentChannelName}`
      : null;
  const alertTitle = formatPushSurfaceTitle(
    threadScope ? `Thread in ${threadScope}` : "Thread",
    serverLabel,
  );

  return {
    serverId: fact.serverId,
    channelId: fact.sourceChannelId,
    threadId: fact.sourceChannelId,
    ...(parentChannelId ? { parentChannelId } : {}),
    ...(parentMessageId ? { parentMessageId } : {}),
    messageId: fact.messageId,
    kind: fact.kind,
    badge,
    alertTitle,
    alertBody,
  };
}

type MobilePushOutboxStatus = "pending" | "processing" | "sent" | "skipped" | "revoked" | "dropped";

function mobilePushOutboxTerminalStatus(summary: { attempted: number; sent: number; skipped: number; revoked: number; dropped: number }): MobilePushOutboxStatus {
  if (summary.dropped > 0) return "dropped";
  if (summary.revoked > 0) return "revoked";
  if (summary.sent > 0) return "sent";
  return "skipped";
}

function boundedOutboxError(err: unknown): string {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

function outboxRowToInboxFact(row: {
  receiverType: "user";
  receiverId: string;
  serverId: string;
  kind: "channel" | "dm" | "thread";
  sourceChannelId: string;
  messageId: string;
  messageSeq: number;
  activityAt: Date;
  personalMention: boolean;
  unreadEligible: boolean;
}): InboxNotificationFactInput {
  return {
    receiverType: row.receiverType,
    receiverId: row.receiverId,
    serverId: row.serverId,
    kind: row.kind,
    sourceChannelId: row.sourceChannelId,
    messageId: row.messageId,
    messageSeq: row.messageSeq,
    activityAt: row.activityAt,
    personalMention: row.personalMention,
    unreadEligible: row.unreadEligible,
  };
}

export async function drainMobilePushOutbox(
  batchSize = MOBILE_PUSH_OUTBOX_BATCH_SIZE,
  executor: DatabaseExecutor = getDb(),
): Promise<{ claimed: number; processed: number }> {
  const staleLockedAt = new Date(currentTimeMs() - MOBILE_PUSH_OUTBOX_LOCK_TIMEOUT_MS);
  const candidates = await executor
    .select()
    .from(mobilePushOutbox)
    .where(or(
      eq(mobilePushOutbox.status, "pending"),
      and(eq(mobilePushOutbox.status, "processing"), lt(mobilePushOutbox.lockedAt, staleLockedAt)),
    ))
    .orderBy(asc(mobilePushOutbox.createdAt))
    .limit(batchSize);

  let claimed = 0;
  let processed = 0;

  for (const candidate of candidates) {
    const [row] = await executor
      .update(mobilePushOutbox)
      .set({
        status: "processing",
        lockedAt: sql`now()`,
        attemptCount: sql`${mobilePushOutbox.attemptCount} + 1`,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(mobilePushOutbox.id, candidate.id),
        or(
          eq(mobilePushOutbox.status, "pending"),
          and(eq(mobilePushOutbox.status, "processing"), lt(mobilePushOutbox.lockedAt, staleLockedAt)),
        ),
      ))
      .returning();
    if (!row) continue;
    claimed += 1;
    await afterMobilePushOutboxClaimForTest?.();

    try {
      // The badge reads RisingWave: load it before the writer fence opens its
      // transaction, never while holding one.
      const badgeByReceiverId = new Map([[row.receiverId, await loadMobilePushBadgeOrUnknown(row.receiverId, executor)]]);
      // Serialize the final authority read and provider call with channel
      // conversion. A worker that claimed before cutover either completes
      // while still owning the source lock (therefore before cutover), or waits
      // and observes the row revoked. It cannot publish after audience loss.
      const dispatchWithFreshAuthority = async (tx: DatabaseExecutor) => {
        const [current] = await tx
          .select({ status: mobilePushOutbox.status })
          .from(mobilePushOutbox)
          .where(eq(mobilePushOutbox.id, row.id))
          .limit(1);
        if (current?.status !== "processing") {
          return { attempted: 0, sent: 0, skipped: 0, revoked: 1, dropped: 0 };
        }
        return dispatchMobilePushForInboxFacts([outboxRowToInboxFact(row)], tx, { badgeByReceiverId });
      };
      const summary = mobilePushOutboxMutationForTest === "conversion_authority_bypass"
        // Witnessed predecessor: dispatch from the stale claimed row without
        // acquiring/re-reading the source authority. The Block 5 race tooth
        // proves this can call APNs after the row was revoked by cutover.
        ? await dispatchMobilePushForInboxFacts([outboxRowToInboxFact(row)], executor, { badgeByReceiverId })
        : await withChannelWriterFence(row.sourceChannelId, dispatchWithFreshAuthority);
      const status = mobilePushOutboxTerminalStatus(summary);
      await executor
        .update(mobilePushOutbox)
        .set({
          status,
          attemptedCount: summary.attempted,
          sentCount: summary.sent,
          skippedCount: summary.skipped,
          revokedCount: summary.revoked,
          droppedCount: summary.dropped,
          lastError: null,
          processedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(and(
          eq(mobilePushOutbox.id, row.id),
          eq(mobilePushOutbox.status, "processing"),
        ));
      processed += 1;
    } catch (err) {
      const nextStatus: MobilePushOutboxStatus = row.attemptCount >= MOBILE_PUSH_MAX_ATTEMPTS ? "dropped" : "pending";
      await executor
        .update(mobilePushOutbox)
        .set({
          status: nextStatus,
          lastError: boundedOutboxError(err),
          lockedAt: null,
          processedAt: nextStatus === "dropped" ? sql`now()` : null,
          updatedAt: sql`now()`,
        })
        .where(and(
          eq(mobilePushOutbox.id, row.id),
          eq(mobilePushOutbox.status, "processing"),
        ));
      addTraceEvent("push.mobile.outbox.drain_error", {
        outbox_id: row.id,
        status: nextStatus,
        reason: err instanceof Error ? err.name : "unknown_error",
      });
    }
  }

  return { claimed, processed };
}

function scheduleMobilePushOutboxDrain() {
  mobilePushDeliveryRuntime.schedule(async () => {
    await drainMobilePushOutbox();
  });
}

/**
 * A joint channel has one local copy per participating server, and a person in
 * several of them gets one Activity fact per copy for the same message. The
 * phone must still buzz once, so keep one fact per person + message. Prefer a
 * copy whose server push mode lets it through (each server keeps its own
 * all/mentions/none), then the lowest source channel id, so a retried enqueue
 * lands on the same outbox row and conflicts instead of adding another.
 */
async function collapseJointCopiesForPush(
  facts: readonly InboxNotificationFactInput[],
  executor: DatabaseExecutor,
): Promise<Array<InboxNotificationFactInput & { receiverType: "user" }>> {
  const groups = new Map<string, InboxNotificationFactInput[]>();
  for (const fact of facts) {
    const key = `${fact.receiverId}:${fact.messageId}`;
    const group = groups.get(key);
    if (group) group.push(fact);
    else groups.set(key, [fact]);
  }
  const duplicated = [...groups.values()].filter((group) => group.length > 1);
  const modeByTarget = new Map<string, string>();
  if (duplicated.length > 0) {
    const copies = duplicated.flat();
    const memberships = await executor
      .select({ userId: serverMembers.userId, serverId: serverMembers.serverId, mode: serverMembers.serverPushMode })
      .from(serverMembers)
      .where(and(
        inArray(serverMembers.userId, [...new Set(copies.map((fact) => fact.receiverId))]),
        inArray(serverMembers.serverId, [...new Set(copies.map((fact) => fact.serverId))]),
      ));
    for (const membership of memberships) modeByTarget.set(`${membership.userId}:${membership.serverId}`, membership.mode);
  }
  return [...groups.values()].map((group) => {
    const personalMention = group.some((fact) => fact.personalMention === true);
    const pushable = (fact: InboxNotificationFactInput) => {
      const mode = modeByTarget.get(`${fact.receiverId}:${fact.serverId}`);
      return mode === "all" || (mode === "mentions" && personalMention);
    };
    const [chosen] = [...group].sort((a, b) =>
      Number(pushable(b)) - Number(pushable(a)) || (a.sourceChannelId < b.sourceChannelId ? -1 : a.sourceChannelId > b.sourceChannelId ? 1 : 0));
    return { ...chosen!, receiverType: "user" as const, personalMention };
  });
}

export async function enqueueMobilePushForInboxFacts(
  facts: readonly InboxNotificationFactInput[],
  executor: DatabaseExecutor = getDb(),
): Promise<number> {
  const queuedFacts = await collapseJointCopiesForPush(
    facts.filter((fact) => fact.receiverType === "user" && fact.unreadEligible !== false),
    executor,
  );
  if (queuedFacts.length === 0) return 0;
  // Chunked to PostgreSQL's per-statement bind-parameter limit: a large channel's fan-out in one
  // multi-row VALUES fails the whole message transaction (≈5,957 receivers at 11 per row).
  const insertedRows: { id: string }[] = [];
  for (const chunk of chunkForBindParameters(queuedFacts, insertParametersPerRow(mobilePushOutbox))) insertedRows.push(...await executor
    .insert(mobilePushOutbox)
    .values(chunk.map((fact) => ({
      receiverType: fact.receiverType,
      receiverId: fact.receiverId,
      serverId: fact.serverId,
      kind: fact.kind,
      sourceChannelId: fact.sourceChannelId,
      messageId: fact.messageId,
      messageSeq: fact.messageSeq,
      activityAt: fact.activityAt,
      personalMention: fact.personalMention === true,
      unreadEligible: fact.unreadEligible !== false,
      updatedAt: sql`now()`,
    })))
    .onConflictDoNothing({
      target: [
        mobilePushOutbox.receiverType,
        mobilePushOutbox.receiverId,
        mobilePushOutbox.sourceChannelId,
        mobilePushOutbox.messageId,
      ],
    })
    .returning({ id: mobilePushOutbox.id }));

  addTraceEvent("push.mobile.delivery.enqueued", {
    fact_count: queuedFacts.length,
    joint_copies_collapsed: facts.filter((fact) => fact.receiverType === "user" && fact.unreadEligible !== false).length - queuedFacts.length,
    outbox_count: insertedRows.length,
  });

  if (insertedRows.length > 0) scheduleMobilePushOutboxDrain();
  return insertedRows.length;
}

export interface MobilePushOutboxWorker {
  stop(): void;
}

interface MobilePushOutboxWorkerClock {
  scheduleEvery(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultMobilePushOutboxWorkerClock: MobilePushOutboxWorkerClock = {
  scheduleEvery: setClockInterval,
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

async function runMobilePushOutboxWorkerDrain(
  batchSize: number,
  tracer: Tracer,
  trigger: "startup" | "interval_worker",
) {
  const span = tracer.startSpan("server.push.mobile_outbox.drain", {
    surface: "server",
    kind: "internal",
    attrs: {
      trigger,
      batch_size: batchSize,
    },
  });
  try {
    const result = await runWithTraceSpan(span, () => drainMobilePushOutbox(batchSize), tracer);
    span.end("ok", {
      attrs: {
        claimed_count: result.claimed,
        processed_count: result.processed,
      },
    });
    return result;
  } catch (error) {
    const errorClass = errorClassOf(error);
    span.addEvent("error", { error_class: errorClass });
    span.end("error", { attrs: { error_class: errorClass } });
    throw error;
  }
}

export function startMobilePushOutboxWorker(opts: {
  intervalMs?: number;
  batchSize?: number;
  clock?: MobilePushOutboxWorkerClock;
  tracer?: Tracer;
} = {}): MobilePushOutboxWorker {
  const intervalMs = opts.intervalMs ?? 15_000;
  const batchSize = opts.batchSize ?? MOBILE_PUSH_OUTBOX_BATCH_SIZE;
  const clock = opts.clock ?? defaultMobilePushOutboxWorkerClock;
  const tracer = opts.tracer ?? noopTracer;
  const run = (trigger: "startup" | "interval_worker") => {
    runMobilePushOutboxWorkerDrain(batchSize, tracer, trigger).catch((err) => {
      console.error("[PushService] Failed to drain mobile push outbox:", err);
    });
  };
  run("startup");
  const timer = clock.scheduleEvery(() => run("interval_worker"), intervalMs);
  if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") timer.unref();
  return {
    stop() {
      clock.clearInterval(timer);
    },
  };
}

export async function sendPushToUsers(userIds: string[], payload: PushPayload) {
  if (!webPushRuntime.enabled || userIds.length === 0) {
    return { attempted: 0, delivered: 0, failed: 0 };
  }

  const db = getDb();
  const subscriptions = await db
    .select()
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.userId, userIds));

  if (subscriptions.length === 0) {
    return { attempted: 0, delivered: 0, failed: 0 };
  }

  const body = JSON.stringify(payload);
  const dropSubscription = (id: string) =>
    db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id)).catch(() => {});
  const results = await Promise.allSettled(
    subscriptions.map(async (subscription) => {
      // Rows may predate endpoint validation, so every send re-checks the host
      // and pins the connection to the vetted address instead of letting the
      // HTTP client resolve the name a second time.
      const pinned = await resolvePublicWebPushAddress(subscription.endpoint);
      if (!pinned) {
        await dropSubscription(subscription.id);
        throw new Error("Web Push endpoint is not a public HTTPS host");
      }
      try {
        await webPushRuntime.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          body,
          {
            TTL: DEFAULT_PUSH_TTL_SECONDS,
            agent: new HttpsAgent({ lookup: createAppWebhookPinnedLookup(pinned) as never }),
          },
        );
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await dropSubscription(subscription.id);
        }
        throw err;
      }
    }),
  );

  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length > 0) {
    console.warn(`[PushService] ${failed.length}/${subscriptions.length} push deliveries failed`);
  }

  return {
    attempted: subscriptions.length,
    delivered: subscriptions.length - failed.length,
    failed: failed.length,
  };
}

export async function sendPushNotifications(targets: Array<{ userId: string; payload: PushPayload }>) {
  if (!webPushRuntime.enabled || targets.length === 0) return;

  const byPayload = new Map<string, { payload: PushPayload; userIds: string[] }>();
  for (const target of targets) {
    const key = JSON.stringify(target.payload);
    const bucket = byPayload.get(key);
    if (bucket) {
      bucket.userIds.push(target.userId);
    } else {
      byPayload.set(key, { payload: target.payload, userIds: [target.userId] });
    }
  }

  await Promise.all(
    [...byPayload.values()].map(({ userIds, payload }) => sendPushToUsers(userIds, payload)),
  );
}
