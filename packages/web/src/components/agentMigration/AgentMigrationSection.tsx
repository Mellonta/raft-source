import { useCallback, useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { Button, Spinner } from "raft-ui";
import { MoveRight } from "lucide-react";
import Banner from "../ui/Banner";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import type { Agent } from "../../store/agentStore";
import { useMachineStore } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";
import { agentMigrationRequiresUpgrade } from "./billing";
import { migrationStatusErrorPresentation } from "./presentation";
import { canCancelMigration, isActiveMigrationState, isFailedMigrationState } from "./state";
import { useAgentMigrationStatus } from "./useAgentMigrationStatus";
import { useAgentMigrationUiEnabled } from "./useAgentMigrationUiEnabled";
import { AgentMigrationCancelDialog } from "./AgentMigrationCancelDialog";
import { AgentMigrationDialog } from "./AgentMigrationDialog";
import { AgentMigrationUpgradeDialog } from "./AgentMigrationUpgradeDialog";
import { MigrationErrorContent } from "./MigrationErrorContent";
import { MigrationProgressPanel } from "./MigrationProgressPanel";

/**
 * Move-to-another-computer action, live progress, and its dialogs. The caller
 * mounts this only where the viewer can manage a non-external agent.
 */
export function AgentMigrationSection({ agent }: { agent: Agent }) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const machines = useMachineStore((s) => s.machines);
  const billing = useServerStore((s) => s.billing);
  const loadingBilling = useServerStore((s) => s.loadingBilling);
  const loadBilling = useServerStore((s) => s.loadBilling);
  const uiEnabled = useAgentMigrationUiEnabled();
  const enabled = uiEnabled && Boolean(agent.machineId);
  const [showDialog, setShowDialog] = useState(false);
  const [showUpgradeDialog, setShowUpgradeDialog] = useState(false);
  const [showCancel, setShowCancel] = useState(false);

  const presentStatusError = useCallback(
    (error: { code?: string; message?: string }) => migrationStatusErrorPresentation(error, formatMessage),
    [formatMessage],
  );
  const { model, error: statusError, refresh } = useAgentMigrationStatus({
    agentId: agent.id,
    enabled,
    presentError: presentStatusError,
  });
  const notice = model.migration?.agentId === agent.id ? model.migration : null;
  const active = notice ? isActiveMigrationState(notice.state) : false;
  const canRetry = notice ? isFailedMigrationState(notice.state) : false;
  const requiresUpgrade = agentMigrationRequiresUpgrade(billing?.plan);
  const billingChecking = billing == null && loadingBilling;

  useEffect(() => {
    if (!enabled) return;
    void loadBilling();
  }, [enabled, loadBilling]);

  if (!enabled) return null;

  return (
    <>
      <Button variant="success" size="md"
        type="button"
        onClick={() => {
          if (requiresUpgrade) {
            setShowUpgradeDialog(true);
            return;
          }
          setShowDialog(true);
        }}
        disabled={active || billingChecking}
        aria-busy={billingChecking}
        className="w-full"
      >
        {active ? (
          <Spinner size="sm" aria-hidden="true" />
        ) : (
          <MoveRight size={14} aria-hidden="true" />
        )}
        {active
          ? formatMessage({ id: "agent.detail.migrationInProgress" })
          : canRetry
            ? formatMessage({ id: "agent.detail.tryMigrationAgain" })
            : formatMessage({ id: "agent.detail.moveToAnotherComputer" })}
      </Button>
      {notice ? (
        <MigrationProgressPanel
          notice={notice}
          machines={machines}
          onShowCancel={() => setShowCancel(true)}
        />
      ) : null}
      {statusError ? (
        <Banner
          intent="warning"
          density="sm"
          title={formatMessage({ id: "agent.detail.migrationStatusUnavailable" })}
        >
          <MigrationErrorContent presentation={statusError} />
        </Banner>
      ) : null}

      {showDialog && (
        <AgentMigrationDialog
          agent={agent}
          machines={machines}
          sourceMachineId={agent.machineId ?? null}
          onClose={() => setShowDialog(false)}
          onProRequired={() => {
            setShowDialog(false);
            setShowUpgradeDialog(true);
            void loadBilling();
          }}
          onStarted={async () => {
            setShowDialog(false);
            await refresh();
          }}
        />
      )}

      {showUpgradeDialog && (
        <AgentMigrationUpgradeDialog
          onClose={() => setShowUpgradeDialog(false)}
          onViewPlans={() => nav.toSettings("billing")}
        />
      )}

      {showCancel && notice && canCancelMigration(notice) && (
        <AgentMigrationCancelDialog
          agentId={agent.id}
          notice={notice}
          machines={machines}
          onClose={() => setShowCancel(false)}
          onRefresh={refresh}
        />
      )}
    </>
  );
}
