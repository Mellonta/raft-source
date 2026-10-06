import { useIntl } from "react-intl";
import { Badge, Button, Spinner } from "raft-ui";
import { Check, CircleCheck, TriangleAlert, X } from "lucide-react";
import Banner from "../ui/Banner";
import ProgressBar from "../ui/ProgressBar";
import SurfaceListItem from "../ui/SurfaceListItem";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import type { Machine } from "../../store/machineStore";
import { migrationNoticePresentation, migrationTargetLabel } from "./presentation";
import type { AgentMigrationNotice } from "./realtime";
import {
  MIGRATION_PROGRESS_STEPS,
  canCancelMigration,
  isActiveMigrationState,
  isCanceledMigrationState,
  isCompletedMigrationState,
  isFailedMigrationState,
  migrationProgressStep,
} from "./state";
import { MigrationErrorContent } from "./MigrationErrorContent";
import { MigrationReference } from "./MigrationReference";

export function MigrationProgressPanel({
  notice,
  machines,
  onShowCancel,
}: {
  notice: AgentMigrationNotice;
  machines: Machine[];
  onShowCancel: () => void;
}) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const source = migrationTargetLabel(formatMessage, machines, notice.sourceMachineId);
  const target = migrationTargetLabel(formatMessage, machines, notice.targetMachineId);
  const presentation = migrationNoticePresentation(formatMessage, notice, machines, formatShortDateTime);
  const completed = isCompletedMigrationState(notice.state);
  const failed = isFailedMigrationState(notice.state)
    || (notice.state === "starting" && notice.failureReason === "auto_start_failed");
  const canceled = isCanceledMigrationState(notice.state);
  const active = isActiveMigrationState(notice.state);
  const currentStep = migrationProgressStep(notice);
  const progress = completed ? 100 : Math.min(88, currentStep * 25 + 13);
  const cancelRequested = notice.state.startsWith("cancel_requested_");
  const statusLabel = completed
    ? formatMessage({ id: "agent.detail.migrationComplete" })
    : canceled
      ? formatMessage({ id: "agent.migration.canceledStatus" })
    : failed || notice.cancelNeedsAttention
      ? formatMessage({ id: "agent.detail.needsAttention" })
      : cancelRequested
        ? formatMessage({ id: "billing.canceling" })
        : formatMessage({ id: "agent.detail.inProgress" });
  const badgeVariant = completed
    ? "success"
    : canceled
      ? "muted"
    : failed || notice.cancelNeedsAttention
      ? "warning"
      : "information";
  const headerMessageId = completed
    ? "agent.detail.movedToTarget"
    : canceled
      ? "agent.detail.migrationToTargetCanceled"
      : failed || notice.cancelNeedsAttention
        ? "agent.detail.migrationToTargetNeedsAttention"
        : cancelRequested
          ? "agent.detail.cancelingMigrationToTarget"
          : active
            ? "agent.detail.movingToTarget"
            : "agent.detail.migrationToTarget";

  return (
    <section aria-label={formatMessage({ id: "agent.detail.migrationToTarget" }, { target })}>
      <SurfaceListItem interactive={false} className="space-y-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {completed ? (
            <CircleCheck size={18} className="shrink-0 text-foreground-strong theme-brutal:text-black" aria-hidden="true" />
          ) : canceled ? (
            <X size={18} className="shrink-0 text-foreground-strong theme-brutal:text-black" aria-hidden="true" />
          ) : failed ? (
            <TriangleAlert size={18} className="shrink-0 text-foreground-strong theme-brutal:text-black" aria-hidden="true" />
          ) : (
            <Spinner size="md" aria-hidden="true" />
          )}
          <div className="min-w-0">
            <h3 className="break-words text-sm font-bold leading-tight text-foreground-strong theme-brutal:text-black">
              {formatMessage({ id: headerMessageId }, { target })}
            </h3>
            <p className="text-xs text-foreground-muted theme-brutal:text-black/55">{formatMessage({ id: "agent.detail.workspaceAndAgentState" })}</p>
          </div>
        </div>
        <Badge appearance="outline" variant={badgeVariant} uppercase className="shrink-0">
          {statusLabel}
        </Badge>
      </div>

      <MigrationReference notice={notice} />

      <ProgressBar
        value={progress}
        tone={completed ? "lime" : failed || canceled ? "orange" : "pink"}
        label={formatMessage({ id: "agent.detail.migrationProgressToTarget" }, { target })}
      />

      <ol className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
        {MIGRATION_PROGRESS_STEPS.map((labelId, index) => {
          const stepComplete = completed || index < currentStep;
          const stepCurrent = !completed && index === currentStep;
          return (
            <li key={labelId} className="flex min-w-0 items-center gap-1.5 text-[11px] font-bold">
              <span
                className={`flex size-4 shrink-0 items-center justify-center border border-line-muted theme-brutal:border-black text-[9px] ${
 stepComplete
 ? "bg-success-soft theme-brutal:bg-brutal-lime"
 : stepCurrent
 ? failed
 ? "bg-warning-soft theme-brutal:bg-brutal-orange"
 : "bg-accent-soft theme-brutal:bg-brutal-pink"
 : "bg-layer-panel theme-brutal:bg-white text-foreground-placeholder theme-brutal:text-black/35"
 }`}
                aria-hidden="true"
              >
                {stepComplete ? <Check size={10} strokeWidth={3} /> : index + 1}
              </span>
              <span className={stepCurrent || stepComplete ? "text-foreground-strong theme-brutal:text-black" : "text-foreground-placeholder theme-brutal:text-black/40"}>
                {formatMessage({ id: labelId })}
              </span>
            </li>
          );
        })}
      </ol>

      <Banner
        intent={failed || notice.cancelNeedsAttention ? "warning" : completed ? "success" : "info"}
        density="sm"
        title={failed || cancelRequested ? presentation.title : undefined}
        aria-live="polite"
      >
        {failed || notice.cancelNeedsAttention
          ? <MigrationErrorContent presentation={presentation} />
          : presentation.message}
      </Banner>
      {completed ? (
        <div
          className="space-y-2 border border-line-muted theme-brutal:border-black/15 bg-fill-muted theme-brutal:bg-black/[0.03] p-2.5 text-xs text-foreground-muted theme-brutal:text-black/70"
          data-testid="migration-completion-summary"
        >
          <p className="font-bold text-foreground-strong theme-brutal:text-black">
            {formatMessage({ id: "agent.detail.migrationCompletionRoute" }, { source, target })}
          </p>
          <p>{formatMessage({ id: "agent.detail.migrationCompletionAuthority" })}</p>
          <p>{formatMessage({ id: "agent.detail.migrationSessionResetDetailed" })}</p>
        </div>
      ) : null}
      {active ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-foreground-placeholder theme-brutal:text-black/45">
            {formatMessage({ id: "agent.detail.updatesAutomatically" })}
          </p>
          {canCancelMigration(notice) ? (
            <Button variant="outline" size="sm"
              type="button"
              onClick={onShowCancel}
              className="flex items-center gap-1.5"
            >
              <X size={12} aria-hidden="true" />
              {formatMessage({ id: "agent.migration.cancelAction" })}
            </Button>
          ) : null}
        </div>
      ) : null}
      </SurfaceListItem>
    </section>
  );
}
