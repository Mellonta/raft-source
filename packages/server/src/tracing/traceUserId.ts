import { inArray } from "drizzle-orm";
import { getDb } from "../db/index";
import { users } from "../db/schema";

// user id -> users.trace_user_id, for the trace export sink (traceUserIdTraceSink.ts),
// which runs synchronously and can't query. Filled for free where a request
// already reads the users row (auth), and in the background on a miss.

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 50_000;

type Entry = { value: string; expiresAt: number };
const cache = new Map<string, Entry>();
const pending = new Set<string>();
let flushScheduled = false;

export type TraceUserIdLoader = (userIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;

async function loadFromDb(userIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const rows = await getDb().select({ id: users.id, traceUserId: users.traceUserId })
    .from(users).where(inArray(users.id, [...userIds]));
  const found = new Map<string, string>();
  for (const row of rows) if (row.traceUserId) found.set(row.id, row.traceUserId);
  return found;
}

let loader: TraceUserIdLoader = loadFromDb;
let now: () => number = Date.now;

/** The cached trace_user_id for a user, or undefined (then a background load is queued). */
export function cachedTraceUserId(userId: string): string | undefined {
  const entry = cache.get(userId);
  if (entry && entry.expiresAt > now()) return entry.value;
  if (entry) cache.delete(userId);
  requestTraceUserId(userId);
  return undefined;
}

export function rememberTraceUserId(userId: string, traceUserId: string | null | undefined): void {
  if (!traceUserId) return;
  if (cache.size >= MAX_ENTRIES && !cache.has(userId)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(userId);
  cache.set(userId, { value: traceUserId, expiresAt: now() + TTL_MS });
}

/** Drop a user's entry, e.g. after rotating trace_user_id on retirement. */
export function forgetTraceUserId(userId: string): void {
  cache.delete(userId);
}

function requestTraceUserId(userId: string): void {
  pending.add(userId);
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(() => { void flushPending(); }, 0).unref?.();
}

async function flushPending(): Promise<void> {
  flushScheduled = false;
  const userIds = [...pending].slice(0, 500);
  for (const id of userIds) pending.delete(id);
  if (pending.size > 0) requestTraceUserId([...pending][0]!);
  if (userIds.length === 0) return;
  try {
    const found = await loader(userIds);
    for (const [id, value] of found) rememberTraceUserId(id, value);
  } catch {
    // Tracing must never fail a request; the next span for these users retries.
  }
}

export const __traceUserIdForTests = {
  setLoader(next: TraceUserIdLoader | null) { loader = next ?? loadFromDb; },
  setNow(next: (() => number) | null) { now = next ?? Date.now; },
  flush: flushPending,
  reset() { cache.clear(); pending.clear(); flushScheduled = false; },
};
