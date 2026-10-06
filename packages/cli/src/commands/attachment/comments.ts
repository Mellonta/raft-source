// `raft attachment comments --id <attachmentId>`
// → GET /internal/agent-api/attachments/:id/comments
//
// Lists the comments SCOPED to one attachment (the ref-filtered subset of its
// parent message's thread). General thread replies are not included — read
// the thread itself for the full conversation. Requires the "read" capability.

import type { Command } from "commander";

import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText } from "../../core/renderer";
import { formatAttachmentComments } from "./_format";
import { createAgentApiSurfaceClient } from "../../agentApiPath";

interface CommentsOpts {
  id: string;
  limit?: string;
}

export const attachmentCommentsCommand = defineCommand(
  {
    name: "comments",
    description: "List comments scoped to an attachment",
    options: [
      { flags: "--id <attachmentId>", description: "Attachment UUID" },
      { flags: "--limit <n>", description: "Max comments to return (default 200)" },
    ],
  },
  async (ctx, opts: Partial<CommentsOpts>) => {
    const id = opts.id?.trim();
    if (!id) {
      throw new CliError({ code: "INVALID_ARG", message: "--id is required" });
    }
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const agentApi = createAgentApiSurfaceClient(client);
    const limit = opts.limit && Number.isFinite(Number(opts.limit)) ? String(Number(opts.limit)) : undefined;
    const res = await agentApi.attachments.comments({ attachmentId: id }, limit ? { limit } : {});
    if (!res.ok || !res.data) {
      const code = res.status >= 500 ? ("SERVER_5XX" as const) : ("COMMENTS_FAILED" as const);
      throw new CliError({ code, message: res.error ?? `HTTP ${res.status}` });
    }

    const { comments, threadChannelId } = res.data;
    writeText(ctx.io, formatAttachmentComments(id, comments, threadChannelId));
  },
);

export function registerAttachmentCommentsCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, attachmentCommentsCommand, runtimeOptions);
}
