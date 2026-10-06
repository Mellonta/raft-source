import assert from "node:assert/strict";
import "./helpers/domSetup";
import { render, screen } from "@testing-library/react";
import { AppearanceThemePicker } from "../src/components/settings/AppearanceThemePicker";
import { TestIntlProvider } from "./helpers/intl";
import type { AppAppearancePreferences } from "../src/types/theme";

test("AppearanceThemePicker renders Elegant preview cards with soft geometry even under a Brutal root", () => {
  const preferences: AppAppearancePreferences = {
    mode: "system",
    lightTheme: "brutal",
    darkTheme: "elegant",
  };

  render(
    <TestIntlProvider>
      <div data-theme="brutal">
        <AppearanceThemePicker
          preferences={preferences}
          resolvedMode="light"
          onModeChange={() => {}}
          onThemeForModeChange={() => {}}
        />
      </div>
    </TestIntlProvider>,
  );

  // Group light
  const lightBrutalCard = screen.getByTestId("appearance-light-theme-brutal").parentElement;
  const lightElegantCard = screen.getByTestId("appearance-light-theme-elegant").parentElement;

  assert.ok(lightBrutalCard);
  assert.ok(lightElegantCard);

  // Check preview geometry within the Elegant light card
  const elegantPreviewMock = lightElegantCard.querySelector('div[aria-hidden="true"]');
  assert.ok(elegantPreviewMock, "preview mock container must exist");
  assert.ok(
    elegantPreviewMock.classList.contains("rounded-md"),
    "Elegant preview outer frame must have rounded-md, not rounded-none",
  );
  assert.ok(
    !elegantPreviewMock.classList.contains("rounded-none"),
    "Elegant preview outer frame must not have rounded-none",
  );

  const elegantInnerMock = elegantPreviewMock.firstElementChild;
  assert.ok(elegantInnerMock, "inner mock card must exist");
  assert.ok(
    elegantInnerMock.classList.contains("rounded"),
    "Elegant inner mock must have rounded, not rounded-none",
  );
  assert.ok(
    !elegantInnerMock.classList.contains("rounded-none"),
    "Elegant inner mock must not have rounded-none",
  );
});
