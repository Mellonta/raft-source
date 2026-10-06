// In-app navigation (RFC-067 `page_viewed`): one event per path change inside
// a server, carrying only the route name, never the path, ids or query. Paths
// that are not a tracked page (legacy redirects, unknown routes) send nothing.

import { useEffect } from "react";
import { SETTINGS_PAGE_TABS } from "@botiverse/raft-shared";
import type { ProductEventProperties } from "@botiverse/raft-shared";
import { trackEvent } from "./track";

type PageRoute = NonNullable<ProductEventProperties<"page_viewed">["route"]>;
type SettingsTab = NonNullable<ProductEventProperties<"page_viewed">["settings_tab"]>;

function isSettingsTab(value: string): value is SettingsTab {
  return (SETTINGS_PAGE_TABS as readonly string[]).includes(value);
}

const ROUTE_BY_SEGMENT: Readonly<Record<string, PageRoute>> = {
  channel: "channel",
  dm: "dm",
  activity: "activity",
  tasks: "tasks",
  saved: "saved",
  search: "search",
  members: "members",
  agent: "agent",
  human: "human",
  computer: "computer",
  machine: "computer", // legacy alias of computer/:machineId
  computers: "computers",
  settings: "settings",
  "release-notes": "release_notes",
};

export function pageRouteFor(pathname: string): { route: PageRoute; settingsTab?: SettingsTab } | null {
  const match = /^\/s\/[^/]+\/?(.*)$/.exec(pathname);
  if (!match) return null;
  const [first = "", second = ""] = match[1].split("/");
  if (first === "members" && second === "graph") return { route: "members_graph" };
  const route = Object.prototype.hasOwnProperty.call(ROUTE_BY_SEGMENT, first) ? ROUTE_BY_SEGMENT[first] : undefined;
  if (!route) return null;
  // Only known tab ids: whatever someone types into the address bar is not recorded.
  if (route === "settings" && isSettingsTab(second)) return { route, settingsTab: second };
  return { route };
}

export function usePageViewTracking(pathname: string): void {
  useEffect(() => {
    const page = pageRouteFor(pathname);
    if (!page) return;
    trackEvent("page_viewed", page.settingsTab
      ? { route: page.route, settings_tab: page.settingsTab }
      : { route: page.route });
  }, [pathname]);
}
