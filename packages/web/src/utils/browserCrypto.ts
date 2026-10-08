import { randomUuid } from "@botiverse/raft-shared/src/randomUuid";

/** Compatibility for lazy third-party widgets that require the native method. */
export function installBrowserUuidCompatibility(): void {
  const crypto = globalThis.crypto;
  if (!crypto || typeof crypto.randomUUID === "function") return;
  if (typeof crypto.getRandomValues !== "function") return;
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    writable: true,
    value: randomUuid,
  });
}
