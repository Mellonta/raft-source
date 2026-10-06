import { ContextMenuSeparator } from "raft-ui";

/**
 * Canonical divider between groups of context-menu items. Per CLAUDE.md
 * "Menus & Dropdowns": a thin semantic divider (Brutal restores
 * `border-t-2 border-black`) with no margin — spacing
 * between items is controlled by item padding, not divider margins.
 *
 * Centralized so context menus (Sidebar channel / DM / agent menus today,
 * future surfaces) don't re-roll the same `<div className="border-t-2
 * border-black" />` literal. stdrc 2026-05-24 audit follow-up.
 */
export default function ContextMenuDivider() {
  return <ContextMenuSeparator />;
}
