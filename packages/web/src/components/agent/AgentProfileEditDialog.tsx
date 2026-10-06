import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Upload, X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  RadioGroup,
  RadioGroupItem,
  Textarea,
} from "raft-ui";
import type { ServerRole } from "@botiverse/raft-shared";
import api from "../../api/client";
import { useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { avatarUploadApiErrorMessage, isAvatarFileTooLarge, isAvatarTooLargeError, PROFILE_AVATAR_ACCEPT } from "../../utils/avatarUpload";
import type { MessageId } from "../../i18n/messages";
import AvatarSlot from "../ui/AvatarSlot";
import FormField from "../ui/FormField";
import Tooltip from "../ui/Tooltip";
import { AVATAR_KEYS, DEFAULT_AVATAR_KEY, isCustomAvatar, parsePixelAvatar } from "./PixelAvatar";

export type AgentProfileEditField = "displayName" | "description" | "role" | "avatar";
type EditableRole = Extract<ServerRole, "admin" | "member">;

export const MAX_AGENT_DESCRIPTION_LENGTH = 3000;

const TITLE_ID = {
  displayName: "agent.detail.editDisplayName",
  description: "agent.detail.editDescription",
  role: "agent.detail.editRole",
  avatar: "agent.detail.chooseAvatar",
} as const satisfies Record<AgentProfileEditField, MessageId>;

/** Avatar choice staged in the dialog; nothing is sent until Save. */
type AvatarDraft =
  | { kind: "unchanged" }
  | { kind: "preset"; key: string }
  | { kind: "default" }
  | { kind: "upload"; file: File; previewUrl: string };

export type AgentProfileEditDialogProps = {
  agent: Agent;
  open: boolean;
  /** The one field this dialog edits (the one whose pencil was clicked). */
  field: AgentProfileEditField;
  onClose: () => void;
  /** Role options the viewer may assign; empty = role is not editable here. */
  roleOptions: { id: EditableRole; label: string }[];
};

/**
 * Edits one profile field (name, description, role or avatar) in a dialog. The
 * change is staged and applied only on Save; closing with unsaved changes asks
 * first. Saved values go through the agent store, which every surface
 * (profile header, info, top bar, lists) reads, so nothing is left stale.
 */
export default function AgentProfileEditDialog({ agent, open, field, onClose, roleOptions }: AgentProfileEditDialogProps) {
  const { formatMessage } = useIntl();
  const updateAgent = useAgentStore((s) => s.updateAgent);
  const ids = { name: useId(), description: useId(), role: useId(), avatar: useId(), title: useId() };
  const currentRole: EditableRole | null = agent.serverRole === "admin" || agent.serverRole === "member" ? agent.serverRole : null;
  const canEditRole = currentRole !== null && roleOptions.length > 0;

  const [displayName, setDisplayName] = useState(agent.displayName || "");
  const [description, setDescription] = useState(agent.description || "");
  const [role, setRole] = useState<EditableRole | null>(currentRole);
  const [avatar, setAvatar] = useState<AvatarDraft>({ kind: "unchanged" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The dialog is mounted per opening, so the initial state above is always the
  // store's current values (the single source of truth). A staged upload's
  // preview URL is released when replaced and when the dialog unmounts.
  const previewUrlRef = useRef<string | null>(null);
  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);
  const stageAvatar = (next: AvatarDraft) => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = next.kind === "upload" ? next.previewUrl : null;
    setAvatar(next);
  };

  const trimmedName = displayName.trim();
  const trimmedDescription = description.trim();
  // Only the field this dialog edits can change.
  const nameChanged = field === "displayName" && trimmedName !== (agent.displayName || "");
  const descriptionChanged = field === "description" && trimmedDescription !== (agent.description || "");
  const roleChanged = field === "role" && canEditRole && role !== currentRole;
  const avatarChanged = field === "avatar" && avatar.kind !== "unchanged";
  const dirty = nameChanged || descriptionChanged || roleChanged || avatarChanged;
  const descriptionTooLong = field === "description" && trimmedDescription.length > MAX_AGENT_DESCRIPTION_LENGTH;

  const requestClose = () => {
    if (saving) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const previewAvatarUrl = useMemo(() => {
    if (avatar.kind === "preset") return `pixel:${avatar.key}`;
    if (avatar.kind === "default") return null;
    if (avatar.kind === "upload") return avatar.previewUrl;
    return agent.avatarUrl ?? null;
  }, [avatar, agent.avatarUrl]);
  const selectedPreset = avatar.kind === "preset"
    ? avatar.key
    : avatar.kind === "default"
      ? DEFAULT_AVATAR_KEY
      : avatar.kind === "unchanged" && !isCustomAvatar(agent.avatarUrl)
        ? (parsePixelAvatar(agent.avatarUrl ?? "") ?? DEFAULT_AVATAR_KEY)
        : null;

  const stageUpload = (file: File) => {
    if (isAvatarFileTooLarge(file)) {
      setError(formatMessage({ id: "avatar.tooLarge" }, { maxLabel: formatMessage({ id: "common.fileSize.maxLabel5mb" }) }));
      return;
    }
    setError("");
    stageAvatar({ kind: "upload", file, previewUrl: URL.createObjectURL(file) });
  };

  const save = async () => {
    if (!dirty || descriptionTooLong) return;
    setSaving(true);
    setError("");
    try {
      if (avatar.kind === "upload") {
        const formData = new FormData();
        formData.append("avatar", avatar.file);
        const res = await api.post(`/agents/${agent.id}/avatar`, formData, {
          headers: { "Content-Type": "multipart/form-data" },
        });
        // The server stored the avatar; write its record into the shared store.
        useAgentStore.setState((state) => ({
          agents: state.agents.map((a) => (a.id === agent.id ? { ...a, ...res.data } : a)),
        }));
      }
      const fields: Parameters<typeof updateAgent>[1] = {};
      if (nameChanged) fields.displayName = trimmedName || null;
      if (descriptionChanged) fields.description = trimmedDescription || null;
      if (roleChanged && role) fields.serverRole = role;
      if (avatar.kind === "preset") fields.avatarUrl = `pixel:${avatar.key}`;
      if (avatar.kind === "default") fields.avatarUrl = null;
      if (Object.keys(fields).length > 0) await updateAgent(agent.id, fields);
      onClose();
    } catch (err: unknown) {
      if (avatar.kind === "upload" && isAvatarTooLargeError(err)) {
        setError(formatMessage({ id: "avatar.tooLarge" }, { maxLabel: formatMessage({ id: "common.fileSize.maxLabel5mb" }) }));
      } else if (avatar.kind === "upload") {
        setError(avatarUploadApiErrorMessage(err, formatMessage({ id: "agent.detail.uploadAvatarFailed" })));
      } else {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        setError(axiosErr.response?.data?.error || formatMessage({ id: "agent.detail.editProfile.saveFailed" }));
      }
    } finally {
      setSaving(false);
    }
  };

  const presetButtonClass = (selected: boolean) =>
    `flex size-10 items-center justify-center overflow-hidden rounded-md border transition-colors theme-brutal:rounded-none theme-brutal:border-2 ${
      selected
        ? "border-accent bg-accent-soft theme-brutal:border-brutal-pink theme-brutal:bg-brutal-pink/20"
        : "border-line-muted hover:border-line-strong theme-brutal:border-black"
    }`;

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!next) requestClose(); }}>
        <DialogContent aria-labelledby={ids.title} className="max-w-lg" data-testid="agent-profile-edit-dialog">
          <DialogHeader>
            <DialogTitle id={ids.title}>{formatMessage({ id: TITLE_ID[field] })}</DialogTitle>
            <Button
              type="button"
              variant="outline"
              size="icon-md"
              aria-label={formatMessage({ id: "common.close" })}
              onClick={requestClose}
              disabled={saving}
            >
              <X className="size-5" aria-hidden="true" />
            </Button>
          </DialogHeader>
          <DialogBody className="grid gap-5 font-normal">
            {field === "displayName" ? (
            <FormField label={formatMessage({ id: "agent.detail.displayName" })} htmlFor={ids.name} labelStyle="plain">
              <Input
                id={ids.name}
                value={displayName}
                autoFocus={field === "displayName"}
                placeholder={agent.name}
                onChange={(e) => setDisplayName(e.target.value.replace(/[\r\n]+/g, " "))}
                data-testid="agent-profile-edit-display-name"
              />
            </FormField>
            ) : null}
            {field === "description" ? (
            <FormField
              label={formatMessage({ id: "machine.detail.description" })}
              htmlFor={ids.description}
              labelStyle="plain"
              error={descriptionTooLong
                ? formatMessage({ id: "agent.detail.descriptionMaxLength" }, { count: MAX_AGENT_DESCRIPTION_LENGTH })
                : undefined}
            >
              <Textarea
                id={ids.description}
                value={description}
                rows={3}
                autoFocus={field === "description"}
                placeholder={formatMessage({ id: "agent.detail.describeAgentPlaceholder" })}
                onChange={(e) => setDescription(e.target.value)}
                data-testid="agent-profile-edit-description"
              />
            </FormField>
            ) : null}
            {field === "role" && canEditRole && role ? (
              <RadioGroup
                aria-label={formatMessage({ id: "agent.detail.role" })}
                value={role}
                onValueChange={(next) => { if (next === "admin" || next === "member") setRole(next); }}
                className="grid gap-3"
                data-testid="agent-profile-edit-role"
              >
                {roleOptions.map((option) => (
                  <label key={option.id} className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <RadioGroupItem value={option.id} autoFocus={option.id === role} />
                    {option.label}
                  </label>
                ))}
              </RadioGroup>
            ) : null}
            {field === "avatar" ? (
            // The dialog title already names this field, so no separate label.
            <div>
              <div className="flex items-start gap-4" data-testid="agent-profile-edit-avatar">
                <div className="size-16 shrink-0">
                  <AvatarSlot context="profile-tile" type="agent" agentAvatarUrl={previewAvatarUrl} />
                </div>
                <div className="flex min-w-0 flex-wrap gap-2">
                  <Tooltip content={formatMessage({ id: "agent.detail.uploadImage" })}>
                    <button
                      type="button"
                      autoFocus={field === "avatar"}
                      aria-label={formatMessage({ id: "agent.detail.uploadImage" })}
                      onClick={() => fileInputRef.current?.click()}
                      className={presetButtonClass(avatar.kind === "upload" || (avatar.kind === "unchanged" && isCustomAvatar(agent.avatarUrl)))}
                    >
                      <Upload size={16} className="text-foreground-muted theme-brutal:text-black/60" />
                    </button>
                  </Tooltip>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={PROFILE_AVATAR_ACCEPT}
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.currentTarget.value = "";
                      if (file) stageUpload(file);
                    }}
                  />
                  {AVATAR_KEYS.map((key) => (
                    <Tooltip key={key} content={key}>
                      <button
                        type="button"
                        aria-label={key}
                        aria-pressed={selectedPreset === key}
                        onClick={() => stageAvatar(key === DEFAULT_AVATAR_KEY ? { kind: "default" } : { kind: "preset", key })}
                        className={presetButtonClass(selectedPreset === key)}
                      >
                        <AvatarSlot context="panel-header" type="agent" agentAvatarUrl={`pixel:${key}`} />
                      </button>
                    </Tooltip>
                  ))}
                </div>
              </div>
            </div>
            ) : null}
            {error ? <Banner status="warning" size="sm" role="alert">{error}</Banner> : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={requestClose} disabled={saving}>
              {formatMessage({ id: "common.confirm.cancel" })}
            </Button>
            <Button
              type="button"
              variant="accent"
              size="sm"
              loading={saving}
              disabled={!dirty || descriptionTooLong}
              onClick={() => void save()}
              data-testid="agent-profile-edit-save"
            >
              {formatMessage({ id: "machine.detail.save" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDiscard} onOpenChange={(next) => { if (!next) setConfirmDiscard(false); }}>
        <AlertDialogContent data-testid="agent-profile-edit-discard">
          <AlertDialogHeader>
            <AlertDialogTitle>{formatMessage({ id: "message.chatPanel.overflow.unsavedTitle" })}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogBody>{formatMessage({ id: "agent.detail.editProfile.discardBody" })}</AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">{formatMessage({ id: "message.chatPanel.overflow.keepEditing" })}</AlertDialogCancel>
            <AlertDialogAction
              variant="danger"
              size="sm"
              onClick={() => { setConfirmDiscard(false); onClose(); }}
            >
              {formatMessage({ id: "message.chatPanel.overflow.discardChanges" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
