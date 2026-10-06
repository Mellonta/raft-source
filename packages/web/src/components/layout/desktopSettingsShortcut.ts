import type { WorkspaceGridRailSide } from "../workspace/workspaceGridNavigationStore";

/**
 * Resolve the layout-appropriate target for the desktop "Settings…" (⌘,) shortcut.
 *
 * The workspace settings modal only renders when the grid is enabled (large screen +
 * gate), so opening its store on a narrow window / grid-off would be a silent no-op.
 * Fall back to the `/settings` route, which renders in every layout. Kept as a pure
 * function so both branches are unit-testable without mounting MainLayout.
 */
export function openDesktopSettings(opts: {
  workspaceEnabled: boolean;
  railSide: WorkspaceGridRailSide;
  serverSlug: string | null | undefined;
  openWorkspaceSettingsModal: (side: WorkspaceGridRailSide) => void;
  navigate: (path: string) => void;
}): void {
  if (opts.workspaceEnabled) {
    opts.openWorkspaceSettingsModal(opts.railSide);
    return;
  }
  if (opts.serverSlug) opts.navigate(`/s/${opts.serverSlug}/settings`);
}
