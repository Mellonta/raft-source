// `raft user info <@name>` — narrow visible profile and channel-membership facts.
// → GET /internal/agent-api/users/:name/channels (the SDK's users.info operation)

import type { Command } from "commander";
import {
  AGENT_API_USER_CHANNELS_DEFAULT_LIMIT,
  AGENT_API_USER_CHANNELS_MAX_LIMIT,
  userInfo,
} from "@botiverse/raft-shared";

import { createAgentApiContractSurfaceClient, createCliOperationFailures } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText } from "../../core/renderer";
import { formatUserInfo } from "../server/_format";

interface UserInfoOpts {
  limit?: string;
  offset?: string;
}

function parseNonNegativeInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `${name} must be a non-negative integer`,
    });
  }
  return Number(raw);
}

function parsePositiveInt(raw: string | undefined, name: string, fallback: number): number {
  const value = parseNonNegativeInt(raw, name, fallback);
  if (value <= 0) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `${name} must be greater than 0`,
    });
  }
  return value;
}

function normalizeUserName(target: string | undefined): string {
  const trimmed = target?.trim() ?? "";
  const name = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (!name) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "user name is required",
    });
  }
  return name;
}

export const userInfoCommand = defineCommand(
  {
    name: "info",
    description: "Show narrow visible facts for a human or agent and its visible channel memberships",
    arguments: ["<name>"],
    options: [
      { flags: "--limit <n>", description: "Maximum visible channels to inspect (default: 50)" },
      { flags: "--offset <n>", description: "Visible channels to skip before inspection (default: 0)" },
    ],
  },
  async (ctx, target: string | undefined, opts: UserInfoOpts = {}) => {
    normalizeUserName(target);
    const limit = parsePositiveInt(opts.limit, "--limit", AGENT_API_USER_CHANNELS_DEFAULT_LIMIT);
    const offset = parseNonNegativeInt(opts.offset, "--offset", 0);
    if (limit > AGENT_API_USER_CHANNELS_MAX_LIMIT) {
      throw new CliError({
        code: "INVALID_ARG",
        message: `--limit must be at most ${AGENT_API_USER_CHANNELS_MAX_LIMIT}`,
      });
    }

    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const api = createAgentApiContractSurfaceClient(client);
    const failures = createCliOperationFailures();
    // One users.channels request (server.info as well when the credential
    // cannot read rosters); the operation is the SDK's users.info.
    const outcome = await userInfo({
      server: { ...api.server, info: () => failures.observe(api.server.info()) },
      users: { ...api.users, channels: (params, query) => failures.observe(api.users.channels(params, query)) },
    }, { name: target ?? "", offset, limit });

    if (!outcome.ok) {
      const failure = failures.last();
      if (outcome.error.code === "INVALID_REQUEST") {
        throw new CliError({ code: "INVALID_ARG", message: outcome.error.message });
      }
      if (outcome.error.code === "NOT_FOUND" && outcome.error.status === undefined) {
        throw new CliError({
          code: "NOT_FOUND",
          message: outcome.error.message,
          suggestedNextAction: outcome.error.nextAction,
        });
      }
      throw new CliError({
        code: (failure?.status ?? 0) >= 500 ? "SERVER_5XX" : "INFO_FAILED",
        message: failure?.error ?? (failure ? `HTTP ${failure.status}` : outcome.error.message),
      });
    }

    const { user, memberships, page, skippedChannels } = outcome.data;
    writeText(ctx.io, formatUserInfo(user, memberships, page, skippedChannels));
  },
);

export function registerUserInfoCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, userInfoCommand, runtimeOptions);
}
