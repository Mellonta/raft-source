// The CLI's CommandStateStore (shared/src/agentOps/seenPolicy/store.ts): the
// agent ledger (./agentLedger.ts) as the shared seen policy's store. Same database,
// same keys, same env overrides (SLOCK_CLI_STATE_DIR,
// SLOCK_CLI_CONSUMED_SEQ_STATE_DIR, SLOCK_CLI_DRAFT_STATE_DIR, RAFT_HOME,
// SLOCK_HOME) and the same published read record; the env is passed in
// explicitly. Every method answers synchronously, so the CLI's synchronous
// facades (commands/message/_consumedSeqState.ts, _continueDraftState.ts) run
// the shared policy over it unchanged.

import type { CommandStateStore } from "@botiverse/raft-shared/src/agentOps/seenPolicy/index";

import { enabledContextSignal } from "../ax/passiveEngine";
import {
  bookExactSeqs,
  bookStreamEntries,
  bookTargetAlias,
  deleteDraftEntry,
  deleteDraftEntryIfIdempotencyKeyMatches,
  deleteDraftEntryIfSavedAt,
  incrementMetaCounter,
  readAllStreamEntries,
  readDraftEntry,
  readExactSeqsWithContext,
  readStreamEntry,
  resolveCanonicalTarget,
  writeDraftEntry,
  type LedgerDraftEntry,
  type LedgerStreamEntry,
} from "./agentLedger";

/** A CommandStateStore whose every answer is synchronous. */
export interface SyncCommandStateStore extends CommandStateStore {
  currentContextId(): string | null;
  resolveCanonicalTarget(target: string): string;
  bookTargetAlias(spelling: string, canonicalTarget: string): void;
  readStreamEntry(target: string): LedgerStreamEntry | undefined;
  readAllStreamEntries(): Record<string, LedgerStreamEntry>;
  bookStreamEntries(entries: Record<string, number | undefined>, contextId: string | null): void;
  readExactSeqsWithContext(target: string): { seqs: number[]; contextId: string | null };
  bookExactSeqs(entries: Record<string, number[]>, contextId: string | null): void;
  readDraft(target: string): LedgerDraftEntry | undefined;
  writeDraft(target: string, draft: LedgerDraftEntry): void;
  deleteDraft(target: string): void;
  deleteDraftIfSavedAt(target: string, savedAt: number): boolean;
  deleteDraftIfIdempotencyKeyMatches(target: string, idempotencyKey: string): boolean;
  incrementCounter(key: string): void;
}

/**
 * The ledger store of `agentId`. `env` is read on every call (the context
 * signal and the state location), as the ledger functions always have; the
 * CLI passes `process.env`.
 */
export function createCliCommandStateStore(agentId: string, env: NodeJS.ProcessEnv): SyncCommandStateStore {
  return {
    // The daemon context signal, only when passive AX is on for this launch
    // (task #359 gate: otherwise null, today's behaviour).
    currentContextId: () => enabledContextSignal(env)?.contextId ?? null,
    resolveCanonicalTarget: (target) => resolveCanonicalTarget(agentId, target, env),
    bookTargetAlias: (spelling, canonicalTarget) => bookTargetAlias(agentId, spelling, canonicalTarget, env),
    readStreamEntry: (target) => readStreamEntry(agentId, target, env),
    readAllStreamEntries: () => readAllStreamEntries(agentId, env),
    bookStreamEntries: (entries, contextId) => bookStreamEntries(agentId, entries, env, contextId),
    readExactSeqsWithContext: (target) => readExactSeqsWithContext(agentId, target, env),
    bookExactSeqs: (entries, contextId) => bookExactSeqs(agentId, entries, env, contextId),
    readDraft: (target) => readDraftEntry(agentId, target, env),
    writeDraft: (target, draft) => writeDraftEntry(agentId, target, draft, env),
    deleteDraft: (target) => deleteDraftEntry(agentId, target, env),
    deleteDraftIfSavedAt: (target, savedAt) => deleteDraftEntryIfSavedAt(agentId, target, savedAt, env),
    deleteDraftIfIdempotencyKeyMatches: (target, idempotencyKey) =>
      deleteDraftEntryIfIdempotencyKeyMatches(agentId, target, idempotencyKey, env),
    incrementCounter: (key) => incrementMetaCounter(agentId, key, env),
  };
}
