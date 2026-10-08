import { createHmac } from "node:crypto";
import { DISTRIBUTION_POLICY } from "@botiverse/raft-shared";
import type { Brand } from "@botiverse/raft-shared";

export type ProductFeedbackKind = "idea" | "problem";

export type ProductFeedbackAttachment = {
  buffer: Buffer;
  filename: string;
  contentType: string;
};

export type ProductFeedbackClientKind = "web" | "ios" | "android";

/**
 * Server-derived reporter attribution attached to a feedback submission.
 *
 * Every field is resolved on the server: `server_id` is validated against the
 * submitter's membership, `server_slug` and `handle` are looked up from that
 * validated id / the authenticated user. A client-supplied value is never
 * trusted, because it could impersonate another reporter. The block is
 * forwarded to Hands as an opaque JSON object under
 * `metadata.reporter_attribution` (Hands stores it whole and does not parse it).
 */
export type ProductFeedbackReporterAttribution = {
  v: 1;
  server_id: string;
  server_slug: string;
  user_id: string;
  handle: string;
};

export type ProductFeedbackMetadata = {
  trustedClientKind?: unknown;
  clientKind?: unknown;
  platform?: unknown;
  clientVersion?: unknown;
  webVersion?: unknown;
  locale?: unknown;
  browser?: unknown;
  osVersion?: unknown;
  viewport?: unknown;
};

export type ProductFeedbackNormalizedMetadata = {
  clientKind: ProductFeedbackClientKind;
  /**
   * Present only when the submitter's server could be validated. Absent for
   * clients that send no server context (older builds) and when validation fails;
   * absence must never block submission.
   */
  reporterAttribution?: ProductFeedbackReporterAttribution;
  platform: ProductFeedbackClientKind;
  clientVersion?: string;
  webVersion?: string;
  locale?: string;
  browser?: string;
  osVersion?: string;
  viewport?: string;
};

/**
 * Id of an agent issue report whose debug bundle the trace upload worker
 * already stored (`POST /api/reports` mints it). Forwarded to Hands only as
 * `metadata.feedback_report_id` so developer tooling can go from a ticket to
 * the debug evidence; the evidence itself never enters Hands. Mint with
 * {@link asFeedbackReportId}.
 */
export type FeedbackReportId = Brand<string, "FeedbackReportId">;

const FEEDBACK_REPORT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function asFeedbackReportId(value: unknown): FeedbackReportId | null {
  return typeof value === "string" && FEEDBACK_REPORT_ID_RE.test(value) ? value as FeedbackReportId : null;
}

export type ProductFeedbackSubmission = {
  submissionId: string;
  kind: ProductFeedbackKind;
  message: string;
  contact: string | null;
  userId: string;
  metadata: ProductFeedbackNormalizedMetadata;
  attachments: ProductFeedbackAttachment[];
  /** Set when the ticket is filed from an agent's Report Issue dialog. */
  feedbackReportId?: FeedbackReportId;
};

export type ProductFeedbackReceipt = {
  id: string;
  status: string;
  reference: string | null;
  attachments: number;
};

export class ProductFeedbackConfigurationError extends Error {
  constructor() {
    super("Hands product feedback is not configured");
    this.name = "ProductFeedbackConfigurationError";
  }
}

export class ProductFeedbackUpstreamError extends Error {
  constructor(
    public readonly upstreamStatus: number | null,
    public readonly retryAfter: string | null = null,
    public readonly upstreamError: string | null = null,
  ) {
    super(upstreamStatus === null
      ? "Hands product feedback request failed"
      : `Hands product feedback returned HTTP ${upstreamStatus}`);
    this.name = "ProductFeedbackUpstreamError";
  }
}

const UPSTREAM_ERROR_BODY_MAX_BYTES = 4 * 1024;
const UPSTREAM_ERROR_MESSAGE_MAX_CHARS = 256;

async function readUpstreamError(response: Response): Promise<string | null> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" || !response.body) return null;

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > UPSTREAM_ERROR_BODY_MAX_BYTES) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > UPSTREAM_ERROR_BODY_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const error = (parsed as Record<string, unknown>).error;
    if (typeof error !== "string") return null;
    const normalized = error.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    return normalized ? normalized.slice(0, UPSTREAM_ERROR_MESSAGE_MAX_CHARS) : null;
  } catch {
    return null;
  }
}

export class ProductFeedbackValidationError extends Error {
  constructor() {
    super("Invalid product feedback attribution");
    this.name = "ProductFeedbackValidationError";
  }
}

type ProductFeedbackServiceConfig = {
  baseUrl: string;
  appSlug: string;
  clientKey: string;
  appToken: string;
  reporterIdSecret: string;
};

export function isProductFeedbackConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!DISTRIBUTION_POLICY.upstreamServices) return false;
  return Boolean(
    env.HANDS_FEEDBACK_BASE_URL?.trim()
    && env.HANDS_FEEDBACK_APP_SLUG?.trim()
    && env.HANDS_FEEDBACK_CLIENT_KEY?.trim()
    && env.HANDS_FEEDBACK_APP_TOKEN?.trim()
    && env.HANDS_FEEDBACK_REPORTER_ID_SECRET?.trim(),
  );
}

function readConfig(env: NodeJS.ProcessEnv): ProductFeedbackServiceConfig {
  if (!DISTRIBUTION_POLICY.upstreamServices) throw new ProductFeedbackConfigurationError();
  const baseUrl = env.HANDS_FEEDBACK_BASE_URL?.trim();
  const appSlug = env.HANDS_FEEDBACK_APP_SLUG?.trim();
  const clientKey = env.HANDS_FEEDBACK_CLIENT_KEY?.trim();
  const appToken = env.HANDS_FEEDBACK_APP_TOKEN?.trim();
  const reporterIdSecret = env.HANDS_FEEDBACK_REPORTER_ID_SECRET?.trim();
  if (!baseUrl || !appSlug || !clientKey || !appToken || !reporterIdSecret) {
    throw new ProductFeedbackConfigurationError();
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    appSlug,
    clientKey,
    appToken,
    reporterIdSecret,
  };
}

export function productFeedbackReporterId(userId: string, secret: string): string {
  return createHmac("sha256", secret).update(`raft-web-feedback:${userId}`).digest("base64url");
}

function bounded(value: string | undefined, maxLength: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function optionalBounded(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ProductFeedbackValidationError();
  return bounded(value, maxLength);
}

function requiredBounded(value: unknown, maxLength: number): string {
  const normalized = optionalBounded(value, maxLength);
  if (!normalized) throw new ProductFeedbackValidationError();
  return normalized;
}

function optionalClientKind(value: unknown): ProductFeedbackClientKind | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "web" || value === "ios" || value === "android") return value;
  throw new ProductFeedbackValidationError();
}

function disallowWebOnlyNativeFields(input: ProductFeedbackMetadata): void {
  if (input.webVersion !== undefined || input.browser !== undefined || input.viewport !== undefined) {
    throw new ProductFeedbackValidationError();
  }
}

export function normalizeProductFeedbackMetadata(input: ProductFeedbackMetadata): ProductFeedbackNormalizedMetadata {
  const trustedClientKind = optionalClientKind(input.trustedClientKind) ?? "web";
  const clientKind = optionalClientKind(input.clientKind) ?? trustedClientKind;
  if (clientKind !== trustedClientKind) throw new ProductFeedbackValidationError();
  const platform = optionalClientKind(input.platform) ?? clientKind;
  if (platform !== clientKind) throw new ProductFeedbackValidationError();

  const locale = optionalBounded(input.locale, 64);
  const osVersion = optionalBounded(input.osVersion, 256);
  if (clientKind === "web") {
    const webVersion = optionalBounded(input.webVersion, 128);
    return {
      clientKind,
      platform,
      clientVersion: optionalBounded(input.clientVersion, 128) ?? webVersion,
      webVersion,
      locale,
      browser: optionalBounded(input.browser, 512),
      osVersion,
      viewport: optionalBounded(input.viewport, 64),
    };
  }

  disallowWebOnlyNativeFields(input);
  return {
    clientKind,
    platform,
    clientVersion: requiredBounded(input.clientVersion, 128),
    locale,
    osVersion,
  };
}

function buildMetadata(input: ProductFeedbackSubmission): Record<string, unknown> {
  const attribution = input.metadata;
  const metadata: Record<string, unknown> = {
    product_type: attribution.clientKind,
    client_kind: attribution.clientKind,
    platform: attribution.platform,
    surface: input.feedbackReportId ? "agent.report_issue" : "settings.feedback",
    feedback_type: input.kind,
    contact_consent: input.contact !== null,
  };

  if (input.feedbackReportId) metadata.feedback_report_id = input.feedbackReportId;
  if (attribution.clientVersion) metadata.client_version = attribution.clientVersion;
  if (attribution.webVersion) metadata.web_version = attribution.webVersion;
  if (attribution.locale) metadata.locale = attribution.locale;
  if (attribution.browser) metadata.browser = attribution.browser;
  if (attribution.osVersion) metadata.os_version = attribution.osVersion;
  if (attribution.viewport) metadata.viewport = attribution.viewport;
  // Forward the server-derived reporter attribution as an opaque nested object.
  // Hands stores the whole metadata JSON and never parses inside this block, so
  // adding dimensions here does not require a Hands-side change.
  if (attribution.reporterAttribution) {
    metadata.reporter_attribution = attribution.reporterAttribution;
  }
  return metadata;
}

function parseReceipt(value: unknown): ProductFeedbackReceipt | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.status !== "string") return null;
  return {
    id: candidate.id,
    status: candidate.status,
    reference: typeof candidate.reference === "string" && candidate.reference.trim()
      ? candidate.reference.trim()
      : null,
    attachments: typeof candidate.attachments === "number" && Number.isFinite(candidate.attachments)
      ? candidate.attachments
      : 0,
  };
}

export async function submitProductFeedback(
  input: ProductFeedbackSubmission,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    onUpstreamServerTiming?: (value: string | null) => void;
  } = {},
): Promise<ProductFeedbackReceipt> {
  const config = readConfig(options.env ?? process.env);
  const body = new FormData();
  body.set("message", input.message);
  body.set("kind", input.kind === "idea" ? "feedback" : "bug");
  body.set("submission_id", input.submissionId);
  body.set("metadata", JSON.stringify(buildMetadata(input)));
  if (input.contact) body.set("contact", input.contact);
  for (const attachment of input.attachments) {
    body.append(
      "attachments",
      new Blob([Uint8Array.from(attachment.buffer)], { type: attachment.contentType }),
      attachment.filename,
    );
  }

  let response: Response;
  try {
    response = await (options.fetchImpl ?? globalThis.fetch)(
      `${config.baseUrl}/public/v2/apps/${encodeURIComponent(config.appSlug)}/feedback`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.appToken}`,
          "X-Hands-Client-Key": config.clientKey,
          "X-Hands-Reporter-Id": productFeedbackReporterId(input.userId, config.reporterIdSecret),
        },
        body,
      },
    );
  } catch {
    throw new ProductFeedbackUpstreamError(null);
  }
  options.onUpstreamServerTiming?.(response.headers.get("server-timing"));

  if (!response.ok) {
    throw new ProductFeedbackUpstreamError(
      response.status,
      response.headers.get("retry-after"),
      await readUpstreamError(response),
    );
  }

  const receipt = parseReceipt(await response.json().catch(() => null));
  if (!receipt) throw new ProductFeedbackUpstreamError(502);
  return receipt;
}
