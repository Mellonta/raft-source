import type { ReactNode } from "react";
import Tooltip from "../ui/Tooltip";

type SettingsProfileCardProps = {
  avatar: ReactNode;
  title: string;
  subtitle: string;
  children: ReactNode;
  testId?: string;
};

/**
 * Shared identity card for Account and Server Profile settings.
 *
 * The shell owns only presentation: avatar placement, identity typography,
 * and the divided field stack. Each settings surface keeps its own form,
 * permissions, validation, and save lifecycle inside `children`.
 */
export default function SettingsProfileCard({
  avatar,
  title,
  subtitle,
  children,
  testId,
}: SettingsProfileCardProps) {
  return (
    <div
      data-testid={testId}
      className="space-y-4 border border-line-muted bg-layer-panel p-4 shadow-raft-sm theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal-sm"
    >
      <div className="flex items-start gap-4">
        <div className="flex size-16 shrink-0 items-center justify-center">
          {avatar}
        </div>

        <div className="min-w-0 flex-1 pt-1">
          <Tooltip content={title}>
          <div
            className="min-w-0 truncate text-lg font-bold leading-tight text-foreground-strong theme-brutal:text-black"
          >
            {title}
          </div>
          </Tooltip>
          <Tooltip content={subtitle}>
          <div className="truncate font-mono text-sm text-foreground-muted theme-brutal:text-black/50">
            {subtitle}
          </div>
          </Tooltip>
        </div>
      </div>

      <div className="space-y-3 border-t border-line-muted pt-4">
        {children}
      </div>
    </div>
  );
}
