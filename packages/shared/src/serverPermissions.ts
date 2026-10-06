export type ServerRole = "owner" | "admin" | "member" | "guest";
export type ServerViewMode = "member" | "public-anonymous" | "public-authenticated-nonmember";
// Guest is intentionally excluded until the server-admission phase exposes
// invite/join-link/role-management entry points.
export type ManageableServerRole = Exclude<ServerRole, "guest">;
export const MANAGEABLE_SERVER_ROLES = ["owner", "admin", "member"] as const satisfies readonly ManageableServerRole[];

/**
 * Server-wide capabilities are intentionally action-specific. Channel access,
 * posting, object ownership, and actor-type policy remain separate
 * authorization axes and must not be inferred from this matrix.
 */
export const SERVER_CAPABILITY_KEYS = [
  "viewChannel",
  "createChannels",
  "editChannelMetadata",
  "archiveChannels",
  "deleteChannels",
  "changeChannelVisibility",
  "manageGuestAccess",
  "federateChannels",
  "viewChannelMembers",
  "joinPublicChannels",
  "addChannelMembers",
  "removeChannelMembers",
  "changeChannelMemberRoles",
  "viewMembers",
  "inviteMembers",
  "removeMembers",
  "changeMemberRoles",
  "viewServerProfile",
  "viewServerSettings",
  "editServerSettings",
  "manageIntegrations",
  "manageExternalAuth",
  "rotateServerSecrets",
  "viewAgents",
  "createAgents",
  "editAgents",
  "controlAgentRuntime",
  "resetAgentWorkspace",
  "deleteAgents",
  "migrateAgents",
  "issueAgentCredentials",
  "viewMachines",
  "registerMachines",
  "editMachines",
  "controlComputers",
  "removeMachines",
  "rotateMachineKeys",
  "assignTasks",
  "deleteAnyTask",
  "viewBilling",
  "manageBilling",
] as const;

export type ServerCapability = typeof SERVER_CAPABILITY_KEYS[number];
export type ServerCapabilities = Readonly<Record<ServerCapability, boolean>>;

export interface ServerSurfaceCapabilities {
  server: ServerCapabilities;
  readPublicChannels: boolean;
  writeMessages: boolean;
  reactToMessages: boolean;
  followThreads: boolean;
  showHelp: boolean;
  settingsScope: "member" | "anonymous-resources" | "account-and-resources";
}

const ALL_SERVER_CAPABILITIES = Object.freeze(
  Object.fromEntries(SERVER_CAPABILITY_KEYS.map((capability) => [capability, true])) as unknown as ServerCapabilities
);

function capabilitiesFrom(granted: readonly ServerCapability[]): ServerCapabilities {
  const grantedSet = new Set<ServerCapability>(granted);
  return Object.freeze(
    Object.fromEntries(SERVER_CAPABILITY_KEYS.map((capability) => [capability, grantedSet.has(capability)])) as unknown as ServerCapabilities
  );
}

const EMPTY_SERVER_CAPABILITIES = capabilitiesFrom([]);
const ADMIN_SERVER_CAPABILITIES = capabilitiesFrom(
  SERVER_CAPABILITY_KEYS.filter((capability) => capability !== "manageBilling")
);
const MEMBER_SERVER_CAPABILITIES = capabilitiesFrom([
  "viewServerProfile",
  "viewChannel",
  "createChannels",
  "viewChannelMembers",
  "joinPublicChannels",
  "addChannelMembers",
  "viewMembers",
  "viewAgents",
  "controlAgentRuntime",
  "viewMachines",
  "assignTasks",
]);

const SERVER_CAPABILITY_MATRIX: Record<ServerRole, ServerCapabilities> = {
  owner: ALL_SERVER_CAPABILITIES,
  admin: ADMIN_SERVER_CAPABILITIES,
  member: MEMBER_SERVER_CAPABILITIES,
  guest: EMPTY_SERVER_CAPABILITIES,
};

export function isOwnerRole(role: ServerRole | null | undefined): role is "owner" {
  return role === "owner";
}

export function isAdminOrOwner(role: ServerRole | null | undefined): role is "owner" | "admin" {
  return role === "owner" || role === "admin";
}

export function isGuestRole(role: ServerRole | null | undefined): role is "guest" {
  return role === "guest";
}

export function getServerCapabilities(role: ServerRole | null | undefined): ServerCapabilities {
  return role ? SERVER_CAPABILITY_MATRIX[role] : EMPTY_SERVER_CAPABILITIES;
}

/**
 * One capability projection for every `/s/:slug` presentation state.
 * Authentication and membership stay independent: signing in may widen
 * account/help chrome, but it never grants server actions or message writes.
 */
export function getServerSurfaceCapabilities(
  mode: ServerViewMode,
  role?: ServerRole | null,
): ServerSurfaceCapabilities {
  if (mode === "member") {
    return Object.freeze({
      server: getServerCapabilities(role),
      readPublicChannels: false,
      writeMessages: true,
      reactToMessages: true,
      followThreads: true,
      showHelp: true,
      settingsScope: "member",
    });
  }
  return Object.freeze({
    server: EMPTY_SERVER_CAPABILITIES,
    readPublicChannels: true,
    writeMessages: false,
    reactToMessages: false,
    followThreads: false,
    showHelp: mode === "public-authenticated-nonmember",
    settingsScope: mode === "public-authenticated-nonmember"
      ? "account-and-resources"
      : "anonymous-resources",
  });
}

export function hasServerCapability(role: ServerRole | null | undefined, capability: ServerCapability): boolean {
  return getServerCapabilities(role)[capability];
}

export function canReadBillingSummary(role: ServerRole | null | undefined): boolean {
  return hasServerCapability(role, "viewBilling");
}

export function canMutateBilling(role: ServerRole | null | undefined): boolean {
  return hasServerCapability(role, "manageBilling");
}

/**
 * Owner is a normal server membership role. Owners can grant/revoke owner,
 * admin, and member roles; the server route enforces the data-dependent
 * invariant that a server must keep at least one owner. Admin behavior stays
 * intentionally narrow: admins can promote members to admin, but cannot touch
 * owners or demote peer admins.
 */
export function canChangeMemberRole(
  actorRole: ServerRole | null | undefined,
  targetRole: ServerRole | null | undefined,
  nextRole: ManageableServerRole
): boolean {
  if (!actorRole || !targetRole) {
    return false;
  }

  if (actorRole === "owner") {
    return true;
  }

  if (actorRole === "admin") {
    return targetRole === "member" && nextRole === "admin";
  }

  return false;
}

export interface ServerRoleTransitionInput {
  actorRole: ServerRole | null | undefined;
  targetRole: ServerRole | null | undefined;
  nextRole: ServerRole;
  isSelf: boolean;
  ownerCount: number;
}

/**
 * Target-aware policy for the later Guest admission/role-management phase.
 * Keeping it pure and unreachable lets every eventual API/UI surface consume
 * one contract without opening Guest creation in the foundation release.
 */
export function canTransitionServerRole(input: ServerRoleTransitionInput): boolean {
  const { actorRole, targetRole, nextRole, isSelf, ownerCount } = input;
  if (!actorRole || !targetRole || targetRole === nextRole) return false;
  if (actorRole === "guest" || actorRole === "member") return false;

  if (actorRole === "owner") {
    return !(targetRole === "owner" && nextRole !== "owner" && ownerCount <= 1);
  }

  if (actorRole === "admin") {
    if (isSelf || targetRole === "owner" || targetRole === "admin") return false;
    return nextRole !== "owner" && (targetRole === "member" || targetRole === "guest");
  }

  return false;
}
