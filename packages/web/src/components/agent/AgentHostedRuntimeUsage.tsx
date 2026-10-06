import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Spinner } from "raft-ui";
import api from "../../api/client";
import SectionEyebrow from "../ui/SectionEyebrow";
import { formatRelativeTime } from "../../utils/relativeTime";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { hostedRuntimeUsagePath, summarizeHostedRuntimeUsage } from "./hostedRuntimeUsage";
import type { HostedRuntimeUsageResponse } from "./hostedRuntimeUsage";

const USAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type LoadState =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "error" }
  | { kind: "ready"; usage: HostedRuntimeUsageResponse };

function UsageRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-4">
      <dt className="truncate text-xs text-foreground-muted theme-brutal:text-black/50">{label}</dt>
      <dd className="m-0 min-w-0 text-sm tabular-nums text-foreground-strong theme-brutal:text-black">{children}</dd>
    </div>
  );
}

/**
 * Last-7-days usage of a hosted (provider-backed) agent: tokens by kind summed
 * across models, tool calls and the top models. Hidden when the agent is not
 * hosted or the caller may not see it (4xx); a warning on provider failures.
 */
export function AgentHostedRuntimeUsage({ agentId }: { agentId: string }) {
  const intl = useIntl();
  const { formatMessage, formatNumber } = intl;
  const { formatShortDateTime } = useTimeFormatter();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    // Keyed by agent at the call site, so the state starts as loading per agent.
    let cancelled = false;
    const to = new Date();
    const from = new Date(to.getTime() - USAGE_WINDOW_MS);
    api.get<HostedRuntimeUsageResponse>(hostedRuntimeUsagePath(agentId), {
      params: { from: from.toISOString(), to: to.toISOString(), bucket: "1d" },
    }).then(({ data }) => {
      if (!cancelled) setState({ kind: "ready", usage: data });
    }).catch((err: unknown) => {
      if (cancelled) return;
      const status = (err as { response?: { status?: number } }).response?.status;
      setState(status && status < 500 && status !== 429 && status !== 400 ? { kind: "hidden" } : { kind: "error" });
    });
    return () => { cancelled = true; };
  }, [agentId]);

  const summary = useMemo(
    () => state.kind === "ready" ? summarizeHostedRuntimeUsage(state.usage.rows) : null,
    [state],
  );

  if (state.kind === "hidden") return null;
  return (
    <div className="border-t border-line-muted theme-brutal:border-black/10 px-5 py-4" data-testid="agent-hosted-runtime-usage">
      <SectionEyebrow as="div" className="mb-2">
        {formatMessage({ id: "agent.detail.usage.title" })}
      </SectionEyebrow>
      {state.kind === "loading" ? (
        <Spinner size="xs" aria-label={formatMessage({ id: "agent.workspace.loading" })} />
      ) : state.kind === "error" ? (
        <p className="text-xs font-bold text-warning-strong theme-brutal:text-brutal-orange">
          {formatMessage({ id: "agent.detail.usage.loadFailed" })}
        </p>
      ) : summary && !summary.hasUsage ? (
        <p className="text-xs text-foreground-muted theme-brutal:text-black/60">
          {formatMessage({ id: "agent.detail.usage.empty" })}
        </p>
      ) : summary ? (
        <dl className="m-0 space-y-2">
          <UsageRow label={formatMessage({ id: "agent.detail.usage.tokens" })}>
            <div className="grid grid-cols-[auto_auto] justify-start gap-x-3 gap-y-0.5 text-xs">
              {([
                ["agent.detail.usage.tokens.input", summary.tokens.input],
                ["agent.detail.usage.tokens.output", summary.tokens.output],
                ["agent.detail.usage.tokens.reasoning", summary.tokens.reasoning],
                ["agent.detail.usage.tokens.cacheRead", summary.tokens.cacheRead],
                ["agent.detail.usage.tokens.cacheWrite", summary.tokens.cacheWrite],
                ["agent.detail.usage.tokens.total", summary.tokens.total],
              ] as const).map(([labelId, value]) => (
                <div key={labelId} className="contents">
                  <span className="text-foreground-muted theme-brutal:text-black/60">{formatMessage({ id: labelId })}</span>
                  <span className="font-mono">{formatNumber(value)}</span>
                </div>
              ))}
            </div>
          </UsageRow>
          <UsageRow label={formatMessage({ id: "agent.detail.usage.toolCalls" })}>
            {formatMessage(
              { id: "agent.detail.usage.toolCallsValue" },
              {
                total: formatNumber(summary.toolCalls.total),
                succeeded: formatNumber(summary.toolCalls.succeeded),
                failed: formatNumber(summary.toolCalls.failed),
              },
            )}
          </UsageRow>
          {summary.topModels.length > 0 && (
            <UsageRow label={formatMessage({ id: "agent.detail.usage.topModels" })}>
              <ul className="m-0 list-none space-y-0.5 p-0 text-xs">
                {summary.topModels.map((entry) => (
                  <li key={entry.model} className="flex min-w-0 gap-2">
                    <span className="truncate font-mono">{entry.model}</span>
                    <span className="shrink-0 font-mono text-foreground-muted theme-brutal:text-black/60">{formatNumber(entry.tokens)}</span>
                  </li>
                ))}
              </ul>
            </UsageRow>
          )}
        </dl>
      ) : null}
      {state.kind === "ready" && state.usage.partial && (
        <p className="mt-2 text-xs text-foreground-muted theme-brutal:text-black/60">
          {formatMessage(
            { id: "agent.detail.usage.partial" },
            { time: formatRelativeTime(state.usage.asOf, intl.locale) ?? formatShortDateTime(state.usage.asOf) },
          )}
        </p>
      )}
    </div>
  );
}
