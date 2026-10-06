import { useEffect, useState } from "react";
import type { IntlShape } from "react-intl";
import { MAX_JOINT_CHANNEL_SERVERS } from "@botiverse/raft-shared";

// Contract v0.3 §18.8. The server computes `jointBillingLocked` when it builds
// channel metadata and never pushes a flip at the deadline, so a snapshot
// fetched during the grace period stays `false` after it ends. Clients compare
// the deadline against their own clock; the server still rejects writes with
// its own clock, so skew only moves the banner by the skew.
type JointLimitFields = {
  type?: string;
  jointBillingLocked?: boolean | null;
  jointOverLimitGraceEndsAt?: string | null;
};

export function isJointChannelReadOnly(channel: JointLimitFields | null | undefined, nowMs: number = Date.now()): boolean {
  if (!channel || channel.type !== "joint") return false;
  if (channel.jointBillingLocked === true) return true;
  const deadline = channel.jointOverLimitGraceEndsAt ? Date.parse(channel.jointOverLimitGraceEndsAt) : Number.NaN;
  return Number.isFinite(deadline) && nowMs >= deadline;
}

/** Grace deadline while over the limit and not yet read-only; null otherwise. */
export function jointChannelGraceEndsAt(channel: JointLimitFields | null | undefined, nowMs: number = Date.now()): string | null {
  if (!channel || channel.type !== "joint" || !channel.jointOverLimitGraceEndsAt) return null;
  return isJointChannelReadOnly(channel, nowMs) ? null : channel.jointOverLimitGraceEndsAt;
}

/**
 * Re-render once when the grace deadline passes, so an open channel switches
 * from the grace banner to read-only without waiting for new metadata.
 */
export function useRerenderAtJointDeadline(deadline: string | null | undefined): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!deadline) return;
    const delay = Date.parse(deadline) - Date.now();
    if (!Number.isFinite(delay) || delay < 0) return;
    // setTimeout caps at ~24.8 days; the grace is 3 days, so one timer suffices.
    const timer = setTimeout(() => setTick((tick) => tick + 1), delay + 50);
    return () => clearTimeout(timer);
  }, [deadline]);
}

/**
 * Message for a failed joint invite accept. Limit codes get their localized
 * copy; anything else falls back to the server's text, then a generic line.
 */
export function jointInviteAcceptErrorMessage(
  err: unknown,
  formatMessage: IntlShape["formatMessage"],
): string {
  const data = (err as { response?: { data?: { error?: unknown; code?: unknown } } } | null)?.response?.data;
  if (data?.code === "joint_free_server_limit") return formatMessage({ id: "channel.joint.freeServerLimit" });
  if (data?.code === "joint_server_limit") {
    return formatMessage({ id: "channel.joint.serverLimit" }, { max: MAX_JOINT_CHANNEL_SERVERS });
  }
  if (typeof data?.error === "string" && data.error.trim()) return data.error;
  return formatMessage({ id: "channel.joint.acceptFailed" });
}
