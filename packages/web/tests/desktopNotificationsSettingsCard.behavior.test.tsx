import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import SettingsPanel from "../src/components/settings/SettingsPanel";
import { en as enMessages } from "../src/i18n/messages/en";
import api from "../src/api/client";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { useTranslationStore } from "../src/store/translationStore";

// Task #93 on the desktop: the Notifications tab must show the native desktop
// card (OS permission + enable/test) and never the Web Push card, and it must
// never sit on "Checking…" — no service-worker probe is involved at all.
const en = enMessages as Record<string, string>;
const originalGet = api.get;
const savedNotification = Object.getOwnPropertyDescriptor(globalThis, "Notification");
const savedRaftDesktop = Object.getOwnPropertyDescriptor(window, "raftDesktop");
let shown = 0;
class FakeNotification {
  static permission: NotificationPermission = "granted"; // the shell grants it outright; NOT the macOS switch
  onclick?: () => void;
  constructor() { shown += 1; }
}
function seedOwner() {
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as never;
  }
  useAuthStore.setState({ user: { id: "user-1", email: "u@example.com", gravatarHash: "", name: "U", displayName: "U", description: null, avatarUrl: null, emailVerified: true, preferredLanguage: null, displayLanguage: null, preferredTimezone: "UTC", autoTranslationEnabled: false, preferredTranslationDisplay: "translated", preferredTimeFormat: "24h", preferredMessageBodyFontSize: null, referralSource: null, referralSourceOther: null, referralSourceSkippedAt: null }, loading: false, initialized: true } as never);
  useServerStore.setState({ servers: [{ id: "s1", slug: "s1", name: "S1", role: "owner" }], current: { id: "s1", slug: "s1", name: "S1", role: "owner" }, members: [], loading: false } as never);
  useTranslationStore.setState({ settings: { ...useTranslationStore.getInitialState().settings, preferredTranslationMode: "off", preferredTimeFormat: "24h", effectiveTimeFormat: "24h" }, settingsServerId: "s1", settingsLoading: false, settingsError: null } as never);
}
beforeEach(() => {
  shown = 0;
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: FakeNotification });
  Object.defineProperty(window, "raftDesktop", { configurable: true, value: { isDesktop: true, focusWindow: () => {} } });
  api.get = (async (url: string) => { throw new Error(`Unexpected GET ${url}`); }) as typeof api.get;
});
afterEach(() => {
  cleanup(); api.get = originalGet;
  if (savedNotification) Object.defineProperty(globalThis, "Notification", savedNotification); else Reflect.deleteProperty(globalThis, "Notification");
  if (savedRaftDesktop) Object.defineProperty(window, "raftDesktop", savedRaftDesktop); else Reflect.deleteProperty(window, "raftDesktop");
  useServerStore.setState(useServerStore.getInitialState(), true);
  useTranslationStore.setState(useTranslationStore.getInitialState(), true);
  useAuthStore.setState({ user: null } as never);
});

test("desktop shell: native notifications card — system-managed status, no Web Push, test notification posts", async () => {
  seedOwner();
  render(<TestIntlProvider locale="en"><MemoryRouter><SettingsPanel tab="notifications" /></MemoryRouter></TestIntlProvider>);
  assert.ok(await screen.findByTestId("desktop-notifications-card"));
  assert.equal(screen.queryByText(en["settings.notifications.statusChecking"]), null, "no 'Checking…' — nothing to probe");
  assert.equal(screen.queryByRole("button", { name: en["settings.notifications.enable"] }), null, "no Web Push enable button on desktop");
  assert.ok(screen.getByText(en["settings.notifications.desktop.statusSystemManaged"]));
  assert.ok(screen.getByText(en["settings.notifications.desktop.systemHint"]));
  // No fabricated enabled/blocked wording anywhere on the card.
  assert.equal(screen.queryByText(en["settings.notifications.statusEnabled"]), null);
  assert.equal(screen.queryByText(en["settings.notifications.statusDenied"]), null);
  fireEvent.click(screen.getByRole("button", { name: en["settings.notifications.desktop.sendTest"] }));
  assert.equal(shown, 1);
  assert.ok(await screen.findByText(en["settings.notifications.desktop.testSent"]));
});
