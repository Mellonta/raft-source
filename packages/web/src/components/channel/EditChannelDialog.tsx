import {
  Badge,
  Button,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  Input,
  Switch,
  Textarea,
  toast,
} from "raft-ui";
import { reportConversionFailure } from "../../utils/conversionDiagnostics";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { formatNameValidationError } from "../../i18n/nameValidation";
import { Archive, ArchiveRestore, Check, Eye, EyeOff, Hash, Info, Lock, LogOut, Mail, Trash2, Unplug, X } from "lucide-react";
import { useChannelStore } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import { ChannelPreferencesSection } from "./ChannelPreferencesSection";
import {
  CHANNEL_TO_JOINT_CONVERSION_FEATURE_FLAG_KEY,
  MAX_JOINT_CHANNEL_SERVERS,
  SERVER_GUEST_FEATURE_FLAG_KEY,
  clearClockTimeout,
  getEffectiveLimits,
  setClockTimeout,
  validateNameReason,
  validateServerSlugReferenceReason,
} from "@botiverse/raft-shared";
import Banner from "../ui/Banner";
import Tooltip from "../ui/Tooltip";
import ConfirmDialog from "../ConfirmDialog";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import FormField from "../ui/FormField";
import { ChannelSlackBridgeField, useChannelSlackBridgeEditor } from "./ChannelSlackBridgeField";
import { OverflowActionRow } from "../ui/OverflowSheet";
import SlugInput from "../ui/SlugInput";
import JointConversionSection, { JointConversionConfirmDialog } from "./JointConversionSection";
import { useConversionObservationNotice } from "./useConversionObservationNotice";
import { beginConversionObservation } from "../../store/conversionObservationStore";
import { channelConversionState, conversionResponseState, conversionObservationResult } from "../../store/channelConversionState";
import { useChannelConversionState } from "../../hooks/useChannelConversionState";
import type { ChannelConversionJobView as ConversionJobState, ServerPlan } from "@botiverse/raft-shared";
import type { ConversionObservationToken, ConversionAttemptBaseline } from "../../store/conversionObservationStore";
import JointAttachmentUploadSection, { useActiveAttachmentUploads } from "./JointAttachmentUploadSection";

const CHANNEL_SETTINGS_FORM_ID = "channel-settings-form";

function ChannelSettingsSheet({
  children,
  isDirty,
  onClose,
}: {
  children: ReactNode;
  isDirty: boolean;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <Drawer
      open={open}
      modal
      swipeDirection="right"
      disablePointerDismissal={isDirty}
      onOpenChange={(nextOpen, eventDetails) => {
        if (
          !nextOpen &&
          isDirty &&
          (eventDetails.reason === "outside-press" || eventDetails.reason === "swipe")
        ) {
          eventDetails.cancel();
          return;
        }
        setOpen(nextOpen);
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DrawerContent
        data-testid="channel-settings-sheet"
        className="theme-aware-channel-settings inset-y-0 right-0 h-dvh w-full max-w-[min(100vw,34rem)] [--drawer-content-height:100dvh] [--drawer-inset:0px] flex-col border-0 theme-brutal:rounded-none theme-brutal:border-l-2 theme-brutal:border-line-strong bg-layer-canvas-muted theme-brutal:bg-brutal-cream text-foreground-strong"
      >
        {children}
      </DrawerContent>
    </Drawer>
  );
}

type EditChannelDialogProps = {
  channelId: string;
  initialName: string;
  initialDescription: string;
  onLeaveChannel?: () => Promise<void> | void;
  onClose: () => void;
  presentation?: "sheet" | "panel";
  dirtyRef?: { current: boolean };
  saveAndCloseAvailableRef?: { current: boolean };
  saveRef?: { current: (() => Promise<boolean>) | null };
  activityMute?: {
    muted: boolean;
    busy: boolean;
    onToggle: () => void;
  };
  collapseLongMessages?: {
    enabled: boolean;
    busy: boolean;
    onToggle: () => void;
  };
  stopAgentsRow?: ReactNode;
};

export default function EditChannelDialog({
  channelId,
  initialName,
  initialDescription,
  onLeaveChannel,
  onClose,
  presentation = "sheet",
  dirtyRef,
  saveAndCloseAvailableRef,
  saveRef,
  activityMute,
  collapseLongMessages,
  stopAgentsRow,
}: EditChannelDialogProps) {
  const { formatMessage } = useIntl();
  const { state: serverConversion, observationScope, pendingCommand, finishObservation } = useChannelConversionState(channelId, true);
  const serverCommand = serverConversion.command;
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const saveStatusTimeoutRef = useRef<ReturnType<typeof setClockTimeout> | null>(null);
  const [saving, setSaving] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendStatus, setResendStatus] = useState("");
  const [resendError, setResendError] = useState("");
  const resendStatusTimeoutRef = useRef<ReturnType<typeof setClockTimeout> | null>(null);
  const [inviteServerSlug, setInviteServerSlug] = useState("");
  const [invitePeopleText, setInvitePeopleText] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteStatus, setInviteStatus] = useState("");
  const [inviteTouched, setInviteTouched] = useState({ serverSlug: false, people: false });
  const [inviteServerSlugServerError, setInviteServerSlugServerError] = useState("");
  const [invitePeopleServerError, setInvitePeopleServerError] = useState("");
  const [inviteSubmitError, setInviteSubmitError] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [showVisibilityConfirm, setShowVisibilityConfirm] = useState(false);
  const [showConvertConfirm, setShowConvertConfirm] = useState(false);
  const [convertError, setConvertError] = useState("");
  const { warning: conversionConnectionWarning, pending: conversionRequestPending, settled: conversionObservationSettled, setWarning: setConversionConnectionWarning, setPending: setConversionRequestPending } = useConversionObservationNotice(pendingCommand?.startedAt, serverCommand?.status === "pending");
  const [conversionObservationRefresh, setConversionObservationRefresh] = useState(0);
  const conversionAwaitingReceipt = !!pendingCommand && pendingCommand.kind !== "cancel";
  const conversionCancelObservationId = pendingCommand?.kind === "cancel" ? pendingCommand.jobId : null;
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [guestPolicyBusy, setGuestPolicyBusy] = useState(false);
  const [convertBusy, setConvertBusy] = useState(false);
  const [conversionCancelBusy, setConversionCancelBusy] = useState(false);
  const [conversionJob, setConversionJob] = useState<ConversionJobState | null>(null);
  const [convertSucceeded, setConvertSucceeded] = useState(false);
  const [conversionProgressDismissed, setConversionProgressDismissed] = useState(false);
  const conversionRunRef = useRef(0);
  const conversionCanceledJobRef = useRef<string | null>(null);
  // Before a Retry is acknowledged, its old failed receipt is only evidence
  // of the preceding attempt, never a terminal answer for this command.
  const conversionAttemptBaselineRef = useRef<ConversionJobState | null>(null);
  const updateChannel = useChannelStore((s) => s.updateChannel);
  const hideAllChannel = useChannelStore((s) => s.hideAllChannel);
  const restoreAllChannel = useChannelStore((s) => s.restoreAllChannel);
  const convertChannelToJoint = useChannelStore((s) => s.convertChannelToJoint);
  const getChannelConversionJob = useChannelStore((s) => s.getChannelConversionJob);
  const retryChannelConversionJob = useChannelStore((s) => s.retryChannelConversionJob);
  const cancelChannelConversionJob = useChannelStore((s) => s.cancelChannelConversionJob);
  const deleteChannel = useChannelStore((s) => s.deleteChannel);
  const disconnectJointChannel = useChannelStore((s) => s.disconnectJointChannel);
  const resendJointChannelInvite = useChannelStore((s) => s.resendJointChannelInvite);
  const inviteJointChannelServer = useChannelStore((s) => s.inviteJointChannelServer);
  const archiveChannel = useChannelStore((s) => s.archiveChannel);
  const unarchiveChannel = useChannelStore((s) => s.unarchiveChannel);
  const channels = useChannelStore((s) => s.channels);
  const channel = channels.find((c) => c.id === channelId);
  const plan = useServerStore((s) => s.current?.plan) || "free";
  const guestJoinableLimit = getEffectiveLimits(plan as ServerPlan).maxGuestJoinableChannelsPerServer;
  const guestJoinableCount = channels.filter((candidate) =>
    candidate.serverId === channel?.serverId
    && candidate.guestJoinable === true
    && !candidate.archivedAt).length;
  const channelToJointConversionEnabled = useServerFeatureFlag(
    CHANNEL_TO_JOINT_CONVERSION_FEATURE_FLAG_KEY,
  ).enabled;
  const isJointChannel = channel?.type === "joint";
  const currentVisibility = channel?.type === "private" ? "private" : "public";
  const nextVisibility = currentVisibility === "private" ? "public" : "private";
  const isArchived = !!channel?.archivedAt;
  const { capabilities } = useServerPermissions();
  const effectiveCapabilities = channel?.channelCapabilities ?? capabilities;
  const nav = useAppNavigate();
  const persistedConversionJob = serverConversion.job;
  // The channel response is the durable source of truth across Settings
  // mounts. Local state only owns the conversion started by this mount. This
  // render-time fallback also covers a late async channel hydrate without a
  // prop-to-state effect or a one-shot channel-id guard.
  // A restored failure no longer blocks sending, but its error and Retry
  // remain visible until cancellation or a successful retry.
  const persistedConversionReceipt = persistedConversionJob
    && ["pending", "running", "failed"].includes(persistedConversionJob.status)
    && conversionCanceledJobRef.current !== persistedConversionJob.id
      ? persistedConversionJob
      : null;
  // A local retry/start response is newer than the stale channel snapshot that
  // caused this mount. Prefer it until the next poll patches the store.
  const conversionReceipt = conversionJob ?? persistedConversionReceipt;
  const conversionReceiptRef = useRef<ConversionJobState | null>(null);
  conversionReceiptRef.current = conversionReceipt;
  const conversionReceiptId = conversionReceipt?.id;
  const conversionReceiptStatus = conversionReceipt?.status;
  const conversionInProgress = convertBusy || conversionAwaitingReceipt || Boolean(conversionCancelObservationId) || Boolean(
    conversionReceipt && ["pending", "running", "failed"].includes(conversionReceipt.status),
  );
  // A stale/early channel projection must not expose completed Joint controls
  // while the durable conversion receipt is still actionable. The receipt is
  // the authority for the Settings state machine; channel.type alone is not.
  const showCompletedJointSettings = isJointChannel && !conversionInProgress;
  const {
    uploads: activeAttachmentUploads,
    cancelBusyId: activeAttachmentUploadCancelBusyId,
    cancelUpload: cancelActiveAttachmentUpload,
  } = useActiveAttachmentUploads(channelId, showCompletedJointSettings || conversionInProgress);
  /*
   * A channel poll replaces the receipt object on every read. Keep the polling
   * effect keyed only by the job identity/status so phase/progress updates do
   * not spawn a second loop or reset its timer.
   */
  // If the drawer is opened while a conversion is already running, resume the
  // same durable polling loop. A first mount that just started the job is
  // already polled by handleConvertToJoint while convertBusy is true.
  const finishCanceledConversion = useCallback((jobId: string, token?: ConversionObservationToken) => {
    conversionCanceledJobRef.current = jobId;
    conversionAttemptBaselineRef.current = null;
    finishObservation(token);
    setConversionConnectionWarning(false);
    setConversionJob(null);
    setConvertSucceeded(false);
    setConversionProgressDismissed(false);
    setShowConvertConfirm(false);
    setConvertError("");
  }, [setConversionConnectionWarning, finishObservation]);

  useEffect(() => {
    const receipt = conversionAwaitingReceipt ? null : conversionReceiptRef.current;
    if (convertBusy || conversionCancelBusy) return;
    if (!conversionCancelObservationId && !conversionAwaitingReceipt && (!receipt || !["pending", "running"].includes(receipt.status))) return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const runId = ++conversionRunRef.current;
    const isCurrent = () => !cancelled && conversionRunRef.current === runId;
    const poll = async () => {
      let current = receipt;
      let retryDelay = 120;
      while (isCurrent() && (conversionCancelObservationId || !current || ["pending", "running"].includes(current.status))) {
        await new Promise<void>((resolve) => {
          timeoutId = setClockTimeout(() => { timeoutId = null; resolve(); }, retryDelay) as ReturnType<typeof setTimeout>;
        });
        if (!isCurrent() || (current && conversionCanceledJobRef.current === current.id)) return;
        try {
          if (current || conversionCancelObservationId) {
            // Own this read's last confirmed receipt before its store hydrate
            // can replace the active fallback and invalidate the observer.
            if (current) setConversionJob(current);
            current = conversionResponseState(await getChannelConversionJob(conversionCancelObservationId ?? current!.id)).job;
          } else {
            // A lost start response gives us no job ID. Read the source channel
            // afresh, rather than assuming the command failed or replaying it.
            const refreshed = await useChannelStore.getState().ensureChannel(channelId, { refresh: true });
            if (!isCurrent()) return;
            if (!refreshed) throw new Error("Conversion status unavailable");
            const refreshedConversion = channelConversionState(refreshed);
            current = refreshedConversion.job;
            const observed = refreshedConversion.command;
            const observation = conversionObservationResult(refreshed, pendingCommand, pendingCommand?.baseline ?? conversionAttemptBaselineRef.current);
            if (observation === "pending") {
              current = null;
              setConversionRequestPending();
              retryDelay = conversionObservationSettled ? 5000 : 1000;
              continue;
            }
            if (observation === "canceled") {
              finishCanceledConversion(current?.id ?? observed?.jobId ?? observed!.id, pendingCommand?.token);
              return;
            }
            if (observation === "done") {
              finishObservation(pendingCommand?.token);
              setConversionConnectionWarning(false);
              setConversionJob(null);
              setConvertSucceeded(true);
              setShowConvertConfirm(false);
              toast.success(formatMessage({ id: "channel.edit.convertSuccess" }));
              return;
            }
            if (observation === "commandFailed") {
              finishObservation();
              setConversionConnectionWarning(false);
              setConversionJob(current);
              setConvertError(observed?.error || formatMessage({ id: "channel.edit.failedConvertJoint" }));
              return;
            }
            if (observation === "unconfirmed") {
              // The original command may still be waiting for admission/lock.
              // An absent job or the pre-Retry failure cannot end observation.
              current = null;
              setConversionConnectionWarning(true);
              retryDelay = conversionObservationSettled ? 5000 : 1000;
              continue;
            }
            conversionAttemptBaselineRef.current = null;

          }
          if (!isCurrent()) return;
          if (current?.status === "canceled") {
            finishCanceledConversion(current.id);
            return;
          }
          if (conversionCancelObservationId && current?.status !== "done" && current?.canCancel !== false) {
            // Cancel has a known job identity. Continue reading even a failed
            // snapshot until cancellation commits or becomes impossible.
            setConversionJob(current);
            setConversionConnectionWarning(true);
            retryDelay = conversionObservationSettled ? 5000 : 1000;
            continue;
          }

          setConversionConnectionWarning(false);
          setConvertError(conversionCancelObservationId
            ? formatMessage({ id: "channel.edit.cancelConversionUnavailable" })
            : current?.status === "failed" ? current.error || "" : "");
          setConversionJob(current);
          finishObservation();
          if (!current || current.status === "done") {
            setConvertSucceeded(true);
            setShowConvertConfirm(false);
            toast.success(formatMessage({ id: "channel.edit.convertSuccess" }));
            return;
          }
          retryDelay = 120;
        } catch (error) {
          if (!isCurrent()) return;
          reportConversionFailure("observe", channelId, pendingCommand?.token, error);
          // Connectivity is an observation failure, not a new job state.
          setConversionConnectionWarning(true);
          retryDelay = conversionObservationSettled ? 5000 : 1000;
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timeoutId !== null) clearClockTimeout(timeoutId);
    };
  }, [channelId, conversionReceiptId, conversionReceiptStatus, conversionAwaitingReceipt, conversionCancelObservationId, conversionObservationSettled, conversionObservationRefresh, convertBusy, conversionCancelBusy, getChannelConversionJob, formatMessage, setConversionConnectionWarning, setConversionRequestPending, finishCanceledConversion, finishObservation, pendingCommand]);

  // Invalidate the mounted conversion runner when Settings unmounts. Without
  // this, a drawer closed during an in-flight poll can keep issuing reads and
  // later overwrite the next Settings mount's receipt.
  useEffect(() => () => {
    conversionRunRef.current += 1;
  }, []);

  const isAllChannel = initialName === "all";
  const canEditChannel = Boolean(effectiveCapabilities.editChannelMetadata
    || effectiveCapabilities.changeChannelVisibility
    || effectiveCapabilities.archiveChannels
    || effectiveCapabilities.deleteChannels
    || effectiveCapabilities.federateChannels);
  const bridgeEditor = useChannelSlackBridgeEditor({
    channelId,
    visibility: currentVisibility,
    canManage: canEditChannel,
  });
  // Personal preferences are available in the settings sheet.
  const serverGuestEnabled = useServerFeatureFlag(SERVER_GUEST_FEATURE_FLAG_KEY).enabled;
  const canManageGuestAccess = Boolean(
    serverGuestEnabled &&
    effectiveCapabilities.manageGuestAccess &&
    !isArchived &&
    !isJointChannel &&
    (channel?.type === "channel" || channel?.type === "private") &&
    // A private channel has no guest policy to manage, so the section is not
    // rendered at all rather than rendered permanently greyed out. This is the
    // server's own rule (`privateGuestPolicyDisabled` in the channel PATCH
    // route), which forces both flags false for private channels.
    // #all is the exception on purpose: hiding #all IS `type: "private"`, and
    // its guest-visible switch stays live — the server spells the same carve-out
    // as `isAllSystemChannel`.
    !(channel?.type === "private" && channel?.name !== "all"),
  );
  const showLeaveAction = !!onLeaveChannel && !isAllChannel && !isArchived;
  const showManageActions = canEditChannel && !isArchived;
  const showVisibilityAction = showManageActions && Boolean(effectiveCapabilities.changeChannelVisibility);
  const showConvertAction = canEditChannel &&
    capabilities.federateChannels &&
    channelToJointConversionEnabled &&
    !isAllChannel &&
    !isJointChannel &&
    Boolean(effectiveCapabilities.federateChannels) &&
    (channel?.type === "channel" || channel?.type === "private");
  // Conversion uses a durable source fence without changing the channel's
  // archive lifecycle. Keep the in-session job receipt mounted through
  // running/failed/canceled states so the user always has an actionable
  // progress, retry, or cancel surface.
  const conversionRetryable = conversionReceipt?.status === "failed";
  const showJointConversionSection = capabilities.federateChannels &&
    channelToJointConversionEnabled &&
    !isAllChannel &&
    ((channel?.type === "channel" || channel?.type === "private") ||
      conversionInProgress ||
      ((!conversionProgressDismissed) && (conversionReceipt !== null || convertSucceeded)));
  const showChannelInfoSettings = !isJointChannel || showCompletedJointSettings;
  // Contract v0.3: any plan may convert; limits apply when servers are invited.
  const jointConversionUnavailableMessage = !canEditChannel
    ? formatMessage({ id: "channel.edit.convertPermissionRequired" })
    : undefined;
  const jointServers = channel?.jointServers?.length
    ? channel.jointServers
    : channel?.jointPeerServerId || channel?.jointPeerServerSlug
      ? [{
          serverId: channel.jointPeerServerId || channel.jointPeerServerSlug || "peer",
          serverName: channel.jointPeerServerName || channel.jointPeerServerSlug || formatMessage({ id: "channel.edit.connectedServerFallback" }),
          serverSlug: channel.jointPeerServerSlug || "",
          role: null,
          status: channel.jointPeerStatus === "pending" ? "pending" as const : "active" as const,
        }]
      : [];
  const jointServerLimitReached = jointServers.length >= MAX_JOINT_CHANNEL_SERVERS;
  const hasCurrentServerPendingJointInvites = channel?.jointPendingInvites
    ? channel.jointPendingInvites.some((invite) => invite.fromServerId === channel.serverId)
    : channel?.jointPeerStatus === "pending";
  const normalizedInviteServerSlug = inviteServerSlug.trim();
  const normalizedInvitePeople = invitePeopleText
    .split(/[\n,]+/)
    .map((person) => person.trim())
    .filter(Boolean);
  const inviteServerSlugValidation = validateServerSlugReferenceReason(normalizedInviteServerSlug);
  const inviteFormValid =
    inviteServerSlugValidation === null && normalizedInvitePeople.length > 0;
  const inviteServerSlugValidationMessage = inviteServerSlugValidation?.code === "required"
    ? formatMessage({ id: "channel.edit.inviteSlugRequired" })
    : inviteServerSlugValidation?.code === "pattern"
      ? formatMessage({ id: "channel.edit.inviteSlugPattern" })
      : "";
  const inviteServerSlugError = inviteServerSlugServerError || (
    inviteTouched.serverSlug
      ? inviteServerSlugValidationMessage
      : ""
  );
  const invitePeopleError = invitePeopleServerError || (
    inviteTouched.people && normalizedInvitePeople.length === 0
      ? formatMessage({ id: "channel.edit.inviteePersonRequired" })
      : ""
  );
  const hasInviteDraft = inviteServerSlug.length > 0 || invitePeopleText.length > 0;
  const currentBridgeSelection = bridgeEditor.snapshot?.channelPairs
    .find((pair) => pair.raftChannelId === channelId)?.slackChannelId ?? "";
  const isBridgeDirty = bridgeEditor.available
    && bridgeEditor.selectedSlackChannelId !== currentBridgeSelection;
  const isDirty = name !== initialName ||
    description !== initialDescription ||
    isBridgeDirty ||
    hasInviteDraft;

  // Keep the host's dismissal guard current from COMMITTED state only.
  // Writing the ref during render is unsafe: an abandoned concurrent
  // render could publish a stale `false` and disarm the guard while the
  // committed draft is still dirty. An effect runs after commit, so the
  // guard always reflects the state actually on screen. The write targets
  // a ref (no re-render), which react-doctor/no-event-handler cannot
  // distinguish from a real prop mutation.
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-event-handler
    if (dirtyRef) dirtyRef.current = isDirty;
  }, [dirtyRef, isDirty]);

  // The host can persist name/description through saveChanges(), but the
  // Joint invitation form is an independent, explicit side effect. Keep the
  // close prompt honest: while an unsent invitation draft exists it may only
  // keep editing or explicitly discard, never claim it can save-and-close.
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-event-handler
    if (saveAndCloseAvailableRef) saveAndCloseAvailableRef.current = !hasInviteDraft;
  }, [hasInviteDraft, saveAndCloseAvailableRef]);

  const clearSaveStatus = () => {
    if (saveStatusTimeoutRef.current !== null) {
      clearClockTimeout(saveStatusTimeoutRef.current);
      saveStatusTimeoutRef.current = null;
    }
    setSaveStatus("");
  };

  const showSaveSuccess = () => {
    clearSaveStatus();
    setSaveStatus(formatMessage({ id: "channel.edit.saveSuccess" }));
    saveStatusTimeoutRef.current = setClockTimeout(() => {
      saveStatusTimeoutRef.current = null;
      setSaveStatus("");
    }, 1500);
  };

  useEffect(() => () => {
    if (saveStatusTimeoutRef.current !== null) {
      clearClockTimeout(saveStatusTimeoutRef.current);
    }
    if (resendStatusTimeoutRef.current !== null) {
      clearClockTimeout(resendStatusTimeoutRef.current);
    }
  }, []);

  const clearResendStatus = () => {
    if (resendStatusTimeoutRef.current !== null) {
      clearClockTimeout(resendStatusTimeoutRef.current);
      resendStatusTimeoutRef.current = null;
    }
    setResendStatus("");
  };

  const showResendSuccess = (count: number) => {
    clearResendStatus();
    setResendStatus(formatMessage(
      { id: "channel.edit.inviteResentCount" },
      { count },
    ));
    resendStatusTimeoutRef.current = setClockTimeout(() => {
      resendStatusTimeoutRef.current = null;
      setResendStatus("");
    }, 1500);
  };

  // Reset the name/description draft back to the last-saved values
  // (final6 in-section Cancel).
  const isNameDescDirty = name !== initialName || description !== initialDescription;
  const hasSavableDraft = isNameDescDirty || isBridgeDirty;
  const resetDraft = () => {
    setName(initialName);
    setDescription(initialDescription);
    bridgeEditor.setSelectedSlackChannelId(currentBridgeSelection);
    setError("");
    clearSaveStatus();
  };

  // Expose the save to the host's unsaved-changes prompt. The ref is
  // re-published after every commit so it always closes over the latest
  // draft; ref writes drive no renders (same react-doctor blind spot as
  // the dirtyRef sync above).
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-event-handler
    if (saveRef) saveRef.current = saveChanges;
    return () => {
      // oxlint-disable-next-line react-doctor/no-event-handler
      if (saveRef) saveRef.current = null;
    };
  });

  const getFallbackChannel = () =>
    channels.find((candidate) => candidate.id !== channelId && candidate.name === "all") ||
    channels.find((candidate) => candidate.id !== channelId);

  /** Persist name/description. Returns true when the draft is clean
   *  afterwards (saved or nothing to save), false on validation/API
   *  failure. Does NOT close — callers decide what happens next. */
  const saveChanges = async (): Promise<boolean> => {
    setError("");
    clearSaveStatus();

    if (!canEditChannel) {
      return true;
    }

    if (!isAllChannel) {
      const nameError = formatNameValidationError(
        validateNameReason(name),
        "channel.edit.nameFieldName",
        formatMessage,
      );
      if (nameError) {
        setError(nameError);
        return false;
      }
    }

    setSaving(true);
    try {
      const updates: { name?: string; description?: string } = {};
      if (!isAllChannel && name.trim() !== initialName) {
        updates.name = name.trim();
      }
      if (description.trim() !== initialDescription) {
        updates.description = description.trim();
      }
      if (Object.keys(updates).length > 0) {
        const updated = await updateChannel(channelId, updates);
        setName(updated.name);
        setDescription(updated.description || "");
      } else {
        setName(initialName);
        setDescription(initialDescription);
      }
      try {
        await bridgeEditor.apply(channelId);
      } catch {
        setError(formatMessage({ id: "channel.bridge.partialFailure" }));
        return false;
      }
      showSaveSuccess();
      return true;
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedUpdate" }));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await saveChanges()) {
      onClose();
    }
  };

  const handleVisibilityChange = async () => {
    setError("");
    setVisibilityBusy(true);
    try {
      // #all no longer travels through the generic visibility field -- the
      // server refuses it there, because hiding #all drops its whole derived
      // audience rather than narrowing a membership list. Both directions have
      // dedicated, id-free endpoints.
      if (isAllChannel) {
        await (nextVisibility === "private" ? hideAllChannel() : restoreAllChannel());
      } else {
        await updateChannel(channelId, { visibility: nextVisibility });
      }
      setShowVisibilityConfirm(false);
      onClose();
      if (isAllChannel && nextVisibility === "private") {
        const fallbackChannel = getFallbackChannel();
        if (fallbackChannel) {
          nav.toChannel(fallbackChannel.id);
        } else {
          nav.toSettings("server");
        }
      }
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedUpdateVisibility" }));
      setShowVisibilityConfirm(false);
    } finally {
      setVisibilityBusy(false);
    }
  };

  const updateGuestPolicy = async (updates: { guestVisible?: boolean; guestJoinable?: boolean }) => {
    setError("");
    setGuestPolicyBusy(true);
    try {
      await updateChannel(channelId, updates);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string; code?: string; limit?: number } } };
      const body = axiosErr.response?.data;
      if (body?.code === "guest_joinable_channel_limit_reached") {
        setError(guestJoinableLimit >= 0
          ? formatMessage({ id: "channel.edit.guestJoinableLimitReached" }, { limit: body.limit ?? guestJoinableLimit })
          : formatMessage({ id: "channel.edit.failedUpdateGuestAccess" }));
      } else {
        setError(body?.error || formatMessage({ id: "channel.edit.failedUpdateGuestAccess" }));
      }
    } finally {
      setGuestPolicyBusy(false);
    }
  };

  const handleConvertToJoint = async () => {
    const runId = ++conversionRunRef.current;
    conversionAttemptBaselineRef.current = conversionReceiptRef.current;
    if (!observationScope || pendingCommand) return;
    const previous = conversionReceiptRef.current;
    const baseline: ConversionAttemptBaseline | null = previous ? {
      id: previous.id, status: previous.status,
      progress: { failedAt: typeof previous.progress?.failedAt === "string" ? previous.progress.failedAt : undefined,
        relockedAt: typeof previous.progress?.relockedAt === "string" ? previous.progress.relockedAt : undefined },
    } : null;
    const command = beginConversionObservation(observationScope, previous?.status === "failed" ? "retry" : "start", baseline, serverCommand?.id ?? null);
    if (!command) return;
    setError("");
    setConvertError("");
    setConversionConnectionWarning(false);
    conversionCanceledJobRef.current = null;
    setConvertBusy(true);
    setShowConvertConfirm(false);
    setConversionRequestPending();
    try {
      const started = conversionReceiptRef.current?.status === "failed"
        ? await retryChannelConversionJob(conversionReceiptRef.current.id, command.token)
        : await convertChannelToJoint(channelId, { observeProgress: true, commandId: command.token });
      if (conversionRunRef.current !== runId) return;
      conversionAttemptBaselineRef.current = null;
      const startedConversion = conversionResponseState(started);
      const commandPending = startedConversion.status === "pending";
      if (commandPending) {
        // Admission is durable on the server, but the source lock may still
        // be waiting. Keep the scoped observation record for remount/reload.
        setShowConvertConfirm(false);
        setConversionRequestPending();
        setConversionJob(null);
        return;
      }
      finishObservation(command.token);
      setConversionConnectionWarning(false);
      setShowConvertConfirm(false);
      const currentJob = startedConversion.job;
      setConversionJob(currentJob);
      if (currentJob?.status === "failed") {
        setConvertError(currentJob.error || formatMessage({ id: "channel.edit.failedConvertJoint" }));
      } else if (!currentJob || currentJob.status === "done") {
        setConvertSucceeded(true);
        toast.success(formatMessage({ id: "channel.edit.convertSuccess" }));
      }
      // Running jobs are observed by the mounted polling effect above.
    } catch (err: unknown) {
      reportConversionFailure(command.kind === "retry" ? "retry" : "start", channelId, command.token, err);
      if (conversionRunRef.current !== runId) return;
      const axiosErr = err as { response?: { status?: number; data?: { error?: string; conversionJob?: ConversionJobState } } };
      const responseData = axiosErr.response?.data;
      if (responseData?.conversionJob) {
        finishObservation(command.token);
        setConversionJob(responseData.conversionJob);
        setShowConvertConfirm(false);
        setConvertError(responseData.conversionJob.status === "failed" ? responseData.conversionJob.error || responseData.error || "" : "");
      } else if (!axiosErr.response || (axiosErr.response.status !== undefined && axiosErr.response.status >= 500)) {
        setShowConvertConfirm(false);
        setConversionConnectionWarning(true);
        // Retry may have succeeded even when its response was lost. Discard
        // the old failed snapshot and rediscover the authoritative receipt.
        setConversionJob(null);
        // Keep the pending command record for reopen, refresh and read-only recovery.
      } else {
        finishObservation(command.token);
        setConversionConnectionWarning(false);
        setConvertError(responseData?.error || formatMessage({ id: "channel.edit.failedConvertJoint" }));
        setShowConvertConfirm(true);
        throw err;
      }
    } finally {
      setConvertBusy(false);
    }
  };

  const handleCancelConversion = async () => {
    if (!conversionReceipt) return;
    const cancelingJobId = conversionReceipt.id;
    if (!observationScope || conversionCancelObservationId) return;
    const runId = ++conversionRunRef.current;
    const command = beginConversionObservation(observationScope, "cancel", { id: cancelingJobId, status: conversionReceipt.status }, serverCommand?.id ?? null);
    if (!command) return;
    setConvertError("");
    setConversionConnectionWarning(false);
    setConversionCancelBusy(true);
    try {
      await cancelChannelConversionJob(cancelingJobId, command.token);
      if (conversionRunRef.current !== runId) return;
      finishCanceledConversion(cancelingJobId, command.token);
      toast.success(formatMessage({ id: "channel.edit.conversionCanceled" }));
    } catch (err: unknown) {
      reportConversionFailure("cancel", channelId, command.token, err);
      if (conversionRunRef.current !== runId) return;
      const axiosErr = err as { response?: { status?: number; data?: { error?: string; code?: string } } };
      const uncertain = !axiosErr.response || (axiosErr.response.status !== undefined && axiosErr.response.status >= 500);
      conversionCanceledJobRef.current = null;
      setConversionJob(conversionReceipt);
      let latest: ConversionJobState | null = null;
      try { latest = conversionResponseState(await getChannelConversionJob(cancelingJobId)).job; }
      catch (error) { reportConversionFailure("cancel-observe", channelId, command.token, error); }
      if (conversionRunRef.current !== runId) return;
      if (latest?.status === "canceled") {
        finishCanceledConversion(latest.id, command.token);
        toast.success(formatMessage({ id: "channel.edit.conversionCanceled" }));
        return;
      }
      if (latest) setConversionJob(latest);
      if (uncertain && latest?.status !== "done" && latest?.canCancel !== false) {
        conversionAttemptBaselineRef.current = null;
        // Keep the known-job cancellation record until a conclusive read.
        setConversionConnectionWarning(true);
        setShowConvertConfirm(false);
        return;
      }
      finishObservation(command.token);
      setConversionConnectionWarning(false);
      if (latest?.status === "done") {
        setConvertSucceeded(true);
        setShowConvertConfirm(false);
      }
      setConvertError(uncertain
        ? formatMessage({ id: "channel.edit.cancelConversionUnavailable" })
        : axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedCancelConversion" }));
    } finally {
      if (conversionRunRef.current === runId) setConversionCancelBusy(false);
    }
  };

  const handleUnarchive = async () => {
    setError("");
    setArchiveBusy(true);
    try {
      const updated = await unarchiveChannel(channelId);
      if (guestJoinableLimit >= 0 && channel?.guestJoinable && !updated.guestJoinable) {
        toast.success(formatMessage({ id: "channel.edit.unarchivedGuestJoinDisabled" }, { limit: guestJoinableLimit }));
      }
      onClose();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedUnarchive" }));
    } finally {
      setArchiveBusy(false);
    }
  };

  const handleResendJointInvite = async () => {
    clearResendStatus();
    setResendError("");
    setResendBusy(true);
    try {
      const result = await resendJointChannelInvite(channelId);
      showResendSuccess(result.resentCount);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setResendError(axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedResendInvite" }));
    } finally {
      setResendBusy(false);
    }
  };

  const handleInviteJointServer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setInviteTouched({ serverSlug: true, people: true });
    setInviteStatus("");
    setInviteSubmitError("");
    setInviteServerSlugServerError("");
    setInvitePeopleServerError("");
    if (!inviteFormValid) return;
    if (jointServerLimitReached) {
      setInviteSubmitError(formatMessage({ id: "channel.edit.maxServers" }, { max: MAX_JOINT_CHANNEL_SERVERS }));
      return;
    }

    setInviteBusy(true);
    try {
      await inviteJointChannelServer(channelId, {
        targetServerSlug: normalizedInviteServerSlug,
        invitedPeople: normalizedInvitePeople,
      });
      setInviteServerSlug("");
      setInvitePeopleText("");
      setInviteTouched({ serverSlug: false, people: false });
      setInviteStatus(formatMessage(
        { id: "channel.edit.inviteSentCount" },
        { count: normalizedInvitePeople.length },
      ));
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string; code?: string } } };
      const code = axiosErr.response?.data?.code;
      const message = code === "joint_free_server_limit"
        ? formatMessage({ id: "channel.joint.freeServerLimit" })
        : code === "joint_server_limit"
          ? formatMessage({ id: "channel.joint.serverLimit" }, { max: MAX_JOINT_CHANNEL_SERVERS })
          : axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedInviteServer" });
      if (code === "joint_free_server_limit" || code === "joint_server_limit") {
        setInviteSubmitError(message);
      } else if (/target server|current server|server slug|already in this joint channel/i.test(message)) {
        setInviteServerSlugServerError(message);
      } else if (/invited person|invitee|target server admin/i.test(message)) {
        setInvitePeopleServerError(message);
      } else {
        setInviteSubmitError(message);
      }
    } finally {
      setInviteBusy(false);
    }
  };

  const handleDisconnectJointChannel = async () => {
    await disconnectJointChannel(channelId);
    const fallbackChannel = getFallbackChannel();
    onClose();
    if (fallbackChannel) {
      nav.toChannel(fallbackChannel.id);
    } else {
      nav.toSettings("server");
    }
  };

  const isPanel = presentation === "panel";

  // Action buttons as composable pieces: the legacy sheet shows one flat
  // actions group, while the drawer panel (final4) splits them by object
  // boundary — shared-resource management vs lifecycle — and leaves
  // "Leave channel" to the members section (it edits my own membership).
  const leaveActionButton = showLeaveAction && (
    <Button size="sm"
      variant="warning"
      type="button"
      onClick={() => setShowLeaveConfirm(true)}
      className="flex w-full items-center justify-center gap-1.5 px-4 py-2 text-sm"
    >
      <LogOut size={14} />
      {formatMessage({ id: "channel.edit.leaveChannel" })}
    </Button>
  );
  const visibilityActionButton = !isJointChannel && showVisibilityAction && (
    <Button size="sm"
      variant="warning"
      type="button"
      onClick={() => setShowVisibilityConfirm(true)}
      disabled={isArchived || visibilityBusy}
      className="flex w-full items-center justify-center gap-1.5 px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {isAllChannel
        ? currentVisibility === "private" ? <Eye size={14} /> : <EyeOff size={14} />
        : currentVisibility === "private" ? <Hash size={14} /> : <Lock size={14} />}
      {visibilityBusy
        ? formatMessage({ id: "channel.edit.updating" })
        : isAllChannel
          ? currentVisibility === "private"
            ? formatMessage({ id: "channel.edit.restoreAll" })
            : formatMessage({ id: "channel.edit.hideAll" })
          : currentVisibility === "private"
            ? formatMessage({ id: "channel.edit.makePublic" })
            : formatMessage({ id: "channel.edit.makePrivate" })}
    </Button>
  );
  const lifecycleActionButtons = !isAllChannel && (
    <>
      {effectiveCapabilities.archiveChannels && (isArchived ? (
        <Button size="sm"
          variant="success"
          type="button"
          onClick={handleUnarchive}
          disabled={archiveBusy}
          className="flex w-full items-center justify-center gap-1.5 px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ArchiveRestore size={14} />
          {archiveBusy ? formatMessage({ id: "channel.edit.unarchiving" }) : formatMessage({ id: "channel.edit.unarchiveChannel" })}
        </Button>
      ) : (
        <Button size="sm"
          variant="warning"
          type="button"
          onClick={() => setShowArchiveConfirm(true)}
          className="flex w-full items-center justify-center gap-1.5 px-4 py-2 text-sm"
        >
          <Archive size={14} />
          {formatMessage({ id: "channel.edit.archiveChannel" })}
        </Button>
      ))}
      {!isArchived && effectiveCapabilities.deleteChannels && (showCompletedJointSettings ? (
        <Button size="sm"
          variant="danger"
          type="button"
          onClick={() => setShowDeleteConfirm(true)}
          className="flex w-full items-center justify-center gap-1.5 px-4 py-2 text-sm"
        >
          <Unplug size={14} />
          {formatMessage({ id: "channel.edit.disconnectChannel" })}
        </Button>
      ) : (
        <Button size="sm"
          variant="danger"
          type="button"
          onClick={() => setShowDeleteConfirm(true)}
          className="flex w-full items-center justify-center gap-1.5 px-4 py-2 text-sm"
        >
          <Trash2 size={14} />
          {formatMessage({ id: "channel.edit.deleteChannel" })}
        </Button>
      ))}
    </>
  );

  // final9 panel rows: the same manage/lifecycle actions rendered with
  // the drawer's action-row primitive (icon + label row, red text for
  // irreversible) instead of the sheet's filled block buttons.
  const visibilityActionRow = !isJointChannel && showVisibilityAction && (
    <OverflowActionRow
      icon={
        isAllChannel
          ? currentVisibility === "private" ? <Eye size={14} /> : <EyeOff size={14} />
          : currentVisibility === "private" ? <Hash size={14} /> : <Lock size={14} />
      }
      label={
        visibilityBusy
          ? formatMessage({ id: "channel.edit.updating" })
          : isAllChannel
            ? currentVisibility === "private"
              ? formatMessage({ id: "channel.edit.restoreAll" })
              : formatMessage({ id: "channel.edit.hideAll" })
            : currentVisibility === "private"
              ? formatMessage({ id: "channel.edit.makePublic" })
              : formatMessage({ id: "channel.edit.makePrivate" })
      }
      onClick={() => setShowVisibilityConfirm(true)}
      disabled={isArchived || visibilityBusy}
      testId="channel-settings-visibility-action"
    />
  );
  const archiveActionRow = !isAllChannel && effectiveCapabilities.archiveChannels && (
    isArchived ? (
      <OverflowActionRow
        icon={<ArchiveRestore size={14} />}
        label={archiveBusy ? formatMessage({ id: "channel.edit.unarchiving" }) : formatMessage({ id: "channel.edit.unarchiveChannel" })}
        onClick={() => void handleUnarchive()}
        disabled={archiveBusy}
        testId="channel-settings-archive-action"
      />
    ) : (
      <OverflowActionRow
        icon={<Archive size={14} />}
        label={formatMessage({ id: "channel.edit.archiveChannel" })}
        onClick={() => setShowArchiveConfirm(true)}
        testId="channel-settings-archive-action"
      />
    )
  );
  // Artea 2026-08-05: Delete is the group's LAST row — the destructive
  // action closes the section, after Leave. v2「重量随风险」: the ONLY
  // filled block in the whole drawer — irreversible is what earns fill;
  // reversible actions (visibility/archive/leave/stop) stay outlined.
  const deleteActionRow = !isAllChannel && effectiveCapabilities.deleteChannels && (
    showCompletedJointSettings ? (
      <OverflowActionRow
        icon={<Unplug size={14} />}
        label={formatMessage({ id: "channel.edit.disconnectChannel" })}
        onClick={() => setShowDeleteConfirm(true)}
        danger
        className="[&_[data-slot=button-content]]:justify-center"
        testId="channel-settings-delete-action"
      />
    ) : (
      <OverflowActionRow
        icon={<Trash2 size={14} />}
        label={formatMessage({ id: "channel.edit.deleteChannel" })}
        onClick={() => setShowDeleteConfirm(true)}
        danger
        className="[&_[data-slot=button-content]]:justify-center"
        testId="channel-settings-delete-action"
      />
    )
  );

  // final11 频道偏好: per-user binary settings — Pin, Mute, and the
  // collapse-long-messages switch (server-persisted). Artea 2026-08-06:
  // Channel info (name/description) leads the panel, so BOTH modes render
  // preferences AFTER the form (sheet always did; panel moved). Mute is a
  // panel-only surface via the activityMute prop.
  // The block itself lives in ChannelPreferencesSection (task #703) so the
  // DM settings sheet renders the same preferences without the edit form.
  const preferencesSection = (
    <ChannelPreferencesSection
      channelId={channelId}
      isPanel={isPanel}
      activityMute={activityMute}
      collapseLongMessages={collapseLongMessages}
    />
  );

  const guestAccessSection = canManageGuestAccess && (
    <section className="mt-5" data-testid="channel-settings-guest-access">
      <h3 className="text-base font-bold text-foreground-strong">
        {formatMessage({ id: "channel.edit.guestAccessTitle" })}
      </h3>
      <p className="mt-1 text-xs font-normal text-foreground-muted">
        {formatMessage({ id: "channel.edit.guestAccessDescription" })}
      </p>
      {guestJoinableLimit >= 0 && <p className="mt-2 text-xs font-semibold text-foreground-muted" data-testid="channel-settings-guest-joinable-usage">
        {formatMessage({ id: "channel.edit.guestJoinableUsage" }, { count: guestJoinableCount, limit: guestJoinableLimit })}
      </p>}
      <div className="mt-2 divide-y divide-black/10">
        <div className="flex items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <h4 id="channel-settings-guest-visible-label" className="text-sm font-medium text-foreground-strong">
              {formatMessage({ id: "channel.edit.guestVisibleTitle" })}
            </h4>
            <p className="mt-1 text-xs font-normal text-foreground-muted">
              {formatMessage({ id: "channel.edit.guestVisibleDescription" })}
            </p>
          </div>
          <Switch
            size="md"
            checked={channel?.guestVisible === true}
            disabled={guestPolicyBusy}
            onCheckedChange={(checked) => void updateGuestPolicy(checked
              ? { guestVisible: true }
              : { guestVisible: false, guestJoinable: false })}
            aria-labelledby="channel-settings-guest-visible-label"
            data-testid="channel-settings-guest-visible-switch"
          />
        </div>
        {channel?.name !== "all" && <div className="flex items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <h4 id="channel-settings-guest-joinable-label" className="text-sm font-medium text-foreground-strong">
              {formatMessage({ id: "channel.edit.guestJoinableTitle" })}
            </h4>
            <p className="mt-1 text-xs font-normal text-foreground-muted">
              {formatMessage({ id: "channel.edit.guestJoinableDescription" })}
            </p>
          </div>
          <Switch
            size="md"
            checked={channel?.guestJoinable === true}
            disabled={guestPolicyBusy}
            onCheckedChange={(checked) => void updateGuestPolicy(checked
              ? { guestVisible: true, guestJoinable: true }
              : { guestJoinable: false })}
            aria-labelledby="channel-settings-guest-joinable-label"
            data-testid="channel-settings-guest-joinable-switch"
          />
        </div>}
      </div>
    </section>
  );

  // final11 生命周期四合一: visibility (Make Private) / Archive / Delete /
  // Leave — one group, ordered by the design master. Leave edits only my
  // own membership, so it renders for plain members too; the manage-gated
  // rows keep their own capability guards. Rows bleed to the panel edge
  // (-mx-4) so they align with the host drawer's own action rows.
  const leaveActionRow = showLeaveAction && (
    <OverflowActionRow
      icon={<LogOut size={14} />}
      label={formatMessage({ id: "channel.edit.leaveChannel" })}
      onClick={() => setShowLeaveConfirm(true)}
      testId="channel-overflow-leave"
    />
  );

  const jointConversionSection = showJointConversionSection && (
    <JointConversionSection
      busy={convertBusy}
      disabled={conversionAwaitingReceipt || Boolean(conversionCancelObservationId) || (!showConvertAction && !conversionRetryable)}
      unavailableMessage={jointConversionUnavailableMessage}
      error={conversionConnectionWarning || conversionRequestPending ? undefined : convertError || conversionReceipt?.error || undefined}
      admissionPending={conversionRequestPending}
      connectionWarning={conversionConnectionWarning ? formatMessage({ id: conversionObservationSettled ? "channel.edit.conversionOutcomeUnknown" : "channel.edit.conversionStatusUnavailable" }) : undefined}
      onCheckStatus={conversionConnectionWarning ? () => setConversionObservationRefresh((n) => n + 1) : undefined}
      conversionJob={conversionReceipt}
      succeeded={convertSucceeded}
      progressDismissed={conversionProgressDismissed}
      onDismissProgress={() => setConversionProgressDismissed(true)}
      onRetry={conversionCancelObservationId || (conversionAwaitingReceipt && !convertBusy) ? undefined : () => { void handleConvertToJoint().catch(() => undefined); }}
      onCancel={conversionCancelObservationId ? undefined : () => { void handleCancelConversion(); }}
      onOpenChannel={onClose}
      cancelBusy={conversionCancelBusy}
      headingClassName="text-base font-bold text-foreground-strong theme-brutal:text-black"
      onStart={() => {
        setConvertError("");
        setConvertSucceeded(false);
        // Keep a failed job mounted while its archived source is being
        // retried; clearing it here would re-trigger the archive hide gate
        // before the retry request returns its replacement job.
        if (conversionReceipt?.status !== "failed") setConversionJob(null);
        setConversionProgressDismissed(false);
        setShowConvertConfirm(true);
      }}
    />
  );
  const jointAttachmentUploadSection = (showCompletedJointSettings || conversionInProgress) && (
    <JointAttachmentUploadSection
      uploads={activeAttachmentUploads}
      cancelBusyId={activeAttachmentUploadCancelBusyId}
      onOpenChannel={onClose}
      onCancel={(uploadId) => {
        void cancelActiveAttachmentUpload(uploadId)
          .then((remaining) => {
            setConversionJob((current) => {
              const base = current ?? conversionReceipt;
              return base
                ? {
                    ...base,
                    error: remaining.length === 0 ? null : base.error,
                    progress: remaining.length === 0
                      ? Object.fromEntries(
                          Object.entries(base.progress ?? {}).filter(([key]) => (
                            key !== "errorCode" && key !== "uploadCount" && key !== "uploadScope"
                          )),
                        )
                      : { ...(base.progress ?? {}), uploadCount: remaining.length },
                  }
                : current;
            });
            if (remaining.length === 0) setConvertError("");
          })
          .catch(() => undefined);
      }}
    />
  );
  // Shared body: the standalone sheet and the overflow-drawer panel
  // (task #187) render identical sections — only the chrome differs.
  const settingsBody = (
    <>
      {isJointChannel && showCompletedJointSettings && ((!conversionReceipt && !convertSucceeded) || conversionProgressDismissed) && (
        <section
          className="space-y-4 border-b border-line-muted pb-5 theme-brutal:border-black/10"
          data-testid="channel-settings-joint-section"
        >
          <div>
            <div className="flex items-center gap-1.5">
              <h4 className="text-sm font-medium text-foreground-strong">
                {formatMessage({ id: "channel.edit.connectedServers" })}
              </h4>
              <Tooltip content={formatMessage({ id: "channel.edit.connectedServersRule" })}>
                <button
                  type="button"
                  className="flex size-5 items-center justify-center text-foreground-muted hover:text-foreground-strong focus:outline-none"
                  aria-label={formatMessage({ id: "channel.edit.connectedServersRule" })}
                  data-testid="channel-settings-joint-servers-rule"
                >
                  <Info size={14} aria-hidden="true" />
                </button>
              </Tooltip>
            </div>
            {jointServers.length > 0 ? (
              <div className="mt-2 divide-y divide-black/10" data-testid="channel-settings-joint-servers">
                {jointServers.map((server) => (
                  <div key={`${server.serverId}:${server.status}`} className="flex items-center justify-between gap-3 py-3" data-testid="channel-settings-joint-server-row">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground-strong">{server.serverName || server.serverSlug}</div>
                      <div className="mt-1 truncate text-xs font-normal text-foreground-muted">
                        {server.serverSlug}{server.isCurrentServer ? ` · ${formatMessage({ id: "channel.edit.thisServer" })}` : ""}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {"plan" in server && server.plan && (
                        <Badge appearance="soft" variant={server.plan === "paid" ? "accent" : "muted"} data-testid="channel-settings-joint-server-plan">
                          {formatMessage({ id: server.plan === "paid" ? "channel.edit.serverPlanPaid" : "billing.free" })}
                        </Badge>
                      )}
                      <Badge appearance="soft" variant={server.status === "active" ? "success" : "warning"} data-testid="channel-settings-joint-server-status">
                        {formatMessage({ id: server.status === "active" ? "channel.edit.serverStatusActive" : "channel.edit.serverStatusPending" })}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-foreground-muted">{formatMessage({ id: "channel.edit.connectedMetaUnavailable" })}</p>
            )}
          </div>
          {capabilities.federateChannels && hasCurrentServerPendingJointInvites && !isArchived && (
            <div className="space-y-2">
              <div className="flex justify-end" data-testid="channel-settings-joint-resend-row">
                <Button type="button" onClick={handleResendJointInvite} disabled={resendBusy} size="sm" variant={resendStatus ? "success" : "outline"} className="disabled:cursor-not-allowed disabled:opacity-50">
                  {resendStatus ? <Check size={14} aria-hidden="true" /> : <Mail size={14} aria-hidden="true" />}
                  <span className="grid w-max whitespace-nowrap" data-testid="channel-settings-joint-resend-label-grid">
                    <span aria-hidden="true" className="invisible col-start-1 row-start-1">{formatMessage({ id: "channel.edit.resendInvite" })}</span>
                    <span aria-hidden="true" className="invisible col-start-1 row-start-1">{formatMessage({ id: "channel.edit.resending" })}</span>
                    <span aria-hidden="true" className="invisible col-start-1 row-start-1">{formatMessage({ id: "channel.edit.resendSuccess" })}</span>
                    <span className="col-start-1 row-start-1" data-testid="channel-settings-joint-resend-label">
                      {resendBusy ? formatMessage({ id: "channel.edit.resending" }) : resendStatus ? formatMessage({ id: "channel.edit.resendSuccess" }) : formatMessage({ id: "channel.edit.resendInvite" })}
                    </span>
                  </span>
                </Button>
              </div>
              {resendStatus && <span className="sr-only" role="status" aria-live="polite" data-testid="channel-settings-joint-resend-status">{resendStatus}</span>}
              {resendError && <p className="text-xs font-normal text-brutal-red" role="alert">{resendError}</p>}
            </div>
          )}
          {capabilities.federateChannels && !isArchived && (
            <div className="space-y-3 border-t border-line-muted pt-4 theme-brutal:border-black/10" data-testid="channel-settings-joint-invite">
              <h4 className="text-sm font-medium text-foreground-strong">{formatMessage({ id: "channel.edit.inviteServerSection" })}</h4>
              {jointServerLimitReached ? (
                <p className="text-sm font-normal text-foreground-muted">{formatMessage({ id: "channel.edit.maxServers" }, { max: MAX_JOINT_CHANNEL_SERVERS })}</p>
              ) : (
                <form className="space-y-3" data-testid="channel-settings-joint-invite-form" onSubmit={handleInviteJointServer} noValidate>
                  <FormField label={formatMessage({ id: "channel.edit.serverSlugLabel" })} labelStyle="plain" required htmlFor="channel-settings-joint-server-slug" error={inviteServerSlugError}>
                    <SlugInput id="channel-settings-joint-server-slug" name="targetServerSlug" type="text" value={inviteServerSlug} onChange={(e) => { setInviteServerSlug(e.target.value); setInviteServerSlugServerError(""); setInviteSubmitError(""); setInviteStatus(""); }} onBlur={() => setInviteTouched((current) => ({ ...current, serverSlug: true }))} placeholder={formatMessage({ id: "channel.edit.serverSlugPlaceholder" })} required autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={inviteServerSlugError ? "true" : undefined} disabled={inviteBusy} />
                  </FormField>
                  <FormField label={formatMessage({ id: "channel.edit.invitedPeopleLabel" })} labelStyle="plain" required hint={formatMessage({ id: "channel.edit.invitedPeopleHint" })} htmlFor="channel-settings-joint-invited-people" error={invitePeopleError}>
                    <Textarea id="channel-settings-joint-invited-people" name="invitedPeople" value={invitePeopleText} onChange={(e) => { setInvitePeopleText(e.target.value); setInvitePeopleServerError(""); setInviteSubmitError(""); setInviteStatus(""); }} onBlur={() => setInviteTouched((current) => ({ ...current, people: true }))} className="w-full" placeholder={formatMessage({ id: "channel.edit.invitedPeoplePlaceholder" })} rows={2} required data-invalid={Boolean(invitePeopleError)} disabled={inviteBusy} />
                  </FormField>
                  <div className="flex justify-end" data-testid="channel-settings-joint-send-invite-row">
                    <Button type="submit" disabled={inviteBusy || !inviteFormValid} size="sm" variant="accent" className="disabled:cursor-not-allowed disabled:opacity-50" data-testid="channel-settings-joint-send-invite"><Mail size={14} />{inviteBusy ? formatMessage({ id: "channel.edit.inviting" }) : formatMessage({ id: "channel.edit.sendInvite" })}</Button>
                  </div>
                  {inviteSubmitError && <Banner intent="warning" className="font-normal" data-testid="channel-settings-joint-invite-submit-error">{inviteSubmitError}</Banner>}
                  {inviteStatus && <p className="text-xs font-normal text-foreground-muted" role="status">{inviteStatus}</p>}
                </form>
              )}
            </div>
          )}
        </section>
      )}
      {jointConversionSection}
      {jointAttachmentUploadSection}
      {isPanel && showManageActions && showChannelInfoSettings && (
        /* The one-word Info section owns the name/description form and its
           description directly; repeating a subordinate "Channel info"
           heading would flatten the hierarchy. Members with only Leave/Mute
           (no manage capability) never see an empty header. */
        <div className="mt-5 mb-3">
          <h3
            className="text-base font-bold text-foreground-strong"
            data-testid="channel-settings-manage-group"
          >
            {formatMessage({ id: "message.chatPanel.overflow.manageGroup" })}
          </h3>
          <p
            className="mt-1 text-xs font-normal text-foreground-muted"
            data-testid="channel-settings-info-description"
          >
            {formatMessage({ id: "message.channelSettings.infoDescription" })}
          </p>
        </div>
      )}
      <form id={CHANNEL_SETTINGS_FORM_ID} onSubmit={handleSubmit} className="space-y-5">
        {error && (
          <Banner
            intent="warning"
            className="font-bold"
            role="alert"
            data-testid="channel-settings-save-error"
          >
            {error}
          </Banner>
        )}
        {canEditChannel && showChannelInfoSettings && (
          <section className="space-y-3 border-b border-line-muted pb-5 theme-brutal:border-black/10">
            <div className="space-y-3">
                  <FormField
                    label={formatMessage({ id: "channel.edit.nameLabel" })}
                    labelStyle="plain"
                    className="[&>label]:!font-medium"
                    htmlFor="channel-settings-name"
                    required
                    hint={
                      isAllChannel
                        ? formatMessage({ id: "channel.edit.allCannotRename" })
                        : showCompletedJointSettings
                          ? formatMessage({ id: "channel.edit.jointNameShared" })
                          : undefined
                    }
                  >
                    <Input
                      id="channel-settings-name"
                      type="text"
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value);
                        setError("");
                        clearSaveStatus();
                      }}
                      className="w-full"
                      placeholder={formatMessage({ id: "channel.edit.namePlaceholder" })}
                      required
                      autoFocus={!isPanel}
                      disabled={isAllChannel || isArchived}
                    />
                  </FormField>
                  <FormField
                    label={formatMessage({ id: "channel.edit.descriptionLabel" })}
                    labelStyle="plain"
                    className="[&>label]:!font-medium"
                    htmlFor="channel-settings-description"
                    optional
                  >
                    <Textarea
                      id="channel-settings-description"
                      value={description}
                      onChange={(e) => {
                        setDescription(e.target.value);
                        setError("");
                        clearSaveStatus();
                      }}
                      className="w-full"
                      placeholder={formatMessage({ id: "channel.edit.descriptionPlaceholder" })}
                      rows={2}
                      disabled={isArchived}
                    />
                  </FormField>
                  {isPanel && (
                    /* Save/Cancel live inside the editable section in panel
                       mode. The same action also commits an optional Slack
                       bridge selection without closing the drawer. */
                    <>
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          onClick={resetDraft}
                          disabled={!hasSavableDraft || saving}
                          size="sm"
                          variant="outline"
                          className="disabled:cursor-not-allowed disabled:opacity-50"
                          data-testid="channel-settings-discard-draft"
                        >
                          {formatMessage({ id: "settings.common.cancel" })}
                        </Button>
                        <Button
                          type="button"
                          onClick={() => void saveChanges()}
                          disabled={!hasSavableDraft || saving || isArchived}
                          size="sm"
                          variant={saveStatus ? "success" : "accent"}
                          className="disabled:cursor-not-allowed disabled:opacity-50"
                          data-testid="channel-settings-save-inline"
                        >
                          {saving
                            ? formatMessage({ id: "channel.edit.saving" })
                            : saveStatus
                              ? <><Check size={12} aria-hidden="true" /> {saveStatus}</>
                              : formatMessage({ id: "channel.edit.saveChanges" })}
                        </Button>
                      </div>
                      {saveStatus && (
                        <span
                          className="sr-only"
                          role="status"
                          aria-live="polite"
                          data-testid="channel-settings-save-status"
                        >
                          {saveStatus}
                        </span>
                      )}
                    </>
                  )}
            </div>
          </section>
        )}
      </form>
      {canEditChannel && !isArchived && (channel?.type === "channel" || channel?.type === "private") && (
        <ChannelSlackBridgeField
          editor={bridgeEditor}
          visibility={currentVisibility}
          disabled={saving}
        />
      )}
      {guestAccessSection}
          {preferencesSection}

          {isPanel ? (
            /* final11 object boundaries in the drawer: v2「重量随风险」 keeps lifecycle actions
               ordered visibility → Archive → Leave → Stop agents → Delete,
               with Delete as the only filled action. Artea 2026-08-09:
               render these as centered, vertically stacked raft-ui Buttons;
               the container adds no competing border or shadow. Leave still
               renders without manage capability. */
            <>
              {showChannelInfoSettings && ((showManageActions && (visibilityActionRow || archiveActionRow || deleteActionRow)) || (isArchived && archiveActionRow) || leaveActionRow || (!isArchived && stopAgentsRow)) && (
                <section className="mt-5" data-testid="channel-settings-lifecycle-group">
                  <h3 className="text-base font-bold text-foreground-strong">
                    {formatMessage({ id: "message.chatPanel.overflow.lifecycleGroup" })}
                  </h3>
                  <div
                    className="mt-2 flex flex-col gap-2 [&_[data-slot=button-content]]:!justify-center"
                    data-testid="channel-settings-action-zone"
                  >
                    {showManageActions && visibilityActionRow}
                    {(showManageActions || isArchived) && archiveActionRow}
                    {leaveActionRow}
                    {!isArchived && stopAgentsRow}
                    {showManageActions && deleteActionRow}
                  </div>
                </section>
              )}
            </>
          ) : (
            showChannelInfoSettings && (showLeaveAction || showManageActions || (isArchived && effectiveCapabilities.archiveChannels)) && (
              <section className="mt-5 space-y-3">
                <div>
                  <h3 className="text-xs font-bold tracking-wide text-foreground-muted">
                    {formatMessage({ id: "message.channelSettings.actionsTitle" })}
                  </h3>
                  <p className="mt-1 text-xs text-foreground-muted">
                    {formatMessage({ id: "message.channelSettings.actionsDescription" })}
                  </p>
                </div>
                <div className="flex flex-col gap-3">
                  {leaveActionButton}
                  {visibilityActionButton}
                  {lifecycleActionButtons}
                </div>
              </section>
            )
          )}
    </>
  );

  const saveButton = canEditChannel && (
    <Button size="sm"
      variant="accent"
      type="submit"
      form={CHANNEL_SETTINGS_FORM_ID}
      disabled={saving || isArchived}
      className="px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {saving ? formatMessage({ id: "channel.edit.saving" }) : formatMessage({ id: "channel.edit.saveChanges" })}
    </Button>
  );

  return (
    <>
      {isPanel ? (
        /* Drawer-embedded flat sections (task #187): same body as the
           sheet, no Drawer chrome, and no global footer — final6 moves
           Save/Cancel into the name/description section; closing is the
           host drawer's job (guarded by the unsaved-changes prompt).
           v2: identity lives in the yellow header, so the panel drops
           its own title and keeps only a hairline from the members
           strip above. */
        <div className="safe-bottom border-t border-line-muted px-4 pt-3 theme-brutal:border-black/10" data-testid="channel-settings-panel">
          {settingsBody}
        </div>
      ) : (
        <ChannelSettingsSheet isDirty={isDirty} onClose={onClose}>
          <div className="flex shrink-0 items-center justify-between gap-4 border-b border-line-muted bg-primary-soft px-4 py-3 text-foreground-strong theme-brutal:border-b-2 theme-brutal:border-black theme-brutal:bg-soft-signal theme-brutal:text-black">
            <div className="min-w-0">
              <p className="text-[10px] font-bold tracking-wide text-foreground-muted theme-brutal:text-black/55">
                {formatMessage({ id: "message.channelSettings.eyebrow" })}
              </p>
              <DrawerTitle id="channel-settings-title" className="truncate font-display text-xl font-bold text-foreground-strong theme-brutal:text-black">
                {formatMessage({ id: "message.channelSettings.title" })}
              </DrawerTitle>
              <DrawerDescription className="truncate font-mono text-xs text-foreground-muted theme-brutal:text-black/60">
                #{initialName}
              </DrawerDescription>
            </div>
            <DrawerClose
              render={(
                <Button size="sm"
                  variant="outline"
                  type="button"
                  className="p-1"
                  aria-label={formatMessage({ id: "message.channelSettings.close" })}
                />
              )}
            >
              <X size={20} />
            </DrawerClose>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {settingsBody}
          </div>

          <div className="safe-bottom flex shrink-0 justify-end gap-3 border-t border-line-muted theme-brutal:border-t-2 theme-brutal:border-black bg-layer-canvas-muted theme-brutal:bg-brutal-cream px-4 py-3">
            <DrawerClose
              render={(
                <Button size="sm"
                  variant="outline"
                  type="button"
                  className="px-4 py-2 text-sm"
                />
              )}
            >
              {formatMessage({ id: "settings.common.cancel" })}
            </DrawerClose>
            {saveButton}
          </div>
        </ChannelSettingsSheet>
      )}

      {showArchiveConfirm && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "channel.edit.archiveChannel" })}
          message={formatMessage({ id: "channel.edit.confirmArchive" }, { name: initialName })}
          confirmLabel={formatMessage({ id: "channel.edit.archiveAction" })}
          loadingLabel={formatMessage({ id: "channel.edit.archiving" })}
          confirmColor="bg-brutal-orange"
          layer={1}
          onConfirm={async () => {
            try {
              await archiveChannel(channelId);
              setShowArchiveConfirm(false);
              onClose();
            } catch (err: unknown) {
              const axiosErr = err as { response?: { data?: { error?: string } } };
              setError(axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedArchive" }));
              setShowArchiveConfirm(false);
            }
          }}
          onClose={() => setShowArchiveConfirm(false)}
        />
      )}

      {showVisibilityConfirm && (
        <ConfirmDialog
          chromeLocale="active"
          title={
            isAllChannel
              ? currentVisibility === "private" ? formatMessage({ id: "channel.edit.restoreAll" }) : formatMessage({ id: "channel.edit.hideAll" })
              : currentVisibility === "private" ? formatMessage({ id: "channel.edit.makeChannelPublic" }) : formatMessage({ id: "channel.edit.makeChannelPrivate" })
          }
          message={
            isAllChannel
              ? currentVisibility === "private"
                ? formatMessage({ id: "channel.edit.confirmRestoreAll" })
                : formatMessage({ id: "channel.edit.confirmHideAll" })
              : currentVisibility === "private"
                ? formatMessage({ id: "channel.edit.confirmMakePublic" }, { name: initialName })
                : formatMessage({ id: "channel.edit.confirmMakePrivate" }, { name: initialName })
          }
          confirmLabel={
            isAllChannel
              ? currentVisibility === "private" ? formatMessage({ id: "channel.edit.restoreAll" }) : formatMessage({ id: "channel.edit.hideAll" })
              : currentVisibility === "private" ? formatMessage({ id: "channel.edit.confirmPublicAction" }) : formatMessage({ id: "channel.edit.confirmPrivateAction" })
          }
          loadingLabel={formatMessage({ id: "channel.edit.updating" })}
          confirmColor="bg-brutal-orange"
          layer={1}
          onConfirm={handleVisibilityChange}
          onClose={() => setShowVisibilityConfirm(false)}
        />
      )}

      {showLeaveConfirm && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "channel.edit.leaveChannel" })}
          message={formatMessage({ id: "channel.edit.confirmLeave" }, { name: initialName })}
          confirmLabel={formatMessage({ id: "channel.edit.leaveAction" })}
          loadingLabel={formatMessage({ id: "channel.edit.leaving" })}
          confirmColor="bg-brutal-orange"
          confirmTestId={isPanel ? "channel-overflow-leave-confirm" : undefined}
          layer={1}
          onConfirm={async () => {
            await onLeaveChannel?.();
            onClose();
          }}
          onClose={() => setShowLeaveConfirm(false)}
        />
      )}

      <JointConversionConfirmDialog
        open={showConvertConfirm}
        busy={convertBusy}
        error={convertError}
        channelName={initialName}
        onConfirm={handleConvertToJoint}
        onClose={() => setShowConvertConfirm(false)}
      />

      {showDeleteConfirm && (
        <ConfirmDialog
          chromeLocale="active"
          title={showCompletedJointSettings ? formatMessage({ id: "channel.edit.disconnectJointChannel" }) : formatMessage({ id: "channel.edit.deleteChannel" })}
          message={showCompletedJointSettings
            ? formatMessage({ id: "channel.edit.confirmDisconnect" }, { name: initialName })
            : formatMessage({ id: "channel.edit.confirmDelete" }, { name: initialName })}
          confirmLabel={showCompletedJointSettings ? formatMessage({ id: "channel.edit.disconnectAction" }) : formatMessage({ id: "channel.edit.deleteAction" })}
          loadingLabel={showCompletedJointSettings ? formatMessage({ id: "channel.edit.disconnecting" }) : formatMessage({ id: "channel.edit.deleting" })}
          layer={1}
          onConfirm={async () => {
            if (showCompletedJointSettings) {
              await handleDisconnectJointChannel();
              return;
            }
            await deleteChannel(channelId);
            const fallbackChannel = getFallbackChannel();
            onClose();
            if (fallbackChannel) {
              nav.toChannel(fallbackChannel.id);
            } else {
              nav.toSettings("server");
            }
          }}
          onClose={() => setShowDeleteConfirm(false)}
        />
      )}
    </>
  );
}
