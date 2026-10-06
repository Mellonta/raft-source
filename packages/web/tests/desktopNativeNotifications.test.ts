import assert from "node:assert/strict";
import "./helpers/domSetup";
import { isDesktopNativeNotificationsAvailable, showDesktopTestNotification } from "../src/utils/desktopNativeNotifications";

// Task #93. The desktop shell grants the Chromium notification permission
// outright, so Notification.permission is not the macOS switch and must not be
// surfaced as an enabled/blocked status. What the helpers can honestly do:
// know whether the API exists in the shell, and post a notification that
// behaves like a real one.
const savedNotification = Object.getOwnPropertyDescriptor(globalThis, "Notification");
const savedRaftDesktop = Object.getOwnPropertyDescriptor(window, "raftDesktop");
let created: Array<{ title: string; body?: string; onclick?: () => void }> = [];
let focusCalls = 0;

class FakeNotification {
  static permission: NotificationPermission = "granted"; // always, in the shell
  onclick?: () => void;
  body?: string;
  constructor(public title: string, options?: { body?: string }) {
    this.body = options?.body;
    created.push(this as never);
  }
}

beforeEach(() => {
  created = []; focusCalls = 0;
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: FakeNotification });
  Object.defineProperty(window, "raftDesktop", { configurable: true, value: { isDesktop: true, focusWindow: () => { focusCalls += 1; } } });
});
afterEach(() => {
  if (savedNotification) Object.defineProperty(globalThis, "Notification", savedNotification); else Reflect.deleteProperty(globalThis, "Notification");
  if (savedRaftDesktop) Object.defineProperty(window, "raftDesktop", savedRaftDesktop); else Reflect.deleteProperty(window, "raftDesktop");
});

test("outside the desktop shell native notifications are unavailable and nothing is posted", () => {
  Reflect.deleteProperty(window, "raftDesktop");
  assert.equal(isDesktopNativeNotificationsAvailable(), false);
  assert.equal(showDesktopTestNotification({ title: "t", body: "b" }), false);
  assert.equal(created.length, 0);
});

test("inside the shell without a Notification API it is unavailable", () => {
  Reflect.deleteProperty(globalThis, "Notification");
  assert.equal(isDesktopNativeNotificationsAvailable(), false);
  assert.equal(showDesktopTestNotification({ title: "t", body: "b" }), false);
});

test("a test notification is posted like a real one: title/body carried, click focuses the window", () => {
  assert.equal(isDesktopNativeNotificationsAvailable(), true);
  assert.equal(showDesktopTestNotification({ title: "Raft Desktop", body: "hi" }), true);
  assert.equal(created.length, 1);
  assert.equal(created[0].title, "Raft Desktop");
  assert.equal(created[0].body, "hi");
  created[0].onclick?.();
  assert.equal(focusCalls, 1);
});

test("a throwing Notification constructor is contained", () => {
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: class { constructor() { throw new TypeError("nope"); } } });
  assert.equal(showDesktopTestNotification({ title: "t", body: "b" }), false);
});
