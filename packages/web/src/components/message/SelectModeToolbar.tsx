import { useLayoutEffect, useRef, useState } from "react";
import { X, Image, Copy, Check, Send, MoreHorizontal, ListChecks } from "lucide-react";
import { useIntl } from "react-intl";
import { useSelectionStore } from "../../store/selectionStore";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
} from "raft-ui";
import Tooltip from "../ui/Tooltip";

export interface SelectModeToolbarProps {
  /** Channel id this toolbar is mounted under. Renders only when select mode is scoped here. */
  channelId: string;
  /** Click handler for the Share preview button. Disabled when 0 selected. */
  onSavePic: () => void;
  /** Preserved for phase 3 platform share targets inside the lightbox. */
  onShareX: () => void;
  /** Click handler for the Copy-MD button. Disabled when 0 selected. */
  onCopyMd: () => void;
  /** Click handler for opening the message-forward composer. */
  onForward?: () => void;
  /** Optional reason to disable forward buttons for unsupported source surfaces. */
  forwardDisabledReason?: string | null;
  /** Click handler for copying permalinks for the current selection. */
  onCopyLinks?: () => void;
  /** Optional thread-mode affordance for selecting parent + all replies. */
  onSelectAll?: () => void;
  /** True while the screenshot is being rendered for the Share preview. */
  capturing?: boolean;
  /** True for ~1.5s after Copy MD succeeds, swaps the icon for a check. */
  copied?: boolean;
}

/**
 * Bottom sticky toolbar shown while multi-select mode is active in a channel.
 * Layout: [N selected] [Cancel] [Forward] [More]
 */
export default function SelectModeToolbar({
  channelId,
  onSavePic,
  onCopyMd,
  onForward,
  forwardDisabledReason,
  onCopyLinks,
  onSelectAll,
  capturing = false,
  copied = false,
}: SelectModeToolbarProps) {
  const { formatMessage } = useIntl();
  const isActive = useSelectionStore((s) => s.isActive);
  const selectionChannelId = useSelectionStore((s) => s.channelId);
  const count = useSelectionStore((s) => s.selectedIds.size);
  const exit = useSelectionStore((s) => s.exit);
  const [compactLevel, setCompactLevel] = useState(0);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const lastActionsWidthRef = useRef(0);

  const canAct = count > 0 && !capturing;
  const canForward = canAct && !!onForward && !forwardDisabledReason;
  // Icon-only states use size="icon-sm". Do not zero RUI Button gap/padding
  // or suppress the keyboard focus ring (those overrides were for the pre-RUI buttons).
  const toolbarButtonClass = "whitespace-nowrap";
  const maxCompactLevel = 1 + (onCopyLinks ? 1 : 0) + (onForward ? 1 : 0) + (onSelectAll ? 1 : 0);
  const compactCopyLink = compactLevel >= 1;
  const compactForward = compactLevel >= 1 + (onCopyLinks ? 1 : 0);
  const compactCancel = compactLevel >= 1 + (onCopyLinks ? 1 : 0) + (onForward ? 1 : 0);
  const compactSelectAll = compactLevel >= maxCompactLevel;
  const moreDisabled = count === 0;
  const selectAllLabel = formatMessage({ id: "message.selectModeToolbar.selectAll" });
  const cancelLabel = formatMessage({ id: "message.selectModeToolbar.cancel" });
  const forwardLabel = formatMessage({ id: "message.selectModeToolbar.forward" });
  const copyLinkLabel = formatMessage({ id: "message.selectModeToolbar.copyLink" });
  const copiedLabel = formatMessage({ id: "message.selectModeToolbar.copied" });
  const moreLabel = formatMessage({ id: "message.selectModeToolbar.more" });
  const moreActionsLabel = formatMessage({ id: "message.selectModeToolbar.moreActions" });
  const renderingLabel = formatMessage({ id: "message.selectModeToolbar.rendering" });
  const generateImageLabel = formatMessage({ id: "message.selectModeToolbar.generateImage" });
  const copyMdLabel = formatMessage({ id: "message.selectModeToolbar.copyMd" });
  const copiedMdLabel = formatMessage({ id: "message.selectModeToolbar.copiedMd" });
  useLayoutEffect(() => {
    const actions = actionsRef.current;
    if (!actions) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const width = actions.clientWidth;
        const gap = Number.parseFloat(getComputedStyle(actions).columnGap) || 0;
        const childrenWidth = Array.from(actions.children).reduce((total, child) => {
          return total + (child as HTMLElement).offsetWidth;
        }, 0);
        const requiredWidth = childrenWidth + Math.max(0, actions.children.length - 1) * gap;
        const overflow = requiredWidth > width + 1;
        setCompactLevel((current) => {
          if (width > lastActionsWidthRef.current + 8 && current > 0) {
            lastActionsWidthRef.current = width;
            return 0;
          }
          lastActionsWidthRef.current = width;
          if (overflow && current < maxCompactLevel) return current + 1;
          return current;
        });
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(actions);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [capturing, copied, compactLevel, count, maxCompactLevel, onCopyLinks, onForward, onSelectAll]);

  if (!isActive || selectionChannelId !== channelId) return null;

  // Keep the default action row short: selection count, cancel, primary
  // forward, common copy-link, and a More menu for lower-frequency actions.
  return (
    <div
      className="relative z-30 border-t border-primary-edge bg-primary-400 safe-bottom-action-bar text-primary-950 theme-brutal:border-t-2 theme-brutal:border-black theme-brutal:bg-soft-signal theme-brutal:text-black"
      data-testid="select-mode-toolbar"
    >
      <div className="flex items-center gap-1 px-2 py-2 sm:gap-1.5 sm:px-2">
        <span
          className="font-mono text-xs font-bold text-primary-950/70 theme-brutal:text-black/70 whitespace-nowrap"
          data-testid="select-mode-count"
        >
          {formatMessage({ id: "message.selectModeToolbar.selectedCount" }, { count })}
        </span>
        <div ref={actionsRef} className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1 sm:gap-1.5">
          {onSelectAll && (
            <Tooltip content={selectAllLabel}>
            <Button
              type="button"
              onClick={onSelectAll}
              disabled={capturing}
             
              size={compactSelectAll ? "icon-sm" : "sm"}
              variant="outline"
              aria-label={selectAllLabel}
              data-slot="button"
              className={toolbarButtonClass}
              data-testid="select-mode-select-all"
            >
              <ListChecks size={14} />
              {!compactSelectAll && <span>{selectAllLabel}</span>}
            </Button>
            </Tooltip>
          )}
          <Tooltip content={cancelLabel}>
          <Button
            type="button"
            onClick={exit}
           
            size={compactCancel ? "icon-sm" : "sm"}
            variant="outline"
            aria-label={cancelLabel}
            data-slot="button"
            className={toolbarButtonClass}
            data-testid="select-mode-cancel"
          >
            <X size={14} />
            {!compactCancel && <span>{cancelLabel}</span>}
          </Button>
          </Tooltip>
          {onForward && (
            <Tooltip content={forwardDisabledReason || forwardLabel}>
            <Button
              type="button"
              onClick={onForward}
              disabled={!canForward}
             
              size={compactForward ? "icon-sm" : "sm"}
              variant="accent"
              aria-label={forwardLabel}
              data-slot="button"
              className={toolbarButtonClass}
              data-testid="select-mode-forward"
            >
              <Send size={14} />
              {!compactForward && <span>{forwardLabel}</span>}
            </Button>
            </Tooltip>
          )}
          {onCopyLinks && (
            <Tooltip content={copyLinkLabel}>
            <Button
              type="button"
              onClick={onCopyLinks}
              disabled={count === 0}
             
              size={compactCopyLink ? "icon-sm" : "sm"}
              variant="outline"
              aria-label={copyLinkLabel}
              data-slot="button"
              className={toolbarButtonClass}
              data-testid="select-mode-copy-link"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {!compactCopyLink && <span>{copied ? copiedLabel : copyLinkLabel}</span>}
            </Button>
            </Tooltip>
          )}
          <DropdownMenu>
            <Tooltip content={moreLabel}>
            <DropdownMenuTrigger
              disabled={moreDisabled}
              render={(
                <Button
                  type="button"
                  size="icon-sm"
                  variant="outline"
                  aria-label={moreActionsLabel}
                  data-slot="button"
                  className={toolbarButtonClass}
                  data-testid="select-mode-more"
                >
                  <MoreHorizontal size={14} />
                </Button>
              )}
            />
            </Tooltip>
            <DropdownMenuContent
              side="top"
              align="end"
              sideOffset={8}
              aria-label={moreActionsLabel}
              data-testid="select-mode-more-menu"
            >
              <DropdownMenuItem
                onClick={onSavePic}
                disabled={!canAct}
                data-testid="select-mode-share-open"
              >
                {capturing ? <Spinner size="sm" aria-label={formatMessage({ id: "common.loadingLabel" })} /> : <Image size={14} />}
                {capturing ? renderingLabel : generateImageLabel}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onCopyMd}
                disabled={count === 0}
                data-testid="select-mode-copy-md"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? copiedMdLabel : copyMdLabel}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
