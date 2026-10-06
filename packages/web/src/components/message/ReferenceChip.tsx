import { MessageReferenceChip } from "raft-ui";
import type { MessageReferenceChipVariant } from "raft-ui";
import type { LucideIcon } from "lucide-react";
import Tooltip from "../ui/Tooltip";

/**
 * Shared in-message reference chip. Both the Slock-permalink inline ref and the
 * attachment comment-ref render through this one structure so they are provably
 * consistent (same box/weight/layout, one height via the RUI message-reference
 * recipe, which owns size and baseline since raft-ui 0.5.16), differing only by icon, color, label, and
 * an optional trailing badge (stdrc directive).
 *
 * The chip carries no cursor in its shared layers on purpose. This component
 * adds `cursor-default` explicitly because in-message refs are the arrow-cursor
 * exception to the app's normal link-hand control contract.
 */
export function ReferenceChip({
  icon: Icon,
  variant,
  label,
  trailing,
  as = "span",
  href,
  onClick,
  title,
  "data-message-affordance": dataMessageAffordance,
}: {
  icon: LucideIcon;
  variant: MessageReferenceChipVariant;
  label: React.ReactNode;
  trailing?: React.ReactNode;
  as?: "a" | "span";
  href?: string;
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  "data-message-affordance"?: string;
}) {
  const Tag = as;
  const anchorProps = as === "a" ? { href, onClick } : {};

  const chip = (
    <MessageReferenceChip
      variant={variant}
      render={<Tag {...anchorProps} data-message-affordance={dataMessageAffordance} />}
      className="cursor-default"
    >
      <Icon size={12} className="shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      {trailing}
    </MessageReferenceChip>
  );
  // Native title= on the chip element is only a hover tooltip; route it
  // through the RUI Tooltip so it follows the theme recipe (title= migration).
  return title ? <Tooltip content={title}>{chip}</Tooltip> : chip;
}
