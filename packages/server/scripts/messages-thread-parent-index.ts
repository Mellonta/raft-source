import pg from "pg";

// Retired partial index over thread parents (channel_id, thread_id) WHERE
// thread_id IS NOT NULL, built by 0293's out-of-band step. #8563 resolves
// "threads whose parent is in channel X" through channels.parent_channel_id
// (idx_channels_thread_parent_channel), so this index is only write cost now.
// 0309 drops it from the schema; production drops it concurrently here.
export const THREAD_PARENT_INDEX_NAME = "idx_messages_channel_thread_parent";
export const THREAD_PARENT_INDEX_STATEMENT_TIMEOUT =
  process.env.MESSAGES_THREAD_PARENT_INDEX_STATEMENT_TIMEOUT?.trim() || "30min";
export const THREAD_PARENT_INDEX_LOCK_TIMEOUT =
  process.env.MESSAGES_THREAD_PARENT_INDEX_LOCK_TIMEOUT?.trim() || "30s";

// Must run as its own statement outside a transaction block.
export const DROP_THREAD_PARENT_INDEX_SQL = `DROP INDEX CONCURRENTLY IF EXISTS "${THREAD_PARENT_INDEX_NAME}"`;

export type ThreadParentIndexStatus = {
  exists: boolean;
  isUnique: boolean;
  isValid: boolean;
  isReady: boolean;
  columns: string[];
  predicate: string | null;
};

type IndexRow = {
  isUnique: boolean;
  isValid: boolean;
  isReady: boolean;
  columns: string[] | string | null;
  predicate: string | null;
};

export function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return databaseUrl;
}

export function createPool(databaseUrl = getDatabaseUrl()): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 1 });
}

export async function assertMessagesTableExists(client: pg.PoolClient) {
  const result = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('public.messages') IS NOT NULL AS "exists"`,
  );
  if (!result.rows[0]?.exists) {
    throw new Error(`messages is missing; run db:migrate before ${THREAD_PARENT_INDEX_NAME}`);
  }
}

export async function readThreadParentIndexStatus(
  client: pg.PoolClient,
): Promise<ThreadParentIndexStatus> {
  const result = await client.query<IndexRow>(
    `
      SELECT
        i.indisunique AS "isUnique",
        i.indisvalid AS "isValid",
        i.indisready AS "isReady",
        array_agg(a.attname ORDER BY key.ordinality) AS "columns",
        pg_get_expr(i.indpred, i.indrelid) AS "predicate"
      FROM pg_class idx
      JOIN pg_namespace ns ON ns.oid = idx.relnamespace
      JOIN pg_index i ON i.indexrelid = idx.oid
      JOIN pg_class tbl ON tbl.oid = i.indrelid
      JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality)
        ON true
      JOIN pg_attribute a ON a.attrelid = tbl.oid AND a.attnum = key.attnum
      WHERE ns.nspname = 'public'
        AND tbl.relname = 'messages'
        AND idx.relname = $1
      GROUP BY i.indisunique, i.indisvalid, i.indisready, i.indpred, i.indrelid
    `,
    [THREAD_PARENT_INDEX_NAME],
  );

  const row = result.rows[0];
  if (!row) {
    return { exists: false, isUnique: false, isValid: false, isReady: false, columns: [], predicate: null };
  }
  return {
    exists: true,
    isUnique: row.isUnique,
    isValid: row.isValid,
    isReady: row.isReady,
    columns: normalizeColumns(row.columns),
    predicate: row.predicate,
  };
}

export function assertThreadParentIndexDropped(status: ThreadParentIndexStatus) {
  if (status.exists) {
    throw new Error(
      `${THREAD_PARENT_INDEX_NAME} still exists (valid=${status.isValid}); run db:drop-messages-thread-parent-index`,
    );
  }
}

export function describeThreadParentIndexStatus(status: ThreadParentIndexStatus): string {
  if (!status.exists) return `${THREAD_PARENT_INDEX_NAME}: missing`;
  return [
    `${THREAD_PARENT_INDEX_NAME}: exists`,
    `unique=${status.isUnique}`,
    `valid=${status.isValid}`,
    `ready=${status.isReady}`,
    `columns=${status.columns.join(",") || "(none)"}`,
    `predicate=${status.predicate ?? "(none)"}`,
  ].join(" ");
}

function normalizeColumns(columns: string[] | string | null): string[] {
  if (!columns) return [];
  if (Array.isArray(columns)) return columns;
  return columns
    .replace(/^\{|\}$/g, "")
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean);
}

/**
 * Operator-facing failure text. A failed connect (e.g. DNS flapping to Neon)
 * surfaces as an AggregateError whose own message is empty, so print its code
 * and every underlying error instead of a blank line.
 */
export function describeScriptError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [`${error.name}: ${error.message || "(no message)"}`];
  const code = (error as { code?: unknown }).code;
  if (code) parts.push(`code=${String(code)}`);
  const inner = (error as { errors?: unknown }).errors;
  if (Array.isArray(inner)) {
    for (const cause of inner) {
      parts.push(`  caused by: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}${
        cause && typeof cause === "object" && "code" in cause ? ` (code=${String((cause as { code: unknown }).code)})` : ""
      }`);
    }
  }
  if (error.cause) parts.push(`  cause: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`);
  return parts.join("\n");
}
