import { useState } from "react";
import { useIntl } from "react-intl";
import { RotateCcw } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "raft-ui";
import { useAgentStore } from "../../store/agentStore";
import Banner from "../ui/Banner";
import type { MessageId } from "../../i18n/messages";
import ConfirmDialog from "../ConfirmDialog";

type ResetMode = "restart" | "session" | "full";

export default function ResetAgentDialog({
  agentId,
  agentName,
  canFullReset,
  memberRuntimeOnly = false,
  onClose,
}: {
  agentId: string;
  agentName: string;
  canFullReset: boolean;
  memberRuntimeOnly?: boolean;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const [mode, setMode] = useState<ResetMode>("restart");
  const resetAgent = useAgentStore((s) => s.resetAgent);

  const handleReset = async () => {
    try {
      await resetAgent(agentId, mode);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      throw new Error(
        axiosErr.response?.data?.error
          || (err instanceof Error ? err.message : formatMessage({ id: "agent.reset.failed" })),
      );
    }
  };

  const options: { mode: ResetMode; labelId: MessageId; descId: MessageId }[] = memberRuntimeOnly
    ? [
        { mode: "restart", labelId: "agent.reset.restartModel", descId: "agent.reset.restartModelDesc" },
        { mode: "session", labelId: "agent.reset.model", descId: "agent.reset.modelDesc" },
      ]
    : [
        { mode: "restart", labelId: "agent.reset.restart", descId: "agent.reset.restartDesc" },
        { mode: "session", labelId: "agent.reset.session", descId: "agent.reset.sessionDesc" },
        ...(canFullReset
          ? [{ mode: "full" as const, labelId: "agent.reset.full" as const, descId: "agent.reset.fullDesc" as const }]
          : []),
      ];

  const selectedOption = options.find((o) => o.mode === mode)!;
  // Severity now rides the semantic Button variant instead of the legacy
  // `confirmColor` colour-string, which ConfirmDialog only kept around to map
  // back onto these same three tones via CONFIRM_TONES_BY_LEGACY_COLOR.
  // Restart is `primary`, not `information`: rui's elegant `information` pairs
  // white text with a light cyan fill (measured 1.91:1 in Elegant light), which
  // this dialog used to paper over with `!text-black`. `primary` measures
  // >=12.75:1 in all three themes by itself, so no override is needed.
  const confirmVariant = mode === "full" ? "danger" : mode === "session" ? "warning" : "primary";

  return (
    <ConfirmDialog
      title={formatMessage({ id: "agent.reset.title" }, { name: agentName })}
      maxWidthClass="max-w-md"
      plainMessage
      message={(
        <div className="space-y-3">
          {/* Standard rui RadioGroup. These were three hand-rolled <button>s
              carrying their own border/tint/hover rules, which is why they read
              as Brutal panels under every theme (@Artea, task #660). The group
              is a single-select list, so the radio semantics come free: arrow
              keys, one tab stop, and a real checked state for assistive tech. */}
          <RadioGroup
            value={mode}
            onValueChange={(value) => setMode(value as ResetMode)}
            aria-label={formatMessage({ id: "agent.reset.title" }, { name: agentName })}
            className="gap-3"
          >
            {options.map((opt) => (
              <label key={opt.mode} className="flex items-start gap-3">
                <RadioGroupItem
                  value={opt.mode}
                  className="mt-0.5 shrink-0"
                  data-testid={`agent-reset-option-${opt.mode}`}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-bold uppercase">{formatMessage({ id: opt.labelId })}</span>
                  <span className="mt-1 block text-xs text-foreground-muted">{formatMessage({ id: opt.descId })}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
          {mode === "full" && (
            <Banner intent="warning" density="sm" withIcon className="font-bold">
              {formatMessage({ id: "agent.reset.fullWarning" })}
            </Banner>
          )}
        </div>
      )}
      chromeLocale="active"
      confirmLabel={formatMessage({ id: selectedOption.labelId })}
      loadingLabel={formatMessage({ id: "agent.reset.loading" })}
      confirmIcon={<RotateCcw size={14} />}
      confirmVariant={confirmVariant}
      onConfirm={handleReset}
      onClose={onClose}
    />
  );
}
