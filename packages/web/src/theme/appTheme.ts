import type { Theme, ThemeMode } from "raft-ui";

/**
 * The old product model persisted one value that mixed color mode and visual
 * family. Keep the key readable so existing devices migrate without a flash.
 */
export const APP_THEME_STORAGE_KEY = "slock-theme-preset";
export const APP_THEME_PREFERENCES_STORAGE_KEY = "slock-theme-preferences-v2";
export const APP_THEME_PRESET_STORAGE_KEY_PREFIX = "raft:theme-preset:v1:";

export const APP_THEME_PRESETS = ["brutal", "elegant-light", "elegant-dark", "elegant-system"] as const;
export type AppThemePreset = (typeof APP_THEME_PRESETS)[number];
export const DEFAULT_APP_THEME_PRESET: AppThemePreset = "brutal";

export const APP_THEME_IDS = ["brutal", "elegant"] as const;
export type AppThemeId = (typeof APP_THEME_IDS)[number];
export type AppAppearanceMode = ThemeMode;
export type AppResolvedMode = Exclude<AppAppearanceMode, "system">;

export interface AppThemeDefinition {
  id: AppThemeId;
  family: Theme;
  supportedModes: readonly AppResolvedMode[];
  previewPreset: Partial<Record<AppResolvedMode, AppThemePreset>>;
}

/**
 * Product-owned registry. A future theme extends this registry; System is a
 * mode resolver and never becomes a theme entry.
 */
export const APP_THEME_REGISTRY: Record<AppThemeId, AppThemeDefinition> = {
  brutal: {
    id: "brutal",
    family: "brutal",
    supportedModes: ["light"],
    previewPreset: { light: "brutal" },
  },
  elegant: {
    id: "elegant",
    family: "elegant",
    supportedModes: ["light", "dark"],
    previewPreset: { light: "elegant-light", dark: "elegant-dark" },
  },
};

export interface AppThemePreferences {
  mode: AppAppearanceMode;
  lightThemeId: AppThemeId;
  darkThemeId: AppThemeId;
}

export const DEFAULT_APP_THEME_PREFERENCES: AppThemePreferences = {
  mode: "system",
  lightThemeId: "brutal",
  darkThemeId: "elegant",
};

export interface ResolvedAppTheme {
  themeId: AppThemeId;
  theme: Theme;
  mode: AppAppearanceMode;
  resolvedMode: AppResolvedMode;
  preset: AppThemePreset;
}

export function isAppThemePreset(value: unknown): value is AppThemePreset {
  return APP_THEME_PRESETS.includes(value as AppThemePreset);
}

export function isAppThemeId(value: unknown): value is AppThemeId {
  return APP_THEME_IDS.includes(value as AppThemeId);
}

export function isAppAppearanceMode(value: unknown): value is AppAppearanceMode {
  return value === "light" || value === "dark" || value === "system";
}

export function supportsAppThemeMode(themeId: AppThemeId, mode: AppResolvedMode): boolean {
  return APP_THEME_REGISTRY[themeId].supportedModes.includes(mode);
}

export function isAppThemePreferences(value: unknown): value is AppThemePreferences {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AppThemePreferences>;
  return isAppAppearanceMode(candidate.mode)
    && isAppThemeId(candidate.lightThemeId)
    && isAppThemeId(candidate.darkThemeId)
    && supportsAppThemeMode(candidate.lightThemeId, "light")
    && supportsAppThemeMode(candidate.darkThemeId, "dark");
}

export function preferencesFromLegacyPreset(preset: AppThemePreset): AppThemePreferences {
  switch (preset) {
    case "brutal":
      return { mode: "light", lightThemeId: "brutal", darkThemeId: "elegant" };
    case "elegant-light":
      return { mode: "light", lightThemeId: "elegant", darkThemeId: "elegant" };
    case "elegant-dark":
      return { mode: "dark", lightThemeId: "elegant", darkThemeId: "elegant" };
    case "elegant-system":
      return { mode: "system", lightThemeId: "elegant", darkThemeId: "elegant" };
  }
}

export function preferencesFromPreset(preset: AppThemePreset): AppThemePreferences {
  return preferencesFromLegacyPreset(preset);
}

export function readAppThemePreferences(): AppThemePreferences {
  if (typeof window === "undefined") return { ...DEFAULT_APP_THEME_PREFERENCES };
  try {
    const stored = window.localStorage.getItem(APP_THEME_PREFERENCES_STORAGE_KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (isAppThemePreferences(parsed)) return parsed;
    }
    const legacyPreset = window.localStorage.getItem(APP_THEME_STORAGE_KEY);
    return isAppThemePreset(legacyPreset)
      ? preferencesFromLegacyPreset(legacyPreset)
      : { ...DEFAULT_APP_THEME_PREFERENCES };
  } catch {
    return { ...DEFAULT_APP_THEME_PREFERENCES };
  }
}

/** @deprecated Use readAppThemePreferences. Kept for narrow compatibility consumers. */
export function readAppThemePreset(): AppThemePreset {
  return resolveAppThemePreferences(readAppThemePreferences(), readSystemThemeMode()).preset;
}

export function readSystemThemeMode(): AppResolvedMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function resolveAppThemePreferences(
  preferences: AppThemePreferences,
  systemMode: AppResolvedMode = "light",
): ResolvedAppTheme {
  const resolvedMode = preferences.mode === "system" ? systemMode : preferences.mode;
  const requestedThemeId = resolvedMode === "dark"
    ? preferences.darkThemeId
    : preferences.lightThemeId;
  // Invalid combinations can only arrive from stale/corrupt storage or future
  // registry drift. Fail to the first real recipe for that mode.
  const themeId = supportsAppThemeMode(requestedThemeId, resolvedMode)
    ? requestedThemeId
    : APP_THEME_IDS.find((id) => supportsAppThemeMode(id, resolvedMode)) ?? "brutal";
  const definition = APP_THEME_REGISTRY[themeId];
  const preset = preferences.mode === "system" && themeId === "elegant"
    ? "elegant-system"
    : definition.previewPreset[resolvedMode]
      ?? (resolvedMode === "dark" ? "elegant-dark" : "brutal");
  return {
    themeId,
    theme: definition.family,
    mode: preferences.mode,
    resolvedMode,
    preset,
  };
}

export function writeAppThemePreferences(preferences: AppThemePreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      APP_THEME_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch {
    // Storage-disabled contexts keep the in-memory preference for this session.
  }
}

/** Compatibility mapping for callers that still speak the RUI family/mode pair. */
export function presetFromTheme(theme: Theme, mode: ThemeMode): AppThemePreset {
  if (theme === "brutal") return "brutal";
  if (mode === "system") return "elegant-system";
  return mode === "dark" ? "elegant-dark" : "elegant-light";
}

export function resolveAppThemePreset(preset: AppThemePreset): ResolvedAppTheme {
  return resolveAppThemePreferences(preferencesFromPreset(preset), readSystemThemeMode());
}
