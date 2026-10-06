import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useIntl } from "react-intl";
import {
  Button,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
} from "raft-ui";
import { X } from "lucide-react";
import api from "../../api/client";
import Modal from "../Modal";
import Banner from "../ui/Banner";
import CloseButton from "../ui/CloseButton";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import type { Agent } from "../../store/agentStore";
import type { Machine } from "../../store/machineStore";
import { isMigrationProPlanRequiredError } from "./billing";
import type { MigrationErrorPresentation } from "./errors";
import { migrationStartErrorPresentation } from "./presentation";
import { MigrationErrorContent } from "./MigrationErrorContent";

interface MigrationStartResponse {
  migrationRef: string;
  state: string;
  sourceMachineId: string;
  targetMachineId: string;
  deadlines?: Record<string, string>;
}

export function AgentMigrationDialog({
  agent,
  machines,
  sourceMachineId,
  onClose,
  onProRequired,
  onStarted,
}: {
  agent: Agent;
  machines: Machine[];
  sourceMachineId: string | null;
  onClose: () => void;
  onProRequired: () => void;
  onStarted: (result: MigrationStartResponse) => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const targetComputers = useMemo(() =>
    machines.filter((machine) =>
      machine.id !== sourceMachineId &&
      machine.isComputer === true
    ),
  [machines, sourceMachineId]);
  const targetComputerOptions = useMemo(() =>
    targetComputers.map((machine) => ({
      value: machine.id,
      label: machine.name,
    })),
  [targetComputers]);
  const [targetComputer, setTargetComputer] = useState(targetComputers[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<MigrationErrorPresentation | null>(null);
  const selectedTargetComputer = targetComputers.some((machine) => machine.id === targetComputer)
    ? targetComputer
    : targetComputers[0]?.id ?? "";
  const sourceComputerName = machines.find((machine) => machine.id === sourceMachineId)?.name;
  const targetComputerName = machines.find((machine) => machine.id === selectedTargetComputer)?.name;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTargetComputer) return;
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await api.post<MigrationStartResponse>(`/agents/${agent.id}/migrate`, {
        targetComputer: selectedTargetComputer,
      });
      await onStarted(data);
    } catch (err: unknown) {
      if (isMigrationProPlanRequiredError(err)) {
        onProRequired();
        return;
      }
      setError(migrationStartErrorPresentation(err, formatMessage, {
        sourceComputerName,
        targetComputerName,
        sourceComputerId: sourceMachineId,
        targetComputerId: selectedTargetComputer,
      }));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal onClose={onClose} closeOnBackdrop>
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md border theme-brutal:border-2 border-line-muted theme-brutal:border-black bg-layer-panel theme-brutal:bg-white shadow-raft-md theme-brutal:shadow-brutal"
      >
        <div className="flex items-center justify-between border-b theme-brutal:border-b-2 border-line-muted theme-brutal:border-black px-4 py-3">
          <h2 className="text-base font-bold text-foreground-strong theme-brutal:text-black">
            {formatMessage({ id: "agent.detail.moveToAnotherComputer" })}
          </h2>
          <CloseButton
            type="button"
            onClick={onClose}
            className="flex size-7 items-center justify-center"
            title={formatMessage({ id: "common.close" })}
          >
            <X size={14} />
          </CloseButton>
        </div>
        <div className="space-y-4 p-4">
          <div>
            <label
              id="agent-migration-target-computer-label"
              className="mb-1 block text-xs font-bold uppercase tracking-wide text-foreground-muted theme-brutal:text-black/55"
            >
              {formatMessage({ id: "agent.detail.targetComputer" })}
            </label>
            <Select
              value={selectedTargetComputer || null}
              onValueChange={(value) => {
                if (value == null) return;
                setTargetComputer(value);
              }}
              disabled={submitting || targetComputers.length === 0}
              items={targetComputerOptions}
            >
              <SelectTrigger
                className="w-full"
                aria-labelledby="agent-migration-target-computer-label"
              >
                <SelectValue placeholder={formatMessage({ id: "agent.detail.noOtherAttachedComputer" })} />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent>
                <SelectList>
                  {targetComputerOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <SelectItemText>{option.label}</SelectItemText>
                      <SelectItemIndicator />
                    </SelectItem>
                  ))}
                </SelectList>
              </SelectContent>
            </Select>
          </div>
          <div className="border border-line-muted theme-brutal:border-black/15 bg-fill-muted theme-brutal:bg-black/[0.03] p-2 text-xs font-bold text-foreground-muted theme-brutal:text-black/60">
            {formatMessage({ id: "agent.detail.migrationModeStopBeforeExport" })}
          </div>
          <div className="border border-line-muted theme-brutal:border-black/15 bg-fill-muted theme-brutal:bg-black/[0.03] p-2 text-xs font-bold text-foreground-muted theme-brutal:text-black/60">
            {formatMessage({ id: "agent.detail.migrationSessionResetDetailed" })}
          </div>
          {error ? (
            <Banner intent="warning" density="sm">
              <MigrationErrorContent presentation={error} />
            </Banner>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t theme-brutal:border-t-2 border-line-muted theme-brutal:border-black bg-layer-inset theme-brutal:bg-gray-50 px-4 py-3">
          {error?.recovery === "open_computers_and_retry" ? (
            <Button variant="outline" size="md"
              type="button"
              onClick={() => {
                onClose();
                if (error.recoveryComputerId) {
                  nav.toComputer(error.recoveryComputerId);
                } else {
                  nav.toComputers();
                }
              }}
              className=""
              disabled={submitting}
            >
              {formatMessage({ id: "agent.migration.error.openComputers" })}
            </Button>
          ) : null}
          <Button variant="outline" size="md"
            type="button"
            onClick={onClose}
            className=""
            disabled={submitting}
          >
            {formatMessage({ id: "agent.detail.cancel" })}
          </Button>
          <Button variant="success" size="md"
            type="submit"
            disabled={submitting || !selectedTargetComputer}
          >
            {submitting
              ? formatMessage({ id: "agent.detail.starting" })
              : error?.recovery === "open_computers_and_retry"
                ? formatMessage({ id: "agent.migration.error.tryAgain" })
                : formatMessage({ id: "agent.detail.startMigration" })}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
