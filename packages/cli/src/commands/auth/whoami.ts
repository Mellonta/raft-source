// `raft auth whoami` — print the agent context resolved from env, then confirm
// it with the server (`GET /internal/agent-api/context`).
//
// The local part (client mode, secret source, profile) is what the CLI will
// act as; the server part is who that credential actually is. If the server
// cannot be reached the local part is still printed, marked unconfirmed, and
// the command fails — it never passes off local state as confirmed identity.
// Token values are never echoed.
//
// `--prompt` prints only the operating guide the server renders for an
// external agent (the self-hosted counterpart of a managed agent's standing
// system prompt).

import type { Command } from "commander";
import type { AgentApiAgentContextResponse } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { apiFailureError } from "../../core/apiFailure";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { NL, writeJson, writeText } from "../../core/renderer";
import { formatAgentContextPrompt } from "./_format";

interface WhoamiOpts {
  prompt?: boolean;
}

const UNCONFIRMED_NEXT_ACTION = "Check network access to the server and that the credential is still valid, then rerun raft auth whoami.";

function unconfirmedError(failure: CliError | null): CliError {
  return new CliError({
    code: failure?.code ?? "WHOAMI_FAILED",
    message: `Could not confirm identity with the server: ${failure?.message ?? "no response"}. Any local context printed is unconfirmed.`,
    suggestedNextAction: failure?.suggestedNextAction ?? UNCONFIRMED_NEXT_ACTION,
    ...(failure ? { cause: failure } : {}),
  });
}

export const whoamiCommand = defineCommand(
  {
    name: "whoami",
    description: "Print the agent context resolved from env (token value redacted) and the identity the server confirms for it",
    options: [
      { flags: "--prompt", description: "Print only the operating guide the server renders for this external agent" },
    ],
  },
  async (ctx, opts: WhoamiOpts = {}) => {
    const agentContext = ctx.loadAgentContext();
    const local = {
      agentId: agentContext.agentId,
      serverUrl: agentContext.serverUrl,
      serverId: agentContext.serverId,
      clientMode: agentContext.clientMode,
      secretSource: agentContext.secretSource,
      ...(agentContext.profileSlug ? { profileSlug: agentContext.profileSlug } : {}),
      ...(agentContext.profileCredentialPath ? { profileCredentialPath: agentContext.profileCredentialPath } : {}),
    };

    // Transport failures throw (network, local proxy); HTTP failures return.
    // Both end as one CliError so whoami never falls back silently.
    let confirmed: AgentApiAgentContextResponse | null = null;
    let failure: CliError | null = null;
    try {
      const res = await createAgentApiSurfaceClient(ctx.createApiClient(agentContext)).agent.context();
      if (res.ok && res.data) confirmed = res.data;
      else failure = apiFailureError(res, "WHOAMI_FAILED");
    } catch (err) {
      failure = err instanceof CliError
        ? err
        : new CliError({ code: "WHOAMI_FAILED", message: err instanceof Error ? err.message : String(err), cause: err });
    }

    if (opts.prompt) {
      if (!confirmed) throw unconfirmedError(failure);
      if (!confirmed.prompt) {
        throw new CliError({
          code: "PROMPT_UNAVAILABLE",
          message: "This is a managed agent: its prompt comes from the Raft daemon that runs it. The server renders a prompt only for external agents.",
        });
      }
      writeText(ctx.io, formatAgentContextPrompt(confirmed.prompt.text), NL);
      return;
    }

    if (!confirmed) {
      writeJson(ctx.io, { ok: false, data: { ...local, serverConfirmed: false } });
      throw unconfirmedError(failure);
    }
    if (agentContext.agentId && agentContext.agentId !== confirmed.agent.id) {
      writeJson(ctx.io, { ok: false, data: { ...local, serverConfirmed: false } });
      throw new CliError({
        code: "IDENTITY_MISMATCH",
        message: `The server says this credential belongs to agent ${confirmed.agent.id}, not the locally configured ${agentContext.agentId}.`,
      });
    }

    writeJson(ctx.io, {
      ok: true,
      data: {
        ...local,
        serverConfirmed: true,
        agent: confirmed.agent,
        server: confirmed.server,
        capabilities: confirmed.credential.capabilities,
      },
    });
  },
);

export function registerWhoamiCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, whoamiCommand, runtimeOptions);
}
