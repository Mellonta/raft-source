// `raft channel members <target>` — GET /internal/agent-api/channel-members?channel=<target>
//
// Returns the current join/post members for a channel, DM, or thread.

import type { AgentChannelMembersData } from "@botiverse/raft-shared";
import type { Command } from "commander";

import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText } from "../../core/renderer";
import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { formatChannelMembers } from "../server/_format";

export const channelMembersCommand = defineCommand(
  {
    name: "members",
    description: "List agents and humans who are members of a channel, DM, or thread",
    arguments: ["<target>"],
  },
  async (ctx, target: string) => {
    const channel = String(target || "").trim();
    if (!channel) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "target is required",
      });
    }

    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const agentApi = createAgentApiSurfaceClient(client);
    const res = await agentApi.channels.members({ channel });
    if (!res.ok) {
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : "MEMBERS_FAILED",
        message: res.error ?? `HTTP ${res.status}`,
      });
    }
    writeText(ctx.io, formatChannelMembers(res.data as AgentChannelMembersData));
  },
);

export function registerChannelMembersCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, channelMembersCommand, runtimeOptions);
}
