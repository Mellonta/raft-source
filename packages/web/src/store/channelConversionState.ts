import { conversionStateBlocksSending, projectConversionState } from "@botiverse/raft-shared";
import type { ChannelConversionState } from "@botiverse/raft-shared";
import type { Channel } from "./channelStore";
import type { ConversionAttemptBaseline, PendingConversionCommand } from "./conversionObservationStore";

type ConversionFields = Pick<Channel, "conversionState" | "conversionCommand" | "conversionJob">;

/** Prefer the server projection. Old-server payloads cross this single adapter;
 * consumers never merge legacy fields into an already-authoritative snapshot. */
export function channelConversionState(channel: ConversionFields | null | undefined): ChannelConversionState {
  return channel?.conversionState ?? projectConversionState(channel?.conversionCommand, channel?.conversionJob);
}

export function conversionResponseState(payload: ConversionFields & { channel?: ConversionFields }): ChannelConversionState {
  return payload.conversionState ?? payload.channel?.conversionState ?? projectConversionState(
    payload.conversionCommand ?? payload.channel?.conversionCommand,
    payload.conversionJob ?? payload.channel?.conversionJob,
  );
}

function isLaterCommand(state: ChannelConversionState, pending: PendingConversionCommand): boolean {
  const command = state.command;
  return !!command && (command.id === pending.token
    || (pending.previousCommandId !== undefined && command.id !== pending.previousCommandId));
}

/** A request without a conclusive receipt remains an observation, not a made-up
 * server job. Retain the existing local correlation across refresh/response loss. */
export function isChannelConversionBlocked(channel: Channel | undefined, pending: PendingConversionCommand | null): boolean {
  const state = channelConversionState(channel);
  const { job, command } = state;
  if (conversionStateBlocksSending(state)) return true;
  if (!pending) return false;
  if (command?.id === pending.token && command.status === "failed") return false;
  // New projections include historical terminal jobs. Those cannot resolve a
  // new Start while its request might still be waiting to reach admission.
  const terminalIsCurrent = !channel?.conversionState || isLaterCommand(state, pending)
    || (pending.baseline?.id === job?.id && pending.baseline?.status !== job?.status);
  if (terminalIsCurrent && job && (job.status === "done" || job.status === "canceled")
    && (pending.kind === "start" ? job.id !== pending.baseline?.id
      : pending.jobId === job.id && pending.baseline?.status !== job.status)) return false;
  if (command?.status === "completed" && isLaterCommand(state, pending)
    && (command.kind === "cancel" || channel?.type === "joint")) return false;
  return true;
}

/** Interpret a fresh read once for both Settings layouts. "unconfirmed" is
 * transport/command correlation, never a persisted conversion state. */
export function conversionObservationResult(
  channel: Channel,
  pending: PendingConversionCommand | null,
  baseline: ConversionAttemptBaseline | null,
): "pending" | "canceled" | "done" | "commandFailed" | "unconfirmed" | "job" {
  const state = channelConversionState(channel);
  const { command, job } = state;
  if (state.status === "pending") return "pending";
  if (command?.status === "failed" && command.id === pending?.token) return "commandFailed";
  const currentCommand = !pending || isLaterCommand(state, pending);
  const newJobOutcome = !!job && baseline?.id === job.id && baseline.status !== job.status;
  const currentTerminal = currentCommand || newJobOutcome;
  // The server read model has terminal jobs. Old servers may only supply a
  // completed command and the changed channel type; keep that rolling adapter.
  if (currentTerminal && command?.status === "completed" && !job) {
    if (command.kind === "cancel") return "canceled";
    if (channel.type === "joint") return "done";
  }
  if (currentTerminal && job?.status === "canceled") return "canceled";
  if (currentTerminal && job?.status === "done") return "done";
  const unchangedFailure = job?.status === "failed" && baseline?.status === "failed"
    && job.id === baseline.id
    && job.progress?.failedAt === baseline.progress?.failedAt
    && job.progress?.relockedAt === baseline.progress?.relockedAt;
  if (unchangedFailure || !job || job.status === "done" || job.status === "canceled") {
    // Old servers omit terminal jobs. Preserve their established Joint cutover
    // adapter; a new projection must supply the actual terminal job instead.
    if (!channel.conversionState && !job && channel.type === "joint") return "done";
    return "unconfirmed";
  }
  return "job";
}
