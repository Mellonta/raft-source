import { forwardRef } from "react";
import type { ReactNode, MouseEvent, DragEvent } from "react";
import AvatarSlot from "../AvatarSlot";
import Tooltip from "../Tooltip";
import InlineMarkdownPreview from "../../markdown/InlineMarkdownPreview";

type ConversationAuthor =
  | {
      kind: "agent";
      name: string;
      avatarUrl?: string | null;
      subtitle?: string | null;
    }
  | {
      kind: "user";
      name: string;
      avatarUrl?: string | null;
      gravatarHash?: string | null;
      subtitle?: string | null;
    };

export interface ConversationPreviewCardProps {
  channelLabel: string;
  author?: ConversationAuthor | null;
  timestamp?: string | null;
  preview: string;
  previewAuthor?: string | null;
  previewLeading?: ReactNode;
  previewLineClampClassName?: "line-clamp-2" | "line-clamp-3";
  previewClassName?: string;
  secondaryPreview?: ReactNode;
  secondaryPreviewClassName?: string;
  ariaLabel?: string;
  title?: string;
  testId?: string;
  marker?: ReactNode;
  footer?: ReactNode;
  action?: ReactNode;
  emphasized?: boolean;
  /**
   * One-shot focus highlight (e.g. after opening a permalink or dblclicking
   * the Inbox sidebar entry). Keep this visually aligned with message
   * permalink focus so "jumped here" reads the same across list surfaces.
   * Owners are responsible for clearing this state after the user has had
   * time to notice it.
   */
  focused?: boolean;
  /**
   * Sticky "this row is the currently-open conversation" highlight — keep it
   * set while the matching detail/thread panel is open so users can see at a
   * glance which list entry corresponds to the panel on the right. Distinct
   * from `focused`, which is a transient flash.
   */
  active?: boolean;
  onClick?: (e: MouseEvent) => void;
  onContextMenu?: (event: MouseEvent) => void;
  draggable?: boolean;
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void;
}

const ConversationPreviewCard = forwardRef<HTMLButtonElement, ConversationPreviewCardProps>(function ConversationPreviewCard({
  channelLabel,
  author,
  timestamp,
  preview,
  previewAuthor,
  previewLeading,
  previewLineClampClassName = "line-clamp-3",
  previewClassName,
  secondaryPreview,
  secondaryPreviewClassName,
  ariaLabel,
  title,
  testId,
  marker,
  footer,
  action,
  emphasized = false,
  focused = false,
  active = false,
  onClick,
  onContextMenu,
  draggable,
  onDragStart,
}, ref) {
  const interactive = Boolean(onClick || onContextMenu);
  const className = `relative flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors hover:border-line-strong hover:shadow-raft-sm theme-brutal:rounded-none theme-brutal:border-2 theme-brutal:hover:border-black theme-brutal:hover:shadow-brutal-sm ${
    interactive ? `active:border-line-strong active:shadow-raft-xs theme-brutal:active:border-black theme-brutal:active:shadow-brutal-sm` : "cursor-default"
  } ${
    focused
      ? "border-line-strong bg-info-soft shadow-raft-sm theme-brutal:border-black theme-brutal:bg-brutal-cyan/25 theme-brutal:shadow-brutal"
      : active
      ? "border-line-strong bg-layer-panel shadow-raft-sm theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal-sm"
      : "border-line-muted bg-layer-panel theme-brutal:border-black/30 theme-brutal:bg-white"
  }`;
  const content = (
    <>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs leading-4">
          <span className="font-bold text-foreground-hint">{channelLabel}</span>
          {author && !previewAuthor ? (
            <span className="inline-flex min-w-0 items-center gap-1 font-bold text-foreground-strong">
              {author.kind === "agent" ? (
                <AvatarSlot context="preview-mini" type="agent" agentAvatarUrl={author.avatarUrl ?? null} />
              ) : (
                <AvatarSlot context="preview-mini" type="human" humanAvatarUrl={author.avatarUrl ?? null} gravatarHash={author.gravatarHash ?? null} />
              )}
              <span className="truncate">{author.name}</span>
              {author.subtitle ? (
                <span className="font-mono text-[10px] text-foreground-hint">{author.subtitle}</span>
              ) : null}
            </span>
          ) : null}
          {marker}
          {timestamp ? <span className="font-mono text-xs leading-4 text-foreground-hint">{timestamp}</span> : null}
        </div>
        <p className={`${previewLineClampClassName} text-sm ${emphasized ? "font-bold" : ""} ${previewClassName ?? ""}`}>
          {previewLeading ? <span className="mr-1 inline-flex align-[-1px]">{previewLeading}</span> : null}
          {previewAuthor ? <span className="font-bold text-foreground-muted">{previewAuthor}: </span> : null}
          <InlineMarkdownPreview markdown={preview} />
        </p>
        {secondaryPreview ? (
          <p className={`mt-1 line-clamp-1 text-xs ${secondaryPreviewClassName ?? "text-foreground-hint"}`}>
            {secondaryPreview}
          </p>
        ) : null}
        {footer ? <div className="mt-1 flex items-center gap-3">{footer}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </>
  );

  if (!interactive) {
    const card = (
      <div
        aria-label={ariaLabel}
        data-testid={testId}
        data-focused={focused ? "true" : undefined}
        data-active={active ? "true" : undefined}
        aria-current={focused || active ? "true" : undefined}
        className={className}
      >
        {content}
      </div>
    );
    return title ? <Tooltip content={title}>{card}</Tooltip> : card;
  }

  const card = (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      aria-label={ariaLabel}
      data-testid={testId}
      data-focused={focused ? "true" : undefined}
      data-active={active ? "true" : undefined}
      aria-current={focused || active ? "true" : undefined}
      className={className}
    >
      {content}
    </button>
  );
  return title ? <Tooltip content={title}>{card}</Tooltip> : card;
});

export default ConversationPreviewCard;
