// In-memory CommandStateStore: the reference semantics of the store contract
// (store.ts), matching the CLI's SQLite ledger (cli/src/state/agentLedger.ts).
// Used by tests; another store can mirror it over its own storage.

import type { CommandStateDraftEntry, CommandStateStore, CommandStateStreamEntry } from "./store";
import { isTrustedCanonicalTarget, normalizeExactSeqs } from "./consumedSeqs";

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

interface StreamRow {
  seq: number | null;
  readOrder: number | null;
  contextId: string | null;
}

export interface MemoryCommandStateStore extends CommandStateStore {
  /** Change the context subsequent calls report (tests). */
  setContextId(contextId: string | null): void;
  /** Counter values (tests). */
  readonly counters: ReadonlyMap<string, number>;
  /** Raw contents (tests). */
  snapshot(): {
    streams: Record<string, StreamRow>;
    exactSeqs: Record<string, { seqs: number[]; contextId: string | null }>;
    aliases: Record<string, string>;
    drafts: Record<string, CommandStateDraftEntry>;
  };
}

export function createMemoryCommandStateStore(options: { contextId?: string | null } = {}): MemoryCommandStateStore {
  let contextId = options.contextId ?? null;
  let nextReadOrder = 1;
  const streams = new Map<string, StreamRow>();
  const exact = new Map<string, { seqs: number[]; contextId: string | null }>();
  const aliases = new Map<string, string>();
  const drafts = new Map<string, CommandStateDraftEntry>();
  const counters = new Map<string, number>();

  const exactFloor = (target: string, exactContextId: string | null): number => {
    const stream = streams.get(target);
    return stream && stream.contextId === exactContextId ? positiveFiniteNumber(stream.seq) ?? 0 : 0;
  };

  const toEntry = (row: StreamRow): CommandStateStreamEntry | undefined => {
    const seq = positiveFiniteNumber(row.seq);
    const readOrder = positiveFiniteNumber(row.readOrder);
    if (seq === undefined && readOrder === undefined) return undefined;
    return row.contextId === null ? { seq, readOrder } : { seq, readOrder, contextId: row.contextId };
  };

  return {
    setContextId(next) {
      contextId = next;
    },
    counters,
    snapshot() {
      return {
        streams: Object.fromEntries([...streams].map(([k, v]) => [k, { ...v }])),
        exactSeqs: Object.fromEntries([...exact].map(([k, v]) => [k, { seqs: [...v.seqs], contextId: v.contextId }])),
        aliases: Object.fromEntries(aliases),
        drafts: Object.fromEntries(drafts),
      };
    },
    currentContextId: () => contextId,
    resolveCanonicalTarget(target) {
      let current = target;
      const seen = new Set<string>([target]);
      for (;;) {
        const canonical = aliases.get(current);
        if (canonical === undefined || seen.has(canonical) || !isTrustedCanonicalTarget(canonical)) return current;
        current = canonical;
        seen.add(current);
      }
    },
    bookTargetAlias(spelling, canonicalTarget) {
      if (!isTrustedCanonicalTarget(spelling) || !isTrustedCanonicalTarget(canonicalTarget) || spelling === canonicalTarget) return;
      aliases.set(spelling, canonicalTarget);
    },
    readStreamEntry(target) {
      const row = streams.get(target);
      return row ? toEntry(row) : undefined;
    },
    readAllStreamEntries() {
      const entries: Record<string, CommandStateStreamEntry> = {};
      for (const [target, row] of streams) {
        const entry = toEntry(row);
        if (entry) entries[target] = entry;
      }
      return entries;
    },
    bookStreamEntries(entries, bookedContextId) {
      for (const [target, rawSeq] of Object.entries(entries)) {
        if (target.length === 0) continue;
        const existingExact = exact.get(target);
        if (existingExact && existingExact.contextId !== bookedContextId) exact.delete(target);
        const seq = positiveFiniteNumber(rawSeq) ?? null;
        const prior = streams.get(target);
        let nextSeq: number | null;
        if (!prior || prior.contextId !== bookedContextId) nextSeq = seq;
        else if (seq === null) nextSeq = prior.seq;
        else nextSeq = prior.seq === null || seq > prior.seq ? seq : prior.seq;
        streams.set(target, { seq: nextSeq, readOrder: nextReadOrder, contextId: bookedContextId });
        nextReadOrder += 1;
        // A real high-water read retires exact observations it now covers.
        const floor = positiveFiniteNumber(nextSeq) ?? 0;
        const kept = exact.get(target);
        if (kept && floor > 0) {
          const seqs = normalizeExactSeqs(kept.seqs, floor);
          if (seqs.length === 0) exact.delete(target);
          else exact.set(target, { seqs, contextId: kept.contextId });
        }
      }
    },
    readExactSeqsWithContext(target) {
      const row = exact.get(target);
      const rowContextId = row?.contextId ?? null;
      return { seqs: normalizeExactSeqs(row?.seqs ?? [], exactFloor(target, rowContextId)), contextId: rowContextId };
    },
    bookExactSeqs(entries, bookedContextId) {
      for (const [target, rawSeqs] of Object.entries(entries)) {
        const seqs = normalizeExactSeqs(rawSeqs);
        if (target.length === 0 || seqs.length === 0) continue;
        const existing = exact.get(target);
        const sameContext = existing !== undefined && existing.contextId === bookedContextId;
        const merged = normalizeExactSeqs([...(sameContext ? existing.seqs : []), ...seqs], exactFloor(target, bookedContextId));
        if (merged.length > 0) exact.set(target, { seqs: merged, contextId: bookedContextId });
      }
    },
    readDraft(target) {
      const draft = drafts.get(target);
      return draft ? { ...draft } : undefined;
    },
    writeDraft(target, draft) {
      drafts.set(target, { ...draft });
    },
    deleteDraft(target) {
      drafts.delete(target);
    },
    deleteDraftIfSavedAt(target, savedAt) {
      if (drafts.get(target)?.savedAt !== savedAt) return false;
      drafts.delete(target);
      return true;
    },
    deleteDraftIfIdempotencyKeyMatches(target, idempotencyKey) {
      if (drafts.get(target)?.idempotencyKey !== idempotencyKey) return false;
      drafts.delete(target);
      return true;
    },
    incrementCounter(key) {
      counters.set(key, (counters.get(key) ?? 0) + 1);
    },
  };
}
