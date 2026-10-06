export function getChannelUnreadIndicatorState(opts: {
  unread: number;
  joined: boolean;
  showMutedIcon: boolean;
  /**
   * The unread summary's `hasNew`: a non-joined public channel with messages past
   * the cursor. It has no exact count (unread is 0), so it only lights the quiet
   * indicator of a non-joined row.
   */
  hasNew?: boolean;
}): { showLoudUnreadBadge: boolean; showQuietUnreadCount: boolean; showQuietNewDot: boolean } {
  const showLoudUnreadBadge = opts.unread > 0 && opts.joined && !opts.showMutedIcon;
  const showQuietUnreadCount = opts.unread > 0 && (!opts.joined || opts.showMutedIcon);
  const showQuietNewDot = !showQuietUnreadCount && !opts.joined && opts.hasNew === true;
  return { showLoudUnreadBadge, showQuietUnreadCount, showQuietNewDot };
}

export function shouldShowActivityMutedIcon(opts: {
  activityMuted: boolean | undefined;
  joined: boolean | undefined;
}): boolean {
  return opts.activityMuted === true && opts.joined === true;
}

export type SectionUnreadChannel = {
  id: string;
  activityMuted?: boolean;
};

export function hasUnmutedUnread(
  unreadCounts: Readonly<Record<string, number>>,
  channels: ReadonlyArray<SectionUnreadChannel | undefined>,
): boolean {
  return channels.some((channel) => (
    channel !== undefined
    && channel.activityMuted !== true
    && (unreadCounts[channel.id] ?? 0) > 0
  ));
}
