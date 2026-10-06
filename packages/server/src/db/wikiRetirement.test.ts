import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

// Execute the actual data migration: an unrelated recurring reminder must
// survive, old fire revisions must become stale, and reruns must not re-audit.
test("Wiki retirement cancels only its maintenance reminders and is idempotent", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE reminders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), server_id uuid DEFAULT gen_random_uuid(),
        owner_agent_id uuid DEFAULT gen_random_uuid(), payload json, status text,
        version integer DEFAULT 3, canceled_at timestamptz, updated_at timestamptz,
        arm_state text DEFAULT 'armed', arm_updated_at timestamptz
      );
      CREATE TABLE reminder_events (
        id uuid PRIMARY KEY, reminder_id uuid, server_id uuid, owner_agent_id uuid,
        actor_type text, event_type text, metadata jsonb
      );
      CREATE TABLE feature_flags (key text PRIMARY KEY, enabled boolean, kill_switch boolean, default_enabled boolean);
      INSERT INTO feature_flags VALUES ('wiki_v0', true, false, true), ('unrelated', true, false, true);
      INSERT INTO reminders (payload, status) VALUES
        ('{"kind":"wiki.incremental_discovery","version":1}', 'scheduled'),
        ('{"kind":"wiki.lint","version":1}', 'fired'),
        ('{"kind":"wiki.lint","version":1}', 'canceled'),
        ('{"kind":"ordinary","version":1}', 'scheduled'),
        ('{"kind":"wiki.lint","version":2}', 'scheduled');
    `);
    const sql = readFileSync(new URL("../../drizzle/0286_retire_wiki.sql", import.meta.url), "utf8");
    await db.exec(sql);
    await db.exec(sql);
    const { rows } = await db.query<{ kind: string; status: string; version: number; arm_state: string }>(
      "SELECT payload->>'kind' AS kind, status, version, arm_state FROM reminders ORDER BY version DESC, kind",
    );
    assert.equal(rows.length, 5);
    assert.equal(rows.filter((row) => row.version === 4 && row.status === "canceled" && row.arm_state === "not_armed").length, 2);
    assert.equal(rows.filter((row) => row.version === 3 && row.status === "scheduled").length, 2);
    assert.deepEqual((await db.query("SELECT actor_type, event_type FROM reminder_events")).rows,
      [{ actor_type: "system", event_type: "canceled" }, { actor_type: "system", event_type: "canceled" }]);
    assert.deepEqual((await db.query("SELECT * FROM feature_flags ORDER BY key")).rows, [
      { key: "unrelated", enabled: true, kill_switch: false, default_enabled: true },
      { key: "wiki_v0", enabled: false, kill_switch: true, default_enabled: false },
    ]);
  } finally {
    await db.close();
  }
});
