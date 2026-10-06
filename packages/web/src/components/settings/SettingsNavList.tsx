import FeedbackUnreadDot from "../../feedback/FeedbackUnreadDot";
import { SidebarItem } from "raft-ui";
import { useIntl } from "react-intl";
import { SETTINGS_GROUPS, SETTINGS_TAB_NAV_LABEL_ID } from "./settingsNavigation";
import type { SettingsTabId } from "./settingsNavigation";

// Settings-nav sidebar; the feedback badge subscribes independently. Extracted from WorkspaceSettingsModal
// so the desktop nav's label localization can be exercised in a DOM test WITHOUT
// mounting SettingsPanel (whose account-tab content reads the Vite-only
// `import.meta.env.DEV` graph the node harness can't shim). It consumes the SAME
// production `SETTINGS_TAB_NAV_LABEL_ID` map + `formatMessage` the modal uses —
// there is no test-only path here.
export default function SettingsNavList({
  activeTab,
  hiddenTabIds,
  onSelect,
}: {
  activeTab: SettingsTabId;
  hiddenTabIds?: ReadonlySet<SettingsTabId>;
  onSelect: (id: SettingsTabId) => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <aside
      className="flex w-[220px] shrink-0 flex-col border-r border-line-muted bg-layer-canvas-muted theme-brutal:border-black/25 theme-brutal:bg-brutal-cream"
      aria-label={formatMessage({ id: "settings.tabs.navAriaLabel" })}
      data-testid="workspace-settings-navigation"
    >
      <div className="flex h-panel-header shrink-0 items-center border-b border-line-muted px-4 text-base font-bold theme-brutal:border-black/25">
        {formatMessage({ id: "settings.tabs.navTitle" })}
      </div>
      <nav className="min-h-0 flex-1 px-2 py-3">
        {SETTINGS_GROUPS.map((group) => (
          <section key={group.key} className="mb-4 last:mb-0">
            <div className="mb-1 px-2 text-[10px] font-bold uppercase tracking-widest text-foreground-placeholder theme-brutal:text-black/45">
              {formatMessage({ id: group.labelId })}
            </div>
            <div className="space-y-0.5">
              {group.items.filter((item) => !hiddenTabIds?.has(item.id)).map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                const navLabel = formatMessage({ id: SETTINGS_TAB_NAV_LABEL_ID[item.id] });
                return (
                  <SidebarItem
                    variant="accent"
                    active={active}
                    key={item.id}
                    type="button"
                    className="mx-0 w-full data-active:bg-fill-muted dark:data-active:bg-fill-muted data-active:shadow-none data-active:ring-0 theme-brutal:data-active:bg-brutal-pink theme-brutal:data-active:shadow-brutal-sm"
                    aria-current={active ? "page" : undefined}
                    data-testid={`workspace-settings-nav-${item.id}`}
                    onClick={() => onSelect(item.id)}
                  >
                    <Icon size={15} className="shrink-0" />
                    <span className="truncate">{navLabel}</span>
                    {item.id === "feedback" && <FeedbackUnreadDot className="ml-auto" />}
                  </SidebarItem>
                );
              })}
            </div>
          </section>
        ))}
      </nav>
    </aside>
  );
}
