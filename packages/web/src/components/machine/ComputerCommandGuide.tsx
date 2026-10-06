import Tooltip from "../ui/Tooltip";
import { Badge, SegmentedControl, SegmentedControlItem, SegmentedControlLabel, CopyableCodeRoot, CopyableCode, CopyableCodeAction } from "raft-ui";
import { useState } from "react";
import { Terminal } from "lucide-react";
import { useIntl } from "react-intl";
import type { ComputerCommandPlatform } from "../../utils/computerSetupCommand";
import SectionEyebrow from "../ui/SectionEyebrow";

interface ComputerCommandGuideProps {
  computerCommand: string | null;
  computerInstallCommand: string | null;
  windowsComputerCommand?: string | null;
  windowsComputerInstallCommand?: string | null;
  className?: string;
  onPlatformChange?: (platform: ComputerCommandPlatform) => void;
}

// Raft Computer is the only connect path. The standalone daemon connect
// command is retired: the daemon is no longer published on its own and this
// guide never offers it (docs/operations/computer-release-version.md).

type CopyTarget =
  | "mac-linux-install"
  | "mac-linux-setup"
  | "windows-install"
  | "windows-setup";

interface CommandStep {
  target: CopyTarget;
  label?: string;
  command: string;
  copyCommand?: string;
  copyAriaLabel: string;
}

interface ComputerStepLabels {
  install: string;
  setup: string;
  copyInstall: string;
  copySetup: string;
}

function getComputerSteps(
  platform: ComputerCommandPlatform,
  macLinuxInstall: string | null,
  macLinuxSetup: string | null,
  windowsInstall: string | null,
  windowsSetup: string | null,
  labels: ComputerStepLabels,
): CommandStep[] {
  const install = platform === "windows" ? windowsInstall : macLinuxInstall;
  const setup = platform === "windows" ? windowsSetup : macLinuxSetup;
  const prefix = platform === "windows" ? "windows" : "mac-linux";
  const steps: CommandStep[] = [];

  if (install) {
    steps.push({ target: `${prefix}-install`, label: labels.install, command: install, copyAriaLabel: labels.copyInstall });
  }
  if (setup) {
    steps.push({ target: `${prefix}-setup`, label: labels.setup, command: setup, copyAriaLabel: labels.copySetup });
  }
  return steps;
}

function CommandRows({
  steps,
  copiedCommand,
  onCopy,
}: {
  steps: readonly CommandStep[];
  copiedCommand: CopyTarget | null;
  onCopy: (target: CopyTarget) => void;
}) {
  return (
    <div className="space-y-3">
      {steps.map(({ target, label, command, copyAriaLabel }) => (
        <div key={target}>
          {label ? <div className="mb-1 text-xs font-bold text-foreground-muted theme-brutal:text-black/60">{label}</div> : null}
          <CopyableCodeRoot
            copied={copiedCommand === target}
            onCopy={() => onCopy(target)}
          >
            <CopyableCode className="min-w-0 flex-1 px-3 py-2 font-mono text-xs break-all">
              {command}
            </CopyableCode>
            <Tooltip content={copyAriaLabel}>
              <CopyableCodeAction
                aria-label={copyAriaLabel}
                className="shrink-0"
              />
            </Tooltip>
          </CopyableCodeRoot>
        </div>
      ))}
    </div>
  );
}

export default function ComputerCommandGuide({
  computerCommand,
  computerInstallCommand,
  windowsComputerCommand = null,
  windowsComputerInstallCommand = null,
  className = "",
  onPlatformChange,
}: ComputerCommandGuideProps) {
  const { formatMessage } = useIntl();
  const [platform, setPlatform] = useState<ComputerCommandPlatform>("mac-linux");
  const [copiedCommand, setCopiedCommand] = useState<CopyTarget | null>(null);

  const isComputerGuide = Boolean(
    computerCommand || computerInstallCommand || windowsComputerCommand || windowsComputerInstallCommand,
  );
  const selectedComputerSteps = getComputerSteps(
    platform,
    computerInstallCommand,
    computerCommand,
    windowsComputerInstallCommand,
    windowsComputerCommand,
    {
      install: formatMessage({ id: "machine.commandGuide.installStep" }),
      setup: formatMessage({ id: "machine.commandGuide.setupStep" }),
      copyInstall: formatMessage({ id: "machine.commandGuide.copyInstallCommand" }),
      copySetup: formatMessage({ id: "machine.commandGuide.copySetupCommand" }),
    },
  );
  const displayedComputerSteps = selectedComputerSteps.length === 1
    ? [{
      ...selectedComputerSteps[0],
      label: undefined,
      copyAriaLabel: formatMessage({ id: "machine.commandGuide.copyComputerCliCommand" }),
    }]
    : selectedComputerSteps;

  const handleCopy = (target: CopyTarget) => {
    setCopiedCommand(target);
    setTimeout(() => {
      setCopiedCommand((current) => (current === target ? null : current));
    }, 2000);
  };

  return (
    <div className={className}>
      <div className="mb-2 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="flex items-center gap-2">
          <Terminal size={16} className="text-foreground-strong theme-brutal:text-black" />
          <SectionEyebrow as="div">{formatMessage({ id: "machine.commandGuide.connectCommand" })}</SectionEyebrow>
        </div>
        <SegmentedControl<ComputerCommandPlatform>
          value={platform}
          onValueChange={(next) => {
            setPlatform(next);
            onPlatformChange?.(next);
          }}
          aria-label={formatMessage({ id: "machine.commandGuide.choosePlatform" })}
          className="shrink-0"
        >
          <SegmentedControlItem value="mac-linux" data-testid="computer-command-platform-mac-linux">
            <SegmentedControlLabel>{formatMessage({ id: "machine.detail.macLinux" })}</SegmentedControlLabel>
          </SegmentedControlItem>
          <SegmentedControlItem value="windows" data-testid="computer-command-platform-windows">
            <SegmentedControlLabel>
              {isComputerGuide
                ? formatMessage({ id: "machine.commandGuide.windowsX64" })
                : formatMessage({ id: "machine.commandGuide.windows" })}
            </SegmentedControlLabel>
          </SegmentedControlItem>
        </SegmentedControl>
      </div>

      <p className="mb-2 text-xs leading-5 text-foreground-muted theme-brutal:text-black/60">
        {isComputerGuide && platform === "windows"
          ? formatMessage({ id: "machine.commandGuide.windowsComputerDescription" })
          : isComputerGuide && computerCommand
            ? formatMessage({ id: "machine.commandGuide.macLinuxComputerDescription" })
            : formatMessage({ id: "machine.commandGuide.generateFreshConnect" })}
      </p>

      {isComputerGuide && platform === "windows" ? (
        <div className="space-y-3" data-testid="windows-computer-command-block">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-xs font-bold uppercase tracking-wide text-foreground-muted theme-brutal:text-black/70">
                {formatMessage({ id: "machine.commandGuide.raftComputerWindowsX64" })}
              </div>
              <Badge.Experimental />
            </div>
          {displayedComputerSteps.length > 0 ? (
            <CommandRows
              steps={displayedComputerSteps}
              copiedCommand={copiedCommand}
              onCopy={(target) => handleCopy(target)}
            />
          ) : (
            <div className="border-2 border-line-muted theme-brutal:border-black/30 bg-layer-panel theme-brutal:bg-white px-3 py-2 text-xs font-bold text-foreground-muted theme-brutal:text-black/50">
              {formatMessage({ id: "machine.commandGuide.generateFreshComputerConnect" })}
            </div>
          )}
        </div>
      ) : isComputerGuide && displayedComputerSteps.length > 0 ? (
        <CommandRows
          steps={displayedComputerSteps}
          copiedCommand={copiedCommand}
          onCopy={(target) => handleCopy(target)}
        />
      ) : (
        <div className="border-2 border-line-muted theme-brutal:border-black/30 bg-layer-panel theme-brutal:bg-white px-3 py-2 text-xs font-bold text-foreground-muted theme-brutal:text-black/50">
          {formatMessage({ id: "machine.commandGuide.generateFreshConnect" })}
        </div>
      )}
    </div>
  );
}
