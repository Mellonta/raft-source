import { LogIn } from "lucide-react";
import { useIntl } from "react-intl";
import Banner from "../ui/Banner";
import { Button, Spinner } from "raft-ui";
import Tooltip from "../ui/Tooltip";

type Props = {
  joinTargetCount: number;
  joinTargetSummary: string;
  joinTargetTitle: string;
  joinInFlight: boolean;
  onJoin: () => void;
  hasJointDestination: boolean;
  skippedCount: number;
  nestedForwardCount: number;
  sourceIsThread: boolean;
};

export default function ForwardComposerWarnings({
  joinTargetCount,
  joinTargetSummary,
  joinTargetTitle,
  joinInFlight,
  onJoin,
  hasJointDestination,
  skippedCount,
  nestedForwardCount,
  sourceIsThread,
}: Props) {
  const { formatMessage } = useIntl();
  const joinLabel = formatMessage({ id: "message.forwardComposer.joinSelected" });
  return (
    <>
      {joinTargetCount > 0 && (
        <Banner
          intent="warning"
          withIcon
          density="sm"
          className="mb-3 !items-center font-bold"
          aria-live="polite"
          data-testid="forward-join-banner"
          actions={(
            <Button type="button" size="xs" variant="outline" onClick={onJoin} disabled={joinInFlight} aria-label={joinLabel} data-testid="forward-join-selected-channels">
              {joinInFlight ? <Spinner size="xs" aria-label={formatMessage({ id: "message.forwardComposer.joining" })} /> : <LogIn size={12} />}
              {formatMessage({ id: "message.forwardComposer.join" })}
            </Button>
          )}
        >
          <Tooltip content={formatMessage({ id: "message.forwardComposer.joinBeforeForwarding" }, { targets: joinTargetTitle })}>
            <span className="block min-h-6 min-w-0 truncate leading-6">
              {formatMessage({ id: "message.forwardComposer.joinBeforeForwarding" }, { targets: joinTargetSummary })}
            </span>
          </Tooltip>
        </Banner>
      )}
      {hasJointDestination && (
        <Banner intent="warning" withIcon className="mb-3 text-xs font-bold">
          {formatMessage({ id: "message.forwardComposer.jointWarning" })}
        </Banner>
      )}
      {skippedCount > 0 && (
        <Banner intent="warning" className="mb-3 text-xs font-bold">
          {nestedForwardCount > 0
            ? formatMessage({ id: "message.forwardComposer.nestedForwardBlocked" })
            : sourceIsThread
              ? formatMessage({ id: "message.forwardComposer.threadOnlyIncluded" })
              : formatMessage({ id: "message.forwardComposer.skippedUnsupported" }, { count: skippedCount })}
        </Banner>
      )}
    </>
  );
}
