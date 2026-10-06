// Ordered singleton migration phases for the deploy path.
//
// The stock PostgreSQL migrator runs every migration it is given in one
// transaction. The deploy runner invokes it once per migration so no migration
// can accidentally extend the lock lifetime of the migrations around it. Each
// phase is a temporary one-entry view of the exact journal: SQL files are copied
// byte-for-byte, and Drizzle still owns SQL execution and journal inserts.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";

const MIN_LOCK_TIMEOUT_MS = 100;
const MAX_LOCK_TIMEOUT_MS = 60_000;

export type MigrationPhase = {
  tags: string[];
  migrations: MigrationMeta[];
};

type JournalEntry = {
  idx: number;
  version?: string;
  when: number;
  tag: string;
  breakpoints?: boolean;
};

type MigrationJournal = {
  version?: string;
  dialect?: string;
  entries: JournalEntry[];
};

export type MigrationPhaseConfig = {
  lockTimeoutMs: number;
  advisoryLockNamespace: number;
  advisoryLockKey: number;
};

const MIGRATION_ADVISORY_NAMESPACE_ENV = "SERVER_MIGRATION_ADVISORY_LOCK_NAMESPACE";
const MIGRATION_ADVISORY_KEY_ENV = "SERVER_MIGRATION_ADVISORY_LOCK_KEY";
const PG_INT32_MIN = -2_147_483_648;
const PG_INT32_MAX = 2_147_483_647;

/**
 * Resolve lock settings supplied by the deploy contract. Phase isolation is a
 * source invariant: every migration is a singleton, so there is no opt-in list
 * that a future release can forget to extend.
 */
export function resolveMigrationPhaseConfig(env: NodeJS.ProcessEnv): MigrationPhaseConfig {
  if (
    env.SERVER_MIGRATION_PHASE_BOUNDARY_TAGS?.trim()
    || env.SERVER_MIGRATION_REQUIRED_PHASE_BOUNDARY_TAGS?.trim()
    || env.SERVER_MIGRATION_LOCK_SCHEMA?.trim()
    || env.SERVER_MIGRATION_LOCK_RELATIONS?.trim()
  ) {
    throw new Error("MIGRATION_PHASE_CONFIG_OBSOLETE");
  }

  const lockRaw = env.SERVER_MIGRATION_EXPECTED_LOCK_TIMEOUT_MS?.trim() ?? "";
  if (!lockRaw || !/^[1-9][0-9]*$/.test(lockRaw)) {
    throw new Error("MIGRATION_LOCK_TIMEOUT_INVALID");
  }
  const lockTimeoutMs = Number(lockRaw);
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < MIN_LOCK_TIMEOUT_MS || lockTimeoutMs > MAX_LOCK_TIMEOUT_MS) {
    throw new Error("MIGRATION_LOCK_TIMEOUT_INVALID");
  }

  const namespaceRaw = env[MIGRATION_ADVISORY_NAMESPACE_ENV]?.trim() ?? "";
  const keyRaw = env[MIGRATION_ADVISORY_KEY_ENV]?.trim() ?? "";
  if (!/^-?[0-9]+$/.test(namespaceRaw) || !/^-?[0-9]+$/.test(keyRaw)) {
    throw new Error("MIGRATION_ADVISORY_LOCK_INVALID");
  }
  const advisoryLockNamespace = Number(namespaceRaw);
  const advisoryLockKey = Number(keyRaw);
  if (
    !Number.isSafeInteger(advisoryLockNamespace)
    || !Number.isSafeInteger(advisoryLockKey)
    || advisoryLockNamespace < PG_INT32_MIN
    || advisoryLockNamespace > PG_INT32_MAX
    || advisoryLockKey < PG_INT32_MIN
    || advisoryLockKey > PG_INT32_MAX
  ) {
    throw new Error("MIGRATION_ADVISORY_LOCK_INVALID");
  }

  return {
    lockTimeoutMs,
    advisoryLockNamespace,
    advisoryLockKey,
  };
}

/**
 * Split an ordered journal into singleton phases. This is deliberately the
 * default rather than an opt-in boundary list: newly-added migrations must not
 * silently fall into the previous migration's transaction.
 */
export function splitMigrationPhases(
  tags: string[],
  migrations: MigrationMeta[],
): MigrationPhase[] {
  if (tags.length !== migrations.length) {
    throw new Error("MIGRATION_MANIFEST_JOURNAL_LENGTH_MISMATCH");
  }
  return tags.map((tag, index) => ({ tags: [tag], migrations: [migrations[index]] }));
}

/**
 * Create a temporary journal view containing exactly one contiguous phase.
 * Drizzle computes hashes from the copied SQL bytes, so journal rows retain
 * the canonical hashes and created_at values from the repository manifest.
 */
export function createMigrationPhaseFolder(
  migrationsFolder: string,
  phase: MigrationPhase,
): string {
  const sourceJournal = JSON.parse(
    readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as MigrationJournal;
  const entries = sourceJournal.entries;
  const start = entries.findIndex((entry) => entry.tag === phase.tags[0]);
  const selected = entries.slice(start, start + phase.tags.length);
  if (
    start < 0
    || selected.length !== phase.tags.length
    || selected.some((entry, index) => entry.tag !== phase.tags[index])
  ) {
    throw new Error("MIGRATION_PHASE_JOURNAL_MISMATCH");
  }

  const phaseFolder = mkdtempSync(path.join(os.tmpdir(), "slock-migration-phase-"));
  try {
    mkdirSync(path.join(phaseFolder, "meta"));
    writeFileSync(
      path.join(phaseFolder, "meta", "_journal.json"),
      JSON.stringify({ ...sourceJournal, entries: selected }),
    );
    for (const tag of phase.tags) {
      copyFileSync(
        path.join(migrationsFolder, `${tag}.sql`),
        path.join(phaseFolder, `${tag}.sql`),
      );
    }
    return phaseFolder;
  } catch (error) {
    rmSync(phaseFolder, { recursive: true, force: true });
    throw error;
  }
}

export type MigrationPhaseDriver = (
  phase: MigrationPhase,
  phaseFolder: string,
) => Promise<void>;

export type MigrationPhasePreflight = (phase: MigrationPhase) => Promise<void>;

export type MigrationLockPreflightQuery = (
  text: string,
  values?: readonly unknown[],
) => Promise<{ rows: readonly Record<string, unknown>[] }>;

/** Acquire the deploy-wide lease without ever waiting indefinitely. A
 * concurrent migration task is a bounded fail-closed outcome; the PostgreSQL
 * session close releases the lease after this run completes. */
export async function acquireMigrationAdvisoryLock(
  query: MigrationLockPreflightQuery,
  namespace: number,
  key: number,
): Promise<void> {
  const result = await query(
    "SELECT pg_try_advisory_lock($1, $2) AS acquired",
    [namespace, key],
  );
  const acquired = result.rows[0]?.acquired === true || result.rows[0]?.acquired === "t";
  if (!acquired) throw new Error("MIGRATION_ADVISORY_LOCK_UNAVAILABLE");
}



/**
 * Apply ordered phases. A failed phase is rolled back by the canonical
 * Drizzle driver; earlier committed phases remain journaled and can be
 * skipped safely on the next invocation.
 */
export async function runMigrationPhases(
  migrationsFolder: string,
  drive: MigrationPhaseDriver,
  beforePhase?: MigrationPhasePreflight,
): Promise<void> {
  const tags = readPhaseJournalTags(migrationsFolder);
  const migrations = readMigrationFiles({ migrationsFolder });
  const phases = splitMigrationPhases(tags, migrations);
  for (const phase of phases) {
    await beforePhase?.(phase);
    const phaseFolder = createMigrationPhaseFolder(migrationsFolder, phase);
    try {
      await drive(phase, phaseFolder);
    } finally {
      rmSync(phaseFolder, { recursive: true, force: true });
    }
  }
}

export function readPhaseJournalTags(migrationsFolder: string): string[] {
  const journal = JSON.parse(
    readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as MigrationJournal;
  return journal.entries.map((entry) => entry.tag);
}
