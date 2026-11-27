// Production bootstrap. The upstream manifest selects the SQL for this server version.
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import {
  buildRisingWaveBootstrapStatements, createdRelationName, RISINGWAVE_ARTIFACT_CDC_TABLES,
  RISINGWAVE_SERVING_ARTIFACTS, RISINGWAVE_CDC_TABLES, RISINGWAVE_LOCAL_SOURCE,
  RISINGWAVE_PUBLICATION_TABLES,
} from "../../../scripts/dev/raftdev-risingwave-bootstrap";

const postgres = new pg.Client({ connectionString: process.env.DATABASE_URL });
const rw = new pg.Client({ connectionString: process.env.RISINGWAVE_DATABASE_URL });
// The parallel comparison graph exceeds the single-node actor budget. Only
// bootstrap and verify the graph that serves this release's reads.
const servingRelations = new Set(RISINGWAVE_SERVING_ARTIFACTS.flatMap(({ relations }) => relations));
const tables = [...RISINGWAVE_CDC_TABLES, ...RISINGWAVE_ARTIFACT_CDC_TABLES.filter(({ name }) => servingRelations.has(name))];
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

// In 1.24, two CDC projections gained columns. Their historical rows must be
// snapshotted again from PostgreSQL. Only rebuild relations owned by the
// 1.21.23 ledger that depend on those tables, in reverse dependency order.
// Each DROP uses RESTRICT, so a separately managed dependent stops the upgrade.
const previousProjections = [
  ["idx_rw_followed_threads_v5_lookup", "INDEX", "a95cb32fc990ff94f676976c35214871c708cf84a6e39485bf7a95f5c1517fed"],
  ["rw_followed_threads_v5", "MATERIALIZED VIEW", "99801adddba571a1f82f20d36ffcedcc56920c066e2bbc92512cf192496c1948"],
  ["idx_rw_target_eligible_v1_target", "INDEX", "48195b3e3f72435a0bb2a744135bbb0f0441e5d409da1988c81c3fd715cc9916"],
  ["idx_rw_channels_server_active_type", "INDEX", "03f86b0e4449cecac221eb7c705accbd608a6c32818f5fd5410f862d82b1887e"],
  ["rw_activity_totals_v6", "MATERIALIZED VIEW", "4493e947d167511fe8fe9f5b54861d7463e3925f39a2109829d6f87b42a4a76b"],
  ["idx_rw_inbox_serving_v8_receiver", "INDEX", "c5872a4801a9c965520e3d131d2a4c07295c560fc81deb585f8d68137262e8d1"],
  ["rw_inbox_serving_v8", "MATERIALIZED VIEW", "fbfdcd7d6dc0a5d00e196eeecf16ac47ab2eaefc148975e73948b25506e141dd"],
  ["rw_inbox_items_v12", "MATERIALIZED VIEW", "30d07d0319326167ee6dccd04d720d052c4c8931653ec545381fdad0ad595ff9"],
  ["rw_activity_watermark_v6", "MATERIALIZED VIEW", "eeed5ea9b32dac25a8bcd7193c914ef14c3a6b3d76a4191a60a71de1731bb6f0"],
  ["idx_rw_conversation_unread_v3_receiver", "INDEX", "1d2c6ebf6e0daaaa84a469dcaef3a3aa732c04d91e6ac014c36b9f95f59c4e10"],
  ["rw_conversation_unread_v3", "MATERIALIZED VIEW", "14bd54fd05fd24f35b00903c6b1256312fcd5c72a469d3b69f7880f5ff527917"],
  ["idx_rw_agent_inbox_v6_agent_activity", "INDEX", "fe18ba569d73ac3d9591b43305066e94c621889beb084277351ed26fe2372464"],
  ["rw_agent_inbox_v6", "MATERIALIZED VIEW", "b1711b3abff2670edcd6654890c743ddd158e76a9b2c383d0b731d4684f274e1"],
  ["rw_inbox_items_v11", "MATERIALIZED VIEW", "50515b1d03e1d676fe7d33dc9506ce85d45fc9e0ff4125aa11909a5bc26bddfb"],
  ["rw_inbox_mention_v6", "MATERIALIZED VIEW", "ef29f7b53d258766f24c7fe891381a188a2d99901db8f5dd31faad359d439858"],
  ["rw_inbox_muted_prefix_v2", "MATERIALIZED VIEW", "421481d33cbed74f12cbc183edd7a646a672fe32bf282d4761c7e7b40dcd7cd8"],
  ["rw_inbox_muted_full_v2", "MATERIALIZED VIEW", "7b4f674443c926be298cecaf9df6af7434e681283278dca2c2a87b21ae022427"],
  ["rw_inbox_normal_v5", "MATERIALIZED VIEW", "f8672d3fb681d332708967a4f12147717d9a0a6a5fde01a813fdfcca2c1ffc0b"],
  ["rw_muted_subs_v1", "MATERIALIZED VIEW", "29620ae71f8fa01aaa3e9fd1c0ba9388639be4c7e1fa068fa9b3bd35d9eb9984"],
  ["rw_subs_v2", "MATERIALIZED VIEW", "aa7cd2d65bcc366cd4dd5baf615d569f79392a3f90e78c3bb5123b3c1e92cb32"],
  ["rw_target_eligible_v1", "MATERIALIZED VIEW", "8a65818edd0e03215a19567c667cb9d8e91e2b0bf40f65821739feb84c302689"],
  ["rw_target_latest_v4", "MATERIALIZED VIEW", "78a16e23c789f8a684a93a98ca77e7627ca28e95354c2676595776390c69f5b0"],
  ["rw_message_target_v3", "MATERIALIZED VIEW", "34bfb192873538582d576a9de0ce6a0c387d569121144652837a2f4e0ad449ef"],
  ["rw_thread_parent_v3", "MATERIALIZED VIEW", "517bb74cc782a255ef3329d6fec0a1e43952b6b4a906c1544fde59e3d2808391"],
  ["idx_rw_message_mentions_v2_inbox", "INDEX", "1253af05e4b043eee203ae1b8213b81a13759fd0d9051a1f4e6d362f62e76b44"],
  ["rw_message_mentions_v2", "TABLE", "effb139cec947e0af59bde77c97044ca5dcc84f80fa91b5543f9b229b8e2fe91"],
  ["rw_channels", "TABLE", "0f84b1ce99d7dff78ededa3672e36af5751bff8b8a0de137f3bd8e44454acd94"],
] as const;

async function upgrade121Projections(applied: Map<string, string>, existing: Set<string>) {
  const needsUpgrade = previousProjections.some(([name, kind, digest]) =>
    kind === "TABLE" && applied.get(name) === digest);
  if (!needsUpgrade) return;
  for (const [name, , digest] of previousProjections) {
    if ((applied.has(name) && applied.get(name) !== digest) || (existing.has(name) && !applied.has(name))) {
      throw new Error(`Cannot upgrade unexpected RisingWave definition for ${name}`);
    }
  }
  console.log("Resnapshotting the Raft 1.21.23 read projections for 1.24.");
  for (const [name, kind] of previousProjections) {
    if (!applied.has(name)) continue;
    // Drop first so an interruption leaves the old ledger entry for a retry.
    await rw.query(`DROP ${kind} IF EXISTS ${name} RESTRICT`);
    await postgres.query("DELETE FROM mellonta.risingwave_ddl WHERE name = $1", [name]);
    applied.delete(name);
    existing.delete(name);
  }
}

async function prepareRelations() {
  const artifacts = Object.fromEntries(RISINGWAVE_SERVING_ARTIFACTS.map(({ file }) => [file, readFileSync(file, "utf8")]));
  const statements = buildRisingWaveBootstrapStatements(artifacts, RISINGWAVE_SERVING_ARTIFACTS);
  // Keep a definition fingerprint. Never reuse a materialized view whose SQL changed under the same name.
  await postgres.query("CREATE SCHEMA IF NOT EXISTS mellonta");
  await postgres.query("CREATE TABLE IF NOT EXISTS mellonta.risingwave_ddl (name text PRIMARY KEY, digest text NOT NULL)");
  const applied = new Map<string, string>((await postgres.query("SELECT name, digest FROM mellonta.risingwave_ddl")).rows.map((r) => [r.name, r.digest]));
  const catalog = await rw.query("SELECT name FROM rw_catalog.rw_relations WHERE schema_id = (SELECT id FROM rw_catalog.rw_schemas WHERE name = 'public')");
  const existing = new Set<string>(catalog.rows.map((r) => r.name));
  await upgrade121Projections(applied, existing);
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
