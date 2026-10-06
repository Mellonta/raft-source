/**
 * Real-PostgreSQL check that deleting 0277 and renumbering 0278 is safe against every database
 * shape this change can meet (task #65, required by @Manjusaka in `#proj-release:886bfaca`).
 *
 * Why this exists rather than a source-reading argument: the migration admission path was read
 * carefully by @Eric and the reasoning was correct as far as it went -- preflight reads only the
 * ledger HEAD, and `classifyAdmission` matches on `(hash, folderMillis)`. But one shape here has a
 * ledger with MORE ROWS THAN THE MANIFEST, and that state had never existed before, so nobody had a
 * reason to read the code that handles it. Reading answers "is this rule what I think it is";
 * only running answers "is there a rule I never thought to look for" (@Tenny).
 *
 * The three shapes, and what each is for:
 *
 *   PRODUCTION   ledger ends at 0275; production never ran the deleted 0277. The renumbered
 *                migration must apply, and `execution_authority` must never exist -- that column
 *                never reaching production is the entire point of this change (@artin).
 *   STAGING      ledger contains an ORPHAN row for the deleted 0277 -- a hash that is no longer in
 *                the manifest at all -- so the ledger has one more row than the manifest. This is
 *                the shape that must not produce HEAD_DIVERGED and must not re-run anything.
 *   FRESH        empty ledger; everything applies cleanly and the column never appears.
 *
 * ⓘ The staging shape reproduces the LEDGER state, not the column drift. Real staging also still
 * carries `execution_authority` because nothing will ever drop it there; @artin accepted that drift
 * explicitly, so it is not re-litigated here. What is tested is the thing that could actually break
 * a deploy: an orphan bookkeeping row.
 *
 * Default-skipped. Run it with:
 *
 *   docker run -d --name pg0277 -e POSTGRES_PASSWORD=probe -p 55437:5432 postgres:16-alpine
 *   MIGRATION_0277_RENUMBER_REAL_PG_URL=postgres://postgres:probe@127.0.0.1:55437/postgres \
 *     pnpm --filter @botiverse/raft-server test:migration-0277-renumber
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, mkdirSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readManifest, classifyAdmission } from "./migrationPreflight";

const REAL_PG_URL_ENV = "MIGRATION_0277_RENUMBER_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.MIGRATION_0277_RENUMBER_REAL_PG_REQUIRED === "1";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * The migration this change DELETES. Pinned by content hash rather than looked up, because the file
 * is gone -- that is precisely what makes its bookkeeping row an orphan on staging.
 * `when` from the journal entry that was removed.
 */
const DELETED_0277_HASH = "1f6991e10df381cf9def7b55af9b7ce4c224601eb1853fa7bd40a71583083bd9";
const DELETED_0277_WHEN = 1789523151508;

/** The renumbered migration. Both values are release acceptance criteria, asserted below. */
const RENAMED_TAG = "0277_official_app_auto_install";
const RENAMED_WHEN = 1789550000000;
const RENAMED_SHA256_PREFIX = "9907e29d6c8a79fa";

function journalTags(): Array<{ idx: number; tag: string; when: number }> {
  return JSON.parse(readFileSync(`${MIGRATIONS}/meta/_journal.json`, "utf8")).entries;
}

async function freshDb(admin: string): Promise<string> {
  const name = `renum_${process.pid}_${randomBytes(4).toString("hex")}`;
  const a = new pg.Client({ connectionString: admin });
  a.on("error", () => {});
  await a.connect();
  await a.query(`CREATE DATABASE "${name}"`);
  await a.end();
  return admin.replace(/\/[^/]*$/, `/${name}`);
}

/** Apply this branch's own migrations up to and including `stopTag`. */
async function applyThrough(url: string, stopTag: string): Promise<void> {
  const entries = journalTags();
  const keep: Array<{ tag: string }> = [];
  for (const e of entries) { keep.push(e); if (e.tag === stopTag) break; }
  const tmp = `/tmp/renum-seed-${randomBytes(4).toString("hex")}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(`${tmp}/meta`, { recursive: true });
  for (const e of keep) copyFileSync(`${MIGRATIONS}/${e.tag}.sql`, `${tmp}/${e.tag}.sql`);
  writeFileSync(`${tmp}/meta/_journal.json`, JSON.stringify({ version: "7", dialect: "postgresql", entries: keep }));
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => {});
  await c.connect();
  await migrate(drizzle(c), { migrationsFolder: tmp });
  await c.end();
  rmSync(tmp, { recursive: true, force: true });
}

async function inspect(url: string) {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => {});
  await c.connect();
  const rows = await c.query(`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`);
  const col = await c.query(
    `SELECT count(*)::int n FROM information_schema.columns
      WHERE table_name = 'read_mutations' AND column_name = 'execution_authority'`,
  );
  const checks = await c.query(
    `SELECT count(*)::int n FROM pg_constraint WHERE conname LIKE '%execution_authority%'`,
  );
  await c.end();
  return {
    rows: rows.rows as Array<{ hash: string; created_at: string | number }>,
    executionAuthorityColumns: col.rows[0].n as number,
    executionAuthorityChecks: checks.rows[0].n as number,
  };
}

async function admit(url: string, manifest: ReturnType<typeof readManifest>) {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => {});
  await c.connect();
  let head: { hash: unknown; createdAt: unknown } | null = null;
  try {
    const r = await c.query(
      `SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`,
    );
    head = r.rows[0] ? { hash: r.rows[0].hash, createdAt: r.rows[0].created_at } : null;
  } catch { head = null; }
  const verdict = classifyAdmission(manifest, head, "60000", 60_000);
  let migrateError: string | null = null;
  try { await migrate(drizzle(c), { migrationsFolder: MIGRATIONS }); }
  catch (e) { migrateError = (e as Error).message; }
  await c.end();
  return { verdict, migrateError };
}

test(
  "deleting 0277 and renumbering 0278 is safe on production, staging (orphan row), and fresh databases",
  { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 600_000 },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);

    // --- release acceptance criteria, asserted before any database work ---------------------
    const entries = journalTags();
    const renamed = entries.find((e) => e.tag === RENAMED_TAG);
    assert.ok(renamed, "the renumbered migration must be in the journal");
    assert.equal(renamed.idx, 277, "it must occupy 277");
    assert.equal(renamed.when, RENAMED_WHEN, "its `when` must be preserved, or every applied ledger diverges");
    assert.equal(
      entries.filter((e) => e.tag.startsWith("0277_")).length, 1,
      "exactly one 0277 may exist",
    );
    assert.ok(
      !entries.some((e) => e.tag === "0277_read_mutation_execution_authority"),
      "the deleted migration must be gone from the journal",
    );
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(readFileSync(`${MIGRATIONS}/${RENAMED_TAG}.sql`)).digest("hex");
    assert.equal(
      sha.slice(0, 16), RENAMED_SHA256_PREFIX,
      "the renamed file's BYTES must be unchanged; staging's applied ledger row is keyed on this hash",
    );

    const manifest = readManifest(MIGRATIONS);
    assert.ok(
      !manifest.some((m) => m.hash === DELETED_0277_HASH),
      "sanity: the deleted migration must not be in the manifest, or this test proves nothing",
    );

    // --- shape 1: PRODUCTION (never ran the deleted 0277) ------------------------------------
    {
      const url = await freshDb(REAL_PG_URL);
      await applyThrough(url, "0275_sloppy_manta");
      const before = await inspect(url);
      const { verdict, migrateError } = await admit(url, manifest);
      const after = await inspect(url);
      assert.equal(migrateError, null, "production shape must migrate cleanly");
      assert.equal(verdict.admit, true);
      assert.equal(verdict.code, "BEHIND_MIGRATE");
      assert.ok(after.rows.length > before.rows.length, "the renumbered migration must actually apply");
      assert.equal(after.executionAuthorityColumns, 0, "⭐ execution_authority must NEVER exist in production");
      assert.equal(after.executionAuthorityChecks, 0, "⭐ nor either of its CHECK constraints");
    }

    // --- shape 2: STAGING (ledger carries an ORPHAN row for the deleted 0277) ----------------
    {
      const url = await freshDb(REAL_PG_URL);
      await applyThrough(url, RENAMED_TAG);
      const c = new pg.Client({ connectionString: url });
      c.on("error", () => {});
      await c.connect();
      // The orphan: a hash that is not in the manifest at all. Its `created_at` is older than the
      // head, which is what real staging looks like -- so it is NOT the row preflight reads.
      await c.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
        [DELETED_0277_HASH, DELETED_0277_WHEN],
      );
      await c.end();

      const before = await inspect(url);
      const orphans = before.rows.filter((r) => !manifest.some((m) => m.hash === r.hash));
      assert.equal(orphans.length, 1, "the fixture must really contain an orphan, or this proves nothing");
      assert.equal(
        before.rows.length, manifest.length + 1,
        "⭐ and the ledger must have MORE rows than the manifest -- the state nobody had read the code for",
      );

      const { verdict, migrateError } = await admit(url, manifest);
      const after = await inspect(url);
      assert.equal(migrateError, null, "an orphan bookkeeping row must not break migrate");
      assert.equal(verdict.admit, true, "⭐ an orphan row must NOT be refused admission");
      assert.equal(verdict.code, "AT_TARGET_NOOP", "⭐ specifically: not HEAD_DIVERGED");
      assert.equal(
        after.rows.length, before.rows.length,
        "⭐ and nothing may be re-applied on a database that is already at target",
      );
    }

    // --- shape 3: FRESH ----------------------------------------------------------------------
    {
      const url = await freshDb(REAL_PG_URL);
      const { verdict, migrateError } = await admit(url, manifest);
      const after = await inspect(url);
      assert.equal(migrateError, null, "a fresh database must migrate cleanly");
      assert.equal(verdict.code, "BEHIND_MIGRATE");
      assert.equal(after.rows.length, manifest.length, "every migration applies exactly once");
      assert.equal(after.executionAuthorityColumns, 0, "⭐ a fresh database never sees the column either");
      assert.equal(after.executionAuthorityChecks, 0);
    }
  },
);
