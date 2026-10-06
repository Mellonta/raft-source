// Task #176 — single source for the third-party app event id contract.
//
// The daemon reports served event ids to
// `/internal/agent-api/third-party-events/delivered` (task #175) and the
// server validates them before marking rows delivered. Both sides used to
// keep their own copy of the id pattern and the per-request cap; a drift there
// would make one side reject what the other side sends. Both now import from
// here, and `thirdPartyEventId.test.ts` pins that neither side defines its own.

/** A third-party event id is a UUID; the server stores it lowercase and the
 * daemon lowercases before reporting, so matching is case-insensitive. */
export const THIRD_PARTY_EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-request cap on `eventIds` for the delivered report, shared by the
 * daemon batcher and the server validator. */
export const THIRD_PARTY_EVENT_DELIVERED_REPORT_MAX_IDS = 200;

export function isThirdPartyEventId(value: unknown): value is string {
  return typeof value === "string" && THIRD_PARTY_EVENT_ID_PATTERN.test(value);
}

/** Canonical form used on the wire and in the server's idempotent update. */
export function normalizeThirdPartyEventId(id: string): string {
  return id.toLowerCase();
}
