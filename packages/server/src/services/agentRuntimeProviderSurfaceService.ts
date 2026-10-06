/**
 * Read-only surfaces of a hosted (provider-backed) agent that Raft proxies to
 * the provider: the workspace file browser and usage. A hosted agent has no
 * machine, so these replace the daemon relay for it.
 *
 * The provider is addressed by its own agent id, so only an `active` row with
 * a `providerAgentId` can be served. Outcomes are classified, never thrown:
 * provider 400 → bad_request, 404 → not_found, any other answer, a body of the
 * wrong shape or a network failure → upstream_unavailable.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { FileNode } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentRuntimeProvisions } from "../db/schema";
import {
  providerAgentUsagePath,
  providerAgentWorkspaceFileReadPath,
  providerAgentWorkspaceFilesPath,
  providerRequest,
  resolveProviderConfig,
  type ProviderErrorBody,
} from "./agentRuntimeProviderService";

export const HOSTED_USAGE_BUCKETS = ["1h", "1d"] as const;
export type HostedUsageBucket = (typeof HOSTED_USAGE_BUCKETS)[number];
/** The provider rejects longer windows; Raft validates first so the user gets a precise 400. */
export const HOSTED_USAGE_MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

export type ProviderSurfaceResult<T> =
  | { kind: "ok"; body: T }
  /** Not provisioned, not active yet, or the provider is not configured on this deployment. */
  | { kind: "unavailable"; reason: string }
  | { kind: "bad_request"; error: ProviderErrorBody | null }
  | { kind: "not_found"; error: ProviderErrorBody | null }
  | { kind: "upstream_unavailable"; reason: string; httpStatus: number | null };

// Minimal shape checks; extra fields the provider adds are tolerated (and dropped).
const fileNodeSchema = z.object({
  name: z.string(),
  path: z.string(),
  isDirectory: z.boolean(),
  size: z.number().catch(0),
  modifiedAt: z.string().catch(""),
  isHidden: z.boolean().optional(),
});

const fileListSchema = z.object({
  files: z.array(fileNodeSchema),
  truncated: z.boolean().optional(),
  omitted: z.number().int().nonnegative().optional(),
});

const fileReadSchema = z.object({
  content: z.string().nullable(),
  binary: z.boolean(),
  size: z.number(),
  mimeType: z.string().nullish(),
  encoding: z.enum(["utf-8", "base64"]).nullish(),
  path: z.string().optional(),
  modifiedAt: z.string().optional(),
});

const usageRowSchema = z.object({
  at: z.string(),
  resource: z.string(),
  dimensions: z.record(z.string(), z.string()),
  unit: z.string(),
  quantity: z.number(),
});

const usageSchema = z.object({
  raftAgentId: z.string(),
  bucket: z.string(),
  from: z.string(),
  to: z.string(),
  asOf: z.string(),
  partial: z.boolean(),
  rows: z.array(usageRowSchema),
});

export type HostedWorkspaceFileList = { files: FileNode[]; truncated?: boolean; omitted?: number };
export type HostedWorkspaceFile = z.infer<typeof fileReadSchema>;
export type HostedAgentUsage = z.infer<typeof usageSchema>;

async function providerGet<T>(
  agentId: string,
  path: (providerAgentId: string, raftServerId: string) => string,
  schema: z.ZodType<T>,
): Promise<ProviderSurfaceResult<T>> {
  const [row] = await getDb().select().from(agentRuntimeProvisions)
    .where(eq(agentRuntimeProvisions.agentId, agentId)).limit(1);
  if (!row) return { kind: "unavailable", reason: "not_provisioned" };
  if (row.state !== "active" || !row.providerAgentId) return { kind: "unavailable", reason: `state_${row.state}` };
  const config = resolveProviderConfig(row.provider);
  if (!config) return { kind: "unavailable", reason: "provider_not_configured" };
  const result = await providerRequest(config, "GET", path(row.providerAgentId, row.serverId));
  if (result.kind === "network") return { kind: "upstream_unavailable", reason: result.code, httpStatus: null };
  if (result.status === 400) return { kind: "bad_request", error: result.error };
  if (result.status === 404) return { kind: "not_found", error: result.error };
  if (result.status < 200 || result.status >= 300) {
    return { kind: "upstream_unavailable", reason: result.error?.code ?? `http_${result.status}`, httpStatus: result.status };
  }
  const parsed = schema.safeParse(result.body);
  if (!parsed.success) return { kind: "upstream_unavailable", reason: "invalid_response", httpStatus: result.status };
  return { kind: "ok", body: parsed.data };
}

export function listHostedAgentWorkspaceFiles(
  agentId: string,
  params: { dirPath?: string; includeHidden?: boolean },
): Promise<ProviderSurfaceResult<HostedWorkspaceFileList>> {
  return providerGet(agentId, (providerAgentId, serverId) => providerAgentWorkspaceFilesPath(providerAgentId, serverId, params), fileListSchema);
}

export function readHostedAgentWorkspaceFile(agentId: string, filePath: string): Promise<ProviderSurfaceResult<HostedWorkspaceFile>> {
  return providerGet(agentId, (providerAgentId, serverId) => providerAgentWorkspaceFileReadPath(providerAgentId, serverId, filePath), fileReadSchema);
}

export function fetchHostedAgentUsage(
  agentId: string,
  params: { from: string; to: string; bucket: HostedUsageBucket },
): Promise<ProviderSurfaceResult<HostedAgentUsage>> {
  return providerGet(agentId, (providerAgentId, serverId) => providerAgentUsagePath(providerAgentId, serverId, params), usageSchema);
}

/**
 * Validates `from`/`to`/`bucket` of a usage request. Defaults: the last 7 days
 * ending now, daily buckets. Returns normalized ISO strings or a reason.
 */
export function parseHostedUsageQuery(
  query: { from?: unknown; to?: unknown; bucket?: unknown },
  now: Date,
): { ok: true; from: string; to: string; bucket: HostedUsageBucket } | { ok: false; error: string } {
  const parseTime = (value: unknown, fallback: Date): Date | null => {
    if (value === undefined || value === "") return fallback;
    if (typeof value !== "string") return null;
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : new Date(time);
  };
  const to = parseTime(query.to, now);
  if (!to) return { ok: false, error: "`to` must be an ISO 8601 timestamp" };
  const from = parseTime(query.from, new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000));
  if (!from) return { ok: false, error: "`from` must be an ISO 8601 timestamp" };
  if (from.getTime() >= to.getTime()) return { ok: false, error: "`from` must be before `to`" };
  if (to.getTime() - from.getTime() > HOSTED_USAGE_MAX_WINDOW_MS) return { ok: false, error: "The window may span at most 31 days" };
  const bucket = query.bucket === undefined || query.bucket === "" ? "1d" : query.bucket;
  if (!HOSTED_USAGE_BUCKETS.includes(bucket as HostedUsageBucket)) return { ok: false, error: "`bucket` must be 1h or 1d" };
  return { ok: true, from: from.toISOString(), to: to.toISOString(), bucket: bucket as HostedUsageBucket };
}
