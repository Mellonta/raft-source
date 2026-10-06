/**
 * Hosted runtime providers for external agents (raft-agent-provider.v1).
 *
 * The provider (today only antiproton) is configured once per deployment
 * (env) and enabled per server by a feature flag. "Create external agent" can
 * then pick it: Raft creates the agent,
 * mints its `sk_agent_*` credential server-side and provisions the agent on
 * the provider, which runs it over the ordinary external-agent protocol.
 * Provisioning is a separate layer; the runtime protocol is unchanged.
 *
 * There is deliberately no model field anywhere: provisioned agents run on
 * the provider's default model.
 */

export const AGENT_RUNTIME_PROVIDER_KINDS = ["antiproton"] as const;
export type AgentRuntimeProviderKind = typeof AGENT_RUNTIME_PROVIDER_KINDS[number];

export function isAgentRuntimeProviderKind(value: unknown): value is AgentRuntimeProviderKind {
  return typeof value === "string" && (AGENT_RUNTIME_PROVIDER_KINDS as readonly string[]).includes(value);
}

/**
 * `GET /api/agent-runtime-providers/:kind` — read-only availability probe for
 * the create dialog: the deployment has the provider configured (env) AND the
 * server has the provider's feature flag. Nothing about the configuration is
 * exposed.
 */
export interface AgentRuntimeProviderAvailabilityView {
  kind: AgentRuntimeProviderKind;
  available: boolean;
}

/**
 * Provisioning lifecycle of one agent on a hosted runtime provider.
 *
 * provisioning → active            POST succeeded (edits then flow as PATCH)
 * provisioning → failed            the provider refused (4xx) or is not configured; retry is manual
 * failed       → provisioning      manual retry
 * any          → deleting          the Raft agent was deleted (credentials revoked first)
 * deleting     → deleted           provider DELETE answered 2xx/404
 */
export const AGENT_RUNTIME_PROVISION_STATES = ["provisioning", "active", "failed", "deleting", "deleted"] as const;
export type AgentRuntimeProvisionState = typeof AGENT_RUNTIME_PROVISION_STATES[number];

export interface AgentRuntimeProvisionError {
  code: string;
  message: string;
  /** HTTP status from the provider; null for network/timeout/local errors. */
  httpStatus: number | null;
  at: string;
}

/** `hostedRuntime` on agent responses for callers who can manage the agent. */
export interface AgentHostedRuntimeSummary {
  provider: AgentRuntimeProviderKind;
  state: AgentRuntimeProvisionState;
  providerAgentId: string | null;
  /** An edit (name/instructions) is waiting to be PATCHed to the provider. */
  syncPending: boolean;
  push: { registered: boolean; error: string | null } | null;
  lastError: AgentRuntimeProvisionError | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  activatedAt: string | null;
}

/**
 * Account connections for provider-backed agents (raft-agent-provider.v1
 * connections extension). The provider owns the OAuth flow and the token;
 * Raft only starts it, reads status and disconnects. Allowlist: GitHub only.
 */
export const AGENT_CONNECTION_PROVIDERS = ["github"] as const;
export type AgentConnectionProvider = typeof AGENT_CONNECTION_PROVIDERS[number];

export function isAgentConnectionProvider(value: unknown): value is AgentConnectionProvider {
  return typeof value === "string" && (AGENT_CONNECTION_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Outcome the provider appends to the returnUrl after the OAuth round trip.
 * `pending` carries a `pending=<id>` that only takes effect once Raft confirms
 * it server-to-server for the signed-in user who started the flow.
 */
export const AGENT_CONNECTION_CALLBACK_STATUSES = ["pending", "denied", "failed"] as const;
export type AgentConnectionCallbackStatus = typeof AGENT_CONNECTION_CALLBACK_STATUSES[number];

/** `POST /api/agents/:id/connections/:provider` body. `private` requests private-repo access. */
export interface AgentConnectionStartRequest {
  access?: "private";
}

/** `POST /api/agents/:id/connections/:provider/confirm` body: the provider's pending id from the return URL. */
export interface AgentConnectionConfirmRequest {
  pending: string;
}

/** Shape of a pending id the provider hands back (opaque, URL-safe). */
export const AGENT_CONNECTION_PENDING_ID_RE = /^[A-Za-z0-9_.~-]{1,200}$/;

/** `POST /api/agents/:id/connections/:provider` → one-time provider URL the browser opens. */
export interface AgentConnectionStartView {
  url: string;
  expiresAt: string;
  scopes: string[];
}

/** `PUT /api/agents/:id/connections/:provider` body: point the agent at a tenant connector. */
export interface AgentConnectionAssignRequest {
  connectorId: string;
}

/** Shape of a connector id the provider hands back (opaque, URL-safe). */
export const AGENT_CONNECTION_CONNECTOR_ID_RE = /^[A-Za-z0-9_.~-]{1,200}$/;

/** Who is acting on a connector, decided by Raft (the provider knows no roles). */
export type AgentConnectorActingRole = "creator" | "admin";

/**
 * A tenant-level (per Raft server) account connection. Several agents may use
 * the same connector; no token is ever part of this view.
 */
export interface AgentConnectionConnectorView {
  id: string;
  account: string | null;
  createdAt: string | null;
  /** The Raft user who created the connector; `name`/`displayName` are null when not a member of this server. */
  creator: { id: string; name: string | null; displayName: string | null } | null;
  /** The agent currently uses this connector. */
  current: boolean;
  /** The caller may assign this connector to an agent and disconnect it (its creator or a server owner/admin). */
  canManage: boolean;
}

/**
 * `GET /api/agents/:id/connections/:provider`. `supported: false` when the
 * provider does not serve connections (it answered 404).
 */
export type AgentConnectionStatusView =
  | { provider: AgentConnectionProvider; supported: false }
  | {
    provider: AgentConnectionProvider;
    supported: true;
    connected: boolean;
    account: string | null;
    connectedAt: string | null;
    /** The Raft user who completed the connection, resolved when still known. */
    connectedBy: { id: string; name: string | null } | null;
    scopes: string[];
    /** The tenant connector this agent uses, if any. */
    connectorId: string | null;
    /** Every tenant connector of this provider on the agent's server. */
    connectors: AgentConnectionConnectorView[];
  };

/**
 * `GET /api/agents/:id/external-diagnostics` — the debugging snapshot of an
 * external agent (runtime `external`, incl. provider-backed ones) behind the
 * agent panel's "Copy diagnostic info". Same access as the other private agent
 * surfaces (owner/admin `editAgents`, or the agent's human creator). Carries no
 * secrets: the push endpoint is reduced to its host.
 */
export interface ExternalAgentDiagnosticsView {
  agentId: string;
  runtime: string;
  generatedAt: string;
  /** Hosted runtime provisioning; null for a self-run external agent. */
  provider: {
    kind: AgentRuntimeProviderKind;
    state: AgentRuntimeProvisionState;
    providerAgentId: string | null;
    syncPending: boolean;
    lastErrorCode: string | null;
    lastErrorAt: string | null;
    activatedAt: string | null;
  } | null;
  presence: {
    /** max(credential last_used_at) over the agent's active credentials. */
    lastSeenAt: string | null;
    onlineWindowMs: number;
    /** lastSeenAt is within onlineWindowMs of generatedAt. */
    online: boolean;
  };
  status: {
    activity: string;
    detail: string | null;
    detailKind: string | null;
    /** When the live status was observed (reporter occurredAt when known). */
    observedAt: string | null;
    /** Newest activity-log entry. */
    lastActivityLogAt: string | null;
    /** First accepted raft-agent-status.v1 report; null = hook-derived status. */
    statusProtocolAdoptedAt: string | null;
  };
  push: {
    registered: boolean;
    enabled: boolean;
    /** Host of the registered endpoint only (no path/query). */
    endpointHost: string | null;
    disabledReason: string | null;
    disabledAt: string | null;
    consecutiveFailures: number;
    lastAttemptAt: string | null;
    lastDeliveryAt: string | null;
    lastError: string | null;
    nextAttemptAt: string | null;
  };
  events: {
    /** Last cursor-mode `GET /internal/agent-api/events?ack=cursor` (or its ack), if any. */
    lastCursorPullAt: string | null;
    /** Durable seqs handed over by that pull and not yet acknowledged. */
    pendingCursorAckCount: number;
  };
  /**
   * Account connections (provider-backed agents only). `state`:
   * connected / not_connected / unsupported (the provider serves none) /
   * not_applicable (not provider-backed) / unavailable (`reason` says why).
   */
  connections: Array<{
    provider: AgentConnectionProvider;
    state: "connected" | "not_connected" | "unsupported" | "not_applicable" | "unavailable";
    account: string | null;
    reason: string | null;
  }>;
}
