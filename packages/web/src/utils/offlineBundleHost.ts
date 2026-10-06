/**
 * How this page was loaded: as an ordinary web page, or from an H5 offline
 * bundle served by a native host (Hands H5 contract, draft).
 *
 * The host injects a frozen object under `window.__RAFT_OFFLINE_BUNDLE__` before
 * page scripts run. It only says which bundle and page session this document
 * belongs to; it is not a credential and grants nothing.
 */
export const OFFLINE_BUNDLE_GLOBAL = "__RAFT_OFFLINE_BUNDLE__";
export const OFFLINE_BUNDLE_PROTOCOL = 1;
export const OFFLINE_BUNDLE_READY_MESSAGE = "raft.offlineBundle.ready";

export type OfflineBundleInvalidReason = "not-an-object" | "unsupported-protocol" | "missing-identity";

export type OfflineBundleHost =
  | { kind: "none" }
  | { kind: "offline"; bundleId: string; pageSessionId: string }
  | { kind: "invalid"; reason: OfflineBundleInvalidReason };

export interface OfflineBundleReadyMessage {
  name: typeof OFFLINE_BUNDLE_READY_MESSAGE;
  payload: { protocol: typeof OFFLINE_BUNDLE_PROTOCOL; bundleId: string; pageSessionId: string };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Absent property: an ordinary page. Present but malformed, or a protocol this
 * build does not speak: a failed offline start. It must never fall back to
 * "ordinary page", or a bad injection would let the page register a worker
 * over the bundle.
 */
export function parseOfflineBundleHost(scope: object | null | undefined): OfflineBundleHost {
  if (!scope || !(OFFLINE_BUNDLE_GLOBAL in scope)) return { kind: "none" };
  const value = (scope as Record<string, unknown>)[OFFLINE_BUNDLE_GLOBAL];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "invalid", reason: "not-an-object" };
  }
  const injected = value as Record<string, unknown>;
  if (injected.protocol !== OFFLINE_BUNDLE_PROTOCOL) return { kind: "invalid", reason: "unsupported-protocol" };
  if (!nonEmptyString(injected.bundleId) || !nonEmptyString(injected.pageSessionId)) {
    return { kind: "invalid", reason: "missing-identity" };
  }
  return { kind: "offline", bundleId: injected.bundleId, pageSessionId: injected.pageSessionId };
}

let latched: OfflineBundleHost | null = null;

/** Read once and kept for the life of the document: the load mode cannot change after scripts start. */
export function getOfflineBundleHost(): OfflineBundleHost {
  if (latched === null) {
    latched = parseOfflineBundleHost(typeof window === "undefined" ? null : window);
  }
  return latched;
}

/** A page loaded from a bundle, or one whose bundle start failed, must not register or update a service worker. */
export function mayUseServiceWorker(host: OfflineBundleHost = getOfflineBundleHost()): boolean {
  return host.kind === "none";
}

/**
 * The message that tells the host this bundle started. Only a valid offline
 * load has one. Sending it is the host bridge adapter's job, and only after the
 * bridge handshake, the entry and the core modules are up; the injected object
 * existing does not mean the bridge is ready.
 */
export function offlineBundleReadyMessage(
  host: OfflineBundleHost = getOfflineBundleHost(),
): OfflineBundleReadyMessage | null {
  if (host.kind !== "offline") return null;
  return {
    name: OFFLINE_BUNDLE_READY_MESSAGE,
    payload: { protocol: OFFLINE_BUNDLE_PROTOCOL, bundleId: host.bundleId, pageSessionId: host.pageSessionId },
  };
}

export class OfflineBundleStartError extends Error {
  constructor(reason: OfflineBundleInvalidReason) {
    super(`Offline bundle start failed: host injection is invalid (${reason})`);
    this.name = "OfflineBundleStartError";
  }
}

/** Throws for a failed offline start so the root error screen shows instead of the app. */
export function assertOfflineBundleStart(host: OfflineBundleHost = getOfflineBundleHost()): void {
  if (host.kind === "invalid") throw new OfflineBundleStartError(host.reason);
}

export function __resetOfflineBundleHostForTests(): void {
  latched = null;
}
