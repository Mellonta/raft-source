import { browserPrivacyMode } from "@botiverse/raft-shared/src/browserPrivacy";
// Cookie consent on public Server pages (cindyz / Tenny, 2026-10-14). A
// logged-out visitor who accepts gets a random visitor id in localStorage, sent
// with public visit counts (publicVisits.ts) and with a guest join, so return
// visits and visit -> join can be counted. Declining or withdrawing deletes the
// id. The choice and its id last PUBLIC_VISITOR_ID_MAX_AGE_DAYS (13 months);
// after that the banner asks again. The id is personal data: it is never logged
// and never sent anywhere else.
//
// Where the visitor's law does not require asking first (the server says
// `default_on`, cindyz 2026-10-15), the id is on by default ("default") and
// Cookie settings can turn it off. Back in an `ask` region, a default id is
// dropped and the visitor is asked; with Global Privacy Control (the server
// says `default_off`) it is dropped and nothing is asked.

import { useSyncExternalStore } from "react";
import { PUBLIC_VISITOR_ID_MAX_AGE_DAYS } from "@botiverse/raft-shared";
import type { PublicVisitorIdMode } from "@botiverse/raft-shared";

/** What the visitor chose in the banner. */
export type PublicVisitorChoice = "accepted" | "declined";
/** What is in force: a choice, or the id on by default where no ask is required. */
export type PublicVisitorState = PublicVisitorChoice | "default";

interface StoredConsent {
  choice: PublicVisitorState;
  decidedAt: number;
  visitorId?: string;
}

const CONSENT_KEY = "raft_public_visitor_consent";
const MAX_AGE_MS = PUBLIC_VISITOR_ID_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(now: number): StoredConsent | null {
  if (browserPrivacyMode()) return null;
  const raw = storage()?.getItem(CONSENT_KEY);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as StoredConsent;
    const valid = (stored.choice === "accepted" || stored.choice === "declined" || stored.choice === "default")
      && typeof stored.decidedAt === "number"
      && now - stored.decidedAt < MAX_AGE_MS
      && (stored.choice === "declined" || typeof stored.visitorId === "string");
    if (valid) return stored;
  } catch {
    // fall through: unreadable counts as undecided
  }
  // Expired or unreadable: forget it, id included, and ask again.
  storage()?.removeItem(CONSENT_KEY);
  return null;
}

/** What is in force, or null while undecided (or after it expired). */
export function readPublicVisitorConsent(now: number = Date.now()): PublicVisitorState | null {
  return read(now)?.choice ?? null;
}

/** The visitor id, only while it was accepted or is on by default. */
export function publicVisitorId(now: number = Date.now()): string | null {
  const stored = read(now);
  return stored?.choice === "accepted" || stored?.choice === "default" ? stored.visitorId ?? null : null;
}

/**
 * Accept keeps a default id (or creates one); decline (or withdrawing)
 * deletes it.
 */
export function setPublicVisitorConsent(choice: PublicVisitorChoice, now: number = Date.now()): void {
  if (browserPrivacyMode()) return;
  const current = read(now);
  write(choice === "accepted"
    ? { choice, decidedAt: now, visitorId: current?.visitorId ?? crypto.randomUUID() }
    : { choice, decidedAt: now });
}

/**
 * Applies the server's answer for this visitor, before the page's first
 * visit: `default_on` turns the id on for an undecided visitor; `ask` and
 * `default_off` drop an id that was only on by default (`ask` then shows the
 * banner). An explicit choice always stands.
 */
export function applyPublicVisitorIdMode(mode: PublicVisitorIdMode, now: number = Date.now()): void {
  if (browserPrivacyMode()) return;
  const current = read(now);
  if (mode === "default_on" && current === null) {
    write({ choice: "default", decidedAt: now, visitorId: crypto.randomUUID() });
  } else if (mode !== "default_on" && current?.choice === "default") {
    storage()?.removeItem(CONSENT_KEY);
    for (const listener of listeners) listener();
  }
}

function write(stored: StoredConsent): void {
  try {
    // Delete first: if writing the new choice then fails (storage full), a
    // withdrawal must still leave no id behind (John, #9870). The banner then
    // simply asks again.
    storage()?.removeItem(CONSENT_KEY);
    storage()?.setItem(CONSENT_KEY, JSON.stringify(stored));
  } catch {
    // Storage full or blocked: nothing is kept, so nothing is sent.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePublicVisitorConsent(): PublicVisitorState | null {
  return useSyncExternalStore(subscribe, () => readPublicVisitorConsent(), () => null);
}

/** Test-only. */
export function resetPublicVisitorConsentForTest(): void {
  storage()?.removeItem(CONSENT_KEY);
  for (const listener of listeners) listener();
}
