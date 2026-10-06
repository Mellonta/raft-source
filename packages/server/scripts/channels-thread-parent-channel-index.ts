import pg from "pg";

// Live threads by parent channel (one row per live thread). Search visibility
// resolves "threads under these visible channels" through it as an index-only
// scan instead of reading every thread's parent message. Requires 0297's
// channels.parent_channel_id (trigger-derived) and the phase-2 backfill.
export const THREAD_PARENT_CHANNEL_INDEX_NAME = "idx_channels_thread_parent_channel";
export const THREAD_PARENT_CHANNEL_INDEX_STATEMENT_TIMEOUT =
  process.env.CHANNELS_THREAD_PARENT_CHANNEL_INDEX_STATEMENT_TIMEOUT?.trim() || "30min";
export const THREAD_PARENT_CHANNEL_INDEX_LOCK_TIMEOUT =
  process.env.CHANNELS_THREAD_PARENT_CHANNEL_INDEX_LOCK_TIMEOUT?.trim() || "30s";

export const CREATE_THREAD_PARENT_CHANNEL_INDEX_SQL = `
CREATE INDEX CONCURRENTLY IF NOT EXISTS "${THREAD_PARENT_CHANNEL_INDEX_NAME}"
  ON "channels" USING btree ("parent_channel_id", "id")
  WHERE type = 'thread' AND deleted_at IS NULL
`;

export type ThreadParentChannelIndexStatus = {
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

export async function assertParentChannelColumnExists(client: pg.PoolClient) {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'channels' AND column_name = 'parent_channel_id'
     ) AS "exists"`,
  );
  if (!result.rows[0]?.exists) {
    throw new Error(`channels.parent_channel_id is missing; run db:migrate (0297) before ${THREAD_PARENT_CHANNEL_INDEX_NAME}`);
  }
}

export async function readThreadParentChannelIndexStatus(
  client: pg.PoolClient,
): Promise<ThreadParentChannelIndexStatus> {
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
        AND tbl.relname = 'channels'
        AND idx.relname = $1
      GROUP BY i.indisunique, i.indisvalid, i.indisready, i.indpred, i.indrelid
    `,
    [THREAD_PARENT_CHANNEL_INDEX_NAME],
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

export function assertThreadParentChannelIndexReady(status: ThreadParentChannelIndexStatus) {
  if (!status.exists) {
    throw new Error(`${THREAD_PARENT_CHANNEL_INDEX_NAME} is missing`);
  }
  if (status.isUnique) {
    throw new Error(`${THREAD_PARENT_CHANNEL_INDEX_NAME} must not be unique`);
  }
  if (!status.isValid || !status.isReady) {
    throw new Error(
      `${THREAD_PARENT_CHANNEL_INDEX_NAME} exists but is not ready/valid; drop the invalid index concurrently before retrying`,
    );
  }
  if (status.columns.join(",") !== "parent_channel_id,id") {
    throw new Error(`${THREAD_PARENT_CHANNEL_INDEX_NAME} has unexpected columns: ${status.columns.join(",")}`);
  }
  if (status.predicate?.replace(/[()\s]/g, "") !== "type='thread'::textANDdeleted_atISNULL") {
    throw new Error(`${THREAD_PARENT_CHANNEL_INDEX_NAME} has unexpected predicate: ${status.predicate}`);
  }
}

export function describeThreadParentChannelIndexStatus(status: ThreadParentChannelIndexStatus): string {
  if (!status.exists) return `${THREAD_PARENT_CHANNEL_INDEX_NAME}: missing`;
  return [
    `${THREAD_PARENT_CHANNEL_INDEX_NAME}: exists`,
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
