// @ts-nocheck
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

test("left rail and mobile sidebar use the notification trigger", () => {
  const leftRail = read("src/components/layout/LeftRail.tsx");
  const sidebar = read("src/components/layout/Sidebar.tsx");

  assert.match(leftRail, /import NotificationTrigger from "\.\/NotificationTrigger";/);
  assert.match(sidebar, /import NotificationTrigger from "\.\/NotificationTrigger";/);
  assert.doesNotMatch(leftRail, /WarningTrigger/);
  assert.doesNotMatch(sidebar, /WarningTrigger/);
});



test("system notification entries use kind, not warning severity", () => {
  const notifications = read("src/components/layout/useSystemNotifications.tsx");
  const kind = read("src/components/layout/notificationKind.ts");

  assert.match(notifications, /export interface NotificationEntry \{/);
  assert.match(notifications, /kind: NotificationKind;/);
  assert.doesNotMatch(notifications, /severity: WarningSeverity/);
  assert.match(kind, /export type NotificationKind = "error" \| "warning" \| "info";/);
});

test("joint channel invites are accepted from email links, not notification center rows", () => {
  const notifications = read("src/components/layout/useSystemNotifications.tsx");
  const app = read("src/App.tsx");

  assert.doesNotMatch(notifications, /joint-invites/);
  assert.doesNotMatch(notifications, /Joint channel invite/);
  assert.match(app, /jointInvite/);
  assert.match(app, /\/channels\/joint-invites\/\$\{encodeURIComponent\(jointInviteId\)\}\/accept/);
});

test("rail Help and Notification use raft-ui hover triggers", () => {
  const leftRail = read("src/components/layout/LeftRail.tsx");
  const trigger = read("src/components/layout/NotificationTrigger.tsx");

  assert.match(leftRail, /Popover,\n\s+PopoverContent,\n\s+PopoverTrigger,/);
  assert.match(leftRail, /<PopoverTrigger\s+openOnHover\s+delay=\{0\}\s+closeDelay=\{120\}/);
  assert.match(leftRail, /forwardRef<HTMLButtonElement, RailTabButtonProps>/);
  assert.match(leftRail, /<AppRailItem[\s\S]*selected=\{active\}/);
  assert.match(trigger, /import\s*\{[^}]*\bNotificationCenter\b[^}]*\}\s*from\s*"raft-ui";/);
  assert.match(trigger, /<PopoverTrigger openOnHover delay=\{0\} closeDelay=\{120\}/);
  assert.doesNotMatch(leftRail, /setTimeout|document\.addEventListener/);
  assert.doesNotMatch(trigger, /setTimeout|document\.addEventListener|useViewportClamp/);
});

test("slock system notifications are rendered with raft-ui notification-center primitives", () => {
  const adapter = read("src/components/layout/NotificationCenter.tsx");

  assert.match(adapter, /NotificationCenterPopup/);
  assert.match(adapter, /NotificationCenterItem/);
  assert.match(adapter, /from "raft-ui";/);
  assert.match(adapter, /dismissedNotificationStore/);
  assert.doesNotMatch(adapter, /KIND_DOT_BG/);
  assert.doesNotMatch(adapter, /DEFAULT_KIND_ICON/);
});

test("dismissed notification fingerprints persist per server across refresh", () => {
  const store = read("src/components/layout/dismissedNotificationStore.ts");
  const notifications = read("src/components/layout/useSystemNotifications.tsx");

  assert.match(store, /STORAGE_PREFIX = "slock:notification-center:dismissed"/);
  assert.match(store, /loadForServer: \(serverId: string \| null\) => void/);
  assert.match(store, /window\.localStorage\.setItem\(storageKey, JSON\.stringify/);
  assert.match(notifications, /loadDismissedNotifications\(serverId\)/);
  assert.doesNotMatch(notifications, /resetDismissedNotifications\(\)/);
});
