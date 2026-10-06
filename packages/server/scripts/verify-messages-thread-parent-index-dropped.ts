#!/usr/bin/env -S node --import @oxc-node/core/register
import "dotenv/config";
import {
  assertMessagesTableExists,
  assertThreadParentIndexDropped,
  createPool,
  describeScriptError,
  describeThreadParentIndexStatus,
  readThreadParentIndexStatus,
} from "./messages-thread-parent-index";

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await assertMessagesTableExists(client);
    const status = await readThreadParentIndexStatus(client);
    assertThreadParentIndexDropped(status);
    console.error(describeThreadParentIndexStatus(status));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(describeScriptError(error));
  process.exit(1);
});
