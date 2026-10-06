import { Check, Copy } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";
import Tooltip from "./Tooltip";

type CopyIconButtonSurface = "dark" | "light" | "code";

interface CopyIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  copied: boolean;
  copiedLabel: string;
  copyLabel: string;
  surface?: CopyIconButtonSurface;
  iconSize?: number;
}

const surfaceClasses: Record<CopyIconButtonSurface, { copied: string; idle: string }> = {
  code: {
    copied: "r-code-copy r-code-copy--copied",
    idle: "r-code-copy",
  },
  dark: {
    copied: "text-brutal-lime",
    idle: "text-white/0 group-hover:text-white/45 hover:!text-white/90 [@media(hover:none)]:text-white/45",
  },
  light: {
    copied: "text-brutal-lime",
    idle: "text-black/40 hover:text-black/75",
  },
};

export default function CopyIconButton({
  copied,
  copiedLabel,
  copyLabel,
  surface = "light",
  iconSize = 14,
  className = "",
  type = "button",
  ...props
}: CopyIconButtonProps) {
  const toneClass = copied ? surfaceClasses[surface].copied : surfaceClasses[surface].idle;

  return (
    <Tooltip content={copied ? copiedLabel : copyLabel}>
      <button
        type={type}
        className={`flex size-6 items-center justify-center transition-colors focus:outline-none ${toneClass} ${className}`}
        aria-label={copied ? copiedLabel : copyLabel}
        {...props}
      >
        {copied ? <Check size={iconSize} /> : <Copy size={iconSize} />}
      </button>
    </Tooltip>
  );
}
