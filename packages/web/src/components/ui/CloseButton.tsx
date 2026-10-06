import { X } from "lucide-react";
import { Button } from "raft-ui";
import type { ButtonProps } from "raft-ui";
import { useIntl } from "react-intl";

/** Dismissal is a quiet icon action; the primary action owns the filled button. */
export default function CloseButton({ children, className = "", ...props }: ButtonProps) {
  const { formatMessage } = useIntl();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={formatMessage({ id: "common.close" })}
      {...props}
      className={`text-foreground-muted hover:bg-fill-muted hover:text-foreground-strong theme-brutal:border-2 theme-brutal:border-black theme-brutal:shadow-brutal-sm theme-brutal:bg-white theme-brutal:text-black ${className}`}
    >
      {children ?? <X size={16} />}
    </Button>
  );
}
