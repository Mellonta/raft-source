import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import {
  channelHumans,
  channels,
  messages,
  readMutations,
  serverMembers,
  servers,
  users,
} from "../db/schema";
import {
  admitReadMutation,
  claimNextReadMutation,
  executeReadMutationClaim,
} from "./readMutationSequencer";

/**
 * terminal_at must record when execution finished. It used to reuse the `now`
 * captured before the execution transaction, so terminal_at - executing_at was
 * ~0 (only the claim-to-execute gap): production read-all timings built on
 * these columns measured only the admission queue wait, never the execution.
 */

const EXECUTION_DELAY_MS = 200;

test("read mutation terminal_at is taken after execution, so terminal_at - executing_at covers the execution time", async ({ db: _db }) => {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `terminal-at-${randomUUID()}@test.invalid`,
    name: `TerminalAt${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Terminal At Server",
    slug: `terminal-at-${randomUUID()}`,
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `terminal-at-${randomUUID().slice(0, 8)}`,
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values({ channelId: channel.id, userId: owner.id });
  await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    content: "unread",
    seq: 1,
  });

  const mutationId = randomUUID();
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId,
    mutation: { kind: "global_read_all" },
  });
  const claim = await claimNextReadMutation({
    serverId: server.id,
    principalId: owner.id,
    leaseOwner: `terminal-at-${randomUUID()}`,
    leaseMs: 60_000,
  });
  assert.ok(claim, "expected the admitted global_read_all to be claimed");

  // Stand-in for real execution work: the per-scope loop is what production
  // needs to see, and it happens between the boundary capture and terminalize.
  await executeReadMutationClaim({
    claim,
    afterBoundaryCaptured: async () => {
      await new Promise((resolve) => setTimeout(resolve, EXECUTION_DELAY_MS));
    },
  });

  const [row] = await db.select({
    state: readMutations.state,
    executingAt: readMutations.executingAt,
    terminalAt: readMutations.terminalAt,
  }).from(readMutations).where(and(
    eq(readMutations.serverId, server.id),
    eq(readMutations.principalId, owner.id),
    eq(readMutations.mutationId, mutationId),
  ));
  assert.ok(row?.executingAt && row.terminalAt, "claimed and terminalized mutation must carry both timestamps");
  assert.notEqual(row.state, "executing");
  const executionMs = row.terminalAt.getTime() - row.executingAt.getTime();
  assert.ok(
    executionMs >= EXECUTION_DELAY_MS * 0.8,
    `terminal_at - executing_at must include the ${EXECUTION_DELAY_MS}ms of execution work; got ${executionMs}ms. `
      + "Near zero means terminal_at reused the pre-execution clock and the execution time is invisible again.",
  );
});
