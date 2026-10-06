import type { ResolvedThemeMode, Theme } from "raft-ui";

export const BRUTAL_THEME_CHROME_COLOR = "#FFD440";
export const ELEGANT_LIGHT_THEME_CHROME_COLOR = "#FFFFFF";
// sRGB rendering of RUI's Elegant Dark canvas token:
// `oklch(0.19 0.005 106.42)`.
export const ELEGANT_DARK_THEME_CHROME_COLOR = "#141411";

export function appThemeChromeColor(
  theme: Theme,
  resolvedMode: ResolvedThemeMode,
): string {
  if (theme === "brutal") return BRUTAL_THEME_CHROME_COLOR;
  return resolvedMode === "dark"
    ? ELEGANT_DARK_THEME_CHROME_COLOR
    : ELEGANT_LIGHT_THEME_CHROME_COLOR;
}

export function applyAppThemeChromeColor(
  targetDocument: Document,
  theme: Theme,
  resolvedMode: ResolvedThemeMode,
): void {
  const themeColor = targetDocument.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (themeColor) themeColor.content = appThemeChromeColor(theme, resolvedMode);
}
