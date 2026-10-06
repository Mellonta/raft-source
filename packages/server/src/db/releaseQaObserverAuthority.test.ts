import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

// Execute the shipped provisioning query, not a separately maintained SQL copy.
// Reads private infra scripts that the source-available snapshot does not carry;
// skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(new URL("../../../../RELEASE_SOURCE", import.meta.url));
const carrier = inSourceSnapshot
  ? ""
  : readFileSync(new URL("../../../../infra/aws-server/envs/release-qa/scripts/runtime-env-up.sh", import.meta.url), "utf8");
const authoritySql = carrier.match(/WITH target AS \([\s\S]*?FROM target(?=" \| tr)/)?.[0]
  .replaceAll("${observer_role}", "release_qa_observer");
if (!inSourceSnapshot) assert.ok(authoritySql, "observer authority query must be present in the runtime carrier");

test.skipIf(inSourceSnapshot)("observer audit accepts mixed relation kinds but still detects table and sequence writes", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`
      CREATE ROLE release_qa_observer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      CREATE SCHEMA drizzle;
      CREATE TABLE drizzle.__drizzle_migrations (id integer);
      GRANT USAGE ON SCHEMA drizzle TO release_qa_observer;
      GRANT SELECT ON drizzle.__drizzle_migrations TO release_qa_observer;
      CREATE TABLE public.observer_fixture (id integer);
      CREATE INDEX idx_oauth_client_maintainers_user ON public.observer_fixture(id);
      CREATE SEQUENCE public.observer_sequence;
      CREATE VIEW public.observer_view AS SELECT id FROM public.observer_fixture;
    `);
    const audit = async () => {
      const result = await pg.query<Array<number | string>>(authoritySql!, [], { rowMode: "array" });
      return result.rows[0].map(Number);
    };
    const readonly = [1, 0, 0, 0, 0, 0, 0, 0, 0];
    assert.deepEqual(await audit(), readonly);
    await pg.exec("GRANT INSERT ON public.observer_fixture TO release_qa_observer");
    assert.deepEqual(await audit(), [1, 0, 0, 0, 0, 0, 1, 0, 0]);
    await pg.exec("REVOKE INSERT ON public.observer_fixture FROM release_qa_observer; GRANT USAGE ON SEQUENCE public.observer_sequence TO release_qa_observer");
    assert.deepEqual(await audit(), [1, 0, 0, 0, 0, 0, 0, 1, 0]);
    await pg.exec("REVOKE USAGE ON SEQUENCE public.observer_sequence FROM release_qa_observer");
    assert.deepEqual(await audit(), readonly);
  } finally {
    await pg.close();
  }
});
