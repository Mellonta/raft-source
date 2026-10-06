// Held-send drafts. The policy (one draft per target, TTL, rehold counter,
// seen snapshot with sparse exact seqs) is shared
// (shared/src/agentOps/seenPolicy/drafts.ts); this module is the CLI's
// synchronous facade over it, backed by the agent ledger
// (`src/state/commandStateStore.ts` over `src/state/agentLedger.ts`, RFC 072
// R1). Legacy tmpdir state is imported once on first ledger miss. The ledger's
// atomic keyed delete replaces the old file lock: no cross-process mutex is
// needed to keep compare-and-clear safe.
import {
  clearSavedDraft as clearSharedSavedDraft,
  clearSavedDraftIfIdempotencyKeyMatches as clearSharedSavedDraftIfIdempotencyKeyMatches,
  expectSync,
  LOCAL_DRAFT_TTL_MINUTES,
  lookupSavedDraft as lookupSharedSavedDraft,
  setSavedDraft as setSharedSavedDraft,
  type SavedDraft,
  type SavedDraftLookup,
} from "@botiverse/raft-shared/src/agentOps/seenPolicy/index";

import { createCliCommandStateStore } from "../../state/commandStateStore";

export { LOCAL_DRAFT_TTL_MINUTES, type SavedDraft, type SavedDraftLookup };

const store = (agentId: string) => createCliCommandStateStore(agentId, process.env);

export function getSavedDraft(agentId: string, target: string): SavedDraft | null {
  const lookup = lookupSavedDraft(agentId, target);
  return lookup.status === "found" ? lookup.draft : null;
}

export function lookupSavedDraft(agentId: string, target: string): SavedDraftLookup {
  return expectSync(lookupSharedSavedDraft(store(agentId), target, () => Date.now()));
}

export function setSavedDraft(agentId: string, target: string, draft: SavedDraft): void {
  expectSync(setSharedSavedDraft(store(agentId), target, draft));
}

export function clearSavedDraft(agentId: string, target: string): void {
  expectSync(clearSharedSavedDraft(store(agentId), target));
}

/** Clear the draft only when it still carries this idempotency key (#7646). */
export function clearSavedDraftIfIdempotencyKeyMatches(
  agentId: string,
  target: string,
  idempotencyKey: string,
): boolean {
  return expectSync(clearSharedSavedDraftIfIdempotencyKeyMatches(store(agentId), target, idempotencyKey));
}

/** Clear the draft only when it is still the one saved at `savedAt` (`--discard-draft` without a key). */
export function clearSavedDraftIfSavedAt(agentId: string, target: string, savedAt: number): boolean {
  return expectSync(store(agentId).deleteDraftIfSavedAt(target, savedAt));
}
