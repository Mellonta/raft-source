import { randomUuid } from "@botiverse/raft-shared/src/randomUuid";
import { useCallback, useSyncExternalStore } from "react";
import { currentTimeMs } from "@botiverse/raft-shared";

export type ConversionObservationToken = string & { readonly __conversionObservationToken: unique symbol };
export type ConversionObservationScope = string & { readonly __conversionObservationScope: unique symbol };
export interface ConversionAttemptBaseline {
  id: string;
  status: string;
  progress?: { failedAt?: string; relockedAt?: string };
}
export interface PendingConversionCommand {
  token: ConversionObservationToken;
  kind: "start" | "retry" | "cancel";
  jobId: string | null;
  baseline: ConversionAttemptBaseline | null;
  startedAt: number;
  previousCommandId?: ConversionObservationToken | null;
}
const PREFIX = "raft_conversion_observation:v1:";
const cache = new Map<string, { raw: string | null; value: PendingConversionCommand | null }>();
const memoryOnly = new Set<string>();
const listeners = new Set<() => void>();

export function conversionObservationScope(userId: string | undefined, serverId: string | undefined, channelId: string): ConversionObservationScope | null {
  return userId && serverId ? `${PREFIX}${userId}:${serverId}:${channelId}` as ConversionObservationScope : null;
}
function decode(raw: string | null): PendingConversionCommand | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingConversionCommand>;
    if (typeof value.token !== "string" || !["start", "retry", "cancel"].includes(value.kind ?? "")
      || typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt)
      || (value.kind !== "start" && typeof value.jobId !== "string")) return null;
    return value as PendingConversionCommand;
  } catch { return null; }
}
export function readPendingConversionCommand(scope: ConversionObservationScope | null): PendingConversionCommand | null {
  if (!scope) return null;
  if (memoryOnly.has(scope)) return cache.get(scope)?.value ?? null;
  try {
    const raw = localStorage.getItem(scope);
    if (cache.get(scope)?.raw === raw) return cache.get(scope)!.value;
    const value = decode(raw);
    cache.set(scope, { raw, value });
    return value;
  } catch { return cache.get(scope)?.value ?? null; }
}
function write(scope: ConversionObservationScope, value: PendingConversionCommand | null) {
  const raw = value ? JSON.stringify(value) : null;
  cache.set(scope, { raw, value });
  try {
    if (raw === null) localStorage.removeItem(scope);
    else localStorage.setItem(scope, raw);
    memoryOnly.delete(scope);
  } catch { memoryOnly.add(scope); }
  for (const listener of listeners) listener();
}
export function beginConversionObservation(
  scope: ConversionObservationScope,
  kind: PendingConversionCommand["kind"],
  baseline: ConversionAttemptBaseline | null,
  previousCommandId?: string | null,
): PendingConversionCommand | null {
  const existing = readPendingConversionCommand(scope);
  if (existing && (kind !== "cancel" || existing.kind === "cancel")) return null;
  const value: PendingConversionCommand = {
    token: randomUuid() as ConversionObservationToken,
    kind,
    jobId: baseline?.id ?? null,
    baseline,
    startedAt: currentTimeMs(),
    previousCommandId: previousCommandId == null ? previousCommandId : previousCommandId as ConversionObservationToken,
  };
  write(scope, value);
  return value;
}
/** Cache an authorized server receipt locally only to retain observation
 * ownership while later hydration replaces the server's pending projection. */
export function conversionObservationFromServer(value: {
  id: string; kind: PendingConversionCommand["kind"]; jobId?: string | null; createdAt?: string;
}): PendingConversionCommand {
  return { token: value.id as ConversionObservationToken, kind: value.kind, jobId: value.jobId ?? null,
    baseline: null, previousCommandId: null, startedAt: value.createdAt ? Date.parse(value.createdAt) : 0 };
}
export function retainServerConversionObservation(scope: ConversionObservationScope, value: PendingConversionCommand) {
  if (!readPendingConversionCommand(scope)) write(scope, value);
}

export function clearConversionObservation(scope: ConversionObservationScope | null, token: ConversionObservationToken | null | undefined): void {
  if (scope && token && readPendingConversionCommand(scope)?.token === token) write(scope, null);
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(PREFIX)) listener(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}
export function usePendingConversionCommand(scope: ConversionObservationScope | null) {
  return useSyncExternalStore(subscribe, useCallback(() => readPendingConversionCommand(scope), [scope]), () => null);
}
export function resetConversionObservationsForTests() {
  if (import.meta.env.MODE !== "test") throw new Error("test-only observation reset");
  for (const key of [...cache.keys()]) localStorage.removeItem(key);
  cache.clear(); memoryOnly.clear();
  for (const listener of listeners) listener();
}
