import { Badge, ProfilePanelBody, Button, DirectMessageIcon } from "raft-ui";
import CloseButton from "../ui/CloseButton";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatRuntimeLabelWithStatus } from "../../utils/runtimeAvailabilityLabel";
import { useIntl } from "react-intl";
import {
  HelpCircle,
  Trash2,
  X,
  Pencil,
  Upload,
} from "lucide-react";
import { SERVER_GUEST_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type {
  ProfileVisibilityMembershipStatus,
  ServerRole,
} from "@botiverse/raft-shared";
import { useAuthStore } from "../../store/authStore";
import { useChannelStore } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import { useProfileStore } from "../../store/profileStore";
import { useThreadStore } from "../../store/threadStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useAppNavigate, useMobileBack } from "../../hooks/useAppNavigate";
import ConfirmDialog from "../ConfirmDialog";
import InlineBadgeEditor from "../InlineBadgeEditor";
import AvatarSlot from "../ui/AvatarSlot";
import { useImageLightboxStore } from "../../store/imageLightboxStore";
import { isRaftUploadedHumanAvatarUrl } from "../../utils/humanAvatar";
import PanelHeader from "../ui/PanelHeader";
import SectionEyebrow from "../ui/SectionEyebrow";
import SectionHeader from "../ui/SectionHeader";
import KeyValueRow from "../ui/KeyValueRow";
import {
  computeAgentDisplayState,
  selectAgentActivitiesSlice,
  useAgentStore,
} from "../../store/agentStore";
import type {
  AgentCreatedSummary,
} from "../../store/agentStore";
import AvatarListRow from "../ui/AvatarListRow";
import StatusDot from "../ui/StatusDot";
import Tooltip from "../ui/Tooltip";
import RolePermissionHelpDialog from "./RolePermissionHelpDialog";
import { getHumanDepartureLabel } from "./humanMembershipStatus";
import {
  avatarUploadApiErrorMessage,
  isAvatarFileTooLarge,
  isAvatarTooLargeError,
  PROFILE_AVATAR_ACCEPT,
} from "../../utils/avatarUpload";
import { formatAgentDisplayStateText } from "../../utils/activity";
import type { MessageId } from "../../i18n/messages";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { getEditableHumanServerRoles } from "./humanRoleTransitions";

const ROLE_CONFIG: Record<ServerRole, { labelId: MessageId; color: string }> = {
  owner: { labelId: "member.detail.roleOwner", color: "bg-warning-soft text-warning-strong theme-brutal:bg-brutal-orange theme-brutal:text-black" },
  admin: { labelId: "member.detail.roleAdmin", color: "bg-accent-soft text-accent-strong theme-brutal:bg-brutal-pink theme-brutal:text-black" },
  member: { labelId: "member.detail.roleMember", color: "bg-fill-muted text-foreground-strong theme-brutal:bg-brutal-lavender theme-brutal:text-black" },
  guest: { labelId: "member.detail.roleGuest", color: "bg-info-soft text-info-strong theme-brutal:bg-brutal-cyan theme-brutal:text-black" },
};
const EDITABLE_ROLE_OPTIONS: { id: ServerRole; labelId: MessageId }[] = [
  { id: "owner", labelId: "member.detail.roleOwner" },
  { id: "admin", labelId: "member.detail.roleAdmin" },
  { id: "member", labelId: "member.detail.roleMember" },
  { id: "guest", labelId: "member.detail.roleGuest" },
];
const MAX_HUMAN_DESCRIPTION_LENGTH = 3000;

export interface HumanProfile {
  userId: string;
  serverId?: string;
  serverName?: string | null;
  serverSlug?: string | null;
  email: string | null;
  gravatarHash: string;
  name: string;
  displayName: string | null;
  description: string | null;
  avatarUrl: string | null;
  role: ServerRole | null;
  joinedAt: string | null;
  membershipStatus: ProfileVisibilityMembershipStatus;
  createdAgents: AgentCreatedSummary[];
  profileProjection?: "channel_summary";
}

export default function HumanDetailPanel({
  human,
  onClose,
  onBack,
  onOpenProfile,
}: {
  human: HumanProfile;
  onClose?: () => void;
  /** Drawer/page-stack mode: return to the previous in-drawer page.
   *  Unlike the responsive route back control, this stays visible on
   *  desktop and never consults browser history. */
  onBack?: () => void;
  /** Controlled page stacks use this instead of the global profile overlay. */
  onOpenProfile?: (type: "agent" | "human", id: string) => void;
}) {
  const intl = useIntl();
  const { formatDate, formatMessage } = intl;
  const currentUser = useAuthStore((s) => s.user);
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const uploadAvatar = useAuthStore((s) => s.uploadAvatar);
  const isSelf = currentUser?.id === human.userId;
  const openUserDM = useChannelStore((s) => s.openUserDM);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const updateMemberRole = useServerStore((s) => s.updateMemberRole);
  const removeMember = useServerStore((s) => s.removeMember);
  const loadMembers = useServerStore((s) => s.loadMembers);
  const members = useServerStore((s) => s.members);
  const serverSlug = useServerStore((s) => s.current?.slug);
  const currentServerId = useServerStore((s) => s.current?.id);
  const isRemoteJointHuman = Boolean(
    currentServerId && human.serverId && human.serverId !== currentServerId,
  );
  const isChannelSummaryHuman = human.profileProjection === "channel_summary";
  const sourceServerLabel = isRemoteJointHuman
    ? human.serverName || human.serverSlug || null
    : null;
  // Two render modes for HumanDetailPanel — see AgentDetailPanel for the
  // same pattern. Overlay mode (`onClose` provided) routes back through
  // the closer rather than skipping past the underlying channel/DM to
  // /members. Cold-start permalink repro: #proj-mobile:b1c622e5
  // (stdrc 2026-05-08).
  const responsiveBack = useMobileBack(
    onClose ?? (serverSlug ? `/s/${serverSlug}/members` : "/"),
  );
  const headerBack = onBack ?? responsiveBack;
  const { role: currentRole, capabilities } = useServerPermissions();
  const serverGuestEnabled = useServerFeatureFlag(SERVER_GUEST_FEATURE_FLAG_KEY).enabled;
  const nav = useAppNavigate();
  // Named-slice subscriptions + render-time compute (see MachineDetailPanel /
  // React #185 incident note): a selector-built map of display states is a
  // fresh object per snapshot and loops the render.
  const storeAgentsForDisplay = useAgentStore((s) => s.agents);
  const activitiesSliceForDisplay = useAgentStore(selectAgentActivitiesSlice);
  // Panel state. The parent (MainLayout L386) passes `key={resolvedHuman.userId}`
  // so this component fully unmounts and remounts whenever the displayed human
  // changes — every state below is therefore entity-scoped and gets clean
  // defaults on every entity switch. The Edit buttons (L289/L396) re-seed
  // `descriptionValue` / `roleValue` from the current prop before flipping the
  // editing flag, so the initial values here are only observed before any edit.
  const [editingRole, setEditingRole] = useState(false);
  const [roleValue, setRoleValue] = useState<ServerRole>(
    human.role ?? "member",
  );
  const [rolePickerOpen, setRolePickerOpen] = useState(false);
  const [roleSaving, setRoleSaving] = useState(false);
  const [roleError, setRoleError] = useState("");
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionValue, setDescriptionValue] = useState(
    human.description || "",
  );
  const [descriptionSaving, setDescriptionSaving] = useState(false);
  const [descriptionError, setDescriptionError] = useState("");
  const [showRoleHelp, setShowRoleHelp] = useState(false);
  // Derive avatar from the canonical source per render. For self, the
  // currentUser store entry is authoritative — authStore.uploadAvatar
  // calls `set({ user: data })`, so the new URL flows back through the
  // selector without any local mirror. For other humans, the prop is the
  // only writer (no one else can upload their avatar). A bare
  // useState(human.avatarUrl) mirror is what react-doctor's
  // no-derived-useState rule guards against.
  const avatarUrl = isSelf ? (currentUser?.avatarUrl ?? null) : human.avatarUrl;
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const roleInfo = human.role
    ? ROLE_CONFIG[human.role] || ROLE_CONFIG.member
    : null;
  const editableRoleOptions = useMemo(
    () => {
      if (!human.role) return [];
      const allowed = new Set(getEditableHumanServerRoles({
        actorRole: currentRole,
        targetRole: human.role,
        isSelf,
        ownerCount: members.filter((member) => member.role === "owner").length,
        serverGuestEnabled,
      }));
      return EDITABLE_ROLE_OPTIONS.filter((option) => allowed.has(option.id));
    },
    [currentRole, human.role, isSelf, members, serverGuestEnabled],
  );
  const localizedEditableRoleOptions = useMemo(
    () =>
      editableRoleOptions.map((option) => ({
        id: option.id,
        label: formatMessage({ id: option.labelId }),
      })),
    [editableRoleOptions, formatMessage],
  );
  const canEditRole =
    human.membershipStatus === "active" &&
    !isRemoteJointHuman &&
    capabilities.changeMemberRoles &&
    editableRoleOptions.length > 0;
  const canRemove =
    human.membershipStatus === "active" &&
    !isRemoteJointHuman &&
    capabilities.removeMembers &&
    !isSelf &&
    (human.role === "owner"
      ? currentRole === "owner" &&
        members.filter((member) => member.role === "owner").length > 1
      : currentRole === "owner" || human.role === "member");
  const departureLabel = getHumanDepartureLabel(human.membershipStatus);
  const departureLabelText =
    departureLabel === "Left"
      ? formatMessage({ id: "member.detail.statusLeft" })
      : departureLabel === "Removed"
        ? formatMessage({ id: "member.detail.statusRemoved" })
        : null;

  const joinedDate = human.joinedAt
    ? formatDate(new Date(human.joinedAt), {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;

  // Find existing DM channel for this human
  const dmChannel = useMemo(
    () => dmChannels.find((c) => c.peerId === human.userId),
    [dmChannels, human.userId],
  );
  const canMessageHuman =
    human.membershipStatus === "active" &&
    !isRemoteJointHuman &&
    ((currentRole !== "guest" && human.role !== "guest") || Boolean(dmChannel));

  useEffect(() => {
    if (!editingDescription || !descriptionRef.current) return;
    descriptionRef.current.style.height = "0px";
    descriptionRef.current.style.height = `${descriptionRef.current.scrollHeight}px`;
  }, [descriptionValue, editingDescription]);

  const handleUploadAvatar = async (file: File) => {
    // Already correct in shape — this only converges the page-scoped duplicate
    // onto the shared id so there is one "too large" sentence, not two.
    if (isAvatarFileTooLarge(file)) {
      setAvatarError(formatMessage({ id: "avatar.tooLarge" }, { maxLabel: formatMessage({ id: "common.fileSize.maxLabel5mb" }) }));
      return;
    }
    setAvatarSaving(true);
    setAvatarError("");
    try {
      await uploadAvatar(file);
      // authStore.uploadAvatar already calls `set({ user: data })`, so
      // the currentUser selector above re-renders the derived avatarUrl
      // with the new URL — no local mirror needed.
      await loadMembers();
    } catch (err: any) {
      // Map the size code first — avatarUploadApiErrorMessage would otherwise
      // return err.message and render the raw "AVATAR_TOO_LARGE" identifier.
      setAvatarError(
        isAvatarTooLargeError(err)
          ? formatMessage({ id: "avatar.tooLarge" }, { maxLabel: formatMessage({ id: "common.fileSize.maxLabel5mb" }) })
          : avatarUploadApiErrorMessage(
              err,
              formatMessage({ id: "member.detail.uploadAvatarFailed" }),
            ),
      );
    } finally {
      setAvatarSaving(false);
    }
  };

  return (
    <ProfilePanelBody className="flex min-h-0 flex-1 flex-col bg-layer-panel theme-brutal:bg-white">
      {isSelf && human.membershipStatus === "active" && (
        <input
          ref={avatarInputRef}
          type="file"
          accept={PROFILE_AVATAR_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.currentTarget.value = "";
            if (file) void handleUploadAvatar(file);
          }}
        />
      )}
      <PanelHeader
        title={human.displayName || human.name}
        subtitle={`@${human.name}`}
        iconSlot={
          <AvatarSlot
            context="panel-header"
            type="human"
            humanAvatarUrl={avatarUrl}
            gravatarHash={human.gravatarHash}
          />
        }
        iconAlwaysVisible
        onMobileBack={headerBack}
        backButtonVisibility={onBack ? "always" : "responsive"}
        mobileBackProps={{
          "data-testid": "human-mobile-back",
          title: formatMessage({ id: "common.announcement.back" }),
        }}
        actions={
          <>
            {canMessageHuman && (
              <Tooltip content={formatMessage({ id: "member.detail.message" })}>
              <Button size="sm" variant="outline"
                onClick={async () => {
                  useProfileStore.getState().closeProfile();
                  useThreadStore.getState().closeThread();
                  if (dmChannel) {
                    nav.toDm(dmChannel.id);
                  } else {
                    const ch = await openUserDM(human.userId);
                    if (ch) nav.toDm(ch.id);
                  }
                }}
                className="flex size-7 items-center justify-center"
                aria-label={formatMessage({ id: "member.detail.message" })}
                data-slot="button"
              >
                <DirectMessageIcon width={14} height={14} />
              </Button>
              </Tooltip>
            )}
            {onClose && (
              <CloseButton
                onClick={onClose}
                className={` size-7 items-center justify-center ${onBack ? "flex" : "hidden md:flex"}`}
                title={formatMessage({ id: "common.close" })}
              >
                <X size={14} />
              </CloseButton>
            )}
          </>
        }
      />

      {/* Profile content — unified cream background, light separators */}
      <div className="flex-1 overflow-y-auto bg-layer-panel theme-brutal:bg-white">
        {sourceServerLabel && (
          <div className="border-b border-line-muted theme-brutal:border-black/10 px-5 py-3">
            <SectionEyebrow as="div" className="mb-1">
              {formatMessage({ id: "member.detail.from" })}
            </SectionEyebrow>
            <div className="text-sm font-bold text-foreground-strong theme-brutal:text-black">
              {sourceServerLabel}
            </div>
          </div>
        )}
        {/* Avatar + name — left-aligned like agent profile */}
        <div className="flex items-start gap-4 px-5 py-5">
          {isSelf && human.membershipStatus === "active" ? (
            <Tooltip content={formatMessage({
              id: avatarSaving
                ? "member.detail.uploadingAvatar"
                : "member.detail.uploadImage",
            })}>
            <button
              type="button"
              onClick={() => avatarInputRef.current?.click()}
              disabled={avatarSaving}
              className="group relative flex shrink-0 disabled:cursor-not-allowed disabled:opacity-70"
              aria-label={formatMessage({
                id: avatarSaving
                  ? "member.detail.uploadingAvatar"
                  : "member.detail.uploadImage",
              })}
            >
              <AvatarSlot
                context="profile-tile"
                type="human"
                humanAvatarUrl={avatarUrl}
                gravatarHash={human.gravatarHash}
              />
              <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                <Upload size={18} className="text-white" />
              </span>
            </button>
            </Tooltip>
          ) : isRaftUploadedHumanAvatarUrl(avatarUrl) ? (
            <Tooltip content={formatMessage({ id: "member.detail.viewAvatar" })}>
            <button
              type="button"
              onClick={() =>
                useImageLightboxStore
                  .getState()
                  .openImage(avatarUrl, human.displayName || human.name)
              }
              className="group relative flex shrink-0"
              aria-label={formatMessage({ id: "member.detail.viewAvatar" })}
            >
              <AvatarSlot
                context="profile-tile"
                type="human"
                humanAvatarUrl={avatarUrl}
                gravatarHash={human.gravatarHash}
              />
            </button>
            </Tooltip>
          ) : (
            <AvatarSlot
              context="profile-tile"
              type="human"
              humanAvatarUrl={avatarUrl}
              gravatarHash={human.gravatarHash}
            />
          )}
          <div className="min-w-0 flex-1">
            <div
              className="min-w-0 truncate text-lg font-bold leading-tight text-foreground-strong theme-brutal:text-black"
            >
              {human.displayName || human.name}
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="min-w-0 truncate text-sm font-mono text-foreground-muted theme-brutal:text-black/50"
              >
                @{human.name}
              </span>
              {departureLabel && (
                <span className="inline-flex shrink-0 items-center px-1.5 py-0.5 text-[10px] font-bold uppercase border border-line-muted theme-brutal:border-black bg-gray-300 text-foreground-muted theme-brutal:text-black/60">
                  {departureLabelText}
                </span>
              )}
              {isSelf && (
                <span className="shrink-0 text-sm text-foreground-muted theme-brutal:text-black/60 font-mono">
                  {formatMessage({ id: "member.detail.you" })}
                </span>
              )}
            </div>
          </div>
        </div>
        {isSelf && human.membershipStatus === "active" && avatarError && (
          <div
            className="-mt-3 px-5 pb-4 text-xs font-bold text-brutal-red"
            role="alert"
          >
            {avatarError}
          </div>
        )}

        <div className="px-5 py-4 border-t border-line-muted theme-brutal:border-black/10">
          <div className="flex items-center gap-2 mb-1">
            <SectionEyebrow as="div">
              {formatMessage({ id: "member.detail.description" })}
            </SectionEyebrow>
            {isSelf &&
              human.membershipStatus === "active" &&
              !editingDescription && (
                <Tooltip content={formatMessage({ id: "member.detail.editDescription" })}>
                <button
                  type="button"
                  onClick={() => {
                    setDescriptionValue(human.description || "");
                    setDescriptionError("");
                    setEditingDescription(true);
                  }}
                  className="text-foreground-muted theme-brutal:text-black/40 hover:text-foreground-strong theme-brutal:hover:text-black transition-colors"
                  aria-label={formatMessage({
                    id: "member.detail.editDescription",
                  })}
                >
                  <Pencil size={12} />
                </button>
                </Tooltip>
              )}
          </div>
          {isSelf && human.membershipStatus === "active" ? (
            editingDescription ? (
              <div className="space-y-[5px]">
                <textarea
                  ref={descriptionRef}
                  value={descriptionValue}
                  onChange={(e) => {
                    if (descriptionError) setDescriptionError("");
                    setDescriptionValue(e.target.value);
                  }}
                  rows={3}
                  maxLength={MAX_HUMAN_DESCRIPTION_LENGTH}
                  placeholder={formatMessage({
                    id: "member.detail.descriptionPlaceholder",
                  })}
                  className="m-0 min-h-10 w-full border-2 border-line-muted theme-brutal:border-black px-2 py-1 text-sm leading-4 shadow-raft-sm theme-brutal:shadow-brutal-sm focus:outline-none focus:shadow-raft-sm theme-brutal:focus:shadow-brutal-sm resize-none overflow-hidden"
                />
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="accent"
                    type="button"
                    onClick={async () => {
                      const nextDescription = descriptionValue.trim();
                      if (
                        nextDescription.length > MAX_HUMAN_DESCRIPTION_LENGTH
                      ) {
                        setDescriptionError(
                          formatMessage(
                            { id: "member.detail.descriptionMaxLength" },
                            { count: MAX_HUMAN_DESCRIPTION_LENGTH },
                          ),
                        );
                        return;
                      }
                      setDescriptionSaving(true);
                      setDescriptionError("");
                      try {
                        await updateProfile({
                          description: nextDescription || null,
                        });
                        await loadMembers();
                        setEditingDescription(false);
                      } catch (err: any) {
                        setDescriptionError(
                          err.response?.data?.error ||
                            formatMessage({
                              id: "member.detail.updateDescriptionFailed",
                            }),
                        );
                      } finally {
                        setDescriptionSaving(false);
                      }
                    }}
                    className="px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={descriptionSaving}
                  >
                    {descriptionSaving
                      ? formatMessage({ id: "member.detail.saving" })
                      : formatMessage({ id: "member.detail.save" })}
                  </Button>
                  <Button size="sm" variant="outline"
                    type="button"
                    onClick={() => {
                      setDescriptionValue(human.description || "");
                      setDescriptionError("");
                      setEditingDescription(false);
                    }}
                    className="px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={descriptionSaving}
                  >
                    {formatMessage({ id: "member.detail.cancel" })}
                  </Button>
                </div>
                <div className="flex items-center justify-between gap-3 text-xs">
                  {descriptionError ? (
                    <span className="font-bold text-brutal-red">
                      {descriptionError}
                    </span>
                  ) : (
                    <span />
                  )}
                  <span className="font-mono text-foreground-muted theme-brutal:text-black/50">
                    {descriptionValue.trim().length}/
                    {MAX_HUMAN_DESCRIPTION_LENGTH}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-foreground-strong theme-brutal:text-black">
                {human.description || (
                  <span className="italic text-foreground-muted theme-brutal:text-black/40">
                    {formatMessage({ id: "member.detail.noDescription" })}
                  </span>
                )}
              </p>
            )
          ) : (
            <div className="text-sm text-foreground-strong theme-brutal:text-black">
              {human.description || (
                <span className="italic text-foreground-muted theme-brutal:text-black/40">
                  {formatMessage({ id: "member.detail.noDescription" })}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Info */}
        {!isRemoteJointHuman && !isChannelSummaryHuman && (
          <div className="px-5 py-4 border-t border-line-muted theme-brutal:border-black/10">
            <SectionEyebrow as="div" className="mb-3">
              {formatMessage({ id: "member.detail.info" })}
            </SectionEyebrow>
            <div className="space-y-3">
              {/* Role */}
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <div className="text-xs text-foreground-muted theme-brutal:text-black/50">
                    {departureLabel
                      ? formatMessage({ id: "member.detail.status" })
                      : formatMessage({ id: "member.detail.role" })}
                  </div>
                  {!departureLabel && (
                    <Tooltip content={formatMessage({
                      id: "member.detail.rolePermissions",
                    })}>
                    <button
                      type="button"
                      onClick={() => setShowRoleHelp(true)}
                      className="text-foreground-muted theme-brutal:text-black/35 transition-colors hover:text-foreground-strong theme-brutal:hover:text-black"
                      aria-label={formatMessage({
                        id: "member.detail.rolePermissions",
                      })}
                    >
                      <HelpCircle size={12} />
                    </button>
                    </Tooltip>
                  )}
                  {canEditRole && roleInfo && !editingRole && (
                    <Tooltip content={formatMessage({ id: "member.detail.editRole" })}>
                    <button
                      type="button"
                      onClick={() => {
                        setRoleValue(human.role ?? "member");
                        setRolePickerOpen(true);
                        setRoleError("");
                        setEditingRole(true);
                      }}
                      className="text-foreground-muted theme-brutal:text-black/40 hover:text-foreground-strong theme-brutal:hover:text-black transition-colors"
                      aria-label={formatMessage({
                        id: "member.detail.editRole",
                      })}
                    >
                      <Pencil size={12} />
                    </button>
                    </Tooltip>
                  )}
                </div>
                {departureLabel ? (
                  <span className="inline-block border-2 border-line-muted theme-brutal:border-black px-2 py-0.5 text-xs font-bold text-foreground-strong theme-brutal:text-black bg-gray-300">
                    {departureLabelText}
                  </span>
                ) : canEditRole && roleInfo ? (
                  <div className="space-y-1.5">
                    {editingRole ? (
                      <>
                        <div className="relative inline-block">
                          <InlineBadgeEditor
                            displayValue={formatMessage({
                              id: (ROLE_CONFIG[roleValue] || ROLE_CONFIG.member)
                                .labelId,
                            })}
                            selectedId={roleValue}
                            options={localizedEditableRoleOptions}
                            onSelect={(nextRole) => {
                              setRoleValue(nextRole as ServerRole);
                              setRolePickerOpen(false);
                            }}
                            open={rolePickerOpen}
                            onToggle={() =>
                              setRolePickerOpen((value) => !value)
                            }
                            badgeClassName={
                              (ROLE_CONFIG[roleValue] || ROLE_CONFIG.member)
                                .color
                            }
                            uppercase={false}
                            dropdownMinWidth="min-w-[140px]"
                            dropdownAlign="left"
                          />
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Button size="sm" variant="accent"
                            type="button"
                            onClick={async () => {
                              try {
                                setRoleSaving(true);
                                setRoleError("");
                                await updateMemberRole(human.userId, roleValue);
                                setEditingRole(false);
                              } catch (err: unknown) {
                                const axiosErr = err as {
                                  response?: { data?: { error?: string } };
                                };
                                setRoleError(
                                  axiosErr.response?.data?.error ||
                                    formatMessage({
                                      id: "member.detail.updateRoleFailed",
                                    }),
                                );
                              } finally {
                                setRoleSaving(false);
                              }
                            }}
                            disabled={roleSaving || roleValue === human.role}
                            className="px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {formatMessage({ id: "member.detail.save" })}
                          </Button>
                          <Button size="sm" variant="outline"
                            type="button"
                            onClick={() => {
                              setRoleValue(human.role ?? "member");
                              setRolePickerOpen(false);
                              setRoleError("");
                              setEditingRole(false);
                            }}
                            disabled={roleSaving}
                            className="px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {formatMessage({ id: "member.detail.cancel" })}
                          </Button>
                        </div>
                      </>
                    ) : (
                      <Badge className={roleInfo.color}>{formatMessage({ id: roleInfo.labelId })}</Badge>
                    )}
                  </div>
                ) : roleInfo ? (
                  <Badge className={roleInfo.color}>{formatMessage({ id: roleInfo.labelId })}</Badge>
                ) : (
                  <span className="inline-block border-2 border-line-muted theme-brutal:border-black px-2 py-0.5 text-xs font-bold text-foreground-strong theme-brutal:text-black bg-gray-100">
                    {formatMessage({ id: "member.detail.unknown" })}
                  </span>
                )}
                {roleError && (
                  <div className="mt-1 text-xs font-bold text-brutal-orange">
                    {roleError}
                  </div>
                )}
              </div>
              {/* Email */}
              {human.email && (
                <KeyValueRow
                  label={formatMessage({ id: "member.detail.email" })}
                  value={human.email}
                  mono
                  breakAll
                />
              )}
              {/* Joined */}
              {joinedDate && (
                <KeyValueRow
                  label={formatMessage({ id: "member.detail.joined" })}
                  value={joinedDate}
                  mono
                />
              )}
            </div>
          </div>
        )}
        {!isRemoteJointHuman && !isChannelSummaryHuman && (
          <div className="px-5 py-4 border-t border-line-muted theme-brutal:border-black/10">
            <SectionHeader
              className="mb-3"
              label={formatMessage({ id: "member.detail.createdAgents" })}
              count={human.createdAgents?.length ?? 0}
            />
            {human.createdAgents?.length ? (
              <div className="space-y-2">
                {human.createdAgents.map((createdAgent) => {
                  const displayState = computeAgentDisplayState(
                    storeAgentsForDisplay,
                    activitiesSliceForDisplay,
                    createdAgent.id,
                    createdAgent,
                  );
                  const activityText = formatAgentDisplayStateText(intl, displayState);
                  return (
                    <AvatarListRow
                      key={createdAgent.id}
                      avatar={
                        <AvatarSlot
                          context="surface-list"
                          type="agent"
                          agentAvatarUrl={createdAgent.avatarUrl}
                        />
                      }
                      name={createdAgent.displayName || createdAgent.name}
                      subtitle={formatRuntimeLabelWithStatus(createdAgent.runtime, formatMessage)}
                      rightContent={
                        <StatusDot
                          activity={displayState.activity}
                          title={activityText}
                        />
                      }
                      onClick={() => {
                        if (onOpenProfile) {
                          onOpenProfile("agent", createdAgent.id);
                          return;
                        }
                        useProfileStore.getState().openProfile("agent", createdAgent.id);
                      }}
                    />
                  );
                })}
              </div>
            ) : (
              <span className="text-sm italic text-foreground-muted theme-brutal:text-black/40">
                {formatMessage({ id: "member.detail.noCreatedAgents" })}
              </span>
            )}
          </div>
        )}
        {canRemove && (
          <div className="px-5 py-4 border-t border-line-muted theme-brutal:border-black/10">
            <SectionEyebrow as="div" className="mb-3">
              {formatMessage({ id: "member.detail.actions" })}
            </SectionEyebrow>
            <Button size="sm" variant="danger"
              onClick={() => setShowRemoveConfirm(true)}
              className="flex w-full items-center justify-center gap-2 px-4 py-2 text-sm font-bold"
            >
              <Trash2 size={14} />
              {formatMessage({ id: "member.detail.removeMember" })}
            </Button>
          </div>
        )}
      </div>
      {showRemoveConfirm && (
        <ConfirmDialog
          title={formatMessage({ id: "member.detail.removeMember" })}
          message={formatMessage(
            { id: "member.detail.removeMemberConfirmMessage" },
            { name: human.displayName || human.name },
          )}
          confirmLabel={formatMessage({ id: "member.detail.removeAction" })}
          loadingLabel={formatMessage({ id: "member.detail.removing" })}
          chromeLocale="active"
          onConfirm={async () => {
            setRemoving(true);
            try {
              await removeMember(human.userId);
            } finally {
              setRemoving(false);
            }
          }}
          onClose={() => {
            if (!removing) setShowRemoveConfirm(false);
          }}
        />
      )}
      {showRoleHelp && (
        <RolePermissionHelpDialog
          subject="human"
          onClose={() => setShowRoleHelp(false)}
        />
      )}
    </ProfilePanelBody>
  );
}
