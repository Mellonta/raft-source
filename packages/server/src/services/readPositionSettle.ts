// Read-position settling for history reads: a read moves the agent's read
// position only past rows old enough that no lower seq is still committing.

/**
 * How old a message must be before a read may move the read position past it
 * (seq order is not commit order). A probabilistic bound, the same kind other
 * watermark reads here use: a transaction that holds a lower seq and commits
 * more than this after the higher row was created (slow query, lock wait) can
 * still be skipped. A visible transaction cannot see which seqs an uncommitted
 * one holds, so a strict "no in-flight lower seq" check is not available here.
 */
export const READ_POSITION_SETTLE_MS = 3_000;

let settleMs = READ_POSITION_SETTLE_MS;

/** The settle window in force (the default outside tests). */
export function readPositionSettleMs(): number {
  return settleMs;
}

/**
 * Test seam. The global server test setup sets 0, so tests that write and
 * read at once still see the read position move; a test about settling sets a
 * window and calls the returned restore in its own finally.
 */
export function setReadPositionSettleMsForTests(ms: number): () => void {
  const previous = settleMs;
  settleMs = ms;
  return () => { settleMs = previous; };
}

/**
 * The highest seq of the page's contiguous settled prefix (oldest first): every
 * row up to it was created before `settledBefore`, so any transaction holding a
 * lower seq has had that long to commit. Null when the oldest row is too new.
 */
export function settledReadThroughSeq(
  messages: ReadonlyArray<{ seq: unknown; createdAt: Date | string }>,
  settledBefore: number,
): number | null {
  let through: number | null = null;
  const bySeq = [...messages]
    .map((message) => ({ seq: Number(message.seq), at: new Date(message.createdAt).getTime() }))
    .filter((row) => Number.isInteger(row.seq) && row.seq > 0)
    .sort((a, b) => a.seq - b.seq);
  for (const row of bySeq) {
    if (!(row.at <= settledBefore)) break;
    through = row.seq;
  }
  return through;
}

export type DeferredReadAdvanceOutcome = "advanced" | "gap_found" | "skipped_newer_read";

export interface DeferredReadAdvance {
  agentId: string;
  channelId: string;
  /** The read position after the immediate (settled-prefix) advance. */
  fromSeq: number;
  /** Every seq this read returned above `fromSeq`; the check compares against exactly these. */
  returnedSeqs: readonly number[];
  /** Seqs that now exist in (fromSeq, toSeq], oldest first. */
  listSeqs: (fromSeq: number, toSeq: number) => Promise<number[]>;
  /** Move the read position to `seq` (forward-only). */
  advance: (seq: number) => Promise<void>;
  record: (outcome: DeferredReadAdvanceOutcome, attrs: { from_seq: number; to_seq: number; gap_seq?: number }) => void;
}

// replica-local: best-effort; lost on restart → falls back to advancing on next read.
const pendingAdvances = new Map<string, { timer: ReturnType<typeof setTimeout>; cancel: () => void }>();

/**
 * After a read left its newest rows unread (too recent to settle), look again
 * once the window has passed: if no seq that this read did not return has
 * appeared in (fromSeq, max returned], move the read position to the max
 * returned; otherwise stop just before the first such seq (a late commit the
 * agent has not seen). One pending check per (agent, conversation): a newer
 * read replaces the older check.
 */
export function scheduleDeferredReadAdvance(input: DeferredReadAdvance): void {
  const returned = [...new Set(input.returnedSeqs)].filter((seq) => seq > input.fromSeq).sort((a, b) => a - b);
  if (returned.length === 0) return;
  const toSeq = returned[returned.length - 1]!;
  const key = `${input.agentId}:${input.channelId}`;
  pendingAdvances.get(key)?.cancel();
  let done = false;
  const run = async () => {
    if (done) return;
    done = true;
    pendingAdvances.delete(key);
    const seen = new Set(returned);
    const present = await input.listSeqs(input.fromSeq, toSeq);
    const gap = present.find((seq) => !seen.has(seq));
    const target = gap === undefined ? toSeq : Math.max(input.fromSeq, ...returned.filter((seq) => seq < gap));
    if (target > input.fromSeq) await input.advance(target);
    input.record(gap === undefined ? "advanced" : "gap_found", {
      from_seq: input.fromSeq,
      to_seq: target,
      ...(gap === undefined ? {} : { gap_seq: gap }),
    });
  };
  const timer = setTimeout(() => { run().catch(() => {}); }, readPositionSettleMs());
  timer.unref?.();
  pendingAdvances.set(key, {
    timer,
    cancel: () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pendingAdvances.delete(key);
      input.record("skipped_newer_read", { from_seq: input.fromSeq, to_seq: toSeq });
    },
  });
}

/** Test seam: how many deferred checks are pending. */
export function pendingDeferredReadAdvanceCount(): number {
  return pendingAdvances.size;
}
