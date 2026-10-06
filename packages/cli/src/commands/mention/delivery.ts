// `raft mention delivery --message <id> [--json]`
// → GET /internal/agent-api/messages/:messageId/mention-deliveries

import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { cliError } from "../../core/errors";
import { writeJson, writeText } from "../../core/renderer";
import { formatSenderMentionDeliveries, type SenderMentionDeliveryRow } from "./_format";

interface DeliveryOpts {
  message?: string;
  json?: boolean;
}

export const mentionDeliveryCommand = defineCommand(
  {
    name: "delivery",
    description: "Show per-target delivery outcome for a message you sent",
    options: [
      { flags: "--message <id>", description: "Message id you authored" },
      { flags: "--json", description: "Emit machine-readable JSON" },
    ],
  },
  async (ctx, opts: DeliveryOpts = {}) => {
    const messageId = (opts.message ?? "").trim();
    if (!messageId) {
      throw cliError("INVALID_ARG", "--message <id> is required");
    }
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const res = await createAgentApiSurfaceClient(client).mentions.senderDeliveries({ messageId });
    if (!res.ok || !res.data) {
      // 404 is deliberately indistinguishable from "not yours": the endpoint
      // must not answer "does that message exist?" for someone else's message.
      throw cliError(
        res.status >= 500 ? "SERVER_5XX" : "MENTION_DELIVERY_LOOKUP_FAILED",
        res.status === 404
          ? "No message you authored matches that id (a message you did not send looks the same here, by design)."
          : res.error ?? `HTTP ${res.status}`,
      );
    }

    const data = res.data as { messageId: string; deliveries: SenderMentionDeliveryRow[] };
    if (opts.json) {
      writeJson(ctx.io, { ok: true, messageId: data.messageId, deliveries: data.deliveries });
      return;
    }

    writeText(ctx.io, formatSenderMentionDeliveries(data.messageId, data.deliveries));
  },
);

export function registerMentionDeliveryCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, mentionDeliveryCommand, runtimeOptions);
}
