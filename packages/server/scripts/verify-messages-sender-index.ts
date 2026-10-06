#!/usr/bin/env -S node --import=@oxc-node/core/register
import "dotenv/config";
import {
  assertMessagesTableExists,
  assertSenderIndexReady,
  createPool,
  describeSenderIndexStatus,
  readSenderIndexStatus,
} from "./messages-sender-index";

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await assertMessagesTableExists(client);
    const status = await readSenderIndexStatus(client);
    assertSenderIndexReady(status);
    console.error(describeSenderIndexStatus(status));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
