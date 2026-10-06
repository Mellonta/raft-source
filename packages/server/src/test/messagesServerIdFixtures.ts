import assert from "node:assert/strict";
import { inArray, sql } from "drizzle-orm";
import type { Database } from "../db/index";
import { messages } from "../db/schema";

export type Db = Database;

/** Put rows back in the pre-0317 state: server_id NULL under a NOT VALID check. */
export async function makeLegacy(db: Db, ids: string[]): Promise<void> {
  await db.execute(sql`ALTER TABLE messages DROP CONSTRAINT messages_server_id_not_null`);
  await db.execute(sql`ALTER TABLE messages DISABLE TRIGGER messages_server_id_update`);
  await db.update(messages).set({ serverId: null }).where(inArray(messages.id, ids));
  await db.execute(sql`ALTER TABLE messages ENABLE TRIGGER messages_server_id_update`);
  await db.execute(sql`ALTER TABLE messages ADD CONSTRAINT messages_server_id_not_null CHECK (server_id IS NOT NULL) NOT VALID`);
}

/** Mark a message as an agent migration receipt (skips the outbox's FK and validation triggers). */
export async function markReceipt(db: Db, message: { id: string; channelId: string }, serverId: string): Promise<void> {
  await db.execute(sql`SET session_replication_role = replica`);
  await db.execute(sql`
    INSERT INTO agent_migration_receipt_outbox (id, migration_id, receipt_kind, server_id, agent_id, channel_id, message_id)
    VALUES (gen_random_uuid(), gen_random_uuid(), 'completed', ${serverId}, gen_random_uuid(), ${message.channelId}, ${message.id})`);
  await db.execute(sql`SET session_replication_role = origin`);
}


/** Rejects with a Postgres error matching `pattern` (drizzle puts the driver error in `cause`). */
export async function rejectsWithPg(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (err: Error) => {
    assert.match(`${err.message} ${err.cause instanceof Error ? err.cause.message : ""}`, pattern);
    return true;
  });
}
