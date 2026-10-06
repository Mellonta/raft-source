import { clearClockInterval, currentTimeMs, setClockInterval } from "@botiverse/raft-shared";

/**
 * Shared ticking "now" for timestamp-derived presence (external agents are
 * online while `now - lastSeenAt < EXTERNAL_AGENT_ONLINE_WINDOW_MS`, otherwise
 * "last active <time ago>"). Nothing is pushed when an agent simply goes
 * quiet, so the UI must re-evaluate on its own.
 *
 * One interval for the whole app, running only while something subscribes.
 * The snapshot is a stored number, so `useSyncExternalStore` consumers
 * re-render only on a tick — and consumers that do not need time (managed
 * agents) pass a constant snapshot and never re-render from it.
 */
export const PRESENCE_CLOCK_TICK_MS = 15_000;

let nowMs = currentTimeMs();
let interval: unknown = null;
const listeners = new Set<() => void>();

function tick(): void {
  nowMs = currentTimeMs();
  for (const listener of [...listeners]) listener();
}

export function subscribePresenceClock(listener: () => void): () => void {
  listeners.add(listener);
  if (interval === null) {
    interval = setClockInterval(tick, PRESENCE_CLOCK_TICK_MS);
    // The clock was idle: bring the snapshot current. React re-checks the
    // snapshot after subscribing, so the first render converges immediately.
    nowMs = currentTimeMs();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && interval !== null) {
      clearClockInterval(interval);
      interval = null;
    }
  };
}

export function getPresenceClockNowMs(): number {
  return nowMs;
}
