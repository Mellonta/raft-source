import type { IntlShape } from "react-intl";

export interface KeyboardShortcutEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

function isApplePlatform(platform: string | null | undefined): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform ?? "");
}

export function isGlobalSearchShortcut(
  event: KeyboardShortcutEvent,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (event.key.toLowerCase() !== "k") return false;
  return isApplePlatform(platform) ? !!event.metaKey && !event.ctrlKey : !!event.ctrlKey && !event.metaKey;
}

export function getGlobalSearchShortcutLabel(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
  formatMessage?: IntlShape["formatMessage"],
): string {
  if (isApplePlatform(platform)) return "⌘K";
  return formatMessage
    ? formatMessage({ id: "common.shortcut.ctrlK" })
    : "Ctrl+K";
}

export function isSystemScreenshotShortcut(
  event: KeyboardShortcutEvent,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  const key = event.key.toLowerCase();
  if (isApplePlatform(platform)) {
    return !!event.metaKey
      && !!event.shiftKey
      && !event.altKey
      && (key === "3" || key === "4" || key === "5");
  }
  return key === "printscreen";
}

function isMacScreenshotModifierPrelude(
  event: KeyboardShortcutEvent,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (!isApplePlatform(platform) || !event.metaKey || !event.shiftKey || event.altKey) return false;
  const key = event.key.toLowerCase();
  return key === "meta" || key === "shift" || key === "control";
}

const TEXT_EDITABLE_INPUT_TYPES = new Set([
  "",
  "date",
  "datetime-local",
  "email",
  "month",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "time",
  "url",
  "week",
]);

function isTextEditableElement(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (view && element instanceof view.HTMLTextAreaElement) return true;
  if (view && element instanceof view.HTMLInputElement) {
    return TEXT_EDITABLE_INPUT_TYPES.has(element.type.toLowerCase());
  }
  return !!view && element instanceof view.HTMLElement && element.isContentEditable;
}

export function blurFocusedControlForScreenshotShortcut(
  event: KeyboardShortcutEvent,
  doc = typeof document === "undefined" ? undefined : document,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (!doc || (!isSystemScreenshotShortcut(event, platform) && !isMacScreenshotModifierPrelude(event, platform))) return false;
  const active = doc.activeElement;
  const view = doc.defaultView;
  if (!view || !(active instanceof view.HTMLElement) || active === doc.body) return false;
  if (isTextEditableElement(active)) return false;
  active.blur();
  return true;
}
