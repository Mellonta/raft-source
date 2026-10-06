import assert from "node:assert/strict";
import { dbTest as test } from "../test/integration/dbTest";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import { computerUpgradeRequests, servers, users } from "../db/schema";
import {
  createComputerUpgradeRequest,
  expireComputerUpgradeRequests,
  listLatestComputerUpgradeRequests,
  observeComputerVersionForUpgradeRequests,
  projectComputerUpgradeRequest,
  UPGRADE_REQUEST_DEADLINE_MS,
} from "./computerUpgradeRequestService";

const now = new Date("2026-09-22T12:00:00Z");
const machineId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function seed() {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email: "upgrade-request@example.com",
    name: "upgrade-request-operator",
    passwordHash: "test",
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "upgrade-request",
    slug: "upgrade-request",
    ownerId: user!.id,
  }).returning();
  return { userId: user!.id, serverId: server!.id };
}

test("one open request per machine; the reported version settles it as done", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const first = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.40", requestedByUserId: userId, now });
    assert.equal(first.created, true);
    assert.equal(first.row.outcome, null);
    assert.equal(first.row.deadlineAt.getTime(), now.getTime() + UPGRADE_REQUEST_DEADLINE_MS);

    // A second request while one is open returns the open one, unchanged.
    const again = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.41", requestedByUserId: userId, now });
    assert.equal(again.created, false);
    assert.equal(again.row.id, first.row.id);
    assert.equal(again.row.targetVersion, "1.0.40");

    // A reconnect with a different version does not close it as done: it is a failure with the reason the successor carried.
    const unrelated = await observeComputerVersionForUpgradeRequests({ machineId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", reportedVersion: "1.0.40", now });
    assert.equal(unrelated, null, "another machine's version settles nothing");

    const done = await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.40", now: new Date(now.getTime() + 60_000) });
    assert.ok(done);
    assert.equal(done.outcome, "done");
    assert.equal(done.observedVersion, "1.0.40");
    assert.equal(done.reason, null);
    assert.equal(projectComputerUpgradeRequest(done).state, "done");

    // Settled rows are never re-settled.
    const settledAgain = await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.39", now });
    assert.equal(settledAgain, null);
    const [row] = await getDb().select().from(computerUpgradeRequests).where(eq(computerUpgradeRequests.id, first.row.id));
    assert.equal(row!.outcome, "done");
  } finally {
    await closeTestDatabase();
  }
});

test("a reconnect with the old version is a failure carrying the installer's reason; a silent machine expires", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const { row } = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.40", requestedByUserId: userId, now });
    const failed = await observeComputerVersionForUpgradeRequests({
      machineId,
      reportedVersion: "1.0.36",
      receipt: { targetVersion: "1.0.40", outcome: "rolled_back", reason: "download checksum mismatch" },
      now,
    });
    assert.ok(failed);
    assert.equal(failed.id, row.id);
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.observedVersion, "1.0.36");
    assert.equal(failed.reason, "download checksum mismatch");

    // A receipt for a different target is not this request's reason.
    const second = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.41", requestedByUserId: userId, now: new Date(now.getTime() + 1) });
    assert.equal(second.created, true);
    const failedNoReceipt = await observeComputerVersionForUpgradeRequests({
      machineId,
      reportedVersion: "1.0.36",
      receipt: { targetVersion: "9.9.9", outcome: "failed", reason: "stale" },
      now,
    });
    assert.equal(failedNoReceipt?.reason, "version_unchanged");

    // Expiry: only open rows past their deadline become no_response.
    const thirdAt = new Date(now.getTime() + 2);
    const third = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.42", requestedByUserId: userId, now: thirdAt });
    assert.equal(third.created, true);
    assert.deepEqual(await expireComputerUpgradeRequests(new Date(thirdAt.getTime() + UPGRADE_REQUEST_DEADLINE_MS - 1)), []);
    const expired = await expireComputerUpgradeRequests(new Date(thirdAt.getTime() + UPGRADE_REQUEST_DEADLINE_MS));
    assert.equal(expired.length, 1);
    assert.equal(expired[0]!.id, third.row.id);
    assert.equal(expired[0]!.outcome, "no_response");

    // Projection picks the open request first, otherwise the most recent.
    const latest = await listLatestComputerUpgradeRequests([machineId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"]);
    assert.equal(latest.size, 1);
    assert.equal(latest.get(machineId)!.id, third.row.id);
    const fourth = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.43", requestedByUserId: userId, now: new Date(now.getTime() + 3) });
    const latestOpen = await listLatestComputerUpgradeRequests([machineId]);
    assert.equal(latestOpen.get(machineId)!.id, fourth.row.id);
    assert.equal(projectComputerUpgradeRequest(fourth.row).state, "pending");
  } finally {
    await closeTestDatabase();
  }
});
