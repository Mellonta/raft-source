import type { ReactNode } from "react";
import {
  SystemMessageGroup,
  SystemMessageGroupChevron,
  SystemMessageGroupDisclosure,
  SystemMessageGroupHeader,
  SystemMessageGroupPanel,
  SystemMessageGroupSummary,
} from "raft-ui";
import Tooltip from "../ui/Tooltip";

type SystemMessageGroupDisclosureWrapperProps = {
  summary: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
};

export default function ConnectedSystemMessageGroupDisclosure({
  summary,
  expanded,
  onToggle,
  children,
}: SystemMessageGroupDisclosureWrapperProps) {
  return (
    <SystemMessageGroup open={expanded} onOpenChange={onToggle} className="mb-1">
      <SystemMessageGroupHeader>
        <Tooltip content={summary}>
          <SystemMessageGroupDisclosure
            data-testid="system-message-group-toggle"
            aria-expanded={expanded}
          >
            <SystemMessageGroupSummary>{summary}</SystemMessageGroupSummary>
            <SystemMessageGroupChevron />
          </SystemMessageGroupDisclosure>
        </Tooltip>
      </SystemMessageGroupHeader>
      <SystemMessageGroupPanel data-testid="system-message-group-details">
        {children}
      </SystemMessageGroupPanel>
    </SystemMessageGroup>
  );
}
