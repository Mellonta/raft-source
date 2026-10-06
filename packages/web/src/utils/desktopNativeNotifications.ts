import { isElectronDesktopShell } from "./desktopShell";

// Raft Desktop notifications go through the renderer's Notification API, which
// Electron maps to OS notifications (see DesktopNativeBridge).
//
// What the app can and cannot know here, honestly: the desktop main process
// grants the Chromium `notifications` permission outright, so
// `Notification.permission` is always "granted" in the shell and says NOTHING
// about the macOS authorization switch (System Settings → Notifications → Raft
// Desktop). Electron exposes no API for that switch. The only truthful check is
// to post a notification and let the user see whether it appears — the first
// one also triggers macOS's own permission prompt. Settings therefore offers a
// test notification plus guidance, not a fabricated enabled/blocked status.
type DesktopBridge = { focusWindow?: () => void };

function desktopBridge(): DesktopBridge | undefined {
  return (window as { raftDesktop?: DesktopBridge }).raftDesktop;
}

export function isDesktopNativeNotificationsAvailable(): boolean {
  return typeof window !== "undefined" && isElectronDesktopShell() && typeof Notification !== "undefined";
}

// Posts a notification that behaves exactly like a real one (click focuses the
// window). Returns false only if the API is missing or throws — it cannot tell
// whether the OS actually displayed it.
export function showDesktopTestNotification(input: { title: string; body: string }): boolean {
  if (!isDesktopNativeNotificationsAvailable()) return false;
  try {
    const notification = new Notification(input.title, { body: input.body });
    notification.onclick = () => desktopBridge()?.focusWindow?.();
    return true;
  } catch (err) {
    console.warn("[DesktopNotifications] Test notification failed:", err);
    return false;
  }
}
