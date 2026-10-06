import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { closeDatabase, getDb, initDatabase } from "../db/index";
import * as schema from "../db/schema";
import { releaseNotes, releaseNoteDrafts, releaseNoteMutationReceipts, releaseNoteAudit } from "../db/schema";
import { runIdempotent } from "../services/releaseNotesMutation";

// Real-PostgreSQL proof for the idempotency claim ordering (task247 review):
// PGlite's single connection cannot demonstrate cross-backend lock blocking,
// so the barrier and true-concurrency teeth live here against real PG.

const REAL_PG_URL_ENV = "RELEASE_NOTES_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.RELEASE_NOTES_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

function databaseUrlFor(adminUrl: string, databaseName: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?(:|$)/);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z0-9_]+$/);
  return `"${identifier}"`;
}

function lockArgs(principalType: 'human' | 'agent', actorId: string, clientId: string, key: string): [number, number] {
  const digest = createHash("sha256").update(`${principalType}:${actorId}:${clientId}:${key}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

async function waitForLockWaiter(observer: pg.Client, minimumCount = 1, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await observer.query("SELECT pg_stat_clear_snapshot()");
    const result = await observer.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
    `);
    if ((result.rows[0]?.count ?? 0) >= minimumCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${minimumCount} backends did not reach a lock wait: deterministic race was not exercised`);
}

type Mutation = {expectedGeneration: number; expectedRevision: number; idempotencyKey: string; reason: string};
const mut = (key: string, digestSeed: string): Mutation => ({expectedGeneration: 1, expectedRevision: 0, idempotencyKey: key, reason: digestSeed});

test(
  "real PostgreSQL idempotency: barrier blocks before any business write; same key replays; different body conflicts",
  { skip: !(REAL_PG_URL || REAL_PG_REQUIRED) },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_rn_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "rn-realpg-admin" });
    let setupPool: pg.Pool | null = null;
    let blocker: pg.Client | null = null;
    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      setupPool = new pg.Pool({ connectionString: testUrl, application_name: "rn-realpg-setup", max: 2 });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await setupPool.end();
      setupPool = null;
      await initDatabase(testUrl);
      const db = getDb();

      const actor = {principalId: randomUUID(), principalType: 'human' as const, clientId: randomUUID()};
      const key = `barrier-${randomUUID().slice(0, 8)}`;
      const [lockA, lockB] = lockArgs(actor.principalType, actor.principalId, actor.clientId, key);

      blocker = new pg.Client({ connectionString: testUrl, application_name: "rn-realpg-blocker" });
      await blocker.connect();
      await blocker.query("SELECT pg_advisory_lock($1, $2)", [lockA, lockB]);

      const createVia = async (seed: string) => {
        const releaseId = randomUUID();
        return runIdempotent(db, actor, mut(key, seed), async tx => {
          await tx.insert(releaseNotes).values({id: releaseId, releaseKey: `rn-${releaseId.slice(0, 8)}`, version: `9.9.${Math.abs(lockA) % 1000000}`, tag: `t-${releaseId.slice(0, 6)}`, date: "2026-09-15"});
          await tx.insert(releaseNoteDrafts).values({releaseId, entries: []});
          await tx.insert(releaseNoteMutationReceipts).values({actorType: actor.principalType, actorId: actor.principalId, clientId: actor.clientId, key, requestDigest: createHash("sha256").update(JSON.stringify(mut(key, seed))).digest("hex"), releaseId, generation: 1, revision: null});
          await tx.insert(releaseNoteAudit).values({releaseId, actorType: actor.principalType, actorId: actor.principalId, clientId: actor.clientId, action: "create", reason: seed, revision: null, entryDeltas: []});
          return {releaseId};
        });
      };

      // The mutation must block on the advisory lock BEFORE any business write.
      const blocked = createVia("same");
      await waitForLockWaiter(blocker);
      const receiptsHeld = await db.select().from(releaseNoteMutationReceipts).where(eq2(key));
      assert.equal(receiptsHeld.length, 0, "no receipt row may exist while the claim is blocked");
      await blocker.query("SELECT pg_advisory_unlock($1, $2)", [lockA, lockB]);
      const first = await blocked;
      assert.equal(first.kind, "ok");

      // Same key, same body: deterministic replay without new business rows.
      const second = await createVia("same");
      assert.equal(second.kind, "replay");
      assert.equal((await db.select().from(releaseNoteMutationReceipts).where(eq2(key))).length, 1);

      // Same key, different body: typed conflict, still no second receipt.
      const third = await createVia("different");
      assert.equal(third.kind, "conflict");
      assert.equal((await db.select().from(releaseNoteMutationReceipts).where(eq2(key))).length, 1);

      await closeDatabase();
    } finally {
      if (blocker) await blocker.end().catch(() => undefined);
      if (setupPool) await setupPool.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  },
);

import { eq } from "drizzle-orm";
const eq2 = (key: string) => eq(releaseNoteMutationReceipts.key, key);
