import { formatDmPeerRef } from "@botiverse/raft-shared";

import { AGENT_REMINDERS_NOT_SENDABLE_MESSAGE } from "./agentPrivateSurfaces";

export type DmTargetResolutionErrorCode = "DM_TARGET_AMBIGUOUS" | "DM_TARGET_INVALID_PEER_KIND" | "DM_TARGET_NOT_SENDABLE";

/**
 * A DM target that cannot be resolved to one conversation for a reason the
 * caller can fix, as opposed to "no such DM". Thrown by
 * channelService.resolveChannelByName so every agent-facing entry reports it
 * instead of collapsing it to not-found; globalJsonServerErrorHandler renders
 * it as `{ error, code }` with its 4xx status.
 */
export class DmTargetResolutionError extends Error {
  readonly status: 400 | 403 | 409;

  constructor(
    readonly code: DmTargetResolutionErrorCode,
    message: string,
    /** One-line, caller-actionable fix, stable across releases. */
    readonly suggestedNextAction: string,
  ) {
    super(message);
    this.name = "DmTargetResolutionError";
    this.status = code === "DM_TARGET_AMBIGUOUS" ? 409 : code === "DM_TARGET_NOT_SENDABLE" ? 403 : 400;
  }

  /** The JSON body every route answers with. */
  toResponseBody(): { error: string; code: DmTargetResolutionErrorCode; suggestedNextAction: string } {
    return { error: this.message, code: this.code, suggestedNextAction: this.suggestedNextAction };
  }

  static ambiguous(peerName: string): DmTargetResolutionError {
    const agentRef = `dm:@${formatDmPeerRef(peerName, "agent")}`;
    const humanRef = `dm:@${formatDmPeerRef(peerName, "human")}`;
    return new DmTargetResolutionError(
      "DM_TARGET_AMBIGUOUS",
      `dm:@${peerName} matches both a human and an agent named ${peerName}. `
        + `Name the one you mean: ${agentRef} for the agent, or ${humanRef} for the human `
        + `(for example: raft message read --target "${agentRef}").`,
      `retry with ${agentRef} for the agent or ${humanRef} for the human`,
    );
  }

  /** dm:@reminders is read-only for its agent: reminders are acted on at their anchor. */
  static privateReminderSurface(): DmTargetResolutionError {
    return new DmTargetResolutionError(
      "DM_TARGET_NOT_SENDABLE",
      AGENT_REMINDERS_NOT_SENDABLE_MESSAGE,
      "send to the reminder's anchor target instead of dm:@reminders",
    );
  }

  static invalidPeerKind(rawPeer: string, suffix: string | undefined): DmTargetResolutionError {
    return new DmTargetResolutionError(
      "DM_TARGET_INVALID_PEER_KIND",
      `dm:@${rawPeer} has an unknown peer kind${suffix !== undefined ? ` "${suffix}"` : ""}. `
        + "Use dm:@<name>, dm:@<name>~agent or dm:@<name>~human.",
      "retry with dm:@<name>, dm:@<name>~agent or dm:@<name>~human",
    );
  }
}
