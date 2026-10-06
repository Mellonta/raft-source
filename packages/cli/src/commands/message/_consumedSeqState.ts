// Local record of what this agent has actually consumed per target, used to
// attest freshness on send.
//
// The policy (target canonicalization and aliases, model-context scope,
// recording rules) is shared (`ConsumedSeqLedger`,
// shared/src/agentOps/seenPolicy/consumedSeqs.ts) so every runtime that
// attests freshness applies one policy. This module is the CLI's
// synchronous facade over it, backed by the agent ledger
// (`src/state/commandStateStore.ts` over `src/state/agentLedger.ts`, RFC 072
// R1): a durable per-agent SQLite file under the Raft user-data root. The
// ledger is the source of truth; after every read it also publishes
// `consumed-seqs.json` (`targets[target] = { seq, readOrder }`, at the
// location shared's `CLI_READ_STATE_*` defines) as a read-only view for
// `@botiverse/raft-sdk`'s `readLatestReadThread()`. Losing this state is safe —
// the next send simply falls back to a conservative hold.
import {
  ConsumedSeqLedger,
  canonicalizeConsumedTarget,
  expectSync,
  getParentTargetForThread,
  planHistoryReadRecording,
  recordHistoryRead,
  type ConsumedThreadTarget,
  type HistoryReadRecordInput,
} from "@botiverse/raft-shared/src/agentOps/seenPolicy/index";

import { createCliCommandStateStore } from "../../state/commandStateStore";

export { canonicalizeConsumedTarget, getParentTargetForThread, type ConsumedThreadTarget };

// One ledger per agent for the life of this CLI process, which runs one
// command: its "withheld for context" set is that run's (a getter that
// withholds another context's evidence marks the target; the send path then
// counts its hold as a context switch). The ledger reads `process.env` on
// every call, as this module always has.
const ledgers = new Map<string, ConsumedSeqLedger>();

function ledgerFor(agentId: string): ConsumedSeqLedger {
  let ledger = ledgers.get(agentId);
  if (!ledger) {
    ledger = new ConsumedSeqLedger(createCliCommandStateStore(agentId, process.env));
    ledgers.set(agentId, ledger);
  }
  return ledger;
}

/** Whether this target's local evidence was withheld in this run because it belongs to another model context. */
export function wasConsumedEvidenceWithheldForContext(agentId: string, target: string): boolean {
  return expectSync(ledgerFor(agentId).wasEvidenceWithheldForContext(target));
}

/**
 * Record what one `message read` history window consumed: the shared
 * read-boundary rules (shared/src/agentOps/seenPolicy/historyRead.ts) decide
 * the record; the typed spelling is booked as an alias of the canonical target.
 */
export function recordHistoryReadWindow(agentId: string, input: HistoryReadRecordInput): void {
  const ledger = ledgerFor(agentId);
  expectSync(recordHistoryRead(ledger, planHistoryReadRecording(input)));
}

/** Record that `rawSpelling` resolves to `canonicalTarget` (latest resolution wins). */
export function recordTargetAlias(agentId: string, rawSpelling: string, canonicalTarget: string): void {
  expectSync(ledgerFor(agentId).recordTargetAlias(rawSpelling, canonicalTarget));
}

/** Record a full-body read of one target (high-water `seq`, fresh `readOrder`). */
export function recordConsumedRead(agentId: string, target: string, seq?: number): void {
  expectSync(ledgerFor(agentId).recordConsumedRead(target, seq));
}

/** Record per-target consumed seqs (monotonic max merge), preserving local read order. */
export function recordConsumedSeqs(agentId: string, entries: Record<string, number>): void {
  expectSync(ledgerFor(agentId).recordConsumedSeqs(entries));
}

/** Record sparse full-body observations without fabricating a high-water boundary. */
export function recordConsumedExactSeqs(agentId: string, entries: Record<string, number[]>): void {
  expectSync(ledgerFor(agentId).recordConsumedExactSeqs(entries));
}

/** The max seq this agent has actually consumed for EXACTLY this target. */
export function getConsumedSeq(agentId: string, target: string): number | undefined {
  return expectSync(ledgerFor(agentId).getConsumedSeq(target));
}

/** Exact sparse seqs whose full bodies were rendered for this target. */
export function getConsumedExactSeqs(agentId: string, target: string): number[] {
  return expectSync(ledgerFor(agentId).getConsumedExactSeqs(target));
}

/** The local order in which this exact target was last read, independent of message seq. */
export function getConsumedReadOrder(agentId: string, target: string): number | undefined {
  return expectSync(ledgerFor(agentId).getConsumedReadOrder(target));
}

export function getMostRecentConsumedThreadForParent(
  agentId: string,
  parentTarget: string,
): ConsumedThreadTarget | undefined {
  return expectSync(ledgerFor(agentId).getMostRecentConsumedThreadForParent(parentTarget));
}
