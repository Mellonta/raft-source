import type { Request } from "express";

import type { DatabaseExecutor } from "../../db/index";
import type { AgentOrchestrator } from "../../services/agentOrchestrator";
import * as reminderCrud from "./crud";
import { publishReminderEvent } from "./realtime";
import * as reminderService from "./service";

type CreateTaskResourceExpiryInput = {
  id: string;
  serverId: string;
  ownerAgentId: string;
  targetChannelId: string;
  msgId: string;
  title: string;
  fireAt: Date;
  payload: unknown;
  createdBy: { type: "agent" | "human"; id: string };
};

export function createTaskResourceExpiryFollowup(
  input: CreateTaskResourceExpiryInput,
  executor: DatabaseExecutor,
): Promise<reminderService.ReminderRow> {
  return reminderCrud.createAppReminder(input, { executor });
}

export function getTaskResourceExpiryFollowup(
  id: string,
  executor: DatabaseExecutor,
): Promise<reminderService.ReminderRow | null> {
  return reminderCrud.getAppReminderById(id, { executor });
}

export async function publishTaskResourceExpiryFollowup(
  req: Request,
  followupId: string,
  serverId: string,
  emitScheduled: boolean,
): Promise<void> {
  const row = await reminderCrud.getAppReminderById(followupId);
  if (!row) {
    console.warn(`[reminder] Task resource expiry follow-up ${followupId} is missing after commit`);
    return;
  }
  const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
  if (orchestrator) {
    try {
      await orchestrator.pushReminderUpsert(row.ownerAgentId, row);
    } catch (error) {
      console.warn(`[reminder] Computer sync failed for ${row.id}@${row.version}:`, error);
    }
  }

  if (!emitScheduled) return;
  const [summary] = await reminderService.toReminderSummaries([row], serverId);
  await publishReminderEvent(req.app.get("io"), row, { type: "reminder:scheduled", reminder: summary });
}
