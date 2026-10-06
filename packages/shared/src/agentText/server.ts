// Canonical server / channel / user text for agent-facing output (moved
// verbatim from the CLI's commands/server/_format.ts; the CLI wraps these in
// its axSurface registrations and pins the bytes with its snapshot tests).

import { formatHint, formatHintName, RAFT_HINTS, RAFT_NO_TOOL_WORDING, type RaftHintStyle } from "../agentOps/hint";

export interface AgentChannelInfo {
  id?: string | null;
  name: string;
  joined: boolean;
  type?: string | null;
  description?: string | null;
  muted?: boolean | null;
  activityMuted?: boolean | null;
  archived?: boolean | null;
  channelRole?: "member" | "admin" | null;
  channelAdminBasis?: "server_role" | "channel_role" | "both" | null;
  channelCapabilities?: Record<string, boolean> | null;
}

export interface AgentMemberAgentInfo {
  name: string;
  /** Missing on older Servers; rendered as "unknown". */
  status?: string | null;
  activity?: string | null;
  activityDetail?: string | null;
  role?: "owner" | "admin" | "member" | string | null;
  serverRole?: "owner" | "admin" | "member" | string | null;
  channelRole?: "admin" | "member" | string | null;
  effectiveChannelRole?: "owner" | "admin" | "member" | string | null;
  channelAdminBasis?: "server_role" | "channel_role" | "both" | string | null;
  description?: string | null;
}

export interface AgentAgentInfo {
  name: string;
  status?: string | null;
  activity?: string | null;
  activityDetail?: string | null;
  role?: "owner" | "admin" | "member" | string | null;
  description?: string | null;
}

export interface AgentMemberHumanInfo {
  name: string;
  role?: "owner" | "admin" | "member" | string | null;
  serverRole?: "owner" | "admin" | "member" | string | null;
  channelRole?: "admin" | "member" | string | null;
  effectiveChannelRole?: "owner" | "admin" | "member" | string | null;
  channelAdminBasis?: "server_role" | "channel_role" | "both" | string | null;
  description?: string | null;
}

export interface AgentHumanInfo {
  name: string;
  role?: "owner" | "admin" | "member" | string | null;
  description?: string | null;
}

export interface AgentRuntimeContextInfo {
  agentId?: string | null;
  runtime?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  serverId?: string | null;
  machineId?: string | null;
  machineName?: string | null;
  machineDescription?: string | null;
  machineHostname?: string | null;
  machineOs?: string | null;
  daemonVersion?: string | null;
  workspacePath?: string | null;
}

export interface AgentChannelMembersData {
  channel?: { ref?: string; type?: string };
  agents?: AgentMemberAgentInfo[];
  humans?: AgentMemberHumanInfo[];
}

export interface AgentServerData {
  runtimeContext?: AgentRuntimeContextInfo | null;
  serverRole?: "owner" | "admin" | "member" | string | null;
  serverCapabilities?: Record<string, unknown> | null;
  channels?: AgentChannelInfo[];
  agents?: AgentAgentInfo[];
  humans?: AgentHumanInfo[];
}

export interface AgentPageInfo {
  total: number;
  offset: number;
  limit: number;
  nextCommand?: string;
}

function formatRuntimeContext(ctx?: AgentRuntimeContextInfo | null): string {
  if (!ctx) return "";

  const lines: string[] = [
    "### Current Runtime",
    "Authoritative context for this agent process. Do not infer computer identity from hostname or cwd when this section is present.",
  ];
  if (ctx.agentId) lines.push(`- Agent ID: ${ctx.agentId}`);
  if (ctx.runtime) lines.push(`- Runtime: ${ctx.runtime}`);
  if (ctx.model) lines.push(`- Model: ${ctx.model}`);
  if (ctx.reasoningEffort) lines.push(`- Reasoning: ${ctx.reasoningEffort}`);
  if (ctx.serverId) lines.push(`- Server ID: ${ctx.serverId}`);
  if (ctx.machineName || ctx.machineId) {
    const label = ctx.machineName && ctx.machineId
      ? `${ctx.machineName} (${ctx.machineId})`
      : ctx.machineName || ctx.machineId;
    lines.push(`- Computer: ${label}`);
  }
  if (ctx.machineDescription) lines.push(`- Computer Description: ${ctx.machineDescription}`);
  if (ctx.machineHostname) lines.push(`- Hostname: ${ctx.machineHostname}`);
  if (ctx.machineOs) lines.push(`- OS: ${ctx.machineOs}`);
  if (ctx.daemonVersion) lines.push(`- Daemon: v${ctx.daemonVersion}`);
  if (ctx.workspacePath) lines.push(`- Workspace: ${ctx.workspacePath}`);

  return lines.length > 2 ? `${lines.join("\n")}\n\n` : "";
}

function roleLabel(role?: string | null): string {
  return role && role !== "member" ? ` (${role})` : "";
}

function channelMemberRoleDetail(member: {
  serverRole?: string | null;
  channelRole?: string | null;
  effectiveChannelRole?: string | null;
  channelAdminBasis?: string | null;
}): string {
  const details: string[] = [];
  if (member.serverRole) details.push(`server role=${member.serverRole}`);
  if (member.channelRole) details.push(`channel role=${member.channelRole}`);
  if (member.channelAdminBasis) details.push(`admin via=${member.channelAdminBasis}`);
  return details.length > 0 ? ` [${details.join(", ")}]` : "";
}

export function agentStatusLabel(agent: { status?: string | null; activity?: string | null; activityDetail?: string | null }): string {
  const lifecycle = agent.status?.trim() || "unknown";
  const activity = agent.activity?.trim();
  if (!activity) return lifecycle;

  const activityWithDetail = agent.activityDetail?.trim()
    ? `${activity}: ${agent.activityDetail.trim()}`
    : activity;
  return activity === lifecycle ? lifecycle : `${lifecycle}; ${activityWithDetail}`;
}

function formatCurrentAgent(data: AgentServerData): string {
  if (!data.serverRole) return "";

  const lines = ["### Current Agent"];
  lines.push(`- Role: ${data.serverRole}`);
  return `${lines.join("\n")}\n\n`;
}

/** Server overview: runtime context, channels, agents, humans. */
export function formatAgentServerInfo(data: AgentServerData, style: RaftHintStyle = "cli"): string {
  let text = "## Server\n\n";
  const channels = data.channels ?? [];
  const agents = data.agents ?? [];
  const humans = data.humans ?? [];

  text += formatRuntimeContext(data.runtimeContext);
  text += formatCurrentAgent(data);

  text += "### Channels\n";
  text += "Visible public channels may appear even when `joined=false`. Private channels are shown only when you are a member; do not disclose private-channel names, membership, or content outside that channel. ";
  text += style === "cli"
    ? `Use channel attention commands (\`${formatHintName(RAFT_HINTS.channelJoinName())}\`, \`leave\`, \`mute\`, \`unmute\`; \`${formatHintName(RAFT_HINTS.threadUnfollowName())}\`) for your own delivery state. Existing channel management commands (\`${formatHintName(RAFT_HINTS.channelCreateName())}\`, \`update\`, \`archive\`, \`unarchive\`, \`add-member\`, \`remove-member\`) are authorized per channel; a channel-admin role never grants delete, visibility, federation, or server-profile actions. There is no Agent command for changing channel roles. Run any subcommand with \`--help\` for syntax.\n`
    : `Use the channel attention tools (${[RAFT_HINTS.channelJoinName(), RAFT_HINTS.channelLeaveName(), RAFT_HINTS.channelMuteName(), RAFT_HINTS.channelUnmuteName()].map((hint) => `\`${formatHintName(hint, style)}\``).join(", ")}; \`${formatHintName(RAFT_HINTS.threadUnfollowName(), style)}\`) for your own delivery state. Channel management (create, update, archive, unarchive, add-member, remove-member) has no tool: ${RAFT_NO_TOOL_WORDING}; a channel-admin role never grants delete, visibility, federation, or server-profile actions. There is no tool for changing channel roles.\n`;
  text += style === "cli"
    ? `Server-profile changes still use ${formatHintName(RAFT_HINTS.serverUpdateName())} and remain server-role gated.\n`
    : `Server-profile changes have no tool and remain server-role gated: ${RAFT_NO_TOOL_WORDING}.\n`;
  text += "Mute state is shown when the server provides it; otherwise it is omitted.\n";
  if (channels.length > 0) {
    for (const t of channels) {
      const statusParts = [channelVisibility(t), t.joined ? "joined" : "not joined"];
      if (t.channelRole) statusParts.push(`channel role=${t.channelRole}`);
      if (t.channelAdminBasis) statusParts.push(`admin via=${t.channelAdminBasis}`);
      const muted = channelMuted(t);
      if (muted !== undefined) statusParts.push(muted ? "muted" : "not muted");
      const status = statusParts.join(", ");
      const ref = agentChannelRef(t.name, t.type);
      text += t.description
        ? `  - ${ref} [${status}] — ${t.description}\n`
        : `  - ${ref} [${status}]\n`;
    }
  } else {
    text += "  (none)\n";
  }

  text += "\n### Agents\n";
  text += "Other AI agents in this server.\n";
  text += "Role labels show server-level owner/admin authority; no role label means ordinary member.\n";
  if (agents.length > 0) {
    for (const a of agents) {
      const role = roleLabel(a.role);
      const status = agentStatusLabel(a);
      text += a.description
        ? `  - @${a.name} (${status})${role} — ${a.description}\n`
        : `  - @${a.name} (${status})${role}\n`;
    }
  } else {
    text += "  (none)\n";
  }

  text += "\n### Humans\n";
  const newDm = formatHint(RAFT_HINTS.messageSend({ target: "dm:@name" }), style);
  text += style === "cli"
    ? `To start a new DM: ${newDm} <<'RAFTMSG' followed by the message body and RAFTMSG. To reply in an existing DM: reuse the target from received messages.\n`
    : `To start a new DM: ${newDm}. To reply in an existing DM: reuse the target from received messages.\n`;
  text += "Role labels show server-level owner/admin authority; no role label means ordinary member.\n";
  if (humans.length > 0) {
    for (const u of humans) {
      const role = roleLabel(u.role);
      text += u.description ? `  - @${u.name}${role} — ${u.description}\n` : `  - @${u.name}${role}\n`;
    }
  } else {
    text += "  (none)\n";
  }

  return (text);
}

export function agentChannelRef(name: string, type?: string | null): string {
  if (type === "dm") return `dm:@${name}`;
  return name.startsWith("#") ? name : `#${name}`;
}

// A joint channel is shared with members of other servers and is
// membership-gated like a private one; calling it "public" hid that.
function channelVisibility(channel: AgentChannelInfo): string {
  const type = channel.type?.trim();
  if (type === "joint") return "joint";
  return type === "private" || type === "dm" ? "private" : "public";
}

function channelMuted(channel: AgentChannelInfo): boolean | undefined {
  if (typeof channel.muted === "boolean") return channel.muted;
  if (typeof channel.activityMuted === "boolean") return channel.activityMuted;
  return undefined;
}

function channelStatus(channel: AgentChannelInfo): string {
  const parts = [
    channelVisibility(channel),
    channel.joined ? "joined" : "not joined",
  ];
  const muted = channelMuted(channel);
  if (channel.channelRole) parts.push(`channel role=${channel.channelRole}`);
  if (channel.channelAdminBasis) parts.push(`admin via=${channel.channelAdminBasis}`);
  if (muted !== undefined) parts.push(muted ? "muted" : "not muted");
  if (typeof channel.archived === "boolean") parts.push(channel.archived ? "archived" : "not archived");
  return parts.join(", ");
}

function formatPageFooter(page?: AgentPageInfo): string {
  if (!page) return "";
  const start = page.total === 0 ? 0 : Math.min(page.offset + 1, page.total);
  const end = Math.min(page.offset + page.limit, page.total);
  const lines = [`\nShowing ${start}-${end} of ${page.total}.`];
  if (page.nextCommand && end < page.total) {
    lines.push(`More: ${page.nextCommand}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Single channel detail block. */
export function formatAgentChannelInfo(
  channel: AgentChannelInfo,
  memberCounts?: { agents?: number; humans?: number } | null,
  style: RaftHintStyle = "cli",
): string {
  const lines = ["## Channel", ""];
  lines.push(`Channel: ${agentChannelRef(channel.name, channel.type)}`);
  if (channel.id) lines.push(`ID: ${channel.id}`);
  lines.push(`Visibility: ${channelVisibility(channel)}`);
  lines.push(`Joined: ${channel.joined ? "yes" : "no"}`);
  if (channel.channelRole) lines.push(`Channel role: ${channel.channelRole}`);
  if (channel.channelAdminBasis) lines.push(`Channel admin basis: ${channel.channelAdminBasis}`);
  const callableCapabilities = Object.entries(channel.channelCapabilities ?? {})
    .filter(([, allowed]) => allowed)
    .map(([capability]) => capability);
  if (callableCapabilities.length > 0) lines.push(`Channel capabilities: ${callableCapabilities.join(", ")}`);
  const muted = channelMuted(channel);
  if (muted !== undefined) lines.push(`Muted: ${muted ? "yes" : "no"}`);
  if (typeof channel.archived === "boolean") lines.push(`Archived: ${channel.archived ? "yes" : "no"}`);
  lines.push(`Description: ${channel.description?.trim() || "(none)"}`);
  if (memberCounts) {
    const agents = memberCounts.agents ?? 0;
    const humans = memberCounts.humans ?? 0;
    lines.push(`Members: ${agents + humans} (${agents} agents, ${humans} humans)`);
  }
  lines.push("");
  lines.push(`More: ${formatHint(RAFT_HINTS.channelMembers(agentChannelRef(channel.name, channel.type)), style)}`);
  return (`${lines.join("\n")}\n`);
}

/** Compact server summary. */
export function formatAgentServerSummary(data: AgentServerData, style: RaftHintStyle = "cli"): string {
  const channels = data.channels ?? [];
  const agents = data.agents ?? [];
  const humans = data.humans ?? [];
  const joined = channels.filter((channel) => channel.joined).length;
  const lines = [
    "## Server",
    "",
    `Channels: ${channels.length} visible (${joined} joined)`,
    `Agents: ${agents.length}`,
    `Humans: ${humans.length}`,
    "",
    "Narrow queries:",
    ...[
      RAFT_HINTS.serverInfo({ view: "channels" }),
      RAFT_HINTS.serverInfo({ view: "agents" }),
      RAFT_HINTS.serverInfo({ view: "humans" }),
      RAFT_HINTS.channelInfo(),
      RAFT_HINTS.userInfo(),
    ].map((hint) => `- ${formatHint(hint, style)}`),
    "",
    `Full dump: ${formatHint(RAFT_HINTS.serverInfo({ view: "full" }), style)}`,
  ];
  return (`${lines.join("\n")}\n`);
}

/** Channel listing page. */
export function formatAgentServerChannels(channels: AgentChannelInfo[], page?: AgentPageInfo): string {
  const lines = [
    "## Server Channels",
    "",
    "Private channels are shown only when this agent is a member. Do not disclose private-channel names or metadata outside that channel.",
  ];
  if (channels.length === 0) {
    lines.push("(none)");
  } else {
    for (const channel of channels) {
      const description = channel.description?.trim();
      lines.push(description
        ? `${agentChannelRef(channel.name, channel.type)} [${channelStatus(channel)}] — ${description}`
        : `${agentChannelRef(channel.name, channel.type)} [${channelStatus(channel)}]`);
    }
  }
  return (`${lines.join("\n")}${formatPageFooter(page)}`);
}

/** Agent listing page. */
export function formatAgentServerAgents(agents: AgentAgentInfo[], page?: AgentPageInfo): string {
  const lines = [
    "## Server Agents",
    "",
    "Role labels show server-level owner/admin authority; no role label means ordinary member.",
  ];
  if (agents.length === 0) {
    lines.push("(none)");
  } else {
    for (const agent of agents) {
      const role = roleLabel(agent.role);
      const status = agentStatusLabel(agent);
      lines.push(agent.description
        ? `@${agent.name} (${status})${role} — ${agent.description}`
        : `@${agent.name} (${status})${role}`);
    }
  }
  return (`${lines.join("\n")}${formatPageFooter(page)}`);
}

/** Human listing page. */
export function formatAgentServerHumans(humans: AgentHumanInfo[], page?: AgentPageInfo): string {
  const lines = [
    "## Server Humans",
    "",
    "Role labels show server-level owner/admin authority; no role label means ordinary member.",
  ];
  if (humans.length === 0) {
    lines.push("(none)");
  } else {
    for (const human of humans) {
      const role = roleLabel(human.role);
      lines.push(human.description ? `@${human.name}${role} — ${human.description}` : `@${human.name}${role}`);
    }
  }
  return (`${lines.join("\n")}${formatPageFooter(page)}`);
}

/** Narrow visible facts for one user/agent. */
export function formatAgentUserInfo(
  user: { kind: "agent"; value: AgentAgentInfo } | { kind: "human"; value: AgentHumanInfo },
  memberships: AgentChannelInfo[],
  page?: AgentPageInfo,
  skippedChannels: number = 0,
): string {
  const name = user.value.name;
  const role = roleLabel(user.value.role);
  const lines = ["## User", ""];
  lines.push(`User: @${name}`);
  lines.push(`Kind: ${user.kind}`);
  if (user.kind === "agent") lines.push(`Status: ${agentStatusLabel(user.value)}`);
  if (role) lines.push(`Role: ${role.slice(2, -1)}`);
  if (user.value.description) lines.push(`Description: ${user.value.description}`);
  lines.push("");
  lines.push("### Visible Channel Memberships");
  if (memberships.length === 0) {
    lines.push("(none found in inspected visible channels)");
  } else {
    for (const channel of memberships) {
      lines.push(`${agentChannelRef(channel.name, channel.type)} [${channelStatus(channel)}]`);
    }
  }
  if (skippedChannels > 0) {
    lines.push(`Skipped ${skippedChannels} visible channel roster checks because the server rejected them.`);
  }
  return (`${lines.join("\n")}${formatPageFooter(page)}`);
}

/** Channel membership with server-role labels. */
export function formatAgentChannelMembers(data: AgentChannelMembersData): string {
  let text = "## Channel Members\n\n";
  const ref = data.channel?.ref ?? "(unknown)";
  const type = data.channel?.type ? ` (${data.channel.type})` : "";
  const agents = data.agents ?? [];
  const humans = data.humans ?? [];

  text += `Channel: ${ref}${type}\n`;
  text += "Members means join/post authority for this surface.\n\n";

  text += "### Agents\n";
  text += "Server and stored channel roles are shown separately when available.\n";
  if (agents.length > 0) {
    for (const a of agents) {
      const role = roleLabel(a.role);
      const channelRole = channelMemberRoleDetail(a);
      const status = agentStatusLabel(a);
      text += a.description
        ? `  - @${a.name} (${status})${role}${channelRole} — ${a.description}\n`
        : `  - @${a.name} (${status})${role}${channelRole}\n`;
    }
  } else {
    text += "  (none)\n";
  }

  text += "\n### Humans\n";
  text += "Server and stored channel roles are shown separately when available.\n";
  if (humans.length > 0) {
    for (const u of humans) {
      const role = roleLabel(u.role);
      const channelRole = channelMemberRoleDetail(u);
      text += u.description ? `  - @${u.name}${role}${channelRole} — ${u.description}\n` : `  - @${u.name}${role}${channelRole}\n`;
    }
  } else {
    text += "  (none)\n";
  }

  return (text);
}
