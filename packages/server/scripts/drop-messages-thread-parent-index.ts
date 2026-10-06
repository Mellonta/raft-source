#!/usr/bin/env -S node --import @oxc-node/core/register
import "dotenv/config";
import {
  assertMessagesTableExists,
  assertThreadParentIndexDropped,
  createPool,
  DROP_THREAD_PARENT_INDEX_SQL,
  describeScriptError,
  describeThreadParentIndexStatus,
  readThreadParentIndexStatus,
  THREAD_PARENT_INDEX_LOCK_TIMEOUT,
  THREAD_PARENT_INDEX_NAME,
  THREAD_PARENT_INDEX_STATEMENT_TIMEOUT,
} from "./messages-thread-parent-index";

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await assertMessagesTableExists(client);

    const before = await readThreadParentIndexStatus(client);
    console.error(describeThreadParentIndexStatus(before));
    if (!before.exists) {
      console.error(`${THREAD_PARENT_INDEX_NAME} is already gone; no action needed`);
      return;
    }

    await client.query(`SELECT set_config('statement_timeout', $1, false)`, [
      THREAD_PARENT_INDEX_STATEMENT_TIMEOUT,
    ]);
    await client.query(`SELECT set_config('lock_timeout', $1, false)`, [
      THREAD_PARENT_INDEX_LOCK_TIMEOUT,
    ]);

    console.error(
      `Dropping ${THREAD_PARENT_INDEX_NAME} concurrently ` +
        `(statement_timeout=${THREAD_PARENT_INDEX_STATEMENT_TIMEOUT}, lock_timeout=${THREAD_PARENT_INDEX_LOCK_TIMEOUT})`,
    );
    await client.query(DROP_THREAD_PARENT_INDEX_SQL);

    const after = await readThreadParentIndexStatus(client);
    assertThreadParentIndexDropped(after);
    console.error(describeThreadParentIndexStatus(after));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(describeScriptError(error));
  process.exit(1);
});
