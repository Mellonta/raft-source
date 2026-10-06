import {
  agentMigrationTopLevelPath,
  type AgentMigrationBundleFileEntry,
  type AgentMigrationExportEntryOverflow,
} from "./agentMigrationExport";
import { normalizeAgentMigrationWorkspaceRelativePath } from "./agentMigrationWorkspacePath";

const MAX_OBJECT_STORE_BUNDLE_ENTRIES = 250_000;
const MAX_BUNDLE_TOO_LARGE_ACCOUNTING_ENTRIES = 3;
const MAX_ENCODED_ACCOUNTING_PATH_LENGTH = 96;

export interface AgentMigrationObjectStoreTopPathCount {
  path: string;
  entryCount: number;
}

export class AgentMigrationObjectStoreEntryCountLimitError extends Error {
  readonly code = "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED";

  constructor(
    readonly entryCount: number,
    readonly maxEntries: number,
    readonly topPathCounts: AgentMigrationObjectStoreTopPathCount[] = [],
  ) {
    super(entryCountLimitWireMessage(entryCount, maxEntries, topPathCounts));
    this.name = "AgentMigrationObjectStoreEntryCountLimitError";
  }
}

function entryCountLimitWireMessage(
  entryCount: number,
  maxEntries: number,
  topPathCounts: AgentMigrationObjectStoreTopPathCount[],
): string {
  const encodedPaths = topPathCounts
    .slice(0, MAX_BUNDLE_TOO_LARGE_ACCOUNTING_ENTRIES)
    .map((entry) => `${encodeAccountingPath(entry.path)},${entry.entryCount}`)
    .filter((entry) => entry.length > 0);
  return `MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED:entryCount=${entryCount}`
    + `:maxEntries=${maxEntries}:topPathCounts=${encodedPaths.join(";")}`;
}

/**
 * Throws when the walk found more entries than the limit. `overflow` carries
 * the entries the export walk only counted after it passed the limit, keyed by
 * top-level workspace path, so the error reports the real total.
 */
export function assertAgentMigrationObjectStoreEntryLimit(
  entries: readonly AgentMigrationBundleFileEntry[],
  maxEntries = MAX_OBJECT_STORE_BUNDLE_ENTRIES,
  overflow?: AgentMigrationExportEntryOverflow,
): void {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error("MIGRATION_OBJECT_STORE_MAX_ENTRIES_INVALID");
  }
  const overflowCount = overflow?.entryCount ?? 0;
  if (entries.length + overflowCount <= maxEntries) return;
  throw new AgentMigrationObjectStoreEntryCountLimitError(
    entries.length + overflowCount,
    maxEntries,
    largestWorkspaceEntryCounts({ files: entries }, MAX_BUNDLE_TOO_LARGE_ACCOUNTING_ENTRIES, overflow?.countByTopLevelPath),
  );
}

export function largestWorkspaceEntryCounts(
  manifest: { files: readonly AgentMigrationBundleFileEntry[] },
  limit = MAX_BUNDLE_TOO_LARGE_ACCOUNTING_ENTRIES,
  extraCountByTopLevelPath?: ReadonlyMap<string, number>,
): AgentMigrationObjectStoreTopPathCount[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  const countByTopLevelPath = new Map<string, number>();
  const add = (unredactedAccountingPath: string, count: number) => {
    const accountingPath = isSensitiveAccountingPath(unredactedAccountingPath)
      ? "other/"
      : unredactedAccountingPath;
    countByTopLevelPath.set(accountingPath, (countByTopLevelPath.get(accountingPath) ?? 0) + count);
  };
  for (const entry of manifest.files) {
    if (entry.source !== "workspace" || !entry.workspaceRelativePath) continue;
    add(agentMigrationTopLevelPath(normalizeObjectStoreWorkspaceRelativePath(entry.workspaceRelativePath)), 1);
  }
  for (const [topLevelPath, count] of extraCountByTopLevelPath ?? []) add(topLevelPath, count);
  return [...countByTopLevelPath]
    .map(([accountingPath, entryCount]) => ({ path: accountingPath, entryCount }))
    .sort((left, right) => right.entryCount - left.entryCount || left.path.localeCompare(right.path))
    .slice(0, limit);
}

function isSensitiveAccountingPath(value: string): boolean {
  const basename = value.endsWith("/") ? value.slice(0, -1) : value;
  return /^\.env(?:\.|$)/i.test(basename)
    || /(?:secret|token|credential|api[-_]?key)/i.test(basename);
}

function encodeAccountingPath(value: string): string {
  let encoded = "";
  for (const character of value) {
    const next = encodeURIComponent(character);
    if (encoded.length + next.length > MAX_ENCODED_ACCOUNTING_PATH_LENGTH) break;
    encoded += next;
  }
  return encoded;
}

function normalizeObjectStoreWorkspaceRelativePath(relativePath: unknown): string {
  return normalizeAgentMigrationWorkspaceRelativePath(
    relativePath,
    "MIGRATION_OBJECT_STORE_UNSAFE_PATH",
  );
}
