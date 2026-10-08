import { randomUuid } from "@botiverse/raft-shared/src/randomUuid";
import {
  Button,
  Checkbox,
  Input,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
} from "raft-ui";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { CheckCircle2, ChevronDown, KeyRound, Link2Off, Pencil, Plus, Power, RefreshCw, Send, Trash2, XCircle } from "lucide-react";
import { useIntl } from "react-intl";
import {
  PI_BUILTIN_PROVIDER_DEFAULT_MODELS,
  PI_BUILTIN_PROVIDER_MODELS,
  providerProbeRequestDigest,
} from "@botiverse/raft-shared";
import type {
  ProviderConnectionAssignedAgent,
  ProviderConnectionAssignedAgentList,
  ProviderConnectionLatestVerified,
  ProviderConnectionProviderId,
  ProviderConnectionProviderOption,
  ProviderConnectionSummary,
  ProviderProbeCreatedView,
} from "@botiverse/raft-shared";
import api from "../../api/client";
import { useProviderConnections } from "../../hooks/useProviderConnections";
import { useMachineStore } from "../../store/machineStore";
import { useProfileStore } from "../../store/profileStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { formatRuntimeLabelWithStatus } from "../../utils/runtimeAvailabilityLabel";
import AvatarListRow from "../ui/AvatarListRow";
import AvatarSlot from "../ui/AvatarSlot";
import StatusDot from "../ui/StatusDot";
import Tooltip from "../ui/Tooltip";
import DialogCard from "../ui/DialogCard";
import FormField from "../ui/FormField";
import SectionHeader from "../ui/SectionHeader";
import EditProviderConnectionModal from "./EditProviderConnectionModal";

function labelForProviderId(
  providerId: ProviderConnectionProviderId,
  providerOptions: ProviderConnectionProviderOption[],
): string {
  return providerOptions.find((entry) => entry.id === providerId)?.label ?? providerId;
}

function isGatewayProviderId(
  providerId: ProviderConnectionProviderId,
  providerOptions: ProviderConnectionProviderOption[],
): boolean {
  return providerOptions.find((entry) => entry.id === providerId)?.providerKind === "gateway";
}

const CUSTOM_MODEL_SELECT_VALUE = "__custom__";

function presetTestModels(providerId: ProviderConnectionProviderId): string[] {
  const prefix = `${providerId}/`;
  return (PI_BUILTIN_PROVIDER_MODELS[providerId] ?? []).map((model) => (
    model.id.startsWith(prefix) ? model.id.slice(prefix.length) : model.id
  ));
}

function defaultTestModel(providerId: ProviderConnectionProviderId): string {
  const value = (PI_BUILTIN_PROVIDER_DEFAULT_MODELS as Partial<Record<ProviderConnectionProviderId, string>>)[providerId];
  const prefix = `${providerId}/`;
  return value?.startsWith(prefix) ? value.slice(prefix.length) : value ?? "";
}

export default function ProviderConnectionsSettings() {
  const { formatMessage } = useIntl();
  const { capabilities } = useServerPermissions();
  const openProfile = useProfileStore((s) => s.openProfile);
  const { connections, providerOptions, loading, error, refresh, featureEnabled } = useProviderConnections();
  // The legacy server-side test button retires exactly when the AI provider
  // feature (single switch) is on; enforcement follows the same key.
  const legacyTestVisible = !featureEnabled;
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ProviderConnectionSummary | null>(null);
  const [testing, setTesting] = useState<ProviderConnectionSummary | null>(null);
  const [verifying, setVerifying] = useState<ProviderConnectionSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  if (!featureEnabled) return null;

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    setActionError("");
    try {
      await action();
      await refresh();
    } catch {
      setActionError(formatMessage({ id: "settings.providers.actionError" }));
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="provider-connections-settings">
      <div className="flex items-center justify-between gap-3">
        <SectionHeader label={formatMessage({ id: "settings.providers.sectionTitle" })} icon={<KeyRound size={16} />} />
        {capabilities.manageExternalAuth && (
          <Button type="button" size="sm" disabled={providerOptions.length === 0} onClick={() => setCreating(true)}>
            <Plus size={16} />
            {formatMessage({ id: "settings.providers.add" })}
          </Button>
        )}
      </div>
      <p className="text-sm text-foreground-muted theme-brutal:text-black/60">{formatMessage({ id: "settings.providers.description" })}</p>

      {(error || actionError) && (
        <div className="border-2 border-line-muted theme-brutal:border-black bg-red-50 px-3 py-2 text-sm font-medium text-red-800">
          {actionError || formatMessage({ id: "settings.providers.loadError" })}
        </div>
      )}

      {loading ? (
        <div className="flex min-h-32 items-center justify-center"><Spinner size="md"  aria-label={formatMessage({ id: "common.loadingLabel" })} /></div>
      ) : connections.length === 0 ? (
        <div className="border-2 border-dashed border-line-muted theme-brutal:border-black/25 px-5 py-10 text-center text-sm text-foreground-muted theme-brutal:text-black/55">
          {formatMessage({ id: "settings.providers.empty" })}
        </div>
      ) : (
        <div className="divide-y-2 divide-line-muted theme-brutal:divide-black border-2 border-line-muted theme-brutal:border-black bg-layer-panel theme-brutal:bg-white shadow-raft-sm theme-brutal:shadow-brutal-sm">
          {connections.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              providerOptions={providerOptions}
              canManage={capabilities.manageExternalAuth}
              legacyTestVisible={legacyTestVisible}
              busy={busyId === connection.id}
              onTest={() => setTesting(connection)}
              onEdit={() => setEditing(connection)}
              onToggle={() => void run(connection.id, () => api.patch(`/provider-connections/${connection.id}`, { enabled: !connection.enabled }))}
              onOpenAgent={(agentId) => openProfile("agent", agentId)}
              onVerify={() => setVerifying(connection)}
              onDetachAgent={(agentId) => run(connection.id, () => api.delete(`/provider-connections/${connection.id}/agents/${agentId}`))}
              onDelete={() => {
                if (window.confirm(formatMessage({ id: "settings.providers.deleteConfirm" }, { name: connection.name }))) {
                  void run(connection.id, () => api.delete(`/provider-connections/${connection.id}`));
                }
              }}
            />
          ))}
        </div>
      )}

      {creating && (
        <CreateProviderConnectionModal
          providerOptions={providerOptions}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}
      {editing && (
        <EditProviderConnectionModal
          key={editing.id}
          connection={editing}
          providerOptions={providerOptions}
          onClose={() => setEditing(null)}
          onCompleted={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
      {verifying && (
        <VerifyProviderConnectionModal
          connection={verifying}
          onClose={() => setVerifying(null)}
        />
      )}
      {testing && (
        <ProviderConnectionTestModal
          key={testing.id}
          connection={testing}
          onClose={() => setTesting(null)}
          onCompleted={async () => {
            setTesting(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function ConnectionRow({
  connection,
  providerOptions,
  canManage,
  legacyTestVisible,
  busy,
  onTest,
  onEdit,
  onToggle,
  onDelete,
  onOpenAgent,
  onVerify,
  onDetachAgent,
}: {
  connection: ProviderConnectionSummary;
  providerOptions: ProviderConnectionProviderOption[];
  canManage: boolean;
  legacyTestVisible: boolean;
  busy: boolean;
  onTest: () => void;
  onEdit?: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onOpenAgent?: (agentId: string) => void;
  onVerify?: () => void;
  onDetachAgent?: (agentId: string) => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const [expanded, setExpanded] = useState(false);
  const [assignedAgents, setAssignedAgents] = useState<ProviderConnectionAssignedAgent[] | null>(null);
  const [loadingAssignedAgents, setLoadingAssignedAgents] = useState(false);
  const [assignedAgentsError, setAssignedAgentsError] = useState(false);
  const ready = connection.enabled;
  const assigned = connection.assignedAgentCount > 0;
  const deleteDisabledReason = assigned
    ? formatMessage(
      { id: "settings.providers.deleteAssignedHint" },
      { count: connection.assignedAgentCount },
    )
    : "";
  const assignedAgentsId = `provider-connection-${connection.id}-assigned-agents`;

  const loadAssignedAgents = useCallback(async () => {
    setLoadingAssignedAgents(true);
    setAssignedAgentsError(false);
    try {
      const { data } = await api.get<ProviderConnectionAssignedAgentList>(
        `/provider-connections/${connection.id}/agents`,
      );
      setAssignedAgents(Array.isArray(data.agents) ? data.agents : []);
    } catch {
      setAssignedAgentsError(true);
    } finally {
      setLoadingAssignedAgents(false);
    }
  }, [connection.id]);

  // The assignment list is read once per row and reused across collapse/reopen:
  // it is bounded by the Agents of one Server, and the catalog refresh that
  // follows any mutation already re-reads the authoritative count.
  const toggleExpanded = () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (assignedAgents === null && !loadingAssignedAgents) void loadAssignedAgents();
  };

  const detachAgent = async (agentId: string) => {
    await onDetachAgent?.(agentId);
    await loadAssignedAgents();
  };

  const handleEdit = onEdit;

  return (
    <div data-testid={`provider-connection-${connection.id}`}>
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center border-2 border-line-muted theme-brutal:border-black ${ready ? "bg-green-100" : "bg-black/5"}`}>
            {ready ? <CheckCircle2 size={17} /> : <XCircle size={17} />}
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-bold">{connection.name}</div>
            <div className="mt-0.5 text-xs text-foreground-muted theme-brutal:text-black/55">
              {labelForProviderId(connection.providerId, providerOptions)}
              {" · "}
              {formatMessage({ id: `settings.providers.status.${connection.status}` })}
              {" · "}
              {assigned ? (
                <Tooltip content={formatMessage({ id: "settings.providers.assignedAgentsExpand" })}>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 font-bold underline decoration-2 underline-offset-2"
                  aria-expanded={expanded}
                  aria-controls={assignedAgentsId}
                  disabled={busy}
                  onClick={toggleExpanded}
                >
                  {connection.assignedAgentCount === 1
                    ? formatMessage({ id: "settings.providers.agentCountOne" })
                    : formatMessage({ id: "settings.providers.agentCount" }, { count: connection.assignedAgentCount })}
                  <ChevronDown size={13} className={expanded ? "rotate-180" : ""} aria-hidden="true" />
                </button>
                </Tooltip>
              ) : formatMessage({ id: "settings.providers.agentCount" }, { count: 0 })}
            </div>
          </div>
        </div>
        {canManage && (
          <div className="flex shrink-0 items-center gap-1">
            {legacyTestVisible && (
              <Button type="button" size="icon-sm" aria-label={formatMessage({ id: "settings.providers.test" })} disabled={busy} onClick={onTest}><Send size={15} /></Button>
            )}
            {onVerify && (
              <Button
                type="button"
                size="icon-sm"
                aria-label={formatMessage({ id: "settings.providers.verify" })}
                disabled={busy}
                onClick={onVerify}
              >
                <Send size={15} />
              </Button>
            )}
            {handleEdit && (
              <Button type="button" size="icon-sm" aria-label={formatMessage({ id: "settings.providers.edit" })} disabled={busy} onClick={handleEdit}><Pencil size={15} /></Button>
            )}
            <Button type="button" size="icon-sm" aria-label={connection.enabled ? formatMessage({ id: "settings.providers.disable" }) : formatMessage({ id: "settings.providers.enable" })} disabled={busy} onClick={onToggle}><Power size={15} /></Button>
            <Tooltip content={deleteDisabledReason || formatMessage({ id: "settings.providers.delete" })}>
            <Button
              type="button"
              size="icon-sm"
              variant="danger"
              data-slot="button"
              // Keep the "disabled but focusable, with a reason" shape: RUI's
              // Button does not land aria-disabled on its own, so the render
              // element carries it.
              render={<button aria-disabled={deleteDisabledReason ? true : undefined} />}
              aria-label={formatMessage({ id: "settings.providers.delete" })}
              aria-description={deleteDisabledReason || undefined}
              className={deleteDisabledReason ? "cursor-not-allowed opacity-50" : ""}
              disabled={busy}
              onClick={deleteDisabledReason ? undefined : onDelete}
            >
              <Trash2 size={15} />
            </Button>
            </Tooltip>
          </div>
        )}
      </div>
      {connection.latestVerified && <VerifiedOnChip latestVerified={connection.latestVerified} />}
      {expanded && assigned && (
        <AssignedAgentsPanel
          panelId={assignedAgentsId}
          agents={assignedAgents}
          loading={loadingAssignedAgents}
          error={assignedAgentsError}
          canManage={canManage}
          busy={busy}
          onRetry={() => void loadAssignedAgents()}
          onOpenAgent={onOpenAgent}
          onDetachAgent={detachAgent}
        />
      )}
    </div>
  );
}

/**
 * Names the Agents holding this connection so a blocked delete is recoverable:
 * an active Agent links to the existing Agent surface that owns its provider,
 * while a soft-deleted Agent — which can no longer be edited — offers detach.
 */
function AssignedAgentsPanel({
  panelId,
  agents,
  loading,
  error,
  canManage,
  busy,
  onRetry,
  onOpenAgent,
  onDetachAgent,
}: {
  panelId: string;
  agents: ProviderConnectionAssignedAgent[] | null;
  loading: boolean;
  error: boolean;
  canManage: boolean;
  busy: boolean;
  onRetry: () => void;
  onOpenAgent?: (agentId: string) => void;
  onDetachAgent: (agentId: string) => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const listed = agents ?? [];
  return (
    <div
      id={panelId}
      className="border-t border-line-hairline bg-fill-muted/30 px-4 py-3 theme-brutal:border-t-2 theme-brutal:border-black theme-brutal:bg-black/[0.03]"
      data-testid="provider-connection-assigned-agents"
    >
      <div className="text-xs font-black uppercase tracking-wide text-foreground-muted">
        {formatMessage({ id: "settings.providers.assignedAgents" })}
      </div>
      <p className="mt-1 text-xs text-foreground-muted">
        {formatMessage({ id: "settings.providers.assignedAgentsUnblockHint" })}
      </p>
      {loading ? (
        <div className="mt-2 flex items-center gap-2 text-sm text-foreground-muted">
          <Spinner size="sm" aria-hidden="true" />
          {formatMessage({ id: "settings.providers.assignedAgentsLoading" })}
        </div>
      ) : error ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-danger-strong">
            {formatMessage({ id: "settings.providers.assignedAgentsError" })}
          </span>
          <Button type="button" size="sm" disabled={busy} onClick={onRetry}>
            <RefreshCw size={15} />
            {formatMessage({ id: "settings.providers.assignedAgentsRetry" })}
          </Button>
        </div>
      ) : listed.length === 0 ? (
        <p className="mt-2 text-sm text-foreground-muted">
          {formatMessage({ id: "settings.providers.assignedAgentsEmpty" })}
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {listed.map((agent) => {
            const label = agent.displayName || agent.name;
            const statusText = formatMessage({ id: `settings.providers.agentStatus.${agent.status}` });
            const subtitle = [
              formatMessage({ id: "settings.providers.assignedAgentHandle" }, { name: agent.name }),
              formatRuntimeLabelWithStatus(agent.runtime, formatMessage),
              agent.computerName ?? formatMessage({ id: "settings.providers.assignedAgentNoComputer" }),
            ].join(" · ");
            return (
              <div key={agent.id} data-testid={`provider-connection-assigned-agent-${agent.id}`}>
                {agent.deleted ? (
                  // Static row: the detach control lives in the primitive's
                  // action slot, a sibling of the (absent) row button, so a
                  // deleted Agent never nests one interactive target in another.
                  <AvatarListRow
                    avatar={<AvatarSlot context="surface-list" type="agent" agentAvatarUrl={null} className="grayscale opacity-60" />}
                    name={<span className="text-foreground-hint line-through">{label}</span>}
                    subtitle={subtitle}
                    rightContent={(
                      <span className="shrink-0 rounded-sm border border-line-muted px-1 text-[10px] font-black uppercase text-foreground-hint theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black/30">
                        {formatMessage({ id: "settings.providers.assignedAgentDeleted" })}
                      </span>
                    )}
                    actionContent={canManage ? (
                      <Tooltip content={formatMessage({ id: "settings.providers.assignedAgentDeletedHint" })}>
                      <Button
                        type="button"
                        size="sm"
                        data-slot="button"
                        disabled={busy}
                        aria-label={formatMessage({ id: "settings.providers.assignedAgentDetach" })}
                        onClick={() => {
                          const confirmed = window.confirm(
                            formatMessage({ id: "settings.providers.detachConfirm" }, { name: label }),
                          );
                          if (confirmed) void onDetachAgent(agent.id);
                        }}
                      >
                        <Link2Off size={15} />
                        {formatMessage({ id: "settings.providers.assignedAgentDetach" })}
                      </Button>
                      </Tooltip>
                    ) : undefined}
                    className="bg-gray-100"
                  />
                ) : (
                  <AvatarListRow
                    avatar={<AvatarSlot context="surface-list" type="agent" agentAvatarUrl={null} />}
                    name={label}
                    subtitle={subtitle}
                    rightContent={(
                      <>
                        <StatusDot activity={agent.status === "active" ? "online" : "offline"} title={statusText} />
                        <span
                          className="hidden max-w-[min(32rem,42vw)] truncate align-middle text-xs font-mono text-foreground-hint sm:inline-block"
                        >
                          {statusText}
                        </span>
                      </>
                    )}
                    onClick={() => onOpenAgent?.(agent.id)}
                    buttonProps={{
                      "aria-label": formatMessage({ id: "settings.providers.assignedAgentOpen" }, { name: label }),
                      title: formatMessage({ id: "settings.providers.assignedAgentOpen" }, { name: label }),
                    }}
                    className="bg-fill-muted/50 hover:bg-fill-muted theme-brutal:bg-gray-100 theme-brutal:hover:bg-white"
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProviderConnectionTestModal({
  connection,
  onClose,
  onCompleted,
}: {
  connection: ProviderConnectionSummary;
  onClose: () => void;
  onCompleted: () => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const [model, setModel] = useState(defaultTestModel(connection.providerId));
  const [message, setMessage] = useState(() => formatMessage({ id: "settings.providers.testMessageDefault" }));
  const [models, setModels] = useState(() => presetTestModels(connection.providerId));
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [customModelMode, setCustomModelMode] = useState(() => {
    const presets = presetTestModels(connection.providerId);
    const initial = defaultTestModel(connection.providerId);
    return presets.length === 0 || (initial.trim().length > 0 && !presets.includes(initial));
  });
  const modelInputId = `provider-connection-${connection.id}-test-model`;
  const modelSelectId = `provider-connection-${connection.id}-test-model-select`;
  const messageInputId = `provider-connection-${connection.id}-test-message`;

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    setModelError("");
    try {
      const response = await api.get<{ models: string[] }>(`/provider-connections/${connection.id}/models`);
      const nextModels = [...new Set([...presetTestModels(connection.providerId), ...response.data.models])];
      setModels(nextModels);
      setModel((current) => {
        if (!current.trim() && nextModels[0]) {
          setCustomModelMode(false);
          return nextModels[0];
        }
        if (nextModels.includes(current)) {
          setCustomModelMode(false);
          return current;
        }
        return current;
      });
    } catch {
      setModelError(formatMessage({ id: "settings.providers.modelsLoadError" }));
    } finally {
      setLoadingModels(false);
    }
  }, [connection.id, connection.providerId, formatMessage]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await api.post(`/provider-connections/${connection.id}/test`, { model, message });
      await onCompleted();
    } catch {
      setError(formatMessage({ id: "settings.providers.testError" }));
    } finally {
      setSubmitting(false);
    }
  };

  const isCustom = customModelMode || (model.trim().length > 0 && !models.includes(model));
  const selectValue = isCustom ? CUSTOM_MODEL_SELECT_VALUE : model;
  const modelSelectOptions = [
    ...models.map((candidate) => ({ value: candidate, label: candidate })),
    { value: CUSTOM_MODEL_SELECT_VALUE, label: formatMessage({ id: "agent.runtimeConfig.custom" }) },
  ];

  return (
    <DialogCard
      onClose={onClose}
      title={formatMessage({ id: "settings.providers.testTitle" }, { name: connection.name })}
      testId="provider-connection-test-dialog"
    >
      <form onSubmit={submit} className="space-y-4" data-testid="provider-connection-test-form">
        <FormField
          label={formatMessage({ id: "settings.providers.testModel" })}
          htmlFor={isCustom || models.length === 0 ? modelInputId : modelSelectId}
        >
          {models.length > 0 ? (
            <Select
              value={selectValue}
              onValueChange={(nextValue) => {
                if (nextValue === CUSTOM_MODEL_SELECT_VALUE) {
                  setCustomModelMode(true);
                  if (models.includes(model)) setModel("");
                  return;
                }
                if (nextValue != null) {
                  setCustomModelMode(false);
                  setModel(nextValue);
                }
              }}
              items={modelSelectOptions}
            >
              <SelectTrigger
                id={modelSelectId}
                className="w-full"
                aria-label={formatMessage({ id: "settings.providers.testModel" })}
              >
                <SelectValue placeholder={formatMessage({ id: "settings.providers.testModel" })} />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent>
                <SelectList>
                  {modelSelectOptions.map((candidate) => (
                    <SelectItem key={candidate.value} value={candidate.value}>
                      <SelectItemText>{candidate.label}</SelectItemText>
                      <SelectItemIndicator />
                    </SelectItem>
                  ))}
                </SelectList>
              </SelectContent>
            </Select>
          ) : null}
          {(isCustom || models.length === 0) && (
            <Input
              id={modelInputId}
              className={`w-full ${models.length > 0 ? "mt-2" : ""}`}
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={formatMessage({ id: "agent.runtimeConfig.customModelId" })}
              maxLength={200}
              required
              autoFocus={isCustom}
            />
          )}
        </FormField>
        <div className="flex items-center justify-between gap-3">
          <p className={`text-xs ${modelError ? "text-red-700" : "text-foreground-muted theme-brutal:text-black/55"}`}>
            {modelError || formatMessage({ id: "settings.providers.testModelHint" })}
          </p>
          <Button type="button" size="sm" disabled={loadingModels || submitting} onClick={() => void loadModels()}>
            <RefreshCw size={15} className={loadingModels ? "animate-spin" : ""} />
            {formatMessage({ id: "settings.providers.refreshModels" })}
          </Button>
        </div>
        <FormField
          label={formatMessage({ id: "settings.providers.testMessage" })}
          htmlFor={messageInputId}
        >
          <Textarea
            id={messageInputId}
            className="min-h-28 w-full resize-y"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            maxLength={2000}
            required
          />
        </FormField>
        {error && <div className="text-sm font-medium text-red-700">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>{formatMessage({ id: "settings.common.cancel" })}</Button>
          <Button type="submit" disabled={submitting || !model.trim() || !message.trim()}>
            {submitting ? <Spinner size="sm" aria-hidden="true" /> : <Send size={16} />}
            {formatMessage({ id: "settings.providers.sendTest" })}
          </Button>
        </div>
      </form>
    </DialogCard>
  );
}

function CreateProviderConnectionModal({
  providerOptions,
  onClose,
  onCreated,
}: {
  providerOptions: ProviderConnectionProviderOption[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const [name, setName] = useState("");
  // oxlint-disable-next-line react-doctor/no-derived-useState -- the modal snapshots the schema catalog default when it opens.
  const [providerId, setProviderId] = useState<ProviderConnectionProviderId>(providerOptions[0]?.id ?? "deepseek");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [supportsImageInput, setSupportsImageInput] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const gateway = isGatewayProviderId(providerId, providerOptions);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await api.post("/provider-connections", {
        name,
        providerId,
        ...(gateway ? { endpointUrl, supportsImageInput } : {}),
        apiKey,
      });
      await onCreated();
    } catch {
      setError(formatMessage({ id: "settings.providers.createError" }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogCard onClose={onClose} title={formatMessage({ id: "settings.providers.createTitle" })} testId="provider-connection-create-dialog">
      <form onSubmit={submit} className="space-y-4" data-testid="provider-connection-create-form">
        <FormField label={formatMessage({ id: "settings.providers.name" })}>
          <Input className="w-full" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required />
        </FormField>
        <FormField label={formatMessage({ id: "settings.providers.provider" })}>
          <Select
            value={providerId}
            onValueChange={(value) => {
              if (value != null) setProviderId(value as ProviderConnectionProviderId);
            }}
            items={providerOptions.map((provider) => ({
              value: provider.id,
              label: provider.label,
            }))}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectList>
                {providerOptions.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    <SelectItemText>{provider.label}</SelectItemText>
                    <SelectItemIndicator />
                  </SelectItem>
                ))}
              </SelectList>
            </SelectContent>
          </Select>
        </FormField>
        {gateway && (
          <FormField label={formatMessage({ id: "settings.providers.endpoint" })}>
            <Input className="w-full" type="url" value={endpointUrl} onChange={(event) => setEndpointUrl(event.target.value)} render={<input placeholder="https://gateway.example.com/v1" />} required />
          </FormField>
        )}
        <FormField label={formatMessage({ id: "settings.providers.apiKey" })} hint={formatMessage({ id: "settings.providers.apiKeyHint" })}>
          <Input className="w-full" type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required />
        </FormField>
        {gateway && (
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox checked={supportsImageInput} onCheckedChange={(event) => setSupportsImageInput(event)} />
            {formatMessage({ id: "settings.providers.imageInput" })}
          </label>
        )}
        {error && <div className="text-sm font-medium text-red-700">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>{formatMessage({ id: "settings.common.cancel" })}</Button>
          <Button type="submit" disabled={submitting || !name.trim() || !apiKey.trim() || (gateway && !endpointUrl.trim())}>
            {submitting ? <Spinner size="sm" aria-hidden="true" /> : <Plus size={16} />}
            {formatMessage({ id: "settings.providers.create" })}
          </Button>
        </div>
      </form>
    </DialogCard>
  );
}

export const __testInternals = { ConnectionRow, CreateProviderConnectionModal, EditProviderConnectionModal, ProviderConnectionTestModal, VerifyProviderConnectionModal, VerifiedOnChip };

/** Prop-driven chip from the catalog read model: zero extra requests. */
function VerifiedOnChip({ latestVerified }: { latestVerified: ProviderConnectionLatestVerified }) {
  const { formatMessage } = useIntl();
  return (
    <div className="flex flex-wrap gap-2 px-4 pb-3" data-testid="provider-connection-verified-on">
      <Tooltip content={`${latestVerified.runtime} · ${latestVerified.model} · ${latestVerified.verifiedAt}`}>
      <span
        className="rounded-md border border-line-muted bg-success-soft px-2 py-0.5 text-xs font-bold text-success-strong theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black/30 theme-brutal:bg-green-50 theme-brutal:text-black/70"
      >
        {formatMessage({ id: "settings.providers.verifiedOn" })}
        {" "}
        {latestVerified.computerName ?? latestVerified.computerId}
      </span>
      </Tooltip>
    </div>
  );
}

/**
 * Computer-scoped verification modal. Deliberately never auto-closes: the
 * user sees 准备 → 正在 <Computer> 验证 → 成功/失败, the durable coordinates,
 * and (only on this page load) the bounded plain-text model reply.
 */
function VerifyProviderConnectionModal({
  connection,
  onClose,
}: {
  connection: ProviderConnectionSummary;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const machines = useMachineStore((state) => state.machines);
  const candidates = machines.filter((machine) => machine.status === "online" && machine.runtimes.includes("builtin"));
  const [computerId, setComputerId] = useState(candidates[0]?.id ?? "");
  const [model, setModel] = useState(() => defaultTestModel(connection.providerId));
  const [phase, setPhase] = useState<"idle" | "running" | "done">("idle");
  const [result, setResult] = useState<ProviderProbeCreatedView | null>(null);
  const [failure, setFailure] = useState("");
  const computerName = machines.find((machine) => machine.id === computerId)?.name ?? computerId;
  const presetModels = presetTestModels(connection.providerId);
  const [customModelMode, setCustomModelMode] = useState(() => {
    const initial = defaultTestModel(connection.providerId);
    return presetModels.length === 0 || (initial.trim().length > 0 && !presetModels.includes(initial));
  });
  const isCustom = customModelMode || (model.trim().length > 0 && !presetModels.includes(model));
  const verifyModelInputId = `provider-connection-${connection.id}-verify-model`;
  const verifyModelSelectId = `provider-connection-${connection.id}-verify-model-select`;
  const verifyModelOptions = [
    ...presetModels.map((candidate) => ({ value: candidate, label: candidate })),
    { value: CUSTOM_MODEL_SELECT_VALUE, label: formatMessage({ id: "agent.runtimeConfig.custom" }) },
  ];

  const start = async () => {
    setPhase("running");
    setFailure("");
    setResult(null);
    try {
      const payload = {
        computerId,
        runtime: "builtin",
        model: model.trim() || defaultTestModel(connection.providerId),
        probeKind: "canary" as const,
      };
      const requestDigest = await providerProbeRequestDigest({ connectionId: connection.id, ...payload });
      const { data } = await api.post<ProviderProbeCreatedView>(`/provider-connections/${connection.id}/probes`, {
        probeRequestId: randomUuid(),
        requestDigest,
        ...payload,
      });
      setResult(data);
      setPhase("done");
    } catch {
      setFailure(formatMessage({ id: "settings.providers.verifyError" }));
      setPhase("done");
    }
  };

  const outcome = result?.probe.outcome ?? null;
  const category = result?.probe.category ?? null;
  return (
    <DialogCard
      onClose={onClose}
      title={formatMessage({ id: "settings.providers.verifyTitle" }, { name: connection.name })}
      testId="provider-connection-verify-dialog"
    >
      <div className="space-y-4" data-testid="provider-connection-verify-body">
        <FormField label={formatMessage({ id: "settings.providers.verifyComputer" })}>
          <Select
            value={computerId}
            disabled={phase === "running" || candidates.length === 0}
            onValueChange={(value) => {
              if (value != null) setComputerId(value);
            }}
            items={candidates.map((machine) => ({
              value: machine.id,
              label: machine.name,
            }))}
          >
            <SelectTrigger
              className="w-full"
              aria-label={formatMessage({ id: "settings.providers.verifyComputer" })}
              disabled={phase === "running" || candidates.length === 0}
            >
              <SelectValue placeholder={formatMessage({ id: "settings.providers.verifyComputer" })} />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectList>
                {candidates.map((machine) => (
                  <SelectItem key={machine.id} value={machine.id}>
                    <SelectItemText>{machine.name}</SelectItemText>
                    <SelectItemIndicator />
                  </SelectItem>
                ))}
              </SelectList>
            </SelectContent>
          </Select>
        </FormField>
        {candidates.length === 0 && (
          <p className="text-sm text-foreground-muted">{formatMessage({ id: "settings.providers.verifyNoComputers" })}</p>
        )}
        <FormField
          label={formatMessage({ id: "settings.providers.verifyModel" })}
          htmlFor={isCustom || presetModels.length === 0 ? verifyModelInputId : verifyModelSelectId}
        >
          {presetModels.length > 0 ? (
            <Select
              value={isCustom ? CUSTOM_MODEL_SELECT_VALUE : model}
              disabled={phase === "running"}
              onValueChange={(nextValue) => {
                if (nextValue === CUSTOM_MODEL_SELECT_VALUE) {
                  setCustomModelMode(true);
                  if (presetModels.includes(model)) setModel("");
                  return;
                }
                if (nextValue != null) {
                  setCustomModelMode(false);
                  setModel(nextValue);
                }
              }}
              items={verifyModelOptions}
            >
              <SelectTrigger
                id={verifyModelSelectId}
                className="w-full"
                aria-label={formatMessage({ id: "settings.providers.verifyModel" })}
                disabled={phase === "running"}
              >
                <SelectValue placeholder={formatMessage({ id: "settings.providers.verifyModel" })} />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent>
                <SelectList>
                  {verifyModelOptions.map((candidate) => (
                    <SelectItem key={candidate.value} value={candidate.value}>
                      <SelectItemText>{candidate.label}</SelectItemText>
                      <SelectItemIndicator />
                    </SelectItem>
                  ))}
                </SelectList>
              </SelectContent>
            </Select>
          ) : null}
          {(isCustom || presetModels.length === 0) && (
            <input
              id={verifyModelInputId}
              className={`input-brutal w-full ${presetModels.length > 0 ? "mt-2" : ""}`}
              value={model}
              disabled={phase === "running"}
              onChange={(event) => setModel(event.target.value)}
              placeholder={formatMessage({ id: "agent.runtimeConfig.customModelId" })}
              maxLength={200}
              required
              autoFocus={isCustom}
            />
          )}
        </FormField>
        {phase === "running" && (
          <p className="text-sm text-foreground-muted" data-testid="provider-connection-verify-running">
            {formatMessage({ id: "settings.providers.verifyRunning" }, { computer: computerName })}
          </p>
        )}
        {phase === "done" && result && outcome === "success" && (
          <div className="space-y-2" data-testid="provider-connection-verify-success">
            <p className="text-sm font-bold text-green-800">
              {formatMessage({ id: "settings.providers.verifySuccess" }, { computer: computerName })}
              {" · "}
              {formatMessage({ id: "settings.providers.verifyLatency" }, { ms: result.probe.latencyMs ?? 0 })}
              {" · "}
              {result.probe.verifiedAt ?? ""}
            </p>
            <div>
              <div className="text-xs font-black uppercase tracking-wide text-foreground-muted">
                {formatMessage({ id: "settings.providers.verifyReply" })}
              </div>
              {result.reply ? (
                <pre className="input-brutal mt-1 w-full whitespace-pre-wrap" data-testid="provider-connection-verify-reply">
                  {result.reply}
                </pre>
              ) : (
                <p className="mt-1 text-xs text-foreground-muted">{formatMessage({ id: "settings.providers.verifyReplyMissing" })}</p>
              )}
            </div>
          </div>
        )}
        {phase === "done" && (outcome === "failure" || failure) && (
          <div className="space-y-1" data-testid="provider-connection-verify-failure">
            <p className="text-sm font-bold text-red-700">
              {failure || formatMessage({ id: "settings.providers.verifyFailure" }, {
                category: category ? formatMessage({ id: `settings.providers.probeCategory.${category}` }) : "",
              })}
            </p>
            <p className="text-xs text-foreground-muted">{formatMessage({ id: "settings.providers.verifyFailureHint" })}</p>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>{formatMessage({ id: "settings.common.close" })}</Button>
          <Button
            type="button"
            disabled={phase === "running" || candidates.length === 0}
            onClick={() => void start()}
          >
            {phase === "done"
              ? formatMessage({ id: "settings.providers.verifyAgain" })
              : formatMessage({ id: "settings.providers.verifyStart" })}
          </Button>
        </div>
      </div>
    </DialogCard>
  );
}
