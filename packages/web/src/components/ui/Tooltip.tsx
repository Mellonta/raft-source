import type { ComponentProps, ReactElement, ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "raft-ui";

type RaftTooltipProps = ComponentProps<typeof Tooltip>;
type TooltipContentProps = ComponentProps<typeof TooltipContent>;
type TooltipTriggerProps = Omit<ComponentProps<typeof TooltipTrigger>, "children" | "render">;

export interface TooltipProps extends Omit<RaftTooltipProps, "children"> {
  children: ReactElement;
  content: ReactNode;
  contentProps?: Omit<TooltipContentProps, "children">;
  triggerProps?: TooltipTriggerProps;
}

/**
 * Product adapter over the RUI Tooltip composition.
 *
 * RUI owns the behaviour and the visual recipe: inert content, flip collision
 * default and trigger data-slot forwarding are all built into rui #289
 * (shipped from 0.5.12; pinned here at 0.5.13). This shell only collapses
 * Tooltip + TooltipTrigger + TooltipContent into the single `content` prop the
 * app call sites use — do not re-add local overrides here; report gaps to rui.
 */
export default function AppTooltip({
  children,
  content,
  contentProps,
  triggerProps,
  ...tooltipProps
}: TooltipProps) {
  return (
    <Tooltip {...tooltipProps}>
      <TooltipTrigger {...triggerProps} render={children} />
      <TooltipContent {...contentProps}>{content}</TooltipContent>
    </Tooltip>
  );
}
