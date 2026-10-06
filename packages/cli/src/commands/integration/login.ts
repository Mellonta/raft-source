// `raft integration login --service <service>` — provision/reuse Raft Agent Login.

import type { Command } from "commander";

import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { cliError } from "../../core/errors";
import { writeJson, writeText, NL } from "../../core/renderer";
import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { formatIntegrationLogin, type IntegrationLoginResponse, type IntegrationLoginOutput } from "./_format";
import { ensureIntegrationServiceSession } from "./_session";

interface LoginOptions {
  service: string;
  scope?: string[];
  target?: string;
  json?: boolean;
}

function normalizeScopes(raw: string[] | undefined): string[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const scopes = Array.from(new Set(
    raw.flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean),
  )).sort();
  if (scopes.length === 0) {
    throw cliError("INVALID_ARG", "--scope must include at least one non-empty scope");
  }
  return scopes;
}

function redactSuccessfulRequestId(data: IntegrationLoginOutput): IntegrationLoginOutput {
  if (data.status === "approval_required" || data.status === "install_required") return data;
  const { requestId: _requestId, ...rest } = data;
  return rest;
}

export const integrationLoginCommand = defineCommand(
  {
    name: "login",
    description: "Provision or reuse a Raft grant and store callback cookies; application authentication remains unverified",
    options: [
      { flags: "--service <id>", description: "Registered service id, client id, or exact service name" },
      {
        flags: "--scope <scope>",
        description: "Requested scope; can be repeated or comma-separated",
        parse: (value, previous: string[] = []) => {
          previous.push(value);
          return previous;
        },
      },
      { flags: "--target <target>", description: "Conversation target to post a human approval card when approval is required" },
      { flags: "--json", description: "Emit machine-readable JSON" },
    ],
  },
  async (ctx, opts: LoginOptions) => {
    const service = opts.service?.trim() ?? "";
    if (!service) {
      throw cliError("INVALID_ARG", "--service is required");
    }
    const scopes = normalizeScopes(opts.scope);

    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const res = await createAgentApiSurfaceClient(client).integrations.login({
      service,
      scopes,
      target: opts.target?.trim() || undefined,
    });
    if (!res.ok || !res.data) {
      const code = res.errorCode
        ?? (res.status >= 500 ? "SERVER_5XX" : "INTEGRATION_LOGIN_FAILED");
      throw cliError(code, res.error ?? `HTTP ${res.status}`);
    }

    let data: IntegrationLoginResponse = res.data;
    if (data.status !== "approval_required" && data.status !== "install_required" && data.service.returnUrl) {
      const session = await ensureIntegrationServiceSession({
        login: data,
        service: data.service,
        agentContext,
        env: ctx.env,
        refresh: true,
      });
      data = {
        ...data,
        session: {
          status: "stored",
          authentication: "unverified",
          source: session.source,
          path: session.sessionPath,
        },
      };
    }

    const outputData = redactSuccessfulRequestId({
      ...data,
      status: data.status === "logged_in" || data.status === "already_logged_in"
        ? "grant_active"
        : data.status,
    });
    if (opts.json) {
      writeJson(ctx.io, { ok: true, data: outputData });
      return;
    }

    writeText(ctx.io, formatIntegrationLogin(outputData), NL);
  },
);

export function registerIntegrationLoginCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, integrationLoginCommand, runtimeOptions);
}
