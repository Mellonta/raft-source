import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  agentMigrationTransferSummarySchema,
  type AgentMigrationTransferSummary,
} from "@botiverse/raft-shared";

export type AgentMigrationBundleEntrySource = "workspace" | "runtime";
export type AgentMigrationBundleEntryKind = "file" | "symlink";

/** Entries counted past the entry limit, for the limit error. */
export interface AgentMigrationExportEntryOverflow {
  entryCount: number;
  /** Keyed by top-level workspace path, `dir/` for directories. */
  countByTopLevelPath: Map<string, number>;
}

/**
 * Cumulative source-build progress. `files`/`bytes` only grow within a phase;
 * the phases run in order scanning -> packing.
 */
export interface AgentMigrationExportProgress {
  phase: "scanning" | "packing";
  files: number;
  bytes: number;
}

export interface AgentMigrationBundleFileEntry {
  kind: AgentMigrationBundleEntryKind;
  source: AgentMigrationBundleEntrySource;
  bundlePath: string;
  workspaceRelativePath?: string;
  sizeBytes?: number;
  sha256?: string;
  mode?: number;
  mtimeMs?: number;
  linkTarget?: string;
}

export interface AgentMigrationExcludedRegenerableEntry {
  path: string;
  reason: "regenerable_default";
  regenerableHint: string;
}

/** A workspace path listed in `.raftmigrateignore` and therefore not moved. */
export interface AgentMigrationExcludedIgnoredEntry {
  path: string;
  reason: "raftmigrateignore";
  fileCount: number;
  sizeBytes: number;
}

export interface AgentMigrationUnreachableEntry {
  path: string;
  reason: "missing" | "read_error" | "unsupported_file_type" | "unsafe_symlink_target";
  detail?: string;
}

// Matched against every path segment, so only names that are unambiguously
// tool-generated belong here (e.g. not `build`, `out`, `coverage`, `venv`).
const THIRD_PARTY_REGENERABLE_NAMES = new Set([
  ".nox",
  ".pnpm-store",
  ".terraform",
  ".tox",
  ".venv",
  "bower_components",
  "node_modules",
  "vendor",
]);
const CACHE_REGENERABLE_NAMES = new Set([
  ".cache",
  ".dart_tool",
  ".gradle",
  ".mypy_cache",
  ".parcel-cache",
  ".pytest_cache",
  ".ruff_cache",
  ".turbo",
  "__pycache__",
]);
const BUILD_REGENERABLE_NAMES = new Set([".next", ".nuxt", ".svelte-kit", "dist", "target"]);

const REGENERABLE_DIRECTORY_NAMES = [
  ...THIRD_PARTY_REGENERABLE_NAMES,
  ...CACHE_REGENERABLE_NAMES,
  ...BUILD_REGENERABLE_NAMES,
].sort();

const EXCLUDED_IGNORED_SUMMARY_LARGEST = 5;

/** Whether a moved workspace path is the agent's `notes/` directory or under it. */
export function isNotesPath(workspaceRelativePath: string): boolean {
  return workspaceRelativePath === "notes" || workspaceRelativePath.startsWith("notes/");
}

/** The transfer summary from running totals, for a bundle that never lists its files in memory. */
export function summarizeAgentMigrationTransfer(input: {
  includedFileCount: number;
  includedBytes: number;
  memoryMdPresent: boolean;
  notesPresent: boolean;
  excludedRegenerable: AgentMigrationExcludedRegenerableEntry[];
  excludedIgnored?: AgentMigrationExcludedIgnoredEntry[];
}): AgentMigrationTransferSummary {
  const excludedRegenerableByCategory = {
    thirdPartyDependencies: 0,
    caches: 0,
    buildArtifacts: 0,
    otherRegenerable: 0,
  };
  for (const entry of input.excludedRegenerable) {
    const names = entry.path.replaceAll("\\", "/").split("/").filter(Boolean);
    if (names.some((name) => THIRD_PARTY_REGENERABLE_NAMES.has(name))) {
      excludedRegenerableByCategory.thirdPartyDependencies += 1;
    } else if (names.some((name) => CACHE_REGENERABLE_NAMES.has(name))) {
      excludedRegenerableByCategory.caches += 1;
    } else if (names.some((name) => BUILD_REGENERABLE_NAMES.has(name))) {
      excludedRegenerableByCategory.buildArtifacts += 1;
    } else {
      excludedRegenerableByCategory.otherRegenerable += 1;
    }
  }
  return agentMigrationTransferSummarySchema.parse({
    includedFileCount: input.includedFileCount,
    includedBytes: input.includedBytes,
    excludedRegenerableCount: input.excludedRegenerable.length,
    excludedRegenerableByCategory,
    keyWorkspaceEntries: {
      memoryMdPresent: input.memoryMdPresent,
      notesPresent: input.notesPresent,
    },
    // Only present when something was ignored, so a summary without ignores
    // stays readable by servers that predate the field.
    ...(input.excludedIgnored && input.excludedIgnored.length > 0
      ? { excludedIgnored: summarizeExcludedIgnored(input.excludedIgnored) }
      : {}),
  });
}

function summarizeExcludedIgnored(entries: AgentMigrationExcludedIgnoredEntry[]): NonNullable<AgentMigrationTransferSummary["excludedIgnored"]> {
  return {
    count: entries.length,
    fileCount: entries.reduce((total, entry) => total + entry.fileCount, 0),
    bytes: entries.reduce((total, entry) => total + entry.sizeBytes, 0),
    largest: [...entries]
      .sort((a, b) => b.sizeBytes - a.sizeBytes || a.path.localeCompare(b.path))
      .slice(0, EXCLUDED_IGNORED_SUMMARY_LARGEST)
      .map((entry) => ({ path: entry.path, bytes: entry.sizeBytes })),
  };
}

/** Workspace-root file listing paths that are regenerable and need not move. */
export const AGENT_MIGRATION_IGNORE_FILE = ".raftmigrateignore";
// Never excluded by `.raftmigrateignore`: the agent's memory, and the ignore
// file itself so the next migration applies the same list. Everything else is
// the agent's call; the source keeps an archived copy for up to 30 days.
const ALWAYS_MOVED_ROOT_PATHS = ["MEMORY.md", AGENT_MIGRATION_IGNORE_FILE];
const IGNORE_PATTERN_CHARS = /[*?[\]!]/;

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:/;

/** What a listing-only walk excluded; `onEntry` saw everything else. */
export interface AgentMigrationWorkspaceListing {
  excludedRegenerable: AgentMigrationExcludedRegenerableEntry[];
  excludedIgnored: AgentMigrationExcludedIgnoredEntry[];
  unreachable: AgentMigrationUnreachableEntry[];
}

/**
 * Walks the workspace with the same exclusions as an export (built-in
 * regenerable directories, `.raftmigrateignore`) and hands each file or
 * symlink path to `onEntry` in a fixed order, without reading anything or
 * keeping a per-file list. `measureIgnored: false` skips sizing ignored paths
 * on a repeat walk.
 */
export async function listAgentMigrationWorkspace(input: {
  workspacePath: string;
  onEntry: (workspaceRelativePath: string) => Promise<void> | void;
  measureIgnored?: boolean;
  onProgress?: (progress: AgentMigrationExportProgress) => void;
}): Promise<AgentMigrationWorkspaceListing> {
  const workspace = path.resolve(input.workspacePath);
  const state: BuildState = {
    workspace,
    excludedRegenerable: [],
    excludedIgnored: [],
    unreachable: [],
    ignoredPaths: new Set(await readAgentMigrationIgnoreFile(workspace)),
    progress: { files: 0, bytes: 0 },
    onProgress: input.onProgress,
    onEntry: input.onEntry,
    measureIgnored: input.measureIgnored ?? true,
  };
  await walkWorkspace(workspace, "", state);
  return {
    excludedRegenerable: sortByPath(state.excludedRegenerable),
    excludedIgnored: sortByPath(state.excludedIgnored),
    unreachable: sortByPath(state.unreachable),
  };
}

interface BuildState {
  workspace: string;
  excludedRegenerable: AgentMigrationExcludedRegenerableEntry[];
  excludedIgnored: AgentMigrationExcludedIgnoredEntry[];
  unreachable: AgentMigrationUnreachableEntry[];
  ignoredPaths: Set<string>;
  progress: { files: number; bytes: number };
  onProgress?: (progress: AgentMigrationExportProgress) => void;
  onEntry: (relativePath: string) => Promise<void> | void;
  /** Count and size `.raftmigrateignore` paths (skipped by a repeat walk). */
  measureIgnored?: boolean;
}

/** Top-level workspace path an entry is accounted under: `name` or `dir/`. */
export function agentMigrationTopLevelPath(relativePath: string): string {
  const slashIndex = relativePath.indexOf("/");
  return slashIndex === -1 ? relativePath : `${relativePath.slice(0, slashIndex)}/`;
}

async function walkWorkspace(
  root: string,
  relativeDir: string,
  state: BuildState,
): Promise<void> {
  const absoluteDir = path.join(root, relativeDir);
  let entries;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch {
    state.unreachable.push({
      path: relativeDir || ".",
      reason: "read_error",
    });
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const relativePath = toPosixPath(path.join(relativeDir, entry.name));
    if (state.ignoredPaths.has(relativePath)) {
      await excludeIgnoredPath(relativePath, entry.isDirectory(), state);
      continue;
    }
    if (entry.isDirectory()) {
      if (isRegenerablePath(relativePath)) {
        state.excludedRegenerable.push({
          path: relativePath,
          reason: "regenerable_default",
          regenerableHint: `${entry.name} is treated as rebuildable/installable state and is not bundled by default`,
        });
        continue;
      }
      await walkWorkspace(root, relativePath, state);
      continue;
    }

    await state.onEntry(relativePath);
  }
}

function reportScanProgress(state: BuildState, files: number, bytes: number): void {
  state.progress.files += files;
  state.progress.bytes += bytes;
  state.onProgress?.({ phase: "scanning", files: state.progress.files, bytes: state.progress.bytes });
}

/**
 * Reads `.raftmigrateignore` at the workspace root: one workspace-relative path
 * per line, `#` comments, no patterns. Only regenerable or re-downloadable
 * content belongs there; paths that must always move are dropped here.
 */
async function readAgentMigrationIgnoreFile(workspace: string): Promise<string[]> {
  let text: string;
  try {
    const ignorePath = path.join(workspace, AGENT_MIGRATION_IGNORE_FILE);
    if (!(await lstat(ignorePath)).isFile()) return [];
    text = await readFile(ignorePath, "utf8");
  } catch {
    return [];
  }
  const candidates: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || IGNORE_PATTERN_CHARS.test(line)) continue;
    candidates.push(line.replace(/^\.\//, "").replace(/\/+$/, ""));
  }
  return normalizeIgnorePaths(candidates, workspace).filter((entry) => !isAlwaysMovedPath(entry));
}

function isAlwaysMovedPath(relativePath: string): boolean {
  return ALWAYS_MOVED_ROOT_PATHS.includes(relativePath);
}

/**
 * Records an ignored path with its size and file count (lstat only, symlinks
 * are not followed).
 */
async function excludeIgnoredPath(
  relativePath: string,
  isDirectory: boolean,
  state: BuildState,
): Promise<void> {
  if (state.measureIgnored === false) return;
  const totals = { fileCount: 0, sizeBytes: 0 };
  const visit = async (entryPath: string, directory: boolean): Promise<void> => {
    if (!directory) {
      try {
        const entryStat = await lstat(path.join(state.workspace, entryPath));
        totals.fileCount += 1;
        totals.sizeBytes += entryStat.isFile() ? entryStat.size : 0;
      } catch {
        // Vanished while walking: nothing to move or count.
      }
      reportScanProgress(state, 1, 0);
      return;
    }
    let children;
    try {
      children = await readdir(path.join(state.workspace, entryPath), { withFileTypes: true });
    } catch {
      state.unreachable.push({ path: entryPath, reason: "read_error" });
      return;
    }
    for (const child of children) {
      await visit(toPosixPath(path.join(entryPath, child.name)), child.isDirectory());
    }
  };
  await visit(relativePath, isDirectory);
  state.excludedIgnored.push({ path: relativePath, reason: "raftmigrateignore", ...totals });
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function normalizeIgnorePaths(paths: string[], workspace: string): string[] {
  const workspacePathApi = path.posix.isAbsolute(workspace) ? path.posix : path.win32;
  const result: string[] = [];
  for (const value of paths) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    let relative = trimmed;
    if (isPortableAbsolutePath(trimmed)) {
      if (!workspacePathApi.isAbsolute(trimmed)) continue;
      relative = workspacePathApi.relative(workspace, trimmed);
      if (isOutsideWorkspaceRelativePath(relative)) continue;
    }
    try {
      result.push(normalizeRelativePath(relative));
    } catch {
      // Unsafe paths are skipped.
    }
  }
  return [...new Set(result)];
}

export function normalizeAgentMigrationSymlinkTarget(
  workspaceRelativePath: string,
  linkTarget: string,
): string {
  const portableTarget = linkTarget.replaceAll("\\", "/");
  if (
    !linkTarget
    || linkTarget.includes("\0")
    || isPortableAbsolutePath(linkTarget)
    || WINDOWS_DRIVE_PATH_PATTERN.test(linkTarget)
  ) {
    throw new Error("MIGRATION_OBJECT_STORE_UNSAFE_LINK");
  }

  const normalizedTarget = path.posix.normalize(portableTarget);
  const normalizedLinkPath = normalizeRelativePath(workspaceRelativePath);
  const resolvedTarget = path.posix.normalize(
    path.posix.join(path.posix.dirname(normalizedLinkPath), normalizedTarget),
  );
  if (
    !normalizedTarget
    || normalizedTarget === "."
    || resolvedTarget === ".."
    || resolvedTarget.startsWith("../")
    || isPortableAbsolutePath(resolvedTarget)
    || WINDOWS_DRIVE_PATH_PATTERN.test(normalizedTarget)
  ) {
    throw new Error("MIGRATION_OBJECT_STORE_UNSAFE_LINK");
  }
  return normalizedTarget;
}

function normalizeRelativePath(value: string): string {
  const portable = value.replaceAll("\\", "/");
  if (
    value.includes("\0")
    || isPortableAbsolutePath(value)
    || WINDOWS_DRIVE_PATH_PATTERN.test(value)
  ) {
    throw new Error(`unsafe migration export path: ${value}`);
  }
  const normalized = path.posix.normalize(portable);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`unsafe migration export path: ${value}`);
  }
  return normalized;
}

function isPortableAbsolutePath(value: string): boolean {
  return path.posix.isAbsolute(value.replaceAll("\\", "/")) || path.win32.isAbsolute(value);
}

function isOutsideWorkspaceRelativePath(value: string): boolean {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  return normalized === ".."
    || normalized.startsWith("../")
    || isPortableAbsolutePath(value)
    || WINDOWS_DRIVE_PATH_PATTERN.test(value);
}

function isRegenerablePath(relativePath: string): boolean {
  return normalizeRelativePath(relativePath)
    .split("/")
    .some((segment) => REGENERABLE_DIRECTORY_NAMES.includes(segment));
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function sortByPath<T extends { path: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => a.path.localeCompare(b.path));
}
