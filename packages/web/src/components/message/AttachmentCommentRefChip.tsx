import { MessageSquare } from "lucide-react";
import { useIntl } from "react-intl";
import type { Message } from "../../store/messageStore";
import { ReferenceChip } from "./ReferenceChip";

export function AttachmentCommentRefChip({
  commentRef,
  commentsEnabled,
  onJumpToHost,
  bodyFontSizeClass,
}: {
  commentRef: Message["commentRef"] | null | undefined;
  commentsEnabled: boolean;
  onJumpToHost: () => void;
  // The chip box (RUI message-reference recipe, via
  // ReferenceChip) renders at its container's font size, so its size comes
  // from this wrapper. Pass the same `messageBodyFontSizeClass`
  // the message body uses so the comment-ref chip scales with the user's
  // font-size preference instead of the outer base size (stdrc task #463: chip
  // looked larger than the body when the preference shrank the body but not the
  // chip).
  bodyFontSizeClass?: string;
}) {
  const { formatMessage } = useIntl();
  if (!commentRef || !commentsEnabled) return null;

  const detail = `${commentRef.filename}${commentRef.anchorLabel ? ` · ${commentRef.anchorLabel}` : ""}`;
  const label = formatMessage({ id: "message.attachment.rePrefix" }, { name: detail });

  return (
    <>
      <div className={`mb-0.5 ${bodyFontSizeClass ?? ""}`}>
        {commentRef.hostSource ? (
          <ReferenceChip
            as="a"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onJumpToHost();
            }}
            data-message-affordance="attachment-comment-ref-chip"
            icon={MessageSquare}
            variant="muted"
            label={label}
            title={formatMessage({ id: "message.attachmentComment.jumpTitle" }, { detail })}
          />
        ) : (
          <ReferenceChip
            as="span"
            data-message-affordance="attachment-comment-ref-chip"
            icon={MessageSquare}
            variant="muted"
            label={label}
            title={formatMessage({ id: "message.attachmentComment.commentTitle" }, { detail })}
          />
        )}
      </div>
      {commentRef.anchorQuote ? (
        <div className="mb-1 whitespace-pre-wrap break-words border-l-2 border-line-muted pl-2 text-xs italic text-foreground-muted theme-brutal:border-black/20 theme-brutal:text-black/55">
          {commentRef.anchorQuote}
        </div>
      ) : null}
    </>
  );
}
