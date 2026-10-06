// Canonical task text for agent-facing output (moved verbatim from the CLI's
// commands/task/_format.ts; the CLI wraps these in its axSurface registrations
// and pins the bytes with its snapshot tests). The line format is an AX
// contract, not an implementation detail.

import { formatHint, RAFT_HINTS, type RaftHintStyle } from "../agentOps/hint";
import { formatUtcTimestamp } from "../utcTimestamp";

/** Mirrors `TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU` on the shared root index (kept local so this module stays bundle-light). */
export const AGENT_TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU = "already claimed by you";

export interface AgentTaskLike {
  taskNumber?: number;
  status?: string;
  title?: string;
  description?: string | null;
  revision?: number | null;
  claimedById?: string | null;
  claimedByName?: string | null;
  createdByName?: string | null;
  createdByMembershipStatus?: "active" | "left" | "removed" | null;
  messageId?: string | null;
  channelRef?: string;
  isLegacy?: boolean;
  requiresResourceReceipt?: boolean;
  resourceReceiptRecordedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  [key: string]: unknown;
}

export interface AgentTaskListData {
  tasks?: AgentTaskLike[];
  coverage?: {
    status?: string;
    visibleChannelTypes?: string[];
    includesArchived?: boolean;
    inaccessibleScope?: string;
    reason?: string;
  };
  pagination?: {
    mode?: string;
    truncated?: boolean;
  };
}

function taskTimestamps(t: AgentTaskLike): string {
  const created = t.createdAt ? ` created=${formatUtcTimestamp(t.createdAt)}` : "";
  const updated = t.updatedAt ? ` updated=${formatUtcTimestamp(t.updatedAt)}` : "";
  return `${created}${updated}`;
}

const TASK_STATUS_ORDER = ["todo", "in_progress", "in_review", "done", "closed"] as const;

function oneLineTaskTitle(title: string | undefined): string {
  return (title ?? "").replace(/\s+/g, " ").trim();
}

/** Channel task board listing. */
export function formatAgentTaskList(channel: string, data: AgentTaskListData, statusFilter?: string): string {
  if (!data.tasks || data.tasks.length === 0) {
    return (`No${statusFilter && statusFilter !== "all" ? ` ${statusFilter}` : ""} tasks in ${channel}.`);
  }

  const formatted = data.tasks
    .map((t) => {
      const assignee = t.claimedById
        ? ` → ${t.claimedByName ? `@${t.claimedByName}` : "<unresolved>"}`
        : "";
      const departedCreator = t.createdByMembershipStatus === "left"
        || t.createdByMembershipStatus === "removed";
      const creator = t.createdByName
        ? ` (by @${t.createdByName}${departedCreator ? " [departed]" : ""})`
        : "";
      const msgId = t.messageId ? ` msg=${t.messageId.slice(0, 8)}` : "";
      const revision = Number.isInteger(t.revision) ? ` rev=${t.revision}` : "";
      const legacy = t.isLegacy ? " [LEGACY — read-only]" : "";
      const resourceReceipt = t.requiresResourceReceipt
        ? ` resource-receipt=${t.resourceReceiptRecordedAt ? "recorded" : "pending"}`
        : "";
      const descriptionPrefix = "  Current description: ";
      const details = t.description
        ? `\n${descriptionPrefix}${t.description.replace(/\n/g, `\n${" ".repeat(descriptionPrefix.length)}`)}`
        : "";
      return `#${t.taskNumber} [${t.status}]${assignee}${creator}${msgId}${revision}${resourceReceipt}${taskTimestamps(t)}${legacy} Current title: ${oneLineTaskTitle(t.title)}${details}`;
    })
    .join("\n");

  return (`## Task Board for ${channel} (${data.tasks.length} tasks)\n\n${formatted}`);
}

/** Cross-channel --mine task listing with coverage notes. */
export function formatAgentMyTaskList(data: AgentTaskListData, statusFilter?: string): string {
  const tasks = data.tasks ?? [];
  const visibleTypes = data.coverage?.visibleChannelTypes?.join("|") ?? "unknown";
  const archived = data.coverage?.includesArchived ? "included" : "not included";
  const coverage = [
    `Coverage: ${data.coverage?.status ?? "unknown"}`,
    `visible types=${visibleTypes}`,
    `archived=${archived}`,
    `inaccessible scope=${data.coverage?.inaccessibleScope ?? "unknown"}`,
  ].join(" · ");
  const output = `Output: showing ${tasks.length} of ${tasks.length} visible matches · mode=${data.pagination?.mode ?? "unknown"} · truncated=${String(data.pagination?.truncated ?? "unknown")}`;
  const title = `## My assigned tasks on this server${statusFilter ? ` (status=${statusFilter})` : " (unfinished)"}`;

  if (tasks.length === 0) {
    return ([title, "", coverage, output, "", "No tasks matched in the covered visible scope."].join("\n"));
  }

  const grouped = new Map<string, AgentTaskLike[]>();
  for (const task of tasks) {
    const status = task.status ?? "unknown";
    const bucket = grouped.get(status) ?? [];
    bucket.push(task);
    grouped.set(status, bucket);
  }
  const statuses = [
    ...TASK_STATUS_ORDER.filter((status) => grouped.has(status)),
    ...[...grouped.keys()].filter((status) => !(TASK_STATUS_ORDER as readonly string[]).includes(status)).sort(),
  ];
  const sections = statuses.map((status) => {
    const rows = grouped.get(status)!;
    const rendered = rows.map((task) => {
      const channelRef = task.channelRef ?? "<unresolved-visible-target>";
      const taskNumber = task.taskNumber ?? "?";
      const departedCreator = task.createdByMembershipStatus === "left"
        || task.createdByMembershipStatus === "removed";
      const creator = task.createdByName
        ? ` by=@${task.createdByName}${departedCreator ? " creator=departed" : ""}`
        : "";
      const message = task.messageId ? ` msg=${task.messageId.slice(0, 8)}` : "";
      const legacy = task.isLegacy ? " legacy=read-only" : "";
      const resourceReceipt = task.requiresResourceReceipt
        ? ` resource-receipt=${task.resourceReceiptRecordedAt ? "recorded" : "pending"}`
        : "";
      return `- ${channelRef} task #${taskNumber} [${status}]${creator}${message}${resourceReceipt}${taskTimestamps(task)}${legacy} Current title: ${oneLineTaskTitle(task.title)}`.trimEnd();
    });
    return [`### ${status} (${rows.length})`, ...rendered].join("\n");
  });

  return ([title, "", coverage, output, "", ...sections].join("\n"));
}

export interface AgentCreatedTask {
  taskNumber: number;
  messageId: string;
  title: string;
  status: string;
  claimedByType: "user" | "agent" | null;
  claimedById: string | null;
  claimedByName?: string | null;
  claimedAt: string | null;
  requiresResourceReceipt?: boolean;
}

export interface AgentCreateTasksData {
  tasks: AgentCreatedTask[];
  assignmentReceipt?: {
    messageId: string;
    content: string;
    assignee: string;
    state: "started" | "assigned";
  };
}

/** Receipt for task create. */
export function formatAgentTasksCreated(channel: string, data: AgentCreateTasksData, style: RaftHintStyle = "cli"): string {
  const created = data.tasks
    .map((t) => {
      const assignee = t.claimedById
        ? (t.claimedByName ? `@${t.claimedByName}` : "<unresolved>")
        : "unassigned";
      const resourceReceipt = t.requiresResourceReceipt ? " resource-receipt=pending" : "";
      return `#${t.taskNumber} [${t.status}] assignee=${assignee} claimedAt=${t.claimedAt ?? "null"} msg=${t.messageId.slice(0, 8)}${resourceReceipt} "${t.title}"`;
    })
    .join("\n");

  const threadHints = data.tasks
    .map((t) => `#${t.taskNumber} → ${formatHint(RAFT_HINTS.messageSend({ target: `${channel}:${t.messageId.slice(0, 8)}` }), style)}`)
    .join("\n");

  const receipt = data.assignmentReceipt
    ? `\n\nAssignment receipt (msg=${data.assignmentReceipt.messageId.slice(0, 8)}):\n${data.assignmentReceipt.content}`
    : "";

  return (`Created ${data.tasks.length} task(s) in ${channel}:\n${created}${receipt}\n\nTo follow up in each task's thread:\n${threadHints}`);
}

export interface AgentClaimConflict {
  kind: "claim_conflict";
  conflictScope: "implementation_execution";
  blockedActions: string[];
  unblockedActionExamples: string[];
  currentAssignee: { type: "user" | "agent"; name: string | null } | null;
  taskStatus: string | null;
  claimedAt: string | null;
  observedAt: string;
}

export interface AgentClaimResult {
  taskNumber?: number;
  messageId?: string;
  success: boolean;
  reason?: string;
  conflict?: AgentClaimConflict;
}

const BLOCKED_ACTION_COPY: Record<string, string> = {
  start_conflicting_execution: "starting conflicting implementation/change work",
};

function formatClaimConflict(label: string, conflict: AgentClaimConflict): string {
  const holder = conflict.currentAssignee?.name
    ? `@${conflict.currentAssignee.name}`
    : "another actor";
  const blocked = conflict.blockedActions
    .map((action) => BLOCKED_ACTION_COPY[action] ?? action)
    .join("; ");
  const examples = conflict.unblockedActionExamples.join(" · ");
  return [
    `${label}: Claim failed — ${holder} currently holds the implementation lock (assignment state as of ${conflict.observedAt}).`,
    `  Blocked: ${blocked}.`,
    `  Not blocked by this claim conflict (each still subject to its own authority/policy): ${examples}.`,
    `  This is not a ruling on who owns or leads this lane. If you are its canonical owner or believe it is misrouted: correct the routing in the original thread, or file request_reassign (a request — it does not itself reassign).`,
  ].join("\n");
}

export interface AgentClaimTasksData {
  results: AgentClaimResult[];
}

export function canonicalAgentTaskTarget(target: string): string {
  return target.replace(/^dm:user:/i, "dm:@");
}

export function agentTaskThreadTarget(target: string, messageId: string): string {
  return `${canonicalAgentTaskTarget(target)}:${messageId.slice(0, 8)}`;
}

/** Claim results incl. concurrency-lock guidance on failed claims. */
export function formatAgentClaimResults(channel: string, data: AgentClaimTasksData, style: RaftHintStyle = "cli"): string {
  const lines = data.results.map((r) => {
    const label = r.taskNumber ? `#${r.taskNumber}` : `msg:${r.messageId}`;
    if (r.success) {
      const msgShort = r.messageId ? r.messageId.slice(0, 8) : "";
      return `${label} (msg:${msgShort}): claimed`;
    }
    if (r.reason === AGENT_TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU) {
      return `${label}: already claimed by you.`;
    }
    if (r.conflict?.kind === "claim_conflict") {
      return formatClaimConflict(label, r.conflict);
    }
    return `${label}: FAILED — ${r.reason || "already claimed"}. Do not start conflicting execution on this task or take over its scope without a redirect; a failed claim is a concurrency lock, not a ruling on lane ownership.`;
  });

  const succeeded = data.results.filter((r) => r.success).length;
  const failed = data.results.length - succeeded;
  let summary = `${succeeded} claimed`;
  if (failed > 0) summary += `, ${failed} failed`;

  const claimedMsgs = data.results
    .filter((r) => r.success && r.messageId)
    .map((r) => `#${r.taskNumber} → ${formatHint(RAFT_HINTS.messageSend({ target: agentTaskThreadTarget(channel, r.messageId!) }), style)}`)
    .join("\n");
  const threadHint = claimedMsgs
    ? `\n\nFollow up in each task's thread:\n${claimedMsgs}`
    : "";

  return (`Claim results (${summary}):\n${lines.join("\n")}${threadHint}`);
}

export function formatAgentTaskUnclaimed(taskNumber: number): string {
  return (`#${taskNumber} unclaimed — now open.`);
}

export function formatAgentTaskAssigned(taskNumber: number, assignee: string | null): string {
  return (assignee
    ? `#${taskNumber} assigned to ${assignee}.`
    : `#${taskNumber} unassigned — now open.`);
}

export function formatAgentTaskStatusUpdated(taskNumber: number, status: string): string {
  return (`#${taskNumber} moved to ${status}.`);
}

export function formatAgentTaskDeleted(taskNumber: number): string {
  return (`#${taskNumber} deleted.`);
}

/** Message→task conversion receipt. */
export function formatAgentTaskConverted(channel: string, task: AgentCreatedTask, style: RaftHintStyle = "cli"): string {
  const target = `${canonicalAgentTaskTarget(channel)}:${task.messageId.slice(0, 8)}`;
  return ([
    `Converted msg=${task.messageId.slice(0, 8)} to task #${task.taskNumber} [${task.status}] assignee=unassigned "${task.title}"`,
    "",
    `To follow up in the task's thread:`,
    formatHint(RAFT_HINTS.messageSend({ target }), style),
  ].join("\n"));
}

export interface AgentTaskAmendData {
  task: {
    taskNumber: number;
    title: string;
    description: string | null;
    revision: number;
  };
  event: {
    seq: number;
  };
}

export function formatAgentTaskAmended(data: AgentTaskAmendData): string {
  const details = data.task.description === null
    ? "details: <none>"
    : `details:\n${data.task.description.split("\n").map((line) => `  ${line}`).join("\n")}`;
  return ([
    `#${data.task.taskNumber} amended — revision ${data.task.revision}, event seq ${data.event.seq}.`,
    `title: ${data.task.title}`,
    details,
  ].join("\n"));
}

export interface AgentTaskHistoryData {
  task: {
    taskNumber: number;
    title: string;
    description: string | null;
    revision: number;
  };
  events: Array<{
    seq: number;
    eventType: string;
    actorType: "user" | "agent" | "system";
    actorName: string | null;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
}

export function formatAgentTaskHistory(data: AgentTaskHistoryData): string {
  const description = data.task.description === null
    ? "(none set)"
    : data.task.description.replace(/\n/g, `\n${" ".repeat("Current description: ".length)}`);
  const header = [
    `## Task #${data.task.taskNumber} history — revision ${data.task.revision}`,
    "",
    `Current title: ${data.task.title.replace(/\s+/g, " ").trim()}`,
    `Current description: ${description}`,
  ].join("\n");
  if (data.events.length === 0) return (`${header}\n\nNo recorded events.`);
  const events = data.events.map((event) => {
    const actor = event.actorType === "system"
      ? "@system"
      : event.actorName ? `@${event.actorName}` : "<unresolved>";
    return `seq=${event.seq} time=${event.createdAt} actor=${actor} type=${event.eventType}\n  ${JSON.stringify(event.payload)}`;
  }).join("\n");
  return (`${header}\n\n${events}`);
}

/**
 * `raft task show`: one task's current title and description (moved verbatim
 * from the CLI's commands/task/show.ts). Labels match the agent delivery
 * surface (`Current title:` / `Current description:`). `description` has three
 * states that must not collapse: a string, an explicit null, and a field the
 * envelope omitted.
 */
export function formatAgentTaskShow(
  target: string,
  task: { taskNumber?: number; status?: string | null; title?: string | null; description?: string | null },
): string {
  const descriptionLine =
    typeof task.description === "string"
      ? `Current description: ${task.description}`
      : task.description === null
        ? "Current description: (none set)"
        : "Current description: (not returned by this surface)";
  return [
    `#${task.taskNumber} [${task.status ?? "unknown"}] in ${target}`,
    `Current title: ${task.title ?? "(none set)"}`,
    descriptionLine,
    "",
  ].join("\n");
}
