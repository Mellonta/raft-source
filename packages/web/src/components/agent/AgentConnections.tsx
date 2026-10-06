import { useCallback, useEffect, useState } from "react";
import { useIntl } from "react-intl";
import {
  Button,
  Checkbox,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
} from "raft-ui";
import type {
  AgentConnectionConnectorView,
  AgentConnectionProvider,
  AgentConnectionStartView,
  AgentConnectionStatusView,
} from "@botiverse/raft-shared";
import api from "../../api/client";
import ConfirmDialog from "../ConfirmDialog";
import SectionEyebrow from "../ui/SectionEyebrow";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";

/**
 * Account connections of a provider-backed (hosted runtime) agent. The
 * provider runs the OAuth flow and keeps the token; this only starts it,
 * shows status and switches or disconnects. Connections are tenant-level
 * connectors shared by the server's agents: the agent uses one of them, only a
 * connector's creator or a server owner/admin may assign or disconnect it
 * (`canManage`, decided by the server). Hidden when the provider does not support
 * connections or the caller may not manage them; shown with a warning when the
 * provider no longer knows the agent (stale provisioning).
 */
/** The provider's own reason for refusing (e.g. the agent needs exactly one GitHub plugin mount), if any. */
export function providerRefusalReason(err: unknown): string | null {
  const data = (err as { response?: { data?: { providerMessage?: unknown } } }).response?.data;
  return typeof data?.providerMessage === "string" && data.providerMessage.trim() ? data.providerMessage : null;
}

export const AGENT_MISSING_AT_PROVIDER_CODE = "agent_connection_agent_missing_at_provider";
export const CONNECTOR_DISCONNECT_PARTIAL_CODE = "agent_connection_connector_disconnect_partial";

function errorCode(err: unknown): string | null {
  const code = (err as { response?: { data?: { code?: unknown } } }).response?.data?.code;
  return typeof code === "string" ? code : null;
}

export function agentConnectionPath(agentId: string, provider: AgentConnectionProvider): string {
  return `/agents/${encodeURIComponent(agentId)}/connections/${provider}`;
}

/** A tenant connector, addressed through an agent the caller manages. */
export function agentConnectorPath(agentId: string, provider: AgentConnectionProvider, connectorId: string): string {
  return `${agentConnectionPath(agentId, provider)}/connectors/${encodeURIComponent(connectorId)}`;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "error" }
  | { kind: "agent_missing" }
  | { kind: "ready"; status: Extract<AgentConnectionStatusView, { supported: true }> };

export function AgentConnections({ agentId }: { agentId: string }) {
  const { formatMessage } = useIntl();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<AgentConnectionStatusView>(agentConnectionPath(agentId, "github"));
      setState(data.supported ? { kind: "ready", status: data } : { kind: "hidden" });
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } }).response?.status;
      // The provider no longer knows the agent: say so instead of hiding the section.
      if (errorCode(err) === AGENT_MISSING_AT_PROVIDER_CODE) {
        setState({ kind: "agent_missing" });
        return;
      }
      // 403/404/409 (not allowed, not provider-backed, not provisioned yet, disabled) hide the section.
      setState(status && status < 500 && status !== 429 ? { kind: "hidden" } : { kind: "error" });
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === "hidden" || state.kind === "loading") return null;
  return (
    <div className="border-t border-line-muted theme-brutal:border-black/10 px-5 py-4" data-testid="agent-connections">
      <SectionEyebrow as="div" className="mb-2">
        {formatMessage({ id: "agent.detail.connections.title" })}
      </SectionEyebrow>
      {state.kind === "error" ? (
        <p className="text-xs font-bold text-warning-strong theme-brutal:text-brutal-orange">
          {formatMessage({ id: "agent.detail.connections.loadFailed" })}
        </p>
      ) : state.kind === "agent_missing" ? (
        <p className="text-xs font-bold text-warning-strong theme-brutal:text-brutal-orange" data-testid="agent-connections-agent-missing">
          {formatMessage({ id: "agent.detail.connections.agentMissingAtProvider" })}
        </p>
      ) : (
        <GithubConnectionRow agentId={agentId} status={state.status} onChanged={load} onAgentMissing={() => setState({ kind: "agent_missing" })} />
      )}
    </div>
  );
}

type ReadyStatus = Extract<AgentConnectionStatusView, { supported: true }>;

function creatorLabel(connector: AgentConnectionConnectorView): string | null {
  return connector.creator?.name ?? connector.creator?.displayName ?? null;
}

function GithubConnectionRow({
  agentId,
  status,
  onChanged,
  onAgentMissing,
}: {
  agentId: string;
  status: ReadyStatus;
  onChanged: () => Promise<void>;
  onAgentMissing: () => void;
}) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const [includePrivate, setIncludePrivate] = useState(false);
  const [starting, setStarting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [pending, setPending] = useState<AgentConnectionStartView | null>(null);
  const [error, setError] = useState<{ kind: "start" | "switch" | "disconnect"; reason: string | null } | null>(null);
  const [confirm, setConfirm] = useState<"detach" | "disconnect" | null>(null);
  const [partialDisconnect, setPartialDisconnect] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const connectors = status.connectors ?? [];
  const current = status.connected
    ? connectors.find((connector) => connector.id === status.connectorId) ?? connectors.find((connector) => connector.current) ?? null
    : null;
  const currentCreator = current ? creatorLabel(current) : null;

  const failed = (err: unknown, kind: "start" | "switch" | "disconnect") => {
    if (errorCode(err) === AGENT_MISSING_AT_PROVIDER_CODE) {
      onAgentMissing();
      return;
    }
    setError({ kind, reason: providerRefusalReason(err) });
  };

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const { data } = await api.post<AgentConnectionStartView>(
        agentConnectionPath(agentId, "github"),
        includePrivate ? { access: "private" } : {},
      );
      setPending(data);
    } catch (err: unknown) {
      failed(err, "start");
    } finally {
      setStarting(false);
    }
  };

  const assign = async (connectorId: string) => {
    const connector = connectors.find((item) => item.id === connectorId);
    // Raft re-checks on the server; the UI only never offers what would be refused.
    if (!connector || !connector.canManage || connectorId === status.connectorId) return;
    setSwitching(true);
    setError(null);
    try {
      await api.put(agentConnectionPath(agentId, "github"), { connectorId });
      await onChanged();
    } catch (err: unknown) {
      failed(err, "switch");
    } finally {
      setSwitching(false);
    }
  };

  const detach = async () => {
    await api.delete(agentConnectionPath(agentId, "github"));
    await onChanged();
  };

  // The provider may disconnect a connector only partially (some agents not
  // detached, 502 `…_disconnect_partial`): not a success; the same call again completes it.
  const disconnectConnector = async (connectorId: string) => {
    setError(null);
    try {
      await api.delete(agentConnectorPath(agentId, "github", connectorId));
    } catch (err: unknown) {
      if (errorCode(err) !== CONNECTOR_DISCONNECT_PARTIAL_CODE) throw err;
      setPartialDisconnect(connectorId);
      return;
    }
    setPartialDisconnect(null);
    await onChanged();
  };

  const retryDisconnect = async (connectorId: string) => {
    setRetrying(true);
    try {
      await disconnectConnector(connectorId);
    } catch (err: unknown) {
      setPartialDisconnect(null);
      failed(err, "disconnect");
    } finally {
      setRetrying(false);
    }
  };

  const requestedScope = includePrivate ? "repo" : "public_repo";
  const connectorLabel = (connector: AgentConnectionConnectorView) => {
    const creator = creatorLabel(connector);
    const account = connector.account ?? "GitHub";
    return creator
      ? formatMessage({ id: "agent.detail.connections.connectorOption" }, { account, creator })
      : account;
  };
  const selectItems = connectors.map((connector) => ({ value: connector.id, label: connectorLabel(connector) }));

  return (
    <div className="space-y-2 border theme-brutal:border-2 border-line-muted theme-brutal:border-black bg-layer-panel theme-brutal:bg-white p-3" data-testid="agent-connection-github" data-connected={status.connected ? "true" : "false"}>
      <div className="min-w-0">
        <p className="text-sm font-bold text-foreground-strong theme-brutal:text-black">{formatMessage({ id: "agent.detail.connections.github" })}</p>
        {status.connected ? (
          <p className="flex flex-wrap gap-x-2 text-xs text-foreground-muted theme-brutal:text-black/60" data-testid="agent-connection-github-status">
            {currentCreator ? (
              <span>{formatMessage({ id: "agent.detail.connections.usesConnector" }, { creator: currentCreator, account: status.account ?? current?.account ?? "?" })}</span>
            ) : (
              <>
                <span>{formatMessage({ id: "agent.detail.connections.connectedAs" }, { account: status.account ?? "?" })}</span>
                {status.connectedBy ? (
                  <span>{formatMessage({ id: "agent.detail.connections.connectedBy" }, { name: status.connectedBy.name ?? status.connectedBy.id })}</span>
                ) : null}
              </>
            )}
            {status.connectedAt ? <span className="font-mono">{formatShortDateTime(status.connectedAt)}</span> : null}
          </p>
        ) : (
          <p className="text-xs text-foreground-muted theme-brutal:text-black/60">
            {formatMessage({ id: "agent.detail.connections.notConnected" })}
          </p>
        )}
        {status.connected && status.scopes.length > 0 && (
          <p className="text-xs font-mono text-foreground-muted theme-brutal:text-black/50">
            {formatMessage({ id: "agent.detail.connections.scopes" }, { scopes: status.scopes.join(", ") })}
          </p>
        )}
      </div>
      {connectors.length > 0 && (
        <div className="space-y-1" data-testid="agent-connection-github-connectors">
          <p className="text-xs font-bold text-foreground-muted theme-brutal:text-black/70">
            {formatMessage({ id: "agent.detail.connections.useConnection" })}
          </p>
          <Select
            value={status.connectorId}
            disabled={switching}
            onValueChange={(value) => {
              if (typeof value === "string") void assign(value);
            }}
            items={selectItems}
          >
            <SelectTrigger className="w-full" aria-label={formatMessage({ id: "agent.detail.connections.useConnection" })}>
              <SelectValue placeholder={formatMessage({ id: "agent.detail.connections.choosePlaceholder" })} />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectList>
                {connectors.map((connector) => {
                  const reason = connector.canManage ? undefined : formatMessage({ id: "agent.detail.connections.connectorForbidden" });
                  return (
                    <SelectItem key={connector.id} value={connector.id} disabled={!connector.canManage} title={reason} data-testid={`agent-connection-connector-${connector.id}`}>
                      <SelectItemText>
                        <span className="flex flex-col">
                          <span>{connectorLabel(connector)}</span>
                          {reason ? <span className="text-xs font-normal text-foreground-muted">{reason}</span> : null}
                        </span>
                      </SelectItemText>
                      <SelectItemIndicator />
                    </SelectItem>
                  );
                })}
              </SelectList>
            </SelectContent>
          </Select>
        </div>
      )}
      {!pending && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={starting}
            title={formatMessage({ id: "agent.detail.connections.connectHint" }, { scopes: requestedScope })}
            onClick={() => void start()}
          >
            {formatMessage({ id: connectors.length > 0 || status.connected ? "agent.detail.connections.connectNew" : "agent.detail.connections.connect" })}
          </Button>
          {status.connected && (
            <Button variant="outline" size="sm" type="button" onClick={() => setConfirm("detach")}>
              {formatMessage({ id: "agent.detail.connections.detach" })}
            </Button>
          )}
          {status.connected && current?.canManage && (
            <Button variant="outline" size="sm" type="button" onClick={() => setConfirm("disconnect")}>
              {formatMessage({ id: "agent.detail.connections.disconnectConnector" })}
            </Button>
          )}
        </div>
      )}
      {!pending && (
        <label className="flex items-center gap-2 text-xs text-foreground-muted theme-brutal:text-black/70">
          <Checkbox
            checked={includePrivate}
            onCheckedChange={(checked) => setIncludePrivate(checked === true)}
            aria-label={formatMessage({ id: "agent.detail.connections.includePrivate" })}
          />
          <span>{formatMessage({ id: "agent.detail.connections.includePrivate" })}</span>
        </label>
      )}
      {pending && (
        <div className="space-y-2" data-testid="agent-connection-github-pending">
          <p className="text-xs text-foreground-muted theme-brutal:text-black/70">
            {formatMessage({ id: "agent.detail.connections.reviewScopes" }, { scopes: pending.scopes.join(", ") || requestedScope })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" type="button" onClick={() => window.location.assign(pending.url)}>
              {formatMessage({ id: "agent.detail.connections.continue" })}
            </Button>
            <Button variant="outline" size="sm" type="button" onClick={() => setPending(null)}>
              {formatMessage({ id: "agent.detail.connections.cancel" })}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p className="text-xs font-bold text-warning-strong theme-brutal:text-brutal-orange" data-testid="agent-connection-github-error">
          {error.reason
            ? formatMessage({ id: "agent.detail.connections.providerRefused" }, { reason: error.reason })
            : formatMessage({
              id: error.kind === "switch"
                ? "agent.detail.connections.switchFailed"
                : error.kind === "disconnect"
                  ? "agent.detail.connections.disconnectFailed"
                  : "agent.detail.connections.startFailed",
            })}
        </p>
      )}
      {partialDisconnect && (
        <div className="flex flex-wrap items-center gap-2" data-testid="agent-connection-disconnect-partial">
          <p className="text-xs font-bold text-warning-strong theme-brutal:text-brutal-orange">
            {formatMessage({ id: "agent.detail.connections.disconnectPartial" })}
          </p>
          <Button variant="outline" size="sm" type="button" disabled={retrying} onClick={() => void retryDisconnect(partialDisconnect)}>
            {formatMessage({ id: "agent.detail.connections.retry" })}
          </Button>
        </div>
      )}
      {confirm === "detach" && (
        <ConfirmDialog
          title={formatMessage({ id: "agent.detail.connections.detachTitle" })}
          message={formatMessage({ id: "agent.detail.connections.detachMessage" }, { account: status.account ?? "GitHub" })}
          confirmLabel={formatMessage({ id: "agent.detail.connections.detach" })}
          onConfirm={detach}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === "disconnect" && current && (
        <ConfirmDialog
          title={formatMessage({ id: "agent.detail.connections.disconnectConnectorTitle" })}
          message={formatMessage({ id: "agent.detail.connections.disconnectConnectorMessage" }, { account: current.account ?? "GitHub" })}
          confirmLabel={formatMessage({ id: "agent.detail.connections.disconnectConnector" })}
          confirmTestId="agent-connection-disconnect-connector-confirm"
          onConfirm={() => disconnectConnector(current.id)}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
