/** Public read model for Channel → Joint. Commands acknowledge one action;
 * jobs describe the longer-lived conversion. Neither completion implies the other. */
export interface ChannelConversionCommandView {
  id: string;
  kind: "start" | "retry" | "cancel";
  status: "pending" | "completed" | "failed";
  jobId?: string | null;
  error?: string | null;
  createdAt?: string;
}

export interface ChannelConversionJobView {
  id: string;
  status: "pending" | "running" | "failed" | "done" | "canceled";
  phase: string;
  canCancel?: boolean;
  // Existing phase-specific wire payload, retained for protocol compatibility.
  progress?: Record<string, unknown>;
  error?: string | null;
}

type ConversionCommand = ChannelConversionCommandView | null;
export type ChannelConversionState =
  | { status: "idle"; command: ConversionCommand; job: null }
  | { status: "pending"; command: ChannelConversionCommandView; job: ChannelConversionJobView | null }
  | { status: "running"; command: ConversionCommand; job: ChannelConversionJobView }
  | { status: "failed"; command: ConversionCommand; job: ChannelConversionJobView | null }
  | { status: "canceled" | "done"; command: ConversionCommand; job: ChannelConversionJobView };

export function isActiveChannelConversionJob(job: { status: string } | null | undefined): boolean {
  if (!job) return false;
  if (job.status === "failed" && typeof (job as { progress?: unknown }).progress === "object"
    && (job as { progress?: Record<string, unknown> }).progress?.rollbackState === "restored") return false;
  return job.status === "pending" || job.status === "running" || job.status === "failed";
}

/** One interpretation for server reads and the old-server client adapter.
 * Transport uncertainty is deliberately absent: a failed GET is not a job failure.
 * The server supplies the current job (active first, otherwise latest terminal).
 */
export function projectConversionState(
  command: ChannelConversionCommandView | null | undefined,
  job: ChannelConversionJobView | null | undefined,
): ChannelConversionState {
  command = command ?? null;
  job = job ?? null;
  // A newly admitted Retry/Cancel must not settle from the preceding job snapshot.
  if (command?.status === "pending") return { status: "pending", command, job };
  if (job) {
    switch (job.status) {
      case "pending":
      case "running": return { status: "running", command, job };
      case "failed": return { status: "failed", command, job };
      case "canceled": return { status: "canceled", command, job };
      case "done": return { status: "done", command, job };
    }
  }
  // Admission failure does not mean that the source was fenced. In particular,
  // a rejected command must not override an existing active job above.
  if (command?.status === "failed") return { status: "failed", command, job: null };
  return { status: "idle", command, job: null };
}

/** Conversion-specific write block only; callers still enforce archive/RBAC. */
export function conversionStateBlocksSending(state: ChannelConversionState): boolean {
  return state.status === "pending" || isActiveChannelConversionJob(state.job);
}
