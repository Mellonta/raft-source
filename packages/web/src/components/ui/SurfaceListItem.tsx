import type { HTMLAttributes, ReactNode } from "react";
import { Card } from "raft-ui";

export default function SurfaceListItem({
  children,
  selected = false,
  interactive = true,
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  selected?: boolean;
  interactive?: boolean;
}) {
  return (
    <Card
      variant="default"
      className={[
 "min-w-0 w-full px-4 py-3 transition-colors",
 selected
 ? "border-info bg-info-muted shadow-raft-sm"
 : [
 "border-line-muted bg-layer-card",
 interactive ? "hover:border-line-strong hover:shadow-raft-sm" : "",
 ].join(" "),
 "theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white",
 selected ? "theme-brutal:border-black theme-brutal:bg-brutal-cyan/15 theme-brutal:shadow-brutal-sm" : "",
 interactive ? "theme-brutal:hover:border-black theme-brutal:hover:shadow-brutal-sm" : "",
 className,
 ].join(" ")}
      {...props}
      data-selected={selected ? "true" : undefined}
    >
      {children}
    </Card>
  );
}
