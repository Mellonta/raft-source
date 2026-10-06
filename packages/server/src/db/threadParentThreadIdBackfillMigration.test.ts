import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// 0292 repairs the 58 prod thread parents that getOrCreateThread left without
// thread_id. It must only fill a NULL thread_id for a listed pair whose live
// thread really points at that parent, and be a no-op everywhere else.
const migrationPath = new URL("../../drizzle/0292_backfill_thread_parent_thread_id.sql", import.meta.url);

test("0292 fills only NULL thread_id on listed live thread parents", async () => {
  const migration = await readFile(migrationPath, "utf8");
  const pairs = [...migration.matchAll(/\('([0-9a-f-]{36})'::uuid, '([0-9a-f-]{36})'::uuid\)/g)].map((m) => ({ thread: m[1]!, parent: m[2]! }));
  assert.equal(pairs.length, 58, "the migration carries exactly the 58 pairs found by the prod scan");
  assert.doesNotMatch(migration.replace(/^\s*--.*$/gm, ""), /\bDELETE\b|\bTRUNCATE\b|\bALTER\b/i);
  assert.match(migration, /t\.created_at >= '2026-09-27T00:00:00Z'/, "the tail starts at the scan cutoff");

  const [repaired, alreadySet, deletedThread, mismatched] = pairs;
  const unlisted = { thread: "00000000-0000-4000-8000-0000000000a1", parent: "00000000-0000-4000-8000-0000000000b1" };
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE messages (id uuid PRIMARY KEY, thread_id text);
      CREATE TABLE channels (id uuid PRIMARY KEY, parent_message_id uuid, type text NOT NULL, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT '2026-07-01T00:00:00Z');
    `);
    const seed = async (thread: string, parent: string, threadId: string | null, opts: { deleted?: boolean; parentOf?: string; createdAt?: string } = {}) => {
      await db.query(`INSERT INTO messages (id, thread_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [parent, threadId]);
      await db.query(`INSERT INTO channels (id, parent_message_id, type, deleted_at, created_at) VALUES ($1, $2, 'thread', $3, $4)`,
        [thread, opts.parentOf ?? parent, opts.deleted ? new Date() : null, opts.createdAt ?? "2026-07-01T00:00:00Z"]);
    };
    await seed(repaired!.thread, repaired!.parent, null);
    await seed(alreadySet!.thread, alreadySet!.parent, "11111111-1111-4111-8111-111111111111");
    await seed(deletedThread!.thread, deletedThread!.parent, null, { deleted: true });
    await seed(mismatched!.thread, mismatched!.parent, null, { parentOf: unlisted.parent });
    await seed(unlisted.thread, unlisted.parent, null);
    // Tail: threads created after the scan cutoff are repaired without being listed.
    const tail = { thread: "00000000-0000-4000-8000-0000000000a2", parent: "00000000-0000-4000-8000-0000000000b2" };
    const tailSet = { thread: "00000000-0000-4000-8000-0000000000a3", parent: "00000000-0000-4000-8000-0000000000b3" };
    const tailDeleted = { thread: "00000000-0000-4000-8000-0000000000a4", parent: "00000000-0000-4000-8000-0000000000b4" };
    await seed(tail.thread, tail.parent, null, { createdAt: "2026-09-28T10:00:00Z" });
    await seed(tailSet.thread, tailSet.parent, "22222222-2222-4222-8222-222222222222", { createdAt: "2026-09-28T10:00:00Z" });
    await seed(tailDeleted.thread, tailDeleted.parent, null, { createdAt: "2026-09-28T10:00:00Z", deleted: true });

    await db.exec(migration);
    const threadIdOf = async (parent: string) =>
      (await db.query<{ thread_id: string | null }>(`SELECT thread_id FROM messages WHERE id = $1`, [parent])).rows[0]?.thread_id;
    assert.equal(await threadIdOf(repaired!.parent), repaired!.thread, "a listed pair with a NULL thread_id is stamped");
    assert.equal(await threadIdOf(alreadySet!.parent), "11111111-1111-4111-8111-111111111111", "an existing thread_id is never overwritten");
    assert.equal(await threadIdOf(deletedThread!.parent), null, "a deleted thread is not stamped");
    assert.equal(await threadIdOf(mismatched!.parent), null, "a thread that does not point at the listed parent is not stamped");
    assert.equal(await threadIdOf(unlisted.parent), null, "unlisted parents from before the cutoff are untouched");
    assert.equal(await threadIdOf(tail.parent), tail.thread, "a live thread created after the cutoff is stamped");
    assert.equal(await threadIdOf(tailSet.parent), "22222222-2222-4222-8222-222222222222", "the tail never overwrites an existing thread_id");
    assert.equal(await threadIdOf(tailDeleted.parent), null, "the tail skips deleted threads");
  } finally {
    await db.close();
  }
});
