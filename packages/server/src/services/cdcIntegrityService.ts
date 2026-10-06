/**
 * Hourly Postgres -> RisingWave CDC integrity check.
 *
 * RisingWave consumes Postgres through CDC tables
 * (`CREATE TABLE rw_x (...) FROM slock_neon_cdc TABLE 'public.x'`). Nothing
 * else compares the two sides, so silent drift (a column added to the RW table
 * after rows existed, a CDC gap) can persist for months. This check discovers
 * every CDC table from the RW catalog, compares count(*) plus count(col) per
 * non-primary-key column on both sides, and emits one id-free span with one
 * event per table. Alerting (drift vs. live lag) is left to the trace consumer;
 * see infra/risingwave/sql/README.md.
 */
import { sql } from "drizzle-orm";
import {
  clearClockInterval,
  clearClockTimeout,
  currentDate,
  noopTracer,
  setClockInterval,
  setClockTimeout,
  type Tracer,
} from "@botiverse/raft-shared";
import { executeSearchSql, getDb, getSearchDb } from "../db/index";
import { getRisingWavePool, queryRisingWave } from "../db/risingwave";
import { getRedis, isRedisAvailable } from "../redis";
import { REPLICA_ID } from "../replicaRouter";
import { errorClassOf } from "../tracing/semanticTrace";

export const CDC_INTEGRITY_SPAN = "server.cdc_integrity.check";
export const CDC_INTEGRITY_TABLE_EVENT = "cdc_integrity.table_checked";

const DEFAULT_FIRST_RUN_DELAY_MS = 15 * 60_000;
const DEFAULT_INTERVAL_MS = 60 * 60_000;
const DEFAULT_PAUSE_BETWEEN_TABLES_MS = 2_000;
const DEFAULT_QUERY_TIMEOUT_MS = 60_000;
const CLAIM_TTL_SECONDS = 3300;

/**
 * Tables too large for a full count every hour: compare a recent window only.
 * Both sides also exclude the most recent 5 minutes to cut live-lag noise.
 */
const WINDOWED_TABLES = new Set(["rw_messages", "rw_message_mentions_v2"]);
const WINDOW_PREDICATE =
  "\"created_at\" > now() - interval '3 days' AND \"created_at\" < now() - interval '5 minutes'";

export interface ParsedCdcTableDefinition {
  /** Source table as written in the definition, e.g. `public.thread_follows`. */
  sourceTable: string;
  /** All declared column names (unquoted, case-normalized like Postgres). */
  columns: string[];
  primaryKey: string[];
}

function normalizeIdentifier(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/""/g, "\"");
  }
  return trimmed.toLowerCase();
}

export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, "\"\"")}"`;
}

/** `public.thread_follows` / `public."Foo"` -> `"public"."thread_follows"`. */
export function quoteQualifiedName(qualified: string): string {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < qualified.length; i++) {
    const ch = qualified[i]!;
    if (ch === "\"") {
      if (inQuotes && qualified[i + 1] === "\"") {
        current += "\"\"";
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "." && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => quoteIdentifier(normalizeIdentifier(p))).join(".");
}

/** Split on commas at paren depth 0, ignoring commas inside quotes. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Leading identifier of an element (quoted or bare) and the rest. */
function leadingIdentifier(element: string): { name: string; rest: string } {
  if (element.startsWith("\"")) {
    let i = 1;
    while (i < element.length) {
      if (element[i] === "\"") {
        if (element[i + 1] === "\"") {
          i += 2;
          continue;
        }
        break;
      }
      i++;
    }
    return { name: normalizeIdentifier(element.slice(0, i + 1)), rest: element.slice(i + 1) };
  }
  const match = /^(\S+)([\s\S]*)$/.exec(element)!;
  return { name: normalizeIdentifier(match[1]!), rest: match[2]! };
}

/**
 * Parse a RisingWave CDC table definition (`rw_catalog.rw_tables.definition`).
 * Returns null for non-CDC tables (no `FROM <source> TABLE '<schema.table>'`).
 */
export function parseCdcTableDefinition(definition: string): ParsedCdcTableDefinition | null {
  const sourceMatch = /\)\s*(?:INCLUDE\b[\s\S]*?)?FROM\s+\S+\s+TABLE\s+'((?:[^']|'')+)'/i.exec(definition);
  if (!sourceMatch) return null;
  const open = definition.indexOf("(");
  if (open < 0) return null;

  let depth = 0;
  let quote: string | null = null;
  let close = -1;
  for (let i = open; i < definition.length; i++) {
    const ch = definition[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return null;

  const columns: string[] = [];
  const primaryKey: string[] = [];
  for (const element of splitTopLevel(definition.slice(open + 1, close))) {
    const tablePk = /^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(([\s\S]*)\)$/i.exec(element);
    if (tablePk) {
      primaryKey.push(...splitTopLevel(tablePk[1]!).map(normalizeIdentifier));
      continue;
    }
    if (/^(?:CONSTRAINT|WATERMARK|UNIQUE|CHECK|FOREIGN)\b/i.test(element)) continue;
    const { name, rest } = leadingIdentifier(element);
    columns.push(name);
    if (/\bPRIMARY\s+KEY\b/i.test(rest)) primaryKey.push(name);
  }

  return {
    sourceTable: sourceMatch[1]!.replace(/''/g, "'"),
    columns,
    primaryKey,
  };
}

export function buildCountSql(fromTable: string, columns: readonly string[], windowed: boolean): string {
  const selects = ["count(*) AS \"__rows\""];
  columns.forEach((column, index) => {
    selects.push(`count(${quoteIdentifier(column)}) AS "c${index}"`);
  });
  return `SELECT ${selects.join(", ")} FROM ${fromTable}${windowed ? ` WHERE ${WINDOW_PREDICATE}` : ""}`;
}

type Row = Record<string, unknown>;
type QueryRows = (sqlText: string) => Promise<Row[]>;

export interface CdcIntegrityDeps {
  tracer?: Tracer;
  /** Postgres (replica if configured) read; each call must carry its own timeout. */
  queryPg?: QueryRows;
  /** RisingWave read; null when RW isn't configured (the check is a no-op). */
  queryRw?: QueryRows | null;
  /** Claim the hour across replicas. Resolve false when another replica holds it. */
  claimHour?: (hourKey: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  pauseBetweenTablesMs?: number;
}

export interface CdcIntegrityTableResult {
  rwTable: string;
  sourceTable: string;
  windowed: boolean;
  pgRows?: number;
  rwRows?: number;
  diffRows?: number;
  diffColumnCount?: number;
  worstColumn?: string | null;
  worstColumnDiff?: number;
  error?: string;
}

export interface CdcIntegrityRunResult {
  outcome: "ok" | "partial" | "error" | "skipped_not_configured" | "skipped_claimed";
  tables: CdcIntegrityTableResult[];
}

function toCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`non-numeric count: ${String(value)}`);
  return n;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Postgres read: replica with cancel-on-timeout, else a short read-only tx with SET LOCAL. */
export async function defaultQueryPg(sqlText: string): Promise<Row[]> {
  const hasReplica = getSearchDb() !== getDb();
  if (hasReplica) {
    const result = await executeSearchSql<Row>(sql.raw(sqlText), {
      signal: AbortSignal.timeout(DEFAULT_QUERY_TIMEOUT_MS),
    });
    return result.rows;
  }
  // Nothing external is awaited inside this transaction.
  return getDb().transaction(async (tx) => {
    await tx.execute(sql.raw("SET TRANSACTION READ ONLY"));
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${DEFAULT_QUERY_TIMEOUT_MS}ms'`));
    const result = await tx.execute(sql.raw(sqlText));
    return result.rows as Row[];
  });
}

function defaultQueryRw(): QueryRows | null {
  const pool = getRisingWavePool();
  if (!pool) return null;
  return async (sqlText) => {
    const read = await withTimeout(queryRisingWave<Row>(pool, sqlText), DEFAULT_QUERY_TIMEOUT_MS, "risingwave count");
    return read.result.rows;
  };
}

async function defaultClaimHour(hourKey: string): Promise<boolean> {
  // No Redis: single replica / dev — just run.
  if (!isRedisAvailable()) return true;
  const result = await getRedis().set(`slock:cdc-integrity:${hourKey}`, REPLICA_ID, "EX", CLAIM_TTL_SECONDS, "NX");
  return result === "OK";
}

/** UTC `YYYY-MM-DDTHH`. */
export function cdcIntegrityHourKey(date: Date): string {
  return date.toISOString().slice(0, 13);
}

export async function runCdcIntegrityCheck(deps: CdcIntegrityDeps = {}): Promise<CdcIntegrityRunResult> {
  const queryRw = deps.queryRw === undefined ? defaultQueryRw() : deps.queryRw;
  if (!queryRw) return { outcome: "skipped_not_configured", tables: [] };
  const queryPg = deps.queryPg ?? defaultQueryPg;
  const claimHour = deps.claimHour ?? defaultClaimHour;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? currentDate;
  const pauseMs = deps.pauseBetweenTablesMs ?? DEFAULT_PAUSE_BETWEEN_TABLES_MS;
  const tracer = deps.tracer ?? noopTracer;

  if (!(await claimHour(cdcIntegrityHourKey(now())))) {
    return { outcome: "skipped_claimed", tables: [] };
  }

  const startedAt = Date.now();
  const span = tracer.startSpan(CDC_INTEGRITY_SPAN, { surface: "server", kind: "internal" });
  const tables: CdcIntegrityTableResult[] = [];

  let catalog: Row[];
  try {
    catalog = await queryRw(
      "SELECT name, definition FROM rw_catalog.rw_tables WHERE name LIKE 'rw\\_%' ORDER BY name",
    );
  } catch (error) {
    span.end("error", {
      attrs: {
        outcome: "error",
        reason: "catalog_query_failed",
        error_class: errorClassOf(error),
        tables_checked: 0,
        tables_with_diff: 0,
        max_abs_diff: 0,
        duration_ms: Date.now() - startedAt,
      },
    });
    return { outcome: "error", tables };
  }

  let first = true;
  for (const entry of catalog) {
    const rwTable = String(entry.name);
    const parsed = parseCdcTableDefinition(String(entry.definition ?? ""));
    if (!parsed) continue;
    if (!first && pauseMs > 0) await sleep(pauseMs);
    first = false;

    const pk = new Set(parsed.primaryKey);
    const columns = parsed.columns.filter((c) => !pk.has(c));
    const windowed = WINDOWED_TABLES.has(rwTable) && parsed.columns.includes("created_at");
    const result: CdcIntegrityTableResult = { rwTable, sourceTable: parsed.sourceTable, windowed };
    tables.push(result);

    try {
      const pgRow = (await queryPg(buildCountSql(quoteQualifiedName(parsed.sourceTable), columns, windowed)))[0];
      const rwRow = (await queryRw(buildCountSql(quoteIdentifier(rwTable), columns, windowed)))[0];
      if (!pgRow || !rwRow) throw new Error("count query returned no rows");
      result.pgRows = toCount(pgRow.__rows);
      result.rwRows = toCount(rwRow.__rows);
      result.diffRows = result.pgRows - result.rwRows;
      result.diffColumnCount = 0;
      result.worstColumn = null;
      result.worstColumnDiff = 0;
      columns.forEach((column, index) => {
        const diff = toCount(pgRow[`c${index}`]) - toCount(rwRow[`c${index}`]);
        if (diff === 0) return;
        result.diffColumnCount! += 1;
        if (Math.abs(diff) > Math.abs(result.worstColumnDiff!)) {
          result.worstColumn = column;
          result.worstColumnDiff = diff;
        }
      });
      span.addEvent(CDC_INTEGRITY_TABLE_EVENT, {
        rw_table: rwTable,
        source_table: parsed.sourceTable,
        windowed,
        outcome: "ok",
        pg_rows: result.pgRows,
        rw_rows: result.rwRows,
        diff_rows: result.diffRows,
        diff_column_count: result.diffColumnCount,
        worst_column: result.worstColumn ?? "",
        worst_column_diff: result.worstColumnDiff,
      });
    } catch (error) {
      result.error = errorClassOf(error);
      span.addEvent(CDC_INTEGRITY_TABLE_EVENT, {
        rw_table: rwTable,
        source_table: parsed.sourceTable,
        windowed,
        outcome: "error",
        error_class: result.error,
      });
    }
  }

  const checked = tables.filter((t) => t.error === undefined);
  const withDiff = checked.filter((t) => t.diffRows !== 0 || t.diffColumnCount !== 0);
  const maxAbsDiff = checked.reduce(
    (max, t) => Math.max(max, Math.abs(t.diffRows ?? 0), Math.abs(t.worstColumnDiff ?? 0)),
    0,
  );
  const errored = tables.length - checked.length;
  const outcome: CdcIntegrityRunResult["outcome"] = errored === 0 ? "ok" : checked.length === 0 ? "error" : "partial";
  span.end(outcome === "error" ? "error" : "ok", {
    attrs: {
      outcome,
      tables_checked: checked.length,
      tables_errored: errored,
      tables_with_diff: withDiff.length,
      max_abs_diff: maxAbsDiff,
      duration_ms: Date.now() - startedAt,
    },
  });
  return { outcome, tables };
}

export function isCdcIntegrityCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CDC_INTEGRITY_CHECK_DISABLED === "1";
}

export function startCdcIntegrityCheckWorker(input: {
  tracer?: Tracer;
  firstRunDelayMs?: number;
  intervalMs?: number;
  run?: typeof runCdcIntegrityCheck;
} = {}): { stop(): void } {
  if (isCdcIntegrityCheckDisabled()) return { stop() {} };
  const run = input.run ?? runCdcIntegrityCheck;
  let stopped = false;
  let running = false;
  let interval: unknown = null;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await run({ tracer: input.tracer });
    } catch (error) {
      console.error("[CdcIntegrity] Check failed:", error);
    } finally {
      running = false;
    }
  };
  const timeout = setClockTimeout(() => {
    if (stopped) return;
    void tick();
    interval = setClockInterval(() => void tick(), input.intervalMs ?? DEFAULT_INTERVAL_MS);
    (interval as { unref?: () => void }).unref?.();
  }, input.firstRunDelayMs ?? DEFAULT_FIRST_RUN_DELAY_MS);
  (timeout as { unref?: () => void }).unref?.();
  return {
    stop() {
      stopped = true;
      clearClockTimeout(timeout);
      if (interval !== null) clearClockInterval(interval);
    },
  };
}
