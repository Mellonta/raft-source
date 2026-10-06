import assert from "node:assert/strict";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import { closeRisingWavePool, getRisingWavePool, queryRisingWave } from "../db/risingwave";
import { seedRealRwFixture, waitForRealRwFixture } from "../test/realRwFixture";
import { __testRisingWaveInbox, getInboxItems } from "./channelService";
import { installRisingWaveReadReferences, uninstallRisingWaveReadReferences } from "../test/risingWaveReadReference";

const required = process.env.RISINGWAVE_INBOX_PREPARE_REAL_RW_REQUIRED === "1";
const databaseUrl = process.env.DATABASE_URL?.trim();
const risingWaveUrl = process.env.RISINGWAVE_DATABASE_URL?.trim();
// Either point at existing data (all three ids) or, when none is given, seed a
// fresh fixture and wait for it to reach RisingWave (the risingwave-real CI job).
let serverId = process.env.RISINGWAVE_INBOX_PREPARE_SERVER_ID?.trim();
let userId = process.env.RISINGWAVE_INBOX_PREPARE_USER_ID?.trim();
let channelId = process.env.RISINGWAVE_INBOX_PREPARE_CHANNEL_ID?.trim();
const idsGiven = [serverId, userId, channelId].filter(Boolean).length;
const configured = Boolean(
  databaseUrl && risingWaveUrl && !databaseUrl.startsWith("pglite") && (idsGiven === 0 || idsGiven === 3),
);

if (required && !configured) {
  throw new Error(
    "real RW prepare test requires DATABASE_URL (real Postgres), RISINGWAVE_DATABASE_URL, "
      + "and either all or none of RISINGWAVE_INBOX_PREPARE_SERVER_ID, RISINGWAVE_INBOX_PREPARE_USER_ID, "
      + "RISINGWAVE_INBOX_PREPARE_CHANNEL_ID",
  );
}

test("real RisingWave prepares the inbox serving query with null and non-null channelId", {
  skip: !configured,
}, async () => {
  assert.ok(databaseUrl);
  const prepared: Array<{ channelParam: unknown; rowCount: number | null }> = [];
  await initDatabase(databaseUrl, undefined, { log: () => {} });
  // The global setupFiles install the Postgres test references; the real RW
  // pool must serve here.
  uninstallRisingWaveReadReferences();
  try {
    if (idsGiven === 0) {
      const pool = getRisingWavePool();
      assert.ok(pool, "RISINGWAVE_DATABASE_URL must yield a RisingWave pool");
      const fixture = await seedRealRwFixture(getDb());
      await waitForRealRwFixture(pool, fixture);
      serverId = fixture.receiverServer.id;
      userId = fixture.receiver.id;
      channelId = fixture.general.id;
    }
    assert.ok(serverId);
    assert.ok(userId);
    assert.ok(channelId);

    __testRisingWaveInbox.set({
      query: (async (pool, queryText, values) => {
        const result = await queryRisingWave(pool, queryText, values);
        prepared.push({
          channelParam: values?.[4] ?? null,
          rowCount: result.result.rowCount,
        });
        return result;
      }) as typeof queryRisingWave,
    });

    for (const scopedChannelId of [undefined, channelId]) {
      await getInboxItems(serverId, userId, {
        filter: "all",
        limit: 100,
        channelId: scopedChannelId,
        humanActivityMuteEnabled: false,
      });
    }
  } finally {
    __testRisingWaveInbox.reset();
    installRisingWaveReadReferences();
    await closeRisingWavePool();
    await closeDatabase();
  }

  assert.equal(prepared.length, 2, "both calls must complete a direct RisingWave query");
  assert.equal(prepared[0]?.channelParam, null);
  assert.equal(prepared[1]?.channelParam, channelId);
  assert.ok((prepared[0]?.rowCount ?? 0) >= 1);
  assert.ok((prepared[1]?.rowCount ?? 0) >= 1);
});
