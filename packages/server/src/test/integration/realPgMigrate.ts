import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

/**
 * Runs the Drizzle migrator against a real PostgreSQL test database under a database-wide advisory lock.
 *
 * Drizzle's node-postgres migrator takes no lock: it creates the `drizzle` schema and migrations table, reads the last
 * applied migration, then applies the newer ones. Real-PG test files that start together against one empty database
 * (vitest runs files in separate forked processes) would each see nothing applied and race on CREATE SCHEMA / CREATE
 * TABLE. The advisory lock serializes them across processes; a file that waits finds the schema already migrated.
 */
export async function migrateRealPgTestDatabase(pool: pg.Pool, migrationsFolder: string): Promise<void> {
  const lockClient = await pool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock(hashtext('raft.test.real_pg_migrate'))");
    try {
      await migrate(drizzle(pool), { migrationsFolder });
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext('raft.test.real_pg_migrate'))");
    }
  } finally {
    lockClient.release();
  }
}
