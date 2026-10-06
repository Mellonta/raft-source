import type { AgentInboxAppItem, AgentInboxSourceSeal } from "@botiverse/raft-shared";

import { createDaemonApiSurfaceClient } from "../../daemonApiPath";
import type { CommandContext } from "../../core/context";
import { cliError } from "../../core/errors";
import { NL, writeDiagnostic } from "../../core/renderer";
import { formatReminderSealsUnchecked } from "../../commands/reminder/_format";

const REMINDER_INBOX_APP_ID = "system.reminder";
const REMINDER_DUE_NOTIFICATION_CLASS = "due";

export function isReminderDueItem(item: AgentInboxAppItem): boolean {
  return item.appId === REMINDER_INBOX_APP_ID
    && item.notificationClass === REMINDER_DUE_NOTIFICATION_CLASS
    && item.sourceRef.kind === "reminder"
    && item.sourceRef.revision !== undefined;
}

export function matchesReminderId(sourceId: string, query: string): boolean {
  return sourceId === query || sourceId.startsWith(query) || `reminder:${sourceId}` === query;
}

export async function readLocalReminderState(ctx: CommandContext): Promise<{
  items: AgentInboxAppItem[];
  seals: AgentInboxSourceSeal[];
}> {
  const agentContext = ctx.loadAgentContext();
  if (agentContext.clientMode !== "managed-runner") {
    throw cliError("INVALID_SCOPE", "Reminder Inbox seals are only available in managed runners");
  }
  const snapshot = await createDaemonApiSurfaceClient(ctx.createApiClient(agentContext)).inbox.check();
  if (!snapshot.ok) {
    throw cliError(
      snapshot.status >= 500 ? "SERVER_5XX" : "CHECK_FAILED",
      snapshot.error ?? `HTTP ${snapshot.status}`,
    );
  }
  const items = (snapshot.data?.items ?? []) as Array<AgentInboxAppItem | { source: "message_target"; row: unknown }>;
  const seals = (snapshot.data?.seals ?? []) as AgentInboxSourceSeal[];
  return {
    items: items.filter((item): item is AgentInboxAppItem => item.source === "app" && isReminderDueItem(item)),
    seals: seals.filter((seal) =>
      seal.appId === REMINDER_INBOX_APP_ID
      && seal.notificationClass === REMINDER_DUE_NOTIFICATION_CLASS
      && seal.sourceRef.kind === "reminder"
    ),
  };
}

export async function readLocalReminderItems(ctx: CommandContext): Promise<AgentInboxAppItem[]> {
  return (await readLocalReminderState(ctx)).items;
}

/** Fail closed before any Server reminder mutation when this seat has a matching seal. */
export async function assertReminderNotSealed(
  ctx: CommandContext,
  reminderIdQuery: string,
  operation: string,
): Promise<void> {
  const agentContext = ctx.loadAgentContext();
  if (agentContext.clientMode !== "managed-runner") {
    // Seals live in a daemon's inbox; an external agent has none. Say so on
    // stderr (stdout stays the command's result) instead of passing silently.
    writeDiagnostic(ctx.io, formatReminderSealsUnchecked(), NL);
    return;
  }
  const snapshot = await createDaemonApiSurfaceClient(ctx.createApiClient(agentContext)).inbox.check();
  if (!snapshot.ok) {
    throw cliError(
      snapshot.status >= 500 ? "SERVER_5XX" : "CHECK_FAILED",
      `Cannot verify local reminder seals before ${operation}: ${snapshot.error ?? `HTTP ${snapshot.status}`}`,
    );
  }
  const seals = (snapshot.data?.seals ?? []) as AgentInboxSourceSeal[];
  const sealed = seals.find((seal) =>
    seal.appId === REMINDER_INBOX_APP_ID
    && seal.notificationClass === REMINDER_DUE_NOTIFICATION_CLASS
    && seal.sourceRef.kind === "reminder"
    && matchesReminderId(seal.sourceRef.id, reminderIdQuery),
  );
  if (sealed) {
    const revision = sealed.sourceRef.revision === undefined
      ? "(id-only)"
      : `revision ${sealed.sourceRef.revision}`;
    throw cliError(
      "UPDATE_FAILED",
      `Reminder ${sealed.sourceRef.id} ${revision} is sealed by ${sealed.owner} until ${sealed.until}; run raft reminder unseal explicitly first`,
    );
  }
}
