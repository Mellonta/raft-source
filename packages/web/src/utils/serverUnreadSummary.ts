export interface ServerUnreadSummary {
  unreadCount: number;
  serverPushMuted: boolean;
  /** Present only when the server proved the Activity count is known. */
  activityUnreadCount?: number;
}

export function parseServerUnreadSummaryRows(data: unknown): Record<string, ServerUnreadSummary> {
  const next: Record<string, ServerUnreadSummary> = {};
  if (!Array.isArray(data)) return next;

  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const entry = row as {
      serverId?: unknown;
      unreadCount?: unknown;
      serverPushMuted?: unknown;
      activityUnreadCount?: unknown;
    };
    const serverId = typeof entry.serverId === "string" ? entry.serverId : null;
    const unreadCount = Number(entry.unreadCount);
    if (!serverId || !Number.isFinite(unreadCount)) continue;

    const activityUnreadCount = entry.activityUnreadCount;
    next[serverId] = {
      unreadCount: Math.max(0, Math.floor(unreadCount)),
      serverPushMuted: entry.serverPushMuted === true,
      ...(typeof activityUnreadCount === "number"
        && Number.isSafeInteger(activityUnreadCount)
        && activityUnreadCount >= 0
        ? { activityUnreadCount }
        : {}),
    };
  }

  return next;
}

export function hasOtherServerLoudUnread(
  servers: Array<{ id: string }>,
  currentServer: { id: string } | null | undefined,
  unreadSummaryByServerId: Record<string, ServerUnreadSummary>,
): boolean {
  const currentServerId = currentServer?.id;
  return servers.some((server) => {
    const summary = unreadSummaryByServerId[server.id];
    return server.id !== currentServerId && (summary?.unreadCount ?? 0) > 0 && !summary?.serverPushMuted;
  });
}

/** Cross-server Activity attention uses only the known server-authority field. */
export function hasOtherServerActivityUnread(
  servers: Array<{ id: string }>,
  currentServer: { id: string } | null | undefined,
  unreadSummaryByServerId: Record<string, ServerUnreadSummary>,
): boolean {
  const currentServerId = currentServer?.id;
  return servers.some((server) => {
    const summary = unreadSummaryByServerId[server.id];
    return server.id !== currentServerId && (summary?.activityUnreadCount ?? 0) > 0;
  });
}

/**
 * Resolve the current server's Activity dot without mixing two snapshots.
 *
 * Before Activity has accepted its first window, the cross-server summary and
 * the optimistic active count are the only available hints. Once a window is
 * accepted, its server-wide total is authoritative until the Activity identity
 * is hard-reset. A background refresh may temporarily clear its generation
 * receipt, but must not make an older summary authoritative again. In
 * particular, an older summary must not resurrect a dot after mark-read /
 * mark-all-read changed the accepted window total to zero.
 */
export function hasCurrentServerActivityUnread(input: {
  hasAcceptedWindow: boolean;
  hasTotalUnread: boolean;
  hasPreloadActiveUnread: boolean;
  summaryUnreadCount?: number;
}): boolean {
  if (input.hasAcceptedWindow) return input.hasTotalUnread;
  return input.hasPreloadActiveUnread || (input.summaryUnreadCount ?? 0) > 0;
}

/** Preserve the caller's snapshot when a cross-server reconciliation is unchanged. */
export function retainServerUnreadSummary(
  previous: Record<string, ServerUnreadSummary>,
  next: Record<string, ServerUnreadSummary>,
): Record<string, ServerUnreadSummary> {
  const ids = Object.keys(next);
  if (ids.length !== Object.keys(previous).length) return next;
  return ids.every((id) => {
    const before = previous[id];
    const after = next[id];
    return before && before.unreadCount === after.unreadCount
      && before.serverPushMuted === after.serverPushMuted
      && before.activityUnreadCount === after.activityUnreadCount;
  }) ? previous : next;
}
