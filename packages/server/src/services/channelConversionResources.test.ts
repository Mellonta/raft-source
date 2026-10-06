import assert from "node:assert/strict";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DatabaseExecutor } from "../db/index";
import { CONVERSION_RESOURCE_DESCRIPTORS, parseConversionProgress } from "./channelConversionContracts";
import { moveConversionResources, verifyConversionResources, restoreConversionResources } from "./channelConversionResources";
import { stableProgressForLedger, stableStringify, type ChannelConversionJob } from "./channelConversionPhaseContext";

test("each registered resource participates in movement, verification, compensation and ledger", async () => {
  const queries: string[] = [];
  const dialect = new PgDialect();
  // Explicit SQL boundary adapter: empty batches exercise every family's query.
  const tx = { execute: async (query: SQL) => { queries.push(dialect.sqlToQuery(query).sql); return { rows: [] }; } } as unknown as DatabaseExecutor;
  const progress = parseConversionProgress({ ledgerVersion: 2 });
  const job = { id: "job", phase: "move_parent_messages", conversionEpoch: "epoch" } as ChannelConversionJob;
  assert.equal(await moveConversionResources(tx, job, sql`SELECT NULL::uuid local_id, NULL::uuid canonical_id`, "parent", progress), true);
  const moved = [...queries]; queries.length = 0;
  await verifyConversionResources(tx, sql`SELECT NULL::uuid channel_id`);
  const verified = [...queries]; queries.length = 0;
  await restoreConversionResources(tx, "from", "to");
  const compensated = [...queries];
  const ledger = stableProgressForLedger("move_parent_messages", progress);
  assert.equal(moved.length, CONVERSION_RESOURCE_DESCRIPTORS.length);
  assert.equal(verified.length, moved.length);
  assert.equal(compensated.length, moved.length);
  assert.deepEqual(Object.keys(ledger.resources?.parent ?? {}).sort(), CONVERSION_RESOURCE_DESCRIPTORS.map(item => item.family).sort());
  for (let i = 0; i < moved.length; i++) {
    const table = moved[i].match(/UPDATE "([^"]+)"/)?.[1];
    assert.ok(table);
    assert.ok(verified[i].includes(`FROM "${table}"`));
    assert.ok(compensated[i].includes(`UPDATE "${table}"`));
    assert.equal(moved[i].includes("pending_channel_id = CASE"), CONVERSION_RESOURCE_DESCRIPTORS[i].pendingChannel);
    assert.equal(verified[i].includes("pending_channel_id"), CONVERSION_RESOURCE_DESCRIPTORS[i].pendingChannel);
  }
});

test("legacy epoch decoding preserves the committed ledger bytes with missing optional fields", () => {
  const progress = parseConversionProgress({
    taskInventory: { directTaskCount: 1, threadTaskCount: 0, totalCount: 1 },
    movedParentMessages: 5, movedParentTasks: 1, movedParentMessagesCursor: "old-cursor",
    movedThreadMessages: 7, preparedThreads: 2,
  });
  assert.equal(stableStringify(stableProgressForLedger("verify", progress)),
    '{"movedParentMessages":5,"movedThreadMessages":7,"preparedThreads":2,"taskInventory":{"directTaskCount":1,"threadTaskCount":0,"totalCount":1}}');
});
