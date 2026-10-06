import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { attachPoolClientErrorHandler } from "./pgPoolErrorHandler";
import { noopTracer, type TraceContext, type Tracer } from "@botiverse/raft-shared";
import * as schema from "./schema";
import { migratePglite } from "./pgliteMigrations";
import { closeRisingWavePool } from "./risingwave";
import {
  recordSecondConnectionInsideTransaction,
  scopeTransactions,
  type Database,
} from "./ambientTransaction";
import { dbPoolConnections, dbPoolWaitingRequests, pgPoolReadOnlyClientRecycledTotal } from "../metrics";
import { errorClassOf, getCurrentTraceContext } from "../tracing/semanticTrace";

let _tracer: Tracer = noopTracer;
const dbTraceAttributes = new AsyncLocalStorage<Record<string, string | number | boolean>>();
const databaseCloseHooksForTests = new Set<() => Promise<void>>();

export function setDbTracer(t: Tracer) {
  _tracer = t;
}

export function registerDatabaseCloseHookForTests(hook: () => Promise<void>): () => void {
  databaseCloseHooksForTests.add(hook);
  return () => {
    databaseCloseHooksForTests.delete(hook);
  };
}

async function runDatabaseCloseHooksForTests(): Promise<void> {
  const hooks = [...databaseCloseHooksForTests].reverse();
  const errors: Error[] = [];
  for (const hook of hooks) {
    try {
      await hook();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Database background work failed while closing");
}

export function withDbTraceAttributes<T>(attrs: Record<string, string | number | boolean>, fn: () => T): T {
  const parentAttrs = dbTraceAttributes.getStore();
  return dbTraceAttributes.run({ ...parentAttrs, ...attrs }, fn);
}

type DbStatementKind = "select" | "insert" | "update" | "delete" | "transaction" | "unknown";

interface QueryIdentity {
  rawSql: string;
  fingerprint: string;
  hash: string;
  exactHash: string;
  statementKind: DbStatementKind;
}

type PgErrorLike = {
  code?: unknown;
  message?: unknown;
};

interface PoolCheckoutState {
  label: string;
  queueMs: number;
  startMs: number;
  queryIdentity: QueryIdentity;
  // Set once a statement other than BEGIN/COMMIT/ROLLBACK/SAVEPOINT has run, so
  // the span names the work the connection was held for, not the closing COMMIT.
  hasWorkStatement?: boolean;
  // False for the first checkout of a newly opened client: its queueMs then
  // includes opening the connection (reported as connect_ms).
  connectionReused: boolean;
  // Round trip of the first statement run on this checkout, from send to
  // result. Separates "the database/pooler answered slowly" from "the
  // connection was held for other work" when hold_ms is high.
  firstQueryStartMs?: number;
  firstQueryMs?: number;
  traceParent: TraceContext | null;
  traceAttributes?: Record<string, string | number | boolean>;
}

interface InstrumentedPoolClient extends pg.PoolClient {
  __slockDbInstrumentation?: {
    checkout?: PoolCheckoutState;
    readOnlyRecycleError?: Error;
  };
}

type InstrumentedRelease = pg.PoolClient["release"] & { __slockDbInstrumentedRelease?: true };

// Clients this process has already checked out at least once. Shared by the
// connect and pool.query paths, so a client first used by either counts as
// reused afterwards (connection_reused on server.db.connection).
const seenPoolClients = new WeakSet<object>();

function markClientCheckedOut(client: object): boolean {
  const reused = seenPoolClients.has(client);
  seenPoolClients.add(client);
  return reused;
}

interface InstrumentedPool extends pg.Pool {
  __slockDbInstrumented?: boolean;
}

interface ReadOnlyRecoveryState {
  lastLoggedAtMs: number;
  suppressedLogs: number;
  logIntervalMs: number;
  now(): number;
}

export function isReadOnlyTransactionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const pgError = err as PgErrorLike;
  if (pgError.code === "25006") return true;

  const message = typeof pgError.message === "string" ? pgError.message : "";
  return /\bread[- ]only\b.*\btransaction\b/i.test(message);
}

function createReadOnlyRecoveryState(): ReadOnlyRecoveryState {
  return {
    lastLoggedAtMs: 0,
    suppressedLogs: 0,
    logIntervalMs: 5_000,
    now: Date.now,
  };
}

function recycleErrorFor(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error("Postgres connection entered read-only transaction state");
}

function recordReadOnlyRecovery(label: string, err: unknown, state: ReadOnlyRecoveryState): Error {
  const recycleErr = recycleErrorFor(err);
  const pgError = err as PgErrorLike;
  const sqlstate = typeof pgError.code === "string" ? pgError.code : "unknown";
  const attrs = {
    event_kind: "db_pool_recovery",
    pool: label,
    sqlstate,
    outcome: "client_discarded",
    reason: "read_only_transaction",
  };

  pgPoolReadOnlyClientRecycledTotal.labels(label).inc();
  _tracer.emitEvent("server.db.pool.read_only_client_recycled", {
    surface: "server",
    parent: getCurrentTraceContext(),
    attrs,
  });

  const now = state.now();
  if (now - state.lastLoggedAtMs < state.logIntervalMs) {
    state.suppressedLogs += 1;
    return recycleErr;
  }

  const suppressedLogs = state.suppressedLogs;
  state.lastLoggedAtMs = now;
  state.suppressedLogs = 0;
  console.warn(JSON.stringify({
    event: "db.pg_pool.read_only_client_recycled",
    pool_label: label,
    sqlstate,
    action: "destroy_client_on_release",
    suppressed_logs: suppressedLogs,
  }));
  return recycleErr;
}

function queryTextFromInput(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  const text = (input as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : undefined;
}

function statementKindFromText(text: string | undefined): DbStatementKind {
  if (!text) return "unknown";
  const keyword = text.trimStart().match(/^[a-zA-Z]+/)?.[0]?.toLowerCase();
  switch (keyword) {
    case "select":
    case "with":
      return "select";
    case "insert":
      return "insert";
    case "update":
      return "update";
    case "delete":
      return "delete";
    case "begin":
    case "commit":
    case "rollback":
    case "savepoint":
      return "transaction";
    default:
      return "unknown";
  }
}

function normalizeSqlShape(text: string | undefined): string {
  if (!text) return "unknown";
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ")
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*\$[\s\S]*?\$[A-Za-z_][A-Za-z0-9_]*\$/g, "?")
    .replace(/\$\$[\s\S]*?\$\$/g, "?")
    .replace(/'(?:''|[^'])*'/g, "?")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "?")
    .replace(/\$\d+\b/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim() || "unknown";
}

function normalizeSqlFingerprint(text: string | undefined): string {
  return normalizeSqlShape(text).slice(0, 240);
}

function rawSqlForTrace(text: string | undefined): string {
  return (text?.trim() || "(none)").slice(0, 2_000);
}

function hashFingerprint(fingerprint: string): string {
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 16);
}

function queryIdentityFromInput(input: unknown): QueryIdentity {
  const text = queryTextFromInput(input);
  const normalizedShape = normalizeSqlShape(text);
  const fingerprint = normalizeSqlFingerprint(text);
  return {
    rawSql: rawSqlForTrace(text),
    fingerprint,
    hash: hashFingerprint(fingerprint),
    exactHash: hashFingerprint(normalizedShape),
    statementKind: statementKindFromText(text),
  };
}

function releaseDiscarded(args: unknown[]): boolean {
  return args[0] === true || args[0] instanceof Error;
}

function recordConnectionSpan(checkout: PoolCheckoutState, releaseArgs: unknown[]) {
  const holdMs = Date.now() - checkout.startMs;
  if (holdMs <= 100 || _tracer === noopTracer) return;
  const discarded = releaseDiscarded(releaseArgs);
  _tracer.startSpan("server.db.connection", {
    parent: checkout.traceParent,
    surface: "server",
    startTimeMs: checkout.startMs - checkout.queueMs,
    attrs: {
      event_kind: "db_connection",
      pool: checkout.label,
      queue_ms: checkout.queueMs,
      hold_ms: holdMs,
      pool_occupancy_ms: holdMs,
      connection_reused: checkout.connectionReused,
      ...(checkout.connectionReused ? {} : { connect_ms: checkout.queueMs }),
      ...(checkout.firstQueryMs === undefined ? {} : { first_query_ms: checkout.firstQueryMs }),
      db_operation: "unknown",
      statement_kind: checkout.queryIdentity.statementKind,
      query: checkout.queryIdentity.rawSql,
      query_hash: checkout.queryIdentity.hash,
      query_exact_hash: checkout.queryIdentity.exactHash,
      query_fingerprint: checkout.queryIdentity.fingerprint,
      discarded,
      ...checkout.traceAttributes,
    },
  }).end("ok", {
    attrs: {
      outcome: discarded ? "discarded" : "released",
      reason: discarded ? "release_discarded" : "release_completed",
    },
  });
}

function checkoutErrorClass(err: unknown): string {
  return errorClassOf(err);
}

function recordConnectionCheckoutFailure(
  label: string,
  queueMs: number,
  queryIdentity: QueryIdentity,
  traceAttributes: Record<string, string | number | boolean> | undefined,
  traceParent: TraceContext | null,
  err: unknown,
) {
  if (_tracer === noopTracer) return;
  _tracer.startSpan("server.db.connection", {
    parent: traceParent,
    surface: "server",
    startTimeMs: Date.now() - queueMs,
    attrs: {
      event_kind: "db_connection",
      outcome: "checkout_failed",
      reason: "pool_connect_failed",
      pool: label,
      queue_ms: queueMs,
      hold_ms: 0,
      pool_occupancy_ms: 0,
      db_operation: "unknown",
      statement_kind: queryIdentity.statementKind,
      query: queryIdentity.rawSql,
      query_hash: queryIdentity.hash,
      query_exact_hash: queryIdentity.exactHash,
      query_fingerprint: queryIdentity.fingerprint,
      discarded: true,
      checkout_failed: true,
      checkout_error_class: checkoutErrorClass(err),
      ...traceAttributes,
    },
  }).end("error");
}

function markReadOnlyRecycle(
  instrumented: InstrumentedPoolClient,
  label: string,
  err: unknown,
  state: ReadOnlyRecoveryState,
) {
  if (!isReadOnlyTransactionError(err)) return;
  if (!instrumented.__slockDbInstrumentation) return;
  if (!instrumented.__slockDbInstrumentation.readOnlyRecycleError) {
    instrumented.__slockDbInstrumentation.readOnlyRecycleError = recordReadOnlyRecovery(label, err, state);
  }
}

function readOnlyRecoveryReleaseArgs(label: string, releaseArgs: unknown[], state: ReadOnlyRecoveryState): unknown[] {
  if (releaseArgs.length > 0 && isReadOnlyTransactionError(releaseArgs[0])) {
    return [recordReadOnlyRecovery(label, releaseArgs[0], state)];
  }
  return releaseArgs;
}

function preparePoolClient(
  label: string,
  client: pg.PoolClient,
  queueMs: number,
  readOnlyRecoveryState: ReadOnlyRecoveryState,
): pg.PoolClient {
  const instrumented = client as InstrumentedPoolClient;
  const connectionReused = markClientCheckedOut(client);
  if (!instrumented.__slockDbInstrumentation) {
    const originalQuery = client.query.bind(client);
    const state = {};
    instrumented.__slockDbInstrumentation = state;

    client.query = ((...args: unknown[]) => {
      const checkout = instrumented.__slockDbInstrumentation?.checkout;
      const timesFirstQuery = Boolean(checkout && checkout.firstQueryStartMs === undefined);
      if (checkout && timesFirstQuery) checkout.firstQueryStartMs = Date.now();
      const finishFirstQuery = () => {
        if (checkout && timesFirstQuery && checkout.firstQueryMs === undefined && checkout.firstQueryStartMs !== undefined) {
          checkout.firstQueryMs = Date.now() - checkout.firstQueryStartMs;
        }
      };
      if (checkout) {
        const queryIdentity = queryIdentityFromInput(args[0]);
        const isWorkStatement = queryIdentity.statementKind !== "transaction";
        if (isWorkStatement || !checkout.hasWorkStatement) {
          checkout.queryIdentity = queryIdentity;
          checkout.traceAttributes = dbTraceAttributes.getStore();
          checkout.hasWorkStatement ||= isWorkStatement;
        }
      }
      const callback = args[args.length - 1];
      if (typeof callback === "function") {
        const queryArgs = args.slice(0, -1);
        return originalQuery(...queryArgs as [never], (err: Error | undefined, ...rest: unknown[]) => {
          finishFirstQuery();
          markReadOnlyRecycle(instrumented, checkout?.label ?? "unknown", err, readOnlyRecoveryState);
          callback(err, ...rest);
        });
      }

      try {
        const result = originalQuery(...args as [never]);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return (result as Promise<unknown>).then(
            (value) => {
              finishFirstQuery();
              return value;
            },
            (err) => {
              finishFirstQuery();
              markReadOnlyRecycle(instrumented, checkout?.label ?? "unknown", err, readOnlyRecoveryState);
              throw err;
            },
          );
        }
        finishFirstQuery();
        return result;
      } catch (err) {
        finishFirstQuery();
        markReadOnlyRecycle(instrumented, checkout?.label ?? "unknown", err, readOnlyRecoveryState);
        throw err;
      }
    }) as pg.PoolClient["query"];

  }

  // pg-pool assigns a fresh client.release on every checkout, so the release
  // hook must be re-installed per checkout; installing it once per client
  // dropped the connection span (and the read-only recycle) for every reuse.
  if (!(client.release as InstrumentedRelease).__slockDbInstrumentedRelease) {
    const originalRelease = client.release.bind(client);
    const release = ((...args: unknown[]) => {
      const checkout = instrumented.__slockDbInstrumentation?.checkout;
      const readOnlyRecycleError = instrumented.__slockDbInstrumentation?.readOnlyRecycleError;
      const releaseArgs = readOnlyRecycleError ? [readOnlyRecycleError] : args;
      if (instrumented.__slockDbInstrumentation) {
        instrumented.__slockDbInstrumentation.checkout = undefined;
        instrumented.__slockDbInstrumentation.readOnlyRecycleError = undefined;
      }
      if (checkout) {
        recordConnectionSpan(checkout, releaseArgs);
      }
      return originalRelease(...releaseArgs as [never]);
    }) as InstrumentedRelease;
    release.__slockDbInstrumentedRelease = true;
    client.release = release;
  }

  instrumented.__slockDbInstrumentation.checkout = {
    label,
    queueMs,
    connectionReused,
    startMs: Date.now(),
    queryIdentity: queryIdentityFromInput(undefined),
    traceParent: getCurrentTraceContext(),
    traceAttributes: dbTraceAttributes.getStore(),
  };
  return client;
}

export function instrumentPool(label: string, pool: pg.Pool) {
  const instrumented = pool as InstrumentedPool;
  if (instrumented.__slockDbInstrumented) return;
  instrumented.__slockDbInstrumented = true;
  const readOnlyRecoveryState = createReadOnlyRecoveryState();

  const originalConnect = pool.connect.bind(pool) as (...args: unknown[]) => Promise<pg.PoolClient> | void;
  pool.connect = ((...args: unknown[]) => {
    const queueStart = Date.now();
    const traceAttributes = dbTraceAttributes.getStore();
    const traceParent = getCurrentTraceContext();
    const callback = args[0];
    if (typeof callback === "function") {
      return originalConnect((err: Error | undefined, client: pg.PoolClient | undefined, release: unknown) => {
        if (!client) {
          recordConnectionCheckoutFailure(
            label,
            Date.now() - queueStart,
            queryIdentityFromInput(undefined),
            traceAttributes,
            traceParent,
            err,
          );
          callback(err, client, release);
          return;
        }
        const prepared = preparePoolClient(label, client, Date.now() - queueStart, readOnlyRecoveryState);
        callback(err, prepared, prepared.release.bind(prepared));
      });
    }

    return (originalConnect(...args) as Promise<pg.PoolClient>).then(
      (client) => preparePoolClient(label, client, Date.now() - queueStart, readOnlyRecoveryState),
      (err) => {
        recordConnectionCheckoutFailure(
          label,
          Date.now() - queueStart,
          queryIdentityFromInput(undefined),
          traceAttributes,
          traceParent,
          err,
        );
        throw err;
      },
    );
  }) as pg.Pool["connect"];

  pool.query = ((...args: unknown[]) => {
    const callback = args[args.length - 1];
    const queueStart = Date.now();
    const queryIdentity = queryIdentityFromInput(args[0]);
    const traceAttributes = dbTraceAttributes.getStore();
    const traceParent = getCurrentTraceContext();
    const finishQuery = (client: pg.PoolClient, checkout: PoolCheckoutState, releaseArgs: unknown[]) => {
      // pool.query runs exactly one statement right after checkout, so its round
      // trip is the whole hold.
      checkout.firstQueryMs ??= Date.now() - checkout.startMs;
      const finalReleaseArgs = readOnlyRecoveryReleaseArgs(label, releaseArgs, readOnlyRecoveryState);
      if (finalReleaseArgs.length > 0) {
        client.release(finalReleaseArgs[0] as never);
      } else {
        client.release();
      }
      recordConnectionSpan(checkout, finalReleaseArgs);
    };

    if (typeof callback === "function") {
      const queryArgs = args.slice(0, -1);
      (originalConnect() as Promise<pg.PoolClient>).then((client) => {
        const checkout: PoolCheckoutState = {
          label,
          queueMs: Date.now() - queueStart,
          connectionReused: markClientCheckedOut(client),
          startMs: Date.now(),
          queryIdentity,
          traceParent,
          traceAttributes,
        };
        const query = client.query as (...queryArgs: unknown[]) => unknown;
        try {
          query(...queryArgs, (queryErr: Error | undefined, result: unknown) => {
            finishQuery(client, checkout, queryErr ? [queryErr] : []);
            callback(queryErr, result);
          });
        } catch (queryErr) {
          finishQuery(client, checkout, [queryErr]);
          callback(queryErr, undefined);
        }
      }, (err) => {
        recordConnectionCheckoutFailure(label, Date.now() - queueStart, queryIdentity, traceAttributes, traceParent, err);
        callback(err, undefined);
      });
      return;
    }

    return (originalConnect() as Promise<pg.PoolClient>).then((client) => {
      const checkout: PoolCheckoutState = {
        label,
        queueMs: Date.now() - queueStart,
        connectionReused: markClientCheckedOut(client),
        startMs: Date.now(),
        queryIdentity,
        traceParent,
        traceAttributes,
      };
      return Promise.resolve((client.query as (...queryArgs: unknown[]) => unknown)(...args)).then(
        (result) => {
          finishQuery(client, checkout, []);
          return result;
        },
        (err) => {
          finishQuery(client, checkout, [err]);
          throw err;
        },
      );
    }, (err) => {
      recordConnectionCheckoutFailure(label, Date.now() - queueStart, queryIdentity, traceAttributes, traceParent, err);
      throw err;
    });
  }) as pg.Pool["query"];
}

export type { Database, DatabaseExecutor, DatabaseTransaction } from "./ambientTransaction";

export class SearchQueryAbortedError extends Error {
  readonly code = "SEARCH_QUERY_ABORTED";

  constructor(message = "Message search query aborted", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SearchQueryAbortedError";
  }
}

export function isSearchQueryAbortedError(error: unknown): boolean {
  return error instanceof SearchQueryAbortedError
    || (
      !!error
      && typeof error === "object"
      && (
        (error as { name?: unknown }).name === "SearchQueryAbortedError"
        || (error as { code?: unknown }).code === "SEARCH_QUERY_ABORTED"
      )
    );
}

type SearchQueryResult<T extends pg.QueryResultRow> = Pick<pg.QueryResult<T>, "rows">;

type PgCancelableClient = pg.PoolClient & {
  processID?: number | null;
  secretKey?: number | null;
};

export interface PgSearchCancelContext<T extends pg.QueryResultRow = pg.QueryResultRow> {
  pool: pg.Pool;
  client: pg.PoolClient;
  query: pg.Query;
  backendPid: number | null;
}

export type PgSearchQueryCanceller = (context: PgSearchCancelContext) => void;

export interface CancellableSearchSqlOptions {
  signal?: AbortSignal;
  cancelQuery?: PgSearchQueryCanceller;
}

const pgDialect = new PgDialect();

/**
 * Return the exact normalized SQL hash emitted as `query_exact_hash` by the
 * primary-pool connection instrumentation. The human-readable fingerprint is
 * intentionally truncated, but this hash covers the complete normalized SQL.
 */
export function getSqlTraceHash(query: SQL): string {
  return queryIdentityFromInput(pgDialect.sqlToQuery(query).sql).exactHash;
}

let _db: Database | null = null;
let _pool: pg.Pool | null = null;
let _pglite: PGlite | null = null;
let _searchDb: Database | null = null;
let _searchPool: pg.Pool | null = null;

function abortErrorFor(signal?: AbortSignal): SearchQueryAbortedError {
  return new SearchQueryAbortedError("Message search query aborted", {
    cause: signal?.reason,
  });
}

function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortErrorFor(signal);
  }
}

function isPgQueryCanceledError(error: unknown): boolean {
  return !!error
    && typeof error === "object"
    && (error as { code?: unknown }).code === "57014";
}

async function connectPoolWithAbort(pool: pg.Pool, signal?: AbortSignal): Promise<pg.PoolClient> {
  throwIfSearchAborted(signal);
  const connectPromise = pool.connect();
  if (!signal) return connectPromise;

  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortErrorFor(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([connectPromise, abortPromise]);
  } catch (error) {
    if (isSearchQueryAbortedError(error)) {
      connectPromise.then((client) => client.release(), () => {});
    }
    throw error;
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function cancelPgQuery(context: PgSearchCancelContext): void {
  const client = context.client as PgCancelableClient;
  if (client.processID == null || client.secretKey == null) return;

  const cancelClient = new pg.Client(context.pool.options);
  // The Client instance itself must carry an 'error' listener: a dropped
  // connection makes pg emit 'error' on the Client, and an unhandled 'error'
  // event crashes the process (task #269).
  cancelClient.on("error", (error) => {
    console.warn("Failed to send pg cancel request for message search:", error);
  });
  const cancelConnection = (cancelClient as unknown as {
    connection?: { once(event: "error", listener: (error: Error) => void): void };
  }).connection;
  cancelConnection?.once("error", (error) => {
    console.warn("Failed to send pg cancel request for message search:", error);
  });
  try {
    (cancelClient as unknown as { cancel(targetClient: PgCancelableClient, query: pg.Query): void })
      .cancel(client, context.query);
  } catch (error) {
    console.warn("Failed to send pg cancel request for message search:", error);
  }
}

export async function executeCancellablePgPoolSql<T extends pg.QueryResultRow = pg.QueryResultRow>(
  pool: pg.Pool,
  statement: SQL,
  options: CancellableSearchSqlOptions = {},
): Promise<SearchQueryResult<T>> {
  const { signal, cancelQuery = cancelPgQuery } = options;
  const client = await connectPoolWithAbort(pool, signal);
  const pgQuery = pgDialect.sqlToQuery(statement);

  let resolveQuery!: (value: pg.QueryResult<T>) => void;
  let rejectQuery!: (reason: unknown) => void;
  const queryPromise = new Promise<pg.QueryResult<T>>((resolve, reject) => {
    resolveQuery = resolve;
    rejectQuery = reject;
  });
  const query = new pg.Query(
    pgQuery.sql,
    pgQuery.params as unknown[],
    (error, result) => {
      if (error) {
        rejectQuery(error);
        return;
      }
      resolveQuery(result as pg.QueryResult<T>);
    },
  );

  const abortError = abortErrorFor(signal);
  let queryDone = false;
  let cancelRequested = false;
  const onAbort = () => {
    if (queryDone || cancelRequested) return;
    cancelRequested = true;
    const backendPid = (client as PgCancelableClient).processID ?? null;
    cancelQuery({ pool, client, query, backendPid });
  };

  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    throwIfSearchAborted(signal);
    client.query(query);
    const result = await queryPromise;
    queryDone = true;
    if (cancelRequested) throw abortError;
    return result;
  } catch (error) {
    queryDone = true;
    if (cancelRequested || (signal?.aborted && isPgQueryCanceledError(error))) {
      throw abortError;
    }
    throw error;
  } finally {
    queryDone = true;
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
    if (cancelRequested) {
      client.release(abortError);
    } else {
      client.release();
    }
  }
}

export async function executeSearchSql<T extends pg.QueryResultRow = pg.QueryResultRow>(
  statement: SQL,
  options: CancellableSearchSqlOptions = {},
): Promise<SearchQueryResult<T>> {
  throwIfSearchAborted(options.signal);
  const searchPool = _searchPool;
  if (!searchPool) {
    return getSearchDb().execute<T>(statement) as Promise<SearchQueryResult<T>>;
  }
  // A separate replica pool is a second connection relative to the ambient
  // transaction; surface it in the audit so search reads can't silently split
  // off from an in-flight transaction.
  recordSecondConnectionInsideTransaction("executeSearchSql");
  return executeCancellablePgPoolSql<T>(searchPool, statement, options);
}

function isPgliteUrl(connectionString: string) {
  return connectionString.startsWith("pglite://");
}

function getPgliteDataDir(connectionString: string): string | undefined {
  const raw = connectionString.slice("pglite://".length).trim();
  if (!raw || raw === ":memory:" || raw === "memory") return undefined;
  return raw;
}

// Exported for the task #269 real-PG teeth: the child process in
// pgPoolErrorHandler.realPg.child.ts must exercise this exact wiring (helper
// + attach site), not a mirror of it.
export function createPool(connectionString: string) {
  const isNeon = connectionString.includes("neon.tech");
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.PG_MAX_CONNECTIONS) || 50,
    // Timeout waiting for a free connection from the pool (fail fast instead of queuing forever)
    connectionTimeoutMillis: 10_000,
    // Close idle connections after 60s — must be shorter than Fly.io NAT timeout (~5min)
    // so we never hand out a connection that Fly's network has silently dropped.
    idleTimeoutMillis: 60_000,
    ssl: isNeon ? { rejectUnauthorized: false } : undefined,
    // TCP keepalive: probe after 10s of silence on a checked-out connection.
    // This detects dead connections (e.g., Fly NAT drop) within ~30s instead of TCP's default ~20min.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  pool.on("error", (err) => {
    console.error("Unexpected pg pool error (likely a disconnected idle client):", err.message);
  });
  // Checked-out clients lose pg-pool's idle 'error' listener; without our own,
  // a server-side connection drop between queries kills the process (task #269).
  attachPoolClientErrorHandler(pool, "pg");
  return pool;
}

export async function initDatabase(
  databaseUrl: string,
  searchDatabaseUrl?: string,
  options: { log?: (...args: unknown[]) => void } = {},
) {
  if (isPgliteUrl(databaseUrl)) {
    return initPgliteDatabase(new PGlite(getPgliteDataDir(databaseUrl)));
  }

  _pool = createPool(databaseUrl);
  instrumentPool("primary", _pool);
  _rootDb = drizzleNodePg(_pool, { schema });
  _db = scopeTransactions(_rootDb);
  _pglite = null;

  const hasSearchReplica = !!searchDatabaseUrl && searchDatabaseUrl !== databaseUrl;
  const log = options.log ?? console.log;
  if (hasSearchReplica) {
    _searchPool = createPool(searchDatabaseUrl);
    instrumentPool("search", _searchPool);
    _searchDb = scopeTransactions(drizzleNodePg(_searchPool, { schema }));
    log("[db] search: using read replica");
  } else {
    _searchPool = _pool;
    _searchDb = _db;
    log("[db] search: using primary (no replica configured)");
  }
  return _db;
}

/** Attach a caller-created PGlite instance, including one restored from a datadir. */
export async function initPgliteDatabase(client: PGlite): Promise<Database> {
  try {
    await migratePglite(client);
  } catch (error) {
    await client.close();
    throw error;
  }
  _pglite = client;
  _rootDb = drizzlePglite(client, { schema }) as unknown as Database;
  _db = scopeTransactions(_rootDb);
  _pool = null;
  _searchPool = null;
  _searchDb = _db;
  return _db;
}

/**
 * The open transaction is the ambient connection.
 *
 * Functions take their executor as an optional argument that defaults to getDb(), and
 * some capture `const db = getDb()` before opening a transaction. Either way a caller
 * that forgets to pass its transaction down used to query the ROOT pool while its own
 * transaction was open: a second connection that cannot see the transaction's
 * uncommitted rows and can wait on a lock the transaction holds (on the
 * single-connection test database, a hang). Nothing in the types catches that.
 *
 * So the root database is wrapped: while a transaction callback is running, every use
 * of the root -- through getDb() or through a handle taken earlier -- goes to that
 * transaction. A root `transaction(...)` inside one becomes a savepoint on it. After
 * the callback settles the scope is closed, so a promise that outlives the commit is
 * back on the pool.
 *
 * getRootDb() is the deliberate escape hatch: a separate connection even inside a
 * transaction. An audit over the full server suite (2026-09-25) found no code that
 * needs one; any future use should say why at the call site.
 *
 * RAFT_TX_POOL_AUDIT_FILE (tests/diagnostics): records every second-connection use
 * made inside a transaction — the root escape hatch (getRootDb), a separate search
 * replica (getSearchDb / executeSearchSql when a replica pool exists), or any other
 * path that reaches a connection outside the ambient transaction. Each entry carries
 * the source label and a stack.
 */
let _rootDb: Database | null = null;

export function getDb() {
  if (!_db) throw new Error("Database not initialized. Call initDatabase() first.");
  return _db;
}

/**
 * A connection OUTSIDE any open transaction -- only for work that must not join it.
 * Say why at the call site.
 */
export function getRootDb(): Database {
  if (!_rootDb) throw new Error("Database not initialized. Call initDatabase() first.");
  recordSecondConnectionInsideTransaction("getRootDb");
  return _rootDb;
}

export function isDatabaseInitialized() {
  return Boolean(_db);
}

/**
 * Pool gauges only — a read-only view of the primary pool's size, for tracing.
 * The raw `pg.Pool` is not exposed: that would be a Proxy-bypassing escape hatch
 * able to open a second connection inside a transaction (the exact hazard #8319
 * closes).
 */
export function getPoolMetrics(): { waitingCount: number; totalCount: number; idleCount: number } | null {
  if (!_pool) return null;
  return { waitingCount: _pool.waitingCount, totalCount: _pool.totalCount, idleCount: _pool.idleCount };
}

export function getSearchDb() {
  if (!_searchDb) throw new Error("Database not initialized. Call initDatabase() first.");
  // When a separate read replica is configured, getSearchDb() reaches a connection
  // outside the ambient transaction — a second connection. The no-replica case is
  // just _db (the wrapped primary), so only the replica case is a hazard to audit.
  if (_searchDb !== _db) recordSecondConnectionInsideTransaction("getSearchDb");
  return _searchDb;
}

export async function pingDatabase() {
  const db = getDb();
  await db.execute(sql`SELECT 1`);
}

let _poolMetricsTimer: ReturnType<typeof setInterval> | null = null;

export function startPoolMetricsReporting(): void {
  if (_poolMetricsTimer) return;
  const report = () => {
    const primary = _pool;
    if (!primary) return;
    reportPoolMetrics("primary", primary);
    const search = _searchPool;
    if (search && search !== primary) {
      reportPoolMetrics("search", search);
    }
  };
  report();
  _poolMetricsTimer = setInterval(report, 30_000);
  _poolMetricsTimer.unref?.();
}

function reportPoolMetrics(poolName: "primary" | "search", pool: pg.Pool): void {
  dbPoolConnections.set({ pool: poolName, state: "total" }, pool.totalCount);
  dbPoolConnections.set({ pool: poolName, state: "idle" }, pool.idleCount);
  dbPoolWaitingRequests.set({ pool: poolName }, pool.waitingCount);
}

export function stopPoolMetricsReporting(): void {
  if (_poolMetricsTimer) {
    clearInterval(_poolMetricsTimer);
    _poolMetricsTimer = null;
  }
}

export async function closeDatabase() {
  stopPoolMetricsReporting();
  const errors: Error[] = [];
  const closers = [
    runDatabaseCloseHooksForTests,
    closeRisingWavePool,
    ...(_pool ? [() => _pool!.end()] : []),
    ...(_searchPool && _searchPool !== _pool ? [() => _searchPool!.end()] : []),
    ...(_pglite ? [() => _pglite!.close()] : []),
  ];
  try {
    for (const close of closers) {
      try {
        await close();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  } finally {
    _db = null;
    _rootDb = null;
    _searchDb = null;
    _pool = null;
    _pglite = null;
    _searchPool = null;
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Database cleanup failed");
}
