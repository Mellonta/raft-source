import { create } from "zustand";
import {
  readHideEmptySidebarSections,
  writeHideEmptySidebarSections,
} from "../components/layout/sidebarEmptySectionVisibility";

export type MessageBodyFontSize = "sm" | "md" | "lg";

export const MESSAGE_BODY_FONT_SIZE_STORAGE_KEY = "slock_message_body_font_size";
export const SHOW_LIVE_AGENT_ACTIVITY_BAR_STORAGE_KEY = "slock_show_live_agent_activity_bar";
export const SHOW_AGENT_MODEL_NAME_STORAGE_KEY = "slock_show_agent_model_name";

export const MESSAGE_BODY_FONT_SIZE_OPTIONS: Array<{
  value: MessageBodyFontSize;
  sizeLabel: string;
  className: string;
}> = [
  { value: "sm", sizeLabel: "12px", className: "text-xs" },
  { value: "md", sizeLabel: "14px", className: "text-sm" },
  { value: "lg", sizeLabel: "16px", className: "text-base" },
];

const MESSAGE_BODY_FONT_SIZE_CLASSES: Record<MessageBodyFontSize, string> = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-base",
};

/**
 * RUI's MessageItemBody recipe intentionally provides a family default size
 * (`theme-*:text-sm`). The product preference is a user-owned override, so it
 * needs a terminal inline value at the shared message-body seam rather than a
 * class whose cascade position can be changed by a theme recipe.
 */
const MESSAGE_BODY_FONT_SIZE_VALUES: Record<MessageBodyFontSize, string> = {
  sm: "0.75rem",
  md: "0.875rem",
  lg: "1rem",
};

function isMessageBodyFontSize(value: unknown): value is MessageBodyFontSize {
  return value === "sm" || value === "md" || value === "lg";
}

function normalizeMessageBodyFontSize(value: unknown): MessageBodyFontSize {
  return value === "sm" || value === "lg" ? value : "md";
}

function readStoredMessageBodyFontSize(): MessageBodyFontSize {
  if (typeof localStorage === "undefined") return "md";
  try {
    return normalizeMessageBodyFontSize(localStorage.getItem(MESSAGE_BODY_FONT_SIZE_STORAGE_KEY));
  } catch {
    return "md";
  }
}

function persistMessageBodyFontSize(size: MessageBodyFontSize) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(MESSAGE_BODY_FONT_SIZE_STORAGE_KEY, size);
  } catch {
    // Keep the in-memory preference responsive even when storage is unavailable.
  }
}

function readStoredShowLiveAgentActivityBar(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    return localStorage.getItem(SHOW_LIVE_AGENT_ACTIVITY_BAR_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function persistShowLiveAgentActivityBar(show: boolean) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SHOW_LIVE_AGENT_ACTIVITY_BAR_STORAGE_KEY, String(show));
  } catch {
    // Keep the in-memory preference responsive even when storage is unavailable.
  }
}

// Default ON everywhere (@WAWQAQ 2026-09-10): the model label next to each
// agent name now shows by default on web AND desktop — previously desktop-only.
// An explicit stored choice (either way) always wins.
function readStoredShowAgentModelName(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    const stored = localStorage.getItem(SHOW_AGENT_MODEL_NAME_STORAGE_KEY);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

function persistShowAgentModelName(show: boolean) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SHOW_AGENT_MODEL_NAME_STORAGE_KEY, String(show));
  } catch {
    // Keep the in-memory preference responsive even when storage is unavailable.
  }
}

export function getMessageBodyFontSizeClass(size: MessageBodyFontSize): string {
  return MESSAGE_BODY_FONT_SIZE_CLASSES[size];
}

export function getMessageBodyFontSizeStyle(size: MessageBodyFontSize): { fontSize: string } {
  return { fontSize: MESSAGE_BODY_FONT_SIZE_VALUES[size] };
}

interface AppearanceState {
  messageBodyFontSize: MessageBodyFontSize;
  showLiveAgentActivityBar: boolean;
  showAgentModelName: boolean;
  hideEmptySidebarSections: boolean;
  setMessageBodyFontSize: (size: MessageBodyFontSize) => void;
  setShowLiveAgentActivityBar: (show: boolean) => void;
  setShowAgentModelName: (show: boolean) => void;
  setHideEmptySidebarSections: (hide: boolean) => void;
}

export const useAppearanceStore = create<AppearanceState>((set) => ({
  messageBodyFontSize: readStoredMessageBodyFontSize(),
  showLiveAgentActivityBar: readStoredShowLiveAgentActivityBar(),
  showAgentModelName: readStoredShowAgentModelName(),
  // Shared with the sidebar section context menu; both read/write this store so
  // Settings ⇄ right-click stay in sync. Default + storage live in
  // sidebarEmptySectionVisibility (desktop default-on; stored choice wins).
  hideEmptySidebarSections: readHideEmptySidebarSections(),
  setMessageBodyFontSize: (size) => {
    const next = normalizeMessageBodyFontSize(size);
    persistMessageBodyFontSize(next);
    set({ messageBodyFontSize: next });
  },
  setShowLiveAgentActivityBar: (show) => {
    persistShowLiveAgentActivityBar(show);
    set({ showLiveAgentActivityBar: show });
  },
  setShowAgentModelName: (show) => {
    persistShowAgentModelName(show);
    set({ showAgentModelName: show });
  },
  setHideEmptySidebarSections: (hide) => {
    writeHideEmptySidebarSections(hide);
    set({ hideEmptySidebarSections: hide });
  },
}));

export function seedMessageBodyFontSizeFromProfile(
  size: MessageBodyFontSize | null | undefined,
) {
  if (!isMessageBodyFontSize(size) || typeof localStorage === "undefined") return;
  try {
    if (isMessageBodyFontSize(localStorage.getItem(MESSAGE_BODY_FONT_SIZE_STORAGE_KEY))) {
      return;
    }
    localStorage.setItem(MESSAGE_BODY_FONT_SIZE_STORAGE_KEY, size);
    useAppearanceStore.setState({ messageBodyFontSize: size });
  } catch {
    // Profile migration is best-effort; the local in-memory default still works.
  }
}
