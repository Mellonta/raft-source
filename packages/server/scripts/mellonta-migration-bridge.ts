import pg from "pg";
import { fileURLToPath } from "node:url";
import { bridgeMellonta113 } from "../src/db/mellontaMigrationBridge";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await client.connect();
  const repaired = await bridgeMellonta113(client, fileURLToPath(new URL("../drizzle", import.meta.url)));
  console.log(`[MELLONTA_MIGRATION_BRIDGE] ${repaired ? "reconciled 1.13 journal" : "not needed"}`);
} catch (error) {
  // Keep credentials and row values out of deployment logs.
  const message = error instanceof Error && error.message.startsWith("MELLONTA_") ? error.message : "MELLONTA_MIGRATION_BRIDGE_FAILED";
  console.error(message);
  process.exitCode = 1;
} finally { await client.end().catch(() => {}); }
