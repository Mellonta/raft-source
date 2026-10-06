// `raft message check` — non-blocking drain of /internal/agent-api/events.
//
// Non-blocking is a hard requirement (kuku redline): the CLI must return
// promptly with whatever is in the inbox, never hold the request open.
//
// Agent API /events consumes/acks returned messages server-side; the CLI does
// not perform a separate acknowledgement request.

import type { Command } from "commander";

import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText, adoptCliReplyText, flushText, NL } from "../../core/renderer";
import { createDaemonApiSurfaceClient } from "../../daemonApiPath";
import { drainInbox } from "./_inbox";
import { formatAppItemsUnavailable, formatInboxHint, formatMessages, formatTarget } from "./_format";
import { recordConsumedExactSeqs } from "./_consumedSeqState";

export const messageCheckCommand = defineCommand(
  {
    name: "check",
    description: "Drain the agent inbox (non-blocking). Acks delivered seqs before returning.",
  },
  async (ctx) => {
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const result = await drainInbox(
      agentContext,
      { block: false },
      client,
    );
    let appInboxStatus = "";
    if (agentContext.clientMode === "managed-runner" && result.messages.length === 0) {
      const response = await createDaemonApiSurfaceClient(client).inbox.check();
      if (!response.ok) {
        throw new CliError({
          code: response.status >= 500 ? "SERVER_5XX" : "CHECK_FAILED",
          message: response.error ?? `HTTP ${response.status}`,
        });
      }
      const pendingAppItems = response.data?.pending_app_items ?? 0;
      if (pendingAppItems > 0) {
        appInboxStatus = `\nApp items pending: ${pendingAppItems}. Run \`raft inbox check\` to inspect them.\n`;
      }
    } else if (agentContext.clientMode !== "managed-runner" && result.messages.length === 0) {
      appInboxStatus = `\n${formatAppItemsUnavailable()}\n`;
    }
    const drainStatus = result.hasMore
      ? "\nMore messages are pending. Run `raft message check` again.\n"
      : result.drainComplete
        ? "\nNo more new inbox messages.\n"
        : "\n";
    writeText(ctx.io, adoptCliReplyText(`${formatMessages(result.messages)}${drainStatus}${appInboxStatus}`));
    if (result.inboxHint) writeText(ctx.io, formatInboxHint(result.inboxHint), NL);
    // Task #178: ack leased third-party events only after their bodies reached
    // stdout. If the write or flush fails (EPIPE, closed pipe) nothing is
    // acked; the daemon lease expires and the events are served again on the
    // next check. An old daemon without the route answers non-2xx: ignored.
    const leases = result.thirdPartyLeases ?? [];
    if (leases.length > 0 && await flushText(ctx.io)) {
      const daemonApi = createDaemonApiSurfaceClient(client);
      for (const lease of leases) {
        try {
          await daemonApi.thirdPartyEvents.ack({ batchId: lease.batchId, eventIds: lease.eventIds });
        } catch {
          // Transport/proxy failure: same outcome as no ack, the lease expires.
        }
      }
    }
    // `/events` batches are sparse attention drains, not contiguous history
    // slices. Record exact target-scoped seqs rather than seeding
    // `seenUpToSeq`; the send gate can credit only these rendered bodies while
    // still holding for any older gap in the same target.
    const consumed: Record<string, number[]> = {};
    for (const message of result.messages as Array<{ seq?: number }>) {
      const seq = typeof message.seq === "number" && Number.isInteger(message.seq) && message.seq > 0
        ? message.seq
        : undefined;
      if (seq === undefined) continue;
      const target = formatTarget(message as never);
      (consumed[target] ??= []).push(seq);
    }
    recordConsumedExactSeqs(agentContext.agentId, consumed);
  },
);

export function registerCheckCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, messageCheckCommand, runtimeOptions);
}
