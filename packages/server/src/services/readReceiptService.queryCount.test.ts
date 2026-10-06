import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { Server as SocketServer } from "socket.io";

import { getDb } from "../db/index";
import { emitScopeReadUpdated } from "./readReceiptService";

/**
 * emitScopeReadUpdated is fanned out per changed scope by read-all
 * (routes/channels.ts, Promise.all over result.scopes) and runs on every
 * human message send (messageService). Human reads are never broadcast, so a
 * human actor must return before ANY query -- the flag, channel and member
 * lookups used to run first (~10 queries per scope), which read-all multiplied
 * by N concurrently.
 */

type PgliteLike = {
  query: (...args: unknown[]) => Promise<unknown>;
  transaction: <T>(fn: (tx: PgliteLike) => Promise<T>, ...rest: unknown[]) => Promise<T>;
};

function queryCounter() {
  const client = (getDb() as unknown as { $client: PgliteLike }).$client;
  const originalQuery = client.query.bind(client);
  const originalTransaction = client.transaction.bind(client);
  const counter = { count: 0 };
  // Count top-level statements and tx-scoped ones: PGlite hands transactions
  // their own client, so patching only the top-level query would miss those.
  client.query = ((...args: unknown[]) => {
    counter.count += 1;
    return originalQuery(...args);
  }) as PgliteLike["query"];
  client.transaction = (async <T,>(fn: (tx: PgliteLike) => Promise<T>, ...rest: unknown[]) => {
    return originalTransaction(async (tx: PgliteLike) => {
      const originalTxQuery = tx.query.bind(tx);
      tx.query = ((...args: unknown[]) => {
        counter.count += 1;
        return originalTxQuery(...args);
      }) as PgliteLike["query"];
      return fn(tx);
    }, ...rest);
  }) as PgliteLike["transaction"];
  return {
    counter,
    restore: () => {
      client.query = originalQuery;
      client.transaction = originalTransaction;
    },
  };
}

const fakeIo = {
  to: () => ({ emit: () => true }),
} as unknown as SocketServer;

async function countEmitQueries(peerKind: "human" | "agent"): Promise<number> {
  const { counter, restore } = queryCounter();
  try {
    await emitScopeReadUpdated({
      io: fakeIo,
      serverId: randomUUID(),
      scopeId: randomUUID(),
      peerKind,
      peerId: randomUUID(),
      maxReadSeq: 1,
      changed: true,
    });
    return counter.count;
  } finally {
    restore();
  }
}

test("emitScopeReadUpdated issues no queries for a human actor (agent control proves the counter counts)", async ({ db: _db }) => {
  const agentQueries = await countEmitQueries("agent");
  assert.ok(
    agentQueries > 0,
    "the agent path must be observed issuing queries; zero here means the counting seam is broken, so the human assertion below would prove nothing",
  );

  const humanQueries = await countEmitQueries("human");
  assert.equal(
    humanQueries,
    0,
    "a human actor must return before any query: human reads are never broadcast, and read-all fans this call out over every changed scope concurrently",
  );
});
