import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  acquireMigrationAdvisoryLock,
  createMigrationPhaseFolder,
  resolveMigrationPhaseConfig,
  runMigrationPhases,
  splitMigrationPhases,
} from "./migrationPhases";
import { readJournalTags } from "./migrateDeploy";

type Entry = { tag: string; when: number; sql: string };

const LOCK_RELEASE_BOUNDARY_TAG = "0244_ancient_ares";
const LOCK_SENSITIVE_MIGRATION_TAG = "0245_complete_sharon_ventura";
const lockContract = {
  SERVER_MIGRATION_EXPECTED_LOCK_TIMEOUT_MS: "5000",
  SERVER_MIGRATION_ADVISORY_LOCK_NAMESPACE: "1907",
  SERVER_MIGRATION_ADVISORY_LOCK_KEY: "245",
};

function writeMigrations(entries: Entry[]): string {
  const folder = mkdtempSync(path.join(tmpdir(), "migration-phases-"));
  mkdirSync(path.join(folder, "meta"));
  writeFileSync(
    path.join(folder, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: entries.map((entry, idx) => ({
        idx,
        version: "7",
        when: entry.when,
        tag: entry.tag,
        breakpoints: true,
      })),
    }),
  );
  for (const entry of entries) writeFileSync(path.join(folder, `${entry.tag}.sql`), entry.sql);
  return folder;
}

const entries: Entry[] = [
  { tag: "0241_users", when: 241, sql: "ALTER TABLE users ADD COLUMN retired_at text;" },
  { tag: LOCK_RELEASE_BOUNDARY_TAG, when: 244, sql: "CREATE TABLE mention_delivery_occurrences (id integer);" },
  { tag: LOCK_SENSITIVE_MIGRATION_TAG, when: 245, sql: "ALTER TABLE server_members ADD COLUMN sidebar_custom_sections json;" },
  { tag: "0246_after", when: 246, sql: "SELECT 1;" },
];

test("splitMigrationPhases makes every migration a singleton by default", () => {
  const folder = writeMigrations(entries);
  try {
    const migrations = readMigrationFiles({ migrationsFolder: folder });
    const phases = splitMigrationPhases(readJournalTags(folder), migrations);
    assert.deepEqual(phases.map((phase) => phase.tags), [
      ["0241_users"],
      [LOCK_RELEASE_BOUNDARY_TAG],
      [LOCK_SENSITIVE_MIGRATION_TAG],
      ["0246_after"],
    ]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("0290-0296 each receive their own transaction without release-specific config", () => {
  const releaseEntries: Entry[] = [
    {
      tag: "0290_messages_search_gin_fastupdate_off",
      when: 290,
      sql: "ALTER INDEX idx SET (fastupdate = off);",
    },
    {
      tag: "0291_messages_autovacuum_thresholds",
      when: 291,
      sql: "ALTER TABLE messages SET (autovacuum_vacuum_scale_factor = 0.02);",
    },
    { tag: "0292_backfill_thread_parent_thread_id", when: 292, sql: "UPDATE messages SET thread_id = id;" },
    { tag: "0293_messages_channel_thread_parent_index", when: 293, sql: "SELECT 1;" },
    {
      tag: "0294_agent_inbox_push",
      when: 294,
      sql: "CREATE TABLE agent_inbox_push_registrations (id integer);",
    },
    {
      tag: "0295_agent_runtime_provider",
      when: 295,
      sql: "CREATE TABLE agent_runtime_provider_configs (id integer);",
    },
    { tag: "0296_antiproton_hosted_runtime", when: 296, sql: "DROP TABLE agent_runtime_provider_configs;" },
    { tag: "0297_future_unconfigured", when: 297, sql: "SELECT 1;" },
  ];
  const folder = writeMigrations(releaseEntries);
  try {
    const migrations = readMigrationFiles({ migrationsFolder: folder });
    const tags = releaseEntries.map((entry) => entry.tag);
    const phases = splitMigrationPhases(readJournalTags(folder), migrations);
    assert.deepEqual(
      phases.map((phase) => phase.tags),
      tags.map((tag) => [tag]),
      "0295 CREATE+FK must commit before 0296 DROP, and an unlisted future tag must remain isolated",
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("migration advisory lease fails closed when another runner owns it", async () => {
  await acquireMigrationAdvisoryLock(
    async () => ({ rows: [{ acquired: true }] }),
    1907,
    245,
  );
  await assert.rejects(
    acquireMigrationAdvisoryLock(
      async () => ({ rows: [{ acquired: false }] }),
      1907,
      245,
    ),
    /MIGRATION_ADVISORY_LOCK_UNAVAILABLE/,
  );
});

test("phase config resolves bounded timeout and advisory lease settings", () => {
  assert.deepEqual(resolveMigrationPhaseConfig(lockContract), {
    lockTimeoutMs: 5000,
    advisoryLockNamespace: 1907,
    advisoryLockKey: 245,
  });
});

test("phase config rejects malformed or unbounded lock settings", () => {
  const cases: [string, NodeJS.ProcessEnv][] = [
    ["MIGRATION_PHASE_CONFIG_OBSOLETE", { ...lockContract, SERVER_MIGRATION_PHASE_BOUNDARY_TAGS: "0296_antiproton_hosted_runtime" }],
    ["MIGRATION_LOCK_TIMEOUT_INVALID", { ...lockContract, SERVER_MIGRATION_EXPECTED_LOCK_TIMEOUT_MS: "0" }],
    ["MIGRATION_ADVISORY_LOCK_INVALID", { ...lockContract, SERVER_MIGRATION_ADVISORY_LOCK_KEY: "not-an-int" }],
  ];
  for (const [code, env] of cases) assert.throws(() => resolveMigrationPhaseConfig(env), new RegExp(code));
});

test("phase folder preserves canonical SQL bytes and journal timestamps", () => {
  const folder = writeMigrations(entries);
  try {
    const migrations = readMigrationFiles({ migrationsFolder: folder });
    const [phase] = splitMigrationPhases(readJournalTags(folder), migrations);
    const phaseFolder = createMigrationPhaseFolder(folder, phase);
    try {
      assert.equal(readFileSync(path.join(phaseFolder, "0241_users.sql"), "utf8"), entries[0].sql);
      const phaseJournal = JSON.parse(readFileSync(path.join(phaseFolder, "meta", "_journal.json"), "utf8")) as { entries: Entry[] };
      assert.deepEqual(phaseJournal.entries.map((entry) => entry.tag), ["0241_users"]);
      assert.deepEqual(readMigrationFiles({ migrationsFolder: phaseFolder }), migrations.slice(0, 1));
    } finally {
      rmSync(phaseFolder, { recursive: true, force: true });
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("runMigrationPhases drives phases sequentially and cleans temporary folders", async () => {
  const folder = writeMigrations(entries);
  const seen: string[] = [];
  try {
    await runMigrationPhases(
      folder,
      async (phase, phaseFolder) => {
        seen.push(phase.tags.join(","));
        assert.equal(existsSync(phaseFolder), true);
        assert.deepEqual(readJournalTags(phaseFolder), phase.tags);
      },
    );
    assert.deepEqual(seen, ["0241_users", LOCK_RELEASE_BOUNDARY_TAG, LOCK_SENSITIVE_MIGRATION_TAG, "0246_after"]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(path.join(repoRoot, "RELEASE_SOURCE"));
