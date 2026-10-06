import { Check, CircleAlert, GitBranch, X } from "lucide-react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import {
  Badge,
  Banner,
  BannerAction,
  BannerDescription,
  BannerTitle,
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Progress,
  ProgressHeader,
  ProgressIndicator,
  ProgressLabel,
  ProgressTrack,
  ProgressValue, Spinner
} from "raft-ui";

type JointConversionSectionProps = {
  busy: boolean;
  disabled: boolean;
  unavailableMessage?: string;
  error?: string;
  connectionWarning?: string;
  admissionPending?: boolean;
  onCheckStatus?: () => void;
  onStart: () => void;
  conversionJob?: {
    status: string;
    phase: string;
    canCancel?: boolean;
    progress?: Record<string, unknown>;
    error?: string | null;
  } | null;
  succeeded?: boolean;
  progressDismissed?: boolean;
  onDismissProgress?: () => void;
  onRetry?: () => void;
  onCancel?: () => void;
  onOpenChannel?: () => void;
  cancelBusy?: boolean;
  headingClassName?: string;
};

/**
 * Value-led entry for turning an ordinary channel into a Joint Channel.
 *
 * Conversion expands who can collaborate here. It is not channel lifecycle
 * management, so this section lives beside the member surface instead of in
 * the archive/leave/delete action stack. The caller continues to own every
 * permission check and conversion state transition.
 */
export default function JointConversionSection({
  busy,
  disabled,
  unavailableMessage,
  error,
  connectionWarning,
  admissionPending = false,
  onCheckStatus,
  onStart,
  conversionJob,
  succeeded = false,
  progressDismissed = false,
  onDismissProgress,
  onRetry,
  onCancel,
  onOpenChannel,
  cancelBusy = false,
  headingClassName = "text-base font-bold text-foreground-strong theme-brutal:text-black",
}: JointConversionSectionProps) {
  const { formatMessage } = useIntl();
  const descriptionId = "channel-settings-joint-conversion-description";
  const unavailableId = unavailableMessage
    ? "channel-settings-joint-conversion-unavailable"
    : undefined;
  const canCancel = !!conversionJob && ["pending", "running", "failed"].includes(conversionJob.status)
    && (conversionJob.canCancel ?? (conversionJob.phase === "prepare" && conversionJob.progress?.canonicalCopyStarted !== true));
  const conversionCanceled = conversionJob?.status === "canceled";
  const conversionComplete = conversionJob ? conversionJob.status === "done" : succeeded;
  const conversionFailed = conversionJob?.status === "failed";
  const progressPhase = conversionJob?.phase ?? (admissionPending ? "prepare" : "");
  const progressStage = conversionStageIndex(progressPhase, conversionJob?.status ?? (admissionPending ? "pending" : ""), conversionComplete);
  const showProgress = !conversionCanceled && (Boolean(conversionJob) || succeeded || admissionPending) && !progressDismissed;
  const displayError = conversionErrorMessage(
    error,
    conversionJob?.progress,
    formatMessage,
  );

  return (
    <section
      className="mb-5 space-y-4 border-b border-line-muted pb-5 theme-brutal:border-black/10"
      data-testid="channel-settings-joint-conversion-section"
    >
      <div className="space-y-2">
        <div className="min-w-0">
          <h3 className={headingClassName} data-testid="channel-settings-joint-conversion-title">
            {formatMessage({ id: "channel.edit.convertSectionTitle" })}
          </h3>
          <p id={descriptionId} className="mt-1 text-xs font-normal text-foreground-muted theme-brutal:text-black/55">
            {formatMessage({ id: "channel.edit.convertSectionDescription" })}
          </p>
        </div>
        {!conversionComplete && !conversionFailed && !conversionJob && !disabled && (
          <div className="flex justify-end" data-testid="channel-settings-joint-conversion-cta-row">
            <Button
              type="button"
              size="sm"
              variant="accent"
              onClick={onStart}
              disabled={disabled || busy}
              loading={busy}
              loadingLabel={formatMessage({ id: "channel.edit.converting" })}
              aria-describedby={[descriptionId, unavailableId].filter(Boolean).join(" ")}
              data-testid="channel-settings-joint-conversion-cta"
            >
              <GitBranch aria-hidden="true" />
              {formatMessage({ id: "channel.edit.convertAction" })}
            </Button>
          </div>
        )}
      </div>
      {connectionWarning && (
        <Banner
          status="warning"
          size="sm"
          data-testid="channel-settings-joint-conversion-connection-warning"
        >
          <BannerDescription className="min-w-0 whitespace-normal break-words [overflow-wrap:anywhere]">
            {connectionWarning}
          </BannerDescription>
          {onCheckStatus && (
            <BannerAction className="!col-span-full !col-start-1 !row-start-3 mt-2 w-full justify-end">
              <Button type="button" size="sm" variant="outline" onClick={onCheckStatus} data-testid="channel-settings-joint-conversion-check-status">
                {formatMessage({ id: "channel.edit.checkConversionStatus" })}
              </Button>
            </BannerAction>
          )}
        </Banner>
      )}
      {showProgress && (
        <div className="space-y-3" data-testid="channel-settings-joint-conversion-progress">
          <div data-testid="channel-settings-joint-conversion-progress-bar">
            <Progress
              value={conversionComplete ? 100 : !conversionJob && admissionPending ? 0 : conversionProgress(progressPhase)}
              variant="information"
              aria-label={formatMessage({ id: conversionPhaseMessageId(progressPhase) })}
            >
              <ProgressHeader>
                <ProgressLabel>{formatMessage({ id: conversionPhaseMessageId(progressPhase) })}</ProgressLabel>
                <ProgressValue />
              </ProgressHeader>
              <ProgressTrack><ProgressIndicator /></ProgressTrack>
            </Progress>
          </div>
          <ol
            className="space-y-2"
            aria-label={formatMessage({ id: "channel.edit.convertProgressTitle" })}
            data-testid="channel-settings-joint-conversion-stages"
          >
            {CONVERSION_STAGES.map((stage, index) => {
              const completed = index < progressStage || (conversionComplete && index === progressStage);
              const current = !conversionComplete && !conversionFailed && !connectionWarning && index === progressStage;
              return (
                <li
                  key={stage.key}
                  className="flex items-center gap-2 text-sm font-normal"
                  aria-current={current ? "step" : undefined}
                  data-stage={stage.key}
                  data-stage-state={completed ? "complete" : current ? "current" : "pending"}
                  aria-label={formatMessage({
                    id: completed
                      ? "channel.edit.convertStageComplete"
                      : current
                        ? "channel.edit.convertStageInProgress"
                        : "channel.edit.convertStagePending",
                  })}
                >
                  <Badge
                    appearance={completed ? "solid" : "outline"}
                    variant={completed ? "success" : current ? "information" : "muted"}
                    aria-hidden="true"
                    className="size-5 justify-center px-0"
                  >
                    {completed ? <Check size={12} /> : current ? <Spinner size="xs" aria-label={formatMessage({ id: "channel.edit.convertInProgress" })} /> : index + 1}
                  </Badge>
                  <span>{formatMessage({ id: stage.messageId })}</span>
                  {current && (
                    <span className="text-xs font-normal text-foreground-muted theme-brutal:text-black/55">
                      {formatMessage({ id: "channel.edit.convertInProgress" })}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
          {displayError && (
            <Banner
              status="warning"
              size="sm"
              className="min-w-0 items-start font-normal"
              data-testid="channel-settings-joint-conversion-error"
            >
              <CircleAlert aria-hidden="true" className="shrink-0" />
              {isUploadsInFlightError(error, conversionJob?.progress) && (
                <BannerTitle className="min-w-0 whitespace-normal break-words [overflow-wrap:anywhere]">
                  {formatMessage({ id: "channel.edit.convertUploadsInFlightTitle" })}
                </BannerTitle>
              )}
              <BannerDescription className="min-w-0 whitespace-normal break-words [overflow-wrap:anywhere]">
                {displayError}
              </BannerDescription>
              {onOpenChannel && isUploadsInFlightError(error, conversionJob?.progress) && (
                <BannerAction className="!col-span-full !col-start-1 !row-start-3 mt-2 w-full justify-end">
                  <Button type="button" size="sm" variant="outline" onClick={onOpenChannel}>
                    {formatMessage({ id: "channel.edit.returnToChannel" })}
                  </Button>
                </BannerAction>
              )}
            </Banner>
          )}
          {conversionComplete && (
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                variant="accent"
                onClick={onDismissProgress}
                data-testid="channel-settings-joint-conversion-done"
              >
                {formatMessage({ id: "channel.edit.convertDone" })}
              </Button>
            </div>
          )}
          {!conversionComplete && ((canCancel && onCancel) || (conversionFailed && onRetry)) && (
            <div className="flex justify-end">
              <div className="flex flex-wrap justify-end gap-2">
                {canCancel && onCancel && (
                  <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={cancelBusy} loading={cancelBusy} loadingLabel={formatMessage({ id: "channel.edit.cancelingConversion" })} data-testid="channel-settings-joint-conversion-cancel">
                    {formatMessage({ id: "channel.edit.cancelConversion" })}
                  </Button>
                )}
                {conversionFailed && onRetry && (
                  <Button
                    type="button"
                    size="sm"
                    variant="warning"
                    onClick={onRetry}
                    disabled={busy || cancelBusy}
                    loading={busy}
                    loadingLabel={formatMessage({ id: "channel.edit.retryingConversion" })}
                    data-testid="channel-settings-joint-conversion-retry"
                  >
                    {formatMessage({ id: "channel.edit.retryConversion" })}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      {unavailableMessage && (
        <div>
          <p id={unavailableId} className="text-xs font-normal text-foreground-muted" data-testid="channel-settings-joint-conversion-unavailable">
            {unavailableMessage}
          </p>
        </div>
      )}
      {displayError && !showProgress && (
        <div>
          <Banner status="warning" size="sm" className="min-w-0 items-start font-normal" data-testid="channel-settings-joint-conversion-error">
            <CircleAlert aria-hidden="true" className="shrink-0" />
            {isUploadsInFlightError(error, conversionJob?.progress) && (
              <BannerTitle className="min-w-0 whitespace-normal break-words [overflow-wrap:anywhere]">
                {formatMessage({ id: "channel.edit.convertUploadsInFlightTitle" })}
              </BannerTitle>
            )}
            <BannerDescription className="min-w-0 whitespace-normal break-words [overflow-wrap:anywhere]">
              {displayError}
            </BannerDescription>
            {onOpenChannel && isUploadsInFlightError(error, conversionJob?.progress) && (
              <BannerAction className="!col-span-full !col-start-1 !row-start-3 mt-2 w-full justify-end">
                <Button type="button" size="sm" variant="outline" onClick={onOpenChannel}>
                  {formatMessage({ id: "channel.edit.returnToChannel" })}
                </Button>
              </BannerAction>
            )}
          </Banner>
        </div>
      )}
    </section>
  );
}

export function JointConversionConfirmDialog({
  open,
  busy,
  error,
  channelName,
  onConfirm,
  onClose,
}: {
  open: boolean;
  busy: boolean;
  error?: string;
  channelName: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !busy) onClose(); }}>
      <DialogContent aria-labelledby="channel-settings-joint-conversion-dialog-title" className="max-w-md">
        <DialogHeader>
          <DialogTitle id="channel-settings-joint-conversion-dialog-title">
            {formatMessage({ id: "channel.edit.convertToJoint" })}
          </DialogTitle>
          <DialogClose
            disabled={busy}
            render={
              <Button variant="outline" size="icon-md" aria-label={formatMessage({ id: "common.close" })}>
                <X className="size-5" aria-hidden="true" />
              </Button>
            }
          />
        </DialogHeader>
        <DialogBody className="font-normal" data-testid="channel-settings-joint-conversion-dialog-body">
          <JointConversionConfirmContent channelName={channelName} />
          {error && <Banner status="warning" size="sm" className="mt-4 font-normal">{error}</Banner>}
        </DialogBody>
        <DialogFooter>
          <DialogClose
            disabled={busy}
            variant="outline"
            size="sm"
            render={<Button variant="outline" size="sm" />}
          >
            {formatMessage({ id: "common.confirm.cancel" })}
          </DialogClose>
          <Button type="button" variant="accent" size="sm" loading={busy}
            loadingLabel={formatMessage({ id: "channel.edit.converting" })}
            onClick={() => void onConfirm().catch(() => undefined)} data-testid="channel-settings-joint-conversion-confirm">
            {formatMessage({ id: "channel.edit.convertAction" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function JointConversionConfirmContent({
  channelName,
}: {
  channelName: string;
}) {
  const { formatMessage } = useIntl();

  return (
    <div className="space-y-3 font-normal" data-testid="channel-settings-joint-conversion-confirm-content">
      <p>{formatMessage({ id: "channel.edit.convertConfirmIntro" }, { name: channelName })}</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>{formatMessage({ id: "channel.edit.convertConfirmHistory" })}</li>
        <li>{formatMessage({ id: "channel.edit.convertConfirmMembers" })}</li>
        <li>{formatMessage({ id: "channel.edit.convertConfirmSharedHistory" })}</li>
        <li>{formatMessage({ id: "channel.edit.convertConfirmAvailability" })}</li>
        <li>{formatMessage({ id: "channel.edit.convertConfirmTasks" })}</li>
      </ul>
    </div>
  );
}

const CONVERSION_STAGES = [
  { key: "prepare", messageId: "channel.edit.convertPhasePreparing" },
  { key: "preserve", messageId: "channel.edit.convertPhasePreserving" },
  { key: "verify", messageId: "channel.edit.convertPhaseVerifying" },
  { key: "access", messageId: "channel.edit.convertPhaseAccess" },
  { key: "done", messageId: "channel.edit.convertPhaseComplete" },
] as const;

function conversionStageIndex(phase = "", status = "", complete = false): number {
  if (complete || status === "done" || phase === "done") return CONVERSION_STAGES.length - 1;
  if (phase === "verify") return 2;
  if (["audience_cutover", "residual_cleanup", "finalize"].includes(phase)) return 3;
  if (["prepare_tasks", "move_parent_messages", "prepare_threads", "move_thread_messages"].includes(phase)) return 1;
  return 0;
}

function conversionProgress(phase: string): number {
  switch (phase) {
    case "prepare": return 15;
    case "prepare_tasks": return 25;
    case "move_parent_messages": return 45;
    case "prepare_threads": return 60;
    case "move_thread_messages": return 72;
    case "verify": return 82;
    case "audience_cutover": return 90;
    case "residual_cleanup": return 95;
    case "finalize": return 98;
    case "done": return 100;
    default: return 10;
  }
}

function conversionPhaseMessageId(phase: string): "channel.edit.convertPhasePreparing" | "channel.edit.convertPhasePreserving" | "channel.edit.convertPhaseAccess" | "channel.edit.convertPhaseVerifying" | "channel.edit.convertPhaseComplete" {
  if (phase === "done") return "channel.edit.convertPhaseComplete";
  if (phase === "prepare") return "channel.edit.convertPhasePreparing";
  if (["move_parent_messages", "prepare_threads", "move_thread_messages", "prepare_tasks"].includes(phase)) {
    return "channel.edit.convertPhasePreserving";
  }
  if (["audience_cutover", "residual_cleanup", "finalize"].includes(phase)) return "channel.edit.convertPhaseAccess";
  return "channel.edit.convertPhaseVerifying";
}

type ConversionProgress = Record<string, unknown> | undefined;

function uploadCountFromProgress(progress: ConversionProgress): number {
  if (!progress) return 1;
  const persistedCount = progress.uploadCount;
  if (typeof persistedCount === "number" && Number.isInteger(persistedCount) && persistedCount > 0) {
    return persistedCount;
  }
  // Older retained jobs do not carry the logical count. Never infer a user
  // count from lifecycle rows (session/intent/reservation); use the safe
  // singular fallback until the server provides the aggregate.
  return 1;
}

function uploadCountFromError(error: string | undefined): number {
  const match = error?.match(/because\s+(\d+)\s+attachment uploads?/i);
  const count = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(count) && count > 0 ? count : 1;
}

export function isUploadsInFlightError(error: string | undefined, progress: ConversionProgress): boolean {
  return progress?.errorCode === "channel_conversion_uploads_in_flight"
    || /attachment upload(?: records)? .*in flight/i.test(error ?? "")
    || /attachment upload(?:s)? .*in progress/i.test(error ?? "")
    || /uploads? (?:are|is) still in flight/i.test(error ?? "");
}

function conversionErrorMessage(
  error: string | undefined,
  progress: ConversionProgress,
  formatMessage: IntlShape["formatMessage"],
): string | undefined {
  if (!isUploadsInFlightError(error, progress)) return error;
  return formatMessage(
    { id: "channel.edit.convertUploadsInFlight" },
    { count: progress?.uploadCount ? uploadCountFromProgress(progress) : uploadCountFromError(error) },
  );
}
