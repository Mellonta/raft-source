import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getDb, getRootDb } from "./index";
import { isInTransaction, recordExternalSinkInsideTransaction, installAuditedGlobalFetch } from "./ambientTransaction";
import { users } from "./schema";

// The open transaction is the ambient connection (db/index.ts scopeTransactions).
// Before it, each of these reads went to a second pool connection: it could not see
// the transaction's own uncommitted row, and on the single-connection test database
// it waited forever.

async function insertUser(executor: ReturnType<typeof getDb>, email: string) {
  const [row] = await executor.insert(users).values({ email, name: email, passwordHash: "x", emailVerified: true }).returning();
  return row;
}

test("inside a transaction, getDb() reads the transaction's own uncommitted rows", async ({ db: _db }) => {
  await getDb().transaction(async (tx) => {
    const user = await insertUser(tx as never, "scope-getdb@test.com");
    const [seen] = await getDb().select().from(users).where(eq(users.id, user.id));
    assert.equal(seen?.id, user.id);
  });
});

test("a root handle taken before the transaction joins it while it is open", async ({ db: _db }) => {
  const root = getDb();
  await root.transaction(async (tx) => {
    const user = await insertUser(tx as never, "scope-handle@test.com");
    const [seen] = await root.select().from(users).where(eq(users.id, user.id));
    assert.equal(seen?.id, user.id);
  });
});

test("a root transaction opened inside one is a savepoint of it", async ({ db: _db }) => {
  const root = getDb();
  let kept = "";
  await root.transaction(async (tx) => {
    kept = (await insertUser(tx as never, "scope-outer@test.com")).id;
    await assert.rejects(root.transaction(async (inner) => {
      await insertUser(inner as never, "scope-inner@test.com");
      throw new Error("roll back the savepoint only");
    }));
  });
  const emails = (await root.select({ email: users.email }).from(users)).map((row) => row.email);
  assert.ok(emails.includes("scope-outer@test.com"));
  assert.ok(!emails.includes("scope-inner@test.com"));
  assert.ok(kept);
});

test("the audit records a second-connection escape hatch but not the ambient redirect", async ({ db: _db }) => {
  const dir = mkdtempSync(join(tmpdir(), "tx-audit-"));
  const file = join(dir, "audit.txt");
  writeFileSync(file, "");
  const previous = process.env.RAFT_TX_POOL_AUDIT_FILE;
  process.env.RAFT_TX_POOL_AUDIT_FILE = file;
  try {
    await getDb().transaction(async (tx) => {
      // The ambient redirect is NOT a second connection: getDb() joins the open
      // transaction, so it must not be recorded.
      await insertUser(tx as never, "audit-ambient@test.com");
      await getDb().select().from(users).where(eq(users.name, "audit-ambient@test.com"));
      // getRootDb() is the deliberate escape hatch: merely resolving it records a
      // second-connection use. (Calling it does NOT run a query, so this does not
      // deadlock the single-connection test DB the way an actual root query would.)
      getRootDb();
    });
    const entries = readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { source?: string });
    assert.equal(entries.length, 1, "exactly one second-connection use inside the transaction");
    assert.equal(entries[0].source, "getRootDb");
  } finally {
    if (previous === undefined) delete process.env.RAFT_TX_POOL_AUDIT_FILE;
    else process.env.RAFT_TX_POOL_AUDIT_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("external-sink audit records only inside a transaction", async ({ db: _db }) => {
  const dir = mkdtempSync(join(tmpdir(), "tx-sink-audit-"));
  const file = join(dir, "audit.txt");
  writeFileSync(file, "");
  const previous = process.env.RAFT_TX_POOL_AUDIT_FILE;
  process.env.RAFT_TX_POOL_AUDIT_FILE = file;
  try {
    // Outside a transaction: isInTransaction is false and no HIT is recorded.
    assert.equal(isInTransaction(), false);
    assert.equal(recordExternalSinkInsideTransaction("risingwave"), false);

    // Inside a transaction: isInTransaction is true and the sink is recorded.
    await getDb().transaction(async (tx) => {
      assert.equal(isInTransaction(), true);
      assert.equal(recordExternalSinkInsideTransaction("risingwave"), true);
      assert.equal(recordExternalSinkInsideTransaction("redis"), true);
      await insertUser(tx as never, "sink-audit@test.com");
    });

    const entries = readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    // Hits are `{ source, stack }`; `{ armed }` records are provenance, not hits.
    const hitSources = entries.filter((e) => typeof e.source === "string").map((e) => e.source);
    assert.deepEqual(hitSources.sort(), ["redis", "risingwave"], "only the in-tx sink uses record hits");
    assert.ok(entries.some((e) => e.armed === "risingwave"), "the out-of-tx call still marks the sink armed");
  } finally {
    if (previous === undefined) delete process.env.RAFT_TX_POOL_AUDIT_FILE;
    else process.env.RAFT_TX_POOL_AUDIT_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the audited global fetch records a fetch inside a transaction", async ({ db: _db }) => {
  const dir = mkdtempSync(join(tmpdir(), "tx-fetch-audit-"));
  const file = join(dir, "audit.txt");
  writeFileSync(file, "");
  const previous = process.env.RAFT_TX_POOL_AUDIT_FILE;
  process.env.RAFT_TX_POOL_AUDIT_FILE = file;
  // Install the audited global fetch (idempotent). The wrapper records the
  // source before delegating, so a refused connection still leaves a hit.
  installAuditedGlobalFetch();
  try {
    await getDb().transaction(async (tx) => {
      await insertUser(tx as never, "fetch-audit@test.com");
      await globalThis.fetch("http://127.0.0.1:9/").catch(() => undefined);
    });
    const entries = readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(entries.some((e) => e.source === "fetch"), "a fetch inside the transaction must be recorded");
    // The ambient redirect (getDb() in the transaction) is NOT a hit.
    assert.ok(!entries.some((e) => e.source === "getRootDb"));
  } finally {
    if (previous === undefined) delete process.env.RAFT_TX_POOL_AUDIT_FILE;
    else process.env.RAFT_TX_POOL_AUDIT_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
