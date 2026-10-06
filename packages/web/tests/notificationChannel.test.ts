import assert from "node:assert/strict";
import "./helpers/domSetup";
import { resolveNotificationChannel } from "../src/utils/notificationChannel";

// Task #93: the Notifications settings must decide the delivery mechanism from
// runtime capabilities, synchronously, with a concrete reason when none applies.

const saved = {
  notification: Object.getOwnPropertyDescriptor(globalThis, "Notification"),
  pushManager: Object.getOwnPropertyDescriptor(window, "PushManager"),
  serviceWorker: Object.getOwnPropertyDescriptor(navigator, "serviceWorker"),
  raftDesktop: Object.getOwnPropertyDescriptor(window, "raftDesktop"),
  secure: Object.getOwnPropertyDescriptor(window, "isSecureContext"),
};

function define(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { configurable: true, value });
}
function restore(target: object, key: string, d: PropertyDescriptor | undefined) {
  if (d) Object.defineProperty(target, key, d); else Reflect.deleteProperty(target, key);
}
function browserWithPush() {
  define(globalThis, "Notification", { permission: "default" });
  define(window, "PushManager", class PushManager {});
  define(navigator, "serviceWorker", { getRegistration: async () => null });
  define(window, "isSecureContext", true);
}

afterEach(() => {
  restore(globalThis, "Notification", saved.notification);
  restore(window, "PushManager", saved.pushManager);
  restore(navigator, "serviceWorker", saved.serviceWorker);
  restore(window, "raftDesktop", saved.raftDesktop);
  restore(window, "isSecureContext", saved.secure);
});

test("a push-capable secure browser resolves to web-push", () => {
  browserWithPush();
  assert.deepEqual(resolveNotificationChannel(), { kind: "web-push" });
});

test("the Raft Desktop shell resolves to desktop-native even though the Web Push APIs exist", () => {
  browserWithPush();
  define(window, "raftDesktop", { isDesktop: true });
  assert.deepEqual(resolveNotificationChannel(), { kind: "desktop-native" });
});

test("each missing capability yields its own unsupported reason", () => {
  browserWithPush(); Reflect.deleteProperty(globalThis, "Notification");
  assert.deepEqual(resolveNotificationChannel(), { kind: "unsupported", reason: "no-notification-api" });

  browserWithPush(); define(window, "isSecureContext", false);
  assert.deepEqual(resolveNotificationChannel(), { kind: "unsupported", reason: "insecure-context" });

  browserWithPush(); Reflect.deleteProperty(navigator, "serviceWorker");
  assert.deepEqual(resolveNotificationChannel(), { kind: "unsupported", reason: "no-service-worker" });

  browserWithPush(); Reflect.deleteProperty(window, "PushManager");
  assert.deepEqual(resolveNotificationChannel(), { kind: "unsupported", reason: "no-push-manager" });
});
