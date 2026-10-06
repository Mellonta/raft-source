// End-to-end non-TTY failure tooth for the deploy migration path (review
// requirement on #5713): the FULL `pnpm --filter @botiverse/raft-server
// db:migrate:deploy` invocation — preflight included, stdio piped exactly like
// ECS/CloudWatch (no TTY) — must print the structured [MIGRATION_FAILED] line
// with the real SQLSTATE, failing tag, server message and statement sentinel
// on the FIRST run. Deleting the catch/formatter in migrateDeploy.ts turns
// this RED (the child would exit 1 with no SQLSTATE anywhere in its output,
// which is precisely the disproven drizzle-kit/hanji behavior).
//
// Own gate (B1 precedent: never borrow another seam's semantics):
//   MIGRATE_DEPLOY_REAL_PG_URL      admin DSN of a disposable PostgreSQL
//   MIGRATE_DEPLOY_REAL_PG_REQUIRED "1" in Hosted — missing URL then FAILS, no skip
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const ADMIN_URL = process.env.MIGRATE_DEPLOY_REAL_PG_URL;
const REQUIRED = process.env.MIGRATE_DEPLOY_REAL_PG_REQUIRED === "1";

const SENTINEL = "deploy_e2e_sqlstate_sentinel";

function writeFailingMigrations(): string {
  const folder = mkdtempSync(path.join(tmpdir(), "migrate-deploy-e2e-"));
  mkdirSync(path.join(folder, "meta"), { recursive: true });
  writeFileSync(
    path.join(folder, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [
        { idx: 0, version: "7", when: 1700000000000, tag: "0000_e2e_ok", breakpoints: true },
        { idx: 1, version: "7", when: 1700000000001, tag: "0001_e2e_overflow", breakpoints: true },
      ],
    }),
  );
  writeFileSync(path.join(folder, "0000_e2e_ok.sql"), "CREATE TABLE e2e_fail (x integer);");
  writeFileSync(
    path.join(folder, "0001_e2e_overflow.sql"),
    `INSERT INTO e2e_fail (x) VALUES (2147483648) /* ${SENTINEL} */;`,
  );
  return folder;
}

test("db:migrate:deploy non-TTY first run prints SQLSTATE + tag + statement on failure", async (t) => {
  if (!ADMIN_URL) {
    if (REQUIRED) {
      throw new Error(
        "MIGRATE_DEPLOY_REAL_PG_REQUIRED=1 but MIGRATE_DEPLOY_REAL_PG_URL is missing — this tooth must not silently skip in Hosted",
      );
    }
    t.skip();
    return;
  }

  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const dbName = `migrate_deploy_e2e_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  t.onTestFinished(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  });

  const adminUrl = new URL(ADMIN_URL);
  const targetUrl = new URL(ADMIN_URL);
  targetUrl.pathname = `/${dbName}`;
  // Preflight contract: the migrator DSN delivers statement_timeout via libpq
  // `options=-c` on a direct connection, and the env pins the expected value.
  targetUrl.searchParams.set("options", "-c statement_timeout=60000");
  void adminUrl;

  const serverDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const migrationsFolder = writeFailingMigrations();

  const child = spawnSync("pnpm", ["run", "db:migrate:deploy"], {
    cwd: serverDir,
    encoding: "utf8",
    // Piped stdio = non-TTY by construction, the ECS/CloudWatch shape.
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DATABASE_URL: targetUrl.toString(),
      SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS: "60000",
      MIGRATIONS_FOLDER: migrationsFolder,
    },
    timeout: 180_000,
  });

  const output = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
  assert.notEqual(child.status, 0, `deploy must exit non-zero on failure; output:\n${output}`);
  assert.match(output, /\[MIGRATION_FAILED\]/, `missing structured line; output:\n${output}`);
  assert.match(output, /sqlstate=22003/, `missing SQLSTATE; output:\n${output}`);
  assert.match(output, /migration=0001_e2e_overflow/, `missing failing tag; output:\n${output}`);
  assert.match(output, /out of range/, "missing server message");
  assert.ok(output.includes(SENTINEL), "missing real failing statement");
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(output, /\x1b\[[0-9;]*m/, "output must be ANSI-free");
  assert.ok(!output.includes(String(adminUrl.password ?? "")), "no DSN secret in output");

  // Production rollback semantics, read back directly from the database the
  // full CLI ran against: the batch transaction rolled back completely — the
  // transiently created table is gone and NO partial journal row exists.
  const probe = new pg.Client({ connectionString: targetUrl.toString() });
  await probe.connect();
  try {
    const reg = await probe.query("SELECT to_regclass('e2e_fail') AS r");
    assert.equal(reg.rows[0].r, null, "failed batch table must be rolled back");
    const journal = await probe.query(
      "SELECT count(*)::int AS n FROM \"drizzle\".\"__drizzle_migrations\"",
    ).catch(() => ({ rows: [{ n: 0 }] }));
    assert.equal(journal.rows[0].n, 0, "no partial journal row after failure");
  } finally {
    await probe.end();
  }
});

test("db:migrate:deploy full run applies real repo migrations once, second run no-ops", async (t) => {
  if (!ADMIN_URL) {
    if (REQUIRED) {
      throw new Error(
        "MIGRATE_DEPLOY_REAL_PG_REQUIRED=1 but MIGRATE_DEPLOY_REAL_PG_URL is missing — this tooth must not silently skip in Hosted",
      );
    }
    t.skip();
    return;
  }

  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const dbName = `migrate_deploy_ok_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  t.onTestFinished(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  });

  const targetUrl = new URL(ADMIN_URL);
  targetUrl.pathname = `/${dbName}`;
  targetUrl.searchParams.set("options", "-c statement_timeout=60000");

  const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const env = {
    ...process.env,
    DATABASE_URL: targetUrl.toString(),
    SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS: "60000",
    SERVER_MIGRATION_PHASE_CONTRACT_REQUIRED: "true",
    SERVER_MIGRATION_EXPECTED_LOCK_TIMEOUT_MS: "5000",
    SERVER_MIGRATION_ADVISORY_LOCK_NAMESPACE: "1907",
    SERVER_MIGRATION_ADVISORY_LOCK_KEY: "245",
    // No MIGRATIONS_FOLDER override: the REAL repo journal is the fixture.
  };
  delete (env as Record<string, unknown>).MIGRATIONS_FOLDER;

  const first = spawnSync("pnpm", ["run", "db:migrate:deploy"], {
    cwd: serverDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
    timeout: 420_000,
  });
  const firstOut = `${first.stdout ?? ""}\n${first.stderr ?? ""}`;
  assert.equal(first.status, 0, `first full apply must succeed; output tail:\n${firstOut.slice(-2000)}`);
  assert.match(firstOut, /\[MIGRATION_DEPLOY_OK\]/);

  const probe = new pg.Client({ connectionString: targetUrl.toString() });
  await probe.connect();
  const count1 = await probe.query(
    "SELECT count(*)::int AS n FROM \"drizzle\".\"__drizzle_migrations\"",
  );
  assert.ok(count1.rows[0].n > 0, "first apply must record journal rows");

  const second = spawnSync("pnpm", ["run", "db:migrate:deploy"], {
    cwd: serverDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
    timeout: 180_000,
  });
  const secondOut = `${second.stdout ?? ""}\n${second.stderr ?? ""}`;
  assert.equal(second.status, 0, `second run must no-op cleanly; output tail:\n${secondOut.slice(-2000)}`);
  assert.match(secondOut, /\[MIGRATION_DEPLOY_OK\]/);

  const count2 = await probe.query(
    "SELECT count(*)::int AS n FROM \"drizzle\".\"__drizzle_migrations\"",
  );
  assert.equal(count2.rows[0].n, count1.rows[0].n, "second run must not re-record or re-apply");
  await probe.end();
});
