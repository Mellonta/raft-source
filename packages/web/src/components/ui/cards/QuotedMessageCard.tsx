import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Hash, MessageSquare } from "lucide-react";
import {
  Badge,
  MessageQuotedPreviewAttachment,
  MessageQuotedPreviewAttachments,
  MessageQuotedPreviewAuthor,
  MessageQuotedPreviewAuthorMeta,
  MessageQuotedPreviewAuthorName,
  MessageQuotedPreviewChannel,
  MessageQuotedPreviewContent,
  MessageQuotedPreviewHeader,
  MessageQuotedPreviewText,
  MessageQuotedPreviewThread,
  MessageQuotedPreviewTimestamp,
  MessageQuotedPreviewUnavailable,
} from "raft-ui";
import type { BadgeProps } from "raft-ui";
import AvatarSlot from "../AvatarSlot";
import InlineMarkdownPreview from "../../markdown/InlineMarkdownPreview";
import PreviewShell from "../PreviewShell";

export interface QuotedMessageCardProps {
  channelName: string;
  channelKind?: "channel" | "dm";
  isThread?: boolean;
  isArchived?: boolean;
  timestamp: string;
  author: {
    name: string;
    avatar?: string;
    gravatarHash?: string;
    kind: "agent" | "user" | "external_projection";
    subtitle?: string;
  };
  content: string;
  attachments?: { label: string }[];
  onClick?: () => void;
  unavailable?: boolean;
}

export function Tag({
  children,
  className,
  variant = "muted",
}: {
  children: ReactNode;
  className?: string;
  variant?: BadgeProps["variant"];
}) {
  return (
    <Badge appearance="soft" variant={variant} uppercase={false} className={className}>
      {children}
    </Badge>
  );
}

export function ThreadMarker() {
  const intl = useIntl();
  return (
    <span className="inline-flex items-center gap-1 font-bold text-accent-strong theme-brutal:text-brutal-pink">
      <MessageSquare size={10} className="shrink-0" />
      {intl.formatMessage({ id: "ui.quotedMessage.thread" })}
    </span>
  );
}

function CompactUserAvatar({ author }: { author: QuotedMessageCardProps["author"] }) {
  if (author.kind === "agent") {
    return <AvatarSlot context="compact-list" type="agent" agentAvatarUrl={author.avatar ?? null} />;
  }

  if (author.kind === "external_projection") {
    return <AvatarSlot context="compact-list" type="app" appAvatarUrl={author.avatar ?? null} appInitials={author.name} />;
  }

  return <AvatarSlot context="compact-list" type="human" humanAvatarUrl={author.avatar ?? null} gravatarHash={author.gravatarHash ?? null} />;
}

export default function QuotedMessageCard({
  channelName,
  channelKind = "channel",
  isThread = false,
  isArchived = false,
  timestamp,
  author,
  content,
  attachments,
  onClick,
  unavailable = false,
}: QuotedMessageCardProps) {
  const intl = useIntl();
  if (unavailable) {
    return (
      <PreviewShell variant="muted" onClick={onClick} data-testid="quoted-message-card" className="group block w-full text-left">
        <MessageQuotedPreviewUnavailable className="px-2.5 py-2 sm:px-3 sm:py-2.5">
          <div className="text-[13px] leading-snug">{intl.formatMessage({ id: "ui.quotedMessage.unavailable" })}</div>
        </MessageQuotedPreviewUnavailable>
      </PreviewShell>
    );
  }

  return (
    <PreviewShell onClick={onClick} data-testid="quoted-message-card" className="group block w-full text-left">
      <div className="px-2.5 py-2 sm:px-3 sm:py-2.5">
        <MessageQuotedPreviewHeader className="mb-1 flex items-start gap-2 sm:mb-1.5">
          <div className="min-w-0 flex flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs leading-none">
            <MessageQuotedPreviewChannel className="inline-flex items-center gap-1 font-bold text-foreground-strong">
              {channelKind === "dm" ? null : <Hash size={11} className="shrink-0" />}
              {channelKind === "dm" ? `@${channelName}` : channelName}
            </MessageQuotedPreviewChannel>
            <span className="text-foreground-hint">·</span>
            <MessageQuotedPreviewAuthor className="inline-flex min-w-0 items-center gap-1.5">
              <CompactUserAvatar author={author} />
              <MessageQuotedPreviewAuthorName className="truncate font-bold text-foreground-strong">
                {author.name}
              </MessageQuotedPreviewAuthorName>
              {author.subtitle ? (
                <MessageQuotedPreviewAuthorMeta className="truncate font-mono text-[10px] text-foreground-hint">
                  {author.subtitle}
                </MessageQuotedPreviewAuthorMeta>
              ) : null}
            </MessageQuotedPreviewAuthor>
            {isThread ? (
              <>
                <span className="text-foreground-hint">·</span>
                <MessageQuotedPreviewThread>
                  <ThreadMarker />
                </MessageQuotedPreviewThread>
              </>
            ) : null}
            {isArchived ? (
              <>
                <span className="text-foreground-hint">·</span>
                <Tag variant="warning">
                  {intl.formatMessage({ id: "ui.quotedMessage.archived" })}
                </Tag>
              </>
            ) : null}
          </div>
          <MessageQuotedPreviewTimestamp className="shrink-0 font-mono text-[10px] text-foreground-hint">
            {timestamp}
          </MessageQuotedPreviewTimestamp>
        </MessageQuotedPreviewHeader>
        <MessageQuotedPreviewContent className="min-w-0">
          <MessageQuotedPreviewText className="line-clamp-2 text-xs leading-snug text-foreground-strong sm:text-[13px]">
            <InlineMarkdownPreview markdown={content} />
          </MessageQuotedPreviewText>
          {attachments?.length ? (
            <MessageQuotedPreviewAttachments className="mt-2 flex flex-wrap gap-1.5">
              {attachments.map((attachment) => (
                <MessageQuotedPreviewAttachment key={attachment.label}>
                  <Tag className="font-mono text-[10px] font-bold">
                    {attachment.label}
                  </Tag>
                </MessageQuotedPreviewAttachment>
              ))}
            </MessageQuotedPreviewAttachments>
          ) : null}
        </MessageQuotedPreviewContent>
      </div>
    </PreviewShell>
  );
}
