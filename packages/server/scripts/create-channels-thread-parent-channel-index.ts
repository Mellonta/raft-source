#!/usr/bin/env -S node --import @oxc-node/core/register
import "dotenv/config";
import {
  assertParentChannelColumnExists,
  assertThreadParentChannelIndexReady,
  createPool,
  CREATE_THREAD_PARENT_CHANNEL_INDEX_SQL,
  describeScriptError,
  describeThreadParentChannelIndexStatus,
  readThreadParentChannelIndexStatus,
  THREAD_PARENT_CHANNEL_INDEX_LOCK_TIMEOUT,
  THREAD_PARENT_CHANNEL_INDEX_NAME,
  THREAD_PARENT_CHANNEL_INDEX_STATEMENT_TIMEOUT,
} from "./channels-thread-parent-channel-index";

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await assertParentChannelColumnExists(client);

    const before = await readThreadParentChannelIndexStatus(client);
    if (before.exists) {
      assertThreadParentChannelIndexReady(before);
      console.error(describeThreadParentChannelIndexStatus(before));
      console.error(`${THREAD_PARENT_CHANNEL_INDEX_NAME} already exists; no action needed`);
      return;
    }

    await client.query(`SELECT set_config('statement_timeout', $1, false)`, [
      THREAD_PARENT_CHANNEL_INDEX_STATEMENT_TIMEOUT,
    ]);
    await client.query(`SELECT set_config('lock_timeout', $1, false)`, [
      THREAD_PARENT_CHANNEL_INDEX_LOCK_TIMEOUT,
    ]);

    console.error(
      `Creating ${THREAD_PARENT_CHANNEL_INDEX_NAME} concurrently ` +
        `(statement_timeout=${THREAD_PARENT_CHANNEL_INDEX_STATEMENT_TIMEOUT}, lock_timeout=${THREAD_PARENT_CHANNEL_INDEX_LOCK_TIMEOUT})`,
    );
    await client.query(CREATE_THREAD_PARENT_CHANNEL_INDEX_SQL);

    const after = await readThreadParentChannelIndexStatus(client);
    assertThreadParentChannelIndexReady(after);
    console.error(describeThreadParentChannelIndexStatus(after));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(describeScriptError(error));
  process.exit(1);
});
