import { create } from "zustand";
import api from "../api/client";
import { coalesce, useServerStore } from "./serverStore";
import { registerServerReset } from "./serverResetRegistry";
import { emitStateTransitionTrace } from "../utils/stateTransitionTrace";
import {
  applyMachineEvent,
} from "./events/machineEvents";
import type {
  MachineDomainState,
  MachineEvent,
  MachineTransition,
} from "./events/machineEvents";
import type { CreatorSummary } from "./agentStore";
import { normalizeComputerReleaseNotes } from "@botiverse/raft-shared";
import type { ComputerReleaseNotes, MachineDiskStatus } from "@botiverse/raft-shared";

export interface Machine {
  id: string;
  name: string;
  description: string | null;
  status: "online" | "offline";
  statusVersion: number;
  apiKeyPrefix: string | null;
  runtimes: string[];
  /** Live runtime binary/package versions reported by the connected daemon. */
  runtimeVersions?: Record<string, string>;
  hostname: string | null;
  os: string | null;
  daemonVersion: string | null;
  // Run-kind: true when this machine is presented by an attached managed
  // Computer (server derives it from the computers↔machines link); false
  // for a raw daemon. Drives the Computer/Daemon label + computer-only
  // setup command on the detail page. Absent on older server responses →
  // treated as false (daemon).
  isComputer?: boolean;
  // True when this Computer row was attached by the current user. Raw daemons
  // and older server responses leave this false/absent.
  computerAttachedByCurrentUser?: boolean;
  // Latest disk report while online; null/absent when offline, never
  // reported, or from an older server. See machineDiskLowPresentation.
  diskStatus?: MachineDiskStatus | null;
  // Public, server-scoped identity of the human who attached this managed
  // Computer. Null for departed creators and raw daemon rows.
  creator?: CreatorSummary | null;
  // For a managed Computer: its own `@botiverse/raft-computer` version (0.0.x),
  // reported by the Computer and shown instead of the underlying daemon
  // version. Null/absent until reported.
  computerVersion?: string | null;
  // Compatibility projection of the closed server policy decision.
  // true is the only broadcastable state; false means policy denied.
  computerUpgradeAvailable?: boolean | null;
  // Remote upgrade v2 (task #873): the latest request for this machine, as
  // the server projects it. `pending` until the machine reconnects or the
  // deadline passes; nothing else is modelled.
  upgradeRequest?: MachineUpgradeRequest | null;
  // Remote upgrade v2: only `true` may be driven from the web. false = this
  // Computer predates the web-driven path; null = version unknown. Both show
  // the greyed button + local upgrade hint (same fail-closed shape as the server).
  remoteUpgradeSupported?: boolean | null;
  // Per-machine source-aware policy projection. This is the only authority for
  // target/copy; top-level latestComputerVersion is an artifact hint.
  computerBroadcastPolicy?: {
    eligibility: "eligible" | "no_broadcast";
    targetVersion: string | null;
    targetRole: "K" | "post_K" | "independent_bugfix" | null;
    migrationClass: "controlled_reinstall_repair" | "seamless" | null;
    policyRevision: string | null;
    reasonCode: string;
  } | null;
  lastHeartbeat: string | null;
  createdAt: string;
}

export interface MachineWorkspaceEntry {
  directoryName: string;
  totalSizeBytes: number;
  lastModified: string;
  fileCount: number;
  status: "active" | "stopped" | "deleted" | "orphan";
  agentName: string | null;
  agentStatus: string | null;
}

/** Per-machine Computer upgrade/restart progress driven by WS frames.
 *  Keyed by machineId. Reset when the machine goes offline or a new
 *  operation begins on the same machine. */
export interface MachineUpgradeRequest {
  id: string;
  targetVersion: string;
  requestedAt: string;
  state: "pending" | "done" | "failed" | "no_response";
  observedVersion: string | null;
  reason: string | null;
  resolvedAt: string | null;
}

export interface ComputerOperationProgress {
  /** Restart is the only in-flight Computer operation the web tracks; upgrades
   *  are request rows settled by the machine's reconnect (remote upgrade v2). */
  operation: "restart";
  /** requestId echoed from the command for terminal receipt correlation. */
  requestId?: string;
  /** Optional human-readable status message. */
  message?: string;
  /** Derived 0-100 progress value for determinate phases. */
  progressValue?: number;
  /** True once the terminal receipt arrives. */
  done?: boolean;
  /** Error message on failure. */
  error?: string;
}

export type MachineLoadStatus = "loading" | "loaded" | "error";

interface MachineState {
  machines: Machine[];
  /** Latest published artifact hint. Never a per-machine target or
   *  eligibility authority; each row's computerBroadcastPolicy owns those. */
  latestComputerVersion: string | null;
  /** Display-only release notes for the latest published Computer version. */
  latestComputerReleaseNotes: ComputerReleaseNotes | null;
  loading: boolean;
  loadStatus: MachineLoadStatus;
  loadError: boolean;
  selectedMachineId: string | null;
  showAddMachine: boolean;
  /**
   * Machine a native host wants first in the sidebar's Computers list (the
   * desktop pins "this device"; see sidebarMachineOrder.ts). Null on the web.
   */
  pinnedMachineId: string | null;
  /** Transient: API key shown once after registration */
  pendingApiKey: string | null;
  pendingMachineId: string | null;
  /** Per-machine workspace scan results */
  machineWorkspaces: Record<string, MachineWorkspaceEntry[]>;
  machineWorkspacesLoading: Record<string, boolean>;
  /** Per-machine Computer operation progress (upgrade/restart) */
  computerOperationProgress: Record<string, ComputerOperationProgress | null>;

  loadMachines: () => Promise<void>;
  /** Ask a computer to re-detect its installed runtimes. Fresh list arrives via the capabilities push. */
  rescanRuntimes: (machineId: string) => Promise<void>;
  registerMachine: (
    name: string,
  ) => Promise<{ machine: Machine; apiKey: string }>;
  renameMachine: (machineId: string, name: string) => Promise<void>;
  updateMachineDetails: (
    machineId: string,
    updates: { name?: string; description?: string | null },
  ) => Promise<void>;
  deleteMachine: (machineId: string) => Promise<void>;
  applyMachineStatusEvent: (
    machineId: string,
    status: "online" | "offline",
    statusVersion?: number,
  ) => MachineTransition;
  requestMachineReconcile: (
    reason: "machine-updated" | "scheduled",
  ) => MachineTransition;
  updateMachineStatus: (
    machineId: string,
    status: "online" | "offline",
    statusVersion?: number,
  ) => boolean;
  updateMachineCapabilities: (
    machineId: string,
    runtimes: string[],
    hostname?: string,
    os?: string,
    daemonVersion?: string,
    computerVersion?: string | null,
    runtimeVersions?: Record<string, string>,
  ) => void;
  rotateApiKey: (machineId: string) => Promise<string>;
  clearPendingApiKey: () => void;
  setSelectedMachine: (machineId: string | null) => void;
  setShowAddMachine: (show: boolean) => void;
  setPinnedMachineId: (machineId: string | null) => void;
  scanMachineWorkspaces: (machineId: string) => Promise<void>;
  deleteMachineWorkspace: (
    machineId: string,
    directoryName: string,
  ) => Promise<void>;
  setComputerOperation: (
    machineId: string,
    progress: ComputerOperationProgress | null,
  ) => void;
  completeComputerRestart: (
    machineId: string,
    requestId: string,
    ok: boolean,
    error?: string,
  ) => void;

  /** Computed helpers */
  hasOnlineMachine: () => boolean;
  hasAnyMachine: () => boolean;
}

export const useMachineStore = create<MachineState>((set, get) => {
  const dispatchMachineEvent = (event: MachineEvent): MachineTransition => {
    const current = get();
    const { state, transition } = applyMachineEvent(
      {
        machines: current.machines,
        latestComputerVersion: current.latestComputerVersion,
        computerOperationProgress: current.computerOperationProgress,
      },
      event,
    );
    if (transition.touched > 0) {
      set(domainStateToStorePatch(state));
    }
    emitStateTransitionTrace({
      domain: "machine",
      event: transition.event,
      entityId: transition.machineId ?? "machine-list",
      touched: transition.touched,
      outcome: transition.accepted ? (transition.touched > 0 || transition.recoveryAction ? "applied" : "noop") : "conflict",
      outcomeDetail: transition.accepted ? "accepted" : "rejected",
      recoveryAction: transition.recoveryAction,
    });
    return transition;
  };

  return {
    machines: [],
    latestComputerVersion: null,
    latestComputerReleaseNotes: null,
    loading: true,
    loadStatus: "loading",
    loadError: false,
    selectedMachineId: null,
    showAddMachine: false,
    pinnedMachineId: null,
    pendingApiKey: null,
    pendingMachineId: null,
    machineWorkspaces: {},
    machineWorkspacesLoading: {},
    computerOperationProgress: {},
    setComputerOperation: (machineId, progress) => {
      dispatchMachineEvent({ kind: "operation-set", machineId, progress });
    },

    rescanRuntimes: async (machineId: string) => {
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) return;
      // Fire-and-forget: the daemon answers by re-emitting its capabilities, which
      // land through the normal machine:capabilities push. Nothing to await here.
      await api.post(`/servers/${serverId}/machines/${machineId}/runtimes/rescan`);
    },

    completeComputerRestart: (machineId, requestId, ok, error) => {
      dispatchMachineEvent({
        kind: "restart-done",
        machineId,
        requestId,
        ok,
        error,
      });
    },

    loadMachines: async () => {
      const epoch = useServerStore.getState().serverEpoch;
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) return;
      // Coalesce concurrent triggers (connect snapshot + realtime fallbacks +
      // surface opens) onto one request; epoch in the key keeps an epoch
      // change from piggybacking on a stale-epoch fetch.
      return coalesce(`machines:${serverId}:${epoch}`, async () => {
        set({ loadError: false });
        if (get().machines.length === 0) {
          set({ loading: true, loadStatus: "loading" });
        }
        // Initial/retry loads with no usable rows re-enter loading. Refreshes keep
        // existing rows visible while the current server epoch is revalidated.
        try {
          const { data } = await api.get(`/servers/${serverId}/machines`);
          if (useServerStore.getState().serverEpoch !== epoch) return;
          const machines = Array.isArray(data) ? data : data.machines;
          const latestComputerVersion = Array.isArray(data)
            ? null
            : (data.latestComputerVersion ?? null);
          // Additive field; re-validated here so a bad payload drops the
          // notes instead of reaching the renderer.
          const releaseNotes = Array.isArray(data) ? null : data.latestComputerReleaseNotes;
          const latestComputerReleaseNotes = normalizeComputerReleaseNotes(releaseNotes?.version, releaseNotes);
          dispatchMachineEvent({
            kind: "hydrate",
            machines,
            latestComputerVersion,
          });
          set({ latestComputerReleaseNotes, loading: false, loadStatus: "loaded", loadError: false });
        } catch (err) {
          console.error("Failed to load machines:", err);
          if (useServerStore.getState().serverEpoch !== epoch) return;
          const hasCachedMachines = get().machines.length > 0;
          set({
            loading: false,
            loadStatus: hasCachedMachines ? "loaded" : "error",
            loadError: true,
          });
        }
      });
    },

    registerMachine: async (name: string) => {
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) throw new Error("No server selected");
      const { data } = await api.post(`/servers/${serverId}/machines`, {
        name,
      });
      const machine: Machine = {
        ...data.machine,
        runtimes: data.machine.runtimes || [],
      };
      // Persist API key locally so the run command is always available
      localStorage.setItem(`slock_machine_apikey_${machine.id}`, data.apiKey);
      set((state) => ({
        machines: [...state.machines, machine],
        pendingApiKey: data.apiKey,
        pendingMachineId: machine.id,
      }));
      return { machine, apiKey: data.apiKey };
    },

    renameMachine: async (machineId: string, name: string) => {
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) throw new Error("No server selected");
      await api.patch(`/servers/${serverId}/machines/${machineId}`, { name });
      set((state) => ({
        machines: state.machines.map((m) =>
          m.id === machineId ? { ...m, name } : m,
        ),
      }));
    },

    updateMachineDetails: async (machineId, updates) => {
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) throw new Error("No server selected");
      await api.patch(`/servers/${serverId}/machines/${machineId}`, updates);
      set((state) => ({
        machines: state.machines.map((m) =>
          m.id === machineId ? { ...m, ...updates } : m,
        ),
      }));
    },

    deleteMachine: async (machineId: string) => {
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) throw new Error("No server selected");
      await api.delete(`/servers/${serverId}/machines/${machineId}`);
      localStorage.removeItem(`slock_machine_apikey_${machineId}`);
      set((state) => ({
        machines: state.machines.filter((m) => m.id !== machineId),
        selectedMachineId:
          state.selectedMachineId === machineId
            ? null
            : state.selectedMachineId,
        pendingApiKey:
          state.pendingMachineId === machineId ? null : state.pendingApiKey,
        pendingMachineId:
          state.pendingMachineId === machineId ? null : state.pendingMachineId,
      }));
    },

    applyMachineStatusEvent: (
      machineId: string,
      status: "online" | "offline",
      statusVersion?: number,
    ) =>
      dispatchMachineEvent({
        kind: "status",
        machineId,
        status,
        statusVersion,
      }),

    requestMachineReconcile: (reason) =>
      dispatchMachineEvent({ kind: "reconcile", reason }),

    updateMachineStatus: (
      machineId: string,
      status: "online" | "offline",
      statusVersion?: number,
    ) => {
      // Returns whether the event was accepted (the newest status for the
      // machine). Stale / duplicate status events must preserve the existing
      // machines array reference; the reducer owns that no-op contract.
      return get().applyMachineStatusEvent(machineId, status, statusVersion)
        .accepted;
    },

    updateMachineCapabilities: (
      machineId: string,
      runtimes: string[],
      hostname?: string,
      os?: string,
      daemonVersion?: string,
      computerVersion?: string | null,
      runtimeVersions?: Record<string, string>,
    ) => {
      dispatchMachineEvent({
        kind: "capabilities",
        machineId,
        runtimes,
        runtimeVersions,
        hostname,
        os,
        daemonVersion,
        computerVersion,
      });
    },

    rotateApiKey: async (machineId: string) => {
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) throw new Error("No server selected");
      const { data } = await api.post(
        `/servers/${serverId}/machines/${machineId}/rotate-key`,
      );
      localStorage.setItem(`slock_machine_apikey_${machineId}`, data.apiKey);
      const newPrefix = data.apiKey.slice(0, 20);
      set((state) => ({
        pendingApiKey: data.apiKey,
        pendingMachineId: machineId,
        machines: state.machines.map((m) =>
          m.id === machineId ? { ...m, apiKeyPrefix: newPrefix } : m,
        ),
      }));
      return data.apiKey;
    },

    clearPendingApiKey: () =>
      set({ pendingApiKey: null, pendingMachineId: null }),

    setSelectedMachine: (machineId) => set({ selectedMachineId: machineId }),

    setShowAddMachine: (show) => set({ showAddMachine: show }),
    setPinnedMachineId: (machineId) => set((state) => (state.pinnedMachineId === machineId ? state : { pinnedMachineId: machineId })),

    scanMachineWorkspaces: async (machineId: string) => {
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) return;
      set((state) => ({
        machineWorkspacesLoading: {
          ...state.machineWorkspacesLoading,
          [machineId]: true,
        },
      }));
      try {
        const { data } = await api.get(
          `/servers/${serverId}/machines/${machineId}/workspaces`,
        );
        set((state) => ({
          machineWorkspaces: { ...state.machineWorkspaces, [machineId]: data },
          machineWorkspacesLoading: {
            ...state.machineWorkspacesLoading,
            [machineId]: false,
          },
        }));
      } catch (err) {
        console.error("Failed to scan workspaces:", err);
        set((state) => ({
          machineWorkspacesLoading: {
            ...state.machineWorkspacesLoading,
            [machineId]: false,
          },
        }));
      }
    },

    deleteMachineWorkspace: async (
      machineId: string,
      directoryName: string,
    ) => {
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) return;
      await api.delete(
        `/servers/${serverId}/machines/${machineId}/workspaces/${directoryName}`,
      );
      // Remove from local state
      set((state) => ({
        machineWorkspaces: {
          ...state.machineWorkspaces,
          [machineId]: (state.machineWorkspaces[machineId] || []).filter(
            (w) => w.directoryName !== directoryName,
          ),
        },
      }));
    },

    hasOnlineMachine: () => get().machines.some((m) => m.status === "online"),
    hasAnyMachine: () => get().machines.length > 0,
  };
});

function domainStateToStorePatch(
  state: MachineDomainState,
): Pick<
  MachineState,
  | "machines"
  | "latestComputerVersion"
  | "computerOperationProgress"
> {
  return {
    machines: state.machines,
    latestComputerVersion: state.latestComputerVersion,
    computerOperationProgress: state.computerOperationProgress,
  };
}

// Reset all server-scoped state when the user switches servers.
registerServerReset(() =>
  useMachineStore.setState({
    machines: [],
    latestComputerVersion: null,
    latestComputerReleaseNotes: null,
    loading: true,
    loadStatus: "loading",
    loadError: false,
    selectedMachineId: null,
    showAddMachine: false,
    pendingApiKey: null,
    pendingMachineId: null,
    machineWorkspaces: {},
    machineWorkspacesLoading: {},
    computerOperationProgress: {},
  }),
);
