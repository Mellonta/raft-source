import { useIntl } from "react-intl";
import ConfirmDialog from "../ConfirmDialog";

export function AgentMigrationUpgradeDialog({
  onClose,
  onViewPlans,
}: {
  onClose: () => void;
  onViewPlans: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <ConfirmDialog
      title={formatMessage({ id: "agent.migration.proRequired.title" })}
      message={(
        <div className="space-y-3 text-sm leading-relaxed text-foreground-strong theme-brutal:text-black/75">
          <p>{formatMessage({ id: "agent.migration.proRequired.description" })}</p>
          <p className="font-bold text-foreground-strong theme-brutal:text-black">
            {formatMessage({ id: "agent.migration.proRequired.preservedAccess" })}
          </p>
        </div>
      )}
      confirmLabel={formatMessage({ id: "agent.migration.proRequired.viewPlans" })}
      confirmColor="bg-brutal-lime"
      onConfirm={onViewPlans}
      onClose={onClose}
      plainMessage
      chromeLocale="active"
      maxWidthClass="max-w-md"
    />
  );
}
