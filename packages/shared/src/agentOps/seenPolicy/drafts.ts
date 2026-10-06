// Held-send drafts (moved from the CLI's commands/message/_continueDraftState.ts;
// the CLI keeps that module as a synchronous facade over its ledger store).
// One draft per target, kept for LOCAL_DRAFT_TTL_MINUTES, with a rehold
// counter and the seen snapshot (sparse exact seqs) it was held with.

import { agentApiStructuredMentionSchema, type AgentApiStructuredMention } from "../../agentApiMessageContract";
import type { CommandStateStore, MaybePromise } from "./store";
import { normalizeExactSeqs } from "./consumedSeqs";
import { andThen } from "./maybe";

export interface SavedDraft {
  content: string;
  attachmentIds: string[];
  idempotencyKey?: string;
  mentions?: AgentApiStructuredMention[];
  savedAt: number;
  reholdCount: number;
  seenUpToSeq?: number;
  seenExactSeqs?: number[];
}

/**
 * A held draft is kept for this long. `lookupSavedDraft` deletes an older
 * draft on first touch and reports it as `expired`, so callers can tell the user
 * the draft is gone rather than that none was ever saved.
 */
export const LOCAL_DRAFT_TTL_MINUTES = 10;
const DEFAULT_LOCAL_DRAFT_TTL_MS = LOCAL_DRAFT_TTL_MINUTES * 60 * 1000;

export type SavedDraftLookup =
  | { status: "found"; draft: SavedDraft }
  /** The draft was older than the TTL and has just been discarded; `content` is the only remaining copy of its body. */
  | { status: "expired"; savedAt: number; content: string }
  | { status: "missing" };

export function lookupSavedDraft(store: CommandStateStore, target: string, now: () => number): MaybePromise<SavedDraftLookup> {
  return andThen(store.readDraft(target), (draft): MaybePromise<SavedDraftLookup> => {
    if (!draft || typeof draft.content !== "string") return { status: "missing" };
    const attachmentIds = Array.isArray(draft.attachmentIds)
      ? draft.attachmentIds.filter((item): item is string => typeof item === "string")
      : [];
    const mentions: AgentApiStructuredMention[] | undefined = Array.isArray(draft.mentions)
      ? draft.mentions.flatMap((item) => {
        const parsed = agentApiStructuredMentionSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
      : undefined;
    const savedAt = Number.isFinite(draft.savedAt) ? draft.savedAt : now();
    const reholdCount = Number.isFinite(draft.reholdCount) ? draft.reholdCount : 0;
    const seenUpToSeq = Number.isFinite(draft.seenUpToSeq) ? draft.seenUpToSeq : undefined;
    const seenExactSeqs = normalizeExactSeqs(draft.seenExactSeqs);
    const idempotencyKey = typeof draft.idempotencyKey === "string" && draft.idempotencyKey.trim().length > 0
      ? draft.idempotencyKey.trim()
      : undefined;
    if (now() - savedAt > DEFAULT_LOCAL_DRAFT_TTL_MS) {
      const expired: SavedDraftLookup = { status: "expired", savedAt, content: draft.content };
      // Keyed on savedAt: a fresher draft a concurrent send just saved survives.
      // Best-effort: an expired draft left behind is re-reported as expired.
      let deleted: MaybePromise<boolean>;
      try {
        deleted = store.deleteDraftIfSavedAt(target, savedAt);
      } catch {
        return expired;
      }
      return andThen(
        typeof deleted === "boolean" ? deleted : deleted.catch(() => false),
        () => expired,
      );
    }
    return {
      status: "found",
      draft: {
        content: draft.content,
        attachmentIds,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(mentions && mentions.length > 0 ? { mentions } : {}),
        savedAt,
        reholdCount,
        seenUpToSeq,
        ...(seenExactSeqs.length > 0 ? { seenExactSeqs } : {}),
      },
    };
  });
}

export function getSavedDraft(store: CommandStateStore, target: string, now: () => number): MaybePromise<SavedDraft | null> {
  return andThen(lookupSavedDraft(store, target, now), (lookup) => (lookup.status === "found" ? lookup.draft : null));
}

export function setSavedDraft(store: CommandStateStore, target: string, draft: SavedDraft): MaybePromise<void> {
  const seenExactSeqs = normalizeExactSeqs(draft.seenExactSeqs);
  return store.writeDraft(target, {
    content: draft.content,
    attachmentIds: draft.attachmentIds,
    ...(draft.idempotencyKey ? { idempotencyKey: draft.idempotencyKey } : {}),
    ...(draft.mentions && draft.mentions.length > 0 ? { mentions: draft.mentions } : {}),
    savedAt: draft.savedAt,
    reholdCount: draft.reholdCount,
    ...(draft.seenUpToSeq !== undefined ? { seenUpToSeq: draft.seenUpToSeq } : {}),
    ...(seenExactSeqs.length > 0 ? { seenExactSeqs } : {}),
  });
}

export function clearSavedDraft(store: CommandStateStore, target: string): MaybePromise<void> {
  return store.deleteDraft(target);
}

/** Clear the draft only when it still carries this idempotency key (#7646). */
export function clearSavedDraftIfIdempotencyKeyMatches(
  store: CommandStateStore,
  target: string,
  idempotencyKey: string,
): MaybePromise<boolean> {
  return store.deleteDraftIfIdempotencyKeyMatches(target, idempotencyKey);
}
