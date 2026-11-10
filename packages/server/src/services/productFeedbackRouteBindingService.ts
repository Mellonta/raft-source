import { privacyModeEnabled } from "@botiverse/raft-shared/src/privacyMode";
import { createHash, timingSafeEqual } from "node:crypto";
import { currentTimeMs } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { integrationSecretCommitments } from "../db/schema";
import { withTraceChildSpan } from "../tracing/semanticTrace";
import { productFeedbackReporterId } from "./productFeedbackService";
import {
  feedbackRouteTuple,
  mintProductFeedbackRouteSubject,
  ProductFeedbackRouteSubjectError,
} from "./productFeedbackRouteSubject";

const COMMITMENT_LABEL = "hands-feedback-route-subject:v1";
// The per-source apps share their own root (productFeedbackApps), committed
// under a separate label so it never collides with the legacy root.
const MULTI_COMMITMENT_LABEL = "hands-feedback-route-subject:multi:v1";
const CACHE_MAX = 10_000;
const CACHE_TTL_MS = 5 * 60_000;
// Hands answers a route-subject PUT in well under a second. Without an explicit
// bound a stalled connect waited for undici's 10s connect timeout, which is what
// reporters saw right after each deploy (Eric, 2026-10-15).
const HANDS_REQUEST_TIMEOUT_MS = 4_000;
const HANDS_RETRY_DELAY_MS = 250;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ProductFeedbackRouteBindingError extends Error {
  /** Fixed operator-log code (a status number at most); never a value. */
  constructor(readonly reason: string = "unknown") {
    super("feedback integration unavailable");
    this.name = "ProductFeedbackRouteBindingError";
  }
}

export type ProductFeedbackRouteConfig = {
  baseUrl: string;
  appId: string;
  appToken: string;
  credentialRevision: string;
  reporterIntegrationId: string;
  keyId: "v1";
  root: string;
  commitmentLabel: string;
  reporterIdSecret: string;
};

const successes = new Map<string, number>();
// A fresh task starts with an empty success cache, so every active reporter's
// first request after a deploy binds at once. Concurrent bindings of the same
// tuple share one Hands call.
const inFlight = new Map<string, Promise<void>>();
// The root commitment never changes once written (rotating the root is a
// separate, explicit procedure), so one successful check per process is enough;
// re-checking wrote and read the database on every feedback request.
const verifiedCommitments = new Set<string>();

export function resetProductFeedbackRouteBindingCacheForTest(): void {
  successes.clear();
  inFlight.clear();
  verifiedCommitments.clear();
}

export function readProductFeedbackRouteConfig(env: NodeJS.ProcessEnv = process.env): ProductFeedbackRouteConfig {
  if (privacyModeEnabled()) throw new ProductFeedbackRouteBindingError();
  const baseUrl = env.HANDS_FEEDBACK_BASE_URL?.trim();
  const appId = env.HANDS_FEEDBACK_APP_ID?.trim();
  const appToken = env.HANDS_FEEDBACK_CONVERSATION_APP_TOKEN?.trim();
  const credentialRevision = env.HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION?.trim();
  const reporterIntegrationId = env.HANDS_FEEDBACK_REPORTER_INTEGRATION_ID?.trim();
  const keyId = env.HANDS_FEEDBACK_ROUTE_SUBJECT_KEY_ID?.trim();
  const root = env.HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT?.trim();
  const reporterIdSecret = env.HANDS_FEEDBACK_REPORTER_ID_SECRET?.trim();
  const commitmentLabel = env.HANDS_FEEDBACK_ROUTE_SUBJECT_COMMITMENT_SCOPE === "multi"
    ? MULTI_COMMITMENT_LABEL
    : COMMITMENT_LABEL;
  if (
    !baseUrl || !appId || !appToken || !credentialRevision || !reporterIntegrationId
    || keyId !== "v1" || !root || !reporterIdSecret
    || !UUID_RE.test(appId)
    || (!UUID_RE.test(reporterIntegrationId) && reporterIntegrationId !== `legacy-feedback:${appId}`)
  ) throw new ProductFeedbackRouteBindingError("config_invalid");
  try {
    const decoded = Buffer.from(root, "base64url");
    if (!/^[A-Za-z0-9_-]{43}$/.test(root) || decoded.length !== 32 || decoded.toString("base64url") !== root) throw new Error();
  } catch {
    throw new ProductFeedbackRouteBindingError("root_invalid");
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""), appId, appToken, credentialRevision,
    reporterIntegrationId, keyId, root, commitmentLabel, reporterIdSecret,
  };
}

export function isProductFeedbackRouteConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    readProductFeedbackRouteConfig(env);
    return true;
  } catch {
    return false;
  }
}

export function productFeedbackRouteRootCommitment(root: string, label: string = COMMITMENT_LABEL): Buffer {
  return createHash("sha256").update(feedbackRouteTuple(label, Buffer.from(root, "base64url"))).digest();
}

export async function assertProductFeedbackRouteRootCommitment(
  config: ProductFeedbackRouteConfig,
  executor: DatabaseExecutor = getDb(),
): Promise<Buffer> {
  const commitment = productFeedbackRouteRootCommitment(config.root, config.commitmentLabel);
  await executor.insert(integrationSecretCommitments).values({
    label: config.commitmentLabel,
    commitment,
  }).onConflictDoNothing();
  const [row] = await executor.select({ commitment: integrationSecretCommitments.commitment })
    .from(integrationSecretCommitments)
    .where(eq(integrationSecretCommitments.label, config.commitmentLabel));
  if (!row || row.commitment.length !== commitment.length || !timingSafeEqual(row.commitment, commitment)) {
    throw new ProductFeedbackRouteBindingError("root_commitment_mismatch");
  }
  return commitment;
}

function remember(key: string, expiresAt: number): void {
  if (successes.size >= CACHE_MAX && !successes.has(key)) {
    const oldest = successes.keys().next().value as string | undefined;
    if (oldest) successes.delete(oldest);
  }
  successes.delete(key);
  successes.set(key, expiresAt);
}

async function verifiedRootCommitment(
  config: ProductFeedbackRouteConfig,
  executor: DatabaseExecutor | undefined,
): Promise<Buffer> {
  const commitment = productFeedbackRouteRootCommitment(config.root, config.commitmentLabel);
  const key = `${config.commitmentLabel}\0${commitment.toString("hex")}`;
  if (verifiedCommitments.has(key)) return commitment;
  await withTraceChildSpan(
    "server.product_feedback.route_commitment",
    { surface: "server", kind: "internal" },
    async () => {
      try {
        await assertProductFeedbackRouteRootCommitment(config, executor);
      } catch (error) {
        if (error instanceof ProductFeedbackRouteBindingError) throw error;
        throw new ProductFeedbackRouteBindingError("commitment_failed");
      }
    },
    { onError: (error) => ({ reason: handsFailureReason(error) }) },
  );
  verifiedCommitments.add(key);
  return commitment;
}

/** A fixed reason code for a failed Hands call: timeout, an upstream status, or the low-level error code. */
function handsFailureReason(error: unknown): string {
  if (error instanceof ProductFeedbackRouteBindingError) return error.reason;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  const cause = error instanceof Error ? (error as Error & { cause?: { code?: unknown } }).cause : undefined;
  const code = typeof cause?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(cause.code) ? cause.code : null;
  return code ? `network_${code}` : "request_failed";
}

function isRetryableHandsFailure(reason: string): boolean {
  return reason === "timeout" || reason.startsWith("network_") || reason === "request_failed" || /^hands_status_5\d\d$/.test(reason);
}

async function putRouteSubjectOnce(
  config: ProductFeedbackRouteConfig,
  reporterId: string,
  subject: string,
  fetchImpl: typeof fetch,
  attempt: number,
): Promise<void> {
  // Child span per Hands call: the reason code (timeout, network_<code>, status)
  // and duration are what the deploy-time 5xx bursts lacked (AndyLok).
  await withTraceChildSpan(
    "server.product_feedback.route_binding",
    { surface: "server", kind: "client", attrs: { attempt } },
    () => putRouteSubjectRequest(config, reporterId, subject, fetchImpl),
    { onError: (error) => ({ reason: handsFailureReason(error) }) },
  );
}

async function putRouteSubjectRequest(
  config: ProductFeedbackRouteConfig,
  reporterId: string,
  subject: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(
    `${config.baseUrl}/api/apps/${encodeURIComponent(config.appId)}/reporter-feedback/route-subject`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${config.appToken}`,
        "Content-Type": "application/json",
        "X-Hands-Reporter-Id": reporterId,
      },
      body: JSON.stringify({ route_subject: subject }),
      signal: AbortSignal.timeout(HANDS_REQUEST_TIMEOUT_MS),
    },
  );
  if (response.status !== 200 && response.status !== 201) {
    throw new ProductFeedbackRouteBindingError(`hands_status_${response.status}`);
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || Object.keys(body).sort().join("\0") !== "changed\0subject_version"
    || typeof body.changed !== "boolean" || body.subject_version !== "v1"
    || (response.status === 201) !== body.changed) throw new ProductFeedbackRouteBindingError("hands_unexpected_body");
}

/** One Hands PUT, retried once on a transient failure (timeout, network error, 5xx). */
async function putRouteSubject(
  config: ProductFeedbackRouteConfig,
  reporterId: string,
  subject: string,
  fetchImpl: typeof fetch,
  retryDelayMs: number = HANDS_RETRY_DELAY_MS,
): Promise<void> {
  try {
    await putRouteSubjectOnce(config, reporterId, subject, fetchImpl, 1);
    return;
  } catch (error) {
    const reason = handsFailureReason(error);
    if (!isRetryableHandsFailure(reason)) throw new ProductFeedbackRouteBindingError(reason);
  }
  if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  try {
    await putRouteSubjectOnce(config, reporterId, subject, fetchImpl, 2);
  } catch (error) {
    throw new ProductFeedbackRouteBindingError(handsFailureReason(error));
  }
}

export async function ensureProductFeedbackRouteBinding(input: {
  userId: string;
  reporterId?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  nowMs?: number;
  executor?: DatabaseExecutor;
  /** Pause before the single retry; tests pass 0. */
  retryDelayMs?: number;
}): Promise<{ reporterId: string }> {
  try {
    const config = readProductFeedbackRouteConfig(input.env);
    if (!UUID_RE.test(input.userId)) throw new Error();
    const reporterId = input.reporterId ?? productFeedbackReporterId(input.userId, config.reporterIdSecret);
    const commitment = await verifiedRootCommitment(config, input.executor);
    const cacheKey = feedbackRouteTuple(
      config.credentialRevision, config.keyId, commitment, config.appId,
      config.reporterIntegrationId, reporterId,
    ).toString("base64url");
    const now = input.nowMs ?? currentTimeMs();
    if ((successes.get(cacheKey) ?? 0) > now) return { reporterId };
    successes.delete(cacheKey);
    const pending = inFlight.get(cacheKey);
    if (pending) {
      await pending;
      return { reporterId };
    }
    const subject = mintProductFeedbackRouteSubject({
      root: config.root,
      userId: input.userId,
      coordinate: { appId: config.appId, reporterIntegrationId: config.reporterIntegrationId, reporterId },
    });
    const binding = putRouteSubject(config, reporterId, subject, input.fetchImpl ?? globalThis.fetch, input.retryDelayMs);
    inFlight.set(cacheKey, binding);
    try {
      await binding;
    } finally {
      if (inFlight.get(cacheKey) === binding) inFlight.delete(cacheKey);
    }
    remember(cacheKey, now + CACHE_TTL_MS);
    return { reporterId };
  } catch (error) {
    if (error instanceof ProductFeedbackRouteBindingError) throw error;
    if (error instanceof ProductFeedbackRouteSubjectError) throw new ProductFeedbackRouteBindingError("route_subject_invalid");
    throw new ProductFeedbackRouteBindingError("request_failed");
  }
}
