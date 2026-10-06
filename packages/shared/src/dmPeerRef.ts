// DM peer references with an optional explicit peer kind.
//
// A human and an agent in one server may share a name (e.g. a person and an
// agent both called `skyzh`). `dm:@skyzh` then names two different DMs, so an
// agent-facing DM target may carry the kind of the peer it means:
//
//   dm:@skyzh~agent   the DM with the agent named skyzh
//   dm:@skyzh~human   the DM with the human named skyzh
//
// `~` never occurs in a user or agent name (NAME_REGEX; production held no
// such name when this was introduced), so the suffix cannot be mistaken for
// part of a name. An unknown suffix is refused rather than read as a bare name.

export type DmPeerKind = "agent" | "human";

export const DM_PEER_KINDS: readonly DmPeerKind[] = ["agent", "human"];
export const DM_PEER_KIND_SEPARATOR = "~";
export const DM_PEER_KIND_SUFFIX_PATTERN = String.raw`~(?:agent|human)`;

export type ParsedDmPeerRef =
  | { ok: true; peerName: string; peerKind: DmPeerKind | null }
  | { ok: false; reason: "unknown_peer_kind" | "empty_peer_name"; suffix?: string };

export function isDmPeerKind(value: unknown): value is DmPeerKind {
  return value === "agent" || value === "human";
}

/** Parse the part of a DM target after `dm:@` (and before any `:<short>` thread suffix). */
export function parseDmPeerRef(raw: string): ParsedDmPeerRef {
  const separator = raw.indexOf(DM_PEER_KIND_SEPARATOR);
  if (separator === -1) {
    return raw.length > 0 ? { ok: true, peerName: raw, peerKind: null } : { ok: false, reason: "empty_peer_name" };
  }
  const peerName = raw.slice(0, separator);
  const suffix = raw.slice(separator + 1);
  if (peerName.length === 0) return { ok: false, reason: "empty_peer_name" };
  if (!isDmPeerKind(suffix)) return { ok: false, reason: "unknown_peer_kind", suffix };
  return { ok: true, peerName, peerKind: suffix };
}

/** Inverse of parseDmPeerRef: `skyzh` or `skyzh~agent`. */
export function formatDmPeerRef(peerName: string, peerKind: DmPeerKind | null): string {
  return peerKind ? `${peerName}${DM_PEER_KIND_SEPARATOR}${peerKind}` : peerName;
}
