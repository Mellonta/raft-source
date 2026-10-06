// `raft inbox check [--view unread|mentions] [--before <seq>]`
// -> GET /internal/agent-api/inbox/conversations (durable unread list, server)
// -> GET /internal/agent-api/inbox (managed runners: daemon pending snapshot)
//
// The agent's Activity panel: one entry point, no required flags. Every row
// carries its `open:` command; the output ends with exactly one `Next:` line.

import type { Command } from "commander";
import { AGENT_API_INBOX_VIEWS, currentTimeMs, type AgentApiInboxView, type AgentInboxSourceSeal } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText, NL } from "../../core/renderer";
import { createDaemonApiSurfaceClient } from "../../daemonApiPath";
import { apiFailureError } from "../_apiFailure";
import {
  formatInboxCheck,
  type InboxAppItem,
  type InboxTargetRow,
} from "./_format";

interface InboxCheckOpts {
  view?: string;
  before?: string;
}

const INBOX_UNAVAILABLE_NEXT_ACTION = "Retry in a moment; to drain new messages now use raft message check.";

function parseView(raw: string | undefined): AgentApiInboxView {
  if (raw === undefined) return "unread";
  const view = raw.trim();
  if ((AGENT_API_INBOX_VIEWS as readonly string[]).includes(view)) return view as AgentApiInboxView;
  throw new CliError({
    code: "INVALID_ARG",
    message: `--view must be one of ${AGENT_API_INBOX_VIEWS.join(", ")}; got ${raw}`,
  });
}

function parseBefore(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `--before must be a positive integer seq (copy it from the More: line); got ${raw}`,
    });
  }
  return Number(value);
}

type DaemonSnapshot = {
  rows: InboxTargetRow[];
  appItems: InboxAppItem[];
  seals: AgentInboxSourceSeal[];
};

export const inboxCheckCommand = defineCommand(
  {
    name: "check",
    description: "List your unread conversations, newest activity first, each with the command that opens it (no flags needed).",
    options: [
      { flags: "--view <view>", description: "unread (default) or mentions" },
      { flags: "--before <seq>", description: "Next page: the seq printed on the More: line" },
    ],
  },
  async (ctx, opts: InboxCheckOpts = {}) => {
    const view = parseView(opts.view);
    const before = parseBefore(opts.before);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const managed = agentContext.clientMode === "managed-runner";

    const [listRes, daemonRes] = await Promise.all([
      createAgentApiSurfaceClient(client).inbox.list({
        ...(view !== "unread" ? { view } : {}),
        ...(before !== undefined ? { before_seq: String(before) } : {}),
      }),
      managed ? createDaemonApiSurfaceClient(client).inbox.check() : Promise.resolve(null),
    ]);

    if (!listRes.ok) {
      if (listRes.status === 503 && listRes.errorCode === "INBOX_UNAVAILABLE") {
        throw new CliError({
          code: "INBOX_UNAVAILABLE",
          message: listRes.error ?? "Inbox is temporarily unavailable",
          suggestedNextAction: INBOX_UNAVAILABLE_NEXT_ACTION,
        });
      }
      throw apiFailureError(listRes, "INBOX_CHECK_FAILED");
    }
    if (!listRes.data) {
      throw new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: "Agent API inboxList returned an empty response body",
      });
    }

    let daemon: DaemonSnapshot | null = null;
    let daemonError: string | undefined;
    if (daemonRes) {
      if (daemonRes.ok) {
        type InboxItemWire = { source: string } & Partial<InboxAppItem>;
        const data = daemonRes.data as { rows?: InboxTargetRow[]; items?: InboxItemWire[]; seals?: AgentInboxSourceSeal[] } | null | undefined;
        daemon = {
          rows: data?.rows ?? [],
          appItems: (data?.items ?? []).filter((item): item is InboxAppItem => item.source === "app"),
          seals: data?.seals ?? [],
        };
      } else {
        daemonError = daemonRes.error ?? `HTTP ${daemonRes.status}`;
      }
    }

    writeText(ctx.io, formatInboxCheck({
      view,
      ...(before !== undefined ? { before } : {}),
      list: listRes.data,
      ...(daemon ? { pendingRows: daemon.rows, appItems: daemon.appItems, seals: daemon.seals } : {}),
      ...(daemonError ? { daemonError } : {}),
      ...(managed ? {} : { appItemsUnavailable: true }),
      nowMs: currentTimeMs(),
    }), NL);
  },
);

export function registerInboxCheckCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, inboxCheckCommand, runtimeOptions);
}
