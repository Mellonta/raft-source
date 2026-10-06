/**
 * Usage of a hosted (provider-backed) agent as reported by its provider via
 * `GET /agents/:id/hosted-runtime/usage`. Rows with the same `resource` share
 * a unit and can be summed; resources this client does not know are ignored.
 */
export interface HostedRuntimeUsageRow {
  at: string;
  resource: string;
  dimensions: Record<string, string>;
  unit: string;
  quantity: number;
}

export interface HostedRuntimeUsageResponse {
  raftAgentId: string;
  bucket: string;
  from: string;
  to: string;
  asOf: string;
  partial: boolean;
  rows: HostedRuntimeUsageRow[];
}

export interface HostedRuntimeUsageSummary {
  /** Summed across models and buckets; `cacheWrite` is 5m + 1h writes, `total` includes unknown kinds. */
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number };
  /** `total` includes outcomes other than succeeded/failed. */
  toolCalls: { total: number; succeeded: number; failed: number };
  /** Models by total tokens, largest first. */
  topModels: Array<{ model: string; tokens: number }>;
  hasUsage: boolean;
}

type TokenKind = Exclude<keyof HostedRuntimeUsageSummary["tokens"], "total">;

const TOKEN_KIND: Record<string, TokenKind> = {
  input: "input",
  output: "output",
  reasoning: "reasoning",
  cache_read: "cacheRead",
  cache_write_5m: "cacheWrite",
  cache_write_1h: "cacheWrite",
};

export function hostedRuntimeUsagePath(agentId: string): string {
  return `/agents/${encodeURIComponent(agentId)}/hosted-runtime/usage`;
}

export function summarizeHostedRuntimeUsage(
  rows: readonly HostedRuntimeUsageRow[],
  options: { topModelCount?: number } = {},
): HostedRuntimeUsageSummary {
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const toolCalls = { total: 0, succeeded: 0, failed: 0 };
  const byModel = new Map<string, number>();
  for (const row of rows) {
    const quantity = row.quantity;
    if (!Number.isFinite(quantity)) continue;
    if (row.resource === "model.tokens") {
      tokens.total += quantity;
      const kind = TOKEN_KIND[row.dimensions?.kind ?? ""];
      if (kind) tokens[kind] += quantity;
      const model = row.dimensions?.model;
      if (model) byModel.set(model, (byModel.get(model) ?? 0) + quantity);
    } else if (row.resource === "tool.call") {
      toolCalls.total += quantity;
      const outcome = row.dimensions?.outcome;
      if (outcome === "succeeded") toolCalls.succeeded += quantity;
      else if (outcome === "failed") toolCalls.failed += quantity;
    }
  }
  const topModels = [...byModel]
    .map(([model, modelTokens]) => ({ model, tokens: modelTokens }))
    .filter((entry) => entry.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model))
    .slice(0, options.topModelCount ?? 3);
  return { tokens, toolCalls, topModels, hasUsage: tokens.total > 0 || toolCalls.total > 0 };
}
