// `raft mention pending [--json]`
// → GET /internal/agent-api/mention-actions/pending

import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { cliError } from "../../core/errors";
import { writeJson, writeText } from "../../core/renderer";
import { MENTION_PENDING_MAX_LIMIT, formatPendingMentionActions, normalizePendingMentionActions } from "./_format";

interface PendingOpts {
  json?: boolean;
  limit?: string;
}

// Validated here rather than left to the server, in BOTH directions, because the route reinterprets
// both ends silently: `Number(query.limit) || 50` turns `abc`/`0` into the DEFAULT, and
// `Math.min(..., MENTION_PENDING_MAX_LIMIT)` clamps `500` down to 100. Either way the page you get
// is not the page you asked for and nothing says so -- and the second case additionally makes this
// command's own verdict lie, since it would report `--limit 500` beside 100 rows.
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw cliError("INVALID_ARG", `--limit must be a positive integer; got ${raw}`);
  }
  if (limit > MENTION_PENDING_MAX_LIMIT) {
    throw cliError(
      "INVALID_ARG",
      `--limit must be at most ${MENTION_PENDING_MAX_LIMIT} (the server clamps higher values and would return `
      + `${MENTION_PENDING_MAX_LIMIT} rows while this command reported your ${limit}); got ${raw}`,
    );
  }
  return limit;
}

export const mentionPendingCommand = defineCommand(
  {
    name: "pending",
    description: "List sender-side pending mention actions",
    options: [
      { flags: "--json", description: "Emit machine-readable JSON" },
      { flags: "--limit <n>", description: "Rows to request (server default 50, server caps at 100)" },
    ],
  },
  async (ctx, opts: PendingOpts = {}) => {
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const limit = parseLimit(opts.limit);
    const res = await createAgentApiSurfaceClient(client).mentions.pendingActions(
      limit === undefined ? undefined : { limit: String(limit) },
    );
    if (!res.ok || !res.data) {
      throw cliError(res.status >= 500 ? "SERVER_5XX" : "MENTION_PENDING_FAILED", res.error ?? `HTTP ${res.status}`);
    }

    const actions = normalizePendingMentionActions(res.data);
    // `has_more` is read straight off the response, not recomputed: the server over-fetches by one
    // to decide it, which the CLI cannot see. `undefined` is carried through as a third state --
    // see the note on the formatter's `hasMore` option.
    const hasMore = (res.data as { has_more?: unknown }).has_more;
    const truncated = typeof hasMore === "boolean" ? hasMore : undefined;
    if (opts.json) {
      writeJson(ctx.io, {
        ok: true,
        pendingMentionActions: actions,
        // Explicit `null` rather than an omitted key, so the unknown state is VISIBLE on
        // inspection and testable as `=== null`.
        // ⚠️ It does NOT rescue `if (!out.truncated)` — `!null` is `true` in JS, so a falsy
        // test still collapses unknown into "nothing more". There is no serialisation of a
        // third state that a two-way falsy check can survive; the consumer must branch on all
        // three (`=== true` / `=== false` / `=== null`). Said here rather than implied,
        // because the earlier version of this comment claimed a protection it does not give.
        truncated: truncated ?? null,
        limit: limit ?? null,
      });
      return;
    }

    writeText(ctx.io, formatPendingMentionActions(actions, { source: "pending", hasMore: truncated, limit }));
  },
);

export function registerMentionPendingCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, mentionPendingCommand, runtimeOptions);
}
