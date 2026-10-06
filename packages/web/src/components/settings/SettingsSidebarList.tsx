import FeedbackUnreadDot from "../../feedback/FeedbackUnreadDot";
import type { ReactNode } from "react";
import { SidebarItem } from "raft-ui";

export interface SettingsSidebarItem {
  id: string;
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  href?: string;
  testId?: string;
}

export interface SettingsSidebarGroup {
  label: string;
  items: SettingsSidebarItem[];
}

/** The shared settings rows used inside the canonical AppShell sidebar.
 *  Rows are RUI SidebarItem so selected/hover geometry follows the theme
 *  recipe (elegant rounded borderless, brutal hard pink block). External
 *  links keep anchor semantics via `render`. */
export default function SettingsSidebarList({
  groups,
  activeId,
}: {
  groups: SettingsSidebarGroup[];
  activeId: string | null;
}) {
  return (
    <div className="space-y-3" data-testid="settings-sidebar-list">
      {groups.filter((group) => group.items.length > 0).map((group) => (
        <div key={group.label}>
          <div className="mb-1 px-2 text-[10px] font-bold uppercase tracking-widest text-foreground-muted theme-brutal:text-black/40">
            {group.label}
          </div>
          {group.items.map((item) => {
            const selected = activeId === item.id;
            return (
              <SidebarItem
                key={item.id}
                variant="accent"
                active={selected}
                render={item.href ? (
                  // The render literal is empty by design: SidebarItem merges
                  // its children into this element. aria-label mirrors the
                  // visible label for the anchor-has-content rule.
                  <a href={item.href} target="_blank" rel="noopener noreferrer" aria-label={item.label} />
                ) : (
                  <button type="button" onClick={item.onClick} aria-label={item.label} />
                )}
                data-testid={item.testId}
              >
                {item.icon}
                {item.label}
                {item.id === "feedback" && <FeedbackUnreadDot className="ml-auto" />}
              </SidebarItem>
            );
          })}
        </div>
      ))}
    </div>
  );
}
