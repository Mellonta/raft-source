import { Input, Card,
  Badge,
  Button,
  SidebarList,
  SidebarSection,
  SidebarSectionChevron,
  SidebarSectionCount,
  SidebarSectionDisclosure,
  SidebarSectionHeader,
  SidebarSectionTitle, Spinner } from "raft-ui";
import CloseButton from "../ui/CloseButton";
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ArrowLeft, Users, Plus, X, Search, AlertTriangle } from "lucide-react";
import { useAgentDisplayState, useAgentStore } from "../../store/agentStore";
import type { AgentActivity } from "@botiverse/raft-shared";
import { CHANNEL_MANAGER_ROLE_ACTIONS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type { Agent } from "../../store/agentStore";
import { useChannelStore } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useChannelMembers } from "../../hooks/useChannelMembers";
import type { ChannelAgent, ChannelExternalMember, ChannelHuman } from "../../hooks/useChannelMembers";
import { useProfileStore } from "../../store/profileStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useAuthStore } from "../../store/authStore";
import AvatarSlot from "../ui/AvatarSlot";
import Banner from "../ui/Banner";
import { trackAgentCreateOpened } from "../../analytics/journey";
import CreateAgentDialog from "./CreateAgentDialog";
import CheckMarker from "../ui/CheckMarker";
import SectionEyebrow from "../ui/SectionEyebrow";
import FormField from "../ui/FormField";
import AgentActivityDot from "./AgentActivityDot";
import {
  ChannelMemberListShell,
  ChannelMemberHoverActions,
  ChannelMemberRoleAndActions,
  ChannelMemberRow,
  ChannelMemberSectionHeader,
} from "../channel/ChannelMemberList";
import { useChannelMemberRemoval } from "../channel/useChannelMemberRemoval";
import Modal from "../Modal";
import ConfirmDialog from "../ConfirmDialog";
import Tooltip from "../ui/Tooltip";
import type { ProfilePanelTarget } from "../profile/ProfilePanel";
import { primeHumanProfileFromChannelMember, setCachedAgentProfile } from "../profile/profileFallbackCache";
import { isLocalProjectionMember } from "../../utils/channelLocalMembership";
import { usePeopleSuggestionSearch } from "../../hooks/usePeopleSuggestionSearch";
import type { PeopleSuggestionCandidate } from "../../utils/peopleSuggestionSearch";
import { canUseChannelMemberAction } from "../../utils/channelMemberPermissions";
import { formatAgentDisplayStateText } from "../../utils/activity";

const ProfilePanel = lazy(() => import("../profile/ProfilePanel"));

// Shared by the modal/panel member list and the drawer-internal members
// page (presentation="page"), which renders the same per-agent activity
// sub-line.
export function agentStatusFallbackActivity(status: Agent["status"]): AgentActivity {
  return status === "active" ? "online" : "offline";
}

export function AgentActivityInfo({ agentId, fallbackStatus }: { agentId: string; fallbackStatus: Agent["status"] }) {
  const intl = useIntl();
  const displayState = useAgentDisplayState(agentId, { status: fallbackStatus });
  const activityText = formatAgentDisplayStateText(intl, displayState);
  return (
    <div className="truncate font-mono text-xs text-foreground-muted">
      {activityText}
    </div>
  );
}

// Shared by the modal/panel member list and the members page, which shows
// the same remote-server badge on joint-channel rows. The RUI Badge recipe
// owns the per-theme shape (brutal square / elegant pill), so this only
// keeps the identity-label typography.
export function JointPeerBadge({ label }: { label: string }) {
  return (
    <Badge
      appearance="soft"
      variant="information"
      uppercase={false}
      className="inline-flex max-w-full items-center justify-center truncate text-center font-mono leading-none"
    >
      {label}
    </Badge>
  );
}

/** Live roster filter for the members page search box — matches on the
 *  handle or the display name, case-insensitive (query pre-normalized). */
function memberMatches(query: string, name: string, displayName: string | null): boolean {
  if (!query) return true;
  return (
    name.toLowerCase().includes(query)
    || (displayName ?? "").toLowerCase().includes(query)
  );
}

/** Raft UI disclosure for one member kind on the drawer-internal roster
 * page. Both categories start expanded; the primitive owns keyboard/ARIA
 * state and chevron rotation, while filtering continues to own the live
 * count and whether an empty category is rendered at all. */
function MemberPageSection({
  kind,
  label,
  count,
  children,
}: {
  kind: "humans" | "agents" | "external";
  label: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <SidebarSection
      defaultOpen
      data-testid={`member-page-section-${kind}-group`}
    >
      <SidebarSectionHeader className="w-full!">
        <SidebarSectionDisclosure
          className="!normal-case"
          data-testid={`member-page-section-${kind}-toggle`}
        >
          <SidebarSectionChevron />
          <span
            className="flex min-w-0 items-center"
            data-testid={`member-page-section-${kind}`}
          >
            <SidebarSectionTitle>{label}</SidebarSectionTitle>
            <SidebarSectionCount>{" · "}{count}</SidebarSectionCount>
          </span>
        </SidebarSectionDisclosure>
      </SidebarSectionHeader>
      <SidebarList data-testid={`member-page-section-${kind}-panel`}>
        {children}
      </SidebarList>
    </SidebarSection>
  );
}

function AddMemberCandidateBody({
  name,
  description,
  trailing,
}: {
  name: ReactNode;
  description?: string | null;
  trailing?: ReactNode;
}) {
  const normalizedDescription = description?.trim();

  return (
    <span className="min-w-0 flex-1 text-left">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-sm font-medium text-foreground-strong">{name}</span>
        {trailing}
      </span>
      {normalizedDescription ? (
        <Tooltip content={normalizedDescription}>
          <span
            className="block truncate text-xs font-normal text-foreground-muted"
          >
            {normalizedDescription}
          </span>
        </Tooltip>
      ) : null}
    </span>
  );
}

/** Selection-set key for the multi-select add flow — ids are UUIDs, so
 *  a `kind:id` prefix never collides with the id itself. */
function candidateKey(kind: "agent" | "human", id: string): string {
  return `${kind}:${id}`;
}

type ChannelMembersProps = {
  channelId: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  presentation?: "modal" | "panel" | "page";
  onRequestClose?: () => void;
  onBack?: () => void;
  onClose?: () => void;
  initialView?: "add";
  prefetchedMembers?: {
    channelAgents: ChannelAgent[];
    channelHumans: ChannelHuman[];
    channelExternalMembers?: ChannelExternalMember[];
    loading: boolean;
    addMembers: (input: { userIds: string[]; agentIds: string[] }) => Promise<unknown>;
    addAgent: (agentId: string) => Promise<void>;
    removeAgent: (agentId: string) => Promise<void>;
    addHuman: (userId: string) => Promise<void>;
    removeHuman: (userId: string) => Promise<void>;
    changeMemberRole: (targetType: "user" | "agent", memberId: string, role: "member" | "admin") => Promise<void>;
    roleChangeFailed: boolean;
  };
};

export default function ChannelMembers({
  channelId,
  open,
  onOpenChange,
  hideTrigger = false,
  presentation = "modal",
  onRequestClose,
  onBack,
  onClose,
  initialView,
  prefetchedMembers,
}: ChannelMembersProps) {
  const { formatMessage } = useIntl();
  const agents = useAgentStore((s) => s.agents);
  const channels = useChannelStore((s) => s.channels);
  const currentChannel = channels.find((c) => c.id === channelId) ?? null;
  const currentServerId = useServerStore((s) => s.current?.id);
  const canOpenAgentProfiles = true;
  // Guests may open human profiles: the panel itself filters by capability
  // (guest capabilities are empty, so message/change-role/remove never render),
  // and the chat-panel entry never gated this. Gating only the roster entry made
  // the same panel reachable from chat but not from Members.
  const canOpenHumanProfiles = true;
  const currentUserId = useAuthStore((s) => s.user?.id);
  const serverMembers = useServerStore((s) => s.members);
  const localMembers = useChannelMembers(channelId, { enabled: !prefetchedMembers });
  const {
    channelAgents,
    channelHumans,
    channelExternalMembers = [],
    loading: membersLoading,
    addMembers,
    addAgent,
    removeAgent,
    addHuman,
    removeHuman,
    changeMemberRole,
    roleChangeFailed,
  } = prefetchedMembers ?? localMembers;
  const openProfile = useProfileStore((s) => s.openProfile);
  const channelManagerRoleActionsEnabled = useServerFeatureFlag(
    CHANNEL_MANAGER_ROLE_ACTIONS_FEATURE_FLAG_KEY,
  ).enabled;
  const [internalShowPanel, setInternalShowPanel] = useState(false);
  const isPanel = presentation === "panel";
  const isPage = presentation === "page";
  const showPanel = open ?? internalShowPanel;
  const setShowPanel = (next: boolean) => {
    if (onOpenChange) onOpenChange(next);
    else setInternalShowPanel(next);
  };
  const [showAddSection, setShowAddSection] = useState(initialView === "add");
  // The add picker lists agents from the roster store. Ask for it when the
  // picker opens instead of relying on boot timing: the connect snapshot (or its
  // bounded fallback) may not have landed yet, and an empty roster would offer to
  // create an agent that already exists. loadAgents dedupes in-flight calls.
  // (A picker opened directly via initialView="add" is covered by its opener.)
  const loadAgents = useAgentStore((s) => s.loadAgents);
  const openAddSection = useCallback(() => {
    setShowAddSection(true);
    void loadAgents();
  }, [loadAgents]);
  const [memberSearch, setMemberSearch] = useState("");
  // Members page (page mode) live roster filter — separate from the add
  // flow's candidate search (`memberSearch`).
  const [rosterQuery, setRosterQuery] = useState("");
  const [profileStack, setProfileStack] = useState<ProfilePanelTarget[]>([]);
  const selectedProfile = profileStack.at(-1) ?? null;
  const backProfile = useCallback(() => {
    setProfileStack((stack) => stack.slice(0, -1));
  }, []);
  const closeProfilePage = useCallback(() => {
    onClose?.();
  }, [onClose]);
  const openNestedProfile = useCallback((type: "agent" | "human", id: string) => {
    setProfileStack((stack) => [...stack, { type, id }]);
  }, []);
  const {
    requestRemove,
    confirmDialog: removeConfirmDialog,
    removeTarget,
  } = useChannelMemberRemoval({
    removeAgent,
    removeHuman,
    channelName: currentChannel?.name,
  });
  // task #187 multi-select add flow: selection is staged and
  // only committed on confirm; failed rows stay selected + highlighted so
  // the confirm button doubles as retry.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [failedKeys, setFailedKeys] = useState<Set<string>>(() => new Set());
  const [addError, setAddError] = useState<"none" | "some" | null>(null);
  const [adding, setAdding] = useState(false);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  // Two-step contract (task #584): the create succeeded but the channel join
  // did not. The agent EXISTS on the server at this point — the banner + retry
  // exist so nobody "fixes" the failure by creating a same-named duplicate.
  const [pendingJoinAgent, setPendingJoinAgent] = useState<{ id: string; name: string } | null>(null);
  const [retryingJoin, setRetryingJoin] = useState(false);
  const [roleChangingKey, setRoleChangingKey] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [protectedDemoteTarget, setProtectedDemoteTarget] = useState<string | null>(null);

  const isAllChannel = currentChannel?.name === "all" && currentChannel?.type === "channel";
  const isArchived = !!currentChannel?.archivedAt;
  const isLocalMember = (serverId?: string) =>
    !currentChannel?.serverId || !serverId || serverId === currentChannel.serverId;
  const jointPeerLabel = (serverId?: string, serverName?: string | null, serverSlug?: string | null) =>
    currentChannel?.type === "joint" && !isLocalMember(serverId)
      ? serverName || serverSlug || null
      : null;
  const totalParticipants = channelAgents.length + channelHumans.length + channelExternalMembers.length;
  const { capabilities } = useServerPermissions();
  const canAddChannelMembers = canUseChannelMemberAction({
    currentUserId,
    currentServerId,
    channelServerId: currentChannel?.serverId,
    channelHumans,
    serverMembers,
    hasChannelMemberCapability: currentChannel?.channelCapabilities?.addChannelMembers === true,
    isAllChannel,
  }) && !isArchived;
  const canRemoveChannelMembers = canUseChannelMemberAction({
    currentUserId,
    currentServerId,
    channelServerId: currentChannel?.serverId,
    channelHumans,
    serverMembers,
    hasChannelMemberCapability: currentChannel?.channelCapabilities?.removeChannelMembers ?? capabilities.removeChannelMembers,
    isAllChannel,
  }) && !isArchived;

  const memberSearchCandidates = useMemo(() => {
    const channelAgentIds = new Set(channelAgents.map((agent) => agent.id));
    const channelHumanIds = new Set(channelHumans
      .filter((h) => isLocalProjectionMember(h, currentChannel))
      .map((h) => h.id));
    const candidates: PeopleSuggestionCandidate<(typeof agents)[number] | (typeof serverMembers)[number]>[] = [
      ...agents.filter((agent) => !agent.deletedAt && !channelAgentIds.has(agent.id)).map((agent) => ({
        kind: "agent" as const,
        id: agent.id,
        value: agent,
        handle: agent.name,
        displayName: agent.displayName,
        description: agent.description,
      })),
      ...serverMembers.filter((member) => !channelHumanIds.has(member.userId)).map((member) => ({
        kind: "human" as const,
        id: member.userId,
        value: member,
        handle: member.name,
        displayName: member.displayName,
        description: member.description,
        sourceServerLabel: member.serverName || member.serverSlug,
      })),
    ];
    return candidates;
  }, [agents, channelAgents, channelHumans, currentChannel, serverMembers]);
  const { entries: memberSearchEntries, ranked: rankedMembers } = usePeopleSuggestionSearch(
    memberSearch,
    memberSearchCandidates,
  );
  const filteredAgents = rankedMembers.filter((candidate) => candidate.kind === "agent").map((candidate) => candidate.value as (typeof agents)[number]);
  const filteredHumans = rankedMembers.filter((candidate) => candidate.kind === "human").map((candidate) => candidate.value as (typeof serverMembers)[number]);
  const hasAvailable = memberSearchEntries.length > 0;
  const hasFilteredResults = filteredAgents.length > 0 || filteredHumans.length > 0;

  const candidateNameByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents) {
      map.set(candidateKey("agent", agent.id), agent.displayName || agent.name);
    }
    for (const member of serverMembers) {
      map.set(candidateKey("human", member.userId), member.displayName || member.name);
    }
    return map;
  }, [agents, serverMembers]);

  const resetAddFlow = () => {
    setShowAddSection(false);
    setMemberSearch("");
    setSelectedKeys(new Set());
    setFailedKeys(new Set());
    setAddError(null);
    setAdding(false);
  };
  const closePanel = () => {
    resetAddFlow();
    setRoleError(null);
    if (isPanel || isPage) onRequestClose?.();
    else setShowPanel(false);
  };

  const toggleCandidate = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    // A touched row is no longer "failed" — the highlight follows the
    // last confirm attempt, not the user's corrections after it.
    setFailedKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setAddError(null);
  };

  const handleConfirmAdd = async () => {
    if (adding || selectedKeys.size === 0) return;
    setAdding(true);
    setAddError(null);
    const userIds: string[] = [];
    const agentIds: string[] = [];
    for (const key of selectedKeys) {
      const sep = key.indexOf(":");
      const kind = key.slice(0, sep);
      const id = key.slice(sep + 1);
      if (kind === "agent") agentIds.push(id);
      else userIds.push(id);
    }
    try {
      await addMembers({ userIds, agentIds });
      resetAddFlow();
    } catch {
      // The server batch is atomic, so a rejected request means every selected
      // row remains unresolved and should stay selected for correction/retry.
      setFailedKeys(new Set(selectedKeys));
      // One failure, one story (task #584 D-state, Duoyu's corrected rule):
      // the D strip may replace the generic banner only when it covers the
      // WHOLE failed batch — i.e. the batch was exactly the pending agent.
      // In a mixed batch the two messages are not redundant: the strip talks
      // about the agent ("exists, don't re-create"), the generic banner is
      // the only sentence the other failed members get.
      const onlyPendingAgent = pendingJoinAgent
        && userIds.length === 0
        && agentIds.length === 1
        && agentIds[0] === pendingJoinAgent.id;
      if (!onlyPendingAgent) {
        setAddError("none");
      }
    } finally {
      setAdding(false);
    }
  };

  const showAddEntry = !membersLoading && canAddChannelMembers;

  const renderMemberActions = (
    targetType: "user" | "agent",
    member: ChannelHuman | ChannelAgent,
    removeAction?: () => void,
  ) => {
    const serverRole = member.serverRole ?? ("role" in member ? member.role : "member");
    const effectiveRole = member.effectiveChannelRole
      ?? (serverRole === "owner" || serverRole === "admin" || member.channelRole === "admin" ? "admin" : "member");
    const protectedServerAdmin = serverRole === "owner" || serverRole === "admin";
    const canExplainProtectedDemote = !isArchived
      && !isAllChannel
      && currentChannel?.channelCapabilities?.changeChannelMemberRoles === true
      && member.id !== currentUserId
      && protectedServerAdmin
      && effectiveRole !== "member";
    const canChangeRole = !isArchived && !isAllChannel && member.canChangeChannelRole;
    const showRoleAction = channelManagerRoleActionsEnabled
      && (canChangeRole || canExplainProtectedDemote);
    if (!showRoleAction && !removeAction) return null;
    const nextRole = effectiveRole === "member" ? "admin" : "member";
    const key = `${targetType}:${member.id}`;
    return (
      <ChannelMemberHoverActions
        roleAction={showRoleAction ? {
          label: formatMessage({
            id: nextRole === "admin"
              ? "agent.channelMembers.makeAdminShort"
              : "agent.channelMembers.removeAdminShort",
          }),
          ariaLabel: formatMessage({
            id: nextRole === "admin"
              ? "agent.channelMembers.makeAdmin"
              : "agent.channelMembers.removeAdmin",
          }, { name: member.name }),
          disabled: roleChangingKey === key,
          onClick: () => {
            if (canExplainProtectedDemote) {
              setProtectedDemoteTarget(member.displayName || member.name);
              return;
            }
            setRoleError(null);
            setRoleChangingKey(key);
            void changeMemberRole(targetType, member.id, nextRole)
              .catch(() => setRoleError(formatMessage({ id: "agent.channelMembers.updateRoleFailed" })))
              .finally(() => setRoleChangingKey((current) => current === key ? null : current));
          },
        } : undefined}
        removeAction={removeAction ? {
          label: formatMessage({ id: "agent.channelMembers.removeName" }, { name: member.name }),
          onClick: removeAction,
        } : undefined}
      />
    );
  };

  /* Per-member row renderers, single-sourced between the modal/panel
     member list and the members page (page mode): the page makes the
     whole row the profile button and adds the server-role tag in the
     trailing slot; modal/panel keep the avatar-click affordance. */
  const renderAgentRow = (agent: ChannelAgent, pageMode: boolean) => {
    const canRemoveAgent = isLocalMember(agent.serverId);
    const peerLabel = jointPeerLabel(agent.serverId, agent.serverName, agent.serverSlug);
    const openAgentProfile = () => {
      setCachedAgentProfile(currentServerId, agent);
      if (isPage) {
        setProfileStack([{ type: "agent", id: agent.id }]);
        return;
      }
      closePanel();
      openProfile("agent", agent.id);
    };
    const role = agent.effectiveChannelRole ?? agent.serverRole ?? "member";
    const actions = renderMemberActions(
      "agent",
      agent,
      !isAllChannel && canRemoveChannelMembers && canRemoveAgent
        ? () => requestRemove({ type: "agent", id: agent.id, name: agent.displayName || agent.name })
        : undefined,
    );
    return (
      <ChannelMemberRow
        key={agent.id}
        type="agent"
        agentId={agent.id}
        agentAvatarUrl={agent.avatarUrl}
        agentFallbackActivity={agentStatusFallbackActivity(agent.status)}
        name={(
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{agent.displayName || agent.name}</span>
            {peerLabel && <JointPeerBadge label={peerLabel} />}
          </span>
        )}
        secondary={<AgentActivityInfo agentId={agent.id} fallbackStatus={agent.status} />}
        onAvatarClick={!canOpenAgentProfiles || pageMode ? undefined : openAgentProfile}
        onRowClick={canOpenAgentProfiles && pageMode ? openAgentProfile : undefined}
        trailing={<ChannelMemberRoleAndActions role={role} actions={actions} />}
      />
    );
  };

  const renderHumanRow = (human: ChannelHuman, pageMode: boolean) => {
    const canRemoveHuman = isLocalMember(human.serverId);
    const peerLabel = jointPeerLabel(human.serverId, human.serverName, human.serverSlug);
    const openHumanProfile = () => {
      if (currentChannel?.serverId) {
        primeHumanProfileFromChannelMember(currentChannel.serverId, human);
      }
      if (isPage) {
        setProfileStack([{ type: "human", id: human.id }]);
        return;
      }
      closePanel();
      openProfile("human", human.id);
    };
    const role = human.effectiveChannelRole ?? human.role;
    const actions = renderMemberActions(
      "user",
      human,
      !isAllChannel && canRemoveChannelMembers && canRemoveHuman
        ? () => requestRemove({ type: "human", id: human.id, name: human.displayName || human.name })
        : undefined,
    );
    return (
      <ChannelMemberRow
        key={human.id}
        type="human"
        humanAvatarUrl={human.avatarUrl}
        gravatarHash={human.gravatarHash}
        name={(
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{human.displayName || human.name}</span>
            {peerLabel && <JointPeerBadge label={peerLabel} />}
          </span>
        )}
        secondary={human.description ? <div className="truncate">{human.description}</div> : undefined}
        onAvatarClick={!canOpenHumanProfiles || pageMode ? undefined : openHumanProfile}
        onRowClick={canOpenHumanProfiles && pageMode ? openHumanProfile : undefined}
        trailing={<ChannelMemberRoleAndActions role={role} actions={actions} />}
      />
    );
  };

  const renderExternalRow = (member: ChannelExternalMember) => (
    <ChannelMemberRow
      key={member.id}
      type="human"
      humanAvatarUrl={member.avatarUrl}
      name={(
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{member.displayName}</span>
          <span className="border border-line-muted theme-brutal:border-black bg-accent-soft theme-brutal:bg-brutal-lavender px-1 font-mono text-[10px] font-bold uppercase leading-4 text-foreground-strong theme-brutal:text-black">
            {formatMessage({ id: "settings.slackBridge.providerBadge" })}
          </span>
        </span>
      )}
      secondary={member.handles[0] ? `@${member.handles[0]}` : undefined}
    />
  );

  // The search text doubles as the new agent's suggested name. The leading
  // "@" is display notation the candidate rows themselves teach (they render
  // handles as "@duoyu"), so stripping it recovers intent; everything else —
  // spaces included — is left for the human to fix inside the dialog, because
  // rewriting "deploy bot" into a handle they did not type would be guessing
  // (task #1139 E-state ruling).
  const createAgentPrefillName = memberSearch.trim().replace(/^@/, "");
  // The name carries over ONLY from the promoted (no-hit) row — that is where
  // the row's own label promises it. A generic「创建一个新 Agent」row must not
  // smuggle the search text into the dialog (Duoyu, PR #7372 design review).
  const createEntryPromoted = createAgentPrefillName.length > 0 && !hasFilteredResults;
  const joinCreatedAgent = async (agent: { id: string; name: string }) => {
    setRetryingJoin(true);
    try {
      // Same atomic batch facade as「添加所选」(handleConfirmAdd) — ONE
      // underlying call and ONE error contract for every way a created agent
      // reaches this channel (review finding on PR #7372: addAgent's single
      // POST was a second code path with its own failure semantics).
      await addMembers({ userIds: [], agentIds: [agent.id] });
      setPendingJoinAgent(null);
      setSelectedKeys((prev) => {
        const key = candidateKey("agent", agent.id);
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setMemberSearch("");
    } catch {
      setPendingJoinAgent(agent);
      // Stage the created agent in the ordinary flow too: the banner's retry
      // and「添加所选」both resolve through the same useChannelMembers add
      // path, so either affordance completes the join — no second mechanism.
      setSelectedKeys((prev) => new Set(prev).add(candidateKey("agent", agent.id)));
    } finally {
      setRetryingJoin(false);
    }
  };

  const addCandidateRows = (multiSelect: boolean, fillAvailableHeight = false) => (
    <div
      // Column: the candidates scroll in the inner region; the create-agent
      // entry is a pinned footer OUTSIDE that region (task #99) so it is always
      // in view instead of only after scrolling to the end of a long list.
      className={`flex flex-col border border-line-muted bg-layer-panel shadow-raft-sm theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal-sm overflow-y-auto ${fillAvailableHeight ? "min-h-0 flex-1" : "max-h-72"}`}
      data-testid={multiSelect ? "add-member-candidate-list" : undefined}
    >
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid={multiSelect ? "add-member-candidate-scroll" : undefined}>
      {/* Available agents */}
      {filteredAgents.length > 0 && (
        <>
          <SectionEyebrow as="div" uppercase={false} className="bg-fill-muted px-3 py-1.5 text-foreground-muted theme-brutal:bg-white/50 theme-brutal:text-black">
            {formatMessage({ id: "agent.channelMembers.agents" })}
          </SectionEyebrow>
          {filteredAgents.map((agent) => {
            const key = candidateKey("agent", agent.id);
            if (!multiSelect) {
              return (
                <button
                  key={agent.id}
                  onClick={() => { void addAgent(agent.id).catch(() => {}); }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-foreground-strong transition-colors hover:bg-fill-muted [@media(max-height:600px)]:py-1 theme-brutal:text-black theme-brutal:hover:bg-soft-signal"
                >
                  <AvatarSlot
                    context="compact-list"
                    type="agent"
                    agentAvatarUrl={agent.avatarUrl}
                    badge={<AgentActivityDot agentId={agent.id} />}
                    className="self-center"
                  />
                  <AddMemberCandidateBody
                    name={agent.displayName || agent.name}
                    description={agent.description}
                  />
                </button>
              );
            }
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => toggleCandidate(key)}
                disabled={adding}
                aria-pressed={selectedKeys.has(key)}
                aria-describedby={failedKeys.has(key) ? `add-member-failed-${key}` : undefined}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-foreground-strong transition-colors hover:bg-fill-muted disabled:cursor-not-allowed disabled:opacity-60 [@media(max-height:600px)]:py-1 theme-brutal:text-black theme-brutal:hover:bg-soft-signal ${failedKeys.has(key) ? "bg-warning-soft text-warning-strong dark:bg-warning-soft dark:text-warning-strong theme-brutal:bg-brutal-orange/15 theme-brutal:text-black" : ""}`}
                data-testid={`add-candidate-agent-${agent.id}`}
              >
                <CheckMarker checked={selectedKeys.has(key)} disabled={adding} />
                <AvatarSlot
                  context="compact-list"
                  type="agent"
                  agentAvatarUrl={agent.avatarUrl}
                  badge={<AgentActivityDot agentId={agent.id} />}
                  className="self-center"
                />
                <AddMemberCandidateBody
                  name={agent.displayName || agent.name}
                  description={agent.description}
                />
                {failedKeys.has(key) ? (
                  <span id={`add-member-failed-${key}`} className="sr-only">
                    {formatMessage({ id: "agent.channelMembers.addFailed" })}
                  </span>
                ) : null}
              </button>
            );
          })}
        </>
      )}

      {/* Available humans */}
      {filteredHumans.length > 0 && (
        <>
          <SectionEyebrow as="div" uppercase={false} className="bg-fill-muted px-3 py-1.5 text-foreground-muted theme-brutal:bg-white/50 theme-brutal:text-black">
            {formatMessage({ id: "agent.channelMembers.humans" })}
          </SectionEyebrow>
          {filteredHumans.map((human) => {
            const key = candidateKey("human", human.userId);
            if (!multiSelect) {
              return (
                <button
                  key={human.userId}
                  onClick={() => { void addHuman(human.userId).catch(() => {}); }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-foreground-strong transition-colors hover:bg-fill-muted [@media(max-height:600px)]:py-1 theme-brutal:text-black theme-brutal:hover:bg-soft-signal"
                >
                  <AvatarSlot
                    context="compact-list"
                    type="human"
                    humanAvatarUrl={human.avatarUrl}
                    gravatarHash={human.gravatarHash}
                    className="self-center"
                  />
                  <AddMemberCandidateBody
                    name={human.displayName || human.name}
                    description={human.description}
                  />
                </button>
              );
            }
            return (
              <button
                key={human.userId}
                type="button"
                onClick={() => toggleCandidate(key)}
                disabled={adding}
                aria-pressed={selectedKeys.has(key)}
                aria-describedby={failedKeys.has(key) ? `add-member-failed-${key}` : undefined}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-foreground-strong transition-colors hover:bg-fill-muted disabled:cursor-not-allowed disabled:opacity-60 [@media(max-height:600px)]:py-1 theme-brutal:text-black theme-brutal:hover:bg-soft-signal ${failedKeys.has(key) ? "bg-warning-soft text-warning-strong dark:bg-warning-soft dark:text-warning-strong theme-brutal:bg-brutal-orange/15 theme-brutal:text-black" : ""}`}
                data-testid={`add-candidate-human-${human.userId}`}
              >
                <CheckMarker checked={selectedKeys.has(key)} disabled={adding} />
                <AvatarSlot
                  context="compact-list"
                  type="human"
                  humanAvatarUrl={human.avatarUrl}
                  gravatarHash={human.gravatarHash}
                  className="self-center"
                />
                <AddMemberCandidateBody
                  name={human.displayName || human.name}
                  description={human.description}
                />
                {failedKeys.has(key) ? (
                  <span id={`add-member-failed-${key}`} className="sr-only">
                    {formatMessage({ id: "agent.channelMembers.addFailed" })}
                  </span>
                ) : null}
              </button>
            );
          })}
        </>
      )}

      {!hasAvailable && (
        <div className="px-3 py-4 text-center font-mono text-sm text-foreground-muted">
          {formatMessage({ id: "agent.channelMembers.allMembersAdded" })}
        </div>
      )}

      {hasAvailable && !hasFilteredResults && (
        <div className="px-3 py-4 text-center font-mono text-sm text-foreground-muted">
          {formatMessage({ id: "agent.channelMembers.noMatches" }, { query: memberSearch.trim() })}
        </div>
      )}

    </div>
      {/* Create-a-new-Agent entry (task #584, design task #1139): persistent
          bottom row — pinned below the scrolling candidates (task #99), not the
          last scrolled row. When the search has no hit the
          typed text becomes the suggested name and the row steps up to the
          primary next action; without create permission the row stays VISIBLE
          but disabled with the reason — hiding it here would recreate the
          dead end this entry exists to remove. */}
      {multiSelect && (
        capabilities.createAgents ? (
          <button
            type="button"
            onClick={() => {
              trackAgentCreateOpened("channel_members");
              setShowCreateAgent(true);
            }}
            disabled={adding}
            data-testid="add-member-create-agent-entry"
            className={`flex w-full shrink-0 items-center gap-2.5 border-t border-line-strong px-3 py-2.5 text-left theme-brutal:border-t-2 theme-brutal:border-black ${
              createEntryPromoted ? "bg-primary-soft text-foreground-strong theme-brutal:bg-soft-signal theme-brutal:text-black" : "bg-layer-panel text-foreground-strong hover:bg-fill-muted theme-brutal:bg-white theme-brutal:text-black theme-brutal:hover:bg-black/5"
            }`}
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-line-strong bg-layer-inset theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white">
              <Plus size={14} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-bold">
                {createEntryPromoted
                  ? formatMessage({ id: "channel.addMembers.createAgentNamed" }, { name: createAgentPrefillName })
                  : formatMessage({ id: "channel.addMembers.createAgent" })}
              </span>
              <span className="truncate text-xs text-foreground-muted theme-brutal:text-black/50">
                {formatMessage({ id: "channel.addMembers.createAgentAutoJoin" }, { channel: `#${currentChannel?.name ?? ""}` })}
              </span>
            </span>
          </button>
        ) : (
          <div className="shrink-0 border-t-2 border-line-strong theme-brutal:border-black px-3 py-2.5" data-testid="add-member-create-agent-entry-disabled">
            <div className="flex items-center gap-2.5 opacity-50">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-line-strong bg-layer-inset theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white">
                <Plus size={14} />
              </span>
              <span className="text-sm font-bold">{formatMessage({ id: "channel.addMembers.createAgent" })}</span>
            </div>
            <p className="mt-1.5 text-xs text-foreground-muted theme-brutal:text-black/50">
              {formatMessage({ id: "channel.addMembers.createAgentNoPermission" })}
            </p>
          </div>
        )
      )}
    </div>
  );

  const memberListView = (
    <>
      {/* Member list — panel mode renders flat sections (no bordered,
          inner-scrolling box); modal mode keeps the framed shell. */}
      <ChannelMemberListShell framed={!isPanel}>
        {(roleError || roleChangeFailed) && (
          <Banner intent="warning" className="m-3 font-bold" data-testid="channel-member-role-error">
            {roleError || formatMessage({ id: "agent.channelMembers.updateRoleFailed" })}
          </Banner>
        )}
        {membersLoading && (
          <div
            className="flex items-center justify-center gap-2 px-3 py-4 font-mono text-foreground-muted"
            data-testid="channel-members-loading"
          >
            <Spinner
              size="sm"
              aria-label={formatMessage({ id: "message.chatPanel.overflow.membersLoading" })}
            />
            {formatMessage({ id: "message.chatPanel.overflow.membersLoading" })}
          </div>
        )}

        {/* Agents section */}
        {!membersLoading && channelAgents.length > 0 && (
          <>
            <ChannelMemberSectionHeader>{formatMessage({ id: "agent.channelMembers.agents" })}</ChannelMemberSectionHeader>
            {channelAgents.map((agent) => renderAgentRow(agent, false))}
          </>
        )}

        {/* Humans section */}
        {!membersLoading && channelHumans.length > 0 && (
          <>
            <ChannelMemberSectionHeader>{formatMessage({ id: "agent.channelMembers.humans" })}</ChannelMemberSectionHeader>
            {channelHumans.map((human) => renderHumanRow(human, false))}
          </>
        )}

        {!membersLoading && channelExternalMembers.length > 0 && (
          <>
            <ChannelMemberSectionHeader>
              {formatMessage({ id: "agent.channelMembers.slackParticipants" })}
            </ChannelMemberSectionHeader>
            {channelExternalMembers.map(renderExternalRow)}
          </>
        )}

        {!membersLoading && totalParticipants === 0 && (
          <div className="px-3 py-4 text-center font-mono text-sm text-foreground-muted">
            {formatMessage({ id: "agent.channelMembers.noMembers" })}
          </div>
        )}
      </ChannelMemberListShell>

    </>
  );

  const addView = (
    <div
      className={isPage ? "flex min-h-0 flex-1 flex-col" : undefined}
      data-testid="add-member-view"
    >
      {addError && (
        <Banner intent="warning" className="mb-3 font-bold" data-testid="add-member-error">
          {formatMessage({
            id: addError === "none"
              ? "channel.addMembers.noneAdded"
              : "agent.channelMembers.someAddFailed",
          })}
        </Banner>
      )}

      {/* D-state (task #584): created but not joined. Membership is the truth
          that clears this — however the join completes (banner retry, the
          staged「添加所选」, or a socket refresh), the banner goes away. */}
      {pendingJoinAgent && !channelAgents.some((agent) => agent.id === pendingJoinAgent.id) && (
        <Banner intent="warning" className="mb-3" data-testid="add-member-create-agent-join-failed">
          <div className="text-sm font-bold">
            {formatMessage(
              { id: "channel.addMembers.createAgentJoinFailedTitle" },
              { name: pendingJoinAgent.name, channel: `#${currentChannel?.name ?? ""}` },
            )}
          </div>
          <div className="mt-0.5 text-xs">
            {formatMessage({ id: "channel.addMembers.createAgentJoinFailedBody" })}
          </div>
          <Button size="sm" variant="outline"
            type="button"
            onClick={() => { void joinCreatedAgent(pendingJoinAgent); }}
            disabled={retryingJoin || adding}
            className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="add-member-create-agent-retry-join"
          >
            {formatMessage({ id: "channel.addMembers.retryJoin" })}
          </Button>
        </Banner>
      )}

      {/* Selected chips — staged selection with per-chip deselect. */}
      {selectedKeys.size > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5" data-testid="add-member-selected-chips">
          {[...selectedKeys].map((key) => {
            const kind = key.startsWith("agent:") ? "agent" : "human";
            const failedNow = failedKeys.has(key);
            const memberName = candidateNameByKey.get(key) ?? key;
            return (
              <Badge
                key={key}
                appearance={failedNow ? "soft" : "solid"}
                variant={failedNow ? "warning" : kind === "agent" ? "information" : "accent"}
                className={`inline-flex items-center gap-1 text-xs font-bold ${failedNow ? "theme-brutal:bg-brutal-orange/25 theme-brutal:text-black" : kind === "agent" ? "theme-brutal:bg-brutal-cyan theme-brutal:text-black" : "theme-brutal:bg-brutal-lavender theme-brutal:text-black"}`}
                data-member-kind={kind}
                data-member-status={failedNow ? "failed" : "selected"}
                data-testid={`add-member-selected-chip-${key}`}
              >
                <span className="max-w-32 truncate">{memberName}</span>
                {failedNow ? (
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-bold uppercase" data-member-failure="true">
                    <AlertTriangle size={11} aria-hidden="true" />
                    <span>{formatMessage({ id: "agent.channelMembers.addFailed" })}</span>
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => toggleCandidate(key)}
                  disabled={adding}
                  className="shrink-0"
                  aria-label={formatMessage({ id: "agent.channelMembers.deselectName" }, { name: memberName })}
                >
                  <X size={12} />
                </button>
              </Badge>
            );
          })}
        </div>
      )}

      {hasAvailable && (
        <FormField label={formatMessage({ id: "agent.channelMembers.search" })} labelStyle="plain" className="mb-3">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-foreground-muted" />
            <Input
              type="text"
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              className="input-member-search w-full pl-9"
              placeholder={formatMessage({ id: "agent.channelMembers.namePlaceholder" })}
              autoFocus
            />
          </div>
        </FormField>
      )}

      {addCandidateRows(true, isPage)}

      {/* Confirm — staged atomic commit; N=0 disabled; a rejected batch keeps
          every selected row available for correction/retry. */}
      <div className={`mt-4 ${isPage ? "shrink-0" : ""}`}>
        <Button
          type="button"
          onClick={() => void handleConfirmAdd()}
          disabled={adding || selectedKeys.size === 0}
          variant="primary"
          className="flex w-full items-center justify-center gap-1.5 px-3 py-1.5 text-sm font-bold theme-brutal:bg-brutal-pink theme-brutal:!text-black"
          data-testid="add-member-confirm"
        >
          <Plus size={14} />
          {adding
            ? formatMessage({ id: "agent.channelMembers.adding" })
            : formatMessage({ id: "agent.channelMembers.confirmAdd" }, { count: selectedKeys.size })}
        </Button>
      </div>
    </div>
  );

  const showInModalAddView = showAddSection && canAddChannelMembers;

  // Shared header + view body: the Modal shell (legacy) and the overflow
  // drawer panel (task #187) render identical content — only the close
  // affordance differs (panel mode: the drawer chrome owns close).
  const panelHeader = (
    <div className="mb-4 flex items-center justify-between">
      <div className="flex min-w-0 items-center gap-2">
        {showInModalAddView && (
          <Tooltip content={formatMessage({ id: "agent.channelMembers.backToMembers" })}>
            <Button size="sm" variant="outline"
              onClick={resetAddFlow}
              className="p-1"
              aria-label={formatMessage({ id: "agent.channelMembers.backToMembers" })}
              data-testid="add-member-back"
            >
              <ArrowLeft size={16} />
            </Button>
          </Tooltip>
        )}
        <h2 className="truncate text-lg font-bold">
          {showInModalAddView
            ? formatMessage({ id: "agent.channelMembers.addMember" })
            : isPanel
              // task #187: the overflow drawer pins the human/agent split
              // count (Artea: 几 humans · 几 agents) instead of one total.
              ? formatMessage({ id: "message.chatPanel.overflow.members" })
              : membersLoading
                ? formatMessage({ id: "message.chatPanel.overflow.membersLoading" })
                : formatMessage({ id: "agent.channelMembers.membersCount" }, { count: totalParticipants })}
        </h2>
        {isPanel && !showInModalAddView && (
          <span className="shrink-0 font-mono text-xs font-normal text-foreground-muted theme-brutal:text-black/55">
            {membersLoading
              ? formatMessage({ id: "message.chatPanel.overflow.membersLoading" })
              : formatMessage(
                  { id: "message.chatPanel.overflow.membersSummary" },
                  { humans: channelHumans.length, agents: channelAgents.length },
                )}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {!showInModalAddView && showAddEntry && (
          <Tooltip content={formatMessage({ id: "agent.channelMembers.addMember" })}>
            <Button size="sm" variant="outline"
              onClick={openAddSection}
              disabled={!hasAvailable}
              className="p-1 disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label={formatMessage({ id: "agent.channelMembers.addMember" })}
              data-testid="add-member-open"
            >
              <Plus size={16} />
            </Button>
          </Tooltip>
        )}
        {!isPanel && (
          <CloseButton
            onClick={closePanel}
            className=""
            aria-label={formatMessage({ id: "message.channelSettings.close" })}
          >
            <X size={20} />
          </CloseButton>
        )}
      </div>
    </div>
  );
  // final3: member list gets a bounded, borderless-scroll region in the
  // drawer panel; the add view stays unwrapped. final9 raises the bound
  // to 280px so a typical channel fits without inner scrolling.
  const panelBody = showInModalAddView
    ? addView
    : isPanel
      ? (
        <div
          className="max-h-[280px] overflow-y-auto border-y border-line-muted theme-brutal:border-black/10"
          data-testid="channel-members-scroll"
        >
          {memberListView}
        </div>
      )
      : memberListView;

  /* ── Members page (page mode, task #187): the overflow drawer's
     second-level view. One full-height column — yellow header (‹ back
     to the drawer root), persistent roster search, humans-first
     sections with counts + role tags, bottom-pinned ＋ add entry; the
     staged add flow renders in place as the drawer-internal third level,
     so the whole member interaction never leaves the drawer. ── */
  const normalizedRosterQuery = rosterQuery.trim().toLowerCase();
  const visibleHumans = channelHumans.filter((human) =>
    memberMatches(normalizedRosterQuery, human.name, human.displayName));
  const visibleAgents = channelAgents.filter((agent) =>
    memberMatches(normalizedRosterQuery, agent.name, agent.displayName));
  const visibleExternalMembers = channelExternalMembers.filter((member) =>
    memberMatches(normalizedRosterQuery, member.handles.join(" "), member.displayName));

  const pageHeader = (
    <div className="flex h-panel-header shrink-0 items-center gap-2 border-b border-line-muted bg-layer-inset px-4 theme-brutal:border-b-2 theme-brutal:border-black theme-brutal:bg-soft-signal">
      {/* In the add view the back button is the add flow's own ‹ back
          (resetAddFlow), keeping the add-member-back contract the modal
          and panel headers use; otherwise it returns to the drawer root. */}
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        onClick={() => (showAddSection ? resetAddFlow() : onBack?.())}
        aria-label={formatMessage({
          id: showAddSection ? "agent.channelMembers.backToMembers" : "channel.membersPage.back",
        })}
        data-testid={showAddSection ? "add-member-back" : "member-page-back"}
      >
        <ArrowLeft size={16} />
      </Button>
      <h2 className="truncate text-base font-bold">
        {showAddSection
          ? formatMessage({ id: "agent.channelMembers.addMember" })
          : formatMessage({ id: "message.chatPanel.overflow.members" })}
      </h2>
      {!showAddSection && !membersLoading && (
        <Badge
          appearance="soft"
          variant="muted"
          uppercase={false}
          className="shrink-0 font-mono"
          data-testid="member-page-count"
        >
          {totalParticipants}
        </Badge>
      )}
      {!showAddSection && membersLoading && (
        <Spinner
          size="sm"
          aria-label={formatMessage({ id: "message.chatPanel.overflow.membersLoading" })}
          data-testid="member-page-count-loading"
        />
      )}
      <div className="flex-1" />
    </div>
  );

  const pageListView = (
    <>
      {(roleError || roleChangeFailed) && (
        <Banner
          intent="warning"
          className="m-3 shrink-0 font-bold"
          data-testid="channel-member-role-error"
        >
          {roleError || formatMessage({ id: "agent.channelMembers.updateRoleFailed" })}
        </Banner>
      )}

      {/* Persistent search — filters both sections live. */}
      <div className="shrink-0 border-b border-line-muted theme-brutal:border-black/10 px-4 py-3">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-foreground-muted" />
          <Input
            type="text"
            value={rosterQuery}
            onChange={(e) => setRosterQuery(e.target.value)}
            disabled={membersLoading}
            className="input-member-search w-full pl-9"
            placeholder={formatMessage({ id: "channel.membersPage.searchPlaceholder" })}
            data-testid="member-page-search"
          />
        </div>
      </div>

      {/* Humans first (design master member-page), then agents. Each category
          uses Raft UI's disclosure primitive, starts expanded, and keeps its
          live filtered count in the trigger.

          The RUI sidebar section header bleeds by `--sidebar-row-inset-x`
          (6px each side) to escape its sidebar gutter; this page has no such
          gutter, so that bleed grew the header to calc(100% + 12px) and made
          the column scroll sideways. Zeroing the inset drops the negative
          margins, and w-full! replaces the 100%+12px width with one that fits
          the container - the chevron, label and count keep their exact
          positions, and the scrollbar disappears at its cause, not hidden.

          TEMPORARY (Artea, 2026-09-17): this page borrows RUI's sidebar
          section family for its groups, and that reuse is what leaks sidebar
          geometry into member rows. Two removals are tracked:
          - rui #284 derives the bleed width from the same variable instead of
            the hard-coded 12px; once the pinned raft-ui carries it, drop
            w-full! and keep only the inset declaration;
          - a generic rui Collapsible (commissioned in #proj-rui) will replace
            this SidebarSection reuse entirely, at which point both the inset
            declaration and this bridge are removed. */}
      <div className="min-h-0 flex-1 overflow-y-auto [--sidebar-row-inset-x:0px]">
        {membersLoading && (
          <div
            className="flex min-h-32 items-center justify-center gap-2 px-3 py-4 font-mono text-sm text-foreground-muted"
            aria-live="polite"
            data-testid="member-page-loading"
          >
            <Spinner
              size="sm"
              aria-label={formatMessage({ id: "message.chatPanel.overflow.membersLoading" })}
            />
            {formatMessage({ id: "message.chatPanel.overflow.membersLoading" })}
          </div>
        )}

        {!membersLoading && visibleHumans.length > 0 && (
          <MemberPageSection
            kind="humans"
            label={formatMessage({ id: "agent.channelMembers.humans" })}
            count={visibleHumans.length}
          >
            {visibleHumans.map((human) => renderHumanRow(human, true))}
          </MemberPageSection>
        )}

        {!membersLoading && visibleAgents.length > 0 && (
          <MemberPageSection
            kind="agents"
            label={formatMessage({ id: "agent.channelMembers.agents" })}
            count={visibleAgents.length}
          >
            {visibleAgents.map((agent) => renderAgentRow(agent, true))}
          </MemberPageSection>
        )}

        {!membersLoading && visibleExternalMembers.length > 0 && (
          <MemberPageSection
            kind="external"
            label={formatMessage({ id: "agent.channelMembers.slackParticipants" })}
            count={visibleExternalMembers.length}
          >
            {visibleExternalMembers.map(renderExternalRow)}
          </MemberPageSection>
        )}

        {!membersLoading && totalParticipants === 0 && (
          <div className="px-3 py-4 text-center font-mono text-sm text-foreground-muted theme-brutal:text-black/50">
            {formatMessage({ id: "agent.channelMembers.noMembers" })}
          </div>
        )}
        {!membersLoading
          && totalParticipants > 0
          && visibleHumans.length === 0
          && visibleAgents.length === 0
          && visibleExternalMembers.length === 0 && (
          <div className="px-3 py-4 text-center font-mono text-sm text-foreground-muted theme-brutal:text-black/50">
            {formatMessage({ id: "agent.channelMembers.noMatches" }, { query: rosterQuery.trim() })}
          </div>
        )}
      </div>

      {/* ＋ Add members — bottom pinned; swaps in the staged multi-select
          add flow (drawer-internal third level, no Modal). Hidden while a
          remove confirm is staged so the bottom bar never stacks. */}
      {!removeTarget && showAddEntry && (
        <div className="shrink-0 border-t-2 border-line-muted theme-brutal:border-black p-3">
          <Button
            size="md"
            variant="outline"
            type="button"
            onClick={openAddSection}
            disabled={!hasAvailable}
            className="flex w-full items-center justify-center gap-1.5 font-bold disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="member-page-add"
          >
            <Plus size={14} />
            {formatMessage({ id: "agent.channelMembers.addMember" })}
          </Button>

        </div>
      )}
    </>
  );

  return (
    <>
      {/* Member count button in header */}
      {!isPanel && !isPage && !hideTrigger && (
        <Tooltip content={formatMessage({ id: "agent.channelMembers.viewParticipants" })}>
          <Button
            onClick={() => setShowPanel(true)}
            size="sm"
            className="min-w-7 gap-1 px-1.5"
            aria-label={formatMessage({ id: "agent.channelMembers.viewParticipants" })}
            data-testid="channel-members-open"
          >
            <Users size={14} className="shrink-0" />
            {membersLoading ? (
              <Spinner
                size="xs"
                aria-label={formatMessage({ id: "message.chatPanel.overflow.membersLoading" })}
              />
            ) : (
              <span data-testid="channel-members-count" className="min-w-[1ch] text-center font-mono text-[11px] font-bold leading-none tabular-nums">
                {totalParticipants > 99 ? "99+" : totalParticipants}
              </span>
            )}
          </Button>
        </Tooltip>
      )}

      {/* Members modal panel */}
      {!isPanel && !isPage && showPanel && (
        <Modal onClose={closePanel}>
          <Card className="w-full max-w-sm p-6">
            {panelHeader}
            {panelBody}
          </Card>
        </Modal>
      )}

      {/* Drawer-embedded panel (task #187): no Modal, no close X — the
          overflow sheet chrome owns back/close. */}
      {isPanel && (
        <div className="px-4 py-2" data-testid="channel-members-panel">
          {panelHeader}
          {panelBody}
        </div>
      )}

      {/* Drawer-internal members page (task #187): full-height column
          the host overflow drawer shows as its second-level view. */}
      {isPage && (
        <>
          {/* Keep the roster page mounted under the profile page. Its live
              search query, disclosures and scroll position are the actual
              "previous page" the Back control must restore. */}
          <div
            className={`${selectedProfile ? "hidden" : "flex"} min-h-0 flex-1 flex-col bg-layer-panel text-foreground-strong theme-brutal:bg-white theme-brutal:text-black`}
            data-testid="member-page"
          >
            {pageHeader}
            {showAddSection && canAddChannelMembers ? (
              <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
                {addView}
              </div>
            ) : pageListView}
          </div>
          {selectedProfile && (
            <Suspense
              fallback={(
                <div className="flex min-h-0 flex-1 items-center justify-center bg-layer-panel text-sm font-display text-foreground-muted theme-brutal:bg-white theme-brutal:text-black/40">
                  {formatMessage({ id: "common.loading" })}
                </div>
              )}
            >
              <ProfilePanel
                key={`${selectedProfile.type}:${selectedProfile.id}`}
                target={selectedProfile}
                presentation="embedded"
                onBack={backProfile}
                onClose={closeProfilePage}
                onOpenProfile={openNestedProfile}
              />
            </Suspense>
          )}
        </>
      )}

      {/* One shared dialog across modal, panel, desktop Drawer, and the
          full-screen mobile Drawer. */}
      {removeConfirmDialog}
      {protectedDemoteTarget && (
        <ConfirmDialog
          title={formatMessage({ id: "agent.channelMembers.cannotDemoteServerAdminTitle" })}
          message={formatMessage(
            { id: "agent.channelMembers.cannotDemoteServerAdminMessage" },
            { name: protectedDemoteTarget },
          )}
          confirmLabel={formatMessage({ id: "common.ok" })}
          confirmColor="bg-white"
          hideCancel
          closeOnConfirm={false}
          onConfirm={() => setProtectedDemoteTarget(null)}
          onClose={() => setProtectedDemoteTarget(null)}
          layer={1}
          chromeLocale="active"
        />
      )}
      {showCreateAgent && (
        <CreateAgentDialog
          prefilledName={createEntryPromoted ? createAgentPrefillName : undefined}
          prefilledNameNote={createEntryPromoted ? [
            // "改了要说": the @-strip is the one modification we make.
            ...(memberSearch.trim().startsWith("@")
              ? [formatMessage({ id: "channel.addMembers.prefillAtStripped" })]
              : []),
            ...(/\s/.test(createAgentPrefillName)
              ? [formatMessage(
                  { id: "channel.addMembers.prefillSpacesKept" },
                  {
                    dashed: createAgentPrefillName.replace(/\s+/g, "-"),
                    joined: createAgentPrefillName.replace(/\s+/g, ""),
                  },
                )]
              : []),
          ].join(" ") || undefined : undefined}
          stayOnCreate
          autoJoinChannelName={currentChannel?.name}
          onCreated={(agent) => { void joinCreatedAgent(agent); }}
          onClose={() => setShowCreateAgent(false)}
        />
      )}
    </>
  );
}
