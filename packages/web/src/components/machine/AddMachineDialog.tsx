import CloseButton from "../ui/CloseButton";
import { Input, Card, Checkbox, Button, Status } from "raft-ui";
import { useState, useEffect, useRef } from "react";
import { X, CheckCircle, Monitor, Cloud } from "lucide-react";
import { useIntl } from "react-intl";
import { useMachineStore } from "../../store/machineStore";
import { useComputerConnectionWatch } from "../../hooks/useComputerConnectionWatch";
import { useServerStore } from "../../store/serverStore";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { getServerUrl } from "../../utils/server";
// The baseline/resolver import staging still carries is gone here: this dialog's
// connect state machine lives in useComputerConnectionWatch now, shared with onboarding.
import { getComputerCommands } from "../../utils/computerSetupCommand";
import { PLAN_CONFIG, getEffectiveLimits } from "@botiverse/raft-shared";
import type { ServerPlan } from "@botiverse/raft-shared";
import Modal from "../Modal";
import FormField from "../ui/FormField";
import Banner from "../ui/Banner";
import ComputerCommandGuide from "./ComputerCommandGuide";

function isQuotaError(error: string): boolean {
  return error.includes("limit reached");
}

type DialogStep = "type" | "waiting" | "connected";
type MachineType = "local" | "cloud";

export default function AddMachineDialog({ onClose }: { onClose: () => void }) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const [step, setStep] = useState<DialogStep>("type");
  const [machineType, setMachineType] = useState<MachineType>("local");
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [machineId, setMachineId] = useState("");
  const [registeredMachineId, setRegisteredMachineId] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmedComputerMatch, setConfirmedComputerMatch] = useState(false);
  const connectedComputerConfirmationRef = useRef<{ machineId: string; requiresConfirmation: boolean } | null>(null);

  const registerMachine = useMachineStore((s) => s.registerMachine);
  const renameMachine = useMachineStore((s) => s.renameMachine);
  const serverSlug = useServerStore((s) => s.current?.slug);
  const deleteMachine = useMachineStore((s) => s.deleteMachine);
  const machines = useMachineStore((s) => s.machines);

  const plan = (useServerStore((s) => s.current?.plan) || "free") as ServerPlan;
  const maxMachines = getEffectiveLimits(plan).maxMachines;
  const atLimit = maxMachines !== -1 && machines.length >= maxMachines;

  const serverUrl = getServerUrl();


  // Watch for the machine coming online. The detection, the baseline, and the
  // dropped-event polling fallback all live in the shared watch — the onboarding
  // setup gate asks the same questions and must not answer them differently.
  // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
  const pendingMachine = machineId ? machines.find((m) => m.id === machineId) : null;
  // oxlint-disable-next-line react-doctor/no-event-handler -- Same YMNNE-family async waiter as `pendingMachine` above: the watch observes daemon connect, it is not an event handler.
  const connectWatchActive = step === "waiting";
  // oxlint-disable-next-line react-doctor/no-event-handler -- Ditto: the pending row id is the thing being waited on.
  const connectWatchPendingId = machineId;
  const connectionProgress = useComputerConnectionWatch({
    active: connectWatchActive,
    pendingMachineId: connectWatchPendingId,
  });
  const connectedMachine = connectionProgress.state === "connected" ? connectionProgress.machine : null;
  const connectedRequiresConfirmation = connectionProgress.state === "connected" &&
    connectionProgress.requiresConfirmation;
  const isConnected = Boolean(connectedMachine);
  const connectedComputerConfirmation = connectedComputerConfirmationRef.current;
  const needsComputerMatchConfirmation = step === "connected" &&
    Boolean(pendingMachine?.isComputer) &&
    machineId !== registeredMachineId &&
    (connectedComputerConfirmation?.machineId === machineId ? connectedComputerConfirmation.requiresConfirmation : true);
  const canFinishConnectedStep = step === "connected" && (!needsComputerMatchConfirmation || confirmedComputerMatch);

  // One-shot prefill waiter: during the Add Machine setup wizard, the daemon
  // registers and then comes online over the socket. When it does, advance
  // the wizard from "waiting" → "connected" and pre-fill the name field with
  // the daemon-reported hostname (saving the user a manual type). NOT a
  // mirror-prop pattern — it's a wait-for-async-event seed, and a
  // useState-initializer refactor would require remounting the dialog when
  // `isConnected` flips and would lose the wizard's place. Same shape as
  // CreateAgentDialog's `prefilledMachineId` waiter (PR #2524).
  // oxlint-disable-next-line react-doctor/no-cascading-set-state -- One-shot async waiter seeds wizard state after daemon/Computer connect; splitting would lose the modal progression contract.
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family async waiter, not a render mirror.
    if (connectedMachine && step === "waiting") {
      // oxlint-disable-next-line react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
      setStep("connected");
      // The Computer setup command creates/resumes its own linked machine row
      // instead of using the daemon placeholder created for the legacy command.
      // When that row comes online, pivot the wizard to the real connected row.
      if (connectedMachine.id !== machineId) {
        connectedComputerConfirmationRef.current = {
          machineId: connectedMachine.id,
          requiresConfirmation: connectedRequiresConfirmation,
        };
        // oxlint-disable-next-line react-doctor/no-chain-state-updates, react-doctor/no-derived-state -- This is not render-derived state; it records the concrete connected row for Done/rename/navigation.
        setMachineId(connectedMachine.id);
      }
      // Pre-fill name with hostname from daemon
      if (connectedMachine.hostname) {
        // oxlint-disable-next-line react-doctor/no-derived-state
        setName(connectedMachine.hostname);
      }
    }
  }, [connectedMachine, connectedRequiresConfirmation, machineId, step]);

  // The dropped-event polling fallback now lives in useComputerConnectionWatch,
  // alongside the baseline it belongs with.

  const handleSelectType = async () => {
    setRegistering(true);
    setError("");
    setConfirmedComputerMatch(false);
    connectedComputerConfirmationRef.current = null;
    try {
      const result = await registerMachine("my-computer");
      setApiKey(result.apiKey);
      setMachineId(result.machine.id);
      setRegisteredMachineId(result.machine.id);
      setStep("waiting");
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "machine.add.registerFailed" }));
    } finally {
      setRegistering(false);
    }
  };

  const handleCancel = async () => {
    // If we created a raw daemon placeholder but never confirmed a Computer
    // pivot, clean the placeholder rather than treating the heuristic match as
    // the final operation target.
    if (registeredMachineId && (!isConnected || (needsComputerMatchConfirmation && !confirmedComputerMatch))) {
      try {
        await deleteMachine(registeredMachineId);
      } catch {
        // ignore cleanup error
      }
    }
    onClose();
  };

  const handleDone = async () => {
    if (needsComputerMatchConfirmation && !confirmedComputerMatch) return;
    const finalName = name.trim() || pendingMachine?.hostname || "";
    if (finalName && machineId && finalName !== "my-computer") {
      setSaving(true);
      try {
        await renameMachine(machineId, finalName);
      } catch {
        // ignore — name stays as default
      } finally {
        setSaving(false);
      }
    }
    if (registeredMachineId && registeredMachineId !== machineId) {
      try {
        await deleteMachine(registeredMachineId);
      } catch {
        // ignore cleanup error
      }
    }
    useMachineStore.getState().clearPendingApiKey();
    onClose();
    nav.toMachine(machineId);
  };

  const deploymentEnv = import.meta.env?.VITE_DEPLOYMENT_ENV;
  const computerCommands = getComputerCommands(serverSlug, deploymentEnv, serverUrl, {
    legacyApiKey: apiKey,
  });
  const windowsComputerCommands = getComputerCommands(serverSlug, deploymentEnv, serverUrl, {
    legacyApiKey: apiKey,
    platform: "windows",
  });
  const computerSetupCommand = computerCommands?.setup ?? null;
  const computerInstall = computerCommands?.install ?? null;
  const windowsComputerSetupCommand = windowsComputerCommands?.setup ?? null;
  const windowsComputerInstall = windowsComputerCommands?.install ?? null;

  return (
    <Modal onClose={canFinishConnectedStep ? handleDone : handleCancel}>
      <Card className="w-full max-w-lg p-6">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold uppercase">
            {step === "type" && formatMessage({ id: "machine.add.title.add" })}
            {step === "waiting" && formatMessage({ id: "machine.add.title.connect" })}
            {step === "connected" && formatMessage({ id: "machine.add.title.connected" })}
          </h2>
          <CloseButton
            aria-label={formatMessage({ id: "common.close" })}
            onClick={canFinishConnectedStep ? handleDone : handleCancel}
            className="p-1"
          >
            <X size={20} />
          </CloseButton>
        </div>

        {atLimit && step === "type" && (
          <Banner intent="warning" className="mb-4 font-bold">
            {formatMessage(
              { id: "machine.add.limitReached" },
              { count: machines.length, max: maxMachines, plan: PLAN_CONFIG[plan].displayName },
            )}{" "}
            <button
              type="button"
              onClick={() => {
                onClose();
                nav.toSettings("billing");
              }}
              className="font-bold text-foreground-strong theme-brutal:text-black underline"
            >
              {formatMessage({ id: "machine.add.upgradeForMore" })}
            </button>
          </Banner>
        )}
        {error && !atLimit && (
          <Banner intent="warning" className="mb-4 font-bold">
            {error}
            {isQuotaError(error) && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    nav.toSettings("billing");
                  }}
                  className="font-bold text-foreground-strong theme-brutal:text-black underline"
                >
                  {formatMessage({ id: "machine.add.viewPlans" })}
                </button>
              </>
            )}
          </Banner>
        )}

        {/* Step 1: Choose machine type */}
        {step === "type" && (
          <div>
            <div className="mb-4 flex gap-2">
              <button
                type="button"
                aria-pressed={machineType === "local"}
                onClick={() => setMachineType("local")}
                className={`flex-1 flex items-center gap-2 border p-3 text-left transition-colors rounded-md theme-brutal:rounded-none theme-brutal:border-2 ${
                  machineType === "local"
                    ? "border-line-muted theme-brutal:border-black bg-primary-400 text-primary-950 font-bold shadow-[0_0_0_1px_var(--primary-edge)] theme-brutal:bg-soft-signal theme-brutal:text-black theme-brutal:shadow-brutal-sm"
                    : "border-line-muted theme-brutal:border-black/30 bg-layer-panel theme-brutal:bg-white hover:border-line-strong theme-brutal:hover:border-black"
                }`}
              >
                <Monitor size={18} className={`shrink-0 ${machineType === "local" ? "text-primary-950 theme-brutal:text-black" : "text-foreground-strong theme-brutal:text-black"}`} />
                <div>
                  <div className="text-sm font-bold uppercase">
                    {formatMessage({ id: "machine.add.yourComputer" })}
                  </div>
                  <div className={`text-xs font-normal normal-case ${machineType === "local" ? "text-primary-950/70 theme-brutal:text-black/50" : "text-foreground-muted theme-brutal:text-black/50"}`}>
                    {formatMessage({ id: "machine.add.yourComputerDescription" })}
                  </div>
                </div>
              </button>
              <div
                className="flex-1 flex items-center gap-2 border border-dashed border-line-muted theme-brutal:border-2 theme-brutal:border-black/30 bg-layer-panel theme-brutal:bg-white p-3 text-left cursor-not-allowed rounded-md theme-brutal:rounded-none"
              >
                <Cloud size={18} className="text-foreground-muted theme-brutal:text-black/25 shrink-0" />
                <div>
                  <div className="text-sm font-bold uppercase text-foreground-muted theme-brutal:text-black/30">{formatMessage({ id: "machine.add.cloudComputer" })}</div>
                  <div className="text-xs text-foreground-muted theme-brutal:text-black/25 font-normal normal-case">{formatMessage({ id: "machine.add.comingSoon" })}</div>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3">
              <Button
                size="md"
                variant="outline"
                type="button"
                onClick={handleCancel}
              >
                {formatMessage({ id: "common.confirm.cancel" })}
              </Button>
              <Button
                size="md"
                variant="accent"
                type="button"
                onClick={handleSelectType}
                disabled={registering || atLimit}
                className="disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {registering
                  ? formatMessage({ id: "machine.add.settingUp" })
                  : formatMessage({ id: "common.announcement.next" })}
              </Button>
            </div>
          </div>
        )}

        {/* Step 2: Waiting for connection */}
        {step === "waiting" && (
          <div>
            <ComputerCommandGuide
              className="mb-4"
              computerCommand={computerSetupCommand}
              computerInstallCommand={computerInstall}
              windowsComputerCommand={windowsComputerSetupCommand}
              windowsComputerInstallCommand={windowsComputerInstall}
            />

            {/* Waiting indicator */}
            <Banner
              intent="info"
              className="mb-4"
              // rui Banner only lays out a leading indicator that is an <svg> or a
              // `data-slot="status"` element (its own Status). The old custom
              // StatusDot was a plain <span>, so the grid put the text in row 1 and
              // the dot underneath it (task #665).
              icon={<Status variant="warning" pulse />}
            >
              <span className="font-bold text-foreground-strong theme-brutal:text-black">
                {formatMessage({ id: "machine.add.waitingForConnect" })}
              </span>
            </Banner>

            <div className="flex justify-end gap-3">
              <Button
                size="md"
                variant="outline"
                type="button"
                onClick={handleCancel}
              >
                {formatMessage({ id: "common.confirm.cancel" })}
              </Button>
              <Button
                size="md"
                variant="success"
                type="button"
                disabled
                className="disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {formatMessage({ id: "machine.add.done" })}
              </Button>
            </div>
          </div>
        )}

        {/* Step 3: Connected — name the machine */}
        {step === "connected" && (
          <div>
            <div className="mb-4 flex items-center gap-3 rounded-md border border-line-muted bg-success-soft p-4 theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black">
              <CheckCircle size={24} className="text-foreground-strong theme-brutal:text-black shrink-0" />
              <div>
                <div className="font-bold text-sm text-foreground-strong theme-brutal:text-black">
                  {formatMessage({ id: "machine.add.connectedSuccessfully" })}
                </div>
                {pendingMachine?.hostname && (
                  <div className="text-xs text-foreground-muted theme-brutal:text-black/60 font-mono mt-0.5">
                    {pendingMachine.hostname} — {pendingMachine.os || formatMessage({ id: "machine.add.unknownOs" })}
                  </div>
                )}
              </div>
            </div>

            <FormField
              label={formatMessage({ id: "machine.add.computerName" })}
              hint={formatMessage({ id: "machine.add.computerNameHint" })}
              className="mb-4"
            >
              <Input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full text-sm"
                placeholder={pendingMachine?.hostname || formatMessage({ id: "machine.add.computerNamePlaceholder" })}
                autoFocus
              />
            </FormField>

            {needsComputerMatchConfirmation && (
              <label className="mb-4 flex items-start gap-2 border-2 border-line-muted theme-brutal:border-black bg-layer-panel theme-brutal:bg-white p-3 text-sm font-bold">
                <Checkbox
                  checked={confirmedComputerMatch}
                  onCheckedChange={(event) => setConfirmedComputerMatch(event)}
                  className="mt-0.5"
                  aria-label={formatMessage({ id: "machine.add.confirmComputerMatch" }, { hostname: pendingMachine?.hostname ? ` (${pendingMachine.hostname})` : "" })}
                />
                <span>
                  {formatMessage(
                    { id: "machine.add.confirmComputerMatch" },
                    { hostname: pendingMachine?.hostname ? ` (${pendingMachine.hostname})` : "" },
                  )}
                </span>
              </label>
            )}

            <div className="flex justify-end">
              <Button
                size="md"
                variant="success"
                type="button"
                onClick={handleDone}
                disabled={saving || (needsComputerMatchConfirmation && !confirmedComputerMatch)}
                className="disabled:opacity-50"
              >
                {saving
                  ? formatMessage({ id: "machine.add.saving" })
                  : formatMessage({ id: "machine.add.done" })}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </Modal>
  );
}
