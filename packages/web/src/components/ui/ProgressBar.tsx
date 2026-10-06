import { Progress, ProgressTrack, ProgressIndicator } from "raft-ui";
import type { HTMLAttributes } from "react";
import { useContext } from "react";
import { IntlContext } from "react-intl";
import { en } from "../../i18n/messages/en";

/** Product labels and value normalization over the themed RUI progress recipe. */
export type ProgressBarTone = "pink" | "cyan" | "lime" | "orange";

const TONE_CLASS: Record<ProgressBarTone, "accent" | "information" | "success" | "warning"> = {
  pink: "accent",
  cyan: "information",
  lime: "success",
  orange: "warning",
};

export interface ProgressBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "role"> {
  /** 0–100 for a determinate bar; omit (or null) for an indeterminate stripe. */
  value?: number | null;
  /** Fill color. Defaults to pink (CTA), matching the Upgrade button. */
  tone?: ProgressBarTone;
  /** Optional phase / status label rendered above the track (left). */
  label?: string;
  /** Show the numeric percent at the right of the label row (determinate only). */
  showPercent?: boolean;
}

export default function ProgressBar({
  value = null,
  tone = "pink",
  label,
  showPercent = false,
  className = "",
  ...rest
}: ProgressBarProps) {
  const intl = useContext(IntlContext);
  const indeterminate = value === null || value === undefined || Number.isNaN(value);
  const pct = indeterminate ? 0 : Math.max(0, Math.min(100, value));
  const defaultAriaLabel =
    intl?.formatMessage({ id: "ui.progressBar.ariaLabel" }) ?? en["ui.progressBar.ariaLabel"];

  return (
    <div className={className} {...rest}>
      {(label || (showPercent && !indeterminate)) && (
        <div className="mb-1 flex items-center justify-between text-xs font-mono text-foreground-muted theme-brutal:text-black/60">
          {label ? <span className="truncate">{label}</span> : <span />}
          {showPercent && !indeterminate && <span className="shrink-0">{Math.round(pct)}%</span>}
        </div>
      )}
      <Progress value={indeterminate ? null : pct} variant={TONE_CLASS[tone]} aria-label={label ?? defaultAriaLabel}>
        <ProgressTrack>
          <ProgressIndicator />
        </ProgressTrack>
      </Progress>
    </div>
  );
}
