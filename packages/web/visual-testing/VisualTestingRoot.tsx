import type { ReactNode } from "react";
import { ThemeProvider, TooltipProvider } from "raft-ui";
import { BrowserRouter } from "react-router-dom";

import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { AppThemeContext } from "../src/hooks/useAppTheme";
import { preferencesFromPreset } from "../src/theme/appTheme";
import type { AppThemePreset } from "../src/theme/appTheme";

export function VisualTestingRoot({
  children,
  defaultTheme,
}: {
  children: ReactNode;
  defaultTheme: "brutal" | "elegant";
}) {
  const preset: AppThemePreset = defaultTheme === "elegant" ? "elegant-light" : "brutal";
  const preferences = preferencesFromPreset(preset);
  const fixedThemeContext = {
    preset,
    preferences,
    resolvedMode: "light" as const,
    setPreferences: () => undefined,
    setMode: () => undefined,
    setThemeForMode: () => undefined,
    setPreset: () => undefined,
  };

  return (
    <ThemeProvider defaultTheme={defaultTheme} defaultMode="light">
      <AppThemeContext.Provider value={fixedThemeContext}>
        <TooltipProvider>
          <BrowserRouter>
            <LocaleProvider>
              <IntlProviderWrapper>{children}</IntlProviderWrapper>
            </LocaleProvider>
          </BrowserRouter>
        </TooltipProvider>
      </AppThemeContext.Provider>
    </ThemeProvider>
  );
}
