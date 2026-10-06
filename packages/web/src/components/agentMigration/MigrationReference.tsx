import { useState } from "react";
import { useIntl } from "react-intl";
import { Button } from "raft-ui";
import { Check, Clipboard } from "lucide-react";
import { setClockTimeout } from "@botiverse/raft-shared";
import Tooltip from "../ui/Tooltip";
import { copyTextToClipboard } from "../../utils/selectMarkdown";
import { migrationSupportRef } from "./presentation";
import type { AgentMigrationNotice } from "./realtime";

export function MigrationReference({ notice }: { notice: AgentMigrationNotice }) {
  const { formatMessage } = useIntl();
  const [copied, setCopied] = useState(false);
  const ref = migrationSupportRef(notice);
  const copy = async () => {
    try {
      await copyTextToClipboard(ref);
      setCopied(true);
      setClockTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-foreground-muted theme-brutal:text-black/55">
      <span className="font-bold">{formatMessage({ id: "agent.migration.referenceLabel" })}</span>
      <code className="min-w-0 break-all font-mono">{ref}</code>
      <Tooltip content={copied
          ? formatMessage({ id: "agent.migration.referenceCopied" })
          : formatMessage({ id: "agent.migration.referenceCopy" })}>
      <Button variant="outline" size="sm"
        type="button"
        onClick={() => void copy()}
        className="flex size-6 shrink-0 items-center justify-center"
        aria-label={copied
          ? formatMessage({ id: "agent.migration.referenceCopied" })
          : formatMessage({ id: "agent.migration.referenceCopyAria" }, { ref })}
      >
        {copied ? <Check size={12} aria-hidden="true" /> : <Clipboard size={12} aria-hidden="true" />}
      </Button>
      </Tooltip>
    </div>
  );
}
