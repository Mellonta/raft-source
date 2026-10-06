import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

test("iOS standalone chrome keeps the brutal buckets and floats the elegant tab bar on a transparent shell (task #678)", () => {
  const html = readFileSync(resolve(repoRoot, "index.html"), "utf8");
  const css = readFileSync(resolve(repoRoot, "src/index.css"), "utf8");
  const manifest = readFileSync(resolve(repoRoot, "public/site.webmanifest"), "utf8");
  const layout = readFileSync(
    resolve(repoRoot, "src/components/layout/MainLayout.tsx"),
    "utf8",
  );
  const stack = readFileSync(
    resolve(repoRoot, "src/components/layout/MobileBottomBarStack.tsx"),
    "utf8",
  );
  const sidebar = readFileSync(resolve(repoRoot, "src/components/layout/Sidebar.tsx"), "utf8");
  const tasksPanel = readFileSync(resolve(repoRoot, "src/components/task/TasksPanel.tsx"), "utf8");
  const settingsPanel = readFileSync(resolve(repoRoot, "src/components/settings/SettingsPanel.tsx"), "utf8");
  const themeChrome = readFileSync(
    resolve(repoRoot, "src/theme/appThemeChrome.ts"),
    "utf8",
  );

  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" \/>/);
  assert.match(html, /<meta name="theme-color" content="#FFD440" \/>/);
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" \/>/);
  assert.match(manifest, /"theme_color": "#FFD440"/);
  assert.match(manifest, /"background_color": "#FFD440"/);
  assert.match(css, /html \{[\s\S]*background-color: var\(--layer-canvas-muted\);/);
  assert.match(css, /body \{[\s\S]*background-color: var\(--layer-canvas-muted\);/);
  assert.match(layout, /const THEME_CHROME_YELLOW = "#FFD440";/);
  assert.match(layout, /const THEME_CHROME_WHITE = "#FFFFFF";/);
  assert.match(
    layout,
    /const isMobileTabRoot = mobileShowSidebarInline \|\| \(!isDesktop && isTasksRoute\)/,
  );
  // Brutal keeps the iOS-standalone chrome buckets (tab roots yellow, detail
  // routes white) and paints them on the shell wrapper; the meta effect stays
  // brutal-only because AppThemeProvider owns the elegant meta colour.
  assert.match(
    layout,
    /const browserChromeColor = !isDesktop && !isMobileTabRoot \? THEME_CHROME_WHITE : THEME_CHROME_YELLOW;/,
  );
  assert.match(
    layout,
    /const shellBackgroundColor = appThemePreset === "brutal" && !isDesktop \? browserChromeColor : undefined;/,
  );
  assert.match(layout, /backgroundColor: shellBackgroundColor/);
  assert.match(layout, /themeColor\.content = browserChromeColor/);
  assert.match(layout, /if \(appThemePreset !== "brutal"\) return;/);
  // Elegant floats the tab bar over the content instead of reserving a row.
  assert.match(layout, /useOptionalAppTheme/);
  assert.match(layout, /const floatingTabBar = appTheme !== null && appTheme.preset !== "brutal";/);
  assert.match(layout, /pointer-events-auto md:hidden/);
  assert.match(layout, /floating=\{!isDesktop && appThemePreset !== "brutal"\}/);
  assert.match(stack, /data-testid="mobile-bottom-bar-overlay"/);
  assert.match(stack, /pointer-events-none fixed inset-x-0 bottom-0 z-40/);
  // The tab-root scrolling surfaces reserve clearance for the floating capsule.
  assert.match(css, /html\[data-theme="elegant"\] \.mobile-nav-clearance \{/);
  assert.match(css, /padding-bottom: calc\(68px \+ env\(safe-area-inset-bottom, 0px\)\);/);
  assert.match(css, /html\[data-theme="elegant"\]:has\(\[data-testid="mobile-live-activity-slot"\] > \*\) \.mobile-nav-clearance/);
  assert.match(css, /padding-bottom: calc\(116px \+ env\(safe-area-inset-bottom, 0px\)\);/);
  assert.match(sidebar, /mobile-nav-clearance/);
  assert.match(tasksPanel, /isChannelMode \? "" : " mobile-nav-clearance"/);
  assert.match(settingsPanel, /mobile-nav-clearance/);
  assert.match(themeChrome, /ELEGANT_LIGHT_THEME_CHROME_COLOR = "#FFFFFF"/);
  assert.match(themeChrome, /ELEGANT_DARK_THEME_CHROME_COLOR = "#141411"/);
  assert.match(layout, /<AppShellRoot/);
  assert.match(layout, /<MobileNavRoot/);
});
