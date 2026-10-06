import { appendFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

// Ambient-transaction state, split out of index.ts so external sinks
// (RisingWave query, Redis client, APNs send, the audited global fetch) can
// query "am I inside a transaction?" without importing all of db/index.ts
// (which would create index -> risingwave -> index module cycles).

export type Database = NodePgDatabase<typeof schema>;
export type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DatabaseExecutor = Database | DatabaseTransaction;

type TransactionScope = { tx: DatabaseTransaction; active: boolean };
const transactionScope = new AsyncLocalStorage<TransactionScope>();

function activeTransaction(): DatabaseTransaction | null {
  const scope = transactionScope.getStore();
  return scope?.active ? scope.tx : null;
}

/** The live transaction scope, consumed by scopeTransactions in index.ts. */
function runInTransactionScope<T>(tx: DatabaseTransaction, fn: () => Promise<T>): Promise<T> {
  const scope: TransactionScope = { tx, active: true };
  return transactionScope.run(scope, async () => {
    try {
      return await fn();
    } finally {
      scope.active = false;
    }
  });
}

/**
 * Wrap a root database so that while a top-level transaction callback runs,
 * every use of the root resolves to that transaction (and a nested root
 * transaction becomes a savepoint). The live transaction handle is deliberately
 * kept private here — sinks only get isInTransaction(), never the tx object.
 */
export function scopeTransactions(root: Database): Database {
  const transaction = root.transaction.bind(root);
  const scopedTransaction = ((callback: (tx: DatabaseTransaction) => Promise<unknown>, config?: unknown) => {
    const outer = activeTransaction();
    if (outer) return outer.transaction(callback as never);
    return transaction(async (tx) => {
      return await runInTransactionScope(tx, () => callback(tx));
    }, config as never);
  }) as Database["transaction"];
  return new Proxy(root, {
    get(target, prop, receiver) {
      if (prop === "transaction") return scopedTransaction;
      const source = activeTransaction() ?? target;
      const value = Reflect.get(source, prop, source === target ? receiver : source);
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
}

/**
 * READ-ONLY: whether the current async context is inside an ambient transaction.
 * Exposed for external sinks to self-report when invoked inside a transaction.
 * Deliberately does NOT expose the transaction handle — only a boolean.
 */
export function isInTransaction(): boolean {
  return activeTransaction() !== null;
}

function appendAuditEntry(source: string): void {
  const file = process.env.RAFT_TX_POOL_AUDIT_FILE;
  if (!file) return;
  const stack = (new Error().stack ?? "").split("\n").slice(3, 14).join("\n");
  appendFileSync(file, `${JSON.stringify({ source, stack })}\n`);
}

// "armed" provenance: an `armed source=X` record is written the first time a
// sink is actually exercised (called) in this run — or, for fetch, when its
// wrapper is installed. This is stronger than a single module-load header: it
// proves EVERY sink was genuinely reached, so a sink that was never called in a
// whole run cannot present its absence as "zero hits". A consumer must require
// all four armed records before trusting the results.
const armedSources = new Set<string>();

function markArmed(source: string): void {
  if (armedSources.has(source)) return;
  armedSources.add(source);
  const file = process.env.RAFT_TX_POOL_AUDIT_FILE;
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify({ armed: source })}\n`);
  } catch {
    // Unwritable path (e.g. a per-test temp dir before it is created): best-effort.
  }
}

/**
 * Records a second-connection access (getRootDb / getSearchDb replica /
 * executeSearchSql replica) made inside a transaction.
 */
export function recordSecondConnectionInsideTransaction(source: string): void {
  if (!activeTransaction()) return;
  appendAuditEntry(source);
}

/**
 * Audit hook for external sinks: marks the sink armed (first call), then records
 * a hit if it ran while a transaction was open. Returns true if it recorded a
 * hit, so tests can assert without re-checking.
 */
export function recordExternalSinkInsideTransaction(source: string): boolean {
  markArmed(source);
  if (!activeTransaction()) return false;
  appendAuditEntry(source);
  return true;
}

let wrapInstalled = false;

/**
 * Wrap the global fetch so any fetch() issued while a transaction is open is
 * recorded to the audit file. Installed at process startup ONLY when
 * RAFT_TX_POOL_AUDIT_FILE is set, so production is untouched by default. The
 * wrapper delegates to the previous global fetch (preserving any prior wrapper).
 * Records `armed source=fetch` when it actually installs, so "fetch zero hits"
 * is distinguishable from "fetch wrapper never installed".
 */
export function installAuditedGlobalFetch(): void {
  if (wrapInstalled || !process.env.RAFT_TX_POOL_AUDIT_FILE) return;
  wrapInstalled = true;
  markArmed("fetch");
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    recordExternalSinkInsideTransaction("fetch");
    return original(input, init);
  }) as typeof globalThis.fetch;
}

// Install the audited global fetch at module load (not just in server.ts's
// bootstrap): db/index.ts imports this module in BOTH the test process and the
// production bootstrap, so the wrapper is live wherever the audit is armed.
if (process.env.RAFT_TX_POOL_AUDIT_FILE) {
  installAuditedGlobalFetch();
}
