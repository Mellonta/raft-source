/**
 * A module-scoped handle on the app's toast manager.
 *
 * Surfaces that must report a failure but are also rendered without a provider
 * (tests, and the odd non-app mount) cannot call `useToastManager()` — the hook
 * throws outside `<Toast.Provider>`. `LocalizedToastProvider` registers the
 * live manager here once, and everyone else reports through `showToast`, which
 * simply does nothing when no provider is mounted.
 */
type ToastManager = { add: (toast: { title: string; type?: string }) => void };

let manager: ToastManager | null = null;

export function setToastManager(next: ToastManager | null): void {
  manager = next;
}

export function showToast(toast: { title: string; type?: string }): void {
  manager?.add(toast);
}
