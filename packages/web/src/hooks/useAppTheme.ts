import { createContext, useContext } from "react";
import type {
  AppAppearanceMode,
  AppResolvedMode,
  AppThemeId,
  AppThemePreferences,
  AppThemePreset,
} from "../theme/appTheme";

export interface AppThemeContextValue {
  preset: AppThemePreset;
  preferences: AppThemePreferences;
  resolvedMode: AppResolvedMode;
  setPreferences: (preferences: AppThemePreferences) => void;
  setMode: (mode: AppAppearanceMode) => void;
  setThemeForMode: (mode: AppResolvedMode, themeId: AppThemeId) => void;
  /** Compatibility setter for callers that have not migrated off presets. */
  setPreset: (preset: AppThemePreset) => void;
}

export const AppThemeContext = createContext<AppThemeContextValue | null>(null);

export function useAppTheme(): AppThemeContextValue {
  const value = useContext(AppThemeContext);
  if (value === null) {
    throw new Error("useAppTheme must be used within AppThemeProvider");
  }
  return value;
}

export function useOptionalAppTheme(): AppThemeContextValue | null {
  return useContext(AppThemeContext);
}
