import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import type { TrajectoryEntry } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, servers, users } from "../db/schema";
import { appendAgentActivityEvent, listRecentAgentTrajectory } from "./agentActivityLogService";
import { rewriteDaemonActivityEntries } from "./agentLifecycleReducer";


afterEach(async () => {
  await closeTestDatabase();
});

async function seedAgent(agentId: string, suffix: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    id: `10000000-0000-4000-8000-${suffix.padStart(12, "0")}`,
    email: `owner-${suffix}@example.com`,
    name: `owner-${suffix}`,
    displayName: `owner-${suffix}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();

  const [server] = await db.insert(servers).values({
    id: `20000000-0000-4000-8000-${suffix.padStart(12, "0")}`,
    name: `Server ${suffix}`,
    slug: `server-${suffix}`,
    ownerId: owner.id,
  }).returning();

  await db.insert(agents).values({
    id: agentId,
    serverId: server.id,
    name: `agent-${suffix}`,
    status: "active",
    model: "gpt-5",
    runtime: "codex",
  });
}

test("compaction terminal facts survive daemon normalization, database persistence and history readback", async ({ db }) => {
  void db;
  const agentId = "30000000-0000-4000-8000-000000000099";
  await seedAgent(agentId, "99");
  const entries = rewriteDaemonActivityEntries(
    (["compaction_failed", "input_too_large", "recovery_exhausted"] as const).map(failureReason => ({
      kind: "status" as const,
      detailKind: "runtime_error" as const,
      detail: "Context compaction interrupted",
      compaction: {
        outcome: "compaction_failed_or_exhausted" as const,
        reason: "overflow" as const,
        failureReason,
        willRetry: false,
        failureDiagnostic: {
          errorClass: "ProviderServerError" as const,
          errorReason: "provider_server_error" as const,
          fingerprint: "0123456789abcdef",
          reasonProvenance: "runtime_error_event" as const,
        },
      },
    })),
    { activity: "error", detailKind: "runtime_error", source: "canonical" },
  );
  assert.ok(entries);
  await appendAgentActivityEvent(agentId, "error", "Context compaction interrupted", entries, new Date("2026-09-14T00:00:00Z"), "compaction-terminal");
  const persisted = await listRecentAgentTrajectory(agentId);
  assert.equal(persisted.length, 3);
  assert.deepEqual(persisted.map(row => row.entry), entries);
  assert.deepEqual(persisted.map(row => row.entry.kind === "status" ? row.entry.compaction?.failureReason : undefined),
    ["compaction_failed", "input_too_large", "recovery_exhausted"]);
});

test("activity log dedupes projection writes per agent and dedupe key", async ({ db }) => {

  const agentId = "30000000-0000-4000-8000-000000000001";
  await seedAgent(agentId, "1");

  const entry: TrajectoryEntry = { kind: "status", activity: "offline", detail: "Runtime interrupted" };
  const firstInserted = await appendAgentActivityEvent(
    agentId,
    "offline",
    "Runtime interrupted",
    [entry],
    new Date("2026-05-12T00:00:00.000Z"),
    "agent:agent-1:machine:machine-1:connectionEpoch:epoch-1:readyReconcile:mark-inactive-offline",
  );
  const secondInserted = await appendAgentActivityEvent(
    agentId,
    "offline",
    "Runtime interrupted",
    [entry],
    new Date("2026-05-12T00:00:01.000Z"),
    "agent:agent-1:machine:machine-1:connectionEpoch:epoch-1:readyReconcile:mark-inactive-offline",
  );

  assert.equal(firstInserted, true);
  assert.equal(secondInserted, false);
  assert.deepEqual(await listRecentAgentTrajectory(agentId), [
    { timestamp: Date.parse("2026-05-12T00:00:00.000Z"), entry },
  ]);
});

test("activity log dedupe keys are scoped to a single agent", async ({ db }) => {

  const agentOne = "30000000-0000-4000-8000-000000000011";
  const agentTwo = "30000000-0000-4000-8000-000000000012";
  await seedAgent(agentOne, "11");
  await seedAgent(agentTwo, "12");

  const entry: TrajectoryEntry = { kind: "status", activity: "offline", detail: "Runtime interrupted" };
  const dedupeKey = "machine:shared-epoch:readyReconcile";
  const firstInserted = await appendAgentActivityEvent(
    agentOne,
    "offline",
    "Runtime interrupted",
    [entry],
    new Date("2026-05-12T00:00:00.000Z"),
    dedupeKey,
  );
  const secondInserted = await appendAgentActivityEvent(
    agentTwo,
    "offline",
    "Runtime interrupted",
    [entry],
    new Date("2026-05-12T00:00:00.000Z"),
    dedupeKey,
  );

  assert.equal(firstInserted, true);
  assert.equal(secondInserted, true);
  assert.equal((await listRecentAgentTrajectory(agentOne)).length, 1);
  assert.equal((await listRecentAgentTrajectory(agentTwo)).length, 1);
});
