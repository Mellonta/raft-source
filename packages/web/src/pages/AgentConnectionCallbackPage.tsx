import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Link, useLocation } from "react-router-dom";
import { AGENT_CONNECTION_PENDING_ID_RE, isAgentConnectionProvider } from "@botiverse/raft-shared";
import type { AgentConnectionProvider, AgentConnectionStatusView } from "@botiverse/raft-shared";
import api from "../api/client";
import Banner from "../components/ui/Banner";
import SectionEyebrow from "../components/ui/SectionEyebrow";
import { agentConnectionPath, providerRefusalReason } from "../components/agent/AgentConnections";
import { useAuthStore } from "../store/authStore";
import { useServerStore } from "../store/serverStore";

type Target = { provider: AgentConnectionProvider; serverId: string; agentId: string };

export type AgentConnectionCallbackView =
  | { kind: "invalid" }
  /** Someone else started this flow: never confirm it, never show it as a success. */
  | ({ kind: "foreign" } & Target)
  | ({ kind: "pending"; pending: string } & Target)
  | ({ kind: "denied" } & Target)
  | ({ kind: "failed" } & Target);

/**
 * Reads the provider's return (`connection`, `status`, `pending`, `by`,
 * forwarded by the API bounce with `serverId`/`agentId`). `by` must be the
 * signed-in user: the provider binds the flow to the Raft user who started it,
 * and only that user may confirm the pending connection.
 */
export function describeAgentConnectionCallback(search: string, currentUserId: string | null): AgentConnectionCallbackView {
  const params = new URLSearchParams(search);
  const provider = params.get("connection");
  const serverId = params.get("serverId");
  const agentId = params.get("agentId");
  if (!isAgentConnectionProvider(provider) || !serverId || !agentId) return { kind: "invalid" };
  const target = { provider, serverId, agentId };
  const by = params.get("by");
  if (!currentUserId || !by || by !== currentUserId) return { kind: "foreign", ...target };
  const status = params.get("status");
  if (status === "pending") {
    const pending = params.get("pending");
    return pending && AGENT_CONNECTION_PENDING_ID_RE.test(pending) ? { kind: "pending", pending, ...target } : { kind: "failed", ...target };
  }
  return { kind: status === "denied" ? "denied" : "failed", ...target };
}

type ConfirmState =
  | { kind: "confirming" }
  | { kind: "connected"; account: string | null }
  | { kind: "expired"; reason: string | null }
  | { kind: "error"; reason: string | null };

export default function AgentConnectionCallbackPage() {
  const { formatMessage } = useIntl();
  const location = useLocation();
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const servers = useServerStore((s) => s.servers);
  const view = describeAgentConnectionCallback(location.search, currentUserId);
  const server = view.kind === "invalid" ? null : servers.find((candidate) => candidate.id === view.serverId) ?? null;
  const [confirm, setConfirm] = useState<ConfirmState>({ kind: "confirming" });
  const [status, setStatus] = useState<AgentConnectionStatusView | null>(null);
  const confirmedKey = useRef<string | null>(null);

  const pendingKey = view.kind === "pending" ? `${view.serverId}/${view.agentId}/${view.pending}` : null;
  useEffect(() => {
    // The pending id is single-use: confirm exactly once per id.
    if (view.kind !== "pending" || confirmedKey.current === pendingKey) return;
    confirmedKey.current = pendingKey;
    api.post<AgentConnectionStatusView>(
      `${agentConnectionPath(view.agentId, view.provider)}/confirm`,
      { pending: view.pending },
      { headers: { "X-Server-Id": view.serverId } },
    )
      .then(({ data }) => setConfirm({ kind: "connected", account: data.supported ? data.account : null }))
      .catch((err: unknown) => {
        const httpStatus = (err as { response?: { status?: number } }).response?.status;
        const reason = providerRefusalReason(err);
        setConfirm(httpStatus === 404 ? { kind: "expired", reason } : { kind: "error", reason });
      });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed by pendingKey, which covers every field used
  }, [pendingKey]);

  // A flow someone else started: re-read status so an unexpected connection can be flagged.
  const foreignKey = view.kind === "foreign" ? `${view.serverId}/${view.agentId}/${view.provider}` : null;
  useEffect(() => {
    if (view.kind !== "foreign") return;
    let canceled = false;
    api.get<AgentConnectionStatusView>(agentConnectionPath(view.agentId, view.provider), { headers: { "X-Server-Id": view.serverId } })
      .then(({ data }) => { if (!canceled) setStatus(data); })
      .catch(() => undefined);
    return () => { canceled = true; };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed by foreignKey, which covers every field used
  }, [foreignKey]);

  const agentId = view.kind === "invalid" ? null : view.agentId;
  const agentHref = server && agentId ? `/s/${encodeURIComponent(server.slug)}/agent/${encodeURIComponent(agentId)}` : null;
  const foreignConnected = view.kind === "foreign" && status?.supported === true && status.connected;

  let intent: "success" | "warning" | "info" | "destructive" = "destructive";
  let message: string;
  let reason: string | null = null;
  switch (view.kind) {
    case "invalid":
      message = formatMessage({ id: "pages.agentConnectionCallback.invalid" });
      break;
    case "foreign":
      message = formatMessage({ id: "pages.agentConnectionCallback.foreign" });
      break;
    case "denied":
      intent = "warning";
      message = formatMessage({ id: "pages.agentConnectionCallback.denied" });
      break;
    case "failed":
      message = formatMessage({ id: "pages.agentConnectionCallback.failed" });
      break;
    case "pending":
      if (confirm.kind === "connected") {
        intent = "success";
        message = confirm.account
          ? formatMessage({ id: "pages.agentConnectionCallback.connectedAs" }, { account: confirm.account })
          : formatMessage({ id: "pages.agentConnectionCallback.connected" });
      } else if (confirm.kind === "expired") {
        message = formatMessage({ id: "pages.agentConnectionCallback.expired" });
        reason = confirm.reason;
      } else if (confirm.kind === "error") {
        message = confirm.reason
          ? formatMessage({ id: "pages.agentConnectionCallback.providerRefused" }, { reason: confirm.reason })
          : formatMessage({ id: "pages.agentConnectionCallback.failed" });
      } else {
        intent = "info";
        message = formatMessage({ id: "pages.agentConnectionCallback.confirming" });
      }
      break;
  }

  return (
    <div
      className="h-full min-h-0 overflow-y-auto bg-layer-canvas-muted font-display text-foreground-strong safe-top safe-bottom theme-brutal:bg-brutal-cream theme-brutal:text-black"
      data-testid="agent-connection-callback-page"
      data-kind={view.kind}
      data-confirm={confirm.kind}
    >
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col justify-center px-4 py-8">
        <div className="space-y-4 rounded-lg border border-line-muted bg-layer-panel p-5 shadow-raft-md theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal">
          <div>
            <SectionEyebrow as="div">{formatMessage({ id: "pages.agentConnectionCallback.eyebrow" })}</SectionEyebrow>
            <h1 className="mt-2 text-2xl font-black">{formatMessage({ id: "pages.agentConnectionCallback.title" })}</h1>
          </div>
          <Banner intent={intent} withIcon>
            <span data-testid="agent-connection-callback-message">{message}</span>
          </Banner>
          {reason && (
            <p className="text-sm text-foreground-muted theme-brutal:text-black/70" data-testid="agent-connection-callback-reason">
              {formatMessage({ id: "pages.agentConnectionCallback.providerReason" }, { reason })}
            </p>
          )}
          {foreignConnected && (
            <p className="text-sm text-foreground-muted theme-brutal:text-black/70" data-testid="agent-connection-callback-disconnect-advice">
              {formatMessage({ id: "pages.agentConnectionCallback.foreignConnected" })}
            </p>
          )}
          {agentHref && (
            <Link to={agentHref} className="inline-block text-sm font-bold underline">
              {formatMessage({ id: "pages.agentConnectionCallback.backToAgent" })}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
