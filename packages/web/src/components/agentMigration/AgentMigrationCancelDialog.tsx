import { useIntl } from "react-intl";
import { X } from "lucide-react";
import api from "../../api/client";
import ConfirmDialog from "../ConfirmDialog";
import Banner from "../ui/Banner";
import type { Machine } from "../../store/machineStore";
import { migrationSupportRef, migrationTargetLabel } from "./presentation";
import type { AgentMigrationNotice } from "./realtime";
import { canCancelMigration } from "./state";
import { MigrationReference } from "./MigrationReference";

export function AgentMigrationCancelDialog({
  agentId,
  notice,
  machines,
  onClose,
  onRefresh,
}: {
  agentId: string;
  notice: AgentMigrationNotice;
  machines: Machine[];
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const source = migrationTargetLabel(formatMessage, machines, notice.sourceMachineId);
  const target = migrationTargetLabel(formatMessage, machines, notice.targetMachineId);
  const ref = migrationSupportRef(notice);

  const submit = async () => {
    if (!canCancelMigration(notice)) return;
    try {
      await api.post(`/agents/${agentId}/migration/cancel`, {
        migrationRef: ref,
        expectedRevision: notice.revision,
      });
      await onRefresh();
    } catch (nextError: unknown) {
      const value = nextError as {
        response?: { data?: { code?: string } };
      };
      const code = value.response?.data?.code;
      await onRefresh();
      const message = code === "MIGRATION_REVISION_STALE" || code === "MIGRATION_CONCURRENT_UPDATE"
        ? formatMessage({ id: "agent.migration.cancelDialogStaleError" })
        : formatMessage({ id: "agent.migration.cancelDialogGenericError" });
      const technicalCode = code && /^[A-Za-z][A-Za-z0-9_-]{1,127}$/.test(code) ? code : null;
      throw new Error(technicalCode ? `${message} (${technicalCode})` : message);
    }
  };

  return (
    <ConfirmDialog
      title={formatMessage({ id: "agent.migration.cancelDialogTitle" })}
      confirmLabel={formatMessage({ id: "agent.migration.cancelAction" })}
      loadingLabel={formatMessage({ id: "agent.migration.cancelDialogRequesting" })}
      cancelLabel={formatMessage({ id: "agent.migration.cancelDialogKeepAction" })}
      confirmIcon={<X size={14} aria-hidden="true" />}
      confirmColor="bg-brutal-orange"
      confirmDisabled={!canCancelMigration(notice)}
      maxWidthClass="max-w-md"
      plainMessage
      chromeLocale="active"
      onClose={onClose}
      onConfirm={submit}
      message={
        <div className="space-y-3">
          <Banner
            intent="warning"
            density="sm"
            title={formatMessage({ id: "agent.migration.cancelDialogSafetyTitle" })}
          >
            {formatMessage({ id: "agent.migration.cancelDialogSafeMessage" }, { source, target })}
          </Banner>
          <MigrationReference notice={notice} />
          <p className="text-xs text-foreground-muted theme-brutal:text-black/60">
            {formatMessage({ id: "agent.migration.cancelDialogExplanation" })}
          </p>
        </div>
      }
    />
  );
}
