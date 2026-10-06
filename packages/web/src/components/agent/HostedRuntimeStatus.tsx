import { useState } from "react";
import { useIntl } from "react-intl";
import { Button } from "raft-ui";
import type { AgentHostedRuntimeSummary } from "@botiverse/raft-shared";

export type HostedRuntimeStateLabelId =
  | "agent.detail.hostedRuntime.state.provisioning"
  | "agent.detail.hostedRuntime.state.active"
  | "agent.detail.hostedRuntime.state.syncing"
  | "agent.detail.hostedRuntime.state.failed"
  | "agent.detail.hostedRuntime.state.deleting"
  | "agent.detail.hostedRuntime.state.deleted";

/** What the profile shows for a provisioning record; pure so it can be pinned by tests. */
export function describeHostedRuntime(summary: AgentHostedRuntimeSummary): {
  labelId: HostedRuntimeStateLabelId;
  inProgress: boolean;
  canRetry: boolean;
} {
  switch (summary.state) {
    case "provisioning":
      return { labelId: "agent.detail.hostedRuntime.state.provisioning", inProgress: true, canRetry: summary.lastError !== null };
    case "active":
      return summary.syncPending
        ? { labelId: "agent.detail.hostedRuntime.state.syncing", inProgress: true, canRetry: summary.lastError !== null }
        : { labelId: "agent.detail.hostedRuntime.state.active", inProgress: false, canRetry: summary.lastError !== null };
    case "failed":
      return { labelId: "agent.detail.hostedRuntime.state.failed", inProgress: false, canRetry: true };
    case "deleting":
      return { labelId: "agent.detail.hostedRuntime.state.deleting", inProgress: true, canRetry: false };
    case "deleted":
      return { labelId: "agent.detail.hostedRuntime.state.deleted", inProgress: false, canRetry: false };
  }
}

export function HostedRuntimeStatus({
  summary,
  onRetry,
}: {
  summary: AgentHostedRuntimeSummary;
  onRetry: () => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(false);
  const view = describeHostedRuntime(summary);
  const retry = async () => {
    setRetrying(true);
    setRetryError(false);
    try {
      await onRetry();
    } catch {
      setRetryError(true);
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div className="space-y-2" data-testid="agent-hosted-runtime-status" data-state={summary.state}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex border theme-brutal:border-2 border-line-muted theme-brutal:border-black bg-layer-panel theme-brutal:bg-white px-2 py-0.5 text-xs font-bold uppercase text-foreground-strong theme-brutal:text-black">
          {formatMessage({ id: view.labelId })}
        </span>
        <span className="text-xs text-foreground-muted theme-brutal:text-black/60">
          {formatMessage({ id: "agent.detail.hostedRuntime.provider" }, { provider: "antiproton" })}
        </span>
      </div>
      {summary.state === "active" && summary.push && !summary.push.registered && (
        <p className="text-xs font-bold text-warning-strong theme-brutal:text-brutal-orange">
          {formatMessage({ id: "agent.detail.hostedRuntime.pushNotRegistered" })}
          {summary.push.error ? <span className="ml-1">{summary.push.error}</span> : null}
        </p>
      )}
      {summary.lastError && (
        <p className="break-words text-xs font-bold text-warning-strong theme-brutal:text-brutal-orange" data-testid="agent-hosted-runtime-error">
          {formatMessage(
            { id: "agent.detail.hostedRuntime.lastError" },
            { code: summary.lastError.code, message: summary.lastError.message || summary.lastError.code },
          )}
        </p>
      )}
      {view.canRetry && (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" type="button" disabled={retrying} onClick={() => void retry()}>
            {formatMessage({ id: "agent.detail.hostedRuntime.retry" })}
          </Button>
          {retryError && (
            <span className="text-xs font-bold text-warning-strong theme-brutal:text-brutal-orange">
              {formatMessage({ id: "agent.detail.hostedRuntime.retryFailed" })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
