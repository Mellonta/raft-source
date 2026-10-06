import { formatDmPeerRef, isDmPeerKind, parseDmPeerRef, type DmPeerKind } from "@botiverse/raft-shared";

import { CliError } from "../core/errors";

export interface TargetAliasOpts {
  target?: string;
  channel?: string;
  peerKind?: string;
}

/**
 * `--peer-kind agent|human`: which DM is meant when a human and an agent in
 * the server share a name. Same as writing `dm:@name~agent` /
 * `dm:@name~human` in the target; see dmPeerRef in shared.
 */
export const PEER_KIND_OPTION = {
  flags: "--peer-kind <kind>",
  description:
    "For a DM target whose name a human and an agent share: 'agent' or 'human' (same as dm:@name~agent / dm:@name~human)",
} as const;

const DM_PREFIX_RE = /^dm:@/i;
const THREAD_SUFFIX_RE = /:([0-9a-f]{8})$/i;

/**
 * Apply `--peer-kind` to a target. Refuses a non-DM target, an unknown kind,
 * and a kind that contradicts one already written in the target; the same
 * kind written both ways is accepted. Without `--peer-kind` the target is
 * returned unchanged.
 */
export function applyDmPeerKind(target: string, rawKind: string | undefined): string {
  if (rawKind === undefined) return target;
  const kind = rawKind.trim().toLowerCase();
  if (!isDmPeerKind(kind)) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `--peer-kind must be 'agent' or 'human'; got ${rawKind}`,
    });
  }
  if (!DM_PREFIX_RE.test(target)) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `--peer-kind only applies to DM targets (dm:@name or dm:@name:<id>); got ${target}`,
    });
  }
  const prefix = target.slice(0, 4);
  const rest = target.slice(4);
  const thread = THREAD_SUFFIX_RE.exec(rest);
  const rawPeer = thread ? rest.slice(0, thread.index) : rest;
  const threadSuffix = thread ? thread[0] : "";
  const parsed = parseDmPeerRef(rawPeer);
  if (!parsed.ok) {
    throw new CliError({
      code: "INVALID_ARG",
      message: parsed.reason === "empty_peer_name"
        ? `DM target has no peer name: ${target}`
        : `DM target has an unknown peer kind "${parsed.suffix ?? ""}": ${target}. Use dm:@<name>~agent or dm:@<name>~human.`,
    });
  }
  if (parsed.peerKind !== null && parsed.peerKind !== kind) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `--peer-kind ${kind} contradicts the target ${target}, which already names the ${parsed.peerKind}. Drop one of them.`,
    });
  }
  return `${prefix}${formatDmPeerRef(parsed.peerName, kind as DmPeerKind)}${threadSuffix}`;
}

export function resolveTargetAlias(opts: TargetAliasOpts): string | undefined {
  const target = opts.target?.trim();
  const legacyChannel = opts.channel?.trim();
  if (target && legacyChannel && target !== legacyChannel) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "--target and legacy --channel must refer to the same target when both are provided",
    });
  }
  const resolved = target || legacyChannel || undefined;
  if (resolved === undefined) {
    if (opts.peerKind !== undefined) {
      throw new CliError({ code: "INVALID_ARG", message: "--peer-kind needs a DM --target" });
    }
    return undefined;
  }
  return applyDmPeerKind(resolved, opts.peerKind);
}

export function requireTargetAlias(opts: TargetAliasOpts): string {
  const target = resolveTargetAlias(opts);
  if (!target) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "--target is required (legacy --channel is accepted during the transition)",
    });
  }
  return target;
}
