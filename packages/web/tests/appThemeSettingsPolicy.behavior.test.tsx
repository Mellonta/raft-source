import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AppearanceThemeSettingsControl } from "../src/components/settings/SettingsPanel";
import { AppThemeProvider } from "../src/theme/AppThemeProvider";
import { useAppTheme } from "../src/hooks/useAppTheme";
import { useAuthStore } from "../src/store/authStore";
import {
  APP_THEME_PREFERENCES_STORAGE_KEY,
  APP_THEME_STORAGE_KEY,
} from "../src/theme/appTheme";
import { TestIntlProvider } from "./helpers/intl";

const originalMatchMedia = window.matchMedia;

function accessToken(subject: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: subject, type: "access" })).toString("base64url");
  return `header.${payload}.signature`;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.matchMedia = originalMatchMedia;
  useAuthStore.setState({ accessToken: null, user: null });
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.classList.remove("light", "dark");
  document.documentElement.style.removeProperty("color-scheme");
});

beforeEach(() => {
  useAuthStore.setState({ accessToken: accessToken("appearance-account"), user: null });
});

let observedPreset = "";

function PolicyProbe() {
  const { preset } = useAppTheme();
  observedPreset = preset;
  return null;
}

function ProductAppearance() {
  return (
    <TestIntlProvider locale="en">
      <AppThemeProvider>
        <PolicyProbe />
        <AppearanceThemeSettingsControl />
      </AppThemeProvider>
    </TestIntlProvider>
  );
}

test("the real Settings Appearance path saves the device preference", () => {
  window.localStorage.setItem(APP_THEME_STORAGE_KEY, "brutal");
  observedPreset = "";
  render(<ProductAppearance />);

  fireEvent.click(screen.getByTestId("appearance-mode-dark"));
  fireEvent.click(screen.getByTestId("appearance-dark-theme-elegant"));
  assert.equal(observedPreset, "elegant-dark", "the settings control received the preset mutation");
  assert.deepEqual(
    JSON.parse(window.localStorage.getItem(APP_THEME_PREFERENCES_STORAGE_KEY) ?? "null"),
    { mode: "dark", lightThemeId: "brutal", darkThemeId: "elegant" },
  );
  assert.equal(document.documentElement.dataset.theme, "elegant");
  assert.equal(document.documentElement.classList.contains("dark"), true);
  assert.ok(screen.queryByRole("status") === null, "there is no deployment rollback notice");
});

test("Light, Dark, and System mode preserve independent theme choices across remount", () => {
  window.localStorage.setItem(
    APP_THEME_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ mode: "light", lightThemeId: "elegant", darkThemeId: "elegant" }),
  );
  const view = render(<ProductAppearance />);

  fireEvent.click(screen.getByTestId("appearance-light-theme-brutal"));
  fireEvent.click(screen.getByTestId("appearance-mode-system"));
  assert.deepEqual(
    JSON.parse(window.localStorage.getItem(APP_THEME_PREFERENCES_STORAGE_KEY) ?? "null"),
    { mode: "system", lightThemeId: "brutal", darkThemeId: "elegant" },
    "switching mode does not overwrite either per-mode theme choice",
  );

  view.unmount();
  render(<ProductAppearance />);
  assert.equal(screen.getByTestId("appearance-mode-system").getAttribute("aria-checked"), "true");
  assert.equal(screen.getByTestId("appearance-light-theme-brutal").getAttribute("aria-checked"), "true");
  assert.equal(screen.getByTestId("appearance-dark-theme-elegant").getAttribute("aria-checked"), "true");
});

test("selected theme cards use their own visual personality", () => {
  render(<ProductAppearance />);
  const brutalRadio = screen.getByTestId("appearance-light-theme-brutal");
  const elegantRadio = screen.getByTestId("appearance-light-theme-elegant");
  const brutalCard = brutalRadio.parentElement?.querySelector<HTMLElement>("[data-theme='brutal']");
  const elegantCard = elegantRadio.parentElement?.querySelector<HTMLElement>("[data-theme='elegant']");
  assert.ok(brutalCard);
  assert.ok(elegantCard);

  assert.match(brutalCard.className, /shadow-raft-md/);
  assert.match(brutalCard.className, /border-line-strong/);
  assert.doesNotMatch(brutalCard.className, /border-primary-400/);
  assert.match(elegantCard.className, /shadow-none/);
  assert.match(elegantCard.className, /border-line-muted/);

  const brutalPreview = brutalCard.querySelector<HTMLElement>('[aria-hidden="true"]');
  assert.ok(brutalPreview?.classList.contains("rounded-none"), "brutal preview must be rounded-none");
  assert.ok(brutalPreview?.firstElementChild?.classList.contains("shadow-brutal-xs"), "brutal inner mock must have shadow-brutal-xs");

  const elegantPreview = elegantCard.querySelector<HTMLElement>('[aria-hidden="true"]');
  assert.ok(elegantPreview?.classList.contains("rounded-md"), "elegant preview must be rounded-md");
  assert.equal(elegantPreview?.classList.contains("rounded-none"), false, "elegant preview must not be rounded-none");
  assert.ok(elegantPreview?.firstElementChild?.classList.contains("shadow-raft-xs"), "elegant inner mock must have shadow-raft-xs");

  fireEvent.click(elegantRadio);
  assert.match(elegantCard.className, /border-primary-400/);
  assert.match(elegantCard.className, /shadow-none/);
  assert.match(brutalCard.className, /shadow-none/);
  assert.doesNotMatch(brutalCard.className, /border-line-strong/);
  assert.match(brutalCard.className, /border-line-muted/);
});
