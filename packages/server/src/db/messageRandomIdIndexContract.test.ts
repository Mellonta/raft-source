import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const SERVER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(path.resolve(SERVER_ROOT, "../../RELEASE_SOURCE"));

async function readServerFile(relativePath: string) {
  return readFile(path.join(SERVER_ROOT, relativePath), "utf8");
}

test("0140 keeps the large partial index out of drizzle migrate", async () => {
  const migration = await readServerFile("drizzle/0140_great_blacklash.sql");

  assert.match(
    migration,
    /ALTER TABLE "messages" ADD COLUMN "random_id" text/,
  );
  assert.doesNotMatch(
    migration,
    /CREATE UNIQUE INDEX\s+"idx_messages_user_random_id"/,
  );
});

test.skipIf(inSourceSnapshot)("server package exposes concurrent create and verify scripts", async () => {
  const packageJson = JSON.parse(await readServerFile("package.json"));
  assert.equal(
    packageJson.scripts["db:create-message-random-id-index"],
    "node --import @oxc-node/core/register scripts/create-message-random-id-index.ts",
  );
  assert.equal(
    packageJson.scripts["db:verify-message-random-id-index"],
    "node --import @oxc-node/core/register scripts/verify-message-random-id-index.ts",
  );

  const helperScript = await readServerFile(
    "scripts/message-random-id-index.ts",
  );
  assert.match(
    helperScript,
    /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "\$\{RANDOM_ID_INDEX_NAME\}"/,
  );
  assert.match(helperScript, /MESSAGE_RANDOM_ID_INDEX_STATEMENT_TIMEOUT/);
  assert.match(helperScript, /MESSAGE_RANDOM_ID_INDEX_LOCK_TIMEOUT/);
  assert.match(helperScript, /indisvalid/);
  assert.match(helperScript, /indisready/);

  const createScript = await readServerFile(
    "scripts/create-message-random-id-index.ts",
  );
  assert.match(createScript, /set_config\('statement_timeout'/);
  assert.match(createScript, /set_config\('lock_timeout'/);

  const postSteps = JSON.parse(
    await readFile(
      path.join(
        SERVER_ROOT,
        "../../scripts/deploy/aws-server-post-migration-steps.json",
      ),
      "utf8",
    ),
  );
  // The post-migration list is intentionally EMPTY as of v1.17.2: both the
  // create and verify steps for these indexes were removed because the creates
  // are the same assertion as the verifies once the index exists, and an index
  // that has been created does not disappear. See the deploy step file's own
  // history.
  //
  // What this assertion protects is NOT "these five steps exist" -- it is that
  // IF a step is wired into the deploy list, it must be the correctly
  // configured script. Pinning the exact list broke on an intentional
  // emptying; pinning the wiring rule does not break when the list changes,
  // while still failing if someone adds a step pointing at the wrong script.
  const EXPECTED_STEP_COMMANDS: Record<string, string[]> = {
    "Create message random_id unique index": [
      "pnpm",
      "--filter",
      "@botiverse/raft-server",
      "db:create-message-random-id-index",
    ],
    "Verify message random_id unique index": [
      "pnpm",
      "--filter",
      "@botiverse/raft-server",
      "db:verify-message-random-id-index",
    ],
    "Verify inbox serving receiver/server/activity index": [
      "pnpm",
      "--filter",
      "@botiverse/raft-server",
      "db:verify-inbox-serving-rows-receiver-server-index",
    ],
    "Create messages sender/created_at index": [
      "pnpm",
      "--filter",
      "@botiverse/raft-server",
      "db:create-messages-sender-index",
    ],
    "Verify messages sender/created_at index": [
      "pnpm",
      "--filter",
      "@botiverse/raft-server",
      "db:verify-messages-sender-index",
    ],
  };
  assert.ok(Array.isArray(postSteps), "post-migration steps must be an array");
  // The list is intentionally EMPTY as of v1.17.2. That intent must be ASSERTED,
  // not just commented: with an empty list the loop below never runs, so without
  // this line the only thing standing is "it is an array" -- and an ACCIDENTAL
  // emptying would pass. This is the one assertion that must be deliberately
  // edited to change the list's length, which is exactly the review moment we
  // want when someone adds a step back. (Raised by @Tenny.)
  assert.equal(
    postSteps.length,
    0,
    "the post-migration list is intentionally empty since v1.17.2; if you are adding a step, register its command in EXPECTED_STEP_COMMANDS and change this number deliberately",
  );
  for (const step of postSteps) {
    const expected = EXPECTED_STEP_COMMANDS[step.name];
    assert.ok(
      expected,
      `post-migration step "${step.name}" is not a known index step; add it here with its exact command before wiring it into the deploy list`,
    );
    assert.deepEqual(
      step.command,
      expected,
      `post-migration step "${step.name}" must run the canonical command`,
    );
  }
});

test("PGlite keeps random_id replay semantics for local and test DBs", async () => {
  const pgliteMigrations = await readServerFile("src/db/pgliteMigrations.ts");

  assert.match(
    pgliteMigrations,
    /CREATE UNIQUE INDEX IF NOT EXISTS "idx_messages_user_random_id"/,
  );
  assert.doesNotMatch(pgliteMigrations, /CONCURRENTLY/);
});
