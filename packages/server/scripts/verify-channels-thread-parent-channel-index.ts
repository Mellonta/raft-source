#!/usr/bin/env -S node --import @oxc-node/core/register
import "dotenv/config";
import {
  assertParentChannelColumnExists,
  assertThreadParentChannelIndexReady,
  createPool,
  describeScriptError,
  describeThreadParentChannelIndexStatus,
  readThreadParentChannelIndexStatus,
} from "./channels-thread-parent-channel-index";

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await assertParentChannelColumnExists(client);
    const status = await readThreadParentChannelIndexStatus(client);
    assertThreadParentChannelIndexReady(status);
    console.error(describeThreadParentChannelIndexStatus(status));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(describeScriptError(error));
  process.exit(1);
});
