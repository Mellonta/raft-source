// `raft manual search <keywords>` — GET /internal/agent-api/knowledge/search?query=...

import type { Command } from "commander";

import { formatAgentKnowledgeSearchResults } from "@botiverse/raft-shared";
import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError, type CliErrorCode } from "../../core/errors";
import { writeText, adoptCliReplyText } from "../../core/renderer";
import { formatManualIndexCommand, requireKnowledgeContexts } from "./context";

export interface KnowledgeSearchOptions {
  scope?: string;
  intent?: string;
  reason?: string;
  turnId?: string;
  traceId?: string;
}

export interface KnowledgeSearchResultForFormat {
  slug: string;
  title: string;
  firstScreen: string;
  /** Why this result matched. Absent on responses from older servers. */
  matchedTerms?: string[];
  correctedTerms?: Array<{ term: string; matched: string }>;
  expandedTerms?: Array<{ from: string; to: string }>;
}

export function formatKnowledgeSearchResults(results: KnowledgeSearchResultForFormat[]): string {
  return formatAgentKnowledgeSearchResults(results);
}

function toKnowledgeSearchErrorCode(errorCode: string | null | undefined, status: number): CliErrorCode {
  switch (errorCode) {
    case "INVALID_JSON_RESPONSE":
    case "SCOPE_DENIED":
    case "knowledge_agent_missing":
    case "knowledge_internal_error":
    case "knowledge_intent_invalid":
    case "knowledge_language_unsupported":
    case "knowledge_not_found":
    case "knowledge_query_invalid":
    case "knowledge_reason_invalid":
    case "knowledge_scope_invalid":
    case "knowledge_source_invalid":
    case "knowledge_trace_id_invalid":
    case "knowledge_turn_id_invalid":
    case "unsupported_capability":
      return errorCode;
    default:
      return status >= 500 ? "SERVER_5XX" : "KNOWLEDGE_SEARCH_FAILED";
  }
}

export const knowledgeSearchCommand = defineCommand(
  {
    name: "search",
    description: "Search Raft Manual for Agents topics from the current server",
    arguments: ["<keywords>"],
    options: [
      {
        flags: "--scope <scope>",
        description: "Optional search scope. Currently supports: recipes",
      },
      {
        flags: "--intent <text>",
        description: "Required: what the user ultimately wants to accomplish with Raft (12-500 chars)",
      },
      {
        flags: "--reason <text>",
        description: "Required: why Manual is needed at this point (12-500 chars)",
      },
      {
        flags: "--turn-id <id>",
        description: "Diagnostic: override the turn id recorded on the knowledge event",
        hidden: true,
      },
      {
        flags: "--trace-id <id>",
        description: "Diagnostic: override the trace id recorded on the knowledge event",
        hidden: true,
      },
    ],
    helpAfter:
      "\nExamples:\n"
      + "  raft manual search \"preview before merge\" --scope recipes --intent \"Safely preview a change before merge\" --reason \"Need the recommended preview workflow now\"\n"
      + "  raft manual get recipes/technique/preview-env --intent \"Safely preview a change before merge\" --reason \"Need exact preview setup steps now\"\n",
  },
  async (ctx, keywords: string, opts: KnowledgeSearchOptions) => {
    const { intent, reason } = requireKnowledgeContexts(opts.intent, opts.reason);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const res = await createAgentApiSurfaceClient(client).knowledge.search({
      query: keywords,
      scope: opts.scope,
      intent,
      reason,
      turn_id: opts.turnId,
      trace_id: opts.traceId,
    });
    if (!res.ok) {
      throw new CliError({
        code: toKnowledgeSearchErrorCode(res.errorCode, res.status),
        message: res.error ?? `HTTP ${res.status}`,
        suggestedNextAction: res.suggestedNextAction ??
          (res.errorCode === "knowledge_not_found"
            ? `Retry with different keywords, keeping your --intent/--reason. To browse all topics, run:\n${formatManualIndexCommand()}`
            : undefined),
      });
    }
    const data = res.data;
    if (!data || data.ok !== true || !Array.isArray(data.results)) {
      throw new CliError({
        code: "KNOWLEDGE_SEARCH_FAILED",
        message: "Server returned an unexpected response shape",
      });
    }
    writeText(ctx.io, adoptCliReplyText(formatKnowledgeSearchResults(data.results)));
  },
);

export function registerKnowledgeSearchCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, knowledgeSearchCommand, runtimeOptions);
}
