import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { useAuthStore } from "../src/store/authStore";
import {
  AppThemeProvider,
  useAppTheme,
} from "../src/theme/AppThemeProvider";
import {
  APP_THEME_PREFERENCES_STORAGE_KEY,
  APP_THEME_STORAGE_KEY,
} from "../src/theme/appTheme";

function accessToken(subject: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: subject, type: "access" }))
    .toString("base64url");
  return `header.${payload}.signature`;
}

let systemDark = false;
window.matchMedia = ((query: string) => ({
  get matches() {
    return query === "(prefers-color-scheme: dark)" && systemDark;
  },
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
})) as typeof window.matchMedia;

function ThemeProbe() {
  const { preset, setPreset } = useAppTheme();
  useEffect(() => {
    beforePaintSnapshots.push({
      preset,
      rootTheme: document.documentElement.dataset.theme,
      light: document.documentElement.classList.contains("light"),
      dark: document.documentElement.classList.contains("dark"),
      themeColor: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content,
    });
  }, [preset]);
  return (
    <div>
      <output data-testid="preset">{preset}</output>
      <button type="button" onClick={() => setPreset("elegant-light")}>Use elegant</button>
    </div>
  );
}

const originalLocalStorage = window.localStorage;
const beforePaintSnapshots: Array<{
  preset: string;
  rootTheme: string | undefined;
  light: boolean;
  dark: boolean;
  themeColor: string | undefined;
}> = [];

function setAccount(accountId: string | null) {
  useAuthStore.setState({
    accessToken: accountId === null ? null : accessToken(accountId),
    user: null,
  });
}

beforeEach(() => {
  const themeColor = document.createElement("meta");
  themeColor.name = "theme-color";
  themeColor.content = "#FFD440";
  document.head.append(themeColor);
});

afterEach(() => {
  cleanup();
  systemDark = false;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: originalLocalStorage,
  });
  document.querySelector('meta[name="theme-color"]')?.remove();
  window.localStorage.clear();
  beforePaintSnapshots.length = 0;
  setAccount(null);
  delete document.documentElement.dataset.theme;
  document.documentElement.classList.remove("light", "dark");
  document.documentElement.style.removeProperty("color-scheme");
});

test("legacy brutal stays light even when the system is dark and storage cannot be written", async () => {
  systemDark = true;
  const values = new Map<string, string>([[APP_THEME_STORAGE_KEY, "brutal"]]);
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return values.size;
      },
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: () => {
        throw new Error("storage is read-only");
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      clear: () => {
        values.clear();
      },
    },
  });

  render(
    <AppThemeProvider>
      <ThemeProbe />
    </AppThemeProvider>,
  );

  assert.equal(screen.getByTestId("preset").textContent, "brutal");
  await waitFor(() => {
    assert.equal(document.documentElement.dataset.theme, "brutal");
    assert.equal(document.documentElement.classList.contains("dark"), false);
  });
  assert.equal(window.localStorage.getItem(APP_THEME_PREFERENCES_STORAGE_KEY), null);
});

test("the device preference restores and persists without an account", async () => {
  window.localStorage.setItem(APP_THEME_STORAGE_KEY, "elegant-dark");

  render(
    <AppThemeProvider>
      <ThemeProbe />
    </AppThemeProvider>,
  );

  assert.equal(screen.getByTestId("preset").textContent, "elegant-dark");
  await waitFor(() => {
    assert.equal(document.documentElement.dataset.theme, "elegant");
    assert.equal(document.documentElement.classList.contains("dark"), true);
    assert.equal(
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content,
      "#141411",
    );
  });

  fireEvent.click(screen.getByRole("button", { name: "Use elegant" }));

  assert.equal(screen.getByTestId("preset").textContent, "elegant-light");
  assert.equal(
    window.localStorage.getItem(APP_THEME_PREFERENCES_STORAGE_KEY),
    JSON.stringify({ mode: "light", lightThemeId: "elegant", darkThemeId: "elegant" }),
  );
  assert.deepEqual(beforePaintSnapshots.at(-1), {
    preset: "elegant-light",
    rootTheme: "elegant",
    light: true,
    dark: false,
    themeColor: "#FFFFFF",
  });
});

test("switching accounts keeps the same device theme", () => {
  window.localStorage.setItem(
    APP_THEME_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ mode: "dark", lightThemeId: "brutal", darkThemeId: "elegant" }),
  );
  setAccount("account-a");

  render(
    <AppThemeProvider>
      <ThemeProbe />
    </AppThemeProvider>,
  );
  assert.equal(screen.getByTestId("preset").textContent, "elegant-dark");

  act(() => setAccount("account-b"));
  assert.equal(screen.getByTestId("preset").textContent, "elegant-dark");

  act(() => setAccount(null));
  assert.equal(screen.getByTestId("preset").textContent, "elegant-dark");
});

test("a storage event refreshes the device preference", () => {
  window.localStorage.clear();
  render(
    <AppThemeProvider>
      <ThemeProbe />
    </AppThemeProvider>,
  );
  assert.equal(screen.getByTestId("preset").textContent, "brutal");

  act(() => window.dispatchEvent(new StorageEvent("storage", {
    key: APP_THEME_PREFERENCES_STORAGE_KEY,
    newValue: JSON.stringify({ mode: "light", lightThemeId: "elegant", darkThemeId: "elegant" }),
  })));
  assert.equal(screen.getByTestId("preset").textContent, "elegant-light");
});
