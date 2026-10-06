import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { getDb } from '../db/index';
import { releaseNoteMutationReceipts } from '../db/schema';
import { releaseMutation } from './releaseNotesContent';

export type Actor = { principalId: string; principalType: 'human' | 'agent'; clientId: string };
export type Mutation = z.infer<typeof releaseMutation>;
export type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

export type IdempotentOutcome<T> =
  | {kind: 'replay'; releaseId: string; generation: number; revision: number | null}
  | {kind: 'conflict'}
  | {kind: 'ok'; value: T};

function requestDigest(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/**
 * Serializes mutations per (actor, client, idempotency key) with a transaction
 * advisory lock, then re-checks the receipt INSIDE the same transaction. A
 * concurrent duplicate blocks on the lock until the winner commits, so its
 * re-check reliably observes the winner's receipt — same body replays,
 * different body is a typed conflict — and business unique collisions
 * (version/tag/release_key) can never be reached twice for one key. The
 * receipt claim always lands in the same transaction as the business writes,
 * so there is no partial state and no reliance on post-hoc 23505 triage.
 *
 * This is the shared mutation primitive used by the Release App via direct
 * database access (the server no longer exposes admin write HTTP routes).
 */
export async function runIdempotent<T>(
  db: ReturnType<typeof getDb>,
  actor: Actor,
  mutation: Mutation,
  fn: (tx: Tx) => Promise<T>,
): Promise<IdempotentOutcome<T>> {
  const lockText = `${actor.principalType}:${actor.principalId}:${actor.clientId}:${mutation.idempotencyKey}`;
  const digest = createHash('sha256').update(lockText).digest();
  const lockA = digest.readInt32BE(0);
  const lockB = digest.readInt32BE(4);
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(${lockA}, ${lockB})`);
    const [prior] = await tx.select().from(releaseNoteMutationReceipts).where(and(
      eq(releaseNoteMutationReceipts.actorType, actor.principalType),
      eq(releaseNoteMutationReceipts.actorId, actor.principalId),
      eq(releaseNoteMutationReceipts.clientId, actor.clientId),
      eq(releaseNoteMutationReceipts.key, mutation.idempotencyKey))).limit(1);
    if (prior) {
      if (prior.requestDigest === requestDigest(mutation)) {
        return {kind: 'replay', releaseId: prior.releaseId, generation: prior.generation, revision: prior.revision};
      }
      return {kind: 'conflict'};
    }
    return {kind: 'ok', value: await fn(tx)};
  });
}

/**
 * Typed cause discipline: only the three release_notes identity uniques may be
 * reported as release_exists. Any other 23505 (receipts, audit, drafts, or a
 * future table) is an unexpected integrity error and must fail closed through
 * the generic error path, never be relabeled.
 */
const RELEASE_IDENTITY_CONSTRAINTS = new Set([
  'release_notes_release_key_unique',
  'release_notes_version_unique',
  'release_notes_tag_unique',
]);

export function isReleaseIdentityUnique(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {code?: unknown; constraint?: unknown};
  return e.code === '23505' && typeof e.constraint === 'string' && RELEASE_IDENTITY_CONSTRAINTS.has(e.constraint);
}

export type DraftEntry = {entryId: string; ordinal: number; type: string; text: string; emphasis: boolean};

/** Contract §3: audit events carry entry_id delta references (add/remove/change). */
export function diffEntries(prev: DraftEntry[], next: DraftEntry[]): Array<{entryId: string; op: 'add' | 'remove' | 'change'}> {
  const prevMap = new Map(prev.map(e => [e.entryId, e]));
  const nextMap = new Map(next.map(e => [e.entryId, e]));
  const deltas: Array<{entryId: string; op: 'add' | 'remove' | 'change'}> = [];
  for (const e of next) if (!prevMap.has(e.entryId)) deltas.push({entryId: e.entryId, op: 'add'});
  for (const e of prev) {
    if (!nextMap.has(e.entryId)) deltas.push({entryId: e.entryId, op: 'remove'});
    else {
      const n = nextMap.get(e.entryId)!;
      if (n.ordinal !== e.ordinal || n.type !== e.type || n.text !== e.text || n.emphasis !== e.emphasis) deltas.push({entryId: e.entryId, op: 'change'});
    }
  }
  return deltas.sort((a, b) => a.entryId.localeCompare(b.entryId));
}