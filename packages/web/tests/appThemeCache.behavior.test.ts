import assert from "node:assert/strict";

import {
  APP_THEME_PREFERENCES_STORAGE_KEY,
  APP_THEME_PRESET_STORAGE_KEY_PREFIX,
  APP_THEME_STORAGE_KEY,
  DEFAULT_APP_THEME_PREFERENCES,
} from "../src/theme/appTheme";
import {
  DEVICE_THEME_STORAGE_KEY,
  readDeviceThemePreferences,
  writeDeviceThemePreferences,
} from "../src/theme/appThemeCache";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

test("theme preferences use one device key and default to following the system", () => {
  assert.equal(DEVICE_THEME_STORAGE_KEY, APP_THEME_PREFERENCES_STORAGE_KEY);
  assert.deepEqual(readDeviceThemePreferences(memoryStorage()), DEFAULT_APP_THEME_PREFERENCES);
  assert.equal(DEFAULT_APP_THEME_PREFERENCES.mode, "system");
});

test("a saved device preference round-trips without an account id", () => {
  const storage = memoryStorage();
  const preferences = {
    mode: "light" as const,
    lightThemeId: "elegant" as const,
    darkThemeId: "elegant" as const,
  };

  assert.equal(writeDeviceThemePreferences(preferences, storage), true);
  assert.deepEqual(readDeviceThemePreferences(storage), preferences);
  assert.equal(storage.length, 1);
});

test("legacy device and single-account preferences migrate once", () => {
  const legacy = memoryStorage();
  legacy.setItem(APP_THEME_STORAGE_KEY, "elegant-dark");
  const promoted = {
    mode: "dark" as const,
    lightThemeId: "elegant" as const,
    darkThemeId: "elegant" as const,
  };
  assert.deepEqual(readDeviceThemePreferences(legacy), promoted);
  assert.equal(legacy.getItem(DEVICE_THEME_STORAGE_KEY), JSON.stringify(promoted));

  legacy.setItem(APP_THEME_STORAGE_KEY, "brutal");
  assert.deepEqual(readDeviceThemePreferences(legacy), promoted);

  const oneAccount = memoryStorage();
  oneAccount.setItem(
    `${APP_THEME_PRESET_STORAGE_KEY_PREFIX}account-a`,
    JSON.stringify({ mode: "light", lightThemeId: "elegant", darkThemeId: "elegant" }),
  );
  assert.equal(readDeviceThemePreferences(oneAccount).lightThemeId, "elegant");

  const manyAccounts = memoryStorage();
  manyAccounts.setItem(`${APP_THEME_PRESET_STORAGE_KEY_PREFIX}account-a`, "elegant-dark");
  manyAccounts.setItem(`${APP_THEME_PRESET_STORAGE_KEY_PREFIX}account-b`, "elegant-light");
  assert.deepEqual(readDeviceThemePreferences(manyAccounts), DEFAULT_APP_THEME_PREFERENCES);
});

test("a readable but unwritable legacy preference still keeps its theme", () => {
  let writes = 0;
  const values = new Map<string, string>([[APP_THEME_STORAGE_KEY, "elegant-dark"]]);
  const storage = {
    get length() {
      return values.size;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem() {
      writes += 1;
      throw new Error("storage is read-only");
    },
  };

  assert.deepEqual(readDeviceThemePreferences(storage), {
    mode: "dark",
    lightThemeId: "elegant",
    darkThemeId: "elegant",
  });
  assert.equal(writes, 1);
  assert.equal(storage.getItem(DEVICE_THEME_STORAGE_KEY), null);
});

test("corrupt or unavailable storage falls back without throwing", () => {
  const storage = memoryStorage();
  storage.setItem(APP_THEME_PREFERENCES_STORAGE_KEY, "{");
  assert.deepEqual(readDeviceThemePreferences(storage), DEFAULT_APP_THEME_PREFERENCES);

  const unavailable = {
    get length() {
      return 0;
    },
    key() {
      return null;
    },
    getItem() {
      throw new Error("storage unavailable");
    },
    setItem() {
      throw new Error("storage unavailable");
    },
  };
  assert.deepEqual(readDeviceThemePreferences(unavailable), DEFAULT_APP_THEME_PREFERENCES);
  assert.equal(writeDeviceThemePreferences(DEFAULT_APP_THEME_PREFERENCES, unavailable), false);
});
