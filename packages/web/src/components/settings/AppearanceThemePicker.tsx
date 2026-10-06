import { Check } from "lucide-react";
import { useIntl } from "react-intl";
import {
  Card,
  CardContent,
  CardDescription,
  CardTitle,
  RadioGroup,
  RadioGroupItem,
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlLabel,
  useTheme,
} from "raft-ui";
import { presetFromTheme, APP_THEME_REGISTRY } from "../../theme/appTheme";
import type {
  AppAppearanceMode,
  AppResolvedMode,
  AppThemeId,
  AppThemePreferences,
  AppThemePreset,
} from "../../theme/appTheme";
export type { AppThemePreset } from "../../theme/appTheme";

export interface AppearanceThemePickerProps {
  /** Canonical controlled value used by the product Settings contract. */
  preset?: AppThemePreset;
  onChange?: (preset: AppThemePreset) => void;
  /** Controlled preset. When omitted, the app-level RUI provider owns it. */
  value?: AppThemePreset;
  onValueChange?: (preset: AppThemePreset) => void;
  /** Reserved compatibility surface; the current product UI intentionally shows three cards. */
  includeSystemCard?: boolean;
  /** New two-axis product contract. When supplied, the picker renders mode and
   * per-mode theme choices instead of the legacy mixed preset radios. */
  preferences?: AppThemePreferences;
  resolvedMode?: AppResolvedMode;
  onModeChange?: (mode: AppAppearanceMode) => void;
  onThemeForModeChange?: (mode: AppResolvedMode, themeId: AppThemeId) => void;
}

type ThemeOption = {
  value: AppThemePreset;
  labelId:
    | "settings.appearance.themeBrutal"
    | "settings.appearance.themeElegant"
    | "settings.appearance.themeElegantDark"
    | "settings.appearance.themeElegantSystem";
  family: "brutal" | "elegant";
  mode: "light" | "dark" | "system";
};

const BASE_OPTIONS: readonly ThemeOption[] = [
  {
    value: "brutal",
    labelId: "settings.appearance.themeBrutal",
    family: "brutal",
    mode: "light",
  },
  {
    value: "elegant-light",
    labelId: "settings.appearance.themeElegant",
    family: "elegant",
    mode: "light",
  },
  {
    value: "elegant-dark",
    labelId: "settings.appearance.themeElegantDark",
    family: "elegant",
    mode: "dark",
  },
] as const;
// The three user-facing accessible names are Brutal, Elegant, and Elegant dark.

const SYSTEM_OPTION: ThemeOption = {
  value: "elegant-system",
  labelId: "settings.appearance.themeElegantSystem",
  family: "elegant",
  mode: "system",
};

function selectPreset(
  preset: AppThemePreset,
  setTheme: ReturnType<typeof useTheme>["setTheme"],
) {
  if (preset === "brutal") {
    setTheme("brutal");
    return;
  }
  const mode = preset === "elegant-dark" ? "dark" : preset === "elegant-system" ? "system" : "light";
  setTheme("elegant", { mode });
}

export function AppearanceThemePicker({
  preset,
  onChange,
  value,
  onValueChange,
  includeSystemCard = false,
  preferences,
  resolvedMode,
  onModeChange,
  onThemeForModeChange,
}: AppearanceThemePickerProps) {
  const { formatMessage } = useIntl();
  const { theme, mode, setTheme } = useTheme();
  const activePreset = preset ?? value ?? presetFromTheme(theme, mode);
  const options = includeSystemCard ? [...BASE_OPTIONS, SYSTEM_OPTION] : BASE_OPTIONS;

  const handleValueChange = (nextValue: string) => {
    const nextPreset = nextValue as AppThemePreset;
    (onChange ?? onValueChange)?.(nextPreset);
    if (preset === undefined && value === undefined) selectPreset(nextPreset, setTheme);
  };

  if (preferences && resolvedMode && onModeChange && onThemeForModeChange) {
    const modeOptions: readonly AppAppearanceMode[] = ["light", "dark", "system"];
    const modeLabels: Record<AppAppearanceMode, string> = {
      light: formatMessage({ id: "settings.appearance.modeLight" }),
      dark: formatMessage({ id: "settings.appearance.modeDark" }),
      system: formatMessage({ id: "settings.appearance.modeSystem" }),
    };
    const themeModes: readonly AppResolvedMode[] = ["light", "dark"];
    return (
      <div className="space-y-4" data-testid="appearance-theme-picker">
        <div className="space-y-2">
          <div className="text-xs font-bold uppercase tracking-widest text-foreground-muted">
            {formatMessage({ id: "settings.appearance.modeTitle" })}
          </div>
          <SegmentedControl<AppAppearanceMode>
            value={preferences.mode}
            onValueChange={onModeChange}
            aria-label={formatMessage({ id: "settings.appearance.modeAria" })}
            className="w-fit max-w-full"
          >
            {modeOptions.map((mode) => (
              <SegmentedControlItem key={mode} value={mode} data-testid={`appearance-mode-${mode}`}>
                <SegmentedControlLabel>{modeLabels[mode]}</SegmentedControlLabel>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          <p className="text-xs text-foreground-muted">
            {formatMessage({ id: "settings.appearance.modeDescription" })}
          </p>
        </div>
        {themeModes.map((themeMode) => {
          const themeId = themeMode === "light" ? preferences.lightThemeId : preferences.darkThemeId;
          const isEffective = resolvedMode === themeMode;
          const groupLabel = formatMessage({
            id: themeMode === "light"
              ? "settings.appearance.lightThemeTitle"
              : "settings.appearance.darkThemeTitle",
          });
          const options = Object.values(APP_THEME_REGISTRY).filter((definition) =>
            definition.supportedModes.includes(themeMode),
          );
          return (
            <div key={themeMode} className="space-y-2" data-testid={`appearance-theme-group-${themeMode}`}>
              <div className="flex items-center gap-2">
                <div className="text-sm font-bold text-foreground-strong">
                  {groupLabel}
                </div>
                {isEffective ? (
                  <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[10px] font-bold text-primary-strong">
                    {formatMessage({ id: "settings.appearance.currentTheme" })}
                  </span>
                ) : null}
              </div>
              <RadioGroup
                value={themeId}
                onValueChange={(value) => onThemeForModeChange(themeMode, value as AppThemeId)}
                aria-label={groupLabel}
                className="grid gap-2 sm:grid-cols-2"
              >
                {options.map((option) => {
                  const selected = themeId === option.id;
                  const label = formatMessage({
                    id: option.id === "brutal"
                      ? "settings.appearance.themeBrutal"
                      : "settings.appearance.themeElegant",
                  });
                  const isBrutal = option.id === "brutal";
                  // The heavy ring marks the SELECTION, not the card's family: an
                  // unselected Brutal card must not sit in a permanent heavy black
                  // frame (Artea, 2026-09-17). It still needs a quiet boundary of
                  // its own, so the unselected state keeps Brutal's 2px geometry
                  // in the neutral line colour instead of dropping the frame
                  // entirely. Border width never changes, so selecting cannot
                  // shift the layout.
                  const cardClass = isBrutal
                    ? `border-2 bg-layer-panel ${
                        selected ? "border-line-strong shadow-raft-md" : "border-line-muted shadow-none"
                      }`
                    : `rounded-lg border-[0.5px] bg-layer-panel shadow-none ${
                        selected
                          ? "border-accent-strong theme-brutal:border-soft-signal"
                          : "border-line-muted"
                      }`;
                  return (
                    <div
                      key={option.id}
                      className="group min-w-0 focus-within:outline-none"
                    >
                      <RadioGroupItem
                        appearance="none"
                        value={option.id}
                        aria-label={label}
                        className="peer"
                        data-testid={`appearance-${themeMode}-theme-${option.id}`}
                      />
                      <div
                        data-theme={option.family}
                        className={`${themeMode} text-left transition-[box-shadow,transform] group-hover:-translate-y-px peer-focus-visible:ring-2 peer-focus-visible:ring-accent-strong theme-brutal:peer-focus-visible:ring-soft-signal ${cardClass}`}
                        onClick={() => onThemeForModeChange(themeMode, option.id)}
                      >
                        <div className="p-3">
                          {/* The preview carries the card's own theme scope, so its
                              geometry must follow that family: square corners and a
                              hard shadow inside the Brutal card, soft radii inside
                              Elegant. We select the classes in JS based on option.id (isBrutal)
                              rather than relying on CSS theme-brutal descendant matching,
                              which would match when html data-theme="brutal" is an ancestor. */}
                          <div
                            className={`relative h-16 overflow-hidden bg-layer-canvas p-2 ${
                              isBrutal
                                ? "rounded-none border-2 border-line-strong"
                                : "rounded-md border border-line-muted"
                            }`}
                            aria-hidden="true"
                          >
                            <div
                              className={`h-full bg-layer-panel p-2 ${
                                isBrutal
                                  ? "rounded-none border-2 border-black shadow-brutal-xs"
                                  : "rounded border border-line-muted shadow-raft-xs"
                              }`}
                            >
                              <div
                                className={`h-1.5 w-3/5 bg-foreground-muted/35 ${
                                  isBrutal ? "rounded-none" : "rounded-full"
                                }`}
                              />
                              <div className="mt-2 flex items-center gap-1.5">
                                <div
                                  className={`size-3 ${
                                    isBrutal ? "rounded-none bg-primary-400" : "rounded-sm bg-primary-soft"
                                  }`}
                                />
                                <div
                                  className={`h-1.5 flex-1 bg-fill-muted ${
                                    isBrutal ? "rounded-none" : "rounded-full"
                                  }`}
                                />
                                <div
                                  className={`h-3 w-7 ${
                                    isBrutal ? "rounded-none bg-accent-400" : "rounded-sm bg-accent-soft"
                                  }`}
                                />
                              </div>
                            </div>
                          </div>
                          <div className="mt-2 flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground-strong">{label}</span>
                            {selected ? (
                              <Check
                                size={14}
                                className={`shrink-0 ${isBrutal ? "text-primary-500" : "text-accent-strong"}`}
                                aria-hidden="true"
                              />
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </RadioGroup>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="appearance-theme-picker">
      <RadioGroup
        value={activePreset}
        onValueChange={handleValueChange}
        className={`grid gap-2 ${includeSystemCard ? "sm:grid-cols-2 xl:grid-cols-4" : "sm:grid-cols-3"}`}
        aria-label={formatMessage({ id: "settings.appearance.themeAria" })}
      >
        {options.map((option) => {
          const selected = activePreset === option.value;
          const label = formatMessage({ id: option.labelId });
          const previewMode = option.mode === "system" ? "light" : option.mode;

          return (
            <div
              key={option.value}
              className="group min-w-0 focus-within:outline-none"
              data-testid={`appearance-theme-${option.value}`}
            >
              <RadioGroupItem
                appearance="none"
                value={option.value}
                aria-label={label}
                className="peer"
              />
              <Card
                onClick={() => handleValueChange(option.value)}
                className="h-full transition-[opacity,box-shadow,transform] group-hover:-translate-y-px group-hover:opacity-100 peer-focus-visible:ring-2 peer-focus-visible:ring-line-strong peer-data-checked:ring-2 peer-data-checked:ring-accent-strong theme-brutal:peer-data-checked:ring-soft-signal"
              >
                <CardContent className="space-y-2 p-3">
                  <div
                    data-theme={option.family}
                    className={`${previewMode} relative h-16 overflow-hidden rounded-md border border-line-muted bg-layer-canvas p-2`}
                    aria-hidden="true"
                  >
                    <div className="h-full rounded border border-line-muted bg-layer-panel p-2 shadow-raft-xs">
                      <div className="h-1.5 w-3/5 rounded-full bg-foreground-muted/35" />
                      <div className="mt-2 flex items-center gap-1.5">
                        <div
                          className={`size-3 rounded-sm ${
                            option.family === "brutal" ? "bg-primary-400" : "bg-primary-soft"
                          }`}
                        />
                        <div className="h-1.5 flex-1 rounded-full bg-fill-muted" />
                        <div
                          className={`h-3 w-7 rounded-sm ${
                            option.family === "brutal" ? "bg-accent-400" : "bg-accent-soft"
                          }`}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="flex min-w-0 items-center gap-2">
                    <CardTitle className="min-w-0 flex-1 truncate text-sm">{label}</CardTitle>
                    {selected ? (
                      <Check
                        size={14}
                        className="shrink-0 text-accent-strong theme-brutal:text-primary-500"
                        aria-hidden="true"
                      />
                    ) : null}
                  </div>
                  <CardDescription className="min-h-4 text-[11px]">
                    {selected
                      ? formatMessage({ id: "settings.appearance.savedOnDevice" })
                      : null}
                  </CardDescription>
                </CardContent>
              </Card>
            </div>
          );
        })}
      </RadioGroup>
    </div>
  );
}

export default AppearanceThemePicker;
