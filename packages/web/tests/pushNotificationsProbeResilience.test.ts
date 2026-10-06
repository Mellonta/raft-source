import assert from "node:assert/strict";
import "./helpers/domSetup";
import api from "../src/api/client";
import { disablePushNotifications, isPushSubscribed, supportsPushNotifications } from "../src/utils/pushNotifications";

// Task #93: Settings → Push notifications sat on "Checking…" forever with the
// enable button disabled. `refreshState` awaited `isPushSubscribed()` with no
// error handling, and `navigator.serviceWorker.getRegistration()` can REJECT:
// deterministically in the Raft Desktop shell, whose app:// origin cannot host
// a service worker (Chromium: "SecurityError: Failed to get a
// ServiceWorkerRegistration: The URL protocol of the current origin
// ('app://raft') is not supported." — reproduced with an Electron probe using
// the production scheme privileges), and in browsers that block site storage.
// The helpers must therefore (a) never let that rejection escape and (b) not
// advertise Web Push inside the desktop shell at all.

const originalNotification = Object.getOwnPropertyDescriptor(globalThis, "Notification");
const originalWindowNotification = Object.getOwnPropertyDescriptor(window, "Notification");
const originalPushManager = Object.getOwnPropertyDescriptor(window, "PushManager");
const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
const originalRaftDesktop = Object.getOwnPropertyDescriptor(window, "raftDesktop");

function restoreProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

let getRegistrationCalls = 0;

beforeEach(() => {
  getRegistrationCalls = 0;
  const notification = { permission: "default" as NotificationPermission, requestPermission: async () => "default" as NotificationPermission };
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: notification });
  Object.defineProperty(window, "Notification", { configurable: true, value: notification });
  Object.defineProperty(window, "PushManager", { configurable: true, value: class PushManager {} });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      // Exactly what the desktop app:// origin does.
      getRegistration: async () => {
        getRegistrationCalls += 1;
        throw new DOMException("Failed to get a ServiceWorkerRegistration: The URL protocol of the current origin ('app://raft') is not supported.", "SecurityError");
      },
      register: async () => {
        throw new TypeError("Failed to register a ServiceWorker: The URL protocol of the current origin ('app://raft') is not supported.");
      },
    },
  });
});

afterEach(() => {
  restoreProperty(globalThis, "Notification", originalNotification);
  restoreProperty(window, "Notification", originalWindowNotification);
  restoreProperty(window, "PushManager", originalPushManager);
  restoreProperty(navigator, "serviceWorker", originalServiceWorker);
  restoreProperty(window, "raftDesktop", originalRaftDesktop);
});

test("a rejecting service-worker registration lookup resolves isPushSubscribed to false instead of throwing", async () => {
  assert.equal(supportsPushNotifications(), true, "the environment looks push-capable, as it does in the desktop shell");
  await assert.doesNotReject(isPushSubscribed());
  assert.equal(await isPushSubscribed(), false);
  assert.ok(getRegistrationCalls >= 1, "the real lookup was attempted");
});

test("a rejecting pushManager.getSubscription() is also contained", async () => {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: async () => ({
        update: async () => {},
        pushManager: { getSubscription: async () => { throw new DOMException("push service error", "AbortError"); } },
      }),
    },
  });
  assert.equal(await isPushSubscribed(), false);
});

test("inside the Raft Desktop shell Web Push is reported unsupported (no probe, no offer)", async () => {
  Object.defineProperty(window, "raftDesktop", { configurable: true, value: { isDesktop: true } });
  assert.equal(supportsPushNotifications(), false);
  assert.equal(await isPushSubscribed(), false);
  assert.equal(getRegistrationCalls, 0, "unsupported short-circuits before touching the service worker API");
});

test("disablePushNotifications reports FAILURE when the registration lookup throws (it did not unsubscribe anything)", async () => {
  const originalDelete = api.delete;
  let deletes = 0;
  api.delete = (async () => { deletes += 1; return { data: {} }; }) as typeof api.delete;
  try {
    assert.equal(await disablePushNotifications(), false, "a failed lookup is not 'nothing to disable'");
    assert.equal(deletes, 0, "the server subscription must not be deleted on a failed lookup");
  } finally {
    api.delete = originalDelete;
  }
});

test("disablePushNotifications still returns true when the lookup confirms there is no registration", async () => {
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => undefined } });
  assert.equal(await disablePushNotifications(), true);
});
