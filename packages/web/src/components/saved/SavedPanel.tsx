import { copyTextToClipboard } from "../../utils/clipboard";
import { memo, useCallback, useEffect, useRef } from "react";
import { useIntl } from "react-intl";
import { Bookmark, Copy, Link, MessageSquare } from "lucide-react";
import {
  Card,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  PanelToggleAction,
} from "raft-ui";
import { useSavedStore } from "../../store/savedStore";
import type { SavedEntry } from "../../store/savedStore";
import { useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import { useThreadStore } from "../../store/threadStore";
import { useAppNavigate, useMobileBack, buildMessagePermalink } from "../../hooks/useAppNavigate";
import { resolveMessageSenderMemberFromList } from "../../utils/messageSenderMember";
import { formatRelativeTime } from "../../utils/relativeTime";
import AvatarSlot from "../ui/AvatarSlot";
import PanelHeader from "../ui/PanelHeader";
import EmptyState from "../ui/EmptyState";
import { ConversationCardSkeleton } from "../ui/Skeleton";

const SavedItem = memo(function SavedItem({ entry, onOpenEntry, onRemoveMessage, onDragEntry, serverSlug }: {
  entry: SavedEntry;
  onOpenEntry: (entry: SavedEntry) => void;
  onRemoveMessage: (messageId: string) => void;
  onDragEntry?: (event: React.DragEvent<HTMLButtonElement>, entry: SavedEntry) => void;
  serverSlug: string | undefined;
}) {
  const { formatMessage, locale } = useIntl();
  const agents = useAgentStore((s) => s.agents);
  const members = useServerStore((s) => s.members);
  const currentUser = useAuthStore((s) => s.user);

  const isThread = entry.channelType === "thread";
  const isDm = isThread
    ? entry.parentChannelType === "dm"
    : entry.channelType === "dm";
  const sourceChannelName = isThread
    ? entry.parentChannelName
    : entry.channelName;
  const channelLabel = isDm
    ? `@${entry.senderName || entry.senderId}`
    : `#${sourceChannelName}`;

  const senderAgent = entry.senderType === "agent"
    ? agents.find((a) => a.id === entry.senderId)
    : null;
  const senderMember = entry.senderType === "user"
    ? resolveMessageSenderMemberFromList({ senderType: "user", senderId: entry.senderId }, members, currentUser) ?? null
    : null;
  const senderName = senderAgent?.displayName ?? senderAgent?.name ?? senderMember?.displayName ?? senderMember?.name ?? entry.senderName;

  const handleCopyLink = useCallback(() => {
    if (!serverSlug) return;
    const channelForLink = isThread ? entry.parentChannelId || entry.channelId : entry.channelId;
    const routeKind = isDm ? "dm" : "channel";
    const url = buildMessagePermalink(serverSlug, channelForLink, entry.messageId, {
      routeKind,
      threadParentMessageId: isThread ? entry.parentMessageId : null,
    });
    copyTextToClipboard(url);
  }, [serverSlug, isDm, isThread, entry.parentChannelId, entry.parentMessageId, entry.channelId, entry.messageId]);

  const handleCopyMarkdown = useCallback(() => {
    copyTextToClipboard(entry.content);
  }, [entry.content]);

  const handleRemove = useCallback(() => {
    onRemoveMessage(entry.messageId);
  }, [entry.messageId, onRemoveMessage]);

  const handleRemoveButtonClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onRemoveMessage(entry.messageId);
  }, [entry.messageId, onRemoveMessage]);

  const handleOpen = useCallback(() => {
    onOpenEntry(entry);
  }, [entry, onOpenEntry]);

  const handleDragStart = useCallback((event: React.DragEvent<HTMLButtonElement>) => {
    onDragEntry?.(event, entry);
  }, [entry, onDragEntry]);

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <Card
            render={<div role="button" tabIndex={0} />}
            onClick={handleOpen}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                handleOpen();
              }
            }}
            draggable={!!onDragEntry}
            onDragStart={onDragEntry ? (event) => handleDragStart(event as unknown as React.DragEvent<HTMLButtonElement>) : undefined}
            className="relative flex flex-row items-center gap-3 transition-colors p-3 text-left w-full shadow-none border-line-muted theme-brutal:border-2 theme-brutal:border-black bg-layer-panel theme-brutal:bg-white hover:bg-fill-muted data-[popup-open]:bg-fill-muted"
          />
        }
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1 text-xs">
            <span className="font-bold text-foreground-muted theme-brutal:text-black/50">{channelLabel}</span>
            {isThread && (
              <span className="inline-flex items-center gap-1 font-bold text-foreground-muted theme-brutal:text-black/40">
                <MessageSquare size={10} />
                {formatMessage({ id: "saved.threadLabel" })}
              </span>
            )}
            {senderName && (
              <span className="inline-flex items-center gap-1 font-bold text-foreground-strong theme-brutal:text-black">
                {senderAgent ? (
                  <AvatarSlot context="preview-mini" type="agent" agentAvatarUrl={senderAgent.avatarUrl ?? null} />
                ) : entry.senderType === "external_projection" ? (
                  <AvatarSlot context="preview-mini" type="app" appAvatarUrl={entry.senderAvatarUrl} appInitials={senderName} />
                ) : (
                  <AvatarSlot context="preview-mini" type="human" humanAvatarUrl={senderMember?.avatarUrl} gravatarHash={senderMember?.gravatarHash} />
                )}
                <span>{senderName}</span>
              </span>
            )}
            <span className="text-xs text-foreground-muted font-mono theme-brutal:text-black/40">
              {formatRelativeTime(entry.createdAt, locale) ?? ""}
            </span>
          </div>
          <p className="text-sm line-clamp-3">
            {entry.content}
          </p>
        </div>
        <div className="ml-auto shrink-0 self-center">
          <PanelToggleAction
            pressed
            onKeyDown={(event) => event.stopPropagation()}
            onClick={handleRemoveButtonClick}
            aria-label={formatMessage({ id: "saved.remove" })}
            className="data-pressed:text-accent-strong theme-brutal:data-pressed:text-brutal-orange data-pressed:bg-accent-soft/30"
          >
            <Bookmark size={14} fill="currentColor" className="text-accent-strong theme-brutal:text-brutal-orange" aria-hidden />
          </PanelToggleAction>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent>
        <ContextMenuItem onClick={handleCopyLink}>
          <Link size={14} />
          <span>{formatMessage({ id: "saved.copyLink" })}</span>
        </ContextMenuItem>
        <ContextMenuItem onClick={handleCopyMarkdown}>
          <Copy size={14} />
          <span>{formatMessage({ id: "saved.copyMarkdown" })}</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleRemove}>
          <Bookmark size={14} />
          <span>{formatMessage({ id: "saved.remove" })}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

export default function SavedPanel({ onOpenEntry, onDragEntry, embedded = false }: {
  onOpenEntry?: (entry: SavedEntry) => void;
  onDragEntry?: (event: React.DragEvent<HTMLButtonElement>, entry: SavedEntry) => void;
  /** Embedded hosts own the surrounding panel header and navigation. */
  embedded?: boolean;
} = {}) {
  const { formatMessage } = useIntl();
  const saved = useSavedStore((s) => s.saved);
  // True total (server count), not the loaded-so-far page length — the panel
  // header has room for the exact number (the sidebar badge caps at 99+).
  const savedTotal = useSavedStore((s) => s.total);
  const loadSaved = useSavedStore((s) => s.loadSaved);
  const loadMore = useSavedStore((s) => s.loadMore);
  const hasMore = useSavedStore((s) => s.hasMore);
  const loading = useSavedStore((s) => s.loading);
  const unsaveMessage = useSavedStore((s) => s.unsaveMessage);
  const openThread = useThreadStore((s) => s.openThread);
  const serverSlug = useServerStore((s) => s.current?.slug);
  const serverId = useServerStore((s) => s.current?.id);
  const onMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}` : "/");
  const nav = useAppNavigate();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);

  const openSavedEntry = useCallback((entry: SavedEntry) => {
    if (onOpenEntry) {
      onOpenEntry(entry);
      return;
    }
    if (entry.channelType === "thread" && entry.parentChannelId && entry.parentMessageId) {
      nav.toMessage(entry.parentChannelId, entry.parentMessageId);
      // Stryker disable all: typed thread payload shape is covered by openThread payload/source contracts.
      void openThread({
        parentChannelId: entry.parentChannelId,
        parentMessageId: entry.parentMessageId,
        focusedMessageId: entry.messageId,
      });
      // Stryker restore all
    } else {
      nav.toMessage(entry.channelId, entry.messageId);
    }
  }, [nav, onOpenEntry, openThread]);

  const removeSavedMessage = useCallback((messageId: string) => {
    void unsaveMessage(messageId);
  }, [unsaveMessage]);

  useEffect(() => {
    // The route can mount one render before ServerResolver selects the URL's
    // server.  An early request has no X-Server-Id and is rejected/empty;
    // retry when the authoritative server context arrives so a refresh cannot
    // make an existing Saved row appear to disappear permanently.
    if (!serverId) return;
    void loadSaved({ query: "", sortDirection: "desc" });
  }, [loadSaved, serverId]);

  useEffect(() => {
    if (!hasMore || loading || saved.length === 0) return;
    if (typeof IntersectionObserver === "undefined") return;
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMore();
        }
      },
      {
        root: scrollerRef.current,
        rootMargin: "240px 0px",
        threshold: 0,
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadMore, loading, saved.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-layer-canvas-muted theme-brutal:bg-white">
      {!embedded ? (
        <PanelHeader
          title={formatMessage({ id: "saved.header.title" })}
          subtitle={formatMessage({ id: "saved.header.subtitle" }, { count: savedTotal })}
          icon={<Bookmark size={18} />}
          iconBg="bg-primary-soft"
          onMobileBack={onMobileBack}
        />
      ) : null}

      {/* Saved list */}
      <div
        ref={scrollerRef}
        data-testid="saved-list-scroller"
        className="flex-1 overflow-y-auto bg-layer-canvas-muted p-4 safe-bottom theme-brutal:bg-white"
      >
        {loading && saved.length === 0 ? (
          <ConversationCardSkeleton />
        ) : saved.length === 0 ? (
          <EmptyState
            className="flex h-full flex-col items-center justify-center"
            icon={<Bookmark size={36} />}
            title={formatMessage({ id: "emptyState.noSavedTitle" })}
            description={formatMessage({ id: "saved.emptyDescription" })}
          />
        ) : (
          <div className="flex flex-col gap-2">
            {saved.map((entry) => (
              <SavedItem
                key={entry.messageId}
                entry={entry}
                serverSlug={serverSlug}
                onOpenEntry={openSavedEntry}
                onRemoveMessage={removeSavedMessage}
                onDragEntry={onDragEntry}
              />
            ))}
            {hasMore && (
              <div
                ref={loadMoreSentinelRef}
                data-testid="saved-infinite-scroll-sentinel"
                className="flex min-h-10 items-center justify-center py-3"
                aria-live="polite"
              >
                {loading ? (
                  <span className="text-xs font-bold text-foreground-muted">{formatMessage({ id: "common.loading" })}</span>
                ) : (
                  <span className="sr-only">{formatMessage({ id: "saved.loadingMore" })}</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
