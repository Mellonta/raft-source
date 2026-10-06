import { getTableColumns, type Table } from "drizzle-orm";

/**
 * PostgreSQL's extended protocol sends a statement's parameter count as an Int16, so one
 * statement can bind at most 65,535 values. node-postgres does not guard it: past the limit
 * the count wraps and the server rejects the Bind message (`08P01`, e.g. "bind message has 2
 * parameter formats but 0 parameters" for 65,538 values). Drizzle does not chunk either
 * (drizzle-team/drizzle-orm#1740), and a multi-row `.values([...])` binds rows × columns.
 */
export const PG_MAX_BIND_PARAMETERS = 65_535;

/**
 * Headroom for parameters a statement binds outside its row list: an ON CONFLICT SET
 * value, a WHERE clause, etc. Callers with more must pass their own count.
 */
const DEFAULT_RESERVED_PARAMETERS = 256;

/**
 * Upper bound on the parameters one inserted row can bind: every table column yields at most
 * one (a value, a `$defaultFn` result, or the `default` keyword, which binds none). Deriving it
 * from the table rather than from the row literal keeps the bound correct when a column or a
 * `$defaultFn` is added later.
 */
export function insertParametersPerRow(table: Table): number {
  return Object.keys(getTableColumns(table)).length;
}

/**
 * Split `items` so that no statement built from one chunk binds more than
 * PG_MAX_BIND_PARAMETERS, given `parametersPerItem` values per item plus `reservedParameters`
 * bound elsewhere in the statement. Order is preserved; an empty input yields no chunks.
 */
export function chunkForBindParameters<T>(
  items: readonly T[],
  parametersPerItem: number,
  reservedParameters = DEFAULT_RESERVED_PARAMETERS,
): T[][] {
  if (!Number.isSafeInteger(parametersPerItem) || parametersPerItem < 1) {
    throw new Error(`parametersPerItem must be a positive integer, got ${String(parametersPerItem)}`);
  }
  const available = PG_MAX_BIND_PARAMETERS - reservedParameters;
  const itemsPerChunk = Math.floor(available / parametersPerItem);
  if (itemsPerChunk < 1) {
    throw new Error(`one item binds ${parametersPerItem} parameters, more than the ${available} available per statement`);
  }
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += itemsPerChunk) {
    chunks.push(items.slice(start, start + itemsPerChunk));
  }
  return chunks;
}
