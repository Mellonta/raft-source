// SeenFrontier: the per-target record of what the model has actually seen,
// attested on send and claim so the Server's freshness gate does not hold a
// reply in a conversation the agent has already read.
//
// Why this lives on the client: the Server refuses, by design, to use delivery
// or read positions as freshness proof ("Durable legacy read-ish cursors
// cannot prove the model actually saw the messages; delivery ack state is
// volatile inbox state" — internalAgentApi.ts send gate). Only the runtime
// knows what its model saw, so only the runtime can attest it. This is the
// same bookkeeping the CLI keeps in `_consumedSeqState.ts`, with the same
// rules (FH-EXT-001):
//
// 1. Per-target, never merged: seq N in channel A proves nothing about B, even
//    though seqs are server-global. A thread is a different target from its
//    parent.
// 2. A contiguous read (`messages.read` without `around`) may advance the
//    high-water mark, and only to the boundary the Server computed
//    (`model_seen_up_to_seq`); a sparse drain (`inbox.check`) records exact
//    seqs, which prove only those bodies were rendered.
// 3. Monotonic forward: browsing older messages never lowers the mark.
// 4. Passive signals (wake hints, notices, inbox listings) never advance.
// 5. Absent frontier ⇒ omit the attestation ⇒ the Server holds (fail-closed).
//    Losing this state is safe; the next send returns the unread context.
// 6. Model-context scope (RFC 072 §7.10), the same policy as the shared seen
//    ledger (seenPolicy/consumedSeqs.ts, reference semantics in
//    seenPolicy/memoryStore.ts), mirrored here over in-memory state because
//    the frontier is synchronous and snapshot-shaped: with a current context
//    (`setContext(id)`, or a view from `inContext(id)`), bookings carry that
//    context and `attestation` only uses bookings from it; a booking from
//    another context replaces the record instead of merging into it. Without
//    a context (null, the default) every booking is attested, exactly as
//    before contexts existed.

export interface SeenAttestation {
  seenUpToSeq?: number;
  seenExactSeqs: number[];
}

export interface SeenFrontierSnapshot {
  version: 1;
  targets: Record<string, {
    upTo?: number;
    exact?: number[];
    /** The model context `upTo` was booked in; absent when there was none. */
    upToContextId?: string;
    /** The model context `exact` was booked in; absent when there was none. */
    exactContextId?: string;
  }>;
  /** Alternate spellings the Server resolved to a canonical target. */
  aliases: Record<string, string>;
  /** The frontier's current model context (`setContext`), when one is set. */
  contextId?: string;
}

const MAX_EXACT_SEQS = 2_500;

function positiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function contextOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface TargetState {
  upTo?: number;
  upToContext: string | null;
  exact: Set<number>;
  exactContext: string | null;
}

interface FrontierCore {
  targets: Map<string, TargetState>;
  aliases: Map<string, string>;
  context: string | null;
}

export class SeenFrontier {
  private core: FrontierCore = { targets: new Map(), aliases: new Map(), context: null };
  /** Set on a view from `inContext`: the context this view books and attests under. */
  private bound: string | null | undefined = undefined;

  static fromSnapshot(snapshot: SeenFrontierSnapshot | null | undefined): SeenFrontier {
    const frontier = new SeenFrontier();
    frontier.absorb(snapshot);
    return frontier;
  }

  /** The model context this frontier books and attests under; null means no context scoping. */
  get contextId(): string | null {
    return this.bound !== undefined ? this.bound : this.core.context;
  }

  /**
   * Set the current model context (shared by every view of this frontier that
   * is not bound to its own context). Call it when the model's context
   * changes (a new session, a compaction): reads booked under the previous
   * context then no longer attest a send. `null` turns scoping off.
   */
  setContext(contextId: string | null): void {
    this.core.context = contextOrNull(contextId);
  }

  /**
   * A view over the same records that books and attests under `contextId`
   * (for one call made on behalf of that model context), without changing the
   * frontier's current context. `undefined` returns this frontier.
   */
  inContext(contextId: string | null | undefined): SeenFrontier {
    if (contextId === undefined) return this;
    const view = new SeenFrontier();
    view.core = this.core;
    view.bound = contextOrNull(contextId);
    return view;
  }

  /**
   * Merge a snapshot into this frontier: each record is booked under the
   * context it was booked in (same context: monotonic, never lowers a mark).
   * Adopts the snapshot's current context when this frontier has none.
   */
  absorb(snapshot: SeenFrontierSnapshot | null | undefined): void {
    if (!snapshot || snapshot.version !== 1) return;
    for (const [alias, canonical] of Object.entries(snapshot.aliases ?? {})) this.recordAlias(alias, canonical);
    for (const [target, state] of Object.entries(snapshot.targets ?? {})) {
      if (positiveInt(state.upTo)) this.bookUpTo(target, state.upTo, contextOrNull(state.upToContextId));
      if (Array.isArray(state.exact)) this.bookExact(target, state.exact, contextOrNull(state.exactContextId));
    }
    if (this.core.context === null) this.core.context = contextOrNull(snapshot.contextId);
  }

  /** Remember that the Server resolved `requested` to `canonical` (a thread spelling, a `~agent` suffix, …). */
  recordAlias(requested: string, canonical: string): void {
    if (requested && canonical && requested !== canonical) this.core.aliases.set(requested, canonical);
  }

  canonical(target: string): string {
    return this.core.aliases.get(target) ?? target;
  }

  /** Advance the contiguous boundary for a target in the current context; never lowers it within one context. */
  recordUpTo(target: string, seq: number): void {
    this.bookUpTo(target, seq, this.contextId);
  }

  /** Record bodies that were rendered without proving contiguity, in the current context. */
  recordExact(target: string, seqs: readonly number[]): void {
    this.bookExact(target, seqs, this.contextId);
  }

  /**
   * Attest that the model saw the context of an interrupt (`outcome.interrupt`
   * of an `interrupted` send, claim or task write). Call it only after
   * `interrupt.context` actually reached the model (the SDK cannot know that,
   * so it never records this implicitly). Returns false and records nothing
   * when the context was withheld, not fully shown (`contextComplete: false`),
   * or the Server sent no boundary.
   */
  recordHeld(held: { target: string; seenUpToSeq: number | null; withheld: boolean; contextComplete?: boolean }): boolean {
    if (held.withheld || held.contextComplete === false || held.seenUpToSeq === null) return false;
    this.recordUpTo(held.target, held.seenUpToSeq);
    return true;
  }

  /**
   * What to attest on a send or claim to `target`; omits `seenUpToSeq` when
   * nothing contiguous is known. With a current context, only bookings made
   * in that context count.
   */
  attestation(target: string): SeenAttestation {
    const state = this.core.targets.get(this.canonical(target));
    if (!state) return { seenExactSeqs: [] };
    const context = this.contextId;
    const upTo = context === null || state.upToContext === context ? state.upTo : undefined;
    const exact = context === null || state.exactContext === context ? [...state.exact] : [];
    return {
      ...(upTo === undefined ? {} : { seenUpToSeq: upTo }),
      seenExactSeqs: exact.filter((seq) => upTo === undefined || seq > upTo).sort((a, b) => a - b),
    };
  }

  snapshot(): SeenFrontierSnapshot {
    const targets: SeenFrontierSnapshot["targets"] = {};
    for (const [target, state] of this.core.targets) {
      targets[target] = {
        ...(state.upTo === undefined ? {} : { upTo: state.upTo }),
        ...(state.exact.size === 0 ? {} : { exact: [...state.exact].sort((a, b) => a - b) }),
        ...(state.upTo === undefined || state.upToContext === null ? {} : { upToContextId: state.upToContext }),
        ...(state.exact.size === 0 || state.exactContext === null ? {} : { exactContextId: state.exactContext }),
      };
    }
    return {
      version: 1,
      targets,
      aliases: Object.fromEntries(this.core.aliases),
      ...(this.core.context === null ? {} : { contextId: this.core.context }),
    };
  }

  /** A high-water booking (seenPolicy `bookStreamEntries`): another context's record is replaced, not merged. */
  private bookUpTo(target: string, seq: number, context: string | null): void {
    if (!positiveInt(seq)) return;
    const state = this.state(this.canonical(target));
    if (state.exact.size > 0 && state.exactContext !== context) state.exact.clear();
    if (state.upTo === undefined || state.upToContext !== context || seq > state.upTo) state.upTo = seq;
    state.upToContext = context;
    state.exactContext = context;
    for (const exact of state.exact) if (exact <= state.upTo) state.exact.delete(exact);
  }

  /** A sparse booking (seenPolicy `bookExactSeqs`): merges within a context, replaces across; never moves `upTo`. */
  private bookExact(target: string, seqs: readonly number[], context: string | null): void {
    const state = this.state(this.canonical(target));
    if (state.exactContext !== context) {
      state.exact.clear();
      state.exactContext = context;
    }
    const floor = state.upToContext === context ? state.upTo : undefined;
    for (const seq of seqs) {
      if (!positiveInt(seq)) continue;
      if (floor !== undefined && seq <= floor) continue;
      state.exact.add(seq);
    }
    if (state.exact.size > MAX_EXACT_SEQS) {
      const keep = [...state.exact].sort((a, b) => b - a).slice(0, MAX_EXACT_SEQS);
      state.exact.clear();
      for (const seq of keep) state.exact.add(seq);
    }
  }

  private state(target: string): TargetState {
    let state = this.core.targets.get(target);
    if (!state) {
      state = { upToContext: null, exact: new Set(), exactContext: null };
      this.core.targets.set(target, state);
    }
    return state;
  }
}
