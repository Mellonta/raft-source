import { Input, Textarea, Card, Button } from "raft-ui";
import { useMemo, useRef, useState } from "react";
import { Check, GitBranch, Plus, Search, Trash2 } from "lucide-react";
import { MAX_JOINT_CHANNEL_SERVERS, validateNameReason } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import { formatNameValidationError } from "../../i18n/nameValidation";
import { useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useChannelStore } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import AvatarSlot from "../ui/AvatarSlot";
import Banner from "../ui/Banner";
import FormField from "../ui/FormField";
import SectionEyebrow from "../ui/SectionEyebrow";
import SlugInput from "../ui/SlugInput";
import DialogCard from "../ui/DialogCard";
import { usePeopleSuggestionSearch } from "../../hooks/usePeopleSuggestionSearch";
import type { PeopleSuggestionCandidate } from "../../utils/peopleSuggestionSearch";

interface ArchivedCollision {
  archivedChannelId: string;
  archivedChannelName: string;
  canUnarchiveArchivedChannel: boolean;
}

interface JointInviteDraft {
  id: string;
  targetServerSlug: string;
  invitedPeopleText: string;
}

function isBillingGateError(error: string) {
  return error.includes("requires the Pro plan");
}

export default function CreateJointChannelDialog({ onClose }: { onClose: () => void }) {
  const { formatMessage } = useIntl();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [jointInviteDrafts, setJointInviteDrafts] = useState<JointInviteDraft[]>([
    { id: "invite-1", targetServerSlug: "", invitedPeopleText: "" },
  ]);
  const [memberSearch, setMemberSearch] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  const [selectedHumanIds, setSelectedHumanIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [billingError, setBillingError] = useState(false);
  const [archivedCollision, setArchivedCollision] = useState<ArchivedCollision | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submitInFlightRef = useRef(false);
  const nextInviteIdRef = useRef(2);
  const createChannel = useChannelStore((s) => s.createChannel);
  const unarchiveChannel = useChannelStore((s) => s.unarchiveChannel);
  const allAgents = useAgentStore((s) => s.agents);
  const members = useServerStore((s) => s.members);
  const plan = useServerStore((s) => s.current?.plan) || "free";
  const currentUser = useAuthStore((s) => s.user);
  const nav = useAppNavigate();
  // Contract v0.3: free servers may host any number of joint channels; the
  // limit is at most 2 free servers per joint channel, enforced by the server.
  const freeAllowance = plan === "free";

  const memberSearchCandidates = useMemo<PeopleSuggestionCandidate<(typeof allAgents)[number] | (typeof members)[number]>[]>(() => [
      ...allAgents.filter((agent) => !agent.deletedAt).map((agent) => ({
        kind: "agent" as const,
        id: agent.id,
        value: agent,
        handle: agent.name,
        displayName: agent.displayName,
        description: agent.description,
      })),
      ...members.filter((member) => member.userId !== currentUser?.id).map((member) => ({
        kind: "human" as const,
        id: member.userId,
        value: member,
        handle: member.name,
        displayName: member.displayName,
        description: member.description,
        sourceServerLabel: member.serverName || member.serverSlug,
      })),
    ], [allAgents, currentUser?.id, members]);
  const { entries: memberSearchEntries, ranked: rankedMembers } = usePeopleSuggestionSearch(
    memberSearch,
    memberSearchCandidates,
  );
  const filteredAgents = rankedMembers.filter((candidate) => candidate.kind === "agent").map((candidate) => candidate.value as (typeof allAgents)[number]);
  const filteredHumans = rankedMembers.filter((candidate) => candidate.kind === "human").map((candidate) => candidate.value as (typeof members)[number]);
  const hasMembers = memberSearchEntries.length > 0;
  const hasFilteredMembers = filteredAgents.length > 0 || filteredHumans.length > 0;
  const maxJointInviteDrafts = MAX_JOINT_CHANNEL_SERVERS - 1;
  const canAddJointInviteDraft = jointInviteDrafts.length < maxJointInviteDrafts;

  // A submit error is about the invite list it was submitted with (e.g. the
  // free-server limit). Once that list changes, the error no longer describes
  // it, so clear it rather than leave a stale reason on screen.
  const clearSubmitError = () => {
    setError("");
    setBillingError(false);
  };

  const updateJointInviteDraft = (id: string, updates: Partial<Omit<JointInviteDraft, "id">>) => {
    clearSubmitError();
    setJointInviteDrafts((prev) => prev.map((draft) => draft.id === id ? { ...draft, ...updates } : draft));
  };

  const addJointInviteDraft = () => {
    if (!canAddJointInviteDraft) return;
    clearSubmitError();
    const id = `invite-${nextInviteIdRef.current++}`;
    setJointInviteDrafts((prev) => [...prev, { id, targetServerSlug: "", invitedPeopleText: "" }]);
  };

  const removeJointInviteDraft = (id: string) => {
    clearSubmitError();
    setJointInviteDrafts((prev) => prev.length > 1 ? prev.filter((draft) => draft.id !== id) : prev);
  };

  const toggleAgent = (agentId: string) => {
    setSelectedAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const toggleHuman = (userId: string) => {
    setSelectedHumanIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitInFlightRef.current) return;
    setError("");
    setBillingError(false);
    setArchivedCollision(null);

    const nameError = formatNameValidationError(
      validateNameReason(name),
      "channel.create.nameFieldName",
      formatMessage,
    );
    if (nameError) {
      setError(nameError);
      return;
    }
    const jointInvites = jointInviteDrafts.map((draft) => ({
      targetServerSlug: draft.targetServerSlug.trim(),
      invitedPeople: draft.invitedPeopleText
        .split(/[\n,]+/)
        .map((person) => person.trim())
        .filter(Boolean),
    }));
    const incompleteInvite = jointInvites.find((invite) => !invite.targetServerSlug || invite.invitedPeople.length === 0);
    if (incompleteInvite?.targetServerSlug === "") {
      setError(formatMessage({ id: "channel.edit.inviteSlugRequired" }));
      return;
    }
    if (incompleteInvite) {
      setError(formatMessage({ id: "channel.edit.inviteePersonRequired" }));
      return;
    }

    submitInFlightRef.current = true;
    setSubmitting(true);
    try {
      const channel = await createChannel(name.trim(), description.trim() || undefined, {
        visibility: "joint",
        agentIds: [...selectedAgentIds],
        userIds: [...selectedHumanIds],
        jointInvites,
      });
      onClose();
      nav.toChannel(channel.id);
    } catch (err: unknown) {
      const axiosErr = err as {
        response?: {
          data?: {
            error?: string;
            code?: string;
            archivedChannelId?: string;
            archivedChannelName?: string;
            archivedChannelType?: string;
            canUnarchiveArchivedChannel?: boolean;
          };
        };
      };
      const body = axiosErr.response?.data;
      if (
        body?.code === "archived_name_collision"
        && body.archivedChannelId
        && body.archivedChannelName
        && body.archivedChannelType === "joint"
      ) {
        setArchivedCollision({
          archivedChannelId: body.archivedChannelId,
          archivedChannelName: body.archivedChannelName,
          canUnarchiveArchivedChannel: body.canUnarchiveArchivedChannel === true,
        });
      } else if (body?.code === "joint_free_server_limit") {
        setError(formatMessage({ id: "channel.joint.freeServerLimit" }));
        setBillingError(true);
      } else if (body?.code === "joint_server_limit") {
        setError(formatMessage({ id: "channel.joint.serverLimit" }, { max: MAX_JOINT_CHANNEL_SERVERS }));
      } else {
        const nextError = body?.error || formatMessage({ id: "channel.createJoint.failedCreate" });
        setError(nextError);
        setBillingError(isBillingGateError(nextError));
      }
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const handleUnarchiveCollision = async () => {
    if (!archivedCollision) return;
    setSubmitting(true);
    try {
      const channel = await unarchiveChannel(archivedCollision.archivedChannelId);
      onClose();
      nav.toChannel(channel.id);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "channel.create.failedUnarchive" }));
    } finally {
      setSubmitting(false);
    }
  };

  const dialogTitle = (
    <span className="flex min-w-0 items-center gap-2">
      <GitBranch size={18} className="shrink-0" />
      <span className="truncate">{formatMessage({ id: "channel.createJoint.title" })}</span>
    </span>
  );

  return (
    <DialogCard
      title={dialogTitle}
      onClose={onClose}
      maxWidthClass="max-w-lg"
    >
        <form onSubmit={handleSubmit} className="space-y-4">
          {freeAllowance && (
            <Banner intent="info" className="font-bold">
              {formatMessage({ id: "channel.createJoint.freeAllowance" })}
            </Banner>
          )}
          {error && (
            <Banner intent="warning" className="font-bold">
              {error}
              {billingError && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      nav.toSettings("billing");
                    }}
                    className="font-bold text-foreground-strong theme-brutal:text-black underline"
                  >
                    {formatMessage({ id: "channel.createJoint.viewBilling" })}
                  </button>
                </>
              )}
            </Banner>
          )}
          {archivedCollision && (
            <Banner intent="warning" className="space-y-2">
              <p className="font-bold">
                {formatMessage(
                  { id: "channel.create.archivedNameHeld" },
                  {
                    name: archivedCollision.archivedChannelName,
                    mono: (chunks: React.ReactNode) => <span key="mono" className="font-mono">{chunks}</span>,
                  },
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                {archivedCollision.canUnarchiveArchivedChannel && (
                  <Button size="sm"
                    variant="success"
                    type="button"
                    onClick={handleUnarchiveCollision}
                    disabled={submitting}
                    className="px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {formatMessage({ id: "channel.create.unarchive" })}
                  </Button>
                )}
                <Button size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => {
                    setArchivedCollision(null);
                    setName("");
                  }}
                  className="px-2 py-1 text-xs"
                >
                  {formatMessage({ id: "channel.create.changeName" })}
                </Button>
              </div>
            </Banner>
          )}

          <FormField label={formatMessage({ id: "channel.create.nameLabel" })} required>
            <Input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full"
              placeholder={formatMessage({ id: "channel.createJoint.namePlaceholder" })}
              required
              autoFocus
            />
          </FormField>

          <FormField label={formatMessage({ id: "channel.create.descriptionLabel" })} optional>
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="w-full"
              placeholder={formatMessage({ id: "channel.createJoint.descriptionPlaceholder" })}
              rows={2}
            />
          </FormField>

          <Card className="space-y-3 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-foreground-muted theme-brutal:text-black/60">
                <GitBranch size={14} />
                {formatMessage({ id: "channel.createJoint.inviteServersSection" })}
              </div>
              <Button size="sm"
                variant="outline"
                type="button"
                onClick={addJointInviteDraft}
                disabled={submitting || !canAddJointInviteDraft}
                className="flex items-center gap-1 px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Plus size={14} />
                {formatMessage({ id: "channel.createJoint.addServer" })}
              </Button>
            </div>
            {/* Only at the cap, as in EditChannelDialog: it explains why "Add server" is disabled. */}
            {!canAddJointInviteDraft && (
              <p className="text-xs font-bold text-foreground-muted theme-brutal:text-black/60" data-testid="create-joint-max-servers-hint">
                {formatMessage(
                  { id: "channel.createJoint.maxServers" },
                  { max: MAX_JOINT_CHANNEL_SERVERS },
                )}
              </p>
            )}
            {jointInviteDrafts.map((draft, index) => (
              <Card key={draft.id} className="space-y-3 bg-layer-inset theme-brutal:bg-brutal-gray/20 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-bold uppercase text-foreground-muted theme-brutal:text-black/60">
                    {formatMessage({ id: "channel.createJoint.serverInviteIndex" }, { n: index + 1 })}
                  </div>
                  {jointInviteDrafts.length > 1 && (
                    <Button size="sm"
                      variant="danger"
                      type="button"
                      onClick={() => removeJointInviteDraft(draft.id)}
                      disabled={submitting}
                      className="p-1 disabled:opacity-50 disabled:cursor-not-allowed"
                      aria-label={formatMessage({ id: "channel.createJoint.removeServerInvite" }, { n: index + 1 })}
                    >
                      <Trash2 size={14} />
                    </Button>
                  )}
                </div>
                <FormField label={formatMessage({ id: "channel.edit.serverSlugLabel" })} required>
                  <SlugInput
                    type="text"
                    value={draft.targetServerSlug}
                    onChange={(event) => updateJointInviteDraft(draft.id, { targetServerSlug: event.target.value })}
                    placeholder="partner-workspace"
                    required
                  />
                </FormField>
                <FormField
                  label={formatMessage({ id: "channel.edit.invitedPeopleLabel" })}
                  required
                  hint={formatMessage({ id: "channel.edit.invitedPeopleHint" })}
                >
                  <Textarea
                    value={draft.invitedPeopleText}
                    onChange={(event) => updateJointInviteDraft(draft.id, { invitedPeopleText: event.target.value })}
                    className="w-full"
                    placeholder={formatMessage({ id: "channel.edit.invitedPeoplePlaceholder" })}
                    rows={2}
                    required
                  />
                </FormField>
              </Card>
            ))}
          </Card>

          <FormField label={formatMessage({ id: "channel.createJoint.currentServerMembers" })} optional>
            {hasMembers ? (
              <div className="space-y-2">
                <div className="relative">
                  <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-foreground-muted theme-brutal:text-black/40" />
                  <Input
                    type="text"
                    value={memberSearch}
                    onChange={(event) => setMemberSearch(event.target.value)}
                    className="input-member-search w-full pl-9"
                    placeholder={formatMessage({ id: "channel.create.membersSearchPlaceholder" })}
                  />
                </div>

                <Card className="max-h-48 overflow-y-auto">
                  {filteredAgents.length > 0 && (
                    <>
                      <SectionEyebrow as="div" className="bg-fill-muted theme-brutal:bg-white/50 px-3 py-1.5">
                        {formatMessage({ id: "channel.create.agents" })}
                      </SectionEyebrow>
                      {filteredAgents.map((agent) => {
                        const selected = selectedAgentIds.has(agent.id);
                        return (
                          <button
                            key={agent.id}
                            type="button"
                            onClick={() => toggleAgent(agent.id)}
                            className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm font-medium text-foreground-strong theme-brutal:text-black transition-colors ${
 selected ? "bg-accent-soft theme-brutal:bg-brutal-pink/20" : "hover:bg-primary-soft theme-brutal:hover:bg-soft-signal"
 }`}
                          >
                            <AvatarSlot context="sidebar-list" type="agent" agentAvatarUrl={agent.avatarUrl} />
                            <span className="flex-1 truncate text-left">{agent.displayName || agent.name}</span>
                            {selected && <Check size={14} className="shrink-0 text-brutal-pink" />}
                          </button>
                        );
                      })}
                    </>
                  )}

                  {filteredHumans.length > 0 && (
                    <>
                      <SectionEyebrow as="div" className="bg-fill-muted theme-brutal:bg-white/50 px-3 py-1.5">
                        {formatMessage({ id: "channel.create.humans" })}
                      </SectionEyebrow>
                      {filteredHumans.map((human) => {
                        const selected = selectedHumanIds.has(human.userId);
                        return (
                          <button
                            key={human.userId}
                            type="button"
                            onClick={() => toggleHuman(human.userId)}
                            className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm font-medium text-foreground-strong theme-brutal:text-black transition-colors ${
 selected ? "bg-accent-soft theme-brutal:bg-brutal-pink/20" : "hover:bg-primary-soft theme-brutal:hover:bg-soft-signal"
 }`}
                          >
                            <AvatarSlot context="sidebar-list" type="human" humanPlaceholder />
                            <span className="flex-1 truncate text-left">{human.displayName || human.name}</span>
                            {selected && <Check size={14} className="shrink-0 text-brutal-pink" />}
                          </button>
                        );
                      })}
                    </>
                  )}

                  {!hasFilteredMembers && (
                    <div className="px-3 py-4 text-center font-mono text-sm text-foreground-muted theme-brutal:text-black/50">
                      {formatMessage(
                        { id: "channel.create.noMatchesFor" },
                        { query: memberSearch.trim() },
                      )}
                    </div>
                  )}
                </Card>
              </div>
            ) : (
              <div className="font-mono text-sm text-foreground-muted theme-brutal:text-black/50">
                {formatMessage({ id: "channel.create.noMembersAvailable" })}
              </div>
            )}
          </FormField>

          <div className="flex justify-end gap-3">
            <Button size="sm"
              variant="outline"
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {formatMessage({ id: "settings.common.cancel" })}
            </Button>
            <Button size="sm"
              variant="accent"
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting
                ? formatMessage({ id: "channel.create.creating" })
                : formatMessage({ id: "channel.createJoint.title" })}
            </Button>
          </div>
        </form>
    </DialogCard>
  );
}
