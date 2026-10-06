// `raft thread list`
// -> GET /internal/agent-api/threads

import type { Command } from "commander";
import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText, NL } from "../../core/renderer";
import { formatThreadList } from "./_format";

export { formatThreadList } from "./_format";

export const threadListCommand = defineCommand(
  {
    name: "list",
    description: "List threads this agent is currently following",
  },
  async (ctx) => {
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const agentApi = createAgentApiSurfaceClient(client);
    const res = await agentApi.threads.list();
    if (!res.ok) {
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : "LIST_FAILED",
        message: res.error ?? `HTTP ${res.status}`,
      });
    }
    if (!res.data) {
      throw new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: "Agent API threadList returned an empty response body",
      });
    }

    writeText(ctx.io, formatThreadList(res.data.threads), NL);
  },
);

export function registerThreadListCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, threadListCommand, runtimeOptions);
}
