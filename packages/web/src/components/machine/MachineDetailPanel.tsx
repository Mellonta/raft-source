import { Input, Textarea, Card, Badge, Button, CopyableCodeRoot, CopyableCode, CopyableCodeAction } from "raft-ui";
import { useEffect, useId, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Trash2, Monitor, Check, RefreshCw, FolderOpen, Play, Plus, X, Pencil, Square, RotateCcw, CheckCircle, AlertCircle, Terminal, ChevronRight } from "lucide-react";
import DialogCard from "../ui/DialogCard";
import Banner from "../ui/Banner";
import { machineDiskLowPresentation } from "../../utils/machineDiskPresentation";
import ProgressBar from "../ui/ProgressBar";
import { compareComputerVersions, getMachineRuntimeDisplayOptions, isComputerSemver, isRemoteUpgradeSupported, runtimeAvailabilitySuffix } from "@botiverse/raft-shared";
import { formatRuntimeAvailabilitySuffix, formatRuntimeLabelWithStatus } from "../../utils/runtimeAvailabilityLabel";
import { agentModelLabel } from "../../utils/agentModelName";
import { useMachineStore } from "../../store/machineStore";
import { REMOTE_COMPUTER_UPGRADE_V2_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import type { Machine, MachineWorkspaceEntry } from "../../store/machineStore";
import { computeAgentDisplayState, selectAgentActivitiesSlice, useAgentStore } from "../../store/agentStore";
import { useServerStore } from "../../store/serverStore";
import { useProfileStore } from "../../store/profileStore";
import { useAuthStore } from "../../store/authStore";
import api from "../../api/client";
import { useAppNavigate, useMobileBack } from "../../hooks/useAppNavigate";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { getServerUrl } from "../../utils/server";
import { formatRelativeTime } from "../../utils/relativeTime";
import { getComputerCommands } from "../../utils/computerSetupCommand";
import { getComputerVersionFact } from "../../utils/computerVersionFact";
import { canViewMachineRuntimeAccountUsage } from "../../utils/machineRuntimeUsageVisibility";
import ConfirmDialog from "../ConfirmDialog";
import { trackAgentCreateOpened } from "../../analytics/journey";
import CreateAgentDialog from "../agent/CreateAgentDialog";
import StatusDot from "../ui/StatusDot";
import Tooltip from "../ui/Tooltip";
import PanelHeader from "../ui/PanelHeader";
import SectionEyebrow from "../ui/SectionEyebrow";
import SectionHeader from "../ui/SectionHeader";
import KeyValueRow from "../ui/KeyValueRow";
import AvatarSlot from "../ui/AvatarSlot";
import SurfaceListItem from "../ui/SurfaceListItem";
import AvatarListRow from "../ui/AvatarListRow";
import CheckMarker from "../ui/CheckMarker";
import { formatActivityText } from "../../utils/activity";
import { RuntimeAccountUsageGateChip } from "./RuntimeAccountUsageChip";
import ComputerReleaseNotesAffordance from "./ComputerReleaseNotesAffordance";
import { formatFileSizeBytes } from "../../utils/fileSizePresentation";

const EMPTY_WORKSPACES: MachineWorkspaceEntry[] = [];

/** A refused Upgrade click, mapped from the server's code (never its text). */
type UpgradeRefusal = "web_upgrade_off" | "too_old" | "not_allowed" | "unknown";

function upgradeRefusalFromCode(code: string | undefined): UpgradeRefusal {
  switch (code) {
    case "remote_upgrade_disabled":
      return "web_upgrade_off";
    case "computer_remote_upgrade_unsupported":
      return "too_old";
    case "computer_broadcast_not_eligible":
      return "not_allowed";
    default:
      return "unknown";
  }
}
type CommandCopyTarget =
  | "computer-install"
  | "computer-setup"
  | "computer-install-restart"
  | "terminal-status"
  | "terminal-doctor"
  | "terminal-restart";

function WorkspacesSection({ machineId, canManageMachines }: { machineId: string; canManageMachines: boolean }) {
  const { formatDate, formatMessage } = useIntl();
  const scanMachineWorkspaces = useMachineStore((s) => s.scanMachineWorkspaces);
  const deleteMachineWorkspace = useMachineStore((s) => s.deleteMachineWorkspace);
  const workspaces = useMachineStore((s) => s.machineWorkspaces[machineId]) ?? EMPTY_WORKSPACES;
  const loading = useMachineStore((s) => s.machineWorkspacesLoading[machineId]) ?? false;
  const [scanned, setScanned] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const deleteEntry = deleteTarget
    ? workspaces.find((w: MachineWorkspaceEntry) => w.directoryName === deleteTarget)
    : null;

  const handleScan = async () => {
    await scanMachineWorkspaces(machineId);
    setScanned(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await deleteMachineWorkspace(machineId, deleteTarget);
    setDeleteTarget(null);
  };

  const formatWorkspaceStatus = (status: MachineWorkspaceEntry["status"]) => {
    switch (status) {
      case "active":
        return formatMessage({ id: "machine.detail.workspaceStatus.active" });
      case "stopped":
        return formatMessage({ id: "machine.detail.workspaceStatus.stopped" });
      case "deleted":
        return formatMessage({ id: "machine.detail.workspaceStatus.deleted" });
      case "orphan":
        return formatMessage({ id: "machine.detail.workspaceStatus.orphan" });
      default:
        return status;
    }
  };

  const sortedWorkspaces = [...workspaces].sort((a: MachineWorkspaceEntry, b: MachineWorkspaceEntry) => {
    const order: Record<string, number> = { orphan: 0, deleted: 1, stopped: 2, active: 3 };
    return (order[a.status] ?? 3) - (order[b.status] ?? 3);
  });

  const orphanCount = workspaces.filter((w: MachineWorkspaceEntry) => w.status === "orphan").length;
  const deletedCount = workspaces.filter((w: MachineWorkspaceEntry) => w.status === "deleted").length;

  return (
    <div>
      <SectionHeader
        className="mb-2"
        icon={<FolderOpen size={14} className="text-foreground-strong theme-brutal:text-black" />}
        label={formatMessage({ id: "machine.detail.agentWorkspaces" })}
        action={
          <Button size="sm"
            variant="outline"
            onClick={handleScan}
            disabled={loading}
            className="px-2 py-1 text-xs flex items-center gap-1"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            {loading
              ? formatMessage({ id: "machine.detail.scanning" })
              : scanned
                ? formatMessage({ id: "machine.detail.rescan" })
                : formatMessage({ id: "machine.detail.scan" })}
          </Button>
        }
      />

      {!scanned && !loading && (
        <div className="text-xs text-foreground-muted theme-brutal:text-black/40 italic">
          {formatMessage({ id: "machine.detail.workspacesPrompt" })}
        </div>
      )}

      {scanned && workspaces.length === 0 && (
        <div className="text-xs text-foreground-muted theme-brutal:text-black/40 italic">
          {formatMessage({ id: "machine.detail.noWorkspaceDirectories" })}
        </div>
      )}

      {scanned && orphanCount > 0 && (
        <Banner intent="warning" density="sm" className="mb-2">
          {formatMessage(
            { id: "machine.detail.orphanWorkspaceBanner" },
            { count: orphanCount, strong: (chunks) => <strong key="strong">{chunks}</strong> },
          )}
        </Banner>
      )}

      {scanned && deletedCount > 0 && (
        <div className="mb-2 border-2 border-line-muted theme-brutal:border-black bg-fill-muted theme-brutal:bg-gray-200 px-3 py-2 text-xs text-foreground-strong theme-brutal:text-black">
          {formatMessage(
            { id: "machine.detail.deletedWorkspaceBanner" },
            { count: deletedCount, strong: (chunks) => <strong key="strong">{chunks}</strong> },
          )}
        </div>
      )}

      {sortedWorkspaces.length > 0 && (
        <div className="space-y-1.5">
          {sortedWorkspaces.map((ws: MachineWorkspaceEntry) => (
            <div
              key={ws.directoryName}
              className={`flex items-center gap-2 border-2 px-3 py-2 ${
 ws.status === "orphan"
 ? "border-warning bg-warning-soft theme-brutal:border-brutal-orange theme-brutal:bg-brutal-orange/10"
 : ws.status === "deleted"
 ? "border-line-muted bg-fill-muted theme-brutal:border-black theme-brutal:bg-gray-100"
 : "border-line-muted theme-brutal:border-black/30"
 }`}
            >
              <FolderOpen size={14} className="shrink-0 text-foreground-muted theme-brutal:text-black/40" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-xs text-foreground-strong theme-brutal:text-black truncate">
                    {ws.agentName || ws.directoryName}
                  </span>
                  <Badge uppercase variant={ws.status === "active" ? "success" : ws.status === "orphan" ? "warning" : "muted"}>
                    {formatWorkspaceStatus(ws.status)}
                  </Badge>
                </div>
                <div className="mt-0.5 text-[10px] text-foreground-muted theme-brutal:text-black/40 font-mono break-all">
                  ~/.slock/agents/{ws.directoryName}/
                </div>
                {ws.status === "deleted" && (
                  <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-foreground-muted theme-brutal:text-black/60">
                    {formatMessage({ id: "machine.detail.agentDeletedWorkspaceRetained" })}
                  </div>
                )}
                {ws.status === "orphan" && (
                  <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-brutal-orange">
                    {formatMessage({ id: "machine.detail.noMatchingAgentRecord" })}
                  </div>
                )}
                <div className="flex items-center gap-3 mt-0.5 text-[10px] text-foreground-muted theme-brutal:text-black/50 font-mono">
                  <span>{formatFileSizeBytes(ws.totalSizeBytes, formatMessage)}</span>
                  <span>{formatMessage({ id: "machine.detail.fileCount" }, { count: ws.fileCount })}</span>
                  <span>
                    {formatMessage(
                      { id: "machine.detail.modifiedDate" },
                      {
                        date: formatDate(ws.lastModified, {
                          month: "short",
                          day: "numeric",
                        }),
                      },
                    )}
                  </span>
                </div>
              </div>
              {canManageMachines && (
                <Tooltip content={formatMessage({ id: "machine.detail.deleteWorkspace" })}>
                <Button size="sm"
                  variant="danger"
                  onClick={() => setDeleteTarget(ws.directoryName)}
                  className="shrink-0 p-1"
                  aria-label={formatMessage({ id: "machine.detail.deleteWorkspace" })}
                >
                  <Trash2 size={12} />
                </Button>
                </Tooltip>
              )}
            </div>
          ))}
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={formatMessage({ id: "machine.detail.deleteWorkspaceTitle" })}
          message={formatMessage(
            { id: "machine.detail.deleteWorkspaceMessage" },
            { name: deleteEntry?.agentName || deleteTarget },
          )}
          confirmLabel={formatMessage({ id: "machine.detail.deleteWorkspaceTitle" })}
          loadingLabel={formatMessage({ id: "machine.detail.deleting" })}
          onConfirm={handleDelete}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

// Isolated component — subscribes to current display-state projections only for agents on this machine,
// preventing activity changes from re-rendering the entire MachineDetailPanel.
function MachineAgentList({ machine, canManageMachines }: { machine: Machine; canManageMachines: boolean }) {
  const { formatMessage } = useIntl();
  const allAgents = useAgentStore((s) => s.agents);
  const startAgent = useAgentStore((s) => s.startAgent);
  const stopAgent = useAgentStore((s) => s.stopAgent);
  const resetAgent = useAgentStore((s) => s.resetAgent);
  const nav = useAppNavigate();
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(() => new Set());
  const [bulkAction, setBulkAction] = useState<"start" | "stop" | "restart" | "session" | "full" | null>(null);
  const [bulkError, setBulkError] = useState("");
  const [showResetOptions, setShowResetOptions] = useState(false);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [bulkResetMode, setBulkResetMode] = useState<"restart" | "session" | "full">("restart");

  const machineAgents = allAgents.filter((a) => !a.deletedAt && a.machineId === machine.id);
  // Subscribe via the store's named stable slice selector and compute display
  // states in render. Building this map inside a store selector returned
  // fresh objects per snapshot -> useShallow never equal -> React #185
  // (2026-07-07 prod incident). The slice values are store-held objects, so
  // this subscription only fires on real activity changes.
  const activitiesSlice = useAgentStore(selectAgentActivitiesSlice);
  const displayStateFor = (agent: (typeof machineAgents)[number]) =>
    computeAgentDisplayState(allAgents, activitiesSlice, agent.id, agent);
  const selectedAgents = machineAgents.filter((a) => selectedAgentIds.has(a.id));
  const selectedOfflineAgents = selectedAgents.filter((a) => !displayStateFor(a).isOnline);
  const selectedOnlineAgents = selectedAgents.filter((a) => displayStateFor(a).isOnline);
  const machineAgentIdKey = machineAgents.map((a) => a.id).join("\0");
  const selectedCount = selectedAgents.length;
  const allSelected = machineAgents.length > 0 && selectedCount === machineAgents.length;
  const canStartLike = machine.status === "online";
  const bulkResetOptions: {
    mode: "restart" | "session" | "full";
    label: string;
    desc: string;
    selectedClass: string;
  }[] = [
    {
      mode: "restart",
      label: formatMessage({ id: "machine.detail.bulkRestart" }),
      desc: formatMessage({ id: "machine.detail.bulkRestartDescription" }),
      selectedClass: "border-line-muted theme-brutal:border-black bg-info-soft theme-brutal:bg-brutal-cyan/20 theme-brutal:shadow-brutal-sm",
    },
    {
      mode: "session",
      label: formatMessage({ id: "machine.detail.bulkResetSession" }),
      desc: formatMessage({ id: "machine.detail.bulkResetSessionDescription" }),
      selectedClass: "border-line-muted theme-brutal:border-black bg-warning-soft theme-brutal:bg-brutal-orange/20 theme-brutal:shadow-brutal-sm",
    },
    {
      mode: "full",
      label: formatMessage({ id: "machine.detail.bulkFullReset" }),
      desc: formatMessage({ id: "machine.detail.bulkFullResetDescription" }),
      selectedClass: "border-line-muted theme-brutal:border-black bg-danger-soft theme-brutal:bg-brutal-red/20 theme-brutal:shadow-brutal-sm",
    },
  ];

  // oxlint-disable react-hooks/exhaustive-deps -- reconcile the selection against the current agent set keyed by the stable `machineAgentIdKey`; depending on the `machineAgents` array (a fresh ref every render) would re-run every render.
  // `selectedAgentIds` is a user-driven multi-select Set; this effect cleans
  // stale ids when the underlying agent set shrinks (socket-pushed). The
  // functional updater reads `current` and computes the next Set against
  // `validIds` — NOT a mirror-prop pattern (no single source prop), it's a
  // stale-cleanup. react-doctor's no-derived-state suggested fix
  // (compute during render) can't express "drop ids that have disappeared
  // since last user selection."
  useEffect(() => {
    const validIds = new Set(machineAgents.map((a) => a.id));
    // oxlint-disable-next-line react-doctor/no-derived-state
    setSelectedAgentIds((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of current) {
        if (validIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [machineAgentIdKey]);
  // oxlint-enable react-hooks/exhaustive-deps

  const toggleAgentSelection = (agentId: string) => {
    setSelectedAgentIds((current) => {
      const next = new Set(current);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const selectAllAgents = () => {
    setSelectionMode(true);
    setSelectedAgentIds(new Set(machineAgents.map((a) => a.id)));
  };

  const clearSelection = () => {
    setSelectionMode(false);
    setSelectedAgentIds(new Set());
    setBulkError("");
  };

  const runBulkAction = async (action: "start" | "stop" | "restart" | "session" | "full") => {
    const targets =
      action === "start"
        ? selectedOfflineAgents
        : action === "stop"
          ? selectedOnlineAgents
          : selectedAgents;
    if (targets.length === 0) return;

    setBulkAction(action);
    setBulkError("");
    try {
      const results = await Promise.allSettled(
        targets.map((agent) => {
          if (action === "start") return startAgent(agent.id);
          if (action === "stop") return stopAgent(agent.id);
          return resetAgent(agent.id, action);
        })
      );
      const failed = results.filter((result) => result.status === "rejected").length;
      if (failed > 0) {
        setBulkError(formatMessage({ id: "machine.detail.bulkActionFailed" }, { failed, total: targets.length }));
      } else {
        clearSelection();
        setShowResetOptions(false);
      }
    } finally {
      setBulkAction(null);
    }
  };

  return (
    <>
      <div>
        <SectionHeader
          className="mb-3 flex-wrap gap-y-2"
          label={formatMessage({ id: "machine.detail.agentsOnComputer" })}
          count={machineAgents.length}
          action={
            <div className="flex items-center gap-1.5">
              {canManageMachines && machineAgents.length > 0 && (
                selectionMode ? (
                  <>
                    <Button size="sm"
                      variant="outline"
                      type="button"
                      onClick={allSelected ? () => setSelectedAgentIds(new Set()) : selectAllAgents}
                      className="px-2 py-1 text-xs flex items-center gap-1"
                    >
                      <Check size={12} />
                      {allSelected
                        ? formatMessage({ id: "machine.detail.clearAll" })
                        : formatMessage({ id: "machine.detail.selectAll" })}
                    </Button>
                    <Button size="sm"
                      variant="outline"
                      type="button"
                      onClick={clearSelection}
                      className="px-2 py-1 text-xs flex items-center gap-1"
                    >
                      <X size={12} />
                      {formatMessage({ id: "common.confirm.cancel" })}
                    </Button>
                  </>
                ) : (
                  <Button size="sm"
                    variant="outline"
                    type="button"
                    onClick={() => setSelectionMode(true)}
                    className="px-2 py-1 text-xs flex items-center gap-1"
                  >
                    <Check size={12} />
                    {formatMessage({ id: "machine.detail.select" })}
                  </Button>
                )
              )}
              {canManageMachines && !selectionMode && (
                <Button size="sm"
                  variant="accent"
                  onClick={() => {
                    trackAgentCreateOpened("computer_detail");
                    setShowCreateAgent(true);
                  }}
                  className="px-2 py-1 text-xs flex items-center gap-1"
                >
                  <Plus size={12} />
                  {formatMessage({ id: "machine.detail.create" })}
                </Button>
              )}
            </div>
          }
        />
        {machineAgents.length === 0 ? (
          <div className="text-sm text-foreground-muted theme-brutal:text-black/40 italic">
            {formatMessage({ id: "machine.detail.noAgentsAssigned" })}
          </div>
        ) : (
          <div className="space-y-2">
            {canManageMachines && selectedCount > 0 && (
              <SurfaceListItem selected interactive={false} className="bg-layer-canvas-muted px-3 py-2 theme-brutal:bg-gray-100">
                <div className="flex flex-wrap items-center gap-2">
                  <SectionEyebrow className="mr-auto !text-foreground-strong theme-brutal:text-black">
                    {formatMessage({ id: "machine.detail.selectedCount" }, { count: selectedCount })}
                  </SectionEyebrow>
                  <Tooltip content={
                      !canStartLike
                        ? formatMessage({ id: "machine.detail.mustBeOnlineToStartAgents" })
                        : formatMessage({ id: "machine.detail.startSelectedOfflineAgents" })
                    }>
                  <Button size="sm"
                    variant="success"
                    type="button"
                    onClick={() => runBulkAction("start")}
                    disabled={bulkAction !== null || selectedOfflineAgents.length === 0 || !canStartLike}
                    className="flex items-center gap-1 px-2 py-1 text-xs disabled:cursor-not-allowed theme-brutal:disabled:bg-gray-200"
                  >
                    <Play size={12} />
                    {bulkAction === "start"
                      ? formatMessage({ id: "machine.detail.starting" })
                      : formatMessage({ id: "machine.detail.start" })}
                  </Button>
                  </Tooltip>
                  <Tooltip content={formatMessage({ id: "machine.detail.stopSelectedOnlineAgents" })}>
                  <Button size="sm"
                    variant="outline"
                    type="button"
                    onClick={() => setShowStopConfirm(true)}
                    disabled={bulkAction !== null || selectedOnlineAgents.length === 0}
                    className="flex items-center gap-1 px-2 py-1 text-xs disabled:cursor-not-allowed theme-brutal:disabled:bg-gray-200"
                  >
                    <Square size={12} />
                    {formatMessage({ id: "machine.detail.stop" })}
                  </Button>
                  </Tooltip>
                  <Tooltip content={
                      !canStartLike
                        ? formatMessage({ id: "machine.detail.mustBeOnlineToRestartAgents" })
                        : formatMessage({ id: "machine.detail.restartOrResetSelectedAgents" })
                    }>
                  <Button size="sm"
                    variant="outline"
                    type="button"
                    onClick={() => setShowResetOptions(true)}
                    disabled={bulkAction !== null || !canStartLike}
                    className="flex items-center gap-1 px-2 py-1 text-xs disabled:cursor-not-allowed theme-brutal:disabled:bg-gray-200"
                  >
                    <RotateCcw size={12} />
                    {formatMessage({ id: "machine.detail.restartReset" })}
                  </Button>
                  </Tooltip>
                </div>
                {bulkError && (
                  <Banner intent="warning" density="sm" className="mt-2 font-bold">
                    {bulkError}
                  </Banner>
                )}
              </SurfaceListItem>
            )}
            {machineAgents.map((agent) => {
              const displayState = displayStateFor(agent);
              // A Computer page is where these agent identities are managed:
              // show the model alongside the runtime (artin 2026-09-27), not
              // only the chat-side "Show agent model" preference.
              const agentIdentityLabel = [
                formatRuntimeLabelWithStatus(agent.runtime, formatMessage),
                agentModelLabel(agent),
              ].filter(Boolean).join(" · ");
              const activityText = formatActivityText(
                formatMessage,
                displayState.activity,
                displayState.activityDetail,
                displayState.activityDetailKind,
              );
              const selected = selectedAgentIds.has(agent.id);
              const avatar = <AvatarSlot context="surface-list" type="agent" agentAvatarUrl={agent.avatarUrl} />;
              const rightStatus = (
                <>
                  <StatusDot activity={displayState.activity} title={activityText} />
                  <Tooltip content={activityText}><span
                    className="hidden max-w-[min(32rem,42vw)] truncate align-middle text-xs font-mono text-foreground-muted theme-brutal:text-black/50 sm:inline-block"
                  >
                    {activityText}
                  </span></Tooltip>
                </>
              );
              if (selectionMode) {
                // Selection mode adds a leading CheckMarker column that
                // is outside AvatarListRow's slot contract. Keep the inline
                // SurfaceListItem here — the row body still mirrors the
                // primitive's avatar / name / subtitle / rightContent layout
                // so the visual is identical to the normal-mode AvatarListRow.
                return (
                  <SurfaceListItem
                    key={agent.id}
                    selected={canManageMachines && selected}
                    className={`group px-3 py-2 ${selected ? "" : "bg-layer-canvas-muted hover:bg-layer-panel theme-brutal:bg-gray-100 theme-brutal:hover:bg-white"}`}
                  >
                    <Tooltip content={
                        selected
                          ? formatMessage({ id: "machine.detail.deselectAgent" })
                          : formatMessage({ id: "machine.detail.selectAgent" })
                      }>
                    <button
                      type="button"
                      onClick={() => toggleAgentSelection(agent.id)}
                      className="flex w-full min-w-0 items-center gap-3 text-left"
                      aria-label={
                        selected
                          ? formatMessage({ id: "machine.detail.deselectAgentName" }, { name: agent.displayName || agent.name })
                          : formatMessage({ id: "machine.detail.selectAgentName" }, { name: agent.displayName || agent.name })
                      }
                    >
                      <CheckMarker
                        checked={selected}
                        size="lg"
                        tone="yellow-fill"
                        previewOnHover
                        className="mt-0"
                      />
                      {avatar}
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                          <span className="truncate text-sm font-bold text-foreground-strong theme-brutal:text-black">
                            {agent.displayName || agent.name}
                          </span>
                          <span className="text-xs font-mono text-foreground-muted theme-brutal:text-black/50">
                            {agentIdentityLabel}
                          </span>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">{rightStatus}</div>
                    </button>
                    </Tooltip>
                  </SurfaceListItem>
                );
              }
              return (
                <AvatarListRow
                  key={agent.id}
                  avatar={avatar}
                  name={agent.displayName || agent.name}
                  subtitle={agentIdentityLabel}
                  rightContent={rightStatus}
                  onClick={() => nav.toAgent(agent.id)}
                  selected={false}
                  className="bg-layer-canvas-muted hover:bg-layer-panel theme-brutal:bg-gray-100 theme-brutal:hover:bg-white"
                />
              );
            })}
          </div>
        )}
      </div>

      {canManageMachines && showCreateAgent && (
        <CreateAgentDialog
          defaultMachineId={machine.id}
          onClose={() => setShowCreateAgent(false)}
        />
      )}

      {showResetOptions && (
        <DialogCard title={formatMessage({ id: "machine.detail.restartAgentCount" }, { count: selectedCount })} onClose={() => setShowResetOptions(false)}>
            <div className="space-y-3">
              {bulkResetOptions.map((opt) => (
                <Card
                  key={opt.mode}
                  render={<button type="button" aria-pressed={bulkResetMode === opt.mode} disabled={bulkAction !== null} />}
                  onClick={() => setBulkResetMode(opt.mode)}
                  className={`w-full theme-brutal:border-2 p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
 bulkResetMode === opt.mode
 ? opt.selectedClass
 : "border-line-muted theme-brutal:border-black/30 bg-layer-panel theme-brutal:bg-white hover:border-line-strong theme-brutal:hover:border-black"
 }`}
                >
                  <div className="text-sm font-bold uppercase">{opt.label}</div>
                  <p className="mt-1 text-xs text-foreground-muted theme-brutal:text-black/60">{opt.desc}</p>
                </Card>
              ))}
            </div>
            {bulkResetMode === "full" && (
              <Banner intent="warning" density="sm" withIcon className="mt-3 font-bold">
                {formatMessage({ id: "machine.detail.fullResetWarning" })}
              </Banner>
            )}
            <div className="mt-5 flex justify-end gap-3">
              <Button size="sm"
                variant="outline"
                type="button"
                onClick={() => setShowResetOptions(false)}
                className="px-4 py-2 text-sm"
              >
                {formatMessage({ id: "common.confirm.cancel" })}
              </Button>
              <Button size="sm"
                variant={bulkResetMode === "full" ? "danger" : bulkResetMode === "session" ? "warning" : "information"}
                type="button"
                onClick={() => runBulkAction(bulkResetMode)}
                disabled={bulkAction !== null}
                className="flex items-center gap-1.5 px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
              >
                <RotateCcw size={14} />
                {bulkAction
                  ? formatMessage({ id: "machine.detail.restarting" })
                  : bulkResetOptions.find((opt) => opt.mode === bulkResetMode)!.label}
              </Button>
            </div>
        </DialogCard>
      )}

      {showStopConfirm && (
        <ConfirmDialog
          title={formatMessage({ id: "machine.detail.stopAgentsTitle" })}
          message={formatMessage({ id: "machine.detail.stopAgentsMessage" }, { count: selectedOnlineAgents.length })}
          confirmLabel={formatMessage({ id: "machine.detail.stopAgentsTitle" })}
          loadingLabel={formatMessage({ id: "machine.detail.stopping" })}
          confirmColor="bg-brutal-orange"
          onConfirm={() => runBulkAction("stop")}
          onClose={() => setShowStopConfirm(false)}
        />
      )}
    </>
  );
}

export default function MachineDetailPanel({
  machine,
  workspaceEmbedded = false,
  deploymentEnv = import.meta.env?.VITE_DEPLOYMENT_ENV,
}: {
  machine: Machine;
  workspaceEmbedded?: boolean;
  deploymentEnv?: string;
}) {
  const { formatDate, formatMessage, locale } = useIntl();
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const deleteMachine = useMachineStore((s) => s.deleteMachine);
  const renameMachine = useMachineStore((s) => s.renameMachine);
  const updateMachineDetails = useMachineStore((s) => s.updateMachineDetails);
  const latestComputerVersion = useMachineStore((s) => s.latestComputerVersion);
  const latestComputerReleaseNotes = useMachineStore((s) => s.latestComputerReleaseNotes);
  // "Is it up to date" is the web's own comparison with the latest published
  // version, independent of whether web upgrade is switched on.
  const computerVersionFact = getComputerVersionFact(machine, latestComputerVersion);
  const diskLow = machineDiskLowPresentation(machine, formatMessage);
  // "What's new" follows the "v… available" hint, with or without an
  // Upgrade button (artin). Online: in the action row. Offline (no action
  // row): beside the hint. Display only; not gated by remote_computer_upgrade_v2.
  // Only notes for exactly the version the page offers (the policy's upgrade
  // target when it has one, else the latest published version). Shared by
  // both placements so the offline one can't show mismatched notes.
  const releaseNotesForUpdate = computerVersionFact.kind === "outdated"
    && latestComputerReleaseNotes
    && latestComputerReleaseNotes.version === computerVersionFact.availableVersion
    ? latestComputerReleaseNotes
    : null;
  const openProfile = useProfileStore((s) => s.openProfile);
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const allAgents = useAgentStore((s) => s.agents);
  const { capabilities } = useServerPermissions();
  const machineAgents = allAgents.filter((a) => !a.deletedAt && a.machineId === machine.id);
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const serverSlug = useServerStore((s) => s.current?.slug);
  const onMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}/settings` : "/");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // Collapsed-by-default install/setup fallback on the offline Computer
  // recovery card. The primary path remains start/status/doctor, while this
  // plainly labelled escape hatch also works when the binary is not installed.
  const [showRecoverySetup, setShowRecoverySetup] = useState(false);
  const [recoveryGuideContext, setRecoveryGuideContext] = useState<{
    machineId: string;
    status: Machine["status"];
  }>({ machineId: machine.id, status: machine.status });
  const [recoveryGuideDisclosure, setRecoveryGuideDisclosure] = useState<boolean | null>(null);
  const recoveryGuideContentId = `computer-recovery-guide-content-${useId()}`;
  if (recoveryGuideContext.machineId !== machine.id || recoveryGuideContext.status !== machine.status) {
    setRecoveryGuideContext({ machineId: machine.id, status: machine.status });
    setRecoveryGuideDisclosure(null);
  }
  const [copiedCommand, setCopiedCommand] = useState<CommandCopyTarget | null>(null);
  const [editingName, setEditingName] = useState(false);
  // Per-machine Computer operation progress (upgrade/restart) — from machineStore.
  // oxlint-disable-next-line react-doctor/no-event-handler -- per-machine hot-slice selector mandated by the Render-cost contract (docs/frontend/render-cost-contract.md): it must close over the machine.id prop to subscribe to ONLY this machine's progress entry. Subscribing to the whole computerOperationProgress record to avoid the prop would re-render this panel on every machine's progress change — the exact cost the contract forbids. Heuristic false positive, YMNNE-family.
  const computerOperationProgress = useMachineStore((s) => s.computerOperationProgress[machine.id] ?? null);
  const setComputerOperation = useMachineStore((s) => s.setComputerOperation);
  // draftName is only read while editingName=true. handleStartRename seeds
  // it from machine.name before flipping editingName, so an empty initial
  // value never reaches the rendered input. Initializing with the prop
  // would freeze the mirror on first mount and is what react-doctor's
  // no-derived-useState guards against.
  const [draftName, setDraftName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [editingDescription, setEditingDescription] = useState(false);
  const [draftDescription, setDraftDescription] = useState("");
  const [savingDescription, setSavingDescription] = useState(false);
  const [descriptionError, setDescriptionError] = useState("");
  const descriptionInputRef = useRef<HTMLTextAreaElement>(null);

  const serverUrl = getServerUrl();
  const savedKey = localStorage.getItem(`slock_machine_apikey_${machine.id}`);
  // Validate cached key against server's apiKeyPrefix to detect stale keys
  const isKeyValid = savedKey && machine.apiKeyPrefix && savedKey.startsWith(machine.apiKeyPrefix);
  if (savedKey && !isKeyValid) {
    localStorage.removeItem(`slock_machine_apikey_${machine.id}`);
  }
  const setupMachineId = machine.isComputer ? null : machine.id;
  const computerCommands = getComputerCommands(serverSlug, deploymentEnv, serverUrl, {
    legacyApiKey: isKeyValid ? savedKey : null,
    // Identity-carried migration (task #239): this page knows WHICH row the
    // computer is, so the setup command adopts it directly (--machine <id>) —
    // no fingerprint matching, works after key rotation. Legacy rows only;
    // Computer rows keep the plain setup command.
    machineId: setupMachineId,
  });
  const windowsMachine = machine.os?.toLowerCase().startsWith("win") ?? false;
  const windowsComputerCommands = getComputerCommands(serverSlug, deploymentEnv, serverUrl, {
    legacyApiKey: isKeyValid ? savedKey : null,
    machineId: setupMachineId,
    platform: "windows",
  });
  const computerFreshInstallCommands = getComputerCommands(serverSlug, deploymentEnv, serverUrl, {
    legacyApiKey: isKeyValid ? savedKey : null,
    machineId: setupMachineId,
    // No version pin: the installer resolves the latest release itself, and a
    // pin copied from a page opened before a release would install the older one.
    platform: windowsMachine ? "windows" : "mac-linux",
  });
  const machineComputerCommands = windowsMachine ? windowsComputerCommands : computerCommands;
  const computerSetupCommand = machineComputerCommands?.setup ?? null;
  const computerInstall = machineComputerCommands?.install ?? null;
  const computerFreshInstall = computerFreshInstallCommands?.install ?? null;
  const computerInstallRestartCommand = computerFreshInstallCommands?.restartService ?? null;
  // Address recovery to the current server. Restart handles both local
  // failure shapes the server sees as "offline": a stopped service (stop is
  // a no-op, then start) and a live runner whose server connection is stuck.
  // The CLI's supervisor restart can cycle other managed runners in the same
  // home; taking this from the command bundle keeps staging/slockdev on their
  // per-server RAFT_HOME + binary path.
  const computerRecoveryRestartCommand = machineComputerCommands?.restart ?? null;
  const terminalStatusCommands = machineComputerCommands
    ? [
        { command: machineComputerCommands.status, target: "terminal-status" as const },
        { command: machineComputerCommands.doctor, target: "terminal-doctor" as const },
      ]
    : [];
  const terminalRestartCommand = machineComputerCommands?.restart ?? null;
  // A user choice applies only to the current machine + current health state.
  // When either changes, fall back to the product default immediately: healthy
  // Computers stay collapsed, while an offline Computer exposes recovery.
  const showRecoveryGuide = recoveryGuideDisclosure ?? machine.status !== "online";
  const canManageMachines = machine.computerAttachedByCurrentUser === true
    || (currentUserId !== null && machine.creator?.id === currentUserId)
    || [
    capabilities.editMachines,
    capabilities.controlComputers,
    capabilities.removeMachines,
    capabilities.rotateMachineKeys,
    capabilities.createAgents,
    capabilities.migrateAgents,
    ].some(Boolean);
  const canViewRuntimeAccountUsage = canViewMachineRuntimeAccountUsage(machine, currentUserId, capabilities);
  const handleDelete = async () => {
    await deleteMachine(machine.id);
    setShowDeleteConfirm(false);
  };

  const handleCopy = (target: CommandCopyTarget) => {
    setCopiedCommand(target);
    setTimeout(() => {
      setCopiedCommand((current) => (current === target ? null : current));
    }, 2000);
  };



  // Remote Computer controls (managed Computer only). The server relays
  // a command to the machine's live connection, which forwards it to the
  // Computer service IPC (restart = restart-service). Remote upgrade v2 is a
  // request row settled by the machine's reconnect; see handleRemoteUpgradeV2.
  // Restart uses an indeterminate bar until the machine comes back online.
  const remoteUpgradeV2Enabled = useServerFeatureFlag(REMOTE_COMPUTER_UPGRADE_V2_FLAG_KEY).enabled;
  const upgradeRequest = machine.upgradeRequest ?? null;
  const upgradePending = upgradeRequest?.state === "pending";
  // Below the first v2-capable Computer release (or version unknown) the web
  // cannot drive the upgrade; the same fail-closed shape as the server guard.
  const remoteUpgradeSupported = (machine.remoteUpgradeSupported ?? isRemoteUpgradeSupported(machine.computerVersion)) === true;
  // A refused Upgrade click holds only while every live input that decides
  // whether the one-click upgrade is offered stays the same as when it was
  // refused: this machine and version, the web-upgrade flag, the server's
  // policy (eligibility, reason, revision, target) and whether this version
  // supports remote upgrade. The first change drops it for good (also when a
  // later snapshot matches the refused one again, e.g. a release lookup that
  // failed briefly and recovered), so the card follows the live answer.
  const upgradeAvailabilityKey = JSON.stringify([
    machine.id,
    machine.computerVersion ?? null,
    remoteUpgradeV2Enabled,
    remoteUpgradeSupported,
    machine.computerUpgradeAvailable ?? null,
    machine.computerBroadcastPolicy?.eligibility ?? null,
    machine.computerBroadcastPolicy?.reasonCode ?? null,
    machine.computerBroadcastPolicy?.policyRevision ?? null,
    machine.computerBroadcastPolicy?.targetVersion ?? null,
  ]);
  const [upgradeRefusalState, setUpgradeRefusalState] = useState<{
    availabilityKey: string;
    refusal: UpgradeRefusal;
  } | null>(null);
  if (upgradeRefusalState && upgradeRefusalState.availabilityKey !== upgradeAvailabilityKey) {
    setUpgradeRefusalState(null);
  }
  const upgradeRefusal = upgradeRefusalState?.availabilityKey === upgradeAvailabilityKey
    ? upgradeRefusalState.refusal
    : null;
  const handleRemoteUpgradeV2 = async () => {
    const serverId = useServerStore.getState().current?.id;
    const consentedTargetVersion = machine.computerBroadcastPolicy?.targetVersion ?? null;
    if (!serverId || !consentedTargetVersion) return;
    setUpgradeRefusalState(null);
    try {
      await api.post(
        `/servers/${serverId}/machines/${machine.id}/computer/upgrade`,
        { targetVersion: consentedTargetVersion },
        { headers: { "X-Server-Id": serverId } },
      );
    } catch (err) {
      const code = (err as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
      setUpgradeRefusalState({
        availabilityKey: upgradeAvailabilityKey,
        refusal: upgradeRefusalFromCode(typeof code === "string" ? code : undefined),
      });
    } finally {
      void useMachineStore.getState().loadMachines();
    }
  };
  const handleComputerRestart = async () => {
    const serverId = useServerStore.getState().current?.id;
    if (!serverId) return;
    // Optimistically enter progress state before the POST returns.
    setComputerOperation(machine.id, { operation: "restart" });
    try {
      const { data } = await api.post(
        `/servers/${serverId}/machines/${machine.id}/computer/restart`,
        {},
        { headers: { "X-Server-Id": serverId } },
      );
      const requestId = (data as { requestId?: string })?.requestId;
      if (requestId) {
        setComputerOperation(machine.id, { operation: "restart", requestId });
      }
    } catch (err) {
      const errorData = (err as { response?: { data?: { code?: string; error?: string } } })?.response?.data;
      const code = errorData?.code;
      const serverError = typeof errorData?.error === "string" && errorData.error.trim().length > 0
        ? errorData.error
        : null;
      let errorMsg = serverError ?? formatMessage({ id: "machine.detail.restartRequestFailed" });
      if (code === "computer_offline") {
        errorMsg = formatMessage({ id: "machine.detail.computerOffline" });
      }
      setComputerOperation(machine.id, { operation: "restart", done: true, error: errorMsg });
      // Auto-clear error after 4s so the button reappears.
      setTimeout(() => setComputerOperation(machine.id, null), 4000);
    }
  };
  // Clear terminal operation state after a display pause.
  useEffect(() => {
    if (computerOperationProgress?.done) {
      const t = setTimeout(() => setComputerOperation(machine.id, null), 3000);
      return () => clearTimeout(t);
    }
  }, [computerOperationProgress?.done, machine.id, setComputerOperation]);

  // Safety timeout: if an operation is in progress but no WS frames arrive
  // (e.g. HTTP server down, daemon didn't receive the command), reset to
  // buttons after 60s so the user isn't stuck with no way to retry.
  useEffect(() => {
    if (computerOperationProgress && !computerOperationProgress.done) {
      const t = setTimeout(() => {
        setComputerOperation(machine.id, {
          ...computerOperationProgress,
          done: true,
          error: formatMessageRef.current({ id: "machine.detail.restartTimedOut" }),
        });
      }, 60_000);
      return () => clearTimeout(t);
    }
  }, [computerOperationProgress, machine.id, setComputerOperation]);

  const handleStartRename = () => {
    setDraftName(machine.name);
    setNameError("");
    setEditingName(true);
  };

  const handleSaveRename = async () => {
    const nextName = draftName.trim();
    if (!nextName) {
      setNameError(formatMessage({ id: "machine.detail.computerNameRequired" }));
      return;
    }
    if (nextName === machine.name) {
      setEditingName(false);
      setDraftName(machine.name);
      return;
    }
    setNameError("");
    setSavingName(true);
    try {
      await renameMachine(machine.id, nextName);
      setEditingName(false);
    } catch {
      setNameError(formatMessage({ id: "machine.detail.renameComputerFailed" }));
    } finally {
      setSavingName(false);
    }
  };

  const handleCancelRename = () => {
    setDraftName(machine.name);
    setNameError("");
    setEditingName(false);
  };

  const handleStartEditDescription = () => {
    setDraftDescription(machine.description ?? "");
    setDescriptionError("");
    setEditingDescription(true);
  };

  const handleSaveDescription = async () => {
    const nextDescription = draftDescription.trim();
    if (nextDescription.length > 500) {
      setDescriptionError(formatMessage({ id: "machine.detail.descriptionTooLong" }));
      return;
    }
    const currentDescription = machine.description ?? "";
    if (nextDescription === currentDescription) {
      setEditingDescription(false);
      setDraftDescription(currentDescription);
      return;
    }
    setDescriptionError("");
    setSavingDescription(true);
    try {
      await updateMachineDetails(machine.id, { description: nextDescription || null });
      setEditingDescription(false);
    } catch {
      setDescriptionError(formatMessage({ id: "machine.detail.updateDescriptionFailed" }));
    } finally {
      setSavingDescription(false);
    }
  };

  const handleCancelDescription = () => {
    setDraftDescription(machine.description ?? "");
    setDescriptionError("");
    setEditingDescription(false);
  };

  const createdDate = formatDate(machine.createdAt, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const lastHeartbeatText = formatRelativeTime(machine.lastHeartbeat, locale);
  const lastHeartbeatParenthetical = lastHeartbeatText
    ? formatMessage({ id: "machine.detail.lastSeenParenthetical" }, { time: lastHeartbeatText })
    : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!workspaceEmbedded && (
        <PanelHeader
          title={machine.name}
          icon={<Monitor size={18} />}
          iconBg="bg-primary-soft theme-brutal:bg-soft-signal text-foreground-strong theme-brutal:text-black"
          iconAlwaysVisible
          onMobileBack={onMobileBack}
          mobileBackProps={{
            "data-testid": "machine-mobile-back",
            title: formatMessage({ id: "common.announcement.back" }),
          }}
        />
      )}

      <div className="flex-1 overflow-y-auto bg-layer-panel theme-brutal:bg-white">
        {/* Profile info — machine icon + name + status */}
        <div className="flex items-start gap-4 px-5 py-5 border-b border-line-muted theme-brutal:border-black/10">
          <Card className="flex size-16 shrink-0 items-center justify-center p-0"><Monitor size={28} />
          </Card>
          <div className="min-w-0 flex-1">
            <div className="min-w-0 truncate text-lg font-bold leading-tight text-foreground-strong theme-brutal:text-black">{machine.name}</div>
            <div className="flex min-w-0 items-center gap-2">
              <StatusDot
                tone={machine.status === "online" ? "bg-brutal-lime" : "bg-gray-400"}
                className="shrink-0"
              />
              <span className="shrink-0 text-sm text-foreground-muted theme-brutal:text-black/60 font-mono">
                {machine.status === "online"
                  ? formatMessage({ id: "machine.detail.connected" })
                  : formatMessage({ id: "machine.detail.offline" })}
              </span>
            </div>
            {machine.hostname && (
              <div className="truncate text-sm text-foreground-muted theme-brutal:text-black/50 font-mono">{machine.hostname}</div>
            )}
          </div>
        </div>

        {/* Host slot (desktop task #124): local controls for the machine the
            Electron shell runs on (start / stop / restart / reinstall the
            Computer service) are portaled in here by the desktop, so they live
            where every machine's actions live — the detail panel — instead of
            inside the sidebar row. Empty (zero-height) on the web. */}
        <div data-testid="machine-detail-local-slot" data-machine-id={machine.id} className="empty:hidden" />

        {diskLow && (
          <div className="px-5 pt-4">
            <Banner
              intent="warning"
              density="sm"
              title={formatMessage({ id: "machine.diskLow.bannerTitle" }, { free: diskLow.free, percent: diskLow.freePercent })}
              data-testid="machine-detail-disk-low"
            >
              {formatMessage({ id: "machine.diskLow.bannerBody" })}
            </Banner>
          </div>
        )}

        {/* Name */}
        <div className="px-5 py-4 border-b border-line-muted theme-brutal:border-black/10">
          <div className="flex items-center gap-2 mb-1">
            <SectionEyebrow as="div">
              {formatMessage({ id: "machine.detail.name" })}
            </SectionEyebrow>
            {canManageMachines && !editingName && (
              <Tooltip content={formatMessage({ id: "machine.detail.editComputerName" })}>
              <button
                type="button"
                onClick={handleStartRename}
                className="text-foreground-muted theme-brutal:text-black/40 hover:text-black transition-colors"
                aria-label={formatMessage({ id: "machine.detail.editComputerName" })}
              >
                <Pencil size={12} />
              </button>
              </Tooltip>
            )}
          </div>
          {canManageMachines && editingName ? (
            <div className="space-y-[5px]">
              <Input
                ref={nameInputRef}
                value={draftName}
                onChange={(e) => {
                  setDraftName(e.target.value.replace(/[\r\n]+/g, " "));
                  if (nameError) setNameError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleSaveRename();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    handleCancelRename();
                  }
                }}
                className="w-full text-sm"
                placeholder={formatMessage({ id: "machine.detail.computerName" })}
                autoFocus
                disabled={savingName}
              />
            <div className="flex items-center gap-1.5">
              <Button size="sm"
                  variant="accent"
                  onClick={() => void handleSaveRename()}
                  disabled={savingName}
                  className="px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {formatMessage({ id: "machine.detail.save" })}
                </Button>
                <Button size="sm"
                  variant="outline"
                  onClick={handleCancelRename}
                  disabled={savingName}
                  className="px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                >
                {formatMessage({ id: "common.confirm.cancel" })}
              </Button>
            </div>
            {nameError && (
              <div className="text-xs font-bold text-brutal-orange">
                {nameError}
              </div>
            )}
            </div>
          ) : (
            <p className="text-sm text-foreground-strong theme-brutal:text-black">{machine.name}</p>
          )}
        </div>

        {/* Description */}
        <div className="px-5 py-4 border-b border-line-muted theme-brutal:border-black/10">
          <div className="flex items-center gap-2 mb-1">
            <SectionEyebrow as="div">
              {formatMessage({ id: "machine.detail.description" })}
            </SectionEyebrow>
            {canManageMachines && !editingDescription && (
              <Tooltip content={formatMessage({ id: "machine.detail.editComputerDescription" })}>
              <button
                type="button"
                onClick={handleStartEditDescription}
                className="text-foreground-muted theme-brutal:text-black/40 hover:text-black transition-colors"
                aria-label={formatMessage({ id: "machine.detail.editComputerDescription" })}
              >
                <Pencil size={12} />
              </button>
              </Tooltip>
            )}
          </div>
          {canManageMachines && editingDescription ? (
            <div className="space-y-[5px]">
              <Textarea
                ref={descriptionInputRef}
                value={draftDescription}
                onChange={(e) => {
                  setDraftDescription(e.target.value);
                  if (descriptionError) setDescriptionError("");
                }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void handleSaveDescription();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    handleCancelDescription();
                  }
                }}
                className="min-h-20 w-full resize-y text-sm leading-relaxed"
                placeholder={formatMessage({ id: "machine.detail.descriptionPlaceholder" })}
                maxLength={500}
                autoFocus
                disabled={savingDescription}
              />
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <Button size="sm"
                    variant="accent"
                    onClick={() => void handleSaveDescription()}
                    disabled={savingDescription}
                    className="px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {formatMessage({ id: "machine.detail.save" })}
                  </Button>
                  <Button size="sm"
                    variant="outline"
                    onClick={handleCancelDescription}
                    disabled={savingDescription}
                    className="px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {formatMessage({ id: "common.confirm.cancel" })}
                  </Button>
                </div>
                <span className="text-[11px] text-foreground-muted theme-brutal:text-black/40 font-mono">
                  {draftDescription.length}/500
                </span>
              </div>
              {descriptionError && (
                <div className="text-xs font-bold text-brutal-orange">
                  {descriptionError}
                </div>
              )}
            </div>
          ) : (
            <p className={`whitespace-pre-wrap text-sm leading-relaxed ${machine.description ? "text-foreground-strong theme-brutal:text-black" : "text-foreground-muted theme-brutal:text-black/40 italic"}`}>
              {machine.description || formatMessage({ id: "machine.detail.noDescription" })}
            </p>
          )}
        </div>

        {/* Info */}
        <div className="px-5 py-4 border-b border-line-muted theme-brutal:border-black/10">
          <SectionEyebrow as="div" className="mb-3">
            {formatMessage({ id: "machine.detail.info" })}
          </SectionEyebrow>
          <div className="space-y-3">
            {/* OS */}
            {machine.os && <KeyValueRow label={formatMessage({ id: "machine.detail.osLabel" })} value={machine.os} mono />}
            {/* Version — a managed Computer shows its `@botiverse/raft-computer`
                version (computerVersion), which is the one release number
                (docs/operations/computer-release-version.md). Rows connected
                with the retired standalone daemon show no version: there is no
                daemon release line left to compare against. */}
            {machine.isComputer && (
              <KeyValueRow
                label={formatMessage({ id: "machine.detail.computerVersion" })}
                value={
                  machine.computerVersion ? (
                    <div>
                      <span className={`text-sm font-mono ${computerVersionFact.kind === "outdated" ? "text-brutal-orange font-bold" : "text-foreground-strong theme-brutal:text-black"}`}>
                        v{machine.computerVersion}
                      </span>
                      {computerVersionFact.kind === "current" && (
                        <>
                          {" "}
                          <span className="text-xs text-foreground-muted theme-brutal:text-black/60">
                            · {formatMessage({ id: "machine.detail.upToDate" })}
                          </span>
                        </>
                      )}
                      {computerVersionFact.kind === "outdated" && (
                        <>
                          {" "}
                          <span className="text-xs text-brutal-orange font-bold">
                            · {formatMessage(
                              { id: "machine.detail.versionAvailable" },
                              { version: computerVersionFact.availableVersion },
                            )}
                          </span>
                        </>
                      )}
                      {releaseNotesForUpdate && machine.status !== "online" && (
                        <>
                          {" "}
                          <ComputerReleaseNotesAffordance notes={releaseNotesForUpdate} />
                        </>
                      )}
                    </div>
                  ) : machine.status === "online" ? (
                    <span className="text-sm text-foreground-muted theme-brutal:text-black/40 italic">
                      {formatMessage({ id: "machine.detail.readingVersion" })}
                    </span>
                  ) : (
                    <span className="text-sm text-foreground-muted theme-brutal:text-black/40 italic">—</span>
                  )
                }
              />
            )}
            {/* Online, not a manager, newer version exists: say who can act
                (the offline card has its own admin-only line). */}
            {machine.isComputer && !canManageMachines && machine.status === "online" && computerVersionFact.kind === "outdated" && (
              <p className="text-xs text-foreground-muted theme-brutal:text-black/60" data-testid="computer-upgrade-ask-admin">
                {formatMessage(
                  { id: "machine.detail.upgradeStatus.askAdmin" },
                  { version: computerVersionFact.availableVersion },
                )}
              </p>
            )}
            {/* Detected Runtimes */}
            <KeyValueRow
              label={formatMessage({ id: "machine.detail.detectedRuntimes" })}
              value={
                <div className="flex items-center gap-1.5 flex-wrap">
                  {getMachineRuntimeDisplayOptions().map((r) => {
                    const detected = machine.runtimes.includes(r.id);
                    const chipClassName = detected
                      ? "bg-info-soft text-info-strong theme-brutal:bg-brutal-cyan theme-brutal:text-black"
                      : "bg-fill-muted text-foreground-muted";
                    return (
                      <RuntimeAccountUsageGateChip
                        key={r.id}
                        enabled={detected && canViewRuntimeAccountUsage}
                        runtimeId={r.id}
                        runtimeVersion={machine.runtimeVersions?.[r.id]}
                        serverId={serverId}
                        machineId={machine.id}
                        className={chipClassName}
                      >
                        {formatRuntimeLabelWithStatus(r.id, formatMessage)}{formatRuntimeAvailabilitySuffix(runtimeAvailabilitySuffix(r, machine.runtimes), formatMessage)}
                      </RuntimeAccountUsageGateChip>
                    );
                  })}
                </div>
              }
            />
            <div className="flex flex-wrap gap-x-8 gap-y-3">
              {/* Created */}
              <KeyValueRow label={formatMessage({ id: "machine.detail.created" })} value={createdDate} mono />
              {/* Creator — managed Computers only; raw daemon rows preserve
                  their existing Created-only presentation. */}
              {machine.isComputer && (
                <KeyValueRow
                  label={formatMessage({ id: "agent.detail.creator" })}
                  valueClassName="flex items-center gap-2"
                  value={
                    machine.creator ? (
                      <button
                        type="button"
                        onClick={() => openProfile("human", machine.creator!.id)}
                        className="flex items-center gap-2 text-sm text-foreground-strong theme-brutal:text-black hover:underline"
                      >
                        <AvatarSlot
                          context="creator-link"
                          type="human"
                          humanAvatarUrl={machine.creator.avatarUrl}
                          gravatarHash={machine.creator.gravatarHash}
                        />
                        <span className="font-bold">{machine.creator.displayName || machine.creator.name}</span>
                        <span className="font-mono text-xs text-foreground-muted theme-brutal:text-black/50">
                          {formatMessage({ id: "common.handle" }, { name: machine.creator.name })}
                        </span>
                      </button>
                    ) : (
                      <span className="text-sm italic text-foreground-muted theme-brutal:text-black/40">
                        {formatMessage({ id: "agent.detail.noCreatorAssigned" })}
                      </span>
                    )
                  }
                />
              )}
            </div>
          </div>
        </div>

        <div className="px-5 py-4 space-y-6">
          {/* Rows connected with the retired standalone daemon: the only
              offered action is migrating to Raft Computer (task #239 v2.3
              §19.web). The former "keep using the legacy daemon" section is
              gone with the daemon's npm release; the structure stays
              intent-stable and never restructures on credential state (the
              generate-jump defect class, #wg-raft-computer:5473a4ca). */}
          {!machine.isComputer && canManageMachines && (
            <div className="space-y-6">
              {computerSetupCommand && computerInstall && (
                <div data-testid="computer-migrate-block">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <SectionEyebrow as="div">
                      {formatMessage(
                        { id: "machine.detail.migrateToComputer" },
                        { platform: windowsMachine ? formatMessage({ id: "machine.detail.windowsX64Suffix" }) : "" },
                      )}
                    </SectionEyebrow>
                    {windowsMachine ? <Badge.Experimental /> : null}
                  </div>
                  <p className="mb-2 text-xs leading-5 text-foreground-muted theme-brutal:text-black/60">
                    {formatMessage(
                      { id: "machine.detail.migrateDescription" },
                      {
                        platform: windowsMachine
                          ? formatMessage({ id: "machine.detail.windowsPowerShell" })
                          : formatMessage({ id: "machine.detail.macLinux" }),
                      },
                    )}
                  </p>
                  <div className="space-y-3">
                    {([
                      ["computer-install", formatMessage({ id: "machine.detail.installStep" }), computerInstall],
                      ["computer-setup", formatMessage({ id: "machine.detail.setupStep" }), computerSetupCommand],
                    ] as const).map(([target, label, command]) => (
                      <div key={target}>
                        <div className="mb-1 text-xs font-bold text-foreground-muted theme-brutal:text-black/60">{label}</div>
                        <CopyableCodeRoot
                          copied={copiedCommand === target}
                          onCopy={() => handleCopy(target)}
                        >
                          <CopyableCode className="min-w-0 flex-1 px-3 py-2 font-mono text-xs break-all">
                            {command}
                          </CopyableCode>
                          <Tooltip content={formatMessage({ id: "machine.detail.copyCommandLabel" }, { label })}>
                            <CopyableCodeAction
                              aria-label={formatMessage({ id: "machine.detail.copyCommandLabel" }, { label })}
                              className="shrink-0"
                            />
                          </Tooltip>
                        </CopyableCodeRoot>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {!machine.isComputer && !canManageMachines && machine.status === "offline" && (
            <div>
              <SectionEyebrow as="div" className="mb-2">
                {formatMessage({ id: "machine.detail.connection" })}
              </SectionEyebrow>
              <div className="text-xs text-foreground-muted theme-brutal:text-black/40 font-mono">
                {formatMessage({ id: "machine.detail.connectCommandsAdminOnly" })}
              </div>
            </div>
          )}

          {machine.isComputer && machine.status !== "online" && (
            <div data-testid="computer-recovery-card">
              <div className="mb-2 flex items-center gap-2">
                <Terminal size={16} className="text-foreground-strong theme-brutal:text-black" />
                <SectionEyebrow as="div">{formatMessage({ id: "machine.detail.bringComputerOnline" })}</SectionEyebrow>
              </div>

              {canManageMachines ? (
                <div className="space-y-4">
                  {/* Primary remedy — a local command, platform-independent.
                      Web remote restart/upgrade only works while online (live
                      WS relay), so an offline Computer cannot get a web button. */}
                  {computerRecoveryRestartCommand && (
                    <div>
                      <p className="mb-2 text-xs leading-5 text-foreground-muted theme-brutal:text-black/60">
                        {formatMessage({ id: "machine.detail.recoveryRestartDescription" }, { serverSlug })}
                      </p>
                      <CopyableCodeRoot
                        copied={copiedCommand === "terminal-restart"}
                        onCopy={() => handleCopy("terminal-restart")}
                      >
                        <CopyableCode
                          className="min-w-0 flex-1 px-3 py-2 font-mono text-xs break-all"
                          data-testid="computer-recovery-restart"
                        >
                          {computerRecoveryRestartCommand}
                        </CopyableCode>
                        <Tooltip content={formatMessage({ id: "machine.detail.copyCommand" })}>
                          <CopyableCodeAction
                            aria-label={formatMessage({ id: "machine.detail.copyCommand" })}
                            className="shrink-0"
                          />
                        </Tooltip>
                      </CopyableCodeRoot>
                    </div>
                  )}

                  {/* Diagnostics — reuse the existing status/doctor commands. */}
                  <div>
                    <p className="mb-2 text-xs leading-5 text-foreground-muted theme-brutal:text-black/60">
                      {formatMessage({ id: "machine.detail.offlineDiagnosticsPrompt" })}
                    </p>
                    <div className="space-y-2">
                      {terminalStatusCommands.map(({ command, target }) => (
                        <CopyableCodeRoot
                          key={command}
                          copied={copiedCommand === target}
                          onCopy={() => handleCopy(target)}
                        >
                          <CopyableCode
                            className="min-w-0 flex-1 px-3 py-2 font-mono text-xs break-all"
                            data-testid={`computer-recovery-${target === "terminal-status" ? "status" : "doctor"}`}
                          >
                            {command}
                          </CopyableCode>
                          <Tooltip content={formatMessage({ id: "machine.detail.copyCommand" })}>
                            <CopyableCodeAction
                              aria-label={formatMessage({ id: "machine.detail.copyCommand" })}
                              className="shrink-0"
                            />
                          </Tooltip>
                        </CopyableCodeRoot>
                      ))}
                    </div>
                  </div>

                  {/* last-seen — let the user judge if the machine is just
                      off; no offline-reason guessing (frontend can't tell). */}
                  {machine.lastHeartbeat && (
                    <p className="text-xs leading-5 text-foreground-muted theme-brutal:text-black/50">
                      {formatMessage(
                        { id: "machine.detail.lastSeen" },
                        { time: lastHeartbeatText },
                      )}
                    </p>
                  )}

                  {/* Secondary: an explicit command-not-found path exposes
                      install + setup without displacing the normal start path. */}
                  <div className="border-t border-line-muted theme-brutal:border-black/10 pt-3">
                    <button
                      type="button"
                      onClick={() => setShowRecoverySetup((v) => !v)}
                      className="text-xs font-bold text-foreground-muted theme-brutal:text-black/60 underline underline-offset-2"
                      aria-expanded={showRecoverySetup}
                      data-testid="computer-recovery-setup-toggle"
                    >
                      {showRecoverySetup
                        ? formatMessage({ id: "machine.detail.hideInstallSetupCommands" })
                        : formatMessage({ id: "machine.detail.commandNotFoundSetup" })}
                    </button>
                    {showRecoverySetup && computerInstall && computerSetupCommand && (
                      <div className="mt-2 space-y-3">
                        <p className="text-xs leading-5 text-foreground-muted theme-brutal:text-black/60">
                          {formatMessage({ id: "machine.detail.installSetupDescription" })}
                          {windowsMachine ? ` ${formatMessage({ id: "machine.detail.windowsInstallerX64Only" })}` : ""}
                        </p>
                        {([
                          ["computer-install", formatMessage({ id: "machine.detail.installStep" }), computerInstall],
                          ["computer-setup", formatMessage({ id: "machine.detail.setupStep" }), computerSetupCommand],
                        ] as const).map(([target, label, command]) => (
                          <div key={target}>
                            <div className="mb-1 text-xs font-bold text-foreground-muted theme-brutal:text-black/60">{label}</div>
                            <CopyableCodeRoot
                              copied={copiedCommand === target}
                              onCopy={() => handleCopy(target)}
                            >
                              <CopyableCode
                                className="min-w-0 flex-1 px-3 py-2 font-mono text-xs break-all"
                                data-testid={target === "computer-install" ? "computer-recovery-install" : "computer-recovery-setup"}
                              >
                                {command}
                              </CopyableCode>
                              <Tooltip content={
                                  target === "computer-install"
                                    ? formatMessage({ id: "machine.detail.copyInstallCommand" })
                                    : formatMessage({ id: "machine.detail.copySetupCommand" })
                                }>
                                <CopyableCodeAction
                                  aria-label={
                                    target === "computer-install"
                                      ? formatMessage({ id: "machine.detail.copyInstallCommand" })
                                      : formatMessage({ id: "machine.detail.copySetupCommand" })
                                  }
                                  className="shrink-0"
                                />
                              </Tooltip>
                            </CopyableCodeRoot>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-xs leading-5 text-foreground-muted theme-brutal:text-black/50">
                  {formatMessage(
                    { id: "machine.detail.offlineAdminOnly" },
                    { time: lastHeartbeatParenthetical },
                  )}
                </p>
              )}
            </div>
          )}

          {/* Agents on this machine — isolated to prevent activity re-renders */}
          <MachineAgentList machine={machine} canManageMachines={canManageMachines} />

          {/* Agent Workspaces — only when machine is online */}
          {machine.status === "online" && (
            <div className="mt-2 border-t border-line-muted theme-brutal:border-black/10 pt-4">
              <WorkspacesSection machineId={machine.id} canManageMachines={canManageMachines} />
            </div>
          )}

          {/* Actions */}
          {canManageMachines && (
            <div className="mt-2 border-t border-line-muted theme-brutal:border-black/10 pt-4">
              <SectionEyebrow as="div" className="mb-3">
                {formatMessage({ id: "machine.detail.actions" })}
              </SectionEyebrow>
              {/* Remote restart / upgrade — managed Computer only (a raw
                  daemon has no remotely-controllable service). Online-only:
                  offline recovery is the recovery card's job (task #247). */}
              {machine.isComputer && machine.status === "online" && (
                <Card className="p-4 mb-3" data-testid="computer-service-actions">
                  <div className="text-sm font-bold text-foreground-strong theme-brutal:text-black mb-1">
                    {formatMessage({ id: "machine.detail.computer" })}
                  </div>
                  {computerOperationProgress ? (
                    /* Progress mode — show bar instead of buttons */
                    <div className="space-y-2">
                      {computerOperationProgress.done ? (
                        <div className={`flex items-center gap-2 text-xs font-mono ${computerOperationProgress.error ? "text-brutal-red" : "text-foreground-muted theme-brutal:text-black/70"}`}>
                          {computerOperationProgress.error ? (
                            <AlertCircle size={14} className="shrink-0" />
                          ) : (
                            <CheckCircle size={14} className="shrink-0" />
                          )}
                          {computerOperationProgress.error
                            ? (
                              computerOperationProgress.error === "restart_failed"
                                ? formatMessage({ id: "machine.restartFailed" })
                                : computerOperationProgress.error
                            )
                            : formatMessage({ id: "machine.detail.restarted" })}
                        </div>
                      ) : (
                        <>
                          <ProgressBar
                            value={computerOperationProgress.progressValue ?? null}
                            tone="cyan"
                            label={computerOperationProgress.message ?? formatMessage({ id: "machine.detail.restarting" })}
                          />
                        </>
                      )}
                    </div>
                  ) : (
                    /* Default mode — one status sentence, then exactly one
                       next step: a button, or the commands to run on that
                       machine (never both). */
                    (() => {
                      const policy = machine.computerBroadcastPolicy;
                      const policyTargetVersion = policy?.targetVersion ?? null;
                      // Web upgrade is off when this client's flag is off or the
                      // server's broadcast gate is closed (same flag server-side).
                      const broadcastGated = policy?.reasonCode === "broadcast_disabled"
                        || policy?.reasonCode === "broadcast_gate_unavailable";
                      const webUpgradeOn = remoteUpgradeV2Enabled && !broadcastGated;
                      const oneClickTarget = machine.computerUpgradeAvailable === true
                        && policy?.eligibility === "eligible"
                        && policyTargetVersion
                        ? policyTargetVersion
                        : null;
                      type CardState =
                        | { kind: "reading" }
                        | { kind: "cannotCheck" }
                        | { kind: "upToDate" }
                        | { kind: "upgrading"; version: string }
                        | { kind: "oneClick"; version: string }
                        | { kind: "commands"; version: string; sentence: "runCommands" | "refusedNotAllowed" };
                      const cardState: CardState = (() => {
                        const fact = computerVersionFact;
                        if (fact.kind === "unknown") return { kind: "reading" };
                        if (fact.kind === "cannotCheck") return { kind: "cannotCheck" };
                        if (fact.kind === "current") return { kind: "upToDate" };
                        const version = fact.availableVersion;
                        if (upgradePending) return { kind: "upgrading", version: upgradeRequest?.targetVersion ?? version };
                        if (upgradeRefusal === "not_allowed") return { kind: "commands", version, sentence: "refusedNotAllowed" };
                        // Web upgrade off or refused, or this version too old for
                        // it: the same "run these two commands" state.
                        if (upgradeRefusal === "web_upgrade_off" || upgradeRefusal === "too_old") return { kind: "commands", version, sentence: "runCommands" };
                        if (webUpgradeOn && remoteUpgradeSupported && oneClickTarget) return { kind: "oneClick", version: oneClickTarget };
                        return { kind: "commands", version, sentence: "runCommands" };
                      })();
                      const statusSentence = (() => {
                        switch (cardState.kind) {
                          case "reading":
                            return formatMessage({ id: "machine.detail.upgradeStatus.readingVersion" });
                          case "cannotCheck":
                            return formatMessage({ id: "machine.detail.upgradeStatus.cannotCheck" });
                          case "upToDate":
                            return formatMessage({ id: "machine.detail.upgradeStatus.upToDate" });
                          case "upgrading":
                            return formatMessage({ id: "machine.detail.upgradeStatus.inProgress" }, { version: cardState.version });
                          case "oneClick":
                            return formatMessage({ id: "machine.detail.upgradeStatus.available" }, { version: cardState.version });
                          case "commands":
                            return formatMessage({ id: `machine.detail.upgradeStatus.${cardState.sentence}` }, { version: cardState.version });
                        }
                      })();
                      // Install the latest release, then restart.
                      const upgradeCommands = cardState.kind === "commands" ? computerFreshInstallCommands : null;
                      const upgradeInstallCommand = upgradeCommands?.install ?? null;
                      const upgradeRestartCommand = upgradeCommands?.restartService ?? null;
                      // The last request's outcome only while the Computer is
                      // still below that request's target: a later manual
                      // upgrade makes a failure / no-response line stale.
                      const machineVersion = machine.computerVersion ?? null;
                      const requestOutcomeStillTrue = Boolean(
                        upgradeRequest
                        && (upgradeRequest.state === "failed" || upgradeRequest.state === "no_response")
                        && machineVersion
                        && isComputerSemver(machineVersion)
                        && isComputerSemver(upgradeRequest.targetVersion)
                        && compareComputerVersions(machineVersion, upgradeRequest.targetVersion) < 0,
                      );
                      const statusCommandText = machineComputerCommands?.status ?? "raft-computer status";
                      const statusCommand = <code className="font-mono">{statusCommandText}</code>;
                      const outcomeLine = cardState.kind === "oneClick" && upgradeRefusal === "unknown"
                        ? formatMessage({ id: "machine.detail.upgradeStatus.refusedUnknown" })
                        : cardState.kind !== "upgrading" && cardState.kind !== "upToDate" && requestOutcomeStillTrue
                          ? upgradeRequest?.state === "failed"
                            ? formatMessage(
                                { id: "machine.detail.upgradeStatus.failed" },
                                { version: machineVersion, command: statusCommand },
                              )
                            : formatMessage(
                                { id: "machine.detail.upgradeStatus.noResponse" },
                                { command: statusCommand },
                              )
                          : null;
                      return (
                        <>
                          <p className="text-xs leading-5 text-foreground-muted theme-brutal:text-black/60 mb-3" data-testid="computer-upgrade-status">
                            {statusSentence}
                          </p>
                          <div className="flex flex-wrap items-center gap-2" data-testid="computer-upgrade-actions">
                            {cardState.kind !== "upgrading" && (
                              <Tooltip content={formatMessage({ id: "machine.detail.restartTooltip" })}>
                              <Button size="sm"
                                variant="outline"
                                onClick={() => handleComputerRestart()}
                                className="px-3 py-2 text-sm font-bold flex items-center gap-1.5"
                              >
                                <RotateCcw size={14} />
                                {formatMessage({ id: "machine.detail.restart" })}
                              </Button>
                              </Tooltip>
                            )}
                            {cardState.kind === "upToDate" && webUpgradeOn && (
                              <Tooltip content={formatMessage({ id: "machine.detail.computerAlreadyLatest" })}>
                              <Button size="sm"
                                variant="accent"
                                disabled
                                className="px-3 py-2 text-sm font-bold flex items-center gap-1.5 disabled:opacity-40"
                              >
                                <CheckCircle size={14} />
                                {formatMessage({ id: "machine.detail.upToDate" })}
                              </Button>
                              </Tooltip>
                            )}
                            {cardState.kind === "oneClick" && (
                              <Tooltip content={formatMessage({ id: "machine.detail.upgradeToVersion" }, { version: cardState.version })}>
                              <Button size="sm"
                                variant="accent"
                                onClick={() => { void handleRemoteUpgradeV2(); }}
                                className="px-3 py-2 text-sm font-bold flex items-center gap-1.5"
                              >
                                <Play size={14} />
                                {formatMessage({ id: "machine.detail.upgradeToVersion" }, { version: cardState.version })}
                              </Button>
                              </Tooltip>
                            )}
                            {cardState.kind === "upgrading" && (
                              <Button size="sm"
                                variant="accent"
                                disabled
                                className="px-3 py-2 text-sm font-bold flex items-center gap-1.5 disabled:opacity-40"
                              >
                                <Play size={14} />
                                {formatMessage({ id: "machine.detail.upgradeV2.inProgress" })}
                              </Button>
                            )}
                            {releaseNotesForUpdate && <ComputerReleaseNotesAffordance notes={releaseNotesForUpdate} />}
                          </div>
                          {outcomeLine && (
                            <p className="mt-2 text-xs leading-5 text-brutal-orange" data-testid="computer-upgrade-request-outcome">
                              {outcomeLine}
                            </p>
                          )}
                          {cardState.kind === "commands" && upgradeInstallCommand && upgradeRestartCommand && (
                            <ol className="mt-3 space-y-3" data-testid="computer-upgrade-commands">
                              <li>
                                <div className="mb-1 text-xs font-bold text-foreground-muted theme-brutal:text-black/60">
                                  {formatMessage({ id: "machine.detail.upgradeCommands.installStep" })}
                                </div>
                                <CopyableCodeRoot
                                  copied={copiedCommand === "computer-install"}
                                  onCopy={() => handleCopy("computer-install")}
                                >
                                  <CopyableCode
                                    className="min-w-0 flex-1 break-all px-3 py-2 font-mono text-xs"
                                    data-testid="computer-upgrade-fresh-install"
                                  >
                                    {upgradeInstallCommand}
                                  </CopyableCode>
                                  <Tooltip content={formatMessage({ id: "machine.detail.copyInstallCommand" })}>
                                    <CopyableCodeAction
                                      aria-label={formatMessage({ id: "machine.detail.copyInstallCommand" })}
                                      className="shrink-0"
                                    />
                                  </Tooltip>
                                </CopyableCodeRoot>
                              </li>
                              <li>
                                <div className="mb-1 text-xs font-bold text-foreground-muted theme-brutal:text-black/60">
                                  {formatMessage({ id: "machine.detail.upgradeCommands.restartStep" })}
                                </div>
                                <CopyableCodeRoot
                                  copied={copiedCommand === "computer-install-restart"}
                                  onCopy={() => handleCopy("computer-install-restart")}
                                >
                                  <CopyableCode
                                    className="min-w-0 flex-1 break-all px-3 py-2 font-mono text-xs"
                                    data-testid="computer-upgrade-fresh-restart"
                                  >
                                    {upgradeRestartCommand}
                                  </CopyableCode>
                                  <Tooltip content={formatMessage({ id: "machine.computer.freshInstallUpgrade.copyRestart" })}>
                                    <CopyableCodeAction
                                      aria-label={formatMessage({ id: "machine.computer.freshInstallUpgrade.copyRestart" })}
                                      className="shrink-0"
                                    />
                                  </Tooltip>
                                </CopyableCodeRoot>
                              </li>
                            </ol>
                          )}
                        </>
                      );
                    })()
                  )}
                  <div className="mt-4 border-t border-line-muted theme-brutal:border-black/10 pt-4" data-testid="computer-terminal-verification">
                    <div className="mb-2 flex items-center gap-2">
                      <Terminal size={16} className="text-foreground-strong theme-brutal:text-black" />
                      <SectionEyebrow as="div">
                        {formatMessage({ id: "machine.detail.verifyFromTerminal" })}
                      </SectionEyebrow>
                    </div>
                    <p className="mb-2 text-xs leading-5 text-foreground-muted theme-brutal:text-black/60">
                      {formatMessage({ id: "machine.detail.verifyFromTerminalDescription" })}
                    </p>
                    <div className="space-y-2">
                      {terminalStatusCommands.map(({ command, target }) => (
                        <CopyableCodeRoot
                          key={command}
                          copied={copiedCommand === target}
                          onCopy={() => handleCopy(target)}
                        >
                          <CopyableCode className="min-w-0 flex-1 px-3 py-2 font-mono text-xs break-all">
                            {command}
                          </CopyableCode>
                          <Tooltip content={formatMessage({ id: "machine.detail.copyCommand" })}>
                            <CopyableCodeAction
                              aria-label={formatMessage({ id: "machine.detail.copyCommand" })}
                              className="shrink-0"
                            />
                          </Tooltip>
                        </CopyableCodeRoot>
                      ))}
                    </div>
                    {terminalRestartCommand && (
                      <>
                        <p className="mb-2 mt-3 text-xs leading-5 text-foreground-muted theme-brutal:text-black/60">
                          {formatMessage({ id: "machine.detail.webButtonsNotResponding" })}
                        </p>
                        <CopyableCodeRoot
                          copied={copiedCommand === "terminal-restart"}
                          onCopy={() => handleCopy("terminal-restart")}
                        >
                          <CopyableCode className="min-w-0 flex-1 px-3 py-2 font-mono text-xs break-all">
                            {terminalRestartCommand}
                          </CopyableCode>
                          <Tooltip content={formatMessage({ id: "machine.detail.copyCommand" })}>
                            <CopyableCodeAction
                              aria-label={formatMessage({ id: "machine.detail.copyCommand" })}
                              className="shrink-0"
                            />
                          </Tooltip>
                        </CopyableCodeRoot>
                      </>
                    )}
                  </div>
                </Card>
              )}
              {machine.isComputer && machineComputerCommands && computerFreshInstall && computerInstallRestartCommand && terminalRestartCommand && (
                <Card className="mb-3 p-4" data-testid="computer-recovery-guide">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 text-left"
                    aria-expanded={showRecoveryGuide}
                    aria-controls={recoveryGuideContentId}
                    aria-label={formatMessage(
                      {
                        id: showRecoveryGuide
                          ? "machine.detail.hideRecoveryGuide"
                          : "machine.detail.showRecoveryGuide",
                      },
                    )}
                    onClick={() => setRecoveryGuideDisclosure(!showRecoveryGuide)}
                  >
                    <span className="flex items-center gap-2">
                      <Terminal size={16} className="text-foreground-strong theme-brutal:text-black" />
                      <SectionEyebrow>{formatMessage({ id: "machine.detail.recoveryGuide" })}</SectionEyebrow>
                    </span>
                    <ChevronRight
                      size={16}
                      aria-hidden="true"
                      className={`shrink-0 text-foreground-muted theme-brutal:text-black/60 transition-transform ${showRecoveryGuide ? "rotate-90" : ""}`}
                      data-testid="computer-recovery-guide-chevron"
                    />
                  </button>
                  {showRecoveryGuide && (
                    <div
                      id={recoveryGuideContentId}
                      className="mt-3 border-t border-line-muted theme-brutal:border-black/10 pt-3"
                      data-testid="computer-recovery-guide-content"
                    >
                      <p className="mb-4 text-xs leading-5 text-foreground-muted theme-brutal:text-black/60">
                        {formatMessage({ id: "machine.detail.recoveryGuideDescription" })}
                      </p>
                      <ol className="space-y-4">
                        <li>
                          <div className="mb-2">
                            <div className="text-xs font-bold text-foreground-strong theme-brutal:text-black">
                              {formatMessage({ id: "machine.detail.restartStep" })}
                            </div>
                            <p className="text-xs leading-5 text-foreground-muted theme-brutal:text-black/60">
                              {formatMessage({ id: "machine.detail.restartStepDescription" })}
                            </p>
                          </div>
                          <CopyableCodeRoot
                            copied={copiedCommand === "terminal-restart"}
                            onCopy={() => handleCopy("terminal-restart")}
                          >
                            <CopyableCode
                              className="min-w-0 flex-1 px-3 py-2 font-mono text-xs break-all"
                              data-testid="computer-recovery-guide-restart"
                            >
                              {terminalRestartCommand}
                            </CopyableCode>
                            <Tooltip content={formatMessage({ id: "machine.detail.copyCommand" })}>
                              <CopyableCodeAction
                                aria-label={formatMessage({ id: "machine.detail.copyCommand" })}
                                className="shrink-0"
                              />
                            </Tooltip>
                          </CopyableCodeRoot>
                        </li>
                        <li>
                          <div className="mb-2">
                            <div className="text-xs font-bold text-foreground-strong theme-brutal:text-black">
                              {formatMessage(
                                { id: "machine.detail.freshInstallStep" },
                                { platform: windowsMachine ? formatMessage({ id: "machine.detail.windowsX64Suffix" }) : "" },
                              )}
                            </div>
                            <p className="text-xs leading-5 text-foreground-muted theme-brutal:text-black/60">
                              {formatMessage({ id: "machine.computer.recovery.freshInstallDescription" })}
                            </p>
                          </div>
                          <CopyableCodeRoot
                            copied={copiedCommand === "computer-install"}
                            onCopy={() => handleCopy("computer-install")}
                          >
                            <CopyableCode
                              className="min-w-0 flex-1 px-3 py-2 font-mono text-xs break-all"
                              data-testid="computer-recovery-guide-install"
                            >
                              {computerFreshInstall}
                            </CopyableCode>
                            <Tooltip content={formatMessage({ id: "machine.detail.copyFreshInstallCommand" })}>
                              <CopyableCodeAction
                                aria-label={formatMessage({ id: "machine.detail.copyFreshInstallCommand" })}
                                className="shrink-0"
                              />
                            </Tooltip>
                          </CopyableCodeRoot>
                        </li>
                        <li>
                          <div className="mb-2">
                            <div className="text-xs font-bold text-foreground-strong theme-brutal:text-black">
                              {formatMessage({ id: "machine.computer.recovery.restartAfterInstallStep" })}
                            </div>
                            <p className="text-xs leading-5 text-foreground-muted theme-brutal:text-black/60">
                              {formatMessage({ id: "machine.computer.recovery.restartAfterInstallDescription" })}
                            </p>
                          </div>
                          <CopyableCodeRoot
                            copied={copiedCommand === "computer-install-restart"}
                            onCopy={() => handleCopy("computer-install-restart")}
                          >
                            <CopyableCode
                              className="min-w-0 flex-1 break-all px-3 py-2 font-mono text-xs"
                              data-testid="computer-recovery-guide-restart-after-install"
                            >
                              {computerInstallRestartCommand}
                            </CopyableCode>
                            <Tooltip content={formatMessage({ id: "machine.computer.freshInstallUpgrade.copyRestart" })}>
                              <CopyableCodeAction
                                aria-label={formatMessage({ id: "machine.computer.freshInstallUpgrade.copyRestart" })}
                                className="shrink-0"
                              />
                            </Tooltip>
                          </CopyableCodeRoot>
                        </li>
                      </ol>
                    </div>
                  )}
                </Card>
              )}
              <Card className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-bold text-foreground-strong theme-brutal:text-black">
                      {formatMessage({ id: "machine.detail.deleteComputer" })}
                    </div>
                    <p className="text-xs text-foreground-muted theme-brutal:text-black/60 mt-0.5">
                      {formatMessage({ id: "machine.detail.deleteComputerDescription" })}
                    </p>
                  </div>
                  <Button size="sm"
                    variant="danger"
                    onClick={() => setShowDeleteConfirm(true)}
                    className="px-4 py-2 text-sm font-bold flex items-center gap-1.5 shrink-0 ml-4"
                  >
                    <Trash2 size={14} />
                    {formatMessage({ id: "machine.detail.deleteComputer" })}
                  </Button>
                </div>
              </Card>
            </div>
          )}
        </div>
      </div>

      {showDeleteConfirm && (
        machineAgents.length > 0 ? (
          <ConfirmDialog
            title={formatMessage({ id: "machine.detail.cannotDeleteComputer" })}
            message={formatMessage({ id: "machine.detail.cannotDeleteComputerMessage" }, { count: machineAgents.length })}
            confirmLabel={formatMessage({ id: "common.announcement.ok" })}
            confirmVariant="outline"
            hideCancel
            onConfirm={() => {}}
            onClose={() => setShowDeleteConfirm(false)}
          />
        ) : (
          <ConfirmDialog
            title={formatMessage({ id: "machine.detail.deleteComputer" })}
            message={formatMessage({ id: "machine.detail.deleteComputerMessage" }, { name: machine.name })}
            confirmLabel={formatMessage({ id: "machine.detail.deleteComputer" })}
            loadingLabel={formatMessage({ id: "machine.detail.deleting" })}
            onConfirm={handleDelete}
            onClose={() => setShowDeleteConfirm(false)}
          />
        )
      )}

    </div>
  );
}
