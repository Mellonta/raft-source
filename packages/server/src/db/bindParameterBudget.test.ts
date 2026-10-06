import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";

import { chunkForBindParameters, insertParametersPerRow, PG_MAX_BIND_PARAMETERS } from "./bindParameterBudget";
import { inboxNotificationFacts } from "./schema";

const db = drizzle.mock();
const at = new Date("2026-09-15T00:00:00.000Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Fully populated rows (no undefined, nullable columns set) so every column that can bind does.
const factRow = (n: number) => ({
  receiverType: "user" as const, receiverId: uuid(n), serverId: uuid(1), kind: "channel" as const,
  sourceChannelId: uuid(2), messageId: uuid(3), messageSeq: n, activityAt: at,
  personalMention: false, unreadEligible: true,
});

test("chunkForBindParameters keeps order, covers every item once, and sizes chunks to the parameter budget", () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  assert.deepEqual(chunkForBindParameters([], 3), []);
  // 65,535 − 65,532 reserved = 3 available, 1 per item ⇒ chunks of 3.
  assert.deepEqual(chunkForBindParameters(items, 1, 65_532), [[0, 1, 2], [3, 4, 5], [6, 7, 8], [9]]);
  assert.throws(() => chunkForBindParameters(items, 0), /positive integer/);
  assert.throws(() => chunkForBindParameters(items, 4, 65_532), /more than the 3 available/);
});

test("insertParametersPerRow is a true upper bound on what Drizzle binds per row, including $defaultFn columns", () => {
  for (const [table, row] of [[inboxNotificationFacts, factRow(1)]] as const) {
    const bound = insertParametersPerRow(table);
    const measured = db.insert(table).values([row as never, row as never]).toSQL().params.length / 2;
    assert.ok(measured <= bound, `${bound} must bound the ${measured} parameters Drizzle binds per row`);
    assert.ok(measured > 0);
  }
});

test("every chunked statement for a large fan-out stays within PostgreSQL's parameter limit, and the unchunked one does not", () => {
  // Just past the table's wall: 6,000 × 11 = 66,000. (Much larger
  // unchunked inserts also overflow Drizzle's SQL builder stack — drizzle-orm#1740 — which
  // chunking avoids as well.)
  const cases = [
    { table: inboxNotificationFacts, rows: Array.from({ length: 6_000 }, (_, i) => factRow(i)) },
  ];
  for (const { table, rows } of cases) {
    const unchunked = db.insert(table).values(rows as never[]).toSQL().params.length;
    assert.ok(unchunked > PG_MAX_BIND_PARAMETERS, `control: the unchunked statement binds ${unchunked}, past the limit`);
    const chunks = chunkForBindParameters<unknown>(rows, insertParametersPerRow(table));
    assert.ok(chunks.length > 1);
    assert.equal(chunks.flat().length, rows.length);
    for (const chunk of chunks) {
      const params = db.insert(table).values(chunk as never[]).toSQL().params.length;
      assert.ok(params <= PG_MAX_BIND_PARAMETERS, `a chunk binds ${params}`);
    }
  }
});
