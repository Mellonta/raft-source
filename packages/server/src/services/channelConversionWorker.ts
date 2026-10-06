import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { noopTracer, type Tracer } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { channelConversionJobs } from "../db/schema";
import { runConversionCommandWorkerPass } from "./channelConversionCommandService";
import { runChannelConversionJob } from "./channelConversionService";
import type { ChannelConversionPrivacyRevalidator } from "./channelConversionService";
import { withTraceRoot } from "../tracing/semanticTrace";

type ConversionReceipt = Awaited<ReturnType<typeof runChannelConversionJob>>;

/** A fresh process reconstructs work from receipts. Per-source DB locks make
 * multiple workers safe; failed jobs stay visible until an explicit Retry. */
export async function runChannelConversionWorkerPass(
  onProgress?: (job: ConversionReceipt) => Promise<void>,
  onCommandSettled?: (sourceChannelId: string) => Promise<void>,
  revalidateExternalPrivacy?: ChannelConversionPrivacyRevalidator,
): Promise<number> {
  await runConversionCommandWorkerPass(onCommandSettled, revalidateExternalPrivacy);
  const db = getDb();
  const jobs = await db.select({ id: channelConversionJobs.id }).from(channelConversionJobs)
    .where(or(
      inArray(channelConversionJobs.status, ["pending", "running"]),
      and(inArray(channelConversionJobs.status, ["done", "canceled", "failed"]), sql`${channelConversionJobs.progress}->>'completionBroadcastAt' IS NULL`),
    ))
    .orderBy(asc(channelConversionJobs.updatedAt)).limit(8);
  for (const row of jobs) {
    const job = await runChannelConversionJob(row.id, { maxPhases: 1 });
    await onProgress?.(job);
    if ((job.status === "done" || job.status === "canceled" || job.status === "failed") && onProgress) {
      await db.update(channelConversionJobs).set({
        progress: sql`${channelConversionJobs.progress} || jsonb_build_object('completionBroadcastAt', now())`,
      }).where(and(eq(channelConversionJobs.id, job.id), eq(channelConversionJobs.conversionEpoch, job.conversionEpoch), eq(channelConversionJobs.status, job.status), eq(channelConversionJobs.updatedAt, job.updatedAt)));
    }
  }
  return jobs.length;
}

export function startChannelConversionWorker(
  onProgress: (job: ConversionReceipt) => Promise<void>,
  onCommandSettled?: (sourceChannelId: string) => Promise<void>,
  revalidateExternalPrivacy?: ChannelConversionPrivacyRevalidator,
  tracer: Tracer = noopTracer,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try {
      // Each pass is a root span. A failure also records the
      // `server.channel_conversion_worker.error` event inside it.
      await withTraceRoot(
        tracer,
        "server.channel_conversion_worker.pass",
        { surface: "server", kind: "internal" },
        () => runChannelConversionWorkerPass(onProgress, onCommandSettled, revalidateExternalPrivacy),
        "server.channel_conversion_worker.error",
      );
    } catch (error) {
      console.error("[ChannelConversionWorker] pass failed", error);
    }
    if (!stopped) { timer = setTimeout(() => { void tick(); }, 500); timer.unref(); }
  };
  void tick();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}
