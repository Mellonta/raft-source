import { Badge, Button, Checkbox } from "raft-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import type {
  AgentAppEventDetail,
  AgentAppEventListResponse,
  AgentAppEventSummary,
} from "@botiverse/raft-shared";
import api from "../../api/client";
import Banner from "../ui/Banner";
import SectionHeader from "../ui/SectionHeader";
import SurfaceListItem from "../ui/SurfaceListItem";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import type { MessageId } from "../../i18n/messages";

interface AgentIntegrationItem {
  id: string;
  type: "pending" | "active";
  clientId: string;
  clientName: string;
  clientDescription: string | null;
  clientHomepageUrl: string | null;
  clientAgentManifestUrl: string | null;
  scopes: string[];
  createdAt: string;
  grantSource: "person" | "agent_login" | "app_request" | null;
}

interface GrantableApp {
  clientId: string;
  clientKey: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  scopes: string[];
}

const GRANT_SOURCE_LABEL: Record<NonNullable<AgentIntegrationItem["grantSource"]>, MessageId> = {
  person: "agent.apps.grantSource.person",
  agent_login: "agent.apps.grantSource.agentLogin",
  app_request: "agent.apps.grantSource.appRequest",
};

const EVENT_STATUS_VARIANT: Record<AgentAppEventSummary["status"], "success" | "warning" | "muted"> = {
  delivered: "success",
  queued: "warning",
  expired: "muted",
};

function errorText(err: unknown, fallback: string): string {
  const message = (err as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
  return typeof message === "string" && message ? message : fallback;
}

function ScopeChips({ scopes }: { scopes: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {scopes.map((scope) => (
        <span key={scope} className="inline-flex border border-line-muted bg-layer-card px-1.5 py-0.5 text-[10px] font-bold uppercase theme-brutal:border-black theme-brutal:bg-white">
          {scope}
        </span>
      ))}
    </div>
  );
}

/** Pick an app usable on this server and the scopes to grant, then confirm. */
function GrantAccessForm({ agentId, onDone, onCancel }: { agentId: string; onDone: () => void; onCancel: () => void }) {
  const { formatMessage } = useIntl();
  const [apps, setApps] = useState<GrantableApp[] | null>(null);
  const [selected, setSelected] = useState<GrantableApp | null>(null);
  const [scopes, setScopes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let canceled = false;
    api.get(`/integrations/agents/${agentId}/grantable-apps`)
      .then(({ data }) => { if (!canceled) setApps(data.apps ?? []); })
      .catch((err) => { if (!canceled) setError(errorText(err, formatMessage({ id: "agent.apps.loadGrantableFailed" }))); });
    return () => { canceled = true; };
  }, [agentId, formatMessage]);

  const choose = (app: GrantableApp) => {
    setSelected(app);
    setScopes(app.scopes);
  };

  const submit = async () => {
    if (!selected || scopes.length === 0) return;
    setSaving(true);
    setError("");
    try {
      await api.post(`/integrations/agents/${agentId}/grants`, { clientId: selected.clientId, scopes });
      onDone();
    } catch (err) {
      setError(errorText(err, formatMessage({ id: "agent.apps.grantFailed" })));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SurfaceListItem className="space-y-3" interactive={false} data-testid="agent-grant-access-form">
      <div className="text-sm font-bold text-foreground-strong">{formatMessage({ id: "agent.apps.grantTitle" })}</div>
      <div className="text-xs text-foreground-muted">{formatMessage({ id: "agent.apps.grantDescription" })}</div>
      {error && <Banner intent="warning" density="sm" className="font-bold">{error}</Banner>}
      {apps === null ? (
        !error && <div className="text-xs font-bold text-foreground-muted">{formatMessage({ id: "common.loading" })}</div>
      ) : apps.length === 0 ? (
        <div className="text-sm text-foreground-muted">{formatMessage({ id: "agent.apps.noGrantableApps" })}</div>
      ) : (
        <div className="grid gap-2">
          {apps.map((app) => (
            <button
              key={app.clientId}
              type="button"
              onClick={() => choose(app)}
              aria-pressed={selected?.clientId === app.clientId}
              className={`border-2 p-2.5 text-left ${selected?.clientId === app.clientId ? "border-accent bg-accent-soft theme-brutal:border-black theme-brutal:bg-brutal-lime/20" : "border-line-muted bg-layer-panel theme-brutal:border-black/15 theme-brutal:bg-white"}`}
            >
              <span className="block text-xs font-black text-foreground-strong">{app.name}</span>
              {app.description && <span className="mt-0.5 block text-[11px] text-foreground-muted">{app.description}</span>}
            </button>
          ))}
        </div>
      )}
      {selected && (
        <div className="space-y-2">
          <div className="text-xs font-bold text-foreground-strong">{formatMessage({ id: "agent.apps.grantScopes" })}</div>
          {selected.scopes.map((scope) => (
            <label key={scope} className="flex items-center gap-2 font-mono text-xs text-foreground-strong">
              <Checkbox
                size="sm"
                checked={scopes.includes(scope)}
                onCheckedChange={(checked) => setScopes((prev) => checked ? [...prev, scope] : prev.filter((s) => s !== scope))}
              />
              {scope}
            </label>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void submit()} disabled={!selected || scopes.length === 0 || saving}>
          {formatMessage({ id: "agent.apps.grantConfirm" })}
        </Button>
        <Button variant="outline" size="sm" onClick={onCancel}>{formatMessage({ id: "agent.detail.cancel" })}</Button>
      </div>
    </SurfaceListItem>
  );
}

function AppEventRow({ agentId, event }: { agentId: string; event: AgentAppEventSummary }) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<AgentAppEventDetail | null>(null);
  const [error, setError] = useState("");

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || detail) return;
    try {
      const { data } = await api.get(`/integrations/agents/${agentId}/events/${event.id}`);
      setDetail(data);
    } catch (err) {
      setError(errorText(err, formatMessage({ id: "agent.apps.loadEventFailed" })));
    }
  };

  return (
    <SurfaceListItem className="space-y-1.5" interactive={false}>
      <button type="button" onClick={() => void toggle()} aria-expanded={open} className="block w-full text-left">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-sm font-bold text-foreground-strong break-words">{event.summary}</div>
          <Badge appearance="soft" variant={EVENT_STATUS_VARIANT[event.status]} uppercase className="shrink-0 text-[10px]">
            {formatMessage({ id: `agent.apps.eventStatus.${event.status}` as MessageId })}
          </Badge>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
          <span className="font-bold">{event.app.name}</span>
          <span className="font-mono">{event.kind}</span>
          <span className="font-mono">{formatShortDateTime(event.createdAt)}</span>
        </div>
      </button>
      {open && (
        error ? (
          <Banner intent="warning" density="sm" className="font-bold">{error}</Banner>
        ) : detail ? (
          // App-supplied data: shown as inert JSON text, never rendered as links or markup.
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all border border-line-muted bg-layer-card p-2 font-mono text-[11px] text-foreground-strong theme-brutal:border-black/15">
            {JSON.stringify(detail.payload, null, 2)}
          </pre>
        ) : (
          <div className="text-xs font-bold text-foreground-muted">{formatMessage({ id: "common.loading" })}</div>
        )
      )}
    </SurfaceListItem>
  );
}

/** Recent events apps sent to this agent, newest first, filterable by app. */
function AgentAppEventsSection({ agentId }: { agentId: string }) {
  const { formatMessage } = useIntl();
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const [events, setEvents] = useState<AgentAppEventSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [appFilter, setAppFilter] = useState<string | null>(null);
  const [apps, setApps] = useState<Array<{ clientId: string; name: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (cursor: string | null) => {
    setLoading(true);
    setError("");
    try {
      const params: Record<string, string> = {};
      if (appFilter) params.clientId = appFilter;
      if (cursor) params.before = cursor;
      const { data } = await api.get(`/integrations/agents/${agentId}/events`, { params });
      const page = data as AgentAppEventListResponse;
      setEvents((prev) => cursor ? [...prev, ...page.events] : page.events);
      setNextCursor(page.nextCursor);
      if (!appFilter) {
        // Filter chips come from the apps seen so far in the unfiltered list.
        setApps((prev) => {
          const byId = new Map(prev.map((app) => [app.clientId, app]));
          for (const event of page.events) byId.set(event.app.clientId, { clientId: event.app.clientId, name: event.app.name });
          return [...byId.values()];
        });
      }
    } catch (err) {
      setError(errorText(err, formatMessageRef.current({ id: "agent.apps.loadEventsFailed" })));
    } finally {
      setLoading(false);
    }
  }, [agentId, appFilter]);

  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-derived-state -- async loading indicator, same pattern as the grants list
    void load(null);
  }, [load]);

  return (
    <div className="space-y-3" data-testid="agent-app-events">
      <div>
        <SectionHeader
          label={formatMessage({ id: "agent.apps.eventsTitle" })}
          action={
            <Button variant="outline" size="sm" onClick={() => void load(null)} disabled={loading} className="text-[11px]">
              {loading ? formatMessage({ id: "common.loading" }) : formatMessage({ id: "agent.apps.refresh" })}
            </Button>
          }
        />
        <div className="mt-1 text-xs text-foreground-muted">{formatMessage({ id: "agent.apps.eventsDescription" })}</div>
      </div>
      {apps.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant={appFilter === null ? "default" : "outline"} onClick={() => setAppFilter(null)} className="text-[11px]">
            {formatMessage({ id: "agent.apps.allApps" })}
          </Button>
          {apps.map((app) => (
            <Button key={app.clientId} size="sm" variant={appFilter === app.clientId ? "default" : "outline"} onClick={() => setAppFilter(app.clientId)} className="text-[11px]">
              {app.name}
            </Button>
          ))}
        </div>
      )}
      {error && <Banner intent="warning" density="sm" className="font-bold">{error}</Banner>}
      {events.length === 0 && !loading && !error ? (
        <div className="text-sm text-foreground-muted theme-brutal:text-black/50">{formatMessage({ id: "agent.apps.noEvents" })}</div>
      ) : (
        <div className="space-y-2">
          {events.map((event) => <AppEventRow key={event.id} agentId={agentId} event={event} />)}
        </div>
      )}
      {nextCursor && (
        <Button variant="outline" size="sm" onClick={() => void load(nextCursor)} disabled={loading}>
          {formatMessage({ id: "agent.apps.loadMore" })}
        </Button>
      )}
    </div>
  );
}

/**
 * The Agent panel's Apps tab: which apps can act for this agent (and how they
 * got access), pending requests, granting access on the agent's behalf, and
 * the events apps sent to it. `canManageAgentAccess` is the agent's creator or
 * a server owner/admin; the server enforces the same rule.
 */
export default function AgentAppAccessTab({ agentId, canManageAgentAccess }: { agentId: string; canManageAgentAccess: boolean }) {
  const { formatMessage } = useIntl();
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const { formatShortDateTime } = useTimeFormatter();
  const [items, setItems] = useState<AgentIntegrationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [granting, setGranting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { data } = await api.get(`/integrations/agents/${agentId}`);
      setItems(data);
    } catch (err) {
      setError(errorText(err, formatMessageRef.current({ id: "agent.detail.loadIntegrationsFailed" })));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-derived-state -- async loading indicator (set at request start, cleared in finally)
    void load();
  }, [load]);

  const act = async (path: string, body: unknown, fallbackId: MessageId) => {
    setError("");
    try {
      await api.post(path, body);
      await load();
    } catch (err) {
      setError(errorText(err, formatMessage({ id: fallbackId })));
    }
  };

  const pending = items.filter((item) => item.type === "pending");
  const active = items.filter((item) => item.type === "active");

  return (
    <div className="flex-1 overflow-y-auto bg-layer-panel px-5 py-4 space-y-6 theme-brutal:bg-white">
      {error && <Banner intent="warning" density="sm" className="font-bold">{error}</Banner>}

      {pending.length > 0 && (
        <div className="space-y-3" data-testid="agent-app-pending">
          <SectionHeader label={formatMessage({ id: "agent.apps.pendingTitle" })} count={pending.length} />
          {pending.map((item) => (
            <SurfaceListItem key={item.id} className="space-y-2" interactive={false}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-bold text-foreground-strong">{item.clientName}</div>
                  <div className="text-xs text-foreground-muted">{formatShortDateTime(item.createdAt)}</div>
                </div>
                <Badge appearance="soft" variant="warning" uppercase className="text-[10px]">
                  {formatMessage({ id: "agent.apps.pending" })}
                </Badge>
              </div>
              <ScopeChips scopes={item.scopes} />
              {canManageAgentAccess && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void act(`/integrations/requests/${item.id}/approve`, { remember: true }, "agent.apps.approveFailed")}>
                    {formatMessage({ id: "agent.apps.approve" })}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void act(`/integrations/requests/${item.id}/deny`, {}, "agent.apps.denyFailed")}>
                    {formatMessage({ id: "agent.apps.deny" })}
                  </Button>
                </div>
              )}
            </SurfaceListItem>
          ))}
        </div>
      )}

      <div className="space-y-3">
        <div>
          <SectionHeader
            label={formatMessage({ id: "agent.detail.applications" })}
            action={loading
              ? <span className="text-xs font-bold text-foreground-muted">{formatMessage({ id: "common.loading" })}</span>
              : canManageAgentAccess && !granting
                ? <Button variant="outline" size="sm" onClick={() => setGranting(true)} className="text-[11px]">{formatMessage({ id: "agent.apps.grantAccess" })}</Button>
                : null}
          />
          <div className="mt-1 text-xs text-foreground-muted">
            {formatMessage({ id: "agent.detail.applicationsDescription" })}
          </div>
        </div>
        {granting && (
          <GrantAccessForm
            agentId={agentId}
            onCancel={() => setGranting(false)}
            onDone={() => { setGranting(false); void load(); }}
          />
        )}
        {active.length === 0 ? (
          <div className="text-sm text-foreground-muted theme-brutal:text-black/50">{formatMessage({ id: "agent.detail.noConnectedApps" })}</div>
        ) : (
          <div className="space-y-3">
            {active.map((item) => (
              <SurfaceListItem key={item.id} className="space-y-2" interactive={false}>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-bold text-foreground-strong">{item.clientName}</div>
                    <div className="text-xs text-foreground-muted">{formatShortDateTime(item.createdAt)}</div>
                    {item.grantSource && (
                      <div className="text-xs text-foreground-muted">{formatMessage({ id: GRANT_SOURCE_LABEL[item.grantSource] })}</div>
                    )}
                  </div>
                  <Badge appearance="soft" variant="success" uppercase className="text-[10px]">
                    {formatMessage({ id: "agent.detail.active" })}
                  </Badge>
                </div>
                {item.clientDescription && <div className="text-sm text-foreground-muted">{item.clientDescription}</div>}
                {item.clientAgentManifestUrl && (
                  <div className="break-all font-mono text-xs text-foreground-muted">
                    {formatMessage({ id: "agent.detail.agentManifest" }, { url: item.clientAgentManifestUrl })}
                  </div>
                )}
                <ScopeChips scopes={item.scopes} />
                <div className="flex flex-wrap gap-2">
                  {canManageAgentAccess && (
                    <Button variant="outline" size="sm" onClick={() => void act(`/integrations/grants/${item.id}/revoke`, {}, "agent.detail.revokeIntegrationFailed")}>
                      {formatMessage({ id: "agent.detail.revoke" })}
                    </Button>
                  )}
                  {item.clientHomepageUrl && (
                    <a href={item.clientHomepageUrl} target="_blank" rel="noreferrer" className="text-xs font-bold underline text-foreground-muted self-center">
                      {formatMessage({ id: "agent.detail.viewService" })}
                    </a>
                  )}
                </div>
              </SurfaceListItem>
            ))}
          </div>
        )}
      </div>

      <AgentAppEventsSection agentId={agentId} />
    </div>
  );
}
