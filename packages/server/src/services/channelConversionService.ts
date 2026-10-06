import { assertJointAdmission } from "./jointChannelLimitService";
import { currentDate, currentTimeMs, isActiveChannelConversionJob, noopTracer, projectConversionState, type ChannelConversionCommandView, type ChannelConversionState, type TraceContext, type Tracer } from "@botiverse/raft-shared";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import type { Server as SocketServer } from "socket.io";
import { getDb, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import {
  attestedSendPendingDrafts,
  channelAgents,
  channelConversionCommands,
  channelConversionFences,
  channelConversionJobs,
  channelHumans,
  channels,
  externalChannelBindings,
  jointChannels,
  jointChannelServers,
  messageMentions,
  messages,
  servers,
  shareArtifacts,
  tasks,
  workflowInstances
} from "../db/schema";
import {
  freezeActionCardsForConversion,
  isActionCardConversionMutationForTest,
  unfreezeActionCardsAfterCancellation
} from "./actionCardConversionService";
import { applyChannelConversionAudienceRealtimeCutover, audienceCutover, finalize, getChannelConversionAudienceCutover, residualCleanup } from "./channelConversionAudience";
import {
  parseConversionProgress,
  type ConversionProgress
} from "./channelConversionContracts";
import {
  acquireChannelConversionFence,
  getActiveChannelConversionFence,
  recordConversionPhaseCommit,
  releaseChannelConversionFence,
  withChannelConversionResourceLock
} from "./channelConversionFenceService";
import { ChannelConversionError, conversionTraceAttrs, stableStringify, stateForLegacyPhase, type ChannelConversionJob, type ChannelConversionPhase } from "./channelConversionPhaseContext";
import { assertNoActiveAttachmentTransfers, ChannelConversionUploadsInFlightError, moveParentMessages, moveThreadMessages, prepare, prepareExternalBindingsForChannelConversion, prepareTasks, prepareThreads, verify } from "./channelConversionPreparation";
import { restoreConversionResources } from "./channelConversionResources";
import { errorClassOf } from "../tracing/semanticTrace";
export { applyChannelConversionAudienceRealtimeCutover, getChannelConversionAudienceCutover, replayResidualCleanupForTest, setAudienceCleanupMutationForTest, type ChannelConversionAudienceCutover } from "./channelConversionAudience";
export { ChannelConversionError } from "./channelConversionPhaseContext";
export { assertNoActiveAttachmentTransfersBeforeAdmission, ChannelConversionUploadsInFlightError } from "./channelConversionPreparation";
export { CHANNEL_CONVERSION_BATCH_SIZE } from "./channelConversionResources";

export type { ChannelConversionPhase } from "./channelConversionPhaseContext";
export type ChannelConversionPrivacyRevalidator = (input: {
  serverId: string;
  channelId: string;
  now: Date;
}) => Promise<readonly { kind: string; reason?: string }[]>;
type ChannelConversionReceipt = ChannelConversionJob & { canCancel: boolean };
type ChannelConversionTraceOutcome = "ok" | "failed" | "timeout";
export type ChannelConversionPreJobPhase =
  | "source_lookup"
  | "active_job_check"
  | "eligibility_check"
  | "upload_check"
  | "source_lock"
  | "job_insert";
type ChannelConversionEligibilitySubcheck = "direct_task" | "thread_task";
export type ChannelConversionPreJobTrace = (event: {
  phase: ChannelConversionPreJobPhase;
  outcome: "started" | "ok" | "failed";
  errorClass?: string;
  eligibilitySubcheck?: ChannelConversionEligibilitySubcheck;
}) => void;

const LEASE_MS = 60_000;
const NEXT_PHASE: Record<Exclude<ChannelConversionPhase, "done">, ChannelConversionPhase> = {
  prepare: "prepare_tasks",
  prepare_tasks: "move_parent_messages",
  move_parent_messages: "prepare_threads",
  prepare_threads: "move_thread_messages",
  move_thread_messages: "verify",
  verify: "audience_cutover",
  audience_cutover: "residual_cleanup",
  residual_cleanup: "finalize",
  finalize: "done",
};

export interface ChannelConversionTaskInventoryItem {
  kind: "direct" | "thread";
  messageId: string;
  channelId: string;
  taskStatus: string;
  taskNumber: number | null;
  parentMessageId?: string;
  threadChannelId?: string;
}

export interface ChannelConversionTaskInventory {
  directTaskCount: number;
  threadTaskCount: number;
  totalCount: number;
  canonicalDirectTaskCount: number;
  canonicalThreadTaskCount: number;
  canonicalTaskCount: number;
  shadowOnlyTaskCount: number;
  directTasks: ChannelConversionTaskInventoryItem[];
  threadTasks: ChannelConversionTaskInventoryItem[];
}

export function describeChannelConversionPreJobFailure(phase: ChannelConversionPreJobPhase, error: unknown) {
  const timedOut = isLikelyTimeout(error);
  const phaseCopy: Record<ChannelConversionPreJobPhase, string> = {
    source_lookup: "looking up the source channel",
    active_job_check: "checking for an existing conversion job",
    eligibility_check: "checking whether the channel contains tasks",
    upload_check: "checking whether attachment uploads have finished",
    source_lock: "reserving the source channel",
    job_insert: "creating the conversion job",
  };
  return {
    status: timedOut ? 503 : 500,
    code: `channel_conversion_${phase}${timedOut ? "_timeout" : "_failed"}`,
    error: `Channel conversion ${timedOut ? "timed out" : "failed"} while ${phaseCopy[phase]}. The source channel was not locked and history remains intact. Please retry or contact support.`,
    phase,
    retryable: true,
  };
}

export async function startChannelToJointConversion(input: {
  serverId: string;
  sourceChannelId: string;
  createdByUserId: string;
  tracePreJobPhase?: ChannelConversionPreJobTrace;
  transaction?: DatabaseTransaction;
  revalidateExternalPrivacy?: ChannelConversionPrivacyRevalidator;
}): Promise<ChannelConversionReceipt> {
  if (input.revalidateExternalPrivacy) {
    const receipts = await input.revalidateExternalPrivacy({
      serverId: input.serverId,
      channelId: input.sourceChannelId,
      now: currentDate(),
    });
    const unavailable = receipts.find((receipt) => receipt.kind === "unavailable");
    if (unavailable) {
      throw new ChannelConversionError(
        "Slack channel privacy could not be verified before conversion",
        "external_binding_privacy_unavailable",
      );
    }
  }
  return withChannelConversionResourceLock(input.serverId, input.sourceChannelId, async (tx) => {
    const [source] = await tracePreJobPhase(input, "source_lookup", () => tx
      .select()
      .from(channels)
      .where(and(
        eq(channels.id, input.sourceChannelId),
        isNull(channels.deletedAt),
      ))
      .limit(1));
    if (!source || source.serverId !== input.serverId) throw new ChannelConversionError("Channel not found", "channel_not_found");
    if (source.type !== "channel" && source.type !== "private") {
      throw new ChannelConversionError("Only public or private channels can be converted", "unsupported_channel_type");
    }
    if (source.name === "all") {
      throw new ChannelConversionError("The #all channel cannot be converted", "reserved_channel");
    }
    // Contract v0.3 §18.7: conversion is one of the four admission points.
    // It only ever adds the host, so it cannot break a limit today; calling
    // the shared check keeps the four entry points from drifting apart.
    await assertJointAdmission(tx, null, { kind: "convert", hostServerId: input.serverId }, currentDate());

    const [activeJob] = await tracePreJobPhase(input, "active_job_check", () => tx
      .select()
      .from(channelConversionJobs)
      .where(and(
        eq(channelConversionJobs.sourceChannelId, source.id),
        inArray(channelConversionJobs.status, ["pending", "running", "failed"]),
      ))
      .limit(1));
    // The active job and its epoch are the durable source-of-truth. A duplicate
    // start never creates a second fence or silently advances a phase.
    if (activeJob) {
      // A compensated failure has deliberately released its source fence and
      // restored the ordinary channel. Keep the receipt as the durable retry
      // record; the command executor will mint a fresh epoch when the caller
      // explicitly starts/retries it. Treating this row as an active fenced
      // job would make a restored source permanently fail closed.
      if (activeJob.status === "failed" && normalizeProgress(activeJob.progress).rollbackState === "restored") {
        return projectConversionJob(activeJob);
      }
      const activeFence = await tx
        .select({ status: channelConversionFences.status })
        .from(channelConversionFences)
        .where(and(
          eq(channelConversionFences.sourceChannelId, source.id),
          eq(channelConversionFences.status, "active"),
        ))
        .limit(1);
      if (activeFence.length === 0) {
        throw new ChannelConversionError(
          "Active conversion job is missing its source fence; retry or repair is required",
          "channel_conversion_fence_missing",
        );
      }
      return projectConversionJob(activeJob);
    }
    const taskInventory = await tracePreJobPhase(input, "eligibility_check", async () => {
      return collectTaskInventory(tx, source.id, input);
    });
    const now = currentDate();
    const externalBindingsPaused = await tracePreJobPhase(input, "source_lock", async () => {
      // Match external outbound admission's conversation-first lock order.
      // The conversion fence owns write admission; archive remains lifecycle state.
      const [lockedSource] = await tx.select().from(channels).where(and(
        eq(channels.id, source.id), eq(channels.serverId, source.serverId), isNull(channels.deletedAt),
      )).for("update").limit(1);
      if (!lockedSource || (lockedSource.type !== "channel" && lockedSource.type !== "private")) {
        throw new ChannelConversionError("Channel changed before conversion could reserve it", "channel_conversion_source_changed");
      }
      return prepareExternalBindingsForChannelConversion(tx, lockedSource.serverId, lockedSource.id, false);
    });
    // Uploads are a start precondition. Keep the prepare-phase assertion too:
    // the source lock prevents new writers after this point, but a transfer
    // already committed before the lock must still be rechecked by the worker.
    await tracePreJobPhase(input, "upload_check", () => assertNoActiveAttachmentTransfers(tx, {
      serverId: input.serverId,
      sourceChannelId: source.id,
    }));

    const [job] = await tracePreJobPhase(input, "job_insert", () => tx
      .insert(channelConversionJobs)
      .values({
        serverId: input.serverId,
        sourceChannelId: source.id,
        sourceChannelType: source.type as "channel" | "private",
        status: "pending",
        phase: "prepare",
        createdByUserId: input.createdByUserId,
        progress: {
          version: 1, ledgerVersion: 2, resources: {},
          lockedAt: now.toISOString(),
          sourceArchiveSnapshot: {
            archivedAt: source.archivedAt?.toISOString() ?? null,
            archivedByUserId: source.archivedByUserId,
            archivedByAgentId: source.archivedByAgentId,
          },


          taskInventory: {
            directTaskCount: taskInventory.directTaskCount,
            threadTaskCount: taskInventory.threadTaskCount,
            totalCount: taskInventory.totalCount,
            canonicalDirectTaskCount: taskInventory.canonicalDirectTaskCount,
            canonicalThreadTaskCount: taskInventory.canonicalThreadTaskCount,
            canonicalTaskCount: taskInventory.canonicalTaskCount,
            shadowOnlyTaskCount: taskInventory.shadowOnlyTaskCount,
          },
          externalBindingsPaused,
        },
      })
      .returning());
    const fence = await acquireChannelConversionFence(tx, {
      jobId: job.id,
      serverId: input.serverId,
      sourceChannelId: source.id,
      conversionEpoch: job.conversionEpoch,
    });
    await freezeActionCardsForConversion(tx, {
      id: job.id,
      serverId: input.serverId,
      sourceChannelId: source.id,
      conversionEpoch: fence.conversionEpoch,
    });
    await recordConversionPhaseCommit(tx, {
      jobId: job.id,
      conversionEpoch: job.conversionEpoch,
      phase: "prepared",
      checksumInput: `${job.id}:${source.id}:prepared`,
    });
    await recordConversionPhaseCommit(tx, {
      jobId: job.id,
      conversionEpoch: job.conversionEpoch,
      phase: "fenced",
      checksumInput: `${job.id}:${fence.conversionEpoch}:fenced`,
    });
    const [fencedJob] = await tx
      .update(channelConversionJobs)
      .set({ state: "fenced", updatedAt: now })
      .where(eq(channelConversionJobs.id, job.id))
      .returning();
    return projectConversionJob(fencedJob ?? job);
  }, input.transaction);
}

const EXTERNAL_CONVERSION_RECONFIRM_REASON = "channel_conversion_reconfirmation_required";

/**
 * Freezes every live external conversation before Channel history moves into
 * Joint storage. The binding remains anchored to the same permission-facing
 * local channel id; its old epoch is drained, then invalidated so neither
 * inbound nor outbound work can cross the conversion boundary. Provisioning
 * must run a fresh preflight/reconfirmation before the new epoch can resume.
 */
async function collectTaskInventory(
  tx: DatabaseExecutor,
  sourceChannelId: string,
  input?: { tracePreJobPhase?: ChannelConversionPreJobTrace },
): Promise<ChannelConversionTaskInventory> {
  const directTaskResult = await traceEligibilitySubcheck(input ?? {}, "direct_task", () => tx.execute(sql`
      SELECT
        'direct'::text AS "kind",
        task_message.id::text AS "messageId",
        task_message.channel_id::text AS "channelId",
        task_message.task_status::text AS "taskStatus",
        task_message.task_number AS "taskNumber"
        FROM ${messages} task_message
       WHERE task_message.channel_id = ${sourceChannelId}
         AND task_message.task_status IS NOT NULL
       ORDER BY task_message.seq ASC
    `));

  const threadTaskResult = await traceEligibilitySubcheck(input ?? {}, "thread_task", () => tx.execute(sql`
      SELECT
        'thread'::text AS "kind",
        task_message.id::text AS "messageId",
        task_message.channel_id::text AS "channelId",
        task_message.task_status::text AS "taskStatus",
        task_message.task_number AS "taskNumber",
        parent_message.id::text AS "parentMessageId",
        thread_channel.id::text AS "threadChannelId"
        FROM ${messages} parent_message
        JOIN ${channels} thread_channel
          ON thread_channel.parent_message_id = parent_message.id
         AND thread_channel.type = 'thread'
         AND thread_channel.deleted_at IS NULL
        JOIN ${messages} task_message
          ON task_message.channel_id = thread_channel.id
         AND task_message.task_status IS NOT NULL
       WHERE parent_message.channel_id = ${sourceChannelId}
       ORDER BY parent_message.seq ASC, task_message.seq ASC
    `));
  // v2 task identity is authoritative in `tasks`, including message-less
  // rows. Keep the legacy message scan only as an eligibility warning for
  // rows that still carry a frozen shadow; it must never replace a canonical
  // row or become a second task representation.
  const canonicalDirect = await tx
    .select({ id: tasks.id, messageId: tasks.messageId, channelId: tasks.channelId, status: tasks.status, taskNumber: tasks.taskNumber })
    .from(tasks)
    .where(eq(tasks.channelId, sourceChannelId));
  const threadChannels = await tx.execute(sql`
    SELECT thread_channel.id::text AS "threadChannelId", parent_message.id::text AS "parentMessageId"
      FROM ${channels} thread_channel
      JOIN ${messages} parent_message ON parent_message.id = thread_channel.parent_message_id
     WHERE parent_message.channel_id = ${sourceChannelId}
       AND thread_channel.type = 'thread' AND thread_channel.deleted_at IS NULL
  `);
  const threadChannelIds = (threadChannels.rows as Array<{ threadChannelId: string }>).map((row) => row.threadChannelId);
  const canonicalThread = threadChannelIds.length === 0
    ? []
    : await tx
      .select({ id: tasks.id, messageId: tasks.messageId, channelId: tasks.channelId, status: tasks.status, taskNumber: tasks.taskNumber })
      .from(tasks)
      .where(inArray(tasks.channelId, threadChannelIds));

  const canonicalMessageIds = new Set(
    [...canonicalDirect, ...canonicalThread]
      .map((row) => row.messageId)
      .filter((id): id is string => typeof id === "string"),
  );
  const canonicalDirectTasks = canonicalDirect.map((row) => normalizeTaskInventoryRow({
    kind: "direct", messageId: row.messageId ?? row.id, channelId: row.channelId,
    taskStatus: row.status, taskNumber: row.taskNumber,
  }, "direct"));
  const canonicalThreadTasks = canonicalThread.map((row) => normalizeTaskInventoryRow({
    kind: "thread", messageId: row.messageId ?? row.id, channelId: row.channelId,
    taskStatus: row.status, taskNumber: row.taskNumber,
  }, "thread"));
  // Legacy shadows without a Task v2 row are promoted; existing canonical
  // identity remains authoritative and never requires destructive consent.
  const directTasks = directTaskResult.rows
    .map((row) => normalizeTaskInventoryRow(row, "direct"))
    .filter((row) => !canonicalMessageIds.has(row.messageId));
  const threadTasks = threadTaskResult.rows
    .map((row) => normalizeTaskInventoryRow(row, "thread"))
    .filter((row) => !canonicalMessageIds.has(row.messageId));
  const shadowOnlyTaskCount = directTasks.length + threadTasks.length;
  return {
    directTaskCount: directTasks.length,
    threadTaskCount: threadTasks.length,
    totalCount: shadowOnlyTaskCount,
    canonicalDirectTaskCount: canonicalDirectTasks.length,
    canonicalThreadTaskCount: canonicalThreadTasks.length,
    canonicalTaskCount: canonicalDirectTasks.length + canonicalThreadTasks.length,
    shadowOnlyTaskCount,
    directTasks,
    threadTasks,
  };
}

function normalizeTaskInventoryRow(
  row: unknown,
  kind: "direct" | "thread",
): ChannelConversionTaskInventoryItem {
  const value = row && typeof row === "object" ? row as Record<string, unknown> : {};
  return {
    kind,
    messageId: String(value.messageId ?? ""),
    channelId: String(value.channelId ?? ""),
    taskStatus: String(value.taskStatus ?? ""),
    taskNumber: typeof value.taskNumber === "number" ? value.taskNumber : null,
    ...(typeof value.parentMessageId === "string" ? { parentMessageId: value.parentMessageId } : {}),
    ...(typeof value.threadChannelId === "string" ? { threadChannelId: value.threadChannelId } : {}),
  };
}

async function tracePreJobPhase<T>(
  input: { tracePreJobPhase?: ChannelConversionPreJobTrace },
  phase: ChannelConversionPreJobPhase,
  work: () => Promise<T>,
): Promise<T> {
  input.tracePreJobPhase?.({ phase, outcome: "started" });
  try {
    const result = await work();
    input.tracePreJobPhase?.({ phase, outcome: "ok" });
    return result;
  } catch (error) {
    input.tracePreJobPhase?.({
      phase,
      outcome: "failed",
      errorClass: classifyConversionErrorClass(error),
    });
    throw error;
  }
}

async function traceEligibilitySubcheck<T>(
  input: { tracePreJobPhase?: ChannelConversionPreJobTrace },
  eligibilitySubcheck: ChannelConversionEligibilitySubcheck,
  work: () => Promise<T>,
): Promise<T> {
  input.tracePreJobPhase?.({ phase: "eligibility_check", eligibilitySubcheck, outcome: "started" });
  try {
    const result = await work();
    input.tracePreJobPhase?.({ phase: "eligibility_check", eligibilitySubcheck, outcome: "ok" });
    return result;
  } catch (error) {
    input.tracePreJobPhase?.({
      phase: "eligibility_check",
      eligibilitySubcheck,
      outcome: "failed",
      errorClass: classifyConversionErrorClass(error),
    });
    throw error;
  }
}

export async function retryChannelConversionJob(jobId: string, transaction?: DatabaseTransaction): Promise<ChannelConversionReceipt> {
  const db = transaction ?? getDb();
  const [routing] = await db
    .select({ serverId: channelConversionJobs.serverId, sourceChannelId: channelConversionJobs.sourceChannelId })
    .from(channelConversionJobs)
    .where(eq(channelConversionJobs.id, jobId))
    .limit(1);
  if (!routing) throw new ChannelConversionError("Conversion job not found", "job_not_found");

  const job = await withChannelConversionResourceLock(
    routing.serverId,
    routing.sourceChannelId,
    async (tx) => {
    const [existing] = await tx
      .select()
      .from(channelConversionJobs)
      .where(eq(channelConversionJobs.id, jobId))
      .limit(1);
    if (!existing) return null;
    // Retry is an operation on a failed receipt. A pending/running job is only
    // accepted here when its retained fence is missing, which is the explicit
    // repair path used after a crash between job insert and fence persistence.
    // Never reset a live or terminal job from a stale client retry (or a race
    // with another runner) and accidentally replay an already-committed phase.
    const [activeFence] = await tx
      .select({ status: channelConversionFences.status })
      .from(channelConversionFences)
      .where(and(
        eq(channelConversionFences.jobId, existing.id),
        eq(channelConversionFences.status, "active"),
      ))
      .limit(1);
    if (
      existing.status !== "failed"
      && activeFence
    ) {
      throw new ChannelConversionError(
        "Only a failed conversion can be retried",
        "channel_conversion_retry_not_allowed",
      );
    }
    if (["done", "canceled", "succeeded"].includes(existing.status) || existing.phase === "done") {
      throw new ChannelConversionError(
        "Only a failed conversion can be retried",
        "channel_conversion_retry_not_allowed",
      );
    }
    const existingProgress = normalizeProgress(existing.progress);
    const rolledBack = existing.status === "failed" && existingProgress.rollbackState === "restored";
    const progress: ConversionProgress = rolledBack
      ? parseConversionProgress({
        ledgerVersion: 2,
        ...(existingProgress.sourceArchiveSnapshot ? { sourceArchiveSnapshot: existingProgress.sourceArchiveSnapshot } : {}),
        ...(existingProgress.taskInventory ? { taskInventory: existingProgress.taskInventory } : {}),
        retryState: "running",
      })
      : existingProgress;
    const lockedAt = currentDate();
    const nextEpoch = rolledBack ? randomUUID() : existing.conversionEpoch;
    if (rolledBack) {
      await tx.update(channelConversionJobs).set({
        conversionEpoch: nextEpoch,
        canonicalChannelId: null,
        jointChannelId: null,
        phase: "prepare",
      }).where(eq(channelConversionJobs.id, existing.id));
    }
    await acquireChannelConversionFence(tx, {
      jobId: existing.id,
      serverId: existing.serverId,
      sourceChannelId: existing.sourceChannelId,
      conversionEpoch: nextEpoch,
    });
    if (rolledBack) {
      await freezeActionCardsForConversion(tx, {
        id: existing.id,
        serverId: existing.serverId,
        sourceChannelId: existing.sourceChannelId,
        conversionEpoch: nextEpoch,
      });
    }
    if (isActionCardConversionMutationForTest("failed_retry_unfreeze")) {
      await unfreezeActionCardsAfterCancellation(tx, {
        id: existing.id,
        serverId: existing.serverId,
        sourceChannelId: existing.sourceChannelId,
        conversionEpoch: nextEpoch,
      });
    }
    const [updated] = await tx
      .update(channelConversionJobs)
      .set({
        state: rolledBack ? "fenced"
          : isConversionState(progress.previousState)
          ? progress.previousState
          : existing.phase === "prepare" ? "fenced" : "copying",
        status: "pending",
        // Every phase is its own transactional/idempotent retry boundary.
        // Resume the failed phase directly so the receipt's Retry action has
        // precise semantics instead of silently replaying earlier stages.
        phase: rolledBack ? "prepare" : existing.phase,
        error: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: lockedAt,
        progress: { ...progress, relockedAt: lockedAt.toISOString(), retryState: "running", completionBroadcastAt: null },
      })
      .where(eq(channelConversionJobs.id, jobId))
      .returning();
    return updated ?? null;
  }, transaction);
  if (!job) throw new ChannelConversionError("Conversion job not found", "job_not_found");
  return projectConversionJob(job);
}

export async function runChannelConversionJob(
  jobId: string,
  opts: {
    maxPhases?: number;
    io?: Pick<SocketServer, "in">;
    failBeforePhase?: ChannelConversionPhase;
    tracer?: Tracer | null;
    traceParent?: TraceContext | null;
  } = {},
): Promise<ChannelConversionReceipt> {
  const tracer = opts.tracer ?? noopTracer;
  let remaining = opts.maxPhases ?? Number.POSITIVE_INFINITY;
  while (remaining > 0) {
    const job = await getChannelConversionJob(jobId);
    if (!job) throw new ChannelConversionError("Conversion job not found", "job_not_found");
    if (job.phase === "done" || job.status === "done") return job;
    if (job.status === "failed") return job;
    if (job.status === "canceled") return job;
    if (opts.failBeforePhase && job.phase === opts.failBeforePhase) {
      await markJobFailed(job, `injected failure before ${job.phase}`, new Error("InjectedChannelConversionFailure"));
      return (await getChannelConversionJob(job.id))!;
    }
    await runOnePhase(job, tracer, opts.traceParent ?? null, opts.failBeforePhase);
    if (opts.io) applyChannelConversionAudienceRealtimeCutover(opts.io, await getChannelConversionAudienceCutover(job.id));
    remaining -= 1;
  }
  const job = await getChannelConversionJob(jobId);
  if (!job) throw new ChannelConversionError("Conversion job not found", "job_not_found");
  return job;
}

export async function getChannelConversionJob(jobId: string): Promise<ChannelConversionReceipt | null> {
  const db = getDb();
  const [job] = await db.select().from(channelConversionJobs).where(eq(channelConversionJobs.id, jobId)).limit(1);
  return job ? projectConversionJob(job) : null;
}

/** Legacy fields keep their existing active-job-only shape. The new read model
 * also carries terminal jobs, so clients never infer cancellation from channel.type. */
export type ConversionCommandView = ChannelConversionCommandView;

export function conversionCommandView(command: typeof channelConversionCommands.$inferSelect): ConversionCommandView {
  return {
    id: command.id, kind: command.kind, status: command.status, jobId: command.jobId,
    error: command.error, createdAt: command.createdAt.toISOString(),
  };
}

export async function attachLatestChannelConversionJobs<T extends { id: string; serverId: string }>(
  rows: T[],
): Promise<Array<T & { conversionJob: Pick<ChannelConversionReceipt, "id" | "status" | "phase" | "progress" | "error" | "canCancel"> | null; conversionCommand: ConversionCommandView | null; conversionState: ChannelConversionState }>> {
  if (rows.length === 0) return [];
  // Both facts must come from one read snapshot: a command committed between
  // two ordinary reads must not be paired with the pre-command failed job.
  return getDb().transaction(async (db) => {
    const jobs = await db
      .selectDistinctOn([channelConversionJobs.sourceChannelId])
      .from(channelConversionJobs)
      .where(and(
        inArray(channelConversionJobs.serverId, [...new Set(rows.map((row) => row.serverId))]),
        inArray(channelConversionJobs.sourceChannelId, rows.map((row) => row.id)),
      ))
      .orderBy(channelConversionJobs.sourceChannelId, sql`CASE WHEN ${channelConversionJobs.status} IN ('pending', 'running', 'failed') THEN 0 ELSE 1 END`,
        desc(channelConversionJobs.updatedAt), desc(channelConversionJobs.createdAt));
    type ConversionJobReceipt = Pick<ChannelConversionReceipt, "id" | "status" | "phase" | "progress" | "error" | "canCancel">;
    const bySource = new Map<string, ConversionJobReceipt>();
    for (const job of jobs) {
      if (!bySource.has(job.sourceChannelId)) {
        bySource.set(job.sourceChannelId, {
          id: job.id,
          status: job.status,
          phase: job.phase,
          progress: job.progress,
          error: job.error,
          canCancel: canCancelChannelConversion(job),
        });
      }
    }
    const commands = await db.selectDistinctOn([channelConversionCommands.sourceChannelId]).from(channelConversionCommands).where(and(
      inArray(channelConversionCommands.sourceChannelId, rows.map(row => row.id)),
      inArray(channelConversionCommands.serverId, [...new Set(rows.map(row => row.serverId))]),
    )).orderBy(channelConversionCommands.sourceChannelId, sql`CASE WHEN ${channelConversionCommands.status} = 'pending' THEN 0 ELSE 1 END`, desc(channelConversionCommands.createdAt));
    const commandsBySource = new Map<string, ConversionCommandView>();
    for (const command of commands) {
      if (!commandsBySource.has(command.sourceChannelId)) commandsBySource.set(command.sourceChannelId, conversionCommandView(command));
    }
    return rows.map((row) => {
      const job = bySource.get(row.id) ?? null;
      const command = commandsBySource.get(row.id) ?? null;
      return {
        ...row,
        conversionJob: isActiveChannelConversionJob(job) ? job : null,
        conversionCommand: command,
        conversionState: projectConversionState(command, job),
      };
    });
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export function canCancelChannelConversion(job: Pick<ChannelConversionJob, "status" | "phase" | "progress" | "canonicalChannelId" | "jointChannelId">): boolean {
  const progress = normalizeProgress(job.progress);
  if (job.status === "failed" && progress.rollbackState === "restored") return true;
  return ["pending", "running", "failed"].includes(job.status)
    && !progress.audienceCutoverAt
    && !["residual_cleanup", "finalize", "done"].includes(job.phase);
}

function projectConversionJob(job: ChannelConversionJob): ChannelConversionReceipt {
  return { ...job, canCancel: canCancelChannelConversion(job) };
}

export async function cancelChannelConversionJob(jobId: string, transaction?: DatabaseTransaction): Promise<ChannelConversionReceipt> {
  const db = transaction ?? getDb();
  const [routing] = await db
    .select({ serverId: channelConversionJobs.serverId, sourceChannelId: channelConversionJobs.sourceChannelId })
    .from(channelConversionJobs)
    .where(eq(channelConversionJobs.id, jobId))
    .limit(1);
  if (!routing) throw new ChannelConversionError("Conversion job not found", "job_not_found");

  return withChannelConversionResourceLock(routing.serverId, routing.sourceChannelId, async (tx) => {
    const [job] = await tx.select().from(channelConversionJobs).where(eq(channelConversionJobs.id, jobId)).limit(1);
    if (!job) throw new ChannelConversionError("Conversion job not found", "job_not_found");
    if (job.status === "canceled") return projectConversionJob(job);
    if (["done", "succeeded"].includes(job.status) || job.phase === "done") {
      throw new ChannelConversionError(
        "This conversion has already reached a terminal state and cannot be canceled",
        "channel_conversion_cancel_not_allowed",
      );
    }
    if (!canCancelChannelConversion(job)) {
      throw new ChannelConversionError(
        "This conversion has already switched channel access; retry it to finish.",
        "channel_conversion_cancel_after_copy",
      );
    }
    await rollbackConversionToSource(tx, job);
    const [canceled] = await tx
      .update(channelConversionJobs)
      .set({
        state: "canceled",
        status: "canceled",
        phase: "done",
        progress: { ...normalizeProgress(job.progress), completionBroadcastAt: null },
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: currentDate(),
      })
      .where(eq(channelConversionJobs.id, job.id))
      .returning();
    return projectConversionJob(canceled);
  }, transaction);
}

async function runOnePhase(job: ChannelConversionJob, tracer: Tracer, traceParent: TraceContext | null, failBeforePhase?: ChannelConversionPhase) {
  const phaseSpan = tracer.startSpan("server.channel_conversion.phase", {
    parent: traceParent,
    surface: "server",
    kind: "internal",
    attrs: conversionTraceAttrs(job, { outcome: "ok" }),
  });
  let outcome: ChannelConversionTraceOutcome = "ok";
  let errorClass: string | undefined;
  let attemptedJob = job;
  try {
    await withChannelConversionResourceLock(job.serverId, job.sourceChannelId, async (tx) => {
      const [current] = await tx
        .select()
        .from(channelConversionJobs)
        .where(eq(channelConversionJobs.id, job.id))
        .limit(1);
      if (!current || current.status === "done" || current.phase === "done" || current.status === "canceled" || current.status === "failed") return;
      attemptedJob = current;
      const fence = await getActiveChannelConversionFence(tx, current.sourceChannelId);
      if (!fence || fence.jobId !== current.id || fence.conversionEpoch !== current.conversionEpoch) {
        throw new ChannelConversionError(
          "Conversion source fence is missing or belongs to another epoch",
          "channel_conversion_fence_mismatch",
        );
      }

      const leaseOwner = `conversion:${randomUUID()}`;
      await tx
        .update(channelConversionJobs)
        .set({
          state: current.phase === "prepare" ? "draining" : stateForLegacyPhase(current.phase),
          status: "running",
          error: null,
          leaseOwner,
          leaseExpiresAt: new Date(currentTimeMs() + LEASE_MS),
          updatedAt: currentDate(),
        })
        .where(eq(channelConversionJobs.id, current.id));

      if (current.phase === "prepare") await prepare({ tx, job: current, progress: normalizeProgress(current.progress), span: phaseSpan });
      else if (current.phase === "prepare_tasks") await prepareTasks({ tx, job: current, progress: normalizeProgress(current.progress), span: phaseSpan });
      else if (current.phase === "move_parent_messages") await moveParentMessages({ tx, job: current, progress: normalizeProgress(current.progress), span: phaseSpan });
      else if (current.phase === "prepare_threads") await prepareThreads({ tx, job: current, progress: normalizeProgress(current.progress), span: phaseSpan });
      else if (current.phase === "move_thread_messages") await moveThreadMessages({ tx, job: current, progress: normalizeProgress(current.progress), span: phaseSpan });
      else if (current.phase === "verify") await verify({ tx, job: current, progress: normalizeProgress(current.progress), span: phaseSpan });
      else if (current.phase === "audience_cutover") {
        // Access changes, destructive personal-state cleanup, and success are
        // one commit. Until this transaction commits every copied row can be
        // returned to the source; no newly-created job can stop halfway through
        // an irreversible cutover.
        await audienceCutover({ tx, job: current, progress: normalizeProgress(current.progress), span: phaseSpan });
        let [next] = await tx.select().from(channelConversionJobs).where(eq(channelConversionJobs.id, current.id));
        if (failBeforePhase === "residual_cleanup") throw new Error("InjectedChannelConversionFailure");
        do {
          await residualCleanup({ tx, job: next, progress: normalizeProgress(next.progress), span: phaseSpan });
          [next] = await tx.select().from(channelConversionJobs).where(eq(channelConversionJobs.id, current.id));
        } while (next.phase === "residual_cleanup");
        if (failBeforePhase === "finalize") throw new Error("InjectedChannelConversionFailure");
        await finalize({ tx, job: next, progress: normalizeProgress(next.progress), span: phaseSpan });
      }
      else if (current.phase === "residual_cleanup") await residualCleanup({ tx, job: current, progress: normalizeProgress(current.progress), span: phaseSpan });
      else if (current.phase === "finalize") await finalize({ tx, job: current, progress: normalizeProgress(current.progress), span: phaseSpan });
    });
  } catch (err) {
    outcome = classifyConversionTraceOutcome(err);
    errorClass = classifyConversionErrorClass(err);
    phaseSpan.addEvent("server.channel_conversion.phase.failed", conversionTraceAttrs(job, { outcome, errorClass }));
    await markJobFailed(attemptedJob, err instanceof Error ? err.message : String(err), err);
  } finally {
    phaseSpan.end(outcome === "ok" ? "ok" : "error", {
      attrs: conversionTraceAttrs(job, { outcome, errorClass }),
    });
  }
}

/** Compensate committed pre-cutover work after a phase failure.  The source
 * fence is held for the whole operation, so no writer can observe a half
 * restored projection.  This deliberately stops before audience cleanup,
 * whose deleted personal state cannot be reconstructed from the conversion
 * tables alone. */
async function rollbackConversionToSource(tx: DatabaseExecutor, job: ChannelConversionJob): Promise<void> {
  const ownedProjection = await resolveOwnedConversionProjection(tx, job);
  const canonicalChannelId = ownedProjection?.canonicalChannelId ?? null;
  const jointChannelId = ownedProjection?.jointChannelId ?? null;
  // Drop the job's foreign-key references before deleting the temporary
  // projection. The rollback runs in the same transaction, so this does not
  // expose an unowned intermediate state, and it prevents the FK from making
  // compensation itself fail closed.
  if (canonicalChannelId || jointChannelId) {
    await tx.update(channelConversionJobs).set({ canonicalChannelId: null, jointChannelId: null })
      .where(eq(channelConversionJobs.id, job.id));
  }
  if (!canonicalChannelId) {
    const promotedTaskIds = normalizeProgress(job.progress).promotedTaskIds;
    if (Array.isArray(promotedTaskIds) && promotedTaskIds.length > 0) {
      await tx.delete(tasks).where(inArray(tasks.id, promotedTaskIds.filter((id): id is string => typeof id === "string")));
    }
    await restoreExternalBindings(tx, job);
    await releaseChannelConversionFence(tx, job.id, "failed_rollback");
    await unfreezeActionCardsAfterCancellation(tx, {
      id: job.id, serverId: job.serverId, sourceChannelId: job.sourceChannelId, conversionEpoch: job.conversionEpoch,
    });
    return;
  }

  // Lock everything this rollback deletes or re-keys before changing any of
  // it, in the order read-state resolution takes FOR KEY SHARE on the same
  // rows (readMutationSequencer): per thread in local-thread-id order the
  // projection, joint, storage thread and parent message, then the parent
  // joint, its projections and the canonical channel. Moving a message back
  // rewrites channel_id, a key column, so parents need FOR UPDATE too. A
  // rollback that waits here therefore holds nothing a reader needs next.
  // Rows are locked in ORDER BY order; within one row, PostgreSQL locks the
  // tables in FOR UPDATE OF list order (not FROM order — verified on PG 18),
  // so that list is the per-thread lock order and must stay projection,
  // joint_thread, canonical_thread, parent.
  const threadRows = await tx.execute(sql`
    SELECT projection.local_channel_id::text AS local_id,
           joint_thread.canonical_channel_id::text AS canonical_id,
           canonical_thread.parent_message_id::text AS parent_message_id,
           projection.joint_channel_id::text AS joint_id
      FROM ${jointChannelServers} projection
      JOIN ${jointChannels} joint_thread ON joint_thread.id = projection.joint_channel_id
      JOIN ${channels} canonical_thread ON canonical_thread.id = joint_thread.canonical_channel_id
      JOIN ${messages} parent ON parent.id = canonical_thread.parent_message_id
     WHERE projection.server_id = ${job.serverId}
       AND joint_thread.created_by_server_id = ${job.serverId}
       AND joint_thread.id <> ${jointChannelId ?? "00000000-0000-0000-0000-000000000000"}::uuid
       AND canonical_thread.type = 'thread'
       AND parent.channel_id = ${canonicalChannelId}
     ORDER BY projection.local_channel_id
     FOR UPDATE OF projection, joint_thread, canonical_thread, parent
  `);
  if (jointChannelId) {
    await tx.execute(sql`SELECT 1 FROM ${jointChannels} WHERE id = ${jointChannelId}::uuid FOR UPDATE`);
    await tx.execute(sql`
      SELECT 1 FROM ${jointChannelServers} WHERE joint_channel_id = ${jointChannelId}::uuid ORDER BY server_id FOR UPDATE
    `);
  }
  await tx.execute(sql`SELECT 1 FROM ${channels} WHERE id = ${canonicalChannelId}::uuid FOR UPDATE`);

  for (const row of threadRows.rows as Array<{ local_id: string; canonical_id: string; parent_message_id: string; joint_id: string }>) {
    await moveRowsBackToSource(tx, row.canonical_id, row.local_id);
    await tx.update(messages)
      .set({ threadId: row.local_id })
      .where(and(eq(messages.id, row.parent_message_id), eq(messages.threadId, row.canonical_id)));
    await tx.delete(jointChannelServers).where(eq(jointChannelServers.jointChannelId, row.joint_id));
    await tx.delete(jointChannels).where(eq(jointChannels.id, row.joint_id));
    await tx.delete(channels).where(eq(channels.id, row.canonical_id));
    await tx.update(channels)
      .set({ parentMessageId: row.parent_message_id })
      .where(eq(channels.id, row.local_id));
  }

  await moveRowsBackToSource(tx, canonicalChannelId, job.sourceChannelId);
  const promotedTaskIds = normalizeProgress(job.progress).promotedTaskIds;
  if (Array.isArray(promotedTaskIds) && promotedTaskIds.length > 0) {
    await tx.delete(tasks).where(inArray(tasks.id, promotedTaskIds.filter((id): id is string => typeof id === "string")));
  }
  if (jointChannelId) {
    await tx.delete(jointChannelServers).where(eq(jointChannelServers.jointChannelId, jointChannelId));
    await tx.delete(jointChannels).where(eq(jointChannels.id, jointChannelId));
  }
  await tx.delete(channels).where(eq(channels.id, canonicalChannelId));

  // Restore bindings paused by this epoch.  The source lock serializes this
  // with binding writers; only our reconfirmation marker is eligible.
  await restoreExternalBindings(tx, job);
  await releaseChannelConversionFence(tx, job.id, "failed_rollback");
  await unfreezeActionCardsAfterCancellation(tx, {
    id: job.id, serverId: job.serverId, sourceChannelId: job.sourceChannelId, conversionEpoch: job.conversionEpoch,
  });
}

/**
 * Find only the projection this conversion is allowed to compensate.  The
 * job's routing columns are mutable retry state, so they are not sufficient
 * authority after an interrupted or corrupted attempt.  The deterministic
 * storage-channel name plus its creating server binds the cleanup to this
 * conversion id and prevents a bad job row from deleting another channel.
 */
async function resolveOwnedConversionProjection(
  tx: DatabaseExecutor,
  job: ChannelConversionJob,
): Promise<{ canonicalChannelId: string; jointChannelId: string } | null> {
  const expectedName = `joint-storage-convert-${job.id.replaceAll("-", "")}`;
  const rows = await tx.execute(sql`
    SELECT canonical.id::text AS canonical_id, joint.id::text AS joint_id
      FROM ${jointChannels} joint
      JOIN ${channels} canonical ON canonical.id = joint.canonical_channel_id
      JOIN ${servers} storage ON storage.id = canonical.server_id
     WHERE joint.created_by_server_id = ${job.serverId}
       AND storage.kind = 'joint_storage'
       AND canonical.name = ${expectedName}
  `);
  const candidates = rows.rows as Array<{ canonical_id?: unknown; joint_id?: unknown }>;
  const unique = new Map<string, string>();
  for (const row of candidates) {
    if (typeof row.canonical_id === "string" && typeof row.joint_id === "string") {
      unique.set(row.canonical_id, row.joint_id);
    }
  }
  if (unique.size > 1) throw new Error("Ambiguous conversion projection ownership");
  if (unique.size === 0) return null;
  const [entry] = unique.entries();
  return entry ? { canonicalChannelId: entry[0], jointChannelId: entry[1] } : null;
}

async function restoreExternalBindings(tx: DatabaseExecutor, job: ChannelConversionJob): Promise<void> {
  await tx.execute(sql`
    UPDATE ${externalChannelBindings}
       SET state = 'active',
           state_reason = NULL,
           binding_epoch = GREATEST(binding_epoch - 1, 0),
           updated_at = now()
     WHERE server_id = ${job.serverId}
       AND channel_id = ${job.sourceChannelId}
       AND state = 'paused'
       AND state_reason = ${EXTERNAL_CONVERSION_RECONFIRM_REASON}
  `);
}

async function moveRowsBackToSource(tx: DatabaseExecutor, fromChannelId: string, sourceChannelId: string): Promise<void> {
  await restoreConversionResources(tx, fromChannelId, sourceChannelId);
  await tx.update(messageMentions).set({ channelId: sourceChannelId }).where(eq(messageMentions.channelId, fromChannelId));
  await tx.update(workflowInstances).set({ channelId: sourceChannelId }).where(eq(workflowInstances.channelId, fromChannelId));
  await tx.update(shareArtifacts).set({ channelId: sourceChannelId }).where(eq(shareArtifacts.channelId, fromChannelId));
  await tx.update(attestedSendPendingDrafts).set({ channelId: sourceChannelId }).where(eq(attestedSendPendingDrafts.channelId, fromChannelId));
}

async function markJobFailed(expected: ChannelConversionJob, error: string, cause?: unknown) {
  const jobId = expected.id;
  await withChannelConversionResourceLock(expected.serverId, expected.sourceChannelId, async (tx) => {
    const [job] = await tx.select().from(channelConversionJobs).where(eq(channelConversionJobs.id, jobId)).limit(1);
    // Compare with the persisted snapshot *before* the failed transaction.
    // Its temporary lease was rolled back and cannot identify the attempt.
    // A newer cancel, retry, phase or batch must never receive this old error.
    if (!job || job.status === "done" || job.status === "canceled" || job.status === "failed"
      || job.phase === "done" || job.phase !== expected.phase || job.status !== expected.status
      || job.conversionEpoch !== expected.conversionEpoch || job.leaseOwner !== expected.leaseOwner
      || job.updatedAt.getTime() !== expected.updatedAt.getTime()
      || stableStringify(job.progress) !== stableStringify(expected.progress)) return;
    const failedAt = currentDate();
    const phaseCopy: Record<ChannelConversionPhase, string> = {
      prepare: "preparing the conversion",
      prepare_tasks: "preserving task identity",
      move_parent_messages: "moving channel history",
      prepare_threads: "preparing thread projections",
      move_thread_messages: "moving thread history",
      verify: "verifying copied history",
      audience_cutover: "computing channel access",
      residual_cleanup: "cleaning obsolete personal state",
      finalize: "committing the Joint channel",
      done: "finishing the conversion",
    };
    const rollbackEligible = canCancelChannelConversion(job);
    const userFacingError = cause instanceof ChannelConversionUploadsInFlightError
      ? cause.message
      : cause instanceof ChannelConversionError
        ? error
      : `Channel conversion failed while ${phaseCopy[job.phase] ?? "running a conversion phase"}. ${rollbackEligible ? "The original channel has been restored. You can use it or retry conversion." : "Retry to finish the conversion."}`;
    // Database/transport diagnostics belong to server logs, never the receipt.
    console.error("[ChannelConversion] phase failed", { jobId, phase: job.phase, cause });
    // Failures before audience cutover are compensating failures: restore every
    // committed move and release the source fence so the user can return to the
    // ordinary channel. New jobs commit cutover, cleanup and Done together;
    // only legacy jobs already past cutover need forward recovery.
    if (rollbackEligible) await rollbackConversionToSource(tx, job);
    if (isActionCardConversionMutationForTest("failed_retry_unfreeze")) {
      await unfreezeActionCardsAfterCancellation(tx, {
        id: job.id,
        serverId: job.serverId,
        sourceChannelId: job.sourceChannelId,
        conversionEpoch: job.conversionEpoch,
      });
    }
    await tx
      .update(channelConversionJobs)
      .set({
        state: "retry_waiting",
        status: "failed",
        error: userFacingError,
        // A compensated failure deletes its temporary projection. Clear the
        // routing references in the receipt as part of the same transition so
        // the persisted job cannot point at a channel that no longer exists.
        ...(rollbackEligible ? { canonicalChannelId: null, jointChannelId: null } : {}),
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: failedAt,
        progress: {
          ...normalizeProgress(job.progress),
          failedAt: failedAt.toISOString(),
          awaitingRetryAt: failedAt.toISOString(),
          previousState: job.state,
          retryState: "awaiting_retry",
          sourceLock: rollbackEligible ? "released" : "retained",
          ...(rollbackEligible ? { rollbackState: "restored", rollbackAt: failedAt.toISOString() } : {}),
          errorClass: classifyConversionErrorClass(cause),
          errorPhase: job.phase,
          ...(cause instanceof ChannelConversionError ? { errorCode: cause.code } : {}),
          ...(cause instanceof ChannelConversionUploadsInFlightError
            ? { uploadScope: cause.uploadScope, uploadCount: cause.uploadCount }
            : {}),
        },
      })
      .where(eq(channelConversionJobs.id, jobId));
  });
}

function normalizeProgress(progress: unknown): ConversionProgress {
  return parseConversionProgress(progress);
}

function isConversionState(value: unknown): value is ChannelConversionJob["state"] {
  return typeof value === "string" && [
    "prepared",
    "fenced",
    "draining",
    "copying",
    "projections_rebuilt",
    "audience_cutover",
    "residual_cleanup",
    "verifying",
    "succeeded",
    "retry_waiting",
    "failed",
    "canceled",
  ].includes(value);
}

function classifyConversionTraceOutcome(error: unknown): ChannelConversionTraceOutcome {
  if (isLikelyTimeout(error)) return "timeout";
  return "failed";
}

function classifyConversionErrorClass(error: unknown): string {
  if (isLikelyTimeout(error)) return "TimeoutError";
  return errorClassOf(error);
}

function isLikelyTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /timeout|timed out|statement timeout|canceling statement due to statement timeout/i.test(error.message);
}

export async function getJointShapeForLocalChannel(channelId: string) {
  const db = getDb();
  const canonicalThread = alias(channels, "shape_canonical_thread");
  const localThread = alias(channels, "shape_local_thread");
  const parentMessage = alias(messages, "shape_parent_message");

  const [parent] = await db
    .select({
      localChannelId: jointChannelServers.localChannelId,
      serverId: jointChannelServers.serverId,
      role: jointChannelServers.role,
      jointChannelId: jointChannelServers.jointChannelId,
      canonicalChannelId: jointChannels.canonicalChannelId,
    })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(eq(jointChannelServers.localChannelId, channelId), eq(jointChannelServers.status, "active")))
    .limit(1);
  if (!parent) return null;

  const threadRows = await db
    .select({
      localThreadId: jointChannelServers.localChannelId,
      canonicalThreadId: jointChannels.canonicalChannelId,
      parentMessageId: canonicalThread.parentMessageId,
      parentContent: parentMessage.content,
      localParentMessageId: localThread.parentMessageId,
    })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .innerJoin(localThread, eq(localThread.id, jointChannelServers.localChannelId))
    .innerJoin(canonicalThread, eq(canonicalThread.id, jointChannels.canonicalChannelId))
    .innerJoin(parentMessage, eq(parentMessage.id, canonicalThread.parentMessageId))
    .where(and(
      eq(jointChannelServers.serverId, parent.serverId),
      eq(localThread.type, "thread"),
      eq(canonicalThread.type, "thread"),
      eq(parentMessage.channelId, parent.canonicalChannelId),
    ));

  const memberRows = await db
    .select({ userId: channelHumans.userId })
    .from(channelHumans)
    .where(eq(channelHumans.channelId, parent.localChannelId));
  const agentRows = await db
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(eq(channelAgents.channelId, parent.localChannelId));

  const parentMessages = await db
    .select({ content: messages.content, threadId: messages.threadId, senderType: messages.senderType })
    .from(messages)
    .where(eq(messages.channelId, parent.canonicalChannelId));

  return {
    parent,
    threadRows,
    memberUserIds: memberRows.map((row) => row.userId).sort(),
    memberAgentIds: agentRows.map((row) => row.agentId).sort(),
    parentMessages,
  };
}
