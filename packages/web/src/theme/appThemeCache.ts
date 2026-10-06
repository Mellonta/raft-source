import {
  APP_THEME_PREFERENCES_STORAGE_KEY,
  APP_THEME_PRESET_STORAGE_KEY_PREFIX,
  APP_THEME_STORAGE_KEY,
  DEFAULT_APP_THEME_PREFERENCES,
  isAppThemePreferences,
  isAppThemePreset,
  preferencesFromLegacyPreset,
} from "./appTheme";
import type { AppThemePreferences } from "./appTheme";

export {
  APP_THEME_PREFERENCES_STORAGE_KEY,
  APP_THEME_PRESET_STORAGE_KEY_PREFIX,
  APP_THEME_STORAGE_KEY,
} from "./appTheme";

type ThemeStorage = Pick<Storage, "getItem" | "setItem" | "key" | "length">;

/**
 * One preference for this browser profile. It is not derived from the signed-in
 * account, so switching accounts or signing out keeps the same theme.
 */
export const DEVICE_THEME_STORAGE_KEY = APP_THEME_PREFERENCES_STORAGE_KEY;

function browserStorage(): ThemeStorage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

export function readDeviceThemePreferences(
  storage: ThemeStorage | null = browserStorage(),
): AppThemePreferences {
  if (storage === null) return { ...DEFAULT_APP_THEME_PREFERENCES };
  try {
    const current = storage.getItem(DEVICE_THEME_STORAGE_KEY);
    if (current) {
      const parsed: unknown = JSON.parse(current);
      if (isAppThemePreferences(parsed)) return parsed;
    }

    const migrated = migrateLegacyDevicePreferences(storage);
    if (!migrated) return { ...DEFAULT_APP_THEME_PREFERENCES };
    // Keep the user's existing choice even when this browser cannot persist it.
    writeDeviceThemePreferences(migrated, storage);
    return migrated;
  } catch {
    return { ...DEFAULT_APP_THEME_PREFERENCES };
  }
}

export function writeDeviceThemePreferences(
  preferences: AppThemePreferences,
  storage: ThemeStorage | null = browserStorage(),
): boolean {
  if (storage === null || !isAppThemePreferences(preferences)) return false;
  try {
    storage.setItem(DEVICE_THEME_STORAGE_KEY, JSON.stringify(preferences));
    return true;
  } catch {
    // Storage is an optimization for first paint. The current page stays
    // responsive even when private mode or quota policy makes it unavailable.
    return false;
  }
}

function migrateLegacyDevicePreferences(storage: ThemeStorage): AppThemePreferences | null {
  const legacyPreset = storage.getItem(APP_THEME_STORAGE_KEY);
  if (isAppThemePreset(legacyPreset)) return preferencesFromLegacyPreset(legacyPreset);

  // Older builds stored one preset per account. A device with exactly one such
  // value keeps it; several accounts can disagree, so none of them is promoted.
  const accountPreferences: AppThemePreferences[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(APP_THEME_PRESET_STORAGE_KEY_PREFIX)) continue;
    const raw = storage.getItem(key);
    if (!raw) continue;
    if (isAppThemePreset(raw)) {
      accountPreferences.push(preferencesFromLegacyPreset(raw));
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isAppThemePreferences(parsed)) accountPreferences.push(parsed);
    } catch {
      // Skip a corrupt account entry rather than failing the whole migration.
    }
  }
  if (accountPreferences.length !== 1) return null;
  return accountPreferences[0] ?? null;
}
