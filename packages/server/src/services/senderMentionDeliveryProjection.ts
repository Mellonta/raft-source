import type { MentionDeliveryLookupResult } from "./mentionDeliveryOccurrenceService";
import type {
  MentionDeliveryTerminalErrorCode,
  SenderMentionDeliveryOutcome,
  SenderMentionDeliveryReasonCategory,
} from "@botiverse/raft-shared";

/**
 * `MentionDeliveryTerminalErrorCode` has a single source: the 7-member
 * `MENTION_DELIVERY_TERMINAL_ERROR_CODES` in packages/shared/src/index.ts,
 * unified by task #154 (PR #7921). The table below is keyed on it, so a code
 * added there and left uncategorised here fails the build.
 */

/**
 * task #153 — what the AUTHOR of a message may learn about each target they
 * mentioned.
 *
 * Why this exists: the fact was already there. A mention lost to the target's
 * quota limit is recorded as `terminalErrorCode = QUOTA_LIMITED`, is durable,
 * and is excluded from every redrive — but it is readable only by the RECEIVER
 * (`routes/internalAgentApi.ts`, the `/mentions/:messageId/delivery` comment)
 * and has no CLI surface at all. So the machine knew a mention was permanently
 * lost, and everyone who knew was someone other than the sender. This card
 * routes that existing fact; it does not invent a signal.
 *
 * Scope sentence — required by the ruling, and repeated in the card:
 *   this answers "the seat could not act". It does NOT answer "the mention did
 *   not land". The latter is `not_in_conversation`, which already reports to the
 *   sender at send time AND leaves a recoverable `mention pending` row, and is
 *   deliberately NOT represented here. Two mechanisms reporting one fact would
 *   eventually disagree, and nobody would know which to believe.
 *
 * Deliberately excluded, though it looks similar: a mention DELIVERED to a
 * non-member who then cannot reply where it landed (receipt says `queued`).
 * That is AR task #17, ruled by @Box — not this card.
 *
 * What may cross the boundary (ruled A by @Tenny `4a6a06b8`; @xxchan did not
 * answer and @Box's declared fallback applied): the outcome, and a category
 * coarse enough to be actionable. The sender's only decision is "keep waiting"
 * vs "re-route", and the category is exactly what settles it. Nothing that
 * explains why the seat broke — no raw code, no reset time, no model or
 * provider — because that is the target's private operational state and the
 * sender cannot act on it.
 */

// Imported, NOT restated: one hand-copied closed set is how the duplicate
// MentionDeliveryTerminalErrorCode drifted in the first place (task #154).
export {
  SENDER_MENTION_DELIVERY_OUTCOMES,
  SENDER_MENTION_DELIVERY_REASON_CATEGORIES,
  type SenderMentionDeliveryOutcome,
  type SenderMentionDeliveryReasonCategory,
} from "@botiverse/raft-shared";

/**
 * Closed by ruling. `unclassified` exists because the terminal-code enum is
 * wider than the three seat-availability causes: `IDENTITY_UNKNOWN`,
 * `IDENTITY_DRIFT` and `UNSUPPORTED_DELIVERY_PATH` are all reachable and none of
 * them is "the seat could not act".
 *
 * It is a NAMED member rather than an absent field on purpose (@Tenny): a
 * missing field and a forgotten assignment produce the same reading and mean
 * opposite things, so `lost` always carries a category.
 */

export interface SenderMentionDeliveryRow {
  targetHandle: string;
  outcome: SenderMentionDeliveryOutcome;
  /** Present exactly when `outcome === "lost"`. Never absent in that case. */
  reasonCategory?: SenderMentionDeliveryReasonCategory;
}

/**
 * THE PROPERTY (standing acceptance, ruled by @Stone `86e2504d`):
 *   a terminal code that nobody has categorised must FAIL THE BUILD — and the
 *   check must fail for the deletion a real maintainer would actually make, not
 *   only for the tidiest one.
 *
 * Why this is a total lookup table and not a `switch` with a `default`:
 * @Xinran measured all three shapes on head `32370b952` and the previous shape
 * failed the second half of that property.
 *
 *   A  switch + `never` guard + `default: return "unclassified"`  ⇒ TS2322 ✅ red
 *   B  delete ONLY the guard's two lines, keep the default        ⇒ exit 0 🔴 GREEN
 *   C  delete the whole `default` arm                             ⇒ TS2366 ✅ red
 *
 * B is the minimal edit — the one someone makes when a comment tells them the
 * guard is decorative — and it was the only unprotected shape. The cause is
 * structural: a `default` that returns a LEGAL value makes the declared return
 * type blind to a new member, so the guard was carrying detection alone.
 *
 * The table removes the `default` that was doing the hiding, so the annotation
 * below carries detection on its own. Measured here the same way, so this
 * comment is not another unchecked claim:
 *
 *   A' add a code to the union, no table entry  ⇒ TS2741 naming it     ✅ red
 *   B' delete one table key                     ⇒ TS2741 naming it     ✅ red
 *   C' widen to `Partial<Record<…>>`            ⇒ TS2322 at the lookup ✅ red
 *   D' C' **plus** `?? "unclassified"` at the lookup, key deleted
 *                                               ⇒ tsc exit 0          🔴 GREEN
 *
 * ⚠️ So shape B is NOT gone — D' is it, rebuilt. `??` is a legal-value default
 * wearing different clothes, and it is the natural next edit for someone whom C'
 * has just turned red. I had written here that the widening alone was silent;
 * C' says otherwise, and the honest boundary is that the type tooth holds until
 * a fallback absorbs the `undefined`.
 * ⇒ That is what the runtime tooth is for: T7 in
 * `senderMentionDeliveryProjection.test.ts` compares this table's KEYS against
 * `MENTION_DELIVERY_TERMINAL_ERROR_CODES` — it fails on D' (measured: 1 failed /
 * 13 passed) and needs no `default` to be absent. ⛔ Do not delete it on the
 * grounds that the annotation already covers the codes; it covers A'–C' only.
 */
export const TERMINAL_CODE_CATEGORY: Record<
  MentionDeliveryTerminalErrorCode,
  SenderMentionDeliveryReasonCategory
> = {
  QUOTA_LIMITED: "quota",
  DELIVERY_REJECTED: "runtime_error",
  // Not seat-availability: the target's identity could not be resolved or the
  // path is unsupported. Real, reportable, but none of the three causes — and
  // saying "quota" here would send the sender to wait for a reset that does not
  // exist.
  IDENTITY_UNKNOWN: "unclassified",
  IDENTITY_DRIFT: "unclassified",
  UNSUPPORTED_DELIVERY_PATH: "unclassified",
  // We retried and gave up. Genuinely lost, but it is OUR retry budget that ran
  // out, not one of the three seat-availability causes — calling it
  // `runtime_error` would blame the target for our own bound.
  // If the ruled category set is ever reopened, this is the strongest candidate
  // for a member of its own.
  REDELIVERY_EXHAUSTED: "unclassified",
  // Reachable as a terminal CODE as well as a lookup status. Same argument as
  // the `unknown` outcome: do not dress an instrument failure as a statement
  // about the target. (In practice the caller diverts this code to
  // `outcome: "unknown"` before reaching here; kept total so a future code
  // cannot fall through silently.)
  INSTRUMENT_FAILED: "unclassified",
};

function categoriseTerminalCode(
  code: MentionDeliveryTerminalErrorCode,
): SenderMentionDeliveryReasonCategory {
  return TERMINAL_CODE_CATEGORY[code];
}

export function projectMentionDeliveryForSender(
  targetHandle: string,
  result: MentionDeliveryLookupResult,
): SenderMentionDeliveryRow {
  switch (result.status) {
    case "ACKED":
      return { targetHandle, outcome: "delivered" };
    case "TERMINAL_ERROR": {
      if (result.code === "INSTRUMENT_FAILED") {
        return { targetHandle, outcome: "unknown" };
      }
      return { targetHandle, outcome: "lost", reasonCategory: categoriseTerminalCode(result.code) };
    }
    case "BROKEN_HOP":
      // A hop is missing but nothing is terminal: still in flight. Reporting
      // this as `lost` would tell the sender to stop waiting for a message that
      // may still arrive.
      return { targetHandle, outcome: "pending" };
    case "INSTRUMENT_FAILED":
      return { targetHandle, outcome: "unknown" };
    case "NOT_JOINABLE":
      // Callers must not reach here: a non-author gets the byte-identical
      // non-participant 404 at the route, so this never becomes a row.
      return { targetHandle, outcome: "unknown" };
  }
}
