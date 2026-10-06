// Product analytics call surface (RFC-067).
//
// Events and their properties are declared in the shared registry
// (PRODUCT_EVENT_REGISTRY in @botiverse/raft-shared), which server ingest
// also validates against. Add one only with the event-registry owner's
// sign-off, never as a side effect of feature work (RFC-067 §3.2).
//
// Sending: events queue in memory and flush in batches to
// POST /api/product-events/batch for the server they happened in. Before the
// first batch for a server, the tab asks GET /api/product-events/config
// whether this user may send there (their "share usage data" choice and the
// workspace switch); if not, events for that server are dropped here and never
// leave the browser. Nothing is retried: a failed batch is dropped.

import type { ProductEventName, ProductEventProperties } from "@botiverse/raft-shared";
import { assertValidDesktopRuntimeEnvironment, hasDesktopBridge, RUNTIME_API_BASE } from "../desktopRuntimeEnvironment";
import { WEB_APP_VERSION } from "../utils/webAppVersion";
import { getWebTabId } from "../utils/webAuthTrace";

const FLUSH_DELAY_MS = 10_000;
const MAX_BATCH_EVENTS = 100;
const MAX_QUEUED_EVENTS = 500;
const TOKEN_KEY = "slock_access_token";

interface QueuedEvent {
  serverId: string;
  body: {
    uuid: string;
    event: ProductEventName;
    timestamp: string;
    client_session_id: string;
    properties: Record<string, string | number | boolean>;
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let queue: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
// Per server: undefined = not asked yet, a promise while asking, then the answer.
const allowedByServer = new Map<string, boolean | Promise<boolean>>();
let serverIdGetter: () => string | undefined = () => undefined;
let fetchOverride: FetchLike | null = null;

/** Wired by serverStore, so this module does not import the store. */
export function setProductEventServerIdGetter(getter: () => string | undefined): void {
  serverIdGetter = getter;
}

export function trackEvent<E extends ProductEventName>(
  event: E,
  props?: ProductEventProperties<E>,
): void {
  const serverId = serverIdGetter();
  if (!serverId || allowedByServer.get(serverId) === false) return;
  if (queue.length >= MAX_QUEUED_EVENTS) return;
  const properties: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value !== undefined) properties[key] = value as string | number | boolean;
  }
  queue.push({
    serverId,
    body: {
      uuid: crypto.randomUUID(),
      event,
      timestamp: new Date().toISOString(),
      client_session_id: getWebTabId(),
      properties,
    },
  });
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushProductEvents();
  }, FLUSH_DELAY_MS);
}

function getFetch(): FetchLike {
  return fetchOverride ?? ((input, init) => fetch(input, init));
}

function headers(token: string, serverId: string): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Server-Id": serverId };
}

async function askAllowed(serverId: string, token: string): Promise<boolean> {
  try {
    const response = await getFetch()(`${RUNTIME_API_BASE}/product-events/config`, {
      headers: headers(token, serverId),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as { clientEventsAllowed?: unknown };
    return data.clientEventsAllowed === true;
  } catch {
    return false;
  }
}

/**
 * Sends queued events. Never throws and never touches auth state (a 401 is
 * just a dropped batch). `onPageHide` sends only to servers already known to
 * allow events, with keepalive, because the page may be gone before a config
 * request could answer.
 */
export async function flushProductEvents(options: { onPageHide?: boolean } = {}): Promise<void> {
  if (flushing && !options.onPageHide) return;
  const token = globalThis.localStorage?.getItem(TOKEN_KEY) ?? null;
  if (!token) {
    queue = [];
    return;
  }
  flushing = true;
  try {
    assertValidDesktopRuntimeEnvironment();
    const pending = queue;
    queue = [];
    const byServer = new Map<string, QueuedEvent["body"][]>();
    for (const entry of pending) {
      const events = byServer.get(entry.serverId) ?? [];
      events.push(entry.body);
      byServer.set(entry.serverId, events);
    }
    for (const [serverId, events] of byServer) {
      let allowed = allowedByServer.get(serverId);
      if (allowed === undefined && !options.onPageHide) {
        allowed = askAllowed(serverId, token);
        allowedByServer.set(serverId, allowed);
      }
      if ((await allowed) !== true) {
        if (allowed !== undefined) allowedByServer.set(serverId, false);
        continue;
      }
      allowedByServer.set(serverId, true);
      for (let start = 0; start < events.length; start += MAX_BATCH_EVENTS) {
        await getFetch()(`${RUNTIME_API_BASE}/product-events/batch`, {
          method: "POST",
          headers: headers(token, serverId),
          keepalive: options.onPageHide === true,
          body: JSON.stringify({
            source: hasDesktopBridge() ? "desktop" : "web",
            app_version: WEB_APP_VERSION,
            events: events.slice(start, start + MAX_BATCH_EVENTS),
          }),
        }).catch(() => undefined);
      }
    }
  } catch {
    // Failure-isolated: product analytics never breaks the app.
  } finally {
    flushing = false;
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const flushOnHide = () => {
    if (queue.length > 0) void flushProductEvents({ onPageHide: true });
  };
  window.addEventListener("pagehide", flushOnHide);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushOnHide();
  });
}

/** Test-only: reset module state and inject fetch. */
export function resetProductEventsForTest(fetchImpl: FetchLike | null = null): void {
  queue = [];
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  flushing = false;
  allowedByServer.clear();
  fetchOverride = fetchImpl;
}
