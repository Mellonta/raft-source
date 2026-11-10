// Production bootstrap. The upstream manifest selects the SQL for this server version.
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import {
  buildRisingWaveBootstrapStatements, createdRelationName, RISINGWAVE_ARTIFACT_CDC_TABLES,
  RISINGWAVE_BOOTSTRAP_ARTIFACTS, RISINGWAVE_CDC_TABLES, RISINGWAVE_LOCAL_SOURCE,
  RISINGWAVE_PUBLICATION_TABLES,
} from "../../../scripts/dev/raftdev-risingwave-bootstrap";

const postgres = new pg.Client({ connectionString: process.env.DATABASE_URL });
const rw = new pg.Client({ connectionString: process.env.RISINGWAVE_DATABASE_URL });
const tables = [...RISINGWAVE_CDC_TABLES, ...RISINGWAVE_ARTIFACT_CDC_TABLES];
const publication = "raft_rw_publication";
const slot = "raft_rw_slot";
const source = "raft_pg_cdc";
const pgPassword = new URL(process.env.DATABASE_URL!).password;
const cdcPassword = createHmac("sha256", pgPassword).update("raft-postgres-cdc-v1").digest("hex");

async function preparePublication() {
  const role = await postgres.query("SELECT rolreplication, rolsuper FROM pg_roles WHERE rolname = 'raft_cdc'");
  if (!role.rowCount) {
    await postgres.query(`CREATE ROLE raft_cdc LOGIN REPLICATION PASSWORD '${cdcPassword}'`);
  } else if (!role.rows[0].rolreplication || role.rows[0].rolsuper) {
    throw new Error("Unexpected privileges on the existing raft_cdc role");
  }
  const members = RISINGWAVE_PUBLICATION_TABLES.map((name) => `public.${name}`);
  await postgres.query("GRANT USAGE ON SCHEMA public TO raft_cdc");
  await postgres.query(`GRANT SELECT ON ${members.join(", ")} TO raft_cdc`);
  const existing = await postgres.query("SELECT puballtables FROM pg_publication WHERE pubname = $1", [publication]);
  if (!existing.rowCount) {
    await postgres.query(`CREATE PUBLICATION ${publication} FOR TABLE ${members.join(", ")}`);
    return;
  }
  const rows = await postgres.query("SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = $1", [publication]);
  const existingTables = rows.rows.map(({ schemaname, tablename }) => `${schemaname}.${tablename}`);
  if (existing.rows[0].puballtables || existingTables.some((table) => !members.includes(table))) {
    throw new Error(`Unexpected tables in ${publication}`);
  }
  const missing = members.filter((table) => !existingTables.includes(table));
  if (missing.length) await postgres.query(`ALTER PUBLICATION ${publication} ADD TABLE ${missing.join(", ")}`);
}

async function prepareSource() {
  const sources = await rw.query(
    "SELECT 1 FROM rw_catalog.rw_sources s JOIN rw_catalog.rw_schemas n ON s.schema_id = n.id WHERE n.name = 'public' AND s.name = $1",
    [source],
  );
  const hasSource = Boolean(sources.rowCount);
  const slots = await postgres.query("SELECT database, plugin, wal_status FROM pg_replication_slots WHERE slot_name = $1", [slot]);
  if (hasSource !== Boolean(slots.rowCount)) {
    throw new Error("The persisted RisingWave source and PostgreSQL replication slot disagree. Check the mounted data directories before retrying.");
  }
  if (hasSource) {
    const { database, plugin, wal_status } = slots.rows[0];
    if (database !== "raft" || plugin !== "pgoutput" || wal_status === "lost") throw new Error(`Invalid replication slot ${slot}`);
    return;
  }
  await rw.query(`CREATE SOURCE ${source} WITH (
    connector = 'postgres-cdc', hostname = 'postgres', port = '5432',
    username = 'raft_cdc', password = '${cdcPassword}', database.name = 'raft',
    schema.name = 'public', slot.name = '${slot}', publication.name = '${publication}',
    publication.create.enable = 'false')`);
}

async function prepareRelations() {
  const artifacts = Object.fromEntries(RISINGWAVE_BOOTSTRAP_ARTIFACTS.map(({ file }) => [file, readFileSync(file, "utf8")]));
  const statements = buildRisingWaveBootstrapStatements(artifacts);
  // Keep a definition fingerprint. Never reuse a materialized view whose SQL changed under the same name.
  await postgres.query("CREATE SCHEMA IF NOT EXISTS mellonta");
  await postgres.query("CREATE TABLE IF NOT EXISTS mellonta.risingwave_ddl (name text PRIMARY KEY, digest text NOT NULL)");
  const applied = new Map((await postgres.query("SELECT name, digest FROM mellonta.risingwave_ddl")).rows.map((r) => [r.name, r.digest]));
  const catalog = await rw.query("SELECT name FROM rw_catalog.rw_relations WHERE schema_id = (SELECT id FROM rw_catalog.rw_schemas WHERE name = 'public')");
  const existing = new Set(catalog.rows.map((r) => r.name));
  for (const raw of statements) {
    const sql = raw.replaceAll(RISINGWAVE_LOCAL_SOURCE, source);
    const name = createdRelationName(sql);
    if (!name) {
      await rw.query(sql); // Session settings, including foreground DDL.
      continue;
    }
    const digest = createHash("sha256").update(sql).digest("hex");
    if (applied.has(name) && applied.get(name) !== digest) throw new Error(`Definition changed for ${name}. An explicit RisingWave upgrade is required.`);
    // Record intent first. A retry can finish interrupted DDL, but must never adopt an unrelated object.
    if (!applied.has(name)) {
      if (existing.has(name)) throw new Error(`An unmanaged RisingWave object already exists: ${name}`);
      await postgres.query("INSERT INTO mellonta.risingwave_ddl (name, digest) VALUES ($1, $2)", [name, digest]);
    }
    if (!existing.has(name)) {
      console.log(`Creating ${name}`);
      await rw.query(sql);
    }
  }
}

async function verifySnapshot() {
  // Deployment keeps the API stopped while comparing the initial snapshot.
  const counts = new Map<string, string>();
  for (const { upstream } of tables) {
    counts.set(upstream, (await postgres.query(`SELECT count(*) FROM public.${upstream}`)).rows[0].count);
  }
  let pending: string[] = [];
  for (let attempt = 0; attempt < 60; attempt++) {
    pending = [];
    for (const { name, upstream } of tables) {
      const { rows } = await rw.query(`SELECT count(*) FROM ${name}`);
      if (String(rows[0].count) !== counts.get(upstream)) pending.push(name);
    }
    const { rows } = await postgres.query("SELECT active FROM pg_replication_slots WHERE slot_name = $1", [slot]);
    if (!pending.length && rows[0]?.active) {
      console.log(`Verified all ${tables.length} CDC table counts and active replication.`);
      return;
    }
    await sleep(1000);
  }
  throw new Error(`Replication is inactive or snapshot counts differ: ${pending.join(", ")}`);
}

try {
  await postgres.connect();
  await rw.connect();
  await postgres.query("SELECT pg_advisory_lock(hashtext('mellonta-risingwave-bootstrap'))");
  await preparePublication();
  await prepareSource();
  await prepareRelations();
  await verifySnapshot();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("RisingWave setup failed:", message.replaceAll(cdcPassword, "[redacted]").replaceAll(pgPassword, "[redacted]"));
  process.exitCode = 1;
} finally {
  await Promise.allSettled([rw.end(), postgres.end()]);
}
