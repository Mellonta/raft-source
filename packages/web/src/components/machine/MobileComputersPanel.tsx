import { Button } from "raft-ui";
import { Monitor, Plus, RefreshCw } from "lucide-react";
import { useIntl } from "react-intl";
import { useLocation } from "react-router-dom";
import { useMachineStore } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useAppNavigate, useMobileBack } from "../../hooks/useAppNavigate";
import EmptyState from "../ui/EmptyState";
import PanelHeader from "../ui/PanelHeader";
import StatusDot from "../ui/StatusDot";
import { SkeletonRow } from "../ui/Skeleton";
import { getMachineRunLabelDescriptor } from "../../utils/machineRunLabel";
import { MachineRunLabel } from "./MachineRunLabel";
import {
  getComputerAttentionStatus,
  getComputerRowDotStatus,
  getComputerRowDotTitleDescriptor,
  getComputerRowDotTone,
} from "../../utils/computerUpgradeIndicator";
import { getComputerAvailableVersion } from "../../utils/computerVersionFact";
import { machineDiskLowPresentation } from "../../utils/machineDiskPresentation";

/**
 * Mobile-only Computers panel — renders as a regular detail panel
 * (yellow h-[62px] navbar, cream body, card-style machine items) so
 * /computers visually matches other Settings sub-pages like Account
 * / Browser / Server. Reported as a styling inconsistency by
 * @stdrc 2026-05-01 `#proj-uiux:c8711d2a` msg 2a500cb7 — previously
 * /computers on mobile rendered via the Sidebar's inline branch with
 * uppercase section headers and transparent-border list rows, which
 * read as sidebar navigation rather than a page.
 *
 * Desktop still uses the Sidebar's dedicated Computers rail column;
 * only mobile routes /computers here.
 */
export default function MobileComputersPanel() {
  const { formatMessage } = useIntl();
  const machines = useMachineStore((s) => s.machines);
  const latestComputerVersion = useMachineStore((s) => s.latestComputerVersion);
  const machinesLoading = useMachineStore((s) => s.loading);
  const machineLoadStatus = useMachineStore((s) => s.loadStatus);
  const machineLoadError = useMachineStore((s) => s.loadError);
  const loadMachines = useMachineStore((s) => s.loadMachines);
  const setShowAddMachine = useMachineStore((s) => s.setShowAddMachine);
  const serverSlug = useServerStore((s) => s.current?.slug);
  const { capabilities } = useServerPermissions();
  const canRegisterMachines = capabilities.registerMachines;
  const nav = useAppNavigate();
  const location = useLocation();
  const attentionOnly = new URLSearchParams(location.search).get("filter") === "attention";
  const visibleMachines = attentionOnly
    ? machines.filter((machine) => getComputerAttentionStatus(machine) !== "none")
    : machines;
  // Computers is a level-2 view under Settings on mobile; back pops
  // to the Settings tab home (or app root if serverSlug is missing).
  const onMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}/settings` : "/");

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="mobile-computers-panel">
      {/* Header — uses canonical PanelHeader so padding (`gap-3 px-5`),
          back-chevron sizing, and action-slot wrapping match every other
          Settings sub-page (Account / Browser / Server). Was hand-rolled
          with `gap-3 px-5` before; converted to PanelHeader after stdrc
          confirmed (2026-05-14 #wg-theme:16123203) that the wider BEFORE
          padding is the canonical look on every breakpoint. */}
      <PanelHeader
        title={formatMessage({ id: "machine.mobile.title" })}
        onMobileBack={onMobileBack}
        mobileBackProps={{ "data-testid": "computers-mobile-back", title: formatMessage({ id: "common.announcement.back" }) }}
      />

      {/* Body — cream page background with card-style machine rows,
          matching the visual weight of Tasks / Saved / Threads. */}
      <div className="flex-1 overflow-y-auto bg-layer-canvas p-4 safe-bottom">
        <div className="flex flex-col gap-2.5">
          {machinesLoading && (
            <div className="flex flex-col gap-2.5" data-testid="computers-loading-skeleton">
              {Array.from({ length: 4 }, (_, index) => (
                <SkeletonRow
                  key={index}
                  className="min-h-[68px] gap-3 rounded-md border border-line-muted bg-layer-panel p-3 shadow-raft-sm theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal-sm"
                  avatar
                  avatarClassName="size-10 rounded-none"
                  lineWidths={["w-2/5", "w-3/5"]}
                />
              ))}
            </div>
          )}
          {!machinesLoading && machineLoadError && machines.length > 0 && (
            <div
              className="flex items-center justify-between gap-3 rounded-md border border-line-muted bg-primary-soft p-3 text-sm text-foreground-strong theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-soft-signal theme-brutal:text-black"
              data-testid="computers-refresh-error"
            >
              <span className="font-semibold">{formatMessage({ id: "machine.mobile.refreshErrorSaved" })}</span>
              <Button onClick={() => void loadMachines()}>
                <RefreshCw size={14} />
                {formatMessage({ id: "machine.mobile.retry" })}
              </Button>
            </div>
          )}
          {!machinesLoading && machineLoadStatus === "error" && (
            <EmptyState
              className="flex flex-col items-center justify-center py-10"
              icon={<Monitor size={36} />}
              title={formatMessage({ id: "machine.mobile.loadErrorTitle" })}
              description={formatMessage({ id: "machine.mobile.loadErrorDescription" })}
              action={
                <Button onClick={() => void loadMachines()}>
                  <RefreshCw size={14} />
                  {formatMessage({ id: "machine.mobile.retry" })}
                </Button>
              }
            />
          )}
          {!machinesLoading && machineLoadStatus === "loaded" && machines.length === 0 && (
            <EmptyState
              className="flex flex-col items-center justify-center py-10"
              icon={<Monitor size={36} />}
              title={formatMessage({ id: "emptyState.noComputersTitle" })}
              description={formatMessage({ id: "machine.mobile.emptyDescription" })}
            />
          )}
          {!machinesLoading && machineLoadStatus === "loaded" && machines.length > 0 && visibleMachines.length === 0 && (
            <EmptyState
              className="flex flex-col items-center justify-center py-10"
              icon={<Monitor size={36} />}
              title={formatMessage({ id: "machine.mobile.noAttentionTitle" })}
              description={formatMessage({ id: "machine.mobile.noAttentionDescription" })}
            />
          )}
          {!machinesLoading && machineLoadStatus === "loaded" && visibleMachines.map((machine) => {
              // Same row signal as the desktop Sidebar: the web's own version comparison.
              const availableVersion = getComputerAvailableVersion(machine, latestComputerVersion);
              const diskLow = machineDiskLowPresentation(machine, formatMessage);
              const rowDotStatus = getComputerRowDotStatus(machine, availableVersion);
              const rowDotTitle = getComputerRowDotTitleDescriptor(
                rowDotStatus,
                machine.status,
                availableVersion,
              );
              return (
                <button
                  key={machine.id}
                  onClick={() => nav.toComputer(machine.id)}
                  data-testid={`computer-list-item-${machine.id}`}
                  className="flex w-full items-center gap-3 rounded-md border border-line-muted bg-layer-panel p-3 text-left shadow-raft-sm transition-all duration-100 hover:-translate-y-[1px] hover:shadow-raft-md active:translate-x-[1px] active:translate-y-[1px] theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal-sm theme-brutal:hover:shadow-brutal theme-brutal:active:shadow-brutal-active"
                >
                  <div className="relative flex size-10 shrink-0 items-center justify-center border border-line-muted bg-layer-inset p-0 theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white"><Monitor size={20} />
                    <StatusDot
                      className="absolute -right-1 -top-1"
                      title={formatMessage({ id: rowDotTitle.id }, rowDotTitle.values)}
                      tone={getComputerRowDotTone(rowDotStatus)}
                      data-testid={`computer-status-dot-${machine.id}`}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center">
                      <span className="min-w-0 truncate text-sm font-bold text-foreground-strong">{machine.name}</span>
                    </div>
                    {machine.description && (
                      <div className="mt-0.5 truncate text-xs leading-tight text-foreground-muted">
                        {machine.description}
                      </div>
                    )}
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-foreground-hint font-mono">
                      {(() => {
                        const label = getMachineRunLabelDescriptor(machine);
                        return (
                          <span className={`truncate${label.isOffline ? " text-foreground-hint italic" : ""}`}>
                            <MachineRunLabel machine={machine} />
                          </span>
                        );
                      })()}
                      {availableVersion && (
                        <span className="shrink-0 text-brutal-orange font-bold">
                          → v{availableVersion}
                        </span>
                      )}
                      {diskLow && (
                        <span
                          className="shrink-0 text-brutal-orange font-bold"
                          data-testid={`computer-disk-low-${machine.id}`}
                          title={formatMessage({ id: "machine.diskLow.chipTitle" }, { free: diskLow.free, percent: diskLow.freePercent })}
                        >
                          {formatMessage({ id: "machine.diskLow.chip" })}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
          })}
          {/* @artin: the add affordance is a full-width "+" row at the END of the list,
              not a top-right corner icon. Same brutal card weight as a computer row, but
              a dashed border marks it as an action rather than an item. Gated on
              register-machines permission; under host-shell the panel header no longer carries
              an actions row, so this row is the sole add path in the embedded WebView. */}
          {!machinesLoading && machineLoadStatus === "loaded" && canRegisterMachines && (
            <button
              onClick={() => setShowAddMachine(true)}
              data-testid="computers-add-row"
              className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-line-muted bg-layer-panel p-3 text-sm font-bold text-foreground-muted transition-all duration-100 hover:border-line-strong hover:text-foreground-strong hover:shadow-raft-sm active:translate-x-[1px] active:translate-y-[1px] theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black/40 theme-brutal:bg-white theme-brutal:text-black/70 theme-brutal:hover:border-black theme-brutal:hover:text-black theme-brutal:hover:shadow-brutal-sm"
            >
              <Plus size={16} />
              {formatMessage({ id: "machine.mobile.addComputer" })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
