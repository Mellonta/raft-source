import { FilePreviewBadge } from "raft-ui";
import { attachmentBadgeType } from "../../utils/attachmentBadgeType";

/**
 * The file-type chip, in one place.
 *
 * RUI's badge colours itself from `type` but renders no label of its own, and
 * its recipe sizes for the Files grid rather than a compact row, so this
 * wrapper supplies the uppercase extension text and pins the small size. It
 * stays inline (`static`) so each surface decides where it sits — the Files row
 * passes its absolute corner, the card and preview header leave it inline.
 * Renders nothing for unknown extensions.
 */
export function AttachmentTypeBadge({
  filename,
  className = "",
  "data-testid": testId,
  "data-message-affordance": affordance,
}: {
  filename: string;
  className?: string;
  "data-testid"?: string;
  "data-message-affordance"?: string;
}) {
  const type = attachmentBadgeType(filename);
  if (!type) return null;
  const label = (filename.split(".").pop() ?? "").toUpperCase();

  return (
    <FilePreviewBadge
      type={type}
      data-testid={testId}
      data-message-affordance={affordance}
      className={`!static inline-flex shrink-0 items-center justify-center !h-3.5 !min-h-3.5 !w-7 !min-w-7 !px-0 !text-[9px] ${className}`}
    >
      {label}
    </FilePreviewBadge>
  );
}
