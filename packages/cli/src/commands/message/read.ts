// `raft message read --target <t> [--unread | --before <id|seq> | --after <id|seq> | --around <id|seq>] [--limit N]`
// → GET /internal/agent-api/history
//
// The history anchors accept either a message id (full or short) or a
// numeric seq. `--before` / `--after` exclude the anchor; `--around` includes it.
// `--unread` starts right after the agent's read position instead of an anchor.

import type { Command } from "commander";

import type { ApiProxyDiagnostics } from "../../client";
import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText, adoptCliReplyText } from "../../core/renderer";
import { apiFailureError } from "../_apiFailure";
import { PEER_KIND_OPTION, requireTargetAlias, type TargetAliasOpts } from "../_target";
import { formatHistory } from "./_format";
import { getConsumedExactSeqs, getConsumedSeq, recordHistoryReadWindow } from "./_consumedSeqState";

interface ReadOpts extends TargetAliasOpts {
  before?: string;
  after?: string;
  around?: string;
  limit?: string;
  unread?: boolean;
}

function parsePositiveInt(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `--${name} must be a positive integer; got ${raw}`,
    });
  }
  return n;
}

function mapReadFailure(res: {
  status: number;
  error: string | null;
  errorCode?: string | null;
  suggestedNextAction?: string | null;
  proxy?: ApiProxyDiagnostics | null;
}): CliError {
  if (res.errorCode === "NOT_FOUND") {
    return new CliError({
      code: "NOT_FOUND",
      message: res.error ?? `HTTP ${res.status}`,
      suggestedNextAction: res.suggestedNextAction ?? undefined,
    });
  }
  if (res.errorCode === "AMBIGUOUS_ID") {
    return new CliError({
      code: "AMBIGUOUS_ID",
      message: res.error ?? `HTTP ${res.status}`,
      suggestedNextAction: res.suggestedNextAction ?? "Use the full message UUID instead of the 8-character short id.",
    });
  }
  if (res.errorCode === "INVALID_ARG") {
    return new CliError({
      code: "INVALID_ARG",
      message: res.error ?? `HTTP ${res.status}`,
    });
  }
  return apiFailureError(res, "READ_FAILED");
}

function validateReadOpts(opts: Partial<ReadOpts>): {
  channel: string;
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
  unread?: true;
} {
  const channel = requireTargetAlias(opts);
  const limit = parsePositiveInt("limit", opts.limit);
  const before = opts.before?.trim();
  const after = opts.after?.trim();
  if (opts.unread && (before || after || opts.around !== undefined)) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "--unread cannot be combined with --before, --after, or --around: it always starts right after your read position.",
      suggestedNextAction: `raft message read --target "${channel}" --unread`,
    });
  }
  return {
    channel,
    ...(opts.unread ? { unread: true as const } : {}),
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    ...(opts.around !== undefined ? { around: opts.around } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function alreadyShownIn(agentId: string, target: string, messages: ReadonlyArray<{ seq?: unknown }>): Set<number> {
  const upTo = getConsumedSeq(agentId, target) ?? 0;
  const exact = new Set(getConsumedExactSeqs(agentId, target));
  const shown = new Set<number>();
  for (const message of messages) {
    if (typeof message.seq === "number" && (message.seq <= upTo || exact.has(message.seq))) shown.add(message.seq);
  }
  return shown;
}

export const messageReadCommand = defineCommand(
  {
    name: "read",
    description: "Read message history for a channel, DM, or thread",
    options: [
      { flags: "--target <target>", description: "Target: '#channel', 'dm:@peer', '#channel:threadId', 'dm:@peer:threadId', 'agent-event:eventId'" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      PEER_KIND_OPTION,
      { flags: "--before <idOrSeq>", description: "Return messages strictly before this anchor (pure-decimal values are seqs)" },
      { flags: "--after <idOrSeq>", description: "Return messages strictly after this anchor (pure-decimal values are seqs)" },
      { flags: "--around <idOrSeq>", description: "Center the window on this anchor (8-character values are short ids)" },
      { flags: "--unread", description: "Read this target's unread messages: start right after your read position and move it forward" },
      { flags: "--limit <n>", description: "Max messages to return (server default applies if omitted)" },
    ],
  },
  async (ctx, opts: Partial<ReadOpts>) => {
    const readOpts = validateReadOpts(opts);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const agentApi = createAgentApiSurfaceClient(client);
    const res = await agentApi.history.read({
      channel: readOpts.channel,
      ...(readOpts.before !== undefined ? { before: readOpts.before } : {}),
      ...(readOpts.after !== undefined ? { after: readOpts.after } : {}),
      ...(readOpts.around !== undefined ? { around: readOpts.around } : {}),
      ...(readOpts.limit !== undefined ? { limit: String(readOpts.limit) } : {}),
      ...(readOpts.unread ? { unread: "true" as const } : {}),
    });
    if (!res.ok) {
      throw mapReadFailure(res);
    }
    if (!res.data) {
      throw new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: "Agent API historyRead returned an empty response body",
      });
    }
    // A Server that does not know `unread` ignores it and returns the latest
    // page; printing that as "unread" would be wrong without anyone noticing.
    if (readOpts.unread && typeof res.data.unread_after_seq !== "number") {
      throw new CliError({
        code: "UNSUPPORTED_BY_SERVER",
        message: "This Server does not support --unread yet, so the page it returned was discarded instead of being shown as unread.",
        suggestedNextAction: "raft inbox check (each row prints the read command for that conversation)",
      });
    }
    // `--unread` folds messages this agent was already shown (recorded locally,
    // per model context) so a message that came back unsettled is not read as new.
    const alreadyShownSeqs = readOpts.unread
      ? alreadyShownIn(agentContext.agentId, typeof res.data.target === "string" && res.data.target ? res.data.target : readOpts.channel, res.data.messages ?? [])
      : undefined;
    writeText(
      ctx.io, adoptCliReplyText(
      `${formatHistory(readOpts.channel, res.data, {
        around: readOpts.around,
        after: readOpts.after,
        before: readOpts.before,
        unread: readOpts.unread === true,
        ...(alreadyShownSeqs ? { alreadyShownSeqs } : {}),
      })}\n`,
    ));
    // What the window consumed (the FH-001 full-body advance contract: target
    // identity from the resolver, `--around` and gapped windows record exact
    // seqs only, old-server boundary inference) is the shared seen policy
    // (shared/src/agentOps/seenPolicy/historyRead.ts).
    recordHistoryReadWindow(agentContext.agentId, {
      requestedTarget: readOpts.channel,
      ...(readOpts.around !== undefined ? { around: readOpts.around } : {}),
      ...(readOpts.after !== undefined ? { after: readOpts.after } : {}),
      ...(readOpts.unread && typeof res.data.unread_after_seq === "number" ? { after: String(res.data.unread_after_seq) } : {}),
      data: res.data,
    });
  },
);

export function registerReadCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, messageReadCommand, runtimeOptions);
}
