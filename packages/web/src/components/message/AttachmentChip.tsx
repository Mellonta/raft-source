import { Download, Eye, MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import type { Message } from "../../store/messageStore";
import AttachmentTooltip from "./attachmentTooltip";
import {
  MessageAttachmentAction,
  MessageAttachmentCard,
  MessageAttachmentMeta,
  MessageAttachmentMetaEnd,
  MessageAttachmentSummary,
  MessageAttachmentTitle,
  Spinner,
} from "raft-ui";
import { AttachmentTypeBadge } from "./AttachmentTypeBadge";

type MessageAttachment = NonNullable<Message["attachments"]>[number];

// `variant` is retained for callsite compatibility but the visual layout is
// now unified across types. stdrc 2026-05-20 #proj-theme:441c8b2b: "包括整个
// 不同的 attachment chip 内容物的 layout 和字体大小也全都要统一" — both compact
// and wide now render the same canonical chip (filename / meta / optional
// summary stacked vertically). The exception is the inline image gallery
// (separate surface, see `buildImageGalleryRows` in MessageItem) which keeps
// its preview-image-in-top-left layout per stdrc's exception.
//
// 2026-09-23 (task #640 follow-up, Artea): the shell migrated from the
// hand-rolled PreviewShell card to RUI's MessageAttachment recipe family —
// the RUI card carries no brutal hard shadow (`border-black/15 bg-white
// hover:border-black/30 hover:bg-ink-2`), which is the visual this chip was
// always supposed to have. Actions now live in the RUI meta row
// (MetaEnd) instead of an absolutely-positioned corner box. QuotedMessageCard
// keeps using PreviewShell — its hover alignment contract is untouched.
type AttachmentChipVariant = "compact" | "wide";

interface AttachmentChipProps {
  attachment: MessageAttachment;
  /** Retained for callsite compatibility. Layout is unified across variants;
   *  only the message-flow grouping differs. */
  variant: AttachmentChipVariant;
  isOptimistic: boolean;
  loading?: boolean;
  loadingLabel?: string;
  onClick?: () => void;
  affordance?: "download" | "preview" | "none";
  affordanceName?: string;
  meta?: ReactNode;
  summary?: ReactNode;
  secondaryDownload?: {
    onClick: () => void;
    label: string;
    affordanceName?: string;
  };
  /** Unused under the unified layout; retained for callsite compatibility. */
  icon?: ReactNode;
  /** Overrides the accessible name; defaults to the filename. */
  ariaLabel?: string;
}

// Layout-only token (border / bg / hover / active come from the RUI
// MessageAttachmentCard recipe). messageAttachmentChip width-contract guards
// (w-44 / min-w-44 / max-w-44 / shrink-0 / overflow-hidden) still live here and
// are passed to the card as className; the contract test pins this literal.
const COMPACT_CHIP_LAYOUT = "group/img relative inline-flex h-20 w-44 min-w-44 max-w-44 shrink-0 flex-col justify-between overflow-hidden px-2.5 py-2 text-left transition-colors";
// Wide-variant alias preserved for downstream width-contract callers.
const WIDE_CHIP_LAYOUT = COMPACT_CHIP_LAYOUT;

function TruncatedAttachmentTooltip({
  content,
  className,
  affordance,
  children,
}: {
  content: ReactNode;
  className: string;
  affordance: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  const measure = useCallback(() => {
    const node = ref.current;
    setIsTruncated(Boolean(node && node.scrollWidth > node.clientWidth + 1));
  }, []);

  useEffect(() => {
    measure();
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  const text = (
    <span
      ref={ref}
      data-message-affordance={affordance}
      className={className}
      onMouseEnter={measure}
    >
      {children}
    </span>
  );

  if (!isTruncated) return text;
  return <AttachmentTooltip content={content}>{text}</AttachmentTooltip>;
}

export function AttachmentChip({
  attachment,
  variant: _variant,
  isOptimistic,
  loading = false,
  loadingLabel,
  onClick,
  affordance = "none",
  affordanceName,
  meta,
  summary,
  secondaryDownload,
  icon: _icon,
  ariaLabel,
}: AttachmentChipProps) {
  const { formatMessage } = useIntl();
  const resolvedLoadingLabel = loadingLabel ?? formatMessage({ id: "message.attachment.openingPreview" });
  const disabled = isOptimistic || loading || !onClick;
  // Per-state overrides on top of the RUI card recipe. Loading uses a solid
  // tint via Tailwind's important modifier without any opacity modifier so it
  // sidesteps the Chromium `color-mix(in oklab, …, transparent)` ×
  // element-opacity cyan-rendering edge case; the loading bar + spinner remain
  // the dominant busy signal regardless.
  const stateClassName = isOptimistic
    ? "opacity-70"
    : loading
      ? "!bg-accent-soft/30 cursor-wait"
      : "";
  const loadingBar = (
    <div
      data-message-affordance="attachment-preview-loading"
      className="absolute inset-x-0 bottom-0 flex h-6 items-center gap-1.5 border-t border-line-muted bg-primary-400 px-2 text-[10px] font-bold uppercase tracking-wide text-primary-950 theme-brutal:border-t-2 theme-brutal:border-black theme-brutal:bg-soft-signal theme-brutal:text-black"
    >
      <Spinner size="xs" aria-label={formatMessage({ id: "common.loadingLabel" })} />
      <span className="truncate">{resolvedLoadingLabel}</span>
    </div>
  );

  // The primary affordance icon is decorative: the whole card already carries
  // the click action, so it renders the RUI action recipe on a plain div
  // instead of nesting a real button inside the card button. The secondary
  // download (audio) is a real action with its own click handler.
  const affordanceIcon = affordance === "download" ? (
    <MessageAttachmentAction
      render={<div />}
      aria-hidden="true"
      data-message-affordance={affordanceName ?? "file-download"}
    >
      <Download size={12} />
    </MessageAttachmentAction>
  ) : affordance === "preview" ? (
    <MessageAttachmentAction
      render={<div />}
      aria-hidden="true"
      data-message-affordance={affordanceName ?? "file-preview"}
    >
      <Eye size={12} />
    </MessageAttachmentAction>
  ) : null;

  return (
    <MessageAttachmentCard
      render={disabled ? <div /> : <button type="button" />}
      onClick={disabled ? undefined : onClick}
      aria-busy={loading ? "true" : undefined}
      aria-label={ariaLabel ?? attachment.filename}
      className={`${COMPACT_CHIP_LAYOUT}${stateClassName ? ` ${stateClassName}` : ""}`}
    >
      <MessageAttachmentTitle
        data-message-affordance="attachment-text-slot"
        className="min-w-0 overflow-hidden"
      >
        <span className="flex min-w-0 max-w-full items-center gap-1.5">
          <AttachmentTypeBadge
            filename={attachment.filename}
            data-message-affordance="attachment-type-badge"
          />
          <TruncatedAttachmentTooltip
            content={attachment.filename}
            affordance="attachment-filename"
            className="block min-w-0 max-w-full flex-1 truncate text-xs font-bold text-foreground-strong theme-brutal:text-black"
          >
            {attachment.filename}
          </TruncatedAttachmentTooltip>
        </span>
      </MessageAttachmentTitle>
      {summary ? (
        <MessageAttachmentSummary
          data-message-affordance="attachment-summary-slot"
          className="flex min-w-0 max-w-full overflow-hidden"
        >
          <TruncatedAttachmentTooltip
            content={summary}
            affordance="attachment-summary-text"
            className="inline-flex min-w-0 max-w-full flex-1 items-center gap-1.5 overflow-hidden truncate"
          >
            {summary}
          </TruncatedAttachmentTooltip>
        </MessageAttachmentSummary>
      ) : null}
      <MessageAttachmentMeta>
        {meta}
        {/* Scoped attachment-comment count (MVP §5): rendered inside the
            existing meta line — text-language badge, no new chip layer.
            Suppressed for pdf/image: those surfaces have no comment
            entry (descoped, cindyz 6/11), so a count would dead-end. */}
        {(attachment.commentCount ?? 0) > 0
          && !attachment.mimeType?.startsWith("image/")
          && attachment.mimeType?.split(";")[0]?.trim().toLowerCase() !== "application/pdf" ? (
          <span data-message-affordance="attachment-comment-count" className="inline-flex items-center gap-1 pl-1">
            {meta ? <span className="text-foreground-muted theme-brutal:text-black/35">·</span> : null}
            <MessageSquare size={9} className="shrink-0" />
            {attachment.commentCount}
          </span>
        ) : null}
        <MessageAttachmentMetaEnd>
          {loading ? null : isOptimistic ? (
            <Spinner size="sm" aria-label={formatMessage({ id: "common.loadingLabel" })} />
          ) : (
            <>
              {secondaryDownload ? (
                <MessageAttachmentAction
                  data-message-affordance={secondaryDownload.affordanceName ?? "file-download"}
                  aria-label={secondaryDownload.label}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    secondaryDownload.onClick();
                  }}
                >
                  <Download size={12} />
                </MessageAttachmentAction>
              ) : null}
              {affordanceIcon}
            </>
          )}
        </MessageAttachmentMetaEnd>
      </MessageAttachmentMeta>
      {loading ? loadingBar : null}
      </MessageAttachmentCard>
  );
}

export const ATTACHMENT_CHIP_CLASS_CONTRACT = {
  compact: COMPACT_CHIP_LAYOUT,
  wide: WIDE_CHIP_LAYOUT,
};
