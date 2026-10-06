import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { ThemeProvider, useTheme } from "raft-ui";
import { AppThemeContext } from "../hooks/useAppTheme";
import {
  DEVICE_THEME_STORAGE_KEY,
  readDeviceThemePreferences,
  writeDeviceThemePreferences,
} from "./appThemeCache";
import {
  APP_THEME_PRESET_STORAGE_KEY_PREFIX,
  APP_THEME_STORAGE_KEY,
  DEFAULT_APP_THEME_PREFERENCES,
  isAppThemePreferences,
  isAppThemePreset,
  preferencesFromPreset,
  resolveAppThemePreferences,
  supportsAppThemeMode,
} from "./appTheme";
import type {
  AppAppearanceMode,
  AppResolvedMode,
  AppThemeId,
  AppThemePreferences,
  AppThemePreset,
} from "./appTheme";

// RUI reads matchMedia even when an explicit mode is supplied. Keep the
// provider usable in non-browser test/SSR harnesses that do not install it.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  })) as typeof window.matchMedia;
}

function subscribeSystemMode(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

function getSystemMode(): AppResolvedMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function syncRootTheme(theme: "brutal" | "elegant", mode: AppResolvedMode): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("light", theme === "elegant" && mode === "light");
  root.classList.toggle("dark", theme === "elegant" && mode === "dark");
  root.style.colorScheme = theme === "brutal" ? "light" : mode;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = theme === "brutal" ? "#FFD440" : mode === "dark" ? "#141411" : "#FFFFFF";
}

function AppThemeChromeSynchronizer() {
  const { resolvedMode, theme } = useTheme();
  useLayoutEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = theme === "brutal" ? "#FFD440" : resolvedMode === "dark" ? "#141411" : "#FFFFFF";
  }, [resolvedMode, theme]);
  return null;
}

function isDeviceThemeStorageKey(key: string | null): boolean {
  return key === DEVICE_THEME_STORAGE_KEY
    || key === APP_THEME_STORAGE_KEY
    || (key?.startsWith(APP_THEME_PRESET_STORAGE_KEY_PREFIX) ?? false);
}

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferenceState] = useState<AppThemePreferences>(
    () => readDeviceThemePreferences(),
  );
  const systemMode = useSyncExternalStore<AppResolvedMode>(
    subscribeSystemMode,
    getSystemMode,
    () => "light",
  );
  const resolved = useMemo(
    () => resolveAppThemePreferences(preferences, systemMode),
    [preferences, systemMode],
  );

  useLayoutEffect(() => {
    syncRootTheme(resolved.theme, resolved.resolvedMode);
  }, [resolved.resolvedMode, resolved.theme]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (!isDeviceThemeStorageKey(event.key)) return;
      if (event.key === DEVICE_THEME_STORAGE_KEY && event.newValue) {
        try {
          const parsed: unknown = JSON.parse(event.newValue);
          if (isAppThemePreferences(parsed)) {
            setPreferenceState(parsed);
            return;
          }
        } catch {
          // Fall through to a full storage read.
        }
      }
      if (event.key === APP_THEME_STORAGE_KEY && isAppThemePreset(event.newValue)) {
        setPreferenceState(preferencesFromPreset(event.newValue));
        return;
      }
      setPreferenceState(readDeviceThemePreferences());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const setPreferences = useCallback((nextPreferences: AppThemePreferences) => {
    if (!isAppThemePreferences(nextPreferences)) return;
    setPreferenceState(nextPreferences);
    writeDeviceThemePreferences(nextPreferences);
  }, []);

  const setMode = useCallback((mode: AppAppearanceMode) => {
    setPreferences({ ...preferences, mode });
  }, [preferences, setPreferences]);

  const setThemeForMode = useCallback((mode: AppResolvedMode, themeId: AppThemeId) => {
    if (!supportsAppThemeMode(themeId, mode)) return;
    setPreferences({
      ...preferences,
      ...(mode === "light" ? { lightThemeId: themeId } : { darkThemeId: themeId }),
    });
  }, [preferences, setPreferences]);

  const setPreset = useCallback((preset: AppThemePreset) => {
    if (!isAppThemePreset(preset)) return;
    setPreferences(preferencesFromPreset(preset));
  }, [setPreferences]);

  const handleThemeChange = useCallback((theme: "brutal" | "elegant") => {
    const mode = resolved.resolvedMode;
    if (supportsAppThemeMode(theme, mode)) setThemeForMode(mode, theme);
  }, [resolved.resolvedMode, setThemeForMode]);

  const handleModeChange = useCallback((mode: AppAppearanceMode) => {
    setMode(mode);
  }, [setMode]);

  const contextValue = useMemo(() => ({
    preset: resolved.preset,
    preferences,
    resolvedMode: resolved.resolvedMode,
    setPreferences,
    setMode,
    setThemeForMode,
    setPreset,
  }), [
    preferences,
    resolved.preset,
    resolved.resolvedMode,
    setMode,
    setPreferences,
    setPreset,
    setThemeForMode,
  ]);

  return (
    <AppThemeContext.Provider value={contextValue}>
      <ThemeProvider
        theme={resolved.theme}
        mode={resolved.resolvedMode}
        onThemeChange={handleThemeChange}
        onModeChange={handleModeChange}
      >
        <AppThemeChromeSynchronizer />
        {children}
      </ThemeProvider>
    </AppThemeContext.Provider>
  );
}

// Compatibility re-export for existing Web consumers and tests.
export { useAppTheme } from "../hooks/useAppTheme";

export { DEFAULT_APP_THEME_PREFERENCES };
